'use strict';
/* lib/delegate-allow.js — the station's delegation allowlist: company/state/delegate-allow.json (docs/DEPARTMENTS.md §6,
 * the middle-management plan's P5: narrow fan-out).
 *
 * StarNet patch 0018 (company/patches/0018-team-dispatch-limits.diff) gives a ROUTINE run the team.dispatch tool only
 * when its agent is listed here, refuses a worker that is not on that lead's list for the item, caps the workers per
 * dispatch at the list's maxWorkers and gives each worker its own time limit. The station reads the file named by its
 * env STARNET_DELEGATE_ALLOW and refuses a copy older than 30 minutes (fail closed: no list = no routine run delegates).
 *
 *   { "v": 1, "at": <epoch ms>, "by": "dispatcher",
 *     "leads": { "<lead agentId>": { "items": ["<item id>"], "workers": ["<agentId>"], "maxWorkers": 3, "workerTimeoutMin": 20,
 *                                    "runWorkers": <pieces>, "models": { "<agentId>": [{ "provider": "..", "model": ".." }] } } } }
 * models: the ONLY pairs that worker may run on for this item (the station always runs a listed worker on one of them,
 * the first when the lead names none, and refuses a worker whose list is empty), each allowed for the item's class; the
 * worker's own pair first when it is allowed. runWorkers: how many workers the lead may start in the whole run (the
 * split's piece count): a lead cannot loop team.dispatch call after call.
 *
 * A lead is listed only when ALL hold, for ONE item at a time (the first, in a stable order):
 *   - its department's delegation is live (departments.json delegation.mode live, not withdrawn) and it is the lead;
 *   - an item it owns or consulted on has a RECORDED split (lib/consult.js splitCandidates: a SPLIT answer or the lead's
 *     own consult.js split, the pieces still exactly as recorded) with **Fan-out:** dispatch;
 *   - its workers = delegation.workers ∩ the lead's reports in loops.json ∩ the crew ∩ not busy (in a meeting or a live
 *     chat, a loop run in flight, a live Sprint lane, a live child run): at least one remains;
 *   - the item's class is code when the split says so OR any piece lists a code file (.js, .ts, .py, ...): for a code item
 *     no worker whose model is on a provider the class rules deny (the MiniMax plan) is listed, and the models listed for
 *     each worker are filtered by the same rules;
 *   - its split was not used yet: once a child run of a listed worker for that split has started (a live child run in the
 *     station's run table, or a run row with the item's id), the split is used and not listed again (a new split is);
 *   - the money check (lib/admit.js money(): the daily metered cap, the per-agent share, the Sprint budget and spread) and
 *     the pacer (the override allowlist lib/override-allow.js wrote this tick lists an open pair on that provider for the
 *     worker) are open for EVERY listed worker's provider; one held worker lists no workers for that lead.
 * maxWorkers = min(delegation.maxWorkers, the workers listed); workerTimeoutMin = delegation.workerTimeoutMin.
 *
 *   const DA = require('./lib/delegate-allow');
 *   DA.compute({ candidates, doc, st, crew, jobs, busy, open, money, used, now })  pure -> { doc, notes }
 *   DA.writeEmpty({ root?, log? })                                         nobody listed (a halted company: dispatch.js)
 *   await DA.write({ root?, jobs?, log?, dry?, budget?, now? })              -> { ok, file, leads, notes }
 *   DA.withdrawStep({ root?, log?, dry? })                                   the auto-withdraw: the house ranking's fan-out
 *                                                                             evaluation said withdraw (once per hash)
 *   await DA.step({ jobs, log, dry, budget })                                 both, in that order (dispatch.js, one line)
 * Regenerated on every tick: locked-watch.js class R (writer lib/delegate-allow.js). Never throws from write(). CLI:
 * `node company/tools/lib/delegate-allow.js write|show`. Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const REL = 'company/state/delegate-allow.json';
const WRITER = 'lib/delegate-allow.js';
const MAX_AGE_MS = 30 * 60e3;
const fileOf = root => path.join(path.resolve(root || co.ROOT), REL);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

/* the worker's current pair: its loop routine's provider/model (what a dispatched run of it would run on), else the first
   open pair the override allowlist lists for it */
function pairOf(id, crew, jobs, open) {
  const loop = crew[id] && crew[id].loop;
  if (loop) {
    const hits = (jobs || []).filter(j => j && (j.name === loop || String(j.name || '').startsWith(loop + ' ') || j.name === loop));
    const j = hits.length === 1 ? hits[0] : (jobs || []).find(x => x && x.agentId === id && String(x.name || '').startsWith(loop));
    if (j && j.provider && j.model) return { provider: String(j.provider), model: String(j.model) };
  }
  const o = (open && open[id]) || [];
  return o[0] ? { provider: String(o[0].provider), model: String(o[0].model) } : null;
}

// A piece is code work unless every file it names is plainly not code (documents, text, pictures): .html, .css, .json, .yml,
// a Dockerfile, an .astro page or a bare folder like src/app/ all count as code (2026-11-19 safety re-review: a list of
// code extensions missed them, so such an item could be listed for MiniMax workers). A piece that names no file is code
// when its department's default class is code. The item is then code whatever its words or its **Class:** line say.
const NONCODE_FILE = /\.(?:md|markdown|mdx?|txt|text|rst|adoc|org|pdf|docx?|odt|rtf|csv|tsv|xlsx?|ods|pptx?|odp|png|jpe?g|gif|webp)$/i;
const pieceIsCode = (p, d) => { const fs_ = (p && p.files || []).map(f => String(f).trim()).filter(Boolean); return fs_.length ? fs_.some(f => !NONCODE_FILE.test(f)) : !!(d && d.defaultClass === 'code'); };
const classOf = (c, d) => (c && (c.class === 'code' || (c.pieces || []).some(p => pieceIsCode(p, d)))) ? 'code' : String((c && c.class) || 'general');
/* compute(o) -> { doc, notes: [{ lead, item, why }] }: pure (see the header) */
function compute(o) {
  o = o || {};
  const crew = o.crew || {}, D = require('./departments');
  const busy = o.busy instanceof Set ? o.busy : new Set(o.busy || []);
  const open = o.open || {};
  const denied = typeof o.classDenied === 'function' ? o.classDenied : (cls, pair) => !!(pair && cls === 'code' && pair.provider === 'custom');
  const money = typeof o.money === 'function' ? o.money : () => 'no money check this tick';
  const leads = {}, notes = [];
  const used = o.used instanceof Set ? o.used : new Set(o.used || []);
  for (const c0 of (o.candidates || []).filter(x => x && x.fanout === 'dispatch')) {
    const d = D.list(o.doc || {}).find(x => String(x.id) === String(c0.dept));
    const c = Object.assign({}, c0, { class: classOf(c0, d) });
    if (c.split && used.has(String(c.split))) { notes.push({ lead: c.lead, item: c.item, why: 'this split was dispatched already (its workers started); a new split is listed again' }); continue; }
    if (leads[c.lead]) { notes.push({ lead: c.lead, item: c.item, why: 'one item at a time per lead (' + leads[c.lead].items[0] + ' is listed)' }); continue; }
    if (!d || String(d.lead) !== String(c.lead)) { notes.push({ lead: c.lead, item: c.item, why: 'not the department\'s lead now' }); continue; }
    const g = D.delegationOf(d, o.st);
    if (g.effective !== 'live') { notes.push({ lead: c.lead, item: c.item, why: 'splitting is ' + g.effective }); continue; }
    const under = D.subtree(c.lead, crew);
    let workers = g.workers.filter(w => crew[w] && under.has(w) && w !== String(c.lead));
    const out = []; let held = null;
    for (const w of workers) {
      if (busy.has(w)) { notes.push({ lead: c.lead, item: c.item, worker: w, why: 'busy' }); continue; }
      const pair = pairOf(w, crew, o.jobs, open);
      if (!pair) { notes.push({ lead: c.lead, item: c.item, worker: w, why: 'no model it can run now' }); held = held || w + ' has no model it can run now'; continue; }
      if (denied(c.class, pair)) { notes.push({ lead: c.lead, item: c.item, worker: w, why: c.class + ' work never runs on ' + pair.provider }); continue; }
      const openPairs = (open[w] || []).filter(p => p && p.provider && p.model && !denied(c.class, p));
      if (!openPairs.some(p => String(p.provider) === pair.provider)) { held = held || w + '\'s ' + pair.provider + ' is held now (the pacer, a stop or a closure)'; continue; }
      const why = money(w, pair.provider);
      if (why) { held = held || w + ': ' + why; continue; }
      // the worker's own pair first (what it runs on when the lead names no model), then the other open pairs
      const ms = openPairs.map(p => ({ provider: String(p.provider), model: String(p.model) }));
      ms.sort((a, b) => (b.provider === pair.provider && b.model === pair.model) - (a.provider === pair.provider && a.model === pair.model));
      if (!ms.length) { notes.push({ lead: c.lead, item: c.item, worker: w, why: 'no model it may run on for ' + c.class + ' work' }); continue; }
      out.push({ w, models: ms });
    }
    if (held) { notes.push({ lead: c.lead, item: c.item, why: 'not listed: ' + held }); continue; }
    if (!out.length) { notes.push({ lead: c.lead, item: c.item, why: 'not listed: no free worker on the team' }); continue; }
    const pieces = (c.pieces || []).length || 0;
    const maxP = Math.max(Number(g.maxPieces) || 6, Number(g.minPieces) || 2);
    if (pieces > maxP) { notes.push({ lead: c.lead, item: c.item, why: 'not listed: ' + pieces + ' pieces, more than the ' + maxP + ' one split may have (delegation.maxPieces)' }); continue; }
    const maxW = Math.min(g.maxWorkers, out.length, pieces || Infinity);
    // the whole lead run starts at most one worker per piece, and never more than maxPieces (the station caps it at 50)
    leads[c.lead] = { items: [c.item], workers: out.map(x => x.w), maxWorkers: maxW, workerTimeoutMin: g.workerTimeoutMin, runWorkers: Math.min(pieces || maxW, maxP),
      models: Object.fromEntries(out.map(x => [x.w, x.models])), dept: String(c.dept), split: c.split || null, class: c.class };
  }
  const at = Number.isFinite(o.now) ? o.now : Date.now();
  return { doc: { v: 1, at, by: 'dispatcher', leads }, notes };
}

/* who is busy now: a loop run in flight, a live Sprint lane (lanes.json), a meeting or live chat (lib/meetings.js), a live
   child run (the station's run table: the dispatcher passes FAM.liveChildSeats of its snapshot) */
function busySeats(root, crew, jobs, liveKids) {
  const out = new Set();
  // a seat on a live child run (lib/family.js liveChildSeats from the station's run table, the dispatcher's snapshot)
  for (const id of (liveKids instanceof Map ? liveKids.keys() : Array.isArray(liveKids) ? liveKids : liveKids instanceof Set ? liveKids : [])) out.add(String(id));
  for (const [id, c] of Object.entries(crew || {})) {
    const loop = c && c.loop; if (!loop) continue;
    if ((jobs || []).some(j => j && String(j.name || '').startsWith(loop) && (j.inFlight || j.state === 'running'))) out.add(id);
  }
  try { for (const l of (readJson(path.join(root, 'company', 'state', 'lanes.json'), {}) || {}).lanes || []) if (l && l.seat) out.add(String(l.seat)); } catch (_) {}
  try { const M = require('./meetings'); for (const id of Object.keys(crew || {})) if (M.busy(id)) out.add(id); } catch (_) {}
  return out;
}
/* the money check per worker: lib/admit.js money() with the dispatcher's numbers (the same object lanes.js gets) */
function moneyFn(budget) {
  if (!budget) return () => 'no money numbers this tick';
  const A = require('./admit');
  return (agentId, provider) => {
    const m = A.money({ metered: !(budget.unmetered || ['claude-cli']).includes(String(provider || '')), capOn: budget.capOn, capped: budget.capped,
      share: { usd: budget.perAgentUsd, spent: (budget.byAgent || {})[agentId] }, sprintBudgetLeft: budget.sprintBudgetLeft,
      spread: { on: budget.spread !== false && !!budget.spread, cap: budget.dailyUsd, spent24h: budget.spent, spentLastHour: budget.lastHourMetered, hoursLeft: budget.hoursLeft } });
    return m.verdict === 'run' ? null : m.why;
  };
}
function classDeniedFn(root) {
  let K = null; try { const R = require('./routing'); const L = R.loadPolicy(root); K = L ? R.knobs(L.policy) : null; } catch (_) {}
  return (cls, pair) => { if (!pair) return false; if (cls === 'code' && pair.provider === 'custom') return true; try { return K ? !require('./routing').routeAllowed(cls, pair, K) : false; } catch (_) { return false; } };
}

/* the splits already dispatched: company/state/delegate-allow-state.json used { splitId: at }, kept by markUsed() from what
   the station shows: a live child run of a worker the previous list named for that lead (o.liveKids, the snapshot), or a
   run row (runs.jsonl, the tail) whose itemId and delegatedBy are that split's item and lead */
const stateFile = root => path.join(root, 'company', 'state', 'delegate-allow-state.json');
function markUsed(root, o) {
  const prev = readJson(fileOf(root), null), st = readJson(stateFile(root), {}) || {}; st.used = st.used || {};
  let changed = false;
  const live = o.liveKids instanceof Map ? o.liveKids : new Map();
  let runs = []; try { runs = require('./bounded').tailLines(o.runsFile || path.join(root, '.starnet-data', 'workspaces', 'runs.jsonl'), 4000, { maxBytes: 4 << 20 }).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { runs = []; }
  for (const [lead, e] of Object.entries((prev && prev.leads) || {})) {
    if (!e || !e.split || st.used[e.split]) continue;
    const item = (e.items || [])[0];
    const started = (e.workers || []).some(w => live.has(w)) || runs.some(r => r && r.itemId && String(r.itemId) === String(item) && String(r.delegatedBy || '') === String(lead));
    if (started) { st.used[e.split] = new Date().toISOString(); changed = true; }
  }
  // keep the last 500
  const ks = Object.keys(st.used); if (ks.length > 500) { for (const k of ks.sort((a, b) => String(st.used[a]).localeCompare(String(st.used[b]))).slice(0, ks.length - 500)) delete st.used[k]; changed = true; }
  if (changed && !o.dry) { try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(st) + '\n'); } catch (_) {} }
  return new Set(Object.keys(st.used));
}
async function build(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  const D = require('./departments');
  const L = D.load({ root }), st = D.settings(L.doc, { root });
  const crew = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  // nothing live: an empty list, without reading anything else
  if (!D.list(L.doc).some(d => D.delegationOf(d, st).effective === 'live')) return { doc: { v: 1, at: Number.isFinite(o.now) ? o.now : Date.now(), by: 'dispatcher', leads: {} }, notes: [] };
  const C = require('./consult');
  const candidates = C.splitCandidates({ root, crew });
  const oa = readJson(path.join(root, 'company', 'state', 'override-allow.json'), null);
  const fresh = oa && Number(oa.at) > 0 && Date.now() - Number(oa.at) <= MAX_AGE_MS;
  const used = markUsed(root, o);
  return compute({ candidates, doc: L.doc, st, crew, jobs: o.jobs || [], busy: busySeats(root, crew, o.jobs || [], o.liveKids), open: fresh ? (oa.agents || {}) : {},
    money: moneyFn(o.budget), classDenied: classDeniedFn(root), used, now: o.now });
}

async function write(o) {
  o = o || {};
  const file = fileOf(o.root);
  const put = doc => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const txt = JSON.stringify(doc, null, 1) + '\n', tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file);
    try { require('../provenance.js').wrote(file, txt, WRITER); } catch (_) {}
  };
  try {
    const b = await build(o);
    if (!o.dry) put(b.doc);
    const leads = Object.keys(b.doc.leads);
    if (typeof o.log === 'function' && leads.length) {
      // one line per change of what is listed, not per tick
      const key = leads.map(l => l + ':' + b.doc.leads[l].items.join(',') + ':' + b.doc.leads[l].workers.join(',')).join(';');
      const sf = path.join(path.resolve(o.root || co.ROOT), 'company', 'state', 'delegate-allow-state.json');
      const prev = readJson(sf, {}) || {};
      if (prev.key !== key && !o.dry) { o.log('DELEGATE ALLOWLIST: ' + leads.map(l => l + ' may team.dispatch ' + b.doc.leads[l].workers.join(', ') + ' for ' + b.doc.leads[l].items[0] + ' (at most ' + b.doc.leads[l].maxWorkers + ', ' + b.doc.leads[l].workerTimeoutMin + ' min each)').join('; ')); try { fs.writeFileSync(sf, JSON.stringify({ key, at: Date.now() }) + '\n'); } catch (_) {} }
    }
    return { ok: true, file, leads: leads.length, notes: b.notes };
  } catch (e) {
    // fail closed: an empty list; if even that cannot be written the station refuses the stale copy within 30 minutes
    if (!o.dry) { try { put({ v: 1, at: Date.now(), by: 'dispatcher', leads: {} }); } catch (_) {} }
    if (typeof o.log === 'function') o.log('DELEGATE ALLOWLIST ERROR: ' + String((e && e.message) || e).slice(0, 200) + ' (nobody delegates this tick)');
    return { ok: false, file, error: String((e && e.message) || e) };
  }
}

/* nobody listed, now (a halted company: a lead run already in flight starts no new worker under a list from before the
   halt; the station refuses team.dispatch for every routine run). Never throws. */
function writeEmpty(o) {
  o = o || {}; const file = fileOf(o.root);
  try {
    const cur = readJson(file, null);
    if (cur && cur.v === 1 && cur.leads && !Object.keys(cur.leads).length && Date.now() - Number(cur.at) < 10 * 60e3) return { ok: true, file, leads: 0, unchanged: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const txt = JSON.stringify({ v: 1, at: Date.now(), by: 'dispatcher', leads: {}, halted: true }, null, 1) + '\n', tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file);
    try { require('../provenance.js').wrote(file, txt, WRITER); } catch (_) {}
    if (cur && cur.leads && Object.keys(cur.leads).length && typeof o.log === 'function') o.log('DELEGATE ALLOWLIST: emptied (halted): nobody may team.dispatch');
    return { ok: true, file, leads: 0 };
  } catch (e) { return { ok: false, file, error: String((e && e.message) || e) }; }
}

/* the auto-withdraw: model-rank.js fanoutEvaluation said withdraw for a department (its cost per accepted item was not
   lower than doing the items in one go): departments.js delegation <id> withdraw --by dispatcher --auto, once per
   evaluation hash (kept in company/state/delegate-allow-state.json), with one plain line to the owner */
function withdrawStep(o) {
  o = o || {}; const root = path.resolve(o.root || co.ROOT); const log = typeof o.log === 'function' ? o.log : () => {};
  const ev = readJson(path.join(root, 'company', 'work', 'models', 'routing-evaluation.json'), null);
  const rows = (ev && ev.fanout && ev.fanout.departments) || [];
  if (!rows.length) return { withdrawn: [] };
  const D = require('./departments'); const L = D.load({ root }), st = D.settings(L.doc, { root });
  const sf = path.join(root, 'company', 'state', 'delegate-allow-state.json'); const state = readJson(sf, {}) || {}; state.withdrawn = state.withdrawn || {};
  const out = [];
  for (const r of rows) {
    if (r.verdict !== 'withdraw' || !r.hash) continue;
    const d = D.list(L.doc).find(x => String(x.id) === String(r.dept)); if (!d) continue;
    const g = D.delegationOf(d, st); if (g.mode === 'off' || g.withdrawn) continue;
    if (state.withdrawn[r.dept] === r.hash) continue;
    const why = String((r.reasons || []).join('; ') || 'splitting did not lower the cost per finished job').slice(0, 280);
    if (o.dry) { log('WOULD withdraw splitting for ' + r.dept + ': ' + why); continue; }
    state.withdrawn[r.dept] = r.hash;
    let res; try { res = require('../departments.js').run(['delegation', String(r.dept), 'withdraw', '--by', 'dispatcher', '--auto', '--why', why, '--hash', String(r.hash)]); } catch (e) { res = { code: 1, out: { error: e.message } }; }
    if (res.code !== 0) { log('DELEGATION WITHDRAW ERROR (' + r.dept + '): ' + ((res.out && res.out.error) || 'failed')); continue; }
    out.push(r.dept);
    log('DELEGATION WITHDRAWN ' + r.dept + ': ' + why + ' (evaluation ' + String(r.hash).slice(0, 19) + '; only the owner resumes)');
    try { require('./owner-notice').send({ kind: 'fyi', from: 'the dispatcher', text: withdrawnWords(d.name || r.dept), technical: 'fanoutEvaluation ' + r.dept + ': ' + why, key: 'fanout-withdraw:' + r.dept + ':' + r.hash }); } catch (_) {}
  }
  if (!o.dry) try { fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, JSON.stringify(state) + '\n'); } catch (_) {}
  return { withdrawn: out };
}
const withdrawnWords = dept => 'The crew stopped splitting ' + String(dept).replace(/\s+department$/i, '') + '\'s bigger jobs between several people: doing them in one go was cheaper.';

/* the dispatcher's one line (dispatch.js): the auto-withdraw first, then the list. Fail-safe. */
async function step(o) {
  o = o || {};
  try { withdrawStep(o); } catch (e) { if (o.log) o.log('DELEGATION WITHDRAW ERROR: ' + String(e.message).slice(0, 200)); }
  return write(o);
}

module.exports = { compute, build, write, writeEmpty, markUsed, withdrawStep, step, busySeats, moneyFn, pairOf, classOf, withdrawnWords, MAX_AGE_MS, REL, WRITER };

// node company/tools/lib/delegate-allow.js [write|show]
if (require.main === module) {
  const cmd = process.argv[2] || 'show';
  (async () => {
    if (cmd === 'show') { const b = await build({}); console.log(JSON.stringify(Object.assign({}, b.doc, { notes: b.notes }), null, 1)); return; }
    if (cmd !== 'write') { console.error('usage: node company/tools/lib/delegate-allow.js [write|show]'); process.exit(2); }
    const r = await write({ log: l => console.error(l) });
    console.log('delegate allowlist: ' + (r.error ? 'nobody listed (' + r.error + ')' : r.leads + ' lead(s) listed') + ' -> ' + REL);
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error(e.message); process.exit(1); });
}
