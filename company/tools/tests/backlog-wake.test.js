#!/usr/bin/env node
/* backlog-wake.test.js — Issue #19 acceptance tests:
 *  1. 50 unchanged OPEN items + seat writing a file per run wakes at most once per day; adding 1 new item wakes once naming it.
 *  2. A block unchanged across N wakes produces exactly one manager handoff and stops counting toward wakes.
 *  3. With 4 slots and 6 seats, a seat with 1 new item is woken before backlog-only sweep seats.
 *   node --test company/tools/tests/backlog-wake.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const life = require('../lib/temp-life');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO, 'company', 'tools', 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3;
const TOKEN = 'backlog-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, wakeOnOwnerMessage: true, priority: 100, manager: null, provider: 'claude-cli' },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', priority: 90, provider: 'claude-cli' },
  kim: { name: 'Kim', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent', priority: 80, provider: 'claude-cli' },
  mo: { name: 'Mo', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', priority: 70, provider: 'claude-cli' },
  w1: { name: 'Wen', loop: 'Wen loop', inbox: 'to-wen.md', manager: 'agent', priority: 60, provider: 'claude-cli' },
  w2: { name: 'Uma', loop: 'Uma loop', inbox: 'to-uma.md', manager: 'agent', priority: 50, provider: 'claude-cli' },
  riley: { name: 'Riley', functions: ['risk'], loop: 'Riley loop', inbox: 'to-riley.md', manager: 'agent', priority: 10, provider: 'claude-cli' },
};
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n**Status:** OPEN\n' + (extra || '');

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(life.tmpDir('backlog-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = life.track(spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] }));
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');

async function company(o) {
  o = o || {};
  const T = life.tmpDir('backlog-co-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Backlog Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'backlog-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  w('company/tools/loops.json', { agents });
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  if (o.maxPerTick) cad.maxPerTick = o.maxPerTick;
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 10, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
  const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id + '-' + path.basename(T), prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: s.provider, model: 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false, name } });
    agents[id].loop = name;
  }
  w('company/tools/loops.json', { agents });
  const co = { T, ids, w, r: rel => fs.readFileSync(path.join(T, rel), 'utf8'), json: rel => JSON.parse(fs.readFileSync(path.join(T, rel), 'utf8')) };
  co.tick = (extraEnv) => {
    const before = runs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }, extraEnv || {}) });
    const fired = runs().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(Boolean).sort();
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), fired, log: (() => { try { return co.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  co.lastRun = async (id, minAgo) => st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - minAgo * MIN).toISOString() } });
  co.writeRun = (seat, file) => {
    const now = Date.now() + 50;
    fs.appendFileSync(path.join(T, '.starnet-data/workspaces/runs.jsonl'), JSON.stringify({ runId: 'r-' + Math.random().toString(36).slice(2, 8), agentId: seat, startedAt: now - 60000, endedAt: now, ts: now, outcome: 'succeeded', reason: 'done', usd: 0, artifacts: [], completionEvidence: { effects: [{ tool: 'fs.write', target: file }] } }) + '\n');
  };
  return co;
}

test('50 unchanged OPEN items + file write wakes at most once per day; adding 1 new item wakes once naming it', async () => {
  const fifty = Array.from({ length: 50 }, (_, i) => block('backlog task #' + (i + 1))).join('');
  const c = await company({ handoffs: { 'to-wen.md': fifty } });
  let fired = 0;
  for (let i = 0; i < 4; i++) {
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    if (r.fired.includes('w1')) {
      fired++;
      c.writeRun('w1', 'company/work/notes-' + i + '.md');
    }
    await c.lastRun('w1', 600);
  }
  assert.equal(fired, 1, '50 unchanged OPEN items should wake at most once per day even when seat writes a file');

  // Adding one new item produces one wake naming that item (with line range)
  c.w('company/work/handoffs/to-wen.md', c.r('company/work/handoffs/to-wen.md') + block('urgent release note'));
  const rNew = c.tick();
  assert.deepEqual(rNew.fired, ['w1'], rNew.log);
  assert.match(rNew.log, /\[items: [^\]]*L\d+-\d+ "urgent release note"\]/, rNew.log);
  c.writeRun('w1', 'company/work/release.md');
  await c.lastRun('w1', 600);
  const rQuiet = c.tick();
  assert.deepEqual(rQuiet.fired, [], 'quiet again after handling the new item');
});

test('a block unchanged across N wakes produces exactly one manager handoff and stops counting toward wakes', async () => {
  const c = await company({ handoffs: { 'to-wen.md': block('frozen legacy task') + block('active task') } });
  for (let i = 0; i < 4; i++) {
    const r = c.tick({ DISPATCH_BLOCK_STALL_AFTER: '3' });
    assert.equal(r.code, 0, r.out);
    if (i < 3) {
      assert.ok(r.fired.includes('w1'), 'tick ' + i + ' fired=' + JSON.stringify(r.fired));
      c.w('company/work/handoffs/to-wen.md', c.r('company/work/handoffs/to-wen.md').replace('active task\n**Need:** do it\n', 'active task\n**Need:** do it\n**Progress ' + i + ':** step\n'));
    }
    await c.lastRun('w1', 600);
  }
  const mgr = c.r('company/work/handoffs/to-founder.md');
  assert.equal((mgr.match(/frozen legacy task/g) || []).length, 1, 'exactly one manager handoff for the unchanged block');

  // Close the active task: only the parked frozen block remains OPEN -> must not wake even on a new day
  const txt = c.r('company/work/handoffs/to-wen.md').replace(/## 2026-11-17 from Alex — active task[\s\S]*$/, '');
  c.w('company/work/handoffs/to-wen.md', txt);
  const stFile = c.json('company/work/dispatch-state.json');
  stFile.agents.w1.sweepDay = '2026-11-01';
  c.w('company/work/dispatch-state.json', stFile);
  const rAfter = c.tick({ DISPATCH_BLOCK_STALL_AFTER: '3' });
  assert.ok(!rAfter.fired.includes('w1'), 'parked block stops counting toward wakes: ' + rAfter.log.slice(-600));
});

test('fairness: with 4 slots and 6 seats, a low-priority seat with 1 new item wakes before backlog-only seats', async () => {
  const handoffs = {
    'to-sam.md': block('old sam item'),
    'to-kim.md': block('old kim item'),
    'to-mo.md': block('old mo item'),
    'to-wen.md': block('old wen item'),
    'to-uma.md': block('old uma item'),
  };
  const c = await company({ maxPerTick: 4, handoffs });
  // Run initial wakes so all 5 higher-priority seats have woken once, then simulate next company day (backlog sweep due)
  for (let i = 0; i < 2; i++) {
    const r = c.tick();
    for (const s of r.fired) { c.writeRun(s, 'company/work/' + s + '.md'); await c.lastRun(s, 600); }
  }
  const stFile = c.json('company/work/dispatch-state.json');
  for (const s of ['sam', 'kim', 'mo', 'w1', 'w2']) stFile.agents[s].sweepDay = '2026-11-01';
  c.w('company/work/dispatch-state.json', stFile);
  // Give lowest-priority seat (riley, priority 10) 1 brand-new item
  c.w('company/work/handoffs/to-riley.md', '# Handoffs\n' + block('brand new urgent check'));
  const rFair = c.tick();
  assert.equal(rFair.fired.length, 4, rFair.log);
  assert.ok(rFair.fired.includes('riley'), 'low-priority seat with 1 new item must beat backlog-only seats: fired=' + JSON.stringify(rFair.fired));
});
