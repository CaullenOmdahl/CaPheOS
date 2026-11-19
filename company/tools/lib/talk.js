'use strict';
/* lib/talk.js — how the crew talks to the owner (docs/TALK.md). The owner picks, in Settings › How the crew talks to
 * you, a LEVEL (Plain, Some detail, Technical), a LENGTH and HOW OFTEN they hear from the crew. This file is the one
 * place that reads the choice and turns it into what a seat is told and what the console checks. Deterministic: regexes
 * and counts, no model call. Agents among themselves stay technical: nothing here touches handoffs, consults or routines.
 *
 *   prefs({root}) -> { level, length, often, check, setBy, at, source: 'file'|'default', limits }
 *       company/owner/talk.json (written only by company/tools/talk.js). A missing file reads technical / full / daily /
 *       shadow: today's behaviour, so an existing company changes nothing until the owner picks. The numbers (limits)
 *       are laid one field at a time: built-in, then company/defaults/owner/talk.json limits, then the company file's.
 *   block(prefs, seatVoice?, {owner}) -> the instruction (at most ~90 tokens) a seat gets whenever it addresses the owner
 *       (the chat's context note, the meeting's rules). '' while the owner has not picked (no file), so an existing
 *       company's prompt is byte for byte today's. seatVoice: the profile's voice.toOwner (docs/PROFILES.md), appended.
 *   check(text, level, length, {limits}) -> { ok, problems: [{ kind, words }] }
 *       kind: command | path | tool | id | model | jargon | code | length. Reuses lib/owner-scope.js wordsProblems (the
 *       owner card's patterns) and console/command-ask.js commandAsk (a command handed to the owner). Not the card's
 *       two-sentence limit: length is the owner's word cap. technical: only commandAsk (today's check). some: commands
 *       and paths always; any other technical word only when the same sentence does not explain it ("which means",
 *       "that is", "in other words", a parenthesis). plain: every kind.
 *   mask(text, {wordsOnly?, ownerAimed?}) -> { text, technical: [the parts taken out] }: each code block, code span, path,
 *       command, id, tool and model name and technical word becomes "(a technical detail the crew handles)"; a sentence
 *       still technical after that becomes the placeholder whole, EXCEPT with wordsOnly (an urgent notice, an ask: no
 *       sentence goes whole) or ownerAimed and a sentence aimed at the owner (you/your, money, a deadline, a question:
 *       OWNER_AIMED; lib/owner-notice.js): those keep their words, only the technical ones masked. Otherwise the result
 *       passes check() at plain (bar its length).
 *   recheckNote(problems, level, {command, owner}) -> the note the seat gets with a reply sent back (starts with
 *       CHECK_PREFIX, so the chat history never shows it as the owner's words). With `command` (a commandAsk hit) the
 *       note is console/command-ask.js recheckNote's, with the plain-words part added: one note, one recheck.
 *   record(row, {root}) -> appends company/state/talk-checks.jsonl { at, seat, runId, level, problems, action, ... }
 *   stats({root, days}) -> counts of the check rows by action over the last `days` (talk.js show)
 *   examples({root}) -> company/defaults/owner/talk-examples.json (fixed text, an invented crew; the settings preview)
 */
const fs = require('fs');
const path = require('path');

const LEVELS = ['plain', 'some', 'technical'];
const LENGTHS = ['short', 'medium', 'full'];
const OFTEN = ['needed', 'daily', 'asItHappens'];
const CHECKS = ['off', 'shadow', 'live'];
const MISSING = Object.freeze({ v: 1, level: 'technical', length: 'full', often: 'daily', check: 'shadow' });
const LIMITS = Object.freeze({ shortWords: 80, mediumWords: 200, slack: 1.25 });
const PLACEHOLDER = '(a technical detail the crew handles)';
const MASKED_NOTICE = 'Some technical details were left out. The crew handles them.';
const TECH_TITLE = 'Technical details (for the crew)';

const REPO = path.resolve(__dirname, '..', '..', '..');
const rootOf = o => path.resolve((o && o.root) || require('./company').ROOT);
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
function files(o) {
  const r = rootOf(o);
  return { root: r, file: path.join(r, 'company', 'owner', 'talk.json'), defaults: path.join(r, 'company', 'defaults', 'owner', 'talk.json'),
    examples: path.join(r, 'company', 'defaults', 'owner', 'talk-examples.json'), checks: path.join(r, 'company', 'state', 'talk-checks.jsonl') };
}
function ownerName(o) {
  if (o && o.owner) return String(o.owner);
  const r = rootOf(o);
  const c = readJ(path.join(r, 'company', 'company.json'), {}) || {};
  return String((c.owner && c.owner.name) || 'The owner').trim() || 'The owner';
}

/* ---------- the owner's choice ---------- */
function limitsOf(...srcs) {
  const out = Object.assign({}, LIMITS);
  for (const s of srcs) {
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys(LIMITS)) { const n = Number(s[k]); if (Number.isFinite(n) && n > 0) out[k] = n; }
  }
  return out;
}
function prefs(o) {
  const f = files(o);
  const d = readJ(f.defaults, {}) || {};
  const j = readJ(f.file, null);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return Object.assign({}, MISSING, { setBy: null, at: null, source: 'default', limits: limitsOf(d.limits) });
  const pick = (k, list) => list.includes(j[k]) ? j[k] : MISSING[k];
  return { v: 1, level: pick('level', LEVELS), length: pick('length', LENGTHS), often: pick('often', OFTEN), check: pick('check', CHECKS),
    setBy: j.setBy || null, at: j.at || null, source: 'file', limits: limitsOf(d.limits, j.limits) };
}
const capOf = p => { const L = (p && p.limits) || LIMITS; const len = p && p.length; return len === 'short' ? L.shortWords : len === 'medium' ? L.mediumWords : Infinity; };

/* ---------- what a seat is told ---------- */
function block(p, seatVoice, o) {
  p = p || prefs(o);
  if (p.source === 'default') return '';   // the owner has not picked: today's prompt, unchanged
  const O = ownerName(o);
  const cap = capOf(p);
  const len = Number.isFinite(cap) ? ' Keep it under about ' + cap + ' words.' : '';
  const act = ' If they need to act, link the console button.';
  let t;
  if (p.level === 'plain') t = O + ' chose plain words: no technical terms, no commands, file names or tool names, no model names. Say what it means for them.' + len + act;
  else if (p.level === 'some') t = O + ' chose some detail: mostly plain words, a technical word only with its meaning in the same sentence, never a command or a file path. Say what it means for them.' + len + act;
  else t = O + ' chose technical detail: talk to them as you would to a colleague on the crew, but never ask them to run a command.' + len + act;
  const v = String(seatVoice || '').replace(/\s+/g, ' ').trim();
  return '[How ' + O + ' wants to hear from you] ' + t + (v ? ' Your own way with them: ' + v.slice(0, 200) : '');
}

/* ---------- the check ---------- */
let CA = null;
function cmdLib() {
  if (CA !== null) return CA;
  try { CA = require(path.join(REPO, 'console', 'command-ask.js')); } catch (_) { CA = false; }
  return CA;
}
const commandAsk = t => { const c = cmdLib(); if (!c) return null; try { return c.commandAsk(t); } catch (_) { return null; } };
const scope = () => require('./owner-scope');
// technical words a chat reply carries that the owner card's list does not (the card list is kept as it is)
const EXTRA_JARGON = ['idempotency', 'idempotent', 'refactor(?:s|ed|ing)?', 'backend', 'frontend', 'stack trace', 'runtime', 'pull request', 'pull requests',
  'rebase', 'merge conflict', 'mutex', 'race condition', 'stdin', 'argv', 'null pointer', 'boolean', 'cache key', 'websockets?', 'backfill(?:ed|ing)?'];
const EXTRA_RE = new RegExp('\\b(?:' + EXTRA_JARGON.join('|') + ')\\b', 'gi');
// a model's id ("claude-sonnet-5-5", the whole of it) and a model family's name ("Sonnet", "MiniMax"); "Claude" alone is
// the product the owner knows and stays
const MODEL_ID = /\b(?:claude|gpt|minimax|gemini|llama|mistral|qwen|deepseek|sonnet|opus|haiku|abab)[\w.-]*\d[\w.-]*\b|\bo\d(?:-[\w]+)?\b/gi;
const MODEL_NAME = /\b(?:sonnet|opus|haiku|minimax|deepseek|gemini|llama|mistral|qwen|abab)\b/gi;
// words on the card's list that are everyday English in a chat reply ("the daily digest", "a period of calm")
const SOFT = new Set(['period', 'grace', 'duty', 'duties', 'register', 'registers', 'unit', 'units', 'digest', 'port', 'ports', 'container', 'timer', 'timers', 'token', 'tokens', 'module', 'modules']);
const ALLOW_IDENT = /^(?:iPhone|iPad|iOS|macOS|eBay|iCloud|PayPal|LinkedIn|YouTube|WhatsApp|GitHub)$/;
const KIND_OF = {
  'a code span': 'code', 'a file path': 'path', 'a file or tool name': 'tool', 'an id': 'id', 'a hash': 'id', 'a setting': 'id', 'an identifier': 'id',
  'a model id': 'model', 'a command': 'command', 'a command flag': 'command', 'a clock spec': 'code', 'a setting name': 'id', 'a diff': 'code',
};
const SKIP = new Set(['a clock time', 'a code']);   // "18:00", "Q3": plain in a chat reply
const EXPLAINS = /\bwhich means\b|\bthat is\b|\bthat's\b|\bin other words\b|\bi\.e\.|\(([^()]{3,})\)/i;
// what is not words the owner reads: the console's own controls (```actions), a link's target (a button)
function prose(text) {
  return String(text || '').replace(/```actions[\s\S]*?```/g, '\n').replace(/\]\((?:console:|https?:\/\/)[^)\s]*\)/g, ']');
}
const FENCE = /```[\s\S]*?```/g;
function classifySpan(inner) {
  const s = String(inner || '').trim();
  const S = scope();
  if (/(?:^|[\s(])(?:node|npm|npx|pip|git|sudo|systemctl|bash|sh|curl|wget|cd|ls|rm|mv|cp|chmod|docker|python3?)\s+\S/.test(' ' + s)) return 'command';
  if (/[\w.-]+\/[\w./-]+/.test(s)) return 'path';
  if (/\.(?:js|json|jsonl|md|py|sh|service|timer|socket|conf|ya?ml|txt|log)\b/.test(s)) return 'tool';
  if (S.wordsProblems(s.replace(/`/g, '')).some(w => / \(a model id\)$/.test(w))) return 'model';
  return 'code';
}
// one sentence's technical bits: [{kind, word}]
function hitsIn(sn) {
  const out = [];
  const S = scope();
  for (const m of sn.match(/`[^`\n]+`/g) || []) out.push({ kind: classifySpan(m.slice(1, -1)), word: m.slice(1, -1) });
  for (const w of S.wordsProblems(sn)) {
    const mm = / \(([^()]+)\)$/.exec(w);
    if (!mm) { if (!SOFT.has(w.toLowerCase())) out.push({ kind: 'jargon', word: w }); continue; }
    const what = mm[1], word = w.slice(0, mm.index);
    if (SKIP.has(what) || what === 'a code span') continue;
    if (what === 'an identifier' && ALLOW_IDENT.test(word)) continue;
    out.push({ kind: KIND_OF[what] || 'code', word });
  }
  for (const m of sn.match(EXTRA_RE) || []) out.push({ kind: 'jargon', word: m });
  for (const m of sn.match(MODEL_ID) || []) out.push({ kind: 'model', word: m });
  for (const m of sn.match(MODEL_NAME) || []) out.push({ kind: 'model', word: m });
  return out;
}
const sentences = t => String(t || '').split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const wordCount = t => String(t || '').replace(FENCE, ' ').split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
function group(list) {
  const by = new Map();
  for (const x of list) { if (!by.has(x.kind)) by.set(x.kind, []); const a = by.get(x.kind); const w = String(x.word).trim().slice(0, 120); if (w && !a.includes(w) && a.length < 6) a.push(w); }
  const order = ['command', 'path', 'tool', 'model', 'id', 'code', 'jargon', 'length'];
  return [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([kind, words]) => ({ kind, words }));
}
function check(text, level, length, o) {
  level = LEVELS.includes(level) ? level : 'technical';
  const t = prose(text);
  const list = [];
  const ca = commandAsk(t);
  if (ca) list.push({ kind: 'command', word: ca.command });
  if (level === 'technical') { const problems = group(list); return { ok: !problems.length, problems }; }
  for (const f of t.match(FENCE) || []) list.push({ kind: classifySpan(f.replace(/^```\w*\n?|```$/g, '').split('\n')[0]) === 'command' ? 'command' : 'code', word: f.replace(/^```\w*\n?|```$/g, '').trim().split('\n')[0] || 'a code block' });
  for (const sn of sentences(t.replace(FENCE, '\n'))) {
    const hits = hitsIn(sn);
    if (!hits.length) continue;
    if (level === 'some' && EXPLAINS.test(sn)) { for (const x of hits) if (x.kind === 'command' || x.kind === 'path') list.push(x); continue; }
    if (level === 'some') { for (const x of hits) list.push(x); continue; }
    for (const x of hits) list.push(x);
  }
  const cap = capOf({ length, limits: limitsOf(o && o.limits) });
  const slack = limitsOf(o && o.limits).slack;
  const n = wordCount(t);
  if (Number.isFinite(cap) && n > cap * slack) list.push({ kind: 'length', word: n + ' words' });
  const problems = group(list);
  return { ok: !problems.length, problems };
}

/* ---------- masking (a second reply that is still too technical, for a Plain owner) ---------- */
const MASK_RES = () => {
  const S = scope();
  return [
    /(?:^|(?<=[\s(]))(?:node|npm|npx|pip3?|git|sudo|systemctl|bash|sh|curl|wget|cd|ls|rm|mv|cp|chmod|docker|python3?)\s+[^\s,;!?)]*[^\s.,;!?)](?:\s+(?:--?[\w-]+|[\w./~=:-]*[./=][\w./~=:-]*[\w/~-]|show|list|status|start|stop|restart|install|push|pull))*/g,
    /(?:^|\s)--?[a-z][\w-]*(?==|\s|$)/g,
    /(?:https?:\/\/|~\/|\.{1,2}\/|\/)?\b[\w.-]+\/[\w./-]*[\w-]/g,
    /\b[\w-]+\.(?:js|json|jsonl|md|py|sh|service|timer|socket|conf|ya?ml|txt|log|io)\b/g,
    MODEL_ID, MODEL_NAME,
    /\b[a-z]{1,4}-(?=[0-9a-f]*\d)[0-9a-f]{3,}\b/gi,
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
    /\b\w+=\S+/g,
    /\b[a-z]+(?:_[a-z0-9]+)+\b/g,
    /\b[a-z]+[A-Z][A-Za-z]+\b/g,
    /\*\/\d+|\bOnCalendar\b/g,
    new RegExp(S.JARGON_WORDS.filter(w => !SOFT.has(w)).map(w => '\\b' + w.replace(/[-]/g, '[- ]?') + '\\b').join('|'), 'gi'),
    EXTRA_RE,
  ];
};
// a sentence meant for the owner: it speaks to them (you, your), about money or a deadline, or asks them something. Such a
// sentence is never replaced whole: only its technical words are masked (the owner must still read what is asked of them)
const OWNER_AIMED = /\b(?:you|your|yours|yourself)\b|[$€£]\s?\d|\b(?:usd|dollars?|euros?|money|pay|paid|payment|cost|costs|budget|spend|spent|invoice|refund|deadline|due|today|tonight|tomorrow|this week|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|noon|tonight|tomorrow)|urgent|asap|right away|now)\b|\?\s*$/i;
// mask(text, { wordsOnly?, ownerAimed? }): wordsOnly (an urgent notice, an ask) never replaces a whole sentence; otherwise
// a sentence still technical after its words are masked goes whole, unless ownerAimed and it is aimed at the owner
function mask(text, mo) {
  mo = mo || {};
  const technical = [];
  const keep = [];
  let t = String(text || '');
  // the console's controls and a link's target are kept as they are (a button, not words)
  t = t.replace(/```actions[\s\S]*?```/g, m => { keep.push(m); return '\u0001' + (keep.length - 1) + '\u0001'; });
  t = t.replace(/\]\((?:console:|https?:\/\/)[^)\s]*\)/g, m => { keep.push(m); return '\u0001' + (keep.length - 1) + '\u0001'; });
  const take = m => { const s = String(m).trim(); if (s && !technical.includes(s)) technical.push(s); return (/^\s/.test(m) ? ' ' : '') + PLACEHOLDER; };
  t = t.replace(FENCE, m => '\n' + take(m.replace(/^```\w*\n?|```$/g, '').trim()).trim() + '\n');
  t = t.replace(/`[^`\n]+`/g, m => take(m.slice(1, -1)));
  for (const re of MASK_RES()) t = t.replace(re, (m, ...rest) => {
    // never inside a placeholder or a kept part
    const off = rest[rest.length - 2], src = rest[rest.length - 1];
    if (typeof off === 'number' && isInside(src, off)) return m;
    return take(m);
  });
  // a sentence that still reads technical (a command handed over with its command gone, "in your terminal") goes whole
  const lines = t.split('\n').map(line => {
    const marker = (line.match(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/) || [''])[0];
    const parts = line.slice(marker.length).split(/(?<=[.!?])\s+/);
    const out = parts.map(sn => {
      const probe = sn.split(PLACEHOLDER).join(' ').replace(/\u0001\d+\u0001/g, ' ');
      const c = check(probe, 'plain', 'full');
      if (c.ok) return sn;
      if (mo.wordsOnly || (mo.ownerAimed && OWNER_AIMED.test(probe))) return sn;   // meant for the owner: keep it, its technical words already masked
      if (!technical.includes(sn.trim())) technical.push(sn.trim());
      return PLACEHOLDER + (/[.!?]$/.test(sn.trim()) ? '.' : '');
    });
    return marker + out.join(' ');
  });
  t = lines.join('\n');
  const esc = PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  t = t.replace(new RegExp('(?:' + esc + '[\\s,;:/-]*(?:and|or)?[\\s,;:/-]*){2,}', 'g'), m => PLACEHOLDER + (/\s$/.test(m) ? ' ' : ''));
  t = t.replace(/\(\s*\(a technical detail the crew handles\)\s*\)/g, PLACEHOLDER).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[Number(i)]);
  return { text: t.trim(), technical };
}
function isInside(src, off) {
  const i = src.lastIndexOf(PLACEHOLDER, off);
  if (i >= 0 && off < i + PLACEHOLDER.length) return true;
  const before = src.slice(0, off); const n = (before.match(/\u0001/g) || []).length;
  return n % 2 === 1;
}

/* ---------- the note a reply sent back carries ---------- */
const KIND_SAY = { command: 'a command', path: 'a file path', tool: 'a file or tool name', model: 'a model name', id: 'an id', code: 'code', jargon: 'technical words', length: 'its length' };
function recheckNote(problems, level, o) {
  o = o || {};
  const c = cmdLib();
  const PREFIX = c ? c.CHECK_PREFIX : '[Console check, not from the owner:';
  const O = ownerName(o);
  const talk = (problems || []).filter(p => p.kind !== 'command' || !o.command);
  const cap = capOf({ length: o.length, limits: o.limits });
  const listed = talk.filter(p => p.kind !== 'length').map(p => KIND_SAY[p.kind] + ' (' + p.words.slice(0, 4).join(', ') + ')');
  const long = talk.find(p => p.kind === 'length');
  const lv = level === 'some' ? O + ' chose some detail: a technical word only with its meaning in the same sentence, and never a command or a file path.'
    : level === 'plain' ? O + ' chose plain words: no technical terms, no commands, file names, tool names or model names. Say what it means for them; the details stay with the crew.'
      : O + ' chose technical detail, but never a command to run.';
  const part = (listed.length ? 'it was more technical than ' + O + ' asked for: ' + listed.join('; ') : '') + (long ? (listed.length ? '; and ' : 'it was too long: ') + long.words[0] + (Number.isFinite(cap) ? ', and ' + O + ' asked for about ' + cap : '') : '');
  if (o.command && c) {
    const base = c.recheckNote(o.command);
    if (!part) return base;
    return base.replace(/\]\s*$/, '') + ' It was also not shown because ' + part + '. ' + lv + (Number.isFinite(cap) ? ' Keep it under about ' + cap + ' words.' : '') + ']';
  }
  return PREFIX + ' your reply was NOT shown to the owner, because ' + (part || 'it was more technical than ' + O + ' asked for') + '. ' + lv + (Number.isFinite(cap) ? ' Keep it under about ' + cap + ' words.' : '') + ' If they need to act, link the console button. Write your reply to the owner again.]';
}

/* ---------- the record ---------- */
function record(row, o) {
  const f = files(o);
  const r = Object.assign({ at: new Date().toISOString() }, row);
  try { fs.mkdirSync(path.dirname(f.checks), { recursive: true }); fs.appendFileSync(f.checks, JSON.stringify(r) + '\n'); } catch (_) {}
  return r;
}
function stats(o) {
  const f = files(o); const days = Number(o && o.days) > 0 ? Number(o.days) : 30;
  let txt = ''; try { txt = require('./bounded').tailText(f.checks, 4 * 1024 * 1024); } catch (_) {}
  const cut = Date.now() - days * 86400e3; const out = { days, rows: 0, delivered: 0, 'sent-back': 0, masked: 0, shadow: 0, wouldSendBack: 0 };
  for (const l of txt.split('\n')) {
    if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; }
    if (!r || Date.parse(r.at) < cut) continue;
    out.rows++; if (out[r.action] !== undefined) out[r.action]++;
    if (r.action === 'shadow' && Array.isArray(r.problems) && r.problems.length) out.wouldSendBack++;
  }
  return out;
}
function examples(o) {
  const f = files(o);
  return readJ(f.examples, null) || readJ(path.join(REPO, 'company', 'defaults', 'owner', 'talk-examples.json'), { messages: [] });
}

module.exports = { OWNER_AIMED, prefs, block, check, mask, recheckNote, record, stats, examples, files, capOf, LEVELS, LENGTHS, OFTEN, CHECKS, MISSING, LIMITS, PLACEHOLDER, MASKED_NOTICE, TECH_TITLE };
