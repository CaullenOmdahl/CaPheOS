#!/usr/bin/env node
/* profile-sections.test.js — the person in a charter reaches the agent (no station).
 *
 * A hire's profile may carry Convictions, Will not do, Takes care of unprompted, Where you look, Counterpart, Blind
 * spots and Signature habits as well as Personality, Backstory, Voice and Persona preset. hire.js must carry every one
 * into the charter (template-started or not) and tell the interviewed candidate the ones that shape answers; dossier.js
 * must inject them into the seat's identity, and must never inject a template placeholder ("<Plausible history.>").
 * Every seat template in company/roles/templates/ keeps the headings dossier.js reads.
 *
 *   node --test company/tools/tests/profile-sections.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');

const REPO = path.resolve(__dirname, '..', '..', '..');
const hire = require(path.join(REPO, 'company', 'tools', 'hire.js'));
const profile = require(path.join(REPO, 'company', 'tools', 'lib', 'profile.js'));
const dossier = require(path.join(REPO, 'company', 'tools', 'dossier.js'));
const TEMPLATES = path.join(REPO, 'company', 'roles', 'templates');

const PROFILE = [
  '# Candidate profile — Jo Vega', '',
  '## Personality', 'Restless and quick.', '',
  '## Backstory and motivation', 'Ran a trading Discord for three years.', '',
  '## Voice', 'Fast and plain.', '',
  '## Persona preset', 'upbeat', '',
  '## Convictions', '- The edge was in a forum before it was in a paper.', '',
  '## Will not do', '- Read a textbook to learn basics.', '',
  '## Where you look', '1. The venue\'s comment threads.', '',
  '## Counterpart', 'The quant seat kills or tests every card.', '',
  '## Model', 'custom/MiniMax-M3.1-Flash', '',
].join('\n');

test('hire.js: a template-started charter carries every profile section the profile wrote', () => {
  const tpl = fs.readFileSync(path.join(TEMPLATES, 'idea-scout.md'), 'utf8');
  const txt = profile.carryProfile(tpl, PROFILE, hire.setSection);
  assert.match(txt, /## Convictions\n- The edge was in a forum before it was in a paper\./);
  assert.match(txt, /## Will not do\n- Read a textbook to learn basics\./);
  assert.match(txt, /## Counterpart\nThe quant seat kills or tests every card\./);
  assert.match(txt, /## Persona preset\nupbeat/);
  assert.doesNotMatch(txt, /## Model/, 'the interview model line is not a charter section');
  // a section the profile did not write keeps the template's text
  assert.match(txt, /## Blind spots\n<For example/);
});

test('hire.js: a charter with no template gets the profile sections in the template order', () => {
  const block = profile.profileBlock(PROFILE);
  const order = ['Personality', 'Backstory and motivation', 'Voice', 'Persona preset', 'Convictions', 'Will not do', 'Where you look', 'Counterpart'].map(h => block.indexOf('## ' + h + '\n'));
  assert.ok(order.every(i => i >= 0), block);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(!/## Blind spots/.test(block), 'a section the profile left out is not written empty');
});

test('hire.js: the interviewed candidate is told its convictions, refusals, sources and counterpart', () => {
  const lines = profile.interviewLines(PROFILE).join('\n');
  for (const s of ['The edge was in a forum', 'Read a textbook to learn basics', 'comment threads', 'The quant seat kills or tests']) assert.ok(lines.includes(s), s);
  assert.match(fs.readFileSync(path.join(REPO, 'company', 'tools', 'hire.js'), 'utf8'), /\.concat\(profileLib\.interviewLines\(profile\)\)/, 'candidateDocs adds the interview lines');
});

test('dossier.js: the person sections ride the identity; placeholders never do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-sections-selftest-'));
  try {
    const tpl = fs.readFileSync(path.join(TEMPLATES, 'idea-scout.md'), 'utf8').replace(/<!--[\s\S]*?-->\n?/g, '');
    const charter = profile.carryProfile(tpl.replace(/<Name>/g, 'Jo Vega').replace(/<Title>/g, 'Idea Scout'), PROFILE, hire.setSection);
    const file = path.join(dir, 'jo-vega.md'); fs.writeFileSync(file, charter);
    const b = dossier.build('cand-x', { name: 'Jo Vega', title: 'Idea Scout', inbox: 'to-jo-vega.md', role: file }, null);
    assert.match(b.identity, /What you believe, from experience:\n- The edge was in a forum/);
    assert.match(b.identity, /What you refuse to do:\n- Read a textbook to learn basics\./);
    assert.match(b.identity, /Who checks your work, and what needs their sign-off:\nThe quant seat/);
    assert.match(b.identity, /Where you look first for ideas and evidence, and what you skip:\n1\. The venue's comment threads\./);
    assert.ok(!/<For example|<Two to four|<trait seen/.test(b.identity + b.purpose), 'a template placeholder reached the prompt');
    assert.equal(b.personaId, 'upbeat');
    assert.ok(dossier.isPlaceholder(charter, 'Blind spots'));
    assert.ok(!dossier.isPlaceholder(charter, 'Convictions'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dossier.js: a placeholder is dropped but inline angle brackets are kept', () => {
  const ch = '## Backstory and motivation\n<Plausible history fitting this company.>\n\n## Will not do\n<Two to four refusals,\nand why.>\n\n## Success traits\n- <trait seen, with the source number>\n- real (2)\n\n## Handoffs\n- Read `to-<name>.md`.\n';
  assert.equal(dossier.section(ch, 'Backstory'), '');
  assert.equal(dossier.section(ch, 'Will not do'), '');
  assert.equal(dossier.sectionRaw(ch, 'Success traits'), '- real (2)');
  assert.equal(dossier.section(ch, 'Handoffs'), '- Read `to-<name>.md`.');
});

test('every seat template keeps the headings dossier.js reads, and the charter template names the person sections', () => {
  for (const f of fs.readdirSync(TEMPLATES).filter(f => f.endsWith('.md'))) {
    const t = fs.readFileSync(path.join(TEMPLATES, f), 'utf8');
    for (const h of ['Personality', 'Voice', 'Persona preset']) assert.match(t, new RegExp('^## ' + h, 'm'), f + ' lacks ' + h);
  }
  const base = fs.readFileSync(path.join(TEMPLATES, '_charter-template.md'), 'utf8');
  for (const [h] of profile.PERSON) assert.match(base, new RegExp('^## ' + h + '$', 'm'), '_charter-template.md lacks ' + h);
  for (const h of profile.PROFILE_SECTIONS) assert.match(base, new RegExp('^## ' + h, 'm'), '_charter-template.md lacks ' + h);
});

test('archetypes: a profile with no preset takes its archetype\'s; an explicit preset wins; hire.js uses it', () => {
  assert.equal(profile.presetFor('## Archetype\ncombiner\n'), 'warm');
  assert.equal(profile.presetFor('## Archetype\nscout\n\n## Persona preset\nblunt\n'), 'blunt');
  assert.equal(profile.presetFor('## Archetype\nnot-a-kind\n'), '');
  for (const a of Object.values(profile.ARCHETYPES)) assert.ok(profile.PRESETS.includes(a.preset) && a.line.length > 40);
  assert.match(fs.readFileSync(path.join(REPO, 'company', 'tools', 'hire.js'), 'utf8'), /const presetFromProfile = profileLib\.presetFor\(profile\)/);
});

test('archetypes: the seat is told what kind of contributor it is; an eager seat must name a counterpart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-sections-selftest-'));
  try {
    const tpl = fs.readFileSync(path.join(TEMPLATES, 'idea-combiner.md'), 'utf8').replace(/<!--[\s\S]*?-->\n?/g, '');
    const file = path.join(dir, 'kit.md'); fs.writeFileSync(file, tpl.replace(/<Name>/g, 'Kit').replace(/<Title>/g, 'Combiner'));
    const b = dossier.build('cand-y', { name: 'Kit', title: 'Combiner', inbox: 'to-kit.md', role: file }, null);
    assert.match(b.identity, /You are the crew's combiner/);
    assert.equal(b.personaId, 'warm');
    assert.ok(profile.needsCounterpart(tpl), 'the template\'s counterpart is still a placeholder');
    assert.ok(!profile.needsCounterpart(tpl.replace(/## Counterpart\n<[^>]*>/, '## Counterpart\nRohan Iyer tests or kills every card.')));
    assert.ok(!profile.needsCounterpart('## Archetype\ntester\n'), 'a conservative seat needs none');
    assert.match(profile.interviewLines('## Archetype\nscout\n').join('\n'), /crew's scout/);
    assert.match(b.manual, /Studying what any practitioner already knows .* is not work/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('crew mix: a crew of careful seats with nobody proposing is noted, a mixed one is not', () => {
  const careful = profile.crewMix(['dry', 'dry', 'dry', 'dry', 'composed', 'composed', 'composed', 'blunt'].map(p => ({ preset: p, archetype: '' })));
  assert.equal(careful.notes.length, 3, careful.notes.join(' | '));
  const mixed = profile.crewMix([['dry', 'tester'], ['upbeat', 'scout'], ['warm', 'combiner'], ['composed', 'builder'], ['blunt', 'contrarian']].map(([p, a]) => ({ preset: p, archetype: a })));
  assert.deepEqual(mixed.notes, []);
});
