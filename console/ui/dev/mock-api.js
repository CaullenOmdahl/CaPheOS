#!/usr/bin/env node
/* Dev-only mock of the console API (docs/CONSOLE-API.md) for working on console/ui without a company or station.
 *
 *   node console/ui/dev/mock-api.js [port]          # default 8931; serves console/ui and answers /api/* with fixtures
 *   MOCK_STATION_DOWN=1 node console/ui/dev/mock-api.js   # /api/station/* answers 502, as when the station is not running
 *   MOCK_CERTIFIED=1 node console/ui/dev/mock-api.js      # a company that finished Setup (Today is the landing page)
 *   MOCK_NO_PUSH=1 node console/ui/dev/mock-api.js        # no new question pushed 8 s after the first SSE client (scripted walks)
 *   MOCK_PLAIN=1 node console/ui/dev/mock-api.js          # without the typed-question fixtures (one card per question kind)
 *   MOCK_HEADLESS=1 node console/ui/dev/mock-api.js       # a station with no floor plan (Crew hides its Floor tab)
 *   MOCK_MINIMAX=1 node console/ui/dev/mock-api.js        # adds a question asking for the MiniMax key (endpoint picker)
 *   MOCK_ACTIONS=1 node console/ui/dev/mock-api.js        # chat actions: a Founder reply with ```actions blocks and two approvals
 * Chat actions: POST /api/chat-actions/secret keeps only {name, chars}; GET /api/__mock/actions lists what was stored and
 * every approval answer; POST /api/__mock/archive-chat empties the Founder chat (the approvals stay on Needs you).
 * MiniMax endpoint (company.json providers.minimax, company/tools/lib/minimax-endpoint.js): a key starting sk-good-cn
 * validates on Mainland China only, any other sk-good key on Global (and Custom) only, sk-net is "unreachable".
 * GET /api/__mock/minimax lists what each MiniMax save or validate was sent (region, baseUrl, key present: never the key).
 *
 * Never contacts a real station. State lives in memory: answering a question removes it, halts change mode, and so on.
 * 8 s after the first SSE client connects a new owner question arrives (event: change {topic:'questions'}) to exercise
 * the "Just now" highlight. Fixture names and numbers are placeholders, not company data.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const UI = path.resolve(__dirname, '..');
const REPO = path.resolve(UI, '..', '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8931);
if (PORT === 8800) { console.error('refusing port 8800'); process.exit(2); }
const STATION_DOWN = !!process.env.MOCK_STATION_DOWN;
const CERTIFIED = !!process.env.MOCK_CERTIFIED;
const now = () => new Date().toISOString();
const ago = m => new Date(Date.now() - m * 60000).toISOString();

// the real question schema (company/tools/inbox.js is pure for these calls: no company files are read or written)
const INBOX = require(path.join(REPO, 'company', 'tools', 'inbox.js'));
// the console's own plain-words step and run-summary code (console/activity.js), fed raw commands and tool markup
const ACTIVITY = require(path.join(REPO, 'console', 'activity.js'));
// Settings › Connections and keys › Service keys: the real names, labels and Today marking (console/service-keys.js)
const SKEYS = require(path.join(REPO, 'console', 'service-keys.js'));
const MOCK_ROOT = '/home/owner/Companies/example';
const ACT = ACTIVITY({ co: { ROOT: MOCK_ROOT, crew: () => ({}) }, stationGet: async () => ({ ok: false }), emit() {}, tool() { throw new Error('mock'); } });
const RAW_STEP = 'cd ' + MOCK_ROOT + ' && grep -n "decisions.md" company/work/security/locked-changes.md | tail -5';
const RAW_RUN_OUT = '<parameter name="cmd"cd ' + MOCK_ROOT + ' && python3 -I -m py_compile company/work/sim/scripts/record.py && systemctl --user restart example-recorder.servic';
function typedFixtures() {
  const mk = (id, mins, o) => { const form = o.form ? INBOX.normalizeForm(o.form) : INBOX.normalizeForm(INBOX.expandKind(o.kind, o.spec));
    return { id, from: o.from || 'Founder', about: o.about || 'access', blocking: false, askedAt: ago(mins), batch: null, kind: o.form ? 'form' : o.kind, form,
      message: o.message, details: o.details || '', q: o.message + (o.details ? '\n\n' + o.details : ''), askerSeat: 'agent' }; };
  const legacy = { id: 'q-000120', from: 'Founder', about: '', blocking: false, askedAt: ago(300), batch: null,
    q: 'Access gate (gate 2), no payment: a read-only Example API key, from an account you create in your own name. Why it is the binding one: the websocket rejects anonymous connections (HTTP/1.1 401 measured today), so sub-second book data is closed to us. A key buys about 1 Hz quotes.' };
  const lp = (() => { const ss = legacy.q.split(/(?<=[.!?])\s+(?=[A-Z])/); return { message: ss.slice(0, 2).join(' '), details: ss.slice(2).join(' ') }; })();
  Object.assign(legacy, lp, { messageDerived: true, kind: 'approve', secretHint: INBOX.secretHint(legacy), askerSeat: 'agent' });
  return [
    mk('q-000111', 20, { kind: 'secret', message: 'Could you make a read-only Example Exchange key and paste it here? It lets the recorder see the live order book. If you would rather not, we keep using the slower public feed.', details: 'Anonymous websocket: HTTP 401. Public REST: 0.8 snapshots/s per series.', spec: { name: 'example-exchange-key', label: 'Example Exchange API key', provider: 'example.com > Account > API keys (read-only)' } }),
    mk('q-000112', 25, { kind: 'choice', message: 'Which plan should we start with?', spec: { options: 'free:The free tier,pro:Pro at $20 a month,later:Ask me in a month', recommended: 'free', allowOther: true } }),
    mk('q-000113', 30, { kind: 'text', message: 'In a few sentences, who is the newsletter for?', spec: { min: 20, max: 800, placeholder: 'Who reads it and why' } }),
    mk('q-000114', 35, { kind: 'link', message: 'Could you sign up for the data service with your Google account? It is free and gives us a year of history.', spec: { url: 'https://example.com/signup', action: 'Sign in with Google and accept the free plan' } }),
    mk('q-000115', 40, { kind: 'account', message: 'Please make a free uptime-monitor account so the recorder can tell us when it stops.', spec: { url: 'https://example.org/accounts/signup/', action: 'Create a free account', fields: 'email:The sign-in email,project:Project name' } }),
    mk('q-000116', 45, { kind: 'number', message: 'What is the most we may spend on research tools each month?', spec: { unit: 'USD', min: 0, max: 500 } }),
    mk('q-000117', 50, { kind: 'date', message: 'When should the first public post go out?', spec: { min: '2026-01-01' } }),
    mk('q-000118', 55, { message: 'Two things for the recorder alarm. Make a free account and paste its ping key. If you would rather not, we use a different free service.', details: 'A watchdog on the same disk cannot report its own death.',
      form: { fields: [{ id: 'intro', type: 'info', text: 'It costs **nothing**.' }, { id: 'signup', type: 'link', label: 'Sign up', url: 'https://example.net/signup', action: 'Create a free account', required: true },
        { id: 'email', type: 'text', label: 'Sign-in email', required: true }, { id: 'ping', type: 'secret', label: 'Ping key', name: 'example-ping-key' },
        { id: 'ok', type: 'checkbox', label: 'Alert emails may go to that address', required: true }],
        actions: [{ id: 'go', label: 'Here you go', verdict: 'done' }, { id: 'other', label: 'Use another free service instead', verdict: 'no' }] } }),
    // the pacer's cutoff question (company/tools/lib/pacing-ask.js): two sliders and three buttons
    mk('q-000119', 15, { from: 'Pacer', about: 'pacing:claude', message: 'Claude is 70% used this week and resets Thursday 18:00. The company\'s routines are paused on Claude for today. How much of this week\'s Claude may routines use?',
      details: 'Today\'s line is 41.9% (spread evenly over the week). Held: Ingrid Halvorsen, Marisol Vance, Halima Cisse.',
      form: { fields: [{ id: 'weekstop', type: 'slider', label: 'Weekly stop', min: 70, max: 100, step: 1, value: 95, unit: '%', say: 'Let routines use up to {value}% of this week\'s Claude', minLabel: 'What is used now (70%)', maxLabel: 'All of it (100%)', marks: [{ value: 95, label: 'now 95%' }] },
        { id: 'usenow', type: 'slider', label: 'Spread evenly or use it now', min: 0, max: 100, step: 10, value: 0, unit: '%', say: '{value}% of the way from an even share each day to using it all now', sayAt: { 0: 'Spread evenly: an even share of the week each day', 100: 'Use it now: routines may go up to the weekly stop today' }, minLabel: 'Spread evenly', maxLabel: 'Use it now', required: false }],
        actions: [{ id: 'set', label: 'Set', verdict: 'submit', primary: true }, { id: 'keep', label: 'Keep paused', verdict: 'no', needs: 'none' }, { id: 'other', label: 'Use another model meanwhile', verdict: 'done', needs: 'none' }] } }),
    legacy,
    // several questions in one request: each answered on its own (inbox.js questions)
    Object.assign(mk('q-000121', 10, { kind: 'approve', message: 'Three decisions for the recorder this week. Answer each one on its own.' }), { kind: 'multi', form: undefined,
      questions: INBOX.normalizeQuestions([{ id: 'trial', prompt: 'Start the free trial of the data service?', kind: 'approve' },
        { id: 'plan', prompt: 'Which plan after the trial?', kind: 'choice', spec: { options: 'free:Free,hobby:Hobby at $5' } },
        { id: 'post', prompt: 'May the weekly post go out on Friday?', kind: 'approve' }]) }),
    // a typed form with a key and an approval: Store keeps it open, Approve answers it with both
    mk('q-000122', 12, { message: 'Two things for the alarm: the ping key, and your OK to send alerts.', form: { fields: [{ id: 'ok', type: 'checkbox', label: 'Alert emails may go to you', required: true },
      { id: 'pk', type: 'secret', label: 'Ping key', name: 'example-ping-key-2', required: false }], actions: [{ id: 'approve', label: 'Approve', verdict: 'yes' }, { id: 'decline', label: 'Decline', verdict: 'no', needs: 'none' }] } }),
    // walk 2: a request of three different questions (no shared category), a URL the asker composed as a "secret" field
    // (shown as a plain https field with Save), an approve with no stated action ("Approve tells Founder yes") and one
    // whose asker said what Approve does
    Object.assign(mk('q-000124', 25, { kind: 'approve', about: 'commitments, access, heartbeat', message: 'Three things only you can do, all access rather than policy, and each is safe to decline. The kill switch only watched 25 of the last 46 minutes because of a start limit, our own house rules send every seat to a commitments tool that is switched off here, and the outside heartbeat needs its ping address from an account in your name. Recommendations: yes to all three.' }), { kind: 'multi', form: undefined,
      questions: INBOX.normalizeQuestions([{ id: 'limit', prompt: 'May the tools seat lift the start limit on the kill-switch unit through a framework request? Yes means the halting control is back to every minute within the hour.', kind: 'approve' },
        { id: 'module', prompt: 'Our house rules tell every seat to hand future work off through the commitments tool, which is switched off here. May I switch the module on?', kind: 'approve', spec: { does: 'Approve switches the commitments module on: one tool and one ten-minute duty, no new authority.' } },
        { id: 'ping', prompt: 'You approved an outside heartbeat this morning. Paste the ping URL from the free check you make at healthchecks.io, or decline and the recorder ships local-only.', form: { fields: [{ id: 'url', type: 'secret', label: 'The ping URL from that check', name: 'hc-ping-url', help: 'It looks like https://hc-ping.com/your-uuid.' }],
          actions: [{ id: 'store', label: 'Store the ping URL', verdict: 'done', needs: ['url'] }, { id: 'local', label: 'Not now, local watchdog only', verdict: 'no', needs: 'none' }] } }]) }),
    // the recovery: an untyped request of four decisions that was closed by storing a key alone comes back once
    (() => { const q = 'Four one-file patches are ready, each measured on a copy.\n\n1. harness-change.js: a framework request carries its real diff.\n2. locked-watch.js: a symlink in a watched folder is baselined.\n3. default-branch-watch.js: an empty watch list says 0 watched.\n4. dispatch.js: a step with a due date waits instead of paging.';
      const mp = INBOX.messageParts({ q });
      return { type: 'answer', id: 'q-000123', from: 'Founder', about: 'four patches', blocking: false, askedAt: ago(90), at: ago(80), answeredAt: ago(80), batch: null, q, message: mp.message, details: mp.details, messageDerived: true, askerSeat: 'agent',
        a: 'The key: stored at secrets/example-minimax-key (40 chars).', answer: { verdict: 'done', action: 'store-key', values: { key: { stored: 'secrets/example-minimax-key', chars: 40, validated: null } } } }; })(),
  ];
}
// as inbox.js openQuestions(): a request's questions (typed, inferred from untyped text, or a follow-up) and progress
function present(q) {
  const o0 = Object.assign({}, q); if (!o0.form) o0.form = INBOX.formOf(q);
  const o = SKEYS.markSaved(o0, n => (S.serviceKeys[n] && S.serviceKeys[n].at) || null);
  o.secretOnly = INBOX.secretOnly(o.form);
  const qo = INBOX.questionsOf(Object.assign({ type: 'ask' }, q));
  if (qo) {
    o.kind = 'multi'; if (qo.inferred) o.inferred = true;
    o.questions = qo.questions.map(p => Object.assign({}, p, { answered: qo.done[p.id] ? { a: qo.done[p.id].a, at: qo.done[p.id].at } : null }));
    o.progress = { answered: o.questions.filter(p => p.answered).length, total: o.questions.length, requiredLeft: o.questions.filter(p => !p.answered && p.required !== false).length };
    if (qo.followUp) o.followUp = { note: qo.followUp.note, storedAt: qo.followUp.storedAt, earlierAnswer: q.a };
  }
  return o;
}
const placeholderSecrets = (form, values, b) => { const out = Object.assign({}, values); for (const f of form.fields.filter(x => x.type === 'secret')) { const v = out[f.id]; if (v === undefined || typeof v === 'object') continue;
  const name = f.hinted && b && b.secretNames && b.secretNames[f.id] ? b.secretNames[f.id] : f.name; out[f.id] = { stored: 'secrets/' + name, chars: String(v).trim().length, validated: null }; S.mockStored = (S.mockStored || 0) + 1; } return out; };

const S = {
  limits: { level: 'approve',
    claude: { name: 'Claude', known: true, open: false, why: 'week 70% used is over today\'s line of 41.9%', usedPct: 70, line: 41.9, normalLine: 41.9, resetsAt: Date.now() + 2 * 86400e3, weekStop: 95, useNow: 0, paceBy: 'week', affected: ['Ingrid Halvorsen', 'Marisol Vance', 'Halima Cisse'], ownerSet: null },
    minimax: { name: 'MiniMax', known: true, open: true, why: 'paced by its own limits', usedPct: 24, line: 100, normalLine: 100, resetsAt: Date.now() + 4 * 86400e3, weekStop: 100, useNow: 0, paceBy: 'fiveHour', affected: [], ownerSet: null } },
  company: { ok: true, name: 'Example Co', shortName: 'example', owner: { name: 'Sam Owner' }, timezone: 'America/Chicago', station: { url: 'http://127.0.0.1:8802' }, ownerChannel: { adapter: 'file' } },
  questions: [
    { id: 'q-000101', from: 'Founder', about: 'governance:hiring', blocking: true, askedAt: ago(40), batch: 'gate',
      gate: { category: 'hiring', ref: 'round-a', by: 'People', summary: 'Hire Candidate A as Analyst' },
      q: 'Approval needed (hiring): Hire Candidate A as Analyst.\nRecommendation from People: hire Candidate A; release B and C.\nIf you do not answer: the round waits; nobody is hired.\nReply yes or no and name q-000101.' },
    { id: 'q-000102', from: 'Founder', about: 'budget', blocking: false, askedAt: ago(130), batch: null,
      q: 'A research tool trial costs nothing for 14 days, then a monthly fee. Should we try it?\nRecommendation from Founder: approve the trial, decide on the paid plan after.\nIf you do not answer: no trial.' },
  ].concat(CERTIFIED ? [] : [{ id: 'q-000050', from: 'onboard.js', about: 'onboarding', blocking: false, askedAt: ago(600), batch: null,
      q: 'Onboarding: what the enabled packs and modules need from you (one batch, asked once):\n- Hiring candidates default to the metered model deepseek/deepseek-flash, but the metered daily cap is $0 and the station has no subscription provider (claude-cli) ready. Either connect a subscription provider on the station, or set a daily cap for pay-per-token AI (console Setup, step Budget).\n- provide secrets/example-key (0600) for example-module\nRecommendation: answer each line; secrets go in secrets/<name> with mode 0600, never in a message.\nIf you do not answer: those packs and modules stay uncertified.' }])
    // typed questions (company/tools/inbox.js forms): one of each kind, plus an asker-composed form; MOCK_PLAIN=1 leaves them out
    .concat(process.env.MOCK_PLAIN ? [] : typedFixtures())
    .concat(process.env.MOCK_MINIMAX ? [{ id: 'q-000130', from: 'Founder', about: 'access', blocking: false, askedAt: ago(5), batch: null, kind: 'secret',
      form: INBOX.normalizeForm(INBOX.expandKind('secret', { name: 'minimax-key', label: 'MiniMax plan key', validate: 'custom', provider: 'MiniMax > Account > API keys' })),
      message: 'Could you paste the MiniMax plan key? The crew paces its work against the plan.', details: '', q: 'Could you paste the MiniMax plan key?', askerSeat: 'agent' }] : []),
  answered: [{ id: 'q-000090', from: 'Founder', about: 'access', q: 'Approval needed (access): read access to the shared drive.', answer: 'yes', answeredAt: ago(200) },
    // a question its asker withdrew (inbox.js withdraw): one line under Answered today
    { id: 'q-000098', part: 'reload', from: 'Founder', message: 'May I have the one command that reloads the unit?', withdrawn: { by: 'Founder', why: 'the service rerender fixed the start limit at 18:00' }, answer: 'withdrawn by Founder: the service rerender fixed the start limit at 18:00', answeredAt: ago(30) }],
  messages: [
    { dir: 'out', id: 'out-1', at: ago(300), from: 'Founder', text: 'Morning report: two quests moved, one handoff is due today.' },
    { dir: 'in', id: 'in-1', at: ago(280), from: 'Sam Owner', text: 'Thanks. Approve the trial if it is under $100.', acked: true },
  ],
  seats: [
    { id: 'agent', name: 'Founder', title: 'Founder and CEO', seat: 'founder', role: 'agent.md', functions: ['ceo', 'risk', 'floor', 'finance'], loop: 'Founder loop', priority: 100, inbox: 'to-founder.md', log: 'founder-log.md', wakeOnInbox: true, manager: null, station: { agentId: 'agent', model: 'deepseek-flash', provider: 'deepseek', status: 'working' } },
    { id: 'people1', name: 'Mira', title: 'People Manager', seat: 'people', role: 'people-manager.md', functions: ['people'], loop: 'People loop', priority: 50, manager: 'agent', station: { agentId: 'people1', model: 'example-model-medium', status: 'idle' } },
    { id: 'cand-tools-backtest-engineer-1-n', name: 'Nadia farrell', title: 'Tools & Backtest Engineer', seat: 'specialist', role: 'nadia-farrell.md', functions: [], loop: 'Nadia farrell loop', priority: 40, manager: 'agent', hiredIn: 'tools-backtest-engineer-1', hire: { at: ago(900) }, firstRun: { at: ago(895), outcome: 'stopped' }, station: { agentId: 'cand-tools-backtest-engineer-1-n', model: 'claude-sonnet-5-5', provider: 'claude-cli', status: 'idle' } },
    { id: 'tools1', name: 'Teo', title: 'Tool Builder', seat: 'tools', role: 'tool-builder.md', functions: ['tools'], loop: 'Tools loop', priority: 60, manager: 'agent', station: { agentId: 'tools1', status: 'blocked' } },
  ],
  handoffs: [
    { due: new Date(Date.now() + 3 * 3600e3).toISOString(), raw: 'today 17:00', file: 'company/work/handoffs/to-founder.md', line: 3, heading: '## from Teo — review dispatcher change', overdue: false },
    { due: ago(60), raw: 'today 09:00', file: 'company/work/handoffs/to-people.md', line: 9, heading: '## from Founder — shortlist for the analyst role', overdue: true },
  ],
  halt: { mode: 'running' },
  services: null,
  governance: null, guardrails: null,
  // console/owner-needs.js: an open card the owner's settings leave to the crew (read only on Today), the day's digest,
  // standing rules and a project waiting for the owner
  crewHandling: [{ id: 'q-000301', from: 'Mira', askerSeat: null, askedAt: ago(30), category: 'tools', level: 'notify', ruling: null, lead: 'A question about changes to the crew\'s own tools.', line: 'Your settings let the crew decide changes to the crew\'s own tools and tell you afterwards.',
    question: { id: 'q-000301', from: 'Mira', about: 'governance:tools', blocking: false, askedAt: ago(30), batch: 'gate', kind: 'approve', q: 'May I change the report tool?', message: 'May I change the report tool? It lets us ship faster; if you skip it, we keep the old one.', gate: { category: 'tools', ref: 'harness-review:hc-0008', summary: 'change the report tool' }, technical: 'harness-change.js hc-0008: company/tools/report.js (+12 -3)', needsOwner: false } }],
  digest: [{ at: ago(120), from: 'Founder', text: 'The weekly report went out to the two pilot customers.' }, { at: ago(45), from: 'Mira', text: 'Mira fixed the broken sign-up link.', technical: 'site/signup.html: href fixed (commit 1a2b3c4)' }],
  rulings: [], projects: [{ id: 'shop-app', name: 'Shop App', state: 'requested', scope: 'the shop front', root: '/srv/shop' }],
  cadence: { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, file: 'company/work/ops/cadence.json', unknownSeats: [],
    sprint: { on: true, active: true, since: new Date(Date.now() - 3 * 3600e3).toISOString(), until: null, untilWhy: 'until the company is certified, then 24 h more', by: 'founding', budgetUsd: 4, budgetIsDefault: true, config: { cooldownFloorMin: 2, lanes: 2, fallbackTickMin: 5 } },
    seats: { agent: { name: 'Founder', loop: 'Founder loop', cooldownMin: { value: 10, from: 'cadence' }, priority: { value: 100, from: 'loops' }, wakeOnInbox: { value: true }, wakeOnOwnerMessage: { value: true } },
      people1: { name: 'Mira', loop: 'People loop', cooldownMin: { value: 40, from: 'default' }, priority: { value: 50 }, wakeOnInbox: { value: true }, wakeOnOwnerMessage: { value: false } } },
    bounds: { tickMin: [5, 30], cooldownMin: [10, 120], maxWakesPerHour: 12, maxWakesPerDay: 120, quietHours: null },
    tempo: { mode: 'bounded-auto', autoExpireMin: 30, minChangeIntervalMin: 15 },
    effective: { tickMin: 5, cooldownMin: 40, maxPerTick: 4, source: 'temporary', quiet: false, reason: 'temporary (dispatcherTickMin=5) by Founder' },
    temporary: { set: { dispatcherTickMin: 5 }, by: 'Founder', why: 'the owner is waiting on the launch checklist', at: new Date(Date.now() - 6e5).toISOString(), expiresAt: new Date(Date.now() + 12e5).toISOString() },
    wakes: { hour: 3, day: 41, maxPerHour: 12, maxPerDay: 120 },
    loop: { status: 'sleeping', lastTickAt: new Date(Date.now() - 2e5).toISOString(), lastTickEndAt: new Date(Date.now() - 18e4).toISOString(), nextTickAt: new Date(Date.now() + 12e4).toISOString(), tempo: { tickMin: 5, source: 'temporary' } },
    changes: [{ at: new Date(Date.now() - 6e5).toISOString(), by: 'Founder', what: 'temporary until 30 min: dispatcherTickMin=5', why: 'the owner is waiting on the launch checklist' }] },
  hidden: {},
  // Setup (#/setup) fixtures: GET /api/setup is computed from these
  setup: { certified: CERTIFIED, govChosen: CERTIFIED, candidateDefault: CERTIFIED ? { provider: 'claude-cli', model: 'claude-haiku-4-5-20251001' } : { provider: 'deepseek', model: 'deepseek-flash' },
    budget: { dailyUsd: 0, perAgentUsd: 0, unmeteredProviders: ['claude-cli'], setBy: '', setAt: '' }, ready: CERTIFIED ? ['claude-cli'] : [], claude: { installed: true, loggedIn: CERTIFIED, authMethod: '' }, login: null,
    charter: CERTIFIED ? { mandate: 'We run an example business.', forWhom: 'Example customers', outOfScope: 'Nothing regulated.', firstGoal: 'First sale.' } : null,
    checks: CERTIFIED ? null : { station: [true], dispatcher: [true], guardrails: [true], secrets: [true], ops: [true], liveness: [false, 'liveness module not enabled: node company/tools/module.js enable liveness --by owner'], doctor: [true], charter: [false, 'placeholders left: <What the company exists to do…>'], console: [true] }, lastCertify: ago(30) },
};
S.company.onboarding = { certified: CERTIFIED, kickoff: CERTIFIED ? { status: 'ok', at: ago(4), planOpen: true } : null };
S.company.ceo = { id: 'agent', name: 'Founder' };
// live chat transcripts (console-<id>) and the runs in flight (Now strip); one fake in-flight routine run
const IDLE = {
  people1: { state: 'waiting', reason: 'waiting on Founder for 2 items', waitingOn: ['Founder'], since: ago(30), qid: null },
  'cand-tools-backtest-engineer-1-n': { state: 'resting', reason: 'nothing new since its last run; looks again at 16:34', waitingOn: [], since: ago(20), qid: null },
};
S.chats = { agent: [{ role: 'user', content: 'What is on today?', at: ago(30) }, { role: 'assistant', content: 'Two quests and **one handoff** due at 17:00. See [the handoffs](console:#/work/handoffs).', at: ago(29) }] };
// MOCK_CHAT_TURNS=N: a long conversation with the Founder (the chat's rolling window and backscroll)
// a reply that tells the owner to run a command (the captured 2026-11-17 one), with the server's lint (console/command-ask.js)
if (process.env.MOCK_COMMAND_ASK) for (const content of ['For tonight, the heartbeat test is ready:\n\n1. Note the period and grace on your check.\n2. Stop the timer by running `systemctl --user stop capheos-sandbox-station-liveness.timer`.',
  'One more: please run `git push origin main` so the branch is up.']) S.chats.agent.push({ role: 'assistant', content, at: ago(28), commandAsk: require(path.join(__dirname, '..', '..', 'command-ask.js')).commandAsk(content) });
if (Number(process.env.MOCK_CHAT_TURNS) > 0) for (let k = Number(process.env.MOCK_CHAT_TURNS); k > 0; k--) S.chats.agent.unshift({ role: k % 2 ? 'assistant' : 'user', content: 'Message ' + k + ' of the earlier conversation.', at: ago(30 + k) });
if (Number(process.env.MOCK_CHAT_TURNS) > 0) for (let k = Number(process.env.MOCK_CHAT_TURNS); k > 0; k--) S.messages.unshift({ dir: 'out', id: 'out-mock-' + k, at: ago(30 + k), from: 'Founder', text: 'Owner channel message ' + k + '.' });
// MOCK_ACTIONS=1: a Founder reply with every kind of chat action, an expired one, a superseded pair, a malformed one,
// and approvals: one answerable in chat, one fixed owner gate, one block naming a record that does not exist
const MOCK_ACTIONS = !!process.env.MOCK_ACTIONS;
const D = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
S.approvals = {};
if (MOCK_ACTIONS) {
  const fence = o => '```actions\n' + JSON.stringify(o) + '\n```';
  S.chats.agent.push(
    { role: 'assistant', at: ago(60 * 30), content: 'Yesterday I asked:\n\n' + fence({ id: 'old-pick', prompt: 'Which day for the review?', items: [{ type: 'button', label: 'Monday', value: 'mon' }, { type: 'button', label: 'Friday', value: 'fri' }] }) },
    { role: 'assistant', at: ago(20), content: 'First draft:\n\n' + fence({ id: 'tone', prompt: 'Which tone?', items: [{ type: 'button', label: 'Formal', value: 'formal' }] }) },
    { role: 'assistant', at: ago(19), content: 'Better options:\n\n' + fence({ id: 'tone', prompt: 'Which tone?', items: [{ type: 'button', label: 'Formal', value: 'formal' }, { type: 'button', label: 'Friendly', value: 'friendly' }] }) },
    { role: 'assistant', at: ago(18), content: 'This one is broken:\n\n```actions\n{"id": "bad", "items": [{"type": "run", "label": "rm -rf"}]}\n```' },
    { role: 'assistant', at: ago(5), content: 'Two decisions before I start:\n\n' + fence({ id: 'launch', prompt: 'How should we launch?', items: [
      { type: 'choice', id: 'region', label: 'Region', options: [{ id: 'eu', label: 'Europe' }, { id: 'us', label: 'United States', recommended: true }] },
      { type: 'url', id: 'site', label: 'Landing page', placeholder: 'https://…' },
      { type: 'slider', id: 'share', label: 'Budget share', min: 0, max: 100, step: 5, value: 80, unit: '%' },
      { type: 'button', label: 'Launch now', value: 'now', tone: 'primary', run: 'rm -rf /', tool: 'code.run' },
      { type: 'button', label: 'Wait a week', value: 'wait' },
      { type: 'link', label: 'See the budget', href: 'console:#/spend' },
      { type: 'link', label: 'Read the docs', href: 'https://example.org/docs' },
      { type: 'link', label: 'Evil', href: 'javascript:alert(1)' }] }) + '\n\nAnd the key for the data feed:\n\n' + fence({ id: 'feed-key', items: [{ type: 'secret', id: 'key', label: 'Example feed key', name: 'example-feed-key' }] }) },
    { role: 'assistant', at: ago(4), content: 'Two approvals are waiting:\n\n' + fence({ id: 'approvals', items: [{ type: 'approval', ref: 'q-000201' }, { type: 'approval', ref: 'q-000202' }, { type: 'approval', ref: 'q-000999', label: 'A hand-made approve' }] }) });
  const rec = (id, category, fixed, message, params) => { const r = { id, from: 'Sam', category, fixed, message, params, actionDigest: 'sha256:' + D(id + JSON.stringify(params)), expiresAt: new Date(Date.now() + 90 * 60e3).toISOString(), default: 'deny', status: 'pending', answer: null, legacy: false, suppressed: null,
    authority: fixed ? { who: ['owner'], why: category + ' is a fixed owner gate (governance.json fixed): only the owner decides it, on Today › Needs you' } : { who: ['owner', 'ceo'], why: 'owner or CEO' } };
    r.chatAnswerable = !fixed; S.approvals[id] = r;
    S.questions.push({ id, from: 'Sam', about: 'approval:' + category, blocking: false, askedAt: ago(6), batch: null, kind: 'approve', q: message, message, approval: { category, actionDigest: r.actionDigest, expiresAt: r.expiresAt, default: 'deny', fixed } }); };
  S.messages.push({ dir: 'out', id: 'out-actions', at: ago(3), from: 'Founder', text: 'While you are away:\n\n' + fence({ id: 'away', prompt: 'Shall I keep the trial running?', items: [{ type: 'button', label: 'Keep it', value: 'keep', tone: 'primary' }, { type: 'button', label: 'Stop it', value: 'stop', tone: 'danger' }] }) });
  rec('q-000201', 'spend', false, 'May we buy one month of the example data plan for $20?', { amountUsd: 20, vendor: 'data.example.com' });
  rec('q-000202', 'access', true, 'Could we get read access to the example bank account?', { account: 'example' });
}
S.mockActions = { stored: [], answers: [] };
// secrets/ as Settings › Service keys sees it: name -> {at, chars, files} (a value is never kept); files = who reads it
S.serviceKeys = {
  'kalshi-api-key': { at: ago(60 * 24 * 3), chars: 36, files: ['company/work/markets/kalshi_feed.py'] },
  'kalshi-private-key': { at: ago(60 * 24 * 3), chars: 1704, files: ['company/work/markets/kalshi_feed.py'] },
  'pyth-api-key': { at: null, files: ['company/work/research/pyth_prices.py'] },
  'liveness-heartbeat-url': { at: null, files: ['modules/liveness/watch.js'] },
};
S.mockActions.serviceKeys = [];
// Settings › Connections and keys › Sign-ins (console/connectors.js): the real declarations and address checks, a
// simulated CLI. Synpath (loopback) waits for a pasted return address; the GitHub CLI (device code) for
// POST /api/__mock/approve/github-cli. Nothing is ever run.
const CONN = require(path.join(REPO, 'console', 'connectors.js'));
const CONN_DECLS = CONN.loadDeclarations(path.join(REPO, 'company', 'connectors')).connectors;
S.connections = { 'github-cli': { state: 'expired', at: ago(60 * 24 * 40) } };
S.connSessions = {}; S.mockActions.connectors = [];
function connRow(d) {
  const c = S.connections[d.id] || { state: 'not-connected' }; const sess = S.connSessions[d.id];
  return { id: d.id, label: d.label, about: d.about || null, docs: d.docs || null, style: d.style, provider: d.provider || null, state: c.state,
    expiredHint: c.state === 'expired' ? (d.expiredHint || 'The saved sign-in no longer works. Reconnect to sign in again.') : null,
    artefacts: d.credentialPath.map(p => ({ path: p, exists: c.state !== 'not-connected', mode: c.state !== 'not-connected' ? '0600' : null })),
    connectedAt: c.state !== 'not-connected' ? c.at : null, by: c.state !== 'not-connected' ? 'owner' : null, outside: false,
    knownIssues: (d.knownIssues || []).map(k => ({ title: k.title, text: k.text })), serviceKey: d.serviceKey || null, signingIn: !!(sess && !sess.ended),
    storage: d.credentialPath.every(p => p.startsWith('~/')) ? 'home' : 'company', crewEnv: d.configEnv ? Object.fromEntries(Object.entries(d.configEnv).map(([k, v]) => [k, 'company/connections/' + d.id + v.slice(5)])) : null, storageNote: null,
    isolation: 'same-user', crewCanRead: c.state !== 'not-connected' ? true : null,
    promise: 'Kept out of prompts and logs, not out of reach of the crew\'s tools: the file is owner-only (0600) for the one user the console, crew and station all run as.' };
}
function connView(d, req) {
  const x = S.connSessions[d.id]; if (!x) return { session: null };
  if (x.phase === 'finishing' && Date.now() - x.at > 700) { x.phase = 'connected'; x.ended = true; x.message = 'Connected. ' + d.label + ' is ready for the crew.'; S.connections[d.id] = { state: 'connected', at: now() }; S.mockActions.connectors.push({ id: d.id, connected: true }); }
  return { session: { id: 's1', connector: d.id, label: d.label, style: d.style, provider: d.provider || null, phase: x.phase,
    url: x.phase === 'sign-in' ? x.url : null, code: x.phase === 'sign-in' ? x.code : null,
    needs: x.phase !== 'sign-in' ? null : d.style === 'device-code' ? 'enter-code-there' : d.style === 'paste-code' ? 'paste-code' : 'loopback',
    sameMachine: CONN.sameMachine(req), port: x.expect ? x.expect.port : null, message: x.message || null, error: x.error || null, knownIssue: x.knownIssue || null, steps: [],
    startedAt: x.started, endsAt: new Date(Date.parse(x.started) + 600e3).toISOString(), output: '' } };
}
function serviceKeyRows() {
  return Object.entries(S.serviceKeys).map(([name, k]) => Object.assign(SKEYS.describe(name), { set: !!k.at, changedAt: k.at, files: k.files || [], usedBy: [...new Set((k.files || []).map(SKEYS.readerOf))], stored: 'secrets/' + name }))
    .sort((a, b) => (b.set - a.set) || a.label.localeCompare(b.label));
}
S.live = STATION_DOWN ? [] : [
  { runId: 'run-live-1', agentId: 'agent', name: 'Founder', startedAt: Date.now() - 4 * 60000, kind: 'routine', label: 'routine "Founder loop"', href: '#/settings/tempo/routines', step: 'hiring…', steps: 7, usd: 0.0123, stoppable: true, watched: true },
  // a seat with two things running at once (a Sprint lane): its step is a raw shell command, said in plain words
  { runId: 'run-live-2', agentId: 'tools1', name: 'Teo', startedAt: Date.now() - 2 * 60000, kind: 'routine', label: 'routine "Tools loop"', href: '#/settings/tempo/routines', step: ACT.stepText('shell', JSON.stringify({ cmd: RAW_STEP })), steps: 3, usd: 0.004, stoppable: true, watched: true },
  { runId: 'run-live-3', agentId: 'tools1', name: 'Teo', startedAt: Date.now() - 60000, kind: 'lane', label: 'lane 2: fix the intake form', href: '#/crew/tools1', step: ACT.stepText('shell', JSON.stringify({ cmd: 'bash scripts/test.sh' })), steps: 1, usd: 0.001, stoppable: true, watched: true }
];
S.charterText = CERTIFIED ? '# Example Co — Company Charter\n\n## Mandate\n\nWe run an example business.\n\n**For whom:** Example customers\n\n## What is out of scope\n\nNothing regulated.\n\n## First goal\n\nFirst sale.\n' : '# Example Co — Company Charter\n\n## Mandate\n\n<What the company exists to do, for whom, and how it makes money.>\n\n## What is out of scope\n\n<Work the company will not take on.>\n';
const PRESETS = { 'approve-everything': 'Approve everything', 'gate-money-people': 'Gate money and people', 'gate-money': 'Gate money', autonomous: 'Autonomous' };
const CATS = { hiring: 'opening a role and picking the hire', release: 'releasing or replacing a crew member', budget: 'setting or changing the metered cap', spend: 'new spend inside the approved cap',
  models: 'changing which model a seat or routine runs', tools: 'shared changes to tools, house rules and policies', schedules: 'routine clocks, dispatcher tick and per-seat cadence',
  external: 'anything that leaves the company', dashboard: 'agents adding or changing console panels' };
const LV = { 'approve-everything': {}, 'gate-money-people': { models: 'notify', tools: 'notify', schedules: 'notify', dashboard: 'notify' }, 'gate-money': { hiring: 'notify', release: 'notify', models: 'auto', tools: 'auto', schedules: 'auto', external: 'notify', dashboard: 'auto' }, autonomous: { hiring: 'auto', release: 'notify', budget: 'auto', spend: 'auto', models: 'auto', tools: 'auto', schedules: 'auto', external: 'auto', dashboard: 'auto' } };
function setPreset(p) { S.governance = { preset: p, presetLabel: PRESETS[p] || 'Custom', categories: Object.keys(CATS).map(c => ({ category: c, level: (LV[p] || {})[c] || 'approve', what: CATS[c] })),
  fixed: ['access', 'ownership', 'commitment', 'spendBeyondCap'].map(c => ({ category: c, level: 'approve' })), ownerGatesGuardrail: 'on', presets: Object.entries(PRESETS).map(([id, label]) => ({ id, label })) }; }
setPreset('gate-money-people');
S.services = [
  { name: 'depth-recorder', unit: 'company-svc-depth-recorder', kind: 'service', status: 'installed', state: 'running', schedule: null, scheduleWords: 'runs all the time', lastRun: ago(300),
    by: 'data1', byName: 'Halima', why: 'Records the order book once a second, so the back-tests have depth data that cannot be fetched later.', command: '/usr/bin/python3 company/work/sim/scripts/record_depth.py --hz 1',
    limits: { memoryMax: '512M', cpuQuota: '50%' }, network: true, softHalt: 'keep', approval: { level: 'approve', via: 'owner said yes to q-104511', at: ago(600) }, scoped: true, managed: true, halt: null },
  { name: 'bank-day', unit: 'company-svc-bank-day', kind: 'timer', status: 'installed', state: 'scheduled', schedule: { onCalendar: '*-*-* 17:30:00 UTC' }, scheduleWords: 'on the calendar *-*-* 17:30:00 UTC',
    lastRun: ago(900), nextRun: new Date(Date.now() + 6 * 3600e3).toISOString(), by: 'data1', byName: 'Halima', why: 'Banks the day that just closed, every night after midnight company time.',
    command: '/bin/sh company/work/sim/scripts/bank_yesterday.sh', limits: { memoryMax: '512M', cpuQuota: '50%' }, network: true, softHalt: 'finish', approval: { level: 'owner', via: 'adopted by the owner', at: ago(700) }, scoped: true, managed: true, halt: null },
  { name: 'tape-check', unit: 'company-svc-tape-check', kind: 'timer', status: 'proposed', state: 'proposed', schedule: { every: '1h' }, scheduleWords: 'every 1h', lastRun: null,
    by: 'tools1', byName: 'Teo', why: 'Checks every hour that yesterday\'s trade tape is complete.', command: '/usr/bin/node company/work/sim/tape-check.js', limits: { memoryMax: '256M', cpuQuota: '25%' },
    network: false, softHalt: 'finish', approval: { level: 'approve', questionId: 'q-104520' }, questionId: 'q-104520', scoped: true, managed: true, halt: null },
];
const GUARDS = ['ownerGates', 'spendCap', 'externalActions', 'harnessSelfEdit', 'defaultBranch', 'secrets', 'localComputer', 'privilegedShell', 'promptInjection', 'halt'];
S.guardrails = { sandbox: false, banner: null, guards: GUARDS.map(n => ({ name: n, on: true, fixed: n === 'halt', blocks: 'what ' + n + ' stops. Off: it no longer holds.', enforcedIn: ['company/tools/' + n.toLowerCase() + '.js'], note: null })) };
const guardView = () => Object.assign({ ok: true }, S.guardrails, { off: S.guardrails.guards.filter(g => !g.on).map(g => g.name) });

const PANELS = {
  'open-handoffs': { meta: { status: 'installed', title: 'Open handoffs by deadline', placement: 'today', owner: 'ceo', view: 'table', refresh: 300, valid: true, findings: 0 },
    data: () => ({ ok: true, type: 'capheos:panel-data', version: 1, id: 'open-handoffs', at: now(), title: 'Open handoffs by deadline', owner: 'ceo', why: 'Work stuck between two seats is the first thing to slip.', refresh: 300,
      view: { kind: 'table', source: 'due', columns: [{ key: 'due', label: 'Due', format: 'relative', flag: 'overdue' }, { key: 'heading', label: 'Handoff', width: 'wide' }, { key: 'file', label: 'Inbox' }], empty: 'No open handoffs.' },
      actions: [{ id: 'nudge-ceo', label: 'Ask the CEO', kind: 'ask-ceo', scope: 'row', text: 'This handoff is due {{row.raw}}: "{{row.heading}}". Is it on track?' }],
      data: { due: S.handoffs }, sources: { due: { ok: true } } }) },
  'kpis': { meta: { status: 'installed', title: 'This week', placement: 'today', owner: 'finance', view: 'stat-row', refresh: 30, valid: true, findings: 0 },
    data: () => ({ ok: true, id: 'kpis', at: now(), title: 'This week', owner: 'finance', why: 'The owner glances at the week in one row of numbers.', refresh: 30,
      view: { kind: 'stat-row', items: [{ source: 'w', value: 'closed', label: 'quests closed' }, { source: 'w', value: 'spend', label: 'metered spend', format: 'money' }, { source: 'w', value: 'rate', label: 'on time', format: 'percent' }] },
      actions: [], data: { w: { closed: 4, spend: 2.4, rate: 0.92 } }, sources: { w: { ok: true } } }) },
  'notes': { meta: { status: 'installed', title: 'House notes', placement: 'side:work', owner: 'ceo', view: 'markdown', refresh: 600, valid: true, findings: 0 },
    data: () => ({ ok: true, id: 'notes', at: now(), title: 'House notes', owner: 'ceo', why: 'Standing notes the CEO keeps for the owner.', refresh: 600, view: { kind: 'markdown', source: 'md' }, actions: [],
      data: { md: '## This week\n- Ship the **intake tool**\n- Review `cadence.json`\n\nSee [the guide](docs/CONSOLE-PANELS.md). <script>alert(1)</script>' }, sources: { md: { ok: true } } }) },
  'trading-positions': { meta: { status: 'installed', title: 'Positions and P&L', placement: 'screen', nav: 'Positions', owner: 'finance', view: 'custom', refresh: 60, valid: true, findings: 0 },
    data: () => { const pj = JSON.parse(fs.readFileSync(path.join(REPO, 'company/console/examples/trading-positions/panel.json'), 'utf8'));
      return { ok: true, type: 'capheos:panel-data', version: 1, id: pj.id, at: now(), title: pj.title, owner: pj.owner, why: pj.why, refresh: pj.refresh, view: pj.view, actions: pj.actions,
        data: { positions: JSON.parse(fs.readFileSync(path.join(REPO, 'company/console/examples/trading-positions/fixture/company/work/desk/positions.json'), 'utf8')) }, sources: { positions: { ok: true } } }; },
    view: path.join(REPO, 'company/console/examples/trading-positions/view.html') },
  'broken-one': { meta: { status: 'installed', title: 'Broken example', placement: 'today', owner: 'tools', view: 'table', refresh: 300, valid: false, findings: 2 } },
  'proposed-one': { meta: { status: 'proposed', title: 'Billable hours', placement: 'screen', nav: 'Hours', owner: 'finance', view: 'chart', refresh: 300, valid: true, findings: 0 } },
};
const panelList = () => Object.entries(PANELS).map(([id, p]) => Object.assign({ id, hidden: !!S.hidden[id] }, p.meta));

/* ---------- Setup ---------- */
const MME = require(path.join(REPO, 'company', 'tools', 'lib', 'minimax-endpoint.js'));
const mmLog = [];
const mmOk = (ep, key) => { const k = String(key || ''); if (/^sk-net/.test(k)) return { valid: false, reachable: false, error: 'connect ETIMEDOUT' };
  const ok = ep.region === 'cn' ? /^sk-good-cn/.test(k) : /^sk-good/.test(k) && !/^sk-good-cn/.test(k);
  return { valid: ok, reachable: true, status: ok ? 'verified' : 'rejected', error: ok ? null : 'provider rejected this key (HTTP 401)' }; };
const mmEp = () => MME.fromConfig({ providers: { minimax: S.setup.mm } });
const mmViewOf = ep => ({ region: ep.region, label: ep.label, plain: MME.plain(ep), custom: ep.custom, other: !!ep.other, baseUrl: ep.baseUrl, keyUrl: ep.keyUrl, usageUrl: ep.usageUrl, warnings: ep.warnings || [], problem: ep.problem || null, stored: !!ep.stored, choices: MME.choices() });
const mmWanted = b => (b.region === undefined && b.baseUrl === undefined) ? { ep: mmEp(), explicit: false } : { ep: MME.resolve({ region: b.region || 'custom', baseUrl: b.baseUrl, other: b.other === true }), explicit: true };
const OFFER = [
  { id: 'claude-cli', name: 'Claude subscription', how: 'signin', unmetered: true, blurb: 'Your Claude Pro or Max plan, through Claude Code on this machine. Flat fee: nothing is billed per token.' },
  { id: 'custom', name: 'MiniMax Coding Plan', how: 'key', unmetered: true, /* keyUrl, baseUrl, endpoint: from mmEp() */ blurb: 'A MiniMax plan key. Flat fee, paced against the plan.' },
  { id: 'deepseek', name: 'DeepSeek', how: 'key', unmetered: false, keyUrl: 'https://platform.deepseek.com/api_keys', blurb: 'Pay per token from a prepaid balance. Needs a daily cap in step 3.' },
  { id: 'openrouter', name: 'OpenRouter', how: 'key', unmetered: false, keyUrl: 'https://openrouter.ai/keys', blurb: 'One key for many models, pay per token. Needs a daily cap in step 3.' },
  { id: 'anthropic', name: 'Anthropic API', how: 'key', unmetered: false, keyUrl: 'https://console.anthropic.com/settings/keys', blurb: 'Claude by API key, pay per token. Needs a daily cap in step 3.' },
];
function setupView() {
  const U = S.setup, cd = U.candidateDefault, b = U.budget, up = !STATION_DOWN;
  const ready = up ? U.ready : [];
  const steps = [];
  const add = (id, title, status, why) => steps.push({ id, title, status, why });
  add('company', 'Company', 'done', S.company.name + ', run by ' + S.company.owner.name + ', on ' + S.company.timezone + ' time.');
  add('provider', 'AI provider', ready.includes(cd.provider) ? 'done' : 'needs', !up ? 'The station is not answering (connect ECONNREFUSED), so no AI provider can be checked or connected. Start it, then come back.' : ready.includes(cd.provider) ? 'New hires interview on Claude Haiku 4.5, which the station has ready.' : 'Your crew needs an AI to think with. The station has no AI provider connected yet.');
  const metered = !b.unmeteredProviders.includes(cd.provider);
  add('budget', 'Budget', metered && b.dailyUsd <= 0 ? 'needs' : b.setBy ? 'done' : 'optional', metered && b.dailyUsd <= 0 ? 'New hires run on ' + cd.provider + ', which bills per token, and the daily cap is $0, so nothing they do can run.' : b.dailyUsd > 0 ? 'Up to $' + b.dailyUsd + ' a day on pay-per-token AI.' : 'Subscription only: $0 a day on pay-per-token AI. Fine while the crew runs on a subscription.');
  add('governance', 'How much the company decides alone', U.govChosen ? 'done' : 'optional', (U.govChosen ? 'Set to ' : 'Starts at ') + S.governance.presetLabel + '. The four owner gates (money beyond the cap, access, ownership, outside commitments) always come to you.');
  add('charter', 'Charter', U.charter ? 'done' : 'needs', U.charter ? 'The crew knows what the company does and what it will not do.' : 'The crew reads the charter to know what the company is for. It still has 3 blanks to fill.');
  const off = S.guardrails.guards.filter(g => !g.on).map(g => g.name);
  add('guardrails', 'Guardrails', off.length ? 'optional' : 'done', off.length ? off.length + ' switched off by you: ' + off.join(', ') + '.' : 'All ' + S.guardrails.guards.length + ' are on. You can switch some off later in Controls.');
  const checks = U.checks ? Object.entries(U.checks).map(([id, v]) => ({ id, ok: v[0], missing: v[1] || null })) : [];
  const failed = checks.filter(c => !c.ok).map(c => c.id);
  add('certify', 'Certify', U.certified ? 'done' : 'needs', U.certified ? 'All checks passed. The company is operational.' : failed.length + ' of ' + checks.length + ' checks still failing: ' + failed.join(', ') + '.');
  return { certified: U.certified, done: steps.filter(x => x.status === 'done').length, total: steps.length, steps,
    company: { name: S.company.name, ownerName: S.company.owner.name, timezone: S.company.timezone },
    station: { up, error: up ? null : 'connect ECONNREFUSED', url: S.company.station.url, claude: up ? U.claude : null },
    providers: OFFER.map(o => o.id !== 'custom' ? o : Object.assign({}, o, { keyUrl: mmEp().keyUrl, baseUrl: mmEp().baseUrl, endpoint: mmViewOf(mmEp()) })).map(o => Object.assign({}, o, { ready: ready.includes(o.id), present: ready.includes(o.id), isDefault: cd.provider === o.id, metered: !b.unmeteredProviders.includes(o.id) })),
    candidateDefault: cd, budget: b,
    governance: { preset: S.governance.preset, presetLabel: S.governance.presetLabel, presets: S.governance.presets, chosen: U.govChosen },
    charter: Object.assign({ exists: true, placeholders: U.charter ? [] : ['<What the company exists to do…>', '<Work the company will not take on…>'], mandate: '', forWhom: '', outOfScope: '', firstGoal: '' }, U.charter || {}),
    guardrails: { off, sandbox: S.guardrails.sandbox, guards: S.guardrails.guards.map(g => ({ name: g.name, on: g.on, fixed: g.fixed, blocks: g.blocks })) },
    checks, lastCertify: U.lastCertify, onboardingQuestions: S.questions.filter(q => q.from === 'onboard.js' || /^onboarding/.test(q.about || '')) };
}

/* ---------- SSE ---------- */
const clients = new Set(); let pushed = false;
function emit(topic) { for (const c of clients) c.write('event: change\ndata: ' + JSON.stringify({ topic }) + '\n\n'); }
function newQuestion() {
  S.questions.unshift({ id: 'q-000' + (200 + S.questions.length), from: 'Founder', about: 'governance:external', blocking: true, askedAt: now(), batch: 'gate',
    gate: { category: 'external', summary: 'Publish the weekly post' }, q: 'Approval needed (external): Publish the weekly post.\nRecommendation from Founder: publish as drafted.\nIf you do not answer: held until you answer.' });
  emit('questions');
}

/* ---------- routes ---------- */
const J = (res, code, o) => { const b = JSON.stringify(o); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(b); };
const body = req => new Promise(r => { let d = ''; req.on('data', c => { d += c; }); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch (_) { r({}); } }); });

async function apiRoute(req, res, p, q) {
  const M = req.method, B = M === 'POST' ? await body(req) : {};
  const ok = o => J(res, 200, Object.assign({ ok: true }, o || {}));
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write(': hello\n\n');
    clients.add(res); req.on('close', () => clients.delete(res));
    if (!pushed && !process.env.MOCK_NO_PUSH) { pushed = true; setTimeout(newQuestion, 8000); }   // a scripted walk sets MOCK_NO_PUSH: a card redraw mid-walk would race its checks
    return;
  }
  if (p.startsWith('/api/station/')) return station(req, res, p.slice('/api/station/'.length), q, B);
  // Watch: a run's steps, each in plain words with its raw command (Watch is where the command may be read)
  { const m = M === 'GET' && /^\/api\/now\/run\/([\w-]+)$/.exec(p); if (m) { const r = S.live.find(x => x.runId === m[1]); if (!r) return ok({ known: false, events: [], done: null });
    const after = Number(q.get('after')) || 0;
    const ev = [{ seq: 1, name: 'tool', tool: 'shell', text: r.step, raw: r.agentId === 'tools1' ? RAW_STEP : 'node company/tools/hire.js status', callId: 'c1' }, { seq: 2, name: 'result', callId: 'c1', ok: true }, { seq: 3, name: 'token', delta: 'Looking at the open items.' }];
    return ok({ known: true, runId: r.runId, agentId: r.agentId, name: r.name, events: ev.filter(e => e.seq > after), seq: 3, done: false }); } }
  // Settings › System › Test the outside alarm (modules/liveness/http.js): pause the heartbeat ping, count down, resume
  if (p === '/api/m/liveness/alarm-test' || p.startsWith('/api/m/liveness/alarm-test/')) {
    const A = S.alarm = S.alarm || { saved: { periodMin: 5, graceMin: 2 }, active: null, last: null, lastPingAt: ago(3) };
    const view = () => ok({ configured: true, enabled: true, lastPingAt: A.lastPingAt, saved: A.saved, active: A.active, last: A.last, maxWindowMin: 720, extraMin: 5 });
    const what = p.slice('/api/m/liveness/alarm-test/'.length);
    if (M === 'GET' && !what) return view();
    if (M === 'POST' && what === 'start') {
      const pm = Number(B.periodMin), gm = Number(B.graceMin);
      if (!(pm > 0) || !(gm >= 0)) return J(res, 400, { ok: false, error: 'Give the check\'s period (minutes, above 0) and grace (minutes, 0 or more), as your check shows them.' });
      const exp = Date.parse(A.lastPingAt) + (pm + gm) * 60000;
      A.saved = { periodMin: pm, graceMin: gm };
      A.active = { id: 'hbt-mock', startedAt: now(), periodMin: pm, graceMin: gm, lastPingAt: A.lastPingAt, expectAt: new Date(exp).toISOString(), until: new Date(Math.max(exp, Date.now()) + 5 * 60000).toISOString(), gotAt: null };
      return view();
    }
    if (M === 'POST' && (what === 'got-it' || what === 'resume')) {
      if (!A.active) return J(res, 409, { ok: false, error: 'No test is running.' });
      A.last = Object.assign({}, A.active, { gotAt: what === 'got-it' ? now() : null, result: what === 'got-it' ? 'alert seen' : 'no alert seen', endedAt: now() });
      A.active = null; A.lastPingAt = now(); return view();
    }
  }
  // background services (Settings › System): company/tools/service.js list --json, and stop/start/remove as the owner
  if (M === 'GET' && p === '/api/services') return ok({ company: 'mock', guardrail: 'on', services: S.services });
  const svm = p.match(/^\/api\/services\/([A-Za-z0-9@_.:-]{2,80})\/(stop|start|remove)$/);
  if (M === 'POST' && svm) {
    const sv = S.services.find(x => x.name === svm[1]); if (!sv) return J(res, 400, { ok: false, error: 'no registered service "' + svm[1] + '"' });
    if (svm[2] === 'remove') S.services = S.services.filter(x => x !== sv);
    else if (sv.status !== 'installed') return J(res, 400, { ok: false, error: '"' + sv.name + '" is ' + sv.status + ', not installed' });
    else sv.state = svm[2] === 'stop' ? 'stopped' : sv.kind === 'timer' ? 'scheduled' : 'running';
    emit('services'); return ok({ name: sv.name, done: svm[2] });
  }
  // full profiles (Crew › <person> › Profile): console/profile.js -> company/tools/profile.js (docs/PROFILES.md); the
  // preview is the real lib/profile.js block of the fixture
  if (p.startsWith('/api/profile')) {
    const PL = require('../../../company/tools/lib/profile.js');
    if (!S.profiles) {
      const b = PL.blank('agent', { name: 'Founder', title: 'Founder' });
      Object.assign(b.identity, { archetype: 'lead', background: 'Started the company to see whether a small crew could run a shop on its own.', stake: 'Their name is on the company.' });
      b.temperament = { risk: 2, pace: 3, rigour: 3, candour: 3, independence: 4, changesMind: 'A number from a test the crew ran.' };
      b.convictions = ['A decision written down beats a perfect one in your head.']; b.counterpart = { seat: 'people1', signOff: ['plan', 'commit'], why: 'Mira asks who pays for a long plan.' };
      b.examples = [{ with: 'owner', they: 'Can we go faster?', you: 'Yes, on the small things. The launch stays on Friday so we can check it.', pushback: true }, { with: 'people1', they: 'We need two more people.', you: 'Show me the work that is waiting, then we decide.', pushback: true }, { with: 'tools1', they: 'It is done.', you: 'Good. What did the test say?' }];
      b.voice = { preset: 'composed', words: 'Short sentences; decides out loud.', toOwner: 'Plain and brief.', avoid: [] };
      b.version = 3; b.hash = PL.hashOf(b);
      S.profiles = { agent: b, proposals: [{ id: 'pp-0a1b2c3d', seat: 'agent', by: 'people1', kind: 'experience', status: 'open', why: 'the first launch', changes: { '/experiences/-': { at: '2026-11-18', text: 'The first launch slipped a day and taught them to check the payment page first', addedBy: 'Mira' } } }] };
    }
    const crewNames = [{ id: 'people1', name: 'Mira' }, { id: 'tools1', name: 'Teo' }];
    const view = () => { const pr = S.profiles.agent; const crew = { agent: { name: 'Founder' }, people1: { name: 'Mira' }, tools1: { name: 'Teo' } };
      return { ok: true, seat: 'agent', profile: pr, history: [{ at: '2026-11-18T09:00:00Z', version: 3, by: 'You', op: 'edit', kind: 'voice', why: null }, { at: '2026-11-17T09:00:00Z', version: 2, by: 'Mira', op: 'proposal-apply', kind: 'experience', why: 'the first week' }, { at: '2026-11-16T09:00:00Z', version: 1, by: 'The crew', op: 'edit', kind: 'content', why: 'built from the charter' }],
        proposals: S.profiles.proposals.filter(x => x.status === 'open'), preview: { block: PL.block(pr, { crew }), reminder: PL.reminder(pr, { crew }), example: { who: 'You', they: pr.examples[0].they, you: pr.examples[0].you, pushback: true, name: 'Founder' } },
        words: { counterpart: '**Who checks Founder:** Mira. Before Founder can **start a plan longer than three days** or **commit someone else\'s time**, Mira has to agree.', model: 'Runs on: the everyday setup', boundaries: PL.FIXED_BOUNDARIES.map(x => x.plain), family: [],
          proposals: S.profiles.proposals.filter(x => x.status === 'open').map(x => ({ id: x.id, kind: x.kind, text: 'Mira suggests adding to Founder\'s experience: \'' + x.changes['/experiences/-'].text + '.\' Add it · Not this one · Try it.' })) },
        policy: { inject: 'profile', pov: true, signoff: { mode: 'live' } }, temperament: PL.temperament(), signoffKinds: Object.fromEntries(Object.entries(PL.SIGNOFF_KINDS).map(([k, v]) => [k, v.owner])), crew: crewNames, check: { ok: true, problems: [], notes: [] } }; };
    if (M === 'GET' && p === '/api/profile/presets') return ok({ presets: PL.presets() });
    if (M === 'GET' && p === '/api/profile/agent') return ok(view());
    if (M === 'POST' && p === '/api/profile/agent/preview') return ok(view().preview);
    const ppm = p.match(/^\/api\/profile\/proposals\/(pp-[0-9a-f]{8})\/(apply|decline|try)$/);
    if (M === 'POST' && ppm) { const x = S.profiles.proposals.find(y => y.id === ppm[1]); if (!x) return J(res, 400, { ok: false, error: 'no proposal' }); x.status = ppm[2] === 'decline' ? 'declined' : 'applied'; if (ppm[2] !== 'decline') S.profiles.agent.experiences = (S.profiles.agent.experiences || []).concat([x.changes['/experiences/-']]); emit('crew'); return ok({}); }
    if (M === 'POST' && p === '/api/profile/agent') { if (Number(B.base) !== S.profiles.agent.version) return J(res, 409, { ok: false, error: 'Someone changed this profile while you were editing it. Reload to see the latest version, then make your change again.' }); for (const [k, v] of Object.entries(B.set || {})) { const t = k.slice(1).split('/'); let o = S.profiles.agent; for (const x of t.slice(0, -1)) o = o[x] = o[x] || {}; o[t[t.length - 1]] = v; } S.profiles.agent.version++; return ok({ version: S.profiles.agent.version }); }
    if (M === 'POST' && /^\/api\/profile\/agent\/(try|undo|trial\/keep|trial\/stop|migrate)$/.test(p)) { S.profiles.agent.version++; return ok({ version: S.profiles.agent.version }); }
    if (M === 'POST' && p === '/api/profile/policy') return ok({ policy: { inject: B.inject } });
    if (M === 'GET') return ok({ seat: p.split('/').pop(), profile: null, name: p.split('/').pop(), canMigrate: true, policy: { inject: 'charter' } });
  }
  // departments and the lead's advice (Crew › People › Departments): console/departments.js -> company/tools/departments.js,
  // consult.js status (docs/DEPARTMENTS.md §5)
  if (!S.departments) S.departments = { exists: true, unassigned: [{ id: 'agent', name: 'Founder', isCeo: true }, { id: 'people1', name: 'Mira', isCeo: false }], drift: { ok: true, mismatches: [], notes: [] }, proposals: [],
    departments: [{ id: 'eng', name: 'Engineering', lead: 'tools1', leadName: 'Teo', defaultClass: 'code', members: [{ id: 'tools1', name: 'Teo', isLead: true, onCrew: true }, { id: 'cand-tools-backtest-engineer-1-n', name: 'Nadia Farrell', isLead: false, onCrew: true }],
      advisor: { mode: 'live', effective: 'live', paused: null, since: ago(3 * 86400e3 / 60e3), by: 'owner' }, consultLimits: { maxPerDay: 12 },
      delegation: { mode: 'shadow', effective: 'shadow', workers: ['cand-tools-backtest-engineer-1-n'], maxWorkers: 3, workerTimeoutMin: 20, minPieces: 3, prefer: 'lanes', since: null, by: 'owner', withdrawn: null } }] };
  const ddm = p.match(/^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/delegation$/);
  if (M === 'POST' && ddm) { const d = S.departments.departments.find(x => x.id === ddm[1]); if (!d) return J(res, 400, { ok: false, error: 'no department' }); const g = d.delegation; if (B.resume) g.withdrawn = null; else if (['off', 'shadow', 'live'].includes(B.mode)) { g.mode = B.mode; g.effective = B.mode; } else return J(res, 400, { ok: false, error: 'mode must be off, shadow or live' }); emit('crew'); return ok({ changed: true, summary: 'splitting ' + g.mode, delegation: g }); }
  if (M === 'GET' && p === '/api/departments') return ok(S.departments);
  const dlm = p.match(/^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/(lead-desk|advisor)$/);
  if (dlm) {
    const d = S.departments.departments.find(x => x.id === dlm[1]); if (!d) return J(res, 400, { ok: false, error: 'no department "' + dlm[1] + '"' });
    if (M === 'GET' && dlm[2] === 'lead-desk') return ok({ dept: d.id, advisor: d.advisor, consultLimits: d.consultLimits, brief: '# Engineering\n\nThis week: the new parser, then the slow report.',
      desk: { dept: d.id, mode: d.advisor.mode, effective: d.advisor.effective, paused: d.advisor.paused, today: 4, maxPerDay: 12, open: 1, lastAdviceAt: ago(42), nextAdvice: null, nextWhy: '1 open consult(s), fewer than 3', evaluation: { verdict: 'not enough data', failed: [] } } });
    if (M === 'POST' && dlm[2] === 'advisor') {
      const a = d.advisor;
      if (B && B.resume) a.paused = null; else if (B && B.pause) a.paused = { at: new Date().toISOString(), by: 'owner', why: B.why || 'the owner paused it' }; else if (B && ['off', 'shadow', 'live'].includes(B.mode)) a.mode = B.mode;
      a.effective = a.mode === 'off' ? 'off' : a.paused ? 'shadow' : a.mode;
      emit('crew'); return ok({ changed: true, summary: 'advice ' + a.mode, advisor: a });
    }
  }
  // routing modes and trials (Settings › Models › Routing): console/routing.js -> company/tools/routing.js
  if (!S.routing) S.routing = { ok: true, source: 'default', mode: 'shadow', tierCaps: { mode: 'shadow', allow: [], exemptFunctions: ['ceo'], exemptLeads: true }, log: [],
    trials: [{ id: 'code-claude-three', class: 'code', status: 'running', entryShare: 0.1, minItemsPerArm: 30, createdBy: 'Mira', scope: { departments: ['eng'], seats: [] }, reasons: ['held: claude-cli held by the pacer (since 2026-11-18 09:00)'], hold: null, progress: { minItemsPerArm: 30, lowestArm: 0, enough: false },
      heldGuard: { providers: ['claude-cli'], subscriptions: ['claude-cli'], missing: [] },
      arms: [{ index: 0, provider: 'claude-cli', model: 'haiku', effort: 'low', items: 1, wakes: 1, shadowItems: 0, shadowWakes: 0 }, { index: 1, provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high', items: 0, wakes: 0, shadowItems: 1, shadowWakes: 1 }, { index: 2, provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium', items: 0, wakes: 0, shadowItems: 0, shadowWakes: 0 }] }] };
  if (M === 'GET' && p === '/api/routing') return ok(S.routing);
  // the weekly suggestions (Settings › Models › Routing › Weekly suggestions): routing.js proposals status --json
  if (!S.suggest) S.suggest = { ok: true, mode: 'live', policy: { weekday: 1, hourLocal: 9, vetoDays: 3, maxPerWeek: 3 }, waiting: [],
    weeks: [{ week: '2026-W47', suggestions: [{ id: 'rp-0a1b2c3d4e5f', dept: 'eng', deptName: 'Engineering', class: 'code', from: { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, to: { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'medium' }, state: 'applied', why: null }] },
      { week: '2026-W46', suggestions: [{ id: 'rp-9f8e7d6c5b4a', dept: 'eng', deptName: 'Engineering', class: 'review', from: { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, to: { provider: 'deepseek', model: 'deepseek-flash' }, state: 'vetoed', why: null }] }, { week: '2026-W45', suggestions: [] }] };
  if (M === 'GET' && p === '/api/routing/proposals') return ok(S.suggest);
  // Settings › How the crew talks to you (console/talk.js): talk.js show --console; the examples are the framework's own
  if (!S.talk) S.talk = { prefs: { v: 1, level: 'technical', length: 'full', often: 'daily', check: 'shadow', source: 'default' }, picked: false, checks: { days: 30, rows: 12, delivered: 9, 'sent-back': 0, masked: 0, shadow: 3, wouldSendBack: 3 } };
  if (M === 'GET' && p === '/api/settings/talk') return ok(Object.assign({}, S.talk, { examples: JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'owner', 'talk-examples.json'), 'utf8')) }));
  if (M === 'POST' && p === '/api/settings/talk') { for (const k of ['level', 'length', 'often']) if (B[k]) S.talk.prefs[k] = B[k]; if (!S.talk.picked) S.talk.prefs.check = 'live'; S.talk.picked = true; S.talk.prefs.source = 'file'; return ok({ changed: true, prefs: S.talk.prefs, said: 'Saved. The crew will talk to you this way from their next message.' }); }
  if (M === 'POST' && p === '/api/routing/proposals/mode') { if (!['off', 'shadow', 'live'].includes(B.mode)) return J(res, 400, { ok: false, error: 'mode is one of off, shadow, live' }); S.suggest.mode = B.mode; emit('routing'); return ok({ changed: true, summary: 'weekly suggestions -> ' + B.mode }); }
  const rtm = p.match(/^\/api\/routing\/(mode|tiercaps)$/), rtt = p.match(/^\/api\/routing\/trials\/([a-z][a-z0-9-]{1,39})\/(start|pause|resume|stop)$/);
  if (M === 'POST' && rtm) { if (!['off', 'shadow', 'live'].includes(B.mode)) return J(res, 400, { ok: false, error: 'mode is one of off, shadow, live' }); if (rtm[1] === 'mode') S.routing.mode = B.mode; else S.routing.tierCaps.mode = B.mode; S.routing.log.unshift({ at: Date.now(), op: rtm[1], to: B.mode, by: 'owner' }); emit('routing'); return ok({ changed: true, summary: rtm[1] + ' -> ' + B.mode }); }
  if (M === 'POST' && rtt) { const t = S.routing.trials.find(x => x.id === rtt[1]); if (!t) return J(res, 400, { ok: false, error: 'no trial' }); t.status = { start: 'running', pause: 'paused', resume: 'running', stop: 'done' }[rtt[2]]; S.routing.log.unshift({ at: Date.now(), op: 'trial-' + rtt[2], trial: t.id, to: t.status, by: 'owner' }); emit('routing'); return ok({ changed: true, summary: rtt[2] + ' trial ' + t.id }); }
  const rlm = p.match(/^\/api\/rulings\/(rule-[a-z0-9]+-[0-9a-f]{4}|r-[a-z0-9]{4,20})\/remove$/), pjm = p.match(/^\/api\/projects\/([a-z0-9-]+)\/(approve|revoke)$/);
  if (M === 'POST' && rlm) { S.rulings = S.rulings.filter(r => r.id !== rlm[1]); emit('rulings'); return ok({ removed: rlm[1] }); }
  if (M === 'POST' && pjm) { const pj = S.projects.find(x => x.id === pjm[1]); if (!pj) return J(res, 400, { ok: false, error: 'no project' }); pj.state = pjm[2] === 'approve' ? 'approved' : 'revoked'; return ok({ project: pj }); }
  switch (M + ' ' + p) {
    case 'GET /api/company': return J(res, 200, S.company);
    // Needs you vs The crew is handling (console/owner-needs.js): the mock's handled card sits apart from S.questions
    case 'GET /api/questions': return ok({ questions: S.questions.map(present), crewHandling: S.crewHandling });
    case 'GET /api/digest': return ok({ title: 'What the crew did today', items: S.digest });
    case 'GET /api/rulings': return ok({ rulings: S.rulings });
    case 'POST /api/rulings': { const r = { id: 'rule-' + Date.now().toString(36) + '-abcd', at: now(), by: 'owner', text: String(B.text || ''), scope: B.scope || {}, effect: B.effect || 'crew-decides', covers: (B.scope && B.scope.categories) || [] }; S.rulings.push(r); emit('rulings'); return ok({ ruling: r }); }
    case 'GET /api/projects': return ok({ projects: S.projects });
    case 'GET /api/questions/answered': return ok({ answered: S.answered });
    case 'GET /api/owner/messages': return ok(ownerView());
    case 'POST /api/owner/messages': { if (!B.text) return J(res, 400, { ok: false, error: 'text is required' }); const m = { dir: 'in', id: 'in-' + Date.now(), at: now(), from: 'Sam Owner', text: (B.to ? B.to + ', ' : '') + B.text }; S.messages.push(m); emit('owner'); return ok({ message: ownerView().messages.find(x => x.id === m.id) }); }
    case 'GET /api/now': return ok({ station: { up: !STATION_DOWN, feed: !STATION_DOWN }, runs: S.live.map(r => Object.assign({}, r, { elapsedSec: Math.round((Date.now() - r.startedAt) / 1000) })),
      seats: S.seats.map(x => Object.assign({ id: x.id, name: x.name, title: x.title, running: S.live.filter(r => r.agentId === x.id).length, loop: x.loop || null, enabled: true, nextRunAt: new Date(Date.now() + 50 * 60000).toISOString(), soonerBecause: x.id === 'agent' ? ['1 open handoff'] : [], wakesOnMessage: x.id === 'agent', schedulerOn: true },
        // the dispatcher's reason for a seat that is not running (dispatch-state.json seats, lib/seat-status.js)
        IDLE[x.id] ? { idle: IDLE[x.id] } : {},
        S.cadence.sprint.active ? { sprint: S.live.some(r => r.agentId === x.id) || x.id === 'agent' || x.id === 'cand-tools-backtest-engineer-1-n' ? 'working' : 'waiting for work', lanes: { running: S.live.filter(r => r.agentId === x.id).length, max: x.id === 'agent' ? 1 : 2, possible: x.id === 'tools1' ? 2 : x.id === 'cand-tools-backtest-engineer-1-n' ? 1 : 0, why: x.id === 'agent' ? 'the CEO works one run at a time' : '7 open item(s) declare no Touches, so everything runs in one lane',
          live: x.id === 'tools1' ? [{ n: 2, handoff: '## from Founder — fix the intake form', since: new Date(Date.now() - 60000).toISOString(), runId: 'run-live-3' }] : [] } } : {})),
      sprint: S.cadence.sprint.active ? { on: true, since: S.cadence.sprint.since, until: S.cadence.sprint.until, untilWhy: S.cadence.sprint.untilWhy, by: S.cadence.sprint.by, floorMin: 2, wakes: 14, idleWakes: 2, idleWakeRatio: 0.15, itemsDone: 9, spentUsd: 0.42, budgetUsd: 4, usdPerItem: 0.047, proposalsPerHour: 1, reviewsPerHour: 0.7 } : null });
    case 'GET /api/activity': return ok({ items: [
      { at: ago(12), kind: 'run', who: 'Founder', title: 'Founder ran "Founder loop"', outcome: 'succeeded', usd: 0.0047, text: 'Wrote the first plan to company/work/plan.md and opened a People Manager round.', links: [{ label: 'Quests', href: '#/work/quests' }, { label: 'Hiring', href: '#/crew/hiring' }] },
      Object.assign({ at: ago(20), kind: 'run', who: 'Teo', title: 'Teo ran "Tools loop"', outcome: 'succeeded', usd: 0, links: [{ label: 'Teo', href: '#/crew/tools1' }] }, ACTIVITY.runText(RAW_RUN_OUT, 0, x => x.split(MOCK_ROOT + '/').join(''))),
      { at: ago(40), kind: 'hiring', who: 'Hiring', title: 'Hired: Mira (people1) as People Manager by Founder', text: 'Crew decides: done without asking you (hiring is set to "auto"; change it in Settings › Autonomy and guardrails)', links: [{ label: 'Crew', href: '#/crew/people1' }, { label: 'Hiring level', href: '#/settings/autonomy/presets' }] },
      { at: ago(300), kind: 'message', who: 'Founder', title: 'Founder wrote to you', text: 'Morning report: two quests moved.', links: [{ label: 'Open', href: '#/chat/owner' }] }] });
    case 'GET /api/setup/charter': { const ph = (S.charterText.match(/<[A-Za-z][^<>\n]{0,200}>/g) || []); return ok({ text: S.charterText, at: ago(60), placeholders: ph, fields: {} }); }
    // walk2: Settings › Models (console/models.js GET /api/models): raw ids from the tool, now.plain is the current-state Why
    case 'GET /api/models': {
      const e = (provider, model, ok, why) => ({ provider, model, key: provider + '/' + model, ok, why: why || 'can run', connected: ok });
      const row = (id, name, cur, chain, plain) => ({ id, name, hasChain: !!chain, primary: chain ? chain[0] : null, chain: chain || [], now: { model: cur, index: chain ? chain.findIndex(x => x.key === cur.provider + '/' + cur.model) : -1, why: chain ? 'fallback 1 of 2: claude-cli/claude-sonnet-5-5 cannot run (checking local sign-in)' : 'no chain of its own: on ' + cur.provider + '/' + cur.model + ', where the pacer\'s routing table or the last hand change put it', plain: plain || null }, history: [] });
      return ok({ failover: { mode: 'live' }, backstop: 'StarNet\'s station-wide fallback chain still catches a single run whose model fails mid-run.', seats: [
        row('agent', 'Founder', { provider: 'deepseek', model: 'deepseek-flash' }, null),
        row('cand-tools-backtest-engineer-1-n', 'Nadia farrell', { provider: 'claude-cli', model: 'claude-sonnet-5-5' }, null),
        row('people1', 'Priya Raman', { provider: 'deepseek', model: 'deepseek-flash' }, [e('claude-cli', 'claude-sonnet-5-5', true), e('deepseek', 'deepseek-flash', true), e('custom', 'MiniMax-M3.1-Flash', true)], 'On a fallback for now. Claude can run again, so it moves back up shortly.')] });
    }
    case 'GET /api/crew': return ok({ seats: S.seats, station: STATION_DOWN ? 'down' : 'up' });
    case 'GET /api/handoffs': return ok({ items: S.handoffs });
    case 'GET /api/handoffs/parked': return ok({ at: now(), items: (S.parked = S.parked || [
      { seat: 'agent', name: 'Founder', inbox: 'to-founder.md', heading: '2026-11-17 22:24 from Teo — recompute the ranking', kind: 'waiting', words: 'waiting for: gold history download to finish' },
      { seat: 'agent', name: 'Founder', inbox: 'to-founder.md', heading: '2026-11-17 22:24 from Teo — read the open', kind: 'notBefore', until: '2026-11-19 09:00', words: 'not before 09:00 tomorrow: market opens' }]),
      running: [{ id: 'c-mock-1', job: 'gold-backfill', why: 'gold backfill', since: ago(40), wakes: ['Founder'] }],
      completions: [{ id: 'c-mock-0', words: 'feed check FAILED: exit 2 after 3 min', failed: true, at: ago(90), wakes: ['Founder'] }] });
    case 'POST /api/handoffs/start-now': S.parked = (S.parked || []).filter(x => x.heading !== B.heading); return ok({ release: { id: 'rel-mock' } });
    case 'GET /api/decisions': return ok({ entries: ['## 2026-11-14 Founder', '- Adopted conflicts-before-engagement.', '## 2026-11-15 People', '- Opened the analyst round.'].map(text => ({ text })) });
    case 'GET /api/dispatch': return ok({ state: { lastTick: ago(4) }, log: ['- 06:40 Dispatcher closed quest q:31 on checked evidence.', '- 04:12 woke Mira (handoff to-people.md)', '- 02:05 held 0, woke Teo (quest q:35)', '- 00:15 Pacer moved two routines off the large model'] });
    case 'GET /api/hiring': return ok({ rounds: [{ id: 'analyst-2026-11', title: 'Analyst', openedBy: 'Founder', template: 'specialist', at: ago(2000), candidates: [{ agentId: 'c1', name: 'Candidate A', provider: 'claude', model: 'example-medium', status: 'candidate', interviewedAt: ago(100) }, { agentId: 'c2', name: 'Candidate B', provider: 'minimax', model: 'example-m', status: 'candidate' }] }], templates: ['people-manager', 'tool-builder', 'risk-manager', 'finance-manager', 'floor-manager', 'specialist'] });
    case 'GET /api/spend': return ok({ windowHours: 24, known: true, today: { usd: 1.37, ownerPaidUsd: 0, capUsd: 5, perSeatCapUsd: 2, inFlightRuns: 1 },
      bySeat: [{ id: 'agent', name: 'Founder', usd: 0.92 }, { id: 'tools1', name: 'Teo', usd: 0.45 }, { id: 'cand-tools-backtest-engineer-1-n', name: 'Nadia farrell', candidate: false, usd: 0.22 }].concat(
        ['tobias-lin:Tobias Lin', 'oskar-:Oskar Berg', 'imani-okafo:Imani Okafor', 'tomas-fe:Tomas Ferreira', 'junko-:Junko Sato', 'priya-raghun:Priya Raghunathan', 's:Sven Ek', 'r:Ruth Adeyemi', 'clara-vo:Clara Vogel', 'marc-delacro:Marc Delacroix', 'tomas-weiss:Tomas Weiss', 'aisha-bell:Aisha Bello']
          .map((x, i) => { const [slug, name] = x.split(':'); return { id: 'cand-example-role-1-' + slug, name, candidate: true, round: 'example-role-1', usd: Math.round((0.0206 - i * 0.0005) * 10000) / 10000 }; })), byProvider: [{ id: 'deepseek', usd: 1.37, capped: true }, { id: 'claude-cli', usd: 0, capped: false }],
      subscriptions: Object.keys(S.limits).filter(k => S.limits[k] && S.limits[k].name).map(k => ({ id: k, name: S.limits[k].name, usedPct: S.limits[k].usedPct, weekStop: S.limits[k].weekStop, line: S.limits[k].line, resetsAt: S.limits[k].resetsAt, open: S.limits[k].open, paceBy: S.limits[k].paceBy, why: S.limits[k].why })),
      pacer: { mode: 'shadow', live: false, emergency: null, boost: null, rail: null, problems: [] } });
    case 'GET /api/usage': return ok({ mode: 'shadow', live: false, claude: { key: 'claude', label: 'Claude Max', known: true, open: true, usedPct: 78, usedToday: null, line: 90, normalLine: 41.9, left: 12, sharesLeft: 0.8, share: 14.3, emergencyOpened: true, why: '12 points under today\'s line (0.8 days\' share) — open only because of the emergency' },
      minimax: { key: 'minimax', label: 'MiniMax', known: true, open: true, usedPct: 24, usedToday: 22, line: 28, share: 50, why: 'near the line' }, deepseek: { label: 'DeepSeek', open: true, why: 'no credit failure seen', reading: null },
      rail: { known: true, pct: 12, perDay: 25, source: 'runs.jsonl' }, emergency: { active: true, by: 'Founder', why: 'the owner lifted today\'s line', until: Date.now() + 5 * 3600e3, ceilingPct: 90 }, boost: { on: false, why: 'off' }, problems: [] });
    case 'GET /api/pacer/limits': return ok(S.limits);
    case 'POST /api/pacer/limit': { const l = S.limits[B.provider]; if (!l) return J(res, 400, { ok: false, error: 'provider is claude or minimax' });
      for (const [k, f] of [['weekStop', 'weekStop'], ['useNow', 'useNow']]) if (B[k] != null) { const n = Number(B[k]); if (!(n >= 0 && n <= 100)) return J(res, 400, { ok: false, error: k + ' must be a number from 0 to 100' }); l[f] = n; }
      l.ownerSet = { at: now(), by: S.company.owner.name, choice: 'set', via: 'console' }; return ok({ key: B.provider, now: { weekStop: l.weekStop, useNow: l.useNow } }); }
    case 'GET /api/governance': return ok(S.governance);
    case 'POST /api/governance/preset': if (!PRESETS[B.preset]) return J(res, 400, { ok: false, error: 'unknown preset' }); setPreset(B.preset); S.setup.govChosen = true; emit('governance'); return ok();
    case 'POST /api/governance/set': { const c = S.governance.categories.find(x => x.category === B.category); if (!c) return J(res, 400, { ok: false, error: 'unknown category' }); c.level = B.level; S.governance.preset = 'custom'; S.governance.presetLabel = 'Custom'; emit('governance'); return ok(); }
    case 'GET /api/guardrails': return J(res, 200, guardView());
    case 'POST /api/guardrails/set': { const g = S.guardrails.guards.find(x => x.name === B.name); if (!g || g.fixed) return J(res, 400, { ok: false, error: 'cannot change ' + B.name }); g.on = !!B.on; emit('guardrails'); return ok(); }
    case 'POST /api/guardrails/all': if (!B.on && B.confirm !== 'I understand there are no guardrails') return J(res, 400, { ok: false, error: 'confirm is required' }); S.guardrails.guards.forEach(g => { if (!g.fixed) g.on = !!B.on; }); emit('guardrails'); return ok();
    case 'POST /api/guardrails/sandbox': S.guardrails.sandbox = !!B.on; emit('guardrails'); return ok();
    case 'GET /api/onboarding': return ok({ provisioned: true, certified: false, lastCertify: now(), steps: [{ id: 'founded', what: 'company.json written and defaults copied', status: 'ok' }, { id: 'candidate-default', what: 'hiring candidates default to a model the company can run', status: 'pending', note: 'metered model with a $0 cap' }],
      checks: [{ id: 'station', what: 'station answers GET /api/cron', status: 'ok' }, { id: 'liveness', what: 'dead-man switch enabled and pinged', status: 'failed', missing: 'liveness module not enabled' }] });
    case 'POST /api/onboarding/certify': { const U = S.setup; U.checks = U.checks || {}; U.checks.charter = U.charter ? [true] : [false, 'placeholders left: <What the company exists to do…>']; U.lastCertify = now();
      const pending = setupView().steps.filter(x => x.id !== 'certify' && x.status === 'needs');
      if (!pending.length) { for (const k of Object.keys(U.checks)) U.checks[k] = [true]; U.certified = true; S.company.onboarding.certified = true; }
      return ok({ certified: U.certified, results: Object.fromEntries(Object.entries(U.checks).map(([k, v]) => [k, { ok: v[0], missing: v[1] || null }])) }); }
    case 'GET /api/setup': return ok(setupView());
    case 'GET /api/decision-models': return ok({ models: [{ id: 'gate-triage', title: 'Gate triage', versions: [1], active: 1, mode: 'shadow', params: { maxUsd: 50 }, cases: 12, evaluations: 3, lastAt: ago(90), valid: true }] });
    case 'POST /api/setup/company': {
      try { new Intl.DateTimeFormat('en', { timeZone: B.timezone }); } catch (_) { return J(res, 400, { ok: false, error: 'timezone must be an IANA zone such as Europe/London or America/New_York' }); }
      if (!String(B.name || '').trim() || !String(B.ownerName || '').trim()) return J(res, 400, { ok: false, error: 'name and owner name are required' });
      S.company.name = B.name.trim(); S.company.owner = { name: B.ownerName.trim() }; S.company.timezone = B.timezone; return ok({ changes: ['mock'] }); }
    case 'GET /api/__mock/minimax': return ok({ log: mmLog, stored: S.setup.mm || null });
    case 'GET /api/setup/minimax-endpoint': return ok({ endpoint: mmViewOf(mmEp()) });
    case 'POST /api/setup/provider/detect': {
      const key = String(B.key || '') || S.setup.mmKey || ''; if (!key) return J(res, 400, { ok: false, error: 'paste your MiniMax key first' });
      const tried = [];
      for (const region of MME.ORDER) { const r = mmOk(MME.resolve({ region }), key); mmLog.push({ path: 'detect', region, baseUrl: MME.REGIONS[region].baseUrl, key: true }); tried.push(Object.assign({ region, label: MME.REGIONS[region].label }, r)); if (r.valid) break; }
      const hit = tried.find(t => t.valid);
      if (hit) return ok({ found: hit.region, label: hit.label, why: 'found', tried, text: 'Your key works on ' + hit.label + '.' + (hit.region === 'global' ? '' : ' Global did not accept it.') });
      const net = tried.every(t => !t.reachable);
      return ok({ found: null, why: net ? 'network' : 'bad-key', tried, text: net ? 'Neither MiniMax region could be reached from the station machine, so the key was not checked. Check the station\'s internet connection and try again.' : 'Neither Global nor Mainland China accepted this key. Check that you copied all of it, from the MiniMax site where your account is, and that the plan is active.' }); }
    case 'POST /api/setup/provider/validate': if (B.provider === 'custom') {
      const w = mmWanted(B); if (!w.ep.ok) return J(res, 400, { ok: false, error: w.ep.error });
      mmLog.push({ path: 'validate', region: w.ep.region, baseUrl: w.ep.baseUrl, key: !!B.key });
      const r = mmOk(w.ep, B.key); return ok({ provider: 'custom', valid: r.valid, reachable: r.reachable, error: r.error, modelCount: r.valid ? 3 : 0, endpoint: mmViewOf(w.ep) });
    }
      return ok({ provider: B.provider, valid: /^sk-good/.test(B.key || ''), reachable: true, error: /^sk-good/.test(B.key || '') ? null : 'HTTP 401: invalid key (mock: keys starting sk-good pass)', modelCount: 12 });
    case 'POST /api/setup/provider': {
      const U = S.setup;
      if (STATION_DOWN) return J(res, 502, { ok: false, error: 'station unreachable: connect ECONNREFUSED' });
      if (B.provider === 'claude-cli') { if (!U.claude.loggedIn) return J(res, 400, { ok: false, error: 'Claude is not signed in on the station yet: finish the sign-in first' }); }
      else if (B.provider === 'custom') {
        // as console/setup.js: the endpoint asked for is checked with the key (the key on file when switching with none)
        const w = mmWanted(B); if (!w.ep.ok) return J(res, 400, { ok: false, error: w.ep.error });
        const prev = mmEp(); const switching = w.explicit && !MME.same(w.ep, prev);
        const key = String(B.key || '') || (switching ? U.mmKey || '' : '');
        if (!key && !U.ready.includes('custom')) return J(res, 400, { ok: false, error: 'paste the API key' });
        if (key) { const r = mmOk(w.ep, key); if (!r.valid) return J(res, 400, { ok: false, error: 'MiniMax ' + MME.plain(w.ep) + ' did not accept ' + (B.key ? 'that key' : 'the key on file') + (r.reachable ? '. Check the key, or pick the region where your account is.' : ': it could not be reached from the station machine.') }); U.mmKey = key; }
        if (w.explicit && (switching || !prev.stored)) U.mm = MME.entryOf(w.ep, 'Owner');
        mmLog.push({ path: 'provider', region: w.ep.region, baseUrl: w.ep.baseUrl, key: !!B.key, saved: !!U.mm });
      }
      else if (!U.ready.includes(B.provider) && !/^sk-good/.test(B.key || '')) return J(res, 400, { ok: false, error: 'the provider did not accept that key: HTTP 401 (mock: keys starting sk-good pass)' });
      if (!U.ready.includes(B.provider)) U.ready.push(B.provider);
      if (B.keepDefault === true) return ok({ connected: true, provider: B.provider, keyOnly: true, endpoint: B.provider === 'custom' ? mmViewOf(mmEp()) : undefined });
      if (B.provider === 'custom' && B.subscription !== false && !U.budget.unmeteredProviders.includes('custom')) U.budget.unmeteredProviders.push('custom');
      const model = { 'claude-cli': 'claude-haiku-4-5-20251001', custom: 'MiniMax-M3.1-Pro', deepseek: 'deepseek-flash', openrouter: 'deepseek/deepseek-chat', anthropic: 'claude-haiku-4-5' }[B.provider];
      U.candidateDefault = { provider: B.provider, model };
      const runnable = U.budget.unmeteredProviders.includes(B.provider) || U.budget.dailyUsd > 0;
      if (runnable) { const i = S.questions.findIndex(q => q.id === 'q-000050'); if (i >= 0) S.questions[i].q = S.questions[i].q.replace(/\n- Hiring candidates[^\n]*/, ''); emit('questions'); }
      return ok({ connected: true, provider: B.provider, model, runnable }); }
    case 'POST /api/setup/budget': { const d = Number(B.dailyUsd), p2 = Number(B.perAgentUsd || 0); if (!(d >= 0) || !(p2 >= 0)) return J(res, 400, { ok: false, error: 'dailyUsd must be a number from 0 to 10000' }); if (p2 > d && d > 0) return J(res, 400, { ok: false, error: 'the per-agent share cannot be more than the daily cap' });
      Object.assign(S.setup.budget, { dailyUsd: d, perAgentUsd: d > 0 ? p2 : 0, setBy: S.company.owner.name, setAt: now() }); return ok({ dailyUsd: d, perAgentUsd: p2 }); }
    case 'POST /api/setup/charter': if (typeof B.text === 'string') { S.charterText = B.text; const ph = (B.text.match(/<[A-Za-z][^<>\n]{0,200}>/g) || []); if (!ph.length) S.setup.charter = { mandate: 'edited', forWhom: '', outOfScope: 'edited', firstGoal: '' }; emit('charter'); return ok({ text: B.text, placeholders: ph, saved: true }); }
      if (String(B.mandate || '').trim().length < 10) return J(res, 400, { ok: false, error: 'say in a sentence or two what the company does' }); if (!String(B.outOfScope || '').trim()) return J(res, 400, { ok: false, error: 'say what the company will not do (write "Nothing yet" if you have no limits in mind)' });
      S.setup.charter = { mandate: B.mandate, forWhom: B.forWhom || '', outOfScope: B.outOfScope, firstGoal: B.firstGoal || '' }; if (S.setup.checks) S.setup.checks.charter = [true];
      S.charterText = '# ' + S.company.name + ' — Company Charter\n\n## Mandate\n\n' + B.mandate + '\n\n## What is out of scope\n\n' + B.outOfScope + '\n\n## First goal\n\n' + (B.firstGoal || 'The Founder proposes it.') + '\n'; emit('charter'); return ok({ placeholders: [] });
    case 'GET /api/halt': return ok(S.halt);
    case 'POST /api/halt/soft': S.halt = { mode: 'soft', by: 'Sam Owner', at: now(), why: B.why || null, deadline: new Date(Date.now() + (B.deadlineMin || 30) * 60000).toISOString(), escalate: !!B.escalate,
      shutdowns: [{ seat: 'Founder', routine: 'Founder shutdown', maxMinutes: 15, status: 'fired', done: false }, { seat: 'Mira', routine: '—', status: 'missing' }], left: ['Tools loop (running)'] }; emit('halt'); return ok(S.halt);
    case 'POST /api/halt/hard': S.halt = { mode: 'hard', by: 'Sam Owner', at: now(), why: B.why || null }; emit('halt'); return ok(S.halt);
    case 'POST /api/halt/resume': S.halt = { mode: 'running' }; emit('halt'); return ok(S.halt);
    case 'GET /api/cadence': return ok(S.cadence);
    case 'GET /api/cadence/sprint': return ok({ on: S.cadence.sprint.on, active: S.cadence.sprint.active, since: S.cadence.sprint.since, until: S.cadence.sprint.until, wakes: 14, idleWakes: 2, idleWakeRatio: 0.15, itemsDone: 9, spentUsd: 0.42, budgetUsd: 4, usdPerItem: 0.047, proposals: 3, reviews: 2, proposalsPerHour: 1, reviewsPerHour: 0.7 });
    case 'POST /api/cadence/sprint': { const on = B.on === true; Object.assign(S.cadence.sprint, { on, active: on, until: on && B.hours ? new Date(Date.now() + Number(B.hours) * 3600e3).toISOString() : null, endedAt: on ? null : now(), endedWhy: on ? null : 'turned off by the owner', by: on ? 'Sam Owner' : S.cadence.sprint.by }); emit('cadence'); emit('now'); return ok(); }
    case 'POST /api/cadence/default': if (B.minutes != null) S.cadence.dispatcherTickMin = Number(B.minutes); if (B.cooldown != null) S.cadence.defaultCooldownMin = Number(B.cooldown); if (B.maxPerTick != null) S.cadence.maxPerTick = Number(B.maxPerTick); emit('cadence'); return ok();
    case 'POST /api/cadence/bounds': { const b = S.cadence.bounds, t = S.cadence.tempo; for (const k of ['tickMin', 'cooldownMin', 'maxWakesPerHour', 'maxWakesPerDay', 'quietHours']) if (B[k] !== undefined) b[k] = B[k]; for (const k of ['mode', 'autoExpireMin', 'minChangeIntervalMin']) if (B[k] !== undefined) t[k] = B[k]; emit('cadence'); return ok(); }
    case 'POST /api/cadence/end-temporary': S.cadence.temporary = null; S.cadence.effective = Object.assign({}, S.cadence.effective, { tickMin: S.cadence.dispatcherTickMin, source: 'base' }); emit('cadence'); return ok();
    case 'POST /api/cadence/seat': { const s = S.cadence.seats[B.seat]; if (!s) return J(res, 400, { ok: false, error: 'no seat ' + B.seat }); if (B.cooldown != null) s.cooldownMin = { value: Number(B.cooldown) }; if (B.priority != null) s.priority = { value: Number(B.priority) }; if (B.wakeOnInbox != null) s.wakeOnInbox = { value: B.wakeOnInbox }; if (B.wakeOnOwner != null) s.wakeOnOwnerMessage = { value: B.wakeOnOwner }; emit('cadence'); return ok(); }
    case 'GET /api/panels': return ok({ panels: panelList() });
    case 'GET /api/governance-log': return ok({ entries: [{ at: ago(600), by: 'Sam Owner', event: 'preset', preset: 'gate-money-people' }] });
    case 'GET /api/locked': return ok({ text: 'locked-watch: 14 files watched, 0 drifted (mock)' });
    case 'GET /api/external': return ok({ text: 'external-gate: 1 clearance\n  message  owner channel (file adapter)  pinned (mock)' });
    case 'GET /api/today': return ok({ company: S.company, needsYou: { questions: S.questions.map(present), count: S.questions.length }, crewHandling: S.crewHandling, digest: { items: S.digest }, halt: S.halt });
  }
  let m;
  if (M === 'GET' && (m = /^\/api\/chat\/([A-Za-z0-9_-]+)$/.exec(p))) {
    const seat = S.seats.find(x => x.id === m[1]); if (!seat) return J(res, 404, { ok: false, error: 'no crew member ' + m[1] });
    return ok({ agent: { id: seat.id, name: seat.name, title: seat.title }, model: 'example-model-large', provider: 'claude-cli', modelFrom: 'its loop routine "Founder loop"', streamId: 'console-' + seat.id, turns: S.chats[seat.id] || [],
      problems: STATION_DOWN ? [{ code: 'station-down', message: 'The station is not answering, so ' + seat.name + ' cannot answer.', fix: 'Start it on the station machine.', link: '#/settings/system' }] : [] });
  }
  if (M === 'POST' && (m = /^\/api\/chat\/([A-Za-z0-9_-]+)\/send$/.exec(p))) return chatSend(req, res, m[1], B);
  // colleagues in a live chat (console/huddle.js): who is in it, + Colleague, ×; no turns are run here
  if ((m = /^\/api\/huddle\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(p))) {
    const host = S.seats.find(x => x.id === m[1]); if (!host) return J(res, 404, { ok: false, error: 'no crew member ' + m[1] });
    const hd = (S.huddles = S.huddles || {})[host.id] = S.huddles[host.id] || { guests: [], log: [] };
    const seatRow = (s, lead) => ({ id: s.id, name: s.name, title: s.title, leader: lead, guest: !lead, model: { label: 'Claude Sonnet' } });
    const hv = () => ({ host: { id: host.id, name: host.name }, open: hd.guests.length > 0, limits: { guests: 3 }, live: { phase: 'idle' }, meeting: { id: 'm-mock1', state: hd.guests.length ? 'open' : 'closed' },
      seats: hd.guests.length ? [seatRow(host, true)].concat(hd.guests.map(g => seatRow(S.seats.find(x => x.id === g), false))) : [],
      roster: S.seats.filter(x => x.id !== host.id).map(x => ({ id: x.id, name: x.name, title: x.title, seated: hd.guests.includes(x.id) })) });
    const sub = m[2] || '';
    if (M === 'GET' && !sub) return ok(hv());
    if (M === 'GET' && sub === '/entries') return ok({ entries: hd.log });
    if (M === 'GET' && sub === '/history') return ok({ huddles: [] });
    if (M === 'POST' && sub === '/seats') {
      for (const id of B.add || []) if (!hd.guests.includes(id)) { hd.guests.push(id); const g = S.seats.find(x => x.id === id); hd.log.push({ i: hd.log.length + 1, kind: 'join', who: id, name: g ? g.name : id, by: 'owner', byName: 'Sam Owner', at: now() }); }
      for (const id of B.remove || []) if (hd.guests.includes(id)) { hd.guests = hd.guests.filter(x => x !== id); const g = S.seats.find(x => x.id === id); hd.log.push({ i: hd.log.length + 1, kind: 'leave', who: id, name: g ? g.name : id, by: 'owner', byName: 'Sam Owner', at: now() }); }
      if (!hd.guests.length) hd.log = [];
      emit('huddle'); return ok(hv());
    }
    if (M === 'POST' && sub === '/say') { hd.log.push({ i: hd.log.length + 1, kind: 'say', who: 'owner', name: 'Sam Owner', text: String(B.text || ''), at: now() }); emit('huddle'); return ok(hv()); }
  }
  // chat actions and approvals (console/server.js): the key store keeps only the name and length; approvals as approvals.js
  if (M === 'POST' && p === '/api/chat-actions/secret') {
    if (!INBOX.safeSecretName(B.name)) return J(res, 400, { ok: false, error: 'bad secret name' });
    if (typeof B.value !== 'string' || !B.value.trim()) return J(res, 400, { ok: false, error: 'paste the key first' });
    const chars = B.value.trim().length; S.mockActions.stored.push({ name: B.name, chars }); return ok({ stored: 'secrets/' + B.name, name: B.name, chars }); }
  if (M === 'GET' && p === '/api/__mock/actions') return ok(S.mockActions);
  if (M === 'GET' && p === '/api/connectors') return ok({ connectors: CONN_DECLS.map(connRow), errors: [] });
  if ((m = /^\/api\/(?:__mock\/approve|connectors)\/([a-z0-9-]+)(?:\/([a-z]+))?$/.exec(p))) {
    const d = CONN_DECLS.find(x => x.id === m[1]); if (!d) return J(res, 404, { ok: false, error: 'no connector "' + m[1] + '"' });
    const act = p.startsWith('/api/__mock/') ? 'approve' : (m[2] || '');
    const x = S.connSessions[d.id];
    if (M === 'GET' && act === '') return ok({ connector: connRow(d) });
    if (M === 'GET' && act === 'session') return ok(connView(d, req));
    if (M === 'POST' && act === 'connect') {
      if (x && !x.ended) return J(res, 409, { ok: false, error: d.label + ' sign-in is already open. Finish it or cancel it first.' });
      const url = d.style === 'loopback' ? 'https://auth.example.invalid/oauth/google/start?cli_port=48123&cli_state=mock-state-1&cli_challenge=x' : 'https://github.com/login/device';
      S.connSessions[d.id] = { phase: 'sign-in', url, code: d.style === 'device-code' ? 'MOCK-1234' : null, expect: d.style === 'loopback' ? CONN.expectation(d, url) : null, started: now(), at: Date.now() };
      return ok(connView(d, req));
    }
    if (M === 'POST' && act === 'callback') {
      if (!x || x.ended || x.phase !== 'sign-in' || d.style !== 'loopback') return J(res, 409, { ok: false, error: 'No ' + d.label + ' sign-in is waiting for an address. Start one with Connect.' });
      const c = CONN.checkCallback(B.address, x.expect); if (!c.ok) return J(res, 400, { ok: false, error: c.error });
      if (c.error) { Object.assign(x, { phase: 'failed', ended: true, error: d.label + ' sign-in did not finish (the program stopped with exit 1).', knownIssue: (d.knownIssues || [])[0] ? { title: d.knownIssues[0].title, text: d.knownIssues[0].text } : null }); return ok(Object.assign(connView(d, req), { accepted: false })); }
      Object.assign(x, { phase: 'finishing', at: Date.now() }); return ok(Object.assign(connView(d, req), { accepted: true }));
    }
    if (M === 'POST' && act === 'approve') { if (x && x.phase === 'sign-in') Object.assign(x, { phase: 'finishing', at: Date.now() }); return ok({}); }
    if (M === 'POST' && act === 'cancel') { if (x && !x.ended) Object.assign(x, { phase: 'cancelled', ended: true, message: 'Cancelled.' }); return ok(connView(d, req)); }
    if (M === 'POST' && act === 'disconnect') {
      if (B.confirm !== true) return J(res, 400, { ok: false, error: 'Disconnecting removes ' + d.credentialPath.join(', ') + ' from the station. Confirm to go ahead.' });
      S.connections[d.id] = { state: 'not-connected' }; S.mockActions.connectors.push({ id: d.id, disconnected: true }); return ok({ id: d.id, removed: d.credentialPath, loggedOut: true });
    }
    return J(res, 405, { ok: false, error: 'mock: ' + M + ' ' + p });
  }
  if (M === 'GET' && p === '/api/service-keys') return ok({ keys: serviceKeyRows(), services: SKEYS.offers() });
  if (M === 'POST' && p === '/api/service-keys') {   // as console/service-keys.js save(): checks, then keeps {at, chars} only
    const known = B.service && B.service !== 'other' ? SKEYS.offers().find(x => x.id === B.service) : null;
    if (B.service && B.service !== 'other' && !known) return J(res, 400, { ok: false, error: 'unknown service' });
    const name = String(B.name || (known && known.name) || '').trim();
    if (SKEYS.RESERVED.has(name.toLowerCase())) return J(res, 400, { ok: false, error: '"' + name + '" is the framework\'s own file; it cannot be set from here' });
    if (!SKEYS.safeName(name)) return J(res, 400, { ok: false, error: 'the name may use letters, digits, . _ - only (no folders), up to 64 characters' });
    if (typeof B.value !== 'string' || !B.value.trim()) return J(res, 400, { ok: false, error: 'paste the key first' });
    const d = SKEYS.describe(name);
    if (d.kind === 'address' && !/^https?:\/\/\S+$/.test(B.value.trim())) return J(res, 400, { ok: false, error: 'this one is a web address: paste the whole address, starting with https://' });
    const ex = S.serviceKeys[name] && S.serviceKeys[name].at;
    if (ex && !B.replace) return J(res, 409, { ok: false, error: d.label + ' is already saved. Use Replace to overwrite it.', detail: { code: 'exists', name } });
    S.serviceKeys[name] = Object.assign({}, S.serviceKeys[name], { at: now(), chars: B.value.trim().length });
    S.mockActions.serviceKeys.push({ name, chars: B.value.trim().length, replaced: !!ex, told: 'Founder' });
    emit('questions');
    return ok({ name, label: d.label, kind: d.kind, stored: 'secrets/' + name, chars: B.value.trim().length, replaced: !!ex, told: 'Founder' });
  }
  if (M === 'POST' && p === '/api/__mock/archive-chat') { S.chats.agent = []; return ok({}); }
  if (M === 'GET' && p === '/api/approvals') return ok({ approvals: Object.values(S.approvals).filter(r => r.status === 'pending') });
  if (M === 'GET' && (m = /^\/api\/approvals\/(q-\d+)$/.exec(p))) { const r = S.approvals[m[1]]; return r ? ok(r) : J(res, 404, { ok: false, error: 'no approval record ' + m[1] }); }
  if (M === 'POST' && (m = /^\/api\/approvals\/(q-\d+)\/answer$/.exec(p))) {
    const r = S.approvals[m[1]]; S.mockActions.answers.push({ id: m[1], verdict: B.verdict, surface: B.surface, shownDigest: B.shownDigest });
    if (!r) return J(res, 404, { ok: false, error: 'no approval record ' + m[1] });
    if (r.status !== 'pending') return J(res, 409, { ok: false, error: m[1] + ' is already ' + r.status });
    if (B.surface === 'chat' && r.fixed) return J(res, 409, { ok: false, error: r.authority.why });
    if (B.shownDigest !== r.actionDigest) return J(res, 409, { ok: false, error: 'stale' });
    r.status = B.verdict === 'yes' ? 'approved' : 'denied'; r.answer = { by: 'Commander', surface: B.surface, at: now() }; r.chatAnswerable = false;
    S.questions = S.questions.filter(x => x.id !== m[1]); emit('questions'); return ok({ state: r.status, surface: B.surface }); }
  if (M === 'GET' && (m = /^\/api\/now\/run\/([A-Za-z0-9_-]+)$/.exec(p))) {
    const after = Number(q.get('after')) || 0;
    const evs = [{ seq: 1, name: 'tool', tool: 'fs_read', text: 'reading the charter', callId: 'c1' }, { seq: 2, name: 'result', callId: 'c1', ok: true }, { seq: 3, name: 'tool', tool: 'code.run', text: 'running hire.js open…', callId: 'c2' }, { seq: 4, name: 'token', delta: 'Opening a **People Manager** round now.' }];
    return ok({ known: true, runId: m[1], agentId: 'agent', name: 'Founder', events: evs.filter(e => e.seq > after), seq: 4, done: false });
  }
  if (M === 'POST' && (m = /^\/api\/questions\/(q-\d+)\/answer$/.exec(p))) {
    const i = S.questions.findIndex(x => x.id === m[1]); if (i < 0) return J(res, 404, { ok: false, error: 'no open question ' + m[1] });
    const q0 = S.questions[i];
    let ans;
    if (B.endpoints || (B.parts && Object.values(B.parts).some(x => x && x.endpoints))) {
      for (const [fid, e] of Object.entries(B.endpoints || Object.assign({}, ...Object.values(B.parts).map(x => (x && x.endpoints) || {})))) {
        const ep = MME.resolve(Object.assign({}, e, { region: e.region || 'custom' })); if (!ep.ok) return J(res, 400, { ok: false, error: ep.error });
        mmLog.push({ path: 'question', id: m[1], field: fid, region: ep.region, baseUrl: ep.baseUrl, key: true }); S.setup.mm = MME.entryOf(ep, 'Owner');
      }
    }
    const pq = present(q0);
    // several questions: {parts, closeRest}; the old store-key on a request maps to its key question
    if (pq.questions && !B.parts && (B.action === 'store-key' || B.store)) { const kp = pq.questions.find(x => x.kind === 'secret' && !x.answered); if (kp) B.parts = { [kp.id]: { action: 'store', values: { key: (B.values || {})[B.store || 'key'] } } }; }
    if (pq.questions && (B.parts || B.closeRest)) {
      const parts = {};
      for (const [pid, r0] of Object.entries(B.parts || {})) { const qp = pq.questions.find(x => x.id === pid); if (!qp) return J(res, 400, { ok: false, error: 'no question ' + pid }); parts[pid] = Object.assign({}, r0, { values: placeholderSecrets(qp.form, r0.values || {}, r0) }); }
      let c; try { c = INBOX.computeParts(Object.assign({ type: 'ask' }, q0), parts, !!B.closeRest); } catch (e) { return J(res, 400, { ok: false, error: e.message }); }
      q0.parts = Object.assign({}, q0.parts); for (const [pid, r] of Object.entries(c.results)) q0.parts[pid] = Object.assign({ at: now() }, r);
      const stored = Object.values(c.results).flatMap(r => Object.values(r.answer.values || {}).filter(v => v && v.stored));
      if (c.finished) { S.questions.splice(i, 1); S.answered.push(Object.assign({}, q0, { answer: c.a, answerDetail: c.final, answeredAt: now() })); }
      emit('questions'); return ok({ state: c.finished ? 'answered' : 'open', a: c.a, answer: c.finished ? c.final : null, answered: c.questions.length - c.left.length, total: c.questions.length, left: c.left, stored });
    }
    if (B.store) {   // a key stored inside a form that asks for more: kept as {stored, chars}, the question stays open
      const v = placeholderSecrets(pq.form, { [B.store]: (B.values || {})[B.store] }, B)[B.store];
      if (!v || typeof v !== 'object') return J(res, 400, { ok: false, error: 'paste the key first' });
      q0.stored = Object.assign({}, q0.stored, { [B.store]: v }); emit('questions'); return ok({ state: 'open', stored: [v] });
    }
    if (!B.action) {
      if (!['yes', 'no', 'reply'].includes(B.verdict)) return J(res, 400, { ok: false, error: 'verdict must be yes, no or reply' });
      ans = { a: B.verdict === 'reply' ? B.text : B.verdict + (B.text ? ': ' + B.text : '') };
    } else {
      // as the real server: a secret value is replaced by where it would be stored before anything else sees it; never kept
      const form = pq.form; const values = Object.assign({}, B.values || {}); const stored = [];
      for (const f of form.fields.filter(x => x.type === 'secret')) {
        const v = values[f.id]; if (v === undefined) continue;
        const name = f.hinted && B.secretNames && B.secretNames[f.id] ? B.secretNames[f.id] : f.name;
        if (name === 'existing-key' && !(B.replace && B.replace[f.id])) return J(res, 409, { ok: false, error: 'secrets/' + name + ' already exists. Tick "replace the stored key" to overwrite it.' });
        values[f.id] = { stored: 'secrets/' + name, chars: String(v).trim().length, validated: null }; stored.push(values[f.id]); S.mockStored = (S.mockStored || 0) + 1;
      }
      try { const row = Object.assign({}, q0, { form }); if (INBOX.storeOnlyAction(form, form.actions.find(a => a.id === B.action)) && !INBOX.secretOnly(form)) throw new Error('storing a key does not answer this question'); const st = INBOX.checkAnswer(row, { action: B.action, values, note: B.note }); ans = { a: INBOX.plainAnswer(row, st), answerDetail: st, stored }; }
      catch (e) { return J(res, 400, { ok: false, error: e.message }); }
    }
    S.questions.splice(i, 1); S.answered.push(Object.assign({}, q0, { answer: ans.a, answerDetail: ans.answerDetail || null, answeredAt: now() })); emit('questions'); return ok({ state: 'answered', a: ans.a, answer: ans.answerDetail || null, stored: ans.stored || [] });
  }
  if (M === 'POST' && (m = /^\/api\/questions\/(q-\d+)\/snooze$/.exec(p))) {
    const q0 = S.questions.find(x => x.id === m[1]); if (!q0) return J(res, 404, { ok: false, error: 'no open question ' + m[1] });
    const t = Date.parse(B.until); if (!(t > Date.now())) return J(res, 400, { ok: false, error: 'until must be in the future' });
    q0.snoozedUntil = new Date(t).toISOString(); emit('questions'); return ok({ id: q0.id, snoozedUntil: q0.snoozedUntil });
  }
  if ((m = /^\/api\/panels\/([a-z0-9-]+)\/(data|view)$/.exec(p))) {
    const P = PANELS[m[1]]; if (!P) return J(res, 404, { ok: false, error: 'no panel ' + m[1] });
    if (m[2] === 'view') { if (!P.view) return J(res, 404, { ok: false, error: 'no custom view' }); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(P.view)); }
    if (!P.data) return J(res, 400, { ok: false, error: 'panel does not validate', findings: ['x', 'y'] });
    return J(res, 200, P.data());
  }
  if (M === 'POST' && (m = /^\/api\/panels\/([a-z0-9-]+)\/(hide|unhide|approve|reject|remove)$/.exec(p))) {
    const P = PANELS[m[1]]; if (!P) return J(res, 404, { ok: false, error: 'no panel' });
    if (m[2] === 'hide') S.hidden[m[1]] = true; else if (m[2] === 'unhide') delete S.hidden[m[1]]; else if (m[2] === 'approve') P.meta.status = 'installed'; else delete PANELS[m[1]];
    emit('panels'); return ok({ status: m[2] });
  }
  J(res, 404, { ok: false, error: 'mock: no route ' + M + ' ' + p });
}

function ownerView() {
  const stuck = STATION_DOWN;
  const ch = { ok: !stuck, problems: stuck ? [{ code: 'station-down', msg: 'the station does not answer', fix: 'Start it on the station machine.', link: '#/settings/system' }] : [], ceo: { id: 'agent', name: 'Founder' }, nextCheckMin: 7, working: false };
  const msgs = S.messages.map(m => m.dir !== 'in' ? m : Object.assign({}, m, { state: m.acked ? { status: 'read', text: 'read by Founder: approved the trial' }
    : stuck ? { status: 'stuck', text: 'nobody will pick this up: the station does not answer', fix: 'Start it on the station machine.', link: '#/settings/system' } : { status: 'waiting', text: 'waiting for the Founder — next check within 7 min', nextCheckMin: 7 } }));
  return { messages: msgs, channel: ch };
}
// the live chat, streamed like console/chat.js: console.user, console.run, the run events, a tool step, then the end
function chatSend(req, res, id, B) {
  const seat = S.seats.find(x => x.id === id); if (!seat) return J(res, 404, { ok: false, error: 'no crew member ' + id });
  const text = B.brief === 'charter' ? 'Let us write the company charter together, here in this chat. First ask me a few short questions…' : String(B.text || '').trim();
  if (!text) return J(res, 400, { ok: false, error: 'text is required' });
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const out = [{ name: 'console.user', payload: { text, brief: B.brief || null } }];
  if (STATION_DOWN) { out.push({ name: 'console.error', payload: { code: 'station-down', message: 'The station is not answering, so ' + seat.name + ' cannot answer.', fix: 'Start it on the station machine.', link: '#/settings/system' } }); for (const e of out) res.write(JSON.stringify(e) + '\n'); return res.end(); }
  const reply = B.brief === 'charter' ? 'Happy to. Three quick questions:\n\n1. What does the company do?\n2. For whom?\n3. What will it never do?\n\nWhen I have your answers I will write `company/CHARTER.md`. [Review it in Setup](console:#/setup/charter)'
    : /\n\[actionReply \{/.test(text) ? 'Got it: ' + text.split('\n')[0] + '.' : /fail/i.test(text) ? null : 'Mock reply from ' + seat.name + ': I read your message and would start with **the overdue handoff**. See [Work](console:#/work/handoffs) and [the docs](https://example.org/docs). [bad](javascript:alert(1))';
  out.push({ name: 'console.run', payload: { agentId: id, name: seat.name, model: 'example-model-large', provider: 'claude-cli' } }, { name: 'agent.run.start', payload: { runId: 'chat-' + Date.now(), agentId: id } });
  const runId = out[out.length - 1].payload.runId;
  out.push({ name: 'agent.tool_call', payload: { runId, callId: 't1', name: 'fs_read', argsSummary: 'company/CHARTER.md' } }, { name: 'agent.tool_result', payload: { runId, callId: 't1', ok: true, summary: '40 lines' } });
  if (/use a tool/i.test(text)) { out.push({ name: 'permission.prompt', payload: { runId, promptId: 'p1', tool: 'code.run', argsSummary: 'ls company/work' } }); for (let k = 0; k < 80; k++) out.push({ name: 'mock.wait', payload: {} }); }
  if (!reply) out.push({ name: 'agent.run.error', payload: { runId, message: 'provider error: HTTP 401 invalid key' } }, { name: 'agent.run.end', payload: { runId, reason: 'error', outcome: 'failed', usd: 0 } });
  else { for (const w of reply.match(/\S+\s*/g)) out.push({ name: 'agent.token', payload: { runId, delta: w } }); out.push({ name: 'agent.run.end', payload: { runId, reason: 'done', outcome: 'succeeded', usd: 0.0021 } }); }
  const t = (S.chats[id] = S.chats[id] || []);
  let i = 0; const timer = setInterval(() => {
    if (i < out.length) { res.write(JSON.stringify(out[i++]) + '\n'); return; }
    clearInterval(timer); t.push({ role: 'user', content: text, at: now() }); if (reply) t.push({ role: 'assistant', content: reply, at: now() }); res.end();
  }, 50);
  req.on('close', () => clearInterval(timer));
}

const groups = [{ id: 'g1', title: 'Crew group', members: ['agent', 'people1', 'tools1'], updatedAt: ago(90), messages: [{ id: 'm1', seq: 1, author: 'agent', content: 'Weekly standup: intake tool next.', at: ago(90) }] }];
function station(req, res, p, q, B) {
  if (STATION_DOWN) return J(res, 502, { ok: false, error: 'station unreachable: connect ECONNREFUSED' });
  const route = req.method + ' ' + p;
  if (route === 'GET health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (route === 'GET quests') return J(res, 200, { ok: true, quests: [
    // walk2: a title with its delivery target, a title the station cut, a done quest with unticked steps (no blocked one)
    { id: 'q:11', title: 'Recorder: live day sealed, tape decided, five-day floor met -> floor-met.md', agentId: 'tools1', status: 'open', contract: { type: 'artifact', key: 'company/work/sim/floor-met.md' }, steps: [['First live day sealed', false], ['Tape decision recorded', true], ['Five sealed days', false]] },
    { id: 'q:10', title: 'Every company day banked by the recorder, with the live sealed-day count kept as', desc: 'The live count is rewritten to day-count.md every night.', agentId: 'tools1', status: 'done', steps: [['Daily bank timer armed', true], ['First live day', false], ['Five days', false], ['Tape decision', false]] },
    { id: 'q:9', title: 'Round B floor-manager-1 files written and the round opened with a scores rule ->', agentId: 'people1', status: 'done', contract: { type: 'artifact', key: 'company/hiring/floor-manager-1/scorecard.md' }, steps: [['Research', true], ['Scorecard', true]] },
    { id: 'q:34', title: 'Q1 plan from the charter', agentId: 'agent', status: 'open', steps: [{ key: 'a', label: 'Draft', done: true }, { key: 'b', label: 'Pricing model', done: false }] },
    { id: 'q:8', title: 'Backtest the quote recorder', agentId: 'cand-tools-backtest-engineer-1-n', status: 'open', steps: [{ key: 'a', label: 'Replay a day', done: true }, { key: 'b', label: 'Compare fills', done: false }] },
    { id: 'q:35', title: 'Matter intake tool', agentId: 'tools1', status: 'open', disposition: process.env.MOCK_BLOCKED ? 'blocked' : null, steps: [{ key: 'a', label: 'Spec', done: true }, { key: 'b', label: 'Access', done: false }] },
    { id: 'q:31', title: 'Engagement letter template', agentId: 'tools1', status: 'done', attest: true, steps: [{ key: 'a', label: 'x', done: true }] }] });
  if (route === 'GET cron') return J(res, 200, { enabled: true, halted: false, jobs: [
    { id: 'j1', name: 'Founder loop', agentId: 'agent', scheduleDisplay: 'every 2 h', model: 'example-model-large', enabled: true, nextRunAt: new Date(Date.now() + 50 * 60000).toISOString() },
    { id: 'j2', name: 'Morning brief', agentId: 'agent', scheduleDisplay: '07:00 daily', model: 'example-small', enabled: true, lastStatus: 'error', lastError: 'timeout' }] });
  if (route === 'POST cron/run') return J(res, 200, { ok: true });
  if (route === 'GET groups') {
    if (q.get('id')) { const g = groups.find(x => x.id === q.get('id')); return g ? J(res, 200, { ok: true, result: g }) : J(res, 404, { ok: false, error: 'no group' }); }
    return J(res, 200, { ok: true, result: { groups: groups.map(g => Object.assign({}, g, { messages: undefined })) } });
  }
  if (route === 'POST groups') {
    if (B.op === 'control' && B.action === 'delete') { const i = groups.findIndex(g => g.id === B.id); if (i < 0) return J(res, 404, { ok: false, error: 'no group' }); groups.splice(i, 1); return J(res, 200, { ok: true, result: { deleted: true } }); }
    if (B.op === 'send') { const g = groups.find(x => x.id === B.id); if (!g) return J(res, 404, { ok: false, error: 'no group' }); g.messages.push({ id: 'm' + Date.now(), author: 'owner', content: B.text, at: now() }); return J(res, 200, { ok: true, result: {} }); }
    if (B.op === 'create') { const g = { id: 'g' + Date.now(), title: B.title || 'Group', members: B.members || [], updatedAt: now(), messages: [] }; groups.push(g); return J(res, 200, { ok: true, result: { id: g.id } }); }
    return J(res, 400, { ok: false, error: 'mock: op ' + B.op });
  }
  if (route === 'GET transcript') return J(res, 200, { stream: q.get('stream'), turns: [{ role: 'user', content: 'What is on today?' }, { role: 'assistant', content: 'Two quests and one handoff due at 17:00.' }] });
  if (route === 'POST run') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const words = ('Mock reply from ' + (B.agentId || 'agent') + ': I read your message and would start with the overdue handoff.').split(' ');
    res.write(JSON.stringify({ name: 'agent.run.start', payload: { agentId: B.agentId, runId: 'run-1' } }) + '\n');
    let i = 0; const t = setInterval(() => {
      if (i < words.length) { res.write(JSON.stringify({ name: 'agent.token', payload: { runId: 'run-1', delta: (i ? ' ' : '') + words[i++] } }) + '\n'); return; }
      clearInterval(t); res.write(JSON.stringify({ name: 'agent.run.end', payload: { reason: 'done', turns: 1, usd: 0.002 } }) + '\n'); res.end();
    }, 60);
    req.on('close', () => clearInterval(t)); return;
  }
  if (route === 'POST cancel') { S.live = S.live.filter(r => r.runId !== B.runId); emit('now'); return J(res, 200, { ok: true }); }
  if (route === 'POST run/steer') return J(res, 200, { ok: true });
  if (route === 'GET connectors') return J(res, 200, { connectors: [{ id: 'github', name: 'GitHub', status: 'connected', description: 'Read-only via MCP.' }, { id: 'drive', name: 'Google Drive', connected: false }] });
  if (route === 'GET skills') return J(res, 200, { skills: [{ id: 'chain-of-command', name: 'chain-of-command', enabled: true, description: 'Ask up one level.' }] });
  if (route === 'GET channels/status') return J(res, 200, { telegram: { paired: false, state: 'Not paired' }, slack: { state: 'Not connected' } });
  if (route === 'GET state/snapshot') return J(res, 200, { ts: Date.now(), runs: S.live.map(r => ({ runId: r.runId, agentId: r.agentId, startedAt: r.startedAt, source: 'cron' })), prompts: [], summons: [], queues: {} });
  if (route === 'POST consent') return J(res, 200, { ok: true, decision: B.decision });
  if (route === 'GET autonomy') return J(res, 404, { error: 'no such API route for GET /api/autonomy' });
  if (route === 'GET save') return process.env.MOCK_HEADLESS ? J(res, 200, { save: { agents: {} } }) : J(res, 200, { save: { station: {
    rooms: { r1: { id: 'r1', kind: 'hab', name: 'HOME', rects: [{ x1: 0, y1: 0, x2: 9, y2: 6 }] }, r2: { id: 'r2', kind: 'lab', name: 'WORKSHOP', rects: [{ x1: 10, y1: 0, x2: 19, y2: 6 }] } },
    props: [{ id: 'p1', t: 'desk', x: 2, y: 1, agentId: 'agent' }, { id: 'p2', t: 'desk', x: 4, y: 1, agentId: 'people1' }, { id: 'p3', t: 'desk', x: 12, y: 2, agentId: 'tools1' }, { id: 'p4', t: 'desk', x: 14, y: 2 }] } } });
  if (route === 'GET projects') return J(res, 200, { projects: [{ root: '/srv/companies/example', displayPath: '/srv/companies/example', grantedAt: Date.now() - 864e5, lastTouchedAt: Date.now() - 3600e3, isGitRepo: true, blessed: true }] });
  if (route === 'GET servicekeys') return J(res, 200, { keys: [{ name: 'Example exchange' }] });
  if (route === 'GET providers') return J(res, 200, { providers: OFFER.map(o => ({ id: o.id, label: o.name.toUpperCase(), configured: S.setup.ready.includes(o.id), unattendedReady: S.setup.ready.includes(o.id), reason: S.setup.ready.includes(o.id) ? 'unverified' : 'credential missing' })) });
  if (route === 'GET auth/claude-cli/status') return J(res, 200, Object.assign({ signingIn: !!S.setup.login }, S.setup.claude));
  if (route === 'POST auth/claude-cli/start') { S.setup.login = { id: 'login-' + Date.now(), at: Date.now() }; return J(res, 200, { status: 'pending', login_id: S.setup.login.id, url: 'https://claude.ai/oauth/authorize?mock=1' }); }
  if (route === 'POST auth/claude-cli/code') { if (!S.setup.login || B.login_id !== S.setup.login.id) return J(res, 200, { ok: false, error: 'this sign-in is no longer running' }); S.setup.login.code = true; return J(res, 200, { ok: true }); }
  if (route === 'POST auth/claude-cli/poll') {
    const L = S.setup.login; if (!L || B.login_id !== L.id) return J(res, 200, { status: 'error', error: 'this sign-in is no longer running', code: 'login_not_found' });
    if (L.code || Date.now() - L.at > 6000) { S.setup.login = null; S.setup.claude = { installed: true, loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', subscription: 'max' }; S.setup.ready.push('claude-cli'); return J(res, 200, Object.assign({ status: 'connected' }, S.setup.claude)); }
    return J(res, 200, { status: 'pending' }); }
  if (route === 'POST auth/claude-cli/cancel') { S.setup.login = null; return J(res, 200, { ok: true }); }
  J(res, 404, { ok: false, error: 'mock station: no route ' + route });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) return apiRoute(req, res, u.pathname, u.searchParams).catch(e => J(res, 500, { ok: false, error: e.message }));
  let rel = decodeURIComponent(u.pathname); if (rel === '/') rel = '/index.html';
  const f = path.resolve(UI, '.' + rel);
  if (!f.startsWith(UI + path.sep) || rel.includes('..')) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(d); });
}).listen(PORT, '127.0.0.1', () => console.log('mock console on http://127.0.0.1:' + PORT + (STATION_DOWN ? ' (station down)' : '')));
