#!/usr/bin/env node
/* lanes.e2e.js — Sprint lanes against a REAL StarNet station (not part of scripts/test.sh: it needs a StarNet checkout,
 * npm modules and about a minute).
 *
 *   node company/tools/tests/lanes.e2e.js
 *   env: STARNET_SRC     the StarNet repo to clone (default: STARNET_REPO from scripts/setup-station.sh; a local path works)
 *        STARNET_REF     the commit (default: the one setup-station.sh pins)
 *        STARNET_NODE_MODULES  an existing node_modules for that commit, symlinked instead of `npm install`
 *        KEEP=1          keep the temp folder; LANES_E2E_DIR=<dir> where to make it (default the system temp dir)
 *
 * It does what scripts/setup-station.sh does in a throwaway folder: a fresh clone at the pinned commit, every default
 * patch in company/patches/ (0012 included), then boots the station's sidecar on a free port (never 8800 or 8810) with a
 * fake OpenRouter that scripts each run's tool calls. A temp company (a git repo; an engineer seat "sam" with two OPEN
 * handoffs whose Touches are disjoint; Sprint on, lanes 2) runs real dispatcher ticks against it:
 *   tick 1: dispatch.js fires Sam's main loop AND lanes.js starts lane sam/1 (its own routine, its own worktree);
 *           while the main loop's run is held live (it has already used the shell in the company folder), the lane's run
 *           writes docs/api.md, commits it with a SHELL call and writes LANE-RESULT.md: no "workspace busy", no 45 s wait;
 *   tick 2: the lane has ended: its result is in the handoff, its branch kept with the commit, its lock released, its
 *           routine removed; nothing was merged into the main checkout.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), net = require('net');
const { spawn, spawnSync, execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const setup = fs.readFileSync(path.join(REPO, 'scripts', 'setup-station.sh'), 'utf8');
const pick = re => (re.exec(setup) || [])[1];
const SRC = process.env.STARNET_SRC || pick(/STARNET_REPO="\$\{STARNET_REPO:-([^}]+)\}"/);
const REF = process.env.STARNET_REF || pick(/STARNET_REF="\$\{STARNET_REF:-([0-9a-f]+)\}"/);
const BRANCH = pick(/STARNET_BRANCH="\$\{STARNET_BRANCH:-([^}]+)\}"/);
const TOKEN = 'lanes-e2e-token';
const W = fs.realpathSync(fs.mkdtempSync(path.join(process.env.LANES_E2E_DIR || os.tmpdir(), 'lanes-e2e-')));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, oks = 0;
const ok = (c, msg) => { if (c) { oks++; console.log('ok   ' + msg); } else { fails++; console.log('FAIL ' + msg); } };
const children = [];
function cleanup() { for (const c of children) { try { c.kill(); } catch (_) {} } if (process.env.KEEP !== '1') { try { fs.rmSync(W, { recursive: true, force: true }); } catch (_) {} } else console.log('kept ' + W); }
process.on('exit', cleanup);

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => (p === 8800 || p === 8810) ? freePort().then(res, rej) : res(p)); }); s.on('error', rej); });
}

/* 1. a fresh StarNet checkout, set up the way setup-station.sh does it */
function station() {
  const sn = path.join(W, 'starnet');
  console.log('cloning ' + SRC + ' @ ' + REF);
  if (/^(https?|git|ssh):|^git@/.test(SRC)) {   // a remote: only the pinned commit (shallow)
    fs.mkdirSync(sn); git(sn, 'init', '-q'); git(sn, 'remote', 'add', 'origin', SRC);
    execFileSync('git', ['-C', sn, 'fetch', '-q', '--depth', '1', 'origin', REF], { stdio: 'inherit' });
    git(sn, 'sparse-checkout', 'set', '--no-cone', '/*', '!/frontend/assets/');
    git(sn, 'checkout', '-q', 'FETCH_HEAD');
  } else {   // a local checkout: share its objects (nothing copied)
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', SRC, sn], { stdio: 'inherit' });
    git(sn, 'sparse-checkout', 'set', '--no-cone', '/*', '!/frontend/assets/');   // the art (gigabytes) is not needed to run the engine
    git(sn, 'checkout', '-q', REF);
  }
  for (const d of fs.readdirSync(path.join(REPO, 'company', 'patches')).filter(f => /^\d{4}-.*\.diff$/.test(f)).sort()) {
    const f = path.join(REPO, 'company', 'patches', d);
    if (/^# Status: NOT APPLIED/m.test(fs.readFileSync(f, 'utf8'))) { console.log('skip ' + d); continue; }
    let applied = false;
    for (const args of [['apply', '--3way', '--whitespace=nowarn', f], ['apply', '--whitespace=nowarn', f]]) { try { execFileSync('git', ['-C', sn].concat(args), { stdio: 'ignore' }); applied = true; break; } catch (_) {} }
    ok(applied, 'patch ' + d + ' applies on a fresh checkout of ' + REF.slice(0, 10));
  }
  if (process.env.STARNET_NODE_MODULES) fs.symlinkSync(path.resolve(process.env.STARNET_NODE_MODULES), path.join(sn, 'node_modules'));
  else execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: sn, stdio: 'inherit' });
  return sn;
}

/* 2. a fake OpenRouter: each run's tool calls, by which run it is (a lane's prompt names "Sprint lane sam/1") */
function fakeModel() {
  const requests = []; const held = new Map();
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
    if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      let msgs = []; try { msgs = JSON.parse(body).messages || []; } catch (_) {}
      const text = msgs.filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      const lane = /Sprint lane (\S+)\)/.exec(text); const who = lane ? 'lane' : /to-sam\.md/.test(text) ? 'main' : 'other';
      const results = msgs.filter(m => m && m.role === 'tool');
      requests.push({ who, n: results.length, results: results.map(m => String(m.content || '').slice(0, 300)) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const tool = (name, args) => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: who + results.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
      const done = () => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
      const script = who === 'lane' ? [
        ['brief_proceed', { objective: 'document the API' }],
        ['fs_write', { path: 'docs/api.md', content: '# API\n\nGET /intake returns the form.\n' }],
        ['shell_exec', { cmd: 'git add -A && git -c user.name=Sam -c user.email=sam@example.invalid commit -q -m "API docs" && git log --oneline -1' }],
        ['fs_write', { path: 'LANE-RESULT.md', content: 'Status: DONE — documented GET /intake\nEdited docs/api.md and committed it on the lane branch.\n' }],
      ] : who === 'main' ? [
        ['brief_proceed', { objective: 'build the intake form' }],
        ['shell_exec', { cmd: 'mkdir -p src/intake && echo "module.exports = 2;" > src/intake/form.js && echo main-wrote' }],
      ] : [];
      if (results.length < script.length) return tool(...script[results.length]);
      if (who === 'main' && !held.has('main-released')) { held.set('main', done); return; }   // the main loop stays live
      done();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, requests, held, release() { held.set('main-released', true); const f = held.get('main'); held.delete('main'); if (f) f(); }, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' })));
}

(async () => {
  const sn = station();
  const model = await fakeModel();
  const port = await freePort();
  ok(port !== 8800 && port !== 8810, 'the throwaway station uses port ' + port);
  const ws = path.join(W, 'data', 'workspaces'); fs.mkdirSync(ws, { recursive: true });
  const sidecar = spawn(process.execPath, [path.join(sn, 'sidecar', 'index.js')], { cwd: sn, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, {
    SKYNET_PORT: String(port), PORT: String(port), SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, XDG_DATA_HOME: path.join(W, 'data'), STARNET_API_TOKEN: TOKEN, STARNET_HOST: '127.0.0.1', STARNET_HEADLESS: '1',
    SKYNET_OPENROUTER_BASE: model.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-lanes-e2e-fake', SKYNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '1' }) });
  children.push(sidecar);
  let out = ''; sidecar.stdout.on('data', d => { out += d; }); sidecar.stderr.on('data', d => { out += d; });
  const B = 'http://127.0.0.1:' + port;
  const H = { 'Content-Type': 'application/json', 'x-starnet-token': TOKEN };
  const api = async (method, p, body) => { const r = await fetch(B + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return Object.assign({ _status: r.status }, JSON.parse(t)); } catch (_) { return { _status: r.status, _text: t.slice(0, 300) }; } };
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/api/cron', { headers: H }); if (r.status === 200) break; } catch (_) {} await sleep(500); }
  const ver = await api('GET', '/api/version');
  ok(Array.isArray(ver.capabilities) && ver.capabilities.includes('workspace-lease-per-folder'), 'the station reports the patch 0012 capability');

  /* 3. a company: a git repo, an engineer with two independent OPEN handoffs, Sprint on */
  const T = path.join(W, 'company'); fs.mkdirSync(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('.gitignore', '/company/work/*\n/company/state/*\n/company/owner/*\n/.starnet-data/\n/secrets/\n'); w('src/intake/form.js', 'module.exports = 1;\n'); w('docs/api.md', '# API\n');
  git(T, 'init', '-q', '-b', 'main'); git(T, 'add', '-A'); git(T, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  w('company/company.json', { name: 'Lanes E2E', owner: { name: 'Pat' }, timezone: 'UTC', station: { port, serviceName: 'lanes-e2e' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: true, since: new Date(Date.now() - 3600e3).toISOString(), until: null, by: 'owner', lanes: 2 };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 5, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} }); w('company/owner/inbound.jsonl', '');
  fs.mkdirSync(path.join(T, '.starnet-data'), { recursive: true }); fs.symlinkSync(ws, path.join(T, '.starnet-data', 'workspaces'));
  const item = (h, t) => '\n## 2026-11-17 from Alex — ' + h + '\n**Need:** do it\n**Status:** OPEN\n**Touches:** ' + t + '\n';
  w('company/work/handoffs/to-sam.md', '# Handoffs\n' + item('build the intake form', 'src/intake/') + item('write the API docs', 'docs/api.md'));
  w('company/work/handoffs/to-founder.md', '# Handoffs\n');
  ok((await api('POST', '/api/projects/bless', { path: T })).ok === true, 'the company folder is blessed');
  const mk = async (name, agentId, prompt) => (await api('POST', '/api/cron', { name, agentId, prompt, schedule: 'every 24h', workdir: T, deliver: 'local', model: 'test/model', provider: 'openrouter', unattendedGrants: ['workbench'] })).job;
  const founder = await mk('Founder loop', 'agent', 'Read company/work/handoffs/to-founder.md and /api/quests, then work.');
  const samLoop = await mk('Sam loop', 'sam', 'Read company/work/handoffs/to-sam.md and /api/quests, then work.');
  ok(samLoop && samLoop.id && founder && founder.id, 'the seats\' loop routines exist on the station');
  w('company/tools/loops.json', { agents: {
    agent: { name: 'Alex', title: 'Founder and CEO', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null },
    sam: { name: 'Sam', title: 'Software engineer', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', writesCode: true } } });
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: B, CAPHEOS_TZ: 'UTC', DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30' });
  const tick = () => { const p = spawnSync(process.execPath, [path.join(REPO, 'company', 'tools', 'dispatch.js')], { cwd: T, env, encoding: 'utf8', timeout: 170000 }); return (p.stdout || '') + (p.stderr || ''); };
  const lanesJson = () => { try { return JSON.parse(fs.readFileSync(path.join(T, 'company', 'state', 'lanes.json'), 'utf8')); } catch (_) { return { lanes: [], history: [] }; } };

  /* tick 1: the main loop and a lane, at once */
  const t0 = Date.now();
  const o1 = tick();
  const lane = lanesJson().lanes[0];
  ok(/LANE START sam\/1/.test(o1) && lane && lane.kind === 'worktree', 'tick 1 started lane sam/1 in a worktree' + (lane ? ' (' + lane.branch + ')' : ': ' + o1.slice(-800)));
  ok(/RUN Sam loop/.test(o1), 'tick 1 also fired Sam\'s main loop');
  if (!lane) { console.log(out.slice(-3000)); process.exit(1); }
  for (let i = 0; i < 120 && !(model.held.has('main') && model.requests.some(r => r.who === 'lane' && r.n >= 4)); i++) await sleep(500);
  ok(model.held.has('main'), 'the main loop\'s run is live (held on its last turn, after its shell call in the company folder)');
  const laneReqs = model.requests.filter(r => r.who === 'lane');
  ok(laneReqs.some(r => r.n >= 4), 'the lane ran all its steps while the main loop was live');
  ok(!laneReqs.some(r => r.results.some(x => /workspace busy|workspace-busy/.test(x))), 'no lane tool call was refused "workspace busy"');
  ok(Date.now() - t0 < 45000 + 20000, 'no 45 s lease wait (' + Math.round((Date.now() - t0) / 1000) + ' s for both)');
  ok(/API docs/.test(git(T, 'log', '--oneline', lane.branch)), 'the lane\'s shell call committed on its branch ' + lane.branch);
  ok(fs.readFileSync(path.join(T, 'src', 'intake', 'form.js'), 'utf8').includes('2'), 'the main loop wrote in the company folder at the same time');
  model.release();
  for (let i = 0; i < 60; i++) { const jobs = (await api('GET', '/api/cron')).jobs || []; if (!jobs.some(j => j.inFlight)) break; await sleep(500); }

  /* tick 2: the lane has ended */
  const o2 = tick();
  const inbox = fs.readFileSync(path.join(T, 'company', 'work', 'handoffs', 'to-sam.md'), 'utf8');
  ok(/LANE END sam\/1 .*: DONE, 1 commit/.test(o2), 'tick 2 ended the lane: DONE with 1 commit');
  ok(/\*\*Lane result \(lane 1, run [^,]+, [^)]+\):\*\* DONE — documented GET \/intake; branch `lane\/sam-1-/.test(inbox), 'the result and the branch are in the handoff');
  ok(!/\*\*Lane:\*\*/.test(inbox), 'the Lane line is gone');
  ok(lanesJson().lanes.length === 0 && !(JSON.parse(fs.readFileSync(path.join(T, 'company', 'state', 'lane-locks.json'), 'utf8')).locks || []).length, 'the lane and its path lock are released');
  ok(!((await api('GET', '/api/cron')).jobs || []).some(j => /^Lane /.test(j.name)), 'the lane routine is removed from the station');
  ok(git(T, 'log', '--oneline', 'main').split('\n').length === 1 && !!git(T, 'branch', '--list', lane.branch), 'nothing merged into main; the branch is kept for review');
  console.log((fails ? 'LANES E2E FAILED: ' + fails + ' of ' + (fails + oks) : 'LANES E2E PASSED: ' + oks + ' checks') + ' (station ' + REF.slice(0, 10) + ' + default patches, port ' + port + ')');
  if (process.env.LANES_E2E_LOG) fs.writeFileSync(process.env.LANES_E2E_LOG, out + '\n\n--- tick 1 ---\n' + o1 + '\n--- tick 2 ---\n' + o2);
  if (fails) { console.log(out.slice(-2000)); console.log(JSON.stringify(model.requests.map(r => [r.who, r.n, r.results.map(x => x.slice(0, 160))]), null, 1).slice(0, 6000)); }
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
