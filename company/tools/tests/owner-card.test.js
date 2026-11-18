#!/usr/bin/env node
/* owner-card.test.js — what reaches the owner (company/tools/lib/owner-card.js, lib/owner-rulings.js, lib/owner-scope.js
 * classify/check, lib/governance.js fileQuestion and fyi, approvals.js records, inbox.js stored keys, lib/money-hold.js):
 * a category at auto is the crew's, at notify it goes to the digest, at approve it is a card; a fixed gate is always a
 * card, even under a crew-decides ruling; a lead that is not plain is refused (NOT_PLAIN); cards dedupe and withdraw by
 * ref; a money question is withdrawn when today's budget is set some other way; a stored key is not asked for again.
 *   node --test company/tools/tests/owner-card.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');

// one throwaway company for the whole file: every tool reads it through CAPHEOS_ROOT (set before any require)
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-card-test-'));
const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');   // provenance.fixtureRoot: the owner checks pass here (and only here)
w('company/company.json', { name: 'OC', owner: { name: 'Pat' }, timezone: 'UTC' });
w('company/tools/loops.json', { agents: { founder: { name: 'Founder Fox', functions: ['ceo'], inbox: 'founder.md' }, sam: { name: 'Sam Lee', functions: ['tools'], inbox: 'sam.md' } } });
const DEF = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'state', 'governance.json'), 'utf8'));
w('company/defaults/state/governance.json', DEF);
const govDoc = Object.assign({}, DEF, { categories: Object.assign({}, DEF.categories, { tools: 'auto', schedules: 'notify', hiring: 'approve', models: 'notify', budget: 'approve' }) });
w('company/state/governance.json', govDoc);
w('company/work/ops/cadence.json', { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, seats: {} });
process.env.CAPHEOS_ROOT = T; process.env.PROVENANCE_ROOT = T;
process.env.INBOX_SECRETS_DIR = path.join(T, 'secrets');
delete process.env.PM_INBOX_FILE; delete process.env.GOVERNANCE_ROOT; delete process.env.OWNER_DIR;
const P = require(path.join(REPO, 'company', 'tools', 'provenance.js')); P.pinUnderStation(false);
const card = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-card.js'));
const R = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-rulings.js'));
const scope = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-scope.js'));
const gov = require(path.join(REPO, 'company', 'tools', 'lib', 'governance.js'));
const inbox = require(path.join(REPO, 'company', 'tools', 'inbox.js'));
const G = require(path.join(REPO, 'company', 'tools', 'lib', 'pm-inbox-guard.js'));
const INBOX = path.join(T, 'company', 'pm-inbox.jsonl');
test.after(() => { P.pinUnderStation(null); fs.rmSync(T, { recursive: true, force: true }); });

const asks = () => G.rows({ file: INBOX, noAlert: true }).filter(r => r.type === 'ask');
const base = o => Object.assign({ asker: 'sam', ref: 'test:' + Math.random().toString(36).slice(2), lead: 'May we hire a part-time designer for the shop?',
  consequence: 'If you say yes, Sam starts the search this week. If you say no, nobody is hired.', recommendation: 'Sam recommends yes: the shop pages wait on it.',
  technical: 'Round hr-0042, see company/work/people/rounds/hr-0042.md' }, o || {});
const captured = [];
const notice = n => { captured.push(n); return n; };

test('a category at auto is not filed: the crew decides', () => {
  const n = asks().length;
  const r = card.file(base({ category: 'tools', lead: 'May we rename a helper the crew uses?' }), { notice });
  assert.deepEqual([r.filed, r.route], [false, 'crew']); assert.equal(asks().length, n);
});

test('a category at notify is not filed: it goes to the daily digest as an fyi, technical part apart', () => {
  const n = asks().length; captured.length = 0;
  const r = card.file(base({ category: 'schedules', lead: 'May we check in on the shop more often in the morning?' }), { notice });
  assert.deepEqual([r.filed, r.route], [false, 'digest']); assert.equal(asks().length, n);
  assert.equal(captured.length, 1); assert.equal(captured[0].kind, 'fyi');
  assert.match(captured[0].text, /^Sam Lee decided this, as your settings allow: May we check in on the shop more often in the morning\.$/);
  assert.match(captured[0].technical, /hr-0042/); assert.doesNotMatch(captured[0].text, /hr-0042/);
});

test('the digest fallback (until lib/owner-notice.js is in the tree) sends only the plain text', () => {
  const r = card.file(base({ category: 'models', lead: 'May we try a cheaper AI for the weekly summary?' }));
  assert.equal(r.route, 'digest');
  const lines = ['digest.jsonl', 'outbound.jsonl'].map(f => path.join(T, 'company', 'owner', f)).filter(fs.existsSync).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(lines, /cheaper AI for the weekly summary/);
  if (!fs.existsSync(path.join(T, 'company', 'owner', 'digest.jsonl'))) assert.doesNotMatch(lines, /hr-0042|company\/work/);
});

test('a category at approve is filed: plain parts, the technical part collapsed, the gate and the effect on the row', () => {
  const o = base({ category: 'hiring', effect: { harnessApply: { id: 'hc-0042' } } });
  const r = card.file(o);
  assert.equal(r.filed, true); assert.match(r.id, /^q-\d{6}$/);
  const row = asks().find(x => x.id === r.id);
  assert.equal(row.message, o.lead); assert.equal(row.from, 'Sam Lee'); assert.equal(row.technical, o.technical);
  assert.deepEqual([row.gate.ref, row.gate.category, row.gate.fixedGate], [o.ref, 'hiring', null]);
  assert.deepEqual(row.effect, { harnessApply: { id: 'hc-0042' } });   // a throwaway company: the producer check is off
  assert.doesNotMatch(row.details, /hr-0042/); assert.match(row.q, /Technical details \(for the crew\):\nRound hr-0042/);
  const open = inbox.openQuestions().find(q => q.id === r.id);
  assert.equal(open.card, true); assert.equal(open.technical, o.technical); assert.deepEqual(open.effect, row.effect); assert.ok(!open.secretHint);
  assert.ok(gov.pendingGates().some(g => g.id === r.id && g.ref === o.ref), 'a governance reader sees it as a gate');
  assert.throws(() => inbox.answer({ id: r.id, by: 'Commander', a: 'yes' }), e => e.code === 5, 'a card is answered on Needs you, never by a plain inbox answer');
});

test('a fixed gate is always filed, even under a crew-decides ruling; a ruling covers an approve category; an ask ruling lifts a notify one', () => {
  assert.equal(R.add({ by: 'owner', text: 'The crew decides hiring and access on its own.', effect: 'crew-decides', scope: { categories: ['hiring'] } }).ok, true);
  assert.equal(R.add({ by: 'owner', text: 'Access too.', effect: 'crew-decides', scope: { categories: ['access'] } }).code, 2, 'a ruling cannot cover a fixed gate');
  const fx = card.file(base({ category: 'access', fixedGate: 'access', lead: 'Could you sign in to the shop account so we can see the orders?' }));
  assert.equal(fx.filed, true);
  const rowFx = asks().find(x => x.id === fx.id); assert.deepEqual([rowFx.gate.category, rowFx.gate.fixedGate], ['access', 'access']);
  const fx2 = card.file(base({ category: 'hiring', fixedGate: 'commitments', lead: 'May we sign the one-year deal with the print shop?' }));
  assert.equal(fx2.filed, true, 'a fixedGate wins over the category ruling');
  const h = card.file(base({ category: 'hiring' }));
  assert.deepEqual([h.filed, h.route, h.ruling && h.ruling.effect], [false, 'ruling', 'crew-decides']);
  assert.equal(R.add({ by: 'owner', text: 'Always ask me before a new AI is tried.', effect: 'ask', scope: { categories: ['models'], topics: ['cheaper AI'] } }).ok, true);
  const m = card.file(base({ category: 'models', lead: 'May we try a cheaper AI for the support replies?' }));
  assert.equal(m.filed, true, 'the owner asked to be asked');
});

test('governance: a crew-decides ruling lets decide() go ahead without a card; approve files a plain card', () => {
  const n = asks().length;
  const d = gov.decide('hiring', { by: 'Sam Lee', summary: 'hire Ana as designer', ref: 'hiring:ana' });
  assert.equal(d.allowed, true); assert.equal(d.ruling.effect, 'crew-decides'); assert.equal(asks().length, n);
  // a summary that does not read plainly is never sent as an empty "a decision about the budget" card (owner-experience review)
  const np = gov.decide('budget', { by: 'Sam Lee', summary: 'raise the cap in company/work/finance/budget.json to $40', recommendation: 'yes', ref: 'budget:x0' });
  assert.equal(np.allowed, false); assert.equal(np.notPlain, true); assert.equal(asks().length, n);
  const q = gov.decide('budget', { by: 'Sam Lee', summary: 'raise the daily budget to $40', recommendation: 'yes', ref: 'budget:x1', technical: 'company/work/finance/budget.json dailyUsd 20 -> 40' });
  assert.equal(q.allowed, false); assert.ok(q.questionId);
  const row = asks().find(x => x.id === q.questionId);
  assert.ok(card.plain(row.message), row.message); assert.ok(card.plain(row.consequence), row.consequence);
  assert.match(row.message, /^May Sam Lee go ahead and raise the daily budget to \$40\?$/);
  assert.match(row.technical, /company\/work\/finance\/budget\.json dailyUsd 20 -> 40/);
  assert.equal(row.recommendation, 'Sam Lee recommends yes.');
});

test('NOT_PLAIN: a lead with a path, a command or a model id is refused, naming the words', () => {
  for (const [lead, what] of [['May we change company/tools/dispatch.js so it waits less?', /file path|file or tool name/],
    ['Could you run node company/tools/halt.js resume for us?', /command/],
    ['May we move the writer to claude-sonnet-4-5 for a week?', /model id/],
    ['May we set the check to */5 so it runs more often?', /clock spec/]]) {
    assert.throws(() => card.file(base({ category: 'hiring', lead })), e => e.code === 'NOT_PLAIN' && e.words.some(x => what.test(x)), lead);
  }
  assert.throws(() => card.file(base({ category: 'hiring', consequence: 'If you say yes we set max_retries=3.' })), e => e.code === 'NOT_PLAIN' && /consequence/.test(e.words.join()));
  assert.throws(() => card.file(base({ category: 'hiring', effect: { launchRockets: true } })), e => e.code === 'BAD_EFFECT');
  assert.throws(() => card.file(base({ category: 'budget', effect: { governance: { category: 'access', level: 'auto' } } })), e => e.code === 'BAD_EFFECT', 'no effect loosens a fixed gate');
});

test('dedupe by ref: the same card twice is one card; a changed card updates it in place', () => {
  const o = base({ category: 'budget', ref: 'budget:dedupe', lead: 'May we raise today\'s budget to $12 so the writers finish?' });
  const a = card.file(o); const b = card.file(o);
  assert.equal(a.filed, true); assert.deepEqual([b.filed, b.route, b.id], [false, 'duplicate', a.id]);
  const c = card.file(Object.assign({}, o, { lead: 'May we raise today\'s budget to $15 so the writers finish?' }));
  assert.deepEqual([c.filed, c.updated, c.id], [true, true, a.id]);
  const open = inbox.openQuestions().filter(q => q.id === a.id);
  assert.equal(open.length, 1); assert.match(open[0].message, /\$15/);
  assert.equal(card.openCard('budget:dedupe').message, open[0].message);
});

test('withdraw by ref closes the open card; a later file is a new card', () => {
  const o = base({ category: 'budget', ref: 'budget:withdraw', lead: 'May we pay for a stock photo pack for the shop?' });
  const a = card.file(o);
  const w1 = card.withdraw({ ref: 'budget:withdraw', by: 'Sam Lee', why: 'found free photos' });
  assert.deepEqual(w1.withdrawn, [a.id]); assert.equal(card.openCard('budget:withdraw'), null);
  assert.ok(!inbox.openQuestions().some(q => q.id === a.id));
  const b = card.file(o); assert.equal(b.filed, true); assert.notEqual(b.id, a.id);
});

test('a "not now" from the owner holds the same ref for 7 days unless something material changed', () => {
  const o = base({ category: 'budget', ref: 'budget:notnow', lead: 'May we buy a paid plan for the newsletter?' });
  const a = card.file(o);
  G.append(INBOX, { type: 'answer', id: a.id, at: new Date().toISOString(), a: 'not now', answer: { verdict: 'no' }, by: 'Commander' }, 'test');
  const b = card.file(o); assert.deepEqual([b.filed, b.route, b.backoff && b.backoff.id], [false, 'declined', a.id]);
  assert.equal(card.coveredByCrew(b), false, 'a "not now" is never the crew\'s go-ahead'); assert.equal(card.refusedByOwner(b), true);
  const c = card.file(Object.assign({}, o, { changed: 'the newsletter now has 400 readers, up from 40' })); assert.equal(c.filed, true);
});

test('owner-scope: classify reads the real level; check honours rulings but never for a fixed gate', () => {
  assert.equal(scope.classify({ message: 'May we change when the routines run?', category: 'schedules' }).route, 'digest');
  assert.equal(scope.classify({ message: 'May we rename the helper?', category: 'tools' }).route, 'crew');
  assert.equal(scope.classify({ message: 'May we raise the budget?', category: 'budget' }).scope, 'owner');
  assert.equal(scope.classify({ message: 'x', category: 'tools', fixed: true }).scope, 'owner');
  const r = scope.check({ from: 'Sam Lee', message: 'May we hire a second designer? It lets us ship faster; if you skip it, we wait.', category: 'hiring', level: 'approve' }, { rows: [] });
  assert.equal(r && r.code, 'ruling'); assert.match(r.error, /standing rule/);
  assert.equal(scope.check({ from: 'Sam Lee', message: 'May we hire a second designer? It lets us ship faster; if you skip it, we wait.', category: 'hiring', fixed: true }, { rows: [] }), null);
  const n = scope.check({ from: 'Sam Lee', message: 'May we check in more often? It lets us answer faster; if you skip it, we keep the pace.', category: 'schedules' }, { rows: [] });
  assert.equal(n.code, 'crew-scope'); assert.equal(n.route, 'digest');
});

test('rulings: only the owner writes them; an agent run and a hand edit are refused', () => {
  assert.equal(R.add({ by: 'Sam Lee', text: 'x', effect: 'never-ask', scope: { categories: ['spend'] } }).code, 3);
  assert.equal(R.add({ by: 'owner', text: 'x', effect: 'never-ask', scope: { categories: ['spend'] } }, { shell: () => false }).code, 3, 'not the owner\'s shell');
  const before = R.list().length; assert.ok(before >= 2);
  const f = path.join(T, R.REL); const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.rulings.push({ id: 'r-forged', by: 'owner', text: 'forged', effect: 'crew-decides', scope: { categories: ['spend'] } });
  const keep = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, JSON.stringify(d));
  assert.equal(R.list().length, 0, 'a file changed after the owner\'s recorded write is not the owner\'s');
  fs.writeFileSync(f, keep); assert.equal(R.list().length, before);
});

test('approvals: an older gate record without a level reads the category\'s level as it is now', () => {
  const A = require(path.join(REPO, 'company', 'tools', 'approvals.js'));
  G.append(INBOX, { type: 'ask', id: 'q-990001', at: new Date().toISOString(), from: 'Founder Fox', about: 'governance:schedules', q: 'Old gate. May we?', message: 'Old gate. May we?', gate: { category: 'schedules', ref: 'old:1' } }, 'test');
  const rec = A.records()['q-990001'];
  assert.deepEqual([rec.level, rec.levelNow], ['notify', 'notify']);
});

test('a key that is already stored is not asked for again; an approval card never offers a key field', () => {
  const ask = o => inbox.ask(Object.assign({ scopeExempt: true, from: 'Sam Lee' }, o));
  const spec = { name: 'pyth-api-key', label: 'Pyth API key' };
  const msg = 'Could you make a free Pyth account and paste its API key? It lets us test prices; if you skip it, that idea waits.';
  w('secrets/pyth-api-key', 'k-123456789012345');
  assert.throws(() => ask({ message: msg, kind: 'secret', spec }), e => e.code === 'secret-exists' && /already stored/.test(e.message));
  assert.ok(ask({ message: msg, kind: 'secret', spec, changed: 'the old key stopped working this morning' }).row.id, 'asked again with what changed');
  // an old untyped row that reads as a key request: no key field once the key is stored
  G.append(INBOX, { type: 'ask', id: 'q-990002', at: new Date().toISOString(), from: 'Sam Lee', q: 'Please paste a free Pyth API key here.' }, 'test');
  assert.equal(inbox.secretHint(inbox.state()['q-990002']), null);
  fs.unlinkSync(path.join(T, 'secrets', 'pyth-api-key'));
  assert.equal((inbox.secretHint(inbox.state()['q-990002']) || {}).name, 'pyth-api-key', 'missing key: the field is offered');
  assert.equal(inbox.secretHint({ id: 'q-1', q: 'Please paste the Pyth API key.', gate: { ref: 'x' } }), null, 'never on a gate card');
  assert.equal(inbox.secretHint({ id: 'q-2', q: 'Please paste the Pyth API key.', approval: { category: 'access' } }), null, 'never on an approval');
});

test('money: an open money question is withdrawn when today\'s budget is set some other way', () => {
  const MH = require(path.join(REPO, 'company', 'tools', 'lib', 'money-hold.js'));
  const st = {}; const logs = [];
  const args = { root: T, holds: [{ seat: 'founder', name: 'Founder Fox', kind: 'cap', waiting: [] }], st, cap: 5, spent: 5.1, live: true, log: l => logs.push(l), govOpts: { level: 'approve' } };
  MH.tick(args); const r = MH.tick(args);
  assert.ok(r.asked, logs.join('\n'));
  const row = inbox.state()[r.asked];
  assert.doesNotMatch(row.details, /ticks|money-hold\.js|today-budget\.json/); assert.match(row.technical, /money-hold\.js set/);
  // the owner raises today's budget in Settings (the same recorded write, another path)
  assert.equal(MH.set(T, { choice: 'raise', dailyUsd: 9, by: 'Pat', why: 'raised in Settings', via: 'console settings' }).ok, true);
  MH.tick(args);
  assert.ok(!inbox.openQuestions().some(q => q.id === r.asked), 'the money question is closed');
  assert.equal(Object.values(st.moneyAsks)[0].status, 'settled'); assert.ok(logs.some(l => /MONEY HOLD withdrew/.test(l)), logs.join('\n'));
  // a raised daily budget closes it too (another company day, so today's decision above does not count)
  const st2 = {}; const later = Date.now() + 2 * 864e5;
  const a2 = Object.assign({}, args, { st: st2, now: later, holds: [{ seat: 'sam', name: 'Sam Lee', kind: 'cap', waiting: [] }] });
  MH.tick(a2); const r2 = MH.tick(a2);
  assert.ok(r2.asked, logs.join('\n'));
  MH.tick(Object.assign({}, a2, { cap: 20 }));
  assert.ok(!inbox.openQuestions().some(q => q.id === r2.asked), 'closed when the daily budget was raised');
  assert.match(Object.values(st2.moneyAsks)[0].settledBy, /daily budget was raised from \$5 to \$20/);
});
