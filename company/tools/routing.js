#!/usr/bin/env node
/* routing.js — the owner's switches for model routing, and the one writer of company/work/models/routing-policy.json
 * (docs/ROUTING.md). The router itself (company/tools/lib/routing.js decide, called by dispatch.js) only reads the policy.
 *
 *   node company/tools/routing.js status [--json]           the routing mode, the tier-cap mode, every trial with its arm
 *                                                           counts so far (from company/state/wakes.jsonl route fields),
 *                                                           why a trial is paused or held, and the last 20 routing-log
 *                                                           rows (changes and holds; never the per-wake decisions)
 *   node company/tools/routing.js mode off|shadow|live --by owner [--why ".."]       class routes and trials (owner only)
 *   node company/tools/routing.js tiercaps off|shadow|live --by owner [--why ".."]   executor tier caps (owner only)
 *   node company/tools/routing.js trial create <id> --class <class> --arm provider/model[@effort] --arm ...
 *        (--scope-dept <department id> | --scope-seat <seat>)... [--entry-share 0.1] [--min-items 30]
 *        [--pause-when-held claude-cli,...] --by <name> [--why ".."]
 *                                                           a DRAFT trial; by the people function or the owner
 *   node company/tools/routing.js trial start|pause|resume|stop <id> --by owner [--why ".."]   (owner only)
 *   node company/tools/routing.js trial show <id> [--json]
 *   node company/tools/routing.js --selftest
 *
 * Every change is one read-modify-write under an exclusive lock (company/work/models/routing-policy.json.lock,
 * lib/file-lock.js): a writer that cannot get the lock within a few seconds fails with exit 2 and records nothing.
 * Every change: company/work/models/routing-policy.json replaced atomically (created from the framework default
 * company/defaults/work/models/routing-policy.json on the first change) and its bytes recorded (provenance.js wrote, so
 * locked-watch.js knows it as this tool's write), one line in company/work/decisions.md (decision.js add), one row in
 * the policy's history file (company/work/models/routing-log.jsonl, recorded with provenance.js appended: locked-watch.js
 * keeps only the rows routing.js and lib/routing.js recorded). That log holds changes and events only, one schema
 * {at, ts, op, by, ...}: this tool's ops (CHANGE_OPS) and the router's trial-held / trial-unheld (lib/routing.js, when the
 * pacer holds a provider a running trial pauses on); the router's per-wake decisions are in routing-decisions.jsonl and
 * on wakes.jsonl, never here. A create is checked against company/model-policy.json
 * `allowed`, the policy's classRules (a code trial with a MiniMax-plan arm is refused) and trialLimits; its pauseWhenHeld
 * always covers every arm whose provider the pacer meters as a subscription (lib/pacing-ask.js SUBS, which pacer.js
 * uses: claude-cli and custom): they are added to the default, and a --pause-when-held that leaves one out is refused.
 * Owner-only commands go through company/tools/lib/owner.js: --by owner from the owner's own shell or the console.
 * Exit: 0 done (or nothing to change), 1 selftest failed or an unexpected error, 2 usage or refused.
 * Owner of this tool: the people function (the model manager).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const { withFileLock, LockBusy } = require('./lib/file-lock');

const TOOL = 'routing.js';
const MODES = ['off', 'shadow', 'live'];
const STATUSES = ['draft', 'running', 'paused', 'done'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];   // models.js EFFORTS
const TRIAL_ID = /^[a-z][a-z0-9-]{1,39}$/;
const LOG_DEFAULT = 'company/work/models/routing-log.jsonl';
const CHANGE_OPS = ['mode', 'tiercaps', 'trial-create', 'trial-start', 'trial-pause', 'trial-resume', 'trial-stop'];
const EVENT_OPS = ['trial-held', 'trial-unheld'];   // written by lib/routing.js (the dispatcher), read here
const LOG_OPS = CHANGE_OPS.concat(EVENT_OPS);
const LIMIT_DEFAULTS = { minArms: 2, maxArms: 4, maxEntryShare: 0.5, defaultEntryShare: 0.1, defaultMinItemsPerArm: 30, defaultPauseWhenHeld: ['claude-cli'] };

const S = {   // seams for the tests (company/tools/tests/routing-controls.test.js)
  root: () => co.ROOT,
  now: () => Date.now(),
  crew: () => co.crew(),
  ceo: () => co.ceo(),
  owner: () => require('./lib/owner'),
  prov: () => require('./provenance.js'),
  decision: o => require('./decision.js').add(o),
  // the owner's self-governance level for model changes (lib/governance.js; a test hands in its own)
  modelsLevel: () => { try { return require('./lib/governance').level('models', { root: co.ROOT }); } catch (_) { return 'approve'; } },
  tellOwner: (text, technical) => { try { require('./lib/governance').notify(text, { from: 'The crew', technical }); } catch (_) {} },
  lockOpts: () => ({}),   // lib/file-lock.js options (staleMs, retries, waitMs)
  // the providers the pacer meters as flat-fee subscriptions (pacer.js SUBS is built from the same table)
  subscriptions: () => { try { return Object.values(require('./lib/pacing-ask').SUBS).map(x => String(x.provider)).filter(Boolean); } catch (_) { return ['claude-cli', 'custom']; } },
};
const P = (...x) => path.join(S.root(), ...x);
const REL = 'company/work/models/routing-policy.json';
const DEFAULT_REL = 'company/defaults/work/models/routing-policy.json';
const readIf = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const readJson = (f, d) => { const t = readIf(f); if (t == null) return d; try { return JSON.parse(t); } catch (_) { return d; } };
const clean = (t, n) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 300);
const clone = o => JSON.parse(JSON.stringify(o == null ? null : o));
const iso = ms => new Date(ms).toISOString();
const given = v => v !== undefined && v !== true && v !== null && String(v).trim() !== '';
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }

class Refusal extends Error { constructor(msg, code) { super(msg); this.code = code || 2; } }

/* ---------------- the policy ---------------- */
// The company's copy, else the framework default (exactly as model-rank.js reads ranking-policy.json). A company copy
// that does not parse is an error: nothing is changed on top of it, and status says so.
function loadPolicy() {
  const own = readIf(P(REL));
  if (own != null) {
    try { const doc = JSON.parse(own); if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not an object'); return { doc, source: 'company', file: REL }; }
    catch (e) { return { doc: null, source: 'company', file: REL, error: REL + ' does not parse (' + e.message + ')' }; }
  }
  const def = readJson(P(DEFAULT_REL), null);
  if (def && typeof def === 'object') return { doc: def, source: 'default', file: DEFAULT_REL };
  return { doc: { mode: 'off', tierCaps: { mode: 'off' }, trials: [] }, source: 'none', file: null };
}
const modeOf = doc => MODES.includes(doc && doc.mode) ? doc.mode : 'off';
const capModeOf = doc => MODES.includes(doc && doc.tierCaps && doc.tierCaps.mode) ? doc.tierCaps.mode : 'off';
const trialsOf = doc => (doc && Array.isArray(doc.trials) ? doc.trials.filter(t => t && typeof t === 'object') : []);
function limitsOf(doc) {
  const l = Object.assign({}, LIMIT_DEFAULTS, (doc && doc.trialLimits && typeof doc.trialLimits === 'object') ? doc.trialLimits : {});
  const int = (v, d, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi) ? Number(v) : d;
  l.minArms = int(l.minArms, 2, 1, 12); l.maxArms = Math.max(l.minArms, int(l.maxArms, 4, 1, 12));
  l.maxEntryShare = Number(l.maxEntryShare) > 0 && Number(l.maxEntryShare) <= 1 ? Number(l.maxEntryShare) : 0.5;
  l.defaultEntryShare = Math.min(l.maxEntryShare, Number(l.defaultEntryShare) > 0 ? Number(l.defaultEntryShare) : 0.1);
  l.defaultMinItemsPerArm = int(l.defaultMinItemsPerArm, 30, 1, 100000);
  l.defaultPauseWhenHeld = Array.isArray(l.defaultPauseWhenHeld) ? l.defaultPauseWhenHeld.map(String) : ['claude-cli'];
  return l;
}
// the history file the policy names: under company/work/, a .jsonl, no '..' (anything else: the default)
function historyRel(doc) {
  const h = String((doc && doc.history) || '');
  return /^company\/work\/[A-Za-z0-9_./-]+\.jsonl$/.test(h) && !h.split('/').some(s => s === '..' || s === '.' || s === '') ? h : LOG_DEFAULT;
}

/* ---------------- who is asking ---------------- */
const nameOf = (crew, id) => (crew[id] && crew[id].name) || id;
function actor(by, cmd) {
  const name = String(by == null ? '' : by).trim();
  if (!name || by === true) throw new Refusal('--by <name> is required (who decides)');
  const own = S.owner();
  if (own.isOwnerName(name)) {
    const r = own.refusal(name, 'a routing change'); if (r) throw new Refusal(r);
    return { kind: 'owner', name: 'owner', label: (co.config.owner && co.config.owner.name) || 'the owner' };
  }
  const crew = S.crew(), low = name.toLowerCase();
  const id = crew[name] ? name : Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low);
  if (!id) throw new Refusal('--by "' + name + '" is not on the crew (company/tools/loops.json) and is not the owner');
  // inside an agent's run the --by claim must be that run's own seat
  let pv = null; try { pv = S.prov(); } catch (_) {}
  if (pv && pv.underStation()) {
    const env = String(process.env.STARNET_AGENT_ID || '').trim();
    if (env && env !== id) throw new Refusal('this run is ' + nameOf(crew, env) + '\'s, not ' + nameOf(crew, id) + '\'s: --by names the seat running the command');
    const c = pv.callerConflict(S.root(), [TOOL, cmd], id);
    if (c) throw new Refusal('this command claims --by ' + nameOf(crew, id) + ' but ran in another seat\'s run (' + c.runId + ')');
  }
  const seat = crew[id];
  return { kind: co.holds(seat, 'people') ? 'people' : id === S.ceo() ? 'ceo' : 'other', id, name: seat.name || id, label: seat.name || id };
}
function ownerOnly(by, what) {
  const name = String(by == null ? '' : by).trim();
  if (!S.owner().isOwnerName(name)) throw new Refusal(what + ' is the owner\'s decision: --by owner from the owner\'s own shell, or the console (Settings › Models and subscriptions › Cheaper models). The people function proposes it to the owner instead');
  return actor(by, what);
}

/* ---------------- writing ---------------- */
function commit(L, next, who, row) {
  if (process.env.CAPHEOS_READONLY === '1') throw new Refusal('read-only run (CAPHEOS_READONLY=1): routing.js changes nothing here');
  if (!L.lock) throw new Error('routing.js: commit outside the policy lock');
  // a company with no copy yet starts from the framework default (its _doc and every rule), with this change on top
  const text = JSON.stringify(next, null, 1) + '\n';
  const file = P(REL);
  L.lock.check();            // still ours: nobody broke it as stale while this change was planned
  writeAtomic(file, text);   // throws on failure: then no log row and no decision line are written
  // recorded only now, after the policy write, still under the lock (so the log's order is the file's order)
  try { S.prov().wrote(file, text, TOOL); } catch (_) {}
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const at = S.now();
  const log = Object.assign({ at, ts: iso(at), op: row.op, by: who.kind === 'owner' ? 'owner' : who.name }, row.fields || {}, row.why ? { why: row.why } : {}, { digest });
  const hist = P(historyRel(next)), line = JSON.stringify(log) + '\n';
  // recorded like lib/routing.js record(): locked-watch.js keeps only appends a writer recorded (class A)
  try { fs.mkdirSync(path.dirname(hist), { recursive: true }); fs.appendFileSync(hist, line); try { S.prov().appended(hist, line, TOOL, { root: S.root() }); } catch (_) {} } catch (_) {}
  let decision = null;
  try { decision = S.decision({ by: who.kind === 'owner' ? 'owner' : who.name, text: 'Model routing: ' + row.summary + '.', why: row.why || undefined }); } catch (e) { decision = { error: e.message }; }
  return { ok: true, changed: true, summary: row.summary, by: who.label, file: REL, created: L.source !== 'company' || undefined, digest,
    decision: decision && decision.ok ? decision.id : undefined, decisionError: decision && decision.error ? decision.error : undefined };
}
function editable(lock) {
  const L = loadPolicy();
  if (L.error) throw new Refusal(L.error + '; restore it (locked-watch.js revert ' + REL + ' --by <name>) before changing routing');
  return Object.assign(L, { next: clone(L.doc), lock });
}
// change(fn): fn(L) reads, plans and commits one change, all under the policy's exclusive lock. A read-only run takes no
// lock (it writes nothing: commit refuses). Lock busy -> a Refusal, before anything is read or recorded.
function change(fn) {
  if (process.env.CAPHEOS_READONLY === '1') return fn(editable(null));
  try { return withFileLock(P(REL), lock => fn(editable(lock)), Object.assign({ what: REL }, S.lockOpts())); }
  catch (e) { if (e instanceof LockBusy) throw new Refusal(e.message); throw e; }
}
const whyOf = a => given(a.why) ? clean(a.why, 300) : '';

function setMode(kind, value, a) {
  const what = kind === 'mode' ? 'the routing mode' : 'the tier-cap mode';
  const v = String(value || '').trim();
  if (!MODES.includes(v)) throw new Refusal(kind + ' takes one of ' + MODES.join(', ') + ' (got "' + v + '")');
  const who = ownerOnly(a.by, 'Changing ' + what);
  return change(L => {
    const cur = kind === 'mode' ? modeOf(L.doc) : capModeOf(L.doc);
    if (cur === v) return { ok: true, changed: false, summary: what + ' is ' + v + ' already' };
    if (kind === 'mode') L.next.mode = v;
    else L.next.tierCaps = Object.assign({}, (L.next.tierCaps && typeof L.next.tierCaps === 'object') ? L.next.tierCaps : {}, { mode: v });
    const summary = what + ' ' + cur + ' -> ' + v + (v === 'live' ? ' (applied only where the seat\'s override allowlist opens the chosen model)' : v === 'shadow' ? ' (recorded on each wake, not applied)' : ' (not computed)');
    return commit(L, L.next, who, { op: kind === 'mode' ? 'mode' : 'tiercaps', fields: { from: cur, to: v }, why: whyOf(a), summary });
  });
}

/* ---------------- trials ---------------- */
function parseArm(s) {
  const raw = String(s || '').trim();
  const slash = raw.indexOf('/');
  if (slash <= 0) throw new Refusal('an arm is provider/model[@effort] (got "' + raw + '")');
  const provider = raw.slice(0, slash), rest = raw.slice(slash + 1), at = rest.lastIndexOf('@');
  const model = at > 0 ? rest.slice(0, at) : rest, effort = at > 0 ? rest.slice(at + 1) : null;
  if (!model) throw new Refusal('an arm is provider/model[@effort] (got "' + raw + '")');
  return Object.assign({ provider, model }, effort ? { effort } : {});
}
const armLabel = x => x.provider + '/' + x.model + (x.effort ? '@' + x.effort : '');
const list = v => (v === undefined || v === true ? [] : [].concat(v)).flatMap(x => String(x).split(',')).map(x => x.trim()).filter(Boolean);
function classes() { try { return require('./lib/taskclass').CLASSES; } catch (_) { return ['code', 'review', 'research', 'writing', 'design', 'ops', 'mechanical', 'general']; } }
function deniedBy(doc, cls, arm) {
  const r = doc && doc.classRules && doc.classRules[cls];
  if (!r || typeof r !== 'object') return null;
  if (Array.isArray(r.denyProviders) && r.denyProviders.map(String).includes(arm.provider)) return 'classRules.' + cls + '.denyProviders';
  if (Array.isArray(r.denyModels) && r.denyModels.map(String).includes(arm.model)) return 'classRules.' + cls + '.denyModels';
  return null;
}
// the arms' providers that the pacer meters as subscriptions, in arm order, once each
function subscriptionArms(arms, subs) {
  const S2 = new Set((subs || S.subscriptions()).map(String));
  return (arms || []).map(x => String(x && x.provider || '')).filter((p, i, xs) => S2.has(p) && xs.indexOf(p) === i);
}
function heldGuard(t, subs) {
  const providers = Array.isArray(t.pauseWhenHeld) ? t.pauseWhenHeld.map(String) : [];
  const subscriptions = subscriptionArms(t.arms, subs);
  return { providers, subscriptions, missing: subscriptions.filter(p => !providers.includes(p)) };
}
/* planTrial(a, doc, ctx) -> the trial object, or a Refusal naming every problem. Pure apart from ctx. */
function planTrial(a, doc, ctx) {
  const probs = [];
  const id = String(a.pos[2] || '').trim();
  if (!TRIAL_ID.test(id)) probs.push('the trial id must be lowercase letters, digits and dashes, 2-40 characters, starting with a letter (got "' + id + '")');
  else if (trialsOf(doc).some(t => String(t.id) === id)) probs.push('a trial "' + id + '" exists already (ids are never reused: pick a new one)');
  const cls = given(a.class) ? String(a.class).trim() : '';
  if (!classes().includes(cls)) probs.push('--class must be one of ' + classes().join(', ') + (cls ? ' (got "' + cls + '")' : ''));
  const lim = limitsOf(doc), allowed = (ctx.modelPolicy && ctx.modelPolicy.allowed) || {};
  const armArgs = a.arm === undefined || a.arm === true ? [] : [].concat(a.arm);
  const arms = [];
  if (!armArgs.length) probs.push('a trial needs arms: --arm provider/model[@effort], at least ' + lim.minArms);
  for (const s of armArgs) {
    let arm; try { arm = parseArm(s); } catch (e) { probs.push(e.message); continue; }
    const fam = allowed[arm.provider];
    if (!fam) { probs.push(armLabel(arm) + ': provider ' + arm.provider + ' is not allowed (company/model-policy.json allowed)'); continue; }
    if (!Array.isArray(fam.models) || !fam.models.includes(arm.model)) { probs.push(armLabel(arm) + ': ' + arm.model + ' is not an allowed ' + arm.provider + ' model (company/model-policy.json allowed.' + arm.provider + '.models)'); continue; }
    if (arm.effort && !EFFORTS.includes(arm.effort)) { probs.push(armLabel(arm) + ': effort must be one of ' + EFFORTS.join(', ')); continue; }
    const deny = cls && deniedBy(doc, cls, arm);
    if (deny) { probs.push(armLabel(arm) + ': ' + cls + ' work may not run on ' + arm.provider + (arm.provider === 'custom' ? ' (the MiniMax plan)' : '') + ' (owner ruling, ' + deny + ')'); continue; }
    if (arms.some(x => armLabel(x) === armLabel(arm))) { probs.push(armLabel(arm) + ' is listed twice'); continue; }
    arms.push(arm);
  }
  if (armArgs.length && (armArgs.length < lim.minArms || armArgs.length > lim.maxArms)) probs.push('a trial has ' + lim.minArms + ' to ' + lim.maxArms + ' arms (trialLimits; got ' + armArgs.length + ')');
  const depts = list(a['scope-dept']), seats = list(a['scope-seat']);
  if (!depts.length && !seats.length) probs.push('name where the trial runs: --scope-dept <department id> and/or --scope-seat <seat>');
  const known = ctx.departments || [];
  for (const d of depts) if (!known.some(x => String(x.id) === d)) probs.push('no department "' + d + '" (departments.js list)');
  for (const s of seats) if (!ctx.crew[s]) probs.push(s + ' is not a seat on the crew (company/tools/loops.json)');
  let share = lim.defaultEntryShare;
  if (a['entry-share'] !== undefined) { share = Number(a['entry-share']); if (!(share > 0 && share <= lim.maxEntryShare)) probs.push('--entry-share is a share of the wakes in scope, more than 0 and at most ' + lim.maxEntryShare + ' (trialLimits.maxEntryShare)'); }
  let minItems = lim.defaultMinItemsPerArm;
  if (a['min-items'] !== undefined) { minItems = Number(a['min-items']); if (!(Number.isInteger(minItems) && minItems >= 1 && minItems <= 100000)) probs.push('--min-items is a whole number of items per arm, 1 or more'); }
  // every arm on a subscription the pacer meters pauses the trial while that subscription is held
  const armSubs = subscriptionArms(arms, ctx.subscriptions);
  let held;
  if (a['pause-when-held'] !== undefined) {
    held = list(a['pause-when-held']);
    if (a['pause-when-held'] === true || !held.length) probs.push('--pause-when-held takes providers, comma separated (got none)');
    const drop = armSubs.filter(p => !held.includes(p));
    if (drop.length) probs.push('--pause-when-held ' + (held.join(',') || '(none)') + ' leaves out ' + drop.join(', ') + ': an arm runs on ' + (drop.length > 1 ? 'those subscriptions' : 'that subscription') + ', so the trial must pause while the pacer holds ' + (drop.length > 1 ? 'them' : 'it') + ' (add ' + drop.join(',') + ')');
  } else held = lim.defaultPauseWhenHeld.concat(armSubs).filter((p, i, xs) => xs.indexOf(p) === i);
  for (const p of held) if (!allowed[p]) probs.push('--pause-when-held ' + p + ' is not an allowed provider');
  if (probs.length) throw new Refusal('refused: ' + probs.join('; '));
  return { id, class: cls, arms, scope: { departments: depts, seats }, entryShare: share, status: 'draft', pauseWhenHeld: held, minItemsPerArm: minItems,
    createdAt: iso(S.now()), createdBy: ctx.who, why: whyOf(a) || undefined };
}
function createTrial(a) {
  const who = actor(a.by, 'trial');
  if (who.kind !== 'owner' && who.kind !== 'people') throw new Refusal(who.label + ' may not create a trial: the people function (the model manager) or the owner drafts one; the owner starts it, or the people function while the owner\'s models level lets the crew decide');
  let departments = [];
  try { const D = require('./lib/departments'); departments = D.list(D.load({ root: S.root() }).doc); } catch (_) {}
  return change(L => {
    const t = planTrial(a, L.doc, { modelPolicy: readJson(P('company', 'model-policy.json'), {}), departments, crew: S.crew(), who: who.kind === 'owner' ? 'owner' : who.name, subscriptions: S.subscriptions() });
    L.next.trials = trialsOf(L.next).concat([t]);
    const summary = 'draft trial ' + t.id + ' for ' + t.class + ' work: ' + t.arms.map(armLabel).join(' vs ') + ', ' + Math.round(t.entryShare * 100) + '% of wakes in ' + scopeText(t.scope) + ', ' + t.minItemsPerArm + ' items per arm, paused while the pacer holds ' + (t.pauseWhenHeld.join(' or ') || 'nothing') + ' (not started: the owner starts it)';
    return Object.assign(commit(L, L.next, who, { op: 'trial-create', fields: { trial: t.id, to: 'draft' }, why: whyOf(a), summary }), { trial: t });
  });
}
const scopeText = s => [].concat((s.departments || []).map(d => 'department ' + d), (s.seats || []).map(x => 'seat ' + x)).join(', ') || 'nowhere';
const FROM = { start: ['draft'], pause: ['running'], resume: ['paused'], stop: ['draft', 'running', 'paused'] };
const TO = { start: 'running', pause: 'paused', resume: 'running', stop: 'done' };
const overlaps = (x, y) => (x.departments || []).some(d => (y.departments || []).includes(d)) || (x.seats || []).some(s => (y.seats || []).includes(s));
/* who may start, pause, resume or stop a trial: the owner always; the people function (the model manager) too while the
 * owner's `models` level lets the crew decide model changes (auto, or notify: the owner then reads one plain line in the
 * day's message). At approve (or triage) it stays the owner's, from Settings › Models and subscriptions › Cheaper models. */
function moveTrial(op, id, a) {
  const what = (op[0].toUpperCase() + op.slice(1)) + 'ing a trial';
  const name = String(a.by == null ? '' : a.by).trim();
  let who;
  if (S.owner().isOwnerName(name)) who = ownerOnly(a.by, what);
  else {
    const lv = S.modelsLevel();
    if (lv !== 'auto' && lv !== 'notify') return ownerOnly(a.by, what);   // throws the owner's refusal
    who = actor(a.by, what);
    if (who.kind !== 'people') throw new Refusal(who.label + ' may not do this: the people function (the model manager) or the owner moves a trial');
  }
  const r = change(L => moveIn(L, op, id, a, who));
  if (who.kind !== 'owner' && r && r.changed !== false && S.modelsLevel() === 'notify') {
    const did = { start: 'started', pause: 'paused', resume: 'resumed', stop: 'stopped' }[op];
    S.tellOwner(who.name + ' ' + did + ' a trial that compares AI models on real work, as your settings allow. You can see it in Settings › Models and subscriptions.', 'routing.js trial ' + op + ' ' + id + ' by ' + who.name + ' (models at notify).');
  }
  return r;
}
function moveIn(L, op, id, a, who) {
  const trials = trialsOf(L.next), t = trials.find(x => String(x.id) === String(id));
  if (!t) throw new Refusal('no trial "' + (id || '') + '" (routing.js status)');
  const cur = STATUSES.includes(t.status) ? t.status : 'draft';
  if (cur === TO[op]) return { ok: true, changed: false, summary: 'trial ' + t.id + ' is ' + cur + ' already' };
  if (!FROM[op].includes(cur)) throw new Refusal('trial ' + t.id + ' is ' + cur + ': ' + op + ' works on a ' + FROM[op].join(' or ') + ' trial');
  if (op === 'start' || op === 'resume') {
    const clash = trials.find(x => x !== t && x.class === t.class && ['running', 'paused'].includes(x.status) && overlaps(x.scope || {}, t.scope || {}));
    if (clash) throw new Refusal('trial ' + clash.id + ' (' + clash.status + ') already tests ' + t.class + ' work in ' + scopeText(clash.scope || {}) + ': stop it first, so a wake is never in two trials');
  }
  const at = iso(S.now()), by = who.kind === 'owner' ? 'owner' : who.name, why = whyOf(a);
  t.status = TO[op];
  if (op === 'start') Object.assign(t, { startedAt: at, startedBy: by });
  if (op === 'pause') Object.assign(t, { pausedAt: at, pausedBy: by, pauseWhy: why || undefined });
  if (op === 'resume') { Object.assign(t, { resumedAt: at, resumedBy: by }); delete t.pausedAt; delete t.pausedBy; delete t.pauseWhy; }
  if (op === 'stop') Object.assign(t, { stoppedAt: at, stoppedBy: by, stopWhy: why || undefined });
  const mode = modeOf(L.next);
  const summary = op + ' trial ' + t.id + ' (' + cur + ' -> ' + t.status + ')' + (op === 'start' || op === 'resume' ? (mode === 'live' ? '' : '; routing is ' + mode + ', so its arms are ' + (mode === 'shadow' ? 'recorded, not applied' : 'not computed') + ' until the owner switches routing live') : '');
  return Object.assign(commit(L, L.next, who, { op: 'trial-' + op, fields: { trial: t.id, from: cur, to: t.status }, why, summary }), { trial: t });
}

/* ---------------- reading: counts, pauses, the log ---------------- */
// What a wake row's route says about trials: { trial, arm (index or null), applied, why? } for an assignment, and the
// trials it says are held. Accepts route.trial / route.trialId, route.arm as an index, "<trial>:<index>" or {trial, index},
// and the same inside route.wouldApply (a shadow decision).
function trialOfRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const pick = (x, applied) => {
    if (!x || typeof x !== 'object' || x.source !== 'trial') return null;
    let trial = x.trial || x.trialId || null, arm = x.arm;
    if (arm && typeof arm === 'object') { trial = trial || arm.trial || arm.id || null; arm = arm.index; }
    if (typeof arm === 'string') { const m = arm.match(/^(.*?)[:#](\d+)$/); if (m) { trial = trial || m[1]; arm = Number(m[2]); } else if (/^\d+$/.test(arm)) arm = Number(arm); }
    return trial ? { trial: String(trial), arm: Number.isInteger(arm) ? arm : null, provider: x.provider, model: x.model, effort: x.effort, applied } : null;
  };
  // the route's own source/trial is what the wake ran on: applied as the one-run override, or the arm that is the seat's
  // own pair (the control arm, applied false but run on it); wouldApply is a shadow (or not open) assignment
  return pick(r, true) || pick(r.wouldApply, false);
}
function heldOfRoute(r) {
  const x = r && (r.trialPaused || r.trialHeld);
  return (x ? [].concat(x) : []).filter(y => y && typeof y === 'object' && (y.trial || y.id)).map(y => ({ trial: String(y.trial || y.id), why: clean(y.why || y.reason || 'held', 200) }));
}
function wakeRows(sinceMs) {
  try { return require('./lib/wakes').rows({ sinceMs, file: P('company', 'state', 'wakes.jsonl') }); } catch (_) { return []; }
}
// the routing log's change and event rows (a row without a known op, such as a decision row an older router wrote here,
// is never shown as a change)
function logRows(doc, n) {
  try { return require('./lib/bounded').tailLines(P(historyRel(doc)), n, { maxBytes: 4 * 1048576 }).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && typeof r === 'object' && LOG_OPS.includes(r.op)); } catch (_) { return []; }
}
function armIndexOf(t, x) {
  if (Number.isInteger(x.arm) && x.arm >= 0 && x.arm < t.arms.length) return x.arm;
  const i = t.arms.findIndex(a => a.provider === x.provider && a.model === x.model && (!a.effort || !x.effort || a.effort === x.effort));
  return i >= 0 ? i : null;
}
function trialView(t, rows, log, subs) {
  const arms = (Array.isArray(t.arms) ? t.arms : []).map((a, i) => ({ index: i, provider: a.provider, model: a.model, effort: a.effort || null, label: armLabel(a), wakes: 0, items: 0, shadowWakes: 0, shadowItems: 0 }));
  const seen = arms.map(() => ({ live: new Set(), shadow: new Set() }));
  const since = Date.parse(t.startedAt || t.createdAt || '') || 0;
  let held = null, unknownArm = 0;
  for (const w of rows) {
    if ((Number(w.at) || 0) < since) continue;
    const x = trialOfRoute(w.route);
    if (x && x.trial === String(t.id)) {
      const i = armIndexOf({ arms: arms }, x);
      if (i == null) unknownArm++;
      else {
        const k = x.applied ? 'live' : 'shadow';
        if (x.applied) arms[i].wakes++; else arms[i].shadowWakes++;
        for (const it of (w.items || [])) if (it && it.id) seen[i][k].add(String(it.id));
      }
    }
    for (const h of heldOfRoute(w.route)) if (h.trial === String(t.id)) held = { at: iso(Number(w.at) || 0), why: h.why, from: 'wakes.jsonl' };
  }
  arms.forEach((a, i) => { a.items = seen[i].live.size; a.shadowItems = seen[i].shadow.size; });
  // the router records a hold and its end in the routing log (op trial-held / trial-unheld); the newer of it and the
  // newest wake that named the hold wins
  for (const r of log) {
    if (String(r.trial || '') !== String(t.id)) continue;
    const at = r.ts || (r.at ? iso(Number(r.at)) : null);
    if (r.op === 'trial-held' && (!held || String(at) >= held.at)) held = { at, why: clean(r.why || 'held by the pacer', 200), from: 'routing-log' };
    if (r.op === 'trial-unheld' && held && String(at) >= held.at) held = null;
  }
  const reasons = [];
  if (t.status === 'paused') reasons.push('paused by ' + (t.pausedBy || 'the owner') + (t.pausedAt ? ' at ' + t.pausedAt : '') + (t.pauseWhy ? ': ' + t.pauseWhy : ''));
  if (t.status === 'running' && held) reasons.push('held: ' + held.why + ' (since ' + held.at + ')');
  const min = Number(t.minItemsPerArm) || 0;
  const n = a => a.items + a.shadowItems;
  return Object.assign(clone(t), { arms, countedSince: since ? iso(since) : null, unknownArm: unknownArm || undefined,
    hold: t.status === 'running' ? held : null, reasons, heldGuard: heldGuard(t, subs),
    progress: { minItemsPerArm: min, lowestArm: arms.length ? Math.min(...arms.map(n)) : 0, enough: arms.length > 0 && arms.every(a => n(a) >= min) } });
}
function status() {
  const L = loadPolicy(), doc = L.doc || {};
  const trials = trialsOf(doc);
  const starts = trials.filter(t => t.status !== 'draft').map(t => Date.parse(t.startedAt || t.createdAt || '')).filter(Number.isFinite);
  const rows = starts.length ? wakeRows(Math.min(...starts)) : [];
  const log = logRows(doc, 400);
  const tc = doc.tierCaps && typeof doc.tierCaps === 'object' ? doc.tierCaps : {};
  const subs = S.subscriptions();
  return { ok: !L.error, error: L.error || undefined, file: REL, source: L.source, mode: modeOf(doc), classRules: doc.classRules || {}, order: doc.order || null,
    tierCaps: { mode: capModeOf(doc), allow: tc.allow || [], heavyEscape: tc.heavyEscape || null, exemptFunctions: tc.exemptFunctions || [], exemptLeads: tc.exemptLeads !== false },
    trialLimits: Object.assign(limitsOf(doc), { subscriptionProviders: subs }), trials: trials.map(t => trialView(t, rows, log, subs)), log: log.slice(-20).reverse(), history: historyRel(doc) };
}

/* ---------------- text output ---------------- */
function trialText(t) {
  const g = t.heldGuard || { providers: [], missing: [] };
  const L = [t.id + ' — ' + t.class + ' work, ' + t.status + ', ' + Math.round((Number(t.entryShare) || 0) * 100) + '% of wakes in ' + scopeText(t.scope || {}) + ', ' + t.minItemsPerArm + ' items per arm, paused while the pacer holds ' + (g.providers.join(' or ') || 'nothing') + (g.missing.length ? ' (NOT ' + g.missing.join(' or ') + ', which an arm runs on)' : '')];
  for (const a of t.arms) L.push('  arm ' + a.index + ' ' + a.label + ': ' + a.items + ' items in ' + a.wakes + ' applied wakes, ' + a.shadowItems + ' items in ' + a.shadowWakes + ' shadow wakes');
  for (const r of t.reasons) L.push('  ' + r);
  return L.join('\n');
}
function statusText(s) {
  const L = [];
  if (s.error) L.push('ERROR: ' + s.error);
  L.push('Routing (class routes and trials): ' + s.mode + '.  Tier caps: ' + s.tierCaps.mode + '.  Policy: ' + (s.source === 'company' ? s.file : 'the framework default (' + DEFAULT_REL + ')'));
  L.push(s.trials.length ? 'Trials:' : 'No trials.');
  for (const t of s.trials) L.push(trialText(t));
  if (s.log.length) { L.push('Recent changes and holds:'); for (const r of s.log) L.push('  ' + (r.ts || '') + ' ' + r.op + (r.trial ? ' ' + r.trial : '') + (r.to ? ' -> ' + r.to : '') + ' by ' + (r.by || '?') + (r.why ? ': ' + r.why : '')); }
  return L.join('\n');
}

/* ---------------- CLI ---------------- */
function args(argv) {
  const o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    const v = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    if (k === 'arm' || k === 'scope-dept' || k === 'scope-seat') o[k] = (o[k] === undefined ? [] : [].concat(o[k])).concat([v]);
    else o[k] = v;
  }
  return o;
}
const USAGE = 'usage: routing.js status [--json] | mode off|shadow|live --by owner | tiercaps off|shadow|live --by owner | trial create <id> --class <c> --arm provider/model[@effort] ... (--scope-dept <id> | --scope-seat <seat>) [--entry-share 0.1] [--min-items 30] --by <name> | trial start|pause|resume|stop <id> --by owner | trial show <id> [--json] | --selftest';
function main(argv) {
  const a = args(argv), cmd = a.pos[0] || 'status';
  if (cmd === 'status') { const s = status(); return { code: s.error ? 1 : 0, out: a.json ? s : statusText(s) }; }
  if (cmd === 'mode' || cmd === 'tiercaps') return { code: 0, out: setMode(cmd, a.pos[1], a) };
  if (cmd === 'trial') {
    const sub = a.pos[1];
    if (sub === 'create') return { code: 0, out: createTrial(a) };
    if (sub === 'show') {
      const s = status(), t = s.trials.find(x => String(x.id) === String(a.pos[2]));
      if (!t) throw new Refusal('no trial "' + (a.pos[2] || '') + '" (routing.js status)');
      const log = s.log.filter(r => String(r.trial || '') === String(t.id));
      return { code: 0, out: a.json ? { ok: true, mode: s.mode, trial: t, log } : trialText(t) };
    }
    if (FROM[sub]) return { code: 0, out: moveTrial(sub, a.pos[2], a) };
  }
  throw new Refusal(USAGE);
}
function run(argv) {
  try { return main(argv); }
  catch (e) { if (e instanceof Refusal) return { code: e.code, out: { ok: false, error: e.message, refused: true } }; return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; }
}

/* ---------------- selftest: the pure parts (the CLI end to end: tests/routing-controls.test.js) ---------------- */
function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  ok('an arm parses provider/model@effort, with the model keeping its brackets', JSON.stringify(parseArm('claude-cli/claude-fable-5-2[1m]@medium')) === JSON.stringify({ provider: 'claude-cli', model: 'claude-fable-5-2[1m]', effort: 'medium' }));
  ok('an arm without effort leaves it to the station', !('effort' in parseArm('deepseek/deepseek-flash')));
  const doc = { classRules: { code: { denyProviders: ['custom'] } }, trials: [{ id: 'old' }] };
  const ctx = { modelPolicy: { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }, custom: { models: ['MiniMax-M3.1-Pro'] }, deepseek: { models: ['deepseek-flash'] } } }, departments: [{ id: 'eng' }], crew: { kim: {} }, who: 'Hal' };
  const base = { pos: ['trial', 'create', 'cmp'], class: 'code', arm: ['claude-cli/claude-sonnet-5-5@high', 'claude-cli/claude-opus-5-5@medium'], 'scope-dept': ['eng'] };
  const t = planTrial(base, doc, ctx);
  ok('a valid draft: arms, scope, the configured defaults', t.status === 'draft' && t.arms.length === 2 && t.entryShare === 0.1 && t.minItemsPerArm === 30 && t.pauseWhenHeld[0] === 'claude-cli');
  const refuse = (o, re) => { try { planTrial(Object.assign({}, base, o), doc, ctx); return false; } catch (e) { return re.test(e.message); } };
  ok('a code arm on the MiniMax plan is refused (owner ruling)', refuse({ arm: ['claude-cli/claude-sonnet-5-5', 'custom/MiniMax-M3.1-Pro'] }, /owner ruling/));
  ok('the same MiniMax arm is fine for research', (() => { try { return planTrial(Object.assign({}, base, { class: 'research', arm: ['deepseek/deepseek-flash', 'custom/MiniMax-M3.1-Pro'] }), doc, ctx).arms.length === 2; } catch (_) { return false; } })());
  ok('an unknown model is refused', refuse({ arm: ['claude-cli/gpt-9', 'deepseek/deepseek-flash'] }, /not an allowed claude-cli model/));
  ok('no arms is refused', refuse({ arm: undefined }, /needs arms/));
  ok('a reused id is refused', refuse({ pos: ['trial', 'create', 'old'] }, /exists already/));
  ok('an entry share over the limit is refused', refuse({ 'entry-share': '0.9' }, /entry-share/));
  ok('a scope is required', refuse({ 'scope-dept': undefined }, /scope/));
  const rs = Object.assign({}, base, { class: 'research', arm: ['deepseek/deepseek-flash', 'custom/MiniMax-M3.1-Pro'] });
  ok('a MiniMax arm adds custom to the default pauseWhenHeld', JSON.stringify(planTrial(rs, doc, Object.assign({}, ctx, { subscriptions: ['claude-cli', 'custom'] })).pauseWhenHeld) === '["claude-cli","custom"]');
  ok('a --pause-when-held that drops a subscription arm is refused', (() => { try { planTrial(Object.assign({}, rs, { 'pause-when-held': 'deepseek' }), doc, Object.assign({}, ctx, { subscriptions: ['claude-cli', 'custom'] })); return false; } catch (e) { return /leaves out custom/.test(e.message); } })());
  ok('the guard names a gap in an older trial', JSON.stringify(heldGuard({ arms: [{ provider: 'custom' }], pauseWhenHeld: ['claude-cli'] }, ['claude-cli', 'custom']).missing) === '["custom"]');
  const tv = trialView({ id: 'cmp', status: 'running', startedAt: '2030-01-01T00:00:00.000Z', minItemsPerArm: 1, arms: t.arms }, [
    { at: Date.parse('2030-01-01T01:00:00Z'), items: [{ id: 'a' }], route: { source: 'trial', trial: 'cmp', arm: 0, applied: true } },
    { at: Date.parse('2030-01-01T02:00:00Z'), items: [{ id: 'b' }, { id: 'c' }], route: { source: 'route', applied: false, wouldApply: { source: 'trial', arm: 'cmp:1' } } },
    { at: Date.parse('2029-12-31T00:00:00Z'), items: [{ id: 'z' }], route: { source: 'trial', trial: 'cmp', arm: 0, applied: true } }], []);
  ok('counts: applied and shadow per arm, rows before the start left out', tv.arms[0].wakes === 1 && tv.arms[0].items === 1 && tv.arms[1].shadowWakes === 1 && tv.arms[1].shadowItems === 2 && tv.progress.enough === true);
  const tc = trialView({ id: 'cmp', status: 'running', startedAt: '2030-01-01T00:00:00.000Z', minItemsPerArm: 1, arms: t.arms }, [
    { at: Date.parse('2030-01-01T01:00:00Z'), items: [{ id: 'k' }], route: { source: 'trial', trial: 'cmp', arm: 1, applied: false, mode: 'live' } }], []);
  ok('the control arm (the seat\'s own pair, run without an override) counts as run on that arm, not as shadow', tc.arms[1].wakes === 1 && tc.arms[1].items === 1 && tc.arms[1].shadowWakes === 0);
  const th = trialView({ id: 'cmp', status: 'running', startedAt: '2030-01-01T00:00:00.000Z', arms: t.arms }, [], [
    { at: Date.parse('2030-01-01T01:00:00Z'), op: 'trial-held', by: 'dispatcher', trial: 'cmp', providers: ['claude-cli'], why: 'claude-cli held by the pacer' }]);
  ok('a trial-held row in the routing log shows the trial held, with the reason', th.hold && th.hold.why === 'claude-cli held by the pacer' && /held: claude-cli held by the pacer/.test(th.reasons.join(' ')));
  console.log(bad ? 'ROUTING SELFTEST FAILED: ' + bad : 'ROUTING SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { run, status, planTrial, parseArm, trialOfRoute, heldGuard, loadPolicy, S, Refusal, REL, DEFAULT_REL, LOG_DEFAULT, CHANGE_OPS, EVENT_OPS };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  if (r.out !== undefined) console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  process.exit(r.code);
}
