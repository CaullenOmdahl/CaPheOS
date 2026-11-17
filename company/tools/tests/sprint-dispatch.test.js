#!/usr/bin/env node
/* sprint-dispatch.test.js — Sprint (start-up) through the real dispatch.js, against tests/mock-station.js.
 *
 * Each case builds a small company in a temp folder (seven seats, their loop routines on the mock station, inboxes, a
 * cadence.json with Sprint on or off) and runs one dispatcher tick, then reads which routines the tick fired from the
 * mock's request log. What it proves while Sprint is on: a seat with open work wakes past its cooldown (floor), a seat
 * with none is never woken, the per-tick limit and the wake caps are lifted, unchanged work is not woken again, a new
 * handoff or a review is, and the daily cap, the spendCap guardrail, the soft halt and the CEO's single run still hold.
 * Nothing here touches a live station or the checkout's company files.
 *
 *   node --test company/tools/tests/sprint-dispatch.test.js
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
const TOKEN = 'sprint-test-token';
// a company timezone where it is about 02:00 now, so "the hours left in the company day" is large and stable
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, wakeOnOwnerMessage: true, priority: 100, manager: null, provider: 'claude-cli' },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli' },
  kim: { name: 'Kim', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent', provider: 'claude-cli' },
  mo: { name: 'Mo', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', provider: 'deepseek' },
  w1: { name: 'Wen', loop: 'Wen loop', inbox: 'to-wen.md', manager: 'agent', provider: 'claude-cli' },
  w2: { name: 'Uma', loop: 'Uma loop', inbox: 'to-uma.md', manager: 'agent', provider: 'claude-cli' },
  riley: { name: 'Riley', functions: ['risk'], loop: 'Riley loop', inbox: 'to-riley.md', manager: 'agent', provider: 'claude-cli' },
};
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n**Status:** OPEN\n' + (extra || '');

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
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
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');

/* a company: o.sprint (true = on since an hour ago), o.handoffs {inbox: text}, o.lastRunMinAgo, o.runs (runs.jsonl rows) */
async function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Sprint Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'sprint-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  w('company/tools/loops.json', { agents });
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = o.sprint ? Object.assign({ on: true, since: new Date(Date.now() - HOUR).toISOString(), until: null, by: 'owner' }, o.sprintCfg || {}) : { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: o.dailyUsd != null ? o.dailyUsd : 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  if (o.guards) w('company/state/guardrails.json', { guards: o.guards });
  if (o.halt) w('company/state/halt.json', o.halt);
  w('company/owner/inbound.jsonl', o.ownerMessage ? JSON.stringify({ id: 'in-1', at: new Date().toISOString(), from: 'Pat', text: 'How is it going?' }) + '\n' : '');
  w('.starnet-data/workspaces/runs.jsonl', (o.runs || []).map(r => JSON.stringify(r)).join('\n') + (o.runs && o.runs.length ? '\n' : ''));
  if (o.wakes) w('company/state/tempo-wakes.json', { wakes: o.wakes });
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
  // the routines on the mock station, each last run lastRunMinAgo minutes ago
  const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);   // unique per company on the shared mock
    const r = await st('POST', '/api/cron', { name, agentId: id + '-' + path.basename(T), prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: s.provider, model: s.provider === 'deepseek' ? 'deepseek-flash' : 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - (o.lastRunMinAgo != null ? o.lastRunMinAgo : 5) * MIN).toISOString(), inFlight: !!(o.inFlight || []).includes(id), name } });
    agents[id].loop = name;
  }
  w('company/tools/loops.json', { agents });
  const co = { T, ids, w, r: rel => fs.readFileSync(path.join(T, rel), 'utf8'), json: rel => JSON.parse(fs.readFileSync(path.join(T, rel), 'utf8')) };
  co.tick = () => {
    const before = runs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const fired = runs().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(Boolean).sort();
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), fired, log: (() => { try { return co.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  co.lastRun = async (id, minAgo) => st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - minAgo * MIN).toISOString() } });
  return co;
}
const WORK = {
  'to-sam.md': block('build the intake form', '**Touches:** src/intake/\n') + block('write the API docs', '**Touches:** docs/api.md\n'),
  'to-mo.md': block('rename the fixtures', '**Effort:** mechanical\n'),
  'to-wen.md': block('draft the pricing page'),
  'to-uma.md': block('check the data feed'),
  'to-founder.md': block('approve the plan'),
};

test('Sprint off: seats inside their cooldown wait (the baseline)', async () => {
  const c = await company({ sprint: false, handoffs: WORK });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, []);
});

test('Sprint on: every seat with open work wakes past its cooldown, in one tick; a seat with none is not woken', async () => {
  const c = await company({ sprint: true, handoffs: WORK });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, ['agent', 'mo', 'sam', 'w1', 'w2'], r.log);   // five wakes: more than the base maxPerTick of 4
  assert.ok(!r.fired.includes('kim') && !r.fired.includes('riley'), 'no empty wakes');
  assert.match(r.log, /RUN Sam loop .*\[Sprint: new work; rest 2 min\]/);
  const m = c.json('company/state/sprint-metrics.json');
  assert.equal(m.wakes, 5);
  // lanes: Sam has two items with disjoint Touches, but the station runs one agent's file work at a time
  assert.equal(m.lanes.sam.possible, 2); assert.equal(m.lanes.sam.max, 1); assert.match(m.lanes.sam.why, /patch 0012/);
  assert.equal(m.lanes.agent.max, 1); assert.match(m.lanes.agent.why, /CEO/);
  assert.match(r.log, /SPRINT LANES held at 1: Sam \(2 independent\)/);
  assert.equal(c.json('company/state/sprint-effort.json').seats.mo, 'mechanical');

  // the next tick: the same work, past the floor but inside the cooldown -> nobody (no empty wakes); the wakes resolve as idle
  for (const id of Object.keys(SEATS)) await c.lastRun(id, 3);
  const r2 = c.tick();
  assert.deepEqual(r2.fired, [], r2.log);
  const m2 = c.json('company/state/sprint-metrics.json');
  assert.equal(m2.resolved, 5); assert.equal(m2.idleWakes, 5);   // the mock runs do nothing, so every wake did nothing

  // new work: a handoff for Sam, a review for Riley (harness-change writes reviews as OPEN handoffs); one of Uma's is done
  fs.appendFileSync(path.join(c.T, 'company/work/handoffs/to-sam.md'), block('fix the date bug', '**Touches:** src/dates.js\n'));
  fs.appendFileSync(path.join(c.T, 'company/work/handoffs/to-riley.md'), block('review hc-0007 (schedule: cadence.json) proposed by Sam'));
  c.w('company/work/handoffs/to-uma.md', '# Handoffs\n' + WORK['to-uma.md'].replace('**Status:** OPEN', '**Status:** DONE — checked'));
  const r3 = c.tick();
  assert.deepEqual(r3.fired, ['riley', 'sam'], r3.log);
  const m3 = c.json('company/state/sprint-metrics.json');
  assert.equal(m3.itemsDone, 1); assert.equal(m3.wakes, 7);
  const status = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'company/tools/cadence.js'), 'sprint', 'status', '--json'], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: c.T, CAPHEOS_TZ: TZ }), encoding: 'utf8' }));
  assert.equal(status.active, true); assert.equal(status.wakes, 7); assert.equal(status.itemsDone, 1); assert.equal(status.idleWakeRatio, 1);
});

test('Sprint on: the hourly and daily wake caps are lifted (they hold with Sprint off)', async () => {
  const wakes = Array.from({ length: 130 }, (_, i) => ({ at: Date.now() - 50 * MIN + i * 1000, seat: 'x' }));
  const off = await company({ sprint: false, handoffs: WORK, lastRunMinAgo: 60, wakes });
  const r0 = off.tick();
  assert.deepEqual(r0.fired, [], r0.log);   // nothing: every wake held by the caps
  assert.match(r0.log, /TEMPO HOLD .* wakes in the last hour, cap 12/);
  const on = await company({ sprint: true, handoffs: WORK, lastRunMinAgo: 60, wakes });
  const r1 = on.tick();
  assert.deepEqual(r1.fired, ['agent', 'mo', 'sam', 'w1', 'w2'], r1.log);
  assert.doesNotMatch(r1.log, /TEMPO HOLD/);
});

test('Sprint on: the daily metered cap still holds a metered seat; subscription seats keep going', async () => {
  const spent = [{ runId: 'x1', agentId: 'mo', provider: 'deepseek', usd: 1.2, startedAt: Date.now() - 3 * HOUR, endedAt: Date.now() - 3 * HOUR + MIN }];
  const c = await company({ sprint: true, handoffs: WORK, runs: spent });
  const r = c.tick();
  assert.ok(!r.fired.includes('mo'), r.log);
  assert.ok(r.fired.includes('sam') && r.fired.includes('w1'), r.log);
  assert.match(r.log, /CAP: company metered \$1\.20 of cap \$1 .*metered loops held: Mo loop \S+/);
});

test('Sprint on: the spendCap guardrail is still the switch (off: nothing held, it is noted)', async () => {
  const spent = [{ runId: 'x1', agentId: 'mo', provider: 'deepseek', usd: 1.2, startedAt: Date.now() - 3 * HOUR, endedAt: Date.now() - 3 * HOUR + MIN }];
  const c = await company({ sprint: true, handoffs: WORK, runs: spent, guards: { spendCap: false } });
  const r = c.tick();
  assert.ok(r.fired.includes('mo'), r.log);
  assert.match(r.log, /spendCap guardrail off — would have held Mo loop/);
});

test('Sprint on: the daily cap is spread over the day (a fast last hour holds metered work, not subscription work)', async () => {
  const spent = [{ runId: 'x1', agentId: 'mo', provider: 'deepseek', usd: 0.6, startedAt: Date.now() - 20 * MIN, endedAt: Date.now() - 10 * MIN }];
  const c = await company({ sprint: true, handoffs: WORK, runs: spent });
  const r = c.tick();
  assert.ok(!r.fired.includes('mo') && r.fired.includes('sam'), r.log);
  assert.match(r.log, /SPRINT SPREAD: .*Mo loop \S+ — Sprint spreads the daily cap/);
  const off = await company({ sprint: false, handoffs: WORK, runs: spent, lastRunMinAgo: 60 });
  assert.ok(off.tick().fired.includes('mo'), 'outside Sprint the even spread does not apply');
});

test('Sprint on: a soft halt still wakes nobody', async () => {
  const c = await company({ sprint: true, handoffs: WORK, halt: { mode: 'soft', by: 'Pat', why: 'test', at: new Date().toISOString() } });
  const r = c.tick();
  assert.deepEqual(r.fired, [], r.log);
  assert.match(r.out + r.log, /HALTED \(soft by Pat/);
});

test('Sprint on: the CEO stays one run at a time (a live CEO run is never doubled), workers go on', async () => {
  const c = await company({ sprint: true, handoffs: WORK, ownerMessage: true, inFlight: ['agent'] });
  const r = c.tick();
  assert.ok(!r.fired.includes('agent'), r.log);
  assert.ok(r.fired.includes('sam') && r.fired.includes('w1'), r.log);
  assert.equal(c.json('company/state/sprint-metrics.json').lanes.agent.max, 1);
});
