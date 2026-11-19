#!/usr/bin/env node
/* profile-migrate.test.js — what the wave-3 reviews found in profile.js migrate and the injected block, on a fixture
 * company shaped like the sandbox (a careful tester who is "the conservative counterpart of" an eager scout, two seats
 * whose charters name people not hired yet, wrapped bullets, a long Counterpart text with colons):
 *   - "counterpart of X" means this seat checks X, never that X checks it; a name not on the roster is ignored, never
 *     replaced by someone else on the crew; the why keeps whole sentences;
 *   - a bullet that wraps onto a second line stays one belief;
 *   - profile.js check fails a pairing the wrong way round, two seats each named the other's checker and a broken line,
 *     and notes identical sliders ("same sliders as X"); migrate reports them for the people seat;
 *   - the injected block stays under its size limit (newest experiences, a pushing-back example kept);
 *   - the console's history credits the owner for a build the owner ran, and experiences show a name, not an id.
 *   node --test company/tools/tests/profile-migrate.test.js
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
  boss: { name: 'Alex Kim', functions: ['ceo'], manager: null, inbox: 'to-alex.md', title: 'CEO' },
  mar: { name: 'Mara Vale', functions: ['people'], manager: 'boss', inbox: 'to-mara.md', title: 'People', role: 'company/roles/mara.md' },
  ben: { name: 'Noah Tate', manager: 'boss', inbox: 'to-noah.md', title: 'Idea Scout', role: 'company/roles/noah.md' },
  ro: { name: 'Ravi Shah', manager: 'boss', inbox: 'to-ravi.md', title: 'Quant Researcher', role: 'company/roles/ravi.md' },
  hal: { name: 'Hollis Cole', manager: 'ro', inbox: 'to-hollis.md', title: 'Data Scientist', role: 'company/roles/hollis.md' },
};
const NOAH = ['# Noah Tate — Idea Scout', '', '## Archetype', 'scout', '', '## Personality', 'Restless.', '',
  '## Convictions', '- The crowd is a dataset, not an oracle.', '- Edges show up in comment sections and group chats months before they show up in a paper, and they are gone by the',
  '  time the paper is out.', '- New markets are mispriced in their first hours.', '',
  '## Blind spots', '- Falls for a good story told by someone', '  who sounds sure.', '',
  '## Counterpart', 'Ravi Shah, the Quant Researcher, on Claude while Noah runs on MiniMax: two different heads on purpose. Noah throws him one batch',
  'a day; Ravi throws back a test or a kill inside two working days.', ''].join('\n');
const RAVI = ['# Ravi Shah — Quant Researcher', '', '## Archetype', 'tester', '', '## Convictions', '- A test that cannot fail is not a test.', '',
  '## Counterpart', 'You are the conservative counterpart of Noah Tate (Idea Scout): every card he writes comes to you, and you answer it',
  'with the cheapest test or a kill, inside two working days. The scout writes the kill line in words; your verdict\'s first line puts the fee and',
  'the fill against it, because that arithmetic is your trade, not his. You are not the last word on money: a card you KEEP becomes a strategy spec,',
  'and anything that would place an order goes to the CEO.', ''].join('\n');
const HOLLIS = ['# Hollis Cole — Data Scientist', '', '## Archetype', 'tester', '', '## Counterpart',
  'She is the conservative counterpart of Odile Marchetti (Idea Combiner): every combination card comes to her. What to record stays Ravi Shah\'s call.', ''].join('\n');
const MARA = ['# Mara Vale — People', '', '## Archetype', 'connector', '', '## Temperament', '- Risk: 1', '- Pace — 3', '- rigour: 2', '- candour: 4', '- independence: 1', ''].join('\n');

function fixture() {
  const T = __LIFE.tmpDir('profile-migrate-test-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json', 'company/defaults/state/governance.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/state/governance.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w('company/roles/noah.md', NOAH); w('company/roles/ravi.md', RAVI); w('company/roles/hollis.md', HOLLIS); w('company/roles/mara.md', MARA);
  for (const s of Object.values(CREW)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n');
  // a profile written as profile.js writes it (recorded), for a scenario the tool itself would refuse to make
  const wp = (rel, d) => { const f = path.join(T, rel), text = JSON.stringify(d, null, 1) + '\n'; fs.writeFileSync(f, text); require(path.join(TOOLS, 'provenance.js')).wrote(f, text, 'profile.js', { root: T }); };
  return { T, w, wp, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return null; } } };
}
function tool(T, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'const t = require(' + JSON.stringify(path.join(TOOLS, 'profile.js')) + '); const r = t.run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', PROFILE_NO_SYNC: '1' }); delete env.STARNET_AGENT_ID;
  // a script at the tool's own path in the fixture, not node -e: a profile is read only as an untainted profile.js recorded it
  const sf = path.join(T, 'company', 'tools', 'profile.js'); fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, code);
  const p = spawnSync(process.execPath, [sf], { cwd: T, encoding: 'utf8', env });
  if (p.status !== 0) throw new Error('child failed: ' + p.stdout + p.stderr);
  return JSON.parse(p.stdout);
}
const load = (c, s) => JSON.parse(c.r('company/people/profiles/' + s + '.json'));

test('migrate reads "counterpart of" the right way round, ignores names not hired, keeps whole sentences and wrapped bullets', () => {
  const c = fixture();
  const r = tool(c.T, ['migrate', '--all', '--by', 'owner'], { owner: true });
  assert.equal(r.code, 0, JSON.stringify(r));
  const ro = load(c, 'ro'), ben = load(c, 'ben'), hal = load(c, 'hal');
  assert.equal(ro.counterpart, null, 'Ravi is the counterpart OF Noah: Noah is not recorded as his checker');
  assert.deepEqual(r.out.made.find(m => m.seat === 'ro').checks, ['ben'], '...it is recorded as a seat Ravi checks');
  assert.equal(ben.counterpart.seat, 'ro', 'Noah\'s charter opens with Ravi: Ravi checks Noah');
  assert.ok(!/:$/.test(ben.counterpart.why) && /\.$/.test(ben.counterpart.why), 'the why ends on a whole sentence, never cut at a colon: ' + ben.counterpart.why);
  assert.equal(hal.counterpart, null, 'a name not on the roster (Odile) is ignored, never replaced by Ravi');
  assert.deepEqual(ben.convictions, ['The crowd is a dataset, not an oracle.', 'Edges show up in comment sections and group chats months before they show up in a paper, and they are gone by the time the paper is out.', 'New markets are mispriced in their first hours.'], 'a wrapped bullet stays one conviction');
  assert.deepEqual(ben.blindSpots, ['Falls for a good story told by someone who sounds sure.']);
  // what the crew and the owner read
  const roBlock = tool(c.T, ['render', 'ro']).out;
  assert.equal((roBlock.match(/Whose work you check:/g) || []).length, 1, 'Ravi checks one seat: ' + roBlock);
  assert.ok(/Whose work you check: Noah Tate/.test(roBlock) && !/Who checks your work/.test(roBlock));
  assert.ok(!/Noah checks you/.test(tool(c.T, ['render', 'ro', '--reminder']).out), 'Ravi\'s reminder does not say Noah checks him');
  const words = tool(c.T, ['show', 'ro', '--console']).out.words;
  assert.ok(/^Nobody checks Ravi/.test(words.counterpart) && words.checks === 'Ravi checks Noah before their ideas move on.', JSON.stringify(words));
  // a Temperament section is read (colons, dashes); one without it says so to the people seat
  const mar = load(c, 'mar');
  assert.deepEqual([mar.temperament.risk, mar.temperament.pace, mar.temperament.rigour, mar.temperament.candour, mar.temperament.independence], [1, 3, 2, 4, 1]);
  assert.ok(/preset/.test(r.out.made.find(m => m.seat === 'ro').temperament), 'a seat filled from its preset is flagged');
  assert.ok((r.out.problems || []).some(t => /same sliders as/.test(t)), 'identical sliders are reported to the people seat: ' + JSON.stringify(r.out.problems));
});

test('check: a reversed pairing, a mutual pairing and a broken line fail; identical sliders are a note', () => {
  const crew = { ben: { name: 'Noah' }, ro: { name: 'Ravi' } };
  const mk = (seat, arch, cp, extra) => Object.assign(P.blank(seat, { name: crew[seat].name }), { identity: Object.assign(P.blank(seat).identity, { name: crew[seat].name, archetype: arch }), counterpart: cp ? { seat: cp, signOff: [], why: '' } : null }, extra || {});
  const rev = P.crewChecks({ ro: mk('ro', 'tester', 'ben'), ben: mk('ben', 'scout', null) }, { crew });
  assert.ok(rev.failures.some(f => /wrong way round/.test(f.text) && f.seat === 'ro'), JSON.stringify(rev));
  const mutual = P.crewChecks({ ro: mk('ro', 'tester', 'ben'), ben: mk('ben', 'scout', 'ro') }, { crew });
  assert.ok(mutual.failures.some(f => /each named as the other/.test(f.text)), JSON.stringify(mutual));
  const broken = P.crewChecks({ ben: mk('ben', 'scout', 'ro', { convictions: ['Edges show up months before they show up in a paper, and they are gone by the', 'time the paper is out.'] }), ro: mk('ro', 'tester', null) }, { crew });
  assert.ok(broken.failures.some(f => /broken in two/.test(f.text)), JSON.stringify(broken));
  assert.ok(broken.notes.some(n => /same sliders as/.test(n.text)), 'two blank profiles share sliders: a note');
  const fine = P.crewChecks({ ben: mk('ben', 'scout', 'ro', { convictions: ['One line.', 'Another line.'], temperament: Object.assign({}, P.blank('ben').temperament, { risk: 4 }) }), ro: mk('ro', 'tester', null) }, { crew });
  assert.deepEqual(fine, { failures: [], notes: [] });
  // and through the tool
  const c = fixture(); tool(c.T, ['migrate', '--all', '--by', 'owner'], { owner: true });
  const ro = load(c, 'ro'); ro.counterpart = { seat: 'ben', signOff: [], why: '' }; delete ro.hash;
  ro.hash = P.hashOf(ro); c.wp('company/people/profiles/ro.json', ro);
  const ch = tool(c.T, ['check', '--all']);
  assert.equal(ch.code, 1); assert.ok(ch.out.seats.find(s => s.seat === 'ro').failures.some(f => /wrong way round/.test(f)), JSON.stringify(ch.out.seats));
});

test('the injected block stays under its limit: the newest experiences, a pushing-back example kept, the fixed rules whole', () => {
  const p = P.blank('ben', { name: 'Noah' });
  p.identity.archetype = 'scout';
  p.experiences = Array.from({ length: 60 }, (_, i) => ({ at: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), text: 'Experience number ' + i + ': ' + 'a long lesson about markets and fills and fees. '.repeat(6), source: 's' + i, addedBy: 'mar', version: 2 }));
  p.examples = Array.from({ length: 12 }, (_, i) => ({ with: 'owner', they: 'Question ' + i + ' ' + 'x'.repeat(200), you: 'Answer ' + i + ' ' + 'y'.repeat(200), pushback: i === 11 }));
  p.relationships = Array.from({ length: 30 }, (_, i) => ({ seat: 'ro', note: 'note ' + i }));
  const b = P.block(p, { crew: { ben: { name: 'Noah' }, ro: { name: 'Ravi' } } });
  assert.ok(b.length <= P.BLOCK_MAX_CHARS, 'the block is ' + b.length + ' characters, over ' + P.BLOCK_MAX_CHARS);
  assert.ok(/Experience number 59/.test(b) && !/Experience number 0:/.test(b), 'the newest experiences are kept, the oldest go');
  assert.ok(/\(pushing back\)/.test(b), 'the pushing-back example is kept');
  for (const t of P.FIXED_TEXTS) assert.ok(b.includes(t), 'a fixed rule is never cut: ' + t);
  assert.ok((b.match(/^- Ravi: note/mg) || []).length <= P.BLOCK_CAPS.relationships);
});

test('over the limit the long lists are trimmed first: how a person sounds, with the owner and the pushing-back example are never cut', () => {
  const p = P.blank('ben', { name: 'Noah Tate' });
  p.identity.archetype = 'scout'; p.identity.personality = 'Restless, quick and loud about what he finds. '.repeat(8); p.identity.background = 'Ran a trading forum and blew up an account once. '.repeat(8);
  p.counterpart = { seat: 'ro', signOff: ['promote', 'commit'], why: 'Ravi tests every card before anyone builds on it.' };
  const long = (w, n) => Array.from({ length: n }, (_, i) => w + ' ' + (i + 1) + ': ' + 'a careful sentence about where the edge shows up first and why. '.repeat(3));
  for (const k of ['convictions', 'willNotDo', 'unprompted', 'whereYouLook', 'strengths', 'blindSpots', 'flaws']) p[k] = long(k, 8);
  p.habits = ['Posts the raw thread before the summary.', 'Says "cheap to check" when he means "I like it".'];
  p.voice = { preset: 'upbeat', words: 'Fast, plain and a little loud; short sentences, numbers first.', avoid: ['circle back'], toOwner: 'Leads with the one card worth the owner\'s time, then the cost.' };
  p.examples = [{ with: 'ro', they: 'One lucky week.', you: 'Cheap to check; I drop it if it fails.', pushback: true }, { with: 'owner', they: 'Anything new?', you: 'Two cards, one worth a look.' }, { with: 'ro', they: 'Killed it.', you: 'Fair. Next one.' }];
  const crew = { ben: { name: 'Noah Tate' }, ro: { name: 'Ravi Shah' } };
  const b = P.block(p, { crew });
  assert.ok(b.length <= P.BLOCK_MAX_CHARS, b.length + ' characters');
  for (const t of ['How you sound: Fast, plain and a little loud', 'You never say: "circle back"', 'With the owner: Leads with the one card', 'You (pushing back): "Cheap to check; I drop it if it fails."', 'Posts the raw thread before the summary.', 'Says "cheap to check" when he means']) assert.ok(b.includes(t), 'kept: ' + t);
  for (const t of P.FIXED_TEXTS) assert.ok(b.includes(t), 'a fixed rule is never cut: ' + t);
  assert.ok(!/\n…\n|\n…$/.test(b), 'no bare cut-off line');
  // where you look first and the strengths go before the beliefs and what you refuse
  const count = k => (b.split(/\n\n/).find(x => x.startsWith(k)) || '').split('\n- ').length - 1;
  assert.ok(count('Where you look first') < 8 && count('Your strengths') < 8, 'the long lists are trimmed');
  assert.ok(count('Where you look first') >= 1 && count('Your strengths') >= 1, 'down to one line each, not gone');
  assert.ok(count('What you believe') >= count('Where you look first'), 'beliefs are trimmed after where you look');
  // a profile under the limit is untouched (the same block as before any trimming)
  const small = Object.assign({}, p, { whereYouLook: p.whereYouLook.slice(0, 1), strengths: p.strengths.slice(0, 1), blindSpots: [], flaws: [], unprompted: [], convictions: p.convictions.slice(0, 2), willNotDo: p.willNotDo.slice(0, 1) });
  const sb = P.block(small, { crew }); assert.ok(sb.length < P.BLOCK_MAX_CHARS); assert.ok(sb.includes(p.convictions[1].trim()), 'whole lines when it fits');
});

test('the console credits the owner for a build the owner ran; an experience shows a name, not an id', () => {
  const c = fixture();
  tool(c.T, ['migrate', '--all', '--by', 'owner'], { owner: true });
  const v = tool(c.T, ['show', 'ben', '--console']).out;
  assert.equal(v.history[0].by, 'You', JSON.stringify(v.history[0]));
  const ben = load(c, 'ben'); ben.experiences = [{ at: '2026-11-18', text: 'A lesson.', source: 'd-1', addedBy: 'cand-people-manager-1-mara-va', version: 1 }, { at: '2026-11-18', text: 'Another.', source: 'd-2', addedBy: 'mar', version: 1 }];
  delete ben.hash; ben.hash = P.hashOf(ben); c.wp('company/people/profiles/ben.json', ben);
  const v2 = tool(c.T, ['show', 'ben', '--console']).out;
  assert.deepEqual(v2.experiences.map(e => e.addedByName), ['Mara', 'Mara']);
});

test('each reminder carries one thing of the person\'s own; text written about the person ("he", the name) is a note for the people seat', () => {
  const crew = { ben: { name: 'Noah Tate' }, ro: { name: 'Ravi Shah' } };
  const ben = P.blank('ben', { name: 'Noah Tate' }); ben.identity.archetype = 'scout'; ben.counterpart = { seat: 'ro', signOff: ['promote'], why: 'Noah runs on the cheap setup, so Ravi checks.' };
  ben.identity.personality = 'He reads twenty threads before breakfast.'; ben.habits = ['Posts the raw thread before the summary.'];
  const ro = P.blank('ro', { name: 'Ravi Shah' }); ro.identity.archetype = 'tester'; ro.convictions = ['I would want to see it on a day it lost.']; ro.identity.personality = 'You distrust a clean curve.';
  const rb = P.reminder(ben, { crew }), rr = P.reminder(ro, { crew });
  assert.ok(rb.length <= P.REMINDER_MAX && rr.length <= P.REMINDER_MAX);
  assert.match(rb, /Your habit: Posts the raw thread/); assert.match(rr, /You believe: I would want to see it on a day it lost\./);
  assert.notEqual(rb.replace(/Noah|Ravi|scout|tester/g, ''), rr.replace(/Noah|Ravi|scout|tester/g, ''), 'not the same sentence with a name swapped');
  const long = Object.assign({}, ro, { convictions: ['x '.repeat(150).trim()] }); assert.ok(P.reminder(long, { crew }).length <= P.REMINDER_MAX);
  const notes = P.crewChecks({ ben, ro }, { crew }).notes.map(n => n.text);
  assert.ok(notes.some(t => /Noah Tate's personality or why they are checked are written about Noah/.test(t)), JSON.stringify(notes));
  assert.ok(!notes.some(t => /Ravi Shah's .* written about/.test(t)), 'a profile in "you" is not flagged');
});

test('the temperament sentences in a "you" profile do not say "they" or "their"; a muted caption on a selected talk card stays readable', () => {
  const T = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/people/temperament.json'), 'utf8'));
  for (const [k, s] of Object.entries(T.sliders)) for (const v of s.values) assert.ok(!/\b(?:they|their|them)\b/i.test(v), k + ': ' + v);
  const css = fs.readFileSync(path.join(REPO, 'console/ui/app.css'), 'utf8');
  assert.match(css, /\.choice\[aria-checked="true"\] \.muted \{ color: inherit;/);
});
