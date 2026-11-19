#!/usr/bin/env node
/* Chat › Meeting in headless Chrome, against the real console and tests/mock-station.js (scripted replies):
 *   - every control calls its API action (the page's fetches are recorded): More, Tools / talk only, the rounds stepper,
 *     Observe / Take part, the crown, No leader, ×, + Add, New meeting, Shift+Enter, Round, Raise hand, Esc (a hand only:
 *     Esc again never stops anyone), Continue, Stop after this turn, How hard they think (Max asks first), Model
 *   - as at the table: no Next button by default; the turn in flight streams; one colour per person; passes, asks,
 *     joins and hands as dim lines in order; tool steps as "· Name: …" lines; the END line
 *   - @name autocomplete in the composer
 *   - the speaking-now line, the cost line, Open minutes
 *   - a live update does not close the roster dropdown (held: events.js pendingWhileEditing), while the controls still
 *     follow; the strip redraws once focus leaves
 *   - phone width: no horizontal scroll
 * SKIP without Chrome. */
'use strict';
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
if (!bin) { console.log('SKIP meeting-ui-walk: no Chrome'); process.exit(0); }
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-meeting-ui-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + String(JSON.stringify(info)).slice(0, 900))); if (!cond) fails++; };
const kids = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-ui-selftest-'));
const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-ui-chrome-'));
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } for (const d of [tmp, udd]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });
async function waitFor(fn, ms, step) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(step || 150); } }
const freePort = () => new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = rel => { try { return fs.readFileSync(path.join(tmp, rel), 'utf8'); } catch (_) { return ''; } };
const W = (rel, v) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };

fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
for (const d of ['console', 'modules', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(tmp, d), { recursive: true });
fs.rmSync(path.join(tmp, 'company', 'state', 'meetings'), { recursive: true, force: true });
W('secrets/station-token', TOKEN + '\n'); fs.chmodSync(path.join(tmp, 'secrets', 'station-token'), 0o600);
const loops = JSON.parse(R('company/tools/loops.json'));
loops.agents.cfo = { name: 'Sharon', title: 'CFO', manager: 'agent' };
loops.agents.sec = { name: 'Phil', title: 'IT Admin and Security', manager: 'agent' };
loops.agents.hr = { name: 'Rachel', title: 'Hiring Manager', manager: 'agent' };
W('company/tools/loops.json', loops);
W('.starnet-data/workspaces/agent.roster.json', { agents: ['agent', 'cfo', 'sec', 'hr'].map(id => ({ agentId: id, name: loops.agents[id].name, model: 'claude-sonnet-5-5', provider: 'claude-cli' })) });
W('company/work/finance/dispatch-budget.json', { dailyUsd: 5 });
W('company/state/meetings/seats.json', { seats: ['agent', 'cfo', 'sec'], leader: 'agent', talkOnly: false, observeRounds: 6 });

(async () => {
  const sp = await freePort(), cp = await freePort();
  const m = spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.add(m);
  const st = (p, b) => fetch('http://127.0.0.1:' + sp + p, { method: b ? 'POST' : 'GET', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  let err = '';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp }); delete env.CONSOLE_PORT;
  const c = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(c);
  c.stderr.on('data', d => { err += d; });
  await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
  const ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const C = 'http://127.0.0.1:' + cp;
  const api = async (p, b) => { const r = await fetch(C + '/api' + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-console-token': ctoken }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };

  const cdpPort = await freePort();
  const chrome = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + udd, '--remote-debugging-port=' + cdpPort, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' }); kids.add(chrome);
  const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json()).find(x => x.type === 'page'), 15000);
  if (!tab) { t('chrome started', false); process.exit(1); }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = {}; ws.onmessage = mm => { const j = JSON.parse(mm.data); if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; } };
  const cmd = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => ((await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result || {}).result?.value;
  const key = async (k, code, mods, text, vk) => { await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mods || 0, text, windowsVirtualKeyCode: vk || 0 }); await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods || 0, windowsVirtualKeyCode: vk || 0 }); };
  await cmd('Page.navigate', { url: C + '/login' });
  await waitFor(() => ev('(()=>{const i=document.getElementById("secret");if(!i)return 0;i.value=' + JSON.stringify(ctoken) + ';i.form.submit();return 1})()'), 10000);
  await sleep(800);
  await cmd('Page.navigate', { url: C + '/#/chat/meeting' });
  t('the meeting opens with the seat strip in speaking order', await waitFor(() => ev('[...document.querySelectorAll(".mtg-seat")].map(x=>x.dataset.seat).join()==="agent,cfo,sec"'), 15000), await ev('document.querySelector("main")&&document.querySelector("main").innerText.slice(0,400)'));
  t('the conversation list has Meeting, and the header switches between Group chat and Meeting', await ev('!!document.querySelector(".conv-list a[href=\\"#/chat/meeting\\"]") && [...document.querySelectorAll(".mtg-mode a")].map(a=>a.textContent).join()==="Group chat,Meeting"'));
  await sleep(400);
  // record every POST the page makes
  await ev('(()=>{window.__posts=[];const f=window.fetch;window.fetch=function(u,o){try{if(o&&o.method==="POST")window.__posts.push({path:String(u).replace(/^.*\\/api/,""),body:o.body?JSON.parse(o.body):null})}catch(_){}return f.apply(this,arguments)};return 1})()');
  const lastPost = () => ev('window.__posts[window.__posts.length-1]||null');
  const click = sel => ev('(()=>{const b=document.querySelector(' + JSON.stringify(sel) + ');if(!b||b.disabled)return false;b.click();return true})()');
  async function maps(name, sel, want) {
    const n = await ev('window.__posts.length');
    const ok = await click(sel);
    const p = await waitFor(async () => (await ev('window.__posts.length')) > n ? lastPost() : null, 4000);
    t('control → action: ' + name, ok && p && p.path === want.path && JSON.stringify(p.body) === JSON.stringify(want.body), { ok, p, want });
    await sleep(350);
  }
  t('tools are on by default, as at the table', /tools on/.test(await ev('document.querySelector(".mtg-sub").textContent')) && !/talk only/.test(await ev('document.querySelector(".mtg-sub").textContent')));
  t('the controls in view are the table\'s: Round, Observe, More; no Next button by default', await ev('(()=>{const a=[...document.querySelectorAll(".mtg-btns [data-act]")].map(x=>x.dataset.act);return a.includes("round")&&a.includes("observe")&&!a.includes("next")&&!a.includes("register")&&!a.includes("pause")&&!!document.querySelector(".mtg-more > summary[data-act=more]")&&!document.querySelector(".mtg-more").open})()'), await ev('[...document.querySelectorAll(".mtg-btns [data-act]")].map(x=>x.dataset.act).join()'));
  await ev('document.querySelector(".mtg-more > summary").click()');
  t('More opens the rest: tools, register, minutes, agenda, pace', await waitFor(() => ev('(()=>{const d=document.querySelector(".mtg-more");return d.open&&["talk-only","register","minutes"].every(k=>!!d.querySelector("[data-act="+k+"]"))&&!!d.querySelector("#mtg-speed")&&!!d.querySelector("#mtg-item-new")})()'), 3000));
  t('the Tools button says it is on (aria-pressed on it, not on the thinking controls)', await ev('(()=>{const d=document.querySelector(".mtg-more");const k=d.querySelector("#mtg-think");return d.querySelector("[data-act=talk-only]").getAttribute("aria-pressed")==="true"&&!!k&&!k.closest("[aria-pressed]")&&!d.querySelector("#mtg-pin").closest("[aria-pressed]")})()'));
  await maps('Tools off (talk only) for the meeting', '[data-act="talk-only"]', { path: '/meeting/talkonly', body: { on: true } });
  t('the head says talk only', await waitFor(() => ev('/talk only/.test(document.querySelector(".mtg-sub").textContent)'), 3000));
  t('the Tools button now says it is off', await waitFor(() => ev('document.querySelector(".mtg-more [data-act=talk-only]").getAttribute("aria-pressed")==="false"'), 3000));
  await maps('Tools on again', '[data-act="talk-only"]', { path: '/meeting/talkonly', body: { on: false } });
  t('More stays open across live updates', await ev('document.querySelector(".mtg-more").open'));
  await ev('(()=>{const i=document.getElementById("mtg-item-new");i.value="Check the books";return 1})()');
  await maps('Add agenda item', '.mtg-agenda .mtg-add .btn', { path: '/meeting/agenda', body: { op: 'add', title: 'Check the books' } });
  await waitFor(() => ev('!!document.querySelector("[data-act=item-tools]")'), 3000);
  t('a new item follows the meeting: tools on', await ev('document.querySelector("[data-act=item-tools]").getAttribute("aria-pressed")==="true"'));
  await maps('Talk only for an item', '[data-act="item-tools"]', { path: '/meeting/agenda', body: { op: 'tools', id: 'a1', on: false } });
  t('the item shows talk only', await waitFor(() => ev('document.querySelector("[data-act=item-tools]").getAttribute("aria-pressed")==="false"'), 3000));
  await maps('Tools on for the item again', '[data-act="item-tools"]', { path: '/meeting/agenda', body: { op: 'tools', id: 'a1', on: true } });
  await maps('More rounds (stepper)', '[data-act="rounds-up"]', { path: '/meeting/observe', body: { on: false, rounds: 7 } });
  await maps('Observe', '[data-act="observe"]', { path: '/meeting/observe', body: { on: true, rounds: 7 } });
  await maps('Take part', '[data-act="take-part"]', { path: '/meeting/observe', body: { on: false } });
  await maps('the crown (make leader)', '.mtg-seat[data-seat="cfo"] [data-act="lead"]', { path: '/meeting/lead', body: { seat: 'cfo' } });
  t('the new leader is first in the strip', await waitFor(() => ev('document.querySelector(".mtg-seat").dataset.seat==="cfo"'), 3000));
  await maps('No leader', '[data-act="no-leader"]', { path: '/meeting/lead', body: { seat: null } });
  await maps('the crown again', '.mtg-seat[data-seat="agent"] [data-act="lead"]', { path: '/meeting/lead', body: { seat: 'agent' } });
  await maps('× (remove)', '.mtg-seat[data-seat="sec"] [data-act="remove"]', { path: '/meeting/seats', body: { remove: ['sec'] } });
  await waitFor(() => ev('!document.querySelector(".mtg-seat[data-seat=sec]")'), 3000);
  await ev('(()=>{const s=document.getElementById("mtg-pick");s.value="sec";return 1})()');
  await maps('+ Add (roster picker)', '[data-act="add"]', { path: '/meeting/seats', body: { add: ['sec'] } });
  await maps('New meeting (with its type)', '[data-act="new"]', { path: '/meeting/new', body: { type: 'decision' } });
  // the model on hover or tap
  t('the model shows on hover (title) and on tap', await ev('(()=>{const a=document.querySelector(".mtg-seat[data-seat=cfo] .mtg-av");a.click();const m=document.querySelector(".mtg-seat[data-seat=cfo] .mtg-model");return /Claude Sonnet/.test(a.title)&&!m.hidden&&/Claude Sonnet/.test(m.textContent)})()'));

  // @name autocomplete, then Shift+Enter sends
  await ev('(()=>{const t=document.getElementById("msg");t.focus();t.value="";return 1})()');
  await cmd('Input.insertText', { text: '@sh' });
  const acShown = await waitFor(() => ev('(()=>{const a=document.getElementById("mtg-ac");return a&&!a.hidden?[...a.querySelectorAll("li")].map(x=>x.textContent).join("|"):null})()'), 3000);
  t('@name autocomplete suggests the seated person', acShown && /@Sharon/.test(acShown), acShown);
  await key('Tab', 'Tab', 0, '', 9);
  t('Tab completes the name', (await ev('document.getElementById("msg").value')) === '@sharon ', await ev('document.getElementById("msg").value'));
  await cmd('Input.insertText', { text: 'what is the budget?' });
  await st('/__meeting', { reset: true, replies: { cfo: 'The budget is fine.\nASK: Phil — any risk?', sec: 'No risk.\nINVITE: Rachel — hiring view', hr: 'PASS' } });
  const n0 = await ev('window.__posts.length');
  await key('Enter', 'Enter', 8, '\r', 13);
  const sent = await waitFor(async () => (await ev('window.__posts.length')) > n0 ? lastPost() : null, 4000);
  t('control → action: Shift+Enter sends the message', sent && sent.path === '/meeting/say' && sent.body.text === '@sharon what is the budget?', sent);
  const lines = await waitFor(() => ev('(()=>{const k=[...document.querySelectorAll(".chat-body .mtg-ev[data-kind]")].map(x=>x.dataset.kind);return k.includes("ask")&&k.includes("join")&&k.includes("pass")?[...document.querySelectorAll(".chat-body .mtg-ev[data-kind]")].map(x=>x.textContent):null})()'), 15000);
  t('asks, joins and passes are dim lines in order, as at the table', lines && lines.some(x => x === '(Sharon asks Phil: any risk?)') && lines.some(x => x === '(Rachel joins, invited by Phil: hiring view)') && lines.some(x => x === '(Rachel passes)') && lines.findIndex(x => /Sharon asks Phil/.test(x)) < lines.findIndex(x => /Rachel joins/.test(x)) && lines.findIndex(x => /Rachel joins/.test(x)) < lines.findIndex(x => /Rachel passes/.test(x)), lines);
  t('...and the protocol lines are not shown as raw text', !(await ev('/ASK:|INVITE:/.test(document.querySelector(".chat-body").innerText)')));
  t('the answer is introduced as at the table: (Phil answers Sharon)', await ev('[...document.querySelectorAll(".chat-body .msg-them-wrap[data-who=sec] .mtg-ev-lead")].some(x=>x.textContent==="(Phil answers Sharon)")'));
  t('tool steps stay in the flow as "· Name: …" lines (tools are on)', await waitFor(() => ev('[...document.querySelectorAll(".chat-body .msg-them-wrap[data-who=cfo] .mtg-tool")].some(x=>/^· Sharon: reading CHARTER\.md$/.test(x.textContent))'), 5000), await ev('[...document.querySelectorAll(".chat-body .mtg-tool")].map(x=>x.textContent)'));
  t('each person keeps one colour: their avatar, their name and their turns', await ev('(()=>{const c=el=>[...el.classList].find(k=>/^mtg-c\d$/.test(k));const av=c(document.querySelector(".mtg-seat[data-seat=cfo] .mtg-av"));const turns=[...document.querySelectorAll(".chat-body .msg-them-wrap[data-who=cfo]")].map(c);const other=c(document.querySelector(".mtg-seat[data-seat=sec] .mtg-av"));return !!av&&turns.length>0&&turns.every(x=>x===av)&&getComputedStyle(document.querySelector(".chat-body .msg-them-wrap[data-who=cfo] .mtg-who")).color!==getComputedStyle(document.querySelector(".chat-body .msg-them-wrap[data-who=sec] .mtg-who")).color||av===other})()'));
  await waitFor(() => ev('document.querySelector("[data-act=round]") && !document.querySelector("[data-act=round]").disabled'), 10000);
  { const n = await ev('window.__posts.length'); const i = await ev('(()=>{const b=document.querySelector(".chat-body .mtg-explain");if(!b)return null;const i=Number(b.closest("[data-i]").dataset.i);b.click();return i})()');
    const p = await waitFor(async () => (await ev('window.__posts.length')) > n ? lastPost() : null, 4000);
    t('control → action: Explain for the room', p && p.path === '/meeting/explain' && p.body.i === i, { p, i }); }
  t('a pass is never shown as a turn: no PASS text, no turn for Rachel', !(await ev('/PASS/.test(document.querySelector(".chat-body").innerText)')) && !(await ev('!!document.querySelector(".chat-body .msg-them-wrap[data-who=hr]")')));
  t('the cost line counts the turns and never shows $0.00 for a subscription', await ev('(()=>{const t=document.querySelector(".mtg-cost").textContent;return /^This meeting so far: [1-9]\\d* turns? · Claude: /.test(t)&&!/\\$0\\.00/.test(t)})()'), await ev('document.querySelector(".mtg-cost").textContent'));

  // Round, the speaking-now line, Raise hand, Continue, Esc, Stop round
  await st('/__meeting', { reset: true, replies: { agent: [{ text: 'A slow opening statement that runs on for a while, word after word after word.', stepMs: 120 }, { text: 'Another slow answer that keeps going on and on and on for a good while yet.', stepMs: 150 }], cfo: 'Short.', sec: 'PASS' } });
  await maps('Round', '[data-act="round"]', { path: '/meeting/round', body: {} });
  const speaking = await waitFor(() => ev('(()=>{const l=document.querySelector(".mtg-live");return l&&/Speaking now: Founder/.test(l.textContent)?l.textContent:null})()'), 6000, 80);
  t('the live line says who is speaking now and who is next', speaking && /Next up: \w/.test(speaking), speaking);
  const s1 = await waitFor(() => ev('(()=>{const l=document.querySelector(".chat-body .mtg-liveturn:not([hidden])");const s=l&&l.querySelector(".mtg-stream");return s&&s.textContent.length>5?{who:l.dataset.who,len:s.textContent.length,text:s.textContent,name:l.querySelector(".mtg-who").textContent}:null})()'), 6000, 60);
  await sleep(500);
  const s2 = await ev('(()=>{const s=document.querySelector(".chat-body .mtg-liveturn:not([hidden]) .mtg-stream");return s?s.textContent.length:0})()');
  t('the turn in flight streams word by word under the speaker\'s name', s1 && s1.who === 'agent' && s1.name === 'Founder' && s2 > s1.len && 'A slow opening statement that runs on for a while, word after word after word.'.startsWith(s1.text.trim()), { s1, s2 });
  await maps('Raise hand', '[data-act="hand"]', { path: '/meeting/hand', body: {} });
  t('the floor comes to the owner after the current speaker', await waitFor(() => ev('!!document.querySelector("[data-act=continue]") && /you have the floor/i.test(document.querySelector(".mtg-live").textContent)'), 15000));
  await maps('Continue', '[data-act="continue"]', { path: '/meeting/continue', body: {} });
  await waitFor(() => ev('document.querySelector("[data-act=round]").disabled===false'), 15000);
  await maps('Round again', '[data-act="round"]', { path: '/meeting/round', body: {} });
  await waitFor(() => ev('!!document.querySelector("[data-act=hand]") && !document.querySelector("[data-act=hand]").disabled'), 5000, 80);
  const n1 = await ev('window.__posts.length');
  await ev('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
  await key('Escape', 'Escape', 0, '', 27);
  const esc = await waitFor(async () => (await ev('window.__posts.length')) > n1 ? lastPost() : null, 3000);
  t('control → action: Esc raises a hand while a round runs', esc && esc.path === '/meeting/hand', esc);
  await sleep(300);
  const n2 = await ev('window.__posts.length');
  await key('Escape', 'Escape', 0, '', 27);
  await sleep(800);
  const esc2 = (await ev('window.__posts.length')) > n2 ? lastPost() : null;
  t('Esc again never stops anyone: no Stop is sent', !esc2 || esc2.path !== '/meeting/stop', esc2);
  t('the floor comes after the speaker; Continue ends the round', await waitFor(() => ev('!!document.querySelector("[data-act=continue]")'), 15000));
  await api('/meeting/continue', {});
  t('the round ends', await waitFor(() => ev('document.querySelector("[data-act=round]").disabled===false && !document.querySelector("[data-act=stop]")'), 15000));
  const slow = { text: 'One more slow answer that keeps going on and on for a while.', stepMs: 150 };
  await st('/__meeting', { reset: true, replies: { agent: slow, cfo: slow, sec: slow } });
  await api('/meeting/say', { text: 'One more, slowly.' });   // a new message: everyone has something new to answer
  await waitFor(() => ev('!!document.querySelector("[data-act=stop]")'), 5000, 80);
  await waitFor(() => ev('!!document.querySelector(".chat-body .mtg-liveturn:not([hidden]) .mtg-stream")'), 8000, 60);
  t('the Stop button says it is after this turn', await ev('/Stop after this turn/.test(document.querySelector("[data-act=stop]").textContent)'));
  await maps('Stop', '[data-act="stop"]', { path: '/meeting/stop', body: {} });
  t('Stop stops it after the current speaker', await waitFor(() => ev('document.querySelector("[data-act=round]").disabled===false && !document.querySelector("[data-act=stop]")'), 15000));
  const sayStop = await api('/meeting/entries?limit=200', null).catch(() => null);
  t('the speaker was not cut off: their whole answer is in the messages', sayStop && sayStop.entries && sayStop.entries.some(e => e.kind === 'say' && e.text === slow.text), sayStop && sayStop.entries && sayStop.entries.slice(-4));

  // How hard they think and on which model (More): Normal by default; Max asks first; one model for everyone
  await ev('document.querySelector("[data-act=more]").click()');
  t('More shows how hard they think, Normal by default, and the model', await waitFor(() => ev('(()=>{const s=document.getElementById("mtg-think"),m=document.getElementById("mtg-pin");return s&&m&&s.value==="normal"&&m.value===""})()'), 4000));
  await ev('(()=>{const s=document.getElementById("mtg-think");s.value="deep";s.dispatchEvent(new Event("change"));return 1})()');
  const th = await waitFor(() => { return ev('1').then(() => lastPost()).then(p => p && p.path === '/meeting/think' ? p : null); }, 3000);
  t('control → action: How hard they think', th && th.body.level === 'deep', th);
  await ev('window.confirm=()=>false;(()=>{const s=document.getElementById("mtg-think");s.value="max";s.dispatchEvent(new Event("change"));return 1})()');
  await sleep(300);
  t('Max asks first; declined, nothing is sent', (await lastPost()).body.level !== 'max' && await ev('document.getElementById("mtg-think").value!=="max"'));
  await ev('(()=>{const s=document.getElementById("mtg-pin");s.value=s.options[1].value;s.dispatchEvent(new Event("change"));return 1})()');
  const pn = await waitFor(() => lastPost().then(p => p && p.path === '/meeting/think' && p.body.pin ? p : null), 3000);
  t('control → action: one model for everyone', pn && /\//.test(pn.body.pin), pn);
  t('the cost line carries the next round\'s estimate', await waitFor(() => ev('/Next round at Deep: about \\d+ turn/.test(document.querySelector(".mtg-cost").textContent)'), 4000), await ev('document.querySelector(".mtg-cost").textContent'));
  await api('/meeting/think', { level: 'normal', pin: 'usual' });
  await ev('document.querySelector("[data-act=more]").click()');

  // Pace: Next (manual), Pause, Catch me up
  await ev('(()=>{const s=document.getElementById("mtg-speed");s.value="manual";s.dispatchEvent(new Event("change"));return 1})()');
  const pc = await waitFor(() => lastPost(), 3000);
  t('control → action: the pace picker', pc && pc.path === '/meeting/pace' && pc.body.speed === 'manual', pc);
  await st('/__meeting', { reset: true, replies: { agent: 'First.', cfo: 'Second.', sec: 'Third.' } });
  await api('/meeting/say', { text: 'At my pace.' });
  t('with Next pacing the meeting waits for you after a turn', await waitFor(() => ev('!!document.querySelector("[data-act=next]")'), 8000));
  await maps('Next', '[data-act="next"]', { path: '/meeting/next', body: {} });
  await waitFor(() => ev('!!document.querySelector("[data-act=pause]")'), 5000);
  await maps('Pause', '[data-act="pause"]', { path: '/meeting/hold', body: { on: true } });
  await waitFor(() => ev('!!document.querySelector("[data-act=unpause]")'), 5000);
  await maps('Carry on', '[data-act="unpause"]', { path: '/meeting/hold', body: { on: false } });
  await api('/meeting/pace', { speed: 'instant' }); await api('/meeting/next', {});
  await waitFor(() => ev('document.querySelector("[data-act=round]").disabled===false'), 10000);
  await st('/__meeting', { replies: { 'agent:catchup': 'Five bullets for you.' } });
  { const n = await ev('window.__posts.length'); await click('[data-act="catchup"]'); const p = await waitFor(async () => (await ev('window.__posts.length')) > n ? lastPost() : null, 4000);
    t('control → action: Catch me up', p && p.path === '/meeting/catchup' && typeof p.body.since === 'number', p); }
  t('the catch-up is a card only the owner sees', await waitFor(() => ev('!!document.querySelector(".chat-body .mtg-catchup")'), 8000));
  t('reading modes: Skim hides what was said, Everything shows it', await ev('(()=>{const b=[...document.querySelectorAll(".mtg-modes button")];b[2].click();const hid=[...document.querySelectorAll(".chat-body .msg-them-wrap")].every(x=>x.hidden);b[0].click();return hid&&[...document.querySelectorAll(".chat-body .msg-them-wrap")].some(x=>!x.hidden)})()'));
  t('nothing scrolls by itself: reading back stays put when a turn arrives', await (async () => {
    await ev('document.querySelector(".chat-body").scrollTop=0'); const top0 = await ev('document.querySelector(".chat-body").scrollTop');
    await st('/__meeting', { reset: true, replies: { agent: 'An arrival.' } }); await api('/meeting/say', { text: '@founder one more' });
    await waitFor(() => ev('[...document.querySelectorAll(".chat-body .msg-them-wrap")].some(x=>/An arrival/.test(x.textContent))'), 8000);
    return (await ev('document.querySelector(".chat-body").scrollTop')) === top0;
  })());
  t('the timeline lists the moments to scrub to', await ev('(async()=>{const d=document.querySelector(".mtg-timeline");d.open=true;d.dispatchEvent(new Event("toggle"));await new Promise(r=>setTimeout(r,800));return d.querySelectorAll("li button").length>0})()'));
  // the dropdown is held during live events; the controls still follow
  await api('/meeting/seats', { remove: ['hr'] });   // Rachel came in as a guest: unseat her, so the picker has someone
  await waitFor(() => ev('!document.getElementById("mtg-pick").disabled'), 4000);
  await ev('document.querySelector(".mtg-setup").open = true');   // the seats fold away; the owner opens them to add someone
  const f0 = await ev('(()=>{const s=document.getElementById("mtg-pick");s.__mark=1;s.focus();return document.activeElement===s})()');
  await api('/meeting/talkonly', { on: true });   // a change from elsewhere: the server emits "meeting"
  const followed = await waitFor(() => ev('/talk only/.test(document.querySelector(".mtg-sub").textContent)'), 5000);
  const held = await ev('(async()=>{const e=await import("/js/events.js");const s=document.getElementById("mtg-pick");return {same:!!(s&&s.__mark),focused:document.activeElement===s,pending:e.pendingWhileEditing()}})()');
  t('a live update does not close the roster dropdown (held)', f0 && held && held.same && held.focused && held.pending >= 1, held);
  t('...while the controls follow the change at once', !!followed);
  await ev('document.getElementById("mtg-pick").blur()');
  t('the strip redraws once focus leaves', await waitFor(() => ev('!document.getElementById("mtg-pick").__mark'), 4000));
  await api('/meeting/agenda', { op: 'remove', id: 'a1' }); await api('/meeting/talkonly', { on: false });

  // observe to END: the END card
  await api('/meeting/observe', { on: true, rounds: 3 });
  await st('/__meeting', { reset: true, replies: { agent: 'We agree.\nEND: ship it, Sharon writes it up', cfo: 'Agreed.' } });
  await api('/meeting/say', { text: 'Settle it.' });
  const endCard = await waitFor(() => ev('(()=>{const e=[...document.querySelectorAll(".chat-body .mtg-ev-end")].find(x=>/closes the discussion/.test(x.textContent));return e?e.textContent:null})()'), 15000);
  t('the END summary is its own line, as at the table', endCard === '(Founder closes the discussion: ship it, Sharon writes it up)', endCard);
  await api('/meeting/observe', { on: false });
  // Open minutes
  // the Register: the leader's proposed ruling, confirmed by the owner
  await st('/__meeting', { reset: true, replies: { agent: 'RULING: keep the plan — plain: we keep the plan' } });
  await api('/meeting/say', { text: '@founder rule on it' });
  t('a proposed ruling is a dim line with its way to confirm', await waitFor(() => ev('[...document.querySelectorAll(".chat-body .mtg-ev[data-kind=ruling]")].some(x=>/Founder proposes a ruling for you to confirm: keep the plan/.test(x.textContent)&&!!x.querySelector("[data-act=open-register]"))'), 8000));
  await click('[data-act="register"]');
  await waitFor(() => ev('!!document.querySelector("dialog.mtg-register[open] [data-ruling] button")'), 4000);
  { const n = await ev('window.__posts.length'); await ev('document.querySelector("dialog.mtg-register [data-ruling] button").click()'); const p = await waitFor(async () => (await ev('window.__posts.length')) > n ? lastPost() : null, 4000);
    t('control → action: Confirm ruling in the Register', p && p.path === '/meeting/register' && p.body.op === 'confirm' && p.body.n === 1, p); }
  await sleep(600); await ev('(()=>{const d=document.querySelector("dialog.mtg-register");if(d)d.close();return 1})()');
  t('the confirmed ruling is in decisions.md', /Meeting ruling \(\d{4}-\d{2}-\d{2}\): keep the plan/.test(R('company/work/decisions.md')));
  await click('[data-act="minutes"]');
  const mins = await waitFor(() => ev('(()=>{const d=document.querySelector("dialog.mtg-minutes[open]");return d?d.textContent:null})()'), 4000);
  t('Open minutes shows every word', mins && /The budget is fine\./.test(mins) && /company\/work\/meetings\/meeting-/.test(mins), mins && mins.slice(0, 300));
  await ev('document.querySelector("dialog.mtg-minutes").close()');

  // Close without END
  await maps('Close meeting', '[data-act="close"]', { path: '/meeting/close', body: {} });
  t('the meeting shows as closed, by whom, and offers a new one', await waitFor(() => ev('/closed by/.test(document.querySelector(".mtg-state").textContent) && !!document.querySelector(".chat-body .mtg-closed")'), 5000));
  if (process.env.MEETING_SHOTS) {   // a laptop / remote-desktop window, for a human to look at
    await ev('(()=>{const d=document.querySelector(".mtg-setup"); if (d) d.open = false; const m = document.querySelector(".mtg-more"); if (m && m.open) { m.open = false; m.dataset.reopen = 1; } return 1})()');
    if (process.env.MEETING_SHOTS_SKIM) await ev('(()=>{const b=document.querySelector(".mtg-modes [data-mode=skim]"); if (b) b.click(); const t=document.querySelector(".mtg-timeline"); if (t) t.open=false; return 1})()');
    await cmd('Emulation.setDeviceMetricsOverride', { width: 1000, height: 512, deviceScaleFactor: 1, mobile: false }); await sleep(600);
    const s = await cmd('Page.captureScreenshot', { format: 'png' }); if (s.result) fs.writeFileSync(process.env.MEETING_SHOTS, Buffer.from(s.result.data, 'base64'));
    await ev('(()=>{const m = document.querySelector(".mtg-more"); if (m && m.dataset.reopen) m.open = true; return 1})()');
  }
  // phone width
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const phone = await ev('(()=>({w:document.documentElement.scrollWidth,iw:innerWidth,btns:[...document.querySelectorAll(".mtg-controls .btn, .mtg-more-ctrl .btn")].every(b=>b.getBoundingClientRect().right<=innerWidth+1),off:[...document.querySelectorAll(".mtg-controls .btn, .mtg-more-ctrl .btn")].filter(b=>b.getBoundingClientRect().right>innerWidth+1).map(b=>b.textContent+":"+Math.round(b.getBoundingClientRect().right))}))()');
  t('phone width: no horizontal scroll, every control on screen', phone && phone.w <= phone.iw + 1 && phone.btns, phone);
  await cmd('Emulation.clearDeviceMetricsOverride', {});

  ws.close();
  console.log(fails ? 'MEETING UI WALK: FAIL (' + fails + ')' : 'MEETING UI WALK: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
