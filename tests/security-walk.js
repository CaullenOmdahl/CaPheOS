#!/usr/bin/env node
/* security-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Settings › Security, the
 * security watch (company/tools/security-watch.js view over its offline fixture company, through GET/POST /api/security).
 *
 *   node tests/security-walk.js
 *
 * Checks: the section says in plain words whether a part has a known hole and who is fixing it; each hole is a card with
 * the part in everyday words, its state and who is on it; package names, advisory ids, versions and paths appear only
 * inside "Technical details"; Check now asks once and then says it was requested; desktop and phone widths, no page
 * exception, no sideways scroll on a phone. Starts the mock on a free port (never 8800). Exits 0 with "SKIP" when no
 * Chrome is installed or Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP security walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP security walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }
const LEAK = /company\/|\.js\b|\/api\/|GHSA-|CVE-|\bsharp\b|\bnpm\b|\d+\.\d+\.\d+|node_modules/;
const VISIBLE = `(() => { const host = document.getElementById('settings-security'); if (!host) return null; const out = []; const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const el = n.parentElement; if (!el) continue; const d = el.closest('details'); if (d && !el.closest('summary')) continue;
    if (!el.getClientRects().length) continue; const t = n.textContent.trim(); if (t) out.push(t); } return out.join('\\n'); })()`;

(async () => {
  const port = await freePort(), cport = await freePort();
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_CERTIFIED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = life.tmpDir('security-walk-');
  const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', detached: true, env: life.chromeEnv(udd) }));
  // Chrome keeps writing its profile for a moment after the kill: remove the folder only once it has exited
  const exited = p => new Promise(r => { if (p.exitCode !== null || p.signalCode) return r(); p.once('exit', r); setTimeout(r, 5000); });
  const done = async code => {
    try { process.kill(-chrome.pid, 'SIGTERM'); } catch (_) { try { chrome.kill(); } catch (_) {} }   // the whole group: its helpers write the profile too
    try { mock.kill(); } catch (_) {}
    await Promise.all([exited(chrome), exited(mock)]);
    for (let i = 0; i < 10 && fs.existsSync(udd); i++) { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (_) {} await sleep(300); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} }
    life.cleanup();
    process.exit(code);
  };
  try {
    if (!await until(async () => /mock console on/.test(out), 15000)) throw new Error('the mock did not start: ' + out.slice(-400));
    const page = await until(async () => { try { return (await getJson('http://127.0.0.1:' + cport + '/json')).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (_) { return null; } }, 20000);
    if (!page) throw new Error('Chrome showed no page target in 20 s');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]); };
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const width = (w, hgt) => send('Emulation.setDeviceMetricsOverride', { width: w, height: hgt, deviceScaleFactor: 1, mobile: w < 600 });
    await send('Runtime.enable'); await send('Page.enable');
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt); errors.length = 0;
      await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/#/settings/security' });
      const ready = await until(() => js(`document.querySelectorAll('#set-holes article').length >= 2`), 15000);
      const text = await js(VISIBLE);
      const leaks = String(text || '').split('\n').filter(l => LEAK.test(l));
      check(label + ': Settings › Security draws its cards, no package names, ids, versions or paths outside Technical details', ready && !leaks.length && !errors.length, { leaks, errors, text: String(text).slice(0, 300) });
      const head = await js(`(document.querySelector('#set-watch') || {}).innerText`);
      check(label + ': the headline says how many holes and who is handling them, with what it means', /known security holes? in parts? we use (is|are) being handled by Riley/.test(head) && /could let a stranger in/.test(head) && /Last checked/.test(head), head);
      const stationCard = `[...document.querySelectorAll('#set-holes article')].find(a => /The program the crew works in/.test(a.innerText))`;
      const first = await js(`(${stationCard} || {}).innerText`);
      check(label + ': the station card names the part in everyday words and who is fixing it', /The program the crew works in/.test(first) && /Riley is fixing it now/.test(first) && /Fixing now/.test(first), first);
      check(label + ': the advisory and the fixed version sit in Technical details, closed', await js(`(() => { const d = (${stationCard} || document).querySelector('details'); return !!d && !d.open && /GHSA-wq5f-xc86-pv6w/.test(d.textContent) && /0\.35\.5/.test(d.textContent) && /VipsForeignLoadSvg/.test(d.textContent); })()`));
      if (w < 600) check('phone: no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    }
    await width(1280, 900);
    await js(`[...document.querySelectorAll('#set-watch button')].find(b => b.textContent === 'Check now').click(); 1`);
    check('Check now asks for a check and then says it was requested', await until(() => js(`[...document.querySelectorAll('#set-watch button')].some(b => b.textContent === 'Check requested' && b.disabled)`), 5000));
    check('no page exception during the walk', !errors.length, errors);
    console.log(fails ? 'SECURITY WALK: FAIL (' + fails + ')' : 'SECURITY WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('security walk crashed: ' + e.stack); done(1); }
})();
