#!/usr/bin/env node
/* lanes-dispatch.test.js — Sprint parallel lanes (company/tools/lanes.js) through the real dispatch.js, against
 * tests/mock-station.js. Each case builds a small company in a temp folder (a git repo: an engineer who writes code, a
 * writer who does not, a metered seat, the CEO), runs dispatcher ticks and reads what reached the mock station.
 * It proves: lanes refuse cleanly on a station without patch 0012 (and say why); a lane is its own run on the seat's
 * agent and current model, in its own worktree (code) or scratch folder, owning one handoff, behind a path lock; the
 * main loop is not woken for lane-owned items; a finished lane reports into its handoff and leaves its branch; the CEO
 * never gets lanes; per-seat and company caps; the daily cap, a paused loop and a soft halt start none; a hard halt and
 * the timeout cut them off and release the lock; locked-watch takes a lane routine as the seat's.
 *
 *   node --test company/tools/tests/lanes-dispatch.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO, 'company', 'tools', 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3, HOUR = 3600e3;
const TOKEN = 'lanes-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const SEATS = {
  agent: { name: 'Alex', title: 'Founder and CEO', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null, provider: 'claude-cli' },
  sam: { name: 'Sam', title: 'Software engineer', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli' },
  kim: { name: 'Kim', title: 'Writer', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent', provider: 'claude-cli' },
  mo: { name: 'Mo', title: 'Backend engineer', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', provider: 'deepseek' },
};
const block = (head, touches) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n**Status:** OPEN\n' + (touches ? '**Touches:** ' + touches + '\n' : '');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800); assert.notEqual(port, 8810);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/* a company: o.caps (the station has patch 0012), o.handoffs {inbox: text}, o.sprintCfg, o.runs, o.halt, o.dailyUsd */
async function company(o) {
  o = o || {};
  await st('POST', '/__caps', { caps: o.caps === false ? [] : ['workspace-lease-per-folder'] });
  await st('POST', '/__hold', { names: o.hold || [] });
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-co-'))); roots.push(T);
  const tag = path.basename(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  // the company checkout is a git repo with the product code tracked; company/work and company/state are not
  w('.gitignore', '/company/work/*\n/company/state/*\n/company/owner/*\n/.starnet-data/\n/secrets/\n');
  w('src/intake/form.js', 'module.exports = 1;\n'); w('src/dates.js', 'module.exports = 2;\n'); w('src/auth/login.js', '//\n'); w('docs/api.md', '# API\n'); w('docs/guide.md', '# Guide\n');
  git(T, 'init', '-q', '-b', 'main'); git(T, 'add', '-A'); git(T, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  w('company/company.json', { name: 'Lanes Test ' + tag, owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'lanes-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = o.sprint === false ? { on: false } : Object.assign({ on: true, since: new Date(Date.now() - HOUR).toISOString(), until: null, by: 'owner', lanes: 2 }, o.sprintCfg || {});
  if (o.quiet) cad.bounds.quietHours = o.quiet;
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: o.dailyUsd != null ? o.dailyUsd : 5, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  if (o.halt) w('company/state/halt.json', o.halt);
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', (o.runs || []).map(r => JSON.stringify(r)).join('\n') + (o.runs && o.runs.length ? '\n' : ''));
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
  const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + tag;
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: s.provider, model: s.provider === 'deepseek' ? 'deepseek-flash' : 'claude-haiku-5', schedule: 'every 2h', workdir: T, unattendedGrants: (o.grants || {})[id] || ['workbench'] });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: Object.assign({ lastRunAt: new Date(Date.now() - 50 * MIN).toISOString(), inFlight: false }, (o.patch || {})[id] || {}) });
    agents[id].loop = name;
  }
  w('company/tools/loops.json', { agents });
  const co = { T, tag, ids, w, r: rel => fs.readFileSync(path.join(T, rel), 'utf8'), json: rel => JSON.parse(fs.readFileSync(path.join(T, rel), 'utf8')) };
  co.env = extra => Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }, extra || {});
  co.tick = extra => {
    const n = reqs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env: co.env(extra) });
    const mine = reqs().slice(n);
    const fired = mine.filter(r => r.path === '/api/cron/run' && r.method === 'POST').map(r => r.body.id);
    const laneCreates = mine.filter(r => r.path === '/api/cron' && r.method === 'POST' && /^Lane /.test((r.body || {}).name || ''));
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), mine, fired, firedSeats: Object.keys(ids).filter(k => fired.includes(ids[k])).sort(), laneCreates,
      log: (() => { try { return co.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  co.lanes = () => { try { return co.json('company/state/lanes.json'); } catch (_) { return { lanes: [], history: [] }; } };
  co.locks = () => { try { return co.json('company/state/lane-locks.json').locks; } catch (_) { return []; } };
  co.cron = async () => (await st('GET', '/api/cron')).jobs;
  co.lastRun = async (id, minAgo) => st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - minAgo * MIN).toISOString() } });
  return co;
}
const SAM2 = { 'to-sam.md': block('build the intake form', 'src/intake/') + block('write the API docs', 'docs/api.md') };

test('no patch 0012 on the station: no lane starts, the log and Crew say why, the main loop runs as before', async () => {
  const c = await company({ caps: false, handoffs: SAM2 });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.laneCreates.length, 0, 'no lane routine created');
  assert.deepEqual(r.firedSeats, ['sam'], r.log);
  assert.match(r.log, /SPRINT LANES held at 1: Sam \(2 independent\) could run in parallel, but this station has not applied patch 0012/);
  const m = c.json('company/state/sprint-metrics.json');
  assert.equal(m.lanes.sam.max, 1); assert.equal(m.lanes.sam.possible, 2); assert.match(m.lanes.sam.why, /patch 0012/); assert.match(m.lanes.sam.why, /setup-station/);
  assert.equal(c.lanes().lanes.length, 0);
});

test('a lane is its own run: the seat\'s agent and current model, its own worktree, one handoff, a path lock; it reports back and leaves its branch', async () => {
  const c = await company({ handoffs: SAM2, hold: ['Lane '] });
  await st('POST', '/api/cron/update', { id: c.ids.sam, patch: { model: 'claude-sonnet-5-5' } });   // what the pacer / models.js set this tick
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.laneCreates.length, 1, r.log);
  const body = r.laneCreates[0].body;
  const laneJob = (await c.cron()).find(j => j.name === body.name);
  body.prompt = laneJob.prompt;   // the request log keeps only the first 300 characters
  assert.equal(body.agentId, 'sam'); assert.equal(body.model, 'claude-sonnet-5-5'); assert.equal(body.provider, 'claude-cli'); assert.equal(body.enabled, false);
  assert.equal(body.workdir, path.join(c.T, 'company', 'work', 'lanes', 'sam', '1'));
  assert.match(body.name, /^Lane [0-9a-f]{8}$/);
  assert.match(body.prompt, /YOUR HANDOFF: "2026-11-17 from Alex — write the API docs"/);
  assert.match(body.prompt, /TOUCH ONLY THESE PATHS: docs\/api\.md/);
  assert.match(body.prompt, /git worktree/);
  assert.ok(!/build the intake form"/.test(body.prompt.split('Its text:')[0]), 'the lane names only its own handoff');
  // the lane run and the main loop both started; the bless came first
  assert.ok(r.fired.includes(laneJob.id), 'the lane routine was fired'); assert.ok(r.firedSeats.includes('sam'), 'the main loop ran too');
  assert.ok(r.mine.some(x => x.path === '/api/projects/bless' && x.body.path === body.workdir));
  const lane = c.lanes().lanes[0];
  assert.equal(lane.id, 'sam/1'); assert.equal(lane.kind, 'worktree'); assert.match(lane.branch, /^lane\/sam-1-/); assert.ok(lane.runId);
  assert.equal(git(body.workdir, 'rev-parse', '--abbrev-ref', 'HEAD'), lane.branch);
  assert.deepEqual(c.locks().map(l => [l.lane, l.paths]), [['sam/1', ['docs/api.md']]]);
  assert.match(c.r('company/work/handoffs/to-sam.md'), /write the API docs\n\*\*Need:\*\* do it\n\*\*Status:\*\* OPEN\n\*\*Lane:\*\* 1, run run-\d+, since /);
  const m = c.json('company/state/sprint-metrics.json');
  assert.equal(m.lanes.sam.max, 2); assert.equal(m.lanes.sam.live.length, 1); assert.equal(m.lanes.sam.live[0].handoff, '2026-11-17 from Alex — write the API docs');
  assert.match(r.log, /LANE START sam\/1 \(Sam, run run-\d+, worktree lane\/sam-1-\S+, claude-cli\/claude-sonnet-5-5\)/);
  // no routing policy: the lane's run body is exactly {id, detach}; its wake row (door lane) names its one item, no route
  const laneRun = r.mine.find(x => x.path === '/api/cron/run' && x.body.id === laneJob.id);
  assert.equal(JSON.stringify(laneRun.body), JSON.stringify({ id: laneJob.id, detach: true }));
  const laneWake = c.r('company/state/wakes.jsonl').trim().split('\n').map(l => JSON.parse(l)).find(x => x.door === 'lane');
  assert.ok(laneWake && laneWake.seat === 'sam' && laneWake.runId === lane.runId && laneWake.jobId === laneJob.id && !('route' in laneWake), JSON.stringify(laneWake));
  assert.deepEqual(laneWake.items.map(i => i.title), ['2026-11-17 from Alex — write the API docs']);

  // next tick, the lane still running: not restarted, the lock still held; the main loop's item 1 is done, so the main
  // loop is NOT woken for the lane's item
  c.w('company/work/handoffs/to-sam.md', c.r('company/work/handoffs/to-sam.md').replace('**Status:** OPEN\n**Touches:** src/intake/', '**Status:** DONE — built\n**Touches:** src/intake/'));
  await c.lastRun('sam', 30);
  const r2 = c.tick();
  assert.equal(r2.laneCreates.length, 0); assert.ok(!r2.firedSeats.includes('sam'), 'the main loop is not woken for a lane-owned item: ' + r2.log.slice(-600));
  assert.match(r2.log, /LANES: main loop not woken for Sam: every open item is owned by a live lane/);
  assert.equal(c.locks().length, 1);

  // the lane does its work in its worktree, commits, writes its result; the station run ends
  fs.writeFileSync(path.join(body.workdir, 'docs', 'api.md'), '# API\n\nGET /intake\n');
  git(body.workdir, 'add', '-A'); git(body.workdir, '-c', 'user.name=Sam', '-c', 'user.email=s@x', 'commit', '-q', '-m', 'API docs');
  fs.writeFileSync(path.join(body.workdir, 'LANE-RESULT.md'), 'Status: DONE — documented GET /intake\nEdited docs/api.md, committed.\n');
  await st('POST', '/__finish', { id: laneJob.id, status: 'ok' });
  const r3 = c.tick();
  assert.equal(c.lanes().lanes.length, 0, r3.log); assert.equal(c.locks().length, 0, 'the lock is released');
  assert.ok(r3.mine.some(x => x.path === '/api/cron/remove' && x.body.id === laneJob.id), 'the lane routine is removed');
  const inbox = c.r('company/work/handoffs/to-sam.md');
  assert.ok(!/\*\*Lane:\*\*/.test(inbox), 'the Lane line is gone');
  assert.match(inbox, /\*\*Lane result \(lane 1, run run-\d+, [^)]+\):\*\* DONE — documented GET \/intake; branch `lane\/sam-1-\S+` in the company repo has 1 commit\(s\), not merged: review and merge it/);
  assert.match(inbox, /write the API docs\n\*\*Need:\*\* do it\n\*\*Status:\*\* OPEN/, 'unmerged commits: the item stays OPEN for the seat\'s review flow');
  assert.ok(git(c.T, 'branch', '--list', lane.branch), 'the branch is kept'); assert.ok(!fs.existsSync(path.join(body.workdir, 'docs')), 'the worktree is removed');
  assert.equal(git(c.T, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main'); assert.equal(git(c.T, 'log', '--oneline').split('\n').length, 1, 'nothing merged into the main checkout');
  assert.match(r3.log, /LANE END sam\/1 \(Sam, "2026-11-17 from Alex — write the API docs"\): DONE, 1 commit\(s\)/);
  assert.equal(c.lanes().history[0].outcome, 'DONE');
  // locked-watch saw a lane routine with the seat's own fields: nothing flagged
  let flagged = ''; try { flagged = c.r('company/work/security/locked-changes.jsonl'); } catch (_) {}
  assert.ok(!/Lane sam/.test(flagged), flagged.slice(0, 400));
});

test('a lane run the model refused is re-run once on the seat\'s next model, the same item; refused again, it is said plainly and goes back to the main loop', async () => {
  const c = await company({ handoffs: SAM2, hold: ['Lane '] });
  c.w('company/model-policy.json', { seats: { sam: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } } });
  await st('POST', '/api/cron/update', { id: c.ids.sam, patch: { model: 'claude-sonnet-5-5' } });
  c.tick();
  const lane = c.lanes().lanes[0]; assert.ok(lane && lane.runId);
  const runsF = path.join(c.T, '.starnet-data', 'workspaces', 'runs.jsonl');
  const refuse = (runId, provider, model) => fs.appendFileSync(runsF, JSON.stringify({ runId, cronJobId: 'x', agentId: 'sam', provider, model, outcome: 'refused', failureCode: 'content_policy_blocked', reason: 'refused', startedAt: Date.now() - 60000, endedAt: Date.now() }) + '\n');
  refuse(lane.runId, 'claude-cli', 'claude-sonnet-5-5');
  await st('POST', '/__finish', { id: lane.jobId, status: 'error' });
  await c.lastRun('sam', 1);
  const r2 = c.tick();
  const now = c.lanes().lanes.find(l => l.id === 'sam/1');
  assert.ok(now && now.runId !== lane.runId && now.retryOf === lane.runId && now.provider !== 'claude-cli' && now.heading === lane.heading, r2.log.slice(-800));
  assert.match(r2.log, /LANE RETRY sam\/1: Claude declined this; DeepSeek takes the lane instead/); assert.equal(now.provider, 'deepseek');
  assert.match(c.r('company/state/model-moves.jsonl'), /"direction":"refusal".*"door":"lane"|"door":"lane".*"direction":"refusal"/);
  // the retry is refused too: no third run, said plainly, the item goes back to the main loop
  refuse(now.runId, now.provider, now.model);
  await st('POST', '/__finish', { id: now.jobId, status: 'error' });
  const r3 = c.tick();
  assert.ok(!c.lanes().lanes.some(l => l.id === 'sam/1'), r3.log.slice(-600));
  assert.match(r3.log, /LANE REFUSED sam\/1: \S+ declined it too after a retry; the item goes back to the seat's main loop/);
  assert.equal(r3.laneCreates.length, 0);
});

test('a writer\'s lane works in a scratch folder (its own project root); a DONE without commits closes the item', async () => {
  const c = await company({ handoffs: { 'to-kim.md': block('draft the guide', 'docs/guide.md') + block('draft the FAQ', 'company/work/faq.md') }, hold: ['Lane '] });
  const r = c.tick();
  assert.equal(r.laneCreates.length, 1, r.log);
  const b = r.laneCreates[0].body; b.prompt = (await c.cron()).find(j => j.name === b.name).prompt; assert.match(b.prompt, /scratch folder/);
  assert.ok(fs.existsSync(path.join(b.workdir, '.git')), 'a scratch lane folder is its own repo, so the station blesses exactly it');
  fs.writeFileSync(path.join(b.workdir, 'LANE-RESULT.md'), 'Status: DONE — FAQ drafted\n');
  const job = (await c.cron()).find(j => j.name === b.name);
  await st('POST', '/__finish', { id: job.id });
  c.tick();
  assert.match(c.r('company/work/handoffs/to-kim.md'), /draft the FAQ\n\*\*Need:\*\* do it\n\*\*Status:\*\* DONE — FAQ drafted \(lane 1\)/);
});

test('the CEO never gets lanes; an item without Touches keeps the seat at one lane', async () => {
  const c = await company({ handoffs: { 'to-founder.md': block('approve the plan', 'docs/plan.md') + block('approve the budget', 'docs/budget.md'), 'to-sam.md': block('a', 'src/intake/') + block('b no touches') } });
  const r = c.tick();
  assert.equal(r.laneCreates.length, 0, r.log);
  const m = c.json('company/state/sprint-metrics.json');
  assert.equal(m.lanes.agent.max, 1); assert.match(m.lanes.agent.why, /CEO/);
});

test('caps: lanes per seat (main loop included) and lanes in the whole company', async () => {
  const three = block('one', 'src/intake/') + block('two', 'docs/api.md') + block('three', 'src/dates.js');
  const c = await company({ handoffs: { 'to-sam.md': three, 'to-mo.md': three }, sprintCfg: { lanes: 2, maxLanesTotal: 1 }, hold: ['Lane '] });
  const r = c.tick();
  assert.equal(r.laneCreates.length, 1, 'one lane in the company (maxLanesTotal 1), one per seat (lanes 2 = main loop + 1): ' + r.log);
  assert.match(r.log, /SPRINT LANES held: .*the company is at its 1 lanes/);
  const c2 = await company({ handoffs: { 'to-sam.md': three }, sprintCfg: { lanes: 3 }, hold: ['Lane '] });
  const r2 = c2.tick();
  assert.equal(r2.laneCreates.length, 2, 'lanes 3: the main loop plus two lanes');
  assert.deepEqual(c2.locks().map(l => l.lane).sort(), ['sam/1', 'sam/2']);
});

test('money and tempo: the daily cap holds a metered seat\'s lane; a paused loop, a soft halt and Sprint off start none', async () => {
  const two = block('one', 'src/intake/') + block('two', 'docs/api.md');
  const now = Date.now();
  const capped = await company({ handoffs: { 'to-mo.md': two }, dailyUsd: 1, runs: [{ runId: 'x', agentId: 'mo', provider: 'deepseek', usd: 2, startedAt: now - HOUR, endedAt: now - HOUR + 1000 }] });
  const r = capped.tick();
  assert.equal(r.laneCreates.length, 0, r.log);
  const paused = await company({ handoffs: { 'to-sam.md': two }, patch: { sam: { enabled: false } } });
  assert.equal(paused.tick().laneCreates.length, 0);
  const soft = await company({ handoffs: { 'to-sam.md': two }, halt: { mode: 'soft', by: 'Pat', at: new Date().toISOString() } });
  const rs = soft.tick(); assert.equal(rs.laneCreates.length, 0); assert.match(rs.log, /HALTED \(soft/);
  const off = await company({ sprint: false, handoffs: { 'to-sam.md': two } });
  assert.equal(off.tick().laneCreates.length, 0);
  const one = await company({ handoffs: { 'to-sam.md': two }, sprintCfg: { lanes: 1 } });
  assert.equal(one.tick().laneCreates.length, 0, 'lanes 1: no extra lane');
  // a subscription seat is not held by the metered cap
  const sub = await company({ handoffs: { 'to-sam.md': two }, dailyUsd: 1, runs: [{ runId: 'x', agentId: 'mo', provider: 'deepseek', usd: 2, startedAt: now - HOUR, endedAt: now - HOUR + 1000 }], hold: ['Lane '] });
  assert.equal(sub.tick().laneCreates.length, 1);
});

test('a hard halt cuts lanes off: run stopped, lock released, handoff told', async () => {
  const c = await company({ handoffs: SAM2, hold: ['Lane '] });
  c.tick();
  assert.equal(c.lanes().lanes.length, 1);
  const runId = c.lanes().lanes[0].runId;
  const n = reqs().length;
  const h = spawnSync(process.execPath, [path.join(REPO, 'company', 'tools', 'halt.js'), 'hard', '--by', 'Pat', '--why', 'test'], { cwd: c.T, encoding: 'utf8', env: c.env(), timeout: 60000 });
  assert.equal(h.status, 0, h.stdout + h.stderr);
  assert.ok(reqs().slice(n).some(x => x.path === '/api/halt'), 'the station E-STOP');
  assert.equal(c.lanes().lanes.length, 0); assert.equal(c.locks().length, 0);
  assert.equal(c.lanes().history[0].outcome, 'halt');
  assert.match(c.r('company/work/handoffs/to-sam.md'), /\*\*Lane result \(lane 1, run run-\d+, [^)]+\):\*\* the lane was cut off by a hard halt\./);
  assert.ok(runId);
  await st('POST', '/api/halt/resume', { confirm: true });
});

test('a lane that hangs is stopped at its time limit and its lock released', async () => {
  const c = await company({ handoffs: SAM2, hold: ['Lane '], sprintCfg: { lanes: 2, laneTimeoutMin: 5 } });
  c.tick();
  const lane = c.lanes().lanes[0]; assert.ok(lane && lane.runId);
  const n = reqs().length;
  const r = c.tick({ LANES_CLOCK_SKEW_MIN: '6' });   // six minutes later
  assert.ok(reqs().slice(n).some(x => x.path === '/api/cancel' && x.body.runId === lane.runId), 'the hung run is cancelled: ' + r.log.slice(-500));
  assert.equal(c.lanes().lanes.length, 0, 'the hung lane is gone, and its item is not given a second lane (it goes back to the main loop)');
  assert.equal(c.locks().length, 0, 'its lock is released');
  assert.equal(c.lanes().history[0].outcome, 'timeout');
  assert.match(c.r('company/work/handoffs/to-sam.md'), /the lane was stopped after its 5 min limit/);
});

test('locked-watch: a lane routine with its seat\'s own grants is the seat\'s; one with more grants is not', async () => {
  const L = require('../lanes.js');
  const loops = { agents: { sam: SEATS.sam } };
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-lw-'))); roots.push(T);
  fs.mkdirSync(path.join(T, 'company', 'tools'), { recursive: true }); fs.writeFileSync(path.join(T, 'company', 'tools', 'loops.json'), JSON.stringify(loops));
  const p = spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(path.join(REPO, 'company', 'tools', 'lanes.js'))});
    const T = ${JSON.stringify(T)};
    const loop = { id: 'j1', name: 'Sam loop', agentId: 'sam', workdir: T, unattendedGrants: ['workbench', 'connectors'] };
    const lane = { id: 'j2', name: 'Lane 0a1b2c3d', agentId: 'sam', workdir: T + '/company/work/lanes/sam/1', unattendedGrants: ['connectors', 'workbench'] };
    const more = Object.assign({}, lane, { id: 'j3', unattendedGrants: ['workbench', 'connectors', 'studio'] });
    const elsewhere = Object.assign({}, lane, { id: 'j4', workdir: '/tmp' });
    console.log(JSON.stringify([L.isLaneJob(lane, [loop, lane], T), L.isLaneJob(more, [loop, more], T), L.isLaneJob(elsewhere, [loop, elsewhere], T), L.isLaneJob(loop, [loop], T)]));
  `], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(p.stdout.trim()), [true, false, false, false], p.stderr);
  assert.ok(L.CAPABILITY === 'workspace-lease-per-folder');
});

test('a lane is routed like a wake: live + an open pair passes the one-run override, recorded on its wake row (door lane)', async () => {
  const c = await company({ hold: ['Lane '], handoffs: { 'to-sam.md': block('build the intake form', 'src/intake/') + block('write the API docs', 'docs/api.md').replace('**Need:**', '**Class:** writing\n**Need:**') } });
  const pol = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'models', 'routing-policy.json'), 'utf8'));
  pol.mode = 'live'; pol.tierCaps.mode = 'off';
  c.w('company/work/models/routing-policy.json', pol);
  c.w('company/departments.json', { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['sam'], defaultClass: 'code', routes: { writing: { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' } } }] });
  c.w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: { sam: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }] } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.equal(r.laneCreates.length, 1, r.log);
  const laneJob = (await c.cron()).find(j => j.name === r.laneCreates[0].body.name);
  const laneRun = r.mine.find(x => x.path === '/api/cron/run' && x.body.id === laneJob.id);
  assert.deepEqual(laneRun.body, { id: laneJob.id, detach: true, provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' });
  const rows = c.r('company/state/wakes.jsonl').trim().split('\n').map(l => JSON.parse(l));
  const lw = rows.find(x => x.door === 'lane');
  assert.deepEqual([lw.route.applied, lw.route.source, lw.route.class], [true, 'route', 'writing']);
  // the main loop's item names no class: the department default (code) has no route here, so it runs on its chain
  const mainRun = r.mine.find(x => x.path === '/api/cron/run' && x.body.id === c.ids.sam);
  assert.deepEqual(Object.keys(mainRun.body).sort(), ['detach', 'id']);
  const mw = rows.find(x => x.door === 'dispatch' && x.seat === 'sam');
  assert.equal(mw.route.class, 'code'); assert.equal(mw.route.applied, false);
  const log = c.r('company/work/models/routing-decisions.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.some(x => x.door === 'lane' && x.wakeId === lw.wakeId) && log.some(x => x.door === 'dispatch' && x.wakeId === mw.wakeId), JSON.stringify(log));
});
