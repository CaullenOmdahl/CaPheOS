/* lib/profile.js — the person in a seat's charter, one list read by hire.js and dossier.js.
 *
 * A profile (company/hiring/<round>/profiles/<name>.md) and a charter (company/roles/<name>.md) share the headings of
 * company/roles/templates/_charter-template.md. PROFILE_SECTIONS is every heading that describes the person; hire.js
 * carries each one a profile wrote into the hire's charter, and dossier.js injects PERSON (the sections after the
 * Backstory) into the seat's identity, each under its lead line. A section a charter does not have is simply absent.
 *
 * ARCHETYPES (the "## Archetype" section, one id) say what kind of contributor a seat is. Before them every hire was
 * written from job listings and came out careful, dry and analytical: a crew of testers with nobody to give them
 * ideas (CaPheOS Sandbox 2026-11-19: 8 seats, presets dry x4 / composed x3 / blunt x1, no seat that generates ideas,
 * 42M tokens on papers and 0 reads of the forums and channels where traders actually talk). An eager archetype
 * (scout, combiner, contrarian) generates and must name a conservative counterpart; a conservative one (tester,
 * steward) checks; the archetype also gives the persona preset when a profile names none.
 * Owner of this file: the tools function holder.
 */
'use strict';
const PERSON = [
  ['Convictions', 'What you believe, from experience'],
  ['Will not do', 'What you refuse to do'],
  ['Takes care of unprompted', 'What you take care of without being asked'],
  ['Where you look', 'Where you look first for ideas and evidence, and what you skip'],
  ['Counterpart', 'Who checks your work, and what needs their sign-off'],
  ['Blind spots', 'Your known blind spots'],
  ['Signature habits', 'Your habits'],
];
const PROFILE_SECTIONS = ['Archetype', 'Personality', 'Backstory and motivation', 'Voice', 'Persona preset'].concat(PERSON.map(x => x[0]));
const PRESETS = ['composed', 'warm', 'blunt', 'dry', 'upbeat'];
// id -> eager (generates, needs a counterpart) or not, the preset it defaults to, and the line the seat is told
const ARCHETYPES = {
  scout: { eager: true, preset: 'upbeat', line: 'You are the crew\'s scout: you find ideas where practitioners and crowds actually talk, and write each one as a card that is cheap to test. Range and speed over polish; most of your cards should die, and that is the job working.' },
  combiner: { eager: true, preset: 'warm', line: 'You are the crew\'s combiner: you join ideas from places that never meet into small, specific, boutique angles the big players ignore. A combination is worth a card when you can say what joins the two halves and how to test it cheaply.' },
  contrarian: { eager: true, preset: 'blunt', line: 'You are the crew\'s contrarian: you look for where the crowd\'s story is wrong and what it costs the people who believe it, and you argue the other side out loud. You argue; your counterpart decides with a test.' },
  tester: { eager: false, preset: 'dry', line: 'You are a tester: you turn other people\'s ideas into the cheapest test that could kill them and give a verdict fast (kill, keep, or test bigger). You keep your rigour for the test, not for study: you do not learn basics from textbooks, you measure.' },
  builder: { eager: false, preset: 'composed', line: 'You are a builder: you make the things the company runs on, small and provable, and you say plainly what they do not do yet.' },
  steward: { eager: false, preset: 'dry', line: 'You are a steward: you guard what the company cannot afford to lose (money, access, the record), and you say no with a reason and a way to yes.' },
  connector: { eager: false, preset: 'warm', line: 'You are a connector: you keep people, handoffs and the floor moving, and you notice who is stuck before they say so.' },
  lead: { eager: false, preset: 'composed', line: 'You lead: you decide with partial information, write the decision down, and give each seat room to own its work.' },
};
// the sections a candidate is told about themselves in an interview, beyond Personality, Backstory and Voice
const INTERVIEW = ['Convictions', 'Will not do', 'Where you look', 'Counterpart'];
// the archetype a profile or charter names ('' when none or unknown)
const archetypeOf = txt => { const a = sec(txt, 'Archetype').toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] || ''; return ARCHETYPES[a] ? a : ''; };
// the line that tells a seat its archetype ('' when none)
const archetypeLine = txt => { const a = archetypeOf(txt); return a ? ARCHETYPES[a].line : ''; };
// the persona preset: the profile's own, else its archetype's, else '' (the caller's default)
function presetFor(txt) {
  const p = sec(txt, 'Persona preset').toLowerCase().split(/\s+/)[0];
  if (PRESETS.includes(p)) return p;
  const a = archetypeOf(txt); return a ? ARCHETYPES[a].preset : '';
}
// an eager seat with no counterpart is a problem for its charter (the eager seat is gated by a conservative one)
const needsCounterpart = txt => { const a = archetypeOf(txt); return !!a && ARCHETYPES[a].eager && !sec(txt, 'Counterpart').replace(/<[^>]*>/g, '').trim(); };
// the crew's temperament mix, from each seat's {preset, archetype}: notes (never a failure) when it is all one kind
function crewMix(seats) {
  const n = seats.length, notes = [], count = {};
  for (const s of seats) count[s.preset || 'none'] = (count[s.preset || 'none'] || 0) + 1;
  if (n >= 4) {
    const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / n >= 0.5) notes.push(top[1] + ' of ' + n + ' seats share the "' + top[0] + '" preset: hire for a different temperament next');
    if (!seats.some(s => s.archetype && ARCHETYPES[s.archetype].eager)) notes.push('no seat generates ideas (archetype scout, combiner or contrarian): every seat checks, nobody proposes');
    if (!(count.warm || count.upbeat)) notes.push('no warm or upbeat seat');
  }
  return { presets: count, notes };
}

const sec = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''; };
const lead = h => (PERSON.find(x => x[0] === h) || [h, h])[1];

// a template-started charter: every section the profile wrote replaces (or is added after) the template's;
// setSection(txt, heading, body) is the caller's (hire.js)
function carryProfile(txt, prof, setSection) { for (const h of PROFILE_SECTIONS) if (sec(prof, h)) txt = setSection(txt, h, sec(prof, h)); return txt; }
// a charter with no template: the profile's sections in the template's order, none written empty
function profileBlock(prof) { return PROFILE_SECTIONS.map(h => sec(prof, h) ? '## ' + h + '\n' + sec(prof, h) + '\n\n' : '').join(''); }
// the lines added to a candidate's interview identity
function interviewLines(prof) { return [archetypeLine(prof)].concat(INTERVIEW.map(h => sec(prof, h) ? lead(h) + ': ' + sec(prof, h) : '')).filter(Boolean); }

module.exports = { PERSON, PROFILE_SECTIONS, PRESETS, ARCHETYPES, carryProfile, profileBlock, interviewLines, archetypeOf, archetypeLine, presetFor, needsCounterpart, crewMix };
