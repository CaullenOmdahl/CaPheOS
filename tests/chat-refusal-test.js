#!/usr/bin/env node
/* A chat turn the first model refuses is answered by the seat's next model (owner ruling; company/tools/lib/refusal.js):
 * the real console against tests/mock-station.js on a temp copy of the company. The mock's "[refuse]" makes claude-cli's
 * filter decline the run; "[refuse-all]" makes every model decline it.
 *   1. "[refuse]": one plain line ("Claude declined this; DeepSeek is answering instead."), a second run on DeepSeek, the
 *      reply arrives, console.final is complete, no console.error; the failover is recorded on the seat
 *   2. "[refuse-all]": one retry, then a plain console.error (code refused), the stream ends; never more than two runs */
'use strict';
const life = require('../company/tools/lib/temp-life');   // temp dirs and helper processes end with the walk, on a kill too
const { spawn } = require('child_process'); const path = require('path'); const os = require('os'); const fs = require('fs'); const http = require('http');
const REPO = path.join(__dirname, '..');
const TOKEN = 'mock-refusal-token';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const t = (name, cond, info) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + JSON.stringify(info).slice(0, 800))); if (!cond) fails++; };
const kids = new Set();
const tmp = life.tmpDir('chat-refusal-selftest-');
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

  let ls = await send('[refuse] please check the plan');
  const note = ls.find(l => l.name === 'console.note' && l.payload && l.payload.refusal);
  const runs = ls.filter(l => l.name === 'console.run');
  const finals = ls.filter(l => l.name === 'console.final');
  t('1. a refusal is said in one plain line, and the next model answers', note && /^Claude declined this; DeepSeek is answering instead\.$/.test(note.payload.message), ls.map(l => l.name));
  // (the opening lines are sent and then replayed from the run's journal, so each may appear twice: count models, not lines)
  const models = [...new Set(runs.map(r => r.payload.provider))];
  t('1. the retry is a second run on DeepSeek, the same turn', models.join() === 'claude-cli,deepseek', runs);
  t('1. the reply arrives complete and nothing is shown as an error', finals.length === 1 && finals[0].payload.complete === true && /Got it/.test(finals[0].payload.text) && !ls.some(l => l.name === 'console.error'), { finals, err: ls.filter(l => l.name === 'console.error') });
  const moves = (() => { try { return fs.readFileSync(path.join(tmp, 'company', 'state', 'model-moves.jsonl'), 'utf8'); } catch (_) { return ''; } })();
  t('1. the failover is recorded on the seat (model-moves.jsonl, models-state lastRefusal)', /"direction":"refusal"/.test(moves) && /"door":"chat"/.test(moves) && /Claude declined this/.test(fs.readFileSync(path.join(tmp, 'company', 'state', 'models-state.json'), 'utf8')), moves);

  ls = await send('[refuse-all] please check the plan');
  const e = ls.find(l => l.name === 'console.error');
  t('2. every model declining: one retry, then a plain error, and the stream ends', [...new Set(ls.filter(l => l.name === 'console.run').map(l => l.payload.provider))].join() === 'claude-cli,deepseek' && ls.filter(l => l.name === 'console.final').length === 1 && e && e.payload.code === 'refused' && /declined this too/.test(e.payload.message), ls.map(l => l.name + (l.payload && l.payload.message ? ': ' + l.payload.message : '')));

  console.log(fails ? 'CHAT REFUSAL TEST: FAIL (' + fails + ')' : 'CHAT REFUSAL TEST: PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
