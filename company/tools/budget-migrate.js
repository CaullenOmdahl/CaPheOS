#!/usr/bin/env node
/* budget-migrate.js — move an existing company to the phase 1 "one gate" layout, or back (docs/BUDGET.md "Migration").
 *
 * Phase 1 changes no money rule. It switches who starts the crew's scheduled loop runs:
 *   --to dispatcher (default)  company.json runtime.scheduler = "dispatcher"; every crew loop routine is paused on the
 *                              station (enabled:false — the dispatcher still starts it with Run now, through admit());
 *                              the watchdog routine (script only, company/tools/watchdog.js) is created: the only thing the
 *                              station schedule runs. A routine that was already switched off stays off (on:false).
 *   --to station               the rollback: runtime.scheduler = "station"; the routines the dispatcher took over are
 *                              armed again exactly as they were, the watchdog routine is removed.
 *   --seat <id> --off|--on     with the dispatcher owning the schedule: switch one seat's loop off or on (the station's
 *                              enabled switch no longer means that, since every crew loop is paused there)
 *
 *   node company/tools/budget-migrate.js [--root <company folder>] [--to dispatcher|station] --dry-run [--json]
 *   node company/tools/budget-migrate.js [--root <company folder>] [--to dispatcher|station] --by owner
 *   node company/tools/budget-migrate.js --selftest
 *
 * --dry-run is READ-ONLY, enforced: it reads company.json, company/tools/loops.json, company/state/scheduler.json and the
 * station's routine store FILE (.starnet-data/workspaces/cron.jobs.json, not the API), opens no socket, and every
 * filesystem write or network call in this process throws while it runs. It prints what it would change.
 * Without --dry-run it needs the owner (lib/owner.js) and the station API. Idempotent: a second run changes nothing.
 * It never runs by itself; nothing calls it. Owner: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
if (opt('root')) process.env.CAPHEOS_ROOT = path.resolve(opt('root'));   // before lib/company reads it

/* readOnly(fn): run fn with every write and every socket refused (the dry-run guarantee) */
async function readOnly(fn) {
  const net = require('net'), http = require('http'), https = require('https');
  const W = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'rmdirSync', 'copyFileSync', 'openSync', 'writeSync', 'truncateSync', 'symlinkSync', 'chmodSync', 'utimesSync', 'mkdtempSync'];
  const saved = [];
  const refuse = what => function () { throw new Error('dry-run is read-only: refused ' + what); };
  for (const k of W) {
    if (k === 'openSync') { const real = fs.openSync; saved.push([fs, k, real]); fs.openSync = function (f, flags) { if (flags != null && !/^r$/.test(String(flags)) && flags !== 0) throw new Error('dry-run is read-only: refused open for write ' + f); return real.apply(fs, arguments); }; continue; }
    saved.push([fs, k, fs[k]]); fs[k] = refuse('fs.' + k);
  }
  for (const [m, k] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [net, 'connect'], [net, 'createConnection']]) { saved.push([m, k, m[k]]); m[k] = refuse(k); }
  const realFetch = global.fetch; global.fetch = refuse('fetch');
  try { return await fn(); }
  finally { for (const [m, k, v] of saved) m[k] = v; global.fetch = realFetch; }
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

async function plan(o) {
  const co = require('./lib/company');
  const SCHED = require('./lib/scheduler');
  const to = o.to === 'station' ? 'station' : 'dispatcher';
  const cfg = readJson(co.p('company', 'company.json'), {}) || {};
  const crew = co.crew() || {};
  let jobs, source;
  if (o.dry) {
    const f = co.p('.starnet-data', 'workspaces', 'cron.jobs.json');
    const doc = readJson(f, null);
    jobs = doc ? (Array.isArray(doc) ? doc : doc.jobs || []) : null; source = path.relative(co.ROOT, f) + (doc ? '' : ' (missing)');
  } else {
    const r = await require('./station-crew.js').call('GET', '/api/cron', null, 20000);
    if (r.status !== 200) throw new Error('GET /api/cron: HTTP ' + r.status);
    jobs = JSON.parse(r.body).jobs || []; source = 'GET /api/cron';
  }
  const st = SCHED.readState(co.ROOT);
  const p = SCHED.plan(to, { jobs: jobs || [], crew, state: st, root: co.ROOT });
  const cur = SCHED.mode(cfg);
  const blockers = [];
  if (to === 'dispatcher') for (const f of [SCHED.WATCHDOG.script, 'company/tools/lib/admit.js', 'company/tools/lib/scheduler.js']) if (!fs.existsSync(co.p(f))) blockers.push(f + ' is not in this company yet: update its framework first');
  return { root: co.ROOT, from: cur, to, source, blockers, flag: cur !== to, jobsRead: jobs ? jobs.length : 0, pause: p.pause, resume: p.resume, createWatchdog: p.createWatchdog, removeWatchdog: p.removeWatchdog, keep: p.keep, missing: p.missing, owned: p.owned, state: st, cfg };
}
const nothing = p => !p.flag && !p.pause.length && !p.resume.length && !p.createWatchdog && !p.removeWatchdog.length;
function describe(p) {
  const L = [];
  L.push('company: ' + p.root);
  L.push('scheduler: ' + p.from + ' -> ' + p.to + (p.flag ? ' (company.json runtime.scheduler would be set to "' + p.to + '")' : ' (already)'));
  L.push('station routines read from: ' + p.source + ' (' + p.jobsRead + ' routines)');
  for (const x of p.pause) L.push('  pause   "' + x.name + '" (' + x.seat + ', station schedule ' + (x.schedule || '?') + '): the dispatcher starts its runs');
  for (const x of p.resume) L.push('  re-arm  "' + x.name + '" (' + x.seat + '): the station schedule fires it again');
  if (p.createWatchdog) L.push('  create  "' + require('./lib/scheduler').WATCHDOG.name + '": script only (company/tools/watchdog.js, every 15 minutes), no agent, starts no work');
  for (const x of p.removeWatchdog) L.push('  remove  "' + x.name + '"');
  for (const x of p.keep) L.push('  keep    "' + x.name + '" (' + x.seat + '): ' + x.why);
  for (const x of p.missing) L.push('  note    no routine matches loop "' + x.loop + '" for ' + x.seat + ' (nothing to do for it)');
  for (const b of p.blockers || []) L.push('  BLOCKED ' + b);
  if (nothing(p)) L.push('nothing to change: the company is already on the ' + p.to + ' scheduler.');
  L.push('money rules: unchanged (phase 1 changes no cap, share, spread or budget value).');
  return L.join('\n');
}

async function apply(p, by) {
  const co = require('./lib/company');
  const SCHED = require('./lib/scheduler');
  const call = (m, u, b) => require('./station-crew.js').call(m, u, b, 20000);
  const done = [], errors = [];
  const setFlag = () => {
    const f = co.p('company', 'company.json'); const cfg = readJson(f, {}) || {};
    cfg.runtime = Object.assign({ _doc: 'runtime.scheduler: who starts the crew\'s scheduled loop runs. "dispatcher" = the dispatcher, through admit(), with the crew loop routines paused on the station and one watchdog routine there; "station" = the station\'s own schedule (the old way). Switch only with company/tools/budget-migrate.js (docs/BUDGET.md).' }, cfg.runtime || {}, { scheduler: p.to });
    const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n'); fs.renameSync(tmp, f);
    done.push('company.json runtime.scheduler = ' + p.to);
  };
  const st = { mode: p.to, at: new Date().toISOString(), by, owned: p.owned };
  if (p.to === 'dispatcher') {
    SCHED.writeState(st, co.ROOT);                       // 1. the routines it takes over (a tick in between pauses them itself)
    if (p.flag) setFlag();                               // 2. the flag
    if (p.createWatchdog) { const r = await call('POST', '/api/cron', SCHED.watchdogSpec(co.ROOT, co.ceo())); (r.status === 200 ? done : errors).push('create watchdog: HTTP ' + r.status); }
    for (const x of p.pause) { const r = await call('POST', '/api/cron/update', { id: x.id, patch: { enabled: false } }); (r.status === 200 ? done : errors).push('pause "' + x.name + '": HTTP ' + r.status); }
  } else {
    if (p.flag) setFlag();                               // 1. the flag first: a tick in between does not pause them again
    for (const x of p.resume) { const r = await call('POST', '/api/cron/update', { id: x.id, patch: { enabled: true } }); (r.status === 200 ? done : errors).push('re-arm "' + x.name + '": HTTP ' + r.status); }
    for (const x of p.removeWatchdog) { const r = await call('POST', '/api/cron/remove', { id: x.id }); (r.status === 200 ? done : errors).push('remove watchdog: HTTP ' + r.status); }
    SCHED.writeState(st, co.ROOT);
  }
  try { const f = co.p('company', 'work', 'ops', 'scheduler-log.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: st.at, by, from: p.from, to: p.to, done, errors }) + '\n'); } catch (_) {}
  return { done, errors };
}
function seatSwitch(seat, on, by) {
  const co = require('./lib/company'); const SCHED = require('./lib/scheduler');
  if (SCHED.mode() !== 'dispatcher') return { ok: false, error: 'the station owns the schedule here: switch the routine itself on or off on the station' };
  const st = SCHED.readState(co.ROOT);
  const hit = Object.entries(st.owned).find(([, v]) => v && v.seat === seat);
  if (!hit) return { ok: false, error: 'no loop routine of ' + seat + ' is recorded in company/state/scheduler.json' };
  hit[1].on = on; hit[1].switchedBy = by; hit[1].switchedAt = new Date().toISOString();
  SCHED.writeState(st, co.ROOT);
  return { ok: true, seat, on };
}

async function selftest() {
  const os = require('os');
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-migrate-selftest-'));
  const w = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
  w('company/company.json', { name: 'M', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
  w('company/tools/loops.json', { agents: { agent: { name: 'Alex', loop: 'Founder loop', functions: ['ceo'] }, sam: { name: 'Sam', loop: 'Sam loop' }, kim: { name: 'Kim', loop: 'Kim loop' } } });
  w('.starnet-data/workspaces/cron.jobs.json', { version: 1, jobs: [{ id: 'j1', name: 'Founder loop', enabled: true, schedule: { kind: 'interval', minutes: 60, display: 'every 1h' } }, { id: 'j2', name: 'Sam loop', enabled: true, schedule: { kind: 'cron', expr: '0 */2 * * *', display: 'cron 0 */2 * * *' } }, { id: 'j3', name: 'Kim loop', enabled: false }] });
  const before = fs.readdirSync(T, { recursive: true }).sort().join('|');
  const r = require('child_process').spawnSync(process.execPath, [__filename, '--root', T, '--dry-run', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { STARNET_URL: 'http://127.0.0.1:1' }) });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  ok('dry-run: pauses the armed crew loops, keeps the one switched off, creates the watchdog, sets the flag', j && j.pause.length === 2 && j.keep.length === 1 && j.createWatchdog && j.flag && j.to === 'dispatcher', r.stdout + r.stderr);
  ok('dry-run wrote nothing', fs.readdirSync(T, { recursive: true }).sort().join('|') === before);
  const r2 = require('child_process').spawnSync(process.execPath, ['-e', 'process.argv.push("--dry-run");require(' + JSON.stringify(__filename) + ')._readOnly(async()=>require("fs").writeFileSync(' + JSON.stringify(path.join(T, 'x')) + ',"x")).then(()=>process.exit(0),e=>{console.log(e.message);process.exit(3)})'], { encoding: 'utf8' });
  ok('a write inside the dry-run guard throws', r2.status === 3 && /read-only/.test(r2.stdout) && !fs.existsSync(path.join(T, 'x')), r2.stdout + r2.stderr);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  console.log(bad ? 'BUDGET-MIGRATE SELFTEST FAILED: ' + bad : 'BUDGET-MIGRATE SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { plan, apply, describe, seatSwitch, _readOnly: readOnly };

if (require.main === module) {
  (async () => {
    if (argv.includes('--selftest') || argv[0] === 'selftest') return selftest();
    const to = opt('to') || 'dispatcher';
    if (!['dispatcher', 'station'].includes(to)) { console.error('--to is dispatcher or station'); return 2; }
    const json = argv.includes('--json');
    if (argv.includes('--dry-run')) {
      const p = await readOnly(() => plan({ to, dry: true }));
      const out = Object.assign({}, p); delete out.cfg; delete out.state;
      console.log(json ? JSON.stringify(out, null, 1) : 'DRY RUN (read-only: nothing written, no station call)\n' + describe(p));
      return 0;
    }
    const by = opt('by');
    if (!by) { console.error('--by owner is required (or --dry-run to see the plan)'); return 2; }
    const own = require('./lib/owner');
    if (!own.isOwnerName(by)) { console.error('the scheduler is the owner\'s switch: --by owner (or the owner\'s name)'); return 3; }
    const refusal = own.refusal(by, 'the scheduler switch');
    if (refusal) { console.error(refusal); return 3; }
    if (opt('seat')) {
      const r = seatSwitch(opt('seat'), !argv.includes('--off'), by);
      console.log(r.ok ? opt('seat') + ' scheduled loop ' + (r.on ? 'on' : 'off') : 'refused: ' + r.error); return r.ok ? 0 : 1;
    }
    const p = await plan({ to, dry: false });
    console.log(describe(p));
    if (p.blockers && p.blockers.length) { console.error('not applied: ' + p.blockers.length + ' precondition(s) above'); return 1; }
    if (nothing(p)) return 0;
    const r = await apply(p, by);
    for (const d of r.done) console.log('done: ' + d);
    for (const e of r.errors) console.log('ERROR: ' + e);
    return r.errors.length ? 1 : 0;
  })().then(c => process.exit(c || 0), e => { console.error('budget-migrate.js: ' + (e && e.message || e)); process.exit(1); });
}
