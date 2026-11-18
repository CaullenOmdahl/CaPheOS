#!/usr/bin/env node
/* console/server.js — the owner console backend. Dependency-free (Node 22). Spec: docs/CONSOLE-API.md.
 *
 *   node console/server.js [--port N] [--host H]     serve the console (prints the login URL)
 *   node console/server.js --selftest                start against a temp copy of company/ and exercise the API
 *
 * Every write acts as the owner (co.config.owner.name) through the same tools the owner would run in a shell.
 * Root: company/tools/lib/company.js (env CAPHEOS_ROOT wins). Station: co.STATION_URL (env STARNET_URL wins).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const co = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'company.js'));
const TOOLS = co.p('company', 'tools');
const UI_DIR = path.join(__dirname, 'ui');
let OWNER = (co.config.owner && co.config.owner.name) || 'Owner';   // re-read after Setup renames the owner
const tool = name => require(path.join(TOOLS, name));

/* ---------------- small helpers ---------------- */
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };
// bounded reads (company/tools/lib/bounded.js, docs/RETENTION.md): a list endpoint never reads a whole growing file
const BOUNDED = require(path.join(TOOLS, 'lib', 'bounded.js'));
function tailLines(file, n) { try { return BOUNDED.tailLines(file, n); } catch (_) { return []; } }
/* Paging for list endpoints: ?limit=N (default per endpoint, at most 1000) and ?cursor=<from the last answer>. A file
 * list pages backwards from its end (cursor = the byte offset the next page ends at); an in-memory list by position.
 * Every answer carries { cursor, more }; the console's "Load more" passes the cursor back. */
const limitOf = (q, d) => { const n = Number(q && q.get && q.get('limit')); return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : d; };
const cursorOf = q => { const c = q && q.get && q.get('cursor'); if (c == null || c === '') return null; if (!/^\d{1,15}$/.test(c)) bad('cursor must be a number from a previous answer'); return Number(c); };
function filePage(file, q, d) { try { const p = BOUNDED.page(file, { limit: limitOf(q, d), cursor: cursorOf(q) }); return { lines: p.lines.slice().reverse(), cursor: p.cursor, more: p.more }; } catch (e) { if (e instanceof HttpError) throw e; return { lines: [], cursor: null, more: false }; } }
function arrayPage(arr, q, d) { const list = Array.isArray(arr) ? arr : []; const from = cursorOf(q) || 0; const n = limitOf(q, d); const items = list.slice(from, from + n); const next = from + items.length; return { items, cursor: next < list.length ? next : null, more: next < list.length, total: list.length }; }
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (msg, status) => { throw new HttpError(status || 400, msg); };

/* Run a company tool as a child process; JSON stdout (or stderr) is parsed, anything else comes back as { text }. */
function run(name, args, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    execFile(process.execPath, [path.join(TOOLS, name)].concat(args), { cwd: co.ROOT, timeout: opts.timeout || 30000,
      maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      let data = null;
      for (const s of [stdout, stderr]) { const t = String(s || '').trim(); if (!t) continue; try { data = JSON.parse(t); break; } catch (_) {} }
      if (data === null) data = { ok: code === 0, text: String(stdout || '').trim() || undefined, error: code ? (String(stderr || '').trim() || (err && err.killed ? 'timed out' : 'exit ' + code)) : undefined };
      resolve({ code, data, timedOut: !!(err && err.killed) });
    });
  });
}
/* run() as an HTTP answer: non-zero exit or ok:false → 4xx/5xx with the tool's own error. */
async function runApi(name, args, opts) {
  const r = await run(name, args, opts);
  const d = r.data;
  if (r.code === 0 && !(d && d.ok === false)) return Array.isArray(d) ? { ok: true, items: d } : (d && typeof d === 'object' && !('ok' in d) ? Object.assign({ ok: true }, d) : d);
  const status = r.timedOut ? 504 : r.code === 3 ? 403 : r.code === 2 ? 400 : (d && d.ok === false && r.code === 1) ? 400 : 500;
  throw new HttpError(status, (d && (d.error || d.text)) || 'tool failed', d);
}

/* ---------------- station ---------------- */
function stationToken() { try { return co.stationToken(); } catch (_) { return null; } }
function stationGet(p, timeoutMs) {
  return new Promise(resolve => {
    const token = stationToken(); if (!token) return resolve({ ok: false, error: 'no station token' });
    let u; try { u = new URL(co.STATION_URL + '/api/' + p); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { 'x-starnet-token': token } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(d) }); } catch (_) { resolve({ ok: false, status: res.statusCode, error: 'not JSON' }); } });
    });
    req.setTimeout(timeoutMs || 3000, () => req.destroy(new Error('station timeout')));
    req.on('error', e => resolve({ ok: false, error: 'station unreachable: ' + e.message }));
    req.end();
  });
}
/* JSON POST to the station (the Setup screen's provider connect): { ok, status, data } — never throws */
function stationPost(p, body, timeoutMs) {
  return new Promise(resolve => {
    const token = stationToken(); if (!token) return resolve({ ok: false, error: 'no station token' });
    let u; try { u = new URL(co.STATION_URL + '/api/' + p); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const data = JSON.stringify(body || {});
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'x-starnet-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200, status: res.statusCode, data: j, error: j ? undefined : 'not JSON' }); });
    });
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('station timeout')));
    req.on('error', e => resolve({ ok: false, error: 'station unreachable: ' + e.message }));
    req.end(data);
  });
}
const POST_ALLOW = ['run', 'run/steer', 'run/stream', 'cancel', 'groups', 'groups/*', 'cron/run', 'cron/update', 'cron/arm', 'loops/control',
  'consent/answer', 'permissions/*', 'autonomy/*', 'connectors/*', 'servicekeys/*', 'skills/toggle', 'providers/*', 'halt', 'halt/resume',
  'transcript/redact', 'session', 'consent',
  'auth/claude-cli/start', 'auth/claude-cli/poll', 'auth/claude-cli/code', 'auth/claude-cli/cancel'];
const postAllowed = p => POST_ALLOW.some(a => a.endsWith('/*') ? (p === a.slice(0, -2) || p.startsWith(a.slice(0, -1))) : p === a);
function stationProxy(req, res, sub, search) {
  if (!/^[A-Za-z0-9._~\-\/]+$/.test(sub) || sub.split('/').some(s => s === '..' || s === '.' || s === '')) return sendJson(res, 400, { ok: false, error: 'bad station path' });
  if (req.method === 'POST' && !postAllowed(sub)) return sendJson(res, 403, { ok: false, error: 'POST /api/' + sub + ' is not on the console allowlist' });
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
  const token = stationToken();
  if (!token) return sendJson(res, 502, { ok: false, error: 'station unavailable: no station token (secrets/station-token)' });
  let u; try { u = new URL(co.STATION_URL + '/api/' + sub + (search || '')); } catch (e) { return sendJson(res, 502, { ok: false, error: e.message }); }
  // the one gate (company/tools/lib/admit.js): a run started from the console is counted (door health for a health-check
  // stream, console otherwise). Phase 1 always allows: the body is read, recorded, and passed on unchanged.
  if (req.method === 'POST' && (sub === 'run' || sub === 'cron/run')) return admitThenProxy(req, res, sub, u, token);
  const headers = { 'x-starnet-token': token, accept: req.headers.accept || '*/*' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
  const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers }, ur => {
    const h = {}; for (const k of ['content-type', 'cache-control', 'content-length']) if (ur.headers[k]) h[k] = ur.headers[k];
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.setTimeout(30000, () => up.destroy(new Error('station timeout')));
  up.on('error', e => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'station unreachable: ' + e.message }); else res.end(); });
  res.on('close', () => up.destroy());
  if (req.method === 'POST') req.pipe(up); else up.end();
}

function admitThenProxy(req, res, sub, u, token) {
  const chunks = []; let size = 0, over = false;
  req.on('data', c => { size += c.length; if (size > 4 << 20) { over = true; req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (over) return sendJson(res, 413, { ok: false, error: 'body too large' });
    const buf = Buffer.concat(chunks);
    let b = {}; try { b = JSON.parse(buf.toString('utf8') || '{}') || {}; } catch (_) {}
    let tk = null;
    try {
      const health = sub === 'run' && /^(aicheck|health)/i.test(String(b.streamId || ''));
      tk = require(co.p('company', 'tools', 'lib', 'admit.js')).admit({ door: health ? 'health' : 'console', kind: 'run', seat: sub === 'run' ? String(b.agentId || 'agent') : null, jobId: sub === 'cron/run' ? String(b.id || '') : null, why: health ? 'console health check' : 'owner: ' + sub + ' from the console' });
    } catch (_) {}
    const headers = { 'x-starnet-token': token, accept: req.headers.accept || '*/*', 'content-type': req.headers['content-type'] || 'application/json', 'content-length': buf.length };
    const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers }, ur => {
      try { require(co.p('company', 'tools', 'lib', 'admit.js')).started(tk, { status: ur.statusCode }); } catch (_) {}
      const h = {}; for (const k of ['content-type', 'cache-control', 'content-length']) if (ur.headers[k]) h[k] = ur.headers[k];
      res.writeHead(ur.statusCode || 502, h);
      ur.pipe(res);
    });
    up.setTimeout(30000, () => up.destroy(new Error('station timeout')));
    up.on('error', e => { if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'station unreachable: ' + e.message }); else res.end(); });
    res.on('close', () => up.destroy());
    up.end(buf);
  });
}

/* ---------------- auth ---------------- */
const TOKEN_FILE = path.join(co.SECRETS_DIR, 'console-token');
// sign-in, sessions, CSRF, rate limit, trusted proxy: console/auth.js (docs/DEPLOY-SERVER.md)
const AUTH = require(path.join(__dirname, 'auth.js'))({ co, tokenFile: TOKEN_FILE, HttpError });
const consoleToken = () => AUTH.token();
// headers for every answer: no framing by other sites, no referrer leaking an address; a stream is never buffered by a proxy
function baseHeaders(res, p) {
  res.setHeader('x-frame-options', 'SAMEORIGIN'); res.setHeader('referrer-policy', 'same-origin');   // same-origin: a form POST keeps its Origin (the CSRF check), other sites get no referrer
  if (p === '/api/events' || p.startsWith('/api/chat/') || p.startsWith('/api/station/') || p.startsWith('/api/now/run/')) res.setHeader('x-accel-buffering', 'no');
}

/* ---------------- responses ---------------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) { reject(new HttpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { if (!d.trim()) return resolve({}); try { const o = JSON.parse(d); resolve(o && typeof o === 'object' ? o : {}); } catch (_) { reject(new HttpError(400, 'body is not JSON')); } });
    req.on('error', reject);
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json' };
const FALLBACK_INDEX = '<!doctype html><meta charset="utf-8"><title>Console</title><body style="font-family:sans-serif;padding:2rem">' +
  '<h1>Owner console</h1><p>The API is up (<code>/api/today</code>). The UI (console/ui/index.html) is not built yet.</p></body>';
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { ok: false, error: 'GET only' });
  let rel; try { rel = decodeURIComponent(pathname); } catch (_) { return sendJson(res, 400, { ok: false, error: 'bad path' }); }
  if (rel.includes('\0') || rel.split(/[\/\\]/).includes('..')) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(UI_DIR, '.' + rel);
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (rel === '/index.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(req.method === 'HEAD' ? '' : FALLBACK_INDEX); }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- data ---------------- */
function questions() {
  const inbox = tool('inbox.js');
  let gates = []; try { gates = require(path.join(TOOLS, 'lib', 'governance.js')).pendingGates(); } catch (_) {}
  const byId = {}; for (const g of gates) byId[g.id] = g;
  let rec = {}; try { rec = tool('approvals.js').records(); } catch (_) {}   // approvals: reminded (the Needs-you highlight)
  const st = inbox.state();
  return inbox.openQuestions().map(q => SERVICE_KEYS.markSaved(q)).map(q => Object.assign({}, q, { askerSeat: seatOf(q.from) }, byId[q.id] ? { gate: { category: byId[q.id].category, ref: byId[q.id].ref, by: byId[q.id].by, summary: byId[q.id].summary, fixedGate: (st[q.id] && st[q.id].gate && st[q.id].gate.fixedGate) || undefined } } : {},
    q.approval ? { approval: Object.assign({}, q.approval, { reminded: !!(rec[q.id] && rec[q.id].reminded), fixed: !!(rec[q.id] && rec[q.id].fixed) }) } : {}, cardParts(st[q.id])));
}
// an owner card's plain parts (company/tools/lib/owner-card.js: consequence, recommendation, the collapsed technical
// detail) and what yes does, in the console's own words (console/owner-needs.js describeEffect)
function cardParts(row) {
  if (!row) return {};
  const o = {};
  for (const k of ['consequence', 'recommendation', 'technical']) if (typeof row[k] === 'string' && row[k].trim()) o[k] = row[k].trim().slice(0, k === 'technical' ? 8000 : 600);
  if (row.effect) { o.effectSays = NEEDS.describeEffect(row.effect); o.effectKind = NEEDS.effectKind(row.effect) || 'unknown'; }
  if (row.effect || row.card) o.cardDigest = NEEDS.cardDigest(row);   // sent back with the answer: a yes applies only what was shown
  return o;
}
/* Needs you: only what still needs the owner (console/owner-needs.js classify); the rest is "The crew is handling" */
function ownerQuestions() {
  const all = questions(); let st = {}; try { st = tool('inbox.js').state(); } catch (_) {}
  return NEEDS.split(all, st);
}
// the crew seat id of a question's asker (by full or first name), for Discuss; null for a tool (onboard.js) or a stranger
function seatOf(from) {
  const f = String(from || '').trim().toLowerCase(); if (!f) return null;
  try { for (const [id, c] of Object.entries(co.crew() || {})) { const n = String((c && c.name) || '').toLowerCase(); if (n && (n === f || n.split(/\s+/)[0] === f || id.toLowerCase() === f)) return id; } } catch (_) {}
  return null;
}

/* ---------------- owner answers: typed forms and the secret store ----------------
 * A secret field's value is in the HTTP body only. This process writes secrets/<name> (0600, never over an existing
 * file unless the owner ticked replace), optionally checks it with the station, and hands inbox.js only
 * {stored, chars, validated}. The value is never written to pm-inbox.jsonl, a message, a log line, an SSE event or a
 * response body; error messages never quote it. */
const PEM = /-----BEGIN ([A-Z0-9 ]+)-----\s*([\s\S]+?)\s*-----END \1-----/;
function looksLikeKey(t) {
  const s = String(t || ''); if (!s) return false;
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(s)) return true;
  try { return tool('owner-inbox.js').redact(s) !== s; } catch (_) { return false; }
}
// a pasted PEM block whose line breaks were lost (a one-line field, a chat paste) is put back in its 64-column shape
function normalizeSecret(v) {
  let s = String(v == null ? '' : v).replace(/\r/g, '').trim();
  const m = PEM.exec(s);
  if (m) { const body = m[2].replace(/\s+/g, ''); if (/^[A-Za-z0-9+/=]+$/.test(body)) s = '-----BEGIN ' + m[1] + '-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END ' + m[1] + '-----'; }
  return s;
}
function writeSecret(name, value, replace) {
  const dir = co.SECRETS_DIR; const file = path.resolve(dir, name);
  if (path.dirname(file) !== path.resolve(dir)) bad('bad secret name', 400);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file) && !replace) throw new HttpError(409, 'secrets/' + name + ' already exists. Tick "replace the stored key" to overwrite it.', { code: 'exists', name });
  const tmp = path.join(dir, '.' + name + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, value + '\n', { mode: 0o600, flag: 'wx' });
  fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600);
  // the owner's change, for locked-watch.js (keys are class K): the hash of the exact bytes, never the value
  try { tool('provenance.js').wrote(file, value + '\n', 'console (owner key)'); } catch (_) {}
  return file;
}
// the secret fields of one form in a body: checked first (nothing written), then written by writePending
function prepareSecrets(inbox, form, values, b, act) {
  const pending = [];
  for (const f of form.fields.filter(x => x.type === 'secret')) {
    const raw = values[f.id]; delete values[f.id];
    if ((act && act.needs === 'none') || raw === undefined || raw === null || String(raw).trim() === '') continue;
    if (typeof raw !== 'string') bad((f.label || f.id) + ': paste the key as text');
    const value = normalizeSecret(raw);
    if (value.length > 16384) bad((f.label || f.id) + ': longer than 16 KB; is this the key?');
    const name = f.hinted && b.secretNames && b.secretNames[f.id] ? String(b.secretNames[f.id]).trim() : f.name;
    if (!inbox.safeSecretName(name)) bad('the file name under secrets/ may use letters, digits, . _ - (not station-token or console-token)');
    const replace = !!(b.replace && (b.replace === true || b.replace[f.id]));
    if (fs.existsSync(path.join(co.SECRETS_DIR, name)) && !replace) throw new HttpError(409, 'secrets/' + name + ' already exists. Tick "replace the stored key" to overwrite it.', { code: 'exists', field: f.id, name });
    // a MiniMax key: the endpoint picked next to the field ({endpoints: {<field id>: {region, baseUrl?, other?}}}), checked
    // now (400 before anything is written); none picked = the company's stored endpoint
    const mmEp = minimaxField(f) ? SETUP.mmWanted(b.endpoints && typeof b.endpoints === 'object' ? b.endpoints[f.id] : undefined) : null;
    pending.push({ f, name, value, replace, mmEp });
  }
  return pending;
}
// a secret field that holds a MiniMax key: validated as StarNet's `custom` provider against the MiniMax endpoint
const minimaxField = f => f.validate === 'custom' || (!f.validate && /minimax/i.test(String(f.name || '')));
const placeholderOf = p => ({ stored: 'secrets/' + (p.f.hinted ? p.f.name : p.name), chars: p.value.length });
async function writePending(pending, values) {
  for (const p of pending) {
    writeSecret(p.name, p.value, p.replace);
    let validated = null, validateError;
    if (p.f.validate || p.mmEp) {
      const v = await stationPost('providers/validate', Object.assign({ provider: p.f.validate || 'custom', key: p.value }, p.mmEp ? { baseUrl: p.mmEp.ep.baseUrl } : {}), 25000);
      if (!v.ok && !v.data) { validated = false; validateError = 'the station could not be reached to check it'; }
      else { validated = !!(v.data && v.data.credentialVerified); if (!validated) validateError = String((v.data && v.data.error) || 'not verified').split(p.value).join('[key]').slice(0, 120); }
      // the key works on the endpoint the owner picked: that endpoint becomes the company's (company.json)
      if (validated && p.mmEp && p.mmEp.explicit) { const prev = SETUP.minimaxEndpoint(); if (!prev.stored || !MME_same(p.mmEp.ep, prev)) SETUP.saveEndpoint(p.mmEp.ep, prev); }
      if (p.mmEp && validated === false) validateError = 'on MiniMax ' + p.mmEp.ep.label + ': ' + (validateError || 'not verified');
    }
    values[p.f.id] = Object.assign({ stored: 'secrets/' + p.name, chars: p.value.length, validated }, validateError ? { validateError } : {});
  }
}
/* the owner's answer, then what it asks for: a card's typed effect on yes (console/owner-needs.js applyEffect) and, when
 * the owner ticked "Make this a standing rule", the ruling (company/state/owner-rulings.json) */
async function answerQuestion(id, b) {
  b = b && typeof b === 'object' ? b : {};
  const q = questions().find(x => x.id === id); if (!q) bad('no open question ' + id, 404);
  const row = tool('inbox.js').state()[id] || {};
  const rule = b.rule && typeof b.rule === 'object' ? b.rule : (b.rule === true ? {} : null);
  let ruleDraft = null;
  if (rule) {   // checked before the answer is recorded, so a refused rule never leaves a half-done answer
    const words = String(rule.text || b.text || b.note || (b.values && (b.values.reason || b.values.answer)) || '').trim();
    // the same check that decides whether Today offers the tick (console/owner-needs.js ruleOffer): never a rule that
    // cannot work, and never an internal name in what the owner reads
    const offer = NEEDS.ruleOffer(q, row, []);
    if (!offer.ok) bad(offer.why + ' Your answer was not recorded; answer it without the rule.');
    if (words.length < 3) bad('Write the rule in your own words first (for example: “you decide these yourselves”).');
    ruleDraft = { text: words, effect: rule.effect, scope: offer.scope, fromCard: id };
  }
  const yes = (() => {
    if (b.parts || b.store) return false;
    if (b.verdict === 'yes' && !b.action) return true;
    const act = b.action ? (q.form.actions || []).find(a => a.id === String(b.action)) : null;
    return !!(act && act.verdict === 'yes');
  })();
  // a free-text reply that makes a standing rule on an approval card: the rule is saved and the card stays open (an
  // approval takes only Approve or Deny); the crew now has it, under "The crew is handling", where the owner can still decide
  if (ruleDraft && (row.approval || row.gate) && b.verdict === 'reply') {
    const ruling = NEEDS.addRuling(ruleDraft, bad);
    return { ok: true, id, state: 'open', ruling, rulingSaid: 'Saved as a standing rule: “' + ruling.text + '”. Questions like this one are now the crew\'s to decide; this one is under “The crew is handling”, where you can still decide it.' };
  }
  // a card whose yes does something: the answer must be to the card as the owner saw it (the page sends its cardDigest);
  // a card the asker updated since is refused before anything is recorded
  const acts = row.effect && NEEDS.effectKind(row.effect) && NEEDS.effectKind(row.effect) !== 'none';
  if (acts && yes && b.cardDigest !== NEEDS.cardDigest(row)) throw new HttpError(409, 'This card changed while you were reading it, so your answer was not recorded. Read it again, then answer.', { code: 'card-changed' });
  const r = await answerOne(id, b, q);
  const out = Object.assign({}, r);
  if (ruleDraft) { try { out.ruling = NEEDS.addRuling(ruleDraft, bad); out.rulingSaid = 'Saved as a standing rule: “' + out.ruling.text + '”. You can remove it in Settings › Autonomy.'; } catch (e) { out.rulingSaid = 'Your answer is recorded, but the standing rule was not saved: ' + e.message; } }
  if (row.effect && r && r.ok !== false && String(r.state || 'answered') !== 'open') {
    // the card still is what the owner saw (no update slipped in between their click and now), and its effect is the same
    const now = tool('inbox.js').state()[id] || {};
    if (yes && acts && NEEDS.cardDigest(now) !== b.cardDigest) { out.applied = { kind: NEEDS.effectKind(row.effect), applied: false, said: 'Your answer is recorded, but the card changed while you answered, so nothing was changed. The crew will ask again.' }; out.said = out.applied.said; }
    else if (yes) { out.applied = await NEEDS.applyEffect(row.effect, { runApi, owner: () => OWNER, id, card: q }); out.said = out.applied.said; }
    else out.said = 'Your answer is recorded. Nothing was changed.';
    try { emit('governance'); } catch (_) {}
  }
  return out;
}
async function answerOne(id, b, q) {
  const inbox = tool('inbox.js');
  const keyRefusal = 'this looks like a key or a private key. Put it in the secure field instead' + (q.form.fields.some(f => f.type === 'secret') ? '' : ' ("Store the key securely")') + ': it is stored as a file and never written into a message.';
  const row = inbox.state()[id];
  // an approval record (approvals.js, or an older gate question) is answered ONLY through the approval API, as the
  // Needs-you surface (set here, by this route); anything that is not an approve/deny is refused, never a plain answer
  if (row && (row.approval || row.gate)) {
    const act = !b.store && !b.parts && b.verdict !== 'reply' ? (q.form.actions.find(a => a.id === String(b.action || '')) || q.form.actions.find(a => a.verdict === b.verdict)) : null;
    if (!act || !(act.verdict === 'yes' || act.verdict === 'no')) bad(id + ' is an approval: answer it with Approve or Deny');
    return approvalAnswer(id, { verdict: act.verdict, shownDigest: b.shownDigest }, 'needs-you');
  }
  const noKeys = (form, values, note) => {
    for (const [k, v] of Object.entries(values)) { const f = form.fields.find(x => x.id === k); if (f && f.type !== 'secret' && looksLikeKey(typeof v === 'string' ? v : JSON.stringify(v))) bad('Not sent: ' + (f.label || k) + ': ' + keyRefusal); }
    if (looksLikeKey(note)) bad('Not sent: the note: ' + keyRefusal);
  };
  // the old "Store the key securely" on a request whose key is one of its questions: that question only
  if (q.questions && !b.parts && (b.action === 'store-key' || b.store)) {
    const kp = q.questions.find(p => p.kind === 'secret' && !p.answered);
    if (!kp) bad('no key question left to answer in ' + id);
    const sf = kp.form.fields.find(f => f.type === 'secret'); const v = (b.values || {})[b.store || 'key'] !== undefined ? (b.values || {})[b.store || 'key'] : (b.values || {})[sf.id];
    b = { parts: { [kp.id]: { action: (kp.form.actions.find(a => a.verdict === 'done') || kp.form.actions[0]).id, values: { [sf.id]: v }, replace: b.replace && (b.replace === true || b.replace[b.store || 'key']) ? { [sf.id]: true } : undefined,
      secretNames: b.secretNames && b.secretNames[b.store || 'key'] ? { [sf.id]: b.secretNames[b.store || 'key'] } : undefined,
      endpoints: b.endpoints && b.endpoints[b.store || 'key'] ? { [sf.id]: b.endpoints[b.store || 'key'] } : undefined } } };
  }
  // several questions in one request: {parts: {<question id>: {action, values, note, replace?, secretNames?}}, closeRest?}
  if (q.questions && (b.parts || b.closeRest)) {
    const parts = {}; const writes = [];
    for (const [pid, raw] of Object.entries(b.parts && typeof b.parts === 'object' ? b.parts : {})) {
      const p = q.questions.find(x => x.id === pid); if (!p) bad('no question "' + pid + '" in ' + id);
      const r0 = raw && typeof raw === 'object' ? raw : {};
      if (r0.verdict === 'reply') { if (looksLikeKey(r0.value)) bad('Not sent: ' + keyRefusal); parts[pid] = { verdict: 'reply', value: String(r0.value || '') }; continue; }
      const act = p.form.actions.find(a => a.id === String(r0.action)); if (!act) bad('question ' + (q.questions.indexOf(p) + 1) + ': no action "' + r0.action + '"');
      const values = Object.assign({}, r0.values && typeof r0.values === 'object' ? r0.values : {}); const note = r0.note == null ? '' : String(r0.note);
      noKeys(p.form, values, note);
      const pending = prepareSecrets(inbox, p.form, values, r0, act);
      const ph = Object.assign({}, values); for (const x of pending) ph[x.f.id] = placeholderOf(x);
      parts[pid] = { action: act.id, values: ph, note }; writes.push({ pid, pending, values, act, note });
    }
    try { inbox.computeParts(row, parts, !!b.closeRest); } catch (e) { bad(e.message); }   // dry run: a bad answer never leaves a key file behind
    const stored = [];
    for (const w of writes) { await writePending(w.pending, w.values); parts[w.pid] = { action: w.act.id, values: w.values, note: w.note }; stored.push(...w.pending.map(x => w.values[x.f.id])); }
    const r = wrap(() => inbox.answerParts({ id, by: OWNER, parts, closeRest: !!b.closeRest }));
    return Object.assign({}, r, { stored });
  }
  // the old body: {verdict: yes|no|reply, text}
  if (!b.action && !b.store && ['yes', 'no', 'reply'].includes(b.verdict)) {
    const text = String(b.text || '').trim();
    if (looksLikeKey(text)) bad('Not sent: ' + keyRefusal);
    if (b.verdict === 'reply') { if (!text) bad('text is required for a reply'); return inbox.answer({ id, by: OWNER, answer: { verdict: 'reply', value: text } }); }
    if (q.questions) return wrap(() => inbox.answer({ id, by: OWNER, answer: { verdict: b.verdict, note: text || undefined } }));
    const act = q.form.actions.find(a => a.verdict === b.verdict); if (!act) bad('this question has no ' + b.verdict + ' action (' + q.form.actions.map(a => a.id).join(', ') + ')');
    const hasReason = q.form.fields.some(f => f.id === 'reason');
    return wrap(() => inbox.answer({ id, by: OWNER, answer: { action: act.id, values: text && hasReason ? { reason: text } : {}, note: text && !hasReason ? text : undefined } }));
  }
  // storing a key inside a form that asks for more ({store: <field id>}, or a store-only action such as the old
  // "Store the key securely"): the file is written and recorded, the question STAYS OPEN for its final submit
  const actIn = b.action ? q.form.actions.find(a => a.id === String(b.action)) : null;
  const storing = b.store || (!q.secretOnly && (b.action === 'store-key' || (actIn && inbox.storeOnlyAction(q.form, actIn))));
  if (storing) {
    const values = Object.assign({}, b.values && typeof b.values === 'object' ? b.values : {});
    const only = b.store ? { [String(b.store)]: values[String(b.store)] } : values;
    const form = { fields: q.form.fields.filter(f => f.type === 'secret' && f.id in only), actions: [] };
    if (!form.fields.length) bad('no key to store: name a secret field of ' + id);
    const pending = prepareSecrets(inbox, form, only, b, null); if (!pending.length) bad('paste the key first');
    const out = {}; await writePending(pending, out);
    const stored = pending.map(p => wrap(() => inbox.recordStored(Object.assign({ id, by: OWNER, field: p.f.id }, out[p.f.id]))).stored);
    return { ok: true, id, state: 'open', stored, note: 'Key stored. The question stays open: answer the rest of it.' };
  }
  if (q.questions) bad('this request has ' + q.questions.length + ' questions: answer them with parts (or Reply to it as a whole)');
  if (!b.action) bad('verdict must be yes, no or reply, or name an action (' + q.form.actions.map(a => a.id).join(', ') + ')');
  const act = actIn; if (!act) bad('no action "' + b.action + '" on ' + id);
  const values = Object.assign({}, b.values && typeof b.values === 'object' ? b.values : {});
  const note = b.note == null ? '' : String(b.note);
  noKeys(q.form, values, note);
  // secrets: check everything first, then write the files, then record the answer
  const pending = prepareSecrets(inbox, q.form, values, b, act);
  // dry run of the answer with placeholders, so a bad field never leaves a key file behind
  const placeholder = Object.assign({}, values); for (const p of pending) placeholder[p.f.id] = placeholderOf(p);
  try { inbox.checkAnswer(row, { action: act.id, values: placeholder, note }); } catch (e) { bad(e.message); }
  await writePending(pending, values);
  // a hinted field stored under another name than the suggestion still records the real path
  const r = wrap(() => inbox.answer({ id, by: OWNER, answer: { action: act.id, values, note } }));
  return { ok: true, id, state: r.state, a: r.a, answer: r.answer, stored: pending.map(p => values[p.f.id]) };
}
function wrap(fn) { try { return fn(); } catch (e) { throw new HttpError(e.code === 3 ? 403 : e.code === 4 ? 404 : 400, e.message); } }
function answered(since) {
  const st = tool('inbox.js').state();
  const today = co.localParts().date;
  const sinceMs = since ? Date.parse(since) : NaN;
  return Object.values(st).filter(x => x.type === 'answer' || (x.a && x.q)).filter(x => x.a)
    .filter(x => Number.isFinite(sinceMs) ? Date.parse(x.at) >= sinceMs : co.localParts(new Date(x.at)).date === today)
    .map(x => ({ id: x.id, from: x.from, about: x.about, q: x.q, message: x.message, answer: x.a, answeredAt: x.at }))
    // questions their asker withdrew ("no longer needed"): one line each, "withdrawn by <asker>: <why>"
    .concat(tool('inbox.js').withdrawnSince(0).filter(w => Number.isFinite(sinceMs) ? Date.parse(w.at) >= sinceMs : co.localParts(new Date(w.at)).date === today)
      .map(w => ({ id: w.id, part: w.part, from: w.from, message: w.message, withdrawn: { by: w.by, why: w.why }, answer: 'withdrawn by ' + w.by + ': ' + w.why, answeredAt: w.at })));
}
function ownerMessages() {
  const oi = tool('owner-inbox.js');
  const ack = (readJson(co.p('company', 'state', 'owner-inbox.json'), {}) || {}).acked || {};
  const rows = oi.messages().map(m => Object.assign({ dir: 'in', acked: !!ack[m.id] }, m)).concat(oi.sent().map(m => Object.assign({ dir: 'out' }, m)));
  return rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}
// the owner channel with what each message is waiting on (console/chat.js): never a message with no visible state
async function ownerChannel() {
  const ch = await CHAT.channelState();
  return { ok: true, messages: CHAT.messageStates(ownerMessages(), ch), channel: ch };
}
function postOwnerMessage(body) {
  let text = String(body.text || '').trim(); if (!text) bad('text is required');
  if (text.length > 20000) bad('text too long');
  if (body.to) {
    const names = Object.values(co.crew()).map(s => s && s.name).filter(Boolean);
    const to = names.find(n => n.toLowerCase() === String(body.to).trim().toLowerCase());
    if (!to) bad('no crew member named ' + body.to);
    text = to + ', ' + text;
  }
  const oi = tool('owner-inbox.js');
  const file = oi.INBOUND();
  const row = { id: 'in-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex'), at: new Date().toISOString(), from: OWNER, text };
  if (body.re) row.re = String(body.re);
  // recorded in the provenance log before it is written: only lines the console or the owner's tools recorded count as
  // the owner's (company/tools/lib/owner-channel.js); a line appended by anyone else is ignored and quarantined
  require(co.p('company', 'tools', 'lib', 'owner-channel.js')).append(file, row, 'console');
  return { ok: true, message: Object.assign({ dir: 'in' }, row) };
}
async function crewView() {
  const c = co.crew();
  const seats = Object.entries(c).map(([id, s]) => Object.assign({ id }, s));
  // the crew lives in the station save (GET /api/save; /api/roster is POST-only), read through station-crew.js
  let r = { ok: false, error: 'station-crew.js unavailable' }, list = null;
  try {
    const SC = require(co.p('company', 'tools', 'station-crew.js'));
    const sv = await Promise.race([SC.getSave(), new Promise((_, rej) => setTimeout(() => rej(new Error('station did not answer')), 3000))]);
    const rw = SC.rows(sv.doc); const arr = rw instanceof Map ? [...rw.values()] : Array.isArray(rw) ? rw : Object.values(rw || {});
    list = arr.map(a => Object.assign({}, a, { approvalMode: a.approvalMode || a.approval || null }));
    r = { ok: true };
  } catch (e) { r = { ok: false, error: e.message }; }
  if (Array.isArray(list)) for (const s of seats) { const hit = list.find(x => x && (x.id === s.id || x.agentId === s.id)); if (hit) s.station = hit; }
  // a hired seat: when and in which round, and its first run since (or that it is still to come): runs.jsonl, else its
  // loop routine's last run (GET /api/cron) when that came after the hire
  let jobs = null;
  for (const s of seats) {
    if (!s.hiredIn) continue;
    const rd = readJson(co.p('company', 'hiring', String(s.hiredIn).replace(/[^a-z0-9-]/g, ''), 'round.json'), null);
    const c = rd && (rd.candidates || []).find(x => x.agentId === s.id);
    if (!c || !c.hiredAt) continue;
    s.hire = { round: s.hiredIn, at: c.hiredAt, by: c.hiredBy || null, pickedBy: rd.pick ? rd.pick.by : null };
    s.firstRun = firstRunSince(s.id, Date.parse(c.hiredAt) - 1000);
    if (!s.firstRun) {
      if (jobs === null) { try { const cr = await stationGet('cron', 2500); jobs = cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : []; } catch (_) { jobs = []; } }
      const j = jobs.find(x => x.agentId === s.id && x.lastRunAt && Date.parse(x.lastRunAt) >= Date.parse(c.hiredAt) - 1000);
      if (j) s.firstRun = { runId: j.lastRunId || null, at: j.lastRunAt, outcome: j.lastStatus === 'ok' ? 'succeeded' : j.lastStatus || null, routine: j.name };
    }
  }
  return { ok: true, seats, station: r.ok ? 'up' : 'down', stationError: r.ok ? undefined : r.error };
}
function decisions(q) { const p = filePage(co.p('company', 'work', 'decisions.md'), q, 100); return { ok: true, entries: p.lines.map(text => ({ text })), cursor: p.cursor, more: p.more }; }
function dispatchView(q) {
  const p = filePage(co.p('company', 'work', 'dispatch-log.md'), q, 60);
  return { ok: true, state: readJson(co.p('company', 'work', 'dispatch-state.json'), null), log: p.lines, cursor: p.cursor, more: p.more };
}
// every round with its live stage (hire.js roundStage: candidates created, interviewing 2/3, waiting for pick by X, hired)
function hiringRounds() {
  const dir = co.p('company', 'hiring'); const rounds = [];
  let H = null; try { H = tool('hire.js'); } catch (_) {}
  try { for (const d of fs.readdirSync(dir)) { const r = readJson(path.join(dir, d, 'round.json'), null); if (!r) continue;
    let stage = null; try { stage = H ? H.roundStage(path.join(dir, d), r) : null; } catch (_) {}
    rounds.push(Object.assign({ id: d }, r, { stage })); } } catch (_) {}
  return rounds;
}
// a seat's first run since it was hired (runs.jsonl), for the Crew screen
// (runs.jsonl is StarNet's and only grows: only the part since the hire is read, from the end, at most 32 MB)
function firstRunSince(agentId, sinceMs) {
  let rows = []; try { rows = BOUNDED.jsonlWindow(co.p('.starnet-data', 'workspaces', 'runs.jsonl'), { sinceMs, maxBytes: 32 * BOUNDED.MB }).rows; } catch (_) {}
  for (const r of rows) {
    const at = Number(r.startedAt || r.endedAt || r.ts) || 0;
    if (r && r.agentId === agentId && at >= sinceMs && !r.internal) return { runId: r.runId, at: new Date(at).toISOString(), outcome: r.outcome || (r.reason === 'done' ? 'succeeded' : r.reason || null) }; }
  return null;
}
function hiring() {
  const rounds = hiringRounds();
  let templates = []; try { templates = fs.readdirSync(co.p('company', 'roles', 'templates')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')); } catch (_) {}
  return { ok: true, rounds, templates };
}
// GET /api/spend: the owner's Spend screen, read-only. Today's pay-per-token spend against the daily cap (the same
// numerator the dispatcher's cap uses: cap-numerator.js), by seat and by provider, and this week's subscription use.
async function spendView() {
  const b = readJson(co.p('company', 'work', 'finance', 'dispatch-budget.json'), {}) || {};
  let c = null, err = null; try { c = tool('cap-numerator.js').compute({ hours: 24 }); } catch (e) { err = e.message; }
  const crew = (() => { try { return co.crew(); } catch (_) { return {}; } })();
  const cands = {};
  try { const dir = co.p('company', 'hiring'); for (const d of fs.readdirSync(dir)) { const r = readJson(path.join(dir, d, 'round.json'), null); for (const x of (r && r.candidates) || []) if (x && x.agentId) cands[x.agentId] = { name: x.name || null, round: d }; } } catch (_) {}
  const [use, lim] = await Promise.all([usage(), runApi('pacer.js', ['limits', '--json'], { timeout: 15000 }).catch(() => null)]);
  const round = v => Math.round((Number(v) || 0) * 10000) / 10000;
  const subs = ['claude', 'minimax'].filter(k => lim && lim[k]).map(k => { const x = lim[k]; return { id: k, name: x.name, usedPct: x.usedPct, weekStop: x.weekStop, line: x.line, resetsAt: x.resetsAt, open: x.open, paceBy: x.paceBy, why: x.why }; });
  return { ok: true, windowHours: 24, known: !!c, error: err,
    today: { usd: round(c && c.metered), ownerPaidUsd: round(c && c.ownerPaid), capUsd: Number(b.dailyUsd) || 0, perSeatCapUsd: Number(b.perAgentUsd) || 0, inFlightRuns: c ? c.inFlightRuns : 0 },
    // an interview candidate (not in the crew) is flagged and named from its round, so Spend folds them into one row
    bySeat: Object.entries((c && c.byAgent) || {}).map(([id, usd]) => crew[id] ? { id, name: crew[id].name || id, candidate: false, usd: round(usd) }
      : { id, name: (cands[id] && cands[id].name) || co.nameOf(id) || id, candidate: !!cands[id] || /^cand-/.test(id), round: cands[id] ? cands[id].round : null, usd: round(usd) }).sort((a, z) => z.usd - a.usd),
    byProvider: Object.entries((c && c.byProvider) || {}).map(([id, x]) => ({ id, usd: round(x.usd), capped: x.capped })).sort((a, z) => z.usd - a.usd),
    subscriptions: subs,
    pacer: use && use.ok !== false ? { mode: use.mode, live: use.live, emergency: use.emergency || null, boost: use.boost || null, rail: use.rail || null, problems: use.problems || [] } : null };
}
async function usage() { try { return await runApi('pacer.js', ['status', '--json'], { timeout: 15000 }); } catch (e) { return { ok: false, error: e.message }; } }
function panelsList() { return tool('console-panel.js').listPanels(); }
async function today() {
  const since = Date.now() - 24 * 3600e3;
  const sp = ownerQuestions(); const qs = sp.needs;
  let unread = []; try { unread = tool('owner-inbox.js').unacked(); } catch (_) {}
  const outbound = (() => { try { return tool('owner-inbox.js').sent().filter(m => Date.parse(m.at) >= since); } catch (_) { return []; } })();
  const [crew, use] = await Promise.all([crewView(), usage()]);
  let panels = []; try { panels = panelsList().filter(p => p.status === 'installed' && !p.hidden && /^today/.test(String(p.placement || ''))).map(p => p.id); } catch (_) {}
  return { ok: true, company: companyInfo(), needsYou: { questions: qs, count: qs.length, blocking: qs.filter(q => q.blocking).length }, crewHandling: sp.handling.map(x => Object.assign({}, x, { question: undefined })),
    digest: NEEDS.digest(), crew, usage: use, overnight: { fromCompany: outbound, unreadByCompany: unread.length, dispatch: tailLines(co.p('company', 'work', 'dispatch-log.md'), 20) },
    halt: co.haltState(), panels, onboarding: onboardingBrief() };
}
function onboardingBrief() {
  const s = readJson(co.p('company', 'state', 'onboarding-state.json'), null) || {};
  const failed = s.checks && s.checks.results ? Object.keys(s.checks.results).filter(k => !s.checks.results[k].ok) : null;
  const k = (s.steps || {}).kickoff || null;
  let planOpen = false;
  if (k) { try { const c = co.crew()[co.ceo() || 'agent'] || {}; const t = fs.readFileSync(co.p('company', 'work', 'handoffs', c.inbox || 'to-founder.md'), 'utf8'); planOpen = t.split(/^(?=## )/m).some(b => /from onboard\.js — turn the charter into the first plan/.test(b) && /^\*\*Status:\*\*\s*OPEN\b/m.test(b)); } catch (_) {} }
  return { certified: !!s.certified, certifiedAt: s.certifiedAt || null, lastCertify: (s.checks || {}).at || null, failed,
    kickoff: k ? { status: k.status, at: k.at, note: k.note, planOpen } : null };
}
function companyInfo() { const c = co.config; const ceo = co.ceo() || 'agent'; return { name: c.name, shortName: c.shortName, owner: c.owner, ceo: { id: ceo, name: co.nameOf(ceo) }, timezone: process.env.CAPHEOS_TZ || c.timezone || co.TZ, station: { url: co.STATION_URL }, ownerChannel: c.ownerChannel, onboarding: onboardingBrief() }; }

const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
function panelDir(id) {
  for (const sub of ['panels', 'proposed']) { const d = co.p('company', 'console', sub, id); if (fs.existsSync(path.join(d, 'panel.json'))) return d; }
  return null;
}

/* ---------------- router ---------------- */
const onOff = v => (v === true || v === 'on') ? 'on' : (v === false || v === 'off') ? 'off' : bad('on must be true or false');
const str = (v, name) => { if (v === undefined || v === null || v === '') return null; const s = String(v); if (s.startsWith('--')) bad(name + ' may not start with --'); return s; };
const routes = [];
const route = (method, re, fn) => routes.push({ method, re, fn });
const SERVICE_KEYS = require(path.join(__dirname, 'service-keys.js'))({ co, bad, HttpError, tool, writeSecret, normalizeSecret, owner: () => OWNER });
const NEEDS = require(path.join(__dirname, 'owner-needs.js')).make({ co });   // Needs you vs the crew is handling, rulings, effects, the digest
const CHAT = require(path.join(__dirname, 'chat.js'))({ co, stationGet, bad, HttpError, tool, owner: () => OWNER });
/* a meeting seat's model: the seat's current chain entry (the loop routine's pair models.js keeps on it, else its roster
   row, else the company default: console/chat.js modelFor), with the routines read once a few seconds for all seats;
   a metered model under a $0 cap is held, as in the chat */
let meetJobs = { at: 0, jobs: [] };
async function meetingModel(id) {
  const s = CHAT.seatOf(id);
  if (Date.now() - meetJobs.at > 5000) { const cr = await stationGet('cron', 4000); meetJobs = { at: Date.now(), jobs: cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : [] }; }
  const m = await CHAT.modelFor(s, meetJobs.jobs);
  if (!m) return null;
  const h = CHAT.meteredHold(s, m); if (h) throw new Error(h.message);
  return m;
}
// the owner's meeting with the crew (console/meeting.js): turns through the station, tracked by the chat's runs
const MEET = require(path.join(__dirname, 'meeting.js'))({ co, HttpError, owner: () => OWNER, emit: t => emit(t), stationPost, runs: CHAT.runs,
  run: (name, args) => run(name, args, { timeout: 30000 }), modelFor: meetingModel, seatJobs: id => meetJobs.jobs.filter(j => j && j.agentId === id).map(j => j.id),
  // a seat mid-routine sits the turn out (the station's routines, read fresh: a turn never doubles a running loop)
  seatBusy: async id => { const cr = await stationGet('cron', 3000); const jobs = cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : []; return jobs.some(j => j && j.agentId === id && j.noAgent !== true && (j.inFlight || j.state === 'running')); } });
const ACT = require(path.join(__dirname, 'activity.js'))({ co, stationGet, emit: t => emit(t), tool });

route('GET', /^\/api\/company$/, () => Object.assign({ ok: true }, companyInfo()));
route('GET', /^\/api\/today$/, today);
// questions: only the cards that still need the owner (the badge counts these); crewHandling: the rest, read only
route('GET', /^\/api\/questions$/, () => { const sp = ownerQuestions(); return { ok: true, questions: sp.needs, crewHandling: sp.handling }; });
route('GET', /^\/api\/digest$/, (m, q) => NEEDS.digest({ hours: Math.min(72, Math.max(1, Number(q.get('hours')) || 24)) }));
// the Undo button on a digest line (lib/owner-notice.js action undo-decision): only for a line that carries it; the owner's
// "undo" goes to the crew as the owner's own message naming the decision (decision.js join() records it against the model)
route('POST', /^\/api\/digest\/undo$/, (m, q, b) => {
  const did = String((b && b.decisionId) || '');
  if (!/^d-[0-9a-f]{12}$/.test(did)) bad('which decision to undo?');
  const item = NEEDS.digest({ hours: 72 }).items.find(x => x.action && x.action.kind === 'undo-decision' && x.action.decisionId === did);
  if (!item) bad('That line has no undo any more (it is older than three days, or it was never one the crew can undo).', 404);
  const r = postOwnerMessage({ text: 'Please undo this decision: ' + item.text.replace(/\s*You can undo it on Today\.?$/, '') + ' (' + did + ')', re: did });
  try { emit('owner'); } catch (_) {}
  return { ok: true, said: 'Sent: the crew has your request to undo it, and the check that let it through is marked as wrong.', message: r.message };
});
route('GET', /^\/api\/rulings$/, () => ({ ok: true, rulings: NEEDS.rulings().map(r => Object.assign({}, r, { covers: ((r.scope && r.scope.categories) || []).map(NEEDS.catSay).concat((r.scope && r.scope.topics) || []) })) }));
route('POST', /^\/api\/rulings$/, (m, q, b) => ({ ok: true, ruling: NEEDS.addRuling({ text: b.text, effect: b.effect, scope: b.scope }, bad) }));
route('POST', /^\/api\/rulings\/(rule-[a-z0-9]+-[0-9a-f]{4}|r-[a-z0-9]{4,20})\/remove$/, m => NEEDS.removeRuling(m[1], bad));
// projects the crew asked to take over (company/tools/project.js): only the owner approves or revokes one
route('GET', /^\/api\/projects$/, () => runApi('project.js', ['list']));
route('POST', /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/(approve|revoke)$/, (m, q, b) => runApi('project.js', [m[2], '--id', m[1], '--by', OWNER]));
route('GET', /^\/api\/questions\/answered$/, (m, q) => ({ ok: true, answered: answered(q.get('since')) }));
route('POST', /^\/api\/questions\/(q-\d+)\/answer$/, (m, q, b) => answerQuestion(m[1], b));
route('POST', /^\/api\/questions\/(q-\d+)\/snooze$/, (m, q, b) => {
  if (!questions().some(x => x.id === m[1])) bad('no open question ' + m[1], 404);
  return wrap(() => tool('inbox.js').snooze({ id: m[1], until: String(b.until || ''), by: OWNER }));
});
route('GET', /^\/api\/owner\/messages$/, ownerChannel);
route('POST', /^\/api\/owner\/messages$/, async (m, q, b) => { const r = postOwnerMessage(b); const ch = await CHAT.channelState(); r.message = CHAT.messageStates([r.message], ch)[0]; r.channel = ch; return r; });
// live chat with a crew member (console/chat.js); POST /api/chat/<id>/send streams and is handled in makeServer
route('GET', /^\/api\/chat\/([A-Za-z0-9_-]{1,64})$/, m => CHAT.info(m[1]));
// the live chat runs in flight (console/chat-runs.js): scripts/restart-console.sh --when-idle waits for an empty list
route('GET', /^\/api\/console\/busy$/, () => ({ ok: true, chats: CHAT.runs.busy() }));
MEET.mount(route);
// plan identity and price (company/work/finance/subscriptions.json) with each plan's current use, and the prepaid balances:
// the OWNER's view (behind the console sign-in); the amounts never go to an agent, a log or a report
route('GET', /^\/api\/finance\/plans$/, () => {
  const SM = require(path.join(TOOLS, 'lib', 'subscription-meter.js')), PB = require(path.join(TOOLS, 'lib', 'provider-balance.js'));
  const plans = SM.plans().map(p => { const w = SM.windows(p.provider); return Object.assign({}, p, { use: [w.fiveHour ? Math.round(w.fiveHour.usedPct) + '% of the 5-hour window' : null, w.week ? Math.round(w.week.usedPct) + '% of the week' : null].filter(Boolean).join(', ') || 'use unknown' }); });
  const balances = {}; for (const [k, b] of Object.entries(PB.read())) balances[k] = { at: b.at, available: b.available, balances: b.balances || [], low: !!b.low };
  return { ok: true, plans, balances };
});
// chat actions (docs/CHAT-ACTIONS.md): a secret field in a chat block is stored here (the same writer as Today's key
// field); the reply says only where and how long. Approvals: the approval API over the existing owner-question
// records (company/tools/approvals.js); the expiry default (deny) and the reminders run server-side, here.
route('POST', /^\/api\/chat-actions\/secret$/, (m, q, b) => {
  const name = String(b.name || '').trim(); if (!tool('inbox.js').safeSecretName(name)) bad('the file name under secrets/ may use letters, digits, . _ - (not station-token or console-token)');
  if (typeof b.value !== 'string' || !b.value.trim()) bad('paste the key first');
  const value = normalizeSecret(b.value); if (value.length > 16384) bad('longer than 16 KB; is this the key?');
  writeSecret(name, value, !!b.replace);
  return { ok: true, stored: 'secrets/' + name, name, chars: value.length };
});
// Settings › Connections and keys › Service keys (console/service-keys.js): the keys in secrets/, never their values
route('GET', /^\/api\/service-keys$/, () => SERVICE_KEYS.list());
route('POST', /^\/api\/service-keys$/, (m, q, b) => SERVICE_KEYS.save(b));
// Settings › Connections and keys › <service> › Connect (console/connectors.js, docs/CONNECTORS.md): the owner's own
// sign-in to a CLI, run here on the station; the owner's browser may be on another machine. Owner token like every /api.
const CONNECTORS = require(path.join(__dirname, 'connectors.js'))({ co, bad, HttpError, tool, owner: () => OWNER });
process.on('exit', () => CONNECTORS.stopAll());   // a sign-in CLI runs in its own process group: it never outlives the console
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) if (!process.listenerCount(sig)) process.once(sig, () => { CONNECTORS.stopAll(); process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]); });
const CONN = '\\/api\\/connectors\\/([a-z0-9][a-z0-9-]{0,40})';
route('GET', /^\/api\/connectors$/, () => CONNECTORS.list());
route('GET', new RegExp('^' + CONN + '$'), m => CONNECTORS.status(m[1]));
route('GET', new RegExp('^' + CONN + '\\/session$'), (m, q, b, req) => CONNECTORS.session(m[1], req));
route('POST', new RegExp('^' + CONN + '\\/connect$'), (m, q, b, req) => CONNECTORS.start(m[1], b, req));
route('POST', new RegExp('^' + CONN + '\\/callback$'), (m, q, b) => CONNECTORS.callback(m[1], b));
route('POST', new RegExp('^' + CONN + '\\/code$'), (m, q, b) => CONNECTORS.code(m[1], b));
route('POST', new RegExp('^' + CONN + '\\/cancel$'), m => CONNECTORS.cancel(m[1]));
route('POST', new RegExp('^' + CONN + '\\/disconnect$'), (m, q, b) => CONNECTORS.disconnect(m[1], b));
const approvals = async () => { const A = tool('approvals.js'); try { await A.tick({ actor: 'the console' }); } catch (_) {} return A; };
route('GET', /^\/api\/approvals$/, async () => ({ ok: true, approvals: (await approvals()).list() }));
route('GET', /^\/api\/approvals\/(q-\d+)$/, async m => { const r = (await approvals()).get(m[1]); if (!r) bad('no approval record ' + m[1], 404); return Object.assign({ ok: true }, r); });
// the chat route: its surface is "chat", always. A body's `surface` is ignored (a crafted "console" or "needs-you" would
// otherwise answer a fixed gate from chat); approvals.js enforces the fixed-gate rule by record on top of that.
route('POST', /^\/api\/approvals\/(q-\d+)\/answer$/, (m, q, b) => approvalAnswer(m[1], b, 'chat'));
async function approvalAnswer(id, b, surface) {
  const r = await (await approvals()).answer(id, { verdict: b.verdict, shownDigest: b.shownDigest, surface, by: 'owner' });
  if (!r.ok) throw new HttpError({ missing: 404, closed: 409, stale: 409, authority: 403, unverified: 403, route: 409, held: 409 }[r.code] || 400, r.error, { code: r.code, link: r.link || null, status: r.status || null });
  return r;
}
// the crew's work, visible (console/activity.js)
route('GET', /^\/api\/now$/, () => ACT.now());
route('GET', /^\/api\/now\/run\/([A-Za-z0-9_-]{1,80})$/, (m, q) => ACT.runEvents(m[1], q.get('after')));
route('GET', /^\/api\/activity$/, async (m, q) => { const r = await ACT.recent(); if (!r || !Array.isArray(r.items)) return r; const p = arrayPage(r.items, q, 60); return Object.assign({}, r, { items: p.items, cursor: p.cursor, more: p.more, total: p.total }); });
route('GET', /^\/api\/crew$/, crewView);
route('GET', /^\/api\/handoffs$/, () => runApi('handoff-status.js', ['--due', '--json']));
// parked items in plain words (company/state/parked.json, written by the dispatcher every tick) and the watched jobs
// (lib/completions.js); Start now releases one parked item: a row in company/state/gate-releases.jsonl, then the
// dispatcher's next tick removes the gate and wakes the holder at once (company/HANDOFFS.md)
const GATES = () => require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'gates.js'));
const COMPL = () => require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'completions.js'));
route('GET', /^\/api\/handoffs\/parked$/, () => {
  const G = GATES(), C = COMPL(); const crew = co.crew(); const nm = id => (crew[id] && crew[id].name) || id;
  const p = co.readJson(G.PARKED(co.ROOT), {}) || {};
  const rel = G.releases(co.ROOT);
  const items = (p.items || []).filter(x => !rel.has(x.inbox + '\n' + x.heading)).map(x => ({ seat: x.seat, name: x.name || nm(x.seat), inbox: x.inbox, heading: x.heading, kind: x.kind, words: x.words, until: x.until || null }));
  const running = C.running(co.ROOT).map(r => ({ id: r.id, job: r.job || null, why: r.why || r.cmd || r.service, since: r.startedAt, wakes: (r.seat || []).map(nm) }));
  const completions = C.recent(co.ROOT, 12).reverse().map(r => ({ id: r.id, job: r.job || null, words: C.words(r), failed: C.failed(r), at: r.endedAt, wakes: (r.seat || []).map(nm) }));
  return { ok: true, at: p.at || null, items, running, completions };
});
route('POST', /^\/api\/handoffs\/start-now$/, (m, q, b) => {
  const inbox = str(b.inbox, 'inbox'), heading = str(b.heading, 'heading');
  if (!/^to-[\w.-]+\.md$/.test(inbox || '')) bad('inbox is a to-<name>.md file');
  if (!heading) bad('heading is required');
  let txt = ''; try { txt = fs.readFileSync(co.p('company', 'work', 'handoffs', inbox), 'utf8'); } catch (_) { bad('no such inbox', 404); }
  if (!txt.split(/^## /m).slice(1).some(sec => sec.split('\n')[0].trim() === heading)) bad('no such item in ' + inbox, 404);
  const r = GATES().release(co.ROOT, { by: OWNER, inbox, heading, why: 'Start now (Work › Handoffs)', writer: 'console (owner Start now)' });
  emit('handoffs');
  return { ok: true, release: r, text: 'Released. The holder is woken on the next check.' };
});
route('GET', /^\/api\/decisions$/, (m, q) => decisions(q));
route('GET', /^\/api\/dispatch$/, (m, q) => dispatchView(q));
route('GET', /^\/api\/hiring$/, hiring);
route('GET', /^\/api\/usage$/, usage);
route('GET', /^\/api\/spend$/, spendView);
// the subscription cutoffs (Settings › Models and subscriptions › Subscription cutoffs): read, and set through the recorded pacer.js limit
route('GET', /^\/api\/pacer\/limits$/, () => runApi('pacer.js', ['limits', '--json'], { timeout: 15000 }));
route('POST', /^\/api\/pacer\/limit$/, (m, q, b) => {
  const key = String(b.provider || ''); if (!['claude', 'minimax'].includes(key)) bad('provider is claude or minimax');
  const pct = (v, what) => { const n = Number(v); if (!(Number.isFinite(n) && n >= 0 && n <= 100)) bad(what + ' must be a number from 0 to 100'); return String(n); };
  const args = ['limit', key];
  if (b.weekStop != null && b.weekStop !== '') args.push('--week-stop', pct(b.weekStop, 'weekStop'));
  if (b.useNow != null && b.useNow !== '') args.push('--use-now', pct(b.useNow, 'useNow'));
  if (args.length === 2) bad('weekStop or useNow is required');
  return runApi('pacer.js', args.concat(['--by', OWNER, '--why', 'set by the owner in the console (Settings › Models and subscriptions)']));
});

route('GET', /^\/api\/governance$/, () => runApi('governance.js', ['show', '--json']));
route('POST', /^\/api\/governance\/preset$/, (m, q, b) => runApi('governance.js', ['preset', str(b.preset, 'preset') || bad('preset is required'), '--by', OWNER]));
route('POST', /^\/api\/governance\/set$/, (m, q, b) => runApi('governance.js', ['set', str(b.category, 'category') || bad('category is required'), str(b.level, 'level') || bad('level is required'), '--by', OWNER]));
route('GET', /^\/api\/guardrails$/, () => runApi('guardrails.js', ['show', '--json']));
route('POST', /^\/api\/guardrails\/set$/, (m, q, b) => {
  const args = ['set', str(b.name, 'name') || bad('name is required'), onOff(b.on), '--by', OWNER];
  if (b.why) args.push('--why', str(b.why, 'why'));
  return runApi('guardrails.js', args);
});
route('POST', /^\/api\/guardrails\/all$/, (m, q, b) => {
  const on = onOff(b.on) === 'on';
  const args = [on ? 'on-all' : 'off-all', '--by', OWNER];
  if (!on) args.push('--confirm', str(b.confirm, 'confirm') || bad('confirm is required to switch every guardrail off'));
  if (b.why) args.push('--why', str(b.why, 'why'));
  return runApi('guardrails.js', args);
});
route('POST', /^\/api\/guardrails\/sandbox$/, (m, q, b) => runApi('guardrails.js', ['sandbox', onOff(b.on), '--by', OWNER]));
route('GET', /^\/api\/halt$/, () => runApi('halt.js', ['status', '--json']));
route('POST', /^\/api\/halt\/soft$/, (m, q, b) => {
  const args = ['soft', '--by', OWNER];
  if (b.why) args.push('--why', str(b.why, 'why'));
  if (b.deadlineMin) { const n = Number(b.deadlineMin); if (!(n > 0)) bad('deadlineMin must be a positive number'); args.push('--deadline-min', String(n)); }
  if (b.escalate) args.push('--escalate');
  return runApi('halt.js', args, { timeout: 120000 });
});
route('POST', /^\/api\/halt\/hard$/, (m, q, b) => runApi('halt.js', ['hard', '--by', OWNER].concat(b.why ? ['--why', str(b.why, 'why')] : []), { timeout: 60000 }));
route('POST', /^\/api\/halt\/resume$/, () => runApi('halt.js', ['resume', '--by', OWNER], { timeout: 60000 }));
// background services (company/tools/service.js): Settings › System › Background services; stop/start/remove as the owner
route('GET', /^\/api\/services$/, () => runApi('service.js', ['list', '--json']));
route('POST', /^\/api\/services\/([A-Za-z0-9@_.:-]{2,80})\/(stop|start|remove)$/, m => runApi('service.js', [m[2], m[1], '--by', OWNER], { timeout: 60000 }));
route('GET', /^\/api\/cadence$/, () => runApi('cadence.js', ['show', '--json']));
route('POST', /^\/api\/cadence\/default$/, (m, q, b) => {
  const pos = (v, what) => { const n = Number(v); if (!(Number.isInteger(n) && n > 0)) bad(what + ' must be a whole number above 0'); return String(n); };
  const args = ['set-default'];
  if (b.minutes != null && b.minutes !== '') args.push(pos(b.minutes, 'minutes'));
  if (b.cooldown != null && b.cooldown !== '') args.push('--cooldown', pos(b.cooldown, 'cooldown'));
  if (b.maxPerTick != null && b.maxPerTick !== '') args.push('--max-per-tick', pos(b.maxPerTick, 'maxPerTick'));
  if (args.length === 1) bad('minutes, cooldown or maxPerTick is required');
  return runApi('cadence.js', args.concat(['--by', OWNER]));
});
// the owner's bounds and tempo (cadence.js bounds): what the crew may change on its own, and for how long
route('POST', /^\/api\/cadence\/bounds$/, (m, q, b) => {
  const args = ['bounds'];
  const range = (v, what) => { const a = Array.isArray(v) ? v : String(v).split(/[-,]/); if (a.length !== 2 || !a.every(x => Number.isInteger(Number(x)) && Number(x) > 0)) bad(what + ' is [low, high] minutes'); return a.map(Number).join('-'); };
  const pos = (v, what) => { const n = Number(v); if (!(Number.isInteger(n) && n > 0)) bad(what + ' must be a whole number above 0'); return String(n); };
  if (b.tickMin != null) args.push('--tick-min', range(b.tickMin, 'tickMin'));
  if (b.cooldownMin != null) args.push('--cooldown-min', range(b.cooldownMin, 'cooldownMin'));
  if (b.maxWakesPerHour != null) args.push('--max-wakes-per-hour', pos(b.maxWakesPerHour, 'maxWakesPerHour'));
  if (b.maxWakesPerDay != null) args.push('--max-wakes-per-day', pos(b.maxWakesPerDay, 'maxWakesPerDay'));
  if (b.quietHours !== undefined) args.push('--quiet-hours', b.quietHours ? str(b.quietHours, 'quietHours') : 'off');
  if (b.mode != null) { if (!['fixed', 'bounded-auto'].includes(b.mode)) bad('mode is fixed or bounded-auto'); args.push('--mode', b.mode); }
  if (b.autoExpireMin != null) args.push('--auto-expire-min', pos(b.autoExpireMin, 'autoExpireMin'));
  if (b.minChangeIntervalMin != null) args.push('--min-change-interval-min', pos(b.minChangeIntervalMin, 'minChangeIntervalMin'));
  if (args.length === 1) bad('nothing to set');
  return runApi('cadence.js', args.concat(['--by', OWNER]));
});
// Sprint (start-up): the owner's switch (cadence.js sprint on|off), and how it is going (sprint status)
route('GET', /^\/api\/cadence\/sprint$/, () => runApi('cadence.js', ['sprint', 'status', '--json']));
route('POST', /^\/api\/cadence\/sprint$/, (m, q, b) => {
  const on = onOff(b.on) === 'on';
  const args = ['sprint', on ? 'on' : 'off'];
  if (on && b.hours != null && b.hours !== '') { const n = Number(b.hours); if (!(n > 0 && n <= 336)) bad('hours must be above 0 and at most 336'); args.push('--hours', String(n)); }
  if (b.budgetUsd != null && b.budgetUsd !== '') { const n = Number(b.budgetUsd); if (!(n >= 0)) bad('budgetUsd must be a number >= 0'); args.push('--budget-usd', String(n)); }
  args.push('--by', OWNER, '--why', on ? 'switched on by the owner in the console' : 'switched off by the owner in the console');
  return runApi('cadence.js', args);
});
// Sprint's spread of the daily metered cap over the day: on, off, or off until midnight (cadence.js sprint config --spread)
route('POST', /^\/api\/cadence\/sprint\/spread$/, (m, q, b) => {
  const v = String(b.spread || ''); if (!['on', 'off', 'today'].includes(v)) bad('spread is on, off or today');
  return runApi('cadence.js', ['sprint', 'config', '--spread', v, '--by', OWNER, '--why', 'set by the owner in the console (Settings › Tempo)']);
});
route('POST', /^\/api\/cadence\/end-temporary$/, () => runApi('cadence.js', ['end-temporary', '--by', OWNER, '--why', 'ended by the owner in the console']));
route('POST', /^\/api\/cadence\/seat$/, async (m, q, b) => {
  const seat = str(b.seat, 'seat') || bad('seat is required');
  const args = ['set', seat];
  const add = (flag, v) => { if (v !== undefined && v !== null && v !== '') args.push(flag, typeof v === 'boolean' ? (v ? 'on' : 'off') : str(v, flag)); };
  add('--loop-every', b.loopEvery); add('--cooldown', b.cooldown); add('--priority', b.priority); add('--wake-on-inbox', b.wakeOnInbox); add('--wake-on-owner', b.wakeOnOwner);
  args.push('--by', OWNER);
  const set = await runApi('cadence.js', args);
  const apply = await run('cadence.js', ['apply', '--by', OWNER], { timeout: 60000 });
  return { ok: true, set, apply: apply.data };
});
route('GET', /^\/api\/panels$/, () => ({ ok: true, panels: panelsList() }));
route('GET', /^\/api\/panels\/([a-z0-9-]+)\/data$/, async (m, q) => {
  if (!PANEL_ID.test(m[1])) bad('bad panel id');
  let r = await tool('console-panel.js').render(m[1], { live: true });
  // a source that failed is reported per source (the unit shows its error state); only a missing or invalid panel is an HTTP error
  if (!r.ok && !r.data) throw new HttpError(/^no panel/.test(r.error || '') ? 404 : 400, r.error || 'render failed', r);
  if (!r.ok) r = Object.assign({}, r, { ok: true, partial: true });
  if (Array.isArray(r.data)) { const p = arrayPage(r.data, q, 200); return Object.assign({}, r, { data: p.items, page: { cursor: p.cursor, more: p.more, total: p.total } }); }   // a list panel pages
  return r;
});
// page/panel preview (docs/CONSOLE-PANELS.md §12): an installed or proposed id, or ?dir= a working folder under company/work/
route('GET', /^\/api\/preview\/([a-z0-9-]+)$/, async (m, q) => {
  if (!PANEL_ID.test(m[1])) bad('bad panel id');
  let target = m[1]; const dir = q.get('dir');
  if (dir) { const a = path.resolve(co.ROOT, dir); if (!a.startsWith(co.p('company', 'work') + path.sep) || path.basename(a) !== m[1]) bad('dir must be a working folder under company/work/ named ' + m[1]); target = a; }
  const r = await tool('console-panel.js').render(target, { live: true });
  if (!r.ok && !r.findings && !r.data) throw new HttpError(404, r.error || 'no panel or page ' + m[1]);
  return Object.assign({}, r, { ok: true, valid: !!r.ok });
});
route('POST', /^\/api\/panels\/([a-z0-9-]+)\/(hide|unhide|approve|reject|remove)$/, (m, q, b) => {
  if (!PANEL_ID.test(m[1])) bad('bad panel id');
  const args = [m[2], m[1], '--by', OWNER]; if (m[2] === 'reject' && b.note) args.push('--note', str(b.note, 'note'));
  return runApi('console-panel.js', args);
});
route('GET', /^\/api\/governance-log$/, (m, q) => { const p = filePage(co.p('company', 'state', 'governance-log.jsonl'), q, 200); const entries = []; for (const l of p.lines) { try { const r = JSON.parse(l); if (r && !r._retention) entries.push(r); } catch (_) {} } return { ok: true, entries, cursor: p.cursor, more: p.more }; });
route('GET', /^\/api\/decision-models$/, () => runApi('decide.js', ['list', '--json']));
// Settings › Autonomy › Decision rules: turn a tested check on (live) or back to practice (shadow), as the owner; the
// version is the model's active one (decide.js promote checks its cases)
route('POST', /^\/api\/decision-models\/([a-z][a-z0-9-]{1,40})\/mode$/, async (m, q, b) => {
  const mode = b && b.mode === 'live' ? 'live' : b && b.mode === 'shadow' ? 'shadow' : bad('mode is live or shadow');
  const list = await runApi('decide.js', ['list', '--json']);
  const model = ((list && (list.models || list.items)) || []).find(x => x.id === m[1]);
  if (!model) bad('no such rule', 404);
  const v = String(model.active || model.version || '');
  if (!/^[0-9A-Za-z._-]{1,20}$/.test(v)) bad('that rule has no version to turn on');
  return runApi('decide.js', ['promote', m[1], v, '--mode', mode, '--by', OWNER], { timeout: 60000 });
});
// Settings › Autonomy › Permission to answer for you: the owner's delegations, and taking one back
route('GET', /^\/api\/delegations$/, () => runApi('delegation.js', ['list', '--json']));
route('POST', /^\/api\/delegations\/(dg-[0-9a-z-]{1,40})\/revoke$/, (m) => runApi('delegation.js', ['revoke', m[1], '--by', OWNER, '--why', 'taken back by the owner in the console']));
// onboarding (company/tools/onboard.js): provisioning steps + the last certification; POST certify re-runs the 9 checks
route('GET', /^\/api\/onboarding$/, () => runApi('onboard.js', ['--check', '--json']));
route('POST', /^\/api\/onboarding\/certify$/, async () => { const r = await run('onboard.js', ['--certify', '--json'], { timeout: 300000 }); return Object.assign({}, r.data, { ok: true, certified: !!(r.data && r.data.certified) }); });
// Setup (console/setup.js): the seven-step guided setup, every write as the owner
const MME_same = (a, b) => require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'minimax-endpoint.js')).same(a, b);
const SETUP = require(path.join(__dirname, 'setup.js'))({ co, run, runApi, stationGet, stationPost, owner: () => OWNER, setOwner: n => { OWNER = n || OWNER; }, bad, HttpError, tool, emit: t => emit(t) });
for (const [mth, re, fn] of SETUP.routes) route(mth, re, fn);
require(path.join(__dirname, 'models.js')).mount(route, { co, runApi, stationGet, bad, owner: () => OWNER });   // per-seat model chains (console/models.js)
require(path.join(__dirname, 'departments.js')).mount(route, { runApi, bad, owner: () => OWNER });   // departments, leads, members (console/departments.js)
require(path.join(__dirname, 'routing.js')).mount(route, { runApi, bad, owner: () => OWNER });   // routing modes and trials (console/routing.js)
// the owner's server chores without a terminal: flags, scheduler, services, modules, restarts, framework update, access
const OPS = require(path.join(__dirname, 'owner-ops.js')).mount(route, { co, run, runApi, bad, owner: () => OWNER, tool, busy: () => CHAT.runs.busy(), emit: t => emit(t) });
route('GET', /^\/api\/locked$/, () => runApi('locked-watch.js', ['status']));
route('GET', /^\/api\/external$/, () => runApi('external-gate.js', ['list']));

/* ---------------- events (SSE) ---------------- */
const clients = new Set();
const WATCHES = [
  ['questions', ['company'], f => f === 'pm-inbox.jsonl' || f === 'asks.jsonl'],
  // a level or a standing rule decides what is in Needs you (console/owner-needs.js), so either change redraws it
  ['questions', ['company', 'state'], f => f === 'governance.json' || f === 'owner-rulings.json'],
  ['rulings', ['company', 'state'], f => f === 'owner-rulings.json'],
  ['owner', ['company', 'owner'], () => true],
  ['handoffs', ['company', 'work', 'handoffs'], () => true],
  ['halt', ['company', 'state'], f => f === 'halt.json'],
  ['governance', ['company', 'state'], f => f === 'governance.json' || f === 'governance-log.jsonl'],
  ['guardrails', ['company', 'state'], f => f === 'guardrails.json'],
  ['services', ['company', 'state'], f => f === 'services.json'],
  ['cadence', ['company', 'work', 'ops'], f => f === 'cadence.json'],
  ['panels', ['company', 'console'], f => f === 'state.json' || f === 'changes.jsonl' || f === 'panels' || f === 'proposed'],
  ['panels', ['company', 'console', 'panels'], () => true],
  ['panels', ['company', 'console', 'pages'], () => true],
  ['dispatch', ['company', 'work'], f => f === 'dispatch-log.md' || f === 'dispatch-state.json'],
  ['crew', ['company', 'tools'], f => f === 'loops.json'],
  ['crew', ['company'], f => f === 'departments.json'],
  ['routing', ['company', 'work', 'models'], f => f === 'routing-policy.json' || f === 'routing-log.jsonl'],
  ['charter', ['company'], f => f === 'CHARTER.md' || /^CHARTER\.md\.tmp/.test(f)],
  ['activity', ['company', 'work'], f => f === 'decisions.md' || f === 'dispatch-log.md'],
  ['activity', ['company', 'owner'], () => true],
];
const timers = {};
function emit(topic) {
  clearTimeout(timers[topic]);
  timers[topic] = setTimeout(() => { const msg = 'event: change\ndata: ' + JSON.stringify({ topic }) + '\n\n'; for (const c of clients) c.write(msg); }, 250);
}
const armed = new Map();
function armWatches() {
  WATCHES.forEach(([topic, parts, match], i) => {
    if (armed.has(i)) return;
    const dir = co.p(...parts);
    try {
      const w = fs.watch(dir, (ev, f) => { if (!f || match(String(f).split(/[\/\\]/)[0])) emit(topic); });
      w.on('error', () => { try { w.close(); } catch (_) {} armed.delete(i); });
      armed.set(i, w);
    } catch (_) { /* folder not there yet: retried */ }
  });
}
function events(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 5000\n: hello\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

/* ---------------- core modules: ONE generic mount (company/tools/lib/modules.js) ----------------
 * Each enabled module's http.js routes: auth 'source' -> /hooks/<id>/<path> (no owner token: the module authenticates
 * the caller, e.g. an HMAC over ctx.body), auth 'owner' -> /api/m/<id>/<path> (behind the owner token like every /api
 * route). Bodies are read raw and capped at 256 KB (413 above). ctx = { id, params, query, body (Buffer), text, json(),
 * owner, co, send(status, obj) }. A handler either answers on res itself or returns an object (sent as JSON 200). */
const MODULE_BODY_CAP = 256 * 1024;
const modulesLib = () => require(path.join(TOOLS, 'lib', 'modules.js'));
function readRaw(req, cap) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    // over the cap: stop keeping it, drain the rest, then answer 413 (destroying the socket would leave no answer)
    req.on('data', c => { n += c.length; if (n <= cap) parts.push(c); else if (n > cap * 64) req.destroy(); });
    req.on('end', () => n > cap ? reject(new HttpError(413, 'body too large (cap ' + cap + ' bytes)')) : resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function moduleRoute(req, res, url, auth, id, sub) {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return sendJson(res, 404, { ok: false, error: 'no such module' });
  let routes; try { routes = modulesLib().httpRoutes(); } catch (e) { return sendJson(res, 500, { ok: false, error: 'module routes: ' + e.message }); }
  const mine = routes.filter(r => r.id === id && r.auth === auth);
  if (!mine.length) return sendJson(res, 404, { ok: false, error: 'module ' + id + ' is not enabled or has no ' + auth + ' routes' });
  const subPath = String(sub || '').replace(/^\/+|\/+$/g, '');
  const hits = mine.filter(r => r.re.test(subPath));
  const r = hits.find(x => x.method === req.method);
  if (!r) return sendJson(res, hits.length ? 405 : 404, { ok: false, error: 'no such endpoint: ' + req.method + ' ' + url.pathname });
  const body = (req.method === 'GET' || req.method === 'HEAD') ? Buffer.alloc(0) : await readRaw(req, MODULE_BODY_CAP);
  const m = subPath.match(r.re); const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  const ctx = { id, params, query: url.searchParams, body, text: body.toString('utf8'), json: () => { try { return JSON.parse(body.toString('utf8') || '{}'); } catch (_) { throw new HttpError(400, 'body is not JSON'); } },
    owner: auth === 'owner' ? OWNER : null, co, send: (status, obj) => sendJson(res, status, obj), headers: req.headers };
  const out = await r.handler(req, res, ctx);
  if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out === undefined ? { ok: true } : out);
}

/* ---------------- server ---------------- */
function makeServer() {
  return http.createServer(async (req, res) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
    const p = url.pathname;
    baseHeaders(res, p);
    try {
      if (p === '/api/health') return sendJson(res, 200, { ok: true });   // for a container's health check: no auth, no detail
      if (await AUTH.handle(req, res, url)) return;   // GET/POST /login, POST /logout
      const hk = p.match(/^\/hooks\/([^/]+)(?:\/(.*))?$/);
      if (hk) return await moduleRoute(req, res, url, 'source', hk[1], hk[2]);
      if (/^\/preview\/[a-z0-9-]+$/.test(p)) {   // the page preview shell; its data comes from /api/preview/<id>
        if (!AUTH.check(req).ok) { res.writeHead(303, { location: '/login?next=' + encodeURIComponent(p) }); return res.end(); }
        return serveStatic(req, res, '/preview.html');
      }
      if (!p.startsWith('/api/') && p !== '/api') {
        // the app shell needs a session: a signed-out browser goes to the login page (assets stay public: no data in them)
        if ((p === '/' || p === '/index.html') && !AUTH.check(req).ok) { res.writeHead(303, { location: '/login', 'cache-control': 'no-store' }); return res.end(); }
        return serveStatic(req, res, p);
      }
      const who = AUTH.check(req);
      if (!who.ok) return sendJson(res, 401, { ok: false, error: 'sign in first (the login page is /login; scripts send the x-console-token header)', login: '/login' });
      if (req.method !== 'GET' && req.method !== 'HEAD' && !AUTH.csrfOk(req, who)) return sendJson(res, 403, { ok: false, error: 'refused: this write has no valid CSRF token (x-csrf-token) or came from another site', csrf: true });
      for (const [mth, re, fn] of AUTH.routes) { const m = p.match(re); if (m && req.method === mth) { const body = mth === 'POST' ? await readBody(req) : {}; return sendJson(res, 200, await fn(m, url.searchParams, body, req, res)); } }
      if (p === '/api/events') return events(req, res);
      if (p.startsWith('/api/station/')) return stationProxy(req, res, p.slice('/api/station/'.length), url.search);
      const am = p.match(/^\/api\/m\/([^/]+)(?:\/(.*))?$/);
      if (am) return await moduleRoute(req, res, url, 'owner', am[1], am[2]);
      const vm = p.match(/^\/api\/panels\/([a-z0-9-]+)\/view$/);
      if (vm && req.method === 'GET') {
        const d = PANEL_ID.test(vm[1]) && panelDir(vm[1]);
        const f = d && path.join(d, 'view.html');
        if (!f || !fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: 'no custom view for ' + vm[1] });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(f));
      }
      if (req.method === 'POST' && !/json/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { ok: false, error: 'POST bodies are JSON (content-type: application/json)' });
      const am2 = p.match(/^\/api\/chat\/([A-Za-z0-9_-]{1,64})\/attach$/);
      if (am2 && req.method === 'GET') return CHAT.attach(req, res, am2[1], url.searchParams);
      const cm = p.match(/^\/api\/chat\/([A-Za-z0-9_-]{1,64})\/send$/);
      if (cm) { if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }); return await CHAT.send(req, res, cm[1], await readBody(req)); }
      for (const r of routes) {
        const m = p.match(r.re); if (!m) continue;
        if (req.method !== r.method) continue;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const out = await r.fn(m, url.searchParams, body, req);
        return sendJson(res, 200, out);
      }
      return sendJson(res, routes.some(r => r.re.test(p)) ? 405 : 404, { ok: false, error: 'no such endpoint: ' + req.method + ' ' + p });
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e instanceof HttpError ? e.status : 500;
      sendJson(res, status, Object.assign({ ok: false, error: e.message }, e.extra && typeof e.extra === 'object' ? { detail: e.extra } : {}));
    }
  });
}
/* The login line. The token goes only to an interactive terminal: under systemd stdout is the user journal, which
 * every diagnostic reads, so there the line names where the token is kept instead (scripts/console.sh --url prints
 * the full address to a terminal). */
function loginLine(base, token, tty) {
  // the token is never part of an address any more (an address lands in history, proxy and access logs); a terminal
  // gets the sign-in page and, on its own line, where the token is kept
  void token; void tty;
  return 'console: ' + base + '/login (sign in with the owner token in secrets/console-token, or your passphrase)';
}
function listenConfig(argv) {
  const cc = co.config.console || {};
  const flag = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  let stationPort = 0; try { stationPort = Number(new URL(co.STATION_URL).port) || 0; } catch (_) {}
  const port = flag('port') !== undefined ? Number(flag('port')) : process.env.CONSOLE_PORT ? Number(process.env.CONSOLE_PORT) : cc.port || (stationPort ? stationPort + 100 : 8901);
  return { host: flag('host') || process.env.CONSOLE_HOST || cc.host || '127.0.0.1', port };
}
function printUrl(argv) {
  const { host, port } = listenConfig(argv);
  const shown = host.includes(':') ? '[' + host + ']' : host;
  if (!process.stdout.isTTY) { console.error('console --url prints the login token, so only to an interactive terminal (stdout here is a pipe or a log). The token is in secrets/console-token.'); return 2; }
  console.log(loginLine('http://' + shown + ':' + port) + '\ntoken (paste it into the form; never into an address): ' + consoleToken()); return 0;
}
// --rotate-token: a new console token (the owner's own shell only); every session ends at once (the console re-reads the token file)
function rotateToken() {
  let owner = false; try { owner = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'owner.js')).shell(); } catch (_) {}
  if (!owner) { console.error('rotating the console token is the owner\'s, from the owner\'s own shell'); return 2; }
  AUTH.writeToken(crypto.randomBytes(24).toString('hex'));
  console.log('a new console token is in secrets/console-token; every browser is signed out (the running console reads the new token by itself). The owner can do the same from Settings › System › Sign-in › Sign out everywhere.');
  return 0;
}
/* --reset-login: the server admin's break-glass for an owner who is locked out (docs/DEPLOY-SERVER.md "Locked out").
 * A new token, the passphrase and recovery code removed, every session ended. From a shell on the server only (not an
 * agent's run); the new token goes to a terminal only. The running console picks it up without a restart. */
function resetLogin() {
  let agent = false; try { agent = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'owner.js')).underStation(); } catch (_) {}
  if (agent) { console.error('refused: --reset-login is the server admin\'s, never an agent run\'s'); return 2; }
  AUTH.writeToken(crypto.randomBytes(24).toString('hex'));
  for (const f of ['console-passphrase', 'console-recovery']) { try { fs.unlinkSync(path.join(co.SECRETS_DIR, f)); } catch (_) {} }
  try { fs.appendFileSync(co.p('company', 'work', 'decisions.md'), '- ' + new Date().toISOString() + ' server admin reset the console sign-in (--reset-login): new token, passphrase and recovery code removed\n'); } catch (_) {}
  console.log('console sign-in reset: new token written to secrets/console-token, passphrase and recovery code removed, every session ended.');
  if (process.stdout.isTTY) console.log('new token (give it to the owner privately; they sign in with it, then set a passphrase): ' + consoleToken());
  else console.log('read the new token with: cat secrets/console-token   (in a terminal; it is not printed to a pipe or a log)');
  return 0;
}
function start(argv) {
  const token = consoleToken();
  const { host, port } = listenConfig(argv);
  const server = makeServer();
  const bw = require(path.join(__dirname, 'auth.js')).bindWarning(host); if (bw) console.error('console: WARNING ' + bw);
  armWatches();
  CHAT.runs.start();   // re-attach to the chat runs a previous console process left in flight
  MEET.start();        // and carry on a meeting it left mid-round (its turn in flight is one of those runs)
  setInterval(armWatches, 15000).unref();
  setInterval(() => { tool('approvals.js').tick({ actor: 'the console' }).catch(() => {}); }, 60000).unref();   // approvals: expiry (default deny) and reminders
  ACT.start();
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();
  server.listen(port, host, () => {
    const a = server.address();
    const shown = host.includes(':') ? '[' + host + ']' : host;
    if (argv.includes('--print-port')) console.log(JSON.stringify({ port: a.port }));
    else console.log(loginLine('http://' + shown + ':' + a.port, token, !!process.stdout.isTTY) + '\n(company root ' + co.ROOT + ', station ' + co.STATION_URL + ')');
  });
  return server;
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const snap = () => ['state', 'owner', 'work'].map(d => { try { return d + ':' + fs.readdirSync(co.p('company', d)).map(f => f + '@' + fs.statSync(co.p('company', d, f)).mtimeMs).join(','); } catch (_) { return d + ':-'; } })
    .concat([co.p('company', 'pm-inbox.jsonl')].map(f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return '-'; } })).join('|');
  const before = snap();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'console-selftest-'));
  fs.cpSync(co.p('company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), 'selftest-fake-station-token\n', { mode: 0o600 });
  // a demo core module with one owner route and one source route (the generic mount)
  fs.mkdirSync(path.join(tmp, 'modules', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'modules', 'demo', 'http.js'), "module.exports = { routes: [" +
    "{ method: 'GET', path: 'echo/:what', auth: 'owner', handler: (req, res, ctx) => ({ ok: true, what: ctx.params.what, owner: ctx.owner }) }," +
    "{ method: 'POST', path: 'in', auth: 'source', handler: (req, res, ctx) => ctx.headers['x-demo-secret'] === 's3' ? { ok: true, bytes: ctx.body.length } : ctx.send(401, { ok: false }) }] };\n");
  fs.mkdirSync(path.join(tmp, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: { demo: { at: 'x' } } }));
  // a dead station: a port we bound and released, so every station call is refused
  const dead = await new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const pt = s.address().port; s.close(() => r(pt)); }); });
  // background services: one installed (driven through a fake systemctl, never the real user manager) and one proposed
  const fakeSc = path.join(tmp, 'fake-systemctl'), scLog = path.join(tmp, 'fake-systemctl.log');
  fs.writeFileSync(fakeSc, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(scLog) + '\ncase "$2" in show) echo ActiveState=active;; esac\n', { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'units'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'company', 'state', 'services.json'), JSON.stringify({ services: {
    rec: { name: 'rec', unit: 'company-svc-rec', kind: 'service', status: 'installed', argv: ['/usr/bin/python3', path.join(tmp, 'company/work/rec.py')], schedule: null, why: 'records depth between runs', by: 'agent', byName: 'Founder', files: {} },
    tape: { name: 'tape', unit: 'company-svc-tape', kind: 'timer', status: 'proposed', argv: ['/bin/sh', 'x.sh'], schedule: { onCalendar: '*-*-* 18:00:00 UTC' }, why: 'banks the tape daily', by: 'agent', byName: 'Founder' } } }));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, CONNECTORS_HOME: path.join(tmp, 'home'), STARNET_URL: 'http://127.0.0.1:' + dead, SERVICE_SYSTEMCTL: fakeSc, SERVICE_UNIT_DIR: path.join(tmp, 'units') });
  delete env.CONSOLE_PORT;
  const child = spawn(process.execPath, [__filename, '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', d => { errText += d; });
  const serverOut = { d: '' }; child.stdout.on('data', d => { serverOut.d += d; });
  const port = await new Promise((resolve, reject) => {
    let buf = ''; child.stdout.on('data', d => { buf += d; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); });
    child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText)));
    setTimeout(() => reject(new Error('server did not start: ' + errText)), 10000);
  });
  const token = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const mode = fs.statSync(path.join(tmp, 'secrets', 'console-token')).mode & 0o777;
  const call = (method, p, body, headers) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = Object.assign({}, data ? { 'content-type': 'application/json' } : {}, headers === undefined ? { 'x-console-token': token } : headers);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: h }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, headers: res.headers, json: j, text: d }); });
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout ' + p)));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const cases = []; const check = (n, c, info) => { cases.push({ n, ok: !!c }); console.log((c ? 'ok   ' : 'FAIL ') + n + (c || info === undefined ? '' : '  ' + JSON.stringify(info).slice(0, 400))); };
  try {
    check('console-token created 0600', mode === 0o600, mode.toString(8));
    let r = await call('GET', '/api/today', undefined, {});
    check('no token: 401', r.status === 401, r.status);
    r = await call('GET', '/api/today', undefined, { 'x-console-token': 'wrong' });
    check('wrong token: 401', r.status === 401, r.status);
    r = await call('GET', '/login?token=' + token, undefined, {});
    check('a token in the login address is not accepted (no cookie)', r.status === 400 && !r.headers['set-cookie'] && !r.text.includes(token), r.status);
    r = await call('POST', '/login', { secret: token }, { 'content-type': 'application/json' });
    const cookie = String((r.headers['set-cookie'] || [''])[0]).split(';')[0];
    check('login form sets a session cookie (not the token)', r.status === 200 && /^capheos_session=v1\./.test(cookie) && !cookie.includes(token), r.headers);
    // the login token never reaches the journal or an address
    check('the login line never carries the token', !loginLine('http://h:1', 'tok-secret-1', false).includes('tok-secret-1') && !loginLine('http://h:1', 'tok-secret-1', true).includes('tok-secret-1') && /secrets\/console-token/.test(loginLine('http://h:1', 'tok-secret-1', false)));
    { const u = require('child_process').spawnSync(process.execPath, [__filename, '--url'], { encoding: 'utf8', env: Object.assign({}, process.env), timeout: 15000 });
      check('console --url to a pipe is refused and prints no token', u.status === 2 && !/token=/.test(u.stdout + u.stderr), u.stdout + u.stderr); }
    r = await call('GET', '/api/company', undefined, { cookie });
    check('cookie auth works', r.status === 200 && r.json.ok && r.json.owner && r.json.owner.name === OWNER, r.json);
    r = await call('GET', '/api/today');
    check('today', r.status === 200 && r.json.ok && r.json.needsYou && Array.isArray(r.json.needsYou.questions) && r.json.halt && r.json.halt.mode === 'running', r.json);
    r = await call('GET', '/api/spend');
    check('GET /api/spend: today against the cap, by seat and by provider (read-only)', r.status === 200 && r.json.ok && r.json.today && typeof r.json.today.usd === 'number' && typeof r.json.today.capUsd === 'number' && Array.isArray(r.json.bySeat) && Array.isArray(r.json.byProvider) && Array.isArray(r.json.subscriptions), r.json);
    // questions
    const ask = await new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'ask', '--from', 'Selftest', '--about', 'console', '--q', 'May we test the console? It lets us check the screens; if you skip it, we wait.', '--blocking'], { env }, (e, so) => res(JSON.parse(so))));
    r = await call('GET', '/api/questions');
    check('question asked via inbox.js shows', r.json.ok && r.json.questions.some(q => q.id === ask.id && q.blocking), r.json);
    r = await call('POST', '/api/questions/' + ask.id + '/answer', { verdict: 'maybe' });
    check('bad verdict: 400', r.status === 400, r.json);
    r = await call('POST', '/api/questions/' + ask.id + '/answer', { verdict: 'yes', text: 'go ahead' });
    check('answer accepted', r.status === 200 && r.json.ok, r.json);
    r = await call('GET', '/api/questions');
    check('answered question gone', r.json.ok && !r.json.questions.some(q => q.id === ask.id), r.json);
    r = await call('GET', '/api/questions/answered');
    check('answered today lists it', r.json.ok && r.json.answered.some(q => q.id === ask.id && /^yes/.test(q.answer)), r.json);
    r = await call('POST', '/api/questions/' + ask.id + '/answer', { verdict: 'yes' });
    check('answering again: 404', r.status === 404, r.json);
    // typed questions: every shortcut kind, a free-form form, snooze, and the secret store
    // a fixture message gets the plain tail the owner-scope rule asks for (what the owner gets, what happens if they skip it)
    const PLAIN_TAIL = ' It lets us go on; if you skip it, we wait.';
    const plainArgv = argv => argv.map((x, i) => argv[i - 1] === '--message' && x.length > 1 && !/\bskip\b/.test(x) ? x + PLAIN_TAIL : x);
    const askCli = argv => new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'ask', '--from', 'Founder'].concat(plainArgv(argv)), { env }, (e, so) => { try { res(JSON.parse(so)); } catch (_) { res({ ok: false, raw: so }); } }));
    const SECRET = 'S3cr3t-Value-For-Selftest-0123456789';
    const sseBuf = { d: '' };
    const sseReq = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-console-token': token } }, res => res.on('data', c => { sseBuf.d += c; }));
    sseReq.on('error', () => {}); sseReq.end();
    const kq = {};
    kq.choice = await askCli(['--message', 'Which plan should we try?', '--kind', 'choice', '--options', 'trial:The free trial,skip:Skip it', '--recommended', 'trial']);
    kq.text = await askCli(['--message', 'What should the newsletter cover?', '--kind', 'text', '--min', '10']);
    kq.secret = await askCli(['--message', 'Please make a read-only Kalshi key and paste it here.', '--details', 'Kalshi refuses anonymous websockets.', '--kind', 'secret', '--name', 'kalshi-api-key', '--label', 'Kalshi API key']);
    kq.secret2 = await askCli(['--message', 'And once more, the same Kalshi key file.', '--kind', 'secret', '--name', 'kalshi-api-key']);
    kq.link = await askCli(['--message', 'Could you sign up at Synpath?', '--kind', 'link', '--url', 'https://synpath.example/signup', '--action', 'Sign in with Google']);
    kq.account = await askCli(['--message', 'Make a free Acme account.', '--kind', 'account', '--url', 'https://healthchecks.io/', '--action', 'Sign up', '--fields', 'email:Sign-in email']);
    kq.number = await askCli(['--message', 'What monthly cap?', '--kind', 'number', '--unit', 'USD', '--min', '0', '--max', '100']);
    kq.date = await askCli(['--message', 'When do we launch?', '--kind', 'date', '--min', '2026-01-01']);
    kq.slider = await askCli(['--message', 'How much of this week may routines use?', '--kind', 'slider', '--min', '70', '--max', '100', '--step', '5', '--value', '95', '--unit', '%', '--say', 'Let routines use up to {value}% of this week']);
    kq.form = await askCli(['--message', 'Two quick things.', '--form', JSON.stringify({ fields: [{ id: 'ok', type: 'checkbox', label: 'Emails may go to you', required: true }, { id: 'pk', type: 'secret', label: 'Ping key', name: 'ping-key', required: false }], actions: [{ id: 'go', label: 'Here you go', verdict: 'done' }, { id: 'later', label: 'Not now', verdict: 'no' }] })]);
    kq.legacy = await askCli(['--q', 'A free Acme key from an account in your name, please. It unlocks the reference series; if you skip it, we wait.\nAccess gate (gate 2), no payment: the Acme API key.']);
    kq.unsafe = await askCli(['--message', 'x', '--kind', 'link', '--url', 'javascript:alert(1)', '--action', 'click']);
    check('inbox.js ask: every kind filed; an unsafe link refused with the reason', Object.entries(kq).every(([k, v]) => k === 'unsafe' ? (!v.ok && /http or https/.test(v.error)) : v.ok) && /no --message/.test((kq.legacy.warnings || []).join()), kq);
    r = await call('GET', '/api/questions');
    const byId = Object.fromEntries((r.json.questions || []).map(x => [x.id, x]));
    check('GET /api/questions carries kind, form, message and details', byId[kq.secret.id] && byId[kq.secret.id].kind === 'secret' && byId[kq.secret.id].form.fields[0].type === 'secret' && byId[kq.secret.id].message.startsWith('Please') && /websockets/.test(byId[kq.secret.id].details), byId[kq.secret.id]);
    check('the asker\'s seat is named for Discuss', byId[kq.choice.id] && byId[kq.choice.id].askerSeat === (co.ceo() || 'agent'), byId[kq.choice.id] && byId[kq.choice.id].askerSeat);
    check('a legacy key question offers the secret field (acme-api-key)', byId[kq.legacy.id] && byId[kq.legacy.id].secretHint && byId[kq.legacy.id].secretHint.name === 'acme-api-key', byId[kq.legacy.id]);
    r = await call('POST', '/api/questions/' + kq.choice.id + '/answer', { action: 'choose', values: { choice: 'nope' } });
    check('choice: an option off the list: 400', r.status === 400 && /not one of the options/.test(r.json.error), r.json);
    r = await call('POST', '/api/questions/' + kq.choice.id + '/answer', { action: 'choose', values: { choice: 'trial' }, note: 'two weeks' });
    check('choice answered in plain words', r.status === 200 && /"The free trial"/.test(r.json.a), r.json);
    r = await call('POST', '/api/questions/' + kq.text.id + '/answer', { action: 'send', values: { answer: 'short' } });
    check('text: under the minimum length: 400', r.status === 400, r.json);
    r = await call('POST', '/api/questions/' + kq.text.id + '/answer', { action: 'send', values: { answer: 'sk-abcdefghijklmnopqrstuvwxyz123456 is the key' } });
    check('a key pasted into a text field is refused, pointing at the secure field', r.status === 400 && /secure field/.test(r.json.error) && !r.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), r.json);
    r = await call('POST', '/api/questions/' + kq.text.id + '/answer', { verdict: 'reply', text: '-----BEGIN PRIVATE KEY----- MC4CAQAwBQYDK2VwBCIEIAkR -----END PRIVATE KEY-----' });
    check('a private key pasted into Reply is refused', r.status === 400 && /secure field/.test(r.json.error), r.json);
    r = await call('POST', '/api/questions/' + kq.text.id + '/answer', { action: 'send', values: { answer: 'Night-sky field guides for beginners.' } });
    check('text answered', r.status === 200 && r.json.a === 'Night-sky field guides for beginners.', r.json);
    r = await call('POST', '/api/questions/' + kq.number.id + '/answer', { action: 'send', values: { value: 500 } });
    check('number above max: 400', r.status === 400, r.json);
    r = await call('POST', '/api/questions/' + kq.number.id + '/answer', { action: 'send', values: { value: 40 } });
    check('number answered with its unit', r.status === 200 && /40 USD/.test(r.json.a), r.json);
    r = await call('POST', '/api/questions/' + kq.slider.id + '/answer', { action: 'set', values: { value: 105 } });
    check('slider above max: 400 (checked on the server, not only in the browser)', r.status === 400 && /outside/.test(r.json.error), r.json);
    r = await call('POST', '/api/questions/' + kq.slider.id + '/answer', { action: 'set', values: { value: 82 } });
    check('slider off its step: 400', r.status === 400 && /between steps/.test(r.json.error), r.json);
    r = await call('POST', '/api/questions/' + kq.slider.id + '/answer', { action: 'set', values: { value: 80 } });
    check('slider answered in its plain words', r.status === 200 && /Let routines use up to 80% of this week/.test(r.json.a), r.json);
    r = await call('POST', '/api/questions/' + kq.date.id + '/answer', { action: 'send', values: { value: 'soon' } });
    check('date not a date: 400', r.status === 400, r.json);
    r = await call('POST', '/api/questions/' + kq.date.id + '/answer', { action: 'send', values: { value: '2026-12-01' } });
    check('date answered', r.status === 200 && /2026-12-01/.test(r.json.a), r.json);
    r = await call('POST', '/api/questions/' + kq.link.id + '/answer', { action: 'couldnt', values: { note: 'Google asked for a phone' } });
    check('link: could not, with the note', r.status === 200 && /could not/.test(r.json.a) && /phone/.test(r.json.a), r.json);
    r = await call('POST', '/api/questions/' + kq.account.id + '/answer', { action: 'done', values: {} });
    check('account: a missing field: 400', r.status === 400 && /Sign-in email/.test(r.json.error), r.json);
    r = await call('POST', '/api/questions/' + kq.account.id + '/answer', { action: 'done', values: { email: 'me@example.com' } });
    check('account answered with the field', r.status === 200 && /me@example\.com/.test(r.json.a), r.json);
    // the secret store
    r = await call('POST', '/api/questions/' + kq.secret.id + '/answer', { action: 'store', values: { key: '   ' } });
    check('secret: an empty key: 400, nothing written', r.status === 400 && !fs.existsSync(path.join(tmp, 'secrets', 'kalshi-api-key')), r.json);
    r = await call('POST', '/api/questions/' + kq.secret.id + '/answer', { action: 'store', values: { key: '  ' + SECRET + '\n' } });
    const kfile = path.join(tmp, 'secrets', 'kalshi-api-key');
    check('secret: stored, the answer names the path and length only', r.status === 200 && r.json.stored[0].stored === 'secrets/kalshi-api-key' && r.json.stored[0].chars === SECRET.length && /secrets\/kalshi-api-key \(36 chars, validated: not checked\)/.test(r.json.a), r.json);
    check('secret: the response body never carries the value', !r.text.includes(SECRET));
    check('secret: the file is 0600 and holds the value', fs.existsSync(kfile) && (fs.statSync(kfile).mode & 0o777) === 0o600 && fs.readFileSync(kfile, 'utf8') === SECRET + '\n', fs.existsSync(kfile) && (fs.statSync(kfile).mode & 0o777).toString(8));
    r = await call('POST', '/api/questions/' + kq.secret2.id + '/answer', { action: 'store', values: { key: 'another-value-1234567890' } });
    check('secret: an existing file is not overwritten without replace (409)', r.status === 409 && r.json.detail && r.json.detail.code === 'exists' && fs.readFileSync(kfile, 'utf8') === SECRET + '\n', r.json);
    r = await call('POST', '/api/questions/' + kq.secret2.id + '/answer', { action: 'store', values: { key: 'another-value-1234567890' }, replace: { key: true } });
    check('secret: replace ticked overwrites it, still 0600', r.status === 200 && fs.readFileSync(kfile, 'utf8') === 'another-value-1234567890\n' && (fs.statSync(kfile).mode & 0o777) === 0o600, r.json);
    r = await call('POST', '/api/questions/' + kq.form.id + '/answer', { action: 'go', values: { pk: SECRET } });
    check('form: a required checkbox missing: 400 and no key file left behind', r.status === 400 && !fs.existsSync(path.join(tmp, 'secrets', 'ping-key')), r.json);
    r = await call('POST', '/api/questions/' + kq.form.id + '/answer', { action: 'go', values: { ok: true, pk: '-----BEGIN PRIVATE KEY----- MC4CAQAwBQYDK2VwBCIEIAkRaIju+GQX99lOzlTW4ttYt7vtuKO3/TIksMVHD0PA -----END PRIVATE KEY-----' } });
    const pk = fs.existsSync(path.join(tmp, 'secrets', 'ping-key')) ? fs.readFileSync(path.join(tmp, 'secrets', 'ping-key'), 'utf8') : '';
    check('form: a flattened PEM key is stored with its line breaks back', r.status === 200 && /^-----BEGIN PRIVATE KEY-----\nMC4C[^\n]+\n-----END PRIVATE KEY-----\n$/.test(pk), { r: r.json, pk: pk.length });
    r = await call('POST', '/api/questions/' + kq.legacy.id + '/answer', { action: 'store-key', values: { key: SECRET }, secretNames: { key: '../escape' } });
    check('legacy: an unsafe file name is refused', r.status === 400 && !r.text.includes(SECRET), r.json);
    r = await call('POST', '/api/questions/' + kq.legacy.id + '/answer', { action: 'store-key', values: { key: SECRET }, secretNames: { key: 'acme-api-key' } });
    check('legacy key question: stored through the secure field, the request stays open for its decision', r.status === 200 && fs.existsSync(path.join(tmp, 'secrets', 'acme-api-key')) && r.json.state === 'open' && /secrets\/acme-api-key/.test(r.json.a), r.json);
    r = await call('GET', '/api/questions'); const lq2 = (r.json.questions || []).find(x => x.id === kq.legacy.id);
    check('legacy key question: still on Today with the key question answered', lq2 && lq2.kind === 'multi' && lq2.questions.find(p => p.kind === 'secret').answered && lq2.progress.requiredLeft === 1, lq2);
    r = await call('POST', '/api/questions/' + kq.legacy.id + '/answer', { parts: { decision: { action: 'approve' } } });
    check('legacy key question: Approve closes it and the answer has both parts', r.status === 200 && r.json.state === 'answered' && r.json.answer.parts.decision.verdict === 'yes' && r.json.answer.parts.key.values.key.stored === 'secrets/acme-api-key' && !r.text.includes(SECRET), r.json);
    // a typed form with a key and a checkbox: Store keeps it open, the final submit carries both
    const kq3 = await askCli(['--message', 'Two quick things.', '--form', JSON.stringify({ fields: [{ id: 'ok', type: 'checkbox', label: 'Emails may go to you', required: true }, { id: 'pk', type: 'secret', label: 'Ping key', name: 'ping-key-3', required: false }], actions: [{ id: 'go', label: 'Here you go', verdict: 'done' }] })]);
    r = await call('POST', '/api/questions/' + kq3.id + '/answer', { store: 'pk', values: { pk: SECRET } });
    check('form store: the key is written, the question stays open', r.status === 200 && r.json.state === 'open' && fs.existsSync(path.join(tmp, 'secrets', 'ping-key-3')) && !r.text.includes(SECRET), r.json);
    r = await call('GET', '/api/questions'); const f3 = (r.json.questions || []).find(x => x.id === kq3.id);
    check('form store: Today still has it, with the stored key', f3 && f3.stored && f3.stored.pk.stored === 'secrets/ping-key-3', f3);
    r = await call('POST', '/api/questions/' + kq3.id + '/answer', { action: 'go', values: { ok: true } });
    check('form store: the final submit answers it with both, the key as {stored, chars}', r.status === 200 && r.json.state === 'answered' && r.json.answer.values.ok === true && r.json.answer.values.pk.stored === 'secrets/ping-key-3' && r.json.answer.values.pk.chars === SECRET.length, r.json);
    // Settings › Connections and keys › <service> › Connect (console/connectors.js): owner-only, like every /api route
    {
      r = await call('GET', '/api/connectors', undefined, {});
      check('connectors: no owner token, 401', r.status === 401, r.status);
      r = await call('POST', '/api/connectors/synpath/connect', {}, { 'content-type': 'application/json', 'x-console-token': 'wrong' });
      check('connectors: a wrong token cannot start a sign-in', r.status === 401, r.status);
      r = await call('GET', '/api/connectors');
      const syn = r.json && (r.json.connectors || []).find(c => c.id === 'synpath');
      check('connectors: the owner sees Synpath and the GitHub CLI, not connected, stored under the company root, the same-user promise stated',
        r.status === 200 && syn && syn.state === 'not-connected' && syn.style === 'loopback' && syn.storage === 'company' && syn.isolation === 'same-user' && /not out of reach of the crew/.test(syn.promise) && (r.json.connectors || []).some(c => c.id === 'github-cli' && c.style === 'device-code') && !(r.json.errors || []).length, r.json);
      r = await call('POST', '/api/connectors/synpath/callback', { address: 'http://127.0.0.1:1/callback?code=x&state=y' });
      check('connectors: a pasted address with no sign-in waiting is refused (409)', r.status === 409, r.json);
      r = await call('POST', '/api/connectors/nope/connect', {});
      check('connectors: an unknown connector is 404', r.status === 404, r.json);
    }
    // Settings › Connections and keys › Service keys: list, add, replace; values never returned; reserved names and
    // traversal refused; the owner's change recorded for locked-watch; the CEO told; Today knows a key is already saved
    {
      fs.mkdirSync(path.join(tmp, 'company', 'work', 'research'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'company', 'work', 'research', 'feed.js'), "const co = require('../../tools/lib/company');\nconst k = co.secret('pyth-api-key');\n");
      const PYTH = 'pyth-Value-For-Selftest-9876543210', PYTH2 = 'pyth-Replaced-For-Selftest-111222333';
      const pfile = path.join(tmp, 'secrets', 'pyth-api-key');
      const loops = JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'tools', 'loops.json'), 'utf8')).agents || {};
      const ceoId = Object.keys(loops).find(k => (loops[k].functions || []).includes('ceo')) || Object.keys(loops).find(k => !loops[k].manager);
      const ceoInbox = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'work', 'handoffs', loops[ceoId].inbox), 'utf8'); } catch (_) { return ''; } };
      r = await call('GET', '/api/service-keys');
      const kal = r.json.keys && r.json.keys.find(k => k.name === 'kalshi-api-key');
      check('service keys: lists the keys in secrets/ with a friendly name, set and a change date, never a value or the station/console token',
        r.status === 200 && kal && kal.label === 'Kalshi API key' && kal.set === true && !isNaN(Date.parse(kal.changedAt)) && !r.text.includes(SECRET) && !r.text.includes('another-value') && !r.text.includes('selftest-fake-station-token')
        && !r.json.keys.some(k => /^(station-token|console-token|readme\.md)$/i.test(k.name)), r.json);
      const py0 = r.json.keys.find(k => k.name === 'pyth-api-key');
      check('service keys: a key a company script reads but nobody saved yet is listed as not set, with who reads it', py0 && py0.set === false && py0.label === 'Pyth' && py0.usedBy.includes('the research work') && py0.files.includes('company/work/research/feed.js'), py0);
      check('service keys: the Add list offers Pyth, Kalshi, Synpath, healthchecks.io and GitHub, each with where to get it', ['pyth', 'kalshi', 'kalshi-private', 'synpath', 'healthchecks', 'github'].every(id => (r.json.services || []).some(x => x.id === id && x.where)), r.json.services);
      r = await call('POST', '/api/service-keys', { service: 'pyth', value: '  ' + PYTH + '\n' });
      check('service keys: add stores secrets/pyth-api-key (0600) and answers with name and length only', r.status === 200 && r.json.name === 'pyth-api-key' && r.json.chars === PYTH.length && r.json.replaced === false && !r.text.includes(PYTH)
        && fs.readFileSync(pfile, 'utf8') === PYTH + '\n' && (fs.statSync(pfile).mode & 0o777) === 0o600, r.json);
      const provRows = () => fs.readFileSync(path.join(tmp, 'company', 'state', 'locked', 'provenance.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(x => x.file === 'secrets/pyth-api-key');
      const sha = t => 'sha256:' + crypto.createHash('sha256').update(t).digest('hex');
      let pr = provRows();
      check('service keys: the write is recorded as the owner\'s (provenance: hash of the exact bytes, writer console, not an agent run), so locked-watch stays quiet',
        pr.length === 1 && pr[0].sha256 === sha(PYTH + '\n') && /^console /.test(pr[0].writer) && pr[0].underStation === false && pr[0].tainted === false && !JSON.stringify(pr).includes(PYTH), pr);
      check('service keys: the CEO\'s inbox gets "The owner saved Pyth (secrets/pyth-api-key)", never the value', /The owner saved Pyth \(secrets\/pyth-api-key\)/.test(ceoInbox()) && /\*\*Status:\*\* OPEN/.test(ceoInbox()) && !ceoInbox().includes(PYTH), ceoInbox().slice(-600));
      r = await call('POST', '/api/service-keys', { service: 'pyth', value: PYTH2 });
      check('service keys: saving over a saved key without replace is 409 and changes nothing', r.status === 409 && r.json.detail && r.json.detail.code === 'exists' && fs.readFileSync(pfile, 'utf8') === PYTH + '\n' && !r.text.includes(PYTH2), r.json);
      r = await call('POST', '/api/service-keys', { name: 'pyth-api-key', value: PYTH2, replace: true });
      check('service keys: replace overwrites it, still 0600, recorded again, the CEO told it was replaced', r.status === 200 && r.json.replaced === true && fs.readFileSync(pfile, 'utf8') === PYTH2 + '\n' && (fs.statSync(pfile).mode & 0o777) === 0o600
        && provRows().some(x => x.sha256 === sha(PYTH2 + '\n')) && /The owner replaced Pyth/.test(ceoInbox()) && !r.text.includes(PYTH2), r.json);
      r = await call('GET', '/api/service-keys');
      check('service keys: the list never carries a value (after add and replace)', r.status === 200 && r.json.keys.find(k => k.name === 'pyth-api-key').set === true && !r.text.includes(PYTH) && !r.text.includes(PYTH2), r.json);
      const tokBefore = fs.readFileSync(path.join(tmp, 'secrets', 'station-token'), 'utf8');
      for (const nm of ['station-token', 'console-token', 'README.md', 'Station-Token']) {
        r = await call('POST', '/api/service-keys', { name: nm, value: 'overwrite-attempt-123456', replace: true });
        check('service keys: the framework\'s file ' + nm + ' is refused (400, named as the framework\'s)', r.status === 400 && /framework/.test(r.json.error) && !r.text.includes('overwrite-attempt'), r.json);
      }
      check('service keys: the station token is untouched', fs.readFileSync(path.join(tmp, 'secrets', 'station-token'), 'utf8') === tokBefore);
      for (const nm of ['../escape', '../../company/x', 'a/b', '..hidden', '.dotfile', '/etc/passwd', 'x\\y']) {
        r = await call('POST', '/api/service-keys', { name: nm, value: 'traversal-attempt-123456', replace: true });
        check('service keys: path traversal refused (' + nm + ')', r.status === 400, r.json);
      }
      check('service keys: nothing was written outside secrets/', !fs.existsSync(path.join(tmp, 'escape')) && !fs.existsSync(path.join(tmp, 'company', 'x')) && !fs.readdirSync(path.join(tmp, 'secrets')).some(f => /escape|hidden|dotfile|^a$/.test(f)));
      r = await call('POST', '/api/service-keys', { service: 'healthchecks', value: 'not an address' });
      check('service keys: an address must be a web address', r.status === 400 && !fs.existsSync(path.join(tmp, 'secrets', 'liveness-heartbeat-url')), r.json);
      r = await call('POST', '/api/service-keys', { service: 'healthchecks', value: 'https://hc-ping.com/0f0e0d0c-aaaa-bbbb-cccc-1234567890ab' });
      check('service keys: the healthchecks.io heartbeat is saved and labelled an address', r.status === 200 && r.json.kind === 'address' && /address/.test(r.json.label) && !r.text.includes('hc-ping.com'), r.json);
      r = await call('POST', '/api/service-keys', { service: 'nope', value: 'x-123456789' });
      check('service keys: an unknown service is refused', r.status === 400, r.json);
      // Today: a crew request for a key that is already saved says so
      // a key that is already saved is not asked for again (inbox.js code secret-exists), unless the asker says what changed
      const kq4no = await askCli(['--message', 'The Pyth key, please.', '--kind', 'secret', '--name', 'pyth-api-key', '--label', 'Pyth API key']);
      check('Today: a crew request for a key that is already saved is refused unless it says what changed', kq4no.ok === false && kq4no.code === 'secret-exists', kq4no);
      const kq4 = await askCli(['--message', 'The Pyth key, please.', '--kind', 'secret', '--name', 'pyth-api-key', '--label', 'Pyth API key', '--changed', 'the stored key stopped working this morning']);
      const kq5 = await askCli(['--message', 'A Synpath key, please.', '--kind', 'secret', '--name', 'synpath-api-key', '--label', 'Synpath key']);
      r = await call('GET', '/api/questions'); const q4 = (r.json.questions || []).find(x => x.id === kq4.id), q5 = (r.json.questions || []).find(x => x.id === kq5.id);
      check('Today: a request for a key that is already saved carries saved.at; one for a new key does not', q4 && q4.form.fields[0].saved && !isNaN(Date.parse(q4.form.fields[0].saved.at)) && q5 && !q5.form.fields[0].saved && !r.text.includes(PYTH2), { q4: q4 && q4.form, q5: q5 && q5.form });
      for (const x of [kq4, kq5]) await call('POST', '/api/questions/' + x.id + '/answer', { action: 'skip' }).catch(() => {});
    }
    // the composer refuses an ask that tells the owner to run a command
    const shellAsk = await askCli(['--message', 'Two patches need your shell.', '--details', 'patch -p1 < scratch/a.diff && node company/tools/a.js selftest']);
    check('composer: an ask telling the owner to run a command is refused with the routes', shellAsk.ok === false && /run a command/.test(shellAsk.error || '') && /framework request/.test(shellAsk.error || ''), shellAsk);
    const shellAsk2 = await askCli(['--message', 'Three things.', '--questions', JSON.stringify([{ prompt: 'It needs one daemon-reload that agents are refused. May I have that one command?' }, { prompt: 'Switch the module on?' }])]);
    check('composer: a question asking for systemctl/daemon-reload in prose is refused', shellAsk2.ok === false && /run a command/.test(shellAsk2.error || ''), shellAsk2);
    // withdraw: the asker takes one question back; Today hides it and lists it under Answered today
    const wq = await askCli(['--message', 'Two things.', '--questions', JSON.stringify([{ id: 'a', prompt: 'May we spend $10 on the trial? It lets us test the idea; if you skip it, we wait.' }, { id: 'b', prompt: 'May we sign the pilot agreement? It gives us a first client; if you skip it, we wait.' }])]);
    const wd = await new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'withdraw', wq.id, '--part', '1', '--why', 'the rerender fixed it', '--from', 'Founder'], { env }, (e, so) => { try { res(JSON.parse(so)); } catch (_) { res({ ok: false, raw: so }); } }));
    r = await call('GET', '/api/questions');
    const wqq = (r.json.questions || []).find(x => x.id === wq.id);
    check('withdraw: the withdrawn question leaves the card, the other stays', wd.ok && wqq && wqq.questions.length === 1 && wqq.questions[0].id === 'b', { wd, wqq });
    r = await call('GET', '/api/questions/answered');
    check('withdraw: Answered today has "withdrawn by Founder: why"', (r.json.answered || []).some(x => x.id === wq.id && x.withdrawn && x.answer === 'withdrawn by Founder: the rerender fixed it'), r.json);
    // snooze
    const sz = await askCli(['--message', 'Whenever you have a minute.']);
    r = await call('POST', '/api/questions/' + sz.id + '/snooze', { until: '2001-01-01T00:00:00Z' });
    check('snooze into the past: 400', r.status === 400, r.json);
    const until = new Date(Date.now() + 3600e3).toISOString();
    r = await call('POST', '/api/questions/' + sz.id + '/snooze', { until });
    const listed = await new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'list', '--open'], { env }, (e, so) => res(JSON.parse(so))));
    check('snoozed: the question carries snoozedUntil and the asker sees "snoozed until"', r.status === 200 && listed.items.some(x => x.id === sz.id && /^snoozed until /.test(x.status)), listed.items.find(x => x.id === sz.id));
    // the secret value is nowhere
    await new Promise(rs => setTimeout(rs, 600));
    const answeredNow = await call('GET', '/api/questions/answered');
    const msgsNow = await call('GET', '/api/owner/messages');
    const inboxText = fs.readFileSync(path.join(tmp, 'company', 'pm-inbox.jsonl'), 'utf8');
    const inboundText = (() => { try { return fs.readFileSync(path.join(tmp, 'company', 'owner', 'inbound.jsonl'), 'utf8'); } catch (_) { return ''; } })();
    const leaks = { inbox: inboxText.includes(SECRET), inbound: inboundText.includes(SECRET), answered: answeredNow.text.includes(SECRET), messages: msgsNow.text.includes(SECRET), sse: sseBuf.d.includes(SECRET), serverOut: serverOut.d.includes(SECRET) || errText.includes(SECRET),
      pem: inboxText.includes('MC4CAQAwBQYDK2VwBCIEIAkR') || inboundText.includes('MC4CAQAwBQYDK2VwBCIEIAkR') };
    check('the secret value is in no inbox row, owner message, answered list, SSE event or server log', Object.values(leaks).every(v => !v), leaks);
    check('answers reach the asker as owner messages naming the question', inboundText.includes('my answer to your question ' + kq.secret.id) && /stored at secrets\/kalshi-api-key/.test(inboundText));
    sseReq.destroy();
    // owner messages
    r = await call('POST', '/api/owner/messages', { text: 'Hello company' });
    check('owner message posted', r.status === 200 && r.json.ok && r.json.message.from === OWNER, r.json);
    r = await call('POST', '/api/owner/messages', { text: 'x', to: 'Nobody-Here' });
    check('message to unknown crew: 400', r.status === 400, r.json);
    r = await call('GET', '/api/owner/messages');
    check('owner messages list it', r.json.ok && r.json.messages.some(m => m.dir === 'in' && m.text === 'Hello company'), r.json);
    // governance
    r = await call('POST', '/api/governance/preset', { preset: 'autonomous' });
    check('governance preset autonomous', r.status === 200 && r.json.ok, r.json);
    r = await call('GET', '/api/governance');
    check('governance shows the preset', r.json.ok && r.json.preset === 'autonomous', r.json && r.json.preset);
    r = await call('POST', '/api/governance/preset', { preset: 'no-such' });
    check('unknown preset refused', r.status >= 400 && r.json.ok === false, r.json);
    // guardrails
    r = await call('POST', '/api/guardrails/set', { name: 'externalActions', on: false, why: 'selftest' });
    check('guardrail off', r.status === 200 && r.json.ok, r.json);
    r = await call('GET', '/api/guardrails');
    check('guardrail shows off', r.json.ok && r.json.guards.some(g => g.name === 'externalActions' && g.on === false), r.json && r.json.off);
    r = await call('POST', '/api/guardrails/set', { name: 'externalActions', on: true });
    check('guardrail back on', r.status === 200 && r.json.ok, r.json);
    r = await call('POST', '/api/guardrails/set', { name: 'halt', on: false });
    check('halt guardrail cannot be switched off', r.status >= 400, r.json);
    // background services (Settings › System)
    r = await call('GET', '/api/services');
    check('services list: each service with state, schedule words, who asked and why', r.status === 200 && r.json.ok && r.json.services.length === 2
      && r.json.services.some(x => x.name === 'rec' && x.state === 'running' && x.byName === 'Founder' && /depth/.test(x.why) && x.scheduleWords === 'runs all the time')
      && r.json.services.some(x => x.name === 'tape' && x.state === 'proposed'), r.json);
    r = await call('POST', '/api/services/rec/stop', {});
    check('services: the owner stops one (through service.js, as the owner)', r.status === 200 && /--user stop company-svc-rec.service/.test(fs.readFileSync(scLog, 'utf8')), r.json);
    r = await call('POST', '/api/services/tape/start', {});
    check('services: starting one that is not installed is refused in the tool\'s words', r.status === 400 && /not installed/.test(r.json && r.json.error), r.json);
    r = await call('POST', '/api/services/rec/remove', {});
    check('services: the owner removes one', r.status === 200 && r.json.removed === true && !JSON.parse(fs.readFileSync(path.join(tmp, 'company', 'state', 'services.json'), 'utf8')).services.rec, r.json);
    r = await call('POST', '/api/services/..%2Fx/stop', {});
    check('services: a bad name never reaches the tool', r.status === 404 || r.status === 400, r.status);
    // halt (station unreachable: state is still recorded)
    r = await call('POST', '/api/halt/soft', { why: 'selftest', deadlineMin: 5 });
    check('soft halt recorded', r.status === 200 && r.json.mode === 'soft', r.json);
    r = await call('GET', '/api/halt');
    check('halt status soft', r.json.mode === 'soft' && r.json.by === OWNER, r.json);
    r = await call('POST', '/api/halt/resume', {});
    check('resume', r.status === 200 && r.json.mode === 'running', r.json);
    // cadence, panels, read-only reports
    r = await call('GET', '/api/cadence');
    check('cadence show', r.status === 200 && r.json.ok && r.json.dispatcherTickMin > 0, r.json);
    r = await call('GET', '/api/panels');
    check('panels list', r.status === 200 && r.json.ok && Array.isArray(r.json.panels), r.json);
    r = await call('GET', '/api/panels/nope/data');
    check('unknown panel data: 404', r.status === 404, r.json);
    r = await call('GET', '/api/onboarding');
    check('GET /api/onboarding: steps and checks, not certified', r.status === 200 && r.json.ok && Array.isArray(r.json.steps) && r.json.checks.length === 11 && r.json.certified === false, r.json);
    for (const ep of ['/api/handoffs', '/api/decisions', '/api/dispatch', '/api/hiring', '/api/crew', '/api/governance-log', '/api/usage']) {
      r = await call('GET', ep);
      check('GET ' + ep + ' answers JSON', r.status < 500 && r.json && typeof r.json === 'object', { status: r.status, body: r.text.slice(0, 300) });
    }
    // list endpoints page from the end of their file: limit + cursor, every line exactly once, oldest page last
    {
      const df = path.join(tmp, 'company', 'work', 'decisions.md'); const keep = fs.existsSync(df) ? fs.readFileSync(df) : null;
      fs.mkdirSync(path.dirname(df), { recursive: true }); fs.writeFileSync(df, '# Decisions\n\n' + Array.from({ length: 7 }, (_, i) => '- 2026-11-0' + (i + 1) + ' 09:00 decision ' + i).join('\n') + '\n');
      const seen = []; let cur = null, pages = 0;
      do { r = await call('GET', '/api/decisions?limit=3' + (cur != null ? '&cursor=' + cur : '')); seen.unshift(...r.json.entries.map(e => e.text)); cur = r.json.more ? r.json.cursor : null; pages++; } while (cur != null && pages < 10);
      check('GET /api/decisions?limit=3 pages back to the first line, each line once', pages === 3 && seen.join('\n') === fs.readFileSync(df, 'utf8').trim().split('\n').filter(l => l.trim()).join('\n'), { pages, seen });
      r = await call('GET', '/api/decisions?cursor=abc');
      check('a malformed cursor is a 400', r.status === 400, r.status);
      if (keep) fs.writeFileSync(df, keep); else fs.unlinkSync(df);
    }
    // core module mount
    r = await call('GET', '/api/m/demo/echo/hi');
    check('module owner route under /api/m/<id>/', r.status === 200 && r.json.what === 'hi' && r.json.owner === OWNER, r.json);
    r = await call('GET', '/api/m/demo/echo/hi', undefined, {});
    check('module owner route needs the owner token', r.status === 401, r.status);
    r = await call('POST', '/hooks/demo/in', { a: 1 }, { 'content-type': 'application/json', 'x-demo-secret': 's3' });
    check('module source route under /hooks/<id>/ without the owner token', r.status === 200 && r.json.bytes === 7, r.json);
    r = await call('POST', '/hooks/demo/in', { a: 1 }, { 'content-type': 'application/json' });
    check('module source route: the module refuses an unauthenticated caller', r.status === 401, r.status);
    r = await call('POST', '/hooks/demo/in', { big: 'x'.repeat(300 * 1024) }, { 'content-type': 'application/json', 'x-demo-secret': 's3' });
    check('module body cap 256 KB: 413', r.status === 413, r.status);
    r = await call('POST', '/hooks/nope/in', {}, { 'content-type': 'application/json' });
    check('a module that is not enabled has no route: 404', r.status === 404, r.status);
    r = await call('POST', '/api/today', {});
    check('wrong method: 405', r.status === 405, r.status);
    r = await call('POST', '/api/owner/messages', undefined, { 'x-console-token': token, 'content-type': 'text/plain' });
    check('non-JSON POST: 415', r.status === 415, r.status);
    // static
    r = await call('GET', '/', undefined, {});
    check('signed out, the app shell sends the browser to the login page', r.status === 303 && r.headers.location === '/login', r.status);
    r = await call('GET', '/');
    check('static index', r.status === 200 && /text\/html/.test(r.headers['content-type']), r.status);
    r = await call('GET', '/ds/styles.css', undefined, {});
    check('static css content type', r.status === 200 && /text\/css/.test(r.headers['content-type']), r.headers['content-type']);
    for (const t of ['/../server.js', '/%2e%2e/server.js', '/ds/..%2f..%2fserver.js', '/..%5cserver.js']) {
      r = await call('GET', t, undefined, {});
      check('traversal refused ' + t, r.status === 403 || r.status === 404 || r.status === 400, r.status);
      check('traversal leaks nothing ' + t, !/console\/server\.js — the owner console backend/.test(r.text));
    }
    // station proxy (station is down)
    r = await call('GET', '/api/station/state/snapshot');
    check('station proxy GET: 502 JSON', r.status === 502 && r.json && r.json.ok === false, r);
    r = await call('POST', '/api/station/cron/run', { id: 'x' });
    check('station proxy allowlisted POST: 502', r.status === 502 && r.json && r.json.ok === false, r.json);
    r = await call('POST', '/api/station/agents/delete', { id: 'x' });
    check('station proxy POST off the allowlist: 403', r.status === 403, r.json);
    r = await call('GET', '/api/station/../secrets');
    check('station proxy bad path refused', r.status === 400 || r.status === 404, r.status);
    // SSE
    const sse = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { 'x-console-token': token } }, res => {
        let d = ''; res.on('data', c => { d += c; if (/"topic":"owner"/.test(d)) { req.destroy(); resolve(true); } });
        setTimeout(() => call('POST', '/api/owner/messages', { text: 'sse ping' }), 300);
      });
      req.on('error', () => {}); req.end();
      setTimeout(() => { req.destroy(); resolve(false); }, 5000);
    });
    check('SSE change event on owner message', sse);
    // live chat, owner-message state and Now with the station down: every answer says why, none is silent
    r = await call('GET', '/api/chat/agent');
    check('GET /api/chat/agent: station down is a problem with its fix', r.status === 200 && r.json.ok && r.json.problems.some(p => p.code === 'station-down' && /systemctl/.test(p.fix)), r.json);
    r = await call('POST', '/api/chat/agent/send', { text: 'hello' });
    const lines = String(r.text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    check('POST /api/chat/agent/send: station down streams console.user then console.error', r.status === 200 && lines[0].name === 'console.user' && lines.some(l => l.name === 'console.error' && l.payload.code === 'station-down'), r.text);
    r = await call('GET', '/api/chat/nobody');
    check('GET /api/chat/<unknown seat>: 404', r.status === 404, r.status);
    // chat actions: a key field stores through the key store; the response never carries the value
    r = await call('POST', '/api/chat-actions/secret', { name: 'chat-feed-key', value: 'sk-chat-selftest-value-123456' });
    const cf = path.join(tmp, 'secrets', 'chat-feed-key');
    check('POST /api/chat-actions/secret: secrets/<name> 0600, the reply says where and how long, never the value', r.status === 200 && r.json.stored === 'secrets/chat-feed-key' && r.json.chars === 29 && !r.text.includes('sk-chat-selftest') && fs.existsSync(cf) && (fs.statSync(cf).mode & 0o777) === 0o600, r.json);
    r = await call('POST', '/api/chat-actions/secret', { name: 'chat-feed-key', value: 'other' });
    check('POST /api/chat-actions/secret: an existing key is not overwritten without replace (409)', r.status === 409 && fs.readFileSync(cf, 'utf8').startsWith('sk-chat'), r.json);
    r = await call('POST', '/api/chat-actions/secret', { name: 'station-token', value: 'x' });
    check('POST /api/chat-actions/secret: the station token is not a name a chat may write', r.status === 400, r.json);
    r = await call('GET', '/api/approvals');
    check('GET /api/approvals: the approval API answers (expiry and reminders run first, server-side)', r.status === 200 && Array.isArray(r.json.approvals), r.json);
    r = await call('POST', '/api/approvals/q-999999/answer', { verdict: 'yes', surface: 'chat' });
    check('POST /api/approvals/<no record>/answer: 404, nothing created', r.status === 404, r.json);
    r = await call('GET', '/api/owner/messages');
    check('owner messages carry a state; with the station down they are stuck with a fix', r.json.ok && r.json.messages.filter(m => m.dir === 'in').every(m => m.state && (m.state.status === 'stuck' || m.state.status === 'read' || m.state.status === 'answered')) && r.json.channel.problems.length > 0, r.json.channel);
    r = await call('GET', '/api/now');
    check('GET /api/now answers with the station down', r.status === 200 && r.json.ok && r.json.station.up === false && Array.isArray(r.json.seats), r.json);
    r = await call('GET', '/api/activity');
    check('GET /api/activity answers', r.status === 200 && r.json.ok && Array.isArray(r.json.items), r.json);
    r = await call('GET', '/api/setup/charter');
    check('GET /api/setup/charter: the text and its blanks', r.status === 200 && typeof r.json.text === 'string' && Array.isArray(r.json.placeholders), r.json);
    // Setup (console/setup.js), station down
    r = await call('GET', '/api/setup');
    check('GET /api/setup: seven steps, provider needs the station, not certified', r.status === 200 && r.json.ok && r.json.steps.length === 7 && r.json.total === 7 &&
      r.json.steps.find(x => x.id === 'provider').status === 'needs' && r.json.station.up === false && r.json.certified === false && r.json.providers.some(p => p.id === 'claude-cli'), r.json);
    r = await call('GET', '/api/company');
    check('GET /api/company carries the onboarding brief', r.json.onboarding && r.json.onboarding.certified === false, r.json);
    r = await call('POST', '/api/setup/company', { timezone: 'Mars/Olympus_Mons' });
    check('setup company: a bad timezone is refused (400)', r.status === 400, r.json);
    r = await call('POST', '/api/setup/company', { name: 'Selftest Co', ownerName: 'Pat Owner', timezone: 'Europe/London' });
    check('setup company: name, owner and timezone written', r.status === 200 && r.json.ok && readJson(path.join(tmp, 'company', 'company.json'), {}).owner.name === 'Pat Owner', r.json);
    r = await call('GET', '/api/company');
    check('GET /api/company shows the new name and timezone', r.json.name === 'Selftest Co' && r.json.timezone === 'Europe/London' && r.json.owner.name === 'Pat Owner', r.json);
    r = await call('POST', '/api/governance/preset', { preset: 'gate-money' });
    check('after the owner rename, owner writes still pass (--by the new name)', r.status === 200 && r.json.ok, r.json);
    r = await call('POST', '/api/setup/budget', { dailyUsd: -1 });
    check('setup budget: a negative cap is refused', r.status === 400, r.json);
    r = await call('POST', '/api/setup/budget', { dailyUsd: 2, perAgentUsd: 5 });
    check('setup budget: a share above the cap is refused', r.status === 400, r.json);
    r = await call('POST', '/api/setup/budget', { dailyUsd: 2, perAgentUsd: 1 });
    const bj = readJson(path.join(tmp, 'company', 'work', 'finance', 'dispatch-budget.json'), {});
    check('setup budget: dispatch-budget.json written as the owner, notes kept', r.status === 200 && bj.dailyUsd === 2 && bj.perAgentUsd === 1 && bj.setBy === 'Pat Owner' && !!bj._dailyUsd, bj);
    check('setup budget: the write is recorded for locked-watch (provenance)', fs.readFileSync(path.join(tmp, 'company', 'state', 'locked', 'provenance.jsonl'), 'utf8').includes('dispatch-budget.json'));
    r = await call('POST', '/api/setup/charter', { mandate: 'x' });
    check('setup charter: an empty mandate is refused', r.status === 400, r.json);
    r = await call('POST', '/api/setup/charter', { mandate: 'We write <great> software for small shops.', forWhom: 'Independent retailers', outOfScope: 'No regulated financial advice.', firstGoal: 'Ship a stock tracker.' });
    const chText = fs.readFileSync(path.join(tmp, 'company', 'CHARTER.md'), 'utf8');
    check('setup charter: CHARTER.md filled, no placeholders left', r.status === 200 && r.json.ok && SETUP.placeholders(chText).length === 0 && /Selftest Co/.test(chText) && /Independent retailers/.test(chText) && /## First goal/.test(chText), chText.slice(0, 600));
    r = await call('GET', '/api/setup');
    check('GET /api/setup: company, budget and charter now done', ['company', 'charter'].every(id => r.json.steps.find(x => x.id === id).status === 'done') && r.json.charter.forWhom === 'Independent retailers', r.json.steps);
    r = await call('POST', '/api/setup/provider', { provider: 'deepseek', key: 'k' });
    check('setup provider with the station down: 502', r.status === 502, r.json);
    r = await call('POST', '/api/setup/provider', { provider: 'nope' });
    check('setup provider: unknown provider 400', r.status === 400, r.json);
    r = await call('POST', '/api/station/auth/claude-cli/start', {});
    check('station proxy: the Claude sign-in is on the allowlist', r.status === 502, r.status);
    // Setup against a fake station: connect a key on a headless station, the onboarding gate is answered
    const fake = { calls: [], ready: false };
    const fsrv = http.createServer((req, res) => {
      let d = ''; req.on('data', c => { d += c; }); req.on('end', () => {
        const u = req.url.split('?')[0]; let b = {}; try { b = JSON.parse(d || '{}'); } catch (_) {}
        fake.calls.push({ m: req.method, u, key: b.key, provider: b.provider, baseUrl: b.baseUrl });
        const J = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers['x-starnet-token'] !== 'selftest-fake-station-token') return J(401, { error: 'token' });
        if (u === '/api/providers') return J(200, { providers: [{ id: 'deepseek', configured: fake.ready, unattendedReady: fake.ready, credential: { present: fake.ready } }, { id: 'claude-cli', configured: false, unattendedReady: false }] });
        if (u === '/api/auth/claude-cli/status') return J(200, { installed: true, loggedIn: false });
        if (u === '/api/providers/validate' && b.provider === 'custom') {
          // MiniMax: mm-cn-key answers only on api.minimaxi.com, mm-global-key only on api.minimax.io, mm-net-key nowhere
          if (b.key === 'mm-net-key') return J(200, { ok: false, credentialVerified: false, reachable: false, status: 'unreachable', error: 'fetch failed' });
          const good = (b.key === 'mm-cn-key' && /^https:\/\/api\.minimaxi\.com\//.test(b.baseUrl || '')) || (b.key === 'mm-global-key' && /^https:\/\/api\.minimax\.io\//.test(b.baseUrl || ''));
          return J(200, { ok: good, credentialVerified: good, reachable: true, status: good ? 'verified' : 'rejected', httpStatus: good ? 200 : 401, error: good ? undefined : 'provider rejected this key (HTTP 401) ' + b.key });
        }
        if (u === '/api/providers/validate') return J(200, { ok: b.key === 'good-key', credentialVerified: b.key === 'good-key', reachable: true, error: b.key === 'good-key' ? undefined : 'HTTP 401' });
        if (u === '/api/providers/connect') return J(409, { ok: false, provider: b.provider, code: 'no-page' });
        if (u === '/api/providers/engine-key') { fake.ready = true; return J(200, { ok: true, provider: b.provider, applied: true }); }
        J(404, { error: 'fake: ' + u });
      });
    });
    await new Promise(rs => fsrv.listen(0, '127.0.0.1', rs));
    const child2 = spawn(process.execPath, [__filename, '--port', '0', '--print-port'], { env: Object.assign({}, env, { STARNET_URL: 'http://127.0.0.1:' + fsrv.address().port }), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const port2 = await new Promise((resolve, reject) => { let buf = ''; child2.stdout.on('data', d => { buf += d; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); setTimeout(() => reject(new Error('second server did not start')), 10000); });
      const call2 = (method, p, body) => new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: port2, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
          let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
        });
        req.setTimeout(60000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
      });
      const gq = await new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'ask', '--from', 'onboard.js', '--about', 'onboarding', '--q',
        'Onboarding: a few things the new parts of the company need from you. It lets us finish setup; if you skip it, they stay off.\n- Hiring candidates default to the metered model deepseek/deepseek-flash, but the metered daily cap is $0.\nRecommendation: answer each line.'], { env }, (e, so) => res(JSON.parse(so))));
      r = await call2('GET', '/api/setup');
      check('fake station: GET /api/setup lists the onboarding question and the provider still needs you', r.json.station.up && r.json.steps.find(x => x.id === 'provider').status === 'needs' && r.json.onboardingQuestions.some(q => q.id === gq.id), r.json);
      r = await call2('POST', '/api/setup/provider/validate', { provider: 'deepseek', key: 'bad-key' });
      check('setup validate: a rejected key says so (valid false)', r.status === 200 && r.json.valid === false, r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'deepseek', key: 'bad-key' });
      check('setup provider: a rejected key is not saved (400)', r.status === 400 && !fake.calls.some(c => c.u === '/api/providers/engine-key'), r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'claude-cli' });
      check('setup provider: Claude not signed in is refused (400)', r.status === 400 && /not signed in/.test(r.json.error), r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'deepseek', key: ' good-\nkey ' });
      const pol = readJson(path.join(tmp, 'company', 'model-policy.json'), {});
      check('setup provider: a headless station gets the key through engine-key, candidate default set', r.status === 200 && r.json.connected && fake.calls.some(c => c.u === '/api/providers/engine-key' && c.key === 'good-key') && pol.candidateDefault.provider === 'deepseek' && pol.candidateDefault.setBy === 'Pat Owner', { r: r.json, cd: pol.candidateDefault });
      check('setup provider: the key never comes back in the answer', !JSON.stringify(r.json).includes('good-key'));
      r = await call2('GET', '/api/questions');
      check('setup provider: the onboarding gate question is answered', r.json.ok && !r.json.questions.some(q => q.id === gq.id), r.json);
      const vq = await askCli(['--message', 'The DeepSeek key, please.', '--kind', 'secret', '--name', 'deepseek-key', '--validate', 'deepseek']);
      const vq2 = await askCli(['--message', 'A second DeepSeek key.', '--kind', 'secret', '--name', 'deepseek-key-2', '--validate', 'deepseek']);
      r = await call2('POST', '/api/questions/' + vq.id + '/answer', { action: 'store', values: { key: 'good-key' } });
      check('secret with validate: the station checks it (validated: yes)', r.status === 200 && /validated: yes/.test(r.json.a) && fake.calls.some(c => c.u === '/api/providers/validate' && c.key === 'good-key'), r.json);
      r = await call2('POST', '/api/questions/' + vq2.id + '/answer', { action: 'store', values: { key: 'bad-key' } });
      check('secret with validate: a rejected key is stored and recorded as validated: no', r.status === 200 && /validated: no/.test(r.json.a) && fs.existsSync(path.join(tmp, 'secrets', 'deepseek-key-2')), r.json);
      r = await call2('GET', '/api/setup');
      check('fake station: provider and budget steps done', ['provider', 'budget'].every(id => r.json.steps.find(x => x.id === id).status === 'done'), r.json.steps);
      // MiniMax endpoints (company.json providers.minimax): migration default, detect, save, switch, custom URLs, questions
      const mmCfg = () => (readJson(path.join(tmp, 'company', 'company.json'), {}).providers || {}).minimax || null;
      let mmP = r.json.providers.find(p => p.id === 'custom');
      check('minimax: nothing stored = Global (today\'s behaviour): base URL, key page, three plain choices', !mmCfg() && mmP.endpoint.region === 'global' && !mmP.endpoint.stored && mmP.baseUrl === 'https://api.minimax.io/v1' && /platform\.minimax\.io/.test(mmP.keyUrl)
        && mmP.endpoint.choices.map(c => c.label).join('/') === 'Global/Mainland China/Custom', mmP);
      fake.calls.length = 0;
      r = await call2('POST', '/api/setup/provider/detect', { provider: 'custom', key: 'mm-cn-key' });
      check('minimax detect: tries Global then Mainland China through the station and picks the one that answers', r.status === 200 && r.json.found === 'cn' && /works on Mainland China/.test(r.json.text)
        && JSON.stringify(fake.calls.filter(c => c.u === '/api/providers/validate').map(c => c.baseUrl)) === JSON.stringify(['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1']), { r: r.json, calls: fake.calls });
      check('minimax detect: the key never comes back (not even inside a station error)', !JSON.stringify(r.json).includes('mm-cn-key'), r.json);
      check('minimax detect saves nothing', !mmCfg());
      r = await call2('POST', '/api/setup/provider/detect', { provider: 'custom', key: 'wrong-key' });
      check('minimax detect: a key no region accepts says so in plain words (bad key)', r.json.found === null && r.json.why === 'bad-key' && /Neither Global nor Mainland China accepted/.test(r.json.text), r.json);
      r = await call2('POST', '/api/setup/provider/detect', { provider: 'custom', key: 'mm-net-key' });
      check('minimax detect: no region reachable is a network problem, not a bad key', r.json.found === null && r.json.why === 'network' && /could be reached/.test(r.json.text), r.json);
      r = await call2('POST', '/api/setup/provider/validate', { provider: 'custom', key: 'mm-cn-key', region: 'cn' });
      check('minimax validate: checks against the chosen region', r.json.valid === true && r.json.endpoint.region === 'cn' && fake.calls.slice(-1)[0].baseUrl === 'https://api.minimaxi.com/v1', r.json);
      fake.calls.length = 0;
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', key: 'mm-global-key', region: 'cn', keepDefault: true });
      check('minimax connect: a key the chosen region refuses is not saved and the endpoint stays', r.status === 400 && /Mainland China did not accept/.test(r.json.error) && !mmCfg() && !fake.calls.some(c => c.u === '/api/providers/engine-key'), r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', key: 'mm-cn-key', region: 'cn', keepDefault: true });
      check('minimax connect: Mainland China saved once in company.json, the station gets its base URL', r.status === 200 && mmCfg() && mmCfg().region === 'cn' && !mmCfg().baseUrl
        && fake.calls.some(c => c.u === '/api/providers/engine-key' && c.baseUrl === 'https://api.minimaxi.com/v1'), { r: r.json, cfg: mmCfg(), calls: fake.calls });
      r = await call2('GET', '/api/setup'); mmP = r.json.providers.find(p => p.id === 'custom');
      check('minimax: Setup now shows Mainland China, its key page and base URL', mmP.endpoint.region === 'cn' && mmP.endpoint.stored && /platform\.minimaxi\.com/.test(mmP.keyUrl) && mmP.baseUrl === 'https://api.minimaxi.com/v1', mmP);
      const pacerP = require(path.join(tmp, 'company', 'tools', 'pacer.js')).loadPolicy(tmp);
      check('minimax: the pacer polls the Mainland China usage URL', pacerP.minimax.url === 'https://api.minimaxi.com/v1/token_plan/remains', pacerP.minimax);
      check('minimax: the change is in decisions.md', /set the MiniMax endpoint to Mainland China/.test(fs.readFileSync(path.join(tmp, 'company', 'work', 'decisions.md'), 'utf8')));
      // switching back with no key pasted: the key on file is re-checked on the new endpoint first
      fs.writeFileSync(path.join(tmp, 'secrets', 'minimax-key'), 'mm-cn-key\n', { mode: 0o600 });
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', region: 'global', keepDefault: true });
      check('minimax switch: the key on file does not work on Global, so nothing changes', r.status === 400 && /Global did not accept the key on file/.test(r.json.error) && mmCfg().region === 'cn' && !r.json.error.includes('mm-cn-key'), r.json);
      fs.writeFileSync(path.join(tmp, 'secrets', 'minimax-key'), 'mm-global-key\n', { mode: 0o600 });
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', region: 'global', keepDefault: true });
      check('minimax switch: re-validated on Global with the key on file, then saved', r.status === 200 && r.json.switched && mmCfg().region === 'global' && fake.calls.slice(-1)[0].baseUrl === 'https://api.minimax.io/v1', { r: r.json, cfg: mmCfg() });
      // custom base URLs
      r = await call2('POST', '/api/setup/provider/validate', { provider: 'custom', key: 'mm-global-key', region: 'custom', baseUrl: 'http://api.minimax.io/v1' });
      check('minimax custom: http is refused (400)', r.status === 400 && /https/.test(r.json.error), r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', key: 'mm-global-key', region: 'custom', baseUrl: 'https://llm.example.com/v1', keepDefault: true });
      check('minimax custom: a non-MiniMax host is refused unless "other" is ticked', r.status === 400 && /not a MiniMax address/.test(r.json.error) && mmCfg().region === 'global', r.json);
      r = await call2('POST', '/api/setup/provider', { provider: 'custom', key: 'mm-global-key', region: 'custom', baseUrl: 'https://api.minimax.io/v1/', keepDefault: true });
      check('minimax custom: a MiniMax https URL is saved with its address (trailing slash dropped)', r.status === 200 && mmCfg().region === 'custom' && mmCfg().baseUrl === 'https://api.minimax.io/v1' && r.json.endpoint.warnings.length === 0, { r: r.json, cfg: mmCfg() });
      // a typed owner question asking for the MiniMax key: the endpoint picked next to it is checked and saved
      const mq1 = await askCli(['--message', 'The MiniMax key, please.', '--kind', 'secret', '--name', 'minimax-key-q', '--validate', 'custom']);
      fake.calls.length = 0;
      r = await call2('POST', '/api/questions/' + mq1.id + '/answer', { action: 'store', values: { key: 'mm-cn-key' }, endpoints: { key: { region: 'cn' } } });
      check('minimax question: the key is checked on the picked region (validated: yes) and that region is saved', r.status === 200 && /validated: yes/.test(r.json.a) && mmCfg().region === 'cn'
        && fake.calls.some(c => c.u === '/api/providers/validate' && c.baseUrl === 'https://api.minimaxi.com/v1'), { r: r.json, cfg: mmCfg() });
      const mq2 = await askCli(['--message', 'Another MiniMax key.', '--kind', 'secret', '--name', 'minimax-key-q2', '--validate', 'custom']);
      r = await call2('POST', '/api/questions/' + mq2.id + '/answer', { action: 'store', values: { key: 'mm-cn-key' }, endpoints: { key: { region: 'global' } } });
      check('minimax question: a key the picked region refuses is stored as validated: no and the endpoint is not changed', r.status === 200 && /validated: no/.test(r.json.a) && /Global/.test(r.json.a) && mmCfg().region === 'cn' && !JSON.stringify(r.json).includes('mm-cn-key'), { r: r.json, cfg: mmCfg() });
      const mq3 = await askCli(['--message', 'A third MiniMax key.', '--kind', 'secret', '--name', 'minimax-key-q3', '--validate', 'custom']);
      r = await call2('POST', '/api/questions/' + mq3.id + '/answer', { action: 'store', values: { key: 'mm-cn-key' }, endpoints: { key: { region: 'custom', baseUrl: 'ftp://x' } } });
      check('minimax question: a bad custom URL is refused before the key file is written', r.status === 400 && !fs.existsSync(path.join(tmp, 'secrets', 'minimax-key-q3')), r.json);
    } finally { child2.kill(); fsrv.close(); }
    // the real company was not touched
    check('real company untouched', snap() === before);
  } catch (e) {
    check('selftest ran to the end', false, e.stack);
  } finally {
    child.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  const failed = cases.filter(c => !c.ok).length;
  console.log(failed ? 'CONSOLE SELFTEST FAILED: ' + failed + ' of ' + cases.length : 'CONSOLE SELFTEST PASSED: ' + cases.length + ' checks');
  return failed ? 1 : 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
  else if (argv.includes('--url')) process.exit(printUrl(argv));
  else if (argv.includes('--rotate-token')) process.exit(rotateToken());
  else if (argv.includes('--reset-login')) process.exit(resetLogin());
  else start(argv);
}
module.exports = { makeServer, start, postAllowed, loginLine, listenConfig, AUTH };
