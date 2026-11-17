#!/usr/bin/env node
/* notify-when.js — start a long job (or watch one already running) and have the dispatcher wake a seat when it ends.
 *
 * Why: the dispatcher woke seats on handoffs, artifacts, owner messages, hiring and duties, but nothing woke anyone when
 * a job finished, so the crew guessed: a bare background shell plus polling, or a **Not before:** a few hours out. Start
 * it, hand off, and you are woken when it ends: the completion is the dispatcher's seventh wake source, and it satisfies
 * any `**Waiting on:** job:<id>` (or `service:<name>`) line (company/HANDOFFS.md).
 *
 *   node company/tools/notify-when.js --seat <seat>[,<seat>] --why "gold backfill" [--id gold-backfill] [--timeout 6h] -- <cmd> [args…]
 *        runs <cmd> (no shell) detached from your run and returns at once with the job id; --foreground waits for it
 *   node company/tools/notify-when.js --seat <seat> --why "…" --pid <pid> [--log <file>]    watch a process already running
 *   node company/tools/notify-when.js --seat <seat> --why "…" --service <name>               watch a registered service's current run
 *   node company/tools/notify-when.js list [--json]                running watched jobs and the recent completions
 *   node company/tools/notify-when.js show <id>                    one completion (its output tail, secrets redacted)
 *   node company/tools/notify-when.js selftest     (or --selftest)
 * (service.js writes `notify-when.js --service-run <name> --seat a,b -- <argv>` as the ExecStart of a service proposed
 *  with --wake; it runs in the foreground and passes the exit code through, so systemd sees the job's own result.)
 *
 * On exit it appends one row to company/state/completions.jsonl (lib/completions.js): exit code, duration, the last 40
 * lines of output scrubbed of secrets, the seats to wake. That file is written only by this tool (provenance.js records
 * every write; locked-watch.js class A puts back anything else) and bounded (newest 300 rows past 400 rows or 1 MB).
 * The whole output goes to scratch/jobs/<id>.log. While a job runs, company/state/watched-jobs/<id>.json says so.
 * Exit: 0 ok (or the job's own exit code with --foreground/--service-run), 2 bad usage.
 * Owner: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const co = require('./lib/company');
const C = require('./lib/completions');

const ROOT = co.ROOT;
const TAIL = 40;
function usage(msg) { console.error('notify-when: ' + msg + '\n  node company/tools/notify-when.js --seat <seat> --why "…" [--id <name>] -- <cmd> [args…]   (or --pid <pid> | --service <name>)'); process.exit(2); }
function parseArgs(argv) {
  const o = { cmd: null }; const i = argv.indexOf('--');
  const head = i >= 0 ? argv.slice(0, i) : argv; if (i >= 0) o.cmd = argv.slice(i + 1);
  for (let k = 0; k < head.length; k++) {
    const a = head[k];
    if (!a.startsWith('--')) { (o._ = o._ || []).push(a); continue; }
    const key = a.slice(2); const flag = ['foreground', 'json', 'detached-child', 'selftest'].includes(key);
    o[key] = flag ? true : head[++k];
  }
  return o;
}
function seatsOf(v) {
  const crew = co.crew(); const out = [];
  for (const s of String(v || '').split(',').map(x => x.trim()).filter(Boolean)) {
    const id = crew[s] ? s : Object.keys(crew).find(k => { const n = String((crew[k] || {}).name || '').toLowerCase(); return n === s.toLowerCase() || n.split(/\s+/)[0] === s.toLowerCase(); });
    if (!id) usage('no seat "' + s + '" in company/tools/loops.json');
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
function durSec(v) { if (v == null) return null; const m = String(v).match(/^(\d+)\s*(s|sec|m|min|h)?$/i); if (!m) usage('--timeout is like 90s, 40min or 6h'); const n = Number(m[1]); const u = (m[2] || 's').toLowerCase(); return n * (u.startsWith('h') ? 3600 : u.startsWith('m') ? 60 : 1); }
const newId = () => 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const runFile = id => path.join(C.RUNNING_DIR(ROOT), id + '.json');
const logFileOf = id => path.join(ROOT, 'scratch', 'jobs', id + '.log');
const scrubCmd = argv => C.redact((argv || []).map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' '), ROOT).slice(0, 400);
function writeRunning(rec) { fs.mkdirSync(C.RUNNING_DIR(ROOT), { recursive: true }); fs.writeFileSync(runFile(rec.id), JSON.stringify(rec, null, 1) + '\n'); }
function finish(rec, res, tail) {
  try { fs.unlinkSync(runFile(rec.id)); } catch (_) {}
  const ended = Date.now();
  const row = { id: rec.id, job: rec.job || null, seat: rec.seat, why: rec.why || null, cmd: rec.cmd || null, service: rec.service || null, pid: rec.pid || null,
    startedAt: rec.startedAt, endedAt: new Date(ended).toISOString(), durationMs: ended - Date.parse(rec.startedAt), exit: res.exit == null ? null : res.exit, signal: res.signal || null,
    status: res.status, tail: C.redact(tail.join('\n'), ROOT).split('\n').slice(-TAIL).map(l => l.slice(0, 400)), log: rec.log ? path.relative(ROOT, rec.log) : null, by: 'notify-when.js' };
  C.append(ROOT, row);
  return row;
}
function lastLines(file, n) { try { return require('./lib/bounded').tailLines(file, n, { maxBytes: 256 * 1024 }); } catch (_) { return []; } }

// run argv to its end; output to the log and a ring of the last lines
function runWrapped(rec, argv, timeoutSec, passStdio) {
  return new Promise(resolve => {
    fs.mkdirSync(path.dirname(rec.log), { recursive: true });
    const out = fs.openSync(rec.log, 'a'); const ring = []; let part = '';
    const take = buf => { const s = part + buf.toString('utf8'); const ls = s.split('\n'); part = ls.pop(); for (const l of ls) { ring.push(l); if (ring.length > TAIL) ring.shift(); } };
    let child; try { child = spawn(argv[0], argv.slice(1), { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); } catch (e) { resolve({ res: { status: 'failed', exit: 127 }, tail: [String(e.message)] }); return; }
    rec.pid = child.pid; writeRunning(rec);
    for (const s of [child.stdout, child.stderr]) s.on('data', b => { fs.writeSync(out, b); take(b); if (passStdio) process.stdout.write(b); });
    let timedOut = false, t = null;
    if (timeoutSec) t = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 10000).unref(); }, timeoutSec * 1000);
    const forward = sig => { try { child.kill(sig); } catch (_) {} };
    process.on('SIGTERM', () => forward('SIGTERM')); process.on('SIGINT', () => forward('SIGINT'));
    child.on('error', e => { ring.push(String(e.message)); });
    child.on('close', (code, signal) => {
      if (t) clearTimeout(t); if (part) ring.push(part); try { fs.closeSync(out); } catch (_) {}
      const status = timedOut ? 'timeout' : signal ? 'killed' : code === 0 ? 'ok' : 'failed';
      resolve({ res: { status, exit: code, signal }, tail: ring.slice(-TAIL) });
    });
  });
}
async function watchPid(rec, logFile) {
  rec.pid = Number(rec.pid); writeRunning(rec);
  while (C.alive(rec.pid)) await new Promise(r => setTimeout(r, Number(process.env.NOTIFY_WHEN_POLL_MS) || 5000));
  return { res: { status: 'ended', exit: null }, tail: logFile ? lastLines(logFile, TAIL) : [] };
}
function systemctl(args) {
  try { return String(require('child_process').execFileSync(process.env.SERVICE_SYSTEMCTL || '/usr/bin/systemctl', ['--user'].concat(args), { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch (e) { return String(e.stdout || ''); }
}
async function watchService(rec) {
  const reg = co.readJson(co.p('company', 'state', 'services.json'), {}) || {}; const e = (reg.services || {})[rec.service];
  if (!e || !e.unit) usage('no registered service "' + rec.service + '" (node company/tools/service.js list)');
  const unit = e.unit + '.service'; writeRunning(rec);
  const show = () => { const o = {}; for (const l of systemctl(['show', unit, '-p', 'ActiveState,Result,ExecMainStatus']).split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); } return o; };
  let s = show();
  while (['active', 'activating', 'reloading', 'deactivating'].includes(s.ActiveState)) { await new Promise(r => setTimeout(r, Number(process.env.NOTIFY_WHEN_POLL_MS) || 5000)); s = show(); }
  const exit = s.ExecMainStatus !== undefined && s.ExecMainStatus !== '' ? Number(s.ExecMainStatus) : null;
  const status = s.Result === 'success' || (!s.Result && exit === 0) ? 'ok' : s.Result === 'timeout' ? 'timeout' : /signal|core-dump/.test(s.Result || '') ? 'killed' : 'failed';
  let tail = []; try { tail = String(require('child_process').execFileSync('journalctl', ['--user', '-u', unit, '-n', String(TAIL), '-o', 'cat', '--no-pager'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })).split('\n').filter(Boolean); } catch (_) {}
  return { res: { status, exit }, tail };
}

async function main(argv) {
  const o = parseArgs(argv);
  const sub = (o._ || [])[0];
  if (sub === 'selftest' || o.selftest) return selftest();
  if (sub === 'list') {
    const run = C.running(ROOT), done = C.recent(ROOT, 20);
    if (o.json) { console.log(JSON.stringify({ running: run, completions: done }, null, 1)); return 0; }
    for (const r of run) console.log('RUNNING  ' + r.id + '  ' + (r.why || r.job || r.cmd) + '  since ' + r.startedAt + '  wakes ' + r.seat.join(','));
    for (const r of done.slice().reverse()) console.log((C.failed(r) ? 'FAILED   ' : 'ENDED    ') + r.id + '  ' + C.words(r) + '  (' + r.endedAt + ')');
    if (!run.length && !done.length) console.log('no watched jobs yet');
    return 0;
  }
  if (sub === 'show') {
    const r = C.recent(ROOT, C.MAX_ROWS).find(x => x.id === (o._ || [])[1] || x.job === (o._ || [])[1]);
    if (!r) { console.error('notify-when: no completion ' + (o._ || [])[1]); return 2; }
    console.log(C.words(r) + '\n' + (r.tail || []).join('\n')); return 0;
  }
  const serviceRun = o['service-run'];
  const seat = seatsOf(o.seat || o.wake);   // a --service-run may name none: its row still satisfies `Waiting on: service:<name>`
  if (!seat.length && !serviceRun) usage('--seat names who to wake');
  const modes = [o.cmd && o.cmd.length ? 1 : 0, o.pid ? 1 : 0, o.service ? 1 : 0].reduce((a, b) => a + b, 0);
  if (modes !== 1) usage('give exactly one of: -- <cmd…>, --pid <pid>, --service <name>');
  if (!serviceRun && String(o.why || '').trim().length < 3) usage('--why says in a few words what the job is ("gold backfill")');
  if (o.id && !/^[A-Za-z0-9][\w.:-]{0,79}$/.test(o.id)) usage('--id is letters, digits, . _ : - (it is what `**Waiting on:** job:<id>` names)');
  const id = o['job-id'] || newId();
  const rec = { id, job: o.id || null, seat, why: String(o.why || (serviceRun ? 'the ' + serviceRun + ' run' : '')).replace(/\s+/g, ' ').trim().slice(0, 160), service: serviceRun || o.service || null,
    cmd: o.cmd ? scrubCmd(o.cmd) : null, pid: o.pid || null, watcherPid: process.pid, startedAt: new Date().toISOString(), log: o.cmd ? logFileOf(id) : null };
  // detach by default: the caller's run returns at once with the id, and the job outlives it
  if (!o.foreground && !serviceRun && !o['detached-child']) {
    const args = [__filename].concat(argv.filter(a => a !== '--foreground')); const k = args.indexOf('--'); args.splice(k < 0 ? args.length : k, 0, '--detached-child', '--job-id', id);
    const child = spawn(process.execPath, args, { cwd: process.cwd(), detached: true, stdio: 'ignore', env: process.env }); child.unref();
    console.log('started ' + id + (rec.job ? ' (job:' + rec.job + ')' : '') + ': ' + (rec.why || rec.cmd) + ' — ' + seat.map(s => co.nameOf(s)).join(', ') + ' will be woken when it ends'
      + (rec.log ? '; output in ' + path.relative(ROOT, rec.log) : '') + '. Hand off now (a `**Waiting on:** job:' + (rec.job || id) + '` line holds the next step until then) and end the run.');
    return 0;
  }
  const r = o.cmd ? await runWrapped(rec, o.cmd, durSec(o.timeout), !!serviceRun || !!o.foreground) : o.pid ? await watchPid(rec, o.log) : await watchService(rec);
  const row = finish(rec, r.res, r.tail);
  if (o.foreground || serviceRun) { if (o.foreground) console.log(C.words(row) + ' (' + row.id + ')'); return row.exit == null ? (row.status === 'ok' ? 0 : 1) : row.exit; }
  return 0;
}

function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-when-selftest-'));
  const w = (rel, s) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  w('company/tools/loops.json', JSON.stringify({ agents: { rohan: { name: 'Rohan Iyer', inbox: 'to-rohan.md' } } }));
  w('company/company.json', '{"name":"T"}'); w('secrets/pyth-api-key', 'pk_live_supersecretvalue123\n');
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T });
  const run = args => require('child_process').spawnSync(process.execPath, [__filename].concat(args), { cwd: T, env, encoding: 'utf8' });
  const rows = () => fs.readFileSync(path.join(T, 'company/state/completions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok   ' + name); };
  try {
    ok('a wrapped exit 0 is one ok row naming the seat', () => { const r = run(['--seat', 'Rohan', '--why', 'gold backfill', '--id', 'gb', '--foreground', '--', process.execPath, '-e', 'console.log("done 1")']); assert.equal(r.status, 0, r.stderr); const x = rows(); assert.equal(x.length, 1); assert.equal(x[0].status, 'ok'); assert.deepEqual(x[0].seat, ['rohan']); assert.equal(x[0].job, 'gb'); assert.equal(x[0].tail.pop(), 'done 1'); assert.equal(x[0].by, 'notify-when.js'); });
    ok('a non-zero exit is a failed row and the exit code passes through', () => { const r = run(['--seat', 'rohan', '--why', 'x job', '--foreground', '--', process.execPath, '-e', 'process.exit(3)']); assert.equal(r.status, 3); assert.equal(rows().pop().status, 'failed'); assert.match(C.words(rows().pop()), /FAILED: exit 3/); });
    ok('the output tail has secrets redacted', () => { run(['--seat', 'rohan', '--why', 'leaky', '--foreground', '--', process.execPath, '-e', 'console.log("key pk_live_supersecretvalue123 token=abcdef123456 sk-abcdefghijklmnopqrstu")']); const t = rows().pop().tail.join('\n'); assert.ok(!/supersecret|abcdef123456|sk-abcdefghij/.test(t), t); assert.match(t, /\[secret pyth-api-key\]/); });
    ok('a timeout is labelled as one', () => { run(['--seat', 'rohan', '--why', 'slow', '--timeout', '1s', '--foreground', '--', process.execPath, '-e', 'setTimeout(()=>{},60000)']); assert.equal(rows().pop().status, 'timeout'); });
    ok('provenance: each write is recorded as notify-when.js with the exact bytes on disk', () => { const p = fs.readFileSync(path.join(T, 'company/state/locked/provenance.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.file === 'company/state/completions.jsonl'); assert.ok(p.length >= 4 && p.every(r => r.writer === 'notify-when.js' && r.kind === 'write' && /notify-when\.js$/.test(r.main))); assert.equal(p[p.length - 1].sha256, 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(path.join(T, 'company/state/completions.jsonl'))).digest('hex')); });
    ok('usage: an unknown seat or no command is refused (exit 2)', () => { assert.equal(run(['--seat', 'nobody', '--why', 'x y', '--', 'true']).status, 2); assert.equal(run(['--seat', 'rohan', '--why', 'x y']).status, 2); });
    ok('bounded: past 400 rows the file keeps the newest 300', () => {
      const f = path.join(T, 'company/state/completions.jsonl'); const prev = process.env.CAPHEOS_ROOT;
      fs.writeFileSync(f, Array.from({ length: C.MAX_ROWS }, (_, i) => JSON.stringify({ id: 'c-old-' + i, seat: ['rohan'], status: 'ok' })).join('\n') + '\n');
      C.append(T, { id: 'c-new', seat: ['rohan'], status: 'ok' }); const x = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(x.length, C.KEEP_ROWS); assert.equal(x[x.length - 1].id, 'c-new'); process.env.CAPHEOS_ROOT = prev;
    });
    ok('detached by default: returns at once with the id, the row lands when the job ends', () => {
      const before = rows().length; const r = run(['--seat', 'rohan', '--why', 'bg job', '--', process.execPath, '-e', 'setTimeout(()=>console.log("late"),300)']); assert.equal(r.status, 0); assert.match(r.stdout, /started c-/);
      const t0 = Date.now(); while (rows().length === before && Date.now() - t0 < 8000) require('child_process').spawnSync('sleep', ['0.1']);
      assert.equal(rows().length, before + 1); assert.equal(rows().pop().tail.pop(), 'late'); assert.equal(fs.readdirSync(path.join(T, 'company/state/watched-jobs')).length, 0);
    });
  } catch (e) { console.log('FAIL ' + e.message); console.log('NOTIFY-WHEN SELFTEST FAILED'); return 1; } finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} }
  console.log('NOTIFY-WHEN SELFTEST PASSED: ' + n + ' cases'); return 0;
}

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c || 0), e => { console.error('notify-when: ' + e.message); process.exit(1); });
module.exports = { parseArgs };
