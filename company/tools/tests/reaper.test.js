'use strict';
// reaper.test.js — lib/owned.js on a fake /proc: what counts as THIS company's process (docs/RETENTION.md "The reaper"),
// and what never does. reaper.js selftest runs the real processes and a real Chrome; this checks each rule alone.
//   node --test company/tools/tests/reaper.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('assert');
const life = require('../lib/temp-life');
const O = require('../lib/owned');

const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
function fakeProc() {
  const T = life.tmpDir('reaper-test-selftest-');
  const root = path.join(T, 'x', 'co'), other = path.join(T, 'x', 'co-2'), proc = path.join(T, 'proc');
  for (const d of [root, other, proc, path.join(root, 'company')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ slug: 'co', station: { serviceName: 'co-station' } }));
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu 0\nbtime ' + Math.floor(Date.now() / 1000 - 36000) + '\n');
  const put = (pid, o) => {
    const d = path.join(proc, String(pid)); fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'cmdline'), o.cmd.join('\0') + '\0');
    // after "(comm) ": state, ppid, pgid, ... utime at [11], stime at [12], starttime at [19] (proc(5) fields 3..)
    const rest = ['S', o.ppid || 1, o.pgid || pid]; while (rest.length < 22) rest.push(0);
    rest[11] = o.ticks || 0; rest[19] = o.start || 100;
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + (o.comm || 'x') + ') ' + rest.join(' '));
    fs.writeFileSync(path.join(d, 'status'), 'Name:\t' + (o.comm || 'x') + '\nUid:\t' + (o.uid == null ? UID : o.uid) + '\t0\t0\t0\nVmRSS:\t  20480 kB\n');
    if (o.cwd) fs.symlinkSync(o.cwd, path.join(d, 'cwd'));
    if (o.env) fs.writeFileSync(path.join(d, 'environ'), o.env.join('\0') + '\0');
    if (o.cgroup) fs.writeFileSync(path.join(d, 'cgroup'), o.cgroup + '\n');
  };
  return { T, root, other, proc, put };
}
const ctxOf = (f, o) => O.context(Object.assign({ root: f.root, proc: f.proc, home: path.join(f.T, 'home'), ledger: [], stationPids: [] }, o || {}));

test('proof by path: profile, working folder (also a deleted one) and TMPDIR inside the root; never a sibling sharing its prefix', () => {
  const f = fakeProc();
  f.put(10, { cmd: ['/opt/google/chrome/chrome', '--headless=new', '--user-data-dir=' + f.root + '/.starnet-data/tmp/p1'], comm: 'chrome' });
  f.put(11, { cmd: ['/opt/google/chrome/chrome', '--headless=new', '--user-data-dir=' + f.other + '/.starnet-data/tmp/p1'], comm: 'chrome' });
  f.put(12, { cmd: ['node', 'x.js'], cwd: f.root + '/scratch/phil-gone (deleted)' });
  f.put(13, { cmd: ['node', 'x.js'], env: ['HOME=/h', 'TMPDIR=' + f.root + '/.starnet-data/tmp'] });
  f.put(14, { cmd: ['node', 'x.js'], cwd: f.other });
  const c = ctxOf(f); const all = O.scan(c);
  assert.strictEqual(O.proof(all.get(10), c).how, 'path');
  assert.strictEqual(O.proof(all.get(11), c), null, '/x/co-2 is not /x/co');
  assert.match(O.proof(all.get(12), c).detail, /\(deleted\)$/);
  assert.match(O.proof(all.get(13), c).detail, /^TMPDIR /);
  assert.strictEqual(O.proof(all.get(14), c), null);
});

test('proof by unit, station pid and ledger receipt (pid AND identity: a reused pid never matches)', () => {
  const f = fakeProc();
  f.put(20, { cmd: ['node', 'build.js'], cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/co-station.service' });
  f.put(21, { cmd: ['node', 'svc.js'], cgroup: '0::/user.slice/user@1000.service/app.slice/co-svc-rec.service' });
  f.put(22, { cmd: ['node', 'sidecar/index.js'] });
  f.put(23, { cmd: ['bash', '-c', 'npm run build'], start: 200 });
  f.put(24, { cmd: ['bash', '-c', 'npm run build'], start: 900000 });
  const c = ctxOf(f, { stationPids: [22], ledger: [{ pid: 23, cmd: 'bash -c npm run build', kind: 'shell.fg', created: null, startedAt: Date.now() }, { pid: 24, cmd: 'x', created: 1 }] });
  const all = O.scan(c);
  assert.strictEqual(O.proof(all.get(20), c).how, 'unit');
  assert.strictEqual(O.proof(all.get(21), c).how, 'unit');
  assert.strictEqual(O.proof(all.get(22), c).how, 'station-pid');
  assert.strictEqual(O.proof(all.get(23), c).how, 'ledger');
  assert.strictEqual(O.proof(all.get(24), c), null, 'the receipt\'s creation time is not this process\'s: a reused pid');
});

test('never touchable: another uid, a unit the company does not own, the owner\'s own Chrome, a live main', () => {
  const f = fakeProc();
  const prof = f.root + '/.starnet-data/tmp/p';
  f.put(30, { cmd: ['/opt/google/chrome/chrome', '--headless', '--user-data-dir=' + prof], comm: 'chrome', uid: UID + 1 });
  f.put(31, { cmd: ['node', 'x.js'], cwd: f.root, cgroup: '0::/user.slice/user@1000.service/app.slice/other-company-station.service' });
  f.put(32, { cmd: ['/opt/google/chrome/chrome', '--user-data-dir=' + prof], comm: 'chrome' });
  f.put(33, { cmd: ['/opt/google/chrome/chrome', '--remote-debugging-port=9222', '--user-data-dir=' + path.join(f.T, 'home', '.config', 'google-chrome')], comm: 'chrome' });
  f.put(34, { cmd: ['/opt/google/chrome/chrome', '--headless', '--user-data-dir=' + prof], comm: 'chrome', cgroup: '0::/user.slice/user@1000.service/app.slice/app-com.google.Chrome-34.scope' });
  f.put(35, { cmd: ['node', 'console/server.js'], cwd: f.root });
  const c = ctxOf(f, { mainPids: [35] }); const all = O.scan(c);
  assert.strictEqual(O.touchable(all.get(30), c), false, 'another user');
  assert.strictEqual(O.touchable(all.get(31), c), false, 'in another company\'s unit');
  assert.strictEqual(O.touchable(all.get(32), c), false, 'a window a person opened (not driven)');
  assert.strictEqual(O.touchable(all.get(33), c), false, 'a profile under ~/.config');
  assert.strictEqual(O.touchable(all.get(34), c), true, 'a driven browser in the scope Chrome made for itself, on the company\'s profile');
  assert.strictEqual(O.touchable(all.get(35), c), false, 'the live console');
});

test('browsers: parent kind and idle state; strays: handed to init, outside the units, known kinds', () => {
  const f = fakeProc();
  f.put(1058, { cmd: ['/usr/lib/systemd/systemd', '--user'], comm: 'systemd' });
  f.put(40, { cmd: ['node', 'sidecar/index.js'], ppid: 1058 });
  const prof = n => f.root + '/.starnet-data/tmp/' + n;
  f.put(41, { cmd: ['/opt/google/chrome/chrome --headless=new --remote-debugging-port=9333 --user-data-dir=' + prof('a')], comm: 'chrome', ppid: 1058 });
  f.put(42, { cmd: ['/opt/google/chrome/chrome', '--type=renderer', '--user-data-dir=' + prof('a')], comm: 'chrome', ppid: 41 });
  f.put(43, { cmd: ['/opt/google/chrome/chrome', '--headless', '--remote-debugging-port=9444', '--user-data-dir=' + prof('b')], comm: 'chrome', ppid: 40 });
  f.put(44, { cmd: ['/opt/google/chrome/chrome', '--headless', '--remote-debugging-port=9555', '--user-data-dir=' + prof('c')], comm: 'chrome', ppid: 1058 });
  f.put(50, { cmd: ['/home/u/flutter/bin/cache/artifacts/engine/linux-x64/flutter_tester', '--packages=x'], comm: 'flutter_tester', ppid: 1058, cwd: f.root + '/scratch/phil-ui (deleted)' });
  f.put(51, { cmd: ['node', 'sidecar/index.js', '--port', '0'], ppid: 1058, cwd: f.root + '/scratch/sn-fresh (deleted)' });
  f.put(52, { cmd: ['sleep', '300'], ppid: 1058, cwd: f.root });
  f.put(53, { cmd: ['sleep', '300'], ppid: 1058, cwd: f.root, cgroup: '0::/user.slice/user@1000.service/app.slice/co-station.service' });
  // 127.0.0.1:41000 -> 127.0.0.1:9555 (0x2553) ESTABLISHED: a client on browser 44's port
  const netTcp = '  sl  local_address rem_address   st\n   0: 0100007F:A028 0100007F:2553 01 00000000:00000000 00:00000000 00000000  1000        0 1 1\n';
  const c = ctxOf(f, { stationPids: [40], stationMain: 40, netTcp });
  const B = Object.fromEntries(O.browsers(c).map(b => [b.pid, b]));
  assert.deepStrictEqual(Object.keys(B).map(Number).sort((a, b) => a - b), [41, 43, 44]);
  assert.strictEqual(B[41].parent, 'orphan'); assert.strictEqual(B[41].idle, true); assert.deepStrictEqual(B[41].pids.sort(), [41, 42]);
  assert.strictEqual(B[43].parent, 'station');
  assert.strictEqual(B[44].idle, false, 'a client is connected to its port');
  const S = Object.fromEntries(O.strays(c, { minAgeS: 0 }).map(s => [s.pid, s]));
  assert.strictEqual(S[50].kind, 'flutter_tester');
  assert.strictEqual(S[51].kind, 'test station', 'a sidecar started from a deleted scratch folder');
  assert.strictEqual(S[52].kind, null, 'an unknown kind is listed, not ended');
  assert.ok(!S[53], 'inside the company\'s unit: that unit\'s life, not a stray');
  assert.ok(!S[40], 'the live station is never a stray');
});

test('a receipt matched by command line needs its startedAt: without it a reused pid running a similar command is not claimed', () => {
  const f = fakeProc();
  f.put(25, { cmd: ['bash', '-c', 'npm run build --watch'] });
  const c = ctxOf(f, { ledger: [{ pid: 25, cmd: 'bash -c npm run build', kind: 'shell.bg' }] });
  assert.strictEqual(O.proof(O.scan(c).get(25), c), null, 'no startedAt, no created: no proof');
  const c2 = ctxOf(f, { ledger: [{ pid: 25, cmd: 'bash -c npm run build', kind: 'shell.bg', startedAt: Date.now() }] });
  assert.strictEqual(O.proof(O.scan(c2).get(25), c2).how, 'ledger');
  const c3 = ctxOf(f, { ledger: [{ pid: 25, cmd: 'bash -c npm run build', kind: 'shell.bg', startedAt: Date.now() - 20 * 3600e3 }] });
  assert.strictEqual(O.proof(O.scan(c3).get(25), c3), null, 'it started after the receipt was written: a reused pid');
});

test('a driven Chrome with no --user-data-dir runs on the owner\'s default profile: never touchable, never listed', () => {
  const f = fakeProc();
  f.put(1058, { cmd: ['/usr/lib/systemd/systemd', '--user'], comm: 'systemd' });
  f.put(36, { cmd: ['/opt/google/chrome/chrome', '--remote-debugging-port=9222'], comm: 'chrome', ppid: 1058, cwd: f.root });
  const c = ctxOf(f); const all = O.scan(c);
  assert.ok(O.proof(all.get(36), c), 'its working folder is in the company');
  assert.strictEqual(O.touchable(all.get(36), c), false, 'but it is the owner\'s Chrome');
  assert.ok(!O.browsers(c).some(b => b.pid === 36));
});

test('naming: only Chrome processes naming the profile exactly; a sibling sharing its prefix and a crew command are left alone', () => {
  const f = fakeProc();
  const p = f.root + '/.browser-profile';
  f.put(60, { cmd: ['/opt/google/chrome/chrome', '--type=renderer', '--user-data-dir=' + p], comm: 'chrome' });
  f.put(61, { cmd: ['/opt/google/chrome/chrome_crashpad_handler', '--database=' + p + '/Crashpad', '--monitor-self'], comm: 'chrome_crashpad' });
  f.put(62, { cmd: ['/opt/google/chrome/chrome', '--headless', '--user-data-dir=' + p + '-2'], comm: 'chrome' });
  f.put(63, { cmd: ['/opt/google/chrome/chrome_crashpad_handler', '--database=' + p + '-2/Crashpad'], comm: 'chrome_crashpad' });
  f.put(64, { cmd: ['du', '-sh', p] , comm: 'du' });
  f.put(65, { cmd: ['/opt/google/chrome/chrome', '--user-data-dir=' + p + 'x'], comm: 'chrome' });
  const c = ctxOf(f);
  assert.deepStrictEqual(O.naming(c, p).sort((a, b) => a - b), [60, 61]);
  assert.ok(O.namesPath('--user-data-dir=' + p, p) && O.namesPath(p + '/Default', p) && !O.namesPath(p + '-2', p) && !O.namesPath('/elsewhere' + p, p));
});

test('strays: a Gradle daemon is ended only after its idle time without CPU, with a polite TERM first; never for its age alone', () => {
  const f = fakeProc();
  const RP = require('../reaper');
  f.put(1058, { cmd: ['/usr/lib/systemd/systemd', '--user'], comm: 'systemd' });
  const gd = { cmd: ['/usr/lib/jvm/bin/java', '-Xmx2g', 'org.gradle.launcher.daemon.bootstrap.GradleDaemon', '8.7'], comm: 'java', ppid: 1058, cwd: f.root + '/scratch/phil-app', ticks: 500 };
  f.put(70, gd);
  f.put(71, { cmd: ['/home/u/flutter/bin/cache/artifacts/engine/linux-x64/flutter_tester'], comm: 'flutter_tester', ppid: 1058, cwd: f.root + '/scratch/phil-app' });
  fs.mkdirSync(path.join(f.root, 'company', 'state'), { recursive: true });
  const kills = [];
  const at = t => RP.context({ root: f.root, proc: f.proc, supervisor: 'none', cgroupOf: () => '', home: path.join(f.T, 'home'), now: t, minAgeS: 0, idleS: 3 * 3600, graceMs: 10, daemonGraceMs: 10,
    kill: (pid, sig) => { kills.push(pid + ' ' + sig); return true; }, alive: pid => pid === 70 && !kills.includes('70 SIGKILL'), noNetwork: true });   // the daemon ignores TERM here: KILL after the grace
  const t0 = Date.now();
  let ctx = at(t0); let r = RP.stepStrays(ctx);
  assert.ok(kills.some(k => k === '71 SIGTERM' || k === '-71 SIGTERM'), 'flutter_tester ended at once: ' + kills.join());
  assert.ok(!kills.some(k => /^-?70 /.test(k)), 'first sighting of the daemon: its clock starts');
  assert.match(r.list.find(x => x.pid === 70).decision, /^in use/);
  const save = c => fs.writeFileSync(path.join(f.root, 'company', 'state', 'reaper.json'), JSON.stringify(c.state));
  save(ctx);
  // 2 h later it used CPU (a build): the clock starts again
  fs.rmSync(path.join(f.proc, '70'), { recursive: true }); f.put(70, Object.assign({}, gd, { ticks: 900 }));
  kills.length = 0; ctx = at(t0 + 2 * 3600e3); r = RP.stepStrays(ctx); save(ctx);
  assert.ok(!kills.some(k => /^-?70 /.test(k)), 'used CPU: kept');
  // 4 h after that, no CPU used since: idle 4 h (over 3), ended with TERM to the pid alone, then KILL
  kills.length = 0; ctx = at(t0 + 6 * 3600e3); r = RP.stepStrays(ctx);
  assert.strictEqual(r.list.find(x => x.pid === 70).decision, 'end');
  assert.ok(kills.indexOf('70 SIGTERM') >= 0 && kills.indexOf('70 SIGTERM') < kills.indexOf('70 SIGKILL') && !kills.includes('-70 SIGTERM'), 'TERM to the daemon alone first: ' + kills.join());
  const row = fs.readFileSync(path.join(f.root, 'company', 'state', 'reaper.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(x => x.pid === 70);
  assert.match(row.plain, /^Ended a left-behind gradle daemon from Phil's work \(\d+ h old, unused for 4 h, \d+ MB\)\.$/);
});

test('retention: a yes on a report-only folder hands its removal to the tools seat (the reaper never deletes it), until it is gone', () => {
  const f = fakeProc();
  const RP = require('../reaper');
  const W = (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); };
  W(path.join(f.root, 'company', 'work', 'ops', 'retention.json'), JSON.stringify({ artifacts: [
    { id: 'old-rehearsal', path: '.starnet-data/rehearsal', policy: 'report-only', warnBytes: 1, enforce: false, plain: 'The old rehearsal copy' }] }));
  W(path.join(f.root, '.starnet-data', 'rehearsal', 'f'), 'x'.repeat(8192)); fs.mkdirSync(path.join(f.root, 'company', 'state'), { recursive: true });
  const cards = []; let yes = false;
  const at = t => { const c = RP.context({ root: f.root, proc: f.proc, supervisor: 'none', now: t, noNetwork: true, halted: false,
    card: { file: o => { cards.push(o); return { filed: true, id: 'q-1' }; } }, answerOf: ref => yes && ref === 'retention:old-rehearsal' ? { yes: true, id: 'q-1' } : null }); c.forceRetention = true; c.due = []; c.rows = []; return c; };
  const t0 = Date.parse('2026-11-19T12:00:00Z');
  let c = at(t0); RP.stepRetention(c); fs.writeFileSync(path.join(f.root, 'company', 'state', 'reaper.json'), JSON.stringify(c.state));
  assert.strictEqual(cards.length, 1);
  assert.match(cards[0].consequence, /^Yes: the crew checks nothing still uses it, removes it and tells you when it is gone\./);
  yes = true;
  c = at(t0 + 86400e3); let r = RP.stepRetention(c); fs.writeFileSync(path.join(f.root, 'company', 'state', 'reaper.json'), JSON.stringify(c.state));
  assert.ok(fs.existsSync(path.join(f.root, '.starnet-data', 'rehearsal', 'f')), 'the reaper never deletes a report-only folder');
  assert.deepStrictEqual(r.handedOver, ['old-rehearsal']);
  assert.ok(c.due.some(d => d.id === 'retention-yes:old-rehearsal' && /The owner agreed that the old rehearsal copy/.test(d.reason)), JSON.stringify(c.due));
  c = at(t0 + 2 * 86400e3); r = RP.stepRetention(c); fs.writeFileSync(path.join(f.root, 'company', 'state', 'reaper.json'), JSON.stringify(c.state));
  assert.strictEqual(c.due.length, 0, 'once a week, not every day');
  fs.rmSync(path.join(f.root, '.starnet-data', 'rehearsal'), { recursive: true });
  c = at(t0 + 9 * 86400e3); r = RP.stepRetention(c);
  assert.strictEqual(c.due.length, 0, 'gone: nothing more to hand over');
  assert.ok(c.state.retention['old-rehearsal'].done, 'and the row is marked done');
});
