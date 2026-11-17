#!/usr/bin/env node
/* routine-length.js — how long each routine actually runs, against the context window it must fit in.
 *
 *   node company/tools/routine-length.js [--days 14] [--json]
 *
 * Why: pairing a routine with a model needs a *fit* number, not a spec. A context-window figure ("200k") says
 * nothing until it is set beside the tokens a routine really carries. This reads the station's run records
 * (.starnet-data/workspaces/runs.jsonl, routine runs only) and writes, per routine:
 *   runs, median turns, p90 turns, worst-case turns, median tokens, p90 tokens, worst-case tokens,
 *   median and worst-case tokens per turn, and the number of models whose context window clears the worst case.
 *
 * HONEST LIMIT, stated in the output too: runs.jsonl records CUMULATIVE tokens for a run, not the size of the
 * largest single request. Tokens-per-turn (total / turns) is therefore a LOWER bound on the peak request size:
 * a run's last turn re-sends the transcript, so the peak is at least the mean and normally well above it.
 * The check that would settle it is a harness-side log of peak input tokens per run; until that exists, the
 * fit column is a screening test (does the window clear the whole run's token total? if not, look closer),
 * never a certificate.
 *
 * Writes company/work/models/routine-length.md and company/work/models/routine-length.json.
 * Read next to company/work/models/BENCHMARKS.md (§1.5) and house-benchmarks.md.
 * Context windows: company/work/models/context-windows.json ([{id, window}]) when present, else the published list below.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = co.ROOT;
const RUNS = path.join(ROOT, '.starnet-data', 'workspaces', 'runs.jsonl');
const CRON = path.join(ROOT, '.starnet-data', 'workspaces', 'cron.jobs.json');
const OUT = path.join(ROOT, 'company', 'work', 'models');

const a = process.argv.slice(2);
const days = (() => { const i = a.indexOf('--days'); return i >= 0 ? Number(a[i + 1]) || 14 : 14; })();
const since = Date.now() - days * 86400e3;

const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const max = xs => xs.length ? Math.max(...xs) : null;

// same classification as model-stats.js, so the two files agree on what a "finished" run is
const kind = r => {
  if (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') return 'refused';
  if (r.reason === 'done') return 'finished';
  if (r.reason === 'max_iters') return 'outOfSteps';
  if (r.reason === 'budget') return 'outOfBudget';
  if (r.reason === 'error' || r.reason === 'empty') return 'providerError';
  if (r.reason === 'cancelled' || r.reason === 'interrupted') return 'stopped';
  return 'other';
};

let routineNames = {};
try { const j = JSON.parse(fs.readFileSync(CRON, 'utf8')); for (const job of (j.jobs || j)) routineNames[job.id] = job.name; } catch (_) {}

const byRoutine = new Map();
for (const id of Object.values(routineNames)) byRoutine.set(id, { routine: id, models: new Set(), all: [], finished: [] });
let runsText = ''; try { runsText = require('./lib/bounded').jsonlWindowText(RUNS, since); } catch (_) {}   // the window only, read from the end (lib/bounded.js)   // no station data yet: an empty table
for (const l of runsText.split('\n')) {
  if (!l) continue;
  let r; try { r = JSON.parse(l); } catch (_) { continue; }
  if (!r.cronJobId || !(r.startedAt >= since)) continue;
  const name = routineNames[r.cronJobId] || r.cronJobId.slice(0, 8);
  if (!byRoutine.has(name)) byRoutine.set(name, { routine: name, models: new Set(), all: [], finished: [] });
  const e = byRoutine.get(name);
  e.models.add((r.provider || '?') + '/' + r.model);
  const row = { turns: r.turns || 0, tokens: r.tokens || 0, k: kind(r), model: (r.provider || '?') + '/' + r.model };
  e.all.push(row);
  if (row.k === 'finished') e.finished.push(row);
}

// context windows as published by the providers (BENCHMARKS.md §1); company/work/models/context-windows.json wins
const DEFAULT_WINDOWS = [
  { id: 'claude-haiku-4-5-20251001', window: 200000 },
  { id: 'claude-haiku-5-5 = the haiku alias', window: 1000000 },
  { id: 'claude-sonnet-5-5', window: 1000000 },
  { id: 'claude-opus-5-5', window: 1000000 },
  { id: 'claude-fable-5-2[1m]', window: 1000000 },
  { id: 'deepseek-flash', window: 1000000 },
  { id: 'MiniMax-M3.1-Flash', window: 1000000 },
];
const WINDOWS = (() => { const j = co.readJson(path.join(OUT, 'context-windows.json'), null); return Array.isArray(j) && j.length ? j.filter(w => w && w.id && Number(w.window) > 0) : DEFAULT_WINDOWS; })();

const routines = [];
for (const e of [...byRoutine.values()].sort((x, y) => y.all.length - x.all.length || x.routine.localeCompare(y.routine))) {
  const fin = e.finished, all = e.all;
  const finTurns = fin.map(r => r.turns), finTokens = fin.map(r => r.tokens);
  const allTurns = all.map(r => r.turns), allTokens = all.map(r => r.tokens);
  const perTurnFin = fin.filter(r => r.turns > 0).map(r => r.tokens / r.turns);
  const perTurnAll = all.filter(r => r.turns > 0).map(r => r.tokens / r.turns);
  const worstTokens = max(allTokens);
  routines.push({
    routine: e.routine,
    runs: all.length,
    finished: fin.length,
    models: [...e.models].sort(),
    medianTurns: median(finTurns), p90Turns: pct(finTurns, 0.9), worstTurns: max(allTurns || [0]),
    medianTokens: median(finTokens), p90Tokens: pct(finTokens, 0.9), worstTokens,
    medianTokensPerTurn: median(perTurnFin), worstTokensPerTurn: max(perTurnAll),
    // screening only: windows that clear the run's WHOLE cumulative token total (a sufficient, not necessary, test)
    windowsClearingWholeRun: worstTokens == null ? [] : WINDOWS.filter(w => w.window >= worstTokens).map(w => w.id),
    enoughRuns: fin.length >= 5,
  });
}

const asOf = new Date().toISOString().slice(0, 10);
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const nf = n => n == null ? '–' : Math.round(n).toLocaleString('en-US');

const json = { asOf, generatedAt: stamp, days, source: '.starnet-data/workspaces/runs.jsonl + cron.jobs.json', windows: WINDOWS, limit: 'runs.jsonl has cumulative tokens per run, not peak request size; tokens/turn is a lower bound on the peak.', routines };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'routine-length.json'), JSON.stringify(json, null, 1) + '\n');

let md = `# Routine length against context window — the fit question\n\n`;
md += `Written by \`company/tools/routine-length.js\` at ${stamp} from the last ${days} days of routine runs in \`.starnet-data/workspaces/runs.jsonl\` (${routines.reduce((s, r) => s + r.runs, 0)} runs). Owner: the seat that keeps the model benchmarks. Read with \`BENCHMARKS.md\` §1.5.\n\n`;
md += `**What this answers.** The model manager's question: does a model's context window actually constrain our longest routines? A window is a spec; this table turns it into a *fit* — median and worst case in turns and tokens per routine, beside the windows of the models we run.\n\n`;
md += `**The limit, stated first, because it decides how much weight this table carries.** \`runs.jsonl\` records the **cumulative** tokens a run spent, not the size of its largest single request. *Tokens per turn* (total ÷ turns) is therefore a **lower bound** on the peak request — the last turn re-sends the transcript, so the peak is at least the mean and normally above it. Read the last two columns as a **screening test**: a routine whose **mean** request is already a large fraction of a window will certainly cross that window at its peak; one whose mean is a small fraction is *probably* clear, and the file cannot prove it. The check that would settle it is a harness-side log of peak input tokens per run; no one should quote this table as a certificate either way.\n\n`;
md += `| Routine | Runs | Finished | Median turns | p90 turns | Worst turns | Median tokens | p90 tokens | Worst tokens | Median tokens/turn | Worst tokens/turn | Worst mean request as % of a 200k window | as % of a 1M window |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of routines) {
  const mark = r.enoughRuns ? '' : ' (few)';
  const p200 = r.worstTokensPerTurn == null ? '–' : Math.round(100 * r.worstTokensPerTurn / 200000) + '%';
  const p1m = r.worstTokensPerTurn == null ? '–' : Math.round(100 * r.worstTokensPerTurn / 1000000) + '%';
  md += `| ${r.routine}${mark} | ${r.runs} | ${r.finished} | ${nf(r.medianTurns)} | ${nf(r.p90Turns)} | ${nf(r.worstTurns)} | ${nf(r.medianTokens)} | ${nf(r.p90Tokens)} | ${nf(r.worstTokens)} | ${nf(r.medianTokensPerTurn)} | ${nf(r.worstTokensPerTurn)} | ${p200} | ${p1m} |\n`;
}
md += `\n(few) = fewer than 5 finished runs; the medians are shown, but do not pair a model on them.\n\n`;
md += `**Context windows used (published, \`BENCHMARKS.md\` §1, or \`context-windows.json\`):** ${WINDOWS.map(w => `\`${w.id}\` ${nf(w.window)}`).join(' · ')}.\n\n`;
md += `## What it says\n\n`;
const withData = routines.filter(r => r.worstTokensPerTurn != null);
const longOnes = withData.slice().sort((x, y) => y.worstTokensPerTurn - x.worstTokensPerTurn);
const over200 = longOnes.filter(r => r.worstTokensPerTurn > 200000);
const near200 = longOnes.filter(r => r.worstTokensPerTurn > 100000 && r.worstTokensPerTurn <= 200000);
md += `- **The run total is not the constraint — the single request is.** Cumulative tokens per run routinely reach ${nf(Math.max(...withData.map(r => r.worstTokens)))}; by the end of a run the transcript is far bigger than any window, which is exactly why the harness compacts and why the run total cannot be compared to a window. The number that should be compared is tokens per turn.\n`;
md += `- **Mean request size per routine runs ${nf(Math.min(...withData.map(r => r.worstTokensPerTurn)))}–${nf(Math.max(...withData.map(r => r.worstTokensPerTurn)))} tokens (worst case per routine).** That is ${Math.round(100 * Math.min(...longOnes.map(r => r.worstTokensPerTurn)) / 1000000)}–${Math.round(100 * Math.max(...longOnes.map(r => r.worstTokensPerTurn)) / 1000000)}% of a 1M window and ${Math.round(100 * Math.min(...longOnes.map(r => r.worstTokensPerTurn)) / 200000)}–${Math.round(100 * Math.max(...longOnes.map(r => r.worstTokensPerTurn)) / 200000)}% of a 200k window. On a 1M window there is ${Math.floor(1000000 / Math.max(...longOnes.map(r => r.worstTokensPerTurn)))}× headroom over the largest mean request; on a 200k window, ${(200000 / Math.max(...longOnes.map(r => r.worstTokensPerTurn))).toFixed(1)}×.\n`;
const smallest = WINDOWS.slice().sort((x, y) => x.window - y.window)[0];
md += `- **The smallest window is the one that can change the answer.** ${!smallest ? 'No windows configured.' : (() => { const half = smallest.window / 2; const over = longOnes.filter(r => r.worstTokensPerTurn > smallest.window); const near = longOnes.filter(r => r.worstTokensPerTurn > half && r.worstTokensPerTurn <= smallest.window); return over.length ? `${over.map(r => r.routine).join(', ')} already exceed \`${smallest.id}\` (${nf(smallest.window)}) at the mean.` : `No routine's worst mean request exceeds \`${smallest.id}\` (${nf(smallest.window)}), but ${near.length} routine${near.length === 1 ? ' is' : 's are'} past half of it at the mean${near.length ? ' (' + near.map(r => `${r.routine} ${Math.round(100 * r.worstTokensPerTurn / smallest.window)}%`).join(', ') + ')' : ''} — for those, a peak request on that model would be a real risk. Check which concrete model each alias in the routing table resolves to before reading this row.`; })()}\n`;
md += `- **What would still bite, and we cannot see it here:** a single turn whose request crosses a window and is silently truncated. Nothing in \`runs.jsonl\` records peak request size, so this table cannot rule it out for any routine. The check that would settle it is one harness-side field — peak input tokens per run — and it belongs to the tools owner, not to a benchmark refresh.\n\n`;
md += `## Re-run\n\n\`node company/tools/routine-length.js\` (optionally \`--days N\`). It rewrites this file and \`routine-length.json\`. Refresh with the monthly benchmark pass, and after any change to a routine's prompt length or step budget.\n`;
fs.writeFileSync(path.join(OUT, 'routine-length.md'), md);

if (a.includes('--json')) console.log(JSON.stringify(json, null, 1));
else {
  console.log('wrote company/work/models/routine-length.md and routine-length.json');
  for (const r of routines) console.log([r.routine.padEnd(28), String(r.runs).padStart(3), nf(r.medianTurns).padStart(6), nf(r.medianTokens).padStart(9), nf(r.worstTokens).padStart(9), nf(r.worstTokensPerTurn).padStart(9), r.windowsClearingWholeRun.length + '/' + WINDOWS.length].join(' '));
}
