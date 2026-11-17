'use strict';
/* money-hold.js (lib) — a money hold that keeps a seat from its work is the owner's decision, not a log line.
 *
 * The dispatcher holds a metered seat for money in two ways: the daily metered cap (dispatch-budget.json dailyUsd) and,
 * in Sprint, the spread of that cap over the company day (lib/sprint.js spreadHold). Each used to be one dispatch-log
 * line per tick and nothing else, so the owner saw work waiting and agents idle with no reason and no way to choose.
 *
 * tick() runs once per dispatcher tick (dispatch.js, live mode only):
 *  1. an answered money question is applied through set() (the same recorded path as `money-hold.js set`), so it takes
 *     effect on the next tick;
 *  2. it keeps, per seat, how many ticks in a row it was held for money (st.moneyHolds); a seat held for MORE than one
 *     tick gets ONE owner question (company/pm-inbox.jsonl, Today): the plain situation and who waits on the seat, a
 *     slider for today's metered budget and three buttons — "Let it run now" (the spread is off for today), "Raise
 *     today's budget" and "Keep spreading" ("Keep it paused" for the cap). One open money question at a time; per kind
 *     it asks at most once a company day, and not at all after the owner answered that kind today.
 *  3. self-governance (company/state/governance.json, category "budget"): at auto or notify the company decides, so the
 *     question is a non-blocking FYI (the hold stays as it is) plus one owner sentence; at approve (or triage) it is a
 *     blocking question and the hold stays until the owner answers.
 *
 * The owner's answer: "Let it run now" goes through `cadence.js sprint config --spread today` (setSprintConfig: the
 * spread is off until local midnight, recorded in cadence.json like every Sprint setting); "Raise today's budget" lives
 * in company/work/finance/today-budget.json, valid for one company day only:
 *   { day, dailyUsd?, by, at, via, choice, why, changes[] }   (every choice, "keep" too, is a changes[] row there)
 * set() is that file's only writer: an atomic write, a provenance record (locked-watch.js accepts it as money-hold.js's
 * own write), a changes[] row and a dispatch-log line. capToday() is what dispatch.js reads.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const TODAY_REL = 'company/work/finance/today-budget.json';
const ABOUT = kind => 'money-hold:' + kind;
const KINDS = { spread: 'the spread of today\'s budget', cap: 'today\'s metered budget' };

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
const dayOf = ms => co.localParts(new Date(ms == null ? Date.now() : ms)).date;
function readToday(root, now) {
  const t = readJson(path.join(root || co.ROOT, TODAY_REL), null);
  return t && t.day === dayOf(now) ? t : null;
}
/* the daily cap the dispatcher holds against today: the owner's raised number for today, else the budget file's */
function capToday(root, base, now) { const t = readToday(root, now); return t && Number.isFinite(Number(t.dailyUsd)) && Number(t.dailyUsd) >= 0 ? Number(t.dailyUsd) : base; }
function dispatchLog(root, line) {
  try { const lp = co.localParts(); fs.appendFileSync(path.join(root, 'company', 'work', 'dispatch-log.md'), '- ' + lp.date + ' ' + lp.time + ' ' + line + '\n'); } catch (_) {}
}
const ownerName = () => (co.config.owner && co.config.owner.name) || 'owner';
const isOwner = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === 'commander' || b === ownerName().toLowerCase()); };
function govLevel(root, opts) { try { return require('./governance.js').level('budget', Object.assign({ root }, opts || {})); } catch (_) { return 'approve'; } }
const companyDecides = lv => lv === 'auto' || lv === 'notify';
function withInbox(root, fn) {
  const prev = process.env.PM_INBOX_FILE; process.env.PM_INBOX_FILE = path.join(root, 'company', 'pm-inbox.jsonl');
  try { return fn(require('../inbox.js')); } finally { if (prev === undefined) delete process.env.PM_INBOX_FILE; else process.env.PM_INBOX_FILE = prev; }
}
const usd = n => '$' + (Math.round(Number(n) * 100) / 100).toFixed(2).replace(/\.00$/, '');
const list = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

/* authorize(root, by) -> null (may set) or {code, error}: the owner (not from an agent's run); the CEO or finance seat
 * only while self-governance gives budget to the company. */
function authorize(root, by, opts) {
  if (!by) return { code: 2, error: '--by is required' };
  if (isOwner(by)) {
    let under = false; try { under = require('../provenance.js').underStation(); } catch (_) {}
    if (under && !(opts && opts.trustOwner)) return { code: 3, error: 'an agent\'s run may not answer for the owner; the dispatcher asks the owner on Today' };
    return null;
  }
  const loops = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  const seat = Object.values(loops).find(a => a && String(a.name || '').toLowerCase().split(/\s+/)[0] === String(by).toLowerCase().split(/\s+/)[0]);
  const fns = (seat && seat.functions) || [];
  if (!fns.includes('ceo') && !fns.includes('finance')) return { code: 3, error: by + ' may not change today\'s budget (the owner may; the CEO or finance seat only when self-governance gives budget to the company)' };
  if (!companyDecides(govLevel(root, opts))) return { code: 3, error: 'budget is at "' + govLevel(root, opts) + '" in self-governance: today\'s budget is the owner\'s decision (the dispatcher asks on Today)' };
  return null;
}

/* set(root, {choice: 'run'|'raise'|'keep', dailyUsd?, by, why, via?, now?}) -> {ok, what} — the one recorded write */
function set(root, o) {
  o = o || {}; root = root || co.ROOT;
  const by = String(o.by || '').trim(), why = String(o.why || '').trim();
  if (!by || !why) return { ok: false, code: 2, error: '--by and --why are required' };
  const choice = ['run', 'raise', 'keep'].includes(o.choice) ? o.choice : null;
  if (!choice) return { ok: false, code: 2, error: 'say what: run (the spread is off for today), raise --budget <usd>, or keep' };
  const now = Number(o.now) || Date.now(); const day = dayOf(now);
  const f = path.join(root, TODAY_REL);
  const prev = readJson(f, null) || {};
  const cur = prev.day === day ? Object.assign({}, prev) : { day };
  const what = [];
  if (choice === 'run') {   // the same recorded path as the owner's `cadence.js sprint config --spread today`
    try { require('../cadence.js').setSprintConfig({ by, why, spread: 'today' }); what.push('the spread is off until midnight (cadence.js sprint config --spread today)'); }
    catch (e) { if (!/nothing to set/.test(e.message)) return { ok: false, code: e.refused ? 3 : 1, error: e.message }; what.push('the spread was already off for today'); }
  }
  if (choice === 'raise') {
    const n = Number(o.dailyUsd);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return { ok: false, code: 2, error: '--budget is dollars from 0 to 10000' };
    const r = Math.round(n * 100) / 100; what.push('today\'s metered budget ' + (cur.dailyUsd != null ? usd(cur.dailyUsd) + ' -> ' : '') + usd(r)); cur.dailyUsd = r;
  }
  if (choice === 'keep') what.push('kept as it is');
  const at = new Date(now).toISOString();
  Object.assign(cur, { by, at, via: o.via || 'money-hold.js set', choice, why });
  cur.changes = (Array.isArray(prev.changes) ? prev.changes : []).concat([{ at, by, what: what.join(', ') || 'no change', why, via: cur.via }]).slice(-30);
  cur._doc = 'The owner\'s money decisions for ONE company day (lib/money-hold.js): dailyUsd replaces dispatch-budget.json dailyUsd for today; choice is the last answer (run = the spread is off until midnight, through cadence.js). Written only by money-hold.js set.';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const txt = JSON.stringify(cur, null, 1) + '\n'; const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('../provenance.js').wrote(f, txt, 'money-hold.js'); } catch (_) {}
  dispatchLog(root, 'MONEY HOLD ' + (what.join(', ') || 'no change') + ' by ' + by + ': ' + why);
  return { ok: true, what: what.join(', ') || 'no change', choice, today: cur };
}

/* the question: plain message first, numbers in the details, a slider for today's budget, three buttons */
function questionFor(sit, fyi) {
  const who = sit.waiting && sit.waiting.length ? ' ' + list(sit.waiting) + (sit.waiting.length > 1 ? ' are' : ' is') + ' waiting on ' + (sit.names.length > 1 ? 'them' : 'it') + '.' : '';
  const names = list(sit.names);
  const head = sit.kind === 'spread'
    ? names + (sit.names.length > 1 ? ' are' : ' is') + ' paused so today\'s ' + usd(sit.cap) + ' lasts until midnight.'
    : names + (sit.names.length > 1 ? ' are' : ' is') + ' paused: the company has spent today\'s ' + usd(sit.cap) + ' metered budget.';
  const message = head + who + (fyi ? ' You let the company decide budget, so it keeps it this way; pick something else if you want.' : '');
  const details = [
    'Metered spend in the last 24 h: ' + usd(sit.spent) + ' of ' + usd(sit.cap) + (sit.kind === 'spread' ? '. Last hour: ' + usd(sit.lastHour) + ', allowance ' + usd(sit.allowance) + ' (Sprint spreads what is left over the hours left today).' : '.'),
    'Held for ' + sit.ticks + ' ticks in a row' + (sit.since ? ' since ' + String(co.localParts(new Date(sit.since)).time) : '') + '. Subscription seats (Claude, MiniMax) are not affected.',
    '"Let it run now" turns the spread off for today only; "Raise today\'s budget" sets today\'s metered budget to the slider (today only; your daily number in Settings stays). Recorded in ' + TODAY_REL + ' through money-hold.js set; it takes effect on the next dispatcher tick.',
  ].join('\n');
  const min = Math.max(0, Math.ceil(Number(sit.cap) || 0));
  const max = Math.max(min + 5, Math.ceil((Number(sit.cap) || 1) * 4));
  const value = Math.min(max, Math.max(min, Math.ceil(Math.max(Number(sit.cap) * 1.5, Number(sit.spent) + Number(sit.cap) / 2))));
  const form = { fields: [
    { id: 'budget', type: 'slider', label: 'Today\'s metered budget', min, max, step: 1, value, unit: '$', say: 'Let the company spend up to ${value} metered today',
      minLabel: 'Today\'s budget now (' + usd(min) + ')', maxLabel: usd(max), required: false },
  ], actions: (sit.kind === 'spread' ? [{ id: 'run', label: 'Let it run now', verdict: 'yes', primary: true, needs: 'none' }] : []).concat([
    { id: 'raise', label: 'Raise today\'s budget', verdict: 'submit', primary: sit.kind !== 'spread', needs: ['budget'] },
    { id: 'keep', label: sit.kind === 'spread' ? 'Keep spreading' : 'Keep it paused', verdict: 'no', needs: 'none' },
  ]) };
  return { message, details, form };
}

function openMoneyQuestion(root) { return withInbox(root, ib => ib.openQuestions().find(q => String(q.about || '').startsWith('money-hold:')) || null); }

function applyAnswer(root, rec, row) {
  const ans = row.answer || {}; const v = ans.values || {};
  const base = { by: ownerName(), via: rec.qid };
  let r;
  if (ans.action === 'run') r = set(root, Object.assign(base, { choice: 'run', why: 'the owner\'s answer to ' + rec.qid + ' on Today: let it run now' }));
  else if (ans.action === 'raise') r = set(root, Object.assign(base, { choice: 'raise', dailyUsd: v.budget, why: 'the owner\'s answer to ' + rec.qid + ' on Today: raise today\'s budget' }));
  else r = set(root, Object.assign(base, { choice: 'keep', why: 'the owner\'s answer to ' + rec.qid + ': ' + (ans.verdict === 'reply' ? 'a reply in words (sent to the company)' : rec.kind === 'spread' ? 'keep spreading' : 'keep it paused') }));
  return r.ok ? 'MONEY HOLD applied ' + rec.qid + ': ' + r.what : 'MONEY HOLD NOT applied ' + rec.qid + ': ' + r.error;
}

/* tick({root, holds: [{seat, name, kind, waiting: [names]}], spent, cap, lastHour, allowance, st, live, dry, log, govOpts, now})
 *   -> {applied: [...], asked: qid|null, fyi, open: {seatId: qid}} — never throws */
function tick(a) {
  const out = { applied: [], asked: null, fyi: false, open: {} };
  try {
    const log = typeof a.log === 'function' ? a.log : () => {};
    const root = a.root || co.ROOT; const st = a.st || {}; const now = Number(a.now) || Date.now(); const day = dayOf(now);
    st.moneyHolds = st.moneyHolds && typeof st.moneyHolds === 'object' ? st.moneyHolds : {};
    st.moneyAsks = st.moneyAsks && typeof st.moneyAsks === 'object' ? st.moneyAsks : {};
    // held ticks in a row, per seat (a seat not held this tick starts again from zero)
    const held = {};
    for (const h of a.holds || []) {
      if (!h || !h.seat) continue;
      const p = st.moneyHolds[h.seat];
      held[h.seat] = p && p.kind === h.kind ? { kind: h.kind, since: p.since, ticks: (Number(p.ticks) || 0) + 1 } : { kind: h.kind, since: new Date(now).toISOString(), ticks: 1 };
    }
    if (!a.dry) st.moneyHolds = held;
    if (a.dry) return out;
    // 1. answers
    for (const [key, rec] of Object.entries(st.moneyAsks)) {
      if (!rec || rec.status !== 'open' || !rec.qid) continue;
      const row = withInbox(root, ib => ib.state()[rec.qid]);
      if (!row) { rec.status = 'gone'; continue; }
      if (row.reclassified || (row.type === 'close' && !row.a)) { rec.status = 'closed'; continue; }
      if (!row.a) { for (const s of rec.seats || []) out.open[s] = rec.qid; continue; }
      const line = applyAnswer(root, rec, row); rec.status = 'answered'; rec.answeredAt = new Date(now).toISOString();
      out.applied.push(rec.qid); log(line);
    }
    for (const [k, rec] of Object.entries(st.moneyAsks)) if (rec && rec.day && rec.day < day && rec.status !== 'open') delete st.moneyAsks[k];   // yesterday's, settled
    if (!a.live) return out;
    // 2. ask once: the seats held for more than one tick, grouped by kind
    if (openMoneyQuestion(root)) return out;
    for (const kind of Object.keys(KINDS)) {
      const hs = (a.holds || []).filter(h => h && h.kind === kind && held[h.seat] && held[h.seat].ticks >= 2);
      if (!hs.length) continue;
      const key = day + ':' + kind;
      if (st.moneyAsks[key]) continue;   // asked (or answered) about this kind today
      const t = readToday(root, now); if (t && t.choice && (kind === 'spread' || t.choice !== 'run')) continue;   // the owner decided today (readToday is today's only)
      const waiting = Array.from(new Set([].concat(...hs.map(h => h.waiting || []))));
      const first = hs.map(h => held[h.seat]).sort((x, y) => Date.parse(x.since) - Date.parse(y.since))[0];
      const sit = { kind, names: hs.map(h => h.name), waiting, cap: a.cap, spent: a.spent, lastHour: a.lastHour, allowance: a.allowance, ticks: first.ticks, since: first.since };
      const fyi = companyDecides(govLevel(root, a.govOpts));
      const q = questionFor(sit, fyi);
      const r = withInbox(root, ib => ib.ask({ from: 'Dispatcher', about: ABOUT(kind), message: q.message, details: q.details, blocking: !fyi, form: q.form, batch: fyi ? 'fyi' : null }));
      st.moneyAsks[key] = { qid: r.row.id, status: 'open', at: new Date(now).toISOString(), day, kind, fyi, seats: hs.map(h => h.seat) };
      for (const h of hs) out.open[h.seat] = r.row.id;
      if (fyi) { try { require('./governance.js').notify('FYI: ' + q.message.replace(/ You let the company.*$/, '') + ' The company keeps it this way; you can change it on Today (' + r.row.id + ').', { root, from: 'Dispatcher' }); } catch (_) {} }
      log('MONEY HOLD ASK ' + r.row.id + (fyi ? ' (FYI: budget is the company\'s)' : ' (waits for the owner)') + ': ' + list(sit.names) + ' held by ' + KINDS[kind] + ' for ' + sit.ticks + ' ticks' + (waiting.length ? '; waiting on them: ' + list(waiting) : ''));
      out.asked = r.row.id; out.fyi = fyi;
      break;   // one question at a time
    }
  } catch (e) { try { (a.log || (() => {}))('MONEY HOLD ERROR: ' + String(e && e.message || e).slice(0, 200)); } catch (_) {} }
  return out;
}

module.exports = { tick, set, authorize, questionFor, readToday, capToday, TODAY_REL, KINDS };
