#!/usr/bin/env node
/* Conformance test for this core module (same file in scopes, verify, evidence, reports, ledger). Exit 0 only when:
 * module.json has its fields; README has no TODO; every listed tool exists, passes `node --check` and its --selftest;
 * nothing unlisted sits in tools/; the shipped limits are CLOSED (numbers 0, lists empty, strings empty, no booleans);
 * tick.js (if any) loads and exports tick(); each panel has a panel.json; and, when enabled, each tool in company/tools/
 * is byte-identical to the module's copy. Env (module.js / pack.js): MODULE_DIR|PACK_DIR, MODULE_ROOT|PACK_ROOT,
 * MODULE_ENABLED|PACK_INSTALLED (1|0), MODULE_TOOLS_DIR|PACK_TOOLS_DIR. Offline. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const env = k => process.env['MODULE_' + k] || process.env['PACK_' + k] || '';
const dir = path.resolve(env('DIR') || path.join(__dirname, '..'));
const enabled = (process.env.MODULE_ENABLED || process.env.PACK_INSTALLED) === '1';
const toolsDir = env('TOOLS_DIR');
const missing = [];
const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
const closed = (v, at, out) => {
  if (typeof v === 'number') { if (v !== 0) out.push(at + ' = ' + v); }
  else if (typeof v === 'string') { if (v !== '') out.push(at + ' = "' + v + '" (a closed string limit is empty)'); }
  else if (typeof v === 'boolean') out.push(at + ' is a boolean');
  else if (Array.isArray(v)) { if (v.length) out.push(at + ' has entries'); }
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) if (!k.startsWith('_')) closed(v[k], at + '.' + k, out);
  return out;
};
let m = null;
try { m = JSON.parse(read('module.json')); } catch (e) { missing.push('module.json: unreadable (' + e.message + ')'); }
if (m) {
  if (m.id !== path.basename(dir) && !enabled) missing.push('module.json: id ' + m.id + ' does not equal the folder name');
  for (const k of ['layer', 'enableWhen', 'title', 'summary', 'owner']) if (!m[k]) missing.push('module.json: ' + k + ' required');
  const rd = read('README.md'); if (rd == null || /TODO/.test(rd)) missing.push('README.md: missing or has TODO');
  const listed = new Set((m.tools || []).map(t => path.posix.normalize(t.file)));
  if (!listed.size) missing.push('tools: none listed');
  let present = []; try { present = fs.readdirSync(path.join(dir, 'tools')).map(f => 'tools/' + f); } catch (_) {}
  for (const f of present) if (!listed.has(f) && f !== 'tools/README.md') missing.push('tools: ' + f + ' is not listed in module.json');
  for (const t of m.tools || []) {
    const src = path.join(dir, t.file);
    if (!fs.existsSync(src)) { missing.push('tools: ' + t.file + ' listed but missing'); continue; }
    const chk = spawnSync(process.execPath, ['--check', src], { encoding: 'utf8' }); if (chk.status !== 0) missing.push('tools: ' + t.file + ' fails node --check');
    const r = spawnSync(process.execPath, [src, '--selftest'], { encoding: 'utf8', timeout: 120000 });
    if (r.status !== 0) missing.push('tools: ' + t.file + ' --selftest exited ' + r.status + ': ' + String(r.stdout || '').split('\n').filter(l => /FAIL/.test(l)).slice(0, 3).join(' | '));
    if (enabled && toolsDir) { const inst = path.join(toolsDir, path.basename(t.file)); if (!fs.existsSync(inst) || !fs.readFileSync(inst).equals(fs.readFileSync(src))) missing.push('enabled: ' + inst + ' missing or not identical to ' + t.file); }
  }
  if (!(m.limits || []).length) missing.push('limits: none listed');
  for (const l of m.limits || []) { let v; try { v = JSON.parse(read(l.file)); } catch (_) { missing.push('limits: ' + l.file + ' missing or not JSON'); continue; } const o = closed(v, l.file, []); if (o.length) missing.push('limits: shipped open: ' + o.join('; ')); }
  if (fs.existsSync(path.join(dir, 'tick.js'))) { try { if (typeof require(path.join(dir, 'tick.js')).tick !== 'function') missing.push('tick.js: exports no tick()'); } catch (e) { missing.push('tick.js: does not load (' + e.message + ')'); } }
  for (const p of m.panels || []) { try { const pj = JSON.parse(read(path.posix.join(p, 'panel.json'))); if (pj.id !== path.basename(p)) missing.push('panels: ' + p + ' id differs'); } catch (_) { missing.push('panels: ' + p + '/panel.json missing or not JSON'); } }
}
if (missing.length) { console.log('NOT CONFORMANT (' + missing.length + ' missing):'); for (const x of missing) console.log('  MISSING ' + x); process.exit(1); }
console.log('CONFORMANT');
