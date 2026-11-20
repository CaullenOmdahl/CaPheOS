#!/usr/bin/env node
/* project.js — the product-takeover registry. Access is not ownership.
 *
 *   node company/tools/project.js list
 *   node company/tools/project.js status  --id example-app
 *   node company/tools/project.js request --id example-app --name "Example App" --root "/path" --scope "…" --by Alex
 *   node company/tools/project.js approve --id example-app --by Commander [--scope "…"]
 *   node company/tools/project.js revoke  --id example-app --by Commander
 *   node company/tools/project.js assert  --id example-app      # exit 0 only when approved/active
 *   node company/tools/project.js discover --id example-app --remote <git url> --by Alex
 *   node company/tools/project.js relationship --id example-app --set <client|own> --by Commander
 *
 * The one rule this encodes: ONLY the Commander can approve or revoke. An agent naming itself is
 * refused, so "we gave ourselves permission" is impossible by construction. "Commander" is the owner; `--by owner` and
 * the owner's name from company/company.json are accepted as the same person.
 *
 * relationship (client | own, lib/projects.js): a product the company did not found is client work, the owner's own
 * included, and every row starts as client. Only the Commander marks a row own (a product the company founded); list,
 * status, assert and the seats' dossiers show it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const FILE = co.p('company', 'projects.json');
const STATES = ['discovered', 'requested', 'approved', 'active', 'revoked', 'declined'];
const PJ = require('./lib/projects');

const load = PJ.load;
function save(db) {
  db.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1) + '\n');
  fs.renameSync(tmp, FILE);
}
function args() {
  const o = {}; const a = process.argv.slice(2);
  o.cmd = a[0] || 'list';
  for (let i = 1; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
function isCommander(by) { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'commander' || b === 'owner' || b === String(co.config.owner.name || '').trim().toLowerCase()); }
function find(db, id) { return db.projects.find(p => p.id === String(id || '').toLowerCase()); }
function out(code, obj) { console.log(JSON.stringify(obj, null, 1)); process.exit(code); }
function gitInfo(root) {
  const g = (a) => { try { return execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 8000 }).trim(); } catch (_) { return ''; } };
  return { branch: g(['rev-parse', '--abbrev-ref', 'HEAD']), head: g(['rev-parse', '--short', 'HEAD']), remotes: g(['remote', '-v']).split('\n').filter(Boolean) };
}

const a = args();
const db = load();

if (a.cmd === 'list') {
  out(0, {
    ok: true,
    company: co.config.name,
    policy: 'access != ownership; only Commander approves a takeover',
    projects: db.projects.map(p => ({ id: p.id, name: p.name, state: p.state, relationship: PJ.relationshipOf(p), root: p.root, approvedBy: p.approvedBy || null, scope: p.scope || '' })),
  });
}

if (a.cmd === 'status' || a.cmd === 'assert') {
  const id = String(a.id || '').toLowerCase();
  const p = find(db, id);
  if (!p) out(a.cmd === 'assert' ? 3 : 1, { ok: false, error: 'no such project: ' + id, hint: 'node company/tools/project.js list' });
  const live = p.state === 'approved' || p.state === 'active';
  if (a.cmd === 'assert') {
    if (!live) out(3, { ok: false, id, state: p.state, error: 'takeover NOT approved by the Commander — do not modify, rebrand, ship or publish', next: 'request it, then wait for the Commander' });
    out(0, { ok: true, id, state: p.state, relationship: PJ.relationshipOf(p), brief: PJ.NOTE[PJ.relationshipOf(p)], scope: p.scope, approvedBy: p.approvedBy, approvedAt: p.approvedAt });
  }
  out(0, { ok: true, project: Object.assign({}, p, { relationship: PJ.relationshipOf(p) }), brief: PJ.NOTE[PJ.relationshipOf(p)] });
}

if (a.cmd === 'discover') {
  const id = String(a.id || '').toLowerCase();
  if (!id) out(2, { ok: false, error: '--id is required' });
  let p = find(db, id);
  if (p && (p.state === 'approved' || p.state === 'active')) out(1, { ok: false, error: 'already approved; discover would not downgrade it', project: p });
  const row = p || { id, createdAt: new Date().toISOString(), relationship: 'client' };
  Object.assign(row, {
    name: String(a.name || row.name || id),
    remote: String(a.remote || row.remote || ''),
    root: a.root ? path.resolve(String(a.root)) : (row.root || ''),
    scope: String(a.scope || row.scope || ''),
    state: 'discovered',
    discoveredBy: String(a.by || 'unknown'), discoveredAt: new Date().toISOString(),
  });
  if (!p) db.projects.push(row); else Object.assign(p, row);
  save(db);
  out(0, { ok: true, discovered: { id, name: row.name, remote: row.remote, state: 'discovered', relationship: PJ.relationshipOf(row) }, note: 'access registered; NO ownership granted' });
}

if (a.cmd === 'request') {
  const id = String(a.id || '').toLowerCase();
  if (!id) out(2, { ok: false, error: '--id is required' });
  const name = String(a.name || id);
  const root = a.root ? path.resolve(String(a.root)) : '';
  if (root && !fs.existsSync(root)) out(2, { ok: false, error: 'root does not exist: ' + root });
  const by = String(a.by || 'unknown');
  let p = find(db, id);
  if (p && (p.state === 'approved' || p.state === 'active')) out(1, { ok: false, error: 'already approved', project: p });
  const git = root ? gitInfo(root) : null;
  const row = p || { id, createdAt: new Date().toISOString(), relationship: 'client' };
  Object.assign(row, {
    name, root: root || row.root || '', scope: String(a.scope || '') || row.scope || '',
    remote: (git && git.remotes[0]) || row.remote || '',
    git: git || row.git || null,
    state: 'requested',
    requestedBy: by, requestedAt: new Date().toISOString(),
    approvedBy: null, approvedAt: null, revokedBy: null, revokedAt: null,
  });
  if (!p) db.projects.push(row); else Object.assign(p, row);
  save(db);
  out(0, { ok: true, requested: { id, name, root: row.root, scope: row.scope, state: 'requested', relationship: PJ.relationshipOf(row) }, note: 'takeover is NOT granted. Only --by Commander can approve it.' });
}

if (a.cmd === 'approve') {
  if (!isCommander(a.by)) out(3, { ok: false, error: 'only the Commander can approve a takeover; "' + String(a.by || '') + '" cannot' });
  const id = String(a.id || '').toLowerCase();
  const p = find(db, id);
  if (!p) out(1, { ok: false, error: 'no such project: ' + id, hint: 'request it first' });
  p.state = 'active';
  p.approvedBy = 'Commander';
  p.approvedAt = new Date().toISOString();
  if (a.scope) p.scope = String(a.scope);
  save(db);
  out(0, { ok: true, approved: { id: p.id, name: p.name, state: p.state, relationship: PJ.relationshipOf(p), scope: p.scope, approvedBy: p.approvedBy, approvedAt: p.approvedAt } });
}

if (a.cmd === 'revoke') {
  if (!isCommander(a.by)) out(3, { ok: false, error: 'only the Commander can revoke a takeover' });
  const id = String(a.id || '').toLowerCase();
  const p = find(db, id);
  if (!p) out(1, { ok: false, error: 'no such project: ' + id });
  p.state = 'revoked';
  p.revokedBy = 'Commander';
  p.revokedAt = new Date().toISOString();
  p.approvedBy = null; p.approvedAt = null;
  save(db);
  out(0, { ok: true, revoked: p.id, state: p.state });
}

if (a.cmd === 'relationship') {
  const id = String(a.id || '').toLowerCase();
  const p = find(db, id);
  if (!p) out(1, { ok: false, error: 'no such project: ' + id });
  const to = String(a.set || '').toLowerCase();
  if (!PJ.RELATIONSHIPS.includes(to)) out(2, { ok: false, error: '--set must be one of ' + PJ.RELATIONSHIPS.join(', ') });
  // anyone may record a product as client work; only the Commander marks one as the company's own
  if (to === 'own' && !isCommander(a.by)) out(3, { ok: false, error: 'only the Commander can mark a project as the company\'s own; "' + String(a.by || '') + '" cannot' });
  p.relationship = to;
  save(db);
  out(0, { ok: true, id: p.id, relationship: to, brief: PJ.NOTE[to] });
}

out(2, { ok: false, error: 'unknown command: ' + a.cmd, commands: ['list', 'status', 'request', 'approve', 'revoke', 'assert', 'discover', 'relationship'] });
