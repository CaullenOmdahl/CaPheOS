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
// the person sections a profile md or a charter may carry; the full profile (company/people/profiles/<seat>.json) adds
// Stake, Temperament, Flaws, Relationships and Example exchanges (wave 3, docs/PROFILES.md)
const PROFILE_SECTIONS = ['Archetype', 'Personality', 'Backstory and motivation', 'Stake', 'Temperament', 'Voice', 'Persona preset'].concat(PERSON.map(x => x[0])).concat(['Flaws', 'Relationships', 'Example exchanges']);
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

/* ================= the full profile (wave 3, docs/PROFILES.md) =================
 * One file per seat: company/people/profiles/<seat id>.json (class F, written only by company/tools/profile.js), its
 * history beside it (<seat>.history.jsonl, hash-chained), the people function's proposals
 * (company/people/profile-proposals.json) and the company's policy (company/people/profile-policy.json, each missing
 * field read from company/defaults/people/profile-policy.json). Everything below is pure apart from the small reads
 * named load*, policy, presets and modelOf.
 *   load(seat, o) / loadAll(o)       the profile (null when there is none) / every profile, by seat
 *   validate(p, o)                   { ok, problems, notes }: the shape, the sliders, the fixed boundaries, the reminder
 *                                    length, the sign-off kinds, the examples (o.examplesAsNotes: fewer than 3 is a note)
 *   canonical(p) / hashOf(p)         the body that is hashed (no hash, version, trial or model block) / its 12-hex sha256
 *   block(p, o)                      the injection block, in a fixed order, with no clock, version or owner notes
 *   reminder(p)                      the <= 200-character reminder that ends a run's prompt
 *   charterSection(p, o) / renderCharter(text, p, o) / fromCharter(md, o)   the charter's person sections, between
 *                                    <!-- profile:begin v=N --> and <!-- profile:end -->, and back
 *   SIGNOFF_KINDS, FIXED_BOUNDARIES, TEMPER_KEYS
 *   familyOf(provider, model) / pairCheck(a, b)   the kind of model a seat runs on; an opposed pair on the same kind
 *   policy(o), presets(o), temperament(o), modelOf(seat, o), wakeStamp(seat, o)
 */
const fs_ = require('fs');
const path_ = require('path');
const crypto_ = require('crypto');
let coMod = null;
const coLib = () => coMod || (coMod = require('./company'));
const FRAMEWORK = path_.resolve(__dirname, '..', '..', '..');
const rootOf = o => path_.resolve((o && o.root) || coLib().ROOT);
const readJ = (f, fb) => { try { return JSON.parse(fs_.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const SEAT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
function paths(o) {
  const r = rootOf(o), J = (...a) => path_.join(r, ...a);
  const dir = J('company', 'people', 'profiles');
  return { root: r, dir, file: s => path_.join(dir, String(s) + '.json'), history: s => path_.join(dir, String(s) + '.history.jsonl'),
    proposals: J('company', 'people', 'profile-proposals.json'), policy: J('company', 'people', 'profile-policy.json'),
    policyDefault: [J('company', 'defaults', 'people', 'profile-policy.json'), path_.join(FRAMEWORK, 'company', 'defaults', 'people', 'profile-policy.json')],
    temperament: [J('company', 'defaults', 'people', 'temperament.json'), path_.join(FRAMEWORK, 'company', 'defaults', 'people', 'temperament.json')],
    presets: [J('company', 'defaults', 'people', 'presets.json'), path_.join(FRAMEWORK, 'company', 'defaults', 'people', 'presets.json')],
    state: J('company', 'state', 'profile-state.json'), modelPolicy: J('company', 'model-policy.json') };
}
const firstOf = (files, fb) => { for (const f of files) { const j = readJ(f, null); if (j) return j; } return fb; };

/* ---------- fixed lists ---------- */
const TEMPER_KEYS = ['risk', 'pace', 'rigour', 'candour', 'independence'];
// what a counterpart's sign-off covers: words for the seat (agent) and for the owner (the console)
const SIGNOFF_KINDS = {
  promote: { words: 'move an idea or card to a test or a build', owner: 'move an idea to a test' },
  commit: { words: 'commit another seat\'s time for more than a day, or money within the company\'s limits', owner: 'commit someone else\'s time' },
  external: { words: 'act outside the company (anything through the external gate)', owner: 'do anything outside the company' },
  merge: { words: 'merge a pull request', owner: 'finish and merge a change' },
  plan: { words: 'start a plan of more than 3 days', owner: 'start a plan longer than three days' },
  trade: { words: 'place an order (where a module defines trading)', owner: 'place a trade' },
};
// the rules no profile can override: always in `boundaries`, never removable (profile.js refuses), read only in the console
const FIXED_BOUNDARIES = [
  { id: 'default-branch', text: 'Never push to a default branch: every change goes through a branch, the pre-merge check and the merge gate.', plain: 'Never changes the main copy of a project directly: every change is checked first.' },
  { id: 'owner-gates', text: 'Owner gates stay the owner\'s: what only the owner can decide goes up your chain of command to the CEO.', plain: 'What only you can decide stays yours.' },
  { id: 'no-self-edit', text: 'Never edit your own profile: the people function proposes changes and the owner decides.', plain: 'Never changes their own profile.' },
  { id: 'code-on-claude', text: 'Code is written only on Claude, never on another model.', plain: 'Code is written only on the company\'s coding setup.' },
];
const FIXED_TEXTS = FIXED_BOUNDARIES.map(b => b.text);
const TEMPER_LEAD = { risk: 'Risk', pace: 'Pace', rigour: 'Thoroughness', candour: 'Candour', independence: 'Independence' };
const LIST_FIELDS = ['convictions', 'willNotDo', 'unprompted', 'whereYouLook', 'flaws', 'strengths', 'blindSpots', 'habits'];
const REMINDER_MAX = 200;   // ~50 tokens at 4 characters a token

/* ---------- reading ---------- */
function load(seat, o) { if (!SEAT_RE.test(String(seat || ''))) return null; const j = readJ(paths(o).file(seat), null); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; }
function loadAll(o) {
  const out = {}; let names = []; try { names = fs_.readdirSync(paths(o).dir); } catch (_) { return out; }
  for (const f of names.sort()) { if (!/\.json$/.test(f)) continue; const s = f.slice(0, -5); const p = load(s, o); if (p && p.seat === s) out[s] = p; }
  return out;
}
const merge1 = (d, c) => { const out = Object.assign({}, d); for (const [k, v] of Object.entries(c || {})) { if (k.startsWith('_')) continue; out[k] = v && typeof v === 'object' && !Array.isArray(v) && d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? Object.assign({}, d[k], v) : v; } return out; };
// the company's policy laid over the framework default one field at a time (a missing file reads the default: inject charter)
function policy(o) {
  const P = paths(o);
  const d = firstOf(P.policyDefault, { inject: 'charter', reminder: true, pov: false, signoff: { mode: 'shadow', holdMaxHours: 24, ceoOverride: true }, trial: { days: 7, minWakes: 10 }, experienceDuty: { everyMin: 240 }, familyCheck: 'note' });
  const c = readJ(P.policy, null);
  const out = merge1(d, c && typeof c === 'object' ? c : {}); delete out._doc;
  if (!['charter', 'profile'].includes(out.inject)) out.inject = 'charter';
  if (!out.signoff || !['off', 'shadow', 'live'].includes(out.signoff.mode)) out.signoff = Object.assign({}, out.signoff || {}, { mode: 'shadow' });
  out.exists = !!c;
  return out;
}
function temperament(o) { const t = firstOf(paths(o).temperament, null); return t && t.sliders ? t : { order: TEMPER_KEYS, sliders: {} }; }
const temperWords = (key, v, T) => { const s = ((T || temperament()).sliders || {})[key]; const n = Number(v); return s && Array.isArray(s.values) && Number.isInteger(n) && n >= 0 && n <= 4 ? s.values[n] : ''; };
function presets(o) {
  const j = firstOf(paths(o).presets, { presets: [] });
  return (Array.isArray(j.presets) ? j.presets : []).filter(x => x && ARCHETYPES[x.archetype]).map(x => Object.assign({}, x, { voicePreset: ARCHETYPES[x.archetype].preset, eager: !!ARCHETYPES[x.archetype].eager, line: ARCHETYPES[x.archetype].line }));
}

/* ---------- canonical body and hash ---------- */
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]); return o; } return v; }
const HASH_SKIP = ['hash', 'version', 'trial', 'model'];
function canonical(p) { const o = {}; for (const [k, v] of Object.entries(p || {})) if (!HASH_SKIP.includes(k)) o[k] = v; return JSON.stringify(sortKeys(o)); }
const hashOf = p => crypto_.createHash('sha256').update(canonical(p)).digest('hex').slice(0, 12);

/* ---------- a blank profile, validation ---------- */
function blank(seat, o) {
  o = o || {};
  return { v: 1, seat: String(seat), version: 1, hash: '', identity: { name: o.name || '', title: o.title || '', archetype: '', personality: '', background: '', stake: '' },
    temperament: { risk: 2, pace: 2, rigour: 2, candour: 2, independence: 2, changesMind: '' },
    convictions: [], willNotDo: [], unprompted: [], whereYouLook: [], flaws: [], strengths: [], blindSpots: [], habits: [], relationships: [],
    voice: { preset: '', toOwner: '', words: '', avoid: [] }, examples: [], reminder: '', counterpart: null, model: null,
    boundaries: FIXED_TEXTS.slice(), experiences: [], ownerNotes: '', trial: null };
}
const isStr = v => typeof v === 'string';
const strArr = v => Array.isArray(v) && v.every(isStr);
function validate(p, o) {
  o = o || {};
  const problems = [], notes = [];
  const bad = m => problems.push(m), note = m => notes.push(m);
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, problems: ['not a profile object'], notes };
  if (p.v !== 1) bad('v must be 1');
  if (!SEAT_RE.test(String(p.seat || ''))) bad('seat must be a seat id');
  if (!Number.isInteger(p.version) || p.version < 1) bad('version must be a whole number from 1');
  const id = p.identity || {};
  if (typeof p.identity !== 'object' || !p.identity) bad('identity is missing');
  for (const k of ['name', 'title', 'archetype', 'personality', 'background', 'stake']) if (id[k] != null && !isStr(id[k])) bad('identity.' + k + ' must be text');
  if (id.archetype && !ARCHETYPES[id.archetype]) bad('identity.archetype "' + id.archetype + '" is not one of ' + Object.keys(ARCHETYPES).join(', '));
  const t = p.temperament || {};
  for (const k of TEMPER_KEYS) if (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > 4) bad('temperament.' + k + ' must be a whole number from 0 to 4');
  if (t.changesMind != null && !isStr(t.changesMind)) bad('temperament.changesMind must be text');
  for (const k of LIST_FIELDS) if (p[k] != null && !strArr(p[k])) bad(k + ' must be a list of lines');
  if (p.relationships != null && !(Array.isArray(p.relationships) && p.relationships.every(r => r && isStr(r.seat) && isStr(r.note)))) bad('relationships must be a list of {seat, note}');
  const v = p.voice || {};
  if (v.preset && !PRESETS.includes(v.preset)) bad('voice.preset must be one of ' + PRESETS.join(', '));
  for (const k of ['toOwner', 'words']) if (v[k] != null && !isStr(v[k])) bad('voice.' + k + ' must be text');
  if (v.avoid != null && !strArr(v.avoid)) bad('voice.avoid must be a list of phrases');
  const ex = Array.isArray(p.examples) ? p.examples : null;
  if (p.examples != null && !(ex && ex.every(e => e && isStr(e.with) && isStr(e.they) && isStr(e.you) && (e.pushback == null || typeof e.pushback === 'boolean')))) bad('examples must be a list of {with, they, you, pushback}');
  else { const n = (ex || []).length, push = (ex || []).some(e => e.pushback === true);
    const m = n < 3 ? 'it has ' + n + ' example exchanges; it needs at least 3' : !push ? 'no example exchange is marked as pushing back' : '';
    if (m) (o.examplesAsNotes ? note : bad)(m); }
  if (p.reminder != null && !isStr(p.reminder)) bad('reminder must be text');
  else if (String(p.reminder || '').trim().length > REMINDER_MAX) bad('the reminder is ' + String(p.reminder).trim().length + ' characters; at most ' + REMINDER_MAX + ' (about 50 tokens)');
  if (p.counterpart != null) {
    const c = p.counterpart;
    if (typeof c !== 'object' || Array.isArray(c)) bad('counterpart must be {seat, signOff, why} or null');
    else {
      if (!SEAT_RE.test(String(c.seat || ''))) bad('counterpart.seat must be a seat id');
      else if (c.seat === p.seat) bad('a seat cannot be its own counterpart');
      if (!Array.isArray(c.signOff) || !c.signOff.every(k => SIGNOFF_KINDS[k])) bad('counterpart.signOff must list kinds from ' + Object.keys(SIGNOFF_KINDS).join(', '));
      if (c.why != null && !isStr(c.why)) bad('counterpart.why must be text');
      if (o.crew && c.seat && !o.crew[c.seat]) bad('the counterpart ' + c.seat + ' is not on the crew');
    }
  }
  if (id.archetype && ARCHETYPES[id.archetype] && ARCHETYPES[id.archetype].eager && !(p.counterpart && p.counterpart.seat)) bad('an eager seat (' + id.archetype + ') needs a counterpart who checks it');
  if (!strArr(p.boundaries || null)) bad('boundaries must be a list of lines');
  else for (const b of FIXED_TEXTS) if (!p.boundaries.includes(b)) bad('a fixed rule is missing from boundaries: "' + b + '"');
  if (p.experiences != null && !(Array.isArray(p.experiences) && p.experiences.every(e => e && isStr(e.at) && isStr(e.text)))) bad('experiences must be a list of {at, text, source, addedBy, version}');
  if (p.ownerNotes != null && !isStr(p.ownerNotes)) bad('ownerNotes must be text');
  if (p.trial != null && !(typeof p.trial === 'object' && Number.isInteger(p.trial.from) && isStr(p.trial.until))) bad('trial must be {from, until, startedBy} or null');
  if (p.hash && p.hash !== hashOf(p)) bad('hash does not match the body (edited by hand?)');
  return { ok: !problems.length, problems, notes };
}

/* ---------- the injection block ---------- */
const nm = (crew, s) => (crew && crew[s] && crew[s].name) || s;
const first = n => String(n || '').trim().split(/\s+/)[0] || String(n || '');
const lines = a => (Array.isArray(a) ? a : []).map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
const bulletList = (lead, a) => { const l = lines(a); return l.length ? lead + '\n' + l.map(x => '- ' + x).join('\n') : ''; };
// the injected block's size (docs/PROFILES.md "Size"): it is carried by every run of the seat
const BLOCK_MAX_CHARS = 6000;   // about 1,500 tokens at 4 characters a token
const BLOCK_CAPS = { experiences: 8, examples: 5, relationships: 8, line: 400 };
const cap = (t, n) => { const x = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return x.length <= n ? x : x.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const kindsWords = (ks, field) => (ks || []).filter(k => SIGNOFF_KINDS[k]).map(k => SIGNOFF_KINDS[k][field || 'words']);
const joinOr = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
// o: { crew (loops.json agents), profiles (every seat's, for "whose work you check"), temperament (defs) }
function block(p, o) {
  o = o || {};
  const crew = o.crew || {}, T = o.temperament || temperament(o), id = p.identity || {};
  const name = id.name || nm(crew, p.seat), me = first(name);
  const arch = id.archetype && ARCHETYPES[id.archetype] ? ARCHETYPES[id.archetype].line : '';
  const out = ['YOUR PROFILE (who you are; it changes only when your profile does)'];
  out.push('You are ' + name + (id.title ? ', ' + id.title : '') + '.' + (arch ? ' ' + arch : ''));
  if (id.personality) out.push('Your personality: ' + id.personality.trim());
  if (id.background) out.push('Where you come from: ' + id.background.trim());
  if (id.stake) out.push('Why you care how this company does: ' + id.stake.trim());
  const tm = p.temperament || {};
  const tl = TEMPER_KEYS.map(k => { const w = temperWords(k, tm[k], T); return w ? '- ' + TEMPER_LEAD[k] + ': ' + w + '.' : ''; }).filter(Boolean);
  if (tl.length) out.push('Your temperament:\n' + tl.join('\n'));
  if (tm.changesMind) out.push('What it takes to change your mind: ' + tm.changesMind.trim());
  for (const [lead, k] of [['What you believe, from experience:', 'convictions'], ['What you refuse to do:', 'willNotDo'], ['What you take care of without being asked:', 'unprompted'], ['Where you look first, and what you skip:', 'whereYouLook']]) { const b = bulletList(lead, p[k]); if (b) out.push(b); }
  const c = p.counterpart;
  if (c && c.seat) {
    const ks = kindsWords(c.signOff);
    out.push('Who checks your work: ' + nm(crew, c.seat) + '.' + (ks.length ? ' Before you ' + joinOr(ks) + ', ' + first(nm(crew, c.seat)) + ' has to agree: write **Needs sign-off:** <' + c.signOff.join('|') + '> on that handoff, and the dispatcher holds it until ' + first(nm(crew, c.seat)) + ' signs off.' : '') + (c.why ? ' Why: ' + c.why.trim() : ''));
  }
  const checks = Object.values(o.profiles || {}).filter(x => x && x.seat !== p.seat && x.counterpart && x.counterpart.seat === p.seat).sort((a, b) => (a.seat < b.seat ? -1 : 1));
  for (const x of checks) {
    const ks = kindsWords(x.counterpart.signOff);
    out.push('Whose work you check: ' + nm(crew, x.seat) + '.' + (ks.length ? ' Before ' + first(nm(crew, x.seat)) + ' can ' + joinOr(ks) + ', you have to agree: answer each sign-off item in your inbox with node company/tools/approvals.js signoff answer <id> --verdict yes|no --check "<what you checked>" --by ' + me + '. Say no with a reason and what would make it a yes.' : ''));
  }
  for (const [lead, k] of [['Your strengths:', 'strengths'], ['Your blind spots:', 'blindSpots'], ['Your habits:', 'habits'], ['Your flaws (they show in your work; know them):', 'flaws']]) { const b = bulletList(lead, p[k]); if (b) out.push(b); }
  const rel = (Array.isArray(p.relationships) ? p.relationships : []).filter(r => r && r.seat && r.note).slice(0, BLOCK_CAPS.relationships);
  if (rel.length) out.push('The people around you:\n' + rel.map(r => '- ' + nm(crew, r.seat) + ': ' + cap(r.note, BLOCK_CAPS.line)).join('\n'));
  // the newest experiences only (the list keeps growing; every run of the seat carries this block)
  const exp = (Array.isArray(p.experiences) ? p.experiences : []).filter(e => e && e.text).slice(-BLOCK_CAPS.experiences);
  const expAt = out.length;
  if (exp.length) out.push(expBlock(exp));
  const v = p.voice || {};
  if (v.words || (v.avoid || []).length) out.push('How you sound: ' + (v.words ? v.words.trim() : '') + ((v.avoid || []).length ? (v.words ? ' ' : '') + 'You never say: ' + lines(v.avoid).map(a => '"' + a + '"').join(', ') + '.' : ''));
  if (v.toOwner) out.push('With the owner: ' + v.toOwner.trim());
  const exAll = (Array.isArray(p.examples) ? p.examples : []).filter(e => e && e.they && e.you);
  // at most BLOCK_CAPS.examples, keeping a pushing-back one
  let ex = exAll.slice(0, BLOCK_CAPS.examples); const pb = exAll.find(e => e.pushback);
  if (pb && !ex.includes(pb)) ex = ex.slice(0, -1).concat([pb]);
  const exLines = e => '- ' + (e.with === 'owner' ? 'The owner' : nm(crew, e.with)) + ': "' + cap(e.they, BLOCK_CAPS.line) + '"\n  You' + (e.pushback ? ' (pushing back)' : '') + ': "' + cap(e.you, BLOCK_CAPS.line) + '"';
  const exAt = out.length;
  if (ex.length) out.push('How you answer, in your own voice:\n' + ex.map(exLines).join('\n'));
  const bnd = lines(p.boundaries);
  if (bnd.length) out.push('Fixed rules (no profile overrides these):\n' + bnd.map(b => '- ' + b).join('\n'));
  // the whole block stays under BLOCK_MAX_CHARS (about 1,500 tokens): the oldest experiences go first, then the examples
  // beyond the pushing-back one; the fixed rules are never cut
  const total = () => out.join('\n\n').length;
  let e2 = exp.slice();
  while (total() > BLOCK_MAX_CHARS && e2.length) { e2 = e2.slice(1); out[expAt] = e2.length ? expBlock(e2) : ''; }
  let x2 = ex.slice();
  while (total() > BLOCK_MAX_CHARS && x2.length > 1) {
    const drop = x2.map((e, i) => i).reverse().find(i => !x2[i].pushback); if (drop == null) break;
    x2.splice(drop, 1); out[exAt] = 'How you answer, in your own voice:\n' + x2.map(exLines).join('\n');
  }
  let txt = out.filter(Boolean).join('\n\n');
  if (txt.length > BLOCK_MAX_CHARS) {
    // still too long (very long lists): cut the middle sections' lines, never the first lines or the fixed rules
    const tail = bnd.length ? '\n\nFixed rules (no profile overrides these):\n' + bnd.map(b => '- ' + b).join('\n') : '';
    const head = txt.slice(0, txt.length - tail.length);
    txt = head.slice(0, Math.max(0, BLOCK_MAX_CHARS - tail.length - 2)).replace(/\n[^\n]*$/, '') + '\n…' + tail;
  }
  return txt;
}
const expBlock = exp => 'What has happened to you here, and what you took from it:\n' + exp.map(e => '- ' + cap(e.text, BLOCK_CAPS.line)).join('\n');
function reminder(p, o) {
  const r = String((p && p.reminder) || '').replace(/\s+/g, ' ').trim();
  if (r) return r.length <= REMINDER_MAX ? r : r.slice(0, REMINDER_MAX - 1).replace(/\s+\S*$/, '') + '…';
  const id = (p && p.identity) || {}, n = first(id.name || nm(o && o.crew, p && p.seat));
  const what = id.archetype ? 'the ' + id.archetype : (id.title ? 'the ' + id.title : 'yourself');
  const c = p && p.counterpart && p.counterpart.seat ? ' ' + first(nm(o && o.crew, p.counterpart.seat)) + ' checks you.' : '';
  return ('You are ' + n + ', ' + what + '. Reply only as ' + n + ', in your own voice.' + c).slice(0, REMINDER_MAX);
}

/* ---------- the charter's person sections ---------- */
const BEGIN_RE = /<!-- profile:begin v=(\d+) -->\n?/, END = '<!-- profile:end -->';
const exLine = (e, crew) => '- With ' + (e.with === 'owner' ? 'the owner' : nm(crew, e.with)) + ': "' + String(e.they).trim() + '" — You: "' + String(e.you).trim() + '"' + (e.pushback ? ' (pushes back)' : '');
function charterSection(p, o) {
  o = o || {};
  const crew = o.crew || {}, T = o.temperament || temperament(o), id = p.identity || {}, tm = p.temperament || {}, v = p.voice || {}, c = p.counterpart;
  const bl = a => lines(a).map(x => '- ' + x).join('\n');
  const S = [
    ['Archetype', id.archetype || ''], ['Personality', id.personality || ''], ['Backstory and motivation', id.background || ''], ['Stake', id.stake || ''],
    ['Temperament', TEMPER_KEYS.map(k => k + ': ' + tm[k] + ' — ' + temperWords(k, tm[k], T)).join('\n') + (tm.changesMind ? '\nchanges mind: ' + tm.changesMind : '')],
    ['Voice', [v.words || '', v.toOwner ? 'With the owner: ' + v.toOwner : '', (v.avoid || []).length ? 'Never says: ' + lines(v.avoid).map(a => '"' + a + '"').join(', ') : ''].filter(Boolean).join('\n')],
    ['Persona preset', v.preset || ''], ['Convictions', bl(p.convictions)], ['Will not do', bl(p.willNotDo)], ['Takes care of unprompted', bl(p.unprompted)], ['Where you look', bl(p.whereYouLook)],
    ['Counterpart', c && c.seat ? nm(crew, c.seat) + (c.why ? ': ' + c.why : '') + '\nSign-off: ' + (c.signOff || []).join(', ') : ''],
    ['Blind spots', bl(p.blindSpots)], ['Signature habits', bl(p.habits)], ['Flaws', bl(p.flaws)],
    ['Relationships', (p.relationships || []).map(r => '- ' + nm(crew, r.seat) + ' — ' + r.note).join('\n')],
    ['Example exchanges', (p.examples || []).map(e => exLine(e, crew)).join('\n')],
  ];
  return S.filter(([, b]) => String(b).trim()).map(([h, b]) => '## ' + h + '\n' + String(b).trim() + '\n').join('\n');
}
// the charter with the profile's sections between the markers. The first render moves the person sections already in
// the charter inside the markers (once); after that only the text between the markers changes.
function renderCharter(text, p, o) {
  const body = '<!-- profile:begin v=' + p.version + ' -->\n' + charterSection(p, o) + END;
  const t = String(text || '');
  const b = t.match(BEGIN_RE), e = t.indexOf(END);
  if (b && e > b.index) { const next = t.slice(0, b.index) + body + t.slice(e + END.length); return { text: next, changed: next !== t }; }
  const secs = t.split(/^(?=## )/m);
  const isPerson = s => { const h = (s.match(/^## ([^\n(]+)/) || [])[1]; return !!h && PROFILE_SECTIONS.some(x => h.trim().toLowerCase().startsWith(x.toLowerCase())); };
  const at = secs.findIndex(isPerson);
  let next;
  if (at < 0) next = t.replace(/\s*$/, '\n\n') + body + '\n';
  else { const kept = secs.filter((s, i) => i < at || !isPerson(s)); kept.splice(at, 0, body + '\n\n'); next = kept.join(''); }
  return { text: next, changed: next !== t };
}
// a hand edit inside the markers: the text there is not what the profile renders
function charterDrift(text, p, o) {
  const t = String(text || ''), b = t.match(BEGIN_RE), e = t.indexOf(END);
  if (!b || e < b.index) return { markers: false, drift: false };
  const inside = t.slice(b.index + b[0].length, e);
  return { markers: true, version: Number(b[1]), drift: inside.trim() !== charterSection(p, o).trim() };
}
const secOf = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\n<!-- profile:end|$)')); return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : ''; };
const PLACE = /^<[A-Za-z][^<>]*\s[^<>]*>$/s;
const realOf = t => { const x = String(t || '').trim(); return PLACE.test(x) || /^<[A-Z][\s\S]*>$/.test(x) ? '' : x; };   // a template placeholder (one <...> block, even with <Name> inside) is not content
// one item per bullet: a line that does not start a bullet (an indented or plain continuation of a wrapped bullet) is joined
// onto the bullet above it; a section with no bullet markers at all reads one item per line, as before
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+/;
const bulletsOf = t => {
  if (!realOf(t)) return [];
  const src = String(t).split('\n'), marked = src.some(l => BULLET_RE.test(l)), out = [];
  for (const raw of src) {
    if (!raw.trim()) continue;
    if (marked && !BULLET_RE.test(raw) && out.length) { out[out.length - 1] = (out[out.length - 1] + ' ' + raw.trim()).replace(/\s+/g, ' '); continue; }
    out.push(raw.replace(BULLET_RE, '').trim());
  }
  return out.filter(l => l && !PLACE.test(l));
};
// the ## Counterpart text read the right way round -> { seat: who checks this seat | null, checks: [seats this one checks] }.
// Only seats on the roster count (a name not hired yet is ignored, never replaced by someone else).
//   "<Name>, the …" / "<Name> tests …" (the section opens with a crew name), "<Name> checks you", "checked by <Name>",
//   "your counterpart is <Name>"            -> <Name> checks this seat
//   "… (the conservative) counterpart of <Name>", "you check <Name>", "<pronoun> checks <Name>'s"  -> this seat checks <Name>
function counterpartOf(text, crew, self) {
  const t = String(text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
  const out = { seat: null, checks: [] };
  if (!t || PLACE.test(t)) return out;
  const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [];
  for (const [sid, c] of Object.entries(crew || {})) { if (sid === self || !c || !c.name) continue; const full = String(c.name).trim(); names.push({ sid, n: full }); const f = full.split(/\s+/)[0]; if (f && f !== full) names.push({ sid, n: f }); }
  names.sort((a, b) => b.n.length - a.n.length);
  const at = (re) => { const m = t.match(re); return m ? m : null; };
  const nameRe = names.length ? '(' + names.map(x => esc(x.n)).join('|') + ')' : null;
  const sidOf = n => { const l = String(n).toLowerCase(); const h = names.find(x => x.n.toLowerCase() === l); return h ? h.sid : null; };
  // this seat checks others
  const checkRes = [/\bcounterpart\s+(?:of|to|for)\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/g, /\b(?:you|she|he|they)\s+checks?\s+([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*)?)/g];
  for (const re of checkRes) for (const m of t.matchAll(re)) {
    const words = m[1].split(/\s+/); let sid = sidOf(words.join(' ')) || sidOf(words[0]);
    if (sid && !out.checks.includes(sid)) out.checks.push(sid);
  }
  if (!nameRe) return out;
  // who checks this seat
  const opens = at(new RegExp('^' + nameRe + '\\b', 'i'));
  const checksYou = at(new RegExp('\\b' + nameRe + '(?:\\s*\\([^)]*\\))?\\s+(?:checks|tests|reviews|signs off)\\s+(?:you|your|him|her|them|' + esc(String((crew[self] || {}).name || '\\0').split(/\s+/)[0]) + ')\\b', 'i'));
  const byName = at(new RegExp('\\b(?:checked|tested|reviewed|signed off)\\s+by\\s+' + nameRe + '\\b', 'i'));
  const isCp = at(new RegExp('\\b(?:your|his|her|their)\\s+counterpart\\s+is\\s+' + nameRe + '\\b', 'i'));
  const handed = at(new RegExp('\\b(?:card|cards|work|idea|ideas)\\b[^.]{0,40}\\b(?:is|are|goes|go)?\\s*(?:handed|sent|given|goes|go)\\s+to\\s+' + nameRe + '\\b', 'i'));
  for (const m of [opens, checksYou, byName, isCp, handed]) { if (!m) continue; const sid = sidOf(m[1]); if (sid && !out.checks.includes(sid)) { out.seat = sid; break; } }
  return out;
}
// a sentence-aware cut: whole sentences up to n characters (never ends on a colon or mid-sentence)
function sentencesUpTo(t, n) {
  const s = String(t || '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s;
  const parts = s.match(/[^.!?]+[.!?]+(?:\s|$)/g) || [];
  let out = ''; for (const p of parts) { if ((out + p).trim().length > n) break; out += p; }
  out = out.trim(); return out || s.slice(0, n - 1).replace(/[\s,;:]+\S*$/, '') + '…';
}
function seatByName(text, crew, self) {
  const t = String(text || '').toLowerCase(); let best = null;
  for (const [sid, c] of Object.entries(crew || {})) {
    if (sid === self || !c || !c.name) continue;
    const full = String(c.name).toLowerCase(), f = full.split(/\s+/)[0];
    const at = [full, f].map(n => { const m = t.match(new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')); return m ? m.index : -1; }).filter(i => i >= 0);
    if (at.length) { const i = Math.min(...at); if (!best || i < best.i) best = { id: sid, i }; }
  }
  return best ? best.id : null;
}
// a profile from a charter or a hire's profile md (migrate, hire.js): every field it can read; the rest empty and listed
function fromCharter(md, o) {
  o = o || {};
  const crew = o.crew || {}, seat = String(o.seat || ''), p = blank(seat, { name: o.name || nm(crew, seat), title: o.title || ((crew[seat] || {}).title) || '' });
  const s = h => realOf(secOf(md, h));
  p.identity.archetype = archetypeOf(md);
  p.identity.personality = s('Personality').replace(/\s+/g, ' ');
  p.identity.background = s('Backstory').replace(/\s+/g, ' ');
  p.identity.stake = s('Stake').replace(/\s+/g, ' ');
  const temp = s('Temperament');
  for (const l of temp.split('\n')) {
    const m = l.match(/^\s*(?:[-*]\s*)?\**([a-z ]+?)\**\s*(?::|—|–|-|=)\s*([0-4])(?:\s*\/\s*4)?\b/i);
    if (m) { const k = m[1].trim().toLowerCase().replace(/^rigor$/, 'rigour'); if (TEMPER_KEYS.includes(k)) p.temperament[k] = Number(m[2]); }
    const cm = l.match(/^\s*changes mind\s*:\s*(.+)$/i); if (cm) p.temperament.changesMind = cm[1].trim();
  }
  if (!temp && p.identity.archetype) { const pr = presets(o).find(x => x.archetype === p.identity.archetype); if (pr) Object.assign(p.temperament, pr.temperament); }
  const voice = s('Voice');
  p.voice.words = voice.split('\n').filter(l => !/^(with the owner|never says):/i.test(l.trim())).join(' ').replace(/\s+/g, ' ').trim();
  const to = voice.match(/^with the owner:\s*(.+)$/im); if (to) p.voice.toOwner = to[1].trim();
  const av = voice.match(/^never says:\s*(.+)$/im); if (av) p.voice.avoid = (av[1].match(/"([^"]+)"/g) || []).map(x => x.slice(1, -1));
  p.voice.preset = presetFor(md);
  p.convictions = bulletsOf(s('Convictions')); p.willNotDo = bulletsOf(s('Will not do')); p.unprompted = bulletsOf(s('Takes care of unprompted'));
  p.whereYouLook = bulletsOf(s('Where you look')); p.blindSpots = bulletsOf(s('Blind spots')); p.habits = bulletsOf(s('Signature habits')); p.flaws = bulletsOf(s('Flaws'));
  p.strengths = bulletsOf(s('Success traits')).filter(x => !/^<|with the source number/.test(x));
  const cp = s('Counterpart');
  let checks = [];
  if (cp) {
    const read = counterpartOf(cp, crew, seat); checks = read.checks;
    const cs = o.counterpart || read.seat;
    const so = cp.match(/^sign-?off:\s*(.+)$/im);
    const kinds = so ? so[1].split(/[\s,]+/).map(x => x.toLowerCase()).filter(k => SIGNOFF_KINDS[k]) : (p.identity.archetype && ARCHETYPES[p.identity.archetype].eager ? ['promote'] : []);
    if (cs) p.counterpart = { seat: cs, signOff: kinds, why: sentencesUpTo(cp.split('\n').filter(l => !/^sign-?off:/i.test(l.trim())).join(' '), 300) };
  }
  p.relationships = bulletsOf(s('Relationships')).map(l => { const sid = seatByName(l, crew, seat); const note = l.replace(/^[^—:-]+[—:-]\s*/, '').trim(); return sid && note ? { seat: sid, note } : null; }).filter(Boolean);
  p.examples = bulletsOf(s('Example exchanges')).map(l => {
    const m = l.match(/^with\s+(.+?):\s*"([^"]+)"\s*[—–-]+\s*you:\s*"([^"]+)"\s*(\(pushes back\))?/i); if (!m) return null;
    const w = /^the owner$|^owner$/i.test(m[1].trim()) ? 'owner' : (seatByName(m[1], crew, seat) || m[1].trim());
    return { with: w, they: m[2].trim(), you: m[3].trim(), pushback: !!m[4] };
  }).filter(Boolean);
  const missing = [];
  for (const [k, ok] of [['identity.background', p.identity.background], ['identity.stake', p.identity.stake], ['convictions', p.convictions.length], ['willNotDo', p.willNotDo.length], ['unprompted', p.unprompted.length],
    ['flaws', p.flaws.length], ['relationships', p.relationships.length], ['examples (at least 3, one pushing back)', p.examples.length >= 3 && p.examples.some(e => e.pushback)], ['temperament', !!temp], ['voice.words', p.voice.words]]) if (!ok) missing.push(k);
  if (p.identity.archetype && ARCHETYPES[p.identity.archetype].eager && !p.counterpart) missing.push('counterpart (an eager seat needs one)');
  return { profile: p, missing, checks, temperFromCharter: !!temp };
}

/* ---------- checks across the crew (profile.js check, migrate) ---------- */
// what one profile alone cannot show: a pairing the wrong way round, two seats checking each other, a checker of many,
// list lines broken in two by a wrapped bullet, and seats whose five sliders are identical.
// -> { failures: [{ seat, text }], notes: [{ seat, text }] }
const BROKEN_END = /\b(?:the|a|an|of|and|or|to|by|in|on|at|for|with|from|than|that|is|are|be|it|its|their|his|her|as)$/i;
function crewChecks(all, o) {
  o = o || {};
  const crew = o.crew || {}, failures = [], notes = [];
  const name = s => nm(crew, s), arch = p => (p && p.identity && ARCHETYPES[p.identity.archetype]) || null;
  const list = Object.values(all || {}).filter(p => p && p.seat);
  for (const p of list) {
    const c = p.counterpart && p.counterpart.seat ? p.counterpart.seat : null;
    if (c) {
      const q = all[c];
      if (q && q.counterpart && q.counterpart.seat === p.seat) failures.push({ seat: p.seat, text: name(p.seat) + ' and ' + name(c) + ' are each named as the other\'s checker: one of the two is the wrong way round' });
      const ap = arch(p), aq = arch(q);
      if (ap && !ap.eager && aq && aq.eager) failures.push({ seat: p.seat, text: name(c) + ' (an eager ' + q.identity.archetype + ') is named as the checker of ' + name(p.seat) + ' (a careful ' + p.identity.archetype + '): the pairing is the wrong way round' });
    }
    const checked = list.filter(x => x.seat !== p.seat && x.counterpart && x.counterpart.seat === p.seat).map(x => x.seat);
    if (checked.length > 2) notes.push({ seat: p.seat, text: name(p.seat) + ' checks ' + checked.length + ' seats (' + checked.map(name).join(', ') + '): is that what you meant?' });
    for (const k of LIST_FIELDS) {
      const a = Array.isArray(p[k]) ? p[k].map(x => String(x || '').trim()) : [];
      for (let i = 0; i < a.length; i++) {
        const prev = i ? a[i - 1] : '';
        if ((i && /^[a-z]/.test(a[i]) && !/[.!?:;)"'”]$/.test(prev)) || BROKEN_END.test(a[i])) { failures.push({ seat: p.seat, text: name(p.seat) + '\'s ' + k + ' has a line broken in two ("' + cap(i && /^[a-z]/.test(a[i]) ? prev : a[i], 60) + '"): join it into one line' }); break; }
      }
    }
  }
  const key = p => TEMPER_KEYS.map(k => (p.temperament || {})[k]).join(',');
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (key(list[i]) === key(list[j])) notes.push({ seat: list[j].seat, text: 'same sliders as ' + name(list[i].seat) + ': ' + name(list[j].seat) + ' and ' + name(list[i].seat) + ' have identical temperaments; give each their own' });
  return { failures, notes };
}

/* ---------- the kind of model, opposed pairs ---------- */
function familyOf(provider, model) {
  const pv = String(provider || '').toLowerCase(), m = String(model || '').toLowerCase();
  if (pv === 'claude-cli' || pv === 'anthropic') return 'anthropic';
  if (pv === 'deepseek') return 'deepseek';
  if (pv === 'custom' || pv === 'minimax') return 'minimax';
  if (pv === 'openrouter') { const v = m.split('/')[0]; return v === 'anthropic' || /claude/.test(v) ? 'anthropic' : v || 'openrouter'; }
  if (/claude/.test(m)) return 'anthropic'; if (/deepseek/.test(m)) return 'deepseek'; if (/minimax|abab/.test(m)) return 'minimax'; if (/gpt|^o\d/.test(m)) return 'openai'; if (/gemini/.test(m)) return 'google';
  return pv || 'unknown';
}
// a = the eager seat, b = its counterpart: { seat, name, provider, model, code }; a code pair is exempt (code stays on Claude)
function pairCheck(a, b) {
  if (!a || !b || !a.provider || !b.provider) return null;
  if (a.code || b.code) return null;
  const fa = familyOf(a.provider, a.model), fb = familyOf(b.provider, b.model);
  if (fa !== fb) return null;
  const A = first(a.name || a.seat), Bn = first(b.name || b.seat);
  return { family: fa, seats: [a.seat, b.seat], text: Bn + ' checks ' + A + ' and both run on the same kind of AI. A different kind tends to argue back better. The crew can change this.', crew: Bn + ' checks ' + A + ' and both run on the same kind of model (' + fa + '): a different one argues back better' };
}
// the seat's model as the chain names it (model-policy.json seats.<id>.chain[0]) and its tier in plain words
function modelOf(seat, o) {
  const pol = readJ(paths(o).modelPolicy, {}) || {};
  const ch = ((pol.seats || {})[seat] || {}).chain;
  const e = Array.isArray(ch) && ch[0] && ch[0].provider ? ch[0] : null;
  if (!e) return null;
  const tier = e.provider === 'claude-cli' ? ((((pol.allowed || {})['claude-cli'] || {}).tiers) || {})[e.model] || null : null;
  const words = tier === 'heavy' || tier === 'top' ? 'the strong setup' : tier === 'standard' ? 'the everyday setup' : 'the cheap setup';
  return { provider: e.provider, model: e.model, effort: e.effort || null, tier, words: 'Runs on: ' + words };
}
// the profile a wake ran under (dispatch.js writes it into wakes.jsonl): { version, hash, trial? } or undefined
function wakeStamp(seat, o) {
  const p = load(seat, o); if (!p || !Number.isInteger(p.version)) return undefined;
  const r = { version: p.version, hash: String(p.hash || hashOf(p)) };
  if (p.trial && Number.isInteger(p.trial.from)) r.trial = { from: p.trial.from, until: String(p.trial.until || '') };
  return r;
}
// what a seat's runs carry from its profile (dossier.js identity, the meeting's seat voice): the block when the company
// injects profiles, else '' (today's charter path)
function voiceFor(seat, o) {
  if (policy(o).inject !== 'profile') return '';
  const p = load(seat, o); if (!p) return '';
  return block(p, { crew: coLib().crew(), profiles: loadAll(o), temperament: temperament(o) });
}
function reminderFor(seat, o) {
  const pol = policy(o); if (pol.inject !== 'profile' || pol.reminder === false) return '';
  const p = load(seat, o); return p ? reminder(p, { crew: coLib().crew() }) : '';
}

module.exports = { PERSON, PROFILE_SECTIONS, PRESETS, ARCHETYPES, carryProfile, profileBlock, interviewLines, archetypeOf, archetypeLine, presetFor, needsCounterpart, crewMix,
  TEMPER_KEYS, SIGNOFF_KINDS, FIXED_BOUNDARIES, FIXED_TEXTS, REMINDER_MAX, BLOCK_MAX_CHARS, BLOCK_CAPS, crewChecks, SEAT_RE, paths, load, loadAll, policy, temperament, temperWords, presets, sortKeys, canonical, hashOf,
  blank, validate, block, reminder, charterSection, renderCharter, charterDrift, fromCharter, seatByName, counterpartOf, bulletsOf, sentencesUpTo, familyOf, pairCheck, modelOf, wakeStamp, voiceFor, reminderFor };
