#!/usr/bin/env node
/* inbox.js — the owner (PM) inbox. Every question the company cannot answer within its authority goes here.
 *
 * The owner (the station Commander) is the PM. Agents ask; the owner answers; nothing guesses in the gap. The CEO
 * batches open questions and the dispatcher delivers the CEO's to company/owner/outbound.jsonl; an owner reply that
 * names the question id comes back through company/owner/inbound.jsonl (owner-inbox.js).
 *
 *   node company/tools/inbox.js ask --from <name> --message "2-4 plain sentences" [--details "evidence, numbers"]
 *        [--about <project>] [--blocking] [--kind <shortcut> + its flags | --form '<json>']     (--q is the old form)
 *   node company/tools/inbox.js list [--open] [--from <name>]
 *   node company/tools/inbox.js answer --id q-0003 --a "yes: rotate it" --by Commander [--answer '<json>'] [--quiet]
 *   node company/tools/inbox.js snooze --id q-0003 --until <ISO time> --by Commander
 *   node company/tools/inbox.js close --id q-0003
 *   node company/tools/inbox.js --selftest
 *
 * HOW A QUESTION READS. `--message` is what the owner sees first: 2-4 conversational sentences — what you need, why,
 * what happens if they say no. Evidence, numbers, alternatives and ids go in `--details`, shown collapsed under "More
 * detail". `ask` warns (field `warnings`) when there is no message, or it is long (> 400 chars) or dense with jargon.
 * An old question with only `q` shows its first two sentences as the message and the rest as detail.
 *
 * A QUESTION IS A FORM the asker composes (`--form '{"fields":[...],"actions":[...]}'`), any number and mix of fields:
 *   info      {text}                                   read-only text (markdown)
 *   text      {multiline?, minLength?, maxLength?, placeholder?}
 *   secret    {name, provider?, validate?}             a password field; the CONSOLE SERVER writes secrets/<name> (0600)
 *             and the answer carries only {stored: "secrets/<name>", chars, validated}. `validate` = a station provider
 *             id to check the key with (/api/providers/validate). The value never reaches this file or any message.
 *   choice    {options: [{id, label, recommended?}], multi?, allowOther?}
 *   link      {url (http/https), action: what to do there}   the owner marks it done / couldn't
 *   number    {unit?, min?, max?}     date {min?, max? YYYY-MM-DD}     checkbox {}  (a yes/no tick)
 *   slider    {min, max, step?, value (the suggested value), unit?, marks?: [{value, label}], minLabel?, maxLabel?,
 *             say?: "Let routines use up to {value}% of this week's Claude", sayAt?: {"0": "a whole sentence for 0"}}
 *             a range the owner drags (keyboard: arrows,
 *             Page Up/Down, Home/End); the card shows `say` with the live value in plain words. The answer must be in
 *             [min, max] and on a step from min; it is checked here, server-side, not only in the browser.
 * Every field has {id, type, label, help?, required?}. `actions` are the buttons, each {id, label, verdict, primary?,
 * needs?}: verdict is one of yes, no, submit, done, couldnt, declined (yes/no is what lib/governance approved() reads);
 * needs is "fields" (the required fields must be filled; default for yes/submit/done), "none", or a list of field ids.
 * Limits: 20 fields, 6 actions, 30 options, ids [a-z][a-z0-9_-]*, http(s) links only; an unsafe form is refused with
 * the reason. Every question also takes a free Reply, Snooze and Discuss in the console.
 *
 * SHORTCUTS (--kind) expand to a form: approve (default: Approve / Decline + reason), choice (--options "id:Label,..."
 * [--recommended id] [--allow-other] [--multi]), text ([--min N] [--max N] [--placeholder]), secret (--name <file>
 * [--label] [--provider "where to get it"] [--validate <provider id>]), link (--url --action), account (--url --action
 * --fields "id:Label,..."; non-secret fields only), number ([--unit] [--min] [--max]), date ([--min] [--max]),
 * slider (--min --max [--step] [--value] [--unit] [--say "... {value} ..."] [--min-label] [--max-label]).
 * `--spec '<json>'` gives the shortcut's fields as JSON.
 *
 * ANSWERS are stored as { type:'answer', id, a: <plain words>, answer: {verdict, action, values, note?}, by } and,
 * unless --quiet, delivered to the asker as an owner message (company/owner/inbound.jsonl, `re` the question id,
 * opening with the asker's name so owner-addressing.js routes it): the dispatcher's owner-message wake is how the
 * asker hears the answer. A secret arrives as "stored at secrets/<name>": read it with co.secret('<name>') in a tool,
 * under the secrets guardrail; never print it.
 *
 * Only `answer`/`close`/`snooze` require --by Commander (or --by owner, or the owner's name from company/company.json).
 * An agent may ask, never resolve its own question.
 *
 * Also a module: `require('./inbox.js').openQuestions()` is the single source of truth for "what is an open PM
 * question". ask(), answer(), snooze(), normalizeForm(), expandKind(), formOf(), plainAnswer(), secretHint(),
 * messageParts() are exported. Env PM_INBOX_FILE overrides the file (tests only).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const FILE = () => process.env.PM_INBOX_FILE || co.p('company', 'pm-inbox.jsonl');
const isOwner = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'commander' || b === 'owner' || b === String(co.config.owner.name || '').trim().toLowerCase()); };

const KINDS = ['approve', 'choice', 'text', 'secret', 'link', 'account', 'number', 'date', 'slider'];
const FIELD_TYPES = ['info', 'text', 'secret', 'choice', 'link', 'number', 'date', 'checkbox', 'slider'];
const VERDICTS = ['yes', 'no', 'submit', 'done', 'couldnt', 'declined'];
const LIMITS = { fields: 20, actions: 6, options: 30, label: 200, help: 1000, info: 4000, message: 2000, details: 20000, value: 20000 };
const MESSAGE_SOFT = 400;
// a file name under secrets/ the console may write: letters, digits, dot, dash, underscore; never the station's own
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const RESERVED_SECRETS = new Set(['readme.md', 'station-token', 'console-token']);
const safeSecretName = n => SECRET_NAME.test(String(n || '')) && !RESERVED_SECRETS.has(String(n).toLowerCase()) && !String(n).includes('..');
const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] || 'list' };
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
function readAll() {
  try { return fs.readFileSync(FILE(), 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; }
}
function append(row) { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.appendFileSync(FILE(), JSON.stringify(row) + '\n'); }
function state() {
  const by = {};
  for (const r of readAll()) {
    if (r.type === 'ask') by[r.id] = Object.assign({}, r);
    if (r.type === 'answer' || r.type === 'close') Object.assign(by[r.id] = by[r.id] || {}, r);
    if (r.type === 'reclassify') Object.assign(by[r.id] = by[r.id] || {}, { reclassified: r.note, by: r.by });
    if (r.type === 'snooze') Object.assign(by[r.id] = by[r.id] || {}, { snoozedUntil: r.until || null, snoozedAt: r.at });
  }
  return by;
}

/* ---- message: plain words first, detail under "More detail" ---- */
function sentences(t) { return String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z("'`*\[])/); }
/* messageParts(row) -> { message, details, derived } — a row without `message` shows its first two sentences. */
function messageParts(r) {
  if (r && r.message) return { message: String(r.message), details: r.details ? String(r.details) : '', derived: false };
  const q = String((r && r.q) || '').trim();
  const lines = q.split('\n'); const first = lines[0] || '';
  const ss = sentences(first); let msg = ss.slice(0, 2).join(' ');
  if (msg.length > MESSAGE_SOFT) msg = ss[0].length <= MESSAGE_SOFT ? ss[0] : ss[0].slice(0, MESSAGE_SOFT - 1).replace(/\s+\S*$/, '') + '…';
  const rest = q.slice(Math.min(q.length, q.indexOf(msg.replace(/…$/, '')) + msg.replace(/…$/, '').length)).trim();
  return { message: msg, details: msg.endsWith('…') ? q : rest, derived: true };
}
const JARGON = [/`[^`]+`/g, /\b[\w./-]+\.(js|json|jsonl|md|py|sh)\b/g, /\bq-\d{6}\b/g, /\b(HTTP|API|SDK|REST|PnL|ms|Hz|p\d\d)\b/g, /\d+(\.\d+)?\s?(ms|s|Hz|%)\b/g, /\([^)]{25,}\)/g];
/* styleWarnings(message, details) -> [plain advice to the asker] */
function styleWarnings(message, details) {
  const w = [];
  if (!message) return ['no --message: the owner sees the first two sentences of --q. Write 2-4 plain sentences (what you need, why, what happens if they say no) and move evidence to --details.'];
  if (message.length > MESSAGE_SOFT) w.push('the message is ' + message.length + ' characters; keep it under ' + MESSAGE_SOFT + ' and move the rest to --details.');
  const hits = JARGON.reduce((n, re) => n + (message.match(re) || []).length, 0);
  if (hits >= 3) w.push('the message reads like a report (' + hits + ' ids, paths, units or abbreviations); say it the way you would to a person and put the numbers in --details.');
  if (sentences(message).length > 5) w.push('the message has ' + sentences(message).length + ' sentences; 2-4 is enough.');
  return w;
}

/* ---- the form ---- */
const num = v => (v === undefined || v === null || v === '' || v === true) ? undefined : Number(v);
const httpUrl = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) && !x.username && !x.password ? x.toString() : null; } catch (_) { return null; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40);
// "id:Label,id2:Label two" (or "Label,Label two") -> [{id,label}]
function parseList(s) {
  if (Array.isArray(s)) return s;
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf(':'); const id = (i > 0 ? x.slice(0, i) : x).trim(); const label = (i > 0 ? x.slice(i + 1) : x).trim();
    return { id: slug(id) || 'option', label };
  });
}
const str = (v, max, what) => {
  if (v === undefined || v === null || v === true || v === false) return undefined;
  const s = String(v).trim(); if (!s) return undefined;
  if (s.length > max) throw new Error(what + ' is longer than ' + max + ' characters');
  return s;
};
/* normalizeForm({fields, actions}) -> a checked copy, or throws Error with a reason the asker can fix. */
function normalizeForm(form) {
  const f0 = form && typeof form === 'object' ? form : {};
  const fields = Array.isArray(f0.fields) ? f0.fields : f0.fields === undefined ? [] : null;
  const actions = Array.isArray(f0.actions) ? f0.actions : f0.actions === undefined ? [] : null;
  if (!fields || !actions) throw new Error('form.fields and form.actions must be lists');
  if (fields.length > LIMITS.fields) throw new Error('at most ' + LIMITS.fields + ' fields');
  if (actions.length > LIMITS.actions) throw new Error('at most ' + LIMITS.actions + ' actions');
  const ids = new Set(); const secretNames = new Set();
  const outF = fields.map((x, i) => {
    if (!x || typeof x !== 'object') throw new Error('field ' + (i + 1) + ' is not an object');
    const type = String(x.type || '').toLowerCase();
    if (!FIELD_TYPES.includes(type)) throw new Error('field ' + (i + 1) + ': unknown type "' + x.type + '" (one of ' + FIELD_TYPES.join(', ') + (/file|upload/.test(type) ? '; file uploads are not supported, ask for a link instead' : '') + ')');
    const id = String(x.id || '').trim() || type + (i + 1);
    if (!ID.test(id)) throw new Error('field id "' + id + '": use lowercase letters, digits, - or _ (start with a letter)');
    if (ids.has(id)) throw new Error('two fields are called "' + id + '"'); ids.add(id);
    const o = { id, type, label: str(x.label, LIMITS.label, 'field ' + id + ' label'), help: str(x.help, LIMITS.help, 'field ' + id + ' help') };
    if (type !== 'info' && !o.label) throw new Error('field ' + id + ' needs a label');
    if (x.required !== undefined) o.required = !!x.required;
    if (type === 'info') { o.text = str(x.text, LIMITS.info, 'info ' + id); if (!o.text) throw new Error('info field ' + id + ' needs text'); delete o.required; }
    if (type === 'text') {
      if (x.multiline) o.multiline = true;
      o.minLength = num(x.minLength !== undefined ? x.minLength : x.min); o.maxLength = num(x.maxLength !== undefined ? x.maxLength : x.max);
      for (const k of ['minLength', 'maxLength']) if (o[k] !== undefined && !(Number.isInteger(o[k]) && o[k] >= 0 && o[k] <= LIMITS.value)) throw new Error('field ' + id + ': ' + k + ' must be a whole number from 0 to ' + LIMITS.value);
      if (o.minLength !== undefined && o.maxLength !== undefined && o.minLength > o.maxLength) throw new Error('field ' + id + ': minLength is above maxLength');
      o.placeholder = str(x.placeholder, 200, 'field ' + id + ' placeholder');
      if (/pass(word)?|secret|api[-_ ]?key|token|private key/i.test(id + ' ' + o.label)) throw new Error('field ' + id + ' asks for a secret in a text field: use type "secret" (the key is stored as a file, never written in the answer)');
    }
    if (type === 'secret') {
      o.name = String(x.name || '').trim();
      if (!safeSecretName(o.name)) throw new Error('secret field ' + id + ' needs name: a plain file name under secrets/ (letters, digits, . _ -; not station-token or console-token), e.g. kalshi-api-key');
      if (secretNames.has(o.name)) throw new Error('two secret fields write secrets/' + o.name); secretNames.add(o.name);
      o.provider = str(x.provider, 300, 'field ' + id + ' provider');
      if (x.validate) { o.validate = String(x.validate).trim(); if (!/^[a-z0-9_-]{1,40}$/i.test(o.validate)) throw new Error('field ' + id + ': validate is a station provider id, e.g. deepseek'); }
      if (x.multiline) o.multiline = true;   // a PEM private key
      if (o.required === undefined) o.required = true;
      if (x.hinted) o.hinted = true;
    }
    if (type === 'choice') {
      const opts = parseList(x.options);
      if (opts.length > LIMITS.options) throw new Error('field ' + id + ': at most ' + LIMITS.options + ' options');
      o.options = opts.map(p => typeof p === 'string' ? parseList(p)[0] : p).filter(p => p && (p.id || p.label)).map(p => {
        const oid = slug(p.id || p.label) || 'option'; const lab = str(p.label || p.id, LIMITS.label, 'option label');
        return Object.assign({ id: oid, label: lab }, p.recommended ? { recommended: true } : {});
      });
      if (x.recommended) for (const p of o.options) if (p.id === String(x.recommended).toLowerCase()) p.recommended = true;
      if (o.options.length < (x.allowOther ? 1 : 2)) throw new Error('choice field ' + id + ' needs at least two options');
      if (new Set(o.options.map(p => p.id)).size !== o.options.length) throw new Error('choice field ' + id + ': option ids must be different');
      if (x.multi) o.multi = true; if (x.allowOther) o.allowOther = true;
    }
    if (type === 'link') {
      o.url = httpUrl(x.url); if (!o.url) throw new Error('link field ' + id + ' needs url: http or https only');
      o.action = str(x.action, 500, 'field ' + id + ' action'); if (!o.action) throw new Error('link field ' + id + ' needs action: what the owner should do there');
    }
    if (type === 'number') {
      o.unit = str(x.unit, 20, 'unit'); o.min = num(x.min); o.max = num(x.max);
      for (const k of ['min', 'max']) if (o[k] !== undefined && !Number.isFinite(o[k])) throw new Error('field ' + id + ': ' + k + ' must be a number');
      if (o.min !== undefined && o.max !== undefined && o.min > o.max) throw new Error('field ' + id + ': min is above max');
    }
    if (type === 'slider') Object.assign(o, normalizeSlider(x, id));
    if (type === 'date') {
      o.min = str(x.min, 10, 'min'); o.max = str(x.max, 10, 'max');
      for (const k of ['min', 'max']) if (o[k] && !ISO_DATE.test(o[k])) throw new Error('field ' + id + ': ' + k + ' must be YYYY-MM-DD');
    }
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
  });
  const aids = new Set();
  let outA = actions.map((x, i) => {
    if (!x || typeof x !== 'object') throw new Error('action ' + (i + 1) + ' is not an object');
    const label = str(x.label, 80, 'action label'); if (!label) throw new Error('action ' + (i + 1) + ' needs a label');
    const id = String(x.id || slug(label)).trim();
    if (!ID.test(id)) throw new Error('action id "' + id + '": use lowercase letters, digits, - or _');
    if (aids.has(id)) throw new Error('two actions are called "' + id + '"'); aids.add(id);
    const verdict = String(x.verdict || 'submit').toLowerCase();
    if (!VERDICTS.includes(verdict)) throw new Error('action ' + id + ': verdict must be one of ' + VERDICTS.join(', '));
    const o = { id, label, verdict };
    if (x.primary) o.primary = true;
    if (Array.isArray(x.needs)) { for (const n of x.needs) if (!ids.has(String(n))) throw new Error('action ' + id + ' needs a field that does not exist: ' + n); o.needs = x.needs.map(String); }
    else o.needs = x.needs === 'none' || x.needs === 'fields' ? x.needs : (['yes', 'submit', 'done'].includes(verdict) ? 'fields' : 'none');
    return o;
  });
  const answerable = outF.some(f => f.type !== 'info');
  if (!outA.length) outA = answerable ? [{ id: 'send', label: 'Send', verdict: 'submit', primary: true, needs: 'fields' }] : [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true, needs: 'fields' }, { id: 'decline', label: 'Decline', verdict: 'no', needs: 'none' }];
  if (!outA.some(a => a.primary)) outA[0].primary = true;
  return { fields: outF, actions: outA };
}
/* a slider's checked settings: finite min < max, step > 0 (at most 1000 steps), value and marks in range and on a step */
const onStep = (n, f) => { const k = (n - f.min) / f.step; return Math.abs(k - Math.round(k)) < 1e-6; };
function normalizeSlider(x, id) {
  const o = { min: num(x.min), max: num(x.max), step: num(x.step) === undefined ? 1 : num(x.step) };
  for (const k of ['min', 'max', 'step']) if (!Number.isFinite(o[k])) throw new Error('slider ' + id + ': ' + k + ' must be a number');
  if (!(o.min < o.max)) throw new Error('slider ' + id + ': min must be below max');
  if (!(o.step > 0)) throw new Error('slider ' + id + ': step must be above 0');
  if ((o.max - o.min) / o.step > 1000) throw new Error('slider ' + id + ': at most 1000 steps from min to max');
  o.value = num(x.value) === undefined ? o.min : num(x.value);
  if (!Number.isFinite(o.value) || o.value < o.min || o.value > o.max) throw new Error('slider ' + id + ': value (the suggestion) must be from ' + o.min + ' to ' + o.max);
  if (!onStep(o.value, o)) throw new Error('slider ' + id + ': value ' + o.value + ' is not on a step of ' + o.step + ' from ' + o.min);
  o.unit = str(x.unit, 20, 'unit'); o.minLabel = str(x.minLabel, 80, 'minLabel'); o.maxLabel = str(x.maxLabel, 80, 'maxLabel');
  o.say = str(x.say, 300, 'field ' + id + ' say');
  if (o.say && !o.say.includes('{value}')) throw new Error('slider ' + id + ': say must contain {value} (the live value in plain words)');
  if (x.sayAt !== undefined) {   // whole sentences for particular values (the ends, usually), e.g. {"0": "Spread evenly"}
    if (!x.sayAt || typeof x.sayAt !== 'object' || Array.isArray(x.sayAt) || Object.keys(x.sayAt).length > 12) throw new Error('slider ' + id + ': sayAt is an object of at most 12 {value: sentence}');
    o.sayAt = {};
    for (const [k, t] of Object.entries(x.sayAt)) { const v = Number(k); if (!Number.isFinite(v) || v < o.min || v > o.max) throw new Error('slider ' + id + ': sayAt ' + k + ' is outside ' + o.min + '-' + o.max); o.sayAt[String(v)] = str(t, 300, 'sayAt'); }
  }
  if (x.marks !== undefined) {
    if (!Array.isArray(x.marks) || x.marks.length > 12) throw new Error('slider ' + id + ': marks is a list of at most 12 {value, label}');
    o.marks = x.marks.map(m => {
      const v = num(m && m.value); if (!Number.isFinite(v) || v < o.min || v > o.max) throw new Error('slider ' + id + ': a mark is outside ' + o.min + '-' + o.max);
      return { value: v, label: str(m.label, 40, 'mark label') || String(v) };
    });
  }
  return o;
}
// the live value in plain words: the asker's `say` sentence, else "Label: 80 %"
function sliderWords(f, v) {
  const val = String(Math.round(Number(v) * 1e6) / 1e6);
  if (f.sayAt && f.sayAt[val]) return f.sayAt[val];
  if (f.say) return f.say.split('{value}').join(val);
  return (f.label || f.id) + ': ' + val + (f.unit ? (/^[%°]/.test(f.unit) ? '' : ' ') + f.unit : '');
}
/* expandKind(kind, spec) -> {fields, actions}: the shortcuts. */
function expandKind(kind, spec) {
  const k = kind ? String(kind).trim().toLowerCase() : 'approve';
  if (!KINDS.includes(k)) throw new Error('unknown --kind ' + kind + ' (one of ' + KINDS.join(', ') + '; or compose your own with --form)');
  const s = spec && typeof spec === 'object' ? spec : {};
  const reason = { id: 'reason', type: 'text', multiline: true, label: 'Reason (optional)', required: false };
  const note = { id: 'note', type: 'text', multiline: true, label: 'Note (optional)', required: false };
  switch (k) {
    case 'approve': return { fields: [reason], actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true }, { id: 'decline', label: 'Decline', verdict: 'no' }] };
    case 'choice': return { fields: [{ id: 'choice', type: 'choice', label: s.label || 'Your choice', options: s.options, recommended: s.recommended, multi: s.multi, allowOther: s.allowOther, required: true }, note],
      actions: [{ id: 'choose', label: 'Choose', verdict: 'submit', primary: true }] };
    case 'text': return { fields: [{ id: 'answer', type: 'text', multiline: true, label: s.label || 'Your answer', minLength: s.minLength !== undefined ? s.minLength : s.min, maxLength: s.maxLength !== undefined ? s.maxLength : s.max, placeholder: s.placeholder, required: true }],
      actions: [{ id: 'send', label: 'Send answer', verdict: 'submit', primary: true }] };
    case 'secret': return { fields: [{ id: 'key', type: 'secret', label: s.label || 'The key', name: s.name, provider: s.provider, validate: s.validate, multiline: s.multiline, required: true }, note],
      actions: [{ id: 'store', label: 'Store it securely', verdict: 'done', primary: true }, { id: 'decline', label: 'I can\'t provide this', verdict: 'declined' }] };
    case 'link': return { fields: [{ id: 'link', type: 'link', label: s.label || 'Open the page', url: s.url, action: s.action, required: false }, note],
      actions: [{ id: 'done', label: 'Done', verdict: 'done', primary: true }, { id: 'couldnt', label: 'Couldn\'t do it', verdict: 'couldnt' }] };
    case 'account': return { fields: [{ id: 'link', type: 'link', label: s.label || 'Open the page', url: s.url, action: s.action, required: false }]
      .concat(parseList(s.fields).map(x => typeof x === 'string' ? parseList(x)[0] : x).map(x => ({ id: slug(x.id || x.label), type: 'text', label: x.label || x.id, placeholder: x.placeholder, required: x.required !== false }))).concat([note]),
      actions: [{ id: 'done', label: 'Done', verdict: 'done', primary: true }, { id: 'couldnt', label: 'Couldn\'t do it', verdict: 'couldnt' }] };
    case 'number': return { fields: [{ id: 'value', type: 'number', label: s.label || 'Your answer', unit: s.unit, min: s.min, max: s.max, required: true }], actions: [{ id: 'send', label: 'Send', verdict: 'submit', primary: true }] };
    case 'date': return { fields: [{ id: 'value', type: 'date', label: s.label || 'The date', min: s.min, max: s.max, required: true }], actions: [{ id: 'send', label: 'Send', verdict: 'submit', primary: true }] };
    case 'slider': return { fields: [{ id: 'value', type: 'slider', label: s.label || 'Your answer', min: s.min, max: s.max, step: s.step, value: s.value, unit: s.unit, marks: s.marks, minLabel: s.minLabel, maxLabel: s.maxLabel, say: s.say, sayAt: s.sayAt, required: true }, note],
      actions: [{ id: 'set', label: 'Set', verdict: 'submit', primary: true }] };
  }
}

/* secretHint(row) — an old question that asks for a key, token or credential (and has no secret field) gets a secure
 * field as an extra option, with a suggested file name. null when the text does not ask for one. */
function secretHint(q) {
  if (!q || (q.form && (q.form.fields || []).some(f => f.type === 'secret'))) return null;
  const t = String(q.q || '') + ' ' + String(q.message || '');
  if (!/\b(api[- ]?key|api[- ]?token|access token|credential|secret key|private key|password|key)\b/i.test(t)) return null;
  const skip = new Set(['a', 'an', 'the', 'free', 'read', 'only', 'read-only', 'new', 'second', 'first', 'our', 'your', 'own', 'one', 'paid', 'live', 'gate', 'api', 'no', 'its', 'their']);
  const W = '((?:[A-Za-z][\\w.-]*\\s+){1,3})';
  const m = t.match(new RegExp(W + '(?:api[- ]?key|api[- ]?token|access token)\\b', 'i')) || t.match(new RegExp(W + '(?:private key|secret key|token|key)\\b', 'i'));
  let base = '';
  if (m) { const words = m[1].trim().split(/\s+/).filter(w => !skip.has(w.toLowerCase().replace(/[^a-z-]/g, ''))); base = (words.pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  const kindWord = /private key/i.test(t) && !/api key/i.test(t) ? 'private-key' : /token/i.test((m && m[0]) || '') ? 'api-token' : 'api-key';
  const name = base && base.length <= 30 ? base + '-' + kindWord : 'key-' + String(q.id || 'x').replace(/^q-/, '');
  return { name: safeSecretName(name) ? name : 'key-' + String(q.id || 'x').replace(/[^a-z0-9]/gi, '') };
}
/* formOf(row) — the form a question is answered with: its own, or (an old row) Approve/Decline + reason. A row that
 * asks for a key without a secret field gets an optional secret field `key` and a "Store the key securely" action. */
function formOf(r) {
  const form = r && r.form ? r.form : normalizeForm(expandKind('approve'));
  const hint = secretHint(r);
  if (!hint) return form;
  return { fields: form.fields.concat([{ id: 'key', type: 'secret', label: 'The key (optional: only if this is what is asked for)', name: hint.name, multiline: true, required: false, hinted: true }]).filter((f, i, all) => all.findIndex(g => g.id === f.id) === i),
    actions: form.actions.concat([{ id: 'store-key', label: 'Store the key securely', verdict: 'done', needs: ['key'] }]) };
}

/* openQuestions() — the single definition of "an open PM question": an ask that has no answer and has not been
 * reclassified to company ownership. A snoozed question is still open; it carries snoozedUntil while the snooze runs. */
function openQuestions() {
  const now = Date.now();
  return Object.values(state())
    .filter(x => x.type === 'ask' && !x.a && !x.reclassified)
    .map(x => {
      const m = messageParts(x);
      const o = { id: x.id, from: x.from, about: x.about, q: x.q, message: m.message, details: m.details, messageDerived: m.derived,
        blocking: x.blocking, askedAt: x.at, batch: x.batch || null, kind: x.kind || (x.form ? 'form' : 'approve'), form: formOf(x) };
      if (x.snoozedUntil && Date.parse(x.snoozedUntil) > now) o.snoozedUntil = x.snoozedUntil;
      const hint = secretHint(x); if (hint) o.secretHint = hint;
      return o;
    });
}

function newId() {
  const used = new Set(readAll().map(r => r.id));
  let n = Number(String(Date.now()).slice(-6)); let id = 'q-' + String(n).padStart(6, '0');
  while (used.has(id)) { n = (n + 1) % 1e6; id = 'q-' + String(n).padStart(6, '0'); }
  return id;
}
/* ask({from, about, message, details, q, blocking, kind, spec, form}) -> { row, warnings }. Throws on an unsafe form. */
function ask(o) {
  const message = str(o.message, LIMITS.message, 'the message');
  const details = str(o.details, LIMITS.details, 'the details');
  const q = message ? message + (details ? '\n\n' + details : '') : String(o.q || '').trim();
  if (!q) throw new Error('--message is required (2-4 plain sentences; old form: --q)');
  if (String(q).length > LIMITS.details + LIMITS.message) throw new Error('the question is too long');
  let kind = o.kind ? String(o.kind).toLowerCase() : null, form;
  if (o.form) { form = normalizeForm(typeof o.form === 'string' ? JSON.parse(o.form) : o.form); kind = 'form'; }
  else { form = normalizeForm(expandKind(kind || 'approve', o.spec)); kind = kind || 'approve'; }
  const row = { type: 'ask', id: newId(), at: new Date().toISOString(), from: String(o.from || 'unknown'), about: String(o.about || ''), q, blocking: !!o.blocking };
  if (message) row.message = message; if (details) row.details = details;
  if (kind !== 'approve') { row.kind = kind; row.form = form; }
  if (o.batch) row.batch = o.batch; if (o.gate) row.gate = o.gate;
  append(row);
  return { row, warnings: styleWarnings(message, details) };
}

/* ---- answers ---- */
const yesNo = v => v === true ? 'yes' : v === false ? 'no' : 'not checked';
function titleOf(q) { return messageParts(q).message.replace(/^Approval needed \([^)]*\):\s*/i, '').slice(0, 140); }
/* checkAnswer(row, {action, verdict?, values, note}) -> the structured answer, or throws Error (a plain reason).
 * Secret fields carry {stored, chars, validated} — the console server stores the file first; a raw value is refused. */
function checkAnswer(row, raw) {
  const form = formOf(row); const a = raw || {};
  const note = a.note === undefined || a.note === null ? '' : String(a.note).trim().slice(0, LIMITS.value);
  if (a.verdict === 'reply') { const t = String(a.value || note).trim(); if (!t) throw new Error('a reply needs text'); return { verdict: 'reply', value: t.slice(0, LIMITS.value) }; }
  let act = form.actions.find(x => x.id === a.action);
  if (!act && !a.action && a.verdict) act = form.actions.find(x => x.verdict === a.verdict);
  if (!act) throw new Error(a.action ? 'no action "' + a.action + '" on this question (' + form.actions.map(x => x.id).join(', ') + ')' : 'say which action (' + form.actions.map(x => x.id).join(', ') + ')');
  const need = act.needs === 'none' ? new Set() : Array.isArray(act.needs) ? new Set(act.needs) : new Set(form.fields.filter(f => f.required).map(f => f.id));
  const vals = a.values && typeof a.values === 'object' ? a.values : {};
  const out = { verdict: act.verdict, action: act.id, values: {} };
  for (const f of form.fields) {
    if (f.type === 'info') continue;
    let v = vals[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (f.type === 'checkbox' && v === false && need.has(f.id));
    if (empty) { if (need.has(f.id)) throw new Error((f.label || f.id) + ': ' + (f.type === 'checkbox' ? 'tick it' : f.type === 'secret' ? 'paste the key' : f.type === 'slider' ? 'set the slider' : 'fill it in')); continue; }
    if (act.needs === 'none' && !Array.isArray(act.needs) && f.type === 'secret') continue;   // declining never stores a key
    if (f.type === 'text') {
      const t = String(v).trim(); if (f.minLength && t.length < f.minLength) throw new Error((f.label || f.id) + ': at least ' + f.minLength + ' characters, please (' + t.length + ' written)');
      if (t.length > (f.maxLength || LIMITS.value)) throw new Error((f.label || f.id) + ': at most ' + (f.maxLength || LIMITS.value) + ' characters (' + t.length + ' written)');
      if (t) out.values[f.id] = t;
    } else if (f.type === 'secret') {
      if (typeof v !== 'object' || 'value' in v || !/^secrets\/[A-Za-z0-9._-]+$/.test(String(v.stored || ''))) throw new Error((f.label || f.id) + ': a key is stored by the console (secrets/<name>), never written into an answer');
      if (!f.hinted && v.stored !== 'secrets/' + f.name) throw new Error((f.label || f.id) + ': stored at the wrong name');
      out.values[f.id] = { stored: v.stored, chars: Number(v.chars) || 0, validated: v.validated === true ? true : v.validated === false ? false : null };
      if (v.validateError) out.values[f.id].validateError = String(v.validateError).slice(0, 200);
    } else if (f.type === 'choice') {
      const list = (Array.isArray(v) ? v : [v]).map(x => String(x).trim()).filter(Boolean);
      if (!f.multi && list.length > 1) throw new Error((f.label || f.id) + ': choose one');
      for (const x of list) if (!f.options.some(p => p.id === x) && !f.allowOther) throw new Error((f.label || f.id) + ': not one of the options: ' + x);
      out.values[f.id] = f.multi ? list.map(x => x.slice(0, 2000)) : list[0].slice(0, 2000);
    } else if (f.type === 'link') {
      if (!['done', 'couldnt'].includes(v)) throw new Error((f.label || f.id) + ': done or couldnt'); out.values[f.id] = v;
    } else if (f.type === 'number') {
      const n = Number(v); if (!Number.isFinite(n)) throw new Error((f.label || f.id) + ': a number, please');
      if (f.min !== undefined && n < f.min) throw new Error((f.label || f.id) + ': at least ' + f.min); if (f.max !== undefined && n > f.max) throw new Error((f.label || f.id) + ': at most ' + f.max);
      out.values[f.id] = n;
    } else if (f.type === 'date') {
      const d = String(v).trim(); if (!ISO_DATE.test(d) || isNaN(Date.parse(d + 'T00:00:00Z'))) throw new Error((f.label || f.id) + ': a date, YYYY-MM-DD');
      if (f.min && d < f.min) throw new Error((f.label || f.id) + ': on or after ' + f.min); if (f.max && d > f.max) throw new Error((f.label || f.id) + ': on or before ' + f.max);
      out.values[f.id] = d;
    } else if (f.type === 'checkbox') out.values[f.id] = v === true || v === 'true' || v === 'on';
    else if (f.type === 'slider') {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new Error((f.label || f.id) + ': a number from ' + f.min + ' to ' + f.max + ', please');
      if (n < f.min || n > f.max) throw new Error((f.label || f.id) + ': from ' + f.min + ' to ' + f.max + ' (' + n + ' is outside)');
      if (!onStep(n, f)) throw new Error((f.label || f.id) + ': in steps of ' + f.step + ' from ' + f.min + ' (' + n + ' is between steps)');
      out.values[f.id] = Math.round(n * 1e6) / 1e6;
    }
  }
  for (const k of Object.keys(vals)) if (!form.fields.some(f => f.id === k)) throw new Error('no field "' + k + '" on this question');
  // a single yes/no choice answers a governance question like Approve/Decline
  if (act.verdict === 'submit') { const ch = form.fields.filter(f => f.type === 'choice' && !f.multi); if (ch.length === 1 && /^(yes|no)$/.test(out.values[ch[0].id] || '')) out.verdict = out.values[ch[0].id]; }
  if (note) out.note = note;
  return out;
}
/* plainAnswer(row, answer) — the owner's answer in plain words, for the asker and the answer row's `a`. A yes/no
 * verdict opens with "yes"/"no" so old readers (lib/governance verdict()) still understand it. */
function plainAnswer(row, ans) {
  const a = ans || {}; if (a.verdict === 'reply') return String(a.value || '');
  const form = formOf(row); const act = form.actions.find(x => x.id === a.action);
  const parts = [];
  const head = a.verdict === 'yes' ? 'yes' : a.verdict === 'no' ? 'no' : null;
  const label = act ? act.label : a.verdict;
  if (head) parts.push(head + (act && !/^(approve|decline|yes|no)$/i.test(act.label) ? ' (' + act.label + ')' : '') + '.');
  else if (a.verdict === 'submit' && /^(send( answer)?|submit|choose|ok|answer)$/i.test(label)) { /* a plain Send says nothing */ }
  else if (a.verdict === 'done' && /^(done|store (it|the key) securely)$/i.test(label)) { if (!form.fields.some(f => f.type === 'secret' && (a.values || {})[f.id])) parts.push('Done.'); }
  else parts.push(a.verdict === 'couldnt' ? 'I could not do it ("' + label + '").' : a.verdict === 'declined' ? 'I will not provide this ("' + label + '").' : label + '.');
  for (const f of form.fields) {
    const v = (a.values || {})[f.id]; if (v === undefined) continue;
    const L = f.label ? f.label.replace(/\s*\(optional[^)]*\)\s*$/i, '') : f.id;
    if (f.type === 'secret') parts.push(L + ': stored at ' + v.stored + ' (' + v.chars + ' chars, validated: ' + yesNo(v.validated) + (v.validated === false && v.validateError ? ', ' + v.validateError : '') + '). Read it with co.secret(\'' + String(v.stored).replace(/^secrets\//, '') + '\'); never print, log or paste it.');
    else if (f.type === 'choice') { const nm = x => { const p = (f.options || []).find(o => o.id === x); return p ? '"' + p.label + '" (' + p.id + ')' : '"' + x + '" (my own answer)'; }; parts.push(L + ': ' + (Array.isArray(v) ? v.map(nm).join(', ') : nm(v)) + '.'); }
    else if (f.type === 'link') parts.push(L + ' (' + f.url + '): ' + (v === 'done' ? 'done' : 'could not do it') + '.');
    else if (f.type === 'number') parts.push(L + ': ' + v + (f.unit ? ' ' + f.unit : '') + '.');
    else if (f.type === 'checkbox') parts.push(L + ': ' + (v ? 'yes' : 'no') + '.');
    else if (f.type === 'slider') parts.push(sliderWords(f, v).replace(/[.!?]?$/, '.'));
    else if (f.type === 'text' && f.multiline && /^(reason|note|answer)$/.test(f.id)) parts.push(v);
    else parts.push(L + ': ' + v + (/[.!?]$/.test(v) ? '' : '.'));
  }
  if (a.note) parts.push(a.note);
  return parts.join(' ').replace(/\s+$/, '');
}
// a legacy text answer ("yes: go ahead", "no", anything else) as a structured answer
function fromText(text, row) {
  const t = String(text || '').trim();
  const m = /^(yes|no)\b[:,.\s-]*([\s\S]*)$/i.exec(t);
  const form = formOf(row);
  if (m && form.actions.some(x => x.verdict === m[1].toLowerCase())) { const v = m[1].toLowerCase(); const note = m[2].trim(); return { verdict: v, values: note && form.fields.some(f => f.id === 'reason') ? { reason: note } : {}, note: note && !form.fields.some(f => f.id === 'reason') ? note : undefined }; }
  return { verdict: 'reply', value: t };
}
// the asker's crew name when it is one (owner-addressing.js routes a message that opens with it)
function askerName(from) {
  const f = String(from || '').trim().toLowerCase(); if (!f) return null;
  try { for (const c of Object.values(co.crew() || {})) { const n = c && c.name ? String(c.name) : ''; if (n && (n.toLowerCase() === f || n.split(/\s+/)[0].toLowerCase() === f)) return n.split(/\s+/)[0]; } } catch (_) {}
  return null;
}
/* deliver(question, plain) — the answer as an owner message to the asker (company/owner/inbound.jsonl). */
function deliver(q, plain) {
  const oi = require('./owner-inbox.js');
  const who = askerName(q.from);
  const text = (who ? who + ', ' : '') + 'my answer to your question ' + q.id + (titleOf(q) ? ' ("' + titleOf(q).replace(/"/g, "'") + '")' : '') + ': ' + plain;
  const row = { id: 'in-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(),
    from: (co.config.owner && co.config.owner.name) || 'owner', text, re: q.id, via: 'inbox.js answer' };
  const file = oi.INBOUND(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}
/* answer({id, by, answer|text, quiet}) — record the owner's answer. Returns {ok, id, state, a, answer, delivered}. */
function answer(o) {
  if (!isOwner(o.by)) { const e = new Error('only the Commander (the owner, the PM) can answer or close a question'); e.code = 3; throw e; }
  const id = String(o.id || ''); if (!id) throw new Error('--id is required');
  const q = state()[id];
  if (!q || q.type !== 'ask') { const e = new Error('no question ' + id); e.code = 4; throw e; }
  const structured = checkAnswer(q, o.answer || fromText(o.text, q));
  const plain = plainAnswer(q, structured).trim() || structured.verdict;
  append({ type: 'answer', id, at: new Date().toISOString(), a: plain, answer: structured, by: 'Commander' });
  let delivered = null;
  if (!o.quiet) { try { delivered = deliver(q, plain).id; } catch (_) {} }
  return { ok: true, id, state: 'answered', a: plain, answer: structured, delivered };
}
/* snooze({id, until, by}) — hide an open question from Today until `until` (at most 30 days); the asker sees it in list. */
function snooze(o) {
  if (!isOwner(o.by)) { const e = new Error('only the owner can snooze a question'); e.code = 3; throw e; }
  const id = String(o.id || ''); const q = state()[id];
  if (!q || q.type !== 'ask' || q.a || q.reclassified) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  const t = Date.parse(o.until);
  if (!Number.isFinite(t) || t <= Date.now() || t > Date.now() + 31 * 86400e3) throw new Error('--until must be a time in the next 30 days');
  const until = new Date(t).toISOString();
  append({ type: 'snooze', id, at: new Date().toISOString(), until, by: 'Commander' });
  return { ok: true, id, snoozedUntil: until };
}
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }

module.exports = { openQuestions, state, readAll, ask, answer, snooze, normalizeForm, expandKind, formOf, checkAnswer, plainAnswer, secretHint, sliderWords,
  messageParts, styleWarnings, safeSecretName, KINDS, FIELD_TYPES, VERDICTS, FILE };

/* ---- selftest: a scratch inbox, owner dir and governance root ---- */
function selftest() {
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-selftest-'));
  process.env.PM_INBOX_FILE = path.join(T, 'company', 'pm-inbox.jsonl'); process.env.OWNER_DIR = path.join(T, 'company', 'owner');
  const cases = []; const t = (n, c, info) => { cases.push(!!c); console.log((c ? 'ok   ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 300))); };
  const throws = f => { try { f(); return null; } catch (e) { return e.message; } };
  const by = 'Commander';
  const open = id => openQuestions().find(q => q.id === id);
  try {
    // messages
    const dense = 'Access gate (gate 2), no payment: a read-only Kalshi API key, from an account you create in your own name. Why it is the binding one: Kalshi\'s websocket rejects anonymous connections (HTTP/1.1 401 measured from this station today), so sub-second book is closed to us. A key buys about 1 Hz quotes.';
    const legacy = ask({ from: 'Founder', q: dense });
    t('an old-style --q ask warns that there is no message', legacy.warnings.length === 1 && /no --message/.test(legacy.warnings[0]));
    const lq = open(legacy.row.id);
    t('an old question shows its first two sentences as the message, the rest as detail', lq.messageDerived && /^Access gate/.test(lq.message) && /binding one/.test(lq.message) && /1 Hz/.test(lq.details) && !/1 Hz/.test(lq.message), lq);
    t('an ask with no kind is an approve form: Approve / Decline + reason, no form written', !('form' in legacy.row) && lq.kind === 'approve' && lq.form.actions.map(a => a.id).join() === 'approve,decline,store-key');
    const long = ask({ from: 'Founder', message: 'We need ' + 'a lot of words here, '.repeat(25) + 'ok.', details: 'x' });
    t('a long message warns', long.warnings.some(w => /characters/.test(w)));
    const jar = ask({ from: 'Founder', message: 'Edit `company/tools/x.js` so q-123456 exits 0 (HTTP 401 at 50 ms).' });
    t('a jargon-dense message warns', jar.warnings.some(w => /reads like a report/.test(w)), jar.warnings);
    const good = ask({ from: 'Founder', message: 'Could you make us a free Pyth account and paste its API key? It lets us test our main idea about commodity prices. If you say no, that idea waits.', details: 'Pyth answers 401 without a key; 200 ms gold, 50 ms WTI.', kind: 'secret', spec: { name: 'pyth-api-key', label: 'Pyth API key', provider: 'pyth.network > Developers' } });
    t('a plain message with details: no warnings; q keeps both for old readers', good.warnings.length === 0 && /\n\nPyth answers 401/.test(good.row.q) && open(good.row.id).details.startsWith('Pyth'));
    fs.appendFileSync(FILE(), JSON.stringify({ type: 'ask', id: 'q-000001', at: new Date().toISOString(), from: 'Founder', q: 'Old row. May we go?' }) + '\n');
    t('an old row with no kind reads as approve', open('q-000001').kind === 'approve' && open('q-000001').form.actions[0].verdict === 'yes' && !open('q-000001').secretHint);
    // shortcuts and validation
    t('unknown kind refused', /unknown --kind/.test(throws(() => ask({ message: 'x', kind: 'poll' }))));
    t('choice needs two options', /at least two options/.test(throws(() => ask({ message: 'x', kind: 'choice', spec: { options: 'a:A' } }))));
    t('secret needs a safe name', /needs name/.test(throws(() => ask({ message: 'x', kind: 'secret', spec: { name: '../etc/passwd' } }))) && /needs name/.test(throws(() => ask({ message: 'x', kind: 'secret', spec: { name: 'station-token' } }))));
    t('link: http(s) only', /http or https only/.test(throws(() => ask({ message: 'x', kind: 'link', spec: { url: 'javascript:alert(1)', action: 'a' } }))));
    t('account: a password field is refused', /use type "secret"/.test(throws(() => ask({ message: 'x', kind: 'account', spec: { url: 'https://x.example', action: 'sign up', fields: 'user:Username,password:Password' } }))));
    // free-form forms
    t('form: unknown field type refused, with a file-upload hint', /file uploads are not supported/.test(throws(() => ask({ message: 'x', form: { fields: [{ id: 'f', type: 'file', label: 'F' }] } }))));
    t('form: bad ids, duplicate ids, bad verdict refused', /lowercase/.test(throws(() => ask({ message: 'x', form: { fields: [{ id: 'Bad Id', type: 'text', label: 'x' }] } })))
      && /two fields/.test(throws(() => ask({ message: 'x', form: { fields: [{ id: 'a', type: 'text', label: 'x' }, { id: 'a', type: 'number', label: 'y' }] } })))
      && /verdict must be/.test(throws(() => ask({ message: 'x', form: { actions: [{ label: 'Go', verdict: 'maybe' }] } }))));
    t('form: two secret fields writing the same file refused', /two secret fields/.test(throws(() => ask({ message: 'x', form: { fields: [{ id: 'a', type: 'secret', label: 'A', name: 'k' }, { id: 'b', type: 'secret', label: 'B', name: 'k' }] } }))));
    t('form: too many fields refused', /at most 20 fields/.test(throws(() => ask({ message: 'x', form: { fields: Array.from({ length: 21 }, (_, i) => ({ id: 'f' + i, type: 'checkbox', label: 'x' })) } }))));
    const fx = ask({ from: 'Founder', message: 'Two things for the recorder alarm. Make a free healthchecks.io account, then paste its ping key here. If you would rather not, we use the free tier of something else.',
      form: { fields: [{ id: 'intro', type: 'info', text: 'It costs nothing.' }, { id: 'signup', type: 'link', label: 'Sign up', url: 'https://healthchecks.io/accounts/signup/', action: 'Create a free account', required: true },
        { id: 'email', type: 'text', label: 'Sign-in email', required: true }, { id: 'ping', type: 'secret', label: 'Ping key', name: 'healthchecks-ping-key' },
        { id: 'when', type: 'date', label: 'Start from', required: false }, { id: 'budget', type: 'number', label: 'Monthly cap', unit: 'USD', min: 0, max: 20, required: false },
        { id: 'tiers', type: 'choice', label: 'Plan', multi: true, options: [{ id: 'free', label: 'Free', recommended: true }, { id: 'hobby', label: 'Hobby' }], required: false },
        { id: 'ok', type: 'checkbox', label: 'Emails may go to that address', required: true }],
      actions: [{ id: 'go', label: 'Here you go', verdict: 'done' }, { id: 'free', label: 'Use the free tier of another service instead', verdict: 'no' }, { id: 'later', label: 'Not now', verdict: 'no', needs: 'none' }] } });
    const fq = open(fx.row.id);
    t('form kept as composed: 8 fields, 3 named actions, first is primary', fq.kind === 'form' && fq.form.fields.length === 8 && fq.form.actions.length === 3 && fq.form.actions[0].primary && fq.form.actions[1].needs === 'none');
    t('form answer: a required checkbox must be ticked', /tick it/.test(throws(() => answer({ id: fx.row.id, by, answer: { action: 'go', values: { signup: 'done', email: 'me@x.example', ping: { stored: 'secrets/healthchecks-ping-key', chars: 22, validated: null } } } }))));
    t('form answer: a raw secret value is refused', /never written into an answer/.test(throws(() => answer({ id: fx.row.id, by, answer: { action: 'go', values: { signup: 'done', email: 'me@x.example', ok: true, ping: 'sk-live-123' } } }))));
    t('form answer: a field that is not on the form is refused', /no field "extra"/.test(throws(() => answer({ id: fx.row.id, by, answer: { action: 'later', values: { extra: 1 } } }))));
    let r = answer({ id: fx.row.id, by, answer: { action: 'go', values: { signup: 'done', email: 'me@x.example', ok: true, ping: { stored: 'secrets/healthchecks-ping-key', chars: 22, validated: false, validateError: 'HTTP 401' }, budget: 5, tiers: ['free'] } } });
    t('form answered in plain words: action, link, email, key path, number, choice', /^Here you go\./.test(r.a) && /Sign up \(https:\/\/healthchecks\.io\/accounts\/signup\/\): done/.test(r.a) && /Sign-in email: me@x\.example/.test(r.a) && /stored at secrets\/healthchecks-ping-key \(22 chars, validated: no, HTTP 401\)/.test(r.a) && /5 USD/.test(r.a) && /"Free" \(free\)/.test(r.a), r.a);
    t('the answer is delivered to the asker as an owner message naming the question', require('./owner-inbox.js').messages().some(m => m.re === fx.row.id && /my answer to your question/.test(m.text)));
    // shortcut answers
    const ch = ask({ from: 'Founder', message: 'Which plan?', kind: 'choice', spec: { options: 'yes:Take the trial,no:Skip it,later:Ask again in May', recommended: 'yes' } });
    t('choice: an id off the list is refused', /not one of the options/.test(throws(() => answer({ id: ch.row.id, by, answer: { action: 'choose', values: { choice: 'maybe' } } }))));
    r = answer({ id: ch.row.id, by, answer: { action: 'choose', values: { choice: 'yes' }, note: 'two weeks only' }, quiet: true });
    t('choice of "yes" answers yes (governance reads it); --quiet sends nothing', r.answer.verdict === 'yes' && /^yes/.test(r.a) && !r.delivered);
    const txt = ask({ from: 'Founder', message: 'What should the newsletter be about?', kind: 'text', spec: { min: 10 } });
    t('text: too short refused', /at least 10/.test(throws(() => answer({ id: txt.row.id, by, answer: { action: 'send', values: { answer: 'short' } } }))));
    const nm = ask({ from: 'Founder', message: 'Monthly cap?', kind: 'number', spec: { unit: 'USD', min: 0, max: 500 } });
    t('number out of range refused', /at most 500/.test(throws(() => answer({ id: nm.row.id, by, answer: { action: 'send', values: { value: 900 } } }))));
    // slider: composed safely, checked server-side (range, step), answered in the asker's plain words
    t('slider: min above max, zero step, suggestion off a step, say without {value} refused',
      /min must be below max/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 9, max: 1 } })))
      && /step must be above 0/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 0, max: 10, step: 0 } })))
      && /not on a step/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 0, max: 100, step: 5, value: 42 } })))
      && /must be from/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 0, max: 100, value: 120 } })))
      && /must contain \{value\}/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 0, max: 100, say: 'no number' } })))
      && /sayAt 120 is outside/.test(throws(() => ask({ message: 'x', kind: 'slider', spec: { min: 0, max: 100, say: '{value}', sayAt: { 120: 'too far' } } })))
      && /a mark is outside/.test(throws(() => ask({ message: 'x', form: { fields: [{ id: 's', type: 'slider', label: 'S', min: 0, max: 10, marks: [{ value: 11, label: 'x' }] }] } }))));
    const sl = ask({ from: 'Pacer', message: 'How much of this week\'s Claude may routines use?', kind: 'slider', spec: { label: 'Weekly stop', min: 70, max: 100, step: 1, value: 95, unit: '%', say: 'Let routines use up to {value}% of this week\'s Claude', minLabel: 'Now (70%)', maxLabel: 'All of it' } });
    const slf = open(sl.row.id).form.fields[0];
    t('slider: kept with its suggestion, unit, labels and say', slf.type === 'slider' && slf.value === 95 && slf.unit === '%' && slf.minLabel === 'Now (70%)' && /\{value\}/.test(slf.say), slf);
    t('slider answer: out of range refused', /from 70 to 100 \(120 is outside\)/.test(throws(() => answer({ id: sl.row.id, by, answer: { action: 'set', values: { value: 120 } } }))) && /outside/.test(throws(() => answer({ id: sl.row.id, by, answer: { action: 'set', values: { value: 69 } } }))));
    t('slider answer: off a step refused; not a number refused', /between steps/.test(throws(() => answer({ id: sl.row.id, by, answer: { action: 'set', values: { value: 80.5 } } }))) && /a number from/.test(throws(() => answer({ id: sl.row.id, by, answer: { action: 'set', values: { value: 'lots' } } }))));
    r = answer({ id: sl.row.id, by, answer: { action: 'set', values: { value: '80' } }, quiet: true });
    t('slider answer: a number, said in the asker\'s plain words', r.answer.values.value === 80 && /Let routines use up to 80% of this week's Claude\./.test(r.a), r.a);
    const sec = ask({ from: 'Founder', message: 'The Kalshi key, please.', kind: 'secret', spec: { name: 'kalshi-api-key' } });
    r = answer({ id: sec.row.id, by, answer: { action: 'decline', note: 'not this week' } });
    t('secret: declining needs no key', r.answer.verdict === 'declined' && /will not provide/.test(r.a));
    r = answer({ id: legacy.row.id, by, text: 'yes: go ahead' });
    t('a legacy text answer becomes {verdict: yes, reason}', r.answer.verdict === 'yes' && r.answer.values.reason === 'go ahead' && r.a === 'yes. go ahead');
    // legacy key question: a secure field as an extra option
    const kq = ask({ from: 'Founder', q: 'Access gate (gate 2), no payment: a read-only Kalshi API key, from an account you create in your own name.' });
    t('legacy key question: secretHint kalshi-api-key and a store-key action', (open(kq.row.id).secretHint || {}).name === 'kalshi-api-key' && open(kq.row.id).form.actions.some(a => a.id === 'store-key'));
    t('legacy: "a free Pyth API key" -> pyth-api-key', (secretHint({ q: 'Access gate (gate 2), no payment, second key: a free Pyth API key.' }) || {}).name === 'pyth-api-key');
    t('store-key needs the key', /paste the key/.test(throws(() => answer({ id: kq.row.id, by, answer: { action: 'store-key' } }))));
    r = answer({ id: kq.row.id, by, answer: { action: 'store-key', values: { key: { stored: 'secrets/kalshi-api-key', chars: 40 } } } });
    t('legacy key question takes a stored secret (validated: not checked)', /stored at secrets\/kalshi-api-key \(40 chars, validated: not checked\)/.test(r.a), r.a);
    // snooze
    const sz = ask({ from: 'Founder', message: 'Later is fine.' });
    t('snooze in the past refused', /next 30 days/.test(throws(() => snooze({ id: sz.row.id, by, until: '2020-01-01T00:00:00Z' }))));
    const until = new Date(Date.now() + 3600e3).toISOString();
    snooze({ id: sz.row.id, by, until });
    t('a snoozed question stays open and carries snoozedUntil', open(sz.row.id).snoozedUntil === until);
    // governance approved(): structured verdicts
    const gov = require('./lib/governance');
    const g1 = gov.decide('hiring', { by: 'Sam', summary: 'open a round', ref: 'st:r1' }, { root: T, level: 'approve' });
    const g2 = gov.decide('hiring', { by: 'Sam', summary: 'open round 2', ref: 'st:r2' }, { root: T, level: 'approve' });
    t('governance files gate questions with a plain message', !!g1.questionId && !open(g1.questionId).messageDerived && open(g1.questionId).message.length <= MESSAGE_SOFT, open(g1.questionId));
    answer({ id: g1.questionId, by, answer: { action: 'approve', values: { reason: 'fine' } }, quiet: true });
    answer({ id: g2.questionId, by, answer: { verdict: 'no' }, quiet: true });
    t('governance approved(): structured yes is true, no is false', gov.approved('st:r1', { root: T }) === true && gov.approved('st:r2', { root: T }) === false);
  } catch (e) { t('selftest ran to the end', false, e.stack); }
  finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} }
  const bad = cases.filter(c => !c).length;
  console.log(bad ? 'INBOX SELFTEST FAILED: ' + bad + ' of ' + cases.length : 'INBOX SELFTEST PASSED: ' + cases.length + ' cases');
  return bad ? 1 : 0;
}

if (require.main !== module) return; // required as a module: export only, never run the CLI
if (process.argv.includes('--selftest')) process.exit(selftest());

const a = args();

if (a.cmd === 'ask') {
  let spec = {};
  if (a.spec && a.spec !== true) { try { spec = JSON.parse(a.spec); } catch (e) { out(2, { ok: false, error: '--spec is not JSON: ' + e.message }); } }
  let form = null;
  if (a.form && a.form !== true) { try { form = JSON.parse(a.form); } catch (e) { out(2, { ok: false, error: '--form is not JSON: ' + e.message }); } }
  const flag = { options: 'options', recommended: 'recommended', 'allow-other': 'allowOther', multi: 'multi', min: 'min', max: 'max', placeholder: 'placeholder', name: 'name', label: 'label',
    provider: 'provider', validate: 'validate', url: 'url', action: 'action', fields: 'fields', unit: 'unit', multiline: 'multiline',
    step: 'step', value: 'value', say: 'say', 'min-label': 'minLabel', 'max-label': 'maxLabel' };
  for (const [f, k] of Object.entries(flag)) if (a[f] !== undefined) spec[k] = a[f];
  try {
    const { row, warnings } = ask({ from: a.from, about: a.about, message: a.message, details: a.details, q: a.q, blocking: a.blocking, kind: a.kind || spec.kind, spec, form });
    out(0, Object.assign({ ok: true, id: row.id, kind: row.kind || 'approve', status: 'open', note: 'the owner answers on Today in the console; the answer comes back to you as an owner message naming ' + row.id }, warnings.length ? { warnings } : {}));
  } catch (e) { out(2, { ok: false, error: e.message }); }
}
if (a.cmd === 'list') {
  const now = Date.now();
  const rows = Object.values(state()).filter(x => x.type === 'ask' && (!a.open || (!x.a && !x.reclassified)) && (!a.from || String(x.from).toLowerCase() === String(a.from).toLowerCase()));
  out(0, { ok: true, open: openQuestions().length, items: rows.map(x => {
    const snoozed = !x.a && x.snoozedUntil && Date.parse(x.snoozedUntil) > now ? x.snoozedUntil : null;
    return { id: x.id, from: x.from, about: x.about, kind: x.kind || 'approve', message: messageParts(x).message, q: x.q, blocking: x.blocking, askedAt: x.at, answer: x.a || null, answerDetail: x.answer || null, answeredBy: x.by || null, reclassified: x.reclassified || null,
      snoozedUntil: snoozed, status: x.a ? 'answered' : x.reclassified ? 'reclassified' : snoozed ? 'snoozed until ' + snoozed : 'open' };
  }) });
}
if (a.cmd === 'reclassify') {
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  const note = String(a.note || '').trim(); if (!note) out(2, { ok: false, error: '--note is required (what the company decided and who owns it)' });
  const by = String(a.by || 'unknown');
  append({ type: 'reclassify', id, at: new Date().toISOString(), note, by });
  out(0, { ok: true, id, state: 'reclassified-company-owned', by, note });
}
if (a.cmd === 'snooze') {
  try { out(0, snooze({ id: a.id, until: a.until, by: a.by })); } catch (e) { out(e.code === 3 ? 3 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'answer') {
  if (!isOwner(a.by)) out(3, { ok: false, error: 'only the Commander (the owner, the PM) can answer or close a question' });
  if (!String(a.id || '')) out(2, { ok: false, error: '--id is required' });
  if (!String(a.a || '').trim() && !a.answer) out(2, { ok: false, error: '--a is required' });
  let structured;
  if (a.answer && a.answer !== true) { try { structured = JSON.parse(a.answer); } catch (e) { out(2, { ok: false, error: '--answer is not JSON' }); } }
  // an id that was never asked still gets its answer row (old behaviour), so a reply to a question asked elsewhere is kept
  if (!state()[String(a.id)]) { append({ type: 'answer', id: String(a.id), at: new Date().toISOString(), a: String(a.a), by: 'Commander' }); out(0, { ok: true, id: String(a.id), state: 'answered' }); }
  try { out(0, answer({ id: a.id, by: a.by, text: a.a, answer: structured, quiet: !!a.quiet })); }
  catch (e) { out(e.code === 3 ? 3 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'close') {
  if (!isOwner(a.by)) out(3, { ok: false, error: 'only the Commander (the owner, the PM) can answer or close a question' });
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  append({ type: 'close', id, at: new Date().toISOString(), by: 'Commander' });
  out(0, { ok: true, id, state: 'closed' });
}
out(2, { ok: false, error: 'unknown command: ' + a.cmd, commands: ['ask', 'list', 'answer', 'snooze', 'close', 'reclassify', '--selftest'] });
