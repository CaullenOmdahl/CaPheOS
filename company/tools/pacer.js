#!/usr/bin/env node
/* pacer.js — paces the company's AI use across the flat-fee subscriptions (Claude Max, MiniMax) and DeepSeek.
 *
 * The rule (company/MODEL_POLICY.md, "Pacing"; numbers in company/work/finance/pacing-policy.json):
 *  - Lean into the subscriptions, but a subscription with a weekly limit may use at most dailyFraction (e.g. 1/7) of
 *    that limit per day, scaled by shareOfAccount when the account is shared with another company. Days count from
 *    the start of that subscription's own weekly window (Claude: resetsAt minus 7 days; MiniMax: weekly_start_time).
 *    During day k (1..7) the week's used % may not pass k x 100 x dailyFraction x share minus a safety margin, so
 *    unused share carries forward within the week. An emergency (company/state/emergency.json) lifts the line to the
 *    emergency ceiling; nothing passes the subscription's hard weekly stop (weekCloseAtUsedPct).
 *  - The Claude meter is the whole account (any other use of it counts), so routines get Claude only while the meter
 *    is under the line. Of the station's reading and an optional status-line feed, the highest fresh reading for the
 *    current week is used; a stale reading is unknown, and unknown means closed. So that this never deadlocks (closed,
 *    so no Claude run, so no new reading), a stale meter is refreshed by the pacer itself: one tiny internal check run on
 *    the cheapest Claude model, at most once per staleAfterMin (claude.meterCheck; `pacer.js meter-check`, docs/BUDGET.md).
 *    A usage-limit error closes Claude until the window that ran out resets (5 hours when the meters do not say which).
 *    The overage window (seven_day_overage_included "rejected": extra usage off) never closes Claude.
 *  - MiniMax closes on its own limits (5-hour window, week); Claude also when its 5-hour window is too far used or the
 *    account answers "rejected". Once closed, a subscription reopens only reopenBandPct under the line (no flapping).
 *  - Routines run on Haiku or Sonnet at most, never Opus or Fable. Each routine names a scope in
 *    company/model-policy.json routing: an ordered chain of model families; it runs on the first link open now, never
 *    switching while it runs. A move onto a subscription happens at most once an hour per routine and for at most a
 *    few routines an hour in all; a move off a closed subscription happens at once. A run that a model refused blocks
 *    that provider for that routine for a while; re-firing it is off unless routing.refireWithinMin is set.
 *  - DeepSeek is pay-per-use: no cost figures reach the agents. Routines must never trip the station's own daily rail
 *    (GET /api/budget/status caps.perDay), which needs a manual RESUME: near it the dispatcher holds DeepSeek wake-ups
 *    that have no OPEN handoff due today, and closer still the pacer pauses scheduled DeepSeek routines on the same
 *    terms (StarNet fires those without the dispatcher), resuming them once the rail falls back.
 *  - DeepSeek's peak-price hours (pacing-policy.json peakPricing, in DeepSeek's own timezone) are a second trigger of
 *    the same hold (company/tools/offpeak-hold.js).
 *  - The dispatcher may fire an extra loop a tick while Claude or MiniMax has more than half a day's share left, and
 *    only when the extra loop runs on that subscription.
 *
 * Numbers: company/work/finance/pacing-policy.json (the finance seat). Routing table: company/model-policy.json
 * "routing" (the people seat; the CEO approves). State: company/state/pacer-state.json (one writer at a time:
 * pacer-state.json.lock). Report: company/work/finance/ai-usage.md.
 * Mode "shadow" (the policy file's default): it measures, plans, logs and reports, and changes nothing on the station,
 * except to lift a rail pause it made itself while it was live.
 *
 *   node company/tools/pacer.js status [--json]     the meters and what is open to routines (read-only)
 *   node company/tools/pacer.js plan [--json]       what each routine should run on now, and why (read-only)
 *   node company/tools/pacer.js report              write company/work/finance/ai-usage.md
 *   node company/tools/pacer.js apply               live: switch, pause and resume routines; shadow: print what live would do
 *   node company/tools/pacer.js restore             put every routine the pacer moved back on its earlier model and lift its pauses
 *   node company/tools/pacer.js emergency on --why "..." --by <name> --hours 4     (emergency.allowedBy; at most maxHours)
 *   node company/tools/pacer.js emergency off --by <name> [--why "..."]
 *   node company/tools/pacer.js meter-check [--at <ms>]  run the pending Claude meter check (a tick starts it detached)
 *   node company/tools/pacer.js limits [--json]     per subscription: usage, reset, weekly stop, use-now, affected seats
 *   node company/tools/pacer.js limit claude|minimax [--week-stop N] [--use-now N] --by <name> --why "..."
 *        the recorded way to set a subscription cutoff (provenance, changes[], dispatch log): the owner always; the CEO or
 *        finance seat only while self-governance gives budget to the company. When a cutoff holds seats or moves them
 *        off a subscription and the owner has not set it this week, the live pacer asks the owner once on Today (two
 *        sliders; lib/pacing-ask.js); at auto/notify that is an FYI and it does not wait.
 *
 * The spendCap guardrail off (company/state/guardrails.json): no pacing line or weekly stop closes a subscription (a
 * provider's own refusal still does); each such state is logged once as SPENDCAP OFF. A hand-started emergency is a budget
 * decision under self-governance (company/state/governance.json): at approve it waits for the owner's yes.
 *
 * Seats with their own model chain (company/model-policy.json seats, company/tools/models.js) are not routed here: plan()
 * leaves their routines untouched, and each hook tick hands its measurement to models.js tick(), which moves those
 * seats down and back up their chains (its own failover.mode; StarNet's station-wide fallback chain stays the backstop).
 *
 * dispatch.js calls dispatchHook() once per tick inside try/catch; an error or a 40-second timeout leaves the tick as
 * it would have been without the pacer. It never prints a key: provider keys are read from secrets/ (or the station's
 * key file) and sent only in the Authorization header.
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const co = require('./lib/company');
const mm = require('./lib/models-money');
const MME = require('./lib/minimax-endpoint');
const gov = require('./lib/governance');

const DEFAULT_ROOT = co.ROOT;
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3, MB = 1024 * 1024;
const B = require('./lib/bounded');
const HOOK_TIMEOUT_MS = 40000;
const REL = {
  policy: 'company/work/finance/pacing-policy.json',
  policyDefault: 'company/defaults/work/finance/pacing-policy.json',
  modelPolicy: 'company/model-policy.json',
  state: 'company/state/pacer-state.json',
  emergency: 'company/state/emergency.json',
  journal: 'company/state/pacer-log.jsonl',
  dispatchLog: 'company/work/dispatch-log.md',
  report: 'company/work/finance/ai-usage.md',
  subs: '.starnet-data/workspaces/.usage/subscriptions.json',
  runs: '.starnet-data/workspaces/runs.jsonl',
  keys: '.starnet-data/workspaces/.secrets/provider-keys.json',
  loops: 'company/tools/loops.json',
  handoffs: 'company/work/handoffs',
  competenceOut: 'company/work/people/competence.json',
  ledger: '.starnet-data/workspaces/ledger.jsonl',
  knobs: '.starnet-data/workspaces/runtime.knobs.json',
  token: 'secrets/station-token',
  meterCheck: 'company/state/claude-meter-check.json',
  halt: 'company/state/halt.json',
};
// Used when company/work/finance/pacing-policy.json is missing or a number in it is unusable. A missing file means shadow.
const DEFAULTS = {
  mode: 'shadow',
  dailyFraction: '1/7',
  marginPct: 1,
  reopenBandPct: 1,
  shareOfAccount: 1,
  // meterCheck: when the Claude reading goes stale, one tiny internal run (cheapest model, a few words, no tools) makes
  // the station read the meter again, at most once per staleAfterMin; without it a stale meter closed Claude, nothing
  // could start, and nothing refreshed it (2026-11-19: 8 hours closed in both companies until the owner reopened it)
  claude: { feedFile: '', staleAfterMin: 90, fiveHourCloseAtUsedPct: 70, meterCheck: { enabled: true, model: '', timeoutSec: 180 } },
  // url '' = from the company's MiniMax endpoint (company.json providers.minimax, lib/minimax-endpoint.js)
  minimax: { url: '', modelName: 'general', pollEveryMin: 10, staleAfterMin: 45, fiveHourCloseBelowLeftPct: 20 },
  emergency: { ceilingPct: 90, maxHours: 12, allowedBy: ['ceo', 'risk'], autoOnSerious: true, autoHours: 6 },
  routing: { switchAtMostEveryMin: 60, maxOntoSubscriptionPerHour: 2, refusalBlockHours: 24, refusalFirstBlockHours: 2, refusalRepeatWithinHours: 24, refireWithinMin: 120, blockOutcomes: ['refused'], blockFailureCodes: ['content_policy_blocked'] },
  deepseekRail: { holdAtPct: 85, pauseScheduledAtPct: 90, resumeBelowPct: 80, projectFromHours: 3, overflowToMiniMax: true },
  // DeepSeek is prepaid: when the balance runs out every call answers 402 "Insufficient Balance" and every routine on
  // it stops. The pacer asks DeepSeek's balance endpoint whether calls are possible (is_available only: no amount is
  // read into state, a log or a report) and also reads the routines' own errors.
  deepseek: { balanceUrl: 'https://api.deepseek.com/user/balance', pollEveryMin: 10, staleAfterMin: 30, creditFailureHoldMin: 120 },
  offpeakHold: { enabled: true },   // `false` is the kill switch for the peak trigger: a policy key, not a code edit
  throughput: { boostedMaxPerTick: 3, boostWhenShareLeftAbove: 0.5 },
};
const ROUTINE_TIERS = ['light', 'standard'];   // Haiku and Sonnet; Opus (heavy) and Fable (top) never run routines
// the flat-fee subscriptions (claude-cli, custom): one table, lib/pacing-ask.js SUBS, which routing.js also reads
const SUBS = Object.values(require('./lib/pacing-ask.js').SUBS).map(x => x.provider);
const NAMES = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek' };

/* ---------- small helpers ---------- */
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const numOr = (v, d, lo, hi) => { const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(n) && (lo == null || n >= lo) && (hi == null || n <= hi) ? n : d; };
/* the owner's line when a crew member changes a subscription cutoff at budget=notify: what it is about, in plain words;
 * the setting names and numbers ride in `technical`, and the crew's reason only when it reads plainly */
function limitNotice(by, sub, what, why) {
  const words = t => { try { return !require('./lib/owner-scope').wordsProblems(t).length; } catch (_) { return false; } };
  const reason = why && words(why) && String(why).length <= 120 ? ' ' + by + '\'s reason: ' + String(why).trim().replace(/[.!]?$/, '').replace(/^./, c => c.toLowerCase()) + '.' : '';
  return { text: by + ' changed when the crew stops using the ' + sub + ' subscription.' + reason + ' You can change it back in Settings › Models and subscriptions.', technical: by + ' set the ' + sub + ' cutoffs: ' + what + ' (' + why + ').' };
}
function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function writeJsonAtomic(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  const txt = JSON.stringify(obj, null, 1) + '\n';
  fs.writeFileSync(tmp, txt);
  fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, 'pacer.js'); } catch (_) {}   // locked-watch.js: this tool's own write
}
function writeTextAtomic(f, txt) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, txt);
  fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, 'pacer.js'); } catch (_) {}
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
function fraction(v) {
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?\s*$/.test(v)) { const [a, b] = v.split('/').map(Number); return b ? a / b : NaN; }
  return Number(v);
}
const toMs = v => { const n = Number(v); if (v == null || !Number.isFinite(n) || n <= 0) return null; return n < 1e12 ? n * 1000 : n; };
const z = n => String(n).padStart(2, '0');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// clock words in the company timezone (company/company.json), whatever the machine's own zone is
const cz = ms => mm.zoneParts(ms, co.TZ);
function when(ms) { if (!isNum(ms)) return 'unknown'; const p = cz(ms), [, mo, d] = p.date.split('-').map(Number); return WD[p.day] + ' ' + d + ' ' + MO[mo - 1] + ' ' + z(p.hour) + ':' + z(p.minute); }
function hm(ms) { if (!isNum(ms)) return '?'; const p = cz(ms); return WD[p.day] + ' ' + z(p.hour) + ':' + z(p.minute); }
function age(ms, t) { if (!isNum(ms)) return 'unknown age'; const m = Math.max(0, Math.round((t - ms) / MIN)); return m < 120 ? m + ' min' : (m / 60).toFixed(1) + ' h'; }
const f1 = v => isNum(v) ? String(Math.round(v * 10) / 10) : '?';
const localDate = ms => cz(ms).date;
function stamp(ms) { const p = cz(ms); return p.date + ' ' + z(p.hour) + ':' + z(p.minute); }

/* ---------- pure rules (exported for the tests) ---------- */
function dayOf(weekStart, t) { return Math.min(7, Math.max(1, Math.floor((t - weekStart) / DAY) + 1)); }
function lineFor(day, frac, margin) { return Math.min(100, day * 100 * frac) - margin; }
// the first day of this week whose line (less the reopening band) is above `used`, or null when none is (the meter
// stays over the line all week)
function nextOpenDay(used, frac, margin, band) { for (let k = 1; k <= 7; k++) if (lineFor(k, frac, margin) - (band || 0) > used) return k; return null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadPolicy(root, override) {
  const file = path.join(root, REL.policy);
  const problems = [];
  let raw = readJson(file, null);
  if (!raw) {
    raw = readJson(path.join(root, REL.policyDefault), null);
    problems.push('company/work/finance/pacing-policy.json is missing or unreadable: ' + (raw ? 'the company/defaults copy' : 'built-in defaults') + ' in use, mode shadow');
    if (raw) raw = Object.assign({}, raw, { mode: 'shadow' });
  }
  const p = merge(merge(JSON.parse(JSON.stringify(DEFAULTS)), raw || {}), override || {});
  p.mode = raw && p.mode === 'live' ? 'live' : 'shadow';
  if (override && override.mode) p.mode = override.mode === 'live' ? 'live' : 'shadow';
  const fr = fraction(p.dailyFraction);
  p.dailyFractionText = typeof p.dailyFraction === 'string' ? p.dailyFraction : String(p.dailyFraction);
  p.dailyFraction = fr > 0 && fr <= 1 ? fr : 1 / 7;
  p.marginPct = numOr(p.marginPct, 1, 0, 50);
  // the company's share of each subscription account (another company, or the owner, may use the same account)
  p.shareOfAccount = numOr(p.shareOfAccount, 1, 0.01, 1);
  p.claude.shareOfAccount = numOr(p.claude.shareOfAccount, p.shareOfAccount, 0.01, 1);
  p.minimax.shareOfAccount = numOr(p.minimax.shareOfAccount, p.shareOfAccount, 0.01, 1);
  p.reopenBandPct = numOr(p.reopenBandPct, 1, 0, 20);
  p.claude.staleAfterMin = numOr(p.claude.staleAfterMin, 90, 1, 24 * 60);
  p.claude.fiveHourCloseAtUsedPct = numOr(p.claude.fiveHourCloseAtUsedPct, 70, 0, 100);
  // the stale-meter check (meterCheck): on unless set false; the model is the routing table's cheapest Claude (haiku)
  const mcIn = p.claude.meterCheck === false ? { enabled: false } : isObj(p.claude.meterCheck) ? p.claude.meterCheck : {};
  let mcModel = typeof mcIn.model === 'string' && mcIn.model.trim() ? mcIn.model.trim() : '';
  if (!mcModel) { try { const rm = ((readJson(path.join(root, REL.modelPolicy), {}) || {}).routing || {}).models || {}; if (rm.haiku && rm.haiku.provider === 'claude-cli' && rm.haiku.model) mcModel = String(rm.haiku.model); } catch (_) {} }
  p.claude.meterCheck = { enabled: mcIn.enabled !== false, model: mcModel || 'haiku', timeoutSec: numOr(mcIn.timeoutSec, 180, 30, 900) };
  // the usage URL follows the company's MiniMax region unless pacing-policy.json names its own (not a built-in default)
  const mmUse = MME.usageUrlFor(p.minimax.url, MME.read(root));
  p.minimax.url = mmUse.url; p.minimax.urlFrom = mmUse.from;
  p.minimax.pollEveryMin = numOr(p.minimax.pollEveryMin, 10, 10, 24 * 60);   // never more often than every 10 minutes
  p.minimax.staleAfterMin = numOr(p.minimax.staleAfterMin, 45, 10, 24 * 60);
  p.minimax.fiveHourCloseBelowLeftPct = numOr(p.minimax.fiveHourCloseBelowLeftPct, 20, 0, 100);
  p.minimax.paceBy = p.minimax.paceBy === 'fiveHour' ? 'fiveHour' : 'week';
  p.minimax.weekCloseAtUsedPct = numOr(p.minimax.weekCloseAtUsedPct, 100, 1, 100);   // the account's hard weekly stop
  p.claude.weekCloseAtUsedPct = numOr(p.claude.weekCloseAtUsedPct, 95, 1, 100);       // the account's hard weekly stop
  // the owner's cutoffs (lib/pacing-ask.js, `pacer.js limit`): 0 = spread evenly, 100 = today's line is the weekly stop
  for (const k of ['claude', 'minimax']) p[k].useNowPct = numOr(p[k].useNowPct, 0, 0, 100);
  p.claude.dailyLineFromMs = p.claude.dailyLineFrom ? (Date.parse(p.claude.dailyLineFrom) || null) : null;   // optional: no daily line before this time
  p.emergency.ceilingPct = numOr(p.emergency.ceilingPct, 90, 0, 100);
  p.emergency.maxHours = numOr(p.emergency.maxHours, 12, 0, 12);   // never more than 12 hours
  p.emergency.autoHours = Math.min(p.emergency.maxHours, numOr(p.emergency.autoHours, 6, 0, 12));
  if (!Array.isArray(p.emergency.allowedBy)) p.emergency.allowedBy = DEFAULTS.emergency.allowedBy.slice();
  p.routing.switchAtMostEveryMin = numOr(p.routing.switchAtMostEveryMin, 60, 0, 24 * 60);
  p.routing.refusalBlockHours = numOr(p.routing.refusalBlockHours, 24, 0, 24 * 7);   // a REPEAT refusal (2+ in refusalRepeatWithinHours)
  p.routing.refusalFirstBlockHours = numOr(p.routing.refusalFirstBlockHours, 2, 0, 24 * 7);   // a routine's first refusal
  p.routing.refusalRepeatWithinHours = numOr(p.routing.refusalRepeatWithinHours, 24, 1, 24 * 7);
  p.routing.maxOntoSubscriptionPerHour = numOr(p.routing.maxOntoSubscriptionPerHour, 2, 0, 100);   // 0 = no ramp limit
  // owner ruling: a refused run is never lost — it is re-run once, unchanged, on the routine's next model (lib/refusal.js);
  // refireWithinMin is only how fresh a refusal must be for that re-run (0, the old "never", reads as the default)
  p.routing.refireWithinMin = numOr(p.routing.refireWithinMin, 120, 1, 24 * 60);
  for (const k of ['blockOutcomes', 'blockFailureCodes']) if (!Array.isArray(p.routing[k])) p.routing[k] = DEFAULTS.routing[k].slice();
  p.deepseekRail.holdAtPct = numOr(p.deepseekRail.holdAtPct, 85, 1, 100);
  p.deepseekRail.pauseScheduledAtPct = numOr(p.deepseekRail.pauseScheduledAtPct, 90, 1, 100);   // 100 = never pause
  p.deepseekRail.resumeBelowPct = Math.min(p.deepseekRail.pauseScheduledAtPct, numOr(p.deepseekRail.resumeBelowPct, 80, 0, 100));
  p.deepseekRail.projectFromHours = numOr(p.deepseekRail.projectFromHours, 3, 1, 24);
  if (!p.deepseek || typeof p.deepseek !== 'object') p.deepseek = JSON.parse(JSON.stringify(DEFAULTS.deepseek));
  p.deepseek.pollEveryMin = numOr(p.deepseek.pollEveryMin, 10, 10, 24 * 60);   // never more often than every 10 minutes
  p.deepseek.staleAfterMin = numOr(p.deepseek.staleAfterMin, 30, 10, 24 * 60);
  p.deepseek.creditFailureHoldMin = numOr(p.deepseek.creditFailureHoldMin, 120, 10, 24 * 60);
  if (!p.offpeakHold || typeof p.offpeakHold !== 'object') p.offpeakHold = { enabled: true };
  p.offpeakHold.enabled = p.offpeakHold.enabled !== false;
  p.throughput.boostedMaxPerTick = numOr(p.throughput.boostedMaxPerTick, 3, 1, 10);
  p.throughput.boostWhenShareLeftAbove = numOr(p.throughput.boostWhenShareLeftAbove, 0.5, 0, 7);
  p.problems = problems;
  return p;
}

// The routing table in company/model-policy.json, checked against that file's own allow-lists (the rule hire.js
// policyCheck applies) and against the routine tier rule (Haiku and Sonnet only).
function loadRouting(root) {
  const mp = readJson(path.join(root, REL.modelPolicy), {}) || {};
  const allowed = mp.allowed || {};
  const r = mp.routing || {};
  const problems = [];
  const allowedPair = (provider, model) => !!(allowed[provider] && Array.isArray(allowed[provider].models) && allowed[provider].models.includes(model));
  const models = {};
  for (const [k, v] of Object.entries(r.models || {})) {
    if (!v || !v.provider || !v.model) { problems.push('routing model "' + k + '" has no provider/model'); continue; }
    let ok = allowedPair(v.provider, v.model), why = ok ? '' : v.provider + '/' + v.model + ' is not on the allowed list';
    if (ok && v.provider === 'claude-cli') {
      const tier = ((allowed['claude-cli'] || {}).tiers || {})[v.model];
      if (!ROUTINE_TIERS.includes(tier)) { ok = false; why = v.model + ' is a ' + (tier || 'unknown') + ' tier: routines use Haiku or Sonnet only'; }
    }
    if (!ok) problems.push('routing model "' + k + '": ' + why);
    models[k] = { key: k, provider: v.provider, model: v.model, ok, why };
  }
  if (!models.deepseek || !models.deepseek.ok) {
    problems.push('routing has no usable "deepseek" model: DeepSeek V4.1 Flash is assumed as the fallback');
    models.deepseek = { key: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', ok: allowedPair('deepseek', 'deepseek-flash'), why: '' };
  }
  const routines = isObj(r.routines) ? r.routines : {};
  // Scopes: an ordered chain of one to three model families per scope, kept by the people seat. A routine names its
  // scope; the pacer runs it on the first link that is open now. 'claude' = the routine's Claude
  // tier (its "claude" key, sonnet when it names none), 'minimax' = the MiniMax model, 'deepseek' = DeepSeek.
  const scopes = {};
  for (const [k, v] of Object.entries(isObj(r.scopes) ? r.scopes : {})) {
    if (k.startsWith('_')) continue;
    const chain = v && Array.isArray(v.chain) ? v.chain.map(String) : null;
    const bad = !chain || !chain.length || chain.length > 3 || new Set(chain).size !== chain.length || chain.some(x => !LINKS.includes(x));
    if (bad) { problems.push('scope "' + k + '" needs a chain of 1 to 3 different links from ' + LINKS.join(', ') + ' (it has ' + JSON.stringify(v && v.chain) + ')'); continue; }
    // claudeReserve: this scope's Claude link ignores the daily line (it still closes at the week's hard stop, on the
    // 5-hour window, on a usage-limit error or an unknown meter), so the seat it serves (the CEO) never goes dark.
    scopes[k] = { key: k, chain, who: v.who || '', claudeReserve: v.claudeReserve === true };
  }
  for (const [name, e] of Object.entries(routines)) {
    if (name.startsWith('_') || !e || e.scope == null) continue;
    if (!scopes[e.scope]) problems.push('routine "' + name + '" names scope "' + e.scope + '", which is not a usable scope: the older routing rule applies to it');
  }
  const chainFor = key => { const e = routines[key]; const s = e && e.scope != null ? scopes[e.scope] : null; return s ? s : null; };
  return { models, routines, scopes, chainFor, problems, allowedPair, tierOf: m => ((allowed['claude-cli'] || {}).tiers || {})[m] || null };
}
const LINKS = ['claude', 'minimax', 'deepseek'];
const linkOfProvider = p => p === 'claude-cli' ? 'claude' : p === 'custom' ? 'minimax' : p === 'deepseek' ? 'deepseek' : null;
// the error a routine records when DeepSeek's prepaid balance is gone ("openai-compatible http 402 - [type
// insufficient_balance_error ...] Insufficient Balance")
const CREDIT_RE = /insufficient[_ ]balance|http 402\b/i;
// longest routing key that names this routine (exact, or a prefix as dispatch.js matches loops: "Ops loop" fits
// "Ops loop — run the company")
function routingKeyFor(name, routines) {
  const n = String(name || '');
  return Object.keys(routines || {}).filter(k => !k.startsWith('_') && (n === k || n.startsWith(k))).sort((a, b) => b.length - a.length)[0] || null;
}

function parseMiniMax(body, modelName, at) {
  const base = body && body.base_resp;
  if (base && Number(base.status_code) !== 0) return { ok: false, error: 'MiniMax answered status ' + base.status_code + (base.status_msg ? ' (' + String(base.status_msg).slice(0, 80) + ')' : '') };
  const rows = (body && Array.isArray(body.model_remains)) ? body.model_remains : [];
  const row = rows.find(r => r && r.model_name === modelName);
  if (!row) return { ok: false, error: 'no "' + modelName + '" row in the MiniMax answer' };
  const wl = Number(row.current_weekly_remaining_percent), il = Number(row.current_interval_remaining_percent);
  if (row.current_weekly_remaining_percent == null || !Number.isFinite(wl)) return { ok: false, error: 'the MiniMax answer has no weekly percentage' };
  return {
    ok: true, at,
    usedPct: Math.max(0, Math.min(100, 100 - wl)),
    weekStart: toMs(row.weekly_start_time), weekEnd: toMs(row.weekly_end_time),
    fiveHourLeftPct: row.current_interval_remaining_percent == null || !Number.isFinite(il) ? null : il,
    fiveHourStart: toMs(row.start_time), fiveHourEnd: toMs(row.end_time),
    weeklyStatus: row.current_weekly_status == null ? null : row.current_weekly_status,
    intervalStatus: row.current_interval_status == null ? null : row.current_interval_status,
  };
}

// OPEN handoffs in one inbox that count as due today: a Deadline that is today, overdue, or says "today", "tonight",
// "now", "asap", "EOD"/"end of day" and the like (free text, read loosely), and any OPEN handoff with no Deadline line
// at all (an unknown deadline is treated as today, so a hold never sits on unread urgent work).
const DUE_WORDS = /\b(today|tonight|this (morning|afternoon|evening)|now|asap|urgent|urgently|immediately|overdue|eod|cob|end[ -]of[ -](the[ -])?day|close of business)\b/i;
function handoffsDueToday(file, t) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const today = localDate(t), out = [];
  for (const sec of txt.split(/^## /m).slice(1)) {
    if (!/^\*\*Status:\*\*\s*OPEN\b/m.test(sec)) continue;
    const m = sec.match(/^\*\*Deadline:\*\*\s*(.*)$/m);
    if (!m) { out.push(sec.split('\n')[0].trim()); continue; }
    // "no later than today" / "not later than today" is a deadline, not a negation
    const dl = m[1].replace(/\b(no|not)\s+later\s+th[ae]n\b/gi, 'by');
    const dates = (dl.match(/\b20\d\d-\d\d-\d\d\b/g) || []).sort();
    const negated = /\b(nothing|not|no)\b[^.;]{0,40}\b(today|tonight)\b/i.test(dl);
    const word = !negated && DUE_WORDS.test(dl);
    if (word || (dates.length && dates[0] <= today)) out.push(sec.split('\n')[0].trim());
  }
  return out;
}

const isUsageLimit = r => String(r.failureCode || '') === 'quota_exhausted'
  || /usage[_ ]limit[_ ]reached|usage limit reached|hit your (weekly |session |)limit/i.test(String(r.error || ''));

/* ---------- the station and MiniMax ---------- */
function stationCall(root, host) {
  const HOST = host || co.STATION_URL;
  let token = null;
  const tok = () => { if (token == null) { token = mm.readSecret(root, 'station-token'); if (!token) throw new Error('no station token (secrets/station-token)'); } return token; };
  return (method, p, body, timeoutMs) => new Promise((resolve, reject) => {
    const u = new URL(HOST + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'x-starnet-token': tok() }, body ? { 'Content-Type': 'application/json' } : {}), timeout: timeoutMs || 15000 }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 4e6) d = d.slice(-1e6); });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
// POST /api/cron/run {id, detach:true}, resolved on the first byte of a 200 (admitted) like dispatch.js fireRun, so a
// long run never blocks the tick.
function stationFire(root, host) {
  const HOST = host || co.STATION_URL;
  return jobId => new Promise(resolve => {
    let done = false; const finish = r => { if (!done) { done = true; resolve(r); } };
    const token = mm.readSecret(root, 'station-token');
    if (!token) return finish({ status: 0, body: 'no station token' });
    const u = new URL(HOST + '/api/cron/run');
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-starnet-token': token, 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => { d += c; if (res.statusCode === 200 && d.length > 0) { finish({ status: 200, body: d.slice(0, 200) }); req.destroy(); } });
      res.on('end', () => finish({ status: res.statusCode, body: d }));
      res.on('error', () => finish({ status: res.statusCode || 0, body: d }));
    });
    req.setTimeout(15000, () => finish({ status: 0, body: 'no response in 15s (run may still be detached-live)' }));
    req.on('error', e => finish({ status: 0, body: e.message }));
    req.write(JSON.stringify({ id: jobId, detach: true }));
    req.end();
  });
}
// GET the MiniMax plan's remaining quota. The key goes only into the Authorization header; nothing returned holds it.
function minimaxFetch(root, url) {
  return async () => {
    let key = mm.readSecret(root, 'minimax-key') || MME.storedKey(root);   // secrets/ first, then the station's provider-key store
    if (!key) return { ok: false, error: 'no MiniMax key on file' };
    const scrub = s => String(s).split(key).join('[key]');
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(10000) });
      const txt = scrub(await r.text());   // an answer that echoes the key (an error message, say) never carries it further
      let j = null; try { j = JSON.parse(txt); } catch (_) {}
      if (!r.ok || !j) return { ok: false, error: 'MiniMax answered HTTP ' + r.status };
      return { ok: true, body: j };
    } catch (e) { return { ok: false, error: scrub((e && e.message) || e).slice(0, 120) }; }
  };
}

// DeepSeek's balance endpoint answers { is_available, balance_infos: [...] }. is_available goes to the pacer's state; the
// amounts (balance_infos, per currency: USD or CNY, never summed) go ONLY to the owner's company/state/provider-balance.json
// (lib/provider-balance.js, 0600), never to the pacer's state, its log, a report or an agent's prompt.
function deepseekFetch(root, url) {
  return async () => {
    let key = mm.readSecret(root, 'deepseek-key') || '';
    if (!key) try { key = String((((readJson(path.join(root, REL.keys), {}) || {}).providers || {}).deepseek || {}).key || ''); } catch (_) {}
    if (!key) return { ok: false, error: 'no DeepSeek key on file' };
    const scrub = s => String(s).split(key).join('[key]');
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      let j = null; try { j = JSON.parse(await r.text()); } catch (_) {}
      if (!r.ok || !j || typeof j.is_available !== 'boolean') return { ok: false, error: 'DeepSeek balance check answered HTTP ' + r.status };
      return { ok: true, available: j.is_available, balances: Array.isArray(j.balance_infos) ? j.balance_infos : [] };
    } catch (e) { return { ok: false, error: scrub((e && e.message) || e).slice(0, 120) }; }
  };
}

/* ---------- the pacer ---------- */
/* ASKS: what a governed pacer change says to the owner (lib/governance.js decide): plain words up front, the
 * percentages and the setting in `technical`. Exported so a test files it at approve. */
const ASKS = {
  emergency: ({ ceilingPct, hours, why }) => {
    const gov = require('./lib/governance');
    const w = why ? gov.plainPart(String(why).replace(/\s+/g, ' ').trim().replace(/[.!]$/, '').slice(0, 200)) : null;
    return { summary: 'let the crew use more of its AI subscriptions than usual for the next ' + (Number(hours) === 1 ? 'hour' : hours + ' hours'),
      recommendation: w ? 'yes, for the emergency: ' + w.replace(/^./, c => c.toLowerCase()) : 'yes, for the emergency the crew named', default: 'the crew keeps to its usual daily share',
      technical: 'Emergency: lift the subscription pacing lines to ' + ceilingPct + '% for ' + hours + ' hours: ' + String(why || '').slice(0, 200) };
  },
};
function makePacer(o) {
  o = o || {};
  const root = o.root || DEFAULT_ROOT;
  const P = k => path.join(root, REL[k]);
  // StarNet's runs.jsonl, never read whole (docs/RETENTION.md): the rows that ended since sinceMs, read from the end
  const runsWindow = (sinceMs, maxBytes) => { try { return B.jsonlWindow(P('runs'), { sinceMs, maxBytes: maxBytes || 64 * MB }).rows; } catch (_) { return []; } };
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const home = o.home || os.homedir();
  const dry = !!o.dry;
  // readOnly (the status and plan commands): no log lines, no journal, no state saved except the MiniMax reading
  // (saveMiniMax), so a look never uses up an event a tick must act on and never moves the hourly clocks.
  const readOnly = !!o.readOnly;
  const policy = loadPolicy(root, o.policy);
  const live = policy.mode === 'live';
  const call = o.call || stationCall(root, o.host);
  const fire = o.fire || stationFire(root, o.host);
  const fetchMiniMax = o.fetchMiniMax || minimaxFetch(root, policy.minimax.url);
  const fetchDeepSeek = o.fetchDeepSeek || deepseekFetch(root, policy.deepseek.balanceUrl);
  const sink = typeof o.log === 'function' ? o.log : null;   // the dispatcher's log(): prints, and writes dispatch-log.md unless --dry-run
  const quiet = !!o.quiet || readOnly;
  const frac = policy.dailyFraction, margin = policy.marginPct, share = 100 * frac, band = policy.reopenBandPct;
  const feedFile = String(policy.claude.feedFile || '').replace(/^~(?=\/|$)/, home);
  // self-governance and guardrails for this company tree (o.guards: tests only)
  const govOpts = { root, guards: o.guards };

  // one line per state change: through the dispatcher's log when called from it, else printed and appended to dispatch-log.md
  function note(line) {
    if (quiet) return;
    if (sink) { sink('PACE ' + line); return; }
    const t = now();
    console.log(stamp(t) + ' PACE ' + line);
    if (dry) return;
    try { const f = P('dispatchLog'); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Dispatch log\n\n'); fs.appendFileSync(f, '- ' + stamp(t) + ' PACE ' + line + '\n'); } catch (_) {}
  }
  function journal(kind, data) {
    if (dry || readOnly) return;
    try { fs.mkdirSync(path.dirname(P('journal')), { recursive: true }); const line = JSON.stringify(Object.assign({ at: new Date(now()).toISOString(), kind, mode: policy.mode }, data)) + '\n'; fs.appendFileSync(P('journal'), line); try { require('./provenance.js').appended(P('journal'), line, 'pacer.js'); } catch (_) {} } catch (_) {}
  }
  function loadState() {
    const s = readJson(P('state'), null) || {};
    return Object.assign({ v: 1, minimax: {}, history: { claude: [], minimax: [] }, routines: {}, original: {}, blocks: [], closures: {}, handled: {}, pendingRefires: [], refired: {}, keys: {}, seriousSeen: {}, gateOpen: {}, railPaused: {} }, s);
  }
  function saveState(st) { if (!dry && !readOnly) writeJsonAtomic(P('state'), st); }
  // the MiniMax reading only, merged into the state as it is on disk now (status/plan: the 10-minute call limit holds)
  function saveMiniMax(st) {
    if (dry) return;
    const cur = readJson(P('state'), null) || {};
    cur.minimax = st.minimax;
    writeJsonAtomic(P('state'), cur);
  }
  // One writer at a time: a command run during a dispatcher tick must not overwrite the tick's state (and lose, say,
  // lastSwitchAt). An O_EXCL lock file next to the state; one older than 2 minutes is a crashed holder's and is taken.
  async function withLock(fn, waitMs) {
    if (dry) return { value: await fn() };
    const lock = P('state') + '.lock';
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const deadline = Date.now() + (waitMs == null ? 10000 : waitMs);
    for (;;) {
      try { const fd = fs.openSync(lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let ageMs = 0; try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch (_) { continue; }
        if (ageMs > 120000) { try { fs.unlinkSync(lock); } catch (_) {} continue; }
        if (Date.now() >= deadline) return { busy: true };
        await sleep(200);
      }
    }
    try { return { value: await fn() }; } finally { try { fs.unlinkSync(lock); } catch (_) {} }
  }

  async function getJobs() {
    const r = await call('GET', '/api/cron');
    const j = JSON.parse(r.body);
    return (j && j.jobs) || [];
  }

  /* ---- measure ---- */
  // The Claude weekly meter. Among the readings that are fresh (under staleAfterMin) and for the current week, the
  // HIGHEST wins, not the newest: a status line rewrites its file every minute with a new time even while
  // its session is idle and its numbers are frozen, so the newest reading can be an old, lower number. The weekly
  // meter only rises within a week, so the pacer also never reads lower than what it itself saw for this week within
  // the same freshness window. With no fresh reading, the newest is returned and gate() calls it unknown (closed).
  // Which windows decide: the account's own week (seven_day) and 5-hour window (five_hour). A "rejected" there means
  // runs are refused. An OVERAGE window (seven_day_overage_included, with overage.status "rejected" and a reason such
  // as org_level_disabled: seen 2026-11-19 at 100% "rejected" while seven_day was 79% "allowed_warning") is the
  // pay-as-you-go extra usage past the plan, which is switched off for the account: runs inside the plan still go on,
  // so it never closes Claude. A per-model week (seven_day_opus, seven_day_sonnet) refuses only that model: it is shown,
  // and a run it really refuses closes Claude through its usage-limit error, as any refused run does.
  function readClaude(t, st) {
    const cands = [];
    const subs = readJson(P('subs'), null);
    const prim = subs && subs.providers && subs.providers['claude-cli'] && subs.providers['claude-cli'].primary;
    let notes = { overage: null, modelWeeks: [] };
    if (prim && Array.isArray(prim.windows)) {
      const w = prim.windows.find(x => x && x.id === 'seven_day'), fh = prim.windows.find(x => x && x.id === 'five_hour');
      const ov = prim.windows.find(x => x && /overage/.test(String(x.id || '')));
      if (ov || (prim.overage && prim.overage.status)) notes.overage = { status: String((ov && ov.status) || (prim.overage && prim.overage.status) || ''), why: String((prim.overage && prim.overage.why) || ''), using: !!(prim.overage && prim.overage.using) };
      notes.modelWeeks = prim.windows.filter(x => x && /^seven_day_(?!overage)/.test(String(x.id || ''))).map(x => ({ id: String(x.id), model: String(x.id).replace(/^seven_day_/, ''), usedPct: Number.isFinite(Number(x.usedPct)) && x.usedPct != null ? Number(x.usedPct) : null, status: String(x.status || '') }));
      const rejected = [w, fh].some(x => x && x.status === 'rejected');
      if (w && w.usedPct != null && Number.isFinite(Number(w.usedPct)))
        cands.push({ source: 'station', at: Number(prim.seenAt) || 0, usedPct: Number(w.usedPct), resetsAt: toMs(w.resetsAt), status: rejected ? 'rejected' : (w.status || null),
          fiveHour: fh && fh.usedPct != null && Number.isFinite(Number(fh.usedPct)) ? { usedPct: Number(fh.usedPct), resetsAt: toMs(fh.resetsAt) } : null });
      else if (rejected && Number(prim.seenAt)) cands.push({ source: 'station', at: Number(prim.seenAt), usedPct: 100, resetsAt: toMs([w, fh].find(x => x && x.status === 'rejected').resetsAt), status: 'rejected', fiveHour: null });   // an older CLI: the binding window only, no number
    }
    // the pacer's own meter check (meterCheck) refused for usage IS a reading: the account said no at that time
    const mc = readJson(P('meterCheck'), null);
    if (mc && mc.status === 'done' && mc.outcome === 'usage-limit' && isNum(mc.endedAt) && !cands.some(c => c.at > mc.endedAt)) {
      const prev = cands.slice().sort((a, b) => b.at - a.at)[0];
      cands.push({ source: 'meter check', at: mc.endedAt, usedPct: prev ? Math.max(prev.usedPct, 0) : 100, resetsAt: prev && prev.resetsAt && prev.resetsAt > t ? prev.resetsAt : null, status: 'rejected', fiveHour: null });
    }
    const feed = feedFile ? readJson(feedFile, null) : null;
    const wk = feed && feed.seven_day;
    if (wk && wk.used_percentage != null && Number.isFinite(Number(wk.used_percentage))) {
      const fh = feed.five_hour;
      cands.push({ source: 'status line', at: Number(feed.at) || 0, usedPct: Number(wk.used_percentage), resetsAt: toMs(wk.resets_at), status: null,
        fiveHour: fh && fh.used_percentage != null && Number.isFinite(Number(fh.used_percentage)) ? { usedPct: Number(fh.used_percentage), resetsAt: toMs(fh.resets_at) } : null });
    }
    if (!cands.length) return null;
    const staleMs = policy.claude.staleAfterMin * MIN;
    const fresh = cands.filter(c => t - c.at <= staleMs && !(c.resetsAt && c.resetsAt <= t));
    const resets = fresh.map(c => c.resetsAt).filter(isNum);
    const week = resets.length ? Math.max(...resets) : null;   // a reading for a newer week beats one for the week before
    const pool = week ? fresh.filter(c => !c.resetsAt || Math.abs(c.resetsAt - week) < HOUR) : fresh;
    let best;
    if (pool.length) {
      best = Object.assign({}, pool.slice().sort((a, b) => b.usedPct - a.usedPct || b.at - a.at)[0]);
      if (!best.resetsAt && week) best.resetsAt = week;
      const fhs = pool.map(c => c.fiveHour).filter(f => f && !(f.resetsAt && f.resetsAt <= t)).sort((a, b) => b.usedPct - a.usedPct);
      best.fiveHour = fhs[0] || null;
      if (pool.some(c => c.status === 'rejected')) best.status = 'rejected';
      const seen = (((st && st.history) || {}).claude || []).filter(x => x && isNum(x.weekEnd) && best.resetsAt && Math.abs(x.weekEnd - best.resetsAt) < HOUR && t - x.at <= staleMs && x.usedPct > best.usedPct);
      if (seen.length) { const hi = seen.sort((a, b) => b.usedPct - a.usedPct)[0]; best.raisedFrom = best.usedPct; best.usedPct = hi.usedPct; best.raisedAt = hi.at; }
      best.picked = pool.length > 1 ? 'the highest of ' + pool.length + ' fresh readings' : 'the only fresh reading';
    } else {
      best = Object.assign({}, cands.slice().sort((a, b) => b.at - a.at)[0]);
      if (!best.resetsAt) { const other = cands.find(c => c.resetsAt && c.resetsAt > t); if (other) best.resetsAt = other.resetsAt; }
      best.picked = 'no fresh reading';
    }
    best.weekEnd = best.resetsAt || null;
    best.weekStart = best.resetsAt ? best.resetsAt - 7 * DAY : null;
    best.others = cands.filter(c => c.source !== best.source).map(c => ({ source: c.source, at: c.at, usedPct: c.usedPct }));
    best.stale = !pool.length;
    best.overage = notes.overage; best.modelWeeks = notes.modelWeeks;
    return best;
  }

  /* ---- the stale-meter check (claude.meterCheck) ---- */
  // A stale Claude reading is unknown, and unknown is closed. Only a Claude run refreshes the meter (the station reads it
  // off the run's rate_limit_event), and a closed Claude starts none: a deadlock until the owner reopened it (2026-11-19,
  // 8 hours in both companies). So the pacer refreshes it itself: one internal run on the cheapest Claude model (a few
  // words, no tools, not crew work: lib/admit.js door "pacer", stream pacer-meter-check), at most once per staleAfterMin,
  // in a detached child (`pacer.js meter-check`) so a slow start never holds the dispatcher's tick. The next tick sees the
  // fresh reading. While the check runs Claude stays closed; a check refused for usage is a reading ("rejected", readClaude).
  const mcTimeoutMs = () => (policy.claude.meterCheck.timeoutSec + 60) * 1000;
  const readMeterCheck = () => readJson(P('meterCheck'), null);
  const meterCheckPending = (mc, t) => !!(mc && mc.status === 'pending' && isNum(mc.at) && t - mc.at < mcTimeoutMs());
  function haltedHere() { const h = readJson(P('halt'), null); return h && (h.mode === 'soft' || h.mode === 'hard') ? h.mode : false; }
  function probeSeat() { const crew = crewLoops(), ids = Object.keys(crew); return ids.find(id => co.holds(crew[id], 'ceo')) || ids.find(id => crew[id] && crew[id].manager == null) || 'agent'; }
  async function claudeConnected() {
    try {
      const r = await call('GET', '/api/providers', null, 8000); const j = JSON.parse(r.body);
      const list = Array.isArray(j && j.providers) ? j.providers : Object.values((j && j.providers) || {});
      const c = list.find(x => x && x.id === 'claude-cli'); return !!(c && c.configured);
    } catch (_) { return false; }
  }
  function meterCheckWords(mc, r) {
    if (mc.outcome === 'usage-limit') return 'CLAUDE METER CHECK: Claude refused the check for usage at ' + hm(mc.endedAt) + ' (the account is at its limit); that counts as a reading, Claude stays closed, and the pacer checks again after ' + policy.claude.staleAfterMin + ' min';
    if (mc.outcome === 'ok') return 'CLAUDE METER CHECK: Claude answered at ' + hm(mc.endedAt) + (r && !r.stale && r.at >= mc.at - MIN ? '; the meter reads ' + f1(r.usedPct) + '% of the week' : '; the station has no new meter reading from it, so Claude stays closed and the pacer checks again after ' + policy.claude.staleAfterMin + ' min');
    return 'CLAUDE METER CHECK: the check sent at ' + hm(mc.at) + ' failed (' + (mc.why || 'no answer') + '); Claude stays closed and the pacer tries again after ' + policy.claude.staleAfterMin + ' min';
  }
  // the tick's part: say once what a finished check found, and start a new one when the meter is stale
  async function meterCheckTick(st, t, r, allow) {
    const mc = readMeterCheck();
    const out = { pending: meterCheckPending(mc, t), last: mc || null, started: false };
    if (!readOnly && !dry && mc && isNum(mc.at)) {
      const mcs = st.meterCheck = Object.assign({}, st.meterCheck || {});
      if (mcs.reported !== mc.at && mc.status === 'done') { mcs.reported = mc.at; note(meterCheckWords(mc, r)); journal('meter-check', { outcome: mc.outcome, runId: mc.runId || null, why: mc.why || null }); }
      else if (mcs.reported !== mc.at && mc.status === 'pending' && !out.pending) { mcs.reported = mc.at; note('CLAUDE METER CHECK: the check sent at ' + hm(mc.at) + ' did not answer within ' + policy.claude.meterCheck.timeoutSec + ' s; Claude stays closed and the pacer tries again after ' + policy.claude.staleAfterMin + ' min'); }
    }
    if (!allow || !policy.claude.meterCheck.enabled || readOnly || dry) return out;
    if (r && !r.stale) return out;                                                          // a fresh reading: nothing to check
    if (out.pending) return out;                                                            // one check at a time
    if (mc && isNum(mc.at) && t - mc.at < policy.claude.staleAfterMin * MIN) return out;    // at most once per staleAfterMin
    const cl = st.closures && st.closures.claude; if (cl && cl.until > t) return out;       // closed by a real limit: its reset reopens it
    const ro = st.reopened && st.reopened.claude; if (r && ro && Number(ro.at) > Number(r.at)) return out;   // the owner reopened it: runs refresh it
    // at the week's stop: the weekly meter only rises, so before its reset a check could only say "still closed" and would
    // spend a run past the owner's stop for nothing. (With the spendCap guardrail off the stop holds nothing: check.)
    if (r && isNum(r.usedPct) && r.usedPct >= policy.claude.weekCloseAtUsedPct && isNum(r.resetsAt) && r.resetsAt > t && gov.guard('spendCap', govOpts)) return out;
    if (haltedHere()) return out;                                                           // a halt starts nothing, this neither
    if (!r && !(await claudeConnected())) return out;                                       // never read: only with Claude signed in
    const spec = { at: t, status: 'pending', model: policy.claude.meterCheck.model, seat: probeSeat(), why: r ? 'the last Claude reading is ' + age(r.at, t) + ' old' : 'there is no Claude reading yet' };
    writeJsonAtomic(P('meterCheck'), spec);
    note('CLAUDE METER CHECK: ' + spec.why + ', so the pacer sent Claude one tiny check (' + spec.model + ', a few words, no tools, not crew work) to read the meter again; Claude stays closed to routines until it answers');
    journal('meter-check-start', { model: spec.model, seat: spec.seat, why: spec.why });
    try { startMeterCheck(spec); out.started = true; out.pending = true; }
    catch (e) { writeJsonAtomic(P('meterCheck'), Object.assign({}, spec, { status: 'done', endedAt: t, outcome: 'error', why: 'could not start the check: ' + String((e && e.message) || e).slice(0, 120) })); out.pending = false; }
    out.last = readMeterCheck();
    return out;
  }
  let meterCheckP = null;
  function startMeterCheck(spec) {
    if (typeof o.startMeterCheck === 'function') return o.startMeterCheck(spec);   // test seam
    if (o.call) { meterCheckP = meterCheckRun(spec.at).catch(() => null); return; }  // a caller's own station function: in this process
    const cp = require('child_process').spawn(process.execPath, [__filename, 'meter-check', '--at', String(spec.at)], { cwd: root, detached: true, stdio: 'ignore',
      env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }, o.host ? { STARNET_URL: o.host } : {}) });
    cp.on('error', () => {});
    cp.unref();
  }
  // the check itself (`pacer.js meter-check --at <ms>`, or in process): one internal talk-only run, its answer written to
  // company/state/claude-meter-check.json. Runs only the pending check it was started for.
  async function meterCheckRun(at) {
    const spec = readMeterCheck();
    if (!spec || spec.status !== 'pending' || (at && spec.at !== at)) return { skipped: true, why: 'no pending check' + (at ? ' sent at ' + at : '') };
    const finish = res => {
      const cur = readMeterCheck();
      const done = Object.assign({}, spec, { status: 'done', endedAt: now() }, res);
      if (!cur || cur.at === spec.at) writeJsonAtomic(P('meterCheck'), done);
      return done;
    };
    const A = require('./lib/admit'), aOpts = { root, file: path.join(root, 'company', 'state', 'admit-log.jsonl') };
    let tk = null; try { tk = A.admit({ door: 'pacer', kind: 'run', seat: spec.seat, provider: 'claude-cli', why: 'Claude meter check: ' + spec.why + ' (internal, a few words, not crew work)' }, aOpts); } catch (_) {}
    const body = { agentId: spec.seat, provider: 'claude-cli', model: spec.model, internal: true, isTask: false, streamId: 'pacer-meter-check', reasoningEffort: 'low',
      system: 'This is an automatic connection check. Reply with the single word OK and nothing else.', messages: [{ role: 'user', content: 'OK?' }] };
    let r;
    try {
      r = await call('POST', '/api/run', body, policy.claude.meterCheck.timeoutSec * 1000);
      // the station's Claude sign-in check answers from a cache it only starts filling on the first ask: right after a
      // restart (every seat held on a stale meter, so this check IS the first ask) it refuses "missing key/model" with
      // no run and no usage. Ask once more after the cache filled, or the company stays closed another staleAfterMin.
      if (r && r.status === 400 && /missing key\/model/i.test(String(r.body || ''))) {
        await new Promise(res => setTimeout(res, Number(o.meterRetryMs) >= 0 ? Number(o.meterRetryMs) : 5000));
        r = await call('POST', '/api/run', body, policy.claude.meterCheck.timeoutSec * 1000);
      }
    }
    catch (e) { try { A.started(tk, { status: 0 }, aOpts); } catch (_) {} return finish({ outcome: 'error', why: 'the station did not answer (' + String((e && e.message) || e).slice(0, 100) + ')' }); }
    const txt = String((r && r.body) || '');
    if (!r || r.status !== 200) {
      try { A.started(tk, { status: r ? r.status : 0 }, aOpts); } catch (_) {}
      return finish({ outcome: isUsageLimit({ error: txt }) ? 'usage-limit' : 'error', why: 'the station answered HTTP ' + (r ? r.status : 0) + (txt.trim() ? ': ' + txt.trim().slice(0, 120) : '') });
    }
    let runId = null, end = null, err = null;
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      const p = (ev && ev.payload) || {};
      if (ev.name === 'agent.run.start' && !runId) runId = p.runId || null;
      const mine = !runId || !p.runId || p.runId === runId;
      if (ev.name === 'agent.run.error' && mine) err = { message: String(p.message || ''), failureCode: String(p.failureCode || '') };
      if (ev.name === 'agent.run.end' && mine) end = p;
    }
    try { A.started(tk, { status: 200, runId }, aOpts); } catch (_) {}
    const fc = String((end && end.failureCode) || (err && err.failureCode) || ''), msg = String((err && err.message) || (end && end.error) || '');
    if (isUsageLimit({ failureCode: fc, error: msg })) return finish({ outcome: 'usage-limit', runId, why: (fc || 'usage limit') + (msg ? ': ' + msg.slice(0, 120) : '') });
    if (end && (end.reason === 'done' || end.outcome === 'succeeded')) return finish({ outcome: 'ok', runId });
    return finish({ outcome: 'error', runId, why: end ? 'the run ended ' + (end.reason || end.outcome || 'without a result') + (msg ? ': ' + msg.slice(0, 120) : '') : 'the run never ended' });
  }

  async function readMiniMax(st, t, allowFetch) {
    st.minimax = st.minimax || {};
    const pollMs = policy.minimax.pollEveryMin * MIN;
    let fetched = false;
    if (allowFetch && !(isNum(st.minimax.triedAt) && t - st.minimax.triedAt < pollMs)) {   // at most one call per poll period, answered or not
      st.minimax.triedAt = t; fetched = true;
      let r; try { r = await fetchMiniMax(); } catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
      if (r && r.ok) {
        const p = parseMiniMax(r.body, policy.minimax.modelName, t);
        if (p.ok) { st.minimax.reading = p; st.minimax.error = null; } else st.minimax.error = p.error;
      } else st.minimax.error = (r && r.error) || 'no answer';
    }
    const rd = st.minimax.reading;
    return rd ? Object.assign({ source: 'MiniMax plan API', fetched, lastError: st.minimax.error || null }, rd) : { none: true, fetched, lastError: st.minimax.error || null };
  }

  // Can DeepSeek take calls now? Two sources: the balance endpoint (at most one call per poll period, answered or
  // not), and the routines' own last errors. A credit failure newer than the last good reading closes DeepSeek; a
  // fresh reading saying calls are possible opens it again, so a top-up is seen within one poll period.
  async function readDeepSeek(st, t, jobs, allowFetch) {
    st.deepseek = st.deepseek || {};
    const pollMs = policy.deepseek.pollEveryMin * MIN;
    if (allowFetch && !(isNum(st.deepseek.triedAt) && t - st.deepseek.triedAt < pollMs)) {
      st.deepseek.triedAt = t;
      let r; try { r = await fetchDeepSeek(); } catch (e) { r = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
      if (r && r.ok && typeof r.available === 'boolean') {
        st.deepseek.reading = { at: t, available: r.available }; st.deepseek.error = null;
        // the amounts: the owner's file only; a drop below the low line tells the owner once (no amount in the notice)
        if (Array.isArray(r.balances) && !o.readOnly) { try { require('./lib/provider-balance').record('deepseek', { at: t, available: r.available, balances: r.balances }, { root, now: t, notify: o.notifyOwner || (text => { try { require('./lib/governance').notify(text, { root }); } catch (_) {} }) }); } catch (_) {} }
      }
      else st.deepseek.error = (r && r.error) || 'no answer';
    }
    // the newest credit failure among the routines whose last run was on DeepSeek, and the newest good DeepSeek run
    const runProv = {}; let okAt = null;
    try {
      // the last 7 days from the end of the file (lib/bounded.js): a routine's last run and the newest good DeepSeek run
      for (const r of runsWindow(t - 7 * DAY, 16 * MB)) {
        if (r.provider !== 'deepseek') continue;
        if (r.runId) runProv[r.runId] = r.provider;
        const end = Number(r.endedAt || r.ts) || 0;
        if (r.reason === 'done' && end > (okAt || 0)) okAt = end;
      }
    } catch (_) {}
    let outAt = null, outName = null;
    for (const j of jobs || []) {
      if (!j || !CREDIT_RE.test(String(j.lastError || ''))) continue;
      const onDs = j.lastRunId && runProv[j.lastRunId] ? runProv[j.lastRunId] === 'deepseek' : ((j.wire && j.wire.provider) || j.provider) === 'deepseek';
      const at = Date.parse(j.lastRunAt || '') || null;
      if (onDs && at && at > (outAt || 0)) { outAt = at; outName = j.name; }
    }
    // remembered: once a routine has moved off DeepSeek its error is replaced by its next run's, and the failure must
    // not be forgotten with it (without a balance reading that would move everybody back onto an empty account)
    const kept = st.deepseek.lastOut;
    if (outAt && (!kept || outAt > kept.at)) st.deepseek.lastOut = { at: outAt, name: outName };
    else if (kept && isNum(kept.at)) { outAt = kept.at; outName = kept.name; }
    const g = { key: 'deepseek', label: 'DeepSeek', open: true, hard: false, why: '', reading: st.deepseek.reading || null, lastError: st.deepseek.error || null, outAt, outName, okAt };
    const rd = st.deepseek.reading, fresh = rd && t - rd.at <= policy.deepseek.staleAfterMin * MIN;
    const failedSince = x => outAt && (!x || outAt > x) && !(okAt && okAt > outAt);
    if (fresh && rd.available === false) { g.open = false; g.hard = true; g.why = 'the account has no credit left (DeepSeek\'s balance check at ' + hm(rd.at) + ')'; }
    else if (fresh && failedSince(rd.at)) { g.open = false; g.hard = true; g.why = '"' + outName + '" failed for credit at ' + hm(outAt) + ', after the ' + hm(rd.at) + ' balance check'; }
    else if (fresh) g.why = 'calls possible (balance check at ' + hm(rd.at) + ')';
    else if (failedSince(null) && t - outAt < policy.deepseek.creditFailureHoldMin * MIN) { g.open = false; g.hard = true; g.why = '"' + outName + '" failed for credit at ' + hm(outAt) + ' and no balance reading says otherwise' + (g.lastError ? ' (' + g.lastError + ')' : ''); }
    else g.why = 'no credit failure seen' + (g.lastError ? '; no balance reading (' + g.lastError + ')' : '');
    return g;
  }

  function runs24hUsd(t) {
    const since = t - DAY; let usd = 0;
    for (const r of runsWindow(since)) if (Number(r.startedAt) >= since) usd += Number(r.usd) || 0;
    return usd;
  }
  async function readRail(st, t) {
    const R = policy.deepseekRail, hold = R.holdAtPct;
    const done = x => Object.assign(x, { holdAtPct: hold, pauseAtPct: R.pauseScheduledAtPct, resumeBelowPct: R.resumeBelowPct,
      pausePressure: !x.none && x.pct >= R.pauseScheduledAtPct, projection: x.none ? null : railProjection(t, x.perDay, x.pct) });
    try {
      const r = await call('GET', '/api/budget/status', null, 10000);
      const j = JSON.parse(r.body);
      const perDay = Number(j && j.caps && j.caps.perDay);
      if (r.status === 200 && Number.isFinite(perDay)) {
        st.rail = { perDay, at: t };
        if (perDay <= 0) return done({ known: true, pct: 0, pressure: false, source: 'station', none: true, perDay });
        const d = j.day || {};
        const vals = [d.usd, d.estimatedUsd, j.atLeast && j.atLeast.today, j.spentToday].filter(isNum);
        const spent = (vals.length ? Math.max(...vals) : 0) + (isNum(j.live) ? j.live : 0);   // the larger of booked and estimated, plus runs in flight
        const pct = 100 * spent / perDay;
        // dayNull: the station answered with no settled figure for today, so `spent` is runs in flight only and the
        // percentage is a floor, not a reading: printing a percentage in that state would tell every reader the rail
        // is being measured when it is being estimated from the smallest term.
        return done({ known: true, pct, pressure: pct >= hold, source: 'station', perDay, dayNull: vals.length === 0 });
      }
    } catch (_) {}
    const perDay = st.rail && isNum(st.rail.perDay) ? st.rail.perDay : 25;   // the station's shipped default
    if (perDay <= 0) return done({ known: false, pct: 0, pressure: false, source: 'runs.jsonl', none: true, perDay });
    const pct = 100 * runs24hUsd(t) / perDay;
    return done({ known: false, pct, pressure: pct >= hold, source: 'runs.jsonl (the station did not answer)', perDay });
  }
  // When the rail would reach the hold line and trip if the last projectFromHours' pace went on, with the station's
  // rolling 24 hours ageing out as it goes (the ledger's own rows; percentages only, never dollars).
  function railProjection(t, perDay, pctNow) {
    if (!(perDay > 0)) return null;
    const fromH = policy.deepseekRail.projectFromHours;
    const rows = [];
    try {
      let txt = fs.readFileSync(P('ledger'), 'utf8'); if (txt.length > 8e6) txt = txt.slice(-8e6);
      for (const l of txt.split('\n')) { if (!l || l.indexOf('"usd"') < 0) continue; try { const r = JSON.parse(l); const ts = Number(r.ts), usd = Number(r.usd); if (ts > t - DAY && ts <= t && usd > 0) rows.push([ts, usd]); } catch (_) {} }
    } catch (_) { return null; }
    const inWin = at => rows.reduce((s, [ts, u]) => ts > at - DAY ? s + u : s, 0);
    const base = inWin(t), extra = Math.max(0, pctNow * perDay / 100 - base);   // in-flight runs and anything the ledger lacks
    const rate = rows.reduce((s, [ts, u]) => ts > t - fromH * HOUR ? s + u : s, 0) / fromH;   // per hour
    const out = { fromHours: fromH, pctPerHour: 100 * rate / perDay, holdAt: null, tripAt: null };
    for (let k = 1; k <= 144; k++) {   // 24 hours in 10-minute steps
      const at = t + k * 10 * MIN;
      const pct = 100 * (inWin(at) + extra + rate * k * 10 * MIN / HOUR) / perDay;
      if (out.holdAt == null && pct >= policy.deepseekRail.holdAtPct) out.holdAt = at;
      if (pct >= 100) { out.tripAt = at; break; }
    }
    return out;
  }
  function readKnobs() {
    const k = ((readJson(P('knobs'), {}) || {}).knobs) || {};
    const n = Number(k.maxUnpricedTokens);
    // company.json providers.minimax.credits: false = the MiniMax account holds no Credits, so a run past the plan's
    // limit is refused (quota_exhausted), never billed; true or absent = it may bill Credits (MiniMax's default)
    const mm = ((MME.readCfg(root).providers || {}).minimax) || {};
    return { maxUnpricedTokens: Number.isFinite(n) ? n : null, minimaxCredits: mm.credits === false ? false : mm.credits === true ? true : null };
  }

  // emergency.allowedBy holds function names (ceo, risk, ...) and/or literal names. A function stands for whoever holds
  // it in loops.json (by display name or station id; the CEO seat when nobody does, as lib/company.js seatFor).
  const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
  function allowedNames() {
    const crew = crewLoops(), ids = Object.keys(crew), out = new Set();
    const ceoId = ids.find(id => co.holds(crew[id], 'ceo')) || ids.find(id => crew[id] && crew[id].manager == null) || null;
    for (const a of policy.emergency.allowedBy.map(String)) {
      const fn = a.toLowerCase();
      if (!FUNCTIONS.includes(fn)) { out.add(fn); continue; }
      let holders = ids.filter(id => fn === 'ceo' ? id === ceoId : co.holds(crew[id], fn));
      if (!holders.length && ceoId) holders = [ceoId];
      for (const id of holders) { out.add(id.toLowerCase()); if (crew[id] && crew[id].name) out.add(String(crew[id].name).toLowerCase()); }
    }
    return out;
  }
  const allowedWords = () => { const crew = crewLoops(); const n = [...allowedNames()].filter(x => !crew[x]); return n.length ? n.join(' or ') : 'nobody (emergency.allowedBy is empty)'; };
  // the name before any comma, bracket or space: "Alex", "Alex (CEO)" and "Alex, CEO" count; "Alexa" does not
  const byAllowed = by => allowedNames().has(String(by || '').trim().split(/[\s,(]/)[0].toLowerCase());
  // company/state/emergency.json, checked on every read: a file written by hand (or by an agent) counts only if it
  // keeps the same rules the command does — started by someone in emergency.allowedBy (an automatic one: for a confirmed S0/S1 flag
  // that is in competence.json), at most maxHours long (autoHours for an automatic one), started in the past.
  function readEmergency(t) {
    const e = readJson(P('emergency'), null);
    const until = e ? Date.parse(e.until) : NaN, since = e ? Date.parse(e.since) : NaN;
    const claimed = !!(e && e.active === true && Number.isFinite(until) && t < until);
    let invalid = null;
    if (claimed) {
      const maxH = e.auto ? policy.emergency.autoHours : policy.emergency.maxHours;
      if (!Number.isFinite(since)) invalid = 'it has no start time';
      else if (since > t + MIN) invalid = 'its start time is in the future';
      else if (until - since > maxH * HOUR + MIN) invalid = 'it is set for ' + f1((until - since) / HOUR) + ' hours, over the ' + maxH + '-hour limit';
      else if (e.auto) {
        const out = readJson(P('competenceOut'), null);
        const flags = out && Array.isArray(out.serious) ? out.serious : [];
        if (!e.flag || !flags.some(x => x && String(x.id) === String(e.flag) && /^S[01]$/.test(String(x.severity || '')))) invalid = 'it says it is automatic, but its serious flag is not a confirmed S0/S1 in competence.json';
      } else if (!byAllowed(e.by)) invalid = 'it was started by "' + String(e.by || '').slice(0, 40) + '", and only ' + allowedWords() + ' may start one';
    }
    const active = claimed && !invalid;
    return { active, invalid, expired: !!(e && e.active === true && !claimed), why: e && e.why, by: e && e.by, since: e && e.since, until: Number.isFinite(until) ? until : null, auto: !!(e && e.auto), ceilingPct: policy.emergency.ceilingPct };
  }

  // refusals, usage-limit errors: from the station's run records, the last 48 hours
  function scanRuns(t) {
    const since = t - 48 * HOUR, out = { refusals: [], claudeLimits: [], minimaxLimits: [] };
    const outcomes = policy.routing.blockOutcomes.map(String), codes = policy.routing.blockFailureCodes.map(String);
    for (const r of runsWindow(since, 16 * MB)) {
      if (!r.failureCode && !r.outcome && !r.error) continue;
      const end = Number(r.endedAt || r.ts || r.startedAt) || 0;
      if (end < since) continue;
      const fc = String(r.failureCode || ''), oc = String(r.outcome || '');
      if (r.cronJobId && (outcomes.includes(oc) || codes.includes(fc)))
        out.refusals.push({ runId: r.runId, routineId: r.cronJobId, provider: r.provider, model: r.model, endedAt: end, code: fc || oc, trial: r.requestedBy === 'override' });
      if (isUsageLimit(r)) {
        if (r.provider === 'claude-cli') out.claudeLimits.push({ runId: r.runId, endedAt: end, model: r.model });
        else if (r.provider === 'custom') out.minimaxLimits.push({ runId: r.runId, endedAt: end, model: r.model });
      }
    }
    return out;
  }

  function noteHistory(st, key, reading) {
    if (!reading || !isNum(reading.usedPct) || !isNum(reading.at)) return;
    const h = st.history[key] = Array.isArray(st.history[key]) ? st.history[key] : [];
    const last = h[h.length - 1];
    if (!last || (last.at !== reading.at && (last.usedPct !== reading.usedPct || reading.at - last.at >= 30 * MIN))) h.push({ at: reading.at, usedPct: reading.usedPct, weekEnd: isNum(reading.weekEnd) ? reading.weekEnd : null });
    const cut = now() - 8 * DAY;
    st.history[key] = h.filter(x => x.at >= cut).slice(-2000);
  }
  // week used % at the start of today (day k of that subscription's week), from the pacer's own readings; null = not seen
  function usedAtDayStart(st, key, weekStart, day) {
    if (day === 1) return 0;   // a new week starts at 0
    const dayStart = weekStart + (day - 1) * DAY;
    const h = (st.history[key] || []).filter(x => x.at >= weekStart && x.at <= dayStart);
    return h.length ? h[h.length - 1].usedPct : null;
  }

  function gate(key, label, r, t, em, st, extra) {
    const g = { key, label, known: false, open: false, why: '', hard: false, usedPct: null, day: null, line: null, normalLine: null, left: 0, sharesLeft: 0, share,
      source: r && !r.none ? r.source : null, at: r && !r.none ? r.at : null, weekStart: r && r.weekStart, weekEnd: r && r.weekEnd, emergencyOpened: false, nextOpen: null, usedToday: null };
    const stale = key === 'claude' ? policy.claude.staleAfterMin : policy.minimax.staleAfterMin;
    if (!r || r.none || !isNum(r.usedPct)) { g.why = 'no reading yet' + (r && r.lastError ? ' (' + r.lastError + ')' : ''); return g; }
    if (t - r.at > stale * MIN) {
      g.why = 'the last reading is ' + age(r.at, t) + ' old (over ' + stale + ' min), so the meter is unknown'; g.usedPct = r.usedPct;
      // the owner reopened it after that reading (pacer.js reopen): open until a run reads the meter again. Otherwise a
      // stale meter could only refresh through a run it never lets start, and the seat stays closed until the reset.
      const ro = st && st.reopened && st.reopened[key];
      if (ro && Number(ro.at) > Number(r.at)) { g.open = true; g.why += '; the owner reopened it at ' + hm(ro.at) + ', so it runs until the next reading'; }
      return g;
    }
    if (!isNum(r.weekStart) || !isNum(r.weekEnd)) { g.why = 'the reading has no weekly window'; g.usedPct = r.usedPct; return g; }
    if (t >= r.weekEnd) { g.why = 'the reading is from a week that has ended; waiting for a new one'; return g; }
    g.known = true; g.usedPct = r.usedPct;
    g.day = dayOf(r.weekStart, t);
    const sh = key === 'claude' ? policy.claude.shareOfAccount : policy.minimax.shareOfAccount;
    g.shareOfAccount = sh; g.share = share * sh;
    g.normalLine = lineFor(g.day, frac * sh, margin);
    g.line = em.active ? Math.max(g.normalLine, em.ceilingPct) : g.normalLine;
    // the account's hard stop for each subscription (weekCloseAtUsedPct): no line, emergency or reserve goes past it
    g.weekCap = key === 'claude' ? policy.claude.weekCloseAtUsedPct : policy.minimax.weekCloseAtUsedPct;
    g.line = Math.min(g.line, g.weekCap); g.normalLine = Math.min(g.normalLine, g.weekCap);
    // the owner's "spread evenly vs use it now" (useNowPct): today's line moves that far from the even line to the stop
    g.useNowPct = policy[key].useNowPct;
    if (g.useNowPct > 0) { g.normalLine += (g.weekCap - g.normalLine) * g.useNowPct / 100; g.line = Math.max(g.line, g.normalLine); }
    // Optional claude.dailyLineFrom: before it the daily line does not apply and Claude runs to its stop (a company in
    // setup before a weekly reset).
    if (key === 'claude' && isNum(policy.claude.dailyLineFromMs) && t < policy.claude.dailyLineFromMs) {
      g.dailyLineOff = policy.claude.dailyLineFromMs; g.line = g.weekCap; g.normalLine = g.weekCap;
    }
    g.left = Math.max(0, g.line - r.usedPct);
    g.sharesLeft = g.share > 0 ? g.left / g.share : 0;
    g.dayEnds = Math.min(r.weekStart + g.day * DAY, r.weekEnd);
    const base = usedAtDayStart(st, key, r.weekStart, g.day);
    g.usedToday = base == null ? null : Math.max(0, r.usedPct - base);
    // A band against flapping: once closed, a subscription reopens only reopenBandPct under the line; while open it
    // stays open up to the line itself.
    const wasOpen = !!(st.gateOpen && st.gateOpen[key] === true);
    g.openBelow = wasOpen ? g.line : g.line - band;
    g.open = r.usedPct < g.openBelow;
    if (g.open && em.active && r.usedPct >= g.normalLine) g.emergencyOpened = true;
    // MiniMax's plan is limited per 5-hour window and per week, not per day. With paceBy fiveHour the daily line does
    // not gate MiniMax; its two real limits do: the
    // 5-hour window (the extra check in measure, under fiveHourCloseBelowLeftPct left) and the week (weekCloseAtUsedPct).
    const fiveHourOnly = key === 'minimax' && policy.minimax.paceBy === 'fiveHour';
    if (fiveHourOnly) {
      const cap = policy.minimax.weekCloseAtUsedPct;
      g.paceBy = 'fiveHour'; g.emergencyOpened = false;
      g.open = r.usedPct < cap;
      g.sharesLeft = isNum(r.fiveHourLeftPct) ? (r.fiveHourLeftPct >= 50 ? 1 : 0) : 0;   // the per-tick boost: while over half the window is left
      if (!g.open) g.why = 'the week is ' + f1(r.usedPct) + '% used (closes at ' + cap + '% of the weekly limit; the week resets ' + when(r.weekEnd) + ')';
    }
    if (!g.open && !fiveHourOnly) {
      g.why = r.usedPct < g.line
        ? 'week ' + f1(r.usedPct) + '% used is under today\'s line of ' + f1(g.line) + '% but it was closed, and it reopens only under ' + f1(g.openBelow) + '% (a ' + band + '-point band against flapping)'
        : 'week ' + f1(r.usedPct) + '% used is over today\'s line of ' + f1(g.line) + '%';
      const k = nextOpenDay(r.usedPct, frac * sh, margin, band);
      g.nextOpen = k && k > g.day ? { day: k, at: r.weekStart + (k - 1) * DAY, line: lineFor(k, frac * sh, margin) } : null;
    }
    const cl = st.closures[key];
    if (cl && cl.until > t) { g.open = false; g.hard = true; g.why = cl.why + '; closed until ' + when(cl.until); }
    for (const x of (extra || [])) if (x) { g.open = false; g.hard = true; g.why = x; }
    if (g.open && fiveHourOnly) g.why = 'paced by its own limits: 5-hour window ' + (isNum(r.fiveHourLeftPct) ? f1(r.fiveHourLeftPct) + '% left' + (r.fiveHourEnd ? ' (resets ' + hm(r.fiveHourEnd) + ')' : '') : 'unknown') + ', week ' + f1(r.usedPct) + '% used of the ' + g.weekCap + '% cap';
    else if (g.open && g.dailyLineOff) g.why = 'the daily line is off until ' + when(g.dailyLineOff) + ' (claude.dailyLineFrom); week ' + f1(r.usedPct) + '% used, Claude stops at ' + g.weekCap + '%';
    else if (g.open) g.why = f1(g.left) + ' points under today\'s line (' + f1(g.sharesLeft) + ' days\' share)' + (g.emergencyOpened ? ' — open only because of the emergency' : '');
    return g;
  }

  async function measure(st, jobs, opts) {
    opts = opts || {};
    const t = now();
    const byId = Object.fromEntries((jobs || []).map(j => [j.id, j]));
    const nameOf = id => (byId[id] && byId[id].name) || id;
    const changes = [];
    const change = line => { changes.push(line); note(line); };
    // expire old state first
    st.blocks = (st.blocks || []).filter(b => b && b.until > t);
    for (const k of Object.keys(st.closures || {})) if (!st.closures[k] || st.closures[k].until <= t) delete st.closures[k];
    for (const [k, v] of Object.entries(st.handled || {})) if (!isNum(v) || t - v > 3 * DAY) delete st.handled[k];
    for (const [k, v] of Object.entries(st.refired || {})) if (!v || !isNum(v.at) || t - v.at > 3 * DAY) delete st.refired[k];
    st.pendingRefires = (st.pendingRefires || []).filter(p => p && t - p.endedAt <= policy.routing.refireWithinMin * MIN && !st.refired[p.runId]);
    st.keys = st.keys || {};
    for (const k of Object.keys(st.keys)) if (k.startsWith('refire:') && !st.pendingRefires.some(p => 'refire:' + p.runId === k)) delete st.keys[k];

    const claudeR = readClaude(t, st);
    const meterCheck = await meterCheckTick(st, t, claudeR, opts.fetch !== false);
    const mmR = await readMiniMax(st, t, opts.fetch !== false);
    const deepseek = await readDeepSeek(st, t, jobs, opts.fetch !== false);
    const rail = await readRail(st, t);
    const em = readEmergency(t);
    if (claudeR) noteHistory(st, 'claude', claudeR);
    if (mmR && !mmR.none) noteHistory(st, 'minimax', mmR);

    // events from the run records
    const ev = scanRuns(t);
    // A routine's FIRST refusal (a filter can refuse an ordinary run) blocks that provider for that routine for
    // refusalFirstBlockHours and re-runs that one run once, prompt unchanged, on its next entry. A second refusal of the
    // same routine within refusalRepeatWithinHours is a pattern: refusalBlockHours, no re-run, and the CEO handles it (T3).
    st.refusalLog = (st.refusalLog || []).filter(x => x && t - x.at < policy.routing.refusalRepeatWithinHours * HOUR);
    for (const e of ev.refusals) {
      if (!e.runId || st.handled[e.runId]) continue;
      st.handled[e.runId] = t;
      // a one-run trial model (the router's override) refused: only that model is off for this routine, in the router, for
      // refusalBlockHours; the seat keeps its provider and its own chain, and its open items wake it as usual (no re-run on
      // the model that refused). Before this, one trial model's refusal closed the whole provider to the seat for hours.
      if (e.trial) {
        const until = e.endedAt + policy.routing.refusalBlockHours * HOUR;
        if (until <= t) continue;
        st.blocks.push({ routineId: e.routineId, name: nameOf(e.routineId), provider: e.provider, model: e.model, runId: e.runId, code: e.code, at: e.endedAt, until, trial: true });
        change('TRIAL MODEL REFUSED "' + nameOf(e.routineId) + '": ' + e.model + ' refused its trial run at ' + hm(e.endedAt) + ' (' + e.code + '); that model is left out of this routine\'s trials until ' + when(until) + ', and ' + (NAMES[e.provider] || e.provider) + ' stays open on its own chain');
        journal('trial-block', { routine: nameOf(e.routineId), routineId: e.routineId, provider: e.provider, model: e.model, runId: e.runId, code: e.code, until: new Date(until).toISOString() });
        continue;
      }
      const prior = st.refusalLog.filter(x => x.routineId === e.routineId && x.runId !== e.runId && Math.abs(e.endedAt - x.at) < policy.routing.refusalRepeatWithinHours * HOUR).length;
      st.refusalLog.push({ routineId: e.routineId, runId: e.runId, at: e.endedAt });
      const repeat = prior >= 1;
      const until = e.endedAt + (repeat ? policy.routing.refusalBlockHours : policy.routing.refusalFirstBlockHours) * HOUR;
      if (until <= t) continue;
      // a content filter is the model's own (one Claude model refuses work another runs): only that model is blocked, and the
      // seat's chain goes on to its next entry, the same provider's other models included. Other refusals block the provider.
      const modelOnly = e.code === 'content_policy_blocked' && !!e.model;
      st.blocks.push({ routineId: e.routineId, name: nameOf(e.routineId), provider: e.provider, model: e.model, runId: e.runId, code: e.code, at: e.endedAt, until, repeat, modelOnly });
      const fresh = t - e.endedAt <= policy.routing.refireWithinMin * MIN;   // a repeat refusal is re-run too: the run is never lost
      if (fresh) st.pendingRefires.push({ runId: e.runId, routineId: e.routineId, provider: e.provider, model: e.model, endedAt: e.endedAt, modelOnly });
      change('BLOCK ' + (NAMES[e.provider] || e.provider) + ' for "' + nameOf(e.routineId) + '" until ' + when(until) + ': its run at ' + hm(e.endedAt) + ' on ' + e.model + ' ended ' + e.code + (repeat ? ' (a second refusal within ' + policy.routing.refusalRepeatWithinHours + ' h: blocked ' + policy.routing.refusalBlockHours + ' h; the CEO looks at it, ESCALATION_POLICY T3)' : '') + (fresh ? (live ? '; it will be re-fired once on its new model' : '; live mode would re-fire it once on its new model') : ''));
      journal('block', { routine: nameOf(e.routineId), routineId: e.routineId, provider: e.provider, model: e.model, runId: e.runId, code: e.code, until: new Date(until).toISOString() });
    }
    const limitClosure = (key, list, untilOf) => {
      for (const e of list) {
        if (!e.runId || st.handled[e.runId]) continue;
        st.handled[e.runId] = t;
        const until = untilOf(e);
        if (!(until > t)) continue;
        const cur = st.closures[key];
        if (!cur || cur.until < until) st.closures[key] = { until, why: 'a ' + NAMES[key === 'claude' ? 'claude-cli' : 'custom'] + ' run hit its usage limit at ' + hm(e.endedAt), runId: e.runId, at: e.endedAt };
        change('CLOSE ' + (key === 'claude' ? 'Claude' : 'MiniMax') + ' to routines until ' + when(until) + ': a run hit the usage limit at ' + hm(e.endedAt));
        journal('closure', { provider: key, runId: e.runId, until: new Date(until).toISOString() });
      }
    };
    // Claude: until the reset of the window that ran out. A five-hour window near full, or the week near full, says
    // which; when neither is (an unreported window), five hours.
    limitClosure('claude', ev.claudeLimits, e => {
      const r = claudeR || {};
      if (r.fiveHour && r.fiveHour.usedPct >= 90 && r.fiveHour.resetsAt > t) return r.fiveHour.resetsAt;
      if (isNum(r.usedPct) && r.usedPct >= 95 && r.resetsAt > t) return r.resetsAt;
      return e.endedAt + 5 * HOUR;
    });
    limitClosure('minimax', ev.minimaxLimits, e => {
      const r = mmR && !mmR.none ? mmR : {};
      if (isNum(r.usedPct) && r.usedPct >= 99 && r.weekEnd > t) return r.weekEnd;
      if (r.fiveHourEnd > t) return r.fiveHourEnd;
      return e.endedAt + 5 * HOUR;
    });

    const claudeExtra = [];
    if (claudeR && claudeR.status === 'rejected') claudeExtra.push('the account answered "rejected" (at its limit)');
    if (claudeR && claudeR.fiveHour && claudeR.fiveHour.usedPct >= policy.claude.fiveHourCloseAtUsedPct && !(claudeR.fiveHour.resetsAt && claudeR.fiveHour.resetsAt <= t))
      claudeExtra.push('the 5-hour window is ' + f1(claudeR.fiveHour.usedPct) + '% used (closes at ' + policy.claude.fiveHourCloseAtUsedPct + '%)' + (claudeR.fiveHour.resetsAt ? '; it resets ' + hm(claudeR.fiveHour.resetsAt) : ''));
    const mmExtra = [];
    // an EMPTY window is closed whatever the threshold: fiveHourCloseBelowLeftPct 0 means "use it to the end", and with
    // "left < 0" alone a window at 0% stayed open, so every start failed quota_exhausted at the provider
    if (mmR && !mmR.none && isNum(mmR.fiveHourLeftPct) && (mmR.fiveHourLeftPct <= 0 || mmR.fiveHourLeftPct < policy.minimax.fiveHourCloseBelowLeftPct) && !(mmR.fiveHourEnd && mmR.fiveHourEnd <= t))
      mmExtra.push('the 5-hour window has ' + f1(mmR.fiveHourLeftPct) + '% left (' + (mmR.fiveHourLeftPct <= 0 ? 'it is used up' : 'closes under ' + policy.minimax.fiveHourCloseBelowLeftPct + '%') + '); it resets ' + hm(mmR.fiveHourEnd));
    const claude = gate('claude', 'Claude Max', claudeR, t, em, st, claudeExtra);
    const minimax = gate('minimax', 'MiniMax', mmR, t, em, st, mmExtra);
    if (!claude.known && !claude.open && meterCheck.pending && meterCheck.last) claude.why += '; a meter check is under way (sent ' + hm(meterCheck.last.at) + '), so it stays closed until it answers';
    claude.meterCheck = meterCheck.last ? { at: meterCheck.last.at, status: meterCheck.last.status, outcome: meterCheck.last.outcome || null, endedAt: meterCheck.last.endedAt || null, why: meterCheck.last.why || null, pending: meterCheck.pending } : null;
    claude.overage = claudeR ? claudeR.overage || null : null;
    claude.modelWeeks = claudeR ? claudeR.modelWeeks || [] : [];
    // The spendCap guardrail (company/state/guardrails.json): while it is off, no pacing line or weekly stop holds a
    // subscription. A provider's own refusal (a usage-limit error, a closed 5-hour window, "rejected") still does: that is
    // the provider saying no, not the company's cap. Each change of state is logged once, with what would have happened.
    const capOn = gov.guard('spendCap', govOpts);
    st.keys = st.keys || {};
    for (const g of [claude, minimax]) {
      const k = 'spendCapOff:' + g.key;
      if (!capOn && g.known && !g.open && !g.hard) {
        g.wouldHave = g.why; g.open = true; g.spendCapOff = true;
        g.why = 'the spendCap guardrail is off, so the pacing line holds nothing (it would have closed ' + g.label + ': ' + g.wouldHave + ')';
        if (!st.keys[k]) { st.keys[k] = t; change('SPENDCAP OFF: ' + g.label + ' stays open; with the guardrail on it would be closed (' + g.wouldHave + ')'); journal('spendcap-off', { key: g.key, wouldHave: g.wouldHave }); }
      } else if (st.keys[k] && (capOn || g.open)) delete st.keys[k];
    }
    st.gateOpen = { claude: claude.open, minimax: minimax.open, deepseek: deepseek.open, at: t };
    claude.fiveHour = claudeR && claudeR.fiveHour || null;
    claude.others = claudeR ? claudeR.others : [];
    claude.picked = claudeR ? claudeR.picked : null;
    if (claudeR && isNum(claudeR.raisedFrom)) claude.raised = { from: claudeR.raisedFrom, at: claudeR.raisedAt };
    minimax.fiveHourLeftPct = mmR && !mmR.none ? mmR.fiveHourLeftPct : null;
    minimax.fiveHourEnd = mmR && !mmR.none ? mmR.fiveHourEnd : null;
    minimax.lastError = mmR ? mmR.lastError : null;
    const thr = policy.throughput.boostWhenShareLeftAbove;
    const boostBy = [claude, minimax].filter(g => g.open && g.sharesLeft > thr).map(g => g.label);
    const boost = { on: boostBy.length > 0 && !rail.pressure, by: boostBy, max: policy.throughput.boostedMaxPerTick,
      why: rail.pressure ? 'off: DeepSeek is near the station\'s daily rail' : boostBy.length ? boostBy.join(' and ') + ' ha' + (boostBy.length > 1 ? 've' : 's') + ' more than half a day\'s share left' : 'off: neither subscription has more than half a day\'s share left' };
    const serious = await seriousFlags();
    return { at: t, mode: policy.mode, live, claude, minimax, deepseek, rail, emergency: em, boost, changes, serious, knobs: readKnobs(), problems: policy.problems.slice() };
  }

  // confirmed S0/S1 "serious" flags, read from competence.js's computed output (company/work/people/competence.json
  // "serious"). Read-only: competence.js's own seriousFlags() issues handoffs, so the pacer never calls it. Only a flag
  // from the last 24 hours can start an emergency, so an old flag seen for the first time never does.
  async function seriousFlags() {
    const out = readJson(P('competenceOut'), null);
    if (!out) return { available: false, why: 'company/work/people/competence.json is not there yet (competence.js writes it daily)', flags: [] };
    if (!Array.isArray(out.serious)) return { available: false, why: 'competence.json has no "serious" list', flags: [] };
    const t = now();
    const flags = out.serious.filter(x => x && /^S[01]$/.test(String(x.severity || '')))
      .map(x => ({ id: String(x.id || ''), who: x.agent || null, severity: x.severity, at: toMs(Date.parse(x.at)) || toMs(x.at), why: String(x.signal || '').slice(0, 160) }))
      .filter(x => x.id && isNum(x.at) && t - x.at <= DAY && x.at <= t + HOUR);
    return { available: true, flags, total: out.serious.length };
  }

  /* ---- plan ---- */
  function plan(m, st, jobs) {
    const t = m.at;
    const R = loadRouting(root);
    const blocked = (id, prov, model) => (st.blocks || []).find(b => b.routineId === id && b.provider === prov && b.until > t && !b.trial && (!b.modelOnly || !model || b.model === model)) || null;
    const rows = [], untouched = [];
    // a seat with its own model chain (model-policy.json seats, company/tools/models.js) is moved by models.js, not here
    let chained = new Set(); try { chained = require('./models.js').chainedSeats(root); } catch (_) {}
    for (const job of jobs || []) {
      if (!job || job.noAgent === true) continue;
      const key = routingKeyFor(job.name, R.routines);
      const cur = { provider: (job.wire && job.wire.provider) || job.provider || '', model: (job.wire && job.wire.model) || job.model || '' };
      if (job.agentId && chained.has(job.agentId)) { untouched.push({ id: job.id, name: job.name, now: cur, seatChain: true }); continue; }
      if (!key) { untouched.push({ id: job.id, name: job.name, now: cur }); continue; }
      const e = R.routines[key] || {};
      const tried = [];
      let choice = null;
      const scope = R.chainFor(key);
      if (scope) {
        // the 1-2-3 chain: the first link that is open now
        const mm = R.models.minimax, ds = R.models.deepseek;
        scope.chain.forEach((link, i) => {
          if (choice) return;
          const pos = 'link ' + (i + 1) + ' of the ' + scope.key + ' chain';
          if (link === 'claude') {
            const tier = e.claude || 'sonnet', md = R.models[tier], b = blocked(job.id, 'claude-cli', md && md.model), need = Number(e.claudeOnlyIfShareLeftAbove);
            const reserveCap = policy.claude.weekCloseAtUsedPct;   // the owner's stop for Claude, not a number of ours
            const reserve = !m.claude.open && scope.claudeReserve && m.claude.known && !m.claude.hard && isNum(m.claude.usedPct) && m.claude.usedPct < reserveCap;
            if (!md || !md.ok) tried.push('Claude tier "' + tier + '" is not allowed for routines' + (md && md.why ? ' (' + md.why + ')' : ''));
            else if (!m.claude.open && !reserve) tried.push('Claude closed: ' + m.claude.why + (scope.claudeReserve ? ' (past the reserve too)' : ''));
            else if (!reserve && Number.isFinite(need) && !(m.claude.sharesLeft > need)) tried.push('Claude is open but only ' + f1(m.claude.sharesLeft) + ' days\' share is left (this routine needs more than ' + need + ')');
            else if (b) tried.push('Claude refused this routine at ' + hm(b.at) + ' (blocked until ' + hm(b.until) + ')');
            else choice = { provider: md.provider, model: md.model, tier, reserve,
              why: pos + (reserve ? '; the ' + scope.key + ' scope keeps Claude past the daily line (week ' + f1(m.claude.usedPct) + '%, Claude stops at ' + reserveCap + '%)' : '; Claude open: ' + m.claude.why), emergency: m.claude.emergencyOpened };
          } else if (link === 'minimax') {
            const b = blocked(job.id, 'custom');
            if (!mm || !mm.ok) tried.push('the MiniMax model is not allowed' + (mm && mm.why ? ' (' + mm.why + ')' : ''));
            else if (!m.minimax.open) tried.push('MiniMax closed: ' + m.minimax.why);
            else if (b) tried.push('MiniMax refused this routine at ' + hm(b.at) + ' (blocked until ' + hm(b.until) + ')');
            else choice = { provider: mm.provider, model: mm.model, tier: 'minimax', why: pos + '; MiniMax open: ' + m.minimax.why, emergency: m.minimax.emergencyOpened };
          } else if (link === 'deepseek') {
            const b = blocked(job.id, 'deepseek');
            if (!ds || !ds.ok) tried.push('the DeepSeek model is not allowed');
            else if (!m.deepseek.open) tried.push('DeepSeek closed: ' + m.deepseek.why);
            else if (m.rail.pressure && e.railOverflow !== false && policy.deepseekRail.overflowToMiniMax) tried.push('DeepSeek is near the station\'s daily rail (' + f1(m.rail.pct) + '%)');
            else if (b) tried.push('DeepSeek refused this routine at ' + hm(b.at) + ' (blocked until ' + hm(b.until) + ')');
            else choice = { provider: ds.provider, model: ds.model, tier: 'deepseek', why: pos + '; DeepSeek open: ' + m.deepseek.why };
          }
        });
        if (!choice) {
          // nothing in the chain is open: stay where it is if that is one of its links, else wait on link 1
          // Park it where it cannot spend: StarNet still fires a scheduled routine on its own, and a firing on a
          // subscription that is merely over the daily line would run and spend it, while one on a hard-closed link
          // (DeepSeek with no credit) fails at once and costs nothing. Else stay, else link 1.
          const curLink = linkOfProvider(cur.provider);
          // only an empty DeepSeek account truly cannot spend: a subscription closed by a threshold still has room left
          const hardClosed = l => l === 'deepseek' && !m.deepseek.open && m.deepseek.hard;
          const keepLink = scope.chain.find(hardClosed) || (scope.chain.includes(curLink) ? curLink : scope.chain[0]);
          const md = keepLink === 'claude' ? R.models[e.claude || 'sonnet'] : R.models[keepLink];
          const stay = keepLink === curLink ? cur : { provider: md.provider, model: md.model };
          choice = { provider: stay.provider, model: stay.model, tier: keepLink === 'claude' ? (e.claude || 'sonnet') : keepLink, none: true,
            why: 'nothing in the ' + scope.key + ' chain is open (' + tried.join('; ') + '); ' + (hardClosed(keepLink) ? 'parked on ' + (NAMES[stay.provider] || stay.provider) + ', which cannot spend while it is closed' : 'it stays on ' + (NAMES[stay.provider] || stay.provider)) };
        }
      }
      if (!scope && e.claude) {
        const md = R.models[e.claude];
        const b = blocked(job.id, 'claude-cli');
        const need = Number(e.claudeOnlyIfShareLeftAbove);
        if (!md || !md.ok) tried.push('Claude tier "' + e.claude + '" is not allowed for routines' + (md && md.why ? ' (' + md.why + ')' : ''));
        else if (!m.claude.open) tried.push('Claude closed: ' + m.claude.why);
        else if (Number.isFinite(need) && !(m.claude.sharesLeft > need)) tried.push('Claude is open but only ' + f1(m.claude.sharesLeft) + ' days\' share is left (this routine needs more than ' + need + ')');
        else if (b) tried.push('Claude refused this routine at ' + hm(b.at) + ' (blocked until ' + hm(b.until) + ')');
        else choice = { provider: md.provider, model: md.model, tier: e.claude, why: 'Claude open: ' + m.claude.why, emergency: m.claude.emergencyOpened };
      }
      const mm = R.models.minimax;
      const mmBlocked = blocked(job.id, 'custom');
      if (!choice && e.minimax === true) {
        if (!mm || !mm.ok) tried.push('the MiniMax model is not allowed' + (mm && mm.why ? ' (' + mm.why + ')' : ''));
        else if (!m.minimax.open) tried.push('MiniMax closed: ' + m.minimax.why);
        else if (mmBlocked) tried.push('MiniMax refused this routine at ' + hm(mmBlocked.at) + ' (blocked until ' + hm(mmBlocked.until) + ')');
        else choice = { provider: mm.provider, model: mm.model, tier: 'minimax', why: 'MiniMax open: ' + m.minimax.why, emergency: m.minimax.emergencyOpened };
      }
      if (!choice && e.minimax !== true && e.railOverflow !== false && m.rail.pressure && policy.deepseekRail.overflowToMiniMax && mm && mm.ok && m.minimax.open && !mmBlocked)
        choice = { provider: mm.provider, model: mm.model, tier: 'minimax', why: 'DeepSeek is near the station\'s daily rail (' + f1(m.rail.pct) + '%) and MiniMax has room', emergency: m.minimax.emergencyOpened };
      if (!choice) {
        const ds = R.models.deepseek;
        choice = { provider: ds.provider, model: ds.model, tier: 'deepseek', why: tried.length ? tried.join('; ') + '; DeepSeek is the fallback' : 'DeepSeek only (routing table)' };
        if (blocked(job.id, 'deepseek')) choice.why += ' (DeepSeek also refused this routine; nothing else is open)';
      }
      const same = cur.provider === choice.provider && cur.model === choice.model;
      const running = !!(job.inFlight || job.state === 'running');
      const last = (st.routines[job.id] || {}).lastSwitchAt;
      const curTier = cur.provider === 'claude-cli' ? R.tierOf(cur.model) : null;
      // rules that never wait for the hourly limit or the ramp: a routine on a model family its chain does not
      // name (MiniMax under a code scope), and a claudeReserve scope (the CEO's) going back onto Claude
      const offChain = scope && cur.provider && !scope.chain.includes(linkOfProvider(cur.provider)) ? (NAMES[cur.provider] || cur.provider) + ' is not in the ' + scope.key + ' chain' : null;
      const ownerLane = scope && scope.claudeReserve && choice.provider === 'claude-cli' && cur.provider !== 'claude-cli' ? 'the ' + scope.key + ' scope runs on Claude (claudeReserve: the CEO stays on Claude)' : null;
      const urgentWhy = offChain || ownerLane || (!cur.provider ? null
        : !R.allowedPair(cur.provider, cur.model) ? cur.provider + '/' + cur.model + ' is not on the allowed list'
        : cur.provider === 'claude-cli' && !ROUTINE_TIERS.includes(curTier) ? cur.model + ' is not a routine tier (Haiku or Sonnet only)'
        : cur.provider === 'claude-cli' && m.claude.hard ? 'Claude is hard-closed (' + m.claude.why + ')'
        : cur.provider === 'custom' && m.minimax.hard ? 'MiniMax is hard-closed (' + m.minimax.why + ')'
        // moving OFF a subscription that is closed to routines (over the line, or its meter unknown) never waits for
        // the hourly limit: only moves onto something are paced
        : cur.provider === 'claude-cli' && !m.claude.open ? 'Claude is closed to routines (' + m.claude.why + ')'
        : cur.provider === 'custom' && !m.minimax.open ? 'MiniMax is closed to routines (' + m.minimax.why + ')'
        // an empty DeepSeek account fails every run at once: moving off it never waits either
        : cur.provider === 'deepseek' && !m.deepseek.open ? 'DeepSeek is closed (' + m.deepseek.why + ')'
        : blocked(job.id, cur.provider) ? NAMES[cur.provider] + ' refused this routine' : null);
      let action, note2 = '';
      if (same) action = 'stay';
      else if (running) { action = 'wait'; note2 = 'it is running now; switched after it ends'; }
      else if (!urgentWhy && isNum(last) && t - last < policy.routing.switchAtMostEveryMin * MIN) { action = 'wait'; note2 = 'switched ' + age(last, t) + ' ago (at most once every ' + policy.routing.switchAtMostEveryMin + ' min)'; }
      else action = 'switch';
      rows.push({ id: job.id, name: job.name, key, now: cur, to: { provider: choice.provider, model: choice.model }, tier: choice.tier, why: choice.why, emergency: !!choice.emergency, none: !!choice.none, scope: scope ? scope.key : null,
        action, wait: note2, urgent: urgentWhy, nextRunAt: job.nextRunAt || null, lastSwitchAt: last || null, enabled: job.enabled !== false });
    }
    // Ramp: at most maxOntoSubscriptionPerHour routines move onto a subscription (from another provider) in any hour,
    // in the routing table's order, so going live (or a subscription reopening) never moves every routine at once.
    const ramp = policy.routing.maxOntoSubscriptionPerHour;
    if (ramp > 0) {
      const recent = Object.values(st.routines || {}).filter(v => v && isNum(v.lastSwitchAt) && t - v.lastSwitchAt < HOUR && v.to && v.from && SUBS.includes(v.to.provider) && v.from.provider !== v.to.provider).length;
      let room = Math.max(0, ramp - recent);
      const order = Object.keys(R.routines);
      const onto = rows.filter(r => r.action === 'switch' && !r.urgent && SUBS.includes(r.to.provider) && r.now.provider !== r.to.provider)
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      for (const r of onto) {
        if (room > 0) { room--; continue; }
        r.action = 'wait'; r.wait = 'ramp: at most ' + ramp + ' routine(s) move onto a subscription per hour (' + recent + ' in the last hour)';
      }
    }
    // re-fires owed for fresh refusals: once, after the routine has moved off the provider that refused
    const refires = [];
    for (const p of st.pendingRefires || []) {
      const job = (jobs || []).find(j => j.id === p.routineId);
      const row = rows.find(r => r.id === p.routineId);
      if (!job || !row) continue;
      const lastRun = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
      let status = 'ready';
      if (lastRun > p.endedAt + MIN) status = 'done: the routine has run again since';
      else if (require('./lib/scheduler').switchedOff(job, root)) status = 'skip: the routine is paused (Run Now would still fire it, so the pacer never does)';
      else if (job.inFlight || job.state === 'running') status = 'wait: running';
      else if (row.to.provider === p.provider) status = 'stop: no other model in its chain is open, so nothing could re-run it';
      else if (row.action === 'wait') status = 'wait: ' + row.wait;
      refires.push({ runId: p.runId, routineId: p.routineId, name: job.name, provider: p.provider, model: p.model, to: row.to, status });
    }
    return { at: t, rows, untouched, refires, rail: railPlan(m, st, jobs, rows), blocks: (st.blocks || []).filter(b => b && b.until > t), closures: Object.assign({}, st.closures || {}), problems: R.problems };
  }

  // Scheduled runs near the rail. StarNet fires routines on their own schedules without the dispatcher, so holding
  // dispatcher wake-ups alone cannot keep the station under its rail. From pauseScheduledAtPct a routine that would
  // still run on DeepSeek is paused (POST /api/cron/update {enabled:false}) unless it is running (a pause aborts the
  // run), it is an owner-wake loop, or its person has an OPEN handoff due today; the pacer resumes the routines it
  // paused itself once the rail is under resumeBelowPct, or when the mode is no longer live. A routine somebody else
  // paused or resumed meanwhile is left alone.
  function railPlan(m, st, jobs, rows) {
    const byId = Object.fromEntries((jobs || []).map(j => [j.id, j]));
    const crew = crewLoops();
    const paused = st.railPaused || {};
    const out = { pause: [], resume: [], keep: [], forget: [], spared: [] };
    for (const [id, p] of Object.entries(paused)) {
      const job = byId[id];
      if (!job) { if ((jobs || []).length) out.forget.push({ id, name: p && p.name, why: 'the routine is gone' }); continue; }
      if (job.enabled !== false) { out.forget.push({ id, name: job.name, why: 'somebody resumed it' }); continue; }
      if (!live) out.resume.push({ id, name: job.name, why: 'the mode is ' + policy.mode + ': the pacer lifts its own rail pauses' });
      else if (m.rail.pct < m.rail.resumeBelowPct) out.resume.push({ id, name: job.name, why: 'the rail is down to ' + Math.round(m.rail.pct) + '% (resumes under ' + m.rail.resumeBelowPct + '%)' });
      else out.keep.push({ id, name: job.name });
    }
    if (!m.rail.pausePressure) return out;
    for (const r of rows) {
      const job = byId[r.id];
      const after = r.action === 'switch' ? r.to : r.now;   // where it runs once this tick's switches are made
      if (!job || after.provider !== 'deepseek' || job.enabled === false || paused[r.id]) continue;
      const agent = crew[job.agentId] || null;
      const ownLoop = agent && agent.loop && (job.name === agent.loop || String(job.name).startsWith(agent.loop));
      let spare = null;
      if (agent && agent.wakeOnOwnerMessage && ownLoop) spare = 'owner-wake loop';
      else if (agent && agent.inbox && handoffsDueToday(path.join(root, REL.handoffs, agent.inbox), m.at).length) spare = (agent.name || job.agentId) + ' has an OPEN handoff due today';
      else if (job.inFlight || job.state === 'running') spare = 'running now (a pause would abort it); paused after it ends';
      if (spare) { out.spared.push({ id: r.id, name: job.name, why: spare }); continue; }
      out.pause.push({ id: r.id, name: job.name, why: 'the rail is at ' + Math.round(m.rail.pct) + '% (pauses from ' + m.rail.pauseAtPct + '%) and nothing but DeepSeek is open for it' });
    }
    return out;
  }

  /* ---- apply ---- */
  // pause (false) or resume (true) one routine; true only when the station's answer shows it done
  async function setEnabled(id, want) {
    let res; try { res = await call('POST', '/api/cron/update', { id, patch: { enabled: want } }); } catch (e) { res = { status: 0, body: String(e.message) }; }
    let j = {}; try { j = JSON.parse(res.body); } catch (_) {}
    const v = require('./lib/station').cronResult(res, 'POST /api/cron/update');   // a 200 can be a decline: its message is the body shown
    return { ok: v.ok && j.ok === true && !!j.job && (j.job.enabled !== false) === want, status: res.status, body: v.ok ? String(res.body || '').slice(0, 160) : v.reason };
  }
  async function applyRail(m, pl, st, jobs, fresh) {
    const t = m.at, done = [], rp = pl.rail || { pause: [], resume: [], forget: [] };
    const byId = Object.fromEntries((jobs || []).map(j => [j.id, j]));
    st.railPaused = st.railPaused || {};
    for (const f of rp.forget || []) delete st.railPaused[f.id];
    for (const r of rp.resume || []) {
      const res = await setEnabled(r.id, true);
      if (res.ok) { delete st.railPaused[r.id]; if (byId[r.id]) { byId[r.id].enabled = true; byId[r.id].state = 'scheduled'; } }
      note((res.ok ? 'RESUME "' : 'RESUME FAILED "') + r.name + '" (the pacer had paused it for the rail): ' + r.why + (res.ok ? '' : '; HTTP ' + res.status + ' ' + res.body));
      journal('rail-resume', { routine: r.name, routineId: r.id, ok: res.ok, why: r.why });
      done.push({ id: r.id, name: r.name, resume: true, applied: res.ok });
    }
    if (!live) return done;
    for (const r of rp.pause || []) {
      const nowJob = fresh && fresh[r.id];
      if (!nowJob || nowJob.inFlight || nowJob.state === 'running' || nowJob.enabled === false) { done.push({ id: r.id, name: r.name, pause: true, applied: false, error: !nowJob ? 'could not re-read it' : 'it started running or was paused meanwhile' }); continue; }
      const res = await setEnabled(r.id, false);
      if (res.ok) { st.railPaused[r.id] = { at: t, name: r.name, railPct: Math.round(m.rail.pct) }; if (byId[r.id]) { byId[r.id].enabled = false; byId[r.id].state = 'paused'; } }
      note((res.ok ? 'PAUSE "' : 'PAUSE FAILED "') + r.name + '" for the station rail: ' + r.why + (res.ok ? '; resumed under ' + m.rail.resumeBelowPct + '%' : '; HTTP ' + res.status + ' ' + res.body));
      journal('rail-pause', { routine: r.name, routineId: r.id, ok: res.ok, railPct: Math.round(m.rail.pct) });
      done.push({ id: r.id, name: r.name, pause: true, applied: res.ok });
    }
    return done;
  }
  async function apply(m, pl, st, jobs) {
    const t = m.at, done = [];
    const byId = Object.fromEntries((jobs || []).map(j => [j.id, j]));
    const switches = pl.rows.filter(r => r.action === 'switch');
    const rp = pl.rail || { pause: [], resume: [], forget: [] };
    if (!live || dry || readOnly) {
      for (const r of switches) done.push({ id: r.id, name: r.name, from: r.now, to: r.to, applied: false, why: r.why });
      for (const f of pl.refires.filter(x => x.status === 'ready')) done.push({ id: f.routineId, name: f.name, refire: true, applied: false });
      for (const r of rp.pause) done.push({ id: r.id, name: r.name, pause: true, applied: false });
      // the one thing a non-live mode does: lift a rail pause the pacer itself made while it was live
      if (!dry && !readOnly && (rp.resume.length || rp.forget.length)) done.push(...await applyRail(m, pl, st, jobs, null));
      else for (const r of rp.resume) done.push({ id: r.id, name: r.name, resume: true, applied: false });
      return done;
    }
    let fresh = null;   // the routines as they are now: a run may have started since the plan was made
    if (switches.length || rp.pause.length) { try { fresh = Object.fromEntries((await getJobs()).map(j => [j.id, j])); } catch (_) { fresh = null; } }
    for (const r of switches) {
      const nowJob = fresh && fresh[r.id];
      if (!fresh || !nowJob || nowJob.inFlight || nowJob.state === 'running') { done.push({ id: r.id, name: r.name, from: r.now, to: r.to, applied: false, error: !fresh ? 'could not re-read the routines' : 'started running; switched on a later tick' }); continue; }
      let res; try { res = await call('POST', '/api/cron/update', { id: r.id, patch: { provider: r.to.provider, model: r.to.model } }); } catch (e) { res = { status: 0, body: String(e.message) }; }
      let j = {}; try { j = JSON.parse(res.body); } catch (_) {}
      const ok = res.status === 200 && j.ok === true && j.job && j.job.provider === r.to.provider && j.job.model === r.to.model;
      if (ok) {
        st.original = st.original || {};
        if (!st.original[r.id]) st.original[r.id] = { provider: r.now.provider, model: r.now.model, name: r.name, at: t };   // what `restore` puts back
        st.routines[r.id] = { lastSwitchAt: t, from: r.now, to: r.to, why: r.why, emergency: !!r.emergency };
        const job = byId[r.id];
        if (job) { job.provider = r.to.provider; job.model = r.to.model; job.wire = Object.assign({}, job.wire || {}, { provider: r.to.provider, model: r.to.model, source: 'routine' }); }
        note('SWITCH "' + r.name + '": ' + r.now.provider + '/' + r.now.model + ' -> ' + r.to.provider + '/' + r.to.model + ' (' + r.why + ')' + (r.emergency ? ' [EMERGENCY]' : ''));
        journal('switch', { routine: r.name, routineId: r.id, from: r.now, to: r.to, why: r.why, emergency: !!r.emergency });
        if (r.emergency) journal('emergency-use', { routine: r.name, to: r.to });
        done.push({ id: r.id, name: r.name, from: r.now, to: r.to, applied: true });
      } else {
        note('SWITCH FAILED "' + r.name + '" to ' + r.to.provider + '/' + r.to.model + ': HTTP ' + res.status + ' ' + String(res.body).slice(0, 160));
        done.push({ id: r.id, name: r.name, from: r.now, to: r.to, applied: false, error: 'HTTP ' + res.status });
      }
    }
    for (const f of pl.refires) {
      if (/^stop:/.test(f.status) && !(st.refired[f.runId])) {   // every entry refused or closed: said plainly, once, and stopped
        st.refired[f.runId] = { at: t, status: 'stopped' };
        const job0 = byId[f.routineId];
        note('REFUSED, NOT RE-RUN "' + f.name + '": ' + (NAMES[f.provider] || f.provider) + ' refused it and no other model in its chain is open. The run is reported, not lost: the CEO picks it up.');
        try { require('./lib/refusal.js').record({ root, seat: job0 && job0.agentId, door: 'routine', runId: f.runId, from: { provider: f.provider, model: f.model }, to: null }); } catch (_) {}
        continue;
      }
      if (f.status !== 'ready' && !/^done/.test(f.status)) continue;
      if (/^done/.test(f.status)) { st.refired[f.runId] = { at: t, status: 'not needed' }; continue; }
      const job = byId[f.routineId];
      const curProv = job ? ((job.wire && job.wire.provider) || job.provider) : null;
      if (!job || curProv === f.provider) continue;   // the switch did not happen: never re-fire on the model that refused
      st.refired[f.runId] = { at: t, status: 'pending' };   // marked before firing: a timeout never fires it twice
      const tk = require('./lib/admit').admit({ door: 'pacer', kind: 'run', seat: job.agentId || null, jobId: f.routineId, why: 're-fire after a refusal on ' + f.provider });   // the one gate, phase 1: recorded
      if (tk.decision === 'hold' && tk.memory) { delete st.refired[f.runId]; continue; }   // short of memory: retried on a later tick
      const res = await fire(f.routineId);
      require('./lib/admit').started(tk, res);
      st.refired[f.runId] = { at: t, status: res.status };
      if (res.status === 200 && job) job.inFlight = true;   // the dispatcher skips it this tick
      note('RE-FIRE "' + f.name + '" on ' + curProv + ' after a refusal: HTTP ' + res.status + (res.status === 200 ? '' : ' ' + String(res.body).slice(0, 120)));
      if (res.status === 200) try { require('./lib/refusal.js').record({ root, seat: job.agentId, door: 'routine', runId: f.runId, retryRunId: res.runId || null, from: { provider: f.provider, model: f.model }, to: { provider: curProv, model: (job.wire && job.wire.model) || job.model } }); } catch (_) {}
      journal('refire', { routine: f.name, routineId: f.routineId, runId: f.runId, on: curProv, status: res.status });
      done.push({ id: f.routineId, name: f.name, refire: true, applied: res.status === 200 });
    }
    done.push(...await applyRail(m, pl, st, jobs, fresh));
    return done;
  }

  // refused runs of routines plan() leaves to models.js (seats with their own chain): once, after the seat moved off the
  // provider that refused; with nothing else to run on, said plainly once and stopped (lib/refusal.js)
  async function refireChained(st, jobs, pl) {
    const out = []; const t = now();
    const mine = new Set((pl.untouched || []).filter(u => u.seatChain).map(u => u.id));
    for (const p of (st.pendingRefires || []).slice()) {
      if (!mine.has(p.routineId) || st.refired[p.runId]) continue;
      const job = (jobs || []).find(j => j.id === p.routineId); if (!job) continue;
      const curProv = (job.wire && job.wire.provider) || job.provider, curModel = (job.wire && job.wire.model) || job.model;
      const lastRun = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
      if (lastRun > p.endedAt + MIN) { st.refired[p.runId] = { at: t, status: 'not needed' }; continue; }
      if (require('./lib/scheduler').switchedOff(job, root) || job.inFlight || job.state === 'running') continue;
      if (curProv === p.provider && (!p.modelOnly || curModel === p.model)) {   // models.js could not move it: no other entry can run
        st.refired[p.runId] = { at: t, status: 'stopped' };
        note('REFUSED, NOT RE-RUN "' + job.name + '": ' + (NAMES[p.provider] || p.provider) + ' refused it and no other model in its seat\'s chain can run. The run is reported, not lost: the CEO picks it up.');
        try { require('./lib/refusal.js').record({ root, seat: job.agentId, door: 'routine', runId: p.runId, from: { provider: p.provider, model: p.model }, to: null }); } catch (_) {}
        continue;
      }
      st.refired[p.runId] = { at: t, status: 'pending' };
      const tk = require('./lib/admit').admit({ door: 'pacer', kind: 'run', seat: job.agentId || null, jobId: job.id, provider: curProv, why: 're-fire after a refusal on ' + p.provider });
      if (tk.decision === 'hold' && tk.memory) { delete st.refired[p.runId]; continue; }   // short of memory: retried on a later tick
      const res = await fire(job.id);
      require('./lib/admit').started(tk, res);
      st.refired[p.runId] = { at: t, status: res.status };
      if (res.status === 200) { job.inFlight = true; try { require('./lib/refusal.js').record({ root, seat: job.agentId, door: 'routine', runId: p.runId, retryRunId: res.runId || null, from: { provider: p.provider, model: p.model }, to: { provider: curProv, model: curModel } }); } catch (_) {} }
      note('RE-FIRE "' + job.name + '" on ' + curProv + '/' + curModel + ' after a refusal on ' + (NAMES[p.provider] || p.provider) + ': HTTP ' + res.status);
      journal('refire', { routine: job.name, routineId: job.id, runId: p.runId, on: curProv, status: res.status });
      out.push({ id: job.id, name: job.name, refire: true, applied: res.status === 200 });
    }
    return out;
  }

  // Put every routine the pacer moved back on the model it had before the pacer first moved it, and lift the
  // pacer's own rail pauses: the way to stop the pacer's effect on the station, in any mode (setting the mode to
  // shadow only stops further changes). A running routine is left for a later run of this command.
  async function restore(st, jobs) {
    const done = [];
    if (!(jobs || []).length) return [{ applied: false, error: 'could not read the routines from the station; nothing was changed' }];
    const byId = Object.fromEntries((jobs || []).map(j => [j.id, j]));
    for (const [id, o] of Object.entries(st.original || {})) {
      const job = byId[id];
      if (!job) { done.push({ id, name: o.name, applied: false, error: 'the routine is gone' }); delete st.original[id]; continue; }
      const cur = { provider: (job.wire && job.wire.provider) || job.provider || '', model: (job.wire && job.wire.model) || job.model || '' };
      if (cur.provider === o.provider && cur.model === o.model) { delete st.original[id]; delete st.routines[id]; done.push({ id, name: job.name, applied: true, note: 'already on ' + o.provider + '/' + o.model }); continue; }
      if (job.inFlight || job.state === 'running') { done.push({ id, name: job.name, applied: false, error: 'running now; run restore again after it ends' }); continue; }
      if (dry) { done.push({ id, name: job.name, applied: false, would: o }); continue; }
      let res; try { res = await call('POST', '/api/cron/update', { id, patch: { provider: o.provider, model: o.model } }); } catch (e) { res = { status: 0, body: String(e.message) }; }
      let j = {}; try { j = JSON.parse(res.body); } catch (_) {}
      const ok = res.status === 200 && j.ok === true && j.job && j.job.provider === o.provider && j.job.model === o.model;
      if (ok) { delete st.original[id]; delete st.routines[id]; }
      note((ok ? 'RESTORE "' : 'RESTORE FAILED "') + job.name + '": ' + cur.provider + '/' + cur.model + ' -> ' + o.provider + '/' + o.model + (ok ? '' : ' (HTTP ' + res.status + ')'));
      journal('restore', { routine: job.name, routineId: id, to: o, ok });
      done.push({ id, name: job.name, applied: ok, to: o });
    }
    for (const [id, p] of Object.entries(st.railPaused || {})) {
      const job = byId[id];
      if (!job || job.enabled !== false) { delete st.railPaused[id]; continue; }
      if (dry) { done.push({ id, name: job.name, resume: true, applied: false }); continue; }
      const res = await setEnabled(id, true);
      if (res.ok) delete st.railPaused[id];
      note((res.ok ? 'RESUME "' : 'RESUME FAILED "') + job.name + '" (restore: the pacer had paused it for the rail)');
      journal('rail-resume', { routine: job.name, routineId: id, ok: res.ok, why: 'restore' });
      done.push({ id, name: (p && p.name) || job.name, resume: true, applied: res.ok });
    }
    return done;
  }

  /* ---- emergency ---- */
  function emergencyOn(a) {
    a = a || {};
    const t = now();
    const by = String(a.by || '').trim(), why = String(a.why || '').trim(), hours = Number(a.hours);
    if (!a.auto) {
      if (!by || !byAllowed(by)) return { ok: false, error: '--by must be ' + allowedWords() + ' (pacing-policy.json emergency.allowedBy)' };
      if (!why) return { ok: false, error: '--why is required: say what the emergency is' };
    }
    if (!(hours > 0) || hours > policy.emergency.maxHours) return { ok: false, error: '--hours must be more than 0 and at most ' + policy.emergency.maxHours };
    // a hand-started emergency lifts the pacing lines, which is a budget decision (self-governance category budget); the
    // automatic one for a confirmed serious flag is standing policy (emergency.autoOnSerious) and is not asked again
    if (!a.auto) {
      const gd = gov.decide('budget', Object.assign({ by, ref: 'budget:emergency:' + by.toLowerCase() + ':' + hours + ':' + why.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) },
        ASKS.emergency({ ceilingPct: policy.emergency.ceilingPct, hours, why })), govOpts);
      if (!gd.allowed) return { ok: false, error: gov.refusal('budget', gd), governance: { level: gd.level, questionId: gd.questionId || null } };
    }
    const cur = readEmergency(t);
    const until = t + hours * HOUR;
    const rec = { active: true, why: why.slice(0, 300), by: by.slice(0, 80), until: new Date(until).toISOString(), since: new Date(t).toISOString(), hours, auto: !!a.auto,
      flag: a.auto && a.flag ? String(a.flag) : undefined,
      note: 'While active, the daily line rises to ' + policy.emergency.ceilingPct + '% of each weekly limit. It ends by itself at "until". company/tools/pacer.js emergency off ends it early.' };
    if (!dry) writeJsonAtomic(P('emergency'), rec);
    note('EMERGENCY ON by ' + rec.by + ' for ' + hours + ' h, until ' + when(until) + (cur.active ? ' (replaces the one from ' + (cur.by || '?') + ')' : '') + ': ' + rec.why);
    journal('emergency-on', { by: rec.by, why: rec.why, hours, until: rec.until, auto: rec.auto });
    return { ok: true, emergency: rec };
  }
  function emergencyOff(a) {
    a = a || {};
    const t = now();
    const by = String(a.by || '').trim();
    if (!by) return { ok: false, error: '--by is required' };
    const cur = readJson(P('emergency'), null);
    if (!cur || cur.active !== true) return { ok: true, note: 'no emergency was active' };
    const rec = Object.assign({}, cur, { active: false, endedAt: new Date(t).toISOString(), endedBy: by.slice(0, 80), endedWhy: String(a.why || 'ended early').slice(0, 200) });
    if (!dry) writeJsonAtomic(P('emergency'), rec);
    note('EMERGENCY OFF by ' + rec.endedBy + ' (' + rec.endedWhy + '); it was on since ' + when(Date.parse(cur.since)) + ' for: ' + String(cur.why || '').slice(0, 120));
    journal('emergency-off', { by: rec.endedBy, why: rec.endedWhy });
    return { ok: true, emergency: rec };
  }
  // expire an emergency whose time is up, and start one for a new confirmed S0/S1 serious flag (shadow: say so only)
  function emergencyHousekeeping(m, st) {
    const t = m.at;
    if (m.emergency.expired && !dry) {
      const cur = readJson(P('emergency'), {}) || {};
      writeJsonAtomic(P('emergency'), Object.assign({}, cur, { active: false, endedAt: new Date(t).toISOString(), endedBy: 'pacer', endedWhy: 'expired' }));
      note('EMERGENCY EXPIRED (on since ' + when(Date.parse(cur.since)) + ', by ' + (cur.by || '?') + '): the daily line is back to ' + f1(lineFor(m.claude.day || 1, frac * policy.claude.shareOfAccount, margin)) + '% for Claude');
      journal('emergency-expired', { by: cur.by, why: cur.why });
      m.emergency = readEmergency(t);
    }
    if (!policy.emergency.autoOnSerious || !m.serious || !m.serious.available) return;
    st.seriousSeen = st.seriousSeen || {};
    const fresh = m.serious.flags.filter(f => !st.seriousSeen[f.id]);
    if (!fresh.length) return;
    const f = fresh[0];
    if (!live) { note('SHADOW would turn on an emergency for ' + policy.emergency.autoHours + ' h: confirmed serious flag ' + f.id + (f.who ? ' (' + f.who + ')' : '')); }
    else if (!m.emergency.active) { emergencyOn({ auto: true, flag: f.id, by: 'auto (competence.js)', why: 'confirmed ' + (f.severity || 'S0/S1') + ' serious flag ' + f.id + (f.who ? ' (' + f.who + ')' : '') + (f.why ? ': ' + f.why : ''), hours: policy.emergency.autoHours }); m.emergency = readEmergency(t); }
    if (!dry) for (const x of fresh) st.seriousSeen[x.id] = t;
  }

  /* ---- the dispatcher's tick ---- */
  function crewLoops() { return ((readJson(P('loops'), {}) || {}).agents) || {}; }
  function loopJob(jobs, crew, agentId) {
    const want = crew[agentId] && crew[agentId].loop;
    if (!want) return null;
    const hits = (jobs || []).filter(j => j.name === want || String(j.name).startsWith(want));
    return hits.length === 1 ? hits[0] : null;
  }
  function gateLine(m) {
    const g = x => x.label + ' ' + (x.open ? 'open' : 'closed') + ' (' + (!x.known ? 'unknown'
      : x.paceBy === 'fiveHour' ? 'week ' + f1(x.usedPct) + '% of the ' + x.weekCap + '% stop, 5-hour window ' + (isNum(x.fiveHourLeftPct) ? f1(x.fiveHourLeftPct) + '% left' : 'unknown')
      : 'week ' + f1(x.usedPct) + '%, line ' + f1(x.line) + '%' + (x.dailyLineOff ? ' (daily line off until ' + when(x.dailyLineOff) + ')' : '')) + (x.open ? '' : ': ' + x.why) + ')';
    return g(m.claude) + '; ' + g(m.minimax) + '; DeepSeek ' + (m.deepseek.open ? 'open' : 'closed: ' + m.deepseek.why) + '; ' + railShort(m.rail);
  }
  // The rail has three states, not one number: no rail at all (`caps.perDay` 0), a rail
  // whose numerator the station cannot settle (day total null), and a measured percentage. Printing "0%" for the
  // first reads as headroom when it means nothing is capped, and printing a percentage for the second reports the
  // smallest term of a sum as if it were the sum.
  function railShort(r) {
    if (r.none) return 'DeepSeek rail: NOT ARMED (station caps.perDay is 0 — nothing is capped)';
    // No dollar figure here or below: the rail is the owner's money and ai-usage.md carries percentages only
    // (`pacer.test.js` asserts the report has no `$<number>`), so the wording says WHICH numerator is missing instead.
    if (r.dayNull) return 'rail armed at the station\'s caps.perDay/day; station day total is null (accounting UNSETTLED_SPEND), so the percentage covers in-flight runs only';
    return 'DeepSeek rail ' + Math.round(r.pct) + '% of the station\'s daily rail' + (r.pressure ? ' (DeepSeek wake-ups held from ' + r.holdAtPct + '%)' : '');
  }
  function onChange(st, key, value, line) {
    st.keys = st.keys || {};
    if (dry) { note(line); return; }   // a dry run shows everything, every time
    if (st.keys[key] === value) return;
    st.keys[key] = value;
    note(line);
  }

  async function hook(a) {
    a = a || {};
    const r = await withLock(() => hookLocked(a), 5000);
    if (r.busy) { note('BUSY: another pacer command holds company/state/pacer-state.json; this tick runs without the pacer'); return { extra: 0, busy: true }; }
    return r.value;
  }
  async function hookLocked(a) {
    const order = Array.isArray(a.order) ? a.order : [];
    const jobs = Array.isArray(a.jobs) ? a.jobs : await getJobs();
    const maxPerTick = numOr(a.maxPerTick, 2, 1, 50);
    const st = loadState();
    const m = await measure(st, jobs);
    emergencyHousekeeping(m, st);
    const pl = plan(m, st, jobs);
    onChange(st, 'gates', [m.claude.open, m.minimax.open, m.rail.pressure, m.rail.pausePressure, m.emergency.active, m.deepseek.open].join(','), gateLine(m));
    if (m.emergency.invalid) onChange(st, 'emInvalid', String(m.emergency.invalid), 'EMERGENCY IGNORED: company/state/emergency.json says an emergency is on, but ' + m.emergency.invalid + '; the daily line stays as it is');
    else if (st.keys && st.keys.emInvalid) st.keys.emInvalid = '';
    const pj = m.rail.projection;
    const eta = pj && pj.tripAt ? Math.round(pj.tripAt / HOUR) : 0;   // logged again only when the estimate moves by an hour or more
    if (eta) onChange(st, 'railEta', String(eta), 'RAIL WARNING: at the last ' + pj.fromHours + ' hours\' pace (about ' + f1(pj.pctPerHour) + '% of the station\'s daily rail an hour) the rail would reach ' + m.rail.holdAtPct + '% around ' + when(pj.holdAt) + ' and trip around ' + when(pj.tripAt) + (live ? '; the pacer holds and pauses DeepSeek work from ' + m.rail.holdAtPct + '% and ' + m.rail.pauseAtPct + '%' : '; mode shadow: nothing holds it'));
    else if (st.keys && st.keys.railEta) st.keys.railEta = '';
    if (a.late) return { extra: 0, late: true };
    const done = await apply(m, pl, st, jobs);
    // per-seat model chains (company/tools/models.js): failover and recovery on this tick's measurement; never throws
    // they see this tick's refusal blocks (st.blocks, not yet saved): a refused seat moves to its next entry now
    if (!a.late) await require('./models.js').tick({ root, m, jobs, log: a.log || (l => note(l)), dry, call, now, blocks: st.blocks });
    // a refused run of a seat with its own chain is re-run once, in this same tick, on the entry models.js just moved it to
    if (!a.late && live) done.push(...await refireChained(st, jobs, pl));
    if (a.late) { saveState(st); return { extra: 0, late: true }; }
    if (!live) {
      // keyed on every planned move (a running routine's included), so a routine starting or ending does not re-log it
      const mv = pl.rows.filter(r => r.action !== 'stay');
      const key = mv.map(r => r.id + '>' + r.to.provider + '/' + r.to.model).sort().join('|');
      if (mv.length) onChange(st, 'shadow', key, 'SHADOW would move ' + mv.length + ' routine(s): ' + mv.map(r => '"' + r.name + '" ' + r.now.provider + ' -> ' + r.to.provider + '/' + r.to.model + (r.action === 'wait' ? ' (waits: ' + r.wait + ')' : '')).join(', ') + ' (mode shadow: nothing changed)');
      else st.keys.shadow = '';
      for (const f of pl.refires.filter(x => x.status === 'ready')) onChange(st, 'refire:' + f.runId, 'x', 'SHADOW would re-fire "' + f.name + '" once on ' + f.to.provider + '/' + f.to.model + ' after a refusal on ' + f.provider);
      const pk = (pl.rail.pause || []).map(p => p.id).sort().join(',');
      if (pk) onChange(st, 'railPause', pk, 'SHADOW would pause ' + pl.rail.pause.length + ' scheduled DeepSeek routine(s) for the station rail (' + Math.round(m.rail.pct) + '%, pauses from ' + m.rail.pauseAtPct + '%): ' + pl.rail.pause.map(p => '"' + p.name + '"').join(', '));
      else if (st.keys.railPause) st.keys.railPause = '';
    }
    // DeepSeek holds: ONE predicate, TWO triggers. Trigger 1 is the station rail at holdAtPct. Trigger 2 is a DeepSeek
    // peak-price block (pacing-policy.json peakPricing.deepseek, in DeepSeek's own timezone, plus its margin either
    // side so a run that crosses a boundary is not billed at a price we did not choose). Both triggers ask offpeak-hold.js holdCheck(), so they cannot answer differently: an owner wake-up, a
    // loop with an OPEN handoff due today, or an open merge/release/publication window is never held — by either.
    const crew = crewLoops(), holds = [];
    const OH = require('./offpeak-hold.js');
    const pk = OH.peakConfig(root);
    const peak = policy.offpeakHold.enabled ? OH.peakBlock(m.at, undefined, pk) : { peak: false, block: null, off: true };
    if (m.rail.pressure || peak.peak) {
      const windows = OH.windowsOpen({ root, at: m.at, jobs });
      for (const id of order) {
        const job = loopJob(jobs, crew, id);
        const prov = job ? ((job.wire && job.wire.provider) || job.provider) : null;
        if (String(prov || '').toLowerCase() !== 'deepseek') continue;
        const inbox = crew[id] && crew[id].inbox ? path.join(root, REL.handoffs, crew[id].inbox) : null;
        const c = OH.holdCheck({ id, provider: prov, ownerWake: a.ownerWake, inbox, at: m.at, root, windows });
        if (!c.hold) continue;
        // The must-not-move list (offpeakHold.mustNotMove) scopes the PEAK trigger only. The rail hold is a money-safety
        // control, so the list cannot quietly widen a wake the rail already held.
        if (!m.rail.pressure && OH.mustNotMove(job.name, root)) continue;
        holds.push({ id, name: (crew[id] && crew[id].name) || id, loop: job.name, trigger: m.rail.pressure ? 'rail' : 'peak', why: c.why });
      }
    }
    // Nothing in a person's chain is open: the dispatcher does not wake them. A wake on a closed link either fails at
    // once (DeepSeek out of credit) or spends a subscription past its daily line.
    // Kept apart from `holds`: those are deferred to the next DeepSeek window, these wait for any link to open.
    const noneRows = new Map(pl.rows.filter(r => r.to && r.action !== 'switch' && r.none).map(r => [r.id, r]));
    const noneHolds = [];
    for (const id of order) {
      if (holds.some(h => h.id === id)) continue;
      const job = loopJob(jobs, crew, id);
      const row = job && noneRows.get(job.id);
      if (row) noneHolds.push({ id, name: (crew[id] && crew[id].name) || id, loop: job.name, why: row.why, provider: row.to && row.to.provider });
    }
    const noneKey = noneHolds.map(h => h.id).sort().join(',');
    if (noneHolds.length) onChange(st, 'holdNone', noneKey, (live ? 'HOLD' : 'SHADOW would hold') + ' (nothing in their 1-2-3 chain is open): ' + noneHolds.map(h => h.loop + ' (' + h.name + ')').join(', ') + ' — ' + noneHolds[0].why);
    else if (st.keys && st.keys.holdNone) onChange(st, 'holdNone', '', (live ? 'HOLD' : 'SHADOW hold') + ' lifted: every waiting person has an open link in their chain again');
    if (live) for (const h of noneHolds) { const i = order.indexOf(h.id); if (i >= 0) order.splice(i, 1); }
    // a cutoff that holds seats or moves them off a subscription is the owner's decision: ask once (lib/pacing-ask.js)
    try { require('./lib/pacing-ask.js').tick({ root, m, pl, holds: noneHolds, st, live, dry, log: note, govOpts }); } catch (e) { note('PACING ASK ERROR: ' + String(e && e.message || e).slice(0, 200)); }
    const holdKey = holds.map(h => h.id + ':' + h.trigger).sort().join(',');
    const triggerLine = () => (m.rail.pressure && peak.peak)
      ? 'station rail ' + Math.round(m.rail.pct) + '%, holds from ' + m.rail.holdAtPct + '%, and the peak block ' + peak.block + ' until ' + when(OH.nextWindow(m.at, undefined, pk))
      : m.rail.pressure
        ? 'station rail ' + Math.round(m.rail.pct) + '%, holds from ' + m.rail.holdAtPct + '%'
        : 'DeepSeek peak block ' + peak.block + ', holds until ' + when(OH.nextWindow(m.at, undefined, pk));
    if (holds.length) onChange(st, 'hold', holdKey, (live ? 'HOLD' : 'SHADOW would hold') + ' (' + triggerLine() + '): ' + holds.map(h => h.loop + ' (' + h.name + ')' + (h.trigger === 'peak' ? ' [peak]' : '')).join(', ') + ' — ' + holds[0].why);
    else if (st.keys && st.keys.hold) { onChange(st, 'hold', '', (live ? 'HOLD' : 'SHADOW hold') + ' lifted: no DeepSeek wake is held (rail ' + Math.round(m.rail.pct) + '%, ' + (peak.peak ? 'inside the peak block ' + peak.block : 'outside the peak blocks') + ')'); }
    if (live) for (const h of holds) { const i = order.indexOf(h.id); if (i >= 0) order.splice(i, 1); }
    // A deferred wake is for the NEXT window only. The record says when it was first held and when that window ends;
    // if the loop has still not run by then, one DEFERRED DROP line says so and the record is forgotten. Nothing is
    // retried on this record's account, and nothing here can hold a wake for a second window.
    if (live) {
      st.deferred = st.deferred && typeof st.deferred === 'object' ? st.deferred : {};
      // settle(id, d): a record that ran is forgotten; one whose cheap window has CLOSED without a run is dropped with
      // one DEFERRED DROP line. Returns true when the record is gone. Used for held and not-held loops alike, so a
      // morning record that was never run cannot be inherited by the afternoon's hold.
      const settle = (id, d) => {
        const job = loopJob(jobs, crew, id);
        if (job && (Date.parse(job.lastRunAt) || 0) >= (d.at || 0)) { delete st.deferred[id]; return true; }
        if (m.at >= (d.expires || d.until || 0)) {   // the cheap window has CLOSED (not opened): the loop was owed a run inside it
          onChange(st, 'deferDrop:' + id + ':' + d.at, 'x', 'DEFERRED DROP: "' + d.name + '" was held from ' + when(d.at) + ' to ' + when(d.until) + ' and owed a run until ' + when(d.expires || d.until) + ' (' + d.trigger + ': ' + d.why + ') and did not run in that window; this wake is not retried');
          delete st.deferred[id];
          journal('defer-drop', { id, agent: id, loop: d.name, from: new Date(d.at || 0).toISOString(), until: new Date(d.until || 0).toISOString(), expires: new Date(d.expires || d.until || 0).toISOString(), why: d.why });
          return true;
        }
        return false;
      };
      for (const h of holds) {
        let prev = st.deferred[h.id];
        if (prev && settle(h.id, prev)) prev = null;
        st.deferred[h.id] = { at: prev ? prev.at : m.at, until: OH.nextWindow(m.at, undefined, pk), expires: prev && prev.expires ? prev.expires : OH.windowCloses(m.at, undefined, pk), name: h.loop, why: h.why, trigger: h.trigger };
        journal('defer', { id: h.id, agent: h.name, loop: h.loop, trigger: h.trigger, until: new Date(st.deferred[h.id].until).toISOString(), expires: new Date(st.deferred[h.id].expires).toISOString(), why: h.why });
      }
      const heldNow = new Set(holds.map(h => h.id));
      for (const [id, d] of Object.entries(st.deferred)) {
        if (heldNow.has(id) || !d) continue;
        if (!settle(id, d) && !d.released) {
          // Held earlier, not held now, window not yet closed, loop not yet run: the predicate let go (a handoff came due,
          // the owner wrote, a window opened) or the loop left DeepSeek. One row, so a run that follows inside the peak is
          // explained in the record instead of being read by offpeak-proof.js as a hold that did not take.
          d.released = m.at;
          journal('release', { id, agent: id, loop: d.name, from: new Date(d.at || 0).toISOString(), why: 'held at ' + when(d.at) + ', no longer held at ' + when(m.at) + ': the hold predicate stopped holding or the loop left DeepSeek' });
        }
      }
    }
    // The third per-tick slot, lent only when it would wake a loop that runs on a subscription with room: the
    // dispatcher fires the due loops in `order`, so the slot goes to the (maxPerTick+1)-th loop it can fire. The
    // dispatcher's own skips are mirrored here (no loop, paused, running, cooldown), so this is a close estimate; the
    // ones it cannot see (ask mode, its own caps) only make the slot go unused.
    const boosted = Math.max(maxPerTick, m.boost.max);
    const wouldExtra = m.boost.on ? boosted - maxPerTick : 0;
    const subsWithRoom = new Set([m.claude, m.minimax].filter(g => g.open && g.sharesLeft > policy.throughput.boostWhenShareLeftAbove).map(g => g.key === 'claude' ? 'claude-cli' : 'custom'));
    const cdMin = k => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : null; };
    const cooldown = (cdMin('DISPATCH_COOLDOWN_MIN') || 40) * MIN, ownerCooldown = (cdMin('DISPATCH_OWNER_COOLDOWN_MIN') || 10) * MIN;
    const isOwner = id => !!(a.ownerWake && typeof a.ownerWake.has === 'function' && a.ownerWake.has(id));
    const fireable = order.map(id => ({ id, job: loopJob(jobs, crew, id) })).filter(x => x.job && !require('./lib/scheduler').switchedOff(x.job, root) && !x.job.inFlight && x.job.state !== 'running'
      && m.at - (Date.parse(x.job.lastRunAt) || 0) >= (isOwner(x.id) ? ownerCooldown : cooldown));
    let lend = 0;
    for (let i = maxPerTick; i < Math.min(fireable.length, maxPerTick + wouldExtra); i++) {
      const prov = (fireable[i].job.wire && fireable[i].job.wire.provider) || fireable[i].job.provider;
      if (subsWithRoom.has(prov)) lend++; else break;
    }
    const extra = live ? lend : 0;
    onChange(st, 'boost', String(m.boost.on), m.boost.on
      ? (live ? 'PER-TICK LIMIT up to ' + boosted : 'SHADOW would raise the per-tick limit to ' + boosted) + ' when the extra loop runs on a subscription with room: ' + m.boost.why
      : (live ? 'PER-TICK LIMIT ' + maxPerTick : 'SHADOW per-tick limit stays ' + maxPerTick) + ' (' + m.boost.why + ')');
    st.last = { at: m.at, mode: policy.mode, claude: m.claude.open, minimax: m.minimax.open, railPct: Math.round(m.rail.pct), holds: holds.map(h => h.id), extra, wouldLend: lend,
      switched: done.filter(d => d.applied && !d.refire && !d.pause && !d.resume).length, paused: Object.keys(st.railPaused || {}).length };
    saveState(st);
    if (!dry) try { writeReport(m, pl, st, { holds, extra, wouldExtra, lend, maxPerTick }); } catch (e) { note('REPORT ERROR: ' + e.message); }
    return { extra, holds: holds.map(h => h.id), mode: policy.mode };
  }

  /* ---- words ---- */
  function meterRow(g) {
    const name = g.key === 'claude' ? 'Claude Max (the whole account: any other use of it counts)' : 'MiniMax (token plan)';
    if (!g.known) return '| ' + name + ' | ' + (isNum(g.usedPct) ? f1(g.usedPct) + '% (old reading)' : 'unknown') + ' | — | — | — | — | **Closed**: ' + g.why + ' |';
    return '| ' + name + ' | ' + f1(g.usedPct) + '% | ' + g.day + ' of 7, until ' + hm(g.dayEnds) + ' | ' + f1(g.line) + '%' + (g.emergencyOpened || (m0(g) && g.line !== g.normalLine) ? ' (emergency; normally ' + f1(g.normalLine) + '%)' : '') + ' | '
      + (g.usedToday == null ? 'not measured yet' : f1(g.usedToday) + ' points') + ' | ' + f1(g.left) + ' points (' + f1(g.sharesLeft) + ' days\' share) | ' + (g.open ? '**Open**' : '**Closed**: ' + g.why) + ' |';
  }
  const m0 = g => isNum(g.line) && isNum(g.normalLine);
  function statusText(m) {
    const L = [];
    L.push('AI usage pacer — mode ' + m.mode + (m.live ? ' (switches routines)' : ' (measures and plans; changes nothing)') + ' — ' + when(m.at));
    for (const g of [m.claude, m.minimax]) {
      L.push('');
      L.push(g.label + ': ' + (g.open ? 'OPEN to routines' : 'CLOSED to routines') + ' — ' + g.why);
      if (g.known) {
        L.push('  week ' + f1(g.usedPct) + '% used; day ' + g.day + ' of 7 (its week ' + when(g.weekStart) + ' to ' + when(g.weekEnd) + '); today\'s line ' + f1(g.line) + '% (margin ' + margin + '), left under it ' + f1(g.left) + ' points = ' + f1(g.sharesLeft) + ' days\' share');
        L.push('  used since today began: ' + (g.usedToday == null ? 'not measured yet (the pacer has no reading from the start of today)' : f1(g.usedToday) + ' points'));
        if (!g.open && g.nextOpen) L.push('  if use stayed flat it would open ' + when(g.nextOpen.at) + ' (day ' + g.nextOpen.day + ', line ' + f1(g.nextOpen.line) + '%)');
        if (!g.open && !g.nextOpen && !g.hard) L.push('  it stays over the line for the rest of this week; the week resets ' + when(g.weekEnd));
      }
      if (g.source) L.push('  reading: ' + g.source + ', ' + age(g.at, m.at) + ' old' + (g.picked ? ' (' + g.picked + ')' : '') + (g.raised ? '; raised from ' + f1(g.raised.from) + '% to the ' + f1(g.usedPct) + '% the pacer saw at ' + hm(g.raised.at) + ' (the weekly meter only rises)' : '')
        + (g.key === 'claude' && g.others && g.others.length ? '; also ' + g.others.map(o => o.source + ' ' + f1(o.usedPct) + '% (' + age(o.at, m.at) + ' old)').join(', ') : ''));
      if (g.key === 'claude') L.push('  5-hour window: ' + (g.fiveHour ? f1(g.fiveHour.usedPct) + '% used (closes at ' + policy.claude.fiveHourCloseAtUsedPct + '%)' : 'not reported'));
      if (g.key === 'claude' && g.overage && g.overage.status === 'rejected') L.push('  extra usage past the plan: off' + (g.overage.why ? ' (' + g.overage.why + ')' : '') + '; runs inside the plan are not affected');
      if (g.key === 'claude' && g.modelWeeks && g.modelWeeks.length) L.push('  per-model weeks: ' + g.modelWeeks.map(w => w.model + ' ' + (w.usedPct == null ? '?' : f1(w.usedPct) + '%') + (w.status === 'rejected' ? ' (refused: that model only)' : '')).join(', '));
      if (g.key === 'claude' && g.meterCheck) L.push('  meter check: ' + (g.meterCheck.pending ? 'sent ' + hm(g.meterCheck.at) + ', waiting for the answer' : 'last sent ' + hm(g.meterCheck.at) + ', ' + (g.meterCheck.outcome === 'ok' ? 'answered' : g.meterCheck.outcome === 'usage-limit' ? 'refused for usage' : 'failed' + (g.meterCheck.why ? ' (' + g.meterCheck.why + ')' : ''))));
      if (g.key === 'minimax') L.push('  5-hour window: ' + (isNum(g.fiveHourLeftPct) ? f1(g.fiveHourLeftPct) + '% left, resets ' + hm(g.fiveHourEnd) : 'unknown') + (g.lastError ? '; last call: ' + g.lastError : ''));
    }
    L.push('');
    L.push('DeepSeek V4.1 Flash: pay-per-use, prepaid by the owner. ' + (m.deepseek.open ? 'OPEN — ' : 'CLOSED — ') + m.deepseek.why + '. ' + railWords(m) + (m.rail.pressure ? ' HOLDING NOW.' : ''));
    L.push('Emergency: ' + (m.emergency.active ? 'ON by ' + m.emergency.by + ' until ' + when(m.emergency.until) + ' — ' + m.emergency.why + ' (line ' + m.emergency.ceilingPct + '%)' : m.emergency.invalid ? 'none (company/state/emergency.json claims one, but ' + m.emergency.invalid + ', so it is ignored)' : 'none'));
    L.push('Per-tick limit: ' + (m.boost.on ? 'up to ' + m.boost.max + ' when the extra loop would run on a subscription with room (' + m.boost.why + ')' : 'unchanged (' + m.boost.why + ')') + (m.live ? '' : '; in shadow the dispatcher keeps its own limit'));
    L.push('Serious-flag link: ' + (m.serious.available ? (m.serious.total || 0) + ' confirmed S0/S1 flag(s) in competence.json, ' + m.serious.flags.length + ' from the last 24 hours' : m.serious.why));
    const pre = preLive(m);
    if (pre.length) { L.push('Before going live:'); for (const x of pre) L.push('  - ' + x); }
    for (const p of m.problems) L.push('Problem: ' + p);
    return L.join('\n');
  }
  // the rail in plain words: percentages and times only, never dollars (the owner pays DeepSeek)
  function railWords(m) {
    const r = m.rail, pj = r.projection;
    if (r.none) return 'DeepSeek rail: NOT ARMED (station caps.perDay is 0 — nothing is capped), so nothing here holds a DeepSeek wake-up for the rail.';
    if (r.dayNull) return 'The station\'s daily rail is armed at its own caps.perDay; station day total is null (accounting UNSETTLED_SPEND), so the percentage covers in-flight runs only (currently ' + f1(r.pct) + '%). From ' + r.holdAtPct + '% the dispatcher would hold DeepSeek wake-ups with no handoff due today and the pacer would pause scheduled routines from ' + r.pauseAtPct + '% (live mode only); neither can see a settled day.';
    let s = 'The station\'s daily rail is ' + Math.round(r.pct) + '% used' + (r.known ? '' : ' (estimate: ' + r.source + ')') + '. From ' + r.holdAtPct + '% the dispatcher holds DeepSeek wake-ups with no handoff due today; from ' + r.pauseAtPct + '% the pacer also pauses scheduled DeepSeek routines with no handoff due today and resumes them under ' + r.resumeBelowPct + '% (live mode only).';
    if (pj) s += ' At the last ' + pj.fromHours + ' hours\' pace (about ' + f1(pj.pctPerHour) + '% of the rail an hour) it would ' + (pj.tripAt ? 'reach ' + r.holdAtPct + '% around ' + when(pj.holdAt) + ' and trip around ' + when(pj.tripAt) + (m.live ? '' : ', and in shadow mode nothing holds it') + '.' : pj.holdAt ? 'reach ' + r.holdAtPct + '% around ' + when(pj.holdAt) + ' and not trip within 24 hours.' : 'stay under ' + r.holdAtPct + '% for the next 24 hours.');
    return s;
  }
  // what to settle before mode "live"; empty when nothing is left
  function preLive(m) {
    const out = [];
    const k = m.knobs || {};
    if (k.maxUnpricedTokens === 0 && k.minimaxCredits !== false) out.push('MiniMax runs have no per-run token ceiling (station setting maxUnpricedTokens is 0 in .starnet-data/workspaces/runtime.knobs.json), and MiniMax bills Credits once the plan runs out: set a ceiling of about 6–8M tokens first, or record that the account holds no Credits (company.json providers.minimax.credits: false; a run past the plan is then refused, never billed)');
    return out;
  }
  function planText(m, pl) {
    const L = [statusText(m), '', 'Routing (' + (m.live ? 'live' : 'shadow: nothing is changed') + '):'];
    const w = Math.max(...pl.rows.map(r => r.name.length), 10);
    for (const r of pl.rows) {
      const act = r.action === 'stay' ? 'stays' : r.action === 'switch' ? (m.live ? 'SWITCH' : 'would switch') : 'waits (' + r.wait + ')';
      L.push('  ' + r.name.padEnd(w) + '  ' + (r.now.provider + '/' + r.now.model).padEnd(36) + (r.action === 'stay' ? '' : ' -> ' + r.to.provider + '/' + r.to.model) + '  ' + act + (r.urgent ? ' [now: ' + r.urgent + ']' : ''));
      L.push('  ' + ''.padEnd(w) + '  why: ' + r.why);
    }
    for (const u of pl.untouched) L.push('  ' + u.name.padEnd(w) + '  ' + u.now.provider + '/' + u.now.model + '  not in the routing table: left alone');
    for (const f of pl.refires) L.push('  re-fire "' + f.name + '" after a refusal on ' + f.provider + ': ' + f.status);
    const rp = pl.rail || {};
    for (const p of rp.pause || []) L.push('  ' + (m.live ? 'PAUSE' : 'would pause') + ' "' + p.name + '": ' + p.why);
    for (const p of rp.spared || []) L.push('  not paused "' + p.name + '": ' + p.why);
    for (const p of rp.resume || []) L.push('  ' + (m.live ? 'RESUME' : 'resumes') + ' "' + p.name + '" (paused by the pacer): ' + p.why);
    for (const p of rp.keep || []) L.push('  stays paused "' + p.name + '" (paused by the pacer for the rail)');
    const blocks = (pl.blocks || []);
    if (blocks.length) { L.push('Blocks:'); for (const b of blocks) L.push('  ' + (b.trial ? b.model + ' (a trial model) left out of trials' : (NAMES[b.provider] || b.provider) + ' blocked') + ' for "' + b.name + '" until ' + when(b.until) + ' (its run at ' + hm(b.at) + ' on ' + b.model + ' ended ' + b.code + ')'); }
    for (const [k, c] of Object.entries(pl.closures || {})) L.push('  ' + (k === 'claude' ? 'Claude' : 'MiniMax') + ' closed to routines until ' + when(c.until) + ': ' + c.why);
    for (const p of pl.problems) L.push('Routing problem: ' + p);
    return L.join('\n');
  }
  function writeReport(m, pl, st, x) {
    x = x || {};
    const t = m.at;
    const L = [];
    L.push('# AI usage');
    L.push('');
    L.push('Written by `company/tools/pacer.js` on ' + when(t) + '. Mode: **' + m.mode + '**' + (m.live ? ' (it switches routine models).' : ' — it measures, plans and reports, and changes nothing on the station yet.'));
    L.push('');
    L.push('**The rule**: use the subscriptions as much as possible, but each one may use at most ' + policy.dailyFractionText + ' of its weekly limit per day. Days count from the start of that subscription\'s own week, and unused share carries forward, so on day k the week\'s use may reach k × ' + f1(share) + '% minus a ' + margin + '-point margin ("today\'s line"). An emergency lifts the line to ' + policy.emergency.ceilingPct + '%. The Claude meter is the whole account (any other use of it counts), so company routines get Claude only while the whole account is under the line' + (policy.claude.shareOfAccount < 1 || policy.minimax.shareOfAccount < 1 ? '; this company\'s line is scaled to its share of the account (Claude ' + policy.claude.shareOfAccount + ', MiniMax ' + policy.minimax.shareOfAccount + ')' : '') + '. DeepSeek V4.1 Flash is the pay-per-use fallback. Numbers: `company/work/finance/pacing-policy.json` (the finance seat). Routing table: `company/model-policy.json` (the people seat).');
    L.push('');
    L.push('## Meters');
    L.push('');
    L.push('| Subscription | Week used | Day of its week | Today\'s line | Used since today began | Left under the line | Routines |');
    L.push('|---|---|---|---|---|---|---|');
    L.push(meterRow(m.claude));
    L.push(meterRow(m.minimax));
    L.push('');
    const src = g => g.source ? g.source + ', ' + age(g.at, t) + ' old' : 'none';
    L.push('- Claude reading: ' + src(m.claude) + (m.claude.picked ? ' (' + m.claude.picked + ')' : '') + (m.claude.raised ? ', raised from ' + f1(m.claude.raised.from) + '% to what the pacer saw at ' + hm(m.claude.raised.at) : '') + '. 5-hour window: ' + (m.claude.fiveHour ? f1(m.claude.fiveHour.usedPct) + '% used' : 'not reported') + '.' + (m.claude.nextOpen && !m.claude.open ? ' If use stayed flat, Claude would reopen to routines on ' + when(m.claude.nextOpen.at) + ' (line ' + f1(m.claude.nextOpen.line) + '%).' : ''));
    L.push('- MiniMax reading: ' + src(m.minimax) + '. 5-hour window: ' + (isNum(m.minimax.fiveHourLeftPct) ? f1(m.minimax.fiveHourLeftPct) + '% left (closes under ' + policy.minimax.fiveHourCloseBelowLeftPct + '%)' : 'unknown') + '. Its week ends ' + when(m.minimax.weekEnd) + '.');
    L.push('- DeepSeek (paid by the owner; no costs are reported here): ' + railWords(m).replace(/^The station's daily rail/, 'the station\'s daily safety rail') + (m.rail.pressure ? ' **Holding now.**' : ''));
    L.push('- Dispatcher per-tick limit: ' + (m.boost.on ? (m.live ? 'up to ' + m.boost.max : 'would be up to ' + m.boost.max + ' in live mode') + ', and only when the extra loop runs on a subscription with room (this tick: ' + (x.lend ? 'yes' : 'no') + ') — ' + m.boost.why : (x.maxPerTick || 2) + ' — ' + m.boost.why) + '.');
    if (x.holds && x.holds.length) L.push('- ' + (m.live ? 'Held' : 'Would hold') + ' this tick: ' + x.holds.map(h => h.loop + ' (' + h.name + ')').join(', ') + '.');
    const rp = pl.rail || {};
    if ((rp.pause || []).length) L.push('- ' + (m.live ? 'Paused' : 'Would pause') + ' for the rail: ' + rp.pause.map(p => p.name).join(', ') + '.');
    const pausedNow = Object.values(st.railPaused || {});
    if (pausedNow.length) L.push('- Paused by the pacer for the rail right now: ' + pausedNow.map(p => p.name + ' (since ' + hm(p.at) + ')').join(', ') + '.');
    L.push('');
    L.push('## Routing');
    L.push('');
    L.push('Each routine runs on its Claude tier while Claude is open, else on MiniMax if it may and MiniMax is open, else on DeepSeek. A routine never switches while it runs; it moves onto a subscription at most once an hour (and at most ' + policy.routing.maxOntoSubscriptionPerHour + ' routines an hour in all), and off a subscription that has closed at once. Opus and Fable never run routines.');
    L.push('');
    L.push('| Routine | Runs on now | Pacer\'s choice | What happens | Why |');
    L.push('|---|---|---|---|---|');
    for (const r of pl.rows) {
      const act = r.action === 'stay' ? 'stays' : r.action === 'switch' ? (m.live ? '**switches**' : 'would switch (shadow)') : 'waits: ' + r.wait;
      L.push('| ' + r.name.replace(/\|/g, '/') + ' | ' + r.now.provider + '/' + r.now.model + ' | ' + r.to.provider + '/' + r.to.model + ' | ' + act + ' | ' + r.why.replace(/\|/g, '/') + (r.emergency ? ' (emergency)' : '') + ' |');
    }
    for (const u of pl.untouched) L.push('| ' + u.name.replace(/\|/g, '/') + ' | ' + u.now.provider + '/' + u.now.model + ' | — | left alone | not in the routing table |');
    const recent = Object.entries(st.routines || {}).filter(([, v]) => v && t - v.lastSwitchAt < DAY).sort((a, b) => b[1].lastSwitchAt - a[1].lastSwitchAt).slice(0, 12);
    if (recent.length) { L.push(''); L.push('Switches in the last 24 hours:'); for (const [id, v] of recent) { const row = pl.rows.find(r => r.id === id); L.push('- ' + hm(v.lastSwitchAt) + ' ' + (row ? row.name : id) + ': ' + v.from.provider + '/' + v.from.model + ' → ' + v.to.provider + '/' + v.to.model + (v.emergency ? ' (emergency)' : '')); } }
    L.push('');
    L.push('## Blocks and closures');
    L.push('');
    const blocks = (st.blocks || []).filter(b => b.until > t);
    if (!blocks.length && !Object.keys(st.closures || {}).length) L.push('None.');
    for (const b of blocks) L.push('- ' + (b.trial ? b.model + ' (a trial model) is left out of trials' : (NAMES[b.provider] || b.provider) + ' is blocked') + ' for "' + b.name + '" until ' + when(b.until) + ': its run at ' + hm(b.at) + ' on ' + b.model + ' ended ' + b.code + '.');
    for (const [k, c] of Object.entries(st.closures || {})) L.push('- ' + (k === 'claude' ? 'Claude' : 'MiniMax') + ' is closed to routines until ' + when(c.until) + ': ' + c.why + '.');
    for (const f of pl.refires) L.push('- Re-fire of "' + f.name + '" after its refusal: ' + f.status + '.');
    L.push('');
    L.push('## Emergencies');
    L.push('');
    L.push(m.emergency.active ? '**On** since ' + when(Date.parse(m.emergency.since)) + ' by ' + m.emergency.by + ', until ' + when(m.emergency.until) + ': ' + m.emergency.why + '. The line is ' + m.emergency.ceilingPct + '% while it lasts.' : 'None active. ' + allowedWords() + ' can start one for up to ' + policy.emergency.maxHours + ' hours: `node company/tools/pacer.js emergency on --why "..." --by <name> --hours 4`.');
    if (m.emergency.invalid) L.push('\n**Ignored:** `company/state/emergency.json` says an emergency is on, but ' + m.emergency.invalid + '. Only `pacer.js emergency on` (' + allowedWords() + ', at most ' + policy.emergency.maxHours + ' hours) starts one.');
    const hist = readJournal(e => /^emergency/.test(e.kind)).slice(-8);
    if (hist.length) { L.push(''); for (const e of hist) L.push('- ' + stamp(Date.parse(e.at)) + ' ' + e.kind.replace('emergency-', '') + (e.by ? ' by ' + e.by : '') + (e.hours ? ' for ' + e.hours + ' h' : '') + (e.why ? ': ' + String(e.why).slice(0, 140) : '') + (e.routine ? ': ' + e.routine + ' on ' + e.to.provider : '')); }
    L.push('');
    if (!m.live) {
      L.push('## Going live');
      L.push('');
      L.push('The finance seat (' + co.nameOf(co.seatFor('finance')) + ') sets `"mode": "live"` in `company/work/finance/pacing-policy.json`. From the next dispatcher tick the pacer switches routine models (at most ' + policy.routing.maxOntoSubscriptionPerHour + ' onto a subscription an hour), holds DeepSeek wake-ups and pauses scheduled DeepSeek routines near the rail, and lends the dispatcher its third slot.');
      const pre = preLive(m);
      if (pre.length) { L.push(''); L.push('Settle first:'); for (const p of pre) L.push('- ' + p.charAt(0).toUpperCase() + p.slice(1) + '.'); }
      L.push('');
    }
    L.push('## Stopping it');
    L.push('');
    L.push('Setting the mode back to `"shadow"` stops further changes (and lifts any rail pause the pacer made), but routines stay on the model the pacer last gave them, a Claude tier included. To put every routine back where it was before the pacer moved it, also run `node company/tools/pacer.js restore`.');
    L.push('');
    for (const p of m.problems.concat(pl.problems)) L.push('- Problem: ' + p);
    writeTextAtomic(P('report'), L.join('\n').replace(/\n+$/, '') + '\n');
    return P('report');
  }
  function readJournal(filter) {
    let txt = ''; try { txt = fs.readFileSync(P('journal'), 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const l of txt.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (!filter || filter(e)) out.push(e); } catch (_) {} }
    return out;
  }

  return { policy, live, dry, readOnly, root, loadState, saveState, saveMiniMax, withLock, getJobs, measure, plan, apply, restore, hook, emergencyOn, emergencyOff, emergencyHousekeeping,
    writeReport, statusText, planText, readClaude, readEmergency, readJournal, meterCheckRun, meterCheckDone: () => meterCheckP };
}

/* ---------- the dispatcher hook: fail-safe ---------- */
// dispatch.js: `fired = -extra` after this resolves; any throw is caught there. The race below guarantees an answer.
async function dispatchHook(a) {
  a = a || {};
  let timer;
  const limitMs = numOr(a.timeoutMs, HOOK_TIMEOUT_MS, 1, HOOK_TIMEOUT_MS);   // tests shorten it; nobody lengthens it
  const timeout = new Promise(res => { timer = setTimeout(() => { a.late = true; res({ extra: 0, timeout: true }); }, limitMs); });   // a late hook changes nothing
  let r;
  try {
    // a.pacer: test seam only (a fake station, clock and root); dispatch.js never passes it
    const run = Promise.resolve().then(() => makePacer(Object.assign({ dry: !!a.dry, log: a.log }, a.pacer || {})).hook(a))
      .catch(e => { if (typeof a.log === 'function') a.log('PACER ERROR: ' + String((e && e.message) || e).slice(0, 200)); return { extra: 0 }; });
    r = await Promise.race([run, timeout]);
  } finally { clearTimeout(timer); }
  if (r && r.timeout && typeof a.log === 'function') a.log('PACER TIMEOUT: no answer in ' + (limitMs < 10000 ? (limitMs / 1000).toFixed(1) : Math.round(limitMs / 1000)) + ' s; this tick runs without the pacer');
  return r || { extra: 0 };
}

/* ---------- command line ---------- */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) { const k = s.slice(2); const v = argv[i + 1]; if (v != null && !v.startsWith('--')) { a[k] = v; i++; } else a[k] = true; }
    else a._.push(s);
  }
  return a;
}
async function cli(argv, o) {
  o = o || {};
  const print = o.print || (s => console.log(s));
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));
  // status, plan and report only look: they keep no log lines, use up no event and move no clock (readOnly); the
  // MiniMax reading they may fetch is saved so the 10-minute call limit holds. apply and restore act, under the lock.
  const looking = cmd === 'status' || cmd === 'plan' || cmd === 'report' || cmd === 'limits';
  const pz = makePacer(Object.assign({}, o, { dry: false, readOnly: looking }));
  if (cmd === 'meter-check') {
    // meter-check [--at <ms>]: the pacer's own stale-meter check, started detached by a tick (meterCheckTick); runs the
    // pending check once and writes its answer to company/state/claude-meter-check.json
    const r = await pz.meterCheckRun(Number(a.at) || null); print(JSON.stringify(r)); return 0;
  }
  const readJobs = async () => { try { return await pz.getJobs(); } catch (e) { print('(could not read routines from the station: ' + e.message + ')'); return []; } };
  if (looking) {
    const jobs = await readJobs();
    let r = await pz.withLock(async () => { const st = pz.loadState(); const m = await pz.measure(st, jobs); pz.saveMiniMax(st); return { st, m }; }, 3000);
    if (r.busy) {   // a dispatcher tick holds the state: use its cached reading, call nothing, save nothing
      const st = pz.loadState(); r = { value: { st, m: await pz.measure(st, jobs, { fetch: false }) } };
      print('(a dispatcher tick is running: this uses the cached MiniMax reading)');
    }
    const { st, m } = r.value;
    const pl = pz.plan(m, st, jobs);
    if (cmd === 'report') pz.writeReport(m, pl, st, {});
    if (cmd === 'limits') { const v = require('./lib/pacing-ask.js').view(m, pl, jobs, o.root || DEFAULT_ROOT); print(a.json ? JSON.stringify(v, null, 1) : Object.entries(v).filter(([k]) => k !== 'level').map(([, x]) => x.name + ': ' + (x.usedPct == null ? '?' : Math.round(x.usedPct * 10) / 10) + '% used, weekly stop ' + x.weekStop + '%, use-now ' + x.useNow + '%, affected: ' + (x.affected.join(', ') || 'none')).join('\n')); return 0; }
    if (a.json) { print(JSON.stringify(cmd === 'status' ? m : { measure: m, plan: pl }, null, 1)); return 0; }
    if (cmd === 'status') print(pz.statusText(m));
    else if (cmd === 'plan') print(pz.planText(m, pl));
    else print('wrote ' + REL.report);
    return 0;
  }
  if (cmd === 'apply' || cmd === 'restore') {
    const jobs = await readJobs();
    const r = await pz.withLock(async () => {
      const st = pz.loadState();
      if (cmd === 'restore') { const done = await pz.restore(st, jobs); pz.saveState(st); return { done }; }
      const m = await pz.measure(st, jobs);
      pz.emergencyHousekeeping(m, st);
      const pl = pz.plan(m, st, jobs);
      const done = await pz.apply(m, pl, st, jobs);
      pz.saveState(st);
      pz.writeReport(m, pl, st, {});
      return { m, pl, done };
    }, 10000);
    if (r.busy) { print('A dispatcher tick holds company/state/pacer-state.json; nothing was done. Try again in a minute.'); return 3; }
    const { m, pl, done } = r.value;
    if (cmd === 'restore') {
      if (a.json) { print(JSON.stringify(done, null, 1)); return 0; }
      if (!done.length) print('Nothing to restore: the pacer has not moved or paused any routine.');
      for (const d of done) print((d.applied ? 'ok   ' : 'NOT  ') + (d.name || d.id || '') + (d.resume ? ': resumed (the pacer had paused it)' : d.to ? ': back on ' + d.to.provider + '/' + d.to.model : '') + (d.note ? ' (' + d.note + ')' : '') + (d.error ? ' — ' + d.error : ''));
      return done.some(d => !d.applied) ? 1 : 0;
    }
    if (a.json) { print(JSON.stringify({ measure: m, plan: pl, applied: done }, null, 1)); return 0; }
    print(pz.planText(m, pl));
    print('');
    const n = f => done.filter(f).length;
    if (!pz.live) print('Mode ' + m.mode + ': nothing was changed' + (n(d => d.resume && d.applied) ? ' except lifting ' + n(d => d.resume && d.applied) + ' rail pause(s) the pacer had made' : '') + '. In live mode it would make ' + n(d => !d.refire && !d.pause && !d.resume) + ' switch(es), ' + n(d => d.refire) + ' re-fire(s) and ' + n(d => d.pause) + ' rail pause(s).');
    else print('Applied: ' + (done.filter(d => d.applied).map(d => (d.refire ? 're-fired ' : d.pause ? 'paused ' : d.resume ? 'resumed ' : 'switched ') + d.name).join(', ') || 'nothing to change') + (done.some(d => !d.applied) ? '; not done: ' + done.filter(d => !d.applied).map(d => d.name).join(', ') : '') + '.');
    return 0;
  }
  if (cmd === 'emergency') {
    const sub = a._[0];
    const r = sub === 'on' ? pz.emergencyOn({ why: a.why === true ? '' : a.why, by: a.by === true ? '' : a.by, hours: a.hours })
      : sub === 'off' ? pz.emergencyOff({ by: a.by === true ? '' : a.by, why: a.why === true ? '' : a.why })
      : { ok: false, error: 'emergency on --why "..." --by <name> --hours N (at most ' + pz.policy.emergency.maxHours + '), or emergency off --by <Name>' };
    print(JSON.stringify(r, null, 1));
    return r.ok ? 0 : 2;
  }
  if (cmd === 'mode') {
    // live|shadow: the one way to switch the pacer, so the change is recorded (provenance, dispatch log) and never a
    // hand edit of pacing-policy.json, which locked-watch would flag. Who: the owner, the CEO, the finance or people seat.
    const co = require('./lib/company');
    const want = a._[0]; const by = a.by === true ? '' : (a.by || ''); const why = a.why === true ? '' : (a.why || '');
    if (!['live', 'shadow'].includes(want) || !by || !why) { print('usage: pacer.js mode live|shadow --by <Name> --why "..."'); return 2; }
    const allowed = [co.config.owner && co.config.owner.name, co.nameOf(co.ceo()), co.nameOf(co.seatFor('finance')), co.nameOf(co.seatFor('people'))].filter(Boolean).map(x => x.toLowerCase());
    if (!allowed.includes(by.toLowerCase())) { print('refused: ' + by + ' may not switch the pacer (the owner, the CEO, the finance or the people seat may)'); return 3; }
    const root = (o.root || co.ROOT); const f = path.join(root, REL.policy);
    let pol = {}; try { pol = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { try { pol = JSON.parse(fs.readFileSync(path.join(root, REL.policyDefault), 'utf8')); } catch (_) {} }
    const was = pol.mode === 'live' ? 'live' : 'shadow';
    if (was === want) { print('the pacer is already ' + want); return 0; }
    pol.mode = want; pol.changes = (pol.changes || []).concat([{ at: new Date().toISOString(), by, what: 'mode ' + was + ' -> ' + want, why }]).slice(-50);
    const txt = JSON.stringify(pol, null, 1) + '\n'; fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
    try { require('./provenance.js').wrote(f, txt, 'pacer.js'); } catch (_) {}
    try { const lf = path.join(root, 'company', 'work', 'dispatch-log.md'); fs.appendFileSync(lf, '- ' + (lp => lp.date + ' ' + lp.time)(co.localParts()) + ' PACER MODE ' + was + ' -> ' + want + ' by ' + by + ': ' + why + '\n'); } catch (_) {}
    print('pacer mode ' + was + ' -> ' + want + ' (recorded)'); return 0;
  }
  if (cmd === 'reopen') {
    // reopen claude|minimax --by owner [--why "..."]: the owner says the subscription has room again (extra usage, a plan
    // change). It clears the usage-limit closure; the next run reads the meter afresh, and the provider's own refusal
    // closes it again by itself if it is really full.
    const root = o.root || DEFAULT_ROOT;
    const which = String(a._[0] || '').toLowerCase(); const by = a.by === true ? '' : (a.by || ''); const why = a.why === true ? '' : String(a.why || '');
    if (!/^(claude|minimax)$/.test(which) || !by) { print('usage: pacer.js reopen claude|minimax --by owner [--why "..."]'); return 2; }
    const OW = require('./lib/owner');
    if (!((o.ownerShell ? o.ownerShell() : OW.shell()) && OW.isOwnerName(by, root))) { print(JSON.stringify({ ok: false, error: 'reopening a subscription is the owner\'s: --by owner, from the owner\'s own shell or the console' }, null, 1)); return 3; }
    const lk = await pz.withLock(async () => {
      const st = pz.loadState(); const t = (o.now ? o.now() : Date.now());
      const was = (st.closures || {})[which] || null;
      if (st.closures) delete st.closures[which];
      st.reopened = Object.assign({}, st.reopened || {}, { [which]: { at: t, by, why: why || null, was } });
      pz.saveState(st);
      return { ok: true, reopened: which, was };
    }, 5000);
    print(JSON.stringify(lk, null, 1)); return lk && lk.ok ? 0 : 1;
  }
  if (cmd === 'unblock') {
    // unblock <seat|routine> --by owner [--why "..."]: the owner clears a refusal block (the one record, pacer-state
    // blocks): kept as cleared (who, when, why), the seat moves back on the next tick, its manager is told
    const co = require('./lib/company'); const root = o.root || DEFAULT_ROOT;
    const target = String(a._[0] || ''); const by = a.by === true ? '' : (a.by || ''); const why = a.why === true ? '' : String(a.why || '');
    if (!target || !by) { print('usage: pacer.js unblock <seat|routine> --by owner [--why "..."]'); return 2; }
    const OW = require('./lib/owner');
    const ownerOk = (o.ownerShell ? o.ownerShell() : OW.shell()) && OW.isOwnerName(by, root);
    if (!ownerOk) { print(JSON.stringify({ ok: false, error: 'clearing a refusal block is the owner\'s: --by owner, from the owner\'s own shell or the console' }, null, 1)); return 3; }
    const jobs = o.jobs || await pz.getJobs();
    const crew = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'company', 'tools', 'loops.json'), 'utf8')).agents || {}; } catch (_) { return {}; } })();
    const seatId = crew[target] ? target : Object.keys(crew).find(k => String((crew[k] || {}).name || '').toLowerCase() === target.toLowerCase()) || null;
    const ids = new Set(seatId ? (jobs || []).filter(j => j.agentId === seatId).map(j => j.id) : (jobs || []).filter(j => j.id === target || j.name === target).map(j => j.id).concat([target]));
    const lk = await pz.withLock(async () => {
      const st = pz.loadState(); const t = (o.now ? o.now() : Date.now());
      const hit = (st.blocks || []).filter(b => b && ids.has(b.routineId) && !b.clearedAt && Number(b.until) > t);
      if (!hit.length) return { ok: true, cleared: 0, note: 'no active refusal block for ' + target };
      for (const b of hit) Object.assign(b, { clearedAt: t, clearedBy: by, clearedWhy: why || null });
      st.blocks = (st.blocks || []).filter(b => !b.clearedAt); st.clearedBlocks = (st.clearedBlocks || []).concat(hit).slice(-100);
      pz.saveState(st);
      return { ok: true, cleared: hit.length, blocks: hit, seat: seatId || (jobs.find(j => ids.has(j.id)) || {}).agentId || null };
    }, 5000);
    const r = lk && lk.value;
    if (!r || !r.ok || !r.cleared) { print(JSON.stringify(r || { ok: false, error: 'the pacer is busy; try again in a minute' }, null, 1)); return r && r.ok ? 0 : 1; }
    const seat = r.seat; const names = [...new Set(r.blocks.map(b => b.provider))];
    // the seat moves back on the next tick without the usual recovery wait (models.js reads ownerCleared once)
    try { const f = path.join(root, 'company', 'state', 'models-state.json'); const ms = JSON.parse(fs.readFileSync(f, 'utf8') || '{}'); ms.seats = ms.seats || {}; const ss = ms.seats[seat] = ms.seats[seat] || { okSince: {} };
      ss.ownerCleared = { at: new Date().toISOString(), by, why: why || null, providers: names }; const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(ms, null, 1) + '\n'); fs.renameSync(tmp, f); } catch (_) {
      try { const f = path.join(root, 'company', 'state', 'models-state.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ v: 1, seats: { [seat]: { okSince: {}, ownerCleared: { at: new Date().toISOString(), by, why: why || null, providers: names } } } }, null, 1) + '\n'); } catch (_) {} }
    const seatName = (crew[seat] || {}).name || seat; const lp = co.localParts();
    const line = 'REFUSAL BLOCK CLEARED for ' + seatName + ' (' + names.map(p => NAMES[p] || p).join(', ') + ') by ' + by + (why ? ': ' + why : '') + '; it runs on its primary again from the next check';
    try { fs.appendFileSync(path.join(root, 'company', 'work', 'dispatch-log.md'), '- ' + lp.date + ' ' + lp.time + ' ' + line + '\n'); } catch (_) {}
    // recorded as this tool's own append (provenance), or locked-watch strips the line as an unknown writer's
    try { const f = path.join(root, 'company', 'state', 'pacer-log.jsonl'); const line = JSON.stringify({ at: new Date().toISOString(), event: 'unblock', seat, by, why: why || null, blocks: r.blocks.map(b => ({ routineId: b.routineId, provider: b.provider, model: b.model || null, until: b.until })) }) + '\n'; fs.appendFileSync(f, line); try { require('./provenance.js').appended(f, line, 'pacer.js'); } catch (_) {} } catch (_) {}
    // the seat's manager is told (an FYI handoff in their inbox)
    try {
      const mgr = (crew[seat] || {}).manager || null; const mi = mgr && crew[mgr] && crew[mgr].inbox;
      if (mi) require('./lib/tool-blocks').append(path.join(root, 'company', 'work', 'handoffs', mi), '\n## ' + lp.date + ' ' + lp.time + ' from the pacer — the owner cleared ' + seatName + '\'s refusal block\n**Need:** nothing; for your information. ' + line + '.\n**Why:** the owner chose to let ' + seatName + ' run on ' + names.map(p => NAMES[p] || p).join(', ') + ' again.\n**Deadline:** today\n**Status:** DONE — for your information\n', { root });   // recorded (lib/tool-blocks.js): a tool's own block, never held as a member's message
    } catch (_) {}
    print(JSON.stringify({ ok: true, cleared: r.cleared, seat, providers: names, line }, null, 1)); return 0;
  }
  if (cmd === 'limit') {
    // limit claude|minimax [--week-stop N] [--use-now N] --by <Name> --why "...": the recorded way to set a subscription
    // cutoff (lib/pacing-ask.js setLimit: provenance, changes[], dispatch log); the owner's answers on Today use it too
    const PA = require('./lib/pacing-ask.js'); const root = o.root || DEFAULT_ROOT;
    const key = String(a._[0] || '').toLowerCase(); const by = a.by === true ? '' : (a.by || ''); const why = a.why === true ? '' : (a.why || '');
    if (!PA.SUBS[key] || !by || !why) { print('usage: pacer.js limit claude|minimax [--week-stop N] [--use-now N] --by <Name> --why "..."'); return 2; }
    const no = PA.authorize(root, by, o.govOpts ? Object.assign({ root }, o.govOpts) : undefined);
    if (no) { print(JSON.stringify({ ok: false, error: no.error }, null, 1)); return no.code; }
    const r = PA.setLimit(root, key, { weekStop: a['week-stop'], useNow: a['use-now'], by, why, via: a.via && a.via !== true ? a.via : 'pacer.js limit' });
    if (r.ok && !/^(owner|commander)$/i.test(by) && by.toLowerCase() !== String((require('./lib/company').config.owner || {}).name || '').toLowerCase()) {
      try { if (gov.level('budget', Object.assign({ root }, o.govOpts || {})) === 'notify') { const n = limitNotice(by, PA.SUBS[key].name, r.what, why); gov.notify(n.text, { root, technical: n.technical }); } } catch (_) {}
    }
    print(JSON.stringify(r, null, 1)); return r.ok ? 0 : (r.code || 2);
  }
  print('commands: status [--json], plan [--json], report, limits [--json], apply, restore, meter-check, emergency on|off, mode live|shadow --by --why, limit claude|minimax --week-stop N --use-now N --by --why, unblock <seat|routine> --by owner [--why]');
  return 2;
}

module.exports = { ASKS, limitNotice, makePacer, dispatchHook, cli, loadPolicy, loadRouting, routingKeyFor, parseMiniMax, handoffsDueToday, minimaxFetch, dayOf, lineFor, nextOpenDay, DEFAULTS, REL };

if (require.main === module) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error('pacer error: ' + e.message); process.exitCode = 1; });
}
