#!/usr/bin/env node
/* Conformance test for the reach module. Mirrors the standard CaPheOS core-module contract: manifest complete,
 * docs without TODO, every tool listed and passing --selftest, limits shipped closed, and byte-identical installed
 * copy when enabled. Offline. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const env = k => process.env['MODULE_' + k] || process.env['PACK_' + k] || '';
const dir = path.resolve(env('DIR') || path.join(__dirname, '..'));
const root = path.resolve(env('ROOT') || path.join(dir, '..', '..'));
const installedDir = path.join(root, 'company', 'tools');
const flag = process.env.MODULE_ENABLED || process.env.PACK_INSTALLED || '';
const enabled = flag ? flag === '1' : (() => { try { return !!JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'modules.json'), 'utf8')).enabled[path.basename(dir)]; } catch (_) { return false; } })();
const missing = [];
const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
let m = null;
try { m = JSON.parse(read('module.json')); } catch (e) { missing.push('module.json: unreadable (' + e.message + ')'); }
const closed = (v, at, out) => {
  if (typeof v === 'number') { if (v !== 0) out.push(at + ' = ' + v); }
  else if (typeof v === 'boolean') out.push(at + ' is a boolean');
  else if (Array.isArray(v)) { if (v.length) out.push(at + ' has entries'); }
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) if (!k.startsWith('_')) closed(v[k], at + '.' + k, out);
  return out;
};
if (m) {
  if (m.id !== path.basename(dir)) missing.push('module.json: id ' + m.id + ' does not equal the folder name');
  for (const k of ['layer', 'enableWhen', 'title', 'summary', 'owner']) if (!m[k]) missing.push('module.json: ' + k + ' required');
  for (const d of m.docs || []) { const t = read(d); if (t == null) missing.push('docs: ' + d + ' listed but missing'); else if (/TODO/.test(t)) missing.push('docs: ' + d + ' still has TODO'); }
  if (!(m.tools || []).length) missing.push('tools: none listed');
  const listed = new Set((m.tools || []).map(t => path.normalize(t.file)));
  let present = []; try { present = fs.readdirSync(path.join(dir, 'tools')).map(f => path.normalize('tools/' + f)); } catch (_) {}
  for (const f of present) if (!listed.has(f) && f !== path.normalize('tools/README.md')) missing.push('tools: ' + f + ' is not listed in module.json');
  for (const l of m.limits || []) { let v; try { v = JSON.parse(read(l.file)); } catch (_) { missing.push('limits: ' + l.file + ' missing or not JSON'); continue; } const o = closed(v, l.file, []); if (o.length) missing.push('limits: must ship CLOSED: ' + o.join('; ')); }
  if (!(m.limits || []).length) missing.push('limits: none listed');
  for (const t of m.tools || []) {
    const src = path.join(dir, t.file);
    if (!fs.existsSync(src)) { missing.push('tools: ' + t.file + ' listed but missing'); continue; }
    let run = src;
    if (enabled) {
      const inst = path.join(installedDir, path.basename(t.file));
      if (!fs.existsSync(inst)) { missing.push('tools: company/tools/' + path.basename(t.file) + ' missing although the module is enabled'); continue; }
      if (!fs.readFileSync(inst).equals(fs.readFileSync(src))) missing.push('tools: company/tools/' + path.basename(t.file) + ' differs from the module copy');
      run = inst;
    }
    const r = spawnSync(process.execPath, [run, '--selftest'], { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { MODKIT_SELFTEST_INNER: '' }) });
    if (r.status !== 0) missing.push('tools: ' + path.basename(t.file) + ' --selftest exited ' + r.status + ' ' + String(r.stdout || r.stderr || '').trim().split('\n').filter(l => /FAIL/.test(l)).slice(0, 3).join(' | '));
  }
}
if (missing.length) { console.log('NOT CONFORMANT (' + missing.length + ' missing):'); for (const x of missing) console.log('  MISSING ' + x); process.exit(1); }
console.log('CONFORMANT');
