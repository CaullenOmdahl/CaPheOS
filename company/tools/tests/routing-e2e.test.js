#!/usr/bin/env node
/* routing-e2e.test.js — routing end to end across its three parts: the owner's switches (company/tools/routing.js), the
 * router (company/tools/lib/routing.js through the real dispatch.js, against tests/mock-station.js on a loopback port) and
 * the readers (routing.js status, model-rank.js evaluate), plus locked-watch.js over the routing log. docs/ROUTING.md.
 * It proves:
 *   (1) a trial routing.js writes and the owner starts is what the router reads: the dispatcher assigns its arm, and
 *       routing.js status counts it (the control arm included); the decision is a routing-decisions.jsonl row, never a
 *       routing-log row;
 *   (2) a pacer hold of a running trial is a routing-log row {op: trial-held, by, trial, providers, why}, and routing.js
 *       status shows the trial held with that reason; the log shown is changes and holds only;
 *   (3) a code item never starts on custom (the MiniMax plan) in any mode combination, decided or dispatched;
 *   (4) no routing policy: every body is {id, detach} as before; the framework default present: the same bodies, except a
 *       code item on a seat whose only chain is custom, which is held (the class rules always hold);
 *   (5) an owner mode change made by the real routing.js survives a locked-watch tick; a forged routing-log row is stripped;
 *   (6) the router's real decisions feed model-rank.js and routing.js status, and both count the same arms.
 * No model runs, no network beyond the loopback mock.
 *
 *   node --test company/tools/tests/routing-e2e.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const MIN = 60e3, TOKEN = 'routing-e2e-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();
const LOG = 'company/work/models/routing-log.jsonl', DECISIONS = 'company/work/models/routing-decisions.jsonl';
const CHANGE_OPS = ['mode', 'tiercaps', 'trial-create', 'trial-start', 'trial-pause', 'trial-resume', 'trial-stop', 'trial-held', 'trial-unheld'];

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(require('../lib/temp-life').tmpDir('routing-e2e-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = require('../lib/temp-life').track(spawn(process.execPath, [path.join(REPO, 'tests', 'mock-station.js'), '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] }));
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');
const block = (head, extra) => '\n## 2026-11-17 from Alex — ' + head + '\n**Need:** do it\n' + (extra || '') + '**Status:** OPEN\n';

/* a company. o.defaults (copy the framework company/defaults so the default routing policy is
 * there, as in a real checkout), o.seats, o.handoffs, o.departments, o.modelPolicy, o.policy, o.allow, o.patchDefault */
async function company(o) {
  o = o || {};
  const repo = REPO;
  const T = require('../lib/temp-life').tmpDir('routing-e2e-co-'); roots.push(T);
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
  // routing.js in-process in a child, as the owner (pinned owner shell) or as a seat (no locked-watch runs on these
  // companies; c.routingCli runs the real program, whose provenance rows locked-watch trusts)
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
test('(1) a trial created by routing.js and started by the owner is what the router reads: the dispatcher assigns its arm, status counts it', async () => {
  const seen = new Set();
  // a new wakeId per company: run until both arms have been seen (at most 8 companies; the assignment is a hash)
  for (let k = 0; k < 8 && seen.size < 2; k++) {
    const c = await company({ seats: SEATS, departments: DEPTS, modelPolicy: MODEL_POLICY, defaults: true,
      patchDefault: d => { d.trialLimits = Object.assign({}, d.trialLimits, { maxEntryShare: 1 }); },
      handoffs: { 'to-sam.md': block('write the notes ' + k, '**Class:** writing\n') },
      allow: { sam: [DSP, DSF] } });
    const cr = c.routing(['trial', 'create', 'wr-cmp', '--class', 'writing', '--arm', 'deepseek/deepseek-pro', '--arm', 'deepseek/deepseek-flash', '--scope-dept', 'eng', '--entry-share', '1', '--min-items', '2', '--pause-when-held', 'deepseek', '--by', 'Hal']);
    assert.equal(cr.code, 0, JSON.stringify(cr.out));
    assert.equal(c.routing(['trial', 'start', 'wr-cmp', '--by', 'owner'], true).code, 0);
    assert.equal(c.routing(['mode', 'live', '--by', 'owner'], true).code, 0);
    const R = require(path.join(TOOLS, 'lib', 'routing.js'));
    const L = R.loadPolicy(c.T); assert.equal(L.source, 'company/work/models/routing-policy.json');
    const K = R.knobs(L.policy);
    assert.equal(K.mode, 'live'); assert.equal(K.trials.length, 1); assert.equal(K.trials[0].status, 'running');
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    const w = c.wake('sam');
    assert.ok(w && w.route, 'sam woke with a route: ' + r.log.slice(-3000));
    const g = R.assign(K.trials[0], w.wakeId);
    assert.deepEqual([w.route.source, w.route.trial, w.route.arm, w.route.model], ['trial', 'wr-cmp', g.arm, K.trials[0].arms[g.arm].model], JSON.stringify(w.route));
    if (g.arm === 1) {   // deepseek-flash is sam's own pair: the control arm, no override
      assert.equal(w.route.applied, false); assert.deepEqual(Object.keys(r.bySeat.sam).sort(), ['detach', 'id']);
    } else {
      assert.equal(w.route.applied, true); assert.deepEqual(r.bySeat.sam, { id: c.ids.sam, detach: true, provider: 'deepseek', model: 'deepseek-pro' });
    }
    seen.add(g.arm);
    // routing.js status counts the wake on its arm (the control arm too), never as shadow
    const s = c.routing(['status', '--json']).out;
    assert.deepEqual(s.trials[0].arms.map(a => [a.wakes, a.items, a.shadowWakes]), [0, 1].map(i => i === g.arm ? [1, 1, 0] : [0, 0, 0]), JSON.stringify(s.trials[0].arms));
    // the log split: the changes (and only they) in the routing log; the decisions in routing-decisions.jsonl
    assert.deepEqual(c.jsonl(LOG).map(x => x.op), ['trial-create', 'trial-start', 'mode']);
    assert.ok(c.jsonl(LOG).every(x => Number.isFinite(x.at) && x.by && CHANGE_OPS.includes(x.op)));
    assert.deepEqual(s.log.map(x => x.op), ['mode', 'trial-start', 'trial-create'], 'status shows the changes, newest first');
    const dec = c.jsonl(DECISIONS);
    assert.ok(dec.some(x => x.seat === 'sam' && x.wakeId === w.wakeId && x.route && x.route.trial === 'wr-cmp' && !('op' in x)), JSON.stringify(dec));
  }
  assert.equal(seen.size, 2, 'both arms were assigned across the companies');
});

/* ---------- (2) a pacer hold the router records: routing.js status shows it ---------- */
test('(2) the pacer holds claude-cli: the trial is held (a trial-held routing-log row) and routing.js status names the hold and its reason', async () => {
  const seats = Object.assign({}, SEATS, { sam: { name: 'Sam', loop: 'Sam loop', inbox: 'to-sam.md', manager: 'agent', provider: 'claude-cli', model: 'haiku' } });
  const c = await company({ seats, departments: DEPTS, modelPolicy: MODEL_POLICY, defaults: true,
    patchDefault: d => { d.trialLimits = Object.assign({}, d.trialLimits, { maxEntryShare: 1 }); },
    handoffs: { 'to-sam.md': block('write the notes', '**Class:** writing\n') }, allow: { sam: [SONNET, HAIKU] } });
  assert.equal(c.routing(['trial', 'create', 'wr-c', '--class', 'writing', '--arm', 'claude-cli/claude-sonnet-5-5', '--arm', 'claude-cli/haiku', '--scope-dept', 'eng', '--entry-share', '1', '--by', 'Hal']).code, 0);
  assert.equal(c.routing(['trial', 'start', 'wr-c', '--by', 'owner'], true).code, 0);
  assert.equal(c.routing(['mode', 'live', '--by', 'owner'], true).code, 0);
  const r = c.tick(); assert.equal(r.code, 0, r.out);   // the mock station's usage holds Claude
  const log = c.jsonl(LOG);
  const held = log.filter(x => x.op === 'trial-held');
  assert.equal(held.length, 1, JSON.stringify(log));
  assert.deepEqual([held[0].by, held[0].trial, held[0].providers, held[0].why], ['dispatcher', 'wr-c', ['claude-cli'], 'claude-cli held by the pacer']);
  assert.ok(log.every(x => CHANGE_OPS.includes(x.op)), 'only changes and events in the routing log: ' + JSON.stringify(log));
  const s = c.routing(['status', '--json']).out;
  assert.ok(s.trials[0].hold && s.trials[0].hold.why === 'claude-cli held by the pacer', JSON.stringify(s.trials[0]));
  assert.ok(s.trials[0].reasons.some(x => /^held: claude-cli held by the pacer/.test(x)), JSON.stringify(s.trials[0].reasons));
  assert.ok(s.log.length && s.log.every(x => CHANGE_OPS.includes(x.op)) && s.log[0].op === 'trial-held', JSON.stringify(s.log));
  assert.match(c.routing(['status']).out, /held: claude-cli held by the pacer/);
  const w = c.wake('sam');
  assert.ok(w && w.route && !w.route.trial && w.route.reasons.some(x => /trial wr-c paused: claude-cli held by the pacer/.test(x)), JSON.stringify(w && w.route));
  assert.ok(c.jsonl(DECISIONS).some(x => x.wakeId === w.wakeId), 'the decision is in the decisions log');
});

/* ---------- (3) code on custom: never started, any modes ---------- */
test('(3) a code item never starts on custom (the MiniMax plan) in any mode combination', async () => {
  const seats = { agent: SEATS.agent, dev: { name: 'Dev', loop: 'Dev loop', inbox: 'to-dev.md', manager: 'agent', provider: 'custom', model: 'MiniMax-M2' } };
  const DEP = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: null, members: ['dev'], defaultClass: 'code', routes: { code: { provider: 'custom', model: 'MiniMax-M3.1-Flash' } }, consult: {} }] };
  const DEF = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/models/routing-policy.json'), 'utf8'));
  const M2 = { provider: 'custom', model: 'MiniMax-M2' }, FL = { provider: 'custom', model: 'MiniMax-M3.1-Flash' };
  const trial = { id: 'mm', class: 'code', arms: [FL, SONNET], scope: { departments: ['eng'], seats: [] }, entryShare: 1, status: 'running', pauseWhenHeld: [] };
  const R = require(path.join(TOOLS, 'lib', 'routing.js'));
  const code = [{ text: '## x\n**Class:** code\n**Status:** OPEN\n' }];
  for (const mode of ['off', 'shadow', 'live']) for (const cm of ['off', 'shadow', 'live']) for (const cra of ['always', 'mode', 'off']) for (const allow of ['custom', 'none', 'sonnet']) {
    const P = Object.assign(JSON.parse(JSON.stringify(DEF)), { mode, classRulesApply: cra, trials: [trial] }); P.tierCaps.mode = cm;
    const al = allow === 'custom' ? [M2, FL] : allow === 'sonnet' ? [M2, FL, SONNET] : null;
    const d = R.decide({ policy: P, seat: 'dev', items: code, wakeId: 'wk-' + mode + cm + cra + allow, departments: DEP, crew: seats, chain: [M2, SONNET], current: M2, held: [], allow: al });
    const runsOn = d.hold ? null : d.applied ? d.provider : M2.provider;
    assert.notEqual(runsOn, 'custom', JSON.stringify({ mode, cm, cra, allow, d }));
    // and with no chain beyond the denied pair
    const d2 = R.decide({ policy: P, seat: 'dev', items: code, wakeId: 'wk2', departments: DEP, crew: seats, chain: [M2], current: M2, held: [], allow: al });
    assert.ok(d2.hold || (d2.applied && d2.provider !== 'custom'), JSON.stringify({ mode, cm, cra, allow, d2 }));
  }
  // the dispatcher, every mode pair with classRulesApply off (the weakest setting) and a custom-only allowlist
  for (const mode of ['off', 'shadow', 'live']) for (const cm of ['off', 'shadow', 'live']) {
    const P = Object.assign(JSON.parse(JSON.stringify(DEF)), { mode, classRulesApply: 'off', trials: [trial] }); P.tierCaps.mode = cm;
    const c = await company({ seats, departments: DEP, policy: P, handoffs: { 'to-dev.md': block('fix the lexer', '**Class:** code\n') }, allow: { dev: [M2, FL] } });
    const r = c.tick();
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.bySeat.dev, 'dev started (' + mode + '/' + cm + '): ' + JSON.stringify(r.bySeat.dev));
    assert.match(r.log, /ROUTE HOLD Dev loop \S+ for dev: class rules deny custom\/MiniMax-M2/);
  }
});

/* ---------- (4) no policy: bodies as before; the default policy: the same, except a code item held off custom ---------- */
test('(4) no routing policy: every body is {id, detach}; with the framework default the same, except a code item on custom is held', async () => {
  const seats = { agent: SEATS.agent, sam: SEATS.sam, mo: { name: 'Mo', loop: 'Mo loop', inbox: 'to-mo.md', manager: 'agent', provider: 'deepseek' },
    dev: { name: 'Dev', loop: 'Dev loop', inbox: 'to-dev.md', manager: 'agent', provider: 'custom', model: 'MiniMax-M2' } };
  const handoffs = { 'to-sam.md': block('write notes', '**Class:** writing\n'), 'to-mo.md': block('fix parser', '**Class:** code\n'), 'to-dev.md': block('fix lexer', '**Class:** code\n') };
  const bodiesOf = r => { const b = {}; for (const [s, x] of Object.entries(r.bySeat)) b[s] = JSON.stringify(x).replace(/"id":"[^"]+"/, '"id":"X"'); return b; };
  const plain = '{"id":"X","detach":true}';
  // no company/defaults at all: no routing (this is also what the code before the router sent; checked byte for byte)
  const bare = await company({ seats, handoffs });
  const rb = bare.tick(); assert.equal(rb.code, 0, rb.out);
  assert.deepEqual(bodiesOf(rb), { sam: plain, mo: plain, dev: plain });
  assert.ok(!bare.jsonl('company/state/wakes.jsonl').some(x => 'route' in x));
  assert.ok(!fs.existsSync(path.join(bare.T, LOG)) && !fs.existsSync(path.join(bare.T, DECISIONS)));
  assert.doesNotMatch(rb.log, /ROUTE|ROUTING/);
  // a real checkout (the framework default present: shadow): no override for anyone; dev's code item on custom is held
  const real = await company({ seats, handoffs, defaults: true });
  const rr = real.tick(); assert.equal(rr.code, 0, rr.out);
  const b = bodiesOf(rr);
  assert.ok(!('dev' in b), 'a code item is never started on custom: ' + JSON.stringify(b));
  for (const s of ['agent', 'sam', 'mo']) if (b[s] !== undefined) assert.equal(b[s], plain, s);
  assert.deepEqual(Object.keys(b).filter(s => s !== 'agent').sort(), ['mo', 'sam']);
  assert.match(rr.log, /ROUTE HOLD Dev loop \S+ for dev: class rules deny custom\/MiniMax-M2 \(code never runs on provider custom\)/);
  assert.ok(real.jsonl(DECISIONS).some(x => x.seat === 'dev' && x.status === 'held' && x.route.hold === true && !x.runId));
  assert.deepEqual(real.jsonl(LOG), [], 'no change and no hold: the routing log is empty');
});

/* ---------- (5) locked-watch over the routing log: the real routing.js's owner change survives; a forged row does not ---------- */
test('(5) locked-watch: an owner mode change made by routing.js survives a tick; a forged routing-log row is stripped', () => {
  const T = require('../lib/temp-life').tmpDir('routing-e2e-lw-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  fs.cpSync(path.join(REPO, 'company', 'defaults'), path.join(T, 'company', 'defaults'), { recursive: true });
  w('company/company.json', { name: 'LW Co', slug: 'lw', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo', 'tools', 'risk'], inbox: 'to-boss.md', manager: null }, hal: { name: 'Hal', functions: ['people'], inbox: 'to-hal.md', manager: 'boss' } } });
  w('company/work/decisions.md', '# Decisions\n\n');
  w('.capheos-selftest-fixture', '');
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), PROVENANCE_ROOT: T, CAPHEOS_READONLY: '' });
  delete env.STARNET_AGENT_ID;
  const run = (tool, ...a) => spawnSync(process.execPath, [path.join(TOOLS, tool), ...a], { cwd: T, env, encoding: 'utf8', timeout: 120000 });
  let r = run('locked-watch.js', 'baseline', '--force'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('locked-watch.js', 'tick'); assert.equal(r.status, 0, r.stdout + r.stderr);
  // the owner's own shell (not under the station): the real program, so its provenance rows are trusted
  r = run('routing.js', 'mode', 'live', '--by', 'owner', '--why', 'reviewed the shadow rows'); assert.equal(r.status, 0, r.stdout + r.stderr);
  r = run('routing.js', 'tiercaps', 'live', '--by', 'owner'); assert.equal(r.status, 0, r.stdout + r.stderr);
  // and the router's hold row (lib/routing.js record, as the dispatcher writes it)
  const RL = require(path.join(TOOLS, 'lib', 'routing.js'));
  process.env.PROVENANCE_ROOT = T;
  try { RL.record({ root: T, K: RL.knobs({}), dry: false }, { op: 'trial-held', by: 'dispatcher', trial: 't1', providers: ['claude-cli'], why: 'claude-cli held by the pacer' }); }
  finally { delete process.env.PROVENANCE_ROOT; }
  const before = fs.readFileSync(path.join(T, LOG), 'utf8');
  assert.deepEqual(before.trim().split('\n').map(l => JSON.parse(l).op), ['mode', 'tiercaps', 'trial-held']);
  r = run('locked-watch.js', 'tick'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /routing-(log|policy)/, 'nothing flagged or stripped');
  assert.equal(fs.readFileSync(path.join(T, LOG), 'utf8'), before, 'the routing log is kept as written');
  const pol = JSON.parse(fs.readFileSync(path.join(T, 'company/work/models/routing-policy.json'), 'utf8'));
  assert.deepEqual([pol.mode, pol.tierCaps.mode], ['live', 'live']);
  const st = JSON.parse(run('routing.js', 'status', '--json').stdout);
  assert.deepEqual(st.log.map(x => x.op), ['trial-held', 'tiercaps', 'mode']);
  // a forged owner row nobody recorded: stripped, the real rows kept
  fs.appendFileSync(path.join(T, LOG), JSON.stringify({ at: Date.now(), op: 'mode', by: 'owner', from: 'live', to: 'off' }) + '\n');
  const old = (Date.now() - 120000) / 1000; fs.utimesSync(path.join(T, LOG), old, old);
  r = run('locked-watch.js', 'tick'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /stripped company\/work\/models\/routing-log\.jsonl/);
  assert.equal(fs.readFileSync(path.join(T, LOG), 'utf8'), before);
});

/* ---------- (6) the router's real decisions feed model-rank.js and routing.js status ---------- */
test('(6) the router\'s decisions on the policy routing.js wrote: model-rank.js and routing.js status count the same arms; tier caps are read', () => {
  const T = require('../lib/temp-life').tmpDir('routing-e2e-rank-'); roots.push(T);
  fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1) + '\n'); };
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_READONLY: '' });
  const CREW = { lee: { name: 'Lee', functions: ['ceo'], inbox: 'to-lee.md', manager: null }, hal: { name: 'Hal', functions: ['people'], inbox: 'to-hal.md', manager: 'lee' },
    sam: { name: 'Sam', inbox: 'to-sam.md', manager: 'lee' }, kim: { name: 'Kim', inbox: 'to-kim.md', manager: 'lee' } };
  const DEPS = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: 'lee', members: ['sam', 'kim'], defaultClass: 'code', routes: {}, consult: {} }] };
  w('company/company.json', { name: 'Rank Co', slug: 'rank', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  w('company/departments.json', DEPS);
  w('company/model-policy.json', { allowed: { 'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] }, deepseek: { models: ['deepseek-flash'] } } });
  w('company/work/decisions.md', '# Decisions\n\n');
  for (const rel of ['company/defaults/work/models/routing-policy.json', 'company/defaults/work/models/ranking-policy.json']) w(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
  const rt = argv => { const p = spawnSync(process.execPath, [path.join(TOOLS, 'routing.js'), ...argv], { cwd: T, env, encoding: 'utf8' }); assert.equal(p.status, 0, argv.join(' ') + ': ' + p.stdout + p.stderr); return p.stdout; };
  rt(['trial', 'create', 'code-cmp', '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5@high', '--arm', 'claude-cli/claude-opus-5-5@medium', '--scope-seat', 'sam', '--entry-share', '0.5', '--min-items', '10', '--by', 'Hal']);
  rt(['trial', 'start', 'code-cmp', '--by', 'owner']);
  rt(['mode', 'live', '--by', 'owner']);
  const R = require(path.join(TOOLS, 'lib', 'routing.js'));
  const policy = R.loadPolicy(T).policy;
  const SON = { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }, OPUS = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, FAB = { provider: 'claude-cli', model: 'claude-fable-5-2', effort: 'medium' };
  const strip = p => ({ provider: p.provider, model: p.model });
  const NOW = Date.UTC(2030, 1, 1), H = 3600e3;
  const wakes = [], runsRows = [], inbox = { 'to-sam.md': ['# Sam\n'], 'to-kim.md': ['# Kim\n'] };
  let seq = 0;
  const item = (seat, id, d, wakeId, route, ran, fail) => {
    const file = 'to-' + seat + '.md', at = Date.UTC(2030, 0, d) + 10 * H + (seq % 50) * 60e3;
    const runId = 'run-' + id + '-' + String(++seq).padStart(4, '0');
    runsRows.push({ runId, parentRunId: '', agentId: seat, provider: ran.provider, model: ran.model, servedModel: ran.model, reasoningEffort: ran.effort, reason: 'done', turns: 8, tokens: 400000, cachedTokens: 200000, usd: 0, unmetered: true, startedAt: at + 60e3, endedAt: at + 31 * 60e3, ts: at + 31 * 60e3 });
    wakes.push({ at, ts: new Date(at).toISOString(), wakeId, seat, runId, admitId: 'adm-' + seq, jobId: 'job-' + seat, door: 'dispatch', items: [{ file, id, title: 'task ' + id, due: null }], why: '1 OPEN in ' + file, route });
    inbox[file].push(['## ' + new Date(at - H).toISOString().slice(0, 16).replace('T', ' ') + ' from Lee — task ' + id, '**Id:** ' + id, '**Need:** task ' + id, '**Class:** code', ...(fail ? ['**Verdict:** REVISE by Lee — check: fails — one finding'] : []), '**Status:** DONE', '**Resolved ' + new Date(at + 4 * H).toISOString().slice(0, 16).replace('T', ' ') + ' by ' + CREW[seat].name + '**'].join('\n') + '\n');
  };
  const txt = [{ text: '## x\n**Class:** code\n**Status:** OPEN\n' }];
  // the live trial: sam's chain is Opus@medium (arm 1 = the control arm), both arms open
  const live = [0, 0];
  for (let k = 0; k < 120; k++) {
    const wakeId = 'wk-live-' + k;
    const d = R.decide({ policy, seat: 'sam', items: txt, wakeId, departments: DEPS, crew: CREW, chain: [OPUS, SON], current: OPUS, held: [], allow: [strip(SON), strip(OPUS)] });
    if (d.trial !== 'code-cmp') continue;
    assert.equal(d.applied, d.arm === 0, 'arm 0 is applied as the override, arm 1 is the chain\'s own pair: ' + JSON.stringify(d));
    live[d.arm]++;
    item('sam', 'L' + k, 2 + (k % 20), wakeId, d, d, k % 7 === 0);
  }
  assert.ok(live[0] > 0 && live[1] > 0, JSON.stringify(live));
  // tier caps on kim (not exempt, not a lead): chain Fable, Sonnet. live + Sonnet open = applied; shadow = the baseline
  let capApplied = 0, capBaseline = 0;
  for (const mode of ['live', 'shadow']) {
    const P = JSON.parse(JSON.stringify(policy)); P.tierCaps.mode = mode; P.mode = 'off';
    for (let k = 0; k < 25; k++) {
      const wakeId = 'wk-cap-' + mode + k;
      const d = R.decide({ policy: P, seat: 'kim', items: txt, wakeId, departments: DEPS, crew: CREW, chain: [FAB, SON], current: FAB, held: [], allow: [strip(SON), strip(FAB)] });
      if (d.source === 'tierCap' && d.applied) capApplied++; else if (d.wouldApply && d.wouldApply.source === 'tierCap') capBaseline++;
      item('kim', (mode === 'live' ? 'C' : 'B') + k, 2 + (k % 20), wakeId, d, d.applied ? d : FAB, k % 10 === 0);
    }
  }
  assert.deepEqual([capApplied, capBaseline], [25, 25]);
  wakes.sort((a, b) => a.at - b.at || (a.wakeId < b.wakeId ? -1 : 1)); runsRows.sort((a, b) => a.ts - b.ts);
  for (const [f, parts] of Object.entries(inbox)) w('company/work/handoffs/' + f, parts.join('\n'));
  w('company/state/wakes.jsonl', wakes.map(x => JSON.stringify(x)).join('\n') + '\n');
  w('.starnet-data/workspaces/runs.jsonl', runsRows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const M = require(path.join(TOOLS, 'model-rank.js'));
  const ev = M.evaluate(M.load({ root: T, now: NOW }));
  const t = ev.trials.find(x => x.id === 'code-cmp');
  assert.ok(t, JSON.stringify(ev.trials));
  assert.deepEqual(t.arms.map(a => a.items), live, 'model-rank counts every wake on its arm, the control arm included');
  assert.ok(t.arms.every(a => a.mismatches && a.mismatches.requested === 0 && a.mismatches.served === 0), JSON.stringify(t.arms));
  const cap = (ev.tierCaps.classes || []).find(c => c.class === 'code');
  assert.ok(cap && cap.capped.items === 25 && cap.baseline.items === 25, JSON.stringify(ev.tierCaps).slice(0, 800));
  // routing.js status reads the same wakes (counted from the trial's start: the wakes are in 2030)
  const st = JSON.parse(rt(['status', '--json']));
  assert.deepEqual(st.trials[0].arms.map(a => [a.wakes, a.items, a.shadowWakes]), live.map(n => [n, n, 0]), 'routing.js status agrees with model-rank');
});
