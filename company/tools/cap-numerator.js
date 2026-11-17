#!/usr/bin/env node
/**
 * cap-numerator.js — the number a spend cap divides by has to be the number that gets billed.
 *
 * This company keeps two records of the same money:
 *
 *   runs.jsonl   — one row per RUN. That is what a cap naturally sums for the daily total and for each
 *                  agent's share.
 *   ledger.jsonl — one row per SETTLED BILLING ENTRY, including auxiliary generations that are not
 *                  runs (`<runId>_skill_review_<uuid>`, `skill-eval-*`).
 *
 * Summing runs.jsonl alone misses every auxiliary generation (skill reviews, skill evals) that has no run
 * row at all, and counts a run at its estimate rather than at what was billed. A cap that sums one of two
 * records is a cap on part of the spend.
 *
 * THE RULE, one sentence: the numerator is the ledger, plus an estimate for runs the ledger has not
 * settled yet. A run whose generations have settled is counted at what was billed; a generation that
 * belongs to no run is counted because it was billed.
 *
 * ## The word "metered" means two things here, and that is a finding, not a detail
 *
 * `dispatch-budget.json` lists `unmeteredProviders`: providers whose loops the company's cap does not
 * hold (flat subscriptions, or a bill the owner pays outside the company budget). The harness writes
 * `"unmetered": false, "billingClass": "metered"` on per-token rows, because there the word means "this
 * cost real money". Both are correct about different questions, and a numerator that reads the second as
 * if it were the first would hold the company's loops against a bill the budget file says not to cap.
 *
 * So this module keeps the CAP's meaning, by policy first:
 *   1. if the row names a provider, the provider list in `dispatch-budget.json` decides;
 *   2. else if it names a model, the model family names the provider (`deepseek*` -> deepseek,
 *      `minimax*` -> custom, `claude*` -> claude-cli) and the same list decides; many ledger rows carry
 *      no provider, and this is what covers them;
 *   3. else the row's own `billingClass` / `unmetered` decides;
 *   4. else it is counted. Under-counting is the defect being fixed, so the unknown case fails toward counting.
 *
 * And the record side is kept whole: `billedAll` is every dollar in the window regardless of who pays,
 * and `forBillingNoRun` is the for-billing spend with no run row, so the gap between the two records
 * stays measurable.
 *
 * ## Two more choices, each with its cost stated
 *  - **The window** follows the run when the ledger row settles a run in it (a run that starts at 16:10
 *    and settles at 16:20 belongs to the window its run belongs to), and the row's own `ts` when it
 *    settles no run.
 *  - **In flight.** A run nothing has settled yet is counted at the run row's own `usd`. Dropping it
 *    would make the cap blind for the length of every run — the same hole in a new place.
 *
 * Usage:
 *   node company/tools/cap-numerator.js --status                # old numerator vs new, live files
 *   node company/tools/cap-numerator.js --status --runs <f> --ledger <f> [--hours 24]
 *   node company/tools/cap-numerator.js --json
 *   node company/tools/cap-numerator.js --selftest
 *
 * `dispatch.js` calls `spendSplit()` and `spentByAgent()` from here, so the cap, the per-agent shares
 * and the monthly close read the same number; `meteredSince()` is that number over another window (the Sprint
 * spread's last hour, Sprint's budget since it began).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const co = require('./lib/company');

const DEFAULT_RUNS = co.p('.starnet-data', 'workspaces', 'runs.jsonl');
const DEFAULT_LEDGER = co.p('.starnet-data', 'workspaces', 'ledger.jsonl');

// dispatch-budget.json `unmeteredProviders`, read from the policy file so the two cannot drift; the fallback is
// dispatch.js's own (env DISPATCH_UNMETERED_PROVIDERS, else claude-cli).
function unmeteredProviders() {
  const b = co.readJson(co.p('company', 'work', 'finance', 'dispatch-budget.json'), null);
  if (b && Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length) return b.unmeteredProviders.map(String).map(x => x.trim()).filter(Boolean);
  return (process.env.DISPATCH_UNMETERED_PROVIDERS || 'claude-cli').split(',').map(x => x.trim()).filter(Boolean);
}
// the provider a model family is served by, for ledger rows that name only a model
function providerOfModel(model) {
  const m = String(model || '').toLowerCase();
  if (/^deepseek/.test(m)) return 'deepseek';
  if (/^minimax/.test(m)) return 'custom';
  if (/^claude|^(haiku|sonnet|opus)$/.test(m)) return 'claude-cli';
  return null;
}

// sinceMs: read only the end of the file back to that moment (lib/bounded.js; runs.jsonl is StarNet's and only grows)
function readJsonl(p, sinceMs) {
  const out = [];
  let text = '';
  try { text = sinceMs ? require('./lib/bounded').jsonlWindowText(p, sinceMs) : fs.readFileSync(p, 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { out.bad = (out.bad || 0) + 1; }
  }
  out.bad = out.bad || 0;
  return out;
}

// Can the company's cap hold this billing entry? Policy first — see the header.
function isCapped(row, providers) {
  const list = providers || unmeteredProviders();
  const provider = String((row && row.provider) || '');
  if (provider) return list.indexOf(provider) < 0;
  const fromModel = providerOfModel(row && row.model);
  if (fromModel) return list.indexOf(fromModel) < 0;
  if (row && row.billingClass === 'metered') return true;
  if (row && row.billingClass === 'subscription') return false;
  if (row && typeof row.unmetered === 'boolean') return !row.unmetered;
  return true;   // unknown ⇒ counted
}

// The run a ledger row settles; auxiliary rows carry `<runId>_skill_review_<uuid>` and similar suffixes.
function baseRunId(id) {
  const s = String(id || '');
  const i = s.indexOf('_');
  return i > 0 ? s.slice(0, i) : s;
}

function load(opts) {
  opts = opts || {};
  const runsPath = opts.runsPath || process.env.CAP_RUNS || DEFAULT_RUNS;
  const ledgerPath = opts.ledgerPath || process.env.CAP_LEDGER || DEFAULT_LEDGER;
  const now = Number(opts.now) || Date.now();
  const hours = Number(opts.hours) || 24;
  const since = now - hours * 3600 * 1000;
  const runs = readJsonl(runsPath, since);
  const ledger = readJsonl(ledgerPath);
  const providers = Array.isArray(opts.providers) ? opts.providers : unmeteredProviders();
  const inWindow = new Map();
  for (const r of runs) if (Number(r.startedAt) >= since && Number(r.startedAt) <= now) inWindow.set(String(r.runId), r);
  return { runsPath, ledgerPath, now, hours, since, runs, ledger, providers, inWindow };
}

function compute(opts) {
  const st = load(opts);
  const perAgent = {};
  const perProvider = {};        // every billed row by provider, capped or not (the owner's Spend screen)
  const provOf = row => String((row && row.provider) || providerOfModel(row && row.model) || 'unknown');
  const addProv = (row, usd, capped) => { const k = provOf(row); const x = perProvider[k] || (perProvider[k] = { usd: 0, capped }); x.usd += usd; };
  const settled = new Set();
  let cappedBilled = 0;
  let ownerBilled = 0;
  let billedAll = 0;
  let billedRows = 0;
  let forBillingNoRunRows = 0;
  let forBillingNoRunUsd = 0;    // every provider: the gap between the two records
  let cappedNoRunUsd = 0;        // what the cap itself was blind to
  let auxRows = 0;               // billing rows that are not a run at all (`<runId>_skill_review_…`, `skill-eval-*`)
  let auxUsd = 0;

  for (const row of st.ledger) {
    const id = String(row.runId || '');
    const base = baseRunId(id);
    const inRunWindow = st.inWindow.has(base) || st.inWindow.has(id);
    const ts = Number(row.ts) || 0;
    if (!inRunWindow && !(ts >= st.since && ts <= st.now)) continue;
    const usd = Number(row.usd) || 0;
    billedAll += usd;
    billedRows++;
    // A billing row that is not a run: `<runId>_skill_review_<uuid>`, and `skill-eval-<n>` (which has no
    // underscore to split on, so it is named explicitly).
    if (base !== id || /^skill-eval/.test(id)) { auxRows++; auxUsd += usd; }
    const noRunRow = !st.inWindow.has(base) && !st.inWindow.has(id);
    if (noRunRow) { forBillingNoRunRows++; forBillingNoRunUsd += usd; }
    addProv(row, usd, isCapped(row, st.providers));
    if (isCapped(row, st.providers)) {
      cappedBilled += usd;
      const agent = row.agentId || (st.inWindow.get(base) || {}).agentId || '(no agent)';
      perAgent[agent] = (perAgent[agent] || 0) + usd;
      if (noRunRow) cappedNoRunUsd += usd;
    } else {
      ownerBilled += usd;
    }
    settled.add(base);
  }

  let inFlightMetered = 0;
  let inFlightRuns = 0;
  let runsOnlyEstimate = 0;
  for (const [id, r] of st.inWindow) {
    const usd = Number(r.usd) || 0;
    if (isCapped(r, st.providers)) runsOnlyEstimate += usd;
    if (settled.has(id) || !isCapped(r, st.providers)) continue;
    inFlightMetered += usd;
    inFlightRuns++;
    addProv(r, usd, true);
    const a = r.agentId || '(no agent)';
    perAgent[a] = (perAgent[a] || 0) + usd;
  }

  return {
    metered: cappedBilled + inFlightMetered,   // the cap's numerator
    ownerPaid: ownerBilled,
    billedAll,
    runsOnlyEstimate,                          // what the cap used to sum
    billedRows,
    inFlightRuns,
    inFlightMetered,
    forBillingNoRunRows,
    forBillingNoRunUsd,
    cappedNoRunUsd,
    auxRows,
    auxUsd,
    damaged: (st.runs.bad || 0) + (st.ledger.bad || 0),
    runsPath: st.runsPath,
    ledgerPath: st.ledgerPath,
    byAgent: perAgent,
    byProvider: perProvider,
  };
}

function spendSplit(opts) {
  const r = compute(opts);
  return { metered: r.metered, ownerPaid: r.ownerPaid, runsOnlyEstimate: r.runsOnlyEstimate, inFlightRuns: r.inFlightRuns };
}

function spentByAgent(opts) { return compute(opts).byAgent; }

/* meteredSince(sinceMs, opts) -> cap-countable USD from sinceMs to now (opts.now): the same numerator as the daily cap,
 * over any window. The Sprint spread (the last hour), Sprint's own budget (since it began) and `cadence.js sprint status`
 * read this, so every spend figure the owner sees is one number cut at different times, never a second sum. */
function meteredSince(sinceMs, opts) {
  opts = Object.assign({}, opts || {});
  const now = Number(opts.now) || Date.now(); const since = Number(sinceMs) || 0;
  if (!(since > 0) || since >= now) return 0;
  opts.now = now; opts.hours = (now - since) / 3600e3;
  return compute(opts).metered;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = n => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: cap-numerator.js --status [--runs f] [--ledger f] [--hours 24] | --json | --selftest');
    process.exit(0);
  }
  if (argv.includes('--selftest')) process.exit(selftest());
  // --anchor pins the end of the window (`--anchor <ISO time>`), so a reading of a frozen snapshot gives one
  // answer forever instead of moving with the clock: reconcile against a frozen copy, never a live log.
  const anchor = arg('anchor');
  const opts = { runsPath: arg('runs') || undefined, ledgerPath: arg('ledger') || undefined, hours: Number(arg('hours') || 24),
    now: anchor ? Date.parse(anchor) : undefined };
  const s = compute(opts);
  if (argv.includes('--json')) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
  const f = n => '$' + Number(n).toFixed(4);
  console.log('CAP NUMERATOR — what a spend cap divides by, measured against what gets billed');
  console.log('  runs   ' + s.runsPath);
  console.log('  ledger ' + s.ledgerPath);
  console.log('');
  console.log('  runs.jsonl only — the old numerator        ' + f(s.runsOnlyEstimate));
  console.log('  ledger + unsettled runs — this numerator   ' + f(s.metered));
  console.log('  difference the old one could not see       ' + f(s.metered - s.runsOnlyEstimate));
  console.log('');
  console.log('  billed rows in window      ' + String(s.billedRows).padStart(5) + '   ' + f(s.billedAll) + '   (every provider)');
  console.log('  billing rows that are not a run  ' + String(s.auxRows).padStart(3) + '   ' + f(s.auxUsd) + '   <- aux generations; the recon\'s skill_review/skill-eval lines');
  console.log('  rows with no run in window       ' + String(s.forBillingNoRunRows).padStart(3) + '   ' + f(s.forBillingNoRunUsd) + '   <- spend hanging off nothing in this window');
  console.log('  of that, cap-countable     ' + ' '.repeat(5) + '   ' + f(s.cappedNoRunUsd) + '   <- the part the cap was blind to');
  console.log('  runs not yet settled       ' + String(s.inFlightRuns).padStart(5) + '   ' + f(s.inFlightMetered) + '   (counted at the run estimate)');
  console.log('  owner-paid, not capped     ' + ' '.repeat(5) + '   ' + f(s.ownerPaid));
  if (s.damaged) console.log('  DAMAGED LINES: ' + s.damaged + ' — counted, not skipped; a line that cannot be parsed is spend nobody can see');
  const rows = Object.entries(s.byAgent).sort((a, b) => b[1] - a[1]);
  if (rows.length) {
    console.log('');
    console.log('  PER AGENT (cap-countable, last ' + (opts.hours || 24) + 'h):');
    for (const [a, v] of rows) console.log('    ' + a.padEnd(22) + f(v));
  }
  process.exit(0);
}

/* ---- selftest: each case is a failure this file exists for, run through the real function ---- */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-numerator-'));
  const write = (name, rows) => { const p = path.join(dir, name); fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return p; };
  const now = Date.now();
  const t = now - 3600 * 1000;
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  add('a settled run is counted at what was billed, not at the run estimate', () => {
    const runs = write('r1.jsonl', [{ runId: 'A', agentId: 'x', provider: 'openrouter', startedAt: t, usd: 1.0 }]);
    const ledger = write('l1.jsonl', [{ runId: 'A', agentId: 'x', ts: t + 1000, usd: 1.25, model: 'gpt-x' }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now });
    return near(s.metered, 1.25) && near(s.runsOnlyEstimate, 1.0) ? null : 'metered ' + s.metered + ' want 1.25 (old ' + s.runsOnlyEstimate + ')';
  });
  add('an auxiliary generation with no run row is in the numerator', () => {
    const runs = write('r2.jsonl', [{ runId: 'A', agentId: 'x', provider: 'openrouter', startedAt: t, usd: 1.0 }]);
    const ledger = write('l2.jsonl', [
      { runId: 'A', agentId: 'x', ts: t + 1, usd: 1.0, model: 'gpt-x' },
      { runId: 'A_skill_review_abc', agentId: 'x', ts: t + 2, usd: 0.40, model: 'gpt-x' },
      { runId: 'skill-eval-9', ts: t + 3, usd: 0.05, model: 'gpt-x' },
    ]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now });
    // 1.45 = 1.00 (run A) + 0.40 (aux hanging off A) + 0.05 (skill-eval, no run at all). Only the last
    // is a row with no run; the aux one has a run and is still counted because it was billed.
    return near(s.metered, 1.45) && s.forBillingNoRunRows === 1 && near(s.cappedNoRunUsd, 0.05)
      ? null : 'metered ' + s.metered + ' want 1.45, noRunRows ' + s.forBillingNoRunRows + ', cappedNoRun ' + s.cappedNoRunUsd;
  });
  const OWNER = ['claude-cli', 'deepseek'];   // a budget file that lists DeepSeek as not capped
  add('a provider in unmeteredProviders stays out of the capped number', () => {
    const runs = write('r3.jsonl', [{ runId: 'A', agentId: 'x', provider: 'deepseek', startedAt: t, usd: 2.0 }]);
    const ledger = write('l3.jsonl', [{ runId: 'A', agentId: 'x', ts: t + 1, usd: 2.0, model: 'deepseek-flash', unmetered: false, billingClass: 'metered' }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now, providers: OWNER });
    return near(s.metered, 0) && near(s.ownerPaid, 2.0) ? null : 'metered ' + s.metered + ' want 0, ownerPaid ' + s.ownerPaid;
  });
  add('a DeepSeek aux row is billed and visible, but not cap-countable (the two meanings, kept apart)', () => {
    const runs = write('r4.jsonl', []);
    const ledger = write('l4.jsonl', [{ runId: 'Z_skill_review_q', ts: t + 5, usd: 0.30, model: 'deepseek-flash', unmetered: false, billingClass: 'metered' }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now, providers: OWNER });
    return near(s.metered, 0) && near(s.forBillingNoRunUsd, 0.30) && near(s.billedAll, 0.30)
      ? null : 'metered ' + s.metered + ' want 0, forBillingNoRun ' + s.forBillingNoRunUsd + ', billedAll ' + s.billedAll;
  });
  add('a metered run the ledger has not settled yet is still counted (in flight)', () => {
    const runs = write('r5.jsonl', [{ runId: 'A', agentId: 'x', provider: 'openrouter', startedAt: t, usd: 0.60 }]);
    const ledger = write('l5.jsonl', []);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now });
    return near(s.metered, 0.60) && s.inFlightRuns === 1 ? null : 'metered ' + s.metered + ' want 0.60, inFlight ' + s.inFlightRuns;
  });
  add('per-agent shares use the billed row, and an aux row lands on its own agent', () => {
    const runs = write('r6.jsonl', [{ runId: 'A', agentId: 'x', provider: 'openrouter', startedAt: t, usd: 1.0 }]);
    const ledger = write('l6.jsonl', [
      { runId: 'A', agentId: 'x', ts: t + 1, usd: 1.0, model: 'gpt-x' },
      { runId: 'A_skill_review_z', agentId: 'y', ts: t + 2, usd: 0.30, model: 'gpt-x' },
    ]);
    const by = spentByAgent({ runsPath: runs, ledgerPath: ledger, now });
    return near(by.x, 1.0) && near(by.y, 0.30) ? null : JSON.stringify(by);
  });
  add('a row that says nothing about billing or model counts as capped (under-counting is the defect)', () => {
    const runs = write('r7.jsonl', []);
    const ledger = write('l7.jsonl', [{ runId: 'Z_skill_review_q', ts: t + 5, usd: 0.07 }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now });
    return near(s.metered, 0.07) ? null : 'metered ' + s.metered + ' want 0.07 (unknown ⇒ counted)';
  });
  add('with the neutral list (claude-cli only), a DeepSeek row with no provider is capped, a Claude one is not', () => {
    const runs = write('r9.jsonl', []);
    const ledger = write('l9.jsonl', [{ runId: 'P', ts: t + 5, usd: 0.20, model: 'deepseek-flash' }, { runId: 'Q', ts: t + 6, usd: 0.50, model: 'claude-sonnet-5-5' }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now, providers: ['claude-cli'] });
    return near(s.metered, 0.20) && near(s.ownerPaid, 0.50) ? null : 'metered ' + s.metered + ' want 0.20, ownerPaid ' + s.ownerPaid;
  });
  add('the window follows the run, not the settlement (a run that settles late still counts)', () => {
    const runs = write('r8.jsonl', [{ runId: 'A', agentId: 'x', provider: 'openrouter', startedAt: t, usd: 1.0 }]);
    const ledger = write('l8.jsonl', [{ runId: 'A', agentId: 'x', ts: now + 3600 * 1000, usd: 1.1, model: 'gpt-x' }]);
    const s = compute({ runsPath: runs, ledgerPath: ledger, now });
    return near(s.metered, 1.1) ? null : 'metered ' + s.metered + ' want 1.1 (settled after the window closed)';
  });

  add('meteredSince is the cap numerator over a shorter window (no slack rows from hours earlier)', () => {
    const runs = write('r10.jsonl', [
      { runId: 'OLD', agentId: 'x', provider: 'deepseek', startedAt: now - 5 * 3600e3, endedAt: now - 5 * 3600e3 + 60e3, usd: 0.80 },
      { runId: 'NEW', agentId: 'x', provider: 'deepseek', startedAt: now - 20 * 60e3, endedAt: now - 10 * 60e3, usd: 0.30 },
    ]);
    const ledger = write('l10.jsonl', [{ runId: 'NEW', agentId: 'x', ts: now - 10 * 60e3, usd: 0.35, model: 'deepseek-flash' }, { runId: 'OLD', agentId: 'x', ts: now - 5 * 3600e3 + 60e3, usd: 0.80, model: 'deepseek-flash' }]);
    const h1 = meteredSince(now - 3600e3, { runsPath: runs, ledgerPath: ledger, now, providers: ['claude-cli'] });
    const d = compute({ runsPath: runs, ledgerPath: ledger, now, providers: ['claude-cli'] }).metered;
    return near(h1, 0.35) && near(d, 1.15) ? null : 'last hour ' + h1 + ' want 0.35, 24h ' + d + ' want 1.15';
  });

  let pass = 0;
  for (const c of cases) {
    let err = null;
    try { err = c.fn(); } catch (e) { err = 'threw: ' + e.message; }
    if (!err) pass++;
    console.log((err ? 'FAIL' : 'PASS') + '  ' + c.name + (err ? '  (' + err + ')' : ''));
  }
  console.log('\nselftest: ' + pass + '/' + cases.length);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return pass === cases.length ? 0 : 1;
}

function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.0000005; }

if (require.main === module) main();
module.exports = { spendSplit, spentByAgent, meteredSince, isCapped, baseRunId, compute, unmeteredProviders, providerOfModel };
