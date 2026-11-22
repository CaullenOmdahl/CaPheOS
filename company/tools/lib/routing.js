'use strict';
/* lib/routing.js — the router: which model ONE wake runs on (docs/ROUTING.md).
 *
 * Policy: company/work/models/routing-policy.json, else company/defaults/work/models/routing-policy.json (the framework
 * default, copied at founding); neither = no routing: prepare() returns null and every wake runs exactly as before (no
 * route field, no log row, no override). Every rule, threshold and switch is in the policy, never here.
 *
 * Steps (policy.order, first choice wins): classRules (a filter on every step: e.g. code never on provider custom), trial
 * (a running trial's arm, assigned by sha256(trial id + wakeId)), route (the seat's department route for the wake's
 * class, company/departments.json: set on purpose, so it runs before scoped), scoped (scoped routing, docs/ROUTING.md §8,
 * live while policy.scoped.enabled: the job's depth and kind from lib/depth.js matched to each routable model's proven
 * depth in lib/capability.js's table; among the open ones that clear it the most efficient by time and share of its own
 * limit; never for an exempt or pinned seat (scopedExempt); recorded on every wake as route.scoped with every candidate
 * and why), tierCap (non-exempt seats on capped entries unless an item is Effort: heavy), chain (the seat's
 * own pair; changed only when the class rules deny it). One walk in policy order: wouldApply = the first step whose mode
 * is shadow or live; applied = the first live step whose pair the station's override allowlist
 * (company/state/override-allow.json, lib/override-allow.js) opens for the seat now. A live pair that is not open is
 * recorded ("not open") and the walk goes on to the next step. Nothing applied: the seat runs on its chain (no override on
 * POST /api/cron/run) and the decision says why ("not open", "shadow", ...). The class rules always hold: when the seat's
 * own pair is denied for the wake's class and nothing earlier applied, the first allowed chain entry the allowlist opens
 * is applied; none open = hold: true (holdWhy), and the dispatcher and the lanes do not start that wake this tick
 * (chainDenied names the rule, so a refused override never falls back to the denied pair either).
 *
 *   const R = require('./lib/routing');
 *   R.loadPolicy(root)                          -> { policy, source } | null
 *   R.knobs(policy)                             -> the normalized config (a missing key reads as off / empty)
 *   R.wakeClass(items, seat, { departments })   -> { class, classes, heavy }
 *   R.denied(pair, classes, K)                  -> the class rule that denies the pair, or null
 *   R.assign(trial, wakeId)                     -> { u, entered, arm }   (deterministic)
 *   R.decide({ seat, items, wakeId, policy|K, departments, crew, chain, current, held, allow, refused })   refused: trial arms
 *                                               ([{provider, model}]) that refused this routine recently are never assigned
 *        -> { v, class, classes, source, trial?, arm?, provider, model, effort?, applied, mode, wouldApply?, hold?, holdWhy?, chainDenied?, reasons }
 *   R.overrideOf(decision)                      -> { provider, model, effort? } | null   (the one-run override body fields)
 *   R.allowFor(seat, { root, now, maxAgeMin })  -> [{provider, model}] the current allowlist opens, or null (none current)
 *   R.trialPauses(K, held, state, now)          -> { state, events }  pause/resume transitions (recorded, never silent)
 *   R.extraEntries(seat, { root, K, departments, crew, chain, scopedCandidates? }) -> the pairs lib/override-allow.js lists
 *                                               beyond chain/routes (scoped on: every routable candidate too)
 *   R.scopedPick(a, K, wakeClass, current, chain) -> { pick, info }  the scoped step alone (a.scoped: prepare()'s context)
 *   R.scopedContext(root, K, modelPolicy, pacerMeasurement, now) -> { capability, candidates, limits, wakes, classDepth }
 *   R.heldProviders(m)                          -> the providers a pacer measurement holds (claude-cli, custom, deepseek)
 *   await R.prepare({ root, jobs, log, dry })   -> a tick context (null without a policy)
 *   R.forWake(ctx, { seat, wakeId, items, job, door }) -> the decision for one wake (logged by R.record)
 *   R.record(ctx, row)                          a wake's decision row ({wakeId, seat, door, jobId, runId, status, route}) to
 *                                               policy.decisions (routing-decisions.jsonl); an event row ({op: trial-held |
 *                                               trial-unheld, trial, providers, why}) to policy.history (routing-log.jsonl)
 *   R.finish(ctx)                               save company/state/routing-state.json (trial pause state) when changed
 * Two logs, by purpose: company/work/models/routing-log.jsonl (policy.history) holds changes and events only, one schema
 * {at, ts, op, by, ...}: routing.js writes the owner's changes (mode, tiercaps, trial-*), this file the pacer's holds of a
 * trial (op trial-held / trial-unheld, by "dispatcher", with trial, providers, why). company/work/models/
 * routing-decisions.jsonl (policy.decisions) holds one row per routed wake {at, ts, wakeId, seat, door, jobId, runId,
 * status, route}; the same route is on the wake's company/state/wakes.jsonl row. Retention (company/defaults/work/ops/
 * retention.json): routing-log 180 days / 2 MB (the audit of owner changes), routing-decisions 90 days / 16 MB.
 * routing-state.json is one small file rewritten whole. Owner: the people function (the model manager). locked-watch.js:
 * the policy is class F (changed only through company/tools/routing.js), this file a protected tool, routing-log.jsonl
 * class A (appended only by routing.js and this file, each row recorded with provenance.js); routing-decisions.jsonl is a
 * per-wake record like wakes.jsonl and is not locked. Never throws from the dispatcher paths.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const POLICY_REL = 'company/work/models/routing-policy.json';
const DEFAULT_REL = 'company/defaults/work/models/routing-policy.json';
const STATE_REL = 'company/state/routing-state.json';
const ALLOW_REL = 'company/state/override-allow.json';
const HISTORY_REL = 'company/work/models/routing-log.jsonl';
const DECISIONS_REL = 'company/work/models/routing-decisions.jsonl';
const EVENT_OPS = ['trial-held', 'trial-unheld'];   // the router's own rows in routing-log.jsonl (routing.js writes the rest)
// a log file the policy names: a .jsonl under company/work/, no '..' (anything else: the default; routing.js reads the same)
const logRel = (v, d) => (typeof v === 'string' && /^company\/work\/[A-Za-z0-9_./-]+\.jsonl$/.test(v) && !v.split('/').some(x => x === '..' || x === '.' || x === '') ? v : d);
const MODES = ['off', 'shadow', 'live'];
const STEPS = ['classRules', 'trial', 'scoped', 'route', 'tierCap', 'chain'];
const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const rootOf = r => path.resolve(r || require('./company').ROOT);
const modeOf = v => (MODES.includes(String(v)) ? String(v) : 'off');
const arr = v => (Array.isArray(v) ? v : []);
const strs = v => arr(v).map(String).filter(Boolean);
const pairOf = e => e && e.provider && e.model ? Object.assign({ provider: String(e.provider), model: String(e.model) }, e.effort ? { effort: String(e.effort) } : {}) : null;
const samePair = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
const sameRun = (a, b) => samePair(a, b) && (a.effort || '') === (b.effort || '');
const label = e => e ? e.provider + '/' + e.model + (e.effort ? '@' + e.effort : '') : 'nothing';

function loadPolicy(root) {
  const R = rootOf(root);
  for (const rel of [POLICY_REL, DEFAULT_REL]) {
    const j = readJson(path.join(R, rel), null);
    if (j && typeof j === 'object' && !Array.isArray(j)) return { policy: j, source: rel };
  }
  return null;
}

function knobs(P) {
  P = P && typeof P === 'object' ? P : {};
  const tc = P.tierCaps && typeof P.tierCaps === 'object' ? P.tierCaps : {};
  const rules = {};
  for (const [c, r] of Object.entries(P.classRules && typeof P.classRules === 'object' ? P.classRules : {})) {
    if (c.startsWith('_') || !r || typeof r !== 'object') continue;
    rules[c] = { denyProviders: strs(r.denyProviders), denyModels: strs(r.denyModels) };
  }
  let order = strs(P.order).filter(s => STEPS.includes(s));
  const scoped = scopedKnobs(P.scoped);
  // the scoped step is the owner's one switch (scoped.enabled): a policy whose order predates it gets it right after the
  // department routes and trials (a route set on purpose and a running trial the owner started keep their wakes)
  if (scoped.enabled && order.length && !order.includes('scoped')) order.splice(scopedSlot(order), 0, 'scoped');
  return {
    scoped,
    mode: modeOf(P.mode),
    classRules: rules,
    classRulesApply: P.classRulesApply === 'mode' ? 'mode' : P.classRulesApply === 'always' ? 'always' : 'off',
    order: order.length ? order : [],
    tierCaps: {
      mode: modeOf(tc.mode),
      allow: arr(tc.allow).filter(a => a && a.provider).map(a => ({ provider: String(a.provider), model: a.model ? String(a.model) : null })),
      heavyEscape: tc.heavyEscape ? String(tc.heavyEscape) : null,
      exemptFunctions: strs(tc.exemptFunctions),
      exemptLeads: tc.exemptLeads === true,
      itemlessWakes: tc.itemlessWakes === true,
    },
    trials: arr(P.trials).filter(t => t && typeof t === 'object' && t.id),
    allowMaxAgeMin: Number(P.allowMaxAgeMin) > 0 ? Number(P.allowMaxAgeMin) : 30,
    history: logRel(P.history, HISTORY_REL),
    decisions: logRel(P.decisions, DECISIONS_REL),
  };
}

/* where the scoped step goes in an order that lacks it: after route and trial (whichever comes last), else after
   classRules, else first */
function scopedSlot(order) {
  const at = ['route', 'trial', 'classRules'].map(s => order.indexOf(s)).filter(i => i >= 0);
  return at.length ? Math.max(...at) + 1 : 0;
}

/* ---- scoped routing's knobs (routing-policy.json scoped; docs/ROUTING.md "Scoped routing") ---- */
function scopedKnobs(S) {
  S = S && typeof S === 'object' ? S : {};
  const o = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const w = o(S.weights), nm = o(S.newModel), lim = o(S.limits);
  return {
    enabled: S.enabled === true,
    classDepth: o(S.classDepth), kinds: o(S.kinds), alsoNeeds: o(S.alsoNeeds), size: o(S.size), escalate: o(S.escalate),
    weights: { time: Math.max(0, n(w.time, 0.5)), limit: Math.max(0, n(w.limit, 0.5)) },
    tieEpsilon: Math.max(0, n(S.tieEpsilon, 0)),
    newModel: { share: Math.max(0, Math.min(1, n(nm.share, 0))), depths: strs(nm.depths).filter(d => DEPTHS.includes(d)) },
    probe: { share: Math.max(0, Math.min(1, n(o(S.probe).share, 0))) },
    exemptFunctions: Array.isArray(S.exemptFunctions) ? strs(S.exemptFunctions) : ['ceo'],
    exemptReserve: S.exemptReserve !== false,
    itemlessWakes: S.itemlessWakes === true,
    effortByDepth: o(S.effortByDepth),
    wakesDays: Math.max(1, n(S.wakesDays, 14)),
    passMark: n(S.passMark, 0.9),
    limits: { subscriptionWeeklyTokens: o(lim.subscriptionWeeklyTokens), usdPerMTokens: o(lim.usdPerMTokens), defaultUsdPerMTokens: Math.max(0, n(lim.defaultUsdPerMTokens, 1)),
      defaultTokens: o(lim.defaultTokens), freeRequestsPerJob: o(lim.freeRequestsPerJob), shareScale: Math.max(1e-9, n(lim.shareScale, 0.02)) },
  };
}

/* ---- the wake's class ---- */
const effortOf = text => { const m = String(text || '').match(/^\*\*Effort:\*\*\s*(.*)$/mi); return m ? m[1].trim() : ''; };
function wakeClass(items, seat, o) {
  const TC = require('./taskclass');
  const deps = (o && o.departments) || { departments: [] };
  const list = arr(items);
  const classes = list.map(it => TC.classOf(typeof it === 'string' ? it : { text: (it && it.text) || '', class: it && it.class, effort: it && it.effort }, seat, { departments: deps }));
  if (!classes.length) classes.push(TC.classOf('', seat, { departments: deps }));
  const n = {}; for (const c of classes) n[c] = (n[c] || 0) + 1;
  let best = classes[0]; for (const c of classes) if (n[c] > n[best]) best = c;   // the majority; a tie: the first item's
  const word = o && o.heavyEscape;
  const heavy = !!word && list.some(it => new RegExp('^\\s*' + String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test((it && it.effort) || effortOf(typeof it === 'string' ? it : it && it.text)));
  return { class: best, classes: [...new Set(classes)], heavy, itemless: !list.length };
}

function denied(pair, classes, K) {
  if (!pair) return null;
  for (const c of arr(classes)) {
    const r = K.classRules[c]; if (!r) continue;
    if (r.denyProviders.includes(pair.provider)) return c + ' never runs on provider ' + pair.provider;
    if (r.denyModels.includes(pair.model)) return c + ' never runs on ' + pair.model;
  }
  return null;
}

/* ---- trials ---- */
function assign(t, wakeId) {
  const h = crypto.createHash('sha256').update(String(t.id) + '\n' + String(wakeId)).digest('hex');
  const u = parseInt(h.slice(0, 8), 16) / 0x100000000;
  const share = Number(t.entryShare); const s = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0;
  const arms = arr(t.arms);
  return { u, entered: u < s, arm: arms.length ? parseInt(h.slice(8, 16), 16) % arms.length : null };
}
function inScope(t, seat, deps) {
  const sc = t.scope && typeof t.scope === 'object' ? t.scope : {};
  if (strs(sc.seats).includes(String(seat))) return true;
  const D = require('./departments'); const d = D.deptOf(seat, deps || { departments: [] });
  return !!d && strs(sc.departments).includes(String(d.id));
}
const pausedBy = (t, held) => strs(t.pauseWhenHeld).filter(p => arr(held).includes(p));
function trialPauses(K, held, state, now) {
  const st = Object.assign({ trials: {} }, state || {}); st.trials = Object.assign({}, st.trials || {});
  const events = [];
  for (const t of K.trials) {
    if (t.status !== 'running') continue;
    const by = pausedBy(t, held); const was = st.trials[t.id] || {};
    if (by.length && !was.paused) { st.trials[t.id] = { paused: true, since: now, providers: by, why: by.join(', ') + ' held by the pacer' }; events.push({ op: 'trial-held', by: 'dispatcher', trial: String(t.id), providers: by, why: st.trials[t.id].why }); }
    else if (!by.length && was.paused) { const prov = strs(was.providers); st.trials[t.id] = { paused: false, since: now, why: 'resumed: ' + (was.why || 'the hold') + ' ended' }; events.push({ op: 'trial-unheld', by: 'dispatcher', trial: String(t.id), providers: prov, why: st.trials[t.id].why }); }
  }
  return { state: st, events };
}

/* ---- tier caps ---- */
const capMatch = (e, allow) => !!e && allow.some(a => a.provider === e.provider && (!a.model || a.model === e.model));
function exemptWhy(seat, K, deps, crew) {
  const c = (crew || {})[seat] || {};
  const co = require('./company');
  const fn = K.tierCaps.exemptFunctions.find(f => co.holds(c, f));
  if (fn) return 'holds the ' + fn + ' function';
  if (K.tierCaps.exemptLeads && arr((deps || {}).departments).some(d => d && d.lead && String(d.lead) === String(seat))) return 'leads a department';
  return null;
}

/* ---- scoped routing: the job's depth and kind against each model's proven depth, then efficiency ----
 * a.scoped (lib/routing.js prepare): { capability (lib/capability.js table), candidates ([{provider, model}]: allowed,
 * routable), limits ({ subs: { <provider>: { leftTokens } }, railLeftUsd, freeLeft }), wakes (wakes.jsonl rows, for
 * escalation), runFail (runId -> why a run counts as a fail on its item: out of steps, a ledger demerit), seats and mp
 * (model-policy.json, for the exemptions and the routable switch), classDepth (the drift) }. Returns { pick: {provider, model, effort?} | null, info } where info is the
 * record that goes on the wake's route (route.scoped): kind, depth, signals, every candidate with why it is in or out
 * and its numbers, the pick and why. Availability (the override allowlist: the pacer, subscription stops, rail,
 * refusals, errors, the free daily limit), the class rules, the routable switch, the seat exemptions and the item's
 * exclude list only filter; among the models that clear the bar the lowest eff = wT * time / slowest + wL * s / (s +
 * shareScale) wins, s = the job's share of what is left of the model's OWN limit (no model's share is 0). When any
 * candidate's limit size is unknown the limit term is left out for every candidate of that comparison (an unknown is
 * neutral, never a penalty for one kind of model). Candidates within tieEpsilon of the best are ordered by their quality
 * margin over the pass mark. */
function limitShareOf(p, tokens, depth, S, L) {
  const FM = require('./free-models');
  if (FM.isFreePair(p.provider, p.model, S.root)) {
    const req = Number((L.freeRequestsPerJob || {})[depth]) > 0 ? Number(L.freeRequestsPerJob[depth]) : 1;
    const left = S.limits && S.limits.freeLeft;
    if (left == null) return { share: null, known: false, basis: 'free: daily request allowance unknown (model-policy.json freeFallback.dailyRequests)' };
    return { share: left > 0 ? Math.min(1, req / left) : 1, known: true, basis: 'free: ' + req + ' request(s) of ' + left + ' left today' };
  }
  const sub = S.limits && S.limits.subs && S.limits.subs[p.provider];
  if (sub) {
    if (sub.leftTokens == null) return { share: null, known: false, basis: 'subscription: window size unknown (scoped.limits.subscriptionWeeklyTokens)' };
    return { share: sub.leftTokens > 0 ? Math.min(1, tokens / sub.leftTokens) : 1, known: true, basis: 'subscription: ~' + tokens + ' tokens of ' + Math.round(sub.leftTokens) + ' left this week' };
  }
  const per = Number((L.usdPerMTokens || {})[p.provider + '/' + p.model]);
  const perP = Number((L.usdPerMTokens || {})[p.provider]);
  const usd = tokens / 1e6 * (per >= 0 && Number.isFinite(per) ? per : perP >= 0 && Number.isFinite(perP) ? perP : L.defaultUsdPerMTokens);
  const left = S.limits && S.limits.railLeftUsd;
  if (left == null) return { share: null, known: false, basis: 'metered: the daily rail is unknown' };
  return { share: left > 0 ? Math.min(1, usd / left) : 1, known: true, basis: 'metered: ~$' + (Math.round(usd * 10000) / 10000) + ' of $' + (Math.round(left * 100) / 100) + ' left on the daily rail' };
}
/* why scoped routing leaves this seat (or this wake) on its own models, or null. Manual pins win: a seat holding one of
   exemptFunctions (the CEO), a claudeReserve seat, a seat the owner pinned (model-policy.json seats.<id>.autoPick false),
   a seat whose current model the owner keeps off automatic picks (it was assigned on purpose), and (with cls) a class
   the seat's department routes on purpose. o: { K (knobs().scoped), crew, seats (model-policy.json seats), mp, current,
   primary (the chain's first entry), departments, cls } */
function scopedExempt(seat, o) {
  o = o || {};
  const Kx = o.K || {}, s = ((o.seats || {})[seat]) || {}, c = (o.crew || {})[seat] || {};
  if (s.autoPick === false) return 'the owner pinned this seat\'s models (autoPick off)';
  let co = null; try { co = require('./company'); } catch (_) { co = null; }
  const fn = co ? arr(Kx.exemptFunctions).find(f => co.holds(c, f)) : null;
  if (fn) return 'holds the ' + fn + ' function: stays on its own models';
  if (Kx.exemptReserve !== false && s.claudeReserve === true) return 'a claudeReserve seat: stays on its own models';
  if (o.mp) for (const [what, p] of [['primary', o.primary], ['current', o.current]]) {
    if (!p) continue;
    const r = require('./capability').routable(p, o.mp);
    if (!r.ok) return 'its ' + what + ' model ' + label(p) + ' was assigned on purpose (' + r.why + ')';
  }
  if (o.cls) {
    try { const d = require('./departments').deptOf(seat, o.departments || { departments: [] }); if (d && d.routes && typeof d.routes === 'object' && pairOf(d.routes[o.cls])) return 'department ' + d.id + ' routes ' + o.cls + ' on purpose'; } catch (_) {}
  }
  return null;
}
function scopedPick(a, K, wc, cur, chain) {
  const S = a.scoped || {}, Kx = K.scoped, D = require('./depth'), C = require('./capability');
  const est = D.estimate(a.items, { seat: a.seat, class: wc.class, K: Kx, departments: a.departments, heavyEscape: K.tierCaps.heavyEscape, classDepth: S.classDepth || {}, wakes: S.wakes || [], runFail: S.runFail || null });
  const info = { kind: est.kind, kindName: est.kindName, depth: est.depth, needs: est.needs, signals: est.signals, candidates: [], pick: null, why: '' };
  if (est.fails) info.escalated = est.fails;
  if (est.exclude.length) info.exclude = est.exclude;
  const ex = scopedExempt(a.seat, { K: Kx, crew: a.crew, seats: S.seats, mp: S.mp, current: cur, primary: chain[0] || null, departments: a.departments, cls: wc.class });
  if (ex) { info.why = 'exempt: ' + ex + ': the chain runs'; info.exempt = true; return { pick: null, info }; }
  if (wc.itemless && !Kx.itemlessWakes) { info.why = 'a wake with no handoff item runs on the seat\'s chain'; return { pick: null, info }; }
  if (est.kind == null) { info.why = 'no kind of work is set for class ' + wc.class + ' (scoped.kinds): the chain runs'; return { pick: null, info }; }
  if (a.allow == null) { info.why = 'no current override allowlist, so no other model can be opened: the chain runs'; return { pick: null, info }; }
  const cap = S.capability || null, L = Kx.limits, pm = Number(cap && cap.passMark) > 0 ? Number(cap.passMark) : Kx.passMark;
  const open = e => arr(a.allow).some(x => samePair(x, e));
  const di = d => DEPTHS.indexOf(d);
  // a probe: a baseline-only job (nothing raised it) goes, for probe.share of such wakes, to a model proven one level
  // lower, so a class whose work keeps proving easier can drift down (model-rank.js classDrift); a fail escalates as usual
  const hp = crypto.createHash('sha256').update('scoped-probe\n' + String(a.wakeId)).digest('hex');
  const probeU = parseInt(hp.slice(0, 8), 16) / 0x100000000;
  const probe = !!cap && est.fromBaseline && !est.fails && di(est.depth) > 0 && Kx.probe.share > 0 && probeU < Kx.probe.share;
  const need = probe ? DEPTHS[di(est.depth) - 1] : est.depth;
  const needs = est.needs.map(nd => ({ kind: nd.kind, depth: probe && di(nd.depth) > di(need) ? need : nd.depth }));
  const rows = [], ok = [], excluded = [], fresh = [];
  for (const p of arr(S.candidates).map(pairOf).filter(Boolean)) {
    const row = { model: p.provider + '/' + p.model };
    const c0 = C.currentOf(cap, p, est.kind); row.current = c0.current;
    const bad = denied(p, wc.classes, K);
    if (bad) { row.out = 'class rules: ' + bad; rows.push(row); continue; }
    if (!open(p)) { row.out = 'not open for ' + a.seat + ' now (limits, stops, refusals or errors)'; rows.push(row); continue; }
    if (!c0.model) {
      row.out = 'new model: no bench result';
      if (cap && Kx.newModel.share > 0 && Kx.newModel.depths.includes(est.depth)) fresh.push({ p, row });
      rows.push(row); continue;
    }
    const short = needs.find(nd => { const c = C.currentOf(cap, p, nd.kind).current; return !c || di(c) < di(nd.depth); });
    if (short) { const c = C.currentOf(cap, p, short.kind).current; row.out = 'proven to ' + (c || 'no depth') + ' on kind ' + short.kind + ', needs ' + short.depth; rows.push(row); continue; }
    if (probe && di(c0.current) !== di(need)) { row.out = 'probe: proven above ' + need; rows.push(row); continue; }
    const e = c0.entry || {}, lv = (e.live || {})[est.depth] || {}, bl = (e.levels || {})[est.depth] || {};
    row.time = lv.timeSecP50 != null && lv.n > 0 ? lv.timeSecP50 : bl.timeSecP50 != null ? bl.timeSecP50 : null;
    const tokens = Number(bl.tokens) > 0 ? Number(bl.tokens) : Number((L.defaultTokens || {})[est.depth]) > 0 ? Number(L.defaultTokens[est.depth]) : 20000;
    const ls = limitShareOf(p, tokens, est.depth, Object.assign({ root: a.root }, S), L);
    row.share = ls.known ? Math.max(1e-9, ls.share) : null; row.shareBasis = ls.basis;
    const q = lv.lower != null && lv.n > 0 ? lv.lower : bl.passRate != null ? bl.passRate : pm;
    row.margin = Math.round((q - pm) * 1000) / 1000;
    if (est.exclude.includes(row.model)) { row.out = 'worked this item before it failed'; excluded.push({ p, row }); rows.push(row); continue; }
    ok.push({ p, row }); rows.push(row);
  }
  let pool = ok, note = '';
  if (!pool.length && excluded.length) { pool = excluded; note = ' (only a model that failed this item before clears the bar; it is retried)'; for (const x of pool) delete x.row.out; }
  let pick = null;
  if (pool.length) {
    // time against the slowest candidate; the limit share saturating at shareScale (s / (s + shareScale): a job taking
    // shareScale of what is left counts half), so two negligible shares do not outweigh real time. Any unknown limit
    // size: the limit term is left out for everyone (neutral), never the worst value for one model type
    const tmax = Math.max(0, ...pool.map(x => x.row.time || 0));
    const useLimit = Kx.weights.limit > 0 && pool.every(x => x.row.share != null);
    if (!useLimit && Kx.weights.limit > 0) info.limitTerm = 'left out: ' + pool.filter(x => x.row.share == null).map(x => x.row.model).slice(0, 4).join(', ') + ' limit size unknown';
    for (const x of pool) {
      const tn = x.row.time == null || !(tmax > 0) ? 1 : x.row.time / tmax;
      const lt = useLimit ? x.row.share / (x.row.share + L.shareScale) : 0;
      x.row.eff = Math.round((Kx.weights.time * tn + (useLimit ? Kx.weights.limit * lt : 0)) * 10000) / 10000;
    }
    const byEff = pool.slice().sort((x, y) => x.row.eff - y.row.eff || (x.row.model < y.row.model ? -1 : 1));
    const best = byEff[0].row.eff, tied = byEff.filter(x => x.row.eff - best <= Kx.tieEpsilon);
    tied.sort((x, y) => y.row.margin - x.row.margin || x.row.eff - y.row.eff || (x.row.model < y.row.model ? -1 : 1));
    pick = tied[0];
    const alts = byEff.filter(x => x !== pick).length;
    info.why = (probe ? 'probe: proven at ' + need + ', one level under the ' + est.depth + ' baseline (u ' + probeU.toFixed(3) + ' < ' + Kx.probe.share + ')' : 'proven at ' + est.depth) + ' on kind ' + est.kind + (needs.length > 1 ? ' (and ' + needs.slice(1).map(nd => 'kind ' + nd.kind + ' at ' + nd.depth).join(', ') + ')' : '') +
      '; the most efficient (eff ' + pick.row.eff + ': time' + (useLimit ? ' and share of its own limit' : ' only, a limit size is unknown') + ')' + (tied.length > 1 ? ', a tie of ' + tied.length + ' broken by quality margin ' + pick.row.margin : '') + ' of ' + (alts + 1) + ' that clear the bar' + note;
    if (probe) info.probe = { from: est.depth, to: need };
  } else if (fresh.length) {
    // a new model with no bench result: a share of the shallow wakes, so it builds a live record (scoped.newModel; 0 by default)
    const h = crypto.createHash('sha256').update('scoped-new\n' + String(a.wakeId)).digest('hex');
    const u = parseInt(h.slice(0, 8), 16) / 0x100000000;
    if (u < Kx.newModel.share) { pick = fresh[parseInt(h.slice(8, 16), 16) % fresh.length]; delete pick.row.out; info.why = 'new model with no bench result, given a ' + est.depth + ' job to build its record (u ' + u.toFixed(3) + ' < ' + Kx.newModel.share + ')'; info.newModel = true; }
  }
  info.candidates = rows.slice(0, 16);
  if (!pick) { if (!info.why) info.why = 'no routable model that is open now is proven at ' + need + ' on kind ' + est.kind + (probe ? ' (a probe one level down)' : est.depth === 'deep' ? ' (the deepest level)' : '') + ': the chain runs'; return { pick: null, info }; }
  const e = pick.p, inChain = arr(chain).find(x => samePair(x, e));
  const out = { provider: e.provider, model: e.model };
  const depthEff = Kx.effortByDepth && typeof Kx.effortByDepth[est.depth] === 'string' && !est.fails ? Kx.effortByDepth[est.depth] : null;
  const eff = samePair(cur, e) && cur.effort ? cur.effort : inChain && inChain.effort ? inChain.effort : depthEff;
  if (eff) out.effort = eff;
  info.pick = e.provider + '/' + e.model;
  return { pick: out, info };
}

/* ---- decide one wake ---- */
function decide(a) {
  a = a || {};
  const K = a.K || knobs(a.policy);
  const deps = a.departments || { departments: [] };
  const seat = String(a.seat || '');
  const chain = arr(a.chain).map(pairOf).filter(Boolean);
  const cur = pairOf(a.current) || chain[0] || null;
  const held = arr(a.held);
  const wc = wakeClass(a.items, seat, { departments: deps, heavyEscape: K.tierCaps.heavyEscape });
  const reasons = [];
  const ok = e => !denied(e, wc.classes, K);
  const scopedOn = K.scoped && K.scoped.enabled && !!a.scoped;
  const modeFor = s => s === 'tierCap' ? K.tierCaps.mode : s === 'chain' ? (K.classRulesApply === 'always' ? 'live' : K.classRulesApply === 'mode' ? K.mode : 'off') : s === 'classRules' ? 'off' : s === 'scoped' ? (scopedOn ? 'live' : 'off') : K.mode;
  let scopedInfo = null;
  const step = {
    scoped() {
      if (!scopedOn) return null;
      const r = scopedPick(a, K, wc, cur, chain);
      scopedInfo = r.info;
      return r.pick ? Object.assign({ source: 'scoped' }, r.pick) : null;
    },
    trial() {
      for (const t of K.trials) {
        if (t.status !== 'running' || String(t.class) !== wc.class || !inScope(t, seat, deps)) continue;
        const arms = arr(t.arms).map(pairOf);
        if (!arms.length || arms.some(x => !x)) { reasons.push('trial ' + t.id + ': an arm has no provider and model; skipped'); continue; }
        const bad = arms.map(x => denied(x, wc.classes, K)).find(Boolean);
        if (bad) { reasons.push('trial ' + t.id + ': an arm the class rules deny (' + bad + '); the trial is skipped'); continue; }
        const by = pausedBy(t, held);
        if (by.length) { reasons.push('trial ' + t.id + ' paused: ' + by.join(', ') + ' held by the pacer (no assignment)'); continue; }
        const g = assign(t, a.wakeId);
        if (!g.entered) { reasons.push('trial ' + t.id + ': not entered (u ' + g.u.toFixed(3) + ' >= entryShare ' + t.entryShare + ')'); continue; }
        const armPair = arms[g.arm];
        const refused = arr(a.refused).find(x => x && x.provider === armPair.provider && (!x.model || x.model === armPair.model));
        if (refused) { reasons.push('trial ' + t.id + ': arm ' + label(armPair) + ' refused this routine recently; not assigned (the chain runs)'); continue; }
        return Object.assign({ source: 'trial', trial: String(t.id), arm: g.arm }, armPair);
      }
      return null;
    },
    route() {
      const D = require('./departments'); const d = D.deptOf(seat, deps);
      const r = d && d.routes && typeof d.routes === 'object' ? pairOf(d.routes[wc.class]) : null;
      if (!r) return null;
      const bad = denied(r, wc.classes, K);
      if (bad) { reasons.push('route ' + d.id + '.' + wc.class + ' ' + label(r) + ' denied: ' + bad); return null; }
      return Object.assign({ source: 'route', department: String(d.id) }, r);
    },
    tierCap() {
      const ex = exemptWhy(seat, K, deps, a.crew);
      if (ex) { reasons.push('tier cap: exempt (' + ex + ')'); return null; }
      if (wc.heavy) { reasons.push('tier cap: an item is Effort: ' + K.tierCaps.heavyEscape); return null; }
      if (wc.itemless && !K.tierCaps.itemlessWakes) return null;
      if (capMatch(cur, K.tierCaps.allow) && ok(cur)) return null;   // already on a capped entry
      const pick = chain.find(e => capMatch(e, K.tierCaps.allow) && ok(e));
      if (!pick) { reasons.push('tier cap: no capped entry in the chain (' + chain.map(label).join(', ') + ')'); return null; }
      return Object.assign({ source: 'tierCap' }, pick);
    },
    chain() {
      if (!cur) return null;
      const bad = denied(cur, wc.classes, K);
      if (!bad) return null;
      // the first allowed entry the override allowlist opens now (a closed one would only be "not open"); no current list:
      // the first allowed entry
      const open = e => a.allow == null || arr(a.allow).some(x => samePair(x, e));
      const pick = chain.find(e => ok(e) && open(e)) || chain.find(ok);
      if (!pick) { reasons.push('class rules deny ' + label(cur) + ' (' + bad + ') and no chain entry is allowed'); return null; }
      return Object.assign({ source: 'chain', classRule: bad }, pick);
    },
  };
  const memo = {};
  const cand = s => (s in memo ? memo[s] : (memo[s] = step[s] ? step[s]() : null));
  const isOpen = e => a.allow != null && arr(a.allow).some(x => samePair(x, e));
  // the walk, in policy order: want = the first shadow or live candidate (recorded); live = the first live candidate that
  // is the seat's own pair (runs it, no override) or that the allowlist opens now (applied). A live candidate that is not
  // open is recorded and the walk goes on to the next step.
  let want = null, live = null, applied = false;
  for (const s of K.order) {
    const m = modeFor(s); if (m === 'off') continue;
    const c = cand(s); if (!c) continue;
    if (!want) want = Object.assign({ mode: m }, c);
    if (m !== 'live') continue;
    if (sameRun(c, cur)) { live = c; break; }
    if (isOpen(c)) { live = c; applied = true; break; }
    if (a.allow == null) reasons.push('not open: no current override allowlist (' + label(c) + ')');
    else reasons.push('not open: ' + c.provider + '/' + c.model + ' is not in the override allowlist for ' + seat + ' now');
  }
  if (!live && want && want.mode === 'shadow') reasons.push(want.source + ' in shadow: recorded, not applied');
  // the class rules always hold, whatever the modes: a wake never starts on a pair they deny for its class. Nothing
  // earlier applied and the seat's own pair is denied: the first chain entry the rules allow and the allowlist opens
  // now; none open = the wake is held (hold: the dispatcher does not start it this tick).
  const curBad = cur ? denied(cur, wc.classes, K) : null;
  let hold = null;
  if (curBad && !applied) {
    const pick = chain.find(e => ok(e) && isOpen(e));
    if (pick) { live = Object.assign({ source: 'chain', classRule: curBad }, pick); applied = true; }
    else {
      hold = 'class rules deny ' + label(cur) + ' (' + curBad + '): no allowed entry open (' + (chain.filter(ok).map(label).join(', ') || 'none allowed') + '); the wake is held, not started on the denied pair';
      reasons.push(hold);
    }
  }
  const runs = applied ? live : cur;
  const out = { v: 1, class: wc.class, classes: wc.classes, source: applied ? live.source : 'chain', provider: runs ? runs.provider : null, model: runs ? runs.model : null, applied, mode: K.mode, capMode: K.tierCaps.mode };
  if (runs && runs.effort) out.effort = runs.effort;
  const hit = applied ? live : null;
  if (hit && hit.trial) { out.trial = hit.trial; out.arm = hit.arm; }
  if (hit && hit.department) out.department = hit.department;
  // the chain's pair is a trial arm: the wake counts for that arm without an override
  if (!applied && live && sameRun(live, cur)) { out.source = live.source; if (live.trial) { out.trial = live.trial; out.arm = live.arm; } }
  if (want && !(applied && sameRun(want, live)) && !sameRun(want, cur)) {
    out.wouldApply = { source: want.source, provider: want.provider, model: want.model };
    if (want.effort) out.wouldApply.effort = want.effort;
    if (want.trial) { out.wouldApply.trial = want.trial; out.wouldApply.arm = want.arm; }
    if (want.department) out.wouldApply.department = want.department;
  }
  if (cur && !applied && !sameRun(cur, runs)) out.chain = label(cur);
  if (curBad) out.chainDenied = curBad;
  if (hold) { out.hold = true; out.holdWhy = hold; }
  // scoped routing is recorded on every wake while it is on, whichever step applied (a trial first, say)
  if (scopedOn) {
    if (!('scoped' in memo)) cand('scoped');
    if (scopedInfo) {
      const took = !!live && live.source === 'scoped';
      out.scoped = Object.assign({}, scopedInfo, { applied: took, override: took && applied, runs: runs ? label(runs) : null });
      if (took && !applied) out.scoped.note = 'the pick is the seat\'s own model: no override';
      else if (scopedInfo.pick && !took) out.scoped.note = applied ? 'an earlier step (' + out.source + ') applied' : 'not applied';
    }
  }
  out.reasons = reasons.slice(0, 12).map(r => String(r).slice(0, 240));
  return out;
}
function overrideOf(d) {
  if (!d || !d.applied || !d.provider || !d.model) return null;
  return Object.assign({ provider: d.provider, model: d.model }, d.effort ? { effort: d.effort } : {});
}

/* ---- the station's current override allowlist ---- */
function allowFor(seat, o) {
  o = o || {};
  const doc = readJson(path.join(rootOf(o.root), ALLOW_REL), null);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const max = (Number(o.maxAgeMin) > 0 ? Number(o.maxAgeMin) : 30) * 60e3;
  if (!doc || doc.v !== 1 || !Number.isFinite(Number(doc.at)) || now - Number(doc.at) > max || Number(doc.at) - now > 60e3 || !doc.agents || typeof doc.agents !== 'object') return null;
  return arr(doc.agents[String(seat)]).map(pairOf).filter(Boolean);
}

/* ---- the pairs the override allowlist lists for a seat beyond its chain and department routes ---- */
function extraEntries(seat, o) {
  o = o || {};
  const K = o.K || (() => { const L = loadPolicy(o.root); return L ? knobs(L.policy) : null; })();
  if (!K) return [];
  const deps = o.departments || require('./departments').load({ root: rootOf(o.root) }).doc;
  const out = [];
  if (K.mode !== 'off') for (const t of K.trials) {
    if (t.status !== 'running' || !inScope(t, seat, deps)) continue;
    const arms = arr(t.arms).map(pairOf);
    if (!arms.length || arms.some(x => !x) || arms.some(x => denied(x, [String(t.class)], K))) continue;   // a trial the class rules deny is never run
    for (const x of arms) out.push({ provider: x.provider, model: x.model });
  }
  if (K.tierCaps.mode === 'live' && !exemptWhy(seat, K, deps, o.crew || require('./company').crew())) {
    for (const e of arr(o.chain).map(pairOf).filter(Boolean)) if (capMatch(e, K.tierCaps.allow)) out.push({ provider: e.provider, model: e.model });
  }
  // scoped routing on: every routable allowed model (lib/capability.js candidates) may be picked for any seat, so each is
  // listed; lib/override-allow.js still keeps only the ones models.js evaluate() says can run for the seat now
  // (a seat scoped routing never moves, the CEO say, gets none of them)
  const mpx = K.scoped && K.scoped.enabled ? (o.modelPolicy || readJson(path.join(rootOf(o.root), 'company', 'model-policy.json'), {}) || {}) : null;
  const ch0 = arr(o.chain).map(pairOf).filter(Boolean)[0] || null;
  if (K.scoped && K.scoped.enabled && !scopedExempt(seat, { K: K.scoped, crew: o.crew || (() => { try { return require('./company').crew(); } catch (_) { return {}; } })(), seats: mpx.seats || {}, mp: mpx, primary: ch0 })) {
    const list = o.scopedCandidates || scopedCandidates(rootOf(o.root));
    for (const e of list) if (!out.some(x => samePair(x, e))) out.push({ provider: e.provider, model: e.model });
  }
  return out;
}
/* the models scoped routing may consider: allowed and routable (lib/capability.js candidates) */
function scopedCandidates(root, cap) {
  try { const mp = readJson(path.join(rootOf(root), 'company', 'model-policy.json'), {}) || {}; return require('./capability').candidates(mp, { root: rootOf(root), capability: cap }); } catch (_) { return []; }
}
/* a department route the class rules deny for its own class is never listed */
function routeAllowed(cls, pair, K) { return !K || !denied(pair, [String(cls)], K); }

function heldProviders(m) {
  const out = [];
  if (!m) return out;
  if (m.claude && m.claude.open === false) out.push('claude-cli');
  if (m.minimax && m.minimax.open === false) out.push('custom');
  if (m.deepseek && m.deepseek.open === false) out.push('deepseek');
  return out;
}

/* ---- one dispatcher tick ---- */
async function prepare(o) {
  o = o || {};
  try {
    const root = rootOf(o.root);
    const L = loadPolicy(root); if (!L) return null;
    const K = knobs(L.policy);
    const deps = require('./departments').load({ root }).doc;
    const crew = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
    const mp = readJson(path.join(root, 'company', 'model-policy.json'), {}) || {};
    const chains = {};
    for (const [id, s] of Object.entries(mp.seats || {})) if (!id.startsWith('_') && s && Array.isArray(s.chain)) chains[id] = s.chain.map(pairOf).filter(Boolean);
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    let held = Array.isArray(o.held) ? o.held.slice() : null;
    const needHeld = K.mode !== 'off' && K.trials.some(t => t.status === 'running' && strs(t.pauseWhenHeld).length);
    let m = o.m || null;
    const measure = async () => { if (m) return m; try { const PZ = require('../pacer.js').makePacer({ root, readOnly: true, quiet: true }); m = await PZ.measure(PZ.loadState(), o.jobs || [], { fetch: false }); } catch (_) { m = null; } return m; };
    if (!held && needHeld) {
      try { held = (await measure()) ? heldProviders(m) : null; }
      catch (_) { held = null; }
      // no measurement: a trial that pauses on a hold cannot tell, so it pauses (fail closed)
      if (!held) held = [...new Set(K.trials.flatMap(t => strs(t.pauseWhenHeld)))];
    }
    const prev = readJson(path.join(root, STATE_REL), null) || { trials: {} };
    const tp = trialPauses(K, held || [], prev, now);
    const ctx = { root, policy: L.policy, source: L.source, K, deps, crew, chains, held: held || [], now, state: tp.state, stateChanged: JSON.stringify(tp.state) !== JSON.stringify(prev), dry: !!o.dry, log: o.log };
    if (K.scoped.enabled) ctx.scoped = o.scoped || scopedContext(root, K, mp, await measure(), now);
    for (const e of tp.events) { record(ctx, Object.assign({ at: now }, e)); if (typeof o.log === 'function') o.log('ROUTING trial ' + e.trial + ' ' + (e.op === 'trial-held' ? 'paused' : 'resumed') + ': ' + e.why); }
    return ctx;
  } catch (e) { if (o && typeof o.log === 'function') o.log('ROUTING ERROR: ' + String((e && e.message) || e).slice(0, 200) + ' (every wake runs on its chain)'); return null; }
}
/* the scoped step's tick context: the capability table, the candidates, each provider's own limit left, recent wakes */
function scopedContext(root, K, mp, m, now) {
  const C = require('./capability'), D = require('./depth'), W = require('./wakes');
  const capability = C.load(root);
  let wakes = []; try { wakes = W.rows({ sinceMs: now - K.scoped.wakesDays * 86400e3, file: path.join(root, 'company', 'state', 'wakes.jsonl') }); } catch (_) { wakes = []; }
  const weekly = K.scoped.limits.subscriptionWeeklyTokens || {};
  const subs = {};
  const sub = (prov, g) => { if (!g) { subs[prov] = { leftTokens: null }; return; } const cap = Number.isFinite(Number(g.weekCap)) ? Number(g.weekCap) : 100; const used = Number(g.usedPct); const wt = Number(weekly[prov]);
    subs[prov] = { leftTokens: g.known !== false && Number.isFinite(used) && wt > 0 ? Math.max(0, (cap - used) / 100 * wt) : null, usedPct: Number.isFinite(used) ? used : null }; };
  sub('claude-cli', m && m.claude); sub('custom', m && m.minimax);
  const rail = m && m.rail;
  const railLeftUsd = rail && Number(rail.perDay) > 0 && Number.isFinite(Number(rail.pct)) ? Math.max(0, Number(rail.perDay) * (1 - Number(rail.pct) / 100)) : null;
  // the station's run records (bounded, the same window): today's OpenRouter runs, and the runs that count as a fail on
  // their item for escalation (scoped.escalate.failedRuns reasons; a provider error is not a depth signal)
  let runs = []; try { runs = require('./bounded').jsonlWindow(path.join(root, '.starnet-data', 'workspaces', 'runs.jsonl'), { sinceMs: now - K.scoped.wakesDays * 86400e3, maxBytes: 32 << 20 }).rows; } catch (_) { runs = []; }
  const failReasons = strs((K.scoped.escalate || {}).failedRuns);
  const runFail = {};
  for (const r of runs) if (r && r.runId && failReasons.includes(String(r.reason || ''))) runFail[String(r.runId)] = 'its run ended ' + r.reason;
  if ((K.scoped.escalate || {}).ledger) {
    let led = []; try { led = require('./bounded').tailLines(path.join(root, 'company', 'work', 'people', 'competence-events.jsonl'), 2000, { maxBytes: 8 << 20 }).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { led = []; }
    for (const r of led) if (r.kind === 'demerit' && (Date.parse(r.at) || 0) >= now - K.scoped.wakesDays * 86400e3) for (const id of [r.authorRunId, r.authorCorroboratedBy]) if (id) runFail[String(id)] = 'a competence demerit (' + String(r.signal || 'defect').slice(0, 60) + ')';
  }
  // free requests left today: the account's daily allowance (model-policy.json freeFallback.dailyRequests) less today's
  // OpenRouter runs, through a chain or an override (UTC day, as OpenRouter counts; one run is at least one request)
  const daily = Number(((mp || {}).freeFallback || {}).dailyRequests);
  const day = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const usedFree = runs.filter(r => r && r.provider === 'openrouter' && (Number(r.startedAt || r.endedAt || r.ts) || 0) >= day).length;
  const freeLeft = daily > 0 ? Math.max(0, daily - usedFree) : null;
  const seats = {}; for (const [id, s] of Object.entries((mp && mp.seats) || {})) if (!id.startsWith('_') && s && typeof s === 'object') seats[id] = { autoPick: s.autoPick, claudeReserve: s.claudeReserve };
  return { root, capability, candidates: scopedCandidates(root, capability), limits: { subs, railLeftUsd, freeLeft }, wakes, runFail, seats, mp: { routable: (mp && mp.routable) || {}, needsCeoApproval: (mp && mp.needsCeoApproval) || [] }, classDepth: D.loadClassDepth(root) };
}
function forWake(ctx, w) {
  if (!ctx) return null;
  try {
    const job = w.job || {};
    const current = pairOf({ provider: (job.wire && job.wire.provider) || job.provider, model: (job.wire && job.wire.model) || job.model, effort: job.reasoningEffort });
    const chain = ctx.chains[w.seat] || (current ? [current] : []);
    let refused = []; try { if (job.id) refused = require('./refusal').trialRefusals(job.id, { root: ctx.root }); } catch (_) { refused = []; }
    return decide({ K: ctx.K, seat: w.seat, items: w.items, wakeId: w.wakeId, departments: ctx.deps, crew: ctx.crew, chain, current, held: ctx.held, refused, scoped: ctx.scoped, root: ctx.root,
      allow: allowFor(w.seat, { root: ctx.root, now: Date.now(), maxAgeMin: ctx.K.allowMaxAgeMin }) });
  } catch (e) { if (typeof ctx.log === 'function') ctx.log('ROUTING ERROR ' + w.seat + ': ' + String((e && e.message) || e).slice(0, 200) + ' (runs on its chain)'); return null; }
}
// an event (row.op trial-held / trial-unheld) goes to the routing log, recorded with provenance (locked-watch.js class A);
// anything else is a wake's decision and goes to the decisions log (a per-wake record like wakes.jsonl, not locked)
function record(ctx, row) {
  if (!ctx || ctx.dry || !row || typeof row !== 'object') return;
  try {
    const event = EVENT_OPS.includes(row.op);
    const K = ctx.K || {};
    const rel = event ? logRel(K.history, HISTORY_REL) : logRel(K.decisions, DECISIONS_REL);
    const f = path.join(ctx.root, rel);
    const at = Number.isFinite(row.at) ? row.at : Date.now();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const head = event ? { at, ts: new Date(at).toISOString(), op: row.op, by: row.by || 'dispatcher' } : { at, ts: new Date(at).toISOString() };
    const line = JSON.stringify(Object.assign({}, head, row, { at, ts: head.ts }, event ? { by: head.by } : {})) + '\n';
    fs.appendFileSync(f, line);
    if (event) try { require('../provenance.js').appended(f, line, 'lib/routing.js', { root: ctx.root }); } catch (_) {}
  } catch (_) { /* a record never breaks a wake */ }
}
function finish(ctx) {
  if (!ctx || ctx.dry || !ctx.stateChanged) return;
  try { const f = path.join(ctx.root, STATE_REL); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(Object.assign({ _doc: 'lib/routing.js: trial pause state (a trial pauses while a provider in its pauseWhenHeld is held by the pacer)' }, ctx.state), null, 1) + '\n'); fs.renameSync(tmp, f); ctx.stateChanged = false; } catch (_) {}
}
/* one line for the dispatch log, only when something would differ from the chain */
function scopedLine(s) {
  if (!s) return '';
  const alts = arr(s.candidates).filter(c => !c.out && c.model !== s.pick).length;
  return 'scoped ' + (s.kind == null ? '?' : s.kind) + '/' + s.depth + (s.pick ? ' -> ' + s.pick + (s.applied ? '' : ' (' + (s.note || 'not applied') + ')') : ': no pick') + ' (' + String(s.why || '').slice(0, 160) + '; ' + alts + ' other(s) cleared, ' + arr(s.candidates).filter(c => c.out).length + ' out)';
}
function line(seat, d) {
  if (!d) return null;
  const base = lineBase(seat, d);
  // a scoped "no pick" (the chain runs as before) is in the decisions log, not the dispatch log: one line per wake
  // would bury the log on a busy company
  if (!d.scoped || (!d.scoped.pick && !base)) return base;
  return base ? base + ' [' + scopedLine(d.scoped) + ']' : 'ROUTE ' + seat + ': ' + scopedLine(d.scoped) + '; runs ' + label(d);
}
function lineBase(seat, d) {
  if (d.applied) return 'ROUTE ' + seat + ': ' + d.source + (d.trial ? ' ' + d.trial + ' arm ' + d.arm : '') + ' -> ' + label(d) + ' (one-run override; chain ' + (d.chain || 'unchanged') + ')';
  if (d.wouldApply) return 'ROUTE ' + seat + ' (not applied): ' + d.wouldApply.source + ' would run ' + label(d.wouldApply) + '; runs ' + label(d) + ' — ' + (d.reasons.find(r => /not open|shadow/.test(r)) || d.reasons[0] || '');
  return null;
}

module.exports = { scopedSlot, scopedExempt, POLICY_REL, DEFAULT_REL, STATE_REL, HISTORY_REL, DECISIONS_REL, EVENT_OPS, MODES, STEPS, DEPTHS, logRel, loadPolicy, knobs, scopedKnobs, scopedPick, limitShareOf, scopedCandidates, scopedContext, scopedLine, wakeClass, denied, assign, inScope, trialPauses, decide, overrideOf, allowFor, extraEntries, routeAllowed, heldProviders, prepare, forWake, record, finish, line, label };

// node company/tools/lib/routing.js show   the policy in force and its switches (read only)
if (require.main === module) {
  const L = loadPolicy();
  if (!L) { console.log('routing: no policy (' + POLICY_REL + ' or ' + DEFAULT_REL + '): every wake runs on its chain'); process.exit(0); }
  const K = knobs(L.policy);
  console.log('routing policy: ' + L.source + '\n  mode ' + K.mode + ' (routes, trials) · tier caps ' + K.tierCaps.mode + ' · class rules ' + K.classRulesApply + ' (' + Object.entries(K.classRules).map(([c, r]) => c + ' denies ' + r.denyProviders.concat(r.denyModels).join('/')).join('; ') + ')\n  order ' + K.order.join(' > ') + '\n  trials: ' + (K.trials.map(t => t.id + ' ' + t.status + ' ' + t.class + ' ' + arr(t.arms).length + ' arms').join('; ') || 'none'));
}
