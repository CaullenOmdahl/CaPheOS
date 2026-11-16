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
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const RUNS = co.p('.starnet-data', 'workspaces', 'runs.jsonl');
const CRON = co.p('.starnet-data', 'workspaces', 'cron.jobs.json');
const OUT = co.p('company', 'work', 'models');

const a = process.argv.slice(2);
const days = (() => { const i = a.indexOf('--days'); return i >= 0 ? Number(a[i + 1]) || 14 : 14; })();
const since = Date.now() - days * 86400e3;
const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const kind = r => {
  if (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') return 'refused';
  if (r.reason === 'done') return 'finished';
  if (r.reason === 'max_iters') return 'outOfSteps';
  if (r.reason === 'budget') return 'outOfBudget';
  if (r.reason === 'error' || r.reason === 'empty') return 'providerError';
  if (r.reason === 'cancelled' || r.reason === 'interrupted') return 'stopped';
  return 'other';
};

let names = {};
try { const j = JSON.parse(fs.readFileSync(CRON, 'utf8')); for (const job of (j.jobs || j)) names[job.id] = job.name; } catch (_) {}
const rows = [];
let runsText = ''; try { runsText = fs.readFileSync(RUNS, 'utf8'); } catch (_) {}   // no runs yet on a new company
for (const l of runsText.split('\n')) {
  if (!l) continue;
  let r; try { r = JSON.parse(l); } catch (_) { continue; }
  if (!r.cronJobId || !(r.startedAt >= since) || !r.model) continue;
  const model = (r.provider || '?') + '/' + r.model;
  const routine = names[r.cronJobId] || r.cronJobId.slice(0, 8);
  rows.push({ model, routine, agentId: r.agentId, k: kind(r), turns: r.turns || 0, tokens: r.tokens || 0, min: (r.durationMs || 0) / 60000 });
}

function stat(list) {
  const c = { runs: list.length, finished: 0, refused: 0, outOfSteps: 0, outOfBudget: 0, providerError: 0, stopped: 0, other: 0 };
  for (const r of list) c[r.k]++;
  // not the model's fault: provider errors, and runs our own limits stopped (token or spend budget, the run time limit,
  // a cancel). They are shown, but left out of the finish rate.
  const judged = c.runs - c.providerError - c.stopped - c.outOfBudget;
  const done = list.filter(r => r.k === 'finished');
  return Object.assign(c, {
    finishRate: judged ? Math.round(100 * c.finished / judged) : null,
    medianTurns: median(done.map(r => r.turns)), medianTokens: median(done.map(r => r.tokens)), medianMinutes: median(done.map(r => r.min)),
    enough: judged >= 5,
  });
}
const by = (list, key) => { const m = new Map(); for (const r of list) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const models = [...by(rows, r => r.model)].map(([model, list]) => ({ model, overall: stat(list),
  routines: [...by(list, r => r.routine)].map(([routine, l]) => ({ routine, ...stat(l) })).sort((x, y) => y.runs - x.runs) }))
  .sort((x, y) => y.overall.runs - x.overall.runs);
const result = { at: new Date().toISOString(), days, routineRuns: rows.length, models };

const fmt = n => n == null ? '–' : (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n * 10) / 10));
const line = (label, s) => '| ' + label + ' | ' + s.runs + ' | ' + (s.finishRate == null ? '–' : s.finishRate + '%') + (s.enough ? '' : ' (too few runs)') +
  ' | ' + s.refused + ' | ' + s.outOfSteps + ' | ' + (s.outOfBudget + s.stopped) + ' | ' + s.providerError + ' | ' + fmt(s.medianTurns) + ' | ' + fmt(s.medianTokens) + ' | ' + fmt(s.medianMinutes) + ' |';
let md = '# House benchmarks: how each model does on our work\n\nWritten by `company/tools/model-stats.js` at ' + result.at.replace('T', ' ').slice(0, 16) + ' UTC from the last ' + days +
  ' days of routine runs (' + rows.length + ' runs). "Finished" counts against runs the model is accountable for: provider errors and runs stopped by our own limits (token or spend budget, the run time limit, a cancel) are shown but left out; many of those say more about our limits than the model. ' +
  'Medians are for finished runs. Judge nothing on fewer than 5 runs. Read with `BENCHMARKS.md` (public scores) and `company/work/people/scoreboard.md` (competence).\n\n';
const head = '| | Runs | Finished | Refused | Out of steps | Stopped by our limits | Provider errors | Median turns | Median tokens | Median minutes |\n|---|---|---|---|---|---|---|---|---|---|\n';
md += '## By model\n\n' + head + models.map(m => line('`' + m.model + '`', m.overall)).join('\n') + '\n';
for (const m of models) md += '\n## `' + m.model + '` by routine\n\n' + head + m.routines.map(r => line(r.routine, r)).join('\n') + '\n';

if (a.includes('--json')) console.log(JSON.stringify(result, null, 1));
else {
  fs.mkdirSync(OUT, { recursive: true });
  const jtxt = JSON.stringify(result, null, 1);
  fs.writeFileSync(path.join(OUT, 'house-benchmarks.json'), jtxt);
  fs.writeFileSync(path.join(OUT, 'house-benchmarks.md'), md);
  try { const P = require('./provenance.js'); P.wrote(path.join(OUT, 'house-benchmarks.json'), jtxt, 'model-stats.js'); P.wrote(path.join(OUT, 'house-benchmarks.md'), md, 'model-stats.js'); } catch (_) {}   // locked-watch.js: this tool's own write
  console.log('wrote company/work/models/house-benchmarks.md (' + rows.length + ' routine runs, ' + models.length + ' models)');
}
