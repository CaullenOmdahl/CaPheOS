#!/usr/bin/env node
/* sprint.test.js — the pure parts of Sprint (company/tools/lib/sprint.js) and the StarNet concurrency finding.
 *
 *   node --test company/tools/tests/sprint.test.js
 * The StarNet part reads the station's own modules (sidecar/concurrency.js, sidecar/workspace-lease.js) from a checkout:
 * STARNET_DIR, else ./starnet under the company root; without one it is skipped. It only require()s them: no station
 * is started and nothing is written.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const SP = require('../lib/sprint');

const item = (heading, o) => Object.assign({ heading, status: 'OPEN', open: true, touches: null, effort: null }, o || {});

test('handoff items: Status (the first line governs), Touches and Effort', () => {
  const txt = '# x\n## a — one\n**Status:** OPEN\n**Touches:** `src/api/`, docs/API.md\n**Effort:** mechanical — renames\n' +
    '## b — two\n**Status:** DONE — ok\n**Status:** OPEN\n' + '## c — three\n**Status:** OPEN\n**Touches:** *\n**Effort:** Reasoning\n';
  const it = SP.parseItems(txt);
  assert.deepEqual(it.map(i => i.open), [true, false, true]);
  assert.deepEqual(it[0].touches, ['src/api', 'docs/API.md']); assert.equal(it[0].effort, 'mechanical');
  assert.equal(it[2].touches, null, '"*" touches everything: conflicting'); assert.equal(it[2].effort, 'reasoning');
});

test('effort per seat: mechanical only when every open item says so; any reasoning item wins; untagged = the default chain', () => {
  assert.equal(SP.effortOf([item('a', { effort: 'mechanical' }), item('b', { effort: 'mechanical' })]), 'mechanical');
  assert.equal(SP.effortOf([item('a', { effort: 'mechanical' }), item('b')]), 'default');
  assert.equal(SP.effortOf([item('a', { effort: 'mechanical' }), item('b', { effort: 'reasoning' })]), 'reasoning');
  assert.equal(SP.effortOf([item('a', { effort: 'mechanical', open: false })]), 'default');
});

test('rest: Sprint drops to the floor only for changed work; hiring picks never wait', () => {
  const base = 40 * 60000;
  assert.deepEqual(SP.restMs({ baseMs: base, sprint: false, changed: true }), { ms: base, fast: false });
  assert.deepEqual(SP.restMs({ baseMs: base, sprint: true, changed: true, floorMin: 2 }), { ms: 120000, fast: true });
  assert.deepEqual(SP.restMs({ baseMs: base, sprint: true, changed: false, floorMin: 2 }), { ms: base, fast: false });
  assert.equal(SP.restMs({ baseMs: 60000, sprint: true, changed: true, floorMin: 2 }).ms, 60000, 'the floor never lengthens a shorter cooldown');
  assert.equal(SP.restMs({ baseMs: base, hiring: true }).ms, 0);
  assert.notEqual(SP.workSig(['a', 1]), SP.workSig(['a', 2]));
});

test('spread: the last hour may spend twice the even share of what is left, never less than an eighth of the cap', () => {
  assert.equal(SP.spreadHold({ cap: 4, spent24h: 0, spentLastHour: 0.4, hoursLeft: 20 }), null);   // allowance max(0.5, 0.4) = 0.5
  assert.match(SP.spreadHold({ cap: 4, spent24h: 1, spentLastHour: 0.5, hoursLeft: 20 }), /spreads the daily cap/);
  assert.equal(SP.spreadHold({ cap: 4, spent24h: 3, spentLastHour: 0.6, hoursLeft: 1 }), null, 'at the end of the day the rest may go');
  assert.equal(SP.spreadHold({ cap: 0, spent24h: 0, spentLastHour: 5, hoursLeft: 10 }), null, 'no cap: nothing to spread');
});

test('lanes: disjoint Touches run in parallel; untagged items make the seat serial; overlap batches; CEO is one lane', () => {
  const a = item('a', { touches: ['src/api'] }), b = item('b', { touches: ['docs'] }), c = item('c', { touches: ['src/api/auth.js'] }), u = item('u');
  let p = SP.lanePlan([a, b], { lanes: 2 });
  assert.equal(p.lanes.length, 2); assert.deepEqual(p.lanes.map(l => l.map(i => i.heading)), [['a'], ['b']]);
  p = SP.lanePlan([a, b, u], { lanes: 2 });
  assert.equal(p.lanes.length, 1, 'an item without Touches conflicts with everything'); assert.equal(p.lanes[0].length, 3, 'one wake, all items'); assert.match(p.why, /declare no Touches/);
  p = SP.lanePlan([a, c, b], { lanes: 3 });
  assert.deepEqual(p.lanes.map(l => l.map(i => i.heading)), [['a', 'c'], ['b']], 'src/api and src/api/auth.js overlap: serial in one lane');
  p = SP.lanePlan([a, b, item('d', { touches: ['web'] })], { lanes: 2 });
  assert.equal(p.lanes.length, 2); assert.equal(p.lanes.flat().length, 3, 'no lane left: batched, never dropped');
  p = SP.lanePlan([a, b], { lanes: 4, isCeo: true });
  assert.equal(p.lanes.length, 1); assert.match(p.why, /CEO/);
  p = SP.lanePlan([a, b], { lanes: 2, held: ['src'] });
  assert.deepEqual(p.waiting.map(i => i.heading), ['a'], 'a path another lane holds waits'); assert.deepEqual(p.lanes.flat().map(i => i.heading), ['b']);
  assert.ok(!SP.overlaps(['src/api'], ['src/apix']), 'a prefix of a name is not a path prefix');
});

test('path lock: one lane per path; a conflict waits; release frees it; no Touches never locks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-lock-'));
  try {
    const L = SP.makePathLock(path.join(dir, 'lane-locks.json'));
    assert.deepEqual(L.acquire('sam#1', ['src/api']), { ok: true });
    const clash = L.acquire('sam#2', ['src/api/auth.js', 'docs']);
    assert.equal(clash.ok, false); assert.equal(clash.holder, 'sam#1'); assert.equal(clash.path, 'src/api/auth.js');
    assert.equal(L.held().length, 1, 'a refused acquire takes nothing');
    assert.deepEqual(L.acquire('sam#2', ['docs']), { ok: true });
    assert.equal(L.acquire('jo#1', []).ok, false);
    assert.equal(L.release('sam#1'), 1);
    assert.deepEqual(L.acquire('sam#3', ['src/api/auth.js']), { ok: true });
    assert.equal(SP.makePathLock(path.join(dir, 'lane-locks.json')).held().length, 2, 'kept on disk for every process');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Sprint spend: metered runs since the start; subscription runs are $0 to the budget', () => {
  const rows = [{ provider: 'deepseek', usd: 0.5, endedAt: 100 }, { provider: 'claude-cli', usd: 9, endedAt: 100 }, { provider: 'deepseek', usd: 1, endedAt: 10 }];
  assert.deepEqual(SP.sprintSpend(rows, 50, ['claude-cli']), { usd: 0.5, runs: 2 });
});

/* ---- the StarNet finding: two runs of one agent are admitted, but only one may touch files or the shell ---- */
const SN = process.env.STARNET_DIR || path.join(process.env.CAPHEOS_ROOT || path.resolve(__dirname, '..', '..', '..'), 'starnet');
const haveSN = fs.existsSync(path.join(SN, 'sidecar', 'workspace-lease.js')) && fs.existsSync(path.join(SN, 'sidecar', 'concurrency.js'));
test('StarNet: a second run of one agent is admitted, but its first file or shell call waits for the first run, then fails', { skip: haveSN ? false : 'no StarNet checkout (set STARNET_DIR)' }, async () => {
  const { makeConcurrencyGate } = require(path.join(SN, 'sidecar', 'concurrency.js'));
  const { makeWorkspaceLease } = require(path.join(SN, 'sidecar', 'workspace-lease.js'));
  const g = makeConcurrencyGate({ max: 2 });
  assert.equal(g.tryEnter('sam'), true); assert.equal(g.tryEnter('sam'), true, 'a second run of an admitted agent takes no new slot');
  assert.equal(g.inFlight('sam'), 2); assert.equal(g.active(), 1);
  const lease = makeWorkspaceLease({ waitMs: 50, now: () => Date.now() });
  assert.deepEqual(await lease.acquire('sam', 'lane-1'), { ok: true });
  const t0 = Date.now(); const second = await lease.acquire('sam', 'lane-2');   // keyed on the agent id alone: a different workdir does not help
  assert.equal(second.ok, false); assert.equal(second.timedOut, true); assert.equal(second.holder.runId, 'lane-1'); assert.ok(Date.now() - t0 >= 45);
  lease.release('sam', 'lane-1');
  assert.deepEqual(await lease.acquire('sam', 'lane-2'), { ok: true }, 'only once the first run ends');
  // the mutating tools that take the lease: every file write and EVERY shell call (CaPheOS seats work through the shell)
  const idx = fs.readFileSync(path.join(SN, 'sidecar', 'index.js'), 'utf8');
  assert.match(idx, /const mutatesWorkspace = \(name\) => \/\^fs\\\.\(write\|append\|edit\|patch\)\$\/\.test\(name\) \|\| \/\^\(shell\|verify\)\\\.\/\.test\(name\)/);
  assert.match(idx, /workspaceLease\.acquire\(agentId, runId\)/);
});

test('spreadHold never holds a seat other seats are waiting on (a blocker); it still holds one nobody waits on', () => {
  const o = { cap: 5, spent24h: 2.39, spentLastHour: 0.95, hoursLeft: 9 };
  assert.match(SP.spreadHold(o), /Sprint spreads the daily cap/);
  assert.equal(SP.spreadHold(Object.assign({ blocking: ['Rohan', 'Halima'] }, o)), null);
  assert.match(SP.spreadHold(Object.assign({ blocking: [] }, o)), /allowance \$0\.63/);
});

test('waitingOn: an OPEN item that waits on another seat is not its holder\'s work; blockersOf names who blocks whom', () => {
  const names = { agent: 'Founder', ing: 'Ingrid Halvorsen', nad: 'Nadia farrell', hal: 'Halima Cisse' };
  assert.equal(SP.waitingOn('OPEN — fix written and proposed as hc-0008, waiting on Ingrid Halvorsen\'s review', names, 'nad', 'agent'), 'ing');
  assert.equal(SP.waitingOn('OPEN', names, 'nad', 'agent'), null);
  assert.equal(SP.waitingOn('OPEN — needs Founder\'s ruling', names, 'nad', 'agent'), 'agent');
  assert.equal(SP.waitingOn('OPEN — waiting for the CEO', names, 'nad', 'agent'), 'agent');
  assert.equal(SP.waitingOn('OPEN — blocked on the owner', names, 'nad', 'agent'), 'owner');
  assert.equal(SP.waitingOn('OPEN — waiting on Nadia', names, 'nad', 'agent'), null, 'waiting on yourself is your own work');
  assert.equal(SP.waitingOn('OPEN — waiting on the vendor', names, 'nad', 'agent'), 'someone');
  const b = SP.blockersOf({ items: { nad: [{ open: true, status: 'OPEN — waiting on Ingrid\'s review' }, { open: true, status: 'OPEN' }] }, names, ceo: 'agent', stalled: ['hal', 'roh'] });
  assert.deepEqual(b, { ing: ['nad'], agent: ['hal', 'roh'] });
});

test('rest in Sprint: unchanged work rests at least unchangedRestMin even when the owner set a 1-minute cooldown', () => {
  assert.deepEqual(SP.restMs({ baseMs: 60000, sprint: true, changed: false }), { ms: 15 * 60000, fast: false });
  assert.deepEqual(SP.restMs({ baseMs: 60000, sprint: true, changed: false, unchangedMin: 5 }), { ms: 5 * 60000, fast: false });
  assert.equal(SP.restMs({ baseMs: 60000, sprint: false, changed: false }).ms, 60000, 'outside Sprint the owner\'s cooldown is the rule');
});

test('spreadOn: spreadDailyCap false is off; spreadOffUntil in the future is off until then', () => {
  const now = Date.parse('2026-11-17T08:00:00Z');
  assert.equal(SP.spreadOn({}, now), true);
  assert.equal(SP.spreadOn({ spreadDailyCap: false }, now), false);
  assert.equal(SP.spreadOn({ spreadOffUntil: '2026-11-17T17:00:00Z' }, now), false);
  assert.equal(SP.spreadOn({ spreadOffUntil: '2026-11-17T07:00:00Z' }, now), true);
});

test('seat-status: the plain reason Today shows for each kind of idle', () => {
  const SS = require('../lib/seat-status');
  assert.equal(SS.entry({ state: 'held-money', kind: 'spread', waiting: ['Rohan', 'Halima'] }).reason, 'paused to make today\'s budget last — Rohan and Halima are waiting on it');
  assert.equal(SS.entry({ state: 'waiting', waits: { Founder: 3 } }).reason, 'waiting on Founder for 3 items');
  assert.equal(SS.entry({ state: 'idle' }).reason, 'waiting for new work');
  assert.equal(SS.entry({ state: 'stuck', open: 4, runs: 3, ceoName: 'Founder' }).reason, 'stuck — same 4 items after 3 runs; Founder has been asked');
  const a = SS.carry(null, SS.entry({ state: 'idle' }), 't1'); const b = SS.carry(a, SS.entry({ state: 'idle' }), 't2');
  assert.equal(b.since, 't1', 'since is kept while the reason stays the same');
});
