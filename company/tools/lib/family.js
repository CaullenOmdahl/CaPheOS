'use strict';
/* lib/family.js — a lead run and the child runs it delegated are ONE family (docs/BUDGET.md, "Delegated runs").
 *
 * The station's team.dispatch (and spawn/resume) starts a child run on the WORKER's own agentId and model, with
 * parentRunId = the lead's run (and delegatedBy = the lead's agentId when orchestration set it). The lead blocks while its
 * workers run. So the work, and the money, are the lead's: a child's spend belongs to the lead's family, never to the
 * worker's own seat budget, and a worker busy on a child run is busy (it is not woken on top of it).
 *
 *   const F = require('./lib/family');
 *   F.leads(runs)               Map runId -> { seat, agentId, parentRunId, rootRunId, child }: the seat whose family each run is in
 *                               (a top-level run: its own agentId; a child: the lead at the top of its chain, else its
 *                               delegatedBy, else null = UNKNOWN)
 *   F.seatOf(map, runId, agentId) the seat a run's spend is booked to (a child whose lead is unknown: F.UNKNOWN)
 *   F.books(runs, { usdOf })    { total, bySeat, byFamily: { seat: { own, delegated, total, workers: {agentId: usd}, runs, children } } }
 *                               bySeat and byFamily both add up to total, which is the sum of the rows' usd (exactly:
 *                               summed in nano-dollars)
 *   F.liveChildSeats(snapRuns)  Map agentId -> [runId]: seats with a child run in flight (GET /api/state/snapshot runs:
 *                               a row with parentRunId, or source "delegated" / "subagent", the station's names for them)
 * Pure: no file or socket. Owner: the finance function.
 */
const UNKNOWN = '(delegated: lead unknown)';
const MAX_DEPTH = 16;
const str = v => (v == null ? '' : String(v));
const nano = u => { const n = Number(u); return Number.isFinite(n) ? Math.round(n * 1e9) : 0; };
const usd = n => n / 1e9;

function leads(runs) {
  const byId = new Map();
  // runs.jsonl carries side rows under a run's id ({runId, kind: 'dispatch-delivery', ts}): the run row (it names an agent
  // or a parent) wins, whatever order they come in
  const isRun = r => !!(str(r.agentId) || str(r.parentRunId));
  for (const r of runs || []) if (r && r.runId) { const id = str(r.runId), had = byId.get(id); if (!had || (!isRun(had) && isRun(r))) byId.set(id, r); }
  const out = new Map();
  for (const [id, r] of byId) {
    const pid = str(r.parentRunId);
    if (!pid) { out.set(id, { seat: str(r.agentId) || null, agentId: str(r.agentId) || null, parentRunId: null, rootRunId: id, child: false }); continue; }
    // walk up to the topmost run this file knows
    let top = r, d = 0;
    while (str(top.parentRunId) && byId.has(str(top.parentRunId)) && d++ < MAX_DEPTH) top = byId.get(str(top.parentRunId));
    const seat = !str(top.parentRunId) ? (str(top.agentId) || null) : (str(top.delegatedBy) || null);   // the lead's row is not here (still running): who delegated
    out.set(id, { seat, agentId: str(r.agentId) || null, parentRunId: pid, rootRunId: !str(top.parentRunId) ? str(top.runId) : str(top.parentRunId), child: true });
  }
  return out;
}
function seatOf(map, runId, agentId) {
  const f = map && map.get(str(runId));
  if (!f || !f.child) return str(agentId) || '(no agent)';
  return f.seat || UNKNOWN;
}
function books(runs, o) {
  o = o || {};
  const usdOf = typeof o.usdOf === 'function' ? o.usdOf : (r => r.usd);
  const map = leads(runs);
  let total = 0; const bySeat = {}, fam = {};
  for (const r of runs || []) {
    if (!r || !r.runId) continue;
    const n = nano(usdOf(r)); total += n;
    const seat = seatOf(map, r.runId, r.agentId);
    bySeat[seat] = (bySeat[seat] || 0) + n;
    const f = fam[seat] = fam[seat] || { own: 0, delegated: 0, total: 0, workers: {}, runs: 0, children: 0 };
    const m = map.get(str(r.runId)) || {};
    const isRun = m.agentId ? str(r.agentId) === m.agentId : true;   // a side row under the run's id adds its money, not a run
    if (m.child) { f.delegated += n; if (isRun) f.children++; const w = m.agentId || '(no agent)'; f.workers[w] = (f.workers[w] || 0) + n; } else { f.own += n; if (isRun) f.runs++; }
    f.total += n;
  }
  const byFamily = {};
  for (const [k, f] of Object.entries(fam)) byFamily[k] = { own: usd(f.own), delegated: usd(f.delegated), total: usd(f.total), runs: f.runs, children: f.children, workers: Object.fromEntries(Object.entries(f.workers).map(([w, n]) => [w, usd(n)])) };
  return { total: usd(total), bySeat: Object.fromEntries(Object.entries(bySeat).map(([k, n]) => [k, usd(n)])), byFamily };
}
const CHILD_SOURCES = new Set(['delegated', 'subagent']);
function isLiveChild(r) { return !!(r && r.runId && r.agentId && (str(r.parentRunId) || r.delegated === true || CHILD_SOURCES.has(str(r.source)))); }
function liveChildSeats(snapRuns) {
  const out = new Map();
  for (const r of Array.isArray(snapRuns) ? snapRuns : []) if (isLiveChild(r)) { const a = str(r.agentId); out.set(a, (out.get(a) || []).concat([str(r.runId)])); }
  return out;
}

module.exports = { UNKNOWN, leads, seatOf, books, liveChildSeats, isLiveChild };
