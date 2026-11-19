#!/usr/bin/env node
/* memory-walk.js — the station browser really closes when idle (StarNet patch 0020, STARNET_BROWSER_IDLE_MIN).
 *
 *   node tests/memory-walk.js [--starnet <checkout>]
 *
 * Boots a SCRATCH station from a temporary copy of the StarNet checkout with patch 0020 applied (never the checkout
 * itself, never a live station: an ephemeral port, its own workspace, token, HOME and XDG dirs, no STARNET_ or SKYNET_
 * setting of the caller), headless, with STARNET_BROWSER_IDLE_MIN=1 and STARNET_BROWSER_OWN_GROUP=1. It starts the
 * station browser through the API (POST /api/browser/view/warm), checks a Chrome runs on the station profile, waits
 * out the idle minute in real time (about 70 s: this walk is slow and optional), and checks the browser closed and
 * no process names the profile. Then it stops the station (SIGTERM) and checks nothing of it is left.
 * SKIP (exit 0) without a StarNet checkout or without Chrome. Every dir and process goes through temp-life.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const SC = require(path.join(REPO, 'company', 'patches', 'tests', 'starnet-copy.js'));
const RECORD = path.join(REPO, 'company', 'patches', '0020-memory-lifecycle.diff');
const LIVE = new Set([8800, 8810, 8900, 8910]);
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const naming = needle => {
  const out = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try { if (fs.readFileSync('/proc/' + e + '/cmdline', 'utf8').includes(needle)) out.push(Number(e)); } catch (_) {}
  }
  return out;
};
async function waitFor(fn, ms, step) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step || 250); } return fn(); }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer(); s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function chromeBin() {
  for (const c of [process.env.STARNET_CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return null;
}

(async () => {
  if (process.platform !== 'linux') { console.log('SKIP memory-walk: Linux only'); return 0; }
  const src = SC.findSource(opt('starnet'));
  if (!src) { console.log('SKIP memory-walk: no StarNet checkout (set CAPHEOS_STARNET_SRC or run inside a company that has ./starnet)'); return 0; }
  const chrome = chromeBin();
  if (!chrome) { console.log('SKIP memory-walk: no Chrome or Chromium installed'); return 0; }
  life.setGrace(2000);
  const { dir: SN, applied } = SC.prepare(src, RECORD, 'capheos-memwalk-sn-');
  const BASE = life.tmpDir('memwalk-');   // short: Chrome's singleton socket path must stay under 108 bytes
  const WS = path.join(BASE, 'ws'); fs.mkdirSync(WS, { recursive: true });
  let port = await freePort(); while (LIVE.has(port)) port = await freePort();
  const TOKEN = crypto.randomBytes(24).toString('hex');
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(STARNET|SKYNET)_/.test(k)) env[k] = v;
  Object.assign(env, { HOME: path.join(BASE, 'home'), XDG_DATA_HOME: path.join(BASE, 'xdg-data'), XDG_CONFIG_HOME: path.join(BASE, 'xdg-config'), XDG_CACHE_HOME: path.join(BASE, 'xdg-cache'),
    TMPDIR: path.join(BASE, 'tmp'), DISPLAY: '', WAYLAND_DISPLAY: '',
    SKYNET_DEV: '1', SKYNET_WORKSPACES: WS, SKYNET_PORT: String(port), STARNET_API_TOKEN: TOKEN, STARNET_HEADLESS: '1', STARNET_CHROME: chrome,
    STARNET_BROWSER_HEADLESS: '1', STARNET_BROWSER_DOWNLOAD: '0', STARNET_BROWSER_IDLE_MIN: '1', STARNET_BROWSER_OWN_GROUP: '1', STARNET_BROWSER_LOWMEM: '1' });
  for (const d of ['home', 'xdg-data', 'xdg-config', 'xdg-cache', 'tmp']) fs.mkdirSync(path.join(BASE, d), { recursive: true });
  const logFile = path.join(BASE, 'sidecar.log');
  const log = fs.openSync(logFile, 'w');
  const sidecar = life.track(cp.spawn(process.execPath, [path.join(SN, 'sidecar', 'index.js')], { cwd: SN, env, stdio: ['ignore', log, log], detached: true }), { group: true });
  const api = async (method, p, body) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: Object.assign({ 'x-starnet-token': TOKEN }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); try { return JSON.parse(t); } catch (_) { return { status: r.status, text: t.slice(0, 200) }; }
  };
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok }); console.log((ok ? '  ok    ' : '  FAIL  ') + name + (ok || detail === undefined ? '' : ' — ' + JSON.stringify(detail))); return !!ok; };
  try {
    console.log('memory-walk: scratch station on 127.0.0.1:' + port + ' from a copy of ' + src + ' (0020 ' + applied + ')');
    const up = await waitFor(async () => { try { const v = await api('GET', '/api/browser/view'); return v && v.station ? v : null; } catch (_) { return null; } }, 60000, 500);
    if (!check('the scratch station answers GET /api/browser/view', up, fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n'))) return 1;
    const warm = await api('POST', '/api/browser/view/warm', {});
    check('POST /api/browser/view/warm starts the station browser', warm && warm.ok !== false, warm);
    const profileNeedle = WS;   // the station profile (durable or temporary) lives under the scratch workspace or its TMPDIR
    const running = await waitFor(() => naming(profileNeedle).concat(naming(path.join(BASE, 'tmp'))).filter(p => { try { return /chrome|chromium/i.test(fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').split('\0')[0]); } catch (_) { return false; } }).length > 0, 30000);
    check('a Chrome runs for the station browser', running);
    const opened = await waitFor(async () => { const v = await api('GET', '/api/browser/view'); return v.station && v.station.open; }, 20000);
    check('the station says its browser is open', opened);
    const t0 = Date.now();
    const closed = await waitFor(async () => { const v = await api('GET', '/api/browser/view'); return v.station && !v.station.open; }, 100000, 2000);
    check('it closed by itself after the idle minute (' + Math.round((Date.now() - t0) / 1000) + ' s)', closed);
    const gone = await waitFor(() => naming(profileNeedle).concat(naming(path.join(BASE, 'tmp'))).filter(p => p !== sidecar.pid).length === 0, 10000);
    check('no process names the station profile any more', gone, naming(profileNeedle));
  } finally {
    try { process.kill(-sidecar.pid, 'SIGTERM'); } catch (_) {}
    await waitFor(() => sidecar.exitCode !== null || sidecar.signalCode !== null, 8000);
    const left = await waitFor(() => naming(BASE).length === 0, 5000);
    check('the stopped station left nothing running', left, naming(BASE));
  }
  const bad = checks.filter(c => !c.ok).length;
  console.log('memory-walk: ' + (checks.length - bad) + '/' + checks.length + ' checks passed');
  return bad ? 1 : 0;
})().then(code => { life.cleanup(); process.exit(code); }, e => { console.error(e && e.stack || e); life.cleanup(); process.exit(1); });
