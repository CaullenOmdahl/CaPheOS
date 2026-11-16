#!/usr/bin/env node
/* Conformance test for a pack. Fails, saying what is missing, until the pack's contract (README.md) is met.
 * The template fails this test by design. A filled pack extends it with its own checks; it never loosens these.
 * Env (set by company/tools/pack.js doctor): PACK_DIR (the pack folder), PACK_ROOT (company root),
 * PACK_INSTALLED (1|0), PACK_TOOLS_DIR (where install copied the tools). Offline; exit 0 = conformant. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dir = path.resolve(process.env.PACK_DIR || path.join(__dirname, '..'));
const installed = process.env.PACK_INSTALLED === '1';
const toolsDir = process.env.PACK_TOOLS_DIR || '';
const missing = [];
const read = f => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return null; } };
let pack = null;
try { pack = JSON.parse(read('pack.json')); } catch (e) { missing.push('pack.json: unreadable (' + e.message + ')'); }
if (pack) {
  const id = path.basename(dir);
  if (pack.template === true) missing.push('pack.json: template is true (remove it once the pack is filled)');
  if (String(pack.id).startsWith('_')) missing.push('pack.json: id ' + pack.id + ' is a template id; give the pack its own id');
  if (pack.id !== id && !installed) missing.push('pack.json: id ' + pack.id + ' does not equal the folder name ' + id);
  if (/TODO/.test(read('pack.json') || '')) missing.push('pack.json: still has TODO');
  if (/TODO/.test(read('README.md') || 'TODO')) missing.push('README.md: the contract still has TODO (or the file is missing)');
  for (const d of pack.docs || []) { const t = read(d); if (t == null) missing.push('docs: ' + d + ' is listed but missing'); else if (/TODO/.test(t)) missing.push('docs: ' + d + ' still has TODO'); }
  const tools = pack.tools || [];
  if (!tools.length) missing.push('tools: none listed in pack.json (a pack with no tool adds no capability)');
  const listed = new Set(tools.map(t => path.normalize(t.file)));
  let present = []; try { present = fs.readdirSync(path.join(dir, 'tools')).map(f => path.normalize('tools/' + f)); } catch (_) {}
  for (const f of present) if (!listed.has(f) && f !== path.normalize('tools/README.md')) missing.push('tools: ' + f + ' is not listed in pack.json');
  for (const t of tools) {
    const src = path.join(dir, t.file);
    if (!fs.existsSync(src)) { missing.push('tools: ' + t.file + ' is listed but missing'); continue; }
    if (installed && toolsDir && !fs.existsSync(path.join(toolsDir, path.basename(t.file)))) missing.push('tools: ' + t.file + ' is not in ' + toolsDir + ' (install did not copy it)');
    if (/\.js$/.test(t.file)) {
      const r = spawnSync(process.execPath, [installed && toolsDir ? path.join(toolsDir, path.basename(t.file)) : src, '--selftest'], { encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) missing.push('tools: ' + t.file + ' --selftest exited ' + r.status + ' ' + String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0]);
    }
  }
  if (!(pack.limits || []).length) missing.push('limits: none listed');
  for (const l of pack.limits || []) { try { JSON.parse(read(l.file)); } catch (_) { missing.push('limits: ' + l.file + ' missing or not JSON'); } }
  if (!(pack.meters || []).length) missing.push('meters: none declared (a pack nobody can measure is not a capability)');
}
if (missing.length) {
  console.log('NOT CONFORMANT (' + missing.length + ' missing):');
  for (const m of missing) console.log('  MISSING ' + m);
  process.exit(1);
}
console.log('CONFORMANT');
