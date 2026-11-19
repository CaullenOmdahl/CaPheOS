#!/usr/bin/env node
/* delegation-fanout.test.js — narrow fan-out (docs/DEPARTMENTS.md §6, the middle-management plan's P5 bars), on fixture
 * companies:
 *   - splitOk refuses 2 pieces, a piece with no check and two pieces sharing a file;
 *   - a lead's SPLIT answer writes the pieces into the member's item when splitting is live, and only records it (WOULD
 *     DELEGATE, the item stays with the member) when it is recording only; splitting off refuses it; the lead's own split;
 *   - departments.js delegation: the owner's switch, workers only from the lead's reports (DELEGATE_OUTSIDE_SUBTREE), the
 *     check codes, the dispatcher's --auto withdraw and the owner-only resume; set-route: the class rules first (a code
 *     route to the MiniMax plan is refused for the owner too), --by routing-proposal refused from an agent's run;
 *   - lib/delegate-allow.js compute: a worker outside the lead's subtree is never listed, a busy worker is not listed, a
 *     pacer hold on a worker's provider lists no workers for that lead, a code item never lists a worker on the MiniMax
 *     plan, one item at a time per lead; build() from a recorded split with the real files;
 *   - model-rank.js fanoutEvaluation: withdraw when the delegated cost per accepted item is not below the single-seat cost
 *     over 10 items, keep when it is, not enough data below, deterministic; the dispatcher withdraws once per hash;
 *   - the family books: a child run's spend is the lead's, and the totals match runs.jsonl exactly, per item too;
 *   - piece lanes through the real dispatch.js against tests/mock-station.js: each piece is its own run on a listed
 *     worker's agent, at most maxWorkers at once, on its own time limit, Sprint off; the item gets each piece's lane line
 *     and result, and the wake row names the split; the dispatcher writes the delegation list every tick.
 *   node --test company/tools/tests/delegation-fanout.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const C = require(path.join(TOOLS, 'lib', 'consult.js'));
const DA = require(path.join(TOOLS, 'lib', 'delegate-allow.js'));
const D = require(path.join(TOOLS, 'lib', 'departments.js'));
const MR = require(path.join(TOOLS, 'model-rank.js'));
const FAM = require(path.join(TOOLS, 'lib', 'family.js'));
const POLICY = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/ranking-policy.json'), 'utf8'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };
const jsonl = (root, rel) => (read(root, rel) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));

const CREW = {
  boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' },
  hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' },
  kwa: { name: 'Kwame', manager: 'boss', inbox: 'to-kwame.md', loop: 'Kwame loop' },
  ben: { name: 'Ben', manager: 'kwa', inbox: 'to-ben.md', loop: 'Ben loop' },
  cat: { name: 'Cat', manager: 'kwa', inbox: 'to-cat.md', loop: 'Cat loop' },
  dan: { name: 'Dan', manager: 'ben', inbox: 'to-dan.md', loop: 'Dan loop' },
  zed: { name: 'Zed', manager: 'boss', inbox: 'to-zed.md', loop: 'Zed loop' },
};
const deptsDoc = (delegation, advisor) => ({ version: 1, leadModelDefault: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' },
  departments: [{ id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben', 'cat', 'dan'], defaultClass: 'code', routes: { code: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' } },
    consult: { maxPerDay: 12, stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2 },
    advisor: advisor || { mode: 'live', since: '2026-11-01T00:00:00.000Z', by: 'owner', paused: null },
    delegation: delegation === undefined ? { mode: 'live', workers: ['ben', 'cat'], maxWorkers: 2, workerTimeoutMin: 20 } : delegation }] });
const item = (id, head) => '\n## 2026-11-20 from Boss — ' + head + '\n**Id:** ' + id + '\n**Need:** do it\n**Status:** OPEN\n';
const PIECES = ['the parser — files: src/parse.js — check: npm test -- parse', 'the lexer — files: src/lex.js — check: npm test -- lex', 'the docs — files: docs/parser.md — check: the doc builds'];

function fixture(o) {
  o = o || {};
  const root = __LIFE.tmpDir('fanout-test-'); roots.push(root);
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/departments.json', 'company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/work/departments/advise-prompt.md', 'company/defaults/work/models/ranking-policy.json', 'company/defaults/work/models/routing-policy.json', 'company/model-policy.json'])
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  w(root, 'company/state/governance.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  w(root, 'company/departments.json', o.depts || deptsDoc(o.delegation));
  for (const f of ['BRIEF.md', 'INBOX-DIGEST.md']) w(root, 'company/work/departments/eng/' + f, '# x\n');
  w(root, 'company/work/departments/eng/DECISIONS.md', '# Engineering — decisions\n\nNewest first.\n\n');
  w(root, 'company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w(root, 'company/work/handoffs/to-ben.md', '# Handoffs\n' + item('ben-parser', 'rewrite the parser'));
  w(root, 'company/work/handoffs/to-kwame.md', '# Handoffs\n' + item('kwa-big', 'the big refactor'));
  for (const s of ['to-cat.md', 'to-boss.md', 'to-hal.md', 'to-dan.md', 'to-zed.md']) w(root, 'company/work/handoffs/' + s, '# Handoffs\n');
  return root;
}
// a tool's run(argv) in a child process with CAPHEOS_ROOT at the fixture; o.station: as if inside an agent's run
function tool(root, file, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(' + (o.station ? 'true' : 'false') + '); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'const r = require(' + JSON.stringify(path.join(TOOLS, file)) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }, o.env || {}) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
function inRoot(root, js) {
  const r = spawnSync(process.execPath, ['-e', 'const C = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'consult.js')) + '); const DA = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'delegate-allow.js')) + '); Promise.resolve(' + js + ').then(x => process.stdout.write(JSON.stringify(x === undefined ? null : x)));'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC' }) });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const consult = (root, argv, o) => tool(root, 'consult.js', argv, o);
const depts = (root, argv, o) => tool(root, 'departments.js', argv, o);
const pieceBlock = list => '**Pieces:**\n' + list.map((p, i) => (i + 1) + '. ' + p).join('\n');

test('splitOk: two pieces, a piece with no check and two pieces sharing a file are refused; three clean pieces pass', () => {
  assert.equal(C.splitOk(pieceBlock(PIECES)).ok, true);
  assert.equal(C.splitOk(pieceBlock(PIECES)).pieces.length, 3);
  assert.match(C.splitOk(pieceBlock(PIECES.slice(0, 2))).why, /2 pieces; a split needs at least 3/);
  assert.match(C.splitOk(pieceBlock([PIECES[0], PIECES[1], 'the docs — files: docs/parser.md'])).why, /piece 3 has no acceptance check/);
  assert.match(C.splitOk(pieceBlock([PIECES[0], PIECES[1], 'more parser — files: src/parse.js — check: npm test'])).why, /pieces 1 and 3 both touch src\/parse\.js/);
  assert.match(C.splitOk(pieceBlock([PIECES[0], PIECES[1], 'all of src — files: src — check: npm test'])).why, /both touch/, 'a folder overlaps the files under it');
  assert.equal(C.splitOk(pieceBlock(PIECES), { minPieces: 4 }).ok, false, 'minPieces is config');
  // at most maxPieces (default 6): a lead's own split of many pieces is refused, so one run's workers stay bounded
  const many = n => Array.from({ length: n }, (_, i) => 'part ' + (i + 1) + ' — files: src/p' + (i + 1) + '.js — check: npm test');
  assert.equal(C.splitOk(pieceBlock(many(6))).ok, true);
  assert.match(C.splitOk(pieceBlock(many(7))).why, /7 pieces; a split has at most 6/);
  assert.match(C.splitOk(pieceBlock(many(30)), { maxPieces: 12 }).why, /at most 12/);
});

test('a SPLIT answer: live writes the pieces into the member\'s item and records the split; recording only keeps the item with the member; off refuses', () => {
  for (const mode of ['live', 'shadow', 'off']) {
    const root = fixture({ delegation: { mode, workers: ['ben', 'cat'], maxWorkers: 2, workerTimeoutMin: 20 } });
    const ask = consult(root, ['ask', '--item', 'ben-parser', '--question', 'Can this be split?', '--kind', 'plan', '--check', 'npm test', '--by', 'Ben']);
    assert.equal(ask.code, 0, JSON.stringify(ask));
    const argv = ['answer', ask.out.id, '--verdict', 'SPLIT', '--check', 'read the item', '--fanout', 'lanes', '--by', 'Kwame'];
    for (const p of PIECES) argv.push('--piece', p);
    const r = consult(root, argv);
    const box = read(root, 'company/work/handoffs/to-ben.md');
    if (mode === 'off') { assert.equal(r.code, 2); assert.match(r.out.error, /splitting big jobs is off for Engineering/); assert.ok(!/Pieces/.test(box)); continue; }
    assert.equal(r.code, 0, JSON.stringify(r));
    const split = jsonl(root, 'company/state/consults.jsonl').filter(x => x.op === 'split');
    assert.equal(split.length, 1); assert.equal(split[0].item, 'ben-parser'); assert.equal(split[0].pieces.length, 3); assert.equal(split[0].fanout, 'lanes'); assert.equal(split[0].lead, 'kwa');
    assert.match(box, /\*\*Verdict:\*\* SPLIT by Kwame — check: read the item — 1\. the parser 2\. the lexer 3\. the docs/);
    if (mode === 'live') {
      assert.ok(!split[0].shadow);
      assert.match(box, /\*\*Pieces:\*\*\n1\. the parser — files: src\/parse\.js — check: npm test -- parse\n2\. the lexer/);
      assert.match(box, /\*\*Fan-out:\*\* lanes/);
      const cands = inRoot(root, 'C.splitCandidates({})');
      assert.equal(cands.length, 1); assert.equal(cands[0].item, 'ben-parser'); assert.equal(cands[0].lead, 'kwa'); assert.equal(cands[0].fanout, 'lanes');
      // a hand edit of the pieces since the split: no longer a candidate
      fs.writeFileSync(path.join(root, 'company/work/handoffs/to-ben.md'), box.replace('src/lex.js', 'src/lexer.js'));
      assert.equal(inRoot(root, 'C.splitCandidates({})').length, 0, 'a Pieces list edited by hand is not delegated');
    } else {
      assert.equal(split[0].shadow, true);
      assert.ok(!/\*\*Pieces:\*\*/.test(box), 'recording only: the item is not split');
      assert.match(box, /recorded only: splitting is in recording-only mode, so the item stays with Ben/);
      assert.match(read(root, 'company/work/dispatch-log.md'), /WOULD DELEGATE ben-parser \(eng\): 3 pieces by lanes/);
      assert.equal(inRoot(root, 'C.splitCandidates({})').length, 0);
    }
    // SPLIT neither passes nor fails in the ranking
    const K = MR.knobs(POLICY); assert.deepEqual(MR.verdictsIn('**Verdict:** SPLIT by Kwame — check: x', K, CREW), []);
  }
});

test('the lead\'s own split of its item; a member cannot split; too few pieces are refused', () => {
  const root = fixture();
  const argv = (by, list) => ['split', 'kwa-big', '--fanout', 'dispatch', '--by', by].concat(...list.map(p => ['--piece', p]));
  assert.match(consult(root, argv('Ben', PIECES)).out.error, /only a department lead splits/);
  assert.match(consult(root, argv('Kwame', PIECES.slice(0, 2))).out.error, /split refused: 2 pieces/);
  const r = consult(root, argv('Kwame', PIECES));
  assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r.out.live, true); assert.equal(r.out.fanout, 'dispatch');
  assert.match(read(root, 'company/work/handoffs/to-kwame.md'), /\*\*Fan-out:\*\* dispatch/);
  const c = inRoot(root, 'C.splitCandidates({})');
  assert.equal(c.length, 1); assert.equal(c[0].fanout, 'dispatch'); assert.equal(c[0].file, 'to-kwame.md');
});

test('departments.js delegation: the owner\'s switch, workers only from the lead\'s team, check codes, the auto withdraw and the owner-only resume', () => {
  const root = fixture({ delegation: null });
  assert.match(depts(root, ['delegation', 'eng', 'live', '--by', 'Boss']).out.error, /only the owner switches/);
  const on = depts(root, ['delegation', 'eng', 'shadow', '--by', 'owner'], { owner: true });
  assert.equal(on.code, 0, JSON.stringify(on)); assert.equal(on.out.delegation.mode, 'shadow'); assert.equal(on.out.delegation.effective, 'shadow');
  // workers: Dan reports to Ben who reports to Kwame (in the subtree); Zed reports to the CEO (not)
  const bad = depts(root, ['delegation', 'eng', 'workers', 'ben,zed', '--by', 'owner'], { owner: true });
  assert.equal(bad.code, 2); assert.equal(bad.out.problem, 'DELEGATE_OUTSIDE_SUBTREE'); assert.match(bad.out.error, /Zed \(zed\) does not report to Kwame/);
  const ok = depts(root, ['delegation', 'eng', 'workers', 'ben,dan', '--by', 'owner'], { owner: true });
  assert.equal(ok.code, 0, JSON.stringify(ok)); assert.deepEqual(ok.out.delegation.workers, ['ben', 'dan']);
  assert.equal(depts(root, ['check', '--json']).code, 0, 'consistent');
  // a hand-edited worker outside the subtree, and splitting with no lead, are check mismatches
  const doc = JSON.parse(read(root, 'company/departments.json')); doc.departments[0].delegation.workers.push('zed'); w(root, 'company/departments.json', doc);
  const ch = depts(root, ['check', '--json']); assert.equal(ch.code, 1); assert.ok(ch.out.mismatches.some(m => m.code === 'DELEGATE_OUTSIDE_SUBTREE' && m.seat === 'zed'));
  doc.departments[0].delegation.workers = ['ben']; doc.departments[0].delegation.maxWorkers = 99; w(root, 'company/departments.json', doc);
  assert.ok(depts(root, ['check', '--json']).out.mismatches.some(m => m.code === 'BAD_DELEGATION'));
  doc.departments[0].delegation.maxWorkers = 2; doc.departments[0].lead = null; w(root, 'company/departments.json', doc);
  assert.ok(depts(root, ['check', '--json']).out.mismatches.some(m => m.code === 'DELEGATE_NO_LEAD'));
  doc.departments[0].lead = 'kwa'; doc.departments[0].delegation.mode = 'live'; w(root, 'company/departments.json', doc);
  // the dispatcher withdraws only with --auto and never from an agent's run; only the owner resumes
  assert.match(depts(root, ['delegation', 'eng', 'withdraw', '--by', 'dispatcher', '--why', 'x']).out.error, /only with --auto/);
  assert.match(depts(root, ['delegation', 'eng', 'withdraw', '--by', 'dispatcher', '--auto', '--why', 'x'], { station: true }).out.error, /never an agent's run/);
  const wd = depts(root, ['delegation', 'eng', 'withdraw', '--by', 'dispatcher', '--auto', '--why', 'not cheaper', '--hash', 'sha256:abc']);
  assert.equal(wd.code, 0, JSON.stringify(wd)); assert.equal(wd.out.delegation.effective, 'shadow', 'a withdrawn department records only');
  assert.equal(wd.out.delegation.withdrawn.by, 'auto'); assert.equal(wd.out.delegation.withdrawn.evaluationHash, 'sha256:abc');
  assert.match(depts(root, ['delegation', 'eng', 'resume', '--by', 'dispatcher']).out.error, /only the owner resumes/);
  assert.match(depts(root, ['delegation', 'eng', 'resume', '--by', 'Boss']).out.error, /only the owner resumes/);
  const rs = depts(root, ['delegation', 'eng', 'resume', '--by', 'owner'], { owner: true });
  assert.equal(rs.code, 0); assert.equal(rs.out.delegation.effective, 'live');
  assert.match(read(root, 'company/work/decisions.md'), /splitting big jobs/);
});

test('set-route: the one writer of routes; the class rules first, for the owner too; the weekly suggestion never from an agent\'s run', () => {
  const root = fixture();
  const mm = depts(root, ['set-route', 'eng', 'code', 'custom/MiniMax-M3.1-Pro', '--by', 'owner'], { owner: true });
  assert.equal(mm.code, 2); assert.equal(mm.out.problem, 'CLASS_RULE'); assert.match(mm.out.error, /never written on the MiniMax plan/);
  const ok = depts(root, ['set-route', 'eng', 'code', 'claude-cli/claude-sonnet-5-5@high', '--by', 'owner'], { owner: true });
  assert.equal(ok.code, 0, JSON.stringify(ok)); assert.deepEqual(JSON.parse(read(root, 'company/departments.json')).departments[0].routes.code, { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' });
  assert.equal(depts(root, ['set-route', 'eng', 'research', 'custom/MiniMax-M3.1-Pro', '--by', 'owner'], { owner: true }).code, 0, 'research may run on the MiniMax plan');
  const agent = depts(root, ['set-route', 'eng', 'code', 'claude-cli/claude-opus-5-5', '--by', 'routing-proposal', '--proposal', 'rp-000000000000'], { station: true });
  assert.equal(agent.code, 2); assert.match(agent.out.error, /never an agent's run/);
  const early = depts(root, ['set-route', 'eng', 'code', 'claude-cli/claude-opus-5-5', '--by', 'routing-proposal', '--proposal', 'rp-000000000000']);
  assert.equal(early.code, 2); assert.match(early.out.error, /not ready to apply: no offered suggestion/);
  assert.match(depts(root, ['set-route', 'eng', 'code', 'claude-cli/claude-opus-5-5', '--by', 'Ben']).out.error, /only the owner or the CEO/);
});

/* ---------------- the delegation allowlist (pure) ---------------- */
const jobs = [{ name: 'Ben loop', agentId: 'ben', provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { name: 'Cat loop', agentId: 'cat', provider: 'claude-cli', model: 'claude-sonnet-5-5' },
  { name: 'Dan loop', agentId: 'dan', provider: 'custom', model: 'MiniMax-M3.1-Pro' }, { name: 'Zed loop', agentId: 'zed', provider: 'claude-cli', model: 'claude-sonnet-5-5' }];
const openAll = { ben: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }], cat: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'custom', model: 'MiniMax-M3.1-Pro' }], dan: [{ provider: 'custom', model: 'MiniMax-M3.1-Pro' }], zed: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }] };
const cand = o => Object.assign({ split: 'sp-1', dept: 'eng', lead: 'kwa', item: 'kwa-big', file: 'to-kwame.md', class: 'code', fanout: 'dispatch', pieces: [] }, o || {});
function compute(o) {
  o = o || {};
  const doc = deptsDoc(Object.assign({ mode: 'live', workers: ['ben', 'cat', 'zed'], maxWorkers: 3, workerTimeoutMin: 20 }, o.delegation || {}));
  return DA.compute({ candidates: o.candidates || [cand()], doc, st: D.settings(doc, {}), crew: CREW, jobs, busy: o.busy || [], open: o.open || openAll, money: o.money || (() => null), now: 1 });
}
test('delegate-allow compute: the subtree, busy seats, a pacer hold, the class rules, one item per lead', () => {
  const r = compute();
  assert.deepEqual(r.doc.leads.kwa.workers, ['ben', 'cat'], 'Zed (outside Kwame\'s reports) is never listed');
  assert.equal(r.doc.leads.kwa.maxWorkers, 2); assert.equal(r.doc.leads.kwa.workerTimeoutMin, 20); assert.deepEqual(r.doc.leads.kwa.items, ['kwa-big']);
  assert.deepEqual(r.doc.leads.kwa.models.cat, [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }], 'a code item lists no MiniMax-plan pair, even one open for the worker');
  assert.deepEqual(compute({ busy: ['ben'] }).doc.leads.kwa.workers, ['cat'], 'a busy worker is not listed');
  const held = compute({ open: Object.assign({}, openAll, { cat: [{ provider: 'custom', model: 'MiniMax-M3.1-Pro' }] }) });
  assert.equal(held.doc.leads.kwa, undefined, 'a pacer hold on one listed worker\'s provider lists no workers for that lead');
  assert.ok(held.notes.some(n => /held now/.test(n.why)));
  assert.equal(compute({ money: (a, p) => a === 'ben' ? 'the daily metered cap is reached' : null }).doc.leads.kwa, undefined, 'the money check holds for every listed worker');
  // Dan works on the MiniMax plan: never listed for a code item, listed for research
  const d1 = compute({ delegation: { workers: ['dan', 'ben'] } });
  assert.deepEqual(d1.doc.leads.kwa.workers, ['ben']);
  assert.deepEqual(compute({ delegation: { workers: ['dan', 'ben'] }, candidates: [cand({ class: 'research' })] }).doc.leads.kwa.workers, ['dan', 'ben']);
  assert.equal(compute({ candidates: [cand({ fanout: 'lanes' })] }).doc.leads.kwa, undefined, 'a lanes split is not a team.dispatch grant');
  const two = compute({ candidates: [cand(), cand({ item: 'kwa-other' })] });
  assert.deepEqual(two.doc.leads.kwa.items, ['kwa-big'], 'one item at a time per lead');
  assert.equal(compute({ delegation: { mode: 'shadow' } }).doc.leads.kwa, undefined, 'recording only: nobody listed');
});

test('delegate-allow: code files make a code item, a worker\'s own pair is listed first and only allowed pairs, the whole run is capped at the pieces, a used split is not listed again', () => {
  const doc = deptsDoc({ mode: 'live', workers: ['ben', 'cat', 'dan'], maxWorkers: 3, workerTimeoutMin: 20 });
  const run = o => DA.compute(Object.assign({ candidates: [cand()], doc, st: D.settings(doc, {}), crew: CREW, jobs, busy: [], open: openAll, money: () => null, now: 1 }, o));
  // a split that reads as "general" but whose pieces list .ts / .js files is code work: Dan (MiniMax plan) is never listed
  const tsPieces = [{ n: 1, title: 'a', files: ['src/a.ts'], check: 'x' }, { n: 2, title: 'b', files: ['docs/b.md'], check: 'x' }, { n: 3, title: 'c', files: ['lib/c.js'], check: 'x' }];
  const g = run({ candidates: [cand({ class: 'general', pieces: tsPieces })] });
  assert.deepEqual(g.doc.leads.kwa.workers, ['ben', 'cat'], JSON.stringify(g));
  assert.equal(g.doc.leads.kwa.class, 'code');
  for (const w of g.doc.leads.kwa.workers) assert.ok(g.doc.leads.kwa.models[w].length && g.doc.leads.kwa.models[w].every(m => m.provider !== 'custom'), 'every listed model is allowed for code: ' + w);
  assert.equal(DA.classOf({ class: 'general', pieces: [{ files: ['docs/a.md'] }] }), 'general');
  // a piece is code unless every file is plainly not code (2026-11-19 re-review: .html, .css, .json, .yml, a Dockerfile,
  // an .astro page or a bare folder slipped past a list of code extensions and could be listed for MiniMax workers)
  for (const f of ['site/index.html', 'web/app.css', 'config/app.json', '.github/workflows/ci.yml', 'Dockerfile', 'src/pages/a.astro', 'src/app/', 'src', 'docs/page.mdx'])
    assert.equal(DA.classOf({ class: 'ops', pieces: [{ files: ['docs/a.md'] }, { files: [f] }] }), 'code', f);
  for (const f of ['docs/a.md', 'notes/b.txt', 'report.pdf', 'brief.docx', 'data/table.csv'])
    assert.equal(DA.classOf({ class: 'research', pieces: [{ files: [f] }] }), 'research', f);
  assert.equal(DA.classOf({ class: 'general', pieces: [{ files: [] }] }, { defaultClass: 'code' }), 'code', 'no files in a code department');
  const html = run({ candidates: [cand({ class: 'ops', pieces: tsPieces.map(p => Object.assign({}, p, { files: ['site/' + p.n + '.html'] })) })] });
  assert.equal(html.doc.leads.kwa.class, 'code');
  for (const w of html.doc.leads.kwa.workers) assert.ok(html.doc.leads.kwa.models[w].every(m => m.provider !== 'custom'), 'no MiniMax for html pieces: ' + w);
  // more pieces than delegation.maxPieces: not listed; at the limit: the whole run is capped at it
  const big = n => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: 'p' + i, files: ['src/p' + i + '.ts'], check: 'x' }));
  const over = run({ candidates: [cand({ pieces: big(7) })] });
  assert.ok(!over.doc.leads.kwa, JSON.stringify(over.doc)); assert.ok(over.notes.some(n => /7 pieces, more than the 6/.test(n.why)), JSON.stringify(over.notes));
  assert.equal(run({ candidates: [cand({ pieces: big(6) })] }).doc.leads.kwa.runWorkers, 6);
  // the whole run: at most the piece count, and never more per call than pieces
  assert.equal(g.doc.leads.kwa.runWorkers, 3); assert.ok(g.doc.leads.kwa.maxWorkers <= 3);
  // research: the worker's own pair first (what it runs on when the lead names none)
  const r = run({ candidates: [cand({ class: 'research', pieces: tsPieces.map(p => Object.assign({}, p, { files: ['notes/' + p.n + '.md'] })) })], open: Object.assign({}, openAll, { dan: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'custom', model: 'MiniMax-M3.1-Pro' }] }) });
  assert.deepEqual(r.doc.leads.kwa.models.dan[0], { provider: 'custom', model: 'MiniMax-M3.1-Pro' }, 'Dan\'s own pair first');
  // a split already dispatched is not listed again
  const u = run({ candidates: [cand({ pieces: tsPieces })], used: new Set(['sp-1']) });
  assert.equal(u.doc.leads.kwa, undefined); assert.ok(u.notes.some(n => /dispatched already/.test(n.why)));
});

test('delegate-allow: a worker on a live child run is busy; a split whose workers started is marked used; a halt empties the list', () => {
  const root = fixture();
  assert.ok(DA.busySeats(root, CREW, [], new Map([['cat', ['run-1']]])).has('cat'), 'a live child run makes the seat busy');
  // the previous list named Kwame -> Ben, Cat for sp-9; Cat now runs a child run: sp-9 is used
  w(root, 'company/state/delegate-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', leads: { kwa: { items: ['kwa-big'], workers: ['ben', 'cat'], maxWorkers: 2, workerTimeoutMin: 20, split: 'sp-9' } } });
  const used = inRoot(root, '[...DA.markUsed(process.cwd(), { liveKids: new Map([["cat", ["r1"]]]) })]');
  assert.deepEqual(used, ['sp-9']);
  // a run row with the item's id and the lead as delegatedBy marks it too (the child already finished)
  w(root, 'company/state/delegate-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', leads: { kwa: { items: ['kwa-other'], workers: ['ben'], maxWorkers: 1, workerTimeoutMin: 20, split: 'sp-10' } } });
  w(root, '.starnet-data/workspaces/runs.jsonl', JSON.stringify({ runId: 'c1', agentId: 'ben', delegatedBy: 'kwa', itemId: 'kwa-other', parentRunId: 'l1' }) + '\n');
  assert.deepEqual(inRoot(root, '[...DA.markUsed(process.cwd(), {})].sort()'), ['sp-10', 'sp-9']);
  // halted: nobody listed, at once
  const e = inRoot(root, 'DA.writeEmpty({}) && JSON.parse(require("fs").readFileSync("company/state/delegate-allow.json", "utf8"))');
  assert.deepEqual(e.leads, {}); assert.equal(e.halted, true);
  const src = fs.readFileSync(path.join(TOOLS, 'dispatch.js'), 'utf8');
  assert.match(src, /if \(halted\) \{ if \(!DRY\) \{ try \{ require\('\.\/lib\/delegate-allow\.js'\)\.writeEmpty\(/, 'the dispatcher empties the list before its halted return');
  assert.match(src, /delegate-allow\.js'\)\.step\(\{ jobs, log, liveKids: LIVE_KIDS/, 'the dispatcher passes the live child runs');
  // the station's half (company/patches/0018): a listed worker runs only on a listed model; the run is capped over all calls
  const patch = fs.readFileSync(path.join(REPO, 'company', 'patches', '0018-team-dispatch-limits.diff'), 'utf8');
  for (const t of ['has no model on the delegation list for this item', 'wov = Object.assign({ provider: listed[0].provider, model: listed[0].model }', 'the most its delegation list allows', 'runWorkers: rw >= 1', 'no override allowlist: the listed model cannot run']) assert.ok(patch.includes(t), 'patch 0018 carries: ' + t);
});

test('delegate-allow build/write: a recorded dispatch split, the override list it reads, and fail-closed without money numbers', async () => {
  const root = fixture();
  const argv = ['split', 'kwa-big', '--fanout', 'dispatch', '--by', 'Kwame'].concat(...PIECES.map(p => ['--piece', p]));
  assert.equal(consult(root, argv).code, 0);
  w(root, 'company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: openAll });
  const budget = { capOn: true, capped: false, dailyUsd: 5, perAgentUsd: 0, byAgent: {}, spent: 0, lastHourMetered: 0, hoursLeft: 10, spread: false, unmetered: ['claude-cli'] };
  const r = inRoot(root, 'DA.write({ jobs: ' + JSON.stringify(jobs) + ', budget: ' + JSON.stringify(budget) + ' }).then(x => ({ x, doc: JSON.parse(require("fs").readFileSync("company/state/delegate-allow.json", "utf8")) }))');
  assert.equal(r.x.ok, true); assert.deepEqual(r.doc.leads.kwa.workers, ['ben', 'cat']); assert.equal(r.doc.leads.kwa.items[0], 'kwa-big'); assert.equal(r.doc.v, 1);
  const none = inRoot(root, 'DA.write({ jobs: ' + JSON.stringify(jobs) + ' }).then(() => JSON.parse(require("fs").readFileSync("company/state/delegate-allow.json", "utf8")))');
  assert.deepEqual(none.leads, {}, 'without the dispatcher\'s money numbers nobody is listed');
  w(root, 'company/state/override-allow.json', { v: 1, at: Date.now() - 40 * 60e3, by: 'dispatcher', agents: openAll });
  const stale = inRoot(root, 'DA.write({ jobs: ' + JSON.stringify(jobs) + ', budget: ' + JSON.stringify(budget) + ' }).then(() => JSON.parse(require("fs").readFileSync("company/state/delegate-allow.json", "utf8")))');
  assert.deepEqual(stale.leads, {}, 'a stale override list opens nobody\'s provider');
});

/* ---------------- fanoutEvaluation ---------------- */
function fanItems(o) {
  const items = [];
  const add = (k, n, cost, fails, cls) => { for (let i = 0; i < n; i++) items.push({ id: k + '-' + i, seat: i % 2 ? 'ben' : 'kwa', excluded: false, settled: true, closedAt: 1, delegated: k === 'del', oneShot: i < fails ? 0 : 1, cell: { class: cls || 'code' }, cost: { listUsd: cost, usd: 0, windowTokens: 0 } }); };
  add('del', o.del.n, o.del.cost, o.del.fails || 0, o.del.cls); add('one', o.one.n, o.one.cost, o.one.fails || 0, o.one.cls);
  return items;
}
const fanEval = o => MR.fanoutEvaluation({ policy: POLICY, now: 1, departments: o.departments || deptsDoc({ mode: 'live', workers: ['ben'] }) }, { items: fanItems(o) }, MR.knobs(POLICY), { minItems: 10 }, it => !it.excluded && it.settled);
test('fanoutEvaluation: withdraw when splitting is not cheaper per accepted item over 10 items, keep when it is, not enough data below; deterministic', () => {
  const w1 = fanEval({ del: { n: 10, cost: 2 }, one: { n: 10, cost: 2 } });
  assert.equal(w1.departments[0].verdict, 'withdraw', JSON.stringify(w1)); assert.equal(w1.departments[0].ratio, 1);
  assert.equal(JSON.stringify(w1), JSON.stringify(fanEval({ del: { n: 10, cost: 2 }, one: { n: 10, cost: 2 } })), 'deterministic');
  assert.match(w1.departments[0].hash, /^sha256:[0-9a-f]{64}$/);
  // the same cost but more rework (fewer accepted): splitting costs more per accepted item
  assert.equal(fanEval({ del: { n: 10, cost: 1.5, fails: 5 }, one: { n: 10, cost: 2 } }).departments[0].verdict, 'withdraw');
  const k = fanEval({ del: { n: 12, cost: 1 }, one: { n: 10, cost: 2 } }).departments[0];
  assert.equal(k.verdict, 'keep'); assert.equal(k.ratio, 0.5);
  assert.equal(fanEval({ del: { n: 9, cost: 5 }, one: { n: 10, cost: 2 } }).departments[0].verdict, 'not enough data');
  assert.equal(fanEval({ del: { n: 10, cost: 5, cls: 'review' }, one: { n: 10, cost: 2, cls: 'code' } }).departments[0].verdict, 'not enough data', 'compared within the same class only');
  assert.equal(fanEval({ del: { n: 10, cost: 2 }, one: { n: 10, cost: 2 }, departments: deptsDoc(null) }), null, 'no department with splitting on: no report');
});

test('the dispatcher withdraws splitting once per evaluation hash and tells the owner in one plain line', () => {
  const root = fixture();
  const ev = { fanout: { departments: [{ dept: 'eng', verdict: 'withdraw', reasons: ['splitting cost 120% of doing the same kind of item in one go'], hash: 'sha256:' + 'a'.repeat(64) }] } };
  w(root, 'company/work/models/routing-evaluation.json', ev);
  const r1 = inRoot(root, 'DA.withdrawStep({})');
  assert.deepEqual(r1.withdrawn, ['eng']);
  const g = JSON.parse(read(root, 'company/departments.json')).departments[0].delegation;
  assert.equal(g.withdrawn.by, 'auto'); assert.equal(g.withdrawn.evaluationHash, ev.fanout.departments[0].hash);
  // the owner resumes; the same evaluation does not withdraw it again
  assert.equal(depts(root, ['delegation', 'eng', 'resume', '--by', 'owner'], { owner: true }).code, 0);
  assert.deepEqual(inRoot(root, 'DA.withdrawStep({})').withdrawn, [], 'once per hash');
  const line = read(root, 'company/owner/digest.jsonl') || '';
  assert.match(line, /The crew stopped splitting Engineering's bigger jobs between several people: doing them in one go was cheaper\./);
  const OS = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  assert.deepEqual(OS.wordsProblems(DA.withdrawnWords('Engineering')), [], 'plain words');
});

test('the family books: a delegated child\'s spend is the lead\'s, and the totals match runs.jsonl exactly, per item too', () => {
  const runs = [
    { runId: 'L1', agentId: 'kwa', usd: 0.4 }, { runId: 'c1', agentId: 'ben', parentRunId: 'L1', delegatedBy: 'kwa', itemId: 'kwa-big', usd: 0.25 },
    { runId: 'c2', agentId: 'cat', parentRunId: 'L1', delegatedBy: 'kwa', itemId: 'kwa-big', usd: 0.35 }, { runId: 'g1', agentId: 'dan', parentRunId: 'c1', usd: 0.05 },
    { runId: 'B1', agentId: 'ben', usd: 0.1 }, { runId: 'c3', agentId: 'cat', parentRunId: 'L-running', delegatedBy: 'kwa', itemId: 'kwa-big', usd: 0.2 },
  ];
  const books = FAM.books(runs, { usdOf: r => r.usd });
  const sum = runs.reduce((t, r) => t + Math.round(r.usd * 1e9), 0) / 1e9;
  assert.equal(books.total, sum, 'the books total runs.jsonl exactly');
  assert.equal(Object.values(books.bySeat).reduce((t, x) => t + Math.round(x * 1e9), 0) / 1e9, sum);
  const fam = books.byFamily.kwa;
  assert.equal(Math.round(fam.total * 1e9), Math.round((0.4 + 0.25 + 0.35 + 0.05 + 0.2) * 1e9), 'children and the grandchild are Kwame\'s');
  assert.equal(Math.round(books.byFamily.ben.total * 1e9), Math.round(0.1 * 1e9), 'Ben\'s own run stays Ben\'s');
  // per item: the delegated rows named kwa-big add up to the family's delegated spend of that item
  const perItem = runs.filter(r => r.itemId === 'kwa-big').reduce((t, r) => t + Math.round(r.usd * 1e9), 0);
  assert.equal(perItem, Math.round((0.25 + 0.35 + 0.2) * 1e9));
});

/* ---------------- piece lanes through the real dispatcher ---------------- */
const DISPATCH = path.join(TOOLS, 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const TOKEN = 'fanout-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
let mock = null, port = 0;
async function startMock() {
  if (mock) return;
  const log = path.join(__LIFE.tmpDir('fanout-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.ok(![8800, 8810, 8900, 8910].includes(port));
  mock.logFile = log;
}
test.after(() => { try { if (mock) mock.kill(); } catch (_) {} });
async function st(method, p, body) { const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('piece lanes: each piece its own run on a listed worker, at most maxWorkers at once, on its own time limit, Sprint off; results land in the item', async () => {
  await startMock();
  await st('POST', '/__caps', { caps: [] });   // no patch 0012: piece lanes run on other agents, they do not need it
  await st('POST', '/__hold', { names: ['Lane '] });
  const T = fs.realpathSync(fixture()); const tag = path.basename(T);
  const SEATS = { boss: 'Boss loop', kwa: 'Kwame loop', ben: 'Ben loop', cat: 'Cat loop', dan: 'Dan loop', hal: 'Hal loop', zed: 'Zed loop' };
  const agents = JSON.parse(JSON.stringify(CREW));
  w(T, 'company/company.json', { name: 'Fanout Test ' + tag, owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'fanout-test' } });
  w(T, 'secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8')); cad.tempo.sprint = { on: false };
  w(T, 'company/work/ops/cadence.json', cad);
  w(T, 'company/work/finance/dispatch-budget.json', { dailyUsd: 5, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w(T, 'company/owner/inbound.jsonl', ''); w(T, '.starnet-data/workspaces/runs.jsonl', '');
  const ids = {};
  for (const [id, loop] of Object.entries(SEATS)) {
    const name = loop + ' ' + tag;
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + CREW[id].inbox + ', then work.', provider: 'claude-cli', model: 'claude-haiku-5', schedule: 'every 2h', workdir: T, unattendedGrants: ['workbench'] });
    ids[id] = r.job.id; agents[id].loop = name;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { lastRunAt: new Date(Date.now() - 50 * 60e3).toISOString(), inFlight: false } });
  }
  w(T, 'company/tools/loops.json', { agents });
  const argv = ['split', 'kwa-big', '--by', 'Kwame'].concat(...PIECES.map(p => ['--piece', p]));
  const sp = consult(T, argv); assert.equal(sp.code, 0, JSON.stringify(sp));
  const env = () => Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' });
  const tick = () => { const n = reqs().length; const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env: env() }); const mine = reqs().slice(n);
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), mine, laneCreates: mine.filter(r => r.path === '/api/cron' && r.method === 'POST' && /^Lane /.test((r.body || {}).name || '')), log: read(T, 'company/work/dispatch-log.md') || '' }; };
  const r = tick();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.laneCreates.length, 2, 'two pieces start (maxWorkers 2): ' + r.log.slice(-800));
  const agentsOf = r.laneCreates.map(x => x.body.agentId).sort();
  assert.deepEqual(agentsOf, ['ben', 'cat'], 'on the listed workers\' own agents');
  const lanes = JSON.parse(read(T, 'company/state/lanes.json')).lanes;
  assert.deepEqual(lanes.map(l => l.piece).sort(), [1, 2]); assert.ok(lanes.every(l => l.timeoutMin === 20 && l.inbox === 'to-kwame.md' && l.lead === 'kwa'), JSON.stringify(lanes));
  const job = (await st('GET', '/api/cron')).jobs.find(j => j.name === r.laneCreates[0].body.name);
  assert.match(job.prompt, /YOUR PIECE \d of this item: the (parser|lexer)\. Kwame split the item/);
  assert.match(job.prompt, /ACCEPTANCE CHECK: npm test -- (parse|lex)/);
  const box = read(T, 'company/work/handoffs/to-kwame.md');
  assert.match(box, /\*\*Piece 1 lane:\*\* (Ben|Cat), lane 1, run run-\d+/); assert.match(box, /\*\*Piece 2 lane:\*\*/);
  const wakes = jsonl(T, 'company/state/wakes.jsonl').filter(x => x.door === 'lane');
  assert.equal(wakes.length, 2); assert.ok(wakes.every(x => x.split && x.split.item === 'kwa-big' && x.split.lead === 'kwa' && x.items[0].file === 'to-kwame.md'), JSON.stringify(wakes));
  assert.match(r.log, /PIECE LANE START (ben|cat)\/1 \((Ben|Cat), piece \d of "2026-11-20 from Boss — the big refactor", split by Kwame/);
  // the dispatcher wrote the delegation list (fail closed here: no pacer measurement, so nothing is open)
  assert.deepEqual(JSON.parse(read(T, 'company/state/delegate-allow.json')).leads, {});
  // piece 1's worker finishes; next tick: its result is in the item, the item stays OPEN, piece 3 starts on that worker
  const l1 = lanes.find(l => l.piece === 1);
  fs.writeFileSync(path.join(l1.dir, 'LANE-RESULT.md'), 'Status: DONE — parser rewritten\nEdited src/parse.js.\n');
  await st('POST', '/__finish', { id: l1.jobId, status: 'ok' });
  await st('POST', '/api/cron/update', { id: ids.kwa, patch: { lastRunAt: new Date(Date.now() - 50 * 60e3).toISOString(), inFlight: false } });
  const r2 = tick();
  assert.equal(r2.code, 0, r2.out);
  const box2 = read(T, 'company/work/handoffs/to-kwame.md');
  assert.match(box2, /\*\*Piece 1 result \(lane 1, (Ben|Cat), run run-\d+, [^)]+\):\*\* DONE — parser rewritten/);
  assert.ok(!/\*\*Piece 1 lane:\*\*/.test(box2), 'its lane line is gone');
  assert.match(box2, /the big refactor\n\*\*Id:\*\* kwa-big\n\*\*Need:\*\* do it\n\*\*Status:\*\* OPEN/, 'a piece never closes the item');
  assert.equal(r2.laneCreates.length, 1, 'piece 3 starts: ' + r2.log.slice(-600));
  assert.equal(r2.laneCreates[0].body.agentId, l1.seat, 'on the worker that came free');
  const after = JSON.parse(read(T, 'company/state/lanes.json'));
  assert.deepEqual(after.lanes.map(l => l.piece).sort(), [2, 3]); assert.equal(after.history[0].piece, 1);
});
