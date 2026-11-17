#!/usr/bin/env node
/* today-questions-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Today's Needs-you
 * cards render each question kind's control, the plain message comes first with the detail collapsed, a secret goes
 * through a password field that never echoes, and Snooze / Discuss / Reply work.
 *
 *   node tests/today-questions-walk.js [--shots <dir>]
 *
 * Starts the mock on a free port (never 8800) with MOCK_CERTIFIED=1, drives Chrome over the DevTools protocol (no
 * dependencies). Exits 0 with "SKIP" when no Chrome is installed or Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const net = require('net');
const argv = process.argv.slice(2);
const SHOTS = (i => i >= 0 ? argv[i + 1] : null)(argv.indexOf('--shots'));
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP today questions walk: no Chrome/Chromium installed'); process.exit(0); }
if (typeof WebSocket === 'undefined') { console.log('SKIP today questions walk: this Node has no WebSocket'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const getJson = u => new Promise((res, rej) => http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || info === undefined ? '' : ' — ' + JSON.stringify(info).slice(0, 500))); };
async function until(fn, ms) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(200); } return v; }
const SECRET = 'mock-secret-value-never-echoed-0123456789';

(async () => {
  let mport = await freePort(); if (mport === 8800) mport = await freePort();
  const mock = spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(mport)], { env: Object.assign({}, process.env, { MOCK_CERTIFIED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let mockOut = ''; mock.stdout.on('data', d => { mockOut += d; }); mock.stderr.on('data', d => { mockOut += d; });
  await until(async () => /mock console on/.test(mockOut), 8000);
  const cport = await freePort();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'today-walk-'));
  const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,2400', 'about:blank'], { stdio: 'ignore' });
  const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} setTimeout(() => process.exit(code), 200); };
  try {
    let targets; for (let i = 0; i < 60 && !targets; i++) { try { targets = await getJson('http://127.0.0.1:' + cport + '/json'); } catch (_) { await sleep(200); } }
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    let id = 0; const pending = new Map(); const errors = [];
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') errors.push(String((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text).split('\n')[0]); };
    const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };
    const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(s.result.data, 'base64')); };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + mport + '/#/today' });
    const card = sel => `document.querySelector('.gate[data-id="${sel}"]')`;
    const loaded = await until(() => js(`document.querySelectorAll('.gate').length >= 9`), 10000);
    check('Today shows the typed question cards', loaded, await js(`document.querySelectorAll('.gate').length`));
    await shot('today-questions');
    const kinds = await js(`[...document.querySelectorAll('.gate')].map(g => g.dataset.kind)`);
    for (const k of ['approve', 'secret', 'choice', 'text', 'link', 'account', 'number', 'date', 'form']) check('a ' + k + ' card renders', (kinds || []).includes(k), kinds);
    // every card: Reply (a textarea), Snooze, Discuss
    const common = await js(`[...document.querySelectorAll('.gate')].every(g => { const b = [...g.querySelectorAll('button, a')].map(x => x.textContent); return b.includes('Reply') && b.includes('Snooze') && b.includes('Discuss'); })`);
    check('every card has Reply, Snooze and Discuss', common);
    // secret
    const sec = await js(`(() => { const g = ${card('q-000111')}; const i = g.querySelector('input.secret-input'); return i && { type: i.type, ac: i.getAttribute('autocomplete'), spell: i.getAttribute('spellcheck'), note: g.innerText.includes('secrets/example-exchange-key'), replace: !!g.querySelector('input[type=checkbox]') }; })()`);
    check('secret: a password input, autocomplete off, no spellcheck, names secrets/<name>, a replace tick-box', sec && sec.type === 'password' && sec.ac === 'off' && sec.spell === 'false' && sec.note && sec.replace, sec);
    const msgFirst = await js(`(() => { const g = ${card('q-000111')}; const m = g.querySelector('.q-message'); const d = g.querySelector('details.q-details'); return { msg: m && m.innerText, closed: d && !d.open, detail: d && d.innerText, order: m && d && (m.compareDocumentPosition(d) & 4) }; })()`);
    check('the plain message comes first; the detail is collapsed under "More detail"', msgFirst.msg && /Could you make/.test(msgFirst.msg) && !/HTTP 401/.test(msgFirst.msg) && msgFirst.closed && /More detail/.test(msgFirst.detail) && msgFirst.order, msgFirst);
    await js(`(() => { const g = ${card('q-000111')}; const b = [...g.querySelectorAll('button')].find(x => x.textContent === 'Show'); b.click(); return 1; })()`);
    const shown = await js(`${card('q-000111')}.querySelector('input.secret-input').type`);
    await js(`(() => { const g = ${card('q-000111')}; [...g.querySelectorAll('button')].find(x => x.textContent === 'Hide').click(); return 1; })()`);
    check('secret: Show / Hide toggles the field', shown === 'text' && await js(`${card('q-000111')}.querySelector('input.secret-input').type`) === 'password');
    // legacy dense question: first two sentences, detail collapsed, a secure field offered with a suggested name
    const leg = await js(`(() => { const g = ${card('q-000120')}; const d = g.querySelector('details.q-details'); const hint = g.querySelector('details.q-secret-hint'); return { msg: g.querySelector('.q-message').innerText, detail: d && d.textContent, hint: hint && hint.querySelector('input[aria-label^="File name"]').value, actions: [...g.querySelectorAll('button')].map(b => b.textContent) }; })()`);
    check('legacy: the first two sentences are the message, the rest is detail', leg && /binding one/.test(leg.msg) && !/1 Hz/.test(leg.msg) && /1 Hz/.test(leg.detail), leg);
    check('legacy key question: a secure field with a suggested name and a "Store the key securely" action', leg && leg.hint === 'example-api-key' && leg.actions.includes('Approve') && leg.actions.includes('Store the key securely'), leg);
    // choice, link, number, date, account, form
    const ch = await js(`(() => { const g = ${card('q-000112')}; const r = [...g.querySelectorAll('input[type=radio]')]; return { n: r.length, checked: (r.find(x => x.checked) || {}).value, rec: g.innerText.includes('Recommended'), other: !!g.querySelector('input[aria-label="Your own answer"]') }; })()`);
    check('choice: radio options, the recommended one picked and tagged, an "other" box', ch && ch.n === 4 && ch.checked === 'free' && ch.rec && ch.other, ch);
    const ln = await js(`(() => { const a = ${card('q-000114')}.querySelector('a[target=_blank]'); return a && { href: a.getAttribute('href'), rel: a.getAttribute('rel') }; })()`);
    check('link: an open button to the https page with rel=noopener', ln && ln.href === 'https://example.com/signup' && /noopener/.test(ln.rel), ln);
    check('link: Done and Couldn\'t do it', await js(`(() => { const b = [...${card('q-000114')}.querySelectorAll('button')].map(x => x.textContent); return b.includes('Done') && b.includes("Couldn't do it"); })()`));
    check('number: a number input with its unit', await js(`(() => { const g = ${card('q-000116')}; const i = g.querySelector('input[type=number]'); return !!i && i.max === '500' && g.innerText.includes('USD'); })()`));
    check('date: a date input', await js(`!!${card('q-000117')}.querySelector('input[type=date]')`));
    check('account: the link plus its non-secret fields', await js(`(() => { const g = ${card('q-000115')}; return !!g.querySelector('a[target=_blank]') && g.innerText.includes('The sign-in email') && g.querySelectorAll('input[type=text]').length >= 2; })()`));
    check('an asker-composed form: info, link, text, secret, checkbox and its own named actions', await js(`(() => { const g = ${card('q-000118')}; const b = [...g.querySelectorAll('button')].map(x => x.textContent); return g.innerText.includes('It costs') && !!g.querySelector('input.secret-input') && !!g.querySelector('input[type=checkbox]') && b.includes('Here you go') && b.includes('Use another free service instead'); })()`));
    await js(`(() => { [...${card('q-000118')}.querySelectorAll('button')].find(x => x.textContent === 'Here you go').click(); return 1; })()`);
    const ferr = await until(() => js(`${card('q-000118')}.querySelector('.err-line').textContent`), 4000);
    check('a form with a required field left empty says which one', /Not recorded: .*(Sign up|Sign-in email|tick it|fill it in)/.test(ferr || ''), ferr);
    // Reply is long-form; a key pasted into it is stopped in the browser
    await js(`(() => { [...${card('q-000113')}.querySelectorAll('button')].find(x => x.textContent === 'Reply').click(); return 1; })()`);
    const rta = await until(() => js(`(() => { const t = ${card('q-000113')}.querySelector('textarea[aria-label^="Your reply"]'); return t ? Number(t.getAttribute('rows')) : 0; })()`), 3000);
    check('Reply opens a long-form textarea', rta >= 4, rta);
    // Discuss opens the asker's live chat with the question quoted
    const disc = await js(`[...${card('q-000116')}.querySelectorAll('a')].find(a => a.textContent === 'Discuss').getAttribute('href')`);
    check('Discuss opens the asker\'s live chat with the question quoted', /^#\/comms\/agent:agent\?draft=/.test(disc || '') && decodeURIComponent(disc.split('draft=')[1]).startsWith('> What is the most'), disc);
    // store the secret: the card goes, the value appears nowhere on the page
    await js(`(() => { const i = ${card('q-000111')}.querySelector('input.secret-input'); i.value = ${JSON.stringify(SECRET)}; i.dispatchEvent(new Event('input')); [...${card('q-000111')}.querySelectorAll('button')].find(x => x.textContent === 'Store it securely').click(); return 1; })()`);
    const gone = await until(() => js(`!${card('q-000111')}`), 5000);
    check('secret stored: the card is answered', gone);
    const leak = await js(`document.documentElement.outerHTML.includes(${JSON.stringify(SECRET)}) || [...document.querySelectorAll('input, textarea')].some(i => i.value.includes(${JSON.stringify(SECRET)}))`);
    check('the secret value is nowhere on the page afterwards', leak === false, leak);
    const answered = await until(() => js(`(() => { const d = [...document.querySelectorAll('details')].find(x => /Answered today/.test(x.textContent)); return d && d.textContent; })()`), 4000);
    check('Answered today says where the key went, not what it is', answered && /secrets\/example-exchange-key/.test(answered) && !answered.includes(SECRET), answered);
    // snooze: the card hides and shows under "Snoozed"
    await js(`(() => { const g = ${card('q-000117')}; [...g.querySelectorAll('button')].find(x => x.textContent === 'Snooze').click(); [...g.querySelectorAll('button')].find(x => x.textContent === 'In an hour').click(); return 1; })()`);
    const snoozed = await until(() => js(`!${card('q-000117')} && [...document.querySelectorAll('summary')].some(s => /Snoozed \\(1\\)/.test(s.textContent))`), 5000);
    check('Snooze hides the card until then and lists it under "Snoozed"', snoozed);
    await shot('today-after');
    check('no page exceptions', !errors.length, errors);
    console.log(fails ? 'TODAY QUESTIONS WALK: FAIL (' + fails + ')' : 'TODAY QUESTIONS WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('today questions walk crashed: ' + e.stack); done(1); }
})();
