'use strict';
/* pacing-ask.js (lib) — the subscription cutoffs are the owner's decisions: the pacer asks instead of deciding alone.
 *
 * The cutoffs live in company/work/finance/pacing-policy.json, per subscription (claude, minimax):
 *   weekCloseAtUsedPct  the weekly stop: routines never use the account past it
 *   useNowPct           0 = spread evenly (today's line is k x the daily share), 100 = use it now (today's line is the
 *                       weekly stop); in between, the line sits that far from the even line towards the stop
 *   ownerSet            the owner's last decision {at, by, via, choice, weekStop, useNow, usedPct, cause, weekStart}
 *   changes[]           every recorded change {at, by, what, why}
 *
 * tick() runs inside the pacer's dispatcher tick (pacer.js hookLocked, live mode only):
 *  1. an answered pacer question is applied through setLimit() (the same recorded path as `pacer.js limit`), so the
 *     new numbers take effect on the next tick;
 *  2. when a cutoff holds seats or moves routines off a subscription, and the owner has not set that subscription's
 *     cutoff this week, it files ONE owner question (company/pm-inbox.jsonl, Today): two sliders (the weekly stop, from
 *     what is used now to 100%, suggested = the policy's value; and spread evenly vs use it now) and three buttons (Set,
 *     Keep paused, Use another model meanwhile). Deduped by subscription and week: it asks again only when the
 *     situation changes materially (the cause moves from today's line to the weekly stop, or the week rises by
 *     MATERIAL_PTS points since the last ask or answer). One open pacer question at a time.
 *  3. Self-governance (company/state/governance.json, category "budget"): at auto or notify the company decides pacing
 *     alone, so the question is a non-blocking FYI (the pacer keeps its current cutoffs) plus one plain line in the
 *     owner's daily digest (lib/governance.js fyi); at approve (or triage) it is a blocking question and the cutoffs stay
 *     as they are until the owner answers.
 * The owner reads plain words only; the file, tool and settings page it is recorded in are under "Technical details
 * (for the crew)".
 *
 * setLimit() is the only writer of these keys: an atomic write, a provenance record (locked-watch.js accepts it as
 * pacer.js's own write) and a dispatch-log line.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const POLICY_REL = 'company/work/finance/pacing-policy.json';
const DEFAULT_REL = 'company/defaults/work/finance/pacing-policy.json';
const SUBS = { claude: { provider: 'claude-cli', name: 'Claude' }, minimax: { provider: 'custom', name: 'MiniMax' } };
const MATERIAL_PTS = 15;
const ABOUT = key => 'pacing:' + key;

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function readPolicy(root) { return readJson(path.join(root, POLICY_REL), null) || readJson(path.join(root, DEFAULT_REL), null) || {}; }
function writePolicy(root, pol) {
  const f = path.join(root, POLICY_REL); fs.mkdirSync(path.dirname(f), { recursive: true });
  const txt = JSON.stringify(pol, null, 1) + '\n'; const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('../provenance.js').wrote(f, txt, 'pacer.js'); } catch (_) {}   // locked-watch.js: the pacer's own write
}
function dispatchLog(root, line) {
  try { const lp = co.localParts(); fs.appendFileSync(path.join(root, 'company', 'work', 'dispatch-log.md'), '- ' + lp.date + ' ' + lp.time + ' ' + line + '\n'); } catch (_) {}
}
const ownerName = () => (co.config.owner && co.config.owner.name) || 'owner';
const isOwner = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === 'commander' || b === ownerName().toLowerCase()); };
const f1 = n => String(Math.round(Number(n) * 10) / 10);
function when(ms) {
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: co.TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms)).replace(' at ', ' '); } catch (_) { return new Date(ms).toISOString(); }
}
// with the inbox file of `root` (a scratch company in tests; the live one otherwise)
function withInbox(root, fn) {
  const prev = process.env.PM_INBOX_FILE; process.env.PM_INBOX_FILE = path.join(root, 'company', 'pm-inbox.jsonl');
  try { return fn(require('../inbox.js')); } finally { if (prev === undefined) delete process.env.PM_INBOX_FILE; else process.env.PM_INBOX_FILE = prev; }
}
function govLevel(root, opts) { try { return require('./governance.js').level('budget', Object.assign({ root }, opts || {})); } catch (_) { return 'approve'; } }
const companyDecides = lv => lv === 'auto' || lv === 'notify';

/* authorize(root, by) -> null (may set) or {code, error}. The owner always; the CEO or the finance seat only while
 * self-governance gives pacing ("budget") to the company. An agent's run may not claim to be the owner. */
function authorize(root, by, opts) {
  if (!by) return { code: 2, error: '--by is required' };
  if (isOwner(by)) {
    // the one owner rule (lib/owner.js); trustOwner: the dispatcher relaying the owner's own answer on Today
    const ownerHere = opts && typeof opts.ownerShell === 'function' ? opts.ownerShell() : require('./owner').shell();
    if (!ownerHere && !(opts && opts.trustOwner)) return { code: 3, error: 'an agent\'s run may not set a cutoff as the owner; ask the owner (the pacer files the question on Today)' };
    return null;
  }
  const loops = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  const seat = Object.values(loops).find(a => a && String(a.name || '').toLowerCase().split(/\s+/)[0] === String(by).toLowerCase().split(/\s+/)[0]);
  const fns = (seat && seat.functions) || [];
  if (!fns.includes('ceo') && !fns.includes('finance')) return { code: 3, error: by + ' may not change a subscription cutoff (the owner may; the CEO or finance seat only when self-governance gives budget to the company)' };
  const lv = govLevel(root, opts);
  if (!companyDecides(lv)) return { code: 3, error: 'budget is at "' + lv + '" in self-governance: the subscription cutoffs are the owner\'s decision (the pacer asks on Today)' };
  return null;
}

/* setLimit(root, key, {weekStop?, useNow?, by, why, via?, choice?, situation?, at?}) -> {ok, key, was, now, what}
 * The one recorded write of a subscription cutoff. No numbers = the decision is recorded as it is (Keep paused). */
function setLimit(root, key, o) {
  o = o || {};
  if (!SUBS[key]) return { ok: false, code: 2, error: 'which subscription: ' + Object.keys(SUBS).join(' or ') };
  const by = String(o.by || '').trim(), why = String(o.why || '').trim();
  if (!by || !why) return { ok: false, code: 2, error: '--by and --why are required' };
  const num = (v, lo, hi, what) => { if (v === undefined || v === null || v === '' || v === true) return undefined; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(what + ' must be a number from ' + lo + ' to ' + hi); return Math.round(n * 10) / 10; };
  let weekStop, useNow;
  try { weekStop = num(o.weekStop, 1, 100, '--week-stop'); useNow = num(o.useNow, 0, 100, '--use-now'); } catch (e) { return { ok: false, code: 2, error: e.message }; }
  const pol = readPolicy(root); pol[key] = pol[key] && typeof pol[key] === 'object' ? pol[key] : {};
  const s = pol[key];
  const was = { weekStop: Number.isFinite(Number(s.weekCloseAtUsedPct)) ? Number(s.weekCloseAtUsedPct) : (key === 'claude' ? 95 : 100), useNow: Number.isFinite(Number(s.useNowPct)) ? Number(s.useNowPct) : 0 };
  const what = [];
  if (weekStop !== undefined && weekStop !== was.weekStop) { s.weekCloseAtUsedPct = weekStop; what.push('week stop ' + was.weekStop + '% -> ' + weekStop + '%'); }
  if (useNow !== undefined && useNow !== was.useNow) { s.useNowPct = useNow; what.push('use-now ' + was.useNow + '% -> ' + useNow + '%'); }
  const at = new Date(o.at || Date.now()).toISOString(); const sit = o.situation || {};
  const choice = o.choice || (what.length ? 'set' : 'keep');
  const nowV = { weekStop: weekStop !== undefined ? weekStop : was.weekStop, useNow: useNow !== undefined ? useNow : was.useNow };
  const dec = { at, by, why, via: o.via || 'pacer.js limit', choice, weekStop: nowV.weekStop, useNow: nowV.useNow };
  for (const k of ['usedPct', 'cause', 'weekStart']) if (sit[k] !== undefined) dec[k] = sit[k];
  if (isOwner(by)) s.ownerSet = dec; else s.companySet = dec;
  const line = what.length ? what.join(', ') : 'kept as it is (' + choice + ')';
  pol.changes = (Array.isArray(pol.changes) ? pol.changes : []).concat([{ at, by, what: SUBS[key].name + ' ' + line, why }]).slice(-50);
  writePolicy(root, pol);
  dispatchLog(root, 'PACER LIMIT ' + SUBS[key].name + ': ' + line + ' by ' + by + ': ' + why);
  return { ok: true, key, was, now: nowV, what: line, choice };
}

/* the cutoff situation of one subscription on this tick, or null when no cutoff is holding or moving anything */
function situation(m, pl, holds, key, root) {
  const g = m && m[key]; const sub = SUBS[key];
  if (!g || !g.known || g.open || g.hard || g.paceBy === 'fiveHour' && !(g.usedPct >= g.weekCap)) return null;
  // held: nothing in the seat's chain is open, and this subscription is one of the closed links (its row's why says so)
  const held = (holds || []).filter(h => h && (h.provider === sub.provider || String(h.why || '').includes(sub.name + ' closed'))).map(h => h.name);
  const moved = ((pl && pl.rows) || []).filter(r => r && r.now && r.now.provider === sub.provider && r.to && r.to.provider !== sub.provider && r.action !== 'stay').map(r => r.name);
  if (!held.length && !moved.length) return null;
  const pol = readPolicy(root)[key] || {};
  return { key, provider: sub.provider, name: sub.name, usedPct: g.usedPct, line: g.line, weekCap: g.weekCap, useNow: Number(pol.useNowPct) || 0,
    weekStart: g.weekStart, weekEnd: g.weekEnd, cause: g.usedPct >= g.weekCap ? 'stop' : 'line', held, moved };
}
const material = (a, sit) => !a || a.cause !== sit.cause || sit.usedPct - Number(a.usedPct || 0) >= MATERIAL_PTS;

/* the question: plain message first, numbers in the details, two sliders, three buttons */
function questionFor(sit, fyi) {
  const used = Math.round(sit.usedPct), reset = when(sit.weekEnd);
  const paused = sit.cause === 'stop' ? 'The company\'s routines have stopped on ' + sit.name + ': they reached the weekly stop of ' + sit.weekCap + '%.'
    : 'The company\'s routines are paused on ' + sit.name + ' for today.';
  const message = fyi
    ? sit.name + ' is ' + used + '% used this week and resets ' + reset + '. ' + paused + ' You let the company decide pacing, so it keeps its current cutoffs; move the sliders and press Set if you want something else.'
    : sit.name + ' is ' + used + '% used this week and resets ' + reset + '. ' + paused + ' How much of this week\'s ' + sit.name + ' may routines use?';
  const who = sit.held.length ? 'Waiting for ' + sit.name + ': ' + sit.held.join(', ') + '.' : '';
  const off = sit.moved.length ? 'Moved off ' + sit.name + ': ' + sit.moved.join(', ') + '.' : '';
  const details = ['Used this week: ' + Math.round(sit.usedPct) + '%. Allowed by today: ' + Math.round(sit.line) + '%. Weekly stop: ' + sit.weekCap + '%. It resets ' + reset + '.',
    who, off, '"Use another model meanwhile" asks the crew to let these seats work on another AI until ' + sit.name + ' is free again.'].filter(Boolean).join('\n');
  const technical = ['Week used: ' + f1(sit.usedPct) + '%. Today\'s line: ' + f1(sit.line) + '% (' + (sit.useNow ? sit.useNow + '% of the way to using it now' : 'spread evenly over the week') + '). Weekly stop: ' + sit.weekCap + '%. Cause: ' + (sit.cause === 'stop' ? 'the weekly stop' : 'today\'s line') + '.',
    '"Use another model meanwhile" hands the people seat a fallback link for each seat\'s model chain (Settings › Models and subscriptions: console:#/settings/models).',
    'The answer is recorded in ' + POLICY_REL + ' through pacer.js limit and takes effect on the next dispatcher tick.'].join('\n');
  const min = Math.min(100, Math.max(1, Math.ceil(sit.usedPct)));
  const stop = Math.min(100, Math.max(min, Math.round(sit.weekCap)));
  const form = { fields: [
    { id: 'weekstop', type: 'slider', label: 'Weekly stop for routines', min, max: 100, step: 1, value: stop, unit: '%', say: 'Let routines use up to {value}% of this week\'s ' + sit.name,
      minLabel: 'What is used now (' + min + '%)', maxLabel: 'All of it (100%)', marks: min < sit.weekCap && sit.weekCap < 100 ? [{ value: stop, label: 'now ' + stop + '%' }] : undefined, required: true },
    { id: 'usenow', type: 'slider', label: 'Spread evenly or use it now', min: 0, max: 100, step: 10, value: Math.round(sit.useNow / 10) * 10, unit: '%',
      say: '{value}% of the way from an even share each day to using it all now', sayAt: { 0: 'Spread evenly: an even share of the week each day', 100: 'Use it now: routines may go up to the weekly stop today' }, minLabel: 'Spread evenly', maxLabel: 'Use it now', required: false },
  ], actions: [
    { id: 'set', label: 'Set', verdict: 'submit', primary: true },
    { id: 'keep', label: 'Keep paused', verdict: 'no', needs: 'none' },
    { id: 'other', label: 'Use another model meanwhile', verdict: 'done', needs: 'none' },
  ] };
  return { message, details, technical, form };
}

function openPacerQuestion(root) {
  return withInbox(root, ib => ib.openQuestions().find(q => String(q.about || '').startsWith('pacing:')) || null);
}
function peopleInbox(root) {
  const loops = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  const v = Object.values(loops); const pick = v.find(a => a && (a.functions || []).includes('people')) || v.find(a => a && (a.functions || []).includes('ceo'));
  return pick && /^[A-Za-z0-9_.-]+\.md$/.test(String(pick.inbox || '')) ? pick : null;
}
function handoffOther(root, sit, qid) {
  const p = peopleInbox(root); if (!p) return null;
  const names = sit.held.concat(sit.moved);
  const block = '\n## ' + new Date().toISOString().slice(0, 10) + ' from Pacer — give ' + (names.join(', ') || 'the held seats') + ' a model to use while ' + sit.name + ' is paused\n' +
    '**Need:** add a fallback link to each seat\'s model chain (node company/tools/models.js, or Crew > seat > Model) so it can work while ' + sit.name + ' is paused for routines; the owner chose "Use another model meanwhile" (' + qid + ').\n' +
    '**Why:** ' + sit.name + ' is ' + Math.round(sit.usedPct) + '% used this week; these seats have nothing else open in their chain.\n**Deadline:** today\n**Status:** OPEN\n**Evidence:** company/pm-inbox.jsonl ' + qid + ', company/work/finance/ai-usage.md\n';
  const f = path.join(root, 'company', 'work', 'handoffs', p.inbox); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, block);
  return p.name;
}

/* apply one answered question; returns a log line */
function applyAnswer(root, key, rec, row) {
  const ans = row.answer || {}; const v = ans.values || {};
  const sit = Object.assign({ name: SUBS[key].name, held: [], moved: [] }, rec.situation || {});
  const base = { by: ownerName(), via: rec.qid, situation: { usedPct: rec.usedPct, cause: rec.cause, weekStart: rec.weekStart } };
  if (ans.action === 'set') {
    const r = setLimit(root, key, Object.assign(base, { weekStop: v.weekstop, useNow: v.usenow, choice: 'set', why: 'the owner\'s answer to ' + rec.qid + ' on Today' }));
    return r.ok ? 'PACER LIMIT applied ' + rec.qid + ': ' + r.what : 'PACER LIMIT NOT applied ' + rec.qid + ': ' + r.error;
  }
  if (ans.action === 'other') {
    const r = setLimit(root, key, Object.assign(base, { choice: 'other-model', why: 'the owner\'s answer to ' + rec.qid + ': use another model meanwhile' }));
    const to = handoffOther(root, sit, rec.qid);
    return 'PACER LIMIT ' + rec.qid + ': cutoffs kept; another model meanwhile' + (to ? ' (handoff to ' + to + ')' : '') + (r.ok ? '' : ' — ' + r.error);
  }
  const r = setLimit(root, key, Object.assign(base, { choice: ans.verdict === 'reply' ? 'reply' : 'keep', why: 'the owner\'s answer to ' + rec.qid + ': ' + (ans.verdict === 'reply' ? 'a reply in words (sent to the company)' : 'keep paused') }));
  return 'PACER LIMIT ' + rec.qid + ': ' + (ans.verdict === 'reply' ? 'the owner replied in words; cutoffs kept' : 'keep paused') + (r.ok ? '' : ' — ' + r.error);
}

/* tick({root, m, pl, holds, st, live, dry, log, govOpts}) -> {applied: [...], asked: qid|null, fyi: bool} — never throws */
function tick(a) {
  const out = { applied: [], asked: null, fyi: false };
  const log = typeof a.log === 'function' ? a.log : () => {};
  const root = a.root || co.ROOT; const st = a.st || {};
  st.limitAsks = st.limitAsks && typeof st.limitAsks === 'object' ? st.limitAsks : {};
  if (a.dry) return out;
  // 1. answers
  for (const [key, rec] of Object.entries(st.limitAsks)) {
    if (!rec || rec.status !== 'open' || !rec.qid) continue;
    const row = withInbox(root, ib => ib.state()[rec.qid]);
    if (!row) { rec.status = 'gone'; continue; }
    if (row.reclassified || (row.type === 'close' && !row.a)) { rec.status = 'closed'; continue; }
    if (!row.a) continue;
    const line = applyAnswer(root, key, rec, row); rec.status = 'answered'; rec.answeredAt = new Date().toISOString();
    out.applied.push(rec.qid); log(line);
  }
  if (!a.live) return out;
  // 2. ask, once, when a cutoff holds or moves something and the owner has not set it this week
  if (openPacerQuestion(root)) return out;   // one open pacer question at a time
  const pol = readPolicy(root);
  for (const key of Object.keys(SUBS)) {
    const sit = situation(a.m, a.pl, a.holds, key, root); if (!sit) continue;
    const os = (pol[key] || {}).ownerSet;
    if (os && Date.parse(os.at) >= sit.weekStart && !material(os, sit)) continue;   // the owner decided this week
    const prev = st.limitAsks[key];
    if (prev && prev.weekStart === sit.weekStart && !material(prev, sit)) continue;   // asked this week; nothing changed
    const fyi = companyDecides(govLevel(root, a.govOpts));
    const q = questionFor(sit, fyi);
    const r = withInbox(root, ib => ib.ask({ scopeExempt: 'framework', from: 'Pacer', about: ABOUT(key), message: q.message, details: q.details, technical: q.technical, blocking: !fyi, form: q.form, batch: fyi ? 'fyi' : null }));
    st.limitAsks[key] = { qid: r.row.id, status: 'open', at: new Date().toISOString(), weekStart: sit.weekStart, usedPct: sit.usedPct, cause: sit.cause, fyi,
      situation: { name: sit.name, held: sit.held, moved: sit.moved, usedPct: sit.usedPct, cause: sit.cause, weekStart: sit.weekStart } };
    if (fyi) {
      try { require('./governance.js').fyi({ from: 'Pacer', text: 'FYI: ' + sit.name + ' is ' + Math.round(sit.usedPct) + '% used this week, so routines are paused on it under the current limits. You can change them on Today.', technical: 'Pacer question ' + r.row.id + ' (non-blocking: budget is the company\'s in self-governance).', key: ABOUT(key) + ':' + sit.weekStart }, { root }); } catch (_) {}
    }
    log('PACER ASK ' + r.row.id + (fyi ? ' (FYI: budget is the company\'s)' : ' (waits for the owner)') + ': ' + sit.name + ' ' + f1(sit.usedPct) + '% used, cause ' + (sit.cause === 'stop' ? 'the weekly stop' : 'today\'s line') + '; ' + (sit.held.length + sit.moved.length) + ' seat(s) affected');
    out.asked = r.row.id; out.fyi = fyi;
    break;   // one question at a time
  }
  return out;
}

/* view(m, pl, jobs, root) — what Settings shows per subscription: usage, reset, the two cutoffs, affected seats */
function view(m, pl, jobs, root) {
  const pol = readPolicy(root); const out = {};
  let seats = {}; try { seats = (readJson(path.join(root, 'company', 'model-policy.json'), {}) || {}).seats || {}; } catch (_) {}
  const loops = (readJson(path.join(root, 'company', 'tools', 'loops.json'), {}) || {}).agents || {};
  for (const [key, sub] of Object.entries(SUBS)) {
    const g = (m && m[key]) || {}; const p = pol[key] || {};
    const routines = ((pl && pl.rows) || []).filter(r => r && ((r.now && r.now.provider === sub.provider) || (r.to && r.to.provider === sub.provider))).map(r => r.name);
    const chained = Object.entries(seats).filter(([k, s]) => !k.startsWith('_') && s && Array.isArray(s.chain) && s.chain.some(c => c && c.provider === sub.provider)).map(([k]) => (loops[k] && loops[k].name) || k);
    out[key] = { name: sub.name, known: !!g.known, open: !!g.open, why: g.why || '', usedPct: g.usedPct, line: g.line, normalLine: g.normalLine, resetsAt: g.weekEnd || null,
      weekStop: Number.isFinite(Number(p.weekCloseAtUsedPct)) ? Number(p.weekCloseAtUsedPct) : (key === 'claude' ? 95 : 100), useNow: Number(p.useNowPct) || 0,
      paceBy: p.paceBy || 'week', affected: Array.from(new Set(chained.concat(routines))), ownerSet: p.ownerSet || null, companySet: p.companySet || null };
  }
  out.level = govLevel(root);
  return out;
}

module.exports = { tick, setLimit, authorize, situation, questionFor, view, readPolicy, SUBS, MATERIAL_PTS, POLICY_REL };
