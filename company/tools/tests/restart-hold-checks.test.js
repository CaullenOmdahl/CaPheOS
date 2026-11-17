'use strict';
// restart-hold-checks.test.js — while restart-station.js holds new starts (company/state/restart-hold.json, the station
// scheduler disarmed on purpose), the status checks say "paused for a station restart (since …, expires …)" instead of
// FAIL: onboard.js --certify (its founder-loop check, via founder-loop.js status), the duty board (duty-runner view) and
// the liveness heartbeat. A hold past its expiresAt holds nothing, so a scheduler still off then is a FAIL again, and
// so is one off while the restart script only watches (its hold lifted after --hold-max-min).
//   node --test company/tools/tests/restart-hold-checks.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-hold-checks-selftest-'));
const TOKEN = 'hold-checks-token';
const W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof txt === 'string' ? txt : JSON.stringify(txt)); return f; };
const HOLD = 'company/state/restart-hold.json';
const iso = ms => new Date(ms).toISOString();
const hold = (o) => W(HOLD, Object.assign({ by: 'Olive', reason: 'patch 0017', pid: 999999999, at: iso(Date.now() - 5 * 60e3), expiresAt: iso(Date.now() + 25 * 60e3), disarmed: true }, o || {}));

let mock, PORT;
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign({ 'x-starnet-token': TOKEN }, data ? { 'content-type': 'application/json' } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(d); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const env = () => Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + PORT, CAPHEOS_SECRET_STATION_TOKEN: TOKEN, CONSOLE_URL: 'http://127.0.0.1:1', CAPHEOS_BACKUP_DIR: path.join(T, 'backups'), ONBOARD_NO_SYSTEMCTL: '1' });
// a snippet in a child with CAPHEOS_ROOT set (lib/company.js reads it once, at require time)
function snippet(code) {
  const r = spawnSync(process.execPath, ['-e', code], { cwd: T, env: env(), encoding: 'utf8', timeout: 60000 });
  let j = null; try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) {}
  return { j, out: r.stdout + r.stderr };
}
function certify() {
  const r = spawnSync(process.execPath, [path.join(T, 'company', 'tools', 'onboard.js'), '--certify', '--json'], { cwd: T, env: env(), encoding: 'utf8', timeout: 170000 });
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  return { code: r.status, j, out: r.stdout + r.stderr };
}

test.before(async () => {
  fs.cpSync(path.join(REPO, 'company'), path.join(T, 'company'), { recursive: true, filter: s => !/[\/\\]company[\/\\](state|work|owner|hiring)[\/\\]./.test(s) });
  fs.cpSync(path.join(REPO, 'scripts'), path.join(T, 'scripts'), { recursive: true });
  fs.cpSync(path.join(REPO, 'modules'), path.join(T, 'modules'), { recursive: true });
  for (const d of ['state', 'work', 'owner']) fs.mkdirSync(path.join(T, 'company', d), { recursive: true });
  W('company/company.json', { name: 'Test Co', slug: 'test-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { serviceName: 'test-co-station' } });
  W('company/tools/loops.json', { agents: { founder: { name: 'Founder', functions: ['ceo', 'people', 'tools', 'risk', 'finance'], manager: null, inbox: 'to-founder.md', loop: 'Founder loop' } } });
  mock = spawn(process.execPath, [path.join(REPO, 'tests', 'mock-station.js'), '--port', '0', '--token', TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
  PORT = await new Promise((resolve, reject) => { mock.stdout.once('data', d => { try { resolve(JSON.parse(String(d).split('\n')[0]).port); } catch (e) { reject(e); } }); mock.once('exit', c => reject(new Error('mock exited ' + c))); });
  // a working Founder loop: the routine in the company folder with a terminal grant and a model, the folder blessed
  await req('POST', '/api/projects/bless', { path: T });
  await req('POST', '/api/cron', { name: 'Founder loop', agentId: 'founder', prompt: 'x', schedule: 'every 2 hours', workdir: T, unattendedGrants: ['workbench'], model: 'm', provider: 'p', enabled: true });
  await req('POST', '/api/cron/arm', { enabled: false });   // what a restart hold does
});
test.after(() => { try { mock.kill(); } catch (_) {} try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} });

const flStatus = () => snippet("require('./company/tools/founder-loop.js').status().then(r => console.log(JSON.stringify(r)))");

test('founder-loop status: the scheduler off under an active restart hold is paused, not a problem', () => {
  hold();
  const { j, out } = flStatus();
  assert.ok(j, out);
  assert.strictEqual(j.ok, true, out);
  assert.strictEqual(j.schedulerOn, false);
  assert.ok(/^paused for a station restart \(since \d\d:\d\d, expires \d\d:\d\d; patch 0017\)$/.test(j.paused), j.paused);
});

test('founder-loop status: an expired hold, a watching record or no hold with the scheduler off still FAILs', () => {
  hold({ at: iso(Date.now() - 3 * 3600e3), expiresAt: iso(Date.now() - 60e3) });
  let { j, out } = flStatus();
  assert.strictEqual(j.ok, false, out);
  const p = j.problems.find(x => x.code === 'scheduler-off');
  assert.ok(p && /scheduler is off/.test(p.msg) && /restart hold disarmed it and expired at \d\d:\d\d/.test(p.msg) && /restart-station\.sh --release/.test(p.fix), JSON.stringify(j.problems));
  hold({ watching: true, disarmed: false });   // the hold is lifted: the scheduler should be armed again
  ({ j, out } = flStatus());
  assert.strictEqual(j.ok, false, out); assert.ok(j.problems.some(x => x.code === 'scheduler-off'));
  fs.unlinkSync(path.join(T, HOLD));
  ({ j, out } = flStatus());
  assert.strictEqual(j.ok, false, out); assert.ok(j.problems.some(x => x.code === 'scheduler-off' && !/expired/.test(x.msg)));
});

test('onboard --certify during a hold: founder-loop passes with the pause named; after the hold expires it fails', () => {
  hold();
  let r = certify();
  assert.ok(r.j && r.j.results, r.out);
  let fl = r.j.results['founder-loop'];
  assert.strictEqual(fl.ok, true, JSON.stringify(fl));
  assert.ok(/the scheduler is paused for a station restart \(since \d\d:\d\d, expires \d\d:\d\d/.test(fl.note), JSON.stringify(fl));
  assert.ok(!/scheduler is off/.test(JSON.stringify(r.j.results)), 'no "scheduler is off" anywhere while held');
  hold({ at: iso(Date.now() - 3 * 3600e3), expiresAt: iso(Date.now() - 60e3) });
  r = certify();
  fl = r.j.results['founder-loop'];
  assert.strictEqual(fl.ok, false, JSON.stringify(fl));
  assert.ok(/the station scheduler is off, so no routine fires on its schedule/.test(fl.missing), fl.missing);
  fs.unlinkSync(path.join(T, HOLD));
});

test('onboard kickoff during a hold: the handoff is written, the loop is not fired', async () => {
  hold();
  const before = (await req('GET', '/__state')).runSeq;
  const r = spawnSync(process.execPath, [path.join(T, 'company', 'tools', 'onboard.js'), '--step', 'kickoff', '--json'], { cwd: T, env: env(), encoding: 'utf8', timeout: 60000 });
  assert.ok(/not fired now, the company is paused for a station restart/.test(r.stdout), r.stdout + r.stderr);
  assert.ok(/turn the charter into the first plan/.test(fs.readFileSync(path.join(T, 'company/work/handoffs/to-founder.md'), 'utf8')));
  assert.strictEqual((await req('GET', '/__state')).runSeq, before, 'no routine was fired');
  fs.unlinkSync(path.join(T, HOLD));
});

test('duty board: a duty gone stale under an active hold is paused with the hold\'s words; liveness-only duties and no hold stay stale', () => {
  W('company/state/duties.json', { duties: { 'tool-parse': { lastRun: iso(Date.now() - 300 * 60e3), lastResult: 'ok' }, 'liveness-watcher': { lastRun: iso(Date.now() - 300 * 60e3), lastResult: 'ok' } } });
  W('company/state/modules.json', { enabled: { liveness: true } });
  const view = () => snippet("const v = require('./company/tools/lib/duty-runner').view(); console.log(JSON.stringify(v.duties.map(d => ({ id: d.id, state: d.state, reason: d.reason }))))");
  hold();
  let { j, out } = view();
  const by = id => (j || []).find(d => d.id === id) || {};
  assert.strictEqual(by('tool-parse').state, 'paused', out);
  assert.ok(/^paused for a station restart \(since/.test(by('tool-parse').reason), out);
  assert.strictEqual(by('handoff-status').state, 'paused', 'never run under the hold: paused too');
  assert.strictEqual(by('liveness-watcher').state, 'stale', 'a whileHalted duty runs under the hold, so stale is real');
  fs.unlinkSync(path.join(T, HOLD));
  ({ j, out } = view());
  assert.strictEqual(by('tool-parse').state, 'stale', out);
});

test('liveness heartbeat during a hold says paused, not halted by anyone', () => {
  hold();
  let { j, out } = snippet("require('./modules/liveness/watch.js').beat({ halted: 'soft' }).then(() => console.log(JSON.stringify(require('./modules/liveness/watch.js').status().heartbeat)))");
  assert.ok(j && /^paused for a station restart/.test(j.paused), out);
  fs.unlinkSync(path.join(T, HOLD));
  ({ j, out } = snippet("require('./modules/liveness/watch.js').beat({}).then(() => console.log(JSON.stringify(require('./modules/liveness/watch.js').status().heartbeat)))"));
  assert.ok(j && j.paused === null, out);
});
