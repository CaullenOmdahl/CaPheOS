'use strict';
// console/connectors.js (Settings › Connections and keys › <service> › Connect, docs/CONNECTORS.md) against fake CLIs
// (fixtures/connectors/fake-cli.js), one per auth style, so nothing reaches a network: URL capture through the BROWSER
// shim, the remote paste replay (and every refusal: another host, port, path, scheme or state), device-code display,
// paste-code, the postLogin commands, credential mode and verify, Expired, Disconnect, provenance keeping locked-watch
// quiet, the 10-minute kill (shortened), one sign-in at a time, the same-user answer (G4), and where credentials live.
// Owner-only routes are checked in console/server.js --selftest.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-selftest-'));
const H = path.join(T, 'home');
fs.mkdirSync(H, { recursive: true });
fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
fs.mkdirSync(path.join(T, 'company', 'tools'), { recursive: true });
fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
fs.mkdirSync(path.join(T, 'company', 'work', 'handoffs'), { recursive: true });
fs.writeFileSync(path.join(T, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: {
  ceo1: { name: 'Avery', functions: ['ceo', 'people', 'risk', 'tools', 'finance', 'floor'], inbox: 'to-avery.md', manager: null } } }));
fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', slug: 'test-co', timezone: 'UTC', owner: { name: 'Pat' } }));
Object.assign(process.env, { CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, PROVENANCE_HOME: H });

const FAKE = path.join(__dirname, 'fixtures', 'connectors', 'fake-cli.js');
const D = path.join(T, 'company', 'connectors');
fs.mkdirSync(D, { recursive: true });
const decl = (id, o) => fs.writeFileSync(path.join(D, id + '.json'), JSON.stringify(Object.assign({ id, label: 'Fake ' + id,
  configEnv: { FAKE_CRED_FILE: '{dir}/cred.json' }, credentialPath: 'company/connections/' + id + '/cred.json',
  verify: ['node', FAKE, 'any', 'verify'], logout: ['node', FAKE, 'any', 'logout'] }, o)));
decl('fake-loop', { style: 'loopback', loginCommand: ['node', FAKE, 'loopback', 'login', '--no-print'], postLogin: [['node', FAKE, 'any', 'keys-create']],
  redirectUri: 'http://127.0.0.1:{port}/callback', portParam: 'cli_port', stateParam: 'cli_state', urlPattern: '^https://auth\\.example\\.invalid/start',
  knownIssues: [{ title: 'Test users only', match: 'access_denied', text: 'Ask to be added as a test user.' }] });
decl('fake-device', { style: 'device-code', loginCommand: ['node', FAKE, 'device', 'login'], postLogin: [['node', FAKE, 'any', 'keys-create']], codePattern: 'one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})' });
decl('fake-paste', { style: 'paste-code', loginCommand: ['node', FAKE, 'paste', 'login'], postLogin: [['node', FAKE, 'any', 'keys-create']] });
decl('fake-hang', { style: 'paste-code', loginCommand: ['node', FAKE, 'any', 'hang'] });
decl('fake-home', { style: 'device-code', configEnv: undefined, credentialPath: '~/.config/fake/cred.json', loginCommand: ['node', FAKE, 'device', 'login'], postLogin: [['node', FAKE, 'any', 'keys-create']], codePattern: 'one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})' });
decl('fake-missing', { style: 'paste-code', loginCommand: ['capheos-no-such-cli-xyz', 'login'] });

const co = require('../lib/company.js');
const C = require('../../../console/connectors.js');
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = m => { throw new HttpError(400, m); };
const tool = n => require(path.join(__dirname, '..', n));
const P = require('../provenance.js'); P.pinUnderStation(false);
const make = o => C(Object.assign({ co, bad, HttpError, tool, owner: () => 'Pat', opts: Object.assign({ home: H, noDeps: true }, o) }));
const K = make();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 8000); for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(80); } }
const remote = { socket: { remoteAddress: '10.1.2.3' }, headers: {} };
const local = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
const phase = id => K.session(id).session && K.session(id).session.phase;
const refuses = async (fn, re) => { await assert.rejects(async () => fn(), e => (re ? re.test(e.message) : true) && e.status >= 400); };
const cred = id => path.join(T, 'company', 'connections', id, 'cred.json');
const LW = require('../locked-watch.js');
const lwTick = now => LW.tick({ root: T, home: H, now, log: () => {}, underStation: false, jobs: [], connectors: null });

test.after(() => { K.stopAll(); fs.rmSync(T, { recursive: true, force: true }); });

test('the shipped declarations (Synpath, GitHub CLI) are valid and keep credentials under the company root', () => {
  const r = C.loadDeclarations(path.join(__dirname, '..', '..', 'connectors'));
  assert.deepEqual(r.errors, []);
  const syn = r.connectors.find(c => c.id === 'synpath'), gh = r.connectors.find(c => c.id === 'github-cli');
  assert.equal(syn.style, 'loopback'); assert.ok(syn.loginCommand.includes('--no-browser'));
  assert.ok(syn.postLogin.some(a => a.join(' ') === 'synpath keys create capheos --no-print-key'));
  assert.equal(gh.style, 'device-code');
  for (const d of [syn, gh]) assert.ok(d.credentialPath.every(p => p.startsWith('company/connections/' + d.id + '/')) && d.configEnv);
  assert.ok(C.validate({ id: 'x', label: 'X', style: 'loopback', loginCommand: ['x'], credentialPath: '../etc/passwd', redirectUri: 'http://127.0.0.1:1/cb' }).error);
  assert.ok(C.validate({ id: 'x', label: 'X', style: 'loopback', loginCommand: ['x'], credentialPath: 'a', redirectUri: 'http://evil.example:1/cb' }).error);
});

test('locked-watch watches every declared credential as a key the console writes', () => {
  const e = LW.connectorEntries(p => path.join(T, p));
  const k = e.find(x => x.p === 'company/connections/fake-loop/cred.json');
  assert.ok(k && k.cls === 'K' && k.writers.includes('console'));
  assert.ok(e.some(x => x.p === '~/.config/fake/cred.json'));
});

test('loopback, owner on another machine: the shim captures the address; the pasted return address is checked, then replayed', async () => {
  assert.ok((await lwTick(Date.now())).initialized, 'locked-watch baseline before any connect');
  const v = K.start('fake-loop', {}, remote);
  assert.equal(v.session.sameMachine, false);
  await refuses(() => K.start('fake-loop', {}, remote), /already open/);   // one sign-in at a time
  const s = await until(() => { const x = K.session('fake-loop', remote).session; return x.phase === 'sign-in' && x; });
  assert.ok(s, 'reached sign-in: ' + JSON.stringify(K.session('fake-loop').session));
  assert.match(s.url, /^https:\/\/auth\.example\.invalid\/start\?cli_port=\d+&cli_state=/, 'captured through BROWSER (the CLI printed nothing)');
  assert.equal(s.needs, 'loopback');
  assert.ok(!s.output.includes(s.url));
  assert.equal(K.session('fake-loop', local).session.sameMachine, true);
  assert.equal(K.session('fake-loop', { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.9' } }).session.sameMachine, false, 'behind a proxy is remote');
  const u = new URL(s.url); const port = u.searchParams.get('cli_port'), state = u.searchParams.get('cli_state');
  const code = 'c'.repeat(43);
  const good = 'http://127.0.0.1:' + port + '/callback?code=' + code + '&state=' + state;
  await refuses(() => K.callback('fake-loop', { address: good.replace('127.0.0.1', 'evil.example') }), /127\.0\.0\.1/);
  await refuses(() => K.callback('fake-loop', { address: good.replace('127.0.0.1', '10.0.0.1') }), /127\.0\.0\.1/);
  await refuses(() => K.callback('fake-loop', { address: good.replace(':' + port, ':' + (Number(port) === 65535 ? 1 : Number(port) + 1)) }), /another port/);
  await refuses(() => K.callback('fake-loop', { address: good.replace('http:', 'https:') }), /http:\/\//);
  await refuses(() => K.callback('fake-loop', { address: good.replace('/callback', '/other') }), /return address/);
  await refuses(() => K.callback('fake-loop', { address: good.replace('state=' + state, 'state=forged') }), /state does not match/);
  await refuses(() => K.callback('fake-loop', { address: good.replace('&state=' + state, '') }), /state does not match/);
  await refuses(() => K.callback('fake-loop', { address: 'http://user:pw@127.0.0.1:' + port + '/callback?state=' + state }));
  await refuses(() => K.callback('fake-loop', { address: 'not a url' }), /not a web address/);
  assert.equal(phase('fake-loop'), 'sign-in', 'refusals leave the sign-in waiting');
  const r = await K.callback('fake-loop', { address: '  ' + good + '\n' });
  assert.equal(r.accepted, true);
  assert.ok(await until(() => phase('fake-loop') === 'connected'), JSON.stringify(K.session('fake-loop').session));
  const sess = K.session('fake-loop').session;
  assert.deepEqual(sess.steps.map(x => x.ok), [true], 'the postLogin command ran');
  const c = JSON.parse(fs.readFileSync(cred('fake-loop'), 'utf8'));
  assert.ok(c.session && /^spk_k1\./.test(c.api_key), 'postLogin added the key');
  assert.equal(fs.statSync(cred('fake-loop')).mode & 0o777, 0o600);
  const rec = JSON.parse(fs.readFileSync(path.join(T, 'company', 'state', 'connections.json'), 'utf8')).connections['fake-loop'];
  assert.ok(rec.connected && rec.by === 'owner' && rec.connectedAt && rec.artefacts[0] === 'company/connections/fake-loop/cred.json');
  const recText = fs.readFileSync(path.join(T, 'company', 'state', 'connections.json'), 'utf8');
  for (const secret of [c.api_key, state, code, s.url]) assert.ok(!recText.includes(secret), 'no value or address in connections.json');
  const inbox = fs.readFileSync(path.join(T, 'company', 'work', 'handoffs', 'to-avery.md'), 'utf8');
  assert.match(inbox, /The owner connected Fake fake-loop/); assert.ok(!inbox.includes(c.api_key));
  const prov = fs.readFileSync(P.logFile(T), 'utf8');
  assert.ok(prov.includes('"file":"company/connections/fake-loop/cred.json"') && prov.includes('console (owner connect fake-loop)'));
  const st = (await K.status('fake-loop')).connector;
  assert.equal(st.state, 'connected'); assert.equal(st.storage, 'company');
  assert.deepEqual(st.crewEnv, { FAKE_CRED_FILE: 'company/connections/fake-loop/cred.json' });
});

test('provenance keeps locked-watch quiet for the owner\'s connect, and an unrecorded change is still flagged', async () => {
  const now = Date.now() + 60e3;
  const r = await lwTick(now);
  const ev = (r.events || []).filter(e => e.key === 'company/connections/fake-loop/cred.json');
  assert.deepEqual(ev, [], JSON.stringify(r.events));
  fs.writeFileSync(cred('fake-loop'), '{"api_key":"spk_planted.0000000000"}'); fs.chmodSync(cred('fake-loop'), 0o600);
  const r2 = await lwTick(now + 60e3);
  assert.ok((r2.events || []).some(e => e.key === 'company/connections/fake-loop/cred.json' && e.kind === 'flagged'), JSON.stringify(r2.events));
});

test('G4: one Unix user, so a crew tool CAN read the credential, and status says so instead of hiding it', async () => {
  const st = (await K.status('fake-loop')).connector;
  const agentRead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("fs").readFileSync(process.argv[1]).length))', cred('fake-loop')], { encoding: 'utf8' });
  assert.equal(agentRead.status, 0, 'an agent tool running as the same user reads the file');
  assert.ok(Number(agentRead.stdout) > 0);
  assert.equal(st.isolation, 'same-user'); assert.equal(st.crewCanRead, true);
  assert.match(st.promise, /Kept out of prompts and logs, not out of reach of the crew's tools/);
  assert.ok(!/encrypt|keychain|keyring/i.test(st.promise));
  const B = make({ broker: { canRead: () => false } });
  const sb = (await B.status('fake-loop')).connector;
  assert.equal(sb.isolation, 'broker'); assert.equal(sb.crewCanRead, false, 'the future broker hook answers for itself');
});

test('Expired when the verify command fails; Disconnect needs confirmation, removes the credential and is recorded', async () => {
  process.env.FAKE_EXPIRED = path.join(T, 'expired');
  fs.writeFileSync(process.env.FAKE_EXPIRED, '');
  assert.equal((await K.status('fake-loop')).connector.state, 'expired');
  fs.rmSync(process.env.FAKE_EXPIRED); delete process.env.FAKE_EXPIRED;
  await refuses(() => K.disconnect('fake-loop', {}), /Confirm/);
  assert.ok(fs.existsSync(cred('fake-loop')));
  const r = await K.disconnect('fake-loop', { confirm: true });
  assert.deepEqual(r.removed, ['company/connections/fake-loop/cred.json']); assert.equal(r.loggedOut, true);
  assert.ok(!fs.existsSync(cred('fake-loop')));
  assert.equal((await K.status('fake-loop')).connector.state, 'not-connected');
  const rec = JSON.parse(fs.readFileSync(path.join(T, 'company', 'state', 'connections.json'), 'utf8')).connections['fake-loop'];
  assert.ok(rec.connected === false && rec.disconnectedAt);
  assert.match(fs.readFileSync(P.logFile(T), 'utf8'), /"kind":"delete"[^\n]*console \(owner disconnect fake-loop\)/);
  const lw = await lwTick(Date.now() + 300e3);
  assert.ok(!(lw.events || []).some(e => e.key === 'company/connections/fake-loop/cred.json' && e.kind === 'flagged'), JSON.stringify(lw.events));
});

test('device-code: the code and the address are shown; approval elsewhere finishes it', async () => {
  process.env.FAKE_APPROVE = path.join(T, 'approve');
  K.start('fake-device', {}, remote);
  const s = await until(() => { const x = K.session('fake-device').session; return x.phase === 'sign-in' && x; });
  assert.ok(s, JSON.stringify(K.session('fake-device').session));
  assert.equal(s.code, 'WXYZ-1234'); assert.equal(s.url, 'https://auth.example.invalid/device'); assert.equal(s.needs, 'enter-code-there');
  assert.ok(!s.output.includes('WXYZ-1234'), 'the code is not repeated in the redacted output');
  await refuses(() => K.callback('fake-device', { address: 'http://127.0.0.1:1/x' }), /is waiting for an address/);
  fs.writeFileSync(process.env.FAKE_APPROVE, '');
  assert.ok(await until(() => phase('fake-device') === 'connected'), JSON.stringify(K.session('fake-device').session));
  delete process.env.FAKE_APPROVE;
});

test('paste-code: a wrong code fails the sign-in; the right one connects', async () => {
  K.start('fake-paste', {}, remote);
  assert.ok(await until(() => phase('fake-paste') === 'sign-in'));
  assert.equal(K.session('fake-paste').session.needs, 'paste-code');
  await refuses(() => K.code('fake-paste', { code: 'has space' }), /no spaces/);
  K.code('fake-paste', { code: 'WRONG' });
  assert.ok(await until(() => phase('fake-paste') === 'failed'));
  K.start('fake-paste', {}, remote);
  assert.ok(await until(() => phase('fake-paste') === 'sign-in'));
  K.code('fake-paste', { code: 'GOOD-CODE' });
  assert.ok(await until(() => phase('fake-paste') === 'connected'), JSON.stringify(K.session('fake-paste').session));
});

test('a credential others could read is refused (mode must be 0600)', async () => {
  await K.disconnect('fake-paste', { confirm: true });
  process.env.FAKE_MODE = '644';
  try {
    K.start('fake-paste', {}, remote);
    assert.ok(await until(() => phase('fake-paste') === 'sign-in'));
    K.code('fake-paste', { code: 'GOOD-CODE' });
    assert.ok(await until(() => phase('fake-paste') === 'failed'));
    assert.match(K.session('fake-paste').session.error, /mode 0644.*0600/);
  } finally { delete process.env.FAKE_MODE; }
});

test('the CLI and its children are killed when the time runs out', async () => {
  const pids = path.join(T, 'pids'); process.env.FAKE_PIDS = pids;
  const Q = make({ timeoutMs: 1200 });
  Q.start('fake-hang', {}, remote);
  const ids = await until(() => { try { return fs.readFileSync(pids, 'utf8').split(' ').map(Number); } catch (_) { return null; } });
  assert.ok(ids && ids.length === 2);
  assert.ok(await until(() => Q.session('fake-hang').session.phase === 'timed-out', 5000));
  assert.match(Q.session('fake-hang').session.error, /not finished within/);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
  assert.ok(await until(() => !alive(ids[0]) && !alive(ids[1]), 6000), 'the CLI and its grandchild are gone');
  delete process.env.FAKE_PIDS;
});

test('a CLI that cannot be redirected keeps its credential in ~ and status says so; a missing CLI says it is not installed', async () => {
  const st = (await K.status('fake-home')).connector;
  assert.equal(st.storage, 'home'); assert.match(st.storageNote, /lost on a rebuild unless the home folder is a volume/);
  K.start('fake-missing', {}, remote);
  assert.ok(await until(() => phase('fake-missing') === 'failed'));
  assert.match(K.session('fake-missing').session.error, /not installed/);
});

test('pure helpers: redact hides addresses, codes and keys; the known issue matches a provider refusal', () => {
  const t = C.redact('Open https://x.example/a?state=s and spk_abc.1234567890 code: WXYZ-1234 ghp_abcdefghijklmnop');
  assert.ok(!/https:|spk_abc|WXYZ|ghp_/.test(t), t);
  const e = C.expectation({ redirectUri: 'http://127.0.0.1:{port}/cb', portParam: 'p' }, 'https://a.example/s?p=5000&state=abc');
  assert.deepEqual([e.port, e.path, e.state, e.requireState], [5000, '/cb', 'abc', true]);
  const r = C.expectation({ redirectUri: 'http://127.0.0.1:{port}/cb', redirectParam: 'redirect_uri' }, 'https://a.example/s?redirect_uri=' + encodeURIComponent('http://localhost:6000/cb') + '&state=z');
  assert.equal(C.checkCallback('http://127.0.0.1:6000/cb?state=z', r).ok, false, 'the exact redirect host');
  assert.equal(C.checkCallback('http://localhost:6000/cb?state=z', r).ok, true);
  assert.equal(C.checkCallback('http://localhost:6000/cb?error=access_denied&state=z', r).error, 'access_denied');
});
