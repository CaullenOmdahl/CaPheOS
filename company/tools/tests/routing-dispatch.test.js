#!/usr/bin/env node
/* routing-dispatch.test.js — the router (lib/routing.js) through the real dispatch.js, against tests/mock-station.js (the
 * harness of gates-dispatch.test.js). It proves: with no routing policy and no departments every POST /api/cron/run body is
 * exactly what it was before ({id, detach}) and no wake row carries a route; shadow records wouldApply on the wake row and
 * in routing-log.jsonl and runs the chain (no override); live + a current allowlist that opens the pair passes the one-run
 * override; live + a pair the allowlist does not list records "not open" and runs the chain.
 *
 *   node --test company/tools/tests/routing-dispatch.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO, 'company', 'tools', 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3;
const TOKEN = 'routing-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const DEFAULT_POLICY = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'models', 'routing-policy.json'), 'utf8'));

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null, provider: 'claude-cli' },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli' },
  mo: { name: 'Mo', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', provider: 'deepseek' },
};
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n' + (extra || '') + '**Status:** OPEN\n';
const DEPTS = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['sam', 'mo'], defaultClass: 'code',
  routes: { writing: { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }, code: { provider: 'custom', model: 'MiniMax-M3.1-Flash' } } }] };
const WORK = { 'to-sam.md': block('write the release notes', '**Class:** writing\n'), 'to-mo.md': block('fix the parser', '**Class:** code\n') };

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
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

/* o.policy (routing-policy.json, or none), o.departments, o.allow ({seat: [pairs]} written fresh before each tick) */
async function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Routing Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'routing-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  if (o.policy) w('company/work/models/routing-policy.json', o.policy);
  if (o.departments) w('company/departments.json', o.departments);
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || WORK)[s.inbox] || ''));
  const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id + '-' + path.basename(T), prompt: 'Read company/work/handoffs/' + s.inbox + ', then work.', provider: s.provider, model: s.provider === 'deepseek' ? 'deepseek-flash' : 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false, name } });
    agents[id].loop = name;
  }
  w('company/tools/loops.json', { agents });
  const c = { T, ids, w, r: rel => fs.readFileSync(path.join(T, rel), 'utf8') };
  c.jsonl = rel => { try { return c.r(rel).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  c.tick = () => {
    if (o.allow) w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: o.allow });
    const before = runs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const mine = runs().slice(before);
    const bySeat = {}; for (const r of mine) { const k = Object.keys(ids).find(x => ids[x] === r.body.id); if (k) bySeat[k] = r.body; }
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), bodies: mine.map(r => r.body), bySeat, log: (() => { try { return c.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  c.wake = seat => c.jsonl('company/state/wakes.jsonl').filter(r => r.seat === seat).pop();
  return c;
}
const policy = patch => Object.assign(JSON.parse(JSON.stringify(DEFAULT_POLICY)), patch || {});

test('(7) no routing policy and no departments: every cron run body is {id, detach} as before; no route on any wake row, no log', async () => {
  const c = await company({});
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(r.bySeat).sort(), ['mo', 'sam'], r.log);
  for (const b of r.bodies) assert.deepEqual(Object.keys(b).sort(), ['detach', 'id'], JSON.stringify(b));
  for (const b of r.bodies) assert.equal(JSON.stringify(b), JSON.stringify({ id: b.id, detach: true }), 'byte for byte the old body');
  const rows = c.jsonl('company/state/wakes.jsonl');
  assert.ok(rows.length >= 2 && rows.every(x => !('route' in x)), JSON.stringify(rows));
  assert.ok(!fs.existsSync(path.join(c.T, 'company/work/models/routing-log.jsonl')));
  assert.doesNotMatch(r.log, /ROUTE|ROUTING/);
});

test('(1) shadow: the wake row and the routing log record wouldApply; the run goes out on its chain (no override)', async () => {
  const c = await company({ policy: policy({ mode: 'shadow' }), departments: DEPTS, allow: { sam: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }] } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(Object.keys(r.bySeat.sam).sort(), ['detach', 'id'], 'no override in shadow: ' + JSON.stringify(r.bySeat.sam));
  const w = c.wake('sam');
  assert.equal(w.route.applied, false);
  assert.equal(w.route.class, 'writing');
  assert.deepEqual(w.route.wouldApply, { source: 'route', provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high', department: 'eng' });
  assert.ok(w.route.reasons.some(x => /shadow/.test(x)), JSON.stringify(w.route));
  const log = c.jsonl('company/work/models/routing-log.jsonl');
  assert.ok(log.some(x => x.seat === 'sam' && x.wakeId === w.wakeId && x.route.wouldApply && x.runId === w.runId), JSON.stringify(log));
  assert.match(r.log, /ROUTE sam \(not applied\): route would run claude-cli\/claude-sonnet-5-5@high/);
  // (3) the code item's department route is MiniMax: denied by the class rules, never recorded as a choice
  const m = c.wake('mo');
  assert.ok(!m.route.wouldApply || m.route.wouldApply.provider !== 'custom', JSON.stringify(m.route));
  assert.ok(m.route.reasons.some(x => /route eng\.code custom\/MiniMax-M3\.1-Flash denied: code never runs on provider custom/.test(x)), JSON.stringify(m.route));
  assert.deepEqual(Object.keys(r.bySeat.mo).sort(), ['detach', 'id']);
});

test('(2) live + allowed passes the one-run override; live + not in the allowlist records "not open" and runs the chain', async () => {
  const c = await company({ policy: policy({ mode: 'live' }), departments: DEPTS, allow: { sam: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }], mo: [] } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.bySeat.sam, { id: c.ids.sam, detach: true, provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' });
  const w = c.wake('sam');
  assert.deepEqual([w.route.applied, w.route.source, w.route.provider, w.route.model], [true, 'route', 'claude-cli', 'claude-sonnet-5-5']);
  assert.match(r.log, /ROUTE sam: route -> claude-cli\/claude-sonnet-5-5@high \(one-run override/);

  const c2 = await company({ policy: policy({ mode: 'live' }), departments: DEPTS, allow: { sam: [{ provider: 'deepseek', model: 'deepseek-flash' }] } });
  const r2 = c2.tick();
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(Object.keys(r2.bySeat.sam).sort(), ['detach', 'id'], JSON.stringify(r2.bySeat.sam));
  const w2 = c2.wake('sam');
  assert.equal(w2.route.applied, false);
  assert.ok(w2.route.reasons.some(x => /^not open: claude-cli\/claude-sonnet-5-5 is not in the override allowlist for sam/.test(x)), JSON.stringify(w2.route));
  assert.equal(w2.route.wouldApply.model, 'claude-sonnet-5-5');

  // no current allowlist at all (none written): not open either
  const c3 = await company({ policy: policy({ mode: 'live' }), departments: DEPTS });
  const r3 = c3.tick();
  assert.deepEqual(Object.keys(r3.bySeat.sam).sort(), ['detach', 'id']);
  assert.ok(c3.wake('sam').route.reasons.some(x => /not open: no current override allowlist/.test(x)));
});
