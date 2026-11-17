#!/usr/bin/env node
/* alarm-test.js — the owner's test of the outside alarm (the off-box heartbeat, secrets/liveness-heartbeat-url).
 *
 * The off-box check (healthchecks.io or alike) alerts the owner when pings STOP. Proving that path means pausing the
 * pings for the check's period plus grace and seeing the alert arrive. Settings › System › "Test the outside alarm"
 * (modules/liveness/http.js, owner token) drives it; there is no agent route:
 *   start({periodMin, graceMin})  writes company/state/liveness-heartbeat-pause.json {until, ...}: the heartbeat unit
 *                                 (<station>-liveness-heartbeat.timer, watch.js heartbeat) skips its GET while it holds.
 *                                 The dispatcher-silence watcher is a separate unit and is never paused.
 *                                 expectAt = last ping + period + grace; until = max(expectAt, now) + 5 min.
 *   gotIt()                       the owner saw the alert: recorded with its time, then resume.
 *   resume()                      the owner ends it early: the flag goes and the heartbeat is pinged at once.
 *   expireIfDue()                 the heartbeat unit's own check, every run (the only automatic end): a flag past its deadline (or malformed, or longer
 *                                 than the 12 h cap) is removed and the test closed as "no alert seen" unless the owner
 *                                 said otherwise, so the pause never outlives its deadline even with the console gone;
 *                                 that run then pings at once.
 * Owner only: start/gotIt/resume refuse unless lib/owner.js shell() (the console process or the owner's own shell).
 * Record: company/work/security/heartbeat-tests.jsonl rows {type: start|got-alert|end, id, ...}; the end of each test
 * also goes to the risk seat as a handoff block (FYI when the alert was seen, OPEN when it was not).
 *
 *   node modules/liveness/alarm-test.js status      the current or last test, JSON
 *   node modules/liveness/alarm-test.js --selftest
 * Env: LIVENESS_NOW (ms, tests).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('../../company/tools/lib/company');

const F = {
  pause: () => co.p('company', 'state', 'liveness-heartbeat-pause.json'),
  log: () => co.p('company', 'work', 'security', 'heartbeat-tests.jsonl'),
  watch: () => co.p('company', 'state', 'liveness-watch.json'),
};
const MAX_WINDOW_MIN = 12 * 60;   // period + grace: longer than this is not a test, it is switching the alarm off
const EXTRA_MIN = 5;              // the pause ends this long after the alert was due
const now = () => Number(process.env.LIVENESS_NOW) || Date.now();
const iso = ms => new Date(ms).toISOString();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); };
const watch = () => require('./watch.js');   // lazy: watch.js requires this file too
function row(r) { fs.mkdirSync(path.dirname(F.log()), { recursive: true }); fs.appendFileSync(F.log(), JSON.stringify(Object.assign({ at: iso(now()) }, r)) + '\n'); }
function rows() { try { return fs.readFileSync(F.log(), 'utf8').split('\n').filter(Boolean).slice(-400).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } }
const hhmm = ms => { const p = co.localParts(new Date(ms)); return String(p.hour).padStart(2, '0') + ':' + String(p.minute).padStart(2, '0'); };
const stamp = ms => co.localParts(new Date(ms)).date + ' ' + hhmm(ms);

function ownerRefusal(o) {
  let ok = false;
  try { ok = o && typeof o.shell === 'function' ? !!o.shell() : require(co.p('company', 'tools', 'lib', 'owner.js')).shell(); } catch (_) { ok = false; }
  return ok ? null : 'Only the owner tests the outside alarm, from the console (Settings › System). An agent cannot pause the heartbeat.';
}
const refuse = (msg, code) => ({ ok: false, error: msg, code: code || 'refused' });

/* the pause the watcher honours: a well-formed flag inside its deadline and the cap; else null */
function valid(p) {
  if (!p || typeof p !== 'object') return false;
  const s = Date.parse(p.startedAt), u = Date.parse(p.until), w = Number(p.periodMin) + Number(p.graceMin);
  return Number.isFinite(s) && Number.isFinite(u) && Number.isFinite(w) && w > 0 && w <= MAX_WINDOW_MIN && u > s && u - s <= (MAX_WINDOW_MIN + EXTRA_MIN + 15) * 60000;
}
function activePause(at) { const p = readJson(F.pause(), null); return p && valid(p) && (at || now()) < Date.parse(p.until) ? p : null; }

function lastPingAt() { return watch().lastPingAt(); }
function saved() {
  const s = rows().filter(r => r.type === 'start').pop();
  return s ? { periodMin: s.periodMin, graceMin: s.graceMin } : null;
}
function testOf(id) {
  const rs = rows().filter(r => r.id === id);
  const s = rs.find(r => r.type === 'start'); if (!s) return null;
  const g = rs.find(r => r.type === 'got-alert'), e = rs.find(r => r.type === 'end');
  return { id, startedAt: s.at, periodMin: s.periodMin, graceMin: s.graceMin, lastPingAt: s.lastPingAt, expectAt: s.expectAt, until: s.until, gotAt: g ? g.at : null, endedAt: e ? e.at : null, result: e ? e.result : null, how: e ? e.how : null };
}
function status() {
  const p = activePause();
  const last = rows().filter(r => r.type === 'start').pop();
  return { ok: true, configured: !!co.secret('liveness-heartbeat-url'), enabled: watch().enabled(), lastPingAt: lastPingAt(), saved: saved(), now: iso(now()),
    active: p ? testOf(p.id) || p : null, last: !p && last ? testOf(last.id) : null, maxWindowMin: MAX_WINDOW_MIN, extraMin: EXTRA_MIN };
}

function start(o) {
  o = o || {};
  const no = ownerRefusal(o); if (no) return refuse(no, 'authority');
  if (!co.secret('liveness-heartbeat-url')) return refuse('There is no outside alarm to test yet: save the heartbeat address (the ping URL of your healthchecks.io check) first, in Settings › Connections and keys.', 'unconfigured');
  if (activePause()) return refuse('A test is already running.', 'busy');
  const pm = Number(o.periodMin), gm = Number(o.graceMin);
  if (!(Number.isFinite(pm) && pm > 0) || !(Number.isFinite(gm) && gm >= 0)) return refuse('Give the check\'s period (minutes, above 0) and grace (minutes, 0 or more), as your check shows them.', 'input');
  if (pm + gm > MAX_WINDOW_MIN) return refuse('Period plus grace is over ' + MAX_WINDOW_MIN / 60 + ' hours: that is not a test, it switches the outside alarm off. Shorten the check\'s period for the test.', 'input');
  const t = now();
  const lp = lastPingAt();
  // the check counts from the last ping it received; one older than two watcher runs is not a fresh base
  const base = lp && t - Date.parse(lp) <= 2 * watch().watchMin() * 60000 + 60000 ? Date.parse(lp) : t;
  const expectAt = base + (pm + gm) * 60000;
  const until = Math.max(expectAt, t) + EXTRA_MIN * 60000;
  const id = 'hbt-' + new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 13) + '-' + Math.random().toString(36).slice(2, 6);
  const p = { id, startedAt: iso(t), periodMin: pm, graceMin: gm, lastPingAt: lp, expectAt: iso(expectAt), until: iso(until), by: o.by || 'owner' };
  writeJson(F.pause(), p);
  row({ type: 'start', id, by: p.by, periodMin: pm, graceMin: gm, lastPingAt: lp, expectAt: p.expectAt, until: p.until });
  return Object.assign(status(), { started: p });
}

function riskLine(test, how) {
  const t = now();
  const seen = !!test.gotAt;
  const after = seen && test.expectAt ? Math.round((Date.parse(test.gotAt) - Date.parse(test.expectAt)) / 60000) : null;
  const result = seen ? 'the owner got the alert at ' + hhmm(Date.parse(test.gotAt)) + (after === null ? '' : ' (' + (after === 0 ? 'on time' : Math.abs(after) + ' min ' + (after > 0 ? 'after' : 'before') + ' it was due') + ')')
    : 'no alert seen: the owner did not report one before the pings resumed' + (how === 'deadline' ? ' at the deadline' : '');
  const line = 'Outside alarm test ' + test.id + ': the owner paused the off-box heartbeat at ' + hhmm(Date.parse(test.startedAt)) + ' (check period ' + test.periodMin + ' min + grace ' + test.graceMin + ' min), so the alert was due by ' + hhmm(Date.parse(test.expectAt)) + '. Result: ' + result + '. Pings resumed at ' + hhmm(t) + ' (' + (how === 'deadline' ? 'automatically, at the deadline' : 'by the owner') + '). Record: company/work/security/heartbeat-tests.jsonl.';
  let to = null;
  try {
    const id = co.seatFor('risk'); const s = co.crew()[id] || {};
    const inbox = String(s.inbox || '').replace(/[^A-Za-z0-9._-]/g, '');
    if (inbox) {
      to = co.nameOf(id);
      const block = '\n## ' + stamp(t) + ' from Liveness (modules/liveness/alarm-test.js) — outside alarm test: ' + (seen ? 'the alert reached the owner' : 'no alert seen') + '\n'
        + '**Need:** ' + (seen ? 'nothing; this is the record of the owner\'s test of the dead-man alarm\'s silence path.' : 'find out why the outside alarm did not reach the owner (the check\'s notification settings live in the owner\'s account: ask the owner on Today, in plain words, never for a command).') + '\n'
        + line + '\n**Deadline:** ' + (seen ? 'none' : stamp(t + 86400000).slice(0, 10)) + '\n**Status:** ' + (seen ? 'DONE — FYI' : 'OPEN') + '\n';
      const f = co.p('company', 'work', 'handoffs', inbox);
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, block);
    }
  } catch (_) { to = null; }
  return { line, result: seen ? 'alert seen' : 'no alert seen', to };
}
/* close the open test (flag removed first, so a crash after it never leaves the heartbeat paused) */
function close(p, how, by) {
  try { fs.rmSync(F.pause(), { force: true }); } catch (_) {}
  const test = (p && p.id && testOf(p.id)) || null;
  if (!test || test.endedAt) return { closed: false };
  const r = riskLine(test, how);
  row({ type: 'end', id: test.id, how, by: by || (how === 'deadline' ? 'liveness watcher' : 'owner'), result: r.result, gotAt: test.gotAt, riskTold: r.to });
  return { closed: true, id: test.id, result: r.result, riskTold: r.to, line: r.line };
}
/* the watcher's side: a flag past its deadline (or not a valid one) goes, whatever the console is doing */
function expireIfDue(at) {
  const p = readJson(F.pause(), null);
  if (!p && !fs.existsSync(F.pause())) return { expired: false };
  if (p && valid(p) && (at || now()) < Date.parse(p.until)) return { expired: false, paused: true, until: p.until };
  return Object.assign({ expired: true }, close(p, valid(p) ? 'deadline' : 'invalid-flag'));
}
async function pingNow() {
  const hb = await watch().heartbeatNow();
  return hb;
}
async function resume(o) {
  o = o || {};
  const no = ownerRefusal(o); if (no) return refuse(no, 'authority');
  const p = readJson(F.pause(), null);
  if (!p) return refuse('No test is running.', 'idle');
  const c = close(p, o.how || 'owner', o.by);
  const hb = await pingNow();
  return Object.assign(status(), { resumed: c, ping: hb });
}
async function gotIt(o) {
  o = o || {};
  const no = ownerRefusal(o); if (no) return refuse(no, 'authority');
  const p = activePause();
  if (!p) return refuse('No test is running.', 'idle');
  const t = now();
  row({ type: 'got-alert', id: p.id, by: o.by || 'owner', minutesAfterDue: Math.round((t - Date.parse(p.expectAt)) / 60000) });
  return resume(Object.assign({}, o, { how: 'owner-got-alert' }));
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const os = require('os');
  const { spawn } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-test-selftest-'));
  let fails = 0, n = 0;
  const t = (name, ok, x) => { n++; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || x === undefined ? '' : ' :: ' + String(typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 600))); };
  const hits = []; const srv = require('http').createServer((q, res) => { hits.push(q.method); res.end('OK'); });
  try {
    for (const d of ['company/tools/lib', 'company/state', 'company/owner', 'company/work/ops', 'company/work/handoffs', 'modules/liveness', 'secrets']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', '..', 'company', 'tools', 'lib', 'company.js'), path.join(tmp, 'company', 'tools', 'lib', 'company.js'));
    for (const f of ['watch.js', 'tick.js', 'alarm-test.js', 'http.js']) fs.copyFileSync(path.join(__dirname, f), path.join(tmp, 'modules', 'liveness', f));
    // owner.js as the real one would answer for a process that is neither the console nor the owner's shell
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'lib', 'owner.js'), "module.exports={shell:()=>process.env.TEST_OWNER==='1'};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'owner-inbox.js'), "const fs=require('fs'),p=require('path');module.exports={send({from,text}){fs.appendFileSync(p.join(__dirname,'..','owner','outbound.jsonl'),JSON.stringify({from,text})+'\\n');return {id:'x'};}};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'external-gate.js'), "module.exports={check:({target})=>target.startsWith('http://127.0.0.1')?{allow:true}:({allow:false,reason:'not on the allowlist'})};\n");
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', owner: { name: 'Alex' }, timezone: 'UTC' }));
    fs.writeFileSync(path.join(tmp, 'company', 'work', 'ops', 'cadence.json'), JSON.stringify({ dispatcherTickMin: 10 }));
    fs.writeFileSync(path.join(tmp, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { ceo1: { name: 'Fran Founder', functions: ['ceo'], inbox: 'to-fran.md' }, r1: { name: 'Ingrid Risk', functions: ['risk'], inbox: 'to-ingrid.md' } } }));
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: { liveness: { at: 'x' } } }));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(tmp, 'secrets', 'liveness-heartbeat-url'), 'http://127.0.0.1:' + srv.address().port + '/ping/abc\n', { mode: 0o600 });
    const T0 = Date.parse('2030-01-01T00:00:00Z'), M = 60000;
    // every step a fresh process (no console running): node <file> with LIVENESS_NOW pinned
    const node = (at, code, owner) => new Promise(resolve => {
      const ch = spawn(process.execPath, ['-e', code], { cwd: tmp, env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(at), TEST_OWNER: owner ? '1' : '0' }) });
      let o = ''; ch.stdout.on('data', d => { o += d; }); ch.stderr.on('data', d => { o += d; });
      ch.on('exit', code2 => { let j = null; try { j = JSON.parse(o.trim().split('\n').pop()); } catch (_) {} resolve({ code: code2, j, out: o }); });
    });
    const AT = "const a=require('./modules/liveness/alarm-test.js');";
    const check = at => node(at, "require('./modules/liveness/watch.js').check().then(r=>console.log(JSON.stringify(r)))");
    // the heartbeat unit (<station>-liveness-heartbeat.timer runs `watch.js heartbeat`): the only thing that pings
    const hbeat = at => node(at, "require('./modules/liveness/watch.js').heartbeatRun().then(r=>console.log(JSON.stringify(r)))");
    const tick = at => node(at, "require('./modules/liveness/tick.js').tick({}).then(r=>console.log(JSON.stringify(r)))");
    const outbound = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'owner', 'outbound.jsonl'), 'utf8'); } catch (_) { return ''; } };
    const log = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'work', 'security', 'heartbeat-tests.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (_) { return []; } };
    const risk = () => { try { return fs.readFileSync(path.join(tmp, 'company', 'work', 'handoffs', 'to-ingrid.md'), 'utf8'); } catch (_) { return ''; } };
    const pauseFile = path.join(tmp, 'company', 'state', 'liveness-heartbeat-pause.json');

    await tick(T0); let r = await hbeat(T0 + 1 * M);
    t('baseline: the heartbeat unit pings the outside check once', r.j && r.j.sent && hits.join() === 'GET', r.out + hits.join());
    r = await check(T0 + 1 * M + 1000);
    t('baseline: the watcher check (its own unit) sends no ping', r.j && r.j.ok && hits.length === 1, r.out);

    // owner only
    r = await node(T0 + 2 * M, AT + "console.log(JSON.stringify(a.start({periodMin:5,graceMin:2,by:'Sam'})))", false);
    t('owner only: a process that is not the owner (an agent\'s run) cannot start the test', r.j && r.j.ok === false && r.j.code === 'authority' && !fs.existsSync(pauseFile), r.out);
    r = await node(T0 + 2 * M, "const h=require('./modules/liveness/http.js');console.log(JSON.stringify({auth:[...new Set(h.routes.map(x=>x.auth))]}))");
    t('owner only: every console route of the test is behind the owner token', r.j && r.j.auth.join() === 'owner', r.out);
    r = await node(T0 + 2 * M, AT + "console.log(JSON.stringify(a.start({periodMin:600,graceMin:300})))", true);
    t('a window longer than 12 h is refused (that switches the alarm off)', r.j && r.j.ok === false && r.j.code === 'input', r.out);

    // start: the owner pauses the pings only
    // started by a console that then dies (SIGKILL mid-test): nothing of the console is needed to end the pause
    const con = spawn(process.execPath, ['-e', AT + "console.log(JSON.stringify(a.start({periodMin:5,graceMin:2})));setInterval(()=>{},1000)"], { cwd: tmp, env: Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, LIVENESS_NOW: String(T0 + 2 * M), TEST_OWNER: '1' }) });
    let cout = ''; con.stdout.on('data', d => { cout += d; });
    for (let i = 0; i < 100 && !cout.includes('\n'); i++) await new Promise(res => setTimeout(res, 50));
    con.kill('SIGKILL'); await new Promise(res => con.once('exit', res));
    r = { j: (() => { try { return JSON.parse(cout.trim()); } catch (_) { return null; } })(), out: cout };
    const p = r.j && r.j.started;
    t('the console that started the test is killed (SIGKILL); the flag stays for the watcher', con.signalCode === 'SIGKILL' && fs.existsSync(pauseFile), cout);
    t('start: expected alert = last ping + period + grace, deadline 5 min after it', p && p.expectAt === iso(T0 + 1 * M + 7 * M) && p.until === iso(T0 + 13 * M) && fs.existsSync(pauseFile), r.out);
    t('start is recorded (start, expected alert time)', log().some(x => x.type === 'start' && x.id === p.id && x.expectAt === p.expectAt && x.periodMin === 5 && x.graceMin === 2));
    r = await node(T0 + 2 * M, AT + "console.log(JSON.stringify(a.status()))");
    t('status offers the saved period and grace next time', r.j && r.j.saved && r.j.saved.periodMin === 5 && r.j.saved.graceMin === 2 && r.j.active && r.j.active.id === p.id, r.out);
    await tick(T0 + 4 * M);
    r = await hbeat(T0 + 5 * M);
    t('paused: the heartbeat unit sends no ping', r.j && r.j.paused && hits.length === 1, r.out + hits.join());
    r = await check(T0 + 5 * M + 1000);
    t('paused: the watcher check still runs and judges the dispatcher (healthy)', r.j && r.j.ok && r.j.label === 'dispatcher' && hits.length === 1, r.out);
    // the dispatcher goes silent during the pause: its alert still fires (the liveness timer was not stopped)
    fs.writeFileSync(path.join(tmp, 'company', 'state', 'heartbeat.json'), JSON.stringify({ at: iso(T0 - 60 * M), firstAt: iso(T0 - 120 * M) }));
    await hbeat(T0 + 10 * M);
    r = await check(T0 + 10 * M + 1000);
    t('paused: a silent dispatcher is still alerted on (owner told), and no ping goes out', r.code !== null && r.j && r.j.stale === true && /dispatcher has not checked in/.test(outbound()) && hits.length === 1, r.out + outbound());
    await tick(T0 + 11 * M);
    r = await check(T0 + 12 * M); await hbeat(T0 + 12 * M + 1000);
    t('paused: recovery is told, still no ping before the deadline', /checking in again/.test(outbound()) && hits.length === 1 && fs.existsSync(pauseFile), r.out);

    // auto-resume on the deadline with no console at all: the watcher checks the deadline itself and pings at once
    r = await hbeat(T0 + 13 * M + 1000);
    t('deadline, console dead: the heartbeat unit removes the flag on its own and pings in the same run', !fs.existsSync(pauseFile) && hits.length === 2 && r.j && r.j.sent && r.j.alarmTest && r.j.alarmTest.expired, r.out + hits.join());
    const end = log().find(x => x.type === 'end' && x.id === p.id);
    t('record: the end row says no alert seen, resumed at the deadline', end && end.result === 'no alert seen' && end.how === 'deadline', log());
    t('risk seat: an OPEN handoff in plain words with the times and the record', /outside alarm test: no alert seen/.test(risk()) && /\*\*Status:\*\* OPEN/.test(risk()) && /due by 00:08/.test(risk()) && /heartbeat-tests\.jsonl/.test(risk()), risk());

    // a forged flag far in the future is not honoured: the watcher removes it and pings
    fs.writeFileSync(pauseFile, JSON.stringify({ id: 'x', startedAt: iso(T0 + 14 * M), until: iso(T0 + 30 * 86400000), periodMin: 5, graceMin: 2 }));
    r = await hbeat(T0 + 15 * M);
    t('a flag beyond the 12 h cap is ignored and removed, and the ping goes out', !fs.existsSync(pauseFile) && hits.length === 3, r.out + hits.join());

    // the owner path: got the alert -> recorded with its time, resumed, pinged at once, FYI to risk
    r = await node(T0 + 20 * M, AT + "console.log(JSON.stringify(a.start({periodMin:5,graceMin:1})))", true);
    const p2 = r.j && r.j.started;
    r = await node(T0 + 24 * M, AT + "a.gotIt({}).then(x=>console.log(JSON.stringify(x)))", false);
    t('owner only: "I got the alert" from a non-owner process is refused', r.j && r.j.code === 'authority' && fs.existsSync(pauseFile), r.out);
    r = await node(T0 + 24 * M, AT + "a.gotIt({}).then(x=>console.log(JSON.stringify(x)))", true);
    const g = log().find(x => x.type === 'got-alert' && x.id === (p2 && p2.id));
    t('got it: recorded with its time, the flag goes, the heartbeat is pinged at once', g && g.at === iso(T0 + 24 * M) && g.minutesAfterDue === 3 && !fs.existsSync(pauseFile) && hits.length === 4 && r.j && r.j.ping && r.j.ping.sent, r.out + hits.join());
    t('got it: the end row and an FYI to the risk seat say the alert reached the owner', log().some(x => x.type === 'end' && x.id === p2.id && x.result === 'alert seen') && /the alert reached the owner/.test(risk()) && /got the alert at 00:24 \(3 min after it was due\)/.test(risk()) && /DONE — FYI/.test(risk()), risk());
    r = await node(T0 + 28 * M, AT + "a.resume({}).then(x=>console.log(JSON.stringify(x)))", true);
    t('resume with no test running says so', r.j && r.j.ok === false && r.j.code === 'idle', r.out);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { start, gotIt, resume, status, activePause, expireIfDue, F, MAX_WINDOW_MIN, EXTRA_MIN };
if (require.main === module) {
  const a = process.argv.slice(2);
  (async () => {
    if (a.includes('--selftest') || a[0] === 'selftest') process.exit(await selftest());
    if ((a[0] || 'status') !== 'status') { console.error('usage: alarm-test.js status | --selftest (the test itself is started from the console)'); process.exit(2); }
    console.log(JSON.stringify(status(), null, 1));
  })().catch(e => { console.error('alarm-test: ' + e.message); process.exit(1); });
}
