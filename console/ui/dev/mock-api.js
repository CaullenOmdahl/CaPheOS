#!/usr/bin/env node
/* Dev-only mock of the console API (docs/CONSOLE-API.md) for working on console/ui without a company or station.
 *
 *   node console/ui/dev/mock-api.js [port]          # default 8931; serves console/ui and answers /api/* with fixtures
 *   MOCK_STATION_DOWN=1 node console/ui/dev/mock-api.js   # /api/station/* answers 502, as when the station is not running
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
const now = () => new Date().toISOString();
const ago = m => new Date(Date.now() - m * 60000).toISOString();

const S = {
  company: { ok: true, name: 'Example Co', shortName: 'example', owner: { name: 'Sam Owner' }, timezone: 'America/Chicago', station: { url: 'http://127.0.0.1:8802' }, ownerChannel: { adapter: 'file' } },
  questions: [
    { id: 'q-000101', from: 'Founder', about: 'governance:hiring', blocking: true, askedAt: ago(40), batch: 'gate',
      gate: { category: 'hiring', ref: 'round-a', by: 'People', summary: 'Hire Candidate A as Analyst' },
      q: 'Approval needed (hiring): Hire Candidate A as Analyst.\nRecommendation from People: hire Candidate A; release B and C.\nIf you do not answer: the round waits; nobody is hired.\nReply yes or no and name q-000101.' },
    { id: 'q-000102', from: 'Founder', about: 'budget', blocking: false, askedAt: ago(130), batch: null,
      q: 'A research tool trial costs nothing for 14 days, then a monthly fee. Should we try it?\nRecommendation from Founder: approve the trial, decide on the paid plan after.\nIf you do not answer: no trial.' },
  ],
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
      people1: { name: 'Mira', loop: 'People loop', cooldownMin: { value: 40, from: 'default' }, priority: { value: 50 }, wakeOnInbox: { value: true }, wakeOnOwnerMessage: { value: false } } } },
  hidden: {},
};
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
    case 'GET /api/owner/messages': return ok({ messages: S.messages });
    case 'POST /api/owner/messages': { if (!B.text) return J(res, 400, { ok: false, error: 'text is required' }); const m = { dir: 'in', id: 'in-' + Date.now(), at: now(), from: 'Sam Owner', text: (B.to ? B.to + ', ' : '') + B.text }; S.messages.push(m); emit('owner'); return ok({ message: m }); }
    case 'GET /api/crew': return ok({ seats: S.seats, station: STATION_DOWN ? 'down' : 'up' });
    case 'GET /api/handoffs': return ok({ items: S.handoffs });
    case 'GET /api/decisions': return ok({ entries: ['## 2026-11-14 Founder', '- Adopted conflicts-before-engagement.', '## 2026-11-15 People', '- Opened the analyst round.'].map(text => ({ text })) });
    case 'GET /api/dispatch': return ok({ state: { lastTick: ago(4) }, log: ['- 06:40 Dispatcher closed quest q:31 on checked evidence.', '- 04:12 woke Mira (handoff to-people.md)', '- 02:05 held 0, woke Teo (quest q:35)', '- 00:15 Pacer moved two routines off the large model'] });
    case 'GET /api/hiring': return ok({ rounds: [{ id: 'analyst-2026-11', title: 'Analyst', openedBy: 'Founder', template: 'specialist', at: ago(2000), candidates: [{ agentId: 'c1', name: 'Candidate A', provider: 'claude', model: 'example-medium', status: 'candidate', interviewedAt: ago(100) }, { agentId: 'c2', name: 'Candidate B', provider: 'minimax', model: 'example-m', status: 'candidate' }] }], templates: ['people-manager', 'tool-builder', 'risk-manager', 'finance-manager', 'floor-manager', 'specialist'] });
    case 'GET /api/usage': return ok({ mode: 'shadow', live: false, claude: { key: 'claude', label: 'Claude Max', known: true, open: true, usedPct: 31, usedToday: 9, line: 14, share: 50, why: 'under today\'s line' },
      minimax: { key: 'minimax', label: 'MiniMax', known: true, open: true, usedPct: 24, usedToday: 22, line: 28, share: 50, why: 'near the line' }, deepseek: { label: 'DeepSeek', open: true, why: 'no credit failure seen', reading: null },
      rail: { known: true, pct: 12, perDay: 25, source: 'runs.jsonl' }, emergency: { active: false }, boost: { on: false, why: 'off' }, problems: [] });
    case 'GET /api/governance': return ok(S.governance);
    case 'POST /api/governance/preset': if (!PRESETS[B.preset]) return J(res, 400, { ok: false, error: 'unknown preset' }); setPreset(B.preset); emit('governance'); return ok();
    case 'POST /api/governance/set': { const c = S.governance.categories.find(x => x.category === B.category); if (!c) return J(res, 400, { ok: false, error: 'unknown category' }); c.level = B.level; S.governance.preset = 'custom'; S.governance.presetLabel = 'Custom'; emit('governance'); return ok(); }
    case 'GET /api/guardrails': return J(res, 200, guardView());
    case 'POST /api/guardrails/set': { const g = S.guardrails.guards.find(x => x.name === B.name); if (!g || g.fixed) return J(res, 400, { ok: false, error: 'cannot change ' + B.name }); g.on = !!B.on; emit('guardrails'); return ok(); }
    case 'POST /api/guardrails/all': if (!B.on && B.confirm !== 'I understand there are no guardrails') return J(res, 400, { ok: false, error: 'confirm is required' }); S.guardrails.guards.forEach(g => { if (!g.fixed) g.on = !!B.on; }); emit('guardrails'); return ok();
    case 'POST /api/guardrails/sandbox': S.guardrails.sandbox = !!B.on; emit('guardrails'); return ok();
    case 'GET /api/onboarding': return ok({ provisioned: true, certified: false, lastCertify: now(), steps: [{ id: 'founded', what: 'company.json written and defaults copied', status: 'ok' }, { id: 'candidate-default', what: 'hiring candidates default to a model the company can run', status: 'pending', note: 'metered model with a $0 cap' }],
      checks: [{ id: 'station', what: 'station answers GET /api/cron', status: 'ok' }, { id: 'liveness', what: 'dead-man switch enabled and pinged', status: 'failed', missing: 'liveness module not enabled' }] });
    case 'POST /api/onboarding/certify': return ok({ certified: false, results: {} });
    case 'GET /api/halt': return ok(S.halt);
    case 'POST /api/halt/soft': S.halt = { mode: 'soft', by: 'Sam Owner', at: now(), why: B.why || null, deadline: new Date(Date.now() + (B.deadlineMin || 30) * 60000).toISOString(), escalate: !!B.escalate,
      shutdowns: [{ seat: 'Founder', routine: 'Founder shutdown', maxMinutes: 15, status: 'fired', done: false }, { seat: 'Mira', routine: '—', status: 'missing' }], left: ['Tools loop (running)'] }; emit('halt'); return ok(S.halt);
    case 'POST /api/halt/hard': S.halt = { mode: 'hard', by: 'Sam Owner', at: now(), why: B.why || null }; emit('halt'); return ok(S.halt);
    case 'POST /api/halt/resume': S.halt = { mode: 'running' }; emit('halt'); return ok(S.halt);
    case 'GET /api/cadence': return ok(S.cadence);
    case 'POST /api/cadence/default': S.cadence.dispatcherTickMin = Number(B.minutes); emit('cadence'); return ok();
    case 'POST /api/cadence/seat': { const s = S.cadence.seats[B.seat]; if (!s) return J(res, 400, { ok: false, error: 'no seat ' + B.seat }); if (B.cooldown != null) s.cooldownMin = { value: Number(B.cooldown) }; if (B.priority != null) s.priority = { value: Number(B.priority) }; if (B.wakeOnInbox != null) s.wakeOnInbox = { value: B.wakeOnInbox }; if (B.wakeOnOwner != null) s.wakeOnOwnerMessage = { value: B.wakeOnOwner }; emit('cadence'); return ok(); }
    case 'GET /api/panels': return ok({ panels: panelList() });
    case 'GET /api/governance-log': return ok({ entries: [{ at: ago(600), by: 'Sam Owner', event: 'preset', preset: 'gate-money-people' }] });
    case 'GET /api/locked': return ok({ text: 'locked-watch: 14 files watched, 0 drifted (mock)' });
    case 'GET /api/external': return ok({ text: 'external-gate: 1 clearance\n  message  owner channel (file adapter)  pinned (mock)' });
    case 'GET /api/today': return ok({ company: S.company, needsYou: { questions: S.questions, count: S.questions.length }, halt: S.halt });
  }
  let m;
  if (M === 'POST' && (m = /^\/api\/questions\/(q-\d+)\/answer$/.exec(p))) {
    const i = S.questions.findIndex(x => x.id === m[1]); if (i < 0) return J(res, 404, { ok: false, error: 'no open question ' + m[1] });
    if (!['yes', 'no', 'reply'].includes(B.verdict)) return J(res, 400, { ok: false, error: 'verdict must be yes, no or reply' });
    const [q] = S.questions.splice(i, 1); S.answered.push(Object.assign({}, q, { answer: B.verdict === 'reply' ? B.text : B.verdict + (B.text ? ': ' + B.text : ''), answeredAt: now() })); emit('questions'); return ok();
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
  if (route === 'POST cancel' || route === 'POST run/steer') return J(res, 200, { ok: true });
  if (route === 'GET connectors') return J(res, 200, { connectors: [{ id: 'github', name: 'GitHub', status: 'connected', description: 'Read-only via MCP.' }, { id: 'drive', name: 'Google Drive', connected: false }] });
  if (route === 'GET skills') return J(res, 200, { skills: [{ id: 'chain-of-command', name: 'chain-of-command', enabled: true, description: 'Ask up one level.' }] });
  if (route === 'GET channels/status') return J(res, 200, { telegram: { paired: false, state: 'Not paired' }, slack: { state: 'Not connected' } });
  if (route === 'GET state/snapshot') return J(res, 200, { ts: Date.now(), runs: [{ id: 'run-1' }], prompts: [], summons: [], queues: {} });
  if (route === 'GET autonomy') return J(res, 200, { posture: 'small' });
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
