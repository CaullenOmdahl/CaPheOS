#!/usr/bin/env node
/* bounded-rotation.test.js — a time window over a rotated log (runs.jsonl -> runs.jsonl.1) includes the rows in .1.
 *   node --test company/tools/tests/bounded-rotation.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const B = require('../lib/bounded.js');

test('jsonlWindow: a window older than the current file goes on in .1; a window inside it does not read .1', () => {
  const dir = require('../lib/temp-life').tmpDir('bounded-rot-');
  try {
    const f = path.join(dir, 'runs.jsonl'), T = 1795100000000, H = 3600e3;
    const row = (id, t) => JSON.stringify({ runId: id, startedAt: t, ts: t }) + '\n';
    fs.writeFileSync(f + '.1', row('old-a', T - 10 * H) + row('old-b', T - 3 * H) + row('old-c', T - 2 * H));
    fs.writeFileSync(f, row('new-a', T - H) + row('new-b', T));
    const ids = w => w.rows.map(r => r.runId);
    assert.deepEqual(ids(B.jsonlWindow(f, { sinceMs: T - 4 * H, slackMs: 0 })), ['old-b', 'old-c', 'new-a', 'new-b']);
    assert.deepEqual(ids(B.jsonlWindow(f, { sinceMs: T - 30 * 60e3, slackMs: 0 })), ['new-b'], 'a window inside the current file');
    assert.deepEqual(ids(B.jsonlWindow(f, {})), ['new-a', 'new-b'], 'no time window: the current file only, as before');
    fs.unlinkSync(f + '.1');
    assert.deepEqual(ids(B.jsonlWindow(f, { sinceMs: T - 4 * H, slackMs: 0 })), ['new-a', 'new-b'], 'no .1: as before');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('jsonlSeek: seeks into rotated .1 when target predates or borders the active file', () => {
  const dir = require('../lib/temp-life').tmpDir('bounded-seek-rot-');
  try {
    const f = path.join(dir, 'runs.jsonl'), T = 1795100000000, H = 3600e3;
    const pad = 'x'.repeat(2048);
    const row = (id, t) => JSON.stringify({ runId: id, startedAt: t, endedAt: t, pad }) + '\n';
    // .1 holds older runs; active file holds >128KB of newer runs so binary search lands past byte 0 for recent targets
    let oldData = '';
    for (let i = 0; i < 60; i++) oldData += row('old-' + i, T - (100 - i) * H);
    fs.writeFileSync(f + '.1', oldData);
    let newData = '';
    for (let i = 0; i < 120; i++) newData += row('new-' + i, T - 40 * H + i * 600e3);
    fs.writeFileSync(f, newData);

    // Target inside .1 (e.g. T - 70*H) must find old-30
    const rOld = B.jsonlSeek(f, T - 70 * H, { backMs: 30 * 60e3 });
    assert.ok(rOld.some(r => r.runId === 'old-30'), 'finds rotated run old-30 in .1');

    // Target well inside active file (near the end) must not pull .1 rows
    const rNew = B.jsonlSeek(f, T - 40 * H + 110 * 600e3, { backMs: 10 * 60e3 });
    assert.ok(rNew.some(r => r.runId === 'new-110'), 'finds new-110 in active file');
    assert.ok(!rNew.some(r => r.runId.startsWith('old-')), 'does not read .1 when target is well inside active file');

    // noRotated: true skips .1
    const rNoRot = B.jsonlSeek(f, T - 70 * H, { backMs: 30 * 60e3, noRotated: true });
    assert.ok(!rNoRot.some(r => r.runId === 'old-30'), 'noRotated suppresses .1 lookup');

    // Empty active file still falls back to .1
    fs.writeFileSync(f, '');
    const rEmpty = B.jsonlSeek(f, T - 70 * H, { backMs: 30 * 60e3 });
    assert.ok(rEmpty.some(r => r.runId === 'old-30'), 'falls back to .1 when active file is empty');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
