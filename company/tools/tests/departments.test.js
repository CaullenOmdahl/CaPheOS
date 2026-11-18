#!/usr/bin/env node
/* departments.test.js — departments as data (company/tools/departments.js, lib/departments.js, lib/company.js deptOf /
 * leadOf; docs/DEPARTMENTS.md), on a fixture company with three departments:
 *   eng       lead Ana, members Ana and Ben          (Ben's manager is Ana)
 *   research  NO lead, members Dan and Cat           (leadOf falls back to each member's loops.json manager)
 *   ops       lead Eve, member Eve
 * plus Boss (CEO, in no department) and Hal (the people function, in no department). FLOOR_PLAN.md puts Ben in Research,
 * which the drift check must find. Each case runs the tool in a child process with CAPHEOS_ROOT at a fresh copy of the
 * fixture (lib/company.js reads the root once) and pins "is this the owner's shell" in that process
 * (provenance.pinOwnerShell; there is no environment switch for it).
 *
 *   node --test company/tools/tests/departments.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };

const CREW = {
  boss: { name: 'Boss', title: 'CEO', functions: ['ceo'], manager: null, inbox: 'to-boss.md' },
  hal: { name: 'Hal', title: 'People', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' },
  ana: { name: 'Ana', title: 'Engineering Lead', manager: 'boss', inbox: 'to-ana.md' },
  ben: { name: 'Ben', title: 'Engineer', manager: 'ana', inbox: 'to-ben.md' },
  cat: { name: 'Cat', title: 'Analyst', manager: 'boss', inbox: 'to-cat.md' },
  dan: { name: 'Dan', title: 'Researcher', manager: 'hal', inbox: 'to-dan.md' },
  eve: { name: 'Eve', title: 'Operator', manager: 'boss', inbox: 'to-eve.md' },
};
const DEPTS = {
  _doc: 'fixture', version: 1,
  leadModelDefault: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' },
  departments: [
    { id: 'eng', name: 'Engineering', lead: 'ana', members: ['ana', 'ben'], defaultClass: 'code', brief: 'company/work/departments/eng/BRIEF.md', routes: {}, consult: { maxPerDay: 12, stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2 } },
    { id: 'research', name: 'Research', lead: null, members: ['dan', 'cat'], defaultClass: 'research', brief: 'company/work/departments/research/BRIEF.md', routes: {}, consult: {} },
    { id: 'ops', name: 'Operations', lead: 'eve', members: ['eve'], defaultClass: 'ops', brief: 'company/work/departments/ops/BRIEF.md', routes: {}, consult: {} },
  ],
};
const PLAN = [
  '# Fixture floor plan', '',
  '## 1. Rooms and their departments', '',
  '- **LAB** (x 0..9): **Engineering** — Engineering Lead, Engineer.',
  '- **LIBRARY** (x 10..19): **Research** — Researcher, Analyst.',
  '- **DOCK** (x 20..29): **Operations** — Operator.', '',
  '## 2. Who sits where', '',
  '| Agent | Department | Room | Desk | Prop | Justification |',
  '|---|---|---|---|---|---|',
  '| Ana — Engineering Lead | Engineering | LAB | 1,1 | p1 | lead |',
  '| Ben — Engineer | Research | LIBRARY | 11,1 | p2 | sits with research |',
  '| Dan — Researcher | Research | LIBRARY | 12,1 | p3 | |',
  '| Eve — Operator | Operations | DOCK | 21,1 | p4 | |',
  '| Boss — CEO | — | LAB | 2,1 | p5 | |', '',
  '## 3. What each room is for', '',
].join('\n');

function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'departments-test-')); roots.push(root);
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive', addressAs: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/departments.json', 'company/defaults/state/governance.json', 'company/defaults/state/guardrails.json']) fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(root, f));
  const gov = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8'));
  if (o.org === null) delete gov.categories.org; else gov.categories.org = o.org || 'approve';
  w(root, 'company/state/governance.json', gov);
  if (o.depts !== false) w(root, 'company/departments.json', o.depts || DEPTS);
  if (o.plan !== false) w(root, 'company/FLOOR_PLAN.md', o.plan || PLAN);
  for (const id of ['eng', 'research', 'ops']) if (o.depts !== false) { w(root, 'company/work/departments/' + id + '/BRIEF.md', '# brief\n'); w(root, 'company/work/departments/' + id + '/DECISIONS.md', '# ' + id + ' — decisions\n\nNewest first.\n\n'); }
  w(root, 'company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n\n');
  return root;
}
// run departments.js in a child: argv, with the owner's shell pinned (owner: true|false)
function tool(root, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'const r = require(' + JSON.stringify(path.join(TOOLS, 'departments.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
function inRoot(root, js) {
  const r = spawnSync(process.execPath, ['-e', 'const co = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + '); process.stdout.write(JSON.stringify(' + js + '));'], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }) });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

test('co.deptOf / co.leadOf / co.departmentsOf: the lead, the manager when the department has none, null outside', () => {
  const root = fixture();
  const r = inRoot(root, '{ depts: co.departmentsOf().map(d => d.id), ben: co.leadOf("ben"), dan: co.leadOf("dan"), cat: co.leadOf("cat"), ana: co.leadOf("ana"), hal: co.leadOf("hal"), boss: co.leadOf("boss"), benDept: (co.deptOf("ben") || {}).id, halDept: co.deptOf("hal") }');
  assert.deepEqual(r.depts, ['eng', 'research', 'ops']);
  assert.equal(r.ben, 'ana', 'a member of a led department goes to its lead');
  assert.equal(r.dan, 'hal', 'research has no lead: Dan\'s loops.json manager stands in');
  assert.equal(r.cat, 'boss', 'and Cat\'s manager for Cat');
  assert.equal(r.ana, 'boss', 'a lead does not lead itself: its own manager');
  assert.equal(r.hal, null, 'a seat in no department has no lead');
  assert.equal(r.boss, null);
  assert.equal(r.benDept, 'eng'); assert.equal(r.halDept, null);
  // no file: no departments, every answer null (behaves as before departments existed)
  const bare = fixture({ depts: false });
  assert.deepEqual(inRoot(bare, '[co.departmentsOf(), co.deptOf("ben"), co.leadOf("ben")]'), [[], null, null]);
});

test('a seat already in one department is refused in a second, for the owner too; an unknown seat is refused', () => {
  const root = fixture();
  const before = read(root, 'company/departments.json');
  const two = tool(root, ['add-member', 'research', 'ben', '--by', 'owner'], { owner: true });
  assert.equal(two.code, 2); assert.match(two.out.error, /already in Engineering/);
  const ghost = tool(root, ['add-member', 'eng', 'ghost', '--by', 'owner'], { owner: true });
  assert.equal(ghost.code, 2); assert.match(ghost.out.error, /not a seat on the crew/);
  const lead = tool(root, ['set-lead', 'research', 'ghost', '--by', 'owner'], { owner: true });
  assert.equal(lead.code, 2);
  assert.equal(read(root, 'company/departments.json'), before, 'nothing was written');
});

test('set-lead by the owner: applied, recorded with provenance, in decisions.md and the department\'s DECISIONS.md', () => {
  const root = fixture();
  const r = tool(root, ['set-lead', 'research', 'dan', '--by', 'Olive', '--why', 'Dan runs the research agenda'], { owner: true });
  assert.equal(r.code, 0, JSON.stringify(r.out)); assert.equal(r.out.changed, true);
  const doc = JSON.parse(read(root, 'company/departments.json'));
  assert.equal(doc.departments.find(d => d.id === 'research').lead, 'dan');
  assert.equal(doc._doc, 'fixture', 'the rest of the file is kept');
  const prov = read(root, 'company/state/locked/provenance.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(prov.some(p => p.writer === 'departments.js' && /departments\.json$/.test(p.file)), 'the write is recorded for locked-watch');
  assert.match(read(root, 'company/work/decisions.md'), /Departments: make Dan \(dan\) the lead of Research.*Why: Dan runs the research agenda/);
  const dec = read(root, 'company/work/departments/research/DECISIONS.md');
  assert.match(dec.split('\n').find(l => l.startsWith('- ')), /Olive \(owner\): make Dan/);
  assert.equal(inRoot(root, 'co.leadOf("cat")'), 'dan', 'now Cat goes to Dan');
  // --by owner from a process that is not the owner's shell or the console is refused
  const fake = tool(root, ['set-lead', 'research', 'cat', '--by', 'owner'], { owner: false });
  assert.equal(fake.code, 2); assert.match(fake.out.error, /owner's own interactive shell or the console/);
});

test('set-lead by a seat that is neither the CEO nor the people function is refused; the people function proposes', () => {
  const root = fixture({ org: 'auto' });
  const before = read(root, 'company/departments.json');
  const ben = tool(root, ['set-lead', 'research', 'cat', '--by', 'Ben']);
  assert.equal(ben.code, 2); assert.match(ben.out.error, /may not change departments/);
  const hal = tool(root, ['set-lead', 'research', 'cat', '--by', 'Hal']);
  assert.equal(hal.code, 0); assert.equal(hal.out.proposed, true);
  assert.equal(read(root, 'company/departments.json'), before, 'a proposal changes nothing');
  const again = tool(root, ['set-lead', 'research', 'cat', '--by', 'Hal']);
  assert.equal(again.out.id, hal.out.id, 'the same proposal is not filed twice');
  // the duty hands the open proposal to the CEO
  const duty = tool(root, ['--duty']);
  assert.equal(duty.code, 1);
  assert.ok(duty.out.items.some(i => i.id === 'departments-proposal:' + hal.out.id && i.route === 'ceo'), JSON.stringify(duty.out));
  // Ben may not apply it; the CEO may, at the org level the owner set (auto here)
  assert.equal(tool(root, ['apply', hal.out.id, '--by', 'Ben']).code, 2);
  const ap = tool(root, ['apply', hal.out.id, '--by', 'Boss']);
  assert.equal(ap.code, 0, JSON.stringify(ap.out)); assert.equal(ap.out.changed, true);
  assert.equal(JSON.parse(read(root, 'company/departments.json')).departments.find(d => d.id === 'research').lead, 'cat');
  assert.match(read(root, 'company/work/decisions.md'), /proposal dp-[0-9a-f]{6} by Hal/);
  assert.equal(tool(root, ['proposals', '--json']).out.proposals.length, 0);
});

test('the CEO at org=approve waits for the owner (exit 3, one owner question); at notify it goes ahead and tells the owner', () => {
  const root = fixture({ org: 'approve' });
  const r = tool(root, ['move', 'cat', 'ops', '--by', 'Boss']);
  assert.equal(r.code, 3, JSON.stringify(r.out)); assert.equal(r.out.governance.category, 'org'); assert.ok(r.out.governance.questionId);
  const r2 = tool(root, ['move', 'cat', 'ops', '--by', 'Boss']);
  assert.equal(r2.out.governance.questionId, r.out.governance.questionId, 'asked once');
  assert.equal(JSON.parse(read(root, 'company/departments.json')).departments.find(d => d.id === 'ops').members.includes('cat'), false);
  const n = fixture({ org: 'notify' });
  const m = tool(n, ['move', 'cat', 'ops', '--by', 'Boss']);
  assert.equal(m.code, 0, JSON.stringify(m.out));
  assert.ok(JSON.parse(read(n, 'company/departments.json')).departments.find(d => d.id === 'ops').members.includes('cat'));
  assert.match(read(n, 'company/owner/outbound.jsonl') || '', /move Cat/);
  // a company founded before the org category existed reads the framework default (approve)
  const old = fixture({ org: null });
  assert.equal(tool(old, ['move', 'cat', 'ops', '--by', 'Boss']).code, 3);
});

test('check: FLOOR_PLAN.md puts Ben in Research while departments.json has him in Engineering (reported, never fixed)', () => {
  const root = fixture();
  const plan = read(root, 'company/FLOOR_PLAN.md'), depts = read(root, 'company/departments.json');
  const r = tool(root, ['check', '--json']);
  assert.equal(r.code, 1);
  const ben = r.out.mismatches.find(m => m.code === 'PLAN_SEAT_MISMATCH' && m.seat === 'ben');
  assert.ok(ben, JSON.stringify(r.out.mismatches)); assert.match(ben.msg, /Ben in Research.*ben in Engineering/);
  assert.equal(r.out.mismatches.length, 1, 'nothing else disagrees: ' + JSON.stringify(r.out.mismatches));
  assert.ok(r.out.notes.some(n => n.code === 'UNASSIGNED' && n.seat === 'hal'), 'Hal in no department is a note, not a mismatch');
  assert.ok(!r.out.notes.some(n => n.seat === 'boss'), 'the CEO is not reported as unassigned');
  assert.equal(read(root, 'company/FLOOR_PLAN.md'), plan); assert.equal(read(root, 'company/departments.json'), depts);
  // the duty sees the same, read-only, with ids only
  const d = tool(root, ['--duty']);
  assert.equal(d.code, 1); assert.deepEqual(d.out.items, [{ id: 'departments:PLAN_SEAT_MISMATCH:ben', route: 'people' }]);
  assert.ok(!/Research|Engineering|Ben\b/.test(d.out.reason), 'no file content in the reason: ' + d.out.reason);
  // a department the plan does not know, a loops.json department field that disagrees, an over-long brief
  w(root, 'company/tools/loops.json', { agents: Object.assign({}, CREW, { eve: Object.assign({}, CREW.eve, { department: 'eng' }) }) });
  w(root, 'company/FLOOR_PLAN.md', plan.replace('**Operations**', '**Logistics**').replace('| Operations |', '| Logistics |'));
  w(root, 'company/work/departments/eng/BRIEF.md', 'x'.repeat(8001));
  const codes = tool(root, ['check', '--json']).out.mismatches.map(m => m.code).sort();
  assert.deepEqual(codes, ['BRIEF_TOO_LONG', 'DEPT_NOT_ON_PLAN', 'LOOPS_MISMATCH', 'PLAN_SEAT_MISMATCH', 'PLAN_UNKNOWN_DEPT']);
  // with no departments.json there is nothing to check and the duty is quiet
  const bare = fixture({ depts: false });
  assert.equal(tool(bare, ['check', '--json']).code, 0);
  assert.equal(tool(bare, ['--duty']).code, 0);
});

test('create writes the department and its brief skeleton; move takes the lead along and leaves the old one without a lead', () => {
  const root = fixture();
  const c = tool(root, ['create', 'design', '--name', 'Design', '--class', 'design', '--by', 'owner'], { owner: true });
  assert.equal(c.code, 0, JSON.stringify(c.out));
  const d = JSON.parse(read(root, 'company/departments.json')).departments.find(x => x.id === 'design');
  assert.deepEqual([d.name, d.lead, d.members, d.defaultClass, d.brief], ['Design', null, [], 'design', 'company/work/departments/design/BRIEF.md']);
  assert.equal(d.consult.stuckAfterFailedRuns, 2, 'the consult numbers come from newDepartment in the config');
  const brief = read(root, 'company/work/departments/design/BRIEF.md');
  assert.ok(brief && brief.length < 8000 && /## Purpose/.test(brief) && /8000 characters/.test(brief));
  assert.match(read(root, 'company/work/departments/design/DECISIONS.md'), /Newest first and append-only[\s\S]*\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Olive \(owner\): create the Design department/);
  assert.ok(read(root, 'company/work/departments/design/INBOX-DIGEST.md'));
  assert.equal(tool(root, ['create', 'design', '--name', 'Design 2', '--by', 'owner'], { owner: true }).code, 2, 'an id is used once');
  assert.equal(tool(root, ['create', 'bad', '--name', 'Bad', '--class', 'juggling', '--by', 'owner'], { owner: true }).code, 2, 'an unknown task class is refused');
  const mv = tool(root, ['move', 'ana', 'design', '--by', 'owner'], { owner: true });
  assert.equal(mv.code, 0); assert.match(mv.out.summary, /left without a lead/);
  const doc = JSON.parse(read(root, 'company/departments.json'));
  assert.equal(doc.departments.find(x => x.id === 'eng').lead, null);
  assert.equal(inRoot(root, 'co.leadOf("ben")'), 'ana', 'Ben now goes to his manager, who happens to be Ana');
  const l = tool(root, ['list', '--json']).out;
  assert.deepEqual(l.departments.map(x => x.id), ['eng', 'research', 'ops', 'design']);
  assert.ok(l.unassigned.some(u => u.id === 'hal'));
});

test('the console route runs departments.js as the owner with fixed arguments', async () => {
  const calls = [], routes = [];
  require(path.join(REPO, 'console', 'departments.js')).mount((m, re, fn) => routes.push([m, re, fn]), {
    runApi: async (name, args) => { calls.push([name].concat(args)); return { ok: true }; }, bad: msg => { throw new Error(msg); }, owner: () => 'Olive' });
  const hit = async (m, p, b) => { for (const [mm, re, fn] of routes) { const x = mm === m && re.exec(p); if (x) return fn(x, null, b); } throw new Error('no route ' + p); };
  await hit('GET', '/api/departments');
  await hit('POST', '/api/departments/eng/lead', { seat: 'ben' });
  await hit('POST', '/api/departments/eng/lead', { seat: '' });
  await hit('POST', '/api/departments/move', { seat: 'cat', to: 'ops' });
  await assert.rejects(() => hit('POST', '/api/departments/move', { seat: '--by', to: 'ops' }));
  await assert.rejects(() => hit('POST', '/api/departments/move', { seat: 'cat', to: '--by' }));
  assert.deepEqual(calls, [['departments.js', 'list', '--json'], ['departments.js', 'set-lead', 'eng', 'ben', '--by', 'Olive'], ['departments.js', 'set-lead', 'eng', 'none', '--by', 'Olive'], ['departments.js', 'move', 'cat', 'ops', '--by', 'Olive']]);
});

test('no department defined yet: a FLOOR_PLAN.md that names departments is not drift (the empty list founding ships)', () => {
  const DL = require(path.join(TOOLS, 'lib', 'departments.js'));
  const plan = DL.parsePlan('# Floor\n\n## 1. Rooms\n\n- **North room** (desks 1-4): **Engineering**\n\n## 2. Seats\n\n| Agent | Department |\n|---|---|\n| Alex — lead | Engineering |\n');
  const r = DL.drift({ doc: { departments: [] }, exists: true, crew: { agent: { name: 'Alex' } }, plan, ceo: 'agent' });
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  assert.deepEqual(r.mismatches, []);
  assert.ok(r.notes.some(n => n.code === 'NOT_IN_USE'));
});
