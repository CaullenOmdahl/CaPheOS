#!/usr/bin/env node
/* A colleague brought into the owner's live chat, through the real console and tests/mock-station.js (POST /__meeting
 * scripts the replies: '<seat>:chat' for the 1:1 reply, '<seat>' for a turn in the chat with colleagues), on a temp copy
 * of the company:
 *   1. owner-only: no sign-in is refused (401)
 *   2. a live chat reply that ends with ASK: Sharon — … : the stream carries console.huddle; Sharon's run is its own
 *      stream (huddle-agent-cfo) with tools, admitted as door chat / kind meeting-turn; the host closes the loop
 *   3. GET /api/huddle/<host>/attach replays a guest turn's tokens; an unknown run answers console.gone
 *   4. while Sharon is in the chat, POST /api/chat/<host>/send goes to everyone (host first), not to a 1:1 run
 *   5. the owner's × sends Sharon back out: the chat is 1:1 again, the minutes are written, and the host's next 1:1
 *      message carries the recap
 *   6. a plain 1:1 run writes live.json while it runs (the dispatcher holds the seat), and removes it at the end */
'use strict';
const { spawn, spawnSync } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-huddle-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + String(JSON.stringify(info)).slice(0, 900))); if (!cond) fails++; };
const kids = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-walk-selftest-'));
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
loops.agents.cfo = { name: 'Sharon', title: 'CFO', manager: 'agent', inbox: 'to-sharon.md' };
loops.agents.sec = { name: 'Phil', title: 'IT Admin and Security', manager: 'agent', inbox: 'to-phil.md' };
W('company/tools/loops.json', loops);
W('.starnet-data/workspaces/agent.roster.json', { agents: [{ agentId: 'agent', name: 'Founder', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'cfo', name: 'Sharon', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'sec', name: 'Phil', model: 'claude-sonnet-5-5', provider: 'claude-cli' }] });
W('company/work/finance/dispatch-budget.json', { dailyUsd: 5 });

(async () => {
  const sp = await freePort();
  const m = spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.add(m);
  const st = (p, b) => fetch('http://127.0.0.1:' + sp + p, { method: b ? 'POST' : 'GET', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  const cp = await freePort(); let err = '';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp, CHAT_RUN_QUIET_MS: '3000' }); delete env.CONSOLE_PORT;
  const c = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(c);
  c.stderr.on('data', d => { err += d; });
  await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
  const ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const H = noAuth => Object.assign({ 'content-type': 'application/json' }, noAuth ? {} : { 'x-console-token': ctoken });
  const api = async (p, b, noAuth) => { const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: b ? 'POST' : 'GET', headers: H(noAuth), body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, json: j }; };
  const ndjson = async (p, b) => { const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: b ? 'POST' : 'GET', headers: Object.assign(H(), { accept: 'application/x-ndjson' }), body: b ? JSON.stringify(b) : undefined }); return (await r.text()).split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); };
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
  await st('/__meeting', { reset: true, replies: { 'agent:chat': 'Let me ask Sharon.\nASK: Sharon — is the daily budget set?', cfo: 'Yes, Founder: five dollars a day.', agent: 'Sharon confirms the budget is five dollars a day.' } });
  let lines = await ndjson('/chat/agent/send', { text: 'Is the budget set?' });
  const hud = lines.find(l => l.name === 'console.huddle');
  t('2. the reply that asks a colleague ends with console.huddle', !!hud && hud.payload.host === 'agent' && /^m-/.test(hud.payload.id), lines.map(l => l.name));
  t('2. ... after the reply itself (console.final, then console.huddle, then console.end)', lines.findIndex(l => l.name === 'console.final') < lines.findIndex(l => l.name === 'console.huddle') && lines.findIndex(l => l.name === 'console.huddle') < lines.findIndex(l => l.name === 'console.end'), lines.map(l => l.name));
  let v = await idle();
  let rs = await runs();
  const g = rs.find(x => x.agentId === 'cfo');
  t('2. Sharon answers in her own stream, with tools, right away', g && g.streamId === 'huddle-agent-cfo' && g.isTask === true && Array.isArray(g.placed) && /Founder asked you directly: is the daily budget set\?/.test(g.last), g);
  t('2. Sharon sees the chat so far', g && /live chat with Founder/.test(g.first), g && g.first);
  const wrap = rs.filter(x => x.streamId === 'huddle-agent-agent');
  t('2. the host closes the loop once', wrap.length === 1 && /Close the loop for/.test(wrap[0].last), wrap);
  t('2. the chat is open with Sharon in it', v && v.open && v.seats.map(s => s.id).join() === 'agent,cfo', v);
  const adm = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.door === 'chat' && x.kind === 'meeting-turn');
  t('2. every turn admitted: door chat, kind meeting-turn', adm.length >= 2 && adm.some(x => x.seat === 'cfo') && adm.every(x => x.decision === 'allow'), adm);
  const ent = (await api('/huddle/agent/entries?limit=200')).json.entries;
  t('2. the entries: the chat so far, the ask, Sharon joining and answering', ent.some(e => e.kind === 'say' && e.src === 'chat' && e.who === 'owner') && ent.some(e => e.kind === 'ask' && e.who === 'agent' && e.to === 'cfo') && ent.some(e => e.kind === 'join' && e.who === 'cfo') && ent.some(e => e.kind === 'say' && e.who === 'cfo' && /five dollars/.test(e.text)), ent.map(e => e.kind + ':' + e.who));
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
  t('4. while Sharon is here, the 1:1 send goes to the chat with her', lines.length === 1 && lines[0].name === 'console.huddle' && lines[0].payload.routed === true, lines);
  await idle();
  rs = (await runs()).slice(n0);
  t('4. the host first, then the guest; no 1:1 run', rs.map(x => x.streamId).join() === 'huddle-agent-agent,huddle-agent-cfo', rs.map(x => x.streamId));

  // 5. the owner's ×
  r = await api('/huddle/agent/seats', { remove: ['cfo'] });
  t('5. the owner sends Sharon back out', r.status === 200, r);
  v = await waitFor(async () => { const x = (await api('/huddle/agent')).json; return x && !x.open ? x : null; }, 10000);
  t('5. the chat is 1:1 again, closed in the record', v && v.open === false && v.meeting.state === 'closed', v && v.meeting);
  const day = new Date().toISOString().slice(0, 10);
  const mins = fs.readdirSync(path.join(tmp, 'company/work/meetings')).filter(f => /^chat-agent-/.test(f));
  t('5. its minutes', mins.length === 1 && /five dollars/.test(R('company/work/meetings/' + mins[0])), mins);
  const hist = (await api('/chat/agent')).json.huddles;
  t('5. the 1:1 view lists it as an earlier chat with colleagues', hist.length === 1 && hist[0].guests.includes('Sharon') && hist[0].entries.some(e => e.kind === 'say' && e.who === 'cfo'), hist);
  await st('/__meeting', { replies: { 'agent:chat': 'Noted.' } });
  lines = await ndjson('/chat/agent/send', { text: 'Thanks.' });
  const tr = (await st('/__state')).transcripts['console-agent'];
  const lastUser = tr.filter(x => x.role === 'user').pop();
  t('5. the host\'s next 1:1 message carries the recap', lastUser && /\[While Sharon was in this chat/.test(lastUser.content) && /Agreed, Founder\./.test(lastUser.content), lastUser && lastUser.content.slice(-1200));
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

  console.log(fails ? 'HUDDLE WALK: FAIL (' + fails + ')' : 'HUDDLE WALK: PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.log('FAIL ' + e.stack); process.exit(1); });
