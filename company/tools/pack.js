#!/usr/bin/env node
/* pack.js — capability packs: list them, check them, propose, approve, install and uninstall them.
 *
 * A pack (packs/<id>/, or a working folder an agent fills from packs/_template/) adds one line of business. Docs are
 * readable from the moment the folder exists; tools are ABSENT until the owner installs the pack (no dormant stub);
 * limits ship CLOSED (zero/empty); meters are locked on install (registered for locked-watch). Spec: docs/PACKS-SPEC.md,
 * schema: company/schemas/pack.schema.json.
 *
 *   node company/tools/pack.js list [--json]
 *   node company/tools/pack.js status <id> [--json]
 *   node company/tools/pack.js doctor [<id>|<dir>|--all] [--json]    # fail closed; exit 0 only when every INSTALLED pack is conformant
 *   node company/tools/pack.js propose <dir> --by <seat>               # check, then park in company/state/packs/proposed/<id>/
 *   node company/tools/pack.js approve <id> --by <owner>               # co.gate('packs'): approve = owner only
 *   node company/tools/pack.js reject <id> --by <owner> [--note ..]
 *   node company/tools/pack.js install <id> --by <owner>               # owner only, an approved proposal with the same digest
 *   node company/tools/pack.js uninstall <id> --by <owner>             # tools out, registrations out; meter records kept
 *   node company/tools/pack.js selftest                                # offline, temp root
 *
 * Status is exactly one of: absent (no such pack anywhere), dormant (exists but is not installed, or is installed and
 * fails doctor), conformant (installed and doctor passes, conformance test included). Only conformant counts.
 *
 * Where things go on install: tools -> company/tools/packs/<id>/; seat templates -> company/roles/templates/<id>--<seat>.md
 * (so hire.js --template <id>--<seat> finds them); the pack copy (limits included) -> company/state/packs/installed/<id>/;
 * allowlist hosts -> company/state/external-allowlist.txt (tagged "# pack:<id>"); meters, installed tools and installed
 * limits -> company/state/locked-extra.json (entries in locked-watch MANIFEST shape). Registry: company/state/packs.json;
 * log: company/state/packs-log.jsonl.
 * Why the propose/approve split mirrors console-panel.js: agents fill scaffolds, only the owner adds a line of business.
 * Env CAPHEOS_ROOT (read by lib/company.js) points everything at another root; the selftest uses it.
 * Exit: 0 ok, 1 findings / refused, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');
const co = require('./lib/company');

const R = co.ROOT;
const P = {
  src: path.join(R, 'packs'),
  state: co.p('company', 'state', 'packs'),
  proposed: co.p('company', 'state', 'packs', 'proposed'),
  installed: co.p('company', 'state', 'packs', 'installed'),
  registry: co.p('company', 'state', 'packs.json'),
  log: co.p('company', 'state', 'packs-log.jsonl'),
  tools: co.p('company', 'tools', 'packs'),
  roles: co.p('company', 'roles', 'templates'),
  lockedExtra: co.p('company', 'state', 'locked-extra.json'),
  allowlist: co.p('company', 'state', 'external-allowlist.txt'),
  schema: path.join(__dirname, '..', 'schemas', 'pack.schema.json'),
};
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
// mirror of external-gate.js CATEGORIES (kept static so doctor never loads the gate); the selftest checks they match
const EXT_CATS = ['message', 'publish', 'account', 'form', 'spend', 'network'];
const ID_RE = /^_?[a-z][a-z0-9-]{1,39}$/;
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const rel = f => path.relative(R, f) || '.';
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(t, f); try { require('./provenance.js').wrote(f, JSON.stringify(v, null, 2) + '\n', 'pack.js'); } catch (_) {} };

/* ---------- people ---------- */
function isOwner(by) {
  const b = String(by || '').trim().toLowerCase();
  const name = String((co.config.owner && co.config.owner.name) || '').toLowerCase();
  return b === 'owner' || (name && b === name);
}
function findSeat(who) {
  const c = co.crew(); const w = String(who || '').trim().toLowerCase();
  if (!w) return null;
  for (const id of Object.keys(c)) if (id.toLowerCase() === w || String(c[id].name || '').toLowerCase() === w) return { id, seat: c[id] };
  return null;
}
function underStation() { try { return require('./provenance.js').underStation(); } catch (_) { return false; } }
function ownerOnly(by, what) {
  if (!isOwner(by)) return 'only the owner ' + what;
  if (underStation()) return 'refused: "--by owner" from inside an agent\'s station run';
  return null;
}

/* ---------- registry, log, owner channel ---------- */
function registry() { const r = readJson(P.registry, {}) || {}; r.installed = r.installed || {}; r.approved = r.approved || {}; return r; }
function record(row) {
  fs.mkdirSync(path.dirname(P.log), { recursive: true });
  const line = Object.assign({ at: new Date().toISOString() }, row);
  fs.appendFileSync(P.log, JSON.stringify(line) + '\n');
  return line;
}
function tellOwner(text, from) {
  const mod = path.join(__dirname, 'owner-inbox.js');
  if (!fs.existsSync(mod)) return { told: false, why: 'owner-inbox.js not present' };
  try { const row = require(mod).send({ from, text }); return { told: true, id: row && row.id }; } catch (e) { return { told: false, why: e.message }; }
}
function askOwner(q, from) {
  const tool = path.join(__dirname, 'inbox.js');
  if (!fs.existsSync(tool)) return { asked: false, why: 'inbox.js not present' };
  try {
    const o = execFileSync(process.execPath, [tool, 'ask', '--from', from, '--about', 'packs', '--q', q], { cwd: R, encoding: 'utf8', timeout: 15000 });
    const j = JSON.parse(o); return { asked: !!j.ok, id: j.id };
  } catch (e) { return { asked: false, why: e.message }; }
}

/* ---------- files ---------- */
function walk(dir, base, out) {
  base = base || ''; out = out || [];
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out); else if (e.isFile()) out.push(r);
  }
  return out;
}
function digest(dir) {
  const h = crypto.createHash('sha256');
  for (const f of walk(dir)) h.update(f + '\0' + fs.readFileSync(path.join(dir, f)) + '\0');
  return h.digest('hex').slice(0, 16);
}
function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const f of walk(src)) { const d = path.join(dest, f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(src, f), d); }
}
const inside = (dir, f) => { const a = path.resolve(dir, f); return a.startsWith(path.resolve(dir) + path.sep) ? a : null; };

/* ---------- where a pack lives ---------- */
function installedDir(id) { return path.join(P.installed, id); }
function sourceDir(id) {
  for (const d of [path.join(P.proposed, id), path.join(P.src, id)]) if (fs.existsSync(path.join(d, 'pack.json'))) return d;
  return null;
}
function resolveDir(arg) {
  if (!arg) return null;
  if (ID_RE.test(arg)) { if (registry().installed[arg] && fs.existsSync(installedDir(arg))) return installedDir(arg); const s = sourceDir(arg); if (s) return s; }
  const a = path.resolve(arg);
  if (fs.existsSync(path.join(a, 'pack.json'))) return a;
  if (/pack\.json$/.test(a) && fs.existsSync(a)) return path.dirname(a);
  return null;
}
function allIds() {
  const ids = new Set();
  for (const d of [P.src, P.proposed, P.installed]) { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(d, e.name, 'pack.json'))) ids.add(e.name); } catch (_) {} }
  for (const id of Object.keys(registry().installed)) ids.add(id);
  return [...ids].sort();
}

/* ---------- a small JSON Schema subset checker (type, const, enum, required, properties, additionalProperties,
 * items, minItems, minLength, maxLength, pattern, $ref #/$defs) — enough for pack.schema.json ---------- */
function schemaCheck(s, v, at, out, root) {
  if (s.$ref) s = root.$defs[s.$ref.replace('#/$defs/', '')];
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  if (s.const !== undefined && v !== s.const) { out.push(at + ': must be ' + JSON.stringify(s.const)); return; }
  if (s.enum && !s.enum.includes(v)) { out.push(at + ': must be one of ' + s.enum.join(', ')); return; }
  if (s.type && s.type !== t && !(s.type === 'integer' && Number.isInteger(v))) { out.push(at + ': must be ' + s.type); return; }
  if (t === 'string') {
    if (s.minLength && v.length < s.minLength) out.push(at + ': too short');
    if (s.maxLength && v.length > s.maxLength) out.push(at + ': too long');
    if (s.pattern && !new RegExp(s.pattern).test(v)) out.push(at + ': does not match ' + s.pattern);
  }
  if (t === 'array') {
    if (s.minItems && v.length < s.minItems) out.push(at + ': needs at least ' + s.minItems);
    if (s.items) v.forEach((x, i) => schemaCheck(s.items, x, at + '[' + i + ']', out, root));
  }
  if (t === 'object') {
    for (const k of s.required || []) if (!(k in v)) out.push(at + '.' + k + ': required');
    for (const k of Object.keys(v)) {
      if (s.properties && s.properties[k]) schemaCheck(s.properties[k], v[k], at + '.' + k, out, root);
      else if (s.additionalProperties === false) out.push(at + '.' + k + ': not allowed');
    }
  }
}

/* A limit is CLOSED when every number is 0, every list is empty, and nothing is a boolean (a limit is a quantity the
 * owner opens, never an on/off switch). Keys starting with "_" are notes. Strings (units, currency) are allowed. */
function openParts(v, at, out) {
  if (typeof v === 'number') { if (v !== 0) out.push(at + ' = ' + v); }
  else if (typeof v === 'boolean') out.push(at + ' is a boolean (a limit is a quantity, not a switch)');
  else if (Array.isArray(v)) { if (v.length) out.push(at + ' has ' + v.length + ' entries'); }
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (!k.startsWith('_')) openParts(v[k], at + '.' + k, out); }
  return out;
}

/* ---------- checks ---------- */
// static: shape, files, closed limits, empty template tools. No requires, no conformance run.
function checkStatic(dir, opts) {
  opts = opts || {};
  const f = [];
  const raw = (() => { try { return fs.readFileSync(path.join(dir, opts.manifest || 'pack.json'), 'utf8'); } catch (_) { return null; } })();
  if (raw == null) return { pack: null, findings: ['pack.json: missing'] };
  let pack; try { pack = JSON.parse(raw); } catch (e) { return { pack: null, findings: ['pack.json: not JSON (' + e.message + ')'] }; }
  const schema = opts.schema || readJson(P.schema, null);
  if (!schema) f.push('schema: cannot read ' + rel(P.schema) + ' (fail closed)');
  else schemaCheck(schema, pack, 'pack.json', f, schema);
  if (!pack || typeof pack !== 'object') return { pack: null, findings: f };
  if (!opts.installed && pack.id !== path.basename(dir)) f.push('pack.json:id: ' + pack.id + ' does not equal the folder name ' + path.basename(dir));
  const exists = x => { const a = inside(dir, x); return a && fs.existsSync(a); };
  for (const d of pack.docs || []) if (!exists(d)) f.push('docs: ' + d + ' listed but missing');
  const toolFiles = walk(path.join(dir, 'tools')).map(x => 'tools/' + x);
  if (pack.template === true || String(pack.id || '').startsWith('_')) {
    const extra = toolFiles.filter(x => x !== 'tools/README.md');
    if (extra.length) f.push('tools: a template ships no tool and no stub; found ' + extra.join(', '));
    if ((pack.tools || []).length) f.push('pack.json:tools: a template lists no tools');
  }
  const listed = new Set((pack.tools || []).map(t => path.posix.normalize(t.file)));
  for (const t of pack.tools || []) {
    if (!/^tools\/[^/]+$/.test(path.posix.normalize(t.file))) f.push('tools: ' + t.file + ' must be a file directly under tools/');
    else if (!exists(t.file)) f.push('tools: ' + t.file + ' listed but missing');
  }
  for (const x of toolFiles) if (x !== 'tools/README.md' && !listed.has(x)) f.push('tools: ' + x + ' is not listed in pack.json (no unlisted callables)');
  const names = new Set((pack.seats || []).map(s => s.name));
  for (const s of pack.seats || []) {
    if (!exists(s.template)) f.push('seats: ' + s.name + ' template ' + s.template + ' missing');
    for (const o of s.independentOf || []) if (!names.has(o) && !FUNCTIONS.includes(o)) f.push('seats: ' + s.name + ' independentOf names unknown seat ' + o + ' (a seat of this pack or a function)');
  }
  for (const r of pack.routines || []) if (!exists(r.file)) f.push('routines: ' + r.file + ' missing');
  for (const pn of pack.panels || []) if (!exists(path.posix.join(pn, 'panel.json'))) f.push('panels: ' + pn + '/panel.json missing');
  for (const l of pack.limits || []) {
    const a = inside(dir, l.file); const v = a ? readJson(a, undefined) : undefined;
    if (v === undefined) { f.push('limits: ' + l.file + ' missing or not JSON'); continue; }
    if (!opts.installed) { const open = openParts(v, l.file, []); if (open.length) f.push('limits: must ship CLOSED: ' + open.join('; ')); }
  }
  const pid = String(pack.id || '');
  if (!opts.anyMeterPath) for (const m of pack.meters || []) if (!String(m.p).startsWith('company/work/packs/' + pid + '/')) f.push('meters: ' + m.p + ' must live under company/work/packs/' + pid + '/');
  if (!pack.conformance || !exists(pack.conformance.test)) f.push('conformance: test ' + ((pack.conformance || {}).test || '(none)') + ' missing (a pack is a contract plus a failing test, never a blank file)');
  return { pack, findings: f };
}

function checkRequires(pack, seen) {
  const f = []; const q = pack.requires || {};
  for (const id of q.packs || []) {
    if (seen.has(id)) { f.push('requires.packs: cycle through ' + id); continue; }
    const s = status(id, new Set([...seen, id]));
    if (s.status !== 'conformant') f.push('requires.packs: ' + id + ' is ' + s.status + ' (must be installed and conformant)');
  }
  // modules a pack (or a module) builds on: enabled in company/state/modules.json and module.js doctor-clean
  for (const id of q.modules || []) {
    if (seen.has('module:' + id)) { f.push('requires.modules: cycle through ' + id); continue; }
    let st = null; try { st = require('./module.js').status(id, new Set([...seen, 'module:' + id])); } catch (e) { st = { status: 'unknown (' + e.message + ')' }; }
    if (!st || st.status !== 'conformant') f.push('requires.modules: ' + id + ' is ' + (st ? st.status : 'unknown') + ' (must be enabled and conformant: node company/tools/module.js enable ' + id + ' --by owner)');
  }
  for (const g of q.guardrails || []) if (!co.guard(g)) f.push('requires.guardrails: ' + g + ' is OFF');
  for (const s of q.secrets || []) { let ok = false; try { ok = fs.statSync(path.join(co.SECRETS_DIR, s)).size > 0; } catch (_) {} if (!ok && !co.secret(s)) f.push('requires.secrets: secrets/' + s + ' missing or empty'); }
  const gov = co.governance();
  for (const c of q.governance || []) if (!(gov.categories && Object.prototype.hasOwnProperty.call(gov.categories, c))) f.push('requires.governance: category ' + c + ' not in governance.json');
  for (const c of q.externalGates || []) if (!EXT_CATS.includes(c)) f.push('requires.externalGates: unknown external-gate category ' + c);
  const abil = Array.isArray(co.config.station && co.config.station.abilities) ? co.config.station.abilities : [];
  for (const a of q.stationAbilities || []) if (!abil.includes(a)) f.push('requires.stationAbilities: ' + a + ' not in company.json station.abilities');
  return f;
}

function runConformance(dir, pack, installed) {
  const test = inside(dir, (pack.conformance || {}).test || '');
  if (!test || !fs.existsSync(test)) return { ok: false, out: 'conformance test missing' };
  const env = Object.assign({}, process.env, { PACK_DIR: dir, PACK_ROOT: R, PACK_INSTALLED: installed ? '1' : '0', PACK_TOOLS_DIR: installed ? path.join(P.tools, pack.id) : '' });
  const r = spawnSync(process.execPath, [test], { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  return { ok: r.status === 0, code: r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}

// installed-only: what install put in place is still there
function checkInstalled(pack, reg) {
  const f = [];
  for (const t of pack.tools || []) {
    const d = path.join(P.tools, pack.id, path.basename(t.file));
    if (!fs.existsSync(d)) f.push('installed: tool ' + rel(d) + ' missing');
    else if (reg.tools && reg.tools[t.file] && sha(fs.readFileSync(d)) !== reg.tools[t.file]) f.push('installed: tool ' + rel(d) + ' changed since install');
  }
  for (const s of pack.seats || []) if (!fs.existsSync(path.join(P.roles, pack.id + '--' + s.name + '.md'))) f.push('installed: seat template ' + pack.id + '--' + s.name + '.md missing');
  const extra = (readJson(P.lockedExtra, {}) || {}).entries || [];
  for (const m of pack.meters || []) if (!extra.some(e => e.pack === pack.id && e.p === m.p)) f.push('installed: meter ' + m.p + ' not registered in ' + rel(P.lockedExtra));
  const al = (() => { try { return fs.readFileSync(P.allowlist, 'utf8'); } catch (_) { return ''; } })();
  for (const a of pack.allowlist || []) if (!al.split('\n').some(l => l.trim().startsWith(a.host + ' ') && l.includes('# pack:' + pack.id))) f.push('installed: allowlist host ' + a.host + ' missing');
  return f;
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

/* ---------- status / doctor ---------- */
function status(id, seen) {
  seen = seen || new Set([id]);
  const reg = registry();
  const inst = reg.installed[id];
  if (inst) {
    const dir = installedDir(id);
    const { pack, findings } = checkStatic(dir, { installed: true });
    if (!pack) return { id, status: 'dormant', installed: true, findings };
    findings.push(...checkRequires(pack, seen), ...checkInstalled(pack, inst));
    const c = runConformance(dir, pack, true);
    if (!c.ok) findings.push('conformance: ' + (c.out.split('\n').slice(0, 12).join(' | ') || 'exit ' + c.code));
    return { id, status: findings.length ? 'dormant' : 'conformant', installed: true, dir: rel(dir), findings };
  }
  const dir = sourceDir(id);
  if (!dir) return { id, status: 'absent', installed: false, findings: [] };
  return Object.assign({ id, status: 'dormant', installed: false, dir: rel(dir), proposed: dir.startsWith(P.proposed + path.sep), approved: !!reg.approved[id] }, preview(dir));
}
// what doctor would say if this folder were installed: for agents filling a scaffold
function preview(dir) {
  const { pack, findings } = checkStatic(dir);
  if (!pack) return { findings };
  findings.push(...checkRequires(pack, new Set([pack.id])));
  const c = runConformance(dir, pack, false);
  return { findings, conformance: c.ok ? 'pass' : 'fail', conformanceOut: c.out };
}
function doctor(arg) {
  if (arg && arg !== true && !ID_RE.test(arg)) { const d = resolveDir(arg); if (!d) return { code: 2, out: { ok: false, error: 'no pack at ' + arg } }; const p = preview(d); return { code: p.findings.length || p.conformance !== 'pass' ? 1 : 0, out: Object.assign({ dir: d }, p) }; }
  const ids = arg && arg !== true ? [arg] : allIds();
  const rows = ids.map(id => status(id));
  const bad = rows.filter(r => r.installed && r.status !== 'conformant');
  const unknown = arg && arg !== true && rows[0].status === 'absent';
  return { code: bad.length || unknown ? 1 : 0, out: { ok: !bad.length && !unknown, packs: rows } };
}

/* ---------- propose / approve / install / uninstall ---------- */
function cmdPropose(dirArg, by) {
  const dir = resolveDir(dirArg);
  if (!dir) return { code: 2, out: { ok: false, error: 'no pack folder at ' + dirArg } };
  if (!by) return { code: 2, out: { ok: false, error: '--by <seat> is required' } };
  const owner = isOwner(by); const seat = findSeat(by);
  if (!owner && !seat) return { code: 1, out: { ok: false, error: '--by ' + by + ' is not a seat in loops.json or the owner' } };
  const { pack, findings } = checkStatic(dir);
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  if (pack.template === true || pack.id.startsWith('_')) return { code: 1, out: { ok: false, error: 'a template is never proposed; copy it, fill it, give it its own id' } };
  if (registry().installed[pack.id]) return { code: 1, out: { ok: false, error: pack.id + ' is installed; uninstall it first (owner) or propose under a new packVersion after uninstall' } };
  const c = runConformance(dir, pack, false);
  if (!c.ok) return { code: 1, out: { ok: false, error: 'conformance test fails', conformance: c.out } };
  const dest = path.join(P.proposed, pack.id);
  if (path.resolve(dir) !== path.resolve(dest)) copyDir(dir, dest);
  const reg = registry(); delete reg.approved[pack.id]; writeJson(P.registry, reg);
  const d = digest(dest);
  const who = owner ? 'owner' : (seat.seat.name || seat.id);
  const gate = co.gate('packs');
  const q = who + ' proposes capability pack "' + pack.title + '" (' + pack.id + '): ' + pack.summary
    + ' Needs: ' + JSON.stringify(pack.requires || {}) + '. Recommendation: review docs/ and limits/. Default if unanswered: not installed.'
    + ' Approve: node company/tools/pack.js approve ' + pack.id + ' --by owner; then install ' + pack.id + ' --by owner';
  const asked = owner ? null : (gate === 'approve' ? askOwner(q, who) : tellOwner(q, who));
  return { code: 0, out: { ok: true, status: 'proposed', id: pack.id, gate, dir: rel(dest), digest: d, asked, change: record({ op: 'propose', id: pack.id, by: who, gate, digest: d }) } };
}
function cmdApprove(id, by, reject, note) {
  const src = path.join(P.proposed, String(id || ''));
  if (!id || !fs.existsSync(path.join(src, 'pack.json'))) return { code: 1, out: { ok: false, error: 'no proposed pack ' + id } };
  const gate = co.gate('packs');
  let who;
  if (gate === 'approve' || reject) { const e = ownerOnly(by, reject ? 'rejects a pack' : 'approves a pack while governance "packs" is approve'); if (e) return { code: 1, out: { ok: false, error: e } }; who = 'owner'; }
  else {
    const s = findSeat(by);
    if (isOwner(by)) { const e = ownerOnly(by, 'approves'); if (e) return { code: 1, out: { ok: false, error: e } }; who = 'owner'; }
    else if (s && co.holds(s.seat, 'ceo')) who = s.seat.name || s.id;
    else return { code: 1, out: { ok: false, error: 'governance "packs" is ' + gate + ': the CEO seat or the owner approves' } };
  }
  const reg = registry();
  if (reject) { fs.rmSync(src, { recursive: true, force: true }); delete reg.approved[id]; writeJson(P.registry, reg); return { code: 0, out: { ok: true, status: 'rejected', change: record({ op: 'reject', id, by: who, note: note || null }) } }; }
  const { findings } = checkStatic(src);
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  const d = digest(src);
  reg.approved[id] = { by: who, at: new Date().toISOString(), digest: d, gate };
  writeJson(P.registry, reg);
  const told = gate === 'notify' && who !== 'owner' ? tellOwner(who + ' approved capability pack ' + id + ' (digest ' + d + '). Only you install it: node company/tools/pack.js install ' + id + ' --by owner', who) : null;
  return { code: 0, out: { ok: true, status: 'approved', id, digest: d, told, next: 'node company/tools/pack.js install ' + id + ' --by owner', change: record({ op: 'approve', id, by: who, gate, digest: d }) } };
}
function lockedEntries(pack) {
  const own = { pack: pack.id };
  const rows = (pack.meters || []).map(m => Object.assign({ p: m.p, cls: (m.writers || []).length ? 'A' : 'F', append: !!m.append, writers: m.writers || [], owner: m.owner, area: 'record', why: 'pack ' + pack.id + ' meter: ' + m.why }, own));
  for (const t of pack.tools || []) rows.push(Object.assign({ p: 'company/tools/packs/' + pack.id + '/' + path.basename(t.file), cls: 'F', owner: 'tools', area: 'tool', why: 'pack ' + pack.id + ' tool (installed by the owner)' }, own));
  for (const l of pack.limits || []) rows.push(Object.assign({ p: 'company/state/packs/installed/' + pack.id + '/' + l.file, cls: 'F', owner: l.owner, area: 'policy', why: 'pack ' + pack.id + ' limit: ' + l.why }, own));
  rows.push(Object.assign({ p: 'company/state/packs/installed/' + pack.id + '/pack.json', cls: 'F', owner: 'risk', area: 'policy', why: 'pack ' + pack.id + ' contract as installed' }, own));
  return rows;
}
function setLockedExtra(id, rows) {
  const cur = readJson(P.lockedExtra, null) || {};
  const doc = {
    _doc: 'Extra locked-watch entries (MANIFEST shape: p, cls, owner, area, why, writers?, append?) registered by company/tools/pack.js on install and removed on uninstall. locked-watch.js must append these to its MANIFEST and watch this file itself (cls F, writer pack.js, owner risk).',
    entries: (cur.entries || []).filter(e => e.pack !== id).concat(rows || []),
  };
  writeJson(P.lockedExtra, doc);
}
function setAllowlist(id, hosts) {
  let lines = []; try { lines = fs.readFileSync(P.allowlist, 'utf8').split('\n'); } catch (_) {}
  lines = lines.filter(l => !l.includes('# pack:' + id));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const a of hosts || []) lines.push(a.host + ' # pack:' + id + ' ' + a.why.replace(/\s+/g, ' '));
  fs.mkdirSync(path.dirname(P.allowlist), { recursive: true });
  fs.writeFileSync(P.allowlist, lines.length ? lines.join('\n') + '\n' : '');
}
function cmdInstall(id, by) {
  const e = ownerOnly(by, 'installs a pack'); if (e) return { code: 1, out: { ok: false, error: e } };
  const reg = registry();
  if (reg.installed[id]) return { code: 1, out: { ok: false, error: id + ' is already installed' } };
  const src = path.join(P.proposed, String(id || ''));
  if (!id || !fs.existsSync(path.join(src, 'pack.json'))) return { code: 1, out: { ok: false, error: 'no proposed pack ' + id + ' (propose, then approve, then install)' } };
  const ap = reg.approved[id];
  const d = digest(src);
  if (!ap) return { code: 1, out: { ok: false, error: id + ' is not approved: node company/tools/pack.js approve ' + id + ' --by owner' } };
  if (ap.digest !== d) return { code: 1, out: { ok: false, error: 'the proposed copy changed since approval (approved ' + ap.digest + ', now ' + d + '); approve again' } };
  const { pack, findings } = checkStatic(src);
  findings.push(...checkRequires(pack || {}, new Set([id])));
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  const c = runConformance(src, pack, false);
  if (!c.ok) return { code: 1, out: { ok: false, error: 'conformance test fails', conformance: c.out } };
  // place everything, then register; any failure rolls back
  const dest = installedDir(id);
  try {
    copyDir(src, dest);
    const tools = {};
    fs.mkdirSync(path.join(P.tools, id), { recursive: true });
    for (const t of pack.tools || []) { const to = path.join(P.tools, id, path.basename(t.file)); fs.copyFileSync(path.join(src, t.file), to); fs.chmodSync(to, 0o755); tools[t.file] = sha(fs.readFileSync(to)); }
    for (const s of pack.seats || []) fs.copyFileSync(path.join(src, s.template), path.join(P.roles, id + '--' + s.name + '.md'));
    for (const m of pack.meters || []) if (!m.p.includes('*')) { const a = path.join(R, m.p); fs.mkdirSync(path.dirname(a), { recursive: true }); if (!fs.existsSync(a)) fs.writeFileSync(a, ''); }
    setAllowlist(id, pack.allowlist);
    setLockedExtra(id, lockedEntries(pack));
    const panels = [];
    for (const pn of pack.panels || []) {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'console-panel.js'), 'add', path.join(dest, pn), '--by', 'owner'], { cwd: R, encoding: 'utf8', timeout: 30000 });
      panels.push({ panel: pn, code: r.status });
    }
    reg.installed[id] = { at: new Date().toISOString(), by: 'owner', digest: d, packVersion: pack.packVersion || null, tools, panels };
    delete reg.approved[id];
    writeJson(P.registry, reg);
    fs.rmSync(src, { recursive: true, force: true });
  } catch (err) {
    undoPlacement(id, pack);
    return { code: 1, out: { ok: false, error: 'install failed and was rolled back: ' + err.message } };
  }
  const st = status(id);
  const told = tellOwner('Capability pack ' + id + ' installed (' + st.status + '). Limits are closed until you open them in company/state/packs/installed/' + id + '/limits/.', 'pack.js');
  return { code: st.status === 'conformant' ? 0 : 1, out: { ok: st.status === 'conformant', status: st.status, id, findings: st.findings, told, change: record({ op: 'install', id, by: 'owner', digest: d, status: st.status }) } };
}
function undoPlacement(id, pack) {
  fs.rmSync(path.join(P.tools, id), { recursive: true, force: true });
  for (const s of (pack && pack.seats) || []) fs.rmSync(path.join(P.roles, id + '--' + s.name + '.md'), { force: true });
  setAllowlist(id, []);
  setLockedExtra(id, []);
  fs.rmSync(installedDir(id), { recursive: true, force: true });
}
function cmdUninstall(id, by) {
  const e = ownerOnly(by, 'uninstalls a pack'); if (e) return { code: 1, out: { ok: false, error: e } };
  const reg = registry();
  if (!reg.installed[id]) return { code: 1, out: { ok: false, error: id + ' is not installed' } };
  const pack = readJson(path.join(installedDir(id), 'pack.json'), {}) || {};
  for (const pn of pack.panels || []) { const pj = readJson(path.join(installedDir(id), pn, 'panel.json'), null); if (pj && pj.id) spawnSync(process.execPath, [path.join(__dirname, 'console-panel.js'), 'remove', pj.id, '--by', 'owner'], { cwd: R, timeout: 30000 }); }
  undoPlacement(id, pack);
  delete reg.installed[id]; writeJson(P.registry, reg);
  return { code: 0, out: { ok: true, status: 'uninstalled', id, kept: (pack.meters || []).map(m => m.p), note: 'meter records are kept; they are no longer locked-watched', change: record({ op: 'uninstall', id, by: 'owner' }) } };
}

function list() {
  const reg = registry();
  return allIds().map(id => {
    const inst = !!reg.installed[id];
    const dir = inst ? installedDir(id) : sourceDir(id);
    const pk = dir ? readJson(path.join(dir, 'pack.json'), {}) || {} : {};
    return { id, title: pk.title || null, template: pk.template === true, where: inst ? 'installed' : dir && dir.startsWith(P.proposed + path.sep) ? 'proposed' : 'packs/', approved: !!reg.approved[id], installed: inst };
  });
}

/* ---------- selftest (offline, temp root, child processes with CAPHEOS_ROOT) ---------- */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-selftest-'));
  let fails = 0, n = 0;
  const t = (name, ok, extra) => { n++; if (!ok) { fails++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 600) : '')); } else console.log('ok   ' + name); };
  const here = path.resolve(__dirname, '..', '..');
  try {
    const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
    mk('company', 'tools', 'lib'); mk('company', 'schemas'); mk('company', 'state'); mk('company', 'owner'); mk('company', 'roles', 'templates'); mk('secrets');
    fs.copyFileSync(__filename, path.join(tmp, 'company', 'tools', 'pack.js'));
    fs.copyFileSync(path.join(__dirname, 'lib', 'company.js'), path.join(tmp, 'company', 'tools', 'lib', 'company.js'));
    fs.copyFileSync(P.schema, path.join(tmp, 'company', 'schemas', 'pack.schema.json'));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){const r={id:'out-test',from,text};fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify(r)+'\\n');return r;}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC', station: { port: 1, abilities: ['local-render'] } }));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { 'a-ceo': { name: 'Sam', manager: null, functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'] }, 'a-two': { name: 'Kim', manager: 'a-ceo', functions: [] } } }));
    const gov = readJson(path.join(here, 'company', 'defaults', 'state', 'governance.json'), {});
    t('defaults: governance has packs = approve', gov.categories && gov.categories.packs === 'approve', gov.categories);
    t('defaults: every preset has packs = approve', Object.values(gov.presets || {}).every(p => p.categories.packs === 'approve'));
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'governance.json'), JSON.stringify(gov));
    const guards = readJson(path.join(here, 'company', 'defaults', 'state', 'guardrails.json'), {});
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'guardrails.json'), JSON.stringify(guards));
    try { t('external categories mirror external-gate.js', JSON.stringify(Object.keys(require('./external-gate.js').CATEGORIES)) === JSON.stringify(EXT_CATS)); } catch (_) { /* gate absent: skip */ }
    copyDir(path.join(here, 'packs', '_template'), path.join(tmp, 'packs', '_template'));
    const run = (...a) => { const r = spawnSync(process.execPath, [path.join(tmp, 'company', 'tools', 'pack.js'), ...a, '--json'], { cwd: tmp, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp }), timeout: 120000 }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {} return { code: r.status, j, out: r.stdout + r.stderr }; };

    let r = run('doctor', '--all');
    t('fresh: doctor --all exit 0 (nothing installed)', r.code === 0, r.out);
    t('fresh: template reported dormant', r.j && r.j.packs.find(p => p.id === '_template').status === 'dormant', r.j);
    t('status of an unknown pack is absent', run('status', 'nope').j.status === 'absent');
    const tc = spawnSync(process.execPath, [path.join(tmp, 'packs', '_template', 'conformance', 'test.js')], { encoding: 'utf8' });
    t('template conformance test FAILS and says what is missing', tc.status === 1 && /MISSING tools/.test(tc.stdout) && /MISSING meters/.test(tc.stdout), tc.stdout);
    t('a template is never proposed', run('propose', path.join(tmp, 'packs', '_template'), '--by', 'Kim').code === 1);

    // fill a pack from the template
    const work = path.join(tmp, 'work', 'demo'); copyDir(path.join(tmp, 'packs', '_template'), work);
    const pj = readJson(path.join(work, 'pack.json'));
    Object.assign(pj, { id: 'demo', title: 'Demo pack', summary: 'A demo line of business for the selftest.', template: false,
      tools: [{ file: 'tools/demo.js', purpose: 'does the demo work' }],
      meters: [{ p: 'company/work/packs/demo/ledger.jsonl', append: true, writers: ['demo.js'], owner: 'finance', why: 'the demo ledger' }],
      allowlist: [{ host: 'api.example.com', why: 'the demo upload endpoint' }],
      seats: [{ name: 'maker', template: 'roles/maker.md', why: 'makes things' }, { name: 'checker', template: 'roles/checker.md', independentOf: ['maker'], why: 'checks the maker' }] });
    pj.requires.stationAbilities = ['local-render'];
    fs.writeFileSync(path.join(work, 'pack.json'), JSON.stringify(pj, null, 2));
    fs.writeFileSync(path.join(work, 'README.md'), '# Demo\n\nContract: makes demos. Halt: soft halt stops it.\n');
    fs.writeFileSync(path.join(work, 'docs', 'STANDARD.md'), '# Demo standard\n');
    mk('work', 'demo', 'roles'); fs.writeFileSync(path.join(work, 'roles', 'maker.md'), '# <Name>\n'); fs.writeFileSync(path.join(work, 'roles', 'checker.md'), '# <Name>\n');
    fs.writeFileSync(path.join(work, 'tools', 'demo.js'), "if (process.argv.includes('--selftest')) { console.log('ok'); process.exit(0); }\n");
    r = run('doctor', work);
    t('filled folder: doctor preview passes', r.code === 0 && r.j.conformance === 'pass', r.j);

    const lim = path.join(work, 'limits', 'limits.json'); const limOrig = fs.readFileSync(lim, 'utf8');
    fs.writeFileSync(lim, JSON.stringify({ dailyUnits: 5, enabled: true }));
    r = run('propose', work, '--by', 'Kim');
    t('propose refused: limits not closed (number and boolean)', r.code === 1 && /CLOSED/.test(JSON.stringify(r.j)) && /boolean/.test(JSON.stringify(r.j)), r.j);
    fs.writeFileSync(lim, limOrig);
    fs.writeFileSync(path.join(work, 'tools', 'stub.js'), '// stub\n');
    t('propose refused: unlisted tool file', run('propose', work, '--by', 'Kim').code === 1);
    fs.rmSync(path.join(work, 'tools', 'stub.js'));
    t('propose refused: unknown seat', run('propose', work, '--by', 'Nobody').code === 1);

    r = run('propose', work, '--by', 'Kim');
    t('propose ok: parked, gate approve', r.code === 0 && r.j.status === 'proposed' && r.j.gate === 'approve', r.out);
    t('propose: tools still absent from company/tools', !fs.existsSync(path.join(tmp, 'company', 'tools', 'packs', 'demo')));
    t('status after propose: dormant', run('status', 'demo').j.status === 'dormant');
    t('install refused before approval', run('install', 'demo', '--by', 'owner').code === 1);
    t('approve refused for the CEO seat while gate is approve', run('approve', 'demo', '--by', 'Sam').code === 1);
    t('approve ok for the owner (by name)', run('approve', 'demo', '--by', 'Alex').code === 0);
    fs.appendFileSync(path.join(tmp, 'company', 'state', 'packs', 'proposed', 'demo', 'docs', 'STANDARD.md'), 'sneaky edit\n');
    t('install refused: proposed copy changed after approval', /changed since approval/.test(run('install', 'demo', '--by', 'owner').out));
    t('re-approve ok', run('approve', 'demo', '--by', 'owner').code === 0);
    t('install refused for an agent', run('install', 'demo', '--by', 'Sam').code === 1);

    guards.guards.spendCap = false; fs.writeFileSync(path.join(tmp, 'company', 'state', 'guardrails.json'), JSON.stringify(guards));
    r = run('install', 'demo', '--by', 'owner');
    t('install refused: a required guardrail is off', r.code === 1 && /spendCap is OFF/.test(r.out), r.out);
    guards.guards.spendCap = true; fs.writeFileSync(path.join(tmp, 'company', 'state', 'guardrails.json'), JSON.stringify(guards));

    r = run('install', 'demo', '--by', 'owner');
    t('install ok: conformant', r.code === 0 && r.j.status === 'conformant', r.out);
    t('install: tool copied in', fs.existsSync(path.join(tmp, 'company', 'tools', 'packs', 'demo', 'demo.js')));
    t('install: seat templates placed for hire.js', fs.existsSync(path.join(tmp, 'company', 'roles', 'templates', 'demo--checker.md')));
    const le = readJson(path.join(tmp, 'company', 'state', 'locked-extra.json'), {});
    t('install: meter registered locked (cls A, writer demo.js)', (le.entries || []).some(e => e.p === 'company/work/packs/demo/ledger.jsonl' && e.cls === 'A' && e.pack === 'demo'), le);
    t('install: installed limits registered locked', (le.entries || []).some(e => /installed\/demo\/limits\/limits\.json$/.test(e.p)));
    t('install: allowlist host added', /api\.example\.com # pack:demo/.test(fs.readFileSync(path.join(tmp, 'company', 'state', 'external-allowlist.txt'), 'utf8')));
    t('install: owner told', /installed/.test(fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8')));
    r = run('doctor', '--all');
    t('doctor --all exit 0 with demo conformant + template dormant', r.code === 0 && r.j.packs.find(p => p.id === 'demo').status === 'conformant', r.j);

    fs.appendFileSync(path.join(tmp, 'company', 'tools', 'packs', 'demo', 'demo.js'), '// tampered\n');
    r = run('doctor', '--all');
    t('tampered tool: doctor exit 1, demo dormant', r.code === 1 && r.j.packs.find(p => p.id === 'demo').status === 'dormant', r.j);
    fs.rmSync(path.join(tmp, 'company', 'tools', 'packs', 'demo', 'demo.js'));
    t('missing tool: status dormant', run('status', 'demo').j.status === 'dormant');
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'governance.json'), JSON.stringify({ categories: {} }));
    const g0 = spawnSync(process.execPath, ['-e', "process.stdout.write(require(process.argv[1]).gate('packs'))", path.join(tmp, 'company', 'tools', 'lib', 'company.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp }) });
    t('governance without packs: co.gate fails closed to approve', g0.stdout === 'approve', g0.stdout + g0.stderr);
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'governance.json'), JSON.stringify(gov));

    t('uninstall refused for an agent', run('uninstall', 'demo', '--by', 'Sam').code === 1);
    r = run('uninstall', 'demo', '--by', 'owner');
    t('uninstall ok', r.code === 0, r.out);
    t('uninstall: tools and seat templates gone', !fs.existsSync(path.join(tmp, 'company', 'tools', 'packs', 'demo')) && !fs.existsSync(path.join(tmp, 'company', 'roles', 'templates', 'demo--maker.md')));
    t('uninstall: registrations gone, meter record kept', !((readJson(path.join(tmp, 'company', 'state', 'locked-extra.json'), {}).entries || []).some(e => e.pack === 'demo')) && fs.existsSync(path.join(tmp, 'company', 'work', 'packs', 'demo', 'ledger.jsonl')));
    t('uninstall: allowlist line gone', !/pack:demo/.test(fs.readFileSync(path.join(tmp, 'company', 'state', 'external-allowlist.txt'), 'utf8')));
    t('after uninstall: demo absent, doctor exit 0', run('status', 'demo').j.status === 'absent' && run('doctor', '--all').code === 0);
    t('repo template passes static checks (closed limits, no tools)', checkStatic(path.join(here, 'packs', '_template')).findings.length === 0, checkStatic(path.join(here, 'packs', '_template')).findings);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

// shared with module.js (core modules use the same scaffold rules)
module.exports = { status, doctor, list, checkStatic, checkRequires, openParts, digest, schemaCheck, walk, copyDir, sha, isOwner, findSeat, ownerOnly, underStation, tellOwner, askOwner, inside, EXT_CATS, FUNCTIONS, SCHEMA: P.schema };
if (require.main !== module) return;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else o._.push(argv[i]);
  }
  return o;
}
const A = args(process.argv.slice(2));
const cmd = A._[0];
const emit = res => {
  if (A.json || !res.out.packs) console.log(JSON.stringify(res.out, null, 1));
  else for (const p of res.out.packs) { console.log(p.status.toUpperCase().padEnd(11) + ' ' + p.id + (p.installed ? '  (installed)' : '')); for (const f of p.findings || []) console.log('    ' + f); }
  process.exit(res.code);
};
if (cmd === 'selftest' || A.selftest) process.exit(selftest());
if (cmd === 'list') {
  const rows = list();
  if (A.json) console.log(JSON.stringify(rows, null, 1));
  else { if (!rows.length) console.log('no packs'); for (const x of rows) console.log(x.where.padEnd(10) + ' ' + x.id.padEnd(24) + ' ' + (x.title || '') + (x.template ? '  [template]' : '') + (x.approved ? '  [approved]' : '')); }
  process.exit(0);
}
if (cmd === 'status') { if (!A._[1]) { console.error('status <id>'); process.exit(2); } const s = status(A._[1]); if (A.json) console.log(JSON.stringify(s, null, 1)); else { console.log(s.status); for (const f of s.findings || []) console.log('  ' + f); } process.exit(0); }
if (cmd === 'doctor') emit(doctor(A.all ? true : A._[1] || true));
if (cmd === 'propose') emit(cmdPropose(A._[1], A.by));
if (cmd === 'approve') emit(cmdApprove(A._[1], A.by));
if (cmd === 'reject') emit(cmdApprove(A._[1], A.by, true, A.note));
if (cmd === 'install') emit(cmdInstall(A._[1], A.by));
if (cmd === 'uninstall') emit(cmdUninstall(A._[1], A.by));
console.error('usage: pack.js list | status <id> | doctor [<id>|<dir>|--all] | propose <dir> --by <seat> | approve|reject <id> --by <owner> | install|uninstall <id> --by <owner> | selftest   [--json]');
process.exit(2);
