#!/usr/bin/env node
/* ops-container-restart.test.js — verifies Issue #34:
 *  1. scripts/supervise.js writes company/state/supervise/<name>.pid and restarts its child on SIGUSR1.
 *  2. console/owner-ops.js issues a verifiable HMAC owner-job grant for systemd-run jobs, cleans it up on exit,
 *     and exposes POST /api/ops/restart/dispatch and POST /api/ops/baseline.
 *  3. framework-update.js detects needsDispatchRestart and container stationActive via supervise/station.pid.
 *   node --test company/tools/tests/ops-container-restart.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const life = require('../lib/temp-life');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SUPERVISE = path.join(REPO, 'scripts', 'supervise.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('supervise.js: writes pidfile and cleanly restarts child on SIGUSR1 without exiting supervisor', async () => {
  const T = life.tmpDir('sup-test-');
  const pidfile = path.join(T, 'company', 'state', 'supervise', 'station.pid');
  const sup = life.track(spawn(process.execPath, [SUPERVISE, '--name', 'station', '--', process.execPath, '-e', 'setInterval(() => {}, 60000)'], {
    cwd: T,
    env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }),
    stdio: 'ignore',
  }));
  try {
    let first = null;
    for (let i = 0; i < 40 && !first; i++) {
      try { first = JSON.parse(fs.readFileSync(pidfile, 'utf8')); } catch (_) { await sleep(50); }
    }
    assert.ok(first && first.supervisorPid === sup.pid && first.childPid > 1, 'pidfile written with supervisor & child pids');
    const oldChild = first.childPid;
    process.kill(sup.pid, 'SIGUSR1');
    let second = null;
    for (let i = 0; i < 60; i++) {
      try {
        const cur = JSON.parse(fs.readFileSync(pidfile, 'utf8'));
        if (cur && cur.childPid && cur.childPid !== oldChild) { second = cur; break; }
      } catch (_) {}
      await sleep(50);
    }
    assert.ok(second, 'supervise restarted child with a new PID after SIGUSR1');
    assert.equal(second.supervisorPid, sup.pid, 'supervisor PID remained unchanged');
    assert.notEqual(second.childPid, oldChild, 'child PID changed');
  } finally {
    try { sup.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('owner-ops.js: POST /api/ops/restart/dispatch signals supervised dispatcher in container mode', async () => {
  const T = life.tmpDir('ops-disp-');
  const pidfile = path.join(T, 'company', 'state', 'supervise', 'dispatch.pid');
  fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
  fs.mkdirSync(path.join(T, 'company', 'tools', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'company', 'tools', 'lib', 'host.js'), path.join(T, 'company', 'tools', 'lib', 'host.js'));
  fs.mkdirSync(path.join(T, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }));
  fs.writeFileSync(path.join(T, 'secrets', 'console-token'), 'tok-test-123\n');

  const sup = life.track(spawn(process.execPath, [SUPERVISE, '--name', 'dispatch', '--', process.execPath, '-e', 'setInterval(() => {}, 60000)'], {
    cwd: T,
    env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }),
    stdio: 'ignore',
  }));
  const prevSup = process.env.CAPHEOS_SUPERVISOR;
  process.env.CAPHEOS_SUPERVISOR = 'supervise';
  try {
    let first = null;
    for (let i = 0; i < 40 && !first; i++) {
      try { first = JSON.parse(fs.readFileSync(pidfile, 'utf8')); } catch (_) { await sleep(50); }
    }
    assert.ok(first && first.childPid > 1);
    const routes = [];
    const route = (method, re, fn) => routes.push({ method, re, fn });
    const co = { ROOT: T, p: (...a) => path.join(T, ...a), config: { name: 'Test Co', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }, localParts: () => ({ date: '2026-11-22', time: '12:00' }) };
    const bad = (msg, code) => { const e = new Error(msg); e.status = code || 400; throw e; };
    require(path.join(REPO, 'console', 'owner-ops.js')).mount(route, { co, run: async () => ({}), runApi: async (tool, args) => ({ tool, args }), bad, owner: () => 'Pat', tool: () => ({}) });

    const dispRoute = routes.find(r => r.method === 'POST' && r.re.test('/api/ops/restart/dispatch'));
    assert.ok(dispRoute, 'POST /api/ops/restart/dispatch mounted');
    const res = await dispRoute.fn([], new URLSearchParams(), { why: 'test restart' });
    assert.equal(res.ok, true);
    assert.equal(res.restarted, true);
    assert.equal(res.via, 'supervise');

    let second = null;
    for (let i = 0; i < 60; i++) {
      try {
        const cur = JSON.parse(fs.readFileSync(pidfile, 'utf8'));
        if (cur && cur.childPid && cur.childPid !== first.childPid) { second = cur; break; }
      } catch (_) {}
      await sleep(50);
    }
    assert.ok(second, 'supervised dispatcher restarted via POST /api/ops/restart/dispatch');

    const baseRoute = routes.find(r => r.method === 'POST' && r.re.test('/api/ops/baseline'));
    assert.ok(baseRoute, 'POST /api/ops/baseline mounted');
    const sha40 = 'a'.repeat(40);
    const bres = await baseRoute.fn([], new URLSearchParams(), { sha: sha40 });
    assert.equal(bres.ok, true);
    assert.equal(bres.tool, 'capheos-merge.js');
    assert.deepEqual(bres.args, ['baseline', '--by', 'Pat', '--sha', sha40]);
  } finally {
    if (prevSup === undefined) delete process.env.CAPHEOS_SUPERVISOR; else process.env.CAPHEOS_SUPERVISOR = prevSup;
    try { sup.kill('SIGTERM'); } catch (_) {}
    await sleep(200);
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('framework-update.js: detects needsDispatchRestart and runs dispatcher restart hook on apply', () => {
  const T = life.tmpDir('fu-disp-');
  const prevEnv = Object.assign({}, process.env);
  try {
    const U = path.join(T, 'upstream'), I = path.join(T, 'company');
    const G = (cwd, ...a) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-C', cwd, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const W = (root, f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    W(U, 'company/company.json', '{"name":"T","owner":{"name":"Pat"}}\n');
    W(U, 'company/tools/dispatch.js', '// v1\n');
    W(U, 'scripts/instance-guard.sh', fs.readFileSync(path.join(REPO, 'scripts', 'instance-guard.sh')));
    W(U, '.gitignore', 'company/work/\ncompany/state/\n');
    G(U, 'init', '-q'); G(U, 'add', '-A'); G(U, 'commit', '-qm', 'init');
    spawnSync('git', ['clone', '-q', U, I]);
    W(I, 'company/work/.founded', 'x\n');
    spawnSync('bash', [path.join(I, 'scripts', 'instance-guard.sh')], { cwd: I });

    W(U, 'company/tools/dispatch.js', '// v2\n');
    G(U, 'add', '-A'); G(U, 'commit', '-qm', 'update dispatch');
    const upHead = G(U, 'rev-parse', 'HEAD');

    const FU = require(path.join(REPO, 'company', 'tools', 'framework-update.js'));
    const c = FU.check({ root: I });
    assert.equal(c.needsDispatchRestart, true);
    const dmark = path.join(T, 'dispatch-restarted');
    process.env.FRAMEWORK_UPDATE_DISPATCH_RESTART = 'touch ' + JSON.stringify(dmark);
    const res = FU.apply({ root: I, by: 'owner', expect: upHead, ownerRefusal: () => null, noBackup: true });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.needsDispatchRestart, true);
    assert.equal(fs.existsSync(dmark), true, 'dispatcher restart hook ran');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    fs.rmSync(T, { recursive: true, force: true });
  }
});

/* ---------------- hardening: pidfile trust, grant binding, console start ---------------- */
const crypto = require('crypto');
const PC = require('../lib/proc-check.js');
const prov = require('../provenance.js');
const mkRoot = prefix => {
  const T = life.tmpDir(prefix);
  fs.mkdirSync(path.join(T, 'company', 'state', 'supervise'), { recursive: true });
  fs.mkdirSync(path.join(T, 'company', 'state', 'owner-ops'), { recursive: true });
  fs.mkdirSync(path.join(T, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(T, 'console'), { recursive: true });
  fs.mkdirSync(path.join(T, 'company', 'tools', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'company', 'tools', 'lib', 'host.js'), path.join(T, 'company', 'tools', 'lib', 'host.js'));
  fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }));
  fs.writeFileSync(path.join(T, 'secrets', 'console-token'), 'tok-test-123\n');
  return T;
};
const mountOps = T => {
  const routes = [];
  const co = { ROOT: T, p: (...a) => path.join(T, ...a), config: { name: 'Test Co', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }, localParts: () => ({ date: '2026-11-22', time: '12:00' }) };
  const bad = (msg, code) => { const e = new Error(msg); e.status = code || 400; throw e; };
  require(path.join(REPO, 'console', 'owner-ops.js')).mount((method, re, fn) => routes.push({ method, re, fn }), { co, run: async () => ({}), runApi: async () => ({}), bad, owner: () => 'Pat', tool: () => ({}) });
  return routes;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

test('a stale pidfile whose pid is a live unrelated process is not signalled', async () => {
  const T = mkRoot('ops-stale-');
  const other = life.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' }));
  const prevSup = process.env.CAPHEOS_SUPERVISOR;
  process.env.CAPHEOS_SUPERVISOR = 'supervise';
  try {
    for (const name of ['dispatch', 'station', 'console'])
      fs.writeFileSync(path.join(T, 'company', 'state', 'supervise', name + '.pid'), JSON.stringify({ supervisorPid: other.pid, childPid: other.pid, name }) + '\n');
    fs.writeFileSync(path.join(T, 'company', 'state', 'dispatcher-loop.json'), JSON.stringify({ pid: other.pid }));
    assert.equal(PC.superviseTarget(T, 'dispatch', 'company/tools/dispatcher-loop.js'), null, 'not the supervisor, not the dispatcher: not a target');
    assert.equal(PC.superviseTarget(T, 'station', 'sidecar/index.js'), null);
    const route = mountOps(T).find(r => r.method === 'POST' && r.re.test('/api/ops/restart/dispatch'));
    await assert.rejects(() => route.fn([], new URLSearchParams(), { why: 'test' }), /no systemd user manager and no running supervised dispatcher/);
    await sleep(100);
    assert.equal(alive(other.pid), true, 'the unrelated process was left alone');
    assert.equal(other.exitCode, null);
  } finally {
    if (prevSup === undefined) delete process.env.CAPHEOS_SUPERVISOR; else process.env.CAPHEOS_SUPERVISOR = prevSup;
    try { other.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('owner-job grant: refused from a process that is not the unit\'s main pid or its descendant; console pid recycling fails', async () => {
  const T = mkRoot('ops-grant-');
  const main = life.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' }));
  try {
    await sleep(100);
    const id = 'update-20261122-abcd', unit = 'testco-station-owner-job-' + id + '.service', tok = 'tok-test-123';
    const mk = over => {
      const g = Object.assign({ id, unit, invocationId: 'inv-1', mainPid: main.pid, mainStart: PC.startTicks(main.pid), consolePid: process.pid, consoleStart: PC.startTicks(process.pid), startedAt: new Date().toISOString() }, over);
      g.hmac = crypto.createHmac('sha256', tok).update(prov._internals.grantText(g)).digest('hex');
      return g;
    };
    const base = g => ({ cgroup: '0::/app.slice/' + unit, unit: '/testco-station.service', root: T, readGrant: () => g, readToken: () => tok, readInvocation: () => 'inv-1', readArgv: () => ['/usr/bin/node', path.join(T, 'console', 'server.js')] });
    const V = prov._internals.validOwnerJobGrant;
    assert.equal(V(Object.assign(base(mk()), { pid: main.pid })), true, 'the unit\'s own main pid is accepted');
    assert.equal(V(Object.assign(base(mk()), { pid: process.pid })), false, 'a process outside the unit (this test) is refused');
    assert.equal(V(Object.assign(base(mk()), { pid: main.pid, readInvocation: () => 'inv-2' })), false, 'another invocation of the unit is refused');
    // the console pid was recycled: same number, other start time (signed, so the grant itself is genuine)
    const recycled = mk({ consoleStart: String(Number(PC.startTicks(process.pid)) + 1) });
    assert.equal(V(Object.assign(base(recycled), { pid: main.pid })), false, 'a recycled console pid fails');
    assert.equal(V(Object.assign(base(mk()), { pid: main.pid, readArgv: () => ['/usr/bin/node', '/elsewhere/console/server.js'] })), false, 'another folder\'s console/server.js is not this console');
  } finally {
    try { main.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(T, { recursive: true, force: true });
  }
});

test('console start deletes every leftover owner-job grant', () => {
  const T = mkRoot('ops-clean-');
  try {
    const dir = path.join(T, 'company', 'state', 'owner-ops');
    for (const f of ['a.grant', 'b.grant', 'c.grant.tmp']) fs.writeFileSync(path.join(dir, f), '{}\n');
    fs.writeFileSync(path.join(dir, 'a.log'), 'keep\n');
    mountOps(T);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.log']);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
