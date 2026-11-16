#!/usr/bin/env node
/* station-view.js — let the crew SEE the real station (floor, top bar, crew rail, dock) without touching anything.
 *
 * Why: the owner wants the agents to "break the 4th wall" — look at the actual StarNet interface they live in, for the
 * company's own checks and for any public record of the company's progress. The owner drives the station page in a
 * browser of their own; this tool NEVER uses the owner's browser or tab at all. Every command starts its own
 * throwaway viewer and throws it away again:
 *   · a headless Chrome with a fresh private profile (no storage, journals, tab channel or page lock shared with the
 *     owner's browser), driven over --remote-debugging-pipe (no debugging port another process could attach to);
 *   · all of its traffic goes through a GET-only filter in this process: any POST/PUT/PATCH/DELETE, any other host, any
 *     tunnel or websocket is refused before it reaches the station, so the viewer cannot save, push the roster, change a
 *     setting or an agent, start a run, ack a bridge verb or stamp presence — whatever the page tries;
 *   · the live event feed passes only when StarNet patch 0008 (viewer mode) is applied AND the running station marks a
 *     viewer feed (then the station does not count the viewer as an open page). Otherwise the feed is held and the view
 *     is "static": the real floor and crew as the station has them, without live walk-ups (status says which);
 *   · Chrome runs with its home, config, data, cache and temp folders inside that throwaway profile and an environment of
 *     its own (no desktop session, no keyring, no crash reporter), so nothing it writes lands in the owner's folders or
 *     the station's data folder;
 *   · private and secret surfaces are not drawn (COMMS, the session rail, notifications, windows and their minimized
 *     chips, widget rails, every sign-in or settings screen, the camera frame's activity ticker), in-world speech bubbles
 *     and task plates are off, and every capture is checked first: any visible text, image or frame outside the allowed
 *     surfaces refuses the capture.
 * Agents never pass page code: the commands and their flags are fixed, and every id is checked against the station. That
 * is a rule of this tool, not a lock: everyone runs as one Unix user, so anyone with a shell and the token could drive a
 * browser by hand (company/work/STATION-VIEW.md "Do not"). The tool's own test hooks (STATION_VIEW_PORT, _TOKEN_FILE,
 * _CHROME, _FFMPEG, _SCREENS) work only against a scratch station (never the company's configured station port) with captures in a scratch
 * folder outside company/ (never company/work/screens/), and only then does require() hand out the viewer itself.
 *
 *   node company/tools/station-view.js status
 *   node company/tools/station-view.js shot [--room <name|id>] [--agent <id|name>] [--prop <type>] [--zoom <0.5-6>] [--cinema]
 *        [--size 720p|1080p] [--format png|jpeg|webp] [--out <path under company/work/screens/>] [--by <name>]
 *   node company/tools/station-view.js look "<closed question>" [same flags as shot]     (shot, then vision.js)
 *   node company/tools/station-view.js look "<question>" --repeat 3      one capture, the same question 3 times (2-5):
 *        every answer printed plus whether they agreed; a split reports itself as unknown, not as the first answer
 *   node company/tools/station-view.js look --objects "camera, crates, easel"   one capture, one closed yes/no per
 *        object, printed as a `table` of "object | yes|no|unclear" — a room summary is not stable enough to be a check
 *   node company/tools/station-view.js selftest      the pure half of `look`, graded free (no browser, no vision call)
 *   node company/tools/station-view.js clip --seconds <1-30> [--cinecam | same focus flags] [--cinema] [--size 720p|1080p] [--out x.mp4]
 *   --cinema: the station's own floor-only layout (no panels); --cinecam: the station's auto-director picks the shots
 *
 * Output: one JSON object (ok, file, mode, focus, privacy, network). Files go under company/work/screens/<date>/ and that
 * folder keeps at most 200 files, 7 days and 500 MB (oldest go first). Anything made public goes through the risk owner's
 * redaction rule and company/tools/external-gate.js first (company/work/STATION-VIEW.md).
 * Owner of this tool: the tools seat (loops.json function `tools`); security review: the risk seat (function `risk`).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const co = require('./lib/company');
const ROOT = co.ROOT;
const REAL_SCREENS = co.p('company', 'work', 'screens');
const VISION = co.p('company', 'tools', 'vision.js');
// test hooks (company/tools/tests): a scratch station on another loopback port with its own token file, captures in a
// scratch folder. Any hook set = test mode, which testGuard() holds to a scratch station and a scratch folder.
const HOOKS = ['STATION_VIEW_PORT', 'STATION_VIEW_TOKEN_FILE', 'STATION_VIEW_CHROME', 'STATION_VIEW_FFMPEG', 'STATION_VIEW_SCREENS'].filter(k => process.env[k] != null && process.env[k] !== '');
const TEST = HOOKS.length > 0;
// the company's own station (co.STATION_URL: env STARNET_URL, else company.json station.url/port). A test run may never
// point at it; the viewer only ever talks to loopback, so a station URL on another host is refused outright.
const LIVE_URL = (() => { try { return new URL(co.STATION_URL); } catch (_) { return null; } })();
const LIVE_PORT = LIVE_URL ? Number(LIVE_URL.port || (LIVE_URL.protocol === 'https:' ? 443 : 80)) : NaN;
const PORT = Number(process.env.STATION_VIEW_PORT || LIVE_PORT);
const TOKEN_FILE = process.env.STATION_VIEW_TOKEN_FILE || null;   // null = the company's station token (secrets/station-token)
const CHROME = process.env.STATION_VIEW_CHROME || '/usr/bin/google-chrome-stable';
const FFMPEG = process.env.STATION_VIEW_FFMPEG || '/usr/bin/ffmpeg';
const SCREENS = TEST && process.env.STATION_VIEW_SCREENS ? path.resolve(process.env.STATION_VIEW_SCREENS) : REAL_SCREENS;
const HOST = '127.0.0.1';
const KEEP_FILES = 200, KEEP_DAYS = 7, KEEP_BYTES = 500 * 1024 * 1024;
const MEDIA_RE = /\.(png|jpe?g|webp|mp4)$/i;
const SIZES = { '720p': [1280, 720], '1080p': [1920, 1080] };
const RUNTIME = (process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR)) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
const LOCK = path.join(RUNTIME, TEST ? 'station-view-test-' + PORT + '.lock' : 'station-view.lock');   // a test run never blocks a real capture
const LOG = path.join(SCREENS, 'captures.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let TOKEN = null;
function token() { if (TOKEN == null) TOKEN = TOKEN_FILE ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : co.stationToken(); return TOKEN; }   // never printed
function out(code, o) { process.stdout.write(JSON.stringify(o, null, 1) + '\n'); process.exitCode = code; }
class Refusal extends Error { constructor(m, code) { super(m); this.refusal = true; this.code = code || 3; } }
// test mode never reaches the live station and never writes into company/ (so a capture of a fake station can never sit
// in company/work/screens/ looking real); null = fine
function testProblem() {
  if (!TEST) {
    if (!LIVE_URL || !['127.0.0.1', 'localhost'].includes(LIVE_URL.hostname)) return 'the station URL (' + co.STATION_URL + ') is not on loopback; the viewer only ever talks to 127.0.0.1';
    return null;
  }
  if (!process.env.STATION_VIEW_PORT) return 'test hooks (' + HOOKS.join(', ') + ') need STATION_VIEW_PORT set to a scratch station\'s port';
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === LIVE_PORT) return 'test hooks (' + HOOKS.join(', ') + ') need STATION_VIEW_PORT set to a scratch station\'s port, never ' + LIVE_PORT;
  if (!process.env.STATION_VIEW_TOKEN_FILE) return 'test hooks need STATION_VIEW_TOKEN_FILE: the scratch station\'s own token, never the company\'s';
  if (!process.env.STATION_VIEW_SCREENS) return 'test hooks need STATION_VIEW_SCREENS: a scratch folder for the captures, outside company/';
  let real = SCREENS; try { real = fs.realpathSync(SCREENS); } catch (_) {}
  const company = (() => { try { return fs.realpathSync(path.join(ROOT, 'company')); } catch (_) { return path.join(ROOT, 'company'); } })();
  for (const c of [SCREENS, real]) if (c === company || c.startsWith(company + path.sep) || c === path.join(ROOT, 'company') || c.startsWith(path.join(ROOT, 'company') + path.sep)) return 'STATION_VIEW_SCREENS must be outside company/ (test captures never mix with real ones)';
  return null;
}
function testGuard() { const p = testProblem(); if (p) throw new Refusal(p, 2); }
const fileLabel = p => (TEST ? p : path.relative(ROOT, p));   // what the output and the log call a file

// ---------------------------------------------------------------- arguments (fixed flags only)
const FLAGS = { room: 1, agent: 1, prop: 1, zoom: 1, size: 1, format: 1, out: 1, by: 1, seconds: 1, cinecam: 0, cinema: 0, repeat: 1, objects: 1 };
function parse(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) { a._.push(x); continue; }
    const k = x.slice(2);
    if (!(k in FLAGS)) throw new Refusal('unknown flag --' + k + ' (flags: ' + Object.keys(FLAGS).map(f => '--' + f).join(' ') + ')', 2);
    if (FLAGS[k]) { const v = argv[++i]; if (v == null || v.startsWith('--')) throw new Refusal('--' + k + ' needs a value', 2); a[k] = v; }
    else a[k] = true;
  }
  return a;
}
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
function sizeOf(a, dflt) { const s = a.size || dflt; if (!SIZES[s]) throw new Refusal('--size must be 720p or 1080p', 2); return { name: s, w: SIZES[s][0], h: SIZES[s][1] }; }
function zoomOf(a) {
  if (a.zoom == null) return null;
  const z = Number(a.zoom);
  if (!Number.isFinite(z) || z < 0.5 || z > 6) throw new Refusal('--zoom must be a number from 0.5 to 6', 2);
  return z;
}
/* ---- look: asking the same capture more than once, or asking about objects ----
 * The failure this fixes: an open multiple-choice question ("which of these is it — machine room / records store /
 * money office / design studio") can answer "records store" and then "design studio" five minutes later on unchanged
 * content, and flip several times in a row. One closed question about one object is stable first time. So the instrument was fine
 * and the question was wrong — the tool now makes both shapes easy instead of leaving the discipline to the asker:
 *   --repeat <n>   one capture, the same question n times (2..5): every answer is printed, plus whether they agreed.
 *   --objects "a, b"  one capture, one closed yes/no per named object: a table, not a summary of the room.
 * The answers are still a second opinion (the tool says so in every output); what changes is that a single answer is no
 * longer the same object as five answers that all said the same thing, and now you can see which one you have.
 */
function repeatOf(a) {
  if (a.repeat == null) return 1;
  const n = Number(a.repeat);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Refusal('--repeat takes a whole number from 1 to 5 (cost is one vision call per repeat)', 2);
  return n;
}
function objectsOf(a) {
  if (a.objects == null) return null;
  const list = String(a.objects).split(',').map(s => s.trim().replace(/[."]+$/, '')).filter(Boolean);
  if (!list.length) throw new Refusal('--objects needs one or more names, comma separated: --objects "camera, crates"', 2);
  if (list.length > 8) throw new Refusal('--objects takes at most 8 names (each one is a vision call on the same capture)', 2);
  for (const o of list) if (o.length > 40) throw new Refusal('--objects names must be under 40 characters: "' + o.slice(0, 20) + '…"', 2);
  return list;
}
// A yes/no read of free text, deterministic and deliberately narrow: a leading YES/NO wins, otherwise the first
// standalone yes/no word, otherwise "unclear". A model that answers with a paragraph is not counted as agreeing.
const yesNo = text => {
  const s = String(text == null ? '' : text).replace(/[*_`]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'unclear';
  const lead = s.match(/^(?:answer\s*[:\-]?\s*)?(yes|no)\b/i);
  if (lead) return lead[1].toLowerCase();
  const any = s.match(/\b(yes|no)\b/i);
  if (any) return any[1].toLowerCase();
  return 'unclear';
};
// Do the answers agree? Strict majority of the normalised text, and the text itself is kept so paraphrase reads as
// paraphrase rather than as disagreement about the room.
const normAnswer = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function majorityOf(answers) {
  const list = (answers || []).map(x => ({ raw: x, key: normAnswer(x) }));
  const counts = new Map();
  for (const x of list) counts.set(x.key, (counts.get(x.key) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const of = list.length;
  const top = ranked[0] || [null, 0];
  const agreed = of > 0 && top[1] * 2 > of;               // strictly more than half
  const tied = ranked.filter(r => r[1] === top[1]).map(r => r[0]);
  return { of, agreed, count: top[1], answer: agreed ? (list.find(x => x.key === top[0]) || {}).raw : null,
    distinct: ranked.length, tied: agreed ? [] : tied.slice(0, 4) };
}
function asksForObjects(o) { return o.map(obj => ({ object: obj, question: 'Does this image show ' + obj + '? Answer with one word: YES or NO.' })); }
function visionAsk(file, question, by) {
  const r = spawnSync(process.execPath, [VISION, file, String(question)].concat(by ? ['--by', by] : []), { encoding: 'utf8', timeout: 660000, cwd: ROOT });
  let ans = null; try { ans = JSON.parse(r.stdout); } catch (_) {}
  if (ans && ans.ok) return { ok: true, answer: ans.answer };
  return { ok: false, error: 'vision.js: ' + ((ans && ans.error) || String(r.stderr || r.stdout || 'no answer').slice(0, 200)) };
}
function byOf(a) { if (a.by == null) return null; if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(a.by)) throw new Refusal('--by must be a plain name', 2); return a.by; }

// ---------------------------------------------------------------- the station (read-only calls from this process)
function request(method, p, { auth = true, timeoutMs = 15000, headOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method, timeout: timeoutMs, headers: auth ? { 'x-starnet-token': token() } : {} }, res => {
      if (headOnly) { resolve({ status: res.statusCode, headers: res.headers, body: '' }); res.destroy(); req.destroy(); return; }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end();
  });
}
async function stationFacts() {
  const f = { station: false, viewerPage: false, viewerFeed: false };
  try { const r = await request('GET', '/api/version'); f.station = r.status === 200; try { const j = JSON.parse(r.body); f.version = j.app || j.version || null; } catch (_) {} } catch (e) { f.error = e.message; }
  if (!f.station) return Object.assign(f, { mode: 'down' });
  // patch 0008 on the frontend: the station serves app/viewer.js (static, no token)
  try { const r = await request('GET', '/app/viewer.js', { auth: false }); f.viewerPage = r.status === 200 && r.body.includes('company patch 0008'); } catch (_) {}
  // patch 0008 in the RUNNING sidecar: it marks a viewer feed. This probe is a Node client (header token), which the
  // station never counts as a page; it reads the reply headers and hangs up at once.
  try { const r = await request('GET', '/api/channels/events?viewer=1', { headOnly: true, timeoutMs: 5000 }); f.viewerFeed = String(r.headers['x-starnet-viewer'] || '') === '1'; } catch (_) {}
  f.mode = (f.viewerPage && f.viewerFeed) ? 'live' : 'static';
  return f;
}
async function saveFacts() {
  const r = await request('GET', '/api/save?agent=agent', { timeoutMs: 20000 });
  let doc = null; try { doc = JSON.parse(r.body).save; } catch (_) {}
  if (!doc) throw new Refusal('the station did not return its save (GET /api/save ' + r.status + ')', 1);
  const st = doc.station || {};
  const rooms = Object.entries(st.rooms || {}).map(([id, v]) => ({ id, name: String((v && v.name) || '') }));
  const agents = [];
  const seen = new Set();
  for (const x of [doc.agent].concat(doc.agents || [])) if (x && x.id && !seen.has(x.id)) { seen.add(x.id); agents.push({ id: String(x.id), name: String(x.name || '') }); }
  const props = Array.isArray(st.props) ? st.props : Object.values(st.props || {});
  const propTypes = [...new Set(props.map(p => p && String(p.t || '')).filter(Boolean))].sort();
  return { rooms, agents, propTypes };
}
// --room/--agent/--prop: matched against the station's own save; the page only ever gets a known id
async function focusOf(a) {
  const n = ['room', 'agent', 'prop', 'cinecam'].filter(k => a[k] != null);
  if (n.length > 1) throw new Refusal('pick one of --room, --agent, --prop' + (a.cinecam ? ', --cinecam' : ''), 2);
  if (!n.length) return { kind: 'station' };
  if (a.cinecam) return { kind: 'cinecam' };
  const facts = await saveFacts();
  const want = String(a[n[0]]).trim();
  const lc = want.toLowerCase();
  if (a.room != null) {
    const r = facts.rooms.find(x => x.id === want) || facts.rooms.find(x => x.name.toLowerCase() === lc);
    if (!r) throw new Refusal('no room "' + want.slice(0, 40) + '"; rooms: ' + facts.rooms.map(x => x.name || x.id).join(', '), 2);
    return { kind: 'room', id: r.id, label: r.name || r.id };
  }
  if (a.agent != null) {
    const g = facts.agents.find(x => x.id === want) || facts.agents.find(x => x.name.toLowerCase() === lc);
    if (!g) throw new Refusal('no agent "' + want.slice(0, 40) + '"; agents: ' + facts.agents.map(x => x.id + (x.name ? ' (' + x.name + ')' : '')).join(', '), 2);
    if (!ID_RE.test(g.id)) throw new Refusal('agent id not usable', 2);
    return { kind: 'agent', id: g.id, label: g.name || g.id };
  }
  const t = facts.propTypes.find(x => x === want) || facts.propTypes.find(x => x.toLowerCase() === lc);
  if (!t || !/^[a-z0-9_-]{1,40}$/.test(t)) throw new Refusal('no prop of type "' + want.slice(0, 40) + '"; types on the floor: ' + facts.propTypes.join(', '), 2);
  return { kind: 'prop', id: t, label: t };
}

// ---------------------------------------------------------------- output files and retention
function outPath(a, focus, ext) {
  if (a.out != null) {
    const raw = String(a.out);
    if (!/^[A-Za-z0-9._/-]{1,160}$/.test(raw) || raw.split('/').includes('..')) throw new Refusal('--out: letters, digits, . _ - / only, no ..', 2);
    const rel = raw.replace(/^company\/work\/screens\//, '');
    const p = path.resolve(SCREENS, rel);
    if (!p.startsWith(SCREENS + path.sep)) throw new Refusal('--out must be under company/work/screens/', 2);
    if (path.extname(p).toLowerCase() !== ext && !(ext === '.jpg' && path.extname(p).toLowerCase() === '.jpeg')) throw new Refusal('--out must end in ' + ext, 2);
    return p;
  }
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const tag = (focus.kind === 'station' || focus.kind === 'cinecam') ? focus.kind : focus.kind + '-' + String(focus.label || focus.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  return path.join(SCREENS, day, pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + tag + ext);
}
function prepareOut(p) {
  fs.mkdirSync(SCREENS, { recursive: true });
  const realScreens = fs.realpathSync(SCREENS);
  const inside = r => r === realScreens || r.startsWith(realScreens + path.sep);
  const there = x => { try { fs.lstatSync(x); return true; } catch (_) { return false; } };
  // the nearest folder that already exists must resolve inside screens/ BEFORE anything is created (a symlink in the
  // path must not get folders made at its far end); a dangling link does not resolve and is refused
  let d = path.dirname(p);
  while (!there(d) && d !== path.dirname(d)) d = path.dirname(d);
  let realD = null; try { realD = fs.realpathSync(d); } catch (_) {}
  if (!realD || !inside(realD)) throw new Refusal('--out resolves outside company/work/screens/', 2);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const realDir = fs.realpathSync(path.dirname(p));
  if (!inside(realDir)) throw new Refusal('--out resolves outside company/work/screens/', 2);
  try { if (fs.lstatSync(p).isSymbolicLink()) throw new Refusal('--out is a symlink', 2); } catch (e) { if (e.refusal) throw e; }
}
function listMedia(dir) {
  const root = dir || SCREENS;
  const outl = [];
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.name.startsWith('.')) continue; if (e.isDirectory()) walk(p); else if (e.isFile() && MEDIA_RE.test(e.name)) { try { const s = fs.statSync(p); outl.push({ p, t: s.mtimeMs, b: s.size }); } catch (_) {} } } };
  walk(root);
  return outl.sort((x, y) => x.t - y.t);
}
// oldest first: anything past KEEP_DAYS, then until at most KEEP_FILES files and KEEP_BYTES bytes remain (media only)
function prune(dir, lim) {
  const root = dir || SCREENS, L = Object.assign({ files: KEEP_FILES, days: KEEP_DAYS, bytes: KEEP_BYTES }, lim || {});
  const files = listMedia(root); let removed = 0;
  const cutoff = Date.now() - L.days * 86400000;
  let total = files.reduce((s, f) => s + f.b, 0), count = files.length;
  for (const f of files) {
    if (!(f.t < cutoff || count > L.files || total > L.bytes)) break;
    try { fs.unlinkSync(f.p); removed++; count--; total -= f.b; } catch (_) {}
  }
  // empty day folders go too
  try { for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)) { const d = path.join(root, e.name); if (!fs.readdirSync(d).length) fs.rmdirSync(d); } } catch (_) {}
  return { removed, kept: count, bytes: total };
}
function logCapture(entry) {
  if (TEST) entry.station = 'scratch 127.0.0.1:' + PORT;   // a test station, never confused with the real one
  try {
    fs.mkdirSync(SCREENS, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 2000) { const tmp = LOG + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, lines.slice(-1500).join('\n') + '\n'); fs.renameSync(tmp, LOG); }
  } catch (_) {}
}

// ---------------------------------------------------------------- one capture at a time
function takeLock() {
  for (let i = 0; i < 2; i++) {
    try { const fd = fs.openSync(LOCK, 'wx', 0o600); fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); fs.closeSync(fd); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null; try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (_) {}
      const alive = !!(held && held.pid && pidAlive(held.pid));
      if (alive && held && Date.now() - held.at < 5 * 60000) throw new Refusal('another station-view capture is running (pid ' + held.pid + '); try again in a minute', 3);
      try { fs.unlinkSync(LOCK); } catch (_) {}
    }
  }
  throw new Refusal('could not take the capture lock', 3);
}
function dropLock() { try { const held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (held.pid === process.pid) fs.unlinkSync(LOCK); } catch (_) {} }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// throwaway profiles a killed run left behind (an agent run's timeout can SIGKILL this tool before it cleans up). Each
// profile names its owner's pid; one whose owner is gone (or, unnamed, older than 15 minutes) is removed.
const PROFILE_RE = /^station-view-[A-Za-z0-9]{6}$/;
const OWNER_FILE = 'station-view-owner.json';
function leftoverProfiles() {
  let es = []; try { es = fs.readdirSync(RUNTIME, { withFileTypes: true }); } catch (_) { return []; }
  const outl = [];
  for (const e of es) {
    if (!e.isDirectory() || !PROFILE_RE.test(e.name)) continue;
    const d = path.join(RUNTIME, e.name);
    let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(d, OWNER_FILE), 'utf8')); } catch (_) {}
    let age = 0; try { age = Date.now() - fs.statSync(d).mtimeMs; } catch (_) {}
    if ((owner && owner.pid) ? !pidAlive(owner.pid) : age > 15 * 60000) outl.push(d);
  }
  return outl;
}
function sweepProfiles() {
  let n = 0;
  for (const d of leftoverProfiles()) {
    // a Chrome that outlived its owner (it normally exits when the pipe closes) goes first, only if it is that profile's
    let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(d, OWNER_FILE), 'utf8')); } catch (_) {}
    if (owner && owner.chrome && pidAlive(owner.chrome)) { try { if (fs.readFileSync('/proc/' + owner.chrome + '/cmdline', 'utf8').includes(d + path.sep)) process.kill(owner.chrome, 'SIGKILL'); } catch (_) {} }
    try { fs.rmSync(d, { recursive: true, force: true }); n++; } catch (_) {}
  }
  return n;
}

// ---------------------------------------------------------------- the GET-only filter every viewer request goes through
const PROBE_PATH = '/__station_view_probe__';
function startFilter(opts) {
  const tally = { forwarded: 0, refused: {}, feed: 'none' };
  const refuse = (res, status, what, code) => {
    tally.refused[what] = (tally.refused[what] || 0) + 1;
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'X-StarNet-Code': code || 'viewer_readonly', 'Cache-Control': 'no-store' });
    res.end(status === 204 ? undefined : JSON.stringify({ ok: false, error: 'read-only viewer', code: code || 'viewer_readonly' }));
  };
  // GETs that change state on the station (sign-in callbacks) are refused like writes
  const SIDE_EFFECT_GETS = /^\/api\/(connectors\/oauth\/callback|spotify\/callback)/;
  const server = http.createServer((req, res) => {
    let u = null; try { u = new URL(req.url); } catch (_) {}
    const method = String(req.method || '').toUpperCase();
    if (!u || u.protocol !== 'http:' || !['127.0.0.1:' + PORT, 'localhost:' + PORT].includes(u.host)) return refuse(res, 403, method + ' offsite', 'viewer_offsite');
    const what = method + ' ' + u.pathname;
    if (u.pathname === PROBE_PATH) { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); return res.end('<!doctype html><title>probe</title><p id="probe">' + opts.probeMark + '</p>'); }
    if (method !== 'GET' && method !== 'HEAD') return refuse(res, 403, what);
    if (SIDE_EFFECT_GETS.test(u.pathname)) return refuse(res, 403, what);
    if (u.pathname === '/api/channels/events') {
      // the live feed: only a viewer-marked feed, only when the running station leaves viewers out of its open pages
      if (!(opts.live && u.searchParams.get('viewer') === '1')) { tally.feed = 'held'; return refuse(res, 204, 'GET /api/channels/events (held)'); }
      tally.feed = 'live';
    }
    const headers = Object.assign({}, req.headers);
    for (const h of ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer']) delete headers[h];
    headers.host = HOST + ':' + PORT;
    tally.forwarded++;
    const up = http.request({ host: HOST, port: PORT, method, path: u.pathname + u.search, headers }, r => {
      const h = Object.assign({}, r.headers); delete h.connection; delete h['keep-alive'];
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('error', () => { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch (_) {} });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, sock) => { tally.refused['CONNECT ' + String(req.url).slice(0, 60)] = (tally.refused['CONNECT ' + String(req.url).slice(0, 60)] || 0) + 1; sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  server.on('upgrade', (req, sock) => { tally.refused['UPGRADE ' + String(req.url).slice(0, 60)] = (tally.refused['UPGRADE ' + String(req.url).slice(0, 60)] || 0) + 1; sock.destroy(); });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, HOST, () => resolve({ port: server.address().port, tally, close: () => new Promise(r => { server.close(() => r()); setTimeout(r, 1000); try { server.closeAllConnections(); } catch (_) {} }) }));
  });
}

// ---------------------------------------------------------------- the throwaway viewer (headless Chrome over a pipe)
function cdpPipe(proc) {
  const w = proc.stdio[3], r = proc.stdio[4];
  let id = 0; const pend = new Map(); const listeners = new Set(); let parts = [];
  r.on('data', chunk => {
    let start = 0, i;
    while ((i = chunk.indexOf(0, start)) >= 0) {
      parts.push(chunk.slice(start, i));
      const text = Buffer.concat(parts).toString('utf8'); parts = []; start = i + 1;
      let m; try { m = JSON.parse(text); } catch (_) { continue; }
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); clearTimeout(p.t); m.error ? p.rej(new Error(m.error.message || 'cdp error')) : p.res(m.result); }
      else for (const l of listeners) { try { l(m); } catch (_) {} }
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
  r.on('error', () => {}); w.on('error', () => {});
  const send = (method, params, sessionId, timeoutMs) => new Promise((res, rej) => {
    const mid = ++id;
    const t = setTimeout(() => { pend.delete(mid); rej(new Error('viewer did not answer ' + method)); }, timeoutMs || 30000);
    pend.set(mid, { res, rej, t });
    try { w.write(JSON.stringify(Object.assign({ id: mid, method, params: params || {} }, sessionId ? { sessionId } : {})) + '\0'); } catch (e) { clearTimeout(t); pend.delete(mid); rej(e); }
  });
  return { send, on: f => listeners.add(f), off: f => listeners.delete(f) };
}

/* What a capture may show. An allowlist: the floor (#stage + its camera frame), the top bar, the crew rail's crew list and
   the dock. Everything else is not drawn (display:none, which no rule inside can undo). Same rules as patch 0008's own. */
const HIDE_CSS = [
  'html.sv-capture body > :not(#screen-game):not(#logo):not(#viewer-badge):not(#sv-badge):not(script):not(style):not(link) { display: none !important; }',
  'html.sv-capture #screen-game > :not(#topbar):not(#left):not(#stage-wrap):not(#crew-resizer):not(#chat-panel):not(#bottombar) { display: none !important; }',
  'html.sv-capture #wr-top, html.sv-capture #wr-bot, html.sv-capture #ws-wrap, html.sv-capture #crew-vresizer, html.sv-capture #crew-search-wrap,',
  'html.sv-capture #bottombar .bb-menu, html.sv-capture #chat-panel > :not(.sv-note):not(.viewer-note), html.sv-capture #stage-wrap > :not(#stage):not(.cam-hud) { display: none !important; }',
  // the camera frame keeps its corners and two fixed chips (CINEMA, AUTO CAM/TRACKING); its activity ticker (who ran what,
  // the cost, raw error text), feed and rec readouts and anything added later are not drawn; nor are the dock's
  // minimized-window chips (session titles) or the topbar's hidden focused-agent/model fields
  'html.sv-capture #stage-wrap .cam-hud > :not(.cam-c):not(.cam-cine):not(.cam-mode), html.sv-capture #term-strip, html.sv-capture #gt-agent, html.sv-capture #gt-model { display: none !important; }',
  'html.sv-capture #crew { max-height: none !important; flex: 1 1 auto !important; }',
  'html.sv-capture .sv-note { display: flex; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 48px; padding: 10px; letter-spacing: .22em; opacity: .5; }',
  '#sv-badge { position: fixed; z-index: 2147483647; top: 6px; left: 50%; transform: translateX(-50%); padding: 2px 10px; font: 14px/1.4 VT323, monospace; letter-spacing: .18em; color: #111; background: #ffb000; border-radius: 3px; pointer-events: none; opacity: .9; }',
].join('\n');
const EARLY = `(() => {
  const css = ${JSON.stringify(HIDE_CSS)};
  const dress = () => {
    if (!document.documentElement) return;
    document.documentElement.classList.add('sv-capture');
    if (!document.getElementById('sv-style')) { const s = document.createElement('style'); s.id = 'sv-style'; s.textContent = css; (document.head || document.documentElement).appendChild(s); }
    if (document.body && !document.getElementById('viewer-badge') && !document.getElementById('sv-badge')) { const b = document.createElement('div'); b.id = 'sv-badge'; b.textContent = 'VIEWER \\u00B7 READ-ONLY'; document.body.appendChild(b); }
    const note = (host, text) => { if (!host || host.querySelector('.sv-note, .viewer-note')) return; const d = document.createElement('div'); d.className = 'sv-note'; d.textContent = text; host.appendChild(d); };
    note(document.getElementById('chat-panel'), 'COMMS \\u00B7 PRIVATE');
  };
  try { dress(); } catch (_) {}
  document.addEventListener('readystatechange', dress); document.addEventListener('DOMContentLoaded', dress);
  window.addEventListener('load', () => { const a = document.getElementById('viewer-badge'), b = document.getElementById('sv-badge'); if (a && b) b.remove(); if (document.querySelector('.viewer-note')) document.querySelectorAll('.sv-note').forEach(n => n.remove()); });
})()`;
const READY = `(() => { const g = document.getElementById('screen-game'); const a = document.querySelector('.screen.active');
  return { game: !!(g && g.classList.contains('active')), screen: a ? a.id : null, world: (typeof World !== 'undefined') && !!(World.cameraState && World.cameraState().scale > 0),
    viewer: window.__STARNET_VIEWER__ === true, guards: (window.__STARNET_VIEWER_STATE__ && window.__STARNET_VIEWER_STATE__.guards) || [] }; })()`;
// live mode: what the page itself refused (patch 0008 stops writes inside the page, so the filter never sees them)
const PAGE_REFUSED = `(() => { try { const r = window.__STARNET_VIEWER_STATE__ && window.__STARNET_VIEWER_STATE__.refused(); return r ? r.count : null; } catch (_) { return null; } })()`;
// every visible text, image or frame must sit inside an allowed surface; never echoes the text itself
const PRIVACY = `(() => {
  const problems = [];
  const g = document.getElementById('screen-game');
  if (!g || !g.classList.contains('active')) problems.push('the station floor is not on screen');
  if (!document.getElementById('sv-style')) problems.push('the hide rules are missing');
  const shown = el => { if (!el) return false; if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
  const DENY = ['#chat-log', '#chat-input', '#chat-inputrow', '#comms-idbar', '#comms-workpath', '#ws-wrap', '#workstreams', '#projects', '#ws-search', '#ws-needs',
    '#toast-stack', '#terms', '#screen-connect', '#in-key', '#wr-top', '#wr-bot', '#nav-coach', '.bb-menu', '#term-strip', '#stage-summary',
    '.cam-ticker', '.cam-feed', '.cam-label', '.cam-rec', '#gt-agent', '#gt-model', 'input', 'textarea', 'select', 'dialog'];
  for (const sel of DENY) for (const el of document.querySelectorAll(sel)) if (shown(el)) { problems.push('visible: ' + sel); break; }
  const ALLOW = '#topbar, #crew, #left > h3, #crew-sum, #stage, #stage-wrap > .cam-hud > .cam-c, #stage-wrap > .cam-hud > .cam-cine, #stage-wrap > .cam-hud > .cam-mode, #bottombar, #logo, #viewer-badge, #sv-badge, .sv-note, .viewer-note';
  const BAD_INSIDE = '#wr-top, #wr-bot, .bb-menu, #ws-wrap, #term-strip, #gt-agent, #gt-model';
  const out = el => !el.closest(ALLOW) || !!el.closest(BAD_INSIDE);
  const seen = new Set(); const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = tw.nextNode()) && problems.length < 12) {
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    const el = n.parentElement; if (!el || seen.has(el)) continue; seen.add(el);
    if (el.closest('script, style, noscript, template')) continue;
    if (shown(el) && out(el)) problems.push('text outside the allowed surfaces: ' + name(el));
  }
  for (const el of document.querySelectorAll('img, iframe, video, canvas, object, embed, svg image')) if (problems.length < 12 && shown(el) && out(el)) problems.push('media outside the allowed surfaces: ' + name(el));
  return { ok: problems.length === 0, problems };
})()`;
// the camera, from fixed code; the only values that ever reach the page are a checked id and a number
function focusExpr(focus, zoom) {
  return `(async () => {
    const W = (typeof World !== 'undefined') ? World : null; if (!W) return { ok: false, error: 'the floor is not loaded' };
    try { W.setOverlays(false); } catch (_) {}
    try { W.setCinecamIdle(${focus.kind === 'cinecam' ? 1000 : 1e9}); } catch (_) {}
    const kind = ${JSON.stringify(focus.kind)}, id = ${JSON.stringify(focus.id || null)}, zoom = ${zoom == null ? 'null' : Number(zoom)};
    const rezoom = () => { if (zoom == null) return; const s = W.cameraState(); W.restoreCamera({ scale: zoom, cx: s.cx, cy: s.cy }); };
    if (kind === 'station') { if (W.frameReviewRoom(null) === false) return { ok: false, error: 'the floor is not baked yet' }; rezoom(); return { ok: true, camera: W.cameraState() }; }
    if (kind === 'cinecam') { W.frameReviewRoom(null); return { ok: true, camera: W.cameraState() }; }
    if (kind === 'room') { if (!W.frameReviewRoom(id)) return { ok: false, error: 'that room is not on the floor' }; rezoom(); return { ok: true, camera: W.cameraState() }; }
    if (kind === 'agent') {
      const live = (typeof App !== 'undefined' && App.agents) ? App.agents().some(x => x && x.id === id) : true;
      if (!live) return { ok: false, error: 'that agent is not on the floor' };
      W.lockBody(id, zoom == null ? 3 : zoom, { seatAt: 0.62 });
      return { ok: W.cameraMode() === 'lock', camera: W.cameraState(), error: W.cameraMode() === 'lock' ? undefined : 'that agent has no place on the floor yet' };
    }
    if (kind === 'prop') {
      const cv = document.getElementById('stage');
      let s = W.cameraState(); W.restoreCamera({ scale: zoom == null ? 3 : zoom, cx: s.cx, cy: s.cy });
      for (let i = 0; i < 4; i++) {
        const p = W._dbgPropClientPoint && W._dbgPropClientPoint(id); if (!p) return { ok: false, error: 'no prop of that type on the floor' };
        const r = (typeof U !== 'undefined' && U.pointerRect) ? U.pointerRect(cv) : cv.getBoundingClientRect();
        const dx = (p.clientX - (r.left + r.width / 2)) * (cv.width / r.width), dy = (p.clientY - (r.top + r.height / 2)) * (cv.height / r.height);
        s = W.cameraState(); W.restoreCamera({ scale: s.scale, cx: s.cx + dx / s.scale, cy: s.cy + dy / s.scale });
      }
      return { ok: true, camera: W.cameraState() };
    }
    return { ok: false, error: 'unknown focus' };
  })()`;
}
// CINEMA: the station's own floor-only layout (warroom.js toggles the same class); the panels are simply not laid out
const CINEMA_ON = "(() => { const g = document.getElementById('screen-game'); if (g) g.classList.add('cinema'); return !!g; })()";
const KEEP_QUIET = "(() => { try { World.setOverlays(false); } catch (_) {} return true; })()";

async function openViewer(size, live) {
  const probeMark = 'sv-' + process.pid + '-' + Date.now();
  const filter = await startFilter({ live, probeMark });
  sweepProfiles();
  const profile = fs.mkdtempSync(path.join(RUNTIME, 'station-view-'));
  fs.writeFileSync(path.join(profile, OWNER_FILE), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  // Chrome's whole world lives in the profile: its data, a home of its own (config, data, cache: crash reports, the NSS
  // store, mimeapps.list, the pulse cookie all land here, not in the owner's ~/.config or the station's XDG_DATA_HOME),
  // runtime and temp folders. Its environment is built from nothing: no desktop session (DISPLAY, Wayland, D-Bus, so no
  // keyring and no window that could take focus), none of the caller's variables (keys, tokens, the station's paths).
  const dir = sub => { const d = path.join(profile, sub); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
  const userData = dir('chrome'), home = dir('home'), runtime = dir('run'), tmp = dir('tmp');
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: dir('home/.config'), XDG_DATA_HOME: dir('home/.local/share'),
    XDG_CACHE_HOME: dir('home/.cache'), XDG_RUNTIME_DIR: runtime, TMPDIR: tmp, LANG: process.env.LANG || 'C.UTF-8' };
  if (process.env.TZ) env.TZ = process.env.TZ;
  const args = ['--headless=new', '--user-data-dir=' + userData, '--remote-debugging-pipe', '--proxy-server=http://' + HOST + ':' + filter.port, '--proxy-bypass-list=<-loopback>',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--disable-default-apps', '--metrics-recording-only', '--disable-crash-reporter', '--disable-breakpad', '--password-store=basic', '--use-mock-keychain',
    '--disable-features=MediaRouter,DialMediaRouteProvider', '--disable-notifications',
    '--mute-audio', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=' + size.w + ',' + size.h, 'about:blank'];
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env });
  try { fs.writeFileSync(path.join(profile, OWNER_FILE), JSON.stringify({ pid: process.pid, chrome: proc.pid || null, at: Date.now() }), { mode: 0o600 }); } catch (_) {}
  let dead = false; proc.on('exit', () => { dead = true; });
  const cdp = cdpPipe(proc);
  const v = { proc, cdp, filter, profile, session: null, frames: null,
    async close() {
      try { await cdp.send('Browser.close', {}, null, 3000); } catch (_) {}
      for (let i = 0; i < 20 && !dead; i++) await sleep(100);
      try { proc.kill('SIGKILL'); } catch (_) {}
      await filter.close();
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    } };
  cleanup.push(() => { try { proc.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} });
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', {}, null, 15000);
    let page = (targetInfos || []).find(t => t.type === 'page');
    if (!page) { const t = await cdp.send('Target.createTarget', { url: 'about:blank' }); page = { targetId: t.targetId }; }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    v.session = sessionId;
    v.s = (m, p, t) => cdp.send(m, p, sessionId, t);
    v.eval = async (expr, t) => { const r = await v.s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, t); if (r.exceptionDetails) throw new Error('viewer page error: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).slice(0, 160)); return r.result.value; };
    await v.s('Page.enable'); await v.s('Runtime.enable');
    await v.s('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
    // prove every request goes through the filter BEFORE the station page is ever loaded: the filter answers this URL itself
    await v.s('Page.navigate', { url: 'http://' + HOST + ':' + PORT + PROBE_PATH });
    let routed = false;
    for (let i = 0; i < 40 && !routed; i++) { await sleep(150); routed = await v.eval("(document.getElementById('probe') || {}).textContent || ''").then(t => t === probeMark).catch(() => false); }
    if (!routed) throw new Refusal('the viewer\'s traffic did not go through the read-only filter; refusing to load the station', 1);
    await v.s('Page.addScriptToEvaluateOnNewDocument', { source: EARLY });
    await v.s('Page.navigate', { url: 'http://' + HOST + ':' + PORT + '/?viewer=1' });
    let st = null;
    for (let i = 0; i < 120; i++) { await sleep(500); st = await v.eval(READY).catch(() => null); if (st && st.game && st.world) break; if (st && st.screen && !['screen-boot', 'screen-game'].includes(st.screen) && i > 30) break; }
    if (!st || !st.game || !st.world) throw new Refusal('the station page did not reach the floor (' + ((st && st.screen) || 'no screen') + '); nothing was captured', 1);
    v.ready = st;
    await sleep(3500);   // sprites, the floor bake and the first frames
    return v;
  } catch (e) { await v.close(); throw e; }
}
async function aim(v, focus, zoom, cinema) {
  if (cinema) { await v.eval(CINEMA_ON); await sleep(700); }   // the canvas resizes first, then the camera is framed on the new size
  const r = await v.eval(focusExpr(focus, zoom));
  if (!r || !r.ok) throw new Refusal('could not frame ' + focus.kind + (focus.label ? ' ' + focus.label : '') + ': ' + ((r && r.error) || 'unknown'), 1);
  await sleep(focus.kind === 'agent' ? 2600 : focus.kind === 'cinecam' ? 6000 : 1400);   // the follow camera eases in; the auto-director picks a shot
  return r.camera;
}
async function privacy(v) {
  await v.eval(KEEP_QUIET);
  const p = await v.eval(PRIVACY);
  if (!p || !p.ok) throw new Refusal('privacy check failed, nothing kept: ' + ((p && p.problems) || ['no answer']).join('; '), 3);
  return p;
}
// refused: what the filter stopped on the wire (static mode); pageRefused: what patch 0008 stopped inside the page (live mode)
const network = (v, pageRefused) => ({ forwardedGets: v.filter.tally.forwarded, refused: v.filter.tally.refused, pageRefused: pageRefused == null ? null : pageRefused, feed: v.filter.tally.feed });

// ---------------------------------------------------------------- commands
const cleanup = [];
async function cmdShot(a, question) {
  const size = sizeOf(a, '1080p');
  const fmt = a.format || 'png';
  if (!['png', 'jpeg', 'webp'].includes(fmt)) throw new Refusal('--format must be png, jpeg or webp', 2);
  const zoom = zoomOf(a), by = byOf(a);
  const facts = await stationFacts();
  if (!facts.station) throw new Refusal('the station is not answering on 127.0.0.1:' + PORT, 1);
  const focus = await focusOf(a);
  if (focus.kind === 'cinecam') throw new Refusal('--cinecam is for clip', 2);
  const file = outPath(a, focus, fmt === 'jpeg' ? '.jpg' : '.' + fmt);
  prepareOut(file);
  takeLock();
  let v = null;
  try {
    v = await openViewer(size, facts.mode === 'live');
    const camera = await aim(v, focus, zoom, !!a.cinema);
    const priv = await privacy(v);
    const cam = await v.eval('World.cameraState()').catch(() => camera);
    const shot = await v.s('Page.captureScreenshot', Object.assign({ format: fmt, captureBeyondViewport: false }, fmt === 'png' ? {} : { quality: 90 }), 60000);
    const after = await v.eval(PRIVACY);   // the frame did not change under the check
    if (!after.ok) throw new Refusal('privacy check failed right after the capture, nothing kept: ' + after.problems.join('; '), 3);
    const pageRefused = await v.eval(PAGE_REFUSED).catch(() => null);
    const tmp = file + '.partial'; fs.writeFileSync(tmp, Buffer.from(shot.data, 'base64')); fs.renameSync(tmp, file);
    const res = { ok: true, command: question ? 'look' : 'shot', file: fileLabel(file), bytes: fs.statSync(file).size, size: size.w + 'x' + size.h, format: fmt,
      mode: facts.mode, layout: a.cinema ? 'cinema' : 'station', focus: { kind: focus.kind, id: focus.id || null, label: focus.label || null }, zoom: cam ? +Number(cam.scale).toFixed(2) : null,
      privacy: { ok: priv.ok, checked: 'allowlist: floor, top bar, crew list, dock; overlays off' }, viewer: { patch0008: !!v.ready.viewer, guards: v.ready.guards }, network: network(v, pageRefused) };
    await v.close(); v = null;
    res.retention = prune();
    logCapture({ at: new Date().toISOString(), by, command: res.command, file: res.file, focus: res.focus, mode: res.mode, refused: Object.values(res.network.refused).reduce((s, x) => s + x, 0) + (res.network.pageRefused || 0) });
    return res;
  } finally { if (v) await v.close(); dropLock(); }
}
async function cmdLook(a) {
  const q = a._[1] ? String(a._[1]).trim() : '';
  const repeat = repeatOf(a), objects = objectsOf(a);
  if (!q && !objects) throw new Refusal('usage: look "<closed question>" [--repeat n] [--objects "a, b"] [shot flags]', 2);
  if (q.length > 600) throw new Refusal('keep the question under 600 characters', 2);
  if (objects && repeat > 1) throw new Refusal('--repeat and --objects together would ask ' + (repeat * objects.length) + ' questions; run them separately so the cost is visible', 2);
  const res = await cmdShot(Object.assign({}, a, { format: a.format || 'png' }), q || null);
  const file = path.isAbsolute(res.file) ? res.file : path.join(ROOT, res.file);
  res.command = 'look';
  res.question = q || null;
  res.calls = 0;                       // how many vision calls this answer cost, so a 5x question is visibly 5x
  const fail = m => { res.ok = false; res.error = m; };
  if (objects) {
    const rows = [];
    for (const o of asksForObjects(objects)) {
      res.calls++;
      const v = visionAsk(file, o.question, a.by);
      if (!v.ok) { fail('object "' + o.object + '": ' + v.error); break; }
      rows.push({ object: o.object, showed: yesNo(v.answer), answer: v.answer });
    }
    res.objects = rows;
    res.table = rows.map(r => r.object + ' | ' + r.showed);
    if (rows.length && rows.length === objects.length) {
      res.counts = rows.reduce((acc, r) => Object.assign(acc, { [r.showed]: (acc[r.showed] || 0) + 1 }), {});
      if (rows.some(r => r.showed === 'unclear')) res.note2 = 'an "unclear" row is not a no: ask it again as its own look';
    }
  } else {
    const answers = [];
    for (let i = 0; i < repeat; i++) {
      res.calls++;
      const v = visionAsk(file, q, a.by);
      if (!v.ok) { fail('ask ' + (i + 1) + ' of ' + repeat + ': ' + v.error); break; }
      answers.push(v.answer);
    }
    res.answers = answers;
    if (repeat > 1) { res.majority = majorityOf(answers); if (!res.majority.agreed) res.note2 = 'the asks did not agree — treat the answer as unknown, not as the first one'; }
    else res.answer = answers[0];
  }
  res.note = 'the vision answer is a second opinion, never the only check';
  return res;
}
async function cmdClip(a) {
  const secs = Number(a.seconds);
  if (!Number.isFinite(secs) || secs < 1 || secs > 30) throw new Refusal('clip needs --seconds from 1 to 30', 2);
  if (a.format) throw new Refusal('a clip is always mp4', 2);
  const size = sizeOf(a, '720p');
  const zoom = zoomOf(a), by = byOf(a);
  if (!fs.existsSync(FFMPEG)) throw new Refusal('ffmpeg is not installed at ' + FFMPEG, 1);
  const facts = await stationFacts();
  if (!facts.station) throw new Refusal('the station is not answering on 127.0.0.1:' + PORT, 1);
  const focus = await focusOf(a);
  const file = outPath(a, focus, '.mp4');
  prepareOut(file);
  takeLock();
  let v = null, ff = null;
  const tmp = file + '.partial.mp4';
  try {
    v = await openViewer(size, facts.mode === 'live');
    await aim(v, focus, zoom, !!a.cinema);
    await privacy(v);
    // constant 30 fps from the frames' own timestamps: StarNet draws only when something changes, so a frame is
    // repeated until the next one arrives. Frames go straight into ffmpeg (no frame files on disk).
    const FPS = 30;
    ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-movflags', '+faststart', '-f', 'mp4', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
    let ffErr = ''; ff.stderr.on('data', d => { ffErr += d; });
    const ffDone = new Promise(r => ff.on('exit', c => r(c)));
    let t0 = null, last = null, written = 0, frames = 0, stopped = false;
    const put = (buf, until) => { const need = Math.round((until - t0) * FPS); while (written < need) { ff.stdin.write(buf); written++; } };
    const onFrame = m => {
      if (m.method !== 'Page.screencastFrame' || m.sessionId !== v.session) return;
      v.s('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
      if (stopped) return;
      const ts = (m.params.metadata && m.params.metadata.timestamp) || (Date.now() / 1000);
      const buf = Buffer.from(m.params.data, 'base64');
      if (t0 == null) t0 = ts;
      if (ts > t0 + secs) return;   // the clip is exactly --seconds long from its first frame
      if (last) put(last, ts);
      last = buf; frames++;
    };
    v.cdp.on(onFrame);
    await v.s('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: size.w, maxHeight: size.h, everyNthFrame: 1 });
    const startedAt = Date.now();
    let checks = 0;
    while (Date.now() - startedAt < secs * 1000) {
      await sleep(1000);
      const p = await v.eval(PRIVACY).catch(() => ({ ok: false, problems: ['no answer'] }));
      checks++;
      if (!p.ok) { stopped = true; throw new Refusal('privacy check failed during the clip, nothing kept: ' + p.problems.join('; '), 3); }
      await v.eval(KEEP_QUIET).catch(() => {});
    }
    stopped = true;
    await v.s('Page.stopScreencast').catch(() => {});
    v.cdp.off(onFrame);
    if (!last) throw new Refusal('the viewer sent no frames', 1);
    put(last, t0 + secs);
    ff.stdin.end();
    const code = await ffDone;
    if (code !== 0 || !fs.existsSync(tmp)) throw new Error('ffmpeg failed: ' + ffErr.slice(0, 200));
    fs.renameSync(tmp, file);
    const pageRefused = await v.eval(PAGE_REFUSED).catch(() => null);
    const res = { ok: true, command: 'clip', file: fileLabel(file), bytes: fs.statSync(file).size, seconds: secs, fps: FPS, sourceFrames: frames, size: size.w + 'x' + size.h,
      mode: facts.mode, layout: a.cinema ? 'cinema' : 'station', focus: { kind: focus.kind, id: focus.id || null, label: focus.label || null }, privacy: { ok: true, checks }, viewer: { patch0008: !!v.ready.viewer, guards: v.ready.guards }, network: network(v, pageRefused) };
    await v.close(); v = null;
    res.retention = prune();
    logCapture({ at: new Date().toISOString(), by, command: 'clip', file: res.file, focus: res.focus, mode: res.mode, seconds: secs, refused: Object.values(res.network.refused).reduce((s, x) => s + x, 0) + (res.network.pageRefused || 0) });
    return res;
  } finally {
    if (ff && ff.exitCode == null) { try { ff.stdin.destroy(); } catch (_) {} try { ff.kill('SIGKILL'); } catch (_) {} }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    if (v) await v.close();
    dropLock();
  }
}
async function cmdStatus() {
  const facts = await stationFacts();
  const media = listMedia();
  let lock = null; try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (_) {}
  const lockAlive = !!(lock && lock.pid && pidAlive(lock.pid));
  const leftovers = leftoverProfiles().length;
  const notes = [];
  if (TEST) notes.push('TEST MODE (' + HOOKS.join(', ') + '): scratch station 127.0.0.1:' + PORT + ', captures in ' + SCREENS);
  if (lock && !lockAlive) notes.push('a capture was killed before it finished (pid ' + lock.pid + ' is gone): the next capture takes the lock back and clears what it left');
  if (facts.mode === 'static') notes.push(facts.viewerPage ? 'patch 0008 is on disk but the running station does not mark viewer feeds yet: restart ' + (co.config.station.serviceName || 'the station service') + ' to get live mode'
    : 'patch 0008 (viewer mode) is not applied: captures are static (real floor and crew, no live walk-ups); see company/patches/README.md');
  if (facts.mode === 'live') notes.push('live mode: the viewer hears the event feed, and the station does not count it as an open page');
  return { ok: facts.station, station: facts.station ? 'up' : 'down', version: facts.version || null, mode: facts.mode, patch0008: { frontend: facts.viewerPage, sidecar: facts.viewerFeed },
    chrome: fs.existsSync(CHROME), ffmpeg: fs.existsSync(FFMPEG), ownerTab: 'never used (this tool runs its own throwaway viewer)',
    screens: { dir: fileLabel(SCREENS), files: media.length, bytes: media.reduce((s, f) => s + f.b, 0), keep: KEEP_FILES + ' files, ' + KEEP_DAYS + ' days, ' + Math.round(KEEP_BYTES / 1048576) + ' MB' },
    busy: lockAlive ? { pid: lock.pid, since: new Date(lock.at).toISOString() } : null, staleLock: (lock && !lockAlive) ? { pid: lock.pid || null, since: lock.at ? new Date(lock.at).toISOString() : null } : null,
    leftoverProfiles: leftovers, notes };
}

const USAGE = 'usage: station-view.js status | selftest | shot [--room <name>|--agent <id>|--prop <type>] [--zoom n] [--cinema] [--size 720p|1080p] [--format png|jpeg|webp] [--out <path under company/work/screens/>] [--by <name>] | look "<closed question>" [--repeat 2-5] [--objects "a, b"] [shot flags] | clip --seconds <1-30> [--cinecam|focus flags] [--cinema] [--size 720p|1080p] [--out x.mp4]';

/* selftest — the pure half of `look`, graded without a browser and without spending a vision call. It proves the three
 * things that decide whether a repeated or an object question means anything: how a yes/no is read out of a paragraph,
 * when a set of answers counts as agreeing, and which flag values are refused. It cannot prove the capture or the model;
 * for those, `--repeat` prints every answer it got, so a wrong one is visible rather than averaged away. */
function selftest() {
  const cases = [];
  const ok = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  ok('yes: a bare "Yes."', yesNo('Yes.') === 'yes');
  ok('no: "No, there is no safe in the room."', yesNo('No, there is no safe in the room.') === 'no');
  ok('yes: a leading "Answer: YES"', yesNo('Answer: YES — a tripod is visible') === 'yes');
  ok('a hedged paragraph is unclear, not a yes', yesNo('It is hard to say; the image is small') === 'unclear');
  ok('no is not read out of "notable"', yesNo('A notable amount of clutter') === 'unclear');
  const agree = majorityOf(['records store', 'Records store.', 'records store', 'design studio']);
  ok('3 of 4 the same text agree, with the count', agree.agreed === true && agree.count === 3 && agree.of === 4 && agree.distinct === 2);
  const split = majorityOf(['records store', 'money office']);
  ok('a 1-1 split does not agree, and names the tie', split.agreed === false && split.answer === null && split.tied.length === 2);
  const paraphrase = majorityOf(['the room holds server racks', 'racks fill the room']);
  ok('two paraphrases of one meaning do NOT count as agreement', paraphrase.agreed === false);
  ok('an empty answer set is not agreement', majorityOf([]).agreed === false && majorityOf([]).of === 0);
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e.refusal ? e.message : 'threw a non-refusal: ' + e.message; } };
  ok('--repeat 0 is refused', !!threw(() => repeatOf({ repeat: '0' })));
  ok('--repeat 6 is refused', !!threw(() => repeatOf({ repeat: '6' })));
  ok('--repeat 3 is accepted', repeatOf({ repeat: '3' }) === 3);
  ok('no --repeat is one ask', repeatOf({}) === 1);
  ok('--objects splits on commas and trims', JSON.stringify(objectsOf({ objects: ' camera , crates/boxes , easel ' })) === JSON.stringify(['camera', 'crates/boxes', 'easel']));
  ok('--objects with only spaces is refused', !!threw(() => objectsOf({ objects: ' , ' })));
  ok('--objects with 9 names is refused', !!threw(() => objectsOf({ objects: Array.from({ length: 9 }, (_, i) => 'o' + i).join(',') })));
  ok('every object question is closed and names the object', asksForObjects(['floor safe'])[0].question === 'Does this image show floor safe? Answer with one word: YES or NO.');
  const failed = cases.filter(c => !c.pass);
  for (const c of cases) process.stdout.write((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']') + '\n');
  process.stdout.write('\nSTATION-VIEW LOOK SELFTEST: ' + (cases.length - failed.length) + ' passed, ' + failed.length + ' failed\n');
  return { ok: failed.length === 0, cases: cases.length, failed: failed.length };
}
async function main() {
  const a = parse(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'selftest') return selftest();   // pure helpers only: no station, no browser, no vision call
  testGuard();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'shot') { if (a._.length > 1) throw new Refusal('shot takes no other words; ' + USAGE, 2); if (a.seconds || a.cinecam) throw new Refusal('--seconds/--cinecam are for clip', 2); return cmdShot(a); }
  if (cmd === 'look') { if (a._.length > 2) throw new Refusal('put the question in quotes', 2); if (a.seconds || a.cinecam) throw new Refusal('--seconds/--cinecam are for clip', 2); return cmdLook(a); }
  if (cmd === 'clip') { if (a._.length > 1) throw new Refusal(USAGE, 2); if (a.format) throw new Refusal('a clip is always mp4', 2); return cmdClip(a); }
  throw new Refusal(USAGE, 2);
}
const bail = () => { for (const f of cleanup) try { f(); } catch (_) {} dropLock(); };
if (require.main === module) {
  process.on('SIGINT', () => { bail(); process.exit(130); });
  process.on('SIGTERM', () => { bail(); process.exit(143); });
  main().then(r => out(r && r.ok === false ? 1 : 0, r), e => { bail(); out(e.refusal ? e.code : 1, { ok: false, refused: !!e.refusal, error: String(e.message || e) }); });
} else {
  // for company/tools/tests/station-view.e2e.js only. The viewer itself (openViewer, whose eval runs any page code) is handed
  // out only in test mode against a scratch station; loaded any other way, this file gives the fixed rules and the pure
  // helpers and nothing that opens a page.
  module.exports = { PRIVACY, HIDE_CSS, READY, prune, listMedia, parse, SCREENS, TEST, testProblem,
    yesNo, majorityOf, repeatOf, objectsOf, asksForObjects, selftest };
  if (TEST && !testProblem()) Object.assign(module.exports, { openViewer, aim, privacy, stationFacts, startFilter });
}
