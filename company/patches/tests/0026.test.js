#!/usr/bin/env node
/* company/patches/tests/0026.test.js — StarNet patch 0026 (checkpoint-store refuses root/system workTrees and
 * honors STARNET_CHECKPOINT_MAX_BYTES).
 *
 *   node company/patches/tests/0026.test.js [--starnet <dir>]
 */
'use strict';
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0026-checkpoint-root-guard.diff');
const SC = require('./starnet-copy');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0026.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0026-');
console.log('0026.test.js: ' + applied);
const wsDir = life.tmpDir('capheos-0026-ws-');

const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const { makeCheckpointStore } = require('./sidecar/checkpoint-store.js');
  const ws = ${JSON.stringify(wsDir)};
  fs.mkdirSync(path.join(ws, 'eng'), { recursive: true });
  process.env.STARNET_CHECKPOINT_MAX_BYTES = String(50 * 1024 * 1024);
  const store = makeCheckpointStore({
    fs, pathMod: path, root: ws,
    runGit: async () => ({ code: 0, stdout: '', stderr: '' }),
    allowWorkTree: () => true,
    scopeIdOf: p => 's' + Buffer.from(p).toString('hex').slice(0, 12)
  });
  (async () => {
    for (const bad of ['/', '/etc', '/opt', '/var/lib', os.homedir()]) {
      const r = await store.snapshot('eng', { workTree: bad, authorizedWorkTree: true, tool: 'shell.exec' });
      assert.strictEqual(r, null, 'must refuse checkpointing forbidden root: ' + bad);
    }
    console.log('ok   forbidden roots (/, /etc, /opt, /var/lib, homedir) all refused');
  })().catch(e => { console.error(e); process.exit(1); });
`], { cwd: dir, encoding: 'utf8' });

if (probe.status !== 0) {
  console.error('FAIL 0026 probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0026.test.js');
