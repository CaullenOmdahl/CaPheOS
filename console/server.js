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
function readLines(file) {
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = []; for (const l of t.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) {} }
  return out;
}
function tailLines(file, n) {
  let t = ''; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return t.split('\n').filter(l => l.trim()).slice(-n);
}
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

/* ---------------- auth ---------------- */
const TOKEN_FILE = path.join(co.SECRETS_DIR, 'console-token');
function consoleToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch (_) {}
  fs.mkdirSync(co.SECRETS_DIR, { recursive: true });
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (_) {}
  return t;
}
function cookies(req) { const o = {}; for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o; }
function same(a, b) { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); }

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
  return inbox.openQuestions().map(q => Object.assign({}, q, byId[q.id] ? { gate: { category: byId[q.id].category, ref: byId[q.id].ref, by: byId[q.id].by, summary: byId[q.id].summary } } : {}));
}
function answered(since) {
  const st = tool('inbox.js').state();
  const today = co.localParts().date;
  const sinceMs = since ? Date.parse(since) : NaN;
  return Object.values(st).filter(x => x.type === 'answer' || (x.a && x.q)).filter(x => x.a)
    .filter(x => Number.isFinite(sinceMs) ? Date.parse(x.at) >= sinceMs : co.localParts(new Date(x.at)).date === today)
    .map(x => ({ id: x.id, from: x.from, about: x.about, q: x.q, answer: x.a, answeredAt: x.at }));
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
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
  return { ok: true, seats, station: r.ok ? 'up' : 'down', stationError: r.ok ? undefined : r.error };
}
function decisions() { return { ok: true, entries: tailLines(co.p('company', 'work', 'decisions.md'), 100).map(text => ({ text })) }; }
function dispatchView() {
  return { ok: true, state: readJson(co.p('company', 'work', 'dispatch-state.json'), null), log: tailLines(co.p('company', 'work', 'dispatch-log.md'), 60) };
}
function hiring() {
  const dir = co.p('company', 'hiring'); const rounds = [];
  try { for (const d of fs.readdirSync(dir)) { const r = readJson(path.join(dir, d, 'round.json'), null); if (r) rounds.push(Object.assign({ id: d }, r)); } } catch (_) {}
  let templates = []; try { templates = fs.readdirSync(co.p('company', 'roles', 'templates')).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, '')); } catch (_) {}
  return { ok: true, rounds, templates };
}
async function usage() { try { return await runApi('pacer.js', ['status', '--json'], { timeout: 15000 }); } catch (e) { return { ok: false, error: e.message }; } }
function panelsList() { return tool('console-panel.js').listPanels(); }
async function today() {
  const since = Date.now() - 24 * 3600e3;
  const qs = questions();
  let unread = []; try { unread = tool('owner-inbox.js').unacked(); } catch (_) {}
  const outbound = (() => { try { return tool('owner-inbox.js').sent().filter(m => Date.parse(m.at) >= since); } catch (_) { return []; } })();
  const [crew, use] = await Promise.all([crewView(), usage()]);
  let panels = []; try { panels = panelsList().filter(p => p.status === 'installed' && !p.hidden && /^today/.test(String(p.placement || ''))).map(p => p.id); } catch (_) {}
  return { ok: true, company: companyInfo(), needsYou: { questions: qs, count: qs.length, blocking: qs.filter(q => q.blocking).length },
    crew, usage: use, overnight: { fromCompany: outbound, unreadByCompany: unread.length, dispatch: tailLines(co.p('company', 'work', 'dispatch-log.md'), 20) },
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
const CHAT = require(path.join(__dirname, 'chat.js'))({ co, stationGet, bad, HttpError, tool, owner: () => OWNER });
const ACT = require(path.join(__dirname, 'activity.js'))({ co, stationGet, emit: t => emit(t), tool });

route('GET', /^\/api\/company$/, () => Object.assign({ ok: true }, companyInfo()));
route('GET', /^\/api\/today$/, today);
route('GET', /^\/api\/questions$/, () => ({ ok: true, questions: questions() }));
route('GET', /^\/api\/questions\/answered$/, (m, q) => ({ ok: true, answered: answered(q.get('since')) }));
route('POST', /^\/api\/questions\/(q-\d+)\/answer$/, async (m, q, b) => {
  const id = m[1];
  if (!questions().some(x => x.id === id)) bad('no open question ' + id, 404);
  const extra = String(b.text || '').trim();
  let a;
  if (b.verdict === 'yes') a = 'yes' + (extra ? ': ' + extra : '');
  else if (b.verdict === 'no') a = 'no' + (extra ? ': ' + extra : '');
  else if (b.verdict === 'reply') { if (!extra) bad('text is required for a reply'); a = extra; }
  else bad('verdict must be yes, no or reply');
  if (a.startsWith('--')) a = ' ' + a;
  return runApi('inbox.js', ['answer', '--id', id, '--a', a, '--by', OWNER]);
});
route('GET', /^\/api\/owner\/messages$/, ownerChannel);
route('POST', /^\/api\/owner\/messages$/, async (m, q, b) => { const r = postOwnerMessage(b); const ch = await CHAT.channelState(); r.message = CHAT.messageStates([r.message], ch)[0]; r.channel = ch; return r; });
// live chat with a crew member (console/chat.js); POST /api/chat/<id>/send streams and is handled in makeServer
route('GET', /^\/api\/chat\/([A-Za-z0-9_-]{1,64})$/, m => CHAT.info(m[1]));
// the crew's work, visible (console/activity.js)
route('GET', /^\/api\/now$/, () => ACT.now());
route('GET', /^\/api\/now\/run\/([A-Za-z0-9_-]{1,80})$/, (m, q) => ACT.runEvents(m[1], q.get('after')));
route('GET', /^\/api\/activity$/, () => ACT.recent());
route('GET', /^\/api\/crew$/, crewView);
route('GET', /^\/api\/handoffs$/, () => runApi('handoff-status.js', ['--due', '--json']));
route('GET', /^\/api\/decisions$/, decisions);
route('GET', /^\/api\/dispatch$/, dispatchView);
route('GET', /^\/api\/hiring$/, hiring);
route('GET', /^\/api\/usage$/, usage);

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
route('GET', /^\/api\/cadence$/, () => runApi('cadence.js', ['show', '--json']));
route('POST', /^\/api\/cadence\/default$/, (m, q, b) => {
  const n = Number(b.minutes); if (!(n > 0)) bad('minutes must be a positive number');
  return runApi('cadence.js', ['set-default', String(n), '--by', OWNER]);
});
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
route('GET', /^\/api\/panels\/([a-z0-9-]+)\/data$/, async m => {
  if (!PANEL_ID.test(m[1])) bad('bad panel id');
  const r = await tool('console-panel.js').render(m[1], { live: true });
  if (!r.ok) throw new HttpError(/^no panel/.test(r.error || '') ? 404 : 400, r.error || 'render failed', r);
  return r;
});
route('POST', /^\/api\/panels\/([a-z0-9-]+)\/(hide|unhide|approve|reject|remove)$/, (m, q, b) => {
  if (!PANEL_ID.test(m[1])) bad('bad panel id');
  const args = [m[2], m[1], '--by', OWNER]; if (m[2] === 'reject' && b.note) args.push('--note', str(b.note, 'note'));
  return runApi('console-panel.js', args);
});
route('GET', /^\/api\/governance-log$/, () => ({ ok: true, entries: readLines(co.p('company', 'state', 'governance-log.jsonl')).slice(-200) }));
route('GET', /^\/api\/decision-models$/, () => runApi('decide.js', ['list', '--json']));
// onboarding (company/tools/onboard.js): provisioning steps + the last certification; POST certify re-runs the 9 checks
route('GET', /^\/api\/onboarding$/, () => runApi('onboard.js', ['--check', '--json']));
route('POST', /^\/api\/onboarding\/certify$/, async () => { const r = await run('onboard.js', ['--certify', '--json'], { timeout: 300000 }); return Object.assign({}, r.data, { ok: true, certified: !!(r.data && r.data.certified) }); });
// Setup (console/setup.js): the seven-step guided setup, every write as the owner
const SETUP = require(path.join(__dirname, 'setup.js'))({ co, run, runApi, stationGet, stationPost, owner: () => OWNER, setOwner: n => { OWNER = n || OWNER; }, bad, HttpError, tool, emit: t => emit(t) });
for (const [mth, re, fn] of SETUP.routes) route(mth, re, fn);
route('GET', /^\/api\/locked$/, () => runApi('locked-watch.js', ['status']));
route('GET', /^\/api\/external$/, () => runApi('external-gate.js', ['list']));

/* ---------------- events (SSE) ---------------- */
const clients = new Set();
const WATCHES = [
  ['questions', ['company'], f => f === 'pm-inbox.jsonl' || f === 'asks.jsonl'],
  ['owner', ['company', 'owner'], () => true],
  ['handoffs', ['company', 'work', 'handoffs'], () => true],
  ['halt', ['company', 'state'], f => f === 'halt.json'],
  ['governance', ['company', 'state'], f => f === 'governance.json' || f === 'governance-log.jsonl'],
  ['guardrails', ['company', 'state'], f => f === 'guardrails.json'],
  ['cadence', ['company', 'work', 'ops'], f => f === 'cadence.json'],
  ['panels', ['company', 'console'], f => f === 'state.json' || f === 'changes.jsonl' || f === 'panels' || f === 'proposed'],
  ['panels', ['company', 'console', 'panels'], () => true],
  ['dispatch', ['company', 'work'], f => f === 'dispatch-log.md' || f === 'dispatch-state.json'],
  ['crew', ['company', 'tools'], f => f === 'loops.json'],
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
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
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
function makeServer(token) {
  return http.createServer(async (req, res) => {
    let url; try { url = new URL(req.url, 'http://x'); } catch (_) { return sendJson(res, 400, { ok: false, error: 'bad url' }); }
    const p = url.pathname;
    try {
      if (p === '/login') {
        if (!same(url.searchParams.get('token'), token)) return sendJson(res, 401, { ok: false, error: 'bad token' });
        res.writeHead(302, { 'set-cookie': 'console_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000', location: '/' });
        return res.end();
      }
      const hk = p.match(/^\/hooks\/([^/]+)(?:\/(.*))?$/);
      if (hk) return await moduleRoute(req, res, url, 'source', hk[1], hk[2]);
      if (!p.startsWith('/api/') && p !== '/api') return serveStatic(req, res, p);
      if (!same(req.headers['x-console-token'] || cookies(req).console_token, token)) return sendJson(res, 401, { ok: false, error: 'owner token required (x-console-token header or console_token cookie; GET /login?token=...)' });
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
      const cm = p.match(/^\/api\/chat\/([A-Za-z0-9_-]{1,64})\/send$/);
      if (cm) { if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' }); return await CHAT.send(req, res, cm[1], await readBody(req)); }
      for (const r of routes) {
        const m = p.match(r.re); if (!m) continue;
        if (req.method !== r.method) continue;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const out = await r.fn(m, url.searchParams, body);
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
function listenConfig(argv) {
  const cc = co.config.console || {};
  const flag = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  let stationPort = 0; try { stationPort = Number(new URL(co.STATION_URL).port) || 0; } catch (_) {}
  const port = flag('port') !== undefined ? Number(flag('port')) : process.env.CONSOLE_PORT ? Number(process.env.CONSOLE_PORT) : cc.port || (stationPort ? stationPort + 100 : 8901);
  return { host: flag('host') || cc.host || '127.0.0.1', port };
}
function start(argv) {
  const token = consoleToken();
  const { host, port } = listenConfig(argv);
  const server = makeServer(token);
  armWatches();
  setInterval(armWatches, 15000).unref();
  ACT.start();
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();
  server.listen(port, host, () => {
    const a = server.address();
    const shown = host.includes(':') ? '[' + host + ']' : host;
    if (argv.includes('--print-port')) console.log(JSON.stringify({ port: a.port }));
    else console.log('console: http://' + shown + ':' + a.port + '/login?token=' + token + '\n(company root ' + co.ROOT + ', station ' + co.STATION_URL + ')');
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
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + dead });
  delete env.CONSOLE_PORT;
  const child = spawn(process.execPath, [__filename, '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', d => { errText += d; });
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
    const cookie = String((r.headers['set-cookie'] || [''])[0]).split(';')[0];
    check('login sets cookie and redirects', r.status === 302 && cookie === 'console_token=' + token, r.headers);
    r = await call('GET', '/api/company', undefined, { cookie });
    check('cookie auth works', r.status === 200 && r.json.ok && r.json.owner && r.json.owner.name === OWNER, r.json);
    r = await call('GET', '/api/today');
    check('today', r.status === 200 && r.json.ok && r.json.needsYou && Array.isArray(r.json.needsYou.questions) && r.json.halt && r.json.halt.mode === 'running', r.json);
    // questions
    const ask = await new Promise(res => execFile(process.execPath, [path.join(tmp, 'company', 'tools', 'inbox.js'), 'ask', '--from', 'Selftest', '--about', 'console', '--q', 'May we test the console?', '--blocking'], { env }, (e, so) => res(JSON.parse(so))));
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
        fake.calls.push({ m: req.method, u, key: b.key });
        const J = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.headers['x-starnet-token'] !== 'selftest-fake-station-token') return J(401, { error: 'token' });
        if (u === '/api/providers') return J(200, { providers: [{ id: 'deepseek', configured: fake.ready, unattendedReady: fake.ready, credential: { present: fake.ready } }, { id: 'claude-cli', configured: false, unattendedReady: false }] });
        if (u === '/api/auth/claude-cli/status') return J(200, { installed: true, loggedIn: false });
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
        'Onboarding: what the enabled packs and modules need from you (one batch, asked once):\n- Hiring candidates default to the metered model deepseek/deepseek-flash, but the metered daily cap is $0.\nRecommendation: answer each line.'], { env }, (e, so) => res(JSON.parse(so))));
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
      r = await call2('GET', '/api/setup');
      check('fake station: provider and budget steps done', ['provider', 'budget'].every(id => r.json.steps.find(x => x.id === id).status === 'done'), r.json.steps);
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
  else start(argv);
}
module.exports = { makeServer, start, postAllowed };
