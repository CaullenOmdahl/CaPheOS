#!/usr/bin/env node
/* budget-auto-settle.test.js — a run cut off before it settled, on an unmetered provider (a subscription), is booked at
 * $0 by the dispatcher's snapshot; a metered one is left for the owner (budget.js settle --usd).
 *
 * 2026-11-20: a reboot cut off one Haiku run (claude-cli, a subscription). With a daily cap on, the station then refused
 * every run (spend_history_unavailable) until the owner's session ran `budget.js settle`. Nothing in it was a decision.
 *
 *   node --test company/tools/tests/budget-auto-settle.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const B = require('../budget.js');

test('snapshot books a cut-off subscription run at $0 and leaves a metered one for the owner', async () => {
  const dir = require('../lib/temp-life').tmpDir('budget-auto-settle-');
  const saved = Object.assign({}, B.F);
  B.F.budget = () => path.join(dir, 'dispatch-budget.json');
  B.F.snapshot = () => path.join(dir, 'station-caps.json');
  B.F.log = () => path.join(dir, 'budget-apply.jsonl');
  fs.writeFileSync(B.F.budget(), JSON.stringify({ unmeteredProviders: ['claude-cli'] }));
  let unsettled = [
    { runId: 'r-sub', agentId: 'a', ts: 1, provider: 'claude-cli', model: 'haiku' },
    { runId: 'r-paid', agentId: 'b', ts: 2, provider: 'openrouter', model: 'x' },
  ];
  const posts = [];
  const call = async (m, p, body) => {
    if (m === 'POST' && p === '/api/budget/settle') { posts.push(body); unsettled = unsettled.filter(u => u.runId !== body.runId); return { status: 200, body: '{}' }; }
    if (m === 'GET' && p === '/api/budget/status') return { status: 200, body: JSON.stringify({ caps: { perDay: 5, perAgent: 0 }, accounting: { complete: !unsettled.length }, unsettled }) };
    return { status: 404, body: '{}' };
  };
  try {
    const doc = await B.snapshot({ call, jobs: [] });
    assert.deepEqual(posts, [{ runId: 'r-sub', usd: 0 }], 'only the subscription run is booked, at $0');
    assert.deepEqual(doc.spendHistory.unsettled.map(u => u.runId), ['r-paid'], 'the snapshot shows what is still unsettled');
    const log = fs.readFileSync(B.F.log(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(log.length, 1); assert.equal(log[0].settled, 'r-sub'); assert.equal(log[0].usd, 0); assert.match(log[0].by, /dispatcher/);
    posts.length = 0;
    await B.snapshot({ call, jobs: [], noAutoSettle: true });
    assert.equal(posts.length, 0, 'noAutoSettle books nothing');
  } finally { Object.assign(B.F, saved); fs.rmSync(dir, { recursive: true, force: true }); }
});
