#!/usr/bin/env node
/* model-rank-trials.test.js — the trial and tier-cap evaluation of company/tools/model-rank.js (docs/RANKING.md §10):
 * a 3-arm trial below and above minItemsPerArm, the decision rule both ways, served-vs-requested mismatches, shadow-only and
 * mixed-arm items, deterministic decision files, the tier-cap verdict both ways, and the house-ranking duty lines.
 * Every fixture is built here, in a temporary folder (invented crew: Lee, Sam, Kim, Ria).
 *
 *   node --test company/tools/tests/model-rank-trials.test.js
 */
'use strict';
process.env.CAPHEOS_TZ = 'UTC';   // before lib/company.js is loaded: close stamps read as UTC, as the child does
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const TOOLS = path.join(__dirname, '..');
const TOOL = path.join(TOOLS, 'model-rank.js');
const M = require(TOOL);
const DEFAULT_POLICY = path.join(TOOLS, '..', 'defaults', 'work', 'models', 'ranking-policy.json');
const NOW = Date.UTC(2030, 1, 1);
const H = 3600e3, D = 24 * H;
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const ARMS = [
  { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' },
  { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' },
  { provider: 'claude-cli', model: 'claude-fable-5-2', effort: 'medium' },
];
const TOKENS = { 'claude-sonnet-5-5': [400000, 300000], 'claude-opus-5-5': [500000, 380000], 'claude-fable-5-2': [600000, 450000] };

/* build({ arms: [{n, fails}], tier: {capped: {n, fails}, baseline: {n, fails}}, extra: fn(ctx) }) -> root */
function build(o) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'model-rank-trials-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n'); };
  const policy = JSON.parse(fs.readFileSync(DEFAULT_POLICY, 'utf8'));
  w('company/work/models/ranking-policy.json', Object.assign(policy, o.policy || {}));
  w('company/company.json', { name: 'Fixture Co', timezone: 'UTC', owner: { name: 'Owner' } });
  w('company/tools/loops.json', { agents: {
    lee: { name: 'Lee', functions: ['ceo', 'people'], inbox: 'to-lee.md', manager: null },
    sam: { name: 'Sam', inbox: 'to-sam.md', manager: 'lee' }, kim: { name: 'Kim', inbox: 'to-kim.md', manager: 'lee' }, ria: { name: 'Ria', inbox: 'to-ria.md', manager: 'lee' },
  } });
  w('company/departments.json', { departments: [{ id: 'eng', name: 'Engineering', lead: 'lee', members: ['sam', 'kim', 'ria'], defaultClass: 'code', routes: {} }] });
  w('company/work/models/routing-policy.json', Object.assign({ mode: 'live', tierCaps: { mode: 'shadow' },
    trials: [{ id: 't-code', class: 'code', arms: ARMS, scope: { departments: ['eng'], seats: [] }, entryShare: 0.1, status: 'running', pauseWhenHeld: ['claude-cli'], minItemsPerArm: 30, startedAt: '2030-01-02T00:00:00.000Z', startedBy: 'owner' }] }, o.routing || {}));
  const inbox = { 'to-sam.md': ['# Sam inbox\n'], 'to-kim.md': ['# Kim inbox\n'] }, wakes = [], runs = [];
  let seq = 0;
  const ctx = {
    item(seat, id, d, spec, route, x) {
      x = x || {};
      const file = 'to-' + seat + '.md', at = Date.UTC(2030, 0, d) + 10 * H + (seq % 50) * 60e3, closed = at + 4 * H;
      const runId = 'run-' + id + '-' + String(++seq).padStart(4, '0');
      const [tokens, cached] = x.tokens || TOKENS[spec.model] || [300000, 200000];
      const r = { runId, parentRunId: '', agentId: seat, provider: spec.provider, model: x.runModel || spec.model, reasoningEffort: spec.effort, reason: 'done', turns: 8, tokens, cachedTokens: cached, usd: 0, unmetered: true, startedAt: at + 60e3, endedAt: at + 31 * 60e3, ts: at + 31 * 60e3 };
      if (x.served !== null) r.servedModel = x.served || x.runModel || spec.model;
      runs.push(r);
      const wake = { at, ts: new Date(at).toISOString(), wakeId: 'wk-' + String(wakes.length + 1).padStart(4, '0'), seat, runId, door: 'dispatch', items: [{ file, id, title: 'task ' + id, due: null }], why: 'handoff' };
      if (route) wake.route = route;
      wakes.push(wake);
      for (const r2 of x.moreRoutes || []) { const rr = Object.assign({}, r, { runId: runId + '-b', startedAt: at + 2 * H, endedAt: at + 2.5 * H, ts: at + 2.5 * H }); runs.push(rr); wakes.push(Object.assign({}, wake, { at: at + 2 * H - 60e3, ts: new Date(at + 2 * H - 60e3).toISOString(), wakeId: wake.wakeId + 'b', runId: rr.runId, route: r2 })); }
      const lines = ['## ' + new Date(at - H).toISOString().slice(0, 16).replace('T', ' ') + ' from Lee — task ' + id, '**Id:** ' + id, '**Need:** task ' + id];
      if (x.cls) lines.push('**Class:** ' + x.cls);
      if (x.fail) lines.push('**Verdict:** REVISE by Ria — check: the acceptance test fails — one finding');
      lines.push('**Status:** DONE', '**Resolved ' + new Date(closed).toISOString().slice(0, 16).replace('T', ' ') + ' by ' + (seat === 'sam' ? 'Sam' : 'Kim') + '**');
      inbox[file].push(lines.join('\n') + '\n');
    },
  };
  /* the router's decision shapes (lib/routing.js decide(), as its tests pin them):
   *   override  the arm applied as a one-run override: { source: 'trial', trial, arm, <arm pair>, applied: true }
   *   control   the seat's chain already is the assigned arm: it runs there with no override,
   *             { source: 'trial', trial, arm, <arm pair>, applied: false } (no wouldApply)
   *   shadow    trials in shadow (or the arm not open): the chain runs, the arm only in wouldApply,
   *             { source: 'chain', <chain pair>, applied: false, wouldApply: { source: 'trial', <arm pair>, trial, arm } } */
  const trialRoute = (i, kind, chainPair) => {
    const base = { v: 1, class: 'code', classes: ['code'], mode: kind === 'shadow' ? 'shadow' : 'live', capMode: 'shadow' };
    if (kind === 'shadow') { const c = chainPair || ARMS[(i + 1) % ARMS.length]; return Object.assign(base, { source: 'chain', provider: c.provider, model: c.model, effort: c.effort, applied: false, wouldApply: { source: 'trial', provider: ARMS[i].provider, model: ARMS[i].model, effort: ARMS[i].effort, trial: 't-code', arm: i }, reasons: ['trial in shadow: recorded, not applied'] }); }
    return Object.assign(base, { source: 'trial', provider: ARMS[i].provider, model: ARMS[i].model, effort: ARMS[i].effort, applied: kind !== 'control', trial: 't-code', arm: i, reasons: [] });
  };
  ctx.trialRoute = trialRoute;
  (o.arms || []).forEach((a, i) => { for (let k = 0; k < a.n; k++) ctx.item('sam', 'A' + i + '-' + String(k).padStart(2, '0'), 3 + (k % 20), ARMS[i], trialRoute(i, a.kind || 'override'), { fail: k < a.fails }); });
  /* tier caps, the router's shapes: an applied cap is { source: 'tierCap', <capped pair>, applied: true }; a cap in shadow (or
   * live but not in the allowlist) runs the chain and is { source: 'chain', <chain pair>, applied: false,
   * wouldApply: { source: 'tierCap', <capped pair> } } -- the baseline */
  const SON = { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }, FAB = { provider: 'claude-cli', model: 'claude-fable-5-2', effort: 'medium' };
  const capRoute = (applied, cls) => Object.assign({ v: 1, class: cls || 'code', classes: [cls || 'code'], mode: 'off', capMode: applied ? 'live' : 'shadow' }, applied
    ? { source: 'tierCap', provider: SON.provider, model: SON.model, effort: SON.effort, applied: true, reasons: [] }
    : { source: 'chain', provider: FAB.provider, model: FAB.model, effort: FAB.effort, applied: false, wouldApply: { source: 'tierCap', provider: SON.provider, model: SON.model, effort: SON.effort }, reasons: ['tierCap in shadow: recorded, not applied'] });
  Object.assign(ctx, { capRoute, SON, FAB });
  if (o.tier) {
    for (let k = 0; k < o.tier.capped.n; k++) ctx.item('kim', 'C-' + String(k).padStart(2, '0'), 3 + (k % 20), SON, capRoute(true), { fail: k < o.tier.capped.fails, tokens: o.tier.capped.tokens || [300000, 150000] });
    for (let k = 0; k < o.tier.baseline.n; k++) ctx.item('kim', 'B-' + String(k).padStart(2, '0'), 3 + (k % 20), FAB, capRoute(false), { fail: k < o.tier.baseline.fails, tokens: [1000000, 500000] });
  }
  if (o.extra) o.extra(ctx);
  wakes.sort((a, b) => a.at - b.at || (a.wakeId < b.wakeId ? -1 : 1)); runs.sort((a, b) => a.ts - b.ts || (a.runId < b.runId ? -1 : 1));
  for (const [f, parts] of Object.entries(inbox)) w('company/work/handoffs/' + f, parts.join('\n'));
  w('company/state/wakes.jsonl', wakes.map(x => JSON.stringify(x)).join('\n') + '\n');
  w('.starnet-data/workspaces/runs.jsonl', runs.map(x => JSON.stringify(x)).join('\n') + '\n');
  return T;
}
const evalOf = (T, now) => M.evaluate(M.load({ root: T, now: now || NOW }));
const run = (T, args) => spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }), timeout: 60000 });
const trialMd = T => fs.readFileSync(path.join(T, 'company', 'work', 'models', 'trials', 't-code.md'), 'utf8');

test('a 3-arm trial below minItemsPerArm: per-arm numbers, and no decision with what is missing', () => {
  const T = build({ arms: [{ n: 10, fails: 1 }, { n: 12, fails: 3 }, { n: 8, fails: 0 }] });
  const t = evalOf(T).trials.find(x => x.id === 't-code');
  assert.equal(t.status, 'running'); assert.equal(t.minItemsPerArm, 30); assert.equal(t.arms.length, 3);
  assert.deepEqual(t.arms.map(a => a.items), [10, 12, 8]);
  assert.deepEqual(t.arms.map(a => a.label), ['claude-cli/claude-sonnet-5-5 @ high', 'claude-cli/claude-opus-5-5 @ medium', 'claude-cli/claude-fable-5-2 @ medium']);
  const a0 = t.arms[0];
  assert.equal(a0.oneShotRate, 0.9); assert.ok(a0.lower < 0.9 && a0.upper > 0.9 && a0.lower > 0.6, 'a range around the point estimate: ' + a0.lower + '-' + a0.upper);
  assert.equal(a0.revisePerItem, 0.1);
  for (const a of t.arms) assert.ok(a.costPerItem > 0 && a.medianCost > 0 && a.p90Cost >= a.medianCost && a.hardestCost >= a.medianCost, 'costs for arm ' + a.arm);
  assert.ok(t.arms[0].costPerItem < t.arms[1].costPerItem && t.arms[1].costPerItem < t.arms[2].costPerItem, 'Sonnet < Opus < Fable at list price');
  assert.equal(t.decision.state, 'no decision yet'); assert.equal(t.decision.winner, null);
  assert.deepEqual(t.decision.missing, ['arm 0 (claude-cli/claude-sonnet-5-5 @ high): 10 of 30 items', 'arm 1 (claude-cli/claude-opus-5-5 @ medium): 12 of 30 items', 'arm 2 (claude-cli/claude-fable-5-2 @ medium): 8 of 30 items']);
  const md = M.renderTrialMd(t, 'sha256:x');
  assert.match(md, /\*\*No decision yet\.\*\*/); assert.match(md, /10 of 30 items/); assert.doesNotMatch(md, /wins/);
  assert.match(md, /90% \(\d+(\.\d)?%–\d+(\.\d)?%\)/, 'the one-shot range is shown');
});

test('above minItemsPerArm: the decision rule picks the arm whose lower bound clears the others and costs less', () => {
  const T = build({ arms: [{ n: 40, fails: 2 }, { n: 30, fails: 9 }, { n: 30, fails: 8 }] });
  const t = evalOf(T).trials[0];
  assert.deepEqual(t.arms.map(a => a.enough), [true, true, true]);
  assert.ok(t.arms[0].lower >= t.arms[2].oneShotRate, t.arms[0].lower + ' vs ' + t.arms[2].oneShotRate);
  assert.equal(t.decision.state, 'decided'); assert.equal(t.decision.winner, 0); assert.match(t.decision.why, /lower bound/);
  assert.match(M.renderTrialMd(t, 'sha256:x'), /\*\*Arm 0 \(`claude-cli\/claude-sonnet-5-5 @ high`\) wins\*\*/);
});

test('above minItemsPerArm, the rule the other way: no arm clearly better, or the best is not the cheapest', () => {
  const even = evalOf(build({ arms: [{ n: 30, fails: 3 }, { n: 30, fails: 3 }, { n: 30, fails: 3 }] })).trials[0];
  assert.equal(even.decision.state, 'no decision yet');
  assert.match(even.decision.missing[0], /no arm is clearly better: the best lower bound, .* is below .*point estimate 0\.9/);
  // Fable (the dearest arm) is clearly the best: it clears the quality bar but does not cost less -> no decision
  const dear = evalOf(build({ arms: [{ n: 30, fails: 12 }, { n: 30, fails: 12 }, { n: 40, fails: 0 }] })).trials[0];
  assert.ok(dear.arms[2].lower >= Math.max(dear.arms[0].oneShotRate, dear.arms[1].oneShotRate));
  assert.equal(dear.decision.state, 'no decision yet');
  assert.match(dear.decision.missing[0], /arm 2 .* clears the quality bar but does not cost less/);
  // pure rule: cheaperThan bestOther only compares with the best other arm
  const arms = [{ arm: 0, label: 'a', items: 30, lower: 0.8, oneShotRate: 0.9, decisionCost: 2 }, { arm: 1, label: 'b', items: 30, lower: 0.6, oneShotRate: 0.75, decisionCost: 3 }, { arm: 2, label: 'c', items: 30, lower: 0.3, oneShotRate: 0.4, decisionCost: 1 }];
  assert.equal(M.trialDecision(arms, 30, { cheaperThan: 'every', costStat: 'mean' }).state, 'no decision yet');
  assert.equal(M.trialDecision(arms, 30, { cheaperThan: 'bestOther', costStat: 'mean' }).winner, 0);
  assert.equal(M.trialDecision(arms, 31, { cheaperThan: 'bestOther', costStat: 'mean' }).state, 'no decision yet', 'never a winner below minItemsPerArm');
});

test('mismatches, shadow-only and mixed-arm items are reported, not scored as arm items', () => {
  const T = build({ arms: [{ n: 5, fails: 0 }, { n: 5, fails: 0 }, { n: 5, fails: 0 }], extra: c => {
    c.item('sam', 'MM-served', 5, ARMS[1], c.trialRoute(1, 'override'), { served: 'claude-opus-4-8' });                   // asked Opus 5.5, served 4.8: not the arm
    c.item('sam', 'MM-unconf', 6, ARMS[1], c.trialRoute(1, 'override'), { served: null });                                // no servedModel: counted, unconfirmed
    c.item('sam', 'MM-req', 7, ARMS[1], c.trialRoute(1, 'override'), { runModel: 'claude-fable-5-2' });                   // the override did not take: served Fable
    c.item('sam', 'MM-req-unconf', 7, ARMS[1], c.trialRoute(1, 'override'), { runModel: 'claude-fable-5-2', served: null }); // asked Fable, served unknown
    c.item('sam', 'SH-1', 8, ARMS[0], c.trialRoute(2, 'shadow', ARMS[0]));                                              // shadow: the arm only in wouldApply
    c.item('sam', 'MIX-1', 9, ARMS[0], c.trialRoute(0, 'override'), { moreRoutes: [c.trialRoute(1, 'override')] });     // worked on two arms
  } });
  const t = evalOf(T).trials[0];
  assert.deepEqual(t.arms[1].mismatches, { requested: 1, served: 2, unconfirmed: 2 });
  assert.equal(t.arms[1].items, 7, 'the two items served another model are counted apart, not as arm items');
  assert.equal(t.arms[2].shadowItems, 1); assert.equal(t.arms[2].items, 5);
  assert.equal(t.mixedItems, 1); assert.equal(t.arms[0].items, 5);
});

test('review probe: a control arm (the chain already is the arm: no override, applied false) counts like an override arm', () => {
  const T = build({ arms: [{ n: 35, fails: 1, kind: 'control' }, { n: 35, fails: 10, kind: 'override' }], routing: { trials: [{ id: 't-code', class: 'code', arms: ARMS.slice(0, 2), scope: { departments: ['eng'], seats: [] }, entryShare: 0.1, status: 'running', minItemsPerArm: 30 }] } });
  const t = evalOf(T).trials[0];
  assert.deepEqual(t.arms.map(a => a.items), [35, 35]);
  assert.deepEqual(t.arms.map(a => a.shadowItems), [0, 0]);
  assert.deepEqual(t.arms.map(a => a.enough), [true, true]);
  assert.equal(t.decision.state, 'decided'); assert.equal(t.decision.winner, 0);
  // shadow-only assignments never count as arm items, whichever arm they name
  const S = build({ arms: [{ n: 35, fails: 1, kind: 'shadow' }, { n: 35, fails: 10, kind: 'shadow' }], routing: { trials: [{ id: 't-code', class: 'code', arms: ARMS.slice(0, 2), status: 'running', minItemsPerArm: 30 }] } });
  const s = evalOf(S).trials[0];
  assert.deepEqual(s.arms.map(a => [a.items, a.shadowItems]), [[0, 35], [0, 35]]);
  assert.equal(s.decision.state, 'no decision yet');
});

test('deterministic: refresh writes the decision file and the evaluation once; a rerun (later clock) rewrites nothing; new numbers regenerate it', () => {
  const T = build({ arms: [{ n: 10, fails: 1 }, { n: 10, fails: 2 }, { n: 10, fails: 3 }], policy: { countUnsettled: false } });
  const r1 = run(T, ['refresh', '--force', '--now', String(NOW)]);
  assert.equal(r1.status, 0, r1.stderr); assert.match(r1.stdout, /trials\/tier caps: 2 file\(s\) rewritten/);
  const md1 = trialMd(T), ev1 = fs.readFileSync(path.join(T, 'company', 'work', 'models', 'routing-evaluation.json'), 'utf8');
  assert.doesNotMatch(md1, /20[0-9]{2}-[0-9]{2}-[0-9]{2}T/, 'no clock time in the decision file');
  const r2 = run(T, ['refresh', '--force', '--now', String(NOW + 3 * H)]);
  assert.equal(r2.status, 0); assert.doesNotMatch(r2.stdout, /trials\/tier caps/);
  assert.equal(trialMd(T), md1); assert.equal(fs.readFileSync(path.join(T, 'company', 'work', 'models', 'routing-evaluation.json'), 'utf8'), ev1);
  assert.equal(JSON.stringify(M.sortKeys(evalOf(T))), JSON.stringify(M.sortKeys(evalOf(T))), 'the pure function too');
  // one more item on arm 2: the numbers change, the file is regenerated
  const wf = path.join(T, 'company', 'state', 'wakes.jsonl'), rf = path.join(T, '.starnet-data', 'workspaces', 'runs.jsonl'), hf = path.join(T, 'company', 'work', 'handoffs', 'to-sam.md');
  const at = Date.UTC(2030, 0, 15) + 11 * H;
  fs.appendFileSync(wf, JSON.stringify({ at, wakeId: 'wk-new', seat: 'sam', runId: 'run-new', door: 'dispatch', items: [{ file: 'to-sam.md', id: 'NEW', title: 'task NEW', due: null }], why: 'handoff', route: { class: 'code', source: 'trial', trial: 't-code', arm: 2, applied: true, ...ARMS[2] } }) + '\n');
  fs.appendFileSync(rf, JSON.stringify({ runId: 'run-new', agentId: 'sam', provider: 'claude-cli', model: 'claude-fable-5-2', servedModel: 'claude-fable-5-2', reasoningEffort: 'medium', reason: 'done', tokens: 600000, cachedTokens: 450000, usd: 0, unmetered: true, startedAt: at + 60e3, endedAt: at + 1800e3, ts: at + 1800e3 }) + '\n');
  fs.appendFileSync(hf, '\n## 2030-01-15 10:00 from Lee — task NEW\n**Id:** NEW\n**Status:** DONE\n**Resolved 2030-01-15 16:00 by Sam**\n');
  const r3 = run(T, ['refresh', '--force', '--now', String(NOW + 4 * H)]);
  assert.equal(r3.status, 0); assert.match(r3.stdout, /trials\/tier caps: 2 file\(s\) rewritten/);
  assert.notEqual(trialMd(T), md1); assert.match(trialMd(T), /\| 2 \| `claude-cli\/claude-fable-5-2 @ medium` \| 11 \(of 30\)/);
});

test('tier caps: keep when window use falls 30% and rework stays within 1.25x; roll back when REVISE rises; not enough data below minItems', () => {
  const keep = evalOf(build({ tier: { capped: { n: 20, fails: 2 }, baseline: { n: 20, fails: 2 } } })).tierCaps;
  const k = keep.classes.find(c => c.class === 'code');
  assert.equal(k.verdict, 'keep'); assert.equal(keep.verdict, 'keep');
  assert.equal(k.capped.items, 20); assert.equal(k.baseline.items, 20); assert.ok(k.windowCut >= 0.3, String(k.windowCut));
  assert.equal(k.reviseRatio, 1); assert.equal(keep.mode, 'shadow');
  const back = evalOf(build({ tier: { capped: { n: 20, fails: 6 }, baseline: { n: 20, fails: 2 } } })).tierCaps;
  const b = back.classes.find(c => c.class === 'code');
  assert.equal(b.verdict, 'roll back'); assert.deepEqual(back.rollBack, ['code']); assert.equal(back.verdict, 'roll back');
  assert.match(b.reasons.join(' '), /REVISE rate 0\.3 vs baseline 0\.1 \(over 1\.25x\)/);
  // the caps do not save enough window: roll back too
  const flat = evalOf(build({ tier: { capped: { n: 20, fails: 2, tokens: [1000000, 600000] }, baseline: { n: 20, fails: 2 } } })).tierCaps.classes[0];
  assert.equal(flat.verdict, 'roll back'); assert.match(flat.reasons.join(' '), /under the 30% the caps must save/);
  const few = evalOf(build({ tier: { capped: { n: 10, fails: 0 }, baseline: { n: 25, fails: 2 } } })).tierCaps;
  assert.equal(few.verdict, 'not enough data'); assert.deepEqual(few.classes[0].reasons, ['capped items 10 of 20']);
  // thresholds are policy: a looser rework ratio keeps what 1.25x rolled back
  const loose = evalOf(build({ tier: { capped: { n: 20, fails: 6 }, baseline: { n: 20, fails: 2 } }, policy: { tierCapEvaluation: { minItems: 20, windowCut: 0.3, reworkMaxRatio: 3.5, rates: ['revise', 'reopen'], baseline: 'wouldApply' } } })).tierCaps;
  assert.equal(loose.verdict, 'keep');
});

test('review probe: 25 applied caps against 25 would-apply baseline wakes (the router records those as source chain) give a verdict', () => {
  const ev = evalOf(build({ tier: { capped: { n: 25, fails: 2 }, baseline: { n: 25, fails: 2 } }, routing: { trials: [] } })).tierCaps;
  const k = ev.classes.find(c => c.class === 'code');
  assert.deepEqual([k.capped.items, k.baseline.items], [25, 25]);
  assert.notEqual(k.verdict, 'not enough data'); assert.equal(k.verdict, 'keep'); assert.equal(k.wouldApplyItems, 25);
});

test('tier caps: a class verdict uses only items of that class (an item classed writing on a code wake is not a code item)', () => {
  const T = build({ tier: { capped: { n: 20, fails: 2 }, baseline: { n: 20, fails: 2 } }, routing: { trials: [] }, extra: c => {
    for (let k = 0; k < 6; k++) c.item('kim', 'W-' + k, 4 + k, c.SON, c.capRoute(true), { cls: 'writing', fail: true, tokens: [300000, 150000] });
  } });
  const ev = evalOf(T).tierCaps;
  const code = ev.classes.find(c => c.class === 'code'), wr = ev.classes.find(c => c.class === 'writing');
  assert.equal(code.capped.items, 20); assert.equal(code.verdict, 'keep');
  assert.ok(wr, 'the writing items form their own class'); assert.equal(wr.capped.items, 6); assert.equal(wr.verdict, 'not enough data');
});

test('the house-ranking duty: a stuck trial, a decided trial, and a tier-cap roll back while live; quiet otherwise; off without the policy sections', () => {
  const below = build({ arms: [{ n: 10, fails: 1 }, { n: 10, fails: 1 }, { n: 10, fails: 1 }] });
  const d1 = M.duty({ root: below, now: NOW });   // the last routed wake was 2030-01-12: twenty days before
  assert.equal(d1.due, true); assert.match(d1.reason, /trial t-code has had no items for \d+ days/);
  assert.ok(d1.items.some(i => /^trial:t-code:stuck:/.test(i.id)));
  assert.equal(M.duty({ root: below, now: Date.UTC(2030, 0, 13, 12) }).due, false, 'a day after the last wake: not stuck');
  const won = build({ arms: [{ n: 40, fails: 2 }, { n: 30, fails: 9 }, { n: 30, fails: 8 }] });
  const d2 = M.duty({ root: won, now: Date.UTC(2030, 0, 23, 12) + 8 * D });
  assert.equal(d2.due, true); assert.match(d2.reason, /trial t-code reached a decision \(arm 0\)/);
  assert.ok(d2.reason.length <= 300); assert.match(d2.key, /^rp-[0-9a-f]{16}$/);
  // a trial marked done is quiet, whatever its numbers
  const done = build({ arms: [{ n: 40, fails: 2 }, { n: 30, fails: 9 }, { n: 30, fails: 8 }], routing: { trials: [{ id: 't-code', class: 'code', arms: ARMS, status: 'done', minItemsPerArm: 30 }] } });
  assert.equal(M.duty({ root: done, now: NOW }).due, false);
  // tier caps: a roll back is due only while the caps are live
  const tierShadow = build({ tier: { capped: { n: 20, fails: 6 }, baseline: { n: 20, fails: 2 } }, routing: { trials: [] } });
  assert.equal(M.duty({ root: tierShadow, now: NOW }).due, false, 'shadow: reported, not due');
  const tierLive = build({ tier: { capped: { n: 20, fails: 6 }, baseline: { n: 20, fails: 2 } }, routing: { trials: [], tierCaps: { mode: 'live' } } });
  const d3 = M.duty({ root: tierLive, now: NOW });
  assert.equal(d3.due, true); assert.match(d3.reason, /tier caps: roll back code/); assert.deepEqual(d3.items, [{ id: 'tiercap:code' }]);
  // the sections removed from the ranking policy: no evaluation, no duty line, no files
  const off = build({ arms: [{ n: 10, fails: 1 }, { n: 10, fails: 1 }, { n: 10, fails: 1 }] });
  const pf = path.join(off, 'company', 'work', 'models', 'ranking-policy.json'); const p = JSON.parse(fs.readFileSync(pf, 'utf8')); delete p.trials; delete p.tierCapEvaluation; fs.writeFileSync(pf, JSON.stringify(p));
  assert.deepEqual(evalOf(off), {}); assert.equal(M.duty({ root: off, now: NOW }).due, false);
  assert.equal(run(off, ['refresh', '--force', '--now', String(NOW)]).status, 0);
  assert.equal(fs.existsSync(path.join(off, 'company', 'work', 'models', 'routing-evaluation.json')), false);
});

test('the shipped ranking policy documents every trial and tier-cap setting with the plan defaults', () => {
  const def = JSON.parse(fs.readFileSync(DEFAULT_POLICY, 'utf8'));
  assert.ok(def._trials && def._tierCapEvaluation);
  assert.equal(def.trials.minItemsPerArm, 30); assert.equal(def.trials.decision.cheaperThan, 'every'); assert.equal(def.trials.stuckDays, 3);
  assert.equal(def.tierCapEvaluation.windowCut, 0.3); assert.equal(def.tierCapEvaluation.reworkMaxRatio, 1.25); assert.equal(def.tierCapEvaluation.minItems, 20);
  const E = M.evalKnobs(def);
  assert.equal(E.trials.confidence, 0.8); assert.deepEqual(E.tierCaps.rates, ['revise', 'reopen']); assert.equal(E.tierCaps.baseline, 'wouldApply');
});
