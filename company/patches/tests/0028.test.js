#!/usr/bin/env node
/* 0028.test.js — verifies patch 0028 rejects previously persisted forbidden workTrees in readScopeSaved().
 * Skips cleanly when CAPHEOS_STARNET_SRC is absent. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const R0026 = path.join(REPO, 'company', 'patches', '0026-checkpoint-root-guard.diff');
const R0028 = path.join(REPO, 'company', 'patches', '0028-checkpoint-saved-scope-guard.diff');
const SC = require('./starnet-copy');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));

(async () => {
  const src = SC.findSource();
  if (!src) { console.log('SKIP 0028.test.js: no StarNet checkout'); process.exit(0); }
  const has0026 = fs.readFileSync(path.join(src, 'sidecar', 'checkpoint-store.js'), 'utf8').includes('isForbiddenWorkTree');
  const { dir, applied } = SC.prepare(src, has0026 ? R0028 : [R0026, R0028], 'capheos-0028-');
  console.log('0028.test.js: ' + applied);
  const T = life.tmpDir('cp0028-');
  try {
    const { makeCheckpointStore } = require(path.join(dir, 'sidecar', 'checkpoint-store.js'));
    const scopeId = '8a5edab282632443219e051e';
    const scopeDir = path.join(T, '.checkpoints', 'agent', 'roots', scopeId);
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.writeFileSync(path.join(scopeDir, 'scope.json'), JSON.stringify({ version: 1, scopeId, workTree: '/' }));
    const indexDir = path.join(T, '.checkpoints', 'agent');
    fs.writeFileSync(path.join(indexDir, 'index.json'), JSON.stringify({ version: 1, snapshots: [{ id: scopeId + ':s1', scopeId, runId: 'r1', turn: 1 }] }));
    let gitCalled = 0;
    const store = makeCheckpointStore({
      fs,
      pathMod: path,
      root: T,
      allowWorkTree: () => true,
      scopeIdOf: () => scopeId,
      runGit: async () => { gitCalled++; return { code: 0, stdout: '', stderr: '' }; },
    });
    const res = await store.restoreDetailed('agent', scopeId + ':s1');
    assert.equal(res && res.ok, false, 'previously saved "/" scope must be rejected');
    assert.equal(gitCalled, 0, 'git must never be invoked on a forbidden saved scope');
    console.log('ok   saved "/" scope rejected without invoking git');
    console.log('PASS 0028.test.js');
  } finally {
    fs.rmSync(T, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
