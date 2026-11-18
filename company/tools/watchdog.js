#!/usr/bin/env node
/* watchdog.js — the only thing the station's schedule runs when the dispatcher owns the schedule (docs/BUDGET.md).
 *
 * With company.json runtime.scheduler = "dispatcher" the crew's loop routines are paused on the station and the
 * dispatcher starts every run. The station keeps ONE routine: "Watchdog (dispatcher liveness, starts no work) #<6 hex>",
 * a script-only routine (noAgent, lib/scheduler.js WATCHDOG) that runs this file every 15 minutes. It:
 *   1. records itself through admit() (door watchdog, kind watchdog), so the station schedule's every act is counted;
 *   2. reads how long the dispatcher has been silent (company/state/dispatcher-loop.json lastTickEndAt / lastTickAt, else
 *      the dispatch log's age) against max(3 dispatcher ticks, 30 min);
 *   3. silent: tells the owner ONCE per outage, as a TOP PRIORITY owner message (owner-inbox.js send, priority "top"),
 *      and writes a row to company/work/ops/watchdog-alerts.jsonl; back: tells the owner once that it recovered;
 *   4. ends with the line {"wakeAgent":false}: the station never wakes an agent for it. It makes no station call, starts
 *      no run and changes no routine — while the dispatcher is down nothing in the company starts, by design.
 * It always exits 0 (a failing routine script would be counted as a failing routine and paused by the station).
 *
 *   node company/tools/watchdog.js            one check (what the station runs)
 *   node company/tools/watchdog.js status     the last check and any open outage, JSON
 *   node company/tools/watchdog.js --selftest
 * Env (tests): WATCHDOG_NOW (ms).
 * Owner: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');

const F = {
  loop: () => co.p('company', 'state', 'dispatcher-loop.json'),
  log: () => co.p('company', 'work', 'dispatch-log.md'),
  state: () => co.p('company', 'state', 'watchdog.json'),
  alerts: () => co.p('company', 'work', 'ops', 'watchdog-alerts.jsonl'),
  cadence: () => co.p('company', 'work', 'ops', 'cadence.json'),
  cadenceDefault: () => co.p('company', 'defaults', 'work', 'ops', 'cadence.json'),
};
const MIN_SILENT_MIN = 30;
const now = () => Number(process.env.WATCHDOG_NOW) || Date.now();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); };
const local = ms => { const p = co.localParts(new Date(ms)); return p.date + ' ' + p.time; };

function tickMin() {
  let base = 10;
  for (const f of [F.cadence(), F.cadenceDefault()]) { const n = Number((readJson(f, {}) || {}).dispatcherTickMin); if (Number.isFinite(n) && n > 0) { base = n; break; } }
  const eff = Number(((readJson(F.loop(), null) || {}).tempo || {}).tickMin);
  return Number.isFinite(eff) && eff > base ? eff : base;
}
/* when the dispatcher was last heard: the loop's last tick end (or start), else the dispatch log's last write */
function lastHeard() {
  const lp = readJson(F.loop(), null) || {};
  const ts = [lp.lastTickEndAt, lp.lastTickAt].map(x => Date.parse(x || '')).filter(Number.isFinite);
  let logAt = null; try { logAt = fs.statSync(F.log()).mtimeMs; } catch (_) {}
  const all = ts.concat(logAt != null ? [logAt] : []);
  return all.length ? Math.max(...all) : null;
}
/* judge({ now, lastAt, tickMin }) -> { silent, silentMin, limitMin } — pure */
function judge(o) {
  const limitMin = Math.max(MIN_SILENT_MIN, 3 * (Number(o.tickMin) || 10));
  if (o.lastAt == null) return { silent: true, silentMin: null, limitMin, never: true };
  const silentMin = Math.max(0, Math.round((o.now - o.lastAt) / 60000));
  return { silent: silentMin > limitMin, silentMin, limitMin };
}

function check(o) {
  o = o || {};
  const t = Number.isFinite(o.now) ? o.now : now();
  // urgent (lib/owner-notice.js): the company cannot work; shown first in the console (priority top)
  const notify = o.notify || (text => require('./lib/owner-notice').send({ kind: 'urgent', from: 'Watchdog', text, priority: 'top' }));
  let ticket = null; try { ticket = require('./lib/admit').admit({ door: 'watchdog', kind: 'watchdog', seat: null, why: 'station schedule: the liveness check (starts no work)' }, { now: t }); } catch (_) {}
  const st = readJson(F.state(), {}) || {};
  const lastAt = lastHeard();
  const v = judge({ now: t, lastAt, tickMin: tickMin() });
  const svc = ((co.config.station || {}).serviceName || 'capheos-station') + '-dispatch.service';
  const out = { at: new Date(t).toISOString(), lastHeard: lastAt ? new Date(lastAt).toISOString() : null, silentMin: v.silentMin, limitMin: v.limitMin, silent: v.silent, alerted: false, recovered: false, admitted: ticket ? ticket.decision : null };
  if (v.silent) {
    if (!st.outage) st.outage = { since: lastAt ? new Date(lastAt).toISOString() : null, detectedAt: out.at };
    if (!st.outage.alertedAt) {
      const text = 'TOP PRIORITY: the dispatcher has been silent for ' + (v.never ? 'as long as this company has a record (it never ran)' : v.silentMin + ' minutes (last heard ' + local(lastAt) + ')') + '. While it is down NOTHING in the company starts: no seat is woken, no scheduled loop runs, no work happens (the station\'s own schedule runs only this watchdog). Start it again: `systemctl --user restart ' + svc + '` and look at `journalctl --user -u ' + svc + ' -n 50`.';
      try { const row = notify(text); st.outage.alertId = (row && row.id) || null; } catch (e) { st.outage.alertError = String(e.message || e).slice(0, 200); }
      st.outage.alertedAt = out.at; out.alerted = true;
      try { fs.mkdirSync(path.dirname(F.alerts()), { recursive: true }); fs.appendFileSync(F.alerts(), JSON.stringify({ at: out.at, kind: 'dispatcher-silent', priority: 'top', silentMin: v.silentMin, limitMin: v.limitMin, lastHeard: out.lastHeard }) + '\n'); } catch (_) {}
    }
  } else if (st.outage) {
    if (st.outage.alertedAt) {
      try { notify('The dispatcher is running again (heard ' + local(lastAt) + '; it was silent from ' + (st.outage.since ? local(Date.parse(st.outage.since)) : 'the start') + '). The crew is woken as usual.'); } catch (_) {}
      try { fs.appendFileSync(F.alerts(), JSON.stringify({ at: out.at, kind: 'dispatcher-recovered', priority: 'info', since: st.outage.since }) + '\n'); } catch (_) {}
      out.recovered = true;
    }
    st.lastOutage = Object.assign({}, st.outage, { endedAt: out.at }); st.outage = null;
  }
  st.lastCheck = out;
  try { writeJson(F.state(), Object.assign({ _doc: 'company/tools/watchdog.js: the station-scheduled dispatcher liveness check. outage: the open outage (alerted once). Written only by watchdog.js.' }, st)); } catch (_) {}
  return out;
}

function selftest() {
  const os = require('os');
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  ok('silent past 3 ticks (min 30 min) is an outage', judge({ now: 100 * 60e3, lastAt: 50 * 60e3, tickMin: 10 }).silent === true);
  ok('20 min is not an outage at a 10 min tick', judge({ now: 70 * 60e3, lastAt: 50 * 60e3, tickMin: 10 }).silent === false);
  ok('a slow tick (20 min) raises the limit to 60 min', judge({ now: 100 * 60e3, lastAt: 50 * 60e3, tickMin: 20 }).silent === false);
  ok('never heard = silent', judge({ now: 1, lastAt: null, tickMin: 10 }).silent === true);
  const src = fs.readFileSync(__filename, 'utf8');
  ok('the watchdog makes no station call and starts no run', !/\/api\/(cron\/run|run\b|cron\/update)|stationToken|http\.request/.test(src.replace(/ok\('the watchdog makes[^\n]*\n/, '')));
  // one full check in a temp company: one alert per outage, then one recovery
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-selftest-'));
  const save = { root: co.ROOT };
  try {
    const P = (...a) => path.join(T, ...a);
    for (const k of Object.keys(F)) { const rel = path.relative(save.root, F[k]()); F[k] = () => P(rel); }
    process.env.ADMIT_LOG = P('company', 'state', 'admit-log.jsonl');
    writeJson(P('company', 'state', 'dispatcher-loop.json'), { lastTickEndAt: new Date(Date.now() - 2 * 3600e3).toISOString() });
    const told = []; const n = text => { told.push(text); return { id: 'out-' + told.length }; };
    const a = check({ now: Date.now(), notify: n }), b = check({ now: Date.now() + 60e3, notify: n });
    ok('a silent dispatcher: one top-priority alert, not two', a.alerted && !b.alerted && told.length === 1 && /^TOP PRIORITY/.test(told[0]), JSON.stringify(told));
    ok('the check is admitted and counted (door watchdog)', fs.readFileSync(process.env.ADMIT_LOG, 'utf8').split('\n').filter(l => /"door":"watchdog"/.test(l)).length === 2);
    writeJson(P('company', 'state', 'dispatcher-loop.json'), { lastTickEndAt: new Date().toISOString() });
    const c = check({ now: Date.now() + 120e3, notify: n });
    ok('recovery is told once', c.recovered && told.length === 2 && /running again/.test(told[1]));
  } finally { delete process.env.ADMIT_LOG; try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} }
  console.log(bad ? 'WATCHDOG SELFTEST FAILED: ' + bad : 'WATCHDOG SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { check, judge, lastHeard, F };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest') || a[0] === 'selftest') process.exit(selftest());
  if (a[0] === 'status') { console.log(JSON.stringify(readJson(F.state(), {}), null, 1)); process.exit(0); }
  let r = null;
  try { r = check(); console.log('watchdog: dispatcher ' + (r.silent ? 'SILENT ' + (r.silentMin == null ? '(never ran)' : r.silentMin + ' min') + (r.alerted ? ', owner told (top priority)' : ', owner already told') : 'alive (' + r.silentMin + ' min since its last tick)')); }
  catch (e) { console.log('watchdog: check failed: ' + String(e.message || e).slice(0, 200)); }
  console.log(JSON.stringify({ wakeAgent: false }));
  process.exit(0);
}
