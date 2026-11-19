#!/usr/bin/env node
/* duties.test.js — DUTIES (docs/DUTIES.md): the --duty contract, the runner, and the dispatcher's use of it.
 *
 * Part 1 (no station): the exit-code contract (ok / due / broken, timeouts, the 16 KB cap, bad JSON), reason
 * sanitizing, the allowlist environment, every registered duty run against a fixture tree with no file changed, and no
 * registered duty loading a network module. Part 2 (tests/mock-station.js): one real dispatch.js tick per case — a due
 * duty wakes its seat with the reason, a covered one wakes nobody, broken is flagged once (and again when it changes),
 * a duty that never completes is stale and flagged once, the per-tick cap makes duties wait, only whileHalted duties run
 * while halted, the duty sees no secret, and an unrecorded policy edit is not obeyed.
 *
 *   node --test company/tools/tests/duties.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const DISPATCH = path.join(TOOLS, 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const MIN = 60e3;
const TOKEN = 'duties-test-token';
const roots = [];
const tmp = p => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(d); return d; };
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
// run a snippet in a child with CAPHEOS_ROOT set (lib/company.js reads it once, at require time)
function inRoot(root, code, env) {
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC' }, env || {}) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
function treeHash(root) {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(f, r); else if (e.isFile()) { const st = fs.statSync(f); out[r] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + st.mtimeMs; } } };
  walk(root, ''); return out;
}

/* ---------------- Part 1 ---------------- */
test('the --duty contract: exit 0 ok, exit 1 + JSON due, anything else broken; timeout and 16 KB are broken', async () => {
  const R = require(path.join(TOOLS, 'lib', 'duty-runner.js'));
  const D = tmp('duty-contract-');
  const tool = (name, body) => w(D, name + '.js', "if (!process.argv.includes('--duty') || process.argv.length !== 3) process.exit(9);\n" + body);
  const run = (name, o) => R.runOne(Object.assign({ file: path.join(D, name + '.js'), timeoutMs: 5000 }, o || {}), { env: { PATH: process.env.PATH }, cwd: D, remainingMs: 20000 });
  tool('ok', 'process.exit(0)');
  tool('due', "console.log(JSON.stringify({ due: true, reason: '3 late\\u0007 `items`\\n<b>' + 'x'.repeat(400), key: 'k 1/a', route: 'risk', items: [{ id: 'a b', route: 'kim' }, 'c-2'] })); process.exit(1)");
  tool('garbage', "console.log('not json'); process.exit(1)");
  tool('nokey', "console.log(JSON.stringify({ due: true, reason: 'x' })); process.exit(1)");
  tool('three', 'process.exit(3)');
  tool('slow', 'setTimeout(() => process.exit(0), 3000)');
  tool('big', "process.stdout.write('x'.repeat(20000)); process.exit(1)");
  assert.equal((await run('ok')).result, 'ok');
  const due = await run('due');
  assert.equal(due.result, 'due');
  assert.ok(due.reason.length <= 300 && !/[\u0000-\u001f`<>]/.test(due.reason) && due.reason.startsWith('3 late items b'), due.reason);
  assert.equal(due.route, 'risk'); assert.equal(due.key, 'k1/a');
  assert.deepEqual(due.items, [{ id: 'ab', route: 'kim' }, { id: 'c-2' }]);
  assert.match((await run('garbage')).error, /JSON/);
  assert.match((await run('nokey')).error, /key/);
  assert.deepEqual([(await run('three')).result, (await run('three')).error], ['broken', 'exit 3']);
  const slow = await run('slow', { timeoutMs: 500 });
  assert.equal(slow.result, 'broken'); assert.match(slow.error, /no answer within 500 ms/);
  assert.equal((await R.runOne({ file: path.join(D, 'slow.js'), timeoutMs: 5000 }, { env: {}, cwd: D, remainingMs: 600 })).result, 'waited', 'cut by the per-tick cap: waits, not broken');
  const big = await run('big');
  assert.equal(big.result, 'broken'); assert.match(big.error, /16 KB/);
});

test('reasons are sanitized: no control or bidi characters, no markup, capped', () => {
  const { sanitize } = require(path.join(TOOLS, 'lib', 'duty-runner.js'));
  assert.equal(sanitize('a\u0000b\u202ec\r\n`d` **e** <script>'), 'a b c d e script');
  assert.equal(sanitize('x'.repeat(500)).length, 300);
  assert.equal(sanitize('y'.repeat(50), 10), 'yyyyyyyyyy');
});

test('the duty environment is an allowlist: no secrets, no NODE_OPTIONS, the read-only and no-network flags set', () => {
  const { dutyEnv } = require(path.join(TOOLS, 'lib', 'duty-env.js'));
  const base = { PATH: '/bin', HOME: '/home/x', TZ: 'UTC', STARNET_STATION_TOKEN: 's1', ANTHROPIC_API_KEY: 's2', GITHUB_TOKEN: 's3', NODE_OPTIONS: '--require /evil.js', MY_PASSWORD: 's4', AWS_SECRET_ACCESS_KEY: 's5', CAPHEOS_ROOT: '/elsewhere' };
  const { env, source } = dutyEnv({ root: '/co', base, sanitize: null });
  assert.equal(source, 'local');
  assert.deepEqual(Object.keys(env).sort(), ['CAPHEOS_NO_NETWORK', 'CAPHEOS_READONLY', 'CAPHEOS_ROOT', 'HOME', 'PATH', 'TZ']);
  assert.equal(env.CAPHEOS_ROOT, '/co'); assert.equal(env.CAPHEOS_READONLY, '1'); assert.equal(env.CAPHEOS_NO_NETWORK, '1');
  // with StarNet's sanitizer present it can only remove names, never add them back
  const s = dutyEnv({ root: '/co', base, sanitize: e => { const o = Object.assign({}, e, { STARNET_PIN: '1' }); delete o.TZ; return o; } });
  assert.equal(s.source, 'starnet'); assert.ok(!('TZ' in s.env) && !('STARNET_PIN' in s.env) && s.env.CAPHEOS_READONLY === '1');
});

// a fixture company where every registered duty has something to find
function fixtureCompany() {
  const T = tmp('duty-fixture-');
  for (const id of ['commitments', 'liveness']) fs.cpSync(path.join(REPO, 'modules', id), path.join(T, 'modules', id), { recursive: true });
  fs.mkdirSync(path.join(T, 'company', 'tools'), { recursive: true }); fs.symlinkSync(path.join(TOOLS, 'lib'), path.join(T, 'company', 'tools', 'lib'));   // as in a company: modules find company/tools/lib
  w(T, 'company/company.json', { name: 'Fixture', slug: 'fixture', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
  w(T, 'company/tools/loops.json', { agents: { a: { name: 'Alex', functions: ['ceo'], manager: null, loop: 'A loop', inbox: 'to-alex.md' }, k: { name: 'Kim', functions: ['tools', 'risk'], manager: 'a', loop: 'K loop', inbox: 'to-kim.md' } } });
  w(T, 'company/state/modules.json', { enabled: { commitments: { at: 'x' }, liveness: { at: 'x' } } });
  w(T, 'company/work/handoffs/to-kim.md', '# Kim\n\n## late one\n**Need:** x\n**Status:** OPEN\n**Deadline:** 2020-01-01 12:00\n\n## no status\n**Need:** y\n');
  w(T, 'company/work/handoffs/to-alex.md', '# Alex\n');
  w(T, 'company/work/commitments/c-202001010000-abcdef.json', { id: 'c-202001010000-abcdef', title: 'secret title', key: 'k', owner: 'k', state: 'acknowledged', createdAt: '2020-01-01T00:00:00Z', dueAt: '2020-01-02T00:00:00Z' });
  w(T, 'company/state/heartbeat.json', { at: new Date().toISOString() });
  w(T, '.starnet-data/workspaces/connectors/state.json', { version: 2, configs: [{ id: 'github', headers: { 'X-MCP-Readonly': 'false' } }] });
  w(T, 'company/work/ops/duty-policy.json', { duties: {} });
  return T;
}

test('every registered duty runs against a fixture tree and changes no file', () => {
  const T = fixtureCompany();
  const before = treeHash(T);
  const res = inRoot(T, `
    const R = require(${JSON.stringify(path.join(TOOLS, 'lib', 'duty-runner.js'))});
    const { dutyEnv } = require(${JSON.stringify(path.join(TOOLS, 'lib', 'duty-env.js'))});
    (async () => { const out = {}; const env = dutyEnv({ root: process.env.CAPHEOS_ROOT, base: Object.assign({}, process.env, { CAPHEOS_BACKUP_DIR: process.env.CAPHEOS_ROOT + '/no-backups' }) }).env;
      for (const d of R.registry()) { const r = await R.runOne(d, { env, cwd: process.env.CAPHEOS_ROOT, remainingMs: 60000 }); out[d.id] = { result: r.result, error: r.error || null, items: (r.items || []).map(i => i.id), reason: r.reason || null }; }
      console.log(JSON.stringify(out)); })();`);
  assert.deepEqual(Object.keys(res).sort(), ['backup-freshness', 'budget-drift', 'commitments-due', 'connector-scope', 'consults', 'departments', 'deps-verify', 'handoff-status', 'house-ranking', 'liveness-watcher', 'module-doctor', 'profiles', 'provider-balance', 'security-watch', 'tool-parse', 'unregistered-services']);
  for (const [id, r] of Object.entries(res)) assert.notEqual(r.result, 'broken', id + ': ' + r.error);
  for (const id of ['handoff-status', 'commitments-due', 'liveness-watcher', 'connector-scope', 'backup-freshness']) assert.equal(res[id].result, 'due', id + ' should find its fixture: ' + JSON.stringify(res[id]));
  assert.deepEqual(res['commitments-due'].items, ['c-202001010000-abcdef']);
  assert.ok(!JSON.stringify(res).includes('secret title') && !JSON.stringify(res).includes('late one'), 'reasons carry ids and counts, never content');
  assert.deepEqual(treeHash(T), before, 'a duty changed a file');
});

test('no registered duty loads a network module or calls fetch', () => {
  const T = fixtureCompany();
  const guard = w(tmp('duty-guard-'), 'guard.js', `
    const M = require('module'); const orig = M._load;
    M._load = function (req) { if (/^(node:)?(http|https|http2|net|tls|dgram|undici)$/.test(req)) process.stderr.write('NETWORK:' + req + '\\n'); return orig.apply(this, arguments); };
    globalThis.fetch = () => { process.stderr.write('NETWORK:fetch\\n'); return Promise.reject(new Error('no network in a duty')); };`);
  const reg = inRoot(T, `console.log(JSON.stringify(require(${JSON.stringify(path.join(TOOLS, 'lib', 'duty-runner.js'))}).registry().map(d => [d.id, d.file])))`);
  assert.ok(reg.length >= 7);
  for (const [id, file] of reg) {
    const src = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n'), /^const .*require\((['"])(node:)?(http|https|net|tls)\1\)/m, id + ' requires a network module at load');
    const r = spawnSync(process.execPath, ['-r', guard, file, '--duty'], { cwd: T, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: T, CAPHEOS_ROOT: T, CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1', TZ: 'UTC' } });
    assert.ok(r.status === 0 || r.status === 1, id + ' exit ' + r.status + ' ' + r.stderr);
    assert.doesNotMatch(r.stderr, /NETWORK:/, id + ' reached for the network');
  }
});

/* ---------------- Part 2: the dispatcher ---------------- */
let mock = null, port = 0;
async function startMock() {
  if (mock) return;
  const log = path.join(tmp('duties-mock-'), 'req.jsonl');
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  assert.notEqual(port, 8800);
  mock.logFile = log;
  mock.on('exit', (code, sig) => { if (!mock.stopping) console.error('# mock station exited: ' + code + ' ' + sig); });
}
test.after(() => { try { if (mock) { mock.stopping = true; mock.kill(); } } catch (_) {} });
async function st(method, p, body) {
  // one retry: a kept-alive socket the mock closed while a long tick ran ("other side closed") is not a failure
  for (let i = 0; ; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return await r.json();
    } catch (e) { if (i >= 2) throw new Error('mock: ' + ((e.cause && e.cause.message) || e.message)); }
  }
}
const runs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.path === '/api/cron/run' && r.method === 'POST');

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: false, wakeOnOwnerMessage: true, priority: 100, manager: null },
  kim: { name: 'Kim', loop: 'Kim loop', inbox: 'to-kim.md', wakeOnInbox: false, manager: 'agent' },
  riley: { name: 'Riley', functions: ['risk'], loop: 'Riley loop', inbox: 'to-riley.md', wakeOnInbox: false, manager: 'agent' },
};
// the fake module's duty tools: each reads its mode from <root>/fake-mode.json
const FAKE = id => `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
if (!process.argv.includes('--duty')) process.exit(9);
const m = (JSON.parse(fs.readFileSync(path.join(process.env.CAPHEOS_ROOT, 'fake-mode.json'), 'utf8')) || {})[${JSON.stringify(id)}] || { exit: 0 };
if (m.dumpEnv) fs.writeFileSync(path.join(process.env.CAPHEOS_ROOT, m.dumpEnv), JSON.stringify(process.env));
if (m.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, m.sleepMs);
if (m.out) console.log(JSON.stringify(m.out));
process.exit(m.exit || 0);
`;
async function company(o) {
  await startMock();
  o = o || {};
  const T = tmp('duties-co-');
  w(T, 'company/company.json', { name: 'Duties Test ' + path.basename(T), slug: path.basename(T), owner: { name: 'Pat' }, timezone: 'UTC', station: { port, serviceName: 'duties-test' } });
  w(T, 'secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w(T, 'company/work/ops/cadence.json', cad);
  w(T, 'company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w(T, 'company/state/governance.json', { categories: {} });
  if (o.halt) w(T, 'company/state/halt.json', o.halt);
  w(T, 'company/owner/inbound.jsonl', '');
  w(T, '.starnet-data/workspaces/runs.jsonl', '');
  // the fake module: its duties are code (module.json), like any module's
  const duties = (o.duties || ['fake-due']).map(id => Object.assign({ id, tool: 'tools/' + id + '.js', route: 'kim', everyMin: 5, timeoutMs: 10000, whileHalted: false, enabledByDefault: true }, (o.dutyCfg || {})[id] || {}));
  w(T, 'modules/dutytest/module.json', { version: 1, id: 'dutytest', title: 'duty test', duties });
  for (const d of duties) w(T, 'modules/dutytest/' + d.tool, FAKE(d.id));
  w(T, 'company/state/modules.json', { enabled: { dutytest: { at: 'x' } } });
  w(T, 'fake-mode.json', o.modes || {});
  // the company duties are switched off here (they have their own tests above), except where a case wants one
  w(T, 'company/work/ops/duty-policy.json', Object.assign({ tickCapMs: 20000, duties: Object.fromEntries(['handoff-status', 'tool-parse', 'connector-scope', 'backup-freshness', 'module-doctor', 'unregistered-services', 'budget-drift', 'deps-verify', 'provider-balance', 'departments', 'house-ranking', 'consults', 'profiles', 'security-watch'].map(id => [id, { enabled: false }])) }, o.policy || {}));
  for (const [inbox, text] of Object.entries(Object.assign({ 'to-founder.md': '', 'to-kim.md': '', 'to-riley.md': '' }, o.handoffs || {}))) w(T, 'company/work/handoffs/' + inbox, '# Handoffs\n' + text);
  const agents = JSON.parse(JSON.stringify(SEATS)); const ids = {};
  for (const [id, s] of Object.entries(agents)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + ' and /api/quests, then work.', provider: 'claude-cli', model: 'haiku', schedule: 'every 2h' });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { agentId: id, lastRunAt: new Date(Date.now() - 60 * MIN).toISOString(), name } });
    s.loop = name;
  }
  w(T, 'company/tools/loops.json', { agents });
  const c = { T, ids, w: (rel, d) => w(T, rel, d), r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
  c.json = rel => JSON.parse(c.r(rel) || 'null');
  c.tick = (env) => {
    const before = runs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000,
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: 'UTC', LOCKED_WATCH_HOME: T, HOME: T, DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '' }, env || {}) });
    const fired = runs().slice(before).map(r => Object.keys(ids).find(k => ids[k] === r.body.id)).filter(Boolean).sort();
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), fired, log: c.r('company/work/dispatch-log.md') };
  };
  c.rewind = async () => {   // every duty due to run again, every seat past its cooldown
    const s = c.json('company/state/duties.json'); for (const d of Object.values(s.duties)) if (d.lastRun) d.lastRun = new Date(Date.parse(d.lastRun) - 30 * MIN).toISOString();
    c.w('company/state/duties.json', s);
    for (const id of Object.keys(ids)) await st('POST', '/api/cron/update', { id: ids[id], patch: { lastRunAt: new Date(Date.now() - 60 * MIN).toISOString() } });
  };
  return c;
}
const DUE = (extra) => ({ exit: 1, out: Object.assign({ due: true, reason: '2 things\u0007 are `late`\nnow', key: 'k1' }, extra || {}) });

test('dispatcher: a due duty wakes its routed seat, hands it the sanitized reason, and logs RUN … (reason)', async () => {
  const c = await company({ modes: { 'fake-due': DUE() } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, ['kim'], r.log);
  assert.match(r.log, /RUN Kim loop \S+ for kim \(duty:fake-due \(2 things are late now\)\)/);
  const inbox = c.r('company/work/handoffs/to-kim.md');
  assert.match(inbox, /## \S+ from Dispatcher — duty fake-due: 2 things are late now\n/);
  assert.match(inbox, /\*\*Duty:\*\* fake-due key k1/); assert.match(inbox, /\*\*Status:\*\* OPEN/);
  assert.doesNotMatch(inbox, /\u0007|`late`/);
  assert.equal(c.json('company/state/duties.json').duties['fake-due'].lastResult, 'due');
  // the next tick: the same duty, now covered by that OPEN handoff -> nobody is woken for it again
  await c.rewind();
  const r2 = c.tick();
  assert.deepEqual(r2.fired, [], r2.log);
  // the check passes: the dispatcher closes its own duty handoff
  c.w('fake-mode.json', { 'fake-due': { exit: 0 } }); await c.rewind();
  c.tick();
  assert.match(c.r('company/work/handoffs/to-kim.md'), /\*\*Status:\*\* DONE — the duty check passes now/);
});

test('dispatcher: a P0 duty result wakes its seat at once, past its rest, with a Priority line and the evidence; a plain one waits', async () => {
  const c = await company({ duties: ['fake-p0', 'fake-plain'], dutyCfg: { 'fake-p0': { route: 'riley' }, 'fake-plain': { route: 'kim' } },
    modes: { 'fake-p0': DUE({ key: 'p0k', priority: 'P0', evidence: 'company/work/security/security-watch.md', items: [{ id: 'sec-0123abcd', route: 'riley' }] }), 'fake-plain': DUE({ key: 'pk' }) } });
  // both seats ran a minute ago: inside their rest
  for (const id of ['riley', 'kim']) await st('POST', '/api/cron/update', { id: c.ids[id], patch: { lastRunAt: new Date(Date.now() - MIN).toISOString() } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.fired, ['riley'], r.log);
  assert.match(r.log, /RUN Riley loop \S+ for riley \(P0 duty:fake-p0/);
  const inbox = c.r('company/work/handoffs/to-riley.md');
  assert.match(inbox, /## \S+ from Dispatcher — P0 duty fake-p0: /);
  assert.match(inbox, /\*\*Priority:\*\* P0/); assert.match(inbox, /\*\*Evidence:\*\* company\/work\/security\/security-watch\.md/); assert.match(inbox, /items sec-0123abcd/);
  assert.equal(c.json('company/state/duties.json').duties['fake-p0'].priority, 'P0');
  assert.equal(c.r('company/work/handoffs/to-kim.md').includes('fake-plain'), false, 'a plain duty item waits for the seat\'s rest');
});

test('dispatcher: dedup — items already in an OPEN handoff to that seat wake nobody; uncovered items do', async () => {
  const covered = await company({ modes: { 'fake-due': DUE({ items: [{ id: 'c-202611170000-aaaaaa', route: 'kim' }] }) }, handoffs: { 'to-kim.md': '\n## from Sam — about c-202611170000-aaaaaa\n**Need:** finish it\n**Status:** OPEN\n' } });
  const r = covered.tick();
  assert.deepEqual(r.fired, [], r.log);
  assert.doesNotMatch(r.log, /duty:fake-due/);
  const open = await company({ modes: { 'fake-due': DUE({ items: [{ id: 'c-202611170000-aaaaaa', route: 'kim' }, { id: 'c-202611170000-bbbbbb', route: 'riley' }] }) }, handoffs: { 'to-kim.md': '\n## from Sam — about c-202611170000-aaaaaa\n**Need:** finish it\n**Status:** DONE — finished\n' } });
  const r2 = open.tick();
  assert.deepEqual(r2.fired, ['kim', 'riley'], r2.log);   // each item to the seat it routes to
});

test('dispatcher: the stall rule holds a duty whose key does not change', async () => {
  const c = await company({ modes: { 'fake-due': DUE() } });
  for (let i = 0; i < 3; i++) {
    const r = c.tick(); assert.deepEqual(r.fired, ['kim'], 'wake ' + (i + 1) + ': ' + r.log);
    c.w('company/work/handoffs/to-kim.md', c.r('company/work/handoffs/to-kim.md').replace(/\*\*Status:\*\* OPEN/g, '**Status:** DONE — tried'));   // the seat closes it, the check still fails
    await c.rewind();
  }
  const r = c.tick();
  assert.deepEqual(r.fired, [], r.log);
  assert.match(r.log, /STALLED duty fake-due \(kim\): still due with key k1 after 3 runs/);
});

test('dispatcher: a broken duty is flagged once to the tools owner, quiet while the error stays, again when it changes', async () => {
  const c = await company({ modes: { 'fake-due': { exit: 5 } } });
  const flags = () => (c.r('company/work/handoffs/to-founder.md').match(/duty fake-due is broken/g) || []).length;
  c.tick();
  assert.equal(flags(), 1);
  assert.match(c.r('company/work/handoffs/to-founder.md'), /\*\*Evidence:\*\* exit 5/);
  await c.rewind(); c.tick();
  assert.equal(flags(), 1, 'the same error is not flagged again');
  c.w('fake-mode.json', { 'fake-due': { exit: 6 } }); await c.rewind(); c.tick();
  assert.equal(flags(), 2, 'a different error is flagged again');
  assert.match(c.r('company/work/dispatch-log.md'), /DUTY BROKEN fake-due: exit 6/);
});

test('dispatcher: the per-tick cap makes duties wait (counted); one that never completes is stale and flagged once', async () => {
  const c = await company({ duties: ['fake-slow', 'fake-due'], modes: { 'fake-slow': { sleepMs: 6000 }, 'fake-due': DUE() }, policy: { tickCapMs: 2000 } });
  const r = c.tick();
  assert.equal(r.code, 0, r.out);
  const s = c.json('company/state/duties.json').duties;
  assert.ok(!s['fake-slow'].lastRun && s['fake-slow'].waits === 1, JSON.stringify(s));
  assert.ok(!s['fake-due'].lastRun && s['fake-due'].waits === 1, 'the second duty waited for the cap: ' + JSON.stringify(s));
  assert.match(r.log, /DUTIES 0 run in [\d.]+ s — 0 ok, 0 due, 0 broken, 2 stale \(fake-slow, fake-due\); waiting for the cap: fake-slow, fake-due/);
  assert.deepEqual(r.fired.filter(x => x === 'kim'), [], 'a duty that did not run wakes nobody');
  const stale = () => (c.r('company/work/handoffs/to-founder.md').match(/duty fake-slow is stale/g) || []).length;
  assert.equal(stale(), 1);
  c.tick();
  assert.equal(stale(), 1, 'flagged once');
  const v = JSON.parse(spawnSync(process.execPath, [path.join(TOOLS, 'duty-status.js'), '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: c.T }) }).stdout);
  assert.equal(v.find(x => x.id === 'fake-slow').state, 'stale', 'absence never renders green');
});

test('dispatcher: while halted only whileHalted duties run, and nobody is woken or flagged', async () => {
  const c = await company({ duties: ['fake-live', 'fake-due'], dutyCfg: { 'fake-live': { whileHalted: true } }, modes: { 'fake-live': DUE({ key: 'lv' }), 'fake-due': DUE() },
    halt: { mode: 'soft', by: 'Pat', why: 'test', at: new Date().toISOString() } });
  const r = c.tick();
  assert.deepEqual(r.fired, [], r.log);
  const s = c.json('company/state/duties.json').duties;
  assert.equal(s['fake-live'].lastResult, 'due');
  assert.ok(!s['fake-due'] || !s['fake-due'].lastRun, 'a non-whileHalted duty did not run');
  assert.match(r.log, /DUTIES \(halted: liveness only\) 1 run/);
  assert.doesNotMatch(c.r('company/work/handoffs/to-founder.md'), /is stale|is broken/);
  assert.match(r.out + r.log, /HALTED \(soft by Pat/);
});

test('dispatcher: the duty sees no secret from the dispatcher environment', async () => {
  const c = await company({ modes: { 'fake-due': { dumpEnv: 'env.json', exit: 0 } } });
  c.tick({ STARNET_STATION_TOKEN: 'tok-1', ANTHROPIC_API_KEY: 'key-2', MY_SECRET: 'sec-3', NODE_OPTIONS: '--no-deprecation', SOMETHING_ELSE: 'x' });
  const env = c.json('env.json');
  for (const k of ['STARNET_STATION_TOKEN', 'ANTHROPIC_API_KEY', 'MY_SECRET', 'NODE_OPTIONS', 'SOMETHING_ELSE', 'STARNET_URL']) assert.ok(!(k in env), k + ' leaked');
  assert.ok(!JSON.stringify(env).includes(TOKEN), 'the station token value leaked');
  assert.equal(env.CAPHEOS_READONLY, '1'); assert.equal(env.CAPHEOS_NO_NETWORK, '1'); assert.equal(env.CAPHEOS_ROOT, c.T);
});

test('dispatcher: an unrecorded edit to the duty policy is flagged by locked-watch before the duties run, and not obeyed', async () => {
  const c = await company({ modes: { 'fake-due': { exit: 0 } } });
  let r = c.tick();   // the first tick builds locked-watch's baseline (and its last-known-good copy of the policy)
  assert.equal(r.code, 0, r.out);
  assert.equal(c.json('company/state/duties.json').duties['fake-due'].lastResult, 'ok');
  // tamper: switch the duty off by hand, no reviewed change
  const pol = c.json('company/work/ops/duty-policy.json'); pol.duties['fake-due'] = { enabled: false };
  const f = path.join(c.T, 'company/work/ops/duty-policy.json'); fs.writeFileSync(f, JSON.stringify(pol)); fs.utimesSync(f, (Date.now() - 120000) / 1000, (Date.now() - 120000) / 1000);
  await c.rewind();
  const ranBefore = c.json('company/state/duties.json').duties['fake-due'].lastRun;
  r = c.tick();
  assert.equal(r.code, 0, r.out);
  const report = c.r('company/work/security/locked-changes.jsonl');
  assert.match(report, /company\/work\/ops\/duty-policy\.json/, 'locked-watch reported the edit: ' + r.log.slice(-2000));
  const after = c.json('company/state/duties.json');
  assert.notEqual(after.duties['fake-due'].lastRun, ranBefore, 'the duty still ran: the flagged edit was not obeyed');
  assert.equal(after.policySource, 'last-known-good');
  // and the tools owner is told about the edit (locked-watch's report), while the duty kept running on the good copy
  assert.match(c.r('company/work/handoffs/to-founder.md'), /duty-policy\.json/);
});

test('dispatcher: a due finding is checked again within 30 minutes, not only after a long cadence, so a cleared one stops waking', async () => {
  const c = await company({ modes: { 'fake-due': DUE() }, dutyCfg: { 'fake-due': { everyMin: 360 } } });
  let t = c.tick();
  assert.equal(c.json('company/state/duties.json').duties['fake-due'].lastResult, 'due', t.out);
  c.w('fake-mode.json', { 'fake-due': { exit: 0 } });   // the problem is fixed
  const back = mins => { const s = c.json('company/state/duties.json'); s.duties['fake-due'].lastRun = new Date(Date.now() - mins * MIN).toISOString(); c.w('company/state/duties.json', s); };
  back(10); t = c.tick();
  assert.equal(c.json('company/state/duties.json').duties['fake-due'].lastResult, 'due', 'inside 30 minutes it is not re-run');
  back(31); t = c.tick();
  assert.equal(c.json('company/state/duties.json').duties['fake-due'].lastResult, 'ok', 'after 30 minutes the due finding is re-checked (cadence 360): ' + t.out.slice(-400));
});
