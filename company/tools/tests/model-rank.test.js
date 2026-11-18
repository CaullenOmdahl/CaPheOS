#!/usr/bin/env node
/* model-rank.test.js — the house ranking (docs/RANKING.md): the golden fixture (tests/fixtures/ranking, built by its
 * build.js), a deterministic rerun, minItems, servedModel vs claimed, the half-weight lead verdict, the dispatch-slice
 * exclusion, the hash-chained history, the read-only duty, the task class rules and the benchmark book checker.
 *
 *   node --test company/tools/tests/model-rank.test.js
 */
'use strict';
process.env.CAPHEOS_TZ = 'UTC';   // before lib/company.js is loaded: the in-process checks read close stamps as the child does
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync } = require('child_process');

const TOOLS = path.join(__dirname, '..');
const TOOL = path.join(TOOLS, 'model-rank.js');
const FIX = path.join(__dirname, 'fixtures', 'ranking');
const NOW = JSON.parse(fs.readFileSync(path.join(FIX, 'now.json'), 'utf8')).now;
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

function fixtureRoot() { const T = fs.mkdtempSync(path.join(os.tmpdir(), 'model-rank-test-')); roots.push(T); fs.cpSync(path.join(FIX, 'root'), T, { recursive: true }); return T; }
const env = (T, extra) => Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }, extra || {});
const run = (T, args, extra) => spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8', env: env(T, extra), timeout: 60000 });
const out = (T, f) => path.join(T, 'company', 'work', 'models', f);
const ranking = T => JSON.parse(fs.readFileSync(out(T, 'house-ranking.json'), 'utf8'));
const cell = (r, id) => r.cells.find(c => c.id === id);
function treeHash(root) {
  const h = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(f, r); else h[r] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + fs.statSync(f).mtimeMs; } };
  walk(root, ''); return h;
}

test('golden fixture: refresh writes exactly the expected house-ranking.json', () => {
  const T = fixtureRoot();
  const r = run(T, ['refresh', '--force', '--now', String(NOW)]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(out(T, 'house-ranking.json'), 'utf8'), fs.readFileSync(path.join(FIX, 'expected-house-ranking.json'), 'utf8'));
  assert.ok(fs.existsSync(out(T, 'house-ranking.md')));
});

test('deterministic: a rerun on the same inputs is byte-identical and adds no history or proposal rows', () => {
  const T = fixtureRoot();
  assert.equal(run(T, ['refresh', '--force', '--now', String(NOW)]).status, 0);
  const files = ['house-ranking.json', 'house-ranking.md', 'house-ranking-history.jsonl', 'routing-proposals.jsonl'].map(f => fs.readFileSync(out(T, f), 'utf8'));
  const r = run(T, ['refresh', '--force', '--now', String(NOW + 3 * 3600e3)]);   // later clock, same items in the window
  assert.equal(r.status, 0); assert.match(r.stdout, /unchanged/);
  assert.deepEqual(['house-ranking.json', 'house-ranking.md', 'house-ranking-history.jsonl', 'routing-proposals.jsonl'].map(f => fs.readFileSync(out(T, f), 'utf8')), files);
  // the pure function too: the same inputs give the same body, key order included
  const M = require(TOOL);
  const inp = M.load({ root: T, now: NOW });
  assert.equal(JSON.stringify(M.sortKeys(M.rank(inp))), JSON.stringify(M.sortKeys(M.rank(M.load({ root: T, now: NOW })))));
  assert.equal(ranking(T).hash, M.bodyHash(M.rank(inp)), 'the hash covers the body, not computedAt');
});

test('a cell under minItems says not enough data and steers nothing', () => {
  const T = fixtureRoot(); run(T, ['refresh', '--force', '--now', String(NOW)]);
  const r = ranking(T);
  const o = cell(r, 'code|claude-cli/claude-opus-4-8|medium|served');
  assert.equal(o.items, 5); assert.equal(o.enough, false); assert.equal(o.status, 'not enough data'); assert.equal(o.score, null); assert.equal(o.rank, null);
  assert.ok(!r.proposals.some(p => p.to.cell === o.id));
  const m = cell(r, 'mechanical|deepseek/deepseek-flash|high|claimed');
  assert.equal(m.status, 'not enough data');
  assert.equal(m.usd, 0.06, 'metered runs keep their real usd');
});

test('servedModel groups by what the provider served; a row without it is claimed', () => {
  const T = fixtureRoot(); run(T, ['refresh', '--force', '--now', String(NOW)]);
  const r = ranking(T);
  const claimed = cell(r, 'code|claude-cli/claude-fable-5-2[1m]|medium|claimed');
  const served = cell(r, 'code|claude-cli/claude-opus-4-8|medium|served');
  assert.ok(claimed && claimed.claimed === true && claimed.items === 22, 'requested Fable with no servedModel: its own claimed cell');
  assert.ok(served && served.claimed === false, 'requested Fable, served Opus 4.8: counted as Opus 4.8');
  assert.ok(!r.cells.some(c => /fable/.test(c.model) && !c.claimed), 'no unverified row is counted as a served Fable');
  assert.equal(cell(r, 'code|claude-cli/claude-sonnet-5-5|high|served').claimed, false);
});

test('verdicts: a lead\'s REVISE on its own report counts half; self-grades and uncited verdicts are ignored', () => {
  const T = fixtureRoot(); run(T, ['refresh', '--force', '--now', String(NOW)]);
  const r = ranking(T);
  const f = cell(r, 'code|claude-cli/claude-fable-5-2[1m]|medium|claimed');
  assert.equal(f.oneShot, 21.5, 'F02 (the lead\'s REVISE) counts 0.5; F04 (self) and F06 (no check) do not count');
  assert.equal(r.totals.selfGradesIgnored, 1); assert.equal(r.totals.uncitedIgnored, 1);
  const s = cell(r, 'code|claude-cli/claude-sonnet-5-5|high|served');
  assert.equal(s.oneShot, 22, 'S03 (a peer REVISE) and S05 (reopened) are not one-shot');
  assert.equal(s.reopened, 1);
  const lee = r.graders.find(g => g.seat === 'lee');
  assert.deepEqual([lee.verdicts, lee.weight], [2, 1], 'two verdicts by the lead, each at half weight (one from a consult block)');
  // unit level: the same verdict by a peer counts whole
  const M = require(TOOL);
  const inp = M.load({ root: T, now: NOW });
  inp.files = inp.files.map(x => x.file === 'to-kim.md' ? { file: x.file, text: x.text.replace('REVISE by Lee — check: acceptance step 3', 'REVISE by Ria — check: acceptance step 3') } : x);
  assert.equal(M.rank(inp).cells.find(c => c.id === f.id).oneShot, 21);
});

test('a dispatch-slice cancel and a provider error are excluded, not failures', () => {
  const T = fixtureRoot(); run(T, ['refresh', '--force', '--now', String(NOW)]);
  const f = cell(ranking(T), 'code|claude-cli/claude-fable-5-2[1m]|medium|claimed');
  assert.equal(f.excludedRuns, 2, 'the F12 child cut by the slice and the X01 provider error');
  assert.equal(f.excludedItems, 1, 'X01 has no other run: not scored');
  assert.equal(f.items, 22, 'F12 is still scored on its lead run');
  assert.equal(f.extraRunsPerItem, 0.0455, 'only F10\'s second own run is rework (1/22)');
  assert.equal(f.costPerItem, 0.940909, 'the cut child\'s cost is not in the cell\'s cost per item');
  assert.equal(f.excludedListUsd, 1.016, '...it is reported apart');
  const M = require(TOOL);
  assert.equal(M.runKind({ runId: 'c', parentRunId: 'p', reason: 'cancelled' }, new Map([['c', { reason: 'timeout' }]])), 'sliceCut');
  assert.equal(M.runKind({ runId: 'c', reason: 'cancelled' }, new Map([['c', { reason: 'timeout' }]])), 'stopped', 'only a delegated child is a slice cut');
});

test('defects, premerge first pass, items per change and the routing proposal', () => {
  const T = fixtureRoot(); run(T, ['refresh', '--force', '--now', String(NOW)]);
  const r = ranking(T);
  const f = cell(r, 'code|claude-cli/claude-fable-5-2[1m]|medium|claimed'), s = cell(r, 'code|claude-cli/claude-sonnet-5-5|high|served');
  assert.deepEqual([f.defects, f.defectPoints], [1, 4], 'one confirmed S1 through the credit\'s author run');
  assert.deepEqual([s.premergeKnown, s.premergeFirstPassRate], [2, 0.5], 'PR 12 failed first, PR 13 passed first');
  assert.equal(s.itemsPerChange, 1);
  assert.equal(r.totals.settling, 1, 'S25 closed less than oneShotWindowDays ago');
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.mode, 'shadow'); assert.equal(p.department, 'eng'); assert.equal(p.from.cell, f.id); assert.equal(p.to.cell, s.id);
  const rows = fs.readFileSync(out(T, 'routing-proposals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(x => [x.kind, x.id]), [['proposal', p.id]]);
});

test('the history file is hash-chained: a removed or edited row is caught', () => {
  const T = fixtureRoot();
  assert.equal(run(T, ['refresh', '--force', '--now', String(NOW)]).status, 0);
  // a second, different ranking: a stricter minItems in the company's policy copy
  const pf = out(T, 'ranking-policy.json'); const pol = JSON.parse(fs.readFileSync(pf, 'utf8')); pol.minItems = 23; fs.writeFileSync(pf, JSON.stringify(pol));
  assert.equal(run(T, ['refresh', '--now', String(NOW)]).status, 0, 'a policy change makes a refresh due');
  const h = out(T, 'house-ranking-history.jsonl');
  const rows = fs.readFileSync(h, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 2); assert.equal(rows[1].prev, rows[0].rowHash); assert.equal(rows[0].prev, 'sha256:genesis');
  assert.equal(cell(ranking(T), 'code|claude-cli/claude-fable-5-2[1m]|medium|claimed').status, 'not enough data', '22 < 23');
  assert.equal(run(T, ['verify']).status, 0);
  const good = fs.readFileSync(h, 'utf8');
  fs.writeFileSync(h, good.split('\n').slice(1).join('\n'));
  assert.equal(run(T, ['verify']).status, 1, 'the first row removed');
  const edited = JSON.parse(good.split('\n')[0]); edited.cells[0][1] = 99;
  fs.writeFileSync(h, JSON.stringify(edited) + '\n' + good.split('\n').slice(1).join('\n'));
  const v = run(T, ['verify']); assert.equal(v.status, 1); assert.match(v.stdout, /does not match its contents/);
  // after a retention roll the pointer line records it, and the chain restarts from the first live row
  fs.writeFileSync(h, JSON.stringify({ _retention: 'rolled', archive: ['x'] }) + '\n' + good.split('\n').slice(1).join('\n'));
  assert.equal(run(T, ['verify']).status, 0);
});

test('the duty is read-only, offline, quiet when nothing is open, and due for an open proposal until it is decided', () => {
  const T = fixtureRoot();
  const guard = path.join(T, '..', path.basename(T) + '-guard.js'); roots.push(guard);
  fs.writeFileSync(guard, "const M = require('module'); const o = M._load; M._load = function (r) { if (/^(node:)?(http|https|http2|net|tls|dgram|undici)$/.test(r)) process.stderr.write('NETWORK:' + r + '\\n'); return o.apply(this, arguments); }; globalThis.fetch = () => { process.stderr.write('NETWORK:fetch\\n'); return Promise.reject(new Error('no')); };");
  const duty = extra => spawnSync(process.execPath, ['-r', guard, TOOL, '--duty'], { cwd: T, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: T, CAPHEOS_ROOT: T, CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1', CAPHEOS_TZ: 'UTC', TZ: 'UTC', ...(extra || {}) } });
  const before = treeHash(T);
  const d = duty({ MODEL_RANK_NOW: String(NOW) });
  assert.equal(d.status, 1, d.stderr + d.stdout);
  const j = JSON.parse(d.stdout);
  assert.equal(j.due, true); assert.equal(j.route, 'people'); assert.match(j.key, /^rp-[0-9a-f]{16}$/);
  assert.equal(j.items.length, 1); assert.match(j.items[0].id, /^rp-[0-9a-f]{12}$/);
  assert.ok(j.reason.length <= 300 && /1 routing proposal/.test(j.reason) && !/task S|task F/.test(j.reason), 'counts and ids only');
  assert.doesNotMatch(d.stderr, /NETWORK:/);
  assert.deepEqual(treeHash(T), before, 'the duty changed a file');
  // quiet: no work in its window (today's clock: the fixture is years away) -> exit 0, nothing printed
  const q = duty(); assert.equal(q.status, 0, q.stderr); assert.equal(q.stdout.trim(), '');
  // decided -> quiet
  assert.equal(run(T, ['refresh', '--force', '--now', String(NOW)]).status, 0);
  const dec = run(T, ['decide', j.items[0].id, '--verdict', 'noted', '--by', 'Lee', '--reason', 'waiting for more Fable data']);
  assert.equal(dec.status, 0, dec.stderr);
  assert.equal(run(T, ['decide', j.items[0].id, '--verdict', 'declined', '--by', 'lee']).status, 1, 'decided once');
  const after = duty({ MODEL_RANK_NOW: String(NOW) }); assert.equal(after.status, 0, after.stdout); assert.equal(after.stdout.trim(), '');
  // no policy -> nothing ranked, quiet
  fs.rmSync(out(T, 'ranking-policy.json'));
  assert.equal(duty({ MODEL_RANK_NOW: String(NOW) }).status, 0);
  assert.match(run(T, ['refresh', '--force', '--now', String(NOW)]).stdout, /no ranking policy/);
});

test('refresh is at most every refreshMinutes, and the shipped default policy is complete', () => {
  const T = fixtureRoot();
  const M = require(TOOL);
  assert.equal(M.refreshDue({ root: T, now: NOW }), true);
  assert.equal(run(T, ['refresh', '--now', String(NOW)]).status, 0);
  assert.equal(M.refreshDue({ root: T, now: NOW + 30 * 60e3 }), false, '30 minutes later');
  assert.match(run(T, ['refresh', '--now', String(NOW + 30 * 60e3)]).stdout, /not due/);
  assert.equal(M.refreshDue({ root: T, now: NOW + 61 * 60e3 }), true);
  const def = JSON.parse(fs.readFileSync(path.join(TOOLS, '..', 'defaults', 'work', 'models', 'ranking-policy.json'), 'utf8'));
  for (const k of ['refreshMinutes', 'windowDays', 'oneShotWindowDays', 'minItems', 'interval', 'score', 'signals', 'oneShot', 'verdicts', 'weights', 'defects', 'rework', 'ownerCorrections', 'exclude', 'cost', 'tail', 'graders', 'proposals', 'readBounds'])
    assert.ok(def[k] !== undefined && def['_' + k] !== undefined, 'the default policy has ' + k + ' and says what it does');
  assert.equal(def.minItems, 20); assert.equal(def.weights.leadOnOwnReport, 0.5); assert.equal(def.oneShotWindowDays, 7); assert.equal(def.interval.confidence, 0.8); assert.equal(def.proposals.mode, 'shadow');
  const k = M.knobs(Object.assign({}, def, { refreshMinutes: 5 }));
  assert.equal(k.refreshMin, 60, 'never more often than hourly');
});

test('task class: an explicit Class line wins, then Effort mechanical, then the department default, then general', () => {
  const TC = require(path.join(TOOLS, 'lib', 'taskclass.js'));
  const deps = { departments: [{ id: 'eng', lead: 'lee', members: ['sam'], defaultClass: 'code' }] };
  assert.equal(TC.classOf('## x\n**Class:** research\n**Effort:** mechanical', 'sam', { departments: deps }), 'research');
  assert.equal(TC.classOf('## x\n**Effort:** mechanical', 'sam', { departments: deps }), 'mechanical');
  assert.equal(TC.classOf('## x', 'sam', { departments: deps }), 'code');
  assert.equal(TC.classOf('## x', 'zed', { departments: deps }), 'general');
  assert.equal(TC.classOf('## x\n**Class:** banana', 'zed', { departments: deps }), 'general', 'an unknown class word is ignored');
  assert.equal(TC.leadOf('sam', deps, {}), 'lee');
  assert.equal(TC.leadOf('lee', deps, { lee: { manager: 'boss' } }), 'boss', 'a lead is graded by its own manager');
  assert.deepEqual(TC.CLASSES, ['code', 'review', 'research', 'writing', 'design', 'ops', 'mechanical', 'general']);
});

test('check-benchmarks.py passes its positive fixture and fails every negative one', () => {
  const py = spawnSync('python3', ['-I', path.join(TOOLS, 'check-benchmarks.py'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  if (py.error && py.error.code === 'ENOENT') return;   // no python3 on this machine
  assert.equal(py.status, 0, py.stdout + py.stderr);
  assert.match(py.stdout, /negative fixture bad-missing-model\.json fails/);
  const bad = path.join(__dirname, 'fixtures', 'benchmarks', 'bad-source.json');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-')); roots.push(T);
  fs.writeFileSync(path.join(T, 'book.json'), JSON.stringify(JSON.parse(fs.readFileSync(bad, 'utf8')).book));
  const neg = spawnSync('python3', ['-I', path.join(TOOLS, 'check-benchmarks.py'), '--book', path.join(T, 'book.json'), '--policy', path.join(__dirname, 'fixtures', 'benchmarks', 'policy.json')], { encoding: 'utf8' });
  assert.equal(neg.status, 1, neg.stdout); assert.match(neg.stdout, /not an http\(s\) URL/);
  const pos = spawnSync('python3', ['-I', path.join(TOOLS, 'check-benchmarks.py'), '--book', path.join(__dirname, 'fixtures', 'benchmarks', 'good.json'), '--policy', path.join(__dirname, 'fixtures', 'benchmarks', 'policy.json')], { encoding: 'utf8', env: Object.assign({}, process.env, { CLAUDE_MODEL_CATALOG: path.join(T, 'none', '*.json') }) });
  assert.equal(pos.status, 0, pos.stdout);
});
