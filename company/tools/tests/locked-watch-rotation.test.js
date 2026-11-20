#!/usr/bin/env node
/* locked-watch-rotation.test.js — StarNet rotating its run log (runs.jsonl -> runs.jsonl.1, a new short runs.jsonl) is
 * not a rewrite; a rotation whose .1 does not hold the bytes the last check saw still is.
 *   node --test company/tools/tests/locked-watch-rotation.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { rotatedFrom } = require('../locked-watch.js');
const sha = d => 'sha256:' + crypto.createHash('sha256').update(d).digest('hex');
const CH = 64 * 1024;

test('a rotation that kept the old bytes in .1 is recognised; altered history or no .1 is not', () => {
  const root = require('../lib/temp-life').tmpDir('lw-rot-');
  try {
    const key = '.starnet-data/workspaces/runs.jsonl', f = path.join(root, key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const old = Buffer.from(Array.from({ length: 4000 }, (_, i) => JSON.stringify({ runId: 'r' + i, outcome: 'succeeded' })).join('\n') + '\n');
    const b = { exists: true, lite: true, bytes: old.length, headSha: sha(old.subarray(0, Math.min(CH, old.length))), tailSha: sha(old.subarray(Math.max(0, old.length - CH))) };
    const ctx = { root };
    fs.writeFileSync(f + '.1', Buffer.concat([old, Buffer.from('{"runId":"later"}\n')]));
    fs.writeFileSync(f, '{"runId":"new"}\n');
    const cur = { exists: true, bytes: fs.statSync(f).size };
    assert.equal(rotatedFrom(ctx, key, cur, b), true, 'rotated: .1 starts with what was seen');
    const bad = Buffer.from(old); bad[old.length - 10] = 0x41;
    fs.writeFileSync(f + '.1', bad);
    assert.equal(rotatedFrom(ctx, key, cur, b), false, 'a record changed before the rotation is still a rewrite');
    fs.unlinkSync(f + '.1');
    assert.equal(rotatedFrom(ctx, key, cur, b), false, 'shorter with no .1: a rewrite');
    assert.equal(rotatedFrom(ctx, key, { exists: true, bytes: old.length + 5 }, b), false, 'longer is the append rule, not this one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
