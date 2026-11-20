#!/usr/bin/env node
/* pacer.test.js — offline tests for company/tools/pacer.js.
 *
 * Every test builds its own company folder in a temp directory and gives the pacer a fake station (call/fire), a fake
 * MiniMax answer and a fixed clock. Nothing here touches the live station, the network or the real company files; the
 * only real file read is company/model-policy.json (to prove its routing table passes hire.js policyCheck), plus
 * hire.js's own source for that check.
 *
 *   node company/tools/tests/pacer.test.js          exit 0 = all pass
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const REPO = path.resolve(__dirname, '..', '..', '..');
const pacer = require('../pacer.js');

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const CLAUDE_RESET = 1795266000000;            // Sat 21 Nov 2026 13:00 UTC (a weekly resetsAt)
const WEEK_START = CLAUDE_RESET - 7 * DAY;     // Sat 14 Nov 13:00 UTC
const T0 = WEEK_START + 22 * HOUR;             // Sun 15 Nov 11:00 UTC: Claude day 1
const MM_START = 1794182400000, MM_END = 1794787200000;   // MiniMax week Mon 9 Nov 00:00 to Mon 16 Nov 00:00 UTC (day 7 at T0)

const LOOPS = {
  agent: { name: 'Alex', functions: ['ceo'], loop: 'Ops loop', inbox: 'to-alex.md', wakeOnInbox: false, wakeOnOwnerMessage: true },
  auditor: { name: 'Max', functions: ['risk'] },   // holds the risk function, no loop of its own
  drafter: { name: 'Sam', loop: 'Product loop', inbox: 'to-sam.md' },
  engineer: { name: 'Jo', loop: 'Engineering loop', inbox: 'to-jo.md' },
  designer: { name: 'Kim', loop: 'Design loop', inbox: 'to-kim.md' },
  treasurer: { name: 'Pat', loop: 'Finance loop', inbox: 'to-pat.md' },
  'cand-qa-lee': { name: 'Lee', loop: 'Lee loop', inbox: 'to-lee.md' },
};
const job = (id, name, agentId, provider, model, extra) => Object.assign({ id, name, agentId, provider, model, wire: { provider, model, source: 'routine' },
  state: 'scheduled', enabled: true, lastRunAt: new Date(T0 - 3 * HOUR).toISOString(), nextRunAt: new Date(T0 + HOUR).toISOString() }, extra || {});
function crewJobs() {
  return [
    job('j-ops', 'Ops loop — run the company', 'agent', 'deepseek', 'deepseek-flash'),
    job('j-brief', 'Morning operating brief', 'agent', 'deepseek', 'deepseek-flash'),
    job('j-prod', 'Product loop', 'drafter', 'deepseek', 'deepseek-flash'),
    job('j-eng', 'Engineering loop', 'engineer', 'deepseek', 'deepseek-flash'),
    job('j-design', 'Design loop', 'designer', 'deepseek', 'deepseek-flash'),
    job('j-fin', 'Finance loop', 'treasurer', 'deepseek', 'deepseek-flash'),
    job('j-health', 'Tool health check', 'engineer', 'deepseek', 'deepseek-flash'),
    job('j-lee', 'Lee loop', 'cand-qa-lee', 'deepseek', 'deepseek-flash'),
    job('j-misc', 'Some new routine', 'engineer', 'deepseek', 'deepseek-flash'),
  ];
}
const mmBody = (weeklyLeft, intervalLeft) => ({ model_remains: [
  { model_name: 'general', start_time: T0 - HOUR, end_time: T0 + 4 * HOUR, current_interval_remaining_percent: intervalLeft, current_weekly_remaining_percent: weeklyLeft,
    weekly_start_time: MM_START, weekly_end_time: MM_END, current_interval_total_count: 0, current_weekly_total_count: 0 },
  { model_name: 'video', current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100, weekly_start_time: MM_START, weekly_end_time: MM_END } ],
  base_resp: { status_code: 0, status_msg: 'success' } });

const roots = [];
function fixture(o) {
  o = o || {};
  const root = require('../lib/temp-life').tmpDir('pacer-test-');
  fs.writeFileSync(path.join(root, '.capheos-selftest-fixture'), '');   // provenance.fixtureRoot: this throwaway company answers owner checks, also in CI or an agent's run
  roots.push(root);
  const home = path.join(root, 'home');
  const w = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/model-policy.json', o.modelPolicy || LEGACY_POLICY);   // the chain tests pass the live table (liveFixture)
  if (o.policy !== false) w('company/work/finance/pacing-policy.json', Object.assign({ mode: 'shadow' }, o.policy || {},
    { claude: Object.assign({ feedFile: '~/.local/state/usage/claude-usage.json' }, (o.policy || {}).claude || {}) }));
  w('company/tools/loops.json', { agents: LOOPS });
  // self-governance for the scratch company: budget decided by the company unless a test sets a level
  w('company/state/governance.json', { categories: { budget: o.budgetLevel || 'auto' } });
  if (o.guards) w('company/state/guardrails.json', { guards: o.guards });
  // the merge window offpeak-hold.js reads (company time); without it the hold fails closed and never holds
  w('company/tools/merge-train.sh', 'WINDOW_START=0100\nWINDOW_STOP=0300\n');
  if (o.station !== false) w('.starnet-data/workspaces/.usage/subscriptions.json', { v: 1, providers: { 'claude-cli': { primary: {
    windows: [{ id: 'seven_day', label: 'week', usedPct: o.stationPct != null ? o.stationPct : 24, resetsAt: CLAUDE_RESET, status: o.stationStatus || 'allowed' }],
    seenAt: o.stationAt != null ? o.stationAt : T0 - 100 * MIN } } } });
  if (o.feed !== false) w('home/.local/state/usage/claude-usage.json', { at: o.feedAt != null ? o.feedAt : T0 - MIN,
    seven_day: { used_percentage: o.feedPct != null ? o.feedPct : 28, resets_at: CLAUDE_RESET / 1000 }, five_hour: o.fiveHour || null });
  w('.starnet-data/workspaces/runs.jsonl', (o.runs || []).map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const [inbox, txt] of Object.entries(o.handoffs || {})) w('company/work/handoffs/' + inbox, txt);
  if (o.emergency) w('company/state/emergency.json', o.emergency);
  if (o.ledger) w('.starnet-data/workspaces/ledger.jsonl', o.ledger.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (o.knobs) w('.starnet-data/workspaces/runtime.knobs.json', { version: 1, knobs: o.knobs });
  return { root, home, w };
}
// Routing fixtures. Both take the allowed lists and routing models from the real company/model-policy.json (so a
// change there that breaks the pacer shows up here) and put a reference set of routines on top: a new company's own
// table lists only the founder's loop, which is too little to exercise the rules.
const REAL_POLICY = () => JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'model-policy.json'), 'utf8'));
// The older routing rule (no scopes): a Claude tier while Claude is open, MiniMax if the routine may, else DeepSeek. A
// routine with no scope still follows it.
const LEGACY_ROUTINES = {
  'Morning operating brief': { claude: 'sonnet', minimax: true }, 'Daily PM digest': { claude: 'sonnet', minimax: false },
  'Finance loop': { claude: 'sonnet', minimax: false }, 'Security sweep': { claude: 'sonnet', minimax: false },
  'Product loop': { claude: 'sonnet', minimax: true }, 'Hiring loop': { claude: 'sonnet', minimax: false },
  'Daily standup': { claude: 'haiku', minimax: false }, 'Ops loop': { claude: 'haiku', minimax: false },
  'Engineering loop': { claude: null, minimax: false, railOverflow: false }, 'Design loop': { claude: null, minimax: true },
  'Deploy loop': { claude: null, minimax: true }, 'Floor loop': { claude: null, minimax: true }, 'Research loop': { claude: null, minimax: true },
  'Tool health check': { claude: null, minimax: false }, 'Sales trial loop': { claude: null, minimax: false, railOverflow: false },
  'Lee loop': { claude: null, minimax: false, railOverflow: false },
};
const LEGACY_POLICY = (() => { const mp = REAL_POLICY(); mp.routing = { models: mp.routing.models, routines: LEGACY_ROUTINES }; return JSON.stringify(mp); })();
const legacyFixture = o => fixture(Object.assign({ modelPolicy: LEGACY_POLICY }, o || {}));
// The chain rule: every routine names a scope from the real table (plus a 'sales' scope for a trial loop).
const CHAIN_ROUTINES = {
  'Morning operating brief': { claude: 'sonnet', minimax: true, scope: 'ceo' }, 'Daily PM digest': { claude: 'sonnet', minimax: true, scope: 'writing' },
  'Finance loop': { claude: 'sonnet', minimax: true, scope: 'review' }, 'Security sweep': { claude: 'sonnet', minimax: true, scope: 'review' },
  'Product loop': { claude: 'sonnet', minimax: true, scope: 'writing' }, 'Hiring loop': { claude: 'sonnet', minimax: true, scope: 'review' },
  'Daily standup': { claude: 'haiku', minimax: true, scope: 'ceo' }, 'Ops loop': { claude: 'haiku', minimax: true, scope: 'ceo' },
  'Engineering loop': { claude: 'sonnet', minimax: false, railOverflow: false, scope: 'actions' }, 'Design loop': { claude: 'sonnet', minimax: false, scope: 'design' },
  'Deploy loop': { claude: 'sonnet', minimax: false, scope: 'actions' }, 'Floor loop': { claude: 'haiku', minimax: false, scope: 'design' },
  'Research loop': { claude: 'sonnet', minimax: true, scope: 'research' }, 'Tool health check': { claude: 'haiku', minimax: false, scope: 'actions' },
  'Sales trial loop': { claude: 'sonnet', minimax: true, railOverflow: false, scope: 'sales' }, 'Lee loop': { claude: 'sonnet', minimax: false, railOverflow: false, scope: 'code' },
};
const LIVE_POLICY = () => { const mp = REAL_POLICY(); mp.routing.routines = JSON.parse(JSON.stringify(CHAIN_ROUTINES));
  mp.routing.scopes.sales = { chain: ['deepseek', 'minimax', 'claude'], who: 'a sales trial', why: 'a trial keeps the model it was interviewed on first' }; return JSON.stringify(mp); };
const liveFixture = o => fixture(Object.assign({ modelPolicy: LIVE_POLICY() }, o || {}));
function station(jobs, budget) {
  const copy = JSON.parse(JSON.stringify(jobs));
  const calls = [], fires = [];
  const call = async (method, p, body) => {
    calls.push({ method, p, body });
    if (method === 'GET' && p === '/api/budget/status') return { status: 200, body: JSON.stringify(budget || { caps: { perDay: 25 }, day: { usd: 5, cap: 25 }, live: 0 }) };
    if (method === 'GET' && p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs: copy }) };
    if (method === 'POST' && p === '/api/cron/update') {
      const j = copy.find(x => x.id === body.id); if (!j) return { status: 404, body: '{"error":"no such routine"}' };
      Object.assign(j, body.patch); j.wire = { provider: j.provider, model: j.model, source: 'routine' };
      return { status: 200, body: JSON.stringify({ ok: true, job: j }) };
    }
    return { status: 404, body: '{}' };
  };
  const fire = async id => { fires.push(id); return { status: 200, body: 'started' }; };
  return { call, fire, calls, fires, copy, posts: () => calls.filter(c => c.method === 'POST') };
}
function make(fx, st, o) {
  o = o || {};
  let fetches = 0;
  const lines = [];
  const clock = { t: o.t || T0 };
  const p = pacer.makePacer(Object.assign({ root: fx.root, home: fx.home, now: () => clock.t, call: st.call, fire: st.fire, log: l => lines.push(l),
    fetchMiniMax: async () => { fetches++; return o.mmFail ? { ok: false, error: 'HTTP 500' } : { ok: true, body: o.mm || mmBody(94, 94) }; } }, o.extra || {}));
  return { p, lines, clock, fetches: () => fetches };
}
async function measurePlan(h, jobs) { const s = h.p.loadState(); const m = await h.p.measure(s, jobs); const pl = h.p.plan(m, s, jobs); return { s, m, pl, row: n => pl.rows.find(r => r.name.startsWith(n)) }; }

test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

/* ---- the daily line ---- */
test('day count and line: k x 100/7 minus the margin, carried forward', () => {
  assert.equal(pacer.dayOf(WEEK_START, T0), 1);
  assert.equal(pacer.dayOf(WEEK_START, WEEK_START + DAY + 1), 2);
  assert.equal(pacer.dayOf(WEEK_START, CLAUDE_RESET - 1), 7);
  assert.ok(Math.abs(pacer.lineFor(1, 1 / 7, 1) - 13.2857) < 1e-3);
  assert.ok(Math.abs(pacer.lineFor(3, 1 / 7, 1) - 41.857) < 1e-3);
  assert.equal(Math.round(pacer.lineFor(7, 1 / 7, 1)), 99);
  assert.equal(pacer.nextOpenDay(28, 1 / 7, 1), 3);
  assert.equal(pacer.nextOpenDay(99.5, 1 / 7, 1), null);
});

test('Claude at 28% on day 1 is closed; at 10% it is open; on day 3 at 40% it is open', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture({ feedPct: 28 }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false);
  assert.match(r.m.claude.why, /over today's line of 13.3%/);
  assert.equal(r.m.claude.nextOpen.day, 3);
  r = await measurePlan(make(fixture({ feedPct: 10 }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, true);
  assert.ok(Math.abs(r.m.claude.left - 3.2857) < 1e-3);
  const t3 = WEEK_START + 2 * DAY + HOUR;
  r = await measurePlan(make(fixture({ feedPct: 40, feedAt: t3 - MIN }), station(jobs), { t: t3 }), jobs);
  assert.equal(r.m.claude.day, 3);
  assert.equal(r.m.claude.open, true);
});

test('the highest fresh Claude reading wins (not the newest), and a reading older than 90 minutes is unknown = closed', async () => {
  const jobs = crewJobs();
  // the status line rewrites its file every minute even while its numbers are frozen: newer is not truer
  let r = await measurePlan(make(fixture({ feedPct: 28, feedAt: T0 - 30 * MIN, stationPct: 5, stationAt: T0 - 2 * MIN }), station(jobs)), jobs);
  assert.equal(r.m.claude.source, 'status line');
  assert.equal(r.m.claude.usedPct, 28);
  assert.equal(r.m.claude.open, false);
  // a higher reading that is stale does not count: the fresh one decides
  r = await measurePlan(make(fixture({ feedPct: 5, feedAt: T0 - MIN, stationPct: 40, stationAt: T0 - 100 * MIN }), station(jobs)), jobs);
  assert.equal(r.m.claude.usedPct, 5);
  assert.equal(r.m.claude.open, true);
  r = await measurePlan(make(fixture({ feedPct: 5, feedAt: T0 - 91 * MIN, stationPct: 5, stationAt: T0 - 120 * MIN }), station(jobs)), jobs);
  assert.equal(r.m.claude.known, false);
  assert.equal(r.m.claude.open, false);
  assert.match(r.m.claude.why, /unknown/);
  r = await measurePlan(make(fixture({ feed: false, station: false }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false);
  assert.match(r.m.claude.why, /no reading/);
});

test('a reading from a week that has ended is not used', async () => {
  const jobs = crewJobs();
  const after = CLAUDE_RESET + 10 * MIN;
  const r = await measurePlan(make(fixture({ feedPct: 96, feedAt: after - 5 * MIN }), station(jobs), { t: after }), jobs);
  assert.equal(r.m.claude.open, false);
  assert.match(r.m.claude.why, /week that has ended/);
});

/* ---- MiniMax ---- */
test('MiniMax: weekly used = 100 - remaining, day from weekly_start_time, closed under 20% of the 5-hour window', async () => {
  const p = pacer.parseMiniMax(mmBody(94, 94), 'general', T0);
  assert.equal(p.ok, true); assert.equal(p.usedPct, 6); assert.equal(p.fiveHourLeftPct, 94); assert.equal(p.weekStart, MM_START);
  assert.equal(pacer.parseMiniMax({ base_resp: { status_code: 1004, status_msg: 'auth' } }, 'general', T0).ok, false);
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture(), station(jobs), { mm: mmBody(94, 94) }), jobs);
  assert.equal(r.m.minimax.day, 7); assert.equal(r.m.minimax.open, true);
  r = await measurePlan(make(fixture(), station(jobs), { mm: mmBody(94, 15) }), jobs);
  assert.equal(r.m.minimax.open, false); assert.equal(r.m.minimax.hard, true);
  assert.match(r.m.minimax.why, /5-hour window has 15% left/);
  // day 2 of its week at 40% used: line 27.6, closed
  const d2 = MM_START + DAY + HOUR;
  r = await measurePlan(make(fixture({ feedAt: d2 - MIN }), station(jobs), { t: d2, mm: mmBody(60, 90) }), jobs);
  assert.equal(r.m.minimax.day, 2); assert.equal(r.m.minimax.open, false);
});

test('MiniMax is called at most once every 10 minutes and the reading is cached', async () => {
  const fx = fixture(), jobs = crewJobs(), st = station(jobs);
  const h = make(fx, st);
  let s = h.p.loadState(); await h.p.measure(s, jobs); h.p.saveState(s);
  h.clock.t += 9 * MIN; s = h.p.loadState(); const m = await h.p.measure(s, jobs); h.p.saveState(s);
  assert.equal(h.fetches(), 1);
  assert.equal(m.minimax.open, true);   // the cached reading is 9 minutes old
  h.clock.t += 1 * MIN; s = h.p.loadState(); await h.p.measure(s, jobs); h.p.saveState(s);
  assert.equal(h.fetches(), 2);
  const saved = JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/pacer-state.json'), 'utf8'));
  assert.equal(saved.minimax.reading.usedPct, 6);
  assert.ok(!JSON.stringify(saved).includes('Bearer'));
});

test('a failing MiniMax call leaves it closed once the cached reading is stale', async () => {
  const fx = fixture(), jobs = crewJobs();
  const h = make(fx, station(jobs), { mmFail: true });
  const s = h.p.loadState(); const m = await h.p.measure(s, jobs);
  assert.equal(m.minimax.open, false);
  assert.match(m.minimax.why, /no reading yet \(HTTP 500\)/);
});

/* ---- emergency ---- */
test('emergency: Alex or Max only, at most 12 hours; lifts the line to 90% and expires by itself', async () => {
  const fx = fixture({ feedPct: 29 }), jobs = crewJobs();
  const h = make(fx, station(jobs));
  assert.equal(h.p.emergencyOn({ why: 'prod down', by: 'Jo', hours: 2 }).ok, false);
  assert.equal(h.p.emergencyOn({ why: 'prod down', by: 'Alex', hours: 13 }).ok, false);
  assert.equal(h.p.emergencyOn({ why: '', by: 'Max', hours: 2 }).ok, false);
  const on = h.p.emergencyOn({ why: 'production API down (S0)', by: 'Max', hours: 4 });
  assert.equal(on.ok, true);
  let r = await measurePlan(h, jobs);
  assert.equal(r.m.emergency.active, true);
  assert.equal(r.m.claude.line, 90);
  assert.equal(r.m.claude.open, true);
  assert.equal(r.m.claude.emergencyOpened, true);
  assert.equal(r.row('Morning operating brief').to.model, 'claude-sonnet-5-5');
  assert.equal(r.row('Morning operating brief').emergency, true);
  h.clock.t += 4 * HOUR + MIN;
  const s = h.p.loadState(); const m = await h.p.measure(s, jobs);
  assert.equal(m.emergency.active, false); assert.equal(m.emergency.expired, true);
  h.p.emergencyHousekeeping(m, s);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/emergency.json'), 'utf8')).active, false);
  assert.ok(h.lines.some(l => /EMERGENCY ON by Max/.test(l)) && h.lines.some(l => /EMERGENCY EXPIRED/.test(l)));
  const kinds = h.p.readJournal().map(e => e.kind);
  assert.ok(kinds.includes('emergency-on') && kinds.includes('emergency-expired'));
});

test('a confirmed S0/S1 serious flag from the last 24 hours starts a 6-hour emergency in live mode, once; shadow only says so', async () => {
  const serious = [{ id: 'ev-new', agent: 'deployer', severity: 'S1', signal: 'gate that cannot fail', at: new Date(T0 - 2 * HOUR).toISOString() },
    { id: 'ev-old', agent: 'agent', severity: 'S1', signal: 'old', at: new Date(T0 - 3 * DAY).toISOString() },
    { id: 'ev-s2', agent: 'agent', severity: 'S2', signal: 'minor', at: new Date(T0 - HOUR).toISOString() }];
  for (const mode of ['shadow', 'live']) {
    const jobs = crewJobs();
    const fx = fixture({ policy: { mode } });
    fx.w('company/work/people/competence.json', { serious });
    const h = make(fx, station(jobs));
    let s = h.p.loadState(); let m = await h.p.measure(s, jobs);
    assert.deepEqual(m.serious.flags.map(f => f.id), ['ev-new']);
    h.p.emergencyHousekeeping(m, s); h.p.saveState(s);
    const em = (() => { try { return JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/emergency.json'), 'utf8')); } catch (_) { return null; } })();
    if (mode === 'live') {
      assert.equal(em.active, true); assert.equal(em.auto, true); assert.equal(em.hours, 6);
      assert.match(em.why, /ev-new/);
      h.p.emergencyOff({ by: 'Alex', why: 'handled' });
      s = h.p.loadState(); m = await h.p.measure(s, jobs); h.p.emergencyHousekeeping(m, s);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/emergency.json'), 'utf8')).active, false);   // never restarted for the same flag
    } else {
      assert.equal(em, null);
      assert.ok(h.lines.some(l => /SHADOW would turn on an emergency/.test(l)));
    }
  }
});

/* ---- routing ---- */
test('routing: Claude tier when Claude is open, MiniMax when eligible, else DeepSeek; DeepSeek-only and unlisted routines', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(legacyFixture({ feedPct: 5 }), station(jobs)), jobs);
  assert.equal(r.row('Morning operating brief').to.model, 'claude-sonnet-5-5');
  assert.equal(r.row('Ops loop').to.model, 'haiku');
  assert.equal(r.row('Design loop').to.provider, 'custom');
  assert.equal(r.row('Tool health check').to.provider, 'deepseek');
  assert.equal(r.row('Lee loop').to.provider, 'deepseek');
  assert.ok(r.pl.untouched.some(u => u.name === 'Some new routine'));
  // Claude closed: brief and product fall to MiniMax; digest-style routines fall to DeepSeek
  r = await measurePlan(make(legacyFixture({ feedPct: 28 }), station(jobs)), jobs);
  assert.equal(r.row('Morning operating brief').to.provider, 'custom');
  assert.equal(r.row('Product loop').to.provider, 'custom');
  assert.equal(r.row('Finance loop').to.provider, 'deepseek');
  assert.equal(r.row('Ops loop').to.provider, 'deepseek');
  for (const row of r.pl.rows) assert.ok(!/opus|fable/i.test(row.to.model));
});

// claudeOnlyIfShareLeftAbove: a routine may ask for Claude only while more than N days' share is left. No reference
// routine sets it, so it is proved on a fixture row.
test('claudeOnlyIfShareLeftAbove is honoured in both directions (proved on a fixture row)', async () => {
  const mp = JSON.parse(LIVE_POLICY());
  mp.routing.routines['Engineering loop'] = { claude: 'sonnet', minimax: false, claudeOnlyIfShareLeftAbove: 0.75 };
  const jobs = crewJobs();
  // day 1, 5% used: 8.3 points left = 0.58 days' share, under the 0.75 this row asks
  let r = await measurePlan(make(fixture({ feedPct: 5, modelPolicy: JSON.stringify(mp) }), station(jobs)), jobs);
  assert.ok(r.m.claude.sharesLeft < 0.75);
  assert.equal(r.row('Engineering loop').to.provider, 'deepseek');
  assert.match(r.row('Engineering loop').why, /needs more than 0\.75/);
  r = await measurePlan(make(fixture({ feedPct: 1, modelPolicy: JSON.stringify(mp) }), station(jobs)), jobs);
  assert.ok(r.m.claude.sharesLeft > 0.75);
  assert.equal(r.row('Engineering loop').to.model, 'claude-sonnet-5-5');
});

test('the reference chain table: the default scope rules hold (drift guard on company/model-policy.json scopes)', () => {
  const mp = JSON.parse(LIVE_POLICY());
  const R = mp.routing, sc = R.scopes, rt = R.routines;
  for (const [name, e] of Object.entries(rt)) {
    assert.ok(e.scope && sc[e.scope], name + ' names a scope (every person has a chain)');
    assert.ok(sc[e.scope].chain.length >= 2, name + ': at least one fallback');
  }
  // the actions scope: DeepSeek first, fallbacks behind it, DeepSeek kept near the rail
  assert.equal(sc[rt['Engineering loop'].scope].chain[0], 'deepseek');
  assert.equal(rt['Engineering loop'].railOverflow, false);
  // defaults: MiniMax never writes code; Claude leads UI/UX; the CEO is on Claude and does not go down
  for (const n of ['Engineering loop', 'Deploy loop', 'Lee loop', 'Tool health check', 'Design loop', 'Floor loop'])
    assert.ok(!sc[rt[n].scope].chain.includes('minimax'), n + ' writes code or screens: no MiniMax link');
  for (const n of ['Design loop', 'Floor loop']) assert.equal(sc[rt[n].scope].chain[0], 'claude', n + ': Claude first (UI/UX)');
  for (const n of ['Ops loop', 'Morning operating brief', 'Daily standup']) {
    assert.equal(sc[rt[n].scope].chain[0], 'claude', n + ': Alex is on Claude');
    assert.equal(sc[rt[n].scope].claudeReserve, true, n + ': Alex keeps Claude past the daily line');
  }
});

test('Opus or Fable in the routing table is refused, and a routine found on Opus is moved at once', async () => {
  const mp = JSON.parse(LIVE_POLICY());
  mp.routing.models.opus = { provider: 'claude-cli', model: 'claude-opus-5-5' };
  mp.routing.routines['Morning operating brief'] = { claude: 'opus', minimax: false };
  const jobs = crewJobs();
  jobs.find(j => j.id === 'j-fin').provider = 'claude-cli';
  Object.assign(jobs.find(j => j.id === 'j-fin'), { model: 'claude-opus-5-5', wire: { provider: 'claude-cli', model: 'claude-opus-5-5' } });
  const fx = fixture({ feedPct: 5, modelPolicy: JSON.stringify(mp) });
  const h = make(fx, station(jobs));
  const s = h.p.loadState(); s.routines['j-fin'] = { lastSwitchAt: T0 - 5 * MIN }; h.p.saveState(s);
  const r = await measurePlan(h, jobs);
  assert.equal(r.row('Morning operating brief').to.provider, 'deepseek');
  assert.ok(r.pl.problems.some(p => /heavy tier/.test(p)));
  const fin = r.row('Finance loop');
  assert.equal(fin.action, 'switch');                // despite the switch five minutes ago
  assert.match(fin.urgent, /not a routine tier/);
  assert.equal(fin.to.model, 'claude-sonnet-5-5');
});

test('at most one switch an hour, never while running', async () => {
  const jobs = crewJobs();
  jobs.find(j => j.id === 'j-design').state = 'running';
  const h = make(fixture({ feedPct: 28 }), station(jobs));
  const s = h.p.loadState(); s.routines['j-prod'] = { lastSwitchAt: T0 - 30 * MIN }; h.p.saveState(s);
  const r = await measurePlan(h, jobs);
  assert.equal(r.row('Design loop').action, 'wait'); assert.match(r.row('Design loop').wait, /running/);
  assert.equal(r.row('Product loop').action, 'wait'); assert.match(r.row('Product loop').wait, /switched 30 min ago/);
  assert.equal(r.row('Morning operating brief').action, 'switch');
});

/* ---- apply against the fake call layer ---- */
test('apply in shadow mode makes no POST at all', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const h = make(fixture({ feedPct: 28 }), st);
  const r = await measurePlan(h, jobs);
  const done = await h.p.apply(r.m, r.pl, r.s, jobs);
  assert.ok(done.length > 0 && done.every(d => d.applied === false));
  assert.equal(st.posts().length, 0);
  assert.equal(st.fires.length, 0);
});

test('apply in live mode: POST /api/cron/update {id, patch:{provider, model}}, recorded, and checked against the answer', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const h = make(fixture({ feedPct: 28, policy: { mode: 'live' } }), st);
  assert.equal(h.p.live, true);
  const r = await measurePlan(h, jobs);
  const done = await h.p.apply(r.m, r.pl, r.s, jobs);
  const posts = st.posts();
  assert.equal(posts.length, 2);   // the ramp: at most 2 routines move onto a subscription an hour
  for (const c of posts) { assert.equal(c.p, '/api/cron/update'); assert.deepEqual(Object.keys(c.body.patch).sort(), ['model', 'provider']); }
  assert.ok(posts.some(c => c.body.id === 'j-brief' && c.body.patch.provider === 'custom' && c.body.patch.model === 'MiniMax-M3.1-Flash'));
  assert.ok(done.filter(d => d.applied).length === posts.length);
  assert.ok(r.s.routines['j-brief'].lastSwitchAt === T0);
  assert.equal(jobs.find(j => j.id === 'j-brief').wire.provider, 'custom');   // the dispatcher's copy follows
  assert.ok(h.lines.some(l => /SWITCH "Morning operating brief": deepseek\/deepseek-flash -> custom\/MiniMax-M3.1-Flash/.test(l)));
  // the next plan in the same hour leaves it alone
  const r2 = h.p.plan(r.m, r.s, jobs);
  assert.equal(r2.rows.find(x => x.id === 'j-brief').action, 'stay');
});

test('a routine\'s first refusal blocks that provider for that routine for 2 h and is re-run once, unchanged, on its new model', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-prod'), { provider: 'claude-cli', model: 'claude-sonnet-5-5', wire: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
  const runs = [{ runId: 'r-refused', cronJobId: 'j-prod', agentId: 'drafter', provider: 'claude-cli', model: 'claude-sonnet-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', reason: 'error', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
  const st = station(jobs);
  const h = make(fixture({ feedPct: 5, runs, policy: { mode: 'live', routing: { refireWithinMin: 120 } } }), st);
  const s = h.p.loadState();
  s.routines['j-prod'] = { lastSwitchAt: T0 - 15 * MIN };   // urgent: the hourly limit does not hold a refusal
  const m = await h.p.measure(s, jobs);
  assert.equal(s.blocks.length, 1);
  assert.equal(s.blocks[0].until, T0 - 10 * MIN + 2 * HOUR);
  const pl = h.p.plan(m, s, jobs);
  const row = pl.rows.find(x => x.id === 'j-prod');
  assert.equal(row.to.provider, 'custom');           // Claude is open but blocked for this routine
  assert.equal(row.action, 'switch');
  assert.equal(pl.refires[0].status, 'ready');
  await h.p.apply(m, pl, s, jobs);
  assert.deepEqual(st.fires, ['j-prod']);
  assert.ok(s.refired['r-refused']);
  h.p.saveState(s);
  // the next tick: blocked still, never re-fired twice
  h.clock.t += 10 * MIN;
  const s2 = h.p.loadState(); const m2 = await h.p.measure(s2, jobs); const pl2 = h.p.plan(m2, s2, jobs);
  await h.p.apply(m2, pl2, s2, jobs);
  assert.deepEqual(st.fires, ['j-prod']);
  assert.equal(pl2.rows.find(x => x.id === 'j-prod').to.provider, 'custom');
  // 24 hours later the block is gone
  h.clock.t = T0 + 25 * HOUR;
  const s3 = h.p.loadState(); await h.p.measure(s3, jobs);
  assert.equal(s3.blocks.length, 0);
});

test('a usage-limit error closes Claude until its reset, and Claude routines move at once', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-ops'), { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', wire: { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001' } });
  const runs = [{ runId: 'r-limit', agentId: 'agent', provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', outcome: 'failed', failureCode: 'quota_exhausted', error: 'Claude Code usage limit reached: You have hit your limit', startedAt: T0 - 6 * MIN, endedAt: T0 - 5 * MIN }];
  const h = make(legacyFixture({ feedPct: 5, runs, fiveHour: { used_percentage: 100, resets_at: (T0 + 2 * HOUR) / 1000 } }), station(jobs));
  const s = h.p.loadState(); s.routines['j-ops'] = { lastSwitchAt: T0 - 10 * MIN }; h.p.saveState(s);
  const r = await measurePlan(h, jobs);
  assert.equal(r.m.claude.open, false); assert.equal(r.m.claude.hard, true);
  assert.equal(r.s.closures.claude.until, T0 + 2 * HOUR);   // the 5-hour window that ran out
  const ops = r.row('Ops loop');
  assert.equal(ops.to.provider, 'deepseek'); assert.equal(ops.action, 'switch'); assert.ok(ops.urgent);
});

test('a 64 MB runs.jsonl is never read whole: the usage-limit error at its end still closes Claude, quickly', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-ops'), { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', wire: { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001' } });
  const fx = legacyFixture({ feedPct: 5, fiveHour: { used_percentage: 100, resets_at: (T0 + 2 * HOUR) / 1000 } });
  const rf = path.join(fx.root, '.starnet-data/workspaces/runs.jsonl');
  const old = JSON.stringify({ runId: 'r-old', agentId: 'agent', provider: 'deepseek', model: 'deepseek-flash', reason: 'done', usd: 0.01, startedAt: T0 - 30 * DAY, endedAt: T0 - 30 * DAY + MIN, pad: 'p'.repeat(300) }) + '\n';
  const fd = fs.openSync(rf, 'w'); try { const block = Buffer.from(old.repeat(4096)); for (let w = 0; w < 64 * 1024 * 1024; w += block.length) fs.writeSync(fd, block); } finally { fs.closeSync(fd); }
  fs.appendFileSync(rf, JSON.stringify({ runId: 'r-limit', agentId: 'agent', provider: 'claude-cli', model: 'claude-haiku-4-5-20251001', outcome: 'failed', failureCode: 'quota_exhausted', error: 'Claude Code usage limit reached: You have hit your limit', startedAt: T0 - 6 * MIN, endedAt: T0 - 5 * MIN }) + '\n');
  const h = make(fx, station(jobs));
  const real = fs.readFileSync; let whole = 0;
  fs.readFileSync = function (f) { if (String(f) === rf) whole++; return real.apply(fs, arguments); };
  const t0 = Date.now(); let r;
  try { r = await measurePlan(h, jobs); } finally { fs.readFileSync = real; }
  const ms = Date.now() - t0;
  assert.equal(whole, 0, 'runs.jsonl read whole ' + whole + ' times');
  assert.equal(r.m.claude.open, false); assert.equal(r.m.claude.hard, true);
  assert.ok(ms < 3000, 'measure + plan took ' + ms + ' ms');
});

/* ---- the dispatcher hook ---- */
const due = d => '# inbox\n\n## 2026-11-15 from Sam — something\n**Need:** x\n**Deadline:** ' + d + '\n**Status:** OPEN\n**Evidence:** y\n';
test('handoffsDueToday reads free-text deadlines loosely', () => {
  const fx = fixture({ handoffs: {
    'a.md': due('today'), 'b.md': due('2026-11-20 12:00'), 'c.md': due('your call; nothing blocks on it today.'), 'd.md': due('the SIM figure was due 2026-11-14'),
    'e.md': due('today').replace('OPEN', 'DONE'), 'f.md': due('none.') } });
  const f = n => pacer.handoffsDueToday(path.join(fx.root, 'company/work/handoffs', n), T0).length;
  assert.equal(f('a.md'), 1); assert.equal(f('b.md'), 0); assert.equal(f('c.md'), 0); assert.equal(f('d.md'), 1); assert.equal(f('e.md'), 0); assert.equal(f('f.md'), 0);
});

test('near the station rail, live mode holds DeepSeek wake-ups with no handoff due today (never an owner wake-up)', async () => {
  const budget = { caps: { perDay: 25 }, day: { usd: null, estimatedUsd: 21.5, cap: 25 }, live: 0.3 };   // 87%
  const handoffs = { 'to-kim.md': due('2026-11-20 12:00'), 'to-jo.md': due('today'), 'to-pat.md': due('2026-11-17') };
  for (const mode of ['shadow', 'live']) {
    const jobs = crewJobs(), st = station(jobs, budget);
    const fx = fixture({ feedPct: 28, handoffs, policy: { mode } });
    const h = make(fx, st, { mm: mmBody(94, 10) });   // MiniMax closed (5-hour window), so nothing moves off DeepSeek
    const order = ['agent', 'engineer', 'designer', 'treasurer', 'cand-qa-lee'];
    const r = await h.p.hook({ jobs, order, ownerWake: new Set(['agent']), maxPerTick: 2 });
    if (mode === 'live') {
      assert.deepEqual(order, ['agent', 'engineer']);
      assert.deepEqual(r.holds.sort(), ['cand-qa-lee', 'designer', 'treasurer']);
      assert.ok(h.lines.some(l => /^PACE HOLD \(station rail 87%/.test(l)));
    } else {
      assert.equal(order.length, 5);
      assert.ok(h.lines.some(l => /SHADOW would hold/.test(l)));
      assert.equal(st.posts().length, 0);
    }
    assert.equal(r.extra, 0);   // no third slot near the rail
    const report = fs.readFileSync(path.join(fx.root, 'company/work/finance/ai-usage.md'), 'utf8');
    assert.ok(!/\$\s?\d/.test(report), 'the report carries no dollar figures');
    assert.match(report, /daily safety rail is 87% used/);
  }
});

test('near the rail, a DeepSeek routine overflows to MiniMax while MiniMax is open (not the candidates)', async () => {
  const budget = { caps: { perDay: 25 }, day: { usd: 22, cap: 25 }, live: 0 };
  const jobs = crewJobs();
  const r = await measurePlan(make(legacyFixture({ feedPct: 28 }), station(jobs, budget)), jobs);
  assert.equal(r.m.rail.pressure, true);
  assert.equal(r.row('Finance loop').to.provider, 'custom');
  assert.match(r.row('Finance loop').why, /near the station's daily rail/);
  assert.equal(r.row('Lee loop').to.provider, 'deepseek');
});

test('the third per-tick slot: live only, only while a subscription has more than half a day left, only when it is needed', async () => {
  for (const [mode, orderLen, want] of [['live', 4, 1], ['live', 2, 0], ['shadow', 4, 0]]) {
    const jobs = crewJobs();
    Object.assign(jobs.find(j => j.id === 'j-design'), { provider: 'custom', model: 'MiniMax-M3.1-Flash', wire: { provider: 'custom', model: 'MiniMax-M3.1-Flash' } });   // the third loop is on MiniMax
    const h = make(fixture({ feedPct: 28, policy: { mode } }), station(jobs));
    const order = ['agent', 'engineer', 'designer', 'treasurer'].slice(0, orderLen);
    const r = await h.p.hook({ jobs, order, ownerWake: new Set(), maxPerTick: 2 });
    assert.equal(r.extra, want, mode + ' ' + orderLen);
  }
  // MiniMax nearly spent and Claude closed: no boost
  const jobs = crewJobs();
  const h = make(fixture({ feedPct: 28, policy: { mode: 'live' } }), station(jobs), { mm: mmBody(2, 90) });
  const r = await h.p.hook({ jobs, order: ['agent', 'engineer', 'designer'], ownerWake: new Set(), maxPerTick: 2 });
  assert.equal(r.extra, 0);
});

test('dispatchHook is fail-safe: an error or a hang returns extra 0 and changes nothing', async () => {
  const lines = [];
  const order = ['engineer', 'designer'];
  let r = await pacer.dispatchHook({ log: l => lines.push(l), order, jobs: [], pacer: { root: fixture().root, now: () => { throw new Error('boom'); } } });
  assert.deepEqual(r, { extra: 0 });
  assert.ok(lines.some(l => /PACER ERROR: boom/.test(l)));
  const fx = fixture();
  r = await pacer.dispatchHook({ log: l => lines.push(l), order, timeoutMs: 200, pacer: { root: fx.root, home: fx.home, call: () => new Promise(() => {}), fetchMiniMax: () => new Promise(() => {}) } });
  assert.equal(r.extra, 0); assert.equal(r.timeout, true);
  assert.deepEqual(order, ['engineer', 'designer']);
  assert.ok(lines.some(l => /PACER TIMEOUT/.test(l)));
});

test('a missing policy file means shadow mode', () => {
  const fx = fixture({ policy: false });
  const p = pacer.loadPolicy(fx.root);
  assert.equal(p.mode, 'shadow');
  assert.ok(p.problems.length);
  assert.equal(pacer.loadPolicy(fx.root, { mode: 'live' }).mode, 'live');
  assert.equal(pacer.DEFAULTS.claude.staleAfterMin, 90);   // loading never edits the defaults
});

/* ---- the real routing table ---- */
test('the routing table in company/model-policy.json passes hire.js policyCheck and uses only Haiku/Sonnet for Claude', () => {
  const src = fs.readFileSync(path.join(REPO, 'company', 'tools', 'hire.js'), 'utf8');
  const fn = src.match(/function policyCheck\(provider, model\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'policyCheck found in hire.js');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
  const modelPolicy = () => readJson(path.join(REPO, 'company', 'model-policy.json'), {}) || {};
  const policyCheck = new Function('readJson', 'path', 'ROOT', 'modelPolicy', fn[0] + '\nreturn policyCheck;')(readJson, path, REPO, modelPolicy);
  const mp = REAL_POLICY();
  for (const [k, v] of Object.entries(mp.routing.models)) assert.equal(policyCheck(v.provider, v.model), null, k);
  assert.match(policyCheck('claude-cli', 'claude-opus-5-5') || '', /^$/);   // Opus stays hireable; it is only kept off routines
  assert.ok(policyCheck('deepseek', 'deepseek-v4-pro'));
  const R = pacer.loadRouting(REPO);
  assert.deepEqual(R.problems, []);
  for (const [name, e] of Object.entries(mp.routing.routines)) {
    if (e.claude) assert.ok(['light', 'standard'].includes(mp.allowed['claude-cli'].tiers[mp.routing.models[e.claude].model]), name);
    assert.ok(e.scope && mp.routing.scopes[e.scope], name + ' names a scope');
  }
  // the table names exactly the loops that exist (company/tools/loops.json); this test also runs inside a company, whose
  // people seat owns the table, so it checks the invariants and not that company's decisions
  const loops = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'tools', 'loops.json'), 'utf8')).agents;
  routingInvariants(mp, Object.values(loops).map(a => a.loop).filter(Boolean));
});

// routingInvariants(policy, loopNames) — what any company's routing table must hold. The SET of routines matches the
// loops (table order matters to the pacer, but it is the table owner's choice, not a side effect of this check); the ceo
// scope keeps a Claude reserve; the CEO loop's chain includes claude, whichever scope the table puts it on.
function routingInvariants(mp, loopNames) {
  assert.deepEqual(Object.keys(mp.routing.routines).sort(), loopNames.slice().sort(), 'the table names the loops that exist');
  assert.equal(mp.routing.scopes.ceo && mp.routing.scopes.ceo.claudeReserve, true, 'the ceo scope keeps a Claude reserve');
  const ceoLoop = mp.routing.routines['Founder loop'];
  assert.ok(ceoLoop && (mp.routing.scopes[ceoLoop.scope].chain || []).includes('claude'), 'the CEO loop\'s chain includes claude');
}

test('routing invariants hold for a grown company that reordered its table and moved the CEO loop to another claude scope', () => {
  const mp = JSON.parse(JSON.stringify(REAL_POLICY()));
  mp.routing.routines = { 'Sam loop': { scope: 'code' }, 'Founder loop': { scope: 'actions' } };
  assert.doesNotThrow(() => routingInvariants(mp, ['Founder loop', 'Sam loop']));
  assert.throws(() => routingInvariants(mp, ['Founder loop']), /loops that exist/);
  mp.routing.routines['Founder loop'].scope = 'research';
  mp.routing.scopes.research = { chain: ['minimax', 'deepseek'] };
  assert.throws(() => routingInvariants(mp, ['Founder loop', 'Sam loop']), /includes claude/);
  delete mp.routing.scopes.ceo.claudeReserve;
  assert.throws(() => routingInvariants(mp, ['Founder loop', 'Sam loop']), /Claude reserve/);
});

/* ==== fixes after review ==== */
const readState = fx => { try { return JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/pacer-state.json'), 'utf8')); } catch (_) { return null; } };
const tick = async (h, jobs, extra) => h.p.hook(Object.assign({ jobs, order: [], ownerWake: new Set(), maxPerTick: 2 }, extra || {}));

test('fix 1: an idle session rewriting a lower number never lowers the meter; a newer week beats an ended one', async () => {
  const jobs = crewJobs(), fx = fixture({ feedPct: 30, feedAt: T0 - MIN, station: false }), st = station(jobs);
  const h = make(fx, st);
  let s = h.p.loadState(); await h.p.measure(s, jobs); h.p.saveState(s);
  h.clock.t += 10 * MIN;
  fx.w('home/.local/state/usage/claude-usage.json', { at: h.clock.t - 30e3, seven_day: { used_percentage: 28, resets_at: CLAUDE_RESET / 1000 } });
  s = h.p.loadState(); const m = await h.p.measure(s, jobs);
  assert.equal(m.claude.usedPct, 30);
  assert.equal(m.claude.raised.from, 28);
  // just after the weekly reset: the station has a new-week reading, the feed still the old week's
  const t = CLAUDE_RESET + 10 * MIN;
  const fx2 = fixture({ feedPct: 96, feedAt: t - 2 * MIN, stationPct: 1, stationAt: t - 5 * MIN });
  fx2.w('.starnet-data/workspaces/.usage/subscriptions.json', { v: 1, providers: { 'claude-cli': { primary: { windows: [{ id: 'seven_day', usedPct: 1, resetsAt: CLAUDE_RESET + 7 * DAY }], seenAt: t - 5 * MIN } } } });
  const r = await measurePlan(make(fx2, station(jobs), { t }), jobs);
  assert.equal(r.m.claude.usedPct, 1); assert.equal(r.m.claude.day, 1); assert.equal(r.m.claude.open, true);
});

test('fix 3: company/state/emergency.json is checked on read (who, how long, a real flag for an automatic one)', async () => {
  const jobs = crewJobs();
  const iso = d => new Date(d).toISOString();
  const cases = [
    [{ active: true, why: 'x', by: 'Mallory', since: iso(T0 - HOUR), until: iso(T0 + 3 * HOUR) }, /Mallory/],
    [{ active: true, why: 'x', by: 'Alex', since: iso(T0 - HOUR), until: iso(T0 + 7 * DAY) }, /over the 12-hour limit/],
    [{ active: true, why: 'x', by: 'Alex', until: iso(T0 + 3 * HOUR) }, /no start time/],
    [{ active: true, why: 'x', by: 'Alex', since: iso(T0 + 2 * HOUR), until: iso(T0 + 3 * HOUR) }, /future/],
    [{ active: true, why: 'x', by: 'auto (competence.js)', auto: true, since: iso(T0 - HOUR), until: iso(T0 + 4 * HOUR) }, /serious flag/],
  ];
  for (const [em, re] of cases) {
    const r = await measurePlan(make(fixture({ feedPct: 29, emergency: em }), station(jobs)), jobs);
    assert.equal(r.m.emergency.active, false, JSON.stringify(em)); assert.match(r.m.emergency.invalid, re);
    assert.equal(r.m.claude.open, false);
  }
  let r = await measurePlan(make(fixture({ feedPct: 29, emergency: { active: true, why: 'prod down', by: 'Max (security)', since: iso(T0 - HOUR), until: iso(T0 + 3 * HOUR) } }), station(jobs)), jobs);
  assert.equal(r.m.emergency.active, true); assert.equal(r.m.claude.line, 90);
  const fx = fixture({ feedPct: 29, emergency: { active: true, why: 'flag', by: 'auto (competence.js)', auto: true, flag: 'ev-1', since: iso(T0 - HOUR), until: iso(T0 + 5 * HOUR) } });
  fx.w('company/work/people/competence.json', { serious: [{ id: 'ev-1', agent: 'deployer', severity: 'S1', signal: 's', at: iso(T0 - 2 * HOUR) }] });
  r = await measurePlan(make(fx, station(jobs)), jobs);
  assert.equal(r.m.emergency.active, true);
  // a tick says so once
  const h = make(fixture({ feedPct: 29, emergency: cases[0][0] }), station(jobs));
  await tick(h, jobs); h.clock.t += 10 * MIN; await tick(h, jobs);
  assert.equal(h.lines.filter(l => /EMERGENCY IGNORED/.test(l)).length, 1);
});

test('fix 4: off a closed subscription at once, a 1-point band before reopening, no flapping', async () => {
  const t = WEEK_START + 2 * DAY + HOUR;   // Claude day 3: line 41.86
  const jobs = crewJobs(), st = station(jobs);
  const fx = fixture({ feedPct: 30, feedAt: t - MIN, policy: { mode: 'live' } });
  const h = make(fx, st, { t, mm: mmBody(94, 10) });   // MiniMax hard-closed: only Claude and DeepSeek in play
  await tick(h, st.copy);
  assert.equal(st.copy.find(j => j.id === 'j-brief').provider, 'claude-cli');
  // 10 minutes later the meter passes the line: the routine leaves Claude now, not in an hour
  h.clock.t = t + 10 * MIN; fx.w('home/.local/state/usage/claude-usage.json', { at: h.clock.t - MIN, seven_day: { used_percentage: 43, resets_at: CLAUDE_RESET / 1000 } });
  let s = h.p.loadState(); let m = await h.p.measure(s, st.copy); let pl = h.p.plan(m, s, st.copy);
  const row = pl.rows.find(r => r.id === 'j-brief');
  assert.equal(row.action, 'switch'); assert.match(row.urgent, /Claude is closed to routines/);
  // a stale meter is the same: off at once
  fx.w('home/.local/state/usage/claude-usage.json', { at: t - 95 * MIN, seven_day: { used_percentage: 30, resets_at: CLAUDE_RESET / 1000 } });
  s = h.p.loadState(); m = await h.p.measure(s, st.copy); pl = h.p.plan(m, s, st.copy);
  assert.equal(pl.rows.find(r => r.id === 'j-brief').action, 'switch');
  // an oscillating meter around the line: few switches in 6 hours
  const fx2 = fixture({ feedPct: 41, feedAt: t - MIN, policy: { mode: 'live' } }), st2 = station(crewJobs());
  const h2 = make(fx2, st2, { t, mm: mmBody(94, 10) });
  let switches = 0;
  for (let i = 0; i < 36; i++) {
    h2.clock.t = t + i * 10 * MIN;
    fx2.w('home/.local/state/usage/claude-usage.json', { at: h2.clock.t - MIN, seven_day: { used_percentage: i % 2 ? 42.5 : 41.5, resets_at: CLAUDE_RESET / 1000 } });
    const before = st2.posts().length; await tick(h2, st2.copy);
    switches += st2.posts().slice(before).filter(c => c.body.id === 'j-fin').length;
  }
  assert.ok(switches <= 2, 'Finance loop switched ' + switches + ' times');
  const g = (await measurePlan(make(fixture({ feedPct: 41.5, feedAt: t - MIN }), station(crewJobs()), { t }), crewJobs())).m.claude;
  assert.equal(g.open, false); assert.match(g.why, /reopens only under 40.9%/);   // never open before: the band applies
});

test('fix 9: going live moves at most 2 routines an hour onto a subscription, in routing-table order', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const h = make(legacyFixture({ feedPct: 28, policy: { mode: 'live' } }), st);   // Claude closed, MiniMax open: brief, product, design want MiniMax
  await tick(h, st.copy);
  assert.deepEqual(st.posts().map(c => c.body.id).sort(), ['j-brief', 'j-prod']);
  h.clock.t += 30 * MIN;
  let s = h.p.loadState(); let m = await h.p.measure(s, st.copy); let pl = h.p.plan(m, s, st.copy);
  assert.equal(pl.rows.find(r => r.id === 'j-design').action, 'wait'); assert.match(pl.rows.find(r => r.id === 'j-design').wait, /ramp/);
  h.clock.t += 31 * MIN;
  await tick(h, st.copy);
  assert.ok(st.posts().some(c => c.body.id === 'j-design' && c.body.patch.provider === 'custom'));
  // 0 turns the ramp off
  const st2 = station(crewJobs());
  await tick(make(legacyFixture({ feedPct: 28, policy: { mode: 'live', routing: { maxOntoSubscriptionPerHour: 0 } } }), st2), st2.copy);
  assert.equal(st2.posts().length, 3);
});

test('fix 6: the third slot is lent only when the extra loop runs on a subscription with room', async () => {
  const run = async (order, designRanMinAgo) => {
    const jobs = crewJobs();
    if (designRanMinAgo != null) jobs.find(j => j.id === 'j-design').lastRunAt = new Date(T0 - designRanMinAgo * MIN).toISOString();
    const h = make(fixture({ feedPct: 28, policy: { mode: 'live', routing: { maxOntoSubscriptionPerHour: 0 } } }), station(jobs));
    return (await h.p.hook({ jobs, order, ownerWake: new Set(), maxPerTick: 2 })).extra;
  };
  // Claude closed, MiniMax with room: Engineering, Finance and Lee all stay on DeepSeek, so no slot is lent
  assert.equal(await run(['engineer', 'treasurer', 'cand-qa-lee']), 0);
  // the Design loop moves to MiniMax this tick (ramp off here), so the third slot wakes it
  assert.equal(await run(['engineer', 'treasurer', 'designer', 'cand-qa-lee']), 1);
  // ...unless it is in its 40-minute cooldown: the slot would go to Lee on DeepSeek
  assert.equal(await run(['engineer', 'treasurer', 'designer', 'cand-qa-lee'], 10), 0);
});

test('a second refusal of the same routine within 24 h: a 24 h block, and the run is still re-run once (never lost); refireWithinMin 0 no longer drops it; a paused routine is never re-run', async () => {
  const mk = (enabled, policy, runs) => {
    const jobs = crewJobs();
    Object.assign(jobs.find(j => j.id === 'j-prod'), { enabled, provider: 'claude-cli', model: 'claude-sonnet-5-5', wire: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
    runs = runs || [{ runId: 'r-ref', cronJobId: 'j-prod', provider: 'claude-cli', model: 'claude-sonnet-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
    const st = station(jobs);
    return { st, jobs, h: make(fixture({ feedPct: 5, runs, policy }), st) };
  };
  let x = mk(true, { mode: 'live' }, [
    { runId: 'r-ref-a', cronJobId: 'j-prod', provider: 'claude-cli', model: 'claude-sonnet-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 5 * HOUR - 10 * MIN, endedAt: T0 - 5 * HOUR },
    { runId: 'r-ref-b', cronJobId: 'j-prod', provider: 'claude-cli', model: 'claude-sonnet-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }]);
  await tick(x.h, x.st.copy);
  const b = readState({ root: x.h.p.root }).blocks;
  assert.equal(b.length, 1, JSON.stringify(b)); assert.equal(b[0].runId, 'r-ref-b'); assert.equal(b[0].until, T0 - 10 * MIN + 24 * HOUR); assert.equal(b[0].repeat, true);
  assert.deepEqual(x.st.fires, ['j-prod'], 'a repeat refusal is re-run once too: the run is never lost');
  const moves = fs.readFileSync(path.join(x.h.p.root, 'company/state/model-moves.jsonl'), 'utf8');
  const mv = moves.trim().split('\n').map(l => JSON.parse(l)).find(r => r.direction === 'refusal');
  assert.ok(mv && mv.door === 'routine' && mv.from === 'claude-cli/claude-sonnet-5-5' && mv.to && mv.to !== mv.from && mv.seat === 'drafter', 'the failover is recorded on the seat: ' + moves);
  assert.match(fs.readFileSync(path.join(x.h.p.root, 'company/state/models-state.json'), 'utf8'), /Claude declined this/);
  // refireWithinMin 0 (the old "never") no longer drops the run
  x = mk(true, { mode: 'live', routing: { refireWithinMin: 0 } });
  await tick(x.h, x.st.copy);
  assert.deepEqual(x.st.fires, ['j-prod']); assert.equal(readState({ root: x.h.p.root }).blocks[0].until, T0 - 10 * MIN + 2 * HOUR);
  // a paused routine is never re-run
  x = mk(false, { mode: 'live' });
  const s = x.h.p.loadState(); const m = await x.h.p.measure(s, x.st.copy); const pl = x.h.p.plan(m, s, x.st.copy);
  assert.match(pl.refires[0].status, /^skip: the routine is paused/);
  await x.h.p.apply(m, pl, s, x.st.copy);
  assert.deepEqual(x.st.fires, []);
});

test('a trial model\'s refusal (the router\'s one-run override) leaves out that model only: no provider block, no re-run on it, the router skips the arm', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-prod'), { provider: 'claude-cli', model: 'claude-sonnet-5-5', wire: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
  const runs = [{ runId: 'r-trial', cronJobId: 'j-prod', provider: 'claude-cli', model: 'claude-opus-5-5', requestedBy: 'override', override: { provider: 'claude-cli', model: 'claude-opus-5-5' }, outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
  const st = station(jobs); const h = make(fixture({ feedPct: 5, runs, policy: { mode: 'live' } }), st);
  await tick(h, st.copy);
  const b = readState({ root: h.p.root }).blocks;
  assert.equal(b.length, 1); assert.equal(b[0].trial, true); assert.equal(b[0].model, 'claude-opus-5-5');
  assert.deepEqual(st.fires, [], 'no re-run on the model that refused: the open items wake the seat on its own chain');
  const REF = require('../lib/refusal.js');
  assert.equal(REF.blockFor('j-prod', 'claude-cli', { root: h.p.root, now: T0 }), null, 'Claude is not blocked for the routine');
  assert.deepEqual(REF.trialRefusals('j-prod', { root: h.p.root, now: T0 }).map(x => x.model), ['claude-opus-5-5']);
  const R = require('../lib/routing.js');
  const K = R.knobs({ mode: 'live', order: ['trial'], trials: [{ id: 'tier-trial', status: 'running', class: 'general', entryShare: 1, scope: { seats: ['drafter'] }, arms: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }] }] });
  const items = [{ text: 'tidy the notes', title: 'notes' }];
  const free = R.decide({ K, seat: 'drafter', items, wakeId: 'w1', chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }], allow: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }] });
  const skip = R.decide({ K, seat: 'drafter', items, wakeId: 'w1', chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }], allow: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }], refused: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }] });
  assert.equal(free.source, 'trial', 'control: without the refusal the arm is assigned ' + JSON.stringify(free));
  assert.notEqual(skip.source, 'trial', JSON.stringify(skip));
  assert.ok(skip.reasons.some(r => /refused this routine recently/.test(r)), JSON.stringify(skip.reasons));
});

test('a content-filter refusal blocks only the model that refused: the same provider\'s other models stay open', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-prod'), { provider: 'claude-cli', model: 'opus', wire: { provider: 'claude-cli', model: 'opus' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
  const runs = [{ runId: 'r-cf', cronJobId: 'j-prod', provider: 'claude-cli', model: 'opus', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
  const st = station(jobs); const h = make(fixture({ feedPct: 5, runs, policy: { mode: 'live' } }), st);
  await tick(h, st.copy);
  const b = readState({ root: h.p.root }).blocks;
  assert.equal(b.length, 1); assert.equal(b[0].modelOnly, true); assert.equal(b[0].model, 'opus');
  const REF = require('../lib/refusal.js');
  const o = { root: h.p.root, now: T0 };
  assert.ok(REF.blockFor('j-prod', 'claude-cli', o, 'opus'), 'opus is blocked for the routine');
  assert.equal(REF.blockFor('j-prod', 'claude-cli', o, 'claude-sonnet-5-5'), null, 'sonnet is not');
  assert.equal(REF.blocksEntry(b[0], { provider: 'claude-cli', model: 'claude-sonnet-5-5' }), false);
  const A = require('../lib/admit.js');
  const ok = A.admit({ door: 'dispatch', kind: 'run', seat: 'drafter', jobId: 'j-prod', provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { root: h.p.root, now: T0, file: path.join(h.p.root, 'company/state/admit-log.jsonl') });
  const no = A.admit({ door: 'dispatch', kind: 'run', seat: 'drafter', jobId: 'j-prod', provider: 'claude-cli', model: 'opus' }, { root: h.p.root, now: T0, file: path.join(h.p.root, 'company/state/admit-log.jsonl') });
  assert.notEqual(ok.decision === 'hold' && /refusal block/.test(ok.reason), true, 'a start on sonnet is not held by the opus refusal: ' + ok.reason);
  assert.equal(no.decision, 'hold'); assert.match(no.reason, /refusal block/);
});

test('fix 10: deadlines: "no later than today", EOD, end of day and a missing Deadline count as due', () => {
  const noDl = '# inbox\n\n## 2026-11-15 18:38 from Casey — I leaked production secrets\n**Status:** OPEN\n\nRotate now.\n';
  const fx = fixture({ handoffs: { 'a.md': due('no later than today 18:00'), 'b.md': due('by end of day (EOD)'), 'c.md': due('end-of-day'), 'd.md': noDl,
    'e.md': due('whenever you have it; nothing here blocks tonight\'s run'), 'f.md': due('2026-11-16 12:00'), 'g.md': due('not today'), 'h.md': due('COB') } });
  const f = n => pacer.handoffsDueToday(path.join(fx.root, 'company/work/handoffs', n), T0).length;
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(n => f(n + '.md')), [1, 1, 1, 1, 0, 0, 0, 1]);
});

test('fix 11: status and plan only look (no log line, no event used up, no clock moved); the MiniMax limit still holds', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const runs = [{ runId: 'r-ref2', cronJobId: 'j-fin', provider: 'claude-cli', model: 'claude-opus-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 2 * HOUR, endedAt: T0 - HOUR }];
  const fx = fixture({ feedPct: 28, runs });
  let fetches = 0; const out = [];
  const o = { root: fx.root, home: fx.home, now: () => T0, call: st.call, fire: st.fire, print: l => out.push(l), fetchMiniMax: async () => { fetches++; return { ok: true, body: mmBody(94, 94) }; } };
  assert.equal(await pacer.cli(['status'], o), 0);
  assert.equal(await pacer.cli(['plan'], o), 0);
  assert.equal(fetches, 1);
  assert.ok(!fs.existsSync(path.join(fx.root, 'company/work/dispatch-log.md')));
  const saved = readState(fx);
  assert.equal(saved.minimax.reading.usedPct, 6);
  assert.ok(!saved.handled || !saved.handled['r-ref2']); assert.ok(!saved.blocks || !saved.blocks.length);
  assert.ok(out.join('\n').includes('Blocks:'));   // plan still shows the block it would record
  assert.equal(st.posts().length, 0);
  // a tick later records it, once
  const h = make(fx, st); await tick(h, jobs);
  assert.equal(readState(fx).blocks.length, 1);
  assert.equal(h.lines.filter(l => /BLOCK/.test(l)).length, 1);
});

test('fix 11: one writer at a time: a held lock makes the tick step aside; a stale one is taken', async () => {
  const jobs = crewJobs(), fx = fixture(), st = station(jobs);
  const lock = path.join(fx.root, 'company/state/pacer-state.json.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, '123');
  const h = make(fx, st);
  const busy = await h.p.withLock(async () => 1, 300);
  assert.equal(busy.busy, true);
  const old = (Date.now() - 5 * MIN) / 1000; fs.utimesSync(lock, old, old);
  const r = await tick(h, jobs);
  assert.equal(r.busy, undefined); assert.ok(readState(fx).last);
  assert.ok(!fs.existsSync(lock));
});

test('fix 12: a MiniMax answer that echoes the key never carries it into the state or the report', async () => {
  const KEY = 'sk-test-SECRET-0123456789';
  const fx = fixture();
  fx.w('.starnet-data/workspaces/.secrets/provider-keys.json', { providers: { custom: { key: KEY } } });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid key ' + KEY } }) });
  try {
    const jobs = crewJobs(), st = station(jobs);
    const h = make(fx, st, { extra: { fetchMiniMax: pacer.minimaxFetch(fx.root, 'https://example.invalid/remains') } });
    await tick(h, jobs);
    const txt = fs.readFileSync(path.join(fx.root, 'company/state/pacer-state.json'), 'utf8') + fs.readFileSync(path.join(fx.root, 'company/work/finance/ai-usage.md'), 'utf8') + h.lines.join('\n');
    assert.ok(!txt.includes(KEY)); assert.ok(txt.includes('[key]'));
  } finally { global.fetch = realFetch; }
});

test('fix 2: from 90% of the rail, live mode pauses scheduled DeepSeek routines (spares owner-wake, running and due work) and resumes them under 80%', async () => {
  const at = pct => ({ caps: { perDay: 25 }, day: { usd: null, estimatedUsd: 25 * pct / 100 }, live: 0 });
  const jobs = crewJobs();
  jobs.find(j => j.id === 'j-eng').inFlight = true;
  let budget = at(92);
  const st = station(jobs, null);
  const call = async (mth, p, b) => (mth === 'GET' && p === '/api/budget/status') ? { status: 200, body: JSON.stringify(budget) } : st.call(mth, p, b);
  const fx = fixture({ feedPct: 28, policy: { mode: 'live' }, handoffs: { 'to-sam.md': due('today') } });
  const h = make(fx, Object.assign({}, st, { call }), { mm: mmBody(94, 10) });   // MiniMax hard-closed, Claude over the line
  await tick(h, st.copy);
  const paused = st.posts().filter(c => c.body.patch.enabled === false).map(c => c.body.id).sort();
  assert.deepEqual(paused, ['j-brief', 'j-design', 'j-fin', 'j-health', 'j-lee']);   // not Ops (owner wake), Product (due today), Engineering (running), the unlisted routine
  assert.deepEqual(Object.keys(readState(fx).railPaused).sort(), paused);
  assert.ok(h.lines.some(l => /^PACE PAUSE "Finance loop" for the station rail/.test(l)));
  // still over 80%: stays paused, no new calls
  budget = at(84); h.clock.t += 10 * MIN; let n = st.posts().length; await tick(h, st.copy);
  assert.equal(st.posts().length, n);
  // under 80%: resumed
  budget = at(70); h.clock.t += 10 * MIN; n = st.posts().length; await tick(h, st.copy);
  assert.deepEqual(st.posts().slice(n).filter(c => c.body.patch.enabled === true).map(c => c.body.id).sort(), paused);
  assert.deepEqual(readState(fx).railPaused, {});
  // shadow: says so, changes nothing
  const st2 = station(crewJobs(), at(92)), fx2 = fixture({ feedPct: 28 });
  const h2 = make(fx2, st2, { mm: mmBody(94, 10) });
  await tick(h2, st2.copy);
  assert.equal(st2.posts().length, 0); assert.ok(h2.lines.some(l => /SHADOW would pause 7 scheduled DeepSeek routine/.test(l)), h2.lines.join('\n'));   // no running routine and no due handoff here: all but the owner-wake loop
});

test('fix 2: back in shadow, the pacer lifts only its own rail pauses; one somebody resumed is forgotten', async () => {
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-fin'), { enabled: false, state: 'paused' });
  const st = station(jobs, { caps: { perDay: 25 }, day: { estimatedUsd: 23 }, live: 0 });
  const fx = fixture({ feedPct: 28 });
  const h = make(fx, st, { mm: mmBody(94, 10) });
  const s = h.p.loadState(); s.railPaused = { 'j-fin': { at: T0 - HOUR, name: 'Finance loop' }, 'j-design': { at: T0 - HOUR, name: 'Design loop' } }; h.p.saveState(s);
  await tick(h, st.copy);
  assert.deepEqual(st.posts().map(c => [c.body.id, c.body.patch.enabled]), [['j-fin', true]]);   // Design was resumed by somebody: left alone
  assert.deepEqual(readState(fx).railPaused, {});
});

test('fix 2: the rail projection (percentages only) and its warning', async () => {
  const ledger = [];
  for (let i = 0; i < 18; i++) ledger.push({ ts: T0 - i * 10 * MIN - MIN, usd: 0.21, model: 'deepseek-flash' });   // about 5% of the rail an hour for 3 hours
  ledger.push({ ts: T0 - 20 * HOUR, usd: 2, model: 'deepseek-flash' });
  const spent = ledger.reduce((s, r) => s + r.usd, 0);
  const jobs = crewJobs();
  const h = make(fixture({ feedPct: 28, ledger }), station(jobs, { caps: { perDay: 25 }, day: { estimatedUsd: spent }, live: 0 }));
  await tick(h, jobs);
  const s = h.p.loadState(); const m = await h.p.measure(s, jobs);
  const pj = m.rail.projection;
  assert.ok(Math.abs(pj.pctPerHour - 5.04) < 0.01);
  assert.ok(pj.holdAt > T0 && pj.tripAt > pj.holdAt);
  assert.ok(h.lines.some(l => /^PACE RAIL WARNING: at the last 3 hours' pace/.test(l)));
  const report = fs.readFileSync(path.join(h.p.root, 'company/work/finance/ai-usage.md'), 'utf8');
  assert.ok(!/\$\s?\d/.test(report)); assert.match(report, /would reach 85% around/);
});

test('fix 5: restore puts routines back on their pre-pacer model and lifts the pacer\'s pauses; shadow alone does not', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const fx = fixture({ feedPct: 28, policy: { mode: 'live' } });
  const h = make(fx, st);
  await tick(h, st.copy);   // brief and product move to MiniMax
  assert.equal(st.copy.find(j => j.id === 'j-brief').provider, 'custom');
  assert.deepEqual(readState(fx).original['j-brief'], Object.assign({ provider: 'deepseek', model: 'deepseek-flash', name: 'Morning operating brief', at: T0 }));
  Object.assign(st.copy.find(j => j.id === 'j-fin'), { enabled: false, state: 'paused' });
  const s = h.p.loadState(); s.railPaused = { 'j-fin': { at: T0, name: 'Finance loop' } }; h.p.saveState(s);
  const out = [];
  assert.equal(await pacer.cli(['restore'], { root: fx.root, home: fx.home, now: () => T0, call: st.call, fire: st.fire, print: l => out.push(l), fetchMiniMax: async () => ({ ok: false }) }), 0);
  assert.equal(st.copy.find(j => j.id === 'j-brief').provider, 'deepseek');
  assert.equal(st.copy.find(j => j.id === 'j-prod').provider, 'deepseek');
  assert.equal(st.copy.find(j => j.id === 'j-fin').enabled, true);
  const after = readState(fx); assert.deepEqual(after.original, {}); assert.deepEqual(after.railPaused, {});
  assert.match(out.join('\n'), /ok   Morning operating brief: back on deepseek\/deepseek-flash/);
});

test('fix 14: the shadow "would move" line is not re-logged when a routine starts or ends; a short timeout says 0.2 s', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const h = make(fixture({ feedPct: 28 }), st);
  await tick(h, jobs);
  jobs.find(j => j.id === 'j-prod').inFlight = true; h.clock.t += 10 * MIN; await tick(h, jobs);
  jobs.find(j => j.id === 'j-prod').inFlight = false; h.clock.t += 10 * MIN; await tick(h, jobs);
  assert.equal(h.lines.filter(l => /SHADOW would move/.test(l)).length, 1);
  const lines = [], fx = fixture();
  await pacer.dispatchHook({ log: l => lines.push(l), order: [], timeoutMs: 200, pacer: { root: fx.root, home: fx.home, call: () => new Promise(() => {}), fetchMiniMax: () => new Promise(() => {}) } });
  assert.ok(lines.some(l => /no answer in 0.2 s/.test(l)));
});

/* ---- the rail line has three states, not one number ---- */
test('the rail line says NOT ARMED when caps.perDay is 0, names a null day when armed, and prints a percentage only when measured', async () => {
  // (a) no rail at all: "0% of the station's daily rail" reads as headroom and means the opposite
  let jobs = crewJobs(), st = station(jobs, { caps: { perDay: 0 }, day: null });
  let h = make(fixture({ feedPct: 28 }), st);
  let r = await measurePlan(h, jobs);
  await h.p.hook({ jobs, order: ['agent'], ownerWake: new Set(['agent']), maxPerTick: 2 });   // the gate line is written by hook()
  const g1 = h.lines.find(l => /DeepSeek rail/.test(l)) || '';
  assert.match(g1, /DeepSeek rail: NOT ARMED \(station caps\.perDay is 0 — nothing is capped\)/, h.lines.join('\n'));
  assert.ok(!/0% of the station/.test(g1), 'no percentage is printed when there is no rail');

  // (b) armed, but the station has no settled day: the percentage is a floor from in-flight runs, and says so
  jobs = crewJobs(); st = station(jobs, { caps: { perDay: 25 }, day: null, live: 0.4 });
  h = make(fixture({ feedPct: 28 }), st);
  r = await measurePlan(h, jobs);
  assert.equal(r.m.rail.dayNull, true);
  await h.p.hook({ jobs, order: ['agent'], ownerWake: new Set(['agent']), maxPerTick: 2 });
  const g2 = h.lines.find(l => /rail armed at/.test(l)) || '';
  assert.match(g2, /station day total is null \(accounting UNSETTLED_SPEND\), so the percentage covers in-flight runs only/, h.lines.join('\n'));

  // (c) a settled day still prints the measured percentage, so the two new states did not replace the old one
  jobs = crewJobs(); st = station(jobs, { caps: { perDay: 25 }, day: { usd: 5 }, live: 0 });
  h = make(fixture({ feedPct: 28 }), st);
  r = await measurePlan(h, jobs);
  assert.equal(r.m.rail.dayNull, false);
  await h.p.hook({ jobs, order: ['agent'], ownerWake: new Set(['agent']), maxPerTick: 2 });
  assert.ok(h.lines.some(l => /DeepSeek rail 20% of the station's daily rail/.test(l)), h.lines.join('\n'));
});

/* ---- 1-2-3 chains by scope ---- */
const dsUp = { fetchDeepSeek: async () => ({ ok: true, available: true }) };
const dsOut = { fetchDeepSeek: async () => ({ ok: true, available: false }) };

test('chains: each routine runs on the first open link of its scope, and code never lands on MiniMax', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(liveFixture({ feedPct: 10 }), station(jobs), { extra: dsUp }), jobs);   // everything open
  assert.equal(r.row('Engineering loop').to.provider, 'deepseek');      // actions: DeepSeek first
  assert.equal(r.row('Finance loop').to.provider, 'claude-cli');       // review: Claude first
  assert.equal(r.row('Ops loop').to.model, 'haiku');                   // the Claude link uses the routine's own tier
  assert.equal(r.row('Design loop').to.provider, 'claude-cli');        // design: Claude first (UI/UX)
  r = await measurePlan(make(liveFixture({ feedPct: 28 }), station(jobs), { extra: dsOut }), jobs);   // Claude over the daily line, DeepSeek empty, MiniMax open
  assert.equal(r.m.deepseek.open, false);
  assert.match(r.m.deepseek.why, /no credit/);
  for (const n of ['Engineering loop', 'Design loop', 'Lee loop', 'Tool health check']) {
    const row = r.row(n);
    assert.notEqual(row.to.provider, 'custom', n + ' must not move to MiniMax');
    assert.equal(row.none, true, n + ': nothing in its chain is open');
  }
  const prod = r.row('Product loop');
  assert.equal(prod.to.provider, 'custom'); assert.match(prod.why, /link 2 of the writing chain/);
  assert.match(prod.urgent, /DeepSeek is closed/, 'moving off an empty account never waits for the hourly limit or the ramp');
  const ops = r.row('Ops loop');
  assert.equal(ops.to.provider, 'claude-cli', 'Alex stays on Claude past the daily line');
  assert.match(ops.why, /keeps Claude past the daily line .*Claude stops at 95%/);
  r = await measurePlan(make(liveFixture({ feedPct: 10 }), station(jobs), { extra: dsOut }), jobs);   // Claude open, DeepSeek empty
  assert.equal(r.row('Engineering loop').to.model, 'claude-sonnet-5-5', 'actions link 2 is Claude');
});

test('chains: Alex\'s Claude reserve ends at the owner\'s 95% stop', async () => {
  const jobs = crewJobs();
  const r = await measurePlan(make(liveFixture({ feedPct: 96, stationPct: 96 }), station(jobs), { extra: dsOut }), jobs);
  assert.notEqual(r.row('Ops loop').to.provider, 'claude-cli');
  assert.equal(r.row('Ops loop').to.provider, 'custom', 'link 2 (MiniMax) takes Alex over');
});

test('chains: a routine that failed for credit closes DeepSeek; a later balance reading saying calls work reopens it', async () => {
  const jobs = crewJobs();
  const fin = jobs.find(j => j.id === 'j-fin');
  fin.lastError = 'openai-compatible http 402 - [type insufficient_balance_error; code invalid_request_error] Insufficient Balance (request_id: x)';
  fin.lastRunAt = new Date(T0 - 20 * MIN).toISOString();
  const fx = liveFixture({ feedPct: 28 });
  let r = await measurePlan(make(fx, station(jobs), { extra: { fetchDeepSeek: async () => ({ ok: false, error: 'DeepSeek balance check answered HTTP 500' }) } }), jobs);
  assert.equal(r.m.deepseek.open, false);
  assert.match(r.m.deepseek.why, /"Finance loop" failed for credit/);
  r = await measurePlan(make(fx, station(jobs), { t: T0 + 15 * MIN, extra: dsUp }), jobs);   // a top-up, read after the failure
  assert.equal(r.m.deepseek.open, true);
  assert.equal(r.row('Engineering loop').to.provider, 'deepseek');
});

test('chains: when nothing in a chain is open, live mode holds the wake-up and moves nobody onto a closed link', async () => {
  const jobs = crewJobs(), st = station(jobs);
  const fx = liveFixture({ feedPct: 28, policy: { mode: 'live' } });
  const h = make(fx, st, { mm: mmBody(94, 10), extra: dsOut });   // Claude over the daily line, MiniMax's 5-hour window closed, DeepSeek empty
  const order = ['agent', 'engineer', 'designer'];
  await h.p.hook({ jobs, order, ownerWake: new Set(), maxPerTick: 2 });
  assert.deepEqual(order, ['agent'], 'Alex runs on his Claude reserve; Jo and Kim wait');
  assert.ok(h.lines.some(l => /HOLD \(nothing in their 1-2-3 chain is open\)/.test(l)), h.lines.join('\n'));
  const ups = st.posts().filter(p => p.p === '/api/cron/update');
  assert.ok(ups.length >= 1 && ups.every(p => p.body.patch.provider === 'claude-cli'), JSON.stringify(ups));
});

test('MiniMax paced by its own limits: paceBy fiveHour ignores the daily line and stops at the owner\'s 100%', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture({ feedPct: 28 }), station(jobs), { mm: mmBody(0.5, 50) }), jobs);   // the week 99.5% used, day 7
  assert.equal(r.m.minimax.open, false, 'week pacing: over the day-7 line');
  r = await measurePlan(make(fixture({ feedPct: 28, policy: { minimax: { paceBy: 'fiveHour', fiveHourCloseBelowLeftPct: 0 } } }), station(jobs), { mm: mmBody(0.5, 3) }), jobs);
  assert.equal(r.m.minimax.open, true, 'fiveHour pacing: open until 100% of the week and of the window');
  assert.match(r.m.minimax.why, /paced by its own limits/);
  r = await measurePlan(make(fixture({ feedPct: 28, policy: { minimax: { paceBy: 'fiveHour', fiveHourCloseBelowLeftPct: 0 } } }), station(jobs), { mm: mmBody(0, 50) }), jobs);
  assert.equal(r.m.minimax.open, false, 'the week used up closes it');
});

test('chains: the DeepSeek balance check keeps only whether calls are possible, never the amount', async () => {
  const jobs = crewJobs();
  const fx = liveFixture({ feedPct: 28 });
  fx.w('.starnet-data/workspaces/.secrets/provider-keys.json', { providers: { deepseek: { key: 'sk-test-not-real' } } });
  const real = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, o) => { seen.push({ url: String(url), auth: o && o.headers && o.headers.Authorization }); return { ok: true, status: 200, text: async () => JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '123.45' }] }) }; };
  try {
    const h = make(fx, station(jobs));
    await h.p.hook({ jobs, order: [], ownerWake: new Set(), maxPerTick: 2 });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /api\.deepseek\.com\/user\/balance/);
    const all = h.lines.join('\n') + fs.readFileSync(path.join(fx.root, 'company/state/pacer-state.json'), 'utf8') + fs.readFileSync(path.join(fx.root, 'company/work/finance/ai-usage.md'), 'utf8');
    assert.ok(!/123\.45/.test(all), 'no balance amount in state, log or report');
    assert.ok(!/sk-test-not-real/.test(all), 'no key anywhere');
  } finally { globalThis.fetch = real; }
});

test('chains: a scope with a bad chain is reported, and its routines keep the older rule', async () => {
  const mp = JSON.parse(LIVE_POLICY());
  mp.routing.scopes.actions.chain = ['deepseek', 'gpt'];
  const jobs = crewJobs();
  const r = await measurePlan(make(fixture({ feedPct: 28, modelPolicy: JSON.stringify(mp) }), station(jobs), { extra: dsUp }), jobs);
  assert.ok(r.pl.problems.some(p => /scope "actions" needs a chain/.test(p)), r.pl.problems.join('\n'));
  assert.ok(r.pl.problems.some(p => /routine "Engineering loop" names scope "actions"/.test(p)));
});

test('chains: a routine on a family its chain does not name moves at once, and parks where it cannot spend', async () => {
  const jobs = crewJobs();
  for (const j of jobs) { j.provider = 'custom'; j.model = 'MiniMax-M3.1-Flash'; j.wire = { provider: 'custom', model: 'MiniMax-M3.1-Flash', source: 'routine' }; }
  const st = station(jobs);
  const fx = liveFixture({ feedPct: 28 });
  const h = make(fx, st, { extra: dsOut });
  const s = h.p.loadState();
  for (const j of jobs) s.routines[j.id] = { lastSwitchAt: T0 - 5 * MIN, from: { provider: 'deepseek' }, to: { provider: 'custom' } };   // all just moved
  const m = await h.p.measure(s, jobs), pl = h.p.plan(m, s, jobs), row = n => pl.rows.find(r => r.name.startsWith(n));
  const eng = row('Engineering loop');
  assert.equal(eng.action, 'switch', 'MiniMax is not in the actions chain: no hourly wait');
  assert.match(eng.urgent, /MiniMax is not in the actions chain/);
  assert.equal(eng.to.provider, 'deepseek', 'parked on the empty DeepSeek account, not on Claude past the daily line');
  assert.match(eng.why, /parked on DeepSeek, which cannot spend/);
  assert.equal(row('Design loop').to.provider, 'deepseek');
  const ops = row('Ops loop');
  assert.equal(ops.action, 'switch', 'Alex goes back onto Claude without waiting');
  assert.equal(ops.to.provider, 'claude-cli');
  assert.equal(row('Product loop').action, 'stay', 'MiniMax is in the writing chain');
});

test('no Claude daily line until claude.dailyLineFrom; then the line applies, and 95% is always the stop', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture({ feedPct: 28, policy: { claude: { dailyLineFrom: new Date(T0 + DAY).toISOString() } } }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, true, 'day 1 at 28%: open while the daily line is off');
  assert.match(r.m.claude.why, /daily line is off until .*claude\.dailyLineFrom/);
  r = await measurePlan(make(fixture({ feedPct: 96, stationPct: 96, policy: { claude: { dailyLineFrom: new Date(T0 + DAY).toISOString() } } }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false, 'past the 95% stop');
  r = await measurePlan(make(fixture({ feedPct: 28, policy: { claude: { dailyLineFrom: new Date(T0 - HOUR).toISOString() } } }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false, 'after the reset the daily line is back');
});

/* ---- shareOfAccount: a second company on the same subscription account ---- */
test('shareOfAccount scales the daily line (k x 100 x fraction x share - margin) and never the hard stop', async () => {
  const jobs = crewJobs();
  // day 1 at 10% used: the full line is 13.3%, so Claude is open; at half the account the line is 6.1%, so it closes
  let r = await measurePlan(make(fixture({ feedPct: 10, stationPct: 10 }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, true);
  assert.ok(Math.abs(r.m.claude.line - pacer.lineFor(1, 1 / 7, 1)) < 1e-9);
  r = await measurePlan(make(fixture({ feedPct: 10, stationPct: 10, policy: { shareOfAccount: 0.5 } }), station(jobs)), jobs);
  assert.ok(Math.abs(r.m.claude.line - pacer.lineFor(1, 0.5 / 7, 1)) < 1e-9, String(r.m.claude.line));
  assert.equal(r.m.claude.open, false);
  assert.match(r.m.claude.why, /over today's line/);
  // a per-subscription share wins over the top-level one
  r = await measurePlan(make(fixture({ feedPct: 10, stationPct: 10, policy: { shareOfAccount: 0.5, claude: { shareOfAccount: 1 } } }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, true);
  // an emergency still lifts to its ceiling, and the hard stop is not scaled
  const p = pacer.loadPolicy(fixture({ policy: { shareOfAccount: 0.5 } }).root);
  assert.equal(p.claude.shareOfAccount, 0.5); assert.equal(p.minimax.shareOfAccount, 0.5); assert.equal(p.claude.weekCloseAtUsedPct, 95);
  assert.equal(pacer.loadPolicy(fixture({ policy: { shareOfAccount: 7 } }).root).shareOfAccount, 1, 'an unusable share falls back to 1');
});

test('emergency.allowedBy names functions: whoever holds ceo or risk in loops.json, by name or station id', () => {
  const h = make(fixture({ feedPct: 20 }), station(crewJobs()));
  assert.equal(h.p.emergencyOn({ why: 'x', by: 'auditor', hours: 1 }).ok, true);   // station id of the risk holder
  assert.equal(h.p.emergencyOn({ why: 'x', by: 'Sam', hours: 1 }).ok, false);
  const err = h.p.emergencyOn({ why: 'x', by: 'Sam', hours: 1 }).error;
  assert.match(err, /alex/); assert.match(err, /max/);
});

/* ---- self-governance and the spendCap guardrail ---- */
test('spendCap guardrail off: a Claude over its daily line stays open, says what would have happened, logs it once', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture({ feedPct: 28 }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false);   // guardrail on (no file: fail closed): the line holds
  const h = make(fixture({ feedPct: 28, guards: { spendCap: false } }), station(jobs));
  const s = h.p.loadState();
  const m = await h.p.measure(s, jobs);
  assert.equal(m.claude.open, true); assert.equal(m.claude.spendCapOff, true);
  assert.match(m.claude.why, /spendCap guardrail is off/); assert.match(m.claude.wouldHave, /over today's line/);
  await h.p.measure(s, jobs);
  assert.equal(h.lines.filter(l => /SPENDCAP OFF: Claude Max/.test(l)).length, 1);
});
test('spendCap guardrail off: a provider\'s own refusal (rejected) still closes Claude', async () => {
  const jobs = crewJobs();
  const r = await measurePlan(make(fixture({ feedPct: 5, stationPct: 5, stationStatus: 'rejected', stationAt: T0 - MIN, guards: { spendCap: false } }), station(jobs)), jobs);
  assert.equal(r.m.claude.open, false); assert.ok(!r.m.claude.spendCapOff);
});
test('emergency by hand under self-governance: budget at approve files one owner question and waits; a yes lets it start', async () => {
  const fx = fixture({ feedPct: 29, budgetLevel: 'approve' }), jobs = crewJobs();
  const h = make(fx, station(jobs));
  const a1 = h.p.emergencyOn({ why: 'production API down (S0)', by: 'Max', hours: 4 });
  const a2 = h.p.emergencyOn({ why: 'production API down (S0)', by: 'Max', hours: 4 });
  assert.equal(a1.ok, false); assert.match(a1.error, /budget is at approve/); assert.equal(a1.governance.questionId, a2.governance.questionId);
  assert.ok(!fs.existsSync(path.join(fx.root, 'company/state/emergency.json')));
  require('../lib/pm-inbox-guard').append(path.join(fx.root, 'company/pm-inbox.jsonl'), { type: 'answer', id: a1.governance.questionId, a: 'yes', by: 'Commander' }, 'selftest');
  assert.equal(h.p.emergencyOn({ why: 'production API down (S0)', by: 'Max', hours: 4 }).ok, true);
});
test('emergency by hand at notify starts at once and tells the owner', async () => {
  const fx = fixture({ feedPct: 29, budgetLevel: 'notify' }), jobs = crewJobs();
  const h = make(fx, station(jobs));
  assert.equal(h.p.emergencyOn({ why: 'production API down (S0)', by: 'Max', hours: 4 }).ok, true);
  assert.match(fs.readFileSync(path.join(fx.root, 'company/owner/digest.jsonl'), 'utf8'), /Max decided to let the crew use more of its AI subscriptions than usual for the next 4 hours/);   // an FYI (lib/owner-notice.js)
});
// Per-seat model chains (company/tools/models.js): the pacer leaves a chained seat's routines alone, and its hook
// tick hands its measurement to models.js, which moves the seat down its chain when a link closes.
test('a seat with its own model chain: plan leaves its routine alone; the hook fails it over when Claude closes, and back', async () => {
  const mp = JSON.parse(LEGACY_POLICY);
  mp.seats = { engineer: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } };
  mp.failover = { recoverAfterMin: 0, upAtMostEveryMin: 0 };
  const jobs = crewJobs().map(j => j.agentId === 'engineer' ? Object.assign(j, { provider: 'claude-cli', model: 'claude-sonnet-5-5', wire: { provider: 'claude-cli', model: 'claude-sonnet-5-5', source: 'routine' } }) : j);
  const fx = fixture({ feedPct: 95, stationPct: 95, modelPolicy: JSON.stringify(mp), policy: { mode: 'shadow' } });
  const st = station(jobs);
  const base = st.call;
  const sent = [];
  st.call = async (method, p, body) => {
    if (p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: [{ id: 'claude-cli', configured: true }, { id: 'deepseek', configured: true }] }) };
    if (p === '/api/agent/model') { sent.push(body); return { status: 200, body: '{"ok":true,"via":"roster"}' }; }
    return base(method, p, body);
  };
  const h = make(fx, st);
  const r = await measurePlan(h, st.copy);
  assert.ok(!r.pl.rows.some(x => x.name === 'Engineering loop'), 'the chained seat is not in the pacer plan');
  assert.ok(r.pl.untouched.some(x => x.name === 'Engineering loop' && x.seatChain));
  await tick(h, st.copy);   // Claude is over the line (95%): the seat falls to DeepSeek even with the pacer in shadow
  const eng = () => st.copy.find(j => j.id === 'j-eng');
  assert.equal(eng().provider, 'deepseek'); assert.equal(sent[0].provider, 'deepseek');
  assert.ok(h.lines.some(l => /MODELS MOVE Jo claude-cli\/claude-sonnet-5-5 -> deepseek\/deepseek-flash/.test(l)), h.lines.join('\n'));
  // the fixture's engineer has no manager: the owner hears it once (a seat with a manager gets an OPEN handoff)
  assert.match(fs.readFileSync(path.join(fx.root, 'company/owner/digest.jsonl'), 'utf8'), /Jo fell to the last model in their chain/);   // an FYI (lib/owner-notice.js)
  // Claude reopens (two hours on, a fresh low reading; the 95% one is stale): back to the primary
  h.clock.t = T0 + 2 * HOUR;
  fs.writeFileSync(path.join(fx.root, 'home/.local/state/usage/claude-usage.json'), JSON.stringify({ at: h.clock.t - MIN, seven_day: { used_percentage: 5, resets_at: CLAUDE_RESET / 1000 } }));
  fs.writeFileSync(path.join(fx.root, '.starnet-data/workspaces/.usage/subscriptions.json'), JSON.stringify({ v: 1, providers: {} }));
  await tick(h, st.copy);
  assert.equal(eng().provider, 'claude-cli', h.lines.join('\n'));
  const mv = fs.readFileSync(path.join(fx.root, 'company/state/model-moves.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(mv.map(x => x.direction), ['down', 'up']);
});

// The subscription cutoffs are the owner's decisions (lib/pacing-ask.js): the live pacer asks once on Today, the
// answer goes through the recorded `pacer.js limit` path, and at auto/notify it is an FYI that does not wait.
const PA = require('../lib/pacing-ask.js');
const inboxRows = root => { try { return fs.readFileSync(path.join(root, 'company/pm-inbox.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
const pacerAsks = root => inboxRows(root).filter(r => r.type === 'ask' && /^pacing:/.test(r.about || ''));
const readPol = root => JSON.parse(fs.readFileSync(path.join(root, 'company/work/finance/pacing-policy.json'), 'utf8'));
const heldTick = h => { const jobs = crewJobs(); return h.p.hook({ jobs, order: ['agent', 'engineer', 'designer'], ownerWake: new Set(), maxPerTick: 2 }); };
function heldFixture(o) {
  const jobs = crewJobs(), st = station(jobs);
  const fx = liveFixture(Object.assign({ feedPct: 28, policy: { mode: 'live' } }, o || {}));
  return { fx, st, h: make(fx, st, { mm: mmBody(94, 10), extra: dsOut }) };
}
test('cutoffs: a held seat makes the live pacer ask the owner ONCE, with two sliders and three buttons; deduped by subscription and week', async () => {
  const { fx, st, h } = heldFixture({ budgetLevel: 'approve' });
  await heldTick(h);
  let asks = pacerAsks(fx.root);
  assert.equal(asks.length, 1, h.lines.join('\n'));
  const q = asks[0];
  assert.equal(q.about, 'pacing:claude'); assert.equal(q.blocking, true); assert.equal(q.from, 'Pacer');
  assert.match(q.message, /^Claude is 28% used this week and resets \w+ \d\d:\d\d\. The company's routines are paused on Claude for today\. How much of this week's Claude may routines use\?$/);
  const [stop, spread] = q.form.fields;
  assert.equal(stop.type, 'slider'); assert.equal(stop.min, 28); assert.equal(stop.max, 100); assert.equal(stop.value, 95);
  assert.match(stop.say, /Let routines use up to \{value\}% of this week's Claude/);
  assert.equal(spread.type, 'slider'); assert.equal(spread.minLabel, 'Spread evenly'); assert.equal(spread.maxLabel, 'Use it now');
  assert.deepEqual(q.form.actions.map(a => a.label), ['Set', 'Keep paused', 'Use another model meanwhile']);
  assert.ok(h.lines.some(l => /PACER ASK q-\d+ \(waits for the owner\)/.test(l)), h.lines.join('\n'));
  // the same situation on later ticks: no second question (one open at a time; and deduped by week)
  h.clock.t += 10 * MIN; await heldTick(make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut }));
  h.clock.t += 10 * MIN; await heldTick(make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut }));
  assert.equal(pacerAsks(fx.root).length, 1);
  // closed by the owner without an answer: still not asked again this week while nothing changes
  require('../lib/pm-inbox-guard').append(path.join(fx.root, 'company/pm-inbox.jsonl'), { type: 'close', id: q.id, at: new Date().toISOString(), by: 'Commander' }, 'selftest');
  h.clock.t += 10 * MIN; await heldTick(make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut }));
  assert.equal(pacerAsks(fx.root).length, 1);
  // a material change (the week rises by 15+ points): asked again
  fs.writeFileSync(path.join(fx.root, 'home/.local/state/usage/claude-usage.json'), JSON.stringify({ at: h.clock.t + 9 * MIN, seven_day: { used_percentage: 45, resets_at: CLAUDE_RESET / 1000 } }));
  h.clock.t += 10 * MIN; await heldTick(make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut }));
  asks = pacerAsks(fx.root);
  assert.equal(asks.length, 2); assert.match(asks[1].message, /Claude is 45% used/);
});
test('cutoffs: shadow mode never asks (nothing is held)', async () => {
  const { fx, h } = heldFixture({ policy: { mode: 'shadow' }, budgetLevel: 'approve' });
  await heldTick(h);
  assert.equal(pacerAsks(fx.root).length, 0);
});
test('cutoffs: the owner\'s Set is applied through the recorded path (provenance, changes, dispatch log), takes effect on the next tick, and locked-watch stays quiet', async () => {
  const { fx, st, h } = heldFixture({ budgetLevel: 'approve' });
  const prevProv = process.env.PROVENANCE_ROOT; process.env.PROVENANCE_ROOT = fx.root;
  const P = require('../provenance.js'); const pin = P.underStation(); P.pinUnderStation(false);
  const LW = require('../locked-watch.js');
  const C = now => ({ root: fx.root, home: fx.home, now, log: () => {}, underStation: false, jobs: [] });
  try {
    assert.ok((await LW.tick(C(Date.now()))).initialized, 'locked-watch baseline');
    await heldTick(h);
    const q = pacerAsks(fx.root)[0];
    const ib = (() => { process.env.PM_INBOX_FILE = path.join(fx.root, 'company/pm-inbox.jsonl'); return require('../inbox.js'); })();
    try { ib.answer({ id: q.id, by: 'Commander', answer: { action: 'set', values: { weekstop: 90, usenow: 100 } }, quiet: true }); } finally { delete process.env.PM_INBOX_FILE; }
    h.clock.t += 10 * MIN;
    const h2 = make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut });
    await heldTick(h2);   // this tick applies the answer
    const pol = readPol(fx.root);
    assert.equal(pol.claude.weekCloseAtUsedPct, 90); assert.equal(pol.claude.useNowPct, 100);
    assert.equal(pol.claude.ownerSet.via, q.id); assert.equal(pol.claude.ownerSet.choice, 'set');
    assert.match(pol.changes[pol.changes.length - 1].what, /Claude week stop 95% -> 90%, use-now 0% -> 100%/);
    assert.ok(h2.lines.some(l => /PACER LIMIT applied q-\d+: week stop 95% -> 90%/.test(l)), h2.lines.join('\n'));
    const prov = fs.readFileSync(path.join(fx.root, 'company/state/locked/provenance.jsonl'), 'utf8');
    assert.match(prov, /"file":"company\/work\/finance\/pacing-policy.json","kind":"write".*"writer":"pacer.js"/);
    assert.match(fs.readFileSync(path.join(fx.root, 'company/work/dispatch-log.md'), 'utf8'), /PACER LIMIT Claude: week stop 95% -> 90%/);
    // the next tick: today's line is the stop (use it now), so Claude is open again and nobody is held or asked
    h.clock.t += 10 * MIN;
    const h3 = make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut });
    const r = await measurePlan(h3, crewJobs());
    assert.equal(r.m.claude.open, true, r.m.claude.why); assert.equal(Math.round(r.m.claude.line), 90);
    await heldTick(h3);
    assert.equal(pacerAsks(fx.root).length, 1, 'the owner decided this week: not asked again');
    const lw = await LW.tick(C(Date.now() + 60e3));
    assert.ok(!lw.events.some(e => e.key === 'company/work/finance/pacing-policy.json'), JSON.stringify(lw.events));
    // a hand edit of the same file is still flagged
    const f = path.join(fx.root, 'company/work/finance/pacing-policy.json'); const pol2 = readPol(fx.root); pol2.claude.weekCloseAtUsedPct = 100; fs.writeFileSync(f, JSON.stringify(pol2));
    const lw2 = await LW.tick(C(Date.now() + 120e3));
    assert.ok(lw2.events.some(e => e.key === 'company/work/finance/pacing-policy.json' && e.kind === 'flagged'), JSON.stringify(lw2.events));
  } finally { P.pinUnderStation(pin); if (prevProv === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prevProv; }
});
test('cutoffs: Keep paused and Use another model meanwhile are recorded; the second hands the people seat an OPEN handoff', async () => {
  for (const action of ['keep', 'other']) {
    const { fx, st, h } = heldFixture({ budgetLevel: 'approve' });
    await heldTick(h);
    const q = pacerAsks(fx.root)[0];
    process.env.PM_INBOX_FILE = path.join(fx.root, 'company/pm-inbox.jsonl');
    try { require('../inbox.js').answer({ id: q.id, by: 'Commander', answer: { action }, quiet: true }); } finally { delete process.env.PM_INBOX_FILE; }
    h.clock.t += 10 * MIN; await heldTick(make(fx, st, { t: h.clock.t, mm: mmBody(94, 10), extra: dsOut }));
    const pol = readPol(fx.root);
    assert.equal(pol.claude.weekCloseAtUsedPct === undefined ? 95 : pol.claude.weekCloseAtUsedPct, 95);
    assert.equal(pol.claude.ownerSet.choice, action === 'keep' ? 'keep' : 'other-model');
    if (action === 'other') {
      const hand = fs.readdirSync(path.join(fx.root, 'company/work/handoffs')).map(n => fs.readFileSync(path.join(fx.root, 'company/work/handoffs', n), 'utf8')).join('\n');
      assert.match(hand, /from Pacer — give .* a model to use while Claude is paused[\s\S]*\*\*Status:\*\* OPEN/);
    }
  }
});
test('cutoffs: at Autonomous (budget auto) the pacer decides alone, files a non-blocking FYI with the same sliders, tells the owner, and does not wait', async () => {
  const { fx, h } = heldFixture({ budgetLevel: 'auto' });
  const r = await heldTick(h);
  const q = pacerAsks(fx.root)[0];
  assert.ok(q && q.blocking === false && q.batch === 'fyi', JSON.stringify(q));
  assert.match(q.message, /You let the company decide pacing, so it keeps its current cutoffs/);
  assert.equal(q.form.fields[0].type, 'slider'); assert.deepEqual(q.form.actions.map(a => a.id), ['set', 'keep', 'other']);
  // the owner's plain line: the daily digest (lib/owner-notice.js), never at once; no question id in it
  const told = fs.readFileSync(path.join(fx.root, 'company/owner/digest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).map(r => r.text).join('\n');
  assert.match(told, /Claude is 28% used this week/); assert.doesNotMatch(told, /FYI:/); assert.doesNotMatch(told, /q-\d{6}/);   // the question id may ride in technical only
  assert.doesNotMatch(q.details, /pacing-policy\.json|pacer\.js|console:#/); assert.match(q.technical, /pacer\.js limit/);
  assert.ok(h.lines.some(l => /PACER ASK q-\d+ \(FYI/.test(l)), h.lines.join('\n'));
  assert.ok(r && typeof r.extra === 'number', 'the tick returns at once');
});
test('cutoffs: pacer.js limit is the recorded write; the owner always, the CEO only when budget is the company\'s', async t => {
  const fx = fixture({ budgetLevel: 'approve' });
  const out = []; const print = s => out.push(s);
  const owner = (require('../lib/company').config.owner || {}).name || 'owner';
  const P = require('../provenance.js'); const pin = P.underStation(); P.pinUnderStation(false);   // measure the tool, not the caller
  P.pinOwnerShell(true);   // the owner's own shell, also when CI or an agent runs the suite (no tty, no owner shell there)
  t.after(() => { P.pinUnderStation(pin); P.pinOwnerShell(null); });
  assert.equal(await pacer.cli(['limit', 'claude', '--week-stop', '80', '--by', 'Alex', '--why', 'more room'], { root: fx.root, print }), 3);
  assert.match(JSON.parse(out.pop()).error, /budget is at "approve"/);
  assert.equal(await pacer.cli(['limit', 'claude', '--week-stop', '180', '--by', owner, '--why', 'x'], { root: fx.root, print }), 2);
  assert.equal(await pacer.cli(['limit', 'claude', '--week-stop', '80', '--use-now', '50', '--by', owner, '--why', 'set in the console'], { root: fx.root, print }), 0, out.join('\n'));
  let pol = readPol(fx.root); assert.equal(pol.claude.weekCloseAtUsedPct, 80); assert.equal(pol.claude.useNowPct, 50); assert.equal(pol.claude.ownerSet.by, owner);
  const fx2 = fixture({ budgetLevel: 'auto' });
  assert.equal(await pacer.cli(['limit', 'minimax', '--week-stop', '90', '--by', 'Alex', '--why', 'leave room'], { root: fx2.root, print }), 0, out.join('\n'));
  pol = readPol(fx2.root); assert.equal(pol.minimax.weekCloseAtUsedPct, 90); assert.equal(pol.minimax.companySet.by, 'Alex'); assert.ok(!pol.minimax.ownerSet);
  // useNowPct moves today's line from the even line to the stop
  const h = make(fx, station(crewJobs()));
  const m = (await measurePlan(h, crewJobs())).m;
  assert.equal(Math.round(m.claude.line * 10) / 10, Math.round((pacer.lineFor(1, 1 / 7, 1) + (80 - pacer.lineFor(1, 1 / 7, 1)) * 0.5) * 10) / 10);
});

/* ---- Sprint (start-up, cadence.js tempo.sprint) never loosens the pacer ---- */
test('Sprint on changes nothing in the pacer: the Claude weekly stop at 95% and the station-rail hold still apply', async () => {
  const sprintOn = { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, tempo: { mode: 'bounded-auto', sprint: { on: true, since: new Date(T0 - HOUR).toISOString(), until: null, by: 'owner' } }, seats: {} };
  const measureWith = async sprint => {
    const jobs = crewJobs(); const fx = legacyFixture({ feedPct: 96, stationPct: 96 });
    if (sprint) fx.w('company/work/ops/cadence.json', sprintOn);
    const r = await measurePlan(make(fx, station(jobs)), jobs);
    return { open: r.m.claude.open, why: r.m.claude.why, rows: r.pl.rows.map(x => [x.name, x.action, x.to && x.to.provider]) };
  };
  const off = await measureWith(false), on = await measureWith(true);
  assert.equal(on.open, false, 'Claude past its weekly stop is closed with Sprint on');
  assert.deepEqual(on, off);
  const budget = { caps: { perDay: 25 }, day: { usd: null, estimatedUsd: 21.5, cap: 25 }, live: 0.3 };
  const handoffs = { 'to-kim.md': due('2026-11-20 12:00'), 'to-jo.md': due('today'), 'to-pat.md': due('2026-11-17') };
  const jobs = crewJobs(), st = station(jobs, budget);
  const fx = fixture({ feedPct: 28, handoffs, policy: { mode: 'live' } });
  fx.w('company/work/ops/cadence.json', sprintOn);
  const h = make(fx, st, { mm: mmBody(94, 10) });
  const order = ['agent', 'engineer', 'designer', 'treasurer', 'cand-qa-lee'];
  await h.p.hook({ jobs, order, ownerWake: new Set(['agent']), maxPerTick: 7 });   // Sprint's maxPerTick: every seat
  assert.deepEqual(order, ['agent', 'engineer'], 'near the rail the pacer still drops the metered wakes with nothing due');
});

test('the MiniMax usage URL follows the company region (company.json providers.minimax); an explicit policy URL wins', () => {
  const MME = require('../lib/minimax-endpoint');
  // no region stored = Global, today's behaviour (also when the policy still holds the old built-in URL)
  let fx = fixture({ policy: { minimax: { url: 'https://www.minimax.io/v1/token_plan/remains' } } });
  assert.equal(pacer.loadPolicy(fx.root).minimax.url, MME.REGIONS.global.usageUrl);
  fx = fixture();
  assert.equal(pacer.loadPolicy(fx.root).minimax.url, MME.REGIONS.global.usageUrl, 'no url and no region = Global');
  // Mainland China: the old default URL in the policy file is not an override
  fx = fixture({ policy: { minimax: { url: 'https://www.minimax.io/v1/token_plan/remains' } } });
  fx.w('company/company.json', { name: 'X', providers: { minimax: { region: 'cn' } } });
  let p = pacer.loadPolicy(fx.root);
  assert.equal(p.minimax.url, 'https://api.minimaxi.com/v1/token_plan/remains'); assert.match(p.minimax.urlFrom, /cn/);
  // a custom endpoint: its origin's token_plan/remains
  fx.w('company/company.json', { name: 'X', providers: { minimax: { region: 'custom', baseUrl: 'https://mm-proxy.minimax.io/v1' } } });
  assert.equal(pacer.loadPolicy(fx.root).minimax.url, 'https://mm-proxy.minimax.io/v1/token_plan/remains');
  // an explicit non-default URL in pacing-policy.json is an override and wins over the region
  fx = fixture({ policy: { minimax: { url: 'https://usage.example.test/remains' } } });
  fx.w('company/company.json', { name: 'X', providers: { minimax: { region: 'cn' } } });
  p = pacer.loadPolicy(fx.root);
  assert.equal(p.minimax.url, 'https://usage.example.test/remains'); assert.match(p.minimax.urlFrom, /pacing-policy/);
  // a broken stored entry falls back to Global instead of stopping the pacer
  fx = fixture(); fx.w('company/company.json', { name: 'X', providers: { minimax: { region: 'custom', baseUrl: 'http://plain.minimax.io/v1' } } });
  assert.equal(pacer.loadPolicy(fx.root).minimax.url, MME.REGIONS.global.usageUrl);
});

test('one authority for a refusal block: a seat with its own chain is refused on Claude -> re-run on DeepSeek in the same tick -> its next scheduled runs use DeepSeek until the block ends; admit() holds a start on Claude meanwhile', async () => {
  const mp = REAL_POLICY(); mp.seats = { drafter: { chain: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } };
  mp.allowed['claude-cli'].models = Array.from(new Set((mp.allowed['claude-cli'].models || []).concat(['claude-opus-5-5'])));
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-prod'), { provider: 'claude-cli', model: 'claude-opus-5-5', wire: { provider: 'claude-cli', model: 'claude-opus-5-5', source: 'routine' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
  const runs = [{ runId: 'r-opus', cronJobId: 'j-prod', agentId: 'drafter', provider: 'claude-cli', model: 'claude-opus-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', reason: 'refused', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
  const st = station(jobs);
  const base = st.call;
  st.call = async (method, p, body) => {   // the station's provider list and roster model, which models.js uses
    if (method === 'GET' && p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: [{ id: 'claude-cli', configured: true }, { id: 'deepseek', configured: true }] }) };
    if (method === 'POST' && p === '/api/agent/model') return { status: 200, body: '{"ok":true,"via":"roster"}' };
    return base(method, p, body);
  };
  const fx = fixture({ feedPct: 5, runs, policy: { mode: 'live' }, modelPolicy: JSON.stringify(mp) });
  const h = make(fx, st);
  const prov = () => st.copy.find(j => j.id === 'j-prod').provider;
  // tick 1: the refusal is read, the block written, models.js moves the seat off Claude, and the run is re-run on DeepSeek now
  await tick(h, st.copy);
  const s1 = readState({ root: fx.root });
  assert.ok(s1.blocks.some(b => b.routineId === 'j-prod' && b.provider === 'claude-cli' && b.until === T0 - 10 * MIN + 2 * HOUR), JSON.stringify(s1.blocks));
  assert.equal(prov(), 'deepseek', 'the seat moved to its next entry: ' + h.lines.join('\n'));
  assert.deepEqual(st.fires, ['j-prod'], 're-run once, in the same tick: ' + h.lines.join('\n'));
  assert.ok(h.lines.some(l => /RE-FIRE "Product loop" on deepseek\/deepseek-flash after a refusal on Claude/.test(l)), h.lines.join('\n'));
  // the dispatcher's door (admit) holds a start of this routine on Claude while the block is on, and allows DeepSeek
  const A = require('../lib/admit');
  assert.equal(A.admit({ door: 'dispatch', kind: 'run', seat: 'drafter', jobId: 'j-prod', provider: 'claude-cli' }, { now: T0 + 30 * MIN, root: fx.root, file: null }).decision, 'hold');
  assert.equal(A.admit({ door: 'dispatch', kind: 'run', seat: 'drafter', jobId: 'j-prod', provider: 'deepseek' }, { now: T0 + 30 * MIN, root: fx.root, file: null }).decision, 'allow');
  // the next scheduled runs, within the block: still DeepSeek (models.js reads the block as "Claude cannot run for this seat"), never re-fired twice
  for (const dt of [40 * MIN, 80 * MIN]) {
    h.clock.t = T0 + dt; Object.assign(st.copy.find(j => j.id === 'j-prod'), { lastRunAt: new Date(T0 + dt - 5 * MIN).toISOString(), inFlight: false });
    await tick(h, st.copy);
    assert.equal(prov(), 'deepseek', 'still DeepSeek at +' + (dt / MIN) + ' min: ' + h.lines.slice(-4).join('\n'));
  }
  assert.deepEqual(st.fires, ['j-prod']);
  // the block over (2 h) and the recovery wait (30 min) passed: the seat goes back to its primary
  const fresh = () => fx.w('home/.local/state/usage/claude-usage.json', { at: h.clock.t - MIN, seven_day: { used_percentage: 5, resets_at: CLAUDE_RESET / 1000 } });   // a fresh meter reading
  h.clock.t = T0 + 2 * HOUR; fresh(); await tick(h, st.copy);   // the block ended at +1 h 50: Claude can run again from here
  assert.equal(prov(), 'deepseek', 'the usual recovery wait before moving back up');
  h.clock.t = T0 + 2 * HOUR + 35 * MIN; fresh(); await tick(h, st.copy);
  assert.equal(prov(), 'claude-cli', 'back on the primary after the block: ' + h.lines.slice(-4).join('\n'));
});

test('the owner clears a refusal block: owner only, recorded (who, when, why), the manager told, and the next run uses the primary; the block line carries a date', async () => {
  const mp = REAL_POLICY(); mp.seats = { drafter: { chain: [{ provider: 'claude-cli', model: 'claude-opus-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } };
  mp.allowed['claude-cli'].models = Array.from(new Set((mp.allowed['claude-cli'].models || []).concat(['claude-opus-5-5'])));
  const jobs = crewJobs();
  Object.assign(jobs.find(j => j.id === 'j-prod'), { provider: 'claude-cli', model: 'claude-opus-5-5', wire: { provider: 'claude-cli', model: 'claude-opus-5-5', source: 'routine' }, lastRunAt: new Date(T0 - 20 * MIN).toISOString() });
  const runs = [{ runId: 'r-opus2', cronJobId: 'j-prod', agentId: 'drafter', provider: 'claude-cli', model: 'claude-opus-5-5', outcome: 'refused', failureCode: 'content_policy_blocked', startedAt: T0 - 20 * MIN, endedAt: T0 - 10 * MIN }];
  const st = station(jobs); const base = st.call;
  st.call = async (method, p, body) => {
    if (method === 'GET' && p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: [{ id: 'claude-cli', configured: true }, { id: 'deepseek', configured: true }] }) };
    if (method === 'POST' && p === '/api/agent/model') return { status: 200, body: '{"ok":true,"via":"roster"}' };
    return base(method, p, body);
  };
  const fx = fixture({ feedPct: 5, runs, policy: { mode: 'live' }, modelPolicy: JSON.stringify(mp) });
  fx.w('company/work/handoffs/to-alex.md', '# Handoffs\n');
  const loops = JSON.parse(fs.readFileSync(path.join(fx.root, 'company/tools/loops.json'), 'utf8')); loops.agents.drafter.manager = 'agent';
  fx.w('company/tools/loops.json', loops);
  const h = make(fx, st); const prov = () => st.copy.find(j => j.id === 'j-prod').provider;
  await tick(h, st.copy);
  assert.equal(prov(), 'deepseek');
  // the block line carries a date (the shared time format), not a bare time
  const REF = require('../lib/refusal');
  const b0 = readState({ root: fx.root }).blocks[0];
  assert.match(REF.blockLine('Sam', b0, 1, T0), /^Claude paused for Sam until (today|tomorrow|[A-Z][a-z]{2} \d{1,2}) \d\d:\d\d, because it declined a run in the last 24 hours$/);
  assert.match(REF.blockLine('Sam', Object.assign({}, b0, { until: T0 + 50 * HOUR }), 3, T0), /until [A-Z][a-z]{2} \d{1,2} \d\d:\d\d, because it declined 3 runs/);
  const out = []; const cliO = (ownerShell) => ({ root: fx.root, home: fx.home, now: () => h.clock.t, call: st.call, fire: st.fire, print: l => out.push(l), jobs: st.copy, ownerShell: () => ownerShell });
  // owner only: an agent's run (no owner shell) is refused; nothing changes
  assert.equal(await pacer.cli(['unblock', 'drafter', '--by', 'owner', '--why', 'try again'], cliO(false)), 3);
  assert.equal(readState({ root: fx.root }).blocks.length, 1);
  // the owner clears it: recorded, the manager told
  h.clock.t = T0 + 20 * MIN;
  assert.equal(await pacer.cli(['unblock', 'Sam', '--by', 'owner', '--why', 'a one-off filter hit; try Claude again'], cliO(true)), 0, out.join('\n'));
  const s2 = readState({ root: fx.root });
  assert.equal(s2.blocks.length, 0); assert.ok(s2.clearedBlocks[0].clearedBy === 'owner' && s2.clearedBlocks[0].clearedWhy === 'a one-off filter hit; try Claude again' && s2.clearedBlocks[0].clearedAt);
  assert.match(fs.readFileSync(path.join(fx.root, 'company/work/dispatch-log.md'), 'utf8'), /REFUSAL BLOCK CLEARED for Sam \(Claude\) by owner: a one-off filter hit/);
  assert.match(fs.readFileSync(path.join(fx.root, 'company/work/handoffs/to-alex.md'), 'utf8'), /the owner cleared Sam's refusal block/);
  const A = require('../lib/admit');
  assert.equal(A.admit({ door: 'dispatch', kind: 'run', seat: 'drafter', jobId: 'j-prod', provider: 'claude-cli' }, { now: h.clock.t, root: fx.root, file: null }).decision, 'allow', 'admit no longer holds Claude');
  // the next tick puts the seat back on its primary at once (no recovery wait: the owner decided), so the next run uses it
  Object.assign(st.copy.find(j => j.id === 'j-prod'), { inFlight: false, lastRunAt: new Date(T0 + 15 * MIN).toISOString() });   // the DeepSeek re-run has ended
  h.clock.t = T0 + 25 * MIN; fx.w('home/.local/state/usage/claude-usage.json', { at: h.clock.t - MIN, seven_day: { used_percentage: 5, resets_at: CLAUDE_RESET / 1000 } });
  await tick(h, st.copy);
  assert.equal(prov(), 'claude-cli', h.lines.slice(-4).join('\n'));
  assert.ok(h.lines.some(l => /the owner cleared the refusal block/.test(l)), h.lines.join('\n'));
});

/* ---- the DeepSeek balance: the owner's amount, the pacer's yes/no (owner ruling 2026-11-18) ---- */
test('DeepSeek balance: the amounts go to the owner\'s state only (0600, each currency apart); the low-balance notice fires once, before a 402', async () => {
  const jobs = crewJobs();
  const fx = liveFixture({ feedPct: 10 });
  const told = []; let bal = [{ currency: 'USD', total_balance: '40.00', granted_balance: '0.00', topped_up_balance: '40.00' }, { currency: 'CNY', total_balance: '120.00' }];
  const h = make(fx, station(jobs), { extra: { fetchDeepSeek: async () => ({ ok: true, available: true, balances: bal }), notifyOwner: t => told.push(t) } });
  let r = await measurePlan(h, jobs); h.p.saveState && h.p.saveState(r.s);
  const f = path.join(fx.root, 'company', 'state', 'provider-balance.json');
  const pb = JSON.parse(fs.readFileSync(f, 'utf8')).deepseek;
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(pb.balances.map(b => b.currency + ' ' + b.total), ['USD 40', 'CNY 120'], 'kept per currency, never summed');
  assert.equal(told.length, 0, 'no notice while above the line');
  const nothere = s => !/40\.00|120\.00|balance_infos|total_balance|"balances"|"total"/.test(s);
  assert.ok(nothere(JSON.stringify(r.s)) && nothere(JSON.stringify(r.m)) && nothere(h.lines.join('\n')), 'no amount in the pacer\'s state, its measure or its log');
  bal = [{ currency: 'USD', total_balance: '1.20' }, { currency: 'CNY', total_balance: '120.00' }];
  h.clock.t += 11 * 60e3; r = await measurePlan(h, jobs);
  assert.equal(told.length, 1, 'the drop below the low line tells the owner');
  assert.ok(!/1\.20|\$\d/.test(told[0]) && /DeepSeek's prepaid credit is running low/.test(told[0]), 'with no amount in the notice: ' + told[0]);
  assert.equal(r.m.deepseek.open, true, 'calls are still possible: the notice comes before the 402s');
  h.clock.t += 11 * 60e3; await measurePlan(h, jobs);
  assert.equal(told.length, 1, 'once per drop, not every poll');
});

test('reopen: after the owner reopens Claude, a stale meter is open until the next reading; before, it stays closed', async () => {
  const jobs = crewJobs();
  const fx = fixture({ feedPct: 100, feedAt: T0 - 130 * MIN, stationPct: 100, stationAt: T0 - 130 * MIN });
  let r = await measurePlan(make(fx, station(jobs)), jobs);
  assert.equal(r.m.claude.open, false, 'stale: closed');
  const f = path.join(fx.root, 'company/state/pacer-state.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  st.closures = { claude: { until: T0 + 3 * 86400e3, why: 'a Claude run hit its usage limit' } };
  st.reopened = { claude: { at: T0 - MIN, by: 'Pat', why: 'extra usage' } };
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(st));
  delete st.closures.claude; fs.writeFileSync(f, JSON.stringify(st));
  r = await measurePlan(make(fx, station(jobs)), jobs);
  assert.equal(r.m.claude.open, true, r.m.claude.why); assert.match(r.m.claude.why, /owner reopened it/);
});

test('no MiniMax Credits recorded: no per-run token ceiling is not a go-live item; unknown Credits still asks for one', async () => {
  const jobs = crewJobs();
  for (const [credits, warned] of [[undefined, true], [true, true], [false, false]]) {
    const fx = fixture({ knobs: { maxUnpricedTokens: 0 } });
    if (credits !== undefined) fx.w('company/company.json', { providers: { minimax: { region: 'global', credits } } });
    const h = make(fx, station(jobs));
    const r = await measurePlan(h, jobs);
    assert.equal(r.m.knobs.minimaxCredits, credits === undefined ? null : credits);
    assert.equal(/no per-run token ceiling/.test(h.p.statusText(r.m)), warned, 'credits ' + credits);
  }
});

test('MiniMax: an empty 5-hour window is closed even when fiveHourCloseBelowLeftPct is 0 ("use it to the end")', async () => {
  const jobs = crewJobs();
  let r = await measurePlan(make(fixture({ policy: { minimax: { paceBy: 'fiveHour', fiveHourCloseBelowLeftPct: 0 } } }), station(jobs), { mm: mmBody(60, 0) }), jobs);
  assert.equal(r.m.minimax.open, false); assert.equal(r.m.minimax.hard, true); assert.match(r.m.minimax.why, /used up/);
  r = await measurePlan(make(fixture({ policy: { minimax: { paceBy: 'fiveHour', fiveHourCloseBelowLeftPct: 0 } } }), station(jobs), { mm: mmBody(60, 3) }), jobs);
  assert.equal(r.m.minimax.open, true, 'with 3% left and threshold 0 it still runs');
});
