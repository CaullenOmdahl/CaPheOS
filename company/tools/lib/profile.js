/* lib/profile.js — the person in a seat's charter, one list read by hire.js and dossier.js.
 *
 * A profile (company/hiring/<round>/profiles/<name>.md) and a charter (company/roles/<name>.md) share the headings of
 * company/roles/templates/_charter-template.md. PROFILE_SECTIONS is every heading that describes the person; hire.js
 * carries each one a profile wrote into the hire's charter, and dossier.js injects PERSON (the sections after the
 * Backstory) into the seat's identity, each under its lead line. A section a charter does not have is simply absent.
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
const PROFILE_SECTIONS = ['Personality', 'Backstory and motivation', 'Voice', 'Persona preset'].concat(PERSON.map(x => x[0]));
// the sections a candidate is told about themselves in an interview, beyond Personality, Backstory and Voice
const INTERVIEW = ['Convictions', 'Will not do', 'Where you look', 'Counterpart'];

const sec = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''; };
const lead = h => (PERSON.find(x => x[0] === h) || [h, h])[1];

// a template-started charter: every section the profile wrote replaces (or is added after) the template's;
// setSection(txt, heading, body) is the caller's (hire.js)
function carryProfile(txt, prof, setSection) { for (const h of PROFILE_SECTIONS) if (sec(prof, h)) txt = setSection(txt, h, sec(prof, h)); return txt; }
// a charter with no template: the profile's sections in the template's order, none written empty
function profileBlock(prof) { return PROFILE_SECTIONS.map(h => sec(prof, h) ? '## ' + h + '\n' + sec(prof, h) + '\n\n' : '').join(''); }
// the lines added to a candidate's interview identity
function interviewLines(prof) { return INTERVIEW.map(h => sec(prof, h) ? lead(h) + ': ' + sec(prof, h) : '').filter(Boolean); }

module.exports = { PERSON, PROFILE_SECTIONS, carryProfile, profileBlock, interviewLines };
