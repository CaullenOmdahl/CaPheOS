#!/usr/bin/env node
/* dossier.js — keep every agent's StarNet dossier (identity.md, purpose.md, context.md, operating-manual.md) complete
 * and in step with the company's own charters, so nobody has to fill it in by hand.
 *
 * Source of truth: company/roles/<name>.md (scope, out of scope, backstory, what good looks like), company/tools/loops.json
 * (name, title, inbox, manager, role) and company/company.json (company name, owner, mission). Each seat's charter is its
 * loops.json `role` field (a path under company/roles/, or relative to the project root), else company/roles/<name>.md,
 * else company/roles/<id>.md. The headings read are those of company/roles/templates/_charter-template.md.
 * The CEO seat's dossier is only partly built here: the hero's purpose, context and manual double as the owner's
 * profile that rides every agent's prompt, and are written deliberately.
 *
 *   node company/tools/dossier.js check                 # which agents have empty or stock dossier files (exit 1 if any)
 *   node company/tools/dossier.js sync --all            # rebuild every crew dossier from the charters
 *   node company/tools/dossier.js sync --agent <id>     # one agent (hire.js calls this for every new hire)
 *   node company/tools/dossier.js sync --all --if-changed   # only if a charter or loops.json changed since the last sync (daily check)
 *
 * Writes the station save through company/tools/station-crew.js; if a station page is open it is reloaded so it picks
 * the change up instead of pushing its old copy back. Run by: hire.js (new hires), the tools owner's daily tool health check.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./station-crew.js');
const co = require('./lib/company');
const ROOT = co.ROOT;
const LOOPS = co.LOOPS_FILE;
const MARK = '## House rules';   // the start of the generated part of operating-manual.md; anything above it is kept
const companyName = () => co.config.name || 'the company';
const ownerName = () => (co.config.owner && co.config.owner.name) || 'the owner';
const ceoName = () => co.nameOf(co.ceo());
const ceoLabel = () => ceoName() + ' (CEO)';
const peopleOwner = () => co.nameOf(co.seatFor('people'));

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
// A template placeholder still standing in a charter ("<Plausible history.>", "- <trait ...>") is not content: it is
// dropped before anything reaches an agent's prompt. It fills a line (after an optional bullet) and has a space in it,
// so an inline `to-<name>.md` or a bare `<name>` is kept.
const PLACEHOLDER = /(^|\n)[ \t]*(?:[-*][ \t]+|\d+\.[ \t]+)?<[A-Za-z][^<>]*\s[^<>]*>[ \t]*(?=\n|$)/g;
const unplaceheld = b => b.replace(/<!--[\s\S]*?-->/g, '').replace(PLACEHOLDER, '$1').trim();
const isPlaceholder = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return !!m && !!m[1].trim() && !unplaceheld(m[1]); };
const section = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? unplaceheld(m[1]).replace(/\s+/g, ' ') : ''; };
const sectionRaw = (txt, h) => { const m = String(txt).match(new RegExp('## ' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)')); return m ? unplaceheld(m[1]) : ''; };
// The person beyond Personality and Backstory (company/tools/lib/profile.js, shared with hire.js), each under the line
// that introduces it in the seat's identity. A charter without them is still valid; what it has rides every run.
const profileLib = require('./lib/profile');
const { PERSON } = profileLib;
// the archetype's line (what kind of contributor this seat is) first, then each person section under its lead line
const personLines = ch => [profileLib.archetypeLine(ch)].concat(PERSON.map(([h, lead]) => { const b = sectionRaw(ch, h); return b ? lead + ':\n' + b : ''; }));
// the seat's profile block when the company injects profiles (company/people/profile-policy.json inject: profile), else null
function profileFor(id) {
  try {
    if (profileLib.policy().inject !== 'profile') return null;
    const p = profileLib.load(id); if (!p) return null;
    const all = profileLib.loadAll();
    return { block: profileLib.block(p, { crew: co.crew(), profiles: all }), preset: (p.voice || {}).preset || '', voice: String((p.voice || {}).words || '').trim(), version: p.version };
  } catch (_) { return null; }
}
const TIER_RANK = { light: 1, standard: 2, heavy: 3, top: 4 };
// notes for the people function from the profiles (never failures): an opposed pair on the same kind of model (a code pair
// is exempt: code stays on Claude), and a gatekeeper on a lower tier than the seat it checks
function profileNotes(crew) {
  const out = [];
  let all = {}; try { all = profileLib.loadAll(); } catch (_) { return out; }
  const pol = (() => { try { return profileLib.policy(); } catch (_) { return {}; } })();
  const isCode = (s, p) => { try { const TC = require('./lib/taskclass'); if (TC.classOf({ text: '' }, s, { departments: TC.departments({}) }) === 'code') return true; } catch (_) {} return !!(p && p.identity && p.identity.archetype === 'builder'); };
  for (const p of Object.values(all)) {
    const c = p.counterpart; if (!c || !c.seat || !crew[p.seat] || !crew[c.seat]) continue;
    const ma = profileLib.modelOf(p.seat), mb = profileLib.modelOf(c.seat); if (!ma || !mb) continue;
    if (pol.familyCheck !== 'off') { const n = profileLib.pairCheck({ seat: p.seat, name: crew[p.seat].name, provider: ma.provider, model: ma.model, code: isCode(p.seat, p) }, { seat: c.seat, name: crew[c.seat].name, provider: mb.provider, model: mb.model, code: isCode(c.seat, all[c.seat]) }); if (n) out.push({ seats: n.seats, note: n.crew + ': ' + peopleOwner() }); }
    const ra = TIER_RANK[ma.tier] || 0, rb = TIER_RANK[mb.tier] || 0;
    if (rb < ra) out.push({ seats: [p.seat, c.seat], note: crew[c.seat].name + ' checks ' + crew[p.seat].name + ' on a lower tier (' + (mb.tier || 'not Claude') + ' under ' + (ma.tier || 'not Claude') + '): a checker usually needs at least the tier it checks: ' + peopleOwner() });
  }
  return out;
}
const field = (txt, label) => { const m = String(txt).match(new RegExp('\\*\\*' + label + ':\\*\\*\\s*([^\\n]+)')); return m ? m[1].trim() : ''; };
const PERSONAS = ['composed', 'warm', 'blunt', 'dry', 'upbeat'];
// a charter counts as scoped from the market when its Sources list at least three real public listings (URLs)
function scopedFromListings(ch) { return (sectionRaw(ch, 'Sources').match(/https?:\/\/\S+/g) || []).length >= 3; }
// the seat's charter: loops.json `role` (company/roles/<file> or a root-relative path), else roles/<name>.md, else roles/<id>.md
function charterFile(c, id) {
  const roles = co.p('company', 'roles');
  if (c && typeof c.role === 'string' && c.role.trim()) {
    const r = c.role.trim();
    return /[\\/]/.test(r) ? path.resolve(ROOT, r) : path.join(roles, r.endsWith('.md') ? r : r + '.md');
  }
  const byName = c && c.name ? path.join(roles, String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md') : null;
  if (byName && fs.existsSync(byName)) return byName;
  return path.join(roles, String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '.md');
}
function companyLine() {
  const x = co.config;
  return companyName() + (x.industry ? ' (' + x.industry + ')' : '') + ', an AI-run company owned by ' + ownerName();
}

function build(id, c, rec) {
  const name = String((rec && rec.name) || c.name).toUpperCase();
  const display = c.name;
  const chf = charterFile(c, id);
  const ch = fs.existsSync(chf) ? fs.readFileSync(chf, 'utf8') : '';
  const scope = section(ch, 'Scope').replace(/\.$/, '');
  const out = section(ch, 'Out of scope').replace(/\.$/, '');
  const story = section(ch, 'Backstory');
  const good = section(ch, 'What good looks like');
  const personality = section(ch, 'Personality');
  const traits = sectionRaw(ch, 'Success traits');
  const kpis = sectionRaw(ch, 'KPIs');
  const crewAll = (readJson(LOOPS, {}).agents) || {};
  const m = c.manager && crewAll[c.manager];
  const boss = field(ch, 'Reports to') || (m ? (c.manager === co.ceo() ? ceoLabel() : m.name + ' (' + m.title + ')') : null) || ceoLabel();
  // full profiles (docs/PROFILES.md): with the company's policy at inject profile and a profile on file, the person comes
  // from the profile's block (stable: it changes only when the profile does) instead of the charter's sections
  const prof = profileFor(id);
  const identity = [
    'You are ' + name + ', ' + c.title + ' at ' + companyLine() + '. The station calls the owner "Commander". You report to ' + boss + '.',
    ...(prof ? [prof.block] : [
      personality ? 'Your personality: ' + personality : '',
      story ? 'Who you are: ' + story : '',
      ...personLines(ch)]),
    traits ? 'What makes you good at this job:\n' + traits : '',
    'How you work: you own ' + (scope ? scope.replace(/^[A-Z](?=[a-z])/, m => m.toLowerCase()) : 'your area') + '. ' + (out ? 'You hand off ' + out.replace(/^[A-Z]/, m => m.toLowerCase()) + '. ' : '') + 'You decide everything inside your scope yourself, finish what you start, and move work to its owner by handoff. Anything only the owner can decide goes up your chain of command to the CEO, ' + ceoName() + '.',
    'Your workstation on the company\'s StarNet station gives you real tools: files, a terminal, the web and memory. Use them to do the work and to check what is true. If a job needs a tool you do not have, say so plainly. Never claim work you have not verified.',
  ].filter(Boolean).join('\n\n');
  const purpose = [
    c.title + ': ' + (scope || 'see your charter'),
    'You are ' + display + ', ' + c.title + ' at ' + companyName() + '. ' + ceoName() + ' is the CEO.',
    good ? 'What good looks like: ' + good : '',
    kpis ? 'How your work is measured:\n' + kpis : '',
    'Your charter is ' + path.relative(ROOT, chf) + '; your inbox is company/work/handoffs/' + c.inbox + '.',
  ].filter(Boolean).join('\n');
  const context = [
    ownerName() + ' owns ' + companyName() + '. The company is run entirely by AI agents on this StarNet station, with ' + ceoName() + ' as CEO. Company time is ' + co.TZ + '.' + (co.config.mission ? ' Mission: ' + co.config.mission : '') + ' Current priorities are in the CEO\'s plan under company/work/.',
    'The owner wants a company that runs itself: find issues, fix them, finish work and suggest improvements without being asked. Do not take operational questions to the owner; only the CEO writes to the owner, as a person, through the owner channel.',
    'How work moves here: handoffs in company/work/handoffs/ (format in company/HANDOFFS.md), quests on the station that close on evidence, decisions in company/work/decisions.md (written only with company/tools/decision.js add|amend|withdraw), rules in company/DECISION_RIGHTS.md and company/CHAIN_OF_COMMAND.md.',
  ].join('\n\n');
  const rules = MARK + '\n- Read your inbox (company/work/handoffs/' + c.inbox + ') first and work the whole queue, not one item.\n- Close a handoff by changing its own Status line to DONE with the evidence; never leave a finished one OPEN.\n- Quests close on evidence: cite real file paths and commits when you attest.\n- Take every time you write from the date command.\n- Owner gates go up your chain of command to the CEO; never message the owner yourself.\n- Studying what any practitioner already knows (textbooks, course notes, literature reviews, explainers of the basics) is not work. Spend the run on what is specific to this company and the idea or task in front of you; when you need a basic fact, take it in one line and move on.';
  // Soft shutdown (charter section, read by company/tools/halt.js soft): what this seat does when the company soft-halts.
  // A leading <placeholder> paragraph (the template's instructions to the people owner) is not a procedure; drop it.
  let shut = sectionRaw(ch, 'Soft shutdown').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (shut.startsWith('<')) { const k = shut.search(/>\s*(\n|$)/); shut = k >= 0 ? shut.slice(k + 1).trim() : ''; }
  shut = shut.replace(/\s+/g, ' ');
  const rulesAll = rules + '\n- When the company soft-halts (`node company/tools/halt.js status` says soft): ' + (shut || 'start nothing new, finish or park the item in hand, write where it stands in your log, end the session.');
  const prevManual = String((rec && rec.docs && rec.docs.manual) || '');
  const manual = (prevManual.includes(MARK) ? prevManual.slice(0, prevManual.indexOf(MARK)).trimEnd() : prevManual.trim());
  const preset = section(ch, 'Persona preset').toLowerCase().split(/\s+/)[0];
  const voice = section(ch, 'Voice');
  const pPreset = prof && PERSONAS.includes(prof.preset) ? prof.preset : null, pVoice = prof && prof.voice ? prof.voice : null;
  return { identity, purpose, context, manual: (manual ? manual + '\n\n' : '') + rulesAll,
    personaId: pPreset || (PERSONAS.includes(preset) ? preset : null), customVoice: pVoice ? pVoice.slice(0, 600) : voice ? voice.slice(0, 600) : null, scoped: scopedFromListings(ch), profile: prof ? { version: prof.version } : undefined };
}
// The CEO: only identity.md is built here (his purpose, context and manual double as the owner's profile for every agent).
// His researched persona comes first; his CEO standing orders (everything from the marker on) are kept as they are.
const CEO_MARK = 'YOUR STANDING ORDERS AS CEO:';
function buildCeoIdentity(rec) {
  const id = co.ceo(); const seat = co.crew()[id] || {};
  const chf = charterFile(seat, id);
  const ch = fs.existsSync(chf) ? fs.readFileSync(chf, 'utf8') : '';
  if (!scopedFromListings(ch)) return null;   // only a researched charter replaces the hand-written CEO identity
  const prev = String((rec && rec.docs && rec.docs.identity) || '');
  const orders = prev.includes(CEO_MARK) ? prev.slice(prev.indexOf(CEO_MARK)) : '';
  const parts = [
    'You are ' + String((rec && rec.name) || seat.name || 'the CEO').toUpperCase() + ', ' + (seat.title || 'CEO') + ' of ' + companyLine() + '. The station calls the owner "Commander", and so may you.',
    ...(profileFor(id) ? [profileFor(id).block] : [
      section(ch, 'Personality') ? 'Your personality: ' + section(ch, 'Personality') : '',
      section(ch, 'Backstory') ? 'Who you are: ' + section(ch, 'Backstory') : '',
      ...personLines(ch)]),
    sectionRaw(ch, 'Success traits') ? 'What makes you good at this job:\n' + sectionRaw(ch, 'Success traits') : '',
    'You decide, delegate and unblock; a specialist\'s job goes to the seat that owns it. Only you write to the owner, through the owner channel, as one person to another.',
    'Your workstation grants you real tools: reading files, a terminal for the company\'s own tools, and web search. Never claim work you have not checked.',
    orders,
  ];
  const voice = section(ch, 'Voice'), preset = section(ch, 'Persona preset').toLowerCase().split(/\s+/)[0];
  return { identity: parts.filter(Boolean).join('\n\n'), personaId: PERSONAS.includes(preset) ? preset : null, customVoice: voice ? voice.slice(0, 600) : null };
}

const profileOk = id => { try { const p = profileLib.load(id); return !!(p && p.counterpart && p.counterpart.seat); } catch (_) { return false; } };
function problems(id, rec, M) {
  const d = (rec && rec.docs) || {}; const out = [];
  for (const k of ['identity', 'purpose', 'context', 'manual']) if (!String(d[k] || '').trim()) out.push(k + '.md empty');
  try { if (String(d.identity || '') === M.composer.identity(rec.name, rec.role)) out.push('identity.md is the stock StarNet text'); } catch (_) {}
  if (/aboard the STARNET station/.test(String(d.identity || ''))) out.push('identity.md is the stock StarNet text');
  const isCeo = id === co.ceo();
  if (!isCeo && !String(d.manual || '').includes(MARK)) out.push('operating-manual.md has no house rules');
  const crewRow = ((readJson(LOOPS, {}).agents) || {})[id];
  const chf = charterFile(crewRow, id);
  const ch = fs.existsSync(chf) ? fs.readFileSync(chf, 'utf8') : '';
  if (!ch) out.push('no charter at ' + path.relative(ROOT, chf));
  else {
    if (!scopedFromListings(ch)) out.push('charter not yet scoped from real public listings (Sources needs 3+ listing URLs): ' + peopleOwner());
    for (const h of ['Personality', 'Voice', 'Persona preset', 'Success traits', 'KPIs']) if (!section(ch, h)) out.push('charter has no "' + h + '" section: ' + peopleOwner());
    for (const h of ['Personality', 'Backstory'].concat(PERSON.map(x => x[0]))) if (isPlaceholder(ch, h)) out.push('charter section "' + h + '" is still the template placeholder: ' + peopleOwner());
    if (profileLib.needsCounterpart(ch) && !profileOk(id)) out.push('an eager seat (archetype ' + profileLib.archetypeOf(ch) + ') names no ## Counterpart to check it: ' + peopleOwner());
  }
  // the seat's profile (company/people/profiles/<id>.json), when it has one: valid, and an eager one has a counterpart
  try {
    const p = profileLib.load(id);
    if (p) {
      const v = profileLib.validate(p, { crew: (readJson(LOOPS, {}).agents) || {}, examplesAsNotes: true });
      for (const m of v.problems) out.push('profile: ' + m + ': ' + peopleOwner());
    }
  } catch (_) {}
  return [...new Set(out)];
}

async function main() {
  const a = process.argv.slice(2); const cmd = a[0] || 'check';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  const crew = (readJson(LOOPS, {}).agents) || {};
  const { doc } = await C.getSave();
  const rows = C.rows(doc);
  const M = C.appModules();
  if (cmd === 'check') {
    const report = [];
    for (const [id, rec] of rows) { if (!crew[id]) continue; const p = problems(id, rec, M); if (p.length) report.push({ agent: id, name: rec.name, problems: p }); }
    // the crew's temperament mix: notes for the people owner, never a failure
    const mix = profileLib.crewMix(Object.keys(crew).map(id => { const f = charterFile(crew[id], id); const ch = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; return { preset: profileLib.presetFor(ch), archetype: profileLib.archetypeOf(ch) }; }));
    const profiles = profileNotes(crew);   // notes for the people function, never a failure
    console.log(JSON.stringify({ ok: !report.length, incomplete: report, crew: mix, profileNotes: profiles.length ? profiles : undefined }, null, 1));
    process.exit(report.length ? 1 : 0);
  }
  if (cmd === 'sync') {
    const STAMP = path.join(ROOT, 'company', 'state', 'dossier-sync.json');
    if (opt('if-changed')) {
      const last = Number((readJson(STAMP, {}) || {}).at || 0);
      const dir = path.join(ROOT, 'company', 'roles');
      const pdir = path.join(ROOT, 'company', 'people', 'profiles');   // a profile change counts too (inject profile)
      const pm = (() => { try { return fs.readdirSync(pdir).filter(f => /\.json$/.test(f)).map(f => fs.statSync(path.join(pdir, f)).mtimeMs); } catch (_) { return []; } })();
      const newest = Math.max(fs.statSync(LOOPS).mtimeMs, ...fs.readdirSync(dir).map(f => fs.statSync(path.join(dir, f)).mtimeMs), ...pm);
      if (newest <= last) { console.log(JSON.stringify({ ok: true, skipped: 'no charter or crew change since the last sync' })); return; }
    }
    const ids = opt('all') ? Object.keys(crew) : [String(opt('agent') || '')].filter(Boolean);
    if (!ids.length) throw new Error('--agent <id> or --all');
    const done = [];
    await C.editSave(d => {
      for (const id of ids) {
        if (id === co.ceo()) {   // the CEO: identity (and voice) only, and only from a researched charter
          for (const h of [d.agent].filter(x => x && x.id === id).concat((d.agents || []).filter(x => x && x.id === id))) {
            const b = buildCeoIdentity(h); if (!b) continue;
            h.docs = Object.assign({}, h.docs || {}, { identity: b.identity });
            if (b.personaId) h.personaId = b.personaId;
            if (b.customVoice) h.customVoice = b.customVoice;
            done.push(id);
          }
          continue;
        }
        if (!crew[id]) continue;
        for (const rec of (d.agents || []).filter(x => x && x.id === id)) {
          const b = build(id, crew[id], rec);
          rec.docs = Object.assign({}, rec.docs || {}, { identity: b.identity, purpose: b.purpose, context: b.context, manual: b.manual });
          rec.purpose = b.purpose.slice(0, 2000);
          if (b.personaId) rec.personaId = b.personaId;
          if (b.customVoice) rec.customVoice = b.customVoice;
          done.push(id);
        }
      }
      if (!done.length) return false;
    }, 'dossier-sync');
    let pageOpen = false; const synced = [];
    const { doc: fresh } = await C.getSave();
    for (const id of new Set(done.concat([co.ceo()]))) {
      try { synced.push((await C.syncPrompt(id, fresh)).agentId); } catch (e) { if (/via:page/.test(e.message)) pageOpen = true; else synced.push(id + ': ' + e.message.slice(0, 80)); }
    }
    const reloaded = pageOpen ? await C.reloadStationPage() : null;
    if (opt('all')) { fs.mkdirSync(path.dirname(STAMP), { recursive: true }); fs.writeFileSync(STAMP, JSON.stringify({ at: Date.now() }) + '\n'); }
    console.log(JSON.stringify({ ok: true, updated: [...new Set(done)], prompts: pageOpen ? (reloaded === 'reloaded' ? 'station page was open; reloaded so it recomposes them' : reloaded === 'busy' ? 'station page is open with a conversation in progress; it recomposes on its next reload' : 'station page is open and could not be reloaded') : synced }, null, 1));
    return;
  }
  throw new Error('commands: check, sync');
}
module.exports = { build, charterFile, section, sectionRaw, isPlaceholder, problems, profileNotes, profileFor, PERSON };
if (require.main === module) main().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(2); });
