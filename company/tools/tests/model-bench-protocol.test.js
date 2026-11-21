#!/usr/bin/env node
/* model-bench-protocol.test.js — the model bench's text tool protocol (packs/model-bench/lib/bench.js prompt and the
 * tool loop in runInstance):
 *   - the prompt of a tool task says the conversation is the workspace, never to ask for pasted files, one call per
 *     message, and shows a worked example of the turns;
 *   - a first reply that says it cannot reach the workspace gets one corrective message (a turn of maxTurns);
 *   - a model that refuses again, or never makes a tool call, is failures.protocol and its level NOT PROVEN
 *     ('protocol'), never failed; a protocol level never replaces a measured one in the merged result;
 *   - a compliant model is scored as before.
 * Stub drivers only: no station, no model.
 *
 *   node --test company/tools/tests/model-bench-protocol.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

const REPO = path.join(__dirname, '..', '..', '..');
const UNIT = path.join(REPO, 'packs', 'model-bench');
const B = require(path.join(UNIT, 'lib', 'bench.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const tmpRoot = tag => { const T = require('../lib/temp-life').tmpDir('mb-protocol-' + tag + '-'); roots.push(T); fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true }); return T; };

const REFUSAL = 'I can\'t open the workspace in this turn, so I haven\'t read inbox/latest.md. Paste the contents here, or re-run me in a turn where the workspace tools work.';
const isHint = m => m && m.role === 'user' && /You can: reply with a fenced json tool block such as \{"tool": "list", "path": "\."\}/.test(m.content);
// the oracle stub, except its first `refuse` replies of each instance are the refusal, and after a refusal it complies
// by listing the workspace before it answers (kind 1's oracle answers without a tool call); it counts the hints it gets
function driver(refuse) {
  const o = B.stubDriver('oracle'); const start = o.start.bind(o), turn = o.turn.bind(o);
  o.id = 'acme/model-x'; o.family = 'acme'; o.hints = 0; o.turns = 0;
  o.start = inst => { o.n = 0; start(inst); };
  o.turn = async (messages, x) => {
    o.turns++;
    if (isHint(messages[messages.length - 1])) o.hints++;
    const n = o.n++;
    if (n < refuse) return { text: REFUSAL, tokensIn: 10, tokensOut: 30 };
    if (refuse && n === refuse) return { text: 'Listing first.\n```json\n{"tool": "list", "path": "."}\n```', tokensIn: 10, tokensOut: 20 };
    return turn(messages, x);
  };
  return o;
}
const runLookup = drv => B.run({ unitDir: UNIT, root: tmpRoot('run'), model: 'acme/model-x', kinds: [1], depth: 'standard', driver: drv });

test('the tool prompt says the conversation is the workspace and shows a worked example', () => {
  const t = B.loadTasks(UNIT, { kinds: [9], depth: 'lookup' })[0];
  const p = B.prompt(UNIT, t, B.instantiate(UNIT, t, 0));
  assert.match(p, /This conversation is your workspace/);
  assert.match(p, /Never ask for files to be pasted/);
  assert.match(p, /One call per message/);
  assert.match(p, /harness: Result:/);
  assert.match(p, /\{"tool": "list", "path": "\."\}[\s\S]*\{"tool": "read", "path": "notes\/a\.md"\}[\s\S]*your answer/);
  // a task without tools is unchanged
  const n = B.loadTasks(UNIT, { kinds: [2], depth: 'lookup' })[0];
  assert.doesNotMatch(B.prompt(UNIT, n, B.instantiate(UNIT, n, 0)), /harness/);
  assert.ok(B.PROTOCOL_REFUSAL_RE.test(REFUSAL));
  assert.ok(!B.PROTOCOL_REFUSAL_RE.test('I will list the files first.'));
  for (const t of ['No problem, I will open the files now.', 'The function cannot read files larger than 1MB.', 'I will read the files and share the output here.'])
    assert.ok(!B.PROTOCOL_REFUSAL_RE.test(t), t);
  for (const t of ['I do not have access to the repository.', 'Please paste the file contents here.', 'Could you share the code with me?'])
    assert.ok(B.PROTOCOL_REFUSAL_RE.test(t), t);
});

test('a model that refuses the protocol twice is not proven (protocol), never failed', async () => {
  const d = driver(2);
  const r = await runLookup(d);
  const L = r.result.kinds['1'].levels.standard;
  assert.equal(L.failures.protocol, 6);
  assert.equal(L.failures.unparseable, 0);
  assert.equal(L.notProvenReason, 'protocol');
  assert.equal(L.passRate, null); assert.equal(L.passed, null);
  assert.equal(r.result.kinds['1'].proven, null);
  assert.equal(r.result.complete, false);
  assert.equal(d.hints, 6, 'one corrective message per instance');
  assert.equal(d.turns, 12, 'the second refusal ends the instance');
  // a protocol level never replaces a measured one
  const good = await runLookup(driver(0));
  const m = B.mergeResults(UNIT, good.result, r.result);
  assert.equal(m.result.kinds['1'].levels.standard.passRate, 1);
});

test('a model that refuses once and complies after the corrective message is scored normally', async () => {
  const d = driver(1);
  const r = await runLookup(d);
  const L = r.result.kinds['1'].levels.standard;
  assert.equal(d.hints, 6);
  assert.equal(L.failures.protocol, 0);
  assert.equal(L.notProvenReason, null);
  assert.equal(L.passRate, 1);
  assert.ok(r.records.every(x => x.corrected === true && x.pass));
});

test('a compliant model is unchanged: no corrective message, scored as before', async () => {
  const d = driver(0);
  const r = await runLookup(d);
  const L = r.result.kinds['1'].levels.standard;
  assert.equal(d.hints, 0);
  assert.equal(L.failures.protocol, 0);
  assert.equal(L.passRate, 1);
  assert.equal(r.result.kinds['1'].proven, 'standard');
  assert.ok(r.records.every(x => !x.corrected));
});
