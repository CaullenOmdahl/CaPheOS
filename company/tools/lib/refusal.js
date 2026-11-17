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
  return list.filter(b => b && b.routineId && b.provider && Number(b.until) > now);
}
// the block on this routine for this provider, or null
function blockFor(jobId, provider, o) { return activeBlocks(o).find(b => b.routineId === jobId && b.provider === provider) || null; }
// providers blocked for a seat: any of its routines refused on that provider and still in its window
function blockedForSeat(jobIds, o) {
  const ids = new Set(jobIds || []); const out = {};
  for (const b of activeBlocks(o)) if (ids.has(b.routineId) && (!out[b.provider] || out[b.provider].until < b.until)) out[b.provider] = b;
  return out;
}

module.exports = { isRefusal, nextEntry, candidates, record, plainLine, keyOf, pname, activeBlocks, blockFor, blockedForSeat };
