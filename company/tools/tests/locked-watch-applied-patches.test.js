'use strict';
// locked-watch.js coveredByApplied(): a StarNet file whose only changes are applied patches is covered, whatever tick the
// patch landed in; one extra edit is not.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const life = require('../lib/temp-life.js');
const LW = require('../locked-watch.js');

function station() {
  const T = life.tmpDir('lw-applied-');
  const sn = path.join(T, 'starnet'), pd = path.join(T, 'patches');
  fs.mkdirSync(path.join(sn, 'sidecar'), { recursive: true }); fs.mkdirSync(pd);
  const g = (...a) => execFileSync('git', ['-C', sn, '-c', 'user.name=t', '-c', 'user.email=t@example.com'].concat(a), { stdio: 'ignore' });
  g('init', '-q');
  fs.writeFileSync(path.join(sn, 'sidecar', 'a.js'), 'one\ntwo\nthree\nfour\nfive\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(pd, '0001-x.diff'), '# 0001 - a test patch\n--- a/sidecar/a.js\n+++ b/sidecar/a.js\n@@ -1,5 +1,5 @@\n one\n-two\n+TWO\n three\n four\n five\n');
  fs.writeFileSync(path.join(pd, '0002-new.diff'), '# 0002 - adds a file\n--- /dev/null\n+++ b/sidecar/b.js\n@@ -0,0 +1 @@\n+new\n');
  for (const n of ['0001-x.diff', '0002-new.diff']) { execFileSync('git', ['-C', sn, 'apply', path.join(pd, n)]); fs.writeFileSync(path.join(pd, n + '.applied'), ''); }
  return { ctx: { paths: { starnet: sn, patches: pd } }, sn };
}

test('only applied patches: covered; a new file a patch created: covered', () => {
  const { ctx } = station();
  assert.strictEqual(LW.coveredByApplied(ctx, 'sidecar/a.js'), true);
  assert.strictEqual(LW.coveredByApplied(ctx, 'sidecar/b.js'), true);
  life.cleanup();
});

test('an edit beyond the patch, or a file no applied patch names: not covered', () => {
  const { ctx, sn } = station();
  fs.appendFileSync(path.join(sn, 'sidecar', 'a.js'), 'six\n');
  assert.strictEqual(LW.coveredByApplied(ctx, 'sidecar/a.js'), false);
  fs.writeFileSync(path.join(sn, 'sidecar', 'c.js'), 'x\n');
  assert.strictEqual(LW.coveredByApplied(ctx, 'sidecar/c.js'), false);
  fs.unlinkSync(path.join(ctx.paths.patches, '0002-new.diff.applied'));
  assert.strictEqual(LW.coveredByApplied(ctx, 'sidecar/b.js'), false, 'a patch without its applied marker covers nothing');
  life.cleanup();
});
