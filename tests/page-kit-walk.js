#!/usr/bin/env node
/* page-kit-walk.js — headless Chrome walk of the page kit in the real console (console/server.js).
 *
 *   node tests/page-kit-walk.js [--shots <dir>]
 *
 * Against a temp copy of company/: copies every scaffold (console-panel.js scaffold <name> --as <name> --by owner),
 * installs it (add --by owner), starts the console on a free port (never 8800) with a dead station, then opens each
 * company page at desktop (1280) and phone (390) width in light and dark, and checks: every unit draws (no error
 * state), no page exception or console.error, no horizontal scroll, and the dark theme is really dark. It also opens
 * /preview/<id> (owner token) and the page-kit gallery (#/kit). Exits 0 with "SKIP" when no Chrome is installed or
 * Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const argv = process.argv.slice(2);
const SHOTS = (i => i >= 0 ? argv[i + 1] : null)(argv.indexOf('--shots'));
const REPO = path.join(__dirname, '..');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP page kit walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP page kit walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { for (;;) { const p = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); }); if (p !== 8800) return p; } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 600))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }

(async () => {
  const tmp = life.tmpDir('page-kit-walk-');
  fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), 'walk-fake-station-token\n', { mode: 0o600 });
  const deadPort = await freePort();
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + deadPort });
  delete env.CONSOLE_PORT; delete env.CONSOLE_ROOT;
  const cp = (...a) => { try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'company', 'tools', 'console-panel.js')].concat(a), { env, encoding: 'utf8', cwd: tmp })) }; } catch (e) { return { code: e.status, out: String(e.stdout || e.message).slice(0, 600) }; } };
  const scaffolds = JSON.parse(execFileSync(process.execPath, [path.join(tmp, 'company', 'tools', 'console-panel.js'), 'scaffolds', '--json'], { env, encoding: 'utf8', cwd: tmp }));
  check('five scaffolds ship', ['trading-desk', 'noc-health', 'production-board', 'calendar', 'client-portfolio'].every(n => scaffolds.some(s => s.name === n)), scaffolds.map(s => s.name));
  const pages = [];
  for (const s of scaffolds) {
    const sc = cp('scaffold', s.name, '--as', s.name, '--by', 'owner');
    const add = sc.code === 0 ? cp('add', path.join(tmp, sc.out.dir), '--by', 'owner') : sc;
    check('scaffold ' + s.name + ' -> add installs it', add.code === 0 && add.out.status === 'installed' && add.out.type === 'page', add.out);
    if (add.code === 0) pages.push({ id: s.name, units: s.units.length });
  }
  const server = life.track(spawn(process.execPath, [path.join(REPO, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let sOut = ''; server.stdout.on('data', d => { sOut += d; }); server.stderr.on('data', d => { sOut += d; });
  const port = await until(async () => { const m = sOut.match(/\{"port":(\d+)\}/); return m && Number(m[1]); }, 15000);
  if (!port) { console.error('page kit walk: the console did not start: ' + sOut.slice(-400)); server.kill(); process.exit(1); }
  const token = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const base = 'http://127.0.0.1:' + port;
  const cport = await freePort();
  const udd = life.tmpDir('page-kit-chrome-');
  const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', env: life.chromeEnv(udd) }));
  const done = code => { try { chrome.kill(); } catch (_) {} try { server.kill(); } catch (_) {} setTimeout(() => { for (const d of [udd, tmp]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } process.exit(code); }, 300); };
  try {
    const page = await until(async () => { try { return (await getJson('http://127.0.0.1:' + cport + '/json')).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (_) { return null; } }, 20000);
    if (!page) throw new Error('Chrome showed no page target in 20 s');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); let errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push('exception: ' + String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + (m.params.args || []).map(a => a.value || a.description).join(' ').slice(0, 200)); };
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
    const go = async url => { await send('Page.navigate', { url }); await sleep(300); };
    const view = async (w, scheme) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    };
    // geometry and theme facts of the current document
    const facts = sel => js(`(() => { const d = document.documentElement; const units = [...document.querySelectorAll('${sel} .unit')];
      const bg = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number); const lum = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255;
      const wide = [...document.querySelectorAll('${sel} .unit')].filter(u => u.getBoundingClientRect().right > d.clientWidth + 1).map(u => u.dataset.unit);
      return { units: units.length, busy: document.querySelectorAll('${sel} [aria-busy=true]').length, errs: units.filter(u => u.querySelector('.unit-state.err')).map(u => u.dataset.unit + ': ' + u.querySelector('.unit-state.err').textContent),
        hscroll: d.scrollWidth > d.clientWidth + 1 ? d.scrollWidth + ' > ' + d.clientWidth : false, wide, lum: +lum.toFixed(2),
        svgs: document.querySelectorAll('${sel} .ch svg[role=img]').length, tables: document.querySelectorAll('${sel} .ch + .legend, ${sel} details.as-table').length }; })()`);
    await send('Runtime.enable'); await send('Page.enable');
    await go(base + '/login');   // the login form (a token never goes in an address)
    await until(() => js('(()=>{const i=document.getElementById("secret");if(!i)return 0;i.value=' + JSON.stringify(token) + ';i.form.submit();return 1})()'), 8000);
    await until(() => js('!!document.querySelector(".shell")'), 8000);
    const nav = await until(() => js(`[...document.querySelectorAll('a.nav-item[href^="#/p/"]')].map(a => a.getAttribute('href'))`).then(x => x && x.length >= pages.length && x), 8000);
    check('the Company nav group lists every installed page', nav && pages.every(p => nav.includes('#/p/' + p.id)), nav);
    for (const pg of pages) {
      for (const [w, scheme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
        await view(w, scheme); errors = [];
        await go(base + '/#/p/' + pg.id);
        const f = await until(async () => { const x = await facts('.page-grid'); return x && x.units === pg.units && !x.busy ? x : null; }, 10000) || await facts('.page-grid');
        await sleep(250);   // charts draw on the next frame (ResizeObserver)
        const g = await facts('.page-grid');
        const tag = pg.id + ' @' + w + ' ' + scheme;
        check(tag + ': all ' + pg.units + ' units drawn, none in an error state', f.units === pg.units && !f.busy && !g.errs.length, g);
        check(tag + ': no horizontal scroll', !g.hscroll && !g.wide.length, g);
        check(tag + ': ' + (scheme === 'dark' ? 'dark' : 'light') + ' theme', scheme === 'dark' ? g.lum < 0.2 : g.lum > 0.8, g.lum);
        check(tag + ': no page exceptions or console errors', !errors.length, errors);
        await shot(pg.id + '-' + w + '-' + scheme);
      }
    }
    // a chart has its accessible picture and its table fallback
    await view(1280, 'light'); await go(base + '/#/p/trading-desk');
    await until(() => js(`document.querySelectorAll('.page-grid .ch svg').length >= 2`), 8000);
    const a11y = await js(`(() => { const s = document.querySelector('.page-grid .ch svg[role=img]'); return { label: s && s.getAttribute('aria-label'), table: !!s && !!s.closest('.unit').querySelector('details.as-table table') }; })()`);
    check('a chart: role=img with a summary, and a table fallback', a11y && /chart/i.test(a11y.label || '') && a11y.table, a11y);
    // a row action opens the confirm dialog with the filled text, and Cancel sends nothing
    await js(`(() => { const b = [...document.querySelectorAll('.page-grid [data-unit=positions] button')].find(x => x.textContent === 'Ask about this'); b && b.click(); return !!b; })()`);
    const dlg = await until(() => js(`(() => { const d = document.querySelector('dialog.modal'); return d && d.innerText; })()`), 4000);
    check('a row action asks the owner to confirm the filled-in handoff', /handoff to finance/.test(dlg || '') && /Owner question on [A-Z]/.test(dlg || ''), dlg);
    await js(`(() => { const b = [...document.querySelectorAll('dialog.modal button')].find(x => x.textContent === 'Cancel'); b && b.click(); return 1; })()`);
    // kanban move: a confirm naming both columns (a handoff, not a write)
    await go(base + '/#/p/production-board');
    await until(() => js(`document.querySelectorAll('.kb-card').length > 3`), 8000);
    await js(`(() => { const c = document.querySelector('.kb-card'); const s = c.querySelector('select'); s.value = s.options[s.options.length - 1].value; [...c.querySelectorAll('button')].find(b => b.textContent === 'Move').click(); return 1; })()`);
    const mv = await until(() => js(`(() => { const d = document.querySelector('dialog.modal'); return d && d.innerText; })()`), 4000);
    check('kanban: Move asks to confirm a handoff naming from and to', /handoff to ceo/.test(mv || '') && /from Brief to Delivered/.test(mv || ''), mv);
    await js(`(() => { const b = [...document.querySelectorAll('dialog.modal button')].find(x => x.textContent === 'Cancel'); b && b.click(); return 1; })()`);
    // one broken source never blanks the page: only the units reading it show their error state
    fs.rmSync(path.join(tmp, 'company', 'work', 'owner', 'page-data', 'noc-health', 'uptime.json'), { force: true });
    await go(base + '/#/p/noc-health');
    const broken = await until(async () => { const x = await facts('.page-grid'); return x && x.units && !x.busy ? x : null; }, 8000);
    check('a missing source shows an error in its unit only; the rest of the page draws', broken && broken.units === pages.find(p => p.id === 'noc-health').units && broken.errs.length === 1 && /^uptime: Could not load uptime/.test(broken.errs[0]), broken);
    // the preview: owner token, the same drawing
    errors = [];
    await go(base + '/preview/noc-health?theme=dark');
    const pv = await until(() => js(`document.body.dataset.ready ? { ready: document.body.dataset.ready, units: document.querySelectorAll('.page-grid .unit').length, theme: document.documentElement.dataset.theme } : null`), 10000);
    check('/preview/<id> draws the page (dark via ?theme=dark)', pv && pv.ready === 'ok' && pv.units === pages.find(p => p.id === 'noc-health').units && pv.theme === 'dark', pv);
    check('/preview/<id>: no page exceptions or console errors', !errors.length, errors);
    await shot('preview-noc-health-dark');
    const anon = await new Promise(res => http.get(base + '/preview/noc-health', r => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
    check('/preview/<id> needs the owner sign-in (signed out: to the login page)', anon === 303, anon);
    // the gallery: every kind, light and dark, desktop and phone
    for (const [w, scheme] of [[1280, 'light'], [1280, 'dark'], [390, 'light']]) {
      await view(w, scheme); errors = [];
      await go(base + '/#/kit');
      const k = await until(async () => { const x = await js(`document.querySelectorAll('[data-gallery-kind]').length`); return x >= 17 ? x : null; }, 8000);
      await sleep(250);
      const kinds = await js(`[...new Set([...document.querySelectorAll('[data-gallery-kind]')].map(u => u.dataset.kind))]`);
      const g = await facts('.kit-gallery');
      check('gallery @' + w + ' ' + scheme + ': every unit kind drawn', k >= 17 && ['stat-row', 'positions', 'gauge', 'chart', 'status-grid', 'feed', 'pipeline', 'kanban', 'calendar', 'progress', 'table', 'timeline'].every(x => (kinds || []).includes(x)), kinds);
      check('gallery @' + w + ' ' + scheme + ': shows loading, empty and error states', await js(`!!document.querySelector('[data-unit=loading] [aria-busy=true]') && !!document.querySelector('[data-unit=error] .unit-state.err') && /All quiet/.test(document.querySelector('[data-unit=empty]').innerText)`));
      check('gallery @' + w + ' ' + scheme + ': no horizontal scroll, no errors', !g.hscroll && !g.wide.length && !errors.length, { g, errors });
      await shot('gallery-' + w + '-' + scheme);
    }
    console.log(fails ? 'PAGE KIT WALK: FAIL (' + fails + ')' : 'PAGE KIT WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('page kit walk crashed: ' + e.stack); done(1); }
})();
