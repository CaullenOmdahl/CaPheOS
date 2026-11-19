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
    fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + (o.comm || 'x') + ') S ' + (o.ppid || 1) + ' ' + (o.pgid || pid) + ' 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ' + (o.start || 100) + ' 0');
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
