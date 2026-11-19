#!/usr/bin/env node
/* locked-watch-patch-cover.test.js — a StarNet file changed by a recorded patch is covered whether the record is a
 * `git diff` (diff --git a/x b/x) or a plain diff (--- a/x at the end of the line). 2026-11-20: a plain-diff record's
 * three files were flagged to the risk seat as unrecorded changes.
 *   node --test company/tools/tests/locked-watch-patch-cover.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { patchCovers } = require('../locked-watch.js');

test('git-diff and plain-diff records both cover their files; a longer path or another file is not covered', () => {
  const plain = '# 00xx — header\n--- a/sidecar/environment.js\n+++ b/sidecar/environment.js\n@@ -1 +1 @@\n-a\n+b\n';
  const gitd = 'diff --git a/sidecar/tools/builtin/shell.js b/sidecar/tools/builtin/shell.js\nindex 1..2 100644\n';
  assert.equal(patchCovers(plain, 'sidecar/environment.js'), true);
  assert.equal(patchCovers(gitd, 'sidecar/tools/builtin/shell.js'), true);
  assert.equal(patchCovers(plain, 'sidecar/environment'), false);
  assert.equal(patchCovers(plain, 'sidecar/env.js'), false);
  assert.equal(patchCovers(plain + gitd, 'sidecar/other.js'), false);
  assert.equal(patchCovers('', 'sidecar/environment.js'), false);
});
