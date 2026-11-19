'use strict';
/* lib/signoff.js — a counterpart's sign-off, enforced (docs/PROFILES.md "Sign-off"; the owner's 2026-11-18 rule: an eager
 * seat is gated by a conservative one, and the gate is the dispatcher's, not a line in a charter).
 *
 * An eager seat's profile names its counterpart and the kinds of decision that need the counterpart's yes
 * (counterpart.signOff, lib/profile.js SIGNOFF_KINDS). A handoff that seat writes carrying `**Needs sign-off:** <kind>`,
 * or one whose text reads as a kind its profile lists (KIND_CUES), is held for its receiver, like `**Waiting on:**`,
 * until the counterpart answers yes. Records are crew-only: they never become owner questions and never reach Today.
 *
 *   const SO = require('./lib/signoff');
 *   SO.needs(seat, kind, o)           the counterpart whose yes `seat` needs for `kind`, or null
 *   SO.records(o)                     Map id -> { id, ask, answers, override, status: open | yes | no | overridden }
 *   SO.pending(ref, o) / SO.cleared(ref, o, kind?)   an open ask for ref / a yes (or a CEO override) for ref
 *   SO.holdFor(block, seat, o)        pure: { hold, kind, counterpart, id, status } for one block written by `seat`
 *                                     (o.profile: seat's profile, o.records, o.ref)
 *   SO.ask(o) / SO.answer(o) / SO.override(o)   the record rows (approvals.js signoff ask|answer|override calls these)
 *   SO.scanTick(o)                    the dispatcher's step (dispatch.js, once a tick): opens one sign-off item in the
 *                                     counterpart's inbox per held block, writes the would-holds in shadow, tells the
 *                                     counterpart's manager once after holdMaxHours; returns (inbox, item) -> hold | null
 *   SO.gate({seat, kind, refs}, o)    external-gate.js and merge-gate.js: { needed, cleared, refuse?, would? }
 * Files: company/state/signoffs.jsonl (class A, append only: ask, answer and override rows, each recorded with
 * provenance), company/state/signoff-state.json (the dispatcher's memory: what it logged and told), and
 * company/state/signoff-gates.jsonl (the gates' would-refuse rows in shadow; a measurement, not locked).
 * Mode: company/people/profile-policy.json signoff.mode (off | shadow | live; absent reads shadow: nothing is held).
 * Owner: the people function (the records) and the tools function (this file).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const P = require('./profile');

const WRITER = 'approvals.js';   // the records' one writer (approvals.js signoff, and the dispatcher's asks through here)
const HOUR = 3600e3;
const rootOf = o => path.resolve((o && o.root) || co.ROOT);
const files = o => { const r = rootOf(o); return { log: path.join(r, 'company', 'state', 'signoffs.jsonl'), state: path.join(r, 'company', 'state', 'signoff-state.json'), gates: path.join(r, 'company', 'state', 'signoff-gates.jsonl'), handoffs: path.join(r, 'company', 'work', 'handoffs') }; };
const readJ = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const clean = (t, n) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 300);
const crewOf = o => (o && o.crew) || co.crew();
const nameOf = (crew, s) => (crew[s] && crew[s].name) || s;
const firstName = n => String(n || '').split(/\s+/)[0];

/* ---------- refs ---------- */
// one form per ref: a PR as pr:<owner>/<repo>#<n> (a GitHub URL reads the same), anything else trimmed
function normRef(ref) {
  const r = String(ref || '').trim();
  const m = r.match(/^(?:pr:)?(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)\/?$/i);
  return m ? 'pr:' + m[1].toLowerCase() + '#' + m[2] : r.slice(0, 300);
}
const itemRef = (inbox, it) => { const id = require('./wakes').itemId(inbox, it.heading, it.id); return id.includes('#') ? id : inbox + '#' + id; };

/* ---------- the records ---------- */
function rows(o) {
  let t = ''; try { t = require('./bounded').tailText(files(o).log, 8 << 20); } catch (_) { try { t = fs.readFileSync(files(o).log, 'utf8'); } catch (__) { t = ''; } }
  const out = []; for (const l of t.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.id && r.op) out.push(r); } catch (_) {} } return out;
}
function records(o) {
  const m = new Map();
  for (const r of (o && o.rows) || rows(o)) {
    if (r.op === 'ask') { if (!m.has(r.id)) m.set(r.id, { id: r.id, ask: r, answers: [], override: null, status: 'open' }); continue; }
    const x = m.get(r.id); if (!x) continue;
    if (r.op === 'answer') { x.answers.push(r); if (x.status !== 'overridden') x.status = r.verdict === 'yes' ? 'yes' : 'no'; }
    else if (r.op === 'override') { x.override = r; x.status = 'overridden'; }
  }
  return m;
}
const latestFor = (recs, ref, kind) => { let best = null; for (const x of recs.values()) if (x.ask.ref === ref && (!kind || x.ask.kind === kind)) if (!best || String(x.ask.at) >= String(best.ask.at)) best = x; return best; };
function pending(ref, o) { const x = latestFor((o && o.records) || records(o), normRef(ref), o && o.kind); return !!x && (x.status === 'open' || x.status === 'no'); }
function cleared(ref, o, kind) { const x = latestFor((o && o.records) || records(o), normRef(ref), kind || (o && o.kind)); return !!x && (x.status === 'yes' || x.status === 'overridden'); }
function needs(seat, kind, o) {
  const p = (o && o.profile) || P.load(seat, o);
  const c = p && p.counterpart;
  return c && c.seat && c.seat !== seat && Array.isArray(c.signOff) && c.signOff.includes(kind) ? c.seat : null;
}
function append(row, o) {
  const f = files(o).log; const line = JSON.stringify(row) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line);
  try { require('../provenance.js').appended(f, line, WRITER, { root: rootOf(o) }); } catch (_) {}
  return row;
}
const newId = () => 'so-' + crypto.randomBytes(4).toString('hex');
const at = o => new Date(Number.isFinite(o && o.now) ? o.now : Date.now()).toISOString();

/* ---------- the block check (pure) ---------- */
// the kinds a block can read as without an explicit line: only the unmistakable ones (a handoff that promotes a card to a
// test or a build; one that asks for a PR to be merged). Everything else needs **Needs sign-off:**.
const KIND_CUES = {
  promote: /\b(?:promot(?:e|es|ing)\s+(?:this|the|my)?\s*(?:idea|card)|move\s+(?:this|the|my)\s+(?:idea|card)\s+(?:to|into)\s+(?:a\s+)?(?:test|build))\b/i,
  merge: /\b(?:gh pr merge|merge\s+(?:this|the|my)\s+(?:PR|pull request))\b/i,
};
const explicitKinds = block => { const m = String(block || '').match(/^\*\*Needs sign-off:\*\*\s*(.+)$/mi); return m ? m[1].split(/[\s,;|]+/).map(x => x.replace(/[`*<>]/g, '').toLowerCase()).filter(k => P.SIGNOFF_KINDS[k]) : []; };
function holdFor(block, seat, o) {
  o = o || {};
  const prof = o.profile; const c = prof && prof.counterpart;
  if (!c || !c.seat || !Array.isArray(c.signOff) || !c.signOff.length || c.seat === seat) return { hold: false };
  const ex = explicitKinds(block);
  const kind = ex.find(k => c.signOff.includes(k)) || (ex.length ? null : Object.keys(KIND_CUES).find(k => c.signOff.includes(k) && KIND_CUES[k].test(String(block || ''))));
  if (!kind) return { hold: false };
  const rec = o.ref && o.records ? latestFor(o.records, normRef(o.ref), kind) : null;
  if (rec && (rec.status === 'yes' || rec.status === 'overridden')) return { hold: false, cleared: true, kind, counterpart: c.seat, id: rec.id, status: rec.status };
  return { hold: true, kind, counterpart: c.seat, id: rec ? rec.id : null, status: rec ? rec.status : 'none' };
}

/* ---------- the record commands (approvals.js signoff …) ---------- */
class Refusal extends Error { constructor(msg, code) { super(msg); this.code = code || 2; } }
function ask(a, o) {
  o = o || {};
  const crew = crewOf(o), from = String(a.from || ''), kind = String(a.kind || '').toLowerCase(), ref = normRef(a.ref);
  if (!crew[from]) throw new Refusal('--by must be a crew seat');
  if (!P.SIGNOFF_KINDS[kind]) throw new Refusal('--kind must be one of ' + Object.keys(P.SIGNOFF_KINDS).join(', '));
  if (!ref) throw new Refusal('--ref names what is signed off: <inbox>#<item id>, pr:<owner>/<repo>#<n>, or ext:<target>');
  const cp = needs(from, kind, o);
  if (!cp) throw new Refusal(nameOf(crew, from) + '\'s profile names no counterpart who signs off "' + kind + '", so nothing is needed');
  const recs = records(o), have = latestFor(recs, ref, kind);
  if (have && have.status !== 'no') return { ok: true, id: have.id, duplicate: true, status: have.status, counterpart: cp };
  const row = append({ at: at(o), op: 'ask', id: newId(), from, counterpart: cp, kind, ref, digest: clean(a.digest, 120) || null, why: clean(a.why, 400) || null, via: a.via || 'approvals.js' }, o);
  return { ok: true, id: row.id, counterpart: cp, kind, ref };
}
function answer(a, o) {
  o = o || {};
  const crew = crewOf(o), by = String(a.by || ''), x = records(o).get(String(a.id || ''));
  if (!x) throw new Refusal('no sign-off ' + a.id);
  if (by === x.ask.from) throw new Refusal('the seat that asked cannot sign off its own request; ' + nameOf(crew, x.ask.counterpart) + ' answers it');
  if (by !== x.ask.counterpart) throw new Refusal('only ' + nameOf(crew, x.ask.counterpart) + ' (the counterpart named in ' + nameOf(crew, x.ask.from) + '\'s profile) answers this sign-off');
  if (x.status === 'overridden') throw new Refusal('the CEO already overrode this sign-off');
  const verdict = String(a.verdict || '').toLowerCase(); if (!['yes', 'no'].includes(verdict)) throw new Refusal('--verdict yes|no');
  const check = clean(a.check, 300); if (!check) throw new Refusal('--check "<what you checked>" is required');
  const reasons = clean(a.reasons, 600) || null;
  if (verdict === 'no' && !reasons) throw new Refusal('a no needs --reasons "<why, and what would make it a yes>"');
  append({ at: at(o), op: 'answer', id: x.id, by, verdict, check, reasons }, o);
  closeItem(x.id, 'answered ' + verdict + ' by ' + nameOf(crew, by) + ': ' + check, o);
  if (verdict === 'no') tellAsker(x, by, check, reasons, o);
  return { ok: true, id: x.id, verdict, ref: x.ask.ref, next: verdict === 'yes' ? 'the held handoff is released on the next dispatcher tick' : nameOf(crew, x.ask.from) + ' has the reasons in their inbox; the handoff stays held' };
}
function override(a, o) {
  o = o || {};
  const crew = crewOf(o), by = String(a.by || ''), x = records(o).get(String(a.id || ''));
  if (!x) throw new Refusal('no sign-off ' + a.id);
  const ceo = o.ceo || co.ceo();
  if (by !== ceo) throw new Refusal('only the CEO overrides a sign-off');
  if (P.policy(o).signoff.ceoOverride === false) throw new Refusal('this company\'s profile policy does not let the CEO override a sign-off');
  const why = clean(a.why, 400); if (why.length < 8) throw new Refusal('--why "<why the CEO overrides it>" is required');
  append({ at: at(o), op: 'override', id: x.id, by, why }, o);
  closeItem(x.id, 'overridden by ' + nameOf(crew, by) + ' (CEO): ' + why, o);
  return { ok: true, id: x.id, overridden: true, ref: x.ask.ref };
}
function list(o) {
  return [...records(o).values()].filter(x => !(o && o.open) || x.status === 'open' || x.status === 'no')
    .sort((a, b) => String(b.ask.at).localeCompare(String(a.ask.at))).slice(0, 200)
    .map(x => ({ id: x.id, status: x.status, from: x.ask.from, counterpart: x.ask.counterpart, kind: x.ask.kind, ref: x.ask.ref, at: x.ask.at, answeredAt: (x.answers[x.answers.length - 1] || {}).at || null, override: x.override ? { by: x.override.by, why: x.override.why } : null }));
}

/* ---------- inbox side effects ---------- */
const stamp = o => { const lp = co.localParts(new Date(Number.isFinite(o && o.now) ? o.now : Date.now())); return lp.date; };
function appendBlock(inbox, heading, fields, o) {
  if (!inbox) return null;
  const f = path.join(files(o).handoffs, inbox);
  const block = '\n## ' + stamp(o) + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + v).join('\n') + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, '# Handoffs\n');
  fs.appendFileSync(f, block);
  return heading;
}
// the counterpart's sign-off item: its Status line set DONE once the sign-off is answered or overridden
function closeItem(id, why, o) {
  const crew = crewOf(o);
  for (const c of Object.values(crew)) {
    if (!c || !c.inbox) continue;
    const f = path.join(files(o).handoffs, c.inbox); let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    if (!t.includes('**Sign-off:** ' + id)) continue;
    const secs = t.split(/^(?=## )/m); let changed = false;
    const out = secs.map(s => { if (!s.includes('**Sign-off:** ' + id) || !/^\*\*Status:\*\*\s*OPEN/m.test(s)) return s; changed = true; return s.replace(/^\*\*Status:\*\*\s*OPEN.*$/m, '**Status:** DONE — ' + clean(why, 200)); });
    if (changed) { const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, out.join('')); fs.renameSync(tmp, f); }
  }
}
function tellAsker(x, by, check, reasons, o) {
  const crew = crewOf(o), a = crew[x.ask.from];
  appendBlock(a && a.inbox, 'sign-off: ' + firstName(nameOf(crew, by)) + ' said no (' + x.ask.kind + ')', {
    'Sign-off': x.id,
    Need: firstName(nameOf(crew, by)) + ' did not sign off ' + x.ask.ref + ': ' + (reasons || 'no reason given') + ' (checked: ' + check + '). Change the work to meet that, then ask again with node company/tools/approvals.js signoff ask --kind ' + x.ask.kind + ' --ref ' + x.ask.ref + ' --by ' + nameOf(crew, x.ask.from) + ', or drop it. The handoff stays held until a yes.',
    Status: 'OPEN' }, o);
}

/* ---------- the dispatcher's step ---------- */
function writerOf(heading, crew) {
  const m = String(heading || '').match(/\bfrom\s+(.+?)\s+[—–-]\s/); if (!m) return null;
  const n = m[1].trim().toLowerCase();
  return Object.keys(crew).find(id => String((crew[id] || {}).name || '').toLowerCase() === n) || Object.keys(crew).find(id => firstName(String((crew[id] || {}).name || '')).toLowerCase() === n) || null;
}
function scanTick(o) {
  o = o || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const pol = P.policy(o), mode = pol.signoff.mode;
  if (mode === 'off') return () => null;
  const crew = crewOf(o), profiles = P.loadAll(o);
  const eager = Object.values(profiles).filter(p => p.counterpart && p.counterpart.seat && (p.counterpart.signOff || []).length && crew[p.seat]);
  if (!eager.length) return () => null;
  const F = files(o), now = Number.isFinite(o.now) ? o.now : Date.now();
  const st = readJ(F.state, null) || {}; st.would = st.would || {}; st.held = st.held || {}; st.told = st.told || {}; st.items = st.items || {}; st.counts = st.counts || { wouldHold: 0, held: 0 };
  let recs = records(o); const holds = new Map(); let dirty = false;
  const SP = require('./sprint');
  for (const [rid, c] of Object.entries(crew)) {
    if (!c || !c.inbox) continue;
    let t = ''; try { t = fs.readFileSync(path.join(F.handoffs, c.inbox), 'utf8'); } catch (_) { continue; }
    const secs = new Map(t.split(/^## /m).slice(1).map(s => [s.split('\n')[0].trim(), s]));
    for (const it of SP.parseItems(t).filter(i => i.open)) {
      const writer = writerOf(it.heading, crew); if (!writer || writer === rid) continue;
      const prof = profiles[writer]; if (!prof || !prof.counterpart || prof.counterpart.seat === rid) continue;
      const ref = itemRef(c.inbox, it);
      const h = holdFor(secs.get(it.heading) || '', writer, { profile: prof, records: recs, ref });
      if (!h.hold) continue;
      const key = ref + ':' + h.kind, cpName = nameOf(crew, h.counterpart);
      if (mode === 'shadow') {
        if (!st.would[key]) { st.would[key] = new Date(now).toISOString(); st.counts.wouldHold++; dirty = true; log('WOULD HOLD sign-off ' + h.kind + ' ' + ref + ' "' + it.heading.slice(0, 80) + '" (' + nameOf(crew, rid) + '): ' + nameOf(crew, writer) + '\'s counterpart ' + cpName + ' has not signed off (shadow: nothing held)'); }
        continue;
      }
      holds.set(c.inbox + '\n' + it.heading, { who: cpName, kind: h.kind, id: h.id, counterpart: h.counterpart, writer });
      let id = h.id;
      if (!id && !o.dry) {
        const r = append({ at: new Date(now).toISOString(), op: 'ask', id: newId(), from: writer, counterpart: h.counterpart, kind: h.kind, ref, digest: null, why: clean(it.heading, 200), via: 'dispatch.js' }, o);
        id = r.id; recs = records(o); dirty = true;
      }
      if (id && !st.items[id] && !o.dry) {
        const cp = crew[h.counterpart];
        appendBlock(cp && cp.inbox, 'Sign-off: ' + clean(it.heading.replace(/^\S+ from [^—–-]+[—–-]\s*/, ''), 90), {
          'Sign-off': id,
          Need: nameOf(crew, writer) + ' wants to ' + P.SIGNOFF_KINDS[h.kind].words + ' ("' + clean(it.heading, 120) + '" in ' + c.inbox + '). Check it, then answer: node company/tools/approvals.js signoff answer ' + id + ' --verdict yes|no --check "<what you checked>" [--reasons "<why not, and what would make it a yes>"] --by ' + cpName + '. Until you answer, ' + nameOf(crew, rid) + ' is not woken for it.',
          Why: nameOf(crew, writer) + '\'s profile names you as the counterpart who signs off before they ' + P.SIGNOFF_KINDS[h.kind].words + '.',
          Status: 'OPEN' }, o);
        st.items[id] = new Date(now).toISOString(); st.counts.held++; dirty = true;
        log('HOLD sign-off ' + h.kind + ' ' + ref + ' (' + nameOf(crew, rid) + '): waiting for ' + cpName + ' (' + id + '); sign-off item in ' + ((cp && cp.inbox) || '?'));
      }
      // no answer after holdMaxHours: the counterpart's manager hears once; the block stays held
      const rec = id ? recs.get(id) : null, askAt = rec ? Date.parse(rec.ask.at) : now;
      const maxMs = Math.max(1, Number(pol.signoff.holdMaxHours) || 24) * HOUR;
      if (rec && rec.status === 'open' && now - askAt >= maxMs && !st.told[id] && !o.dry) {
        const mgr = crew[(crew[h.counterpart] || {}).manager];
        appendBlock(mgr && mgr.inbox, 'sign-off waiting on ' + firstName(cpName) + ' for ' + Math.round((now - askAt) / HOUR) + ' h', {
          'Sign-off': id, Need: cpName + ' has not answered sign-off ' + id + ' (' + h.kind + ', ' + ref + ') for ' + Math.round((now - askAt) / HOUR) + ' hours, so ' + nameOf(crew, rid) + '\'s handoff is still held. Help ' + firstName(cpName) + ' answer it; only the CEO may override it (approvals.js signoff override ' + id + ' --by <CEO> --why "..").', Status: 'OPEN' }, o);
        st.told[id] = new Date(now).toISOString(); dirty = true;
        log('SIGN-OFF LATE ' + id + ': told ' + ((mgr && mgr.name) || 'nobody (no manager)') + ' once; still held');
      }
    }
  }
  if (dirty && !o.dry) { try { fs.mkdirSync(path.dirname(F.state), { recursive: true }); const tmp = F.state + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(Object.assign({ _doc: 'lib/signoff.js scanTick: the would-holds logged (shadow), the sign-off items opened, the managers told; rewritten whole each tick it changes' }, st), null, 1) + '\n'); fs.renameSync(tmp, F.state); } catch (_) {} }
  return (inbox, it) => (it ? holds.get(inbox + '\n' + it.heading) || null : null);
}

/* ---------- the gates (external-gate.js, merge-gate.js) ---------- */
// in addition to every existing gate, never in place of one: live refuses an act the acting seat's profile says needs
// its counterpart's yes when there is none; shadow records the would-refuse and allows
function gate(a, o) {
  o = o || {};
  const seat = String(a.seat || ''), kind = String(a.kind || '');
  let mode = 'off'; try { mode = P.policy(o).signoff.mode; } catch (_) { return { needed: false }; }
  if (mode === 'off' || !seat) return { needed: false, mode };
  const cp = needs(seat, kind, o); if (!cp) return { needed: false, mode };
  const refs = (a.refs || []).map(normRef).filter(Boolean);
  const recs = records(o);
  if (refs.some(r => cleared(r, { records: recs }, kind))) return { needed: true, cleared: true, mode, counterpart: cp };
  const crew = crewOf(o);
  const why = nameOf(crew, seat) + '\'s profile says ' + nameOf(crew, cp) + ' signs off before they ' + P.SIGNOFF_KINDS[kind].words + ', and there is no yes for ' + (refs[0] || 'this act') + ': ask with node company/tools/approvals.js signoff ask --kind ' + kind + ' --ref ' + (refs[0] || '<ref>') + ' --by ' + nameOf(crew, seat) + ', then act once ' + firstName(nameOf(crew, cp)) + ' says yes';
  if (mode === 'live') return { needed: true, cleared: false, mode, counterpart: cp, refuse: why };
  try { const f = files(o).gates; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: at(o), seat, kind, refs, counterpart: cp, via: a.via || null, would: 'refuse' }) + '\n'); } catch (_) {}
  return { needed: true, cleared: false, mode, counterpart: cp, would: true, why };
}

module.exports = { WRITER, KIND_CUES, Refusal, files, normRef, itemRef, rows, records, pending, cleared, needs, holdFor, explicitKinds, ask, answer, override, list, scanTick, gate, writerOf };
