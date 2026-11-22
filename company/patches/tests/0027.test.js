#!/usr/bin/env node
/* company/patches/tests/0027.test.js — StarNet patch 0027 (aux-governor log rate-limiting and STARNET_AUX_TOKEN_CEILING).
 *
 *   node company/patches/tests/0027.test.js [--starnet <dir>]
 */
'use strict';
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0027-aux-governor-ratelimit.diff');
const SC = require('./starnet-copy');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0027.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0027-');
console.log('0027.test.js: ' + applied);

const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const AG = require('./sidecar/auxgovernor.js');

  process.env.STARNET_AUX_TOKEN_CEILING = '500000';
  const g1 = AG.tokenGate({ unmetered: true, used: 300000 });
  assert.strictEqual(g1.ceiling, 500000);
  assert.strictEqual(g1.blocked, false);
  const g2 = AG.tokenGate({ unmetered: true, used: 500000 });
  assert.strictEqual(g2.blocked, true);

  // Explicit ceiling still overrides env
  const g3 = AG.tokenGate({ unmetered: true, ceiling: 100000, used: 150000 });
  assert.strictEqual(g3.ceiling, 100000);
  assert.strictEqual(g3.blocked, true);

  // Rate limiting: logs once, suppresses within 1h, logs again after 1h with suppressed count
  const t0 = 1795000000000;
  assert.deepStrictEqual(AG.shouldLogCeiling('aux:eng', t0, 3600000), { log: true, suppressed: 0 });
  assert.deepStrictEqual(AG.shouldLogCeiling('aux:eng', t0 + 1000, 3600000), { log: false, suppressed: 1 });
  assert.deepStrictEqual(AG.shouldLogCeiling('aux:eng', t0 + 2000, 3600000), { log: false, suppressed: 2 });
  assert.deepStrictEqual(AG.shouldLogCeiling('aux:eng', t0 + 3600001, 3600000), { log: true, suppressed: 2 });
  console.log('ok   STARNET_AUX_TOKEN_CEILING and shouldLogCeiling 1h rate limit verified');
`], { cwd: dir, encoding: 'utf8' });

if (probe.status !== 0) {
  console.error('FAIL 0027 probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0027.test.js');
