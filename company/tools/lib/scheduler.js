'use strict';
/* lib/scheduler.js — who starts a seat's scheduled loop runs: the dispatcher, or the station (docs/BUDGET.md "Scheduler").
 *
 * company/company.json runtime.scheduler:
 *   "dispatcher"  the dispatcher reads each seat's schedule (cadence.json seats.<id>.loopEvery, else the routine's own
 *                 schedule) and starts a due loop itself, through admit() and every rule a wake passes. The crew's loop
 *                 routines are PAUSED on the station (enabled:false; the dispatcher's Run now still starts them), and the
 *                 station schedule runs ONE routine: the watchdog (company/tools/watchdog.js, script only, no agent),
 *                 which alerts when the dispatcher is silent and never starts work.
 *   "station"     (absent = station) the old way: the station's scheduler fires each loop routine on its own schedule
 *                 and the dispatcher only wakes seats that have work. Rollback is this flag, not a rebuild.
 * Switch with company/tools/budget-migrate.js (--to dispatcher|station); state: company/state/scheduler.json
 * { mode, at, by, owned: { <jobId>: { seat, name, on } } } — the routines the dispatcher took over and whether each seat is
 * on (a routine the owner had switched off stays off: on:false).
 *
 *   S.mode(cfg?)                         'dispatcher' | 'station'
 *   S.parseCron(expr) / S.cronMatch(f, parts)    5-field cron, company time zone
 *   S.lastDue(schedule, anchorMs, nowMs, tz)     the latest scheduled fire time in (anchor, now], or null
 *   S.scheduleOf(seatCadence, job)       the seat's schedule: {kind:'interval', minutes} | {kind:'cron', expr, tz} | null
 *   S.WATCHDOG                           the watchdog routine spec (name = the name PREFIX, script, schedule)
 *   S.isWatchdog(job) / S.crewLoopOf(jobs, loopName)   a watchdog: noAgent + the watchdog script + a name starting
 *                                        with WATCHDOG.name (each one is created as "<WATCHDOG.name> #<6 hex>": StarNet
 *                                        declines a name it remembers, also one deleted by a rollback, so never the bare name)
 *   S.watchdogSpec(root, agentId, name?) the POST /api/cron body, with a fresh unique name unless one is given
 *   await S.createWatchdog(call, root, agentId)   create it, read it back, retry once under a new name on a decline
 *   S.ownedOn(jobId) / S.switchedOff(job)   paused only because the dispatcher starts it / off for real
 *   S.plan(mode, { jobs, crew, state })  what the station's routines must become for that mode: { pause, resume, createWatchdog, removeWatchdog, owned }
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const WATCHDOG = {
  name: 'Watchdog (dispatcher liveness, starts no work)',
  script: 'company/tools/watchdog.js',
  schedule: 'every 15 minutes',
  prompt: 'Script-only watchdog (company/tools/watchdog.js): checks that the dispatcher is alive and alerts the owner if it is not. It never wakes an agent and never starts work.',
};
const stateFile = root => path.join(root || co.ROOT, 'company', 'state', 'scheduler.json');
function readState(root) { try { const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) || {}; s.owned = s.owned || {}; return s; } catch (_) { return { owned: {} }; } }
function writeState(st, root) {
  const f = stateFile(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  const doc = Object.assign({ _doc: 'Who starts scheduled loop runs (lib/scheduler.js, docs/BUDGET.md). owned: the crew loop routines the dispatcher paused on the station and starts itself; on:false = a seat the owner had switched off. Written by budget-migrate.js and the dispatcher only.' }, st);
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n'); fs.renameSync(tmp, f);
}
function mode(cfg) {
  const c = cfg || co.config || {};
  const m = c.runtime && c.runtime.scheduler;
  // The dispatcher takes the schedule over only when budget-migrate.js or found-company.sh switched it (schedulerSetBy):
  // a "dispatcher" value that arrived any other way (a framework update merged into company.json, a hand edit) must not
  // pause the station's loops on its own; the station keeps the schedule until the owner migrates.
  return m === 'dispatcher' && /^(budget-migrate\.js|found-company\.sh)$/.test(String((c.runtime && c.runtime.schedulerSetBy) || '')) ? 'dispatcher' : 'station';
}
// never the exact name: a rollback-and-migrate cycle names each watchdog anew ("… #25f494"), so match the prefix
const isWatchdog = j => !!j && j.noAgent === true && String(j.script || '') === WATCHDOG.script && String(j.name || '').startsWith(WATCHDOG.name);
// this company's watchdog: one whose workdir is this company's folder (a station serves one company; tests share one)
const ownWatchdogs = (jobs, root) => (jobs || []).filter(j => isWatchdog(j) && (!j.workdir || path.resolve(String(j.workdir)) === path.resolve(root || co.ROOT)));
function crewLoopOf(jobs, loopName) {
  if (!loopName) return null;
  const hits = (jobs || []).filter(j => j && !isWatchdog(j) && (j.name === loopName || String(j.name || '').startsWith(loopName)));
  return hits.length === 1 ? hits[0] : null;
}

/* ---------- cron ---------- */
function field(s, lo, hi) {
  const out = new Set();
  for (const part of String(s).split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/); if (!m) throw new Error('bad cron field "' + s + '"');
    let a = lo, b = hi;
    if (m[1] !== '*') { const r = m[1].split('-').map(Number); a = r[0]; b = r.length > 1 ? r[1] : (m[2] ? hi : r[0]); }
    const step = m[2] ? Number(m[2]) : 1;
    if (!(a >= lo && b <= hi && a <= b && step >= 1)) throw new Error('cron field out of range "' + s + '"');
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields: "' + expr + '"');
  const dow = field(f[4].replace(/\b7\b/g, '0'), 0, 6);
  return { minute: field(f[0], 0, 59), hour: field(f[1], 0, 23), dom: field(f[2], 1, 31), month: field(f[3], 1, 12), dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}
const fmtCache = new Map();
function partsIn(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }); fmtCache.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { minute: Number(o.minute), hour: Number(o.hour) % 24, dom: Number(o.day), month: Number(o.month), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) };
}
function cronMatch(c, p) {
  if (!c.minute.has(p.minute) || !c.hour.has(p.hour) || !c.month.has(p.month)) return false;
  const d = c.dom.has(p.dom), w = c.dow.has(p.dow);
  return c.domAny && c.dowAny ? true : c.domAny ? w : c.dowAny ? d : (d || w);   // vixie cron: both restricted = either
}
/* the latest scheduled fire in (anchorMs, nowMs], or null. A cron looks back at most 48 h. */
function lastDue(sch, anchorMs, nowMs, tz) {
  if (!sch || !Number.isFinite(anchorMs) || !(nowMs > anchorMs)) return null;
  if (sch.kind === 'interval') { const step = Number(sch.minutes) * 60e3; if (!(step > 0)) return null; const n = Math.floor((nowMs - anchorMs) / step); return n >= 1 ? anchorMs + n * step : null; }
  if (sch.kind === 'cron') {
    let c; try { c = parseCron(sch.expr); } catch (_) { return null; }
    const from = Math.max(anchorMs + 1, nowMs - 48 * 3600e3);
    for (let t = Math.floor(nowMs / 60e3) * 60e3; t >= from; t -= 60e3) if (cronMatch(c, partsIn(t, sch.tz || tz))) return t > anchorMs ? t : null;
    return null;
  }
  return null;
}
/* a seat's schedule: cadence.json seats.<id>.loopEvery wins (cadence.js parseEvery), else the routine's own schedule */
function scheduleOf(seatCad, job) {
  const every = seatCad && seatCad.loopEvery;
  if (every != null && String(every).trim() && !/^off$/i.test(String(every).trim())) {
    try { const p = require('../cadence.js').parseEvery(every); return p.kind === 'interval' ? { kind: 'interval', minutes: p.minutes, from: 'cadence.json' } : { kind: 'cron', expr: p.expr, from: 'cadence.json' }; } catch (_) { return null; }
  }
  const s = job && job.schedule;
  if (!s) return null;
  if (s.kind === 'interval' && Number(s.minutes) > 0) return { kind: 'interval', minutes: Number(s.minutes), from: 'routine' };
  if (s.kind === 'cron' && s.expr) return { kind: 'cron', expr: String(s.expr), tz: s.tz || null, from: 'routine' };
  return null;
}
const schedText = s => !s ? 'no schedule' : s.kind === 'interval' ? 'every ' + s.minutes + 'm' : 'cron ' + s.expr;

/* plan(mode, {jobs, crew, state}) — what the station's routines must become. Pure. */
function plan(m, o) {
  const jobs = o.jobs || [], crew = o.crew || {}, st = o.state || { owned: {} };
  const owned = Object.assign({}, st.owned || {});
  const out = { mode: m, pause: [], resume: [], createWatchdog: false, removeWatchdog: [], owned, keep: [], missing: [] };
  const wd = ownWatchdogs(jobs, o.root);
  for (const [seat, c] of Object.entries(crew)) {
    if (!c || !c.loop) continue;
    const j = crewLoopOf(jobs, c.loop);
    if (!j) { out.missing.push({ seat, loop: c.loop }); continue; }
    if (m === 'dispatcher') {
      if (j.enabled !== false) { out.pause.push({ id: j.id, seat, name: j.name, schedule: j.schedule && (j.schedule.display || j.scheduleDisplay) || null }); owned[j.id] = { seat, name: j.name, on: true }; }
      else if (!owned[j.id]) { owned[j.id] = { seat, name: j.name, on: false }; out.keep.push({ id: j.id, seat, name: j.name, why: 'already switched off on the station: it stays off (on:false)' }); }
    } else {
      const ow = owned[j.id];
      if (ow && ow.on !== false && j.enabled === false) out.resume.push({ id: j.id, seat, name: j.name });
      else if (ow && ow.on === false) out.keep.push({ id: j.id, seat, name: j.name, why: 'it was switched off before the dispatcher took it over: it stays off' });
    }
  }
  if (m === 'dispatcher') { if (!wd.length) out.createWatchdog = true; }
  else { out.removeWatchdog = wd.map(j => ({ id: j.id, name: j.name })); for (const k of Object.keys(owned)) delete owned[k]; }
  return out;
}
function watchdogSpec(root, agentId, name) {
  return { name: name || require('./station').uniqueName(WATCHDOG.name, 3), agentId: agentId || co.ceo() || 'agent', prompt: WATCHDOG.prompt, schedule: WATCHDOG.schedule, tz: co.TZ,
    script: WATCHDOG.script, noAgent: true, workdir: root || co.ROOT, deliver: 'local', enabled: true, unattendedGrants: ['workbench'], scriptTimeoutMs: 30000 };
}
// -> { ok, job, name, reason, tries }: a 200 that declines, or a create GET /api/cron does not list, is a failure
async function createWatchdog(call, root, agentId) {
  const ST = require('./station');
  return ST.createRoutine(call, watchdogSpec(root, agentId), { what: 'create watchdog', rename: () => ST.uniqueName(WATCHDOG.name, 3), attempts: 3 });
}

/* a crew loop paused on the station only because the dispatcher starts it (runtime.scheduler=dispatcher, seat on) */
function ownedOn(jobId, root) { if (mode() !== 'dispatcher') return false; const o = readState(root).owned[jobId]; return !!o && o.on !== false; }
const switchedOff = (job, root) => !!job && job.enabled === false && !ownedOn(job.id, root);   // off for real: the owner, or the pacer's rail pause

module.exports = { WATCHDOG, mode, ownedOn, switchedOff, readState, writeState, stateFile, isWatchdog, ownWatchdogs, crewLoopOf, parseCron, cronMatch, partsIn, lastDue, scheduleOf, schedText, plan, watchdogSpec, createWatchdog };
