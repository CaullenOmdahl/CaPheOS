#!/usr/bin/env node
/* advisor-eval.test.js — model-rank.js advisorEvaluation (docs/RANKING.md §10, the middle-management plan's P4 bars) and the
 * dispatcher's auto-pause (lib/consult.js consultStep):
 *   - byte-identical on a rerun; "not enough data" under 20 items or 14 days; pause when the consult rate is outside
 *     10-40% or the cost bar fails; keep when cost per item held and one-shot rose 10 points (or rework fell 20%);
 *   - no department with advice on: no advisor report at all;
 *   - the pause runs once per evaluation hash, records who paused it (auto) and tells the owner in one plain digest line.
 *   node --test company/tools/tests/advisor-eval.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const MR = require(path.join(TOOLS, 'model-rank.js'));
const POLICY = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/ranking-policy.json'), 'utf8'));
const DAY = 86400e3;
const NOW = Date.parse('2026-12-10T12:00:00Z');
const SINCE = NOW - 20 * DAY;
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const dept = (o) => ({ departments: [{ id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben', 'cat'], defaultClass: 'code',
  advisor: Object.assign({ mode: 'live', since: new Date(SINCE).toISOString(), by: 'owner', paused: null }, o || {}) }] });
/* n items on each side: o.after / o.before = { n, fails, cost, rework }, o.consulted = how many after-items had a consult */
function inputs(o) {
  const items = [], consults = [];
  const side = (k, s) => { for (let i = 0; i < s.n; i++) {
    const closedAt = k === 'after' ? SINCE + DAY + i * 3600e3 : SINCE - DAY - i * 3600e3;
    items.push({ id: k + '-' + i, seat: i % 2 ? 'ben' : 'cat', excluded: false, settled: true, closedAt, oneShot: i < s.fails ? 0 : 1, cost: { listUsd: s.cost, usd: 0, windowTokens: 0 }, extraRuns: s.rework || 0, reviseRounds: 0 });
  } };
  side('after', o.after); side('before', o.before);
  for (let i = 0; i < (o.consulted || 0); i++) consults.push({ op: 'open', id: 'cs-' + i, dept: 'eng', item: 'after-' + i });
  const runById = new Map([['adv-1', { runId: 'adv-1', agentId: 'kwa', tokens: 10000, cachedTokens: o.cached == null ? 9000 : o.cached }]]);
  const an = { items, body: { graders: [{ seat: 'kwa', verdicts: 12, approvalRate: 0.6, hardOneShotRate: 0.7, drift: -10, flagged: false }] }, runById };
  const inp = { policy: POLICY, now: o.now || NOW, departments: o.departments || dept(o.advisor), consults, wakes: [{ at: SINCE + 2 * DAY, door: 'consult', seat: 'kwa', runId: 'adv-1', items: [] }] };
  return { inp, an };
}
const evalOf = o => { const { inp, an } = inputs(o); return MR.advisorEvaluation(inp, an, MR.knobs(POLICY), Object.assign({}, POLICY.advisorEvaluation), it => !it.excluded && it.settled); };

test('keep: cost per item held, one-shot up 15 points, consult rate 25%, cache 90%; byte-identical on a rerun', () => {
  const o = { after: { n: 20, fails: 2, cost: 0.9, rework: 1 }, before: { n: 20, fails: 5, cost: 1.0, rework: 1 }, consulted: 5 };
  const a = evalOf(o), b = evalOf(o);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'deterministic');
  const r = a.departments[0];
  assert.equal(r.verdict, 'keep', JSON.stringify(r));
  assert.equal(r.consultRate, 0.25); assert.equal(r.cachedShare, 0.9); assert.equal(r.oneShotPoints, 15); assert.equal(r.days, 20);
  assert.ok(r.after.lower < r.after.oneShotRate && r.after.upper > r.after.oneShotRate, 'Wilson range');
  assert.deepEqual(r.leadCalibration, { verdicts: 12, approvalRate: 0.6, hardOneShotRate: 0.7, drift: -10, flagged: false });
  assert.match(r.hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(MR.renderAdvisorMd(r), /## Verdict: keep/);
  // rework down 20% also clears the bar without a one-shot gain
  assert.equal(evalOf({ after: { n: 20, fails: 5, cost: 1.0, rework: 0.8 }, before: { n: 20, fails: 5, cost: 1.0, rework: 1 }, consulted: 5 }).departments[0].verdict, 'keep');
});

test('not enough data under 20 items or 14 days', () => {
  assert.equal(evalOf({ after: { n: 19, fails: 0, cost: 1 }, before: { n: 30, fails: 0, cost: 1 }, consulted: 5 }).departments[0].verdict, 'not enough data');
  assert.equal(evalOf({ after: { n: 30, fails: 0, cost: 1 }, before: { n: 19, fails: 0, cost: 1 }, consulted: 5 }).departments[0].verdict, 'not enough data');
  const young = evalOf({ advisor: { since: new Date(NOW - 10 * DAY).toISOString() }, after: { n: 30, fails: 0, cost: 1 }, before: { n: 30, fails: 0, cost: 1 }, consulted: 5 }).departments[0];
  assert.equal(young.verdict, 'not enough data'); assert.ok(young.reasons.some(x => /10 of 14 days/.test(x)), JSON.stringify(young.reasons));
});

test('pause: the consult rate outside 10-40%, the cost bar, the cache bar', () => {
  const base = { after: { n: 20, fails: 2, cost: 0.9, rework: 1 }, before: { n: 20, fails: 5, cost: 1.0, rework: 1 } };
  const low = evalOf(Object.assign({ consulted: 1 }, base)).departments[0];
  assert.equal(low.verdict, 'pause'); assert.match(low.failed.join(), /consult rate 5% is outside 10-40%/);
  assert.equal(evalOf(Object.assign({ consulted: 10 }, base)).departments[0].verdict, 'pause', '50% is too often');
  const dear = evalOf({ after: { n: 20, fails: 0, cost: 1.2 }, before: { n: 20, fails: 5, cost: 1.0 }, consulted: 5 }).departments[0];
  assert.equal(dear.verdict, 'pause'); assert.match(dear.failed.join(), /cost per item rose/);
  const flat = evalOf({ after: { n: 20, fails: 5, cost: 0.9, rework: 1 }, before: { n: 20, fails: 5, cost: 1.0, rework: 1 }, consulted: 5 }).departments[0];
  assert.equal(flat.verdict, 'pause'); assert.match(flat.failed.join(), /needs \+10/);
  const cold = evalOf(Object.assign({ consulted: 5, cached: 5000 }, base)).departments[0];
  assert.equal(cold.verdict, 'pause'); assert.match(cold.failed.join(), /50% of their input from cache, under 85%/);
  // a department's own autoPause numbers win
  assert.equal(evalOf(Object.assign({ consulted: 1, advisor: { autoPause: { consultRate: [0.01, 0.5] } } }, base)).departments[0].verdict, 'keep');
});

test('no department with advice on: no advisor report', () => {
  assert.equal(evalOf({ after: { n: 20, fails: 0, cost: 1 }, before: { n: 20, fails: 0, cost: 1 }, departments: dept({ mode: 'shadow' }) }), null);
  assert.equal(evalOf({ after: { n: 20, fails: 0, cost: 1 }, before: { n: 20, fails: 0, cost: 1 }, departments: { departments: [] } }), null);
});

test('auto-pause: once per evaluation hash, recorded as auto, one plain line to the owner; only the owner resumes', () => {
  const T = __LIFE.tmpDir('advisor-pause-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Pause Co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo'], inbox: 'to-boss.md' }, kwa: { name: 'Kwame', manager: 'boss', inbox: 'to-kwame.md' }, ben: { name: 'Ben', manager: 'kwa', inbox: 'to-ben.md' }, cat: { name: 'Cat', manager: 'kwa', inbox: 'to-cat.md' } } });
  for (const f of ['company/defaults/departments.json', 'company/defaults/work/departments/advise-prompt.md', 'company/defaults/state/governance.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  const d = dept({ autoPause: { enabled: true } }); d.version = 1;
  w('company/departments.json', d);
  for (const f of ['to-boss.md', 'to-kwame.md', 'to-ben.md', 'to-cat.md']) w('company/work/handoffs/' + f, '# Handoffs\n');
  w('company/work/departments/eng/DECISIONS.md', '# Engineering — decisions\n\n');
  w('company/work/decisions.md', '# Decisions\n\n');
  w('company/work/models/routing-evaluation.json', { advisor: { departments: [{ dept: 'eng', verdict: 'pause', failed: ['cost per item rose from 1 to 1.2 (listUsd)'], reasons: [], hash: 'sha256:aaa' }] } });
  const step = () => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(false);' +
      'const logs = []; require(' + JSON.stringify(path.join(TOOLS, 'lib', 'consult.js')) + ').consultStep({ log: l => logs.push(l), jobs: [], order: [], call: async () => ({ status: 200, body: JSON.stringify({ ok: true, job: { id: "job-x", name: "Kwame advise" }, jobs: [{ id: "job-x", name: "Kwame advise" }] }) }), fireRun: async () => ({ status: 200, body: "{}" }) }).then(r => process.stdout.write(JSON.stringify({ r, logs })));';
    const p = spawnSync(process.execPath, ['-e', code], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }) });
    if (p.status !== 0) throw new Error(p.stderr);
    return JSON.parse(p.stdout);
  };
  const s1 = step();
  assert.deepEqual(s1.r.paused, ['eng'], JSON.stringify(s1));
  assert.ok(s1.logs.some(l => /^ADVISOR PAUSED eng \(Kwame\): cost per item rose/.test(l)), s1.logs.join('\n'));
  const doc = JSON.parse(fs.readFileSync(path.join(T, 'company/departments.json'), 'utf8'));
  assert.deepEqual([doc.departments[0].advisor.paused.by, doc.departments[0].advisor.paused.evaluationHash], ['auto', 'sha256:aaa']);
  const digest = fs.readFileSync(path.join(T, 'company/owner/digest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(digest.length, 1); assert.match(JSON.stringify(digest[0]), /The crew paused Kwame's advice for Engineering: over the last two weeks it cost more than it saved/);
  assert.match(fs.readFileSync(path.join(T, 'company/work/departments/eng/DECISIONS.md'), 'utf8'), /the dispatcher \(automatic\): pause the lead's advice for Engineering/);
  // the same hash again (after the owner resumed): not paused a second time
  doc.departments[0].advisor.paused = null; fs.writeFileSync(path.join(T, 'company/departments.json'), JSON.stringify(doc));
  const s2 = step();
  assert.deepEqual(s2.r.paused, [], 'once per evaluation hash');
  w('company/work/models/routing-evaluation.json', { advisor: { departments: [{ dept: 'eng', verdict: 'pause', failed: ['consult rate 5% is outside 10-40%'], hash: 'sha256:bbb' }] } });
  assert.deepEqual(step().r.paused, ['eng'], 'a new evaluation pauses again');
});
