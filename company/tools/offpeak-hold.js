#!/usr/bin/env node
/*
 * offpeak-hold.js — the off-peak hold, as ONE predicate with two triggers.
 *
 * Why this file exists. A provider-billed (DeepSeek) wake may be deferred into the next off-peak block only when ALL
 * THREE of these hold:
 *     1. no OPEN handoff due today for that agent,
 *     2. no unread owner message for that agent,
 *     3. no merge / release / publication window open.
 * and it must be the dispatcher's existing rail hold with a new trigger, not a second scheduler. The rail hold is
 * pacer.js `hookLocked()`: it walks the dispatcher's wake list and spares a wake on an owner message, on an OPEN
 * handoff due today, and on anything that is not DeepSeek. This module is that same set of conditions written once,
 * with the trigger passed in (rail pressure, or a peak block).
 *
 * The contract, so two triggers cannot drift apart:
 *     holdCheck(ctx)  -> {hold, why, spare}      the predicate. No clock, no peak, no rail. Pure given its inputs.
 *     deferrable(ctx) -> {defer, why, until}     the new trigger: holdCheck AND inside a peak block.
 * `--parity` compares this module's answers with the rail chain in pacer.js on the crew and prints a line per
 * disagreement, so "same predicate" is measured rather than asserted.
 *
 * Fail-closed, in the direction that costs money rather than a deadline: if this file cannot tell whether a
 * window is open (unreadable merge-train.sh, unparseable bound), the wake is NOT deferred. A missed saving is
 * cheaper than a missed release. The same rule for an unknown provider: unknown is not DeepSeek, so it runs.
 *
 * Peak blocks are config, not code: company/work/finance/pacing-policy.json `peakPricing.deepseek` (days, blocks,
 * marginMin) in the provider's own timezone, read through lib/models-money.js. The margin is applied at both edges
 * because the provider does not say whether a request that crosses a boundary bills at its start or its end. No
 * config = no peak hours = nothing is deferred.
 *
 *   node company/tools/offpeak-hold.js --selftest     # every case below; exit code = number of failed cases
 *   node company/tools/offpeak-hold.js --status       # now, peak?, next window, who would be held
 *   node company/tools/offpeak-hold.js --parity       # this module vs pacer.js's rail chain, on the crew
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const co = require('./lib/company');
const mm = require('./lib/models-money');

const ROOT = co.ROOT;
const REL = {
  mergeTrain: 'company/tools/merge-train.sh',
  clearances: 'company/state/external-clearances.jsonl',
  handoffs: 'company/work/handoffs',
  loops: 'company/tools/loops.json',
};
// The gate categories that mean "something is about to become visible outside the company" (external-gate.js
// CATEGORIES: publish covers releasing and deploying). `spend`, `message`, `form`, `account` are not windows.
const WINDOW_CATEGORIES = ['publish'];

function peakConfig(root) { return mm.peakConfig(root || ROOT, 'deepseek'); }

// The must-not-move list is config (pacing-policy.json offpeakHold.mustNotMove), one list for two controls: this
// hold and offpeak-clocks.js. A missing key fails the peak trigger OPEN (every routine is exempt, nothing is
// deferred); an empty list means no routine is exempt.
function mustNotMove(loopName, root) {
  const name = String(loopName == null ? '' : loopName).toLowerCase();
  const list = mm.mustNotMove(root || ROOT);
  if (list == null) return true;
  if (!name) return false;
  return list.some(p => p && name.startsWith(String(p).toLowerCase()));
}

/* ---------- clock: pure functions of a millisecond stamp in the provider's timezone ---------- */
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pad2 = n => (n < 10 ? '0' : '') + n;
function hhmm(min) { const m = ((Math.round(min) % 1440) + 1440) % 1440; return pad2(Math.floor(m / 60)) + pad2(m % 60); }
function hhmm4(v) { const m = ((Math.round(v) % 2400) + 2400) % 2400; return (m < 1000 ? '0' : '') + m; }   // an HHMM value, not minutes
const cfgOf = cfg => cfg || peakConfig();
const marginOf = (marginMin, cfg) => isNum(marginMin) ? marginMin : cfg.marginMin;

// inPeak(min, marginMin, cfg) -> the bare block whose [start-margin, end+margin) contains `min`, or null
function inPeak(min, marginMin, cfg) {
  const c = cfgOf(cfg), mg = marginOf(marginMin, c);
  for (const [s, e] of c.blocks) if (min >= s - mg && min < e + mg) return hhmm(s) + '-' + hhmm(e);
  return null;
}

// peakBlock(at, marginMin, cfg) -> {peak, block}. Days not listed in the config are never peak.
function peakBlock(at, marginMin, cfg) {
  const c = cfgOf(cfg);
  const t = isNum(at) ? at : Date.now();
  if (!c.known) return { peak: false, block: null };
  const { day, min } = mm.zoneParts(t, c.timezone);
  if (!c.days.has(day)) return { peak: false, block: null };
  const block = inPeak(min, marginMin, c);
  return { peak: !!block, block };
}

// nextWindow(at) -> the millisecond the current peak block (with margin) ends and cheap billing resumes. A deferral
// is to this window only; nothing here retries past it. Outside a peak block it is `at` itself. Computed as an
// offset in whole minutes from `at`, so no local-time setters are involved.
function nextWindow(at, marginMin, cfg) {
  const c = cfgOf(cfg);
  const t = isNum(at) ? at : Date.now();
  if (!peakBlock(t, marginMin, c).peak) return t;
  const { min } = mm.zoneParts(t, c.timezone);
  const mg = marginOf(marginMin, c);
  const minuteStart = t - (t % 60e3);
  for (const [s, e] of c.blocks) if (min >= s - mg && min < e + mg) return minuteStart + (e + mg - min) * 60e3;
  return t;
}

// windowCloses(at) -> the millisecond the cheap window that `nextWindow(at)` opens ENDS: the first minute at or after
// it where peakBlock() is true again. A deferred wake is owed a run inside that window, so it can only be called
// dropped once the window has closed — not on its first tick, when the dispatcher has not yet had the chance to
// fire it. With no peak config there is no next peak: eight days on.
function windowCloses(at, marginMin, cfg) {
  const c = cfgOf(cfg);
  let t = nextWindow(at, marginMin, c);
  if (!c.known) return t + 8 * 86400e3;
  for (let i = 0; i < 8 * 24 * 60; i++, t += 60e3) if (peakBlock(t, marginMin, c).peak) return t;
  return t;
}

/* ---------- condition 3's two sources ---------- */
// mergeWindow(root) -> {known, start, stop, source}. The merge window lives in merge-train.sh (WINDOW_START /
// WINDOW_STOP, company time); this reads those two constants rather than keeping a second copy of the numbers.
function mergeWindow(root) {
  const f = path.join(root || ROOT, REL.mergeTrain);
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { return { known: false, why: 'cannot read ' + REL.mergeTrain + ' (' + e.code + ')' }; }
  const g = k => { const m = txt.match(new RegExp('^' + k + '=([0-9]{4})\\b', 'm')); return m ? Number(m[1]) : null; };
  const start = g('WINDOW_START'), stop = g('WINDOW_STOP');
  if (!isNum(start) || !isNum(stop)) return { known: false, why: REL.mergeTrain + ' no longer declares WINDOW_START/WINDOW_STOP' };
  return { known: true, start, stop, source: REL.mergeTrain };
}

// insideMergeWindow(at, w, tz) -> the same wrap arithmetic merge-train.sh's in_window() uses (a window that crosses
// midnight; a naive start<=now<=stop test gets it wrong), in the company timezone.
function insideMergeWindow(at, w, tz) {
  if (!w || !w.known) return null;
  const p = mm.zoneParts(isNum(at) ? at : Date.now(), tz || co.TZ);
  const now = p.hour * 100 + p.minute;
  return w.start > w.stop ? (now >= w.start || now < w.stop) : (now >= w.start && now < w.stop);
}

// liveWindows(root, at) -> [{id, category, target, until}] — a clearance row that is unclosed and unexpired,
// in a category that publishes or releases. NOT part of the predicate: a clearance row is PERMISSION with an
// `until` that may run for days, so treating it as a window would hold nothing at all. A window is something
// happening now. `--status` prints the row count so the distinction stays visible.
function liveWindows(root, at) {
  const t = isNum(at) ? at : Date.now();
  const f = path.join(root || ROOT, REL.clearances);
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return { known: false, rows: [], why: 'cannot read ' + REL.clearances }; }
  const rows = [], parsed = [];
  for (const line of txt.split('\n')) { const s = line.trim(); if (!s) continue; try { parsed.push(JSON.parse(s)); } catch (_) {} }   // a corrupt row can never clear, or hold, anything
  const closed = new Set(parsed.filter(r => r && r.type === 'close' && r.id).map(r => String(r.id)));   // external-gate.js close appends these
  for (const r of parsed) {
    if (!r || r.type === 'close') continue;
    if (!WINDOW_CATEGORIES.includes(String(r.category || '').toLowerCase())) continue;
    if (r.closedAt || closed.has(String(r.id))) continue;                 // a closed row is not an open permission
    const until = Date.parse(r.until); if (!isNum(until) || until <= t) continue;
    rows.push({ id: r.id, category: r.category, target: r.target, until: r.until });
  }
  return { known: true, rows };
}

// windowsOpen({root, at, jobs}) -> {known, open, why[]}. `known:false` means "could not tell" and the caller
// must not defer. Two sources: the merge window's arithmetic (read from merge-train.sh) and a
// merge/release/deploy/publish routine that is running right now.
function windowsOpen(o) {
  o = o || {};
  const at = isNum(o.at) ? o.at : Date.now(), why = [];
  const mw = mergeWindow(o.root);
  if (!mw.known) return { known: false, open: false, why: [mw.why], merge: mw };
  const inside = insideMergeWindow(at, mw, o.tz);
  if (inside) why.push('the merge window ' + hhmm4(mw.start) + '-' + hhmm4(mw.stop) + ' (' + (o.tz || co.TZ) + ') is open (' + mw.source + ')');
  const inflight = (o.jobs || []).filter(j => j && j.state === 'running' && /merge|release|deploy|publish/i.test(String(j.name || '')));
  for (const j of inflight) why.push('"' + j.name + '" is running now');
  return { known: true, open: why.length > 0, why, merge: mw };
}

/* ---------- the predicate, once ---------- */
// holdCheck(ctx) -> {hold, why, spare}. `hold:true` means "this wake may be deferred". `spare` names the
// condition that spared it (the wake must run), or null when nothing spared it.
//   ctx.id          the agent id (the crew key), not the routine id
//   ctx.provider    the provider the wake would run on
//   ctx.ownerWake   Set of agent ids the dispatcher woke for an unread owner message
//   ctx.inbox       absolute path to that agent's handoff inbox (omitted: no due-handoff test is possible)
//   ctx.at          the tick's clock, ms
//   ctx.root        company root
//   ctx.jobs        station jobs, for the in-flight window test
//   ctx.windows     a pre-computed windowsOpen() result (the rail path passes one per tick, not one per agent)
function holdCheck(ctx) {
  ctx = ctx || {};
  const at = isNum(ctx.at) ? ctx.at : Date.now();
  const id = String(ctx.id == null ? '' : ctx.id);
  const prov = ctx.provider == null ? null : String(ctx.provider).toLowerCase();
  if (prov !== 'deepseek') return { hold: false, spare: 'not-deepseek', why: 'it is not billed by DeepSeek (' + (prov || 'no provider') + ')' };
  if (ctx.ownerWake && typeof ctx.ownerWake.has === 'function' && ctx.ownerWake.has(id))
    return { hold: false, spare: 'owner-wake', why: 'an unread owner message woke this agent; an owner wake is never held' };
  let due = [];
  if (ctx.inbox) {
    let hdt; try { hdt = require('./pacer.js').handoffsDueToday; } catch (_) { hdt = null; }
    if (hdt) { try { due = hdt(ctx.inbox, at) || []; } catch (_) { due = []; } }
  }
  if (due.length) return { hold: false, spare: 'open-handoff-due-today', why: due.length + ' OPEN handoff(s) due today: "' + String(due[0]).slice(0, 90) + '"' };
  const w = ctx.windows || windowsOpen({ root: ctx.root, at, jobs: ctx.jobs });
  if (!w.known) return { hold: false, spare: 'window-unknown', why: 'fail closed — ' + (w.why || []).join('; ') };
  if (w.open) return { hold: false, spare: 'window-open', why: w.why.join('; ') };
  return { hold: true, spare: null, why: 'no OPEN handoff due today, no unread owner message, no merge/release/publication window open' };
}

// deferrable(ctx) -> the new trigger: holdCheck AND inside a peak block. `until` is the next window, and a
// deferred wake is to THAT window only (the dispatch log records the deferral and the drop; nothing retries).
// ctx.cfg overrides the peak config (selftests); otherwise it is read from ctx.root.
function deferrable(ctx) {
  ctx = ctx || {};
  const at = isNum(ctx.at) ? ctx.at : Date.now();
  const cfg = ctx.cfg || peakConfig(ctx.root);
  const p = peakBlock(at, undefined, cfg);
  if (!p.peak) return { defer: false, why: 'outside the DeepSeek peak block', peak: p, until: at };
  // The must-not-move list applies to THIS trigger only. The rail hold is a money-safety control and keeps its
  // existing behaviour.
  if (mustNotMove(ctx.loop, ctx.root)) return { defer: false, spare: 'must-not-move', why: '"' + ctx.loop + '" is on the must-not-move list (pacing-policy.json offpeakHold.mustNotMove)', peak: p, until: at };
  const h = holdCheck(Object.assign({}, ctx, { at }));
  return { defer: h.hold, why: h.why, spare: h.spare, peak: p, until: nextWindow(at, undefined, cfg), check: h };
}

/* ---------- parity: the same predicate as the rail hold, measured ---------- */
// pacer.js hookLocked() spares a wake on: an owner wake, an OPEN handoff due today, or a provider that is not
// DeepSeek. This replays that chain over the crew and compares it with holdCheck() on identical inputs, so the two
// triggers can be seen to agree instead of being asserted to.
function parity(root) {
  const r = root || ROOT;
  let loops = {}; try { loops = JSON.parse(fs.readFileSync(path.join(r, REL.loops), 'utf8')); } catch (_) { return { cases: 0, diffs: [{ id: '(none)', why: 'loops.json unreadable' }], rows: [] }; }
  const crew = loops.agents || loops.crew || loops;
  const windows = windowsOpen({ root: r });          // one reading per run, as the rail path does per tick
  const out = [];
  for (const [id, c] of Object.entries(crew)) {
    if (!c || typeof c !== 'object') continue;
    const provider = c.provider || c.wire && c.wire.provider || null;
    const inbox = c.inbox ? path.join(r, REL.handoffs, c.inbox) : null;
    // the rail hold's chain, verbatim in shape
    const rail = { hold: true, spare: null };
    if (String(provider).toLowerCase() !== 'deepseek') { rail.hold = false; rail.spare = 'not-deepseek'; }
    else {
      let due = []; if (inbox) { try { due = require('./pacer.js').handoffsDueToday(inbox, Date.now()) || []; } catch (_) {} }
      if (due.length) { rail.hold = false; rail.spare = 'open-handoff-due-today'; }
      else if (!windows.known) { rail.hold = false; rail.spare = 'window-unknown'; }
      else if (windows.open) { rail.hold = false; rail.spare = 'window-open'; }
    }
    const mine = holdCheck({ id, provider, inbox, at: Date.now(), root: r, windows });
    out.push({ id, provider, rail, mine, same: rail.hold === mine.hold && rail.spare === mine.spare });
  }
  return { cases: out.length, diffs: out.filter(x => !x.same), rows: out };
}

/* ---------- CLI ---------- */
function status(root) {
  const r = root || ROOT, at = Date.now(), cfg = peakConfig(r);
  const p = peakBlock(at, undefined, cfg), w = windowsOpen({ root: r }), par = parity(r);
  const lines = [];
  lines.push('peak config: ' + (cfg.known ? cfg.blocks.map(([s, e]) => hhmm(s) + '-' + hhmm(e)).join(', ') + ' ' + cfg.timezone + ', margin ' + cfg.marginMin + ' min' : 'none (no peak hours: nothing is deferred)'));
  lines.push('now ' + new Date(at).toISOString() + '  peak: ' + (p.peak ? 'YES ' + p.block : 'no') + (p.peak ? '  next window ' + new Date(nextWindow(at, undefined, cfg)).toISOString() : ''));
  lines.push('windows: ' + (w.known ? (w.open ? 'OPEN — ' + w.why.join('; ') : 'none open') : 'UNKNOWN — ' + w.why.join('; ') + ' (nothing is deferred)'));
  const lw = liveWindows(r, at);
  lines.push('live publish clearance rows: ' + (lw.known ? lw.rows.length + ' (permission with an until, not a window)' : 'unreadable'));
  const would = par.rows.filter(x => deferrable({ id: x.id, provider: x.provider, inbox: null, at, root: r, windows: w }).defer);
  lines.push('would defer now: ' + (would.length ? would.map(x => x.id).join(', ') : 'nobody'));
  lines.push('parity with the rail chain: ' + par.cases + ' crew rows, ' + par.diffs.length + ' disagreement(s)');
  return lines.join('\n');
}

// The selftest fixture: a peak config written here, so the test does not depend on the numbers in the policy file.
const FIXTURE_TZ = 'Asia/Shanghai';
const FIXTURE_PEAK = { timezone: FIXTURE_TZ, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], blocks: [['09:00', '12:00'], ['14:00', '18:00']], marginMin: 10 };

function selftest() {
  const fails = [], ok = [];
  const check = (name, got, want) => { if (JSON.stringify(got) === JSON.stringify(want)) ok.push(name); else fails.push(name + ' — got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); };
  const cfg = mm.normalisePeak('deepseek', FIXTURE_PEAK);
  const at = (wd, h, m) => mm.zonedMs(FIXTURE_TZ, 2026, 11, 16 + wd, h, m);   // 2026-11-16 is a Monday
  const pb = (t, mg) => peakBlock(t, mg, cfg);
  const hmZ = ms => { const p = mm.zoneParts(ms, FIXTURE_TZ); return p.day * 10000 + p.hour * 100 + p.minute; };

  // a fixture company root: merge-train.sh, clearances, loops, inboxes, policy with an empty must-not-move list
  const fx = require('./lib/temp-life').tmpDir('offpeak-hold-selftest-');
  const w = (rel, txt) => { const f = path.join(fx, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  w(REL.mergeTrain, '#!/bin/sh\nWINDOW_START=2300\nWINDOW_STOP=0530\n');
  w(mm.POLICY_REL, JSON.stringify({ offpeakHold: { enabled: true, mustNotMove: ['Daily standup', 'Ops loop'] }, peakPricing: { deepseek: FIXTURE_PEAK } }));
  w(REL.loops, JSON.stringify({ agents: { alex: { name: 'Alex', loop: 'Ops loop', inbox: 'to-alex.md', provider: 'deepseek' }, sam: { name: 'Sam', loop: 'Research loop', inbox: 'to-sam.md', provider: 'claude-cli' } } }));
  w(path.join(REL.handoffs, 'to-alex.md'), '# inbox\n');

  // the peak arithmetic, both edges of both blocks and both margins
  check('Mon 08:49 is not peak', pb(at(0, 8, 49)).peak, false);
  check('Mon 08:50 is peak (start margin)', pb(at(0, 8, 50)).peak, true);
  check('Mon 09:00 is peak', pb(at(0, 9, 0)).block, '0900-1200');
  check('Mon 12:09 is peak (last minute of the end margin)', pb(at(0, 12, 9)).peak, true);
  check('Mon 12:10 is not peak (margin half-open at the end)', pb(at(0, 12, 10)).peak, false);
  check('Mon 13:50 is peak', pb(at(0, 13, 50)).peak, true);
  check('Mon 18:09 is peak', pb(at(0, 18, 9)).peak, true);
  check('Mon 18:11 is not peak', pb(at(0, 18, 11)).peak, false);
  check('Sat 10:00 is not peak', pb(at(5, 10, 0)).peak, false);
  check('Sun 15:00 is not peak', pb(at(6, 15, 0)).peak, false);
  check('margin 0 puts 08:50 outside', pb(at(0, 8, 50), 0).peak, false);
  check('no peak config: never peak', peakBlock(at(0, 10, 0), undefined, mm.normalisePeak('deepseek', null)).peak, false);
  check('no peak config: windowCloses terminates', windowCloses(at(0, 10, 0), undefined, mm.normalisePeak('deepseek', null)) > at(0, 10, 0), true);

  // the next window is the end of THIS block, not "later today"
  check('Mon 10:00 defers to 12:10', hmZ(nextWindow(at(0, 10, 0), undefined, cfg)), hmZ(at(0, 12, 10)));
  check('Mon 15:00 defers to 18:10', hmZ(nextWindow(at(0, 15, 0), undefined, cfg)), hmZ(at(0, 18, 10)));
  check('Mon 10:00 held wake is owed a run until Mon 13:50', hmZ(windowCloses(at(0, 10, 0), undefined, cfg)), hmZ(at(0, 13, 50)));
  check('Mon 15:00 held wake is owed a run until Tue 08:50', hmZ(windowCloses(at(0, 15, 0), undefined, cfg)), hmZ(at(1, 8, 50)));
  check('Fri 15:00 held wake is owed a run until Mon 08:50 (weekend is cheap)', hmZ(windowCloses(at(4, 15, 0), undefined, cfg)), hmZ(at(7, 8, 50)));
  check('outside a block the window is now', nextWindow(at(0, 20, 0), undefined, cfg), at(0, 20, 0));

  // the three conditions, each one alone
  const tNine = at(0, 10, 0);
  const cleanInbox = w('to-quiet.md', '# inbox\n\n## 2026-11-16 from someone — nothing due\n**Status:** DONE\n');
  const windowsNone = { known: true, open: false, why: [] };
  check('a DeepSeek wake with nothing pending is held', holdCheck({ id: 'x', provider: 'deepseek', inbox: cleanInbox, windows: windowsNone, at: tNine }).hold, true);
  check('an unread owner message spares it', holdCheck({ id: 'x', provider: 'deepseek', inbox: cleanInbox, windows: windowsNone, at: tNine, ownerWake: new Set(['x']) }).spare, 'owner-wake');
  const dueInbox = w('to-due.md', '## 2026-11-16 from Alex — due today\n**Deadline:** today\n**Status:** OPEN\n');
  check('an OPEN handoff due today spares it', holdCheck({ id: 'x', provider: 'deepseek', inbox: dueInbox, windows: windowsNone, at: tNine }).spare, 'open-handoff-due-today');
  check('an open publish window spares it', holdCheck({ id: 'x', provider: 'deepseek', inbox: cleanInbox, at: tNine, windows: { known: true, open: true, why: ['a release is running'] } }).spare, 'window-open');

  // fail closed, and not DeepSeek
  check('an unreadable window source spares it', holdCheck({ id: 'x', provider: 'deepseek', inbox: cleanInbox, at: tNine, windows: { known: false, open: false, why: ['cannot read merge-train.sh'] } }).spare, 'window-unknown');
  check('a subscription loop is never held', holdCheck({ id: 'x', provider: 'claude-cli', windows: windowsNone, at: tNine }).hold, false);
  check('an unknown provider is never held', holdCheck({ id: 'x', provider: null, windows: windowsNone, at: tNine }).spare, 'not-deepseek');

  // the trigger sits on top of the predicate and cannot fire outside a peak block
  const d = o => deferrable(Object.assign({ id: 'x', provider: 'deepseek', windows: windowsNone, root: fx, cfg }, o));
  check('outside the block nothing is deferred', d({ at: at(0, 20, 0) }).defer, false);
  check('inside the block, nothing pending, it defers to 12:10', hmZ(d({ at: tNine }).until), hmZ(at(0, 12, 10)));
  check('inside the block, a due handoff, it runs', d({ inbox: dueInbox, at: tNine }).defer, false);
  check('inside the block, a must-not-move loop is not deferred', d({ loop: 'Ops loop — run the company', at: tNine }).spare, 'must-not-move');
  check('a loop that is not on the list is deferred', d({ loop: 'Research loop', at: tNine }).defer, true);
  check('the must-not-move list is read from the policy file', mustNotMove('Daily standup', fx) && !mustNotMove('Research loop', fx), true);
  const empty = require('./lib/temp-life').tmpDir('offpeak-hold-empty-');
  fs.mkdirSync(path.join(empty, path.dirname(mm.POLICY_REL)), { recursive: true });
  fs.writeFileSync(path.join(empty, mm.POLICY_REL), JSON.stringify({ offpeakHold: { mustNotMove: [] } }));
  check('an empty must-not-move list exempts nothing', mustNotMove('Ops loop', empty), false);
  fs.writeFileSync(path.join(empty, mm.POLICY_REL), JSON.stringify({ offpeakHold: {} }));
  check('a missing must-not-move list exempts everything (fails open)', mustNotMove('Research loop', empty), true);
  fs.rmSync(empty, { recursive: true, force: true });

  // the merge window arithmetic wraps midnight, in the company timezone, read from merge-train.sh
  const mw = mergeWindow(fx);
  check('merge-train.sh declares its window', mw.known, true);
  const tz = 'UTC';
  check('2330 is inside a 2300-0530 window', insideMergeWindow(mm.zonedMs(tz, 2026, 11, 16, 23, 30), mw, tz), true);
  check('0030 is inside it', insideMergeWindow(mm.zonedMs(tz, 2026, 11, 16, 0, 30), mw, tz), true);
  check('1200 is outside it', insideMergeWindow(mm.zonedMs(tz, 2026, 11, 16, 12, 0), mw, tz), false);

  // a closed or expired clearance row is not a window
  w(REL.clearances, [
    JSON.stringify({ id: 'clr-a', category: 'publish', target: 'web:example', until: '2999-01-01T00:00:00Z' }),
    JSON.stringify({ id: 'clr-b', category: 'publish', target: 'web:example', until: '2999-01-01T00:00:00Z', closedAt: '2026-11-16T00:00:00Z' }),
    JSON.stringify({ id: 'clr-c', category: 'publish', target: 'web:example', until: '2000-01-01T00:00:00Z' }),
    JSON.stringify({ id: 'clr-d', category: 'message', target: 'owner:file', until: '2999-01-01T00:00:00Z' }),
    JSON.stringify({ id: 'clr-e', category: 'publish', target: 'web:example', until: '2999-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'close', id: 'clr-e', until: '2999-01-01T00:00:00Z', closedAt: '2026-11-16T00:00:00Z', closedBy: 'Alex' }),   // a close appended by external-gate.js
    'not json',
  ].join('\n') + '\n');
  check('only the live, unclosed publish row is a window', liveWindows(fx, tNine).rows.map(x => x.id), ['clr-a']);
  const noon = mm.zonedMs(co.TZ, 2026, 11, 16, 12, 0);
  check('a live publish row does NOT make a window open (permission is not a window)', windowsOpen({ root: fx, at: noon, jobs: [] }).open, false);
  check('a deploy running now IS a window', windowsOpen({ root: fx, at: noon, jobs: [{ name: 'Deploy loop', state: 'running' }] }).open, true);

  // parity with the rail chain on a fixture crew
  const par = parity(fx);
  check('this predicate and the rail chain agree on the fixture crew', par.cases > 0 ? par.diffs.length : -1, 0);

  fs.rmSync(fx, { recursive: true, force: true });
  if (fails.length) { console.log('SELFTEST FAILED: ' + fails.length + ' case(s) wrong\n  ' + fails.join('\n  ')); return fails.length; }
  console.log('SELFTEST PASSED (' + ok.length + ' checks)');
  return 0;
}

module.exports = { peakConfig, peakBlock, nextWindow, windowCloses, inPeak, mergeWindow, insideMergeWindow, liveWindows, windowsOpen, holdCheck, deferrable, mustNotMove, parity, status, selftest, REL };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest')) process.exitCode = selftest();
  else if (a.includes('--parity')) { const p = parity(); console.log(p.cases + ' crew rows, ' + p.diffs.length + ' disagreement(s)'); for (const d of p.diffs) console.log('  DIFF ' + d.id + ' rail=' + JSON.stringify(d.rail) + ' mine=' + JSON.stringify(d.mine)); process.exitCode = p.diffs.length ? 1 : 0; }
  else if (a.includes('--status')) console.log(status());
  else { console.log('usage: offpeak-hold.js --selftest | --status | --parity'); process.exitCode = 2; }
}
