#!/usr/bin/env node
/* Chat is a rolling window, not an endless page: headless Chrome against the dev mock with a 120-message conversation.
 * Checks (desktop 1280x900): the page is no taller than the window, the message list scrolls on its own, the composer is
 * on screen, the newest message is in view on open, only the last 40 messages render until you scroll up, scrolling to
 * the top loads 40 more and keeps your place; + Colleague, its picker and the guest strip with ×. SKIP without Chrome. */
'use strict';
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP chat-window-walk: no Chrome'); process.exit(0); }
const mockPort = 9100 + Math.floor(Math.random() * 300), cdpPort = 9500 + Math.floor(Math.random() * 300);
const mock = spawn(process.execPath, [path.join(__dirname, '..', 'console', 'ui', 'dev', 'mock-api.js'), String(mockPort)], { env: Object.assign({}, process.env, { MOCK_CERTIFIED: '1', MOCK_NO_PUSH: '1', MOCK_CHAT_TURNS: '120' }), stdio: 'ignore' });
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatwin-'));
const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + udd, '--remote-debugging-port=' + cdpPort, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const done = code => { try { chrome.kill(); } catch (_) {} try { mock.kill(); } catch (_) {} try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(200); } }
(async () => {
  const ok = await waitFor(async () => (await fetch('http://127.0.0.1:' + mockPort + '/')).ok, 15000); if (!ok) { console.log('FAIL mock did not start'); return done(1); }
  const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json()).find(t => t.type === 'page'), 15000);
  if (!tab) { console.log('FAIL chrome did not start'); return done(1); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; } };
  const cmd = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => ((await cmd('Runtime.evaluate', { expression: expr, returnByValue: true })).result || {}).result?.value;
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + mockPort + '/#/chat/agent' });
  const ready = await waitFor(() => ev('(document.querySelectorAll(".chat-body .msg-them-wrap, .chat-body .msg-me").length > 30)'), 15000);
  let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info))); if (!cond) fails++; };
  t('the conversation renders', !!ready);
  const m = await ev('(()=>{const b=document.querySelector(".chat-body"),c=document.querySelector(".composer").getBoundingClientRect();return {pageH:document.documentElement.scrollHeight,winH:innerHeight,client:b.clientHeight,scroll:b.scrollHeight,atBottom:b.scrollHeight-b.scrollTop-b.clientHeight<80,composerBottom:c.bottom,items:b.children.length,earlier:!!b.querySelector(".chat-earlier")}})()');
  t('the page is no taller than the window (the chat does not grow the page)', m && m.pageH <= m.winH + 2, m);
  t('the message list scrolls on its own', m && m.scroll > m.client + 100, m);
  t('the composer is on screen', m && m.composerBottom <= m.winH + 1, m);
  t('opens at the newest message', m && m.atBottom, m);
  t('only the latest 40 messages render, with "Show earlier messages"', m && m.items === 41 && m.earlier, m);
  // walk 2: on a wide screen the conversation is one centred, fluid column (70% of the chat area, 680-1200 px): the owner's
  // bubbles at its right edge (at most 75% of it), the agent's text at its left, the composer the same width; the header
  // in plain words; names title-cased
  await cmd('Emulation.setDeviceMetricsOverride', { width: 2000, height: 900, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 300));
  const col = await ev('(()=>{const b=document.querySelector(".chat-body"),cs=getComputedStyle(b),br=b.getBoundingClientRect();const L=br.left+parseFloat(cs.paddingLeft),R=br.left+b.clientWidth-parseFloat(cs.paddingRight);const area=document.querySelector(".chat-scroll").getBoundingClientRect().width;const me=[...b.querySelectorAll(".msg-me")].map(x=>x.getBoundingClientRect());const them=[...b.querySelectorAll(".msg-them-wrap")].map(x=>x.getBoundingClientRect());const ta=document.querySelector(".composer textarea").getBoundingClientRect();return {area:Math.round(area),meMax:Math.max(...me.map(r=>r.width)),hscroll:document.documentElement.scrollWidth>innerWidth+1,w:Math.round(R-L),center:Math.round((L+R)/2-(br.left+br.right)/2),meRight:Math.max(...me.map(r=>Math.abs(r.right-R))),meMinLeft:Math.min(...me.map(r=>r.left))-L,themLeft:Math.max(...them.map(r=>Math.abs(r.left-L))),ta:{l:Math.round(ta.left-L),r:Math.round(ta.right-R)}}})()');
  const want = col && Math.min(col.area - 64, Math.min(1200, Math.max(680, 0.7 * col.area)));
  t('walk 2: a centred column of 70% of the chat area (680-1200 px) on a 2000 px screen, no horizontal scroll', col && Math.abs(col.w - want) <= 18 && col.w > 900 && Math.abs(col.center) <= 10 && !col.hscroll, Object.assign({ want }, col));
  t('walk 2: the owner\'s bubbles sit at the column\'s right edge (at most 75% of it), the agent\'s text at its left', col && col.meRight <= 2 && col.meMinLeft >= 0 && col.meMax <= 0.75 * col.w + 2 && col.themLeft <= 2, col);
  t('walk 2: the composer box starts at the column left edge, with Send beside it on the right', col && Math.abs(col.ta.l) <= 2 && col.ta.r <= 16 && col.ta.r >= -160, col);
  const head = await ev('(()=>({sub:document.querySelector(".chat-head .caption").textContent,btns:[...document.querySelectorAll(".chat-head button")].map(b=>b.textContent),label:document.querySelector(".composer label").textContent,list:[...document.querySelectorAll(".conv-list .thread .label")].map(x=>x.textContent)}))()');
  t('walk 2: the header says where it runs in plain words, no raw model id, no bare Reload', head && /Runs on Claude/.test(head.sub) && !/claude-cli|example-model|·\s*deepseek/.test(head.sub) && !head.btns.includes('Reload') && head.btns.includes('Refresh conversation'), head);
  t('walk 2: the composer label is just the shortcut hint', head && /^Shift\+Enter to send/.test(head.label) && !/Live chat/.test(head.label), head && head.label);
  t('walk 2: the conversation list title-cases names ("Nadia Farrell")', head && head.list.includes('Nadia Farrell') && !head.list.includes('Nadia farrell'), head && head.list);
  await cmd('Emulation.clearDeviceMetricsOverride', {});
  await new Promise(r => setTimeout(r, 300));
  const n = await ev('(()=>{const b=document.querySelector(".chat-body");const first=b.children[1];const top0=first.getBoundingClientRect().top;b.scrollTop=0;b.dispatchEvent(new Event("scroll"));return {items:b.children.length,shift:Math.abs(first.getBoundingClientRect().top-top0),scrollTop:b.scrollTop}})()');
  t('scrolling to the top loads 40 earlier messages', n && n.items === 81, n);
  t('and keeps the reader at the same message', n && n.scrollTop > 1000, n);
  // the owner channel (its own message list, not the live chat) is the same rolling window
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + mockPort + '/#/chat/owner' });
  await waitFor(() => ev('location.hash === "#/chat/owner" && document.querySelectorAll(".comms .chat > .chat-body > *").length > 30'), 15000);
  const o = await ev('(()=>{const b=document.querySelector(".comms .chat > .chat-body"),c=document.querySelector(".comms"),f=document.querySelector(".composer").getBoundingClientRect(),l=document.querySelector(".conv-list").getBoundingClientRect();return {pageH:document.documentElement.scrollHeight,winH:innerHeight,client:b.clientHeight,scroll:b.scrollHeight,commsTop:c.scrollTop,composerBottom:f.bottom,listTop:l.top,atBottom:b.scrollHeight-b.scrollTop-b.clientHeight<80}})()');
  t('owner channel: the page and the conversation list stay put', o && o.pageH <= o.winH + 2 && o.commsTop === 0 && o.listTop >= -1, o);
  t('owner channel: the messages scroll on their own, the composer is on screen, newest in view', o && o.scroll > o.client + 100 && o.composerBottom <= o.winH + 1 && o.atBottom, o);
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + mockPort + '/#/chat/agent' });
  await waitFor(() => ev('!!document.getElementById("msg") && document.querySelectorAll(".chat-body .msg-me").length > 10'), 15000);
  // keyboard: Enter adds a line, Shift+Enter sends; ? shows the shortcuts; g then t goes to Today
  const key = async (key, code, mods, text) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: mods || 0, text, windowsVirtualKeyCode: key === 'Enter' ? 13 : 0 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: mods || 0 }); };
  await ev('(()=>{const t=document.getElementById("msg");t.focus();t.value="hello";return 1})()');
  await key('Enter', 'Enter', 0, '\r');
  const afterEnter = await ev('document.getElementById("msg").value');
  t('Enter adds a new line in the message box', /^hello\n?$/.test(afterEnter) && afterEnter !== '' , afterEnter);
  const before = await ev('document.querySelectorAll(".chat-body .msg-me").length');
  await key('Enter', 'Enter', 8, '\r');   // 8 = Shift
  const sent = await waitFor(async () => (await ev('document.querySelectorAll(".chat-body .msg-me").length')) > before, 5000);
  t('Shift+Enter sends the message', !!sent, { before });
  await ev('document.activeElement.blur()');
  await key('?', 'Slash', 8, '?');
  t('? shows the keyboard shortcuts', await waitFor(() => ev('!!document.querySelector("dialog.keys-dialog[open]")'), 3000));
  await ev('document.querySelector("dialog.keys-dialog").close()');
  await key('g', 'KeyG', 0, 'g'); await key('t', 'KeyT', 0, 't');
  t('g then t goes to Today', await waitFor(() => ev('location.hash === "#/today"'), 3000));
  // colleagues: + Colleague and its picker (the crew but the host), the strip with × once one joins, back to 1:1 after ×
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + mockPort + '/#/chat/agent' });
  const pk = await waitFor(() => ev('(()=>{const p=document.getElementById("hud-pick"),b=document.querySelector(".hud-bar [data-act=colleague]");return p&&b?{opts:[...p.options].map(o=>o.value).filter(Boolean),btn:b.textContent}:null})()'), 15000);
  t('colleagues: a + Colleague button with a picker of the crew, the host left out', pk && pk.btn === '+ Colleague' && pk.opts.length > 1 && !pk.opts.includes('agent'), pk);
  const guest = pk && pk.opts[0];
  await ev('(()=>{const p=document.getElementById("hud-pick");p.value=' + JSON.stringify(guest) + ';document.querySelector(".hud-bar [data-act=colleague]").click();return 1})()');
  const strip = await waitFor(() => ev('(()=>{const g=document.querySelector(".hud-bar .hud-seat[data-seat=\'' + guest + '\']");const l=document.querySelector(".hud-bar .hud-seat.lead");return g&&l?{x:!!g.querySelector("[data-act=dismiss]"),hostX:!!l.querySelector("[data-act=dismiss]"),join:!!document.querySelector(".chat-body .hud-area [data-kind=join]"),ph:document.getElementById("msg").placeholder,hs:document.documentElement.scrollWidth>innerWidth+1}:null})()'), 8000);
  t('colleagues: once one joins, the strip shows the host (no ×) and the guest with ×, the join as a dim line, the composer writes to everyone', strip && strip.x && !strip.hostX && strip.join && /everyone in this chat/.test(strip.ph) && !strip.hs, strip);
  await ev('document.querySelector(".hud-bar .hud-seat [data-act=dismiss]").click()');
  const back = await waitFor(() => ev('(!document.querySelector(".hud-bar .hud-seat") && !document.querySelector(".chat-body .hud-area")) || null'), 8000);
  t('colleagues: × sends the guest back out, and the chat is 1:1 again', !!back);
  ws.close(); console.log(fails ? 'CHAT WINDOW WALK: FAIL' : 'CHAT WINDOW WALK: PASS'); done(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.message); done(1); });
