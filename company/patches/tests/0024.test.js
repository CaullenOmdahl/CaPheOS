#!/usr/bin/env node
/* company/patches/tests/0024.test.js — StarNet patch 0024 (claude-cli fail-fast on <synthetic> / content_policy_blocked).
 *
 *   node company/patches/tests/0024.test.js [--starnet <dir>]
 *
 * Skips cleanly (exit 0) when no StarNet checkout is present.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0024-claude-cli-refusal-failfast.diff');
const SC = require('./starnet-copy');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0024.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0024-');
console.log('0024.test.js: ' + applied);

// Create a stub `claude` binary that emits an init line, then a <synthetic> safeguard refusal assistant message,
// then sleeps for 60 seconds (never emitting a result line). Patched claude-cli.js MUST fail fast (< 2s) with
// error.code === 'content_policy_blocked' instead of hanging for idle timeout.
const stubDir = life.tmpDir('capheos-0024-stub-');
const stubBin = path.join(stubDir, 'claude');
fs.writeFileSync(stubBin, `#!${process.execPath}
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.once('line', () => {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-opus-5-5' }));
  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: "API Error: safeguards flagged this message (https://www.anthropic.com/legal/aup). Details: [reasoning_extraction]" }]
    }
  }));
  setTimeout(() => {}, 60000);
});
`);
fs.chmodSync(stubBin, 0o755);

const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const { makeClaudeCliProvider } = require('./sidecar/providers/claude-cli.js');
  const prov = makeClaudeCliProvider({ bin: ${JSON.stringify(stubBin)}, idleMs: 30000, persist: true });
  (async () => {
    const t0 = Date.now();
    let caught = null;
    try {
      for await (const ev of prov.stream({
        model: 'claude-opus-5-5',
        runId: 'test-refusal-1',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'noop', description: 'noop', parameters: { type: 'object', properties: {} } }]
      })) { /* drain */ }
    } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    assert.ok(caught, 'must throw on synthetic safeguard refusal');
    assert.strictEqual(caught.code, 'content_policy_blocked', 'error code must be content_policy_blocked, got: ' + caught.code + ' / ' + caught.message);
    assert.strictEqual(caught.status, 400);
    assert.ok(elapsed < 5000, 'must fail fast (<5s), took ' + elapsed + 'ms');
    console.log('ok   synthetic safeguard refusal failed fast in ' + elapsed + 'ms with code=' + caught.code);
  })().catch(e => { console.error(e); process.exit(1); });
`], { cwd: dir, encoding: 'utf8', timeout: 15000 });

if (probe.status !== 0) {
  console.error('FAIL 0024 probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0024.test.js');
