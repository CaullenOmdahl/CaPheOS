'use strict';
// restart-station.test.js — scripts/restart-station.sh against the mock station (tests/mock-station.js): it waits while a
// run is in flight (a run that writes no log at all), holds new starts meanwhile, restarts only when idle, releases the
// hold, and gives up cleanly without stopping anything. The "restart" is the mock's POST /__restart, which records what
// was in flight at that moment.
//   node --test company/tools/tests/restart-station.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-station-selftest-'));
const TOKEN = 'restart-test-token';
const W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
W('company/company.json', JSON.stringify({ name: 'Test Co', slug: 'testco', timezone: 'UTC', owner: { name: 'Olive' }, station: { serviceName: 'testco-station' } }));
W('company/tools/loops.json', JSON.stringify({ agents: { founder: { name: 'Founder', functions: ['ceo', 'people', 'tools', 'risk', 'finance'], manager: null, inbox: 'to-founder.md' }, halima: { name: 'Halima', manager: 'founder', inbox: 'to-halima.md' } } }));
process.env.CAPHEOS_ROOT = T;   // for the in-process co.restartHold() checks below

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
const state = () => req('GET', '/__state');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return; await sleep(50); } throw new Error('timed out waiting for ' + what); }

// the restart command the script runs instead of systemctl: the mock's POST /__restart
const RESTART_JS = W('scratch/restart.js', 'const http=require("http");const r=http.request({hostname:"127.0.0.1",port:Number(process.argv[2]),path:"/__restart",method:"POST",headers:{"x-starnet-token":' + JSON.stringify(TOKEN) + '}},res=>{res.resume();res.on("end",()=>process.exit(res.statusCode===200?0:1))});r.on("error",()=>process.exit(1));r.end();\n');
function script(args) {
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + PORT, CAPHEOS_SECRET_STATION_TOKEN: TOKEN,
    RESTART_POLL_SEC: '0.15', RESTART_HEALTH_SEC: '10', RESTART_MINUTE_MS: '1000', RESTART_STATION_CMD: process.execPath + ' ' + RESTART_JS + ' ' + PORT });
  const ch = spawn('bash', [path.join(REPO, 'scripts', 'restart-station.sh')].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { out += d; });
  const done = new Promise(resolve => ch.on('exit', code => resolve({ code, out })));
  return { ch, done, out: () => out };
}
const co = () => { delete require.cache[require.resolve('../lib/company')]; return require('../lib/company'); };

test.before(async () => {
  mock = spawn(process.execPath, [path.join(REPO, 'tests', 'mock-station.js'), '--port', '0', '--token', TOKEN, '--restart-down-ms', '400'], { stdio: ['ignore', 'pipe', 'inherit'] });
  PORT = await new Promise((resolve, reject) => { mock.stdout.once('data', d => { try { resolve(JSON.parse(String(d).split('\n')[0]).port); } catch (e) { reject(e); } }); mock.once('exit', c => reject(new Error('mock exited ' + c))); });
  await req('POST', '/api/cron', { name: 'Founder loop', agentId: 'founder', prompt: 'x', schedule: 'every 30 minutes' });
  await req('POST', '/api/cron/arm', { enabled: true });
});
test.after(() => { try { mock.kill(); } catch (_) {} try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} });

test('waits while a run is in flight, holds new starts, restarts once idle, releases the hold, says so', async () => {
  const live = await req('POST', '/__live', { agentId: 'halima', ageSec: 1500 });   // 25 min in, writing nothing anywhere
  const s = script(['--when-idle', '--max-wait-min', '60', '--reason', 'patch 0013', '--by', 'Olive']);
  await until(() => fs.existsSync(path.join(T, 'company/state/restart-hold.json')), 5000, 'the hold');
  await sleep(1200);   // ~8 polls with the run in flight
  let st = await state();
  assert.strictEqual(st.restarts.length, 0, 'no restart while the run is in flight');
  assert.strictEqual(st.cron.enabled, false, 'the scheduler is disarmed while it waits');
  assert.strictEqual(co().startsHeld(), 'restart', 'the dispatcher and hiring see the hold');
  assert.ok(/RESTART HOLD by Olive/.test(R('company/work/dispatch-log.md')), R('company/work/dispatch-log.md'));
  assert.ok(/waiting: Halima/.test(s.out()), s.out());
  await req('POST', '/__live/end', { runId: live.run.runId });   // the run finishes on its own
  const r = await s.done;
  assert.strictEqual(r.code, 0, r.out);
  st = await state();
  assert.strictEqual(st.restarts.length, 1, r.out);
  assert.deepStrictEqual(st.restarts[0].inFlight, [], 'nothing was in flight at the restart');
  assert.strictEqual(st.cron.enabled, true, 'the scheduler is re-armed');
  assert.ok(!fs.existsSync(path.join(T, 'company/state/restart-hold.json')), 'the hold is released');
  assert.strictEqual(co().startsHeld(), false);
  assert.ok(/Station restarted to load patch 0013 at \d\d:\d\d; no run was interrupted after waiting \d+ min for 1 run\(s\) to finish/.test(R('company/work/dispatch-log.md')), R('company/work/dispatch-log.md'));
  assert.ok(/Station restarted to load patch 0013 at \d\d:\d\d; no run was interrupted/.test(R('company/owner/outbound.jsonl')), R('company/owner/outbound.jsonl'));
});

test('a routine lease the run table does not show also holds it', async () => {
  await req('POST', '/__hold', { names: ['Founder loop'] });
  const st0 = await state(); await req('POST', '/api/cron/run', { id: st0.cron.jobs[0].id });
  const s = script(['--when-idle', '--max-wait-min', '60', '--reason', 'patch 0014']);
  await sleep(1000);
  assert.strictEqual((await state()).restarts.length, 1, 'still only the first restart');
  await req('POST', '/__finish', { name: 'Founder loop' }); await req('POST', '/__hold', { names: [] });
  const r = await s.done; assert.strictEqual(r.code, 0, r.out);
  const st = await state(); assert.strictEqual(st.restarts.length, 2); assert.deepStrictEqual(st.restarts[1].inFlight, []);
});

test('without --when-idle a busy station is not restarted, and nothing is held', async () => {
  const live = await req('POST', '/__live', { agentId: 'founder' });
  const r = await script(['--reason', 'patch 0015']).done;
  assert.strictEqual(r.code, 1, r.out); assert.ok(/not restarted: in flight: Founder/.test(r.out), r.out);
  assert.strictEqual((await state()).restarts.length, 2);
  assert.ok(!fs.existsSync(path.join(T, 'company/state/restart-hold.json')));
  await req('POST', '/__live/end', { runId: live.run.runId });
});

test('a second restart while one is waiting is refused', async () => {
  const live = await req('POST', '/__live', { agentId: 'founder' });
  const first = script(['--when-idle', '--max-wait-min', '60', '--reason', 'patch A']);
  await until(() => fs.existsSync(path.join(T, 'company/state/restart-hold.json')), 5000, 'the hold');
  const second = await script(['--when-idle', '--reason', 'patch B']).done;
  assert.strictEqual(second.code, 2, second.out); assert.ok(/another restart is already waiting/.test(second.out), second.out);
  await req('POST', '/__live/end', { runId: live.run.runId });
  assert.strictEqual((await first.done).code, 0);
});

test('--max-wait-min: gives up, releases the hold, re-arms, and never stops the run', async () => {
  const before = (await state()).restarts.length;
  const live = await req('POST', '/__live', { agentId: 'founder', ageSec: 1620 });
  const r = await script(['--when-idle', '--max-wait-min', '2', '--reason', 'patch 0016']).done;   // a "minute" is 1 s here
  assert.strictEqual(r.code, 3, r.out);
  const st = await state();
  assert.strictEqual(st.restarts.length, before, 'not restarted');
  assert.ok(st.live.some(x => x.runId === live.run.runId), 'the run is still running');
  assert.strictEqual(st.cron.enabled, true, 'the scheduler is re-armed');
  assert.ok(!fs.existsSync(path.join(T, 'company/state/restart-hold.json')), 'the hold is released');
  assert.ok(/RESTART GAVE UP after 2 min \(patch 0016\): still in flight: Founder/.test(R('company/work/dispatch-log.md')), R('company/work/dispatch-log.md'));
  assert.ok(/did not restart the station to load patch 0016/.test(R('company/owner/outbound.jsonl')));
  await req('POST', '/__live/end', { runId: live.run.runId });
});

test('the hold has its own cap: lifted while a long run goes on so the crew works, held again and restarted once idle by itself', async () => {
  const before = (await state()).restarts.length;
  const HOLD = path.join(T, 'company/state/restart-hold.json');
  const live = await req('POST', '/__live', { agentId: 'halima', ageSec: 2520 });   // 42 min in, sleeping for market boundaries
  const s = script(['--when-idle', '--max-wait-min', '60', '--hold-max-min', '1', '--reason', 'patch 0017', '--by', 'Olive']);   // a "minute" is 1 s here
  await until(() => co().startsHeld() === 'restart', 5000, 'the hold');
  assert.strictEqual((await state()).cron.enabled, false, 'held: the scheduler is disarmed');
  await until(() => /RESTART WAITING \(patch 0017\): Waiting for Halima's run to end; the crew keeps working meanwhile/.test(R('company/work/dispatch-log.md')), 8000, 'the hold lifted after its cap');
  assert.strictEqual(co().startsHeld(), false, 'lifted: the dispatcher and hiring may start work again');
  assert.strictEqual((await state()).cron.enabled, true, 'lifted: the scheduler is re-armed');
  const rec = JSON.parse(fs.readFileSync(HOLD, 'utf8'));
  assert.strictEqual(rec.watching, true, 'the record stays, marked watching'); assert.strictEqual(co().restartHold(), null);
  assert.ok(/Waiting for Halima's run to end before restarting the station to load patch 0017; the crew keeps working meanwhile/.test(R('company/owner/outbound.jsonl')), R('company/owner/outbound.jsonl'));
  // the crew works meanwhile: a new run starts, and the restart waits for it too
  const other = await req('POST', '/__live', { agentId: 'founder' });
  // a second restart is still refused while the first one watches
  const second = await script(['--when-idle', '--reason', 'patch X']).done;
  assert.strictEqual(second.code, 2, second.out); assert.ok(/another restart is already waiting/.test(second.out), second.out);
  await req('POST', '/__live/end', { runId: live.run.runId });
  await sleep(1000);
  assert.strictEqual((await state()).restarts.length, before, 'not restarted while the crew\'s new run is in flight');
  assert.strictEqual(co().startsHeld(), false, 'and not held for it either');
  await req('POST', '/__live/end', { runId: other.run.runId });
  const r = await s.done;
  assert.strictEqual(r.code, 0, r.out);
  const st = await state();
  assert.strictEqual(st.restarts.length, before + 1, r.out);
  assert.deepStrictEqual(st.restarts[st.restarts.length - 1].inFlight, [], 'nothing was in flight at the restart');
  assert.ok(/RESTART HOLD again by Olive: the station is idle by itself/.test(R('company/work/dispatch-log.md')), R('company/work/dispatch-log.md'));
  assert.ok(/holding new starts again/.test(r.out), r.out);
  assert.strictEqual(st.cron.enabled, true, 'the scheduler is re-armed after the restart');
  assert.ok(!fs.existsSync(HOLD), 'the hold record is gone');
  assert.strictEqual((R('company/owner/outbound.jsonl').match(/Waiting for Halima's run to end/g) || []).length, 1, 'the owner is told once');
});

test('a hold whose script died expires by itself; --release drops it at once', async () => {
  W('company/state/restart-hold.json', JSON.stringify({ by: 'x', pid: 999999999, at: new Date(Date.now() - 3 * 3600e3).toISOString(), expiresAt: new Date(Date.now() - 60e3).toISOString() }));
  assert.strictEqual(co().restartHold(), null, 'expired: holds nothing');
  W('company/state/restart-hold.json', JSON.stringify({ by: 'x', pid: 999999999, at: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600e3).toISOString(), disarmed: false }));
  assert.strictEqual(co().startsHeld(), 'restart');
  const r = await script(['--release', '--by', 'Olive']).done;
  assert.strictEqual(r.code, 0, r.out); assert.strictEqual(co().startsHeld(), false);
});

test('the hold stays until every provider that was ready before the restart is ready again (Claude checks its sign-in at boot)', async () => {
  await req('POST', '/__providers', { 'claude-cli': true, deepseek: true });
  await req('POST', '/__boot-settle', { 'claude-cli': 1500 });
  const HOLD = path.join(T, 'company/state/restart-hold.json');
  const s = script(['--when-idle', '--max-wait-min', '5', '--reason', 'a settle test', '--by', 'Olive']);
  // at no point while Claude still reads "checking local sign-in" after the restart is the hold gone
  let settling = 0, releasedEarly = 0, finishedAt = 0; s.done.then(() => { finishedAt = Date.now(); });
  while (!finishedAt || Date.now() - finishedAt < 2500) {   // and a while after the script ended
    const pv = await req('GET', '/api/providers');
    const c = pv && pv.providers && pv.providers.find(p => p.id === 'claude-cli');
    if (c && c.reason === 'checking local sign-in') { settling++; if (!fs.existsSync(HOLD)) releasedEarly++; }
    await sleep(40);
  }
  assert.ok(settling > 0, 'the provider was seen settling after the restart');
  assert.strictEqual(releasedEarly, 0, 'the hold was released while Claude was still checking its sign-in');
  const r = await s.done;
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/providers ready again: claude-cli, deepseek/.test(r.out), r.out);
  assert.ok(!fs.existsSync(HOLD), 'released once ready');
  await req('POST', '/__boot-settle', {});
});
