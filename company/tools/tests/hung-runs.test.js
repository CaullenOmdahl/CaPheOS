#!/usr/bin/env node
/* hung-runs.test.js — a run silent for an hour is stopped; a busy run, a young run and the owner's chat never are.
 *   node --test company/tools/tests/hung-runs.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const H = require('../hung-runs.js');
const MIN = 60000, NOW = Date.parse('2026-11-20T00:00:00Z');

test('judge: silent past the limit is hung; recent activity, a young run and the owner\'s chat are not', () => {
  const runs = [
    { runId: 'dead', agentId: 'a', source: 'cron', startedAt: NOW - 74 * MIN },
    { runId: 'busy', agentId: 'b', source: 'cron', startedAt: NOW - 90 * MIN },
    { runId: 'young', agentId: 'c', source: 'cron', startedAt: NOW - 30 * MIN },
    { runId: 'chat', agentId: 'd', source: 'interactive', startedAt: NOW - 300 * MIN },
    { runId: 'never', agentId: 'e', source: 'cron', startedAt: NOW - 61 * MIN },
  ];
  const act = { dead: NOW - 60 * MIN - 1, busy: NOW - 2 * MIN };
  assert.deepEqual(H.judge(runs, act, NOW).map(h => h.runId), ['dead', 'never']);
  assert.equal(H.judge(runs, act, NOW).find(h => h.runId === 'dead').silentMin, 60);
  assert.deepEqual(H.judge(runs, act, NOW, 120).map(h => h.runId), []);
});

test('lastActivity: the newest row per run id, from the newest segments', () => {
  const root = require('../lib/temp-life').tmpDir('hung-runs-');
  try {
    const d = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2'); fs.mkdirSync(d, { recursive: true });
    const row = (id, ts) => JSON.stringify({ agentId: 'x', role: 'tool', content: 'ok', ts, sourceRunId: id }) + '\n';
    fs.writeFileSync(path.join(d, 'segment-000001.jsonl'), row('r1', 1795100000000) + row('r2', 1795100000500));
    fs.writeFileSync(path.join(d, 'segment-000002.jsonl'), row('r1', 1795100009000) + row('other', 1795100009999));
    assert.deepEqual(H.lastActivity(root, ['r1', 'r2', 'r3']), { r1: 1795100009000, r2: 1795100000500 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tick: stops a hung run through the station, logs it, and leaves the rest', async () => {
  const root = require('../lib/temp-life').tmpDir('hung-runs-tick-');
  const saved = Object.assign({}, H.S), calls = [], lines = [];
  try {
    H.S.now = () => NOW;
    H.S.call = async (m, p, b) => {
      calls.push(m + ' ' + p + (b ? ' ' + b.runId : ''));
      if (p === '/api/state/snapshot') return { status: 200, body: JSON.stringify({ runs: [{ runId: 'dead-run-1', agentId: 'a', source: 'cron', startedAt: NOW - 80 * MIN }, { runId: 'fresh', agentId: 'b', source: 'cron', startedAt: NOW - 5 * MIN }] }) };
      if (p === '/api/cancel') return { status: 200, body: JSON.stringify({ ok: true, stopped: true }) };
      return { status: 404, body: '{}' };
    };
    const r = await H.tick({ root, log: l => lines.push(l) });
    assert.deepEqual(r.stopped.map(h => h.runId), ['dead-run-1']);
    assert.ok(calls.includes('POST /api/cancel dead-run-1') && !calls.some(c => /cancel fresh/.test(c)), calls.join('|'));
    assert.ok(lines.some(l => /^HUNG RUN STOPPED: .*wrote nothing for 80 min/.test(l)), lines.join('\n'));
    const dry = []; await H.tick({ root, dry: true, log: l => dry.push(l) });
    assert.equal(calls.filter(c => /cancel/.test(c)).length, 1, 'a dry run stops nothing');
  } finally { Object.assign(H.S, saved); fs.rmSync(root, { recursive: true, force: true }); }
});
