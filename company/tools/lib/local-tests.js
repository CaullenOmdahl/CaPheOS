'use strict';
/* local-tests.js — the merge gate's own test run. GitHub Actions is off, so a pull request with no GitHub checks is
 * tested here: a temporary detached worktree at the exact head commit, `bash scripts/test.sh` inside it, the worktree
 * always removed. A pass is cached per head sha in company/work/evidence/localtests-<repo>-<sha>.json so a retry does
 * not run the suite again.
 *
 *   ensure({ root, repo, head, pr, evDir, cmd?, timeoutMs? })
 *        -> { ok, cached, tests: { sha, passed, steps?, ms }, reason? }     never throws
 * Env: CAPHEOS_LOCAL_TEST_CMD replaces `bash scripts/test.sh` (a shell command run inside the worktree; the selftests use it).
 *      CAPHEOS_LOCAL_TEST_TIMEOUT_MIN (default 45).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const life = require('./temp-life');

const GIT = '/usr/bin/git';
const tail = (s, n) => String(s || '').split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-n);
const git = (root, args, o) => spawnSync(GIT, ['-C', root].concat(args), Object.assign({ encoding: 'utf8', timeout: 120000 }, o || {}));

const evFile = o => path.join(o.evDir, 'localtests-' + String(o.repo).split('/').pop() + '-' + String(o.head) + '.json');
/* the cached pass for a head sha, or null */
function cached(o) {
  try { const c = JSON.parse(fs.readFileSync(evFile(o), 'utf8')); if (c && c.passed && c.sha === o.head) return { ok: true, cached: true, tests: { sha: c.sha, passed: true, steps: c.steps, ms: c.ms } }; } catch (_) {}
  return null;
}

function ensure(o) {
  const t0 = Date.now();
  const sha = String(o.head || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, tests: { sha, passed: false, ms: 0 }, reason: 'need the full head sha to test it' };
  const evf = evFile(o);
  const hit = cached(o); if (hit) return hit;
  const fail = (reason, steps) => ({ ok: false, tests: { sha, passed: false, steps, ms: Date.now() - t0 }, reason });
  let wt = null; let base = null;
  try {
    if (git(o.root, ['cat-file', '-e', sha + '^{commit}']).status !== 0 && o.pr) git(o.root, ['fetch', '-q', 'origin', 'refs/pull/' + o.pr + '/head']);
    if (git(o.root, ['cat-file', '-e', sha + '^{commit}']).status !== 0) return fail('head ' + sha.slice(0, 8) + ' is not in this checkout and could not be fetched');
    base = life.tmpDir('capheos-localtests-');
    wt = path.join(base, 'wt');
    const add = git(o.root, ['worktree', 'add', '--detach', '-q', wt, sha]);
    if (add.status !== 0) return fail('could not make a test worktree: ' + tail(add.stderr, 1)[0]);
    const cmd = o.cmd || process.env.CAPHEOS_LOCAL_TEST_CMD || 'bash scripts/test.sh';
    const env = Object.assign({}, process.env, { TEST_TRACKED_ONLY: '1' });
    for (const k of ['CAPHEOS_ROOT', 'CAPHEOS_MERGE_TOOL_TOKEN']) delete env[k];
    const timeoutMs = o.timeoutMs || (Number(process.env.CAPHEOS_LOCAL_TEST_TIMEOUT_MIN) || 45) * 60e3;
    const r = spawnSync('bash', ['-c', cmd], { cwd: wt, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
    const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const steps = tail(out, 40).filter(l => /^\s*(PASS|FAIL|ok|not ok|✓|✗)/i.test(l)).slice(-12);
    if (r.error && r.error.code === 'ETIMEDOUT') return fail('the suite timed out after ' + Math.round(timeoutMs / 60e3) + ' min', steps);
    if (r.status !== 0) return fail('the suite failed (exit ' + r.status + '): ' + tail(out, 3).join(' | ').slice(0, 400), steps);
    const tests = { sha, passed: true, steps, ms: Date.now() - t0 };
    try { fs.mkdirSync(o.evDir, { recursive: true }); fs.writeFileSync(evf, JSON.stringify(Object.assign({ repo: o.repo, at: new Date().toISOString() }, tests), null, 1) + '\n'); } catch (_) {}
    return { ok: true, cached: false, tests };
  } catch (e) {
    return fail('the local test run broke: ' + e.message);
  } finally {
    if (wt) { git(o.root, ['worktree', 'remove', '--force', wt]); try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {} git(o.root, ['worktree', 'prune']); }
    if (base) try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  }
}

/* the merge tool's rule for a head with no GitHub checks: a cached pass is used; otherwise an agent is told to start the
 * long step apart (StarNet's shell.exec caps a call at 10 minutes) and anyone else runs it inline. -> { ok, reason?, tests } */
function gate(o) {
  const hit = cached(o); if (hit) return hit;
  if (o.agent) return { ok: false, tests: { sha: o.head, passed: false, ms: 0 }, reason: 'no local test pass yet; start `node company/tools/notify-when.js --seat ' + o.by + ' --why "tests for ' + o.repo + ' #' + o.pr + '" -- node company/tools/capheos-merge.js test ' + o.pr + (o.repoOpt ? ' --repo ' + o.repo : '') + '`, then run merge again when it ends' };
  const r = ensure(o);
  return r.ok ? r : Object.assign(r, { reason: 'local tests did not pass: ' + r.reason });
}

module.exports = { ensure, cached, gate };
