'use strict';
/* lib/refusal.js — a run the model refused is retried once on the seat's next model, at every door (owner ruling: "when
 * something is rejected by the first model, it should be detected and then fall over to DeepSeek or the second model").
 *
 *   isRefusal(x)                      a run record, an agent.run.end payload or a turn result: the model declined it
 *   nextEntry(seat, from, tried, o)   the entry to retry on: the seat's chain (model-policy.json seats.<id>.chain) after
 *                                     the refused one, preferring another provider, then the routing table's models and
 *                                     candidateDefault; null when every entry has been tried (then: report and stop)
 *   record(o)                         the failover on the seat: a row in company/state/model-moves.jsonl (direction
 *                                     "refusal", door, run, from, to) and models-state.json seats.<id>.lastRefusal, which
 *                                     Settings › Models shows as the seat's "why"
 *   plainLine(from, to)               "Claude declined this; DeepSeek answered instead."
 *
 * Doors: the pacer (routine and dispatcher runs), console/chat.js (owner chat), lanes.js (Sprint lanes), hire.js
 * (interviews). One retry per run; the 2 h / 24 h provider block for a routine stays the pacer's (pacing-policy.json).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const NAMES = { 'claude-cli': 'Claude', anthropic: 'Claude', custom: 'MiniMax', minimax: 'MiniMax', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };
const pname = p => NAMES[p] || p || 'the model';
const keyOf = e => e ? String(e.provider) + '/' + String(e.model) : '';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

function isRefusal(x) {
  if (!x || typeof x !== 'object') return false;
  const words = [x.outcome, x.reason, x.failureCode, x.code, x.status].map(v => String(v || '').toLowerCase());
  if (words.some(w => w === 'refused' || w === 'content_policy_blocked' || w === 'policy_refusal')) return true;
  return /content[_ ]policy|safety (filter|system) (declined|refused)|declined (by|for) (policy|safety)/i.test(String(x.error || x.message || ''));
}

// the entries to try, in order: the seat's chain, then the routing table's models, then candidateDefault (allowed ones only)
function candidates(seat, o) {
  const root = (o && o.root) || co.ROOT;
  const pol = (o && o.policy) || readJson(path.join(root, 'company', 'model-policy.json'), {}) || {};
  const allowed = e => { const fam = (pol.allowed || {})[e.provider]; return !fam || !Array.isArray(fam.models) || fam.models.includes(e.model); };
  const out = []; const add = e => { if (e && e.provider && e.model && allowed(e) && !out.some(x => keyOf(x) === keyOf(e))) out.push({ provider: String(e.provider), model: String(e.model), effort: e.effort || undefined }); };
  const s = seat && (pol.seats || {})[seat];
  for (const e of (s && Array.isArray(s.chain) ? s.chain : [])) add(typeof e === 'string' ? (([p, m]) => ({ provider: p, model: m }))(e.split('/')) : e);
  for (const e of Object.values((pol.routing && pol.routing.models) || {})) add(e);
  add(pol.candidateDefault);
  return out;
}
function nextEntry(seat, from, tried, o) {
  const list = candidates(seat, o);
  const done = new Set([keyOf(from)].concat((tried || []).map(t => typeof t === 'string' ? t : keyOf(t))));
  const fromIdx = list.findIndex(e => keyOf(e) === keyOf(from));
  const after = fromIdx >= 0 ? list.slice(fromIdx + 1).concat(list.slice(0, fromIdx)) : list;
  const open = after.filter(e => !done.has(keyOf(e)));
  return open.find(e => e.provider !== (from && from.provider)) || open[0] || null;   // another provider first: a filter is a provider's
}

function plainLine(from, to) { return pname(from && from.provider) + ' declined this; ' + (to ? pname(to.provider) + ' answered instead.' : 'no other model in the chain would take it.'); }

function record(o) {
  const root = o.root || co.ROOT;
  const at = new Date(o.at || Date.now()).toISOString();
  const row = { at, seat: o.seat, name: o.seat ? co.nameOf(o.seat) : null, from: keyOf(o.from), to: o.to ? keyOf(o.to) : null, direction: 'refusal', door: o.door,
    runId: o.runId || null, retryRunId: o.retryRunId || null, why: o.to ? plainLine(o.from, o.to) + ' (' + o.door + ', one retry)' : plainLine(o.from, null) + ' (' + o.door + '; every entry tried, stopped)', applied: !!o.to };
  try { const f = path.join(root, 'company', 'state', 'model-moves.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(row) + '\n'); } catch (_) {}
  try {
    const f = path.join(root, 'company', 'state', 'models-state.json'); const st = readJson(f, null) || { v: 1, seats: {} };
    st.seats = st.seats || {}; const ss = st.seats[o.seat] = st.seats[o.seat] || { okSince: {} };
    ss.lastRefusal = { at, door: o.door, from: row.from, to: row.to, why: row.why };
    const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(st, null, 1) + '\n'); fs.renameSync(t, f);
  } catch (_) {}
  return row;
}

/* The ONE record of a refusal block: the pacer's blocks (company/state/pacer-state.json, written when it reads a refused
 * run: provider P is blocked for routine R until T). models.js treats P as "cannot run" for R's seat, the dispatcher
 * and admit() never start R on P, and the pacer routes R off P: one authority, read the same way everywhere. */
function activeBlocks(o) {
  const root = (o && o.root) || co.ROOT; const now = (o && Number.isFinite(o.now)) ? o.now : Date.now();
  const list = (o && Array.isArray(o.blocks)) ? o.blocks : ((readJson(path.join(root, 'company', 'state', 'pacer-state.json'), {}) || {}).blocks || []);
  return list.filter(b => b && b.routineId && b.provider && !b.clearedAt && Number(b.until) > now && !b.trial);
}
/* a refusal of a one-run trial model (the router's override, never the seat's own chain) blocks only that model for that
   routine, in the router: the seat keeps its provider and runs on its own chain. -> [{provider, model, until}] */
function trialRefusals(jobId, o) {
  const root = (o && o.root) || co.ROOT; const now = (o && Number.isFinite(o.now)) ? o.now : Date.now();
  const list = (o && Array.isArray(o.blocks)) ? o.blocks : ((readJson(path.join(root, 'company', 'state', 'pacer-state.json'), {}) || {}).blocks || []);
  return list.filter(b => b && b.trial && b.routineId === jobId && !b.clearedAt && Number(b.until) > now).map(b => ({ provider: b.provider, model: b.model, until: b.until }));
}
// the block on this routine for this provider, or null
function blockFor(jobId, provider, o, model) { return activeBlocks(o).find(b => b.routineId === jobId && b.provider === provider && (!b.modelOnly || !model || b.model === model)) || null; }
// does this block stop this chain entry? a model-only block (a content filter) stops only the model that refused
const blocksEntry = (b, entry) => !!b && (!b.modelOnly || !entry || !entry.model || b.model === entry.model);
// providers blocked for a seat: any of its routines refused on that provider and still in its window
function blockedForSeat(jobIds, o) {
  const ids = new Set(jobIds || []); const out = {};
  for (const b of activeBlocks(o)) if (ids.has(b.routineId) && (!out[b.provider] || out[b.provider].until < b.until)) out[b.provider] = b;
  return out;
}

// A provider the pacer has closed to routines because a run hit its usage limit (pacer-state.json closures: claude →
// claude-cli, minimax → custom). While closed, starting a run on it only burns a start and fails quota_exhausted
// (2026-11-18 02:24-02:53: 12 such starts, and a false "failing" flag on the seat). admit() holds it; models.js moves the seat.
const CLOSURE_KEY = { 'claude-cli': 'claude', custom: 'minimax' };
function closureFor(provider, o) {
  const k = CLOSURE_KEY[String(provider || '')]; if (!k) return null;
  const root = (o && o.root) || co.ROOT; const now = (o && Number.isFinite(o.now)) ? o.now : Date.now();
  const c = ((o && o.closures) || (readJson(path.join(root, 'company', 'state', 'pacer-state.json'), {}) || {}).closures || {})[k];
  return c && Number(c.until) > now ? c : null;
}

// how many runs of these routines were refused in the last 24 h (the pacer's refusal log)
function refusalCount(jobIds, o) {
  const root = (o && o.root) || co.ROOT; const now = (o && Number.isFinite(o.now)) ? o.now : Date.now();
  const ids = new Set(jobIds || []); const st = readJson(path.join(root, 'company', 'state', 'pacer-state.json'), {}) || {};
  const seen = new Set(); for (const x of (st.refusalLog || []).concat(st.blocks || [])) if (x && ids.has(x.routineId) && now - Number(x.at) < 24 * 3600e3) seen.add(x.runId || x.at);
  return seen.size;
}
// the one time format (console/ui/js/plain.js whenText, server side): "today 14:22", "tomorrow 14:22", "Nov 17 03:25"
function whenText(t, tz, now) {
  const ms = typeof t === 'number' ? t : Date.parse(t); if (!ms || isNaN(ms)) return '';
  const parts = x => { const o = {}; for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz || co.TZ || undefined, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(x)) o[p.type] = p.value;
    return { key: o.year + '-' + o.month + '-' + o.day, year: o.year, month: o.month, day: o.day, hm: (o.hour === '24' ? '00' : o.hour) + ':' + o.minute }; };
  const n = now == null ? Date.now() : now; const a = parts(ms), today = parts(n), tomorrow = parts(n + 86400e3);
  if (a.key === today.key) return 'today ' + a.hm;
  if (a.key === tomorrow.key) return 'tomorrow ' + a.hm;
  return a.month + ' ' + a.day + (a.year !== today.year ? ' ' + a.year : '') + ' ' + a.hm;
}
// the owner's plain line for a seat's block: "Claude paused for the Founder until tomorrow 23:22, because it declined 3 runs in the last 24 hours"
function blockLine(seatName, b, count, now) {
  return pname(b.provider) + ' paused for ' + (seatName || 'this seat') + ' until ' + whenText(Number(b.until), null, now) + ', because it declined ' + (count > 1 ? count + ' runs' : 'a run') + ' in the last 24 hours';
}

module.exports = { blocksEntry, trialRefusals, refusalCount, whenText, blockLine, isRefusal, nextEntry, candidates, record, plainLine, keyOf, pname, activeBlocks, blockFor, blockedForSeat, closureFor };
