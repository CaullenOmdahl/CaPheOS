#!/usr/bin/env node
/* delegation.test.js — middle-management P0, measurement only (docs/BUDGET.md "Delegated runs are the lead's family",
 * docs/TEMPO.md "Run-to-item links"): a lead's team.dispatch children are door "delegate" and the lead's family's spend;
 * a seat with a live child run is busy; every wake writes one company/state/wakes.jsonl row with the items it is for, and
 * linkItems reports the share of DONE items with a linked run. The dispatcher cases run the real dispatch.js against
 * tests/mock-station.js on a free port; nothing touches a live station or the checkout's company files.
 *
 *   node --test company/tools/tests/delegation.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const DISPATCH = path.join(TOOLS, 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3, HOUR = 3600e3;
const TOKEN = 'delegation-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const FAM = require(path.join(TOOLS, 'lib', 'family.js'));
const A = require(path.join(TOOLS, 'lib', 'admit.js'));
const W = require(path.join(TOOLS, 'lib', 'wakes.js'));

/* ---------------- the family books ---------------- */
// a lead (L) whose run delegated two workers (w1 twice, w2 once, one grandchild under w2's run), a worker's own loop run,
// a child whose lead's run is still going (only delegatedBy names the lead), and a child nobody can place
const now = Date.now();
const FAMILY = [
  { runId: 'L1', agentId: 'lead', startedAt: now - 5 * HOUR, endedAt: now - 4 * HOUR, usd: 0.5, provider: 'openrouter' },
  { runId: 'c1', parentRunId: 'L1', delegatedBy: 'lead', agentId: 'w1', startedAt: now - 5 * HOUR + MIN, endedAt: now - 5 * HOUR + 9 * MIN, usd: 0.25, provider: 'openrouter' },
  { runId: 'c2', parentRunId: 'L1', delegatedBy: 'lead', agentId: 'w1', startedAt: now - 5 * HOUR + 10 * MIN, endedAt: now - 5 * HOUR + 19 * MIN, usd: 0.125, provider: 'openrouter' },
  { runId: 'c3', parentRunId: 'L1', delegatedBy: 'lead', agentId: 'w2', startedAt: now - 5 * HOUR + 20 * MIN, endedAt: now - 5 * HOUR + 39 * MIN, usd: 0.0625, provider: 'openrouter' },
  { runId: 'g1', parentRunId: 'c3', delegatedBy: 'w2', agentId: 'w3', startedAt: now - 5 * HOUR + 21 * MIN, endedAt: now - 5 * HOUR + 30 * MIN, usd: 0.03125, provider: 'openrouter' },
  { runId: 'W1', agentId: 'w1', startedAt: now - 3 * HOUR, endedAt: now - 3 * HOUR + 5 * MIN, usd: 1, provider: 'openrouter' },
  { runId: 'c9', parentRunId: 'L-live', delegatedBy: 'lead', agentId: 'w2', startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 5 * MIN, usd: 0.75, provider: 'openrouter' },
  { runId: 'c0', parentRunId: 'L-gone', agentId: 'w3', startedAt: now - 2 * HOUR, endedAt: now - 2 * HOUR + 5 * MIN, usd: 0.015625, provider: 'openrouter' },
];
// runs.jsonl also carries side rows under a run's id (seen in a live station's file): they never hide the run row
const SIDE = { runId: 'c1', kind: 'dispatch-delivery', ts: now - 5 * HOUR + 9 * MIN };
const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
const runsTotal = FAMILY.reduce((a, r) => a + r.usd, 0);

test('family: per-family and per-seat sums add up exactly to the runs.jsonl total, and a child is never the worker\'s', () => {
  const b = FAM.books(FAMILY);
  assert.equal(b.total, runsTotal);
  assert.equal(sum(b.bySeat), runsTotal, 'per seat');
  assert.equal(sum(Object.fromEntries(Object.entries(b.byFamily).map(([k, f]) => [k, f.total]))), runsTotal, 'per family');
  for (const f of Object.values(b.byFamily)) assert.equal(f.own + f.delegated, f.total);
  assert.deepEqual(FAM.books(FAMILY.slice(0, 2).concat([SIDE]).concat(FAMILY.slice(2))).bySeat, b.bySeat, 'a side row under a child\'s id changes nothing');
  assert.equal(FAM.leads([SIDE].concat(FAMILY)).get('c1').seat, 'lead');
  assert.equal(b.bySeat.lead, 0.5 + 0.25 + 0.125 + 0.0625 + 0.03125 + 0.75, 'the lead carries its whole family, the grandchild and the child of a run still going included');
  assert.equal(b.bySeat.w1, 1, 'the worker keeps only its own loop run');
  assert.equal(b.bySeat.w2, undefined, 'w2 ran only delegated work: nothing on its own seat');
  assert.equal(b.bySeat[FAM.UNKNOWN], 0.015625, 'a child nobody can place is booked apart, not to its worker');
  assert.deepEqual(b.byFamily.lead.workers, { w1: 0.375, w2: 0.8125, w3: 0.03125 });
  assert.equal(b.byFamily.lead.children, 5); assert.equal(b.byFamily.lead.runs, 1);
});

test('family: the cap numerator books a child to the lead\'s share; the company total is unchanged', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'family-cap-'));
  try {
    const runs = path.join(T, 'runs.jsonl'), ledger = path.join(T, 'ledger.jsonl');
    fs.writeFileSync(runs, FAMILY.slice().sort((a, b) => a.endedAt - b.endedAt).map(r => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(ledger, '');
    const cn = require(path.join(TOOLS, 'cap-numerator.js'));
    const plain = cn.compute({ runsPath: runs, ledgerPath: ledger, now, providers: ['claude-cli'] });
    const fam = cn.compute({ runsPath: runs, ledgerPath: ledger, now, providers: ['claude-cli'], family: true });
    assert.equal(plain.metered, runsTotal); assert.equal(fam.metered, runsTotal, 'the cap numerator does not move');
    assert.equal(sum(fam.byAgent), runsTotal); assert.equal(sum(plain.byAgent), runsTotal);
    assert.deepEqual(fam.byAgent, FAM.books(FAMILY).bySeat, 'the dispatcher\'s per-seat shares are the family books');
    assert.equal(plain.byAgent.w1, 1.375, 'without family the worker was charged its lead\'s work (the defect)');
    assert.equal(fam.delegated.lead.w2, 0.8125);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

/* ---------------- the delegate door ---------------- */
test('a child run is door "delegate", with its parent run, its lead and the family\'s door; nothing is unattributed', () => {
  const at = now - 5 * HOUR;
  const admits = [{ at: at - 2000, id: 'adm-1', door: 'dispatch', kind: 'run', seat: 'lead', decision: 'allow' }, { at: at - 1000, ref: 'adm-1', outcome: 'started', status: 200, runId: 'L1' },
    // an admitted wake of w1 near the child's start: the child must not take it (it was never admitted)
    { at: at + 30e3, id: 'adm-2', door: 'dispatch', kind: 'run', seat: 'w1', decision: 'allow' }];
  const att = A.attribute(FAMILY.filter(r => r.runId !== 'W1').concat([{ runId: 'W1b', agentId: 'w1', startedAt: at + 40e3, cronJobId: 'j-w1' }, SIDE]), admits);
  assert.equal(att.filter(r => r.runId === 'c1').length, 1, 'a side row is not a run: never attributed, never unattributed');
  const by = Object.fromEntries(att.map(r => [r.runId, r]));
  assert.equal(by.L1.door, 'dispatch');
  for (const id of ['c1', 'c2', 'c3', 'g1', 'c9', 'c0']) assert.equal(by[id].door, 'delegate', id);
  assert.equal(by.c1.parentRunId, 'L1'); assert.equal(by.c1.lead, 'lead'); assert.equal(by.c1.parentDoor, 'dispatch');
  assert.equal(by.g1.lead, 'lead', 'a grandchild is in the top lead\'s family'); assert.equal(by.g1.parentDoor, 'dispatch');
  assert.equal(by.c9.lead, 'lead', 'the lead\'s run still going: its delegatedBy names the lead'); assert.equal(by.c9.parentDoor, null);
  assert.equal(by.c0.lead, null);
  assert.equal(by.W1b.door, 'dispatch', 'the worker\'s own wake keeps its admit row'); assert.equal(by.W1b.admitId, 'adm-2');
  assert.ok(A.DOORS.includes('delegate'));
});

/* ---------------- run-to-item links ---------------- */
test('linkItems: each DONE item finds the wakes and runs that worked it, and the linked share is reported', () => {
  const t0 = Date.parse('2026-11-17T08:00:00Z');
  const rows = [
    { at: t0, wakeId: 'wk-a', seat: 's', runId: 'r-a', items: [{ file: 'to-s.md', id: 'to-s.md#aaaaaa' }, { file: 'to-s.md', id: 'BUILD-1' }] },
    { at: t0 + HOUR, wakeId: 'wk-b', seat: 's', runId: null, admitId: 'adm-b', items: [{ file: 'to-s.md', id: 'BUILD-1' }] },
    { at: t0 + 2 * HOUR, wakeId: 'wk-c', seat: 'k', runId: null, admitId: 'adm-c', items: [{ file: 'to-k.md', id: 'to-k.md#cccccc' }] },
    { at: t0 + 9 * HOUR, wakeId: 'wk-late', seat: 'k', runId: 'r-late', items: [{ file: 'to-k.md', id: 'to-k.md#dddddd' }] },   // after the close
    { at: t0 + HOUR, wakeId: 'wk-loop', seat: 'k', runId: 'r-loop', items: [] },
  ];
  const done = [
    { file: 'to-s.md', id: 'to-s.md#aaaaaa', title: 'a', closedAt: t0 + 3 * HOUR },
    { file: 'to-s.md', id: 'BUILD-1', title: 'b', closedAt: t0 + 3 * HOUR },
    { file: 'to-k.md', id: 'to-k.md#cccccc', title: 'c', closedAt: t0 + 3 * HOUR },   // its wake's run is known only from attribution
    { file: 'to-k.md', id: 'to-k.md#dddddd', title: 'd', closedAt: t0 + 4 * HOUR },   // closed before any wake listed it
    { file: 'to-x.md', id: 'to-x.md#eeeeee', title: 'e', closedAt: t0 + 4 * HOUR },   // never woken for
  ];
  const r = W.linkItems(rows, done, { attributed: [{ admitId: 'adm-c', runId: 'r-c' }] });
  const by = Object.fromEntries(r.items.map(x => [x.id, x]));
  assert.deepEqual(by['BUILD-1'].runs, ['r-a']); assert.deepEqual(by['BUILD-1'].wakes, ['wk-a', 'wk-b']);
  assert.deepEqual(by['to-k.md#cccccc'].runs, ['r-c']);
  assert.equal(by['to-k.md#dddddd'].linked, false); assert.equal(by['to-x.md#eeeeee'].linked, false);
  assert.equal(r.total, 5); assert.equal(r.linked, 3); assert.equal(r.share, 0.6); assert.equal(r.target, 0.9); assert.equal(r.met, false);
  assert.equal(W.linkItems(rows, done.slice(0, 3), { attributed: [{ admitId: 'adm-c', runId: 'r-c' }] }).met, true);
  assert.equal(W.linkItems([], []).share, null);
});

test('item ids: an **Id:** line wins; else <inbox>#<6 hex of sha256(heading)>, the id handoff-status.js gives a block; closedItems reads DONE blocks in the window', () => {
  const h = '2026-11-17 09:00 from Alex — ship it';
  assert.equal(W.itemId('to-s.md', h, '`SHIP-1`'), 'SHIP-1');
  assert.equal(W.itemId('to-s.md', h), 'to-s.md#' + require('crypto').createHash('sha256').update(h).digest('hex').slice(0, 6));
  const text = '# Handoffs\n\n## ' + h + '\n**Status:** DONE — shipped\n**Resolved 2026-11-17 11:30 by Sam:** done\n\n## 2026-11-17 09:05 from Alex — still open\n**Status:** OPEN\n\n## 2026-11-01 from Alex — old\n**Status:** DONE\n';
  const got = W.closedItems([{ file: 'to-s.md', text }], { sinceMs: Date.parse('2026-11-10T00:00:00Z') });
  assert.equal(got.length, 1); assert.equal(got[0].id, W.itemId('to-s.md', h)); assert.ok(got[0].closedAt > Date.parse('2026-11-17T00:00:00Z'));
  assert.equal(W.runIdOf('{"ok":true,"runId":"run-7","detached":true}'), 'run-7');
  assert.equal(W.runIdOf('{"event":"agent.run.start","runId":"9f1c2d3e-aaaa","agentId":"x","mod'), '9f1c2d3e-aaaa', 'the first ndjson line of a stream, cut off');
  assert.equal(W.runIdOf('{"event":"agent.run.start","runId":"9f1c2d3e-aa'), null, 'an id cut in half is no id');
  assert.equal(W.runIdOf(''), null);
});

/* ---------------- the real dispatcher on the mock station ---------------- */
const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null, provider: 'claude-cli' },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli' },
  kim: { name: 'Kim', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent', provider: 'claude-cli' },
};
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n**Status:** OPEN\n' + (extra || '');
let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
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
const cronRuns = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');
async function company(o) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Delegation Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'delegation-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const agents = {}; for (const [id, s] of Object.entries(SEATS)) { const c = Object.assign({}, s); delete c.provider; agents[id] = c; }
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
  const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: s.provider, model: 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - 120 * MIN).toISOString(), name } });
    agents[id].loop = name;
  }
  w('company/tools/loops.json', { agents });
  const c = { T, ids, r: rel => fs.readFileSync(path.join(T, rel), 'utf8') };
  c.tick = () => {
    const before = cronRuns().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const fired = cronRuns().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(Boolean).sort();
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), fired, log: (() => { try { return c.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  c.wakes = () => { try { return c.r('company/state/wakes.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  return c;
}

test('a seat with a live child run (its lead\'s team.dispatch) is not woken; the others are, and each wake writes one wakes.jsonl row with its items', async () => {
  const c = await company({ handoffs: {
    'to-sam.md': block('build the intake form', '**Id:** INTAKE-1\n**Deadline:** 2026-11-20\n') + block('write the API docs') + block('blocked thing', '**Waiting on:** seat: Kim — review the intake form\n'),
    'to-kim.md': block('review the intake form'),
    'to-founder.md': '',
  } });
  const live = await st('POST', '/__live', { agentId: 'kim', parentRunId: 'lead-run-1' });
  try {
    const snap = await st('GET', '/api/state/snapshot');
    assert.ok(snap.runs.some(r => r.agentId === 'kim' && r.source === 'delegated'), 'the mock lists the child as the station does');
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.fired.includes('kim'), 'Kim is busy on a delegated child run: ' + r.log);
    assert.ok(r.fired.includes('sam'), 'Sam is woken: ' + r.log);
    assert.match(r.log, /DELEGATED BUSY: Kim \(child run live-/);
    const state = JSON.parse(c.r('company/work/dispatch-state.json'));
    assert.equal(state.seats.kim.state, 'working');
    const rows = c.wakes();
    assert.equal(rows.length, r.fired.length, 'one row per run started: ' + JSON.stringify(rows));
    const sam = rows.filter(x => x.seat === 'sam');
    assert.equal(sam.length, 1);
    const row = sam[0];
    assert.ok(row.wakeId && row.at && row.door === 'dispatch' && row.admitId && row.jobId === c.ids.sam, JSON.stringify(row));
    assert.match(String(row.runId), /^run-\d+$/, 'the run id the station answered');
    assert.deepEqual(row.items.map(i => i.id), ['INTAKE-1', W.itemId('to-sam.md', '2026-11-17 from Alex — write the API docs')], 'the open items that were work now, soonest due first; the waiting one is not listed');
    assert.equal(row.items[0].file, 'to-sam.md'); assert.equal(row.items[0].due, '2026-11-20'); assert.match(row.items[1].title, /write the API docs/);
    assert.match(row.why, /OPEN in to-sam\.md/);
    // the admit log has the run id too, so the attribution and the wake row agree
    const adm = c.r('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.ok(adm.some(a => a.ref === row.admitId && a.runId === row.runId), 'admit started() row carries the run id');
    // the next tick, with the child ended: Kim is woken again
    await st('POST', '/__live/end', { runId: live.run.runId });
    const r2 = c.tick();
    assert.ok(r2.fired.includes('kim'), r2.log);
    assert.equal(c.wakes().filter(x => x.seat === 'kim').length, 1);
  } finally { try { await st('POST', '/__live/end', { runId: live.run.runId }); } catch (_) {} }
});

test('dispatch.js --wake-links reports the share of DONE items with a linked run, offline', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-links-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - HOUR));
  const h1 = day + ' from Alex — one', h2 = day + ' from Alex — two';
  w('company/company.json', JSON.stringify({ name: 'Links Test', owner: { name: 'Pat' }, timezone: TZ }));
  const closedTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.now() - HOUR));
  w('company/work/handoffs/to-sam.md', '# Handoffs\n\n## ' + h1 + '\n**Status:** DONE\n**Resolved ' + day + ' ' + closedTime + ' by Sam:** done\n\n## ' + h2 + '\n**Status:** DONE\n**Resolved ' + day + ' ' + closedTime + ' by Sam:** done\n');
  w('company/state/wakes.jsonl', JSON.stringify({ at: Date.now() - 3 * HOUR, wakeId: 'wk-1', seat: 'sam', runId: 'r-1', door: 'dispatch', items: [{ file: 'to-sam.md', id: W.itemId('to-sam.md', h1) }] }) + '\n');
  const p = spawnSync(process.execPath, [DISPATCH, '--wake-links', '--hours', '24', '--json'], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: TZ, STARNET_URL: 'http://127.0.0.1:1' }) });
  assert.equal(p.status, 0, p.stderr);
  const j = JSON.parse(p.stdout);
  assert.equal(j.total, 2); assert.equal(j.linked, 1); assert.equal(j.share, 0.5); assert.equal(j.met, false);
  assert.ok(!fs.existsSync(path.join(T, 'company', 'work', 'dispatch-log.md')), 'no tick ran');
});

test('closed items: a date-only Resolved stamp counts to the end of that day, so a wake later that day still links', () => {
  const sec = 'notes for Kim — 2026-11-18 09:00 from Sam\n**Status:** DONE\n**Resolved 2026-11-18 by Kim:** done\n';
  const done = W.closedItems([{ file: 'to-kim.md', text: '## ' + sec }]);
  assert.equal(done.length, 1);
  const wakeAt = W.closedAtOf('x — 2026-11-18 10:00\n');   // 10:00 the same day, company time
  const rows = [{ at: wakeAt, wakeId: 'w1', runId: 'run-0', items: [{ file: 'to-kim.md', id: done[0].id }] }];
  const r = W.linkItems(rows, done);
  assert.equal(r.linked, 1, JSON.stringify(r));
  assert.ok(done[0].closedBy > wakeAt, 'the close bound is after the 10:00 wake');
  assert.ok(done[0].closedAt < wakeAt, 'for the report window the item closed that day (its start)');
});

test('closed items: a block DONE when written (an FYI or notice) is not finished work unless a wake listed it', () => {
  const text = '## FYI — 2026-11-18 09:00 from the dispatcher\n**Status:** DONE — FYI\n\n'
    + '## real work — 2026-11-18 09:05 from Sam\n**Status:** DONE\n**Resolved 2026-11-18 11:00 by Kim:** shipped\n\n'
    + '## approved in place — 2026-11-18 09:10 from Sam\n**Status:** DONE — approved by Kim\n';
  const done = W.closedItems([{ file: 'to-kim.md', text }]);
  assert.equal(done.length, 3);
  const approved = done.find(d => /approved in place/.test(d.title));
  const rows = [{ at: W.closedAtOf('x — 2026-11-18 09:30\n'), wakeId: 'w1', runId: 'run-1', items: [{ file: 'to-kim.md', id: approved.id }] }];
  const r = W.linkItems(rows, done);
  assert.equal(r.total, 2, 'the FYI is left out; the resolved item and the worked one count: ' + JSON.stringify(r.items.map(i => i.title)));
  assert.ok(!r.items.some(i => /FYI/.test(i.title)));
  assert.equal(r.linked, 1);
});
