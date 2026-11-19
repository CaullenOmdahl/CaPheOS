#!/usr/bin/env node
/* accountable-dispatch.test.js — accountable leads through the real dispatch.js, against tests/mock-station.js (the
 * harness of consult-dispatch.test.js). It proves the dispatcher's side of lib/accountable.js:
 *   live     a member's handed-back item is not woken; the lead's audit routine ("Kwame lead audit", never scheduled by
 *            the station) runs once on the department's fixed audit model as a one-run override, door audit in admit-log,
 *            a wakes.jsonl row (door audit) of the audited item; a member's handoff out of the department is held (its
 *            receiver is not woken) until the lead passes it on; a DONE without the lead's accept goes back to OPEN
 *   shadow   nothing is held: the receiver is woken, the WOULD lines are logged, no audit routine is made
 *   node --test company/tools/tests/accountable-dispatch.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const DISPATCH = path.join(TOOLS, 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3;
const TOKEN = 'accountable-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const LEAD = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' };
const MID = { provider: 'claude-cli', model: 'claude-sonnet-4-6', effort: 'low' };

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo', 'people'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null },
  kwa: { name: 'Kwame', loop: 'Kwame loop', inbox: 'to-kwame.md', manager: 'agent' },
  ben: { name: 'Ben', loop: 'Ben loop', inbox: 'to-ben.md', manager: 'kwa' },
  dan: { name: 'Dan', loop: 'Dan loop', inbox: 'to-dan.md', manager: 'agent' },
};
const depts = acc => ({ version: 1, leadModelDefault: LEAD, departments: [{ id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben'], defaultClass: 'code', routes: {}, consult: {}, accountable: acc }] });
const DIFF = 'diff --git a/src/parse.js b/src/parse.js\n--- a/src/parse.js\n+++ b/src/parse.js\n@@ -1 +1 @@\n-old\n+new\n';

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(__LIFE.tmpDir('accountable-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  for (const bad of [8800, 8810, 8900, 8910]) assert.notEqual(port, bad);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

async function company(acc) {
  const T = __LIFE.tmpDir('accountable-co-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Accountable Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'accountable-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w('.starnet-data/workspaces/runs.jsonl', '');
  for (const f of ['company/defaults/departments.json', 'company/defaults/work/departments/audit-prompt.md']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/departments.json', depts(acc));
  for (const f of ['BRIEF.md', 'DECISIONS.md', 'INBOX-DIGEST.md']) w('company/work/departments/eng/' + f, '# x\n');
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n');
  const agents = {}, ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + '.', provider: 'claude-cli', model: 'haiku', schedule: 'every 2h', workdir: T });
    ids[id] = r.job.id;
    agents[id] = Object.assign({}, s, { loop: name });
  }
  w('company/tools/loops.json', { agents });
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '', STARNET_AGENT_ID: '' });
  const c = { T, ids, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
  c.add = (inbox, text) => fs.appendFileSync(path.join(T, 'company/work/handoffs', inbox), text);
  c.jsonl = rel => c.r(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
  c.cli = argv => {
    const sf = path.join(T, '.t-cli.js');
    fs.writeFileSync(sf, 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(false); process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'accountable.js')) + ').run(' + JSON.stringify(argv) + ')));');
    const p = spawnSync(process.execPath, [sf], { cwd: T, encoding: 'utf8', env }); return JSON.parse(p.stdout);
  };
  c.tick = async (open) => {
    for (const id of Object.values(ids)) await st('POST', '/api/cron/update', { id, patch: { lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false } });
    w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: open || { kwa: [{ provider: MID.provider, model: MID.model }, { provider: LEAD.provider, model: LEAD.model }] } });
    const before = reqs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env });
    const mine = reqs().slice(before);
    const runs = mine.filter(r => r.path === '/api/cron/run' && r.method === 'POST').map(r => r.body);
    const bySeat = {}; for (const b of runs) { const k = Object.keys(ids).find(x => ids[x] === b.id); if (k) bySeat[k] = b; }
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), runs, bySeat, created: mine.filter(r => r.path === '/api/cron' && r.method === 'POST').map(r => r.body), log: c.r('company/work/dispatch-log.md') };
  };
  return c;
}

test('live: the handed-back item waits for the lead\'s audit run on the fixed audit model (door audit); the onward handoff waits for the lead; a DONE without the accept goes back to OPEN', async () => {
  const c = await company({ mode: 'live', since: '2026-11-01T00:00:00Z', by: 'owner', audit: { routine: MID, risky: null }, batch: { startAt: 1, minGapMin: 5, maxWaitMin: 15 } });
  const r0 = await c.tick();   // the first sight: the work already there is left alone; the audit routine is made
  assert.equal(r0.code, 0, r0.out);
  const spec = r0.created.find(b => /^Kwame lead audit/.test(b.name));
  assert.ok(spec && spec.enabled === false && spec.agentId === 'kwa', 'the audit routine, never scheduled by the station: ' + JSON.stringify(r0.created));
  c.add('to-ben.md', '\n## 2026-11-19 from Kwame — fix the parser\n**Id:** ben-1\n**Need:** fix it\n**Acceptance check:** the parser tests pass\n**Check command:** `true`\n**Status:** OPEN\n');
  c.add('to-dan.md', '\n## 2026-11-19 from Ben — deploy the new parser\n**Id:** dan-1\n**Need:** deploy it on Ops\n**Status:** OPEN\n');
  await st('POST', '/__hold', { names: ['Kwame lead audit'] });
  try {
    const r1 = await c.tick();
    assert.equal(r1.code, 0, r1.out);
    assert.ok(r1.bySeat.ben, 'Ben is woken for his new item: ' + r1.log.slice(-1500));
    assert.ok(!r1.bySeat.dan, 'Dan is not woken for a block Ben sent out of the department: ' + r1.log.slice(-1500));
    assert.match(r1.log, /ACCOUNTABLE PASS HELD to-dan\.md#dan-1 \(Ben -> Dan\): waits for Kwame/);
    const parked = JSON.parse(c.r('company/state/parked.json')).items;
    assert.ok(parked.some(x => x.seat === 'dan' && x.kind === 'audit' && /Kwame to pass it on/.test(x.words)), JSON.stringify(parked));
    // the lead's "Pass on" block is the audit run's work (routine tier), not a wake of Kwame's own loop on the top tier
    assert.match(r1.log, /AUDIT Kwame lead audit[^\n]* for Kwame \(routine on claude-cli\/claude-sonnet-4-6@low\): pass:to-dan\.md#dan-1/);
    assert.ok(!r1.bySeat.kwa, 'Kwame\'s loop is not woken for the pass-on block: ' + r1.log.slice(-1200));
    await st('POST', '/__finish', { name: 'Kwame lead audit' });
    c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { lastAudit: {} }));
    fs.writeFileSync(path.join(c.T, 'diff.txt'), DIFF);
    const hb = c.cli(['handback', 'ben-1', '--note', 'ran the parser tests, all green on my side', '--diff-file', path.join(c.T, 'diff.txt'), '--by', 'Ben']);
    assert.equal(hb.code, 0, JSON.stringify(hb)); assert.equal(hb.out.tier, 'routine');
    const r2 = await c.tick();
    assert.ok(!r2.bySeat.ben, 'Ben is not woken for the item while Kwame audits it');
    const job = ((await st('GET', '/api/cron')).jobs || []).find(j => j.name === spec.name && j.workdir === c.T);
    const aud = r2.runs.filter(b => b.id === job.id);
    assert.equal(aud.length, 1, 'one audit run: ' + r2.log.slice(-1500));
    assert.deepEqual(aud[0], { id: job.id, detach: true, provider: MID.provider, model: MID.model, effort: MID.effort }, 'on the owner\'s fixed routine-audit pair, as a one-run override');
    assert.match(job.prompt, new RegExp('Open audits for you: ' + hb.out.id + ' \\(in your inbox\\)\\.'));
    assert.ok(c.jsonl('company/state/admit-log.jsonl').some(x => x.door === 'audit' && x.seat === 'kwa'));
    const wk = c.jsonl('company/state/wakes.jsonl').filter(x => x.door === 'audit');
    assert.equal(wk.length, 2, 'the pass-on run, then the audit'); assert.deepEqual(wk.map(w => w.items.map(i => i.id)), [['to-dan.md#dan-1'], ['ben-1']]);
    // Ben sets it DONE himself before the verdict: back to OPEN
    const t = c.r('company/work/handoffs/to-ben.md'); fs.writeFileSync(path.join(c.T, 'company/work/handoffs/to-ben.md'), t.replace(/^\*\*Status:\*\* OPEN$/m, '**Status:** DONE — finished'));
    const r3 = await c.tick();
    assert.match(r3.log, /ACCOUNTABLE DONE HELD to-ben\.md#ben-1/);
    assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* OPEN — not done until Kwame accepts it/);
    // the lead accepts and passes the onward handoff on: Dan is woken
    assert.equal(c.cli(['audit', hb.out.id, '--verdict', 'ACCEPT', '--check', 'the diff against the parser tests', '--by', 'Kwame']).code, 0);
    assert.equal(c.cli(['pass', 'to-dan.md#dan-1', '--by', 'Kwame']).code, 0);
    const r4 = await c.tick();
    assert.ok(r4.bySeat.dan, 'passed on: Dan is woken: ' + r4.log.slice(-1200));
    assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* DONE — accepted by Kwame/);
  } finally { await st('POST', '/__hold', { names: [] }); }
});

test('recording only: nothing is held, the receiver is woken, the WOULD lines are logged, no audit routine', async () => {
  const c = await company({ mode: 'shadow' });
  await c.tick();
  c.add('to-dan.md', '\n## 2026-11-19 from Ben — deploy the new parser\n**Id:** dan-1\n**Need:** deploy it on Ops\n**Status:** OPEN\n');
  const r = await c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(r.bySeat.dan, 'recording only holds nothing');
  assert.match(r.log, /WOULD HOLD to-dan\.md#dan-1 \(Ben -> Dan\) for Kwame to pass on \(recording only\)/);
  assert.ok(!r.created.some(b => /lead audit/.test(b.name)), 'no audit routine in recording only');
});
