#!/usr/bin/env node
/* cross-e2e.test.js — cross-branch checks for w2-router + w2-controls + w2-analysis (scratch).
 *   E2E_REPO=<worktree> node --test cross-e2e.test.js
 * E2E_MAIN=<main worktree> for check (5).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(process.env.E2E_REPO);
const MAIN = process.env.E2E_MAIN ? path.resolve(process.env.E2E_MAIN) : null;
const TOOLS = path.join(REPO, 'company', 'tools');
const MIN = 60e3, TOKEN = 'cross-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const OUT = process.env.E2E_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'cross-out-'));
const dump = (n, v) => fs.writeFileSync(path.join(OUT, n), typeof v === 'string' ? v : JSON.stringify(v, null, 1));

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cross-mock-')), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [path.join(REPO, 'tests', 'mock-station.js'), '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} if (!process.env.E2E_KEEP) for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n' + (extra || '') + '**Status:** OPEN\n';

/* a company. o.repo (dispatch.js from), o.defaults (copy the framework company/defaults so the default routing policy is
 * there, as in a real checkout), o.seats, o.handoffs, o.departments, o.modelPolicy, o.policy, o.allow, o.patchDefault */
async function company(o) {
  o = o || {};
  const repo = o.repo || REPO;
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-co-')); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  if (o.defaults) fs.cpSync(path.join(repo, 'company', 'defaults'), path.join(T, 'company', 'defaults'), { recursive: true });
  if (o.patchDefault) { const f = 'company/defaults/work/models/routing-policy.json'; const d = JSON.parse(fs.readFileSync(path.join(T, f), 'utf8')); o.patchDefault(d); w(f, d); }
  w('company/company.json', { name: 'Cross ' + path.basename(T), slug: 'cross', owner: { name: 'Olive', addressAs: 'Olive' }, timezone: TZ, station: { port, serviceName: 'cross-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const seats = o.seats;
  const agents = {}; for (const [id, s] of Object.entries(seats)) { const c = Object.assign({}, s); delete c.provider; delete c.model; agents[id] = c; }
  const cad = JSON.parse(fs.readFileSync(path.join(repo, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/owner/inbound.jsonl', '');
  w('company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n\n');
  w('.starnet-data/workspaces/runs.jsonl', '');
  if (o.policy) w('company/work/models/routing-policy.json', o.policy);
  if (o.departments) w('company/departments.json', o.departments);
  if (o.modelPolicy) w('company/model-policy.json', o.modelPolicy);
  for (const s of Object.values(seats)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + ((o.handoffs || {})[s.inbox] || ''));
  const ids = {};
  for (const [id, s] of Object.entries(seats)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id + '-' + path.basename(T), prompt: 'Read company/work/handoffs/' + s.inbox + ', then work.', provider: s.provider, model: s.model || (s.provider === 'deepseek' ? 'deepseek-flash' : 'haiku'), schedule: 'every 2h' });
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
    const p = spawnSync(process.execPath, [path.join(repo, 'company', 'tools', 'dispatch.js')], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }) });
    const mine = runs().slice(before);
    const bySeat = {}; for (const r of mine) { const k = Object.keys(ids).find(x => ids[x] === r.body.id); if (k) bySeat[k] = r.body; }
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), bodies: mine.map(r => r.body), bySeat, log: (() => { try { return c.r('company/work/dispatch-log.md'); } catch (_) { return ''; } })() };
  };
  c.wake = seat => c.jsonl('company/state/wakes.jsonl').filter(r => r.seat === seat).pop();
  // routing.js, as the owner (pinned owner shell) or as a seat
  c.routing = (argv, owner) => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (owner ? 'true' : 'false') + ');' +
      'const r = require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
    const r = spawnSync(process.execPath, ['-e', code], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_READONLY: '' }) });
    if (r.status !== 0) throw new Error('routing.js child failed: ' + r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  };
  return c;
}

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null, provider: 'claude-cli' },
  hal: { name: 'Hal', functions: ['people'], loop: 'Hal loop', inbox: 'to-hal.md', manager: 'agent', provider: 'claude-cli' },
  sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'deepseek', model: 'deepseek-flash' },
};
const MODEL_POLICY = { allowed: {
  'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2[1m]'] },
  custom: { models: ['MiniMax-M3.1-Pro', 'MiniMax-M3.1-Flash', 'MiniMax-M2'] },
  deepseek: { models: ['deepseek-flash', 'deepseek-pro'] } } };
const DEPTS = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['sam'], defaultClass: 'writing', routes: {}, consult: {} }] };
const SONNET = { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, HAIKU = { provider: 'claude-cli', model: 'haiku' };
const DSF = { provider: 'deepseek', model: 'deepseek-flash' }, DSP = { provider: 'deepseek', model: 'deepseek-pro' };

/* ---------- (1) routing.js writes the trial; the owner starts it; the dispatcher assigns the arm ---------- */
test('(1) a trial created by routing.js, started by the owner, is what lib/routing.js reads: the dispatcher assigns its arm', async () => {
  const assigned = [];
  // run until both arms have been seen at least once (a new wakeId per tick), at most 8 companies
  for (let k = 0; k < 8 && new Set(assigned.map(a => a.arm)).size < 2; k++) {
    const c = await company({ seats: SEATS, departments: DEPTS, modelPolicy: MODEL_POLICY, defaults: true,
      patchDefault: d => { d.trialLimits = Object.assign({}, d.trialLimits, { maxEntryShare: 1 }); },
      handoffs: { 'to-sam.md': block('write the notes ' + k, '**Class:** writing\n') },
      allow: { sam: [DSP, DSF] } });
    const cr = c.routing(['trial', 'create', 'wr-cmp', '--class', 'writing', '--arm', 'deepseek/deepseek-pro', '--arm', 'deepseek/deepseek-flash', '--scope-dept', 'eng', '--entry-share', '1', '--min-items', '2', '--pause-when-held', 'deepseek', '--by', 'Hal']);
    assert.equal(cr.code, 0, JSON.stringify(cr.out));
    assert.equal(c.routing(['trial', 'start', 'wr-cmp', '--by', 'owner'], true).code, 0);
    assert.equal(c.routing(['mode', 'live', '--by', 'owner'], true).code, 0);
    const pol = JSON.parse(c.r('company/work/models/routing-policy.json'));
    if (k === 0) dump('1-policy.json', pol);
    // lib/routing.js reads exactly this file
    const R = require(path.join(TOOLS, 'lib', 'routing.js'));
    const L = R.loadPolicy(c.T); assert.equal(L.source, 'company/work/models/routing-policy.json');
    const K = R.knobs(L.policy);
    assert.equal(K.mode, 'live'); assert.equal(K.trials.length, 1); assert.equal(K.trials[0].status, 'running');
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    const w = c.wake('sam');
    assert.ok(w && w.route, 'sam woke with a route: ' + r.log.slice(-3000));
    const g = R.assign(K.trials[0], w.wakeId);
    assert.equal(w.route.trial, 'wr-cmp', JSON.stringify(w.route)); assert.equal(w.route.arm, g.arm);
    assert.equal(w.route.source, 'trial');
    const armPair = K.trials[0].arms[g.arm];
    assert.equal(w.route.model, armPair.model);
    if (g.arm === 1) {   // deepseek-flash is sam's own pair: the control arm, no override
      assert.equal(w.route.applied, false); assert.deepEqual(Object.keys(r.bySeat.sam).sort(), ['detach', 'id']);
    } else {
      assert.equal(w.route.applied, true); assert.deepEqual(r.bySeat.sam, { id: c.ids.sam, detach: true, provider: 'deepseek', model: 'deepseek-pro' });
    }
    assigned.push({ arm: g.arm, route: w.route, body: r.bySeat.sam });
    // routing.js status counts it
    const s = c.routing(['status', '--json']).out.trials[0];
    assigned[assigned.length - 1].status = s.arms.map(a => ({ wakes: a.wakes, items: a.items, shadowWakes: a.shadowWakes, shadowItems: a.shadowItems }));
    assigned[assigned.length - 1].statusLog = c.routing(['status', '--json']).out.log;
    assigned[assigned.length - 1].routingLog = c.jsonl('company/work/models/routing-log.jsonl');
  }
  dump('1-assigned.json', assigned);
  assert.ok(assigned.length >= 1);
});

/* ---------- (1b) a pacer pause the router records: does routing.js status show it? ---------- */
test('(1b) the router pauses a claude-cli trial (the mock pacer holds claude): routing.js status names the hold', async () => {
  const seats = Object.assign({}, SEATS, { sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli', model: 'haiku' } });
  const c = await company({ seats, departments: DEPTS, modelPolicy: MODEL_POLICY, defaults: true,
    patchDefault: d => { d.trialLimits = Object.assign({}, d.trialLimits, { maxEntryShare: 1 }); },
    handoffs: { 'to-sam.md': block('write the notes', '**Class:** writing\n') }, allow: { sam: [SONNET, HAIKU] } });
  assert.equal(c.routing(['trial', 'create', 'wr-c', '--class', 'writing', '--arm', 'claude-cli/claude-sonnet-5-5', '--arm', 'claude-cli/haiku', '--scope-dept', 'eng', '--entry-share', '1', '--by', 'Hal']).code, 0);
  assert.equal(c.routing(['trial', 'start', 'wr-c', '--by', 'owner'], true).code, 0);
  assert.equal(c.routing(['mode', 'live', '--by', 'owner'], true).code, 0);
  const r = c.tick(); assert.equal(r.code, 0, r.out);
  const log = c.jsonl('company/work/models/routing-log.jsonl');
  const s = c.routing(['status', '--json']).out;
  const txt = c.routing(['status']).out;
  dump('1b.json', { log, trial: s.trials[0], statusLog: s.log, txt, dispatchLog: r.log.split('\n').filter(l => /ROUT/.test(l)) });
  assert.ok(log.some(x => x.trial === 'wr-c' && (x.event === 'paused' || x.op === 'trial-held')), 'the router recorded the pause: ' + JSON.stringify(log));
  assert.ok(s.trials[0].hold, 'routing.js status shows the trial held by the pacer: ' + JSON.stringify(s.trials[0]));
});

/* ---------- (4) code on custom: never started, any modes ---------- */
test('(4) a code item never starts on custom/MiniMax in any mode combination', async () => {
  const seats = { agent: SEATS.agent, dev: { name: 'Dev', loop: 'Dev loop', inbox: 'to-dev.md', manager: 'agent', provider: 'custom', model: 'MiniMax-M2' } };
  const DEP = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['dev'], defaultClass: 'code', routes: { code: { provider: 'custom', model: 'MiniMax-M3.1-Flash' } }, consult: {} }] };
  const DEF = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/routing-policy.json'), 'utf8'));
  const M2 = { provider: 'custom', model: 'MiniMax-M2' }, FL = { provider: 'custom', model: 'MiniMax-M3.1-Flash' };
  const trial = { id: 'mm', class: 'code', arms: [FL, SONNET], scope: { departments: ['eng'], seats: [] }, entryShare: 1, status: 'running', pauseWhenHeld: [] };
  const results = [];
  for (const mode of ['off', 'shadow', 'live']) for (const cm of ['off', 'shadow', 'live']) for (const cra of ['always', 'mode', 'off']) for (const allow of ['custom', 'none', 'sonnet']) {
    const P = Object.assign(JSON.parse(JSON.stringify(DEF)), { mode, classRulesApply: cra, trials: [trial] }); P.tierCaps.mode = cm;
    const al = allow === 'custom' ? { dev: [M2, FL] } : allow === 'sonnet' ? { dev: [M2, FL, SONNET] } : undefined;
    // the pure decision first (all 27*3), then a dispatcher tick on a sample
    const R = require(path.join(TOOLS, 'lib', 'routing.js'));
    const d = R.decide({ policy: P, seat: 'dev', items: [{ text: '## x\n**Class:** code\n**Status:** OPEN\n' }], wakeId: 'wk-' + mode + cm + cra + allow, departments: DEP, crew: seats, chain: [M2, SONNET], current: M2, held: [], allow: al ? al.dev : null });
    const runsOn = d.hold ? null : d.applied ? d.provider : M2.provider;
    results.push({ mode, cm, cra, allow, hold: !!d.hold, applied: d.applied, provider: d.provider, model: d.model, runsOn });
    assert.notEqual(runsOn, 'custom', JSON.stringify({ mode, cm, cra, allow, d }));
    // and with no chain beyond the denied pair (decide with chain [M2] only)
    const d2 = R.decide({ policy: P, seat: 'dev', items: [{ text: '## x\n**Class:** code\n**Status:** OPEN\n' }], wakeId: 'wk2', departments: DEP, crew: seats, chain: [M2], current: M2, held: [], allow: al ? al.dev : null });
    assert.ok(d2.hold || (d2.applied && d2.provider !== 'custom'), JSON.stringify({ mode, cm, cra, allow, d2 }));
  }
  dump('4-pure.json', results);
  // the dispatcher, every mode pair with classRulesApply off (the weakest setting) and a custom-only allowlist
  const ticks = [];
  for (const mode of ['off', 'shadow', 'live']) for (const cm of ['off', 'shadow', 'live']) {
    const P = Object.assign(JSON.parse(JSON.stringify(DEF)), { mode, classRulesApply: 'off', trials: [trial] }); P.tierCaps.mode = cm;
    const c = await company({ seats, departments: DEP, policy: P, handoffs: { 'to-dev.md': block('fix the lexer', '**Class:** code\n') }, allow: { dev: [M2, FL] } });
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    ticks.push({ mode, cm, dev: r.bySeat.dev || null, hold: /ROUTE HOLD/.test(r.log) });
    assert.ok(!r.bySeat.dev || (r.bySeat.dev.provider && r.bySeat.dev.provider !== 'custom'), 'dev started on custom: ' + JSON.stringify(r.bySeat.dev) + ' ' + mode + '/' + cm);
  }
  dump('4-ticks.json', ticks);
});

/* ---------- (5) no routing-policy.json, no departments.json: bodies byte-identical to main ---------- */
test('(5) no routing-policy.json and no departments.json: dispatch bodies byte-identical to main', { skip: !MAIN }, async () => {
  const seats = { agent: SEATS.agent, sam: SEATS.sam, mo: { name: 'Mo', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', provider: 'deepseek' },
    dev: { name: 'Dev', loop: 'Dev loop', inbox: 'to-dev.md', manager: 'agent', provider: 'custom', model: 'MiniMax-M2' } };
  const handoffs = { 'to-sam.md': block('write notes', '**Class:** writing\n'), 'to-mo.md': block('fix parser', '**Class:** code\n'), 'to-dev.md': block('fix lexer', '**Class:** code\n') };
  const res = {};
  for (const defaults of [false, true]) for (const [name, repo] of [['main', MAIN], ['cross', REPO]]) {
    const c = await company({ repo, seats, handoffs, defaults });
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    const bodies = {}; for (const [s, b] of Object.entries(r.bySeat)) bodies[s] = JSON.stringify(b).replace(/"id":"[^"]+"/, '"id":"X"');
    res[(defaults ? 'withDefaults-' : 'bare-') + name] = { bodies, hold: (r.log.match(/ROUTE HOLD[^\n]*/g) || []), routeOnWake: c.jsonl('company/state/wakes.jsonl').some(x => 'route' in x) };
  }
  dump('5-bodies.json', res);
  assert.deepEqual(res['bare-cross'].bodies, res['bare-main'].bodies, 'bare root');
  assert.deepEqual(res['withDefaults-cross'].bodies, res['withDefaults-main'].bodies, 'a real checkout (framework defaults present)');
});
