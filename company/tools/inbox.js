#!/usr/bin/env node
/* inbox.js — the owner (PM) inbox. Every question the company cannot answer within its authority goes here.
 *
 * The owner (the station Commander) is the PM. Agents ask; the owner answers; nothing guesses in the gap. The CEO
 * batches open questions and the dispatcher delivers the CEO's to company/owner/outbound.jsonl; an owner reply that
 * names the question id comes back through company/owner/inbound.jsonl (owner-inbox.js).
 *
 *   node company/tools/inbox.js ask --from <name> --message "two plain sentences" [--details "evidence, numbers"]
 *        [--about <project>] [--blocking] [--kind <shortcut> + its flags | --form '<json>' | --questions '<json>']
 *        [--one-decision] [--changed "what is materially different since the owner said not now"]   (--q is the old form)
 *   node company/tools/inbox.js list [--open] [--from <name>]
 *   node company/tools/inbox.js answer --id q-0003 --a "yes: rotate it" --by Commander [--answer '<json>'] [--quiet]
 *   node company/tools/inbox.js snooze --id q-0003 --until <ISO time> --by Commander
 *   node company/tools/inbox.js withdraw q-0003 [--part <n|id>] --why "fixed by …" --from <you>   (the asker: no longer needed)
 *   node company/tools/inbox.js reclassify --id q-0003 --note "the company decides: <who owns it>" --by <you>   (the asker)
 *   node company/tools/inbox.js close --id q-0003
 * answer / snooze / close --by owner (or Commander, or the owner's name) follow the shared owner rule (lib/owner.js):
 * only from the owner's own shell or the console. An APPROVAL record (row.approval, or an older gate question) is never
 * answered or closed here: approvals.js answer (or Today › Needs you) is its only answer path (exit 5).
 *   node company/tools/inbox.js --selftest
 *
 * OWNER SCOPE (lib/owner-scope.js, enforced here for every ask, approvals included). The owner is a busy non-technical
 * person, asked only for money beyond the company's limits, accounts or identity in their own name, legal/ownership/
 * commitment decisions, company direction, risk governance reserves for them, and the fixed gates. An ask about
 * infrastructure, monitoring, health checks, tooling, registers, timers, framework bugs or internal process is refused
 * (code crew-scope) with where it goes: yourself, the risk/tools/floor seat, or a framework request. A topic the owner
 * answered "not now" within 7 days is refused (code backoff) unless --changed says what changed. Every owner question
 * must pass the plain-language check (code plain, with a `suggestion`): at most two short sentences, no jargon, ids,
 * paths or stray figures, what the owner gets or risks, and what happens if they skip it.
 *
 * A STORED KEY IS NOT ASKED AGAIN: an ask with a secret field whose secrets/<name> already holds a key is refused (code
 * secret-exists) unless --changed says what is different (it stopped working, it was rotated); an old row that reads as
 * a key request gets no key field when that key is stored, and an approval or gate card never gets one.
 * `--technical "..."` is kept on the row and shown collapsed as "Technical details (for the crew)".
 *
 * HOW A QUESTION READS. `--message` is what the owner sees first: two short conversational sentences — what you need, what they get,
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
 *             `validate: custom` = a MiniMax key: Today shows the endpoint picker (Global / Mainland China / Custom) beside
 *             it and the console checks the key there, saving the endpoint in company.json providers.minimax.
 *   url       {placeholder?, allowHttp?}             a plain web address (a ping URL, a webhook), shown, checked as https.
 *             Only keys, tokens and passwords are secret fields: a "secret" field whose label asks for a URL or an
 *             address (and names no key/token/password) is turned into a url field (plainFieldKinds), at ask and on read.
 *   choice    {options: [{id, label, recommended?}], multi?, allowOther?}
 *   link      {url (http/https), action: what to do there}   the owner marks it done / couldn't
 *   number    {unit?, min?, max?}     date {min?, max? YYYY-MM-DD}     checkbox {}  (a yes/no tick)
 *   slider    {min, max, step?, value (the suggested value), unit?, marks?: [{value, label}], minLabel?, maxLabel?,
 *             say?: "Let routines use up to {value}% of this week's Claude", sayAt?: {"0": "a whole sentence for 0"}}
 *             a range the owner drags (keyboard: arrows,
 *             Page Up/Down, Home/End); the card shows `say` with the live value in plain words. The answer must be in
 *             [min, max] and on a step from min; it is checked here, server-side, not only in the browser.
 * Every field has {id, type, label, help?, required?}. `actions` are the buttons, each {id, label, verdict, primary?,
 * needs?, does?}: `does` says what pressing it will do ("Approve switches the commitments module on"); an approve
 * shortcut takes it as --spec '{"does": "..."}'. Without it Today says "Approve tells <asker> yes". verdict is one of yes, no, submit, done, couldnt, declined (yes/no is what lib/governance approved() reads);
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
 * SEVERAL DECISIONS = SEVERAL QUESTIONS. `--questions '[{id, prompt, kind?, spec?, form?, required?}, ...]'` (at most 12)
 * is one request whose questions the owner answers one by one (approve/decline by default, any kind or form each).
 * Each answer is a {type:'part'} row and reaches the asker at once; the request stays open until every required
 * question is answered or the owner closes the rest (skipped), then the answer row is {verdict:'parts', parts:{<id>:
 * {verdict, action, values} | {skipped:true}}}. A single Approve/Decline whose text lists several decisions (1. 2. …)
 * is refused with the split ready (`--one-decision` when the list is only evidence). An untyped old row is reshaped
 * the same way when read (inferQuestions): each listed decision its own approve/decline, a key it asks for its own
 * secret question — never one binary answer, never a key field that closes it.
 * KEYS INSIDE A LARGER QUESTION: storing a key never answers a question that asks for more (secretOnly(form) is false):
 * the console writes the file and records {type:'secret'} (recordStored); the final submit carries {stored, chars}.
 * RECOVERY: an untyped question that was closed by storing a key alone, while its text asked for more, comes back ONCE
 * (followUpOf) with the key shown as stored and the rest open: "You stored the key; the rest of this request still needs you".
 * NEVER A COMMAND FOR THE OWNER: an ask whose text tells the owner to run something (patch -p1, node …, git push …,
 * systemctl …, daemon-reload, sudo …, npm/pip install …, a command in backticks, "in your shell", "run this", "on your
 * side", "may I have that command") is refused (details may quote commands as evidence unless they hand them over) with the routes (composerCheck): a framework file = harness-change propose (a framework
 * request with the diff); a locked company tool = the same propose, approved by the owner on Today and applied by the
 * tool; anything else = a handoff to the tools seat.
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
 * WHO WROTE A ROW (lib/pm-inbox-guard.js). Every row is recorded in the provenance log before it is appended, and every
 * reader (state, openQuestions: Today, the dispatcher, approvals; lib/governance answerOf) trusts only recorded rows. An
 * answer, part, secret, close or snooze counts only from the owner's side (the console, this CLI / approvals.js under the
 * lib/owner.js rule, the dispatcher's approvals tick); an agent's run cannot write one (code 3). An ask, withdraw or
 * reclassify comes from the asker's own run: withdraw / reclassify name the asker (--from) and, in an agent's run,
 * callerSeat() checks the run is the asker's (the station's agent id, the transcript) and records that seat with the row.
 * A row anyone appended by hand is ignored, logged, raised to risk and quarantined by locked-watch. Rows from before the
 * cutover are history: shown, never a gate answer.
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
// the shared owner rule (lib/owner.js) for the CLI's --by owner: the owner's own shell or the console, never an agent run
const ownerRefusal = (by, what) => require('./lib/owner').refusal(by, what, { aliases: ['commander'] });
/* an approval record (approvals.js: row.approval, or an older governance gate question: row.gate) is answered ONLY
 * through approvals.answer (digest, lock, authority, audit line, wake): never by a plain inbox answer or close */
const isApprovalRow = row => !!(row && (row.approval || row.gate));
const approvalRefusal = id => { const e = new Error(id + ' is an approval: answer it on Today › Needs you or with node company/tools/approvals.js answer ' + id + ' (an inbox answer would skip the digest, the lock and the audit line)'); e.code = 5; return e; };

const KINDS = ['approve', 'choice', 'text', 'secret', 'link', 'account', 'number', 'date', 'slider'];
const FIELD_TYPES = ['info', 'text', 'secret', 'url', 'choice', 'link', 'number', 'date', 'checkbox', 'slider'];
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
/* Only rows the owner-question check trusts (lib/pm-inbox-guard.js): each was recorded in the provenance log by an allowed
 * writer (an owner row by the console or the owner's own tools, an asker's row by that seat's own tool run), or is history
 * from before the cutover. A row anyone else appended is ignored, logged, raised to risk and quarantined by locked-watch. */
const GUARD = () => require('./lib/pm-inbox-guard');
function readAll() {
  try { return GUARD().rows({ file: FILE() }); } catch (_) { return []; }
}
// record, then append (an owner row from an agent's run is refused with code 3); o.seat: the asker's verified seat
function append(row, o) { return GUARD().append(FILE(), row, 'inbox.js', o); }
/* callerSeat(question, by, verb) — the asker acting on its OWN question. Outside an agent's run: no check (the owner's side,
 * the dispatcher). In an agent's run the caller must be the asker's seat: the station's agent id (STARNET_AGENT_ID) when it
 * gives one, and no transcript shows another seat running this command (provenance.callerConflict). Returns the seat id
 * (recorded with the row, so readers can check it), null outside a run; throws code 3 otherwise. */
function callerSeat(row, by, verb) {
  const prov = require('./provenance.js');
  if (!prov.underStation()) return null;
  const no = m => { const e = new Error(m); e.code = 3; return e; };
  if (isOwner(by)) throw no('an agent\'s run is not the owner: ' + verb + ' ' + row.id + ' --from <the asker>');
  const seat = GUARD().seatOfName(co.crew(), row.from);
  if (!seat) throw no(row.id + ' was asked by ' + row.from + ', who is not a seat on the crew: only the owner ' + verb + 's it');
  const env = String(process.env.STARNET_AGENT_ID || '').trim();
  if (env && env !== seat) throw no('this run is ' + (co.nameOf(env) || env) + '\'s, not ' + row.from + '\'s: a seat ' + verb + 's only its own question');
  const c = prov.callerConflict(co.ROOT, [verb, row.id], seat);
  if (c) throw no('this command claims to be ' + row.from + ' but ran in another seat\'s run (' + (co.nameOf(c.agentId) || c.agentId) + ', ' + c.runId + '): a seat ' + verb + 's only its own question');
  return seat;
}
const storedOf = v => Object.assign({ stored: String(v.stored), chars: Number(v.chars) || 0, validated: v.validated === true ? true : v.validated === false ? false : null }, v.validateError ? { validateError: String(v.validateError).slice(0, 200) } : {});
function state() {
  const by = {};
  for (const r of readAll()) {
    if (r.type === 'ask') by[r.id] = Object.assign({}, r, { askedAt: r.at });
    if (r.type === 'answer' || r.type === 'close') {
      const cur = by[r.id] = by[r.id] || {};
      if (r.type === 'answer' && cur.answer && !cur.prevAnswer) cur.prevAnswer = cur.answer;   // the first answer, for the follow-up recovery
      if (r.type === 'answer' && r.followUp) cur.followedUp = true;
      Object.assign(cur, r); if (r.type === 'answer') cur.answeredAt = r.at;
    }
    // a key stored inside a multi-field form (the question stays open) and one question of a multi-question request
    if (r.type === 'secret') { const cur = by[r.id] = by[r.id] || {}; cur.stored = Object.assign({}, cur.stored, { [r.field]: storedOf(r) }); }
    if (r.type === 'part') { const cur = by[r.id] = by[r.id] || {}; cur.parts = Object.assign({}, cur.parts, { [r.part]: { a: r.a, answer: r.answer, at: r.at } }); }
    if (r.type === 'reclassify') Object.assign(by[r.id] = by[r.id] || {}, { reclassified: r.note, by: r.by });
    // the asker withdrew a question ("no longer needed"): one question of a request (part) or the whole ask
    if (r.type === 'withdraw') { const cur = by[r.id] = by[r.id] || {}; const w = { by: r.by, why: r.why, at: r.at };
      if (r.part) cur.withdrawn = Object.assign({}, cur.withdrawn, { [r.part]: w }); else cur.withdrawnAll = w; }
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
  if (!message) return ['no --message: the owner sees the first two sentences of --q. Write two plain sentences (what you need, what the owner gets, what happens if they skip it) and move evidence to --details.'];
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
    if (type === 'url') { o.placeholder = str(x.placeholder, 200, 'field ' + id + ' placeholder'); if (x.allowHttp) o.allowHttp = true; }
    if (type === 'secret') {
      o.name = String(x.name || '').trim();
      if (!safeSecretName(o.name)) throw new Error('secret field ' + id + ' needs name: a plain file name under secrets/ (letters, digits, . _ -; not station-token or console-token), e.g. tradex-api-key');
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
    const does = str(x.does, 300, 'action ' + id + ' does'); if (does) o.does = does;   // what pressing it will do, in plain words
    if (Array.isArray(x.needs)) { for (const n of x.needs) if (!ids.has(String(n))) throw new Error('action ' + id + ' needs a field that does not exist: ' + n); o.needs = x.needs.map(String); }
    else o.needs = x.needs === 'none' || x.needs === 'fields' ? x.needs : (['yes', 'submit', 'done'].includes(verdict) ? 'fields' : 'none');
    return o;
  });
  const answerable = outF.some(f => f.type !== 'info');
  if (!outA.length) outA = answerable ? [{ id: 'send', label: 'Send', verdict: 'submit', primary: true, needs: 'fields' }] : [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true, needs: 'fields' }, { id: 'decline', label: 'Decline', verdict: 'no', needs: 'none' }];
  if (!outA.some(a => a.primary)) outA[0].primary = true;
  return plainFieldKinds({ fields: outF, actions: outA });
}
/* plainFieldKinds(form) — only keys, tokens and passwords are secret fields. A "secret" field that asks for a URL or an
 * address (a ping URL, a webhook address, an endpoint) and names no key, token or password is a plain https URL field:
 * the owner sees it, it is checked as https, and it is answered with the question's own button ("Store …" reads "Save …").
 * Applied when a form is composed and again when one is read, so questions asked before the rule are shown right too. */
const URL_WORD = /\b(url|urls|address|link|endpoint|webhook|uri|domain|website|site)\b/i;
const SECRET_WORD = /\b(key|keys|token|tokens|password|passwords|passphrase|secret|credentials?|private|pem|api[- _]?key)\b/i;
function looksLikeUrlField(f) { const lab = String(f.label || '') + ' ' + String(f.help || ''); return URL_WORD.test(lab) && !SECRET_WORD.test(String(f.label || '')) && !f.validate; }
function plainFieldKinds(form) {
  if (!form || !Array.isArray(form.fields) || !form.fields.some(f => f.type === 'secret' && looksLikeUrlField(f))) return form;
  const changed = new Set();
  const fields = form.fields.map(f => { if (f.type !== 'secret' || !looksLikeUrlField(f)) return f; changed.add(f.id);
    const o = { id: f.id, type: 'url', label: f.label, required: f.required !== false, reclassified: 'secret' }; if (f.help) o.help = f.help; return o; });
  const actions = (form.actions || []).map(a => {
    const needs = Array.isArray(a.needs) ? a.needs : [];
    const keysLeft = fields.some(f => f.type === 'secret');
    if (/^store\b/i.test(a.label) && (needs.some(n => changed.has(n)) || (!keysLeft && ['done', 'submit', 'yes'].includes(a.verdict)))) return Object.assign({}, a, { label: a.label.replace(/^store( it)?( securely)?/i, m => /it/i.test(m) ? 'Save it' : 'Save') });
    return a;
  });
  return Object.assign({}, form, { fields, actions });
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
    case 'approve': return { fields: [reason], actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true, does: s.does }, { id: 'decline', label: 'Decline', verdict: 'no', does: s.declineDoes }] };
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

/* asksForCredential(text): true only when a sentence ASKS for a credential, not when it mentions one. A sentence counts
 * when it holds a credential noun AND either a request verb (paste, send, provide, give, store, share, supply, enter,
 * upload, put) or the old ask shape "<lead-in>: a ... API key" (a colon, then an article, then the noun phrase).
 * Why: a bare \bkey\b anywhere offered a store-key box on an approve question, and a pasted value closed it as done. */
const CRED_NOUN = /\b(api[- ]?key|api[- ]?token|access token|credentials?|secret key|private key|password|key)\b/i;
const CRED_VERB = /\b(paste|pasted|pasting|send|provide|give|store|share|supply|enter|upload|put|need|needs)\b/i;
const CRED_ASKSHAPE = /:\s*(?:an?|the|your)\s+[^.:]{0,50}?\b(?:api[- ]?key|api[- ]?token|access token|secret key|private key)\b/i;
function asksForCredential(text) {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).some(sn => CRED_NOUN.test(sn) && (CRED_VERB.test(sn) || CRED_ASKSHAPE.test(sn)));
}
/* secretHint(row) — an old question that asks for a key, token or credential (and has no secret field) gets a secure
 * field as an extra option, with a suggested file name. null when the text does not ask for one. */
// the company's key folder (env INBOX_SECRETS_DIR: tests only)
const secretsDir = () => process.env.INBOX_SECRETS_DIR || co.SECRETS_DIR;
/* secretStored(name, before?) -> true when secrets/<name> already holds a key (a non-empty file), stored before `before` if given */
function secretStored(name, before) {
  try {
    if (!safeSecretName(name)) return false;
    const st = fs.statSync(path.join(secretsDir(), String(name))); if (!(st.size > 0)) return false;
    const t = before ? Date.parse(before) : NaN;   // stored before that time (a question's asked-at), when given
    return !Number.isFinite(t) || st.mtimeMs <= t;
  } catch (_) { return false; }
}
function secretHint(q) {
  if (!q || (q.form && (q.form.fields || []).some(f => f.type === 'secret'))) return null;
  // never on an approval or gate card (it asks for a decision, not a key)
  if (isApprovalRow(q)) return null;
  const t = String(q.q || '') + ' ' + String(q.message || '');
  if (!asksForCredential(t)) return null;
  const skip = new Set(['a', 'an', 'the', 'free', 'read', 'only', 'read-only', 'new', 'second', 'first', 'our', 'your', 'own', 'one', 'paid', 'live', 'gate', 'api', 'no', 'its', 'their']);
  const W = '((?:[A-Za-z][\\w.-]*\\s+){1,3})';
  const m = t.match(new RegExp(W + '(?:api[- ]?key|api[- ]?token|access token)\\b', 'i')) || t.match(new RegExp(W + '(?:private key|secret key|token|key)\\b', 'i'));
  let base = '';
  if (m) { const words = m[1].trim().split(/\s+/).filter(w => !skip.has(w.toLowerCase().replace(/[^a-z-]/g, ''))); base = (words.pop() || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  const kindWord = /private key/i.test(t) && !/api key/i.test(t) ? 'private-key' : /token/i.test((m && m[0]) || '') ? 'api-token' : 'api-key';
  const name = base && base.length <= 30 ? base + '-' + kindWord : 'key-' + String(q.id || 'x').replace(/^q-/, '');
  const hint = { name: safeSecretName(name) ? name : 'key-' + String(q.id || 'x').replace(/[^a-z0-9]/gi, '') };
  // the key was already stored when this was asked: no second key field, unless the asker said what changed (it stopped
  // working, rotated). A key stored after the question (the owner answering this very request) keeps the field, so a
  // request answered in parts keeps its key part.
  if (secretStored(hint.name, q.at) && !String(q.changed || '').trim()) return null;
  return hint;
}
/* formOf(row) — the form a question is answered with: its own, or (an old row) Approve/Decline + reason. A row that
 * asks for a key without a secret field gets an optional secret field `key` beside Approve/Decline. There is no
 * "store" button that answers it: storing a key never closes a question that asks for more than the key (an untyped
 * row is shown as a multi-question request, inferQuestions, where the key is one part and the decision another). */
function formOf(r) {
  const form = r && r.form ? plainFieldKinds(r.form) : normalizeForm(expandKind('approve'));
  const hint = secretHint(r);
  if (!hint) return form;
  return { fields: form.fields.concat([{ id: 'key', type: 'secret', label: 'The key (optional: only if this is what is asked for)', name: hint.name, multiline: true, required: false, hinted: true }]).filter((f, i, all) => all.findIndex(g => g.id === f.id) === i),
    actions: form.actions };
}
/* secretOnly(form) — a form that asks for nothing but a key (the secret kind: key + optional note, Store / Decline).
 * Only such a form closes when the key is stored; on any other form storing a key keeps the question open. */
function secretOnly(form) {
  const fs0 = (form && form.fields || []).filter(f => f.type !== 'info');
  return fs0.some(f => f.type === 'secret') && fs0.every(f => f.type === 'secret' || (f.type === 'text' && !f.required))
    && (form.actions || []).every(a => ['done', 'declined', 'couldnt', 'no'].includes(a.verdict));
}
// an action that only stores keys (needs = secret fields only): on a form that asks for more, it stores and keeps it open
function storeOnlyAction(form, act) {
  if (!act || !Array.isArray(act.needs) || !act.needs.length) return act && act.id === 'store-key';
  return act.needs.every(id => (form.fields || []).some(f => f.id === id && f.type === 'secret'));
}

/* ---- several questions in one request ----
 * A request may carry `questions`: [{id, prompt, kind?, spec?, form?, required?}], each its own little form
 * (approve/decline by default; any kind or a composed form). The owner answers each one on its own, and may send the
 * ones answered so far; the request stays open until every required question is answered or the owner closes the
 * rest (skipped). The final answer is {verdict: 'parts', parts: {<id>: {verdict, action, values, note?} | {skipped:true}}}. */
const QLIMIT = 12;
function normalizeQuestions(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('questions must be a non-empty list');
  if (list.length > QLIMIT) throw new Error('at most ' + QLIMIT + ' questions in one request');
  const ids = new Set(); const names = new Set();
  return list.map((x, i) => {
    if (!x || typeof x !== 'object') throw new Error('question ' + (i + 1) + ' is not an object');
    const id = String(x.id || 'q' + (i + 1)).trim();
    if (!ID.test(id)) throw new Error('question id "' + id + '": use lowercase letters, digits, - or _ (start with a letter)');
    if (ids.has(id)) throw new Error('two questions are called "' + id + '"'); ids.add(id);
    const prompt = str(x.prompt || x.message, 1000, 'question ' + id + ' prompt'); if (!prompt) throw new Error('question ' + id + ' needs a prompt (one plain sentence: the one decision it asks for)');
    const kind = x.form ? 'form' : String(x.kind || 'approve').toLowerCase();
    const form = x.form ? normalizeForm(x.form) : normalizeForm(expandKind(kind, x.spec || x));
    for (const f of form.fields) if (f.type === 'secret') { if (names.has(f.name)) throw new Error('two questions write secrets/' + f.name); names.add(f.name); }
    for (const f of form.fields) if (x.hinted && f.type === 'secret') f.hinted = true;
    return Object.assign({ id, prompt, kind, form }, x.required === false ? { required: false } : { required: true });
  });
}
/* decisionItems(text) — the separate decisions in an untyped text: a numbered list (1. … 2. …, at least two), else
 * at least two "should we / may we / do you approve" questions. null when it reads as one decision. */
function decisionItems(text) {
  const items = []; let cur = null;
  for (const l of String(text || '').split('\n')) {
    const m = /^\s{0,3}(\d{1,2})[.)]\s+(\S.*)$/.exec(l);
    if (m && Number(m[1]) === items.length + 1) { cur = { text: m[2].trim() }; items.push(cur); continue; }
    if (m && Number(m[1]) === 1) { if (items.length >= 2) break; items.length = 0; cur = { text: m[2].trim() }; items.push(cur); continue; }
    if (m) { if (items.length >= 2) break; items.length = 0; cur = null; continue; }
    if (cur && /^\s{2,}\S/.test(l)) cur.text += ' ' + l.trim(); else if (!l.trim()) cur = null;
  }
  if (items.length >= 2) return items.map(x => x.text);
  const qs = sentences(String(text || '').replace(/\n+/g, ' ')).filter(x => /\?\s*$/.test(x) && /\b(should|shall|may|can) (we|i)\b|\bdo you (approve|agree|want)\b|\bapprove\b/i.test(x));
  return qs.length >= 2 ? qs : null;
}
const short = (t, n) => { const s = String(t || '').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
/* inferQuestions(row) — an untyped row reshaped without dropping a part: each decision it lists becomes its own
 * approve/decline question, and a key it asks for becomes one more (optional) question with a secure field. One
 * decision and no key: null (the plain Approve / Decline / Reply card with the full text). */
function inferQuestions(r, opts) {
  if (!r || r.form || r.questions || r.gate) return null;
  const text = String(r.q || [r.message, r.details].filter(Boolean).join('\n\n'));
  const items = decisionItems(text);
  const hint = secretHint(r) || (opts && opts.keyName ? { name: opts.keyName } : null);
  if (!items && !hint) return null;
  const parts = items ? items.map((t, i) => ({ id: 'item-' + (i + 1), prompt: short(t, 600), kind: 'approve' }))
    : [{ id: 'decision', prompt: 'The request above, as a whole', kind: 'approve' }];
  if (hint) parts.push({ id: 'key', prompt: 'The key it asks for. Store it here, never in a message.', kind: 'secret', spec: { name: hint.name, label: 'The key', multiline: true }, hinted: true, required: false });
  return normalizeQuestions(parts);
}
// an answer that only stored a key (the old "Store the key securely" button, or a done with nothing but stored keys)
function storeOnlyAnswer(ans) {
  if (!ans || ans.verdict === 'parts' || ans.verdict === 'reply') return false;
  const v = ans.values || {}; const keys = Object.keys(v);
  return ans.action === 'store-key' || (ans.verdict === 'done' && keys.length > 0 && keys.every(k => v[k] && typeof v[k] === 'object' && v[k].stored));
}
const FOLLOW_UP_DAYS = 30;
const APPROVAL_WORDS = /\b(approve|approval|permission|go[- ]ahead|sign[- ]off|(may|should|shall|can) (we|i)|do you (want|agree)|patch(es)?|apply|merge|deploy|enable)\b/i;
/* followUpOf(row) — the recovery: an untyped question that was closed by storing a key while its text asked for more
 * comes back ONCE as a request with the key already stored and the rest still open. Never a second time (followedUp). */
function followUpOf(x) {
  if (!x || x.form || x.questions || x.gate || x.reclassified || x.followedUp || x.type !== 'answer' || !x.q) return null;
  if (!storeOnlyAnswer(x.answer)) return null;
  if (Date.now() - Date.parse(x.answeredAt || x.at) > FOLLOW_UP_DAYS * 86400e3) return null;
  const vals = x.answer.values || {}; const fid = Object.keys(vals).find(k => vals[k] && vals[k].stored);
  const keyName = fid ? String(vals[fid].stored).replace(/^secrets\//, '') : null;
  const qs = inferQuestions(x, { keyName });
  if (!qs || !qs.some(p => p.kind !== 'secret')) return null;
  // the rest must be a real ask: several listed decisions, or approval words (a key-only question stays answered)
  if (!qs.some(p => /^item-/.test(p.id)) && !APPROVAL_WORDS.test(String(x.q))) return null;
  const key = qs.find(p => p.kind === 'secret');
  return { questions: qs, prefilled: key && fid ? { [key.id]: { a: 'stored at ' + vals[fid].stored, answer: { verdict: 'done', action: 'store', values: { key: storeOf(vals[fid]) } }, at: x.answeredAt } } : {},
    storedAt: x.answeredAt, note: 'You stored the key; the rest of this request still needs you.' };
}
const storeOf = v => storedOf(v);
// the questions of a request (typed, a follow-up, or inferred from untyped text) and the ones already answered
function questionsOf(x) {
  if (x.questions) {
    const done = Object.assign({}, x.parts);
    // a question its asker withdrew ("no longer needed") is out of the request: hidden on Today, never asked again
    const qs = x.questions.filter(p => !(x.withdrawn && x.withdrawn[p.id])).map(p => p.form ? Object.assign({}, p, { form: plainFieldKinds(p.form) }) : p);
    return { questions: qs, done, withdrawn: x.withdrawn || null };
  }
  const fu = followUpOf(x); if (fu) return { questions: fu.questions, done: Object.assign({}, fu.prefilled, x.parts), followUp: fu };
  if (x.a) return null;
  const qs = inferQuestions(x); return qs ? { questions: qs, done: Object.assign({}, x.parts), inferred: true } : null;
}
function plainParts(questions, all) {
  return questions.map((p, i) => (i + 1) + '. ' + short(p.prompt, 90) + ': ' + (all[p.id] ? all[p.id].a || all[p.id].answer.verdict : 'skipped (closed without an answer)')).join('\n');
}
/* computeParts(row, parts, closeRest) — pure: check each answered question, say whether the request is now finished.
 * parts = {<question id>: {action, values, note} | {verdict:'reply', value}}. Throws Error with a plain reason. */
function computeParts(row, parts, closeRest) {
  const qo = questionsOf(row); if (!qo) throw new Error('this question has no separate questions; answer it as a whole');
  const results = {};
  for (const [pid, raw] of Object.entries(parts || {})) {
    const p = qo.questions.find(x => x.id === pid); if (!p) throw new Error('no question "' + pid + '" in this request (' + qo.questions.map(x => x.id).join(', ') + ')');
    if (qo.done[pid]) throw new Error('question ' + (qo.questions.indexOf(p) + 1) + ' is already answered');
    const prow = { form: p.form, stored: row.stored };
    let st; try { st = checkAnswer(prow, raw); } catch (e) { throw new Error('question ' + (qo.questions.indexOf(p) + 1) + ': ' + e.message); }
    results[pid] = { a: plainAnswer(prow, st).trim() || st.verdict, answer: st };
  }
  const all = Object.assign({}, qo.done, results);
  const left = qo.questions.filter(p => !all[p.id]);
  const finished = !!closeRest || !left.some(p => p.required !== false);
  const out = { results, all, questions: qo.questions, left: left.map(p => p.id), finished, followUp: !!qo.followUp };
  if (finished) {
    out.final = { verdict: 'parts', parts: {} };
    for (const p of qo.questions) out.final.parts[p.id] = all[p.id] ? Object.assign({}, all[p.id].answer) : { skipped: true };
    out.a = plainParts(qo.questions, all);
  } else out.a = plainParts(qo.questions.filter(p => all[p.id]), all);
  return out;
}
/* answerParts({id, by, parts, closeRest, quiet}) — record the owner's answers to some questions of a request; the
 * asker gets them at once (what is approved can start), and the whole list when the request is finished. */
function answerParts(o) {
  if (!isOwner(o.by)) { const e = new Error('only the Commander (the owner, the PM) can answer or close a question'); e.code = 3; throw e; }
  const id = String(o.id || ''); const row = state()[id];
  if (!row || !(row.type === 'ask' || followUpOf(row))) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  if (row.reclassified || row.withdrawnAll) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  if (isApprovalRow(row)) throw approvalRefusal(id);
  const c = computeParts(row, o.parts, o.closeRest);
  if (!Object.keys(c.results).length && !c.finished) throw new Error('answer at least one question, or close the rest');
  const at = new Date().toISOString();
  for (const [pid, r] of Object.entries(c.results)) append({ type: 'part', id, part: pid, at, a: r.a, answer: r.answer, by: 'Commander' });
  let delivered = null;
  if (c.finished) {
    append(Object.assign({ type: 'answer', id, at, a: c.a, answer: c.final, by: 'Commander' }, c.followUp ? { followUp: true } : {}));
    if (!o.quiet) { try { delivered = deliver(row, '\n' + c.a).id; } catch (_) {} }
  } else if (!o.quiet && Object.keys(c.results).length) {
    const n = c.questions.length - c.left.length;
    try { delivered = deliver(row, '(' + n + ' of ' + c.questions.length + ' answered so far; the rest are still open)\n' + plainParts(c.questions.filter(p => c.results[p.id]), c.all)).id; } catch (_) {}
  }
  return { ok: true, id, state: c.finished ? 'answered' : 'open', a: c.a, answer: c.finished ? c.final : null, answered: c.questions.length - c.left.length, total: c.questions.length, left: c.left, delivered };
}
/* recordStored({id, field, stored, by}) — a key stored inside a multi-field form: the file exists (the console wrote it),
 * the question stays open, and its final answer carries {stored, chars} for that field. */
function recordStored(o) {
  if (!isOwner(o.by)) { const e = new Error('only the owner stores keys'); e.code = 3; throw e; }
  const row = state()[String(o.id || '')]; if (!row || row.type !== 'ask') { const e = new Error('no open question ' + o.id); e.code = 4; throw e; }
  const f = formOf(row).fields.find(x => x.id === o.field && x.type === 'secret'); if (!f) throw new Error('no secret field "' + o.field + '" on this question');
  const v = storedOf(o); if (!/^secrets\/[A-Za-z0-9._-]+$/.test(v.stored)) throw new Error('a key is stored by the console (secrets/<name>)');
  append(Object.assign({ type: 'secret', id: row.id, at: new Date().toISOString(), field: f.id, by: 'Commander' }, v));
  return { ok: true, id: row.id, state: 'open', field: f.id, stored: v };
}

/* ---- the composer's rules: one decision per question, and never a shell command for the owner ----
 * The owner works only in the console. An ask that tells them to run something (patch -p1, node …, git …, "in your
 * shell", "run this") is refused with the route that does it instead. */
const SHELL_PHRASE = /\b(?:in|from|on|into|with|needs?|use) your (?:own )?(?:shell|terminal|command line)\b|\byour shell\b|(?:^|[.!?:]\s+|\n|\b(?:please|just|you can|you could|could you|can you|would you)\s+)run (?:this|these|the following|the commands?|them|it yourself)\b|\bpatch -p\d\b/i;
const CMD = /^\s*(?:[$>#]\s*)?(?:sudo\s+)?(?:patch|node|git|npm|npx|bash|sh|systemctl|docker|chmod|chown|curl|python3?|cd|cp|mv|rm)\s+\S/;
// a command the owner would have to type, wherever it sits in a sentence: sudo …, systemctl …, daemon-reload, npm/pip
// install …, git <verb> …, and any backticked text that starts with a command word
const CMD_WORDS = 'patch|node|git|npm|npx|pnpm|yarn|pip3?|pipx|apt(?:-get)?|dnf|pacman|brew|bash|sh|systemctl|journalctl|loginctl|docker|podman|chmod|chown|curl|wget|python3?|sudo|kill|pkill|crontab|ssh|scp|make|cd|cp|mv|rm|ln|tee|echo';
const INLINE_CMD = new RegExp('\\bsudo\\s+\\S+|\\bsystemctl\\s+(?:--user\\s+)?(?:daemon-reload|restart|start|stop|enable|disable|reload|reset-failed|mask|unmask|edit|set-property|link|kill)\\b|\\bdaemon-reload\\b|\\b(?:npm|pnpm|yarn)\\s+(?:i|install|ci|run|exec|update|link|publish)\\b|\\bpip3?\\s+install\\b|\\bgit\\s+(?:push|pull|reset|checkout|switch|commit|merge|rebase|clone|apply|am|stash|cherry-pick|revert|fetch|add|rm|tag|restore|clean)\\b|\\bloginctl\\s+enable-linger\\b|\\bjournalctl\\s+-', 'i');
const TICKED_CMD = new RegExp('`\\s*(?:\\$\\s*)?(?:' + CMD_WORDS + ')(?:\\s+[^`]*)?`', 'i');
// details may quote what an agent ran as evidence; there a command counts only next to words that hand it to the owner
const HANDS_OVER = /\b(?:on your (?:side|end|machine|computer)|you(?:'d| would| will)? (?:need to |have to )?(?:run|type|paste|execute)|for you to (?:run|type)|(?:may|can|could) (?:i|we) have (?:that|this|the|one)\b[^.?!]{0,30}\bcommand|that agents are refused|agents (?:are|were) refused|only you can run)\b/i;
function shellAsk(text, opts) {
  const t = String(text || '');
  const m = SHELL_PHRASE.exec(t); if (m) return m[0].trim();
  const strict = !(opts && opts.evidence);
  for (const sn of t.split(/(?<=[.!?])\s+|\n+/)) {
    const c = INLINE_CMD.exec(sn) || TICKED_CMD.exec(sn);
    if (c && (strict || HANDS_OVER.test(t))) return c[0].replace(/`/g, '').trim().slice(0, 80);
  }
  const h = HANDS_OVER.exec(t); if (h && /\bcommand\b/i.test(t)) return h[0].trim();
  // a command line the owner would type: inside a code fence, after a $ prompt, or a chained one (&&, <, |)
  let fence = false;
  for (const l of t.split('\n')) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (CMD.test(l) && (fence || /^\s*\$\s/.test(l) || /&&|\s<\s|\s\|\s/.test(l))) return l.trim().slice(0, 80);
  }
  return null;
}
function routeAdvice() {
  let tools = 'the tools seat'; try { const id = co.seatFor('tools'); if (id) tools = co.nameOf(id) + ' (the tools seat)'; } catch (_) {}
  return 'The owner works only in the console and never runs commands. Route it instead: ' +
    '(1) a change to a FRAMEWORK file (a tracked CaPheOS file such as company/tools/*.js) is a framework request: `node company/tools/harness-change.js propose --kind tool --target <file> --change <the diff> --why "…" --by <you>`; once reviewed, apply sends the framework the real diff. ' +
    '(2) a change to a company file only the owner may approve (a locked tool) is the same propose: it becomes one owner approval on Today, and harness-change applies it after the owner presses Approve. ' +
    '(3) anything else that needs a command run is a handoff to ' + tools + '. Then ask the owner only the decision, in plain words.';
}
/* composerCheck({message, details, q, questions, form}) -> null, or a reason the ask is refused */
function composerCheck(o) {
  // what the owner is asked (the message, each question, a form's text) is held to the strict rule; details and an old
  // --q may quote commands as evidence, and count only when they hand the command to the owner
  const asks = [o.message].concat((o.questions || []).map(x => x && x.prompt)).concat((o.questions || []).map(x => x && x.form && (x.form.fields || []).map(f => f && (f.text || f.help)).join('\n'))).concat(((o.form && o.form.fields) || []).map(f => f && (f.text || f.help)));
  const texts = asks.map(t => [t, false]).concat([[o.details, true], [o.message ? null : o.q, true]]);
  for (const [t, evidence] of texts) { const hit = t && shellAsk(t, { evidence }); if (hit) return 'Not asked: it tells the owner to run a command ("' + hit + '"). ' + routeAdvice(); }
  return null;
}

/* ownerScopeCheck(o) — the owner-scope rule (lib/owner-scope.js): a crew-scope ask is refused with where it goes, a
 * topic the owner answered "not now" within 7 days is refused unless o.changed says what changed, and every owner
 * question must read plainly (two short sentences, no jargon, what they get, what happens if they skip it).
 * An approval record carries its category (and the fixed flag) from approvals.js; an older gate question is a fixed gate. */
function crewSeats() {
  const out = {};
  for (const fn of ['risk', 'tools', 'floor']) { try { const c = co.crew(); const id = Object.keys(c).find(k => co.holds(c[k], fn)); out[fn] = id ? co.nameOf(id) : null; } catch (_) { out[fn] = null; } }
  return out;
}
/* scopeExempt (in process only, never from the CLI): 'framework' for the framework's own owner gates (the money hold,
 * the pacer), true for the selftest's form fixtures below.
 * framework-composed asks: a framework tool that composes its own owner gate (an onboarding batch, a pack, a console
 * panel, a system package) is exempt from the owner-scope rule. In process it passes scopeExempt: 'framework'; over the
 * CLI it passes --via <tool>, honoured only when the parent process really is that framework tool (Linux /proc: a node
 * whose script is company/tools/<tool>), so an agent's shell cannot claim it. */
const FRAMEWORK_VIA = new Set(['onboard.js', 'pack.js', 'console-panel.js', 'deps.js']);
function viaFramework(via) {
  const v = String(via || ''); if (!FRAMEWORK_VIA.has(v)) return false;
  try {
    const argv = fs.readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\0').filter(Boolean);
    if (!argv.length || !/(^|\/)node(js)?$/.test(argv[0]) && argv[0] !== process.execPath) return false;
    const cwd = fs.readlinkSync('/proc/' + process.ppid + '/cwd');
    const script = argv.slice(1).find(x => !x.startsWith('-'));
    return !!script && path.resolve(cwd, script).split(path.sep).slice(-3).join('/') === 'company/tools/' + v;
  } catch (_) { return false; }
}
function ownerScopeCheck(o) {
  const ap = o.approval || null;
  const fixedGate = !!o.gate || !!o.fixedGate;
  return require('./lib/owner-scope').check({ from: o.from, about: o.about, message: o.message, details: o.details, q: o.q, questions: o.questions,
    category: ap ? ap.category : (o.gate ? 'gate' : null), level: ap && ap.level, fixed: fixedGate, approvalDigest: ap && ap.actionDigest, changed: o.changed },
  { rows: readAll(), seats: crewSeats() });
}

/* listItems({open?, from?}) — the rows `inbox.js list` prints. A question its asker withdrew whole is not open: before
 * `list` used to print it with status "open" (and `--open` kept it); a question withdrawn whole is not open. */
function listItems(a) {
  a = a || {}; const now = Date.now();
  const rows = Object.values(state()).filter(x => x.type === 'ask' && (!a.open || (!x.a && !x.reclassified && !x.withdrawnAll)) && (!a.from || String(x.from).toLowerCase() === String(a.from).toLowerCase()));
  return rows.map(x => {
    const snoozed = !x.a && x.snoozedUntil && Date.parse(x.snoozedUntil) > now ? x.snoozedUntil : null;
    return { id: x.id, from: x.from, about: x.about, kind: x.kind || 'approve', message: messageParts(x).message, q: x.q, blocking: x.blocking, askedAt: x.at, answer: x.a || null, answerDetail: x.answer || null, answeredBy: x.by || null, reclassified: x.reclassified || null,
      withdrawn: x.withdrawnAll || null,
      snoozedUntil: snoozed, status: x.a ? 'answered' : x.reclassified ? 'reclassified' : x.withdrawnAll ? 'withdrawn by ' + x.withdrawnAll.by : snoozed ? 'snoozed until ' + snoozed : 'open' };
  });
}
/* openQuestions() — the single definition of "an open PM question": an ask that has no answer and has not been
 * reclassified to company ownership. A snoozed question is still open; it carries snoozedUntil while the snooze runs. */
function openQuestions() {
  const now = Date.now();
  return Object.values(state())
    .filter(x => ((x.type === 'ask' && !x.a && !x.reclassified) || followUpOf(x)) && !x.withdrawnAll)
    .map(x => {
      const m = messageParts(x);
      const o = { id: x.id, from: x.from, about: x.about, q: x.q, message: m.message, details: m.details, messageDerived: m.derived,
        blocking: x.blocking, askedAt: x.askedAt || x.at, batch: x.batch || null, kind: x.kind || (x.form ? 'form' : 'approve'), form: formOf(x) };
      if (x.snoozedUntil && Date.parse(x.snoozedUntil) > now) o.snoozedUntil = x.snoozedUntil;
      const hint = secretHint(x); if (hint) o.secretHint = hint;
      if (x.stored) o.stored = x.stored;
      // an owner card (lib/owner-card.js): the plain parts, the collapsed technical part, the typed effect
      if (x.technical) o.technical = x.technical;
      if (x.card) { o.card = true; o.consequence = x.consequence || null; o.recommendation = x.recommendation || null; o.effect = x.effect || null; if (x.expiresAt) o.expiresAt = x.expiresAt; }
      if (x.approval) o.approval = { category: x.approval.category, actionDigest: x.approval.actionDigest || null, expiresAt: x.approval.expiresAt || null, default: 'deny' };
      o.secretOnly = secretOnly(o.form);
      const qo = questionsOf(x);
      if (qo) {
        o.kind = 'multi'; if (qo.inferred) o.inferred = true;
        o.questions = qo.questions.map(p => Object.assign({}, p, { answered: qo.done[p.id] ? { a: qo.done[p.id].a, at: qo.done[p.id].at } : null }));
        o.progress = { answered: o.questions.filter(p => p.answered).length, total: o.questions.length, requiredLeft: o.questions.filter(p => !p.answered && p.required !== false).length };
        if (qo.followUp) o.followUp = { note: qo.followUp.note, storedAt: qo.followUp.storedAt, earlierAnswer: x.a };
        if (x.withdrawn) o.withdrawn = Object.entries(x.withdrawn).map(([part, w]) => Object.assign({ part, prompt: ((x.questions || []).find(p => p.id === part) || {}).prompt || part }, w));
      }
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
  if (!q) throw new Error('--message is required (two plain sentences; old form: --q)');
  if (String(q).length > LIMITS.details + LIMITS.message) throw new Error('the question is too long');
  let kind = o.kind ? String(o.kind).toLowerCase() : null, form, questions = null;
  const rawForm = o.form ? (typeof o.form === 'string' ? JSON.parse(o.form) : o.form) : null;
  const rawQs = o.questions ? (typeof o.questions === 'string' ? JSON.parse(o.questions) : o.questions) : null;
  const refused = composerCheck({ message, details, q, questions: rawQs, form: rawForm }); if (refused) throw Object.assign(new Error(refused), { code: 'shell' });
  if (rawQs) { questions = normalizeQuestions(rawQs); kind = 'multi'; }
  else if (rawForm) { form = normalizeForm(rawForm); kind = 'form'; }
  else { form = normalizeForm(expandKind(kind || 'approve', o.spec)); kind = kind || 'approve'; }
  // a key that is already stored is not asked for again, unless --changed says why (it stopped working, it was rotated)
  if (!String(o.changed || '').trim()) {
    const secretNames = [].concat(form ? form.fields : [], ...(questions || []).map(x => (x.form && x.form.fields) || [])).filter(f => f && f.type === 'secret' && f.name).map(f => f.name);
    const have = secretNames.filter(n => secretStored(n));
    if (have.length) throw Object.assign(new Error('Not asked: the key ' + have.map(n => 'secrets/' + n).join(', ') + ' is already stored. Use it (read it with co.secret(\'' + have[0] + '\') in a tool); if it stopped working or must be replaced, ask again with --changed "<what is different now>".'), { code: 'secret-exists', stored: have });
  }
  // a request for a key or an account is the access gate (fixed): no standing ruling refuses or hides it
  const accessAsk = ['secret', 'account', 'link'].includes(kind) || [].concat(form ? form.fields : [], ...(questions || []).map(x => (x.form && x.form.fields) || [])).some(f => f && f.type === 'secret') ||
    (questions || []).some(x => x && ['secret', 'account', 'link'].includes(x.kind));
  if (!o.scopeExempt) { const sc = ownerScopeCheck({ from: o.from, about: o.about, message, details, q, questions: rawQs, approval: o.approval, gate: o.gate, fixedGate: o.fixedGate || (accessAsk ? 'access' : undefined), changed: o.changed }); if (sc) throw Object.assign(new Error(sc.error), { code: sc.code, suggestion: sc.suggestion, route: sc.route, prior: sc.prior }); }
  // one decision per question: a single Approve/Decline that bundles several decisions is refused, with the split ready
  if (kind === 'approve' && !o.gate && !o.oneDecision) {
    const items = decisionItems(q);
    if (items) throw Object.assign(new Error('Not asked: this is one Approve/Decline for ' + items.length + ' separate decisions, so the owner could only say yes or no to all of them. Send one question per decision with --questions (each is answered on its own), e.g. --questions \'' +
      JSON.stringify(items.slice(0, QLIMIT).map((t, i) => ({ id: 'item-' + (i + 1), prompt: short(t, 160), kind: 'approve' }))) + '\' — or, if the list is only evidence for ONE decision, add --one-decision.'), { code: 'bundled', suggestion: items.map((t, i) => ({ id: 'item-' + (i + 1), prompt: short(t, 600), kind: 'approve' })) });
  }
  const row = { type: 'ask', id: newId(), at: new Date().toISOString(), from: String(o.from || 'unknown'), about: String(o.about || ''), q, blocking: !!o.blocking };
  if (message) row.message = message; if (details) row.details = details;
  if (questions) { row.kind = 'multi'; row.questions = questions; }
  else if (kind !== 'approve' || form.actions.some(a => a.does)) { row.kind = kind; row.form = form; }
  if (o.batch) row.batch = o.batch; if (o.gate) row.gate = o.gate;
  if (o.changed && String(o.changed).trim()) row.changed = String(o.changed).replace(/\s+/g, ' ').trim().slice(0, 300);   // asked again after a "not now": what changed
  if (o.approval) row.approval = o.approval;   // approvals.js: category, canonical params, actionDigest, expiresAt, dependsOn
  if (o.technical && String(o.technical).trim()) row.technical = String(o.technical).trim().slice(0, LIMITS.details);   // shown collapsed: Technical details (for the crew)
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
  const kept = (row && row.stored) || {};   // keys stored earlier inside this form (recordStored): part of the final answer
  for (const f of form.fields) {
    if (f.type === 'info') continue;
    let v = vals[f.id];
    if ((v === undefined || v === null || v === '') && f.type === 'secret' && kept[f.id] && act.needs !== 'none') v = kept[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (f.type === 'checkbox' && v === false && need.has(f.id));
    if (empty) { if (need.has(f.id)) throw new Error((f.label || f.id) + ': ' + (f.type === 'checkbox' ? 'tick it' : f.type === 'secret' ? 'paste the key' : f.type === 'slider' ? 'set the slider' : f.type === 'url' ? 'paste the address' : 'fill it in')); continue; }
    if (act.needs === 'none' && !Array.isArray(act.needs) && f.type === 'secret') continue;   // declining never stores a key
    if (f.type === 'text') {
      const t = String(v).trim(); if (f.minLength && t.length < f.minLength) throw new Error((f.label || f.id) + ': at least ' + f.minLength + ' characters, please (' + t.length + ' written)');
      if (t.length > (f.maxLength || LIMITS.value)) throw new Error((f.label || f.id) + ': at most ' + (f.maxLength || LIMITS.value) + ' characters (' + t.length + ' written)');
      if (t) out.values[f.id] = t;
    } else if (f.type === 'url') {
      const u = String(v).trim(); let x = null; try { x = new URL(u); } catch (_) {}
      if (!x || !(x.protocol === 'https:' || (f.allowHttp && x.protocol === 'http:')) || x.username || x.password) throw new Error((f.label || f.id) + ': a web address starting with https://, please');
      if (u.length > 2000) throw new Error((f.label || f.id) + ': at most 2000 characters');
      out.values[f.id] = x.toString();
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
  // recorded in the provenance log first (lib/owner-channel.js); an agent's run writes nothing here (it is not the owner)
  return require('./lib/owner-channel').append(oi.INBOUND(), row, 'inbox.js');
}
/* answer({id, by, answer|text, quiet}) — record the owner's answer. Returns {ok, id, state, a, answer, delivered}. */
function answer(o) {
  if (!isOwner(o.by)) { const e = new Error('only the Commander (the owner, the PM) can answer or close a question'); e.code = 3; throw e; }
  const id = String(o.id || ''); if (!id) throw new Error('--id is required');
  const q = state()[id];
  if (!q || !(q.type === 'ask' || followUpOf(q)) || q.withdrawnAll) { const e = new Error('no question ' + id + (q && q.withdrawnAll ? ' (withdrawn by ' + q.withdrawnAll.by + ')' : '')); e.code = 4; throw e; }
  if (isApprovalRow(q)) throw approvalRefusal(id);
  if (o.parts || o.closeRest) return answerParts(o);
  const qo = questionsOf(q);
  if (qo) {   // a request with several questions: a reply answers it as a whole; a plain yes/no applies to each open approve question
    const raw = o.answer || fromText(o.text, q);
    if (raw && raw.verdict !== 'reply') {
      const parts = {};
      for (const p of qo.questions) if (!qo.done[p.id] && p.form.actions.some(a => a.verdict === raw.verdict)) parts[p.id] = { verdict: raw.verdict, values: {}, note: raw.note || (raw.values && raw.values.reason) || undefined };
      if (!Object.keys(parts).length) throw new Error('this request has ' + qo.questions.length + ' questions; answer each one (parts)');
      return answerParts(Object.assign({}, o, { parts }));
    }
  }
  const form0 = formOf(q); const raw0 = o.answer || fromText(o.text, q);
  const act0 = raw0 && form0.actions.find(x => x.id === raw0.action);
  if (act0 && storeOnlyAction(form0, act0) && !secretOnly(form0)) throw new Error('storing a key does not answer this question: it asks for more than the key. Store the key (it stays open), then answer with ' + form0.actions.filter(a => !storeOnlyAction(form0, a)).map(a => a.label).join(' / '));
  const structured = checkAnswer(q, raw0);
  const plain = plainAnswer(q, structured).trim() || structured.verdict;
  append({ type: 'answer', id, at: new Date().toISOString(), a: plain, answer: structured, by: 'Commander' });
  let delivered = null;
  if (!o.quiet) { try { delivered = deliver(q, plain).id; } catch (_) {} }
  return { ok: true, id, state: 'answered', a: plain, answer: structured, delivered };
}
/* withdraw({id, part?, why, by}) — the ASKER takes back a question that is no longer needed (the thing it asked about was
 * fixed another way, or it is moot): one question of a request (`part`: its id or its number) or the whole ask. Today
 * stops showing it and lists "withdrawn by <asker>: <why>" under Answered today. When the questions left are all
 * answered, the request finishes with what the owner answered (the withdrawn ones recorded as withdrawn). */
function withdraw(o) {
  const id = String(o.id || ''); const row = state()[id];
  if (!row || row.type !== 'ask' || row.a || row.reclassified || row.withdrawnAll) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  const who = String(o.by || '').trim(); const from = String(row.from || '').trim().toLowerCase();
  const asker = who && (who.toLowerCase() === from || who.split(/\s+/)[0].toLowerCase() === from.split(/\s+/)[0]);
  if (!asker && !isOwner(who)) { const e = new Error('only the asker (' + row.from + ') withdraws its own question'); e.code = 3; throw e; }
  const seat = callerSeat(row, who, 'withdraw'); const so = seat ? { seat } : undefined;
  const why = String(o.why || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (!why) throw new Error('--why is required: one plain line on why it is no longer needed');
  const at = new Date().toISOString();
  let part = o.part === undefined || o.part === null || o.part === true || o.part === '' ? null : String(o.part);
  if (part) {
    if (!row.questions) throw new Error(id + ' is one question: withdraw it whole (no --part)');
    if (/^\d+$/.test(part)) { const p = row.questions[Number(part) - 1]; if (!p) throw new Error('no question ' + part + ' in ' + id); part = p.id; }
    if (!row.questions.some(p => p.id === part)) throw new Error('no question "' + part + '" in ' + id + ' (' + row.questions.map(p => p.id).join(', ') + ')');
    if (row.parts && row.parts[part]) throw new Error('question ' + part + ' is already answered');
    if (row.withdrawn && row.withdrawn[part]) throw new Error('question ' + part + ' is already withdrawn');
  }
  append(Object.assign({ type: 'withdraw', id, at, why, by: who }, part ? { part } : {}), so);
  if (!part) return { ok: true, id, state: 'withdrawn', why };
  // every question left answered (or withdrawn): the request is finished with the answers it has
  const now = state()[id]; const qo = questionsOf(now);
  const left = qo.questions.filter(p => !qo.done[p.id] && p.required !== false);
  if (!left.length) {
    if (!qo.questions.some(p => qo.done[p.id])) { append({ type: 'withdraw', id, at, why: 'every question withdrawn: ' + why, by: who }, so); return { ok: true, id, part, state: 'withdrawn', why }; }
    const final = { verdict: 'parts', parts: {} };
    for (const p of now.questions) final.parts[p.id] = now.withdrawn && now.withdrawn[p.id] ? { withdrawn: true, why: now.withdrawn[p.id].why } : qo.done[p.id] ? Object.assign({}, qo.done[p.id].answer) : { skipped: true };
    append({ type: 'answer', id, at, a: plainParts(qo.questions, qo.done), answer: final, by: 'Commander', closedBy: 'withdraw' }, so);
    return { ok: true, id, part, state: 'answered', why };
  }
  return { ok: true, id, part, state: 'open', left: left.map(p => p.id), why };
}
/* withdrawnSince(sinceMs) — withdrawn questions (whole asks and single questions of a request), newest first, for Today */
function withdrawnSince(since) {
  const rows = readAll(); const asks = {}; for (const r of rows) if (r.type === 'ask') asks[r.id] = r;
  return rows.filter(r => r.type === 'withdraw' && Date.parse(r.at) >= (since || 0) && asks[r.id] && !/^every question withdrawn/.test(r.why || '')).map(r => {
    const a = asks[r.id]; const p = r.part && (a.questions || []).find(x => x.id === r.part);
    return { id: r.id, part: r.part || null, from: a.from, by: r.by, why: r.why, at: r.at, message: p ? p.prompt : messageParts(a).message };
  }).reverse();
}
/* reclassify({id, note, by}) — the ASKER says its question is the company's to decide after all (who owns it in the note):
 * it leaves the owner's list. Only the asker's own run (callerSeat), or the owner. */
function reclassify(o) {
  const id = String(o.id || ''); const row = state()[id];
  if (!row || row.type !== 'ask' || row.a || row.reclassified || row.withdrawnAll) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  const note = String(o.note || '').trim(); if (!note) throw new Error('--note is required (what the company decided and who owns it)');
  const by = String(o.by || '').trim(); const from = String(row.from || '');
  const asker = by && (by.toLowerCase() === from.toLowerCase() || by.split(/\s+/)[0].toLowerCase() === from.split(/\s+/)[0].toLowerCase());
  if (!asker && !isOwner(by)) { const e = new Error('only the asker (' + row.from + ') reclassifies its own question'); e.code = 3; throw e; }
  const seat = callerSeat(row, by, 'reclassify');
  append({ type: 'reclassify', id, at: new Date().toISOString(), note, by }, seat ? { seat } : undefined);
  return { ok: true, id, state: 'reclassified-company-owned', by, note };
}
/* snooze({id, until, by}) — hide an open question from Today until `until` (at most 30 days); the asker sees it in list. */
function snooze(o) {
  if (!isOwner(o.by)) { const e = new Error('only the owner can snooze a question'); e.code = 3; throw e; }
  const id = String(o.id || ''); const q = state()[id];
  if (!q || ((q.type !== 'ask' || q.a || q.reclassified) && !followUpOf(q))) { const e = new Error('no open question ' + id); e.code = 4; throw e; }
  const t = Date.parse(o.until);
  if (!Number.isFinite(t) || t <= Date.now() || t > Date.now() + 31 * 86400e3) throw new Error('--until must be a time in the next 30 days');
  const until = new Date(t).toISOString();
  append({ type: 'snooze', id, at: new Date().toISOString(), until, by: 'Commander' });
  return { ok: true, id, snoozedUntil: until };
}
function out(code, obj) {   // write all of it before exiting: process.exit after console.log cuts piped output at 64KB
  const b = Buffer.from(JSON.stringify(obj, null, 1) + '\n'); let o = 0;
  while (o < b.length) { try { o += fs.writeSync(1, b, o); } catch (e) { if (e.code === 'EPIPE') break; if (e.code !== 'EAGAIN') throw e; } }
  process.exit(code);
}

module.exports = { withdraw, withdrawnSince, reclassify, callerSeat, plainFieldKinds, secretOnly, storeOnlyAction, normalizeQuestions, decisionItems, inferQuestions, followUpOf, questionsOf, computeParts, answerParts, recordStored,
  shellAsk, composerCheck, ownerScopeCheck, viaFramework, routeAdvice, asksForCredential, openQuestions, state, readAll, ask, answer, snooze, normalizeForm, expandKind, formOf, checkAnswer, plainAnswer, secretHint, sliderWords,
  messageParts, styleWarnings, safeSecretName, secretStored, KINDS, FIELD_TYPES, VERDICTS, FILE, deliver, isOwner };

/* ---- selftest: a scratch inbox, owner dir and governance root ---- */
function selftest() {
  const os = require('os');
  const T = require('./lib/temp-life').tmpDir('inbox-selftest-');
  process.env.PM_INBOX_FILE = path.join(T, 'company', 'pm-inbox.jsonl'); process.env.OWNER_DIR = path.join(T, 'company', 'owner');
  process.env.PROVENANCE_ROOT = T; require('./provenance.js').pinUnderStation(false);   // the owner channel's provenance (lib/owner-channel.js) is this fixture's
  process.env.INBOX_SECRETS_DIR = path.join(T, 'secrets');   // the fixture's own key folder (a stored key is not asked again)
  const cases = []; const t = (n, c, info) => { cases.push(!!c); console.log((c ? 'ok   ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 300))); };
  const throws = f => { try { f(); return null; } catch (e) { return e.message; } };
  // the fixtures below test the form, answer and message machinery, not the owner-scope rule (its own cases are at the end)
  const ask = o => module.exports.ask(Object.assign({ scopeExempt: true }, o));
  const by = 'Commander';
  const open = id => openQuestions().find(q => q.id === id);
  try {
    // messages
    const dense = 'Access gate (gate 2), no payment: a read-only Tradex API key, from an account you create in your own name. Why it is the binding one: Tradex\'s websocket rejects anonymous connections (HTTP/1.1 401 measured from this station today), so sub-second book is closed to us. A key buys about 1 Hz quotes.';
    const legacy = ask({ from: 'Founder', q: dense });
    t('an old-style --q ask warns that there is no message', legacy.warnings.length === 1 && /no --message/.test(legacy.warnings[0]));
    const lq = open(legacy.row.id);
    t('an old question shows its first two sentences as the message, the rest as detail', lq.messageDerived && /^Access gate/.test(lq.message) && /binding one/.test(lq.message) && /1 Hz/.test(lq.details) && !/1 Hz/.test(lq.message), lq);
    t('an ask with no kind is an approve form: Approve / Decline + reason, no form written, no store-key button', !('form' in legacy.row) && lq.form.actions.map(a => a.id).join() === 'approve,decline');
    t('an untyped key ask is reshaped into two questions: the decision and the key (nothing dropped)', lq.kind === 'multi' && lq.questions.map(p => p.id + ':' + p.kind).join() === 'decision:approve,key:secret' && lq.questions[1].required === false, lq.questions);
    const long = ask({ from: 'Founder', message: 'We need ' + 'a lot of words here, '.repeat(25) + 'ok.', details: 'x' });
    t('a long message warns', long.warnings.some(w => /characters/.test(w)));
    const jar = ask({ from: 'Founder', message: 'Edit `company/tools/x.js` so q-123456 exits 0 (HTTP 401 at 50 ms).' });
    t('a jargon-dense message warns', jar.warnings.some(w => /reads like a report/.test(w)), jar.warnings);
    const good = ask({ from: 'Founder', message: 'Could you make us a free Quotely account and paste its API key? It lets us test our main idea about commodity prices. If you say no, that idea waits.', details: 'Quotely answers 401 without a key; 200 ms gold, 50 ms WTI.', kind: 'secret', spec: { name: 'quotely-api-key', label: 'Quotely API key', provider: 'quotely.network > Developers' } });
    t('a plain message with details: no warnings; q keeps both for old readers', good.warnings.length === 0 && /\n\nQuotely answers 401/.test(good.row.q) && open(good.row.id).details.startsWith('Quotely'));
    require('./lib/pm-inbox-guard').append(FILE(), { type: 'ask', id: 'q-000001', at: new Date().toISOString(), from: 'Founder', q: 'Old row. May we go?' }, 'selftest');
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
    const sec = ask({ from: 'Founder', message: 'The Tradex key, please.', kind: 'secret', spec: { name: 'tradex-api-key' } });
    r = answer({ id: sec.row.id, by, answer: { action: 'decline', note: 'not this week' } });
    t('secret: declining needs no key', r.answer.verdict === 'declined' && /will not provide/.test(r.a));
    r = answer({ id: 'q-000001', by, text: 'yes: go ahead' });
    t('a legacy text answer becomes {verdict: yes, reason}', r.answer.verdict === 'yes' && r.answer.values.reason === 'go ahead' && r.a === 'yes. go ahead');
    // legacy key question: a secure field as an extra option
    const kq = ask({ from: 'Founder', q: 'Access gate (gate 2), no payment: a read-only Tradex API key, from an account you create in your own name.' });
    t('legacy key question: secretHint tradex-api-key, a key question in the request, no store-key action', (open(kq.row.id).secretHint || {}).name === 'tradex-api-key' && open(kq.row.id).questions.some(p => p.id === 'key' && p.form.fields[0].name === 'tradex-api-key') && !open(kq.row.id).form.actions.some(a => a.id === 'store-key'));
    t('legacy: "a free Quotely API key" -> quotely-api-key', (secretHint({ q: 'Access gate (gate 2), no payment, second key: a free Quotely API key.' }) || {}).name === 'quotely-api-key');
    { // a key stored BEFORE the question was asked is not asked again; one stored after it (the owner answering it) keeps the field
      const sd = path.join(T, 'secrets'); fs.mkdirSync(sd, { recursive: true }); const kf = path.join(sd, 'zeta-api-key'); fs.writeFileSync(kf, 'k\n');
      const old = new Date(Date.now() - 3600e3); fs.utimesSync(kf, old, old);
      const row = at => ({ q: 'Access gate (gate 2), no payment: a free Zeta API key.', at });
      t('a key stored before the ask: no key field on the old row', secretHint(row(new Date().toISOString())) === null);
      t('a key stored after the ask (the owner answering it): the key field stays', (secretHint(row(new Date(Date.now() - 7200e3).toISOString())) || {}).name === 'zeta-api-key');
      fs.rmSync(kf);
    }
    // a question that MENTIONS a credential is not a question that ASKS for one
    const mq = ask({ from: 'Founder', q: 'Four one-file patches are ready. Two close blind spots, and the provider key is a symlink the watcher cannot see. Do you approve them?' });
    t('approve that only mentions a key: no hint, Approve/Decline only', !open(mq.row.id).secretHint && open(mq.row.id).form.actions.map(a => a.id).join() === 'approve,decline', JSON.stringify(open(mq.row.id).form.actions.map(a => a.id)));
    t('a plain approve row refuses store-key (no store-key action on it)', throws(() => answer({ id: mq.row.id, by, answer: { action: 'store-key', values: { key: { stored: 'secrets/x', chars: 5 } } } })) !== null);
    t('asksForCredential: asks vs mentions', asksForCredential('Could you create an account and paste its API key?') && asksForCredential('Gate 2: a free Quotely API key.') && !asksForCredential('The key is a symlink the watcher cannot see.') && !asksForCredential('Reads the password policy and approves.') && asksForCredential('We need a read-only exchange API key.'));
    t('the key question needs the key', /paste the key/.test(throws(() => answer({ id: kq.row.id, by, parts: { key: { action: 'store' } } }))));
    r = answer({ id: kq.row.id, by, parts: { key: { action: 'store', values: { key: { stored: 'secrets/tradex-api-key', chars: 40 } } } } });
    t('storing the key answers only the key question: the request stays open, 1 of 2', r.state === 'open' && r.answered === 1 && open(kq.row.id) && open(kq.row.id).progress.answered === 1 && open(kq.row.id).questions[1].answered, r);
    r = answer({ id: kq.row.id, by, parts: { decision: { action: 'approve' } } });
    t('approving closes it; the answer has both (approve + {stored, chars})', r.state === 'answered' && !open(kq.row.id) && r.answer.verdict === 'parts' && r.answer.parts.decision.verdict === 'yes' && r.answer.parts.key.values.key.stored === 'secrets/tradex-api-key' && r.answer.parts.key.values.key.chars === 40 && /stored at secrets\/tradex-api-key \(40 chars, validated: not checked\)/.test(r.a), r);
    // several questions in one request: each answered on its own, partial sends, the request open until all are done
    const three = ask({ from: 'Founder', message: 'Three things for the recorder this week.', questions: [
      { id: 'trial', prompt: 'Start the free trial?', kind: 'approve' },
      { id: 'plan', prompt: 'Which plan after it?', kind: 'choice', spec: { options: 'free:Free,hobby:Hobby' } },
      { id: 'cap', prompt: 'Monthly cap?', kind: 'number', spec: { unit: 'USD', min: 0, max: 50 } }] });
    t('a request with 3 questions opens as kind multi, 0 of 3', open(three.row.id).kind === 'multi' && open(three.row.id).progress.total === 3 && open(three.row.id).progress.answered === 0);
    r = answer({ id: three.row.id, by, parts: { trial: { action: 'approve' }, plan: { action: 'choose', values: { choice: 'hobby' } } } });
    t('2 of 3 sent: still open with one left; the asker hears the two now', r.state === 'open' && r.left.join() === 'cap' && open(three.row.id).progress.requiredLeft === 1 && require('./owner-inbox.js').messages().some(m => m.re === three.row.id && /2 of 3 answered so far/.test(m.text)), r);
    t('an answered question cannot be answered again', /already answered/.test(throws(() => answer({ id: three.row.id, by, parts: { trial: { action: 'decline' } } }))));
    r = answer({ id: three.row.id, by, parts: { cap: { action: 'send', values: { value: 20 } } } });
    t('the last one closes it; the record has all three', r.state === 'answered' && !open(three.row.id) && r.answer.parts.trial.verdict === 'yes' && r.answer.parts.plan.values.choice === 'hobby' && r.answer.parts.cap.values.value === 20 && /1\. Start the free trial\?: yes/.test(r.a) && state()[three.row.id].answer.verdict === 'parts', r);
    const two = ask({ from: 'Founder', message: 'Two things.', questions: [{ id: 'a', prompt: 'Do A?' }, { id: 'b', prompt: 'Do B?' }] });
    answer({ id: two.row.id, by, parts: { a: { action: 'decline' } } });
    r = answer({ id: two.row.id, by, closeRest: true });
    t('closing the rest: the unanswered ones are recorded as skipped', r.state === 'answered' && r.answer.parts.a.verdict === 'no' && r.answer.parts.b.skipped === true && /skipped/.test(r.a), r);
    // the composer: one decision per question, never a shell command for the owner
    const bundled = throws(() => ask({ from: 'Founder', message: 'Four fixes are ready. Approve them?', details: '1. Fix the watcher.\n2. Fix the dispatcher.\n3. Fix the budget.' }));
    t('composer: a single approve that bundles 3 numbered decisions is refused with a --questions split', /3 separate decisions/.test(bundled || '') && /--questions/.test(bundled), bundled);
    t('composer: --one-decision lets a numbered evidence list through', !!ask({ from: 'Founder', message: 'Ship it?', details: '1. tests green\n2. reviewed', oneDecision: true }).row.id);
    for (const [label, txt] of [['patch -p1', 'Apply it with `patch -p1 < scratch/x.diff`, please.'], ['node in a fence', 'Approve?\n\n```\nnode company/tools/dispatch.js --selftest\n```'], ['git chained', 'Then:\ngit pull && git push'], ['in your shell', 'This needs a minute in your shell.'], ['run this', 'Could you run this for me? It is quick.']]) {
      const e = throws(() => ask({ from: 'Founder', message: 'One quick thing.', details: txt }));
      t('composer refuses a shell ask (' + label + ') and names the routes', /tells the owner to run a command/.test(e || '') && /framework request/.test(e) && /harness-change applies it after the owner presses Approve/.test(e) && /handoff to/.test(e), e);
    }
    t('composer: a question prompt with a command is refused too', /run a command/.test(throws(() => ask({ from: 'F', message: 'Two.', questions: [{ prompt: 'OK to run: patch -p1 < a.diff' }, { prompt: 'B?' }] })) || ''));
    t('composer: evidence that mentions a tool in prose is fine', !!ask({ from: 'Founder', message: 'May we keep the watcher on?', details: 'I ran the selftest of locked-watch.js: 16 checks passed.' }).row.id);
    // a typed form with a key and more: storing the key keeps it open; the final answer carries both
    const kf = ask({ from: 'Founder', message: 'Two quick things.', form: { fields: [{ id: 'ok', type: 'checkbox', label: 'Emails may go to you', required: true }, { id: 'pk', type: 'secret', label: 'Ping key', name: 'ping-key', required: false }], actions: [{ id: 'store', label: 'Store the key', verdict: 'done', needs: ['pk'] }, { id: 'go', label: 'Here you go', verdict: 'done' }] } });
    t('form: a store-only action on a form that asks for more does not answer it', /does not answer this question/.test(throws(() => answer({ id: kf.row.id, by, answer: { action: 'store', values: { pk: { stored: 'secrets/ping-key', chars: 9 } } } })) || '') && !open(kf.row.id).secretOnly);
    recordStored({ id: kf.row.id, by, field: 'pk', stored: 'secrets/ping-key', chars: 9, validated: null });
    t('form: a key stored inside it is recorded and the question stays open', open(kf.row.id) && open(kf.row.id).stored.pk.chars === 9);
    r = answer({ id: kf.row.id, by, answer: { action: 'go', values: { ok: true } } });
    t('form: the final submit carries every part, the key as {stored, chars} only', r.answer.values.ok === true && r.answer.values.pk.stored === 'secrets/ping-key' && r.answer.values.pk.chars === 9, r.answer);
    t('a secret-only question is secretOnly (Store may close it)', secretOnly(open(sec.row.id) ? open(sec.row.id).form : normalizeForm(expandKind('secret', { name: 'x-key' }))));
    // the recovery: an untyped question closed by storing a key comes back once for the rest
    const stuck = ask({ from: 'Founder', q: 'Four patches are ready, all measured on copies.\n\n1. harness-change.js: carry the real diff.\n2. locked-watch.js: baseline symlinks.\n3. default-branch-watch.js: say 0 watched.\n4. dispatch.js: WAITING until a due date.', oneDecision: true });
    require('./lib/pm-inbox-guard').append(FILE(), { type: 'answer', id: stuck.row.id, at: new Date().toISOString(), a: 'The key: stored at secrets/minimax-api-key (125 chars).', answer: { verdict: 'done', action: 'store-key', values: { key: { stored: 'secrets/minimax-api-key', chars: 125, validated: null } } }, by: 'Commander' }, 'selftest');
    const fu = open(stuck.row.id);
    t('recovery: the store-only answer re-opens the rest: 4 approve questions + the key already stored', fu && fu.followUp && /You stored the key; the rest of this request still needs you/.test(fu.followUp.note) && fu.questions.filter(p => p.kind === 'approve').length === 4 && fu.questions.find(p => p.kind === 'secret').answered && fu.progress.answered === 1, fu && fu.questions);
    r = answer({ id: stuck.row.id, by, parts: { 'item-1': { action: 'approve' }, 'item-2': { action: 'approve' }, 'item-3': { action: 'decline' } } });
    t('recovery: a partial answer keeps it open', r.state === 'open' && open(stuck.row.id).progress.requiredLeft === 1);
    r = answer({ id: stuck.row.id, by, parts: { 'item-4': { action: 'approve' } } });
    t('recovery: finished, the record has every item and the key', r.state === 'answered' && r.answer.parts['item-3'].verdict === 'no' && r.answer.parts.key.values.key.stored === 'secrets/minimax-api-key', r.answer);
    t('recovery: never twice', !open(stuck.row.id) && !followUpOf(state()[stuck.row.id]));
    const kOnly = ask({ from: 'Founder', q: 'Gate 2: a free Quotely API key, please.' });
    require('./lib/pm-inbox-guard').append(FILE(), { type: 'answer', id: kOnly.row.id, at: new Date().toISOString(), a: 'stored', answer: { verdict: 'done', action: 'store-key', values: { key: { stored: 'secrets/quotely-api-key', chars: 30 } } }, by: 'Commander' }, 'selftest');
    t('recovery: a key-only question answered by its key stays answered', !open(kOnly.row.id));
    // snooze
    const sz = ask({ from: 'Founder', message: 'Later is fine.' });
    t('snooze in the past refused', /next 30 days/.test(throws(() => snooze({ id: sz.row.id, by, until: '2020-01-01T00:00:00Z' }))));
    const until = new Date(Date.now() + 3600e3).toISOString();
    snooze({ id: sz.row.id, by, until });
    t('a snoozed question stays open and carries snoozedUntil', open(sz.row.id).snoozedUntil === until);
    // walk 2: a URL is not a secret; command asks are refused wherever they sit; Approve says what it does; withdraw
    const urlQ = ask({ from: 'Founder', message: 'The outside heartbeat needs its ping address.', questions: [{ id: 'hb', prompt: 'Paste the ping URL from your new check.', form: { fields: [{ id: 'ping', type: 'secret', label: 'The ping URL from that check', name: 'hc-ping-url' }], actions: [{ id: 'store', label: 'Store the ping URL', verdict: 'done', needs: ['ping'] }, { id: 'no', label: 'Not now', verdict: 'no', needs: 'none' }] } }, { id: 'k', prompt: 'And the API key.', kind: 'secret', spec: { name: 'hc-api-key', label: 'Healthchecks API key' } }] });
    const uq = open(urlQ.row.id); const uf = uq.questions[0].form;
    t('a "secret" field asking for a URL is a plain url field with a Save button; a real key stays secret', uf.fields[0].type === 'url' && uf.actions[0].label === 'Save the ping URL' && uq.questions[1].form.fields[0].type === 'secret', uq.questions);
    t('a url answer must be https', /https:\/\//.test(throws(() => answer({ id: urlQ.row.id, by, parts: { hb: { action: 'store', values: { ping: 'not a url' } } } })) || '') && /https/.test(throws(() => answer({ id: urlQ.row.id, by, parts: { hb: { action: 'store', values: { ping: 'http://hc-ping.com/x' } } } })) || ''));
    r = answer({ id: urlQ.row.id, by, parts: { hb: { action: 'store', values: { ping: 'https://hc-ping.com/abc-123' } } }, quiet: true });
    t('a url answer is recorded as plain text for the asker', r.state === 'open' && /https:\/\/hc-ping\.com\/abc-123/.test(r.a), r);
    const oldRow = { type: 'ask', id: 'q-x', form: { fields: [{ id: 'u', type: 'secret', label: 'Webhook address', name: 'wh' }], actions: [{ id: 'store', label: 'Store it securely', verdict: 'done', needs: ['u'] }] } };
    t('an old row with a URL secret field reads as a url field', formOf(oldRow).fields[0].type === 'url' && formOf(oldRow).actions[0].label === 'Save it');
    for (const [txt, why] of [['It needs a single command on your side that agents are refused: systemctl --user daemon-reload. May I have that one command?', 'systemctl daemon-reload in prose'],
      ['May I have `systemctl --user restart example.service`?', 'a backticked command'], ['Please approve: sudo loginctl enable-linger owner', 'sudo'], ['Could you do npm install in the console folder?', 'npm install'],
      ['One pip install pyyaml would fix it.', 'pip install'], ['Can you git push the branch?', 'git push'], ['Is `node company/tools/x.js selftest` ok to run?', 'backticked node']]) t('composer refuses a command ask: ' + why, /run a command/.test(throws(() => ask({ from: 'Founder', message: txt })) || ''));
    t('composer refuses a command inside one question of a request', /run a command/.test(throws(() => ask({ from: 'Founder', message: 'Three things.', questions: [{ prompt: 'Run daemon-reload for me?' }, { prompt: 'Switch on the module?' }] })) || ''));
    t('evidence in details may quote a command the agents ran', !throws(() => ask({ from: 'Founder', message: 'May I restart the recorder?', details: 'Measured: `systemctl --user status recorder` shows 25 of 46 minutes active; git log shows the fix landed.' })));
    t('details handing a command to the owner are refused', /run a command/.test(throws(() => ask({ from: 'Founder', message: 'One thing only you can do.', details: 'It needs one command on your side: `systemctl --user daemon-reload`.' })) || ''));
    t('plain prose about git or the systemd unit is not a command ask', !throws(() => ask({ from: 'Founder', message: 'The systemd unit keeps hitting its start limit. May I ask the tools seat to change the unit file through a framework request?' })) && !shellAsk('The git history shows two patches.'));
    const dq = ask({ from: 'Founder', message: 'Switch on the commitments module?', kind: 'approve', spec: { does: 'Approve switches the commitments module on (one tool, one 10-minute duty).' } });
    t('an approve can say what Approve does', open(dq.row.id).form.actions[0].does === 'Approve switches the commitments module on (one tool, one 10-minute duty).');
    const wq = ask({ from: 'Founder', message: 'Three things.', questions: [{ id: 'cmd', prompt: 'May the tools seat fix the start limit?' }, { id: 'mod', prompt: 'Switch the module on?' }, { id: 'url', prompt: 'Paste the ping URL.', form: { fields: [{ id: 'u', type: 'url', label: 'Ping URL' }], actions: [{ id: 'save', label: 'Save', verdict: 'done' }] } }] });
    t('only the asker withdraws', /only the asker/.test(throws(() => withdraw({ id: wq.row.id, part: '1', why: 'moot', by: 'Mallory' })) || ''));
    t('withdraw needs a why', /--why/.test(throws(() => withdraw({ id: wq.row.id, part: '1', by: 'Founder' })) || ''));
    r = withdraw({ id: wq.row.id, part: '1', why: 'service.js rerender fixed the start limit at 18:00', by: 'Founder' });
    const wo = open(wq.row.id);
    t('a withdrawn question leaves the request; the rest stay open', r.state === 'open' && wo.questions.map(p => p.id).join() === 'mod,url' && wo.withdrawn[0].part === 'cmd' && /rerender/.test(wo.withdrawn[0].why), wo);
    t('withdrawnSince lists it for Today', withdrawnSince(0).some(w => w.id === wq.row.id && w.part === 'cmd' && w.by === 'Founder'));
    answer({ id: wq.row.id, by, parts: { mod: { action: 'approve' } }, quiet: true });
    r = withdraw({ id: wq.row.id, part: 'url', why: 'built it local-only', by: 'Founder' });
    t('withdrawing the last open question finishes the request with the answers it has', r.state === 'answered' && !open(wq.row.id) && state()[wq.row.id].answer.parts.cmd.withdrawn === true && state()[wq.row.id].answer.parts.mod.verdict === 'yes', state()[wq.row.id].answer);
    const wh = ask({ from: 'Founder', message: 'May I keep the old feed?' });
    withdraw({ id: wh.row.id, why: 'moot', by: 'Founder' });
    { const li = listItems({}).find(x => x.id === wh.row.id) || {}; const still = ask({ from: 'Founder', message: 'May I keep the new feed?' });
      t('list: a whole ask withdrawn reads withdrawn, not open, and --open leaves it out while a live ask stays', li.status === 'withdrawn by Founder' && li.withdrawn && li.withdrawn.why === 'moot' && !listItems({ open: true }).some(x => x.id === wh.row.id) && listItems({ open: true }).some(x => x.id === still.row.id && x.status === 'open') && listItems({ from: 'founder' }).some(x => x.id === wh.row.id), li);
      withdraw({ id: still.row.id, why: 'test tidy', by: 'Founder' }); }
    t('a whole ask withdrawn is no longer open, and cannot be answered', !open(wh.row.id) && /no question|no open question/.test(throws(() => answer({ id: wh.row.id, by, text: 'yes' })) || 'x'));
    // governance approved(): structured verdicts
    const gov = require('./lib/governance');
    const g1 = gov.decide('hiring', { by: 'Sam', summary: 'open a round', ref: 'st:r1' }, { root: T, level: 'approve' });
    const g2 = gov.decide('hiring', { by: 'Sam', summary: 'open round 2', ref: 'st:r2' }, { root: T, level: 'approve' });
    t('governance files gate questions with a plain message', !!g1.questionId && !open(g1.questionId).messageDerived && open(g1.questionId).message.length <= MESSAGE_SOFT, open(g1.questionId));
    let refused = null; try { answer({ id: g1.questionId, by, answer: { action: 'approve' }, quiet: true }); } catch (e) { refused = e.code; }
    t('a gate question is an approval: a plain inbox answer is refused (approvals.js answer is its path)', refused === 5 && !state()[g1.questionId].a);
    // the rows approvals.js answer writes (structured verdicts), which governance reads
    append({ type: 'answer', id: g1.questionId, at: new Date().toISOString(), a: 'yes (via needs-you)', answer: { verdict: 'yes', action: 'approve', values: {} }, by: 'Commander', surface: 'needs-you' });
    append({ type: 'answer', id: g2.questionId, at: new Date().toISOString(), a: 'no (via needs-you)', answer: { verdict: 'no', action: 'decline', values: {} }, by: 'Commander', surface: 'needs-you' });
    t('governance approved(): structured yes is true, no is false', gov.approved('st:r1', { root: T }) === true && gov.approved('st:r2', { root: T }) === false);
    // out() must write the whole reply to a pipe: process.exit straight after console.log cut piped output at 64KB
    const outSrc = (fs.readFileSync(__filename, 'utf8').match(/function out\(code, obj\) \{[\s\S]*?\n\}\n/) || [''])[0];
    const pipeRun = require('child_process').spawnSync('sh', ['-c', '"$0" -e "$CHILD_SRC" | cat', process.execPath], { maxBuffer: 1 << 22, env: Object.assign({}, process.env, { CHILD_SRC: 'const fs = require("fs");' + outSrc + 'out(0, { x: "a".repeat(200000) });' }) });   // a shell pipeline is where the cut showed
    t('out() writes a reply larger than 64KB to a pipe in full', outSrc.length > 0 && pipeRun.stdout.length > 200000, { got: pipeRun.stdout && pipeRun.stdout.length });
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
    let questions = null;
    if (a.questions && a.questions !== true) { try { questions = JSON.parse(a.questions); } catch (e) { out(2, { ok: false, error: '--questions is not JSON: ' + e.message }); } }
    const { row, warnings } = ask({ from: a.from, about: a.about, message: a.message, details: a.details, q: a.q, blocking: a.blocking, kind: a.kind || spec.kind, spec, form, questions, oneDecision: !!a['one-decision'], technical: a.technical && a.technical !== true ? a.technical : undefined, scopeExempt: a.via && viaFramework(a.via) ? 'framework' : undefined, changed: a.changed && a.changed !== true ? a.changed : undefined });
    out(0, Object.assign({ ok: true, id: row.id, kind: row.kind || 'approve', status: 'open', note: 'the owner answers on Today in the console' + (row.questions ? ', one question at a time; each answer' : '; the answer') + ' comes back to you as an owner message naming ' + row.id }, warnings.length ? { warnings } : {}));
  } catch (e) { out(2, Object.assign({ ok: false, error: e.message }, e.code === 'bundled' || e.code === 'plain' ? { suggestion: e.suggestion } : {}, e.route ? { route: e.route } : {}, e.prior ? { prior: e.prior } : {}, e.code ? { code: e.code } : {})); }
}
if (a.cmd === 'list') out(0, { ok: true, open: openQuestions().length, items: listItems(a) });
if (a.cmd === 'reclassify') {
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  const note = String(a.note || '').trim(); if (!note) out(2, { ok: false, error: '--note is required (what the company decided and who owns it)' });
  try { out(0, reclassify({ id, note, by: a.by || a.from })); } catch (e) { out(e.code === 3 ? 3 : e.code === 4 ? 4 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'snooze') {
  { const why = ownerRefusal(a.by, 'inbox.js snooze'); if (why) out(3, { ok: false, error: why }); }
  try { out(0, snooze({ id: a.id, until: a.until, by: a.by })); } catch (e) { out(e.code === 3 ? 3 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'answer') {
  if (!isOwner(a.by)) out(3, { ok: false, error: 'only the Commander (the owner, the PM) can answer or close a question' });
  { const why = ownerRefusal(a.by, 'inbox.js answer'); if (why) out(3, { ok: false, error: why }); }
  if (!String(a.id || '')) out(2, { ok: false, error: '--id is required' });
  if (isApprovalRow(state()[String(a.id)])) out(5, { ok: false, code: 'approval', error: approvalRefusal(String(a.id)).message });
  if (!String(a.a || '').trim() && !a.answer) out(2, { ok: false, error: '--a is required' });
  let structured;
  if (a.answer && a.answer !== true) { try { structured = JSON.parse(a.answer); } catch (e) { out(2, { ok: false, error: '--answer is not JSON' }); } }
  // an id that was never asked still gets its answer row (old behaviour), so a reply to a question asked elsewhere is kept
  if (!state()[String(a.id)]) { append({ type: 'answer', id: String(a.id), at: new Date().toISOString(), a: String(a.a), by: 'Commander' }); out(0, { ok: true, id: String(a.id), state: 'answered' }); }
  try { out(0, answer({ id: a.id, by: a.by, text: a.a, answer: structured, quiet: !!a.quiet })); }
  catch (e) { out(e.code === 3 ? 3 : e.code === 5 ? 5 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'withdraw') {
  // inbox.js withdraw <q-id> [--part <n|id>] --why "fixed by …" --from <you>
  const pos = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;
  try { out(0, withdraw({ id: a.id || pos, part: a.part, why: a.why, by: a.from || a.by })); } catch (e) { out(e.code === 3 ? 3 : 2, { ok: false, error: e.message }); }
}
if (a.cmd === 'close') {
  if (!isOwner(a.by)) out(3, { ok: false, error: 'only the Commander (the owner, the PM) can answer or close a question' });
  { const why = ownerRefusal(a.by, 'inbox.js close'); if (why) out(3, { ok: false, error: why }); }
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  if (isApprovalRow(state()[id])) out(5, { ok: false, code: 'approval', error: approvalRefusal(id).message });
  append({ type: 'close', id, at: new Date().toISOString(), by: 'Commander' });
  out(0, { ok: true, id, state: 'closed' });
}
out(2, { ok: false, error: 'unknown command: ' + a.cmd, commands: ['ask', 'list', 'answer', 'snooze', 'withdraw', 'close', 'reclassify', '--selftest'] });
