#!/usr/bin/env node
/* Dev-only mock of the console API (docs/CONSOLE-API.md) for working on console/ui without a company or station.
 *
 *   node console/ui/dev/mock-api.js [port]          # default 8931; serves console/ui and answers /api/* with fixtures
 *   MOCK_STATION_DOWN=1 node console/ui/dev/mock-api.js   # /api/station/* answers 502, as when the station is not running
 *   MOCK_CERTIFIED=1 node console/ui/dev/mock-api.js      # a company that finished Setup (Today is the landing page)
 *   MOCK_PLAIN=1 node console/ui/dev/mock-api.js          # without the typed-question fixtures (one card per question kind)
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
function typedFixtures() {
  const mk = (id, mins, o) => { const form = o.form ? INBOX.normalizeForm(o.form) : INBOX.normalizeForm(INBOX.expandKind(o.kind, o.spec));
    return { id, from: o.from || 'Founder', about: o.about || 'access', blocking: false, askedAt: ago(mins), batch: null, kind: o.form ? 'form' : o.kind, form,
      message: o.message, details: o.details || '', q: o.message + (o.details ? '\n\n' + o.details : ''), askerSeat: 'agent' }; };
  const legacy = { id: 'q-000120', from: 'Founder', about: '', blocking: false, askedAt: ago(300), batch: null,
    q: 'Access gate (gate 2), no payment: a read-only Example API key, from an account you create in your own name. Why it is the binding one: the websocket rejects anonymous connections (HTTP/1.1 401 measured today), so sub-second book data is closed to us. A key buys about 1 Hz quotes.' };
  const lp = (() => { const ss = legacy.q.split(/(?<=[.!?])\s+(?=[A-Z])/); return { message: ss.slice(0, 2).join(' '), details: ss.slice(2).join(' ') }; })();
  Object.assign(legacy, lp, { messageDerived: true, kind: 'approve', form: INBOX.formOf(legacy), secretHint: INBOX.secretHint(legacy), askerSeat: 'agent' });
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
    legacy,
  ];
}

const S = {
  company: { ok: true, name: 'Example Co', shortName: 'example', owner: { name: 'Sam Owner' }, timezone: 'America/Chicago', station: { url: 'http://127.0.0.1:8802' }, ownerChannel: { adapter: 'file' } },
  questions: [
    { id: 'q-000101', from: 'Founder', about: 'governance:hiring', blocking: true, askedAt: ago(40), batch: 'gate',
      gate: { category: 'hiring', ref: 'round-a', by: 'People', summary: 'Hire Candidate A as Analyst' },
      q: 'Approval needed (hiring): Hire Candidate A as Analyst.\nRecommendation from People: hire Candidate A; release B and C.\nIf you do not answer: the round waits; nobody is hired.\nReply yes or no and name q-000101.' },
    { id: 'q-000102', from: 'Founder', about: 'budget', blocking: false, askedAt: ago(130), batch: null,
      q: 'A research tool trial costs nothing for 14 days, then a monthly fee. Should we try it?\nRecommendation from Founder: approve the trial, decide on the paid plan after.\nIf you do not answer: no trial.' },
  ].concat(CERTIFIED ? [] : [{ id: 'q-000050', from: 'onboard.js', about: 'onboarding', blocking: false, askedAt: ago(600), batch: null,
      q: 'Onboarding: what the enabled packs and modules need from you (one batch, asked once):\n- Hiring candidates default to the metered model deepseek/deepseek-flash, but the metered daily cap is $0 and the station has no subscription provider (claude-cli) ready. Either connect a subscription provider on the station, or set a metered cap in company/work/finance/dispatch-budget.json (dailyUsd).\n- provide secrets/example-key (0600) for example-module\nRecommendation: answer each line; secrets go in secrets/<name> with mode 0600, never in a message.\nIf you do not answer: those packs and modules stay uncertified.' }])
    // typed questions (company/tools/inbox.js forms): one of each kind, plus an asker-composed form; MOCK_PLAIN=1 leaves them out
    .concat(process.env.MOCK_PLAIN ? [] : typedFixtures()),
  answered: [{ id: 'q-000090', from: 'Founder', about: 'access', q: 'Approval needed (access): read access to the shared drive.', answer: 'yes', answeredAt: ago(200) }],
  messages: [
    { dir: 'out', id: 'out-1', at: ago(300), from: 'Founder', text: 'Morning report: two quests moved, one handoff is due today.' },
    { dir: 'in', id: 'in-1', at: ago(280), from: 'Sam Owner', text: 'Thanks. Approve the trial if it is under $100.', acked: true },
  ],
  seats: [
    { id: 'agent', name: 'Founder', title: 'Founder and CEO', seat: 'founder', role: 'agent.md', functions: ['ceo', 'risk', 'floor', 'finance'], loop: 'Founder loop', priority: 100, inbox: 'to-founder.md', log: 'founder-log.md', wakeOnInbox: true, manager: null, station: { agentId: 'agent', model: 'example-model-large', status: 'working' } },
    { id: 'people1', name: 'Mira', title: 'People Manager', seat: 'people', role: 'people-manager.md', functions: ['people'], loop: 'People loop', priority: 50, manager: 'agent', station: { agentId: 'people1', model: 'example-model-medium', status: 'idle' } },
    { id: 'tools1', name: 'Teo', title: 'Tool Builder', seat: 'tools', role: 'tool-builder.md', functions: ['tools'], loop: 'Tools loop', priority: 60, manager: 'agent', station: { agentId: 'tools1', status: 'blocked' } },
  ],
  handoffs: [
    { due: new Date(Date.now() + 3 * 3600e3).toISOString(), raw: 'today 17:00', file: 'company/work/handoffs/to-founder.md', line: 3, heading: '## from Teo — review dispatcher change', overdue: false },
    { due: ago(60), raw: 'today 09:00', file: 'company/work/handoffs/to-people.md', line: 9, heading: '## from Founder — shortlist for the analyst role', overdue: true },
  ],
  halt: { mode: 'running' },
  governance: null, guardrails: null,
  cadence: { dispatcherTickMin: 10, defaultCooldownMin: 40, maxPerTick: 4, file: 'company/work/ops/cadence.json', unknownSeats: [],
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
S.chats = { agent: [{ role: 'user', content: 'What is on today?', at: ago(30) }, { role: 'assistant', content: 'Two quests and **one handoff** due at 17:00. See [the handoffs](console:#/work/handoffs).', at: ago(29) }] };
S.live = STATION_DOWN ? [] : [{ runId: 'run-live-1', agentId: 'agent', name: 'Founder', startedAt: Date.now() - 4 * 60000, kind: 'routine', label: 'routine "Founder loop"', href: '#/automate', step: 'running hire.js open…', steps: 7, usd: 0.0123, stoppable: true, watched: true }];
S.charterText = CERTIFIED ? '# Example Co — Company Charter\n\n## Mandate\n\nWe run an example business.\n\n**For whom:** Example customers\n\n## What is out of scope\n\nNothing regulated.\n\n## First goal\n\nFirst sale.\n' : '# Example Co — Company Charter\n\n## Mandate\n\n<What the company exists to do, for whom, and how it makes money.>\n\n## What is out of scope\n\n<Work the company will not take on.>\n';
const PRESETS = { 'approve-everything': 'Approve everything', 'gate-money-people': 'Gate money and people', 'gate-money': 'Gate money', autonomous: 'Autonomous' };
const CATS = { hiring: 'opening a role and picking the hire', release: 'releasing or replacing a crew member', budget: 'setting or changing the metered cap', spend: 'new spend inside the approved cap',
  models: 'changing which model a seat or routine runs', tools: 'shared changes to tools, house rules and policies', schedules: 'routine clocks, dispatcher tick and per-seat cadence',
  external: 'anything that leaves the company', dashboard: 'agents adding or changing console panels' };
const LV = { 'approve-everything': {}, 'gate-money-people': { models: 'notify', tools: 'notify', schedules: 'notify', dashboard: 'notify' }, 'gate-money': { hiring: 'notify', release: 'notify', models: 'auto', tools: 'auto', schedules: 'auto', external: 'notify', dashboard: 'auto' }, autonomous: { hiring: 'auto', release: 'notify', budget: 'auto', spend: 'auto', models: 'auto', tools: 'auto', schedules: 'auto', external: 'auto', dashboard: 'auto' } };
function setPreset(p) { S.governance = { preset: p, presetLabel: PRESETS[p] || 'Custom', categories: Object.keys(CATS).map(c => ({ category: c, level: (LV[p] || {})[c] || 'approve', what: CATS[c] })),
  fixed: ['access', 'ownership', 'commitment', 'spendBeyondCap'].map(c => ({ category: c, level: 'approve' })), ownerGatesGuardrail: 'on', presets: Object.entries(PRESETS).map(([id, label]) => ({ id, label })) }; }
setPreset('gate-money-people');
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
const OFFER = [
  { id: 'claude-cli', name: 'Claude subscription', how: 'signin', unmetered: true, blurb: 'Your Claude Pro or Max plan, through Claude Code on this machine. Flat fee: nothing is billed per token.' },
  { id: 'custom', name: 'MiniMax Coding Plan', how: 'key', unmetered: true, keyUrl: 'https://platform.minimax.io/', blurb: 'A MiniMax plan key. Flat fee, paced against the plan.' },
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
  add('provider', 'AI provider', ready.includes(cd.provider) ? 'done' : 'needs', !up ? 'The station is not answering (connect ECONNREFUSED), so no AI provider can be checked or connected. Start it, then come back.' : ready.includes(cd.provider) ? 'New hires interview on ' + cd.provider + ' (' + cd.model + '), which the station has ready.' : 'Your crew needs an AI to think with. The station has no AI provider connected yet.');
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
    providers: OFFER.map(o => Object.assign({}, o, { ready: ready.includes(o.id), present: ready.includes(o.id), isDefault: cd.provider === o.id, metered: !b.unmeteredProviders.includes(o.id) })),
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
    if (!pushed) { pushed = true; setTimeout(newQuestion, 8000); }
    return;
  }
  if (p.startsWith('/api/station/')) return station(req, res, p.slice('/api/station/'.length), q, B);
  switch (M + ' ' + p) {
    case 'GET /api/company': return J(res, 200, S.company);
    case 'GET /api/questions': return ok({ questions: S.questions });
    case 'GET /api/questions/answered': return ok({ answered: S.answered });
    case 'GET /api/owner/messages': return ok(ownerView());
    case 'POST /api/owner/messages': { if (!B.text) return J(res, 400, { ok: false, error: 'text is required' }); const m = { dir: 'in', id: 'in-' + Date.now(), at: now(), from: 'Sam Owner', text: (B.to ? B.to + ', ' : '') + B.text }; S.messages.push(m); emit('owner'); return ok({ message: ownerView().messages.find(x => x.id === m.id) }); }
    case 'GET /api/now': return ok({ station: { up: !STATION_DOWN, feed: !STATION_DOWN }, runs: S.live.map(r => Object.assign({}, r, { elapsedSec: Math.round((Date.now() - r.startedAt) / 1000) })),
      seats: S.seats.map(x => ({ id: x.id, name: x.name, title: x.title, running: S.live.filter(r => r.agentId === x.id).length, loop: x.loop || null, enabled: true, nextRunAt: new Date(Date.now() + 50 * 60000).toISOString(), soonerBecause: x.id === 'agent' ? ['1 open handoff'] : [], wakesOnMessage: x.id === 'agent', schedulerOn: true })) });
    case 'GET /api/activity': return ok({ items: [
      { at: ago(12), kind: 'run', who: 'Founder', title: 'Founder ran "Founder loop"', outcome: 'succeeded', usd: 0.0047, text: 'Wrote the first plan to company/work/plan.md and opened a People Manager round.', links: [{ label: 'Quests', href: '#/work/quests' }, { label: 'Hiring', href: '#/hiring' }] },
      { at: ago(40), kind: 'hiring', who: 'Hiring', title: 'Hired: Mira (people1) as People Manager by Founder', text: 'Crew decides: done without asking you (hiring is set to "auto"; change it in Controls)', links: [{ label: 'Crew', href: '#/crew/people1' }, { label: 'Hiring level', href: '#/controls/gov' }] },
      { at: ago(300), kind: 'message', who: 'Founder', title: 'Founder wrote to you', text: 'Morning report: two quests moved.', links: [{ label: 'Open', href: '#/comms/owner' }] }] });
    case 'GET /api/setup/charter': { const ph = (S.charterText.match(/<[A-Za-z][^<>\n]{0,200}>/g) || []); return ok({ text: S.charterText, at: ago(60), placeholders: ph, fields: {} }); }
    case 'GET /api/crew': return ok({ seats: S.seats, station: STATION_DOWN ? 'down' : 'up' });
    case 'GET /api/handoffs': return ok({ items: S.handoffs });
    case 'GET /api/decisions': return ok({ entries: ['## 2026-11-14 Founder', '- Adopted conflicts-before-engagement.', '## 2026-11-15 People', '- Opened the analyst round.'].map(text => ({ text })) });
    case 'GET /api/dispatch': return ok({ state: { lastTick: ago(4) }, log: ['- 06:40 Dispatcher closed quest q:31 on checked evidence.', '- 04:12 woke Mira (handoff to-people.md)', '- 02:05 held 0, woke Teo (quest q:35)', '- 00:15 Pacer moved two routines off the large model'] });
    case 'GET /api/hiring': return ok({ rounds: [{ id: 'analyst-2026-11', title: 'Analyst', openedBy: 'Founder', template: 'specialist', at: ago(2000), candidates: [{ agentId: 'c1', name: 'Candidate A', provider: 'claude', model: 'example-medium', status: 'candidate', interviewedAt: ago(100) }, { agentId: 'c2', name: 'Candidate B', provider: 'minimax', model: 'example-m', status: 'candidate' }] }], templates: ['people-manager', 'tool-builder', 'risk-manager', 'finance-manager', 'floor-manager', 'specialist'] });
    case 'GET /api/usage': return ok({ mode: 'shadow', live: false, claude: { key: 'claude', label: 'Claude Max', known: true, open: true, usedPct: 31, usedToday: 9, line: 14, share: 50, why: 'under today\'s line' },
      minimax: { key: 'minimax', label: 'MiniMax', known: true, open: true, usedPct: 24, usedToday: 22, line: 28, share: 50, why: 'near the line' }, deepseek: { label: 'DeepSeek', open: true, why: 'no credit failure seen', reading: null },
      rail: { known: true, pct: 12, perDay: 25, source: 'runs.jsonl' }, emergency: { active: false }, boost: { on: false, why: 'off' }, problems: [] });
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
    case 'POST /api/setup/provider/validate': return ok({ provider: B.provider, valid: /^sk-good/.test(B.key || ''), reachable: true, error: /^sk-good/.test(B.key || '') ? null : 'HTTP 401: invalid key (mock: keys starting sk-good pass)', modelCount: 12 });
    case 'POST /api/setup/provider': {
      const U = S.setup;
      if (STATION_DOWN) return J(res, 502, { ok: false, error: 'station unreachable: connect ECONNREFUSED' });
      if (B.provider === 'claude-cli') { if (!U.claude.loggedIn) return J(res, 400, { ok: false, error: 'Claude is not signed in on the station yet: finish the sign-in first' }); }
      else if (!U.ready.includes(B.provider) && !/^sk-good/.test(B.key || '')) return J(res, 400, { ok: false, error: 'the provider did not accept that key: HTTP 401 (mock: keys starting sk-good pass)' });
      if (!U.ready.includes(B.provider)) U.ready.push(B.provider);
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
    case 'POST /api/cadence/default': if (B.minutes != null) S.cadence.dispatcherTickMin = Number(B.minutes); if (B.cooldown != null) S.cadence.defaultCooldownMin = Number(B.cooldown); if (B.maxPerTick != null) S.cadence.maxPerTick = Number(B.maxPerTick); emit('cadence'); return ok();
    case 'POST /api/cadence/bounds': { const b = S.cadence.bounds, t = S.cadence.tempo; for (const k of ['tickMin', 'cooldownMin', 'maxWakesPerHour', 'maxWakesPerDay', 'quietHours']) if (B[k] !== undefined) b[k] = B[k]; for (const k of ['mode', 'autoExpireMin', 'minChangeIntervalMin']) if (B[k] !== undefined) t[k] = B[k]; emit('cadence'); return ok(); }
    case 'POST /api/cadence/end-temporary': S.cadence.temporary = null; S.cadence.effective = Object.assign({}, S.cadence.effective, { tickMin: S.cadence.dispatcherTickMin, source: 'base' }); emit('cadence'); return ok();
    case 'POST /api/cadence/seat': { const s = S.cadence.seats[B.seat]; if (!s) return J(res, 400, { ok: false, error: 'no seat ' + B.seat }); if (B.cooldown != null) s.cooldownMin = { value: Number(B.cooldown) }; if (B.priority != null) s.priority = { value: Number(B.priority) }; if (B.wakeOnInbox != null) s.wakeOnInbox = { value: B.wakeOnInbox }; if (B.wakeOnOwner != null) s.wakeOnOwnerMessage = { value: B.wakeOnOwner }; emit('cadence'); return ok(); }
    case 'GET /api/panels': return ok({ panels: panelList() });
    case 'GET /api/governance-log': return ok({ entries: [{ at: ago(600), by: 'Sam Owner', event: 'preset', preset: 'gate-money-people' }] });
    case 'GET /api/locked': return ok({ text: 'locked-watch: 14 files watched, 0 drifted (mock)' });
    case 'GET /api/external': return ok({ text: 'external-gate: 1 clearance\n  message  owner channel (file adapter)  pinned (mock)' });
    case 'GET /api/today': return ok({ company: S.company, needsYou: { questions: S.questions, count: S.questions.length }, halt: S.halt });
  }
  let m;
  if (M === 'GET' && (m = /^\/api\/chat\/([A-Za-z0-9_-]+)$/.exec(p))) {
    const seat = S.seats.find(x => x.id === m[1]); if (!seat) return J(res, 404, { ok: false, error: 'no crew member ' + m[1] });
    return ok({ agent: { id: seat.id, name: seat.name, title: seat.title }, model: 'example-model-large', provider: 'claude-cli', modelFrom: 'its loop routine "Founder loop"', streamId: 'console-' + seat.id, turns: S.chats[seat.id] || [],
      problems: STATION_DOWN ? [{ code: 'station-down', message: 'The station is not answering, so ' + seat.name + ' cannot answer.', fix: 'Start it on the station machine.', link: '#/system' }] : [] });
  }
  if (M === 'POST' && (m = /^\/api\/chat\/([A-Za-z0-9_-]+)\/send$/.exec(p))) return chatSend(req, res, m[1], B);
  if (M === 'GET' && (m = /^\/api\/now\/run\/([A-Za-z0-9_-]+)$/.exec(p))) {
    const after = Number(q.get('after')) || 0;
    const evs = [{ seq: 1, name: 'tool', tool: 'fs_read', text: 'reading company/CHARTER.md', callId: 'c1' }, { seq: 2, name: 'result', callId: 'c1', ok: true }, { seq: 3, name: 'tool', tool: 'code.run', text: 'running hire.js open…', callId: 'c2' }, { seq: 4, name: 'token', delta: 'Opening a **People Manager** round now.' }];
    return ok({ known: true, runId: m[1], agentId: 'agent', name: 'Founder', events: evs.filter(e => e.seq > after), seq: 4, done: false });
  }
  if (M === 'POST' && (m = /^\/api\/questions\/(q-\d+)\/answer$/.exec(p))) {
    const i = S.questions.findIndex(x => x.id === m[1]); if (i < 0) return J(res, 404, { ok: false, error: 'no open question ' + m[1] });
    const q0 = S.questions[i];
    let ans;
    if (!B.action) {
      if (!['yes', 'no', 'reply'].includes(B.verdict)) return J(res, 400, { ok: false, error: 'verdict must be yes, no or reply' });
      ans = { a: B.verdict === 'reply' ? B.text : B.verdict + (B.text ? ': ' + B.text : '') };
    } else {
      // as the real server: a secret value is replaced by where it would be stored before anything else sees it; never kept
      const form = q0.form || INBOX.formOf(q0); const values = Object.assign({}, B.values || {}); const stored = [];
      for (const f of form.fields.filter(x => x.type === 'secret')) {
        const v = values[f.id]; if (v === undefined) continue;
        const name = f.hinted && B.secretNames && B.secretNames[f.id] ? B.secretNames[f.id] : f.name;
        if (name === 'existing-key' && !(B.replace && B.replace[f.id])) return J(res, 409, { ok: false, error: 'secrets/' + name + ' already exists. Tick "replace the stored key" to overwrite it.' });
        values[f.id] = { stored: 'secrets/' + name, chars: String(v).trim().length, validated: null }; stored.push(values[f.id]); S.mockStored = (S.mockStored || 0) + 1;
      }
      try { const row = Object.assign({}, q0, { form }); const st = INBOX.checkAnswer(row, { action: B.action, values, note: B.note }); ans = { a: INBOX.plainAnswer(row, st), answerDetail: st, stored }; }
      catch (e) { return J(res, 400, { ok: false, error: e.message }); }
    }
    S.questions.splice(i, 1); S.answered.push(Object.assign({}, q0, { answer: ans.a, answeredAt: now() })); emit('questions'); return ok({ a: ans.a, stored: ans.stored || [] });
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
  const ch = { ok: !stuck, problems: stuck ? [{ code: 'station-down', msg: 'the station does not answer', fix: 'Start it on the station machine.', link: '#/system' }] : [], ceo: { id: 'agent', name: 'Founder' }, nextCheckMin: 7, working: false };
  const msgs = S.messages.map(m => m.dir !== 'in' ? m : Object.assign({}, m, { state: m.acked ? { status: 'read', text: 'read by Founder: approved the trial' }
    : stuck ? { status: 'stuck', text: 'nobody will pick this up: the station does not answer', fix: 'Start it on the station machine.', link: '#/system' } : { status: 'waiting', text: 'waiting for the Founder — next check within 7 min', nextCheckMin: 7 } }));
  return { messages: msgs, channel: ch };
}
// the live chat, streamed like console/chat.js: console.user, console.run, the run events, a tool step, then the end
function chatSend(req, res, id, B) {
  const seat = S.seats.find(x => x.id === id); if (!seat) return J(res, 404, { ok: false, error: 'no crew member ' + id });
  const text = B.brief === 'charter' ? 'Let us write the company charter together, here in this chat. First ask me a few short questions…' : String(B.text || '').trim();
  if (!text) return J(res, 400, { ok: false, error: 'text is required' });
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const out = [{ name: 'console.user', payload: { text, brief: B.brief || null } }];
  if (STATION_DOWN) { out.push({ name: 'console.error', payload: { code: 'station-down', message: 'The station is not answering, so ' + seat.name + ' cannot answer.', fix: 'Start it on the station machine.', link: '#/system' } }); for (const e of out) res.write(JSON.stringify(e) + '\n'); return res.end(); }
  const reply = B.brief === 'charter' ? 'Happy to. Three quick questions:\n\n1. What does the company do?\n2. For whom?\n3. What will it never do?\n\nWhen I have your answers I will write `company/CHARTER.md`. [Review it in Setup](console:#/setup/charter)'
    : /fail/i.test(text) ? null : 'Mock reply from ' + seat.name + ': I read your message and would start with **the overdue handoff**. See [Work](console:#/work/handoffs) and [the docs](https://example.org/docs). [bad](javascript:alert(1))';
  out.push({ name: 'console.run', payload: { agentId: id, name: seat.name, model: 'example-model-large', provider: 'claude-cli' } }, { name: 'agent.run.start', payload: { runId: 'chat-' + Date.now(), agentId: id } });
  const runId = out[out.length - 1].payload.runId;
  out.push({ name: 'agent.tool_call', payload: { runId, callId: 't1', name: 'fs_read', argsSummary: 'company/CHARTER.md' } }, { name: 'agent.tool_result', payload: { runId, callId: 't1', ok: true, summary: '40 lines' } });
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
    { id: 'q:34', title: 'Q1 plan from the charter', agentId: 'agent', status: 'open', steps: [{ key: 'a', label: 'Draft', done: true }, { key: 'b', label: 'Pricing model', done: false }] },
    { id: 'q:35', title: 'Matter intake tool', agentId: 'tools1', status: 'open', disposition: 'blocked', steps: [{ key: 'a', label: 'Spec', done: true }, { key: 'b', label: 'Access', done: false }] },
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
  if (route === 'GET autonomy') return J(res, 200, { posture: 'small' });
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
