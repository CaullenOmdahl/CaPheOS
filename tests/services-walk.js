#!/usr/bin/env node
/* services-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Settings › System ›
 * Background services (company/tools/service.js through GET/POST /api/services).
 *
 *   node tests/services-walk.js
 *
 * Checks: the section lists each service with its status, schedule, last run, who asked and why, in plain words (no
 * file paths, tool names or API routes outside Details; the command sits in Details); Stop changes the status; Remove
 * asks once more before it acts and the card goes; a proposed one links to Today; desktop and phone widths, no page
 * exception, no sideways scroll on a phone. Starts the mock on a free port (never 8800). Exits 0 with "SKIP" when no
 * Chrome is installed or Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP services walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP services walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }
const LEAK = /company\/|\.js\b|\/api\//;
const VISIBLE = `(() => { const host = document.getElementById('set-services'); if (!host) return null; const out = []; const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const el = n.parentElement; if (!el) continue; const d = el.closest('details'); if (d && !el.closest('summary')) continue;
    if (!el.getClientRects().length) continue; const t = n.textContent.trim(); if (t) out.push(t); } return out.join('\\n'); })()`;

(async () => {
  const port = await freePort(), cport = await freePort();
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_CERTIFIED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = life.tmpDir('services-walk-');
  const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', env: life.chromeEnv(udd) }));
  const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} setTimeout(() => process.exit(code), 200); };
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
    const card = n => `document.querySelector('#set-services [data-service="${n}"]')`;
    await send('Runtime.enable'); await send('Page.enable');
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt); errors.length = 0;
      await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/#/settings/system/services' });
      const ready = await until(() => js(`document.querySelectorAll('#set-services [data-service]').length === 3`), 10000);
      const text = await js(VISIBLE);
      const leaks = String(text || '').split('\n').filter(l => LEAK.test(l));
      check(label + ': Background services lists every service, no paths or tool names outside Details', ready && !leaks.length && !errors.length, { leaks, errors });
      const rec = await js(`(${card('depth-recorder')} || {}).innerText`);
      check(label + ': a service shows its status, schedule, last run, who asked and why in plain words', /Running/.test(rec) && /Runs all the time/.test(rec) && /Last ran/.test(rec) && /Asked by Hollis/.test(rec) && /order book/.test(rec), rec);
      const bank = await js(`(${card('bank-day')} || {}).innerText`);
      check(label + ': a timer shows its schedule and next run', /On schedule/.test(bank) && /Runs on the schedule/.test(bank) && /Next run/.test(bank), bank);
      check(label + ': the command is in Details, not on the card face', await js(`(() => { const d = ${card('depth-recorder')}.querySelector('details'); return !!d && /record_depth\\.py/.test(d.textContent) && !d.open; })()`));
      check(label + ': a proposed service says it waits for you and links to Today', await js(`(() => { const c = ${card('tape-check')}; return /Waiting for your answer/.test(c.innerText) && !!c.querySelector('a[href="#/today"]'); })()`));
      if (w < 600) check('phone: no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    }
    await width(1280, 900);
    await js(`[...${card('depth-recorder')}.querySelectorAll('button')].find(b => b.textContent === 'Stop').click(); 1`);
    check('Stop stops it and the card says so', await until(() => js(`/Stopped/.test(${card('depth-recorder')}.innerText) && [...${card('depth-recorder')}.querySelectorAll('button')].some(b => b.textContent === 'Start')`), 5000));
    await js(`[...${card('bank-day')}.querySelectorAll('button')].find(b => b.textContent === 'Remove…').click(); 1`);
    const ask = await until(() => js(`(() => { const c = ${card('bank-day')}; return /Remove bank-day for good\\?/.test(c.innerText) && [...c.querySelectorAll('button')].some(b => b.textContent === 'Yes, remove it') ? c.innerText : null; })()`), 3000);
    check('Remove asks once more before it acts', !!ask, ask);
    await js(`[...${card('bank-day')}.querySelectorAll('button')].find(b => b.textContent === 'Keep it').click(); 1`);
    check('Keep it puts the buttons back and removes nothing', await js(`!!${card('bank-day')} && [...${card('bank-day')}.querySelectorAll('button')].some(b => b.textContent === 'Remove…')`));
    await js(`[...${card('bank-day')}.querySelectorAll('button')].find(b => b.textContent === 'Remove…').click(); 1`);
    await sleep(100);
    await js(`[...${card('bank-day')}.querySelectorAll('button')].find(b => b.textContent === 'Yes, remove it').click(); 1`);
    check('Yes, remove it removes the service and its card', await until(() => js(`!${card('bank-day')} && document.querySelectorAll('#set-services [data-service]').length === 2`), 5000));
    check('no page exception during the walk', !errors.length, errors);
    console.log(fails ? 'SERVICES WALK: FAIL (' + fails + ')' : 'SERVICES WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('services walk crashed: ' + e.stack); done(1); }
})();
