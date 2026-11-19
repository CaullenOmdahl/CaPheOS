#!/usr/bin/env node
/* model-stats.test.js — the house benchmark (company/tools/model-stats.js): the routine view's old fields are unchanged,
 * every crew run is booked and flagged by source, usd / cached share / reasoning effort per group, and families (a lead
 * run and its team.dispatch children) whose totals equal the sum of their runs exactly; a child cut off by the dispatch
 * time slice is told apart from a real failure.
 *
 *   node --test company/tools/tests/model-stats.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(REPO, 'company', 'tools', 'model-stats.js');
const MS = require(TOOL);
const NOW = Date.UTC(2030, 0, 15, 12, 0, 0);
const SINCE = NOW - 14 * 86400e3;
const H = 3600e3;
const OLD_FIELDS = ['runs', 'finished', 'refused', 'outOfSteps', 'outOfBudget', 'providerError', 'stopped', 'other', 'finishRate', 'medianTurns', 'medianTokens', 'medianMinutes', 'enough'];
const pick = (s, ks) => Object.fromEntries(ks.map(k => [k, s[k]]));

// the old fixture: routine rows only, no effort / usd / cached fields (what the tool read before)
function oldRows() {
  const row = (i, o) => Object.assign({ runId: 'r' + i, agentId: 'seat-a', provider: 'p1', model: 'm1', cronJobId: 'job-1', reason: 'done', turns: 4, tokens: 1000, durationMs: 60000, startedAt: NOW - (i + 1) * H }, o);
  return [
    row(1, {}), row(2, { turns: 6, tokens: 3000, durationMs: 120000 }), row(3, { reason: 'max_iters' }), row(4, { reason: 'error' }),
    row(5, { reason: 'cancelled' }), row(6, { outcome: 'refused', reason: 'refusal' }), row(7, { cronJobId: 'job-2', turns: 2, tokens: 500 }),
    row(8, { provider: 'p2', model: 'm2', reason: 'budget' }),
    row(9, { startedAt: SINCE - H }),                // before the window: not counted
    row(10, { model: '' }),                           // no model: not counted
    { runId: 'x1', agentId: 'seat-a', provider: 'p1', model: 'm1', reason: 'done', turns: 1, tokens: 10, startedAt: NOW - H },   // no routine: not in the routine view
  ];
}

test('the routine view keeps its old fields and values on the old fixture', () => {
  const r = MS.compute({ rows: oldRows(), admitRows: [], names: { 'job-1': 'Loop one' }, days: 14, since: SINCE, now: NOW });
  assert.equal(r.days, 14);
  assert.equal(r.routineRuns, 8);
  assert.deepEqual(r.models.map(m => m.model), ['p1/m1', 'p2/m2']);
  const m1 = r.models[0];
  assert.deepEqual(pick(m1.overall, OLD_FIELDS), { runs: 7, finished: 3, refused: 1, outOfSteps: 1, outOfBudget: 0, providerError: 1, stopped: 1, other: 0,
    finishRate: 60, medianTurns: 4, medianTokens: 1000, medianMinutes: 1, enough: true });
  assert.deepEqual(m1.routines.map(x => x.routine), ['Loop one', 'job-2']);   // an unnamed routine shows its id's first 8 characters
  assert.deepEqual(pick(m1.routines[0], OLD_FIELDS), { runs: 6, finished: 2, refused: 1, outOfSteps: 1, outOfBudget: 0, providerError: 1, stopped: 1, other: 0,
    finishRate: 50, medianTurns: 5, medianTokens: 2000, medianMinutes: 1.5, enough: false });
  assert.deepEqual(pick(r.models[1].overall, OLD_FIELDS), { runs: 1, finished: 0, refused: 0, outOfSteps: 0, outOfBudget: 1, providerError: 0, stopped: 0, other: 0,
    finishRate: null, medianTurns: null, medianTokens: null, medianMinutes: null, enough: false });
  // the crew view counts the routine-less run too
  assert.equal(r.crew.runs, 9);
  assert.equal(r.families.count, 0);
  const md = MS.render(r);
  assert.match(md, /## By model\n\n\| \| Runs \| Finished \| Refused \| Out of steps \| Stopped by our limits \| Provider errors \| Median turns \| Median tokens \| Median minutes \|/);
  assert.match(md, /\| `p1\/m1` \| 7 \| 60% \| 1 \| 1 \| 1 \| 1 \| 4 \| 1k \| 1 \|/);
  assert.match(md, /## `p1\/m1` by routine/);
});

// the new fixture: a lead (owner chat) with 3 children (one cut off by the dispatch slice, one a real failure),
// routine runs at two effort levels, a dispatcher wake and a lane run, with usd and cached counts
function newRows() {
  const t0 = NOW - 5 * H;
  return [
    { runId: 'lead', parentRunId: '', agentId: 'lead-seat', provider: 'p1', model: 'm1', reasoningEffort: 'medium', wireSource: 'agent', streamId: 'console-agent', ownerDirective: true,
      reason: 'done', turns: 10, tokens: 4000, cachedTokens: 3000, usd: 0.5, durationMs: 600000, startedAt: t0 },
    { runId: 'c1', parentRunId: 'lead', agentId: 'w1', provider: 'p1', model: 'm1', reasoningEffort: 'high', wireSource: 'agent', reason: 'done', turns: 5, tokens: 2000, cachedTokens: 1000, usd: 0.25, durationMs: 120000, startedAt: t0 + 1000 },
    { runId: 'c2', parentRunId: 'lead', agentId: 'w2', provider: 'p1', model: 'm1', reasoningEffort: 'high', wireSource: 'agent', reason: 'cancelled', turns: 3, tokens: 1500, cachedTokens: 500, usd: 0.125, durationMs: 300000, startedAt: t0 + 2000 },
    { runId: 'c3', parentRunId: 'lead', agentId: 'w1', provider: 'p1', model: 'm1', reasoningEffort: 'high', wireSource: 'agent', reason: 'error', turns: 1, tokens: 100, usd: 0.0625, durationMs: 6000, startedAt: t0 + 3000 },
    { kind: 'dispatch-delivery', runId: 'c2', dispatchDelivery: { state: 'final', text: 'ran out of time', reason: 'timeout' }, ts: t0 + 400000 },
    { kind: 'dispatch-delivery', runId: 'c1', dispatchDelivery: { state: 'final', text: 'done', reason: 'done' }, ts: t0 + 300000 },
    { runId: 'rt1', agentId: 'seat-a', provider: 'p2', model: 'm2', reasoningEffort: 'high', wireSource: 'routine', cronJobId: 'job-1', streamId: 'cron-job-1', reason: 'done', turns: 8, tokens: 10000, cachedTokens: 8000, usd: 1, durationMs: 60000, startedAt: NOW - 4 * H },
    { runId: 'rt2', agentId: 'seat-a', provider: 'p2', model: 'm2', reasoningEffort: 'low', wireSource: 'routine', cronJobId: 'job-1', streamId: 'cron-job-1', reason: 'done', turns: 4, tokens: 6000, cachedTokens: 3000, usd: 0.5, durationMs: 60000, startedAt: NOW - 3 * H },
    { runId: 'rt3', agentId: 'seat-b', provider: 'p2', model: 'm2', reasoningEffort: 'low', wireSource: 'routine', cronJobId: 'job-2', streamId: 'cron-job-2', reason: 'done', turns: 2, tokens: 2000, usd: 0, unmetered: true, durationMs: 60000, startedAt: NOW - 2 * H },
    { runId: 'ln1', agentId: 'seat-b', provider: 'p2', model: 'm2', reasoningEffort: 'low', wireSource: 'routine', cronJobId: 'job-3', streamId: 'cron-job-3', reason: 'max_iters', turns: 20, tokens: 30000, cachedTokens: 0, usd: 2, durationMs: 60000, startedAt: NOW - 1 * H },
  ];
}
function admitRows() {
  return [
    { at: NOW - 4 * H - 5000, id: 'adm-1', door: 'dispatch', kind: 'run', seat: 'seat-a', jobId: 'job-1', decision: 'allow' },
    { at: NOW - 4 * H - 4000, ref: 'adm-1', outcome: 'started', status: 200, runId: 'rt1' },
    { at: NOW - 1 * H - 5000, id: 'adm-2', door: 'lane', kind: 'run', seat: 'seat-b', jobId: 'job-3', decision: 'allow' },
  ];
}

test('every crew run is booked and flagged by source, with usd, cached share and effort', () => {
  const r = MS.compute({ rows: newRows(), admitRows: admitRows(), names: {}, days: 14, since: SINCE, now: NOW });
  assert.equal(r.crew.runs, 8);
  assert.deepEqual(r.crew.sources, { 'owner-chat': 1, child: 3, dispatcher: 1, routine: 2, lane: 1 });
  assert.equal(r.routineRuns, 4);   // the routine view: runs with a routine, whoever started them
  const all = r.crew.overall;
  assert.equal(all.usd, 4.4375);
  assert.equal(all.usdPerRun, Math.round(4.4375 / 8 * 1e6) / 1e6);
  assert.equal(all.unmeteredRuns, 1);
  assert.equal(all.tokens, 55600);
  // cached share: of the tokens of the runs that report a cached count (c3 and rt3 report none)
  assert.equal(all.cachedTokens, 15500);
  assert.equal(all.cachedShare, Math.round(1000 * 15500 / (55600 - 100 - 2000)) / 1000);
  // effort: provider/model/effort
  const m2 = r.models.find(m => m.model === 'p2/m2');
  assert.deepEqual(m2.byEffort.map(e => [e.effort, e.runs, e.usd]).sort(), [['high', 1, 1], ['low', 3, 2.5]]);
  const lowE = m2.byEffort.find(e => e.effort === 'low');
  assert.equal(lowE.cachedShare, Math.round(1000 * 3000 / 36000) / 1000);
  const cm1 = r.crew.models.find(m => m.model === 'p1/m1');
  assert.deepEqual(cm1.byEffort.map(e => [e.effort, e.runs]).sort(), [['high', 3], ['medium', 1]]);
  assert.deepEqual(cm1.bySource.map(s => [s.source, s.runs]).sort(), [['child', 3], ['owner-chat', 1]]);
  // the routine view gains the new fields too (added, nothing renamed)
  assert.equal(m2.overall.usd, 3.5);
  for (const k of OLD_FIELDS) assert.ok(k in m2.overall, k);
});

test('a family is a lead plus its children; its totals equal the sum of its runs exactly', () => {
  const rows = newRows();
  const r = MS.compute({ rows, admitRows: admitRows(), names: {}, days: 14, since: SINCE, now: NOW });
  const f = r.families;
  assert.equal(f.count, 1);
  const fam = f.list[0];
  assert.equal(fam.leadRunId, 'lead'); assert.equal(fam.leadInWindow, true); assert.equal(fam.source, 'owner-chat'); assert.equal(fam.lead, 'finished');
  assert.equal(fam.runs, 4); assert.equal(fam.children, 3);
  assert.deepEqual(fam.workers.sort(), ['w1', 'w2']);
  const members = rows.filter(x => x.runId === 'lead' || x.parentRunId === 'lead').filter(x => !x.kind);
  assert.equal(fam.tokens, members.reduce((t, x) => t + x.tokens, 0));
  assert.equal(fam.turns, members.reduce((t, x) => t + x.turns, 0));
  assert.equal(fam.usd, members.reduce((t, x) => t + x.usd, 0));
  assert.equal(fam.usd, 0.9375);
  assert.equal(fam.cachedTokens, 4500);
  assert.deepEqual(fam.childOutcomes, { finished: 1, sliceCut: 1, cancelledOther: 0, failed: 1 });
  assert.equal(fam.outcomes.stopped, 1); assert.equal(fam.outcomes.providerError, 1); assert.equal(fam.outcomes.finished, 2);
  // the summary is the sum of its families
  assert.equal(f.runs, 4); assert.equal(f.children, 3); assert.equal(f.tokens, fam.tokens); assert.equal(f.usd, fam.usd); assert.equal(f.turns, fam.turns);
  assert.deepEqual(f.childrenPerLead, { mean: 3, median: 3, max: 3 });
  assert.deepEqual(f.childOutcomes, fam.childOutcomes);
  // without the station's timeout patch the cancelled child is "cancelled otherwise", not a slice cut
  const r2 = MS.compute({ rows: rows.filter(x => !(x.kind && x.runId === 'c2')), admitRows: [], names: {}, days: 14, since: SINCE, now: NOW });
  assert.deepEqual(r2.families.childOutcomes, { finished: 1, sliceCut: 0, cancelledOther: 1, failed: 1 });
  // a family whose lead started before the window still books its children
  const r3 = MS.compute({ rows: rows.filter(x => x.runId !== 'lead'), admitRows: [], names: {}, days: 14, since: SINCE, now: NOW });
  assert.equal(r3.families.count, 1); assert.equal(r3.families.list[0].leadInWindow, false); assert.equal(r3.families.runs, 3);
  assert.match(MS.render(r), /## Families: a lead run and its team.dispatch children as one unit\n\n1 families, 4 runs \(3 children/);
});

test('the CLI reads runs.jsonl and the admit log bounded under CAPHEOS_ROOT and prints JSON with --json', () => {
  const T = require('../lib/temp-life').tmpDir('model-stats-test-');
  try {
    const now = Date.now(), shift = now - NOW;
    const moved = newRows().map(x => Object.assign({}, x, x.startedAt ? { startedAt: x.startedAt + shift } : {}, x.ts ? { ts: x.ts + shift } : {}));
    const ws = path.join(T, '.starnet-data', 'workspaces'); fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'runs.jsonl'), moved.map(x => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(ws, 'cron.jobs.json'), JSON.stringify({ jobs: [{ id: 'job-1', name: 'Loop one' }] }));
    fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'state', 'admit-log.jsonl'), admitRows().map(x => JSON.stringify(Object.assign({}, x, { at: x.at + shift }))).join('\n') + '\n');
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T }); delete env.ADMIT_LOG;
    const p = spawnSync('node', [TOOL, '--json'], { env, encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout);
    assert.equal(r.routineRuns, 4); assert.equal(r.crew.runs, 8); assert.equal(r.crew.sources.lane, 1); assert.equal(r.crew.sources.dispatcher, 1);
    assert.equal(r.families.childOutcomes.sliceCut, 1);
    assert.ok(r.models.find(m => m.model === 'p2/m2').routines.some(x => x.routine === 'Loop one'));
    assert.ok(!fs.existsSync(path.join(T, 'company', 'work', 'models', 'house-benchmarks.json')));   // --json writes nothing
    const w = spawnSync('node', [TOOL], { env, encoding: 'utf8' });
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /4 routine runs, 1 models; 8 crew runs, 1 families/);
    assert.ok(fs.existsSync(path.join(T, 'company', 'work', 'models', 'house-benchmarks.md')));
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
