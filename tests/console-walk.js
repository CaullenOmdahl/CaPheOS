#!/usr/bin/env node
/* console-walk.js — drive the owner console in headless Chrome (DevTools protocol, no dependencies) and check what the
 * owner sees. Used by scripts/e2e-first-light.sh against a console that talks to tests/mock-station.js.
 *
 *   node tests/console-walk.js --url http://127.0.0.1:<console port> --token <console token> [--shots <dir>] [--out <file>]
 *
 * Walks: every route of the route map (old routes too, through their redirects) renders without an exception; Setup → Charter → "Draft it with the Founder" opens
 * the live chat and the Founder's reply streams in (tool step, text, a console: link that stays in the app); Today's
 * "Now" strip shows the run in flight (the test started one on the mock with POST /__live) with Watch and Stop; Needs you
 * renders the secret question the e2e asked with a password field.
 * Prints one line per check and exits 1 on any failure; exits 0 with "SKIP" when no Chrome is installed.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = opt('url'), TOKEN = opt('token'), SHOTS = opt('shots');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP console walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP console walk: this Node has no WebSocket'); process.exit(0); }
const ROUTES = ['#/today', '#/setup', '#/setup/charter', '#/setup/provider', '#/chat/owner', '#/chat/agent', '#/crew', '#/crew/agent', '#/crew/hiring', '#/work/handoffs',
  '#/work/quests', '#/spend', '#/settings/company', '#/settings/autonomy/guardrails', '#/settings/autonomy', '#/settings/tempo', '#/settings/models', '#/settings/connections',
  '#/settings/pages', '#/settings/system', '#/settings/system/map', '#/halt',
  // old routes agents still link to: each redirects to its new home and renders (tests/console-routes-walk.js checks where)
  '#/comms/owner', '#/hiring', '#/controls/gov', '#/automate', '#/governance', '#/usage', '#/system', '#/map'];
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'console-walk-'));
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + port, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const OUT = opt('out');
const check = (name, ok, info) => { if (!ok) fails++; if (OUT) fs.appendFileSync(OUT, (ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 1200)) + '\n'); console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 400))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; }
(async () => {
  // Chrome answers /json before its first page target exists: wait for the page, not for the port
  const page = await until(async () => { try { return (await getJson('http://127.0.0.1:' + port + '/json')).find(t => t.type === 'page' && t.webSocketDebuggerUrl); } catch (_) { return null; } }, 20000);
  if (!page) { console.log('FAIL Chrome showed no page target in 20 s'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const errors = [];
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]); };
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/login' });   // the login form (a token never goes in an address)
  await until(() => js('(()=>{const i=document.getElementById("secret");if(!i)return 0;i.value=' + JSON.stringify(TOKEN) + ';i.form.submit();return 1})()'), 10000);
  // signed in once the login redirect has landed on the app shell (a condition, not a fixed pause)
  const signedIn = await until(() => js(`location.pathname !== '/login' && !!document.getElementById('main') && document.readyState === 'complete'`), 20000);
  check('the login link signs in and lands on the app', signedIn, await js('location.href'));
  for (const r of ROUTES) {
    errors.length = 0;
    await js('location.hash = ' + JSON.stringify(r.slice(1)) + '; 1');
    const ok = await until(() => js(`(() => { const t = (document.getElementById('main') || {}).innerText || ''; return t.trim().length > 40 && !/Loading…$/.test(t.trim()) && !/This screen failed/.test(t); })()`), 6000);
    check('route ' + r + ' renders', ok && !errors.length, { errors, text: await js(`((document.getElementById('main')||{}).innerText||'').slice(0,200)`) });
  }
  // Crew > seat > Model: the primary picker, the chain editor and "running now ... because ..." (console/models.js)
  await js('location.hash = "/crew/agent"; 1');
  await until(() => js(`[...document.querySelectorAll('[role=tab]')].some(b => b.textContent === 'Model')`), 6000);
  errors.length = 0;
  await js(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent === 'Model').click(); 1`);
  const mp = await until(() => js(`(() => { const t = (document.getElementById('main') || {}).innerText || ''; const i = t.toLowerCase().indexOf('running now'); return i >= 0 && /Fallback chain/i.test(t) && document.querySelector('select[aria-label="Set primary provider"]') ? t.slice(i, i + 200) : null; })()`), 8000);
  check('Crew > seat > Model shows what it runs now (a why only when unusual), a primary picker and the chain editor', !!mp && /\bOn \S/.test(mp) && !errors.length, { mp, errors });
  await shot('crew-model');
  await js('location.hash = "/settings/models"; 1');
  const ct = await until(() => js(`(() => { const s = document.getElementById('set-chains'); return s && s.querySelector('table') ? s.innerText.slice(0, 300) : null; })()`), 8000);
  check('Settings › Models shows every seat\'s chain in one table', !!ct && /running now/i.test(ct), ct);
  const cut = await until(() => js(`(() => { const s = document.getElementById('set-cutoffs'); const c = s && s.querySelector('[data-sub=claude]'); return c ? { ranges: c.querySelectorAll('input[type=range]').length, say: (c.querySelector('output.q-say') || {}).textContent, save: [...c.querySelectorAll('button')].some(b => b.textContent === 'Save'), text: c.innerText.slice(0, 1500) } : null; })()`), 8000);
  check('Settings › Models › Subscription cutoffs: Claude\'s weekly stop and daily pacing sliders, in plain words, with Save', !!cut && cut.ranges === 2 && /Let routines use up to \d+% of this week's Claude/.test(cut.say || '') && cut.save && /Resets/.test(cut.text) && /Affects/.test(cut.text), cut);
  // Setup -> Charter -> Draft it with the Founder -> the reply streams in
  await js('location.hash = "/setup/charter"; 1');
  const btn = await until(() => js(`!!document.querySelector('#step-charter') && [...document.querySelectorAll('#step-charter button')].some(b => /Draft it with the Founder/.test(b.textContent))`), 8000);
  check('Setup #/setup/charter opens the charter step with "Draft it with the Founder"', btn && await js(`document.getElementById('step-charter').open`));
  await js(`[...document.querySelectorAll('#step-charter button')].find(b => /Draft it with the Founder/.test(b.textContent)).click(); 1`);
  const live = await until(() => js(`location.hash.startsWith('#/chat/agent:') && !!document.querySelector('.msg-them-wrap.live, .chat-who')`), 8000);
  check('the draft opens the live chat and shows the Founder working', !!live, await js('location.hash'));
  await shot('chat-streaming');
  const reply = await until(() => js(`(() => { const w = [...document.querySelectorAll('.msg-them-wrap')].pop(); if (!w || w.classList.contains('live')) return null; return { text: w.innerText, steps: w.querySelectorAll('.chat-step').length, links: [...w.querySelectorAll('a')].map(a => a.getAttribute('href')) }; })()`), 15000);
  check('the Founder\'s reply streamed in and rendered (tool step + text)', reply && /three quick questions/i.test(reply.text) && reply.steps >= 1, reply);
  check('the brief\'s console: link renders as an in-app link', reply && reply.links.includes('#/setup/charter'), reply && reply.links);
  const strip = await until(() => js(`(document.querySelector('.charter-strip.done')||{}).innerText`), 8000);
  check('the charter strip flips to done once CHARTER.md has no blanks', !!strip, await js(`(document.querySelector('.charter-strip')||{}).innerText`));
  await shot('chat-done');
  // Today: the Now strip shows the run the test started on the mock
  await js('location.hash = "/today"; 1');
  const now = await until(() => js(`(() => { const r = document.querySelector('.now-run'); return r ? r.innerText : null; })()`), 8000);
  check('Today\'s Now strip shows the run in flight with its step, Watch and Stop', now && /Founder/.test(now) && /reading the charter/i.test(now) && /Watch/.test(now) && /Stop/.test(now), now);
  await shot('today-now');
  // Needs you: the typed secret question the e2e asked renders a password field (never autofilled) and the plain message
  const secretCard = await until(() => js(`(() => { const g = document.querySelector('.gate[data-kind="secret"]'); if (!g) return null; const i = g.querySelector('input.secret-input'); return { type: i && i.type, ac: i && i.getAttribute('autocomplete'), msg: (g.querySelector('.q-message') || {}).innerText || '', buttons: [...g.querySelectorAll('button, a')].map(b => b.textContent) }; })()`), 8000);
  check('Today renders the secret question with a password field, its message and Reply / Snooze / Discuss', secretCard && secretCard.type === 'password' && secretCard.ac === 'off' && /paste the example API key/.test(secretCard.msg) && ['Store it securely', 'Reply', 'Snooze', 'Discuss'].every(b => secretCard.buttons.includes(b)), secretCard);
  console.log(fails ? 'CONSOLE WALK: FAIL (' + fails + ')' : 'CONSOLE WALK: PASS');
  ws.close(); chrome.kill(); try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
  setTimeout(() => process.exit(fails ? 1 : 0), 200);
})().catch(e => { console.error('console walk crashed: ' + e.stack); chrome.kill(); process.exit(1); });
