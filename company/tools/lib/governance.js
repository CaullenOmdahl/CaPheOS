'use strict';
/* governance.js (lib) — how a tool asks "may the company do this alone?" and acts on the answer.
 *
 * The owner sets one level per category in company/state/governance.json (company/tools/governance.js set|preset):
 *   auto     the accountable seat decides; nothing else happens
 *   notify   it decides, and the owner gets one plain sentence in company/owner/outbound.jsonl (owner-inbox.js send)
 *   approve  it proposes and waits: an owner question goes into the owner inbox (company/pm-inbox.jsonl, the file
 *            company/tools/inbox.js reads), with a recommendation and what happens if nobody answers. The tool stops now
 *            and goes ahead on a later run, once the owner has answered yes to that question.
 *
 *   const gov = require('./lib/governance');
 *   const d = gov.decide('hiring', { by: 'Sam', summary: 'open a Sales Lead round', recommendation: 'yes: ...',
 *                                    default: 'no round is opened', ref: 'hiring:open:sales-lead-1' });
 *   d -> { level, allowed, questionId?, denied?, noted? }
 *   gov.approved(ref) -> true (the owner said yes) | false (said no) | null (no answer yet, or no question)
 *   gov.level(category)  gov.guard(name)  gov.notify(text)  gov.pendingGates()
 *
 * `ref` names the decision, so a retry of the same act finds the same question instead of filing a second one. One owner
 * yes answers every later call with that ref. Unknown category, unreadable file => approve (fail closed); the four fixed
 * owner gates are approve while the ownerGates guardrail is on (co.gate).
 *
 * Every function takes opts.root (a scratch company tree, for selftests); without it the live company is used and the
 * level comes from co.gate / co.guard. opts.level / opts.guards override the files (tests only).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const LEVELS = ['auto', 'notify', 'approve'];
const rootOf = opts => path.resolve((opts && opts.root) || process.env.GOVERNANCE_ROOT || co.ROOT);
const isLive = opts => rootOf(opts) === path.resolve(co.ROOT);
const files = opts => {
  const r = rootOf(opts);
  return { root: r, gov: path.join(r, 'company', 'state', 'governance.json'), govDefault: path.join(r, 'company', 'defaults', 'state', 'governance.json'),
    guards: path.join(r, 'company', 'state', 'guardrails.json'), guardsDefault: path.join(r, 'company', 'defaults', 'state', 'guardrails.json'),
    inbox: path.join(r, 'company', 'pm-inbox.jsonl'), ownerDir: path.join(r, 'company', 'owner'),
    log: path.join(r, 'company', 'state', 'governance-log.jsonl'), decisions: path.join(r, 'company', 'work', 'decisions.md') };
};
const FRAMEWORK_GOV = co.p('company', 'defaults', 'state', 'governance.json');
const FRAMEWORK_GUARDS = co.p('company', 'defaults', 'state', 'guardrails.json');

function doc(opts) {
  const f = files(opts);
  return co.readJson(f.gov, null) || co.readJson(f.govDefault, null) || co.readJson(FRAMEWORK_GOV, {}) || {};
}
function guard(name, opts) {
  if (name === 'halt') return true;
  if (opts && opts.guards && Object.prototype.hasOwnProperty.call(opts.guards, name)) return opts.guards[name] !== false;
  if (isLive(opts)) return co.guard(name);
  const f = files(opts);
  const g = (co.readJson(f.guards, null) || co.readJson(f.guardsDefault, null) || co.readJson(FRAMEWORK_GUARDS, {}) || {}).guards || {};
  return g[name] !== false;
}
function level(category, opts) {
  if (opts && LEVELS.includes(opts.level)) return opts.level;
  if (isLive(opts)) return co.gate(category);
  const g = doc(opts);
  if (g.fixed && g.fixed[category] && guard('ownerGates', opts)) return 'approve';
  const v = g.categories && g.categories[category];
  return LEVELS.includes(v) ? v : 'approve';
}
const isOwnerName = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === String((co.config.owner && co.config.owner.name) || '').trim().toLowerCase()); };

/* ---- owner inbox rows (the same JSONL company/tools/inbox.js reads and answers) ---- */
function readLines(file) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r) out.push(r); } catch (_) {} }
  return out;
}
function gateAsks(opts) { return readLines(files(opts).inbox).filter(r => r.type === 'ask' && r.gate && r.gate.ref); }
const YES = /^\s*(yes|y|yep|yeah|ok|okay|approved?|go( ahead)?|agreed?|sure|do it|fine)\b/i;
const NO = /^\s*(no|n|nope|not now|reject(ed)?|den(y|ied)|declined?|don'?t|do not|stop|hold)\b/i;
const verdict = text => (NO.test(String(text || '')) ? false : YES.test(String(text || '')) ? true : null);
// the owner's answer to one question id: an inbox.js answer row, else an owner message that names the id
function answerOf(id, opts) {
  const f = files(opts);
  let ans = null;
  for (const r of readLines(f.inbox)) if (r.id === id && (r.type === 'answer') && r.a) ans = { text: String(r.a), via: 'inbox' };
  if (ans) return ans;
  for (const m of readLines(path.join(f.ownerDir, 'inbound.jsonl'))) {
    const text = String(m.text != null ? m.text : (m.body || ''));
    if (String(m.re || '') === id || text.includes(id)) ans = { text: text.replace(/\[?\(?q-\d+\)?\]?/g, '').trim(), via: 'owner-channel' };
  }
  return ans;
}
function closedOrReclassified(id, opts) { return readLines(files(opts).inbox).some(r => r.id === id && (r.type === 'close' || r.type === 'reclassify')); }
function questionFor(ref, opts) { const asks = gateAsks(opts).filter(r => r.gate.ref === ref); return asks.length ? asks[asks.length - 1] : null; }
/* true = the owner said yes to the question for `ref`; false = said no; null = no answer yet (or never asked). */
function approved(ref, opts) {
  const q = questionFor(ref, opts); if (!q) return null;
  const a = answerOf(q.id, opts); if (!a) return null;
  return verdict(a.text);
}
/* Open gate questions (no answer, not closed): for a dispatcher that folds them into one owner message. */
function pendingGates(opts) {
  return gateAsks(opts).filter(q => !answerOf(q.id, opts) && !closedOrReclassified(q.id, opts))
    .map(q => ({ id: q.id, askedAt: q.at, category: q.gate.category, ref: q.gate.ref, by: q.gate.by, summary: q.gate.summary, q: q.q }));
}
function newId(opts) {
  const used = new Set(readLines(files(opts).inbox).map(r => r.id));
  let n = Number(String(Date.now()).slice(-6));
  let id = 'q-' + String(n).padStart(6, '0');
  while (used.has(id)) { n = (n + 1) % 1e6; id = 'q-' + String(n).padStart(6, '0'); }
  return id;
}
function fileQuestion(category, o, opts) {
  const f = files(opts);
  const id = newId(opts);
  const lines = [
    'Approval needed (' + category + '): ' + String(o.summary || 'an act in ' + category).trim().replace(/\.$/, '') + '.',
    o.recommendation ? 'Recommendation from ' + (o.by || 'the company') + ': ' + String(o.recommendation).trim() : null,
    'If you do not answer: ' + String(o.default || 'nothing happens; the company waits for you').trim(),
    'Reply yes or no and name ' + id + '. You set this through self-governance: ' + category + ' is at "approve" (company/tools/governance.js).',
  ].filter(Boolean);
  const row = { type: 'ask', id, at: new Date().toISOString(), from: co.nameOf(co.ceo()) || 'company', about: 'governance:' + category, q: lines.join('\n'), blocking: true,
    batch: 'gate', gate: { category, ref: o.ref, by: o.by || null, summary: o.summary || null, recommendation: o.recommendation || null, default: o.default || null } };
  fs.mkdirSync(path.dirname(f.inbox), { recursive: true });
  fs.appendFileSync(f.inbox, JSON.stringify(row) + '\n');
  return row;
}

/* One plain sentence to the owner (company/owner/outbound.jsonl through owner-inbox.js send). The same sentence is sent once. */
function notify(text, opts) {
  const f = files(opts); const body = String(text || '').trim(); if (!body) return null;
  if (readLines(path.join(f.ownerDir, 'outbound.jsonl')).some(r => String(r.text || '') === body)) return { duplicate: true };
  const prev = process.env.OWNER_DIR;
  if (!isLive(opts)) process.env.OWNER_DIR = f.ownerDir;
  try { return require('../owner-inbox.js').send({ from: (opts && opts.from) || co.nameOf(co.ceo()) || 'company', text: body }); }
  finally { if (!isLive(opts)) { if (prev === undefined) delete process.env.OWNER_DIR; else process.env.OWNER_DIR = prev; } }
}

/* decide(category, {by, summary, recommendation, default, ref}, opts) -> {level, allowed, questionId?, denied?, noted?} */
function decide(category, o, opts) {
  o = o || {};
  const lv = level(category, opts);
  const ref = String(o.ref || (category + ':' + String(o.summary || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)));
  if (lv === 'auto') return { level: lv, allowed: true };
  if (lv === 'notify') {
    const who = o.by || 'The company';
    const sentence = who + ' decided to ' + String(o.summary || 'act on ' + category).trim().replace(/\.$/, '') + '. (Self-governance: ' + category + ' is set to notify, so this is done without waiting for you; reply if you want it undone.)';
    let noted = null; try { noted = notify(sentence, opts); } catch (_) {}
    return { level: lv, allowed: true, noted: !!noted };
  }
  // approve
  const q = questionFor(ref, Object.assign({}, opts));
  if (q) {
    const a = answerOf(q.id, opts);
    const v = a ? verdict(a.text) : null;
    if (v === true) return { level: lv, allowed: true, questionId: q.id, approvedBy: 'owner' };
    if (v === false) return { level: lv, allowed: false, questionId: q.id, denied: true, reason: 'the owner said no to ' + q.id };
    if (!a && !closedOrReclassified(q.id, opts)) return { level: lv, allowed: false, questionId: q.id, reason: 'waiting for the owner on ' + q.id };
    // answered with neither yes nor no, or closed: ask again
  }
  const row = fileQuestion(category, Object.assign({}, o, { ref }), opts);
  return { level: lv, allowed: false, questionId: row.id, reason: 'asked the owner: ' + row.id };
}
/* The refusal text a tool prints when decide() says not now. */
function refusal(category, d) {
  if (d.denied) return 'self-governance: the owner said no (' + d.questionId + '); ' + category + ' is at approve, so this is not done';
  return 'self-governance: ' + category + ' is at approve, so this waits for the owner. Question ' + d.questionId + ' is in the owner inbox (company/pm-inbox.jsonl); run the same command again after the owner answers yes';
}

module.exports = { LEVELS, level, guard, decide, approved, pendingGates, notify, refusal, isOwnerName, files, doc, questionFor, answerOf, verdict };
