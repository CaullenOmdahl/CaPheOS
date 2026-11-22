'use strict';
/* GitHub Actions is off: the merge tool runs the suite itself on the PR head (lib/local-tests.js), and the staged update
 * is not blocked by the absence of GitHub checks. The runner is stubbed with CAPHEOS_LOCAL_TEST_CMD, never the real suite. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const LT = require(path.join(REPO, 'company', 'tools', 'lib', 'local-tests.js'));

function fixture() {
  const T = life.tmpDir('local-gate-');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', T, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
  g('init', '-q'); fs.writeFileSync(path.join(T, 'marker.txt'), 'x'); g('add', '.'); g('commit', '-q', '-m', 'one');
  return { T, head: g('rev-parse', 'HEAD').stdout.trim(), ev: path.join(T, '..', path.basename(T) + '-ev') };
}

test('no checks + local pass: allowed, run at the head commit, worktree removed, pass cached per sha', () => {
  const { T, head, ev } = fixture();
  try {
    const cmd = 'test -f marker.txt && pwd > ' + JSON.stringify(path.join(T, 'ran-in.txt')) + ' && echo "PASS unit"';
    const r = LT.ensure({ root: T, repo: 'o/r', head, evDir: ev, cmd });
    assert.ok(r.ok, r.reason); assert.equal(r.cached, false);
    assert.equal(r.tests.sha, head); assert.equal(r.tests.passed, true); assert.ok(r.tests.ms >= 0);
    assert.ok(!fs.existsSync(fs.readFileSync(path.join(T, 'ran-in.txt'), 'utf8').trim()), 'worktree removed');
    assert.ok(fs.existsSync(path.join(ev, 'localtests-r-' + head + '.json')));
    const again = LT.ensure({ root: T, repo: 'o/r', head, evDir: ev, cmd: 'exit 1' });
    assert.ok(again.ok && again.cached, 'a retry does not run the suite again');
  } finally { fs.rmSync(ev, { recursive: true, force: true }); }
});

test('no checks + local fail: refused with the failing tail, nothing cached', () => {
  const { T, head, ev } = fixture();
  try {
    const r = LT.ensure({ root: T, repo: 'o/r', head, evDir: ev, cmd: 'echo "FAIL step-x"; echo boom >&2; exit 1' });
    assert.equal(r.ok, false); assert.equal(r.tests.passed, false);
    assert.match(r.reason, /failed \(exit 1\).*boom/);
    assert.ok(!fs.existsSync(ev) || !fs.readdirSync(ev).length);
    assert.equal(LT.ensure({ root: T, repo: 'o/r', head: 'abc', evDir: ev, cmd: 'true' }).ok, false);
  } finally { fs.rmSync(ev, { recursive: true, force: true }); }
});

test('staged update: no GitHub checks is not a CI block; pending or failed checks still are', () => {
  const SU = require(path.join(REPO, 'company', 'tools', 'staged-update.js'));
  const t = 'a'.repeat(40);
  assert.equal(SU.ciWhy({ runs: 0, green: false, pending: [], failed: [] }, t), null);
  assert.equal(SU.ciWhy({ runs: 2, green: true, pending: [], failed: [] }, t), null);
  assert.match(SU.ciWhy({ runs: 2, green: false, pending: ['x'], failed: [] }, t), /running: x/);
  assert.match(SU.ciWhy({ runs: 1, green: false, pending: [], failed: ['y:failure'] }, t), /failed: y:failure/);
});
