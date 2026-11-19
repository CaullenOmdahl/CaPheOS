#!/usr/bin/env node
/* meeting-dispatch.test.js — a seat in the owner's meeting (console/meeting.js) while a round runs is neither idle nor
 * wakable: the real dispatch.js against tests/mock-station.js does not fire its loop (no double run), logs MEETING HOLD
 * and says why on Crew; a seat outside the meeting, and the same seat once the round is over, are woken as usual.
 *   node --test company/tools/tests/meeting-dispatch.test.js
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
const TOKEN = 'meeting-dispatch-token';
const SEATS = {
  agent: { name: 'Alex', title: 'Founder and CEO', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', manager: null },
  sam: { name: 'Sam', title: 'Engineer', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent' },
  kim: { name: 'Kim', title: 'Writer', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent' },
};
let mock = null, port = 0; const roots = [];
test.before(async () => {
  const log = path.join(require('../lib/temp-life').tmpDir('meeting-dispatch-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = require('../lib/temp-life').track(spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] }));
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800); assert.notEqual(port, 8810);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const st = async (method, p, body) => (await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

async function company() {
  const T = fs.realpathSync(require('../lib/temp-life').tmpDir('meeting-dispatch-co-')); roots.push(T);
  const tag = path.basename(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Meeting Dispatch ' + tag, owner: { name: 'Pat' }, timezone: 'UTC', station: { port, serviceName: 'meeting-dispatch' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false }; cad.bounds.quietHours = null;
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 5, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', '');
  const agents = {}, ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + (id === 'agent' ? '' : '\n## 2026-11-18 from Alex — do the thing\n**Need:** do it\n**Status:** OPEN\n'));
    const name = s.loop + ' ' + tag;
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ', then work.', provider: 'claude-cli', model: 'claude-haiku-5', schedule: 'every 2h', workdir: T });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { lastRunAt: new Date(Date.now() - 50 * MIN).toISOString(), inFlight: false } });
    agents[id] = Object.assign({}, s, { loop: name });
  }
  w('company/tools/loops.json', { agents });
  const meeting = running => {
    w('company/state/meetings/seats.json', { seats: ['agent', 'sam'], leader: 'agent' });
    w('company/state/meetings/current.json', { id: 'm-test1' });
    w('company/state/meetings/m/m-test1.json', { id: 'm-test1', type: 'decision', state: 'open', opened: true, guests: [], excused: [], run: running ? { round: {}, current: { seat: 'sam' } } : null });
  };
  const tick = () => {
    const n = reqs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: 'UTC', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const fired = reqs().slice(n).filter(r => r.path === '/api/cron/run' && r.method === 'POST').map(r => r.body.id);
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), firedSeats: Object.keys(ids).filter(k => fired.includes(ids[k])).sort(), log: (() => { try { return fs.readFileSync(path.join(T, 'company/work/dispatch-log.md'), 'utf8'); } catch (_) { return ''; } })() };
  };
  // a colleague brought into the owner's live chat with Alex (console/huddle.js): Sam is the guest
  const huddle = running => {
    w('company/state/huddles/agent/seats.json', { seats: ['agent'], leader: 'agent' });
    w('company/state/huddles/agent/current.json', { id: 'm-hud1' });
    w('company/state/huddles/agent/m/m-hud1.json', { id: 'm-hud1', type: 'decision', state: 'open', opened: true, guests: ['sam'], excused: [], run: running ? { round: {}, current: { seat: 'sam' } } : null });
  };
  // a plain 1:1 reply being written (console/chat.js live.json, checked against the chat runs)
  const liveChat = status => {
    w('company/state/huddles/kim/live.json', { seat: 'kim', runId: 'run-live1', at: new Date().toISOString() });
    w('company/state/chat-runs.json', { runs: { 'run-live1': { seat: 'kim', status, streamId: 'console-kim' } } });
  };
  return { T, ids, meeting, huddle, liveChat, tick, reset: async id => st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - 50 * MIN).toISOString(), inFlight: false } }) };
}

test('a seat in a running meeting round is not woken; a seat outside it is', async () => {
  const c = await company();
  c.meeting(true);
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.firedSeats.includes('sam'), 'Sam sits in the meeting: no double run (' + r.firedSeats + ')');
  assert.ok(r.firedSeats.includes('kim'), 'Kim is not in the meeting and is woken as usual: ' + r.log.slice(-800));
  assert.match(r.log, /MEETING HOLD: Sam \(in the owner's meeting; woken after the round\)/);
});

test('once the round is over (the meeting open but idle, or closed), the seat is woken as usual', async () => {
  const c = await company();
  c.meeting(false);
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.firedSeats.includes('sam'), 'no round running: Sam is woken (' + r.firedSeats + ')');
  assert.doesNotMatch(r.log, /MEETING HOLD/);
});

test('a live chat with colleagues in a round holds the host and the guests; an idle one holds no one; a 1:1 reply being written holds that seat', async () => {
  const c = await company();
  c.huddle(true); c.liveChat('running');
  let r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.firedSeats.includes('sam') && !r.firedSeats.includes('kim'), 'Sam is in the chat round, Kim is answering the owner: ' + r.firedSeats);
  assert.match(r.log, /MEETING HOLD: [^\n]*Sam[^\n]*\(in a live chat with the owner; woken after it\)/);
  assert.match(r.log, /MEETING HOLD: [^\n]*Kim[^\n]*\(in a live chat with the owner/);
  for (const id of ['agent', 'sam', 'kim']) await c.reset(id);
  c.huddle(false); c.liveChat('done');
  const before = r.log.length;
  r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.firedSeats.includes('sam') && r.firedSeats.includes('kim'), 'idle chat, finished reply: woken as usual (' + r.firedSeats + ')');
  assert.doesNotMatch(r.log.slice(before), /MEETING HOLD/, 'no hold on the second tick');
});
