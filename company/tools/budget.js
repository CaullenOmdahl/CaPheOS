#!/usr/bin/env node
/* budget.js — the station's spending caps follow the company's settings, and every run carries a door (docs/BUDGET.md).
 *
 *   node company/tools/budget.js apply --by <name> [--dry-run] [--json]
 *        project the CURRENT settings onto the station's caps (POST /api/budget/caps): perDay = today's daily metered
 *        budget (dispatch-budget.json dailyUsd, or the owner's raise for today, money-hold); perAgent = 0. Nothing else is
 *        touched (perRun, global). The station is the backstop while the dispatcher is the only starter.
 *   node company/tools/budget.js drift [--json]      read the station's caps now; exit 1 naming both numbers on a mismatch
 *   node company/tools/budget.js --duty              the budget-drift duty (docs/DUTIES.md): the same comparison against the
 *                                                    snapshot the dispatcher tick took (duties open no socket), plus the
 *                                                    scheduler: with runtime.scheduler=dispatcher no crew loop routine may
 *                                                    be armed on the station, and no station-scheduled run may have started
 *   node company/tools/budget.js snapshot             what the dispatcher tick does each tick: the station's caps and routines
 *                                                    into company/state/station-caps.json (the duty's input)
 *   node company/tools/budget.js doors [--hours 24] [--json]    each station run in the window -> the door that started it
 *   node company/tools/budget.js coverage [--hours 24] [--json] the same; exit 1 if any run has no door (unattributed)
 *   node company/tools/budget.js status [--json]     the projection, the last snapshot, admit() counts by door
 *   node company/tools/budget.js --selftest
 *
 * The projection, and why (phase 1: semantics unchanged, only the numbers are copied):
 *   spendCap guardrail off       perDay 0 (the station's "no cap"): the company holds nothing, so the backstop holds nothing
 *   daily budget > 0             perDay = that number
 *   daily budget 0 ("nothing metered runs")   perDay = $0.000001 — the station's 0 means NO cap, so "closed" is its smallest cap
 *   perAgent                     always 0 (no cap): the station's per-agent cap is ALL-TIME per agent, the company's share
 *                                (perAgentUsd) is per 24 h and stays the dispatcher's rule; an all-time cap would freeze a seat
 * The station counts its calendar day and the company a rolling 24 h; one window for both is phase 2 (window.js).
 * Owner: the finance function. Changes only the station's caps (apply) and company/state/station-caps.json (snapshot).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');

const CLOSED_USD = 0.000001;
const r6 = n => Math.round(Number(n) * 1e6) / 1e6;
const F = {
  budget: () => co.p('company', 'work', 'finance', 'dispatch-budget.json'),
  snapshot: () => co.p('company', 'state', 'station-caps.json'),
  runs: () => co.p('.starnet-data', 'workspaces', 'runs.jsonl'),
  log: () => co.p('company', 'work', 'finance', 'budget-apply.jsonl'),
};
const S = {   // seams (tests)
  call: (m, p, b) => require('./station-crew.js').call(m, p, b, 15000),
  now: () => Date.now(),
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const usd = n => n === CLOSED_USD ? '$0 (closed: $0.000001 on the station)' : Number(n) === 0 ? '$0 (no cap)' : '$' + r6(n);

/* the framework settings, read the way dispatch.js reads them */
function settings() {
  const b = readJson(F.budget(), {}) || {};
  const envDef = Number(process.env.DISPATCH_DAILY_USD) > 0 ? Number(process.env.DISPATCH_DAILY_USD) : 2;
  const base = (typeof b.dailyUsd === 'number' && Number.isFinite(b.dailyUsd) && b.dailyUsd >= 0) ? b.dailyUsd : envDef;
  const today = require('./lib/money-hold').capToday(co.ROOT, base, S.now());
  return { capOn: co.guard('spendCap'), baseDailyUsd: base, dailyUsd: today, raisedToday: today !== base, perAgentUsd: Number(b.perAgentUsd) > 0 ? Number(b.perAgentUsd) : 0 };
}
/* projection(settings) -> { perDay, perAgent, from: {perDay, perAgent} } — pure */
function projection(s) {
  const perDay = !s.capOn ? 0 : s.dailyUsd > 0 ? r6(s.dailyUsd) : CLOSED_USD;
  return {
    perDay, perAgent: 0,
    from: {
      perDay: !s.capOn ? 'the spendCap guardrail is off (nothing is held), so the station holds nothing either'
        : 'dispatch-budget.json dailyUsd $' + r6(s.baseDailyUsd) + (s.raisedToday ? ', raised to $' + r6(s.dailyUsd) + ' for today by the owner (today-budget.json)' : '') + (s.dailyUsd > 0 ? '' : ': 0 means nothing metered runs, the station\'s smallest cap'),
      perAgent: 'always no cap: the station\'s per-agent cap is all-time; the company\'s per-agent share' + (s.perAgentUsd ? ' ($' + s.perAgentUsd + ' per 24 h)' : '') + ' stays the dispatcher\'s rule',
    },
  };
}
const same = (a, b) => Math.abs(Number(a) - Number(b)) < 5e-7;
/* compare(want, caps) -> [{ cap, station, framework, why }] — pure */
function compare(want, caps) {
  const out = [];
  if (!caps) return [{ cap: 'caps', station: null, framework: null, why: 'the station did not report its caps' }];
  for (const k of ['perDay', 'perAgent']) {
    const st = Number(caps[k]) || 0;
    if (!same(st, want[k])) out.push({ cap: k, station: st, framework: want[k], why: k + ': the station holds ' + usd(st) + ', the company setting is ' + usd(want[k]) + ' (' + want.from[k] + ')' });
  }
  return out;
}
async function stationCaps() {
  const r = await S.call('GET', '/api/budget/status');
  if (!r || r.status !== 200) throw new Error('GET /api/budget/status: HTTP ' + (r && r.status));
  const j = JSON.parse(r.body); return j.caps || null;
}

/* the scheduler half of drift: in dispatcher mode no crew loop is armed and the watchdog exists — pure */
function schedulerDrift(jobs, crew, m) {
  const SCHED = require('./lib/scheduler');
  if (m !== 'dispatcher' || !Array.isArray(jobs)) return [];
  const out = [];
  for (const [seat, c] of Object.entries(crew || {})) {
    const j = c && c.loop ? SCHED.crewLoopOf(jobs, c.loop) : null;
    if (j && j.enabled !== false) out.push({ cap: 'schedule', seat, why: 'the routine "' + j.name + '" is armed on the station schedule while the dispatcher owns the schedule (runtime.scheduler=dispatcher): the station could start work around admit()' });
  }
  if (!SCHED.ownWatchdogs(jobs).length) out.push({ cap: 'watchdog', why: 'no watchdog routine on the station: nothing would notice a silent dispatcher (node company/tools/budget-migrate.js --to dispatcher)' });
  return out;
}

async function snapshot(o) {
  o = o || {};
  const call = o.call || S.call;
  let caps = null, err = null;
  try { const r = await call('GET', '/api/budget/status'); if (r && r.status === 200) caps = (JSON.parse(r.body) || {}).caps || null; else err = 'HTTP ' + (r && r.status); } catch (e) { err = String(e.message || e).slice(0, 160); }
  const jobs = (o.jobs || []).map(j => ({ id: j.id, name: j.name, enabled: j.enabled !== false, noAgent: !!j.noAgent, script: j.script || null, workdir: j.workdir || null }));
  const doc = { _doc: 'The station\'s spending caps and routines as the dispatcher tick last saw them (budget.js snapshot), for the budget-drift duty, which opens no socket.', at: new Date(S.now()).toISOString(), caps, error: err, jobs };
  const f = F.snapshot(); fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n'); fs.renameSync(tmp, f);
  return doc;
}

async function apply(o) {
  o = o || {};
  if (!o.by) return { ok: false, code: 2, error: '--by <name> is required: the cap change is recorded with who asked' };
  const want = projection(settings());
  const caps = await stationCaps();
  const diff = compare(want, caps);
  if (!diff.length) return { ok: true, changed: false, want, caps, note: 'the station already holds the company settings' };
  const patch = {}; for (const d of diff) patch[d.cap] = want[d.cap];
  if (o.dry) return { ok: true, dry: true, changed: false, want, caps, patch, diff };
  const r = await S.call('POST', '/api/budget/caps', patch);
  if (!r || r.status !== 200) return { ok: false, code: 1, error: 'POST /api/budget/caps: HTTP ' + (r && r.status) + ' ' + String(r && r.body).slice(0, 200), want, caps };
  const after = ((JSON.parse(r.body) || {}).caps) || null;
  try { fs.mkdirSync(path.dirname(F.log()), { recursive: true }); fs.appendFileSync(F.log(), JSON.stringify({ at: new Date(S.now()).toISOString(), by: String(o.by).slice(0, 80), from: caps && { perDay: caps.perDay, perAgent: caps.perAgent }, to: patch, why: diff.map(d => d.why) }) + '\n'); } catch (_) {}
  return { ok: true, changed: true, want, caps: after, patch, diff };
}
async function drift() {
  const want = projection(settings());
  const caps = await stationCaps();
  let jobs = null; try { const r = await S.call('GET', '/api/cron'); if (r.status === 200) jobs = JSON.parse(r.body).jobs; } catch (_) {}
  const diff = compare(want, caps).concat(schedulerDrift(jobs, co.crew(), require('./lib/scheduler').mode()));
  return { ok: !diff.length, want, caps, diff };
}

/* the duty: offline, from the snapshot and the run/admit logs */
function dutyResult(o) {
  o = o || {};
  const snap = o.snapshot !== undefined ? o.snapshot : readJson(F.snapshot(), null);
  const now = o.now || S.now();
  if (!snap) return null;   // no tick has looked yet: nothing to judge (the tick takes one every time)
  if (Date.now() - Date.parse(snap.at || 0) > 6 * 3600e3 && !o.now) return null;   // stale: the liveness checks own a silent dispatcher
  const want = projection(o.settings || settings());
  const items = [];
  for (const d of (snap.caps ? compare(want, snap.caps) : [])) items.push({ id: 'cap:' + d.cap, route: 'finance', reason: d.why });
  const m = o.mode || require('./lib/scheduler').mode();
  for (const d of schedulerDrift(snap.jobs, o.crew || co.crew(), m)) items.push({ id: d.cap + ':' + (d.seat || 'station'), route: 'tools', reason: d.why });
  if (m === 'dispatcher') {
    const sinceMs = Math.max(now - 24 * 3600e3, Date.parse((require('./lib/scheduler').readState().at) || 0) || 0);
    const att = doors({ sinceMs, runs: o.runs, rows: o.rows });
    const sched = att.runs.filter(r => r.door === 'schedule');
    if (sched.length) items.push({ id: 'schedule-runs', route: 'tools', reason: sched.length + ' run(s) started by the station\'s own schedule since the dispatcher took the schedule over (first ' + sched[0].runId + '): the station must only run the watchdog' });
  }
  if (!items.length) return null;
  return { due: true, reason: items.length + ' budget/scheduler drift finding(s): ' + items.map(i => i.id).join(', '), key: items.map(i => i.id).sort().join(','), items: items.map(i => ({ id: i.id, route: i.route })) };
}

/* doors({hours|sinceMs}) -> { runs: [...attributed], byDoor, unattributed } */
function doors(o) {
  o = o || {};
  const A = require('./lib/admit');
  const sinceMs = Number.isFinite(o.sinceMs) ? o.sinceMs : S.now() - (Number(o.hours) > 0 ? Number(o.hours) : 24) * 3600e3;
  const runs = o.runs || require('./lib/bounded').jsonlWindow(F.runs(), { sinceMs }).rows.filter(r => r && !r.internal && (Number(r.startedAt) || Number(r.ts) || 0) >= sinceMs);
  const rows = o.rows || A.rows({ sinceMs: sinceMs - 3600e3 });
  const att = A.attribute(runs, rows);
  const byDoor = {}; for (const r of att) { const k = r.door || 'unattributed'; byDoor[k] = (byDoor[k] || 0) + 1; }
  return { sinceMs, runs: att, byDoor, unattributed: att.filter(r => !r.door) };
}

async function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  const p = s => projection(Object.assign({ capOn: true, baseDailyUsd: 5, dailyUsd: 5, raisedToday: false, perAgentUsd: 0 }, s));
  ok('a $5 day projects perDay $5, perAgent no cap', p({}).perDay === 5 && p({}).perAgent === 0);
  ok('a $0 day projects the station\'s smallest cap (its 0 means no cap)', p({ dailyUsd: 0, baseDailyUsd: 0 }).perDay === CLOSED_USD);
  ok('spendCap guardrail off projects no cap', p({ capOn: false }).perDay === 0);
  ok('the owner\'s raise for today is what is projected', p({ dailyUsd: 8, raisedToday: true }).perDay === 8 && /raised to \$8/.test(p({ dailyUsd: 8, raisedToday: true }).from.perDay));
  ok('a per-agent share is never projected (the station\'s is all-time)', p({ perAgentUsd: 2 }).perAgent === 0);
  const d = compare(p({ dailyUsd: 7, baseDailyUsd: 7 }), { perDay: 5, perAgent: 0 });
  ok('drift names both numbers', d.length === 1 && /\$5/.test(d[0].why) && /\$7/.test(d[0].why), JSON.stringify(d));
  ok('no drift when they agree', compare(p({}), { perDay: 5.0000001, perAgent: 0 }).length === 0);
  ok('an all-time per-agent cap on the station is drift', compare(p({}), { perDay: 5, perAgent: 3 }).length === 1);
  const jobs = [{ id: 'a', name: 'Founder loop', enabled: true }, { id: 'w', name: require('./lib/scheduler').WATCHDOG.name, noAgent: true, script: 'company/tools/watchdog.js', enabled: true }];
  ok('dispatcher mode: an armed crew loop is drift', schedulerDrift(jobs, { agent: { loop: 'Founder loop' } }, 'dispatcher').length === 1);
  ok('station mode: armed loops are the old way, no drift', schedulerDrift(jobs, { agent: { loop: 'Founder loop' } }, 'station').length === 0);
  ok('dispatcher mode without a watchdog is drift', schedulerDrift([{ id: 'a', name: 'Founder loop', enabled: false }], { agent: { loop: 'Founder loop' } }, 'dispatcher').some(x => x.cap === 'watchdog'));
  ok('the duty is quiet without a snapshot', dutyResult({ snapshot: null }) === null);
  const dr = dutyResult({ snapshot: { at: new Date().toISOString(), caps: { perDay: 25, perAgent: 0 }, jobs: [] }, settings: { capOn: true, baseDailyUsd: 5, dailyUsd: 5, perAgentUsd: 0 }, mode: 'station', crew: {}, now: Date.now() });
  ok('the duty is due on a cap drift, routed to finance, by id only', dr && dr.due && dr.items[0].id === 'cap:perDay' && dr.items[0].route === 'finance', JSON.stringify(dr));
  console.log(bad ? 'BUDGET SELFTEST FAILED: ' + bad : 'BUDGET SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { S, F, CLOSED_USD, settings, projection, compare, schedulerDrift, snapshot, apply, drift, dutyResult, doors };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const json = a.includes('--json');
  const print = (o, text) => console.log(json ? JSON.stringify(o, null, 1) : text);
  (async () => {
    if (a.includes('--selftest') || a[0] === 'selftest') return selftest();
    if (a.includes('--duty')) { const r = dutyResult(); if (r) console.log(JSON.stringify(r)); return r ? 1 : 0; }
    const cmd = a[0] || 'status';
    if (cmd === 'apply') {
      const r = await apply({ by: opt('by'), dry: a.includes('--dry-run') });
      if (!r.ok) { console.error('budget.js apply: ' + r.error); return r.code || 1; }
      print(r, r.dry ? 'would set ' + JSON.stringify(r.patch) + ':\n  ' + r.diff.map(x => x.why).join('\n  ') : r.changed ? 'station caps set: ' + JSON.stringify(r.patch) + ' (perDay ' + usd(r.want.perDay) + ', perAgent no cap)' : r.note);
      return 0;
    }
    if (cmd === 'drift') {
      const r = await drift();
      print(r, r.ok ? 'no drift: the station holds the company settings (perDay ' + usd(r.want.perDay) + ', perAgent no cap)' : 'DRIFT:\n  ' + r.diff.map(x => x.why).join('\n  ') + '\nfix: node company/tools/budget.js apply --by <you>' + (r.diff.some(x => x.cap === 'schedule' || x.cap === 'watchdog') ? ' ; node company/tools/budget-migrate.js --to dispatcher --by owner' : ''));
      return r.ok ? 0 : 1;
    }
    if (cmd === 'snapshot') {
      let jobs = []; try { const r = await S.call('GET', '/api/cron'); if (r.status === 200) jobs = JSON.parse(r.body).jobs || []; } catch (_) {}
      const d = await snapshot({ jobs }); print(d, 'snapshot ' + d.at + ': caps ' + JSON.stringify(d.caps) + (d.error ? ' (error ' + d.error + ')' : '') + ', ' + d.jobs.length + ' routines'); return d.error ? 1 : 0;
    }
    if (cmd === 'doors' || cmd === 'coverage') {
      const r = doors({ hours: Number(opt('hours')) || 24 });
      const lines = Object.entries(r.byDoor).sort((x, y) => y[1] - x[1]).map(([k, n]) => '  ' + k.padEnd(14) + n);
      print(r, r.runs.length + ' run(s) since ' + new Date(r.sinceMs).toISOString() + ' by door:\n' + (lines.join('\n') || '  (none)') + (r.unattributed.length ? '\nUNATTRIBUTED: ' + r.unattributed.map(x => x.runId + ' (' + x.agentId + ')').join(', ') : ''));
      return cmd === 'coverage' && r.unattributed.length ? 1 : 0;
    }
    if (cmd === 'status') {
      const s = settings(), w = projection(s);
      const o = { settings: s, projection: w, snapshot: readJson(F.snapshot(), null), counts24h: require('./lib/admit').counts({ sinceMs: S.now() - 24 * 3600e3 }), scheduler: require('./lib/scheduler').mode() };
      print(o, 'projection: perDay ' + usd(w.perDay) + ' (' + w.from.perDay + '); perAgent no cap\nscheduler: ' + o.scheduler + '\nadmit() last 24 h: ' + JSON.stringify(o.counts24h));
      return 0;
    }
    console.error('usage: budget.js apply --by <name> [--dry-run] | drift | --duty | doors|coverage [--hours N] | status [--json] | --selftest'); return 2;
  })().then(c => process.exit(c || 0), e => { console.error('budget.js: ' + (e && e.message || e)); process.exit(1); });
}
