#!/usr/bin/env node
/* The owner's meeting through the real console and tests/mock-station.js (POST /__meeting scripts each seat's replies),
 * on a temp copy of the company:
 *   1. owner-only: no sign-in is refused (401), as for every /api route
 *   2. a meeting round: turns are station runs on each seat's model, talk only by default (isTask false, nothing placed);
 *      each turn is admitted as a meeting-turn (company/state/admit-log.jsonl); the minutes are written; the cost counts turns
 *   3. tools for one agenda item: isTask true with the tools placed for its turns, hand checks still talk only
 *   4. a refused turn is retried once on the seat's next chain entry, in one plain line
 *   5. END goes to company/work/decisions.md through decision.js add
 *   6. a console restart mid-turn: the turn in flight is re-attached (not started again) and the meeting carries on
 *   7. halt stops a meeting: the turn in flight is cancelled and nobody speaks after it; no round starts under a halt */
'use strict';
const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-meeting-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 900))); if (!cond) fails++; };
const kids = new Set();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-walk-selftest-'));
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(120); } }
const freePort = () => new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const R = rel => { try { return fs.readFileSync(path.join(tmp, rel), 'utf8'); } catch (_) { return ''; } };

fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
for (const d of ['console', 'modules', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(tmp, d), { recursive: true });
fs.rmSync(path.join(tmp, 'company', 'state', 'meetings'), { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), TOKEN + '\n', { mode: 0o600 });
const W = (rel, v) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const loops = JSON.parse(R('company/tools/loops.json'));
loops.agents.cfo = { name: 'Sharon', title: 'CFO', manager: 'agent', inbox: 'to-sharon.md' };
loops.agents.sec = { name: 'Phil', title: 'IT Admin and Security', manager: 'agent', inbox: 'to-phil.md' };
W('company/tools/loops.json', loops);
W('.starnet-data/workspaces/agent.roster.json', { agents: [{ agentId: 'agent', name: 'Founder', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'cfo', name: 'Sharon', model: 'claude-sonnet-5-5', provider: 'claude-cli' }, { agentId: 'sec', name: 'Phil', model: 'deepseek-flash', provider: 'deepseek' }] });
W('company/work/finance/dispatch-budget.json', { dailyUsd: 5 });
const pol = JSON.parse(R('company/model-policy.json'));
pol.seats = Object.assign({}, pol.seats, { agent: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } });
W('company/model-policy.json', pol);

(async () => {
  const sp = await freePort();
  const m = spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.add(m);
  const st = (p, b) => fetch('http://127.0.0.1:' + sp + p, { method: b ? 'POST' : 'GET', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  let console1 = null, cp = 0, ctoken = '';
  async function startConsole() {
    cp = await freePort(); let err = '';
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp, CHAT_RUN_QUIET_MS: '3000' }); delete env.CONSOLE_PORT;
    const c = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(c);
    c.stderr.on('data', d => { err += d; });
    await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
    ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
    return c;
  }
  console1 = await startConsole();
  const api = async (p, b, noAuth) => { const r = await fetch('http://127.0.0.1:' + cp + '/api' + p, { method: b ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, noAuth ? {} : { 'x-console-token': ctoken }), body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch (_) {} return { status: r.status, json: j }; };
  const idle = () => waitFor(async () => { const v = (await api('/meeting')).json; return v && v.live.phase === 'idle' ? v : null; }, 30000);
  const entries = async () => (await api('/meeting/entries?limit=200')).json.entries;
  const runs = async () => (await st('/__state')).meeting.runs;

  // 1. owner-only
  let r = await api('/meeting', null, true);
  t('1. owner-only: the meeting without the owner\'s sign-in is refused', r.status === 401, r);
  r = await api('/meeting/say', { text: 'hello' }, true);
  t('1. owner-only: a write without the sign-in is refused too', r.status === 401, r);

  // 2. a round through the station
  r = await api('/meeting');
  t('2. the default seats are the crew, the CEO seat leads', r.status === 200 && r.json.seats.map(s => s.id).join() === 'agent,cfo,sec' && r.json.meeting.leader === 'agent' && r.json.seats[2].model.provider === 'deepseek', r.json);
  await st('/__meeting', { reset: true, replies: { agent: 'The Founder speaks first.', cfo: 'PASS', sec: 'Phil adds a point.' } });
  r = await api('/meeting/say', { text: 'What is first this week?' });
  t('2. the owner\'s message is taken', r.status === 200, r);
  let v = await idle();
  let rs = await runs();
  t('2. everyone in turn, the leader first, as station runs on each seat\'s model', rs.map(x => x.agentId + '/' + x.provider).join() === 'agent/claude-cli,cfo/claude-cli,sec/deepseek', rs);
  t('2. talk only by default: isTask false and nothing placed (zero tool calls)', rs.every(x => x.isTask === false && !x.placed), rs);
  t('2. Phil saw the Founder\'s words', /Founder: The Founder speaks first\./.test(rs[2].last) || /The Founder speaks first/.test(JSON.stringify(rs[2])), rs[2]);
  const es = await entries();
  t('2. what was said is shown, the pass is not', es.filter(e => e.kind === 'say').map(e => e.who).join() === 'owner,agent,sec' && !es.some(e => e.kind === 'pass'), es);
  const rows = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const adm = rows.filter(x => x.door === 'meeting'); const ids = new Set(adm.map(x => x.id));
  t('2. every turn is admitted as a meeting-turn (lib/admit.js), and its start logged', adm.length === 3 && adm.every(x => x.decision === 'allow' && x.kind === 'meeting-turn') && rows.filter(x => ids.has(x.ref) && x.outcome === 'started').length === 3, rows);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: JSON.parse(R('company/company.json')).timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const minutes = R('company/work/meetings/meeting-' + day + '.md');
  t('2. the minutes have every word, by speaker, with times and models', /\*\*Founder\*\* \(\d\d:\d\d, Claude Sonnet\):\nThe Founder speaks first\./.test(minutes) && /\*\*Phil\*\* \(\d\d:\d\d, DeepSeek \(deepseek-flash\)\):\nPhil adds a point\./.test(minutes), minutes);
  t('2. the cost line counts the turns', v.meeting.cost.turns === 3 && v.meeting.cost.usd > 0, v.meeting.cost);

  // 3. tools switched on for one agenda item
  await api('/meeting/agenda', { op: 'add', title: 'Check the books' });
  const item = (await api('/meeting')).json.meeting.agenda[0];
  await api('/meeting/agenda', { op: 'tools', id: item.id, on: true });
  await st('/__meeting', { reset: true, replies: { agent: 'ASK: Sharon — is the budget fine?', cfo: 'It is fine.', 'sec:hand': 'NO' } });
  await api('/meeting/say', { text: 'Quick check, with tools.' });
  await idle(); rs = await runs();
  t('3. tools for this item: the turns have isTask true and the tools placed, the hand checks stay talk only', rs.filter(x => x.kind === 'turn').every(x => x.isTask === true && x.placed && x.placed.length) && rs.filter(x => x.kind === 'hand').length && rs.filter(x => x.kind === 'hand').every(x => x.isTask === false), rs);
  await api('/meeting/agenda', { op: 'tools', id: item.id, on: false });

  // 4. refusal fallback mid-meeting
  await st('/__meeting', { reset: true, replies: { agent: { text: 'Answered on the second model.', refuse: true } } });
  await api('/meeting/say', { text: '@founder one more thing' });
  await idle(); rs = (await runs()).filter(x => x.agentId === 'agent');
  let e2 = await entries();
  t('4. a refused turn: retried once on the next chain entry', rs.map(x => x.provider).join() === 'claude-cli,deepseek', rs);
  t('4. said in one plain line, and the answer is recorded on the second model', e2.some(e => e.kind === 'note' && e.text === 'Founder: Claude declined this; DeepSeek is answering instead.') && e2.some(e => e.kind === 'say' && e.who === 'agent' && e.model === 'DeepSeek (deepseek-flash)'), e2.slice(-4));
  t('4. the failover is recorded on the seat', /"door":"meeting"/.test(R('company/state/model-moves.jsonl')));

  // 5. END to decisions.md
  await api('/meeting/observe', { on: true, rounds: 3 });
  await st('/__meeting', { reset: true, replies: { agent: 'We agree.\nEND: ship the plan, Sharon writes it up', cfo: 'Agreed.', sec: 'PASS' } });
  await api('/meeting/say', { text: 'Settle it while I watch.' });
  await idle();
  t('5. END goes to decisions.md through decision.js add', /Founder \[d-[0-9a-f]{6}\] Meeting \d{4}-\d{2}-\d{2} closed: ship the plan, Sharon writes it up/.test(R('company/work/decisions.md')), R('company/work/decisions.md').slice(0, 600));
  await api('/meeting/observe', { on: false });

  // 6. a console restart mid-turn
  await st('/__meeting', { reset: true, replies: { agent: { text: 'This is a long and slow answer that keeps going for a while so the console can restart under it.', stepMs: 220 }, cfo: 'After the restart.', sec: 'PASS' } });
  await api('/meeting/say', { text: 'Restart test.' });
  const live = await waitFor(async () => { const x = (await api('/meeting')).json; return x.live.speaking && x.live.speaking.runId ? x : null; }, 10000);
  const busy = (await api('/console/busy')).json;
  t('6. the meeting turn shows as busy (restart-console.sh --when-idle waits for it)', live && busy.chats.includes(live.live.speaking.runId), { live: live && live.live, busy });
  await sleep(500);
  console1.kill('SIGKILL'); kids.delete(console1);
  await sleep(300);
  console1 = await startConsole();
  await idle();
  rs = (await runs()).filter(x => x.agentId === 'agent');
  e2 = await entries();
  t('6. the turn in flight was re-attached, not started again', rs.length === 1, rs);
  t('6. its reply is recorded whole, and the meeting carried on', e2.some(e => e.kind === 'say' && e.who === 'agent' && /keeps going for a while so the console can restart under it\./.test(e.text)) && e2.some(e => e.kind === 'say' && e.who === 'cfo' && e.text === 'After the restart.'), e2.slice(-4));

  // 7. halt
  await st('/__meeting', { reset: true, replies: { agent: { text: 'A slow answer that the halt cuts off before it ends, word by word by word.', stepMs: 250 }, cfo: 'Never said.' } });
  await api('/meeting/say', { text: 'Halt test.' });
  await waitFor(async () => { const x = (await api('/meeting')).json; return x.live.speaking && x.live.speaking.runId; }, 10000);
  await sleep(400);
  r = await api('/halt/hard', { why: 'meeting walk' });
  await idle();
  e2 = await entries();
  t('7. halt stops the meeting, and nobody speaks after', e2.some(e => e.kind === 'note' && /halted, so the meeting stopped/.test(e.text)) && !e2.some(e => e.who === 'cfo' && e.text === 'Never said.'), e2.slice(-4));
  r = await api('/meeting/say', { text: 'Anyone?' });
  t('7. no round starts under a halt', r.status === 409 && /halt/.test(r.json.error), r);
  await api('/halt/resume', {});

  console.log(fails ? 'MEETING WALK: FAIL (' + fails + ')' : 'MEETING WALK: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
