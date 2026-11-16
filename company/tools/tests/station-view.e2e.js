#!/usr/bin/env node
/* station-view.e2e.js — proof for company/tools/station-view.js against a SCRATCH station (never the live one).
 *
 * Boots a scratch StarNet sidecar from the tree you name (its own port, throwaway workspace, random token, cron and
 * night shift off), then runs the real CLI with its test hooks (STATION_VIEW_PORT, STATION_VIEW_TOKEN_FILE and
 * STATION_VIEW_SCREENS, a scratch capture folder: nothing of this test lands in company/work/screens/) and checks:
 *   1. status answers, and names the mode this tree gives (live with patch 0008, static without);
 *   2. shot (whole station), shot --agent, shot --room, shot --prop --cinema, clip --seconds 3 all succeed, pass the
 *      privacy check, and every file lands in the scratch capture folder;
 *   3. the station saw ZERO writes: no workspace file changed beyond what the sidecar writes on its own, the save
 *      revision and the roster are unchanged; in static mode the filter refused the page's own boot writes, in live mode
 *      the page itself did (pageRefused);
 *   4. the viewer's Chrome wrote nothing outside its throwaway profile (the tool runs with HOME and XDG_* pointed at an
 *      empty scratch home, which must stay empty) and left no profile behind;
 *   5. the privacy check bites: with the hide rules removed it fails (COMMS / the session rail are visible), a stray piece
 *      of text outside the allowed surfaces fails it, an activity ticker in the camera frame is hidden even off the glass
 *      theme and fails it when forced visible;
 *   6. bad input is refused: unknown flag, unknown agent, two focus flags, --out outside the folder or through a symlink
 *      (and no folder is made at the link's far end), page code; test hooks pointed at the company's own station port or at a capture folder
 *      inside company/ are refused; loaded without test hooks, the module hands out no viewer;
 *   7. a capture killed hard (SIGKILL, as an agent run's timeout may) leaves a stale lock that status names as stale, not
 *      busy, and the next capture takes the lock back and clears the leftover profile;
 *   8. retention keeps the newest files and drops the oldest past the limit (on a copy of the rule, in a temp folder).
 *
 *   node company/tools/tests/station-view.e2e.js --starnet <StarNet tree> [--port 8965] [--workspace-from <dir>] [--tool <station-view.js>]
 *
 * Exit 0 = every check passed. It never talks to the company's station: the port it boots on must differ from it.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
const TOOL = path.resolve(opt('tool') || path.join(__dirname, '..', 'station-view.js'));
const TREE = path.resolve(opt('starnet') || path.join(path.dirname(TOOL), '..', '..', 'starnet'));
const co = require(path.join(__dirname, '..', 'lib', 'company'));
// the company's own station port (co.STATION_URL): this test boots its own scratch station and must never share it
const LIVE_PORT = (() => { try { const u = new URL(co.STATION_URL); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch (_) { return NaN; } })();
const PORT = Number(opt('port') || 8965);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === LIVE_PORT) { console.error('refusing port ' + PORT + ': the scratch station needs its own port, never the company station\'s (' + LIVE_PORT + ')'); process.exit(2); }
const FROM = opt('workspace-from');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = fs.mkdtempSync(path.join(opt('base') || process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'sv-e2e-'));
const WS = path.join(BASE, 'workspace');
const SCREENS = path.join(BASE, 'screens');
const FAKEHOME = path.join(BASE, 'callerhome');   // the tool's caller environment: Chrome must write none of it
const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_FILE = path.join(BASE, 'token');
const RUNTIME = (process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR)) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

function hashTree(dir) {
  const o = {};
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() || e.isSymbolicLink()) { try { o[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (_) { o[path.relative(dir, p)] = 'x'; } } } };
  walk(dir); return o;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();
function boot() {
  fs.mkdirSync(WS, { recursive: true });
  const src = FROM ? path.resolve(FROM) : path.join(TREE, 'dev', 'fixtures', 'seed-workspace');
  for (const f of ['agent.save.json', 'agent.roster.json', '_commander.dossier.json']) { const p = path.join(src, f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(WS, f)); }
  try { const p = path.join(WS, 'agent.save.json'); const w = JSON.parse(fs.readFileSync(p, 'utf8')); const now = Date.now(); w.updatedAt = now; w.savedAt = now; if (w.doc) w.doc.updatedAt = now; fs.writeFileSync(p, JSON.stringify(w)); } catch (_) {}
  fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  const env = {}; for (const [k, v] of Object.entries(process.env)) if (!/^(STARNET|SKYNET|STATION_VIEW)_/.test(k)) env[k] = v;
  Object.assign(env, { SKYNET_DEV: '1', SKYNET_FULL_ACCESS: '1', SKYNET_WORKSPACES: WS, SKYNET_PORT: String(PORT), STARNET_API_TOKEN: TOKEN, SKYNET_DEFAULT_MODEL: 'anthropic/claude-sonnet-4.6',
    SKYNET_OPENROUTER_KEY: 'sk-or-sv-e2e-placeholder', XDG_DATA_HOME: path.join(BASE, 'xd'), XDG_CONFIG_HOME: path.join(BASE, 'xc'), XDG_CACHE_HOME: path.join(BASE, 'xk') });
  const log = fs.openSync(path.join(BASE, 'sidecar.log'), 'w');
  return spawn(process.execPath, [path.join(TREE, 'sidecar', 'index.js')], { cwd: TREE, env, stdio: ['ignore', log, log] });
}
const baseEnv = {}; for (const [k, v] of Object.entries(process.env)) if (!/^STATION_VIEW_/.test(k)) baseEnv[k] = v;
// the caller's home and XDG folders are an empty scratch home: whatever lands there came from the viewer's Chrome
const toolEnv = Object.assign({}, baseEnv, { STATION_VIEW_PORT: String(PORT), STATION_VIEW_TOKEN_FILE: TOKEN_FILE, STATION_VIEW_SCREENS: SCREENS,
  HOME: FAKEHOME, XDG_CONFIG_HOME: path.join(FAKEHOME, '.config'), XDG_DATA_HOME: path.join(FAKEHOME, '.local', 'share'), XDG_CACHE_HOME: path.join(FAKEHOME, '.cache') });
function run(args, env) {
  const r = spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8', env: env || toolEnv, timeout: 240000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return { code: r.status, json: j, raw: (r.stdout || '').slice(0, 400) + (r.stderr || '').slice(0, 400) };
}
async function saveHead() { try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/save?agent=agent', { headers: { 'x-starnet-token': TOKEN } }); const j = await r.json(); return JSON.stringify(j.head || null) + ':' + (j.save && j.save.updatedAt); } catch (e) { return 'err ' + e.message; } }
const inScratch = f => typeof f === 'string' && path.resolve(f).startsWith(SCREENS + path.sep);

(async () => {
  let side = null; const report = { tree: TREE, port: PORT, screens: SCREENS };
  fs.mkdirSync(FAKEHOME, { recursive: true });
  try {
    side = boot();
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/version', { signal: AbortSignal.timeout(2000) })).status > 0; } catch (_) {} }
    if (!check('scratch station is up', up)) throw new Error('sidecar did not start');
    const h0 = hashTree(WS); await sleep(8000); const h1 = hashTree(WS);
    const background = changed(h0, h1); report.backgroundWrites = background;
    const head0 = await saveHead();

    const st = run(['status']);
    check('status answers (test mode named)', st.code === 0 && st.json && st.json.station === 'up' && (st.json.notes || []).some(n => /TEST MODE/.test(n)), st.raw);
    const mode = st.json && st.json.mode; report.mode = mode;

    const shots = [
      ['shot', '--out', 'e2e/whole.png', '--by', 'e2e'],
      ['shot', '--agent', 'agent', '--size', '720p', '--format', 'webp', '--out', 'e2e/agent.webp'],
      ['shot', '--room', (FROM ? 'SERVER LAB' : 'HOME'), '--format', 'jpeg', '--out', 'e2e/room.jpg'],
      ['shot', '--prop', 'desk', '--cinema', '--size', '720p', '--out', 'e2e/prop.png'],
      ['shot'],
      ['clip', '--seconds', '3', '--out', 'e2e/clip.mp4'],
    ];
    report.captures = [];
    for (const args of shots) {
      const r = run(args);
      const j = r.json || {};
      report.captures.push({ args: args.join(' '), ok: j.ok, file: j.file, bytes: j.bytes, mode: j.mode, refused: j.network && j.network.refused, pageRefused: j.network && j.network.pageRefused, feed: j.network && j.network.feed, error: j.error });
      const label = args.slice(0, 3).join(' ');
      check(label + ' succeeds with privacy ok', r.code === 0 && j.ok === true && j.privacy && j.privacy.ok === true, j.error || r.raw.slice(0, 200));
      check(label + ' wrote a file in the scratch capture folder', inScratch(j.file) && fs.existsSync(j.file) && fs.statSync(j.file).size > 1000, j.file);
      if (mode === 'static') check(label + ' held the feed (static mode)', j.network && j.network.feed !== 'live', j.network && j.network.feed);
      if (mode === 'live') check(label + ' heard the live feed, and the page refused its own writes', j.network && j.network.feed === 'live' && j.network.pageRefused > 0, j.network);
    }
    if (mode === 'static') {
      const refusedWrites = report.captures.map(c => Object.keys(c.refused || {}).filter(k => /^(POST|PUT|PATCH|DELETE) \/api\//.test(k))).flat();
      check('static mode: the filter refused the page\'s own writes (they never reached the station)', refusedWrites.length > 0, [...new Set(refusedWrites)].slice(0, 12));
    }
    const h2 = hashTree(WS);
    const touched = changed(h1, h2).filter(f => !background.includes(f));
    report.workspaceChanges = touched;
    check('ZERO writes reached the station: no workspace file changed beyond background', touched.length === 0, touched);
    check('save head unchanged', (await saveHead()) === head0);
    const log = (() => { try { return fs.readFileSync(path.join(SCREENS, 'captures.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (_) { return []; } })();
    check('the capture log is in the scratch folder and marks the scratch station', log.length === shots.length && log.every(e => /^scratch 127\.0\.0\.1:/.test(e.station || '')), log.length);
    const homeLeft = Object.keys(hashTree(FAKEHOME));
    check('the viewer\'s Chrome wrote nothing in the caller\'s home or XDG folders', homeLeft.length === 0, homeLeft.slice(0, 10));
    const st2 = run(['status']).json || {};
    check('no throwaway profile or lock left behind', st2.leftoverProfiles === 0 && !st2.busy && !st2.staleLock, { leftoverProfiles: st2.leftoverProfiles, busy: st2.busy, staleLock: st2.staleLock });

    // 5. the privacy check bites (the module hands out the viewer only in test mode: set the hooks before require)
    Object.assign(process.env, { STATION_VIEW_PORT: String(PORT), STATION_VIEW_TOKEN_FILE: TOKEN_FILE, STATION_VIEW_SCREENS: SCREENS });
    const SV = require(TOOL);
    check('in test mode against a scratch station, the module hands out the viewer', typeof SV.openViewer === 'function');
    const facts = await SV.stationFacts();
    const v = await SV.openViewer({ w: 1280, h: 720 }, facts.mode === 'live');
    try {
      const ok = await v.eval(SV.PRIVACY);
      check('privacy check passes on the dressed page', ok.ok, ok.problems);
      await v.eval("(() => { const s = document.getElementById('sv-style'); if (s) s.disabled = true; const v = document.getElementById('viewer-style'); if (v) v.disabled = true; return 1; })()");
      await sleep(300);
      const bare = await v.eval(SV.PRIVACY);
      check('privacy check FAILS with the hide rules off', !bare.ok && bare.problems.some(p => /chat|ws-wrap|workstreams|outside/.test(p)), bare.problems);
      await v.eval("(() => { const s = document.getElementById('sv-style'); if (s) s.disabled = false; const v = document.getElementById('viewer-style'); if (v) v.disabled = false; return 1; })()");
      await v.eval("(() => { const d = document.createElement('div'); d.id = 'stray'; d.textContent = 'private words'; d.style.cssText = 'position:fixed;top:300px;left:300px;z-index:9;'; document.getElementById('left').appendChild(d); return 1; })()");
      const stray = await v.eval(SV.PRIVACY);
      check('privacy check FAILS on stray text outside the allowed surfaces (and never echoes it)', !stray.ok && !JSON.stringify(stray).includes('private words'), stray.problems);
      await v.eval("document.getElementById('stray').remove(), 1");
      await v.eval("(() => { const d = document.createElement('div'); d.textContent = 'body level'; document.body.appendChild(d); return 1; })()");
      const bodyLevel = await v.eval(SV.PRIVACY);
      check('a new body-level surface is hidden by the allowlist (privacy still ok)', bodyLevel.ok, bodyLevel.problems);
      // the activity ticker (who ran what, the cost, raw error text) — glass theme off, as on ?glass=0 or a later StarNet
      await v.eval("(() => { document.body.classList.remove('glass-demo'); const hud = document.querySelector('#stage-wrap .cam-hud'); const t = document.createElement('span'); t.id = 'e2e-ticker'; t.className = 'cam-ticker cam-ticker--on'; t.textContent = 'ALEX RUN COMPLETE 14 TURNS $0.43 127.0.0.1:9999'; hud.appendChild(t); return 1; })()");
      await sleep(200);
      const tick = await v.eval(SV.PRIVACY);
      check('an activity ticker in the camera frame is not drawn, even off the glass theme (privacy ok)', tick.ok, tick.problems);
      await v.eval("(() => { document.getElementById('e2e-ticker').style.setProperty('display', 'inline', 'important'); return 1; })()");
      await sleep(200);
      const tickOn = await v.eval(SV.PRIVACY);
      check('privacy check FAILS when the ticker is forced visible (and never echoes it)', !tickOn.ok && tickOn.problems.some(p => /cam-ticker/.test(p)) && !JSON.stringify(tickOn).includes('0.43'), tickOn.problems);
    } finally { await v.close(); }

    // 6. bad input
    fs.mkdirSync(path.join(BASE, 'outside'), { recursive: true });
    fs.mkdirSync(SCREENS, { recursive: true });
    fs.symlinkSync(path.join(BASE, 'outside'), path.join(SCREENS, 'link'));
    const bad = [
      [['shot', '--eval', 'alert(1)'], /unknown flag/],
      [['shot', '--agent', 'nobody-here'], /no agent/],
      [['shot', '--room', 'HOME', '--agent', 'agent'], /pick one/],
      [['shot', '--out', '../../etc/x.png'], /--out/],
      [['shot', '--out', '/tmp/x.png'], /--out/],
      [['shot', '--out', 'link/a/b/x.png'], /--out resolves outside/],
      [['shot', '--zoom', '99'], /--zoom/],
      [['clip', '--seconds', '99'], /--seconds/],
      [['shot', 'document.cookie'], /no other words|usage/],
      [['nonsense'], /usage/],
    ];
    for (const [args, re] of bad) { const r = run(args); check('refused: ' + args.join(' '), r.code !== 0 && r.json && r.json.ok === false && re.test(r.json.error || ''), r.json && r.json.error); }
    check('--out through a symlink made no folder at the link\'s far end', !fs.existsSync(path.join(BASE, 'outside', 'a')), fs.readdirSync(path.join(BASE, 'outside')));
    const hooksLive = run(['status'], Object.assign({}, baseEnv, { STATION_VIEW_PORT: String(LIVE_PORT), STATION_VIEW_TOKEN_FILE: TOKEN_FILE, STATION_VIEW_SCREENS: SCREENS }));
    check('test hooks pointed at the company station port ' + LIVE_PORT + ' are refused', hooksLive.code !== 0 && new RegExp('never ' + LIVE_PORT).test((hooksLive.json || {}).error || ''), hooksLive.json);
    const hooksChrome = run(['status'], Object.assign({}, baseEnv, { STATION_VIEW_CHROME: '/bin/true' }));
    check('a test hook alone (another Chrome, no scratch station) is refused', hooksChrome.code !== 0 && /STATION_VIEW_PORT/.test((hooksChrome.json || {}).error || ''), hooksChrome.json);
    const hooksCompany = run(['status'], Object.assign({}, toolEnv, { STATION_VIEW_SCREENS: path.join(path.dirname(TOOL), '..', 'work', 'screens', 'e2e-' + process.pid) }));
    check('test captures inside company/ are refused', hooksCompany.code !== 0 && /outside company/.test((hooksCompany.json || {}).error || ''), hooksCompany.json);
    const plain = spawnSync(process.execPath, ['-e', 'const m = require(process.argv[1]); console.log(JSON.stringify({ openViewer: typeof m.openViewer, aim: typeof m.aim, startFilter: typeof m.startFilter, TEST: m.TEST }))', TOOL], { encoding: 'utf8', env: baseEnv });
    let pj = null; try { pj = JSON.parse(plain.stdout); } catch (_) {}
    check('loaded without test hooks, the module hands out no viewer', pj && pj.openViewer === 'undefined' && pj.aim === 'undefined' && pj.startFilter === 'undefined' && pj.TEST === false, pj || plain.stderr.slice(0, 200));

    // 7. a capture killed hard: stale lock, leftover profile, then the next capture recovers
    const PROFILE_RE = /^station-view-[A-Za-z0-9]{6}$/;
    const before = new Set(fs.readdirSync(RUNTIME).filter(n => PROFILE_RE.test(n)));
    const victim = spawn(process.execPath, [TOOL, 'shot', '--out', 'e2e/killed.png'], { env: toolEnv, stdio: 'ignore' });
    let mine = null;
    for (let i = 0; i < 60 && !mine; i++) { await sleep(250); mine = fs.readdirSync(RUNTIME).find(n => PROFILE_RE.test(n) && !before.has(n)) || null; }
    await sleep(1500);
    try { victim.kill('SIGKILL'); } catch (_) {}
    await sleep(1500);
    const st3 = run(['status']).json || {};
    check('after a hard kill: status says the lock is stale (not busy) and counts the leftover profile', !!mine && !st3.busy && st3.staleLock && st3.leftoverProfiles >= 1, { mine, busy: st3.busy, staleLock: st3.staleLock, leftoverProfiles: st3.leftoverProfiles });
    const again = run(['shot', '--size', '720p', '--out', 'e2e/after-kill.png']);
    check('the next capture takes the lock back and succeeds', again.code === 0 && again.json && again.json.ok === true, (again.json && again.json.error) || again.raw.slice(0, 200));
    const st4 = run(['status']).json || {};
    check('... and clears the leftover profile', st4.leftoverProfiles === 0 && !st4.staleLock && !(mine && fs.existsSync(path.join(RUNTIME, mine))), { leftoverProfiles: st4.leftoverProfiles, staleLock: st4.staleLock });
  } catch (e) {
    check('test ran to the end', false, e.message);
  } finally {
    try { side && side.kill('SIGTERM'); } catch (_) {}
    await sleep(800); try { side && side.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  }
  // 8. retention, on a temp folder with the tool's own rule
  try {
    const SV = require(TOOL);
    const tmp = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'sv-ret-'));
    const day = path.join(tmp, '2026-01-01'); fs.mkdirSync(day);
    const now = Date.now();
    for (let i = 0; i < 210; i++) { const p = path.join(day, 'f' + String(i).padStart(3, '0') + '.png'); fs.writeFileSync(p, 'x'); const t = (now - (210 - i) * 60000) / 1000; fs.utimesSync(p, t, t); }
    const old = path.join(tmp, 'old.mp4'); fs.writeFileSync(old, 'x'); const ot = (now - 8 * 86400000) / 1000; fs.utimesSync(old, ot, ot);
    fs.writeFileSync(path.join(tmp, 'captures.jsonl'), '{}\n'); fs.writeFileSync(path.join(tmp, '.keep.png'), 'x');
    const r = SV.prune(tmp);
    const left = SV.listMedia(tmp).map(f => path.basename(f.p));
    check('retention: keeps 200 media files, drops the 8-day-old one and the oldest', r.kept === 200 && left.length === 200 && !fs.existsSync(old) && !left.includes('f000.png') && left.includes('f209.png'), { kept: r.kept, removed: r.removed });
    check('retention: never touches the capture log or dotfiles', fs.existsSync(path.join(tmp, 'captures.jsonl')) && fs.existsSync(path.join(tmp, '.keep.png')));
    const r2 = SV.prune(tmp, { bytes: 50 });
    check('retention: the byte ceiling applies too', r2.kept === 50, r2);
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) { check('retention test ran', false, e.message); }
  const failed = checks.filter(c => !c.ok);
  console.log(JSON.stringify(Object.assign({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length, checks }, report), null, 1));
  process.exit(failed.length ? 1 : 0);
})();
