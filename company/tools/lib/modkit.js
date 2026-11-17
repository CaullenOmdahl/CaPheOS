'use strict';
/* modkit.js — small helpers shared by the core-module tools (intake, observe, parties, commitments, playbooks).
 *
 * Module tools are ABSENT until their module is enabled (docs/CORE-MODULES.md, docs/PACKS-SPEC.md §1): they live in
 * modules/<id>/tools/ and module.js copies them into company/tools/ on enable. This file is the always-present plumbing
 * they share, so a tool behaves the same whether it runs from its module folder (a seat filling it, a selftest) or from
 * company/tools/ (enabled).
 *
 *   const kit = require('./lib/modkit')
 *   kit.lib()                    the company/tools/lib folder (for requires from a module folder)
 *   kit.tool(name)               require an ENABLED sibling tool (company/tools/<name>.js) or null; in a selftest
 *                                (env CAPHEOS_MODKIT_SOURCE=1) a module source copy is used too
 *   kit.limits(id, file?)        the module's limits: company/state/modules/<id>/limits/<file> (the owner's opened copy,
 *                                changed only through harness-change.js kind policy), else the shipped modules/<id>/limits/
 *                                copy (closed), else {} (missing/unreadable = CLOSED)
 *   kit.limit(id, key)           one number from them; anything but a positive number reads as 0 (closed)
 *   kit.enabled(id)              is the module listed as enabled in company/state/modules.json
 *   kit.readJsonl / appendJsonl / writeJson (atomic) / newId(prefix) / dget(obj, 'a.b.0') / iso(x)
 *   kit.appendHandoff(seatId, heading, fields, from)   a HANDOFFS.md block in that seat's inbox; returns the inbox or null
 *   kit.selftestRoot(name)       a temp company root with a one-seat loops.json and default guardrails
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const co = require('./company');

const LIB = __dirname;
const TOOLS = path.join(LIB, '..');
const SRC_MODULES = path.join(TOOLS, '..', '..', 'modules');
const MOD_OF = { intake: 'intake', observe: 'observe', parties: 'parties', commitments: 'commitments', playbooks: 'playbooks' };

function lib() { return LIB; }
function tool(name) {
  const cands = [path.join(TOOLS, name + '.js')];
  if (process.env.CAPHEOS_MODKIT_SOURCE === '1') cands.push(path.join(SRC_MODULES, MOD_OF[name] || name, 'tools', name + '.js'));
  for (const f of cands) if (fs.existsSync(f)) { try { return require(f); } catch (_) { return null; } }
  return null;
}

function readJsonl(file) {
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = []; for (const l of t.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r._retention) continue; out.push(r); } catch (_) {} }   // _retention: a retention roll's pointer row
  return out;
}
function appendJsonl(file, row) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(row) + '\n'); return row; }
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(t, file);
}
function newId(prefix) { return prefix + '-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) + '-' + crypto.randomBytes(3).toString('hex'); }
function dget(o, p) {
  if (!p) return o;
  let v = o; for (const k of String(p).split('.')) { if (v == null) return undefined; v = k === 'length' && Array.isArray(v) ? v.length : v[k]; }
  return v;
}
function iso(x) { const d = x instanceof Date ? x : new Date(x); return isNaN(d) ? null : d.toISOString(); }

/* company/state/modules.json { enabled: { <id>: {...} } } is written only by module.js (lib/modules.js reads it too). */
function enabled(id) { const m = co.readJson(co.p('company', 'state', 'modules.json'), null); return !!(m && m.enabled && m.enabled[id]); }

/* Limits ship CLOSED. Missing or unreadable = {} = closed. */
function limits(id, file) {
  file = file || 'limits.json';
  // the owner's opened copy (company/state/modules/<id>/limits/), else the shipped (closed) one in modules/<id>/limits/
  for (const d of [co.p('company', 'state', 'modules', id, 'limits'), co.p('modules', id, 'limits')]) {
    const v = co.readJson(path.join(d, file), undefined);
    if (v && typeof v === 'object') return v;
  }
  return {};
}
function limit(id, key, file) { const v = dget(limits(id, file), key); return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0; }

function stamp(d) { const l = co.localParts(d); return l.date + ' ' + l.time; }
function appendHandoff(seatId, heading, fields, from) {
  const seat = co.crew()[seatId];
  const inbox = seat && seat.inbox;
  if (!inbox || /[\/\\]|\.\./.test(inbox)) return null;
  const f = co.p('company', 'work', 'handoffs', inbox);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const block = '\n## ' + co.localParts().date + ' from ' + (from || 'Dispatcher') + ' — ' + heading + '\n' +
    Object.entries(Object.assign({ Status: 'OPEN' }, fields)).sort(([a], [b]) => (a === 'Status') - (b === 'Status'))
      .map(([k, v]) => '**' + k + ':** ' + (v instanceof Date ? stamp(v) : v)).join('\n') + '\n';
  fs.appendFileSync(f, block);
  return inbox;
}

function selftestRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name + '-selftest-'));
  const loops = { agents: {
    ceo1: { name: 'Alex', functions: ['ceo', 'people', 'risk', 'floor', 'finance'], inbox: 'to-alex.md', manager: null },
    lead1: { name: 'Sam', functions: ['tools'], inbox: 'to-sam.md', manager: 'ceo1' },
    ops1: { name: 'Kim', functions: [], inbox: 'to-kim.md', manager: 'lead1' } } };
  fs.mkdirSync(path.join(root, 'company', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'tools', 'loops.json'), JSON.stringify(loops));
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', timezone: 'UTC', owner: { name: 'Owner' } }));
  return root;
}
/* Write a module's opened limits into a (temp) root, for selftests. */
function setLimits(root, id, v, file) {
  const d = path.join(root, 'company', 'state', 'modules', id, 'limits');
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, file || 'limits.json'), JSON.stringify(v));
}
/* Run this file's selftest body in a child with CAPHEOS_ROOT pointed at a temp root (co.ROOT is fixed at require). */
function runSelftest(file, name, body) {
  if (process.env.MODKIT_SELFTEST_INNER === '1') {
    let fails = 0;
    const ok = (label, cond, extra) => { if (cond) console.log('  ok   ' + label); else { fails++; console.log('  FAIL ' + label + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); } };
    return Promise.resolve().then(() => body(ok)).then(() => { console.log(fails ? '\nSELFTEST FAILED (' + fails + ')' : '\nSELFTEST PASSED'); process.exit(fails ? 1 : 0); },
      e => { console.log('  FAIL threw ' + (e && e.stack || e)); process.exit(1); });
  }
  const root = selftestRoot(name);
  const r = require('child_process').spawnSync(process.execPath, [file, '--selftest'], { stdio: 'inherit',
    env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, MODKIT_SELFTEST_INNER: '1', CAPHEOS_MODKIT_SOURCE: '1', STARNET_URL: 'http://127.0.0.1:1' }) });
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(r.status == null ? 1 : r.status);
}

/* argv -> { _: positionals, <flag>: value | true }. Flags in `bools` take no value. */
function args(argv, bools) {
  const o = { _: [] }; const B = new Set(['json', 'dry', 'dry-run', 'selftest', 'all'].concat(bools || []));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (B.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) o[k] = true; else o[k] = argv[++i]; }
    else o._.push(a);
  }
  return o;
}

module.exports = { args, lib, tool, readJsonl, appendJsonl, writeJson, newId, dget, iso, enabled, limits, limit, appendHandoff,
  selftestRoot, setLimits, runSelftest, stamp };
