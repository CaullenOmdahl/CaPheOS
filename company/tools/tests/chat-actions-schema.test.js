#!/usr/bin/env node
/* chat-actions-schema.test.js — the ```actions block schema and the reply line (console/ui/js/actions-schema.js), no
 * browser: a good block, malformed ones, the link allowlist, a secret never in a reply, replay state (answered,
 * superseded, stale), and the agent's context note (console/chat.js). The rendering is tests/chat-actions-walk.js.
 *   node --test company/tools/tests/chat-actions-schema.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const S = require(path.resolve(__dirname, '..', '..', '..', 'console', 'ui', 'js', 'actions-schema.js'));
const block = o => S.parseActions(JSON.stringify(o));

test('a good block is rebuilt from known keys only', () => {
  const r = block({ id: 'launch', prompt: 'How?', items: [{ type: 'button', label: 'Go', value: 'go', tone: 'primary', run: 'rm -rf /', tool: 'code.run' },
    { type: 'choice', id: 'region', label: 'Region', options: ['eu', { id: 'us', label: 'US', recommended: true }] }, { type: 'slider', id: 's', label: 'Share', min: 0, max: 100, value: 140, unit: '%' },
    { type: 'url', id: 'u', label: 'Site' }, { type: 'link', label: 'Budget', href: 'console:#/spend' }] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.block.items[0], { type: 'button', label: 'Go', value: 'go', tone: 'primary' });
  assert.equal(r.block.items[2].value, 100, 'a suggested value is clamped into range');
  assert.ok(!JSON.stringify(r.block).includes('rm -rf'));
});
test('malformed blocks are refused with a reason', () => {
  for (const [o, re] of [['{nope', /not JSON/], [{ items: [] }, /id/], [{ id: 'a', items: [] }, /1 to 12/], [{ id: 'a', items: [{ type: 'exec', label: 'x' }] }, /type must be/],
    [{ id: 'a', items: [{ type: 'approve', label: 'x' }] }, /type must be/], [{ id: 'a', items: [{ type: 'choice', id: 'c', label: 'C', options: ['one'] }] }, /2 to 12/],
    [{ id: 'a', items: [{ type: 'secret', id: 'k', label: 'K', name: 'station-token' }] }, /secrets/], [{ id: 'a', items: [{ type: 'secret', id: 'k', label: 'K', name: '../x' }] }, /secrets/],
    [{ id: 'a', items: [{ type: 'secret', id: 'k', label: 'K', name: 'k' }, { type: 'button', label: 'B', value: 1 }] }, /block of its own/],
    [{ id: 'a', items: [{ type: 'approval', ref: 'q-1' }, { type: 'button', label: 'Approve', value: 'yes' }] }, /block of their own/], [{ id: 'a', items: [{ type: 'approval', ref: 'anything' }] }, /ref/]]) {
    const r = typeof o === 'string' ? S.parseActions(o) : block(o);
    assert.equal(r.ok, false, JSON.stringify(o)); assert.match(r.error, re);
  }
});
test('link allowlist: console and https kept, any other scheme keeps only its label', () => {
  const r = block({ id: 'l', items: [{ type: 'link', label: 'A', href: 'console:#/today' }, { type: 'link', label: 'B', href: 'https://example.org/x' }, { type: 'link', label: 'C', href: 'javascript:alert(1)' }, { type: 'link', label: 'D', href: 'data:text/html,x' }, { type: 'link', label: 'E', href: 'http://plain.example' }] });
  assert.deepEqual(r.block.items.map(i => i.href), ['console:#/today', 'https://example.org/x', null, null, 'http://plain.example']);
});
test('a reply: visible words and the machine line; a secret reply carries only where and how long', () => {
  const b = block({ id: 'p', items: [{ type: 'button', label: 'Ship', value: 'ship' }, { type: 'slider', id: 'share', label: 'Share', min: 0, max: 100, unit: '%' }] }).block;
  const r = S.replyFor(b, { button: b.items[0], fields: { share: 80 } });
  assert.equal(r.text, 'Chose: Ship · Share 80%\n[actionReply {"id":"p","value":"ship","fields":{"share":80}}]');
  assert.deepEqual(S.parseActionReply(r.text), { reply: { id: 'p', value: 'ship', fields: { share: 80 } }, shown: 'Chose: Ship · Share 80%' });
  assert.equal(S.stripReplyLine(r.text), 'Chose: Ship · Share 80%');
  const k = block({ id: 'k', items: [{ type: 'secret', id: 'key', label: 'Key', name: 'feed-key' }] }).block;
  const s = S.replyFor(k, { stored: { name: 'feed-key', chars: 40 }, fields: { key: 'sk-should-never-appear' } });
  assert.equal(s.text, 'Stored feed-key (40 chars)\n[actionReply {"id":"k","stored":{"name":"feed-key","chars":40}}]');
});
test('replay: answered by a later reply, superseded by a later block with the same id, stale after 24 h', () => {
  const f = o => '```actions\n' + JSON.stringify(o) + '\n```';
  const turns = [{ role: 'assistant', content: f({ id: 'a', items: [{ type: 'button', label: 'X', value: 'x' }] }) },
    { role: 'assistant', content: f({ id: 'b', items: [{ type: 'button', label: 'Y', value: 'y' }] }) },
    { role: 'assistant', content: f({ id: 'b', items: [{ type: 'button', label: 'Y2', value: 'y2' }] }) },
    { role: 'user', content: 'Chose: X\n[actionReply {"id":"a","value":"x"}]' }];
  const st = S.blockStates(turns);
  assert.equal(st.get(0).get('a').answered.reply.value, 'x');
  assert.equal(st.get(1).get('b').superseded, true); assert.ok(!st.get(2).get('b').superseded);
  assert.equal(S.isStale(new Date(Date.now() - 25 * 3600e3).toISOString()), true); assert.equal(S.isStale(new Date().toISOString()), false);
});
test('console/chat.js: the agent\'s next turn is told the message answers its block', () => {
  const src = require('fs').readFileSync(path.resolve(__dirname, '..', '..', '..', 'console', 'chat.js'), 'utf8');
  assert.match(src, /function actionReplyNote\(text\)/);
  assert.match(src, /contextNote\(id, s, co, text\) \+ text/);
});
