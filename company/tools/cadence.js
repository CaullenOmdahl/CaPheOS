#!/usr/bin/env node
/* cadence.js — how often the company wakes (its tempo): the dispatcher tick, each seat's loop schedule, cooldown and
 * priority, inside bounds only the owner sets. Plain-words guide: docs/TEMPO.md.
 *
 *   node company/tools/cadence.js show [--json]
 *   node company/tools/cadence.js set-default [<tick minutes>] [--cooldown <min>] [--max-per-tick N] --by <name> [--why "…"]
 *   node company/tools/cadence.js set <seatId> [--loop-every <cron-or-minutes>] [--cooldown <min>] [--priority N]
 *                                  [--wake-on-inbox on|off] [--wake-on-owner on|off] [--peak-ok on|off] --by <name> [--why "…"]
 *   node company/tools/cadence.js bounds [--tick-min 5-30] [--cooldown-min 10-120] [--max-wakes-per-hour N]
 *                                  [--max-wakes-per-day N] [--quiet-hours 22:00-07:00|off] [--mode fixed|bounded-auto]
 *                                  [--auto-expire-min N] [--min-change-interval-min N] --by owner
 *   node company/tools/cadence.js end-temporary --by <name> [--why "…"]     end a temporary speed-up early
 *   node company/tools/cadence.js apply [--dry-run] [--approved-ref <questionId>] [--by <name>]
 *   node company/tools/cadence.js sprint on|off [--hours N] [--budget-usd X] [--lanes N] --by <owner> [--why "…"]
 *   node company/tools/cadence.js sprint config [--budget-usd X|default] [--lanes N] [--max-lanes-total N] [--lane-timeout-min N]
 *                                  [--cooldown-floor-min N] [--fallback-tick-min N]
 *                                  [--watch-debounce-sec N] [--spread on|off|today] --by <owner> [--why …]
 *                                  --spread: Sprint's spread of the daily metered cap over the day; today = off until midnight
 *   node company/tools/cadence.js sprint status [--json]      Sprint (start-up): on or off, until when, and how it is going
 *   node company/tools/cadence.js duties-floor [--json]   a SUGGESTION only (docs/DUTIES.md): which seats' own loop routines
 *                                  run more often than the duty floor (bounds.loopFloorMin, default 360-720 min; a seat may
 *                                  set seats.<id>.loopFloorMin inside it), and the command the owner or a reviewed change
 *                                  would apply. The CEO seat keeps its loop. Nothing is changed: duties find the work now,
 *                                  so a seat's routine loop can be slow; existing schedules move only when someone applies it.
 *   node company/tools/cadence.js selftest
 *
 * Source of truth: company/work/ops/cadence.json (defaults: company/defaults/work/ops/cadence.json).
 *   base values   dispatcherTickMin, defaultCooldownMin, maxPerTick, seats.<id>.*: the owner's (or a reviewed change's)
 *   bounds        tickMin [lo,hi], cooldownMin [lo,hi], maxWakesPerHour, maxWakesPerDay, quietHours "HH:MM-HH:MM"|null
 *   tempo         mode fixed|bounded-auto, autoExpireMin, minChangeIntervalMin
 *   temporary     {set, by, why, at, expiresAt}: an agent's speed-up (or slow-down), never a new baseline
 * Who may change what (tempo controls spend RATE, liveness cadence and SLA response, so nobody edits their own throttle):
 *   - the owner (--by owner or the owner's name, from outside an agent's run): anything, base values and bounds included;
 *   - an agent, mode bounded-auto, every value inside bounds: set-default writes a TEMPORARY change (--why required) that
 *     expires after tempo.autoExpireMin back to the base; set <seat> (cooldown inside bounds, loopEvery no shorter than
 *     the cooldown floor) is persistent. Both follow the 'schedules' self-governance level (lib/governance.js decide), are
 *     logged, and are rate-limited: no tempo change within tempo.minChangeIntervalMin of the previous change or of the
 *     end of the previous speed-up (hysteresis: a speed-up cannot be chained back to back);
 *   - anything outside bounds, maxPerTick, and bounds/tempo themselves: owner only, or a reviewed change —
 *     `harness-change.js propose --kind schedule --target cadence.json --change '{"/bounds/tickMin":[3,30]}'`, reviewed
 *     by the finance (rate), risk (liveness, SLA) and people (workload) holders, never the proposer.
 *   - a loop routine clock (loopEvery cron) inside a provider's peak-price block (offpeak-clocks.js) is refused unless
 *     the owner sets the seat's peakOk.
 * The dispatcher (company/tools/dispatcher-loop.js) re-reads the effective tempo every iteration, so a change needs no
 * reload; dispatch.js asks tempoAllows(seatId, now) before each wake (wakes-per-hour/day caps, quiet hours).
 * `apply` writes per-seat fields into loops.json and updates loop routine schedules on the station (POST /api/cron/update).
 * loopEvery is minutes (30 => "every 30m"), "every Nm" / "every Nh", or a 5-field cron ("0 9 * * 1-5").
 * Sprint (start-up), tempo.sprint {on, since, until|null, by, …config}: the owner's switch to work as fast as the open
 * work allows (docs/TEMPO.md "Sprint"). While on: a seat whose open work CHANGED wakes as soon as it is idle (cooldown
 * floor), the dispatcher wakes on inbox changes (dispatcher-loop.js watch) with a fallback timer, maxPerTick is the
 * number of seats, and the hourly/daily wake caps are lifted. The spend cap (docs/BUDGET.md), halts, guardrails, the
 * pacer's subscription stops and per-seat model chains are untouched. It ends by itself at `until`, at certified +
 * afterCertifiedH (the founding default), or when its own budget (budgetUsd, default 2 x the daily cap) is spent;
 * sprintTick() (run by the dispatcher loop) writes the end and tells the owner in plain words. Owner only: an agent
 * proposes it with harness-change.js propose --kind schedule --target cadence.json --change '{"/tempo/sprint/on":true}'.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const co = require('./lib/company');
const SP = require('./lib/sprint');

const BUILTIN = { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, seats: {} };
const DEFAULT_BOUNDS = { tickMin: [5, 30], cooldownMin: [10, 120], maxWakesPerHour: 12, maxWakesPerDay: 120, quietHours: null, loopFloorMin: [360, 720] };
const DEFAULT_TEMPO = { mode: 'bounded-auto', autoExpireMin: 30, minChangeIntervalMin: 15 };
const SEAT_FIELDS = ['cooldownMin', 'priority', 'wakeOnInbox', 'wakeOnOwnerMessage'];
const S = {
  file: co.p('company', 'work', 'ops', 'cadence.json'),
  defaultFile: co.p('company', 'defaults', 'work', 'ops', 'cadence.json'),
  wakesFile: co.p('company', 'state', 'tempo-wakes.json'),
  loopStateFile: co.p('company', 'state', 'dispatcher-loop.json'),
  loopsFile: co.LOOPS_FILE,
  unitDir: process.env.CADENCE_UNIT_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'),
  service: () => (co.config.station && co.config.station.serviceName) || 'capheos-station',
  call: (method, p, body) => require('./station-crew.js').call(method, p, body, 20000),
  gate: () => co.gate('schedules'),
  governance: () => { try { return require('./lib/governance'); } catch (_) { return null; } },
  decide: (cat, o) => require('./lib/governance').decide(cat, o),
  underStation: () => { try { return require('./provenance.js').underStation(); } catch (_) { return false; } },
  ownerShell: () => require('./lib/owner').shell(),   // the one owner rule (lib/owner.js)
  ownerName: () => (co.config.owner && co.config.owner.name) || 'Owner',
  peakCfg: () => require('./offpeak-hold.js').peakConfig(),
  notify: (text, technical) => require('./lib/owner-notice').send({ kind: 'fyi', from: co.nameOf(co.ceo()), text, technical }),   // an FYI: tempo changes wait for the day's message
  now: () => Date.now(),
  onboardingFile: co.p('company', 'state', 'onboarding-state.json'),
  budgetFile: co.p('company', 'work', 'finance', 'dispatch-budget.json'),
  runsFile: co.p('.starnet-data', 'workspaces', 'runs.jsonl'),
  metricsFile: co.p('company', 'state', 'sprint-metrics.json'),
  harnessLog: co.p('company', 'work', 'people', 'harness-log.jsonl'),
};

const E = (msg, extra) => Object.assign(new Error(msg), { refused: true }, extra || {});
function load() {
  const c = co.readJson(S.file, null) || co.readJson(S.defaultFile, null) || {};
  const out = Object.assign({}, BUILTIN, c, { seats: Object.assign({}, (c && c.seats) || {}) });
  out.bounds = Object.assign({}, DEFAULT_BOUNDS, (c && c.bounds) || {});
  out.tempo = Object.assign({}, DEFAULT_TEMPO, (c && c.tempo) || {});
  return out;
}
function save(c) {
  fs.mkdirSync(path.dirname(S.file), { recursive: true });
  const text = JSON.stringify(c, null, 2) + '\n';
  const tmp = S.file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, S.file);
  try { require('./provenance.js').wrote(S.file, text, 'cadence.js'); } catch (_) {}
}
function loops() { return co.readJson(S.loopsFile, {}) || {}; }
const posInt = (v, what) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new Error(what + ' must be a whole number >= 1 (got ' + v + ')'); return n; };
const onOff = (v, what) => { if (v === 'on' || v === true) return true; if (v === 'off' || v === false) return false; throw new Error(what + ' must be on or off'); };
const iso = ms => new Date(ms).toISOString();
function isOwner(by) {
  const b = String(by || '').trim().toLowerCase();
  if (!b || S.underStation() || !S.ownerShell()) return false;   // an agent's run, or a detached process, cannot claim to be the owner
  return b === 'owner' || b === String(S.ownerName()).trim().toLowerCase();
}
const needWhy = why => { const w = typeof why === 'string' ? why.trim() : ''; if (!w) throw E('--why "<reason>" is required: every tempo change by the crew is logged with its reason'); return w.slice(0, 300); };

/* loopEvery -> {kind:'interval', minutes, text} | {kind:'cron', expr, text}. Throws on anything else. */
function parseEvery(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d+$/.test(s)) { const m = posInt(s, 'loop-every'); return { kind: 'interval', minutes: m, text: 'every ' + m + 'm' }; }
  let m = s.match(/^every\s+(\d+)\s*(m|min|minutes?|h|hours?)$/i);
  if (m) { const n = posInt(m[1], 'loop-every') * (/^h/i.test(m[2]) ? 60 : 1); return { kind: 'interval', minutes: n, text: 'every ' + n + 'm' }; }
  const parts = s.split(/\s+/);
  if (parts.length === 5 && parts.every(p => /^[\d*,\-/]+$/.test(p))) return { kind: 'cron', expr: parts.join(' '), text: parts.join(' ') };
  throw new Error('loop-every must be minutes, "every Nm"/"every Nh" or a 5-field cron (got "' + s + '")');
}
function sameSchedule(want, cur) {
  if (!cur || !want) return false;
  if (want.kind === 'interval') return cur.kind === 'interval' && Number(cur.minutes) === want.minutes;
  return cur.kind === 'cron' && String(cur.expr || '').trim().split(/\s+/).join(' ') === want.expr;
}

/* ---------------- bounds, the effective tempo, the caps ---------------- */
function parseRange(v, what) {
  const a = Array.isArray(v) ? v : String(v).split(/[-,]/);
  if (a.length !== 2) throw new Error(what + ' is "<lo>-<hi>" minutes (got ' + v + ')');
  const lo = posInt(a[0], what + ' low'), hi = posInt(a[1], what + ' high');
  if (lo > hi) throw new Error(what + ': low ' + lo + ' is above high ' + hi);
  return [lo, hi];
}
function parseQuiet(v) {
  if (v == null || v === 'off' || v === 'none' || v === '') return null;
  const m = String(v).trim().match(/^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error('quiet hours are "HH:MM-HH:MM" in the company timezone, or off (got ' + v + ')');
  return m[1] + ':' + m[2] + '-' + m[3] + ':' + m[4];
}
const inRange = (n, r) => Array.isArray(r) && Number(n) >= r[0] && Number(n) <= r[1];
function inQuiet(quiet, now) {
  if (!quiet) return false;
  const [a, b] = quiet.split('-').map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; });
  const lp = co.localParts(new Date(now)); const x = lp.hour * 60 + lp.minute;
  return a <= b ? (x >= a && x < b) : (x >= a || x < b);
}
// the temporary change, when one is set and not yet expired
function activeTemporary(c, now) {
  const t = c && c.temporary;
  if (!t || !t.set || t.endedAt || !(Date.parse(t.expiresAt) > now)) return null;
  return t;
}
/* ---------------- Sprint (start-up): tempo.sprint ---------------- */
function rawDoc() { return co.readJson(S.file, null) || co.readJson(S.defaultFile, null) || {}; }
function dailyCapUsd() {
  const b = co.readJson(S.budgetFile, null) || {};
  if (typeof b.dailyUsd === 'number' && Number.isFinite(b.dailyUsd) && b.dailyUsd >= 0) return b.dailyUsd;
  return Number(process.env.DISPATCH_DAILY_USD) > 0 ? Number(process.env.DISPATCH_DAILY_USD) : 2;
}
function unmeteredProviders() { const b = co.readJson(S.budgetFile, null) || {}; return Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders.map(String) : ['claude-cli']; }
function sprintConfig(raw) { const out = {}; for (const k of SP.CONFIG_KEYS) out[k] = raw && raw[k] != null ? raw[k] : SP.SPRINT_DEFAULTS[k]; return out; }
// metered USD since Sprint began: the cap's own numerator (cap-numerator.js meteredSince: the ledger plus runs not
// settled yet), so Sprint's budget, `sprint status`, the spread and the daily cap are one number cut at different times.
// `runs` is how many runs ended since (runs.jsonl, read from the end: lib/bounded.js).
function sprintSpent(sinceMs) {
  if (!sinceMs) return { usd: 0, runs: 0 };
  let rows = []; try { rows = require('./lib/bounded').jsonlWindow(S.runsFile, { sinceMs }).rows; } catch (_) {}
  const old = SP.sprintSpend(rows, sinceMs, unmeteredProviders());
  let usd = old.usd;
  try { usd = require('./cap-numerator.js').meteredSince(sinceMs, { now: S.now(), runsPath: S.runsFile, ledgerPath: path.join(path.dirname(S.runsFile), 'ledger.jsonl'), providers: unmeteredProviders() }); } catch (_) {}
  return { usd: Math.round(usd * 1e6) / 1e6, runs: old.runs };
}
function seatCount() { return Object.keys(loops().agents || {}).length || 1; }
/* sprintOf(c, now, {spend}) -> {on, active, since, until, untilWhy, by, config, budgetUsd, ended:{reason, at}|null, …}
 * on = the switch is on; active = on and none of its ends has come (until, certified + afterCertifiedH, budget spent).
 * The budget end needs the spend (opts.spend or opts.withSpend); effective() never reads runs.jsonl, sprintTick() does
 * once per dispatcher iteration and writes the end, so a spent budget ends Sprint within one iteration. */
function sprintOf(c, now, opts) {
  opts = opts || {};
  const raw = (c && c.tempo && c.tempo.sprint) || null;
  const config = sprintConfig(raw);
  const budgetUsd = config.budgetUsd != null && Number.isFinite(Number(config.budgetUsd)) ? Number(config.budgetUsd) : Math.round(2 * dailyCapUsd() * 100) / 100;
  const v = { on: false, active: false, stored: !!raw, since: (raw && raw.since) || null, by: (raw && raw.by) || null, until: null, untilWhy: null,
    afterCertifiedH: raw && raw.afterCertifiedH != null ? Number(raw.afterCertifiedH) : null, config, budgetUsd, budgetIsDefault: config.budgetUsd == null,
    endedAt: (raw && raw.endedAt) || null, endedBy: (raw && raw.endedBy) || null, endedWhy: (raw && raw.endedWhy) || null, ended: null };
  if (!raw || raw.on !== true) return v;
  v.on = true;
  const sinceMs = Date.parse(raw.since || '') || null;
  let until = Date.parse(raw.until || '') || null, why = until ? 'until ' + iso(until) + ' (set by ' + (raw.by || '?') + ')' : null;
  if (!until && Number(raw.hours) > 0) { until = (sinceMs || now) + Number(raw.hours) * 3600e3; why = raw.hours + ' h from the start'; }
  if (v.afterCertifiedH != null) {
    const ob = co.readJson(S.onboardingFile, null) || {};
    const cert = ob.certified ? Date.parse(ob.certifiedAt || '') : NaN;
    if (Number.isFinite(cert)) { const u = cert + v.afterCertifiedH * 3600e3; if (!until || u < until) { until = u; why = 'certified + ' + v.afterCertifiedH + ' h'; } }
    else if (!until) why = 'until the company is certified, then ' + v.afterCertifiedH + ' h more';
    v.waitingForCertify = !Number.isFinite(cert);
  }
  v.until = until ? iso(until) : null; v.untilWhy = why;
  const spend = opts.spend !== undefined ? opts.spend : opts.withSpend ? sprintSpent(sinceMs || now) : null;
  if (spend) v.spent = spend;
  if (until && until <= now) v.ended = { reason: /certified/.test(why || '') ? 'certified' : 'time', at: until };
  else if (spend && budgetUsd > 0 && spend.usd >= budgetUsd) v.ended = { reason: 'budget', at: now };
  v.active = !v.ended;
  return v;
}
const ownerOnlySprint = () => E('Sprint (start-up) is the owner\'s switch: nobody lifts their own limits. Ask the owner, or propose it for review by finance, risk and people: node company/tools/harness-change.js propose --kind schedule --target cadence.json --change \'{"/tempo/sprint/on":true,"/tempo/sprint/hours":24}\' --why "…" --by <you>', { code: 'owner' });
function saveSprint(doc, sprint, by, what, why) {
  doc.tempo = Object.assign({}, DEFAULT_TEMPO, doc.tempo || {}, { sprint });
  for (const k of ['dispatcherTickMin', 'defaultCooldownMin', 'maxPerTick']) if (doc[k] == null) doc[k] = BUILTIN[k];
  if (!doc.seats) doc.seats = {};
  record(doc, by, what, why || null); save(doc);
}
function sprintConfigFrom(o, into) {
  if (o.budgetUsd != null) { if (o.budgetUsd === 'default') delete into.budgetUsd; else { const n = Number(o.budgetUsd); if (!(Number.isFinite(n) && n >= 0)) throw new Error('--budget-usd is a number of dollars >= 0, or default'); into.budgetUsd = n; } }
  if (o.lanes != null) into.lanes = posInt(o.lanes, 'lanes');
  if (o.maxLanesTotal != null) { const n = Math.floor(Number(o.maxLanesTotal)); if (!(Number.isFinite(n) && n >= 0)) throw new Error('--max-lanes-total is a whole number >= 0'); into.maxLanesTotal = n; }
  if (o.laneTimeoutMin != null) into.laneTimeoutMin = posInt(o.laneTimeoutMin, 'lane-timeout-min');
  if (o.cooldownFloorMin != null) into.cooldownFloorMin = posInt(o.cooldownFloorMin, 'cooldown-floor-min');
  if (o.fallbackTickMin != null) into.fallbackTickMin = posInt(o.fallbackTickMin, 'fallback-tick-min');
  if (o.watchDebounceSec != null) into.watchDebounceSec = posInt(o.watchDebounceSec, 'watch-debounce-sec');
  if (o.spread != null) {   // Sprint's spread of the daily cap over the day: on, off, or off until local midnight
    const v = String(o.spread).trim().toLowerCase();
    if (v === 'on') { into.spreadDailyCap = true; delete into.spreadOffUntil; }
    else if (v === 'off') { into.spreadDailyCap = false; delete into.spreadOffUntil; }
    else if (v === 'today') { into.spreadDailyCap = true; into.spreadOffUntil = iso(nextLocalMidnight(S.now())); }
    else throw new Error('--spread is on, off or today (off until midnight, company time)');
  }
  return into;
}
/* setSprint(on, {by, hours, why, budgetUsd, lanes}): the owner turns Sprint on (until --hours from now, or until turned
 * off) or off. Anyone else is refused and told how to propose it. */
function setSprint(on, o = {}) {
  if (!o.by) throw new Error('--by <owner> is required');
  if (!isOwner(o.by)) throw ownerOnlySprint();
  const now = S.now(); const doc = rawDoc();
  const cur = Object.assign({}, (doc.tempo && doc.tempo.sprint) || {});
  const cfg = {}; for (const k of SP.CONFIG_KEYS) if (cur[k] != null) cfg[k] = cur[k];
  sprintConfigFrom(o, cfg);
  let sprint, what;
  if (on) {
    const hours = o.hours != null ? Number(o.hours) : null;
    if (hours != null && !(Number.isFinite(hours) && hours > 0 && hours <= 24 * 14)) throw new Error('--hours is a number of hours above 0 (at most 336)');
    sprint = Object.assign(cfg, { on: true, since: iso(now), until: hours ? iso(now + hours * 3600e3) : null, by: o.by });
    what = 'Sprint on' + (hours ? ' for ' + hours + ' h, until ' + sprint.until : ', until turned off');
  } else {
    if (cur.on !== true) return { ok: true, note: 'Sprint is already off' };
    sprint = Object.assign(cfg, { on: false, since: cur.since || null, until: cur.until || null, by: cur.by || null, endedAt: iso(now), endedBy: o.by, endedWhy: typeof o.why === 'string' && o.why ? o.why.slice(0, 300) : 'turned off by the owner' });
    what = 'Sprint off';
  }
  saveSprint(doc, sprint, o.by, what, typeof o.why === 'string' ? o.why : null);
  return { ok: true, sprint: sprintOf(load(), S.now()), note: on ? 'the dispatcher loop picks it up within 30 s' : 'back to the base tempo within 30 s' };
}
// the next company-local midnight after `now` (co.TZ), to the minute
function nextLocalMidnight(now) {
  const lp = co.localParts(new Date(now));
  const sec = Number(new Intl.DateTimeFormat('en-GB', { timeZone: co.TZ, second: '2-digit' }).format(new Date(now))) || 0;
  return now - ((lp.hour * 60 + lp.minute) * 60 + sec) * 1000 - (now % 1000) + 24 * 3600e3;
}
function setSprintConfig(o = {}) {
  if (!o.by) throw new Error('--by <owner> is required');
  if (!isOwner(o.by)) throw ownerOnlySprint();
  const doc = rawDoc(); const sprint = Object.assign({ on: false }, (doc.tempo && doc.tempo.sprint) || {});
  const before = JSON.stringify(sprint); sprintConfigFrom(o, sprint);
  if (JSON.stringify(sprint) === before) throw new Error('nothing to set');
  saveSprint(doc, sprint, o.by, 'Sprint settings: ' + SP.CONFIG_KEYS.filter(k => sprint[k] != null).map(k => k + '=' + sprint[k]).join(', '), o.why || null);
  return { ok: true, sprint: sprintOf(load(), S.now()) };
}
const hhmmOf = ms => { const lp = co.localParts(new Date(ms)); return lp.date + ' ' + String(lp.time || '').slice(0, 5); };
/* the owner's lines (plain words; the numbers and commands ride in `technical`) */
function endNotice(v, c, st) {
  const why = v.ended.reason === 'budget' ? 'it spent its start-up budget' : v.ended.reason === 'certified' ? 'the company finished its start-up checks' : 'its time was up';
  return { text: 'Sprint ended by itself because ' + why + ', so the crew is back to its normal pace. You can turn Sprint on again in Settings › Tempo and routines.', technical: endMessage(v, c, st) };
}
const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function cadenceNotice(by, done) {
  const n = done.length;
  return { text: (by || 'The crew') + ' changed how often ' + (n === 1 ? 'one part' : (NUM[n] || n) + ' parts') + ' of the crew\'s work runs, as your settings allow.', technical: 'Cadence changed' + (by ? ' by ' + by : '') + ': ' + done.join('; ') + '.' };
}
function endMessage(v, c, st) {
  const b = c.bounds || {};
  const head = v.ended.reason === 'budget' ? 'Sprint (start-up) ended by itself: it spent its budget ($' + (v.spent ? v.spent.usd.toFixed(2) : '?') + ' of $' + v.budgetUsd.toFixed(2) + ' metered since ' + (v.since ? hhmmOf(Date.parse(v.since)) : 'it began') + ').'
    : v.ended.reason === 'certified' ? 'Sprint (start-up) ended by itself: the company was certified, and Sprint was set to run until ' + v.afterCertifiedH + ' h after that (' + hhmmOf(v.ended.at) + ').'
    : 'Sprint (start-up) ended by itself at ' + hhmmOf(v.ended.at) + ', the time it was set to run until.';
  const ran = st && st.wakes ? ' While it ran: ' + st.itemsDone + ' item' + (st.itemsDone === 1 ? '' : 's') + ' done in ' + st.wakes + ' wake' + (st.wakes === 1 ? '' : 's') + (st.idleWakes ? ' (' + st.idleWakes + ' of them did nothing)' : '') + ', $' + (st.spentUsd || 0).toFixed(2) + ' metered.' : '';
  return head + ' The company is back on its normal tempo: the dispatcher checks every ' + c.dispatcherTickMin + ' min, a seat rests ' + c.defaultCooldownMin + ' min between wakes, and at most ' + b.maxWakesPerHour + ' wakes an hour.' + ran
    + ' To turn it back on: Settings › Tempo and routines in the console, or node company/tools/cadence.js sprint on --by owner.';
}
/* sprintTick({log, notify}) — the dispatcher loop runs this before every tick: stamps the start of a Sprint switched on
 * without one (the founding default, a reviewed proposal), and ends a Sprint whose time or budget is up: written to
 * cadence.json, one plain line in the dispatcher log, one owner message. */
function sprintTick(o) {
  o = o || {}; const log = o.log || (() => {}); const notify = o.notify || S.notify;
  const now = S.now(); const doc = rawDoc(); const raw = doc.tempo && doc.tempo.sprint;
  if (!raw || raw.on !== true) return { on: false };
  const sprint = Object.assign({}, raw);
  if (!sprint.since) {
    sprint.since = iso(now);
    if (Number(sprint.hours) > 0) { sprint.until = iso(now + Number(sprint.hours) * 3600e3); delete sprint.hours; }
    saveSprint(doc, sprint, 'dispatcher', 'Sprint started' + (sprint.until ? ' (until ' + sprint.until + ')' : ''), sprint.by ? 'switched on by ' + sprint.by : null);
    log('SPRINT started (switched on by ' + (sprint.by || '?') + '): seats with new open work wake as soon as they are idle; the wake caps are lifted; the budget, halts, guardrails and the pacer still hold');
  }
  const c = load(); const v = sprintOf(c, now, { withSpend: true });
  if (!v.ended) return { on: true, active: true, sprint: v };
  let st = null; try { st = sprintStatus({ now, view: v }); } catch (_) {}
  const d2 = rawDoc(); const s2 = Object.assign({}, d2.tempo.sprint, { on: false, endedAt: iso(v.ended.at), endedBy: 'itself', endedWhy: v.ended.reason });
  saveSprint(d2, s2, 'dispatcher', 'Sprint ended by itself (' + v.ended.reason + ')', null);
  const message = endMessage(v, c, st);
  log('SPRINT ENDED: ' + message);
  const n = endNotice(v, c, st);
  try { notify(n.text, n.technical); } catch (e) { log('SPRINT ENDED: the owner message failed: ' + e.message); }
  return { on: false, ended: true, reason: v.ended.reason, message };
}
/* sprintStatus() -> how the Sprint is going: idle-wake ratio, items done, spend per item, Sprint spend vs budget,
 * proposals/h vs reviews/h, time to certified. The dispatcher keeps the wake and item counts (sprint-metrics.json). */
function sprintStatus(o) {
  o = o || {}; const now = o.now || S.now(); const c = load();
  const v = o.view || sprintOf(c, now, { withSpend: true });
  const sinceMs = Date.parse(v.since || '') || null;
  const endMs = v.on ? now : (Date.parse(v.endedAt || '') || now);
  const m0 = co.readJson(S.metricsFile, null) || {};
  const m = v.since && m0.since === v.since ? m0 : {};
  const spent = v.spent || sprintSpent(sinceMs);
  const hours = sinceMs ? Math.max(0, (endMs - sinceMs) / 3600e3) : 0;
  let proposals = 0, reviews = 0;
  if (sinceMs) {
    let rows = []; try { rows = require('./lib/bounded').jsonlWindow(S.harnessLog, { sinceMs, tsOf: r => Date.parse(r.at) || 0 }).rows; } catch (_) {}
    for (const r of rows) { const t = Date.parse(r.at) || 0; if (t < sinceMs || t > endMs) continue; if (r.event === 'proposed') proposals++; else if (r.event === 'approved' || r.event === 'rejected') reviews++; }
  }
  const ob = co.readJson(S.onboardingFile, null) || {};
  const founded = Date.parse(((ob.steps || {}).founded || {}).at || '') || null, cert = ob.certified ? Date.parse(ob.certifiedAt || '') || null : null;
  const wakes = Number(m.wakes) || 0, idle = Number(m.idleWakes) || 0, resolved = Number(m.resolved) || 0, done = Number(m.itemsDone) || 0;
  const per = h => hours > 0 ? Math.round(h / hours * 10) / 10 : null;
  return { ok: true, on: v.on, active: v.active, since: v.since, until: v.until, untilWhy: v.untilWhy, by: v.by, endedAt: v.endedAt, endedWhy: v.endedWhy, ended: v.ended,
    hours: Math.round(hours * 10) / 10, wakes, idleWakes: idle, idleWakeRatio: resolved ? Math.round(idle / resolved * 100) / 100 : null, itemsDone: done,
    spentUsd: spent.usd, runs: spent.runs, budgetUsd: v.budgetUsd, budgetIsDefault: v.budgetIsDefault, usdPerItem: done ? Math.round(spent.usd / done * 10000) / 10000 : null,
    proposals, reviews, proposalsPerHour: per(proposals), reviewsPerHour: per(reviews),
    certified: !!cert, timeToCertifiedH: founded && cert ? Math.round((cert - founded) / 3600e3 * 10) / 10 : null, sinceFoundedH: founded ? Math.round((now - founded) / 3600e3 * 10) / 10 : null,
    lanes: m.lanes || {}, config: v.config, updatedAt: m.updatedAt || null };
}

/* effective({now}) -> what the dispatcher runs on right now: the base, or an active temporary change over it. */
function effective(opts) {
  const now = (opts && opts.now) || S.now();
  const c = (opts && opts.cadence) || load();
  const base = { tickMin: c.dispatcherTickMin, cooldownMin: c.defaultCooldownMin, maxPerTick: c.maxPerTick };
  const t = activeTemporary(c, now);
  const eff = Object.assign({}, base);
  if (t) { if (t.set.dispatcherTickMin) eff.tickMin = t.set.dispatcherTickMin; if (t.set.defaultCooldownMin) eff.cooldownMin = t.set.defaultCooldownMin; }
  let reason = t ? 'temporary (' + Object.entries(t.set).map(([k, v]) => k + '=' + v).join(', ') + ') by ' + t.by + ' until ' + t.expiresAt + ': ' + t.why
    : 'base (owner-set)' + (c.temporary && c.temporary.set ? '; the last speed-up by ' + c.temporary.by + ' expired at ' + c.temporary.expiresAt : '');
  let source = t ? 'temporary' : 'base', sprint = null;
  const sp = sprintOf(c, now);
  if (sp.active) {
    // Sprint: the timer is only a fallback (inbox changes wake the loop: dispatcher-loop.js), every seat may wake in one
    // tick, and a seat with NEW open work rests only the floor (dispatch.js); unchanged work keeps cooldownMin
    eff.tickMin = Math.min(Number(eff.tickMin) || sp.config.fallbackTickMin, sp.config.fallbackTickMin);
    eff.maxPerTick = Math.max(Number(eff.maxPerTick) || 1, seatCount());
    sprint = { on: true, since: sp.since, until: sp.until, untilWhy: sp.untilWhy, by: sp.by, cooldownFloorMin: sp.config.cooldownFloorMin, watchDebounceSec: sp.config.watchDebounceSec,
      minTickGapSec: sp.config.minTickGapSec, lanes: sp.config.lanes, budgetUsd: sp.budgetUsd, spreadDailyCap: SP.spreadOn(sp.config, now),
      spreadSetting: sp.config.spreadDailyCap === false ? 'off' : SP.spreadOn(sp.config, now) ? 'on' : 'today', spreadOffUntil: sp.config.spreadOffUntil || null,
      unchangedRestMin: sp.config.unchangedRestMin };
    source = 'sprint';
    reason = 'Sprint (start-up) by ' + (sp.by || '?') + (sp.until ? ' until ' + sp.until : sp.untilWhy ? ' ' + sp.untilWhy : ', until turned off') + ': seats with new open work wake when idle (floor ' + sp.config.cooldownFloorMin + ' min), inbox changes wake the dispatcher, wake caps lifted; budget, halts, guardrails and the pacer still hold';
  }
  return Object.assign(eff, { source, base, temporary: t, sprint, quiet: inQuiet(c.bounds.quietHours, now), reason });
}
// the time of the last tempo change, for the rate limit: a recorded change, or the end of the last speed-up
function lastTempoChange(c, now) {
  let at = Date.parse(c.tempoLastChangeAt || '') || 0;
  const t = c.temporary;
  if (t && t.set) { const end = Math.min(Date.parse(t.expiresAt) || 0, Date.parse(t.endedAt || '') || Infinity); if (end <= now && end > at) at = end; }
  return at;
}
function rateLimit(c, now) {
  const gap = Number(c.tempo.minChangeIntervalMin) * 60000;
  const last = lastTempoChange(c, now);
  if (last && now - last < gap) {
    const wait = Math.ceil((gap - (now - last)) / 60000);
    throw E('tempo changed less than ' + c.tempo.minChangeIntervalMin + ' min ago (' + iso(last) + '); try again in ' + wait + ' min. The limit (tempo.minChangeIntervalMin) is the owner\'s', { code: 'rate' });
  }
}
const proposeHint = set => 'outside the owner\'s bounds: ask the owner, or propose it for review by finance, risk and people: node company/tools/harness-change.js propose --kind schedule --target cadence.json --change \'' + JSON.stringify(set) + '\' --why "…" --by <you>';

/* wakes against the caps: company/state/tempo-wakes.json, the last 24 hours */
function readWakes(now) {
  const w = co.readJson(S.wakesFile, null) || {};
  return (Array.isArray(w.wakes) ? w.wakes : []).filter(x => x && Number(x.at) > now - 86400e3);
}
function wakeCounts(now, list) {
  const wakes = list || readWakes(now);
  return { hour: wakes.filter(x => x.at > now - 3600e3).length, day: wakes.length };
}
/* tempoAllows(seatId, now, {record, ownerWake}) -> {ok, reason, hour, day, maxPerHour, maxPerDay}
 * The dispatcher asks before each wake. Owner-message wakes are never held (the owner is waiting) but are counted.
 * With record:true an allowed wake is written down (call it right before firing, and only for a real tick). */
function tempoAllows(seatId, now, opts) {
  opts = opts || {}; now = Number(now) || S.now();
  let c; try { c = load(); } catch (_) { return { ok: true, reason: 'cadence unreadable: not held' }; }
  const b = c.bounds; const wakes = readWakes(now); const n = wakeCounts(now, wakes);
  const sprint = sprintOf(c, now).active;   // Sprint lifts the hourly and daily caps (wakes are still counted); quiet hours still hold
  const out = { hour: n.hour, day: n.day, maxPerHour: b.maxWakesPerHour, maxPerDay: b.maxWakesPerDay, ok: true, reason: null, sprint };
  if (!opts.ownerWake) {
    if (inQuiet(b.quietHours, now)) Object.assign(out, { ok: false, reason: 'quiet hours ' + b.quietHours + ' (' + co.TZ + ')' });
    else if (sprint) { /* caps lifted */ }
    else if (Number(b.maxWakesPerHour) > 0 && n.hour >= b.maxWakesPerHour) Object.assign(out, { ok: false, reason: n.hour + ' wakes in the last hour, cap ' + b.maxWakesPerHour });
    else if (Number(b.maxWakesPerDay) > 0 && n.day >= b.maxWakesPerDay) Object.assign(out, { ok: false, reason: n.day + ' wakes in the last 24 h, cap ' + b.maxWakesPerDay });
  }
  if (out.ok && opts.record) recordWake(seatId, now, { ownerWake: opts.ownerWake, wakes, out });
  return out;
}
/* count one wake that really started (dispatch.js calls it only after the model, quota, refusal and route holds passed:
   2026-11-19 a company held by its models recorded 1,500 "wakes" for ~370 runs and froze on its own daily cap) */
function recordWake(seatId, now, o) {
  o = o || {}; now = Number(now) || S.now();
  const wakes = o.wakes || readWakes(now);
  {
    try {
      wakes.push({ at: now, seat: String(seatId || '?'), owner: o.ownerWake ? true : undefined });
      fs.mkdirSync(path.dirname(S.wakesFile), { recursive: true });
      const tmp = S.wakesFile + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify({ _doc: 'wakes the dispatcher started, last 24 h (cadence.js tempoAllows); read against bounds.maxWakesPerHour/Day', wakes }) + '\n');
      fs.renameSync(tmp, S.wakesFile);
    } catch (_) {}
    if (o.out) { o.out.hour++; o.out.day++; }
  }
}

/* ---------------- peak-price clocks (offpeak-clocks.js) ---------------- */
function cronDays(dow) {
  if (dow === '*') return null;
  const out = new Set();
  for (const part of String(dow).split(',')) {
    const m = part.match(/^(\d)(?:-(\d))?$/); if (!m) return null;
    for (let d = Number(m[1]); d <= Number(m[2] != null ? m[2] : m[1]); d++) out.add(d % 7);
  }
  return out;
}
/* the peak findings for a seat's loopEvery (only a cron at one clock a day can land in a peak block) */
function peakFindings(seatId, every, now) {
  const want = typeof every === 'string' ? parseEvery(every) : every;
  if (want.kind !== 'cron') return [];
  const [mi, hr, , , dow] = want.expr.split(' ');
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(hr)) return [];
  let OC, cfg; try { OC = require('./offpeak-clocks.js'); cfg = S.peakCfg(); } catch (_) { return []; }
  const row = (loops().agents || {})[seatId] || {};
  const job = { id: seatId, name: row.loop || seatId, enabled: true, schedule: { kind: 'cron', expr: want.expr, tz: co.TZ, fields: { hour: [Number(hr)], minute: [Number(mi)] } } };
  const days = cronDays(dow); const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const t0 = now || S.now();
  for (let k = 0; k < 7; k++) {
    const at = t0 + k * 86400e3;
    if (days && !days.has(WD[co.localParts(new Date(at)).weekday])) continue;
    const f = OC.audit([job], new Date(at), { cfg });
    if (f.length) return f;
  }
  return [];
}

/* ---------------- the merged view ---------------- */
function loopState() { return co.readJson(S.loopStateFile, null); }
function view() {
  const c = load(); const L = loops(); const agents = L.agents || {};
  const now = S.now();
  const seats = {};
  for (const [id, row] of Object.entries(agents)) {
    const set = c.seats[id] || {};
    const v = { name: row.name || id, loop: row.loop || null };
    for (const f of SEAT_FIELDS) {
      if (set[f] !== undefined) v[f] = { value: set[f], from: 'cadence' };
      else if (row[f] !== undefined) v[f] = { value: row[f], from: 'loops' };
      else if (f === 'cooldownMin') v[f] = { value: c.defaultCooldownMin, from: 'default' };
    }
    if (set.loopEvery !== undefined) v.loopEvery = set.loopEvery;
    if (set.peakOk) v.peakOk = true;
    seats[id] = v;
  }
  const unknown = Object.keys(c.seats).filter(id => !agents[id]);
  const eff = effective({ now, cadence: c });
  const n = wakeCounts(now);
  return { dispatcherTickMin: c.dispatcherTickMin, defaultCooldownMin: c.defaultCooldownMin, maxPerTick: c.maxPerTick, seats, unknownSeats: unknown,
    bounds: c.bounds, tempo: c.tempo,
    effective: { tickMin: eff.tickMin, cooldownMin: eff.cooldownMin, maxPerTick: eff.maxPerTick, source: eff.source, quiet: eff.quiet, reason: eff.reason, sprint: eff.sprint },
    temporary: eff.temporary ? Object.assign({}, eff.temporary) : null,
    sprint: sprintOf(c, now),
    wakes: { hour: n.hour, day: n.day, maxPerHour: c.bounds.maxWakesPerHour, maxPerDay: c.bounds.maxWakesPerDay },
    loop: loopState(), changes: (c.changes || []).slice(-10).reverse(),
    file: path.relative(co.ROOT, fs.existsSync(S.file) ? S.file : S.defaultFile) };
}
function record(c, by, what, why) {
  c.changes = (c.changes || []).concat([Object.assign({ at: iso(S.now()), by, what }, why ? { why } : {})]).slice(-50);
}
/* ASKS: what each governed tempo change says to the owner (lib/governance.js decide): plain words up front, the setting
 * names and numbers in `technical`. Exported so a test files each at approve. */
const durWords = min => { const m = Number(min); if (!(m > 0)) return 'a while'; if (m % 60 === 0) return m === 60 ? 'the next hour' : 'the next ' + (m / 60) + ' hours'; return 'the next ' + m + ' minutes'; };
const plainWhy = t => { const g = S.governance(); const x = g && typeof g.plainPart === 'function' && t ? g.plainPart(String(t).replace(/\s+/g, ' ').trim().replace(/[.!]$/, '').slice(0, 200)) : null; return x ? x.replace(/^./, c => c.toLowerCase()) : null; };
const ASKS = {
  // a temporary change to the company tempo: faster when the new numbers are smaller than the base
  tempo: ({ set, base, minutes, what, why }) => {
    const ks = ['dispatcherTickMin', 'defaultCooldownMin'].filter(k => set[k] != null && base[k] != null);
    const faster = ks.some(k => Number(set[k]) < Number(base[k])), slower = ks.some(k => Number(set[k]) > Number(base[k]));
    return { summary: (faster && !slower ? 'have the crew pick up work more often' : slower && !faster ? 'have the crew pick up work less often' : 'change how often the crew picks up work') + ' for ' + durWords(minutes),
      recommendation: 'yes' + (plainWhy(why) ? ': ' + plainWhy(why) : ', it stays inside the limits you set'), default: 'the crew keeps its usual pace',
      technical: 'Temporary tempo change for ' + minutes + ' min (' + what + '): ' + why };
  },
  seat: ({ name, seatId, what, why }) => ({ summary: 'change how often ' + name + ' works',
    recommendation: 'yes' + (plainWhy(why) ? ': ' + plainWhy(why) : ', it stays inside the limits you set'), default: name + ' keeps their usual pace',
    technical: 'Seat ' + seatId + ': ' + what.join(', ') + ' (' + why + ')' }),
};
function gateOrThrow(by, ask, ref) {
  const d = S.decide('schedules', Object.assign({ by, ref }, ask));
  if (!d || !d.allowed) { const gov = S.governance(); throw E(gov && d ? gov.refusal('schedules', d) : 'self-governance refused the change', { code: 'gate', questionId: d && d.questionId }); }
  return d;
}

/* set-default: the owner sets the base; an agent sets a temporary change inside bounds */
function setDefault(minutes, o = {}) {
  const { by } = o;
  if (!by) throw new Error('--by <name> is required');
  const c = load(); const now = S.now(); const set = {};
  if (minutes != null) set.dispatcherTickMin = posInt(minutes, 'dispatcher tick minutes');
  if (o.cooldown != null) set.defaultCooldownMin = posInt(o.cooldown, 'cooldown');
  if (o.maxPerTick != null) set.maxPerTick = posInt(o.maxPerTick, 'max-per-tick');
  if (!Object.keys(set).length) throw new Error('nothing to set');
  const what = Object.entries(set).map(([k, v]) => k + '=' + v).join(', ');
  if (isOwner(by)) {
    Object.assign(c, set);
    if (activeTemporary(c, now)) { c.temporary = Object.assign({}, c.temporary, { endedAt: iso(now), endedBy: by, endedWhy: 'the owner set new base values' }); }
    record(c, by, 'base: ' + what, typeof o.why === 'string' ? o.why : null); save(c);
    return { ok: true, base: true, set: Object.keys(set).map(k => k + '=' + set[k]) };
  }
  const why = needWhy(o.why);
  const ptrs = {}; for (const [k, v] of Object.entries(set)) ptrs['/' + k] = v;
  if (c.tempo.mode !== 'bounded-auto') throw E('tempo mode is "' + c.tempo.mode + '": the crew may not change the tempo on its own; ' + proposeHint(ptrs), { code: 'bounds' });
  const out = [];
  if (set.maxPerTick != null) out.push('maxPerTick (wakes per tick has no crew range; the wake caps bound it)');
  if (set.dispatcherTickMin != null && !inRange(set.dispatcherTickMin, c.bounds.tickMin)) out.push('dispatcherTickMin ' + set.dispatcherTickMin + ' (bounds ' + c.bounds.tickMin.join('-') + ')');
  if (set.defaultCooldownMin != null && !inRange(set.defaultCooldownMin, c.bounds.cooldownMin)) out.push('defaultCooldownMin ' + set.defaultCooldownMin + ' (bounds ' + c.bounds.cooldownMin.join('-') + ')');
  if (out.length) throw E(out.join('; ') + ' is ' + proposeHint(ptrs), { code: 'bounds' });
  rateLimit(c, now);
  gateOrThrow(by, ASKS.tempo({ set, base: c, minutes: c.tempo.autoExpireMin, what, why }), 'cadence:tempo:' + what);
  const expiresAt = iso(now + Number(c.tempo.autoExpireMin) * 60000);
  c.temporary = { set, by, why, at: iso(now), expiresAt };
  c.tempoLastChangeAt = iso(now);
  record(c, by, 'temporary until ' + expiresAt + ': ' + what, why); save(c);
  return { ok: true, temporary: true, set: Object.keys(set).map(k => k + '=' + set[k]), expiresAt, note: 'back to the base (' + ['dispatcherTickMin', 'defaultCooldownMin'].filter(k => set[k] != null).map(k => k + '=' + c[k]).join(', ') + ') at ' + expiresAt + '; the dispatcher loop picks it up within a minute' };
}
function endTemporary(o = {}) {
  if (!o.by) throw new Error('--by <name> is required');
  const c = load(); const now = S.now();
  if (!activeTemporary(c, now)) return { ok: true, note: 'no temporary change is active' };
  c.temporary = Object.assign({}, c.temporary, { endedAt: iso(now), endedBy: o.by, endedWhy: typeof o.why === 'string' ? o.why.slice(0, 300) : null });
  record(c, o.by, 'ended the temporary change early', typeof o.why === 'string' ? o.why : null); save(c);
  return { ok: true, ended: true };
}
function setSeat(seatId, o = {}) {
  if (!o.by) throw new Error('--by <name> is required');
  if (!seatId || !(loops().agents || {})[seatId]) throw new Error('no seat "' + seatId + '" in loops.json');
  const c = load(); const now = S.now(); const owner = isOwner(o.by);
  const s = Object.assign({}, c.seats[seatId] || {}); const what = [];
  let tempoField = false; let every = null;
  if (o.loopEvery != null) { every = parseEvery(o.loopEvery); s.loopEvery = every.text; what.push('loopEvery=' + s.loopEvery); tempoField = true; }
  if (o.cooldown != null) { s.cooldownMin = posInt(o.cooldown, 'cooldown'); what.push('cooldownMin=' + s.cooldownMin); tempoField = true; }
  if (o.priority != null) { const n = Number(o.priority); if (!Number.isFinite(n)) throw new Error('priority must be a number'); s.priority = n; what.push('priority=' + n); }
  if (o.wakeOnInbox != null) { s.wakeOnInbox = onOff(o.wakeOnInbox, 'wake-on-inbox'); what.push('wakeOnInbox=' + s.wakeOnInbox); }
  if (o.wakeOnOwner != null) { s.wakeOnOwnerMessage = onOff(o.wakeOnOwner, 'wake-on-owner'); what.push('wakeOnOwnerMessage=' + s.wakeOnOwnerMessage); }
  if (o.peakOk != null) {
    if (!owner) throw E('only the owner lets a loop clock run inside a peak-price block (--peak-ok)', { code: 'owner' });
    s.peakOk = onOff(o.peakOk, 'peak-ok'); if (!s.peakOk) delete s.peakOk; what.push('peakOk=' + !!s.peakOk);
  }
  if (!what.length) throw new Error('nothing to set');
  if (every && !s.peakOk) {
    const f = peakFindings(seatId, every, now);
    if (f.length) throw E('loop clock ' + every.text + ' lands in a peak-price block (' + f[0].block + '): ' + f[0].fix + '. Only the owner can allow it (set ' + seatId + ' --peak-ok on --by owner)', { code: 'peak' });
  }
  let why = null;
  if (!owner) {
    why = needWhy(o.why);
    const ptrs = {}; if (o.loopEvery != null) ptrs['/seats/' + seatId + '/loopEvery'] = s.loopEvery; if (o.cooldown != null) ptrs['/seats/' + seatId + '/cooldownMin'] = s.cooldownMin;
    if (tempoField) {
      if (c.tempo.mode !== 'bounded-auto') throw E('tempo mode is "' + c.tempo.mode + '": the crew may not change the tempo on its own; ' + proposeHint(ptrs), { code: 'bounds' });
      if (o.cooldown != null && !inRange(s.cooldownMin, c.bounds.cooldownMin)) throw E('cooldownMin ' + s.cooldownMin + ' (bounds ' + c.bounds.cooldownMin.join('-') + ') is ' + proposeHint(ptrs), { code: 'bounds' });
      if (every && every.kind === 'interval' && every.minutes < c.bounds.cooldownMin[0]) throw E('a loop every ' + every.minutes + ' min runs more often than the cooldown floor (' + c.bounds.cooldownMin[0] + ' min): ' + proposeHint(ptrs), { code: 'bounds' });
      rateLimit(c, now);
    }
    gateOrThrow(o.by, ASKS.seat({ name: (loops().agents[seatId] || {}).name || 'one of the crew', seatId, what, why }), 'cadence:seat:' + seatId + ':' + what.join(','));
    if (tempoField) c.tempoLastChangeAt = iso(now);
  }
  c.seats[seatId] = s; record(c, o.by, seatId + ': ' + what.join(', '), why || (typeof o.why === 'string' ? o.why : null)); save(c);
  return { ok: true, seat: seatId, set: what, next: 'node company/tools/cadence.js apply' };
}
/* bounds and tempo: the owner's alone */
function setBounds(o = {}) {
  const set = {};
  if (o.tickMin != null) set['/bounds/tickMin'] = parseRange(o.tickMin, 'tick-min');
  if (o.cooldownMin != null) set['/bounds/cooldownMin'] = parseRange(o.cooldownMin, 'cooldown-min');
  if (o.maxWakesPerHour != null) set['/bounds/maxWakesPerHour'] = posInt(o.maxWakesPerHour, 'max-wakes-per-hour');
  if (o.maxWakesPerDay != null) set['/bounds/maxWakesPerDay'] = posInt(o.maxWakesPerDay, 'max-wakes-per-day');
  if (o.quietHours != null) set['/bounds/quietHours'] = parseQuiet(o.quietHours);
  if (o.mode != null) { if (!['fixed', 'bounded-auto'].includes(o.mode)) throw new Error('--mode is fixed or bounded-auto'); set['/tempo/mode'] = o.mode; }
  if (o.autoExpireMin != null) set['/tempo/autoExpireMin'] = posInt(o.autoExpireMin, 'auto-expire-min');
  if (o.minChangeIntervalMin != null) set['/tempo/minChangeIntervalMin'] = posInt(o.minChangeIntervalMin, 'min-change-interval-min');
  if (!Object.keys(set).length) throw new Error('nothing to set');
  if (!o.by) throw new Error('--by owner is required');
  if (!isOwner(o.by)) throw E('bounds and tempo are the owner\'s: nobody changes their own limits. Ask the owner, or propose it: node company/tools/harness-change.js propose --kind schedule --target cadence.json --change \'' + JSON.stringify(set) + '\' --why "…" --by <you> (reviewed by finance, risk and people)', { code: 'owner' });
  const c = load(); const raw = co.readJson(S.file, null) || co.readJson(S.defaultFile, null) || {};
  const b = Object.assign({}, c.bounds), t = Object.assign({}, c.tempo);
  for (const [k, v] of Object.entries(set)) { const [, sec, key] = k.split('/'); (sec === 'bounds' ? b : t)[key] = v; }
  if (b.tickMin[0] < 1 || b.cooldownMin[0] < 1) throw new Error('bounds must stay >= 1');
  const next = Object.assign({}, raw, { bounds: b, tempo: t });
  for (const k of ['dispatcherTickMin', 'defaultCooldownMin', 'maxPerTick']) if (next[k] == null) next[k] = c[k];
  if (!next.seats) next.seats = {};
  record(next, o.by, 'bounds/tempo: ' + Object.entries(set).map(([k, v]) => k.slice(1) + '=' + JSON.stringify(v)).join(', '), typeof o.why === 'string' ? o.why : null);
  save(next);
  return { ok: true, set: Object.keys(set) };
}

/* For harness-change.js --kind schedule --target cadence.json: check a proposed {pointer: value} set and turn it into
 * whole-section sets ("/bounds", "/tempo", "/seats/<id>", or a base number), so the reviewed apply writes exactly that. */
const PROPOSABLE = /^\/(dispatcherTickMin|defaultCooldownMin|maxPerTick|bounds\/(tickMin|cooldownMin|maxWakesPerHour|maxWakesPerDay|quietHours|loopFloorMin)|tempo\/(mode|autoExpireMin|minChangeIntervalMin)|tempo\/sprint\/(on|hours|lanes|budgetUsd)|seats\/[A-Za-z0-9_-]+\/(loopEvery|cooldownMin|loopFloorMin))$/;
function proposal(doc, set, opts) {
  opts = opts || {};
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) throw new Error('--change is {"/pointer": value, …} on cadence.json');
  const d = JSON.parse(JSON.stringify(doc || {}));
  const out = {};
  for (const [p, v0] of Object.entries(set)) {
    if (!PROPOSABLE.test(p)) throw new Error(p + ' is not a tempo number in cadence.json (allowed: /dispatcherTickMin, /defaultCooldownMin, /maxPerTick, /bounds/*, /tempo/*, /tempo/sprint/on|hours|lanes|budgetUsd, /seats/<id>/loopEvery|cooldownMin)');
    const parts = p.slice(1).split('/');
    let v = v0;
    if (parts[0] === 'tempo' && parts[1] === 'sprint') {
      // Sprint through review: only switching it ON (with hours, lanes, a budget); the switch itself stays the owner's
      // to turn off, and a reviewed Sprint starts when the dispatcher loop first sees it (sprintTick stamps since/until)
      const cur = Object.assign({}, DEFAULT_TEMPO, d.tempo || {}).sprint || {};
      const sp = Object.assign({}, cur);
      if (parts[2] === 'on') { if (v0 !== true) throw new Error('/tempo/sprint/on can only be proposed as true (turning Sprint off is the owner\'s, or it ends by itself)'); }
      else if (parts[2] === 'hours') { const n = Number(v0); if (!(Number.isFinite(n) && n > 0 && n <= 72)) throw new Error('/tempo/sprint/hours is above 0 and at most 72 for a proposal'); sp.hours = n; }
      else if (parts[2] === 'lanes') sp.lanes = posInt(v0, 'lanes');
      else { const n = Number(v0); if (!(Number.isFinite(n) && n >= 0)) throw new Error('/tempo/sprint/budgetUsd is dollars >= 0'); sp.budgetUsd = n; }
      if (set['/tempo/sprint/on'] === true) Object.assign(sp, { on: true, since: null, until: null, by: 'a reviewed proposal' }), delete sp.endedAt, delete sp.endedBy, delete sp.endedWhy, delete sp.afterCertifiedH;
      d.tempo = Object.assign({}, DEFAULT_TEMPO, d.tempo || {}, { sprint: sp }); out['/tempo'] = d.tempo;
      continue;
    }
    if (parts[0] === 'bounds') {
      v = /Min$/.test(parts[1]) && parts[1] !== 'quietHours' ? parseRange(v0, parts[1]) : parts[1] === 'quietHours' ? parseQuiet(v0) : posInt(v0, parts[1]);
      d.bounds = Object.assign({}, DEFAULT_BOUNDS, d.bounds || {}, { [parts[1]]: v }); out['/bounds'] = d.bounds;
    } else if (parts[0] === 'tempo') {
      if (parts[1] === 'mode') { if (!['fixed', 'bounded-auto'].includes(v0)) throw new Error('/tempo/mode is fixed or bounded-auto'); } else v = posInt(v0, parts[1]);
      d.tempo = Object.assign({}, DEFAULT_TEMPO, d.tempo || {}, { [parts[1]]: v }); out['/tempo'] = d.tempo;
    } else if (parts[0] === 'seats') {
      if (opts.agents && !opts.agents[parts[1]]) throw new Error('no seat "' + parts[1] + '" in loops.json');
      if (parts[2] === 'loopEvery') {
        const w = parseEvery(v0); v = w.text;
        const seatRow = ((d.seats || {})[parts[1]]) || {};
        if (!seatRow.peakOk && opts.peak !== false) { const f = peakFindings(parts[1], w, opts.now); if (f.length) throw new Error('loop clock ' + w.text + ' lands in a peak-price block (' + f[0].block + '); only the owner can allow that'); }
      } else v = posInt(v0, parts[2]);
      d.seats = Object.assign({}, d.seats || {}); d.seats[parts[1]] = Object.assign({}, d.seats[parts[1]] || {}, { [parts[2]]: v });
      out['/seats'] = d.seats;
    } else { v = posInt(v0, parts[0]); out[p] = v; }
  }
  return out;
}

/* duties-floor: a suggestion, never an apply. With duties detecting work (docs/DUTIES.md), a seat's own loop routine only
 * has to catch what no duty sees, so it can run every 6-12 h. For each seat but the CEO: its loopEvery in cadence.json,
 * the floor (seats.<id>.loopFloorMin inside bounds.loopFloorMin, else the low bound) and, when it runs more often or is
 * not set here, the two ways to apply it. Existing companies' schedules never move by themselves. */
function dutiesFloor() {
  const c = load(); const agents = loops().agents || {};
  const ceo = (Object.entries(agents).find(([, x]) => co.holds(x, 'ceo')) || Object.entries(agents).find(([, x]) => x && x.manager == null) || [null])[0];
  const [lo, hi] = Array.isArray(c.bounds.loopFloorMin) ? c.bounds.loopFloorMin : DEFAULT_BOUNDS.loopFloorMin;
  const rows = [];
  for (const [id, a] of Object.entries(agents)) {
    if (!a || !a.loop) continue;
    if (id === ceo) { rows.push({ id, name: a.name || id, ceo: true, note: 'the CEO seat keeps its current loop' }); continue; }
    const seat = c.seats[id] || {};
    const floor = Math.min(hi, Math.max(lo, Number(seat.loopFloorMin) || lo));
    let cur = null, runsEveryMin = null, note;
    if (seat.loopEvery != null) { try { cur = parseEvery(seat.loopEvery); } catch (_) {} }
    if (cur && cur.kind === 'interval') runsEveryMin = cur.minutes;
    else if (cur && cur.kind === 'cron') { const f = cur.expr.split(' '); if (/^\d+$/.test(f[0]) && /^\d+$/.test(f[1])) runsEveryMin = 1440; }
    const text = 'every ' + (floor % 60 ? floor + 'm' : floor / 60 + 'h');
    const slower = runsEveryMin != null && runsEveryMin >= floor;
    note = slower ? 'already at or below the floor' : cur ? (runsEveryMin == null ? 'a cron clock (' + cur.expr + '): check how often it fires' : 'runs every ' + runsEveryMin + ' min, faster than the ' + floor + ' min floor') : 'no loopEvery in cadence.json: the station\'s own schedule stands';
    rows.push({ id, name: a.name || id, loopEvery: cur ? cur.text : null, runsEveryMin, floorMin: floor, suggest: slower ? null : text, note,
      owner: slower ? null : 'node company/tools/cadence.js set ' + id + ' --loop-every ' + floor + ' --by owner && node company/tools/cadence.js apply --by owner',
      reviewed: slower ? null : 'node company/tools/harness-change.js propose --kind schedule --target cadence.json --change \'' + JSON.stringify({ ['/seats/' + id + '/loopEvery']: text }) + '\' --why "duties find the work now (docs/DUTIES.md)" --by <you>' });
  }
  return { ok: true, suggestionOnly: true, bounds: [lo, hi], seats: rows, measure: 'compare the idle-wake ratio before and after: node company/tools/cadence.js sprint status --json (idleWakeRatio)' };
}

function timerPath() { return path.join(S.unitDir, S.service() + '-dispatch.timer'); }

async function apply({ dry, approvedRef, by } = {}) {
  const owner = isOwner(by);
  const level = owner ? 'owner' : S.gate();
  if (level === 'approve') {
    if (!approvedRef) {
      return { ok: false, refused: true, gate: 'approve',
        error: 'schedules are at governance level "approve": ask the owner first, as an approval (governance reserves it, so the owner-scope rule lets it through), e.g. `node company/tools/approvals.js ask --from <you> --category schedules --message "May we check in <how often, in everyday words>? It <what the owner gets>." --params \'{"cadence":"<what>"}\'`, then rerun with --approved-ref <questionId> once answered yes' };
    }
    const gov = S.governance();
    if (gov && typeof gov.answerOf === 'function' && typeof gov.verdict === 'function') {
      const a = gov.answerOf(approvedRef);
      if (!a || gov.verdict(a.text) !== true) return { ok: false, refused: true, gate: 'approve', error: 'approval ' + approvedRef + ' not accepted: ' + (a ? 'the answer was not yes' : 'no answer on record') };
    }
  }
  const c = load(); const now = S.now();
  const L = loops(); const agents = L.agents || {};
  const plan = { loops: [], routines: [], errors: [], warnings: [] };
  for (const [id, s] of Object.entries(c.seats)) {
    const row = agents[id];
    if (!row) { plan.errors.push('cadence.json seat "' + id + '" is not in loops.json; skipped'); continue; }
    for (const f of SEAT_FIELDS) if (s[f] !== undefined && row[f] !== s[f]) plan.loops.push({ seat: id, field: f, from: row[f], to: s[f] });
  }
  const wantSched = Object.entries(c.seats).filter(([id, s]) => s.loopEvery != null && agents[id]);
  if (wantSched.length) {
    let jobs = null;
    try { const r = await S.call('GET', '/api/cron'); jobs = (JSON.parse(r.body) || {}).jobs; } catch (e) { plan.errors.push('GET /api/cron failed: ' + e.message); }
    if (Array.isArray(jobs)) for (const [id, s] of wantSched) {
      const prefix = agents[id].loop;
      const hits = prefix ? jobs.filter(x => x && x.name && (x.name === prefix || x.name.startsWith(prefix))) : [];
      if (hits.length !== 1) { plan.errors.push(id + ': ' + (hits.length ? 'loop "' + prefix + '" matches ' + hits.length + ' routines' : 'no routine matches loop "' + prefix + '"')); continue; }
      let want; try { want = parseEvery(s.loopEvery); } catch (e) { plan.errors.push(id + ': ' + e.message); continue; }
      if (sameSchedule(want, hits[0].schedule)) continue;
      if (!s.peakOk) { const f = peakFindings(id, want, now); if (f.length) { plan.errors.push(id + ': loop clock ' + want.text + ' lands in a peak-price block (' + f[0].block + '); not applied. Only the owner can allow it: cadence.js set ' + id + ' --peak-ok on --by owner'); continue; } }
      plan.routines.push({ seat: id, id: hits[0].id, name: hits[0].name, from: (hits[0].schedule && hits[0].schedule.display) || null, to: want.text });
    }
  }
  if (fs.existsSync(timerPath())) plan.warnings.push('the old dispatch timer ' + timerPath() + ' is still installed: run scripts/setup-station.sh to replace it with the self-paced dispatcher loop (it reads the tick from cadence.json every iteration)');
  if (dry) return { ok: true, dry: true, gate: level, plan };
  const done = [];
  if (plan.loops.length) {
    const fresh = loops();   // re-read right before writing: another tool may have changed it
    for (const ch of plan.loops) if (fresh.agents && fresh.agents[ch.seat]) fresh.agents[ch.seat][ch.field] = ch.to;
    const tmp = S.loopsFile + '.tmp-' + process.pid;
    const loopsTxt = JSON.stringify(fresh, null, 2) + '\n';
    fs.writeFileSync(tmp, loopsTxt); fs.renameSync(tmp, S.loopsFile);
    try { require('./provenance.js').wrote(S.loopsFile, loopsTxt, 'cadence.js'); } catch (_) {}   // locked-watch.js: this tool's own write
    done.push('loops.json: ' + plan.loops.map(x => x.seat + '.' + x.field + '=' + x.to).join(', '));
  }
  for (const r of plan.routines) {
    try {
      const res = await S.call('POST', '/api/cron/update', { id: r.id, patch: { schedule: r.to } });
      const b = (() => { try { return JSON.parse(res.body); } catch (_) { return {}; } })();
      const v = require('./lib/station').cronResult(res, 'routine "' + r.name + '" update');   // a 200 can be a decline
      if (v.ok && b.ok) {
        done.push('routine "' + r.name + '": ' + (r.from || '?') + ' -> ' + r.to);
        // recorded for locked-watch.js: this schedule change is this tool's, not an unreviewed edit
        try { const to = r.to && typeof r.to === 'object' ? r.to : { expr: r.to }; require('./provenance.js').noted(S.file, { kind: 'schedule', jobId: r.id, expr: to.expr, tz: to.tz || null }, 'cadence.js'); } catch (_) {}
      }
      else plan.errors.push(v.ok ? 'routine "' + r.name + '" update refused: HTTP ' + res.status + ' ' + String(res.body).slice(0, 160) : v.reason);
    } catch (e) { plan.errors.push('routine "' + r.name + '" update failed: ' + e.message); }
  }
  if (done.length) {
    const cc = load(); cc.appliedAt = iso(S.now()); if (by) cc.appliedBy = by;
    const raw = co.readJson(S.file, null); if (raw) { raw.appliedAt = cc.appliedAt; if (by) raw.appliedBy = by; save(raw); } else save(cc);
    if (level === 'notify') { try { const n = cadenceNotice(by, done); S.notify(n.text, n.technical); } catch (e) { plan.errors.push('owner notice failed: ' + e.message); } }
  }
  return { ok: !plan.errors.length, gate: level, applied: done, errors: plan.errors, warnings: plan.warnings };
}

module.exports = { ASKS, endNotice, cadenceNotice, S, BUILTIN, DEFAULT_BOUNDS, DEFAULT_TEMPO, load, view, effective, dutiesFloor, tempoAllows, recordWake, sprintOf, setSprint, setSprintConfig, sprintTick, sprintStatus, sprintSpent, wakeCounts, inQuiet, peakFindings, proposal, parseEvery, sameSchedule, setDefault, setSeat, setBounds, endTemporary, apply, isOwner };

async function selftest() {
  const dir = require('./lib/temp-life').tmpDir('cadence-selftest-');
  const saved = Object.assign({}, S);
  const cases = [];
  const check = (name, cond, detail) => cases.push({ name, pass: !!cond, detail: detail || '' });
  const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) ? true : e.message; } };
  const calls = []; const told = []; const decided = [];
  const jobs = [{ id: 'j1', name: 'Founder loop', schedule: { kind: 'interval', minutes: 120, display: 'every 2h' } },
    { id: 'j2', name: 'Desk loop', schedule: { kind: 'cron', expr: '0 9 * * *', display: 'cron 0 9 * * *' } }];
  let level = 'auto'; let decision = { allowed: true, level: 'auto' };
  let now = Date.parse('2026-01-05T10:00:00Z');   // a Monday
  const mm = require('./lib/models-money');
  Object.assign(S, {
    file: path.join(dir, 'work', 'cadence.json'), defaultFile: path.join(dir, 'defaults.json'), loopsFile: path.join(dir, 'loops.json'),
    wakesFile: path.join(dir, 'state', 'tempo-wakes.json'), loopStateFile: path.join(dir, 'state', 'dispatcher-loop.json'),
    unitDir: dir, service: () => 'test-station', gate: () => level, governance: () => null, notify: t => told.push(t), now: () => now,
    onboardingFile: path.join(dir, 'state', 'onboarding-state.json'), budgetFile: path.join(dir, 'dispatch-budget.json'), runsFile: path.join(dir, 'runs.jsonl'),
    metricsFile: path.join(dir, 'state', 'sprint-metrics.json'), harnessLog: path.join(dir, 'harness-log.jsonl'),
    decide: (cat, o) => { decided.push([cat, o.ref]); return decision; }, underStation: () => false, ownerName: () => 'Pat',
    peakCfg: () => mm.normalisePeak('deepseek', { timezone: co.TZ, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], blocks: [['09:00', '12:00']], marginMin: 10 }),
    call: async (method, p, body) => {
      calls.push([method, p, body]);
      if (method === 'GET' && p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs }) };
      if (method === 'POST' && p === '/api/cron/update') { const x = jobs.find(y => y.id === body.id); x.schedule = parseEvery(body.patch.schedule); return { status: 200, body: JSON.stringify({ ok: true }) }; }
      return { status: 404, body: '{}' };
    },
  });
  fs.writeFileSync(S.defaultFile, JSON.stringify(Object.assign({}, BUILTIN, { bounds: DEFAULT_BOUNDS, tempo: DEFAULT_TEMPO })));
  fs.writeFileSync(S.loopsFile, JSON.stringify({ _doc: 'x', agents: { agent: { name: 'Alex', loop: 'Founder loop', priority: 100, wakeOnInbox: true, manager: null }, desk: { name: 'Sam', loop: 'Desk loop', cooldownMin: 30, manager: 'agent' } } }));
  try {
    check('parseEvery minutes', parseEvery('30').text === 'every 30m' && parseEvery('every 2h').minutes === 120);
    check('parseEvery cron', parseEvery('0 9 * * 1-5').kind === 'cron');
    let bad = false; try { parseEvery('weekdays at 9'); } catch (_) { bad = true; }
    check('parseEvery refuses a phrase it cannot compare', bad);
    let v = view();
    check('view merges loops.json and defaults', v.seats.desk.cooldownMin.value === 30 && v.seats.desk.cooldownMin.from === 'loops' && v.seats.agent.cooldownMin.from === 'default' && v.dispatcherTickMin === 10);
    check('view shows bounds, tempo and the effective tempo', v.bounds.tickMin.join('-') === '5-30' && v.tempo.mode === 'bounded-auto' && v.effective.tickMin === 10 && v.effective.source === 'base');

    // the owner sets the base, anything goes
    setDefault(3, { by: 'owner', maxPerTick: 3 });
    check('the owner sets base values, even outside bounds', load().dispatcherTickMin === 3 && load().maxPerTick === 3 && !load().temporary);
    setDefault(10, { by: 'Pat' });
    check('the owner by name counts as the owner', load().dispatcherTickMin === 10);
    S.underStation = () => true;
    check('"owner" from inside an agent\'s run is not the owner', throwsWith(() => setDefault(3, { by: 'owner', why: 'x' }), /outside the owner's bounds/) === true);
    S.underStation = () => false;

    // an agent, inside bounds: temporary, with a reason, gated, rate-limited, expiring
    check('an agent needs --why', throwsWith(() => setDefault(5, { by: 'Alex' }), /--why/) === true);
    check('an agent outside bounds is told to propose it (finance, risk, people)', throwsWith(() => setDefault(3, { by: 'Alex', why: 'busy' }), /harness-change\.js propose --kind schedule --target cadence\.json/) === true);
    check('an agent may not change wakes per tick', throwsWith(() => setDefault(null, { by: 'Alex', why: 'busy', maxPerTick: 8 }), /maxPerTick/) === true);
    const t1 = setDefault(5, { by: 'Alex', why: 'owner asked for a fast answer', cooldown: 15 });
    let eff = effective();
    check('an agent inside bounds gets a temporary change', t1.temporary && eff.tickMin === 5 && eff.cooldownMin === 15 && eff.source === 'temporary' && load().dispatcherTickMin === 10, JSON.stringify(eff));
    check('the temporary change follows the schedules gate', decided.length === 1 && decided[0][0] === 'schedules');
    check('the change is logged with who and why', /temporary until/.test(load().changes.slice(-1)[0].what) && load().changes.slice(-1)[0].why === 'owner asked for a fast answer');
    now += 5 * 60000;
    check('a second change inside the rate limit is refused', throwsWith(() => setDefault(6, { by: 'Alex', why: 'again' }), /less than 15 min ago/) === true);
    now += 26 * 60000;   // 31 min after the change: expired
    eff = effective();
    check('the temporary change expires back to the base', eff.tickMin === 10 && eff.cooldownMin === 40 && eff.source === 'base' && /expired/.test(eff.reason), JSON.stringify(eff));
    now += 5 * 60000;    // 5 min after the expiry
    check('hysteresis: no new speed-up within the interval after one ends', throwsWith(() => setDefault(5, { by: 'Alex', why: 'again' }), /less than 15 min ago/) === true);
    now += 11 * 60000;
    decision = { allowed: false, level: 'approve', questionId: 'q-9' };
    S.governance = () => ({ refusal: (cat, d) => 'self-governance: ' + cat + ' waits for the owner (' + d.questionId + ')' });
    check('at approve the change waits for the owner', throwsWith(() => setDefault(5, { by: 'Alex', why: 'again' }), /waits for the owner \(q-9\)/) === true && !activeTemporary(load(), now));
    decision = { allowed: true, level: 'auto' }; S.governance = () => null;
    setDefault(6, { by: 'Alex', why: 'one more' });
    const ended = endTemporary({ by: 'Alex', why: 'done' });
    check('a temporary change can be ended early', ended.ended && effective().tickMin === 10);
    now += 16 * 60000;
    setDefault(8, { by: 'Alex', why: 'x' });
    setDefault(12, { by: 'owner' });
    check('a new owner base ends the temporary change', effective().tickMin === 12 && effective().source === 'base');

    // bounds and tempo: owner only
    check('an agent may not change bounds', throwsWith(() => setBounds({ by: 'Alex', tickMin: '1-30' }), /owner's/) === true);
    setBounds({ by: 'owner', tickMin: '2-20', maxWakesPerHour: 2, quietHours: '22:00-07:00', mode: 'fixed' });
    let c = load();
    check('the owner sets bounds and tempo', c.bounds.tickMin.join('-') === '2-20' && c.bounds.maxWakesPerHour === 2 && c.bounds.quietHours === '22:00-07:00' && c.tempo.mode === 'fixed' && c.bounds.maxWakesPerDay === 120);
    now += 16 * 60000;
    check('tempo mode fixed: no crew changes at all', throwsWith(() => setDefault(5, { by: 'Alex', why: 'x' }), /mode is "fixed"/) === true);
    setBounds({ by: 'owner', mode: 'bounded-auto' });

    // seats
    check('a seat cooldown outside bounds is refused for an agent', throwsWith(() => setSeat('desk', { by: 'Alex', why: 'x', cooldown: 5 }), /bounds 10-120/) === true);
    check('a loop every 5 min is under the cooldown floor', throwsWith(() => setSeat('desk', { by: 'Alex', why: 'x', loopEvery: '5' }), /cooldown floor/) === true);
    check('a loop clock inside a peak block is refused', throwsWith(() => setSeat('desk', { by: 'owner', loopEvery: '30 10 * * *' }), /peak-price block/) === true);
    check('only the owner sets peakOk', throwsWith(() => setSeat('desk', { by: 'Alex', why: 'x', peakOk: 'on' }), /only the owner/) === true);
    check('a weekend-only clock is not in a weekday peak block', peakFindings('desk', '30 10 * * 0,6', now).length === 0);
    setSeat('desk', { by: 'Alex', why: 'review queue', loopEvery: '45', cooldown: 20, wakeOnOwner: 'off' });
    setSeat('agent', { by: 'owner', loopEvery: 'every 2h', priority: 90 });
    v = view();
    check('set writes cadence.json and wins in the view', v.seats.desk.cooldownMin.from === 'cadence' && v.seats.desk.cooldownMin.value === 20 && fs.existsSync(S.file));
    let threw = false; try { setSeat('nobody', { by: 'owner', cooldown: 5 }); } catch (_) { threw = true; }
    check('set refuses an unknown seat', threw);

    // proposals for harness-change.js
    const pr = proposal(load(), { '/bounds/tickMin': [3, 30], '/tempo/autoExpireMin': 45, '/seats/desk/cooldownMin': 25, '/maxPerTick': 6 }, { agents: loops().agents, now });
    check('a proposal becomes whole-section sets', pr['/bounds'].tickMin.join('-') === '3-30' && pr['/bounds'].maxWakesPerHour === 2 && pr['/tempo'].autoExpireMin === 45 && pr['/seats'].desk.cooldownMin === 25 && pr['/seats'].desk.loopEvery === 'every 45m' && pr['/maxPerTick'] === 6, JSON.stringify(pr));
    check('a proposal refuses a non-tempo pointer', throwsWith(() => proposal(load(), { '/changes': [] }), /not a tempo number/) === true);
    { const before = fs.readFileSync(S.file, 'utf8'); const df = dutiesFloor(); const desk = df.seats.find(x => x.id === 'desk'), ceoRow = df.seats.find(x => x.id === 'agent');
      check('duties-floor: a seat looping every 45 min is told the 6 h floor, the CEO keeps its loop, nothing is written', df.suggestionOnly && desk && desk.suggest === 'every 6h' && /cadence\.js set desk --loop-every 360 --by owner/.test(desk.owner) && /"\/seats\/desk\/loopEvery":"every 6h"/.test(desk.reviewed) && ceoRow && ceoRow.ceo && !ceoRow.suggest && fs.readFileSync(S.file, 'utf8') === before, JSON.stringify(df)); }
    check('a proposal can set the loop floor bounds and a seat floor', JSON.stringify(proposal(load(), { '/bounds/loopFloorMin': '480-720', '/seats/desk/loopFloorMin': 600 }, { now })['/bounds'].loopFloorMin) === '[480,720]');
    check('a proposal refuses a peak clock', throwsWith(() => proposal(load(), { '/seats/desk/loopEvery': '0 10 * * 1' }, { now }), /peak-price/) === true);

    // wake caps and quiet hours
    now = Date.parse('2026-01-05T12:00:00Z');
    const quietNow = (() => { for (let h = 0; h < 24; h++) { const t = now + h * 3600e3; if (inQuiet('22:00-07:00', t)) return t; } return null; })();
    check('quiet hours hold a wake, not an owner wake', !tempoAllows('desk', quietNow).ok && /quiet hours/.test(tempoAllows('desk', quietNow).reason) && tempoAllows('agent', quietNow, { ownerWake: true }).ok);
    const day = (() => { for (let h = 0; h < 24; h++) { const t = now + h * 3600e3; if (!inQuiet('22:00-07:00', t) && !inQuiet('22:00-07:00', t + 3 * 3600e3)) return t; } return now; })();
    const a1 = tempoAllows('desk', day, { record: true }), a2 = tempoAllows('agent', day + 1000, { record: true }), a3 = tempoAllows('desk', day + 2000, { record: true });
    check('wakes per hour are capped', a1.ok && a2.ok && !a3.ok && /cap 2/.test(a3.reason), JSON.stringify([a1, a2, a3]));
    check('an owner wake is never held but is counted', tempoAllows('agent', day + 3000, { record: true, ownerWake: true }).ok && wakeCounts(day + 4000).hour === 3);
    check('an hour later the hour cap has room again', tempoAllows('desk', day + 3601e3, { record: true }).ok);
    setBounds({ by: 'owner', maxWakesPerHour: 100, maxWakesPerDay: 4 });
    check('wakes per day are capped', !tempoAllows('desk', day + 2 * 3600e3).ok && /24 h, cap 4/.test(tempoAllows('desk', day + 2 * 3600e3).reason));
    check('the view shows wake counts against the caps', view().wakes.maxPerDay === 4 && view().wakes.day >= 0);

    // apply
    now = Date.parse('2026-01-05T10:00:00Z');
    const dry = await apply({ dry: true, by: 'Alex' });
    check('dry-run plans without writing', dry.plan.loops.length === 3 && dry.plan.routines.length === 1 && JSON.parse(fs.readFileSync(S.loopsFile, 'utf8')).agents.desk.cooldownMin === 30, JSON.stringify(dry.plan));
    level = 'approve';
    const refused = await apply({ by: 'Alex' });
    check('approve level refuses an agent without --approved-ref and says how to ask', refused.refused && /approvals\.js ask --from <you> --category schedules/.test(refused.error));
    const ownerApply = await apply({ dry: true, by: 'owner' });
    check('the owner applies without the gate', ownerApply.ok && ownerApply.gate === 'owner');
    level = 'notify';
    fs.writeFileSync(path.join(dir, 'test-station-dispatch.timer'), '[Timer]\nOnUnitActiveSec=10min\n');
    const r = await apply({ by: 'Alex' });
    const L = JSON.parse(fs.readFileSync(S.loopsFile, 'utf8'));
    check('apply writes per-seat fields into loops.json', L.agents.desk.cooldownMin === 20 && L.agents.desk.wakeOnOwnerMessage === false && L.agents.agent.priority === 90 && L._doc === 'x', JSON.stringify(r));
    const ups = calls.filter(x => x[1] === '/api/cron/update');
    check('apply updates only the routine whose schedule changed', ups.length === 1 && ups[0][2].id === 'j2' && ups[0][2].patch.schedule === 'every 45m');
    check('apply never touches a timer; it says to migrate an old one', /setup-station\.sh/.test((r.warnings || []).join(' ')) && /OnUnitActiveSec=10min/.test(fs.readFileSync(path.join(dir, 'test-station-dispatch.timer'), 'utf8')));
    check('notify level tells the owner, in plain words (the routine and clock only in technical)', told.length === 1 && /changed how often/.test(told[0]) && !/\*\/|->/.test(told[0]));
    const again = await apply({ by: 'Alex' });
    check('a second apply changes nothing', again.applied.length === 0 && calls.filter(x => x[1] === '/api/cron/update').length === 1, JSON.stringify(again));
    const raw = JSON.parse(fs.readFileSync(S.file, 'utf8'));
    check('apply keeps the file as written (no builtin values folded in)', raw.bounds && raw.tempo && raw.appliedBy === 'Alex');

    // ---- Sprint (start-up) ----
    fs.writeFileSync(S.budgetFile, JSON.stringify({ dailyUsd: 3, unmeteredProviders: ['claude-cli'] }));
    now = Date.parse('2026-01-05T12:00:00Z');
    check('Sprint is off unless switched on', !view().sprint.on && effective().source !== 'sprint' && view().sprint.budgetUsd === 6);
    check('an agent cannot switch Sprint on; it is told how to propose it', throwsWith(() => setSprint(true, { by: 'Alex', why: 'go fast' }), /owner's switch.*harness-change\.js propose --kind schedule --target cadence\.json --change '\{"\/tempo\/sprint\/on":true/) === true);
    S.underStation = () => true;
    check('"owner" from inside an agent\'s run cannot switch Sprint on', throwsWith(() => setSprint(true, { by: 'owner' }), /owner's switch/) === true && !load().tempo.sprint);
    S.underStation = () => false;
    check('an agent cannot switch Sprint off or change its settings either', throwsWith(() => setSprint(false, { by: 'Alex' }), /owner's switch/) === true && throwsWith(() => setSprintConfig({ by: 'Alex', lanes: 4 }), /owner's switch/) === true);
    const on = setSprint(true, { by: 'owner', hours: 2 });
    let e2 = effective();
    check('the owner switches Sprint on for 2 h: stored as tempo.sprint {on, since, until, by}', on.ok && load().tempo.sprint.on === true && load().tempo.sprint.since === iso(now) && load().tempo.sprint.until === iso(now + 2 * 3600e3) && load().tempo.sprint.by === 'owner', JSON.stringify(load().tempo.sprint));
    check('Sprint: fallback tick, every seat per tick, cooldown floor 2 min, base cooldown kept for unchanged work', e2.source === 'sprint' && e2.tickMin === 5 && e2.maxPerTick >= 2 && e2.sprint.cooldownFloorMin === 2 && e2.cooldownMin === load().defaultCooldownMin && /budget, halts, guardrails and the pacer still hold/.test(e2.reason), JSON.stringify(e2));
    { let tw = null; for (let k = 1; k < 115 && tw == null; k++) if (!inQuiet('22:00-07:00', now + k * 60000)) tw = now + k * 60000;
      const sb = JSON.parse(fs.readFileSync(S.file, 'utf8')); const keep = sb.tempo.sprint; delete sb.tempo.sprint; fs.writeFileSync(S.file, JSON.stringify(sb));
      const before = tw != null && !tempoAllows('desk', tw).ok && /cap 4/.test(tempoAllows('desk', tw).reason);
      sb.tempo.sprint = keep; fs.writeFileSync(S.file, JSON.stringify(sb));
      check('Sprint lifts the hourly and daily wake caps (the day cap of 4 holds without it)', tw == null || (before && tempoAllows('desk', tw).ok && tempoAllows('desk', tw).sprint === true), String(tw) + ' ' + JSON.stringify(tempoAllows('desk', tw))); }
    check('Sprint keeps quiet hours', !tempoAllows('desk', quietNow).ok);
    check('a running Sprint is untouched by sprintTick', sprintTick({ notify: t => told.push(t) }).active === true);
    const told0 = told.length; const lines = [];
    now += 2 * 3600e3 + 1000;
    check('at its end time Sprint stops counting (effective is the base again)', effective().source !== 'sprint');
    const t1s = sprintTick({ log: l => lines.push(l), notify: t => told.push(t) });
    check('the end is written and the owner told in plain words, once', t1s.ended && t1s.reason === 'time' && load().tempo.sprint.on === false && load().tempo.sprint.endedBy === 'itself' && told.length === told0 + 1 && /^Sprint ended by itself because its time was up, so the crew is back to its normal pace\./.test(told[told.length - 1]) && lines.some(l => /back on its normal tempo: the dispatcher checks every \d+ min/.test(l)) && lines.some(l => /^SPRINT ENDED: /.test(l)), JSON.stringify([t1s, told.slice(-1), lines]));
    check('a second sprintTick says nothing more', !sprintTick({ notify: t => told.push(t) }).ended && told.length === told0 + 1);
    // the budget: metered spend since the start ends it; Claude (subscription) spend does not count
    setSprint(true, { by: 'Pat', budgetUsd: 1 });
    fs.writeFileSync(S.runsFile, [{ runId: 'a', agentId: 'desk', provider: 'claude-cli', usd: 5, startedAt: now + 1000, endedAt: now + 2000 }, { runId: 'b', agentId: 'desk', provider: 'deepseek', usd: 0.4, startedAt: now + 1000, endedAt: now + 3000 }].map(r => JSON.stringify(r)).join('\n') + '\n');
    now += 5000;
    check('Sprint spend counts metered runs only ($0.40 of $1)', sprintTick({ notify: t => told.push(t) }).active === true && sprintSpent(now - 10000).usd === 0.4);
    fs.appendFileSync(S.runsFile, JSON.stringify({ runId: 'c', agentId: 'agent', provider: 'deepseek', usd: 0.7, startedAt: now, endedAt: now + 1 }) + '\n');
    now += 1000;
    const tb = sprintTick({ notify: t => told.push(t) });
    check('a spent Sprint budget ends Sprint and says so', tb.ended && tb.reason === 'budget' && /because it spent its start-up budget/.test(told[told.length - 1]) && load().tempo.sprint.endedWhy === 'budget', JSON.stringify([tb, told.slice(-1)]));
    // the founding default: on, until certified + 24 h
    const rd = JSON.parse(fs.readFileSync(S.file, 'utf8')); rd.tempo.sprint = { on: true, since: null, until: null, by: 'founding', afterCertifiedH: 24 }; fs.writeFileSync(S.file, JSON.stringify(rd));
    sprintTick({ notify: t => told.push(t) });
    let sv = view().sprint;
    check('founding default: started by the first tick, waiting for certification', sv.active && sv.since === iso(now) && sv.waitingForCertify && !sv.until && /certified/.test(sv.untilWhy), JSON.stringify(sv));
    fs.mkdirSync(path.dirname(S.onboardingFile), { recursive: true });
    fs.writeFileSync(S.onboardingFile, JSON.stringify({ steps: { founded: { at: iso(now - 30 * 3600e3) } }, certified: true, certifiedAt: iso(now - 10 * 3600e3) }));
    sv = view().sprint;
    check('once certified it runs until certified + 24 h', sv.active && sv.until === iso(now + 14 * 3600e3), JSON.stringify(sv));
    now += 14 * 3600e3 + 1000;
    const tc = sprintTick({ notify: t => told.push(t) });
    check('certified + 24 h ends it, in plain words', tc.ended && tc.reason === 'certified' && /because the company finished its start-up checks/.test(told[told.length - 1]));
    // the proposal path: an agent proposes ON through the schedules review; it starts when the loop first sees it
    check('a proposal may not switch Sprint off', throwsWith(() => proposal(load(), { '/tempo/sprint/on': false }), /only be proposed as true/) === true);
    const prp = proposal(JSON.parse(fs.readFileSync(S.file, 'utf8')), { '/tempo/sprint/on': true, '/tempo/sprint/hours': 24 });
    check('a proposal becomes a whole /tempo section with Sprint on and no start yet', prp['/tempo'].sprint.on === true && prp['/tempo'].sprint.hours === 24 && prp['/tempo'].sprint.since === null && prp['/tempo'].mode === 'bounded-auto', JSON.stringify(prp));
    const rd2 = JSON.parse(fs.readFileSync(S.file, 'utf8')); rd2.tempo = prp['/tempo']; fs.writeFileSync(S.file, JSON.stringify(rd2));   // what harness-change.js apply writes
    sprintTick({ notify: t => told.push(t) });
    check('an applied proposal starts at the next loop iteration, for its hours', view().sprint.active && load().tempo.sprint.since === iso(now) && load().tempo.sprint.until === iso(now + 24 * 3600e3) && load().tempo.sprint.by === 'a reviewed proposal');
    setSprint(false, { by: 'owner' });
    check('the owner switches Sprint off', !view().sprint.on && load().tempo.sprint.endedBy === 'owner' && effective().source !== 'sprint');
    // status: idle-wake ratio, items, spend per item, proposals/h vs reviews/h, time to certified
    setSprint(true, { by: 'owner', budgetUsd: 50 });
    fs.writeFileSync(S.metricsFile, JSON.stringify({ since: load().tempo.sprint.since, wakes: 10, resolved: 8, idleWakes: 2, itemsDone: 4 }));
    fs.appendFileSync(S.runsFile, JSON.stringify({ runId: 'd', agentId: 'desk', provider: 'deepseek', usd: 0.8, startedAt: now + 10, endedAt: now + 20 }) + '\n');
    fs.writeFileSync(S.harnessLog, [{ at: iso(now + 100), event: 'proposed' }, { at: iso(now + 200), event: 'proposed' }, { at: iso(now + 300), event: 'approved' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    now += 2 * 3600e3;
    const ss = sprintStatus();
    check('sprint status: idle-wake ratio, items done, $ per item, spend vs budget', ss.wakes === 10 && ss.idleWakeRatio === 0.25 && ss.itemsDone === 4 && ss.spentUsd === 0.8 && ss.usdPerItem === 0.2 && ss.budgetUsd === 50, JSON.stringify(ss));
    check('sprint status: proposals/h vs reviews/h and time to certified', ss.proposals === 2 && ss.reviews === 1 && ss.proposalsPerHour === 1 && ss.reviewsPerHour === 0.5 && ss.timeToCertifiedH === 20, JSON.stringify(ss));
  } finally {
    Object.assign(S, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const badc = cases.filter(x => !x.pass);
  for (const x of cases) console.log((x.pass ? 'ok   ' : 'FAIL ') + x.name + (x.pass ? '' : '  [' + x.detail + ']'));
  console.log(badc.length ? 'CADENCE SELFTEST FAILED: ' + badc.length + ' of ' + cases.length : 'CADENCE SELFTEST PASSED: ' + cases.length + ' cases');
  return badc.length ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0] || 'show';
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  const sopt = k => (typeof opt(k) === 'string' ? opt(k) : null);
  const out = o => console.log(JSON.stringify(o, null, 1));
  (async () => {
    if (cmd === 'selftest' || cmd === '--selftest') { try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}   // a selftest measures the mechanism in its own fixture tree, not the caller: an agent's run must not fail it
      process.exit(await selftest()); }
    if (cmd === 'show') {
      const v = view();
      if (opt('json')) return out(Object.assign({ ok: true }, v));
      const e = v.effective;
      console.log('base: tick ' + v.dispatcherTickMin + ' min · cooldown ' + v.defaultCooldownMin + ' min · max ' + v.maxPerTick + ' wakes/tick  (' + v.file + ')');
      console.log('now:  tick ' + e.tickMin + ' min · cooldown ' + e.cooldownMin + ' min — ' + e.reason + (e.quiet ? ' · QUIET HOURS' : ''));
      console.log('bounds: tick ' + v.bounds.tickMin.join('-') + ' min · cooldown ' + v.bounds.cooldownMin.join('-') + ' min · wakes ' + v.wakes.hour + '/' + v.bounds.maxWakesPerHour + ' this hour, ' + v.wakes.day + '/' + v.bounds.maxWakesPerDay + ' in 24 h · quiet ' + (v.bounds.quietHours || 'off') + ' · mode ' + v.tempo.mode + ' (speed-ups last ' + v.tempo.autoExpireMin + ' min, ' + v.tempo.minChangeIntervalMin + ' min apart)');
      { const sp = v.sprint; console.log('sprint: ' + (sp.active ? 'ON (start-up) by ' + (sp.by || '?') + (sp.until ? ' until ' + sp.until : ' — ' + (sp.untilWhy || 'until turned off')) + ' · floor ' + sp.config.cooldownFloorMin + ' min · lanes ' + sp.config.lanes + ' · budget $' + sp.budgetUsd : 'off' + (sp.endedAt ? ' (ended ' + sp.endedAt + ', ' + (sp.endedWhy || '?') + ')' : '') + ' — node company/tools/cadence.js sprint on --by owner')); }
      if (v.loop) console.log('loop: last tick ' + (v.loop.lastTickAt || '-') + ', next ' + (v.loop.nextTickAt || '-') + ' (' + (v.loop.status || '?') + ')');
      for (const [id, s] of Object.entries(v.seats)) {
        const f = k => s[k] ? s[k].value + (s[k].from === 'cadence' ? '' : ' [' + s[k].from + ']') : '-';
        console.log('  ' + id + ' (' + s.name + '): loop "' + (s.loop || '-') + '"' + (s.loopEvery ? ' every=' + s.loopEvery : '') + ' cooldown=' + f('cooldownMin') + ' priority=' + f('priority') + ' wakeOnInbox=' + f('wakeOnInbox') + ' wakeOnOwner=' + f('wakeOnOwnerMessage'));
      }
      if (v.unknownSeats.length) console.log('  not in loops.json: ' + v.unknownSeats.join(', '));
      return;
    }
    const by = sopt('by'); const why = sopt('why');
    const run = fn => { try { return out(fn()); } catch (e) { console.error(JSON.stringify({ ok: false, refused: !!e.refused, code: e.code, error: e.message })); process.exit(e.refused ? 3 : 1); } };
    if (cmd === 'set-default') return run(() => setDefault(a[1] && !a[1].startsWith('--') ? a[1] : null, { by, why, cooldown: sopt('cooldown'), maxPerTick: sopt('max-per-tick') }));
    if (cmd === 'set') return run(() => setSeat(a[1], { by, why, loopEvery: sopt('loop-every'), cooldown: sopt('cooldown'), priority: sopt('priority'), wakeOnInbox: sopt('wake-on-inbox'), wakeOnOwner: sopt('wake-on-owner'), peakOk: sopt('peak-ok') }));
    if (cmd === 'bounds') return run(() => setBounds({ by, why, tickMin: sopt('tick-min'), cooldownMin: sopt('cooldown-min'), maxWakesPerHour: sopt('max-wakes-per-hour'), maxWakesPerDay: sopt('max-wakes-per-day'), quietHours: sopt('quiet-hours'), mode: sopt('mode'), autoExpireMin: sopt('auto-expire-min'), minChangeIntervalMin: sopt('min-change-interval-min') }));
    if (cmd === 'end-temporary') return run(() => endTemporary({ by, why }));
    if (cmd === 'sprint') {
      const sub = a[1];
      const cfg = { budgetUsd: sopt('budget-usd'), lanes: sopt('lanes'), maxLanesTotal: sopt('max-lanes-total'), laneTimeoutMin: sopt('lane-timeout-min'), cooldownFloorMin: sopt('cooldown-floor-min'), fallbackTickMin: sopt('fallback-tick-min'), watchDebounceSec: sopt('watch-debounce-sec'), spread: sopt('spread') };
      if (sub === 'on' || sub === 'off') return run(() => setSprint(sub === 'on', Object.assign({ by, why, hours: sopt('hours') }, cfg)));
      if (sub === 'config') return run(() => setSprintConfig(Object.assign({ by, why }, cfg)));
      if (sub === 'status' || !sub) {
        const st = sprintStatus();
        if (opt('json')) return out(st);
        const f = (n, d) => n == null ? '-' : Number(n).toFixed(d == null ? 2 : d);
        console.log('Sprint (start-up): ' + (st.active ? 'ON' : st.on ? 'ON, ending now' : 'off') + (st.since ? ' since ' + st.since : '') + (st.active ? (st.until ? ' until ' + st.until : ' — ' + (st.untilWhy || 'until turned off')) : st.endedAt ? ', ended ' + st.endedAt + ' (' + (st.endedWhy || '?') + ')' : '') + (st.by ? ' · by ' + st.by : ''));
        console.log('  wakes ' + st.wakes + ' · did nothing ' + st.idleWakes + (st.idleWakeRatio != null ? ' (idle-wake ratio ' + f(st.idleWakeRatio) + ')' : '') + ' · items done ' + st.itemsDone + ' · $/item ' + f(st.usdPerItem, 4));
        console.log('  spend $' + f(st.spentUsd) + ' of $' + f(st.budgetUsd) + (st.budgetIsDefault ? ' (2 x the daily cap)' : '') + ' metered · ' + st.runs + ' runs · ' + st.hours + ' h');
        console.log('  proposals ' + st.proposals + ' (' + f(st.proposalsPerHour, 1) + '/h) vs reviews ' + st.reviews + ' (' + f(st.reviewsPerHour, 1) + '/h)');
        console.log('  certified: ' + (st.certified ? 'yes, ' + st.timeToCertifiedH + ' h after founding' : 'not yet' + (st.sinceFoundedH != null ? ' (' + st.sinceFoundedH + ' h since founding)' : '')));
        return;
      }
      throw new Error('sprint on|off [--hours N] --by owner, sprint config …, sprint status [--json]');
    }
    if (cmd === 'duties-floor') {
      const r = dutiesFloor();
      if (opt('json')) return out(r);
      console.log('duties floor (a suggestion; nothing is changed): a seat loop need run no more often than every ' + r.bounds.join('-') + ' min; the CEO keeps its loop');
      for (const x of r.seats) { console.log('  ' + x.id + ' (' + x.name + '): ' + x.note + (x.suggest ? ' -> suggest loopEvery ' + x.suggest : '')); if (x.owner) console.log('      owner:    ' + x.owner + '\n      reviewed: ' + x.reviewed); }
      console.log(r.measure);
      return;
    }
    if (cmd === 'apply') {
      const r = await apply({ dry: !!opt('dry-run'), approvedRef: sopt('approved-ref'), by });
      out(r);
      process.exit(r.ok ? 0 : 1);
    }
    throw new Error('commands: show, set-default, set, bounds, end-temporary, apply, sprint, duties-floor, selftest');
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
