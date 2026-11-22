'use strict';
// two Claude models of one seat refused (each a model-only block): the seat summary must keep both, so the chain
// does not show one of them as open while admission holds it (seen live: a CEO seat held 14 h with "can run" shown)
const test = require('node:test'), assert = require('node:assert');
const REF = require('../lib/refusal.js');
const now = Date.UTC(2030, 0, 10, 12);
const blk = (model, untilH) => ({ routineId: 'job-1', name: 'Ops loop', provider: 'claude-cli', model, modelOnly: true, code: 'content_policy_blocked', at: now - 3600e3, until: now + untilH * 3600e3 });
const o = blocks => ({ now, blocks });
test('both refused models stay blocked in the seat summary', () => {
  const b = REF.blockedForSeat(['job-1'], o([blk('sonnet', 6), blk('opus', 10)]))['claude-cli'];
  assert.ok(b && b.byModel, 'summary carries every refused model');
  assert.strictEqual(REF.blocksEntry(b, { provider: 'claude-cli', model: 'sonnet' }), true);
  assert.strictEqual(REF.blocksEntry(b, { provider: 'claude-cli', model: 'opus' }), true);
  assert.strictEqual(REF.blocksEntry(b, { provider: 'claude-cli', model: 'haiku' }), false, 'a model that never refused is open');
});
test('an alias and its full id are one model', () => {
  const b = REF.blockedForSeat(['job-1'], o([blk('sonnet', 6)]))['claude-cli'];
  assert.strictEqual(REF.blocksEntry(b, { provider: 'claude-cli', model: 'claude-sonnet-5-5' }), true);
  assert.ok(REF.blockFor('job-1', 'claude-cli', o([blk('sonnet', 6)]), 'claude-sonnet-5-5'));
  assert.strictEqual(REF.blockFor('job-1', 'claude-cli', o([blk('sonnet', 6)]), 'claude-opus-5-5'), null);
});
test('a provider-wide block still stops every model', () => {
  const wide = Object.assign(blk('opus', 2), { modelOnly: false });
  const b = REF.blockedForSeat(['job-1'], o([wide, blk('sonnet', 6)]))['claude-cli'];
  assert.strictEqual(REF.blocksEntry(b, { provider: 'claude-cli', model: 'haiku' }), true);
});
