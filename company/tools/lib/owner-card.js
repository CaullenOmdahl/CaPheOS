'use strict';
/* lib/owner-card.js — the one way a tool puts a decision in front of the owner (a card on Today › Needs you).
 *
 * The owner is a busy non-technical person. A card reaches them only when it is (1) one of the four fixed owner gates
 * (access, ownership, commitment, spend beyond the cap: governance.json `fixed`) or a category self-governance has at
 * `approve` (triage reads as approve here: a caller files after the triage model escalated), (2) not already covered
 * by a lower governance level, a standing owner ruling (lib/owner-rulings.js) or a recent "not now", and (3) written
 * in plain words. Technical detail goes in `technical`, shown collapsed as "Technical details (for the crew)".
 *
 *   const card = require('./lib/owner-card');
 *   card.file({ asker, category, fixedGate?, ref, lead, consequence, recommendation?, technical?, options?, effect?,
 *               expiresAt?, by?, about?, fyi?, changed?, blocking? }, opts)
 *     -> { filed: true, id, updated? } | { filed: false, reason, route: 'crew'|'digest'|'duplicate'|'ruling'|'declined', id?, ruling?, backoff? }
 *        route  crew / digest: governance lets the crew decide; ruling: a standing owner ruling covers it (ruling.effect
 *               'crew-decides' = the crew decides, 'never-ask' = the owner's "no" stands); declined: the owner answered
 *               this "not now" within the backoff window (their "no" stands); duplicate: a card is already waiting.
 *        A caller treats ONLY coveredByCrew(result) as "the crew may go ahead" and refusedByOwner(result) as a "no".
 *        guardrail  true when a guardrail (not governance) requires the owner's yes (service.js outside the safe profile,
 *               harness-change.js with nobody on the crew to review a protected tool): like a fixed gate, no ruling,
 *               level or backoff hands it to the crew.
 *        asker      the seat id or name asking (shown as "from")
 *        category   the governance category; fixedGate one of access|ownership|commitment(s)|spendBeyondCap
 *        ref        a stable key (e.g. 'harness-review:hc-0008'): an open card with the same ref is updated, never doubled
 *        lead       ONE plain sentence: what is asked and why it matters to the owner
 *        consequence  plain: what happens on yes and on no
 *        recommendation  plain: the crew's advice and the default
 *        technical  the detail for the crew (paths, ids, diffs, model ids): never in the plain parts
 *        options    form actions (default Approve / Decline); effect: what the console applies on yes (below)
 *        fyi        plain sentence for the digest when the level is notify (default: built from the lead)
 *        changed    what is materially different since the owner said "not now" (lifts the 7-day backoff)
 *   card.withdraw({ ref, by, why }, opts) -> { withdrawn: [id] }   the asker's (or the owner's) withdraw of the open card
 *   card.openCard(ref, opts) -> the open card row with that ref, or null
 *   card.describeEffect(effect) -> what pressing yes does, in plain words
 *
 * A lead, consequence, recommendation or fyi that carries a path, file or tool name, id, hash, command, flag, model id,
 * clock spec, setting name or diff is refused: file() throws an Error with code 'NOT_PLAIN' and `words` (the offending
 * parts), so the caller fixes its template. Nothing here calls a model.
 *
 * EFFECTS (applied ONLY by the console's owner answer handler, an owner path; this module only checks their shape):
 *   {serviceApprove:{name}}  filed only by service.js      {harnessApply:{id}}  filed only by harness-change.js
 *   {none:true}
 * Each effect has exactly one producing tool (EFFECT_PRODUCERS); lib/pm-inbox-guard.js drops the effect of a card whose
 * recorded writer is any other program, so a card an agent's own script files can never carry owner authority. Effect
 * kinds with no producer (governance, clearance, projectApprove, moduleEnable, lockedAccept, budgetToday) are refused.
 * An open card's effect never changes: an update with a different effect is refused (withdraw it and file a new one).
 *
 * ROWS: a pm-inbox ask written through lib/pm-inbox-guard.js append (recorded first, so readers trust it) with
 * gate:{ref, category, fixedGate, by, summary, recommendation, default}, effect, technical, consequence, recommendation.
 * `gate` makes it an approval record: answered only on Today › Needs you or approvals.js, never by inbox.js answer.
 * opts: {root} a scratch company (tests), {level} a governance level override (tests), {notice} a function standing in
 * for the digest writer (tests), {rows} the inbox rows already read.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const GOV = () => require('./governance');
const GUARD = () => require('./pm-inbox-guard');
const SCOPE = () => require('./owner-scope');
const RULINGS = () => require('./owner-rulings');

const FIXED_ALIASES = { commitments: 'commitment', commitment: 'commitment', access: 'access', ownership: 'ownership', spendBeyondCap: 'spendBeyondCap' };
const MAX_CHARS = 300, MAX_SENTENCES = 2;

function rootOf(opts) { return path.resolve((opts && opts.root) || process.env.GOVERNANCE_ROOT || co.ROOT); }
function inboxFile(opts) {
  if (opts && opts.file) return opts.file;
  if (opts && opts.root) return path.join(rootOf(opts), 'company', 'pm-inbox.jsonl');
  return process.env.PM_INBOX_FILE || path.join(rootOf(opts), 'company', 'pm-inbox.jsonl');
}
function crewOf(opts) { try { return co.readJson(path.join(rootOf(opts), 'company', 'tools', 'loops.json'), {}).agents || {}; } catch (_) { return {}; } }
function nameOf(asker, opts) {
  const a = String(asker || '').trim(); if (!a) return 'the crew';
  const crew = crewOf(opts); if (crew[a] && crew[a].name) return crew[a].name;
  return a;
}
const low = s => String(s == null ? '' : s).trim().toLowerCase();
const sentencesOf = t => String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z("'])/).filter(Boolean);

/* ---- plain words ---- */
function plainProblems(text) {
  const t = String(text || '').trim(); const out = [];
  for (const w of SCOPE().wordsProblems(t)) out.push(w);
  if (sentencesOf(t).length > MAX_SENTENCES) out.push(sentencesOf(t).length + ' sentences (at most ' + MAX_SENTENCES + ')');
  if (t.length > MAX_CHARS) out.push(t.length + ' characters (at most ' + MAX_CHARS + ')');
  return out;
}
/* plain(text) -> true when text has nothing a non-technical owner would trip on */
const plain = text => !String(text || '').trim() || plainProblems(text).length === 0;
function assertPlain(parts) {
  const bad = [];
  for (const [k, v] of Object.entries(parts)) { if (v === undefined || v === null || v === '') continue; for (const w of plainProblems(v)) bad.push(k + ': ' + w); }
  if (!bad.length) return;
  const e = new Error('owner card not plain: ' + bad.join('; ') + '. Say it in everyday words; put paths, ids, commands, model ids and settings in `technical`.');
  e.code = 'NOT_PLAIN'; e.words = bad; throw e;
}

/* ---- effects ---- */
const EFFECT_SHAPES = {
  serviceApprove: e => e && typeof e.name === 'string' && /^[a-z][a-z0-9-]{1,30}$/.test(e.name),
  harnessApply: e => e && typeof e.id === 'string' && /^hc-\d{1,6}$/.test(e.id),
  none: e => e === true,
};
// the one program that may file each effect (a path relative to the company root; lib/pm-inbox-guard.js checks the
// provenance row of the card against it). harness-change.js also runs inside the dispatcher's tick.
const EFFECT_PRODUCERS = {
  serviceApprove: ['company/tools/service.js'],
  harnessApply: ['company/tools/harness-change.js', 'company/tools/dispatch.js'],
  none: null,   // anyone
};
const NO_PRODUCER = ['governance', 'clearance', 'projectApprove', 'moduleEnable', 'lockedAccept', 'budgetToday'];
function normEffect(effect, opts) {
  if (effect === undefined || effect === null) return { none: true };
  if (typeof effect !== 'object' || Array.isArray(effect)) throw Object.assign(new Error('effect must be an object like {none:true}'), { code: 'BAD_EFFECT' });
  const keys = Object.keys(effect);
  if (keys.length === 1 && NO_PRODUCER.includes(keys[0])) throw Object.assign(new Error('effect ' + keys[0] + ' has no tool that files it, so no card may carry it: ask with {none:true} and let the owner\'s own tool make the change'), { code: 'BAD_EFFECT' });
  if (keys.length !== 1 || !EFFECT_SHAPES[keys[0]]) throw Object.assign(new Error('unknown effect ' + JSON.stringify(effect) + ': one of ' + Object.keys(EFFECT_SHAPES).join(', ')), { code: 'BAD_EFFECT' });
  const k = keys[0];
  if (!EFFECT_SHAPES[k](effect[k])) throw Object.assign(new Error('effect ' + k + ' is missing a field: ' + JSON.stringify(effect[k])), { code: 'BAD_EFFECT' });
  return JSON.parse(JSON.stringify(effect));
}
function describeEffect(effect) {
  const e = effect || {}; const k = Object.keys(e)[0]; const v = e[k] || {};
  switch (k) {
    case 'serviceApprove': return 'Yes sets up the background job called “' + v.name + '”, exactly as described.';
    case 'harnessApply': return 'Yes makes the crew\'s change number ' + String(v.id).replace(/^hc-0*/, '') + ', exactly as described.';
    case 'none': return 'Yes tells the crew to go ahead.';
    default: return 'Your answer is recorded; nothing is changed automatically.';
  }
}

/* what a caller may do with a not-filed result: ONLY crew, digest, or a crew-decides ruling lets the crew go ahead */
const coveredByCrew = r => !!r && !r.filed && (r.route === 'crew' || r.route === 'digest' || (r.route === 'ruling' && !!r.ruling && r.ruling.effect === 'crew-decides'));
// the owner's "no" stands: a recent "not now" (declined) or a never-ask ruling. Never a go-ahead.
const refusedByOwner = r => !!r && !r.filed && (r.route === 'declined' || (r.route === 'ruling' && !(r.ruling && r.ruling.effect === 'crew-decides')));

/* ---- governance ---- */
function govDoc(opts) { try { return GOV().doc(opts && opts.root ? { root: opts.root } : {}) || {}; } catch (_) { return {}; } }
function isFixed(category, opts) { const f = (govDoc(opts).fixed || {}); return !!category && (!!f[category] || !!f[FIXED_ALIASES[category]]); }
function levelOf(category, opts) {
  try { return GOV().level(category, Object.assign({}, opts && opts.root ? { root: opts.root } : {}, opts && opts.level ? { level: opts.level } : {}, opts && opts.guards ? { guards: opts.guards } : {})); } catch (_) { return 'approve'; }
}

/* ---- the inbox ---- */
function rowsOf(opts) {
  if (opts && Array.isArray(opts.rows)) return opts.rows;
  try { return GUARD().rows({ file: inboxFile(opts), noAlert: true }); } catch (_) { return []; }
}
function closedIds(rows) {
  const s = new Set();
  for (const r of rows) if (r && (r.type === 'answer' || r.type === 'close' || r.type === 'reclassify' || (r.type === 'withdraw' && !r.part))) s.add(r.id);
  return s;
}
/* openCard(ref) -> the newest open ask row carrying gate.ref === ref, or null */
function openCard(ref, opts) {
  const rows = rowsOf(opts); const closed = closedIds(rows);
  let hit = null;
  for (const r of rows) if (r && r.type === 'ask' && r.gate && String(r.gate.ref) === String(ref) && !closed.has(r.id)) hit = r;
  return hit;
}
function newId(file) {
  let used = new Set();
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.id) used.add(r.id); } catch (_) {} } } catch (_) {}
  let n = Number(String(Date.now()).slice(-6)); let id = 'q-' + String(n).padStart(6, '0');
  while (used.has(id)) { n = (n + 1) % 1e6; id = 'q-' + String(n).padStart(6, '0'); }
  return id;
}

/* the digest (lib/governance.js fyi: lib/owner-notice.js when present) */
function digest(o, opts) {
  if (opts && typeof opts.notice === 'function') return opts.notice({ kind: 'fyi', from: o.from, text: o.text, technical: o.technical, key: o.key });
  return GOV().fyi({ from: o.from, text: o.text, technical: o.technical, key: o.key }, opts && opts.root ? { root: opts.root } : {});
}

/* file(o, opts) -> see the header */
function file(o, opts) {
  o = o || {}; opts = opts || {};
  const ref = String(o.ref || '').trim();
  if (!ref) throw Object.assign(new Error('an owner card needs a ref (a stable key, e.g. "harness-review:hc-0008")'), { code: 'USAGE' });
  const fixedGate = o.fixedGate ? FIXED_ALIASES[String(o.fixedGate)] : null;
  if (o.fixedGate && !fixedGate) throw Object.assign(new Error('fixedGate is one of access, ownership, commitments, spendBeyondCap'), { code: 'USAGE' });
  const category = String(o.category || fixedGate || '').trim();
  if (!category) throw Object.assign(new Error('an owner card needs a governance category (or a fixedGate)'), { code: 'USAGE' });
  const lead = String(o.lead || '').replace(/\s+/g, ' ').trim();
  const consequence = String(o.consequence || '').replace(/\s+/g, ' ').trim();
  const recommendation = String(o.recommendation || '').replace(/\s+/g, ' ').trim();
  if (!lead) throw Object.assign(new Error('an owner card needs a lead: one plain sentence saying what is asked and why it matters'), { code: 'USAGE' });
  if (!consequence) throw Object.assign(new Error('an owner card needs a consequence: what happens on yes and on no, in plain words'), { code: 'USAGE' });
  assertPlain({ lead, consequence, recommendation, fyi: o.fyi });
  const effect = normEffect(o.effect, opts);
  const from = nameOf(o.asker, opts);
  const fixed = !!fixedGate || isFixed(category, opts);
  const guardrail = o.guardrail === true;   // a guardrail requires the owner: treated like a fixed gate below
  const technical = o.technical ? String(o.technical).slice(0, 20000) : '';

  // 1. a standing owner ruling (never for a fixed gate)
  const ruling = fixed || guardrail ? null : RULINGS().match({ category, ref, about: o.about, text: lead }, opts);
  if (ruling && (ruling.effect === 'crew-decides' || ruling.effect === 'never-ask'))
    return { filed: false, route: 'ruling', ruling: { id: ruling.id, text: ruling.text, effect: ruling.effect },
      reason: 'the owner\'s standing rule "' + ruling.text + '" covers this: ' + (ruling.effect === 'crew-decides' ? 'the crew decides' : 'the owner is not asked and the default (no) stands') };
  // 2. the real governance level
  const level = fixed || guardrail ? 'approve' : levelOf(category, opts);
  const forced = guardrail || !!(ruling && ruling.effect === 'ask');
  if (!fixed && !forced && level === 'auto') return { filed: false, route: 'crew', level, reason: 'self-governance has ' + category + ' at auto: the crew decides, nobody asks the owner' };
  if (!fixed && !forced && level === 'notify') {
    const text = o.fyi ? String(o.fyi).trim() : from + ' decided this, as your settings allow: ' + lead.replace(/\?$/, '.');
    let noted = null; try { noted = digest({ from, text, technical: technical || undefined, key: ref }, opts); } catch (_) {}
    return { filed: false, route: 'digest', level, noted: !!noted, reason: 'self-governance has ' + category + ' at notify: the crew decides and the owner reads it in the daily digest' };
  }
  // 3. an open card with the same ref: updated, never doubled
  const rows = rowsOf(opts);
  const cur = openCard(ref, Object.assign({}, opts, { rows }));
  const f = inboxFile(opts);
  const q = [lead, consequence, recommendation].filter(Boolean).join(' ') + (technical ? '\n\nTechnical details (for the crew):\n' + technical : '');
  if (cur) {
    const same = cur.message === lead && (cur.consequence || '') === consequence && (cur.recommendation || '') === recommendation && (cur.technical || '') === technical && JSON.stringify(cur.effect || null) === JSON.stringify(effect);
    if (same || low(cur.from) !== low(from)) return { filed: false, route: 'duplicate', id: cur.id, reason: 'an open card with this ref is already waiting (' + cur.id + ')' };
    // what yes does never changes under the owner's eyes: a different effect is a new card (withdraw this one first)
    if (JSON.stringify(cur.effect || { none: true }) !== JSON.stringify(effect)) return { filed: false, route: 'duplicate', id: cur.id, reason: 'an open card with this ref is waiting (' + cur.id + ') and what its yes does cannot change: withdraw it and file a new card' };
  }
  // 4. the owner said "not now" to this within the backoff window
  if (!cur && String(o.changed || '').trim().length < 15) {
    const prior = SCOPE().backoff({ about: o.about || 'card:' + ref, ref, message: lead }, rows, opts.now || Date.now());
    // the owner's "no" stands (a fixed gate too): never a go-ahead for the crew (refusedByOwner)
    if (prior) return { filed: false, route: 'declined', backoff: prior, reason: 'the owner answered this "not now" on ' + String(prior.at).slice(0, 10) + '; their no stands; ask again only when something material changed (changed: "...")' };
  }
  // 5. write the card
  const at = new Date().toISOString();
  const row = { type: 'ask', id: cur ? cur.id : newId(f), at: cur ? cur.at : at, from, about: String(o.about || 'card:' + ref).slice(0, 200), q,
    message: lead, details: [consequence, recommendation].filter(Boolean).join('\n'), consequence, recommendation: recommendation || null,
    blocking: o.blocking !== false, batch: 'gate', card: 1,
    gate: { ref, category: fixedGate || category, fixedGate: fixedGate || (fixed ? category : null), governanceCategory: category, guardrail: guardrail || undefined, by: o.by ? String(o.by) : from, summary: o.summary ? String(o.summary).slice(0, 300) : lead,
      recommendation: recommendation || null, default: consequence },
    effect };
  if (technical) row.technical = technical;
  if (cur) row.updatedAt = at;
  if (o.changed && String(o.changed).trim()) row.changed = String(o.changed).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (o.expiresAt) { const t = Date.parse(o.expiresAt); if (Number.isFinite(t)) { row.expiresAt = new Date(t).toISOString(); row.gate.expiresAt = row.expiresAt; } }
  if (Array.isArray(o.options) && o.options.length) {
    row.kind = 'form';
    row.form = require('../inbox.js').normalizeForm({ fields: Array.isArray(o.fields) ? o.fields : [], actions: o.options });
  }
  GUARD().append(f, row, 'owner-card', opts.root ? { root: rootOf(opts) } : {});
  return cur ? { filed: true, id: row.id, updated: true } : { filed: true, id: row.id };
}

/* withdraw({ref, by, why}) -> {withdrawn: [id]}: the asker's own withdraw (or the owner's, outside an agent's run) */
function withdraw(o, opts) {
  o = o || {}; opts = opts || {};
  const ref = String(o.ref || '').trim(); if (!ref) throw Object.assign(new Error('withdraw needs the card\'s ref'), { code: 'USAGE' });
  const why = String(o.why || '').replace(/\s+/g, ' ').trim() || 'no longer needed';
  const rows = rowsOf(opts); const closed = closedIds(rows);
  const open = rows.filter(r => r && r.type === 'ask' && r.gate && String(r.gate.ref) === ref && !closed.has(r.id));
  const seen = new Set(); const out = [];
  const f = inboxFile(opts);
  let under = false; try { under = require('../provenance.js').underStation(); } catch (_) { under = true; }
  for (const q of open) {
    if (seen.has(q.id)) continue; seen.add(q.id);
    const by = String(o.by || q.from).trim();
    const byOwner = require('./owner').isOwnerName(by, { aliases: ['commander'] });
    let seat = null;
    if (under) {
      if (byOwner) throw Object.assign(new Error('an agent\'s run is not the owner: withdraw ' + q.id + ' as its asker'), { code: 3 });
      seat = GUARD().seatOfName(crewOf(opts), q.from);
      const env = String(process.env.STARNET_AGENT_ID || '').trim();
      if (!seat || (env && env !== seat)) throw Object.assign(new Error('only ' + q.from + '\'s own run withdraws ' + q.id), { code: 3 });
    }
    const row = { type: 'withdraw', id: q.id, at: new Date().toISOString(), by: byOwner ? by : q.from, why: why.slice(0, 300) };
    GUARD().append(f, row, 'owner-card', Object.assign(opts.root ? { root: rootOf(opts) } : {}, seat ? { seat } : {}));
    out.push(q.id);
  }
  return { withdrawn: out };
}

module.exports = { file, withdraw, openCard, describeEffect, plain, plainProblems, coveredByCrew, refusedByOwner, EFFECT_KINDS: Object.keys(EFFECT_SHAPES), EFFECT_PRODUCERS, NO_PRODUCER };
