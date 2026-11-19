#!/usr/bin/env node
/* consult-dispatch.test.js — advisor leads through the real dispatch.js, against tests/mock-station.js (the harness of
 * routing-dispatch.test.js). It proves the dispatcher's side of lib/consult.js:
 *   live     three consults start ONE advise run of the lead: its routine is created ("Kwame advise", never scheduled by
 *            the station), it runs on the lead model as a one-run override, door consult in admit-log, a wakes.jsonl row
 *            (door consult) lists the consulted items; the members are not woken for their held items; the lead's own loop
 *            is not woken while the advise run is in flight, and is again after; the family books add up
 *   shadow   WOULD ADVISE is logged, no routine, no advise run; the members are woken as before
 *   paused   acts as shadow (WOULD ADVISE, nothing runs)
 *   stuck    two failed runs on an item open exactly one consult, delivered to the lead
 *   off      no consult file, no advise routine, no CONSULT line: a company without advice behaves as before
 *   node --test company/tools/tests/consult-dispatch.test.js
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
const MIN = 60e3;
const TOKEN = 'consult-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const LEAD = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' };

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null },
  kwa: { name: 'Kwame', loop: 'Kwame loop', inbox: 'to-kwame.md', manager: 'agent' },
  ben: { name: 'Ben', loop: 'Ben loop', inbox: 'to-ben.md', manager: 'kwa' },
  cat: { name: 'Cat', loop: 'Cat loop', inbox: 'to-cat.md', manager: 'kwa' },
  dan: { name: 'Dan', loop: 'Dan loop', inbox: 'to-dan.md', manager: 'kwa' },
};
const block = (id, head) => '\n## 2026-11-17 from Alex — ' + head + '\n**Id:** ' + id + '\n**Need:** do it\n**Status:** OPEN\n';
const WORK = { 'to-ben.md': block('ben-1', 'fix the parser'), 'to-cat.md': block('cat-1', 'write the docs'), 'to-dan.md': block('dan-1', 'tune the cache') };
const depts = advisor => ({ version: 1, leadModelDefault: LEAD, departments: [{ id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben', 'cat', 'dan'], defaultClass: 'code', routes: {},
  consult: { maxPerDay: 12, stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2 }, advisor }] });

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'consult-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800); assert.notEqual(port, 8810); assert.notEqual(port, 8900); assert.notEqual(port, 8910);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

async function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Consult Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'consult-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: o.metered ? ['ollama'] : ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('.starnet-data/workspaces/runs.jsonl', o.spent ? JSON.stringify({ runId: 'r-spent', agentId: 'ben', provider: 'claude-cli', model: 'haiku', usd: o.spent, startedAt: Date.now() - 5 * MIN, endedAt: Date.now() - 4 * MIN, reason: 'done' }) + '\n' : '');
  for (const f of ['company/defaults/departments.json', 'company/defaults/work/departments/advise-prompt.md']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  if (o.advisor !== false) w('company/departments.json', depts(o.advisor || { mode: 'live', since: '2026-11-01T00:00:00Z', by: 'owner', paused: null }));
  for (const f of ['BRIEF.md', 'DECISIONS.md', 'INBOX-DIGEST.md']) w('company/work/departments/eng/' + f, '# x\n');
  const work = Object.assign({}, WORK, o.handoffs || {});
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + (work[s.inbox] || ''));
  const agents = {}, ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ', then work on /api/quests.', provider: 'claude-cli', model: 'haiku', schedule: 'every 2h', workdir: T });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false } });
    agents[id] = Object.assign({}, s, { loop: name });
  }
  w('company/tools/loops.json', { agents });
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' });
  const c = { T, ids, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return null; } } };
  c.jsonl = rel => (c.r(rel) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));
  c.ask = (seat, item) => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(false); process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'consult.js')) + ').run(["ask", "--item", ' + JSON.stringify(item) + ', "--question", "is this the right way?", "--by", ' + JSON.stringify(seat) + '])));';
    const p = spawnSync(process.execPath, ['-e', code], { cwd: T, encoding: 'utf8', env });
    return JSON.parse(p.stdout);
  };
  c.tick = (t) => {
    w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: (t && t.open) || { kwa: [{ provider: LEAD.provider, model: LEAD.model }] } });
    const before = reqs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env });
    const mine = reqs().slice(before);
    const runs = mine.filter(r => r.path === '/api/cron/run' && r.method === 'POST').map(r => r.body);
    const bySeat = {}; for (const b of runs) { const k = Object.keys(ids).find(x => ids[x] === b.id); if (k) bySeat[k] = b; }
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), runs, bySeat, created: mine.filter(r => r.path === '/api/cron' && r.method === 'POST').map(r => r.body), log: c.r('company/work/dispatch-log.md') || '' };
  };
  return c;
}

test('live: three consults start one advise run on the lead model (door consult, a wakes row of the items); the lead\'s loop waits while it runs', async () => {
  const c = await company({ handoffs: { 'to-kwame.md': block('kwa-1', 'plan the release') } });
  const ids = [c.ask('Ben', 'ben-1'), c.ask('Cat', 'cat-1'), c.ask('Dan', 'dan-1')].map(r => { assert.equal(r.code, 0, JSON.stringify(r)); return r.out.id; });
  await st('POST', '/__hold', { names: ['Kwame advise'] });
  try {
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    const spec = r.created.find(b => /^Kwame advise/.test(b.name));
    assert.ok(spec, 'the advise routine is created: ' + JSON.stringify(r.created));
    assert.equal(spec.enabled, false, 'never scheduled by the station'); assert.equal(spec.agentId, 'kwa');
    const job = ((await st('GET', '/api/cron')).jobs || []).find(j => j.name === spec.name && j.workdir === c.T);
    const adv = r.runs.filter(b => b.id === job.id);
    assert.equal(adv.length, 1, 'exactly one advise run: ' + r.log);
    assert.deepEqual(adv[0], { id: job.id, detach: true, provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, 'on the lead model as a one-run override');
    assert.match(job.prompt, new RegExp('Open consults for you: ' + ids.join(', ') + ' \\(in your inbox\\)\\.'));
    for (const s of ['ben', 'cat', 'dan']) assert.ok(!r.bySeat[s], s + ' is not woken for an item whose consult is open');
    assert.ok(!r.bySeat.kwa, 'the lead\'s loop does not start beside its advise run');
    const admits = c.jsonl('company/state/admit-log.jsonl');
    const a = admits.find(x => x.door === 'consult');
    assert.ok(a && a.seat === 'kwa' && a.decision === 'allow' && a.jobId === job.id, JSON.stringify(admits));
    assert.ok(admits.some(x => x.ref === a.id && x.outcome === 'started'));
    const wk = c.jsonl('company/state/wakes.jsonl').filter(x => x.door === 'consult');
    assert.equal(wk.length, 1); assert.equal(wk[0].seat, 'kwa');
    assert.deepEqual(wk[0].items.map(i => i.file + ':' + i.id).sort(), ['to-ben.md:ben-1', 'to-cat.md:cat-1', 'to-dan.md:dan-1']);
    assert.match(wk[0].why, /^advise cs-/);
    const led = c.jsonl('company/state/consults.jsonl').filter(x => x.op === 'advise');
    assert.equal(led.length, 1); assert.deepEqual(led[0].ids.sort(), ids.slice().sort()); assert.equal(led[0].runId, wk[0].runId);
    assert.match(r.log, /ADVISE ROUTINE created "Kwame advise/); assert.match(r.log, /ADVISE Kwame advise\S* for Kwame: .*one-run override/);
    // a second tick while the advise run is in flight: no second advise run, and the lead's loop still waits
    const r2 = c.tick();
    assert.equal(r2.runs.filter(b => b.id === job.id).length, 0); assert.ok(!r2.bySeat.kwa, 'not woken while advising');
    // the family books: every run is attributed, the advise run to door consult; the books add up
    const A = require(path.join(TOOLS, 'lib', 'admit.js')), F = require(path.join(TOOLS, 'lib', 'family.js'));
    const runs = ((await st('GET', '/api/runs')).runs || []).filter(x => x.runId === wk[0].runId);
    const att = A.attribute(runs.length ? runs : [{ runId: wk[0].runId, agentId: 'kwa', startedAt: wk[0].at, usd: 0.25 }], c.jsonl('company/state/admit-log.jsonl'));
    assert.equal(att[0].door, 'consult', JSON.stringify(att));
    const books = F.books([{ runId: wk[0].runId, agentId: 'kwa', usd: 0.25 }, { runId: 'r-ben', agentId: 'ben', usd: 0.5 }]);
    assert.equal(books.total, 0.75); assert.equal(books.bySeat.kwa + books.bySeat.ben, books.total);
    await st('POST', '/__finish', { id: job.id, status: 'ok' });
    const r3 = c.tick();
    assert.ok(r3.bySeat.kwa, 'the advise run ended: the lead\'s own loop is woken again: ' + r3.log.split('\n').slice(-12).join('\n'));
  } finally { await st('POST', '/__hold', { names: [] }); }
});

test('shadow: WOULD ADVISE is logged, no routine and no advise run; the members are woken as before. Paused acts the same', async () => {
  for (const advisor of [{ mode: 'shadow' }, { mode: 'live', since: '2026-11-01T00:00:00Z', paused: { at: '2026-11-19T00:00:00Z', by: 'auto', why: 'cost per item rose' } }]) {
    const c = await company({ advisor });
    for (const [s, i] of [['Ben', 'ben-1'], ['Cat', 'cat-1'], ['Dan', 'dan-1']]) assert.equal(c.ask(s, i).code, 0);
    assert.equal(c.r('company/work/handoffs/to-kwame.md'), '# Handoffs\n', 'no packet delivered');
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    assert.match(r.log, advisor.paused ? /WOULD ADVISE Kwame \(Engineering, paused\): cs-/ : /WOULD ADVISE Kwame \(Engineering, recording only\): cs-/);
    const jobs = (await st('GET', '/api/cron')).jobs.filter(j => j.workdir === c.T && /advise/.test(j.name));
    assert.equal(r.runs.filter(b => jobs.some(j => j.id === b.id)).length, 0, 'no advise run');
    if (!advisor.paused) assert.equal(jobs.length, 0, 'recording only: no routine');
    for (const s of ['ben', 'cat', 'dan']) assert.ok(r.bySeat[s], s + ' is woken as before (recording only holds nothing)');
    assert.ok(!c.jsonl('company/state/admit-log.jsonl').some(x => x.door === 'consult'));
    const led = c.jsonl('company/state/consults.jsonl').filter(x => x.op === 'advise');
    assert.equal(led.length, 1); assert.equal(led[0].shadow, true);
    assert.equal(c.tick().log.match(/WOULD ADVISE/g).length, 1, 'logged once for those consults');
  }
});

test('stuck: two failed runs on an item open exactly one consult, delivered to the lead', async () => {
  const c = await company({ handoffs: { 'to-cat.md': '', 'to-dan.md': '' } });
  assert.equal(c.tick().code, 0);   // first sight: the baseline
  const at = Date.now() + 1000;
  const wk = n => ({ at: at + n, ts: new Date(at + n).toISOString(), wakeId: 'wk-t' + n, seat: 'ben', runId: 'run-f' + n, door: 'dispatch', items: [{ file: 'to-ben.md', id: 'ben-1', title: 'fix the parser', due: null }], why: 'x' });
  const run = n => ({ runId: 'run-f' + n, agentId: 'ben', startedAt: at + n, endedAt: at + n + 500, ts: at + n + 500, reason: 'max_iters', provider: 'claude-cli', model: 'haiku', usd: 0 });
  fs.appendFileSync(path.join(c.T, 'company/state/wakes.jsonl'), [wk(1), wk(2)].map(x => JSON.stringify(x)).join('\n') + '\n');
  fs.appendFileSync(path.join(c.T, '.starnet-data/workspaces/runs.jsonl'), [run(1), run(2)].map(x => JSON.stringify(x)).join('\n') + '\n');
  await new Promise(res => setTimeout(res, 1100));
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.match(r.log, /CONSULT OPENED cs-\S+ for Ben "[^"]*fix the parser" \(failed-runs:2\) -> Kwame/);
  const open = c.jsonl('company/state/consults.jsonl').filter(x => x.op === 'open');
  assert.equal(open.length, 1); assert.equal(open[0].trigger, 'failed-runs:2'); assert.equal(open[0].kind, 'stuck');
  assert.match(c.r('company/work/handoffs/to-kwame.md'), /\*\*From:\*\* dispatcher on behalf of Ben[\s\S]*- run run-f1: max_iters/);
  assert.equal(c.jsonl('company/state/consults.jsonl').filter(x => x.op === 'open').length, 1);
  c.tick();
  assert.equal(c.jsonl('company/state/consults.jsonl').filter(x => x.op === 'open').length, 1, 'one trigger, one consult');
});

test('off: no departments advice, no consult files, no advise routine, no CONSULT line', async () => {
  const c = await company({ advisor: false });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  for (const s of ['ben', 'cat', 'dan']) assert.ok(r.bySeat[s]);
  assert.equal(c.r('company/state/consults.jsonl'), null); assert.equal(c.r('company/state/consult-state.json'), null);
  assert.doesNotMatch(r.log, /CONSULT|ADVISE/);
  assert.ok(!r.created.some(b => /advise/.test(b.name)));
});

test('an advise run passes the money and pacer checks like any wake: the daily cap holds it; a shut lead model falls back only to an open own model', async () => {
  // the daily metered cap is reached and the lead model is metered: no advise run
  let c = await company({ metered: true, spent: 5 });
  [c.ask('Ben', 'ben-1'), c.ask('Cat', 'cat-1'), c.ask('Dan', 'dan-1')].forEach(r => assert.equal(r.code, 0, JSON.stringify(r)));
  let r = c.tick();
  let job = ((await st('GET', '/api/cron')).jobs || []).find(j => /^Kwame advise/.test(j.name) && j.workdir === c.T);
  assert.ok(job, 'the routine exists: ' + r.log);
  assert.equal(r.runs.filter(b => b.id === job.id).length, 0, 'no advise run past the daily cap');
  assert.match(r.log, /ADVISE HOLD Kwame advise\S* for Kwame: .*daily metered cap/);
  // the lead model is shut by the pacer and the routine's own model is not open either: held, never "on its own model anyway"
  c = await company();
  [c.ask('Ben', 'ben-1'), c.ask('Cat', 'cat-1'), c.ask('Dan', 'dan-1')].forEach(x => assert.equal(x.code, 0));
  r = c.tick({ open: { kwa: [] } });
  job = ((await st('GET', '/api/cron')).jobs || []).find(j => /^Kwame advise/.test(j.name) && j.workdir === c.T);
  assert.equal(r.runs.filter(b => b.id === job.id).length, 0, 'no advise run on a model nobody opened: ' + r.log);
  assert.match(r.log, /ADVISE HOLD Kwame advise\S* for Kwame: .*lead model is .*its own model is /);
  // its model open (the advise routine is created on the lead model): it runs
  r = c.tick({ open: { kwa: [{ provider: job.provider, model: job.model }] } });
  assert.equal(r.runs.filter(b => b.id === job.id).length, 1, r.log);
  // the approval mode "ask" holds it too (the source: the same rule as the dispatcher's wakes)
  const src = fs.readFileSync(path.join(TOOLS, 'lib', 'consult.js'), 'utf8');
  assert.match(src, /ctx\.modes && ctx\.modes\[lead\] === 'ask' && !ctx\.allowAsk/);
  assert.match(fs.readFileSync(path.join(TOOLS, 'dispatch.js'), 'utf8'), /consultStep\(\{ dry: DRY, log, jobs, order, say, call, fireRun, modes, allowAsk: ALLOW_ASK, budget: \{/);
});

test('in a code department an advise run never runs on MiniMax: the lead model and the routine\'s own model face the code rule too', async () => {
  const c = await company();
  const d = JSON.parse(c.r('company/departments.json')); d.leadModelDefault = { provider: 'custom', model: 'MiniMax-M3.1-Pro', effort: 'medium' };
  c.w('company/departments.json', d);
  [c.ask('Ben', 'ben-1'), c.ask('Cat', 'cat-1'), c.ask('Dan', 'dan-1')].forEach(x => assert.equal(x.code, 0, JSON.stringify(x)));
  const r = c.tick({ open: { kwa: [{ provider: 'custom', model: 'MiniMax-M3.1-Pro' }] } });
  const job = ((await st('GET', '/api/cron')).jobs || []).find(j => /^Kwame advise/.test(j.name) && j.workdir === c.T);
  assert.ok(job, r.log);
  assert.equal(r.runs.filter(b => b.id === job.id && b.override && b.override.provider === 'custom').length, 0, 'never on MiniMax: ' + r.log);
  assert.ok(!r.runs.some(b => b.id === job.id && (b.provider === 'custom' || (b.override && b.override.provider === 'custom'))), r.log);
  assert.match(r.log, /ADVISE HOLD Kwame advise\S* for Kwame: .*code is never on the MiniMax plan/);
});
