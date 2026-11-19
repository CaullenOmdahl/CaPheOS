#!/usr/bin/env node
/* alarm-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js, MOCK_COMMAND_ASK=1):
 *   - Chat: a reply that tells the owner to run a command gets the notice "This asks you to run a command. You don't need
 *     a terminal for this: …" (console/command-ask.js), linking the matching console action or saying to tell the agent
 *     to use one; the reply itself is shown as written;
 *   - Settings › System › Test the outside alarm: period and grace pre-filled, the countdown, "I got the alert".
 *   node tests/alarm-walk.js       (never port 8800; exits 0 with SKIP without Chrome)
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP alarm walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP alarm walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

(async () => {
  const port = await freePort(), cport = await freePort();
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_CERTIFIED: '1', MOCK_COMMAND_ASK: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = life.tmpDir('alarm-walk-');
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
    await send('Runtime.enable'); await send('Page.enable');
    // 1. the chat lint: a notice under the reply, the reply itself untouched
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt); errors.length = 0;
      await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/#/chat/agent:agent' });
      const n = await until(() => js(`document.querySelectorAll('.command-ask').length`), 10000);
      check(label + ': the two command replies each get a notice', n === 2, n);
      const first = await js(`(() => { const c = document.querySelectorAll('.command-ask')[0]; const a = c && c.querySelector('a'); return c ? { text: c.innerText, href: a && a.getAttribute('href'), msg: c.closest('.msg-them-wrap').querySelector('.msg-them').innerText } : null; })()`);
      check(label + ': the notice says no terminal is needed and links Test the outside alarm', first && /This asks you to run a command/.test(first.text) && /don't need a terminal/.test(first.text) && first.href === '#/settings/system/alarm', first);
      check(label + ': the reply text is shown as written (a notice, never a rewrite)', first && /systemctl --user stop trial-co-station-liveness\.timer/.test(first.msg), first);
      const second = await js(`(() => { const c = document.querySelectorAll('.command-ask')[1]; return c ? { text: c.innerText, link: !!c.querySelector('a'), btn: [...c.querySelectorAll('button')].map(b => b.textContent) } : null; })()`);
      check(label + ': with no matching console action, it says to tell the agent to use one', second && /use a console action/.test(second.text) && !second.link && second.btn.includes('Ask for a console action'), second);
      check(label + ': the plain reply gets no notice', await js(`[...document.querySelectorAll('.msg-them-wrap')].filter(x => /one handoff/.test(x.innerText) && x.querySelector('.command-ask')).length === 0`));
      if (w < 600) check('phone: chat has no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
      check(label + ': no page exception on chat', !errors.length, errors);
    }
    // 2. Settings › System › Test the outside alarm
    await width(1280, 900); errors.length = 0;
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/#/settings/system/alarm' });
    const idle = await until(() => js(`(() => { const p = document.getElementById('alarm-period'), g = document.getElementById('alarm-grace'); return p && g ? { p: p.value, g: g.value } : null; })()`), 10000);
    check('alarm: the period and grace are pre-filled from the saved values', idle && idle.p === '5' && idle.g === '2', idle);
    await js(`document.getElementById('alarm-period').value = '10'; document.getElementById('alarm-grace').value = '5'; [...document.querySelectorAll('#set-alarm button')].find(b => /Pause the pings/.test(b.textContent)).click(); 1`);
    const run = await until(() => js(`(() => { const c = document.getElementById('alarm-countdown'); return c && /should reach you in [0-9]+:[0-9][0-9]/.test(c.innerText) ? document.getElementById('alarm-running').innerText : null; })()`), 5000);
    const dbg = await js(`(document.getElementById('set-alarm')||{}).innerText`);
    check('alarm: started, it counts down to the alert and offers "I got the alert"', !!run && /I got the alert/.test(run) && /Pings paused/i.test(run) && /start again on their own/.test(run), dbg);
    await js(`[...document.querySelectorAll('#set-alarm button')].find(b => b.textContent === 'I got the alert').click(); 1`);
    const last = await until(() => js(`(() => { const l = document.getElementById('alarm-last'); return l ? l.innerText : null; })()`), 5000);
    check('alarm: "I got the alert" ends it and the last test says the alert reached you', /the alert reached you/.test(last || ''), last);
    check('alarm: the values used are offered again', await js(`document.getElementById('alarm-period').value === '10'`));
    await width(390, 844);
    check('phone: Settings › System has no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    check('no page exception on Settings › System', !errors.length, errors);
    console.log(fails ? 'ALARM WALK: FAIL (' + fails + ')' : 'ALARM WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('alarm walk crashed: ' + e.stack); done(1); }
})();
