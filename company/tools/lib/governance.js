'use strict';
/* governance.js (lib) — how a tool asks "may the company do this alone?" and acts on the answer.
 *
 * The owner sets one level per category in company/state/governance.json (company/tools/governance.js set|preset):
 *   auto     the accountable seat decides; nothing else happens
 *   notify   it decides, and the owner gets one plain sentence in company/owner/outbound.jsonl (owner-inbox.js send)
 *   triage   a decision model (company/decision-models/gate-triage, lib/decision.js) decides: proceed-notify behaves like
 *            notify (the owner sentence names the model, version, rule and decisionId), escalate behaves like approve. A
 *            model in shadow mode always escalates and logs what it would have done. Never used for the fixed owner gates.
 *            Only decide() acts on triage; level() reports it only when asked.
 *            FACT PROVENANCE: triageFacts() builds every safety fact from records, never from the acting seat:
 *              reversible / recurring  the owner's per-category table (gate-triage params reversibleCategories,
 *                                      oneOffCategories, set by decide.js set-param --by <owner>)
 *              amountUsd               the request (o.amountUsd: the amount the tool is about to commit)
 *              vendorKnown             o.vendor on the external-gate allowlist, a registered party, or paid in the ledger
 *              externalRecipientKnown  o.recipient with a live external-gate clearance, on the allowlist, or a party
 *              seatHistoryOk           o.by's competence record (company/work/people/competence.json): present, no
 *                                      serious or waiting flaw
 *            The caller's own `facts` pass only for non-safety fields; a safety claim is logged as a rejected claim. A
 *            triage model with no safety inputs (gate-triage v1) takes facts on the actor's word, so it always escalates.
 *            Before each triage the model's outcomes are joined and a live version over its bad-outcome limit is demoted.
 *   approve  it proposes and waits: an owner question goes into the owner inbox (company/pm-inbox.jsonl, the file
 *            company/tools/inbox.js reads), with a recommendation and what happens if nobody answers. The tool stops now
 *            and goes ahead on a later run, once the owner has answered yes to that question.
 *
 *   const gov = require('./lib/governance');
 *   const d = gov.decide('hiring', { by: 'Sam', summary: 'open a Sales Lead round', recommendation: 'yes: ...',
 *                                    default: 'no round is opened', ref: 'hiring:open:sales-lead-1',
 *                                    amountUsd?, vendor?, recipient?, facts? });   // triage: see FACT PROVENANCE
 *   d -> { level, allowed, questionId?, denied?, noted? }
 *   gov.approved(ref) -> true (the owner said yes) | false (said no) | null (no answer yet, or no question)
 *   gov.level(category)  gov.guard(name)  gov.notify(text)  gov.pendingGates()
 *
 * `ref` names the decision, so a retry of the same act finds the same question instead of filing a second one. One owner
 * yes answers every later call with that ref. Unknown category, unreadable file => approve (fail closed); the four fixed
 * owner gates are approve while the ownerGates guardrail is on (co.gate).
 *
 * DELEGATION: while the owner has granted a delegation (company/tools/delegation.js) for a category, the delegate's answer
 * to that category's approve/triage question (delegation.js answer) counts as the owner's, recorded as "delegate X for
 * owner". Never for the fixed gates or packs; an owner answer always wins over a delegate's.
 *
 * Every function takes opts.root (a scratch company tree, for selftests); without it the live company is used and the
 * level comes from co.gate / co.guard. opts.level / opts.guards override the files (tests only).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const LEVELS = ['auto', 'notify', 'triage', 'approve'];
const TRIAGE_MODEL = 'gate-triage';
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
/* level(category, opts): 'triage' only with opts.triage (decide() and governance.js show); otherwise triage reads as approve. */
function level(category, opts) {
  const tri = !!(opts && opts.triage);
  const g0 = () => doc(opts);
  const fixed = () => { const g = g0(); return !!(g.fixed && g.fixed[category]); };
  if (opts && LEVELS.includes(opts.level)) return opts.level === 'triage' && (!tri || fixed()) ? 'approve' : opts.level;
  if (isLive(opts)) return co.gate(category, { triage: tri });
  const g = g0();
  if (g.fixed && g.fixed[category] && guard('ownerGates', opts)) return 'approve';
  const v = g.categories && g.categories[category];
  if (v === 'triage') return tri && !(g.fixed && g.fixed[category]) ? 'triage' : 'approve';
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
  for (const r of readLines(f.inbox)) if (r.id === id && (r.type === 'answer') && r.a) ans = { text: String(r.a), via: 'inbox', verdict: r.answer && (r.answer.verdict === 'yes' || r.answer.verdict === 'no') ? r.answer.verdict : null };
  if (ans) return ans;
  for (const m of readLines(path.join(f.ownerDir, 'inbound.jsonl'))) {
    const text = String(m.text != null ? m.text : (m.body || ''));
    if (String(m.re || '') === id || text.includes(id)) ans = { text: text.replace(/\[?\(?q-\d+\)?\]?/g, '').trim(), via: 'owner-channel' };
  }
  if (ans) return ans;
  // a delegate's answer, while the owner's delegation for that category was in force (company/tools/delegation.js)
  const q = gateAsks(opts).find(r => r.id === id);
  if (q) { try { const d = require('../delegation.js').answerFor(q, Object.assign({}, opts, { root: rootOf(opts) })); if (d) return d; } catch (_) {} }
  return null;
}
function closedOrReclassified(id, opts) { return readLines(files(opts).inbox).some(r => r.id === id && (r.type === 'close' || r.type === 'reclassify')); }
function questionFor(ref, opts) { const asks = gateAsks(opts).filter(r => r.gate.ref === ref); return asks.length ? asks[asks.length - 1] : null; }
/* true = the owner said yes to the question for `ref`; false = said no; null = no answer yet (or never asked). */
function approved(ref, opts) {
  const q = questionFor(ref, opts); if (!q) return null;
  const a = answerOf(q.id, opts); if (!a) return null;
  if (a.verdict) return a.verdict === 'yes';   // a structured answer (inbox.js answer): Approve/Decline, or a choice of yes/no
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
    o.triage ? 'The triage model escalated this: ' + o.triage + '.' : null,
    'Reply yes or no and name ' + id + '. You set this through self-governance: ' + category + ' is at "' + (o.triage ? 'triage' : 'approve') + '" (company/tools/governance.js).',
  ].filter(Boolean);
  // the plain message the owner reads first (inbox.js messageParts); the lines above stay as the detail
  const summ = String(o.summary || 'an act in ' + category).trim().replace(/\.$/, '');
  const message = ('May ' + (o.by || 'we') + ' go ahead: ' + summ + '? ' + (o.recommendation ? 'The recommendation is ' + String(o.recommendation).trim().replace(/\.$/, '') + '. ' : '') +
    'If you say no or do not answer, ' + String(o.default || 'nothing happens and the company waits for you').trim().replace(/\.$/, '').replace(/^./, c => c.toLowerCase()) + '.').slice(0, 600);
  const row = { type: 'ask', id, at: new Date().toISOString(), from: co.nameOf(co.ceo()) || 'company', about: 'governance:' + category, q: lines.join('\n'), message, details: lines.slice(1).join('\n'), blocking: true,
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

/* ---- triage facts from records (never the actor's word for a safety fact) ---- */
const listHas = (csv, c) => String(csv || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(String(c).toLowerCase());
const hostOf = t => String(t || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]*@/, '').split(/[/?#:]/)[0].toLowerCase();
function allowlisted(target, r) {
  let lines = []; try { lines = fs.readFileSync(path.join(r, 'company', 'state', 'external-allowlist.txt'), 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')); } catch (_) {}
  const h = hostOf(target); if (!h) return false;
  return lines.some(e => (e.startsWith('*.') ? (h === e.slice(2) || h.endsWith(e.slice(1))) : (h === e || h.endsWith('.' + e))));
}
function cleared(target, r, now) {
  const t = String(target || '').trim().toLowerCase(); if (!t) return null;
  const rows = readLines(path.join(r, 'company', 'state', 'external-clearances.jsonl'));
  const closed = new Set(rows.filter(x => x.closedAt && x.id).map(x => x.id));
  const hit = rows.find(x => x && !x.closedAt && !(x.id && closed.has(x.id)) && x.clearedBy && x.until && Date.parse(x.until) > now
    && String(x.target || '').trim().toLowerCase() === t);
  return hit ? (hit.id || hit.at || 'row') : null;
}
function partyKnown(name, r) {
  const id = String(name || '').trim().toLowerCase(); if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return false;
  return fs.existsSync(path.join(r, 'company', 'work', 'parties', id));
}
function ledgerPaid(name, r) {
  const n = String(name || '').trim().toLowerCase(); if (!n) return null;
  const hit = readLines(path.join(r, 'company', 'work', 'ledger', 'ledger.jsonl')).find(x => ['payout', 'receipt', 'invoice'].includes(x.type) && [x.party, x.to].some(v => String(v || '').trim().toLowerCase() === n));
  return hit ? String(hit.hash || hit.seq || hit.at || 'row') : null;
}
function seatRecord(by, r) {
  const b = String(by || '').trim().toLowerCase(); if (!b) return null;
  const comp = co.readJson(path.join(r, 'company', 'work', 'people', 'competence.json'), null);
  if (!comp || !comp.people) return null;
  const id = Object.keys(comp.people).find(k => k.toLowerCase() === b || String((comp.people[k] || {}).name || '').toLowerCase() === b);
  if (!id) return null;
  const flawed = [].concat(comp.serious || [], comp.waiting || []).some(f => f && String(f.agent || '').toLowerCase() === id.toLowerCase());
  return { value: !flawed, ref: 'competence.json ' + id + (comp.computedAt ? ' @' + comp.computedAt : '') };
}
/* triageFacts(category, o, opts) -> { facts (envelopes), from } */
function triageFacts(category, o, opts) {
  const dm = require('./decision'); const r = rootOf(opts); const now = Date.now();
  const L = dm.load(TRIAGE_MODEL, null, { root: r }); const inputs = (L.model && L.model.inputs) || {};
  const P = dm.params(TRIAGE_MODEL, { root: r });
  const facts = {}; const E = (value, source, ref) => ({ value, source, ref });
  const actorFacts = (o && o.facts) || {};
  if ('reversibleCategories' in P) facts.reversible = E(listHas(P.reversibleCategories, category), 'owner-table', 'decision-models params gate-triage.reversibleCategories');
  if ('oneOffCategories' in P) facts.recurring = E(actorFacts.recurring === true || (actorFacts.recurring && actorFacts.recurring.value === true) ? true : !listHas(P.oneOffCategories, category), 'owner-table', 'decision-models params gate-triage.oneOffCategories');
  if (o && typeof o.amountUsd === 'number' && Number.isFinite(o.amountUsd)) facts.amountUsd = E(o.amountUsd, 'request', o.ref || null);
  if (o && o.vendor) {
    const led = ledgerPaid(o.vendor, r);
    facts.vendorKnown = allowlisted(o.vendor, r) ? E(true, 'external-gate-allowlist', hostOf(o.vendor)) : partyKnown(o.vendor, r) ? E(true, 'registry:parties', String(o.vendor)) : led ? E(true, 'ledger', led) : E(false, 'ledger', 'no payout, receipt or invoice for ' + String(o.vendor).slice(0, 80));
  }
  if (o && o.recipient) {
    const c = cleared(o.recipient, r, now);
    facts.externalRecipientKnown = c ? E(true, 'external-gate-clearances', c) : allowlisted(o.recipient, r) ? E(true, 'external-gate-allowlist', hostOf(o.recipient)) : partyKnown(o.recipient, r) ? E(true, 'registry:parties', String(o.recipient)) : E(false, 'external-gate-clearances', 'no live clearance for ' + String(o.recipient).slice(0, 80));
  }
  const sr = seatRecord(o && o.by, r); if (sr) facts.seatHistoryOk = E(sr.value, 'competence', sr.ref);
  // the actor's own facts: kept for non-safety fields; a safety claim goes in as source "actor" (rejected and logged)
  for (const [k, v] of Object.entries(actorFacts)) {
    if (k === 'category' || facts[k] !== undefined) continue;
    const val = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v;
    facts[k] = { value: val, source: 'actor', ref: o && o.by ? String(o.by) : undefined };
  }
  const safety = Object.keys(inputs).filter(k => inputs[k] && inputs[k].safety);
  return { facts, safety };
}

/* triage(category, o, opts): run the gate-triage model on facts built from records. Any failure => escalate (fail closed). */
function triage(category, o, opts) {
  let r; let safety = [];
  try {
    const dm = require('./decision');
    try { dm.health({ root: rootOf(opts), id: TRIAGE_MODEL, apply: true }); } catch (_) {}   // join outcomes; demote a live version over its limit
    const tf = triageFacts(category, o || {}, opts); safety = tf.safety;
    const input = Object.assign({}, tf.facts, { category: { value: category, source: 'governance' }, summary: o && o.summary ? String(o.summary).slice(0, 300) : undefined });
    r = dm.evaluate(TRIAGE_MODEL, input, { root: rootOf(opts), actor: (o && o.by) || undefined, caller: 'governance:' + category + (o && o.ref ? ':' + o.ref : '') });
  } catch (e) { r = { action: null, error: e.message, model: { id: TRIAGE_MODEL } }; }
  const m = r.model || {};
  const tag = m.id + ' v' + (m.version || '?') + (m.sha ? ' (' + m.sha + ')' : '');
  if (r.action != null && !safety.length) return { escalate: true, wouldBe: r.action, rule: r.rule, model: m, mode: r.mode, decisionId: r.decisionId, why: tag + ' marks no fact as safety (it would take the acting seat\'s word), so it waits for you; promote a version with fact provenance (gate-triage v2)' };
  if (r.action == null) return { escalate: true, wouldBe: null, model: m, mode: r.mode, why: 'the decision model could not run (' + (r.error || 'unknown') + '), so it waits for you' };
  const dist = r.distrusted && r.distrusted.length ? '; not taken on the actor\'s word: ' + r.distrusted.join(', ') : '';
  if (r.mode !== 'live') return { escalate: true, wouldBe: r.action, rule: r.rule, model: m, mode: r.mode, decisionId: r.decisionId, distrusted: r.distrusted, why: tag + ' is in shadow mode; it would have said ' + r.action + ' (' + r.reason + dist + ')' };
  return { escalate: r.action !== 'proceed-notify', wouldBe: r.action, rule: r.rule, model: m, mode: r.mode, reason: r.reason, decisionId: r.decisionId, distrusted: r.distrusted, why: tag + ' said ' + r.action + ' (' + r.reason + dist + ')' };
}

/* decide(category, {by, summary, recommendation, default, ref, facts?}, opts) -> {level, allowed, questionId?, denied?, noted?, triage?} */
function decide(category, o, opts) {
  o = o || {};
  let lv = level(category, Object.assign({}, opts, { triage: true }));
  const ref = String(o.ref || (category + ':' + String(o.summary || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)));
  if (lv === 'auto') return { level: lv, allowed: true };
  let tri = null;
  if (lv === 'triage') {
    tri = triage(category, o, opts);
    if (!tri.escalate) {
      const who = o.by || 'The company';
      const m = tri.model;
      const sentence = who + ' decided to ' + String(o.summary || 'act on ' + category).trim().replace(/\.$/, '') + '. (Self-governance: ' + category + ' is set to triage, and decision model ' + m.id + ' v' + m.version + ' let this through: ' + tri.reason + '. Decision ' + (tri.decisionId || '?') + '; reply "undo ' + (tri.decisionId || '') + '" if you want it undone.)';
      let noted = null; try { noted = notify(sentence, opts); } catch (_) {}
      return { level: lv, allowed: true, noted: !!noted, triage: tri };
    }
  }
  if (lv === 'notify') {
    const who = o.by || 'The company';
    const sentence = who + ' decided to ' + String(o.summary || 'act on ' + category).trim().replace(/\.$/, '') + '. (Self-governance: ' + category + ' is set to notify, so this is done without waiting for you; reply if you want it undone.)';
    let noted = null; try { noted = notify(sentence, opts); } catch (_) {}
    return { level: lv, allowed: true, noted: !!noted };
  }
  // approve, or triage that escalated
  const res = approveFlow(category, o, ref, opts, tri);
  res.level = lv; if (tri) res.triage = tri;
  return res;
}
function approveFlow(category, o, ref, opts, tri) {
  const lv = 'approve';
  const q = questionFor(ref, Object.assign({}, opts));
  if (q) {
    const a = answerOf(q.id, opts);
    const v = a ? verdict(a.text) : null;
    if (v === true) return { level: lv, allowed: true, questionId: q.id, approvedBy: a.via === 'delegate' ? 'delegate ' + a.by + ' for owner' : 'owner' };
    if (v === false) return { level: lv, allowed: false, questionId: q.id, denied: true, reason: (a.via === 'delegate' ? 'delegate ' + a.by + ' for the owner' : 'the owner') + ' said no to ' + q.id };
    if (!a && !closedOrReclassified(q.id, opts)) return { level: lv, allowed: false, questionId: q.id, reason: 'waiting for the owner on ' + q.id };
    // answered with neither yes nor no, or closed: ask again
  }
  const row = fileQuestion(category, Object.assign({}, o, { ref, triage: tri ? tri.why : null }), opts);
  return { level: lv, allowed: false, questionId: row.id, reason: 'asked the owner: ' + row.id };
}
/* The refusal text a tool prints when decide() says not now. */
function refusal(category, d) {
  const lv = d.level === 'triage' ? 'triage (escalated)' : 'approve';
  if (d.denied) return 'self-governance: the owner said no (' + d.questionId + '); ' + category + ' is at ' + lv + ', so this is not done';
  return 'self-governance: ' + category + ' is at ' + lv + ', so this waits for the owner. Question ' + d.questionId + ' is in the owner inbox (company/pm-inbox.jsonl); run the same command again after the owner answers yes';
}

module.exports = { LEVELS, TRIAGE_MODEL, triage, triageFacts, gateAsks, readLines, level, guard, decide, approved, pendingGates, notify, refusal, isOwnerName, files, doc, questionFor, answerOf, verdict };
