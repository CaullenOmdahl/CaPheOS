#!/usr/bin/env node
/*
 * offpeak-proof.js — proof that the off-peak hold works, as ONE command, read from the live records.
 *
 * The question a CEO or finance owner asks of the off-peak rule: on one real weekday, (a) are the routine clocks off
 * the peak-price blocks with the margin, (b) was at least one DeepSeek wake held inside a peak block with its reason
 * written, and then actually run inside the cheap window, and (c) what is the ledger split for that day: runs and
 * dollars inside vs outside the peak blocks. A fixture cannot answer that; the records can.
 *
 * This file reads four records and answers those three questions. It does not create a hold, move a clock or write
 * anything except its own stdout:
 *   (a) clocks      live /api/cron (or --file <saved body>) + offpeak-clocks.js audit() — same config, same margin;
 *                   plus any clocks named in pacing-policy.json offpeakHold.proofClocks [{name, at}] (optional)
 *   (b) holds       company/state/pacer-log.jsonl  kind=defer (trigger=peak) and kind=defer-drop
 *       ran         .starnet-data/workspaces/ledger.jsonl — first run for that agent at/after the window's end,
 *                   and the proof that nothing ran for it between the hold and the window's end
 *   (c) split       the same ledger, one company-timezone day: rows and USD inside the peak+margin windows vs outside
 * Peak blocks come from pacing-policy.json peakPricing.deepseek (the provider's own timezone, lib/models-money.js).
 *
 * Exit: 0 PROOF COMPLETE, 1 NOT YET (the window has not happened, or the held wake has not run yet), 2 FAILED
 * (a named clock is still in peak, a held wake ran inside the peak, or a held wake was dropped).
 *
 *   node company/tools/offpeak-proof.js                    # today, live station
 *   node company/tools/offpeak-proof.js --date YYYY-MM-DD   # a named day (company timezone)
 *   node company/tools/offpeak-proof.js --selftest          # every case below, exit = failed cases
 *   node company/tools/offpeak-proof.js --journal F --ledger F --file J   # fixture inputs (used by --selftest)
 * Owner: the tools seat (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const co = require('./lib/company');
const mm = require('./lib/models-money');
const OH = require('./offpeak-hold.js');

const ROOT = co.ROOT;
const REL = {
  journal: 'company/state/pacer-log.jsonl',
  ledger: '.starnet-data/workspaces/ledger.jsonl',
};
// The evaluation context: the provider's peak config and the company timezone that defines "the day". analyse() sets
// it from its options (the selftest passes a fixture config), else it is read from the policy file.
const CTX = { cfg: null, tz: null, root: null };
const cfg = () => CTX.cfg || OH.peakConfig(CTX.root || ROOT);
const dayTz = () => CTX.tz || co.TZ;
// Clocks the proof names explicitly (optional): pacing-policy.json offpeakHold.proofClocks, [{ name, at: "HH:MM" }].
function namedClocks(root) {
  const oh = (mm.pacingPolicy(root || ROOT) || {}).offpeakHold || {};
  return Array.isArray(oh.proofClocks) ? oh.proofClocks.filter(x => x && x.name).map(x => ({ name: String(x.name), now: x.at ? String(x.at) : null })) : [];
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pad2 = n => (n < 10 ? '0' : '') + n;
const hhmm = min => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); };
const localDay = ms => mm.zoneParts(ms, dayTz()).date;
const stamp = ms => { const p = mm.zoneParts(ms, dayTz()); return p.date + ' ' + hhmm(p.min); };

// inPeakAt(ms) -> the [start-margin, end+margin) block (provider minutes) containing that instant, or null. The same
// arithmetic as offpeak-hold.js peakBlock(): one config, one margin, so the three tools cannot disagree about a minute.
function inPeakAt(ms) {
  const c = cfg();
  if (!OH.peakBlock(ms, undefined, c).peak) return null;
  const { min } = mm.zoneParts(ms, c.timezone);
  for (const [s, e] of c.blocks) if (min >= s - c.marginMin && min < e + c.marginMin) return [s - c.marginMin, e + c.marginMin];
  return null;
}
const blockText = b => b ? hhmm(b[0]) + '–' + hhmm(b[1]) : null;
// clearance(ms) -> minutes from that instant (provider clock) to the nearest edge of the peak+margin windows
// (positive = outside, cheap)
function clearance(ms) {
  const c = cfg();
  const { min } = mm.zoneParts(ms, c.timezone);
  let best = Infinity;
  for (const [s, e] of c.blocks) {
    const a = s - c.marginMin, b = e + c.marginMin;
    if (min >= a && min < b && OH.peakBlock(ms, undefined, c).peak) return -Math.min(min - a, b - min) || 0;   // inside: how far from the nearest edge
    best = Math.min(best, Math.abs(min - a), Math.abs(min - b));
  }
  return best;
}

/* ---------- (a) the clocks ---------- */
function clockRows(jobs, at, named) {
  const OC = require('./offpeak-clocks.js');
  const out = [];
  const list = named || namedClocks(CTX.root);
  const byName = new Map();
  for (const j of jobs || []) if (j && j.name) byName.set(String(j.name), j);
  for (const f of list) {
    const j = byName.get(f.name) || [...byName.values()].find(x => String(x.name).toLowerCase().startsWith(f.name.toLowerCase()));
    const clock = j ? OC.singleClock(j) : null;
    if (!clock) { out.push({ name: f.name, ok: false, why: j ? 'not a single daily clock any more' : 'routine not found on the station', now: f.now, at: null }); continue; }
    const inst = OC.clockInstant(j, clock, new Date(at));
    const blk = inPeakAt(inst);
    const clear = clearance(inst);
    out.push({ name: f.name, ok: !blk, why: blk ? 'inside the peak+margin block ' + blockText(blk) + ' ' + cfg().timezone : clear + ' min clear of the nearest edge', now: f.now, at: hhmm(clock.at), clear });
  }
  // every other movable clock still in peak: a failure when no clocks are named (then the audit IS the proof),
  // a warning otherwise.
  const extra = (OC.audit(jobs, new Date(at), { cfg: cfg(), root: CTX.root || ROOT }) || []).filter(x => !list.some(f => String(x.name).toLowerCase().startsWith(f.name.toLowerCase())));
  return { rows: out, extra, named: list.length };
}

/* ---------- (b) the hold and the run ---------- */
// The pacer's `defer` rows may name the person; the ledger keys its rows by agent id. Newer rows carry `id`; older
// ones are mapped through loops.json by crew name. Without this a wake that had run would read "not yet".
function crewIds() {
  let a = {}; try { a = JSON.parse(fs.readFileSync(path.join(CTX.root || ROOT, 'company/tools/loops.json'), 'utf8')).agents || {}; } catch (_) {}
  const m = {}; for (const [id, c] of Object.entries(a)) if (c && c.name) m[String(c.name).toLowerCase()] = id;
  return m;
}
function rowId(r, ids) { return r.id || (ids || {})[String(r.agent || '').toLowerCase()] || r.agent; }
function readJsonl(f) {
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  const rows = [];
  for (const line of txt.split('\n')) { const s = line.trim(); if (!s) continue; try { rows.push(JSON.parse(s)); } catch (_) { /* a corrupt row cannot prove or fail anything */ } }
  return rows;
}
function holds(day, journalRows) {
  const j = journalRows || [];
  const defers = j.filter(r => r && r.kind === 'defer' && localDay(Date.parse(r.at)) === day);
  const drops = j.filter(r => r && r.kind === 'defer-drop' && localDay(Date.parse(r.until || r.at)) === day);
  const peak = defers.filter(r => r.trigger === 'peak' && inPeakAt(Date.parse(r.at)));
  return { peak, all: defers, drops };
}
// ranOutside(agentId, from, until, day, ledger) -> {ran, at, usd, model, insidePeak, runsBefore}
function ranOutside(agentId, from, until, day, ledger, releases) {
  const allRows = (ledger || []).filter(r => r && r.agentId === agentId && isNum(r.ts) && localDay(r.ts) === day);
  // A DeepSeek row with tokens === 0 never reached the model: the provider refused it (failureCode `billing` /
  // HTTP 402 in runs.jsonl, an empty balance). It is neither "the held wake ran" nor "the hold did not take", so it
  // is counted apart. Rows with no `tokens` field (older fixtures, other lanes) are treated as real runs, as before.
  const refused = r => /deepseek/i.test(String(r.model || '')) && isNum(r.tokens) && r.tokens === 0;
  const rows = allRows.filter(r => !refused(r));
  const providerFailed = allRows.filter(refused).filter(r => r.ts >= from).map(r => stamp(r.ts));
  // Only a DeepSeek-billed run inside the hold counts against it: a MiniMax or subscription run is not peak-priced.
  // A run after a `release` row for the same agent was let go by the predicate on purpose (pacer-log kind=release).
  const rel = (releases || []).filter(x => x.id === agentId && isNum(Date.parse(x.at))).map(x => Date.parse(x.at));
  const inHold = rows.filter(r => r.ts >= from && r.ts < until).sort((a, b) => a.ts - b.ts);
  const before = inHold.filter(r => /deepseek/i.test(String(r.model || '')) && !rel.some(t => t <= r.ts + 60e3));
  const otherLane = inHold.length - inHold.filter(r => /deepseek/i.test(String(r.model || ''))).length;
  const after = rows.filter(r => r.ts >= until).sort((a, b) => a.ts - b.ts);
  // The rule is about DeepSeek's peak price, so only a DeepSeek row can be "the held wake ran" or "ran inside the peak".
  // A later run on MiniMax or the subscription lane is reported apart (ranOtherLane): it proves nothing either way.
  const first = after.find(r => /deepseek/i.test(String(r.model || ''))) || null;
  const firstOther = after.find(r => !/deepseek/i.test(String(r.model || ''))) || null;
  return {
    ranOtherLane: firstOther ? stamp(firstOther.ts) + ' ' + firstOther.model : null,
    runsBefore: before.map(r => ({ at: stamp(r.ts), usd: r.usd })),
    otherLane, released: rel.length > 0, providerFailed,
    ran: !!first,
    at: first ? stamp(first.ts) : null,
    usd: first ? first.usd : null,
    model: first ? first.model : null,
    insidePeak: first ? !!inPeakAt(first.ts) : null,
  };
}

/* ---------- (c) the split ---------- */
function split(day, ledger) {
  const rows = (ledger || []).filter(r => r && isNum(r.ts) && localDay(r.ts) === day);
  const acc = (list) => ({ runs: list.length, usd: list.reduce((s, r) => s + (isNum(r.usd) ? r.usd : 0), 0) });
  const isDs = r => /deepseek/i.test(String(r.model || ''));
  const inWin = rows.filter(r => !!inPeakAt(r.ts));
  const outWin = rows.filter(r => !inPeakAt(r.ts));
  return {
    day,
    all: { inside: acc(inWin), outside: acc(outWin) },
    deepseek: { inside: acc(inWin.filter(isDs)), outside: acc(outWin.filter(isDs)) },
    total: acc(rows),
  };
}

/* ---------- the verdict ---------- */
function analyse(o) {
  o = o || {};
  const saved = Object.assign({}, CTX);
  CTX.cfg = o.cfg || null; CTX.tz = o.tz || null; CTX.root = o.root || null;
  try { return analyseIn(o); } finally { Object.assign(CTX, saved); }
}
function analyseIn(o) {
  const at = isNum(o.at) ? o.at : Date.now();
  const day = o.day || localDay(at);
  const rec = o.records || {};
  const clocks = clockRows(o.jobs, at, o.named);
  const h = holds(day, rec.journal);
  rec.releases = (rec.journal || []).filter(r => r && r.kind === 'release');
  const led = rec.ledger;
  const ids = o.ids || crewIds();
  const seen = new Set();   // the pacer re-writes the same hold every tick; one row per loop per window
  const firstHolds = h.peak.filter(r => { const k = rowId(r, ids) + '|' + r.until; if (seen.has(k)) return false; seen.add(k); return true; });
  const held = firstHolds.map(r => {
    const from = Date.parse(r.at), until = Date.parse(r.until);
    const run = ranOutside(rowId(r, ids), from, until, day, led, rec.releases);
    const ranAt = run.at; delete run.at;
    return Object.assign({ agent: r.agent, loop: r.loop, at: stamp(from), until: stamp(until), why: r.why, minute: hhmm(mm.zoneParts(from, dayTz()).min), block: blockText(inPeakAt(from)) }, run, { ranAt });
  });
  const sp = split(day, led);
  const problems = [], pending = [];
  const badClock = clocks.rows.filter(r => !r.ok);
  if (badClock.length) problems.push('clock still in peak: ' + badClock.map(r => r.name + ' at ' + (r.at || '?') + ' (' + r.why + ')').join('; '));
  if (!clocks.named && clocks.extra.length) problems.push('clock still in peak: ' + clocks.extra.map(x => x.name + ' at ' + x.at).join('; '));
  // A DEFERRED DROP is a failure only if the wake did not run. A drop row written on the first tick of the cheap
  // window, in the same tick the dispatcher then fired the loop, is reported as a note, not as a failed proof, and
  // only when the ledger shows the run.
  const dropState = h.drops.map(d => ({ d, run: ranOutside(rowId(d, ids), Date.parse(d.from), Date.parse(d.until), day, led, rec.releases) }));
  // A drop whose loop was REFUSED by the provider (0-token DeepSeek rows, 402) is not the hold's failure: the proof cannot
  // be made today, which is NOT YET with the cause named, not a FAILED hold.
  const refusedDrops = dropState.filter(x => !x.run.ran && x.run.providerFailed.length).map(x => x.d);
  const realDrops = dropState.filter(x => !x.run.ran && !x.run.providerFailed.length).map(x => x.d);
  if (refusedDrops.length) pending.push(refusedDrops.length + ' held wake(s) could not run in the cheap window because DeepSeek refused every attempt (0 tokens, billing/402): ' + refusedDrops.map(d => d.loop).join(', ') + ' — fix the balance, then re-read; the hold is not the cause');
  const falseDrops = dropState.filter(x => x.run.ran).map(x => ({ loop: x.d.loop, at: x.run.at }));
  if (realDrops.length) problems.push(realDrops.length + ' held wake(s) DROPPED without running: ' + realDrops.map(d => d.loop + ' held ' + stamp(Date.parse(d.from)) + ' → ' + stamp(Date.parse(d.until))).join('; '));
  for (const x of held) {
    if (x.insidePeak) problems.push('"' + x.loop + '" was held at ' + x.at + ' and then ran INSIDE the peak (first run ' + x.ranAt + ')' );
    if (x.runsBefore && x.runsBefore.length) problems.push('"' + x.loop + '" has ' + x.runsBefore.length + ' run(s) between the hold and the window end (' + x.runsBefore.map(r => r.at).join(', ') + ') — the hold did not take');
  }
  if (!h.peak.length) pending.push('no DeepSeek wake has been held inside a peak block on ' + day + ' yet (pacer-log kind=defer, trigger=peak)');
  const notRun = held.filter(x => !x.ran);
  if (notRun.length) pending.push('held but not yet run outside the window: ' + notRun.map(x => x.loop).join(', '));
  if (!led) problems.push('cannot read the ledger at ' + (o.ledgerPath || REL.ledger) + ' — the split is unknown');
  const complete = !problems.length && !pending.length;
  return { day, at: stamp(at), clocks, holds: h, held, split: sp, problems, pending, falseDrops, ok: complete, failed: problems.length > 0 };
}

/* ---------- fixtures ---------- */
function selftest() {
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; process.stdout.write('ok    ' + name + '\n'); } else { fail++; process.stdout.write('FAIL  ' + name + (extra ? ' — ' + extra : '') + '\n'); } };
  // A fixture: provider peak 09:00-12:00 and 14:00-18:00 UTC+8 (margin 10), the company and its routine clocks on
  // UTC+7, so the peak reads 08:00-11:00 and 13:00-17:00 on the company clock. Monday 2026-11-16; every job a single
  // daily clock; five named clocks at off-peak times.
  const TZ = 'Etc/GMT-7';
  const fx = { cfg: mm.normalisePeak('deepseek', { timezone: 'Asia/Shanghai', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], blocks: [['09:00', '12:00'], ['14:00', '18:00']], marginMin: 10 }), tz: TZ };
  const named = [{ name: 'Tool health check', now: '11:40' }, { name: 'Security sweep', now: '12:05' }, { name: 'Floor loop', now: '11:20' }, { name: 'Hiring loop', now: '12:20' }, { name: 'Research loop', now: '12:40' }];
  const tmp = require('./lib/temp-life').tmpDir('offpeak-proof-selftest-');
  fs.mkdirSync(path.join(tmp, path.dirname(mm.POLICY_REL)), { recursive: true });
  fs.writeFileSync(path.join(tmp, mm.POLICY_REL), JSON.stringify({ offpeakHold: { mustNotMove: ['Ops loop'] } }));
  fx.root = tmp;
  const job = (name, h, m) => ({ id: name, name, enabled: true, schedule: { kind: 'cron', expr: m + ' ' + h + ' * * *', fields: { hour: [h], minute: [m], dayOfWeek: [0, 1, 2, 3, 4, 5, 6], dayOfMonth: [] }, tz: TZ } });
  const jobs = [job('Tool health check', 11, 40), job('Security sweep', 12, 5), job('Floor loop', 11, 20), job('Hiring loop', 12, 20), job('Research loop', 12, 40), job('Ops loop — run the company', 9, 0)];
  const T = (s) => Date.parse('2026-11-16T' + s + '+07:00');
  const journal = [
    { at: new Date(T('08:15:00')).toISOString(), kind: 'defer', agent: 'cand-qa', loop: 'QA loop', trigger: 'peak', until: new Date(T('11:10:00')).toISOString(), why: 'no OPEN handoff due today, no unread owner message, no merge/release/publication window open' },
    { at: new Date(T('09:00:00')).toISOString(), kind: 'defer', agent: 'other', loop: 'Design loop', trigger: 'rail', until: new Date(T('16:00:00')).toISOString(), why: 'rail 88%' },
  ];
  const ledger = [
    { agentId: 'cand-qa', ts: T('06:00:00'), usd: 0.02, model: 'deepseek-flash' },      // before the hold
    { agentId: 'cand-qa', ts: T('11:14:00'), usd: 0.05, model: 'deepseek-flash' },      // the run in the cheap window
    { agentId: 'agent', ts: T('09:30:00'), usd: 0.10, model: 'deepseek-flash' },        // inside peak: the Ops loop pays
    { agentId: 'agent', ts: T('12:30:00'), usd: 0.03, model: 'deepseek-flash' },        // lunch gap
    { agentId: 'x', ts: T('12:40:00'), usd: 0.01, model: 'something-else' },            // not deepseek
  ];
  const base = Object.assign({ day: '2026-11-16', at: T('18:00:00'), jobs, named, records: { journal, ledger }, ledgerPath: REL.ledger }, fx);
  const noRunLedger = () => ledger.filter(r => !(r.agentId === 'cand-qa' && r.ts === T('11:14:00')));
  const r1 = analyse(base);
  ok('a clean Monday with one peak hold that ran at 11:14 is COMPLETE', r1.ok && !r1.failed, JSON.stringify({ p: r1.problems, n: r1.pending }));
  ok('the named clocks each print the margin they cleared', r1.clocks.rows.every(r => r.ok && /min clear/.test(r.why)), JSON.stringify(r1.clocks.rows.map(r => r.why)));
  ok('the hold carries its reason and its block', /no OPEN handoff due today/.test(r1.held[0].why) && r1.held[0].block === '08:50–12:10');
  ok('a rail hold is not counted as the peak proof', r1.holds.peak.length === 1 && r1.holds.all.length === 2);
  ok('the split counts the run at 11:14 as outside and the Ops loop as inside', r1.split.deepseek.inside.runs === 1 && r1.split.deepseek.outside.runs === 3, JSON.stringify(r1.split.deepseek));
  ok('the split arithmetic is exact on the fixture', Math.abs(r1.split.deepseek.inside.usd - 0.10) < 1e-9 && Math.abs(r1.split.deepseek.outside.usd - (0.02 + 0.05 + 0.03)) < 1e-9, JSON.stringify(r1.split.deepseek));
  ok('a non-DeepSeek row is outside the DeepSeek subtotal', r1.split.total.runs === 5 && r1.split.total.usd > 0 && r1.split.deepseek.outside.runs === 3, JSON.stringify(r1.split));

  // (1) the held wake ran INSIDE the peak: the failure the whole rule exists to prevent
  const ledgerPeakRun = ledger.filter(r => !(r.agentId === 'cand-qa' && r.ts === T('11:14:00'))).concat([{ agentId: 'cand-qa', ts: T('10:05:00'), usd: 0.05, model: 'deepseek-flash' }]);
  const r2 = analyse(Object.assign({}, base, { records: { journal, ledger: ledgerPeakRun } }));
  ok('a wake held at 08:15 that ran at 10:05 is FAILED', r2.failed && r2.problems.some(p => /INSIDE the peak|between the hold/.test(p)), JSON.stringify(r2.problems));

  // (2) the wake was held and then dropped
  const journalDrop = journal.concat([{ at: new Date(T('11:10:00')).toISOString(), kind: 'defer-drop', agent: 'cand-qa', loop: 'QA loop', from: new Date(T('08:15:00')).toISOString(), until: new Date(T('11:10:00')).toISOString(), why: 'no OPEN handoff due today' }]);
  const r3 = analyse(Object.assign({}, base, { records: { journal: journalDrop, ledger: ledger.filter(r => !(r.agentId === 'cand-qa' && r.ts === T('11:14:00'))) } }));
  ok('a DEFERRED DROP on the day is FAILED', r3.failed && r3.problems.some(p => /DROPPED/.test(p)), JSON.stringify(r3.problems));

  // (2b) a drop row for a wake the ledger shows RAN is the pre-fix early drop: a note, not a failure
  const r3b = analyse(Object.assign({}, base, { records: { journal: journalDrop, ledger } }));
  ok('a DEFERRED DROP row for a wake that ran at 11:14 is a note, not FAILED', !r3b.failed && r3b.falseDrops.length === 1, JSON.stringify({ p: r3b.problems, f: r3b.falseDrops }));
  // (2c) a DeepSeek run inside the hold is excused only by a release row; another lane's run never counts
  const earlyRun = ledger.concat([{ agentId: 'cand-qa', ts: T('09:30:00'), usd: 0.04, model: 'deepseek-flash' }]);
  const r3c = analyse(Object.assign({}, base, { records: { journal, ledger: earlyRun } }));
  ok('a DeepSeek run at 09:30 with no release row is FAILED', r3c.failed && r3c.problems.some(p => /hold did not take/.test(p)), JSON.stringify(r3c.problems));
  const withRelease = journal.concat([{ at: new Date(T('09:25:00')).toISOString(), kind: 'release', id: 'cand-qa', agent: 'cand-qa', loop: 'QA loop', why: 'a handoff came due' }]);
  const r3d = analyse(Object.assign({}, base, { records: { journal: withRelease, ledger: earlyRun } }));
  ok('the same run after a release row is not a failed hold', !r3d.failed && r3d.held[0].released === true, JSON.stringify(r3d.problems));
  const otherLane = ledger.concat([{ agentId: 'cand-qa', ts: T('09:30:00'), usd: 0, model: 'claude-sonnet-5-5' }]);
  const r3e = analyse(Object.assign({}, base, { records: { journal, ledger: otherLane } }));
  ok('a subscription-lane run during the hold is counted as another lane, not a failure', !r3e.failed && r3e.held[0].otherLane === 1, JSON.stringify({ p: r3e.problems, o: r3e.held[0].otherLane }));
  // (2d) the pacer wrote the crew NAME; the ledger keys by agent id: loops.json is the bridge
  const byName = journal.map(x => Object.assign({}, x, x.agent === 'cand-qa' ? { agent: 'Sam' } : {}));
  const r3f = analyse(Object.assign({}, base, { ids: { sam: 'cand-qa' }, records: { journal: byName, ledger } }));
  ok('a hold row that names "Sam" finds the ledger rows of cand-qa', r3f.held[0].ran === true && r3f.held[0].ranAt === '2026-11-16 11:14', JSON.stringify({ ran: r3f.held[0].ran, at: r3f.held[0].ranAt }));

  // (2e) DeepSeek answers 402 when the balance is empty. A 0-token row is a refusal, not a run.
  const refusedMid = ledger.concat([{ agentId: 'cand-qa', ts: T('09:30:00'), usd: 0, tokens: 0, model: 'deepseek-flash' }]);
  const r3g = analyse(Object.assign({}, base, { records: { journal, ledger: refusedMid } }));
  ok('a 0-token DeepSeek refusal at 09:30 is not a failed hold; it is counted as refused', !r3g.failed && r3g.held[0].providerFailed.length === 1, JSON.stringify({ p: r3g.problems, f: r3g.held[0].providerFailed }));
  const refusedOnly = noRunLedger().concat([{ agentId: 'cand-qa', ts: T('11:14:00'), usd: 0, tokens: 0, model: 'deepseek-flash' }]);
  const r3h = analyse(Object.assign({}, base, { records: { journal, ledger: refusedOnly } }));
  ok('a 0-token refusal at 11:14 is NOT "the held wake ran": the proof stays NOT YET', !r3h.ok && r3h.held[0].ran === false && r3h.pending.some(p => /not yet run/.test(p)), JSON.stringify({ ran: r3h.held[0].ran, n: r3h.pending }));
  const realRun = noRunLedger().concat([{ agentId: 'cand-qa', ts: T('11:14:00'), usd: 0.05, tokens: 90000, model: 'deepseek-flash' }]);
  const r3i = analyse(Object.assign({}, base, { records: { journal, ledger: realRun } }));
  ok('the same row with tokens > 0 still counts as the run', r3i.ok && r3i.held[0].ran === true, JSON.stringify({ p: r3i.problems, n: r3i.pending }));

  const claudeInPeak = noRunLedger().concat([{ agentId: 'cand-qa', ts: T('13:00:00'), usd: 0, tokens: 40000, model: 'claude-sonnet-5-5' }, { agentId: 'cand-qa', ts: T('14:00:00'), usd: 0, tokens: 40000, model: 'claude-sonnet-5-5' }]);
  const r3j = analyse(Object.assign({}, base, { records: { journal, ledger: claudeInPeak } }));
  ok('a held wake whose next run is on the Claude lane inside the peak is not "ran INSIDE the peak", and not the proof either', !r3j.failed && r3j.held[0].ran === false && !!r3j.held[0].ranOtherLane, JSON.stringify({ p: r3j.problems, r: r3j.held[0].ran, o: r3j.held[0].ranOtherLane }));

  const refusedDropLedger = noRunLedger().concat([{ agentId: 'cand-qa', ts: T('11:18:00'), usd: 0, tokens: 0, model: 'deepseek-flash' }]);
  const r3k = analyse(Object.assign({}, base, { records: { journal: journalDrop, ledger: refusedDropLedger } }));
  ok('a DROP whose only attempts were provider refusals is NOT YET with the cause named, not FAILED', !r3k.failed && !r3k.ok && r3k.pending.some(p => /refused every attempt/.test(p)), JSON.stringify({ p: r3k.problems, n: r3k.pending }));

  // (3) nothing held yet (before the first peak block)
  const r4 = analyse(Object.assign({}, base, { at: T('06:20:00'), records: { journal: [], ledger } }));
  ok('before any peak block it is NOT YET, not a failure', !r4.ok && !r4.failed && r4.pending.some(p => /no DeepSeek wake has been held/.test(p)), JSON.stringify({ p: r4.problems, n: r4.pending }));

  // (4) held, window closed, never ran
  const noRun = ledger.filter(r => !(r.agentId === 'cand-qa' && r.ts === T('11:14:00')));
  const r5 = analyse(Object.assign({}, base, { records: { journal, ledger: noRun } }));
  ok('held and not yet run is NOT YET (a drop is the pacer\'s row, not this tool\'s guess)', !r5.ok && !r5.failed && r5.pending.some(p => /not yet run/.test(p)), JSON.stringify({ p: r5.problems, n: r5.pending }));

  // (5) one of the named clocks is still in the peak margin
  const jobsLate = jobs.map(j => j.name === 'Floor loop' ? job('Floor loop', 13, 5) : j);
  const r6 = analyse(Object.assign({}, base, { jobs: jobsLate }));
  ok('a named clock at 13:05 is FAILED and names the clock', r6.failed && r6.problems.some(p => /Floor loop at 13:05/.test(p)), JSON.stringify(r6.problems));

  // (6) an extra movable clock in peak is a warning, not a proof failure
  const r7 = analyse(Object.assign({}, base, { jobs: jobs.concat([job('Sales loop', 11, 0)]) }));
  ok('a clock outside the named list warns without failing the proof', r7.ok && r7.clocks.extra.some(x => x.name === 'Sales loop'), JSON.stringify({ extra: r7.clocks.extra.map(x => x.name), p: r7.problems }));
  // (6b) with no named clocks, the audit is the proof: an in-peak movable clock fails it
  const r7b = analyse(Object.assign({}, base, { named: [], jobs: jobs.concat([job('Sales loop', 11, 0)]) }));
  ok('with no named clocks, an in-peak movable clock is FAILED', r7b.failed && r7b.problems.some(p => /Sales loop/.test(p)), JSON.stringify(r7b.problems));
  const r7c = analyse(Object.assign({}, base, { named: [] }));
  ok('with no named clocks and every clock off-peak, the proof is COMPLETE', r7c.ok, JSON.stringify({ p: r7c.problems, n: r7c.pending }));

  // (7) no ledger: the split cannot be asserted, so it is not a proof
  const r8 = analyse(Object.assign({}, base, { records: { journal, ledger: null } }));
  ok('an unreadable ledger FAILS rather than printing zero dollars', r8.failed && r8.problems.some(p => /cannot read the ledger/.test(p)));

  // (8) a corrupted journal line is skipped, not fatal
  const txt = journal.map(x => JSON.stringify(x)).join('\n') + '\n{not json\n';
  const f = path.join(tmp, 'offpeak-proof-fixture.jsonl');
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); } catch (_) {}
  const r9 = analyse(Object.assign({}, base, { records: { journal: readJsonl(f), ledger } }));
  ok('a corrupt journal line is skipped', r9.holds.peak.length === 1 && r9.ok);

  fs.rmSync(tmp, { recursive: true, force: true });
  process.stdout.write('\nOFF-PEAK PROOF SELFTEST: ' + pass + ' passed, ' + fail + ' failed\n');
  return fail === 0 ? 0 : 1;
}

/* ---------- report ---------- */
function report(r, opts) {
  if (opts.json) { process.stdout.write(JSON.stringify(r, null, 1) + '\n'); return; }
  const L = [];
  L.push('OFF-PEAK PROOF for ' + r.day + ' (read at ' + r.at + ')');
  L.push('');
  L.push('(a) routine clocks, off-peak with the margin' + (r.clocks.named ? ' (named in offpeakHold.proofClocks):' : ' (every movable DeepSeek clock):'));
  for (const c of r.clocks.rows) L.push('  ' + (c.ok ? 'ok  ' : 'FAIL') + '  ' + c.name.padEnd(20) + ' ' + String(c.at || '—').padEnd(6) + (c.now ? ' (asked ' + c.now + ')' : '') + '  ' + c.why);
  for (const x of r.clocks.extra || []) L.push('  ' + (r.clocks.named ? 'warn' : 'FAIL') + '  ' + x.name.padEnd(20) + ' ' + x.at + '  inside the peak margin' + (r.clocks.named ? ' — not on the named list, not a proof failure' : ''));
  if (!r.clocks.named && !(r.clocks.extra || []).length) L.push('  ok    no movable DeepSeek clock is inside a peak block');
  L.push('');
  L.push('(b) DeepSeek wakes held inside a peak block, and where they ran:');
  if (!r.held.length) L.push('  none yet on this day');
  for (const h of r.held) {
    L.push('  held  ' + h.loop + ' (' + h.agent + ') at ' + h.at + ' in ' + h.block + ' → until ' + h.until);
    L.push('        reason: ' + h.why);
    L.push('        ran:    ' + (h.ran ? h.ranAt + '  ' + h.model + '  $' + Number(h.usd || 0).toFixed(6) + (h.insidePeak ? '  INSIDE THE PEAK' : '  in the cheap window') : 'not yet'));
    if (h.runsBefore && h.runsBefore.length) L.push('        UNEXPLAINED DeepSeek run(s) during the hold: ' + h.runsBefore.length + ' — ' + h.runsBefore.map(x => x.at).join(', '));
    if (!h.ran && h.ranOtherLane) L.push('        next run was on another lane: ' + h.ranOtherLane + ' — not DeepSeek-billed, so it neither proves nor breaks the hold');
    if (h.providerFailed && h.providerFailed.length) L.push('        ' + h.providerFailed.length + ' DeepSeek attempt(s) refused by the provider (0 tokens, billing/402) from the hold on: ' + h.providerFailed.slice(0, 6).join(', ') + (h.providerFailed.length > 6 ? ', …' : '') + ' — not a run, not a failed hold');
    if (h.released) L.push('        released by the pacer before the window closed (kind=release row); a run after it is not a failed hold');
    if (h.otherLane) L.push('        ' + h.otherLane + ' run(s) on another lane (MiniMax / subscription) in the hold interval: not peak-billed');
  }
  for (const f of r.falseDrops || []) L.push('  note  a DEFERRED DROP row for ' + f.loop + ' was written, but the ledger shows it ran at ' + f.at + ' — an early drop row, not a lost wake');
  L.push('');
  const c = cfg();
  L.push('(c) ledger split for ' + r.day + ' (peak+margin = ' + (c.known ? c.blocks.map(([a, b]) => hhmm(a - c.marginMin) + '–' + hhmm(b + c.marginMin)).join(' and ') + ' ' + c.timezone : 'no peak hours configured') + '):');
  const s = r.split;
  L.push('  DeepSeek  inside: ' + String(s.deepseek.inside.runs).padStart(3) + ' run(s)  $' + s.deepseek.inside.usd.toFixed(6));
  L.push('  DeepSeek  outside:' + String(s.deepseek.outside.runs).padStart(3) + ' run(s)  $' + s.deepseek.outside.usd.toFixed(6));
  L.push('  all rows  inside: ' + String(s.all.inside.runs).padStart(3) + ' run(s)  $' + s.all.inside.usd.toFixed(6));
  L.push('  all rows  outside:' + String(s.all.outside.runs).padStart(3) + ' run(s)  $' + s.all.outside.usd.toFixed(6));
  L.push('  day total:        ' + String(s.total.runs).padStart(3) + ' run(s)  $' + s.total.usd.toFixed(6));
  L.push('');
  if (r.problems.length) { L.push('FAILED:'); for (const p of r.problems) L.push('  - ' + p); }
  if (r.pending.length) { L.push('NOT YET:'); for (const p of r.pending) L.push('  - ' + p); }
  if (r.ok) L.push('OFF-PEAK PROOF: COMPLETE — every clause has its record.');
  else L.push('OFF-PEAK PROOF: ' + (r.failed ? 'FAILED' : 'NOT YET') + ' — see the lines above.');
  process.stdout.write(L.join('\n') + '\n');
}

function stationJobs(cb) {
  let tok = ''; try { tok = co.stationToken(); } catch (e) { return cb(e); }
  const u = new URL(co.STATION_URL + '/api/cron');
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { 'x-starnet-token': tok }, timeout: 15000 }, (res) => {
    let body = ''; res.on('data', d => { body += d; });
    res.on('end', () => { try { cb(null, (JSON.parse(body).jobs) || []); } catch (e) { cb(e); } });
  });
  req.on('error', e => cb(e));
  req.on('timeout', () => { req.destroy(new Error('timed out')); });
  req.end();
}

function arg(argv, k) { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; }

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node company/tools/offpeak-proof.js [--date YYYY-MM-DD] [--json] [--journal F] [--ledger F] [--file <saved /api/cron body>] [--at ISO] [--selftest]\n'); return 0; }
  const opts = { json: argv.includes('--json') };
  const dayArg = arg(argv, '--date');
  const atArg = arg(argv, '--at');
  const at = atArg ? Date.parse(atArg) : Date.now();
  if (!isNum(at)) { process.stderr.write('offpeak-proof: --at is not a date\n'); return 2; }
  const day = dayArg || localDay(at);
  const journalPath = arg(argv, '--journal') || path.join(ROOT, REL.journal);
  const ledgerPath = arg(argv, '--ledger') || path.join(ROOT, REL.ledger);
  const journal = readJsonl(journalPath);
  const ledger = readJsonl(ledgerPath);
  const build = (jobs) => {
    const r = analyse({ day, at, jobs, records: { journal, ledger }, ledgerPath: REL.ledger });
    report(r, opts);
    return r.ok ? 0 : (r.failed ? 2 : 1);
  };
  const f = arg(argv, '--file');
  if (f) { let jobs; try { jobs = JSON.parse(fs.readFileSync(f, 'utf8')).jobs; } catch (e) { process.stderr.write('offpeak-proof: cannot read ' + f + ': ' + e.message + '\n'); return 2; } return build(jobs); }
  stationJobs((err, jobs) => {
    if (err) { process.stderr.write('offpeak-proof: cannot read the station (/api/cron): ' + err.message + '\n'); process.exit(2); }
    process.exit(build(jobs));
  });
  return null;
}

if (require.main === module) { const c = main(process.argv.slice(2)); if (typeof c === 'number') process.exit(c); }
module.exports = { analyse, clockRows, holds, ranOutside, split, inPeakAt, clearance, namedClocks };
