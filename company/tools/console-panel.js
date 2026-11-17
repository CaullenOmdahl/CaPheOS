#!/usr/bin/env node
/* console-panel.js — company-made panels for the owner console: check them, install them, and resolve their data.
 *
 * A panel is a folder company/console/panels/<id>/ holding panel.json (company/schemas/console-panel.schema.json) and,
 * for a `custom` view, view.html. It may only read sources named in company/console/sources.json, only offer actions
 * that open an existing door (a handoff, a message to the CEO, a drafted owner message), and only live inside the
 * limits there. Full guide: docs/CONSOLE-PANELS.md. Skill: company/skills/console-panels/SKILL.md.
 *
 *   node company/tools/console-panel.js list [--json]
 *   node company/tools/console-panel.js validate <id|dir|panel.json>        # exit 1 on any finding (file:field: message)
 *   node company/tools/console-panel.js add <dir> --by <seat>               # validate, then install / notify / propose
 *   node company/tools/console-panel.js approve <id> --by owner             # install a proposed panel
 *   node company/tools/console-panel.js reject <id> --by owner [--note ..]  # drop a proposed panel
 *   node company/tools/console-panel.js remove <id> --by <seat>             # panel owner, tools, ceo or the owner
 *   node company/tools/console-panel.js hide <id> --by owner                # owner only; survives re-adds
 *   node company/tools/console-panel.js unhide <id> --by owner
 *   node company/tools/console-panel.js render <id> --json [--live]         # the data the console passes in
 *   node company/tools/console-panel.js scaffolds [--json]                  # ready pages: trading-desk, noc-health, ...
 *   node company/tools/console-panel.js scaffold <name> --as <id> --by <seat> [--nav <label>] [--force]
 *                                                                           # copy one into company/work/<seat>/pages/<id>/ (+ sample data)
 *   node company/tools/console-panel.js render --page <id|dir> --png <out.png> [--theme dark] [--width 390] [--height N]
 *   node company/tools/console-panel.js render --page <id|dir> --serve      # a local preview URL instead of a picture
 *   node company/tools/console-panel.js tokens [--write|--print]            # check (default) / regenerate docs/CONSOLE-DESIGN.md's token table
 *   node company/tools/console-panel.js selftest
 *
 * A folder holding page.json instead of panel.json is a PAGE: a company screen made of units (each a view kind with a
 * span on a 12-column grid). Pages share everything with panels: validation, the dashboard gate, add/approve/remove/
 * hide, owner, why, changes.jsonl and the 8-company-screen limit; they install into company/console/pages/<id>/.
 *
 * Why the gate: what the owner sees every morning is the owner's, so an agent's change to it goes through
 * co.gate('dashboard') like any other self-governed decision: auto installs, notify installs and tells the owner,
 * approve parks it in company/console/proposed/ with an owner question.
 * Why allowlists by id: a panel that could name a command or URL would be a back door to running anything; a panel that
 * names an id can only reach what the tools and risk owners already reviewed.
 * Why render is exported: the console backend calls the same resolver, so what an agent checks offline is exactly what
 * the owner will see.
 *
 * Module: require('./console-panel.js') -> { render, validatePanel, validateDir, listPanels, loadSources, gateFor,
 *   resolveFileSource, lintViewHtml, paths }. render(idOrDir, { live, root }) is async.
 * Env CONSOLE_ROOT overrides the project root (tests only): the console dir, file sources, tools and governance are then
 * read under it, so a test can never touch the real company.
 * Exit: 0 ok, 1 findings / refused, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const co = require('./lib/company');

const SCHEMA_FILE = path.join(__dirname, '..', 'schemas', 'console-panel.schema.json');
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];

function root() { return process.env.CONSOLE_ROOT ? path.resolve(process.env.CONSOLE_ROOT) : co.ROOT; }
function paths(r) {
  r = r || root();
  const c = path.join(r, 'company', 'console');
  return { root: r, console: c, panels: path.join(c, 'panels'), pages: path.join(c, 'pages'), proposed: path.join(c, 'proposed'),
    examples: path.join(c, 'examples'), scaffolds: path.join(c, 'scaffolds'), sources: path.join(c, 'sources.json'), changes: path.join(c, 'changes.jsonl'),
    state: path.join(c, 'state.json'), tools: path.join(r, 'company', 'tools'), loops: path.join(r, 'company', 'tools', 'loops.json') };
}
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
const rel = (f, r) => path.relative(r || root(), f) || '.';

function loadSources(r) {
  const s = readJson(paths(r).sources, null);
  if (!s) throw new Error('cannot read ' + rel(paths(r).sources, r));
  return s;
}

/* ---------- people ---------- */
function crew(r) {
  const P = paths(r);
  if (P.root === co.ROOT) return co.crew();
  return (readJson(P.loops, {}) || {}).agents || {};
}
function isOwner(by) {
  const b = String(by || '').trim().toLowerCase();
  const name = String((co.config.owner && co.config.owner.name) || '').toLowerCase();
  return b === 'owner' || b === 'commander' || (name && b === name);
}
/* A seat by id or display name (case-insensitive). Returns { id, seat } or null. */
function findSeat(who, r) {
  const c = crew(r); const w = String(who || '').trim().toLowerCase();
  if (!w) return null;
  for (const id of Object.keys(c)) if (id.toLowerCase() === w || String(c[id].name || '').toLowerCase() === w) return { id, seat: c[id] };
  return null;
}
function holdsFn(seat, fn) { return co.holds(seat, fn); }
function holderOf(fn, r) {
  const c = crew(r);
  const id = Object.keys(c).find(k => holdsFn(c[k], fn)) || Object.keys(c).find(k => holdsFn(c[k], 'ceo')) || Object.keys(c).find(k => c[k] && c[k].manager == null);
  return id ? { id, seat: c[id] } : null;
}
/* Does `by` answer for a panel owned by `owner` (a function or a seat)? */
function answersFor(by, owner, r) {
  const s = findSeat(by, r); if (!s) return false;
  if (FUNCTIONS.includes(owner)) return holdsFn(s.seat, owner);
  const o = findSeat(owner, r); return !!o && o.id === s.id;
}

/* ---------- governance ---------- */
function gateFor(category, r) {
  const P = paths(r);
  if (P.root === co.ROOT) return co.gate(category);
  const g = readJson(path.join(P.root, 'company', 'state', 'governance.json'), null)
    || readJson(path.join(P.root, 'company', 'defaults', 'state', 'governance.json'), {}) || {};
  if (g.fixed && g.fixed[category]) return 'approve';
  const v = g.categories && g.categories[category];
  return ['auto', 'notify', 'approve'].includes(v) ? v : 'approve';
}

/* ---------- a small JSON Schema (2020-12 subset) checker for our own schema ----------
 * Supports $ref (#/$defs/..), type, const, enum, required, properties, additionalProperties, propertyNames,
 * minProperties, maxProperties, items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum, oneOf, anyOf.
 * oneOf/anyOf with a discriminator (a property that is `const` in every branch: kind, type, area) checks only the branch
 * that matches, so the message names the real problem instead of "matched no branch". */
function schemaCheck(schema, data, at, out, defsRoot) {
  defsRoot = defsRoot || schema;
  const where = at || '(root)';
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m && defsRoot.$defs && defsRoot.$defs[m[1]];
    if (!target) { out.push(where + ': schema $ref not found ' + schema.$ref); return; }
    schemaCheck(target, data, at, out, defsRoot);
  }
  const type = t => Array.isArray(t) ? 'array' : t === null ? 'null' : typeof t === 'number' && Number.isInteger(t) ? 'integer' : typeof t;
  if (schema.type) {
    const t = type(data); const want = [].concat(schema.type);
    const ok = want.some(w => w === t || (w === 'number' && (t === 'integer' || t === 'number')));
    if (!ok) { out.push(where + ': must be ' + want.join('|') + ', got ' + t); return; }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(data)) { out.push(where + ': must be ' + JSON.stringify(schema.const)); return; }
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(data))) { out.push(where + ': must be one of ' + schema.enum.join(', ')); return; }
  if (typeof data === 'string') {
    if (schema.minLength != null && data.length < schema.minLength) out.push(where + ': shorter than ' + schema.minLength);
    if (schema.maxLength != null && data.length > schema.maxLength) out.push(where + ': longer than ' + schema.maxLength);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) out.push(where + ': does not match ' + schema.pattern);
  }
  if (typeof data === 'number') {
    if (schema.minimum != null && data < schema.minimum) out.push(where + ': below minimum ' + schema.minimum);
    if (schema.maximum != null && data > schema.maximum) out.push(where + ': above maximum ' + schema.maximum);
  }
  if (Array.isArray(data)) {
    if (schema.minItems != null && data.length < schema.minItems) out.push(where + ': needs at least ' + schema.minItems + ' items');
    if (schema.maxItems != null && data.length > schema.maxItems) out.push(where + ': at most ' + schema.maxItems + ' items');
    if (schema.items) data.forEach((x, i) => schemaCheck(schema.items, x, where.replace('(root)', '') + '[' + i + ']', out, defsRoot));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const keys = Object.keys(data); const pre = at ? at + '.' : '';
    for (const k of schema.required || []) if (!(k in data)) out.push(pre + k + ': required');
    if (schema.minProperties != null && keys.length < schema.minProperties) out.push(where + ': needs at least ' + schema.minProperties + ' entries');
    if (schema.maxProperties != null && keys.length > schema.maxProperties) out.push(where + ': at most ' + schema.maxProperties + ' entries');
    for (const k of keys) {
      if (schema.propertyNames) { const pn = []; schemaCheck(schema.propertyNames, k, pre + k, pn, defsRoot); if (pn.length) out.push(pre + k + ': bad name (' + schema.propertyNames.pattern + ')'); }
      if (schema.properties && schema.properties[k]) schemaCheck(schema.properties[k], data[k], pre + k, out, defsRoot);
      else if (schema.additionalProperties === false && !(schema.properties && k in schema.properties)) out.push(pre + k + ': not allowed here');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') schemaCheck(schema.additionalProperties, data[k], pre + k, out, defsRoot);
    }
  }
  for (const comb of ['oneOf', 'anyOf']) {
    if (!schema[comb]) continue;
    const branches = schema[comb].map(b => b.$ref ? (defsRoot.$defs[b.$ref.replace('#/$defs/', '')] || b) : b);
    const disc = data && typeof data === 'object' && !Array.isArray(data) && ['kind', 'type', 'area'].find(d =>
      branches.every(b => b.properties && b.properties[d] && 'const' in b.properties[d]));
    if (disc) {
      const i = branches.findIndex(b => b.properties[disc].const === data[disc]);
      if (i < 0) { out.push((at ? at + '.' : '') + disc + ': must be one of ' + branches.map(b => b.properties[disc].const).join(', ')); continue; }
      schemaCheck(schema[comb][i], data, at, out, defsRoot);
      continue;
    }
    const results = schema[comb].map(b => { const o = []; schemaCheck(b, data, at, o, defsRoot); return o; });
    const passing = results.filter(r => !r.length).length;
    if (comb === 'oneOf' ? passing !== 1 : passing < 1) {
      const best = results.slice().sort((a, b) => a.length - b.length)[0] || [];
      out.push(where + ': matches ' + (passing ? 'more than one' : 'no') + ' allowed shape' + (best.length ? ' (closest: ' + best[0] + ')' : ''));
    }
  }
}

/* ---------- path safety ---------- */
function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:[^/]+/)*' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
/* Static checks on a file-source glob. Returns a list of problems (strings). */
function checkGlob(glob, sources) {
  const f = sources.file || {}; const bad = [];
  const g = String(glob || '');
  if (!g) return ['empty glob'];
  if (/[\0\\]/.test(g)) bad.push('no backslash or NUL');
  if (g.startsWith('/') || /^[A-Za-z]:/.test(g) || g.startsWith('~')) bad.push('must be relative to the project root');
  const segs = g.split('/');
  if (segs.some(s => s === '..' || s === '.' || s === '')) bad.push("no '..', '.' or empty segments");
  if (segs.some(s => s.toLowerCase() === 'secrets')) bad.push("never under secrets/");
  if (segs.some(s => s.startsWith('.'))) bad.push('no dotfiles or dot-folders');
  if (/[[\]{}!]/.test(g)) bad.push('only *, ** and ? are supported');
  if (!(f.roots || []).some(r => g.startsWith(r))) bad.push('must start with one of ' + (f.roots || []).join(', '));
  if (!(f.extensions || []).some(e => g.toLowerCase().endsWith(e))) bad.push('must end in one of ' + (f.extensions || []).join(', '));
  for (const d of f.deny || []) if (globToRegex(d).test(g.replace(/\*+/g, 'x'))) bad.push('matches deny rule ' + d);
  return bad;
}
function isDenied(relPath, sources) {
  const f = sources.file || {};
  if (relPath.split('/').some(s => s.toLowerCase() === 'secrets' || s.startsWith('.') || s === '..')) return true;
  if (!(f.roots || []).some(r => relPath.startsWith(r))) return true;
  if (!(f.extensions || []).some(e => relPath.toLowerCase().endsWith(e))) return true;
  return (f.deny || []).some(d => globToRegex(d).test(relPath));
}
/* Walk the allowed root under the glob's fixed prefix; never follow symlinks. */
function matchGlob(glob, sources, r) {
  r = r || root();
  const re = globToRegex(glob);
  const fixed = glob.split('/'); const pre = [];
  for (const s of fixed) { if (/[*?]/.test(s)) break; pre.push(s); }
  const isFile = pre.length === fixed.length;
  const base = isFile ? pre.slice(0, -1) : pre;
  const out = []; const realRoot = fs.realpathSync(r);
  const max = (sources.file && sources.file.maxFiles) || 50;
  (function walk(dirRel, depth) {
    if (depth > 10 || out.length > max * 4) return;
    let ents = []; try { ents = fs.readdirSync(path.join(r, dirRel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const pRel = dirRel ? dirRel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'secrets') walk(pRel, depth + 1); }
      else if (e.isFile() && re.test(pRel) && !isDenied(pRel, sources)) {
        const abs = path.join(r, pRel);
        let real; try { real = fs.realpathSync(abs); } catch (_) { continue; }
        if (!real.startsWith(realRoot + path.sep)) continue;
        out.push(pRel);
      }
    }
  })(base.join('/'), 0);
  return out.sort();
}

/* ---------- data ---------- */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  const head = rows.shift() || [];
  return rows.map(r => { const o = {}; head.forEach((h, i) => { const v = r[i]; o[h] = v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : (v == null ? null : v); }); return o; });
}
function parseFile(abs) {
  const txt = fs.readFileSync(abs, 'utf8'); const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') return JSON.parse(txt);
  if (ext === '.jsonl') return txt.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(x => x != null);
  if (ext === '.csv') return parseCsv(txt);
  return txt; // .md: the console renders it as sanitised markdown, never raw HTML
}
function select(data, dot) {
  if (!dot) return data;
  let v = data;
  for (const k of dot.split('.')) {
    if (v == null) return undefined;
    if (k === 'length' && Array.isArray(v)) return v.length;
    v = v[k];
  }
  return v;
}
function cap(data, limits) {
  const max = (limits && limits.maxRows) || 500;
  if (Array.isArray(data) && data.length > max) return { data: data.slice(0, max), truncated: true };
  return { data, truncated: false };
}
function resolveFileSource(src, sources, r) {
  r = r || root();
  const bad = checkGlob(src.glob, sources);
  if (bad.length) return { ok: false, error: 'glob refused: ' + bad.join('; ') };
  const files = matchGlob(src.glob, sources, r);
  const maxBytes = (sources.file && sources.file.maxBytes) || 2097152;
  const maxFiles = (sources.file && sources.file.maxFiles) || 50;
  const pick = src.pick || 'single';
  if (!files.length) return { ok: false, error: 'no file matches ' + src.glob, files: [] };
  const readOne = f => { const abs = path.join(r, f); const st = fs.statSync(abs); if (st.size > maxBytes) throw new Error(f + ' is larger than ' + maxBytes + ' bytes'); return parseFile(abs); };
  try {
    if (pick === 'single') {
      if (files.length > 1) return { ok: false, error: files.length + ' files match ' + src.glob + "; use pick 'latest' or 'all'", files };
      return Object.assign({ ok: true, files }, cap(select(readOne(files[0]), src.select), sources.limits));
    }
    if (pick === 'latest') {
      const f = files.map(x => ({ x, m: fs.statSync(path.join(r, x)).mtimeMs })).sort((a, b) => b.m - a.m)[0].x;
      return Object.assign({ ok: true, files: [f] }, cap(select(readOne(f), src.select), sources.limits));
    }
    const use = files.slice(0, maxFiles);
    return Object.assign({ ok: true, files: use }, cap(use.map(f => ({ file: f, data: select(readOne(f), src.select) })), sources.limits), files.length > maxFiles ? { truncated: true } : {});
  } catch (e) { return { ok: false, error: e.message, files }; }
}
function resolveToolSource(src, sources, r) {
  r = r || root();
  const entry = (sources.tool || {})[src.id];
  if (!entry || src.id.startsWith('_')) return { ok: false, error: 'tool source ' + src.id + ' is not in sources.json' };
  const script = path.join(paths(r).tools, entry.argv[0]);
  if (!/^[a-z0-9][a-z0-9._-]*\.js$/.test(entry.argv[0]) || path.dirname(script) !== paths(r).tools) return { ok: false, error: 'bad allowlist entry ' + src.id };
  try {
    const stdout = execFileSync(process.execPath, [script].concat(entry.argv.slice(1)), {
      cwd: r, timeout: entry.timeoutMs || 15000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { CAPHEOS_READONLY: '1' })
    });
    return Object.assign({ ok: true, command: entry.argv.join(' ') }, cap(select(JSON.parse(stdout), src.select), sources.limits));
  } catch (e) {
    const msg = e.stdout ? 'not JSON or failed (exit ' + e.status + '): ' + String(e.stderr || e.stdout).trim().slice(0, 200) : e.message;
    return { ok: false, command: entry.argv.join(' '), error: msg };
  }
}
async function resolveStationSource(src, sources, live) {
  const entry = (sources.station || {})[src.id];
  if (!entry || src.id.startsWith('_')) return { ok: false, error: 'station source ' + src.id + ' is not in sources.json' };
  if (String(entry.method || 'GET').toUpperCase() !== 'GET' || !/^\/api\/[A-Za-z0-9/_-]+$/.test(entry.path)) return { ok: false, error: 'bad allowlist entry ' + src.id };
  if (!live) return { ok: false, offline: true, endpoint: 'GET ' + entry.path, error: 'station source not resolved offline (pass --live)' };
  try {
    const res = await fetch(co.STATION_URL + entry.path, { method: 'GET', headers: { 'x-starnet-token': co.stationToken() }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, endpoint: 'GET ' + entry.path, error: 'HTTP ' + res.status };
    return Object.assign({ ok: true, endpoint: 'GET ' + entry.path }, cap(select(await res.json(), src.select), sources.limits));
  } catch (e) { return { ok: false, endpoint: 'GET ' + entry.path, error: e.message }; }
}

/* ---------- custom view lint ---------- */
function lintViewHtml(html, sources, file) {
  const out = []; const f = file || 'view.html';
  const lim = (sources.limits && sources.limits.maxViewHtmlBytes) || 262144;
  if (Buffer.byteLength(html) > lim) out.push(f + ': larger than ' + lim + ' bytes');
  const rules = [
    [/\bhttps?:\/\//i, 'no URLs: the view has no network'],
    [/["'(=]\s*\/\/[a-z0-9]/i, 'no protocol-relative URLs'],
    [/<script\b[^>]*\bsrc\s*=/i, 'no external scripts; inline only'],
    [/<link\b/i, 'no <link>: the console supplies the stylesheet'],
    [/<(iframe|frame|object|embed|base|form|portal)\b/i, 'no nested frames, forms, <base> or plugins'],
    [/<meta\b[^>]*http-equiv/i, 'no <meta http-equiv>'],
    [/\b(fetch|importScripts)\s*\(/, 'no fetch/importScripts: data arrives by postMessage'],
    [/\b(XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|SharedWorker|Worker)\b/, 'no network or worker APIs'],
    [/\bsendBeacon\b|\bserviceWorker\b/, 'no beacons or service workers'],
    [/\bimport\s*\(|<script\b[^>]*type\s*=\s*["']?module/i, 'no module imports'],
    [/\b(?:window\.)?(?:top|opener)\s*\.|\bparent\.(?:location|document)|\bwindow\.open\s*\(/, 'no reaching the parent, top or new windows (postMessage to parent only)'],
    [/\bdocument\.cookie\b|\b(localStorage|sessionStorage|indexedDB)\b/, 'no storage or cookies'],
    [/\beval\s*\(|\bnew\s+Function\s*\(/, 'no eval'],
    [/\bon[a-z]+\s*=\s*["'][^"']*(javascript:)/i, 'no javascript: URLs']
  ];
  for (const [re, why] of rules) { const m = re.exec(html); if (m) out.push(f + ':' + lineOf(html, m.index) + ': ' + why); }
  if (/javascript:/i.test(html)) out.push(f + ':' + lineOf(html, html.search(/javascript:/i)) + ': no javascript: URLs');
  // style: tokens only — check <style> blocks, style="" attributes and .style.<prop> = '...' assignments
  const tokens = new Set(((sources.styleTokens || {}).tokens) || []);
  const styleBits = [];
  html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css, i) => { styleBits.push([css, i]); return m; });
  html.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _q, a, b, i) => { styleBits.push([a || b || '', i]); return m; });
  html.replace(/\.style\.[a-zA-Z]+\s*=\s*(['"`])([^'"`]*)\1/g, (m, _q, v, i) => { styleBits.push([v, i]); return m; });
  html.replace(/\.style\.setProperty\(\s*['"][^'"]+['"]\s*,\s*(['"`])([^'"`]*)\1/g, (m, _q, v, i) => { styleBits.push([v, i]); return m; });
  for (const [css, i] of styleBits) {
    const ln = lineOf(html, i);
    if (/#[0-9a-f]{3,8}\b/i.test(css)) out.push(f + ':' + ln + ': colour literal; use var(--cap-*) tokens');
    if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i.test(css)) out.push(f + ':' + ln + ': colour function; use var(--cap-*) tokens');
    if (/@import|@font-face|\burl\s*\(/i.test(css)) out.push(f + ':' + ln + ': no @import, @font-face or url()');
    if (/font-family\s*:\s*(?!\s*var\()/i.test(css)) out.push(f + ':' + ln + ': font-family must be var(--cap-font) or var(--cap-mono)');
    if (/(^|[;{\s])(position\s*:\s*fixed)/i.test(css)) out.push(f + ':' + ln + ': no position: fixed');
    const vars = css.match(/var\(\s*(--[a-zA-Z0-9-]+)/g) || [];
    for (const v of vars) { const name = v.replace(/var\(\s*/, ''); if (!tokens.has(name) && !name.startsWith('--local-')) out.push(f + ':' + ln + ': unknown token ' + name + ' (allowed: sources.json styleTokens, or your own --local-*)'); }
    const named = css.match(/(?:^|[:\s,])(red|green|blue|black|white|gray|grey|orange|yellow|purple|pink)(?![-\w])/i);
    if (named) out.push(f + ':' + ln + ': named colour ' + named[1] + '; use var(--cap-*) tokens');
  }
  if (!/addEventListener\(\s*['"]message['"]/.test(html) && !/onmessage\s*=/.test(html)) out.push(f + ': never listens for the console\'s message (capheos:panel-data)');
  return out;
}
function lineOf(text, idx) { return text.slice(0, Math.max(0, idx)).split('\n').length; }

/* ---------- validation ---------- */
function placementKey(pl) {
  if (!pl) return '?';
  if (pl.area === 'side') return 'side:' + pl.screen;
  return pl.area;
}
function listDir(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch (_) { return []; } }
/* Installed panels and pages: [{ id, type: 'panel'|'page', dir, panel }] (`panel` is the parsed panel.json or page.json) */
function installed(r) {
  const P = paths(r);
  return listDir(P.panels).map(id => ({ id, type: 'panel', dir: path.join(P.panels, id), panel: readJson(path.join(P.panels, id, 'panel.json'), null) }))
    .concat(listDir(P.pages).map(id => ({ id, type: 'page', dir: path.join(P.pages, id), panel: readJson(path.join(P.pages, id, 'page.json'), null) })));
}
/* A folder is a page when it holds page.json, else a panel. */
const isPageDir = d => fs.existsSync(path.join(d, 'page.json'));
const manifestOf = d => isPageDir(d) ? 'page.json' : 'panel.json';
/* Validate one view (a panel's view, or a page unit's view). `at` is the field prefix ("view" or "units[2].view").
 * ctx = { pf, srcNames, sources (the panel's own), actions, inPage }. Returns findings. */
function validateView(v, at, ctx) {
  const out = []; const pf = ctx.pf; v = v || {};
  const refs = [];
  if (v.source) refs.push([at + '.source', v.source]);
  if (v.kind === 'stat-row') (v.items || []).forEach((it, i) => refs.push([at + '.items[' + i + '].source', it.source]));
  if (v.kind === 'gauge' || v.kind === 'progress') (v.items || []).forEach((it, i) => { if (it.source) refs.push([at + '.items[' + i + '].source', it.source]); });
  (v.sources || []).forEach((s, i) => refs.push([at + '.sources[' + i + ']', s]));
  for (const [field, name] of refs) if (name && !ctx.srcNames.includes(name)) out.push(pf + ':' + field + ': no source named "' + name + '" in sources');
  const srcs = ctx.sources || {};
  if (v.kind === 'markdown' && v.source && srcs[v.source] && srcs[v.source].type === 'file' && !/\.md$/i.test(srcs[v.source].glob || '')) out.push(pf + ':' + at + '.source: a markdown view reads a .md file');
  const act = id => (ctx.actions || []).find(a => a.id === id);
  if (v.kind === 'chart') {
    if (v.chart === 'candlestick') { if (!v.ohlc) out.push(pf + ':' + at + '.ohlc: a candlestick chart names open, high, low and close'); }
    else if (!v.series || !v.series.length) out.push(pf + ':' + at + '.series: required: a ' + (v.chart || '?') + ' chart names 1 to 6 series (key + label); series are never guessed');
    if (v.ohlc && v.chart !== 'candlestick') out.push(pf + ':' + at + '.ohlc: only a candlestick chart takes ohlc');
    (v.refs || []).forEach((r, i) => { if ((r.value == null) === (r.from == null)) out.push(pf + ':' + at + '.refs[' + i + ']: give exactly one of value (a number) or from (a dot path)'); });
    if (v.chart === 'scatter' && v.x && v.x.time) out.push(pf + ':' + at + '.x.time: a scatter plots two measures; use a line chart for values over time');
  }
  if (v.kind === 'kanban' && v.move) { const a = act(v.move); if (!a) out.push(pf + ':' + at + '.move: no action "' + v.move + '" in actions'); else if (a.scope !== 'move') out.push(pf + ':' + at + '.move: action "' + v.move + '" needs scope "move"'); }
  if (v.kind === 'kanban' && v.columns) { const ids = v.columns.map(c => c.id); if (new Set(ids).size !== ids.length) out.push(pf + ':' + at + '.columns: duplicate column id'); }
  if (v.kind === 'feed' && v.ack) { const a = act(v.ack); if (!a) out.push(pf + ':' + at + '.ack: no action "' + v.ack + '" in actions'); else if (a.scope !== 'row') out.push(pf + ':' + at + '.ack: action "' + v.ack + '" needs scope "row"'); if (!v.acked) out.push(pf + ':' + at + '.acked: an ack action needs the field that says an alert is already acknowledged'); }
  if (v.kind === 'pipeline') {
    if (v.by && (v.label || v.count)) out.push(pf + ':' + at + ': either `by` (count items per stage) or `label` + `count` (rows are stages), not both');
    else if (!v.by && !(v.label && v.count)) out.push(pf + ':' + at + ': name `by` (count items per stage) or `label` + `count` (rows are stages)');
  }
  if (v.kind === 'gauge' || v.kind === 'progress') (v.items || []).forEach((it, i) => { if (it.warnAt != null && it.badAt != null && it.warnAt >= it.badAt) out.push(pf + ':' + at + '.items[' + i + '].warnAt: must be below badAt'); });
  if (ctx.inPage && v.kind === 'custom') out.push(pf + ':' + at + '.kind: a page unit is drawn by the console; custom views are single panels only');
  return out;
}
const MOVE_PH = /^\{\{(move\.(from|to))\}\}$/;
function validateActions(acts, ctx) {
  const out = []; const pf = ctx.pf; const r = ctx.root;
  if (ctx.max && acts.length > ctx.max) out.push(pf + ':actions: at most ' + ctx.max);
  const seen = new Set();
  acts.forEach((a, i) => {
    const at = pf + ':actions[' + i + ']';
    if (seen.has(a.id)) out.push(at + '.id: duplicate'); seen.add(a.id);
    if (a.kind === 'handoff') {
      if (!a.to) out.push(at + '.to: a handoff names the function or seat it goes to');
      else if (!FUNCTIONS.includes(a.to) && !findSeat(a.to, r)) out.push(at + '.to: not a function or a seat in loops.json');
    } else if (a.to) out.push(at + '.to: only a handoff has a recipient (' + a.kind + ' goes to ' + (a.kind === 'ask-ceo' ? 'the CEO' : "the owner's own composer") + ')');
    const tpl = String(a.text || '');
    for (const m of tpl.match(/\{\{[^}]*\}\}/g) || []) {
      if (MOVE_PH.test(m)) { if (a.scope !== 'move') out.push(at + '.text: ' + m + ' needs scope "move"'); continue; }
      if (!/^\{\{(row\.[A-Za-z0-9_.-]+|panel\.title)\}\}$/.test(m)) out.push(at + '.text: placeholder ' + m + ' (only {{row.<key>}}, {{panel.title}}, and {{move.from}}/{{move.to}} with scope "move")');
      else if (m.startsWith('{{row.') && a.scope !== 'row' && a.scope !== 'move') out.push(at + '.text: ' + m + ' needs scope "row"');
    }
    if (/\{\{|\}\}/.test(tpl.replace(/\{\{[^}]*\}\}/g, ''))) out.push(at + '.text: unbalanced braces');
  });
  return out;
}
function validateSources(srcMap, sources, pf, max) {
  const out = []; const names = Object.keys(srcMap || {});
  if (max && names.length > max) out.push(pf + ':sources: at most ' + max);
  for (const n of names) {
    const s = srcMap[n] || {};
    if (s.type === 'file') for (const b of checkGlob(s.glob, sources)) out.push(pf + ':sources.' + n + '.glob: ' + b);
    if (s.type === 'tool' && (!(sources.tool || {})[s.id] || String(s.id).startsWith('_'))) out.push(pf + ':sources.' + n + '.id: "' + s.id + '" is not an allowlisted tool (sources.json tool: ' + Object.keys(sources.tool || {}).filter(k => !k.startsWith('_')).join(', ') + ')');
    if (s.type === 'station' && (!(sources.station || {})[s.id] || String(s.id).startsWith('_'))) out.push(pf + ':sources.' + n + '.id: "' + s.id + '" is not an allowlisted station endpoint (sources.json station: ' + Object.keys(sources.station || {}).filter(k => !k.startsWith('_')).join(', ') + ')');
  }
  return out;
}
/* checks shared by panels and pages: id, owner, nav label, refresh, the per-placement limit and nav clashes */
function validateCommon(doc, dir, pf, r, sources) {
  const out = []; const lim = sources.limits || {}; const screens = sources.screens || {};
  if (doc.id && path.basename(dir) !== doc.id) out.push(pf + ':id: must equal the folder name (' + path.basename(dir) + ')');
  if ((sources.reservedIds || []).includes(doc.id)) out.push(pf + ':id: reserved for the console');
  if (doc.owner && !FUNCTIONS.includes(doc.owner) && !findSeat(doc.owner, r)) out.push(pf + ':owner: not a function (' + FUNCTIONS.join(', ') + ') or a seat in loops.json');
  const pl = doc.placement || {};
  if (pl.area === 'side') {
    if ((screens.protected || []).includes(pl.screen)) out.push(pf + ':placement.screen: ' + pl.screen + ' is protected');
    else if (pl.screen && !(screens.sideAllowed || []).includes(pl.screen)) out.push(pf + ':placement.screen: side panels are allowed on ' + (screens.sideAllowed || []).join(', '));
  }
  if (pl.area === 'screen' && pl.nav && (screens.builtinLabels || []).some(l => l.toLowerCase() === String(pl.nav).trim().toLowerCase())) out.push(pf + ':placement.nav: "' + pl.nav + '" is a built-in console label');
  if (doc.refresh != null) {
    if (doc.refresh < (lim.minRefreshSeconds || 30)) out.push(pf + ':refresh: at least ' + (lim.minRefreshSeconds || 30) + ' seconds');
    if (lim.maxRefreshSeconds && doc.refresh > lim.maxRefreshSeconds) out.push(pf + ':refresh: at most ' + lim.maxRefreshSeconds + ' seconds');
  }
  // limits per placement (count installed panels and pages in the same placement, hidden ones included, not counting itself)
  const key = placementKey(pl);
  const limitKey = pl.area === 'side' ? 'side' : pl.area;
  const max = (lim.perPlacement || {})[limitKey];
  const all = installed(r);
  const twin = all.find(x => x.id === doc.id && x.type !== (doc.units ? 'page' : 'panel'));
  if (twin) out.push(pf + ':id: "' + doc.id + '" is already installed as a ' + twin.type + '; remove it first or pick another id');
  if (max && pl.area) {
    const others = all.filter(x => x.id !== doc.id && x.panel && placementKey(x.panel.placement) === key);
    if (others.length + 1 > max) out.push(pf + ':placement: ' + key + ' already holds ' + others.length + ' company ' + (pl.area === 'screen' ? 'screens' : 'panels') + ' (limit ' + max + '); remove one first');
    if (pl.area === 'screen' && pl.nav) {
      const clash = all.find(x => x.id !== doc.id && x.panel && x.panel.placement && x.panel.placement.area === 'screen' && String(x.panel.placement.nav).toLowerCase() === String(pl.nav).toLowerCase());
      if (clash) out.push(pf + ':placement.nav: "' + pl.nav + '" is already used by ' + clash.id);
    }
  }
  return out;
}
function folderExtras(dir, allowed, r) {
  let names = []; try { names = fs.readdirSync(dir); } catch (_) {}
  return names.filter(f => !allowed.includes(f)).map(x => rel(path.join(dir, x), r) + ': a ' + (allowed.includes('page.json') ? 'page folder holds page.json and README.md' : 'panel folder holds panel.json, view.html and README.md') + ' only');
}
/* Validate a parsed panel and its folder. Returns findings as "file:field: message" strings. */
function validatePanel(panel, dir, opts) {
  opts = opts || {};
  const r = opts.root || root();
  const sources = opts.sources || loadSources(r);
  const pf = rel(path.join(dir, 'panel.json'), r);
  const out = [];
  const schema = readJson(SCHEMA_FILE, null);
  if (!schema) return [rel(SCHEMA_FILE, r) + ': cannot read the schema'];
  const sc = []; schemaCheck(schema, panel, '', sc, schema);
  for (const s of sc) out.push(pf + ':' + s);
  if (!panel || typeof panel !== 'object') return out;
  const lim = sources.limits || {};
  out.push(...validateCommon(panel, dir, pf, r, sources));
  out.push(...validateSources(panel.sources, sources, pf, lim.maxSourcesPerPanel));
  const srcNames = Object.keys(panel.sources || {});
  const v = panel.view || {};
  out.push(...validateView(v, 'view', { pf, srcNames, sources: panel.sources, actions: panel.actions || [] }));
  if (v.kind === 'custom') {
    const vh = path.join(dir, 'view.html');
    if (!fs.existsSync(vh)) out.push(pf + ':view.html: view.html is missing from the panel folder');
    else for (const x of lintViewHtml(fs.readFileSync(vh, 'utf8'), sources, rel(vh, r))) out.push(x);
    const h = lim.customHeight || {};
    if (v.height != null && ((h.min && v.height < h.min) || (h.max && v.height > h.max))) out.push(pf + ':view.height: between ' + h.min + ' and ' + h.max);
  } else if (fs.existsSync(path.join(dir, 'view.html'))) out.push(rel(path.join(dir, 'view.html'), r) + ': only a custom view may ship view.html');
  out.push(...folderExtras(dir, ['panel.json', 'view.html', 'README.md', 'fixture'], r));
  out.push(...validateActions(panel.actions || [], { pf, root: r, max: lim.maxActionsPerPanel }));
  return out;
}
/* Validate a parsed page (page.json: a company screen made of units) and its folder. */
function validatePage(page, dir, opts) {
  opts = opts || {};
  const r = opts.root || root();
  const sources = opts.sources || loadSources(r);
  const pf = rel(path.join(dir, 'page.json'), r);
  const out = [];
  const schema = readJson(SCHEMA_FILE, null);
  if (!schema) return [rel(SCHEMA_FILE, r) + ': cannot read the schema'];
  const sc = []; schemaCheck(schema.$defs.page, page, '', sc, schema);
  for (const s of sc) out.push(pf + ':' + s);
  if (!page || typeof page !== 'object') return out;
  const lim = sources.limits || {}; const pl = lim.page || {};
  out.push(...validateCommon(page, dir, pf, r, sources));
  out.push(...validateSources(page.sources, sources, pf, pl.maxSources || 8));
  const srcNames = Object.keys(page.sources || {});
  const acts = page.actions || [];
  const units = Array.isArray(page.units) ? page.units : [];
  if (pl.maxUnits && units.length > pl.maxUnits) out.push(pf + ':units: at most ' + pl.maxUnits);
  const ids = new Set();
  units.forEach((u, i) => {
    const at = 'units[' + i + ']';
    if (!u || typeof u !== 'object') return;
    if (ids.has(u.id)) out.push(pf + ':' + at + '.id: duplicate unit id "' + u.id + '"'); ids.add(u.id);
    out.push(...validateView(u.view, at + '.view', { pf, srcNames, sources: page.sources, actions: acts, inPage: true }));
    (u.actions || []).forEach((id, j) => { const a = acts.find(x => x.id === id); if (!a) out.push(pf + ':' + at + '.actions[' + j + ']: no action "' + id + '" in actions'); else if (a.scope !== 'row') out.push(pf + ':' + at + '.actions[' + j + ']: "' + id + '" is not a row action (panel-wide actions show in the page header; move and ack are named by the view)'); });
  });
  out.push(...folderExtras(dir, ['page.json', 'README.md'], r));
  out.push(...validateActions(acts, { pf, root: r, max: pl.maxActions || 6 }));
  return out;
}
/* An id (installed, then proposed, then examples) or a path. add prefers the path: you add from a working folder. */
function resolveDir(arg, r, preferPath) {
  const P = paths(r);
  if (!arg || typeof arg !== 'string') return null;
  const byPath = () => { const a = path.resolve(arg); return fs.existsSync(a) ? (fs.statSync(a).isDirectory() ? a : path.dirname(a)) : null; };
  const byId = () => { if (!/^[a-z][a-z0-9-]{1,39}$/.test(arg)) return null; for (const d of [P.panels, P.pages, P.proposed, P.examples]) for (const m of ['panel.json', 'page.json']) if (fs.existsSync(path.join(d, arg, m))) return path.join(d, arg); return null; };
  return preferPath ? (byPath() || byId()) : (byId() || byPath());
}
function validateDir(dir, opts) {
  const r = (opts && opts.root) || root();
  const page = isPageDir(dir);
  const pfile = path.join(dir, page ? 'page.json' : 'panel.json');
  let panel;
  try { panel = JSON.parse(fs.readFileSync(pfile, 'utf8')); } catch (e) { return { panel: null, page, findings: [rel(pfile, r) + ': ' + (fs.existsSync(pfile) ? 'not valid JSON: ' + e.message : 'missing (panel.json or page.json)')] }; }
  return { panel, page, findings: page ? validatePage(panel, dir, opts) : validatePanel(panel, dir, opts) };
}

/* ---------- state, provenance ---------- */
function consoleState(r) { const s = readJson(paths(r).state, {}) || {}; s.hidden = s.hidden || {}; return s; }
function writeState(s, r) { fs.mkdirSync(paths(r).console, { recursive: true }); fs.writeFileSync(paths(r).state, JSON.stringify(s, null, 2) + '\n'); }
function digest(dir) {
  const h = crypto.createHash('sha256');
  for (const f of ['panel.json', 'page.json', 'view.html']) { try { h.update(f + '\0' + fs.readFileSync(path.join(dir, f))); } catch (_) {} }
  return h.digest('hex').slice(0, 16);
}
function record(row, r) {
  const P = paths(r);
  fs.mkdirSync(P.console, { recursive: true });
  const line = Object.assign({ at: new Date().toISOString() }, row);
  fs.appendFileSync(P.changes, JSON.stringify(line) + '\n');
  return line;
}
function copyPanel(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['panel.json', 'page.json', 'view.html', 'README.md']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
function tellOwner(text, from, r) {
  const mod = path.join(paths(r).tools, 'owner-inbox.js');
  if (!fs.existsSync(mod)) return { told: false, why: 'owner-inbox.js not present' };
  try { const row = require(mod).send({ from, text }); return { told: true, id: row && row.id }; } catch (e) { return { told: false, why: e.message }; }
}
function askOwner(q, from, r) {
  const tool = path.join(paths(r).tools, 'inbox.js');
  if (!fs.existsSync(tool)) return { asked: false, why: 'inbox.js not present' };
  try {
    const outp = execFileSync(process.execPath, [tool, 'ask', '--from', from, '--about', 'console', '--q', q], { cwd: paths(r).root, encoding: 'utf8', timeout: 15000 });
    const j = JSON.parse(outp); return { asked: !!j.ok, id: j.id };
  } catch (e) { return { asked: false, why: e.message }; }
}

/* ---------- commands ---------- */
function cmdAdd(dirArg, by, r) {
  r = r || root();
  const P = paths(r);
  const dir = resolveDir(dirArg, r, true);
  if (!dir) return { code: 2, out: { ok: false, error: 'no panel folder at ' + dirArg } };
  if (!by) return { code: 2, out: { ok: false, error: '--by <seat> is required' } };
  const owner = isOwner(by); const seat = findSeat(by, r);
  if (!owner && !seat) return { code: 1, out: { ok: false, error: '--by ' + by + ' is not a seat in loops.json or the owner' } };
  if ([P.panels, P.pages].some(d => path.resolve(dir).startsWith(path.resolve(d) + path.sep))) return { code: 2, out: { ok: false, error: 'already installed; add from a working folder' } };
  const { panel, findings, page } = validateDir(dir, { root: r });
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  const home = page ? P.pages : P.panels; const what0 = page ? 'console page' : 'console panel';
  const existing = readJson(path.join(home, panel.id, page ? 'page.json' : 'panel.json'), null);
  if (existing && !owner && !answersFor(by, existing.owner, r) && !holdsFn(seat.seat, 'tools') && !holdsFn(seat.seat, 'ceo'))
    return { code: 1, out: { ok: false, error: panel.id + ' is owned by ' + existing.owner + '; only its owner, the tools or CEO seat, or the owner may change it' } };
  const gate = owner ? 'owner' : gateFor('dashboard', r);
  const from = path.relative(r, dir);
  const who = owner ? 'owner' : seat.seat.name || seat.id;
  const what = (existing ? 'changed' : 'added') + ' ' + what0 + ' "' + panel.title + '" (' + panel.id + ', ' + placementKey(panel.placement) + ', owner ' + panel.owner + ')';
  if (gate === 'approve') {
    copyPanel(dir, path.join(P.proposed, panel.id));
    const q = who + ' proposes a ' + what0 + ': "' + panel.title + '" (' + placementKey(panel.placement) + '). Why: ' + panel.why
      + ' Recommendation: approve. Default if unanswered: not installed. Approve: node company/tools/console-panel.js approve ' + panel.id + ' --by owner';
    const asked = askOwner(q, who, r);
    const line = record({ op: 'propose', id: panel.id, type: page ? 'page' : 'panel', by: who, gate, from, digest: digest(dir), question: asked.id || null }, r);
    return { code: 0, out: { ok: true, status: 'proposed', id: panel.id, dir: rel(path.join(P.proposed, panel.id), r), asked, change: line } };
  }
  copyPanel(dir, path.join(home, panel.id));
  const line = record({ op: existing ? 'change' : 'add', id: panel.id, type: page ? 'page' : 'panel', by: who, gate, from, digest: digest(dir) }, r);
  const told = gate === 'notify' ? tellOwner(who + ' ' + what + '. Why: ' + panel.why + ' Hide it any time: console-panel.js hide ' + panel.id + ' --by owner', who, r) : null;
  const hidden = !!consoleState(r).hidden[panel.id];
  return { code: 0, out: { ok: true, status: 'installed', id: panel.id, type: page ? 'page' : 'panel', gate, hidden, told, change: line } };
}
function cmdApprove(id, by, r, reject, note) {
  r = r || root(); const P = paths(r);
  if (!isOwner(by)) return { code: 1, out: { ok: false, error: 'only the owner ' + (reject ? 'rejects' : 'approves') + ' a proposed panel' } };
  const src = path.join(P.proposed, String(id || ''));
  if (!id || !fs.existsSync(path.join(src, manifestOf(src)))) return { code: 1, out: { ok: false, error: 'no proposed panel or page ' + id } };
  if (reject) { fs.rmSync(src, { recursive: true, force: true }); return { code: 0, out: { ok: true, status: 'rejected', change: record({ op: 'reject', id, by: 'owner', note: note || null }, r) } }; }
  const { findings } = validateDir(src, { root: r });
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  copyPanel(src, path.join(isPageDir(src) ? P.pages : P.panels, id));
  const d = digest(src); fs.rmSync(src, { recursive: true, force: true });
  return { code: 0, out: { ok: true, status: 'installed', id, change: record({ op: 'approve', id, by: 'owner', digest: d }, r) } };
}
function cmdRemove(id, by, r) {
  r = r || root(); const P = paths(r);
  const pdir = path.join(P.pages, String(id || ''));
  const dir = id && fs.existsSync(path.join(pdir, 'page.json')) ? pdir : path.join(P.panels, String(id || ''));
  const panel = readJson(path.join(dir, manifestOf(dir)), null);
  if (!id || !panel) return { code: 1, out: { ok: false, error: 'no installed panel or page ' + id } };
  const owner = isOwner(by); const seat = findSeat(by, r);
  if (!owner && !(seat && (answersFor(by, panel.owner, r) || holdsFn(seat.seat, 'tools') || holdsFn(seat.seat, 'ceo'))))
    return { code: 1, out: { ok: false, error: 'only the panel owner (' + panel.owner + '), the tools or CEO seat, or the owner may remove ' + id } };
  const who = owner ? 'owner' : seat.seat.name || seat.id;
  const d = digest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const gate = owner ? 'owner' : gateFor('dashboard', r);
  const line = record({ op: 'remove', id, by: who, gate, digest: d }, r);
  const told = gate === 'notify' || gate === 'approve' ? tellOwner(who + ' removed console ' + (dir === pdir ? 'page' : 'panel') + ' "' + panel.title + '" (' + id + ').', who, r) : null;
  return { code: 0, out: { ok: true, status: 'removed', id, told, change: line } };
}
function cmdHide(id, by, r, unhide) {
  r = r || root();
  if (!isOwner(by)) return { code: 1, out: { ok: false, error: 'only the owner hides or unhides a panel' } };
  if (!id || !/^[a-z][a-z0-9-]{1,39}$/.test(id)) return { code: 2, out: { ok: false, error: 'hide <id> --by owner' } };
  const s = consoleState(r);
  if (unhide) delete s.hidden[id]; else s.hidden[id] = { by: 'owner', at: new Date().toISOString() };
  writeState(s, r);
  return { code: 0, out: { ok: true, id, hidden: !unhide, change: record({ op: unhide ? 'unhide' : 'hide', id, by: 'owner' }, r) } };
}
function listPanels(r) {
  r = r || root(); const P = paths(r); const s = consoleState(r);
  let sources = null; try { sources = loadSources(r); } catch (_) {}
  const row = (status, dir) => {
    const v = sources ? validateDir(dir, { root: r, sources }) : { panel: readJson(path.join(dir, manifestOf(dir)), null), findings: ['sources.json unreadable'] };
    const p = v.panel || {};
    return { id: path.basename(dir), type: isPageDir(dir) ? 'page' : 'panel', units: Array.isArray(p.units) ? p.units.length : undefined, description: p.description || null, status, title: p.title || null, placement: p.placement ? placementKey(p.placement) : null,
      nav: p.placement && p.placement.nav || null, order: p.placement && p.placement.order || null, owner: p.owner || null, view: p.units ? 'page' : p.view && p.view.kind || null,
      refresh: p.refresh || (sources && sources.limits && sources.limits.defaultRefreshSeconds) || 300,
      hidden: !!s.hidden[path.basename(dir)], valid: !v.findings.length, findings: v.findings.length };
  };
  return listDir(P.panels).map(id => row('installed', path.join(P.panels, id)))
    .concat(listDir(P.pages).map(id => row('installed', path.join(P.pages, id))))
    .concat(listDir(P.proposed).map(id => row('proposed', path.join(P.proposed, id))));
}

/* render: what the console passes into the panel. Never writes. */
async function render(idOrDir, opts) {
  opts = opts || {};
  const r = opts.root || root();
  const sources = opts.sources || loadSources(r);
  const dir = typeof idOrDir === 'string' ? resolveDir(idOrDir, r) : null;
  if (!dir) return { ok: false, error: 'no panel ' + idOrDir };
  const { panel, findings } = validateDir(dir, { root: r, sources });
  if (!panel || findings.length) return { ok: false, id: panel && panel.id, error: 'panel does not validate', findings };
  const data = {}; const status = {};
  const wanted = panel.view && panel.view.kind === 'custom' && panel.view.sources ? panel.view.sources : Object.keys(panel.sources);
  for (const name of wanted) {
    const src = panel.sources[name]; let res;
    if (src.type === 'file') res = resolveFileSource(src, sources, r);
    else if (src.type === 'tool') res = resolveToolSource(src, sources, r);
    else res = await resolveStationSource(src, sources, !!opts.live);
    data[name] = res.ok ? res.data : null;
    const st = Object.assign({}, res); delete st.data; status[name] = st;
  }
  const lim = sources.limits || {};
  return {
    ok: Object.values(status).every(s => s.ok || s.offline),
    type: 'capheos:panel-data', version: 1, id: panel.id, at: new Date().toISOString(),
    title: panel.title, owner: panel.owner, why: panel.why, placement: panel.placement,
    refresh: Math.max(panel.refresh || lim.defaultRefreshSeconds || 300, lim.minRefreshSeconds || 30),
    hidden: !!consoleState(r).hidden[panel.id], actions: panel.actions || [],
    ...(Array.isArray(panel.units) ? { kind: 'page', description: panel.description || null, units: panel.units } : { view: panel.view }),
    data, sources: status
  };
}

/* ---------- scaffolds: ready pages a seat copies and customises (company/console/scaffolds/<name>/) ----------
 * A scaffold is page.json (source globs say {{data}}/<file>), README.md and sample/ (data files). Sample times are
 * written as {{t:-2h}}, {{t:+3d}} or {{t:+1d@09:30}} (a wall time in the company timezone) and become ISO times when
 * the scaffold is copied, so a fresh page always shows "today". The copy lands in the seat's working folder: the page
 * in company/work/<seat>/pages/<id>/, the sample data in company/work/<seat>/page-data/<id>/, and the globs point
 * there. The seat then edits it, points the sources at its real files, validates, previews and adds as usual. */
function listScaffolds(r) {
  const P = paths(r);
  return listDir(P.scaffolds).filter(n => fs.existsSync(path.join(P.scaffolds, n, 'page.json'))).map(n => {
    const p = readJson(path.join(P.scaffolds, n, 'page.json'), {}) || {};
    return { name: n, title: p.title || n, description: p.description || '', units: (p.units || []).map(u => u.view && u.view.kind), samples: listFiles(path.join(P.scaffolds, n, 'sample')) };
  });
}
function listFiles(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort(); } catch (_) { return []; } }
function tzOffsetMs(t, tz) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const o = {}; for (const x of f.formatToParts(t)) o[x.type] = x.value;
    return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(t / 1000) * 1000;
  } catch (_) { return 0; }
}
/* {{t:<+|-><n><m|h|d>[@HH:MM]}} -> ISO time, relative to `now`, wall time in `tz` */
function sampleTimes(text, now, tz) {
  return String(text).replace(/\{\{t:([+-])(\d{1,4})([mhd])(?:@(\d{2}):(\d{2}))?\}\}/g, (_, sign, n, unit, hh, mm) => {
    const k = (sign === '-' ? -1 : 1) * Number(n);
    if (unit !== 'd' || hh == null) return new Date(now + k * { m: 6e4, h: 36e5, d: 864e5 }[unit]).toISOString();
    const local = now + tzOffsetMs(now, tz);                       // wall clock in tz, as if UTC
    const d = new Date(local + k * 864e5);
    const wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(hh), Number(mm));
    return new Date(wall - tzOffsetMs(wall, tz)).toISOString();
  });
}
function companyTz(r) {
  if (paths(r).root === co.ROOT) return process.env.CAPHEOS_TZ || (co.config && co.config.timezone) || co.TZ || 'UTC';
  const c = readJson(path.join(paths(r).root, 'company', 'company.json'), {}) || {};
  return process.env.CAPHEOS_TZ || c.timezone || 'UTC';
}
function cmdScaffold(name, opts, r) {
  r = r || root(); const P = paths(r); opts = opts || {};
  const all = listScaffolds(r);
  if (!name || name === true) return { code: 2, out: { ok: false, error: 'scaffold <name> --as <id> --by <seat>; scaffolds: ' + all.map(x => x.name).join(', ') } };
  const src = path.join(P.scaffolds, String(name));
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(String(name)) || !fs.existsSync(path.join(src, 'page.json'))) return { code: 1, out: { ok: false, error: 'no scaffold "' + name + '"; scaffolds: ' + all.map(x => x.name).join(', ') } };
  const id = opts.as && opts.as !== true ? String(opts.as) : String(name);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return { code: 2, out: { ok: false, error: '--as must be a lowercase kebab-case id, 2 to 40 characters' } };
  let seatId = null;
  if (opts.by && opts.by !== true) { const s0 = isOwner(opts.by) ? { id: 'owner' } : findSeat(opts.by, r); if (!s0) return { code: 1, out: { ok: false, error: '--by ' + opts.by + ' is not a seat in loops.json or the owner' } }; seatId = s0.id; }
  const under = d => { const a = path.resolve(r, d); return a.startsWith(path.join(P.root, 'company', 'work') + path.sep) ? a : null; };
  const dir = opts.dir && opts.dir !== true ? under(opts.dir) : seatId ? path.join(P.root, 'company', 'work', seatId, 'pages', id) : null;
  if (!dir) return { code: 2, out: { ok: false, error: opts.dir ? '--dir must be under company/work/' : '--by <seat> (or --dir under company/work/) is required' } };
  if (path.basename(dir) !== id) return { code: 2, out: { ok: false, error: 'the page folder must be named after the id (' + id + ')' } };
  const dataDir = opts.data && opts.data !== true ? under(opts.data) : path.join(path.dirname(path.dirname(dir)), 'page-data', id);
  if (!dataDir) return { code: 2, out: { ok: false, error: '--data must be under company/work/' } };
  if (fs.existsSync(dir) && !opts.force) return { code: 1, out: { ok: false, error: rel(dir, r) + ' already exists; edit it, or pass --force to overwrite it with a fresh copy' } };
  const now = Date.now(); const tz = companyTz(r); const dataRel = path.relative(r, dataDir).split(path.sep).join('/');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(dataDir, { recursive: true });
  const page = JSON.parse(fs.readFileSync(path.join(src, 'page.json'), 'utf8').split('{{data}}').join(dataRel));
  page.id = id; delete page.$schema;
  if (opts.nav && opts.nav !== true) page.placement = Object.assign({}, page.placement, { nav: String(opts.nav) });
  if (opts.owner && opts.owner !== true) page.owner = String(opts.owner);
  fs.writeFileSync(path.join(dir, 'page.json'), JSON.stringify(page, null, 2) + '\n');
  if (fs.existsSync(path.join(src, 'README.md'))) fs.copyFileSync(path.join(src, 'README.md'), path.join(dir, 'README.md'));
  const written = [];
  for (const f of listFiles(path.join(src, 'sample'))) {
    const dest = path.join(dataDir, f);
    if (fs.existsSync(dest) && !opts.force) continue;   // never overwrite data a routine already writes
    fs.writeFileSync(dest, sampleTimes(fs.readFileSync(path.join(src, 'sample', f), 'utf8'), now, tz)); written.push(rel(dest, r));
  }
  const d = rel(dir, r);
  return { code: 0, out: { ok: true, scaffold: name, id, dir: d, data: dataRel, written, next: [
    'edit ' + d + '/page.json: title, why, owner, nav, units; point sources at the files your routine writes',
    'node company/tools/console-panel.js validate ' + d,
    'node company/tools/console-panel.js render --page ' + d + ' --png /tmp/' + id + '.png   # look at it, light and dark (--theme dark), phone (--width 390)',
    'node company/tools/console-panel.js add ' + d + ' --by <you>'] } };
}

/* ---------- design tokens: the table in docs/CONSOLE-DESIGN.md is generated from console/ui/ds/tokens ---------- */
const TOKENS_BEGIN = '<!-- tokens:begin (generated by console-panel.js tokens --write; do not edit by hand) -->';
const TOKENS_END = '<!-- tokens:end -->';
function frameworkDir(r) { const a = path.join(paths(r).root, 'console', 'ui', 'ds', 'tokens'); return fs.existsSync(a) ? paths(r).root : path.join(__dirname, '..', '..'); }
function readTokens(r) {
  const dir = path.join(frameworkDir(r), 'console', 'ui', 'ds', 'tokens');
  const out = []; const seen = new Map();
  for (const f of ['colors.css', 'dataviz.css', 'typography.css', 'spacing.css', 'effects.css', 'dark.css']) {
    let css = ''; try { css = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    if (f === 'dark.css') {
      const block = (css.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/) || [])[1] || '';
      for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) { const t = seen.get(m[1]); if (t) t.dark = m[2].trim(); }
      continue;
    }
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const name = m[1]; if (seen.has(name)) continue;
      const group = f === 'colors.css' ? (/^--(espresso|robusta|clay|brass|jungle|linen|rust|paper|ink)/.test(name) ? 'brand palette (do not use directly)' : /^--status/.test(name) ? 'status' : 'colour role')
        : f === 'dataviz.css' ? 'chart' : f === 'typography.css' ? (/^--(type|tracking)/.test(name) ? 'type scale' : 'font') : f === 'spacing.css' ? (/^--space/.test(name) ? 'spacing' : 'layout') : /^--radius/.test(name) ? 'radius' : /^--shadow/.test(name) ? 'shadow' : 'effect';
      const t = { name, group, light: m[2].trim(), dark: null }; seen.set(name, t); out.push(t);
    }
  }
  return out;
}
function tokenTable(r) {
  const order = ['colour role', 'status', 'chart', 'type scale', 'font', 'spacing', 'radius', 'shadow', 'layout', 'effect', 'brand palette (do not use directly)'];
  const toks = readTokens(r).sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  const esc = x => String(x == null ? '' : x).replace(/\|/g, '\\|');
  const lines = [TOKENS_BEGIN, '', '| Token | Group | Light | Dark |', '|---|---|---|---|'];
  const byName = new Map(toks.map(t => [t.name, t]));
  const resolve = v => { const m = /^var\((--[a-z0-9-]+)\)$/.exec(v); const t = m && byName.get(m[1]); return t && /^#/.test(t.light) ? '`' + esc(v) + '` = `' + t.light + '`' : '`' + esc(v) + '`'; };
  for (const t of toks) lines.push('| `' + t.name + '` | ' + t.group + ' | ' + resolve(t.light) + ' | ' + (t.dark ? '`' + esc(t.dark) + '`' : 'same') + ' |');
  lines.push('', TOKENS_END);
  return lines.join('\n');
}
function designDoc(r) { return path.join(frameworkDir(r), 'docs', 'CONSOLE-DESIGN.md'); }
/* check (default) or write the generated table; { ok, drift, file } */
function cmdTokens(write, r) {
  const f = designDoc(r); let doc = '';
  try { doc = fs.readFileSync(f, 'utf8'); } catch (_) { return { code: 1, out: { ok: false, error: 'cannot read ' + f } }; }
  const a = doc.indexOf(TOKENS_BEGIN), b = doc.indexOf(TOKENS_END);
  if (a < 0 || b < a) return { code: 1, out: { ok: false, error: f + ' has no tokens:begin/end markers' } };
  const want = tokenTable(r); const have = doc.slice(a, b + TOKENS_END.length);
  if (have === want) return { code: 0, out: { ok: true, drift: false, file: rel(f, r), tokens: readTokens(r).length } };
  if (!write) return { code: 1, out: { ok: false, drift: true, file: rel(f, r), error: 'the token table in ' + rel(f, r) + ' is out of date: run node company/tools/console-panel.js tokens --write' } };
  fs.writeFileSync(f, doc.slice(0, a) + want + doc.slice(b + TOKENS_END.length));
  return { code: 0, out: { ok: true, drift: false, wrote: rel(f, r), tokens: readTokens(r).length } };
}

/* ---------- selftest (offline, temp copy of fixtures/console) ---------- */
function selftest() {
  const os = require('os');
  const FIX = path.join(__dirname, 'tests', 'fixtures', 'console');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-panel-'));
  fs.cpSync(path.join(FIX, 'root'), tmp, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'company', 'console'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'console', 'sources.json'), path.join(tmp, 'company', 'console', 'sources.json'));
  // a fixture tool in the allowlisted slot, so render runs a real child process offline
  fs.writeFileSync(path.join(tmp, 'company', 'tools', 'handoff-status.js'), "console.log(JSON.stringify([{due:'2030-01-01T09:00:00.000Z',raw:'2030-01-01 09:00',file:'company/work/handoffs/to-sam.md',line:3,heading:'## 2030-01-01 from Alex — check the ledger',overdue:false}]))\n");
  // the duties source (duty-status.js --json) as a fixture, so the Duties scaffold renders offline
  fs.writeFileSync(path.join(tmp, 'company', 'tools', 'duty-status.js'), "console.log(JSON.stringify([{id:'tool-parse',route:'tools',owner:'Sam',state:'ok',checkedAt:'2030-01-01T09:00:00.000Z',reason:null,history:['ok','ok']},{id:'handoff-status',route:'ceo',owner:'Alex',state:'due',checkedAt:'2030-01-01T09:00:00.000Z',reason:'1 OPEN handoff(s) past deadline',history:['ok','due']}]))\n");
  // a stub owner channel, so notify is proven without touching the real one
  fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){const r={id:'out-test',from,text};fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify(r)+'\\n');return r;}};\n");
  fs.writeFileSync(path.join(tmp, 'company', 'tools', 'inbox.js'), "const fs=require('fs'),p=require('path');fs.appendFileSync(p.join(__dirname,'..','owner','questions.jsonl'),JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({ok:true,id:'q-000001'}));\n");
  fs.mkdirSync(path.join(tmp, 'company', 'owner'), { recursive: true });
  const setGov = level => { fs.mkdirSync(path.join(tmp, 'company', 'state'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'company', 'state', 'governance.json'), JSON.stringify({ categories: { dashboard: level } })); };
  const examples = path.join(__dirname, '..', 'console', 'examples');
  let fails = 0; const t = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '  ' + JSON.stringify(detail).slice(0, 400))); if (!ok) fails++; };
  const has = (fs_, re) => fs_.some(f => re.test(f));
  const prevRoot = process.env.CONSOLE_ROOT; process.env.CONSOLE_ROOT = tmp;
  const done = () => { if (prevRoot === undefined) delete process.env.CONSOLE_ROOT; else process.env.CONSOLE_ROOT = prevRoot; fs.rmSync(tmp, { recursive: true, force: true }); };
  return (async () => {
    try {
      const sources = loadSources(tmp);
      const work = path.join(tmp, 'work-in-progress'); fs.mkdirSync(work);
      for (const ex of ['open-handoffs', 'trading-positions']) fs.cpSync(path.join(examples, ex), path.join(work, ex), { recursive: true });
      fs.rmSync(path.join(work, 'trading-positions', 'fixture'), { recursive: true, force: true });

      for (const ex of ['open-handoffs', 'trading-positions']) { const v = validateDir(path.join(work, ex), { root: tmp }); t('example ' + ex + ' validates', !v.findings.length, v.findings); }

      // bad panels from fixtures: each must fail with the named field
      const bad = readJson(path.join(FIX, 'bad-cases.json'), { base: {}, cases: [] });
      t('bad-case fixtures loaded', bad.cases.length >= 10);
      for (const c of bad.cases) {
        const panel = Object.assign({}, bad.base, c.patch || {});
        for (const k of c.drop || []) delete panel[k];
        const d = path.join(tmp, 'bad', panel.id || 'x'); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'panel.json'), JSON.stringify(panel));
        if (c.viewHtml) fs.writeFileSync(path.join(d, 'view.html'), c.viewHtml);
        const f = validatePanel(panel, d, { root: tmp, sources });
        t('refuses: ' + c.name, has(f, new RegExp(c.expect)), f);
        fs.rmSync(d, { recursive: true, force: true });
      }

      // glob safety
      for (const g of ['../secrets/x.json', '/etc/passwd.json', 'company/work/../../secrets/a.json', 'company/state/secrets/a.json', 'company/work/.env.json', 'company/work/x.sh', 'company/owner/inbound.jsonl', 'company/work/api-token.json'])
        t('glob refused: ' + g, checkGlob(g, sources).length > 0);
      t('glob allowed: company/work/desk/*.json', checkGlob('company/work/desk/*.json', sources).length === 0);
      // symlink escape: a link inside company/work pointing at secrets is never read
      fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'secrets', 'k.json'), '{"key":"x"}');
      try { fs.symlinkSync(path.join(tmp, 'secrets', 'k.json'), path.join(tmp, 'company', 'work', 'desk', 'link.json')); } catch (_) {}
      t('symlink not followed', !matchGlob('company/work/desk/*.json', sources, tmp).includes('company/work/desk/link.json'));

      // gate: approve -> proposed + question
      setGov('approve');
      let res = cmdAdd(path.join(work, 'open-handoffs'), 'Sam', tmp);
      t('approve gate parks the panel in proposed/', res.out.status === 'proposed' && fs.existsSync(path.join(tmp, 'company', 'console', 'proposed', 'open-handoffs', 'panel.json')) && !fs.existsSync(path.join(tmp, 'company', 'console', 'panels', 'open-handoffs')), res.out);
      t('approve gate files an owner question', res.out.asked && res.out.asked.asked === true, res.out);
      t('agent cannot approve', cmdApprove('open-handoffs', 'Sam', tmp).code === 1);
      res = cmdApprove('open-handoffs', 'owner', tmp);
      t('owner approves -> installed', res.code === 0 && fs.existsSync(path.join(tmp, 'company', 'console', 'panels', 'open-handoffs', 'panel.json')), res.out);

      // gate: notify -> installed + owner note
      setGov('notify');
      res = cmdAdd(path.join(work, 'trading-positions'), 'Alex', tmp);
      const outb = fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8');
      t('notify gate installs and tells the owner', res.out.status === 'installed' && res.out.told && res.out.told.told && /trading-positions/.test(outb), res.out);

      // unknown seat refused
      t('unknown --by refused', cmdAdd(path.join(work, 'open-handoffs'), 'Nobody', tmp).code === 1);

      // limit: today holds 6
      setGov('auto');
      const base = JSON.parse(fs.readFileSync(path.join(work, 'open-handoffs', 'panel.json'), 'utf8'));
      let lastCode = 0; let lastOut = null;
      for (let i = 1; i <= 6; i++) {
        const d = path.join(work, 'today-' + i); fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'panel.json'), JSON.stringify(Object.assign({}, base, { id: 'today-' + i, title: 'Today ' + i })));
        const x = cmdAdd(d, 'Sam', tmp); lastCode = x.code; lastOut = x.out;
      }
      t('seventh panel on Today refused (limit 6)', lastCode === 1 && has(lastOut.findings || [], /limit 6/), lastOut);

      // provenance
      const changes = fs.readFileSync(path.join(tmp, 'company', 'console', 'changes.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      t('provenance records propose, approve, add with by + digest', ['propose', 'approve', 'add'].every(op => changes.some(c => c.op === op && c.by && (op === 'approve' || c.digest))), changes);

      // hide: owner only, survives re-add
      t('agent cannot hide', cmdHide('trading-positions', 'Alex', tmp).code === 1);
      t('owner hides', cmdHide('trading-positions', 'owner', tmp).code === 0);
      res = cmdAdd(path.join(work, 'trading-positions'), 'Alex', tmp);
      t('re-added panel stays hidden', res.out.hidden === true, res.out);

      // ownership on change and remove
      t('a seat that does not answer for a panel cannot remove it', cmdRemove('trading-positions', 'Kim', tmp).code === 1);

      // render
      const rh = await render('open-handoffs', { root: tmp });
      t('render runs the allowlisted tool and passes its JSON', rh.ok && Array.isArray(rh.data.due) && rh.data.due.length === 1 && rh.type === 'capheos:panel-data', rh);
      const rt = await render('trading-positions', { root: tmp });
      t('render reads the file source', rt.ok && rt.data.positions && Array.isArray(rt.data.positions.positions), rt);
      t('render clamps refresh to the minimum', rt.refresh >= 30);
      const list = listPanels(tmp);
      t('list shows installed + hidden flag', list.some(x => x.id === 'trading-positions' && x.hidden) && list.some(x => x.id === 'open-handoffs' && x.valid), list);

      res = cmdRemove('trading-positions', 'Alex', tmp);
      t('panel owner removes', res.code === 0 && !fs.existsSync(path.join(tmp, 'company', 'console', 'panels', 'trading-positions')), res.out);

      /* ---------- page kit: every new kind's schema + validation, pages, scaffolds, tokens ---------- */
      const pv = (units, extra) => Object.assign({ version: 1, id: 'kit-page', title: 'Kit page', owner: 'tools', why: 'Selftest page used to prove the page kit validation.',
        placement: { area: 'screen', nav: 'Kit' }, sources: { rows: { type: 'file', glob: 'company/work/desk/positions.json' } }, units,
        actions: [{ id: 'mv', label: 'Move', kind: 'handoff', to: 'tools', scope: 'move', text: 'Move {{row.symbol}} from {{move.from}} to {{move.to}}.' },
          { id: 'ack', label: 'Acknowledge', kind: 'handoff', to: 'tools', scope: 'row', text: 'Ack {{row.symbol}}.' },
          { id: 'note', label: 'Ask for a note', kind: 'ask-ceo', scope: 'panel', text: 'A note on {{panel.title}} please.' }] }, extra || {});
      const checkPage = (page) => { const d = path.join(tmp, 'kit', page.id); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'page.json'), JSON.stringify(page)); return validatePage(page, d, { root: tmp, sources }); };
      const U = view => [{ id: 'u1', title: 'Unit', span: 6, view }];
      const GOOD = {
        kanban: { kind: 'kanban', source: 'rows', rows: 'positions', column: 'side', title: 'symbol', columns: [{ id: 'long', label: 'Long' }, { id: 'short', label: 'Short', limit: 3 }], steps: { done: 'a', total: 'b' }, move: 'mv' },
        calendar: { kind: 'calendar', source: 'rows', rows: 'positions', start: 'opened', title: 'symbol', view: 'week', views: ['week', 'agenda'] },
        'status-grid': { kind: 'status-grid', source: 'rows', rows: 'positions', name: 'symbol', state: 'side', stateMap: { long: 'ok', short: 'warn' }, history: 'h', historyN: 10 },
        positions: { kind: 'positions', source: 'rows', rows: 'positions', symbol: 'symbol', size: 'qty', entry: 'avg', mark: 'mark', totals: true },
        'chart area': { kind: 'chart', chart: 'area', source: 'rows', rows: 'positions', x: { key: 'at', time: true }, series: [{ key: 'pnl', label: 'P&L' }], refs: [{ label: 'Limit', value: -5, tone: 'bad' }] },
        'chart stacked-bar': { kind: 'chart', chart: 'stacked-bar', source: 'rows', rows: 'positions', x: { key: 'symbol' }, series: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
        'chart candlestick': { kind: 'chart', chart: 'candlestick', source: 'rows', rows: 'positions', x: { key: 'at', time: true }, ohlc: { open: 'o', high: 'h', low: 'l', close: 'c' } },
        'chart scatter': { kind: 'chart', chart: 'scatter', source: 'rows', rows: 'positions', x: { key: 'qty' }, series: [{ key: 'pnl', label: 'P&L' }] },
        gauge: { kind: 'gauge', source: 'rows', items: [{ label: 'Gross', value: 'gross', max: 100, warnAt: 0.7, badAt: 0.9 }, { label: 'Net', value: 'net', max: 'limits.net' }] },
        progress: { kind: 'progress', source: 'rows', items: [{ label: 'Target', value: 'x', max: 10, goodWhen: 'high' }] },
        'pipeline by': { kind: 'pipeline', source: 'rows', rows: 'positions', by: 'side', stuck: 'stuck', stages: [{ id: 'long', label: 'Long' }, { id: 'short', label: 'Short' }] },
        'pipeline rows': { kind: 'pipeline', source: 'rows', rows: 'positions', label: 'symbol', count: 'qty' },
        feed: { kind: 'feed', source: 'rows', rows: 'positions', at: 'at', title: 'symbol', severity: 'side', severityMap: { short: 'warn' }, acked: 'acked', ack: 'ack' }
      };
      for (const [k, v] of Object.entries(GOOD)) { const f = checkPage(pv(U(v))); t('page kit: a good ' + k + ' unit validates', !f.length, f); }
      const pnl = { version: 1, id: 'kit-panel', title: 'Kit panel', owner: 'tools', why: 'Selftest panel: a new kind works as a single panel too.', placement: { area: 'side', screen: 'work' }, sources: { rows: { type: 'file', glob: 'company/work/desk/positions.json' } }, view: GOOD.kanban, actions: pv([]).actions };
      { const d = path.join(tmp, 'kit', 'kit-panel'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'panel.json'), JSON.stringify(pnl)); const f = validatePanel(pnl, d, { root: tmp, sources }); t('page kit: a new kind works as a single panel', !f.length, f); }
      const mut = (k, patch) => Object.assign({}, GOOD[k], patch);
      const BAD = [
        ['kanban without column', U(Object.assign(mut('kanban'), { column: undefined })), /column: required/],
        ['kanban move naming no action', U(mut('kanban', { move: 'nope' })), /move: no action "nope"/],
        ['kanban move naming a row action', U(mut('kanban', { move: 'ack' })), /needs scope "move"/],
        ['calendar view "year"', U(mut('calendar', { view: 'year' })), /view: must be one of/],
        ['status-grid stateMap to a colour', U(mut('status-grid', { stateMap: { long: 'red' } })), /stateMap\.long: must be one of/],
        ['positions without mark', U(Object.assign(mut('positions'), { mark: undefined })), /mark: required/],
        ['chart kind pie', U(mut('chart area', { chart: 'pie' })), /chart: must be one of/],
        ['candlestick without ohlc', U(Object.assign(mut('chart candlestick'), { ohlc: undefined })), /ohlc: a candlestick chart names/],
        ['line chart without series', U(Object.assign(mut('chart area', { chart: 'line' }), { series: undefined })), /series: required/],
        ['scatter on a time axis', U(mut('chart scatter', { x: { key: 'at', time: true } })), /scatter plots two measures/],
        ['reference line with value and from', U(mut('chart area', { refs: [{ label: 'L', value: 1, from: 'limits.x' }] })), /exactly one of value/],
        ['gauge warnAt above badAt', U(mut('gauge', { items: [{ label: 'G', value: 'g', max: 1, warnAt: 0.95, badAt: 0.9 }] })), /warnAt: must be below badAt/],
        ['gauge max an object', U(mut('gauge', { items: [{ label: 'G', value: 'g', max: { x: 1 } }] })), /max: matches no allowed shape/],
        ['progress with no items', U(mut('progress', { items: [] })), /items: needs at least 1/],
        ['pipeline with both by and count', U(mut('pipeline by', { label: 'a', count: 'b' })), /either `by`/],
        ['pipeline with neither', U({ kind: 'pipeline', source: 'rows' }), /name `by`/],
        ['feed ack on a panel-wide action', U(mut('feed', { ack: 'note' })), /needs scope "row"/],
        ['feed ack without acked', U(Object.assign(mut('feed'), { acked: undefined })), /acked: an ack action needs/],
        ['a custom view in a page', U({ kind: 'custom', html: 'view.html' }), /custom views are single panels only/],
        ['a unit naming an unknown source', U(mut('positions', { source: 'nope' })), /no source named "nope"/],
        ['span 13', [{ id: 'u1', span: 13, view: GOOD.positions }], /span: above maximum 12/],
        ['duplicate unit ids', [{ id: 'u1', view: GOOD.positions }, { id: 'u1', view: GOOD.gauge }], /duplicate unit id/],
        ['a unit offering a non-row action', [{ id: 'u1', view: GOOD.positions, actions: ['note'] }], /is not a row action/],
        ['13 units', Array.from({ length: 13 }, (_, i) => ({ id: 'u' + i, view: GOOD.positions })), /units: at most 12/]
      ];
      for (const [name, units, re] of BAD) { const f = checkPage(pv(JSON.parse(JSON.stringify(units)))); t('page kit refuses: ' + name, has(f, re), f); }
      t('page kit refuses: a page placed on Today', has(checkPage(pv(U(GOOD.positions), { placement: { area: 'today' } })), /placement\.area: must be "screen"|placement\.nav: required/));
      t('page kit refuses: 9 sources', has(checkPage(pv(U(GOOD.positions), { sources: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['s' + i, { type: 'file', glob: 'company/work/desk/positions.json' }])) })), /sources: at most 8/));
      t('page kit refuses: {{move.to}} outside a move action', has(checkPage(pv(U(GOOD.positions), { actions: [{ id: 'x', label: 'Ask', kind: 'ask-ceo', scope: 'row', text: 'To {{move.to}} please' }] })), /needs scope "move"/));
      t('page kit refuses: a built-in nav label', has(checkPage(pv(U(GOOD.positions), { placement: { area: 'screen', nav: 'System' } })), /built-in console label/));
      t('page kit refuses: a stray file in the page folder', (() => { const d = path.join(tmp, 'kit', 'kit-page'); checkPage(pv(U(GOOD.positions))); fs.writeFileSync(path.join(d, 'data.json'), '{}'); return has(validatePage(pv(U(GOOD.positions)), d, { root: tmp, sources }), /holds page\.json and README\.md only/); })());

      // sample times: wall time in the company timezone
      const st = sampleTimes('{{t:+1d@09:30}}|{{t:-2h}}', Date.parse('2026-03-07T12:00:00Z'), 'America/New_York');
      t('sample times: {{t:+1d@09:30}} is 09:30 local the next day; {{t:-2h}} is two hours ago', st === '2026-03-08T14:30:00.000Z|2026-03-07T10:00:00.000Z' || st === '2026-03-08T13:30:00.000Z|2026-03-07T10:00:00.000Z', st);

      // scaffolds: copy -> validate -> add -> render, for every one that ships
      fs.cpSync(path.join(__dirname, '..', 'console', 'scaffolds'), path.join(tmp, 'company', 'console', 'scaffolds'), { recursive: true });
      const names = listScaffolds(tmp).map(x => x.name);
      t('five scaffolds ship', ['trading-desk', 'noc-health', 'production-board', 'calendar', 'client-portfolio'].every(n => names.includes(n)), names);
      for (const n of names) {
        const sc = cmdScaffold(n, { as: n, by: 'Sam' }, tmp);
        const dir = sc.out.dir ? path.join(tmp, sc.out.dir) : null;
        t('scaffold ' + n + ': copied into the seat\'s working folder with its data', sc.code === 0 && /^company\/work\/sam\/pages\//.test(sc.out.dir) && sc.out.written.length > 0 && !fs.readFileSync(path.join(dir, 'page.json'), 'utf8').includes('{{data}}'), sc.out);
        if (!dir) continue;
        const vf = validateDir(dir, { root: tmp }).findings; t('scaffold ' + n + ': validates', !vf.length, vf);
        const leftover = sc.out.written.filter(f => /\{\{t:/.test(fs.readFileSync(path.join(tmp, f), 'utf8'))); t('scaffold ' + n + ': every sample time filled in', !leftover.length, leftover);
        const ad = cmdAdd(dir, 'Sam', tmp); t('scaffold ' + n + ': add installs it into company/console/pages/', ad.code === 0 && ad.out.type === 'page' && fs.existsSync(path.join(tmp, 'company', 'console', 'pages', n, 'page.json')), ad.out);
        const rr = await render(n, { root: tmp }); t('scaffold ' + n + ': render resolves every source', rr.ok && rr.kind === 'page' && rr.units.length > 0 && Object.values(rr.sources).every(x => x.ok), rr.sources || rr);
      }
      t('scaffold refuses to overwrite a working copy', cmdScaffold('calendar', { as: 'calendar', by: 'Sam' }, tmp).code === 1);
      t('scaffold refuses an unknown name', cmdScaffold('nope', { as: 'x1', by: 'Sam' }, tmp).code === 1);
      t('scaffold refuses a --dir outside company/work', cmdScaffold('calendar', { as: 'cal2', dir: 'company/state/cal2' }, tmp).code === 2);
      const lp = listPanels(tmp);
      t('list shows pages with type, units and placement', names.every(n => lp.some(x => x.id === n && x.type === 'page' && x.placement === 'screen' && x.units > 0 && x.valid)), lp);
      t('changes.jsonl records a page add', fs.readFileSync(path.join(tmp, 'company', 'console', 'changes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).some(c => c.op === 'add' && c.type === 'page' && c.digest));
      // the 8-screen limit counts pages: one page per scaffold so far, the rest up to 8 fit, the 9th does not
      let nineth = null; const more = 9 - names.length;
      for (let i = 1; i <= more; i++) { const sc = cmdScaffold('calendar', { as: 'cal-' + i, by: 'Sam', nav: 'Cal ' + i }, tmp); nineth = cmdAdd(path.join(tmp, sc.out.dir), 'Sam', tmp); if (i < more) t('page ' + (names.length + i) + ' of 8 installs', nineth.code === 0, nineth.out); }
      t('a ninth company screen is refused (limit 8)', nineth.code === 1 && has(nineth.out.findings || [], /limit 8/), nineth.out);
      t('a page cannot reuse a panel id (or a panel a page id)', (() => { const d = path.join(tmp, 'kit', 'calendar'); fs.mkdirSync(d, { recursive: true }); const p0 = Object.assign({}, pnl, { id: 'calendar' }); fs.writeFileSync(path.join(d, 'panel.json'), JSON.stringify(p0)); return has(validatePanel(p0, d, { root: tmp, sources }), /already installed as a page/); })());
      t('owner hides a page', cmdHide('noc-health', 'owner', tmp).code === 0 && listPanels(tmp).some(x => x.id === 'noc-health' && x.hidden));
      t('a seat that does not answer for a page cannot remove it', cmdRemove('trading-desk', 'Kim', tmp).code === 1);
      res = cmdRemove('trading-desk', 'Alex', tmp);
      t('the page owner (finance) removes it', res.code === 0 && !fs.existsSync(path.join(tmp, 'company', 'console', 'pages', 'trading-desk')), res.out);

      // tokens: the doc table matches the CSS, and a drift is caught
      t('docs/CONSOLE-DESIGN.md token table matches console/ui/ds/tokens', cmdTokens(false, path.join(__dirname, '..', '..')).code === 0, cmdTokens(false, path.join(__dirname, '..', '..')).out);
      { const fw = path.join(tmp, 'fw'); fs.mkdirSync(path.join(fw, 'docs'), { recursive: true }); fs.cpSync(path.join(__dirname, '..', '..', 'console', 'ui', 'ds', 'tokens'), path.join(fw, 'console', 'ui', 'ds', 'tokens'), { recursive: true });
        fs.copyFileSync(path.join(__dirname, '..', '..', 'docs', 'CONSOLE-DESIGN.md'), path.join(fw, 'docs', 'CONSOLE-DESIGN.md'));
        fs.appendFileSync(path.join(fw, 'console', 'ui', 'ds', 'tokens', 'dataviz.css'), ':root{--chart-7:#000000;}\n');
        const d1 = cmdTokens(false, fw); const d2 = cmdTokens(true, fw); const d3 = cmdTokens(false, fw);
        t('a new token without a doc row is caught, and tokens --write fixes it', d1.code === 1 && d1.out.drift && d2.code === 0 && d3.code === 0, [d1.out, d3.out]); }
      { const css = fs.readFileSync(path.join(__dirname, '..', '..', 'console', 'ui', 'ds', 'tokens', 'dark.css'), 'utf8');
        const a = (css.match(/:root:not\(\[data-theme="light"\]\)\{([\s\S]*?)\}/) || [])[1], b = (css.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\}/) || [])[1];
        t('dark.css: the device-setting block and the data-theme block are the same', a && a.trim() === (b || '').trim()); }
    } catch (e) { t('selftest crashed', false, e.stack); }
    done();
    console.log(fails ? fails + ' FAILED' : 'ALL PASS');
    return fails ? 1 : 0;
  })();
}

module.exports = { render, validatePanel, validatePage, validateView, validateDir, listPanels, listScaffolds, cmdScaffold, cmdTokens, tokenTable, sampleTimes, loadSources, gateFor, resolveFileSource, lintViewHtml, checkGlob, paths, companyTz };

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
const emit = res => { console.log(JSON.stringify(res.out, null, 1)); process.exit(res.code); };
(async () => {
  if (cmd === 'selftest' || A.selftest) process.exit(await selftest());
  if (cmd === 'list') {
    const rows = listPanels();
    if (A.json) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
    if (!rows.length) console.log('no company panels (examples: company/console/examples/)');
    for (const x of rows) console.log((x.status === 'proposed' ? 'PROPOSED ' : x.hidden ? 'HIDDEN   ' : 'ON       ') + x.id.padEnd(24) + ' ' + String(x.placement || '?').padEnd(14) + ' ' + String(x.view || '?').padEnd(9) + ' owner ' + x.owner + (x.valid ? '' : '  (' + x.findings + ' findings: run validate)'));
    process.exit(0);
  }
  if (cmd === 'validate') {
    const dir = resolveDir(A._[1]);
    if (!dir) { console.error('validate <id|dir|panel.json>: not found: ' + A._[1]); process.exit(2); }
    const { findings } = validateDir(dir);
    if (A.json) console.log(JSON.stringify({ ok: !findings.length, findings }, null, 1));
    else { for (const f of findings) console.log(f); console.log(findings.length ? findings.length + ' finding(s)' : 'OK ' + rel(dir)); }
    process.exit(findings.length ? 1 : 0);
  }
  if (cmd === 'add') emit(cmdAdd(A._[1], A.by));
  if (cmd === 'approve') emit(cmdApprove(A._[1], A.by));
  if (cmd === 'reject') emit(cmdApprove(A._[1], A.by, undefined, true, A.note));
  if (cmd === 'remove') emit(cmdRemove(A._[1], A.by));
  if (cmd === 'hide') emit(cmdHide(A._[1], A.by));
  if (cmd === 'unhide') emit(cmdHide(A._[1], A.by, undefined, true));
  if (cmd === 'scaffolds') { const rows = listScaffolds(); if (A.json) console.log(JSON.stringify(rows, null, 1)); else for (const x of rows) console.log(x.name.padEnd(20) + ' ' + x.title + ' — ' + x.units.join(', ')); process.exit(0); }
  if (cmd === 'scaffold') emit(cmdScaffold(A._[1], { as: A.as, by: A.by, dir: A.dir, data: A.data, nav: A.nav, owner: A.owner, force: !!A.force }));
  if (cmd === 'tokens') {
    if (A.print) { console.log(tokenTable()); process.exit(0); }
    emit(cmdTokens(!!A.write));
  }
  if (cmd === 'render') {
    const target = A.page && A.page !== true ? A.page : A._[1];
    const res = await render(target, { live: !!A.live });
    if (!A.png && !A.serve) { console.log(JSON.stringify(res, null, A.json ? 1 : 2)); process.exit(res.ok ? 0 : 1); }
    // a picture of it, drawn by the console's own code (lib/page-preview.js)
    const pv = require('./lib/page-preview.js');
    const info = (() => { try { return { name: co.config.name, timezone: companyTz(), currency: co.config.currency || 'USD' }; } catch (_) { return {}; } })();
    const answer = res.ok || res.view || res.units ? res : Object.assign({ id: res.id || target }, res);
    const srv = await pv.serve(answer, { theme: A.theme === 'dark' ? 'dark' : A.theme === 'light' ? 'light' : null, company: info });
    if (A.serve) { console.log('preview: ' + srv.url + '  (Ctrl-C to stop; append ?theme=dark for the dark theme)'); return; }
    const shot = await pv.screenshot(srv.url, A.png === true ? (res.id || 'preview') + '.png' : A.png, { width: A.width, height: A.height, theme: A.theme });
    await srv.close();
    console.log(JSON.stringify({ ok: shot.ok && !!res.ok, png: shot.file || null, error: shot.error || (res.ok ? undefined : res.error), findings: res.findings, sources: res.sources }, null, 1));
    process.exit(shot.ok && res.ok ? 0 : 1);
  }
  console.error('usage: console-panel.js list [--json] | validate <id|dir> | add <dir> --by <seat> | scaffolds | scaffold <name> --as <id> --by <seat> | render --page <id|dir> [--png out.png] [--theme dark] [--width 390] [--serve] | tokens [--write|--print] | approve|reject <id> --by owner | remove <id> --by <seat> | hide|unhide <id> --by owner | render <id> --json [--live] | selftest');
  process.exit(2);
})();
