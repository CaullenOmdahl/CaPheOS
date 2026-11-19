#!/usr/bin/env node
/* The chat's PRE-DELIVERY command check (console/command-ask.js, console/chat.js): a reply that tells the owner to run a
 * command is not delivered; it goes back to the agent once with the reason, and the owner gets the second reply. The real
 * console against tests/mock-station.js on a temp copy of the company. The mock's "[cmd]" makes the first reply hand over
 * `sudo apt install jq`; "[cmd-always]" makes every reply do so.
 *   1. "[cmd]": the first reply is held back (console.recheck), a second run gets the check note (the owner uses the
 *      console only; offer a button or do it yourself), the delivered console.final is the second reply, with no command
 *   2. the chat history shows neither the check note nor the reply that was sent back
 *   3. "[cmd-always]": exactly one check run, then the second reply is delivered with the command notice (commandAsk) */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs'); const http = require('http');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-cmdcheck-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 800))); if (!cond) fails++; };
const kids = new Set();
const tmp = life.tmpDir('chat-cmdcheck-selftest-');
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
const polF = path.join(tmp, 'company', 'model-policy.json'); const pol = JSON.parse(fs.readFileSync(polF, 'utf8'));
pol.seats = Object.assign({}, pol.seats, { agent: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } });
fs.writeFileSync(polF, JSON.stringify(pol, null, 1));

(async () => {
  const sp = await freePort(), cp = await freePort();
  const m = life.track(spawn(process.execPath, [path.join(__dirname, 'mock-station.js'), '--port', String(sp), '--token', TOKEN, '--root', tmp, '--caps', 'run-detach'], { stdio: ['ignore', 'pipe', 'inherit'] })); kids.add(m);
  await waitFor(async () => (await fetch('http://127.0.0.1:' + sp + '/api/health', { headers: { 'x-starnet-token': TOKEN } })).status < 500, 10000);
  let err = '';
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + sp, CHAT_RUN_QUIET_MS: '3000' }); delete env.CONSOLE_PORT;
  const c = life.track(spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', String(cp), '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] })); kids.add(c);
  c.stderr.on('data', d => { err += d; });
  await new Promise((resolve, reject) => { let b = ''; c.stdout.on('data', d => { b += d; if (/\{"port":\d+\}/.test(b)) resolve(); }); setTimeout(() => reject(new Error('console did not start: ' + err)), 20000); });
  const ctoken = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
  const send = text => new Promise(resolve => {
    const data = JSON.stringify({ text }); const lines = [];
    const req = http.request({ host: '127.0.0.1', port: cp, path: '/api/chat/agent/send', method: 'POST', headers: { 'x-console-token': ctoken, 'content-type': 'application/json' } }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (l.trim()) { try { lines.push(JSON.parse(l)); } catch (_) {} } } });
      res.on('end', () => resolve(lines)); res.on('close', () => resolve(lines));
    });
    req.setTimeout(30000, () => req.destroy()); req.on('error', () => resolve(lines)); req.write(data); req.end();
  });

  let ls = await send('[cmd] can you install jq for the report?');
  const finals = ls.filter(l => l.name === 'console.final');
  const rc = ls.find(l => l.name === 'console.recheck');
  t('1. the reply that hands over a command is held back and said plainly (console.recheck)', rc && /asked you to run a command/.test(rc.payload.message) && /sudo apt install jq/.test(rc.payload.command), ls.map(l => l.name));
  t('1. exactly one reply is delivered: the second one, without the command', finals.length === 1 && finals[0].payload.complete === true && !/sudo/.test(finals[0].payload.text) && !finals[0].payload.commandAsk, finals);
  // the station writes the second reply into its transcript as the run settles: wait for it
  const st = await waitFor(async () => { const j = await (await fetch('http://127.0.0.1:' + sp + '/__state', { headers: { 'x-starnet-token': TOKEN } })).json(); const x = j.transcripts && j.transcripts['console-agent'] || []; return x.filter(y => y.role === 'assistant').length >= 2 ? j : null; }, 10000);
  const tr = st && st.transcripts && st.transcripts['console-agent'] || [];
  const note = tr.find(x => x.role === 'user' && /^\[Console check, not from the owner:/.test(x.content));
  t('1. the agent got the reason: the owner uses the console only; offer a button or do it yourself', note && /console only/.test(note.content) && /do it yourself/i.test(note.content) && /sudo apt install jq/.test(note.content), tr.map(x => x.role + ': ' + String(x.content).slice(0, 80)));
  const info = await (await fetch('http://127.0.0.1:' + cp + '/api/chat/agent', { headers: { 'x-console-token': ctoken } })).json();
  const turns = (info.turns || []).map(x => x.role + ': ' + x.content);
  t('2. the chat history shows neither the check note nor the reply that was sent back', !turns.some(x => /Console check/.test(x) || /sudo apt/.test(x)) && turns.some(x => /^assistant: Got it/.test(x)), turns);

  ls = await send('[cmd-always] install jq please');
  const f2 = ls.filter(l => l.name === 'console.final');
  const runs2 = new Set(ls.filter(l => l.name === 'console.attached').map(l => l.payload.runId));
  t('3. a second refusal to drop the command: one check run only, then delivered with the notice', f2.length === 1 && /sudo apt install jq/.test(f2[0].payload.text) && f2[0].payload.commandAsk && runs2.size === 2 && ls.filter(l => l.name === 'console.recheck').length === 1, { names: ls.map(l => l.name), runs: [...runs2], f2 });

  console.log(fails ? 'CHAT COMMAND CHECK TEST: FAIL (' + fails + ')' : 'CHAT COMMAND CHECK TEST: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
