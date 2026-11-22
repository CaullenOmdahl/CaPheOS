#!/usr/bin/env node
/* company/patches/tests/0025.test.js — StarNet patch 0025 (STARNET_SLIM_AUTONOMOUS_TOOLS=1 shrinks Turn-1 advertised
 * core tools on autonomous runs while keeping all tools granted and discoverable via tool.search).
 *
 *   node company/patches/tests/0025.test.js [--starnet <dir>]
 */
'use strict';
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0025-slim-autonomous-tools.diff');
const SC = require('./starnet-copy');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0025.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0025-');
console.log('0025.test.js: ' + applied);

const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const { projectTools } = require('./sidecar/capability/project-tools.js');
  const registry = { get: name => ({ name, scope: 'read', impact: 'low' }), wireFormat: x => x };
  const authority = { project: () => true };
  const baseArgs = () => [
    { id: 'eng' },
    { surface: 'autonomous', trigger: 'cron', isTask: true, extraObjects: [{ instanceId: 'wb1', objectType: 'workbench' }] },
    { lead: true },
    { registry, authority, unrestrictedHost: true }
  ];

  delete process.env.STARNET_SLIM_AUTONOMOUS_TOOLS;
  const full = projectTools(...baseArgs());

  process.env.STARNET_SLIM_AUTONOMOUS_TOOLS = '1';
  const slim = projectTools(...baseArgs());

  assert.strictEqual(slim.resolved.tools.length, full.resolved.tools.length, 'all granted tools stay granted');
  assert.ok(full.advertised.length >= 60, 'baseline full autonomous advertised should be >=60, got ' + full.advertised.length);
  assert.ok(slim.advertised.length <= 25, 'slim autonomous advertised should be <=25, got ' + slim.advertised.length);
  assert.ok(slim.advertised.includes('tool.search'), 'tool.search stays advertised');
  assert.ok(slim.advertised.includes('shell.exec') && slim.advertised.includes('fs.read'), 'core shell/fs stay advertised');
  assert.ok(!slim.advertised.includes('spotify_search') && slim.deferredWire.includes('spotify_search'), 'spotify deferred, not advertised');
  assert.ok(!slim.advertised.includes('image_generate') && slim.deferredWire.includes('image_generate'), 'studio deferred, not advertised');

  // Interactive surface unaffected
  const inter = projectTools({ id: 'eng' }, { surface: 'interactive', trigger: 'directive', isTask: true, extraObjects: [{ instanceId: 'wb1', objectType: 'workbench' }, { instanceId: 'st1', objectType: 'studio' }] }, {}, { registry, authority, unrestrictedHost: true });
  assert.ok(inter.advertised.includes('image_generate'), 'interactive surface keeps studio advertised');
  console.log('ok   advertised tools reduced from ' + full.advertised.length + ' -> ' + slim.advertised.length + ' (all ' + slim.resolved.tools.length + ' granted)');
`], { cwd: dir, encoding: 'utf8' });

if (probe.status !== 0) {
  console.error('FAIL 0025 probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0025.test.js');
