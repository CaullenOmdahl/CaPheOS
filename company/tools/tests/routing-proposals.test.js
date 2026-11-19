#!/usr/bin/env node
/* routing-proposals.test.js — the weekly routing suggestions (routing.js proposals, docs/ROUTING.md "Weekly suggestions",
 * the middle-management plan's P5 bars), on a fixture company in UTC whose house ranking has suggestions:
 *   - the look happens only on the policy weekday and hour, once a week;
 *   - a two-tier move is skipped; a move the class rules deny is skipped;
 *   - a move to the top tier asks the CEO first: a CEO no gives a skip and no owner card; a yes files the card;
 *   - live mode files ONE veto card per suggestion (default go ahead, never expires to a deny) in plain words;
 *   - a veto before the deadline gives no apply; no veto gives set-route at the deadline, a decisions.md line, the apply
 *     row, the routing-log row, and the card withdrawn as answered by default; the routing mode itself is untouched;
 *   - shadow mode files no card (the suggestions are recorded as skipped, "mode shadow");
 *   - the mode switch is the owner's; a routeVeto effect from any program but routing.js is dropped by pm-inbox-guard.
 *   node --test company/tools/tests/routing-proposals.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const R = require(path.join(TOOLS, 'routing.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };
const jsonl = (root, rel) => (read(root, rel) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
const DAY = 86400e3;
const MON = Date.parse('2026-11-23T09:10:00Z');   // a Monday, 09:10 company time (UTC)

const CREW = {
  boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' },
  hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' },
  kwa: { name: 'Kwame', manager: 'boss', inbox: 'to-kwame.md' },
  ben: { name: 'Ben', manager: 'kwa', inbox: 'to-ben.md' },
};
const pair = (p, m, e) => ({ provider: p, model: m, effort: e || 'medium' });
// a house-ranking suggestion and its cells: from -> to for dept/class, the to cell with n items
function sug(id, dept, cls, from, to, n, o) {
  o = o || {};
  const cf = cls + '|' + from.provider + '/' + from.model + '|' + from.effort + '|served', ct = cls + '|' + to.provider + '/' + to.model + '|' + to.effort + '|served';
  return { p: { id, mode: 'shadow', department: dept, class: cls, from: Object.assign({}, from, { cell: cf, score: 1 }), to: Object.assign({}, to, { cell: ct, score: 1.4 }), fromModel: from.provider + '/' + from.model + ' @ ' + from.effort, toModel: to.provider + '/' + to.model + ' @ ' + to.effort, gain: o.gain == null ? 0.4 : o.gain },
    cells: [{ id: cf, items: 40, lower: 0.8, costPerItem: 1.0 }, { id: ct, items: n, lower: 0.82, costPerItem: o.cost == null ? 0.5 : o.cost }] };
}
function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-test-')); roots.push(root);
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/departments.json', 'company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/work/models/routing-policy.json', 'company/model-policy.json'])
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  w(root, 'company/state/governance.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  const pol = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/routing-policy.json'), 'utf8'));
  pol.proposals = Object.assign({}, pol.proposals, { mode: o.mode || 'live' });
  w(root, 'company/work/models/routing-policy.json', pol);
  w(root, 'company/departments.json', { version: 1, departments: [
    { id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben'], defaultClass: 'code', routes: o.routes || { code: pair('claude-cli', 'claude-opus-5-5'), review: pair('claude-cli', 'claude-sonnet-5-5'), research: pair('claude-cli', 'claude-sonnet-5-5') } }] });
  for (const f of ['BRIEF.md', 'INBOX-DIGEST.md', 'DECISIONS.md']) w(root, 'company/work/departments/eng/' + f, '# x\n');
  w(root, 'company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  for (const c of Object.values(CREW)) w(root, 'company/work/handoffs/' + c.inbox, '# Handoffs\n');
  const list = o.suggestions || [sug('rp-aaaaaaaaaaaa', 'eng', 'code', pair('claude-cli', 'claude-opus-5-5'), pair('claude-cli', 'claude-sonnet-5-5'), 40)];
  w(root, 'company/work/models/house-ranking.json', { computedAt: new Date(MON - DAY).toISOString(), proposals: list.map(x => x.p), cells: list.flatMap(x => x.cells) });
  w(root, 'company/work/models/routing-proposals.jsonl', list.map(x => JSON.stringify(Object.assign({ kind: 'proposal', at: new Date(MON - DAY).toISOString() }, x.p))).join('\n') + '\n');
  if (o.strict) w(root, '.pm-inbox-guard-strict', '');
  return root;
}
function routing(root, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(' + (o.station ? 'true' : 'false') + '); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'const r = require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const tick = (root, at) => routing(root, ['proposals', 'tick', '--now', String(at)]);
const rows = root => jsonl(root, 'company/work/models/routing-proposals.jsonl').filter(r => r.kind !== 'proposal');
const cards = root => jsonl(root, 'company/pm-inbox.jsonl').filter(r => r.type === 'ask' && r.gate && /^routing-proposal:/.test(r.gate.ref));
const routeOf = (root, cls) => JSON.parse(read(root, 'company/departments.json')).departments[0].routes[cls];

test('only on the policy weekday and hour, once a week', () => {
  const root = fixture();
  assert.deepEqual(tick(root, MON - DAY).out.offered, [], 'Sunday: nothing');
  assert.deepEqual(tick(root, MON + 3 * 3600e3).out.offered, [], 'Monday at noon: not the hour');
  const r = tick(root, MON);
  assert.equal(r.code, 0, JSON.stringify(r)); assert.deepEqual(r.out.offered, ['rp-aaaaaaaaaaaa']); assert.equal(r.out.week, '2026-W48');
  assert.equal(tick(root, MON + 20 * 60e3).out.week, null, 'the same hour again: the week is done');
  assert.equal(rows(root).filter(x => x.kind === 'week').length, 1);
  assert.equal(rows(root).filter(x => x.kind === 'offer').length, 1);
  assert.equal(cards(root).length, 1, 'one owner card');
});

test('a veto card in plain words: the default first, it never expires to a deny, filed whatever the models level', () => {
  const root = fixture();
  tick(root, MON);
  const c = cards(root)[0];
  assert.equal(c.gate.category, 'models');
  assert.ok(!c.expiresAt && !c.gate.expiresAt, 'no expiry to a deny');
  assert.ok(c.veto && Date.parse(c.veto.until) === MON + 3 * DAY, 'the veto window is vetoDays');
  assert.deepEqual(c.form.actions.map(a => [a.label, a.verdict]), [['Fine, go ahead', 'no'], ['Keep it as it is', 'yes']], 'the default named first; the veto applies the effect');
  assert.deepEqual(c.effect, { routeVeto: { proposalId: 'rp-aaaaaaaaaaaa' } });
  assert.equal(c.message, 'Each week the crew checks which setup does each kind of work best for the money. This week they want Engineering\'s coding work on a cheaper setup that did just as well on the last 40 jobs.');
  assert.equal(c.consequence, 'If you do nothing, it changes on Thursday and the crew keeps measuring; if you keep it as it is, nothing changes.');
  assert.match(c.recommendation, /which is what happens if you do nothing/);
  const OS = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  for (const t of [c.message, c.consequence, c.recommendation, c.veto.defaultLabel, c.veto.vetoLabel]) assert.deepEqual(OS.wordsProblems(t), [], t);
  assert.match(c.technical, /claude-cli\/claude-opus-5-5@medium -> claude-cli\/claude-sonnet-5-5@medium/, 'the pairs and the id in the technical fold');
  // the governance level for models is notify by default: a plain card would go to the digest; a veto card is filed
  assert.equal(JSON.parse(read(root, 'company/state/governance.json')).categories.models, 'notify');
});

test('no veto: set-route at the deadline, a decisions.md line, the apply and log rows, the card withdrawn; the routing mode untouched', () => {
  const root = fixture();
  tick(root, MON);
  assert.deepEqual(tick(root, MON + 2 * DAY).out.applied, [], 'inside the veto window: nothing applied');
  assert.deepEqual(routeOf(root, 'code'), pair('claude-cli', 'claude-opus-5-5'));
  const r = tick(root, MON + 3 * DAY + 60e3);
  assert.deepEqual(r.out.applied, ['rp-aaaaaaaaaaaa'], JSON.stringify(r));
  assert.deepEqual(routeOf(root, 'code'), pair('claude-cli', 'claude-sonnet-5-5'));
  assert.match(read(root, 'company/work/decisions.md'), /the code route of Engineering: claude-cli\/claude-opus-5-5@medium -> claude-cli\/claude-sonnet-5-5@medium \(weekly suggestion rp-aaaaaaaaaaaa, not vetoed\)/);
  const ap = rows(root).find(x => x.kind === 'apply'); assert.ok(ap && ap.by === 'routing-proposal' && /^sha256:/.test(ap.departmentsDigest), JSON.stringify(ap));
  assert.ok(jsonl(root, 'company/work/models/routing-log.jsonl').some(x => x.op === 'proposal-apply' && x.proposal === 'rp-aaaaaaaaaaaa'));
  const inbox = jsonl(root, 'company/pm-inbox.jsonl');
  assert.ok(inbox.some(x => x.type === 'withdraw' && x.id === cards(root)[0].id && /answered by default/.test(x.why)), 'the card is withdrawn as answered by default');
  assert.equal(JSON.parse(read(root, 'company/work/models/routing-policy.json')).mode, 'shadow', 'the routing mode stays the owner\'s switch');
  assert.deepEqual(tick(root, MON + 4 * DAY).out.applied, [], 'applied once');
  // set-route for it again is refused: it is applied
  const D = spawnSync(process.execPath, ['-e', 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'departments.js')) + ').run(["set-route","eng","code","claude-cli/claude-sonnet-5-5@medium","--by","routing-proposal","--proposal","rp-aaaaaaaaaaaa"])))'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC' }) });
  const again = JSON.parse(D.stdout); assert.ok(again.code === 0 && again.out.changed === false || /applied already/.test(again.out.error || ''), D.stdout);
});

test('a veto before the deadline: no apply; only the owner vetoes', () => {
  const root = fixture();
  tick(root, MON);
  assert.equal(routing(root, ['proposals', 'veto', 'rp-aaaaaaaaaaaa', '--by', 'Boss']).code, 2, 'the CEO cannot veto for the owner');
  const v = routing(root, ['proposals', 'veto', 'rp-aaaaaaaaaaaa', '--by', 'owner'], { owner: true });
  assert.equal(v.code, 0, JSON.stringify(v)); assert.equal(v.out.vetoed, 'rp-aaaaaaaaaaaa');
  const r = tick(root, MON + 4 * DAY);
  assert.deepEqual(r.out.applied, []); assert.deepEqual(routeOf(root, 'code'), pair('claude-cli', 'claude-opus-5-5'), 'the route is kept as it is');
  assert.ok(rows(root).some(x => x.kind === 'veto' && x.by === 'owner'));
  assert.match(read(root, 'company/work/decisions.md'), /the owner kept eng's code route as it is \(weekly suggestion rp-aaaaaaaaaaaa vetoed\)/);
  const st = routing(root, ['proposals', 'status', '--json']).out;
  assert.equal(st.weeks[0].suggestions[0].state, 'vetoed');
});

test('skipped: a two-tier move, a move the class rules deny, too few items, more than one move per department and class', () => {
  const root = fixture({ suggestions: [
    sug('rp-bbbbbbbbbbbb', 'eng', 'code', pair('claude-cli', 'claude-opus-5-5'), pair('claude-cli', 'claude-haiku-4-5-20251001'), 40, { gain: 0.9 }),
    sug('rp-cccccccccccc', 'eng', 'code', pair('claude-cli', 'claude-opus-5-5'), pair('custom', 'MiniMax-M3.1-Pro'), 40, { gain: 0.8 }),
    sug('rp-dddddddddddd', 'eng', 'review', pair('claude-cli', 'claude-sonnet-5-5'), pair('deepseek', 'deepseek-flash'), 5, { gain: 0.7 }),
    sug('rp-eeeeeeeeeeee', 'eng', 'code', pair('claude-cli', 'claude-opus-5-5'), pair('claude-cli', 'claude-sonnet-5-5'), 40, { gain: 0.5 }),
    sug('rp-ffffffffffff', 'eng', 'code', pair('claude-cli', 'claude-opus-5-5'), pair('claude-cli', 'sonnet'), 40, { gain: 0.4 }),
  ] });
  const r = tick(root, MON);
  const why = Object.fromEntries(rows(root).filter(x => x.kind === 'skip').map(x => [x.id, x.why]));
  assert.equal(why['rp-bbbbbbbbbbbb'], 'tier step', 'heavy to light is two tiers');
  assert.equal(why['rp-cccccccccccc'], 'class rules', 'code never on the MiniMax plan');
  assert.equal(why['rp-dddddddddddd'], 'not enough items');
  assert.equal(why['rp-ffffffffffff'], 'one move per department and class a week');
  assert.deepEqual(r.out.offered, ['rp-eeeeeeeeeeee'], JSON.stringify(r.out));
});

test('a move to the top tier asks the CEO first: no gives a skip and no owner card; yes files the card', () => {
  for (const verdict of ['no', 'yes']) {
    const root = fixture({ suggestions: [sug('rp-111111111111', 'eng', 'research', pair('claude-cli', 'claude-sonnet-5-5'), pair('claude-cli', 'claude-opus-5-5'), 40, { cost: 1.3 })] });
    const r = tick(root, MON);
    assert.deepEqual(r.out.asked, ['rp-111111111111']); assert.equal(cards(root).length, 0, 'no owner card before the CEO');
    assert.match(read(root, 'company/work/handoffs/to-boss.md'), /weekly routing suggestion rp-111111111111 needs your approval first[\s\S]*routing\.js proposals ceo rp-111111111111 yes\|no/);
    assert.match(routing(root, ['proposals', 'ceo', 'rp-111111111111', verdict, '--by', 'Kwame']).out.error, /only the CEO/);
    assert.match(routing(root, ['proposals', 'ceo', 'rp-111111111111', verdict, '--by', 'owner'], { owner: true }).out.error, /the CEO's/);
    assert.equal(routing(root, ['proposals', 'ceo', 'rp-111111111111', verdict, '--by', 'Boss']).code, 0);
    const r2 = tick(root, MON + 3600e3);
    if (verdict === 'no') {
      assert.ok(rows(root).some(x => x.kind === 'skip' && x.why === 'ceo declined'), JSON.stringify(rows(root)));
      assert.equal(cards(root).length, 0, 'a CEO no files no owner card');
    } else {
      assert.deepEqual(r2.out.offered, ['rp-111111111111']); assert.equal(cards(root).length, 1);
      assert.equal(rows(root).find(x => x.kind === 'offer').ceo.verdict, 'yes');
      assert.match(cards(root)[0].message, /a setup that did more for the money/, 'not cheaper: the card says so');
    }
  }
});

test('shadow mode files no card: the suggestions are recorded, nothing applied; the mode switch is the owner\'s', () => {
  const root = fixture({ mode: 'shadow' });
  const r = tick(root, MON);
  assert.deepEqual(r.out.offered, []); assert.equal(cards(root).length, 0);
  assert.ok(rows(root).some(x => x.kind === 'skip' && x.why === 'mode shadow' && x.id === 'rp-aaaaaaaaaaaa'));
  assert.deepEqual(routeOf(root, 'code'), pair('claude-cli', 'claude-opus-5-5'));
  assert.match(routing(root, ['proposals', 'mode', 'live', '--by', 'Boss']).out.error, /owner's decision/);
  const m = routing(root, ['proposals', 'mode', 'live', '--by', 'owner'], { owner: true });
  assert.equal(m.code, 0, JSON.stringify(m)); assert.equal(JSON.parse(read(root, 'company/work/models/routing-policy.json')).proposals.mode, 'live');
  assert.ok(jsonl(root, 'company/work/models/routing-log.jsonl').some(x => x.op === 'proposals-mode' && x.to === 'live'));
  const off = routing(root, ['proposals', 'mode', 'off', '--by', 'owner'], { owner: true }); assert.equal(off.code, 0);
  assert.equal(R.proposalKnobs(JSON.parse(read(root, 'company/work/models/routing-policy.json'))).mode, 'off');
});

test('a routeVeto effect from any program but routing.js is dropped by pm-inbox-guard', () => {
  const root = fixture({ strict: true });
  // a card with that effect, filed by another company tool, in a company where the program check is on
  const code = 'const card = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'owner-card.js')) + '); card.file({ asker: "Ben", category: "models", ref: "routing-proposal:rp-999999999999", lead: "Each week the crew checks which setup does each kind of work best for the money.", consequence: "If you do nothing, it changes on Thursday and the crew keeps measuring; if you keep it as it is, nothing changes.", recommendation: "The crew suggests letting it go ahead, which is what happens if you do nothing.", veto: { until: "2026-11-26T09:00:00Z", defaultLabel: "Fine, go ahead", vetoLabel: "Keep it as it is" }, effect: { routeVeto: { proposalId: "rp-999999999999" } } }, { root: process.env.CAPHEOS_ROOT });';
  // the filer is a company tool, so its ask row itself counts; only the effect's producer is wrong
  const filer = w(root, 'company/tools/other-tool.js', code);
  const r = spawnSync(process.execPath, [filer], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC' }) });
  assert.equal(r.status, 0, r.stderr);
  const G = spawnSync(process.execPath, ['-e', 'const g = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'pm-inbox-guard.js')) + '); process.stdout.write(JSON.stringify(g.rows({ file: process.env.CAPHEOS_ROOT + "/company/pm-inbox.jsonl", noAlert: true })));'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }) });
  const seen = JSON.parse(G.stdout).filter(x => x.type === 'ask');
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].effect || !seen[0].effect.routeVeto, 'the effect is not kept: ' + JSON.stringify(seen[0].effect));
  const OC = require(path.join(TOOLS, 'lib', 'owner-card.js'));
  assert.deepEqual(OC.EFFECT_PRODUCERS.routeVeto, ['company/tools/routing.js'], 'one producer');
});

test('pure parts: the ISO week, tiers, plain card words', () => {
  assert.equal(R.isoWeek('2026-11-23'), '2026-W48'); assert.equal(R.isoWeek('2026-01-01'), '2026-W01'); assert.equal(R.isoWeek('2027-01-01'), '2026-W53');
  const mp = JSON.parse(fs.readFileSync(path.join(REPO, 'company/model-policy.json'), 'utf8'));
  assert.equal(R.tierOf({ provider: 'claude-cli', model: 'claude-fable-5-2[1m]' }, mp), 3); assert.equal(R.tierOf({ provider: 'deepseek', model: 'deepseek-flash' }, mp), 0, 'no tier reads as light');
  const OS = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  for (const cls of ['code', 'review', 'research', 'writing', 'design', 'ops', 'mechanical', 'general']) {
    const x = R.cardWords({ class: cls, evidence: { items: 25, costRatio: 0.7 } }, 'Engineering', MON + 3 * DAY);
    for (const t of Object.values(x)) assert.deepEqual(OS.wordsProblems(t), [], t);
  }
});

test('the console\'s words for weekly suggestions are plain', async () => {
  const E = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'settings', 'routing-explain.js'));
  const OS = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  for (const t of E.suggestionSamples()) assert.deepEqual(OS.wordsProblems(t), [], t);
  assert.equal(E.suggestionLine({ deptName: 'Engineering', class: 'code', state: 'applied' }), 'Engineering\'s coding work: it went ahead.');
  assert.equal(E.weekTitle('2026-W48', 1), 'Week 48: 1 suggestion');
  assert.match(E.suggestionTech({ id: 'rp-1', dept: 'eng', class: 'code', from: { provider: 'claude-cli', model: 'claude-opus-5-5' }, to: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, state: 'applied' }), /claude-cli\/claude-opus-5-5 -> claude-cli\/claude-sonnet-5-5/, 'the ids only in the technical fold');
});
