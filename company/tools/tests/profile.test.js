#!/usr/bin/env node
/* profile.test.js — company/tools/profile.js, the only writer of crew profiles (docs/PROFILES.md), on a fixture company:
 *   boss Alex (CEO)   mar Marisol (people)   ben Benny (scout)   ro Rohan (tester)
 * The schema and its fixed boundaries, the 200-character reminder, compare-and-swap edits, no self-edit, temperament only
 * through a trial, undo to the exact body, the hash-chained history (a removed row is reported), trials that revert on
 * their own and trials kept, the people function's proposals and the CEO's governance level, migrate from a charter, the
 * experience duty, and the owner-only policy switch.
 *   node --test company/tools/tests/profile.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const P = require(path.join(TOOLS, 'lib', 'profile.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const CREW = {
  boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md', title: 'CEO' },
  mar: { name: 'Marisol', functions: ['people'], manager: 'boss', inbox: 'to-marisol.md', title: 'People' },
  ben: { name: 'Benny', manager: 'boss', inbox: 'to-benny.md', title: 'Idea Scout', role: 'company/roles/benny.md' },
  ro: { name: 'Rohan', manager: 'boss', inbox: 'to-rohan.md', title: 'Data Scientist', role: 'company/roles/rohan.md' },
};
const CHARTER = ['# Benny — Idea Scout', '', '## Scope', '- idea cards', '', '## Archetype', 'scout', '', '## Personality (the ideal candidate)', 'Restless and quick.', '',
  '## Backstory and motivation', 'Ran a trading Discord.', '', '## Voice', 'Fast and plain.', '', '## Persona preset', 'upbeat', '', '## Convictions', '- The edge was in a forum first.', '',
  '## Counterpart', 'Rohan tests or kills every card.', '', '## Example exchanges', '- With Rohan: "One lucky week." — You: "Cheap to check; I drop it if it fails." (pushes back)', '', '## KPIs', '- five cards a week', ''].join('\n');
function fixture(o) {
  o = o || {};
  const T = __LIFE.tmpDir('profile-test-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json', 'company/defaults/state/governance.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/state/governance.json', o.gov || JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w('company/roles/benny.md', CHARTER);
  w('company/roles/rohan.md', '# Rohan\n\n## Archetype\ntester\n\n## Voice\nDry.\n');
  if (o.policy) w('company/people/profile-policy.json', o.policy);
  for (const s of Object.values(CREW)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n');
  return { T, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return null; } } };
}
// profile.js run(argv) in a child with CAPHEOS_ROOT at the fixture; o.owner: the owner's shell; o.agent: inside that seat's run; o.now: the clock
function tool(T, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(' + (o.agent ? 'true' : 'false') + '); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    (o.agent ? 'prov.callerConflict = () => null;' : '') + 'const t = require(' + JSON.stringify(path.join(TOOLS, 'profile.js')) + ');' + (o.now ? 't._S.now = () => ' + o.now + ';' : '') +
    'const r = ' + (o.fn ? o.fn : 't.run(' + JSON.stringify(argv) + ')') + '; process.stdout.write(JSON.stringify(r));';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', PROFILE_NO_SYNC: '1' });
  if (o.agent) env.STARNET_AGENT_ID = o.agent; else delete env.STARNET_AGENT_ID;
  // run as a script at the tool's own path in the fixture, not node -e: lib/profile.js reads a profile only as profile.js
  // recorded it, and a recorded write counts only from an untainted program that is the tool itself (lib/recorded.js)
  const sf = path.join(T, 'company', 'tools', 'profile.js'); fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, code);
  const p = spawnSync(process.execPath, [sf], { cwd: T, encoding: 'utf8', env });
  if (p.status !== 0) throw new Error('child failed: ' + p.stdout + p.stderr);
  return JSON.parse(p.stdout);
}
const own = { owner: true };
const load = (c, s) => JSON.parse(c.r('company/people/profiles/' + s + '.json'));
const hist = (c, s) => c.r('company/people/profiles/' + s + '.history.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
function migrated(o) { const c = fixture(o); const r = tool(c.T, ['migrate', '--all', '--by', 'owner'], own); assert.equal(r.code, 0, JSON.stringify(r)); return c; }

test('schema: a blank profile validates; a missing fixed rule, a reminder over 200 characters and a bad slider are refused; examples are a note for migrate', () => {
  const p = P.blank('ben', { name: 'Benny' }); p.examples = [{ with: 'owner', they: 'a', you: 'b', pushback: true }, { with: 'owner', they: 'c', you: 'd' }, { with: 'owner', they: 'e', you: 'f' }];
  assert.ok(P.validate(p).ok, JSON.stringify(P.validate(p)));
  for (const k of ['risk', 'pace', 'rigour', 'candour', 'independence']) { const q = JSON.parse(JSON.stringify(p)); q.temperament[k] = 5; assert.ok(!P.validate(q).ok, k); }
  const nb = JSON.parse(JSON.stringify(p)); nb.boundaries = nb.boundaries.filter(b => !/Claude/.test(b)); assert.match(P.validate(nb).problems.join(), /fixed rule is missing/);
  assert.match(P.validate(Object.assign({}, p, { reminder: 'x'.repeat(201) })).problems.join(), /at most 200/);
  const few = Object.assign({}, p, { examples: p.examples.slice(0, 2) });
  assert.ok(!P.validate(few).ok); assert.ok(P.validate(few, { examplesAsNotes: true }).ok); assert.match(P.validate(few, { examplesAsNotes: true }).notes.join(), /at least 3/);
  assert.ok(!P.validate(Object.assign({}, p, { examples: p.examples.map(e => Object.assign({}, e, { pushback: false })) })).ok, 'one must push back');
  const eager = JSON.parse(JSON.stringify(p)); eager.identity.archetype = 'scout'; assert.match(P.validate(eager).problems.join(), /eager seat/);
  assert.ok(P.validate(Object.assign({}, p, { hash: 'abcdefabcdef' })).problems.some(x => /hash/.test(x)), 'a hand-edited body fails its hash');
  assert.ok(fs.existsSync(path.join(REPO, 'company', 'schemas', 'profile.schema.json')));
});

test('migrate: profiles from the charters, version 1, by migrate; the counterpart and examples read back; missing fields listed; a second migrate skips', () => {
  const c = fixture();
  const r = tool(c.T, ['migrate', '--all', '--by', 'Marisol']);
  assert.equal(r.code, 0, JSON.stringify(r));
  const ben = load(c, 'ben');
  assert.equal(ben.version, 1); assert.equal(ben.identity.archetype, 'scout'); assert.equal(ben.counterpart.seat, 'ro'); assert.deepEqual(ben.counterpart.signOff, ['promote']);
  assert.equal(ben.examples.length, 1); assert.equal(ben.examples[0].with, 'ro'); assert.equal(ben.examples[0].pushback, true);
  assert.equal(ben.voice.preset, 'upbeat'); assert.deepEqual(ben.convictions, ['The edge was in a forum first.']);
  assert.ok(r.out.made.find(m => m.seat === 'ben').missing.includes('identity.stake'));
  assert.equal(hist(c, 'ben')[0].by, 'migrate');
  assert.ok(P.reminder(ben).length <= 200);
  assert.equal(tool(c.T, ['migrate', '--all', '--by', 'Marisol']).out.made.length, 0);
  assert.equal(tool(c.T, ['migrate', '--all', '--by', 'Benny']).code, 2, 'only the people function or the owner migrates');
  const ch = tool(c.T, ['check', '--all', '--json']);
  assert.equal(ch.code, 1, 'fewer than 3 examples fails check'); assert.match(JSON.stringify(ch.out.seats), /at least 3/);
});

test('edit: owner only, compare-and-swap on the version; a stale base is exit 4; voice applies now; temperament only through try or --now', () => {
  const c = migrated();
  assert.equal(tool(c.T, ['edit', 'ben', '--set', '/voice/words="Quick and cheerful."', '--base', '1', '--by', 'Marisol']).code, 2, 'the people function proposes; it does not edit');
  const r = tool(c.T, ['edit', 'ben', '--set', '/voice/words="Quick and cheerful."', '--base', '1', '--by', 'owner'], own);
  assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r.out.version, 2); assert.equal(r.out.kind, 'voice');
  assert.equal(load(c, 'ben').voice.words, 'Quick and cheerful.');
  const stale = tool(c.T, ['edit', 'ben', '--set', '/voice/words="x"', '--base', '1', '--by', 'owner'], own);
  assert.equal(stale.code, 4); assert.equal(stale.out.conflict, true);
  const t = tool(c.T, ['edit', 'ben', '--set', '/temperament/risk=1', '--base', '2', '--by', 'owner'], own);
  assert.equal(t.code, 2); assert.match(t.out.error, /use profile\.js try/);
  assert.equal(tool(c.T, ['edit', 'ben', '--set', '/temperament/risk=1', '--base', '2', '--now', '--by', 'owner'], own).code, 0);
  assert.equal(tool(c.T, ['edit', 'ben', '--set', '/model/provider="custom"', '--base', '3', '--by', 'owner'], own).code, 2, 'the model block is not edited here');
  const nb = tool(c.T, ['edit', 'ben', '--set', '/boundaries=[]', '--base', '3', '--by', 'owner'], own);
  assert.equal(nb.code, 2); assert.match(nb.out.error, /fixed rule/);
  assert.match(c.r('company/work/decisions.md'), /Profile of Benny: the owner changed \/voice\/words/);
});

test('no self-edit: an agent run naming its own seat cannot edit or propose for itself', () => {
  const c = migrated();
  const e = tool(c.T, ['edit', 'ben', '--set', '/voice/words="me"', '--base', '1', '--by', 'Benny'], { agent: 'ben' });
  assert.equal(e.code, 2); assert.match(e.out.error, /no seat edits its own profile/);
  const ownerClaim = tool(c.T, ['edit', 'ben', '--set', '/voice/words="me"', '--base', '1', '--by', 'owner'], { agent: 'ben' });
  assert.equal(ownerClaim.code, 2, 'an agent run cannot claim the owner');
  const p = tool(c.T, ['propose', 'mar', '--kind', 'voice', '--set', '/voice/words="Warm."', '--why', 'mine', '--by', 'Marisol'], { agent: 'mar' });
  assert.equal(p.code, 2); assert.match(p.out.error, /own profile/);
  assert.equal(tool(c.T, ['propose', 'ro', '--kind', 'voice', '--set', '/voice/words="Dry."', '--why', 'x', '--by', 'Benny']).code, 2, 'only the people function proposes');
});

test('undo: the exact earlier body comes back (hash match) as a new version; the history chain verifies and a removed row is reported', () => {
  const c = migrated();
  const h1 = load(c, 'ben').hash;
  tool(c.T, ['edit', 'ben', '--set', '/voice/words="Two."', '--base', '1', '--by', 'owner'], own);
  tool(c.T, ['edit', 'ben', '--set', '/identity/stake="My name is on the cards."', '--base', '2', '--by', 'owner'], own);
  const u = tool(c.T, ['undo', 'ben', '--to', '1', '--by', 'owner'], own);
  assert.equal(u.code, 0, JSON.stringify(u)); assert.equal(u.out.version, 4); assert.equal(u.out.sameAs, true);
  assert.equal(load(c, 'ben').hash, h1, 'the same body as version 1');
  assert.equal(tool(c.T, ['check', '--seat', 'ben', '--json']).out.seats[0].failures.filter(f => /history|row/.test(f)).length, 0);
  const f = path.join(c.T, 'company/people/profiles/ben.history.jsonl');
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); lines.splice(1, 1); fs.writeFileSync(f, lines.join('\n') + '\n');
  const ch = tool(c.T, ['check', '--seat', 'ben', '--json']);
  assert.equal(ch.code, 1); assert.match(ch.out.seats[0].failures.join(), /does not follow the row before it: a row was removed/);
});

test('trial: try applies N+1 with a trial; at the end with no answer tick reverts to N; keep makes it permanent; a wake stamp carries the trial', () => {
  const c = migrated();
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  const r = tool(c.T, ['try', 'ben', '--set', '/temperament/risk=1', '--base', '1', '--days', '3', '--by', 'owner'], Object.assign({ now: t0 }, own));
  assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r.out.trial.from, 1);
  const p2 = load(c, 'ben'); assert.equal(p2.version, 2); assert.equal(p2.temperament.risk, 1); assert.equal(p2.trial.until, '2026-11-23T10:00:00.000Z');
  const stamp = tool(c.T, null, { fn: 'require(' + JSON.stringify(path.join(TOOLS, 'lib', 'profile.js')) + ').wakeStamp("ben")' });
  assert.deepEqual(stamp.trial, { from: 1, until: '2026-11-23T10:00:00.000Z' }); assert.equal(stamp.version, 2);
  assert.deepEqual(tool(c.T, ['tick'], { now: t0 + 2 * 86400e3 }).out.trials, [], 'not yet');
  const t = tool(c.T, ['tick'], { now: t0 + 4 * 86400e3 });
  assert.equal(t.out.trials[0].reverted, 1);
  const p3 = load(c, 'ben'); assert.equal(p3.version, 3); assert.equal(p3.trial, null); assert.equal(p3.temperament.risk, 4, 'back to the scout preset value');
  assert.equal(hist(c, 'ben').pop().op, 'trial-end');
  // keep
  tool(c.T, ['try', 'ben', '--set', '/temperament/pace=1', '--base', '3', '--by', 'owner'], own);
  const k = tool(c.T, ['trial', 'keep', 'ben', '--by', 'owner'], own);
  assert.equal(k.code, 0); const p5 = load(c, 'ben'); assert.equal(p5.trial, null); assert.equal(p5.temperament.pace, 1);
  assert.deepEqual(tool(c.T, ['tick'], { now: Date.now() + 90 * 86400e3 }).out.trials, [], 'a kept trial never reverts');
  // stop
  tool(c.T, ['try', 'ben', '--set', '/counterpart/signOff=["promote","external"]', '--base', '5', '--by', 'owner'], own);
  assert.equal(tool(c.T, ['trial', 'stop', 'ben', '--by', 'owner'], own).code, 0);
  assert.deepEqual(load(c, 'ben').counterpart.signOff, ['promote']);
});

test('proposals: the people function proposes an experience; the owner adds it; the CEO decides only at its governance level; temperament goes to a trial', () => {
  const c = migrated();
  const p = tool(c.T, ['propose', 'ben', '--kind', 'experience', '--text', 'The forum tip about weather markets cost two days and taught him to check the fee first', '--source', 'd-0123456789ab', '--why', 'the weather card', '--by', 'Marisol']);
  assert.equal(p.code, 0, JSON.stringify(p));
  const words = tool(c.T, ['show', 'ben', '--console']).out.words.proposals[0].text;
  assert.equal(words, 'Marisol suggests adding to Benny\'s experience: \'The forum tip about weather markets cost two days and taught him to check the fee first.\' Add it · Not this one · Try it.');
  // CEO at approve (the default preset): refused, waits for the owner
  const ceo = tool(c.T, ['decide', p.out.id, 'apply', '--by', 'Alex']);
  assert.equal(ceo.code, 3); assert.match(ceo.out.error, /the owner decides/);
  const a = tool(c.T, ['decide', p.out.id, 'apply', '--by', 'owner'], own);
  assert.equal(a.code, 0, JSON.stringify(a));
  const ben = load(c, 'ben'); assert.equal(ben.experiences.length, 1); assert.equal(ben.experiences[0].addedBy, 'Marisol'); assert.equal(ben.experiences[0].source, 'd-0123456789ab');
  assert.equal(hist(c, 'ben').pop().op, 'proposal-apply');
  // at notify the CEO may apply; a temperament proposal becomes a trial
  const c2 = migrated({ gov: { categories: { profiles: 'notify' } } });
  const tp = tool(c2.T, ['propose', 'ben', '--kind', 'temperament', '--set', '/temperament/rigour=2', '--why', 'too many untestable cards', '--by', 'Marisol']);
  const d = tool(c2.T, ['decide', tp.out.id, 'apply', '--by', 'Alex']);
  assert.equal(d.code, 0, JSON.stringify(d)); assert.ok(load(c2, 'ben').trial, 'a temperament proposal goes to a trial');
  assert.equal(tool(c2.T, ['decide', tp.out.id, 'apply', '--by', 'Alex']).code, 2, 'decided once');
});

test('the experience duty: a decision naming a seat is due for the people function; quiet once a proposal cites it', () => {
  const c = migrated();
  const today = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(c.T, 'company/work/decisions.md'), '- ' + today + ' 09:00 Alex [d-00aa11bb22cc] Benny\'s weather card was killed: the fees ate the edge. (decision.js)\n');
  const d = tool(c.T, ['--duty']);
  assert.equal(d.code, 1); assert.equal(d.out.route, 'people');
  assert.ok(d.out.items.some(i => i.id === 'experience:ben:d-00aa11bb22cc'), JSON.stringify(d.out.items));
  tool(c.T, ['propose', 'ben', '--kind', 'experience', '--text', 'Fees ate the weather edge', '--source', 'd-00aa11bb22cc', '--why', 'x', '--by', 'Marisol']);
  const d2 = tool(c.T, ['--duty']);
  assert.ok(d2.code === 0 || !d2.out.items.some(i => /d-00aa11bb22cc/.test(i.id)));
});

test('policy: owner only; inject profile renders the charter\'s person sections between the markers and leaves the rest', () => {
  const c = migrated();
  assert.equal(tool(c.T, ['policy', 'inject', 'profile', '--by', 'Marisol']).code, 2);
  assert.equal(tool(c.T, ['policy', 'show']).out.inject, 'charter', 'absent reads charter');
  const r = tool(c.T, ['policy', 'inject', 'profile', '--by', 'owner'], own);
  assert.equal(r.code, 0, JSON.stringify(r)); assert.ok(r.out.charters.includes('company/roles/benny.md'));
  const ch = c.r('company/roles/benny.md');
  assert.match(ch, /<!-- profile:begin v=1 -->[\s\S]*## Counterpart\nRohan[\s\S]*<!-- profile:end -->/);
  assert.match(ch, /## Scope\n- idea cards/); assert.match(ch, /## KPIs\n- five cards a week/);
  assert.equal((ch.match(/^## Convictions/gm) || []).length, 1, 'moved, not duplicated');
  c.w('company/roles/benny.md', ch.replace('## Archetype\nscout', '## Archetype\nlead'));
  assert.match(JSON.stringify(tool(c.T, ['check', '--seat', 'ben', '--json']).out), /edited by hand/);
  tool(c.T, ['edit', 'ben', '--set', '/identity/stake="His name is on the cards."', '--base', '1', '--by', 'owner'], own);
  assert.match(c.r('company/roles/benny.md'), /<!-- profile:begin v=2 -->[\s\S]*## Archetype\nscout[\s\S]*## Stake\nHis name is on the cards\./, 'the next render overwrites the hand edit');
});

test('a hand edit of a profile or the policy is not read: the last recorded version decides at once, so a seat cannot drop its own sign-off', () => {
  const c = migrated();
  const SO = require(path.join(TOOLS, 'lib', 'signoff.js'));
  const o = { root: c.T, crew: CREW, ceo: 'boss' };
  assert.equal(tool(c.T, ['policy', 'signoff', 'live', '--by', 'owner'], own).code, 0);
  const ben = load(c, 'ben');
  assert.equal(ben.counterpart.seat, 'ro', JSON.stringify(ben.counterpart));
  const kind = ben.counterpart.signOff[0];
  assert.ok(kind, 'migrate gave Benny sign-off kinds');
  const gate = () => SO.gate({ seat: 'ben', kind, refs: ['ext:wire-money'] }, o);
  assert.equal(gate().cleared, false); assert.ok(gate().refuse, 'live: refused without a yes');
  assert.equal(P.loadState('ben', o).state, 'recorded');
  // the reproduction from the review: the profile written by hand with no counterpart, the policy with the sign-off off
  const f = path.join(c.T, 'company/people/profiles/ben.json');
  const forged = Object.assign({}, ben, { counterpart: null }); forged.hash = P.hashOf(forged);
  fs.writeFileSync(f, JSON.stringify(forged, null, 1) + '\n');
  fs.writeFileSync(path.join(c.T, 'company/people/profile-policy.json'), JSON.stringify({ signoff: { mode: 'off' } }));
  assert.equal(P.loadState('ben', o).state, 'restored');
  assert.equal(P.load('ben', o).counterpart.seat, 'ro', 'the recorded version is read');
  assert.equal(P.policy(o).signoff.mode, 'live', 'the recorded policy is read');
  assert.ok(gate().refuse, 'still refused');
  assert.match(JSON.stringify(tool(c.T, ['check', '--seat', 'ben', '--json']).out), /changed outside profile\.js/);
  // a forged history row (a valid chain hash is easy to compute) is not read either
  const hf = path.join(c.T, 'company/people/profiles/ben.history.jsonl');
  const last = hist(c, 'ben').pop();
  fs.appendFileSync(hf, JSON.stringify(Object.assign({}, last, { version: last.version + 1, body: forged, prevHash: last.rowHash })) + '\n');
  assert.equal(P.load('ben', o).counterpart.seat, 'ro');
  // the file deleted: the recorded version still decides
  fs.rmSync(f);
  assert.equal(P.load('ben', o).counterpart.seat, 'ro'); assert.ok(P.loadAll(o).ben, 'loadAll still lists the seat');
  // an older genuine version put back is not the newest recorded write
  const v1 = fs.readFileSync(path.join(c.T, 'company/people/profiles/ro.json'));
  assert.equal(tool(c.T, ['edit', 'ro', '--set', '/voice/words="Dry and exact."', '--base', '1', '--by', 'owner'], own).code, 0);
  fs.writeFileSync(path.join(c.T, 'company/people/profiles/ro.json'), v1);
  assert.equal(P.load('ro', o).voice.words, 'Dry and exact.');
  // a change through profile.js builds on the recorded version and is read as it is again
  assert.equal(tool(c.T, ['policy', 'pov', 'on', '--by', 'owner'], own).code, 0);
  assert.equal(P.policy(o).signoff.mode, 'live', 'the hand-made "off" was not built on'); assert.equal(P.policy(o).pov, true);
  // profile and history both gone or forged: no profile is read and the live gate refuses
  fs.writeFileSync(hf, JSON.stringify({ forged: true }) + '\n'); fs.writeFileSync(f, JSON.stringify(forged));
  assert.equal(P.loadState('ben', o).state, 'tampered');
  assert.match(gate().refuse || '', /changed outside profile\.js/);
});

test('a CEO that also holds the people function never approves its own proposal, even at notify', () => {
  const c = migrated({ gov: { categories: { profiles: 'notify' } } });
  c.w('company/tools/loops.json', { agents: Object.assign({}, CREW, { boss: Object.assign({}, CREW.boss, { functions: ['ceo', 'people'] }) }) });
  const p = tool(c.T, ['propose', 'ben', '--kind', 'experience', '--text', 'A weather card cost two days and taught him to check the fee first', '--source', 'd-0123456789ab', '--why', 'the weather card', '--by', 'Alex']);
  assert.equal(p.code, 0, JSON.stringify(p));
  const d = tool(c.T, ['decide', p.out.id, 'apply', '--by', 'Alex']);
  assert.equal(d.code, 3, JSON.stringify(d)); assert.match(d.out.error, /the CEO proposed this change/);
  assert.equal(tool(c.T, ['decide', p.out.id, 'apply', '--by', 'owner'], own).code, 0, 'the owner decides it');
  // Marisol's proposal: the CEO may still apply it at notify
  const q = tool(c.T, ['propose', 'ro', '--kind', 'experience', '--text', 'A clean backtest hid a fee bug for a week', '--source', 'd-0123456789ab', '--why', 'the fee bug', '--by', 'Marisol']);
  assert.equal(tool(c.T, ['decide', q.out.id, 'apply', '--by', 'Alex']).code, 0);
});

// locked-watch's baseline for the fixture, built by the watcher itself in a child (CAPHEOS_ROOT at the fixture, its mirror
// under H), so lib/recorded.js health() has something real to compare the provenance log with
function lwTick(T, H) {
  const code = 'const LW = require(' + JSON.stringify(path.join(TOOLS, 'locked-watch.js')) + '); LW.tick({ root: ' + JSON.stringify(T) + ', home: ' + JSON.stringify(H) + ', connectors: null, jobs: [], underStation: false, ownerShell: true, log: () => {} }).then(r => process.stdout.write(JSON.stringify({ ok: true, flagOnly: !!(r && r.flagOnly) })));';
  const p = spawnSync(process.execPath, ['-e', code], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, LOCKED_WATCH_HOME: H, STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_TZ: 'UTC' }) });
  if (p.status !== 0) throw new Error('locked-watch failed: ' + p.stdout + p.stderr);
  return JSON.parse(p.stdout);
}

test('emptying or deleting the write record and the history never makes a hand edit count: the watcher\'s last-known-good copy decides (re-verify A)', () => {
  const c = migrated();
  const H = path.join(c.T, 'home'); const prevHome = process.env.LOCKED_WATCH_HOME; process.env.LOCKED_WATCH_HOME = H;
  try {
    const RC = require(path.join(TOOLS, 'lib', 'recorded.js'));
    const SO = require(path.join(TOOLS, 'lib', 'signoff.js'));
    const o = { root: c.T, crew: CREW, ceo: 'boss' };
    assert.equal(tool(c.T, ['policy', 'signoff', 'live', '--by', 'owner'], own).code, 0);
    lwTick(c.T, H); lwTick(c.T, H);   // the first builds the baseline, the second takes the recorded writes since
    RC._clearCache();
    assert.equal(RC.health({ root: c.T }).ok, true, JSON.stringify(RC.health({ root: c.T })));
    const ben = load(c, 'ben'); const kind = ben.counterpart.signOff[0];
    const gate = () => SO.gate({ seat: 'ben', kind, refs: ['ext:wire-money'] }, o);
    assert.ok(gate().refuse, 'live: refused without a yes');
    const prov = path.join(c.T, 'company/state/locked/provenance.jsonl');
    const forged = Object.assign({}, ben, { counterpart: null }); forged.hash = P.hashOf(forged);
    const forge = () => {
      for (const f of ['company/people/profiles/ben.history.jsonl', 'company/people/profile-policy.history.jsonl']) fs.rmSync(path.join(c.T, f), { force: true });
      fs.writeFileSync(path.join(c.T, 'company/people/profiles/ben.json'), JSON.stringify(forged, null, 1) + '\n');
      fs.writeFileSync(path.join(c.T, 'company/people/profile-policy.json'), JSON.stringify({ signoff: { mode: 'off' } }));
    };
    const saved = fs.readFileSync(prov);
    // 1. the reproduction: the log emptied, the history deleted, the profile and the policy written by hand
    fs.writeFileSync(prov, ''); forge();
    assert.equal(RC.health({ root: c.T }).ok, false); assert.match(RC.health({ root: c.T }).why, /shorter/);
    assert.equal(P.loadState('ben', o).state, 'lastgood');
    assert.equal(P.load('ben', o).counterpart.seat, 'ro', 'the last-known-good copy is read, not the forged file');
    assert.equal(P.policy(o).signoff.mode, 'live', 'the hand-made "off" is not obeyed');
    assert.ok(gate().needed && gate().refuse, JSON.stringify(gate()));
    assert.match(JSON.stringify(tool(c.T, ['check', '--seat', 'ben', '--json']).out), /last-known-good/);
    // 2. the log deleted outright: the same
    fs.rmSync(prov);
    assert.equal(P.loadState('ben', o).state, 'lastgood'); assert.equal(P.policy(o).signoff.mode, 'live'); assert.ok(gate().refuse);
    // 3. the log rewritten before the point the watcher read (same length, one byte changed)
    const bad = Buffer.from(saved); bad[10] = bad[10] === 0x41 ? 0x42 : 0x41; fs.writeFileSync(prov, bad);
    assert.match(RC.health({ root: c.T }).why, /rewritten/); assert.equal(P.loadState('ben', o).state, 'lastgood');
    // 4. no last-known-good copy to read (the lkg copy changed too): no profile, the live gate refuses
    fs.writeFileSync(prov, '');
    fs.writeFileSync(path.join(c.T, 'company/state/locked/lkg/company/people/profiles/ben.json'), JSON.stringify(forged));
    assert.equal(P.loadState('ben', o).state, 'tampered'); assert.ok(gate().refuse);
    // 5. the baseline deleted while its mirror is there: never "nothing recorded, trust the file"
    fs.rmSync(path.join(c.T, 'company/state/locked/baseline.json'));
    assert.equal(RC.health({ root: c.T }).ok, false); assert.equal(P.loadState('ben', o).state, 'tampered'); assert.equal(P.policy(o).signoff.mode, 'live');
  } finally { if (prevHome === undefined) delete process.env.LOCKED_WATCH_HOME; else process.env.LOCKED_WATCH_HOME = prevHome; }
});

test('rows written after locked-watch flagged an agent writing to the write record do not count (re-verify A/B residual)', () => {
  const c = migrated();
  const H = path.join(c.T, 'home'); const prevHome = process.env.LOCKED_WATCH_HOME; process.env.LOCKED_WATCH_HOME = H;
  try {
    const RC = require(path.join(TOOLS, 'lib', 'recorded.js'));
    const o = { root: c.T, crew: CREW, ceo: 'boss' };
    assert.equal(tool(c.T, ['policy', 'signoff', 'live', '--by', 'owner'], own).code, 0);
    lwTick(c.T, H); lwTick(c.T, H); RC._clearCache();
    const prov = path.join(c.T, 'company/state/locked/provenance.jsonl');
    const ben = load(c, 'ben'); const forged = Object.assign({}, ben, { counterpart: null }); forged.hash = P.hashOf(forged);
    const body = JSON.stringify(forged, null, 1) + '\n';
    const at = fs.statSync(prov).size;
    fs.writeFileSync(path.join(c.T, 'company/people/profiles/ben.json'), body);
    fs.appendFileSync(prov, JSON.stringify({ at: '2026-11-19 10:00', file: 'company/people/profiles/ben.json', kind: 'write', sha256: RC.sha(body), bytes: body.length, writer: 'profile.js', pid: 1, underStation: false, main: 'company/tools/profile.js', tainted: false }) + '\n');
    assert.equal(P.loadState('ben', o).state, 'recorded', 'before the watcher\'s flag a careful forgery still reads as recorded (documented as not proof)');
    // the watcher's flag (what locked-watch writes when a transcript shows an agent writing to provenance.jsonl)
    const bf = path.join(c.T, 'company/state/locked/baseline.json'); const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
    b.provFlagged = { run: 'r-1', trustedTo: at }; const txt = JSON.stringify(b, null, 1) + '\n'; fs.writeFileSync(bf, txt);
    const mf = fs.readdirSync(path.join(H, '.local/share/capheos-guard')).map(d => path.join(H, '.local/share/capheos-guard', d, 'locked-baseline.sha256'))[0];
    fs.writeFileSync(mf, RC.sha(txt) + '\n');
    const h = RC.health({ root: c.T }); assert.equal(h.ok, false); assert.equal(h.trustedTo, at);
    assert.notEqual(P.loadState('ben', o).state, 'recorded');
    assert.equal(P.load('ben', o).counterpart.seat, 'ro', 'the forged row is not read; the recorded history decides');
    // the same for an append-only record (a forged sign-off "yes" with a matching hand-written append row)
    const sf = path.join(c.T, 'company/state/signoffs.jsonl'); const line = JSON.stringify({ id: 'so-x', op: 'answer', verdict: 'yes' }) + '\n';
    fs.appendFileSync(sf, line);
    fs.appendFileSync(prov, JSON.stringify({ at: '2026-11-19 10:01', file: 'company/state/signoffs.jsonl', kind: 'append', chunkSha: RC.sha(line), bytes: line.length, writer: 'approvals.js', pid: 1, underStation: false, main: 'company/tools/approvals.js', tainted: false }) + '\n');
    assert.deepEqual(RC.lines(sf, ['approvals.js'], { root: c.T }).filter(l => /so-x/.test(l)), [], 'a forged append after the flag is not read');
  } finally { if (prevHome === undefined) delete process.env.LOCKED_WATCH_HOME; else process.env.LOCKED_WATCH_HOME = prevHome; }
});

test('migrate rewrites a charter written about the person ("He reads", "Benny runs", "she can count") so the profile speaks to them', () => {
  const c = fixture();
  c.w('company/roles/benny.md', CHARTER.replace('Restless and quick.', 'Restless and quick. He reads twenty threads before lunch and his notes are short. Benny runs on the cheap setup.')
    .replace('## Convictions', '## Will not do\n- Estimate a number she can count.\n- Ask her first when he is unsure.\n\n## Convictions'));
  const r = tool(c.T, ['migrate', '--all', '--by', 'owner'], own); assert.equal(r.code, 0, JSON.stringify(r));
  const b = load(c, 'ben');
  assert.equal(b.identity.personality, 'Restless and quick. You read twenty threads before lunch and your notes are short. You run on the cheap setup.');
  assert.deepEqual(b.willNotDo, ['Estimate a number you can count.', 'Ask you first when you are unsure.']);
  assert.match(r.out.made.find(m => m.seat === "ben").rewritten, /now to them \("you"\): personality, willNotDo/);
  assert.ok(!/\b(?:he|she|his|her)\b/i.test(P.reminder(b)), P.reminder(b));
});
