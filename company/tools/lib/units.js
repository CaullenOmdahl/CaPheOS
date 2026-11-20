'use strict';
/* lib/units.js — format-2 units (docs/MODULE-SYSTEM.md) on the current stack: the manifest check, the store of installed
 * units and the skills enabled units provide. The unit is the shape the new backend loads natively; this file lets the
 * current stack install the same package unchanged, so what is built now carries over without a rewrite.
 *
 *   const U = require('./lib/units')
 *   U.check(dir)                 -> { ok, manifest, findings: [plain strings] }   the manifest and its files
 *   U.registry(root?)            -> { units: { <id>: { version, digest, state, source, installedAt, by, enabledAt? } } }
 *   U.installedDir(id, version)  -> company/state/units/<id>/<version>
 *   U.enabledSkills(root?)       -> [{ name, file, unit }]   every skill the enabled units provide (compat host output)
 *   U.digest(dir)                -> 'sha256:…' over every file (path + bytes), order-independent
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');

const KINDS = ['capability', 'workflow', 'seat', 'surface', 'stack'];
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REL_RE = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]{1,200}$/;
const SKILL_RE = /^[a-z][a-z0-9-]{1,63}$/;

const rootOf = r => path.resolve(r || co.ROOT);
const regFile = r => path.join(rootOf(r), 'company', 'state', 'units.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

function check(dir) {
  const findings = [];
  const mf = path.join(dir, 'module.json');
  const m = readJson(mf, null);
  if (!m || typeof m !== 'object') return { ok: false, manifest: null, findings: ['no readable module.json in ' + dir] };
  const need = (cond, msg) => { if (!cond) findings.push(msg); };
  need(m.format === 2, 'format must be 2');
  need(typeof m.id === 'string' && ID_RE.test(m.id), 'id must be lowercase letters, digits and dashes (2 to 40)');
  need(m.id === path.basename(path.resolve(dir)), 'id must equal the folder name (' + path.basename(path.resolve(dir)) + ')');
  need(typeof m.version === 'string' && SEMVER_RE.test(m.version), 'version must be semver (1.0.0)');
  need(KINDS.includes(m.kind), 'kind must be one of ' + KINDS.join(', '));
  need(typeof m.title === 'string' && m.title.length >= 2 && m.title.length <= 80, 'title: 2 to 80 characters');
  need(typeof m.summary === 'string' && m.summary.length >= 3 && m.summary.length <= 600, 'summary: 3 to 600 characters');
  need(typeof m.license === 'string' && m.license.trim().length > 0, 'license is required (an SPDX id or "SEE LICENSE IN <file>")');
  need(m.engines && typeof m.engines === 'object' && typeof m.engines.caPheOS === 'string', 'engines.caPheOS is required');
  need(m.requires && typeof m.requires === 'object', 'requires is required ({} for none)');
  need(m.capabilities && typeof m.capabilities === 'object', 'capabilities is required ({} for none)');
  need(m.provides && typeof m.provides === 'object', 'provides is required');
  need(Array.isArray(m.docs) && m.docs.length > 0, 'docs: at least one file (README.md)');
  need(m.conformance && typeof m.conformance.test === 'string', 'conformance.test is required');
  const files = [].concat(Array.isArray(m.docs) ? m.docs : [], m.conformance && m.conformance.test ? [m.conformance.test] : []);
  // entry: the unit's Cordis plugin (an ES module exporting apply, inject, name), run by runtime/src/compat-host.mjs
  if (m.entry !== undefined) { if (typeof m.entry === 'string') files.push(m.entry); else findings.push('entry must be a relative path to the unit\'s Cordis plugin'); }
  const skills = (m.provides && Array.isArray(m.provides.skills)) ? m.provides.skills : [];
  for (const s of skills) {
    if (!s || !SKILL_RE.test(String(s.name || ''))) { findings.push('provides.skills: each skill needs a name (lowercase, dashes)'); continue; }
    const f = s.file || ('skills/' + s.name + '/SKILL.md');
    files.push(f);
    let txt = ''; try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    const fmName = (txt.match(/^name:\s*(\S+)\s*$/m) || [])[1];
    need(fmName === s.name, 'skill ' + s.name + ': its SKILL.md front matter must say name: ' + s.name);
    need(/^description:\s*\S/m.test(txt), 'skill ' + s.name + ': its SKILL.md needs a description line');
  }
  for (const k of ['tools', 'seats', 'workflows', 'surfaces', 'stacks', 'mcpServers']) {
    const list = m.provides && m.provides[k];
    if (Array.isArray(list) && list.length) findings.push('provides.' + k + ' is not supported on the current stack yet (skills only); ship it when the new backend loads it');
  }
  for (const f of files) {
    if (!REL_RE.test(String(f))) { findings.push('not a plain relative path: ' + f); continue; }
    need(fs.existsSync(path.join(dir, f)), 'listed file missing: ' + f);
  }
  return { ok: findings.length === 0, manifest: m, findings };
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const p = path.join(dir, e.name), rel = path.relative(base, p);
    if (e.isDirectory()) walk(p, base, out); else if (e.isFile()) out.push(rel);
  }
  return out;
}
function digest(dir) {
  const h = crypto.createHash('sha256');
  for (const rel of walk(dir, dir, [])) { h.update(rel + '\0'); h.update(fs.readFileSync(path.join(dir, rel))); h.update('\0'); }
  return 'sha256:' + h.digest('hex');
}
function registry(root) { const r = readJson(regFile(root), null); return r && typeof r === 'object' && r.units ? r : { units: {} }; }
function saveRegistry(reg, root) {
  const f = regFile(root); fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(reg, null, 1) + '\n'); fs.renameSync(tmp, f);
}
const installedDir = (id, version, root) => path.join(rootOf(root), 'company', 'state', 'units', id, version);

// the skills enabled units provide, as runtime/src/compat-host.mjs last wrote them (company/state/unit-skills/)
function enabledSkills(root) {
  const dir = path.join(rootOf(root), 'company', 'state', 'unit-skills');
  const index = readJson(path.join(dir, 'index.json'), {}) || {};
  const out = [];
  for (const [name, s] of Object.entries(index)) {
    const file = path.join(dir, name, 'SKILL.md');
    if (SKILL_RE.test(name) && fs.existsSync(file)) out.push({ name, file, unit: s && s.unit });
  }
  return out;
}

module.exports = { KINDS, check, digest, registry, saveRegistry, installedDir, enabledSkills, walk };
