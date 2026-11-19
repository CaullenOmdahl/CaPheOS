#!/usr/bin/env node
/* hire-profile.test.js — hire.js writes the same profile shape (docs/PROFILES.md "Hiring"), with no station:
 *   - a hire's profile md becomes company/people/profiles/<seat>.json version 1, by hire.js, through profile.js (the only
 *     writer): its counterpart resolved to a seat id from ## Counterpart, its examples from ## Example exchanges
 *   - an eager candidate whose profile names no counterpart on the crew is refused at pick, naming the people seat
 *   - a pick that would put half the crew on one preset carries a mix warning in the scorecard
 *   - the templates carry the new headings
 *   node --test company/tools/tests/hire-profile.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const CREW = {
  boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md', role: 'company/roles/alex.md' },
  mar: { name: 'Mara', functions: ['people'], manager: 'boss', inbox: 'to-mara.md', role: 'company/roles/mara.md' },
  ro: { name: 'Ravi', manager: 'boss', inbox: 'to-ravi.md', role: 'company/roles/ravi.md' },
  kit: { name: 'Kit', manager: 'boss', inbox: 'to-kit.md', role: 'company/roles/kit.md' },
};
const PROFILE = cp => ['# Candidate profile — Jo Vega', '', '## Archetype', 'scout', '', '## Personality', 'Restless and quick.', '', '## Backstory and motivation', 'Ran a trading Discord.', '',
  '## Stake', 'Wants a seat that pays for ideas, not hours.', '', '## Temperament', 'risk: 4 — Tries the bold thing first and counts later', 'pace: 4 — Gets a first version out today', 'rigour: 1 — Checks the main thing and moves on', 'candour: 3 — Direct', 'independence: 3 — Decides most things alone', '',
  '## Voice', 'Fast and plain.', '', '## Persona preset', 'upbeat', '', '## Convictions', '- The edge was in a forum first.', '', '## Counterpart', cp, '',
  '## Flaws', '- Loses interest once a test is boring.', '', '## Relationships', '- Ravi — trusts his kills, argues every one.', '',
  '## Example exchanges', '- With Ravi: "One lucky week." — You: "Cheap to check; I drop it if it fails." (pushes back)', '- With the owner: "Any news?" — You: "Two cards, one weird."', '- With Ravi: "Killed." — You: "Fair. Next."', ''].join('\n');
function fixture() {
  const T = __LIFE.tmpDir('hire-profile-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json', 'company/defaults/state/governance.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/state/governance.json', JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')));
  w('company/work/decisions.md', '# Decisions\n\n');
  for (const [id, pre] of [['alex', 'composed'], ['mara', 'upbeat'], ['ravi', 'dry'], ['kit', 'upbeat']]) w('company/roles/' + id + '.md', '# ' + id + '\n\n## Persona preset\n' + pre + '\n');
  for (const s of Object.values(CREW)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n');
  w('company/hiring/scout-1/round.json', { slug: 'scout-1', role: 'Idea Scout', manager: 'boss', openedBy: 'Mara', candidates: [{ agentId: 'cand-jo', name: 'JO VEGA', status: 'candidate', persona: 'upbeat', profile: 'company/hiring/scout-1/profiles/jo.md', interviewedAt: '2026-11-19T10:00:00Z' }] });
  w('company/hiring/scout-1/log.md', '# log\n');
  w('company/hiring/scout-1/scorecard.md', '# Scorecard\n');
  return { T, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
}
const env = T => Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', PROFILE_NO_SYNC: '1' });
const hire = (T, argv) => { const p = spawnSync(process.execPath, [path.join(TOOLS, 'hire.js')].concat(argv), { cwd: T, encoding: 'utf8', env: env(T), timeout: 60000 }); let j = null; try { j = JSON.parse(p.stdout); } catch (_) {} return { code: p.status, out: j, raw: p.stdout + p.stderr }; };

test('pick: an eager candidate with no counterpart on the crew is refused, naming the people seat; with one, the pick is recorded with the mix warning', () => {
  const c = fixture();
  c.w('company/hiring/scout-1/profiles/jo.md', PROFILE('<The data seat, named.>'));
  const r = hire(c.T, ['pick', '--round', 'scout-1', '--agent', 'cand-jo', '--by', 'Mara', '--why', 'best cards']);
  assert.equal(r.code, 2, r.raw); assert.match(r.out.error, /eager seat \(scout\).*names no counterpart.*Mara writes ## Counterpart/);
  c.w('company/hiring/scout-1/profiles/jo.md', PROFILE('Somebody from outside reviews the cards.'));
  assert.match(hire(c.T, ['pick', '--round', 'scout-1', '--agent', 'cand-jo', '--by', 'Mara', '--why', 'x']).out.error, /names nobody on the crew/);
  c.w('company/hiring/scout-1/profiles/jo.md', PROFILE('Ravi tests or kills every card.'));
  const ok = hire(c.T, ['pick', '--round', 'scout-1', '--agent', 'cand-jo', '--by', 'Mara', '--why', 'best cards']);
  assert.equal(ok.code, 0, ok.raw); assert.equal(ok.out.picked, 'cand-jo');
  assert.match(c.r('company/hiring/scout-1/scorecard.md'), /\*\*Crew mix warning:\*\* with this hire 3 of 5 seats share the "upbeat" preset/);
});

test('hire: the profile md becomes version 1 through profile.js, by hire.js, with the counterpart and examples', () => {
  const c = fixture();
  c.w('company/tools/loops.json', { agents: Object.assign({}, CREW, { jo: { name: 'Jo Vega', title: 'Idea Scout', manager: 'boss', inbox: 'to-jo-vega.md' } }) });
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'profile.js')) + ').fromHire({ seat: "jo", md: ' + JSON.stringify(PROFILE('Ravi tests or kills every card.')) + ', by: "Mara", round: "scout-1", decision: false })));';
  const p = spawnSync(process.execPath, ['-e', code], { cwd: c.T, encoding: 'utf8', env: env(c.T) });
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout); assert.equal(r.version, 1); assert.deepEqual(r.missing, ['willNotDo', 'unprompted']);
  const prof = JSON.parse(c.r('company/people/profiles/jo.json'));
  assert.equal(prof.version, 1); assert.equal(prof.counterpart.seat, 'ro'); assert.deepEqual(prof.counterpart.signOff, ['promote']);
  assert.equal(prof.examples.length, 3); assert.equal(prof.examples.filter(e => e.pushback).length, 1); assert.equal(prof.examples[1].with, 'owner');
  assert.deepEqual([prof.temperament.risk, prof.temperament.rigour], [4, 1]); assert.equal(prof.identity.stake, 'Wants a seat that pays for ideas, not hours.');
  assert.deepEqual(prof.relationships, [{ seat: 'ro', note: 'trusts his kills, argues every one.' }]); assert.deepEqual(prof.flaws, ['Loses interest once a test is boring.']);
  const h = c.r('company/people/profiles/jo.history.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(h.length, 1); assert.equal(h[0].by, 'hire.js'); assert.equal(h[0].version, 1);
  // hire() calls it after the seat is on the crew
  const src = fs.readFileSync(path.join(TOOLS, 'hire.js'), 'utf8');
  assert.ok(src.indexOf("require('./profile.js').fromHire(") > src.indexOf('writeJson(LOOPS, loops);'), 'hire() writes the profile once the seat is on the crew');
});

test('templates: the charter template and the idea seats carry Stake, Temperament, Flaws, Relationships and Example exchanges', () => {
  const P = require(path.join(TOOLS, 'lib', 'profile.js'));
  for (const f of ['_charter-template.md', 'idea-scout.md', 'idea-combiner.md']) {
    const t = fs.readFileSync(path.join(REPO, 'company', 'roles', 'templates', f), 'utf8');
    for (const h of ['Stake', 'Temperament', 'Flaws', 'Relationships', 'Example exchanges']) assert.match(t, new RegExp('^## ' + h + '$', 'm'), f + ' ' + h);
  }
  for (const h of ['Stake', 'Temperament', 'Flaws', 'Relationships', 'Example exchanges']) assert.ok(P.PROFILE_SECTIONS.includes(h));
  const scout = P.fromCharter(fs.readFileSync(path.join(REPO, 'company', 'roles', 'templates', 'idea-scout.md'), 'utf8'), { seat: 'x', crew: {} }).profile;
  assert.deepEqual([scout.temperament.risk, scout.temperament.pace, scout.temperament.rigour], [4, 4, 1]);
  assert.equal(scout.examples.length, 0, 'a placeholder is not an example');
});
