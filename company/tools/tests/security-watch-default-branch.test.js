'use strict';
// security-watch.js reads a project clone at its default branch: a clone left on an old feature branch, with scratch
// copies in its working tree, must not report what the default branch has already fixed.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const life = require('../lib/temp-life.js');
const SW = require('../security-watch.js');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main'].concat(a), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const goSum = v => 'golang.org/x/net v' + v + ' h1:abc=\ngolang.org/x/net v' + v + '/go.mod h1:def=\n';

function clone() {
  const base = life.tmpDir('secwatch-ref-');
  const origin = path.join(base, 'origin.git'), work = path.join(base, 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
  fs.mkdirSync(path.join(work, 'apps', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(work, 'apps', 'agents', 'go.sum'), goSum('0.17.0'));
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'old'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'checkout', '-q', '-b', 'feature/old');               // the crew's old branch keeps the old pin
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'apps', 'agents', 'go.sum'), goSum('0.62.0'));
  git(work, 'commit', '-q', '-am', 'fix'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  git(work, 'checkout', '-q', 'feature/old');
  fs.mkdirSync(path.join(work, 'scratch', 'wt', 'apps', 'agents'), { recursive: true });   // an untracked scratch copy
  fs.writeFileSync(path.join(work, 'scratch', 'wt', 'apps', 'agents', 'go.sum'), goSum('0.17.0'));
  return work;
}

test('defaultRef finds origin/HEAD; lockFilesAt lists tracked lockfiles only', () => {
  const work = clone();
  assert.strictEqual(SW.defaultRef(work), 'origin/main');
  assert.deepStrictEqual(SW.lockFilesAt(work, 'origin/main', ['go.sum'], 5), ['apps/agents/go.sum']);
  assert.strictEqual(SW.defaultRef(path.join(work, 'apps')), null, 'a folder inside a repo is not that repo');
  life.cleanup();
});

test('a project clone on an old branch is read at its default branch', () => {
  const work = clone();
  const base = path.dirname(work);
  const t = SW.buildFixtureRoot(life.tmpDir('secwatch-co-'), path.join(__dirname, 'fixtures', 'security-watch'));
  const repos = path.join(t.opts.root, 'company', 'repos');
  fs.mkdirSync(repos, { recursive: true });
  fs.renameSync(work, path.join(repos, 'app'));
  Object.assign(t.opts, { projectRemotes: { app: 'https://github.com/example/app.git' } });
  const inv = SW.inventory(SW.ctxOf(t.opts));
  const go = inv.components.filter(x => x.eco === 'Go').map(x => x.where.file.replace(/^.*company\/repos\//, '') + '@' + x.version);
  assert.deepStrictEqual(go, ['app/apps/agents/go.sum@0.62.0']);
  fs.rmSync(base, { recursive: true, force: true }); life.cleanup();
});
