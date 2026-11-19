#!/usr/bin/env node
/* A colleague brought into the owner's live chat, through the real console and tests/mock-station.js (POST /__meeting
 * scripts the replies: '<seat>:chat' for the 1:1 reply, '<seat>' for a turn in the chat with colleagues), on a temp copy
 * of the company:
 *   1. owner-only: no sign-in is refused (401)
 *   2. a live chat reply that ends with ASK: Zoe — … : the stream carries console.huddle; Zoe's run is its own
 *      stream (huddle-agent-cfo) with tools, admitted as door chat / kind meeting-turn; the host closes the loop
 *   3. GET /api/huddle/<host>/attach replays a guest turn's tokens; an unknown run answers console.gone
 *   4. while Zoe is in the chat, POST /api/chat/<host>/send goes to everyone (host first), not to a 1:1 run
 *   5. the owner's × sends Zoe back out: the chat is 1:1 again, the minutes are written, and the host's next 1:1
 *      message carries the recap
 *   4b. the page (headless Chrome, SKIP without): the strip, the guest's reply in the same window, the ASK as a dim line
 *   6. a plain 1:1 run writes live.json while it runs (the dispatcher holds the seat), and removes it at the end
 *   7. Stop mid-reply: a cut-off reply brings nobody in, even with an ASK line in its text
 *   8. a console restart mid-reply: the new console re-attaches the run and still acts on its ASK line */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-huddle-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + String(JSON.stringify(info)).slice(0, 900))); if (!cond) fails++; };
const kids = new Set();
const tmp = life.tmpDir('huddle-walk-selftest-');
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(120); } }
const freePort = () => new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = rel => { try { return fs.readFileSync(path.join(tmp, rel), 'utf8'); } catch (_) { return ''; } };
const W = (rel, v) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };

fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
for (const d of ['console', 'modules', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(tmp, d), { recursive: true });
for (const d of ['meetings', 'huddles', 'chat-runs']) fs.rmSync(path.join(tmp, 'company', 'state', d), { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), TOKEN + '\n', { mode: 0o600 });
const loops = JSON.parse(R('company/tools/loops.json'));
loops.agents.cfo = { name: 'Zoe', title: 'CFO', manager: 'agent', inbox: 'to-zoe.md' };
loops.agents.sec = { name: 'Paul', title: 'IT Admin and Security', manager: 'agent', inbox: 'to-paul.md' };
W('company/tools/loops.json', loops);
W('.starnet-data/workspaces/agent.roster.json', { agents: [{ agentId: 'agent', name: 'Founder', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'cfo', name: 'Zoe', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'sec', name: 'Paul', model: 'claude-sonnet-5-5', provider: 'claude-cli' }] });
W('company/work/finance/dispatch-budget.json', { dailyUsd: 5 });

(async () => {
  const sp = await freePort();
  const m = life.track(spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] })); kids.add(m);
  const st = (p, b) => fetch('http://127.0.0.1:' + sp + p, { method: b ? 'POST' : 'GET', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  let cp = 0, c = null, err = '', ctoken = '';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp, CHAT_RUN_QUIET_MS: '3000' }); delete env.CONSOLE_PORT;
  const startConsole = async () => {
    cp = await freePort();
    c = life.track(spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] })); kids.add(c);
    c.stderr.on('data', d => { err += d; });
    await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
    ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  };
  await startConsole();
  const H = noAuth => Object.assign({ 'content-type': 'application/json' }, noAuth ? {} : { 'x-console-token': ctoken });
  const api = async (p, b, noAuth) => { const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: b ? 'POST' : 'GET', headers: H(noAuth), body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, json: j }; };
  const ndjson = async (p, b) => { const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: b ? 'POST' : 'GET', headers: Object.assign(H(), { accept: 'application/x-ndjson' }), body: b ? JSON.stringify(b) : undefined }); return (await r.text()).split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); };
  // a send read as it streams: onLine(line, lines) sees each line; resolves with every line once the stream ends
  const streamSend = async (p, b, onLine) => {
    const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: 'POST', headers: Object.assign(H(), { accept: 'application/x-ndjson' }), body: JSON.stringify(b) });
    const out = []; let buf = ''; const dec = new TextDecoder();
    try { for await (const ch of r.body) { buf += dec.decode(ch, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const j = JSON.parse(l); out.push(j); try { await onLine(j, out); } catch (_) {} } } } catch (_) { /* the console went away */ }
    return out;
  };
  const idle = () => waitFor(async () => { const v = (await api('/huddle/agent')).json; return v && (!v.live || v.live.phase === 'idle') ? v : null; }, 30000);
  const runs = async () => (await st('/__state')).meeting.runs;

  // 1. owner-only
  let r = await api('/huddle/agent', null, true);
  t('1. owner-only: the chat with colleagues without the owner\'s sign-in is refused', r.status === 401, r);
  r = await api('/huddle/agent/seats', { add: ['cfo'] }, true);
  t('1. owner-only: bringing someone in without the sign-in is refused too', r.status === 401, r);
  r = await api('/huddle/agent');
  t('1. nobody else is in the chat at first; the picker lists the others', r.status === 200 && r.json.open === false && r.json.roster.map(x => x.id).sort().join() === 'cfo,sec', r.json);

  // 2. the host asks a colleague
  await st('/__meeting', { reset: true, replies: { 'agent:chat': 'Let me ask Zoe.\nASK: Zoe — is the daily budget set?', cfo: 'Yes, Founder: five dollars a day.', agent: 'Zoe confirms the budget is five dollars a day.' } });
  let lines = await ndjson('/chat/agent/send', { text: 'Is the budget set?' });
  const hud = lines.find(l => l.name === 'console.huddle');
  t('2. the reply that asks a colleague ends with console.huddle', !!hud && hud.payload.host === 'agent' && /^m-/.test(hud.payload.id), lines.map(l => l.name));
  t('2. ... after the reply itself (console.final, then console.huddle, then console.end)', lines.findIndex(l => l.name === 'console.final') < lines.findIndex(l => l.name === 'console.huddle') && lines.findIndex(l => l.name === 'console.huddle') < lines.findIndex(l => l.name === 'console.end'), lines.map(l => l.name));
  let v = await idle();
  let rs = await runs();
  const g = rs.find(x => x.agentId === 'cfo');
  t('2. Zoe answers in her own stream, with tools, right away', g && g.streamId === 'huddle-agent-cfo' && g.isTask === true && Array.isArray(g.placed) && /Founder asked you directly: is the daily budget set\?/.test(g.last), g);
  t('2. Zoe sees the chat so far', g && /live chat with Founder/.test(g.first), g && g.first);
  const wrap = rs.filter(x => x.streamId === 'huddle-agent-agent');
  t('2. the host closes the loop once', wrap.length === 1 && /Close the loop for/.test(wrap[0].last), wrap);
  t('2. the chat is open with Zoe in it', v && v.open && v.seats.map(s => s.id).join() === 'agent,cfo', v);
  const adm = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.door === 'chat' && x.kind === 'meeting-turn');
  t('2. every turn admitted: door chat, kind meeting-turn', adm.length >= 2 && adm.some(x => x.seat === 'cfo') && adm.every(x => x.decision === 'allow'), adm);
  const ent = (await api('/huddle/agent/entries?limit=200')).json.entries;
  t('2. the entries: the chat so far, the ask, Zoe joining and answering', ent.some(e => e.kind === 'say' && e.src === 'chat' && e.who === 'owner') && ent.some(e => e.kind === 'ask' && e.who === 'agent' && e.to === 'cfo') && ent.some(e => e.kind === 'join' && e.who === 'cfo') && ent.some(e => e.kind === 'say' && e.who === 'cfo' && /five dollars/.test(e.text)), ent.map(e => e.kind + ':' + e.who));
  const info = (await api('/chat/agent')).json;
  t('2. the 1:1 view knows a colleague is in the chat', info.huddleOpen === true, info.huddleOpen);

  // 3. attach
  const cr = JSON.parse(R('company/state/chat-runs.json')).runs;
  const gid = Object.keys(cr).find(k => cr[k].streamId === 'huddle-agent-cfo');
  lines = await ndjson('/huddle/agent/attach?runId=' + encodeURIComponent(gid) + '&from=0');
  t('3. attach replays a guest turn: its tokens, then its end', lines.filter(l => l.name === 'agent.token').map(l => l.payload.delta).join('').includes('five dollars') && lines[lines.length - 1].name === 'console.end', lines.map(l => l.name));
  lines = await ndjson('/huddle/agent/attach?runId=nope&from=0');
  t('3. an unknown run answers console.gone', lines.length === 1 && lines[0].name === 'console.gone', lines);

  // 4. the owner's next message goes to everyone
  await st('/__meeting', { replies: { agent: 'Then we keep it.', cfo: 'Agreed, Founder.' } });
  const n0 = (await runs()).length;
  lines = await ndjson('/chat/agent/send', { text: 'Should we keep it there?' });
  t('4. while Zoe is here, the 1:1 send goes to the chat with her', lines.length === 1 && lines[0].name === 'console.huddle' && lines[0].payload.routed === true, lines);
  await idle();
  rs = (await runs()).slice(n0);
  t('4. the host first, then the guest; no 1:1 run', rs.map(x => x.streamId).join() === 'huddle-agent-agent,huddle-agent-cfo', rs.map(x => x.streamId));

  // 4b. the page (headless Chrome; SKIP without it): the strip with Zoe, her reply in the same window in her colour,
  // the host's ASK line as a dim line, a message from the composer going to everyone
  const bin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
  if (!bin) console.log('SKIP 4b. the page: no Chrome');
  else {
    const udd = life.tmpDir('huddle-walk-chrome-');
    const cdpPort = await freePort();
    const chrome = life.track(spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--user-data-dir=' + udd, '--remote-debugging-port=' + cdpPort, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', env: life.chromeEnv(udd) })); kids.add(chrome);
    process.on('exit', () => { try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {} });
    const tab = await waitFor(async () => (await (await fetch('http://127.0.0.1:' + cdpPort + '/json')).json()).find(x => x.type === 'page'), 15000);
    const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r2 => ws.onopen = r2);
    let id = 0; const pend = {}; ws.onmessage = mm => { const j = JSON.parse(mm.data); if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; } };
    const cmd = (method, params) => new Promise(r2 => { const i = ++id; pend[i] = r2; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => ((await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result || {}).result?.value;
    const C = 'http://127.0.0.1:' + cp;
    await cmd('Page.navigate', { url: C + '/login' });
    await waitFor(() => ev('(()=>{const i=document.getElementById("secret");if(!i)return 0;i.value=' + JSON.stringify(ctoken) + ';i.form.submit();return 1})()'), 10000);
    await sleep(800);
    await cmd('Page.navigate', { url: C + '/#/chat/agent' });
    const pg = await waitFor(() => ev('(()=>{const g=document.querySelector(".hud-bar .hud-seat[data-seat=\'cfo\']");const a=document.querySelector(".chat-body .hud-area");if(!g||!a||!a.querySelector("[data-who=cfo]"))return null;return {x:!!g.querySelector("[data-act=dismiss]"),reply:a.querySelector("[data-who=cfo]").textContent,colour:[...a.querySelector("[data-who=cfo]").classList].some(c=>/^mtg-c\\d$/.test(c)),asks:[...document.querySelectorAll(".chat-body .mtg-ev")].map(x=>x.textContent),raw:[...document.querySelectorAll(".chat-body .msg-them")].some(x=>/ASK:/.test(x.textContent))}})()'), 15000);
    t('4b. the page: Zoe in the strip with ×, her reply in the same window in her colour', pg && pg.x && /five dollars/.test(pg.reply) && pg.colour, pg);
    t('4b. the page: the host\'s ASK line is a dim line, never raw text', pg && !pg.raw && pg.asks.some(x => /asks Zoe: is the daily budget set\?/.test(x)), pg);
    await st('/__meeting', { replies: { agent: 'From the page: noted.', cfo: 'PASS' } });
    const n1 = (await runs()).length;
    await ev('(()=>{const t=document.getElementById("msg");t.value="One more thing from the page.";t.form.requestSubmit();return 1})()');
    const sent = await waitFor(async () => (await runs()).slice(n1).some(x => x.streamId === 'huddle-agent-agent'), 10000);
    t('4b. the page: a message from the composer goes to everyone in the chat (the host answers in the chat)', !!sent);
    await idle();
    const shown = await waitFor(() => ev('(()=>{const a=document.querySelector(".chat-body .hud-area");return a&&/From the page: noted\./.test(a.textContent)&&/One more thing from the page\./.test(a.textContent)&&/Zoe passes/.test(a.textContent)})()'), 10000);
    t('4b. the page: the owner\'s message, the host\'s answer and Zoe\'s pass, in order', !!shown);
    ws.close();
  }

  // 5. the owner's ×
  r = await api('/huddle/agent/seats', { remove: ['cfo'] });
  t('5. the owner sends Zoe back out', r.status === 200, r);
  v = await waitFor(async () => { const x = (await api('/huddle/agent')).json; return x && !x.open ? x : null; }, 10000);
  t('5. the chat is 1:1 again, closed in the record', v && v.open === false && v.meeting.state === 'closed', v && v.meeting);
  const day = new Date().toISOString().slice(0, 10);
  const mins = fs.readdirSync(path.join(tmp, 'company/work/meetings')).filter(f => /^chat-agent-/.test(f));
  t('5. its minutes', mins.length === 1 && /five dollars/.test(R('company/work/meetings/' + mins[0])), mins);
  const hist = (await api('/chat/agent')).json.huddles;
  t('5. the 1:1 view lists it as an earlier chat with colleagues', hist.length === 1 && hist[0].guests.includes('Zoe') && hist[0].entries.some(e => e.kind === 'say' && e.who === 'cfo'), hist);
  await st('/__meeting', { replies: { 'agent:chat': 'Noted.' } });
  lines = await ndjson('/chat/agent/send', { text: 'Thanks.' });
  const tr = (await st('/__state')).transcripts['console-agent'];
  const lastUser = tr.filter(x => x.role === 'user').pop();
  t('5. the host\'s next 1:1 message carries the recap', lastUser && /\[While Zoe was in this chat/.test(lastUser.content) && /Agreed, Founder\./.test(lastUser.content), lastUser && lastUser.content.slice(-1200));
  t('5. ... once', !fs.existsSync(path.join(tmp, 'company/state/huddles/agent/recap.json')));
  const shown = (await api('/chat/agent')).json.turns.filter(x => x.role === 'user').pop();
  t('5. the owner\'s own bubble shows only what they wrote, not the recap', shown && shown.content === 'Thanks.', shown);
  void day;

  // 6. live.json around a plain 1:1 run
  await st('/__meeting', { replies: { 'cfo:chat': 'a b c d e f g h i j k l m n o p q r s t u v w x y z' } });
  const pend = ndjson('/chat/cfo/send', { text: 'Status?' });
  const busyNow = await waitFor(() => fs.existsSync(path.join(tmp, 'company/state/huddles/cfo/live.json')), 5000);
  t('6. live.json while the 1:1 reply is written', !!busyNow);
  const chk = spawnSync(process.execPath, ['-e', 'const M=require(' + JSON.stringify(path.join(tmp, 'company/tools/lib/meetings.js')) + ');const b=M.busy("cfo");console.log(JSON.stringify(b&&b.kind))'], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp }), encoding: 'utf8' });
  t('6. the dispatcher\'s check holds that seat (kind chat)', /"chat"/.test(chk.stdout), chk.stdout + chk.stderr);
  await pend;
  const gone = await waitFor(() => !fs.existsSync(path.join(tmp, 'company/state/huddles/cfo/live.json')), 5000);
  t('6. and removes it at the end', !!gone);

  // 7. the owner presses Stop while the reply is written: a cut-off reply brings nobody in, even if its text has an ASK line
  await st('/__meeting', { reset: true, replies: { 'cfo:chat': { text: 'Let me ask Paul.\nASK: Paul — what is the firewall rule for the new box and why was it changed last week by the team', stepMs: 150 } } });
  let rid7 = null, stopped7 = false;
  lines = await streamSend('/chat/cfo/send', { text: 'Why did the firewall change?' }, async l => {
    if (l.name === 'console.attached') rid7 = l.payload.runId;
    if (!stopped7 && l.name === 'agent.token' && /firewall/.test(l.payload.delta) && rid7) { stopped7 = true; await st('/api/cancel', { runId: rid7 }); }
  });
  const fin7 = lines.find(l => l.name === 'console.final');
  t('7. Stop mid-reply: the reply is marked cut off, with the ASK line in its text', stopped7 && fin7 && fin7.payload.complete === false && /ASK: Paul/.test(fin7.payload.text || ''), { stopped7, fin7 });
  await sleep(600);
  rs = await runs();
  t('7. ... and nobody is brought in: no console.huddle, no run for Paul, the chat stays 1:1', !lines.some(l => l.name === 'console.huddle') && !rs.some(x => x.agentId === 'sec') && (await api('/huddle/cfo')).json.open === false, { names: lines.map(l => l.name), rs: rs.map(x => x.streamId) });

  // 8. the console restarts while the host's 1:1 reply is written: the new console still acts on its ASK line
  await st('/__meeting', { reset: true, replies: { 'agent:chat': { text: 'Let me ask Zoe about the budget for this month, she keeps the numbers.\nASK: Zoe — what is the budget this month?', stepMs: 120 }, cfo: 'Five dollars a day, as before.', agent: 'Zoe says five dollars a day.' } });
  const oldC = c;
  let killed8 = false;
  await streamSend('/chat/agent/send', { text: 'What is the budget this month?' }, async l => {
    if (!killed8 && l.name === 'agent.token' && /budget/.test(l.payload.delta)) { killed8 = true; await new Promise(r2 => { oldC.on('exit', r2); oldC.kill('SIGKILL'); }); }
  });
  t('8. the console was killed mid-reply', killed8);
  await startConsole();
  const g8 = await waitFor(async () => (await runs()).find(x => x.agentId === 'cfo' && x.streamId === 'huddle-agent-cfo'), 20000);
  t('8. after the restart, the reply\'s ASK still brings Zoe in, and she answers', !!g8 && /what is the budget this month\?/.test(g8.last), g8);
  v = await idle();
  t('8. the chat is open with Zoe in it', v && v.open && v.seats.map(s => s.id).join() === 'agent,cfo', v && v.seats);
  t('8. live.json is gone once the run ended', !fs.existsSync(path.join(tmp, 'company/state/huddles/agent/live.json')));

  console.log(fails ? 'HUDDLE WALK: FAIL (' + fails + ')' : 'HUDDLE WALK: PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.stack); process.exit(1); });
