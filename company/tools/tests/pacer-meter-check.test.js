#!/usr/bin/env node
/* pacer-meter-check.test.js — the stale Claude meter never deadlocks (company/tools/pacer.js claude.meterCheck).
 *
 * 2026-11-19: both companies sat 8 hours with Claude closed: the last Claude reading went stale (staleAfterMin), a stale
 * reading is unknown and unknown is closed, so no Claude run started, and only a Claude run refreshes the reading. The
 * owner had to run `pacer.js reopen claude`. These tests reproduce that state and prove the pacer now gets out of it by
 * itself: one tiny internal check run on the cheapest Claude model, at most once per staleAfterMin, Claude closed while it
 * runs, a check refused for usage recorded as a "rejected" reading. Also: the 'seven_day_overage_included' window
 * "rejected" (extra usage off) does not close Claude; a stale MiniMax reading heals through its own poll.
 *
 * Part 1 drives makePacer with a fake station function (fixed clock); part 2 runs tests/mock-station.js on a free
 * loopback port and the real detached `pacer.js meter-check` child. Nothing reaches a live station or the network.
 *
 *   node company/tools/tests/pacer-meter-check.test.js          exit 0 = all pass
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const pacer = require('../pacer.js');

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const CLAUDE_RESET = 1795266000000;            // Sat 21 Nov 2026 13:00 UTC (the live companies' weekly resetsAt)
const T0 = 1795064820000;                      // Thu 19 Nov 2026 12:07 UTC-ish: day 5 of that week
const LAST = T0 - 8 * HOUR;                    // the last reading, 8 hours old (03:58 in the incident)
// what the station last wrote in both companies (seven_day 79% allowed_warning + the overage window 100% rejected)
const INCIDENT_WINDOWS = [
  { id: 'seven_day', label: 'week', usedPct: 79, resetsAt: CLAUDE_RESET, status: 'allowed_warning' },
  { id: 'seven_day_overage_included', label: 'seven day overage included', usedPct: 100, resetsAt: CLAUDE_RESET, status: 'rejected' },
];
const OVERAGE = { status: 'rejected', using: false, why: 'org_level_disabled' };
const LOOPS = { agent: { name: 'Alex', functions: ['ceo'], loop: 'Ops loop', inbox: 'to-alex.md' }, engineer: { name: 'Jo', loop: 'Engineering loop', inbox: 'to-jo.md', manager: 'agent' } };
const JOBS = [{ id: 'j-ops', name: 'Ops loop — run the company', agentId: 'agent', provider: 'claude-cli', model: 'haiku', wire: { provider: 'claude-cli', model: 'haiku', source: 'routine' }, state: 'scheduled', enabled: true }];

const roots = [];
process.on('exit', () => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const SUBS = '.starnet-data/workspaces/.usage/subscriptions.json';
function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacer-mc-selftest-'));
  roots.push(root);
  const w = (rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/model-policy.json', fs.readFileSync(path.join(REPO, 'company', 'model-policy.json'), 'utf8'));
  // the companies' own settings: the owner's stop at 95%, "use it now" 100 (today's line is the stop), paced MiniMax
  w('company/work/finance/pacing-policy.json', Object.assign({ mode: o.mode || 'shadow' }, {
    claude: Object.assign({ feedFile: '', staleAfterMin: 90, fiveHourCloseAtUsedPct: 95, weekCloseAtUsedPct: 95, useNowPct: 100 }, o.claude || {}),
    minimax: { url: 'http://127.0.0.1:1/minimax', paceBy: 'fiveHour', fiveHourCloseBelowLeftPct: 20, staleAfterMin: 45, pollEveryMin: 10 } }));
  w('company/tools/loops.json', { agents: LOOPS });
  w('company/state/governance.json', { categories: { budget: 'auto' } });
  w('company/tools/merge-train.sh', 'WINDOW_START=0100\nWINDOW_STOP=0300\n');
  if (o.windows !== false) w(SUBS, { v: 1, providers: { 'claude-cli': { primary: { windows: o.windows || INCIDENT_WINDOWS, seenAt: o.seenAt != null ? o.seenAt : LAST, overage: OVERAGE } } } });
  w('.starnet-data/workspaces/runs.jsonl', '');
  if (o.state) w('company/state/pacer-state.json', o.state);
  return { root, w };
}
// a fake station: GET /api/cron, /api/budget/status, /api/providers; POST /api/run answers like the station's NDJSON
// and, as the real station does off Claude Code's rate_limit_event, rewrites subscriptions.json with seenAt = the clock
function station(fx, clock, o) {
  o = o || {};
  const runs = [];
  const call = async (method, p, body) => {
    if (method === 'GET' && p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs: JOBS }) };
    if (method === 'GET' && p === '/api/budget/status') return { status: 200, body: JSON.stringify({ caps: { perDay: 25 }, day: { usd: 1 }, live: 0 }) };
    if (method === 'GET' && p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: [{ id: 'claude-cli', configured: o.connected !== false }] }) };
    if (method === 'POST' && p === '/api/run') {
      runs.push(body);
      const id = 'run-mc-' + runs.length;
      const lines = [{ name: 'agent.run.start', payload: { runId: id } }];
      if (o.refuse) lines.push({ name: 'agent.run.error', payload: { runId: id, message: 'You\'ve hit your weekly limit', failureCode: 'quota_exhausted' } }, { name: 'agent.run.end', payload: { runId: id, reason: 'error', failureCode: 'quota_exhausted' } });
      else {
        if (o.meter !== false) fx.w(SUBS, { v: 1, providers: { 'claude-cli': { primary: { windows: o.windows || [{ id: 'seven_day', usedPct: 81, resetsAt: CLAUDE_RESET, status: 'allowed_warning' }, INCIDENT_WINDOWS[1]], seenAt: clock.t, overage: OVERAGE } } } });
        lines.push({ name: 'agent.token', payload: { runId: id, delta: 'OK' } }, { name: 'agent.run.end', payload: { runId: id, reason: 'done', outcome: 'succeeded', usd: 0 } });
      }
      return { status: 200, body: lines.map(x => JSON.stringify(x)).join('\n') + '\n' };
    }
    return { status: 404, body: '{}' };
  };
  return { call, runs };
}
function make(fx, st, clock, extra) {
  const lines = [];
  const p = pacer.makePacer(Object.assign({ root: fx.root, home: path.join(fx.root, 'home'), now: () => clock.t, call: st.call, fire: async () => ({ status: 200 }), log: l => lines.push(l),
    fetchMiniMax: async () => ({ ok: false, error: 'not in this test' }), fetchDeepSeek: async () => ({ ok: true, available: true, balances: [] }) }, extra || {}));
  return { p, lines };
}
async function tick(h) { const s = h.p.loadState(); const m = await h.p.measure(s, JOBS); h.p.saveState(s); if (h.p.meterCheckDone) await h.p.meterCheckDone(); return m; }
const checkFile = fx => { try { return JSON.parse(fs.readFileSync(path.join(fx.root, 'company/state/claude-meter-check.json'), 'utf8')); } catch (_) { return null; } };

test('deadlock: an 8-hour-old Claude reading is refreshed by the pacer itself, and Claude reopens on the next tick', async () => {
  const fx = fixture(), clock = { t: T0 }, st = station(fx, clock), h = make(fx, st, clock);
  let m = await tick(h);
  assert.equal(m.claude.open, false, 'stale is unknown, unknown is closed');
  assert.match(m.claude.why, /8\.0 h old/);
  assert.equal(st.runs.length, 1, 'one meter check sent (before the fix: none, ever)');
  const b = st.runs[0];
  assert.equal(b.provider, 'claude-cli'); assert.equal(b.model, 'haiku', 'the cheapest Claude model (routing.models.haiku)');
  assert.equal(b.internal, true, 'internal self-talk: no tools, no manual, not the seat\'s memory');
  assert.equal(b.isTask, false); assert.equal(b.streamId, 'pacer-meter-check'); assert.equal(b.reasoningEffort, 'low');
  assert.ok(b.messages.length === 1 && b.messages[0].content.length < 20 && b.system.length < 120, 'a few words in, a few out');
  assert.ok(h.lines.some(l => /CLAUDE METER CHECK: the last Claude reading is 8\.0 h old, so the pacer sent Claude one tiny check/.test(l)), h.lines.join('\n'));
  const adm = fs.readFileSync(path.join(fx.root, 'company/state/admit-log.jsonl'), 'utf8');
  assert.match(adm, /"door":"pacer"/, 'counted at the pacer\'s door, not as crew work');
  clock.t += 5 * MIN;
  m = await tick(h);
  assert.equal(m.claude.known, true, m.claude.why);
  assert.equal(m.claude.open, true, m.claude.why);
  assert.equal(m.claude.usedPct, 81);
  assert.ok(h.lines.some(l => /CLAUDE METER CHECK: Claude answered at .*the meter reads 81% of the week/.test(l)), h.lines.join('\n'));
  assert.equal(st.runs.length, 1, 'a fresh reading: no second check');
});

test('at most one check per staleAfterMin; closed while one is pending; a check that never answers is retried later', async () => {
  const fx = fixture(), clock = { t: T0 }, st = station(fx, clock, { meter: false });
  const started = [];
  const h = make(fx, st, clock, { startMeterCheck: spec => { started.push(spec); } });   // the child never answers
  let m = await tick(h);
  assert.equal(started.length, 1);
  assert.equal(m.claude.open, false); assert.match(m.claude.why, /a meter check is under way \(sent .*\), so it stays closed until it answers/);
  clock.t += 2 * MIN; m = await tick(h);
  assert.equal(started.length, 1, 'pending: no second check'); assert.equal(m.claude.open, false); assert.match(m.claude.why, /under way/);
  clock.t += 6 * MIN; m = await tick(h);   // past timeoutSec + 1 min: no longer pending, reported once
  assert.equal(started.length, 1, 'still inside staleAfterMin'); assert.equal(m.claude.open, false);
  assert.equal(h.lines.filter(l => /did not answer within 180 s/.test(l)).length, 1);
  clock.t += 83 * MIN; m = await tick(h);
  assert.equal(started.length, 2, 'staleAfterMin after the first check: one more');
  // a check that answers but leaves no new meter reading: closed, said once, next check only after staleAfterMin
  const h2 = make(fx, st, clock);
  clock.t += 91 * MIN; m = await tick(h2);
  assert.equal(st.runs.length, 1); clock.t += 5 * MIN; m = await tick(h2);
  assert.equal(m.claude.open, false);
  assert.ok(h2.lines.some(l => /no new meter reading from it/.test(l)), h2.lines.join('\n'));
  clock.t += 30 * MIN; await tick(h2); assert.equal(st.runs.length, 1, 'not again within staleAfterMin');
});

test('a check refused for usage is a real reading: "rejected", Claude stays closed, and the pacer checks again later', async () => {
  const fx = fixture(), clock = { t: T0 }, st = station(fx, clock, { refuse: true }), h = make(fx, st, clock);
  await tick(h);
  assert.equal(st.runs.length, 1);
  assert.equal(checkFile(fx).outcome, 'usage-limit');
  clock.t += 5 * MIN;
  const m = await tick(h);
  assert.equal(m.claude.open, false); assert.equal(m.claude.hard, true, 'the provider said no: not a pacing line');
  assert.equal(m.claude.source, 'meter check'); assert.match(m.claude.why, /rejected/);
  assert.ok(h.lines.some(l => /Claude refused the check for usage/.test(l)), h.lines.join('\n'));
  clock.t += 91 * MIN; await tick(h);
  assert.equal(st.runs.length, 2, 'the "rejected" reading goes stale too, so the next check comes after staleAfterMin');
});

test('the overage window "rejected" (extra usage off) does not close Claude; the week or the 5-hour window "rejected" does', async () => {
  // the incident's own reading, fresh: week 79% allowed_warning, seven_day_overage_included 100% rejected
  let fx = fixture({ seenAt: T0 - 5 * MIN }), clock = { t: T0 }, st = station(fx, clock), h = make(fx, st, clock);
  let m = await tick(h);
  assert.equal(m.claude.open, true, m.claude.why);
  assert.equal(st.runs.length, 0, 'fresh: no check');
  assert.equal(m.claude.overage.status, 'rejected');
  assert.match(h.p.statusText(m), /extra usage past the plan: off \(org_level_disabled\); runs inside the plan are not affected/);
  // a per-model week refused (Sonnet only): shown, not a closure of Claude (a run it refuses closes Claude by its error)
  fx = fixture({ seenAt: T0 - 5 * MIN, windows: [INCIDENT_WINDOWS[0], { id: 'seven_day_sonnet', usedPct: 100, resetsAt: CLAUDE_RESET, status: 'rejected' }] });
  h = make(fx, station(fx, clock), clock); m = await tick(h);
  assert.equal(m.claude.open, true, m.claude.why);
  assert.match(h.p.statusText(m), /per-model weeks: sonnet 100% \(refused: that model only\)/);
  // the account's own windows refusing: closed
  for (const win of [{ id: 'seven_day', usedPct: 79, resetsAt: CLAUDE_RESET, status: 'rejected' }, { id: 'five_hour', usedPct: 60, resetsAt: T0 + HOUR, status: 'rejected' }]) {
    fx = fixture({ seenAt: T0 - 5 * MIN, windows: [win.id === 'seven_day' ? win : INCIDENT_WINDOWS[0], win.id === 'five_hour' ? win : INCIDENT_WINDOWS[1]] });
    h = make(fx, station(fx, clock), clock); m = await tick(h);
    assert.equal(m.claude.open, false, win.id); assert.match(m.claude.why, /rejected/, win.id);
  }
});

test('no check when it would be pointless or not allowed: disabled, a real usage-limit closure, a halt, a look-only status, Claude never signed in', async () => {
  const clock = { t: T0 };
  const cases = [
    ['disabled by policy', fixture({ claude: { meterCheck: { enabled: false } } }), {}],
    ['a usage-limit closure still holds', fixture({ state: { closures: { claude: { until: T0 + HOUR, why: 'a Claude run hit its usage limit' } } } }), {}],
    ['a halt', (() => { const f = fixture(); f.w('company/state/halt.json', { mode: 'soft' }); return f; })(), {}],
    ['no reading ever and Claude not signed in', fixture({ windows: false }), { connected: false }],
  ];
  for (const [what, fx, so] of cases) {
    const st = station(fx, clock, so); await tick(make(fx, st, clock));
    assert.equal(st.runs.length, 0, what);
  }
  const fx = fixture(), st = station(fx, clock);
  const ro = pacer.makePacer({ root: fx.root, now: () => clock.t, call: st.call, readOnly: true, fetchMiniMax: async () => ({ ok: false, error: 'x' }) });
  await ro.measure(ro.loadState(), JOBS);
  assert.equal(st.runs.length, 0, 'status/plan only look');
  // no reading ever but Claude signed in: checked (a new company would otherwise wait forever too)
  const fx2 = fixture({ windows: false }), st2 = station(fx2, clock); await tick(make(fx2, st2, clock));
  assert.equal(st2.runs.length, 1);
});

test('the 95% stop: no check while the last reading is at the stop and its week has not reset; after the reset, one check', async () => {
  const atStop = [{ id: 'seven_day', label: 'week', usedPct: 96, resetsAt: CLAUDE_RESET, status: 'allowed_warning' }, INCIDENT_WINDOWS[1]];
  let fx = fixture({ windows: atStop }), clock = { t: T0 }, st = station(fx, clock), h = make(fx, st, clock);
  let m = await tick(h);
  assert.equal(st.runs.length, 0, 'the weekly meter only rises: a check could not reopen it, so none is spent past the stop');
  assert.equal(m.claude.open, false);
  clock.t = CLAUDE_RESET + 5 * MIN; await tick(h);
  assert.equal(st.runs.length, 1, 'a new week: the old reading says nothing, so one check');
  // with the spendCap guardrail off the stop holds nothing: the check runs
  fx = fixture({ windows: atStop }); clock = { t: T0 }; st = station(fx, clock); h = make(fx, st, clock, { guards: { spendCap: false } });
  await tick(h);
  assert.equal(st.runs.length, 1, 'spendCap off: checked');
});

test('MiniMax: a stale reading heals through its own plan poll (no owner step), and a failing poll is retried each poll period', async () => {
  const fx = fixture({ seenAt: T0 - 5 * MIN });
  const reading = { at: T0 - 3 * HOUR, usedPct: 40, weekStart: T0 - 2 * DAY, weekEnd: T0 + 5 * DAY, fiveHourLeftPct: 80, fiveHourEnd: T0 + HOUR };
  fx.w('company/state/pacer-state.json', { minimax: { reading, triedAt: T0 - 3 * HOUR } });
  const clock = { t: T0 }; let calls = 0, ok = false;
  const body = () => ({ model_remains: [{ model_name: 'general', start_time: clock.t - HOUR, end_time: clock.t + 4 * HOUR, current_interval_remaining_percent: 70, current_weekly_remaining_percent: 55,
    weekly_start_time: T0 - 2 * DAY, weekly_end_time: T0 + 5 * DAY }], base_resp: { status_code: 0 } });
  const h = make(fx, station(fx, clock), clock, { fetchMiniMax: async () => { calls++; return ok ? { ok: true, body: body() } : { ok: false, error: 'MiniMax answered HTTP 503' }; } });
  let m = await tick(h);
  assert.equal(calls, 1); assert.equal(m.minimax.open, false); assert.match(m.minimax.why, /old \(over 45 min\)/);
  clock.t += 5 * MIN; await tick(h); assert.equal(calls, 1, 'not more often than pollEveryMin');
  ok = true; clock.t += 6 * MIN; m = await tick(h);
  assert.equal(calls, 2); assert.equal(m.minimax.known, true); assert.equal(m.minimax.open, true, m.minimax.why);
});

/* ---------------- part 2: the mock station and the real detached child ---------------- */
function startMock(root, token) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [path.join(REPO, 'tests', 'mock-station.js'), '--port', '0', '--token', token, '--root', root], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    cp.stdout.on('data', d => { buf += d; const m = buf.match(/\{[^\n]*"port":(\d+)[^\n]*\}/); if (m) resolve({ cp, url: 'http://127.0.0.1:' + m[1] }); });
    cp.on('error', reject); cp.on('exit', c => reject(new Error('mock exited ' + c)));
  });
}
const post = (url, token, p, body) => fetch(url + p, { method: 'POST', headers: { 'x-starnet-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
async function waitFor(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); } }

test('mock station: the stale meter deadlock clears through the real `pacer.js meter-check` child; a refused check closes it', async () => {
  const token = 'pacer-mc-token';
  const now = Date.now(), reset = now + 2 * DAY;
  const fx = fixture({ seenAt: now - 8 * HOUR, windows: [{ id: 'seven_day', usedPct: 79, resetsAt: reset, status: 'allowed_warning' }, { id: 'seven_day_overage_included', usedPct: 100, resetsAt: reset, status: 'rejected' }] });
  fx.w('secrets/station-token', token);
  const mock = await startMock(fx.root, token);
  try {
    await post(mock.url, token, '/__providers', { 'claude-cli': true });
    await post(mock.url, token, '/__claude-usage', { windows: [{ id: 'seven_day', usedPct: 80, resetsAt: reset, status: 'allowed_warning' }, { id: 'seven_day_overage_included', usedPct: 100, resetsAt: reset, status: 'rejected' }], overage: OVERAGE });
    const lines = [];
    const mk = () => pacer.makePacer({ root: fx.root, host: mock.url, log: l => lines.push(l), fetchMiniMax: async () => ({ ok: false, error: 'not in this test' }), fetchDeepSeek: async () => ({ ok: true, available: true, balances: [] }) });
    let p = mk(), s = p.loadState(), m = await p.measure(s, JOBS); p.saveState(s);
    assert.equal(m.claude.open, false, 'stale: closed');
    const done = await waitFor(() => { const c = checkFile(fx); return c && c.status === 'done' ? c : null; }, 15000);
    assert.ok(done, 'the detached child answered: ' + JSON.stringify(checkFile(fx)));
    assert.equal(done.outcome, 'ok', JSON.stringify(done));
    const S = await fetch(mock.url + '/__state', { headers: { 'x-starnet-token': token } }).then(r => r.json());
    assert.equal(S.claudeRuns.length, 1); assert.equal(S.claudeRuns[0].internal, true); assert.equal(S.claudeRuns[0].model, 'haiku'); assert.equal(S.claudeRuns[0].agentId, 'agent');
    p = mk(); s = p.loadState(); m = await p.measure(s, JOBS); p.saveState(s);
    assert.equal(m.claude.open, true, m.claude.why); assert.equal(m.claude.usedPct, 80);
    // the account at its limit: the next check (staleAfterMin later) is refused, recorded as a rejected reading
    // two hours pass with no Claude run: the reading and the last check are that old again
    await post(mock.url, token, '/__claude-usage', { refuse: true });
    const subs = JSON.parse(fs.readFileSync(path.join(fx.root, SUBS), 'utf8')); subs.providers['claude-cli'].primary.seenAt -= 2 * HOUR; fx.w(SUBS, subs);
    const c0 = checkFile(fx); c0.at -= 2 * HOUR; c0.endedAt -= 2 * HOUR; fx.w('company/state/claude-meter-check.json', c0);
    p = mk(); s = p.loadState(); m = await p.measure(s, JOBS); p.saveState(s);
    assert.equal(m.claude.open, false);
    const refused = await waitFor(() => { const c = checkFile(fx); return c && c.status === 'done' && c.at > c0.at ? c : null; }, 15000);
    assert.ok(refused, JSON.stringify(checkFile(fx))); assert.equal(refused.outcome, 'usage-limit');
    s = p.loadState(); m = await p.measure(s, JOBS);
    assert.equal(m.claude.open, false); assert.match(m.claude.why, /rejected/);
  } finally { mock.cp.kill(); }
});
