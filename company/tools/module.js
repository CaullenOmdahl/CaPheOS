#!/usr/bin/env node
/* module.js — core modules: list them, check them, enable and disable them (docs/CORE-MODULES.md).
 *
 * A core module (modules/<id>/) is generic plumbing a pack builds on: intake, commitments, liveness, ... It follows the
 * pack scaffold rules (docs/PACKS-SPEC.md) — docs always readable, tools absent until enabled, limits closed, meters
 * locked on enable — with three differences: there is no propose/approve step (modules ship with the framework, the
 * owner enables them), tools are copied flat into company/tools/ (they are company tools once enabled), and a module
 * may ship a tick.js (run by the dispatcher) and an http.js (mounted by the console). Runtime hooks: lib/modules.js.
 *
 *   node company/tools/module.js list [--json]
 *   node company/tools/module.js status <id> [--json]
 *   node company/tools/module.js doctor [<id>|--all] [--json]   # fail closed; exit 0 only when every ENABLED module is conformant
 *   node company/tools/module.js enable <id> --by <owner>       # owner only, governance category 'packs'
 *   node company/tools/module.js disable <id> --by <owner>      # tools, rows and registrations out; meter records kept
 *   node company/tools/module.js limits <id> [show]             # shipped (closed) vs opened limits
 *   node company/tools/module.js limits <id> set <file> <key.path> <number> --by <owner>   # open (or close with 0) a limit:
 *                                                               # writes company/state/modules/<id>/<file> (locked-watch F)
 *   node company/tools/module.js gates [--json]                 # owner gates the enabled modules' requirements resolve to
 *   node company/tools/module.js migrate-rows [--check] [--json] # move module rows an older module.js wrote into the
 *                                                               # tracked INVENTORY.md / runbook into the local file and
 *                                                               # restore those files to HEAD (instance-guard.sh runs it)
 *   node company/tools/module.js selftest | --selftest          # offline, temp root
 *
 * module.json = pack.json (company/schemas/pack.schema.json) plus:
 *   layer        sense | organize | act | verify | settle | guarantee
 *   enableWhen   one sentence: when a company needs it (the CORE-MODULES.md table)
 *   requires.modules   other modules that must be enabled first
 *   limits may be empty; meters may live anywhere under company/work/ or company/state/.
 * Optional files: tick.js, http.js (see lib/modules.js), rows.md (the INVENTORY / runbook rows for its tools: sections
 * "## INVENTORY", "## 5a", "## 7b", each holding markdown table rows; generated from tools[] when absent).
 *
 * enable: copies each tools/<file> to company/tools/<file> (refuses to overwrite a file it did not place), creates empty
 * meter files, registers meters + tools + tick.js/http.js in company/state/locked-extra.json (entries tagged module:<id>),
 * writes the tools' rows to company/state/inventory-local.md (instance-local, gitignored; sections INVENTORY / 5a / 7b,
 * read next to company/tools/INVENTORY.md and company/runbooks/tool-management.md by tool-inventory-check.js and doctor,
 * so the tracked files never change and a framework `git pull` stays clean), adds allowlist hosts tagged "# module:<id>", adds panels, records the module in
 * company/state/modules.json and tells the owner. Any failure rolls back. Log: company/state/modules-log.jsonl.
 * Status: absent | dormant (exists, not enabled, or enabled and doctor fails) | conformant (enabled, doctor clean).
 * Exit: 0 ok, 1 findings / refused, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const co = require('./lib/company');
const pk = require('./pack.js');
const mods = require('./lib/modules');

const R = co.ROOT;
const P = {
  src: mods.MODULES_DIR,
  state: mods.STATE_FILE,
  log: co.p('company', 'state', 'modules-log.jsonl'),
  tools: co.p('company', 'tools'),
  lockedExtra: co.p('company', 'state', 'locked-extra.json'),
  allowlist: co.p('company', 'state', 'external-allowlist.txt'),
  inventory: co.p('company', 'tools', 'INVENTORY.md'),
  runbook: co.p('company', 'runbooks', 'tool-management.md'),
  local: co.p('company', 'state', 'inventory-local.md'),
};
const LAYERS = ['sense', 'organize', 'act', 'verify', 'settle', 'guarantee'];
const ID_RE = mods.ID_RE;
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const rel = f => path.relative(R, f) || '.';
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(t, f); try { require('./provenance.js').wrote(f, JSON.stringify(v, null, 2) + '\n', 'module.js'); } catch (_) {} };
function record(row) { fs.mkdirSync(path.dirname(P.log), { recursive: true }); const l = Object.assign({ at: new Date().toISOString() }, row); fs.appendFileSync(P.log, JSON.stringify(l) + '\n'); return l; }

/* ---------- schema: pack.schema.json + layer, enableWhen, requires.modules; limits may be empty; meters anywhere in work/state ---------- */
function moduleSchema() {
  const s = readJson(pk.SCHEMA, null);
  if (!s) return null;
  const m = JSON.parse(JSON.stringify(s));
  m.$id = 'capheos:module'; m.title = 'CaPheOS core module (modules/<id>/module.json)';
  m.required = m.required.concat(['layer', 'enableWhen']);
  m.properties.layer = { type: 'string', enum: LAYERS };
  m.properties.enableWhen = { type: 'string', minLength: 3, maxLength: 400 };
  m.properties.order = { type: 'integer' };
  m.properties.id = { type: 'string', pattern: '^[a-z][a-z0-9-]{1,39}$' };
  delete m.properties.limits.minItems;
  m.properties.meters.items.properties.p = { type: 'string', pattern: '^company/(work|state)/[A-Za-z0-9_./*-]+$' };
  m.properties.requires.properties.modules = m.properties.requires.properties.modules || { type: 'array', items: { type: 'string' } };
  return m;
}

/* ---------- where modules live ---------- */
const srcDir = id => path.join(P.src, id);
function allIds() {
  const ids = new Set();
  try { for (const e of fs.readdirSync(P.src, { withFileTypes: true })) if (e.isDirectory() && ID_RE.test(e.name) && fs.existsSync(path.join(P.src, e.name, 'module.json'))) ids.add(e.name); } catch (_) {}
  for (const id of mods.enabled()) ids.add(id);
  return [...ids].sort();
}
function readModule(id) { return readJson(path.join(srcDir(id), 'module.json'), null); }

/* ---------- checks ---------- */
function checkStatic(dir) {
  const schema = moduleSchema();
  if (!fs.existsSync(path.join(dir, 'module.json'))) return { mod: null, findings: ['module.json: missing'] };
  const raw = fs.readFileSync(path.join(dir, 'module.json'), 'utf8');
  let mod; try { mod = JSON.parse(raw); } catch (e) { return { mod: null, findings: ['module.json: not JSON (' + e.message + ')'] }; }
  if (fs.existsSync(path.join(dir, 'pack.json'))) return { mod, findings: ['pack.json: a module ships module.json, not pack.json'] };
  const r = pk.checkStatic(dir, { schema, anyMeterPath: true, manifest: 'module.json' });
  const findings = r.findings.map(x => x.replace(/^pack\.json/, 'module.json'));
  for (const t of mod.tools || []) {
    const a = pk.inside(dir, t.file);
    if (a && fs.existsSync(a) && /\.(js|sh|py|mjs)$/.test(a) && fs.readFileSync(a, 'utf8').indexOf('--selftest') < 0) findings.push('tools: ' + t.file + ' has no --selftest (every module tool proves itself)');
  }
  for (const f of ['tick.js', 'http.js']) {
    const a = path.join(dir, f);
    if (!fs.existsSync(a)) continue;
    const c = spawnSync(process.execPath, ['--check', a], { encoding: 'utf8' });
    if (c.status !== 0) findings.push(f + ': does not parse: ' + String(c.stderr).split('\n').slice(0, 3).join(' '));
  }
  return { mod, findings };
}
function runConformance(dir, mod, installed) {
  const test = pk.inside(dir, (mod.conformance || {}).test || '');
  if (!test || !fs.existsSync(test)) return { ok: false, out: 'conformance test missing' };
  const env = Object.assign({}, process.env, { MODULE_DIR: dir, MODULE_ROOT: R, MODULE_ENABLED: installed ? '1' : '0', MODULE_TOOLS_DIR: installed ? P.tools : path.join(dir, 'tools'),
    PACK_DIR: dir, PACK_ROOT: R, PACK_INSTALLED: installed ? '1' : '0', PACK_TOOLS_DIR: installed ? P.tools : '' });
  const r = spawnSync(process.execPath, [test], { cwd: dir, env, encoding: 'utf8', timeout: 120000 });
  return { ok: r.status === 0, code: r.status, out: String((r.stdout || '') + (r.stderr || '')).trim() };
}
function checkEnabled(id, mod, reg) {
  const f = [];
  for (const t of mod.tools || []) {
    const d = path.join(P.tools, path.basename(t.file));
    if (!fs.existsSync(d)) f.push('enabled: tool ' + rel(d) + ' missing');
    else if (reg.tools && reg.tools[t.file] && pk.sha(fs.readFileSync(d)) !== reg.tools[t.file]) f.push('enabled: tool ' + rel(d) + ' changed since enable');
  }
  const extra = (readJson(P.lockedExtra, {}) || {}).entries || [];
  for (const m of mod.meters || []) if (!extra.some(e => e.module === id && e.p === m.p)) f.push('enabled: meter ' + m.p + ' not registered in ' + rel(P.lockedExtra));
  const inv = [P.inventory, P.runbook, P.local].map(f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } }).join('\n');
  for (const t of mod.tools || []) if (!inv.includes('company/tools/' + path.basename(t.file))) f.push('enabled: tool ' + path.basename(t.file) + ' has no INVENTORY/runbook row');
  if (reg.digest && pk.digest(srcDir(id)) !== reg.digest) f.push('enabled: modules/' + id + '/ changed since enable (disable and enable again to take the change)');
  return f;
}
function status(id, seen) {
  seen = seen || new Set(['module:' + id]);
  const reg = mods.state().enabled[id];
  const dir = srcDir(id);
  if (!fs.existsSync(path.join(dir, 'module.json'))) return { id, status: reg ? 'dormant' : 'absent', enabled: !!reg, findings: reg ? ['modules/' + id + '/module.json is gone but the module is enabled'] : [] };
  const { mod, findings } = checkStatic(dir);
  if (!mod) return { id, status: 'dormant', enabled: !!reg, findings };
  findings.push(...pk.checkRequires(mod, seen));
  if (reg) findings.push(...checkEnabled(id, mod, reg));
  const c = runConformance(dir, mod, !!reg);
  if (!c.ok) findings.push('conformance: ' + (c.out.split('\n').slice(0, 12).join(' | ') || 'exit ' + c.code));
  return { id, title: mod.title, layer: mod.layer, enableWhen: mod.enableWhen, status: reg && !findings.length ? 'conformant' : 'dormant', enabled: !!reg, findings, conformance: c.ok ? 'pass' : 'fail' };
}
function doctor(arg) {
  const ids = arg && arg !== true ? [arg] : allIds();
  const rows = ids.map(id => status(id));
  const bad = rows.filter(r => r.enabled && r.status !== 'conformant');
  const unknown = arg && arg !== true && rows[0].status === 'absent';
  return { code: bad.length || unknown ? 1 : 0, out: { ok: !bad.length && !unknown, modules: rows } };
}
function list() {
  const en = mods.state().enabled;
  return allIds().map(id => { const m = readModule(id) || {}; return { id, title: m.title || null, layer: m.layer || null, enableWhen: m.enableWhen || null, enabled: !!en[id], tick: fs.existsSync(path.join(srcDir(id), 'tick.js')), http: fs.existsSync(path.join(srcDir(id), 'http.js')) }; });
}

/* ---------- rows: INVENTORY.md and the runbook's §5a / §7b tables ---------- */
function defaultRows(mod) {
  const rows = { INVENTORY: [], '5a': [], '7b': [] };
  for (const t of mod.tools || []) {
    const b = path.basename(t.file); const run = /\.sh$/.test(b) ? 'bash' : /\.py$/.test(b) ? 'python3 -I' : 'node';
    rows.INVENTORY.push('| `company/tools/' + b + '` | ' + String(t.purpose).replace(/\|/g, '/') + ' (module ' + mod.id + ') | ' + mod.owner + ' | `--selftest` | see header | — |');
    rows['5a'].push('| company/tools/' + b + ' | ' + mod.owner + ' | `--selftest` |');
    rows['7b'].push('| `company/tools/' + b + '` | ' + mod.owner + ' | `' + run + ' company/tools/' + b + ' --selftest` |');
  }
  return rows;
}
function moduleRows(dir, mod) {
  const f = path.join(dir, 'rows.md');
  return fs.existsSync(f) ? parseRows(fs.readFileSync(f, 'utf8')) : defaultRows(mod);
}
function parseRows(text) {
  const rows = { INVENTORY: [], '5a': [], '7b': [] }; let cur = null;
  for (const l of String(text || '').split('\n')) {
    const h = l.match(/^##\s+(INVENTORY|5a|7b)\b/i); if (h) { cur = h[1].toUpperCase() === 'INVENTORY' ? 'INVENTORY' : h[1].toLowerCase(); continue; }
    if (cur && /^\|/.test(l) && !/^\|\s*-/.test(l) && !/^\|\s*tool\s*\|/.test(l)) rows[cur].push(l.trimEnd());
  }
  return rows;
}
// company/state/inventory-local.md: the instance's module rows, never tracked (company/state/ is gitignored)
const LOCAL_HEAD = { INVENTORY: '| tool | purpose | owner | selftest | CLI | credentials |\n|---|---|---|---|---|---|', '5a': '| tool | owner | selftest |\n|---|---|---|', '7b': '| tool | owner | selftest |\n|---|---|---|' };
function readLocal() { try { return parseRows(fs.readFileSync(P.local, 'utf8')); } catch (_) { return { INVENTORY: [], '5a': [], '7b': [] }; } }
function writeLocal(rows) {
  const out = ['# Instance-local tool inventory', '',
    'Rows for the core-module tools this company enabled (written by company/tools/module.js enable/disable; read next to',
    'company/tools/INVENTORY.md and company/runbooks/tool-management.md §5a/§7b by tool-inventory-check.js and module.js',
    'doctor). Instance-local and gitignored, so the tracked framework files never change and `git pull` stays clean.', ''];
  const title = { INVENTORY: '## INVENTORY (company/tools/INVENTORY.md)', '5a': '## 5a (tool-management.md §5a)', '7b': '## 7b (tool-management.md §7b selftest table)' };
  for (const k of ['INVENTORY', '5a', '7b']) out.push(title[k], '', LOCAL_HEAD[k], ...rows[k], '');
  fs.mkdirSync(path.dirname(P.local), { recursive: true });
  const t = P.local + '.tmp-' + process.pid; fs.writeFileSync(t, out.join('\n')); fs.renameSync(t, P.local);
}
const rowPat = b => new RegExp('company/tools/' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(`| \\|)');
function setRows(mod, dir, on) {
  const files = (mod.tools || []).map(t => path.basename(t.file)); const pats = files.map(rowPat);
  const cur = readLocal(); const add = on ? moduleRows(dir, mod) : { INVENTORY: [], '5a': [], '7b': [] };
  for (const k of Object.keys(cur)) { cur[k] = cur[k].filter(l => !pats.some(p => p.test(l))); for (const r of add[k]) if (!cur[k].includes(r)) cur[k].push(r); }
  writeLocal(cur);
}
// migrate-rows: an older module.js appended module rows to the tracked INVENTORY.md / runbook, which then blocked
// `git pull`. Move them into the local file and put the tracked files back to HEAD.
function migrateRows(check) {
  const git = (...a) => spawnSync('git', a, { cwd: R, encoding: 'utf8' });
  const inGit = git('rev-parse', '--git-dir').status === 0;
  const pats = Object.values(mods.state().enabled || {}).flatMap(x => Object.keys(x.tools || {}).map(f => rowPat(path.basename(f))));
  const isModRow = l => /^\|/.test(l) && (/\(module [a-z0-9][a-z0-9-]*\)/.test(l) || pats.some(p => p.test(l)));
  const local = readLocal(); const moved = [], restored = [], kept = [];
  for (const f of [P.inventory, P.runbook]) {
    if (!fs.existsSync(f)) continue;
    const r = rel(f); const text = fs.readFileSync(f, 'utf8');
    const head = inGit ? git('show', 'HEAD:' + r) : null;
    const base = head && head.status === 0 ? new Set(head.stdout.split('\n')) : null;
    let sec = f === P.inventory ? 'INVENTORY' : null; const out = []; let n = 0;
    for (const l of text.split('\n')) {
      if (f === P.runbook) { const h = l.match(/^###\s+(5a|7b)\b/); if (h) sec = h[1]; else if (/^##\s/.test(l)) sec = null; }
      if (isModRow(l) && (!base || !base.has(l))) { n++; moved.push({ file: r, row: l }); if (sec && !local[sec].includes(l.trimEnd())) local[sec].push(l.trimEnd()); continue; }
      out.push(l);
    }
    if (!n || check) continue;
    const rest = out.join('\n');
    if (head && head.status === 0 && rest === head.stdout) {
      git('update-index', '--no-skip-worktree', '--', r);
      const c = git('checkout', '--', r);
      if (c.status !== 0) fs.writeFileSync(f, rest);
      restored.push(r);
    } else { fs.writeFileSync(f, rest); kept.push(r + ' (module rows removed; other local changes kept)'); }
  }
  if (moved.length && !check) writeLocal(local);
  return { code: check && moved.length ? 1 : 0, out: { ok: !(check && moved.length), check: !!check, moved: moved.length, rows: moved, restored, kept, local: rel(P.local) } };
}

/* ---------- registrations ---------- */
function lockedEntries(id, mod) {
  const own = { module: id };
  const rows = (mod.meters || []).map(m => Object.assign({ p: m.p, cls: (m.writers || []).length ? 'A' : 'F', append: !!m.append, writers: m.writers || [], owner: m.owner, area: 'record', why: 'module ' + id + ' meter: ' + m.why }, own));
  for (const t of mod.tools || []) rows.push(Object.assign({ p: 'company/tools/' + path.basename(t.file), cls: 'F', owner: 'tools', area: 'tool', why: 'module ' + id + ' tool (enabled by the owner)' }, own));
  for (const f of ['tick.js', 'http.js', 'module.json']) if (fs.existsSync(path.join(srcDir(id), f))) rows.push(Object.assign({ p: 'modules/' + id + '/' + f, cls: 'F', owner: f === 'http.js' ? 'risk' : 'tools', area: f === 'module.json' ? 'policy' : 'tool', why: 'module ' + id + ' ' + f + ' (runs inside the ' + (f === 'http.js' ? 'console' : 'dispatcher') + ')' }, own));
  for (const l of mod.limits || []) rows.push(Object.assign({ p: 'modules/' + id + '/' + l.file, cls: 'F', owner: l.owner, area: 'policy', why: 'module ' + id + ' limit as shipped (closed): ' + l.why }, own));
  if ((mod.limits || []).length) rows.push(Object.assign({ p: 'company/state/modules/' + id + '/limits/**', cls: 'F', writers: ['module.js'], owner: (mod.limits[0] || {}).owner || 'risk', area: 'policy', why: 'module ' + id + ' limits as OPENED by the owner (module.js limits ' + id + ' set ...)' }, own));
  return rows;
}
function setLockedExtra(id, rows) {
  const cur = readJson(P.lockedExtra, null) || {};
  writeJson(P.lockedExtra, {
    _doc: cur._doc || 'Extra locked-watch entries (MANIFEST shape: p, cls, owner, area, why, writers?, append?) registered by company/tools/pack.js (pack:<id>) and company/tools/module.js (module:<id>) and removed on uninstall/disable. locked-watch.js appends them to its MANIFEST and watches this file itself.',
    entries: (cur.entries || []).filter(e => e.module !== id).concat(rows || []),
  });
}
function setAllowlist(id, hosts) {
  let lines = []; try { lines = fs.readFileSync(P.allowlist, 'utf8').split('\n'); } catch (_) {}
  lines = lines.filter(l => !l.includes('# module:' + id));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const a of hosts || []) lines.push(a.host + ' # module:' + id + ' ' + a.why.replace(/\s+/g, ' '));
  if (!lines.length && !fs.existsSync(P.allowlist)) return;
  fs.mkdirSync(path.dirname(P.allowlist), { recursive: true });
  fs.writeFileSync(P.allowlist, lines.length ? lines.join('\n') + '\n' : '');
}
function dependents(id) {
  const out = [];
  for (const o of mods.enabled()) if (o !== id && ((readModule(o) || {}).requires || {}).modules && readModule(o).requires.modules.includes(id)) out.push('module ' + o);
  const preg = readJson(co.p('company', 'state', 'packs.json'), {}) || {};
  for (const p of Object.keys(preg.installed || {})) { const pj = readJson(co.p('company', 'state', 'packs', 'installed', p, 'pack.json'), {}) || {}; if (((pj.requires || {}).modules || []).includes(id)) out.push('pack ' + p); }
  return out;
}

/* ---------- enable / disable ---------- */
function cmdEnable(id, by) {
  const e = pk.ownerOnly(by, 'enables a core module'); if (e) return { code: 1, out: { ok: false, error: e } };
  if (!ID_RE.test(String(id || ''))) return { code: 2, out: { ok: false, error: 'enable <id>' } };
  const st = mods.state();
  if (st.enabled[id]) return { code: 0, out: { ok: true, already: true, id, status: status(id).status } };
  const dir = srcDir(id);
  if (!fs.existsSync(path.join(dir, 'module.json'))) return { code: 1, out: { ok: false, error: 'no module modules/' + id + '/' } };
  const gate = co.gate('packs');
  const { mod, findings } = checkStatic(dir);
  if (mod && mod.id !== id) findings.push('module.json: id ' + mod.id + ' does not equal the folder name');
  if (mod) findings.push(...pk.checkRequires(mod, new Set(['module:' + id])));
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  const c = runConformance(dir, mod, false);
  if (!c.ok) return { code: 1, out: { ok: false, error: 'conformance test fails', conformance: c.out } };
  const owned = new Set(Object.values(st.enabled).flatMap(x => Object.keys(x.tools || {}).map(f => path.basename(f))));
  for (const t of mod.tools || []) { const to = path.join(P.tools, path.basename(t.file)); if (fs.existsSync(to) && !owned.has(path.basename(t.file))) return { code: 1, out: { ok: false, error: 'company/tools/' + path.basename(t.file) + ' already exists and is not a module tool; rename the module tool' } }; }
  const placed = [];
  const backup = (() => { try { return fs.readFileSync(P.local, 'utf8'); } catch (_) { return null; } })();
  try {
    const tools = {};
    for (const t of mod.tools || []) { const to = path.join(P.tools, path.basename(t.file)); fs.copyFileSync(path.join(dir, t.file), to); fs.chmodSync(to, 0o755); placed.push(to); tools[t.file] = pk.sha(fs.readFileSync(to)); }
    for (const m of mod.meters || []) if (!m.p.includes('*')) { const a = path.join(R, m.p); fs.mkdirSync(path.dirname(a), { recursive: true }); if (!fs.existsSync(a) && !/\.json$/.test(a)) fs.writeFileSync(a, ''); }
    setRows(mod, dir, true);
    setAllowlist(id, mod.allowlist);
    setLockedExtra(id, lockedEntries(id, mod));
    const panels = [];
    for (const pn of mod.panels || []) {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'console-panel.js'), 'add', path.join(dir, pn), '--by', 'owner'], { cwd: R, encoding: 'utf8', timeout: 30000 });
      const pj = readJson(path.join(dir, pn, 'panel.json'), {}) || {};
      panels.push({ panel: pn, id: pj.id || null, code: r.status });
    }
    const s2 = mods.state();
    s2._doc = 'Core modules enabled in this company (company/tools/module.js; docs/CORE-MODULES.md). Only module.js writes this file.';
    s2.enabled[id] = { at: new Date().toISOString(), by: 'owner', gate, digest: pk.digest(dir), version: mod.packVersion || null, layer: mod.layer, tools, panels };
    writeJson(P.state, s2);
  } catch (err) {
    for (const f of placed) fs.rmSync(f, { force: true });
    if (backup === null) fs.rmSync(P.local, { force: true }); else fs.writeFileSync(P.local, backup);
    setAllowlist(id, []); setLockedExtra(id, []);
    return { code: 1, out: { ok: false, error: 'enable failed and was rolled back: ' + err.message } };
  }
  const s = status(id);
  const told = pk.tellOwner('Core module ' + id + ' (' + mod.title + ') enabled: ' + s.status + '.' + ((mod.requires || {}).secrets || []).map(x => ' Needs secrets/' + x + '.').join(''), 'module.js');
  // a running company's copied tools and inventory rows must never reach the framework repo (scripts/instance-guard.sh)
  try { const g = path.join(co.ROOT, 'scripts', 'instance-guard.sh'); if (fs.existsSync(g) && fs.existsSync(co.p('company', 'work', '.founded'))) require('child_process').execFileSync('bash', [g], { cwd: co.ROOT, stdio: 'ignore', timeout: 30000 }); } catch (_) {}
  return { code: s.status === 'conformant' ? 0 : 1, out: { ok: s.status === 'conformant', id, status: s.status, findings: s.findings, told, change: record({ op: 'enable', id, by: 'owner', gate, status: s.status }) } };
}
function cmdDisable(id, by) {
  const e = pk.ownerOnly(by, 'disables a core module'); if (e) return { code: 1, out: { ok: false, error: e } };
  const st = mods.state();
  const reg = st.enabled[id];
  if (!reg) return { code: 1, out: { ok: false, error: id + ' is not enabled' } };
  const deps = dependents(id);
  if (deps.length) return { code: 1, out: { ok: false, error: id + ' is required by ' + deps.join(', ') + '; disable those first' } };
  const mod = readModule(id) || { tools: Object.keys(reg.tools || {}).map(file => ({ file })) };
  for (const p of reg.panels || []) if (p.id) spawnSync(process.execPath, [path.join(__dirname, 'console-panel.js'), 'remove', p.id, '--by', 'owner'], { cwd: R, timeout: 30000 });
  for (const f of Object.keys(reg.tools || {})) fs.rmSync(path.join(P.tools, path.basename(f)), { force: true });
  try { setRows({ tools: Object.keys(reg.tools || {}).map(file => ({ file })) }, srcDir(id), false); } catch (_) {}
  setAllowlist(id, []); setLockedExtra(id, []);
  delete st.enabled[id]; writeJson(P.state, st);
  return { code: 0, out: { ok: true, status: 'disabled', id, kept: (mod.meters || []).map(m => m.p), note: 'meter records are kept; they are no longer locked-watched', change: record({ op: 'disable', id, by: 'owner' }) } };
}

/* ---------- limits: shipped closed in modules/<id>/limits/, opened by the owner in company/state/modules/<id>/limits/ ----------
 * Module tools read the opened copy first and fall back to the shipped closed one (lib/modules.js limitsFile). Only
 * numbers are set (a limit is a quantity, never a switch); 0 closes it again. */
function cmdLimits(id, sub, file, key, value, by) {
  const mod = readModule(String(id || ''));
  if (!mod) return { code: 1, out: { ok: false, error: 'no module ' + id } };
  const show = () => (mod.limits || []).map(l => ({ file: l.file, owner: l.owner, opened: fs.existsSync(co.p('company', 'state', 'modules', id, l.file)), value: readJson(mods.limitsFile(id, l.file), null) }));
  if (!sub || sub === 'show') return { code: 0, out: { ok: true, id, limits: show() } };
  if (sub !== 'set') return { code: 2, out: { ok: false, error: 'limits <id> [show] | set <file> <key.path> <number> --by owner' } };
  const e = pk.ownerOnly(by, 'opens a module limit'); if (e) return { code: 1, out: { ok: false, error: e } };
  const l = (mod.limits || []).find(x => x.file === file || path.basename(x.file) === file);
  if (!l) return { code: 1, out: { ok: false, error: 'module ' + id + ' ships no limit ' + file + ' (has: ' + (mod.limits || []).map(x => x.file).join(', ') + ')' } };
  const n = Number(value);
  if (!key || value === undefined || !Number.isFinite(n) || n < 0) return { code: 2, out: { ok: false, error: 'set <file> <key.path> <number ≥ 0>' } };
  const dest = co.p('company', 'state', 'modules', id, l.file);
  const cur = readJson(dest, null) || readJson(path.join(srcDir(id), l.file), {}) || {};
  const parts = String(key).split('.'); let o = cur;
  for (const k of parts.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) return { code: 1, out: { ok: false, error: 'no key ' + key + ' in ' + l.file } }; o = o[k]; }
  const last = parts[parts.length - 1];
  if (!(last in o) || typeof o[last] !== 'number') return { code: 1, out: { ok: false, error: key + ' is not a number in ' + l.file + ' (only shipped numeric limits can be opened)' } };
  const was = o[last]; o[last] = n;
  writeJson(dest, cur);
  return { code: 0, out: { ok: true, id, file: rel(dest), key, was, now: n, change: record({ op: 'limit', id, file: l.file, key, was, now: n, by: 'owner' }) } };
}

/* Owner gates the enabled modules' (and installed packs') requirements resolve to: secrets to provide, external-gate
 * categories that need a clearance policy, station abilities. onboard.js batches these into Today questions once. */
function gates() {
  const out = [];
  const add = (from, kind, name, have) => out.push({ from, kind, name, satisfied: have });
  const srcs = mods.enabled().map(id => ['module ' + id, readModule(id) || {}]);
  const preg = readJson(co.p('company', 'state', 'packs.json'), {}) || {};
  for (const p of Object.keys(preg.installed || {})) srcs.push(['pack ' + p, readJson(co.p('company', 'state', 'packs', 'installed', p, 'pack.json'), {}) || {}]);
  for (const [from, m] of srcs) {
    const q = m.requires || {};
    for (const s of q.secrets || []) { let ok = false; try { ok = fs.statSync(path.join(co.SECRETS_DIR, s)).size > 0; } catch (_) {} add(from, 'secret', s, ok || !!co.secret(s)); }
    for (const g of q.externalGates || []) add(from, 'externalGate', g, null);
    const abil = Array.isArray(co.config.station && co.config.station.abilities) ? co.config.station.abilities : [];
    for (const a of q.stationAbilities || []) add(from, 'stationAbility', a, abil.includes(a));
  }
  return out;
}

/* ---------- selftest ---------- */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'module-selftest-'));
  let fails = 0, n = 0;
  const t = (name, ok, extra) => { n++; if (!ok) { fails++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('ok   ' + name); };
  const here = path.resolve(__dirname, '..', '..');
  try {
    const mk = (...p) => { const d = path.join(tmp, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
    mk('company', 'tools', 'lib'); mk('company', 'schemas'); mk('company', 'state'); mk('company', 'owner'); mk('company', 'runbooks'); mk('secrets');
    for (const f of ['module.js', 'pack.js', 'lib/company.js', 'lib/modules.js', 'INVENTORY.md']) fs.copyFileSync(path.join(__dirname, f), path.join(tmp, 'company', 'tools', f));
    fs.copyFileSync(path.join(here, 'company', 'runbooks', 'tool-management.md'), path.join(tmp, 'company', 'runbooks', 'tool-management.md'));
    fs.copyFileSync(pk.SCHEMA, path.join(tmp, 'company', 'schemas', 'pack.schema.json'));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){const r={id:'out-test',from,text};fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify(r)+'\\n');return r;}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC', station: { port: 1 } }));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { 'a-ceo': { name: 'Sam', manager: null, functions: ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'] } } }));
    fs.copyFileSync(path.join(here, 'company', 'defaults', 'state', 'governance.json'), path.join(tmp, 'company', 'state', 'governance.json'));
    fs.copyFileSync(path.join(here, 'company', 'defaults', 'state', 'guardrails.json'), path.join(tmp, 'company', 'state', 'guardrails.json'));
    // a demo module
    const md = mk('modules', 'demo'); mk('modules', 'demo', 'tools'); mk('modules', 'demo', 'docs'); mk('modules', 'demo', 'conformance');
    const mj = { version: 1, id: 'demo', title: 'Demo module', summary: 'A module for the selftest.', packVersion: '0.1.0', owner: 'tools', layer: 'guarantee', enableWhen: 'always, in the selftest',
      requires: {}, docs: ['README.md'], tools: [{ file: 'tools/demo-mod.js', purpose: 'does the demo module work' }], limits: [{ file: 'limits/limits.json', owner: 'finance', why: 'how much the demo may do' }], order: 5,
      meters: [{ p: 'company/work/demo/log.jsonl', append: true, writers: ['demo-mod.js'], owner: 'tools', why: 'the demo record' }], conformance: { test: 'conformance/test.js' } };
    fs.writeFileSync(path.join(md, 'module.json'), JSON.stringify(mj, null, 2));
    fs.writeFileSync(path.join(md, 'README.md'), '# Demo\n');
    mk('modules', 'demo', 'limits'); fs.writeFileSync(path.join(md, 'limits', 'limits.json'), JSON.stringify({ perDay: 0 }));
    fs.writeFileSync(path.join(md, 'tools', 'demo-mod.js'), "if (process.argv.includes('--selftest')) { console.log('ok'); process.exit(0); }\n");
    fs.writeFileSync(path.join(md, 'conformance', 'test.js'), "process.exit(require('fs').existsSync(process.env.MODULE_DIR + '/README.md') ? 0 : 1);\n");
    fs.writeFileSync(path.join(md, 'tick.js'), "module.exports = { runWhenHalted: false, async tick({ log }) { require('fs').appendFileSync(require('path').join(__dirname, 'ticked'), 'x'); log('DEMO TICK'); return 1; } };\n");
    fs.writeFileSync(path.join(md, 'http.js'), "module.exports = { routes: [{ method: 'GET', path: 'ping/:who', auth: 'owner', handler: (req, res, ctx) => ({ ok: true, who: ctx.params.who }) }] };\n");
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp });
    // a git checkout, so the tracked framework files can be held to HEAD
    const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: tmp, encoding: 'utf8' });
    g('init', '-q'); fs.writeFileSync(path.join(tmp, '.gitignore'), '/company/state/*\n/company/owner/*\n/company/work/*\n'); g('add', '-A'); g('commit', '-qm', 'base');
    const trackedClean = () => g('status', '--porcelain', '--', 'company/tools/INVENTORY.md', 'company/runbooks/tool-management.md').stdout.trim() === '' && !/^S /m.test(g('ls-files', '-v', 'company/tools/INVENTORY.md', 'company/runbooks/tool-management.md').stdout);
    const run = (...a) => { const r = spawnSync(process.execPath, [path.join(tmp, 'company', 'tools', 'module.js'), ...a, '--json'], { cwd: tmp, encoding: 'utf8', env, timeout: 120000 }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {} return { code: r.status, j, out: r.stdout + r.stderr }; };
    const js = code => spawnSync(process.execPath, ['-e', code], { cwd: tmp, encoding: 'utf8', env, timeout: 60000 });

    let r = run('list');
    t('list shows the demo module, not enabled', r.code === 0 && r.j.some(x => x.id === 'demo' && !x.enabled && x.tick && x.http), r.out);
    r = run('doctor', '--all');
    t('doctor --all: nothing enabled -> exit 0, demo dormant', r.code === 0 && r.j.modules[0].status === 'dormant', r.out);
    t('status of an unknown module is absent', run('status', 'nope').j.status === 'absent');
    t('enable refused for an agent seat', run('enable', 'demo', '--by', 'Sam').code === 1);
    t('tool absent before enable', !fs.existsSync(path.join(tmp, 'company', 'tools', 'demo-mod.js')));
    const tk = js("require('./company/tools/lib/modules').runTicks({log:console.log}).then(r=>console.log(JSON.stringify(r)))");
    t('no tick runs for a module that is not enabled', !fs.existsSync(path.join(md, 'ticked')), tk.stdout);
    // bad manifest: a limit that is open, a tool without --selftest
    fs.writeFileSync(path.join(md, 'tools', 'demo-mod.js'), "console.log('no proof');\n");
    r = run('enable', 'demo', '--by', 'owner');
    t('enable refused: a tool without --selftest', r.code === 1 && /--selftest/.test(r.out), r.out);
    fs.writeFileSync(path.join(md, 'tools', 'demo-mod.js'), "if (process.argv.includes('--selftest')) { console.log('ok'); process.exit(0); }\n");
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'demo-mod.js'), '// someone else\n');
    t('enable refused: would overwrite a tool it did not place', /already exists/.test(run('enable', 'demo', '--by', 'owner').out));
    fs.rmSync(path.join(tmp, 'company', 'tools', 'demo-mod.js'));
    r = run('enable', 'demo', '--by', 'Alex');
    t('enable ok by the owner (by name): conformant', r.code === 0 && r.j.status === 'conformant', r.out);
    t('enable: tool copied flat into company/tools', fs.existsSync(path.join(tmp, 'company', 'tools', 'demo-mod.js')));
    t('enable: modules.json lists it', !!readJson(path.join(tmp, 'company', 'state', 'modules.json'), {}).enabled.demo);
    const le = readJson(path.join(tmp, 'company', 'state', 'locked-extra.json'), {});
    t('enable: meter locked (cls A, module tag) and tick.js registered', (le.entries || []).some(e => e.p === 'company/work/demo/log.jsonl' && e.cls === 'A' && e.module === 'demo') && le.entries.some(e => e.p === 'modules/demo/tick.js'), le);
    try {
      const lw = require('./locked-watch.js'); const ctx = lw.context({ root: tmp, home: tmp, underStation: false, ownerShell: false });
      t('locked-watch reads locked-extra.json into its manifest, and watches the registries', ctx.manifest.some(e => e.p === 'company/work/demo/log.jsonl' && e.cls === 'A') && ['company/state/locked-extra.json', 'company/state/modules.json', 'company/state/packs.json'].every(p => ctx.manifest.some(e => e.p === p && e.cls === 'F')));
    } catch (e) { t('locked-watch context loads', false, e.message); }
    const loc = parseRows(fs.readFileSync(path.join(tmp, 'company', 'state', 'inventory-local.md'), 'utf8'));
    t('enable: INVENTORY, §5a and §7b rows written to company/state/inventory-local.md', loc.INVENTORY.some(l => /\| `company\/tools\/demo-mod\.js` \| .*\(module demo\)/.test(l)) && loc['5a'].some(l => /^\| company\/tools\/demo-mod\.js \| tools \|/.test(l)) && loc['7b'].includes('| `company/tools/demo-mod.js` | tools | `node company/tools/demo-mod.js --selftest` |'), loc);
    t('enable: tracked INVENTORY.md and runbook untouched (git status clean)', trackedClean() && !/demo-mod/.test(fs.readFileSync(path.join(tmp, 'company', 'tools', 'INVENTORY.md'), 'utf8') + fs.readFileSync(path.join(tmp, 'company', 'runbooks', 'tool-management.md'), 'utf8')));
    // an instance enabled by an older module.js: rows in the tracked files, hidden with skip-worktree, none in the local file
    {
      const invF = path.join(tmp, 'company', 'tools', 'INVENTORY.md'), rbF = path.join(tmp, 'company', 'runbooks', 'tool-management.md'), locF = path.join(tmp, 'company', 'state', 'inventory-local.md');
      const keep = fs.readFileSync(locF, 'utf8');
      const ins = (f, re, row) => { const ls = fs.readFileSync(f, 'utf8').split('\n'); let i = ls.findIndex(l => re.test(l)); while (!/^\|/.test(ls[i])) i++; while (/^\|/.test(ls[i])) i++; ls.splice(i, 0, row); fs.writeFileSync(f, ls.join('\n')); };
      ins(invF, /^\| tool \| purpose/, loc.INVENTORY[0]); ins(rbF, /^### 5a\b/, loc['5a'][0]); ins(rbF, /^### 7b\b/, loc['7b'][0]);
      fs.rmSync(locF); g('update-index', '--skip-worktree', '--', 'company/tools/INVENTORY.md', 'company/runbooks/tool-management.md');
      r = run('migrate-rows', '--check');
      t('migrate-rows --check: legacy module rows in tracked files -> exit 1, nothing changed', r.code === 1 && r.j.moved === 3 && !fs.existsSync(locF), r.out);
      r = run('migrate-rows');
      const l2 = parseRows(fs.readFileSync(locF, 'utf8'));
      t('migrate-rows: rows moved to the local file by section, tracked files back to HEAD and no longer skip-worktree', r.code === 0 && r.j.restored.length === 2 && trackedClean() && l2.INVENTORY.length === 1 && l2['5a'].length === 1 && l2['7b'].length === 1, r.out);
      t('migrate-rows: a second run moves nothing', run('migrate-rows').j.moved === 0 && run('migrate-rows', '--check').code === 0);
      fs.writeFileSync(locF, keep);
    }
    t('enable: owner told', /Core module demo/.test(fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8')));
    const tk2 = js("require('./company/tools/lib/modules').runTicks({log:console.log}).then(r=>console.log(JSON.stringify(r)))");
    t('tick hook runs the enabled module', fs.existsSync(path.join(md, 'ticked')) && /DEMO TICK/.test(tk2.stdout), tk2.stdout + tk2.stderr);
    fs.rmSync(path.join(md, 'ticked'));
    js("require('./company/tools/lib/modules').runTicks({log:console.log, halted:'soft'})");
    t('a halted company skips a module without runWhenHalted', !fs.existsSync(path.join(md, 'ticked')));
    const hr = js("const r=require('./company/tools/lib/modules').httpRoutes(); const m=r[0]; const x='ping/kim'.match(m.re); console.log(JSON.stringify({n:r.length,auth:m.auth,who:x&&x[1]}))");
    t('http routes: one owner route with a :param', /"n":1,"auth":"owner","who":"kim"/.test(hr.stdout), hr.stdout + hr.stderr);
    t('enable: opened-limits folder registered (class F, writer module.js)', ((readJson(path.join(tmp, 'company', 'state', 'locked-extra.json'), {}).entries) || []).some(e => e.p === 'company/state/modules/demo/limits/**' && e.cls === 'F' && e.writers.includes('module.js')));
    t('limits set refused for an agent', run('limits', 'demo', 'set', 'limits.json', 'perDay', '3', '--by', 'Sam').code === 1);
    t('limits set refuses a key that is not a shipped number', run('limits', 'demo', 'set', 'limits.json', 'enabled', '1', '--by', 'owner').code === 1);
    r = run('limits', 'demo', 'set', 'limits.json', 'perDay', '3', '--by', 'owner');
    t('limits set by the owner writes the opened copy; the shipped copy stays closed', r.code === 0 && readJson(path.join(tmp, 'company', 'state', 'modules', 'demo', 'limits', 'limits.json'), {}).perDay === 3 && readJson(path.join(md, 'limits', 'limits.json'), {}).perDay === 0, r.out);
    const lf = js("console.log(require('./company/tools/lib/modules').limitsFile('demo','limits/limits.json'))");
    t('limitsFile resolves the opened copy first', /company\/state\/modules\/demo\/limits\/limits\.json/.test(lf.stdout), lf.stdout);
    r = run('doctor', '--all');
    t('doctor --all exit 0 with demo conformant', r.code === 0 && r.j.modules[0].status === 'conformant', r.out);
    fs.appendFileSync(path.join(tmp, 'company', 'tools', 'demo-mod.js'), '// tampered\n');
    r = run('doctor', 'demo');
    t('tampered tool: doctor exit 1', r.code === 1 && /changed since enable/.test(r.out), r.out);
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'demo-mod.js'), fs.readFileSync(path.join(md, 'tools', 'demo-mod.js')));
    // a module that requires demo; disable demo refused while it is enabled
    const m2 = mk('modules', 'dep'); mk('modules', 'dep', 'conformance');
    fs.writeFileSync(path.join(m2, 'module.json'), JSON.stringify(Object.assign({}, mj, { id: 'dep', title: 'Dep', tools: [], meters: [], limits: [], order: 1, requires: { modules: ['demo'] } })));
    fs.writeFileSync(path.join(m2, 'README.md'), '# Dep\n');
    fs.copyFileSync(path.join(md, 'conformance', 'test.js'), path.join(m2, 'conformance', 'test.js'));
    t('enable dep (requires demo, enabled) ok', run('enable', 'dep', '--by', 'owner').code === 0);
    const to = js("console.log(JSON.stringify(require('./company/tools/lib/modules').tickOrder()))");
    t('ticks run by module.json order (dep order 1 before demo order 5)', to.stdout.trim() === '["dep","demo"]', to.stdout);
    t('disable demo refused while dep requires it', /required by module dep/.test(run('disable', 'demo', '--by', 'owner').out));
    t('disable dep ok', run('disable', 'dep', '--by', 'owner').code === 0);
    r = run('disable', 'demo', '--by', 'owner');
    t('disable demo ok', r.code === 0, r.out);
    t('disable: tool, rows and registrations gone; meter kept', !fs.existsSync(path.join(tmp, 'company', 'tools', 'demo-mod.js'))
      && !/demo-mod\.js/.test(fs.readFileSync(path.join(tmp, 'company', 'state', 'inventory-local.md'), 'utf8'))
      && !((readJson(path.join(tmp, 'company', 'state', 'locked-extra.json'), {}).entries || []).some(e => e.module === 'demo'))
      && fs.existsSync(path.join(tmp, 'company', 'work', 'demo', 'log.jsonl')));
    t('tracked runbook byte-for-byte unchanged after enable+disable', trackedClean() && fs.readFileSync(path.join(tmp, 'company', 'runbooks', 'tool-management.md'), 'utf8') === fs.readFileSync(path.join(here, 'company', 'runbooks', 'tool-management.md'), 'utf8'));
    t('enable dep refused while demo is disabled', /requires\.modules: demo/.test(run('enable', 'dep', '--by', 'owner').out));
    for (const id of (fs.existsSync(path.join(here, 'modules')) ? fs.readdirSync(path.join(here, 'modules')) : []).filter(x => ID_RE.test(x))) {
      const sc = checkStatic(path.join(here, 'modules', id));
      if (sc.mod) console.log('info repo module ' + id + ': ' + (sc.findings.length ? sc.findings.length + ' static finding(s): ' + sc.findings.slice(0, 3).join('; ') : 'static clean'));
    }
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { status, doctor, list, gates, checkStatic, moduleSchema, LAYERS };
if (require.main !== module) return;

const A = (() => { const o = { _: [] }; const a = process.argv.slice(2); for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[++i] : true; } else o._.push(a[i]); } return o; })();
const cmd = A._[0];
const emit = res => {
  if (A.json || !res.out.modules) console.log(JSON.stringify(res.out, null, 1));
  else for (const m of res.out.modules) { console.log(m.status.toUpperCase().padEnd(11) + ' ' + m.id + (m.enabled ? '  (enabled)' : '')); for (const f of m.findings || []) console.log('    ' + f); }
  process.exit(res.code);
};
if (cmd === 'selftest' || A.selftest) process.exit(selftest());
if (cmd === 'list') { const rows = list(); if (A.json) console.log(JSON.stringify(rows, null, 1)); else { if (!rows.length) console.log('no modules'); for (const x of rows) console.log((x.enabled ? 'enabled ' : 'off     ') + ' ' + x.id.padEnd(14) + ' ' + String(x.layer || '').padEnd(10) + ' ' + (x.title || '')); } process.exit(0); }
if (cmd === 'status') { if (!A._[1]) { console.error('status <id>'); process.exit(2); } const s = status(A._[1]); if (A.json) console.log(JSON.stringify(s, null, 1)); else { console.log(s.status); for (const f of s.findings || []) console.log('  ' + f); } process.exit(0); }
if (cmd === 'doctor') emit(doctor(A.all ? true : A._[1] || true));
if (cmd === 'enable') emit(cmdEnable(A._[1], A.by));
if (cmd === 'disable') emit(cmdDisable(A._[1], A.by));
if (cmd === 'limits') emit(cmdLimits(A._[1], A._[2], A._[3], A._[4], A._[5], A.by));
if (cmd === 'migrate-rows') emit(migrateRows(!!A.check));
if (cmd === 'gates') { const g = gates(); console.log(JSON.stringify(A.json ? g : { ok: true, gates: g }, null, 1)); process.exit(0); }
console.error('usage: module.js list | status <id> | doctor [<id>|--all] | enable|disable <id> --by <owner> | limits <id> [set <file> <key> <n> --by owner] | gates | migrate-rows [--check] | selftest   [--json]');
process.exit(2);
