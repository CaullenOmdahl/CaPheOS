#!/usr/bin/env node
'use strict';
/* unit.js — format-2 units (docs/MODULE-SYSTEM.md) on the current stack.
 *
 * A unit is the package the new backend will load natively (module.json + its files). Building skills and other
 * capabilities as units now means they carry over to the rebuild unchanged. On the current stack a unit may provide
 * skills (provides.skills); other contributions wait for the new backend and are refused by `check` with that reason.
 *
 *   node company/tools/unit.js list [--json]
 *   node company/tools/unit.js check <dir> [--json]          the manifest, its files, no company's own words (exit 0 ok, 1 not)
 *   node company/tools/unit.js install <dir> --by owner       check, copy to company/state/units/<id>/<version>/, record it
 *   node company/tools/unit.js enable <id> --by owner         its skills join the company's (skills.js pushes them to the seats)
 *   node company/tools/unit.js disable <id> --by owner        its skills leave the company's list (installed copy kept)
 *   tests: company/tools/tests/unit-system.test.js
 *
 * Sources live in packs/<id>/ in the framework (the authoring location); installed copies are immutable per version.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const U = require('./lib/units');

// only the owner installs, enables or disables a unit (crew proposals arrive with the governance phase)
function ownerOnly(by, what) {
  try {
    const own = require('./lib/owner');
    if (!own.isOwnerName(by)) return 'only the owner ' + what + ' (--by owner)';
    return own.refusal(by, what);
  } catch (_) { return 'the owner check could not run'; }
}
function leakFindings(dir) {
  try {
    const L = require(path.join(__dirname, '..', '..', 'scripts', 'check-deployment-leaks.js'));
    const W = L.words(); const re = L.matcher(W.words); if (!re) return [];
    const items = [];
    for (const rel of U.walk(dir, dir, [])) { let s = ''; try { s = fs.readFileSync(path.join(dir, rel), 'utf8'); } catch (_) { continue; } s.split('\n').forEach((t, i) => items.push({ file: rel, line: i + 1, text: t })); }
    return L.scanLines(items, re, W.words).map(h => h.file + ':' + h.line + ' carries a ' + h.kind + ' (a unit may not name its company)');
  } catch (_) { return []; }
}
function checkDir(dir) {
  const c = U.check(dir);
  const leaks = c.manifest ? leakFindings(dir) : [];
  return { ok: c.ok && !leaks.length, manifest: c.manifest, findings: c.findings.concat(leaks) };
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const rel of U.walk(src, src, [])) { const t = path.join(dst, rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(path.join(src, rel), t); }
}
function pushSkills(names) {
  const res = [];
  for (const n of names) {
    try { execFileSync(process.execPath, [path.join(__dirname, 'skills.js'), 'install', n, '--agents', 'all'], { cwd: co.ROOT, stdio: 'ignore', timeout: 120000 }); res.push(n + ': pushed to the seats'); }
    catch (_) { res.push(n + ': not pushed now (skills.js install ' + n + ' --agents all)'); }
  }
  return res;
}

// the phase 0.5 Cordis host, in its own process (an ES module with the runtime's one dependency)
function hostSync(root) {
  const host = path.join(__dirname, '..', '..', 'runtime', 'src', 'compat-host.mjs');
  if (!fs.existsSync(path.join(__dirname, '..', '..', 'runtime', 'node_modules', 'cordis'))) return { ok: false, out: 'the runtime is not installed: run scripts/setup-station.sh (it runs npm ci in runtime/)' };
  try { return { ok: true, out: String(execFileSync(process.execPath, [host, 'sync', '--root', root], { cwd: root, encoding: 'utf8', timeout: 120000 })).trim() }; }
  catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message).trim().slice(0, 600) }; }
}
function cmd(argv, o) {
  o = o || {};
  const a = argv[0], by = (() => { const i = argv.indexOf('--by'); return i > 0 ? argv[i + 1] : null; })();
  const root = o.root || co.ROOT;
  if (a === 'list') {
    const reg = U.registry(root);
    return { code: 0, out: { ok: true, units: Object.entries(reg.units).map(([id, u]) => ({ id, version: u.version, state: u.state, digest: u.digest })) } };
  }
  if (a === 'check') {
    const dir = path.resolve(argv[1] || '.'); const c = checkDir(dir);
    return { code: c.ok ? 0 : 1, out: { ok: c.ok, id: c.manifest && c.manifest.id, findings: c.findings } };
  }
  if (a === 'install') {
    const e = ownerOnly(by, 'installs a unit'); if (e) return { code: 3, out: { ok: false, error: e } };
    const dir = path.resolve(argv[1] || ''); const c = checkDir(dir);
    if (!c.ok) return { code: 1, out: { ok: false, error: 'the unit does not pass its check', findings: c.findings } };
    const m = c.manifest, dest = U.installedDir(m.id, m.version, root);
    const reg = U.registry(root), had = reg.units[m.id];
    if (fs.existsSync(dest)) {
      if (U.digest(dest) !== U.digest(dir)) return { code: 1, out: { ok: false, error: m.id + ' ' + m.version + ' is already installed with different files: raise the version' } };
    } else copyDir(dir, dest);
    reg.units[m.id] = { version: m.version, digest: U.digest(dest), state: had && had.state === 'enabled' ? 'enabled' : 'installed', source: path.relative(root, dir) || dir, installedAt: new Date().toISOString(), by: String(by) };
    U.saveRegistry(reg, root);
    return { code: 0, out: { ok: true, id: m.id, version: m.version, state: reg.units[m.id].state } };
  }
  if (a === 'enable' || a === 'disable') {
    const e = ownerOnly(by, a + 's a unit'); if (e) return { code: 3, out: { ok: false, error: e } };
    const id = argv[1]; const reg = U.registry(root); const u = reg.units[id];
    if (!u) return { code: 1, out: { ok: false, error: 'no installed unit ' + id + ' (unit.js install <dir> --by owner first)' } };
    const dir = U.installedDir(id, u.version, root);
    if (U.digest(dir) !== u.digest) return { code: 1, out: { ok: false, error: 'the installed copy of ' + id + ' changed since install: reinstall it' } };
    u.state = a === 'enable' ? 'enabled' : 'installed'; if (a === 'enable') u.enabledAt = new Date().toISOString();
    U.saveRegistry(reg, root);
    // run the enabled units' Cordis plugins (runtime/src/compat-host.mjs): their skills land in company/state/unit-skills/
    const host = hostSync(root);
    const names = U.enabledSkills(root).filter(s => s.unit === id).map(s => s.name);
    const pushed = a === 'enable' && !o.noPush ? pushSkills(names) : [];
    return { code: host.ok ? 0 : 1, out: { ok: host.ok, id, state: u.state, skills: names, pushed, host: host.out } };
  }
  return { code: 2, out: { ok: false, error: 'usage: unit.js list | check <dir> | install <dir> --by owner | enable <id> --by owner | disable <id> --by owner' } };
}

module.exports = { cmd, checkDir };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const r = cmd(argv);
  if (argv.includes('--json') || r.code !== 0) console.log(JSON.stringify(r.out, null, 1));
  else if (argv[0] === 'list') console.log(r.out.units.length ? r.out.units.map(u => u.id + ' ' + u.version + ' ' + u.state).join('\n') : 'no units installed');
  else console.log(JSON.stringify(r.out));
  process.exit(r.code);
}
