'use strict';
// chat-runs-counts.test.js — console/chat-runs.js keeps a journal line count only while a run is live: 1,000 finished
// chat runs leave its in-memory map empty (it used to keep one entry per run for the life of the console).
//   node --test company/tools/tests/chat-runs-counts.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('assert');
const life = require('../lib/temp-life');
const chatRuns = require('../../../console/chat-runs');

test('1,000 finished runs leave the count map empty; a finished run still counts from its journal', async () => {
  const T = life.tmpDir('chat-runs-counts-');
  const co = { p: (...x) => path.join(T, ...x), STATION_URL: 'http://127.0.0.1:1', stationToken: () => null };
  const cr = chatRuns({ co, stationGet: async () => null });
  for (let i = 0; i < 1000; i++) {
    const id = 'run-' + i;
    cr.track(id, { seat: 'zoe', streamId: 'console-zoe' });
    cr.ingest(id, 'agent.token', { delta: 'hi' });
    assert.ok(cr._counted() >= 1);
    cr.ingest(id, 'agent.run.end', { reason: 'done', outcome: 'succeeded' });
  }
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(cr.busy().length, 0, 'every run finished');
  assert.strictEqual(cr._counted(), 0, 'no counts kept for finished runs');
  // a finished run's count is read from its journal on demand (and the next finish or attach drops it again)
  const kept = Object.keys(cr._state().runs)[0];
  assert.strictEqual(cr.countOf(kept), cr.lines(kept).length);
  assert.strictEqual(cr._counted(), 1);
  const seen = []; cr.attach(kept, 0, l => seen.push(l.name));
  assert.strictEqual(seen.length, cr.lines(kept).length);
  assert.strictEqual(cr._counted(), 1, 'attaching to a finished run caches nothing');
  life.cleanup();
});
