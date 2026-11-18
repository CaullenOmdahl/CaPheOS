#!/usr/bin/env node
/* halt.js — stop the company, softly or hard, and start it again.
 *
 *   node company/tools/halt.js status [--json] [--station]       # company/state/halt.json (+ GET /api/halt with --station)
 *   node company/tools/halt.js soft --by <name> [--why "..."] [--deadline-min N] [--escalate]
 *   node company/tools/halt.js hard --by <name> [--why "..."]
 *   node company/tools/halt.js resume --by <name>
 *   node company/tools/halt.js tick                              # the dispatcher runs this every tick
 *   node company/tools/halt.js selftest                          # offline, fake station
 *
 * HARD is the station E-STOP: POST /api/halt aborts every in-flight run at once (routines, loops, channel hubs, the
 * night shift) and stands the scheduler down durably. halt.json is written FIRST, so the dispatcher wakes nobody even
 * if the station cannot be reached; the reply is recorded as `station`.
 *
 * SOFT stops the company the way a person would close the shop: nothing new starts, running work finishes, and each
 * seat that needs to wind something down does it (a trading seat flattens and cancels resting orders). Steps:
 *   1. halt.json {mode:'soft', by, at, why, deadline, escalate} — the dispatcher and every tool that checks
 *      co.halted() start nothing from here on;
 *   2. the station scheduler is disarmed (POST /api/cron/arm {enabled:false}) after recording GET /api/cron `enabled`
 *      as `cronWasEnabled`, so resume puts it back exactly as it was. Disarming stops new fires only; it does not
 *      abort a routine that is already running;
 *   3. each seat in loops.json with a `shutdown` block ({routine, maxMinutes, procedure}) gets that routine fired once
 *      (POST /api/cron/run — a manual run, which works while the scheduler is disarmed). Nothing else is started.
 * `tick` then watches the station (GET /api/cron job `inFlight`, GET /api/state/snapshot `runs`). When no company run
 * is in flight and every shutdown routine has run, the soft halt is COMPLETE: mode stays 'soft', `settledAt` is set
 * and the owner is told. If the deadline passes first, the owner is told what is still running; only when the halt
 * was started with --escalate (halt.json `escalate: true`) does it go hard, and the owner is told that too. Never
 * silently. Runs from the owner's own station tab (source 'interactive') are listed but do not hold the settle.
 *
 * RESUME lifts a hard halt (POST /api/halt/resume {confirm:true}), re-arms the scheduler to `cronWasEnabled`, sets
 * mode 'running' and tells the owner.
 *
 * Continuity (core module, when enabled): soft lists open commitments by party/due in halt.json `commitments`; tick does
 * not settle while a breach-able commitment is unowned (modules/continuity/lib.js).
 *
 * Background services (company/tools/service.js): every write of halt.json hands the new state to service.js onHalt(),
 * the one call: soft stops the registered timers firing (a run in progress finishes) and asks long-running services to
 * finish, unless they declared --soft-halt keep; hard stops every registered unit now; resume starts what was running.
 *
 * Guardrail: co.guard('halt') is always ON; nothing here can be switched off.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const co = require('./lib/company');

const DEFAULT_DEADLINE_MIN = 60;
// Injectable seams (the selftest swaps them for a fake station and a captured owner channel).
const S = {
  haltFile: co.HALT_FILE,
  loopsFile: co.LOOPS_FILE,
  now: () => Date.now(),
  call: (method, p, body) => require('./station-crew.js').call(method, p, body, 20000),
  fire: fireRun,
  // urgent: the company stopped or started again (lib/owner-notice.js); the detail rides along collapsed, for the crew
  notify: (text, technical) => require('./lib/owner-notice').send({ kind: 'urgent', from: co.nameOf(co.ceo()), text, technical }),
  services: st => require('./service.js').onHalt(st),
};

// POST /api/cron/run {detach:true}: the run is admitted on a 200 and keeps going after the socket closes, so resolve on
// the first byte of a 200 or the full short body of a refusal (same contract as dispatch.js fireRun).
function fireRun(jobId) {
  return new Promise(resolve => {
    let token; try { token = co.stationToken(); } catch (e) { resolve({ status: 0, body: e.message }); return; }
    const u = new URL(co.STATION_URL + '/api/cron/run');
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'x-starnet-token': token, 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => { d += c; if (res.statusCode === 200 && d.length) { finish({ status: 200, body: d.slice(0, 200) }); req.destroy(); } });
      res.on('end', () => finish({ status: res.statusCode, body: d }));
      res.on('error', () => finish({ status: res.statusCode || 0, body: d }));
    });
    req.setTimeout(15000, () => finish({ status: 0, body: 'no response in 15s (the run may still be live)' }));
    req.on('error', e => finish({ status: 0, body: e.message }));
    req.write(JSON.stringify({ id: jobId, detach: true }));
    req.end();
  });
}

const j = r => { try { return JSON.parse(r.body); } catch (_) { return null; } };
const iso = ms => new Date(ms).toISOString();
function read() { return co.readJson(S.haltFile, { mode: 'running' }) || { mode: 'running' }; }
function write(st) {
  fs.mkdirSync(path.dirname(S.haltFile), { recursive: true });
  const tmp = S.haltFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n');
  fs.renameSync(tmp, S.haltFile);
  try { S.services(st); } catch (_) {}   // background services follow the halt (service.js onHalt; idempotent per halt)
  return st;
}
function seats() { return (co.readJson(S.loopsFile, {}) || {}).agents || {}; }
/* tell(text, technical) — one plain message to the owner: no commands, no raw errors (those go in `technical`) */
function tell(text, technical) { try { S.notify(text, technical || undefined); return true; } catch (e) { return 'owner channel failed: ' + e.message; } }
const RESUME_LINK = ' [Start it again from the console](console:#/halt) when you are ready.';
const reasonOf = why => (why ? ' Reason given: ' + String(why).replace(/\s+/g, ' ').trim().replace(/[.]$/, '') + '.' : '');
function matchJob(jobs, prefix) {
  const hits = jobs.filter(x => x && x.name && (x.name === prefix || x.name.startsWith(prefix)));
  return hits.length === 1 ? hits[0] : null;
}
async function cronList() {
  const r = await S.call('GET', '/api/cron');
  const b = r && r.status === 200 ? j(r) : null;
  if (!b || !Array.isArray(b.jobs)) throw new Error('GET /api/cron failed: HTTP ' + (r && r.status));
  return b;
}
async function arm(enabled) {
  const r = await S.call('POST', '/api/cron/arm', { enabled });
  const b = j(r);
  const v = require('./lib/station').cronResult(r, 'POST /api/cron/arm ' + enabled);   // a 200 can be a decline
  if (!v.ok || !b || !b.ok) throw new Error(v.ok ? 'POST /api/cron/arm ' + enabled + ' failed: HTTP ' + (r && r.status) + ' ' + String(r && r.body).slice(0, 160) : v.reason);
  return b;
}

/* Goal loops (StarNet standing objectives) are not stopped by disarming the scheduler. Pausing one aborts its running
 * pass on the station, so a soft halt pauses only loops that are between passes and waits for a running pass to end
 * before pausing that loop; resume restarts exactly the loops this halt paused. */
async function loopsList() {
  const r = await S.call('GET', '/api/loops');
  const b = j(r) || {};
  if (r.status !== 200) throw new Error('GET /api/loops HTTP ' + r.status);
  return Array.isArray(b) ? b : (b.loops || []);
}
const QUIET = ['paused', 'stopped', 'done', 'dormant'];
async function pauseQuietLoops(st) {
  st.loops = st.loops || { paused: [], waiting: [] };
  let rows; try { rows = await loopsList(); } catch (e) { st.loops.error = e.message; return; }
  for (const l of rows) {
    if (!l || !l.id || l.enabled === false || QUIET.includes(l.state)) { st.loops.waiting = st.loops.waiting.filter(x => x !== (l && l.id)); continue; }
    if (st.loops.paused.includes(l.id)) continue;
    if (l.state === 'running') { if (!st.loops.waiting.includes(l.id)) st.loops.waiting.push(l.id); continue; }
    const r = await S.call('POST', '/api/loops/control', { id: l.id, action: 'pause' });
    if (r.status === 200) { st.loops.paused.push(l.id); st.loops.waiting = st.loops.waiting.filter(x => x !== l.id); }
    else if (!st.loops.waiting.includes(l.id)) st.loops.waiting.push(l.id);   // 409 = review in progress: try next tick
  }
}

async function hard({ by, why, auto } = {}) {
  if (!by) throw new Error('--by <name> is required');
  const prev = read();
  const st = { mode: 'hard', by, at: iso(S.now()), why: why || null };
  // keep what resume needs from an earlier soft halt (the scheduler's prior arm state, the shutdown record)
  if (prev.mode === 'soft') { st.from = { mode: 'soft', by: prev.by, at: prev.at, why: prev.why }; st.shutdowns = prev.shutdowns; }
  if (typeof prev.cronWasEnabled === 'boolean' && prev.mode !== 'running') st.cronWasEnabled = prev.cronWasEnabled;
  if (auto) st.escalatedFromSoft = true;
  write(st);   // first: a halted company starts nothing even if the station does not answer
  if (typeof st.cronWasEnabled !== 'boolean') {
    try { st.cronWasEnabled = !!(await cronList()).enabled; } catch (e) { st.cronReadError = e.message; }
  }
  try {
    const r = await S.call('POST', '/api/halt', {});
    const b = j(r) || {};
    st.station = { ok: r.status === 200, status: r.status, halted: b.halted, cronAborted: b.cronAborted, loopAborted: b.loopAborted };
  } catch (e) { st.station = { ok: false, error: e.message }; }
  // Sprint lanes (company/tools/lanes.js): every live lane is cut off now (its run stopped, its path lock released, its
  // handoff told), even if the station did not answer the E-STOP
  try { const cut = await require('./lanes.js').cutOff({}); if (cut && cut.cut) st.lanesCut = cut.cut; } catch (e) { st.lanesError = String(e.message).slice(0, 160); }
  write(st);
  if (!auto) tell('The company is paused: ' + by + ' stopped all work at once.' + reasonOf(why)
    + (st.station.ok ? '' : ' Work that was already running may not have stopped yet, but nothing new will start.') + RESUME_LINK,
    'Hard halt by ' + by + ': the station E-STOP ' + (st.station.ok ? 'stopped every run' : 'did NOT answer (' + (st.station.error || 'HTTP ' + st.station.status) + '); the dispatcher still wakes nobody') + '. CLI: node company/tools/halt.js resume --by <name>.');
  return st;
}

/* Continuity (core module modules/continuity, when enabled): a soft halt lists the open commitments by party and due
 * time, and does not report settled while a breach-able commitment is unowned. Not enabled = null (no effect). */
function continuity() {
  try {
    const st = co.readJson(co.p('company', 'state', 'modules.json'), {}) || {};
    if (!(st.enabled || {}).continuity) return null;
    return require(co.p('modules', 'continuity', 'lib.js'));
  } catch (_) { return null; }
}
// the owner's meeting is live work (lib/meetings.js): a soft halt lets its turn in progress finish, then it is
// interrupted with its minutes written; a hard halt aborts the turn. Listed with the commitments.
function meetingWork() { try { return require('./lib/meetings').liveWork(); } catch (_) { return []; } }
function continuityView() {
  const c = continuity(); if (!c) return null;
  try { const o = c.open(); return { at: iso(S.now()), count: o.count, byParty: o.byParty, unowned: c.unowned().map(x => x.id) }; } catch (e) { return { error: e.message }; }
}

async function soft({ by, why, deadlineMin, escalate } = {}) {
  if (!by) throw new Error('--by <name> is required');
  const prev = read();
  if (prev.mode === 'hard') throw new Error('the company is hard-halted; resume first');
  if (prev.mode === 'soft') return Object.assign({ already: true }, prev);
  const now = S.now();
  const mins = Number(deadlineMin) > 0 ? Number(deadlineMin) : DEFAULT_DEADLINE_MIN;
  const st = { mode: 'soft', by, at: iso(now), why: why || null, deadline: iso(now + mins * 60000), escalate: !!escalate, shutdowns: [] };
  write(st);   // first: nothing new starts from this moment
  let jobs = [];
  try {
    const c = await cronList();
    st.cronWasEnabled = !!c.enabled;
    jobs = c.jobs;
    if (c.enabled) await arm(false);
    st.cronDisarmed = true;
  } catch (e) { st.cronError = e.message; }
  for (const [id, seat] of Object.entries(seats())) {
    const sd = seat && seat.shutdown;
    if (!sd || !sd.routine) continue;
    const row = { seat: id, routine: sd.routine, maxMinutes: Number(sd.maxMinutes) || null, procedure: sd.procedure || null };
    const job = matchJob(jobs, sd.routine);
    if (!job) { row.status = 'missing'; st.shutdowns.push(row); continue; }
    row.jobId = job.id; row.lastRunAtBefore = job.lastRunAt || null;
    const tk = require('./lib/admit').admit({ door: 'halt', kind: 'run', seat: id, jobId: job.id, why: 'soft halt: shutdown routine ' + sd.routine });   // the one gate, phase 1: recorded
    const r = await S.fire(job.id);
    require('./lib/admit').started(tk, r);
    row.firedAt = iso(S.now());
    row.status = r.status === 200 ? 'fired' : 'refused';
    if (r.status !== 200) row.error = 'HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160);
    st.shutdowns.push(row);
  }
  await pauseQuietLoops(st);
  const cv = continuityView();
  if (cv) st.commitments = cv;
  const lw = meetingWork(); if (lw.length) st.liveWork = lw;
  write(st);
  const cm = cv && cv.count ? ' Open commitments: ' + cv.count + (cv.unowned && cv.unowned.length ? ' (' + cv.unowned.length + ' unowned — reassign them before the halt can settle: node company/tools/continuity.js unowned)' : '') + '.' : '';
  const lm = lw.filter(x => x.kind === 'meeting');
  const mw = lm.length ? ' Your meeting' + (lm[0].title ? ' "' + lm[0].title + '"' : '') + ' is live work: ' + (lm[0].running ? 'the turn in progress finishes, then it is interrupted and its minutes are written.' : 'it is interrupted; resume it after the halt.') : '';
  const sd = st.shutdowns.length ? ' Shutdown routines: ' + st.shutdowns.map(x => x.seat + ' ' + x.status).join(', ') + '.' : '';
  tell('The company is pausing: ' + by + ' asked it to stop, so nothing new starts and work in progress is finishing.' + reasonOf(why)
    + (st.escalate ? ' Anything still running at the deadline is stopped at once.' : '') + (mw ? ' Your meeting is interrupted; you can pick it up after the pause.' : '')
    + (cv && cv.unowned && cv.unowned.length ? ' Some promises to outside people have nobody on them yet; the crew must hand them over before the pause completes.' : '')
    + ' I will tell you when everything has stopped.',
    'Soft halt by ' + by + ': running work finishes by ' + st.deadline + (st.escalate ? ' or it escalates to a hard halt' : '') + '.' + sd + cm + mw + (st.cronError ? ' Scheduler NOT disarmed: ' + st.cronError + '.' : ''));
  return st;
}

// What is still running on the station, by the two reads that cover it: routine leases and the run table.
async function inFlight(st) {
  const c = await cronList();
  const busy = [], owner = [];
  const byId = new Map(c.jobs.map(x => [x.id, x]));
  for (const x of c.jobs) if (x && x.inFlight) busy.push('routine "' + x.name + '"');
  let runs = [];
  try { const r = await S.call('GET', '/api/state/snapshot'); runs = ((r && r.status === 200 && j(r)) || {}).runs || []; } catch (_) {}
  for (const r of runs) {
    if (!r) continue;
    if (r.source === 'cron') continue;   // already counted through the routine lease
    const label = (r.source || 'run') + ' ' + (r.agentId || '?') + (r.runId ? ' (' + r.runId + ')' : '');
    (r.source === 'interactive' && !r.internal ? owner : busy).push(label);
  }
  for (const row of st.shutdowns || []) {
    if (row.status !== 'fired' || row.done) continue;
    const job = byId.get(row.jobId);
    const ran = job && !job.inFlight && job.lastRunAt && job.lastRunAt !== row.lastRunAtBefore;
    if (ran) { row.done = true; row.doneAt = iso(S.now()); row.lastStatus = job.lastStatus || null; }
    else if (!job) { row.done = true; row.doneAt = iso(S.now()); row.lastStatus = 'routine gone'; }
    else if (row.maxMinutes && !row.overdue && S.now() - Date.parse(row.firedAt) > row.maxMinutes * 60000) row.overdue = true;
  }
  const pending = (st.shutdowns || []).filter(x => x.status === 'fired' && !x.done).map(x => 'shutdown ' + x.seat + (x.overdue ? ' (past its ' + x.maxMinutes + ' min)' : ''));
  return { busy, owner, pending };
}

async function tick({ log, dry } = {}) {
  const say = log || (() => {});
  const st = read();
  if (st.mode !== 'soft' || st.settledAt) return { mode: st.mode, action: 'none' };
  let w;
  try { w = await inFlight(st); } catch (e) { say('HALT: soft halt waiting, station unreadable: ' + e.message); return { mode: 'soft', action: 'unreadable', error: e.message }; }
  if (!dry && st.loops) { await pauseQuietLoops(st); write(st); }
  const left = w.busy.concat(w.pending).concat(((st.loops || {}).waiting || []).map(id => 'goal loop ' + id));
  const cv = continuityView();
  if (cv) { st.commitments = cv; for (const id of cv.unowned || []) left.push('commitment ' + id + ' unowned (breach-able; reassign it)'); }
  for (const m of meetingWork()) if (m.running && m.state === 'open') left.push('the owner\'s meeting (finishing its turn)');
  if (dry) return { mode: 'soft', action: 'dry', left };
  if (!left.length) {
    st.settledAt = iso(S.now());
    write(st);
    const sd = (st.shutdowns || []).length ? ' Shutdown routines: ' + st.shutdowns.map(x => x.seat + ' ' + (x.done ? 'done' + (x.lastStatus ? ' (' + x.lastStatus + ')' : '') : x.status)).join(', ') + '.' : '';
    tell('The company is paused: everything has stopped and nothing is running.' + (w.owner.length ? ' Work you started yourself is still open.' : '') + RESUME_LINK,
      'Soft halt settled.' + sd + (w.owner.length ? ' Still open in the owner\'s station tab: ' + w.owner.join(', ') + '.' : '') + ' CLI: node company/tools/halt.js resume --by <name>.');
    say('HALT: soft halt complete, nothing in flight');
    return { mode: 'soft', action: 'settled', settledAt: st.settledAt };
  }
  if (Date.parse(st.deadline) <= S.now() && !st.deadlinePassedAt) {
    st.deadlinePassedAt = iso(S.now());
    st.leftAtDeadline = left;
    write(st);
    if (st.escalate) {
      tell('Some work was still running when the pause deadline came, so I am stopping it all at once now, as you asked.', 'Soft halt deadline passed; escalate was on; still running: ' + left.join(', ') + '.');
      const h = await hard({ by: 'halt.js (soft-halt deadline)', why: 'soft halt deadline ' + st.deadline + ' passed; escalate was on', auto: true });
      tell(h.station && h.station.ok ? 'The company is paused: all work has stopped.' + RESUME_LINK : 'The company is paused, but some work that was running may not have stopped yet; nothing new will start.' + RESUME_LINK,
        'Hard halt after the soft-halt deadline: station reply ' + JSON.stringify(h.station) + '.');
      say('HALT: soft deadline passed, escalated to hard');
      return { mode: 'hard', action: 'escalated', left };
    }
    tell('The pause deadline has passed, but ' + (left.length === 1 ? 'one piece of work is' : left.length + ' pieces of work are') + ' still finishing. I will let ' + (left.length === 1 ? 'it' : 'them') + ' finish; if you want everything stopped now, use [Stop everything now](console:#/halt?mode=hard).',
      'Soft halt deadline passed with work still running: ' + left.join(', ') + '. Not escalating (escalate off). CLI: node company/tools/halt.js hard --by <name>.');
    say('HALT: soft deadline passed, owner told, still waiting on ' + left.length);
    return { mode: 'soft', action: 'deadline', left };
  }
  if ((st.shutdowns && JSON.stringify(st.shutdowns) !== JSON.stringify(read().shutdowns)) || (cv && JSON.stringify(cv.unowned) !== JSON.stringify((read().commitments || {}).unowned))) write(st);
  say('HALT: soft halt waiting on ' + left.length + ': ' + left.join(', ').slice(0, 300));
  return { mode: 'soft', action: 'waiting', left };
}

async function resume({ by } = {}) {
  if (!by) throw new Error('--by <name> is required');
  const prev = read();
  if (prev.mode === 'running') return Object.assign({ already: true }, prev);
  const out = { mode: 'running', by, at: iso(S.now()), previous: { mode: prev.mode, by: prev.by, at: prev.at, why: prev.why || null, settledAt: prev.settledAt || null } };
  const notes = [];
  if (prev.mode === 'hard') {
    const r = await S.call('POST', '/api/halt/resume', { confirm: true });
    const b = j(r) || {};
    if (r.status !== 200 || !b.ok) throw new Error('POST /api/halt/resume failed: HTTP ' + r.status + ' ' + String(r.body).slice(0, 200) + ' — still hard-halted');
    notes.push('station E-STOP lifted');
  }
  if (typeof prev.cronWasEnabled === 'boolean') {
    const c = await cronList();
    if (c.enabled !== prev.cronWasEnabled || c.halted) { await arm(prev.cronWasEnabled); notes.push('scheduler ' + (prev.cronWasEnabled ? 're-armed' : 'left disarmed, as it was')); }
    else notes.push('scheduler already ' + (c.enabled ? 'armed' : 'disarmed') + ', as it was');
  }
  for (const id of ((prev.loops || {}).paused || [])) {
    try { const r = await S.call('POST', '/api/loops/control', { id, action: 'resume' }); if (r.status === 200) notes.push('goal loop ' + id + ' resumed'); else notes.push('goal loop ' + id + ' NOT resumed (HTTP ' + r.status + ')'); }
    catch (e) { notes.push('goal loop ' + id + ' NOT resumed (' + e.message + ')'); }
  }
  write(out);
  tell('The company is running again: ' + by + ' started it, and the crew picks up where it left off.',
    'Resumed from a ' + prev.mode + ' halt: ' + (notes.join('; ') || 'nothing to undo on the station') + '.');
  return Object.assign(out, { notes });
}

module.exports = { S, read, hard, soft, tick, resume, inFlight, continuityView };

/* ---------------- selftest: a fake station in memory, no network ---------------- */
async function selftest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halt-selftest-'));
  const saved = Object.assign({}, S);
  const cases = [];
  const check = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  let clock = Date.parse('2026-01-05T10:00:00Z');
  const told = [];
  const techs = [];
  const svc = [];
  const station = {};
  const calls = [];
  const reset = () => Object.assign(station, { enabled: true, halted: false, estops: 0, resumes: 0, runs: [], jobs: [
    { id: 'j1', name: 'Founder loop', lastRunAt: '2026-01-05T09:00:00Z' },
    { id: 'j2', name: 'Desk loop', lastRunAt: '2026-01-05T09:00:00Z', inFlight: true },
    { id: 'j3', name: 'Desk shutdown', lastRunAt: null },
  ], loops: [{ id: 'L1', enabled: true, state: 'idle' }, { id: 'L2', enabled: true, state: 'running' }, { id: 'L3', enabled: false, state: 'paused' }] });
  const fake = async (method, p, body) => {
    calls.push(method + ' ' + p);
    const ok = b => ({ status: 200, body: JSON.stringify(b) });
    if (method === 'GET' && p === '/api/cron') return ok({ enabled: station.enabled, halted: station.halted, jobs: station.jobs });
    if (method === 'GET' && p === '/api/state/snapshot') return ok({ runs: station.runs });
    if (method === 'GET' && p === '/api/loops') return ok({ loops: station.loops });
    if (method === 'POST' && p === '/api/loops/control') { const l = station.loops.find(x => x.id === body.id); if (!l) return { status: 404, body: '{}' }; if (body.action === 'pause') { if (l.state === 'running') l.cut = true; l.state = 'paused'; l.enabled = false; } if (body.action === 'resume') { l.state = 'idle'; l.enabled = true; } return ok({ ok: true }); }
    if (method === 'POST' && p === '/api/cron/arm') { station.enabled = body.enabled; station.halted = false; return ok({ ok: true, enabled: station.enabled }); }
    if (method === 'POST' && p === '/api/halt') { station.estops++; station.halted = true; for (const x of station.jobs) delete x.inFlight; return ok({ halted: 1 }); }
    if (method === 'POST' && p === '/api/halt/resume') { if (!body || body.confirm !== true) return { status: 400, body: '{}' }; station.resumes++; station.halted = false; return ok({ ok: true }); }
    if (method === 'POST' && p === '/api/cron/run') { const x = station.jobs.find(y => y.id === body.id); if (!x) return { status: 404, body: '{}' }; x.inFlight = true; return ok({ ok: true }); }
    return { status: 404, body: '{}' };
  };
  Object.assign(S, {
    haltFile: path.join(dir, 'halt.json'), loopsFile: path.join(dir, 'loops.json'), now: () => clock,
    call: fake, fire: id => fake('POST', '/api/cron/run', { id }), notify: (t, tech) => { told.push(t); techs.push(tech || ''); }, services: st => { svc.push(st.mode); },
  });
  fs.writeFileSync(S.loopsFile, JSON.stringify({ agents: {
    agent: { name: 'Alex', loop: 'Founder loop', manager: null },
    desk: { name: 'Sam', loop: 'Desk loop', manager: 'agent', shutdown: { routine: 'Desk shutdown', maxMinutes: 15, procedure: 'company/roles/sam.md#soft-shutdown' } },
  } }));
  try {
    // soft
    reset();
    let st = await soft({ by: 'Alex', why: 'test', deadlineMin: 30 });
    check('soft writes mode soft with a deadline', st.mode === 'soft' && st.deadline === iso(clock + 30 * 60000));
    check('soft records the prior arm state and disarms', st.cronWasEnabled === true && station.enabled === false);
    check('soft fires only the seat shutdown routine', calls.filter(c => c === 'POST /api/cron/run').length === 1 && station.jobs[2].inFlight === true && !station.jobs[0].inFlight);
    check('soft tells the owner', told.length === 1 && /The company is pausing/.test(told[0]));
    check('soft pauses an idle goal loop and leaves a running pass alone', station.loops[0].state === 'paused' && station.loops[1].state === 'running' && !station.loops[1].cut && read().loops.waiting.includes('L2'));
    let t = await tick({});
    check('tick waits while a loop and the shutdown run', t.action === 'waiting' && t.left.some(x => /Desk loop/.test(x)) && t.left.some(x => /shutdown desk/.test(x)), JSON.stringify(t));
    station.runs = [{ runId: 'r1', agentId: 'agent', source: 'interactive' }];
    station.jobs[1].inFlight = false; station.jobs[1].lastRunAt = '2026-01-05T10:05:00Z';
    station.jobs[2].inFlight = false; station.jobs[2].lastRunAt = '2026-01-05T10:06:00Z';
    station.loops[1].state = 'waiting';
    clock += 10 * 60000;
    t = await tick({});
    check('tick settles when idle (owner tab run does not hold it)', t.action === 'settled' && read().mode === 'soft' && read().settledAt, JSON.stringify(t));
    check('settle tells the owner', /everything has stopped/.test(told[told.length - 1]));
    check('settle names no command; the command is in the technical part', !/node |halt\.js|`|--by/.test(told[told.length - 1]) && /halt\.js resume/.test(techs[techs.length - 1]));
    check('a settled soft halt ticks to none', (await tick({})).action === 'none');
    let r = await resume({ by: 'Alex' });
    check('the finished loop pass was paused, never cut, and resume restarts only the loops the halt paused', station.loops[0].state === 'idle' && station.loops[1].state === 'idle' && !station.loops[1].cut && station.loops[2].state === 'paused');
    check('resume from soft re-arms to the prior state', r.mode === 'running' && station.enabled === true && station.resumes === 0);
    check('resume tells the owner', /^The company is running again/.test(told[told.length - 1]));
    check('every message to the owner is plain: no command, no path, no raw error', told.every(t => !/node |\.js\b|`|--[a-z]|HTTP|E-STOP|\{/.test(t)), told);
    check('every halt.json write hands the state to service.js (soft, then running)', svc[0] === 'soft' && svc[svc.length - 1] === 'running', svc);

    // deadline without escalate
    reset(); told.length = 0;
    await soft({ by: 'Alex', deadlineMin: 5 });
    clock += 6 * 60000;
    t = await tick({});
    check('deadline without escalate: owner told, stays soft, no E-STOP', t.action === 'deadline' && read().mode === 'soft' && station.estops === 0 && /still finishing/.test(told[told.length - 1]) && !/halt\.js/.test(told[told.length - 1]));
    t = await tick({});
    check('deadline is told once', t.action === 'waiting' && told.filter(x => /deadline has passed/.test(x)).length === 1);
    await resume({ by: 'Alex' });

    // deadline with escalate
    reset(); told.length = 0;
    await soft({ by: 'Alex', deadlineMin: 5, escalate: true });
    clock += 6 * 60000;
    t = await tick({});
    check('deadline with escalate goes hard and says so', t.action === 'escalated' && read().mode === 'hard' && station.estops === 1 && told.some(x => /stopping it all at once/.test(x)));
    check('escalated hard keeps the prior arm state', read().cronWasEnabled === true);
    r = await resume({ by: 'Alex' });
    check('resume from hard lifts the E-STOP with confirm and re-arms', station.resumes === 1 && station.enabled === true && r.mode === 'running');

    // direct hard
    reset(); told.length = 0; station.enabled = false;
    st = await hard({ by: 'Alex', why: 'stop now' });
    check('hard posts /api/halt and records it', st.mode === 'hard' && station.estops === 1 && st.station.ok && st.cronWasEnabled === false);
    check('hard tells the owner plainly: the company is paused, no command', /^The company is paused/.test(told[told.length - 1]) && !/node |halt\.js|`|E-STOP/.test(told[told.length - 1]) && /E-STOP/.test(techs[techs.length - 1]));
    check('hard reaches service.js before the station is called', svc.includes('hard'));
    let threw = null; try { await soft({ by: 'Alex' }); } catch (e) { threw = e.message; }
    check('soft is refused while hard-halted', threw && /hard-halted/.test(threw));
    await resume({ by: 'Alex' });
    check('resume leaves a scheduler that was disarmed before, disarmed', station.enabled === false && read().mode === 'running');

    // unreachable station during hard: halt.json still says hard
    reset();
    S.call = async () => { throw new Error('ECONNREFUSED'); };
    st = await hard({ by: 'Alex' });
    check('hard with no station still writes mode hard', read().mode === 'hard' && st.station.ok === false);
    threw = null; try { await resume({ by: 'Alex' }); } catch (e) { threw = e.message; }
    check('resume with no station refuses and stays hard', threw && read().mode === 'hard');
  } finally {
    Object.assign(S, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const bad = cases.filter(c => !c.pass);
  for (const c of cases) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']'));
  console.log(bad.length ? 'HALT SELFTEST FAILED: ' + bad.length + ' of ' + cases.length : 'HALT SELFTEST PASSED: ' + cases.length + ' cases');
  return bad.length ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0] || 'status';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  const print = o => console.log(JSON.stringify(o, null, 1));
  (async () => {
    if (cmd === 'selftest' || cmd === '--selftest') process.exit(await selftest());
    if (cmd === 'status') {
      const st = read();
      if (opt('station')) { try { st.stationHalt = j(await S.call('GET', '/api/halt')); } catch (e) { st.stationHalt = { error: e.message }; } }
      if (opt('json')) return print(st);
      console.log('mode: ' + st.mode + (st.by ? ' (by ' + st.by + ' at ' + st.at + ')' : '') + (st.why ? ' — ' + st.why : ''));
      if (st.mode === 'soft') console.log(st.settledAt ? 'settled at ' + st.settledAt : 'waiting; deadline ' + st.deadline + (st.escalate ? ' (escalates to hard)' : ' (owner is told, no escalation)'));
      if (st.commitments && st.commitments.count) { console.log('open commitments: ' + st.commitments.count + (st.commitments.unowned && st.commitments.unowned.length ? ', unowned: ' + st.commitments.unowned.join(', ') : '')); for (const [p, cs] of Object.entries(st.commitments.byParty || {})) console.log('  ' + p + ': ' + cs.map(c => c.id + ' due ' + (c.dueAt || c.ackBy || '-')).join(', ')); }
      for (const x of st.shutdowns || []) console.log('  shutdown ' + x.seat + ': ' + (x.done ? 'done' : x.status) + (x.overdue ? ' (overdue)' : ''));
      if (st.stationHalt) console.log('station: ' + JSON.stringify(st.stationHalt));
      return;
    }
    const by = opt('by'), why = typeof opt('why') === 'string' ? opt('why') : null;
    if (cmd === 'soft') return print(await soft({ by, why, deadlineMin: opt('deadline-min'), escalate: !!opt('escalate') }));
    if (cmd === 'hard') return print(await hard({ by, why }));
    if (cmd === 'resume') return print(await resume({ by }));
    if (cmd === 'tick') return print(await tick({ log: l => console.log(l), dry: !!opt('dry-run') }));
    throw new Error('commands: status, soft, hard, resume, tick, selftest');
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
