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
// Sprint (cadence.js effective().sprint): null when off. Fail-safe: an unreadable cadence means no Sprint.
const SPRINT = (() => { try { return require('./cadence.js').effective().sprint || null; } catch (_) { return null; } })();
const SPRINT_METRICS = path.join(ROOT, 'company', 'state', 'sprint-metrics.json');
const SPRINT_EFFORT = path.join(ROOT, 'company', 'state', 'sprint-effort.json');
const STALL_AFTER = num('DISPATCH_STALL_AFTER', 3);
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
/* A handoff block's own **Deadline:** line (company/HANDOFFS.md requires one) can set it aside until that day: it is not
 * woken by the dispatcher and not counted toward STALLED (no dispatcher run is spent on it, so nothing goes uncounted);
 * the seat's own schedule still runs it. Only a plain YYYY-MM-DD date later than today and at most STALL_DEADLINE_CAP days
 * ahead defers; 'today', prose, a past date or a far date counts as due now. The dispatcher cannot tell who wrote the line,
 * so it remembers the FIRST deadline it saw per block (seen: heading -> date): moving the date later never extends the
 * deferral, an earlier date takes effect at once. */
const STALL_DEADLINE_CAP = num('DISPATCH_STALL_DEADLINE_CAP', 14);
function deadlineDeferrals(sections, seen, todayStr, capDays) {
  const dayMs = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  const now = dayMs(todayStr), nextSeen = {}, deferred = new Map();
  for (const [heading, text] of sections) {
    const m = String(text || '').match(/^\*\*Deadline:\*\*\s*(\d{4}-\d{2}-\d{2})\b/m);
    if (!m || !Number.isFinite(dayMs(m[1]))) continue;
    const prev = seen && seen[heading];
    const d = prev && prev < m[1] ? prev : m[1];   // the first date seen, unless the line now says earlier
    nextSeen[heading] = d;
    if (dayMs(d) > now && dayMs(d) - now <= capDays * 86400000) deferred.set(heading, d);
  }
  return { deferred, seen: nextSeen };
}
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
function capDecision({ capOn, capped, metered, ownerWake, perAgentOver }) {
  if (!metered || ownerWake) return 'run';
  if (capped) return capOn ? 'held' : 'wouldHold';
  if (perAgentOver) return capOn ? 'perAgentHeld' : 'wouldHold';
  return 'run';
}
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
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dispatch-selftest-'));
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const openBlock = '## 2026-11-16 10:00 from X — an open ask\n**Need:** y\n**Status:** OPEN\n**Deadline:** today\n';
  const doneClosed = '## 2026-11-16 10:00 from X — closed\n**Need:** y\n**Status:** DONE — resolved\n**Resolved 06:42 by Y:** done\n';
  const doneThenOpen = doneClosed + '**Status:** OPEN — written by the CEO in a later session (status line appended)\n';
  const openThenDone = openBlock + '**Status:** DONE — actually closed later\n';
  const noteOnly = doneClosed + '**Note (no status on purpose):** a bodyless block from a batch pass\n';

  check('a section whose first status is OPEN is woken', openHandoffs(write('a.md', openBlock)).length === 1);
  // Deadline deferral: capped, a plain date only, the first date seen, an earlier date at once
  const sec = d => '2026-11-17 10:00 from X — ask\n**Need:** y\n**Status:** OPEN\n**Deadline:** ' + d + '\n';
  const dd = (d, seen) => deadlineDeferrals(new Map([['h', sec(d)]]), seen, '2026-11-17', 14);
  check('a Deadline 4 days ahead defers', dd('2026-11-21').deferred.get('h') === '2026-11-21');
  check('today, a past date, prose and no date count as due now', !dd('2026-11-17').deferred.size && !dd('2026-11-10').deferred.size && !dd('next week').deferred.size && !dd('today').deferred.size);
  check('the cap: 14 days ahead defers, 15 does not', dd('2026-12-01').deferred.size === 1 && !dd('2026-12-02').deferred.size);
  check('a date in the body text is not the Deadline line', !deadlineDeferrals(new Map([['h', '2026-11-17 x\n**Status:** OPEN\ndue 2026-11-25 per X\n']]), {}, '2026-11-17', 14).deferred.size);
  check('moving the Deadline later never extends the deferral (the first date seen holds)', dd('2026-11-28', { h: '2026-11-17' }).deferred.size === 0 && dd('2026-11-28', { h: '2026-11-17' }).seen.h === '2026-11-17');
  check('an earlier Deadline takes effect at once', dd('2026-11-17', { h: '2026-11-21' }).deferred.size === 0 && dd('2026-11-19', { h: '2026-11-21' }).seen.h === '2026-11-19');
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
  const bad = cases.filter(c => !c.pass);
  for (const c of cases) console.log((c.pass ? 'ok   ' : 'FAIL ') + c.name + (c.pass ? '' : '  [' + c.detail + ']'));
  console.log(bad.length ? 'DISPATCH SELFTEST FAILED: ' + bad.length + ' of ' + cases.length : 'DISPATCH SELFTEST PASSED: ' + cases.length + ' cases');
  return bad.length ? 1 : 0;
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
function inboxOf(agentId) { return CREW && CREW[agentId] && CREW[agentId].inbox ? CREW[agentId].inbox : null; }
function today() { return co.localParts().date; }
function appendHandoff(inbox, heading, fields) {
  const f = path.join(ROOT, 'company', 'work', 'handoffs', inbox);
  // a "today" deadline is written as the date: handoff-status.js (and the console's due list) leaves "today" undated on purpose
  const block = '\n## ' + today() + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + (k === 'Deadline' && v === 'today' ? today() : v)).join('\n') + '\n';
  if (!DRY) fs.appendFileSync(f, block);
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
 * {"enabled": false} turns it off, {"enabled": true} turns it on for another adapter. At most one message per tick. */
const OUTBOX = path.join(ROOT, 'company', 'state', 'owner-outbox.json');
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
    const row = require('./owner-inbox.js').send({ from: next.from || CEO_NAME, text: body, re: bundle.map(q => q.id).join(',') });
    for (const q of bundle) ob.sent[q.id] = { at: new Date().toISOString(), messageId: row.id };
    fs.writeFileSync(OUTBOX, JSON.stringify(ob, null, 1) + '\n');
    log('SENT owner question ' + bundle.map(q => q.id).join(', ') + ' (from ' + next.from + ') to company/owner/outbound.jsonl');
  } catch (e) { log('OUTBOX send failed for ' + next.id + ' (left pending; clear company/state/owner-outbox.json sent.' + next.id + ' to retry): ' + String(e.message).slice(0, 160)); }
}
// log the held-questions line once per distinct set, not every tick
let OTHERS_SEEN = null;
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
// agentId -> metered USD that agent's runs cost in the last 24h. Unmetered providers are skipped for the same reason
// spentToday() skips them: an owner-paid run must never use up an agent's share of the company's cap.
function spentByAgent() {
  if (CAPNUM && typeof CAPNUM.spentByAgent === 'function') return CAPNUM.spentByAgent();
  return runsOnlyByAgent();
}
function runsOnlyByAgent() {
  const since = Date.now() - 24 * 3600 * 1000; const out = {};
  for (const r of runsSince(since)) if (r.startedAt >= since && r.agentId && !UNMETERED_PROVIDERS.includes(String(r.provider || ''))) out[r.agentId] = (out[r.agentId] || 0) + (Number(r.usd) || 0);
  return out;
}

// POST /api/cron/run with detach:true — the run is admitted on a 200 and then keeps going after we close the
// socket (the sidecar only wires `res close -> abort` when detach is false). We resolve on the first byte of a
// 200 (admitted) or the full short body of a refusal, so a long loop never blocks or gets cancelled by this tick.
function fireRun(jobId) {
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
    req.write(JSON.stringify({ id: jobId, detach: true }));
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
  if (halted) { try { await require('./lib/duty-runner').tick({ log, dry: DRY, halted }); } catch (e) { log('DUTIES ERROR: ' + String(e.message).slice(0, 200)); } log(rhold ? restartHoldLine(rhold) : haltLine(co.haltState())); return; }
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
  const isMetered = job => !UNMETERED_PROVIDERS.includes(String(job.provider || ''));
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
  // Duties (docs/DUTIES.md): after the locked-file watch, so an unrecorded policy edit is reported (and not obeyed) before
  // anything runs. Fail-safe: an error here is one line and the tick goes on without duty work.
  const DR = require('./lib/duty-runner');
  let dutyRun = null;
  try { dutyRun = await DR.tick({ log, dry: DRY, flag: dutyFlag }); } catch (e) { log('DUTIES ERROR: ' + String(e.message).slice(0, 200)); }
  for (const id of (dutyRun && dutyRun.recovered) || []) for (const c of Object.values(CREW || {})) if (c && c.inbox) { closeHandoff(c.inbox, 'duty ' + id + ':', 'the duty check passes now'); closeHandoff(c.inbox, 'duty ' + id + ' is ', 'the duty check runs and passes again'); }
  const state = readJson(STATE, { quests: {}, agents: {} });
  try { await closeQuests(quests, state); } catch (e) { log('CLOSER ERROR: ' + e.message); }
  try { deliverOwnerQuestions(); } catch (e) { log('OUTBOX ERROR: ' + e.message); }
  // 1-on-1s (company/tools/corrections.js, fail-safe): detect habits, then activate, record, escalate or retire standing
  // corrections. Before the house-rules hook, so a correction activated now reaches the prompts in this same tick.
  try { await require('./corrections.js').tick({ dry: DRY, log, quests, jobs }); } catch (e) { log('CORRECTIONS ERROR: ' + e.message); }
  // a run that sleeps to a wall-clock time (company/tools/long-sleep.js, fail-safe): its seat's manager is told once
  try { require('./long-sleep.js').tick({ dry: DRY, log }); } catch (e) { log('LONG SLEEP ERROR: ' + String(e.message).slice(0, 200)); }
  try { await require('./routine-rules.js').ensure({ dry: DRY, log }); } catch (e) { log('HOUSE RULES ERROR: ' + e.message); }
  try { require('./handoff-archive.js').run({ dry: DRY, log }); } catch (e) { log('ARCHIVE ERROR: ' + e.message); }
  try { require('./retention.js').daily({ dry: DRY, log }); } catch (e) { log('RETENTION ERROR: ' + String(e.message).slice(0, 200)); }   // once a company day (docs/RETENTION.md)
  // house benchmark (company/tools/model-stats.js): refreshed at most hourly, read by the people owner and the pacer for model pairing
  try {
    const hb = path.join(ROOT, 'company', 'work', 'models', 'house-benchmarks.json');
    const age = fs.existsSync(hb) ? Date.now() - fs.statSync(hb).mtimeMs : Infinity;
    if (!DRY && age > 3600e3) require('child_process').execFileSync('node', [path.join(__dirname, 'model-stats.js')], { timeout: 60000, stdio: 'ignore' });
  } catch (e) { log('HOUSE BENCHMARK ERROR: ' + e.message); }
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
  // An OPEN item whose Status says it waits on another seat ("waiting on Ingrid's review", "blocked on the owner") is not
  // work for its holder: it neither wakes the seat nor counts in its signature or stall key (lib/sprint.js waitingOn).
  const NAMES = Object.fromEntries(Object.entries(CREW || {}).map(([id, c]) => [id, (c && c.name) || id]));
  const itemsOf = {}, waitsOf = {}, stalledSeats = [];
  for (const [agentId, inbox] of Object.entries(INBOX_OF)) {
    let its = [], txt = ''; try { txt = fs.readFileSync(path.join(ROOT, 'company', 'work', 'handoffs', inbox), 'utf8'); its = SP.parseItems(txt).filter(i => i.open); } catch (_) {}
    itemsOf[agentId] = its; waitsOf[agentId] = {};
    for (const it of its) { const on = SP.waitingOn(it.status, NAMES, agentId, CEO_ID); if (on) { it.waitingOn = on; const n = on === 'owner' ? 'you (the owner)' : NAMES[on] || 'someone else'; waitsOf[agentId][n] = (waitsOf[agentId][n] || 0) + 1; } }
    const st = state.agents[agentId] || { key: '', count: 0 };
    const openSecs = new Map(txt.split(/^## /m).slice(1).map(sec => [sec.split('\n')[0].trim(), sec]).filter(([h]) => its.some(i => i.heading === h && !i.waitingOn)));
    const dl = deadlineDeferrals(openSecs, st.deadlines, today(), STALL_DEADLINE_CAP);
    st.deadlines = dl.seen;
    const open = its.filter(i => !i.waitingOn && !dl.deferred.has(i.heading)).map(i => i.heading).sort();
    const dkey = [...dl.deferred.keys()].sort().join('|');
    if (dkey !== (st.deferred || '')) { st.deferred = dkey; if (dkey) log('WAITING handoffs ' + inbox + ' (' + agentId + '): ' + dl.deferred.size + ' OPEN set aside until their own Deadline (nearest ' + [...dl.deferred.values()].sort()[0] + '): not woken, not counted as stalled'); }
    const key = open.join('|');
    if (key !== st.key) { st.key = key; st.count = 0; st.flagged = false; }   // inbox changed: fresh budget
    state.agents[agentId] = st;
    if (!open.length) continue;
    if (st.count >= STALL_AFTER) {
      stalledSeats.push(agentId);
      if (!st.flagged) {
        st.flagged = true; log('STALLED handoffs ' + inbox + ' (' + agentId + '): ' + open.length + ' OPEN unchanged after ' + STALL_AFTER + ' runs — needs ' + CEO_NAME + ' (CEO)' + lastRunTail(findLoop(jobs, agentId)));
        // "needs the CEO" is said to the CEO, not only to the log: one OPEN handoff per stall (a new item set is a new stall)
        if (agentId !== CEO_ID && inboxOf(CEO_ID)) appendHandoff(inboxOf(CEO_ID), (NAMES[agentId] || agentId) + ' is stuck: the same ' + open.length + ' item' + (open.length === 1 ? '' : 's') + ' after ' + STALL_AFTER + ' runs', { Need: 'look at ' + inbox + ' and unblock it: answer what ' + (NAMES[agentId] || agentId) + ' is waiting for, re-scope the items, or mark them DONE/blocked with a reason. The dispatcher stops waking ' + (NAMES[agentId] || agentId) + ' for them until the set changes.', Why: 'the dispatcher woke ' + (NAMES[agentId] || agentId) + ' ' + STALL_AFTER + ' times for the same open items and nothing moved.', Items: open.slice(0, 6).join(' · ').slice(0, 600), Deadline: 'today', Status: 'OPEN' });
      }
      continue;
    }
    work[agentId] = work[agentId] || [];
    reason[agentId] = (reason[agentId] ? reason[agentId] + '; ' : '') + open.length + ' OPEN in ' + inbox;
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
      work[seat].push({ id: 'duty:' + d.id, why, duty: d, key: String(st.key), items: its.map(i => i.id), skey });
      reason[seat] = (reason[seat] ? reason[seat] + '; ' : '') + 'duty:' + d.id + ' (' + why + ')';
    }
  }
  // Owner messages first, then by revenue priority, then in the order found. The priority exists so that when only
  // MAX_PER_TICK loops can fire, the ones the revenue line depends on are the ones that fire.
  const order = Object.keys(work).sort((a, b) =>
    ((ownerWake.has(b) ? 1 : 0) - (ownerWake.has(a) ? 1 : 0)) || ((hiringWake.has(b) ? 1 : 0) - (hiringWake.has(a) ? 1 : 0)) || (prio(b) - prio(a)));
  // ---- Sprint: what each seat has to do now (its signature), the Sprint numbers, effort per seat, lanes ----
  const sigOf = id => SP.workSig([(work[id] || []).map(q => q.id + ':' + (q.duty ? q.key : (state.quests[q.id] || {}).done)), (state.agents[id] || {}).key || '',
    ownerWake.has(id) ? state.owner.key : '', hiringWake.get(id) || [], artifactWakes[id] || []]);
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
  let fired = 0; try { const pace = await require('./pacer.js').dispatchHook({ dry: DRY, log, jobs, order, ownerWake, maxPerTick: MAX_PER_TICK }); fired = -Math.max(0, Math.min(2, Number(pace && pace.extra) || 0)); } catch (e) { fired = 0; log('PACER ERROR: ' + e.message); }   // pacer.js (fail-safe): may drop metered wakes held near the station rail from `order`, and lends extra per-tick slots by starting `fired` below 0
  // Sprint lanes (company/tools/lanes.js, fail-safe, after the pacer so it sees what the pacer held and the models it set):
  // ends finished, timed-out or cut-off lanes, starts lanes for seats with independent OPEN items within the same money
  // and tempo rules as a wake, and takes a seat out of `order` when live lanes own all its open items
  try { await require('./lanes.js').dispatchHook({ dry: DRY, log, jobs, work, reason, order, ownerWake, hiringWake, modes, allowAsk: ALLOW_ASK, state, sprint: SPRINT, metrics: SM, budget: { capOn: CAP_ON, capped, dailyUsd: DAILY_USD, perAgentUsd: PER_AGENT_USD, byAgent, spent, lastHourMetered, hoursLeft, spread: !!(SPRINT && SPRINT.spreadDailyCap), unmetered: UNMETERED_PROVIDERS } }); } catch (e) { log('LANES ERROR: ' + String(e.message).slice(0, 200)); }
  const deferred = [];
  for (const agentId of order) {
    const qs = work[agentId];
    if (fired >= MAX_PER_TICK) { deferred.push((CREW[agentId] || {}).name || agentId); say(agentId, { state: 'held', why: 'has work, waiting for a free slot (' + MAX_PER_TICK + ' starts per check); next check picks it up' }); continue; }
    if (!LOOP_OF[agentId]) continue;   // not on the crew (for example a departed person's leftover quest): nothing to wake
    const job = findLoop(jobs, agentId);
    if (!job) { log('NO LOOP for ' + agentId + ': no routine matches "' + (LOOP_OF[agentId] || '?') + '"'); continue; }
    if (job.enabled === false) { log('DISABLED loop "' + job.name + '" for ' + agentId + ' — routine exists but is disabled; not fired'); say(agentId, { state: 'held', why: 'has work, but its routine "' + job.name + '" is switched off' }); continue; }
    if (job.inFlight || job.state === 'running') { say(agentId, { state: 'working' }); continue; }
    const last = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
    const ownCooldown = CREW && CREW[agentId] && Number(CREW[agentId].cooldownMin) > 0 ? Number(CREW[agentId].cooldownMin) * 60000 : COOLDOWN_MS;   // per-person rest, loops.json cooldownMin
    // rest: the seat's cooldown (owner message: the short one); in Sprint only the floor when its work changed since its last wake
    const sig = SPRINT ? sigOf(agentId) : null;
    const rest = SP.restMs({ baseMs: ownerWake.has(agentId) ? OWNER_COOLDOWN_MS : ownCooldown, sprint: !!SPRINT, changed: !!SPRINT && state.sprintSig[agentId] !== sig, floorMin: SPRINT && SPRINT.cooldownFloorMin, unchangedMin: SPRINT && SPRINT.unchangedRestMin, hiring: hiringWake.has(agentId) });
    if (Date.now() - last < rest.ms) { say(agentId, { state: 'resting', changed: rest.fast || !SPRINT, at: co.localParts(new Date(last + rest.ms)).time, waits: waitsOf[agentId] }); continue; }
    if (!ALLOW_ASK && modes[agentId] === 'ask') { askHeld.push(job.name + ' (' + agentId + ')'); say(agentId, { state: 'held', why: 'has work, but its approval mode is "ask", so an unattended run could not save anything' }); continue; }   // due, but cannot save unattended
    // the global USD cap, then this agent's share (an owner message is never held; a subscription loop is not metered).
    // With the spendCap guardrail off nothing is held; the loop runs and is listed once in the log.
    const cap = capDecision({ capOn: CAP_ON, capped, metered: isMetered(job), ownerWake: ownerWake.has(agentId), perAgentOver: PER_AGENT_USD > 0 && (byAgent[agentId] || 0) >= PER_AGENT_USD });
    const moneyHold = kind => { moneyHolds.push({ seat: agentId, name: NAMES[agentId] || agentId, kind, waiting: waitersOf(agentId) }); say(agentId, { state: 'held-money', kind, waiting: waitersOf(agentId) }); };
    if (cap === 'held') { held.push(job.name); moneyHold('cap'); continue; }
    if (cap === 'perAgentHeld') { perAgentHeld.push(job.name); moneyHold('perAgent'); continue; }
    if (cap === 'wouldHold') wouldHold.push(job.name);
    if (SPRINT && SPRINT.spreadDailyCap && CAP_ON && cap === 'run' && isMetered(job) && !ownerWake.has(agentId)) {
      // never the seat others wait on (blockers): holding it idles them all; the daily cap above still holds it
      const why = SP.spreadHold({ cap: DAILY_USD, spent24h: spent, spentLastHour: lastHourMetered, hoursLeft, blocking: waitersOf(agentId) });
      if (why) { spreadHeld.push(job.name + ' — ' + why); moneyHold('spread'); continue; }
    }
    { const tempo = require('./cadence.js').tempoAllows(agentId, Date.now(), { record: !DRY, ownerWake: ownerWake.has(agentId) }); if (!tempo.ok) { log('TEMPO HOLD ' + job.name + ' for ' + agentId + ': ' + tempo.reason); say(agentId, { state: 'held', why: 'has work, held by the wake limits: ' + tempo.reason }); continue; } }   // wake caps (cadence.json bounds): an owner message is never held but still counts
    const names = reason[agentId];
    const viaInbox = names.includes(' OPEN in ');
    if (DRY) { log('WOULD run ' + job.name + ' for ' + agentId + ' (' + names + ')'); fired++; say(agentId, { state: 'started', why: names }); continue; }
    log('RUN ' + job.name + ' for ' + agentId + ' (' + names + ')' + (rest.fast ? ' [Sprint: new work; rest ' + SPRINT.cooldownFloorMin + ' min]' : ''));
    fired++;
    // a duty wake hands the agent its reason: one OPEN handoff in its inbox, ids and counts only (dedup reads it next tick)
    for (const q of qs) if (q.duty && inboxOf(agentId)) appendHandoff(inboxOf(agentId), 'duty ' + q.duty.id + ': ' + q.why.slice(0, 160), { Need: (q.duty.why ? q.duty.why + '. ' : '') + 'The check says: ' + q.why + '. Fix the cause or hand it to whoever can; the duty clears this by itself once the check passes. See it again: `node ' + (q.duty.source === 'company/tools/duties.js' ? 'company/tools/' : q.duty.source.replace(/module\.json$/, '')) + q.duty.tool + ' --duty`.', Why: 'a read-only duty check found it (docs/DUTIES.md); the dispatcher woke you for it.', Duty: q.duty.id + ' key ' + q.key + (q.items.length ? ' items ' + q.items.join(', ') : ''), Deadline: 'today', Status: 'OPEN' });
    // Fire detached: the run is admitted on a 200 and then keeps going after we close the socket, so a long
    // loop can never be cancelled by this tick's own hold (a run tied to the request socket dies with it).
    // Only a 200 counts toward the stall budget — a refused start (409/400) is not a run.
    const r = await fireRun(job.id);
    say(agentId, r.status === 200 ? { state: 'started', why: names } : { state: 'held', why: 'has work; the station refused the start (HTTP ' + r.status + ')' });
    if (r.status === 200) {
      for (const q of qs) { if (q.duty) state.duties[q.skey].count++; else state.quests[q.id].count++; }
      for (const qid of (artifactWakes[agentId] || [])) state.artifactWait[qid].wakes++;   // a real start is a wake
      if (viaInbox) state.agents[agentId].count++;
      if (ownerWake.has(agentId)) state.owner.count++;
      for (const slug of (hiringWake.get(agentId) || [])) state.hiringWake[slug] = new Date().toISOString();   // spent: once per round
      if (SPRINT) { state.sprintSig[agentId] = sig; SM.wakes++; SM.pending[agentId] = { at: Date.now(), sig }; }
      fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    } else {
      log('  ' + job.name + ' refused: HTTP ' + r.status + ' ' + r.body.slice(0, 160) + ' (not counted toward stall)');
    }
  }
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
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
