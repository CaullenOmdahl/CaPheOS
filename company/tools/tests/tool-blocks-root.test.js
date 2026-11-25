'use strict';
// Regression test for #64: rootOfInbox() must not escape flat TMPDIR fixtures
// under <company>/.starnet-data/tmp/<run>/ into <company>/company/state/tool-blocks.jsonl.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const life = require('../lib/temp-life');
const TB = require('../lib/tool-blocks');

test('real <company>/company/work/handoffs/<inbox> resolves to <company> ledger', () => {
  const company = life.tmpDir('tb-root-real-');
  const inbox = path.join(company, 'company', 'work', 'handoffs', 'to-alex.md');
  TB.append(inbox, '\n## 2026-11-25 from Dispatcher — real handoff\n**Status:** OPEN\n');
  const ledger = path.join(company, 'company', 'state', 'tool-blocks.jsonl');
  assert.ok(fs.existsSync(ledger), 'company ledger created');
  assert.match(fs.readFileSync(ledger, 'utf8'), /to-alex\.md/);
});

test('flat temp inbox under <company>/.starnet-data/tmp/<run>/ does not escape into ancestor company ledger', () => {
  const company = life.tmpDir('tb-root-escape-');
  const flatDir = path.join(company, '.starnet-data', 'tmp', 'selftest-run-1');
  fs.mkdirSync(flatDir, { recursive: true });
  const inbox = path.join(flatDir, 'to-taylor.md');
  TB.append(inbox, '\n## 2026-11-25 from Dispatcher — fixture handoff\n**Status:** OPEN\n');
  const ancestorLedger = path.join(company, 'company', 'state', 'tool-blocks.jsonl');
  assert.equal(fs.existsSync(ancestorLedger), false, 'ancestor company ledger must not be created');
  const localLedger = path.join(flatDir, 'company', 'state', 'tool-blocks.jsonl');
  assert.ok(fs.existsSync(localLedger), 'ledger stays isolated inside the flat temp dir');
});

test('competence.js selftest with TMPDIR=<company>/.starnet-data/tmp leaves <company> ledger untouched', () => {
  const company = life.tmpDir('tb-root-competence-');
  const tmp = path.join(company, '.starnet-data', 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync(process.execPath, [path.join(__dirname, '..', 'competence.js'), 'selftest'], {
    env: Object.assign({}, process.env, { TMPDIR: tmp }),
    stdio: 'pipe',
  });
  const ancestorLedger = path.join(company, 'company', 'state', 'tool-blocks.jsonl');
  assert.equal(fs.existsSync(ancestorLedger), false, 'competence selftest must not write into ancestor company ledger');
});
