#!/usr/bin/env node
/* routing-scoped.test.js — scoped routing (docs/ROUTING.md "Scoped routing", docs/RANKING.md §3 and §11): the job's depth
 * and kind (lib/depth.js), the capability table from the bench and from validated live work (lib/capability.js), the
 * router's pick (lib/routing.js scoped step: the gate, efficiency over time and each model's OWN limit, free models
 * neither favoured nor penalised, the tie-break, the routable switch, escalation, the chain as the fallback, the kill
 * switch, the allowlist listing), the ranking's new rule pieces, and the owner-only switches (models.js routable,
 * routing.js scoped, console/routing.js). Every fixture is built here; invented crew; no station, no model.
 *
 *   node --test company/tools/tests/routing-scoped.test.js
 */
'use strict';
process.env.CAPHEOS_TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.join(__dirname, '..');
const REPO = path.join(TOOLS, '..', '..');
const R = require('../lib/routing');
const D = require('../lib/depth');
const C = require('../lib/capability');
const MR = require('../model-rank.js');
const FM = require('../lib/free-models');
const DEFAULT = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'defaults', 'work', 'models', 'routing-policy.json'), 'utf8'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const K = R.knobs(DEFAULT);
const KS = K.scoped;
const HAIKU = { provider: 'claude-cli', model: 'haiku' };
const SONNET = { provider: 'claude-cli', model: 'claude-sonnet-5-5' };
const OPUS = { provider: 'claude-cli', model: 'claude-opus-5-5' };
const FLASH = { provider: 'deepseek', model: 'deepseek-flash' };
const MM = { provider: 'custom', model: 'MiniMax-M3.1-Flash' };
const FREE = { provider: 'openrouter', model: 'acme/tiny-chat:free' };
const key = p => p.provider + '/' + p.model;
const item = (text, id) => ({ text: '## task\n' + (text || '') + '\n**Status:** OPEN\n', id: id || 'to-dev.md#aaaaaa' });

/* a bench result: proven depth per kind, with per-depth time and tokens */
function bench(pair, kinds, o) {
  o = o || {};
  const res = { schema: 'model-bench/1', model: key(pair), benchVersion: '1.0.0', ranAt: '2030-01-01T00:00:00.000Z', kinds: {} };
  for (const [k, proven] of Object.entries(kinds)) {
    const levels = {};
    for (const d of D.DEPTHS) levels[d] = { tasks: 5, instances: 5, passRate: D.depthIndex(d) <= D.depthIndex(proven) ? 1 : 0.4, timeSecP50: (o.time || 10) * (D.depthIndex(d) + 1), timeSecMax: 100, tokensIn: (o.tokens || 1000) * 5, tokensOut: 0, failures: {} };
    res.kinds[k] = { proven, gaps: [], levels };
  }
  return res;
}
function capOf(results, live) { return C.build({ bench: results, live: live || [], passMark: 0.9, minItems: 5, now: Date.UTC(2030, 0, 2) }).doc; }
/* one wake's decision with a scoped context */
function decide(o) {
  return R.decide(Object.assign({ K: o.K || K, seat: 'dev', wakeId: o.wakeId || 'wk-1', departments: { departments: [] }, crew: { dev: { name: 'Dev' } }, held: [],
    chain: o.chain || [SONNET], current: o.current || SONNET, allow: o.allow === undefined ? [HAIKU, SONNET, OPUS, FLASH, MM, FREE] : o.allow, items: o.items || [item('**Class:** writing')],
    scoped: Object.assign({ capability: o.cap, candidates: o.candidates || [HAIKU, SONNET, OPUS, FLASH, MM, FREE], limits: o.limits || { subs: { 'claude-cli': { leftTokens: 1e6 }, custom: { leftTokens: 1e6 } }, railLeftUsd: 10, freeLeft: 40 }, wakes: o.wakes || [], classDepth: o.classDepth || {} }, o.scoped || {}) }, o.extra || {}));
}

/* ---------------- (1) depth and kind ---------------- */
test('depth: the class baseline, a Depth line, effort, size, and the kind map (code simple = kind 6, standard = kind 7)', () => {
  const ctx = c => ({ seat: 'dev', class: c, K: KS, heavyEscape: 'heavy' });
  assert.equal(D.estimate([item('**Class:** research')], ctx('research')).depth, 'lookup');
  assert.equal(D.estimate([item('**Class:** research')], ctx('research')).kind, 1, 'research at lookup is kind 1');
  assert.equal(D.estimate([item('**Class:** writing')], ctx('writing')).depth, 'simple');
  const code = D.estimate([item('**Class:** code')], ctx('code'));
  assert.deepEqual([code.depth, code.kind], ['standard', 7]);
  assert.deepEqual(code.needs, [{ kind: 7, depth: 'standard' }, { kind: 9, depth: 'simple' }], 'code also needs tool use at simple');
  const small = D.estimate([item('**Class:** code\n**Depth:** simple')], ctx('code'));
  assert.deepEqual([small.depth, small.kind, small.explicit], ['simple', 6, true], 'an explicit Depth line wins');
  assert.equal(D.estimate([item('**Class:** code\n**Effort:** mechanical')], ctx('code')).depth, 'simple', 'mechanical caps at simple');
  assert.equal(D.estimate([item('**Class:** writing\n**Effort:** heavy')], ctx('writing')).depth, 'deep', 'the heavy word makes it deep');
  assert.equal(D.estimate([item('**Class:** writing\n**Touches:** a.md, b.md, c.md')], ctx('writing')).depth, 'standard', 'three paths: at least standard');
  assert.equal(D.estimate([item('**Class:** writing\n' + 'x'.repeat(9000))], ctx('writing')).depth, 'deep', 'a long block: deep');
  assert.equal(D.estimate([item('**Class:** writing\n**Kind:** 5')], ctx('writing')).kind, 5, 'a Kind line wins');
  assert.equal(D.estimate([item('**Class:** writing')], Object.assign(ctx('writing'), { classDepth: { writing: 'standard' } })).depth, 'standard', 'the drifted baseline wins over the shipped one');
  const two = D.estimate([item('**Class:** writing', 'a'), item('**Class:** writing\n**Depth:** deep', 'b')], ctx('writing'));
  assert.equal(two.depth, 'deep', 'several items: the deepest');
});

test('escalation: a REVISE line or repeated routed wakes move the item one level up each and exclude the model that worked it', () => {
  const ctx = { seat: 'dev', class: 'writing', K: KS };
  const once = D.estimate([item('**Class:** writing\n**Verdict:** REVISE by Ria — check: read it — wrong totals')], ctx);
  assert.deepEqual([once.depth, once.fails], ['standard', 1]);
  const wk = (n, pair) => ({ at: n, items: [{ id: 'to-dev.md#aaaaaa' }], route: { provider: pair.provider, model: pair.model, scoped: { kind: 3, depth: 'simple' } } });
  const wakes = [wk(1, HAIKU), wk(2, HAIKU), wk(3, SONNET)];
  const r = D.estimate([item('**Class:** writing')], Object.assign({}, ctx, { wakes }));
  assert.equal(r.depth, 'standard', '3 routed wakes, 2 free: one level up');
  assert.deepEqual(r.exclude, [key(SONNET)], 'the newest model that worked it');
  assert.equal(D.estimate([item('**Class:** writing\n**Reopened 2030-01-02**\n**Verdict:** REVISE by x — check: y')], Object.assign({}, ctx, { wakes })).depth, 'deep', 'capped at deep');
});

/* ---------------- (2) the capability table ---------------- */
test('capability: the bench sets current; live failures drop it, live successes raise it, one move per refresh; a new model is null', () => {
  const cap = capOf([bench(HAIKU, { 3: 'simple' })]);
  assert.equal(C.currentOf(cap, HAIKU, 3).current, 'simple');
  assert.equal(C.currentOf(cap, SONNET, 3).entry, null, 'not in the table');
  const drop = C.build({ bench: [bench(HAIKU, { 3: 'simple' })], live: [{ model: key(HAIKU), kind: 3, depth: 'simple', n: 10, oneShot: 5 }], prev: cap, passMark: 0.9, minItems: 5 });
  assert.equal(C.currentOf(drop.doc, HAIKU, 3).current, 'lookup');
  assert.deepEqual(drop.moves.map(m => [m.op, m.from, m.to]), [['drop', 'simple', 'lookup']]);
  const raise = C.build({ bench: [bench(HAIKU, { 3: 'simple' })], live: [{ model: key(HAIKU), kind: 3, depth: 'standard', n: 40, oneShot: 40 }], prev: cap, passMark: 0.9, minItems: 5 });
  assert.equal(C.currentOf(raise.doc, HAIKU, 3).current, 'standard');
  const fresh = C.build({ bench: [], live: [{ model: key(FREE), kind: 3, depth: 'lookup', n: 2, oneShot: 2 }], passMark: 0.9, minItems: 5 });
  assert.equal(C.currentOf(fresh.doc, FREE, 3).current, null, 'no bench, too little live: still null');
  const again = C.build({ bench: [bench(HAIKU, { 3: 'deep' })], live: [], prev: drop.doc, passMark: 0.9, minItems: 5 });
  assert.equal(C.currentOf(again.doc, HAIKU, 3).current, 'deep', 'a new bench result resets current');
  const kept = C.build({ bench: [bench(HAIKU, { 3: 'simple' })], live: [], prev: drop.doc, passMark: 0.9, minItems: 5 });
  assert.equal(C.currentOf(kept.doc, HAIKU, 3).current, 'lookup', 'the same bench result keeps the live correction');
});

test('capability: the live record comes from scored items with route.scoped, and the bench files are read (stub and .prev left out)', () => {
  const an = { items: [
    { excluded: false, settled: true, cell: { model: key(HAIKU), class: 'writing' }, scoped: { kind: 3, depth: 'simple' }, oneShot: 1, timeSec: 60 },
    { excluded: false, settled: true, cell: { model: key(HAIKU), class: 'writing' }, scoped: { kind: 3, depth: 'simple' }, oneShot: 0, timeSec: 120 },
    { excluded: false, settled: false, cell: { model: key(HAIKU), class: 'writing' }, scoped: { kind: 3, depth: 'simple' }, oneShot: 1 },
    { excluded: false, settled: true, cell: { model: key(HAIKU), class: 'writing' }, scoped: null, oneShot: 1 }] };
  assert.deepEqual(MR.capabilityLive(an, { countUnsettled: false }), [{ model: key(HAIKU), kind: 3, depth: 'simple', n: 2, oneShot: 1, timeSecP50: 90 }]);
  const T = require('../lib/temp-life').tmpDir('scoped-bench-'); roots.push(T);
  const dir = path.join(T, C.BENCH_DIR); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude-cli_haiku.json'), JSON.stringify(bench(HAIKU, { 1: 'deep' })));
  fs.writeFileSync(path.join(dir, 'claude-cli_haiku.prev.json'), JSON.stringify(bench(HAIKU, { 1: 'lookup' })));
  fs.writeFileSync(path.join(dir, 'stub_good.json'), JSON.stringify(bench({ provider: 'stub', model: 'good' }, { 1: 'deep' })));
  fs.writeFileSync(path.join(dir, 'limits.json'), '{"subscriptionPctPerRun": 5}');
  assert.deepEqual(C.benchResults(T).map(r => r.model), [key(HAIKU)]);
});

test('class drift: a class whose routed items keep needing escalation moves up one level, at most once per week', () => {
  const it = (esc, one) => ({ excluded: false, settled: true, closedAt: 1, cell: { model: key(SONNET), class: 'writing' }, scoped: { kind: 3, depth: 'simple', escalated: esc, fromBaseline: true }, oneShot: one });
  const items = []; for (let i = 0; i < 20; i++) items.push(it(i < 8 ? 1 : 0, 1));
  const routing = { scoped: Object.assign({}, DEFAULT.scoped) };
  const now = Date.UTC(2030, 1, 1);
  const r = MR.classDrift({ items }, { countUnsettled: false }, capOf([bench(SONNET, { 3: 'deep' })]), routing, null, now);
  assert.deepEqual(r.moves.map(m => [m.class, m.from, m.to]), [['writing', 'simple', 'standard']]);
  const again = MR.classDrift({ items }, { countUnsettled: false }, capOf([]), routing, r.doc, now + 86400e3);
  assert.deepEqual(again.moves, [], 'no second step within everyDays');
  const easy = []; for (let i = 0; i < 20; i++) easy.push(it(0, 1));
  const down = MR.classDrift({ items: easy }, { countUnsettled: false }, capOf([bench(SONNET, { 3: 'lookup' })]), routing, null, now);
  assert.deepEqual(down.moves.map(m => [m.from, m.to]), [['simple', 'lookup']], 'done one-shot by a model proven below: easier than thought');
});

/* ---------------- (3) the router ---------------- */
test('the gate: only models proven at the job\'s depth for its kind are candidates; nothing qualifies = the chain runs, recorded', () => {
  const none = decide({ cap: capOf([]) });
  assert.equal(none.applied, false); assert.equal(none.source, 'chain');
  assert.equal(none.scoped.pick, null); assert.match(none.scoped.why, /no routable model .* proven at simple on kind 3: the chain runs/);
  assert.equal(none.scoped.kind, 3); assert.equal(none.scoped.depth, 'simple');
  const cap = capOf([bench(HAIKU, { 3: 'lookup' }), bench(SONNET, { 3: 'deep' })]);
  const d = decide({ cap, current: OPUS, chain: [OPUS, SONNET] });
  assert.equal(d.applied, true); assert.equal(d.source, 'scoped'); assert.deepEqual([d.provider, d.model], ['claude-cli', 'claude-sonnet-5-5']);
  assert.match(d.scoped.candidates.find(c => c.model === key(HAIKU)).out, /proven to lookup on kind 3, needs simple/);
  assert.ok(R.line('dev', d).includes('scoped 3/simple -> claude-cli/claude-sonnet-5-5'), R.line('dev', d));
  assert.deepEqual(R.overrideOf(d), { provider: 'claude-cli', model: 'claude-sonnet-5-5' });
});

test('efficiency: among models that clear the bar the quicker one that uses less of its own limit wins; cost alone never decides', () => {
  // Haiku and Sonnet both proven; Haiku is three times faster and lighter on the same subscription
  const cap = capOf([bench(HAIKU, { 3: 'deep' }, { time: 10, tokens: 1000 }), bench(SONNET, { 3: 'deep' }, { time: 30, tokens: 3000 }), bench(OPUS, { 3: 'deep' }, { time: 90, tokens: 9000 })]);
  const d = decide({ cap });
  assert.equal(d.scoped.pick, key(HAIKU));
  const rows = Object.fromEntries(d.scoped.candidates.filter(c => !c.out).map(c => [c.model, c]));
  assert.ok(rows[key(HAIKU)].eff < rows[key(SONNET)].eff && rows[key(SONNET)].eff < rows[key(OPUS)].eff);
  // a metered model that is cheap per token but slow does not win on price
  const cap2 = capOf([bench(SONNET, { 3: 'deep' }, { time: 10, tokens: 3000 }), bench(FLASH, { 3: 'deep' }, { time: 60, tokens: 3000 })]);
  const d2 = decide({ cap: cap2, limits: { subs: { 'claude-cli': { leftTokens: 3e6 } }, railLeftUsd: 10, freeLeft: 40 } });
  assert.equal(d2.scoped.pick, key(SONNET), 'time counts: the fast subscription model beats the slow metered one');
});

test('free models are full candidates: never at zero share, picked when they are the most efficient, not just as a last resort', () => {
  const cap = capOf([bench(FREE, { 3: 'deep' }, { time: 10, tokens: 1000 }), bench(SONNET, { 3: 'deep' }, { time: 10, tokens: 1000 })]);
  const plenty = decide({ cap, limits: { subs: { 'claude-cli': { leftTokens: 1e5 } }, railLeftUsd: 10, freeLeft: 1000 } });
  const free = plenty.scoped.candidates.find(c => c.model === key(FREE));
  assert.ok(free.share > 0, 'a free model pays in requests: its share is never 0');
  assert.equal(plenty.scoped.pick, key(FREE), 'equal time, a smaller share of its own allowance: the free model');
  const scarce = decide({ cap, limits: { subs: { 'claude-cli': { leftTokens: 1e9 } }, railLeftUsd: 10, freeLeft: 3 } });
  assert.equal(scarce.scoped.pick, key(SONNET), 'nearly out of free requests: the subscription model');
  assert.match(free.shareBasis, /free: 3 request\(s\) of 1000 left today/);
});

test('tie-break: within tieEpsilon the larger quality margin wins', () => {
  const cap = capOf([bench(HAIKU, { 3: 'deep' }, { time: 10 }), bench(SONNET, { 3: 'deep' }, { time: 10 })]);
  // equal time and tokens; Sonnet has a better live record at simple
  cap.models[key(SONNET)].kinds['3'].live.simple = { n: 40, oneShot: 40, lower: 0.97, upper: 1, timeSecP50: null };
  cap.models[key(HAIKU)].kinds['3'].live.simple = { n: 40, oneShot: 37, lower: 0.86, upper: 0.97, timeSecP50: null };
  const d = decide({ cap });
  assert.equal(d.scoped.pick, key(SONNET)); assert.match(d.scoped.why, /tie of 2 broken by quality margin/);
});

test('filters only: not open, the class rules, and the candidates list (routable) keep a model out; availability never ranks', () => {
  const cap = capOf([bench(HAIKU, { 6: 'deep', 7: 'deep', 9: 'deep' }), bench(MM, { 6: 'deep', 7: 'deep', 9: 'deep' }, { time: 1, tokens: 10 })]);
  const code = decide({ cap, items: [item('**Class:** code')] });
  assert.equal(code.scoped.pick, key(HAIKU), 'code never on the MiniMax plan, however efficient');
  assert.match(code.scoped.candidates.find(c => c.model === key(MM)).out, /class rules/);
  const closed = decide({ cap, items: [item('**Class:** code')], allow: [SONNET] });
  assert.equal(closed.scoped.pick, null); assert.match(closed.scoped.candidates.find(c => c.model === key(HAIKU)).out, /not open/);
  const noAllow = decide({ cap, allow: null });
  assert.equal(noAllow.applied, false); assert.match(noAllow.scoped.why, /no current override allowlist/);
});

test('the routable switch: Fable ships off, a CEO-approval model is off until the owner says so, an owner key wins', () => {
  const mp = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'model-policy.json'), 'utf8'));
  assert.equal(C.routable({ provider: 'claude-cli', model: 'claude-fable-5-2[1m]' }, mp).ok, false);
  assert.equal(C.routable(OPUS, mp).ok, false, 'needsCeoApproval');
  assert.equal(C.routable(HAIKU, mp).ok, true);
  const on = Object.assign({}, mp, { routable: Object.assign({}, mp.routable, { 'claude-cli/claude-opus-5-5': true }) });
  assert.equal(C.routable(OPUS, on).ok, true);
  const longest = { routable: { 'claude-cli/claude-fable*': false, 'claude-cli/claude-fable-5-2[1m]': true } };
  assert.equal(C.routable({ provider: 'claude-cli', model: 'claude-fable-5-2[1m]' }, longest).ok, true, 'the longest key wins');
  const cands = C.candidates(Object.assign({}, mp, { allowed: Object.assign({}, mp.allowed, { 'claude-cli': { models: ['haiku', 'claude-opus-5-5', 'claude-fable-5-2[1m]'] } }) }), { capability: null, freeRegistry: null });
  assert.ok(cands.some(p => key(p) === key(HAIKU)) && !cands.some(p => /opus|fable/.test(p.model)), JSON.stringify(cands));
});

test('escalation in the router: a reworked item goes one level up to another model that clears it', () => {
  const cap = capOf([bench(HAIKU, { 3: 'simple' }, { time: 5 }), bench(SONNET, { 3: 'standard' }, { time: 20 })]);
  const first = decide({ cap });
  assert.equal(first.scoped.pick, key(HAIKU));
  const wakes = [{ at: 1, items: [{ id: 'to-dev.md#aaaaaa' }], route: { provider: HAIKU.provider, model: HAIKU.model, scoped: { kind: 3, depth: 'simple' } } }];
  const retry = decide({ cap, wakes, items: [item('**Class:** writing\n**Verdict:** REVISE by Ria — check: read it — wrong')] });
  assert.equal(retry.scoped.depth, 'standard'); assert.equal(retry.scoped.escalated, 1);
  assert.equal(retry.scoped.pick, key(SONNET));
  assert.deepEqual(retry.scoped.exclude, [key(HAIKU)]);
  // at deep with nothing proven there: the chain runs and says so
  const deep = decide({ cap, items: [item('**Class:** writing\n**Depth:** deep')] });
  assert.equal(deep.applied, false); assert.match(deep.scoped.why, /deep .*\(the deepest level\): the chain runs/);
});

test('a new model with no bench result gets a small share of shallow jobs; never a deep one', () => {
  const cap = capOf([]);
  cap.models[key(FREE)] = undefined; delete cap.models[key(FREE)];
  const K2 = R.knobs(Object.assign({}, DEFAULT, { scoped: Object.assign({}, DEFAULT.scoped, { newModel: { share: 1, depths: ['lookup', 'simple'] } }) }));
  const d = decide({ K: K2, cap, candidates: [FREE] });
  assert.equal(d.scoped.pick, key(FREE)); assert.equal(d.scoped.newModel, true);
  const deep = decide({ K: K2, cap, candidates: [FREE], items: [item('**Class:** writing\n**Depth:** deep')] });
  assert.equal(deep.scoped.pick, null);
});

test('a wake with no item runs on its chain; the pick equal to the seat\'s own model is no override', () => {
  const cap = capOf([bench(SONNET, { 3: 'deep', 10: 'deep' })]);
  const loop = decide({ cap, items: [] });
  assert.equal(loop.applied, false); assert.match(loop.scoped.why, /no handoff item/);
  const same = decide({ cap, candidates: [SONNET] });
  assert.equal(same.applied, false); assert.equal(same.source, 'scoped'); assert.equal(same.scoped.applied, true); assert.equal(same.scoped.override, false);
  assert.equal(R.overrideOf(same), null);
});

test('kill switch: scoped off skips the step entirely (no route.scoped, no extra allowlist entries)', () => {
  const off = R.knobs(Object.assign({}, DEFAULT, { scoped: Object.assign({}, DEFAULT.scoped, { enabled: false }) }));
  assert.ok(!off.order.includes('scoped') || !off.scoped.enabled);
  const d = decide({ K: off, cap: capOf([bench(HAIKU, { 3: 'deep' })]) });
  assert.equal(d.scoped, undefined); assert.equal(d.source, 'chain');
  assert.deepEqual(R.extraEntries('dev', { K: off, departments: { departments: [] }, crew: {}, chain: [], scopedCandidates: [HAIKU] }), []);
  const on = R.extraEntries('dev', { K, departments: { departments: [] }, crew: {}, chain: [], scopedCandidates: [HAIKU, FREE] });
  assert.deepEqual(on, [HAIKU, FREE].map(p => ({ provider: p.provider, model: p.model })), 'on: every routable candidate is listed (override-allow still evaluates each)');
});

test('prepare() builds the scoped context from the company files: capability, candidates, limits, wakes; forWake passes item ids', async () => {
  const T = require('../lib/temp-life').tmpDir('scoped-prepare-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
  w('company/work/models/routing-policy.json', Object.assign({}, DEFAULT, { scoped: Object.assign({}, DEFAULT.scoped, { limits: Object.assign({}, DEFAULT.scoped.limits, { subscriptionWeeklyTokens: { 'claude-cli': 1000000 } }) }) }));
  w('company/model-policy.json', { allowed: { 'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-fable-5-2'] }, deepseek: { models: ['deepseek-flash'] } }, routable: { 'claude-cli/claude-fable*': false }, needsCeoApproval: [], freeFallback: { dailyRequests: 50 }, seats: { dev: { chain: [SONNET] } } });
  w('company/tools/loops.json', { agents: { dev: { name: 'Dev', inbox: 'to-dev.md' } } });
  w(C.REL, capOf([bench(HAIKU, { 3: 'deep' })]));
  const m = { claude: { known: true, open: true, usedPct: 40, weekCap: 90 }, minimax: { known: true, open: true, usedPct: 0 }, rail: { pct: 20, perDay: 25 } };
  const ctx = await R.prepare({ root: T, m, held: [] });
  assert.ok(ctx && ctx.scoped);
  assert.deepEqual(ctx.scoped.candidates.map(key).sort(), ['claude-cli/claude-sonnet-5-5', 'claude-cli/haiku', 'deepseek/deepseek-flash']);
  assert.equal(ctx.scoped.limits.subs['claude-cli'].leftTokens, 500000, '(90 - 40)% of a million');
  assert.equal(ctx.scoped.limits.railLeftUsd, 20); assert.equal(ctx.scoped.limits.freeLeft, 50);
  w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: { dev: [HAIKU, SONNET] } });
  const d = R.forWake(ctx, { seat: 'dev', wakeId: 'wk-9', job: { id: 'j', wire: SONNET }, items: [item('**Class:** writing')] });
  assert.equal(d.scoped.pick, key(HAIKU)); assert.equal(d.applied, true);
});

/* ---------------- (6) the ranking's pieces ---------------- */
test('the ranking: no model is free in the score; free models that clear the bar are ordered by efficiency', () => {
  const Kr = MR.knobs(JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'defaults', 'work', 'models', 'ranking-policy.json'), 'utf8')));
  assert.equal(Kr.scoreRule, 'bar-then-efficiency'); assert.equal(MR.barOf(Kr, 'code'), 0.8);
  const free = MR.limitShareOf({ provider: 'openrouter', modelId: 'acme/tiny-chat:free' }, { runs: 2, tokens: 1e5, usd: 0 }, Kr);
  assert.ok(free.share > 0 && /free requests/.test(free.basis));
  const reg = { models: [{ id: 'a:free', tools: true }, { id: 'b:free', tools: true }, { id: 'c:free', tools: true }] };
  const ranking = { cells: [
    { provider: 'openrouter', modelId: 'a:free', class: 'code', items: 30, lower: 0.95, passesBar: true, eff: 0.9 },
    { provider: 'openrouter', modelId: 'b:free', class: 'code', items: 30, lower: 0.85, passesBar: true, eff: 0.4 },
    { provider: 'openrouter', modelId: 'c:free', class: 'code', items: 30, lower: 0.97, passesBar: false, eff: null }] };
  assert.deepEqual(FM.order(reg, ranking, { cls: 'code', minItems: 5 }), ['b:free', 'a:free', 'c:free']);
});

/* ---------------- (5)(7) the owner's switches ---------------- */
function fixture() {
  const T = require('../lib/temp-life').tmpDir('scoped-owner-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' } } });
  w('company/model-policy.json', { allowed: { 'claude-cli': { models: ['haiku', 'claude-sonnet-5-5'] } }, needsCeoApproval: [], seats: {} });
  w('company/defaults/work/models/routing-policy.json', JSON.stringify(Object.assign({}, DEFAULT, { scoped: undefined, order: ['classRules', 'trial', 'route', 'tierCap', 'chain'] })));
  // the company copy predates scoped routing (no scoped block); the framework default has it
  w('company/work/models/routing-policy.json', JSON.stringify(Object.assign({}, DEFAULT, { scoped: undefined, _scoped: undefined, order: ['classRules', 'trial', 'route', 'tierCap', 'chain'] })));
  fs.writeFileSync(path.join(T, 'company/defaults/work/models/routing-policy.json'), JSON.stringify(DEFAULT));
  w('company/work/decisions.md', '# Decisions\n\n');
  return T;
}
function child(T, code, owner) {
  const pre = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (owner ? 'true' : 'false') + ');';
  const r = spawnSync(process.execPath, ['-e', pre + code], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_READONLY: '' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const routable = (T, pair, v, by, owner) => child(T, 'const M = require(' + JSON.stringify(path.join(TOOLS, 'models.js')) + ').makeModels({ quiet: true }); process.stdout.write(JSON.stringify(M.setRoutable({ pair: ' + JSON.stringify(pair) + ', value: ' + JSON.stringify(v) + ', by: ' + JSON.stringify(by) + ', why: "test" })));', owner);
const scoped = (T, v, by, owner) => child(T, 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').run(["scoped", ' + JSON.stringify(v) + ', "--by", ' + JSON.stringify(by) + '])));', owner);

test('models.js routable: owner only (a seat and "--by owner" outside the owner\'s shell are refused); recorded and read by the router', () => {
  const T = fixture();
  assert.match(routable(T, 'claude-cli/haiku', 'off', 'Hal', true).error, /owner's decision/);
  assert.match(routable(T, 'claude-cli/haiku', 'off', 'owner', false).error, /owner's own interactive shell or the console/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(T, 'company/model-policy.json'), 'utf8')).routable, undefined, 'nothing written');
  const ok = routable(T, 'claude-cli/haiku', 'off', 'owner', true);
  assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.changed, true);
  const mp = JSON.parse(fs.readFileSync(path.join(T, 'company/model-policy.json'), 'utf8'));
  assert.equal(mp.routable['claude-cli/haiku'], false); assert.equal(mp.routable._set['claude-cli/haiku'].by, 'owner');
  assert.equal(C.routable(HAIKU, mp).ok, false);
  assert.ok(!R.scopedCandidates(T).some(p => key(p) === key(HAIKU)), 'the router no longer lists it');
  assert.match(fs.readFileSync(path.join(T, 'company/work/decisions.md'), 'utf8'), /claude-cli\/haiku is not picked automatically/);
  assert.equal(routable(T, 'claude-cli/haiku', 'off', 'owner', true).changed, false, 'the same again changes nothing');
  assert.match(routable(T, 'not a pair', 'on', 'owner', true).error, /provider\/model/);
});

test('routing.js scoped on|off: owner only; off is recorded; on brings the default block into an older company copy', () => {
  const T = fixture();
  assert.match(scoped(T, 'on', 'Hal', true).out.error, /owner's decision/);
  const on = scoped(T, 'on', 'owner', true);
  assert.equal(on.code, 0, JSON.stringify(on)); assert.equal(on.out.changed, true);
  let doc = JSON.parse(fs.readFileSync(path.join(T, 'company/work/models/routing-policy.json'), 'utf8'));
  assert.equal(doc.scoped.enabled, true); assert.ok(doc.scoped.kinds && doc.order.includes('scoped'), 'the default block and the step');
  const off = scoped(T, 'off', 'owner', true);
  assert.equal(off.out.changed, true);
  doc = JSON.parse(fs.readFileSync(path.join(T, 'company/work/models/routing-policy.json'), 'utf8'));
  assert.equal(doc.scoped.enabled, false); assert.equal(R.knobs(doc).scoped.enabled, false);
  const log = fs.readFileSync(path.join(T, 'company/work/models/routing-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(r => [r.op, r.from, r.to, r.by]), [['scoped', 'off', 'on', 'owner'], ['scoped', 'on', 'off', 'owner']]);
});

test('the console routes run the tools as the owner with fixed arguments', async () => {
  const calls = [], routes = [];
  require(path.join(REPO, 'console', 'routing.js')).mount((m, re, fn) => routes.push([m, re, fn]), {
    runApi: async (name, args) => { calls.push([name].concat(args)); return { ok: true }; }, bad: msg => { throw new Error(msg); }, owner: () => 'Olive' });
  const hit = async (m, p, b) => { for (const [mm, re, fn] of routes) { const x = mm === m && re.exec(p); if (x) return fn(x, null, b); } throw new Error('no route ' + p); };
  await hit('POST', '/api/routing/scoped', { on: false, why: 'pause it' });
  await hit('GET', '/api/models/routable');
  await hit('POST', '/api/models/routable', { pair: 'claude-cli/claude-fable-5-2[1m]', on: true });
  await assert.rejects(() => hit('POST', '/api/routing/scoped', { on: 'yes' }));
  await assert.rejects(() => hit('POST', '/api/models/routable', { pair: '--by owner', on: true }));
  await assert.rejects(() => hit('POST', '/api/models/routable', { pair: 'claude-cli/haiku' }));
  assert.deepEqual(calls, [['routing.js', 'scoped', 'off', '--by', 'Olive', '--why', 'pause it'], ['models.js', 'routable', '--json'], ['models.js', 'routable', 'claude-cli/claude-fable-5-2[1m]', 'on', '--by', 'Olive']]);
});

test('the console page says it plainly: what a model has shown it can do, and the switch words', async () => {
  const E = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'settings', 'auto-picks.js')).catch(() => null);
  if (!E) return;   // the page module imports the browser kit; the words are checked where it loads
  assert.match(E.provenLine({ proven: [{ kind: 3, depth: 'simple' }] }), /Has shown it can do: simple writing/);
  assert.match(E.provenLine({ proven: [] }), /Not tested yet/);
});

test('the bench fills limitSharePct for a subscription model from subscriptionWeeklyTokens (null for others)', () => {
  const B = require(path.join(REPO, 'packs', 'model-bench', 'lib', 'bench.js'));
  const unit = path.join(REPO, 'packs', 'model-bench');
  const tasks = [{ id: 'k1-lookup-01', kind: 1, depth: 'lookup', version: 1 }];
  const recs = [{ task: 'k1-lookup-01', pass: true, timeSec: 2, tokensIn: 4000, tokensOut: 1000 }];
  const cfg = B.config(unit, { subscriptionWeeklyTokens: { 'claude-cli': 1000000 } });
  assert.equal(B.aggregate(unit, 'claude-cli/haiku', tasks, recs, { cfg, seed: 0 }).kinds['1'].levels.lookup.limitSharePct, 0.5);
  assert.equal(B.aggregate(unit, 'deepseek/deepseek-flash', tasks, recs, { cfg, seed: 0 }).kinds['1'].levels.lookup.limitSharePct, null);
});

test('model-rank.js refresh writes the capability table (recorded as its own write); a live drop is a move; a rerun rewrites nothing', () => {
  const T = require('../lib/temp-life').tmpDir('scoped-refresh-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', timezone: 'UTC', owner: { name: 'Olive' } });
  w('company/tools/loops.json', { agents: {} });
  w('company/work/models/ranking-policy.json', fs.readFileSync(path.join(TOOLS, '..', 'defaults', 'work', 'models', 'ranking-policy.json'), 'utf8'));
  w('company/work/models/routing-policy.json', DEFAULT);
  w('company/state/model-bench/claude-cli_haiku.json', bench(HAIKU, { 3: 'simple' }));
  const now = Date.UTC(2030, 1, 1);
  const run = spawnSync(process.execPath, [path.join(TOOLS, 'model-rank.js'), 'refresh', '--force', '--now', String(now)], { encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }) });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const cap = C.load(T);
  assert.equal(C.currentOf(cap, HAIKU, 3).current, 'simple');
  const prov = fs.readFileSync(path.join(T, 'company/state/locked/provenance.jsonl'), 'utf8');
  assert.ok(prov.split('\n').some(l => l.includes('model-capability.json') && l.includes('model-rank.js')), 'recorded for locked-watch (class R, writer model-rank.js)');
  // a stored live correction (a drop the table made earlier) is reported back as the current depth on the next refresh
  cap.models[key(HAIKU)].kinds['3'].live.simple = { n: 30, oneShot: 10 };
  const again = C.build({ bench: C.benchResults(T), live: [{ model: key(HAIKU), kind: 3, depth: 'simple', n: 30, oneShot: 10 }], prev: cap, passMark: 0.9, minItems: 20 });
  assert.deepEqual(again.moves.map(m => m.op), ['drop']);
  const r2 = MR.refresh({ root: T, now: now + 3600e3, force: true });
  assert.equal(r2.scoped.capChanged, false, 'the same inputs: not rewritten');
});
