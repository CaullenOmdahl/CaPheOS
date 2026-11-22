#!/usr/bin/env node
/* dispatcher — wakes the agent who owns open work.
 *
 * Why: the station's only scheduler is slow cron loops, so most agents run once a day or never and nothing wakes
 * them when work existed. This runs every 10 min (systemd user timer), costs nothing itself (no LLM), and fires an
 * agent's own loop routine via POST /api/cron/run when that agent owns an open quest with unfinished steps.
 *
 * Guards: per-agent cooldown, max dispatches per tick, per-quest stall limit (no step progress after N dispatches
 * => stop and flag for escalation), daily USD cap read from runs.jsonl, honours the station's one-run-per-routine lease.
 *
 *   node company/tools/dispatch.js            # one tick
 *   node company/tools/dispatch.js --dry-run  # show what it would do
 * Env: DISPATCH_COOLDOWN_MIN=40 DISPATCH_MAX_PER_TICK=4 DISPATCH_STALL_AFTER=3 DISPATCH_DAILY_USD=2
 *   (cooldown and per-tick defaults come from company/work/ops/cadence.json when present; the env vars still win)
 * Halt: every tick first runs company/tools/halt.js tick; while co.halted() is 'soft' or 'hard' nobody is woken.
 * Restart hold: while company/state/restart-hold.json holds (restart-station.js waiting for idle), nobody is woken either.
 * Modules: then each enabled core module's tick.js (lib/modules.js runTicks; halted: only runWhenHalted ones).
 * Guardrail spendCap (co.guard): when the owner turns it off, the USD caps hold nothing (one line says what they would have held).
 * Hiring: each tick runs hire.js advance --all (the mechanical steps of every open round, within the cap) and wakes the
 * seat that must pick once per round, past its cooldown; a seat hired this tick gets its first run in the same tick.
 *   node company/tools/dispatch.js --selftest # offline fixtures for the handoff reader
 *   node company/tools/dispatch.js --wake-links [--hours 168] [--json]   # offline: the share of DONE handoff items with a
 *     linked run (company/state/wakes.jsonl, one row per run this tick starts: seat, runId, door, the items it is for)
 * Delegation (lib/family.js): a child run a lead's team.dispatch started is the lead's family: its spend counts toward the
 * LEAD's per-agent share, never the worker's, and a worker with a child run in flight is busy (not woken, no lane).
 * Sprint (start-up, cadence.js tempo.sprint; docs/TEMPO.md): while it is on, a seat whose open work CHANGED since its
 * last wake (a new handoff or review, an owner message, quest progress) rests only the cooldown floor; unchanged work
 * keeps the normal cooldown and the stall rule, so nobody is woken for nothing. Every seat may wake in one tick and
 * the wake caps are lifted (cadence.js). The daily metered cap, the per-agent share, the halt, the guardrails and the
 * pacer's hook all run exactly as outside Sprint; in Sprint the metered cap is also spread over the company day
 * (lib/sprint.js spreadHold). The tick keeps the Sprint numbers (company/state/sprint-metrics.json: wakes, wakes that
 * did nothing, items done, lanes) and tells models.js which seats have only mechanical work (sprint-effort.json).
 * Duties (docs/DUTIES.md, lib/duty-runner.js): after the locked-file watch, the read-only duty checks registered in
 * company/tools/duties.js and the enabled modules' module.json run (no shell, allowlist env, 16 KB, per-tick cap). A due
 * result is the sixth source of work: the routed seat gets one OPEN handoff carrying the sanitized reason and is woken,
 * under the same stall rule, cooldown, caps, halt and Sprint rules; a result already covered by an OPEN handoff to that
 * seat or by its open quest wakes nobody. A broken or stale duty is flagged once to the tools owner. While halted only
 * the whileHalted duties (liveness) run.
 * Watched jobs (company/tools/notify-when.js, service.js --wake): the seventh source. Each completion row wakes the seats it
 * names once, past their rest (a failure too, labelled as one), and satisfies a `**Waiting on:** job:<id>` / `service:<name>`.
 * Waiting on / Not before / Start now: see notBeforeDeferrals below and company/HANDOFFS.md; company/state/parked.json
 * says what is parked and why, for the console.
 * One gate (docs/BUDGET.md, lib/admit.js): every run this tick starts goes through admit() first (door dispatch), which
 * in phase 1 always allows and records {door, seat, kind, decision, reason}; the money rules (cap, share, spread) are
 * lib/admit.js money(), the one copy lanes.js uses too. Scheduler (lib/scheduler.js, company.json runtime.scheduler):
 * "dispatcher" = this tick also starts each seat's DUE scheduled loop (cadence.json loopEvery, else the routine's own
 * schedule) under every rule a wake passes, keeps the crew's loop routines paused on the station (a loop found enabled is
 * paused again) and keeps the watchdog routine there; "station" (the default) = the station's scheduler fires the loops
 * and this tick wakes seats with work only, as before.
 * Counterpart sign-off (lib/signoff.js, docs/PROFILES.md): an eager seat's handoff that needs its counterpart's yes is held for its
 * receiver like Waiting on (live; shadow logs WOULD HOLD); profile trials past their end revert (profile.js tick); each wake row
 * carries the woken seat's profile version (wakes.jsonl profile).
 * Advisor leads (lib/consult.js, docs/DEPARTMENTS.md §5): with a department's advisor mode on, the tick opens a consult for a
 * member's stuck item (failed runs, REVISE rounds, idle wakes, a reopen), starts the lead's separate advise run for the
 * batched consults (admit door consult, on the lead model as a one-run override), keeps the item's holder from being woken
 * for it while its consult is open, and pauses the advice when the house ranking says it does not pay.
 * Accountable leads (lib/accountable.js, docs/DEPARTMENTS.md §8): with a department's accountable mode on, work sent straight to a
 * member is copied to its lead, a member's handed-back item waits for the lead's binding audit (a DONE without the lead's
 * accept goes back to OPEN), a member's handoff out of the department waits for the lead to pass it on, and the lead's
 * audit run starts on the department's fixed audit model (admit door audit; a shut model makes it wait, never another).
 * Router (lib/routing.js, docs/ROUTING.md): with a routing policy each wake's model decision (class rules, trial arm,
 * department route, tier cap, chain) is recorded on its wakes.jsonl row (route) and in routing-decisions.jsonl (a trial held by
 * the pacer: op trial-held / trial-unheld in routing-log.jsonl); it is passed as
 * the one-run override on POST /api/cron/run only when its mode is live and company/state/override-allow.json opens the
 * pair for the seat (a 403 from the station's gate re-runs it on the chain). No policy: the body is {id, detach}, as before.
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const co = require('./lib/company');
const ROOT = co.ROOT;
const HOST = co.STATION_URL;
let TOKEN_CACHE = null;   // read on first station call, so --selftest and --dry-run imports work without a token
const TOKEN = () => TOKEN_CACHE || (TOKEN_CACHE = co.stationToken());
const STATE = path.join(ROOT, 'company', 'work', 'dispatch-state.json');
const LOG = path.join(ROOT, 'company', 'work', 'dispatch-log.md');
const RUNS = path.join(ROOT, '.starnet-data', 'workspaces', 'runs.jsonl');
const ROSTER = path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json');
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
// Ageing: true when a seat has been deferred `after` or more ticks running (streak = state.deferStreak).
function isAged(streak, id, after) { return (Number((streak || {})[id]) || 0) >= after; }
// Cadence (company/tools/cadence.js): company/work/ops/cadence.json, else its default, else 40 / 4. Env vars override.
function tuning(env, cad) {
  const pos = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const c = cad || {};
  return { cooldownMin: pos(env.DISPATCH_COOLDOWN_MIN) || pos(c.defaultCooldownMin) || 40, maxPerTick: pos(env.DISPATCH_MAX_PER_TICK) || pos(c.maxPerTick) || 4 };
}
const CADENCE = co.readJson(co.p('company', 'work', 'ops', 'cadence.json'), null) || co.readJson(co.p('company', 'defaults', 'work', 'ops', 'cadence.json'), null);
const TUNING = tuning(process.env, CADENCE);
const COOLDOWN_MS = TUNING.cooldownMin * 60000;
let MAX_PER_TICK = TUNING.maxPerTick;   // agents work in parallel; the pacer still paces the subscriptions
const SP = require('./lib/sprint');
const SS = require('./lib/seat-status');
const A = require('./lib/admit');
const G = require('./lib/gates');
const CMP = require('./lib/completions');
const W = require('./lib/wakes');      // run-to-item links (company/state/wakes.jsonl): measurement only
const RT = require('./lib/routing');   // which model one wake runs on (company/work/models/routing-policy.json; none = the chain, as before)
const FREE_MODELS = require('./lib/free-models');   // the free-model fallback: a free pair is not metered
const FAM = require('./lib/family');   // a lead run and its delegated child runs are one family (spend, busy seats)
const SCHED = require('./lib/scheduler');
const SCHED_MODE = SCHED.mode();
// Sprint (cadence.js effective().sprint): null when off. Fail-safe: an unreadable cadence means no Sprint.
const SPRINT = (() => { try { return require('./cadence.js').effective().sprint || null; } catch (_) { return null; } })();
const SPRINT_METRICS = path.join(ROOT, 'company', 'state', 'sprint-metrics.json');
const SPRINT_EFFORT = path.join(ROOT, 'company', 'state', 'sprint-effort.json');
const STALL_AFTER = num('DISPATCH_STALL_AFTER', 3);
const NO_MODEL_LOG_MS = 60 * 60e3;   // NO MODEL HOLD: log the start of a hold, then at most hourly (lib/improve.js health reads the last 2 h)
const BLOCK_STALL_AFTER = num('DISPATCH_BLOCK_STALL_AFTER', STALL_AFTER * 2);
const BACKLOG_SWEEP_DAYS = num('DISPATCH_BACKLOG_SWEEP_DAYS', (CADENCE && Number(CADENCE.backlogSweepDays) > 0) ? Number(CADENCE.backlogSweepDays) : 1);
const AGE_AFTER = num('DISPATCH_AGE_AFTER', 3);   // ticks a seat may lose the per-tick cut before it goes ahead of priority
function blockLineRanges(txt) {
  const lines = String(txt || '').split('\n');
  const ranges = new Map();
  let cur = null, start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (cur !== null) ranges.set(cur, { startLine: start, endLine: i });
      cur = lines[i].slice(3).trim();
      start = i + 1;
    }
  }
  if (cur !== null) ranges.set(cur, { startLine: start, endLine: lines.length });
  return ranges;
}
function daysBetween(d1, d2) {
  const t1 = Date.parse(String(d1 || '') + 'T00:00:00Z');
  const t2 = Date.parse(String(d2 || '') + 'T00:00:00Z');
  return Number.isFinite(t1) && Number.isFinite(t2) ? Math.round((t2 - t1) / 86400e3) : Infinity;
}
// The CFO's budget file (company/work/finance/dispatch-budget.json) wins over the env vars and defaults.
const BUDGET = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'company', 'work', 'finance', 'dispatch-budget.json'), 'utf8')) || {}; } catch (_) { return {}; } })();
// The owner may raise it for today only, answering a money-hold question on Today (lib/money-hold.js, today-budget.json).
const MH = require('./lib/money-hold');
const DAILY_USD = MH.capToday(ROOT, (typeof BUDGET.dailyUsd === 'number' && Number.isFinite(BUDGET.dailyUsd) && BUDGET.dailyUsd >= 0) ? BUDGET.dailyUsd : num('DISPATCH_DAILY_USD', 2));
// Per-agent metered share (set by the finance owner): a metered loop is held once its own agent's 24h spend reaches this
// share, even when the global daily cap still has room, so one loop cannot drain the day. 0 = off.
const PER_AGENT_USD = (typeof BUDGET.perAgentUsd === 'number' && Number.isFinite(BUDGET.perAgentUsd) && BUDGET.perAgentUsd > 0) ? BUDGET.perAgentUsd : 0;
// Providers billed by subscription, not per token: the daily USD cap does not hold their loops.
const UNMETERED_PROVIDERS = (Array.isArray(BUDGET.unmeteredProviders) && BUDGET.unmeteredProviders.length)
  ? BUDGET.unmeteredProviders.map(String).map(s => s.trim()).filter(Boolean)
  : (process.env.DISPATCH_UNMETERED_PROVIDERS || 'claude-cli').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.argv.includes('--dry-run');
// An agent whose station approval mode is "ask" gets every unattended file write and (after a web read) every
// shell call refused, because nobody is there to click the prompt: whole runs burn tokens and save nothing. Such a
// loop is held, not fired; DISPATCH_ALLOW_ASK=1 overrides.
const ALLOW_ASK = process.env.DISPATCH_ALLOW_ASK === '1';
// owner agent -> the routine that is that agent's loop. Matched by name prefix, so a renamed
// routine ("Ops loop — run the company") still resolves from "Ops loop" instead of silently logging NO LOOP.
// The crew list lives in company/tools/loops.json (hire.js adds and removes people there), read through lib/company.js;
// the map below is only the fallback if that file is missing or unreadable: the founder's own loop.
const FALLBACK_LOOP_OF = { agent: 'Founder loop' };
// `let`: re-read after the hiring step, so a seat hired this tick is woken for its first run in the same tick
let CREW = (() => { const c = co.crew(); return c && Object.keys(c).length ? c : null; })();
const CEO_ID = co.ceo() || 'agent';
const CEO_NAME = CREW ? co.nameOf(CEO_ID) : 'the CEO';
const seatRow = fn => { const id = CREW ? co.seatFor(fn) : null; return id && CREW[id] ? [id, CREW[id]] : null; };
const loopMap = crew => crew ? Object.fromEntries(Object.entries(crew).filter(([, c]) => c && c.loop).map(([id, c]) => [id, c.loop])) : FALLBACK_LOOP_OF;
let LOOP_OF = loopMap(CREW);
// Revenue priority, set per person as "priority" in loops.json (higher fires first, absent = 0). Used to order the
// due loops so that a cut by the per-tick limit, the USD cap or the per-agent share falls on discretionary work, not
// on the work that makes money. Without it the cut falls on whichever quest /api/quests lists first, and a revenue loop
// can sit held all afternoon while housekeeping loops keep firing.
const prioMap = crew => crew ? Object.fromEntries(Object.entries(crew).map(([id, c]) => [id, Number(c && c.priority) || 0])) : {};
let PRIORITY_OF = prioMap(CREW);
function refreshCrew() { const c = co.crew(); CREW = c && Object.keys(c).length ? c : null; LOOP_OF = loopMap(CREW); PRIORITY_OF = prioMap(CREW); }
const prio = id => PRIORITY_OF[id] || 0;
// Owner messages (company/owner/inbound.jsonl, via owner-inbox.js) wake the seats flagged wakeOnOwnerMessage (the CEO)
// with a short cooldown.
const OWNER_COOLDOWN_MS = num('DISPATCH_OWNER_COOLDOWN_MIN', 10) * 60000;
// The CFO sets the metered daily cap in this file; the env var and the default apply only when it is absent.
const BUDGET_FILE = path.join(ROOT, 'company', 'work', 'finance', 'dispatch-budget.json');

function findLoop(jobs, agentId) {
  const want = LOOP_OF[agentId];
  if (!want) return null;
  const hits = jobs.filter(j => j.name === want || j.name.startsWith(want));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) log('AMBIGUOUS loop "' + want + '" for ' + agentId + ': ' + hits.map(h => h.name).join(', '));
  return null;
}

function call(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(HOST + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'x-starnet-token': TOKEN() }, body ? { 'Content-Type': 'application/json' } : {}), timeout: timeoutMs || 15000 }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 4e6) d = d.slice(-1e6); });   // a run streams events; keep the connection, drop the bytes
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
// agentId -> approval mode from the station roster (read-only). Unknown agent or unreadable roster => '' (not held).
function approvalModes() {
  const out = {};
  for (const a of (readJson(ROSTER, {}).agents || [])) if (a && a.agentId) out[a.agentId] = String(a.approvalMode || '');
  return out;
}
function log(line) {
  const lp = co.localParts();   // company local time (company.json timezone)
  const stamp = lp.date + ' ' + lp.time;
  console.log(stamp + ' ' + line);
  if (DRY) return;
  try { if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '# Dispatch log\n\n'); fs.appendFileSync(LOG, '- ' + stamp + ' ' + line + '\n'); } catch (_) {}
}
/* Headings of the handoffs still OPEN in one inbox file.
 * The FIRST `**Status:**` line governs the section.
 * A multiline test (`/^\*\*Status:\*\*\s*OPEN\b/m`) would match ANY status line in the section: a batch pass that
 * appends `**Status:** OPEN — …` to the END of a block already marked DONE would make dispatch read that block OPEN
 * and queue work that was finished. A section has one status; the first one is it, and everything after is a note
 * (write those as `**Note (no status on purpose):**`). The narrow
 * reading is the safe one in both directions: it cannot invent work, and a block whose first status is OPEN is still
 * woken. */
function firstStatusOf(sectionText) {
  const m = String(sectionText || '').match(/^\*\*Status:\*\*(.*)$/m);
  return m ? m[1].trim() : null;
}
/* When a handoff block may be worked, and in what order (company/HANDOFFS.md).
 * **Deadline:** is when the work must be DONE, never when it may start: it does not defer anything. It only orders the
 * seat's open items (soonest first, undated last) and marks the ones already past as overdue.
 * **Waiting on:** names what an OPEN block waits for (another handoff, a quest step, a file, a service run, a watched job,
 * a seat's item): it is set aside until every dependency is met, then its holder is woken at once (lib/sprint.js
 * parseDeps/resolveDeps, lib/gates.js lookups). An unresolvable reference is work now (fail open) and logged once.
 * **Not before:** YYYY-MM-DD[ HH:MM] <reason> (company time) is for a genuine wall-clock reason only (a market opens, a
 * provider's data release, a time someone outside named). It sets a block aside within its caps (lib/sprint.js
 * notBeforeGate: 24 h ahead without a reason category, 72 h with one, 12 h in Sprint unless the reason is an external
 * time), measured from when the dispatcher FIRST saw the line; beyond them the line is ignored, the block is work now,
 * and that is logged once per block ("released: a 7-day Not before with no external reason"). Only a plain date as the
 * line's first characters counts. The dispatcher remembers the first date it saw per block (seen: heading -> {at,
 * first}): moving it later never extends the deferral, an earlier one takes effect at once. (Until 2026-11-17 the
 * Deadline line deferred; on 2026-11-17 the CEO parked ~13 items behind guessed Not before dates that meant "after X is
 * done", two core items for a week: hence Waiting on and the caps.) */
const dayMsOf = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
function notBeforeDeferrals(sections, seen, nowStr, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const now = String(nowStr).length > 10 ? String(nowStr) : nowStr + ' 00:00', nextSeen = {}, deferred = new Map(), ignored = new Map(), info = new Map();
  for (const [heading, text] of sections) {
    const lm = String(text || '').match(/^\*\*Not before:\*\*(.*)$/im); if (!lm) continue;
    const nb = G.parseNotBefore(lm[1]); if (!nb) continue;   // prose or an impossible date: workable now
    const at = nb.date + ' ' + nb.time;
    const prev0 = seen && seen[heading];
    const prev = typeof prev0 === 'string' ? { at: prev0, first: now } : prev0 && prev0.at ? prev0 : null;   // a string: the pre-cap memory (migration: measured from now)
    const d = prev && prev.at < at ? prev.at : at;   // the first stamp seen, unless the line now says earlier
    const first = prev && prev.first ? prev.first : now;
    nextSeen[heading] = { at: d, first };
    if (!(d > now)) continue;
    const g = SP.notBeforeGate({ rest: nb.rest, hoursAhead: (G.stampMs(d) - G.stampMs(first)) / 3600e3, sprint: !!o.sprint });
    info.set(heading, { at: d, reason: g.reason, category: g.category, external: g.external, dep: g.dep });
    if (g.honour) deferred.set(heading, d); else ignored.set(heading, { at: d, why: g.why, dep: g.dep, reason: g.reason });
  }
  return { deferred, seen: nextSeen, ignored, info };
}
// each section's own leading **Deadline:** date (or 'today'), for ordering and overdue only: { due: Map heading -> date, overdue: [heading] }
function deadlineOrder(sections, todayStr) {
  const due = new Map(), overdue = [];
  for (const [heading, text] of sections) {
    const m = String(text || '').match(/^\*\*Deadline:\*\*\s*(\d{4}-\d{2}-\d{2}\b|today\b)/im);
    if (!m) continue;
    const d = /^today$/i.test(m[1]) ? todayStr : m[1];
    if (!Number.isFinite(dayMsOf(d))) continue;
    due.set(heading, d);
    if (d < todayStr) overdue.push(heading);
  }
  return { due, overdue };
}
// open headings soonest Deadline first, undated last (ties keep their written order)
const byDue = (heads, due) => heads.map((h, i) => [h, i]).sort((a, b) => (due.get(a[0]) || '9999').localeCompare(due.get(b[0]) || '9999') || a[1] - b[1]).map(x => x[0]);
// the full text of each OPEN section (duty dedup: is an item id already in an OPEN handoff to this seat?)
function openSectionTexts(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return txt.split(/^## /m).slice(1).filter(sec => { const st = firstStatusOf(sec); return st && /^OPEN\b/i.test(st); });
}
function openHandoffs(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const sec of txt.split(/^## /m).slice(1)) {
    const st = firstStatusOf(sec);
    if (st && /^OPEN\b/i.test(st)) out.push(sec.split('\n')[0].trim());
  }
  return out.sort();
}
/* Halt gate: the line logged when the company is halted (co.halted()), or null when it runs. Halts are never bypassed:
 * co.guard('halt') is always ON. */
function haltLine(st) {
  const m = st && st.mode;
  if (m !== 'soft' && m !== 'hard') return null;
  return 'HALTED (' + m + (st.by ? ' by ' + st.by : '') + (st.why ? ': ' + String(st.why).slice(0, 120) : '') + ')'
    + (m === 'soft' ? (st.settledAt ? ' — soft halt complete' : ' — running work finishes, nothing new starts') : ' — station E-STOP') + '; waking nobody';
}
/* Restart hold gate (co.restartHold(), written by restart-station.js): the line logged while it holds. */
function restartHoldLine(h) {
  return 'RESTART HOLD (' + (h.by ? 'by ' + h.by : 'restart-station.js') + (h.reason ? ': ' + String(h.reason).slice(0, 120) : '') + ')'
    + ' — waiting for running work to finish so the station can restart; waking nobody';
}
/* USD cap verdict for one due loop: 'run' | 'held' (daily cap) | 'perAgentHeld' | 'wouldHold' (spendCap guardrail off). */
function capDecision({ capOn, capped, metered, ownerWake, perAgentOver }) { return A.money({ capOn, capped, metered, ownerWake, perAgentOver }).verdict; }   // the one copy: lib/admit.js money()
/* ---- HIRING: rounds advance on their own ----
 * Each tick runs `hire.js advance --all` (a child with a timeout, fail-safe): every open round is moved as far as it goes
 * without a judgement: candidates from the written profiles, all interviews in parallel (in the background), the
 * scorecard inputs, the pick handed to the seat that decides, a recorded pick finished into a hire. `--held` passes the
 * metered cap down (interviews are metered model calls). The halt state is checked before this runs. */
function runHiringAdvance(held) {
  const argv = [path.join(__dirname, 'hire.js'), 'advance', '--all'].concat(held ? ['--held'] : []).concat(DRY ? ['--dry'] : []);
  const out = require('child_process').execFileSync(process.execPath, argv, { cwd: ROOT, timeout: num('DISPATCH_HIRING_TIMEOUT_SEC', 240) * 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  return JSON.parse(out);
}
// which seats to wake now for a pick (once per round, past their cooldown): rounds waiting on a pick whose wake has not
// been spent. -> [{ seat, slug }]
function hiringWakes(rounds, state) {
  const w = (state && state.hiringWake) || {}; const outl = [];
  for (const r of rounds || []) if (r && r.stage === 'waiting-pick' && r.pickRequestAt && !w[r.slug]) for (const seat of r.pickSeats || []) outl.push({ seat, slug: r.slug });
  return outl;
}
// one log line per round when something happened or its stage changed
function hiringLines(rounds, state) {
  state.hiringStage = state.hiringStage || {}; const lines = [];
  for (const r of rounds || []) {
    if (!r || !r.slug) continue;
    const changed = state.hiringStage[r.slug] !== r.label;
    if ((r.did && r.did.length) || changed || r.error) lines.push('HIRING ' + r.slug + ': ' + (r.error ? 'error ' + r.error : [].concat(r.did || [], r.notes || []).join('; ') || 'no step') + ' — now ' + (r.label || r.stage || '?'));
    if (r.label) state.hiringStage[r.slug] = r.label;
  }
  return lines;
}
/* `--selftest`: the reader's own fixtures. It exists because the defect above was in a reader, and a reader that is
 * only ever exercised on today's clean inboxes has not been tested. Runs before any state is read or written. */
function selftestOpenHandoffs() {
  const cases = [];
  const check = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  const dir = require('./lib/temp-life').tmpDir('dispatch-selftest-');
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const openBlock = '## 2026-11-16 10:00 from X — an open ask\n**Need:** y\n**Status:** OPEN\n**Deadline:** today\n';
  const doneClosed = '## 2026-11-16 10:00 from X — closed\n**Need:** y\n**Status:** DONE — resolved\n**Resolved 06:42 by Y:** done\n';
  const doneThenOpen = doneClosed + '**Status:** OPEN — written by the CEO in a later session (status line appended)\n';
  const openThenDone = openBlock + '**Status:** DONE — actually closed later\n';
  const noteOnly = doneClosed + '**Note (no status on purpose):** a bodyless block from a batch pass\n';

  check('a section whose first status is OPEN is woken', openHandoffs(write('a.md', openBlock)).length === 1);
  // Not before deferral (rewritten from the hc-0015 Deadline cases on purpose: a Deadline never defers now)
  const sec = (d, k) => '2026-11-17 10:00 from X — ask\n**Need:** y\n**Status:** OPEN\n**' + (k || 'Not before') + ':** ' + d + '\n';
  const nbd = (d, seen, now, sprint) => notBeforeDeferrals(new Map([['h', sec(d)]]), seen, now || '2026-11-17 10:00', { sprint });
  const def = (d, seen, now, sprint) => nbd(d, seen, now, sprint).deferred;
  check('a Not before 20 h ahead with no reason defers (inside the 24 h cap)', def('2026-11-18 06:00').get('h') === '2026-11-18 06:00');
  check('a Not before with a time defers until that minute, then not', def('2026-11-17 14:00').size === 1 && !def('2026-11-17 14:00', null, '2026-11-17 14:00').size);
  check('a Deadline in 3 days defers nothing', !notBeforeDeferrals(new Map([['h', sec('2026-11-20', 'Deadline')]]), {}, '2026-11-17 10:00').deferred.size);
  check('today, a past date, prose and an impossible date count as workable now', !def('2026-11-17').size && !def('2026-11-10').size && !def('next week').size && !def('2026-13-45').size);
  check('a 7-day Not before with no reason is ignored, and says why', !def('2026-11-24').size && nbd('2026-11-24').ignored.get('h').why === 'a 7-day Not before with no external reason');
  check('the caps: 26 h with no reason category is ignored; 26 h for a market opening defers; 74 h for it is ignored', !def('2026-11-18 12:00').size && def('2026-11-18 12:00 — the market opens').size === 1 && !def('2026-11-20 12:00 — the market opens').size);
  check('a dependency-shaped reason is no category (24 h cap) and is named', nbd('2026-11-18 12:00 (set 2026-11-17 22:24 by Founder: the recompute needs the finished gold backfill)').ignored.get('h').dep === 'needs');
  check('Sprint: 13 h is ignored unless the reason is an external time; a quota reset is not', !def('2026-11-17 23:00', null, null, true).size && def('2026-11-17 23:00 — EIA data release', null, null, true).size === 1 && !def('2026-11-17 23:00 — the quota resets', null, null, true).size && def('2026-11-17 23:00 — the quota resets').size === 1);
  check('a date in the body text is not the Not before line', !notBeforeDeferrals(new Map([['h', '2026-11-17 x\n**Status:** OPEN\nnot before 2026-11-25 per X\n']]), {}, '2026-11-17 10:00').deferred.size);
  check('the first Not before seen wins: moving it later never extends the deferral', def('2026-11-28', { h: { at: '2026-11-17 18:00', first: '2026-11-17 09:00' } }).get('h') === '2026-11-17 18:00' && def('2026-11-28', { h: { at: '2026-11-17 00:00', first: '2026-11-16 09:00' } }).size === 0 && nbd('2026-11-28', { h: { at: '2026-11-17 00:00', first: '2026-11-16 09:00' } }).seen.h.at === '2026-11-17 00:00');
  check('an earlier Not before takes effect at once', def('2026-11-17', { h: { at: '2026-11-18 00:00', first: '2026-11-17 09:00' } }).size === 0 && nbd('2026-11-17 20:00', { h: { at: '2026-11-18 00:00', first: '2026-11-17 09:00' } }).seen.h.at === '2026-11-17 20:00');
  check('the cap counts from when the line was first seen, not from now (it never re-parks as the date nears)', !def('2026-11-24', { h: { at: '2026-11-24 00:00', first: '2026-11-17 10:00' } }, '2026-11-23 12:00').size);
  check('migration: the old memory (a plain stamp) is measured from now', !def('2026-11-24', { h: '2026-11-24 00:00' }).size && nbd('2026-11-24', { h: '2026-11-24 00:00' }).seen.h.first === '2026-11-17 10:00');
  // Deadline: ordering and overdue only
  const dlo = deadlineOrder(new Map([['late', sec('2026-11-24', 'Deadline')], ['past', sec('2026-11-15', 'Deadline')], ['none', sec('none', 'Deadline')], ['soon', sec('2026-11-18 (the verdict)', 'Deadline')], ['now', sec('today', 'Deadline')]]), '2026-11-17');
  check('a Deadline orders the work soonest first, undated last', byDue(['late', 'none', 'soon', 'past', 'now'], dlo.due).join(',') === 'past,now,soon,late,none', byDue(['late', 'none', 'soon', 'past', 'now'], dlo.due).join(','));
  check('a Deadline in the past is overdue; today is not', dlo.overdue.join(',') === 'past', dlo.overdue.join(','));
  check('a DONE block with an appended OPEN line is NOT woken (the re-open defect)', openHandoffs(write('b.md', doneThenOpen)).length === 0,
    JSON.stringify(openHandoffs(path.join(dir, 'b.md'))));
  check('a block whose first status is OPEN stays woken even with a later DONE (the first line governs)', openHandoffs(write('c.md', openThenDone)).length === 1);
  check('a note line does not open anything', openHandoffs(write('d.md', noteOnly)).length === 0);
  check('one file, two blocks, only the open one is returned',
    openHandoffs(write('e.md', openBlock + '\n' + doneClosed)).length === 1);
  check('a section with no status line is not woken', openHandoffs(write('f.md', '## x — no status at all\nbody\n')).length === 0);
  check('a soft halt wakes nobody', /^HALTED \(soft/.test(haltLine({ mode: 'soft', by: 'Alex', why: 'test' }) || ''));
  check('a hard halt wakes nobody', /^HALTED \(hard/.test(haltLine({ mode: 'hard', by: 'Alex' }) || ''));
  check('running wakes as usual', haltLine({ mode: 'running' }) === null && haltLine(null) === null);
  check('cadence.json sets cooldown and per-tick defaults', JSON.stringify(tuning({}, { defaultCooldownMin: 25, maxPerTick: 2 })) === '{"cooldownMin":25,"maxPerTick":2}');
  check('env vars override cadence.json', JSON.stringify(tuning({ DISPATCH_COOLDOWN_MIN: '5', DISPATCH_MAX_PER_TICK: '9' }, { defaultCooldownMin: 25, maxPerTick: 2 })) === '{"cooldownMin":5,"maxPerTick":9}');
  check('ageing: 2 deferred ticks is not aged, 3 is (AGE_AFTER 3)', !isAged({ s: 2 }, 's', 3) && isAged({ s: 3 }, 's', 3));
  check('ageing: a seat with no streak or no table is not aged', !isAged({}, 's', 3) && !isAged(undefined, 's', 3) && !isAged({ s: 'x' }, 's', 3));
  {
    const streak = { low: 3, mid: 0 }; const prioOf = { hi: 100, mid: 50, low: 0 };
    const ord = ['hi', 'mid', 'low'].sort((a, b) => ((isAged(streak, b, 3) ? 1 : 0) - (isAged(streak, a, 3) ? 1 : 0)) || (prioOf[b] - prioOf[a]));
    check('ageing: an aged low-priority seat sorts ahead of higher priority; the rest keep priority order', ord.join(',') === 'low,hi,mid', ord.join(','));
  }
  check('no cadence.json falls back to 40 / 4', JSON.stringify(tuning({}, null)) === '{"cooldownMin":40,"maxPerTick":4}');
  const base = { metered: true, ownerWake: false, capped: true, perAgentOver: false };
  check('spendCap on: the daily cap holds a metered loop', capDecision(Object.assign({ capOn: true }, base)) === 'held');
  check('spendCap on: the per-agent share holds', capDecision(Object.assign({ capOn: true }, base, { capped: false, perAgentOver: true })) === 'perAgentHeld');
  check('spendCap off: nothing is held, it is noted', capDecision(Object.assign({ capOn: false }, base)) === 'wouldHold' && capDecision(Object.assign({ capOn: false }, base, { capped: false, perAgentOver: true })) === 'wouldHold');
  check('an owner message is never held', capDecision(Object.assign({ capOn: true }, base, { ownerWake: true })) === 'run');
  check('a subscription loop is never held by the USD cap', capDecision(Object.assign({ capOn: true }, base, { metered: false, perAgentOver: true })) === 'run');
  {
    const rounds = [{ slug: 'qa-1', stage: 'waiting-pick', label: 'waiting for pick by Sam', pickRequestAt: '2026-11-17T10:00:00Z', pickSeats: ['sam'], did: ['handed the pick to Sam'] },
      { slug: 'ops-1', stage: 'interviewing', label: 'interviewing 1/3', pickSeats: ['sam'], did: [] }];
    const st = {};
    check('hiring: a round waiting on a pick wakes its pick seat', JSON.stringify(hiringWakes(rounds, st)) === '[{"seat":"sam","slug":"qa-1"}]');
    check('hiring: the pick wake is spent once per round', hiringWakes(rounds, { hiringWake: { 'qa-1': '2026-11-17T10:01:00Z' } }).length === 0);
    check('hiring: two deciders are both woken', hiringWakes([{ slug: 'x', stage: 'waiting-pick', pickRequestAt: 't', pickSeats: ['m', 'p'] }], {}).length === 2);
    check('hiring: interviews in flight wake nobody', hiringWakes([rounds[1]], {}).length === 0);
    const l1 = hiringLines(rounds, st), l2 = hiringLines(rounds, st);
    check('hiring: a log line on each step or stage change, then quiet', l1.length === 2 && /^HIRING qa-1: handed the pick to Sam — now waiting for pick by Sam$/.test(l1[0]) && l2.length === 1 && /qa-1/.test(l2[0]), JSON.stringify([l1, l2]));
  }
  {
    // the spend window over a large runs.jsonl: the last 24 h from the end, never the whole file
    const rf = write('runs.jsonl', ''); const old = JSON.stringify({ runId: 'old', agentId: 'a', startedAt: 1, endedAt: 2, usd: 9, pad: 'p'.repeat(400) }) + '\n';
    const fd = fs.openSync(rf, 'w'); try { const block = Buffer.from(old.repeat(4096)); for (let w = 0; w < 48 * 1024 * 1024; w += block.length) fs.writeSync(fd, block); } finally { fs.closeSync(fd); }
    const t = Date.now(); fs.appendFileSync(rf, [{ runId: 'n1', agentId: 'a', startedAt: t - 3600e3, endedAt: t - 3000e3, usd: 0.25 }, { runId: 'n2', agentId: 'b', startedAt: t - 600e3, endedAt: t - 60e3, usd: 0.5, provider: 'claude-cli' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const real = fs.readFileSync; let whole = 0; fs.readFileSync = function (f) { if (String(f) === rf) whole++; return real.apply(fs, arguments); };
    const t0 = Date.now(); let rows; try { rows = runsSince(t - 24 * 3600e3, rf); } finally { fs.readFileSync = real; }
    const ms = Date.now() - t0; try { fs.unlinkSync(rf); } catch (_) {}
    check('spend window: a 48 MB runs.jsonl gives the last 24 h only, read from the end (' + ms + ' ms)', whole === 0 && rows.length === 2 && rows.reduce((n, r) => n + r.usd, 0) === 0.75 && ms < 1000, JSON.stringify({ whole, n: rows.length, ms }));
  }
  {   // the CEO batch lists only cards that still need the owner
    const levels = { tools: 'notify', schedules: 'auto', hiring: 'approve', models: 'triage', access: 'auto' };
    const o = { level: c => levels[c] || 'approve', rulings: [{ id: 'r1', by: 'owner', text: 'the crew decides hiring of interns', scope: { topics: ['intern'] }, effect: 'crew-decides' },
      { id: 'r2', by: 'Sam', scope: { categories: ['hiring'] }, effect: 'never-ask' }] };
    const card = (cat, extra) => Object.assign({ id: 'q-1', about: 'governance:' + cat, gate: { category: cat } }, extra || {});
    check('batch: a card whose category is at notify or auto is not sent', !stillNeedsOwner(card('tools'), o) && !stillNeedsOwner(card('schedules'), o));
    check('batch: a card at approve or triage is sent', stillNeedsOwner(card('hiring'), o) && stillNeedsOwner(card('models'), o));
    check('batch: a fixed owner gate is sent whatever the level or a ruling says', stillNeedsOwner(card('access'), o) && stillNeedsOwner(card('spend', { gate: { category: 'spend', fixedGate: 'spendBeyondCap' } }), { level: () => 'auto', rulings: [{ by: 'owner', scope: { categories: ['spend'] }, effect: 'never-ask' }] }));
    check('batch: a standing owner ruling hands the card to the crew; a ruling not by the owner does not', !stillNeedsOwner(card('hiring', { about: 'governance:hiring intern' }), o) && stillNeedsOwner(card('hiring'), o));
    check('batch: an ask with no governance category keeps going (inbox.js ask held it to the owner scope)', stillNeedsOwner({ id: 'q-2', about: 'pricing' }, o));
  }
  const bad = cases.filter(c => !c.pass);
  for (const c of cases) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']'));
  console.log(bad.length ? 'DISPATCH SELFTEST FAILED: ' + bad.length + ' of ' + cases.length : 'DISPATCH SELFTEST PASSED: ' + cases.length + ' cases');
  return bad.length ? 1 : 0;
}
/* `--wake-links [--hours N] [--json]` (default 168 h): run-to-item links, offline (no station call, no tick, no model run).
 * Of the handoff items closed DONE in the window, the share with at least one run the dispatcher started for them
 * (company/state/wakes.jsonl, lib/wakes.js linkItems); the target is 90%. Prints the unlinked items. Always exit 0. */
function wakeLinksReport(argv) {
  const i = argv.indexOf('--hours'); const hours = i >= 0 && Number(argv[i + 1]) > 0 ? Number(argv[i + 1]) : 168;
  const r = W.report({ hours });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 1)); return 0; }
  const pct = r.share == null ? 'n/a' : (Math.round(r.share * 1000) / 10) + '%';
  console.log('run-to-item links, last ' + hours + ' h: ' + r.linked + ' of ' + r.total + ' DONE item(s) have a linked run (' + pct + '; target ' + Math.round(r.target * 100) + '%' + (r.met == null ? '' : r.met ? ', met' : ', NOT met') + ')' + (r.wakeOnly ? '; ' + r.wakeOnly + ' with a wake but no known run id' : ''));
  for (const x of r.items.filter(y => !y.linked).slice(0, 20)) console.log('  unlinked: ' + x.file + ' ' + x.id + ' "' + String(x.title).slice(0, 90) + '"');
  return 0;
}
/* ---- QUEST CLOSER: quests close on evidence, not on the owner's click ----
 * Every company quest minted so far uses StarNet's 'attest' contract, which only the Commander's confirm can close,
 * so finished work piles up waiting for a click. With the owner's delegation of that confirm, for an attest quest
 * whose steps are all ticked, the owner agent attests with evidence, and this closer confirms it when the evidence
 * is checkable — cited files exist inside the project (at least one changed since the quest was minted) or cited
 * commits exist in the project or a product repo under company/repos/. Unproven evidence is declined with a note the agent sees on its next run.
 * New quests should use an 'artifact' contract instead: StarNet itself closes those when the deliverable exists. */
const CLOSURES = path.join(ROOT, 'company', 'work', 'quest-closures.md');
// Product repos the company works in: every git checkout directly under company/repos/, plus the project itself.
const REPOS = (() => {
  const dir = path.join(ROOT, 'company', 'repos'); const out = [];
  try { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d); if (fs.existsSync(path.join(p, '.git'))) out.push(p); } } catch (_) {}
  return out;
})();
const DECLINE_COOLDOWN_MS = 6 * 3600 * 1000;
function evidenceRefs(text) {
  const s = String(text || ''); const refs = new Set();
  for (const m of s.matchAll(/`([^`\n]{3,200})`/g)) {   // a backticked command counts only for its path-shaped tokens
    const t = m[1].trim();
    if (!/\s/.test(t)) refs.add(t); else for (const tok of t.split(/\s+/)) if (/\/|\.[A-Za-z0-9]{1,5}$/.test(tok) && !/^-/.test(tok)) refs.add(tok.replace(/^['"]|['"]$/g, ''));
  }
  for (const m of s.matchAll(/(?:^|[\s(\[])((?:company|docs|runbooks|work|tools|src|apps|packages|scripts)\/[A-Za-z0-9_.\/-]*[A-Za-z0-9_])/g)) refs.add(m[1]);
  for (const m of s.matchAll(/\b([0-9a-f]{7,40})\b/g)) refs.add(m[1]);
  for (const m of s.matchAll(/(?:^|[\s(\[`])([A-Za-z0-9_-]+\.(?:md|js|json|jsonl|sh|py|ts|mjs|pdf|html|png|txt|csv))\b/g)) refs.add(m[1]);   // bare file names
  return [...refs];
}
function checkRef(ref, sinceMs) {
  const r = String(ref).replace(/[),.;]+$/, '').replace(/^\.\//, '');
  if (/^[0-9a-f]{7,40}$/.test(r)) {
    for (const repo of [ROOT].concat(REPOS)) {
      try {   // a commit proves work for this quest only if it was made after the quest was minted
        const ct = Number(require('child_process').execFileSync('git', ['-C', repo, 'show', '-s', '--format=%ct', r + '^{commit}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) * 1000;
        if (Number.isFinite(ct) && ct > 0) return { ok: true, ref: r, kind: 'commit', fresh: ct >= sinceMs };
      } catch (_) {}
    }
    return null;
  }
  const bare = /^[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,5}$/.test(r);
  if ((!r.includes('/') && !bare) || /\s{2,}|^https?:/.test(r) || r.startsWith('/api/')) return null;   // not a file reference
  const file = r.split(/[#]/)[0].replace(/:\d+(-\d+)?$/, '').replace(/\s+§.*$/, '');
  const bases = [ROOT, path.join(ROOT, 'company'), path.join(ROOT, 'company', 'work')].concat(REPOS);
  if (bare) bases.push(path.join(ROOT, 'company', 'runbooks'), path.join(ROOT, 'company', 'tools'));   // never inboxes or station state: those prove nothing about the work
  for (const base of bases) {
    const p = path.resolve(base, file);
    if (!p.startsWith(ROOT + path.sep)) continue;
    if (/(^|\/)(work\/handoffs|\.starnet-data)(\/|$)/.test(path.relative(ROOT, p))) continue;
    try { const st = fs.statSync(p); if (!st.isFile()) continue; return { ok: true, ref: path.relative(ROOT, p), kind: 'file', fresh: st.mtimeMs >= sinceMs }; } catch (_) {}
  }
  return /\.[A-Za-z0-9]{1,5}$/.test(file) ? { ok: false, ref: file, kind: 'file' } : null;   // a path-looking ref that is missing
}
function judgeEvidence(q) {
  const text = [q.attest && q.attest.evidence].concat((q.steps || []).map(s => s.note || '')).join('\n');
  const checks = evidenceRefs(text).map(r => checkRef(r, Number(q.createdAt) || 0)).filter(Boolean);
  const uniq = a => a.filter((c, i) => a.findIndex(x => x.ref === c.ref) === i);
  const ok = uniq(checks.filter(c => c.ok)), missing = uniq(checks.filter(c => !c.ok));
  const pass = ok.length >= 1 && ok.some(c => c.fresh) && missing.length <= ok.length;
  return { pass, ok: ok.map(c => c.ref), missing: missing.map(c => c.ref) };
}
// A quest whose steps are a real-world outcome (money received, a customer signed, people contacted) is not proven by
// files the company wrote itself, so the closer never confirms it: the owner does, in the Quest Log.
const REAL_WORLD = /\b(payment|paid|invoice paid|revenue|customer|client|contract|signed|leads? contacted|contacted|deposit)\b/i;
function realWorldOutcome(q) { return REAL_WORLD.test([q.title].concat((q.steps || []).map(s => s.label || '')).join(' ')); }
// Inbox size guard: counts by Status word, the oldest few unfinished headings, one handoff to the manager per size band.
const INBOX_GUARD_KB = num('DISPATCH_INBOX_GUARD_KB', 64), INBOX_GUARD_ITEMS = num('DISPATCH_INBOX_GUARD_ITEMS', 30);
function inboxSizeGuard(state, agentId, inbox, txt, names) {
  if (agentId === CEO_ID) return;   // the CEO has no manager; nothing else escalates a CEO inbox size
  const mgr = ((CREW || {})[agentId] || {}).manager || CEO_ID, mi = inboxOf(mgr);
  state.inboxGuard = state.inboxGuard || {};
  const items = SP.parseItems(txt);
  const cnt = { OPEN: 0, BLOCKED: 0, PARKED: 0, DONE: 0 };
  const live = [];
  for (const it of items) {
    const w = String(it.status || '').trim().split(/[\s—:-]/)[0].toUpperCase();
    if (cnt[w] != null) cnt[w]++;
    if (w === 'OPEN' || w === 'BLOCKED' || w === 'PARKED') live.push(it.heading);
  }
  const bytes = Buffer.byteLength(txt), kb = Math.round(bytes / 1024), work = cnt.OPEN + cnt.BLOCKED;
  const over = bytes >= INBOX_GUARD_KB * 1024 || work >= INBOX_GUARD_ITEMS;
  const prev = state.inboxGuard[inbox];
  if (!over) { if (prev) delete state.inboxGuard[inbox]; return; }   // back under: a later crossing is a new band
  const now = Date.now();
  if (prev && bytes < prev.bytes * 1.5 && work < prev.work * 1.5 && now - prev.at < 7 * 86400e3) return;
  if (!mi || mgr === agentId) return;
  const nm = names[agentId] || agentId;
  const dated = h => { const m = /\d{4}-\d{2}-\d{2}/.exec(h); return m ? m[0] : '9999'; };
  const oldest = live.map((h, i) => [h, i]).sort((a, b) => dated(a[0]).localeCompare(dated(b[0])) || a[1] - b[1]).slice(0, 5).map(x => x[0].slice(0, 100));
  const heading = nm + '\'s inbox is ' + kb + ' KB with ' + work + ' open or blocked items: please triage it';
  log('INBOX SIZE ' + inbox + ' (' + agentId + '): ' + kb + ' KB, ' + cnt.OPEN + ' OPEN, ' + cnt.BLOCKED + ' BLOCKED, ' + cnt.PARKED + ' PARKED, ' + cnt.DONE + ' DONE; handed to manager ' + mgr + ' to triage (not waking ' + agentId + ')');
  appendHandoff(mi, heading, {
    Need: 'go through ' + inbox + ' and cut it down: merge items that say the same thing, close ones that no longer matter, decide the BLOCKED ones (unblock, reassign or close), and re-scope what is too big. Do not ask ' + nm + ' to do this; it is yours to decide.',
    Why: nm + ' reads this whole file at the start of every run, so each run pays for all of it. Finished items are already archived; what is left is real open work, so only a person can shrink it.',
    Counts: cnt.OPEN + ' OPEN, ' + cnt.BLOCKED + ' BLOCKED, ' + cnt.PARKED + ' PARKED, ' + cnt.DONE + ' DONE; ' + kb + ' KB',
    Oldest: oldest.join(' · ').slice(0, 700) || 'none',
    Deadline: 'none', Status: 'OPEN' });
  state.inboxGuard[inbox] = { bytes, work, at: now };
}
function inboxOf(agentId) { return CREW && CREW[agentId] && CREW[agentId].inbox ? CREW[agentId].inbox : null; }
function today() { return co.localParts().date; }
function appendHandoff(inbox, heading, fields) {
  const f = path.join(ROOT, 'company', 'work', 'handoffs', inbox);
  // a "today" deadline is written as the date: handoff-status.js (and the console's due list) leaves "today" undated on purpose
  const head = today() + ' from Dispatcher — ' + heading;
  const block = '\n## ' + head + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + (k === 'Deadline' && v === 'today' ? today() : v)).join('\n') + '\n';
  if (!DRY) require('./lib/tool-blocks').append(f, block);   // recorded: a block typed with this heading is not the dispatcher's
  return head.trim();   // the block's heading, as parseItems reads it (its wakes.jsonl item id)
}
// a broken or stale duty, flagged once per change to the tools owner (the default-branch-watch pattern)
function dutyFlag({ d, state: s, why }) {
  const row = seatRow('tools'); const tools = row && row[1];
  if (tools && tools.inbox) appendHandoff(tools.inbox, 'duty ' + d.id + ' is ' + s, { Need: s === 'broken' ? 'get `' + d.tool + ' --duty` answering again (exit 0 or 1 with its JSON); run it by hand to see why, then set Status to DONE.' : 'find out why the duty has not run inside its cadence (the per-tick cap, a halt, a dispatcher that is not ticking), then set Status to DONE.', Why: 'while a duty is ' + s + ' the work it watches for goes unseen; ' + s + ' never shows as ok (docs/DUTIES.md).', Deadline: 'today', Status: 'OPEN', Evidence: why });
  log('DUTY ' + s.toUpperCase() + ' ' + d.id + ': ' + why + (tools ? ' — told ' + (tools.name || 'the tools owner') : ''));
}
// flip the Status line of the dispatcher's own handoff whose heading contains `needle` (never touches anyone else's block)
function closeHandoff(inbox, needle, note) {
  const f = path.join(ROOT, 'company', 'work', 'handoffs', inbox);
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return false; }
  const parts = txt.split(/^(?=## )/m); let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i].split('\n')[0];
    if (head.startsWith('## ') && head.includes('from Dispatcher') && head.includes(needle) && /^\*\*Status:\*\*\s*OPEN\b/m.test(parts[i])) {
      parts[i] = parts[i].replace(/^\*\*Status:\*\*\s*OPEN\b.*$/m, '**Status:** DONE — ' + note); changed = true;
    }
  }
  if (changed && !DRY) fs.writeFileSync(f, parts.join(''));
  return changed;
}
async function closeQuests(quests, state) {
  state.closer = state.closer || {};
  // the dispatcher's own "attest q:N" handoffs are closed as soon as the quest no longer needs an attestation
  for (const q of quests) {
    const inbox = inboxOf(q.agentId);
    const needsAttest = q.status === 'open' && q.contract && q.contract.type === 'attest' && !q.attest && !(q.steps || []).some(s => !s.done);
    if (inbox && !needsAttest && closeHandoff(inbox, q.id + ' ', 'no longer needed (quest ' + q.status + (q.attest ? ', attested' : '') + ')')) log('TIDIED dispatcher handoff for ' + q.id + ' in ' + inbox);
  }
  for (const q of quests) {
    if (q.status !== 'open' || !q.contract || q.disposition) continue;
    const steps = q.steps || [];
    if (steps.some(s => !s.done)) continue;
    const st = state.closer[q.id] = state.closer[q.id] || {};
    const owner = q.agentId, inbox = inboxOf(owner);
    if (q.contract.type === 'artifact') {   // StarNet closes these itself; flag one whose file never appeared
      const key = String(q.contract.key || '').trim();
      const present = !!key && fs.existsSync(path.join(ROOT, key));
      if (key && !present && inbox && !st.nudgedAt) {
        appendHandoff(inbox, 'deliver ' + q.id + ' "' + q.title.replace(/"/g, "'") + '": steps ticked, file missing', {
          Need: 'write the deliverable at exactly `' + key + '` (the quest closes itself at the end of your next session once that file exists), or untick the steps that are not really done.',
          Why: 'every step is ticked but the deliverable named in the quest does not exist, so the quest can never close.',
          Deadline: 'today', Status: 'OPEN', Evidence: '/api/quests: ' + steps.length + '/' + steps.length + ' steps ticked; `' + key + '` not found' });
        st.nudgedAt = Date.now();
        log('NUDGED ' + owner + ' to deliver ' + q.id + ' (' + key + ' missing)');
      } else if (present && !st.readyLogged) {
        // StarNet proves an artifact contract only in its run-end sweep for the OWNING agent (sidecar/index.js,
        // QuestSweeps.artifactQuestKeys), so a file that lands while that agent is idle stays unclosed until the
        // agent's next run. The work-assembly block below wakes that loop once; this line says why it is needed.
        st.readyLogged = Date.now();
        log('ARTIFACT READY ' + q.id + ' "' + q.title + '" (`' + key + '` exists): one run by ' + owner + ' closes it at run end');
      }
      continue;
    }
    if (q.contract.type !== 'attest') continue;
    if (realWorldOutcome(q)) {
      if (q.attest && q.attest.confirmed == null && !st.heldLogged) { st.heldLogged = true; log('HELD ' + q.id + ' "' + q.title + '" for the owner: a real-world outcome (payment, customer, contact) is not proven by company files'); }
      continue;
    }
    if (q.attest && q.attest.confirmed == null) {
      const v = judgeEvidence(q);
      if (v.pass) {
        if (DRY) { log('WOULD CLOSE ' + q.id + ' on evidence: ' + v.ok.slice(0, 4).join(', ')); continue; }
        const r = await call('POST', '/api/quests/confirm', { id: q.id, ok: true, note: 'Closed on evidence by the dispatcher (owner-delegated): ' + v.ok.slice(0, 4).join(', ') });
        if (r.status === 200 && /"ok":true/.test(r.body)) {
          log('CLOSED ' + q.id + ' "' + q.title + '" (' + owner + ') on evidence: ' + v.ok.slice(0, 4).join(', '));
          try { if (!fs.existsSync(CLOSURES)) fs.writeFileSync(CLOSURES, '# Quest closures\n\nQuests closed on checked evidence instead of the owner\'s click. The owner can reopen any of them in the Quest Log.\n\n| Closed | Quest | Owner | Evidence checked | Missing refs |\n|---|---|---|---|---|\n');
            fs.appendFileSync(CLOSURES, '| ' + today() + ' ' + co.localParts().time + ' | ' + q.id + ' ' + q.title.replace(/\|/g, '/') + ' | ' + owner + ' | ' + v.ok.slice(0, 6).join(', ') + ' | ' + (v.missing.join(', ') || '—') + ' |\n'); } catch (_) {}
          if (inbox) closeHandoff(inbox, q.id + ' ', 'closed on evidence ' + new Date().toISOString().slice(0, 16));
          st.closedAt = Date.now();
        } else log('  close ' + q.id + ' refused: HTTP ' + r.status + ' ' + r.body.slice(0, 120));
      } else if (!st.declinedAt || Date.now() - st.declinedAt > DECLINE_COOLDOWN_MS) {
        if (DRY) { log('WOULD DECLINE ' + q.id + ': evidence ok=' + v.ok.length + ' missing=' + v.missing.join(', ')); continue; }
        const note = 'Evidence not checkable: cite the files (in backticks) or commits that prove each step' + (v.missing.length ? '; missing: ' + v.missing.slice(0, 4).join(', ') : '');
        const dr = await call('POST', '/api/quests/confirm', { id: q.id, ok: false, note: note.slice(0, 230) });
        if (dr.status === 200 && /"ok":true/.test(dr.body)) { st.declinedAt = Date.now(); st.nudgedAt = 0; log('DECLINED ' + q.id + ' attest: ' + note); }
        else log('  decline ' + q.id + ' refused: HTTP ' + dr.status + ' ' + dr.body.slice(0, 120));
      }
      continue;
    }
    if (!q.attest && inbox && !st.nudgedAt) {
      appendHandoff(inbox, 'attest ' + q.id + ' "' + q.title.replace(/"/g, "'") + '": every step is ticked', {
        Need: 'propose completion with evidence in your next run: `curl -s -H "x-starnet-token: $(cat secrets/station-token)" -H "Content-Type: application/json" -X POST ' + HOST + '/api/quests/update -d \'{"id":"' + q.id + '","op":"attest","agentId":"' + owner + '","evidence":"<what was done, citing each file path in backticks and any commit ids>"}\'`. The dispatcher checks the cited files and commits exist and then closes the quest; you do not need the owner.',
        Why: 'quests now close on evidence, not on the owner\'s click. A fully ticked quest with no attestation never closes.',
        Deadline: 'today',
        Status: 'OPEN',
        Evidence: '/api/quests shows ' + steps.length + '/' + steps.length + ' steps ticked and no attestation',
      });
      st.nudgedAt = Date.now();
      log('NUDGED ' + owner + ' to attest ' + q.id + ' (handoff in ' + inbox + ')');
    }
  }
}
/* ---- OWNER OUTBOX: open owner questions are delivered to the owner, once each ----
 * company/tools/inbox.js ask only writes a file, so a blocking question would sit unseen. This appends each open CEO
 * question to company/owner/outbound.jsonl (owner-inbox.js send) once, tagged with its id (`re`, and in brackets at the
 * end of the text) so a reply is matched back automatically.
 * On by default with the file adapter (company.json ownerChannel.adapter "file"); company/state/owner-outbox.json
 * {"enabled": false} turns it off, {"enabled": true} turns it on for another adapter. At most one message per tick.
 * Only a card that STILL needs the owner is sent (stillNeedsOwner): a fixed owner gate always; a governance card only while
 * its category is at approve (or triage); never one the owner's standing rulings (company/state/owner-rulings.json) or the
 * category's level (auto, notify) already hand to the crew. The message is urgent (lib/owner-notice.js): the CEO is
 * asking; question ids ride in `re` and the technical part, never in the words the owner reads. */
const OUTBOX = path.join(ROOT, 'company', 'state', 'owner-outbox.json');
const FIXED_GATES = new Set(['access', 'ownership', 'commitment', 'commitments', 'spendBeyondCap']);
const categoryOf = q => (q.gate && q.gate.category) || (/^governance:/.test(String(q.about || '')) ? String(q.about).slice('governance:'.length) : null);
/* stillNeedsOwner(q, o) -> true when the owner must still decide this card (o.level / o.rulings: tests only) */
function stillNeedsOwner(q, o) {
  o = o || {};
  const cat = categoryOf(q);
  const fixedName = (q.gate && q.gate.fixedGate) || (cat && FIXED_GATES.has(cat) ? cat : null);
  if (fixedName) return true;   // the four fixed owner gates are never handed to the crew
  if (q.gate && q.gate.guardrail) return true;   // nor a card a guardrail requires (lib/owner-card.js guardrail)
  if (!cat) return true;        // not a governance card: inbox.js ask already held it to the owner's scope
  // standing owner rulings: lib/owner-rulings.js (the reader that ignores a hand-edited file, and the matcher
  // lib/owner-card.js and the console use), never a raw read of the file
  const R = require('./lib/owner-rulings');
  const about = { category: cat, about: q.about, text: q.message || q.q, ref: q.gate && q.gate.ref };
  let ruling = null; try { ruling = R.match(about, o.rulings ? { rulings: o.rulings.filter(r => r && r.by === 'owner') } : { root: ROOT }); } catch (_) {}
  if (ruling && ruling.effect === 'ask') return true;
  const level = o.level ? o.level(cat) : co.gate(cat, { triage: true });
  if (level === 'auto' || level === 'notify') return false;
  if (ruling && (ruling.effect === 'crew-decides' || ruling.effect === 'never-ask')) return false;
  return true;
}
function deliverOwnerQuestions() {
  const ob = readJson(OUTBOX, { sent: {} }) || {}; ob.sent = ob.sent || {};
  const adapter = String(((co.config.ownerChannel || {}).adapter) || 'console');
  const fileAdapter = adapter === 'console' || adapter === 'file';
  // The console shows every open question on Today the moment it is asked (it reads inbox.js directly), so there is no
  // daily limit by default. A push adapter (a chat app, email) may set ownerChannel.dailyLimit to stop it buzzing.
  const dailyLimit = Number((co.config.ownerChannel || {}).dailyLimit) > 0 ? Number((co.config.ownerChannel || {}).dailyLimit) : Infinity;
  if (ob.enabled === false || (ob.enabled == null && !fileAdapter)) return;
  let open = []; try { open = require('./inbox.js').openQuestions(); } catch (e) { log('OUTBOX ERROR: ' + e.message); return; }
  // Only the CEO's question reaches the owner (immediately on the console; a push adapter may set a daily limit). Anyone else's question waits for the CEO to fold it
  // into the batch. A question younger than 3 minutes waits a tick, so a question the CEO is about to supersede is not sent.
  const ceo = new Set([String(CEO_NAME).toLowerCase(), String(CEO_ID).toLowerCase()]);
  const sentToday = Object.values(ob.sent).filter(x => x && String(x.at || x.pendingAt || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const others = open.filter(q => !ceo.has(String(q.from || '').toLowerCase()) && !ob.sent[q.id]);
  if (others.length && state_noteOthers(others)) log('OUTBOX HELD ' + others.map(q => q.id + ' (' + q.from + ')').join(', ') + ': only the CEO\'s batched question goes to the owner; ' + CEO_NAME + ' folds these in');
  const eligible = open.filter(q => !ob.sent[q.id] && ceo.has(String(q.from || '').toLowerCase()) && Date.now() - Date.parse(q.askedAt || q.at || 0) > (dailyLimit === Infinity ? 0 : 3 * 60000))
    .filter(q => { const need = stillNeedsOwner(q); if (!need) log('OUTBOX SKIP ' + q.id + ': ' + (categoryOf(q) || '?') + ' is handled by the crew (its level or a standing owner ruling); not sent'); return need; })
    .sort((a, b) => String(a.askedAt || a.at).localeCompare(String(b.askedAt || b.at)));
  if (!eligible.length) return;
  // Self-governance approvals (lib/governance.js, batch 'gate') travel together: every pending one in a single numbered
  // message, so a day with five approvals is one message, not five days of messages.
  const gates = eligible.filter(q => q.batch === 'gate');
  const bundle = dailyLimit === Infinity ? [eligible[0]] : (gates.length > 1 ? gates : [eligible[0]]);
  const next = bundle[0];
  if (sentToday >= dailyLimit && !bundle.some(q => /\burgent\b/i.test(String(q.q).slice(0, 200)))) return;   // only when a push adapter sets a daily limit
  // Sent as the CEO wrote it: a plain message between two people. Each id rides in brackets so a reply that quotes it is
  // matched automatically; a reply without it still reaches the CEO, who records it.
  // The plain message goes out (inbox.js messageParts); the detail stays on Today. A question with a secret field says
  // where to answer it, so nobody pastes a key into a message.
  const said = q => {
    const secret = ((q.form && q.form.fields) || []).some(f => f.type === 'secret' && !f.hinted) || !!q.secretHint;
    return String(q.message || q.q).slice(0, 1200).trim() + (q.details ? ' (More detail on Today in the console.)' : '') +
      (secret ? ' Please answer this one on Today in the console: it has a secure field for the key. Never paste a key into a message.' : '');
  };
  const body = bundle.length > 1
    ? ('A few things need your yes or no:\n\n' + bundle.map((q, i) => (i + 1) + '. ' + said(q) + ' (' + q.id + ')').join('\n\n')).slice(0, 3800)
    : said(next).slice(0, 3800) + '\n\n(' + next.id + ')';
  if (DRY) { log('WOULD SEND owner question ' + bundle.map(q => q.id).join(', ') + ' (' + body.length + ' chars)'); return; }
  for (const q of bundle) ob.sent[q.id] = { pendingAt: new Date().toISOString() };   // marked before sending: a failure never sends it twice
  fs.writeFileSync(OUTBOX, JSON.stringify(ob, null, 1) + '\n');
  try {
    const sentRes = require('./lib/owner-notice').send({ kind: 'urgent', from: next.from || CEO_NAME, text: body, re: bundle.map(q => q.id).join(','), technical: 'Question ' + bundle.map(q => q.id).join(', ') + ' (reply on Today, or quote the id).', key: 'owner-question:' + bundle.map(q => q.id).join(',') });
    const row = sentRes.row || { id: 'duplicate' };
    for (const q of bundle) ob.sent[q.id] = { at: new Date().toISOString(), messageId: row.id };
    fs.writeFileSync(OUTBOX, JSON.stringify(ob, null, 1) + '\n');
    log('SENT owner question ' + bundle.map(q => q.id).join(', ') + ' (from ' + next.from + ') to company/owner/outbound.jsonl');
  } catch (e) { log('OUTBOX send failed for ' + next.id + ' (left pending; clear company/state/owner-outbox.json sent.' + next.id + ' to retry): ' + String(e.message).slice(0, 160)); }
}
// log the held-questions line once per distinct set, not every tick
let OTHERS_SEEN = null;
let LIVE_KIDS = new Map();   // this tick's live child runs by seat (FAM.liveChildSeats of the station's snapshot), for the delegation allowlist
function state_noteOthers(list) { const k = list.map(q => q.id).sort().join(','); const f = path.join(ROOT, 'company', 'state', 'outbox-held.txt'); let prev = ''; try { prev = fs.readFileSync(f, 'utf8'); } catch (_) {} if (prev === k) return false; if (!DRY) fs.writeFileSync(f, k); return true; }
/* ---- PERFORMANCE: a person consistently failing at their job reaches the people owner, with the evidence ----
 * company/tools/performance.js reads the run records; this writes company/work/performance.md when it changes and hands
 * the people owner one flag per person per flagCooldownHours, with an FYI to the person's manager. The people owner works out the cause and
 * fixes, re-models or (with the manager) replaces the person (company/MODEL_POLICY.md). The CEO is not bothered with it. */
async function performanceFlags(state, jobs) {
  let P; try { P = require(path.join(ROOT, 'company', 'tools', 'performance.js')); } catch (_) { return false; }
  const a = await P.assess({ jobs });
  const report = path.join(ROOT, 'company', 'work', 'performance.md');
  const body = P.render(a);
  let prev = ''; try { prev = fs.readFileSync(report, 'utf8'); } catch (_) {}
  const strip = t => String(t).replace(/^Written by[^\n]*\n/m, '');
  if (!DRY && strip(prev) !== strip(body)) fs.writeFileSync(report, body);
  const cool = (Number(((readJson(path.join(ROOT, 'company', 'model-policy.json'), {}) || {}).performance || {}).flagCooldownHours) || 24) * 3600e3;
  state.perf = state.perf || {};
  // who handles what, by function (lib/company.js seatFor, never hardcoded names): people for people, tools for limits
  const hr = seatRow('people'), tools = seatRow('tools'), fin = seatRow('finance');
  const ceoInbox = (CREW && CREW[CEO_ID] && CREW[CEO_ID].inbox) || 'to-founder.md';
  let issued = 0;
  for (const p of a.people) {
    const crewRow = (CREW && CREW[p.agentId]) || {};
    const mgrId = crewRow.manager || null;
    const mgr = mgrId && CREW && CREW[mgrId] ? CREW[mgrId] : null;
    const types = [...new Set(p.flags.map(f => f.type))];
    const limitOnly = types.length === 1 && types[0] === 'limit';
    const isHr = hr && p.agentId === hr[0] && p.agentId !== CEO_ID;
    // where this person's flag goes: the CEO's own to the CEO; HR's to HR's manager; a limit to the tool owner; else HR
    const to = p.agentId === CEO_ID ? ceoInbox : limitOnly ? ((tools && tools[1].inbox) || ceoInbox) : isHr ? ((mgr && mgr.inbox) || ceoInbox) : ((hr && hr[1].inbox) || ceoInbox);
    const tag = 'performance flag: ' + p.name + ' (';
    if (!p.flags.length) {   // recovered: withdraw any open flag so nobody acts on old evidence
      for (const inbox of new Set([to, (hr && hr[1].inbox), (tools && tools[1].inbox), ceoInbox].filter(Boolean))) if (closeHandoff(inbox, tag, 'withdrawn: ' + p.name + ' recovered ' + new Date().toISOString().slice(0, 16))) log('WITHDREW performance flag for ' + p.name + ' in ' + inbox);
      delete state.perf[p.agentId];
      continue;
    }
    if (openHandoffs(path.join(ROOT, 'company', 'work', 'handoffs', to)).some(h => h.includes(tag))) { state.perf[p.agentId] = { at: Date.now(), flags: types }; continue; }   // one open flag per person
    const st = state.perf[p.agentId] || {};
    if (st.at && Date.now() - st.at < cool) continue;
    const why = p.flags.map(f => f.why).join('; ') + (p.causes && p.causes.length ? '. Likely causes: ' + p.causes.join('; ') : '');
    const heading = tag + p.title + ', ' + p.model + ') is ' + types.join(' and ');
    const need = p.agentId === CEO_ID
      ? 'this flag is about you: fix what you can, and say so in your next note to the owner (replacing the CEO is the owner\'s call).'
      : limitOnly
        ? 'these runs were stopped by a spending or token limit, not by the person: find which limit (the daily cap and per-agent share in company/work/finance/dispatch-budget.json, or a station run limit) and fix it with ' + ((fin && fin[0] !== (tools && tools[0]) && fin[1].name) || 'the finance owner') + ' if it is money. Close this handoff with what you changed.'
        : isHr
          ? 'decide only, as ' + p.name + '\'s manager: (1) fix the cause (hand it to ' + ((tools && tools[1].name) || 'the tool owner') + '), (2) change their model, or (3) replace them: open a people-owner role, and the new people owner carries out the change. Record the decision in company/work/decisions.md.'
          : 'work out the cause from the runs and the person\'s log, then act, cheapest first: (1) fix the cause (a tool, permission or prompt problem goes to ' + ((tools && tools[1].name) || 'the tool owner') + '); (2) change the model within company/MODEL_POLICY.md (`hire.js remodel`); (3) if it keeps happening after a fix or a model change, replace the person (`hire.js fire --replace`) with ' + (mgr && mgrId !== CEO_ID ? 'their manager ' + mgr.name : 'your own decision, since they report to the CEO') + '. Record the decision in company/work/decisions.md and close this handoff with it.';
    appendHandoff(to, heading, { Need: need, Why: why, Deadline: 'today', Status: 'OPEN',
      Evidence: '`company/work/performance.md`; run records in .starnet-data/workspaces/runs.jsonl (agentId ' + p.agentId + ')' });
    if (!limitOnly && !isHr && p.agentId !== CEO_ID && mgr && mgrId !== CEO_ID && mgr.inbox) appendHandoff(mgr.inbox, 'FYI: ' + heading, {
      Need: 'nothing yet. ' + ((hr && hr[1].name) || 'The people owner') + ' is working out the cause and will come to you before any decision to replace ' + p.name + '.',
      Why: why, Deadline: 'none', Status: 'DONE — FYI', Evidence: '`company/work/performance.md`',
    });
    state.perf[p.agentId] = { at: Date.now(), flags: types };
    issued++;
    log('PERFORMANCE FLAG ' + p.name + ' (' + p.agentId + '): ' + p.flags.map(f => f.type + ' — ' + f.why).join('; ') + ' — handed to ' + to.replace(/^to-|\.md$/g, ''));
  }
  return issued > 0;
}
function ownerUnread() { try { return require('./owner-inbox.js').unacked().length; } catch (_) { return 0; } }

// The cap's numerator must mean what its hold logic means. Summing EVERY run's usd would report an owner-paid
// (unmetered) provider's bill beside a cap that holds nothing, and the first loop back on a metered provider would be
// held against money the company was told not to budget. Split the window once, by provider: what the cap can hold,
// and what the owner pays and we do not cap.
//
// The numerator comes from `cap-numerator.js`: the ledger — what actually gets billed — plus an estimate for runs the
// ledger has not settled yet. Summing runs.jsonl alone cannot see an auxiliary generation (`<runId>_skill_review_…`,
// `skill-eval-*`). If that module cannot be loaded the old runs-only sum is used and the log says so once — a silent
// revert is the defect, not the fallback.
const CAPNUM = (() => { try { return require(path.join(__dirname, 'cap-numerator.js')); } catch (e) { return { error: e.message }; } })();
let capNumWarned = false;
function spendSplit() {
  if (CAPNUM && typeof CAPNUM.spendSplit === 'function') return CAPNUM.spendSplit();
  if (!capNumWarned) { capNumWarned = true; log('CAP NUMERATOR ERROR: cap-numerator.js unusable (' + (CAPNUM.error || 'no spendSplit') + ') — the cap is summing runs.jsonl only and cannot see auxiliary generations'); }
  return runsOnlySplit();
}
// StarNet's runs.jsonl is never read whole (docs/RETENTION.md): the window since `sinceMs`, read from the end
// (lib/bounded.js; a run that started in the window ended after it, so the window by end time holds every one)
function runsSince(sinceMs, file) { try { return require('./lib/bounded').jsonlWindow(file || RUNS, { sinceMs }).rows; } catch (_) { return []; } }
// The old numerator, kept whole so the fallback is exactly the behaviour we had and the two can be compared.
function runsOnlySplit() {
  const since = Date.now() - 24 * 3600 * 1000; let metered = 0; let ownerPaid = 0;
  for (const r of runsSince(since)) { if (!(r.startedAt >= since)) continue; const usd = Number(r.usd) || 0; if (UNMETERED_PROVIDERS.includes(String(r.provider || ''))) ownerPaid += usd; else metered += usd; }
  return { metered, ownerPaid };
}
function spentToday() { return spendSplit().metered; }
// seat -> metered USD that seat's FAMILY cost in the last 24h: its own runs plus the child runs its team.dispatch delegated
// (lib/family.js: a child runs on the worker's agentId, but the work and the money are the lead's; the worker's own share
// is never used up by it). Unmetered providers are skipped for the same reason spentToday() skips them: an owner-paid run
// must never use up a seat's share of the company's cap. The company total is unchanged: only whose share a dollar is.
function spentByAgent() {
  if (CAPNUM && typeof CAPNUM.spentByAgent === 'function') return CAPNUM.spentByAgent({ family: true });
  return runsOnlyByAgent();
}
function runsOnlyByAgent() {
  const since = Date.now() - 24 * 3600 * 1000; const out = {};
  const rows = runsSince(since); const fam = FAM.leads(rows);
  for (const r of rows) if (r.startedAt >= since && r.agentId && !UNMETERED_PROVIDERS.includes(String(r.provider || ''))) { const k = FAM.seatOf(fam, r.runId, r.agentId); out[k] = (out[k] || 0) + (Number(r.usd) || 0); }
  return out;
}

// POST /api/cron/run with detach:true — the run is admitted on a 200 and then keeps going after we close the
// socket (the sidecar only wires `res close -> abort` when detach is false). We resolve on the first byte of a
// 200 (admitted) or the full short body of a refusal, so a long loop never blocks or gets cancelled by this tick.
function fireRun(jobId, override) {
  return new Promise((resolve) => {
    const u = new URL(HOST + '/api/cron/run');
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'x-starnet-token': TOKEN(), 'Content-Type': 'application/json' } }, res => {
      let d = '';
      res.on('data', c => {
        d += c;
        if (res.statusCode === 200 && d.length > 0) { finish({ status: 200, body: d.slice(0, 200) }); req.destroy(); }
      });
      res.on('end', () => finish({ status: res.statusCode, body: d }));
      res.on('error', () => finish({ status: res.statusCode || 0, body: d }));
    });
    req.setTimeout(15000, () => finish({ status: 0, body: 'no response in 15s (run may still be detached-live)' }));
    req.on('error', e => finish({ status: 0, body: e.message }));
    // a one-run override (StarNet patch 0017) only when the router applied one (lib/routing.js); else the body is as before
    req.write(JSON.stringify(override ? Object.assign({ id: jobId, detach: true }, override) : { id: jobId, detach: true }));
    req.end();
  });
}
// Tail of the routine's last run for STALLED lines: prove the stall against what actually last ran.
function lastRunTail(job) {
  if (!job) return '';
  const bits = [];
  if (job.lastStatus) bits.push('lastStatus=' + job.lastStatus);
  if (job.lastReason) bits.push('lastReason=' + String(job.lastReason).slice(0, 80));
  if (job.lastError) bits.push('lastError=' + String(job.lastError).slice(0, 120));
  if (job.consecutiveFailures) bits.push('consecutiveFailures=' + job.consecutiveFailures);
  return bits.length ? ' [' + bits.join('; ') + ']' : '';
}

(async () => {
  if (process.argv.includes('--selftest')) process.exit(selftestOpenHandoffs());
  if (process.argv.includes('--wake-links')) process.exit(wakeLinksReport(process.argv));
  // Halt first (company/tools/halt.js, fail-safe): it watches a soft halt settle and escalates only if told to. Then,
  // halted or not, the halt file decides: a halted company wakes nobody.
  try { await require('./halt.js').tick({ dry: DRY, log }); } catch (e) { log('HALT TICK ERROR: ' + String(e.message).slice(0, 200)); }
  // Core modules (company/tools/lib/modules.js): ONE generic hook runs each enabled module's tick.js, fail-safe (a
  // throw or a timeout is one log line). A halted company runs only modules that export runWhenHalted: true
  // (liveness: the heartbeat must keep beating through a halt, or the dead-man's switch would page the owner).
  // A restart hold (company/tools/restart-station.js, waiting for an idle station to restart it) holds starts exactly as a
  // soft halt does: modules run as halted, only whileHalted duties run, nobody is woken. It is not a halt: halt.json is
  // untouched and no shutdown routine runs; the hold ends when the restart is done (or expires if its script died).
  const rhold = co.halted() ? null : co.restartHold();
  const halted = co.halted() || (rhold ? 'soft' : false);
  try { await require('./lib/modules').runTicks({ log, dry: DRY, halted }); } catch (e) { log('MODULE TICKS ERROR: ' + String(e.message).slice(0, 200)); }
  // halted: only the duties marked whileHalted (liveness) run; they record their state and wake nobody, flag nobody
  // halted: the delegation allowlist is emptied too (lib/delegate-allow.js writeEmpty): a lead run already in flight starts no
  // new worker under a list written before the halt (the station would otherwise keep it for up to 30 minutes)
  if (halted) { if (!DRY) { try { require('./lib/delegate-allow.js').writeEmpty({ log }); } catch (e) { log('DELEGATE ALLOWLIST ERROR: ' + String(e.message).slice(0, 200)); } } try { await require('./lib/duty-runner').tick({ log, dry: DRY, halted }); } catch (e) { log('DUTIES ERROR: ' + String(e.message).slice(0, 200)); } log(rhold ? restartHoldLine(rhold) : haltLine(co.haltState())); return; }
  const split = spendSplit();
  const spent = split.metered;
  // Say the numerator out loud when the two records disagree: the cap now reads the ledger, so a tick where it
  // sees money the run record does not is exactly the tick somebody needs to be able to explain later. Quiet when
  // they agree, so a normal tick stays one line shorter.
  if (Math.abs(spent - (Number(split.runsOnlyEstimate) || 0)) > 0.0000005) {
    log('SPEND: cap numerator $' + spent.toFixed(4) + ' — runs.jsonl alone would read $' + (Number(split.runsOnlyEstimate) || 0).toFixed(4)
      + '; the difference is for-billing spend with no run row (cap-numerator.js)');
  }
  // The USD cap holds only METERED loops. A subscription loop (provider claude-cli) adds $0 to runs.jsonl, so
  // stopping it saves nothing, and a cap reached by metered runs must not freeze subscription loops that have OPEN
  // handoffs. Any other provider is treated as metered (a custom provider that records $0 but is flagged
  // unmetered=false is unpriced, not free).
  const capped = spent >= DAILY_USD;
  // a free OpenRouter model (docs/FREE-MODELS.md; the station sends it with a zero max price) costs nothing: not metered
  const isMetered = job => !UNMETERED_PROVIDERS.includes(String(job.provider || '')) && !FREE_MODELS.isFreePair(job.provider, job.model, ROOT);
  const held = [];
  const perAgentHeld = [];
  const wouldHold = [];
  const CAP_ON = co.guard('spendCap');
  const byAgent = spentByAgent();
  const askHeld = [];
  // Hiring first (fail-safe): mechanical steps of every open round, so a hire made now gets its first run in this tick
  let hiringRounds = [];
  try {
    const hr = runHiringAdvance(capped && CAP_ON);
    hiringRounds = (hr && hr.rounds) || [];
    const st0 = readJson(STATE, { quests: {}, agents: {} });
    for (const l of hiringLines(hiringRounds, st0)) log(l);
    if (!DRY) fs.writeFileSync(STATE, JSON.stringify(st0, null, 1));
    if (hiringRounds.some(r => r.hiredNow)) refreshCrew();
  } catch (e) { log('HIRING ERROR: ' + String((e.stderr && String(e.stderr).trim().split('\n').pop()) || e.message).slice(0, 200)); }
  const modes = approvalModes();
  const [qr, cr] = await Promise.all([call('GET', '/api/quests'), call('GET', '/api/cron')]);
  const quests = (JSON.parse(qr.body).quests || []);
  const jobs = (JSON.parse(cr.body).jobs || []);
  // the scheduler (lib/scheduler.js): with the dispatcher owning the schedule, no crew loop routine stays armed on the
  // station (one found enabled — a new hire's, or switched back on — is paused again; the dispatcher starts its runs) and
  // the watchdog routine exists. Fail-safe: an error is one line and the tick goes on.
  const schedState = SCHED.readState(ROOT);
  if (SCHED_MODE === 'dispatcher' && !DRY) {
    try {
      const pl = SCHED.plan('dispatcher', { jobs, crew: CREW || {}, state: schedState, root: ROOT });
      let changed = false;
      for (const x of pl.pause) {
        const r = await require('./lib/station').cron(call, 'POST', '/api/cron/update', { id: x.id, patch: { enabled: false } }, 'pause "' + x.name + '"');
        if (r.ok) { const j = jobs.find(y => y.id === x.id); if (j) j.enabled = false; schedState.owned[x.id] = pl.owned[x.id]; changed = true; log('SCHEDULER: paused "' + x.name + '" on the station: the dispatcher starts its runs (runtime.scheduler=dispatcher)'); }
        else log('SCHEDULER ERROR: could not ' + r.reason);
      }
      if (pl.createWatchdog) {
        const r = await SCHED.createWatchdog(call, ROOT, CEO_ID);
        log(r.ok ? 'SCHEDULER: created the watchdog routine "' + r.name + '" (the only routine the station schedule runs)' + (r.tries.length ? '; declined first: ' + r.tries.join('; ') : '') : 'SCHEDULER ERROR: could not create the watchdog routine: ' + r.reason);
      }
      if (changed) SCHED.writeState(Object.assign(schedState, { mode: 'dispatcher' }), ROOT);
    } catch (e) { log('SCHEDULER ERROR: ' + String(e.message).slice(0, 200)); }
  }
  // the station caps as the station reports them, for the budget-drift duty (budget.js: duties open no socket)
  if (!DRY) { try { await require('./budget.js').snapshot({ call, jobs }); } catch (e) { log('BUDGET SNAPSHOT ERROR: ' + String(e.message).slice(0, 200)); } }
  // each role loop's handoff inbox (loops.json inbox; wakeOnInbox:false opts a seat out, e.g. a CEO loop that reads
  // the whole work/ tree on its own schedule).
  const INBOX_OF = CREW
    ? Object.fromEntries(Object.entries(CREW).filter(([, c]) => c && c.inbox && c.wakeOnInbox !== false).map(([id, c]) => [id, c.inbox]))
    : {};
  for (const agentId of Object.keys(LOOP_OF)) {
    const job = findLoop(jobs, agentId);
    if (!job) { log('CONFIG ERROR: no routine matches "' + LOOP_OF[agentId] + '" for ' + agentId); continue; }
    const prompt = job.prompt || '';
    if (!prompt.includes('/api/quests')) log('CONFIG ERROR: "' + job.name + '" prompt cannot do quest work (no /api/quests) for ' + agentId);
    if (INBOX_OF[agentId] && !prompt.includes(INBOX_OF[agentId])) log('CONFIG ERROR: "' + job.name + '" prompt missing inbox ' + INBOX_OF[agentId] + ' for ' + agentId);
  }
  // Three-tier latitude (company/work/people/LATITUDE.md), fail-safe. First the locked-file watch
  // (company/tools/locked-watch.js): before this tick reads or writes any company state, put back what only a tool may write
  // and report other unrecorded changes to locked files; at the end of this process it records the dispatcher's own state
  // write. Then the 3-day results checks of applied harness changes (company/tools/harness-change.js).
  try { await require('./locked-watch.js').tick({ dry: DRY, log, jobs, from: 'dispatch' }); } catch (e) { log('LOCKED WATCH ERROR: ' + String(e.message).slice(0, 200)); }
  try { await require('./harness-change.js').tick({ dry: DRY, log }); } catch (e) { log('HARNESS CHANGE ERROR: ' + String(e.message).slice(0, 200)); }
  // Security watch (company/tools/security-watch.js, docs/SECURITY-WATCH.md): the inventory and advisory lookup that the
  // security-watch duty reads (duties open no socket). Real work only when due (rescan time, a lockfile or runtime
  // change, the owner's Check now); network only through the external gate; time-boxed; plain code, no model.
  try { await require('./security-watch.js').refresh({ log, dry: DRY }); } catch (e) { log('SECURITY WATCH ERROR: ' + String(e.message).slice(0, 200)); }
  // the free-model list (company/tools/free-models.js, docs/FREE-MODELS.md): read from OpenRouter's public model list at
  // most every freeFallback.refreshHours, and only while the fallback is on; a failed read keeps the last good list
  try { await require('./free-models.js').refresh({ log, dry: DRY }); } catch (e) { log('FREE MODELS ERROR: ' + String(e.message).slice(0, 200)); }
  // Duties (docs/DUTIES.md): after the locked-file watch, so an unrecorded policy edit is reported (and not obeyed) before
  // anything runs. Fail-safe: an error here is one line and the tick goes on without duty work.
  const DR = require('./lib/duty-runner');
  let dutyRun = null;
  try { dutyRun = await DR.tick({ log, dry: DRY, flag: dutyFlag }); } catch (e) { log('DUTIES ERROR: ' + String(e.message).slice(0, 200)); }
  for (const id of (dutyRun && dutyRun.recovered) || []) for (const c of Object.values(CREW || {})) if (c && c.inbox) { closeHandoff(c.inbox, 'duty ' + id + ':', 'the duty check passes now'); closeHandoff(c.inbox, 'duty ' + id + ' is ', 'the duty check runs and passes again'); }
  const state = readJson(STATE, { quests: {}, agents: {} });
  try { await closeQuests(quests, state); } catch (e) { log('CLOSER ERROR: ' + e.message); }
  try { deliverOwnerQuestions(); } catch (e) { log('OUTBOX ERROR: ' + e.message); }
  // the day's ONE plain message to the owner (lib/owner-notice.js digest): every FYI folded, once a company day, at or
  // after the evening hour; a no-op on every other tick
  if (!DRY) try { const d = require('./lib/owner-notice').digest({}); if (d.sent) log('OWNER DAY MESSAGE sent (' + d.folded + ' notes folded)'); } catch (e) { log('OWNER DAY MESSAGE ERROR: ' + String(e.message).slice(0, 200)); }
  // 1-on-1s (company/tools/corrections.js, fail-safe): detect habits, then activate, record, escalate or retire standing
  // corrections. Before the house-rules hook, so a correction activated now reaches the prompts in this same tick.
  try { await require('./corrections.js').tick({ dry: DRY, log, quests, jobs }); } catch (e) { log('CORRECTIONS ERROR: ' + e.message); }
  // a run that sleeps to a wall-clock time (company/tools/long-sleep.js, fail-safe): its seat's manager is told once
  try { require('./long-sleep.js').tick({ dry: DRY, log }); } catch (e) { log('LONG SLEEP ERROR: ' + String(e.message).slice(0, 200)); }
  try { await require('./routine-rules.js').ensure({ dry: DRY, log }); } catch (e) { log('HOUSE RULES ERROR: ' + e.message); }
  try { require('./handoff-archive.js').run({ dry: DRY, log }); } catch (e) { log('ARCHIVE ERROR: ' + e.message); }
  // approvals (company/tools/approvals.js): expiry (default deny) and the batched reminders run on every tick, so they
  // happen whether or not the owner has the console open; the console calls the same tick when it lists approvals
  if (!DRY) try { const t = await require('./approvals.js').tick({ actor: 'the dispatcher' }); const n = ((t.expired || []).length || 0); if (n) log('APPROVALS: ' + n + ' expired (default deny applied)'); } catch (e) { log('APPROVALS ERROR: ' + String(e.message).slice(0, 200)); }
  try { require('./retention.js').daily({ dry: DRY, log }); } catch (e) { log('RETENTION ERROR: ' + String(e.message).slice(0, 200)); }   // once a company day (docs/RETENTION.md)
  // temp files, left-behind browsers and stray processes: the reaper chore (company/tools/reaper.js), run with the duties
  // above, also while halted; it acts only on what it can prove is this company's
  // house benchmark (company/tools/model-stats.js): refreshed at most hourly, read by the people owner and the pacer for model pairing
  try {
    const hb = path.join(ROOT, 'company', 'work', 'models', 'house-benchmarks.json');
    const age = fs.existsSync(hb) ? Date.now() - fs.statSync(hb).mtimeMs : Infinity;
    if (!DRY && age > 3600e3) require('child_process').execFileSync('node', [path.join(__dirname, 'model-stats.js')], { timeout: 60000, stdio: 'ignore' });
  } catch (e) { log('HOUSE BENCHMARK ERROR: ' + e.message); }
  // house ranking (company/tools/model-rank.js, docs/RANKING.md): at most every refreshMinutes (default hourly), in its own
  // process; files and the one log line only when the ranking changed. Measurement only: proposals are shadow records
  try { if (!DRY && require('./model-rank.js').refreshDue()) { const out = String(require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'model-rank.js'), 'refresh'], { cwd: ROOT, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); if (/: changed \((?!0 cells)/.test(out)) log('HOUSE RANKING: ' + out.replace(/^house ranking: changed /, '').slice(0, 240)); } } catch (e) { log('HOUSE RANKING ERROR: ' + String(e.message).slice(0, 200)); }
  // the apprentice (company/tools/apprentice.js, docs/APPRENTICE.md): off unless the owner turned it on, sandbox company
  // only; due() is cheap and fail-safe, the pass runs detached so a slow apprentice server never holds the tick
  try { if (!DRY && require('./apprentice.js').due()) { const k = require('child_process').spawn(process.execPath, [path.join(__dirname, 'apprentice.js'), 'tick'], { cwd: ROOT, detached: true, stdio: 'ignore' }); k.on('error', () => {}); k.unref(); } } catch (e) { log('APPRENTICE ERROR: ' + String(e.message).slice(0, 200)); }
  try { if (await performanceFlags(state, jobs) && !DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); } catch (e) { log('PERFORMANCE ERROR: ' + e.message); }
  const work = {};   // agentId -> open quests with steps still to do
  for (const q of quests) {
    if (q.status !== 'open' || !q.agentId || q.disposition) continue;
    const left = (q.steps || []).filter(s => !s.done).length;
    if (!left) continue;                                   // every step ticked: waiting on a verdict, not on work
    const done = (q.steps || []).length - left;
    const st = state.quests[q.id] || { count: 0, done: -1 };
    if (done > st.done) { st.count = 0; st.done = done; st.flagged = false; }  // progress resets the stall counter and flag
    state.quests[q.id] = st;
    if (st.count >= STALL_AFTER) { if (!st.flagged) { st.flagged = true; log('STALLED ' + q.id + ' "' + q.title + '" (' + q.agentId + '): ' + STALL_AFTER + ' runs, no new step — needs ' + CEO_NAME + ' (CEO) or the owner' + lastRunTail(findLoop(jobs, q.agentId))); } continue; }
    (work[q.agentId] = work[q.agentId] || []).push(q);
  }
  // Handoff wake: an agent with an OPEN handoff in its inbox is owed a run even when the quest belongs to someone
  // else (a quest can sit STALLED on one loop while the missing piece is another seat's sign-off in its own inbox).
  // Same stall rule: the same set of OPEN handoffs after STALL_AFTER dispatches => stop and flag once.
  state.agents = state.agents || {};
  const reason = {};   // agentId -> label for the log
  for (const [agentId, qs] of Object.entries(work)) reason[agentId] = qs.map(q => q.id).join(',');
  // An OPEN item whose Status says it waits on another seat ("waiting on Iris's review", "blocked on the owner") is not
  // work for its holder: it neither wakes the seat nor counts in its signature or stall key (lib/sprint.js waitingOn).
  const NAMES = Object.fromEntries(Object.entries(CREW || {}).map(([id, c]) => [id, (c && c.name) || id]));
  const itemsOf = {}, waitsOf = {}, stalledSeats = [];
  const wakeItemsOf = {};   // agentId -> the OPEN items that are work now, for the wake's wakes.jsonl row (lib/wakes.js)
  const wakeTextOf = {};    // agentId -> heading -> its block text, for the router's task class (lib/routing.js)
  const focusItemsOf = {};  // agentId -> up to 5 target items (id + line range) named in the wake reason
  const backlogOnlyWake = new Set();   // seats woken solely for a slow-cadence backlog sweep (lowest slot priority)
  const pendingWakeSigs = {};          // agentId -> snapshot committed to state.agents[id] only when the wake starts (HTTP 200)
  // progress evidence for the stall check (lib/stall.js): the seats' recent runs, and every inbox's text (blocks sent)
  const STALL = require('./lib/stall');
  const stallRuns = runsSince(Date.now() - 48 * 3600e3);
  const allInboxText = Object.values(INBOX_OF).map(ib => { try { return fs.readFileSync(path.join(ROOT, 'company', 'work', 'handoffs', ib), 'utf8'); } catch (_) { return ''; } });
  const sentBy = name => { if (!name) return 0; const re = new RegExp('^## [^\\n]*\\bfrom ' + String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gmi'); return allInboxText.reduce((n, t) => n + ((t.match(re) || []).length), 0); };
  // Blocking approvals (company/tools/approvals.js blockingSeats(), a READ): the asker's work that depends on a pending
  // blocking approval waits on the owner, like an item whose Status says so: the item that names the approval id or is
  // the handoff the record names (with neither, every OPEN item of the asker: a blocking ask says it cannot go on), and
  // a dependent record's asker's items that name that record. It wakes nobody and counts toward no stall; the seats
  // waiting on the asker stay waiting (waitingOn). One reminder comes from approvals.tick(), not from here. The hold
  // ends when the record is answered, expires or is withdrawn (the asker is then woken by the owner message).
  const apHolds = {};   // seat id -> [{ id, heading?, all }]
  try {
    for (const [seat, recs] of Object.entries(require('./approvals.js').blockingSeats())) for (const r of recs) {
      (apHolds[seat] = apHolds[seat] || []).push({ id: r.id, heading: r.handoff && r.handoff.heading, all: true });
      for (const [i, dep] of (r.dependents || []).entries()) { const ds = (r.dependentSeats || [])[i]; if (ds) (apHolds[ds] = apHolds[ds] || []).push({ id: dep, all: false }); }
    }
  } catch (e) { log('APPROVALS ERROR: ' + String(e.message).slice(0, 200)); }
  // Waiting on, Not before and the owner's Start now (lib/gates.js, lib/sprint.js): which OPEN items are parked, why, in
  // plain words for Work › Handoffs (company/state/parked.json), and who is woken at once because what they waited for
  // happened (wakeNotes: a dependency met, a Start now, a watched job that ended; rest 0, every other rule as usual).
  const RELEASES = (() => { try { return G.releases(ROOT); } catch (_) { return new Map(); } })();
  const lpNow = co.localParts(), nowStamp = lpNow.date + ' ' + lpNow.time;
  const parked = [], nbNotice = [];
  state.releasesDone = state.releasesDone || {};
  const note = (id, n) => {
    const a = state.agents[id] = state.agents[id] || { key: '', count: 0 };
    const list = a.wakeNotes || [];
    if (n.coalesceKey) {
      const prev = list.find(x => x.coalesceKey === n.coalesceKey && !x.written);
      if (prev) {
        const count = (Number(prev.count) || 1) + 1;
        const base = n.baseWords || prev.baseWords || n.words || prev.words || '';
        prev.count = count;
        prev.id = n.id;
        prev.at = Date.now();
        prev.words = base + ' (' + count + 'x)';
        prev.text = 'your ' + prev.words + '; output tail in completions id ' + n.id;
        return;
      }
    }
    if (list.some(x => x.key === n.key)) return;
    a.wakeNotes = list.concat([Object.assign({ at: Date.now() }, n)]);
  };
  const seatOfInbox = ib => Object.keys(CREW || {}).find(k => CREW[k] && CREW[k].inbox === ib) || null;
  const askOf = h => String(h).split(/ — /).slice(1).join(' — ').trim() || String(h);
  const { localToEpoch } = require('./lib/core-loop');
  const sinceOf = (heading, seenAt) => { const hs = G.headingStamp(heading); const ms = hs ? localToEpoch(hs.slice(0, 10), hs.slice(11)) : NaN; return Number.isFinite(ms) && ms <= seenAt && seenAt - ms < 48 * 3600e3 ? ms : seenAt; };
  // a registered service's last successful run (systemd), for `**Waiting on:** service:<name>` when no completion row says so
  const svcLastOk = e => {
    if (process.env.DISPATCH_NO_SYSTEMCTL) return null;
    try {
      const out = String(require('child_process').execFileSync(process.env.SERVICE_SYSTEMCTL || '/usr/bin/systemctl', ['--user', 'show', e.unit + '.service', '--timestamp=unix', '-p', 'Result,ExecMainExitTimestamp'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = out.match(/ExecMainExitTimestamp=@(\d+)/); return /Result=success/.test(out) && m ? Number(m[1]) * 1000 : null;
    } catch (_) { return null; }
  };
  const LOOK = G.lookups({ root: ROOT, crew: CREW || {}, quests, serviceLastOk: svcLastOk });
  // advisor leads (lib/consult.js): an item whose consult is open waits for the lead, and a consult block in a live lead's inbox is its advise run's work, not its loop's
  const CONSULT_HOLD = (() => { try { return require('./lib/consult').holdFn({ root: ROOT }); } catch (e) { log('CONSULT ERROR: ' + String(e.message).slice(0, 200)); return () => null; } })();
  // counterpart sign-off (lib/signoff.js, docs/PROFILES.md): an eager seat's handoff that needs its counterpart's yes waits for it, like Waiting on (shadow: logged only)
  const SIGNOFF_HOLD = (() => { try { return require('./lib/signoff').scanTick({ root: ROOT, log, dry: DRY }); } catch (e) { log('SIGNOFF ERROR: ' + String(e.message).slice(0, 200)); return () => null; } })();
  // accountable leads (lib/accountable.js, docs/DEPARTMENTS.md §8): intake copies, a member's handed-back item waits for the lead's audit, a DONE without the lead's accept goes back to OPEN, a member's onward handoff waits for the lead to pass it on (recording only: logged)
  const AUDIT_HOLD = (() => { try { return require('./lib/accountable').scanTick({ root: ROOT, log, dry: DRY }); } catch (e) { log('ACCOUNTABLE ERROR: ' + String(e.message).slice(0, 200)); return () => null; } })();
  for (const [agentId, inbox] of Object.entries(INBOX_OF)) {
    let its = [], txt = ''; try { txt = fs.readFileSync(path.join(ROOT, 'company', 'work', 'handoffs', inbox), 'utf8'); its = SP.parseItems(txt).filter(i => i.open); } catch (_) {}
    itemsOf[agentId] = its; waitsOf[agentId] = {};
    // inbox size guard (no AI): a seat's inbox that has grown past a size or item count is handed once to its manager to triage,
    // never to the seat itself; archiving DONE cannot shrink real OPEN/BLOCKED work. Re-noted only on 50% more, or 7 days still over.
    try { inboxSizeGuard(state, agentId, inbox, txt, NAMES); } catch (e) { log('INBOX GUARD ERROR ' + inbox + ': ' + String(e.message).slice(0, 200)); }
    const stw = state.agents[agentId] = state.agents[agentId] || { key: '', count: 0 };
    const prevWaits = stw.waits || {}, waitsNext = {};
    for (const it of its) {
      const rel = RELEASES.get(inbox + '\n' + it.heading);
      if (rel) {   // the owner's Start now: no gate holds it (Waiting on, Not before, a waiting Status); its holder is woken once
        it.released = rel; it.waitSeats = [];
        if (!state.releasesDone[rel.id]) { state.releasesDone[rel.id] = new Date().toISOString(); const msg = (NAMES[agentId] || agentId) + ': ' + (rel.by || 'the owner') + ' said Start now — "' + askOf(it.heading).slice(0, 100) + '"'; log('START NOW ' + inbox + ' "' + it.heading.slice(0, 80) + '": released by ' + (rel.by || 'the owner') + ' (' + rel.id + '); waking ' + (NAMES[agentId] || agentId)); note(agentId, { key: 'release:' + rel.id, kind: 'release', heading: it.heading, text: msg }); }
        continue;
      }
      { const ch = CONSULT_HOLD(inbox, it); if (ch) { it.waitingOn = 'consult'; if (ch.who) waitsOf[agentId][ch.who] = (waitsOf[agentId][ch.who] || 0) + 1; continue; } }
      { const ah = AUDIT_HOLD(inbox, it); if (ah) { it.waitingOn = 'audit'; if (ah.who) { waitsOf[agentId][ah.who] = (waitsOf[agentId][ah.who] || 0) + 1; parked.push({ seat: agentId, name: NAMES[agentId] || agentId, inbox, heading: it.heading, kind: 'audit', words: ah.kind === 'pass' ? 'waiting for ' + ah.who + ' to pass it on' : ah.kind === 'escalation' ? 'waiting for ' + ah.who + ' to say why it goes to the CEO' : 'waiting for ' + ah.who + ' to check it' }); } continue; } }
      { const sh = SIGNOFF_HOLD(inbox, it); if (sh) { it.waitingOn = 'signoff'; waitsOf[agentId][sh.who] = (waitsOf[agentId][sh.who] || 0) + 1; parked.push({ seat: agentId, name: NAMES[agentId] || agentId, inbox, heading: it.heading, kind: 'signoff', words: 'waiting for ' + sh.who + ' to sign off' }); continue; } }
      if (it.waitingOnLine == null) { const on = SP.waitingOn(it.status, NAMES, agentId, CEO_ID); if (on) { it.waitingOn = on; const n = on === 'owner' ? 'you (the owner)' : NAMES[on] || 'someone else'; waitsOf[agentId][n] = (waitsOf[agentId][n] || 0) + 1; parked.push({ seat: agentId, name: NAMES[agentId] || agentId, inbox, heading: it.heading, kind: 'status', words: 'waiting for: ' + n }); } continue; }
      // **Waiting on:** governs this item (its Status prose does not): resolved on every tick
      const pd = SP.parseDeps(it.waitingOnLine);
      if (pd.none) { it.waitSeats = []; continue; }   // "Waiting on: nothing": its own work, whatever the Status prose says
      const pw = prevWaits[it.heading];
      const seenAt = pw && pw.line === it.waitingOnLine ? pw.seenAt : Date.now();
      const since = sinceOf(it.heading, seenAt);
      for (const d of pd.deps) { d.since = since; d.self = { inbox, heading: it.heading }; }
      const r = SP.resolveDeps(pd.deps, LOOK);
      waitsNext[it.heading] = { line: it.waitingOnLine, seenAt, state: r.state };
      it.waitSeats = r.state === 'waiting' ? [...new Set(r.pending.map(d => d.kind === 'seat' ? d.seatId : d.kind === 'handoff' ? seatOfInbox(d.inbox) : null).filter(x => x && x !== agentId))] : [];
      if (r.state === 'waiting') {
        it.waitingOn = 'dep'; it.waitWords = pd.label || r.pending.map(d => d.words).join('; ');
        const n = it.waitSeats.length === 1 && r.pending.length === 1 ? NAMES[it.waitSeats[0]] || it.waitSeats[0] : it.waitWords.slice(0, 80);
        waitsOf[agentId][n] = (waitsOf[agentId][n] || 0) + 1;
        parked.push({ seat: agentId, name: NAMES[agentId] || agentId, inbox, heading: it.heading, kind: 'waiting', words: 'waiting for: ' + it.waitWords, deps: r.pending.map(d => d.raw) });
      } else if (r.state === 'unresolvable') {
        if (!pw || pw.state !== 'unresolvable' || pw.line !== it.waitingOnLine) log('WAITING ON UNRESOLVED ' + inbox + ' "' + it.heading.slice(0, 80) + '" (' + (NAMES[agentId] || agentId) + '): ' + (r.unresolved.map(d => d.raw).join('; ') || 'no dependency named') + ' — names nothing the dispatcher can find, so the item is work now (handoff-status.js tells the writer)');
      } else if (pw && pw.state === 'waiting') {
        const msg = (NAMES[agentId] || agentId) + ': ' + (pd.label || pd.deps.map(d => d.words).join('; ')) + ' — done; starting "' + askOf(it.heading).slice(0, 100) + '"';
        log('WAKE ' + msg); note(agentId, { key: 'dep:' + inbox + ':' + it.heading, kind: 'dependency', heading: it.heading, text: msg });
      }
    }
    stw.waits = waitsNext;
    if (apHolds[agentId]) {
      const secOf = new Map(txt.split(/^## /m).slice(1).map(sec => [sec.split('\n')[0].trim(), sec]));
      const hs = apHolds[agentId];
      const mentions = h => its.some(i => (secOf.get(i.heading) || '').includes(h.id));
      const blanket = hs.find(h => h.all && !h.heading && !mentions(h));   // names nothing: all of the asker's OPEN work waits
      for (const it of its) {
        if (it.waitingOn) continue;
        const sec = secOf.get(it.heading) || '';
        const h = hs.find(x => (x.heading && x.heading === it.heading) || sec.includes(x.id)) || blanket;
        if (!h) continue;
        it.waitingOn = 'owner'; it.approval = h.id; waitsOf[agentId]['you (the owner)'] = (waitsOf[agentId]['you (the owner)'] || 0) + 1;
      }
      const held = its.filter(i => i.approval);
      const hk = held.map(i => i.approval + ':' + i.heading).sort().join('|');
      const st0 = state.agents[agentId] = state.agents[agentId] || { key: '', count: 0 };
      if (hk !== (st0.approvalHold || '')) { st0.approvalHold = hk; if (hk) log('WAITING on approval ' + [...new Set(held.map(i => i.approval))].join(', ') + ' (' + agentId + '): ' + held.length + ' OPEN in ' + inbox + ' held until the owner answers; not woken, not counted as stalled'); }
    }
    const st = state.agents[agentId] || { key: '', count: 0 };
    const openSecs = new Map(txt.split(/^## /m).slice(1).map(sec => [sec.split('\n')[0].trim(), sec]).filter(([h]) => its.some(i => i.heading === h && !i.waitingOn && !i.released)));
    const nb = notBeforeDeferrals(openSecs, st.notBefore, nowStamp, { sprint: !!SPRINT });
    st.notBefore = nb.seen; delete st.deadlines;   // st.deadlines: the old Deadline-deferral memory, dropped (a Deadline defers nothing now)
    for (const it of its) if (nb.deferred.has(it.heading)) it.notBefore = nb.deferred.get(it.heading);   // not open work now: blocks nobody (blockersOf)
    // a Not before over its cap is ignored (the item is work now), logged once per item; the CEO gets one handoff about the rules
    const nbr = st.nbReleased || {}; st.nbReleased = {};
    for (const [h, x] of nb.ignored) {
      st.nbReleased[h] = nbr[h] || x.why;
      if (nbr[h]) continue;
      nbNotice.push({ inbox, heading: h, why: x.why, name: NAMES[agentId] || agentId });
      log('RELEASED ' + inbox + ' "' + h.slice(0, 80) + '" (' + (NAMES[agentId] || agentId) + '): ' + x.why + ' — treated as work now; ' + (x.dep ? 'it reads like a dependency: write **Waiting on:** instead' : 'for work that waits on other work write **Waiting on:**, or ask the CEO'));
    }
    for (const [h, d] of nb.deferred) { const i = nb.info.get(h) || {}; parked.push({ seat: agentId, name: NAMES[agentId] || agentId, inbox, heading: h, kind: 'notBefore', until: d, words: 'not before ' + G.whenWords(d, lpNow.date) + (i.reason ? ': ' + i.reason.slice(0, 120) : ''), dependencyShaped: !!i.dep }); }
    const open = its.filter(i => !i.waitingOn && !i.notBefore).map(i => i.heading).sort();
    st.deferred = [...new Set([...nb.deferred.keys()].concat(its.filter(i => i.waitingOn === 'dep' || i.waitingOn === 'audit').map(i => i.heading)))].sort().join('|');   // lanes.js skips these (an item with the lead for audit too)
    const dkey = [...nb.deferred.keys()].sort().join('|');
    if (dkey !== (st.nbKey || '')) { st.nbKey = dkey; if (dkey) log('WAITING handoffs ' + inbox + ' (' + agentId + '): ' + nb.deferred.size + ' OPEN set aside by their own Not before (nearest ' + [...nb.deferred.values()].sort()[0] + '): not woken, not counted as stalled'); }
    const due = deadlineOrder(openSecs, lpNow.date);
    wakeTextOf[agentId] = openSecs;
    wakeItemsOf[agentId] = byDue(open, due.due).map(h => { const it = its.find(i => i.heading === h) || {}; return { file: inbox, id: W.itemId(inbox, h, it.id), title: h, due: due.due.get(h) || null }; });
    st.nextDue = byDue(open, due.due).map(h => due.due.get(h)).find(Boolean) || null;   // the wake order across seats (soonest first)
    const dueNote = open.length ? [due.overdue.filter(h => open.includes(h)).length ? due.overdue.filter(h => open.includes(h)).length + ' overdue' : '', st.nextDue ? 'next due ' + st.nextDue : ''].filter(Boolean).join(', ') : '';
    // stalled = no PROGRESS across STALL_AFTER wakes (lib/stall.js), never "the set of OPEN headings is the same": a seat
    // working steadily through a dated backlog is not stuck, and re-dating a block is never progress
    const secAll = new Map(txt.split(/^## /m).slice(1).map(sec => [sec.split('\n')[0].trim(), sec]));
    const sigs = {}; for (const h of open) sigs[h] = STALL.bodySig(secAll.get(h) || '');
    const closedN = SP.parseItems(txt).filter(i => !i.open && i.status).length;
    // a start that never got to work (the provider refused it at its usage limit, a refusal, an outage) is not a run that
    // made no progress: give that wake back, so a quota outage never pages a seat as stuck (2026-11-18 03:03, Mara)
    { const from = st.progAt || Date.now() - 48 * 3600e3;
      const lost = stallRuns.filter(r => r.agentId === agentId && Number(r.endedAt) > from && r.reason !== 'done' && /quota|rate_limit|usage|overloaded|provider|content_policy|auth/.test(String(r.failureCode || ''))).length;
      if (lost) st.count = Math.max(0, (st.count || 0) - lost); }
    const pj = STALL.judge(st.prog || null, { sigs, closed: closedN, sent: sentBy(NAMES[agentId]), evidence: STALL.runEvidence(stallRuns, agentId, st.progAt || Date.now() - 48 * 3600e3) });
    st.blockWake = st.blockWake || {}; const wakesNow = st.wakes || 0;
    for (const h of open) if (!st.prog || !st.prog.sigs || st.prog.sigs[h] !== sigs[h]) st.blockWake[h] = wakesNow;
    for (const h of Object.keys(st.blockWake)) if (!open.includes(h)) delete st.blockWake[h];
    if (!st.prog || pj.moved) { st.count = 0; st.flagged = false; st.progWhy = pj.why.slice(0, 3); st.progAtWake = wakesNow; }   // progress: fresh budget
    st.prog = { sigs, closed: closedN, sent: sentBy(NAMES[agentId]) }; st.progAt = Date.now(); st.key = open.join('|');
    state.agents[agentId] = st;
    if (!open.length) continue;
    // Per-item wake counter: park any OPEN block unchanged across BLOCK_STALL_AFTER wakes (default STALL_AFTER*2),
    // hand it to the seat's manager once, and stop waking for it until its block body changes.
    st.parkedBlocks = st.parkedBlocks || {};
    st.softNoted = st.softNoted || {};
    for (const h of Object.keys(st.parkedBlocks)) {
      if (!open.includes(h)) { delete st.parkedBlocks[h]; continue; }
      if (st.parkedBlocks[h] !== sigs[h]) { delete st.parkedBlocks[h]; st.blockWake[h] = wakesNow; }
    }
    for (const h of Object.keys(st.softNoted)) if (!open.includes(h)) delete st.softNoted[h];
    if (st.count < STALL_AFTER) {
      const mgr = ((CREW || {})[agentId] || {}).manager || CEO_ID; const mi = inboxOf(mgr);
      for (const h of byDue(open, due.due)) {
        if (st.parkedBlocks[h]) continue;
        const n = wakesNow - (st.blockWake[h] != null ? st.blockWake[h] : wakesNow);
        if (n < BLOCK_STALL_AFTER) continue;
        st.parkedBlocks[h] = sigs[h];
        if (st.softNoted[h] !== st.blockWake[h]) {
          st.softNoted[h] = st.blockWake[h];
          const isDue = due.due.has(h) && due.due.get(h) <= lpNow.date;
          if (isDue) {
            const line = (NAMES[agentId] || agentId) + ' is working, but the due item "' + h.slice(0, 90) + '" (due ' + due.due.get(h) + ') has not moved in ' + n + ' runs';
            log('SLOW ' + inbox + ' (' + agentId + '): ' + line);
            if (mi && mgr !== agentId) appendHandoff(mi, line, { Need: 'nothing urgent: ' + (NAMES[agentId] || agentId) + ' is making progress elsewhere. Look at whether this item needs a decision, help or a new order of work.', Why: 'it is due and its block has not changed in ' + n + ' of ' + (NAMES[agentId] || agentId) + '\'s runs.', Deadline: 'none', Status: 'DONE — FYI' });
          } else {
            const line = (NAMES[agentId] || agentId) + ' is working, but the item "' + h.slice(0, 90) + '"' + (due.due.has(h) ? ' (due ' + due.due.get(h) + ')' : ' (undated)') + ' has not moved in ' + n + ' runs';
            log('PARKED ' + inbox + ' (' + agentId + '): ' + line + ' — handed to manager and stopped waking for it until changed');
            if (mi && mgr !== agentId) appendHandoff(mi, line, { Need: 'this item has sat unchanged across ' + n + ' of ' + (NAMES[agentId] || agentId) + '\'s runs and is now parked from waking ' + (NAMES[agentId] || agentId) + ' until its block changes. Look at whether it should be closed, re-scoped, or reassigned.', Why: 'its block has not changed in ' + n + ' of ' + (NAMES[agentId] || agentId) + '\'s runs.', Deadline: 'none', Status: 'DONE — FYI' });
          }
        }
      }
    }
    const activeOpen = open.filter(h => !st.parkedBlocks[h]);
    if (!activeOpen.length) continue;
    const stuck = STALL.stuckBlock(activeOpen, due.due, due.overdue, null);
    const stuckWords = stuck ? '"' + stuck.slice(0, 90) + '"' + (due.due.get(stuck) ? ' (due ' + due.due.get(stuck) + ')' : ' (undated)') : '';
    if (st.count >= STALL_AFTER) {
      stalledSeats.push(agentId);
      if (!st.flagged) {
        st.flagged = true; log('STALLED handoffs ' + inbox + ' (' + agentId + '): ' + activeOpen.length + ' OPEN and no progress in ' + STALL_AFTER + ' runs (no block changed, none closed or sent, no file written)' + (stuck ? '; ' + stuckWords + ' has not moved' : '') + ' — needs ' + CEO_NAME + ' (CEO)' + lastRunTail(findLoop(jobs, agentId)));
        // "needs the CEO" is said to the CEO, not only to the log: one OPEN handoff per stall (a new item set is a new stall)
        if (agentId !== CEO_ID && inboxOf(CEO_ID)) appendHandoff(inboxOf(CEO_ID), (NAMES[agentId] || agentId) + ' is stuck: no progress in ' + STALL_AFTER + ' runs' + (stuck ? ', starting with ' + stuckWords : ''), { Need: 'look at ' + inbox + (stuck ? ' (first ' + stuckWords + ')' : '') + ' and unblock it: answer what ' + (NAMES[agentId] || agentId) + ' is waiting for, re-scope the items, or mark them DONE/blocked with a reason. The dispatcher stops waking ' + (NAMES[agentId] || agentId) + ' for them until the set changes.', Why: 'the dispatcher woke ' + (NAMES[agentId] || agentId) + ' ' + STALL_AFTER + ' times for the same open items and nothing moved.', Items: activeOpen.slice(0, 6).join(' · ').slice(0, 600), Deadline: 'today', Status: 'OPEN' });
      }
      continue;
    }
    // Wake on change, not presence: only wake for new/changed/newly-due/released items, zero-progress stall retries,
    // or at most one slow-cadence backlog sweep per BACKLOG_SWEEP_DAYS company day(s).
    const hasPrevWake = !!(st.wokenSigs && typeof st.wokenSigs === 'object');
    const releasedHere = new Set(its.filter(i => i.released).map(i => i.heading).concat(Object.keys(st.nbReleased || {}).filter(h => !(nbr && nbr[h]))));
    const depWokeHere = new Set((st.wakeNotes || []).filter(n => n.kind === 'dependency' || n.kind === 'release').map(n => n.heading).filter(Boolean));
    const isFresh = h => !hasPrevWake || st.wokenSigs[h] === undefined || st.wokenSigs[h] !== sigs[h] ||
      (due.due.has(h) && due.due.get(h) <= lpNow.date && (st.wokenDueDay || {})[h] !== lpNow.date) ||
      releasedHere.has(h) || depWokeHere.has(h);
    const freshItems = byDue(activeOpen.filter(isFresh), due.due);
    const zeroProgressRetry = !pj.moved && st.count > 0 && st.count < STALL_AFTER;
    const sweepDue = !st.sweepDay || daysBetween(st.sweepDay, lpNow.date) >= BACKLOG_SWEEP_DAYS;
    if (!freshItems.length && !zeroProgressRetry) {
      if (!sweepDue) continue;
      if (!work[agentId]) backlogOnlyWake.add(agentId);
    }
    const ranges = blockLineRanges(txt);
    wakeItemsOf[agentId] = byDue(activeOpen, due.due).map(h => {
      const it = its.find(i => i.heading === h) || {};
      const rg = ranges.get(h) || null;
      return Object.assign({ file: inbox, id: W.itemId(inbox, h, it.id), title: h, due: due.due.get(h) || null }, rg ? { startLine: rg.startLine, endLine: rg.endLine } : {});
    });
    const focusHeadings = (freshItems.length ? freshItems : byDue(activeOpen, due.due)).slice(0, 5);
    focusItemsOf[agentId] = focusHeadings.map(h => {
      const it = its.find(i => i.heading === h) || {};
      const rg = ranges.get(h) || null;
      return { id: W.itemId(inbox, h, it.id), heading: h, startLine: rg ? rg.startLine : null, endLine: rg ? rg.endLine : null };
    });
    pendingWakeSigs[agentId] = {
      sigs: Object.fromEntries(activeOpen.map(h => [h, sigs[h]])),
      dueDay: Object.fromEntries(activeOpen.filter(h => due.due.has(h) && due.due.get(h) <= lpNow.date).map(h => [h, lpNow.date])),
      isSweep: !freshItems.length && !zeroProgressRetry,
    };
    const activeDueNote = [due.overdue.filter(h => activeOpen.includes(h)).length ? due.overdue.filter(h => activeOpen.includes(h)).length + ' overdue' : '', byDue(activeOpen, due.due).map(h => due.due.get(h)).find(Boolean) ? 'next due ' + byDue(activeOpen, due.due).map(h => due.due.get(h)).find(Boolean) : ''].filter(Boolean).join(', ');
    work[agentId] = work[agentId] || [];
    reason[agentId] = (reason[agentId] ? reason[agentId] + '; ' : '') + activeOpen.length + ' OPEN in ' + inbox + (activeDueNote ? ' (' + activeDueNote + ')' : '') + (pendingWakeSigs[agentId].isSweep ? ' [backlog sweep]' : '');
  }
  // Artifact wake: a quest with an artifact contract, every step ticked and its file already on disk is waiting on
  // exactly one thing — a run by its owner, because StarNet completes an artifact contract only in that agent's
  // run-end sweep. It is not "work" (no step is left) so nothing above wakes the loop, and the agent's own schedule
  // can be hours away, so a finished deliverable can sit unclosed all afternoon. Wake the owner ONCE per quest; if that run
  // ends and the quest is still open, flag it instead of waking it forever.
  state.artifactWait = state.artifactWait || {};
  const artifactWakes = {};   // agentId -> quest ids woken this tick (only a 200 start counts a wake)
  for (const q of quests) {
    if (q.status !== 'open' || !q.agentId || !q.contract || q.contract.type !== 'artifact') continue;
    if ((q.steps || []).some(s => !s.done)) continue;
    const key = String(q.contract.key || '').trim();
    if (!key || !fs.existsSync(path.join(ROOT, key))) continue;
    const w = state.artifactWait[q.id] = state.artifactWait[q.id] || { wakes: 0, flagged: false };
    if (w.wakes >= 1) {
      if (!w.flagged) { w.flagged = true; log('ARTIFACT STUCK ' + q.id + ' "' + q.title + '": `' + key + '` exists and every step is ticked, but the quest is still open after waking ' + q.agentId + ' — needs a manual check of its run-end sweep'); }
      continue;
    }
    work[q.agentId] = work[q.agentId] || [];
    (artifactWakes[q.agentId] = artifactWakes[q.agentId] || []).push(q.id);
    reason[q.agentId] = (reason[q.agentId] ? reason[q.agentId] + '; ' : '') + q.id + ' artifact present, awaiting run-end sweep';
  }
  // Owner wake: an unacknowledged owner message (company/owner/inbound.jsonl) wakes the CEO within ~10 minutes.
  // Same stall rule as handoffs: the same unread set after STALL_AFTER owner-wake runs => flag once and stop the fast wake.
  /* Owner messages addressed by NAME (owner-addressing.js): "Sam, get me a QA hire" goes to that seat's handoff inbox
     so the ordinary handoff path wakes them, instead of waiting for the CEO to relay it. Additive and fail-safe: it only
     WRITES handoff blocks for messages that open with a crew name (read from loops.json), every decision is recorded in
     company/state/owner-addressing.json, and an error here leaves the plain behaviour exactly as it is (the CEO reads all). */
  try {
    const addressed = require('./owner-addressing.js').dispatch({ apply: !DRY, limit: 20 });
    for (const r of addressed.routed) {
      if (r.addressee && r.to === 'agent') log('OWNER ADDRESSED ' + r.addressee + ' by name -> ' + (r.wroteTo || r.inbox) + (r.conflict ? ' (name over ' + r.questionId + ')' : ''));
      else if (r.addressee) log('OWNER ADDRESSED ' + r.addressee + ' (CEO) by name -> CEO inbox' + (r.conflict ? ' (name over ' + r.questionId + ')' : ''));
    }
  } catch (e) { log('ADDRESSING ERROR: ' + e.message); }
  const ownerWake = new Set();
  const unread = ownerUnread();
  let ownerKey = '';
  try { ownerKey = require('./owner-inbox.js').unacked().map(m => m.id).sort().join('|'); } catch (_) {}
  state.owner = state.owner || { key: '', count: 0 };
  if (ownerKey !== state.owner.key) state.owner = { key: ownerKey, count: 0, flagged: false };
  const ownerStalled = state.owner.count >= STALL_AFTER;
  if (unread && ownerStalled && !state.owner.flagged) { state.owner.flagged = true; log('STALLED owner messages: ' + unread + ' still unacknowledged after ' + STALL_AFTER + ' CEO runs; fast wake stopped, the CEO keeps the regular loop schedule'); }
  if (unread && CREW && !ownerStalled) for (const [agentId, c] of Object.entries(CREW)) {
    if (!c || !c.wakeOnOwnerMessage) continue;
    ownerWake.add(agentId);
    work[agentId] = work[agentId] || [];
    reason[agentId] = (reason[agentId] ? reason[agentId] + '; ' : '') + unread + ' owner message(s) unread';
  }
  // Hiring wakes: when a round's interviews are all in, the seat that must pick is woken now, past its cooldown, once
  // per round (state.hiringWake); a seat hired this tick has an OPEN first-session handoff and no last run, so the inbox
  // wake above already starts its first run.
  const hiringWake = new Map();   // agentId -> [round slugs]
  state.hiringWake = state.hiringWake || {};
  for (const { seat, slug } of hiringWakes(hiringRounds, state)) {
    if (!LOOP_OF[seat]) continue;
    hiringWake.set(seat, (hiringWake.get(seat) || []).concat([slug]));
    work[seat] = work[seat] || [];
    reason[seat] = (reason[seat] ? reason[seat] + '; ' : '') + 'pick waiting in hiring round ' + slug;
  }
  // Duty wakes (the sixth source): each due duty's items grouped by the seat they route to. Skipped when every item (or,
  // without items, its key) is already in an OPEN handoff to that seat or in its open quest; otherwise the same stall rule
  // as handoffs: the same duty key after STALL_AFTER wakes => flag once and stop.
  state.duties = state.duties || {};
  const p0Wake = new Set();   // seats with a P0 duty item (docs/SECURITY-WATCH.md): rest 0, ordered right after owner messages
  const seatOfRoute = r => { if (!r) return null; if (CREW && CREW[r]) return r; if (DR.safeRoute(r) && ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'].includes(r)) { const id = co.seatFor(r); return id && CREW && CREW[id] ? id : CEO_ID; } return CEO_ID; };
  for (const { d, st } of (dutyRun && dutyRun.due) || []) {
    const groups = new Map(); const items = Array.isArray(st.items) ? st.items : [];
    const push = (seat, it) => { if (!seat) return; if (!groups.has(seat)) groups.set(seat, []); if (it) groups.get(seat).push(it); };
    if (items.length) for (const it of items) push(seatOfRoute(it.route || st.route || d.route), it); else push(seatOfRoute(st.route || d.route), null);
    for (const [seat, its] of groups) {
      if (!LOOP_OF[seat]) continue;
      const inbox = inboxOf(seat);
      const texts = inbox ? openSectionTexts(path.join(ROOT, 'company', 'work', 'handoffs', inbox)) : [];
      const questText = quests.filter(q => q.status === 'open' && q.agentId === seat).map(q => [q.title].concat((q.steps || []).map(x => x.label || '')).join(' ')).join('\n');
      const inOpen = needle => texts.some(t => t.includes(needle)) || questText.includes(needle);
      if (its.length ? its.every(it => inOpen(it.id)) : inOpen(String(st.key))) continue;   // already somebody's open work
      const skey = seat + '|' + d.id; const k = String(st.key) + ':' + its.map(i => i.id).sort().join(',');
      const ds = state.duties[skey] || { key: '', count: 0 };
      if (ds.key !== k) { ds.key = k; ds.count = 0; ds.flagged = false; }
      state.duties[skey] = ds;
      if (ds.count >= STALL_AFTER) { if (!ds.flagged) { ds.flagged = true; log('STALLED duty ' + d.id + ' (' + seat + '): still due with key ' + String(st.key) + ' after ' + STALL_AFTER + ' runs — needs ' + CEO_NAME + ' (CEO)' + lastRunTail(findLoop(jobs, seat))); } continue; }
      const why = DR.sanitize(st.reason, 300);
      work[seat] = work[seat] || [];
      work[seat].push({ id: 'duty:' + d.id, why, duty: d, key: String(st.key), items: its.map(i => i.id), skey, priority: st.priority === 'P0' ? 'P0' : null, evidence: st.evidence || null });
      reason[seat] = (reason[seat] ? reason[seat] + '; ' : '') + (st.priority === 'P0' ? 'P0 ' : '') + 'duty:' + d.id + ' (' + why + ')';
      if (st.priority === 'P0') p0Wake.add(seat);   // a P0 (security-watch): woken at once, past its rest, ahead of other work
    }
  }
  // Watched jobs (the seventh source, company/tools/notify-when.js and service.js --wake): each completion row in
  // company/state/completions.jsonl wakes the seats it names once (a failure too, labelled as one), past their rest, under
  // every other rule (admit door dispatch, caps, tempo, halt: a halted tick never gets here, so the row waits for the resume).
  state.completionsSeen = state.completionsSeen || {};
  try {
    const firstTime = !Object.keys(state.completionsSeen).length && !state.completionsSince;
    state.completionsSince = state.completionsSince || new Date().toISOString();
    for (const r of CMP.recent(ROOT, 200)) {
      if (state.completionsSeen[r.id]) continue;
      state.completionsSeen[r.id] = Date.now();
      if (firstTime && Date.now() - Date.parse(r.endedAt || '') > 24 * 3600e3) continue;   // a first tick does not replay old history
      const failed = CMP.failed(r);
      for (const seat of [].concat(r.seat || [])) {
        if (!LOOP_OF[seat]) continue;
        log('JOB ' + (failed ? 'FAILED ' : 'ENDED ') + r.id + (r.job ? ' (job:' + r.job + ')' : '') + (r.service ? ' (service:' + r.service + ')' : '') + ': ' + CMP.words(r) + ' — waking ' + (NAMES[seat] || seat));
        const words = CMP.words(r);
        note(seat, Object.assign(
          { key: r.service ? 'service:' + r.service + ':' + (failed ? 'failed' : 'ok') : 'job:' + r.id, kind: 'completion', failed, id: r.id, words, baseWords: words, text: 'your ' + words + '; output tail in completions id ' + r.id },
          r.service ? { service: r.service, coalesceKey: 'svc:' + r.service + ':' + (failed ? 'failed' : 'ok'), routineService: !failed } : {}
        ));
      }
    }
    for (const [id, t] of Object.entries(state.completionsSeen)) if (Date.now() - t > 7 * 86400e3) delete state.completionsSeen[id];
    if (!DRY && typeof CMP.pruneDeadRunning === 'function') { const pruned = CMP.pruneDeadRunning(ROOT); if (pruned) log('WATCHED JOBS: pruned ' + pruned + ' stale dead-PID entry(ies)'); }
  } catch (e) { log('COMPLETIONS ERROR: ' + String(e.message).slice(0, 200)); }
  const wakeNotesMap = new Map();   // agentId -> all pending wake notes
  const urgent = new Map();         // agentId -> wake notes that bypass cooldown (rest 0: failures, one-shot jobs, deps, non-repeat service runs)
  state.serviceWakeAt = state.serviceWakeAt || {};
  for (const [k, t] of Object.entries(state.serviceWakeAt)) if (Date.now() - (Number(t) || 0) > 24 * 3600e3) delete state.serviceWakeAt[k];
  for (const [id, a] of Object.entries(state.agents || {})) {
    if (!a || !Array.isArray(a.wakeNotes)) continue;
    a.wakeNotes = a.wakeNotes.filter(n => Date.now() - (Number(n.at) || 0) < 24 * 3600e3);
    if (!a.wakeNotes.length) { delete a.wakeNotes; continue; }
    if (!LOOP_OF[id]) continue;
    wakeNotesMap.set(id, a.wakeNotes);
    const isRepeatRoutine = n => n.routineService && (Number(n.count) > 1 || (Date.now() - (Number(state.serviceWakeAt[id + ':' + n.service]) || 0) < 15 * 60e3));
    if (a.wakeNotes.some(n => !isRepeatRoutine(n))) urgent.set(id, a.wakeNotes);
    work[id] = work[id] || [];
    reason[id] = (reason[id] ? reason[id] + '; ' : '') + a.wakeNotes.map(n => n.kind === 'completion' ? (n.failed ? 'watched job FAILED: ' : 'watched job ended: ') + n.words + ' (' + n.id + ')' : n.text).join('; ');
  }
  // the parked items, for Work › Handoffs (plain words; the console's Start now writes company/state/gate-releases.jsonl)
  if (!DRY) { try { const pf = G.PARKED(ROOT); fs.mkdirSync(path.dirname(pf), { recursive: true }); fs.writeFileSync(pf, JSON.stringify({ _doc: 'written by dispatch.js every tick: OPEN handoff items set aside (Waiting on, Not before, a waiting Status); read by the console', at: new Date().toISOString(), items: parked }, null, 1) + '\n'); } catch (e) { log('PARKED ERROR: ' + String(e.message).slice(0, 160)); } }
  // existing companies: the first time a Not before is released by the caps, the CEO gets one handoff about the rules
  if (nbNotice.length && !state.gateRulesNotice && CEO_ID && inboxOf(CEO_ID)) {
    state.gateRulesNotice = new Date().toISOString();
    appendHandoff(inboxOf(CEO_ID), 'new rules: Waiting on for work that waits on work, Not before only for a real clock time', {
      Need: 'Read company/HANDOFFS.md (Waiting on, Not before). Use **Waiting on:** for anything that waits on other work: a handoff (to-<name>.md#<heading words>), a quest step (q:13 step x), a file (file: <path>), a service run (service: <name>), a job started with node company/tools/notify-when.js (job: <id>), a seat\'s item (seat: <name> — <heading words>); the holder is woken the tick it is met. Use **Not before:** only for a real clock time, with a reason after the date (a market opens, a provider\'s data release, a time someone outside named): at most 24 h ahead without such a reason, 72 h with one, 12 h in Sprint unless the reason is an external time. Never park work to look busy-free or to avoid stall checks. Rewrite the lines below as Waiting on where they wait on work (node company/tools/handoff-status.js shows them all), then set this DONE.',
      Why: 'the owner\'s ruling: get work done as soon as possible; work is never parked behind a guessed date. The dispatcher now ignores these lines and treats the items as work now: ' + nbNotice.slice(0, 12).map(x => x.name + ' "' + askOf(x.heading).slice(0, 60) + '" (' + x.why + ')').join('; ') + (nbNotice.length > 12 ? '; and ' + (nbNotice.length - 12) + ' more' : '') + '.',
      Deadline: 'today', Status: 'OPEN', Evidence: 'RELEASED lines in company/work/dispatch-log.md' });
    log('RULES NOTICE: told ' + CEO_NAME + ' (CEO) once about Waiting on and the Not before caps (' + nbNotice.length + ' released)');
  }
  // Scheduled loops (runtime.scheduler=dispatcher): a seat whose schedule came due since its last run is woken like any
  // other wake (admit(), cap, share, spread, pacer, tempo); with nothing else to do it is not held by its cooldown (its
  // schedule is its rest) and counts toward no stall. A seat switched off (scheduler.json on:false) is not scheduled.
  const schedWake = new Map();   // agentId -> { only: no other work, text }
  if (SCHED_MODE === 'dispatcher') {
    const seatsCad = (CADENCE && CADENCE.seats) || {};
    for (const agentId of Object.keys(LOOP_OF)) {
      const job = findLoop(jobs, agentId); if (!job) continue;
      const ow = schedState.owned[job.id]; if (ow && ow.on === false) continue;
      const sch = SCHED.scheduleOf(seatsCad[agentId], job); if (!sch) continue;
      const anchor = Date.parse(job.lastRunAt || '') || Date.parse(job.createdAt || '');
      const due = SCHED.lastDue(sch, anchor, Date.now(), co.TZ); if (!due) continue;
      schedWake.set(agentId, { only: !work[agentId], text: SCHED.schedText(sch) });
      work[agentId] = work[agentId] || [];
      reason[agentId] = (reason[agentId] ? reason[agentId] + '; ' : '') + 'scheduled loop (' + SCHED.schedText(sch) + ', due ' + co.localParts(new Date(due)).time + ')';
    }
  }
  // Owner messages first, then by revenue priority, then the seat whose open handoff is due soonest (its Deadline; an
  // undated inbox last), then in the order found. The priority exists so that when only MAX_PER_TICK loops can fire,
  // the ones the revenue line depends on are the ones that fire.
  // Ageing: a seat deferred AGE_AFTER ticks running goes ahead of priority (behind owner, P0, hiring and urgent wakes) on
  // the next tick (state.deferStreak, reset when the seat is not deferred), so a low-priority seat cannot lose the
  // per-tick cut for hours.
  const nextDue = id => ((state.agents[id] || {}).nextDue) || '9999';
  state.deferStreak = state.deferStreak || {};
  const aged = id => isAged(state.deferStreak, id, AGE_AFTER);
  const isBacklogOnly = id => backlogOnlyWake.has(id) && !(work[id] && work[id].length) && !ownerWake.has(id) && !p0Wake.has(id) && !hiringWake.has(id) && !urgent.has(id) && !artifactWakes[id] && !schedWake.has(id);
  const order = Object.keys(work).sort((a, b) =>
    ((ownerWake.has(b) ? 1 : 0) - (ownerWake.has(a) ? 1 : 0)) || ((p0Wake.has(b) ? 1 : 0) - (p0Wake.has(a) ? 1 : 0)) || ((hiringWake.has(b) ? 1 : 0) - (hiringWake.has(a) ? 1 : 0)) || ((urgent.has(b) ? 1 : 0) - (urgent.has(a) ? 1 : 0)) || ((isBacklogOnly(a) ? 1 : 0) - (isBacklogOnly(b) ? 1 : 0)) || ((aged(b) ? 1 : 0) - (aged(a) ? 1 : 0)) || (prio(b) - prio(a)) || nextDue(a).localeCompare(nextDue(b)));
  // ---- Sprint: what each seat has to do now (its signature), the Sprint numbers, effort per seat, lanes ----
  const sigOf = id => SP.workSig([(work[id] || []).map(q => q.id + ':' + (q.duty ? q.key : (state.quests[q.id] || {}).done)), (state.agents[id] || {}).key || '',
    ownerWake.has(id) ? state.owner.key : '', hiringWake.get(id) || [], artifactWakes[id] || [], (wakeNotesMap.get(id) || []).map(n => n.key)]);
  let SM = null; const laneHeld = []; const spreadHeld = [];
  state.sprintSig = state.sprintSig || {};
  if (SPRINT) {
    MAX_PER_TICK = Math.max(MAX_PER_TICK, Object.keys(LOOP_OF).length);
    SM = readJson(SPRINT_METRICS, null) || {};
    if (SM.since !== SPRINT.since) { SM = { since: SPRINT.since, wakes: 0, resolved: 0, idleWakes: 0, itemsDone: 0, pending: {}, seen: {}, lanes: {} }; state.sprintSig = {}; }
    for (const inbox of new Set(Object.values(INBOX_OF))) {   // items done: OPEN headings that are no longer OPEN
      const cur = openHandoffs(path.join(ROOT, 'company', 'work', 'handoffs', inbox)); const prev = SM.seen[inbox];
      if (Array.isArray(prev)) SM.itemsDone += prev.filter(x => !cur.includes(x)).length;
      SM.seen[inbox] = cur;
    }
    const resolveMs = (Number(process.env.DISPATCH_SPRINT_RESOLVE_SEC) >= 0 && process.env.DISPATCH_SPRINT_RESOLVE_SEC !== undefined ? Number(process.env.DISPATCH_SPRINT_RESOLVE_SEC) : 60) * 1000;
    for (const [id, p] of Object.entries(SM.pending || {})) {   // a wake that has finished: did its seat's work change?
      const job = findLoop(jobs, id);
      if (job && (job.inFlight || job.state === 'running')) continue;
      if (Date.now() - p.at < resolveMs) continue;
      SM.resolved++; if (sigOf(id) === p.sig) SM.idleWakes++;
      delete SM.pending[id];
    }
    const effort = {}; SM.lanes = {};
    for (const id of Object.keys(LOOP_OF)) {
      const inbox = (CREW && CREW[id] && CREW[id].inbox) || null;
      let items = []; if (inbox) { try { items = SP.parseItems(fs.readFileSync(path.join(ROOT, 'company', 'work', 'handoffs', inbox), 'utf8')); } catch (_) {} }
      effort[id] = SP.effortOf(items);
      const isCeo = id === CEO_ID;
      const plan = SP.lanePlan(items, { lanes: SPRINT.lanes, isCeo });
      const job = findLoop(jobs, id);
      // the main loop is one lane; company/tools/lanes.js (the hook after the pacer) starts the extra ones, sets max/why
      // from what the station allows (patch 0012) and logs why lanes are held
      const max = 1;
      SM.lanes[id] = { running: job && (job.inFlight || job.state === 'running') ? 1 : 0, max, possible: plan.lanes.length, wanted: isCeo ? 1 : Math.max(1, Number(SPRINT.lanes) || 1),
        why: isCeo ? 'the CEO works one run at a time' : plan.lanes.length > 1 ? 'StarNet lets only one run of an agent write files or use the shell at a time (patch 0012 not applied)' : plan.why };
      if (plan.lanes.length > 1 && max < plan.lanes.length) laneHeld.push(((CREW[id] || {}).name || id) + ' (' + plan.lanes.length + ' independent)');
    }
    const eff = { _doc: 'Sprint: seats whose open items are all Effort: mechanical (models.js keeps Claude for reasoning work)', sprint: true, since: SPRINT.since, seats: effort };
    if (JSON.stringify((readJson(SPRINT_EFFORT, {}) || {}).seats) !== JSON.stringify(effort) && !DRY) { try { fs.mkdirSync(path.dirname(SPRINT_EFFORT), { recursive: true }); fs.writeFileSync(SPRINT_EFFORT, JSON.stringify(eff, null, 1) + '\n'); } catch (_) {} }
    const lk = laneHeld.join(', ');
    state.sprintLaneKey = lk;
  } else if ((readJson(SPRINT_EFFORT, {}) || {}).sprint && !DRY) { try { fs.writeFileSync(SPRINT_EFFORT, JSON.stringify({ sprint: false, seats: {} }) + '\n'); } catch (_) {} }
  // Sprint spreads the daily metered cap over the company day: the last hour's metered spend, and the hours left
  // (the cap's own numerator, cap-numerator.js meteredSince; runsSince() returns hours of slack before the window, so summing
  // it read the last ~7 h as "the last hour")
  const lastHourMetered = (() => { if (!SPRINT) return 0; if (CAPNUM && typeof CAPNUM.meteredSince === 'function') return CAPNUM.meteredSince(Date.now() - 3600e3); const since = Date.now() - 3600e3; let u = 0; for (const r of runsSince(since)) if (Number(r.startedAt) >= since && !UNMETERED_PROVIDERS.includes(String(r.provider || '')) && Number.isFinite(Number(r.usd))) u += Number(r.usd); return u; })();
  // who waits on whom (lib/sprint.js blockersOf): a seat others are waiting on is never held by the spread
  const blockers = SP.blockersOf({ items: itemsOf, names: NAMES, ceo: CEO_ID, stalled: stalledSeats.concat(Object.values(quests).filter(q => q && q.agentId && (state.quests[q.id] || {}).count >= STALL_AFTER && q.status === 'open').map(q => q.agentId)) });
  const waitersOf = id => (blockers[id] || []).map(x => NAMES[x] || x);
  const seatSay = {}; const say = (id, o) => { if (!seatSay[id]) seatSay[id] = SS.entry(o); };   // the first decision about a seat this tick is its reason
  const moneyHolds = [];
  const hoursLeft = (() => { const lp = co.localParts(); return Math.max(1, 24 - (Number(lp.hour) || 0) - (Number(lp.minute) || 0) / 60); })();
  // seats in the owner's meeting while a round runs (lib/meetings.js) are neither idle nor wakable: no wake, no lane, no
  // re-fire for them this tick (no double runs); the next tick after the round wakes them as usual
  // the same for a live chat with the owner (a reply being written, or colleagues brought into it while a round runs)
  { const inMeeting = [], inChat = []; try { const MT = require('./lib/meetings'); for (const id of order) { const b = MT.busy(id); if (b) (b.kind === 'huddle' || b.kind === 'chat' ? inChat : inMeeting).push(id); } } catch (_) {}
    for (const id of inMeeting) { order.splice(order.indexOf(id), 1); say(id, { state: 'held', why: 'in the owner\'s meeting' }); }
    for (const id of inChat) { order.splice(order.indexOf(id), 1); say(id, { state: 'held', why: 'in a live chat with the owner' }); }
    if (inMeeting.length) log('MEETING HOLD: ' + inMeeting.map(id => (CREW[id] || {}).name || id).join(', ') + ' (in the owner\'s meeting; woken after the round)');
    if (inChat.length) log('MEETING HOLD: ' + inChat.map(id => (CREW[id] || {}).name || id).join(', ') + ' (in a live chat with the owner; woken after it)'); }
  // a seat working a child run its lead delegated (team.dispatch: the worker's own agentId, its loop routine idle) is busy:
  // no wake and no lane on top of it this tick (lib/family.js). From the station's run table (GET
  // /api/state/snapshot); an unreadable table holds nobody (as before). One log line per change.
  { let liveKids = new Map();
    try { const sr = await call('GET', '/api/state/snapshot'); if (sr.status === 200) liveKids = FAM.liveChildSeats((JSON.parse(sr.body) || {}).runs); } catch (_) {}
    LIVE_KIDS = liveKids;   // the delegation allowlist reads them too (a worker on a live child run is busy; a split whose workers started is used)
    const busy = order.filter(id => liveKids.has(id));
    for (const id of busy) { order.splice(order.indexOf(id), 1); say(id, { state: 'working' }); }
    const bk = busy.map(id => id + ':' + liveKids.get(id).join('+')).sort().join(',');
    if (bk !== (state.delegatedBusy || '')) { state.delegatedBusy = bk; if (busy.length) log('DELEGATED BUSY: ' + busy.map(id => ((CREW[id] || {}).name || id) + ' (child run ' + liveKids.get(id).map(x => String(x).slice(0, 12)).join(', ') + ')').join('; ') + ': working a task its lead delegated; not woken on top of it'); } }
  // advisor leads (lib/consult.js consultStep, fail-safe): stuck consults, each live lead's advise routine and its batched advise run (door consult), the lead kept out of `order` while it advises, the auto-pause
  // accountable leads (lib/accountable.js auditStep, fail-safe): each live lead's audit routine and its audit run (door audit) on the department's FIXED audit model, the lead kept out of `order` while it audits, the fall back when the saving does not show
  try { await require('./lib/accountable').auditStep({ dry: DRY, log, jobs, order, say, call, fireRun, modes, allowAsk: ALLOW_ASK, budget: { capOn: CAP_ON, capped, dailyUsd: DAILY_USD, perAgentUsd: PER_AGENT_USD, byAgent, spent, lastHourMetered, hoursLeft, spread: !!(SPRINT && SPRINT.spreadDailyCap), unmetered: UNMETERED_PROVIDERS } }); } catch (e) { log('ACCOUNTABLE ERROR: ' + String(e.message).slice(0, 200)); }
  try { await require('./lib/consult').consultStep({ dry: DRY, log, jobs, order, say, call, fireRun, modes, allowAsk: ALLOW_ASK, budget: { capOn: CAP_ON, capped, dailyUsd: DAILY_USD, perAgentUsd: PER_AGENT_USD, byAgent, spent, lastHourMetered, hoursLeft, spread: !!(SPRINT && SPRINT.spreadDailyCap), unmetered: UNMETERED_PROVIDERS } }); } catch (e) { log('CONSULT ERROR: ' + String(e.message).slice(0, 200)); }
  let fired = 0; try { const pace = await require('./pacer.js').dispatchHook({ dry: DRY, log, jobs, order, ownerWake, maxPerTick: MAX_PER_TICK }); fired = -Math.max(0, Math.min(2, Number(pace && pace.extra) || 0)); } catch (e) { fired = 0; log('PACER ERROR: ' + e.message); }   // pacer.js (fail-safe): may drop metered wakes held near the station rail from `order`, and lends extra per-tick slots by starting `fired` below 0
  // Sprint lanes (company/tools/lanes.js, fail-safe, after the pacer so it sees what the pacer held and the models it set):
  // ends finished, timed-out or cut-off lanes, starts lanes for seats with independent OPEN items within the same money
  // and tempo rules as a wake, and takes a seat out of `order` when live lanes own all its open items
  // the router (lib/routing.js): one context per tick; null without a routing policy (every wake on its chain, as before)
  const ROUTING = await RT.prepare({ root: ROOT, jobs, log, dry: DRY });
  try { await require('./lanes.js').dispatchHook({ routing: ROUTING, dry: DRY, log, jobs, work, reason, order, ownerWake, hiringWake, modes, allowAsk: ALLOW_ASK, state, sprint: SPRINT, metrics: SM, budget: { capOn: CAP_ON, capped, dailyUsd: DAILY_USD, perAgentUsd: PER_AGENT_USD, byAgent, spent, lastHourMetered, hoursLeft, spread: !!(SPRINT && SPRINT.spreadDailyCap), unmetered: UNMETERED_PROVIDERS } }); } catch (e) { log('LANES ERROR: ' + String(e.message).slice(0, 200)); }
  const deferred = []; const deferredIds = new Set();
  for (const agentId of order) {
    const qs = work[agentId];
    if (fired >= MAX_PER_TICK) { deferred.push((CREW[agentId] || {}).name || agentId); deferredIds.add(agentId); state.deferStreak[agentId] = (Number(state.deferStreak[agentId]) || 0) + 1; say(agentId, { state: 'held', why: 'has work, waiting for a free slot (' + MAX_PER_TICK + ' starts per check); next check picks it up' }); continue; }
    if (!LOOP_OF[agentId]) continue;   // not on the crew (for example a departed person's leftover quest): nothing to wake
    const job = findLoop(jobs, agentId);
    if (!job) { log('NO LOOP for ' + agentId + ': no routine matches "' + (LOOP_OF[agentId] || '?') + '"'); continue; }
    const ownedOn = SCHED_MODE === 'dispatcher' && schedState.owned[job.id] && schedState.owned[job.id].on !== false;   // paused on the station because the dispatcher starts it
    if (job.enabled === false && !ownedOn) { log('DISABLED loop "' + job.name + '" for ' + agentId + ' — routine exists but is disabled; not fired'); say(agentId, { state: 'held', why: 'has work, but its routine "' + job.name + '" is switched off' }); continue; }
    if (job.inFlight || job.state === 'running') { say(agentId, { state: 'working' }); continue; }
    const last = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
    const ownCooldown = CREW && CREW[agentId] && Number(CREW[agentId].cooldownMin) > 0 ? Number(CREW[agentId].cooldownMin) * 60000 : COOLDOWN_MS;   // per-person rest, loops.json cooldownMin
    // rest: the seat's cooldown (owner message: the short one); in Sprint only the floor when its work changed since its last wake
    const sig = SPRINT ? sigOf(agentId) : null;
    const rest = (schedWake.get(agentId) || {}).only ? { ms: 0, fast: false } : SP.restMs({ baseMs: ownerWake.has(agentId) ? OWNER_COOLDOWN_MS : ownCooldown, sprint: !!SPRINT, changed: !!SPRINT && state.sprintSig[agentId] !== sig, floorMin: SPRINT && SPRINT.cooldownFloorMin, unchangedMin: SPRINT && SPRINT.unchangedRestMin, hiring: hiringWake.has(agentId) || urgent.has(agentId) || p0Wake.has(agentId) });
    if (Date.now() - last < rest.ms) { say(agentId, { state: 'resting', changed: rest.fast || !SPRINT, at: co.localParts(new Date(last + rest.ms)).time, waits: waitsOf[agentId] }); continue; }
    if (!ALLOW_ASK && modes[agentId] === 'ask') { askHeld.push(job.name + ' (' + agentId + ')'); say(agentId, { state: 'held', why: 'has work, but its approval mode is "ask", so an unattended run could not save anything' }); continue; }   // due, but cannot save unattended
    // the global USD cap, then this agent's share (an owner message is never held; a subscription loop is not metered).
    // With the spendCap guardrail off nothing is held; the loop runs and is listed once in the log.
    const cap = A.money({ capOn: CAP_ON, capped, metered: isMetered(job), ownerWake: ownerWake.has(agentId), share: { usd: PER_AGENT_USD, spent: byAgent[agentId] } }).verdict;
    const moneyHold = kind => { moneyHolds.push({ seat: agentId, name: NAMES[agentId] || agentId, kind, waiting: waitersOf(agentId) }); say(agentId, { state: 'held-money', kind, waiting: waitersOf(agentId) }); };
    if (cap === 'held') { held.push(job.name); moneyHold('cap'); continue; }
    if (cap === 'perAgentHeld') { perAgentHeld.push(job.name); moneyHold('perAgent'); continue; }
    if (cap === 'wouldHold') wouldHold.push(job.name);
    if (cap === 'run') {
      // Sprint spreads the daily cap (lib/admit.js money(), the copy lanes.js uses): never the seat others wait on (blockers)
      const m = A.money({ capOn: CAP_ON, metered: isMetered(job), ownerWake: ownerWake.has(agentId), spread: { on: !!(SPRINT && SPRINT.spreadDailyCap), cap: DAILY_USD, spent24h: spent, spentLastHour: lastHourMetered, hoursLeft, blocking: waitersOf(agentId) } });
      if (m.verdict === 'spread') { spreadHeld.push(job.name + ' — ' + m.why); moneyHold('spread'); continue; }
    }
    { const tempo = require('./cadence.js').tempoAllows(agentId, Date.now(), { record: false, ownerWake: ownerWake.has(agentId) }); if (!tempo.ok) { log('TEMPO HOLD ' + job.name + ' for ' + agentId + ': ' + tempo.reason); say(agentId, { state: 'held', why: 'has work, held by the wake limits: ' + tempo.reason }); continue; } }   // wake caps (cadence.json bounds): an owner message is never held but still counts
    const names = reason[agentId];
    const viaInbox = names.includes(' OPEN in ');
    const focusList = viaInbox ? (focusItemsOf[agentId] || []) : [];
    const focusNote = focusList.length ? focusList.map(x => (x.id || '?') + (x.startLine ? ' L' + x.startLine + '-' + x.endLine : '') + ' "' + askOf(x.heading).slice(0, 40) + '"').join(', ') : '';
    if (DRY) { A.admit({ door: 'dispatch', kind: 'run', seat: agentId, jobId: job.id, why: names }, { dry: true }); log('WOULD run ' + job.name + ' for ' + agentId + ' (' + names + ')' + (focusNote ? ' [items: ' + focusNote + ']' : '')); fired++; say(agentId, { state: 'started', why: names + (focusNote ? ' — items: ' + focusNote : '') }); continue; }
    // the router's decision for this wake: recorded always (with a policy), applied as a one-run override only when live and open.
    // The class rules always hold: a wake whose own pair they deny and no allowed entry is open is held, never started on it.
    const wakeId = W.newWakeId(Date.now());
    const route = ROUTING ? RT.forWake(ROUTING, { seat: agentId, wakeId, job, items: viaInbox ? (wakeItemsOf[agentId] || []).map(i => ({ text: (wakeTextOf[agentId] && wakeTextOf[agentId].get(i.title)) || '', id: i.id, file: i.file })) : [] }) : null;
    if (route && route.hold) {
      log('ROUTE HOLD ' + job.name + ' for ' + agentId + ': ' + route.holdWhy);
      RT.record(ROUTING, { wakeId, seat: agentId, door: 'dispatch', jobId: job.id, runId: null, status: 'held', route });
      say(agentId, { state: 'held', why: 'has work, but its model may not do this kind of work and no allowed model is open right now; it starts when one opens' });
      continue;
    }
    const tk = A.admit({ door: 'dispatch', kind: 'run', seat: agentId, jobId: job.id, provider: (job.wire && job.wire.provider) || job.provider, model: (job.wire && job.wire.model) || job.model, priority: waitersOf(agentId).length ? 'blocking' : null, why: names, owner: ownerWake.has(agentId) });   // phase 1: allow, recorded; a refusal block holds
    if (tk.memoryEdge === 'start') log('MEMORY HOLD: new work waits, the computer is short of memory (' + tk.reason.replace(/^memory: /, '') + '); owner chats and health checks still run');
    if (tk.memoryEdge === 'lift') log('MEMORY HOLD LIFTED: enough memory is free again; new work starts');
    if (tk.decision === 'hold' && tk.memory) { say(agentId, { state: 'held', why: 'has work, but the computer is short of memory; it starts when memory is free again' }); continue; }
    if (tk.decision === 'hold' && tk.noModel) {
      say(agentId, { state: 'held', why: 'none of its models can run right now (limits or the daily budget); it starts when one opens' });
      state.noModelAlerts = state.noModelAlerts || {};
      const nkey = agentId + ':' + String(tk.reason || '').slice(0, 120);
      const na = state.noModelAlerts[agentId] || { key: '', ticks: 0, alerted: false };
      if (na.key !== nkey) { na.key = nkey; na.ticks = 0; na.alerted = false; }
      na.ticks++;
      state.noModelAlerts[agentId] = na;
      // the same hold is logged when it starts, then at most hourly (a day-long hold was ~140 identical lines)
      if (na.ticks === 1 || !(Date.now() - (na.loggedAt || 0) < NO_MODEL_LOG_MS)) {
        na.loggedAt = Date.now();
        log('NO MODEL HOLD ' + job.name + ' for ' + agentId + ': ' + tk.reason + (na.ticks > 1 ? ' (still held, ' + na.ticks + ' checks)' : ''));
      }
      const nThresh = agentId === CEO_ID ? 2 : 6;
      if (!DRY && !na.alerted && na.ticks >= nThresh) {
        na.alerted = true;
        const who = NAMES[agentId] || agentId;
        const plain = who + ' has been paused for several checks because none of its assigned AI models are available right now. Add a fallback model or wait for the usage limit to reset.';
        try {
          require('./lib/owner-notice').send({ kind: agentId === CEO_ID ? 'urgent' : 'fyi', from: CEO_NAME, text: plain, technical: 'NO MODEL HOLD ' + job.name + ' (' + agentId + '): ' + tk.reason, key: 'no-model-hold:' + agentId + ':' + require('crypto').createHash('sha256').update(nkey).digest('hex').slice(0, 10) });
        } catch (_) {}
      }
      continue;
    }
    if (tk.decision === 'hold' && tk.quota) { log('QUOTA HOLD ' + job.name + ' for ' + agentId + ': ' + tk.reason); say(agentId, { state: 'held', why: 'its model is at its usage limit; it waits for the limit to reset or its next model' }); continue; }
    if (tk.decision === 'hold') {
      log('REFUSAL HOLD ' + job.name + ' for ' + agentId + ': ' + tk.reason);
      say(agentId, { state: 'held', why: 'its model refused a run; it waits for its next model' });
      state.refusalAlerts = state.refusalAlerts || {};
      const rkey = agentId + ':' + String(tk.reason || '').slice(0, 120);
      const ra = state.refusalAlerts[agentId] || { key: '', ticks: 0, alerted: false };
      if (ra.key !== rkey) { ra.key = rkey; ra.ticks = 0; ra.alerted = false; }
      ra.ticks++;
      state.refusalAlerts[agentId] = ra;
      // Escalate promptly so a blocked seat (especially CEO) never sits dark for hours without anyone noticing.
      const threshold = agentId === CEO_ID ? 1 : 2;
      if (!DRY && !ra.alerted && ra.ticks >= threshold) {
        ra.alerted = true;
        const who = NAMES[agentId] || agentId;
        const plain = agentId === CEO_ID
          ? who + ' cannot run right now because the AI safety filter blocked its current model. Please switch its model or clear the block so work can resume.'
          : who + ' is paused because the AI safety filter blocked its current model across repeated checks. Please switch its model or clear the block.';
        try {
          require('./lib/owner-notice').send({ kind: 'urgent', from: CEO_NAME, text: plain, technical: 'REFUSAL HOLD ' + job.name + ' (' + agentId + '): ' + tk.reason, key: 'refusal-hold:' + agentId + ':' + require('crypto').createHash('sha256').update(rkey).digest('hex').slice(0, 10) });
        } catch (_) {}
      }
      continue;
    }
    // the wake counts toward the tempo caps only now, past every hold (cadence.js recordWake)
    try { require('./cadence.js').recordWake(agentId, Date.now(), { ownerWake: ownerWake.has(agentId) }); } catch (_) {}
    log('RUN ' + job.name + ' for ' + agentId + ' (' + names + ')' + (focusNote ? ' [items: ' + focusNote + ']' : '') + (rest.fast ? ' [Sprint: new work; rest ' + SPRINT.cooldownFloorMin + ' min]' : ''));
    fired++;
    // a duty wake hands the agent its reason: one OPEN handoff in its inbox, ids and counts only (dedup reads it next tick)
    const wroteItems = [];   // blocks this wake writes into the inbox: they are what it is for, too (wakes.jsonl)
    for (const q of qs) if (q.duty && inboxOf(agentId)) wroteItems.push(appendHandoff(inboxOf(agentId), (q.priority === 'P0' ? 'P0 ' : '') + 'duty ' + q.duty.id + ': ' + q.why.slice(0, 160), Object.assign({ Need: (q.duty.why ? q.duty.why + '. ' : '') + 'The check says: ' + q.why + '. Fix the cause or hand it to whoever can; the duty clears this by itself once the check passes. See it again: `node ' + (q.duty.source === 'company/tools/duties.js' ? 'company/tools/' : q.duty.source.replace(/module\.json$/, '')) + q.duty.tool + ' --duty`.', Why: 'a read-only duty check found it (docs/DUTIES.md); the dispatcher woke you for it.', Duty: q.duty.id + ' key ' + q.key + (q.items.length ? ' items ' + q.items.join(', ') : ''), Deadline: 'today' }, q.priority === 'P0' ? { Priority: 'P0 — work this before anything else; the owner is told it is being fixed' } : {}, { Status: 'OPEN' }, q.evidence ? { Evidence: q.evidence } : {})));
    // Fire detached: the run is admitted on a 200 and then keeps going after we close the socket, so a long
    // loop can never be cancelled by this tick's own hold (a run tied to the request socket dies with it).
    // Only a 200 counts toward the stall budget — a refused start (409/400) is not a run.
    // a watched job's end hands the seat its context: one notice in its inbox (a failure is OPEN work; a success is DONE, a note)
    for (const n of (wakeNotesMap.get(agentId) || [])) if (n.kind === 'completion' && !n.written && inboxOf(agentId)) {
      n.written = true;
      const wh = appendHandoff(inboxOf(agentId), (n.failed ? 'FAILED: ' : '') + n.words.slice(0, 140), { Need: n.failed ? 'the job failed. Read its output tail (`node company/tools/notify-when.js show ' + n.id + '`; the whole log under scratch/jobs/), fix or re-run it (through notify-when.js again), then set this DONE.' : 'carry on with the work that waited for it. Its output tail: `node company/tools/notify-when.js show ' + n.id + '`.', Why: 'you asked to be woken when it ended (company/tools/notify-when.js)', Deadline: 'today', Status: n.failed ? 'OPEN' : 'DONE — a notice, nothing to close', Evidence: 'company/state/completions.jsonl ' + n.id });
      if (n.failed) wroteItems.push(wh);
    }
    { const rl = RT.line(agentId, route); if (rl) log(rl); }
    let r = await fireRun(job.id, RT.overrideOf(route));
    if (route && route.applied && r.status === 403 && route.chainDenied) {   // refused, and the chain's pair is denied for the class: held, never run on it
      route.reasons.push('the station refused the override (HTTP 403 ' + String(r.body).slice(0, 120) + '); the chain is denied (' + route.chainDenied + '): held');
      route.applied = false; route.hold = true; route.holdWhy = 'the station refused the override and the class rules deny the chain (' + route.chainDenied + ')';
      if (route.scoped && route.scoped.applied) Object.assign(route.scoped, { applied: false, override: false, runs: null, note: 'the station refused the override: held' });
      log('ROUTE HOLD ' + job.name + ' for ' + agentId + ': ' + route.holdWhy);
    } else if (route && route.applied && r.status === 403) {   // the station's gate refused the override: run on the chain, as without one
      route.reasons.push('the station refused the override (HTTP 403 ' + String(r.body).slice(0, 120) + '); ran on the chain');
      route.applied = false; route.wouldApply = { source: route.source, provider: route.provider, model: route.model }; route.source = 'chain';
      const cp = (job.wire && job.wire.provider) || job.provider, cm = (job.wire && job.wire.model) || job.model; route.provider = cp || null; route.model = cm || null; delete route.effort; delete route.trial; delete route.arm;
      if (route.scoped && route.scoped.applied) Object.assign(route.scoped, { applied: false, override: false, runs: cp && cm ? cp + '/' + cm : null, note: 'the station refused the override: ran on the chain' });
      log('ROUTE ' + agentId + ': the station refused the override; running on the chain');
      r = await fireRun(job.id);
    }
    const runId = r.status === 200 ? W.runIdOf(r.body) : null;
    if (route) RT.record(ROUTING, { wakeId, seat: agentId, door: 'dispatch', jobId: job.id, runId, status: r.status, route });
    A.started(tk, Object.assign({}, r, { runId }));
    say(agentId, r.status === 200 ? { state: 'started', why: names } : { state: 'held', why: 'has work; the station refused the start (HTTP ' + r.status + ')' });
    if (r.status === 200) {
      // run-to-item link (measurement only): which handoff items this run is for
      { const ib = inboxOf(agentId); const items = viaInbox ? (wakeItemsOf[agentId] || []).slice() : [];   // inbox items only when the inbox is why it woke
        for (const h of wroteItems) if (ib && h) items.push({ file: ib, id: W.itemId(ib, h), title: h, due: today() });
        W.record({ wakeId, seat: agentId, runId, admitId: tk.id, jobId: job.id, door: 'dispatch', items, why: names, route: route || undefined, profile: (() => { try { return require('./lib/profile').wakeStamp(agentId, { root: ROOT }); } catch (_) { return undefined; } })() }); }
      for (const q of qs) { if (q.duty) state.duties[q.skey].count++; else state.quests[q.id].count++; }
      for (const qid of (artifactWakes[agentId] || [])) state.artifactWait[qid].wakes++;   // a real start is a wake
      if (viaInbox) {
        state.agents[agentId].count++;
        state.agents[agentId].wakes = (state.agents[agentId].wakes || 0) + 1;
        if (pendingWakeSigs[agentId]) {
          state.agents[agentId].wokenSigs = pendingWakeSigs[agentId].sigs;
          state.agents[agentId].wokenDueDay = Object.assign({}, state.agents[agentId].wokenDueDay || {}, pendingWakeSigs[agentId].dueDay);
          for (const k of Object.keys(state.agents[agentId].wokenDueDay)) if (!(k in pendingWakeSigs[agentId].sigs)) delete state.agents[agentId].wokenDueDay[k];
          state.agents[agentId].sweepDay = lpNow.date;
        }
      }
      if (ownerWake.has(agentId)) state.owner.count++;
      for (const slug of (hiringWake.get(agentId) || [])) state.hiringWake[slug] = new Date().toISOString();   // spent: once per round
      if (wakeNotesMap.has(agentId)) {
        for (const n of (wakeNotesMap.get(agentId) || [])) if (n.routineService && n.service) state.serviceWakeAt[agentId + ':' + n.service] = Date.now();
        delete state.agents[agentId].wakeNotes;   // spent: one wake per completion, release or met dependency
      }
      if (SPRINT) { state.sprintSig[agentId] = sig; SM.wakes++; SM.pending[agentId] = { at: Date.now(), sig }; }
      fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    } else {
      log('  ' + job.name + ' refused: HTTP ' + r.status + ' ' + r.body.slice(0, 160) + ' (not counted toward stall)');
    }
  }
  for (const id of Object.keys(state.deferStreak)) if (!deferredIds.has(id)) delete state.deferStreak[id];   // ageing: a seat not deferred this tick starts again
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  RT.finish(ROUTING);   // the trial pause state, when it changed
  if (SM && !DRY) { SM.updatedAt = new Date().toISOString(); try { fs.mkdirSync(path.dirname(SPRINT_METRICS), { recursive: true }); fs.writeFileSync(SPRINT_METRICS, JSON.stringify(SM, null, 1) + '\n'); } catch (_) {} }
  if (spreadHeld.length) log('SPRINT SPREAD: metered loop(s) held so the daily cap lasts the day: ' + spreadHeld.join('; '));
  // A money hold for more than one tick is the owner's decision: ONE question on Today (lib/money-hold.js), then every
  // seat's state in plain words for Today (lib/seat-status.js), from this tick's decisions
  try {
    const allowance = Math.max(DAILY_USD / 8, 2 * Math.max(0, DAILY_USD - spent) / Math.max(1, hoursLeft));
    const mh = MH.tick({ root: ROOT, holds: moneyHolds, st: state, spent, cap: DAILY_USD, lastHour: lastHourMetered, allowance, live: !DRY, dry: DRY, log });
    for (const [id, qid] of Object.entries(mh.open || {})) if (seatSay[id] && seatSay[id].state === 'held-money') seatSay[id].qid = qid;
    const nowIso = new Date().toISOString(); const prevSeats = state.seats || {}; const seatsOut = {};
    for (const id of Object.keys(LOOP_OF)) {
      let e = seatSay[id];
      if (!e) {
        const job = findLoop(jobs, id);
        if (job && (job.inFlight || job.state === 'running')) e = SS.entry({ state: 'working' });
        else if (stalledSeats.includes(id)) e = SS.entry({ state: 'stuck', open: ((state.agents[id] || {}).key || '').split('|').filter(Boolean).length, runs: STALL_AFTER, ceoName: id === CEO_ID ? 'the owner' : CEO_NAME });
        else if (Object.keys(waitsOf[id] || {}).length) e = SS.entry({ state: 'waiting', waits: waitsOf[id] });
        else e = SS.entry({ state: 'idle' });
      }
      seatsOut[id] = SS.carry(prevSeats[id], e, nowIso);
    }
    state.seats = seatsOut; state.seatsAt = nowIso;
    if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  } catch (e) { log('SEAT STATUS ERROR: ' + String(e.message).slice(0, 200)); }
  // Competence ledger, at most once a day (company/tools/competence.js daily, shadow mode: collect, compute, scoreboard,
  // serious flags, merged-without-gate audit, chain anchor). Runs after the wakes so it can never delay one, in a child
  // process with a timeout, and one attempt a day: its failure is logged and never breaks or repeats a tick.
  try {
    const day = today();
    if ((readJson(path.join(ROOT, 'company', 'state', 'competence-state.json'), {}) || {}).lastDaily !== day && state.competenceTried !== day) {
      if (DRY) log('WOULD run competence.js daily');
      else {
        state.competenceTried = day; fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
        const out = require('child_process').execFileSync('node', [path.join(__dirname, 'competence.js'), 'daily'], { cwd: ROOT, timeout: 300000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        let j = {}; try { j = JSON.parse(String(out).trim().split('\n').pop()); } catch (_) {}
        for (const l of (j.log || [])) log(l);
        log('COMPETENCE daily: ' + (j.skipped || ('+' + ((j.collect || {}).written || 0) + ' ledger rows, ' + (j.serious || 0) + ' serious (' + ((j.flagsIssued || []).length) + ' flagged now), ' + (j.waiting || 0) + ' waiting for the people owner, chain ' + ((j.verify || {}).ok ? 'ok' : 'PROBLEM') + ', anchor ' + (j.anchor || j.anchorError || '?') + ((j.collect || {}).errors && j.collect.errors.length ? ', collect errors: ' + j.collect.errors.join('; ').slice(0, 160) : '') + (j.collectError ? ', collect failed: ' + String(j.collectError).slice(0, 120) : ''))));
      }
    }
  } catch (e) { log('COMPETENCE ERROR: ' + String(e.message || e).split('\n')[0].slice(0, 160)); }
  // GitHub-side tripwire (company/tools/default-branch-watch.js): read-only GitHub calls; flags whatever reached a default branch
  // without a merged PR that had a pre-merge PASS. Started on every tick: the tool itself does a full check at most every 55 min
  // (a skipped start costs no API call), so nothing about its state file's age can keep it from running. After the wakes, in a
  // child with a timeout; a failure is logged with its reason, and 3 failures in a row (30 min) give the tools owner an OPEN
  // handoff and security an FYI, at most once a day.
  try {
    if (!DRY) {
      let line = '', err = null;
      try {
        const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'default-branch-watch.js'), 'tick'], { cwd: ROOT, timeout: 90000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        line = String(out).trim().split('\n').pop() || '';
      } catch (e) {
        const errLines = String(e.stderr || '').split('\n').map(s => s.trim()).filter(Boolean);
        err = (errLines.find(s => /^default-branch-watch:|Error\b/.test(s)) || errLines[0] || (e.signal ? 'stopped (' + e.signal + ') at the 90 s timeout' : String(e.message || e).split('\n')[0])).slice(0, 240);
      }
      if (err) log('DEFAULT-BRANCH WATCH ERROR: ' + err);
      else if (!/^DEFAULT-BRANCH WATCH: skipped, the last full check was/.test(line)) log(line ? line.slice(0, 400) : 'DEFAULT-BRANCH WATCH ERROR: no output');
      const dw = state.defaultBranchWatch = state.defaultBranchWatch || {}, was = JSON.stringify(dw);
      dw.fails = err || !/^DEFAULT-BRANCH WATCH/.test(line) ? (dw.fails || 0) + 1 : 0;
      if (err) dw.lastError = err;
      if (dw.fails >= 3 && dw.notified !== today()) {
        dw.notified = today();
        const toolsRow = seatRow('tools'), secRow = seatRow('risk');
        const tools = toolsRow && toolsRow[1], sec = secRow && secRow[0] !== (toolsRow && toolsRow[0]) ? secRow[1] : null;   // one FYI is enough when one seat holds both
        const ev = 'DEFAULT-BRANCH WATCH ERROR lines in company/work/dispatch-log.md; the last: ' + String(dw.lastError || 'no output').replace(/[\r\n]+/g, ' ').slice(0, 240);
        if (tools && tools.inbox) appendHandoff(tools.inbox, 'the default-branch watch failed ' + dw.fails + ' times in a row', { Need: 'get `node company/tools/default-branch-watch.js tick` running again (run it by hand and read its error; `status` shows the rest), then set Status to DONE.', Why: 'it is the only check on GitHub itself that nothing lands on a default branch outside a pull request with a pre-merge PASS; while it fails, such a push goes unnoticed.', Deadline: 'today', Status: 'OPEN', Evidence: ev });
        if (sec && sec.inbox) appendHandoff(sec.inbox, 'FYI: the default-branch watch failed ' + dw.fails + ' times in a row', { Need: 'nothing unless it lasts: the tools owner has it as an OPEN handoff.', Why: 'until it runs again, a push to a default branch would not be reported.', Deadline: 'none', Status: 'DONE — FYI', Evidence: ev });
        log('DEFAULT-BRANCH WATCH DOWN: ' + dw.fails + ' failures in a row; told the tools owner (OPEN) and security (FYI)');
      }
      if (JSON.stringify(dw) !== was) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    }
  } catch (e) { log('DEFAULT-BRANCH WATCH ERROR: ' + String(e.message || e).split('\n')[0].slice(0, 160)); }
  // company skills on every seat (skills.js reconcile): every 30 min, a seat missing a company skill gets it, so a new
  // hire, a newly added skill or a skill the station lost never stays missing. No AI is used. Quiet when nothing was
  // missing; a restore or a failure is logged. Fail-safe.
  if (!DRY) try {
    const sr = state.skillsReconcile = state.skillsReconcile || {};
    if (!sr.lastAt || Date.now() - Date.parse(sr.lastAt) >= 30 * 60000) {
      sr.lastAt = new Date().toISOString();
      let out = '', code = 0;
      try { out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'skills.js'), 'reconcile'], { cwd: ROOT, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { out = String(e.stdout || ''); code = e.status || 1; }
      let r = null; try { r = JSON.parse(out); } catch (_) { r = null; }
      if (r && r.restored) log('SKILLS RESTORED: ' + r.restored + ' company skill(s) a seat lacked (' + r.done.slice(0, 6).map(d => d.skill + ' to ' + d.agent).join(', ') + (r.done.length > 6 ? ', ...' : '') + ')');
      if (!r || code) log('SKILLS RECONCILE ' + (r ? 'INCOMPLETE: ' + (r.stillMissing || []).length + ' still missing' + ((r.failed || [])[0] ? ' (' + r.failed[0].error + ')' : '') : 'ERROR: ' + String(out).slice(0, 160)));
      fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    }
  } catch (e) { log('SKILLS RECONCILE ERROR: ' + String(e.message || e).split('\n')[0].slice(0, 160)); }
  // self-improvement (lib/selfimprove.js, selfimprove.json enabled): the tripwire on the framework's main (capheos-main-watch.js,
  // at most every 5 min) and the crew's staged update watchdog's fallback check (staged-update.js tick: a watch whose own unit
  // died is finished from here). Off = no child is started. Fail-safe.
  if (!DRY) try {
    if (require('./lib/selfimprove').config().enabled) for (const [tool, label] of [['capheos-main-watch.js', 'CAPHEOS MAIN WATCH'], ['staged-update.js', 'STAGED UPDATE']]) {
      try { const out = require('child_process').execFileSync(process.execPath, [path.join(__dirname, tool), 'tick'], { cwd: ROOT, timeout: 90000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); const line = String(out).trim().split('\n').pop() || ''; if (line && !/skipped|nothing to do|unchanged/.test(line)) log(line.slice(0, 400)); }
      catch (e) { log(label + ' ERROR: ' + String(e.stderr || e.message || e).split('\n').find(Boolean).slice(0, 240)); }
    }
  } catch (e) { log('SELF-IMPROVEMENT ERROR: ' + String(e.message || e).split('\n')[0].slice(0, 160)); }
  // the station's one-run override allowlist (lib/override-allow.js, StarNet patch 0017): rewritten at the end of every
  // tick from what each seat can run NOW; a halted company or a stopped dispatcher stops writing it, and the station
  // turns every override off once it is 30 minutes old. Fail-safe.
  if (!DRY) try { await require('./lib/override-allow.js').write({ jobs, log }); } catch (e) { log('OVERRIDE ALLOWLIST ERROR: ' + String(e.message).slice(0, 200)); }
  // narrow fan-out (lib/delegate-allow.js, StarNet patch 0018): the house ranking's auto-withdraw, then the delegation allowlist (who may team.dispatch whom for which item), after the override list it reads. Fail-safe
  if (!DRY) try { await require('./lib/delegate-allow.js').step({ jobs, log, liveKids: LIVE_KIDS, budget: { capOn: CAP_ON, capped, dailyUsd: DAILY_USD, perAgentUsd: PER_AGENT_USD, byAgent, spent, lastHourMetered, hoursLeft, spread: !!(SPRINT && SPRINT.spreadDailyCap), unmetered: UNMETERED_PROVIDERS } }); } catch (e) { log('DELEGATE ALLOWLIST ERROR: ' + String(e.message).slice(0, 200)); }
  // profile trials (profile.js tick, docs/PROFILES.md): a trial past its end with no answer from the owner goes back. Fail-safe
  if (!DRY) try { const pt = require('./profile.js').tick(); for (const t of (pt.trials || [])) log(t.error ? 'PROFILE TRIAL ERROR ' + t.seat + ': ' + String(t.error).slice(0, 160) : 'PROFILE TRIAL ENDED ' + t.seat + ': no answer, back to version ' + t.reverted + ' (now ' + t.version + ')'); } catch (e) { log('PROFILE TRIAL ERROR: ' + String(e.message).slice(0, 200)); }
  // weekly routing suggestions (routing.js proposals tick, docs/ROUTING.md): hourly, in its own process (the owner's veto card is filed by routing.js). Fail-safe
  try { if (!DRY && require('./routing.js').proposalsDue()) { const out = String(require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'routing.js'), 'proposals', 'tick'], { cwd: ROOT, timeout: 120000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim(); const j = (() => { try { return JSON.parse(out); } catch (_) { return null; } })(); if (j && ((j.applied || []).length || (j.offered || []).length || (j.asked || []).length)) log('ROUTING SUGGESTIONS: ' + ['applied ' + (j.applied || []).join(', '), 'offered ' + (j.offered || []).join(', '), 'to the CEO ' + (j.asked || []).join(', ')].filter(x => !/ $/.test(x)).join('; ')); } } catch (e) { log('ROUTING SUGGESTIONS ERROR: ' + String(e.message).split('\n')[0].slice(0, 200)); }
  if (deferred.length) log('DEFERRED past the ' + MAX_PER_TICK + '/tick limit, by priority: ' + deferred.join(', '));
  if (capped && held.length) log('CAP: company metered $' + spent.toFixed(2) + ' of cap $' + DAILY_USD + ' · owner-paid (not capped) $' + split.ownerPaid.toFixed(2) + ' — metered loops held: ' + (held.join(', ') || 'none due') + '; subscription loops still dispatch');
  if (wouldHold.length) log('spendCap guardrail off — would have held ' + wouldHold.join(', '));
  if (perAgentHeld.length) log('PER-AGENT CAP: loop(s) at their $' + PER_AGENT_USD.toFixed(2) + '/24h share: ' + perAgentHeld.join(', '));
  // One line per change, not per tick: the hold lasts until the PM changes the agent's approval mode.
  const askKey = askHeld.join(', ');
  if (askKey && (DRY || state.askHeld !== askKey)) log('ASK-MODE HOLD: ' + askKey + ' — agent approval mode is "ask", unattended writes are refused; not fired. Needs the PM (access) or a watched run');
  if (!DRY && (state.askHeld || '') !== askKey) { state.askHeld = askKey; fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); }
  if (!fired) console.log('idle: nothing due (company metered $' + spent.toFixed(2) + ' of cap $' + DAILY_USD + ' · owner-paid, not capped $' + split.ownerPaid.toFixed(2) + ' /24h)');
})().catch(e => { console.error('dispatch error: ' + e.message); process.exit(1); });
