#!/usr/bin/env node
/* viewer-mode.e2e.js — proof for StarNet patch 0008 (company/patches/0008-viewer-mode.diff): a /?viewer=1 page makes ZERO
 * writes, and the station does not count it as an open page.
 *
 * It boots a SCRATCH sidecar from the StarNet tree you name (never the live station: its own port, its own throwaway
 * workspace, its own random token, cron and night shift off), opens the page in a headless Chrome with a throwaway
 * profile, and watches every request the browser sends (CDP Network, page and workers). Then:
 *   viewer run  /?viewer=1 : the flag and all guards are on; the page's boot writes (save, roster push, briefing) and
 *                            forced writes (persist, roster, flush, an agent rename, a run, settings, cron, beacon, XHR,
 *                            localStorage, a station.command on the bus) are refused inside the page; the network sees
 *                            no method but GET/HEAD; the workspace files and the save revision are unchanged; the feed
 *                            carries viewer=1 and the sidecar says X-StarNet-Viewer: 1; a personality push answers
 *                            via:"roster" (no page counted); the bus command opened no window and sent no ack; the
 *                            page reports every refused kind (byPath, so a real save's hundreds of boot writes cannot
 *                            push the checked ones out); the camera frame's activity ticker, feed readouts and the
 *                            minimized-window chips are not drawn even off the glass theme; the badge names VT323.
 *   control run /           : the same page without the flag DOES send writes and IS counted (via:"page"), so the
 *                            measurement above can see writes when they happen.
 *
 *   node company/tools/tests/viewer-mode.e2e.js --starnet <StarNet tree with 0008 applied> [--port 8961]
 *        [--workspace-from <dir with agent.save.json + agent.roster.json>] [--keep]
 *
 * The tree is only read (the sidecar's data goes to the scratch dir). Without the patch the viewer checks fail, which is
 * the point. Exit 0 = every check passed; prints one JSON report. The test's Chrome keeps its home and XDG folders in the
 * scratch base. It never talks to the company's station: the port it boots on must differ from it.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
const co = require(path.join(__dirname, '..', 'lib', 'company'));
const TREE = path.resolve(opt('starnet') || co.p('starnet'));
// the company's own station port (co.STATION_URL): this test boots its own scratch station and must never share it
const LIVE_PORT = (() => { try { const u = new URL(co.STATION_URL); return Number(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch (_) { return NaN; } })();
const PORT = Number(opt('port') || 8961);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535 || PORT === LIVE_PORT) { console.error('refusing port ' + PORT + ': the scratch station needs its own port, never the company station\'s (' + LIVE_PORT + ')'); process.exit(2); }
const FROM = opt('workspace-from');
const KEEP = argv.includes('--keep');
const CHROME = process.env.STATION_VIEW_CHROME || '/usr/bin/google-chrome-stable';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = crypto.randomBytes(24).toString('hex');
// a short private base (Chrome's singleton socket path must stay under 108 bytes): --base, else $XDG_RUNTIME_DIR, else the OS temp dir
const BASE = require('../lib/temp-life').tmpDir('viewer-e2e-', { base: opt('base') || process.env.XDG_RUNTIME_DIR || os.tmpdir() });
const WS = path.join(BASE, 'workspace');
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : detail }); return !!ok; };

function materialize() {
  fs.mkdirSync(WS, { recursive: true });
  const src = FROM ? path.resolve(FROM) : path.join(TREE, 'dev', 'fixtures', 'seed-workspace');
  for (const f of ['agent.save.json', 'agent.roster.json', '_commander.dossier.json']) {
    const p = path.join(src, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(WS, f));
  }
  const now = Date.now();
  try { const p = path.join(WS, 'agent.save.json'); const w = JSON.parse(fs.readFileSync(p, 'utf8')); w.updatedAt = now; w.savedAt = now; if (w.doc) w.doc.updatedAt = now; fs.writeFileSync(p, JSON.stringify(w)); } catch (_) {}
}
function bootSidecar() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(STARNET|SKYNET)_/.test(k)) env[k] = v;   // nothing of the live station's config leaks in
  Object.assign(env, { SKYNET_DEV: '1', SKYNET_FULL_ACCESS: '1', SKYNET_WORKSPACES: WS, SKYNET_PORT: String(PORT), STARNET_API_TOKEN: TOKEN,
    SKYNET_DEFAULT_MODEL: 'anthropic/claude-sonnet-4.6', SKYNET_OPENROUTER_KEY: 'sk-or-viewer-e2e-placeholder',
    XDG_DATA_HOME: path.join(BASE, 'xdg-data'), XDG_CONFIG_HOME: path.join(BASE, 'xdg-config'), XDG_CACHE_HOME: path.join(BASE, 'xdg-cache') });
  const log = fs.openSync(path.join(BASE, 'sidecar.log'), 'w');
  return spawn(process.execPath, [path.join(TREE, 'sidecar', 'index.js')], { cwd: TREE, env, stdio: ['ignore', log, log] });
}
async function api(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + PORT + p, { method, headers: Object.assign({ 'x-starnet-token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, text: t.slice(0, 300) };
}
function hashTree(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) { try { out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (_) {} } } };
  walk(dir); return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort();

// ---- minimal CDP over a port (test only; station-view.js itself uses --remote-debugging-pipe) ----
async function launchChrome(tag) {
  const profile = path.join(BASE, 'profile-' + tag);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const proc = spawn(CHROME, ['--headless=new', '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--window-size=1600,900', '--hide-scrollbars', '--disable-crash-reporter', '--disable-breakpad', '--password-store=basic', 'about:blank'],
    // the test's Chrome keeps its home, config, data and cache inside the scratch base too (never the owner's ~/.config)
    { stdio: 'ignore', env: { PATH: process.env.PATH, HOME: path.join(BASE, 'home-' + tag), XDG_CONFIG_HOME: path.join(BASE, 'home-' + tag, '.config'), XDG_DATA_HOME: path.join(BASE, 'home-' + tag, '.local', 'share'),
      XDG_CACHE_HOME: path.join(BASE, 'home-' + tag, '.cache'), TMPDIR: BASE, LANG: process.env.LANG || 'C.UTF-8' } });
  let port = null;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch (_) {} }
  if (!port) throw new Error('chrome did not start');
  const ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws')); });
  let id = 0; const pend = new Map(); const handlers = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else handlers.forEach(h => h(m)); };
  const send = (method, params, sessionId) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify(Object.assign({ id: mid, method, params: params || {} }, sessionId ? { sessionId } : {}))); setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error('cdp timeout ' + method)); } }, 30000); });
  const requests = [];   // { method, url, type, session }
  const responses = [];  // { url, status, headers }
  handlers.push(m => {
    if (m.method === 'Network.requestWillBeSent') requests.push({ method: m.params.request.method, url: m.params.request.url, type: m.params.type, session: m.sessionId || '' });
    if (m.method === 'Network.responseReceived') responses.push({ url: m.params.response.url, status: m.params.response.status, headers: m.params.response.headers });
    if (m.method === 'Target.attachedToTarget') {   // workers too: their requests are counted the same way
      const sid = m.params.sessionId;
      send('Network.enable', {}, sid).catch(() => {});
      send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    }
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Network.enable'); await s('Page.enable'); await s('Runtime.enable'); await s('DOMStorage.enable');
  await s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await s('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expr) => { const r = await s('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const close = () => { try { ws.close(); } catch (_) {} try { proc.kill('SIGKILL'); } catch (_) {} };
  return { s, evaluate, requests, responses, close, profile };
}
const GAME = "(() => { const g = document.getElementById('screen-game'); return !!(g && g.classList.contains('active')); })()";
async function waitGame(c, ms) { for (let t = 0; t < ms; t += 500) { if (await c.evaluate(GAME).catch(() => false)) return true; await sleep(500); } return false; }
const writesOf = reqs => reqs.filter(r => !/^(GET|HEAD)$/i.test(r.method) && /^https?:/.test(r.url));
const pathOf = u => { try { return new URL(u).pathname; } catch (_) { return u; } };

// a personality push from a Node client: via "roster" = no StarNet page is counted as open; "page" = one is
async function personalityVia() {
  let row = null;
  try { row = (JSON.parse(fs.readFileSync(path.join(WS, 'agent.roster.json'), 'utf8')).agents || [])[0]; } catch (_) {}
  if (!row) return { error: 'no roster row' };
  const r = await api('POST', '/api/agent/personality', { agentId: row.agentId, personality: row.personaId || 'composed', system: row.system || '' }).catch(e => ({ error: e.message }));
  return { status: r.status, via: r.json && r.json.via, body: r.json ? undefined : r.text };
}

(async () => {
  let side = null, viewer = null, control = null;
  const report = { tree: TREE, port: PORT, workspace: FROM ? 'copy of ' + FROM : 'dev seed fixture' };
  try {
    materialize();
    side = bootSidecar();
    let up = false;
    for (let i = 0; i < 120 && !up; i++) { await sleep(500); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/version', { signal: AbortSignal.timeout(2000) })).status > 0; } catch (_) {} }
    if (!check('scratch sidecar is up', up)) throw new Error('sidecar did not start; see ' + path.join(BASE, 'sidecar.log'));
    // background: what the sidecar writes with no page at all (excluded from the viewer diff, and reported)
    const h0 = hashTree(WS); await sleep(8000); const h1 = hashTree(WS);
    const background = changed(h0, h1);
    report.backgroundWrites = background;
    const rev0 = ((await api('GET', '/api/save?agent=agent')).json || {}).head || null;
    const roster0 = h1['agent.roster.json'];

    // ---------------- the viewer run ----------------
    viewer = await launchChrome('viewer');
    await viewer.s('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?viewer=1' });
    const inGame = await waitGame(viewer, 60000);
    check('viewer page reached the station floor', inGame);
    const st = await viewer.evaluate("({ flag: window.__STARNET_VIEWER__ === true, desc: (() => { const d = Object.getOwnPropertyDescriptor(window, '__STARNET_VIEWER__'); return d ? { w: d.writable, c: d.configurable } : null; })(), guards: (window.__STARNET_VIEWER_STATE__ && window.__STARNET_VIEWER_STATE__.guards) || [], badge: !!document.getElementById('viewer-badge'), cls: document.body.classList.contains('sn-viewer') })");
    check('viewer flag is on and frozen', st.flag && st.desc && st.desc.w === false && st.desc.c === false, st.desc);
    const want = ['fetch', 'xhr', 'beacon', 'storage', 'channel', 'locks', 'feed', 'surfaces'];
    check('every guard is installed', want.every(g => st.guards.includes(g)), st.guards);
    check('badge and viewer class shown', st.badge && st.cls);
    const flip = await viewer.evaluate("(() => { try { window.__STARNET_VIEWER__ = false; } catch (_) {} try { Object.defineProperty(window, '__STARNET_VIEWER__', { value: false }); } catch (_) {} return window.__STARNET_VIEWER__; })()");
    check('the flag cannot be switched off from page code', flip === true);
    await sleep(6000);   // boot writes: roster push, briefing boot delivery, the first persist
    // forced writes, through the page's own code paths and raw primitives
    const forced = await viewer.evaluate(`(async () => {
      const out = {};
      const tryit = async (k, f) => { try { const v = await f(); out[k] = (v && typeof v.status === 'number') ? v.status : (v === undefined ? 'ran' : v); } catch (e) { out[k] = 'threw ' + String(e && e.message || e).slice(0, 80); } };
      await tryit('persist', () => App.persist());
      await tryit('pushRoster', () => App.pushRoster());
      await tryit('flush', () => (typeof CloudSave !== 'undefined' && CloudSave.flush) ? CloudSave.flush({ force: true }) : 'no CloudSave');
      await tryit('rename', () => (App.agentConfig && App.agentConfig.setName) ? App.agentConfig.setName(App.heroId(), 'VIEWERTEST') : 'no setter');
      await tryit('run', () => fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'agent', message: 'viewer test' }) }));
      await tryit('settings', () => fetch('/api/runtime/knobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
      await tryit('cronDelete', () => fetch('/api/cron/x', { method: 'DELETE' }));
      await tryit('put', () => fetch(new Request('/api/save', { method: 'PUT', body: '{}' })));
      await tryit('beacon', () => navigator.sendBeacon('/api/save', new Blob(['{}'])));
      await tryit('xhr', () => new Promise(res => { const x = new XMLHttpRequest(); x.open('POST', '/api/save'); x.onloadend = () => res('xhr ' + x.status); x.send('{}'); setTimeout(() => res('xhr held'), 1500); }));
      await tryit('storage', () => { localStorage.setItem('viewer-e2e', '1'); return localStorage.getItem('viewer-e2e'); });
      await tryit('channel', () => { const c = new BroadcastChannel('starnet-pages'); c.postMessage({ ping: 'viewer-e2e' }); return 'posted'; });
      await tryit('busCommand', () => { U.bus.emit('station.command', { id: 'viewer-e2e-1', verb: 'station.show', args: { place: 'settings' } }); return 'emitted'; });
      return out;
    })()`);
    report.forced = forced;
    await sleep(12000);  // debounced saves, retries, presence stamps, remote view, the bus command's (absent) ack
    const ref = await viewer.evaluate('window.__STARNET_VIEWER_STATE__ ? window.__STARNET_VIEWER_STATE__.refused() : { count: 0, last: [] }');
    // every kind ever refused (byPath), not only the newest 80: a real save's boot sends hundreds of transcript rows
    const kinds = Object.keys(ref.byPath || {});
    report.refusedInPage = { count: ref.count, kinds: kinds.length, overflow: ref.overflow || 0, byPath: Object.fromEntries(Object.entries(ref.byPath || {}).sort((a, b) => b[1] - a[1]).slice(0, 40)) };
    check('the page reports every refused kind, not only the newest (byPath)', kinds.length > 0 && !ref.overflow, { kinds: kinds.length, overflow: ref.overflow });
    const refusedPaths = kinds.concat(ref.last).join('\n');
    for (const p of ['/api/save', '/api/roster', '/api/run', '/api/runtime/knobs', '/api/cron/x'])
      check('page tried and was refused: ' + p, refusedPaths.includes(' ' + p), undefined);
    check('beacon refused in page', /beacon POST \/api\/save/.test(refusedPaths));
    check('xhr refused in page', /xhr POST \/api\/save/.test(refusedPaths));
    check('bus station.command sent no ack', !/\/api\/station\/ack/.test(refusedPaths));
    // the camera frame's activity ticker (who ran what, the cost, raw error text) is not drawn even off the glass theme
    const ticker = await viewer.evaluate(`(() => { document.body.classList.remove('glass-demo'); const hud = document.querySelector('#stage-wrap .cam-hud'); if (!hud) return 'no hud';
      const t = document.createElement('span'); t.className = 'cam-ticker cam-ticker--on'; t.textContent = 'ALEX RUN COMPLETE 14 TURNS $0.43'; hud.appendChild(t);
      const shown = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0;
      const out = { ticker: shown(t), feed: [...hud.querySelectorAll('.cam-feed, .cam-label, .cam-rec')].some(shown), termStrip: !!document.getElementById('term-strip') && shown(document.getElementById('term-strip')) };
      t.remove(); document.body.classList.add('glass-demo'); return out; })()`);
    check('activity ticker, feed/rec/label readouts and minimized-window chips are not drawn (glass theme off)', ticker && ticker.ticker === false && ticker.feed === false && ticker.termStrip === false, ticker);
    const badgeFont = await viewer.evaluate("(() => { const b = document.getElementById('viewer-badge'); return b ? getComputedStyle(b).fontFamily : null; })()");
    check('the badge names VT323 (font law)', /VT323/.test(String(badgeFont)), badgeFont);
    const termsOpen = await viewer.evaluate("(() => { const t = document.getElementById('terms'); return t ? t.children.length : -1; })()");
    check('bus station.command opened no window', termsOpen <= 0, termsOpen);
    const vw = writesOf(viewer.requests);
    report.viewerRequests = { total: viewer.requests.length, writes: vw.map(r => r.method + ' ' + pathOf(r.url)) };
    check('ZERO non-GET/HEAD requests left the viewer (page and workers)', vw.length === 0, report.viewerRequests.writes);
    const ls = await viewer.s('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'http://127.0.0.1:' + PORT, isLocalStorage: true } });
    const realKeys = (ls.entries || []).map(e => e[0]);
    check('real localStorage untouched by the viewer', realKeys.length === 0, realKeys.slice(0, 10));
    const feed = viewer.requests.filter(r => pathOf(r.url) === '/api/channels/events');
    check('live feed carries viewer=1', feed.length > 0 && feed.every(r => /[?&]viewer=1(&|$)/.test(r.url)), feed.length);
    const feedRes = viewer.responses.filter(r => pathOf(r.url) === '/api/channels/events');
    check('sidecar marked the feed X-StarNet-Viewer: 1', feedRes.length > 0 && feedRes.every(r => String(r.headers['X-StarNet-Viewer'] || r.headers['x-starnet-viewer'] || '') === '1'), feedRes.map(r => r.status));
    const h2 = hashTree(WS);
    const viewerChanged = changed(h1, h2).filter(f => !background.includes(f));
    report.viewerFileChanges = viewerChanged;
    check('no workspace file changed during the viewer run (beyond background)', viewerChanged.length === 0, viewerChanged);
    check('roster file unchanged', h2['agent.roster.json'] === roster0);
    const rev1 = ((await api('GET', '/api/save?agent=agent')).json || {}).head || null;
    check('save revision unchanged', JSON.stringify(rev0) === JSON.stringify(rev1), { before: rev0 && rev0.revision, after: rev1 && rev1.revision });
    const pv = await personalityVia();
    report.personalityWithViewerOpen = pv;
    check('with only the viewer open, the station counts no page (via:"roster")', pv.via === 'roster', pv);
    viewer.close(); viewer = null;

    // ---------------- the control run: the same page without the flag ----------------
    control = await launchChrome('control');
    await control.s('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    check('control page reached the floor', await waitGame(control, 60000));
    await sleep(6000);
    await control.evaluate("(async () => { try { await App.persist(); } catch (_) {} try { App.pushRoster(); } catch (_) {} try { if (CloudSave.flush) await CloudSave.flush({ force: true }); } catch (_) {} return 1; })()");
    await sleep(6000);
    const cw = writesOf(control.requests);
    report.controlWrites = [...new Set(cw.map(r => r.method + ' ' + pathOf(r.url)))];
    check('control page DOES send writes (the measurement sees them)', cw.length > 0, report.controlWrites.slice(0, 8));
    const pc = await personalityVia();
    report.personalityWithControlOpen = pc;
    check('control page IS counted as an open page (via:"page")', pc.via === 'page', pc);
  } catch (e) {
    check('test ran to the end', false, e.message);
  } finally {
    try { viewer && viewer.close(); } catch (_) {}
    try { control && control.close(); } catch (_) {}
    try { side && side.kill('SIGTERM'); } catch (_) {}
    await sleep(800);
    try { side && side.kill('SIGKILL'); } catch (_) {}
    if (!KEEP) try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {} else report.kept = BASE;
  }
  const failed = checks.filter(c => !c.ok);
  console.log(JSON.stringify(Object.assign({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length, checks }, report), null, 1));
  process.exit(failed.length ? 1 : 0);
})();
