#!/usr/bin/env node
/* consult.test.js — advisor leads (lib/consult.js, consult.js, departments.js advisor/brief/digest/note, premerge-check.js's
 * advisory row; docs/DEPARTMENTS.md §5), on a fixture company:
 *   boss  the CEO          hal  the people function
 *   kwa   Kwame, the lead of Engineering (eng)      ben, cat  Engineering members (their manager is Kwame)
 * The acceptance bars of the middle-management plan's P4 that need no dispatcher: the stuck triggers (one trigger, one
 * consult), the batch, the packet size and dedupe, the daily cap, the lead-only answer, the verdict line in the item's
 * block read by model-rank.js at half weight, the advise prompt's stable prefix, the pre-merge row that never changes the
 * gate's exit code, and the owner-only switch with a pause only the owner resumes.
 *   node --test company/tools/tests/consult.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const C = require(path.join(TOOLS, 'lib', 'consult.js'));
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
};
const SINCE = '2026-11-01T00:00:00.000Z';
const deptsDoc = advisor => ({ version: 1, leadModelDefault: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' },
  departments: [{ id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben', 'cat'], defaultClass: 'code', routes: {}, consult: { maxPerDay: 12, stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2 },
    advisor: advisor === undefined ? { mode: 'live', since: SINCE, by: 'owner', paused: null } : advisor }] });
const item = (id, head) => '\n## 2026-11-20 from Boss — ' + head + '\n**Id:** ' + id + '\n**Need:** do it\n**Status:** OPEN\n';

function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-test-')); roots.push(root);
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/departments.json', 'company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/work/departments/advise-prompt.md', 'company/defaults/work/models/ranking-policy.json'])
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  w(root, 'company/state/governance.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  if (o.depts !== false) w(root, 'company/departments.json', o.depts || deptsDoc(o.advisor));
  for (const f of ['BRIEF.md', 'INBOX-DIGEST.md']) w(root, 'company/work/departments/eng/' + f, '# x\n');
  w(root, 'company/work/departments/eng/DECISIONS.md', '# Engineering — decisions\n\nNewest first.\n\n');
  w(root, 'company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w(root, 'company/work/handoffs/to-ben.md', '# Handoffs\n' + item('ben-parser', 'fix the parser') + item('ben-lexer', 'fix the lexer'));
  w(root, 'company/work/handoffs/to-cat.md', '# Handoffs\n' + item('cat-docs', 'write the docs'));
  for (const s of ['to-kwame.md', 'to-boss.md', 'to-hal.md']) w(root, 'company/work/handoffs/' + s, '# Handoffs\n');
  return root;
}
// a tool's run(argv) in a child process with CAPHEOS_ROOT at the fixture (lib/company.js reads the root once)
function tool(root, file, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'const r = require(' + JSON.stringify(path.join(TOOLS, file)) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const consult = (root, argv, o) => tool(root, 'consult.js', argv, o);
const depts = (root, argv, o) => tool(root, 'departments.js', argv, o);
function inRoot(root, js) {
  const r = spawnSync(process.execPath, ['-e', 'const C = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'consult.js')) + '); Promise.resolve(' + js + ').then(x => process.stdout.write(JSON.stringify(x === undefined ? null : x)));'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC' }) });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

test('ask: a member asks its lead; the packet lands in the lead\'s inbox, the ledger records it, the item waits for the lead', () => {
  const root = fixture();
  const r = consult(root, ['ask', '--item', 'ben-parser', '--question', 'Should the parser keep the old grammar?', '--kind', 'plan', '--check', 'npm test passes', '--by', 'Ben']);
  assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r.out.delivered, true);
  const box = read(root, 'company/work/handoffs/to-kwame.md');
  const p = C.parsePacket(box.slice(box.indexOf('## Consult:')));
  assert.equal(p.id, r.out.id); assert.equal(p.item, 'ben-parser'); assert.equal(p.from, 'Ben'); assert.equal(p.kind, 'plan'); assert.equal(p.status, 'OPEN'); assert.equal(p.check, 'npm test passes');
  const rows = jsonl(root, 'company/state/consults.jsonl');
  assert.equal(rows.length, 1); assert.equal(rows[0].op, 'open'); assert.equal(rows[0].lead, 'kwa'); assert.equal(rows[0].file, 'to-ben.md');
  const held = inRoot(root, '(() => { const h = C.holdFn({}); return [h("to-ben.md", { heading: "2026-11-20 from Boss — fix the parser", id: "ben-parser" }), h("to-ben.md", { heading: "2026-11-20 from Boss — fix the lexer", id: "ben-lexer" }), h("to-kwame.md", { heading: "Consult: fix the parser (2026-11-20)", id: "' + r.out.id + '" })]; })()');
  assert.deepEqual(held[0], { who: 'Kwame' }, 'the asking item waits for Kwame');
  assert.equal(held[1], null, 'another item of the same seat is still work');
  assert.equal(held[2].packet, true, 'the packet is the advise run\'s work, not the lead\'s loop');
  // plan without a check is refused; the lead cannot consult itself; a seat in no department has nobody to ask
  assert.equal(consult(root, ['ask', '--item', 'ben-lexer', '--question', 'q', '--kind', 'plan', '--by', 'Ben']).code, 2);
  assert.match(consult(root, ['ask', '--item', 'ben-lexer', '--question', 'q', '--by', 'Kwame']).out.error, /does not consult itself/);
  assert.match(consult(root, ['ask', '--item', 'ben-lexer', '--question', 'q', '--by', 'Hal']).out.error, /in no department/);
});

test('packets: over 4000 characters refused by ask; a duplicate open consult is dropped: duplicate; the dispatcher\'s own packet is clipped', () => {
  const root = fixture();
  const long = consult(root, ['ask', '--item', 'ben-parser', '--question', 'x'.repeat(4100), '--by', 'Ben']);
  assert.equal(long.code, 2); assert.match(long.out.error, /characters; the limit is 4000/);
  assert.equal(read(root, 'company/work/handoffs/to-kwame.md'), '# Handoffs\n', 'nothing delivered');
  assert.equal(consult(root, ['ask', '--item', 'ben-parser', '--question', 'first', '--by', 'Ben']).code, 0);
  const dup = consult(root, ['ask', '--item', 'ben-parser', '--question', 'again', '--by', 'Ben']);
  assert.equal(dup.code, 3); assert.equal(dup.out.dropped, 'duplicate');
  const rows = jsonl(root, 'company/state/consults.jsonl');
  assert.deepEqual(rows.map(r => r.op + ':' + (r.why || '')), ['dropped:too long', 'open:', 'dropped:duplicate']);
  // the dispatcher's packet: What was tried is clipped to fit, never refused
  const r = inRoot(root, 'C.writePacket({ dept: "eng", item: "cat-docs", file: "to-cat.md", title: "write the docs", from: "dispatcher on behalf of Cat", fromSeat: "cat", kind: "stuck", trigger: "failed-runs:2", question: "stuck?", tried: "- run ".repeat(2000) }, { clip: true })');
  assert.equal(r.ok, true); assert.ok(r.chars <= 4000, String(r.chars)); assert.match(r.text, /\(clipped\)/);
});

test('maxPerDay: enforced per department per company day; the drop is recorded and the item\'s manager gets one line', () => {
  const doc = deptsDoc(); doc.departments[0].consult.maxPerDay = 1;
  const root = fixture({ depts: doc });
  assert.equal(consult(root, ['ask', '--item', 'ben-parser', '--question', 'one', '--by', 'Ben']).code, 0);
  const r = consult(root, ['ask', '--item', 'cat-docs', '--question', 'two', '--by', 'Cat']);
  assert.equal(r.code, 3); assert.equal(r.out.dropped, 'daily cap');
  assert.ok(jsonl(root, 'company/state/consults.jsonl').some(x => x.op === 'dropped' && x.why === 'daily cap' && x.item === 'cat-docs'));
  const mgr = read(root, 'company/work/handoffs/to-kwame.md');
  assert.match(mgr, /FYI: Cat's question to the lead was not sent today/); assert.match(mgr, /reached its 1 consults for the day/);
  const st = inRoot(root, 'C.status({})').departments[0];
  assert.equal(st.today, 1); assert.equal(st.maxPerDay, 1); assert.equal(st.dropped, 1);
});

test('answer: only the lead (exit 2 otherwise); the verdict line goes into the consult and the item\'s block, and closes the consult', () => {
  const root = fixture();
  const id = consult(root, ['ask', '--item', 'ben-parser', '--question', 'ok?', '--by', 'Ben']).out.id;
  const no = consult(root, ['answer', id, '--verdict', 'APPROVE', '--check', 'npm test', '--by', 'Cat']);
  assert.equal(no.code, 2); assert.match(no.out.error, /only the lead of Engineering/);
  assert.equal(consult(root, ['answer', id, '--verdict', 'MAYBE', '--check', 'x', '--by', 'Kwame']).code, 2);
  assert.equal(consult(root, ['answer', id, '--verdict', 'REVISE', '--by', 'Kwame']).code, 2, 'a verdict needs its check');
  const ok = consult(root, ['answer', id, '--verdict', 'REVISE', '--check', 'npm test fails on case 3', '--finding', 'keep the old grammar behind a flag', '--finding', 'add a test for case 3', '--by', 'Kwame']);
  assert.equal(ok.code, 0, JSON.stringify(ok));
  const line = '**Verdict:** REVISE by Kwame — check: npm test fails on case 3 — 1. keep the old grammar behind a flag 2. add a test for case 3';
  assert.equal(ok.out.line, line);
  const ben = read(root, 'company/work/handoffs/to-ben.md');
  const parser = ben.split(/^(?=## )/m).find(s => s.includes('fix the parser'));
  assert.ok(parser.includes(line), parser);
  assert.ok(!ben.split(/^(?=## )/m).find(s => s.includes('fix the lexer')).includes('Verdict'), 'only the consulted item');
  const box = read(root, 'company/work/handoffs/to-kwame.md');
  assert.ok(box.includes(line) && /\*\*Status:\*\* DONE — REVISE/.test(box), box);
  assert.equal(consult(root, ['answer', id, '--verdict', 'APPROVE', '--check', 'x', '--by', 'Kwame']).code, 2, 'answered once');
  assert.equal(inRoot(root, 'C.holdFn({})("to-ben.md", { heading: "2026-11-20 from Boss — fix the parser", id: "ben-parser" })'), null, 'answered: the item is work again');
});

test('model-rank reads the lead\'s verdict once, at half weight, and the advise run is not authorship', () => {
  const MR = require(path.join(TOOLS, 'model-rank.js'));
  const policy = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/ranking-policy.json'), 'utf8'));
  const now = Date.parse('2026-11-30T12:00:00Z'), t0 = Date.parse('2026-11-20T09:00:00Z');
  const line = '**Verdict:** REVISE by Kwame — check: npm test — 1. a test for case 3';
  const benBlock = '# Handoffs\n\n## 2026-11-20 from Boss — fix the parser\n**Id:** ben-parser\n**Need:** x\n' + line + '\n**Status:** DONE\n**Resolved 2026-11-21 by Ben**\n';
  const kwaBlock = '# Handoffs\n\n## Consult: fix the parser (2026-11-20)\n**Id:** cs-1\n**Item:** ben-parser\n**From:** Ben\n**Kind:** ask\n' + line + '\n**Status:** DONE — REVISE (2026-11-20)\n';
  const inp = { policy, now, crew: CREW, departments: deptsDoc(), consults: [], ledger: [], corrections: [], evidence: [], attributed: [],
    files: [{ file: 'to-ben.md', text: benBlock }, { file: 'to-kwame.md', text: kwaBlock }],
    wakes: [{ at: t0, wakeId: 'w1', seat: 'ben', runId: 'r1', door: 'dispatch', items: [{ file: 'to-ben.md', id: 'ben-parser' }] }, { at: t0 + 3600e3, wakeId: 'w2', seat: 'kwa', runId: 'r2', door: 'consult', items: [{ file: 'to-ben.md', id: 'ben-parser' }] }],
    runs: [{ runId: 'r1', agentId: 'ben', startedAt: t0, endedAt: t0 + 60e3, reason: 'done', provider: 'claude-cli', model: 'claude-sonnet-5-5', tokens: 1000, usd: 0.02 }, { runId: 'r2', agentId: 'kwa', startedAt: t0 + 3600e3, endedAt: t0 + 3700e3, reason: 'done', provider: 'claude-cli', model: 'claude-opus-5-5', tokens: 500, cachedTokens: 450, usd: 0.01 }] };
  const an = MR.analyze(inp);
  const it = an.items.find(x => x.id === 'ben-parser');
  assert.ok(it, JSON.stringify(an.body.totals));
  assert.deepEqual(it.verdicts, [{ by: 'kwa', fail: true, w: 0.5, word: 'REVISE' }], 'one verdict (written in two blocks), by the lead, half weight');
  assert.equal(it.oneShot, 0.5);
  assert.equal(an.body.totals.selfGradesIgnored, 0, 'the advise run does not make the lead an author');
  assert.ok(it.cost.listUsd > 0 && it.otherRuns === 1, 'the advise run is in the item\'s cost');
});

test('stuck triggers: one trigger opens one consult; revise:2, idle-wakes:2 and reopened; progress and the lead\'s answer reset', () => {
  const now = Date.parse('2026-11-20T10:00:00Z'), M = 60e3;
  const settings = { eng: { stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2, stuckOnReopen: true } };
  const base = { id: 'i1', file: 'to-ben.md', seat: 'ben', dept: 'eng', title: 't', sig: 's', revise: 0, reopens: 0 };
  let acc = { wakes: [], runs: [] }, n = 0;
  const run = reason => { n++; acc.wakes.push({ at: now + n * M, seat: 'ben', runId: 'r' + n, door: 'dispatch', items: [{ id: 'i1' }] }); acc.runs.push({ runId: 'r' + n, agentId: 'ben', endedAt: now + n * M + 1, reason }); };
  const scan = (it, st, extra) => C.stuckScan(Object.assign({ items: [Object.assign({}, base, it)], state: st, now: now + (n + 1) * M, settings }, acc, extra || {}));
  let r = scan({}, {}); let st = r.state;
  run('max_iters'); run('max_iters'); r = scan({}, st); st = r.state;
  assert.deepEqual(r.triggers.map(t => t.trigger), ['failed-runs:2']);
  run('max_iters'); r = scan({}, st); st = r.state; assert.equal(r.triggers.length, 0, 'a third failed run opens none');
  run('cancelled'); acc.runs[acc.runs.length - 1].dispatchDelivery = { reason: 'timeout' }; r = scan({}, st); st = r.state;
  assert.equal(st.items.i1.failedRuns, 3, 'a dispatch time-limit cancel is not a failed run');
  r = scan({ sig: 's2' }, st); st = r.state; assert.equal(st.items.i1.failedRuns, 0, 'progress resets the counter');
  run('max_iters'); run('budget'); r = scan({ sig: 's2' }, st); st = r.state;
  assert.deepEqual(r.triggers.map(t => t.trigger), ['failed-runs:2'], 'then two more failed runs open one more');
  // idle wakes: runs that finished and changed nothing
  acc = { wakes: [], runs: [] }; n = 0;
  r = scan({}, {}); st = r.state; run('done'); run('done'); r = scan({}, st); st = r.state;
  assert.deepEqual(r.triggers.map(t => t.trigger), ['idle-wakes:2']);
  run('done'); r = scan({}, st); assert.equal(r.triggers.length, 0);
  r = scan({}, st, { answered: ['i1'] }); st = r.state; assert.equal(st.items.i1.idleWakes, 0, 'the lead\'s answer resets');
  // revise: two fail verdicts since the baseline
  acc = { wakes: [], runs: [] }; n = 0;
  r = scan({ revise: 1 }, {}); st = r.state;
  r = scan({ revise: 2 }, st); st = r.state; assert.equal(r.triggers.length, 0);
  r = scan({ revise: 3 }, st); st = r.state; assert.deepEqual(r.triggers.map(t => t.trigger), ['revise:2']);
  r = scan({ revise: 4 }, st); assert.equal(r.triggers.length, 0, 'fired once');
  // reopened: seen even though reopening changed the block
  r = scan({}, {}); st = r.state;
  r = scan({ reopens: 1, sig: 'reopened' }, st); st = r.state; assert.deepEqual(r.triggers.map(t => t.trigger), ['reopened']);
  r = scan({ reopens: 1, sig: 'reopened' }, st); assert.equal(r.triggers.length, 0);
  const off = C.stuckScan({ items: [Object.assign({}, base, { reopens: 1, sig: 'x' })], state: st, now, settings: { eng: { stuckOnReopen: false } } });
  assert.equal(off.triggers.length, 0, 'stuckOnReopen false: no reopen trigger');
});

test('batch: 3 consults inside 10 minutes start one advise run; one consult waits for maxWaitMin; nothing inside minGapMin', () => {
  const now = Date.parse('2026-11-20T10:00:00Z'), M = 60e3, batch = { minGapMin: 5, maxWaitMin: 10, startAt: 3 };
  assert.equal(C.batchDue({ pending: [{ at: now - 9 * M }, { at: now - 4 * M }, { at: now }], batch, now }).start, true);
  assert.equal(C.batchDue({ pending: [{ at: now - 9 * M }], batch, now }).start, false);
  assert.equal(C.batchDue({ pending: [{ at: now - 10 * M }], batch, now }).start, true);
  const tick1 = C.batchDue({ pending: [{ at: now }, { at: now }, { at: now }], lastAdvise: now - 1 * M, batch, now });
  const tick2 = C.batchDue({ pending: [{ at: now }, { at: now }, { at: now }], lastAdvise: now - 1 * M, batch, now: now + 3 * M });
  assert.equal(tick1.start, false); assert.equal(tick2.start, false);
  assert.equal(C.batchDue({ pending: [{ at: now }], inFlight: 'busy', batch, now: now + 60 * M }).start, false, 'never while the lead is busy');
});

test('the advise prompt: a pointer to the brief, never its text; the same bytes up to the consult line across wakes', () => {
  const root = fixture();
  w(root, 'company/work/departments/eng/BRIEF.md', '# Engineering\n\nSECRET-PLAN-TEXT\n');
  const t = fs.readFileSync(path.join(REPO, 'company/defaults/work/departments/advise-prompt.md'), 'utf8');
  const a = C.advisePrompt({ template: t, lead: 'Kwame', deptId: 'eng', deptName: 'Engineering', ids: ['cs-1'] });
  const b = C.advisePrompt({ template: t, lead: 'Kwame', deptId: 'eng', deptName: 'Engineering', ids: ['cs-2', 'cs-3', 'cs-4'] });
  const n = a.indexOf(C.CONSULT_LINE);
  assert.ok(n > 1500, 'a long stable prefix: ' + n);
  assert.equal(a.slice(0, n), b.slice(0, n), 'byte-identical prefix');
  assert.notEqual(a, b);
  assert.match(a, /company\/work\/departments\/eng\/BRIEF\.md/); assert.doesNotMatch(a, /SECRET-PLAN-TEXT/);
  assert.ok(a.trimEnd().endsWith('Open consults for you: cs-1 (in your inbox).'));
  // the routine's blocks after its own text (house rules) are kept when the line changes
  const withRules = a.trimEnd() + '\n\n[HOUSE RULES]\nrule\n';
  assert.equal(C.withOwnText(withRules, b), b.trimEnd() + '\n\n[HOUSE RULES]\nrule\n');
});

test('shadow: a consult is recorded and not delivered; the item is not held', () => {
  const root = fixture({ advisor: { mode: 'shadow' } });
  const r = consult(root, ['ask', '--item', 'ben-parser', '--question', 'q', '--by', 'Ben']);
  assert.equal(r.code, 0); assert.equal(r.out.delivered, false);
  assert.equal(read(root, 'company/work/handoffs/to-kwame.md'), '# Handoffs\n');
  assert.equal(jsonl(root, 'company/state/consults.jsonl')[0].shadow, true);
  assert.equal(inRoot(root, 'C.holdFn({})("to-ben.md", { heading: "x", id: "ben-parser" })'), null);
  const off = fixture({ advisor: null });
  const r2 = consult(off, ['ask', '--item', 'ben-parser', '--question', 'q', '--by', 'Ben']);
  assert.equal(r2.code, 2); assert.equal(r2.out.dropped, 'mode off');
});

test('departments.js advisor: owner only; a lead first, never the CEO; the dispatcher pauses with --auto, only the owner resumes', () => {
  const root = fixture({ advisor: null });
  assert.equal(depts(root, ['advisor', 'eng', 'live', '--by', 'Kwame']).code, 2, 'a lead cannot switch its own advice on');
  const on = depts(root, ['advisor', 'eng', 'live', '--by', 'owner'], { owner: true });
  assert.equal(on.code, 0, JSON.stringify(on)); assert.equal(on.out.advisor.mode, 'live'); assert.ok(on.out.advisor.since);
  const doc = JSON.parse(read(root, 'company/departments.json'));
  assert.equal(doc.departments[0].advisor.mode, 'live');
  assert.match(read(root, 'company/work/decisions.md'), /the lead's advice for Engineering \(Kwame\): off -> live/);
  assert.equal(depts(root, ['advisor', 'eng', 'pause', '--by', 'dispatcher', '--why', 'x']).code, 2, 'the dispatcher pauses only with --auto');
  const p = depts(root, ['advisor', 'eng', 'pause', '--by', 'dispatcher', '--auto', '--why', 'cost per item rose', '--hash', 'sha256:abc']);
  assert.equal(p.code, 0, JSON.stringify(p)); assert.equal(p.out.advisor.paused.by, 'auto');
  assert.equal(JSON.parse(read(root, 'company/departments.json')).departments[0].advisor.paused.evaluationHash, 'sha256:abc');
  assert.equal(inRoot(root, 'C.status({})').departments[0].effective, 'shadow', 'paused acts as recording only');
  const r1 = depts(root, ['advisor', 'eng', 'resume', '--by', 'dispatcher']);
  assert.equal(r1.code, 2); assert.match(r1.out.error, /only the owner resumes/);
  assert.equal(depts(root, ['advisor', 'eng', 'resume', '--by', 'Kwame']).code, 2);
  const r2 = depts(root, ['advisor', 'eng', 'resume', '--by', 'owner'], { owner: true });
  assert.equal(r2.code, 0); assert.equal(r2.out.advisor.paused, null); assert.notEqual(r2.out.advisor.since, on.out.advisor.since === r2.out.advisor.since ? null : on.out.advisor.since);
  // no lead, or the CEO as lead: refused for the owner too; check reports a hand edit
  const doc2 = deptsDoc(null); doc2.departments[0].lead = null;
  const nl = fixture({ depts: doc2 });
  assert.equal(depts(nl, ['advisor', 'eng', 'live', '--by', 'owner'], { owner: true }).out.problem, 'ADVISOR_NO_LEAD');
  const doc3 = deptsDoc(); doc3.departments[0].lead = 'boss'; doc3.departments[0].members.push('boss');
  const cl = fixture({ depts: doc3 });
  const ck = depts(cl, ['check', '--json']);
  assert.equal(ck.code, 1); assert.ok(ck.out.mismatches.some(m => m.code === 'ADVISOR_CEO_LEAD'), JSON.stringify(ck.out));
  const doc4 = deptsDoc(); doc4.departments[0].lead = null;
  assert.ok(depts(fixture({ depts: doc4 }), ['check', '--json']).out.mismatches.some(m => m.code === 'ADVISOR_NO_LEAD'));
});

test('departments.js brief / digest / note: the lead\'s own files, inside their limits', () => {
  const root = fixture();
  const f = w(root, 'scratch/brief.md', '# Engineering\n\nWe are fixing the parser this week.\n');
  assert.equal(depts(root, ['brief', 'eng', '--file', f, '--by', 'Ben']).code, 2, 'only the lead');
  const ok = depts(root, ['brief', 'eng', '--file', f, '--by', 'Kwame']);
  assert.equal(ok.code, 0, JSON.stringify(ok)); assert.equal(read(root, 'company/work/departments/eng/BRIEF.md'), fs.readFileSync(f, 'utf8'));
  const big = w(root, 'scratch/big.md', 'x'.repeat(8001));
  assert.match(depts(root, ['brief', 'eng', '--file', big, '--by', 'Kwame']).out.error, /the limit is 8000/);
  assert.equal(depts(root, ['digest', 'eng', '--file', f, '--by', 'Kwame']).code, 0);
  assert.equal(depts(root, ['note', 'eng', '--text', 'we keep the old grammar behind a flag', '--by', 'Kwame']).code, 0);
  assert.match(read(root, 'company/work/departments/eng/DECISIONS.md'), /Kwame: we keep the old grammar behind a flag \(departments\.js note\)/);
  const show = depts(root, ['show', 'eng', '--json', '--brief']);
  assert.match(show.out.department.briefText, /fixing the parser/); assert.equal(show.out.department.advisor.mode, 'live');
});

test('premerge-check: the lead\'s advice is one advisory row; a lead REVISE on an otherwise green PR still passes (exit 0)', () => {
  const root = fixture();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-gh-')); roots.push(bin);
  const PR = { number: 7, title: 'docs: explain the parser', body: 'Author: Ben\nRefs #3', state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'ben/docs', author: { login: 'x' },
    reviews: [], comments: [{ createdAt: '2026-11-20T10:00:00Z', author: { login: 'x' }, body: 'Reviewer: Cat — APPROVE\nfine' }], files: [{ path: 'docs/parser.md', additions: 3, deletions: 0 }], mergeable: 'MERGEABLE', headRefOid: 'a1b2c3d4e5f6a7b8', baseRefOid: 'ffff0000eeee1111', changedFiles: 1 };
  w(bin, 'pr.json', PR);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env node\nconst a = process.argv.slice(2), fs = require("fs"), p = require("path");\n' +
    'if (a[0] === "pr" && a[1] === "view") { process.stdout.write(fs.readFileSync(p.join(__dirname, "pr.json"), "utf8")); process.exit(0); }\n' +
    'if (a[0] === "repo") { process.stdout.write("main\\n"); process.exit(0); }\n' +
    'if (a[0] === "api" && /git\\/ref\\/heads/.test(a[1])) { process.stdout.write(JSON.stringify({ object: { sha: "ffff0000eeee1111" } })); process.exit(0); }\n' +
    'if (a[0] === "api" && /compare/.test(a[1])) { process.stdout.write(JSON.stringify({ behind_by: 0, ahead_by: 1, merge_base_commit: { sha: "ffff0000eeee1111" }, files: [{ filename: "docs/parser.md", status: "modified", additions: 3, deletions: 0 }] })); process.exit(0); }\n' +
    'if (a[0] === "api" && /pulls\\/\\d+\\/files/.test(a[1])) { process.stdout.write("docs/parser.md\\n"); process.exit(0); }\n' +
    'process.stderr.write("gh shim: " + a.join(" ")); process.exit(1);\n', { mode: 0o755 });
  const gate = () => spawnSync(process.execPath, [path.join(TOOLS, 'premerge-check.js'), '--pr', '7', '--repo', 'acme/web'], { cwd: root, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', PATH: bin + path.delimiter + process.env.PATH }) });
  const g1 = gate();
  assert.equal(g1.status, 0, g1.stdout + g1.stderr);
  assert.match(g1.stdout, /Lead's advice \(advisory\)\s+\[asked Kwame; no answer yet; asked in cs-/);
  const open = jsonl(root, 'company/state/consults.jsonl').filter(r => r.op === 'open');
  assert.equal(open.length, 1); assert.equal(open[0].kind, 'premerge'); assert.equal(open[0].head, PR.headRefOid);
  assert.equal(gate().status, 0); assert.equal(jsonl(root, 'company/state/consults.jsonl').filter(r => r.op === 'open').length, 1, 'once per PR head');
  assert.equal(consult(root, ['answer', open[0].id, '--verdict', 'REVISE', '--check', 'read the diff', '--finding', 'name the flag', '--by', 'Kwame']).code, 0);
  const g3 = gate();
  assert.equal(g3.status, 0, 'a lead REVISE never changes the gate\'s exit code: ' + g3.stdout);
  assert.match(g3.stdout, /PASS — /); assert.match(g3.stdout, /Lead's advice \(advisory\)\s+\[Kwame said REVISE/);
  const ev = JSON.parse(read(root, 'company/work/evidence/premerge-web-' + PR.headRefOid + '.json'));
  assert.equal(ev.verdict, 'PASS'); assert.deepEqual(ev.lead, { verdict: 'REVISE', by: 'Kwame', consult: open[0].id, check: 'read the diff', advisory: true });
  assert.ok(!ev.checks.some(c => /Lead/.test(c.name)), 'never a check');
  // advice off: no row, no consult, the same exit code
  const off = fixture({ advisor: null });
  const g4 = spawnSync(process.execPath, [path.join(TOOLS, 'premerge-check.js'), '--pr', '7', '--repo', 'acme/web'], { cwd: off, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: off, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', PATH: bin + path.delimiter + process.env.PATH }) });
  assert.equal(g4.status, 0); assert.doesNotMatch(g4.stdout, /Lead's advice/); assert.equal(read(off, 'company/state/consults.jsonl'), null);
});

test('owner words: every line of the department card and the auto-pause line are plain', async () => {
  const scope = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
  const WD = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'crew-departments-words.js'));
  const lines = WD.samples().concat([C.pausedWords('Kwame', 'Engineering')]);
  for (const t of lines) assert.deepEqual(scope.wordsProblems(t), [], t);
  assert.equal(C.pausedWords('Kwame', 'Engineering'), 'The crew paused Kwame\'s advice for Engineering: over the last two weeks it cost more than it saved. You can turn it back on from the Engineering card.');
  assert.equal(WD.onConfirm('Kwame'), 'Kwame will be asked for advice a few times a day. It uses a stronger, more expensive setup, and the crew will check after two weeks whether it pays off.');
  assert.equal(WD.askedLine(4, 12), 'Asked the lead today: 4 of 12 allowed.');
  assert.equal(WD.resumeConfirm(), 'Turn the lead\'s advice back on? The crew will measure it again from today.');
  assert.deepEqual(['off', 'shadow', 'live'].map(m => WD.ADVICE_SAY[m][0]), ['Off', 'Recording only', 'On']);
});
