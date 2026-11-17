'use strict';
/* lib/admit.js — the one gate every start of work passes through (docs/BUDGET.md).
 *
 * PHASE 1 (now): a COUNTER, not a judge, with one exception (a routine on a provider still blocked for it after a
 * refusal is held: decision 'hold'). Otherwise admit() always answers allow, and records every call — {door, kind, seat,
 * decision, reason} — in company/state/admit-log.jsonl. It changes no budget behaviour: each door still applies the rules
 * it applied before (the daily cap, the per-agent share, the Sprint spread, the pacer, halts, guardrails), and those rules
 * now live here in ONE copy (money() below), so no door keeps its own. Phase 2 makes admit() decide, behind this same
 * function, by flipping PHASE; nothing at the doors changes then.
 *
 *   const A = require('./lib/admit');
 *   const t = A.admit({ door, kind, seat, amountUsd?, priority?, jobId?, why? })  -> { decision: 'allow', reason, id, door, kind, seat }
 *   A.started(t, { status, runId? })      after the station answered: was the run started (HTTP 200)?
 *   A.rows({ sinceMs })                   the log since then (bounded read from the end)
 *   A.counts({ sinceMs })                 { door: { decision: n } }
 *   A.attribute(runs, rows)               each station run -> the door that started it (coverage; budget.js doors)
 *   A.money(o)                            the existing money rules, unchanged: { verdict, why }  (dispatch.js and lanes.js)
 *
 * Doors (DOORS): dispatch (the dispatcher's wakes and, with runtime.scheduler=dispatcher, its scheduled loops), lane
 * (Sprint lanes), hire (interview turns), chat (the owner's console chat), meeting (a turn, hand check or leader call in the
 * owner's meeting, console/meeting.js), health (a console health check run), console
 * (the owner's Run now / run from the console), act (an external-gate spend act), watchdog (the station's one routine),
 * halt (a soft halt's shutdown routine), onboard (the kickoff run), pacer (a re-fire after a refusal), schedule (a run the
 * station's own schedule started: recorded by attribution, never through a door — it is the bypass the dispatcher-owned
 * schedule removes).
 * Kinds: run (starts a model run), act (an outbound act, e.g. a spend), watchdog (the liveness check: starts nothing),
 * meeting-turn (a turn of the owner's meeting, console/meeting.js: a zero-token permission and routing check, no budget:
 * refused unless the owner opened the meeting (req.owner true), held under a hard halt or a refusal block on the provider).
 * Owner: the finance function.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const PHASE = 1;
const DOORS = ['dispatch', 'lane', 'hire', 'chat', 'meeting', 'health', 'console', 'act', 'watchdog', 'halt', 'onboard', 'pacer', 'schedule'];
const KINDS = ['run', 'act', 'watchdog', 'meeting-turn'];
const PHASE1_REASON = 'phase 1 counts, it does not decide: allowed and recorded; the door\'s own rules (cap, share, spread, pacer, halt) decided as before';
const logFile = o => (o && o.file) || process.env.ADMIT_LOG || co.p('company', 'state', 'admit-log.jsonl');
const clip = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, n || 200);
let SEQ = 0;
const HEALTH_STREAM = /^(aicheck|health)/i;
const newId = () => 'adm-' + Date.now().toString(36) + '-' + process.pid.toString(36) + '-' + (SEQ++).toString(36);

function append(row, o) {
  if (o && o.file === null) return;   // a caller's selftest: nothing is written
  const f = logFile(o);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(row) + '\n'); } catch (_) { /* never breaks a door */ }
}

/* admit(req, opts) — phase 1: allow, logged. A bad door or kind is a programming error and throws (tests catch it). */
function admit(req, opts) {
  req = req || {}; opts = opts || {};
  const door = String(req.door || ''), kind = String(req.kind || 'run');
  if (!DOORS.includes(door)) throw new TypeError('admit: unknown door "' + door + '" (one of ' + DOORS.join(', ') + ')');
  if (!KINDS.includes(kind)) throw new TypeError('admit: unknown kind "' + kind + '" (one of ' + KINDS.join(', ') + ')');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const t = { decision: 'allow', reason: PHASE1_REASON, id: newId(), door, kind, seat: req.seat != null ? clip(req.seat, 80) : null };
  // the one rule that decides already in phase 1: a routine is never started on a provider that refused it and is still
  // blocked for it (the pacer's refusal block, lib/refusal.js). The door holds the start; models.js moves the seat.
  if (kind === 'run' && req.jobId && req.provider) {
    let b = null; try { b = require('./refusal').blockFor(String(req.jobId), String(req.provider), { now, root: opts.root }); } catch (_) {}
    if (b) Object.assign(t, { decision: 'hold', reason: 'refusal block: ' + req.provider + ' refused this routine at ' + new Date(b.at).toISOString() + ' and is blocked for it until ' + new Date(b.until).toISOString() + ' (it runs on the next model meanwhile)' });
    // models.js judged that nothing in this seat's chain can run (every entry closed, blocked or at the spend rail): a
    // start would only be stopped by the station partway ("budget") or fail at the provider. Hold it; models.js moves the
    // seat as soon as an entry opens. Read only while models-state.json is fresh (fail open on a stale or missing file).
    if (t.decision === 'allow' && req.seat && door === 'dispatch') {
      try {
        const f = path.join(opts.root || co.ROOT, 'company', 'state', 'models-state.json');
        const st = fs.statSync(f);
        if (now - st.mtimeMs < 10 * 60e3) {
          const ss = ((JSON.parse(fs.readFileSync(f, 'utf8')) || {}).seats || {})[String(req.seat)];
          if (ss && ss.nothingKey) Object.assign(t, { decision: 'hold', reason: 'no model can run: ' + String(ss.nothingKey).split('|').slice(0, 3).join('; ').slice(0, 220), noModel: true });
        }
      } catch (_) {}
    }
    if (t.decision === 'allow') {
      let c = null; try { c = require('./refusal').closureFor(String(req.provider), { now, root: opts.root }); } catch (_) {}
      if (c) Object.assign(t, { decision: 'hold', reason: 'quota closed: ' + req.provider + ' is closed to routines until ' + new Date(Number(c.until)).toISOString() + ' (' + String(c.why || 'usage limit') + ')', quota: true });
    }
  }
  if (kind === 'meeting-turn') {
    if (req.owner !== true) Object.assign(t, { decision: 'refuse', reason: 'a meeting turn starts only in a meeting the owner opened: no routine or agent starts one' });
    else if (co.halted() === 'hard') Object.assign(t, { decision: 'hold', reason: 'the company is under a hard halt' });
    else if (req.provider && Array.isArray(req.jobIds) && req.jobIds.length) {
      let b = null; try { b = require('./refusal').blockedForSeat(req.jobIds.map(String), { now, root: opts.root })[String(req.provider)] || null; } catch (_) {}
      if (b) Object.assign(t, { decision: 'hold', reason: 'refusal block: ' + req.provider + ' is blocked for this seat until ' + new Date(b.until).toISOString() });
    }
    if (t.decision === 'allow') t.reason = 'meeting turn: the owner\'s meeting, no hold; counted, not priced';
  }
  const row = { ts: new Date(now).toISOString(), at: now, id: t.id, phase: PHASE, door, kind, seat: t.seat, decision: t.decision, reason: t.reason };
  if (req.meetingId) row.meetingId = clip(req.meetingId, 40);
  if (req.provider) row.provider = clip(req.provider, 40);
  if (req.amountUsd != null && Number.isFinite(Number(req.amountUsd))) row.amountUsd = Number(req.amountUsd);
  if (req.priority != null) row.priority = clip(req.priority, 40);
  if (req.jobId) row.jobId = clip(req.jobId, 80);
  if (req.why) row.why = clip(req.why, 200);
  if (opts.dry) return Object.assign(t, { dry: true });   // a dry run decides the same and writes nothing
  append(row, opts);
  return t;
}
/* started(ticket, {status, runId}) — the station's answer to the start this ticket admitted */
function started(t, r, opts) {
  if (!t || !t.id || t.dry) return;
  r = r || {};
  const row = { ts: new Date().toISOString(), at: Date.now(), ref: t.id, outcome: Number(r.status) === 200 ? 'started' : 'refused', status: Number(r.status) || 0 };
  if (r.runId) row.runId = clip(r.runId, 80);
  append(row, opts);
}
function rows(o) {
  o = o || {};
  const since = Number.isFinite(o.sinceMs) ? o.sinceMs : Date.now() - 24 * 3600e3;
  try { return require('./bounded').jsonlWindow(logFile(o), { sinceMs: since, tsOf: r => Number(r.at) || Date.parse(r.ts) || 0 }).rows.filter(r => (Number(r.at) || 0) >= since); } catch (_) { return []; }
}
function counts(o) {
  const out = {};
  for (const r of rows(o)) { if (!r.door) continue; const d = out[r.door] = out[r.door] || {}; d[r.decision] = (d[r.decision] || 0) + 1; }
  return out;
}

/* attribute(runs, rows, {windowMs}) -> [{ runId, agentId, startedAt, door, via: 'admit'|'inferred'|null, admitId }]
 * A run is the admitted start it follows: same runId when the door got it, else the same seat (and routine, when both
 * name one) admitted at most windowMs (default 15 min) before it started (or 10 s after: clocks), each start used once.
 * A child run (parentRunId) carries its parent's door. What no admit row covers is inferred: a routine run is the
 * station's own schedule (door 'schedule'), a health-check stream is 'health'; anything else has no door. */
function attribute(runs, list, o) {
  o = o || {};
  const win = Number(o.windowMs) > 0 ? Number(o.windowMs) : 15 * 60e3;
  const admits = [], outcome = new Map();
  for (const r of list || []) { if (r && r.ref) outcome.set(r.ref, r); else if (r && r.door && r.decision) admits.push(r); }
  const usable = admits.filter(a => a.kind !== 'act' && (!outcome.has(a.id) || outcome.get(a.id).outcome === 'started')).sort((a, b) => a.at - b.at);
  const used = new Set(), byRun = new Map(), out = [];
  const byRunId = new Map(); for (const a of usable) { const oc = outcome.get(a.id); if (oc && oc.runId) byRunId.set(oc.runId, a); }
  const sorted = (runs || []).filter(r => r && r.runId).slice().sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
  for (const r of sorted) {
    const at = Number(r.startedAt) || Number(r.ts) || 0;
    let hit = null;
    if (r.parentRunId && byRun.has(r.parentRunId)) { const p = byRun.get(r.parentRunId); out.push(Object.assign({ runId: r.runId, agentId: r.agentId, startedAt: at, child: true }, { door: p.door, via: p.via, admitId: p.admitId })); byRun.set(r.runId, p); continue; }
    if (byRunId.has(r.runId) && !used.has(byRunId.get(r.runId).id)) hit = byRunId.get(r.runId);
    if (!hit) {
      let best = null;
      for (const a of usable) {
        if (used.has(a.id)) continue;
        if ((a.door === 'health') !== HEALTH_STREAM.test(String(r.streamId || ''))) continue;   // a health-check stream is the health door's, and only its
        if (a.seat ? a.seat !== r.agentId : !(a.jobId && a.jobId === r.cronJobId)) continue;   // a console Run now knows only the routine
        if (a.jobId && r.cronJobId && a.jobId !== r.cronJobId) continue;
        const d = at - a.at; if (d < -10e3 || d > win) continue;   // admitted before the start (10 s of clock slack)
        if (!best || Math.abs(d) < Math.abs(at - best.at)) best = a;
      }
      hit = best;
    }
    let e;
    if (hit) { used.add(hit.id); e = { door: hit.door, via: 'admit', admitId: hit.id }; }
    else if (HEALTH_STREAM.test(String(r.streamId || ''))) e = { door: 'health', via: 'inferred', admitId: null };
    else if (r.cronJobId || /^cron-/.test(String(r.streamId || '')) || r.source === 'cron' || r.wireSource === 'routine') e = { door: 'schedule', via: 'inferred', admitId: null };
    else e = { door: null, via: null, admitId: null };
    byRun.set(r.runId, e);
    out.push(Object.assign({ runId: r.runId, agentId: r.agentId || null, startedAt: at, cronJobId: r.cronJobId || null, usd: Number(r.usd) || 0 }, e));
  }
  return out;
}

/* money(o) — the money rules the dispatcher and the lanes applied before admit() existed, in ONE copy, unchanged.
 * o: { metered, ownerWake, capOn, capped, share: { usd, spent } (the per-agent share and this seat's 24 h metered spend;
 *      or perAgentOver), sprintBudgetLeft (lanes only), spread: { on, cap, spent24h, spentLastHour, hoursLeft, blocking } }
 * -> { verdict: 'run' | 'held' (daily cap) | 'perAgentHeld' | 'sprintSpent' | 'spread' | 'wouldHold' (spendCap off), why }
 * The order is the old one: not metered or an owner wake runs; the daily cap; the per-agent share; the Sprint budget; the
 * Sprint spread (lib/sprint.js spreadHold; a seat others wait on is never held by it when the caller passes `blocking`). */
function money(o) {
  o = o || {};
  if (!o.metered || o.ownerWake) return { verdict: 'run', why: null };
  if (o.capped) return o.capOn ? { verdict: 'held', why: 'the daily metered cap is reached' } : { verdict: 'wouldHold', why: 'the daily metered cap is reached (spendCap guardrail off)' };
  const over = o.perAgentOver != null ? !!o.perAgentOver : !!(o.share && Number(o.share.usd) > 0 && (Number(o.share.spent) || 0) >= Number(o.share.usd));
  if (over) return o.capOn ? { verdict: 'perAgentHeld', why: 'the seat is at its per-agent share' } : { verdict: 'wouldHold', why: 'the seat is at its per-agent share (spendCap guardrail off)' };
  if (o.sprintBudgetLeft != null && o.sprintBudgetLeft <= 0) return { verdict: 'sprintSpent', why: 'the Sprint budget is spent' };
  const s = o.spread;
  if (s && s.on && o.capOn && Number(s.cap) > 0) {
    const why = require('./sprint').spreadHold({ cap: s.cap, spent24h: s.spent24h, spentLastHour: s.spentLastHour, hoursLeft: s.hoursLeft, blocking: s.blocking });
    if (why) return { verdict: 'spread', why };
  }
  return { verdict: 'run', why: null };
}

module.exports = { PHASE, DOORS, KINDS, PHASE1_REASON, admit, started, rows, counts, attribute, money, logFile };
