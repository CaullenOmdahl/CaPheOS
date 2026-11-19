#!/usr/bin/env node
/* profile-inject.test.js — how a profile reaches a run (docs/PROFILES.md "Injection"):
 *   - block(p) is byte-identical for an unchanged profile across days and timezones (no clock); owner notes, the version,
 *     the trial and the model block never change it
 *   - dossier.js: with inject profile the identity carries the block (and the voice preset); with the policy absent
 *     (inject charter) the identity is exactly today's
 *   - the chat's context note ends with the reminder; nothing is added with inject charter
 *   - the family note: an opposed pair on the same kind of model is a note, a code pair is exempt, never a failure
 *   - model-rank.js profileEvaluation: per seat and version, a counterpart's no rate and overturned noes, a trial against
 *     the seats that did not change, and the fixed caveat line
 *   node --test company/tools/tests/profile-inject.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const P = require(path.join(TOOLS, 'lib', 'profile.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const CREW = { boss: { name: 'Alex', title: 'CEO', functions: ['ceo', 'people'], manager: null, inbox: 'to-alex.md' }, ben: { name: 'Benny', title: 'Idea Scout', manager: 'boss', inbox: 'to-benny.md', role: 'company/roles/benny.md' }, ro: { name: 'Rohan', title: 'Data Scientist', manager: 'boss', inbox: 'to-rohan.md' } };
function benny() {
  const p = P.blank('ben', { name: 'Benny Tran', title: 'Idea Scout' });
  Object.assign(p.identity, { archetype: 'scout', background: 'Ran a trading Discord for three years.', stake: 'His cards are his name.' });
  p.convictions = ['The edge was in a forum before it was in a paper.']; p.voice = { preset: 'upbeat', words: 'Fast and plain.', toOwner: 'Short and cheerful.', avoid: ['synergy'] };
  p.counterpart = { seat: 'ro', signOff: ['promote'], why: 'Rohan tests or kills every card.' };
  p.examples = [{ with: 'ro', they: 'One lucky week.', you: 'Cheap to check.', pushback: true }, { with: 'owner', they: 'Any news?', you: 'Two cards.' }, { with: 'ro', they: 'Killed.', you: 'Next one.' }];
  p.experiences = [{ at: '2026-11-18', text: 'The forum tip cost two days.', source: 'd-1', addedBy: 'Marisol', version: 2 }];
  p.reminder = 'You are Benny, the scout. Reply only as Benny.'; p.hash = P.hashOf(p); return p;
}
function fixture(policy) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-inject-')); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  if (policy) w('company/people/profile-policy.json', policy);
  w('company/people/profiles/ben.json', benny());
  w('company/roles/benny.md', '# Benny\n\n## Scope\n- cards\n\n## Personality\nRestless.\n\n## Backstory and motivation\nA charter backstory.\n\n## Voice\nCharter voice.\n\n## Persona preset\ndry\n');
  w('company/model-policy.json', { allowed: { 'claude-cli': { tiers: { 'claude-sonnet-5-5': 'standard' } } }, seats: { ben: { chain: [{ provider: 'deepseek', model: 'deepseek-flash' }] }, ro: { chain: [{ provider: 'deepseek', model: 'deepseek-pro' }] } } });
  return { T, w };
}
const inRoot = (T, js, env) => { const p = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify((() => { ' + js + ' })()))'], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }, env || {}) }); if (p.status) throw new Error(p.stderr); return JSON.parse(p.stdout); };
const LIB = JSON.stringify(path.join(TOOLS, 'lib', 'profile.js'));

test('block: byte-identical across days and timezones; owner notes, version, trial and model never change it', () => {
  const c = fixture({ inject: 'profile' });
  const a = inRoot(c.T, 'Date.now = () => Date.parse("2026-11-20T08:00:00Z"); const P = require(' + LIB + '); return P.block(P.load("ben"), { crew: require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + ').crew() });', { TZ: 'UTC' });
  const b = inRoot(c.T, 'Date.now = () => Date.parse("2027-03-01T23:00:00Z"); const P = require(' + LIB + '); return P.block(P.load("ben"), { crew: require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + ').crew() });', { TZ: 'Asia/Tokyo' });
  assert.equal(a, b);
  const p = benny(), crew = CREW, base = P.block(p, { crew });
  for (const [k, v] of [['ownerNotes', 'private: thinking of moving him'], ['version', 41], ['trial', { from: 40, until: '2027-01-01T00:00:00Z' }], ['model', { provider: 'custom', model: 'x' }]]) assert.equal(P.block(Object.assign({}, p, { [k]: v }), { crew }), base, k);
  assert.ok(!/private|2026-11-18|version/i.test(base.replace(/its profile does|your profile does/g, '')), 'no owner notes, dates or versions in the block');
  for (const s of ['Benny Tran, Idea Scout', 'crew\'s scout', 'Thoroughness: Checks the parts that matter', 'The edge was in a forum', 'Who checks your work: Rohan', '**Needs sign-off:** <promote>', 'The forum tip cost two days.', 'You never say: "synergy"', 'Rohan: "One lucky week."\n  You (pushing back): "Cheap to check."', 'Code is written only on Claude']) assert.ok(base.includes(s), s);
  // order: identity, temperament, convictions, counterpart, flaws..., examples, boundaries
  const at = s => base.indexOf(s);
  assert.ok(at('You are Benny') < at('Your temperament') && at('Your temperament') < at('What you believe') && at('What you believe') < at('Who checks your work') && at('Who checks your work') < at('How you answer') && at('How you answer') < at('Fixed rules'));
  const ro = P.block(Object.assign(P.blank('ro', { name: 'Rohan' }), { hash: '' }), { crew, profiles: { ben: p } });
  assert.match(ro, /Whose work you check: Benny\. Before Benny can move an idea or card to a test or a build, you have to agree/);
});

test('dossier.js: inject profile puts the block in the identity and the voice preset; absent policy (charter) is today\'s identity', () => {
  const D = JSON.stringify(path.join(TOOLS, 'dossier.js'));
  const prof = fixture({ inject: 'profile' }), plain = fixture(null);
  const run = T => inRoot(T, 'const D = require(' + D + '); const co = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + '); return D.build("ben", co.crew().ben, null);');
  const a = run(prof.T), b = run(plain.T);
  assert.ok(a.identity.includes('YOUR PROFILE') && a.identity.includes('The edge was in a forum'), a.identity.slice(0, 400));
  assert.ok(!a.identity.includes('A charter backstory'), 'the charter\'s person sections are replaced by the block');
  assert.ok(/How you work: you own/.test(a.identity), 'the charter-derived scope lines stay');
  assert.equal(a.personaId, 'upbeat'); assert.equal(a.customVoice, 'Fast and plain.');
  assert.ok(!b.identity.includes('YOUR PROFILE') && b.identity.includes('Who you are: A charter backstory.'));
  assert.equal(b.personaId, 'dry'); assert.equal(b.customVoice, 'Charter voice.');
  // problems(): a valid profile adds nothing; an invalid one is reported for the people function
  const probs = T => inRoot(T, 'const D = require(' + D + '); return D.problems("ben", { docs: { identity: "x", purpose: "x", context: "x", manual: "## House rules" } }, { composer: { identity: () => "" } });');
  assert.ok(!probs(prof.T).some(x => /^profile:/.test(x)));
  const bad = benny(); bad.boundaries = []; bad.hash = '';
  prof.w('company/people/profiles/ben.json', bad);
  assert.ok(probs(prof.T).some(x => /^profile: a fixed rule is missing/.test(x)));
});

test('chat: the context note ends with the reminder under inject profile; nothing with the policy absent', () => {
  const note = T => inRoot(T, 'const co = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + '); return require(' + JSON.stringify(path.join(REPO, 'console', 'chat.js')) + ').contextNote("ben", co.crew().ben, co, "hi", null);');
  assert.match(note(fixture({ inject: 'profile' }).T), /\nYou are Benny, the scout\. Reply only as Benny\.\]\n\n$/);
  assert.ok(!/Reply only as Benny/.test(note(fixture(null).T)));
  assert.ok(!/Reply only as Benny/.test(note(fixture({ inject: 'profile', reminder: false }).T)), 'reminder off');
});

test('family note: an opposed pair on the same kind of model is a note; a code pair is exempt; a lower-tier checker is a note', () => {
  const c = fixture({ inject: 'profile' });
  const D = JSON.stringify(path.join(TOOLS, 'dossier.js'));
  const notes = () => inRoot(c.T, 'const co = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'company.js')) + '); return require(' + D + ').profileNotes(co.crew());');
  assert.match(notes().map(n => n.note).join(), /Rohan checks Benny and both run on the same kind of model \(deepseek\)/);
  c.w('company/departments.json', { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['ben', 'ro'], defaultClass: 'code' }] });
  assert.equal(notes().filter(n => /same kind/.test(n.note)).length, 0, 'code stays on Claude: a code pair is exempt');
  fs.rmSync(path.join(c.T, 'company/departments.json'));
  c.w('company/model-policy.json', { allowed: { 'claude-cli': { tiers: { 'claude-opus-5-5': 'heavy', 'claude-haiku-4-5': 'light' } } }, seats: { ben: { chain: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }] }, ro: { chain: [{ provider: 'claude-cli', model: 'claude-haiku-4-5' }] } } });
  assert.match(notes().map(n => n.note).join(), /Rohan checks Benny on a lower tier \(light under heavy\)/);
  // the owner's words for the same pair: plain
  const pc = P.pairCheck({ seat: 'ben', name: 'Benny', provider: 'deepseek', model: 'a' }, { seat: 'ro', name: 'Rohan', provider: 'deepseek', model: 'b' });
  assert.equal(pc.text, 'Rohan checks Benny and both run on the same kind of AI. A different kind tends to argue back better. The crew can change this.');
  assert.deepEqual(require(path.join(TOOLS, 'lib', 'owner-scope.js')).wordsProblems(pc.text), []);
});

test('model-rank profileEvaluation: per version, sign-off noes overturned, a trial against the unchanged seats, the caveat', () => {
  const MR = require(path.join(TOOLS, 'model-rank.js'));
  const D = 86400e3, t0 = Date.parse('2026-11-01T00:00:00Z');
  const it = (seat, at, one, wake) => ({ id: seat + at, seat, closedAt: t0 + at * D, oneShot: one, extraRuns: one ? 0 : 1, reviseRounds: 0, wakes: [wake], excluded: false, settled: true });
  const items = [], wakes = [];
  for (let d = 0; d < 10; d++) { items.push(it('ben', d, d % 2, 'w' + d)); wakes.push({ wakeId: 'w' + d, seat: 'ben', at: t0 + d * D, profile: { version: d < 5 ? 1 : 2, hash: 'h' } }); items.push(it('ro', d, 1, 'x' + d)); }
  const an = { items, wakeById: new Map(wakes.map(w => [w.wakeId, w])) };
  const inp = { now: t0 + 10 * D, wakes, corrections: [{ event: 'added', agentId: 'ben', at: '2026-11-02 10:00' }],
    signoffs: [{ op: 'ask', id: 's1', counterpart: 'ro' }, { op: 'answer', id: 's1', by: 'ro', verdict: 'no' }, { op: 'override', id: 's1', by: 'boss' }, { op: 'ask', id: 's2', counterpart: 'ro' }, { op: 'answer', id: 's2', by: 'ro', verdict: 'yes' }],
    meetingStats: [{ seats: { ro: { share: 1 } }, pairs: [{ seats: ['ben', 'ro'], overlap: 0.1 }] }],
    profileHistory: { ben: [{ at: new Date(t0 + 5 * D).toISOString(), version: 2, op: 'trial-start', trial: { from: 1 } }] } };
  const K = { confidence: 0.8 };
  const a = MR.profileEvaluation(inp, an, K, { minItems: 3 }, () => true), b = MR.profileEvaluation(inp, an, K, { minItems: 3 }, () => true);
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.caveat, 'Before-and-after numbers also move on their own; compare with the seats that did not change.');
  const ben = a.seats.find(s => s.seat === 'ben');
  assert.deepEqual(ben.versions.map(v => [v.version, v.items]), [[1, 5], [2, 5]]); assert.equal(ben.versions[0].corrections, 1);
  const ro = a.seats.find(s => s.seat === 'ro');
  assert.deepEqual(ro.signoff, { answered: 2, noRate: 0.5, noes: 1, overturned: 1 }); assert.equal(ro.meetings.stanceShare, 1);
  const t = a.trials[0];
  assert.equal(t.seat, 'ben'); assert.equal(t.state, 'running'); assert.equal(t.before.items, 5); assert.equal(t.during.items, 5);
  assert.equal(t.baseline.before.items, 5, 'Rohan did not change: he is the baseline'); assert.equal(t.baseline.oneShotPoints, 0);
  assert.equal(MR.profileEvaluation({ now: t0, wakes: [], profileHistory: {} }, { items: [], wakeById: new Map() }, K, { minItems: 3 }, () => true), null, 'no profiles: no section');
  assert.ok(MR.evalKnobs(JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/ranking-policy.json'), 'utf8'))).profile, 'on in the framework default');
});
