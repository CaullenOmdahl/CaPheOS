#!/usr/bin/env node
/* minimax-endpoint-walk.js — headless Chrome walk of the MiniMax endpoint picker (console/ui/js/minimax-endpoint.js)
 * against the dev mock (console/ui/dev/mock-api.js, MOCK_MINIMAX=1), never a real station or MiniMax:
 *  - Setup › AI provider: "Where is your MiniMax account?" with Global / Mainland China / Custom, one line each, no raw
 *    URL in the main text (the address only under Details, or in the field once Custom is picked); "Get a key" follows
 *    the region; Find my endpoint selects the region the key works on, or says why none did; a plain http Custom URL is
 *    refused; Connect saves the region (the mock records the base URL it was sent);
 *  - Settings › Connections and keys: the key row shows the current endpoint; switching re-checks the key on file
 *    first (refused here, so nothing changes), then a pasted key switches it;
 *  - Today: a question asking for the MiniMax key has the picker, and storing the key sends the picked region;
 *  - the Setup card has no sideways scroll at phone width.
 *   node tests/minimax-endpoint-walk.js [--shots <dir>]      exit 0 = pass; SKIP (exit 0) without Chrome
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const argv = process.argv.slice(2);
const SHOTS = (i => i >= 0 ? argv[i + 1] : null)(argv.indexOf('--shots'));
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP minimax endpoint walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP minimax endpoint walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800 && p !== 8910) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

(async () => {
  const port = await freePort(); const cport = await freePort();
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_MINIMAX: '1', MOCK_PLAIN: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = life.tmpDir('mm-walk-');
  const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', env: life.chromeEnv(udd) }));
  const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} setTimeout(() => process.exit(code), 200); };
  try {
    if (!await until(async () => /mock console on/.test(out), 15000)) throw new Error('the mock did not start: ' + out.slice(-400));
    const mmLog = () => getJson('http://127.0.0.1:' + port + '/api/__mock/minimax');
    const page = await until(async () => { try { return (await getJson('http://127.0.0.1:' + cport + '/json')).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (_) { return null; } }, 20000);
    if (!page) throw new Error('Chrome showed no page target in 20 s');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]); };
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable');
    const CARD = `document.querySelector('[data-provider="custom"]')`;
    const PICK = `${CARD}.querySelector('.mm-endpoint')`;
    const radio = v => `${PICK}.querySelector('input[type=radio][value="${v}"]')`;
    const btn = (scope, re) => `[...${scope}.querySelectorAll('button')].find(b => ${re}.test(b.textContent))`;
    // the visible text of an element, leaving out <details> bodies and input values
    const visible = sel => js(`(() => { const el = ${sel}; if (!el) return null; const c = el.cloneNode(true); c.querySelectorAll('details').forEach(d => d.remove()); c.querySelectorAll('[hidden]').forEach(d => d.remove()); return c.textContent; })()`);

    /* ---- Setup › AI provider ---- */
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/#/setup/provider' });
    const pick0 = await until(() => js(`(() => { const p = ${CARD} && ${PICK}; return p ? { legend: p.querySelector('legend').textContent, labels: [...p.querySelectorAll('label.check .strong')].map(x => x.textContent), checked: p.querySelector('input[type=radio]:checked').value } : null; })()`), 10000);
    check('Setup: the MiniMax card asks "Where is your MiniMax account?" with Global / Mainland China / Custom, Global picked', pick0 && pick0.legend === 'Where is your MiniMax account?' && pick0.labels.join('/') === 'Global/Mainland China/Custom' && pick0.checked === 'global', pick0);
    const lines = await js(`[...${PICK}.querySelectorAll('label.check .caption')].map(x => x.textContent)`);
    check('each option has a one-line explanation', Array.isArray(lines) && lines.length === 3 && lines.every(l => l.length > 10 && l.length < 120), lines);
    const txt0 = await visible(PICK);
    check('no raw URL in the picker\'s main text', txt0 && !/https?:\/\//.test(txt0), txt0);
    check('the address is under Details', /api\.minimax\.io\/v1/.test(await js(`${PICK}.querySelector('details').textContent`) || ''));
    const keyHref = () => js(`[...${CARD}.querySelectorAll('a')].find(a => /Get a key/.test(a.textContent)).href`);
    check('Get a key points at platform.minimax.io for Global', /^https:\/\/platform\.minimax\.io\//.test(await keyHref()), await keyHref());
    await js(`${radio('cn')}.click(); 1`);
    check('picking Mainland China: Get a key moves to platform.minimaxi.com and Details shows its address', /^https:\/\/platform\.minimaxi\.com\//.test(await keyHref()) && /api\.minimaxi\.com\/v1/.test(await js(`${PICK}.querySelector('details').textContent`) || ''), await keyHref());
    await js(`${radio('custom')}.click(); 1`);
    const cust = await js(`(() => { const u = ${PICK}.querySelector('input[type=url]'); return { shown: !!u && u.offsetParent !== null, details: !!${PICK}.querySelector('details') }; })()`);
    check('picking Custom shows the base URL field (and no Details line)', cust.shown && !cust.details, cust);
    await shot('setup-custom');
    // a plain-http custom address is refused with a reason, nothing saved
    await js(`(() => { const u = ${PICK}.querySelector('input[type=url]'); u.value = 'http://api.minimax.io/v1'; u.dispatchEvent(new Event('input')); const k = ${CARD}.querySelector('input[type=password]'); k.value = 'sk-good-1'; k.dispatchEvent(new Event('input')); ${btn(CARD, '/^Connect$/')}.click(); return 1; })()`);
    const httpErr = await until(() => js(`(() => { const e = [...${CARD}.querySelectorAll('.err-line')].map(x => x.textContent).join(' '); return /https/.test(e) ? e : null; })()`), 4000);
    check('Custom: an http:// address is refused, in plain words', !!httpErr && !(await mmLog()).stored, httpErr);
    // Find my endpoint: a Mainland China key selects Mainland China and says so
    await js(`(() => { ${radio('global')}.click(); const k = ${CARD}.querySelector('input[type=password]'); k.value = 'sk-good-cn-1'; k.dispatchEvent(new Event('input')); ${btn(PICK, '/Find my endpoint/')}.click(); return 1; })()`);
    const found = await until(() => js(`(() => { const s = ${PICK}.querySelector('[role=status]').textContent; return /works on/.test(s) ? { s, checked: ${PICK}.querySelector('input[type=radio]:checked').value } : null; })()`), 5000);
    check('Find my endpoint: picks Mainland China and says which one worked', found && found.checked === 'cn' && /works on Mainland China/.test(found.s), found);
    const log1 = await mmLog();
    check('Find my endpoint goes through the console server (tried Global, then Mainland China)', log1.log.filter(x => x.path === 'detect').map(x => x.region).join(',') === 'global,cn', log1);
    await js(`(() => { const k = ${CARD}.querySelector('input[type=password]'); k.value = 'sk-bad'; ${btn(PICK, '/Find my endpoint/')}.click(); return 1; })()`);
    const none = await until(() => js(`(() => { const s = ${PICK}.querySelector('[role=status]').textContent; return /Neither/.test(s) ? s : null; })()`), 5000);
    check('Find my endpoint: a key no region accepts says so (bad key, not network)', /accepted/.test(none || '') && !/internet/.test(none || ''), none);
    await js(`(() => { const k = ${CARD}.querySelector('input[type=password]'); k.value = 'sk-net'; ${btn(PICK, '/Find my endpoint/')}.click(); return 1; })()`);
    const netw = await until(() => js(`(() => { const s = ${PICK}.querySelector('[role=status]').textContent; return /reached/.test(s) ? s : null; })()`), 5000);
    check('Find my endpoint: nothing reachable is called a network problem', /internet connection/.test(netw || ''), netw);
    // Connect on Mainland China: saved, the station was sent its base URL
    await js(`(() => { ${radio('cn')}.click(); const k = ${CARD}.querySelector('input[type=password]'); k.value = 'sk-good-cn-1'; k.dispatchEvent(new Event('input')); ${btn(CARD, '/^Connect$/')}.click(); return 1; })()`);
    const saved = await until(async () => { const l = await mmLog(); return l.stored && l.stored.region === 'cn' ? l : null; }, 5000);
    check('Connect saves Mainland China; the mock station was sent https://api.minimaxi.com/v1', saved && saved.log.some(x => x.path === 'provider' && x.baseUrl === 'https://api.minimaxi.com/v1'), saved || await mmLog());
    const now = await until(() => js(`(() => { const p = ${CARD} && ${PICK}; return p && /Now: Mainland China/.test(p.textContent) ? p.querySelector('input[type=radio]:checked').value : null; })()`), 5000);
    check('after Connect the card shows the current endpoint (Now: Mainland China)', now === 'cn', now);
    check('no page errors on Setup', !errors.length, errors);
    // phone width: no sideways scroll with the picker open on Custom
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await js(`${radio('custom')}.click(); 1`); await sleep(300);
    check('phone: the picker fits (no sideways scroll)', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    await shot('setup-phone');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    /* ---- Settings › Connections and keys ---- */
    errors.length = 0;
    await js(`location.hash = '/settings/connections'; 1`);
    const row = `document.getElementById('set-key-custom')`;
    const rowTxt = await until(() => js(`(() => { const r = ${row}; return r && /Mainland China/.test(r.innerText) ? r.innerText : null; })()`), 8000);
    check('Settings › Connections: the MiniMax key row shows the current endpoint', /Set · Mainland China/.test(rowTxt || ''), rowTxt);
    await js(`(() => { ${btn(row, '/Replace or switch/')}.click(); ${row}.querySelector('input[type=radio][value="global"]').click(); return 1; })()`);
    const swLabel = await js(`${btn(row, '/Switch endpoint|Save key/')}.textContent`);
    check('picking another region with no new key turns Save into "Switch endpoint"', swLabel === 'Switch endpoint', swLabel);
    await js(`${btn(row, '/Switch endpoint/')}.click(); 1`);
    const swErr = await until(() => js(`(() => { const e = ${row}.querySelector('.err-line').textContent; return e ? e : null; })()`), 5000);
    check('switching re-checks the key on file on the new endpoint first: refused, nothing changes', /Global did not accept the key on file/.test(swErr || '') && (await mmLog()).stored.region === 'cn', swErr);
    await js(`(() => { const k = ${row}.querySelector('input[type=password]'); k.value = 'sk-good-global'; k.dispatchEvent(new Event('input')); ${btn(row, '/Save key|Switch endpoint/')}.click(); return 1; })()`);
    const sw = await until(async () => { const l = await mmLog(); return l.stored && l.stored.region === 'global' ? l : null; }, 5000);
    check('a key that works on Global switches the endpoint to Global', !!sw, await mmLog());
    check('no page errors on Settings', !errors.length, errors);
    await shot('settings-keys');

    /* ---- Today: a question asking for the MiniMax key ---- */
    errors.length = 0;
    await js(`location.hash = '/today'; 1`);
    const QC = `document.querySelector('.gate[data-id="q-000130"]')`;
    const qp = await until(() => js(`(() => { const g = ${QC}; const p = g && g.querySelector('.mm-endpoint'); return p ? p.querySelector('legend').textContent : null; })()`), 8000);
    check('Today: a MiniMax key question shows "Where is your MiniMax account?"', qp === 'Where is your MiniMax account?', qp);
    await js(`(() => { const g = ${QC}; g.querySelector('.mm-endpoint input[type=radio][value="cn"]').click(); const i = g.querySelector('input.secret-input'); i.value = 'sk-good-cn-2'; i.dispatchEvent(new Event('input')); ${btn(QC, '/Store/')}.click(); return 1; })()`);
    const ql = await until(async () => { const l = await mmLog(); return l.log.find(x => x.path === 'question') || null; }, 5000);
    check('storing the key sends the picked region with it (Mainland China)', ql && ql.region === 'cn' && ql.baseUrl === 'https://api.minimaxi.com/v1', ql || await mmLog());
    check('no page errors on Today', !errors.length, errors);
    console.log(fails ? fails + ' FAILED' : 'minimax endpoint walk: all passed');
    done(fails ? 1 : 0);
  } catch (e) { console.log('FAIL walk crashed: ' + (e && e.stack || e)); done(1); }
})();
