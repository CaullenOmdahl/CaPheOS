/* lib/sprint.js — the pure parts of Sprint (start-up tempo): docs/TEMPO.md "Sprint".
 *
 * Sprint is the owner's switch (cadence.js sprint on|off) that makes the company work as fast as its open work allows:
 * a seat with NEW open work wakes as soon as it is idle (cooldown floor), the hourly/daily wake caps are lifted, and the
 * dispatcher loop wakes early on a change in the inboxes. Nothing here reads the clock or the station; callers pass
 * what they know, so every rule is testable on its own (company/tools/tests/sprint.test.js).
 *
 *   parseItems(text)            the handoff sections of one inbox file: {heading, status, open, touches, effort}
 *   workSig(parts)              a short hash of what a seat has to do now (its open items, unread owner messages, …)
 *   restMs(o)                   how long a seat rests before the dispatcher may wake it again
 *   spreadHold(o)               Sprint spreads the daily metered cap over the day: hold a wake that would spend it early
 *                               (never a seat other seats are waiting on: o.blocking)
 *   waitingOn(status, names, self)  the seat an OPEN item's Status says it waits on ("waiting on Iris's review"), or null
 *   blockersOf(o)               seat -> the seats waiting on it (items that name it, STALLED seats that need the CEO, and
 *                               items whose **Waiting on:** names that seat's open item: it.waitSeats)
 *   parseDeps(value)            the dependencies a **Waiting on:** line names (handoff, quest step, file, service, job, seat)
 *   resolveDeps(deps, look)     'waiting' | 'met' | 'unresolvable' (fail open: never silently parked) for those dependencies
 *   notBeforeGate(o)            whether a **Not before:** line may set an item aside (reason, caps, Sprint), and why not
 *   depShaped(text)             a Not before reason that reads like a dependency ("after", "needs", "once X lands")
 *   effortOf(items)             'mechanical' | 'reasoning' | 'default' for a seat's open items (the Effort: field)
 *   lanePlan(items, o)          which open items could run in parallel lanes (Touches: disjoint), CEO always serial
 *   overlaps(a, b)              two Touches lists share a path or area
 *   makePathLock(file)          a per-path lock store for lanes: a conflict waits
 *   sprintSpend(rows, sinceMs, unmetered)   metered USD of the run rows since Sprint began
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// cadence.json tempo.sprint keys that are configuration, not state (the owner may set them; defaults below)
const SPRINT_DEFAULTS = {
  cooldownFloorMin: 2,      // a seat with NEW open work rests at least this long between two dispatcher wakes
  fallbackTickMin: 5,       // the dispatcher's timer while Sprint is on; inbox changes wake it sooner (watch)
  watchDebounceSec: 45,     // an inbox change wakes the dispatcher this long after the last change (more items per wake)
  minTickGapSec: 30,        // never two ticks closer than this, whatever changes
  lanes: 2,                 // runs per worker seat at once, its main loop included (company/tools/lanes.js; needs patch 0012)
  maxLanesTotal: 6,         // extra lane runs in the whole company at once
  laneTimeoutMin: 95,       // a lane still running after this long is stopped and its path lock released
  budgetUsd: null,          // total metered USD for the whole Sprint; null = 2 x the daily cap
  spreadDailyCap: true,     // spread the daily metered cap over the company day (cadence.js sprint config --spread on|off|today)
  spreadOffUntil: null,     // ISO time: the spread is off until then (--spread today = until local midnight), then on again
  unchangedRestMin: 15,     // a seat whose work did NOT change since its last wake rests at least this long (or its cooldown, if longer)
};
const CONFIG_KEYS = Object.keys(SPRINT_DEFAULTS);

/* ---------- handoff items ---------- */
const field = (sec, name) => { const m = String(sec).match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };
// "Touches: src/api/, docs/API.md" -> ['src/api', 'docs/API.md']; absent or empty -> null (treated as conflicting)
function parseTouches(v) {
  if (v == null) return null;
  const list = String(v).replace(/`/g, '').split(/[,;]/).map(s => s.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  if (!list.length || list.some(s => s === '*' || s === '.' || /^(all|everything|any)$/i.test(s))) return null;
  return list;
}
function parseEffort(v) { const s = String(v || '').trim().toLowerCase(); return /^mechanical\b/.test(s) ? 'mechanical' : /^reasoning\b/.test(s) ? 'reasoning' : null; }
function parseItems(text) {
  const out = [];
  for (const sec of String(text || '').split(/^## /m).slice(1)) {
    const heading = sec.split('\n')[0].trim();
    const status = field(sec, 'Status');   // the FIRST status line governs (dispatch.js firstStatusOf)
    out.push({ heading, status, open: !!status && /^OPEN\b/i.test(status), touches: parseTouches(field(sec, 'Touches')), effort: parseEffort(field(sec, 'Effort')),
      waitingOnLine: field(sec, 'Waiting on'), notBeforeLine: field(sec, 'Not before'), id: (field(sec, 'Id') || '').replace(/`/g, '').trim() || null });
  }
  return out;
}

/* ---------- wakes ---------- */
function workSig(parts) { return crypto.createHash('sha1').update(JSON.stringify(parts || [])).digest('hex').slice(0, 16); }
/* restMs({ baseMs, sprint, changed, floorMin, unchangedMin, hiring }) -> { ms, fast }
 * Outside Sprint: the seat's own cooldown (or the owner-message cooldown). In Sprint, a seat whose work CHANGED since its
 * last wake (a new handoff, a new owner message, a review to do) rests only the floor; unchanged work rests its cooldown,
 * but never less than unchangedMin (default 15): a seat whose last run left its work as it was is not woken again every
 * minute for the same items, however short the owner set the base cooldown. */
function restMs(o) {
  if (o.hiring) return { ms: 0, fast: false };
  const base = Number(o.baseMs) || 0;
  if (o.sprint && o.changed) return { ms: Math.min(base, Math.max(0, Number(o.floorMin == null ? SPRINT_DEFAULTS.cooldownFloorMin : o.floorMin)) * 60000), fast: true };
  if (o.sprint) return { ms: Math.max(base, Math.max(0, Number(o.unchangedMin == null ? SPRINT_DEFAULTS.unchangedRestMin : o.unchangedMin)) * 60000), fast: false };
  return { ms: base, fast: false };
}
/* spreadHold({ cap, spent24h, spentLastHour, hoursLeft, blocking }) -> null | reason
 * In Sprint the daily metered cap is spread: the last hour may spend at most twice the even share of what is left of
 * the cap over the hours left in the company day (and never less than an eighth of the cap, so work always moves).
 * A seat other seats are waiting on (blocking: their names) is never held by the spread: holding it would idle all of
 * them to save the money one run costs. The daily cap itself still holds it. */
function spreadHold(o) {
  const cap = Number(o.cap) || 0; if (!(cap > 0)) return null;
  if (Array.isArray(o.blocking) && o.blocking.length) return null;
  const remaining = Math.max(0, cap - (Number(o.spent24h) || 0));
  const allowance = Math.max(cap / 8, 2 * remaining / Math.max(1, Number(o.hoursLeft) || 1));
  const last = Number(o.spentLastHour) || 0;
  return last >= allowance ? 'Sprint spreads the daily cap: $' + last.toFixed(2) + ' metered in the last hour, allowance $' + allowance.toFixed(2) + ' ($' + remaining.toFixed(2) + ' left over ' + Math.max(1, Math.round(Number(o.hoursLeft) || 1)) + ' h)' : null;
}

/* ---------- who waits on whom ---------- */
/* waitingOn(status, names, self, ceo) -> the seat id an OPEN item waits on, 'owner', or null (the item is the holder's own work)
 * status: the item's first Status line ("OPEN — fix written, waiting on Iris Hale's review"); names: {seatId: name};
 * self: the holder's id (waiting on yourself is not waiting); ceo: the CEO's id ("waiting for the CEO"). "waiting on/for", "blocked on/by", "held for", "needs <name>"
 * and "with <name> for review" all count; a phrase that names nobody we know waits on 'someone' (still not the holder's). */
function waitingOn(status, names, self, ceo) {
  const s = String(status || '').replace(/^OPEN\b\s*[—–:-]*\s*/i, '');
  const m = s.match(/\b(?:waiting|waits)\s+(?:on|for)\s+(.+)|\bblocked\s+(?:on|by)\s+(.+)|\bheld\s+(?:for|by)\s+(.+)|\bneeds\s+(.+?)(?:'s|’s)?\s+(?:review|sign-?off|approval|ruling|answer|decision|reply)\b|\bwith\s+(.+?)\s+for\s+(?:review|sign-?off|approval)\b/i);
  if (!m) return null;
  const who = (m[1] || m[2] || m[3] || m[4] || m[5] || '').toLowerCase();
  if (/^(?:the\s+)?(?:owner|commander)\b/.test(who)) return 'owner';
  let best = null, at = Infinity;
  for (const [id, n] of Object.entries(names || {})) {
    const full = String(n || '').toLowerCase(); if (!full) continue;
    const first = full.split(/\s+/)[0];
    for (const k of [full, first]) { const i = k.length > 1 ? who.search(new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')) : -1; if (i >= 0 && i < at) { at = i; best = id; } }
  }
  if (!best && ceo && /\b(?:ceo|founder)\b/.test(who)) best = ceo;
  if (best === self) return null;
  return best || 'someone';
}
/* blockersOf({ items: {seatId: [{heading, status, open}]}, names, ceo, stalled: [seatId] }) -> { seatId: [waiting seat ids] }
 * A seat blocks another when one of the other's OPEN items says it waits on it, or when the other is STALLED (the same
 * items after the stall limit), which needs the CEO. */
function blockersOf(o) {
  const out = {}; const add = (b, w) => { if (!b || b === w || b === 'someone' || b === 'owner') return; (out[b] = out[b] || []); if (!out[b].includes(w)) out[b].push(w); };
  for (const [seat, items] of Object.entries(o.items || {})) for (const it of items || []) {
    if (!it || !it.open) continue;
    if (Array.isArray(it.waitSeats)) { for (const b of it.waitSeats) add(b, seat); continue; }   // its **Waiting on:** governs (dispatch.js)
    add(waitingOn(it.status, o.names, seat, o.ceo), seat);
  }
  for (const seat of o.stalled || []) add(o.ceo, seat);
  return out;
}
/* ---------- Waiting on: event-driven dependencies (company/HANDOFFS.md) ----------
 * `**Waiting on:** <dep>[; <dep>…] (plain words)` names what an OPEN item waits for. Each dependency is one of:
 *   to-nora-field.md#gold backfill   (or `handoff: to-x.md — <heading words or **Id:**>`)  that handoff is closed
 *   q:13 step rank                      (or `q:13`)                                            that quest step is ticked (the quest closed)
 *   file: company/work/strategies/RANKING.md [changed]                                         the file exists (or changed since)
 *   service: bank-day                   a registered background service's next successful run (company/tools/service.js)
 *   job: gold-backfill                  a job started with company/tools/notify-when.js --id gold-backfill has ended
 *   seat: Nora — gold backfill         that seat's open item (the words of its heading or its **Id:**) is closed
 * A trailing "(…)" is the plain words the console shows ("waiting for: gold history download to finish"). The dispatcher
 * resolves every dependency on every tick and wakes the holder the tick they are all met; a reference it cannot resolve
 * (no such inbox, item, quest, step, service or job) is a lint warning, and the item is work now (fail open). */
const DEP_SPLIT = /\s*;\s*|\s+\+\s+|,\s*(?=(?:handoff|quest|file|service|job|seat)\s*:|q:\d|to-[\w.-]+\.md)/i;
function depWords(d) {
  switch (d.kind) {
    case 'handoff': return '"' + d.ref + '" in ' + d.inbox + ' to close';
    case 'seat': return d.name + (d.ref ? ': "' + d.ref + '"' : '') + ' to close';
    case 'quest': return d.qid + (d.step ? ' step ' + d.step : '') + ' to be done';
    case 'file': return d.path + (d.changed ? ' to change' : ' to appear');
    case 'service': return 'the ' + d.name + ' run to finish';
    case 'job': return 'job ' + d.id + ' to finish';
    default: return '"' + d.raw + '" (not a dependency the dispatcher can read)';
  }
}
const NO_WAIT = /^(?:nothing|none|no(?:thing)?\s+(?:further|else|external|more)|n\/a|-|—)(?:\b|\s|$)/i;
function parseDeps(value) {
  let s = String(value == null ? '' : value).replace(/`/g, '').trim();
  if (!s || NO_WAIT.test(s)) return { deps: [], label: null, words: '', none: true };   // "Waiting on: nothing — …": not waiting
  let label = null;
  const lm = s.match(/\(([^()]{2,200})\)\s*$/); if (lm) { label = lm[1].trim(); s = s.slice(0, lm.index).trim(); }
  const deps = [];
  for (const raw of s.split(DEP_SPLIT).map(x => x.trim()).filter(Boolean)) {
    let p = raw.replace(/^quest\s*:\s*/i, ''), m;
    if ((m = p.match(/^q:(\d+)(?:\s+step\s+([\w.-]+))?\s*$/i))) deps.push({ kind: 'quest', qid: 'q:' + m[1], step: m[2] || null, raw });
    else if ((m = p.match(/^file\s*:\s*(\S+)(\s+changed)?\s*$/i))) deps.push({ kind: 'file', path: m[1].replace(/^\.\//, ''), changed: !!m[2], raw });
    else if ((m = p.match(/^service\s*:\s*([a-z][a-z0-9-]{1,30})\s*$/i))) deps.push({ kind: 'service', name: m[1].toLowerCase(), raw });
    else if ((m = p.match(/^job\s*:\s*([A-Za-z0-9][\w.:-]{0,79})\s*$/))) deps.push({ kind: 'job', id: m[1], raw });
    else if ((m = p.match(/^seat\s*:\s*([^—–#:]+?)\s*(?:(?:—|–|#|:|\s-\s)\s*(.+))?$/i))) deps.push({ kind: 'seat', name: m[1].trim(), ref: m[2] ? m[2].trim() : null, raw });
    else if ((m = p.match(/^(?:handoff\s*:\s*)?(to-[\w.-]+\.md)\s*(?:(?:#|—|–|:|\s-\s)\s*(.*))?$/i))) deps.push({ kind: 'handoff', inbox: m[1], ref: (m[2] || '').trim() || null, raw });
    else deps.push({ kind: 'unknown', raw });
  }
  for (const d of deps) d.words = depWords(d);
  return { deps, label, words: label || deps.map(d => d.words).join('; ') };
}
/* resolveDeps(deps, look) -> { state, pending, met, unresolved }
 * look.<kind>(dep) answers 'met' | 'waiting' | null (null: the reference names nothing that exists). Any unresolved
 * reference (or no dependency at all) makes the whole line 'unresolvable', and the item is work now. */
function resolveDeps(deps, look) {
  const out = { state: 'met', pending: [], met: [], unresolved: [] };
  if (!Array.isArray(deps) || !deps.length) { out.state = 'unresolvable'; return out; }
  for (const d of deps) {
    let r = null;
    try { const f = look && look[d.kind]; r = typeof f === 'function' ? f(d) : null; } catch (_) { r = null; }
    if (r === 'met') out.met.push(d); else if (r === 'waiting') out.pending.push(d); else out.unresolved.push(d);
  }
  out.state = out.unresolved.length ? 'unresolvable' : out.pending.length ? 'waiting' : 'met';
  return out;
}

/* ---------- Not before: a genuine wall-clock reason only ----------
 * `**Not before:** YYYY-MM-DD[ HH:MM] <reason>`. The reason says which clock: a market opening, a provider's data release,
 * a time someone outside the company named (external), or a provider's quota reset (a category, not external). Caps,
 * measured from when the dispatcher first saw the line: at most 24 h ahead without a reason category, at most 72 h with
 * one; in Sprint at most 12 h unless the reason is an external time. Beyond that the line is ignored (the item is work
 * now) and the lint says to use **Waiting on:** or ask the CEO. A reason that reads like a dependency never counts as a
 * category: it is waiting on work, not on a clock. */
const NB_CATEGORIES = [
  ['market', true, /\b(markets?|exchanges?|(?:trading )?sessions?|opening bell|bell|trading (?:day|hours)|pre-?market|NYSE|NASDAQ|CME|LSE|COMEX|NYMEX|ICE|futures (?:open|close)|(?:opens|closes) at)\b/i],
  ['release', true, /\b(releases?|released|publish(?:es|ed)?|data drop|daily (?:file|data|report)|end[- ]of[- ]day (?:data|file|prices)|EOD (?:data|file|prices)|settlement prices?|fixing|print(?:s)? at|report(?:s)? at|comes out)\b/i],
  ['outside', true, /\b(?:(?:owner|customer|client|vendor|supplier|partner|regulator|broker|counterparty|auditor|landlord|they|he|she)\s+(?:named|set|asked for|chose|said|scheduled|booked|agreed)|meeting|call with|appointment|embargo(?:ed)?|launch window|go-?live|maintenance window|planned outage)\b/i],
  ['quota', false, /\b(quota|rate[- ]limit|limit resets?|window resets?|resets? at|cool-?down ends?)\b/i],
];
const DEP_SHAPED = /\b(after\b|needs?\b|waits? (?:on|for)|waiting (?:on|for)|once\b|when\b[^.]{0,60}\b(?:lands?|finishes|finished|is done|exists|arrives|completes|is in)\b|comes after|reads? the\b|rides? (?:inside|on|with)|depends? on|until\b[^.]{0,60}\b(?:done|finished|exists|lands|is in)\b|is done\b)/i;
function depShaped(text) { const m = String(text || '').match(DEP_SHAPED); return m ? m[1] : null; }
// what follows the date: "— market opens 09:30 ET", "(set 2026-11-17 22:24 by Founder: the verdict reads the 00:30 bank)"
function nbReason(rest) {
  let r = String(rest || '').trim().replace(/^[—–:,;-]+\s*/, '').trim();
  if (/^\(.*\)$/.test(r)) r = r.slice(1, -1).trim();
  r = r.replace(/^set\s+\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?\s+by\s+[^:]{1,60}:\s*/i, '').trim();
  return r.replace(/^[—–:,;-]+\s*/, '').trim();
}
/* notBeforeGate({ rest, hoursAhead, sprint }) -> { honour, reason, category, external, dep, why, cap }
 * rest: the line after its date; hoursAhead: from when the line was first seen to its date. */
function notBeforeGate(o) {
  const reason = nbReason(o.rest);
  const dep = reason ? depShaped(reason) : null;
  const hit = dep ? null : NB_CATEGORIES.find(c => c[2].test(reason));
  const category = hit ? hit[0] : null, external = !!(hit && hit[1]);
  const h = Number(o.hoursAhead) || 0;
  const cap = o.sprint && !external ? 12 : category ? 72 : 24;
  const span = h >= 47.5 ? Math.round(h / 24) + '-day' : Math.max(1, Math.round(h)) + '-hour';
  const whyNot = !reason ? 'no external reason' : dep ? 'a dependency ("' + dep + '"), not a clock time' : category ? (external ? 'more than 72 h ahead' : 'no external reason') : 'no external reason';
  if (h > cap) return { honour: false, reason, category, external, dep, cap, why: 'a ' + span + ' Not before with ' + (o.sprint && cap === 12 && h <= (category ? 72 : 24) ? 'no external reason during Sprint' : whyNot) };
  return { honour: true, reason, category, external, dep, cap, why: null };
}
/* spreadOn(config, now): the spread holds only while spreadDailyCap is not false and no "off until" is still running */
function spreadOn(config, now) {
  const c = config || {}; if (c.spreadDailyCap === false) return false;
  const u = Date.parse(c.spreadOffUntil || ''); return !(Number.isFinite(u) && u > (Number(now) || Date.now()));
}
function effortOf(items) {
  const open = (items || []).filter(i => i.open);
  if (!open.length) return 'default';
  if (open.some(i => i.effort === 'reasoning')) return 'reasoning';
  return open.every(i => i.effort === 'mechanical') ? 'mechanical' : 'default';
}

/* ---------- lanes ---------- */
const norm = s => String(s).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
function pathOverlap(a, b) { a = norm(a); b = norm(b); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
function overlaps(a, b) { if (!a || !b) return true; return a.some(x => b.some(y => pathOverlap(x, y))); }
/* lanePlan(items, { lanes, isCeo, held }) -> { lanes: [[item…]…], waiting: [item…], independent, why }
 * An item without Touches conflicts with everything, so while one is open the seat runs ONE lane holding all its items
 * (one wake, N items). Otherwise each lane takes items whose Touches are disjoint from every other lane's; an item that
 * overlaps a lane joins that lane's batch (serial); one that overlaps a path another lane already holds (held) waits.
 * The CEO seat is always one lane (external-gate provenance needs one live CEO run). */
function lanePlan(items, o) {
  o = o || {};
  const open = (items || []).filter(i => i.open);
  const max = o.isCeo ? 1 : Math.max(1, Math.floor(Number(o.lanes) || 1));
  const held = (o.held || []).map(norm);
  const indep = open.filter(i => i.touches), serial = open.filter(i => !i.touches);
  const why = o.isCeo ? 'the CEO runs one lane at a time' : max === 1 ? 'one lane allowed' : serial.length ? serial.length + ' open item(s) declare no Touches, so everything runs in one lane' : indep.length < 2 ? 'fewer than two items' : null;
  if (max === 1 || serial.length || indep.length < 2) return { lanes: open.length ? [open] : [], waiting: [], independent: indep.length, why };
  const lanes = [], waiting = [];
  for (const it of indep) {
    if (held.length && overlaps(held, it.touches)) { waiting.push(it); continue; }
    const hit = lanes.find(l => overlaps(l.touches, it.touches));
    if (hit) { hit.items.push(it); hit.touches = hit.touches.concat(it.touches); }
    else if (lanes.length < max) lanes.push({ items: [it], touches: it.touches.slice() });
    else { const l = lanes[lanes.length - 1]; l.items.push(it); l.touches = l.touches.concat(it.touches); }   // no lane left: batched
  }
  return { lanes: lanes.map(l => l.items), waiting, independent: indep.length, why: lanes.length < 2 ? 'their Touches overlap' : null };
}
/* makePathLock(file) — per-path locks for lanes, kept in one JSON file under a mkdir lock.
 *   acquire(laneId, paths) -> { ok:true } | { ok:false, holder, path }   a conflict waits (nothing is taken)
 *   release(laneId); held() -> [{ lane, paths, at }] */
function makePathLock(file, opts) {
  const now = (opts && opts.now) || Date.now;
  const lockDir = file + '.lock';
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).locks || []; } catch (_) { return []; } };
  const write = locks => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ _doc: 'lane path locks (lib/sprint.js makePathLock)', locks }, null, 1) + '\n'); fs.renameSync(tmp, file); };
  function guarded(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lockDir); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 30000) { fs.rmdirSync(lockDir); continue; } } catch (_) {}
        if (i > 200) throw new Error('path lock busy: ' + lockDir);
        const t = Date.now(); while (Date.now() - t < 5) { /* spin briefly */ }
      }
    }
    try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch (_) {} }
  }
  return {
    acquire(lane, paths) {
      const want = (paths || []).map(norm).filter(Boolean);
      if (!want.length) return { ok: false, holder: null, path: null, why: 'no paths declared: an item without Touches never takes a lane lock' };
      return guarded(() => {
        const locks = read();
        for (const l of locks) if (l.lane !== lane) for (const p of want) if (l.paths.some(q => pathOverlap(p, q))) return { ok: false, holder: l.lane, path: p };
        const rest = locks.filter(l => l.lane !== lane); rest.push({ lane, paths: want, at: new Date(now()).toISOString() }); write(rest);
        return { ok: true };
      });
    },
    release(lane) { return guarded(() => { const locks = read(); const rest = locks.filter(l => l.lane !== lane); if (rest.length !== locks.length) write(rest); return locks.length - rest.length; }); },
    held() { return read(); },
  };
}

/* ---------- money ---------- */
function sprintSpend(rows, sinceMs, unmetered) {
  const un = new Set(unmetered || ['claude-cli']);
  let usd = 0, runs = 0;
  for (const r of rows || []) {
    const t = Number(r.endedAt || r.startedAt || r.ts) || 0; if (t < sinceMs) continue;
    runs++; if (!un.has(String(r.provider || '')) && Number.isFinite(Number(r.usd))) usd += Number(r.usd);
  }
  return { usd: Math.round(usd * 1e6) / 1e6, runs };
}

module.exports = { SPRINT_DEFAULTS, CONFIG_KEYS, parseItems, parseTouches, parseEffort, workSig, restMs, spreadHold, spreadOn, waitingOn, blockersOf, parseDeps, resolveDeps, depWords, notBeforeGate, nbReason, depShaped, NB_CATEGORIES, effortOf, lanePlan, overlaps, pathOverlap, makePathLock, sprintSpend };
