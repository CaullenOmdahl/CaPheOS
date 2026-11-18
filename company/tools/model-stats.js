#!/usr/bin/env node
/* model-stats.js — our own "house benchmark": how each model actually performs on this company's work.
 *
 *   node company/tools/model-stats.js [--days 14] [--json]
 *
 * Public benchmarks (company/work/models/BENCHMARKS.md, kept by the model research seat) say how a model scores on someone else's tests.
 * This says how it does on ours: for every model, overall and per routine, from the station's run records
 * (.starnet-data/workspaces/runs.jsonl, routine runs only): runs, finished, refused, ran out of steps or budget,
 * errored (provider faults, not the model's fault), median turns, median tokens and median minutes per run.
 * Writes company/work/models/house-benchmarks.md and company/work/models/house-benchmarks.json.
 * Read it next to BENCHMARKS.md and the competence scoreboard when pairing a role with a model. A model with few runs
 * on a routine is marked "too few runs": do not judge it on fewer than 5.
 *
 * Measurement only (it routes nothing). Besides the routine view above (`models`, `routineRuns`: unchanged), it books
 * EVERY crew run in the window (`crew`): routine runs, runs the dispatcher started, lane runs, the owner's chat, health
 * checks, and team.dispatch child runs (a run with a parentRunId). Each run is flagged by `source` (who started it: the
 * door lib/admit.js attributes it to, else inferred from the row; a child run is source "child"). Every group also gives
 * usd (sum and per run), tokens and cachedTokens with the cached share (of the tokens of the runs that report a cached
 * count: the station records no separate input count, and output is a small part of a tool-loop run), and a split by
 * reasoning effort (provider/model/effort). `families` books a lead run and its child runs as one unit: runs, tokens,
 * usd, turns, outcomes, children per lead, and children cut off by the dispatch wall-clock slice (reason "cancelled"
 * with the station's dispatch-delivery patch reason "timeout") apart from real failures.
 * Reads runs.jsonl and the admit log bounded, from the end (lib/bounded.js); writes two files it overwrites (no growth).
 * Owner: the people function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');

const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r6 = n => Math.round(n * 1e6) / 1e6;   // usd: summed in run order, rounded once, so totals equal the sum of their runs
const kind = r => {
  if (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') return 'refused';
  if (r.reason === 'done') return 'finished';
  if (r.reason === 'max_iters') return 'outOfSteps';
  if (r.reason === 'budget') return 'outOfBudget';
  if (r.reason === 'error' || r.reason === 'empty') return 'providerError';
  if (r.reason === 'cancelled' || r.reason === 'interrupted') return 'stopped';
  return 'other';
};
// who started a run: the door lib/admit.js attributes it to, as a source name
const DOOR_SOURCE = { dispatch: 'dispatcher', lane: 'lane', chat: 'owner-chat', meeting: 'owner-meeting', schedule: 'routine', health: 'health',
  console: 'console', hire: 'hire', pacer: 'pacer', halt: 'halt', onboard: 'onboard', watchdog: 'watchdog', act: 'act' };
const HEALTH_STREAM = /^(aicheck|health)/i;
function inferSource(r) {   // no admit row covers it: what the row itself says
  if (HEALTH_STREAM.test(String(r.streamId || ''))) return 'health';
  if (r.cronJobId || r.wireSource === 'routine') return 'routine';
  if (r.ownerDirective === true || /^console/.test(String(r.streamId || ''))) return 'owner-chat';
  return 'other';
}

/* compute({ rows, admitRows, names, days, since, now }) -> the result object written to house-benchmarks.json.
 * rows: raw runs.jsonl rows (run rows and the station's dispatch-delivery patch rows); admitRows: lib/admit.js log rows. */
function compute(o) {
  const since = o.since, names = o.names || {};
  const delivery = new Map();
  const raw = [];
  for (const r of o.rows || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'dispatch-delivery') { if (r.runId && r.dispatchDelivery) delivery.set(r.runId, r.dispatchDelivery); continue; }
    if (!(r.startedAt >= since) || !r.model) continue;
    raw.push(r);
  }
  let doors = new Map();
  try { for (const a of require('./lib/admit').attribute(raw, o.admitRows || [])) doors.set(a.runId, a.door); } catch (_) { doors = new Map(); }
  const crew = raw.map(r => {
    const dd = delivery.get(r.runId) || r.dispatchDelivery || null;
    const k = kind(r);
    const parent = r.parentRunId ? String(r.parentRunId) : '';
    const door = doors.get(r.runId) || null;
    return {
      runId: r.runId || null, parentRunId: parent || null, agentId: r.agentId,
      model: (r.provider || '?') + '/' + r.model, effort: r.reasoningEffort || 'default',
      routine: r.cronJobId ? (names[r.cronJobId] || String(r.cronJobId).slice(0, 8)) : null,
      source: parent ? 'child' : (door && DOOR_SOURCE[door]) || inferSource(r), door,
      k, sliceCut: !!(parent && k === 'stopped' && dd && dd.reason === 'timeout'),
      turns: r.turns || 0, tokens: r.tokens || 0, cached: Number.isFinite(Number(r.cachedTokens)) && r.cachedTokens != null ? Number(r.cachedTokens) : null,
      usd: Number(r.usd) || 0, unmetered: r.unmetered === true, min: (r.durationMs || 0) / 60000, startedAt: Number(r.startedAt) || 0,
    };
  });
  const rows = crew.filter(r => r.routine != null);   // the routine view: runs with a routine (as before)

  function stat(list) {
    const c = { runs: list.length, finished: 0, refused: 0, outOfSteps: 0, outOfBudget: 0, providerError: 0, stopped: 0, other: 0 };
    for (const r of list) c[r.k]++;
    // not the model's fault: provider errors, and runs our own limits stopped (token or spend budget, the run time limit,
    // a cancel). They are shown, but left out of the finish rate.
    const judged = c.runs - c.providerError - c.stopped - c.outOfBudget;
    const done = list.filter(r => r.k === 'finished');
    let usd = 0, tokens = 0, turns = 0, cached = 0, cachedOf = 0, unmetered = 0;
    for (const r of list) { usd += r.usd; tokens += r.tokens; turns += r.turns; if (r.unmetered) unmetered++; if (r.cached != null) { cached += r.cached; cachedOf += r.tokens; } }
    return Object.assign(c, {
      finishRate: judged ? Math.round(100 * c.finished / judged) : null,
      medianTurns: median(done.map(r => r.turns)), medianTokens: median(done.map(r => r.tokens)), medianMinutes: median(done.map(r => r.min)),
      enough: judged >= 5,
      usd: r6(usd), usdPerRun: c.runs ? r6(usd / c.runs) : null, unmeteredRuns: unmetered,
      tokens, turns, cachedTokens: cached, cachedShare: cachedOf ? Math.round(1000 * cached / cachedOf) / 1000 : null,
    });
  }
  const by = (list, key) => { const m = new Map(); for (const r of list) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const groups = (list, key, name) => [...by(list, key)].map(([k, l]) => ({ [name]: k, ...stat(l) })).sort((x, y) => y.runs - x.runs);
  const models = [...by(rows, r => r.model)].map(([model, list]) => ({ model, overall: stat(list),
    routines: groups(list, r => r.routine, 'routine'), byEffort: groups(list, r => r.effort, 'effort') }))
    .sort((x, y) => y.overall.runs - x.overall.runs);

  const sources = {}; for (const r of crew) sources[r.source] = (sources[r.source] || 0) + 1;
  const crewModels = [...by(crew, r => r.model)].map(([model, list]) => ({ model, overall: stat(list),
    byEffort: groups(list, r => r.effort, 'effort'), bySource: groups(list, r => r.source, 'source') }))
    .sort((x, y) => y.overall.runs - x.overall.runs);

  // families: a lead run and every run under it (children, and their children), as one unit
  const byId = new Map(crew.filter(r => r.runId).map(r => [r.runId, r]));
  const rootOf = r => { let cur = r, hops = 0; while (cur.parentRunId && byId.has(cur.parentRunId) && hops++ < 50) cur = byId.get(cur.parentRunId); return cur.parentRunId || cur.runId; };
  const fam = new Map();
  for (const r of crew) if (r.parentRunId) { const root = rootOf(r); if (!fam.has(root)) fam.set(root, []); fam.get(root).push(r); }
  const famList = [];
  for (const [root, kids] of fam) {
    const lead = byId.get(root) || null;
    const members = lead ? [lead].concat(kids) : kids;
    const s = stat(members);
    const childOutcomes = { finished: 0, sliceCut: 0, cancelledOther: 0, failed: 0 };
    for (const c of kids) childOutcomes[c.k === 'finished' ? 'finished' : c.sliceCut ? 'sliceCut' : c.k === 'stopped' ? 'cancelledOther' : 'failed']++;
    famList.push({ leadRunId: root, leadInWindow: !!lead, agentId: lead ? lead.agentId : null, model: lead ? lead.model : null, effort: lead ? lead.effort : null,
      source: lead ? lead.source : null, startedAt: lead ? lead.startedAt : Math.min(...kids.map(c => c.startedAt)),
      lead: lead ? lead.k : null, runs: members.length, children: kids.length, workers: [...new Set(kids.map(c => c.agentId))],
      tokens: s.tokens, usd: s.usd, turns: s.turns, cachedTokens: s.cachedTokens, cachedShare: s.cachedShare,
      minutes: Math.round(10 * members.reduce((t, m) => t + m.min, 0)) / 10,
      outcomes: { finished: s.finished, refused: s.refused, outOfSteps: s.outOfSteps, outOfBudget: s.outOfBudget, providerError: s.providerError, stopped: s.stopped, other: s.other },
      childOutcomes });
  }
  famList.sort((x, y) => y.startedAt - x.startedAt);
  const sum = k => famList.reduce((t, f) => t + f[k], 0);
  const sumC = k => famList.reduce((t, f) => t + f.childOutcomes[k], 0);
  const per = famList.map(f => f.children);
  const LIST_MAX = 200;   // the newest families in full; the totals cover all of them
  const families = { count: famList.length, runs: sum('runs'), children: sum('children'),
    childrenPerLead: { mean: famList.length ? Math.round(100 * sum('children') / famList.length) / 100 : null, median: median(per), max: per.length ? Math.max(...per) : null },
    tokens: sum('tokens'), usd: r6(famList.reduce((t, f) => t + f.usd, 0)), turns: sum('turns'), cachedTokens: sum('cachedTokens'),
    childOutcomes: { finished: sumC('finished'), sliceCut: sumC('sliceCut'), cancelledOther: sumC('cancelledOther'), failed: sumC('failed') },
    listed: Math.min(LIST_MAX, famList.length), list: famList.slice(0, LIST_MAX) };

  return { at: new Date(o.now || Date.now()).toISOString(), days: o.days, routineRuns: rows.length, models,
    crew: { runs: crew.length, sources, overall: stat(crew), models: crewModels, bySource: groups(crew, r => r.source, 'source') }, families };
}

const fmt = n => n == null ? '–' : (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n * 10) / 10));
const money = n => n == null ? '–' : '$' + (n >= 100 ? Math.round(n) : n >= 1 ? n.toFixed(2) : n.toFixed(4));
const pct = n => n == null ? '–' : Math.round(100 * n) + '%';
function render(result) {
  const line = (label, s) => '| ' + label + ' | ' + s.runs + ' | ' + (s.finishRate == null ? '–' : s.finishRate + '%') + (s.enough ? '' : ' (too few runs)') +
    ' | ' + s.refused + ' | ' + s.outOfSteps + ' | ' + (s.outOfBudget + s.stopped) + ' | ' + s.providerError + ' | ' + fmt(s.medianTurns) + ' | ' + fmt(s.medianTokens) + ' | ' + fmt(s.medianMinutes) + ' |';
  const cost = (label, s) => '| ' + label + ' | ' + s.runs + ' | ' + (s.finishRate == null ? '–' : s.finishRate + '%') + ' | ' + money(s.usd) + ' | ' + money(s.usdPerRun) +
    (s.unmeteredRuns ? ' (' + s.unmeteredRuns + ' unmetered)' : '') + ' | ' + fmt(s.tokens) + ' | ' + pct(s.cachedShare) + ' |';
  const { models, days } = result;
  let md = '# House benchmarks: how each model does on our work\n\nWritten by `company/tools/model-stats.js` at ' + result.at.replace('T', ' ').slice(0, 16) + ' UTC from the last ' + days +
    ' days of routine runs (' + result.routineRuns + ' runs). "Finished" counts against runs the model is accountable for: provider errors and runs stopped by our own limits (token or spend budget, the run time limit, a cancel) are shown but left out; many of those say more about our limits than the model. ' +
    'Medians are for finished runs. Judge nothing on fewer than 5 runs. Read with `BENCHMARKS.md` (public scores) and `company/work/people/scoreboard.md` (competence).\n\n';
  const head = '| | Runs | Finished | Refused | Out of steps | Stopped by our limits | Provider errors | Median turns | Median tokens | Median minutes |\n|---|---|---|---|---|---|---|---|---|---|\n';
  md += '## By model\n\n' + head + models.map(m => line('`' + m.model + '`', m.overall)).join('\n') + '\n';
  for (const m of models) md += '\n## `' + m.model + '` by routine\n\n' + head + m.routines.map(r => line(r.routine, r)).join('\n') + '\n';

  const c = result.crew, f = result.families;
  if (c) {
    const chead = '| | Runs | Finished | USD | USD per run | Tokens | Cached share |\n|---|---|---|---|---|---|---|\n';
    md += '\n## Every crew run, by who started it\n\nAll ' + c.runs + ' crew runs in the window, not only routine runs: the dispatcher\'s wakes, lanes, the owner\'s chat, health checks, and team.dispatch child runs ("child"). ' +
      'The cached share is of the tokens of the runs that report a cached count.\n\n' + chead + cost('all', c.overall) + '\n' + c.bySource.map(s => cost(s.source, s)).join('\n') + '\n';
    md += '\n## Every crew run, by model and reasoning effort\n\n' + chead;
    for (const m of c.models) md += cost('`' + m.model + '`', m.overall) + '\n' + m.byEffort.map(e => cost('`' + m.model + '` @ ' + e.effort, e)).join('\n') + '\n';
  }
  if (f) {
    md += '\n## Families: a lead run and its team.dispatch children as one unit\n\n' + f.count + ' families, ' + f.runs + ' runs (' + f.children + ' children; per lead: mean ' + fmt(f.childrenPerLead.mean) + ', max ' + fmt(f.childrenPerLead.max) + '), ' +
      fmt(f.tokens) + ' tokens, ' + money(f.usd) + ', ' + f.turns + ' turns. Children: ' + f.childOutcomes.finished + ' finished, ' + f.childOutcomes.sliceCut + ' cut off by the dispatch time slice, ' +
      f.childOutcomes.cancelledOther + ' cancelled otherwise, ' + f.childOutcomes.failed + ' failed.\n';
    if (f.list.length) {
      md += '\n| Lead | Seat | Model | Runs | Children | Slice cut | Failed | Tokens | USD | Turns |\n|---|---|---|---|---|---|---|---|---|---|\n' +
        f.list.slice(0, 30).map(x => '| ' + (x.startedAt ? new Date(x.startedAt).toISOString().replace('T', ' ').slice(0, 16) : '–') + (x.leadInWindow ? '' : ' (lead before the window)') + ' | ' + (x.agentId || '–') + ' | ' +
          (x.model ? '`' + x.model + '` @ ' + x.effort : '–') + ' | ' + x.runs + ' | ' + x.children + ' | ' + x.childOutcomes.sliceCut + ' | ' + x.childOutcomes.failed + ' | ' + fmt(x.tokens) + ' | ' + money(x.usd) + ' | ' + x.turns + ' |').join('\n') + '\n';
    }
  }
  return md;
}

function main() {
  const a = process.argv.slice(2);
  const days = (() => { const i = a.indexOf('--days'); return i >= 0 ? Number(a[i + 1]) || 14 : 14; })();
  const now = Date.now(), since = now - days * 86400e3;
  const RUNS = co.p('.starnet-data', 'workspaces', 'runs.jsonl');
  const CRON = co.p('.starnet-data', 'workspaces', 'cron.jobs.json');
  const OUT = co.p('company', 'work', 'models');
  const names = {};
  try { const j = JSON.parse(fs.readFileSync(CRON, 'utf8')); for (const job of (j.jobs || j)) names[job.id] = job.name; } catch (_) {}
  let rows = []; try { rows = require('./lib/bounded').jsonlWindow(RUNS, { sinceMs: since }).rows; } catch (_) {}   // the window only, read from the end; no runs yet on a new company
  let admitRows = []; try { admitRows = require('./lib/admit').rows({ sinceMs: since - 15 * 60e3 }); } catch (_) {}   // bounded read from the end
  const result = compute({ rows, admitRows, names, days, since, now });
  const md = render(result);
  if (a.includes('--json')) { console.log(JSON.stringify(result, null, 1)); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const jtxt = JSON.stringify(result, null, 1);
  fs.writeFileSync(path.join(OUT, 'house-benchmarks.json'), jtxt);
  fs.writeFileSync(path.join(OUT, 'house-benchmarks.md'), md);
  try { const P = require('./provenance.js'); P.wrote(path.join(OUT, 'house-benchmarks.json'), jtxt, 'model-stats.js'); P.wrote(path.join(OUT, 'house-benchmarks.md'), md, 'model-stats.js'); } catch (_) {}   // locked-watch.js: this tool's own write
  console.log('wrote company/work/models/house-benchmarks.md (' + result.routineRuns + ' routine runs, ' + result.models.length + ' models; ' + result.crew.runs + ' crew runs, ' + result.families.count + ' families)');
}

module.exports = { compute, render, kind };
if (require.main === module) main();
