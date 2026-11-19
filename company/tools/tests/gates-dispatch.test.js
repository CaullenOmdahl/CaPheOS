#!/usr/bin/env node
/* gates-dispatch.test.js — Waiting on, the Not before caps, Start now and watched-job wakes through the real dispatch.js,
 * against tests/mock-station.js (the harness of sprint-dispatch.test.js). The owner's ruling: "The goal is to get work
 * done as soon as possible." Work is never parked behind a guessed date: an item that waits on other work names it in
 * **Waiting on:** and is woken the tick it is met; **Not before:** is a real clock time with a reason, within its caps.
 *
 *   node --test company/tools/tests/gates-dispatch.test.js
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
const TOKEN = 'gates-test-token';
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
  const log = path.join(require('../lib/temp-life').tmpDir('gates-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = require('../lib/temp-life').track(spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] }));
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
  const T = require('../lib/temp-life').tmpDir('gates-co-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Gates Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'gates-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  w('company/tools/loops.json', { agents });
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  if (o.maxPerTick) cad.maxPerTick = o.maxPerTick;
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
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home') /* its own baseline mirror: parallel test companies never share one */, DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const fired = runs().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(k => k && k !== 'riley').sort();   // Riley (risk) is woken by the default-branch watch's own FYI, not by anything here
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


const NOTIFY = path.join(REPO, 'company', 'tools', 'notify-when.js');
const G = require(path.join(REPO, 'company', 'tools', 'lib', 'gates.js'));
const hhmm = addMin => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.now() + addMin * MIN));
const dayAt = addMin => day(0).slice(0, 0) + new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + addMin * MIN)) + ' ' + hhmm(addMin);
const day = n => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86400e3));
const notify = (c, args) => spawnSync(process.execPath, [NOTIFY].concat(args), { cwd: c.T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: c.T }) });
const lines = (log, re) => (log.match(new RegExp(re, 'g')) || []).length;

test('a Waiting-on handoff wakes its holder the tick the dependency handoff closes (inside its cooldown), with one plain line', async () => {
  const c = await company({ sprint: false, lastRunMinAgo: 600, handoffs: {
    'to-uma.md': block('download the gold history'),
    'to-wen.md': block('recompute the ranking', '**Waiting on:** to-uma.md#download the gold history (gold history download to finish)\n') } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, ['w2'], r.log);   // Uma has the work; Wen waits
  const parked = c.json('company/state/parked.json').items;
  assert.ok(parked.some(p => p.seat === 'w1' && p.kind === 'waiting' && p.words === 'waiting for: gold history download to finish'), JSON.stringify(parked));
  await c.lastRun('w1', 1);   // Wen ran a minute ago: its cooldown would hold an ordinary wake
  c.w('company/work/handoffs/to-uma.md', '# Handoffs\n' + block('download the gold history').replace('**Status:** OPEN', '**Status:** DONE — 109 days in'));
  const r2 = c.tick();
  assert.deepEqual(r2.fired, ['w1'], r2.log);
  assert.match(r2.log, /WAKE Wen: gold history download to finish — done; starting "recompute the ranking"/);
  await c.lastRun('w1', 1);
  const r3 = c.tick(); assert.deepEqual(r3.fired, [], r3.log + r3.out);
});

test('file, quest and service dependencies: parked until met, then woken', async () => {
  const q = await st('POST', '/api/quests/mint', { title: 'gold ranking', agentId: 'nobody', steps: ['rank'] });
  const c = await company({ sprint: false, lastRunMinAgo: 600, handoffs: {
    'to-kim.md': block('write the strategy notes', '**Waiting on:** file: company/work/strategies/RANKING.md\n'),
    'to-sam.md': block('the month-one library', '**Waiting on:** ' + q.quest.id + '\n'),
    'to-wen.md': block('read the bank', '**Waiting on:** service: bank-day\n') } });
  c.w('company/state/services.json', { services: { 'bank-day': { name: 'bank-day', unit: 'gates-svc-bank-day', kind: 'timer', status: 'installed' } } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, [], r.log);
  assert.deepEqual(c.json('company/state/parked.json').items.map(p => p.seat).sort(), ['kim', 'sam', 'w1']);
  c.w('company/work/strategies/RANKING.md', '# Ranking\n');
  await st('POST', '/api/quests/confirm', { id: q.quest.id, ok: true });
  assert.equal(notify(c, ['--service-run', 'bank-day', '--', process.execPath, '-e', 'console.log("banked")']).status, 0);   // the unit's ExecStart (service.js --wake)
  const r2 = c.tick();
  assert.deepEqual(r2.fired, ['kim', 'sam', 'w1'], r2.log);
  assert.equal(lines(r2.log, 'WAKE '), 3, r2.log);
});

test('a service completion wakes its seat; a Waiting-on job is satisfied when the watched job ends', async () => {
  const c = await company({ sprint: false, lastRunMinAgo: 1, handoffs: { 'to-kim.md': block('rank the gold strategies', '**Waiting on:** job: gold-backfill\n') } });
  const started = notify(c, ['--seat', 'kim', '--why', 'gold backfill', '--id', 'gold-backfill', '--', process.execPath, '-e', 'setTimeout(() => console.log("109 days"), 1500)']);
  assert.equal(started.status, 0, started.stderr);
  const wj = path.join(c.T, 'company/state/watched-jobs');
  for (let t0 = Date.now(); Date.now() - t0 < 5000 && !(fs.existsSync(wj) && fs.readdirSync(wj).length);) spawnSync('sleep', ['0.05']);
  const r = c.tick();
  assert.deepEqual(r.fired, [], r.log);   // the job runs: Kim waits (and is inside its cooldown anyway)
  for (let t0 = Date.now(); Date.now() - t0 < 8000 && !fs.existsSync(path.join(c.T, 'company/state/completions.jsonl'));) spawnSync('sleep', ['0.1']);
  // a service run (service.js --wake: its ExecStart is notify-when.js --service-run) records its own row naming its seats
  assert.equal(notify(c, ['--service-run', 'bank-day', '--seat', 'mo', '--', process.execPath, '-e', 'console.log("banked")']).status, 0);
  const r2 = c.tick();
  assert.deepEqual(r2.fired, ['kim', 'mo'], r2.log);
  assert.match(r2.log, /JOB ENDED c-[\w-]+ \(job:gold-backfill\): gold backfill finished: exit 0 after \d+ s — waking Kim/);
  assert.match(r2.log, /JOB ENDED c-[\w-]+ \(service:bank-day\): the bank-day run finished: exit 0 after \d+ s — waking Mo/);
  assert.match(c.r('company/work/handoffs/to-mo.md'), /from Dispatcher — the bank-day run finished: exit 0 after \d+ s\n[\s\S]*\*\*Status:\*\* DONE — a notice/);
  await c.lastRun('kim', 1); await c.lastRun('mo', 1);
  assert.deepEqual(c.tick().fired, [], 'one wake per completion');
});

test('a watched job: exit 0 wakes the seat once; a non-zero exit wakes it labelled as a failure (OPEN); no wake while halted', async () => {
  const c = await company({ sprint: false, lastRunMinAgo: 1 });
  assert.equal(notify(c, ['--seat', 'Wen', '--why', 'price import', '--foreground', '--', process.execPath, '-e', 'console.log("ok")']).status, 0);
  assert.equal(notify(c, ['--seat', 'uma', '--why', 'feed check', '--foreground', '--', process.execPath, '-e', 'console.error("boom"); process.exit(2)']).status, 2);
  const r0 = c.tick();
  assert.deepEqual(r0.fired, ['w1', 'w2'], r0.log);   // both inside their cooldowns: a completion wakes past them
  await c.lastRun('w1', 1); await c.lastRun('w2', 1);
  // provenance: a row nobody but notify-when.js recorded is put back by the locked-file watch and wakes nobody
  const cf = path.join(c.T, 'company/state/completions.jsonl');
  fs.appendFileSync(cf, JSON.stringify({ id: 'c-forged', seat: ['kim'], status: 'ok', exit: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1, tail: [] }) + '\n');
  fs.utimesSync(cf, new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
  const fr = c.tick();
  assert.deepEqual(fr.fired, [], fr.log);
  assert.doesNotMatch(c.r('company/state/completions.jsonl'), /c-forged/);
  // a job that ends while the company is halted wakes nobody until the resume
  assert.equal(notify(c, ['--seat', 'Kim', '--why', 'late import', '--foreground', '--', process.execPath, '-e', 'console.log(1)']).status, 0);
  c.w('company/state/halt.json', { mode: 'soft', by: 'Pat', why: 'test', at: new Date().toISOString() });
  const h = c.tick();
  assert.deepEqual(h.fired, [], h.log);
  fs.unlinkSync(path.join(c.T, 'company/state/halt.json'));
  const r = c.tick();
  assert.deepEqual(r.fired, ['kim'], r.log);
  const all = c.r('company/work/dispatch-log.md');
  assert.match(all, /JOB FAILED c-[\w-]+: feed check FAILED: exit 2 after \d+ s — waking Uma/);
  assert.match(c.r('company/work/handoffs/to-uma.md'), /FAILED: feed check FAILED: exit 2[\s\S]*\*\*Status:\*\* OPEN/);
  assert.match(all, /JOB ENDED c-[\w-]+: price import finished: exit 0 after \d+ s — waking Wen/);
  const admits = c.r('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.door === 'dispatch');
  assert.equal(admits.length, 3);   // Wen, Uma, then Kim: every start through admit()
  await c.lastRun('kim', 1);
  assert.deepEqual(c.tick().fired, [], 'one wake per completion');
});

test('an unresolvable Waiting on fails open: the item is work now, logged once', async () => {
  const c = await company({ sprint: false, lastRunMinAgo: 600, handoffs: { 'to-wen.md': block('the pricing page', '**Waiting on:** to-nobody.md#the thing; job: never-started\n') } });
  const r = c.tick();
  assert.deepEqual(r.fired, ['w1'], r.log);
  assert.match(r.log, /WAITING ON UNRESOLVED to-wen\.md "2026-11-17 from Alex — the pricing page" \(Wen\): to-nobody\.md#the thing; job: never-started/);
  await c.lastRun('w1', 600);
  const r2 = c.tick();
  assert.deepEqual(r2.fired, ['w1']);
  assert.equal(lines(c.r('company/work/dispatch-log.md'), 'WAITING ON UNRESOLVED'), 1);
});

test('migration: a 7-day Not before with no reason is ignored (work now), logged once per item; the CEO gets one handoff', async () => {
  const head = '2026-11-17 from Alex — the month-one strategy library';
  const c = await company({ sprint: false, lastRunMinAgo: 600, handoffs: {
    'to-wen.md': block('the month-one strategy library', '**Not before:** ' + day(7) + '\n'),
    'to-uma.md': block('the backtest bar', '**Not before:** ' + day(6) + ' 09:00    (set 2026-11-17 22:24 by Founder: this comes after RANKING.md by design)\n') } });
  c.w('company/work/dispatch-state.json', { quests: {}, agents: { w1: { key: '', count: 0, notBefore: { [head]: day(7) + ' 00:00' }, deferred: head } } });   // as the old rule left it
  const r = c.tick();
  assert.equal(r.code, 0, r.out + r.log);
  assert.ok(r.fired.includes('w1') && r.fired.includes('w2'), r.log);
  assert.match(r.log, /RELEASED to-wen\.md "2026-11-17 from Alex — the month-one strategy library" \(Wen\): a 7-day Not before with no external reason — treated as work now/);
  assert.match(r.log, /RELEASED to-uma\.md .*\(Uma\): a 6-day Not before with a dependency \("comes after"\), not a clock time .*write \*\*Waiting on:\*\* instead/);
  assert.match(c.r('company/work/handoffs/to-founder.md'), /new rules: Waiting on for work that waits on work, Not before only for a real clock time/);
  await c.lastRun('w1', 600); await c.lastRun('w2', 600);
  c.tick();
  const log = c.r('company/work/dispatch-log.md');
  assert.equal(lines(log, 'RELEASED to-wen'), 1); assert.equal(lines(log, 'RELEASED to-uma'), 1); assert.equal(lines(log, 'RULES NOTICE'), 1);
  assert.equal((c.r('company/work/handoffs/to-founder.md').match(/new rules:/g) || []).length, 1);
  assert.equal(c.json('company/work/dispatch-state.json').agents.w1.deferred, '');   // lanes.js may take it now
});

test('Sprint: a Not before over 12 h is ignored unless its reason is an external time', async () => {
  const at = dayAt(14 * 60);
  const c = await company({ sprint: true, lastRunMinAgo: 600, handoffs: {
    'to-wen.md': block('re-run the pull', '**Not before:** ' + at + ' — the API quota resets\n'),
    'to-uma.md': block('read the EIA numbers', '**Not before:** ' + at + ' — EIA data release\n') } });
  const r = c.tick();
  assert.ok(r.fired.includes('w1') && !r.fired.includes('w2'), r.log);
  assert.match(r.log, /RELEASED to-wen\.md .*: a 14-hour Not before with no external reason during Sprint/);
  const p = c.json('company/state/parked.json').items.find(x => x.seat === 'w2');
  assert.equal(p.kind, 'notBefore'); assert.match(p.words, /^not before \d\d:\d\d (today|tomorrow): EIA data release$/);
});

test('Start now: the owner releases a parked item; it is recorded and its holder is woken at once, once', async () => {
  const c = await company({ sprint: false, lastRunMinAgo: 5, handoffs: { 'to-wen.md': block('the pricing page', '**Not before:** ' + day(2) + ' — the exchange opens\n') } });
  assert.deepEqual(c.tick().fired, []);
  const rel = G.release(c.T, { by: 'Pat', inbox: 'to-wen.md', heading: '2026-11-17 from Alex — the pricing page' });
  assert.match(c.r('company/state/gate-releases.jsonl'), new RegExp(rel.id));
  const r = c.tick();
  assert.deepEqual(r.fired, ['w1'], r.log);   // inside its cooldown: Start now wakes it at once
  assert.match(r.log, /START NOW to-wen\.md "2026-11-17 from Alex — the pricing page": released by Pat/);
  assert.ok(!c.json('company/state/parked.json').items.length);
  await c.lastRun('w1', 1);
  assert.deepEqual(c.tick().fired, []);
});
