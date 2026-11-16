#!/usr/bin/env node
/* mandate.js — the company's mandate register.
 *
 * A MANDATE is an instruction from the Commander (or, as the company matures, an improvement the
 * company issues itself) that must become operating procedure. Mandates are not chat messages: they
 * are recorded, owned, converted into documents/policies by named agents, and reviewed.
 *
 *   node company/tools/mandate.js list
 *   node company/tools/mandate.js show   --id <id>
 *   node company/tools/mandate.js issue  --id <id> --title "…" --text "…" --by Commander [--type self-improvement]
 *   node company/tools/mandate.js assign --id <id> --agent Alex --task "…"
 *   node company/tools/mandate.js adopt  --id <id> --doc company/standards/x.md --by Alex --summary "…"
 *   node company/tools/mandate.js note   --id <id> --text "…" --by Sam
 *
 * Authority rule (the same shape as the takeover gate): a mandate that would EXPAND the company's
 * permissions, ownership or spending must be issued or confirmed by the Commander. The company may
 * issue self-improvement mandates inside its existing authority without asking.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const FILE = co.p('company', 'mandates.json');

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && Array.isArray(j.mandates)) return j; } catch (_) {}
  return { version: 1, mandates: [] };
}
function save(db) {
  db.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1) + '\n');
  fs.renameSync(tmp, FILE);
}
function args() {
  const a = process.argv.slice(2); const o = { cmd: a[0] || 'list' };
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
function isCommander(by) { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'commander' || b === 'owner' || b === String(co.config.owner.name || '').trim().toLowerCase()); }
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }
const a = args(); const db = load();
const find = id => db.mandates.find(m => m.id === String(id || '').toLowerCase());

if (a.cmd === 'list') {
  out(0, { ok: true, company: co.config.name, mandates: db.mandates.map(m => ({ id: m.id, title: m.title, status: m.status, issuedBy: m.issuedBy, owner: m.owner || null, docs: (m.resultingDocs || []).length })) });
}
if (a.cmd === 'show') {
  const m = find(a.id); if (!m) out(1, { ok: false, error: 'no such mandate' });
  out(0, { ok: true, mandate: m });
}
if (a.cmd === 'issue') {
  const id = String(a.id || '').toLowerCase();
  if (!id) out(2, { ok: false, error: '--id is required' });
  const by = String(a.by || 'unknown');
  const type = String(a.type || 'commander').toLowerCase();
  if (type !== 'self-improvement' && !isCommander(by)) {
    out(3, { ok: false, error: 'a commander mandate must be issued by the Commander; a company-issued mandate must be --type self-improvement' });
  }
  if (find(id)) out(1, { ok: false, error: 'mandate already exists: ' + id });
  const m = {
    id, title: String(a.title || id), text: String(a.text || ''),
    type, issuedBy: by, issuedAt: new Date().toISOString(),
    status: 'received', owner: null, assignments: [], resultingDocs: [], notes: [],
  };
  db.mandates.push(m); save(db);
  out(0, { ok: true, issued: { id, title: m.title, type, status: m.status }, next: 'the CEO assigns it, the owners turn it into procedure, then `adopt` records the result' });
}
if (a.cmd === 'assign') {
  const m = find(a.id); if (!m) out(1, { ok: false, error: 'no such mandate' });
  const agent = String(a.agent || ''); const task = String(a.task || '');
  if (!agent || !task) out(2, { ok: false, error: '--agent and --task are required' });
  m.assignments.push({ agent, task, at: new Date().toISOString() });
  m.owner = m.owner || agent;
  if (m.status === 'received') m.status = 'in-progress';
  save(db); out(0, { ok: true, mandate: m.id, assignments: m.assignments.length });
}
if (a.cmd === 'adopt') {
  const m = find(a.id); if (!m) out(1, { ok: false, error: 'no such mandate' });
  const doc = String(a.doc || '');
  if (!doc) out(2, { ok: false, error: '--doc is required (path the company wrote)' });
  m.resultingDocs = m.resultingDocs || [];
  m.resultingDocs.push({ doc, summary: String(a.summary || ''), by: String(a.by || 'unknown'), at: new Date().toISOString() });
  m.status = 'adopted';
  m.adoptedAt = new Date().toISOString();
  m.reviewAt = new Date(Date.now() + 30 * 864e5).toISOString();   // 30-day review
  save(db); out(0, { ok: true, adopted: m.id, docs: m.resultingDocs.length, reviewAt: m.reviewAt });
}
if (a.cmd === 'set-status') {
  const m = find(a.id); if (!m) out(1, { ok: false, error: 'no such mandate' });
  const st = String(a.status || '').toLowerCase();
  const OK = ['received', 'in-progress', 'adopted', 'superseded'];
  if (OK.indexOf(st) < 0) out(2, { ok: false, error: 'status must be one of ' + OK.join(', ') });
  m.status = st; if (st === 'adopted') m.adoptedAt = m.adoptedAt || new Date().toISOString();
  m.notes.push({ text: 'status -> ' + st, by: String(a.by || 'unknown'), at: new Date().toISOString() });
  save(db); out(0, { ok: true, mandate: m.id, status: m.status });
}
if (a.cmd === 'note') {
  const m = find(a.id); if (!m) out(1, { ok: false, error: 'no such mandate' });
  m.notes.push({ text: String(a.text || ''), by: String(a.by || 'unknown'), at: new Date().toISOString() });
  save(db); out(0, { ok: true, mandate: m.id, notes: m.notes.length });
}
out(2, { ok: false, error: 'unknown command: ' + a.cmd, commands: ['list', 'show', 'issue', 'assign', 'adopt', 'note', 'set-status'] });
