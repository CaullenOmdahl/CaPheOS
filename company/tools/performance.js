#!/usr/bin/env node
/* performance.js — is each person doing their job? Read from the station's own records, no LLM.
 *
 * For every crew member in company/tools/loops.json, over the last windowHours (company/model-policy.json "performance"):
 *   runs and failures of their own routines (a run that did not end "done"), the current streak of failed runs, whether
 *   StarNet has switched their routine off, and OPEN handoffs to them that are past their deadline.
 * A person is flagged when (thresholds in company/model-policy.json):
 *   failing    — consecutiveFailures or more routine runs in a row did not finish, or their routine was switched off
 *   unreliable — failureRate or more of at least minRunsForRate runs failed
 *   overdue    — 2 or more OPEN handoffs are overdueDays or more past deadline
 *
 *   node company/tools/performance.js report     # writes company/work/performance.md and prints the JSON
 *   node company/tools/performance.js flags      # JSON of flagged people only (the dispatcher uses this)
 *
 * What happens to a flag: the dispatcher hands it to the people function holder once a day per person, with an FYI to
 * the person's manager; the people owner and the manager decide fix, re-model or replace (the people owner alone when the
 * manager is the CEO). A "limit" flag (runs stopped by a spending or token limit) goes to the tools owner, because it is
 * the limit, not the person. A flag about the CEO goes to the CEO; replacing the CEO is the owner's call
 * (company/MODEL_POLICY.md).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const co = require('./lib/company');
const ROOT = co.ROOT;
const RUNS = co.p('.starnet-data', 'workspaces', 'runs.jsonl');
const LOOPS = co.LOOPS_FILE;
const POLICY = co.p('company', 'model-policy.json');
const HANDOFFS = co.p('company', 'work', 'handoffs');
const REPORT = co.p('company', 'work', 'performance.md');
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } };
// what a run's end usually means, so the people owner does not blame a person for a limit we set
const CAUSE = { budget: 'hit a spending or token limit (check the limit before the person)', error: 'errored (provider, tool or prompt; read the run)',
  max_iters: 'ran out of steps', refusal: 'the model refused (try another model family)' };
function causeOf(r) { return (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') ? 'refusal' : (r.reason || 'unknown'); }
// a run stopped from outside (cancelled) or cut off by a restart (interrupted) is not the person's failure: StarNet's own
// routine counter treats it the same way (cron-store: "a stop is no failure")
const NOT_THEIRS = new Set(['cancelled', 'interrupted']);

function cronJobs() {
  return new Promise(resolve => {
    let settled = false; const done = v => { if (!settled) { settled = true; resolve(v); } };
    let token = ''; try { token = co.stationToken(); } catch (_) { done([]); return; }
    const station = new URL(co.STATION_URL);
    const req = http.request({ hostname: station.hostname, port: station.port || 80, path: '/api/cron', method: 'GET', timeout: 10000, headers: { 'x-starnet-token': token } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { done(JSON.parse(d).jobs || []); } catch (_) { done([]); } });
      res.on('error', () => done([])); res.on('close', () => done([]));
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', () => done([])); req.end();
  });
}
// the instant a YYYY-MM-DD deadline day ends in the company timezone (co.TZ)
function endOfDayInTz(day) {
  const guess = Date.parse(day + 'T23:59:00Z');
  const lp = co.localParts(new Date(guess));
  const [y, m, d] = lp.date.split('-').map(Number);
  const offsetMs = Date.UTC(y, m - 1, d, lp.hour, lp.minute) - guess;   // local wall clock minus UTC
  return guess - offsetMs + 59000;
}
function overdueHandoffs(inbox, days) {
  let txt = ''; try { txt = fs.readFileSync(path.join(HANDOFFS, inbox), 'utf8'); } catch (_) { return []; }
  const out = []; const now = Date.now();
  for (const sec of txt.split(/^## /m).slice(1)) {
    if (!/^\*\*Status:\*\*\s*OPEN\b/m.test(sec)) continue;
    const m = sec.match(/^\*\*Deadline:\*\*\s*(\d{4}-\d{2}-\d{2})/m);
    if (!m) continue;
    const late = (now - endOfDayInTz(m[1])) / 86400000;
    if (late >= days) out.push({ heading: sec.split('\n')[0].trim().slice(0, 120), deadline: m[1], daysLate: Math.floor(late) });
  }
  return out;
}

async function assess(opts) {
  opts = opts || {};
  const policy = readJson(POLICY, {}).performance || {};
  const P = { consecutiveFailures: 3, failureRate: 0.5, minRunsForRate: 6, windowHours: 72, overdueDays: 2, ...policy };
  const crew = (readJson(LOOPS, {}).agents) || {};
  const since = Date.now() - P.windowHours * 3600e3;
  const runs = [];
  try { for (const l of require('./lib/bounded').jsonlWindowText(RUNS, since).split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r.cronJobId && r.startedAt >= since) runs.push(r); } catch (_) {} } } catch (_) {}
  const jobs = Array.isArray(opts.jobs) ? opts.jobs : await cronJobs();
  const people = [];
  for (const [id, c] of Object.entries(crew)) {
    const all = runs.filter(r => r.agentId === id && !NOT_THEIRS.has(r.reason)).sort((a, b) => a.startedAt - b.startedAt);
    // a model refusal (safety filter) is a limit of the model, not the person's failure: counted apart, flagged as model fit
    const refusedRuns = all.filter(r => causeOf(r) === 'refusal');
    const mine = all.filter(r => causeOf(r) !== 'refusal');
    const failed = mine.filter(r => r.reason !== 'done');
    let streak = 0; for (let i = mine.length - 1; i >= 0 && mine[i].reason !== 'done'; i--) streak++;
    const streakRuns = mine.slice(mine.length - streak);
    const myJobs = jobs.filter(j => j.agentId === id);
    const switchedOff = myJobs.filter(j => j.enabled === false && j.disabledReason === 'consecutive-failures').map(j => j.name);
    const overdue = overdueHandoffs(c.inbox || '', P.overdueDays);
    const reasons = {}; for (const r of (streak ? streakRuns : failed)) { const k = causeOf(r); reasons[k] = (reasons[k] || 0) + 1; }
    const limitOnly = streak > 0 && streakRuns.every(r => r.reason === 'budget' || /quota|usage_limit|rate_limit/.test(String(r.failureCode || '')));   // a provider at its usage limit is a limit, not the person failing
    const flags = [];
    if (streak >= P.consecutiveFailures) flags.push(limitOnly
      ? { type: 'limit', why: streak + ' routine runs in a row were stopped by a spending, token or usage limit' }
      : { type: 'failing', why: streak + ' routine runs in a row did not finish (' + Object.entries(reasons).map(([k, v]) => v + ' ' + k).join(', ') + ')' });
    if (switchedOff.length) flags.push({ type: 'failing', why: 'StarNet switched off ' + switchedOff.join(', ') + ' after repeated failures' });
    // "unreliable" only while still struggling: a person whose latest run finished has recovered
    if (streak >= 1 && !limitOnly && mine.length >= P.minRunsForRate && failed.length / mine.length >= P.failureRate) flags.push({ type: 'unreliable', why: failed.length + ' of ' + mine.length + ' runs in ' + P.windowHours + 'h did not finish' });
    if (overdue.length >= 2) flags.push({ type: 'overdue', why: overdue.length + ' handoffs ' + P.overdueDays + '+ days past deadline: ' + overdue.slice(0, 3).map(o => o.heading).join(' | ') });
    const loopJob = myJobs.find(j => c.loop && (j.name === c.loop || j.name.startsWith(c.loop))) || myJobs[0];
    const model = loopJob ? ((loopJob.wire && loopJob.wire.provider && loopJob.wire.model) ? loopJob.wire.provider + '/' + loopJob.wire.model : loopJob.provider + '/' + loopJob.model) : '?';
    // only refusals by the model the loop runs on now: once the work has moved to another model, the old ones are history
    const wireOf = r => (r.provider || '?') + '/' + (r.model || '?');
    const refusedNow = refusedRuns.filter(r => wireOf(r) === model);
    if (refusedNow.length) flags.push({ type: 'refusal', why: refusedNow.length + ' routine run(s) refused by ' + model + ' (safety filter). This is a limit of the model, not the person: move this work to another model family (hire.js remodel)' });
    const causes = Object.keys(reasons).map(k => k + ': ' + (CAUSE[k] || 'see the run'));
    if (refusedRuns.length) causes.push('refusal: ' + CAUSE.refusal);
    people.push({ agentId: id, name: c.name, title: c.title, model, runs: all.length, refused: refusedRuns.length, failed: failed.length, streak, reasons, causes, switchedOff, overdue: overdue.length, flags,
      lastRun: mine.length ? new Date(mine[mine.length - 1].startedAt).toISOString() : null });
  }
  return { at: new Date().toISOString(), windowHours: P.windowHours, thresholds: P, people };
}

function render(a) {
  const lp = co.localParts(); const stamp = lp.date + ' ' + lp.time + ' (' + co.TZ + ')';
  const rows = a.people.map(p => '| ' + p.name + ' | ' + p.title + ' | ' + p.model + ' | ' + p.runs + ' | ' + p.failed + ' | ' + p.streak + ' | ' + p.overdue + ' | ' + (p.flags.map(f => f.type + ': ' + f.why).join('; ') || 'ok') + ' |');
  return '# Performance\n\nWritten by company/tools/performance.js at ' + stamp + ' from the station\'s run records (last ' + a.windowHours + ' hours of routine runs; cancelled and restart-interrupted runs are not counted).\n\n' +
    'Flags go to the people owner (' + co.nameOf(co.seatFor('people')) + '), with an FYI to the person\'s manager: the people owner and the manager decide fix, re-model or replace (the people owner alone when the manager is the CEO), and record it in company/work/decisions.md (node company/tools/decision.js add). A limit flag goes to the tools owner (' + co.nameOf(co.seatFor('tools')) + '). A flag about the CEO goes to the CEO; replacing the CEO is the owner\'s call (company/MODEL_POLICY.md).\n\n' +
    '| Person | Role | Model | Runs | Failed | Failing streak | Overdue handoffs | Status |\n|---|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n';
}

module.exports = { assess, render, endOfDayInTz };
if (require.main === module) {
  (async () => {
    const cmd = process.argv[2] || 'report';
    const a = await assess();
    if (cmd === 'flags') { console.log(JSON.stringify(a.people.filter(p => p.flags.length), null, 1)); return; }
    if (cmd === 'report') { fs.writeFileSync(REPORT, render(a)); console.log(JSON.stringify(a, null, 1)); return; }
    console.log(JSON.stringify({ ok: false, error: 'commands: report, flags' }));
  })().catch(e => { console.error(e.message); process.exit(1); });
}
