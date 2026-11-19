#!/usr/bin/env node
/* The chat's combined PRE-DELIVERY check at the owner's level (company/tools/lib/talk.js, console/chat.js; docs/TALK.md),
 * the real console against tests/mock-station.js on a temp copy of the company, with scripted chat replies:
 *   1. Plain, check on: a too-technical first reply is sent back exactly once (console.recheck), with one note that
 *      names the problems; the owner gets the second; the words are not streamed one by one; the seat was told the
 *      owner's level in its context note
 *   2. a second reply still technical is delivered masked: no path or command in the shown text, the originals under
 *      technical, the notice; the chat history is masked too
 *   3. a reply with a command AND technical words: one recheck, one note naming both
 *   4. check recording only: delivered unchanged, the would-be problems in a check row
 *   5. no choice (technical, as today): a technical reply is delivered as it is, the context note is today's, and a
 *      command is still sent back once with today's words (golden)
 *   6. POST /api/settings/talk without the owner's sign-in is refused */
'use strict';
const __LIFE = require('../company/tools/lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs'); const http = require('http');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-talkcheck-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 900))); if (!cond) fails++; };
const kids = new Set();
const tmp = __LIFE.tmpDir('chat-talkcheck-selftest-');
process.on('exit', () => { for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { try { const v = await fn(); if (v) return v; } catch (_) {} if (Date.now() > end) return null; await sleep(150); } }
const freePort = () => new Promise(r => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

fs.cpSync(path.join(REPO, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
for (const d of ['console', 'modules', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(tmp, d), { recursive: true });
fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), TOKEN + '\n', { mode: 0o600 });
fs.mkdirSync(path.join(tmp, '.starnet-data', 'workspaces'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.starnet-data', 'workspaces', 'agent.roster.json'), JSON.stringify({ agents: [{ agentId: 'agent', name: 'Founder', model: 'claude-sonnet-5-5', provider: 'claude-cli' }] }));
fs.mkdirSync(path.join(tmp, 'company', 'work', 'finance'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'company', 'work', 'finance', 'dispatch-budget.json'), JSON.stringify({ dailyUsd: 5 }));
const TALKF = path.join(tmp, 'company', 'owner', 'talk.json');
const setTalk = o => { if (!o) { fs.rmSync(TALKF, { force: true }); return; } fs.mkdirSync(path.dirname(TALKF), { recursive: true }); fs.writeFileSync(TALKF, JSON.stringify(Object.assign({ v: 1, level: 'plain', length: 'short', often: 'daily', check: 'live', setBy: 'owner' }, o))); };
const checkRows = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'state', 'talk-checks.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };

(async () => {
  const sp = await freePort(), cp = await freePort();
  const m = spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] }); kids.add(m);
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  let err = '';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp, CHAT_RUN_QUIET_MS: '3000' }); delete env.CONSOLE_PORT;
  const c = spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.add(c);
  c.stderr.on('data', d => { err += d; });
  await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
  const ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const mock = async (p, body) => (await fetch('http://127.0.0.1:' + sp + p, { method: body ? 'POST' : 'GET', headers: { 'x-starnet-token': TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const script = replies => mock('/__meeting', { replies: { 'agent:chat': replies } });
  const chatRuns = async () => ((await mock('/__state')).meeting.runs || []).filter(r => r.kind === 'chat');
  const send = text => new Promise(resolve => {
    const data = JSON.stringify({ text }); const lines = [];
    const req = http.request({ host: '127.0.0.1', port: cp, path: '/api/chat/agent/send', method: 'POST', headers: { 'x-console-token': ctoken, 'content-type': 'application/json' } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (l.trim()) { try { lines.push(JSON.parse(l)); } catch (_) {} } } });
      res.on('end', () => resolve(lines)); res.on('close', () => resolve(lines));
    });
    req.setTimeout(30000, () => req.destroy()); req.on('error', () => resolve(lines)); req.write(data); req.end();
  });
  const names = ls => ls.map(l => l.name);
  const finals = ls => ls.filter(l => l.name === 'console.final');
  const rechecks = ls => ls.filter(l => l.name === 'console.recheck');

  /* 1. Plain, check on: sent back once, the second delivered */
  setTalk({});
  let before = (await chatRuns()).length;
  await script(['I wrote the fix to company/state/prices.json and the cron is back.', 'The price checker is back. Nothing for you to do.']);
  let ls = await send('how is the price checker?');
  let runs = (await chatRuns()).slice(before);
  t('1. the too-technical first reply goes back exactly once, said plainly', rechecks(ls).length === 1 && /was more technical than you asked for, so it went back to Founder to say it again in plain words/.test(rechecks(ls)[0].payload.message) && rechecks(ls)[0].payload.talk.includes('path') && !rechecks(ls)[0].payload.command, names(ls));
  t('1. the owner gets the second reply, plain', finals(ls).length === 1 && finals(ls)[0].payload.text === 'The price checker is back. Nothing for you to do.' && !finals(ls)[0].payload.talkMasked, finals(ls));
  t('1. the words are held until the check (no token reaches the page)', ls.filter(l => l.name === 'agent.token').length > 0 && ls.filter(l => l.name === 'agent.token').every(l => l.payload.delta === '' && l.payload.held), ls.filter(l => l.name === 'agent.token').slice(0, 3));
  const asked = ((await mock('/__state')).transcripts['console-agent'] || []).find(x => x.role === 'user' && /how is the price checker\?$/.test(x.content));
  t('1. the seat was told the owner\'s level in its context note', asked && /\[How Owner wants to hear from you\] Owner chose plain words/.test(asked.content), asked && asked.content.slice(0, 200));
  t('1. the second run got one note naming the problems', runs.length === 2 && /^\[Console check, not from the owner: your reply was NOT shown/.test(runs[1].last) && /a file path \(company\/state\/prices\.json\)/.test(runs[1].last) && /technical words \([^)]*cron/.test(runs[1].last), runs.map(r => r.last.slice(0, 300)));
  let cr = checkRows();
  t('1. the check rows: sent back, then delivered', cr.length === 2 && cr[0].action === 'sent-back' && cr[1].action === 'delivered' && cr[1].secondProblems.length === 0 && cr[0].problems.some(p => p.kind === 'path'), cr);

  /* 2. still technical the second time: delivered masked */
  await script(['See company/state/a.json for it.', 'It is in company/state/b.json; run `node company/tools/x.js` if it stops.']);
  ls = await send('where is it?');
  const f2 = finals(ls)[0] || { payload: {} };
  t('2. one recheck, then the second reply delivered masked: no path or command shown', rechecks(ls).length === 1 && finals(ls).length === 1 && f2.payload.talkMasked === true && !/company\/|node |\.js\b/.test(f2.payload.text) && /a technical detail the crew handles/.test(f2.payload.text), f2.payload);
  t('2. the originals are under technical, with the notice', Array.isArray(f2.payload.technical) && f2.payload.technical.some(x => /company\/state\/b\.json/.test(x)) && f2.payload.notice === 'Some technical details were left out. The crew handles them.' && !f2.payload.commandAsk, f2.payload);
  cr = checkRows();
  t('2. the check rows: sent back, then masked', cr.slice(-2).map(r => r.action).join() === 'sent-back,masked', cr.slice(-2));
  await waitFor(async () => { const j = await mock('/__state'); return (j.transcripts['console-agent'] || []).filter(y => y.role === 'assistant').length >= 4; }, 10000);
  const info = await (await fetch('http://127.0.0.1:' + cp + '/api/chat/agent', { headers: { 'x-console-token': ctoken } })).json();
  const shownTurns = (info.turns || []).filter(x => x.role === 'assistant');
  t('2. the chat history shows neither the replies sent back nor any path', shownTurns.length === 2 && !shownTurns.some(x => /company\/|Console check/.test(x.content)) && shownTurns[1].talkMasked === true, shownTurns);

  /* 3. a command and technical words: one recheck, one note naming both */
  before = (await chatRuns()).length;
  await script(['Please run `sudo apt install jq` in your terminal; the cron needs it.', 'Done, it works now. Nothing for you to do.']);
  ls = await send('can you set it up?');
  runs = (await chatRuns()).slice(before);
  t('3. one recheck for both, said plainly', rechecks(ls).length === 1 && /asked you to run a command and was more technical than you asked for/.test(rechecks(ls)[0].payload.message) && /sudo apt install jq/.test(rechecks(ls)[0].payload.command) && rechecks(ls)[0].payload.talk.includes('jargon'), rechecks(ls));
  t('3. exactly two runs; the note names the command and the plain-words problem, once', runs.length === 2 && (runs[1].last.match(/\[Console check/g) || []).length === 1 && /asked them to run a command \(sudo apt install jq\)/.test(runs[1].last) && /also not shown because it was more technical/.test(runs[1].last) && finals(ls)[0].payload.text === 'Done, it works now. Nothing for you to do.', runs.map(r => r.last.slice(0, 400)));

  /* 4. recording only */
  setTalk({ check: 'shadow' });
  await script(['I wrote company/state/c.json.']);
  ls = await send('anything new?');
  t('4. recording only: delivered unchanged, words streamed, a shadow row', rechecks(ls).length === 0 && finals(ls)[0].payload.text === 'I wrote company/state/c.json.' && !finals(ls)[0].payload.talkMasked && ls.some(l => l.name === 'agent.token' && l.payload.delta) && checkRows().slice(-1)[0].action === 'shadow' && checkRows().slice(-1)[0].problems.some(p => p.kind === 'path'), { names: names(ls), row: checkRows().slice(-1) });

  /* 5. no choice: today's behaviour */
  setTalk(null);
  before = (await chatRuns()).length;
  await script(['I wrote company/state/d.json and the cron is fine.']);
  ls = await send('status?');
  runs = (await chatRuns()).slice(before);
  t('5. no choice: a technical reply is delivered as it is, and the context note is today\'s', rechecks(ls).length === 0 && finals(ls)[0].payload.text === 'I wrote company/state/d.json and the cron is fine.' && runs.length === 1 && !/wants to hear from you/.test(runs[0].last), { names: names(ls), last: runs[0] && runs[0].last.slice(0, 200) });
  const sr = checkRows().slice(-1)[0];
  t('5. ...and recorded what Plain would have sent back', sr.action === 'shadow' && sr.checkedAt === 'plain' && sr.level === 'technical', sr);
  await script(['Please run `sudo apt install jq` in your terminal and tell me when it is done.', 'Done: jq is installed. Nothing for you to do.']);
  ls = await send('install jq please');
  t('5. golden: a command is still sent back once, with today\'s words', rechecks(ls).length === 1 && rechecks(ls)[0].payload.message === 'Founder\'s first reply asked you to run a command, so it went back to Founder to offer a button or do it instead.' && !rechecks(ls)[0].payload.talk && finals(ls).length === 1 && finals(ls)[0].payload.text === 'Done: jq is installed. Nothing for you to do.', rechecks(ls));

  /* 6. the settings route is the owner's */
  const anon = await fetch('http://127.0.0.1:' + cp + '/api/settings/talk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: 'plain' }) });
  t('6. POST /api/settings/talk without the owner\'s sign-in is refused, nothing written', anon.status === 401 || anon.status === 403 ? !fs.existsSync(TALKF) : false, anon.status);
  const own = await (await fetch('http://127.0.0.1:' + cp + '/api/settings/talk', { headers: { 'x-console-token': ctoken } })).json();
  t('6. GET with the sign-in: the choice and the examples', own.ok && own.prefs.level === 'technical' && own.examples.messages.length === 3, own);

  console.log(fails ? 'CHAT TALK CHECK TEST: FAIL (' + fails + ')' : 'CHAT TALK CHECK TEST: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
