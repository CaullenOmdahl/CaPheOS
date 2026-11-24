#!/usr/bin/env node
/* company/patches/tests/0029.test.js — StarNet patch 0029 (claude-cli fail-fast on subscription billing errors).
 *
 *   node company/patches/tests/0029.test.js [--starnet <dir>]
 *
 * Skips cleanly (exit 0) when no StarNet checkout is present.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0029-claude-cli-billing-failfast.diff');
const SC = require('./starnet-copy');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0029.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0029-');
console.log('0029.test.js: ' + applied);

// Stub `claude` binary returning a past-due subscription billing result error.
const stubDir = life.tmpDir('capheos-0029-stub-');
const stubBin = path.join(stubDir, 'claude');
fs.writeFileSync(stubBin, `#!${process.execPath}
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-sonnet-5-5' }));
  console.log(JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead"
  }));
});
`);
fs.chmodSync(stubBin, 0o755);

const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const { makeClaudeCliProvider } = require('./sidecar/providers/claude-cli.js');
  const errorClass = require('./sidecar/providers/errorClass.js');
  const prov = makeClaudeCliProvider({ bin: ${JSON.stringify(stubBin)}, idleMs: 10000, persist: true });
  (async () => {
    let caught = null;
    try {
      for await (const ev of prov.stream({
        model: 'claude-sonnet-5-5',
        runId: 'test-billing-1',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }]
      })) { /* drain */ }
    } catch (e) { caught = e; }
    assert.ok(caught, 'must throw on subscription billing error');
    assert.strictEqual(caught.status, 402, 'status must be 402, got ' + caught.status);
    assert.strictEqual(caught.code, 'billing', 'code must be billing, got ' + caught.code);
    const classify = typeof errorClass === 'function' ? errorClass : (errorClass.classify || errorClass.errorClass);
    if (typeof classify === 'function') {
      const cls = classify(caught);
      assert.strictEqual(cls, 'billing', 'errorClass must classify 402 billing error as billing, got ' + cls);
    }
    console.log('ok   subscription billing error tagged status=402 code=billing (non-retryable)');
  })().catch(e => { console.error(e); process.exit(1); });
`], { cwd: dir, encoding: 'utf8', timeout: 15000 });

if (probe.status !== 0) {
  console.error('FAIL 0029 probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0029.test.js');
