#!/usr/bin/env node
/* owner-gates.test.js — what reaches the owner from a shared-tool change (harness-change.js) and a background service
 * (service.js): only what governance, a fixed owner gate or the localComputer safe profile reserves for them, as ONE plain
 * card through lib/owner-card.js (a contract stand-in here: tests/helpers/owner-stubs.js), never a raw inbox row.
 *   node --test company/tools/tests/owner-gates.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const TOOLS = path.resolve(__dirname, '..');
const HC = require(path.join(TOOLS, 'harness-change.js'));
const SV = require(path.join(TOOLS, 'service.js'));
const stubs = require('./helpers/owner-stubs.js');
const scope = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
const plain = c => ['lead', 'consequence', 'recommendation'].every(k => scope.plainScore(c[k], { approval: true }).ok);

function company(levels) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-gates-'));
  const W = (rel, v) => { fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true }); fs.writeFileSync(path.join(T, rel), typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); };
  W('company/tools/loops.json', { agents: {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' }, people: { name: 'Kwame', manager: 'agent', functions: ['people'], inbox: 'to-kwame.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' }, auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    data: { name: 'Halima', manager: 'agent', inbox: 'to-halima.md' } } });
  const gov = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'defaults', 'state', 'governance.json'), 'utf8'));
  Object.assign(gov.categories, levels || {});
  W('company/state/governance.json', gov);
  fs.copyFileSync(path.join(TOOLS, '..', 'defaults', 'state', 'governance.json'), (fs.mkdirSync(path.join(T, 'company/defaults/state'), { recursive: true }), path.join(T, 'company/defaults/state/governance.json')));
  W('company/tools/competence.js', "'use strict';\nmodule.exports = {};\n");
  fs.mkdirSync(path.join(T, 'company/work/handoffs'), { recursive: true });
  const notice = stubs.makeOwnerNotice(); const card = stubs.makeOwnerCard(T, { notice });
  const C = () => HC.context({ root: T, now: Date.parse('2026-11-18T10:00:00Z'), underStation: true, ownerCard: card, ownerNotice: notice, skipSelftest: true, call: async () => ({ status: 500 }) });
  const asks = () => { try { return fs.readFileSync(path.join(T, 'company/pm-inbox.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.type === 'ask'); } catch (_) { return []; } };
  return { T, W, C, card, notice, asks, done: () => fs.rmSync(T, { recursive: true, force: true }) };
}
const diff = "'use strict';\n// count a report once\nmodule.exports = {};\n";
const withProv = fn => async () => { const prev = process.env.PROVENANCE_ROOT; const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-gates-prov-')); process.env.PROVENANCE_ROOT = T;
  try { await fn(); } finally { if (prev === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prev; fs.rmSync(T, { recursive: true, force: true }); } };

test('a locked tool change at tools=auto is reviewed by the risk and tools seats, never asks the owner, and is one digest line', withProv(async () => {
  const c = company({ tools: 'auto' });
  try {
    const r = await HC.propose(c.C(), { kind: 'tool', target: 'company/tools/competence.js', why: 'count a report only once in the totals', change: diff, by: 'Kwame' });
    assert.deepEqual(r.reviewers.map(x => x.name), ['Riley', 'Max']);
    HC.review(c.C(), r.id, { by: 'Riley' }, 'approve'); HC.review(c.C(), r.id, { by: 'Max' }, 'approve');
    const a = await HC.applyChange(c.C(), r.id, { by: 'Max' });
    assert.equal(a.status, 'applied');
    assert.equal(c.asks().length, 0); assert.equal(c.card.calls.length, 0);
    // a locked tool is something the owner should know about: one plain line in the day's message, never a card
    assert.equal(c.notice.sent.length, 1); assert.equal(c.notice.sent[0].kind, 'fyi');
    assert.equal(c.notice.sent[0].text, 'Kwame changed how the crew\'s work is measured, after two colleagues reviewed it.');
  } finally { c.done(); }
}));

test('at tools=approve: one plain card after the two reviews (diff under technical, effect harnessApply); withdraw closes it', withProv(async () => {
  const c = company({ tools: 'approve' });
  try {
    const r = await HC.propose(c.C(), { kind: 'tool', target: 'company/tools/competence.js', why: 'count a report only once in the totals', change: diff, by: 'Kwame', plain: 'It only changes how a report is counted.' });
    HC.review(c.C(), r.id, { by: 'Riley' }, 'approve'); HC.review(c.C(), r.id, { by: 'Max' }, 'approve');
    await assert.rejects(HC.applyChange(c.C(), r.id, { by: 'Max' }), /waits for the owner/);
    const q = c.asks(); assert.equal(q.length, 1);
    const card = c.card.calls.find(x => x.op === 'file').card;
    assert.equal(card.lead, 'Kwame wants to change how the crew\'s work is measured, and two colleagues reviewed it. It only changes how a report is counted, and it keeps a backup.');
    assert.ok(plain(card)); assert.ok(/count a report once/.test(card.technical)); assert.deepEqual(card.effect, { harnessApply: { id: r.id } });
    HC.withdraw(c.C(), r.id, { by: 'Kwame' });
    assert.equal(c.card.openFor('harness-review:' + r.id), null);
  } finally { c.done(); }
}));

function serviceCtx(c, guardOn) {
  c.W('company/company.json', { name: 'Test Co', slug: 'testco', owner: { name: 'Pat' } });
  c.W('company/work/jobs/report.sh', 'echo 1\n');
  const U = path.join(c.T, 'units'); fs.mkdirSync(U, { recursive: true });
  return SV.context({ root: c.T, unitDir: U, transientDir: path.join(c.T, 'tr'), systemctl: () => ({ code: 0, out: '' }), journal: () => '', isAgent: () => true, ownerShell: () => false,
    guard: n => (n === 'localComputer' ? guardOn : true), halted: () => false, callerConflict: () => null, gov: { root: c.T }, ownerCard: c.card, ownerNotice: c.notice });
}

test('localComputer on: a safe-profile timer at schedules=auto installs with no card; a new host asks once; the same spec never twice', withProv(async () => {
  const c = company({ schedules: 'auto' });
  try {
    const ctx = serviceCtx(c, true);
    const r = SV.propose(ctx, 'nightly', { by: 'data', kind: 'timer', exec: 'bash company/work/jobs/report.sh', 'on-calendar': '*-*-* 02:00:00', why: 'builds the nightly report', network: 'none' });
    assert.equal(r.status, 'installed'); assert.equal(c.asks().length, 0); assert.equal(c.notice.sent.length, 0);
    const o = { by: 'data', kind: 'timer', exec: 'bash company/work/jobs/report.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.new.example' };
    const w = SV.propose(ctx, 'feed', o);
    // a website the company does not use yet is an `external` decision (the default keeps external at approve)
    assert.ok(w.waiting); assert.equal(c.asks().length, 1); assert.equal(c.asks()[0].gate.category, 'external');
    assert.deepEqual(c.asks()[0].effect, { serviceApprove: { name: 'feed' } }); assert.ok(plain(c.card.calls.find(x => x.op === 'file').card));
    SV.propose(ctx, 'feed', o);
    assert.equal(c.asks().length, 1, 'no duplicate card for the same spec');
  } finally { c.done(); }
}));

test('neither tool writes an owner row past lib/owner-card.js or a message past lib/owner-notice.js', () => {
  for (const f of ['harness-change.js', 'service.js']) {
    const src = fs.readFileSync(path.join(TOOLS, f), 'utf8');
    const code = src.slice(0, src.search(/\nfunction selftest|\nasync function selftest|\/\* -{6,} selftest/));
    assert.ok(!/pm-inbox-guard'\)\.append\(/.test(code), f + ' appends to the owner inbox directly');
    assert.ok(!/owner-inbox\.js'\)\.send\(/.test(code), f + ' messages the owner directly');
    assert.ok(!/outbound\.jsonl'\)[^\n]*appendFileSync/.test(code), f + ' writes the owner channel directly');
  }
});
