#!/usr/bin/env node
/* connect-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Settings › Connections and
 * keys › Sign-ins and its Connect dialog (console/connectors.js, docs/CONNECTORS.md).
 *
 *   node tests/connect-walk.js
 *
 * Checks, at desktop and phone widths: Synpath and the GitHub CLI are listed with Not connected / Expired and the
 * honest same-user promise, no sideways scroll. Then: Connect on Synpath shows "Sign in with Google" (opens in a new
 * tab, never in the console), the same-machine instructions, and on "My browser is on another computer" the fallback
 * field; a pasted address on another host, port or state is refused in plain words, the right one connects; Disconnect
 * asks first, then the row says Not connected; a refused Google sign-in shows the test-user known issue; Reconnect on
 * the GitHub CLI shows the device code and its page, and approval connects it. Starts the mock on a free port (never
 * 8800). Exits 0 with "SKIP" when no Chrome is installed or Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP connect walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP connect walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
const postJson = (port, p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, r => { r.resume(); r.on('end', res); }); q.on('error', rej); q.end('{}'); });
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 700))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

(async () => {
  const port = await freePort(), cport = await freePort();
  const mock = spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(port)], { env: Object.assign({}, process.env, { MOCK_NO_PUSH: '1', MOCK_CERTIFIED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; mock.stdout.on('data', d => { out += d; }); mock.stderr.on('data', d => { out += d; });
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-walk-'));
  const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
    const row = n => `document.querySelector('#set-sign-ins [data-connector="${n}"]')`;
    const dlg = `document.querySelector('dialog[data-connect][open]')`;
    const btn = (scope, text) => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const goto = async hash => { await send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' + hash }); };
    const acts = async () => (await getJson('http://127.0.0.1:' + port + '/api/__mock/actions')).connectors || [];
    await send('Runtime.enable'); await send('Page.enable');
    for (const [w, hgt, label] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
      await width(w, hgt); errors.length = 0;
      await goto('#/settings/connections/sign-ins');
      const ready = await until(() => js(`!!${row('synpath')} && !!${row('github-cli')}`), 10000);
      const syn = await js(`(${row('synpath')} || {}).innerText`), gh = await js(`(${row('github-cli')} || {}).innerText`);
      check(label + ': Synpath is listed Not connected with Connect; the GitHub CLI Expired with Reconnect and Disconnect', ready && /Not connected/.test(syn) && /\bConnect\b/.test(syn) && /Expired/.test(gh) && /Reconnect/.test(gh) && /Disconnect/.test(gh), { syn, gh });
      check(label + ': the promise is the honest one (out of prompts and logs, not out of reach of the crew\'s tools)', /not out of reach of the crew's tools/.test(syn) && !/encrypt|keychain/i.test(syn), syn);
      check(label + ': the credential path sits in Details', await js(`(() => { const d = ${row('synpath')}.querySelector('details'); return !!d && !d.open && d.textContent.includes('company/connections/synpath/credentials.json'); })()`));
      if (w < 600) check('phone: no sideways scroll', await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    }
    // Synpath: Connect, same machine first, then the fallback for a browser elsewhere
    await width(390, 844);
    await js(`${btn(row('synpath'), 'Connect')}.click(); 1`);
    const link = await until(() => js(`(() => { const a = ${dlg} && ${dlg}.querySelector('a[data-sign-in-link]'); return a ? { text: a.textContent, href: a.href, target: a.target, rel: a.rel } : null; })()`), 5000);
    check('Connect opens the dialog with "Sign in with Google", opening in a new tab', link && link.text === 'Sign in with Google' && /^https:\/\/auth\.example\.invalid\//.test(link.href) && link.target === '_blank' && /noopener/.test(link.rel), link);
    check('the browser is on the station (a local request): the redirect just works, no field', await js(`!!${dlg}.querySelector('[data-same-machine]') && !${dlg}.querySelector('[data-address-field]')`));
    check('phone: the dialog fits the screen', await js(`(() => { const r = ${dlg}.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; })()`));
    await width(1280, 900);
    await js(`${dlg}.querySelector('[data-toggle-remote]').click(); 1`);
    const remoteTxt = await until(() => js(`(() => { const r = ${dlg}.querySelector('[data-remote]'); return r ? r.innerText : null; })()`), 3000);
    check('"My browser is on another computer" shows the marked fallback: copy the address from the page you landed on, and the SSH tunnel', /Fallback/.test(remoteTxt || '') && /Copy the address from the page you landed on and paste it here/.test(remoteTxt || '') && await js(`${dlg}.querySelector('[data-remote] details').textContent.includes('ssh -L 48123:127.0.0.1:48123')`), remoteTxt);
    const paste = async addr => { await js(`(() => { const f = ${dlg}.querySelector('[data-address-field]'); f.value = ${JSON.stringify(addr)}; f.dispatchEvent(new Event('input')); ${btn(dlg, 'Send address')}.click(); })(); 1`); return until(() => js(`(() => { const e = ${dlg} && ${dlg}.querySelector('.err-line'); return e && e.textContent ? e.textContent : null; })()`), 4000); };
    const good = 'http://127.0.0.1:48123/callback?code=' + 'c'.repeat(43) + '&state=mock-state-1';
    const e1 = await paste(good.replace('127.0.0.1', 'evil.example'));
    check('an address on another host is refused in plain words', /127\.0\.0\.1/.test(e1 || ''), e1);
    const e2 = await paste(good.replace(':48123', ':48124'));
    check('an address on another port is refused', /another port|different sign-in/.test(e2 || ''), e2);
    const e3 = await paste(good.replace('mock-state-1', 'forged'));
    check('an address with another state is refused', /state does not match/.test(e3 || ''), e3);
    await js(`(() => { const f = ${dlg}.querySelector('[data-address-field]'); f.value = ${JSON.stringify(good)}; f.dispatchEvent(new Event('input')); ${btn(dlg, 'Send address')}.click(); })(); 1`);
    const ok1 = await until(() => js(`(() => { const d = ${dlg}; const c = d && d.querySelector('[data-connected]'); return c ? c.textContent : null; })()`), 6000);
    check('the right address connects Synpath', /Connected/.test(ok1 || '') && (await acts()).some(a => a.id === 'synpath' && a.connected), ok1);
    await js(`${btn(dlg, 'Done')}.click(); 1`);
    check('the row now says Connected', await until(() => js(`/\\bConnected\\b/.test((${row('synpath')} || {}).innerText || '') && !/Not connected/.test(${row('synpath')}.innerText)`), 5000));
    // Disconnect asks first
    await js(`${btn(row('synpath'), 'Disconnect')}.click(); 1`);
    const cd = `document.querySelector('dialog[data-disconnect][open]')`;
    const ask = await until(() => js(`(${cd} || {}).innerText`), 3000);
    check('Disconnect asks first, saying what stops', /Disconnect Synpath\?/.test(ask || '') && /removes its saved sign-in/.test(ask || '') && !(await acts()).some(a => a.disconnected), ask);
    await js(`${btn(cd, 'Disconnect')}.click(); 1`);
    check('after confirming, Synpath is Not connected', await until(() => js(`/Not connected/.test((${row('synpath')} || {}).innerText || '')`), 5000) && (await acts()).some(a => a.id === 'synpath' && a.disconnected));
    // a refused Google sign-in: the test-user known issue
    await js(`${btn(row('synpath'), 'Connect')}.click(); 1`);
    await until(() => js(`!!(${dlg} && ${dlg}.querySelector('[data-toggle-remote]'))`), 5000);
    await js(`${dlg}.querySelector('[data-toggle-remote]').click(); 1`);
    await until(() => js(`!!${dlg}.querySelector('[data-address-field]')`), 3000);
    await js(`(() => { const f = ${dlg}.querySelector('[data-address-field]'); f.value = 'http://127.0.0.1:48123/callback?error=access_denied&state=mock-state-1'; f.dispatchEvent(new Event('input')); ${btn(dlg, 'Send address')}.click(); })(); 1`);
    const ki = await until(() => js(`(() => { const k = ${dlg} && ${dlg}.querySelector('[data-known-issue]'); return k ? k.innerText : null; })()`), 6000);
    check('a refused sign-in shows the known issue: the Google account must be on the test-user list', /Known issue/.test(ki || '') && /test-user list/.test(ki || '') && await js(`!!${btn(dlg, 'Try again')}`), ki);
    await js(`${btn(dlg, 'Close')}.click(); 1`);
    // GitHub CLI: device code
    await js(`${btn(row('github-cli'), 'Reconnect')}.click(); 1`);
    const code = await until(() => js(`(() => { const d = ${dlg}; const c = d && d.querySelector('[data-device-code]'); const a = d && d.querySelector('a[data-sign-in-link]'); return c && a ? { code: c.textContent, href: a.href, text: a.textContent, field: !!d.querySelector('[data-address-field]') } : null; })()`), 5000);
    check('device code: the code and GitHub\'s page are shown, no address to paste', code && code.code === 'MOCK-1234' && code.href === 'https://github.com/login/device' && /enter the code/.test(code.text) && !code.field, code);
    await postJson(port, '/api/__mock/approve/github-cli');
    check('approval on GitHub connects it, and the dialog says so by itself', !!await until(() => js(`!!(${dlg} && ${dlg}.querySelector('[data-connected]'))`), 6000));
    await js(`${btn(dlg, 'Done')}.click(); 1`);
    check('the GitHub CLI row now says Connected', await until(() => js(`/\\bConnected\\b/.test((${row('github-cli')} || {}).innerText || '') && !/Expired/.test(${row('github-cli')}.innerText)`), 5000));
    // a link straight to a connector opens its dialog
    await goto('#/settings/connections/sign-in-synpath');
    check('#/settings/connections/sign-in-synpath opens the Connect dialog', !!await until(() => js(`!!(${dlg} && ${dlg}.getAttribute('data-connect') === 'synpath')`), 8000));
    check('no page exception during the walk', !errors.length, errors);
    console.log(fails ? 'CONNECT WALK: FAIL (' + fails + ')' : 'CONNECT WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('connect walk crashed: ' + e.stack); done(1); }
})();
