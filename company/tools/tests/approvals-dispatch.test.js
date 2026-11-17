#!/usr/bin/env node
/* approvals-dispatch.test.js — a BLOCKING approval holds its asker in the real dispatch.js, against tests/mock-station.js
 * (the shape of the Founder hold: the held seat and the seats waiting on it get zero wakes over several ticks, the
 * owner gets ONE reminder); the answer releases it and the asker is woken through the owner-message path.
 * The dispatcher's hook is a read (approvals.blockingSeats()); nothing here touches a live station or the checkout.
 *
 *   node --test company/tools/tests/approvals-dispatch.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const DISPATCH = path.join(REPO, 'company', 'tools', 'dispatch.js');
const AP = path.join(REPO, 'company', 'tools', 'approvals.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3;
const TOKEN = 'approvals-dispatch-token';
const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, wakeOnOwnerMessage: false, priority: 100, manager: null },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent' },
  wen: { name: 'Wen', loop: 'Wen loop', inbox: 'to-wen.md', manager: 'agent' },
  kim: { name: 'Kim', loop: 'Kim loop', inbox: 'to-kim.md', manager: 'agent' },
};
const block = (head, status) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n**Status:** ' + (status || 'OPEN') + '\n';
const HANDOFFS = {
  'to-sam.md': block('buy the data plan'),
  'to-wen.md': block('ship the pricing study', 'OPEN — waiting on Sam'),   // Wen depends on Sam
  'to-kim.md': block('check the data feed'),                                // the control: an unrelated seat
};

let mock = null, port = 0; const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apdisp-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const st = async (method, p, body) => (await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');

async function company() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'apdisp-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('.capheos-selftest-fixture', '');   // this throwaway company's owner is whoever made it (provenance fixtureRoot)
  w('company/company.json', { name: 'Approvals Dispatch ' + path.basename(T), owner: { name: 'Pat' }, timezone: 'UTC', station: { port, serviceName: 'apdisp-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8')); cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: { spend: 'approve' } });
  w('company/owner/inbound.jsonl', '');
  w('company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n');
  w('.starnet-data/workspaces/runs.jsonl', '');
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + (HANDOFFS[s.inbox] || ''));
  const agents = {}; const ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ', then work.', provider: 'claude-cli', model: 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), name } });
    agents[id] = Object.assign({}, s, { loop: name });
  }
  w('company/tools/loops.json', { agents });
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T, DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' });
  const c = { T, ids, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
  c.jsonl = rel => c.r(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
  c.tick = () => {
    const before = runs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env });
    const fired = runs().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(Boolean).sort();
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), fired, log: c.r('company/work/dispatch-log.md') };
  };
  c.rest = async () => { for (const id of Object.values(ids)) await st('POST', '/api/cron/update', { id, patch: { lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false } }); };
  c.ap = code => { const r = spawnSync(process.execPath, ['-e', 'const A = require(' + JSON.stringify(AP) + '); Promise.resolve((() => {' + code + '})()).then(v => console.log(JSON.stringify(v === undefined ? null : v)));'], { cwd: T, env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };
  return c;
}
// a blocking approval Sam asked for 20 minutes ago (so one reminder is due), minted the way approvals.js ask mints it
function plantApproval(c) {
  const a = c.ap('return A.ask({ from: "Sam", category: "spend", message: "May we buy one month of the example data plan for $20?", params: { amountUsd: 20 }, blocking: true });');
  assert.equal(a.minted, true, JSON.stringify(a));
  const f = path.join(c.T, 'company/pm-inbox.jsonl');
  const back = new Date(Date.now() - 20 * MIN).toISOString();
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); if (r.type === 'ask' && r.id === a.id) r.at = back; return JSON.stringify(r); }).join('\n') + '\n');
  return a;
}

test('control: with no approval, Sam (open work) and Kim are woken; Wen waits on Sam', async () => {
  const c = await company();
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.fired.includes('sam') && r.fired.includes('kim'), r.log);
  assert.ok(!r.fired.includes('wen'), 'Wen waits on Sam: ' + r.log);
});

test('a blocking approval: zero wakes for the asker and the seat waiting on it over three ticks, ONE reminder; the answer releases and wakes the asker', async () => {
  const c = await company();
  const a = plantApproval(c);
  const fired = [];
  for (let i = 0; i < 3; i++) { await c.rest(); const r = c.tick(); assert.equal(r.code, 0, r.out); fired.push(r.fired); }
  const all = fired.flat();
  assert.equal(all.filter(x => x === 'sam').length, 0, 'the asker is held: ' + JSON.stringify(fired) + '\n' + c.r('company/work/dispatch-log.md'));
  assert.equal(all.filter(x => x === 'wen').length, 0, 'the seat waiting on the asker is not woken: ' + JSON.stringify(fired));
  assert.ok(all.includes('kim'), 'an unrelated seat still works: ' + JSON.stringify(fired));
  const log = c.r('company/work/dispatch-log.md');
  assert.equal((log.match(new RegExp('WAITING on approval ' + a.id + ' \\(sam\\)', 'g')) || []).length, 1, 'logged once, not every tick: ' + log);
  const seats = JSON.parse(c.r('company/work/dispatch-state.json')).seats;
  assert.equal(seats.sam.state, 'waiting', JSON.stringify(seats.sam)); assert.match(seats.sam.reason, /waiting on you \(the owner\)/);
  const rem = c.jsonl('company/pm-inbox.jsonl').filter(x => x.type === 'approval-reminder');
  assert.equal(rem.length, 1, 'one reminder over three ticks: ' + JSON.stringify(rem)); assert.deepEqual(rem[0].ids, [a.id]);
  assert.equal(c.jsonl('company/owner/outbound.jsonl').filter(m => /waiting for you on Today › Needs you/.test(m.text)).length, 1);

  // the owner answers (Needs you): the hold is released and Sam is woken through the owner-message path
  const ans = c.ap('return A.answer(' + JSON.stringify(a.id) + ', { verdict: "yes", surface: "needs-you", by: "owner", shownDigest: ' + JSON.stringify(a.actionDigest) + ' });');
  assert.equal(ans.ok, true, JSON.stringify(ans));
  assert.deepEqual(c.ap('return A.blockingSeats();'), {});
  await c.rest();
  const r = c.tick();
  assert.ok(r.fired.includes('sam'), 'the asker is woken once the hold ends: ' + r.log);
  assert.ok(c.jsonl('company/owner/inbound.jsonl').some(m => m.re === a.id && /^Sam, my answer to your question/.test(m.text)));
});

test('expiry and withdrawal release the hold too (a hold is never permanent)', async () => {
  const c = await company();
  const a = c.ap('return A.ask({ from: "Sam", category: "spend", message: "A purchase that may expire.", params: { amountUsd: 5 }, blocking: true, expiresMin: 1 });');
  await c.rest(); assert.ok(!c.tick().fired.includes('sam'), 'held while pending');
  c.ap('A._S.now = () => Date.now() + 2 * 60e3; return A.tick({ actor: "the dispatcher" });');
  assert.equal(c.ap('return A.get(' + JSON.stringify(a.id) + ').status;'), 'expired');
  await c.rest(); assert.ok(c.tick().fired.includes('sam'), 'released by expiry');
  const b = c.ap('return A.ask({ from: "Sam", category: "spend", message: "A purchase Sam will withdraw.", params: { amountUsd: 6 }, blocking: true });');
  await c.rest(); assert.ok(!c.tick().fired.includes('sam'), 'held again');
  assert.equal(c.ap('return A.withdraw(' + JSON.stringify(b.id) + ', { by: "Sam", why: "found a free source" });').ok, true);
  await c.rest(); assert.ok(c.tick().fired.includes('sam'), 'released by withdrawal');
});
