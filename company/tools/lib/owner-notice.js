'use strict';
/* owner-notice.js — the one way the company tells the owner something (not asks: an owner question is an owner card,
 * lib/owner-card.js). The owner is a busy, non-technical person: only what cannot wait reaches them at once, and
 * everything else arrives as ONE plain message a day.
 *
 *   const N = require('./lib/owner-notice');
 *   N.send({ kind: 'urgent'|'fyi', from, text, technical?, key?, re?, priority?, root?, now? }, { root?, now? }?)
 *     -> { sent: 'outbound'|'digest', row } | { duplicate: true, key }
 *       urgent  the company stopped or cannot work, money or an account is needed now, a security event, or the CEO's
 *               own reply to the owner: written to company/owner/outbound.jsonl now (owner-inbox.js send, the low-level
 *               writer), after the plain check.
 *       fyi     everything else: one row in company/owner/digest.jsonl, folded into the day's single message.
 *     The plain check (lib/owner-scope.js plainScore, sentence by sentence): a bracketed or quoted technical bit (an id,
 *     a path, a command) is cut out of its sentence; a sentence that is still technical, or very long, moves whole into
 *     `technical`, which the console shows collapsed as "Technical details (for the crew)". The patterns are the owner
 *     card's (lib/owner-scope.js wordsProblems). An fyi with no plain sentence left is kept for the crew only (crewOnly:
 *     never on Today, never in the day message) and recorded in company/state/owner-notice-lint.jsonl; with
 *     CAPHEOS_NOTICE_STRICT=1 (tests) a text that is not plain throws NOT_PLAIN instead, so a template is fixed, not hidden.
 *     asks: true marks a line that points at something waiting on Today; action: {kind:'undo-decision', decisionId} a
 *     console control on the line (ACTIONS).
 *     key: the same key (default: the sender and the plain text) is sent at most once per company day for an fyi. An
 *     urgent notice is never held back for the day: the same urgent key is a repeat only within URGENT_REPEAT_MIN minutes
 *     (one event reported twice), so a second outage or a second pause later the same day reaches the owner.
 *     An urgent notice with no plain sentence left still says what kind of trouble it is (urgentLead), never only
 *     "an urgent note for the crew".
 *   N.digest({ root?, now?, force?, dry? }) -> { sent: false, why } | { sent: true, row, folded }
 *     At or after the evening hour (company/work/ops/owner-notices.json, defaults in company/defaults/work/ops/), once a
 *     company day: every fyi row not folded yet becomes one message titled "What the crew did today". The dispatcher
 *     calls it every tick; `owner-inbox.js digest` runs it by hand (--force: ignore the hour, not the once-a-day rule).
 *   N.pending({ root? }) -> the fyi rows waiting for the next message (the console's Today card).
 *   N.plain(text) -> { text, technical: [parts moved out] }
 *
 * State: company/state/owner-digest.json { foldedThrough: <iso of the newest folded row>, days: { <date>: {at, id, rows} } }.
 * It refuses an empty text, and never writes to the inbound side (the owner's own words).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const scope = require('./owner-scope');

const KINDS = ['urgent', 'fyi'];
const URGENT_REPEAT_MIN = 10;
const MAX_WORDS = 40;
const DEFAULTS = { eveningHour: 18, maxItems: 12, title: 'What the crew did today' };

const rootOf = o => path.resolve((o && o.root) || co.ROOT);
const isLive = o => rootOf(o) === path.resolve(co.ROOT);
function files(o) {
  const r = rootOf(o);
  const ownerDir = (isLive(o) && process.env.OWNER_DIR) || path.join(r, 'company', 'owner');
  return { root: r, ownerDir, digest: path.join(ownerDir, 'digest.jsonl'), outbound: path.join(ownerDir, 'outbound.jsonl'),
    state: path.join(r, 'company', 'state', 'owner-digest.json'),
    config: path.join(r, 'company', 'work', 'ops', 'owner-notices.json'), configDefault: path.join(r, 'company', 'defaults', 'work', 'ops', 'owner-notices.json') };
}
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
function readRows(file, maxBytes) {
  let txt = ''; try { txt = require('./bounded').tailText(file, maxBytes || 4 * 1024 * 1024); } catch (_) { return []; }
  const out = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.id) out.push(r); } catch (_) {} }
  return out;
}
/* the company's settings for notices: the owner's file over the framework defaults */
function config(o) {
  const f = files(o);
  const c = Object.assign({}, DEFAULTS, readJson(f.configDefault, {}) || {}, readJson(f.config, {}) || {});
  const h = Number(c.eveningHour); c.eveningHour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULTS.eveningHour;
  c.maxItems = Math.max(1, Number(c.maxItems) || DEFAULTS.maxItems);
  return c;
}
const dayOf = ms => co.localParts(new Date(ms)).date;
const hourOf = ms => co.localParts(new Date(ms)).hour;

/* ---- the plain check ---- */
// owner-scope's jargon list, plus what only a notice carries: a colon reference (hiring:open:x), a command flag, a <placeholder>
const EXTRA = [/\b[\w-]+:[\w-]+:[\w.-]+/, /(?:^|\s)--[a-z][\w-]*/, /<[a-z][\w -]*>/i, /\bnode\s+\S+/];
// a console link's target ([Open Today](console:#/today)) is a button, not words the owner reads
const unlinked = s => String(s).replace(/\]\((?:console:|https?:\/\/)[^)\s]*\)/g, ']');
// the SAME patterns an owner card's plain parts are checked against (lib/owner-scope.js wordsProblems: the jargon words,
// paths, ids, clock times, hashes, settings, identifiers, model ids, commands, flags, clock specs, setting names, diffs)
const technicalBit = s => { const t = unlinked(s); return scope.wordsProblems(t).length > 0 || EXTRA.some(re => re.test(t)); };
// a sentence that lost its object to a cut ("Resume with .") no longer reads: it moves whole
const DANGLING = /\b(?:with|to|run|use|using|in|at|by|see|try|type|of|from|via|is|are|the|a|an|and|or|named|called)\s*[.!?:]?$/i;
const sentencesOf = t => String(t || '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9("'`*\[])/).map(s => s.trim()).filter(Boolean);
const MARKER = /^(\d{1,2}[.)]|[-*•])\s+/;
// bits a sentence can lose and still read: `code`, (a parenthetical) or [a bracket] that is technical, a trailing id list
const CUTTABLE = [/`[^`]*`/g, /(?<!\])\s*\((?:[^()]|\([^()]*\))*\)/g, /\s*\[[^\]]*\](?!\()/g];
/* plain(text) -> { text, technical }: the plain sentences, and every technical part moved out of them */
function plain(text) {
  const lines = [], moved = [];
  for (const line of String(text || '').replace(/[ \t]+/g, ' ').split('\n')) {
    const marker = (line.trim().match(MARKER) || [''])[0];
    const keep = [];
    for (const s0 of sentencesOf(line.trim().slice(marker.length))) {
      let s = s0; const bits = [];
      if (technicalBit(s)) {
        for (const re of CUTTABLE) s = s.replace(re, m => { if (technicalBit(m.replace(/^\s*[([]|[)\]]$/g, ''))) { bits.push(m.trim()); return ''; } return m; });
        s = s.replace(/\s*\(\s*[,;]?\s*\)|\s*\[\s*\]/g, '').replace(/\s+([.,;:!?])/g, '$1').replace(/[,:;]\s*([.!?])$/, '$1').replace(/\s{2,}/g, ' ').trim();
      }
      const words = s.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
      if (!s || words < 2 || technicalBit(s) || words > MAX_WORDS || (bits.length && DANGLING.test(s))) { moved.push(s0); continue; }
      keep.push(s); moved.push(...bits);
    }
    if (keep.length) lines.push(marker + keep.join(' '));
    else if (!line.trim() && lines.length && lines[lines.length - 1] !== '') lines.push('');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { text: lines.join('\n').trim(), technical: moved };
}
// callers that pass the scratch company as a second argument ({root}, like lib/owner-card.js) are honoured: the root
// never silently falls back to the live company
const withRoot = (o, opts) => { o = Object.assign({}, o || {}); if (!o.root && opts && opts.root) o.root = opts.root; if (o.now === undefined && opts && Number.isFinite(opts.now)) o.now = opts.now; return o; };
const keyOf = (from, text) => crypto.createHash('sha256').update(String(from || '') + '\n' + String(text || '')).digest('hex').slice(0, 16);

/* urgentLead(from, raw): an urgent notice whose every sentence was technical still tells the owner what kind of trouble
 * it is, in plain words, and that the crew has the details */
const URGENT_KINDS = [
  [/\b(security|unverified|forged|tamper|quarantin|intru|leak)/i, 'a possible security problem'],
  [/\b(halt|paused|stopped|silent|down|crash|not (?:come|coming) back|restart|unreachable)/i, 'the company has stopped working'],
  [/\b(money|budget|spend|balance|credit|billing|payment|\$\d)/i, 'money the crew needs now'],
  [/\b(key|token|password|account|sign[- ]?in|login|credential)/i, 'an account or key the crew needs'],
];
function urgentLead(from, raw) {
  const what = (URGENT_KINDS.find(([re]) => re.test(String(raw || ''))) || [null, 'something that cannot wait'])[1];
  return from + ' reports ' + what + '. The full message is in the details below; the crew is on it and will tell you if you need to act.';
}

/* send(o) — one notice: urgent now (plain), fyi into the day's message. */
function send(o, opts) {
  o = withRoot(o, opts);
  const kind = KINDS.includes(o.kind) ? o.kind : 'fyi';
  const raw = String(o.text || '').trim();
  if (!raw) throw new Error('owner-notice send: text is required');
  const from = String(o.from || co.nameOf(co.ceo()) || 'The company');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const f = files(o);
  const p = plain(raw);
  // strict (tests, CAPHEOS_NOTICE_STRICT=1): a sender whose text is not plain fails loudly instead of being trimmed, so
  // a template that needs rewording is found by its test, never hidden from the owner
  if (process.env.CAPHEOS_NOTICE_STRICT === '1' && (p.technical.length || !p.text)) {
    throw Object.assign(new Error('owner notice not plain (' + from + '): ' + (p.technical.length ? p.technical.join(' | ') : raw) + ' — say it in everyday words; pass ids, paths, commands and numbers as `technical`'), { code: 'NOT_PLAIN', parts: p.technical });
  }
  const tech = [].concat(p.technical, o.technical ? [String(o.technical).trim()] : []).filter(Boolean);
  // an fyi with no plain sentence left is not filler for the owner ("noted something technical"): it is kept for the
  // crew only (never on Today, never in the day message) and recorded as a template to fix (company/state/owner-notice-lint.jsonl)
  const lead = p.text || (kind === 'urgent' ? urgentLead(from, raw) : '');
  const key = String(o.key || keyOf(from, lead || raw));
  const day = dayOf(now);
  const seen = kind === 'urgent'
    ? r => r && r.key === key && r.kind === 'urgent' && Number.isFinite(Date.parse(r.at)) && now - Date.parse(r.at) >= 0 && now - Date.parse(r.at) < URGENT_REPEAT_MIN * 60e3
    : r => r && r.key === key && (r.day || (r.at && dayOf(Date.parse(r.at)))) === day;
  if (readRows(f.digest).some(seen) || readRows(f.outbound).some(seen)) return { duplicate: true, key };
  const technical = tech.length ? tech.join('\n') : undefined;
  if (kind === 'urgent') {
    const oi = require('../owner-inbox.js');
    const row = oi.send({ from, text: lead, re: o.re, priority: o.priority, technical, key, day, kind: 'urgent', dir: f.ownerDir, at: now });
    return { sent: 'outbound', row };
  }
  const oi = require('../owner-inbox.js');
  const row = { id: 'fyi-' + now.toString(36) + '-' + crypto.randomBytes(2).toString('hex'), at: new Date(now).toISOString(), day, kind: 'fyi', from,
    text: oi.redact(lead), key };
  if (!p.text) {   // nothing plain to say: it rides in the day message's technical part only, and the crew is told to fix it
    row.crewOnly = true;
    lint(f, { at: row.at, from, key, raw: oi.redact(raw).slice(0, 600), moved: p.technical.slice(0, 8).map(x => oi.redact(x).slice(0, 200)) });
  }
  if (technical) row.technical = oi.redact(technical);
  if (o.re) row.re = String(o.re);
  // asks: the line tells the owner something waits for their answer on Today (the day message then never closes with
  // "Nothing here needs an answer from you")
  if (o.asks === true) row.asks = true;
  // action: a console control the owner can use on this line (only the kinds the console knows; Today draws the button)
  if (o.action && ACTIONS[o.action.kind] && ACTIONS[o.action.kind](o.action)) row.action = JSON.parse(JSON.stringify(o.action));
  fs.mkdirSync(path.dirname(f.digest), { recursive: true });
  fs.appendFileSync(f.digest, JSON.stringify(row) + '\n');
  return { sent: 'digest', row };
}

// the console controls a day-message line may carry (console/owner-needs.js digest and Today draw them)
const ACTIONS = {
  'undo-decision': a => typeof a.decisionId === 'string' && /^d-[0-9a-f]{12}$/.test(a.decisionId),
};
function lint(f, row) {
  try { const file = path.join(f.root, 'company', 'state', 'owner-notice-lint.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n'); } catch (_) {}
}
function state(o) { const s = readJson(files(o).state, {}) || {}; s.days = s.days || {}; return s; }
/* pending(o) — the fyi rows not folded into a daily message yet, oldest first */
function pending(o) {
  const s = state(o); const cut = s.foldedThrough ? Date.parse(s.foldedThrough) : -Infinity;
  return readRows(files(o).digest).filter(r => r.kind === 'fyi' && Date.parse(r.at) > cut).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
/* the one plain message for a day's rows: what each crew member did, in their own (already plain) sentence */
function compose(rows, c) {
  const seen = new Set(); const items = [];
  for (const r of rows) { const t = String(r.text || '').trim(); if (!t || r.crewOnly || seen.has(t)) continue; seen.add(t); items.push({ from: r.from, text: t }); }
  const shown = items.slice(0, c.maxItems);
  const lines = shown.map(i => '- ' + (i.from && !new RegExp('^' + String(i.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(i.text) ? i.from + ': ' : '') + i.text);
  if (items.length > shown.length) lines.push('- And ' + (items.length - shown.length) + ' smaller things.');
  if (!items.length) return null;   // only crew-level notes today: nothing for the owner to read
  const technical = rows.filter(r => r.technical).map(r => (r.from ? r.from + ': ' : '') + r.technical).join('\n');
  // the closing line never contradicts a line above it that points at something waiting on Today
  const close = rows.some(r => r.asks && !r.crewOnly) ? 'Only what waits on Today needs an answer from you; the rest is for your information.' : 'Nothing here needs an answer from you.';
  return { text: c.title + ':\n' + lines.join('\n') + '\n' + close, technical };
}
/* digest(o) — fold every pending fyi row into ONE message, once a company day, at or after the evening hour */
function digest(o) {
  o = o || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const c = config(o); const f = files(o); const s = state(o); const day = dayOf(now);
  if (s.days[day]) return { sent: false, why: 'already sent today (' + s.days[day].at + ')' };
  if (!o.force && hourOf(now) < c.eveningHour) return { sent: false, why: 'before the evening hour (' + c.eveningHour + ')' };
  const rows = pending(o).filter(r => Date.parse(r.at) <= now);
  if (!rows.length) return { sent: false, why: 'nothing to tell' };
  const m = compose(rows, c);
  if (!m) return { sent: false, why: 'nothing to tell' };
  if (o.dry) return { sent: false, why: 'dry run', text: m.text, folded: rows.length };
  const oi = require('../owner-inbox.js');
  const row = oi.send({ from: 'The crew', text: m.text, technical: m.technical || undefined, kind: 'digest', title: c.title, day,
    folds: rows.length, key: 'digest:' + day, dir: f.ownerDir });
  s.foldedThrough = rows[rows.length - 1].at;
  s.days[day] = { at: new Date(now).toISOString(), id: row.id, rows: rows.length };
  const keys = Object.keys(s.days).sort(); while (keys.length > 60) delete s.days[keys.shift()];   // the file stays small
  fs.mkdirSync(path.dirname(f.state), { recursive: true });
  const tmp = f.state + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n'); fs.renameSync(tmp, f.state);
  return { sent: true, row, folded: rows.length };
}

module.exports = { send, digest, pending, plain, config, KINDS, DEFAULTS, URGENT_REPEAT_MIN, ACTIONS };
