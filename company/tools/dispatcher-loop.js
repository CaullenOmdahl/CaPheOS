#!/usr/bin/env node
/* dispatcher-loop.js — the self-paced dispatcher: one dispatch tick, then sleep the current tempo, forever.
 *
 * Why: a systemd timer holds the tick in a unit file that cadence.js would have to rewrite and reload, so the tempo
 * drifted from reality. This process re-reads the effective tempo (company/tools/cadence.js effective(): the owner's
 * base, or an agent's temporary change inside the owner's bounds, which expires by itself) on every iteration, so a
 * change is live within a minute and never needs a reload. Guide: docs/TEMPO.md.
 *
 *   node company/tools/dispatcher-loop.js            run (systemd: <station>-dispatch.service, Type=simple, Restart=always)
 *   node company/tools/dispatcher-loop.js --once     one tick, then exit with its code
 *   node company/tools/dispatcher-loop.js status     print the state file
 *   node company/tools/dispatcher-loop.js selftest
 *
 * Each iteration spawns `node company/tools/dispatch.js` (dispatch.js stays a one-tick program; liveness heartbeats,
 * modules and the halt check all run inside it as before) with DISPATCH_COOLDOWN_MIN / DISPATCH_MAX_PER_TICK set to the
 * effective tempo (unless the environment already sets them). Ticks never overlap: the next one starts only after the
 * previous child exited, and a lock file (company/state/dispatcher-loop.lock) keeps a second loop from starting. A tick
 * that runs past DISPATCHER_TICK_TIMEOUT_SEC (default 900) is stopped (SIGTERM, then SIGKILL).
 * The next tick is lastTickEnd + effective tick minutes, re-checked every 30 s while sleeping, so a speed-up or its
 * expiry moves the next tick at once. SIGTERM/SIGINT: stop sleeping, let a running tick finish (after 60 s it is sent
 * SIGTERM), write the state, exit 0.
 * State: company/state/dispatcher-loop.json {status, pid, startedAt, lastTickAt, lastTickEndAt, lastExit, lastTickSec,
 *   nextTickAt, tempo:{tickMin, cooldownMin, maxPerTick, source}, reason, ticks}. onboard.js, liveness and the console
 *   read it. One log line per tick on stdout (the journal).
 * Env (tests): DISPATCHER_LOOP_CMD (a script to run instead of dispatch.js), DISPATCHER_LOOP_STATE (state file),
 *   DISPATCHER_LOOP_MINUTE_MS (length of a minute, default 60000).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const co = require('./lib/company');

const DEFAULTS = {
  cmd: process.env.DISPATCHER_LOOP_CMD || path.join(__dirname, 'dispatch.js'),
  stateFile: process.env.DISPATCHER_LOOP_STATE || co.p('company', 'state', 'dispatcher-loop.json'),
  minuteMs: Number(process.env.DISPATCHER_LOOP_MINUTE_MS) > 0 ? Number(process.env.DISPATCHER_LOOP_MINUTE_MS) : 60000,
  tickTimeoutMs: (Number(process.env.DISPATCHER_TICK_TIMEOUT_SEC) > 0 ? Number(process.env.DISPATCHER_TICK_TIMEOUT_SEC) : 900) * 1000,
  sliceMs: 30000,
  stopGraceMs: 60000,
  tempo: () => require('./cadence.js').effective(),
  log: line => console.log(new Date().toISOString() + ' ' + line),
};

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 1) + '\n'); fs.renameSync(tmp, file);
  } catch (_) {}
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function lock(file) {
  const lf = file.replace(/\.json$/, '') + '.lock';
  try { fs.mkdirSync(path.dirname(lf), { recursive: true }); fs.writeFileSync(lf, String(process.pid), { flag: 'wx' }); return lf; }
  catch (_) {
    const other = Number(String(fs.readFileSync(lf, 'utf8')).trim());
    if (other && other !== process.pid && alive(other)) return null;
    fs.writeFileSync(lf, String(process.pid)); return lf;   // stale lock
  }
}
function safeTempo(o) {
  try { const t = o.tempo(); if (t && Number(t.tickMin) > 0) return t; } catch (e) { o.log('TEMPO ERROR: ' + e.message + ' (using 10 min)'); }
  return { tickMin: 10, cooldownMin: null, maxPerTick: null, source: 'fallback', reason: 'cadence.json unreadable' };
}
const tempoOf = t => ({ tickMin: t.tickMin, cooldownMin: t.cooldownMin, maxPerTick: t.maxPerTick, source: t.source, quiet: !!t.quiet });

/* runLoop(opts) -> Promise<exit code>. opts.stop() ends it (as SIGTERM does); opts.maxTicks bounds it (tests, --once). */
function runLoop(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const lf = lock(o.stateFile);
  if (!lf) { o.log('another dispatcher loop holds the lock; exiting'); return Promise.resolve(1); }
  const st = Object.assign(readJson(o.stateFile, {}) || {}, { status: 'starting', pid: process.pid, startedAt: new Date().toISOString(), ticks: 0 });
  let stopping = false, child = null, wake = null, lastExit = 0;
  const stop = sig => {
    if (stopping) return; stopping = true;
    o.log('stopping (' + (sig || 'stop') + ')' + (child ? '; letting the running tick finish' : ''));
    // the running tick finishes on its own; past the grace it is signalled (systemd: KillMode=mixed, TimeoutStopSec above the grace)
    if (child) setTimeout(() => { if (child) try { child.kill('SIGTERM'); } catch (_) {} }, o.stopGraceMs).unref();
    if (wake) wake();
  };
  if (o.signals !== false) { process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT')); }
  if (opts && opts.onStop) opts.onStop(stop);
  const sleep = ms => new Promise(r => { const t = setTimeout(() => { wake = null; r(); }, Math.max(0, ms)); wake = () => { clearTimeout(t); wake = null; r(); }; });
  const tick = tempo => new Promise(resolve => {
    const env = Object.assign({}, process.env);
    if (!env.DISPATCH_COOLDOWN_MIN && tempo.cooldownMin) env.DISPATCH_COOLDOWN_MIN = String(tempo.cooldownMin);
    if (!env.DISPATCH_MAX_PER_TICK && tempo.maxPerTick) env.DISPATCH_MAX_PER_TICK = String(tempo.maxPerTick);
    env.DISPATCHER_LOOP = '1';
    child = spawn(process.execPath, [o.cmd], { cwd: co.ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
    const killer = setTimeout(() => { o.log('tick ran past ' + Math.round(o.tickTimeoutMs / 1000) + ' s; stopping it'); try { child.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { child && child.kill('SIGKILL'); } catch (_) {} }, 10000).unref(); }, o.tickTimeoutMs);
    child.on('error', e => { o.log('tick could not start: ' + e.message); });
    child.on('close', (code, signal) => { clearTimeout(killer); child = null; resolve(code == null ? (signal ? 128 : 1) : code); });
  });
  return (async () => {
    try {
      while (!stopping) {
        const tempo = safeTempo(o);
        const t0 = Date.now();
        Object.assign(st, { status: 'ticking', lastTickAt: new Date(t0).toISOString(), nextTickAt: null, tempo: tempoOf(tempo), reason: tempo.reason || null });
        writeState(o.stateFile, st);
        lastExit = await tick(tempo);
        const t1 = Date.now();
        st.ticks = (st.ticks || 0) + 1;
        Object.assign(st, { lastTickEndAt: new Date(t1).toISOString(), lastExit, lastTickSec: Math.round((t1 - t0) / 100) / 10 });
        if (o.maxTicks && st.ticks >= o.maxTicks) break;
        if (stopping) break;
        let next = null, first = true;
        while (!stopping) {
          const t = safeTempo(o);
          const at = t1 + t.tickMin * o.minuteMs;
          if (at !== next) {
            next = at;
            Object.assign(st, { status: 'sleeping', nextTickAt: new Date(at).toISOString(), tempo: tempoOf(t), reason: t.reason || null });
            writeState(o.stateFile, st);
            o.log((first ? 'tick #' + st.ticks + ' exit ' + lastExit + ' in ' + st.lastTickSec + ' s; ' : 'tempo changed; ') + 'next tick in ' + Math.max(0, Math.round((at - Date.now()) / o.minuteMs * 10) / 10) + ' min (tick ' + t.tickMin + ' min, ' + (t.source || '?') + (t.reason ? ': ' + t.reason : '') + ')');
            first = false;
          }
          const left = next - Date.now();
          if (left <= 0) break;
          await sleep(Math.min(left, o.sliceMs));
        }
      }
    } finally {
      Object.assign(st, { status: 'stopped', stoppedAt: new Date().toISOString(), nextTickAt: null });
      writeState(o.stateFile, st);
      try { if (Number(String(fs.readFileSync(lf, 'utf8')).trim()) === process.pid) fs.unlinkSync(lf); } catch (_) {}
    }
    return o.maxTicks ? lastExit : 0;
  })();
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatcher-loop-selftest-'));
  const cases = [];
  const check = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  const marks = path.join(dir, 'marks.txt');
  const fake = path.join(dir, 'fake-dispatch.js');
  fs.writeFileSync(fake, "const fs=require('fs');fs.appendFileSync(" + JSON.stringify(marks) + ",'start '+Date.now()+' '+(process.env.DISPATCH_COOLDOWN_MIN||'-')+'\\n');setTimeout(()=>{fs.appendFileSync(" + JSON.stringify(marks) + ",'end '+Date.now()+'\\n');process.exit(Number(process.env.FAKE_EXIT||0))},Number(process.env.FAKE_MS||40));process.on('SIGTERM',()=>{fs.appendFileSync(" + JSON.stringify(marks) + ",'term\\n');process.exit(0)});\n");
  const stateFile = path.join(dir, 'state', 'dispatcher-loop.json');
  const lines = [];
  try {
    // in process: three ticks, never overlapping, tempo re-read each iteration
    let tickMin = 1; let reads = 0;
    const tempo = () => { reads++; return { tickMin, cooldownMin: 7, maxPerTick: 2, source: tickMin === 1 ? 'base' : 'temporary', reason: 'test ' + tickMin }; };
    const code = await runLoop({ cmd: fake, stateFile, minuteMs: 60, sliceMs: 10, tempo, log: l => lines.push(l), signals: false, maxTicks: 3 });
    const m = fs.readFileSync(marks, 'utf8').trim().split('\n');
    check('three ticks ran', m.filter(x => x.startsWith('start')).length === 3, m.join('|'));
    let overlap = false; for (let i = 0; i < m.length; i += 2) if (!m[i].startsWith('start') || !(m[i + 1] || '').startsWith('end')) overlap = true;
    check('ticks never overlap (start, end, start, end, …)', !overlap, m.join('|'));
    const starts = m.filter(x => x.startsWith('start')).map(x => Number(x.split(' ')[1])); const ends = m.filter(x => x.startsWith('end')).map(x => Number(x.split(' ')[1]));
    check('the loop sleeps the tick between the end of one and the start of the next', starts[1] - ends[0] >= 55 && starts[2] - ends[1] >= 55, JSON.stringify({ starts, ends }));
    check('the effective cooldown reaches dispatch.js through the environment', process.env.DISPATCH_COOLDOWN_MIN ? true : / 7$/.test(m[0]), m[0]);
    check('the tempo is re-read every iteration', reads >= 5, String(reads));
    let st = readJson(stateFile, {});
    check('the state file says when the last tick ran, the tempo and why', code === 0 && st.status === 'stopped' && st.ticks === 3 && st.lastTickAt && st.lastTickEndAt && st.tempo.tickMin === 1 && st.reason === 'test 1', JSON.stringify(st));
    check('each tick logs the effective tempo', lines.some(l => /next tick in .* \(tick 1 min, base: test 1\)/.test(l)), lines.join('\n'));
    check('the lock is released on exit', !fs.existsSync(stateFile.replace(/\.json$/, '') + '.lock'));

    // a speed-up while sleeping moves the next tick at once
    fs.writeFileSync(marks, ''); lines.length = 0; tickMin = 1000;
    let stopFn = null; const t0 = Date.now();
    const p = runLoop({ cmd: fake, stateFile, minuteMs: 60, sliceMs: 10, tempo, log: l => lines.push(l), signals: false, onStop: s => { stopFn = s; } });
    await new Promise(r => setTimeout(r, 150));
    st = readJson(stateFile, {});
    check('a long tick: the state says sleeping with the next tick far out', st.status === 'sleeping' && Date.parse(st.nextTickAt) - t0 > 30000, JSON.stringify(st));
    tickMin = 1;
    await new Promise(r => setTimeout(r, 200));
    const started = fs.readFileSync(marks, 'utf8').split('\n').filter(x => x.startsWith('start')).length;
    check('a speed-up during the sleep starts the next tick without waiting out the old one', started >= 2 && lines.some(l => /tempo changed/.test(l)), started + ' ' + lines.join('|'));
    stopFn('test');
    check('stop() ends the loop cleanly', (await p) === 0 && readJson(stateFile, {}).status === 'stopped');

    // a second loop does not start while one holds the lock
    fs.writeFileSync(stateFile.replace(/\.json$/, '') + '.lock', String(process.ppid || 1));
    const second = await runLoop({ cmd: fake, stateFile, minuteMs: 60, tempo, log: l => lines.push(l), signals: false, maxTicks: 1 });
    check('a second loop refuses to run beside a live one', second === 1 && lines.some(l => /holds the lock/.test(l)));
    fs.unlinkSync(stateFile.replace(/\.json$/, '') + '.lock');

    // as a real process: SIGTERM during a tick lets it finish (signalled), state written, exit 0
    fs.writeFileSync(marks, '');
    const stateFile2 = path.join(dir, 'state2', 'dispatcher-loop.json');
    const proc = spawn(process.execPath, [__filename], { env: Object.assign({}, process.env, { DISPATCHER_LOOP_CMD: fake, DISPATCHER_LOOP_STATE: stateFile2, DISPATCHER_LOOP_MINUTE_MS: '20', FAKE_MS: '400' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
    await new Promise(r => setTimeout(r, 250));
    proc.kill('SIGTERM');
    const ec = await new Promise(r => proc.on('close', c => r(c)));
    const st2 = readJson(stateFile2, {});
    check('SIGTERM exits 0 and the state says stopped', ec === 0 && st2.status === 'stopped' && /stopping \(SIGTERM\)/.test(out), ec + ' ' + JSON.stringify(st2) + ' ' + out);
    const mk = fs.readFileSync(marks, 'utf8');
    check('SIGTERM lets the running tick finish, and no second tick starts', /end /.test(mk) && !/term/.test(mk) && mk.split('\n').filter(x => x.startsWith('start')).length === 1, mk);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const bad = cases.filter(c => !c.pass);
  for (const c of cases) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']'));
  console.log(bad.length ? 'DISPATCHER-LOOP SELFTEST FAILED: ' + bad.length + ' of ' + cases.length : 'DISPATCHER-LOOP SELFTEST PASSED: ' + cases.length + ' cases');
  return bad.length ? 1 : 0;
}

module.exports = { runLoop, DEFAULTS };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === 'selftest' || a[0] === '--selftest') selftest().then(c => process.exit(c));
  else if (a[0] === 'status') { console.log(JSON.stringify(readJson(DEFAULTS.stateFile, { status: 'never ran' }), null, 1)); }
  else runLoop({ maxTicks: a.includes('--once') ? 1 : 0 }).then(c => process.exit(c), e => { console.error('dispatcher-loop: ' + e.message); process.exit(1); });
}
