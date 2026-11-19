#!/usr/bin/env node
/* service-keys-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Settings › Connections
 * and keys › Service keys (console/service-keys.js through GET/POST /api/service-keys) and Today's "Already saved".
 *
 *   node tests/service-keys-walk.js
 *
 * Checks, at desktop and phone widths: every key row shows a friendly name, Set / Not set, the change date and who reads
 * it, with no file path, tool name or API route outside Details (the secrets/ path sits in Details); an address is
 * labelled an address; no sideways scroll on a phone. Then: Replace saves through a masked field, Add a key picks Pyth
 * (where to get it and the link) and saves it, Other takes a typed name, a framework name is refused, no typed value is
 * ever in the page afterwards, and a Today request for a key that is now saved says "Already saved — replace?" and
 * points at Settings. Starts the mock on a free port (never 8800). Exits 0 with "SKIP" when no Chrome is installed or
 * Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP service keys walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP service keys walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }
const LEAK = /company\/|modules\/|secrets\/|\.(js|py|sh)\b|\/api\/|mode 0600/;
const VISIBLE = `(() => { const host = document.getElementById('set-service-keys'); if (!host) return null; const out = []; const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) { const el = n.parentElement; if (!el) continue; const d = el.closest('details'); if (d && !el.closest('summary')) continue;
    if (!el.getClientRects().length) continue; const t = n.textContent.trim(); if (t) out.push(t); } return out.join('\\n'); })()`;

(async () => {
  const port = await freePort(), cport = await freePort();
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_CERTIFIED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = life.tmpDir('service-keys-walk-');
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
    const row = n => `document.querySelector('#set-service-keys [data-skey="${n}"]')`;
    const btn = (scope, text) => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const goto = async hash => { await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' + hash }); };
    await send('Runtime.enable'); await send('Page.enable');
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt); errors.length = 0;
      await goto('#/settings/connections/service-keys');
      const ready = await until(() => js(`document.querySelectorAll('#set-service-keys [data-skey]').length === 4`), 10000);
      const text = await js(VISIBLE);
      const leaks = String(text || '').split('\n').filter(l => LEAK.test(l));
      check(label + ': Service keys lists every key, no file paths or tool names outside Details', ready && !leaks.length && !errors.length, { leaks, errors, text: String(text).slice(0, 300) });
      const kal = await js(`(${row('kalshi-api-key')} || {}).innerText`);
      check(label + ': a saved key shows its friendly name, Set, when it changed, who reads it and Replace', /Kalshi API key/.test(kal) && /\bSet\b/.test(kal) && /Saved .*\d\d:\d\d/.test(kal) && /Used by the markets work/.test(kal) && /Replace/.test(kal) && !/kalshi-api-key/.test(kal), kal);
      const py = await js(`(${row('pyth-api-key')} || {}).innerText`);
      check(label + ': a key a tool reads but nobody saved says Not set, where to get it, who needs it', /^Pyth/.test(py) && /Not set/.test(py) && /API keys/.test(py) && /Used by the research work/.test(py) && await js(`!!${row('pyth-api-key')}.querySelector('a[href="https://app.pyth.com"]')`), py);
      const hb = await js(`(${row('liveness-heartbeat-url')} || {}).innerText`);
      check(label + ': the healthchecks.io heartbeat is labelled an address, not a key', /Heartbeat address \(healthchecks\.io\)/.test(hb) && !/\bkey\b/i.test(hb) && /liveness module/.test(hb), hb);
      check(label + ': the file name sits in Details', await js(`(() => { const d = ${row('kalshi-api-key')}.querySelector('details'); return !!d && d.textContent.includes("secrets/kalshi-api-key") && !d.open; })()`));
      if (w < 600) check('phone: no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    }
    await width(1280, 900);
    // Replace a saved key through its masked field
    const V1 = 'walk-replaced-kalshi-value-000111', V2 = 'walk-pyth-value-222333', V3 = 'walk-exchange-value-444555';
    await js(`${btn(row('kalshi-api-key'), 'Replace')}.click(); 1`);
    const masked = await js(`(() => { const i = ${row('kalshi-api-key')}.querySelector('input.secret-input'); return i && !i.closest('[hidden]') ? i.type : null; })()`);
    check('Replace opens a masked field', masked === 'password', masked);
    await js(`${row('kalshi-api-key')}.querySelector('input.secret-input').value = ${JSON.stringify(V1)}; ${btn(row('kalshi-api-key'), 'Save new key')}.click(); 1`);
    const acts = async () => (await getJson('http://127.0.0.1:' + port + '/api/__mock/actions')).serviceKeys || [];
    check('Replace saves it as a replacement', await until(async () => (await acts()).some(a => a.name === 'kalshi-api-key' && a.replaced), 5000), await acts());
    // Add a key: Pyth from the list
    await until(() => js(`!!${btn("document.getElementById('set-service-keys')", 'Add a key')}`), 5000);
    await js(`${btn("document.getElementById('set-service-keys')", 'Add a key')}.click(); 1`);
    const addBox = `document.querySelector('#set-service-keys [data-skey-add]')`;
    const opts = await js(`[...${addBox}.querySelectorAll('select option')].map(o => o.textContent)`);
    check('Add a key offers Pyth, Kalshi, Synpath, healthchecks.io, GitHub and Other', ['Pyth', 'Kalshi API key', 'Kalshi private key', 'Synpath', 'Heartbeat address (healthchecks.io)', 'GitHub token'].every(x => (opts || []).includes(x)) && (opts || []).some(x => /^Other/.test(x)), opts);
    await js(`(() => { const s = ${addBox}.querySelector('select'); s.value = 'pyth'; s.dispatchEvent(new Event('change')); })(); 1`);
    const addTxt = await js(`${addBox}.innerText`);
    check('picking Pyth says where to get it, with the link, and a masked field', /API keys/.test(addTxt) && await js(`(() => { const a = ${addBox}.querySelector('a[href="https://app.pyth.com"]'); return !!a && !a.hidden; })()`) && await js(`${addBox}.querySelector('input.secret-input').type === 'password'`), addTxt);
    await js(`${addBox}.querySelector('input.secret-input').value = ${JSON.stringify(V2)}; ${btn(addBox, 'Save key')}.click(); 1`);
    check('Add saves Pyth and its row now says Set', await until(() => js(`!!${row('pyth-api-key')} && /\\bSet\\b/.test(${row('pyth-api-key')}.innerText) && !/Not set/.test(${row('pyth-api-key')}.innerText)`), 5000), await js(`(${row('pyth-api-key')} || {}).innerText`));
    // Other: a typed name; a framework name refused
    const addOther = async (name, value) => {
      await js(`${btn("document.getElementById('set-service-keys')", 'Add a key')}.click(); 1`);
      await js(`(() => { const b = ${addBox}; const s = b.querySelector('select'); s.value = 'other'; s.dispatchEvent(new Event('change')); const n = b.querySelector('input.mono'); n.value = ${JSON.stringify(name)}; n.dispatchEvent(new Event('input')); b.querySelector('.secret-input').value = ${JSON.stringify(value)}; })(); 1`);
      await js(`${btn(addBox, 'Save key')}.click(); 1`);
    };
    await addOther('station-token', 'walk-should-be-refused-1234');
    const refused = await until(() => js(`(() => { const e = ${addBox}.querySelector('.err-line'); return e && /framework/.test(e.textContent) ? e.textContent : null; })()`), 5000);
    const errNow = await js(`(.querySelector('.err-line') || {}).textContent`);
    check('a framework name (station-token) is refused with a plain reason', !!refused && !(await acts()).some(a => a.name === 'station-token'), errNow);
    await js(`${btn(addBox, 'Cancel')}.click(); 1`);
    await addOther('example-exchange-key', V3);
    check('Other saves a key under the typed name', await until(async () => (await acts()).some(a => a.name === 'example-exchange-key'), 5000), await acts());
    check('no typed value is anywhere in the page', await js(`![${JSON.stringify(V1)}, ${JSON.stringify(V2)}, ${JSON.stringify(V3)}, 'walk-should-be-refused'].some(v => document.documentElement.outerHTML.includes(v) || [...document.querySelectorAll('input,textarea')].some(i => i.value.includes(v)))`));
    // Today: the crew's request for a key that is now saved
    await goto('#/today');
    const sav = `document.querySelector('[data-saved="example-exchange-key"]')`;
    const sl = await until(() => js(`(() => { const s = ${sav}; return s && !s.hidden ? s.innerText : null; })()`), 10000);
    const fieldBox = `${sav}.closest('.q-secret')`;
    check('Today: a request for a key that is already saved says "Already saved — replace?" with the field closed', !!sl && /Already saved — replace\?/.test(sl) && await js(`[...${fieldBox}.querySelectorAll('.secret-input')].every(i => !i.offsetParent)`), sl);
    check('Today: the field says keys can be added or replaced any time in Settings › Connections and keys', await js(`(() => { const a = ${fieldBox}.querySelector('.q-anytime'); return !!a && /You can also add or replace keys any time in Settings › Connections and keys/.test(a.innerText) && !!a.querySelector('a[href="#/settings/connections/service-keys"]'); })()`));
    await js(`${btn(sav, 'Replace')}.click(); 1`);
    check('Today: Replace opens the masked field with "Replace the saved key" ticked', await js(`(() => { const b = ${fieldBox}; const i = b.querySelector('input.secret-input'); const c = b.querySelector('input[type=checkbox]'); return !!i && !!i.offsetParent && i.type === 'password' && !!c && c.checked && ${sav}.hidden; })()`));
    check('no page exception during the walk', !errors.length, errors);
    console.log(fails ? 'SERVICE KEYS WALK: FAIL (' + fails + ')' : 'SERVICE KEYS WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('service keys walk crashed: ' + e.stack); done(1); }
})();
