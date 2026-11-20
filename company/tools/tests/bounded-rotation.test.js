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
