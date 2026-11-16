#!/usr/bin/env node
/* watch.js — the liveness module's dead-man's switch: is the dispatcher still beating? (docs/CORE-MODULES.md)
 *
 * Two processes watch each other, and neither is the station:
 *   - the dispatcher (modules/liveness/tick.js, every tick, also while halted) writes company/state/heartbeat.json and
 *     checks this watcher's heartbeat (company/state/liveness-watch.json);
 *   - this file, run by its own systemd user timer (systemd/capheos-liveness.{service,timer}.in, installed by
 *     scripts/setup-station.sh), checks heartbeat.json and writes liveness-watch.json.
 * A heartbeat older than 3 dispatcher ticks (company/work/ops/cadence.json dispatcherTickMin, default 10) is an outage:
 * the owner is told once (owner-inbox send) and, when secrets/liveness-ping-url exists, that URL is called through the
 * external gate (category network: its host must be on company/state/external-allowlist.txt, else the push is
 * refused and logged, never sent around the gate). Recovery is told once too.
 *
 *   node modules/liveness/watch.js            one check (the timer runs this); exit 0 when the module is not enabled
 *   node modules/liveness/watch.js status     both heartbeats and their ages, JSON
 *   node modules/liveness/watch.js ping       a test alert: owner message + push (onboard.js certification "pinged once")
 *   node modules/liveness/watch.js --selftest
 * Env: LIVENESS_WATCH_MIN (the watcher timer interval, default 5), LIVENESS_NOW (ms, tests).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('../../company/tools/lib/company');

const F = {
  beat: () => co.p('company', 'state', 'heartbeat.json'),
  watch: () => co.p('company', 'state', 'liveness-watch.json'),
  modules: () => co.p('company', 'state', 'modules.json'),
  cadence: () => co.p('company', 'work', 'ops', 'cadence.json'),
  cadenceDefault: () => co.p('company', 'defaults', 'work', 'ops', 'cadence.json'),
  log: () => co.p('company', 'work', 'liveness', 'alerts.jsonl'),
};
const now = () => Number(process.env.LIVENESS_NOW) || Date.now();
const iso = ms => new Date(ms).toISOString();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); };

function enabled() { return !!((readJson(F.modules(), {}) || {}).enabled || {}).liveness; }
function tickMin() {
  for (const f of [F.cadence(), F.cadenceDefault()]) { const n = Number((readJson(f, {}) || {}).dispatcherTickMin); if (Number.isFinite(n) && n > 0) return n; }
  return 10;
}
function watchMin() { const n = Number(process.env.LIVENESS_WATCH_MIN); return Number.isFinite(n) && n > 0 ? n : 5; }
const ageMs = rec => rec && rec.at && Date.parse(rec.at) ? now() - Date.parse(rec.at) : null;

function note(row) { try { fs.mkdirSync(path.dirname(F.log()), { recursive: true }); fs.appendFileSync(F.log(), JSON.stringify(Object.assign({ at: iso(now()) }, row)) + '\n'); } catch (_) {} }
function tellOwner(text) {
  try { require(co.p('company', 'tools', 'owner-inbox.js')).send({ from: 'liveness', text }); return true; } catch (e) { return 'owner channel failed: ' + e.message; }
}
/* optional push: secrets/liveness-ping-url, only through external-gate (category network) */
function push(text) {
  const url = co.secret('liveness-ping-url');
  if (!url) return Promise.resolve({ sent: false, why: 'no secrets/liveness-ping-url' });
  let gate; try { gate = require(co.p('company', 'tools', 'external-gate.js')); } catch (e) { return Promise.resolve({ sent: false, why: 'external-gate.js missing (fail closed)' }); }
  let v; try { v = gate.check({ category: 'network', target: url, agent: 'liveness' }); } catch (e) { v = { allow: false, reason: e.message }; }
  if (!v || !v.allow) return Promise.resolve({ sent: false, why: 'external gate refused: ' + ((v && v.reason) || 'no verdict') });
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { resolve({ sent: false, why: 'bad url' }); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify({ text, company: co.config.name || null, at: iso(now()) });
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); resolve({ sent: res.statusCode < 400, status: res.statusCode }); });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ sent: false, why: e.message }));
    req.end(body);
  });
}
async function alert(kind, text) {
  const told = tellOwner(text);
  const p = await push(text);
  note({ kind, text, told, push: p });
  return { told, push: p };
}

/* one judgement shared by both sides: is the other side's heartbeat stale? state = { down: bool, since, alertedAt } */
async function judge({ rec, limitMs, label, st, kind }) {
  const age = ageMs(rec);
  const stale = age === null || age > limitMs;
  const out = { label, ageMin: age === null ? null : Math.round(age / 6000) / 10, limitMin: limitMs / 60000, stale };
  if (stale && !st.down) {
    st.down = true; st.since = iso(now());
    const r = await alert(kind + '-down', 'Liveness: the ' + label + ' has not checked in ' + (age === null ? '(no heartbeat on record)' : 'for ' + out.ageMin + ' min') + ' (limit ' + out.limitMin + ' min). ' + (kind === 'dispatcher' ? 'Nothing is being woken. Check the dispatcher timer: systemctl --user status <station>-dispatch.timer' : 'The dead-man\'s switch is not watching. Check: systemctl --user status <station>-liveness.timer'));
    st.alertedAt = iso(now()); out.alerted = r;
  } else if (!stale && st.down) {
    await alert(kind + '-up', 'Liveness: the ' + label + ' is checking in again (it was down since ' + st.since + ').');
    st.down = false; st.recoveredAt = iso(now()); out.recovered = true;
  }
  return out;
}

/* the watcher side (systemd timer) */
async function check() {
  if (!enabled()) return { ok: true, skipped: 'liveness module not enabled' };
  const w = readJson(F.watch(), {}) || {};
  w.dispatcher = w.dispatcher || {};
  const res = await judge({ rec: readJson(F.beat(), null), limitMs: 3 * tickMin() * 60000, label: 'dispatcher', st: w.dispatcher, kind: 'dispatcher' });
  w.at = iso(now()); w.pid = process.pid; w.everyMin = watchMin(); w.checks = (w.checks || 0) + 1;
  writeJson(F.watch(), w);
  return Object.assign({ ok: !res.stale }, res);
}
/* the dispatcher side (tick.js) */
async function beat({ dry, halted } = {}) {
  const b = readJson(F.beat(), {}) || {};
  b.watcher = b.watcher || {};
  const w = readJson(F.watch(), null);
  // the watcher gets a grace period after the dispatcher's first beat, so a fresh enable does not page the owner
  const first = b.firstAt ? Date.parse(b.firstAt) : now();
  const limit = 3 * watchMin() * 60000;
  let res = { label: 'watcher', stale: false, grace: true };
  if (now() - first > limit || w) res = dry ? { label: 'watcher', dry: true } : await judge({ rec: w, limitMs: Math.max(limit, 3 * tickMin() * 60000), label: 'liveness watcher', st: b.watcher, kind: 'watcher' });
  if (dry) return res;
  b.firstAt = b.firstAt || iso(now()); b.at = iso(now()); b.pid = process.pid; b.ticks = (b.ticks || 0) + 1; b.halted = halted || false; b.tickMin = tickMin();
  writeJson(F.beat(), b);
  return res;
}
async function ping() {
  const r = await alert('ping', 'Liveness test ping from ' + (co.config.name || 'the company') + ': if you can read this, the dead-man\'s switch can reach you.');
  const w = readJson(F.watch(), {}) || {};
  w.pingedAt = iso(now()); w.ping = { told: r.told === true, push: r.push };
  writeJson(F.watch(), w);
  return Object.assign({ ok: r.told === true }, r);
}
function status() {
  const b = readJson(F.beat(), null), w = readJson(F.watch(), null);
  const a = ageMs(b), aw = ageMs(w);
  return { ok: true, enabled: enabled(), tickMin: tickMin(), watchMin: watchMin(), heartbeat: b, heartbeatAgeMin: a === null ? null : Math.round(a / 6000) / 10,
    watcher: w, watcherAgeMin: aw === null ? null : Math.round(aw / 6000) / 10, pingedAt: (w && w.pingedAt) || null, dispatcherStale: a === null || a > 3 * tickMin() * 60000 };
}

async function selftest() {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-selftest-'));
  let fails = 0, n = 0;
  const t = (name, ok, x) => { n++; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || x === undefined ? '' : ' :: ' + String(x).slice(0, 500))); };
  try {
    for (const d of ['company/tools/lib', 'company/state', 'company/owner', 'company/work/ops', 'modules/liveness', 'secrets']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'company', 'tools', 'lib', 'company.js'), path.join(tmp, 'company', 'tools', 'lib', 'company.js'));
    fs.copyFileSync(__filename, path.join(tmp, 'modules', 'liveness', 'watch.js'));
    fs.copyFileSync(path.join(__dirname, 'tick.js'), path.join(tmp, 'modules', 'liveness', 'tick.js'));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify({from,text})+'\\n');return {id:'x'};}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>({allow:false,reason:'not on the allowlist: '+target})};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC' }));
    fs.writeFileSync(path.join(tmp, 'company', 'work', 'ops', 'cadence.json'), JSON.stringify({ dispatcherTickMin: 10 }));
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-ping-url'), 'https://push.example.invalid/hook\n', { mode: 0o600 });
    const T0 = Date.parse('2030-01-01T00:00:00Z');
    const run = (at, ...a) => { const r = spawnSync(process.execPath, [path.join(tmp, 'modules', 'liveness', 'watch.js'), ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at) }) }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {} return { code: r.status, j, out: r.stdout + r.stderr }; };
    const tick = (at, halted) => spawnSync(process.execPath, ['-e', "require(process.argv[1]).tick({log:console.log,halted:process.argv[2]==='1'?'soft':false}).then(r=>console.log(JSON.stringify(r)))", path.join(tmp, 'modules', 'liveness', 'tick.js'), halted ? '1' : '0'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at) }) });
    const outbound = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8'); } catch (_) { return ''; } };
    let r = run(T0);
    t('not enabled: the watcher does nothing, exit 0', r.code === 0 && r.j.skipped && !fs.existsSync(path.join(tmp, 'company', 'state', 'liveness-watch.json')), r.out);
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: { liveness: { at: 'x' } } }));
    const tk = tick(T0, true);
    t('the dispatcher tick writes heartbeat.json, also while halted', readJson(path.join(tmp, 'company', 'state', 'heartbeat.json'), {}).halted === 'soft', tk.stdout + tk.stderr);
    t('tick.js runs while halted', require(path.join(tmp, 'modules', 'liveness', 'tick.js')).runWhenHalted === true);
    r = run(T0 + 5 * 60000);
    t('fresh heartbeat: the watcher is quiet', r.code === 0 && r.j.ok && !outbound(), r.out);
    r = run(T0 + 31 * 60000);
    t('heartbeat older than 3 ticks: the owner is told once', r.code === 1 && /dispatcher has not checked in/.test(outbound()), r.out + outbound());
    t('the push without an allowlisted host is refused by the gate and logged', /external gate refused/.test(fs.readFileSync(path.join(tmp, 'company', 'work', 'liveness', 'alerts.jsonl'), 'utf8')));
    run(T0 + 36 * 60000);
    t('no second alert for the same outage', outbound().split('\n').filter(l => /not checked in/.test(l)).length === 1, outbound());
    tick(T0 + 37 * 60000);
    run(T0 + 38 * 60000);
    t('recovery is told once', /checking in again/.test(outbound()), outbound());
    fs.rmSync(path.join(tmp, 'company', 'state', 'liveness-watch.json'));
    fs.writeFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), '');
    tick(T0 + 60 * 60000);
    t('the dispatcher notices a missing watcher heartbeat (each watches the other)', /liveness watcher has not checked in/.test(outbound()), outbound());
    r = run(T0 + 61 * 60000, 'ping');
    t('ping reaches the owner and records pingedAt', r.code === 0 && /test ping/.test(outbound()) && readJson(path.join(tmp, 'company', 'state', 'liveness-watch.json'), {}).pingedAt, r.out);
    r = run(T0 + 61 * 60000, 'status');
    t('status reports both heartbeats', r.j && r.j.heartbeat && r.j.watcher && r.j.enabled === true, r.out);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { check, beat, ping, status, tickMin, watchMin, enabled, F };
if (require.main === module) {
  const a = process.argv.slice(2);
  (async () => {
    if (a.includes('--selftest') || a[0] === 'selftest') process.exit(await selftest());
    const cmd = a[0] || 'check';
    const r = cmd === 'status' ? status() : cmd === 'ping' ? await ping() : cmd === 'check' ? await check() : null;
    if (!r) { console.error('usage: watch.js [check|status|ping|--selftest]'); process.exit(2); }
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error('liveness: ' + e.message); process.exit(1); });
}
