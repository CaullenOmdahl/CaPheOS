#!/usr/bin/env node
/* money-hold.js — the owner's answer when money keeps a seat from its work (lib/money-hold.js).
 *
 * The dispatcher asks the owner once on Today when the daily metered cap, or Sprint's spread of it over the day, holds a
 * seat for more than one tick. The answer is applied through this tool's recorded path; the owner can also use it here:
 *
 *   node company/tools/money-hold.js status [--json]                 today's decision and the effective cap
 *   node company/tools/money-hold.js set run   --by owner --why "…"  let it run now: the spread is off until midnight
 *                                                                    (the same write as cadence.js sprint config --spread today)
 *   node company/tools/money-hold.js set raise --budget 8 --by owner --why "…"   today's metered budget, today only
 *   node company/tools/money-hold.js set keep  --by owner --why "…"  record "keep spreading / keep it paused"
 *   node company/tools/money-hold.js selftest
 *
 * Writes company/work/finance/today-budget.json (atomic, provenance, changes[], a dispatch-log line). Only the owner, or the
 * CEO/finance seat while self-governance gives "budget" to the company.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function main(argv) {
  const co = require('./lib/company');
  const MH = require('./lib/money-hold');
  const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0];
  if (cmd === 'selftest' || argv.includes('--selftest')) { try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}   // a selftest measures the mechanism in its own fixture tree, not the caller: an agent's run must not fail it
    return selftest(); }
  if (!cmd || cmd === 'status') {
    const t = MH.readToday(co.ROOT);
    const b = co.readJson(co.p('company', 'work', 'finance', 'dispatch-budget.json'), {}) || {};
    const base = typeof b.dailyUsd === 'number' ? b.dailyUsd : null;
    const out = { ok: true, day: co.localParts().date, baseDailyUsd: base, todayDailyUsd: base == null ? null : MH.capToday(co.ROOT, base), today: t };
    if (argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
    else console.log('today ' + out.day + ': daily metered budget $' + (out.todayDailyUsd ?? '?') + (t && t.dailyUsd != null ? ' (raised by ' + t.by + ' for today; base $' + base + ')' : ' (the budget file)') + (t ? ' · last answer: ' + t.choice + ' by ' + t.by + ' at ' + t.at : ''));
    return 0;
  }
  if (cmd === 'set') {
    const choice = argv[1]; const by = opt('by'); const why = opt('why');
    const auth = MH.authorize(co.ROOT, by);
    if (auth) { console.error(JSON.stringify({ ok: false, error: auth.error })); return auth.code; }
    const r = MH.set(co.ROOT, { choice, dailyUsd: opt('budget'), by, why, via: 'money-hold.js set' });
    console.log(JSON.stringify(r.ok ? { ok: true, what: r.what } : r));
    return r.ok ? 0 : (r.code || 1);
  }
  console.error('usage: money-hold.js status [--json] | set run|raise|keep [--budget USD] --by owner --why "…" | selftest');
  return 2;
}

/* selftest: a scratch company; the question is asked once after two held ticks, deduped, governed, and answered */
function selftest() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'money-hold-selftest-'));
  fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');   // provenance.fixtureRoot: owner checks pass inside this throwaway company
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'MH', owner: { name: 'Pat' }, timezone: 'UTC' });
  w('company/tools/loops.json', { agents: { agent: { name: 'Founder', functions: ['ceo'] } } });
  w('company/state/governance.json', { categories: {} });
  w('company/work/ops/cadence.json', { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, seats: {}, tempo: { sprint: { on: true, since: new Date().toISOString(), by: 'Pat' } } });
  process.env.CAPHEOS_ROOT = T; process.env.PROVENANCE_ROOT = T;
  for (const k of Object.keys(require.cache)) if (/company[\\/]tools[\\/]/.test(k)) delete require.cache[k];
  const MH = require('./lib/money-hold');
  const ib = () => { process.env.PM_INBOX_FILE = path.join(T, 'company', 'pm-inbox.jsonl'); return require('./inbox.js'); };
  let pass = 0, fail = 0; const check = (name, ok, extra) => { if (ok) pass++; else fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !extra ? '' : '  ' + extra)); };
  const st = {}; const logs = []; const log = l => logs.push(l);
  const holds = [{ seat: 'agent', name: 'Founder', kind: 'spread', waiting: ['Rohan', 'Halima'] }];
  const base = { root: T, holds, st, cap: 5, spent: 2.39, lastHour: 0.95, allowance: 0.63, live: true, log, govOpts: { level: 'approve' } };
  let r = MH.tick(base);
  check('one held tick asks nothing', !r.asked && st.moneyHolds.agent.ticks === 1);
  r = MH.tick(base);
  const q = r.asked && ib().state()[r.asked];
  check('the second held tick asks the owner once, blocking at approve', !!q && q.blocking === true && /Founder is paused so today's \$5 lasts until midnight\. Rohan and Halima are waiting on it\./.test(q.message || q.q), JSON.stringify(q));
  check('it has a slider for today\'s budget and the three buttons', q && q.form && q.form.fields[0].type === 'slider' && q.form.actions.map(a => a.label).join('|') === 'Let it run now|Raise today\'s budget|Keep spreading', JSON.stringify(q && q.form));
  r = MH.tick(base);
  check('deduped: no second question while one is open', !r.asked && ib().openQuestions().filter(x => String(x.about).startsWith('money-hold:')).length === 1 && r.open.agent === q.id);
  ib().answer({ id: q.id, by: 'Pat', answer: { action: 'raise', values: { budget: 9 } } });
  r = MH.tick(base);
  check('an answer is applied through the recorded path (today-budget.json, provenance)', r.applied[0] === q.id && MH.capToday(T, 5) === 9 && MH.readToday(T).via === q.id
    && fs.readFileSync(path.join(T, 'company', 'state', 'locked', 'provenance.jsonl'), 'utf8').includes('"writer":"money-hold.js"'), JSON.stringify(MH.readToday(T)));
  r = MH.tick(base);
  check('answered today: not asked again', !r.asked);
  // run now goes through cadence.js sprint config --spread today
  const rr = MH.set(T, { choice: 'run', by: 'Pat', why: 'test' });
  const cad = JSON.parse(fs.readFileSync(path.join(T, 'company', 'work', 'ops', 'cadence.json'), 'utf8'));
  check('"Let it run now" writes the spread off until midnight through cadence.js', rr.ok && Date.parse(cad.tempo.sprint.spreadOffUntil) > Date.now() && require('./lib/sprint').spreadOn(cad.tempo.sprint, Date.now()) === false, JSON.stringify([rr, cad.tempo.sprint]));
  // governance: at notify the company decides — an FYI, not blocking
  const st2 = { moneyHolds: { agent: { kind: 'cap', since: new Date().toISOString(), ticks: 1 } } };
  const r2 = MH.tick(Object.assign({}, base, { st: st2, holds: [{ seat: 'agent', name: 'Founder', kind: 'cap', waiting: [] }], govOpts: { level: 'notify' } }));
  const q2 = r2.asked && ib().state()[r2.asked];
  check('at notify it is a non-blocking FYI (and the owner is told in a sentence)', !!q2 && q2.blocking === false && r2.fyi === true && q2.form.actions.map(a => a.label).join('|') === 'Raise today\'s budget|Keep it paused', JSON.stringify(q2));
  check('an agent may not answer for the owner', MH.authorize(T, 'Rohan') && MH.authorize(T, 'Rohan').code === 3);
  console.log('\nmoney-hold selftest: ' + pass + '/' + (pass + fail));
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  return fail ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
