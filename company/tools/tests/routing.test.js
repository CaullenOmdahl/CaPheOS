'use strict';
// routing.test.js — lib/routing.js decide(): class rules, trials (deterministic, even, entry share, pacer pause), tier caps,
// shadow vs live and the allowlist (docs/ROUTING.md). Offline: no station, no model run.
//   node --test company/tools/tests/routing.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
process.env.CAPHEOS_ROOT = T; process.env.PROVENANCE_ROOT = T;
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
W('company/company.json', { name: 'Routing Test', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents: {} });
const R = require('../lib/routing');
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

const DEFAULT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'work', 'models', 'routing-policy.json'), 'utf8'));
const pol = patch => Object.assign(JSON.parse(JSON.stringify(DEFAULT)), patch || {});
const caps = patch => Object.assign(JSON.parse(JSON.stringify(DEFAULT.tierCaps)), patch || {});
const CREW = { boss: { name: 'Boss', functions: ['ceo'] }, lead: { name: 'Lee', manager: 'boss' }, dev: { name: 'Dev', manager: 'lead' }, ops: { name: 'Oz', manager: 'boss' } };
const DEPS = { departments: [{ id: 'eng', name: 'Engineering', lead: 'lead', members: ['lead', 'dev'], defaultClass: 'code', routes: { code: { provider: 'custom', model: 'MiniMax-M3.1-Flash' }, writing: { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' } } }] };
const FABLE = { provider: 'claude-cli', model: 'claude-fable-5-2[1m]' };
const SONNET = { provider: 'claude-cli', model: 'claude-sonnet-5-5' };
const MM = { provider: 'custom', model: 'MiniMax-M3.1-Flash' };
const DS = { provider: 'deepseek', model: 'deepseek-flash' };
const item = (cls, extra) => ({ text: '## x\n**Class:** ' + cls + '\n' + (extra || '') + '**Status:** OPEN\n' });
const base = o => Object.assign({ crew: CREW, departments: DEPS, wakeId: 'wk-1', allow: null, held: [] }, o);

test('the default policy: shadow, code denies custom, no trials, tier caps shadow; knobs read it', () => {
  const K = R.knobs(DEFAULT);
  assert.strictEqual(K.mode, 'shadow'); assert.strictEqual(K.tierCaps.mode, 'shadow');
  assert.deepStrictEqual(K.classRules.code.denyProviders, ['custom']);
  assert.deepStrictEqual(K.trials, []);
  assert.deepStrictEqual(K.order, ['classRules', 'trial', 'route', 'tierCap', 'chain']);
  assert.strictEqual(K.history, 'company/work/models/routing-log.jsonl');
  assert.strictEqual(R.knobs({}).mode, 'off', 'a missing key reads as off');
});

test('(3) class rules: a code item never gets a custom pair from a route, a trial arm or the cap, in any mode', () => {
  const trial = { id: 'mm-code', class: 'code', arms: [MM, SONNET], scope: { seats: ['dev'] }, entryShare: 1, status: 'running' };
  for (const mode of ['off', 'shadow', 'live']) for (const cm of ['off', 'shadow', 'live']) {
    const policy = pol({ mode, tierCaps: caps({ mode: cm, allow: [{ provider: 'custom' }, { provider: 'claude-cli', model: 'claude-sonnet-5-5' }] }), trials: [trial] });
    for (let i = 0; i < 40; i++) {
      const d = R.decide(base({ policy, seat: 'dev', items: [item('code')], wakeId: 'wk-' + i, chain: [MM, FABLE, SONNET], current: MM, allow: [MM, FABLE, SONNET] }));
      assert.notStrictEqual(d.provider, 'custom', mode + '/' + cm + ' ' + JSON.stringify(d));
      assert.ok(!d.wouldApply || d.wouldApply.provider !== 'custom', JSON.stringify(d));
      assert.ok(d.reasons.some(r => /mm-code.*class rules deny/.test(r)) || mode === 'off', 'the trial with a custom arm is skipped whole: ' + JSON.stringify(d.reasons));
    }
  }
  // the department's code route is custom: denied; the chain's own custom pair is moved to the first allowed entry
  const d = R.decide(base({ policy: pol({ mode: 'live' }), seat: 'dev', items: [item('code')], chain: [MM, SONNET], current: MM, allow: [MM, SONNET] }));
  assert.ok(d.reasons.some(r => /route eng\.code custom\/MiniMax-M3\.1-Flash denied/.test(r)), JSON.stringify(d));
  assert.deepStrictEqual([d.source, d.provider, d.model, d.applied], ['chain', 'claude-cli', 'claude-sonnet-5-5', true]);
  // the first allowed entry the allowlist opens: Fable closed, so Sonnet (never back to MiniMax)
  const o = R.decide(base({ policy: pol({ mode: 'shadow' }), seat: 'ops', items: [item('code')], chain: [FABLE, SONNET, MM], current: MM, allow: [SONNET, MM] }));
  assert.deepStrictEqual([o.source, o.model, o.applied], ['chain', 'claude-sonnet-5-5', true], 'class rules apply in shadow too: ' + JSON.stringify(o));
  // a writing item on the same seat may run on anything its rules allow (the custom chain is left alone)
  const w = R.decide(base({ policy: pol({ mode: 'shadow' }), seat: 'dev', items: [item('writing')], chain: [MM], current: MM, allow: [MM] }));
  assert.strictEqual(w.provider, 'custom'); assert.strictEqual(w.wouldApply.model, 'claude-sonnet-5-5');
  // with no allowed chain entry the class rule records it and leaves the chain (nothing else exists to run on)
  const n = R.decide(base({ policy: pol({ mode: 'off' }), seat: 'ops', items: [item('code')], chain: [MM], current: MM, allow: [MM] }));
  assert.ok(n.reasons.some(r => /no chain entry is allowed/.test(r)), JSON.stringify(n));
});

test('(4) trial assignment is deterministic, even across arms (+-5%) and respects entryShare (+-2 points) over 2000 wakes', () => {
  const arms = [SONNET, { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, Object.assign({ effort: 'medium' }, FABLE)];
  const trial = { id: 'bigger-lower-effort', class: 'code', arms, scope: { departments: ['eng'] }, entryShare: 0.1, status: 'running', pauseWhenHeld: ['claude-cli'] };
  const policy = pol({ mode: 'shadow', trials: [trial], classRules: {} });
  const K = R.knobs(policy);
  const N = 2000, count = [0, 0, 0]; let entered = 0;
  for (let i = 0; i < N; i++) {
    const wakeId = 'wk-' + (1763400000000 + i * 600000).toString(36) + '-a1-' + i.toString(36);
    const d = R.decide(base({ K, seat: 'dev', items: [item('code')], wakeId, chain: [SONNET], current: SONNET }));
    const again = R.decide(base({ K, seat: 'dev', items: [item('code')], wakeId, chain: [SONNET], current: SONNET }));
    assert.deepStrictEqual(d, again, 'same wakeId, same decision');
    const g = R.assign(trial, wakeId);
    if (g.entered) entered++;
    const arm = d.wouldApply && d.wouldApply.trial ? d.wouldApply.arm : (d.trial ? d.arm : null);
    if (g.entered) assert.strictEqual(arm != null ? arm : g.arm, g.arm, 'the decision names the assigned arm');
  }
  // the arm split, over every wake's arm draw (independent of entry), and inside the entered ones
  for (let i = 0; i < N; i++) count[R.assign(trial, 'wk-split-' + i).arm]++;
  for (const c of count) assert.ok(Math.abs(c / N - 1 / 3) <= 0.05, 'arm share ' + (c / N).toFixed(3) + ' ' + JSON.stringify(count));
  assert.ok(Math.abs(entered / N - 0.1) <= 0.02, 'entry share ' + (entered / N).toFixed(3));
  // an out-of-scope seat (ops, no department) and another class never enter
  const o = R.decide(base({ K, seat: 'ops', items: [item('code')], wakeId: 'wk-0', chain: [SONNET], current: SONNET }));
  assert.ok(!o.wouldApply && !o.trial, JSON.stringify(o));
});

test('(5) a pacer hold on claude-cli pauses the trial (no assignment, reason recorded); it resumes after', () => {
  const trial = { id: 't1', class: 'code', arms: [SONNET, Object.assign({ effort: 'medium' }, FABLE)], scope: { seats: ['dev'] }, entryShare: 1, status: 'running', pauseWhenHeld: ['claude-cli'] };
  const K = R.knobs(pol({ mode: 'live', trials: [trial], classRules: {}, tierCaps: caps({ mode: 'off' }) }));
  const args = (held, id) => base({ K, seat: 'dev', items: [item('code')], wakeId: id, chain: [DS], current: DS, held, allow: [DS, SONNET, FABLE] });
  for (let i = 0; i < 30; i++) {
    const d = R.decide(args(['claude-cli'], 'wk-h' + i));
    assert.ok(!d.trial && !(d.wouldApply && d.wouldApply.trial) && !d.applied, JSON.stringify(d));
    assert.ok(d.reasons.some(r => /trial t1 paused: claude-cli held by the pacer/.test(r)), JSON.stringify(d.reasons));
  }
  let st = { trials: {} };
  const p1 = R.trialPauses(K, ['claude-cli'], st, 1000); st = p1.state;
  assert.deepStrictEqual(p1.events.map(e => [e.trial, e.event]), [['t1', 'paused']]);
  assert.strictEqual(R.trialPauses(K, ['claude-cli'], st, 2000).events.length, 0, 'a lasting hold is recorded once');
  const p2 = R.trialPauses(K, [], st, 3000);
  assert.deepStrictEqual(p2.events.map(e => [e.trial, e.event]), [['t1', 'resumed']]);
  const d = R.decide(args([], 'wk-r1'));
  assert.strictEqual(d.trial, 't1'); assert.strictEqual(d.applied, true);
  assert.deepStrictEqual([d.provider, d.model], [K.trials[0].arms[d.arm].provider, K.trials[0].arms[d.arm].model]);
  // an arm that is not open runs the chain and says so; the wake is never moved to the other arm
  const id = Array.from({ length: 50 }, (_, i) => 'wk-n' + i).find(x => R.assign(trial, x).arm === 1);
  const nd = R.decide(base({ K, seat: 'dev', items: [item('code')], wakeId: id, chain: [DS], current: DS, held: [], allow: [DS, SONNET] }));
  assert.deepStrictEqual([nd.applied, nd.provider, nd.wouldApply.arm], [false, 'deepseek', 1]);
  assert.ok(nd.reasons.some(r => /not open: claude-cli\/claude-fable-5-2\[1m\] is not in the override allowlist/.test(r)), JSON.stringify(nd.reasons));
});

test('(6) tier cap: a light item on a fable-first chain records the capped sonnet entry; heavy, the CEO and a lead are left alone', () => {
  const K = R.knobs(pol({ mode: 'off', tierCaps: caps({ mode: 'shadow' }) }));
  const chain = [FABLE, SONNET, DS];
  const d = R.decide(base({ K, seat: 'dev', items: [item('code')], chain, current: FABLE }));
  assert.deepStrictEqual(d.wouldApply, { source: 'tierCap', provider: 'claude-cli', model: 'claude-sonnet-5-5' });
  assert.deepStrictEqual([d.applied, d.source, d.model], [false, 'chain', FABLE.model]);
  const heavy = R.decide(base({ K, seat: 'dev', items: [item('code', '**Effort:** heavy — a migration\n')], chain, current: FABLE }));
  assert.ok(!heavy.wouldApply && heavy.reasons.some(r => /Effort: heavy/.test(r)), JSON.stringify(heavy));
  const ceo = R.decide(base({ K, seat: 'boss', items: [item('general')], chain, current: FABLE }));
  assert.ok(!ceo.wouldApply && ceo.reasons.some(r => /exempt \(holds the ceo function\)/.test(r)), JSON.stringify(ceo));
  const lead = R.decide(base({ K, seat: 'lead', items: [item('code')], chain, current: FABLE }));
  assert.ok(!lead.wouldApply && lead.reasons.some(r => /exempt \(leads a department\)/.test(r)), JSON.stringify(lead));
  const none = R.decide(base({ K, seat: 'ops', items: [item('general')], chain: [FABLE], current: FABLE }));
  assert.ok(!none.wouldApply && none.reasons.some(r => /no capped entry/.test(r)), JSON.stringify(none));
  // live and open: the capped entry is the one-run override
  const KL = R.knobs(pol({ mode: 'off', tierCaps: caps({ mode: 'live' }) }));
  const l = R.decide(base({ K: KL, seat: 'dev', items: [item('code')], chain, current: FABLE, allow: [FABLE, SONNET] }));
  assert.deepStrictEqual(R.overrideOf(l), { provider: 'claude-cli', model: 'claude-sonnet-5-5' });
});

test('shadow records wouldApply and applies nothing; live + allowed applies; live + not listed is "not open"', () => {
  const s = R.decide(base({ policy: pol({ mode: 'shadow' }), seat: 'dev', items: [item('writing')], chain: [DS], current: DS, allow: [DS, SONNET] }));
  assert.strictEqual(s.applied, false); assert.strictEqual(R.overrideOf(s), null);
  assert.deepStrictEqual(s.wouldApply, { source: 'route', provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high', department: 'eng' });
  const l = R.decide(base({ policy: pol({ mode: 'live' }), seat: 'dev', items: [item('writing')], chain: [DS], current: DS, allow: [DS, SONNET] }));
  assert.deepStrictEqual(R.overrideOf(l), { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' });
  const x = R.decide(base({ policy: pol({ mode: 'live' }), seat: 'dev', items: [item('writing')], chain: [DS], current: DS, allow: [DS] }));
  assert.strictEqual(x.applied, false); assert.ok(x.reasons.some(r => /^not open/.test(r)), JSON.stringify(x));
  const z = R.decide(base({ policy: pol({ mode: 'live' }), seat: 'dev', items: [item('writing')], chain: [DS], current: DS, allow: null }));
  assert.ok(z.reasons.some(r => /not open: no current override allowlist/.test(r)), JSON.stringify(z));
});

test('allowFor reads only a current allowlist; extraEntries lists running trial arms and live cap entries, never a denied pair', () => {
  W('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: { dev: [SONNET] } });
  assert.deepStrictEqual(R.allowFor('dev', { root: T }), [SONNET]);
  assert.deepStrictEqual(R.allowFor('ops', { root: T }), []);
  W('company/state/override-allow.json', { v: 1, at: Date.now() - 31 * 60e3, agents: { dev: [SONNET] } });
  assert.strictEqual(R.allowFor('dev', { root: T }), null, 'stale');
  const trials = [{ id: 'a', class: 'code', arms: [SONNET, DS], scope: { seats: ['dev'] }, status: 'running' },
    { id: 'b', class: 'code', arms: [MM], scope: { seats: ['dev'] }, status: 'running' },
    { id: 'c', class: 'writing', arms: [FABLE], scope: { seats: ['dev'] }, status: 'draft' }];
  const K = R.knobs(pol({ mode: 'shadow', trials, tierCaps: caps({ mode: 'live' }) }));
  assert.deepStrictEqual(R.extraEntries('dev', { K, departments: DEPS, crew: CREW, chain: [FABLE, SONNET] }), [SONNET, DS, SONNET]);
  assert.deepStrictEqual(R.extraEntries('boss', { K, departments: DEPS, crew: CREW, chain: [FABLE, SONNET] }), [], 'the CEO: exempt from the cap, in no trial');
  assert.deepStrictEqual(R.extraEntries('dev', { K: R.knobs(pol({ mode: 'off', trials })), departments: DEPS, crew: CREW, chain: [] }), []);
});

test('prepare: no policy anywhere = null (every wake runs on its chain); a policy writes trial pauses to the log', async () => {
  assert.strictEqual(await R.prepare({ root: T }), null);
  const trial = { id: 'p', class: 'code', arms: [SONNET], scope: { seats: ['dev'] }, entryShare: 1, status: 'running', pauseWhenHeld: ['claude-cli'] };
  W('company/work/models/routing-policy.json', pol({ trials: [trial] }));
  const lines = [];
  const ctx = await R.prepare({ root: T, held: ['claude-cli'], log: l => lines.push(l) });
  R.finish(ctx);
  assert.ok(lines.some(l => /ROUTING trial p paused: claude-cli held by the pacer/.test(l)), lines.join('\n'));
  const log = fs.readFileSync(path.join(T, 'company/work/models/routing-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(log.map(r => [r.kind, r.trial, r.event]), [['trial', 'p', 'paused']]);
  const c2 = await R.prepare({ root: T, held: [], log: l => lines.push(l) }); R.finish(c2);
  assert.ok(lines.some(l => /trial p resumed/.test(l)));
  fs.rmSync(path.join(T, 'company/work/models/routing-policy.json'));
});
