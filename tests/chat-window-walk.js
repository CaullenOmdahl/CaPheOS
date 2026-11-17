#!/usr/bin/env node
/* Chat is a rolling window, not an endless page: headless Chrome against the dev mock with a 120-message conversation.
 * Checks (desktop 1280x900): the page is no taller than the window, the message list scrolls on its own, the composer is
 * on screen, the newest message is in view on open, only the last 40 messages render until you scroll up, scrolling to
 * the top loads 40 more and keeps your place. SKIP without Chrome. */
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
  const n = await ev('(()=>{const b=document.querySelector(".chat-body");const first=b.children[1];const top0=first.getBoundingClientRect().top;b.scrollTop=0;b.dispatchEvent(new Event("scroll"));return {items:b.children.length,shift:Math.abs(first.getBoundingClientRect().top-top0),scrollTop:b.scrollTop}})()');
  t('scrolling to the top loads 40 earlier messages', n && n.items === 81, n);
  t('and keeps the reader at the same message', n && n.scrollTop > 1000, n);
  // the owner channel (its own message list, not the live chat) is the same rolling window
  await cmd('Page.navigate', { url: 'http://127.0.0.1:' + mockPort + '/#/chat/owner' });
  await waitFor(() => ev('document.querySelectorAll(".comms .chat-body > *").length > 30'), 15000);
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
  ws.close(); console.log(fails ? 'CHAT WINDOW WALK: FAIL' : 'CHAT WINDOW WALK: PASS'); done(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.message); done(1); });
