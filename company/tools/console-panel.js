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
 *   node company/tools/console-panel.js selftest
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
  return { root: r, console: c, panels: path.join(c, 'panels'), proposed: path.join(c, 'proposed'),
    examples: path.join(c, 'examples'), sources: path.join(c, 'sources.json'), changes: path.join(c, 'changes.jsonl'),
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
function installed(r) {
  const P = paths(r);
  return listDir(P.panels).map(id => ({ id, dir: path.join(P.panels, id), panel: readJson(path.join(P.panels, id, 'panel.json'), null) }));
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
  const screens = sources.screens || {};

  if (panel.id && path.basename(dir) !== panel.id) out.push(pf + ':id: must equal the folder name (' + path.basename(dir) + ')');
  if ((sources.reservedIds || []).includes(panel.id)) out.push(pf + ':id: reserved for the console');

  if (panel.owner && !FUNCTIONS.includes(panel.owner) && !findSeat(panel.owner, r)) out.push(pf + ':owner: not a function (' + FUNCTIONS.join(', ') + ') or a seat in loops.json');

  const pl = panel.placement || {};
  if (pl.area === 'side') {
    if ((screens.protected || []).includes(pl.screen)) out.push(pf + ':placement.screen: ' + pl.screen + ' is protected');
    else if (pl.screen && !(screens.sideAllowed || []).includes(pl.screen)) out.push(pf + ':placement.screen: side panels are allowed on ' + (screens.sideAllowed || []).join(', '));
  }
  if (pl.area === 'screen' && pl.nav && (screens.builtinLabels || []).some(l => l.toLowerCase() === String(pl.nav).trim().toLowerCase())) out.push(pf + ':placement.nav: "' + pl.nav + '" is a built-in console label');

  if (panel.refresh != null) {
    if (panel.refresh < (lim.minRefreshSeconds || 30)) out.push(pf + ':refresh: at least ' + (lim.minRefreshSeconds || 30) + ' seconds');
    if (lim.maxRefreshSeconds && panel.refresh > lim.maxRefreshSeconds) out.push(pf + ':refresh: at most ' + lim.maxRefreshSeconds + ' seconds');
  }

  const srcNames = Object.keys(panel.sources || {});
  if (lim.maxSourcesPerPanel && srcNames.length > lim.maxSourcesPerPanel) out.push(pf + ':sources: at most ' + lim.maxSourcesPerPanel);
  for (const n of srcNames) {
    const s = panel.sources[n] || {};
    if (s.type === 'file') for (const b of checkGlob(s.glob, sources)) out.push(pf + ':sources.' + n + '.glob: ' + b);
    if (s.type === 'tool' && (!(sources.tool || {})[s.id] || String(s.id).startsWith('_'))) out.push(pf + ':sources.' + n + '.id: "' + s.id + '" is not an allowlisted tool (sources.json tool: ' + Object.keys(sources.tool || {}).filter(k => !k.startsWith('_')).join(', ') + ')');
    if (s.type === 'station' && (!(sources.station || {})[s.id] || String(s.id).startsWith('_'))) out.push(pf + ':sources.' + n + '.id: "' + s.id + '" is not an allowlisted station endpoint (sources.json station: ' + Object.keys(sources.station || {}).filter(k => !k.startsWith('_')).join(', ') + ')');
  }

  const v = panel.view || {};
  const refs = [];
  if (v.source) refs.push(['view.source', v.source]);
  (v.items && v.kind === 'stat-row' ? v.items : []).forEach((it, i) => refs.push(['view.items[' + i + '].source', it.source]));
  (v.sources || []).forEach((s, i) => refs.push(['view.sources[' + i + ']', s]));
  for (const [field, name] of refs) if (name && !srcNames.includes(name)) out.push(pf + ':' + field + ': no source named "' + name + '" in sources');
  if (v.kind === 'markdown' && v.source && panel.sources && panel.sources[v.source] && panel.sources[v.source].type === 'file' && !/\.md$/i.test(panel.sources[v.source].glob || '')) out.push(pf + ':view.source: a markdown view reads a .md file');
  if (v.kind === 'custom') {
    const vh = path.join(dir, 'view.html');
    if (!fs.existsSync(vh)) out.push(pf + ':view.html: view.html is missing from the panel folder');
    else for (const x of lintViewHtml(fs.readFileSync(vh, 'utf8'), sources, rel(vh, r))) out.push(x);
    const h = lim.customHeight || {};
    if (v.height != null && ((h.min && v.height < h.min) || (h.max && v.height > h.max))) out.push(pf + ':view.height: between ' + h.min + ' and ' + h.max);
  } else if (fs.existsSync(path.join(dir, 'view.html'))) out.push(rel(path.join(dir, 'view.html'), r) + ': only a custom view may ship view.html');
  const extra = (() => { try { return fs.readdirSync(dir).filter(f => !['panel.json', 'view.html', 'README.md', 'fixture'].includes(f)); } catch (_) { return []; } })();
  for (const x of extra) out.push(rel(path.join(dir, x), r) + ': a panel folder holds panel.json, view.html and README.md only');

  const acts = panel.actions || [];
  if (lim.maxActionsPerPanel && acts.length > lim.maxActionsPerPanel) out.push(pf + ':actions: at most ' + lim.maxActionsPerPanel);
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
      if (!/^\{\{(row\.[A-Za-z0-9_.-]+|panel\.title)\}\}$/.test(m)) out.push(at + '.text: placeholder ' + m + ' (only {{row.<key>}} and {{panel.title}})');
      else if (m.startsWith('{{row.') && a.scope !== 'row') out.push(at + '.text: ' + m + ' needs scope "row"');
    }
    if (/\{\{|\}\}/.test(tpl.replace(/\{\{[^}]*\}\}/g, ''))) out.push(at + '.text: unbalanced braces');
  });

  // limits per placement (count installed panels in the same placement, hidden ones included, not counting itself)
  const key = placementKey(pl);
  const limitKey = pl.area === 'side' ? 'side' : pl.area;
  const max = (lim.perPlacement || {})[limitKey];
  if (max && pl.area) {
    const others = installed(r).filter(x => x.id !== panel.id && x.panel && placementKey(x.panel.placement) === key);
    if (others.length + 1 > max) out.push(pf + ':placement: ' + key + ' already holds ' + others.length + ' company panels (limit ' + max + '); remove one first');
    if (pl.area === 'screen' && pl.nav) {
      const clash = installed(r).find(x => x.id !== panel.id && x.panel && x.panel.placement && x.panel.placement.area === 'screen' && String(x.panel.placement.nav).toLowerCase() === String(pl.nav).toLowerCase());
      if (clash) out.push(pf + ':placement.nav: "' + pl.nav + '" is already used by ' + clash.id);
    }
  }
  return out;
}
/* An id (installed, then proposed, then examples) or a path. add prefers the path: you add from a working folder. */
function resolveDir(arg, r, preferPath) {
  const P = paths(r);
  if (!arg || typeof arg !== 'string') return null;
  const byPath = () => { const a = path.resolve(arg); return fs.existsSync(a) ? (fs.statSync(a).isDirectory() ? a : path.dirname(a)) : null; };
  const byId = () => { if (!/^[a-z][a-z0-9-]{1,39}$/.test(arg)) return null; for (const d of [P.panels, P.proposed, P.examples]) if (fs.existsSync(path.join(d, arg, 'panel.json'))) return path.join(d, arg); return null; };
  return preferPath ? (byPath() || byId()) : (byId() || byPath());
}
function validateDir(dir, opts) {
  const r = (opts && opts.root) || root();
  const pfile = path.join(dir, 'panel.json');
  let panel;
  try { panel = JSON.parse(fs.readFileSync(pfile, 'utf8')); } catch (e) { return { panel: null, findings: [rel(pfile, r) + ': ' + (fs.existsSync(pfile) ? 'not valid JSON: ' + e.message : 'missing')] }; }
  return { panel, findings: validatePanel(panel, dir, opts) };
}

/* ---------- state, provenance ---------- */
function consoleState(r) { const s = readJson(paths(r).state, {}) || {}; s.hidden = s.hidden || {}; return s; }
function writeState(s, r) { fs.mkdirSync(paths(r).console, { recursive: true }); fs.writeFileSync(paths(r).state, JSON.stringify(s, null, 2) + '\n'); }
function digest(dir) {
  const h = crypto.createHash('sha256');
  for (const f of ['panel.json', 'view.html']) { try { h.update(f + '\0' + fs.readFileSync(path.join(dir, f))); } catch (_) {} }
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
  for (const f of ['panel.json', 'view.html', 'README.md']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
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
  if (path.resolve(dir).startsWith(path.resolve(P.panels) + path.sep)) return { code: 2, out: { ok: false, error: 'already installed; add from a working folder' } };
  const { panel, findings } = validateDir(dir, { root: r });
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  const existing = readJson(path.join(P.panels, panel.id, 'panel.json'), null);
  if (existing && !owner && !answersFor(by, existing.owner, r) && !holdsFn(seat.seat, 'tools') && !holdsFn(seat.seat, 'ceo'))
    return { code: 1, out: { ok: false, error: panel.id + ' is owned by ' + existing.owner + '; only its owner, the tools or CEO seat, or the owner may change it' } };
  const gate = owner ? 'owner' : gateFor('dashboard', r);
  const from = path.relative(r, dir);
  const who = owner ? 'owner' : seat.seat.name || seat.id;
  const what = (existing ? 'changed' : 'added') + ' console panel "' + panel.title + '" (' + panel.id + ', ' + placementKey(panel.placement) + ', owner ' + panel.owner + ')';
  if (gate === 'approve') {
    copyPanel(dir, path.join(P.proposed, panel.id));
    const q = who + ' proposes a console panel: "' + panel.title + '" (' + placementKey(panel.placement) + '). Why: ' + panel.why
      + ' Recommendation: approve. Default if unanswered: not installed. Approve: node company/tools/console-panel.js approve ' + panel.id + ' --by owner';
    const asked = askOwner(q, who, r);
    const line = record({ op: 'propose', id: panel.id, by: who, gate, from, digest: digest(dir), question: asked.id || null }, r);
    return { code: 0, out: { ok: true, status: 'proposed', id: panel.id, dir: rel(path.join(P.proposed, panel.id), r), asked, change: line } };
  }
  copyPanel(dir, path.join(P.panels, panel.id));
  const line = record({ op: existing ? 'change' : 'add', id: panel.id, by: who, gate, from, digest: digest(dir) }, r);
  const told = gate === 'notify' ? tellOwner(who + ' ' + what + '. Why: ' + panel.why + ' Hide it any time: console-panel.js hide ' + panel.id + ' --by owner', who, r) : null;
  const hidden = !!consoleState(r).hidden[panel.id];
  return { code: 0, out: { ok: true, status: 'installed', id: panel.id, gate, hidden, told, change: line } };
}
function cmdApprove(id, by, r, reject, note) {
  r = r || root(); const P = paths(r);
  if (!isOwner(by)) return { code: 1, out: { ok: false, error: 'only the owner ' + (reject ? 'rejects' : 'approves') + ' a proposed panel' } };
  const src = path.join(P.proposed, String(id || ''));
  if (!id || !fs.existsSync(path.join(src, 'panel.json'))) return { code: 1, out: { ok: false, error: 'no proposed panel ' + id } };
  if (reject) { fs.rmSync(src, { recursive: true, force: true }); return { code: 0, out: { ok: true, status: 'rejected', change: record({ op: 'reject', id, by: 'owner', note: note || null }, r) } }; }
  const { findings } = validateDir(src, { root: r });
  if (findings.length) return { code: 1, out: { ok: false, findings } };
  copyPanel(src, path.join(P.panels, id));
  const d = digest(src); fs.rmSync(src, { recursive: true, force: true });
  return { code: 0, out: { ok: true, status: 'installed', id, change: record({ op: 'approve', id, by: 'owner', digest: d }, r) } };
}
function cmdRemove(id, by, r) {
  r = r || root(); const P = paths(r);
  const dir = path.join(P.panels, String(id || ''));
  const panel = readJson(path.join(dir, 'panel.json'), null);
  if (!id || !panel) return { code: 1, out: { ok: false, error: 'no installed panel ' + id } };
  const owner = isOwner(by); const seat = findSeat(by, r);
  if (!owner && !(seat && (answersFor(by, panel.owner, r) || holdsFn(seat.seat, 'tools') || holdsFn(seat.seat, 'ceo'))))
    return { code: 1, out: { ok: false, error: 'only the panel owner (' + panel.owner + '), the tools or CEO seat, or the owner may remove ' + id } };
  const who = owner ? 'owner' : seat.seat.name || seat.id;
  const d = digest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const gate = owner ? 'owner' : gateFor('dashboard', r);
  const line = record({ op: 'remove', id, by: who, gate, digest: d }, r);
  const told = gate === 'notify' || gate === 'approve' ? tellOwner(who + ' removed console panel "' + panel.title + '" (' + id + ').', who, r) : null;
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
    const v = sources ? validateDir(dir, { root: r, sources }) : { panel: readJson(path.join(dir, 'panel.json'), null), findings: ['sources.json unreadable'] };
    const p = v.panel || {};
    return { id: path.basename(dir), status, title: p.title || null, placement: p.placement ? placementKey(p.placement) : null,
      nav: p.placement && p.placement.nav || null, owner: p.owner || null, view: p.view && p.view.kind || null,
      refresh: p.refresh || (sources && sources.limits && sources.limits.defaultRefreshSeconds) || 300,
      hidden: !!s.hidden[path.basename(dir)], valid: !v.findings.length, findings: v.findings.length };
  };
  return listDir(P.panels).map(id => row('installed', path.join(P.panels, id)))
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
  const wanted = panel.view.kind === 'custom' && panel.view.sources ? panel.view.sources : Object.keys(panel.sources);
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
    hidden: !!consoleState(r).hidden[panel.id], view: panel.view, actions: panel.actions || [],
    data, sources: status
  };
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
    } catch (e) { t('selftest crashed', false, e.stack); }
    done();
    console.log(fails ? fails + ' FAILED' : 'ALL PASS');
    return fails ? 1 : 0;
  })();
}

module.exports = { render, validatePanel, validateDir, listPanels, loadSources, gateFor, resolveFileSource, lintViewHtml, checkGlob, paths };

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
  if (cmd === 'render') {
    const res = await render(A._[1], { live: !!A.live });
    console.log(JSON.stringify(res, null, A.json ? 1 : 2)); process.exit(res.ok ? 0 : 1);
  }
  console.error('usage: console-panel.js list [--json] | validate <id|dir> | add <dir> --by <seat> | approve|reject <id> --by owner | remove <id> --by <seat> | hide|unhide <id> --by owner | render <id> --json [--live] | selftest');
  process.exit(2);
})();
