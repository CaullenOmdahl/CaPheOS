#!/usr/bin/env node
/* A live chat reply survives the console and the page (console/chat-runs.js, StarNet patch 0014), and tool calls a model
 * writes as text are shown for what they are (console/ui/js/leaked-tools.js). Runs the real console against
 * tests/mock-station.js on a temp copy of the company.
 *
 * Without Chrome:
 *   1. a chat run is started with the agent's tools on the wire (isTask:true) and detach:true (the station says "run-detach")
 *   2. GET /api/console/busy lists it while it streams
 *   3. the console process is killed mid-reply: the station run goes on; a new console process re-attaches (observer feed,
 *      resumed from its cursor), and GET /attach replays the whole reply, ending console.final complete with the full text
 *   4. scripts/restart-console.sh --when-idle waits while a chat streams and restarts once it is done; with --timeout it
 *      gives up (exit 1) and restarts nothing
 *   5. a station without "run-detach": the old way; a console restart cancels the run, and the reply is marked cut off,
 *      never final (console.final complete:false, and the transcript turn carries cut)
 * With Chrome (SKIP otherwise):
 *   6. a page reload during streaming re-attaches and shows the whole reply as finished
 *   7. a console restart under an open page: the page reconnects by itself and shows the whole reply
 *   8. leaked tool-call text (the 2026-11-17 capture, 31 <run_command> lines) renders as "Founder wrote 31 commands as text
 *      instead of running them" with Ask again and the raw text under a closed Details, with no markdown (no <em> from
 *      underscores in paths), live and after a reload; Ask again sends the follow-up
 *   9. the chat column is fluid at 1280, 1440, 1920 and 2560 px wide (70% of the chat area, 680-1200 px), no horizontal
 *      scroll, owner bubbles at most 75% of it, the composer the same width; phone width keeps its 16 px gutters.
 *      CHAT_SHOTS=<dir> saves a screenshot of each width there. */
'use strict';
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs'); const http = require('http');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-chat-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 600))); if (!cond) fails++; };
const kids = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-resilience-selftest-'));
function cleanup() { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
process.on('exit', cleanup);
async function waitFor(fn, ms, step) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(step || 150); } }
const freePort = () => new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// the company: a copy of the template with a model for the Founder (the station roster row), a budget, a station token
fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
for (const d of ['console', 'modules', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(tmp, d), { recursive: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), TOKEN + '\n', { mode: 0o600 });
fs.mkdirSync(path.join(tmp, '.starnet-data', 'workspaces'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.starnet-data', 'workspaces', 'agent.roster.json'), JSON.stringify({ agents: [{ agentId: 'agent', name: 'Founder', model: 'deepseek-flash', provider: 'deepseek' }] }));
fs.mkdirSync(path.join(tmp, 'company', 'work', 'finance'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'company', 'work', 'finance', 'dispatch-budget.json'), JSON.stringify({ dailyUsd: 5 }));
const FULL = 'Got it. I would start by reading the charter and every open handoff, then agree the first three priorities with my manager. ' +
  'I measure myself on handoffs closed with evidence, not on activity, and I say plainly when something is blocked. That is the whole plan, start to finish.';
const LEAK = fs.readFileSync(path.join(__dirname, 'fixtures', 'leaked-tool-calls.txt'), 'utf8');

function startMock(port) {
  const m = spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(port), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] });
  kids.add(m); return m;
}
let consoleErr = '';
function startConsole(port, stationPort) {
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + stationPort, CHAT_RUN_QUIET_MS: '3000' });
  delete env.CONSOLE_PORT;
  const c = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(port), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stderr.on('data', d => { consoleErr += d; });
  kids.add(c); c.on('exit', () => kids.delete(c));
  return new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(c); }); c.on('exit', code => reject(new Error('console exited ' + code + ': ' + consoleErr))); setTimeout(() => reject(new Error('console did not start: ' + consoleErr)), 15000); });
}
const killed = c => new Promise(r => { if (c.exitCode !== null) return r(); c.on('exit', () => r()); c.kill('SIGKILL'); });

(async () => {
  const sp = await freePort(), cp = await freePort();
  const mock = startMock(sp);
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  const S = async () => (await fetch('http://127.0.0.1:' + sp + '/__state', { headers: { 'x-starnet-token': TOKEN } })).json();
  const caps = async list => fetch('http://127.0.0.1:' + sp + '/__caps', { method: 'POST', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ caps: list }) });
  let con = await startConsole(cp, sp);
  const ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const C = 'http://127.0.0.1:' + cp;
  const api = async (p, o) => { const r = await fetch(C + p, Object.assign({ headers: { 'x-console-token': ctoken, 'content-type': 'application/json' } }, o || {})); return r.json(); };
  // a streaming request: lines as they come; stop() drops the connection
  function streamLines(method, p, body) {
    const out = { lines: [], done: false, req: null };
    out.p = new Promise(resolve => {
      const data = body ? JSON.stringify(body) : null;
      out.req = http.request({ host: '127.0.0.1', port: cp, path: p, method, headers: Object.assign({ 'x-console-token': ctoken }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let b = ''; res.setEncoding('utf8');
        res.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (l.trim()) { try { out.lines.push(JSON.parse(l)); } catch (_) {} } } });
        res.on('end', () => { out.done = true; resolve(out); }); res.on('error', () => { out.done = true; resolve(out); }); res.on('close', () => { out.done = true; resolve(out); });
      });
      out.req.on('error', () => { out.done = true; resolve(out); });
      if (data) out.req.write(data); out.req.end();
    });
    return out;
  }
  const tokens = ls => ls.filter(l => l.name === 'agent.token').map(l => l.payload.delta).join('');

  /* 1-3: a console restart mid-reply */
  const s1 = streamLines('POST', '/api/chat/agent/send', { text: '[slow] what is the plan?' });
  const att = await waitFor(() => s1.lines.find(l => l.name === 'console.attached'), 10000);
  t('1. the send streams console.attached {runId}', !!att, { lines: s1.lines.slice(0, 5), err: consoleErr.slice(-400) });
  const runId = att && att.payload.runId;
  await waitFor(() => s1.lines.filter(l => l.name === 'agent.token').length >= 4, 10000);
  const st1 = await S();
  t('1. the chat run is started with its tools on the wire (isTask:true) and detached (detach:true)', st1.lastRunBody && st1.lastRunBody.isTask === true && st1.lastRunBody.detach === true, st1.lastRunBody);
  const busy1 = await api('/api/console/busy');
  t('2. GET /api/console/busy lists the chat in flight', busy1.ok && busy1.chats.includes(runId), busy1);
  const before = tokens(s1.lines);
  await killed(con);
  await sleep(600);
  const st2 = await S();
  t('3. the console died mid-reply and the station run goes on (not cancelled by the disconnect)', st2.live.some(r => r.runId === runId) && !st2.cancelledByDisconnect, { live: st2.live, c: st2.cancelledByDisconnect });
  con = await startConsole(cp, sp);
  const info = await api('/api/chat/agent');
  t('3. after the restart GET /api/chat/<seat> names the run in flight', info.inflight && info.inflight.runId === runId, info.inflight);
  t('3. ...and leaves its unfinished turns out of the conversation', !(info.turns || []).some(x => /\[slow\] what is the plan/.test(x.content)), (info.turns || []).slice(-2));
  const a1 = streamLines('GET', '/api/chat/agent/attach?runId=' + encodeURIComponent(runId) + '&from=0');
  await waitFor(() => a1.done, 20000);
  const fin = a1.lines.find(l => l.name === 'console.final');
  t('3. re-attached: the journal replays from the start (the opening lines, then the reply)', a1.lines[0] && a1.lines[0].name === 'console.user' && tokens(a1.lines).startsWith(before), a1.lines.slice(0, 3));
  t('3. the whole reply streamed through the restart (the observer feed resumed from its cursor, nothing lost)', tokens(a1.lines) === FULL, tokens(a1.lines));
  t('3. it ends console.final complete, with the full text, then console.end', fin && fin.payload.complete === true && fin.payload.text === FULL && a1.lines[a1.lines.length - 1].name === 'console.end', fin);
  const busy2 = await api('/api/console/busy');
  t('3. busy is empty once the reply is done', busy2.ok && busy2.chats.length === 0, busy2);

  /* 4: the restart script waits for an idle console */
  const marker = path.join(tmp, 'restarted.marker');
  const env4 = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, CONSOLE_URL: C, CONSOLE_RESTART_CMD: 'touch ' + JSON.stringify(marker) });
  const s4 = streamLines('POST', '/api/chat/agent/send', { text: '[slow] once more' });
  await waitFor(() => s4.lines.find(l => l.name === 'agent.token'), 10000);
  const quick = spawnSync('bash', [path.join(tmp, 'scripts', 'restart-console.sh'), '--when-idle', '--timeout', '1'], { env: env4, encoding: 'utf8' });
  t('4. restart-console.sh --when-idle --timeout 1 while a chat streams: exit 1, nothing restarted', quick.status === 1 && !fs.existsSync(marker), { status: quick.status, out: quick.stdout + quick.stderr });
  const now = spawnSync('bash', [path.join(tmp, 'scripts', 'restart-console.sh')], { env: env4, encoding: 'utf8' });
  t('4. without --when-idle it refuses while busy (exit 1)', now.status === 1 && !fs.existsSync(marker), { status: now.status, out: now.stdout + now.stderr });
  const t0 = Date.now();
  const waiter = spawn('bash', [path.join(tmp, 'scripts', 'restart-console.sh'), '--when-idle', '--timeout', '60'], { env: env4, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(waiter);
  let wout = ''; waiter.stdout.on('data', d => { wout += d; }); waiter.stderr.on('data', d => { wout += d; });
  await sleep(1500);
  t('4. --when-idle is waiting while the reply streams', !fs.existsSync(marker) && waiter.exitCode === null, wout);
  const code4 = await new Promise(r => waiter.on('exit', r));
  t('4. ...and restarts once no chat is streaming (exit 0)', code4 === 0 && fs.existsSync(marker) && s4.done !== undefined && Date.now() - t0 > 2000 && /waiting for the chat in flight/.test(wout), { code4, wout });
  await waitFor(() => s4.done, 20000);

  /* 5: an older station (no run-detach): a console restart cancels the run, and the reply is never shown as final */
  await caps([]);
  await sleep(100);
  // the capability is cached for a minute in the running console: restart it to see the station as it is now
  await killed(con); con = await startConsole(cp, sp);
  const s5 = streamLines('POST', '/api/chat/agent/send', { text: '[slow] old station' });
  const att5 = await waitFor(() => s5.lines.find(l => l.name === 'console.attached'), 10000);
  await waitFor(() => s5.lines.filter(l => l.name === 'agent.token').length >= 3, 10000);
  t('5. an older station: the run is not detached', (await S()).lastRunBody.detach !== true, (await S()).lastRunBody);
  await killed(con);
  await waitFor(async () => (await S()).cancelledByDisconnect >= 1, 5000);
  con = await startConsole(cp, sp);
  const rid5 = att5 && att5.payload.runId;
  const a5 = streamLines('GET', '/api/chat/agent/attach?runId=' + encodeURIComponent(rid5) + '&from=0');
  await waitFor(() => a5.done, 20000);
  const fin5 = a5.lines.find(l => l.name === 'console.final');
  t('5. the cut-off reply ends console.final complete:false (the page says it was cut off)', fin5 && fin5.payload.complete === false, fin5 || a5.lines.slice(-3));
  const info5 = await api('/api/chat/agent');
  const cutTurn = (info5.turns || []).filter(x => x.role === 'assistant').pop();
  t('5. the transcript turn the station kept is marked cut', cutTurn && cutTurn.cut === 'cancelled', cutTurn);
  await caps(['run-detach']); await killed(con); con = await startConsole(cp, sp);

  /* 6-9: the page, in headless Chrome */
  const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
  if (!bin) { console.log('SKIP chat-resilience-walk page checks: no Chrome'); console.log(fails ? 'CHAT RESILIENCE WALK: FAIL' : 'CHAT RESILIENCE WALK: PASS'); process.exit(fails ? 1 : 0); }
  const cdpPort = await freePort();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'chatres-'));
  const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + udd, '--remote-debugging-port=' + cdpPort, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' }); kids.add(chrome);
  process.on('exit', () => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} });
  const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json()).find(x => x.type === 'page'), 15000);
  if (!tab) { t('chrome started', false); process.exit(1); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; ws.onmessage = m => { const j = JSON.parse(m.data); if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; } };
  const cmd = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => ((await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result || {}).result?.value;
  await cmd('Page.navigate', { url: C + '/login' });   // the login form (a token never goes in an address)
  await waitFor(() => ev('(()=>{const i=document.getElementById("secret");if(!i)return 0;i.value=' + JSON.stringify(ctoken) + ';i.form.submit();return 1})()'), 10000);
  await sleep(800);
  await cmd('Page.navigate', { url: C + '/#/chat/agent' });
  await waitFor(() => ev('!!document.getElementById("msg")'), 15000);
  const sendText = async txt => ev('(()=>{const t=document.getElementById("msg");t.value=' + JSON.stringify(txt) + ';t.closest("form").requestSubmit();return 1})()');
  const lastCard = 'document.querySelector(".chat-body").lastElementChild';
  const cardState = () => ev('(()=>{const c=' + lastCard + ';return c?{live:c.classList.contains("live"),text:(c.querySelector(".msg-them")||{}).textContent||"",cut:!!c.querySelector(".chat-cut"),notes:[...c.querySelectorAll(".chat-note")].map(x=>x.textContent),meta:(c.querySelector(".msg-meta")||{}).textContent||""}:null})()');

  // 6. reload during streaming
  await sendText('[slow] reload test');
  await waitFor(async () => { const c = await cardState(); return c && c.live && c.text.length > 20; }, 10000);
  await cmd('Page.reload', {});
  await sleep(800);
  const re6 = await waitFor(async () => { const c = await cardState(); return c && c.live ? c : null; }, 8000, 100);
  t('6. after a reload during streaming the reply is live again on the page', !!re6, await cardState());
  const end6 = await waitFor(async () => { const c = await cardState(); return c && !c.live ? c : null; }, 25000);
  t('6. ...and ends as the whole reply, finished, not cut', end6 && end6.text.trim() === FULL && !end6.cut && /Founder/.test(end6.meta), end6);
  const userOnce = await ev('[...document.querySelectorAll(".chat-body .msg-me")].filter(x=>/reload test/.test(x.textContent)).length');
  t('6. the owner\'s message shows once', userOnce === 1, userOnce);

  // 7. the console restarts under an open page
  await sendText('[slow] restart under the page');
  await waitFor(async () => { const c = await cardState(); return c && c.live && c.text.length > 20; }, 10000);
  await killed(con);
  const rec = await waitFor(async () => { const c = await cardState(); return c && c.live && c.notes.some(n => /Reconnecting/.test(n)) ? c : null; }, 5000, 100);
  t('7. the page says it is reconnecting (the reply is not shown as finished)', !!rec, await cardState());
  con = await startConsole(cp, sp);
  const end7 = await waitFor(async () => { const c = await cardState(); return c && !c.live ? c : null; }, 30000);
  t('7. it reconnects by itself and shows the whole reply, finished', end7 && end7.text.trim() === FULL && !end7.cut && !end7.notes.some(n => /Reconnecting|lost/.test(n)), end7);

  // 8. leaked tool-call text
  await sendText('[leak] guide me through it');
  const leakCheck = async () => ev('(()=>{const c=' + lastCard + ';const n=c.querySelector(".leaked-tools-note");const d=c.querySelector("details.leaked-raw");return {live:c.classList.contains("live"),note:n?n.textContent:"",ask:[...c.querySelectorAll("button")].some(b=>b.textContent==="Ask again"),detailsOpen:d?d.open:null,raw:d?d.querySelector("pre").textContent:"",em:c.querySelectorAll("em").length,mdP:c.querySelectorAll(".md-p, .md-code").length,prose:(c.querySelector(".leaked-prose")||{}).textContent||""}})()');
  const lk = await waitFor(async () => { const c = await leakCheck(); return c && !c.live ? c : null; }, 30000);
  t('8. leaked tool calls: "Founder wrote 31 commands as text instead of running them"', lk && /Founder wrote 31 commands as text instead of running them/.test(lk.note), lk && lk.note);
  t('8. ...with Ask again, and the raw text under a closed Details', lk && lk.ask && lk.detailsOpen === false && lk.raw === LEAK && /<run_command>cd \/home\/owner/.test(lk.raw), lk && { ask: lk.ask, open: lk.detailsOpen, raw: lk.raw.slice(0, 80) });
  t('8. ...never as markdown: no <em> from the underscores in the paths, no markdown nodes, the prose as plain text', lk && lk.em === 0 && lk.mdP === 0 && /Let me look at my own record/.test(lk.prose) && !/<run_command>/.test(lk.prose), lk && { em: lk.em, mdP: lk.mdP, prose: lk.prose.slice(0, 120) });
  await cmd('Page.reload', {});
  await waitFor(() => ev('!!document.querySelector(".chat-body .leaked-tools-note")'), 10000);
  const lk2 = await leakCheck();
  t('8. after a reload the transcript turn renders the same way', lk2 && /wrote 31 commands as text/.test(lk2.note) && lk2.ask && lk2.em === 0 && lk2.detailsOpen === false, lk2 && { note: lk2.note, em: lk2.em });
  const nMe = await ev('document.querySelectorAll(".chat-body .msg-me").length');
  await ev('[...' + lastCard + '.querySelectorAll("button")].find(b=>b.textContent==="Ask again").click()');
  const asked = await waitFor(async () => (await ev('[...document.querySelectorAll(".chat-body .msg-me")].map(x=>x.textContent).pop()||""')).match(/Run them with your tools/) && (await ev('document.querySelectorAll(".chat-body .msg-me").length')) > nMe, 8000);
  t('8. Ask again sends the follow-up asking for the commands to be run with tools', !!asked);
  await waitFor(async () => { const c = await cardState(); return c && !c.live; }, 20000);
  // a markdown reply with underscores in a path keeps them as text (md.js: _em_ only between non-word characters)
  const mdu = await ev('import("/js/md.js").then(m=>{const d=document.createElement("div");d.append(...m.md("see company/work/handoffs/to_founder.md and my_file_name, and _this_ is em"));return {em:d.querySelectorAll("em").length,text:d.textContent}})');
  t('8. md.js: underscores inside paths and names are not italics; _word_ still is', mdu && mdu.em === 1 && /to_founder\.md and my_file_name/.test(mdu.text), mdu);

  // 9. the fluid column
  const shots = process.env.CHAT_SHOTS || '';
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const measure = () => ev('(()=>{const b=document.querySelector(".chat-body"),cs=getComputedStyle(b),br=b.getBoundingClientRect();const L=br.left+parseFloat(cs.paddingLeft),R=br.left+b.clientWidth-parseFloat(cs.paddingRight);const me=[...b.querySelectorAll(".msg-me")].map(x=>x.getBoundingClientRect());const them=[...b.querySelectorAll(".msg-them-wrap")].map(x=>x.getBoundingClientRect());const ta=document.querySelector(".composer textarea").getBoundingClientRect();const area=document.querySelector(".chat-scroll").getBoundingClientRect().width;const p=b.querySelector(".msg-them-wrap .md > p, .msg-them-wrap .md > .md-p");return {area:Math.round(area),w:Math.round(R-L),gutter:parseFloat(cs.paddingLeft),center:Math.round((L+R)/2-(br.left+br.right)/2),meMax:Math.max(0,...me.map(r=>r.width)),meRight:Math.max(0,...me.map(r=>Math.abs(r.right-R))),themLeft:Math.max(0,...them.map(r=>Math.abs(r.left-L))),themMax:Math.max(0,...them.map(r=>r.width)),pW:p?p.getBoundingClientRect().width:0,ch:parseFloat(getComputedStyle(p||b).fontSize)*0.5,hscroll:document.documentElement.scrollWidth>innerWidth+1,ta:{l:Math.round(ta.left-L),r:Math.round(ta.right-R)}}})()');
  for (const W of [1280, 1440, 1920, 2560]) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: 1000, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    const m = await measure();
    const want = Math.min(m.area - 64, Math.min(1200, Math.max(680, 0.7 * m.area)));
    t('9. ' + W + ' px: the column is 70% of the chat area within 680-1200 px (' + m.w + ' of ' + m.area + '), centred, no horizontal scroll',
      m && Math.abs(m.w - want) <= 18 && Math.abs(m.center) <= 10 && !m.hscroll, m);
    t('9. ' + W + ' px: owner bubbles at most 75% of the column at its right edge; agent text from its left edge', m && m.meMax <= 0.75 * m.w + 2 && m.meRight <= 2 && m.themLeft <= 2, m);
    t('9. ' + W + ' px: the composer box starts at the column\'s left edge, with Send beside it on the right', m && Math.abs(m.ta.l) <= 2 && m.ta.r <= 16 && m.ta.r >= -160, m && m.ta);
    if (shots) { const s = await cmd('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(shots, 'chat-' + W + '.png'), Buffer.from(s.result.data, 'base64')); }
  }
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const ph = await measure();
  t('9. phone (390 px): 16 px gutters, no horizontal scroll', ph && Math.abs(ph.gutter - 16) <= 1 && !ph.hscroll, ph);
  if (shots) { const s = await cmd('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(path.join(shots, 'chat-390.png'), Buffer.from(s.result.data, 'base64')); }
  ws.close();
  console.log(fails ? 'CHAT RESILIENCE WALK: FAIL' : 'CHAT RESILIENCE WALK: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
