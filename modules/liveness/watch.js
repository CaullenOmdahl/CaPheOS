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
 * Off-box heartbeat (a dead-man check such as a cron-monitoring service, which alerts when pings STOP): put its URL in
 * secrets/liveness-heartbeat-url. Every healthy check GETs it through the same gate; an outage sends nothing to it, so
 * the silence is the alarm, and a dead machine (which sends nothing at all) is caught too. Failing to reach it never
 * fails the check: the reason goes to the log. An outage alert POSTed to a dead-man check would read as "alive", so
 * when liveness-ping-url holds the same URL the outage push is not sent to it (logged "reported by silence"): nothing
 * needs removing. liveness-ping-url is for a separate alert endpoint; `status` shows pingEqualsHeartbeat.
 * The owner tests that alarm from Settings › System (alarm-test.js): a pause flag
 * (company/state/liveness-heartbeat-pause.json) stops only the heartbeat unit's ping, which ends it at its own deadline.
 *
 *   node modules/liveness/watch.js            one check (the timer runs this); exit 0 when the module is not enabled
 *   node modules/liveness/watch.js heartbeat  the off-box heartbeat ping (its OWN timer, <station>-liveness-heartbeat.timer)
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
  hb: () => co.p('company', 'state', 'liveness-heartbeat.json'),
};
const now = () => Number(process.env.LIVENESS_NOW) || Date.now();
const iso = ms => new Date(ms).toISOString();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); };

function enabled() { return !!((readJson(F.modules(), {}) || {}).enabled || {}).liveness; }
// the base tick, or the dispatcher loop's effective tick (company/state/dispatcher-loop.json) when that is longer: a
// slow-down inside the owner's bounds must not read as an outage
function tickMin() {
  let base = 10;
  for (const f of [F.cadence(), F.cadenceDefault()]) { const n = Number((readJson(f, {}) || {}).dispatcherTickMin); if (Number.isFinite(n) && n > 0) { base = n; break; } }
  const lp = readJson(co.p('company', 'state', 'dispatcher-loop.json'), null);
  const eff = Number(lp && lp.tempo && lp.tempo.tickMin);
  return Number.isFinite(eff) && eff > base ? eff : base;
}
function watchMin() { const n = Number(process.env.LIVENESS_WATCH_MIN); return Number.isFinite(n) && n > 0 ? n : 5; }
const ageMs = rec => rec && rec.at && Date.parse(rec.at) ? now() - Date.parse(rec.at) : null;

function note(row) { try { fs.mkdirSync(path.dirname(F.log()), { recursive: true }); fs.appendFileSync(F.log(), JSON.stringify(Object.assign({ at: iso(now()) }, row)) + '\n'); } catch (_) {} }
function tellOwner(text, technical) {
  // urgent (lib/owner-notice.js): the company may have stopped; a tree without it falls back to the low-level writer
  const notice = co.p('company', 'tools', 'lib', 'owner-notice.js');
  try { if (fs.existsSync(notice)) require(notice).send({ kind: 'urgent', from: 'The alarm', text, technical, priority: 'top' }); else require(co.p('company', 'tools', 'owner-inbox.js')).send({ from: 'liveness', text: text + (technical ? '\n' + technical : '') }); return true; } catch (e) { return 'owner channel failed: ' + e.message; }
}
/* the owner's lines: what it means for them and what happens next, in plain words (no console control starts these
 * units, and the owner has nobody to hand it to); the unit names and commands are `technical` */
function downNotice(kind, ageMin) {
  return kind === 'dispatcher' ? 'The crew\'s work has stopped: nothing new has started' + (ageMin == null ? '' : ' for ' + Math.round(ageMin) + ' minutes') + ', so no one is woken. You will get a message here as soon as the work starts again.'
    : 'The alarm that tells you when the company stops is not being checked right now, so a stop might not reach you. You will get a message here when it is checked again.';
}
const upNotice = kind => kind === 'dispatcher' ? 'The crew\'s work is running again after a stop.' : 'The alarm that tells you when the company stops is being checked again.';
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
/* the off-box heartbeat: a GET on the healthy path (secrets/liveness-heartbeat-url), through the gate; never throws */
function heartbeat() {
  const url = co.secret('liveness-heartbeat-url');
  if (!url) return Promise.resolve({ sent: false, why: 'no secrets/liveness-heartbeat-url' });
  let gate; try { gate = require(co.p('company', 'tools', 'external-gate.js')); } catch (e) { return Promise.resolve({ sent: false, why: 'external-gate.js missing (fail closed)' }); }
  let v; try { v = gate.check({ category: 'network', target: url, agent: 'liveness' }); } catch (e) { v = { allow: false, reason: e.message }; }
  if (!v || !v.allow) return Promise.resolve({ sent: false, why: 'external gate refused: ' + ((v && v.reason) || 'no verdict') });
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { resolve({ sent: false, why: 'bad url' }); return; }
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(u, { method: 'GET' }, res => { res.resume(); resolve({ sent: res.statusCode < 400, status: res.statusCode }); });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ sent: false, why: e.message }));
    req.end();
  });
}
async function alert(kind, text, technical) {
  const told = tellOwner(text, technical);
  // the outage push never goes to a dead-man heartbeat URL: a POST there would mark the check alive during the outage
  const same = (co.secret('liveness-ping-url') || '').trim() && (co.secret('liveness-ping-url') || '').trim() === (co.secret('liveness-heartbeat-url') || '').trim();
  const p = same ? { sent: false, why: 'liveness-ping-url is the heartbeat URL: an outage is reported by silence there, not by a push' } : await push(text);
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
    const r = await alert(kind + '-down', downNotice(kind, out.ageMin), 'Liveness: the ' + label + ' has not checked in ' + (age === null ? '(no heartbeat on record)' : 'for ' + out.ageMin + ' min') + ' (limit ' + out.limitMin + ' min). ' + (kind === 'dispatcher' ? 'Nothing is being woken. Check the dispatcher loop: systemctl --user status <station>-dispatch.service' : 'The dead-man\'s switch is not watching. Check: systemctl --user status <station>-liveness.timer'));
    st.alertedAt = iso(now()); out.alerted = r;
  } else if (!stale && st.down) {
    await alert(kind + '-up', upNotice(kind), 'Liveness: the ' + label + ' is checking in again (it was down since ' + st.since + ').');
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
  // the off-box heartbeat is its own unit (<station>-liveness-heartbeat.timer, `watch.js heartbeat`), so an outside-alarm
  // test that pauses the ping never touches this check. Until that unit runs (a company set up before the split), this
  // check still pings, as before (legacy fallback; scripts/setup-station.sh installs and starts the unit).
  if (!heartbeatUnitAlive() && !res.stale) { const r = await pingOnce(); res.heartbeat = r.hb; if (r.alarmTest) res.alarmTest = r.alarmTest; res.heartbeatBy = 'watcher (fallback: the heartbeat unit is not running)'; }
  writeJson(F.watch(), w);
  return Object.assign({ ok: !res.stale }, res);
}
/* ---- the off-box heartbeat unit (`watch.js heartbeat`, its own systemd timer): company/state/liveness-heartbeat.json ----
 * Every run: end an outside-alarm test that is past its deadline (alarm-test.js expireIfDue: this timer is what ends it,
 * console or not), then GET the heartbeat URL unless a test still holds the pause or the dispatcher is silent (an outage
 * is told by silence there). It never judges the dispatcher and never alerts: that is check(), on its own timer. */
const heartbeatUnitAlive = () => { const a = ageMs(readJson(F.hb(), null)); return a !== null && a <= 3 * watchMin() * 60000; };
function recordPing(hb, st) {
  if (hb.sent) { st.heartbeatAt = iso(now()); st.heartbeatError = null; }
  else if (hb.why && hb.why !== 'no secrets/liveness-heartbeat-url' && st.heartbeatError !== hb.why) { st.heartbeatError = hb.why; note({ kind: 'heartbeat-failed', why: hb.why }); }
  else if (!hb.sent && hb.status && st.heartbeatError !== 'HTTP ' + hb.status) { st.heartbeatError = 'HTTP ' + hb.status; note({ kind: 'heartbeat-failed', why: st.heartbeatError }); }
}
async function pingOnce() {
  let at = null; try { at = require('./alarm-test.js').expireIfDue(); } catch (e) { at = { expired: false, error: e.code === 'MODULE_NOT_FOUND' ? undefined : e.message }; }
  const st = readJson(F.hb(), {}) || {};
  let hb;
  if (at && at.paused) { hb = { sent: false, paused: true, until: at.until }; st.pausedUntil = at.until; }
  else { st.pausedUntil = null; hb = await heartbeat(); recordPing(hb, st); }
  writeJson(F.hb(), Object.assign(st, { lastRunAt: iso(now()) }));
  return { hb, alarmTest: at && (at.expired || at.error) ? at : undefined };
}
async function heartbeatRun() {
  if (!enabled()) return { ok: true, skipped: 'liveness module not enabled' };
  const age = ageMs(readJson(F.beat(), null));
  const st = readJson(F.hb(), {}) || {};
  st.at = iso(now()); st.pid = process.pid; st.everyMin = watchMin(); st.runs = (st.runs || 0) + 1;
  writeJson(F.hb(), st);   // this unit is alive (check() stops its fallback ping)
  if (age === null || age > 3 * tickMin() * 60000) {
    let at = null; try { at = require('./alarm-test.js').expireIfDue(); } catch (_) {}
    return { ok: true, sent: false, why: 'the dispatcher is silent: no ping (the silence is the alarm)', alarmTest: at && at.expired ? at : undefined };
  }
  const r = await pingOnce();
  return Object.assign({ ok: true }, r.hb, r.alarmTest ? { alarmTest: r.alarmTest } : {});
}
/* one ping now (the owner ends an outside-alarm test), recorded like the unit's */
async function heartbeatNow() {
  const hb = await heartbeat();
  const st = readJson(F.hb(), {}) || {};
  recordPing(hb, st); st.pausedUntil = null;
  writeJson(F.hb(), st);
  return hb;
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
  // a restart hold beats as halted (nothing starts) but is not a halt: say so, so nobody reads it as one
  { const rh = co.halted() ? null : co.restartHold(); b.paused = rh ? co.restartHoldNote(rh) : null; }
  writeJson(F.beat(), b);
  return res;
}
async function ping() {
  const r = await alert('ping', 'This is a test from ' + (co.config.name || 'the company') + ': if you can read this, the company\'s alarm can reach you.');
  const w = readJson(F.watch(), {}) || {};
  w.pingedAt = iso(now()); w.ping = { told: r.told === true, push: r.push };
  writeJson(F.watch(), w);
  return Object.assign({ ok: r.told === true }, r);
}
function lastPingAt() {
  const w = readJson(F.watch(), {}) || {}, st = readJson(F.hb(), {}) || {};
  return [w.heartbeatAt, st.heartbeatAt].filter(x => x && Date.parse(x)).sort((x, y) => Date.parse(x) - Date.parse(y)).pop() || null;
}
function status() {
  const b = readJson(F.beat(), null), w0 = readJson(F.watch(), null), st = readJson(F.hb(), null);
  const a = ageMs(b), aw = ageMs(w0);
  // the heartbeat fields from the heartbeat unit's own file (the watcher's, from before the split, as fallback)
  const w = w0 ? Object.assign({}, w0, { heartbeatAt: lastPingAt(), heartbeatError: st ? st.heartbeatError || null : w0.heartbeatError, heartbeatPausedUntil: st ? st.pausedUntil || null : null }) : st ? { heartbeatAt: st.heartbeatAt, heartbeatError: st.heartbeatError, heartbeatPausedUntil: st.pausedUntil } : null;
  return { ok: true, enabled: enabled(), tickMin: tickMin(), watchMin: watchMin(), heartbeat: b, heartbeatAgeMin: a === null ? null : Math.round(a / 6000) / 10,
    watcher: w0, heartbeatUnit: st, heartbeatUnitAlive: heartbeatUnitAlive(), watcherAgeMin: aw === null ? null : Math.round(aw / 6000) / 10, pingedAt: (w && w.pingedAt) || null, heartbeatAt: (w && w.heartbeatAt) || null, heartbeatError: (w && w.heartbeatError) || null, heartbeatPausedUntil: (w && w.heartbeatPausedUntil) || null,
    pingEqualsHeartbeat: !!(co.secret('liveness-heartbeat-url') || '').trim() && (co.secret('liveness-heartbeat-url') || '').trim() === (co.secret('liveness-ping-url') || '').trim(), dispatcherStale: a === null || a > 3 * tickMin() * 60000 };
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
    fs.copyFileSync(path.join(__dirname, 'alarm-test.js'), path.join(tmp, 'modules', 'liveness', 'alarm-test.js'));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify({from,text})+'\\n');return {id:'x'};}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>({allow:false,reason:'not on the allowlist: '+target})};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC' }));
    fs.writeFileSync(path.join(tmp, 'company', 'work', 'ops', 'cadence.json'), JSON.stringify({ dispatcherTickMin: 10 }));
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-ping-url'), 'https://push.example.invalid/hook\n', { mode: 0o600 });
    const T0 = Date.parse('2030-01-01T00:00:00Z');
    const run = (at, ...a) => { const r = spawnSync(process.execPath, [path.join(tmp, 'modules', 'liveness', 'watch.js'), ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at) }) }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {} return { code: r.status, j, out: r.stdout + r.stderr }; };
    // async, so the local test endpoint in this process can answer while the watcher runs
    const runA = (at, ...a) => new Promise(resolve => { const ch = require('child_process').spawn(process.execPath, [path.join(tmp, 'modules', 'liveness', 'watch.js'), ...a], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at) }) }); let o = ''; ch.stdout.on('data', d => { o += d; }); ch.stderr.on('data', d => { o += d; }); ch.on('exit', code => { let j = null; try { j = JSON.parse(o); } catch (_) {} resolve({ code, j, out: o }); }); });
    const tick = (at, halted) => spawnSync(process.execPath, ['-e', "require(process.argv[1]).tick({log:console.log,halted:process.argv[2]==='1'?'soft':false}).then(r=>console.log(JSON.stringify(r)))", path.join(tmp, 'modules', 'liveness', 'tick.js'), halted ? '1' : '0'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at) }) });
    const outbound = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8'); } catch (_) { return ''; } };
    // a local dead-man endpoint that counts GETs (and POSTs, which it must never get)
    const hits = []; const srv = require('http').createServer((q, res) => { hits.push(q.method); res.end('OK'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const HB = 'http://127.0.0.1:' + srv.address().port + '/ping/abc';
    let r = run(T0);
    t('not enabled: the watcher does nothing, exit 0', r.code === 0 && r.j.skipped && !fs.existsSync(path.join(tmp, 'company', 'state', 'liveness-watch.json')), r.out);
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: { liveness: { at: 'x' } } }));
    const tk = tick(T0, true);
    t('the dispatcher tick writes heartbeat.json, also while halted', readJson(path.join(tmp, 'company', 'state', 'heartbeat.json'), {}).halted === 'soft', tk.stdout + tk.stderr);
    t('tick.js runs while halted', require(path.join(tmp, 'modules', 'liveness', 'tick.js')).runWhenHalted === true);
    r = run(T0 + 5 * 60000);
    t('fresh heartbeat: the watcher is quiet', r.code === 0 && r.j.ok && !outbound(), r.out);
    // the off-box heartbeat: gate refuses -> logged, check still passes; gate allows -> one GET per healthy check
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-heartbeat-url'), HB + '\n', { mode: 0o600 });
    r = await runA(T0 + 6 * 60000);
    t('heartbeat refused by the gate: the check still passes, the reason is logged once', r.code === 0 && r.j.ok && hits.length === 0 && /heartbeat-failed/.test(fs.readFileSync(path.join(tmp, 'company', 'work', 'liveness', 'alerts.jsonl'), 'utf8')), r.out);
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>target.startsWith('http://127.0.0.1')?{allow:true}:({allow:false,reason:'not on the allowlist: '+target})};\n");
    r = await runA(T0 + 7 * 60000);
    t('healthy check, no heartbeat unit yet (a company set up before the split): the watcher still pings, once', r.code === 0 && hits.join() === 'GET' && readJson(path.join(tmp, 'company', 'state', 'liveness-heartbeat.json'), {}).heartbeatAt && r.j.heartbeatBy, r.out + hits.join());
    // the split: the heartbeat unit pings on its own timer, and the watcher's check stops pinging
    r = await runA(T0 + 7 * 60000 + 30000, 'heartbeat');
    t('heartbeat unit: one GET of its own', r.code === 0 && r.j.sent === true && hits.join() === 'GET,GET', r.out + hits.join());
    r = await runA(T0 + 8 * 60000);
    t('with the heartbeat unit running, the watcher check judges the dispatcher and sends no ping', r.code === 0 && r.j.ok && !r.j.heartbeat && hits.join() === 'GET,GET', r.out + hits.join());
    hits.length = 1;
    // an outage: nothing goes to the heartbeat URL (silence is the alarm), even when the ping URL is the same address
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-ping-url'), HB + '\n', { mode: 0o600 });
    r = await runA(T0 + 31 * 60000);
    t('outage: no GET and no POST to the heartbeat URL (an outage push to the same address is not sent)', hits.join() === 'GET' && /reported by silence/.test(fs.readFileSync(path.join(tmp, 'company', 'work', 'liveness', 'alerts.jsonl'), 'utf8')), hits.join());
    const rh = await runA(T0 + 31 * 60000 + 30000, 'heartbeat');
    t('outage: the heartbeat unit sends nothing either (the silence is the alarm)', rh.code === 0 && rh.j.sent === false && hits.join() === 'GET', rh.out + hits.join());
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-ping-url'), 'https://push.example.invalid/hook\n', { mode: 0o600 });
    fs.rmSync(path.join(tmp, 'secrets', 'liveness-heartbeat-url'));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>({allow:false,reason:'not on the allowlist: '+target})};\n");
    srv.close();
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
    t('ping reaches the owner and records pingedAt', r.code === 0 && /This is a test from .*the company's alarm can reach you/.test(outbound()) && readJson(path.join(tmp, 'company', 'state', 'liveness-watch.json'), {}).pingedAt, r.out);
    r = run(T0 + 61 * 60000, 'status');
    t('status reports both heartbeats', r.j && r.j.heartbeat && r.j.watcher && r.j.enabled === true && r.j.pingEqualsHeartbeat === false, r.out);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { downNotice, upNotice, check, beat, ping, status, heartbeatRun, heartbeatNow, lastPingAt, tickMin, watchMin, enabled, F };
if (require.main === module) {
  const a = process.argv.slice(2);
  (async () => {
    if (a.includes('--selftest') || a[0] === 'selftest') process.exit(await selftest());
    const cmd = a[0] || 'check';
    const r = cmd === 'status' ? status() : cmd === 'ping' ? await ping() : cmd === 'check' ? await check() : cmd === 'heartbeat' ? await heartbeatRun() : null;
    if (!r) { console.error('usage: watch.js [check|heartbeat|status|ping|--selftest]'); process.exit(2); }
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error('liveness: ' + e.message); process.exit(1); });
}
