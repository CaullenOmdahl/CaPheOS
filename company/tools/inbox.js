#!/usr/bin/env node
/* inbox.js — the owner (PM) inbox. Every question the company cannot answer within its authority goes here.
 *
 * The owner (the station Commander) is the PM. Agents ask; the owner answers; nothing guesses in the gap. The CEO
 * batches open questions and the dispatcher delivers the CEO's to company/owner/outbound.jsonl; an owner reply that
 * names the question id comes back through company/owner/inbound.jsonl (owner-inbox.js).
 *
 *   node company/tools/inbox.js ask --from <name> --about <project> --q "May we rotate the payment API key?" [--blocking]
 *   node company/tools/inbox.js list [--open]
 *   node company/tools/inbox.js answer --id q-0003 --a "Yes, rotate it in the provider console; do not print it." --by Commander
 *   node company/tools/inbox.js close --id q-0003
 *
 * Only `answer`/`close` require --by Commander (or --by owner, or the owner's name from company/company.json).
 * An agent may ask, never resolve its own question.
 *
 * Also a module: `require('./inbox.js').openQuestions()` is the single source of truth for
 * "what is an open PM question" — other tools require it instead of re-implementing it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const FILE = co.p('company', 'pm-inbox.jsonl');
const isOwner = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'commander' || b === 'owner' || b === String(co.config.owner.name || '').trim().toLowerCase()); };

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
  try { return fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; }
}
function append(row) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, JSON.stringify(row) + '\n'); }
function state() {
  const rows = readAll(); const by = {}; for (const r of rows) { if (r.type === 'ask') by[r.id] = r; if (r.type === 'answer' || r.type === 'close') Object.assign(by[r.id] = by[r.id] || {}, r); if (r.type === 'reclassify') Object.assign(by[r.id] = by[r.id] || {}, { reclassified: r.note, by: r.by }); } return by;
}
/* openQuestions() — the single definition of "an open PM question":
 * an ask that has no answer and has not been reclassified to company ownership. */
function openQuestions() {
  return Object.values(state())
    .filter(x => x.type === 'ask' && !x.a && !x.reclassified)
    .map(x => ({ id: x.id, from: x.from, about: x.about, q: x.q, blocking: x.blocking, askedAt: x.at, batch: x.batch || null }));
}
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }

module.exports = { openQuestions, state, readAll };

if (require.main !== module) return; // required as a module: export only, never run the CLI

const a = args();

if (a.cmd === 'ask') {
  const q = String(a.q || '').trim(); if (!q) out(2, { ok: false, error: '--q is required' });
  const id = 'q-' + String(Date.now()).slice(-6);
  append({ type: 'ask', id, at: new Date().toISOString(), from: String(a.from || 'unknown'), about: String(a.about || ''), q, blocking: !!a.blocking });
  out(0, { ok: true, id, status: 'open', note: 'the owner answers in the station, in company/owner/inbound.jsonl, or via `node company/tools/inbox.js answer`' });
}
if (a.cmd === 'list') {
  const rows = Object.values(state()).filter(x => x.type === 'ask' && (!a.open || (!x.a && !x.reclassified)));
  out(0, { ok: true, open: openQuestions().length, items: rows.map(x => ({ id: x.id, from: x.from, about: x.about, q: x.q, blocking: x.blocking, askedAt: x.at, answer: x.a || null, answeredBy: x.by || null, reclassified: x.reclassified || null })) });
}
if (a.cmd === 'reclassify') {
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  const note = String(a.note || '').trim(); if (!note) out(2, { ok: false, error: '--note is required (what the company decided and who owns it)' });
  const by = String(a.by || 'unknown');
  append({ type: 'reclassify', id, at: new Date().toISOString(), note, by });
  out(0, { ok: true, id, state: 'reclassified-company-owned', by, note });
}
if (a.cmd === 'answer' || a.cmd === 'close') {
  if (!isOwner(a.by)) out(3, { ok: false, error: 'only the Commander (the owner, the PM) can answer or close a question' });
  const id = String(a.id || ''); if (!id) out(2, { ok: false, error: '--id is required' });
  if (a.cmd === 'answer' && !String(a.a || '').trim()) out(2, { ok: false, error: '--a is required' });
  append({ type: a.cmd === 'answer' ? 'answer' : 'close', id, at: new Date().toISOString(), a: a.cmd === 'answer' ? String(a.a) : undefined, by: 'Commander' });
  out(0, { ok: true, id, state: a.cmd === 'answer' ? 'answered' : 'closed' });
}
out(2, { ok: false, error: 'unknown command: ' + a.cmd, commands: ['ask', 'list', 'answer', 'close', 'reclassify'] });
