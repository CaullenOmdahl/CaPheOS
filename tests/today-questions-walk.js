#!/usr/bin/env node
/* today-questions-walk.js — headless Chrome against the console mock (console/ui/dev/mock-api.js): Today's Needs-you
 * cards render each question kind's control, the plain message comes first with the detail collapsed, a secret goes
 * through a password field that never echoes, and Snooze / Discuss / Reply work from each card's "More ▾" menu. The
 * layout is one readable column of natural-height cards; card heads say who asked, when and a human category (ids under
 * Details); the secret field is full width with its path under Details; Now says each step in plain words.
 *
 *   node tests/today-questions-walk.js [--shots <dir>]
 *
 * Starts the mock on a free port (never 8800) with MOCK_CERTIFIED=1 and MOCK_NO_PUSH=1 (the mock's timed new question
 * would redraw every card mid-walk and wipe the state a check is reading), drives Chrome over the DevTools protocol (no
 * dependencies). Exits 0 with "SKIP" when no Chrome is installed or Node has no WebSocket; 1 on any failed check.
 */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
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
  const mock = life.track(spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(mport)], { env: Object.assign({}, process.env, { MOCK_CERTIFIED: '1', MOCK_NO_PUSH: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let mockOut = ''; mock.stdout.on('data', d => { mockOut += d; }); mock.stderr.on('data', d => { mockOut += d; });
  if (!await until(async () => /mock console on/.test(mockOut), 15000)) { console.error('today questions walk: the mock did not start: ' + mockOut.slice(-400)); mock.kill(); process.exit(1); }
  const cport = await freePort();
  const udd = life.tmpDir('today-walk-');
  const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=' + udd, '--remote-debugging-port=' + cport, '--window-size=1280,2400', 'about:blank'], { stdio: 'ignore', env: life.chromeEnv(udd) }));
  const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} setTimeout(() => process.exit(code), 200); };
  try {
    // Chrome answers /json before its first page target exists: wait for the page, not for the port
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
    await send('Page.navigate', { url: 'http://127.0.0.1:' + mport + '/#/today' });
    const card = sel => `document.querySelector('.gate[data-id="${sel}"]')`;
    const loaded = await until(() => js(`document.querySelectorAll('.gate').length >= 9`), 10000);
    check('Today shows the typed question cards', loaded, await js(`document.querySelectorAll('.gate').length`));
    await shot('today-questions');
    const kinds = await js(`[...document.querySelectorAll('.gate')].map(g => g.dataset.kind)`);
    for (const k of ['approve', 'secret', 'choice', 'text', 'link', 'account', 'number', 'date', 'form', 'multi']) check('a ' + k + ' card renders', (kinds || []).includes(k), kinds);
    // every card: the primary actions in view, Reply / Snooze / Discuss in one "More ▾" menu
    const common = await js(`[...document.querySelectorAll('.gate')].map(g => { const row = g.querySelector('.q-actions'); const vis = [...row.querySelectorAll('button, a')].filter(b => b.getClientRects().length && !b.closest('.more-menu')).map(x => x.textContent); const menu = [...g.querySelectorAll('.more-menu [role=menuitem]')].map(x => x.textContent); return { id: g.dataset.id, vis, menu, hidden: g.querySelector('.more-menu').hidden }; })`);
    check('every card has one "More ▾" menu holding Reply, Snooze and Discuss (closed), and none of them sits beside the primary actions', common && common.every(c => c.vis.includes('More ▾') && !c.vis.some(t => /^(Reply|Snooze|Discuss)$/.test(t)) && ['Reply', 'Snooze', 'Discuss'].every(t => c.menu.includes(t)) && c.hidden), common && common.filter(c => !c.vis.includes('More ▾') || !c.hidden));
    await js(`(() => { ${card('q-000101')}.querySelector('.more-btn').click(); return 1; })()`);
    const opened = await js(`(() => { const g = ${card('q-000101')}; const m = g.querySelector('.more-menu'); return { open: !m.hidden, exp: g.querySelector('.more-btn').getAttribute('aria-expanded'), items: [...m.querySelectorAll('[role=menuitem]')].filter(b => b.getClientRects().length).length }; })()`);
    check('More ▾ opens its menu (aria-expanded) with three items', opened && opened.open && opened.exp === 'true' && opened.items === 3, opened);
    await js(`(() => { ${card('q-000101')}.querySelector('.more-btn').click(); return 1; })()`);
    // 1. layout: one column at most 760 px wide, cards as tall as their content, the actions right under the question
    const lay = await js(`(() => { const gs = document.querySelector('.gates'); const cols = getComputedStyle(gs).gridTemplateColumns.split(' ').length; const g = ${card('q-000101')}; const r = g.getBoundingClientRect(); const t = g.querySelector('h3, .q-message').getBoundingClientRect(); const a = g.querySelector('.q-actions').getBoundingClientRect();
      const g2 = ${card('q-000112')}.getBoundingClientRect(); return { cols, width: Math.round(r.width), gap: Math.round(a.top - t.bottom), tail: Math.round(r.bottom - a.bottom), h1: Math.round(r.height), h2: Math.round(g2.height), sameLeft: Math.abs(r.left - g2.left) < 2 }; })()`);
    check('Needs you is one column (≤ 760 px) of full-width cards at 1280 px', lay && lay.cols === 1 && lay.width <= 760 && lay.width >= 600 && lay.sameLeft, lay);
    check('a short approve card is as tall as its content: its buttons sit right under the question (and what Approve does)', lay && lay.gap < 170 && lay.tail < 90 && lay.h1 !== lay.h2, lay);
    // 3. the optional reason is an "Add a note" link that opens a textarea
    const note0 = await js(`(() => { const g = ${card('q-000101')}; const t = g.querySelector('.q-note textarea'); return { link: !!g.querySelector('.q-note-open'), shown: !!t && t.getClientRects().length > 0, label: g.innerText.includes('Reason (optional)') }; })()`);
    await js(`(() => { ${card('q-000101')}.querySelector('.q-note-open').click(); return 1; })()`);
    const note1 = await js(`(() => { const t = ${card('q-000101')}.querySelector('.q-note textarea'); return !!t && t.getClientRects().length > 0 && document.activeElement === t; })()`);
    check('approve card: no open "Reason (optional)" box, an "Add a note" link that opens one', note0 && note0.link && !note0.shown && !note0.label && note1, { note0, note1 });
    // 4. card heads: who asked, when, and a human category; ids and raw tags only under Details
    const heads = await js(`[...document.querySelectorAll('.gate')].map(g => ({ id: g.dataset.id, cat: (g.querySelector('.q-meta .tag-accent') || {}).textContent || '', who: g.querySelector('.q-asker').textContent, details: g.querySelector('.q-card-details details').textContent }))`);
    check('card heads show a human category and "asker · time", never the question id or a raw tag', heads && heads.every(x => ['Hiring', 'Money', 'Access', 'AI usage', 'Setup', 'Blocking', ''].includes(x.cat) && /ago|just now/.test(x.who) && !/q-\d/.test(x.who + x.cat) && x.details.includes(x.id)), heads);
    check('the pacer\'s question is "AI usage", the hiring gate "Hiring"', heads && (heads.find(x => x.id === 'q-000119') || {}).cat === 'AI usage' && (heads.find(x => x.id === 'q-000101') || {}).cat === 'Hiring', heads && heads.map(x => x.cat));
    // walk 2 (1): a request of several questions leads with one line; each numbered question carries its own text
    const w2 = await js(`(() => { const g = ${card('q-000124')}; if (!g) return null; const lead = g.querySelector('.q-message').innerText.trim(); const parts = [...g.querySelectorAll('.q-part')];
      return { lead, leadLen: lead.length, nums: parts.length, cat: (g.querySelector('.q-meta .tag-accent') || {}).textContent || '', repeats: /commitments tool/.test(lead), more: !!g.querySelector('.q-details'),
        does: parts.map(p => (p.querySelector('.q-does') || {}).textContent || ''), url: (() => { const i = parts[2].querySelector('input[type=url]'); return i ? { ph: i.placeholder, secret: !!parts[2].querySelector('.secret-input'), text: parts[2].innerText } : null; })(),
        buttons: [...parts[2].querySelectorAll('button')].map(b => b.textContent), orphan: [...g.querySelectorAll('summary')].filter(x => x.textContent.trim() === 'Details').length }; })()`);
    check('walk 2: a multi-question card leads with one line (≤ 160 chars), not every sub-question in one paragraph', w2 && w2.leadLen <= 160 && w2.leadLen > 20 && !w2.repeats && w2.nums === 3 && w2.more, w2);
    check('walk 2: no "Commitment" tag from a free-text about; mixed questions show no category', w2 && w2.cat === '', w2 && w2.cat);
    check('walk 2: a URL the asker sent as a "secret" field is a plain https URL field with Save, no Show / Multi-line key / Replace the saved key', w2 && w2.url && /https/.test(w2.url.ph) && !w2.url.secret && !/Show|Multi-line key|Replace the saved key|Stored safely/.test(w2.url.text) && w2.buttons.includes('Save the ping URL'), w2 && { url: w2.url, buttons: w2.buttons });
    check('walk 2: every Approve says what it does: the asker\'s words, else "Approve tells Founder yes"', w2 && /^Approve tells Founder yes/.test(w2.does[0]) && /switches the commitments module on/.test(w2.does[1]), w2 && w2.does);
    check('walk 2: no orphan "Details" label on the card', w2 && w2.orphan === 0, w2 && w2.orphan);
    const badUrl = await js(`(() => { const g = ${card('q-000124')}; const i = g.querySelector('input[type=url]'); i.value = 'hc-ping.com/abc'; i.dispatchEvent(new Event('input')); const e = i.parentElement.querySelector('.err-line').textContent; i.value = ''; i.dispatchEvent(new Event('input')); return e; })()`);
    check('walk 2: the URL field says it wants https before anything is sent', /https:\/\//.test(badUrl || ''), badUrl);
    const wd = await until(() => js(`(() => { const d = [...document.querySelectorAll('details')].find(x => /Answered today/.test(x.textContent)); const li = d && d.querySelector('.q-withdrawn'); return li && li.textContent; })()`), 4000);
    check('walk 2: a withdrawn question is one line under Answered today: "withdrawn by Founder: why"', /withdrawn by Founder: the service rerender fixed/.test(wd || ''), wd);
    const times = await js(`document.querySelector('main').innerText.match(/\\b\\d{1,2}:\\d\\d ?(AM|PM)\\b/g)`);
    check('walk 2: Today shows no 12-hour times', !times, times);
    // 6. a split request: no "as a whole", no implementation note; several decisions are numbered with their own text
    const split = await js(`(() => { const t = document.querySelector('.gates').innerText; const nums = [...${card('q-000121')}.querySelectorAll('.q-num')].map(x => x.textContent); const leg = ${card('q-000120')}; return { whole: /as a whole/i.test(t), form: /came without a form/i.test(t), nums, legNums: leg.querySelectorAll('.q-num').length }; })()`);
    check('split requests: no "the request above, as a whole", no "came without a form"; 1. 2. 3. only where there are several', split && !split.whole && !split.form && split.nums.join() === '1.,2.,3.' && split.legNums === 0, split);
    // 8 + 9. Now: each running step in plain words; Sprint in one plain line, the rest under Details
    const now = await until(() => js(`(() => { const s = [...document.querySelectorAll('.now-step')].map(x => x.textContent); return s.length >= 3 ? { s, sprint: (document.querySelector('.sprint-line') || {}).textContent, more: !!document.querySelector('.sprint-chip details') } : null; })()`), 5000);
    check('Now: a running shell command reads "Searching company files" / "Running a test", never the command', now && now.s.includes('Searching company files') && now.s.includes('Running a test') && !now.s.some(x => /[`\/]|\bcd\b|grep/.test(x)), now);
    check('Now: Sprint is one plain line ("Sprint on … · N things done · $x of $y spent"), the ratios under Details', now && /^Sprint on .+ · \d+ things done · \$[\d.]+ of \$[\d.]+ spent$/.test(now.sprint || '') && !/wakes|\/item|proposals/.test(now.sprint) && now.more, now);
    await js(`(() => { [...document.querySelectorAll('.now-run')].find(r => /Searching company files/.test(r.textContent)).querySelector('button').click(); return 1; })()`);
    const watch = await until(() => js(`(() => { const r = document.querySelector('.now-watch .step-raw'); return r ? r.textContent : null; })()`), 4000);
    check('Watch shows the raw command (only there)', /grep -n/.test(watch || ''), watch);
    // 10. Recent activity: no tool-call markup, a plain summary and the command under Details
    const act = await until(() => js(`(() => { const t = document.querySelector('.timeline'); if (!t) return null; const li = [...t.children].find(x => /Teo ran/.test(x.textContent)); return { all: t.innerText, line: li && li.querySelector('.md') && li.querySelector('.md').innerText, det: li && li.querySelector('details') && li.querySelector('details').textContent }; })()`), 5000);
    check('Recent activity: tool-call markup never shows; a run that only ran a command says so in plain words, the command under Details', act && !/<parameter|<invoke|parameter name|cd \//.test(act.all) && /Restarted a service/.test(act.line || '') && /systemctl/.test(act.det || ''), act);
    // 11. AI usage card in plain words
    const use = await until(() => js(`(() => { const r = [...document.querySelectorAll('.usage-row')].map(x => x.innerText.replace(/\\s+/g, ' ')); return r.length ? r : null; })()`), 5000);
    check('AI usage: "78% of this week used; today\'s allowance 90%", "open because you lifted today\'s limit until …", "Station-wide limit $3 of $25 today"', use && use.some(x => /78% of this week used; today's allowance 90%/.test(x) && /Open because you lifted today's limit until (today |tomorrow )?\d\d:\d\d/.test(x)) && use.some(x => /Station-wide limit \$3 of \$25 today/.test(x)) && !use.some(x => /days' share|emergency|rail/.test(x)), use);
    // 14 + 15. Crew right now: the dispatcher's status words, display names title-cased
    const crewNow = await until(() => js(`(() => { const r = [...document.querySelectorAll('.crew-row')].map(x => x.innerText.replace(/\\s+/g, ' ')); return r.some(x => /Resting/.test(x)) ? r : null; })()`), 5000);
    check('Crew right now: "Nadia Farrell" (title-cased), "Resting" with its reason, Teo "Working on 2 things at once", no lane counts', crewNow && crewNow.some(x => /Nadia Farrell/.test(x) && /Resting/.test(x) && /Nothing new since its last run/.test(x)) && crewNow.some(x => /^T Teo/.test(x) && /Working on 2 things at once/.test(x)) && !crewNow.some(x => /lanes? running|of \d lanes?/.test(x)) && !crewNow.some(x => /Founder/.test(x) && /things at once/.test(x)), crewNow);
    // secret
    const sec = await js(`(() => { const g = ${card('q-000111')}; const i = g.querySelector('input.secret-input'); return i && { type: i.type, ac: i.getAttribute('autocomplete'), spell: i.getAttribute('spellcheck'), path: g.textContent.includes('secrets/example-exchange-key'), visiblePath: g.innerText.includes('secrets/'), plain: g.innerText.includes('Stored safely on this computer; never shown again'), replaceText: g.innerText.includes('Replace the saved key'), replace: !!g.querySelector('input[type=checkbox]'), w: Math.round(i.getBoundingClientRect().width), cw: Math.round(g.getBoundingClientRect().width) }; })()`);
    check('secret: a password input, autocomplete off, no spellcheck, a replace tick-box', sec && sec.type === 'password' && sec.ac === 'off' && sec.spell === 'false' && sec.replace, sec);
    check('secret: the field is full width; "Stored safely on this computer; never shown again" and "Replace the saved key"; secrets/<name> only under Details', sec && sec.w >= sec.cw * 0.8 && sec.plain && sec.replaceText && sec.path && !sec.visiblePath, sec);
    const msgFirst = await js(`(() => { const g = ${card('q-000111')}; const m = g.querySelector('.q-message'); const d = g.querySelector('details.q-details'); return { msg: m && m.innerText, closed: d && !d.open, detail: d && d.innerText, order: m && d && (m.compareDocumentPosition(d) & 4) }; })()`);
    check('the plain message comes first; the detail is collapsed under "More detail"', msgFirst.msg && /Could you make/.test(msgFirst.msg) && !/HTTP 401/.test(msgFirst.msg) && msgFirst.closed && /More detail/.test(msgFirst.detail) && msgFirst.order, msgFirst);
    await js(`(() => { const g = ${card('q-000111')}; const b = [...g.querySelectorAll('button')].find(x => x.textContent === 'Show'); b.click(); return 1; })()`);
    const shown = await js(`${card('q-000111')}.querySelector('input.secret-input').type`);
    await js(`(() => { const g = ${card('q-000111')}; [...g.querySelectorAll('button')].find(x => x.textContent === 'Hide').click(); return 1; })()`);
    check('secret: Show / Hide toggles the field', shown === 'text' && await js(`${card('q-000111')}.querySelector('input.secret-input').type`) === 'password');
    // legacy dense question: first two sentences, detail collapsed, a secure field offered with a suggested name
    const leg = await js(`(() => { const g = ${card('q-000120')}; const d = g.querySelector('details.q-details'); const key = g.querySelector('[data-part="key"]'); const dec = g.querySelector('[data-part="decision"]'); return { msg: g.querySelector('.q-message').innerText, detail: d && d.textContent, name: key && key.querySelector('input[aria-label^="File name"]').value, store: key && [...key.querySelectorAll('button')].some(b => b.textContent === 'Store'), decision: dec && [...dec.querySelectorAll('button')].map(b => b.textContent), actions: [...g.querySelectorAll('button')].map(b => b.textContent) }; })()`);
    check('legacy: the first two sentences are the message, the rest is detail', leg && /binding one/.test(leg.msg) && !/1 Hz/.test(leg.msg) && /1 Hz/.test(leg.detail), leg);
    check('legacy key question: reshaped into a decision (Approve/Decline) AND a key question with a suggested name — no single secret card, no closing "Store the key securely"', leg && leg.name === 'example-api-key' && leg.store && leg.decision.includes('Approve') && leg.decision.includes('Decline') && !leg.actions.includes('Store the key securely'), leg);
    // a key + approve form: Store keeps the card (Stored ✓ (replace)), Approve closes it, the answer has both
    await js(`(() => { const g = ${card('q-000122')}; const i = g.querySelector('input.secret-input'); i.value = ${JSON.stringify(SECRET)}; [...g.querySelectorAll('button')].find(x => x.textContent === 'Store').click(); return 1; })()`);
    const st1 = await until(() => js(`(() => { const g = ${card('q-000122')}; return g && g.querySelector('[data-stored]') ? { text: g.querySelector('.q-stored').innerText, input: !!g.querySelector('input.secret-input') && g.querySelector('input.secret-input').value } : null; })()`), 4000);
    check('key + approve form: Store keeps the card open and the field reads "Stored ✓ (replace)"', st1 && /Stored ✓/.test(st1.text) && /\(replace\)/.test(st1.text) && /secrets\/example-ping-key-2/.test(st1.text) && st1.input === '', st1);
    await js(`(() => { const g = ${card('q-000122')}; g.querySelector('input[type=checkbox]:not([id$="-replace"])').click(); [...g.querySelectorAll('button')].find(x => x.textContent === 'Approve').click(); return 1; })()`);
    check('key + approve form: Approve closes it', await until(() => js(`!${card('q-000122')}`), 5000));
    const ans122 = await js(`fetch('/api/questions/answered').then(r => r.json()).then(d => (d.answered.find(a => a.id === 'q-000122') || {}).answerDetail)`);
    check('key + approve form: the answer has both parts, the key only as {stored, chars}', ans122 && ans122.verdict === 'yes' && ans122.values.ok === true && ans122.values.pk.stored === 'secrets/example-ping-key-2' && ans122.values.pk.chars === SECRET.length && !JSON.stringify(ans122).includes(SECRET), ans122);
    // a request of 3 questions: answer 2, send them, the card stays with 1 left; answer it, it closes with all 3
    const btn = (id, part, label) => `[...${card(id)}.querySelector('[data-part="${part}"]').querySelectorAll('button')].find(x => x.textContent === '${label}')`;
    const r121 = await js(`(() => { const g = ${card('q-000121')}; return g && { parts: g.querySelectorAll('.q-part').length, progress: g.querySelector('[data-progress]').textContent }; })()`);
    check('a 3-question request renders three numbered sub-cards, 0 of 3 answered', r121 && r121.parts === 3 && /0 of 3 answered/.test(r121.progress), r121);
    await js(`(() => { ${btn('q-000121', 'trial', 'Approve')}.click(); ${card('q-000121')}.querySelector('[data-part="plan"] input[value="hobby"]').click(); ${btn('q-000121', 'plan', 'Choose')}.click(); return 1; })()`);
    const picked = await js(`(() => { const g = ${card('q-000121')}; return { progress: g.querySelector('[data-progress]').textContent, send: [...g.querySelectorAll('button')].map(b => b.textContent).find(t => /^Send( \\d|$)/.test(t)) }; })()`);
    check('picking answers: "2 picked, not sent yet" and "Send 2 answered"', /2 picked/.test(picked.progress) && picked.send === 'Send 2 answered', picked);
    await js(`(() => { [...${card('q-000121')}.querySelectorAll('button')].find(b => b.textContent === 'Send 2 answered').click(); return 1; })()`);
    const part2 = await until(() => js(`(() => { const g = ${card('q-000121')}; return g && /2 of 3 answered/.test(g.querySelector('[data-progress]').textContent) ? { answered: g.querySelectorAll('.q-part.answered').length, left: [...g.querySelectorAll('.q-part:not(.answered)')].map(x => x.dataset.part) } : null; })()`), 5000);
    check('partial send: the card stays with 1 left (2 of 3 answered)', part2 && part2.answered === 2 && part2.left.join() === 'post', part2);
    await js(`(() => { ${btn('q-000121', 'post', 'Decline')}.click(); [...${card('q-000121')}.querySelectorAll('button')].find(b => b.textContent === 'Send 1 answered').click(); return 1; })()`);
    check('the last answer closes the request', await until(() => js(`!${card('q-000121')}`), 5000));
    const ans121 = await js(`fetch('/api/questions/answered').then(r => r.json()).then(d => (d.answered.find(a => a.id === 'q-000121') || {}))`);
    check('the asker\'s record has all 3, each with its own result', ans121.answerDetail && ans121.answerDetail.verdict === 'parts' && ans121.answerDetail.parts.trial.verdict === 'yes' && ans121.answerDetail.parts.plan.values.choice === 'hobby' && ans121.answerDetail.parts.post.verdict === 'no' && /1\. .*: yes/.test(ans121.answer) && /3\. .*: no/.test(ans121.answer), ans121);
    // the legacy key question: store the key (stays), approve (closes), both in the answer
    await js(`(() => { const k = ${card('q-000120')}.querySelector('[data-part="key"]'); k.querySelector('.secret-input').value = ${JSON.stringify(SECRET)}; [...k.querySelectorAll('button')].find(x => x.textContent === 'Store').click(); return 1; })()`);
    const legStored = await until(() => js(`(() => { const g = ${card('q-000120')}; return g && g.querySelector('[data-part="key"].answered') ? g.querySelector('[data-progress]').textContent : null; })()`), 5000);
    check('legacy key question: storing the key answers only the key question; the card stays', legStored && /1 of 2 answered/.test(legStored), legStored);
    await js(`(() => { ${btn('q-000120', 'decision', 'Approve')}.click(); [...${card('q-000120')}.querySelectorAll('button')].find(b => b.textContent === 'Send 1 answered').click(); return 1; })()`);
    check('legacy key question: Approve closes it', await until(() => js(`!${card('q-000120')}`), 5000));
    const ans120 = await js(`fetch('/api/questions/answered').then(r => r.json()).then(d => (d.answered.find(a => a.id === 'q-000120') || {}).answerDetail)`);
    check('legacy key question: the answer has the approval and the key {stored, chars}', ans120 && ans120.parts.decision.verdict === 'yes' && ans120.parts.key.values.key.stored === 'secrets/example-api-key' && !JSON.stringify(ans120).includes(SECRET), ans120);
    // the recovery card: a request closed by a key alone comes back for the rest
    const fu = await js(`(() => { const g = ${card('q-000123')}; return g && { note: (g.querySelector('.q-followup') || {}).textContent, approves: [...g.querySelectorAll('.q-part:not(.answered)')].length, keyDone: !!g.querySelector('[data-part="key"].answered'), open: g.querySelector('details.q-details').open }; })()`);
    check('recovery: "You stored the key; the rest of this request still needs you", four decisions open, the key shown as done, the full text open', fu && /You stored the key; the rest of this request still needs you/.test(fu.note) && fu.approves === 4 && fu.keyDone && fu.open, fu);
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
    const ferr = await until(() => js(`${card('q-000118')}.querySelector('.err-line:not(.store-err)').textContent`), 4000);
    check('a form with a required field left empty says which one', /Not recorded: .*(Sign up|Sign-in email|tick it|fill it in)/.test(ferr || ''), ferr);
    // slider (the pacer's cutoff question): a range input with the live value in plain words, moved by the keyboard
    const sl0 = await js(`(() => { const g = ${card('q-000119')}; const r = [...g.querySelectorAll('input[type=range]')]; const o = g.querySelector('output.q-say'); return { n: r.length, v: r[0] && r[0].value, say: o && o.textContent, vt: r[0] && r[0].getAttribute('aria-valuetext'), label: !!g.querySelector('label[for="' + (r[0] && r[0].id) + '"]'), ends: g.innerText.includes('Spread evenly') && g.innerText.includes('Use it now'), buttons: [...g.querySelectorAll('button')].map(b => b.textContent) }; })()`);
    check('slider: two range inputs, the suggestion set, the value in plain words, labelled, end labels', sl0 && sl0.n === 2 && sl0.v === '95' && /up to 95% of this week's Claude/.test(sl0.say) && sl0.vt === sl0.say && sl0.label && sl0.ends, sl0);
    check('slider card: Set, Keep paused and Use another model meanwhile', sl0 && ['Set', 'Keep paused', 'Use another model meanwhile'].every(b => sl0.buttons.includes(b)), sl0 && sl0.buttons);
    await js(`(() => { ${card('q-000119')}.querySelector('input[type=range]').focus(); return 1; })()`);
    for (let i = 0; i < 3; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); }
    const sl1 = await js(`(() => { const g = ${card('q-000119')}; const r = g.querySelector('input[type=range]'); return { v: r.value, say: g.querySelector('output.q-say').textContent, focused: document.activeElement === r }; })()`);
    check('slider: the arrow keys move it and the words follow', sl1 && sl1.v === '92' && /up to 92% of this week's Claude/.test(sl1.say) && sl1.focused, sl1);
    await js(`(() => { [...${card('q-000119')}.querySelectorAll('button')].find(x => x.textContent === 'Set').click(); return 1; })()`);
    const slGone = await until(() => js(`!${card('q-000119')}`), 5000);
    const slAns = await until(() => js(`(() => { const d = [...document.querySelectorAll('details')].find(x => /Answered today/.test(x.textContent)); return d && d.textContent; })()`), 4000);
    check('slider: Set records the answer in the plain words', slGone && /up to 92% of this week's Claude/.test(slAns || ''), slAns);
    // Reply is long-form; a key pasted into it is stopped in the browser
    await js(`(() => { [...${card('q-000113')}.querySelectorAll('button')].find(x => x.textContent === 'Reply').click(); return 1; })()`);
    const rta = await until(() => js(`(() => { const t = ${card('q-000113')}.querySelector('textarea[aria-label^="Your reply"]'); return t ? Number(t.getAttribute('rows')) : 0; })()`), 3000);
    check('Reply opens a long-form textarea', rta >= 4, rta);
    // Discuss opens the asker's live chat with the question quoted
    const disc = await js(`[...${card('q-000116')}.querySelectorAll('a')].find(a => a.textContent === 'Discuss').getAttribute('href')`);
    check('Discuss opens the asker\'s live chat with the question quoted', /^#\/chat\/agent:agent\?draft=/.test(disc || '') && decodeURIComponent(disc.split('draft=')[1]).startsWith('> What is the most'), disc);
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
    // Settings › Models and subscriptions › Subscription cutoffs, the same sliders, saved through the recorded pacer path
    await js('location.hash = "/settings/models/cutoffs"; 1');
    const cut = await until(() => js(`(() => { const c = document.querySelector('#set-cutoffs [data-sub=claude]'); return c ? { ranges: c.querySelectorAll('input[type=range]').length, say: c.querySelector('output.q-say').textContent, text: c.innerText } : null; })()`), 8000);
    check('Settings › Models: Claude\'s weekly stop and daily pacing sliders, usage, reset and the seats affected', cut && cut.ranges === 2 && /up to 95% of this week's Claude/.test(cut.say) && /Used this week/.test(cut.text) && /Resets/.test(cut.text) && /Ingrid Halvorsen/.test(cut.text), cut);
    await js(`(() => { document.querySelector('[data-sub=claude] input[type=range]').focus(); return 1; })()`);
    for (let i = 0; i < 5; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 }); }
    await js(`(() => { [...document.querySelectorAll('[data-sub=claude] button')].find(b => b.textContent === 'Save').click(); return 1; })()`);
    const saved = await until(() => js(`(() => { const c = document.querySelector('[data-sub=claude]'); return c && /Last set by/.test(c.innerText) && c.querySelector('input[type=range]').value === '90' ? c.innerText : null; })()`), 5000);
    check('Settings › Models: Save records the new weekly stop (90%) and who set it', !!saved, await js(`(document.querySelector('[data-sub=claude]') || {}).innerText`));
    await shot('usage-cutoffs');
    check('no page exceptions', !errors.length, errors);
    console.log(fails ? 'TODAY QUESTIONS WALK: FAIL (' + fails + ')' : 'TODAY QUESTIONS WALK: PASS');
    ws.close(); done(fails ? 1 : 0);
  } catch (e) { console.error('today questions walk crashed: ' + e.stack); done(1); }
})();
