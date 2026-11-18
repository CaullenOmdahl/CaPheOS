#!/usr/bin/env node
/* budget-gate.test.js — phase 1 of the budget redesign, "one gate, counting only" (docs/BUDGET.md), against the real
 * dispatch.js, watchdog.js, budget.js and budget-migrate.js and tests/mock-station.js on a free port. The six acceptance
 * tests of the owner's revision, plus the units under them:
 *   1. bypass: the 16-run pattern (a loop the station's schedule fires every hour) is reproduced in a fixture and on the
 *      mock, recorded as door "schedule", and gone once the dispatcher owns the schedule (24 h of station ticks start no
 *      crew run; the dispatcher starts the due loop itself, through admit());
 *   2. coverage: every run in a 24 h fixture carries a door; one unattributed run fails `budget.js coverage`;
 *   3. lane parity: no money check is left in lanes.js (grep), and lanes and the dispatcher get identical admit() answers
 *      and identical money verdicts for the same blocking seat;
 *   4. dispatcher outage: the watchdog alerts once, top priority, and ZERO work runs start (asserted on the station);
 *   5. drift: a setting changed without apply fails drift naming both numbers; apply makes it pass;
 *   6. reversibility: back to runtime.scheduler=station, the routines, schedules and old behaviour return intact.
 *   node --test company/tools/tests/budget-gate.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3, HOUR = 3600e3;
const TOKEN = 'budget-gate-token';
const SEATS = {
  agent: { name: 'Alex', title: 'Founder and CEO', functions: ['ceo', 'finance'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null, provider: 'deepseek', schedule: 'every 1 hour' },
  sam: { name: 'Sam', title: 'Engineer', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli', schedule: 'every 2 hours' },
};

let mock = null, port = 0; const roots = [];
test.before(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gate-mock-')); roots.push(d);
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', path.join(d, 'req.jsonl')], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let s = ''; mock.stdout.on('data', c => { s += c; const m = /"port":(\d+)/.exec(s); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800); assert.notEqual(port, 8810);
  mock.logFile = path.join(d, 'req.jsonl');
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/* a company on the mock. o.scheduler (absent = station), o.dailyUsd, o.handoffs {inbox: text} */
async function company(o) {
  o = o || {};
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gate-co-'))); roots.push(T);
  const tag = path.basename(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  const cfg = { name: 'Gate Test ' + tag, owner: { name: 'Pat' }, timezone: 'UTC', station: { port, serviceName: 'gate-test' } };
  if (o.scheduler) cfg.runtime = { scheduler: o.scheduler, schedulerSetBy: o.setBy === undefined ? 'budget-migrate.js' : o.setBy };
  w('company/company.json', cfg);
  w('secrets/station-token', TOKEN + '\n');
  for (const f of ['watchdog.js', 'lib/admit.js', 'lib/scheduler.js']) { const d = path.join(T, 'company', 'tools', f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.symlinkSync(path.join(TOOLS, f), d); }   // the framework files the migration checks for
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8')); cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: o.dailyUsd != null ? o.dailyUsd : 5, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/work/ops/duty-policy.json', { duties: Object.fromEntries(['handoff-status', 'tool-parse', 'connector-scope', 'backup-freshness', 'module-doctor', 'unregistered-services', 'budget-drift'].map(id => [id, { enabled: false }])) });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  const agents = {}, ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
    const name = s.loop + ' ' + tag;
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: s.provider, model: s.provider === 'deepseek' ? 'deepseek-flash' : 'claude-haiku-5', schedule: s.schedule, workdir: T, unattendedGrants: ['workbench'] });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { lastRunAt: new Date(Date.now() - 30 * MIN).toISOString(), inFlight: false } });
    agents[id] = Object.assign({}, s, { loop: name }); delete agents[id].provider; delete agents[id].schedule;
  }
  w('company/tools/loops.json', { agents });
  const c = { T, tag, ids, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
  c.env = extra => Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: 'UTC', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '', ADMIT_LOG: '' }, extra || {});
  c.node = (args, extra) => spawnSync(process.execPath, args, { cwd: T, encoding: 'utf8', timeout: 170000, env: c.env(extra) });
  c.tick = () => {
    const n = reqs().length; const p = c.node([path.join(TOOLS, 'dispatch.js')]); const mine = reqs().slice(n);
    const fired = mine.filter(x => x.path === '/api/cron/run' && x.method === 'POST').map(x => x.body.id);
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), mine, fired, firedSeats: Object.keys(ids).filter(k => fired.includes(ids[k])).sort(), log: c.r('company/work/dispatch-log.md') };
  };
  // the migration as the owner runs it (plan + apply, in a process rooted at this company)
  c.migrate = (to, extra) => {
    const js = 'const M=require(' + JSON.stringify(path.join(TOOLS, 'budget-migrate.js')) + ');M.plan({to:' + JSON.stringify(to) + '}).then(async p=>{const nothing=!p.flag&&!p.pause.length&&!p.resume.length&&!p.createWatchdog&&!p.removeWatchdog.length;const r=nothing?{done:[],errors:[]}:await M.apply(p,"owner");console.log(JSON.stringify({plan:{pause:p.pause.length,resume:p.resume.length,create:p.createWatchdog,remove:p.removeWatchdog.length,flag:p.flag,blockers:p.blockers},r}))})';
    const p = c.node(['-e', js], extra); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout.trim().split('\n').pop());
  };
  c.jobs = async () => (await st('GET', '/api/cron')).jobs;
  c.mine = async () => (await c.jobs()).filter(j => Object.values(ids).includes(j.id) || (j.noAgent && j.workdir === T)).map(j => j.id);   // this company's routines
  c.stTick = async now => st('POST', '/__tick', { now, only: await c.mine() });
  c.workRuns = async () => (await st('GET', '/__state')).runs.filter(r => Object.values(ids).includes(r.cronJobId)).length;   // station-scheduled runs of this company's loops
  c.admits = () => c.r('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  c.lastRun = async (id, minAgo) => st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - minAgo * MIN).toISOString() } });
  return c;
}

/* ---------------- units ---------------- */
test('admit(): phase 1 always allows, and every call is one logged row {door, seat, kind, decision, reason} (I2)', () => {
  const A = require('../lib/admit');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gate-admit-')), 'log.jsonl'); roots.push(path.dirname(f));
  for (const door of A.DOORS) { const t = A.admit({ door, kind: door === 'act' ? 'act' : door === 'watchdog' ? 'watchdog' : 'run', seat: 's1', amountUsd: door === 'act' ? 250 : undefined }, { file: f }); assert.equal(t.decision, 'allow'); }
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, A.DOORS.length);
  for (const r of rows) for (const k of ['door', 'seat', 'kind', 'decision', 'reason']) assert.ok(r[k] != null, k + ' in ' + JSON.stringify(r));
  assert.equal(rows.find(r => r.door === 'act').amountUsd, 250);
  assert.throws(() => A.admit({ door: 'backdoor', kind: 'run' }, { file: f }), /unknown door/);
  assert.throws(() => A.admit({ door: 'dispatch', kind: 'spend' }, { file: f }), /unknown kind/);
  assert.equal(A.admit({ door: 'dispatch', kind: 'run' }, { file: f, dry: true }).decision, 'allow');
  assert.equal(fs.readFileSync(f, 'utf8').trim().split('\n').length, A.DOORS.length, 'a dry run writes nothing');
});

test('the seat schedule: intervals and 5-field cron in the company time zone, anchored on the last run', () => {
  const S = require('../lib/scheduler');
  const t0 = Date.UTC(2026, 10, 17, 10, 30);
  assert.equal(S.lastDue({ kind: 'interval', minutes: 60 }, t0, t0 + 59 * MIN, 'UTC'), null);
  assert.equal(S.lastDue({ kind: 'interval', minutes: 60 }, t0, t0 + 61 * MIN, 'UTC'), t0 + 60 * MIN);
  assert.equal(S.lastDue({ kind: 'cron', expr: '0 */2 * * *' }, t0, t0 + 20 * MIN, 'UTC'), null);
  assert.equal(S.lastDue({ kind: 'cron', expr: '0 */2 * * *' }, t0, t0 + 95 * MIN, 'UTC'), Date.UTC(2026, 10, 17, 12, 0));
  assert.equal(S.lastDue({ kind: 'cron', expr: '0 9 * * 1-5' }, Date.UTC(2026, 10, 21, 12), Date.UTC(2026, 10, 22, 23), 'UTC'), null, 'a weekend has no weekday 09:00');
  assert.equal(S.lastDue({ kind: 'cron', expr: '0 9 * * *' }, Date.UTC(2026, 10, 17, 1), Date.UTC(2026, 10, 17, 3), 'Asia/Ho_Chi_Minh'), Date.UTC(2026, 10, 17, 2), '09:00 in UTC+7 is 02:00 UTC');
  assert.deepEqual(S.scheduleOf({ loopEvery: 'every 45m' }, { schedule: { kind: 'interval', minutes: 120 } }).minutes, 45, 'cadence.json loopEvery wins');
  assert.equal(S.scheduleOf({}, { schedule: { kind: 'interval', minutes: 120 } }).minutes, 120, 'else the routine\'s own schedule');
});

/* ---------------- 1. bypass ---------------- */
test('1 bypass: 16 hourly runs from the station\'s own schedule are door "schedule"; with the dispatcher owning the schedule 24 h of station ticks start none, and the due loop runs through admit()', async () => {
  const c = await company({});
  // (a) the measured pattern as a fixture: the Founder loop "every 1h" fired by the station 16 times, no admit() row
  const now = Date.now();
  const runs = Array.from({ length: 16 }, (_, i) => ({ runId: 'sched-' + i, agentId: 'agent', provider: 'deepseek', usd: 0.0494, wireSource: 'routine', cronJobId: c.ids.agent, streamId: 'cron-sched-' + i, startedAt: now - (16 - i) * HOUR, endedAt: now - (16 - i) * HOUR + 5 * MIN }));
  c.w('.starnet-data/workspaces/runs.jsonl', runs.map(r => JSON.stringify(r)).join('\n') + '\n');
  let p = c.node([path.join(TOOLS, 'budget.js'), 'doors', '--json']);
  let j = JSON.parse(p.stdout);
  assert.equal(j.byDoor.schedule, 16, p.stdout); assert.equal(j.runs.filter(r => r.via === 'admit').length, 0);
  // (b) live, station mode: the station's tick fires the due Founder loop around the dispatcher
  await st('POST', '/api/cron/arm', { enabled: true });
  await c.lastRun('agent', 61); await c.lastRun('sam', 30);
  let tk = await c.stTick();
  assert.deepEqual(tk.fired.map(f => f.id), [c.ids.agent], 'station mode: the station starts the loop itself');
  const live = (await st('GET', '/__state')).runs.filter(r => r.cronJobId === c.ids.agent);
  assert.deepEqual(require('../lib/admit').attribute(live, c.admits()).map(r => r.door), ['schedule'], 'recorded as door "schedule": nothing admitted it');
  // (c) the dispatcher takes the schedule over: crew loops paused, the watchdog the only armed routine
  const m = c.migrate('dispatcher');
  assert.equal(m.plan.pause, 2); assert.ok(m.plan.create); assert.ok(m.plan.flag); assert.deepEqual(m.r.errors, []);
  assert.equal(JSON.parse(c.r('company/company.json')).runtime.scheduler, 'dispatcher');
  const jobs = await c.jobs();
  assert.equal(jobs.find(x => x.id === c.ids.agent).enabled, false); assert.equal(jobs.find(x => x.id === c.ids.sam).enabled, false);
  const wd = jobs.filter(x => x.noAgent && x.script === 'company/tools/watchdog.js' && x.workdir === c.T); assert.equal(wd.length, 1, 'one watchdog routine');
  // 24 hours of the station's own scheduler, every 15 minutes: only the watchdog fires, no crew run starts
  const before = await c.workRuns(); const firedAll = [];
  for (let i = 1; i <= 96; i++) { tk = await c.stTick(Date.now() + i * 15 * MIN); firedAll.push(...tk.fired); }
  assert.ok(firedAll.length >= 90 && firedAll.every(f => f.noAgent && f.id === wd[0].id), 'only the watchdog: ' + JSON.stringify(firedAll.filter(f => !f.noAgent)));
  assert.equal(await c.workRuns(), before, 'zero station-scheduled work runs in 24 h');
  // and the dispatcher starts the due loop itself, through admit() (door dispatch), with no other work to do
  await c.lastRun('agent', 61); await c.lastRun('sam', 30);
  const t = c.tick();
  assert.equal(t.code, 0, t.out);
  assert.deepEqual(t.firedSeats, ['agent'], t.log);
  assert.match(t.log, /RUN Founder loop .* \(scheduled loop \(every 60m, due/);
  const a = c.admits().filter(r => r.door === 'dispatch' && r.seat === 'agent');
  assert.equal(a.length, 1); assert.equal(a[0].decision, 'allow'); assert.match(a[0].why, /scheduled loop/);
  const out = c.admits().find(r => r.ref === a[0].id); assert.equal(out.outcome, 'started');
  // the run it started is attributed to door dispatch, not schedule
  const started = (await st('GET', '/__state')).runs.slice(-1).map(r => Object.assign({}, r, { cronJobId: c.ids.agent }));
  const att = require('../lib/admit').attribute(started, c.admits());
  assert.equal(att[0].door, 'dispatch'); assert.equal(att[0].via, 'admit');
  // a second tick inside the hour starts nothing: the schedule is the rest
  assert.deepEqual(c.tick().firedSeats, []);
});

/* ---------------- 2. coverage ---------------- */
test('2 coverage: 100% of the runs in a 24 h fixture carry a door; one unattributed run fails coverage and is named', async () => {
  const c = await company({ scheduler: 'dispatcher' });
  const now = Date.now(); const admits = [], runs = [];
  const seat = { dispatch: 'agent', lane: 'sam', hire: 'cand-1', chat: 'agent', console: 'sam', halt: 'agent', onboard: 'agent', pacer: 'sam' };
  let k = 0;
  for (let h = 23; h >= 1; h--) for (const [door, s] of Object.entries(seat)) {
    const at = now - h * HOUR + (k++ % 7) * MIN; const id = 'adm-' + k;
    admits.push({ ts: new Date(at).toISOString(), at, id, phase: 1, door, kind: 'run', seat: s, decision: 'allow', reason: 'x' });
    admits.push({ ts: new Date(at + 500).toISOString(), at: at + 500, ref: id, outcome: 'started', status: 200 });
    runs.push({ runId: 'r-' + k, agentId: s, startedAt: at + 1500, endedAt: at + 60e3, usd: 0, streamId: door === 'chat' ? 'console-' + k : door === 'hire' ? 'interview-' + k : 'cron-r-' + k });
    if (door === 'dispatch' && h % 6 === 0) runs.push({ runId: 'child-' + k, parentRunId: 'r-' + k, agentId: 'helper', startedAt: at + 9000, endedAt: at + 20e3, usd: 0 });
  }
  runs.push({ runId: 'hc-1', agentId: 'agent', startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 2000, streamId: 'aicheck-deepseek-1', usd: 0.0001 });   // a health check from the station's own page
  c.w('.starnet-data/workspaces/runs.jsonl', runs.sort((a, b) => a.endedAt - b.endedAt).map(r => JSON.stringify(r)).join('\n') + '\n');
  c.w('company/state/admit-log.jsonl', admits.map(r => JSON.stringify(r)).join('\n') + '\n');
  let p = c.node([path.join(TOOLS, 'budget.js'), 'coverage', '--json']);
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.runs.length, runs.length); assert.ok(j.runs.every(r => r.door), 'every run has a door');
  assert.equal(j.byDoor.schedule, undefined, 'no run is the station schedule\'s: ' + JSON.stringify(j.runs.filter(r => r.door === 'schedule')));
  for (const d of Object.keys(seat)) assert.equal(j.byDoor[d] >= 23, true, d + ': ' + j.byDoor[d]);
  const kids = j.runs.filter(r => r.child);
  assert.ok(kids.length > 0 && kids.every(r => r.door === 'delegate' && r.parentDoor === 'dispatch' && r.lead === 'agent' && /^r-/.test(r.parentRunId)), 'a child run is door "delegate", with its parent run, its lead and the family\'s door: ' + JSON.stringify(kids[0]));
  assert.equal(j.byDoor.delegate, kids.length, 'budget.js doors reports the delegate door');
  assert.ok(!j.unattributed.some(r => r.child), 'no child run is unattributed');
  // one run nobody admitted
  fs.appendFileSync(path.join(c.T, '.starnet-data/workspaces/runs.jsonl'), JSON.stringify({ runId: 'ghost-1', agentId: 'mystery', startedAt: now - 30 * MIN, endedAt: now - 29 * MIN, usd: 0.2 }) + '\n');
  p = c.node([path.join(TOOLS, 'budget.js'), 'coverage']);
  assert.equal(p.status, 1, p.stdout); assert.match(p.stdout, /UNATTRIBUTED: ghost-1 \(mystery\)/);
});

/* ---------------- 3. lane parity ---------------- */
test('3 lane parity: no money check is left in lanes.js, and lanes and the dispatcher get the same admit() answer and money verdict for a blocking seat', () => {
  const lanes = fs.readFileSync(path.join(TOOLS, 'lanes.js'), 'utf8');
  const code = lanes.split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');   // the code, not its comments
  for (const re of [/spreadHold\s*\(/, /\bcapped\s*\?/, />=\s*b\.perAgentUsd/, /b\.dailyUsd\s*>/, /sprintBudgetLeft\s*<=/, /\bcapDecision\b/]) assert.ok(!re.test(code), 'lanes.js still has ' + re);
  assert.match(code, /A\.money\(/); assert.match(code, /A\.admit\(\{ door: 'lane'/);
  const dispatch = fs.readFileSync(path.join(TOOLS, 'dispatch.js'), 'utf8');
  assert.ok(!/SP\.spreadHold\(/.test(dispatch), 'the dispatcher has no copy of the spread either'); assert.match(dispatch, /A\.admit\(\{ door: 'dispatch'/);
  const A = require('../lib/admit');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'budget-gate-parity-')), 'log.jsonl'); roots.push(path.dirname(f));
  const d = A.admit({ door: 'dispatch', kind: 'run', seat: 'mo', priority: 'blocking' }, { file: f }), l = A.admit({ door: 'lane', kind: 'run', seat: 'mo', priority: 'blocking' }, { file: f });
  assert.deepEqual([d.decision, d.reason, d.seat], [l.decision, l.reason, l.seat]);
  for (const b of [{ capped: true }, { share: { usd: 1, spent: 2 } }, { spread: { on: true, cap: 4, spent24h: 3, spentLastHour: 3, hoursLeft: 4 } }, {}]) {
    const inp = Object.assign({ metered: true, capOn: true }, b);
    assert.deepEqual(A.money(inp), A.money(JSON.parse(JSON.stringify(inp))), 'one function, one answer');
  }
});

/* ---------------- 4. dispatcher outage ---------------- */
test('4 dispatcher outage: the watchdog alerts once, top priority, and zero work runs start', async () => {
  const c = await company({ scheduler: 'dispatcher', handoffs: { 'to-sam.md': '\n## 2026-11-17 from Alex — urgent fix\n**Need:** do it\n**Status:** OPEN\n' } });
  c.migrate('dispatcher');
  await st('POST', '/api/cron/arm', { enabled: true });
  c.w('company/state/dispatcher-loop.json', { status: 'stopped', lastTickAt: new Date(Date.now() - 3 * HOUR).toISOString(), lastTickEndAt: new Date(Date.now() - 3 * HOUR).toISOString() });
  await new Promise(r => setTimeout(r, 300));   // the mock logs a request after answering it
  const n0 = reqs().length; const runs0 = (await st('GET', '/__state')).runs.filter(r => ['agent', 'sam'].includes(r.agentId)).length;
  const w1 = c.node([path.join(TOOLS, 'watchdog.js')]), w2 = c.node([path.join(TOOLS, 'watchdog.js')]);
  assert.equal(w1.status, 0); assert.equal(w2.status, 0);
  assert.equal(w1.stdout.trim().split('\n').pop(), '{"wakeAgent":false}', 'the station never wakes an agent for it');
  assert.deepEqual(reqs().slice(n0).filter(r => !r.path.startsWith('/__')).map(r => r.method + ' ' + r.path), [], 'the watchdog makes no station call');
  const out = c.r('company/owner/outbound.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(out.length, 1, 'one alert per outage'); assert.equal(out[0].priority, 'top'); assert.match(out[0].text, /^The crew's work has stopped: nothing new has started for 18\d minutes/); assert.match(out[0].technical, /^TOP PRIORITY: the dispatcher has been silent for 18\d minutes/);
  // the station's own schedule for 6 hours: only the watchdog, and no work starts although Sam has an OPEN item
  const firedAll = []; for (let i = 1; i <= 24; i++) firedAll.push(...(await c.stTick(Date.now() + i * 15 * MIN)).fired);
  assert.ok(firedAll.length > 0 && firedAll.every(f => f.noAgent), JSON.stringify(firedAll));
  assert.equal(await c.workRuns(), 0, 'ZERO work runs of this company\'s loops');
  assert.equal((await st('GET', '/__state')).runs.filter(r => ['agent', 'sam'].includes(r.agentId)).length, runs0, 'ZERO work runs on the station');
  assert.equal(reqs().slice(n0).filter(r => (r.path === '/api/cron/run' || r.path === '/api/run') && r.method === 'POST').length, 0, 'no start request reached the station');
  const ad = c.admits(); assert.ok(ad.filter(r => r.door === 'watchdog').length === 2 && ad.every(r => r.door === 'watchdog' && r.kind === 'watchdog'), 'only the watchdog\'s own checks were admitted');
  // the dispatcher back: one recovery line
  c.w('company/state/dispatcher-loop.json', { status: 'sleeping', lastTickEndAt: new Date().toISOString() });
  c.node([path.join(TOOLS, 'watchdog.js')]);
  assert.match(c.r('company/owner/outbound.jsonl').trim().split('\n').pop(), /dispatcher is running again/);
});

/* ---------------- 5. drift ---------------- */
test('5 drift: the station caps follow the settings; a change without apply fails drift naming both numbers; apply passes', async () => {
  const c = await company({ scheduler: 'dispatcher', dailyUsd: 5 });
  c.migrate('dispatcher');
  await st('POST', '/api/budget/caps', { perDay: 25, perAgent: 0 });
  const B = a => c.node([path.join(TOOLS, 'budget.js')].concat(a));
  let p = B(['drift']); assert.equal(p.status, 1); assert.match(p.stdout, /perDay: the station holds \$25, the company setting is \$5/);
  p = B(['apply', '--by', 'Alex']); assert.equal(p.status, 0, p.stderr); assert.equal((await st('GET', '/api/budget/status')).caps.perDay, 5);
  p = B(['drift']); assert.equal(p.status, 0, p.stdout);
  // the owner moves the daily budget to $7 and nobody applies it
  c.w('company/work/finance/dispatch-budget.json', { dailyUsd: 7, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  p = B(['drift']); assert.equal(p.status, 1); assert.match(p.stdout, /the station holds \$5, the company setting is \$7/);
  // the duty (no socket) reads the tick's snapshot: due, by id, routed to finance
  assert.equal(B(['snapshot']).status, 0);
  p = B(['--duty'], { CAPHEOS_NO_NETWORK: '1' }); assert.equal(p.status, 1); const d = JSON.parse(p.stdout); assert.ok(d.items.some(i => i.id === 'cap:perDay' && i.route === 'finance'), p.stdout);
  assert.equal(B(['apply', '--by', 'Alex']).status, 0); assert.equal(B(['drift']).status, 0);
  // a $0 day: the station's own 0 means no cap, so "closed" is its smallest cap
  c.w('company/work/finance/dispatch-budget.json', { dailyUsd: 0, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  assert.equal(B(['apply', '--by', 'Alex']).status, 0); assert.equal((await st('GET', '/api/budget/status')).caps.perDay, 0.000001);
  // scheduler drift: a crew loop switched back on at the station while the dispatcher owns the schedule
  await st('POST', '/api/cron/update', { id: c.ids.sam, patch: { enabled: true } });
  p = B(['drift']); assert.equal(p.status, 1); assert.match(p.stdout, /Sam loop .* is armed on the station schedule/);
  const t = c.tick(); assert.match(t.log, /SCHEDULER: paused "Sam loop/);
  assert.equal(B(['drift']).status, 0);
});

/* ---------------- 6. reversibility ---------------- */
test('6 reversibility: runtime.scheduler back to station returns the routines, their schedules and the old behaviour intact; both directions are idempotent', async () => {
  const c = await company({});
  const snap = async () => (await c.jobs()).filter(j => Object.values(c.ids).includes(j.id)).map(j => [j.id, j.enabled, JSON.stringify(j.schedule)]).sort();
  const original = await snap();
  await c.lastRun('agent', 61);
  assert.deepEqual(c.tick().firedSeats, [], 'station mode: no work, no wake (the station fires the schedule)');
  c.migrate('dispatcher');
  assert.deepEqual(c.migrate('dispatcher').plan, { pause: 0, resume: 0, create: false, remove: 0, flag: false, blockers: [] }, 'a second run changes nothing');
  await c.lastRun('agent', 61);
  assert.deepEqual(c.tick().firedSeats, ['agent'], 'dispatcher mode: the dispatcher starts the due loop');
  const back = c.migrate('station');
  assert.equal(back.plan.resume, 2); assert.equal(back.plan.remove, 1); assert.deepEqual(back.r.errors, []);
  assert.equal(JSON.parse(c.r('company/company.json')).runtime.scheduler, 'station');
  assert.deepEqual(await snap(), original, 'enabled and schedule exactly as before');
  assert.equal((await c.jobs()).filter(j => j.noAgent && j.script === 'company/tools/watchdog.js' && j.workdir === c.T).length, 0, 'the watchdog is gone');
  assert.deepEqual(c.migrate('station').plan, { pause: 0, resume: 0, create: false, remove: 0, flag: false, blockers: [] }, 'idempotent back too');
  await c.lastRun('agent', 61); await c.lastRun('sam', 30);
  // the watchers' own OPEN handoffs to the CEO (dated next day) are work now, a Deadline defers nothing: close them, so
  // the tick below tests the schedule alone
  c.w('company/work/handoffs/to-founder.md', c.r('company/work/handoffs/to-founder.md').replace(/^\*\*Status:\*\* OPEN/gm, '**Status:** DONE — closed by the test'));
  assert.deepEqual(c.tick().firedSeats, [], 'the old behaviour: the dispatcher does not start scheduled loops');
  await st('POST', '/api/cron/arm', { enabled: true });
  const tk = await c.stTick();
  assert.ok(tk.fired.some(f => f.id === c.ids.agent), 'the station fires it on its schedule again');
});

// A "dispatcher" setting that arrived without the migration tool (e.g. a framework update merged into company.json)
// leaves the schedule with the station: the dispatcher must not pause the station's loops on its own.
test('a dispatcher setting with no recorded switch keeps the station schedule', () => {
  const S = require('../lib/scheduler');
  assert.equal(S.mode({ runtime: { scheduler: 'dispatcher' } }), 'station');
  assert.equal(S.mode({ runtime: { scheduler: 'dispatcher', schedulerSetBy: 'hand edit' } }), 'station');
  assert.equal(S.mode({ runtime: { scheduler: 'dispatcher', schedulerSetBy: 'budget-migrate.js' } }), 'dispatcher');
  assert.equal(S.mode({ runtime: { scheduler: 'dispatcher', schedulerSetBy: 'found-company.sh' } }), 'dispatcher');
});

/* ---------------- StarNet's dedupe memory: a 200 that declines (lib/station.js) ---------------- */
// The sandbox bug: StarNet remembered a watchdog deleted by a rollback and answered the re-create with HTTP 200
// {ok:false, declined:true}; the migration printed "done: create watchdog: HTTP 200" and nothing existed.
const WD = () => require('../lib/scheduler').WATCHDOG.name;
const ownWd = async c => (await c.jobs()).filter(j => require('../lib/scheduler').isWatchdog(j) && j.workdir === c.T);
// budget.js's scheduler drift as the company sees it (its root, its jobs), in a process rooted there
const drift = c => { const p = c.node(['-e', 'const B=require(' + JSON.stringify(path.join(TOOLS, 'budget.js')) + ');fetch(process.env.STARNET_URL+"/api/cron",{headers:{"x-starnet-token":' + JSON.stringify(TOKEN) + '}}).then(r=>r.json()).then(j=>console.log(JSON.stringify(B.schedulerDrift(j.jobs,JSON.parse(require("fs").readFileSync("company/tools/loops.json","utf8")).agents,"dispatcher"))))']); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout.trim().split('\n').pop()); };
async function declining(o, fn) { await st('POST', '/__declines', Object.assign({ on: true }, o || {})); try { return await fn(); } finally { await st('POST', '/__declines', { on: false }); } }

test('declines: migrate reports a declined watchdog create and retries under a new unique name', async () => {
  const c = await company({});
  const taken = WD() + ' #aaaaaa';
  const m = await declining({ names: [taken] }, () => c.migrate('dispatcher', { CAPHEOS_ROUTINE_SUFFIXES: 'aaaaaa' }));
  assert.deepEqual(m.r.errors, [], JSON.stringify(m.r));
  assert.equal(m.r.warnings.length, 1); assert.match(m.r.warnings[0], /create watchdog: the station declined \(HTTP 200\): this routine already exists .*retried under a new name/);
  const wd = await ownWd(c);
  assert.equal(wd.length, 1, 'exactly one watchdog'); assert.notEqual(wd[0].name, taken); assert.match(wd[0].name, /^Watchdog \(dispatcher liveness, starts no work\) #[0-9a-f]{6}$/);
  assert.ok(m.r.done.some(d => d.includes(wd[0].name)), JSON.stringify(m.r.done));
});

test('declines: a watchdog the station declines on every try is an ERROR, never "done"', async () => {
  const c = await company({});
  const names = ['a1a1a1', 'b2b2b2', 'c3c3c3'].map(x => WD() + ' #' + x);
  const m = await declining({ names }, () => c.migrate('dispatcher', { CAPHEOS_ROUTINE_SUFFIXES: 'a1a1a1,b2b2b2,c3c3c3' }));
  assert.equal(m.r.errors.length, 3, JSON.stringify(m.r)); assert.ok(m.r.errors.every(e => /declined \(HTTP 200\): this routine already exists/.test(e)));
  assert.ok(!m.r.done.some(d => /watchdog/.test(d)), JSON.stringify(m.r.done));
  assert.equal((await ownWd(c)).length, 0);
  // the CLI exits 1 with the reason (the sandbox run printed "done: create watchdog: HTTP 200" and exited 0)
  const p = await declining({ names: [WD() + ' #d4d4d4'] }, () => c.node([path.join(TOOLS, 'budget-migrate.js'), '--to', 'dispatcher', '--by', 'owner'], { CAPHEOS_ROUTINE_SUFFIXES: 'd4d4d4' }));
  assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /FAILED, RETRIED: create watchdog: the station declined/); assert.equal((await ownWd(c)).length, 1);
});

test('declines: rollback then migrate (the station remembering every removed name) leaves one working watchdog, drift green', async () => {
  const c = await company({});
  await declining({ names: [WD()] }, async () => {   // the sandbox: the old bare-named watchdog is in the dedupe memory too
    const m1 = c.migrate('dispatcher'); assert.deepEqual(m1.r.errors, []);
    const first = await ownWd(c); assert.equal(first.length, 1);
    const back = c.migrate('station'); assert.deepEqual(back.r.errors, []); assert.equal((await ownWd(c)).length, 0);
    const m2 = c.migrate('dispatcher'); assert.deepEqual(m2.r.errors, [], JSON.stringify(m2.r));
    const wd = await ownWd(c); assert.equal(wd.length, 1); assert.notEqual(wd[0].name, first[0].name, 'a fresh name, not the remembered one');
    assert.deepEqual(drift(c).filter(x => x.cap === 'watchdog'), []);
    await st('POST', '/api/cron/arm', { enabled: true });
    const tk = await c.stTick(Date.now() + 16 * MIN); assert.ok(tk.fired.some(f => f.id === wd[0].id), 'the station runs the new watchdog');
  });
});

test('declines: the hand-made sandbox watchdog "… #25f494" is recognised by prefix: migrate creates none, drift and founder-loop status stay green', async () => {
  const c = await company({});
  await st('POST', '/api/cron', { name: WD() + ' #25f494', agentId: 'agent', prompt: 'Script-only watchdog', schedule: 'every 15 minutes', script: 'company/tools/watchdog.js', noAgent: true, workdir: c.T, enabled: true });
  const m = c.migrate('dispatcher');
  assert.equal(m.plan.create, false, 'no second watchdog'); assert.deepEqual(m.r.errors, []);
  const wd = await ownWd(c); assert.equal(wd.length, 1); assert.equal(wd[0].name, WD() + ' #25f494');
  assert.deepEqual(drift(c), []);
  const p = c.node([path.join(TOOLS, 'founder-loop.js'), 'status', '--json']);
  assert.doesNotMatch(p.stdout + p.stderr, /no-watchdog/);
});

test('declines: every routine write the station declines with HTTP 200 is reported as a failure (migrate re-arm/remove, dispatcher pause and watchdog)', async () => {
  const c = await company({});
  assert.deepEqual(c.migrate('dispatcher').r.errors, []);
  const back = await declining({ writes: true }, () => c.migrate('station'));
  assert.equal(back.r.errors.length, 3, JSON.stringify(back.r));   // re-arm x2, remove watchdog
  assert.ok(back.r.errors.every(e => /declined \(HTTP 200\)/.test(e)), JSON.stringify(back.r.errors));
  assert.ok(!back.r.done.some(d => /re-arm|remove/.test(d)), JSON.stringify(back.r.done));
  // the dispatcher's own scheduler upkeep: a pause and a watchdog create that the station declines are SCHEDULER ERRORs
  const d = await company({ scheduler: 'dispatcher' });
  const sfx = ['e5e5e5', 'f6f6f6', 'a7a7a7'];
  const t = await declining({ writes: true, names: sfx.map(x => WD() + ' #' + x) }, async () => { d.node([path.join(TOOLS, 'dispatch.js')], { CAPHEOS_ROUTINE_SUFFIXES: sfx.join(',') }); return { log: d.r('company/work/dispatch-log.md') }; });
  assert.match(t.log, /SCHEDULER ERROR: could not pause ".*": the station declined \(HTTP 200\)/);
  assert.match(t.log, /SCHEDULER ERROR: could not create the watchdog routine: create watchdog.*declined \(HTTP 200\): this routine already exists/);
  assert.doesNotMatch(t.log, /SCHEDULER: (created the watchdog|paused)/);
  assert.equal((await ownWd(d)).length, 0);
});
