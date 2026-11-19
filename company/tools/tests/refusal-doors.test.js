'use strict';
// refusal-doors.test.js — lib/refusal.js and the interview door (hire.js answerTurn). The chat door is
// tests/chat-refusal-test.js, the routine door pacer.test.js, the lane door lanes-dispatch.test.js.
//   node --test company/tools/tests/refusal-doors.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = require('../lib/temp-life').tmpDir('refusal-doors-selftest-');
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
W('company/company.json', { name: 'Refusal Test', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents: { alex: { name: 'Alex', functions: ['ceo'], manager: null }, cand1: { name: 'Robin', manager: 'alex' } } });
W('company/model-policy.json', {
  allowed: { 'claude-cli': { models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }, deepseek: { models: ['deepseek-flash'] }, custom: { models: ['MiniMax-M3.1-Flash'] } },
  seats: { alex: { chain: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }, { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } },
  routing: { models: { sonnet: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, deepseek: { provider: 'deepseek', model: 'deepseek-flash' } } },
  candidateDefault: { provider: 'deepseek', model: 'deepseek-flash' } });
process.env.CAPHEOS_ROOT = T;
const REF = require('../lib/refusal');
const hire = require('../hire.js');
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

test('isRefusal: a refused outcome, content_policy_blocked, a policy error; not an ordinary error or a success', () => {
  assert.ok(REF.isRefusal({ outcome: 'refused' })); assert.ok(REF.isRefusal({ failureCode: 'content_policy_blocked', reason: 'error' }));
  assert.ok(REF.isRefusal({ error: 'the request was blocked by our content policy' }));
  assert.ok(!REF.isRefusal({ reason: 'error', failureCode: 'provider_auth' })); assert.ok(!REF.isRefusal({ reason: 'done', outcome: 'succeeded' }));
});

test('nextEntry: the seat\'s chain after the refused entry, another provider first; null when every entry is tried', () => {
  const opus = { provider: 'claude-cli', model: 'claude-opus-5-5' };
  assert.deepStrictEqual(REF.keyOf(REF.nextEntry('alex', opus, [], { root: T })), 'deepseek/deepseek-flash', 'a filter is a provider\'s: DeepSeek before Claude Sonnet');
  assert.strictEqual(REF.keyOf(REF.nextEntry('alex', opus, ['deepseek/deepseek-flash'], { root: T })), 'claude-cli/claude-sonnet-5-5', 'then the same provider\'s other model');
  assert.strictEqual(REF.nextEntry('alex', opus, ['deepseek/deepseek-flash', 'claude-cli/claude-sonnet-5-5'], { root: T }), null, 'every entry tried: null (report and stop)');
  assert.strictEqual(REF.keyOf(REF.nextEntry('nobody', { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, [], { root: T })), 'deepseek/deepseek-flash', 'no chain: the routing table and candidateDefault');
  assert.strictEqual(REF.plainLine(opus, { provider: 'deepseek' }), 'Claude declined this; DeepSeek answered instead.');
});

test('interview door: a refused turn is asked again once on the next model, the transcript says whose answer it is, and the failover is recorded', async () => {
  const calls = [];
  const run = async (agentId, model, provider) => { calls.push(provider + '/' + model); return provider === 'claude-cli' ? { runId: 'r' + calls.length, text: '', reason: 'refused', outcome: 'refused', failureCode: 'content_policy_blocked', usd: 0 } : { runId: 'r' + calls.length, text: 'My answer.', reason: 'done', usd: 0.01 }; };
  const res = await hire.answerTurn({ agentId: 'cand1', provider: 'claude-cli', model: 'claude-sonnet-5-5' }, [{ role: 'user', content: 'q1' }], 's1', run);
  assert.deepStrictEqual(calls, ['claude-cli/claude-sonnet-5-5', 'deepseek/deepseek-flash']);
  assert.strictEqual(res.text, 'My answer.'); assert.match(res.note, /Claude declined this; DeepSeek answered instead\. This answer is deepseek\/deepseek-flash's, not claude-cli\/claude-sonnet-5-5's\./);
  const mv = fs.readFileSync(path.join(T, 'company/state/model-moves.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
  assert.ok(mv.direction === 'refusal' && mv.door === 'interview' && mv.seat === 'cand1' && mv.to === 'deepseek/deepseek-flash', JSON.stringify(mv));
  // every model refusing: one retry only, and a plain "no answer"
  calls.length = 0;
  const all = await hire.answerTurn({ agentId: 'cand1', provider: 'claude-cli', model: 'claude-sonnet-5-5' }, [], 's2', async (a, model, provider) => { calls.push(provider); return { runId: 'x', outcome: 'refused', text: '' }; });
  assert.strictEqual(calls.length, 2); assert.match(all.text, /no answer: Claude and DeepSeek both declined this question/);
});

test('quota closure: admit() holds a dispatch start on a provider the pacer closed at its usage limit, and lets it run once the closure ends', () => {
  const now = Date.now();
  W('company/state/pacer-state.json', { blocks: [], closures: { minimax: { until: now + 30 * 60e3, why: 'a MiniMax run hit its usage limit' } } });
  assert.ok(REF.closureFor('custom', { root: T, now }), 'MiniMax (custom) is closed');
  assert.strictEqual(REF.closureFor('deepseek', { root: T, now }), null, 'a metered provider has no quota closure');
  const A = require('../lib/admit');
  const held = A.admit({ door: 'dispatch', kind: 'run', seat: 'cand1', jobId: 'j1', provider: 'custom' }, { now, root: T, dry: true });
  assert.strictEqual(held.decision, 'hold'); assert.ok(held.quota && /quota closed/.test(held.reason), JSON.stringify(held));
  const other = A.admit({ door: 'dispatch', kind: 'run', seat: 'cand1', jobId: 'j1', provider: 'deepseek' }, { now, root: T, dry: true });
  assert.strictEqual(other.decision, 'allow', 'another provider is not held');
  const later = A.admit({ door: 'dispatch', kind: 'run', seat: 'cand1', jobId: 'j1', provider: 'custom' }, { now: now + 31 * 60e3, root: T, dry: true });
  assert.strictEqual(later.decision, 'allow', 'the closure has ended');
});

test('no model can run: admit() holds a dispatch start while models.js says nothing in the seat\'s chain can run; fresh state only', () => {
  const now = Date.now(); const A = require('../lib/admit');
  W('company/state/pacer-state.json', { blocks: [], closures: {} });
  W('company/state/models-state.json', { v: 1, seats: { cand1: { nothingKey: 'the pacer has Claude closed|metered: the station\'s daily spend rail is at 96% (holds from 85%)' }, alex: { nothingKey: '' } } });
  const held = A.admit({ door: 'dispatch', kind: 'run', seat: 'cand1', jobId: 'j1', provider: 'deepseek' }, { now, root: T, dry: true });
  assert.strictEqual(held.decision, 'hold'); assert.ok(held.noModel && /no model can run/.test(held.reason), JSON.stringify(held));
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 'alex', jobId: 'j2', provider: 'deepseek' }, { now, root: T, dry: true }).decision, 'allow', 'a seat with a runnable entry starts');
  assert.strictEqual(A.admit({ door: 'chat', kind: 'run', seat: 'cand1' }, { now, root: T, dry: true }).decision, 'allow', 'the owner\'s chat is never held here');
  const old = new Date(now - 20 * 60e3); fs.utimesSync(path.join(T, 'company/state/models-state.json'), old, old);
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 'cand1', jobId: 'j1', provider: 'deepseek' }, { now, root: T, dry: true }).decision, 'allow', 'a stale models state fails open');
});
