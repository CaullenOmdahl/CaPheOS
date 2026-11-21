#!/usr/bin/env node
/* model-bench-results.test.js — the model bench's results file across runs and provider failures
 * (packs/model-bench/lib/bench.js mergeResults / forgetDamaged / provider handling, company/tools/model-bench.js):
 *   - a run of one kind merges into the model's earlier result (never wipes the other kinds), per-level measuredAt and
 *     seed, the .prev.json backup, old levels dropped when task versions or the bench major version moved, and the
 *     capability table (lib/capability.js) reads the merged file;
 *   - a provider failure (quota, rate limit ...) is failures.provider and NOT PROVEN, never the model's fail; three in a
 *     row stop the run (the rest not run, exit 0, a plain line); an empty answer without a failure code stays unparseable;
 *   - forget drops the kinds an earlier provider failure scored as unparseable with zero tokens.
 * Stub drivers only: no station, no model.
 *
 *   node --test company/tools/tests/model-bench-results.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

const TOOLS = path.join(__dirname, '..');
const REPO = path.join(TOOLS, '..', '..');
const UNIT = path.join(REPO, 'packs', 'model-bench');
const B = require(path.join(UNIT, 'lib', 'bench.js'));
const C = require('../lib/capability');
const MB = require('../model-bench.js');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const tmpRoot = tag => { const T = require('../lib/temp-life').tmpDir('mb-results-' + tag + '-'); roots.push(T); fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true }); return T; };
const unit = { dir: UNIT, installed: false };
const MODEL = 'acme/model-x';   // not a stub name, so the capability table reads it
const resFile = (T, m) => path.join(T, 'company', 'state', 'model-bench', String(m).replace(/[^A-Za-z0-9._-]+/g, '_') + '.json');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// a driver: answers from the oracle, except the turns `fail(n)` says end in a provider failure code
function driver(fail) {
  const o = B.stubDriver('oracle'); let n = 0;
  const turn = o.turn.bind(o);
  o.id = MODEL; o.family = 'acme'; o.stub = true;
  o.turn = async (...a) => { const code = fail(n++); return code === undefined ? turn(...a) : { text: '', tokensIn: 0, tokensOut: 0, failure: code }; };
  return o;
}
let runRoot = null;
const runKinds = (kinds, o) => B.run(Object.assign({ unitDir: UNIT, root: runRoot || (runRoot = tmpRoot('runs')), model: MODEL, kinds, driver: driver(() => undefined) }, o || {}));

test('a run of one kind merges into the earlier result: the other kinds stay, each with its own measuredAt and seed', async () => {
  const T = tmpRoot('merge');
  let r = await MB.cmd(['run', '--model', 'stub/oracle', '--kinds', '1', '--depth', 'lookup', '--write', '--seed', '1'], { root: T, unit });
  assert.equal(r.code, 0);
  r = await MB.cmd(['run', '--model', 'stub/oracle', '--kinds', '2', '--depth', 'lookup', '--write', '--seed', '2'], { root: T, unit });
  assert.equal(r.code, 0);
  const res = read(resFile(T, 'stub/oracle'));
  assert.deepEqual(Object.keys(res.kinds), ['1', '2'], 'kind 1 is still there after the kind 2 run');
  assert.equal(res.kinds['1'].seed, 1); assert.equal(res.kinds['2'].seed, 2);
  assert.equal(res.kinds['1'].levels.lookup.seed, 1);
  assert.ok(res.kinds['1'].measuredAt && res.kinds['2'].measuredAt && res.kinds['1'].measuredAt <= res.kinds['2'].measuredAt);
  assert.equal(res.kinds['1'].proven, 'lookup');
  assert.equal(res.complete, false);
  const prev = read(resFile(T, 'stub/oracle').replace(/\.json$/, '.prev.json'));
  assert.deepEqual(Object.keys(prev.kinds), ['1'], 'the file before the write is kept as .prev.json');
  // a third run of kind 1 at another seed replaces kind 1 and keeps kind 2
  await MB.cmd(['run', '--model', 'stub/bad', '--kinds', '1', '--depth', 'lookup', '--write'], { root: T, unit });
  await MB.cmd(['run', '--model', 'stub/oracle', '--kinds', '1', '--depth', 'lookup', '--write', '--seed', '9'], { root: T, unit });
  const res3 = read(resFile(T, 'stub/oracle'));
  assert.equal(res3.kinds['1'].seed, 9); assert.equal(res3.kinds['2'].seed, 2);
  const hist = fs.readFileSync(path.join(T, 'company', 'state', 'model-bench', 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(hist[hist.length - 1].ran, [1]);
  assert.ok(hist[hist.length - 1].kept.includes('2/lookup'));
});

test('the new run replaces the levels it measured; levels it did not run are kept only while their versions match', async () => {
  const a = (await runKinds([1, 2], { depth: 'lookup', seed: 1 })).result;
  const b = (await runKinds([2], { depth: 'lookup', seed: 2 })).result;
  let m = B.mergeResults(UNIT, a, b);
  assert.equal(m.result.kinds['2'].levels.lookup.seed, 2, 'the new level replaces the old');
  assert.equal(m.result.kinds['1'].levels.lookup.seed, 1, 'the untouched kind is kept');
  assert.deepEqual(m.kept.map(x => x.kind + '/' + x.depth), ['1/lookup']);
  // a task of kind 1 changed version since: its old level is dropped
  const stale = JSON.parse(JSON.stringify(a));
  const id = Object.keys(stale.kinds['1'].levels.lookup.taskVersions)[0];
  stale.kinds['1'].levels.lookup.taskVersions[id] = 999;
  m = B.mergeResults(UNIT, stale, b);
  assert.equal(m.result.kinds['1'], undefined);
  assert.deepEqual(m.dropped.map(x => x.kind + ' ' + x.why), ['1 task versions changed']);
  // another bench major version: nothing old is kept
  const oldMajor = Object.assign(JSON.parse(JSON.stringify(a)), { benchVersion: '0.9.0' });
  m = B.mergeResults(UNIT, oldMajor, b);
  assert.deepEqual(Object.keys(m.result.kinds), ['2']);
  assert.match(m.dropped[0].why, /major/);
  // an old file without per-level measuredAt and seed takes its ranAt and seed
  const legacy = JSON.parse(JSON.stringify(a));
  for (const k of Object.values(legacy.kinds)) { delete k.measuredAt; delete k.seed; for (const L of Object.values(k.levels)) { delete L.measuredAt; delete L.seed; } }
  legacy.ranAt = '2026-01-01T00:00:00.000Z'; legacy.seed = 4;
  m = B.mergeResults(UNIT, legacy, b);
  assert.equal(m.result.kinds['1'].measuredAt, '2026-01-01T00:00:00.000Z');
  assert.equal(m.result.kinds['1'].seed, 4);
});

test('the capability table (routing) reads the merged file: every kind measured in any run', async () => {
  const T = tmpRoot('route');
  const a = (await runKinds([1], { depth: 'lookup', seed: 1 })).result;
  const b = (await runKinds([2], { depth: 'lookup', seed: 2 })).result;
  const merged = B.mergeResults(UNIT, a, b).result;
  fs.mkdirSync(path.dirname(resFile(T, MODEL)), { recursive: true });
  fs.writeFileSync(resFile(T, MODEL), JSON.stringify(merged));
  const bench = C.benchResults(T);
  assert.equal(bench.length, 1);
  const { doc } = C.build({ bench, live: [], prev: null, passMark: 0.9, minItems: 20, now: 0 });
  assert.equal(C.currentOf(doc, { provider: 'acme', model: 'model-x' }, 1).current, 'lookup');
  assert.equal(C.currentOf(doc, { provider: 'acme', model: 'model-x' }, 2).current, 'lookup');
});

test('a provider failure is failures.provider and not proven, never the model\'s fail; an empty answer without a code stays unparseable', async () => {
  // every 2nd turn fails with the provider's rate limit: never three in a row
  let r = await runKinds([1], { depth: 'lookup', driver: driver(n => (n % 2 ? 'rate_limited' : undefined)) });
  let L = r.result.kinds['1'].levels.lookup;
  assert.equal(L.failures.provider, 3);
  assert.equal(L.failures.unparseable, 0, 'a provider failure is never unparseable');
  assert.equal(L.passRate, null); assert.equal(L.passed, null);
  assert.equal(L.notProvenReason, 'provider:rate_limited');
  assert.equal(r.result.kinds['1'].proven, null);
  assert.equal(r.result.stopped, undefined);
  assert.ok(r.records.filter(x => x.failure === 'provider').every(x => x.notProven === 'provider:rate_limited' && !x.pass));
  // one provider failure among passes: the level is still not proven
  r = await runKinds([1], { depth: 'lookup', driver: driver(n => (n === 0 ? 'overloaded' : undefined)) });
  L = r.result.kinds['1'].levels.lookup;
  assert.equal(L.notProvenReason, 'provider:overloaded'); assert.equal(L.passRate, null);
  // a code the bench does not list, with an empty answer: still the provider
  r = await runKinds([1], { depth: 'lookup', driver: driver(n => (n === 0 ? 'something_new' : undefined)) });
  assert.equal(r.result.kinds['1'].levels.lookup.notProvenReason, 'provider:something_new');
  // an empty answer, no failure code: the model's own unparseable answer
  const T = tmpRoot('empty');
  const e = await MB.cmd(['run', '--model', 'stub/empty', '--kinds', '1', '--depth', 'lookup'], { root: T, unit });
  const E = e.out.kinds['1'].levels.lookup;
  assert.equal(E.failures.unparseable, 6); assert.equal(E.failures.provider, 0); assert.equal(E.passed, 0); assert.equal(E.notProvenReason, null);
});

test('three provider failures in a row stop the run: the rest not run, exit 0, a plain line', async () => {
  const T = tmpRoot('quota');
  const r = await MB.cmd(['run', '--model', 'stub/quota', '--kinds', '1,2', '--write'], { root: T, unit });
  assert.equal(r.code, 0);
  assert.match(r.text, /stopped early: the provider failed 3 times in a row \(quota_exhausted\)/);
  const res = read(resFile(T, 'stub/quota'));
  assert.equal(res.stopped.notRun, 48 - 3);
  for (const k of Object.values(res.kinds)) {
    assert.equal(k.proven, null);
    for (const L of Object.values(k.levels)) { assert.equal(L.passRate, null); assert.equal(L.failures.unparseable, 0); assert.match(L.notProvenReason, /^(provider:quota_exhausted|not-run: provider:quota_exhausted)$/); }
  }
  assert.equal(res.kinds['1'].levels.lookup.failures.provider, 3);
  assert.equal(res.kinds['2'].levels.deep.failures.notRun, 6);
  // a provider stop counts its instances: the runner made 3 turns, no more
  let turns = 0;
  const d = driver(() => { turns++; return 'usage_limit'; });
  const run = await runKinds([1, 2], { driver: d });
  assert.equal(turns, 3);
  assert.equal(run.records.filter(x => x.failure === 'notRun').length, 45);
  assert.equal(run.result.complete, false);
});

test('a provider-failed level never replaces a measured one in the merged result', async () => {
  const a = (await runKinds([1], { depth: 'lookup', seed: 1 })).result;
  const b = (await runKinds([1], { depth: 'lookup', driver: driver(() => 'quota_exhausted') })).result;
  const m = B.mergeResults(UNIT, a, b).result;
  assert.equal(m.kinds['1'].levels.lookup.passRate, 1);
  assert.equal(m.kinds['1'].proven, 'lookup');
  assert.equal(m.kinds['1'].levels.lookup.seed, 1);
});

test('forget drops the kinds an earlier provider failure scored as unparseable with zero tokens', async () => {
  const T = tmpRoot('forget');
  const good = (await runKinds([1], { depth: 'lookup', seed: 1 })).result;
  // what the bench wrote before it told providers apart: every instance unparseable, no tokens
  const damaged = JSON.parse(JSON.stringify(good));
  damaged.kinds['2'] = JSON.parse(JSON.stringify(good.kinds['1']));
  damaged.kinds['3'] = JSON.parse(JSON.stringify(good.kinds['1']));
  for (const k of ['2', '3']) for (const L of Object.values(damaged.kinds[k].levels)) Object.assign(L, { passed: 0, passRate: 0, tokensIn: 0, tokensOut: 0, failures: { timeout: 0, unparseable: L.instances, crash: 0, refused: 0, sandbox: 0 } });
  fs.mkdirSync(path.dirname(resFile(T, MODEL)), { recursive: true });
  fs.writeFileSync(resFile(T, MODEL), JSON.stringify(damaged));
  let r = await MB.cmd(['forget', '--model', MODEL, '--dry-run', '--json'], { root: T, unit });
  assert.deepEqual(r.out.dropped, [2, 3]);
  assert.deepEqual(Object.keys(read(resFile(T, MODEL)).kinds), ['1', '2', '3'], 'a dry run writes nothing');
  r = await MB.cmd(['forget', '--model', MODEL, '--kinds', '3', '--json'], { root: T, unit });
  assert.deepEqual(r.out.dropped, [3]);
  assert.deepEqual(Object.keys(read(resFile(T, MODEL)).kinds), ['1', '2']);
  r = await MB.cmd(['forget', '--model', MODEL], { root: T, unit });
  assert.match(r.text, /dropped kind\(s\) 2/);
  assert.deepEqual(Object.keys(read(resFile(T, MODEL)).kinds), ['1'], 'a real result stays');
  assert.ok(fs.existsSync(resFile(T, MODEL).replace(/\.json$/, '.prev.json')));
  r = await MB.cmd(['forget', '--model', MODEL], { root: T, unit });
  assert.match(r.text, /nothing to drop/);
  r = await MB.cmd(['forget', '--model', 'acme/none'], { root: T, unit });
  assert.equal(r.code, 1);
  // a real unparseable answer used tokens: never forgotten
  const g = (await runKinds([1], { depth: 'lookup', driver: Object.assign(B.stubDriver('garbage'), { id: MODEL }) })).result;
  assert.deepEqual(B.forgetDamaged(g).dropped, []);
});

// a driver whose turns `end(n)` answers with a whole run end (text, failure, reason, error), or undefined: the oracle
function endDriver(end) {
  const o = B.stubDriver('oracle'); let n = 0;
  const turn = o.turn.bind(o);
  o.id = MODEL; o.family = 'acme'; o.stub = true;
  o.turn = async (...a) => { const e = end(n++); if (e === undefined) return turn(...a); if (e instanceof Error) throw e; return Object.assign({ text: '', tokensIn: 0, tokensOut: 0 }, e); };
  return o;
}

test('a provider failure with no failure code (the cause only in the error text, or an error end with no answer) is the provider\'s', async () => {
  // the run end the station sends for a usage limit: an empty failureCode, reason error, the cause in the error text
  let r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? { text: '', failure: '', reason: 'error', error: 'usage limit reached' } : undefined)) });
  let L = r.result.kinds['1'].levels.lookup;
  assert.equal(L.failures.provider, 1); assert.equal(L.failures.unparseable, 0);
  assert.equal(L.notProvenReason, 'provider:error:usage limit reached'); assert.equal(L.passRate, null);
  // three in a row stop the run like any provider failure
  let turns = 0;
  r = await runKinds([1, 2], { driver: endDriver(() => { turns++; return { text: '', failure: '', reason: 'error', error: 'usage limit reached' }; }) });
  assert.equal(turns, 3); assert.equal(r.result.stopped.code, 'error:usage limit reached');
  // an error end with no answer and no error text: still the provider
  r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? { reason: 'error' } : undefined)) });
  assert.equal(r.result.kinds['1'].levels.lookup.notProvenReason, 'provider:error:unknown');
  // the pure rule
  assert.equal(B.providerFailure('', 'some answer', { reason: 'stop' }), null, 'an answer with no code is the model\'s');
  assert.equal(B.providerFailure('', '', {}), null, 'an empty answer with no code and no error stays unparseable');
  assert.equal(B.providerFailure('', 'partial', { error: 'HTTP 429 Too Many Requests' }), 'error:HTTP 429 Too Many Requests');
  assert.equal(B.providerFailure('', '', { reason: 'error', error: 'refused by content policy' }), null);
});

test('a station HTTP 429 or 5xx, or a socket error, is the provider\'s; any other station error stays a crash', async () => {
  let r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? B.httpError(429, 'busy') : undefined)) });
  assert.equal(r.result.kinds['1'].levels.lookup.notProvenReason, 'provider:rate_limited');
  r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? B.httpError(503, 'down') : undefined)) });
  assert.equal(r.result.kinds['1'].levels.lookup.notProvenReason, 'provider:http_503');
  r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? B.socketError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) : undefined)) });
  assert.equal(r.result.kinds['1'].levels.lookup.notProvenReason, 'provider:network');
  r = await runKinds([1], { depth: 'lookup', driver: endDriver(n => (n === 0 ? B.httpError(400, 'bad request') : undefined)) });
  const L = r.result.kinds['1'].levels.lookup;
  assert.equal(L.failures.crash, 1); assert.equal(L.failures.provider, 0);
});

test('the station driver forwards the run end\'s reason and error, and rejects a 429 as the provider\'s', async () => {
  const http = require('http');
  let mode = 'end';
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === '429') { res.writeHead(429); return res.end('slow down'); }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ name: 'agent.run.start', payload: { runId: 'r1' } }) + '\n');
      res.end(JSON.stringify({ name: 'agent.run.end', payload: { runId: 'r1', failureCode: '', reason: 'error', error: 'usage limit reached' } }) + '\n');
    });
  });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  try {
    const d = B.stationDriver({ model: 'acme/model-x', seat: 'bench', token: 't', stationUrl: 'http://127.0.0.1:' + srv.address().port });
    const t = await d.turn([{ role: 'user', content: 'hi' }]);
    assert.equal(t.text, ''); assert.equal(t.reason, 'error'); assert.equal(t.error, 'usage limit reached');
    assert.equal(B.providerFailure(t.failure, t.text, t), 'error:usage limit reached');
    mode = '429';
    await assert.rejects(d.turn([{ role: 'user', content: 'hi' }]), e => e.providerCode === 'rate_limited');
  } finally { srv.close(); }
});

test('a run of an older unit merged in: its levels get its own time and seed, and its damaged levels never replace measured ones', async () => {
  const a = (await runKinds([1, 2], { depth: 'lookup', seed: 1 })).result;
  // what an older unit writes for a quota-hit run of kind 1: unparseable, no tokens, no per-level measuredAt or seed
  const b = JSON.parse(JSON.stringify((await runKinds([1, 3], { depth: 'lookup', seed: 5 })).result));
  b.ranAt = '2099-01-01T00:00:00.000Z';
  for (const k of Object.values(b.kinds)) { delete k.measuredAt; delete k.seed; for (const L of Object.values(k.levels)) { delete L.measuredAt; delete L.seed; } }
  Object.assign(b.kinds['1'].levels.lookup, { passed: 0, passRate: 0, tokensIn: 0, tokensOut: 0, notProvenReason: null, failures: { timeout: 0, unparseable: b.kinds['1'].levels.lookup.instances, crash: 0, refused: 0, sandbox: 0 } });
  const m = B.mergeResults(UNIT, a, b).result;
  assert.equal(m.kinds['1'].levels.lookup.passRate, 1, 'the damaged level did not replace the measured one');
  assert.equal(m.kinds['1'].levels.lookup.seed, 1); assert.equal(m.kinds['1'].levels.lookup.measuredAt, a.kinds['1'].levels.lookup.measuredAt);
  assert.equal(m.kinds['2'].levels.lookup.measuredAt, a.kinds['2'].levels.lookup.measuredAt, 'a kept level keeps its own time');
  assert.equal(m.kinds['3'].levels.lookup.measuredAt, '2099-01-01T00:00:00.000Z', 'the new level is dated by its own run');
  assert.equal(m.kinds['3'].levels.lookup.seed, 5); assert.equal(m.kinds['3'].seed, 5);
  // with nothing measured before, the damaged level stays (forget can drop it)
  const only = B.mergeResults(UNIT, null, b).result;
  assert.equal(only.kinds['1'].levels.lookup.passRate, 0); assert.equal(only.kinds['1'].levels.lookup.measuredAt, '2099-01-01T00:00:00.000Z');
});
