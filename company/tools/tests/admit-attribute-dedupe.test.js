'use strict';
// admit-attribute-dedupe.test.js — lib/admit.js attribute(): a run the recorder wrote twice in runs.jsonl (an interrupted
// run recorded again) is one run. It uses its admit once and is never also reported as door 'schedule', which would page
// the budget-drift duty until the run aged out 24 h later.
//   node --test company/tools/tests/admit-attribute-dedupe.test.js
const test = require('node:test');
const assert = require('assert');
const A = require('../lib/admit');

const at = 1700000000000;
const admits = [
  { id: 'a1', door: 'dispatch', decision: 'allow', kind: 'run', seat: 'sam', at },
  { ref: 'a1', outcome: 'started', runId: 'R1' },
];
const run = { runId: 'R1', agentId: 'sam', startedAt: at + 1000, cronJobId: 'j-sam' };

test('a runId written twice is one row, keeps its admit, and the later copy wins', () => {
  const out = A.attribute([Object.assign({}, run, { usd: 0 }), { runId: 'OTHER', kind: 'dispatch-delivery', ts: at }, Object.assign({}, run, { usd: 0.42, reason: 'interrupted' })], admits);
  assert.deepStrictEqual(out.map(r => r.runId), ['R1'], 'one row per run');
  assert.deepStrictEqual(out.map(r => r.door), ['dispatch'], 'never also door schedule');
  assert.strictEqual(out[0].usd, 0.42, 'the last row in file order is kept');
});

test('two distinct runs with one admit: the second is still the schedule', () => {
  const out = A.attribute([run, { runId: 'R2', agentId: 'sam', startedAt: at + 2000, cronJobId: 'j-sam' }], admits);
  assert.deepStrictEqual(out.map(r => r.door), ['dispatch', 'schedule']);
});
