#!/usr/bin/env node
/* handoff-index.test.js — compact --open-index, corrupt header detection, and >64KB aggressive DONE archiving.
 *   node --test company/tools/tests/handoff-index.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const cp = require('child_process');
const life = require('../lib/temp-life');
const HS = require('../handoff-status.js');

test('openIndex returns compact line ranges for OPEN items only and headerFindings flags junk before H1', () => {
  const sample = [
    'stray stdout line 1',
    'total replaced: 5',
    '# Handoffs to Alex',
    '',
    '## 2026-11-22 09:00 from Jo — Fix rotation bug',
    '**Priority:** P0',
    '**Deadline:** 2026-11-22 18:00',
    '**Status:** OPEN',
    '',
    '## 2026-11-22 08:00 from Sam — Old finished item',
    '**Status:** DONE',
    '',
    '## 2026-11-22 10:00 from Sam — Review PR',
    '**Deadline:** 2026-11-23',
    '**Status:** OPEN',
  ].join('\n') + '\n';

  const hdr = HS.headerFindings(sample);
  assert.equal(hdr.length, 2);
  assert.equal(hdr[0].line, 1);

  const idx = HS.openIndex(sample, 'company/work/handoffs/to-alex.md');
  assert.equal(idx.length, 2);
  assert.equal(idx[0].startLine, 5);
  assert.equal(idx[0].endLine, 9);
  assert.equal(idx[0].priority, 'P0');
  assert.equal(idx[1].startLine, 13);
  assert.match(idx[1].heading, /Review PR/);
});

test('CLI --open-index --json works on a company fixture and handoff-archive tightens on >64KB inboxes', () => {
  const T = life.tmpDir('handoff-idx-');
  try {
    const dir = path.join(T, 'company', 'work', 'handoffs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'company.json'), '{"name":"T","timezone":"UTC"}');
    const pad = 'x'.repeat(20000);
    const mkDone = (i) => `## 2026-11-22 09:00 from Sam — Done ${i}\n${pad}\n**Status:** DONE\n\n`;
    const body = '# Handoffs to Alex\n\n' + mkDone(1) + mkDone(2) + mkDone(3) + mkDone(4)
      + '## 2026-11-22 10:00 from Jo — Still open\n**Status:** OPEN\n';
    fs.writeFileSync(path.join(dir, 'to-alex.md'), body);

    const r = cp.spawnSync(process.execPath, [path.resolve(__dirname, '..', 'handoff-status.js'), '--open-index', '--file', 'to-alex.md', '--json'],
      { env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const items = JSON.parse(r.stdout);
    assert.equal(items.length, 1);
    assert.match(items[0].heading, /Still open/);

    // At 1 hour after 09:00 (10:00), a >64KB file archives DONE items even though default hours is 3
    const moved = cp.spawnSync(process.execPath, ['-e', `
      process.env.CAPHEOS_ROOT = ${JSON.stringify(T)};
      const HA = require(${JSON.stringify(path.resolve(__dirname, '..', 'handoff-archive.js'))});
      console.log(HA.archiveInbox('to-alex.md', { now: Date.parse('2026-11-22T10:00:00Z') }));
    `], { encoding: 'utf8' });
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(Number(moved.stdout.trim()), 4, 'all 4 DONE blocks >30m old archived on >64KB inbox');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
