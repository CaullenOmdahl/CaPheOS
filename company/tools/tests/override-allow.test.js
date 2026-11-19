'use strict';
// override-allow.test.js — lib/override-allow.js: the station's one-run model override allowlist (StarNet patch 0017),
// company/state/override-allow.json, built from what models.js evaluate() says each crew seat can run NOW.
//   node --test company/tools/tests/override-allow.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'override-allow-selftest-'));
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
const R = rel => JSON.parse(fs.readFileSync(path.join(T, rel), 'utf8'));
W('company/company.json', { name: 'Override Test', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents: {
  alex: { name: 'Alex', functions: ['ceo'], manager: null },
  jo: { name: 'Jo', manager: 'alex' },
  sam: { name: 'Sam', manager: 'alex' },
  kim: { name: 'Kim', manager: 'alex' } } });
W('company/model-policy.json', {
  allowed: { 'claude-cli': { models: ['claude-sonnet-5-5', 'claude-opus-5-5'] }, deepseek: { models: ['deepseek-flash'] }, custom: { models: ['MiniMax-M3.1-Flash'] } },
  seats: {
    _doc: 'test',
    // claudeReserve off so the pacer's Claude closure applies to it as to any seat
    jo: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }, { provider: 'deepseek', model: 'deepseek-flash' }], claudeReserve: false },
    sam: { chain: [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }] },
    // an entry off the allowed list never opens, whatever the gates say
    alex: { chain: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }], claudeReserve: false }
  } });
process.env.CAPHEOS_ROOT = T;
process.env.PROVENANCE_ROOT = T;   // provenance.js records under the fixture, never the live company
const OA = require('../lib/override-allow');
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

const providers = { 'claude-cli': true, deepseek: true, custom: true };
const call = async (method, p) => {
  if (p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: Object.entries(providers).map(([id, c]) => ({ id, configured: c, reason: c ? 'verified' : 'credential missing' })) }) };
  if (p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs: [] }) };
  return { status: 404, body: '{}' };
};
const gate = (claude, minimax, deepseek) => ({
  claude: { open: claude, known: true, why: claude ? 'open' : 'past the pacing line', usedPct: 96, weekCap: 95 },
  minimax: { open: minimax, why: minimax ? 'open' : 'out of its window' },
  deepseek: { open: deepseek, why: deepseek ? 'open' : 'no credit' },
  rail: { pct: 10, pressure: false, holdAtPct: 85 } });
let clock = Date.parse('2026-11-18T10:00:00Z');
const now = () => clock;
const FILE = 'company/state/override-allow.json';

test('claude-cli closed by the pacer, deepseek open: the seat lists only deepseek (no effort), every crew seat present', async () => {
  const r = await OA.write({ root: T, call, now, jobs: [], m: gate(false, true, true) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const doc = R(FILE);
  assert.deepStrictEqual([doc.v, doc.at, doc.by], [1, clock, 'dispatcher']);
  assert.deepStrictEqual(doc.agents.jo, [{ provider: 'deepseek', model: 'deepseek-flash' }]);
  assert.deepStrictEqual(doc.agents.sam, [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }]);
  assert.deepStrictEqual(doc.agents.alex, [], 'off the allowed list: never listed');
  assert.deepStrictEqual(doc.agents.kim, [], 'a seat with no chain and no department: []');
  assert.deepStrictEqual(Object.keys(doc.agents).sort(), ['alex', 'jo', 'kim', 'sam']);
});

test('the file is rewritten on every tick: Claude reopens, MiniMax closes', async () => {
  clock += 10 * 60e3;
  await OA.write({ root: T, call, now, jobs: [], m: gate(true, false, true) });
  const doc = R(FILE);
  assert.strictEqual(doc.at, clock);
  assert.deepStrictEqual(doc.agents.jo, [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }]);
  assert.deepStrictEqual(doc.agents.sam, [], 'MiniMax closed by the pacer');
  assert.ok(!fs.readdirSync(path.join(T, 'company/state')).some(f => /override-allow\.json\.tmp/.test(f)), 'atomic: no temp file left');
});

test('a refusal block closes that provider for the seat', async () => {
  clock += 60e3;
  const blocks = [{ routineId: 'jr', name: 'Jo loop', provider: 'deepseek', model: 'deepseek-flash', at: clock - 60e3, until: clock + 3600e3 }];
  await OA.write({ root: T, call, now, jobs: [{ id: 'jr', name: 'Jo loop', agentId: 'jo', provider: 'deepseek', model: 'deepseek-flash' }], m: gate(false, true, true), blocks });
  assert.deepStrictEqual(R(FILE).agents.jo, [], 'Claude closed, DeepSeek refusal-blocked: nothing open');
});

test('no pacer measurement: fail closed, every seat []', async () => {
  clock += 60e3;
  const lines = [];
  const r = await OA.write({ root: T, call, now, jobs: [], m: { nothing: true }, log: l => lines.push(l) });
  assert.strictEqual(r.ok, false);
  const doc = R(FILE);
  assert.ok(Object.values(doc.agents).every(a => Array.isArray(a) && a.length === 0), JSON.stringify(doc));
  assert.ok(lines.some(l => /OVERRIDE ALLOWLIST/.test(l)), lines.join('|'));
});

test('a missing company/departments.json is fine (no routes); a department route is listed only when it can run now', async () => {
  assert.ok(!fs.existsSync(path.join(T, 'company/departments.json')));
  assert.deepStrictEqual(OA.departmentRoutes('kim', { root: T }), []);
  W('company/departments.json', { version: 1, departments: [
    { id: 'eng', name: 'Engineering', lead: 'jo', members: ['jo', 'kim'], routes: { code: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'high' }, mechanical: { provider: 'deepseek', model: 'deepseek-flash' }, writing: { provider: 'custom', model: 'MiniMax-M3.1-Pro' } } }] });
  clock += 60e3;
  await OA.write({ root: T, call, now, jobs: [], m: gate(false, true, true) });
  let doc = R(FILE);
  assert.deepStrictEqual(doc.agents.kim, [{ provider: 'deepseek', model: 'deepseek-flash' }], 'Claude route closed by the pacer, MiniMax Pro off the allowed list: only the DeepSeek route');
  assert.deepStrictEqual(doc.agents.jo, [{ provider: 'deepseek', model: 'deepseek-flash' }], 'chain + routes, no duplicates');
  assert.deepStrictEqual(doc.agents.sam, [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }], 'a seat outside the department gets none of its routes');
  clock += 60e3;
  await OA.write({ root: T, call, now, jobs: [], m: gate(true, true, true) });
  doc = R(FILE);
  assert.deepStrictEqual(doc.agents.kim, [{ provider: 'claude-cli', model: 'claude-opus-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }], 'the Claude route opens with the gate');
  fs.writeFileSync(path.join(T, 'company/departments.json'), '{broken');
  clock += 60e3;
  await OA.write({ root: T, call, now, jobs: [], m: gate(true, true, true) });
  assert.deepStrictEqual(R(FILE).agents.kim, [], 'a broken departments.json counts as none');
  fs.rmSync(path.join(T, 'company/departments.json'));
});

test('a routing policy: running trial arms and live tier-cap entries are listed for in-scope seats; class rules drop a denied route or arm', async () => {
  const pol = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'defaults', 'work', 'models', 'routing-policy.json'), 'utf8'));
  pol.mode = 'shadow'; pol.tierCaps.mode = 'live';
  pol.trials = [
    { id: 'opus-code', class: 'code', arms: [{ provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }], scope: { seats: ['kim'] }, entryShare: 0.1, status: 'running' },
    { id: 'mm-code', class: 'code', arms: [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }], scope: { seats: ['kim'] }, entryShare: 1, status: 'running' },
    { id: 'drafted', class: 'writing', arms: [{ provider: 'deepseek', model: 'deepseek-flash' }], scope: { seats: ['kim'] }, entryShare: 1, status: 'draft' }];
  W('company/work/models/routing-policy.json', pol);
  W('company/departments.json', { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: 'jo', members: ['jo', 'kim'], routes: { code: { provider: 'custom', model: 'MiniMax-M3.1-Flash' } } }] });
  try {
    clock += 60e3;
    await OA.write({ root: T, call, now, jobs: [], m: gate(true, true, true) });
    const doc = R(FILE);
    assert.deepStrictEqual(doc.agents.kim, [{ provider: 'claude-cli', model: 'claude-opus-5-5' }, { provider: 'claude-cli', model: 'claude-sonnet-5-5' }],
      'the running trial\'s arms; not the MiniMax code route nor the MiniMax trial arm (class rules), not the draft trial');
    assert.deepStrictEqual(doc.agents.sam, [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }], 'its own chain only: in no trial, no department');
    assert.deepStrictEqual(OA.departmentRoutes('kim', { root: T }), [], 'the denied route is never listed');
    // without the policy the wave-1 behaviour: the route is listed as it is
    fs.rmSync(path.join(T, 'company/work/models/routing-policy.json'));
    assert.deepStrictEqual(OA.departmentRoutes('kim', { root: T }), [{ provider: 'custom', model: 'MiniMax-M3.1-Flash' }]);
  } finally { fs.rmSync(path.join(T, 'company/departments.json'), { force: true }); fs.rmSync(path.join(T, 'company/work/models/routing-policy.json'), { force: true }); }
});

test('a provider not connected on the station is not listed', async () => {
  providers.deepseek = false;
  try {
    clock += 60e3;
    await OA.write({ root: T, call, now, jobs: [], m: gate(false, true, true) });
    assert.deepStrictEqual(R(FILE).agents.jo, []);
  } finally { providers.deepseek = true; }
});

test('the write is recorded for locked-watch.js (class R, writer lib/override-allow.js)', () => {
  const lw = require('../locked-watch.js');
  const row = lw.MANIFEST.find(m => m.p === FILE);
  assert.ok(row && row.cls === 'R' && row.writers.includes(OA.WRITER) && row.regen[0] === 'lib/override-allow.js', JSON.stringify(row));
  const prov = fs.readFileSync(path.join(T, 'company/state/locked/provenance.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.file === FILE);
  const txt = fs.readFileSync(path.join(T, FILE));
  const sha = 'sha256:' + require('crypto').createHash('sha256').update(txt).digest('hex');
  assert.ok(prov.some(r => r.writer === OA.WRITER && r.sha256 === sha), 'the current bytes have a provenance row');
});

test('the dispatcher rewrites it at the end of every tick, and the station env names it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dispatch.js'), 'utf8');
  assert.ok(/require\('\.\/lib\/override-allow\.js'\)\.write\(\{ jobs, log \}\)/.test(src), 'dispatch.js calls write() each tick');
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'scripts', 'setup-station.sh'), 'utf8');
  assert.ok(/^STARNET_OVERRIDE_ALLOW=\$ROOT\/company\/state\/override-allow\.json$/m.test(sh), 'setup-station.sh writes STARNET_OVERRIDE_ALLOW');
});

test('openFor: the station\'s own test for a caller that starts a run itself (a meeting with one model for everyone)', () => {
  const now = Date.now();
  fs.rmSync(path.join(T, OA.REL), { force: true });
  assert.match(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-flash' }, { root: T }), /no current list/, 'no file: closed');
  W(OA.REL, { v: 1, at: now - 60e3, by: 'dispatcher', agents: { jo: [{ provider: 'deepseek', model: 'deepseek-flash' }], sam: [] } });
  assert.strictEqual(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-flash' }, { root: T, now }), null, 'listed for that agent: open');
  assert.match(OA.openFor('jo', { provider: 'claude-cli', model: 'claude-opus-5-5' }, { root: T, now }), /not open for them/, 'not listed: closed');
  assert.match(OA.openFor('sam', { provider: 'deepseek', model: 'deepseek-flash' }, { root: T, now }), /not open for them/, 'listed for another agent only: closed');
  assert.match(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-flash' }, { root: T, now: now + OA.MAX_AGE_MS }), /out of date/, 'older than 30 minutes: closed');
  // the owner's pick for a meeting (Haiku for everyone, 2026-11-19): a model outside the seat's chain is open when that
  // provider is open for the seat now; another provider, or a seat with nothing open, stays closed
  assert.strictEqual(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-pro' }, { root: T, now, ownerPick: true }), null, 'owner pick, same provider open: open');
  assert.match(OA.openFor('jo', { provider: 'claude-cli', model: 'haiku' }, { root: T, now, ownerPick: true }), /provider is closed/, 'owner pick, provider not open for the seat: closed');
  assert.match(OA.openFor('nobody', { provider: 'deepseek', model: 'deepseek-pro' }, { root: T, now, ownerPick: true }), /no AI is open/, 'owner pick, seat with nothing open: closed');
  assert.match(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-pro' }, { root: T, now }), /not open for them/, 'not an owner pick: the station rule, exact pair only');
  assert.match(OA.openFor('jo', { provider: 'deepseek', model: 'deepseek-pro' }, { root: T, now: now + OA.MAX_AGE_MS, ownerPick: true }), /out of date/, 'owner pick, stale list: closed');
  fs.rmSync(path.join(T, OA.REL), { force: true });
});
