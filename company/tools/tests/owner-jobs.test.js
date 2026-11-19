'use strict';
// owner-jobs.test.js — console/owner-ops.js startJob: a job the owner starts in the console (a framework update, a restart,
// a clean-up) runs as its own transient unit (systemd-run --user), outside the console's cgroup and memory limits, so a
// console restart or the console's MemoryMax never ends it halfway; without systemd it is a detached child. A fake
// systemd-run stands in (CONSOLE_SYSTEMD_RUN): no unit is ever made on this machine's user manager.
//   node --test company/tools/tests/owner-jobs.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('assert');
const life = require('../lib/temp-life');
const OPS = require(path.join(__dirname, '..', '..', '..', 'console', 'owner-ops.js'));
const O = require('../lib/owned');

function setup() {
  const T = life.tmpDir('owner-jobs-selftest-');
  const root = path.join(T, 'co'); fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', station: { serviceName: 'testco-station' } }));
  const argsFile = path.join(T, 'sr-args');
  const sr = path.join(T, 'fake-systemd-run');
  // records its arguments, then runs the command after -- like the unit would: in WorkingDirectory, output appended to the log
  fs.writeFileSync(sr, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > ' + JSON.stringify(argsFile) + '\nlog=; wd=\n'
    + 'while [ $# -gt 0 ]; do case "$1" in --) shift; break;; -p) case "$2" in StandardOutput=append:*) log="${2#StandardOutput=append:}";; WorkingDirectory=*) wd="${2#WorkingDirectory=}";; esac; shift 2;; -E) shift 2;; *) shift;; esac; done\n'
    + '[ -n "$FAKE_SR_FAIL" ] && { echo "Failed to connect to bus" >&2; exit 1; }\n'
    + '( cd "$wd" && exec "$@" ) >>"$log" 2>&1 </dev/null &\nexit 0\n', { mode: 0o755 });
  const routes = [];
  const co = { ROOT: root, p: (...a) => path.join(root, ...a), localParts: () => ({ date: '2026-11-19', time: '12:00' }) };
  const bad = (m, code) => { const e = new Error(m); e.code = code || 400; throw e; };
  const ops = OPS.mount((m, re, fn) => routes.push([m, re, fn]), { co, run: async () => ({}), runApi: async () => ({}), bad, owner: () => 'Robin', tool: () => null });
  return { T, root, ops, sr, argsFile };
}
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
function withEnv(vars, fn) {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('an owner job runs as its own transient unit: oomd never picks it, outside the console\'s limits, no session secret passed', () => withEnv({ CONSOLE_SYSTEMD_RUN: null, CONSOLE_SESSION_SECRET: 'sekrit', CAPHEOS_TEST_RUN: null }, async () => {
  const f = setup();
  process.env.CONSOLE_SYSTEMD_RUN = f.sr;
  let ended = null;
  const meta = f.ops.startJob('update', ['sh', '-c', 'echo updating; exit 3'], { label: 'Framework update', onExit: code => { ended = code; } });
  assert.match(meta.unit, /^testco-station-owner-job-update-\d{14}-[0-9a-f]{4}\.service$/);
  assert.ok(O.ourUnit(O.context({ root: f.root, proc: f.T }), meta.unit), 'lib/owned.js counts the unit as the company\'s');
  const args = fs.readFileSync(f.argsFile, 'utf8').split('\n');
  for (const a of ['--user', '--collect', '--unit=' + meta.unit, 'ManagedOOMPreference=omit', 'OOMPolicy=continue', 'WorkingDirectory=' + f.root]) assert.ok(args.includes(a), a + ' in ' + args.join(' '));
  assert.ok(args.some(a => a === 'StandardOutput=append:' + path.join(f.root, 'company', 'state', 'owner-ops', meta.id + '.log')));
  assert.ok(!args.some(a => /CONSOLE_SESSION_SECRET|sekrit/.test(a)), 'the console\'s session secret is never handed on');
  assert.ok(args.includes('CAPHEOS_ROOT=' + process.env.CAPHEOS_ROOT) || !process.env.CAPHEOS_ROOT);
  assert.ok(await until(() => f.ops.jobOf(meta.id).status !== 'running', 5000), 'it ends');
  const j = f.ops.jobOf(meta.id);
  assert.strictEqual(j.status, 'failed'); assert.strictEqual(j.exit, 3); assert.match(j.output, /updating/);
  assert.ok(await until(() => ended !== null, 6000), 'onExit hears the exit code from the log (the unit is no child of the console)');
  assert.strictEqual(ended, 3);
  life.cleanup();
}));

test('systemd-run not working, no systemd, or a test run without the fake: a detached child, as before', () => withEnv({ CONSOLE_SYSTEMD_RUN: null, CAPHEOS_TEST_RUN: null, FAKE_SR_FAIL: null }, async () => {
  const f = setup();
  process.env.CONSOLE_SYSTEMD_RUN = f.sr; process.env.FAKE_SR_FAIL = '1';
  const a = f.ops.startJob('memory-clean', ['sh', '-c', 'echo cleaned'], {});
  assert.strictEqual(a.unit, null); assert.ok(a.pid > 0);
  assert.ok(await until(() => f.ops.jobOf(a.id).status === 'done', 5000));
  assert.match(f.ops.jobOf(a.id).output, /could not start it as its own unit: Failed to connect to bus.*\n.*cleaned/s);
  delete process.env.CONSOLE_SYSTEMD_RUN; delete process.env.FAKE_SR_FAIL; process.env.CAPHEOS_TEST_RUN = f.T;
  fs.rmSync(f.argsFile, { force: true });
  const b = f.ops.startJob('restart-console', ['sh', '-c', 'echo ok'], {});
  assert.strictEqual(b.unit, null, 'a test run never makes a unit on the machine\'s user manager');
  assert.ok(!fs.existsSync(f.argsFile));
  assert.ok(await until(() => f.ops.jobOf(b.id).status === 'done', 5000));
  life.cleanup();
}));
