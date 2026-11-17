#!/usr/bin/env node
/* restart-station.js — restart the station only when nothing is running, and say so. Run it through scripts/restart-station.sh.
 *
 *   scripts/restart-station.sh --when-idle [--max-wait-min N] [--hold-max-min M] [--reason "..."] [--by <Name>]
 *                                          hold new starts (for up to M min), wait for idle, restart the unit, wait for
 *                                          health, release
 *   scripts/restart-station.sh [--reason "..."]   restart only if the station is idle right now (3 polls); else exit 1
 *   scripts/restart-station.sh --status    what is in flight right now, and any restart hold (exit 0 idle, 1 busy)
 *   scripts/restart-station.sh --release --by <Name>   drop a restart hold left by a script that died (re-arms the scheduler)
 *   node company/tools/restart-station.js selftest     the idle rule on fixtures (the mock-station test is
 *                                                      company/tools/tests/restart-station.test.js)
 *
 * WHY. A quiet station.log is not an idle station: a run can work for 25 minutes without writing it. On 2026-11-17 a
 * "90 s of quiet log" restart cancelled two live runs. Idle is decided from what the station itself says is running:
 *   - GET /api/state/snapshot `runs` (StarNet's run table: every run runOnce drives — routine fires, chat turns, hub
 *     and /v1 runs, a turn queued behind its conversation — plus the background-worker manager's runs) and `queues`;
 *   - GET /api/cron jobs with `inFlight` / state running (a cron lease the run table may not list yet);
 *   - GET /api/loops goal loops in state running;
 *   - the dispatcher's own state: a dispatch tick in progress (company/state/dispatcher-loop.json `ticking`, its pid
 *     alive) and a Sprint lane it started in the last 3 minutes (company/state/lanes.json) that the station does not
 *     list yet.
 * It is idle only when all of them are empty on 3 consecutive polls (RESTART_POLL_SEC apart, default 20). A station
 * API that does not answer is BUSY, never idle.
 *
 * STOPPING NEW STARTS. Waiting alone may never see idle, so --when-idle first sets a restart hold:
 * company/state/restart-hold.json {by, reason, pid, at, expiresAt, disarmed}. While it holds, co.startsHeld() is
 * 'restart': the dispatcher wakes nobody (its log says RESTART HOLD), hiring does not advance, founder-loop ensure does
 * not re-arm. It also disarms the station scheduler (POST /api/cron/arm {enabled:false}) when it was armed, so no routine
 * fires on its schedule; it never touches a scheduler that is off or E-STOP halted. Running work is never stopped.
 * With company.json runtime.scheduler = "dispatcher" (docs/BUDGET.md) the only armed routine is the watchdog, so
 * disarming pauses only that check; the dispatcher's own hold is what keeps the crew's loops from starting.
 * The hold expires by itself (its cap + 15 min) if this script dies; --release drops it at once.
 *
 * THE HOLD HAS ITS OWN CAP (--hold-max-min, default 15). On 2026-11-17 a hold froze the whole company for 40+ minutes
 * while one run (sleeping in a loop for market boundaries) finished: nobody else could start anything. So after the
 * cap, if work is still in flight, the hold is LIFTED (the scheduler re-armed, the crew works again) and the script
 * keeps watching: the hold file stays as a record with `watching: true`, which co.restartHold() ignores, so a second
 * restart is still refused. The next time the station is idle BY ITSELF (the same 3 polls in a row), it holds again,
 * confirms idle under the hold on 3 more polls, and restarts; if something slipped in, the held phase starts over with
 * a fresh cap. The dispatch log and the owner hear it plainly ("Waiting for Halima's run to end; the crew keeps working
 * meanwhile"), the owner once. It still never kills a run and still gives up at --max-wait-min.
 *
 * Then: restart the unit (systemctl --user restart <company.json station.serviceName>.service), wait for GET /api/health
 * "ok" and GET /api/cron (RESTART_HEALTH_SEC, default 180), then until every provider that was ready before the restart
 * is ready again in GET /api/providers (RESTART_PROVIDERS_SEC, default 180: the station checks Claude's local sign-in
 * after it answers health, and a routine started meanwhile is refused "not set up"), re-arm the scheduler, drop the hold, and
 * write one plain line to company/work/dispatch-log.md and one message to the owner channel ("Station restarted to load
 * patch 0013 at 16:00; no run was interrupted."). With --max-wait-min (default 120) it gives up when idle never comes:
 * the hold is released, the scheduler re-armed, nothing is stopped, and the log and the owner are told what kept it
 * busy. It never kills a run.
 * Progress: stdout and company/work/restart-station.log. Exit: 0 restarted (or idle, --status), 1 busy (no --when-idle,
 * or --status), 2 usage / another restart is waiting, 3 gave up (max wait), 4 the station did not come back healthy.
 * Env (tests): RESTART_STATION_CMD (shell command run instead of systemctl), RESTART_POLL_SEC, RESTART_HEALTH_SEC,
 *   RESTART_IDLE_POLLS (default 3), RESTART_MINUTE_MS (length of a minute for --max-wait-min / --hold-max-min, default 60000).
 * Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const co = require('./lib/company');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const S = {
  pollMs: () => num(process.env.RESTART_POLL_SEC, 20) * 1000,
  healthMs: () => num(process.env.RESTART_HEALTH_SEC, 180) * 1000,
  providersMs: () => num(process.env.RESTART_PROVIDERS_SEC, 180) * 1000,
  idlePolls: () => num(process.env.RESTART_IDLE_POLLS, 3),
  minuteMs: () => num(process.env.RESTART_MINUTE_MS, 60000),
  service: () => { const s = String(co.config.station.serviceName || 'capheos-station'); return s.endsWith('.service') ? s : s + '.service'; },
  logFile: () => co.p('company', 'work', 'restart-station.log'),
  dispatchLog: () => co.p('company', 'work', 'dispatch-log.md'),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const stamp = (t) => { const lp = co.localParts(t ? new Date(t) : new Date()); return lp.date + ' ' + lp.time; };
const hm = (t) => co.localParts(t ? new Date(t) : new Date()).time;
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function say(line) {
  const l = stamp() + ' ' + line; console.log(l);
  try { fs.mkdirSync(path.dirname(S.logFile()), { recursive: true }); fs.appendFileSync(S.logFile(), l + '\n'); } catch (_) {}
}
// one line in the dispatch log, in the dispatcher's own format
function dispatchLine(line) {
  try { const f = S.dispatchLog(); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Dispatch log\n\n'); fs.appendFileSync(f, '- ' + stamp() + ' ' + line + '\n'); } catch (_) {}
}
function tellOwner(text) { try { require('./owner-inbox.js').send({ from: co.nameOf(co.ceo()), text }); } catch (e) { say('could not write the owner channel: ' + e.message); } }

/* ---------------- station ---------------- */
function call(method, p, body, timeoutMs) {
  return new Promise(resolve => {
    let token; try { token = co.stationToken(); } catch (e) { resolve({ status: 0, body: '', error: e.message }); return; }
    let u; try { u = new URL(co.STATION_URL + p); } catch (e) { resolve({ status: 0, body: '', error: e.message }); return; }
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: timeoutMs || 8000,
      headers: Object.assign({ 'x-starnet-token': token }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch (_) {} resolve({ status: res.statusCode, body: d, json }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, body: '', error: e.message }));
    if (data) req.write(data); req.end();
  });
}

/* ---------------- what is in flight ---------------- */
// busyFrom(views, now) -> { readable, items: [{ source, key, what }] }. PURE (the selftest feeds it fixtures).
// views: { snapshot, cron, loops: {status, json}, dispatcher: dispatcher-loop.json, lanes: lanes.json, crew }
function busyFrom(v, now) {
  const items = []; let readable = true; const seen = new Set();
  const name = id => (v.crew && v.crew[id] && v.crew[id].name) || id || '?';
  const mins = t => { const n = Number(t) || Date.parse(String(t || '')); return Number.isFinite(n) && n > 0 ? ', ' + Math.max(0, Math.round((now - n) / 60000)) + ' min' : ''; };
  const sn = v.snapshot || {};
  if (sn.status !== 200 || !sn.json || !Array.isArray(sn.json.runs)) { readable = false; items.push({ source: 'station', key: 'snapshot', what: 'GET /api/state/snapshot did not answer (' + (sn.error || 'HTTP ' + sn.status) + '): busy until it does' }); }
  else {
    for (const r of sn.json.runs) { if (!r || !r.runId) continue; seen.add(r.runId); items.push({ source: 'run', key: 'run:' + r.runId, who: name(r.agentId), what: name(r.agentId) + ' (' + (r.source || 'run') + ' run ' + String(r.runId).slice(0, 12) + mins(r.startedAt) + ')' }); }
    for (const q of sn.json.queues || []) if (q && q.depth > 0) items.push({ source: 'queue', key: 'queue:' + q.agentId, who: name(q.agentId), what: q.depth + ' turn(s) queued for ' + name(q.agentId) });
  }
  const cr = v.cron || {};
  if (cr.status !== 200 || !cr.json || !Array.isArray(cr.json.jobs)) { readable = false; items.push({ source: 'station', key: 'cron', what: 'GET /api/cron did not answer (' + (cr.error || 'HTTP ' + cr.status) + '): busy until it does' }); }
  else for (const j of cr.json.jobs) {
    if (!j || !(j.inFlight || j.state === 'running')) continue;
    const rid = j.inFlightRunId || null; if (rid && seen.has(rid)) continue;
    if (rid) seen.add(rid);
    items.push({ source: 'routine', key: 'job:' + j.id + ':' + (rid || '-'), who: name(j.agentId), what: 'routine "' + (j.name || j.id) + '" for ' + name(j.agentId) + (rid ? ' (run ' + String(rid).slice(0, 12) + ')' : ' (in flight)') });
  }
  const lp = v.loops || {};
  if (lp.status === 200 && lp.json && Array.isArray(lp.json.loops)) for (const l of lp.json.loops) if (l && (l.state === 'running' || l.inFlight)) items.push({ source: 'loop', key: 'loop:' + l.id, what: 'goal loop "' + (l.name || l.title || l.id) + '"' });
  const d = v.dispatcher || {};
  if (d.status === 'ticking' && d.pid && alive(d.pid) && now - Date.parse(String(d.lastTickAt || '')) < 16 * 60000) items.push({ source: 'dispatcher', key: 'dispatch-tick', what: 'a dispatcher tick is running (since ' + hm(Date.parse(d.lastTickAt)) + ')' });
  for (const l of ((v.lanes || {}).lanes || [])) {
    if (!l || (l.runId && seen.has(l.runId))) continue;
    const t = Date.parse(String(l.startedAt || '')); if (!(now - t < 3 * 60000)) continue;   // older: the station's own view decides
    items.push({ source: 'lane', key: 'lane:' + l.id, what: 'Sprint lane ' + (l.id || '') + ' started at ' + hm(t) + ', not listed by the station yet' });
  }
  return { readable, items };
}
async function inFlight(now) {
  const [snapshot, cron, loops] = await Promise.all([call('GET', '/api/state/snapshot'), call('GET', '/api/cron'), call('GET', '/api/loops')]);
  return busyFrom({ snapshot, cron, loops, dispatcher: readJson(co.p('company', 'state', 'dispatcher-loop.json'), {}), lanes: readJson(co.p('company', 'state', 'lanes.json'), {}), crew: co.crew() }, now || Date.now());
}
// "patch 0013" -> "load patch 0013"; a reason that already says load ("load the systemctl guard") is not doubled
const loadWhat = r => { const t = String(r || '').trim(); return /^(to\s+)?load\b/i.test(t) ? t.replace(/^to\s+/i, '') : 'load ' + t; };
const listOf = items => items.map(i => i.what).join('; ');
// "Halima's run", "Halima's and Dave's runs", or "the running work" when no item names a person
function waitingFor(items) {
  const who = [...new Set(items.map(i => i.who).filter(Boolean))];
  const n = items.filter(i => i.who).length;
  if (!who.length) return 'the running work';
  const names = who.length === 1 ? who[0] + "'s" : who.slice(0, -1).map(w => w + "'s").join(', ') + ' and ' + who[who.length - 1] + "'s";
  return names + (n > 1 ? ' runs' : ' run');
}

/* ---------------- the hold ---------------- */
function readHold() { return readJson(co.RESTART_HOLD_FILE, null); }
function writeHold(h) { fs.mkdirSync(path.dirname(co.RESTART_HOLD_FILE), { recursive: true }); const t = co.RESTART_HOLD_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(h, null, 1) + '\n'); fs.renameSync(t, co.RESTART_HOLD_FILE); }
async function setHold(o) {
  const cur = readHold();
  if (cur && cur.pid && cur.pid !== process.pid && alive(cur.pid) && (co.restartHold() || cur.watching === true)) return { error: 'another restart is already waiting (pid ' + cur.pid + ', by ' + (cur.by || '?') + ' since ' + hm(Date.parse(cur.at)) + ': ' + (cur.reason || '') + ')' };
  const cr = await call('GET', '/api/cron');
  const armed = !!(cr.status === 200 && cr.json && cr.json.enabled !== false && !cr.json.halted);
  const h = { _doc: 'restart-station.js: nothing new starts while this holds (co.startsHeld()); it expires by itself at expiresAt. Written only by restart-station.js.',
    by: o.by, reason: o.reason, pid: process.pid, at: new Date().toISOString(), expiresAt: new Date(Date.now() + o.holdMs).toISOString(), disarmed: false };
  if (o.firstAt) h.firstAt = o.firstAt;
  writeHold(h);   // first: from here on the dispatcher starts nothing, even if the station call below fails
  if (armed) {
    const a = await call('POST', '/api/cron/arm', { enabled: false });
    if (a.status === 200) { h.disarmed = true; writeHold(h); }
    else say('could not disarm the scheduler (' + (a.error || 'HTTP ' + a.status) + '); the hold still stops the dispatcher, and a routine that fires on its schedule is waited for like any run');
  }
  return { hold: h };
}
// releaseHold(why, watch): re-arm what the hold disarmed and drop the hold. With `watch` ({ waitingFor, giveUpAt }) the
// hold is only LIFTED: the file stays as a `watching: true` record (holds nothing, refuses a second restart).
async function releaseHold(why, watch) {
  const h = readHold(); const notes = [];
  if (h && h.disarmed) {
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) { const a = await call('POST', '/api/cron/arm', { enabled: true }); ok = a.status === 200; if (!ok) await sleep(2000); }
    notes.push(ok ? 're-armed the scheduler' : 'could NOT re-arm the scheduler: run `node company/tools/founder-loop.js ensure`');
  }
  if (watch && h) writeHold({ _doc: 'restart-station.js: the restart hold is LIFTED (nothing is held); the script (pid) still watches for an idle station to restart it. co.restartHold() ignores this record.',
    by: h.by, reason: h.reason, pid: process.pid, at: h.firstAt || h.at, watching: true, liftedAt: new Date().toISOString(),
    waitingFor: watch.waitingFor, giveUpAt: new Date(watch.giveUpAt).toISOString(), expiresAt: new Date(watch.giveUpAt + 15 * S.minuteMs()).toISOString(), disarmed: false });
  else { try { fs.unlinkSync(co.RESTART_HOLD_FILE); } catch (_) {} }
  say((watch ? 'hold lifted' : 'hold released') + ' (' + why + ')' + (notes.length ? '; ' + notes.join('; ') : ''));
  return notes;
}

/* ---------------- restart ---------------- */
function restartUnit() {
  return new Promise(resolve => {
    const cmd = process.env.RESTART_STATION_CMD;
    const [bin, args] = cmd ? ['bash', ['-c', cmd]] : ['systemctl', ['--user', 'restart', S.service()]];
    execFile(bin, args, { timeout: 120000 }, (e, out, err) => resolve(e ? { ok: false, error: String((err || '').trim() || e.message).slice(0, 300) } : { ok: true }));
  });
}
async function waitHealthy() {
  const until = Date.now() + S.healthMs();
  await sleep(Math.min(2000, S.pollMs()));   // the old process may still answer for a moment
  while (Date.now() < until) {
    const h = await call('GET', '/api/health', null, 4000);
    if (h.status === 200 && /^ok/.test(String(h.body || '').trim())) { const c = await call('GET', '/api/cron', null, 6000); if (c.status === 200) return true; }
    await sleep(Math.min(2000, S.pollMs()));
  }
  return false;
}

// the providers the station calls ready (configured, unattended-ready), or null when it does not answer
async function readyProviders() {
  const r = await call('GET', '/api/providers', null, 8000);
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.providers)) return null;
  return r.json.providers.filter(p => p && p.id && p.configured === true && p.unattendedReady !== false).map(p => String(p.id)).sort();
}
// after a restart the station answers /api/health before it has re-checked every provider (Claude's local sign-in is
// checked at boot): wait until each provider ready before the restart is ready again, or the cap. Returns what is missing.
async function waitProviders(want) {
  if (!want || !want.length) return [];
  const until = Date.now() + S.providersMs(); let missing = want.slice();
  while (Date.now() < until) {
    const now = await readyProviders();
    if (now) { missing = want.filter(id => !now.includes(id)); if (!missing.length) return []; }
    await sleep(Math.min(2000, S.pollMs()));
  }
  return missing;
}

/* ---------------- main ---------------- */
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2); const nx = argv[i + 1];
    if (['when-idle', 'status', 'release', 'json'].includes(k)) o[k] = true;
    else if (nx !== undefined && !nx.startsWith('--')) { o[k] = nx; i++; } else o[k] = true;
  }
  return o;
}
async function run(a) {
  const reason = a.reason && a.reason !== true ? String(a.reason).replace(/\s+/g, ' ').trim().slice(0, 200) : 'a restart';
  const by = a.by && a.by !== true ? String(a.by).slice(0, 60) : (co.config.owner && co.config.owner.name) || 'owner';
  if (a.status) {
    const b = await inFlight(); const h = co.restartHold(); const rec = readHold(); const watching = rec && rec.watching === true ? rec : null;
    if (a.json) console.log(JSON.stringify({ idle: b.readable && !b.items.length, readable: b.readable, inFlight: b.items, hold: h, watching }, null, 1));
    else {
      console.log(b.items.length ? 'busy: ' + listOf(b.items) : 'idle: nothing in flight');
      if (h) console.log('restart hold: by ' + h.by + ' since ' + hm(Date.parse(h.at)) + ' (' + h.reason + '), pid ' + h.pid + (alive(h.pid) ? '' : ' (not running)') + ', expires ' + hm(Date.parse(h.expiresAt)));
      if (watching) console.log('restart waiting, hold lifted (the crew keeps working): by ' + watching.by + ' (' + watching.reason + '), pid ' + watching.pid + (alive(watching.pid) ? '' : ' (not running)') + ', waiting for ' + (watching.waitingFor || 'running work') + ', gives up at ' + hm(Date.parse(watching.giveUpAt)));
    }
    return b.readable && !b.items.length ? 0 : 1;
  }
  if (a.release) {
    if (!readHold()) { console.log('no restart hold'); return 0; }
    const h = readHold();
    if (h.pid && alive(h.pid) && h.pid !== process.pid && (co.restartHold() || h.watching === true)) { console.error('the restart script that set the hold is still running (pid ' + h.pid + '); stop it first, it releases the hold itself'); return 2; }
    const n = await releaseHold('released by ' + by); dispatchLine('RESTART HOLD released by ' + by + ' (its restart-station.js was not running)' + (n.length ? '; ' + n.join('; ') : ''));
    return 0;
  }
  const maxWaitMin = num(a['max-wait-min'], 120);
  const need = S.idlePolls();
  const t0 = Date.now();
  if (!a['when-idle']) {
    // no waiting, no hold: restart only if it is idle right now, on `need` polls in a row
    for (let i = 0; i < need; i++) {
      const b = await inFlight();
      if (!b.readable || b.items.length) { console.error('not restarted: ' + (b.items.length ? 'in flight: ' + listOf(b.items) : 'the station did not answer') + '. Wait for it: scripts/restart-station.sh --when-idle --reason "' + reason.replace(/"/g, "'") + '"'); return 1; }
      if (i < need - 1) await sleep(S.pollMs());
    }
    return restartNow({ by, reason, t0, waited: [] });
  }
  const holdCapMin = Math.min(num(a['hold-max-min'], 15), maxWaitMin);
  const holdMs = (holdCapMin + 15) * S.minuteMs();   // a hold expires by itself this long after it is set, if this script dies
  const giveUpAt = t0 + maxWaitMin * S.minuteMs();
  const set = await setHold({ by, reason, holdMs });
  if (set.error) { console.error('not started: ' + set.error); return 2; }
  say('ARMED by ' + by + ': restart ' + S.service() + ' to ' + loadWhat(reason) + ' once nothing is in flight on ' + need + ' polls in a row (every ' + Math.round(S.pollMs() / 1000) + ' s; gives up after ' + maxWaitMin + ' min). Nothing new starts meanwhile, for up to ' + holdCapMin + ' min' + (set.hold.disarmed ? '; the scheduler is disarmed' : '') + '; after that the crew works again while this keeps watching.');
  dispatchLine('RESTART HOLD by ' + by + ': waiting for running work to finish to restart the station (' + reason + '); nothing new starts for up to ' + holdCapMin + ' min, nothing running is stopped (scripts/restart-station.sh)');
  let quiet = 0; let lastSig = null; const waited = new Map(); let lastSay = 0;
  let held = true; let heldAt = Date.now(); let ownerTold = false;
  const cleanup = async sig => { await releaseHold('stopped by ' + sig + ' before the restart'); dispatchLine('RESTART HOLD released: restart-station.js was stopped (' + sig + ') before restarting; nothing was restarted'); process.exit(130); };
  process.once('SIGINT', () => cleanup('SIGINT')); process.once('SIGTERM', () => cleanup('SIGTERM'));
  for (;;) {
    const b = await inFlight();
    for (const i of b.items) if (i.source !== 'station') waited.set(i.key, i.what);
    if (b.readable && !b.items.length) quiet++; else quiet = 0;
    const sig = b.items.map(i => i.key).sort().join(',');
    if (quiet >= need) {
      if (held) break;
      // idle by itself while the crew could start work: hold again, and confirm idle under the hold before restarting
      const again = await setHold({ by, reason, holdMs, firstAt: new Date(t0).toISOString() });
      if (again.error) { say('could not hold again: ' + again.error); return 2; }
      held = true; heldAt = Date.now(); quiet = 0; lastSig = null;
      say('the station is idle by itself: holding new starts again (for up to ' + holdCapMin + ' min) to restart once it stays idle on ' + need + ' polls');
      dispatchLine('RESTART HOLD again by ' + by + ': the station is idle by itself, so nothing new starts while it restarts to ' + loadWhat(reason) + ' (scripts/restart-station.sh)');
      await sleep(S.pollMs()); continue;
    }
    if (sig !== lastSig || Date.now() - lastSay > 10 * S.minuteMs()) { say(b.items.length ? 'waiting' + (held ? '' : ' (hold lifted)') + ': ' + listOf(b.items) : 'idle poll ' + quiet + '/' + need); lastSig = sig; lastSay = Date.now(); }
    if (Date.now() >= giveUpAt) {
      const n = await releaseHold('gave up after ' + maxWaitMin + ' min');
      const still = listOf(b.items) || 'the station did not answer';
      say('GAVE UP: not idle after ' + maxWaitMin + ' min; still in flight: ' + still + '. Nothing was stopped, nothing was restarted.');
      dispatchLine('RESTART GAVE UP after ' + maxWaitMin + ' min (' + reason + '): still in flight: ' + still.slice(0, 300) + '. The hold is released' + (n.length ? ' (' + n.join('; ') + ')' : '') + '; nothing was stopped or restarted.');
      tellOwner('I did not restart the station to ' + loadWhat(reason) + ': after ' + maxWaitMin + ' minutes work was still running (' + still.slice(0, 200) + '), and a restart would have cut it off. Nothing was stopped; work goes on as before. Try again later with scripts/restart-station.sh --when-idle.');
      return 3;
    }
    if (held && quiet === 0 && Date.now() - heldAt >= holdCapMin * S.minuteMs()) {
      // the hold's own cap: one long run must not freeze the whole company. Lift it, keep watching.
      const wf = waitingFor(b.items);
      const n = await releaseHold('held ' + holdCapMin + ' min, the cap; still in flight: ' + listOf(b.items).slice(0, 200), { waitingFor: wf, giveUpAt });
      held = false; lastSig = null;
      say('HOLD LIFTED after ' + holdCapMin + ' min: waiting for ' + wf + ' to end; the crew keeps working meanwhile. Restarting the next time the station is idle by itself; gives up at ' + hm(giveUpAt) + '.');
      dispatchLine('RESTART WAITING (' + reason + '): Waiting for ' + wf + ' to end; the crew keeps working meanwhile. The restart hold was lifted after ' + holdCapMin + ' min' + (n.length ? ' (' + n.join('; ') + ')' : '') + '; the station restarts the next time it is idle by itself, or the restart is given up at ' + hm(giveUpAt) + '. Nothing is stopped.');
      if (!ownerTold) { ownerTold = true; tellOwner('Waiting for ' + wf + ' to end before restarting the station to ' + loadWhat(reason) + '; the crew keeps working meanwhile. I will restart it the next time nothing is running, or give up at ' + hm(giveUpAt) + '. Nothing is stopped.'); }
    }
    await sleep(S.pollMs());
  }
  return restartNow({ by, reason, t0, waited: [...waited.values()], held: true });
}
async function restartNow(o) {
  say('idle: restarting ' + S.service());
  const readyBefore = await readyProviders();
  const r = await restartUnit();
  const at = hm();
  if (!r.ok) {
    if (o.held) await releaseHold('the restart command failed');
    say('RESTART FAILED: ' + r.error);
    dispatchLine('RESTART FAILED (' + o.reason + '): ' + r.error + (o.held ? '; the hold is released' : ''));
    tellOwner('I tried to restart the station to ' + loadWhat(o.reason) + ' at ' + at + ', but the restart command failed: ' + r.error.slice(0, 160) + '. No run was interrupted.');
    return 4;
  }
  const ok = await waitHealthy();
  // the hold stays until the providers that were ready are ready again, so no routine starts into "not set up"
  const notReady = ok ? await waitProviders(readyBefore) : [];
  if (notReady.length) say('providers not ready ' + Math.round(S.providersMs() / 1000) + ' s after the restart: ' + notReady.join(', ') + ' (the hold is released anyway)');
  else if (ok && readyBefore && readyBefore.length) say('providers ready again: ' + readyBefore.join(', '));
  const notes = o.held ? await releaseHold(ok ? 'restart done' + (notReady.length ? '; not ready yet: ' + notReady.join(', ') : '') : 'the station did not come back healthy') : [];
  if (notReady.length) notes.push('not ready ' + Math.round(S.providersMs() / 1000) + ' s after the restart: ' + notReady.join(', '));
  const waitedTxt = o.waited.length ? ' after waiting ' + Math.max(1, Math.round((Date.now() - o.t0) / 60000)) + ' min for ' + o.waited.length + ' run(s) to finish' : '';
  if (!ok) {
    say('STATION NOT HEALTHY ' + Math.round(S.healthMs() / 1000) + ' s after the restart');
    dispatchLine('RESTART: the station was restarted to ' + loadWhat(o.reason) + ' at ' + at + ' but did not answer /api/health within ' + Math.round(S.healthMs() / 1000) + ' s; no run was interrupted' + (notes.length ? '; ' + notes.join('; ') : ''));
    tellOwner('Station restarted to ' + loadWhat(o.reason) + ' at ' + at + '; no run was interrupted, but it has not come back healthy yet. See .starnet-data/station.log.');
    return 4;
  }
  say('DONE: restarted at ' + at + ', healthy; no run was interrupted' + waitedTxt);
  dispatchLine('Station restarted to ' + loadWhat(o.reason) + ' at ' + at + '; no run was interrupted' + waitedTxt + ' (scripts/restart-station.sh by ' + o.by + ')' + (notes.length ? '; ' + notes.join('; ') : ''));
  tellOwner('Station restarted to ' + loadWhat(o.reason) + ' at ' + at + '; no run was interrupted' + waitedTxt + '.');
  return 0;
}

/* ---------------- selftest (the idle rule; the mock-station walk is tests/restart-station.test.js) ---------------- */
function selftest() {
  const assert = require('assert'); let bad = 0; const now = Date.parse('2026-11-17T16:00:00Z');
  const t = (n, f) => { try { f(); console.log('ok   ' + n); } catch (e) { bad++; console.log('FAIL ' + n + ': ' + e.message); } };
  const ok200 = json => ({ status: 200, json });
  const base = () => ({ snapshot: ok200({ runs: [], queues: [] }), cron: ok200({ jobs: [] }), loops: ok200({ loops: [] }), dispatcher: {}, lanes: {}, crew: { founder: { name: 'Founder' } } });
  t('an empty station is idle', () => { const r = busyFrom(base(), now); assert.ok(r.readable && !r.items.length); });
  t('a run in the run table holds it (named, with its age)', () => { const v = base(); v.snapshot.json.runs.push({ runId: 'r-27turns', agentId: 'founder', source: 'cron', startedAt: now - 25 * 60000 }); const r = busyFrom(v, now); assert.ok(r.items.length === 1 && /Founder \(cron run r-27turns, 25 min\)/.test(r.items[0].what), JSON.stringify(r)); });
  t('a run that writes nothing to station.log still holds it (the rule never reads the log)', () => { const v = base(); v.snapshot.json.runs.push({ runId: 'quiet', agentId: 'x' }); assert.strictEqual(busyFrom(v, now).items.length, 1); });
  t('a queued turn holds it', () => { const v = base(); v.snapshot.json.queues.push({ agentId: 'founder', depth: 1 }); assert.strictEqual(busyFrom(v, now).items[0].source, 'queue'); });
  t('a cron lease the run table does not list holds it; one it lists is counted once', () => {
    const v = base(); v.cron.json.jobs.push({ id: 'j1', name: 'Founder loop', agentId: 'founder', inFlight: true, inFlightRunId: 'r1' }, { id: 'j2', name: 'Ops', state: 'running' });
    assert.strictEqual(busyFrom(v, now).items.length, 2);
    v.snapshot.json.runs.push({ runId: 'r1', agentId: 'founder' }); assert.strictEqual(busyFrom(v, now).items.length, 2, 'r1 once (run) + Ops');
  });
  t('a running goal loop holds it', () => { const v = base(); v.loops.json.loops.push({ id: 'l1', state: 'running' }); assert.strictEqual(busyFrom(v, now).items[0].source, 'loop'); });
  t('no /api/loops on this station is not a reason to wait', () => { const v = base(); v.loops = { status: 404 }; assert.ok(!busyFrom(v, now).items.length); });
  t('an unreadable station is BUSY, never idle', () => { const v = base(); v.snapshot = { status: 0, error: 'ECONNREFUSED' }; const r = busyFrom(v, now); assert.ok(!r.readable && r.items.length); v.snapshot = ok200({ runs: [] }); v.cron = { status: 500 }; assert.ok(!busyFrom(v, now).readable); });
  t('a dispatcher tick in progress holds it; a stale or dead one does not', () => {
    const v = base(); v.dispatcher = { status: 'ticking', pid: process.pid, lastTickAt: new Date(now - 60000).toISOString() }; assert.strictEqual(busyFrom(v, now).items[0].source, 'dispatcher');
    v.dispatcher.lastTickAt = new Date(now - 3600e3).toISOString(); assert.ok(!busyFrom(v, now).items.length, 'an hour-old tick is not running');
    v.dispatcher = { status: 'ticking', pid: 999999999, lastTickAt: new Date(now - 60000).toISOString() }; assert.ok(!busyFrom(v, now).items.length, 'dead pid');
  });
  t('a lane the dispatcher just started holds it until the station lists it; an old one is the station\'s call', () => {
    const v = base(); v.lanes = { lanes: [{ id: 'eng/1', runId: 'rl', startedAt: new Date(now - 30000).toISOString() }] }; assert.strictEqual(busyFrom(v, now).items[0].source, 'lane');
    v.lanes.lanes[0].startedAt = new Date(now - 3600e3).toISOString(); assert.ok(!busyFrom(v, now).items.length);
  });
  t('a reason that already says "load" is not doubled', () => { assert.strictEqual(loadWhat('patch 0013'), 'load patch 0013'); assert.strictEqual(loadWhat('load the systemctl guard'), 'load the systemctl guard'); assert.strictEqual(loadWhat('to load patch 9'), 'load patch 9'); assert.strictEqual(loadWhat('Loader fix'), 'load Loader fix'); });
  console.log(bad ? bad + ' FAILED' : 'all checks passed'); return bad ? 1 : 0;
}

module.exports = { busyFrom, inFlight, loadWhat, _internals: { S, args } };
if (require.main === module) {
  const a = args(process.argv.slice(2));
  if (a._[0] === 'selftest' || process.argv.includes('--selftest')) process.exit(selftest());
  run(a).then(c => process.exit(c), e => { console.error('restart-station: ' + (e && e.stack || e)); process.exit(2); });
}
