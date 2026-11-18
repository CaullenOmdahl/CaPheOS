#!/usr/bin/env node
/* owner-experience.test.js — regression tests for the owner-experience review (2026-11-18): what a non-technical owner
 * reads and is asked. Each case runs the real tools in a throwaway company (child processes, so each has its own
 * CAPHEOS_ROOT); nothing reaches a station, systemd or a network port.
 *
 *   B1  background jobs have no network unless they ask; a website goes through the `external` level (an allowlisted
 *       one at external=auto is not asked); the owner is never told a job reaches "only" some websites; crew guidance
 *       says how to declare them
 *   B2  "Make this a standing rule" works on a background-job card, is not offered where it cannot work (the money
 *       hold, a guardrail's card), and never shows an internal identifier
 *   B3  the notice plain check uses the card's patterns; every real sender template reads plainly; nothing is
 *       swallowed and Today never shows "noted something technical"
 *   B4  every instruction to the owner has a console control (undo, practice mode, add-on install, protected-file
 *       accept, add-on switch-on, model trials)
 *   B5  an FYI never lands in Needs you, and the daily message never contradicts Today
 *   and the jargon list and M-items (M1 makers-only changes, M2 "API" alone, M3 names).
 *
 *   node --test company/tools/tests/owner-experience.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exp-scripts-'));
const roots = [SCRIPTS];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const W = (root, rel, v) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); return f; };
const STATION_ENV = ['STARNET_USER_CONTROL_MODE', 'STARNET_COMPUTER_DRIVER', 'STARNET_MCP_STDIO', 'STARNET_AGENT_ID', 'OWNER_DIR', 'PM_INBOX_FILE', 'GOVERNANCE_ROOT', 'CONSOLE_PORT', 'CAPHEOS_NOTICE_STRICT'];
function envFor(T, extra) { const e = Object.assign({}, process.env, { REPO, T, CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }, extra || {}); for (const k of STATION_ENV) if (!(extra && k in extra)) delete e[k]; return e; }
let nScript = 0;
/* run(T, code) -> the JSON the script printed last */
function run(T, code, o) {
  const f = path.join(SCRIPTS, 's' + (++nScript) + '.js');
  fs.writeFileSync(f, "'use strict';\nconst fs = require('fs'), path = require('path');\nconst REPO = process.env.REPO, T = process.env.T;\nconst out = o => console.log(JSON.stringify(o));\n" +
    "try { require(path.join(REPO, 'company/tools/provenance.js')).pinUnderStation(false); } catch (_) {}\n" + code);
  const r = spawnSync(process.execPath, [f], { env: envFor(T, o && o.env), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'script failed: ' + r.stderr + r.stdout);
  const last = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(last); } catch (_) { throw new Error('no JSON from the script: ' + r.stdout + r.stderr); }
}
function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exp-')); roots.push(T);
  W(T, 'company/company.json', { name: 'OC', slug: 'oc', owner: { name: 'Pat Owner' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  W(T, 'company/tools/loops.json', { agents: o.agents || {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' },
    auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    people: { name: 'nadia farrell', manager: 'agent', functions: ['people'], inbox: 'to-nadia.md' },
    sam: { name: 'Sam Lee', manager: 'agent', inbox: 'to-sam.md' } } });
  fs.mkdirSync(path.join(T, 'company', 'work', 'handoffs'), { recursive: true });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8'));
  Object.assign(g.categories, o.levels || {});
  W(T, 'company/defaults/state/governance.json', g); W(T, 'company/state/governance.json', g);
  W(T, 'company/defaults/state/guardrails.json', fs.readFileSync(path.join(REPO, 'company/defaults/state/guardrails.json'), 'utf8'));
  if (o.allowlist) W(T, 'company/state/external-allowlist.txt', o.allowlist.join('\n') + '\n');
  return T;
}
// a fake service manager for service.js (every call kept)
const SVC_CTX = `
const S = require(path.join(REPO, 'company/tools/service.js'));
const calls = [];
const svcOpts = x => Object.assign({ root: T, unitDir: path.join(T, 'units'), transientDir: path.join(T, 'transient'), systemctl: a => { calls.push(a.join(' ')); return { code: 0, out: '', err: '' }; },
  journal: () => '', isAgent: () => true, ownerShell: () => false, guard: () => true, halted: () => false, callerConflict: () => null }, x || {});
const tryIt = fn => { try { return { ok: true, r: fn() }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const G = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js'));
const INBOX = path.join(T, 'company/pm-inbox.jsonl');
const asks = () => G.rows({ file: INBOX, noAlert: true }).filter(x => x.type === 'ask');
const unitText = n => { try { return fs.readFileSync(path.join(T, 'units', 'oc-svc-' + n + '.service'), 'utf8'); } catch (_) { return null; } };
`;

/* ---------------- B1: background jobs ---------------- */
test('B1: a job proposed with no network flags has no network and installs at schedules=auto, with no owner card', () => {
  const T = company({ levels: { schedules: 'auto' } });
  W(T, 'company/work/backup.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
const a = tryIt(() => S.propose(S.context(svcOpts()), 'state-backup', { by: 'sam', kind: 'timer', exec: 'python3 company/work/backup.py', every: '1d', why: 'backs up the company state once a day' }));
out({ a, asks: asks().length, unit: unitText('state-backup') });`);
  assert.equal(r.a.ok, true, JSON.stringify(r.a));
  assert.equal(r.a.r.status, 'installed', 'the crew installs it: ' + JSON.stringify(r.a));
  assert.equal(r.asks, 0, 'no owner card');
  assert.match(r.unit || '', /RestrictAddressFamilies=AF_UNIX/, 'the unit has no network');
});

test('B1: a website on the allowlist at external=auto is not asked; a new one follows the external level', () => {
  const T = company({ levels: { schedules: 'auto', external: 'auto' }, allowlist: ['api.kalshi.com'] });
  W(T, 'company/work/feed.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
const p = (n, hosts) => tryIt(() => S.propose(S.context(svcOpts()), n, { by: 'sam', kind: 'timer', exec: 'python3 company/work/feed.py', every: '1h', why: 'pulls prices for the desk every hour', hosts }));
const known = p('bank-freshness', 'api.kalshi.com');
const fresh = p('seal-nowcast', 'hermes.pyth.network');
const g = JSON.parse(fs.readFileSync(path.join(T, 'company/state/governance.json'), 'utf8')); g.categories.external = 'approve';
fs.writeFileSync(path.join(T, 'company/state/governance.json'), JSON.stringify(g));
const ask = p('eia-slot', 'api.eia.gov');
const card = asks().pop() || null;
out({ known, fresh, ask, card: card && { category: card.gate.category, guardrail: !!card.gate.guardrail, message: card.message, recommendation: card.recommendation, technical: card.technical } });`);
  assert.equal(r.known.r.status, 'installed', 'an allowlisted website at external=auto: installed: ' + JSON.stringify(r.known));
  assert.equal(r.fresh.r.status, 'installed', 'a new website at external=auto: the crew decides: ' + JSON.stringify(r.fresh));
  assert.equal(r.ask.r.waiting, true, 'a new website at external=approve waits for the owner');
  assert.ok(r.card, 'one card');
  assert.equal(r.card.category, 'external'); assert.equal(r.card.guardrail, false, 'not a guardrail card: a standing rule can cover it');
  assert.match(r.card.message, /It connects to the Eia website, which the crew has not used before\./);
  assert.doesNotMatch(r.card.message + r.card.recommendation, /\bonly\b|any website/, 'never claims the job reaches only some websites');
  assert.doesNotMatch(r.card.recommendation, /keeps their work running smoothly/, 'no canned reason');
  assert.match(r.card.technical, /declared, not enforced/);
});

test('B1: crew guidance tells agents how to declare the websites a job needs', () => {
  const h = fs.readFileSync(path.join(REPO, 'company/HANDOFFS.md'), 'utf8');
  assert.match(h, /--hosts/, 'HANDOFFS.md names --hosts');
  assert.match(h, /--plain/, 'and the owner\'s own words');
  const s = require(path.join(REPO, 'company/tools/service.js'));
  const r = s.checkCommand({ isAgent: () => true, guard: () => true, root: os.tmpdir(), P: (...p) => path.join(os.tmpdir(), ...p), log: path.join(SCRIPTS, 'svc-log.jsonl'), now: () => Date.now() }, 'systemctl', ['--user', 'enable', 'x.service']);
  assert.match(r.why, /--hosts/, 'the shim\'s refusal names --hosts');
});

/* ---------------- B2: standing rules ---------------- */
// a full copy of the framework (company/ and console/), for the console's own modules
function fixture(o) {
  o = o || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exp-fx-')); roots.push(root);
  fs.cpSync(path.join(REPO, 'company'), path.join(root, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'console'), path.join(root, 'console'), { recursive: true });
  if (o.modules) fs.cpSync(path.join(REPO, 'modules'), path.join(root, 'modules'), { recursive: true });
  W(root, 'secrets/station-token', 'fake-token\n');
  for (const f of ['company/state/locked/provenance.jsonl', 'company/pm-inbox.jsonl', 'company/state/governance.json', 'company/state/owner-rulings.json', 'company/owner/digest.jsonl']) try { fs.rmSync(path.join(root, f)); } catch (_) {}
  W(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  W(root, 'company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' }, data: { name: 'Halima', manager: 'boss', inbox: 'to-halima.md' } } });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8')); Object.assign(g.categories, o.levels || {});
  W(root, 'company/state/governance.json', g);
  return root;
}
const NEEDS_CTX = `
const co = require(path.join(T, 'company/tools/lib/company.js'));
const NEEDS = require(path.join(T, 'console/owner-needs.js')).make({ co });
const card = (about, gate, x) => Object.assign({ type: 'ask', id: 'q-' + Math.random().toString().slice(2, 8), from: 'Halima', about, message: 'Halima wants a background job to run every hour on this computer. It keeps to company files and cannot reach the internet.', gate }, x || {});
`;
test('B2: a standing rule is offered on a background-job card and covers the next one; never where it cannot work, and never with an internal name', () => {
  const T = fixture({ levels: { schedules: 'approve' } });
  const r = run(T, NEEDS_CTX + `
const job = card('card:service:feed:k1', { ref: 'service:feed:k1', category: 'schedules', governanceCategory: 'schedules' });
const guard = card('card:service:depth:k2', { ref: 'service:depth:k2', category: 'localComputer', governanceCategory: 'localComputer', guardrail: true });
const money = card('money-hold:cap', null, { message: 'Halima is paused: the company has spent today\\'s budget.', blocking: true });
const o = { job: NEEDS.ruleOffer(job, job, []), guard: NEEDS.ruleOffer(guard, guard, []), money: NEEDS.ruleOffer(money, money, []) };
let refused = null; try { NEEDS.addRuling({ text: 'You decide these.', scope: { categories: ['localComputer'] } }, (m, c) => { throw new Error(m); }); } catch (e) { refused = e.message; }
out({ o, refused });`);
  assert.equal(r.o.job.ok, true, 'offered on a background-job card: ' + JSON.stringify(r.o.job));
  assert.deepEqual(r.o.job.scope, { categories: ['schedules'] });
  assert.equal(r.o.guard.ok, false, 'not offered on a guardrail card'); assert.equal(r.o.money.ok, false, 'not offered on the money hold');
  for (const w of [r.o.guard.why, r.o.money.why, r.refused]) {
    assert.ok(w, 'a reason in words');
    assert.doesNotMatch(w, /localComputer|money-hold|schedules\b|[a-z]+[A-Z][a-z]+/, 'no internal identifier: ' + w);
  }
  // the rule a yes-with-rule saves covers the next background job: service.js installs it without a card
  W(T, 'company/work/feed.py', 'print(1)\n');
  const s = run(T, SVC_CTX.replace(/path\.join\(REPO, 'company\/tools\//g, "path.join(T, 'company/tools/") + `
const R = require(path.join(T, 'company/tools/lib/owner-rulings.js'));
const saved = R.add({ by: 'owner', text: 'You decide background jobs yourselves.', effect: 'crew-decides', scope: { categories: ['schedules'] } }, { root: T, shell: () => true });
const a = tryIt(() => S.propose(S.context(svcOpts()), 'nightly', { by: 'data', kind: 'timer', exec: 'python3 company/work/feed.py', every: '1d', why: 'pulls the day\\'s numbers once a day' }));
out({ saved: saved.ok, a, asks: asks().length });`);
  assert.equal(s.saved, true);
  assert.equal(s.a.ok && s.a.r.status, 'installed', 'the rule covers it: ' + JSON.stringify(s.a)); assert.equal(s.asks, 0);
});

/* ---------------- B3: notices ---------------- */
test('B3: the notice plain check uses the card check\'s patterns (clock specs, model ids, setting names, flags)', () => {
  const T = company();
  const r = run(T, `
const N = require(path.join(REPO, 'company/tools/lib/owner-notice.js'));
const ins = ['Cadence changed by Nadia: routine "seal-nowcast": */15 * * * * -> */30 * * * *.', 'Sam switched the coding seat to claude-sonnet-4-5 for a week.', 'Sharon set fiveHourCloseBelowLeftPct to 35 for the evening.', 'Run it again with --force to finish.'];
out(ins.map(t => N.plain(t)));`);
  for (const p of r) {
    assert.ok(p.technical.length > 0, 'something moved to technical: ' + JSON.stringify(p));
    assert.doesNotMatch(p.text, /\*\/\d|claude-sonnet|fiveHour|--force/, 'nothing technical left in the words: ' + p.text);
  }
});

// every real sender template, with the review's real inputs: plain as it stands (nothing to cut, nothing technical)
const TEMPLATES = `
const tools = p => require(path.join(REPO, 'company/tools', p));
const lines = {};
const cad = tools('cadence.js');
lines.cadence = cad.cadenceNotice('Nadia', ['routine "seal-nowcast": */15 * * * * -> */30 * * * *', 'dispatcher tick 4 -> 6 min']).text;
lines.sprintEnd = cad.endNotice({ ended: { reason: 'budget', at: Date.now() }, spent: { usd: 1.1 }, budgetUsd: 1, since: new Date().toISOString() }, { bounds: { maxWakesPerHour: 100 }, dispatcherTickMin: 12, defaultCooldownMin: 40 }, null).text;
const gr = tools('guardrails.js');
lines.guardrails = gr.changedNotice('Caullen', [{ name: 'localComputer', from: 'on', to: 'off' }], ['localComputer', 'harnessSelfEdit'], false).text;
lines.guardrailsApplied = gr.appliedNotice([{ what: 'computer control', ok: true }, { what: 'sudo gate', ok: false, error: 'ECONNREFUSED' }]).text;
lines.pacer = tools('pacer.js').limitNotice('Sharon', 'MiniMax', 'fiveHourCloseBelowLeftPct 0 -> 35', 'keep a margin for the evening').text;
lines.pacerOddWhy = tools('pacer.js').limitNotice('Sharon', 'MiniMax', 'x', 'set /minimax/fiveHourCloseBelowLeftPct per hc-0008').text;
lines.balance = tools('lib/provider-balance.js').lowNotice('DeepSeek', false);
lines.balanceOut = tools('lib/provider-balance.js').lowNotice('DeepSeek', true);
lines.fallback = tools('models.js').fallbackNotice('Halima');
lines.watchdog = tools('watchdog.js').silentNotice({ silentMin: 45 });
lines.watchdogNever = tools('watchdog.js').silentNotice({ never: true });
const lv = require(path.join(REPO, 'modules/liveness/watch.js'));
lines.livenessDown = lv.downNotice('dispatcher', 61); lines.livenessWatcher = lv.downNotice('watcher', null); lines.livenessUp = lv.upNotice('dispatcher');
const hc = tools('harness-change.js'); const hctx = { paths: { dir: path.join(T, 'nowhere') } };
lines.harnessApplied = hc.ownerNewsLine(hctx, 'hc-0008 applied (tool: company/tools/pacer.js)');
lines.harnessRejected = hc.ownerNewsLine(hctx, 'hc-0008 rejected by Kwame Asante');
lines.harnessResults = hc.ownerNewsLine(hctx, 'results check hc-0008 (tool: company/tools/pacer.js): looks better');
lines.panel = tools('console-panel.js').panelNotice('Alex', false, false, { title: 'Trading positions' });
lines.external = tools('external-gate.js').plainClearedLine('Alex', { agent: 'sam', category: 'spend' });
lines.decided = tools('lib/governance.js').plainDecided('Sharon', 'budget', 'apply hc-0008, a policy change to company/work/finance/pacing-policy.json (/minimax/fiveHourCloseBelowLeftPct: 0 -> 35)');
const S = tools('service.js'); const ctx = S.context({ root: T });
fs.mkdirSync(path.join(T, 'company/work'), { recursive: true }); fs.writeFileSync(path.join(T, 'company/work/feed.py'), 'print(1)\\n');
const e = S.specOf(ctx, 'feed', { kind: 'timer', every: '1h', exec: 'python3 company/work/feed.py', why: 'pulls prices every hour', hosts: 'api.kalshi.com' }, { resolve: false });
lines.serviceDone = S.plainDone(ctx, e, { name: 'Halima' });
lines.delegation = tools('delegation.js').answeredNotice('Pat', 'hiring', '2026-11-20T00:00:00Z').text;
lines.demoted = tools('lib/decision.js').demoteNotice('gate-triage', '2', '3 bad outcomes in 14 days over the limit of 2', { root: T }).text;
`;
test('B3: every real sender template reads plainly, with the review\'s real inputs', () => {
  const T = company();
  const r = run(T, TEMPLATES + `
const N = require(path.join(REPO, 'company/tools/lib/owner-notice.js'));
const scope = require(path.join(REPO, 'company/tools/lib/owner-scope.js'));
out(Object.fromEntries(Object.entries(lines).map(([k, t]) => [k, { t, plain: N.plain(t), words: scope.wordsProblems(t) }])));`);
  for (const [k, v] of Object.entries(r)) {
    assert.deepEqual(v.words, [], k + ': ' + v.t);
    assert.deepEqual(v.plain.technical, [], k + ' loses nothing to the plain check: ' + v.t);
    assert.equal(v.plain.text, v.t.replace(/[ \t]+/g, ' ').trim(), k);
  }
});

test('B3: nothing is swallowed: a technical-only notice fails a test (strict), is kept for the crew and recorded, and Today never shows filler', () => {
  const T = fixture();
  const strict = run(T, `
const N = require(path.join(T, 'company/tools/lib/owner-notice.js'));
let thrown = null; try { N.send({ kind: 'fyi', from: 'Dave', text: 'hc-0042 applied: company/tools/pacer.js sha256:ab12cd34ef' }, { root: T }); } catch (e) { thrown = e.code; }
out({ thrown });`, { env: { CAPHEOS_NOTICE_STRICT: '1' } });
  assert.equal(strict.thrown, 'NOT_PLAIN', 'a test sees the template that needs rewording');
  const r = run(T, NEEDS_CTX + `
const N = require(path.join(T, 'company/tools/lib/owner-notice.js'));
const a = N.send({ kind: 'fyi', from: 'Dave', text: 'hc-0042 applied: company/tools/pacer.js sha256:ab12cd34ef' }, { root: T });
N.send({ kind: 'fyi', from: 'Pat', text: 'Pat answered a hiring question for you.' }, { root: T });
const lint = fs.readFileSync(path.join(T, 'company/state/owner-notice-lint.jsonl'), 'utf8');
out({ row: a.row, items: NEEDS.digest().items, lint, day: N.digest({ root: T, force: true, dry: true }) });`);
  assert.equal(r.row.crewOnly, true);
  assert.doesNotMatch(JSON.stringify(r.items), /noted something technical|hc-0042/, 'Today shows no filler: ' + JSON.stringify(r.items));
  assert.equal(r.items.length, 1); assert.match(r.items[0].text, /^Pat answered/);
  assert.match(r.lint, /hc-0042/, 'the crew is told which template to fix');
  assert.doesNotMatch(r.day.text, /noted something technical/);
});

/* ---------------- B4: every instruction has a console control ---------------- */
// the real console server on a fixture company, with a fake station on loopback
async function consoleOn(root, fn) {
  const fake = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fake"}'); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: root, STARNET_URL: 'http://127.0.0.1:' + fake.address().port, CAPHEOS_TZ: 'UTC' });
  for (const k of STATION_ENV.concat(['CAPHEOS_READONLY'])) delete env[k];
  const child = spawn(process.execPath, [path.join(root, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 15000); });
    const token = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.setTimeout(120000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    await fn(call, () => errText);
  } finally { child.kill(); fake.close(); }
}
const tool = (root, args, env) => spawnSync(process.execPath, [path.join(root, 'company/tools', args[0])].concat(args.slice(1)), { cwd: root, encoding: 'utf8', env: envFor(root, env), timeout: 180000 });

test('B4: a decision the crew made by a tested check has an Undo button on Today that reaches the crew as the owner\'s word', async () => {
  const T = fixture();
  run(T, `
const N = require(path.join(T, 'company/tools/lib/owner-notice.js'));
N.send({ kind: 'fyi', from: 'Sharon', text: 'Sharon decided to raise the ad budget to $40. You can undo it on Today.', key: 'd-0123456789ab', action: { kind: 'undo-decision', decisionId: 'd-0123456789ab' } }, { root: T });
out({});`);
  await consoleOn(T, async (call, err) => {
    const d = await call('GET', '/api/digest');
    const item = (d.json.items || []).find(x => x.action);
    assert.ok(item && item.action.kind === 'undo-decision' && item.action.decisionId === 'd-0123456789ab', 'the line carries its Undo: ' + JSON.stringify(d.json));
    const u = await call('POST', '/api/digest/undo', { decisionId: 'd-0123456789ab' });
    assert.equal(u.status, 200, JSON.stringify(u.json) + err());
    assert.ok(!/node |--by|d-[0-9a-f]{12}/.test(u.json.said), 'what the owner reads is plain: ' + u.json.said);
    const none = await call('POST', '/api/digest/undo', { decisionId: 'd-ffffffffffff' });
    assert.equal(none.status, 404, 'only a line that carries an Undo can be undone');
  });
  const inbound = fs.readFileSync(path.join(T, 'company/owner/inbound.jsonl'), 'utf8');
  assert.match(inbound, /undo this decision[^\n]*d-0123456789ab/i, 'the crew gets the owner\'s undo, naming the decision (decision.js join reads it)');
  // the governance line itself no longer says "Reply undo"
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'company/tools/lib/governance.js'), 'utf8'), /Reply "undo"/);
});

test('B4: an add-on approval, a module switch-on and a protected-file accept each reach the owner as one card with a button, never a command', async () => {
  const T = fixture({ modules: true });
  W(T, 'company/work/finance/dispatch-budget.json', '{"dailyUsd":5}\n');
  const r = run(T, `
const pk = require(path.join(T, 'company/tools/pack.js'));
const pc = pk.ownerCard({ id: 'trading-desk', title: 'Trading desk', summary: 'Trades small amounts on prediction markets within limits you set.' }, 'Boss', 'ab12cd34ef567890', 'approved');
const L = require(path.join(T, 'company/tools/locked-watch.js'));
const man = L.MANIFEST.filter(m => m.p === 'company/work/finance/dispatch-budget.json');
const ctx0 = () => L.context({ root: T, home: path.join(T, 'home'), manifest: man, ownerShell: false, underStation: false, log: () => {} });
L.tick(ctx0());
fs.writeFileSync(path.join(T, 'company/work/finance/dispatch-budget.json'), '{"dailyUsd":6}');
L.tick(ctx0());
let la = null; try { la = L.askAcceptCmd(ctx0(), 'company/work/finance/dispatch-budget.json', { by: 'Hal', why: 'the new cap is the one finance agreed' }); } catch (e) { la = 'ERR ' + e.message; }
out({ pc, la });`);
  assert.equal(r.pc.filed, true, 'the pack card is filed: ' + JSON.stringify(r.pc));
  assert.match(String(r.la), /asked the owner/, 'the protected-file card is filed: ' + r.la);
  const m = tool(T, ['module.js', 'ask', 'liveness', '--by', 'Hal', '--why', 'we need the outside alarm to know when the company stops']);
  assert.equal(m.status, 0, m.stdout + m.stderr);
  await consoleOn(T, async (call, err) => {
    const q = await call('GET', '/api/questions');
    const cards = (q.json.questions || []).filter(x => ['packInstall', 'moduleEnable', 'lockedAccept'].includes(x.effectKind));
    assert.deepEqual(cards.map(c => c.effectKind).sort(), ['lockedAccept', 'moduleEnable', 'packInstall'], JSON.stringify(q.json.questions.map(x => [x.id, x.effectKind, x.message])) + err());
    for (const c of cards) {
      assert.equal(c.needsOwner, true, c.effectKind + ' is in Needs you');
      assert.equal(c.canRule, false, c.effectKind + ': no standing rule offered (only the owner can do it)');
      assert.ok(c.message && !/node |--by|\.js\b|sha256|company\//.test(c.message + ' ' + (c.consequence || '')), c.effectKind + ' is plain: ' + c.message);
      assert.ok(c.cardDigest, 'the card can be answered with a button');
    }
    // the module card's yes switches it on, as the owner
    const mc = cards.find(c => c.effectKind === 'moduleEnable');
    const a = await call('POST', '/api/questions/' + mc.id + '/answer', { action: 'approve', cardDigest: mc.cardDigest });
    assert.equal(a.status, 200, JSON.stringify(a.json) + err());
    // the console ran the owner's own switch-on for that module (module.js enable --by <owner>); in this bare fixture the
    // module's own conformance test may refuse it, which the owner reads in plain words
    assert.equal(a.json.applied && a.json.applied.kind, 'moduleEnable', JSON.stringify(a.json) + err());
    assert.ok(a.json.applied.applied === true || /conformance|enable/i.test(String(a.json.applied.technical)), 'module.js enable ran: ' + JSON.stringify(a.json.applied));
    assert.ok(!/node |--by|\.js\b/.test(a.json.applied.said), a.json.applied.said);
    // the protected-file card's yes keeps exactly that content
    const lc = cards.find(c => c.effectKind === 'lockedAccept');
    const b = await call('POST', '/api/questions/' + lc.id + '/answer', { action: 'approve', cardDigest: lc.cardDigest });
    assert.equal(b.status, 200, JSON.stringify(b.json) + err());
    assert.equal(b.json.applied && b.json.applied.applied, true, 'the change is kept: ' + JSON.stringify(b.json) + err());
  });
});

test('B4: the crew\'s refusal points an owner-only accept at the card tool, never at the owner\'s shell', () => {
  const scope = require(path.join(REPO, 'company/tools/lib/owner-scope.js'));
  const c = scope.check({ from: 'Founder', message: 'One accept command only your shell can run: the locked file default-branch-watch.js changed and only you can accept it.' }, { rows: [], govOpts: { level: 'auto' } });
  assert.ok(c && c.code === 'crew-scope', JSON.stringify(c));
  assert.match(c.error, /locked-watch\.js ask-accept/);
});

test('B4: model trials: the people function starts one while the models level lets the crew decide; the owner is told plainly at notify', () => {
  const run1 = (root, argv, owner) => {
    const code = 'const prov = require(' + JSON.stringify(path.join(REPO, 'company/tools/provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (owner ? 'true' : 'false') + ');' +
      'const r = require(' + JSON.stringify(path.join(REPO, 'company/tools/routing.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
    const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: envFor(root) });
    assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout);
  };
  const make = level => {
    const T = company({ levels: { models: level }, agents: { boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, hal: { name: 'Hal', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' }, kim: { name: 'Kim', manager: 'boss', inbox: 'to-kim.md' } } });
    W(T, 'company/departments.json', { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: 'kim', members: ['kim'], defaultClass: 'code', routes: {}, consult: {} }] });
    W(T, 'company/model-policy.json', { allowed: { 'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-opus-5-5'] } } });
    const def = 'company/defaults/work/models/routing-policy.json'; W(T, def, fs.readFileSync(path.join(REPO, def), 'utf8'));
    W(T, 'company/work/decisions.md', '# Decisions\n\n');
    const c = run1(T, ['trial', 'create', 'code-cmp', '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5@high', '--arm', 'claude-cli/claude-opus-5-5@medium', '--scope-dept', 'eng', '--by', 'Hal']);
    assert.equal(c.code, 0, JSON.stringify(c));
    return T;
  };
  const N = make('notify');
  const s = run1(N, ['trial', 'start', 'code-cmp', '--by', 'Hal']);
  assert.equal(s.code, 0, 'models at notify: the people function starts it: ' + JSON.stringify(s));
  const d = fs.readFileSync(path.join(N, 'company/owner/digest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop();
  assert.match(d.text, /^Hal started a trial that compares AI models on real work, as your settings allow\./);
  const A = make('approve');
  assert.equal(run1(A, ['trial', 'start', 'code-cmp', '--by', 'Hal']).code, 2, 'models at approve: still the owner\'s');
  const K = make('auto');
  assert.equal(run1(K, ['trial', 'start', 'code-cmp', '--by', 'Kim']).code, 2, 'only the people function, not any seat');
  const ui = fs.readFileSync(path.join(REPO, 'console/ui/js/screens/settings/routing.js'), 'utf8');
  assert.match(ui, /The crew recommends starting this/, 'the trial card has the crew\'s recommendation');
  assert.match(ui, /If you do nothing, nothing changes/, 'and the default');
});

test('B4: Settings › Autonomy turns a tested check on or back to practice, and takes a delegation back, from the console', async () => {
  const T = fixture();
  const g = tool(T, ['delegation.js', 'grant', '--to', 'Hal', '--categories', 'hiring', '--until', new Date(Date.now() + 3 * 864e5).toISOString(), '--by', 'owner', '--why', 'while I am away']);
  assert.equal(g.status, 0, g.stdout + g.stderr);
  const id = JSON.parse(g.stdout).delegation.id;
  await consoleOn(T, async (call, err) => {
    const l = await call('GET', '/api/delegations');
    assert.ok((l.json.delegations || []).some(d => d.id === id && d.active), JSON.stringify(l.json) + err());
    const rv = await call('POST', '/api/delegations/' + id + '/revoke', {});
    assert.equal(rv.status, 200, JSON.stringify(rv.json) + err());
    const ms = await call('GET', '/api/decision-models');
    const m = (ms.json.models || []).find(x => x.id === 'gate-triage');
    assert.ok(m, JSON.stringify(ms.json));
    const p = await call('POST', '/api/decision-models/gate-triage/mode', { mode: 'shadow' });
    assert.equal(p.status, 200, JSON.stringify(p.json) + err());
  });
  const after = JSON.parse(fs.readFileSync(path.join(T, 'company/state/delegations.json'), 'utf8')).delegations.find(d => d.id === id);
  assert.ok(after.revokedAt, 'the delegation is taken back');
  const ui = fs.readFileSync(path.join(REPO, 'console/ui/js/screens/settings/autonomy.js'), 'utf8');
  assert.doesNotMatch(ui, /from a shell on this machine|decide\.js promote/, 'no shell instruction');
  assert.match(ui, /Turn on/); assert.match(ui, /Take it back/);
});

/* ---------------- B5: FYIs and the day message ---------------- */
test('B5: an FYI card never lands in Needs you; a blocking money hold still does', () => {
  const T = fixture({ levels: { budget: 'auto' } });
  const r = run(T, NEEDS_CTX + `
const fyi = { id: 'q-000501', from: 'Dispatcher', about: 'money-hold:cap', message: 'Halima is paused: the company has spent today\\'s $5 pay-as-you-go budget.', blocking: false, batch: 'fyi', kind: 'form' };
const hold = Object.assign({}, fyi, { id: 'q-000502', blocking: true, batch: null });
const s = NEEDS.split([fyi, hold], {});
out({ needs: s.needs.map(x => x.id), handling: s.handling.map(x => ({ id: x.id, line: x.line })) });`);
  assert.deepEqual(r.needs, ['q-000502'], 'only the blocking hold needs the owner');
  assert.equal(r.handling.length, 1); assert.equal(r.handling[0].id, 'q-000501');
  assert.match(r.handling[0].line, /You can still choose here/);
});

test('B5: the day message never says "nothing needs an answer" under a line that points at Today, and has no "FYI:" or long name lists', () => {
  const T = company({ levels: { budget: 'auto' } });
  const r = run(T, `
const N = require(path.join(REPO, 'company/tools/lib/owner-notice.js'));
N.send({ kind: 'fyi', from: 'Alex', text: 'One approval is waiting for you on Today › Needs you. [Open Needs you](console:#/today)', asks: true }, { root: T });
N.send({ kind: 'fyi', from: 'Pat', text: 'Pat tidied the shared notes.' }, { root: T });
const withAsk = N.digest({ root: T, force: true, dry: true }).text;
const MH = require(path.join(REPO, 'company/tools/lib/money-hold.js'));
const names = Array.from({ length: 13 }, (_, i) => 'Person ' + i);
const q = MH.questionFor({ kind: 'cap', names, waiting: [], cap: 0, spent: 0 }, true);
const src = fs.readFileSync(path.join(REPO, 'company/tools/lib/money-hold.js'), 'utf8') + fs.readFileSync(path.join(REPO, 'company/tools/lib/pacing-ask.js'), 'utf8');
out({ withAsk, lead: q.message, fyiPrefix: /text: 'FYI: '/.test(src) });`);
  assert.doesNotMatch(r.withAsk, /Nothing here needs an answer from you/, r.withAsk);
  assert.match(r.withAsk, /Only what waits on Today needs an answer from you/);
  assert.match(r.lead, /^13 crew members are paused: the company has spent today's \$0 pay-as-you-go budget\./, r.lead);
  assert.doesNotMatch(r.lead, /metered|Person 4/);
  assert.equal(r.fyiPrefix, false, 'no "FYI:" prefix inside the day message');
  const ap = fs.readFileSync(path.join(REPO, 'company/tools/approvals.js'), 'utf8');
  assert.match(ap, /asks: true, key: 'approval-reminder:/, 'the approval reminder marks itself as pointing at Today');
});

/* ---------------- the jargon list and the M-items ---------------- */
test('jargon: a governance card that would say nothing is not sent; no "reasons are under the technical details"', () => {
  const T = company({ levels: { tools: 'approve' } });
  const r = run(T, `
const gov = require(path.join(REPO, 'company/tools/lib/governance.js'));
const d = gov.decide('tools', { by: 'Sharon', summary: 'apply hc-0008, a policy change to company/work/finance/pacing-policy.json (/minimax/fiveHourCloseBelowLeftPct: 0 -> 35)', recommendation: 'per the hc-0008 review', ref: 'harness:hc-0008' }, { root: T });
const ok = gov.decide('tools', { by: 'Sharon', summary: 'change how work is handed out', recommendation: 'yes', ref: 'harness:hc-0009' }, { root: T });
const asks = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js')).rows({ file: path.join(T, 'company/pm-inbox.jsonl'), noAlert: true }).filter(x => x.type === 'ask');
out({ d, refusal: gov.refusal('tools', d), asks: asks.map(a => ({ message: a.message, recommendation: a.recommendation })) });`);
  assert.equal(r.d.allowed, false); assert.equal(r.d.notPlain, true, JSON.stringify(r.d));
  assert.match(r.refusal, /does not read plainly/);
  assert.equal(r.asks.length, 1, 'only the plain one reaches the owner: ' + JSON.stringify(r.asks));
  assert.equal(r.asks[0].message, 'May Sharon go ahead and change how work is handed out?');
  assert.doesNotMatch(JSON.stringify(r.asks), /reasons are under the technical details|a decision about/);
});

test('jargon: change cards have no canned reason and say a makers-only change leaves the company as it is; M1 a makers-only change is not a card', () => {
  const T = company({ levels: { tools: 'approve' } });
  const g = p => spawnSync('git', p, { cwd: T, encoding: 'utf8' });
  W(T, 'company/tools/fw.js', 'x\n'); W(T, 'company/work/.founded', ''); W(T, 'company/tools/mine.js', 'y\n');
  W(T, 'company/work/changes/hc-0001/change.diff', '--- a/company/tools/fw.js\n+++ b/company/tools/fw.js\n@@ -1 +1 @@\n-x\n+y\n');
  g(['init', '-q']); g(['add', 'company/tools/fw.js']);
  const r = run(T, `
const hc = require(path.join(REPO, 'company/tools/harness-change.js'));
const ctx = hc.context({ root: T, now: Date.now() });
const base = { kind: 'tool', by: 'Kwame Asante', byId: 'engineer', why: 'tighten the check', change: { mode: 'patch', payload: 'company/work/changes/hc-0001/change.diff' }, status: 'approved',
  reviewers: [{ id: 'auditor', name: 'Riley' }, { id: 'agent', name: 'Alex' }], approvals: [{ id: 'auditor', name: 'Riley' }, { id: 'agent', name: 'Alex' }] };
const up = hc.ownerCard(ctx, Object.assign({ id: 'hc-0001', target: { type: 'file', file: 'company/tools/fw.js' } }, base), 'apply');
const own = hc.ownerCard(ctx, Object.assign({ id: 'hc-0002', target: { type: 'file', file: 'company/tools/mine.js' } }, base), 'apply');
const review = hc.ownerCard(ctx, Object.assign({ id: 'hc-0003', target: { type: 'file', file: 'company/tools/fw.js' } }, base, { reviewers: [{ id: 'owner', name: 'owner' }], approvals: [] }), 'review');
const asks = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js')).rows({ file: path.join(T, 'company/pm-inbox.jsonl'), noAlert: true }).filter(x => x.type === 'ask');
out({ up, own, review, asks: asks.map(a => ({ ref: a.gate.ref, message: a.message, recommendation: a.recommendation })) });`);
  assert.equal(r.up.filed, false); assert.equal(r.up.route, 'crew', 'M1: a makers-only change is not a card: ' + JSON.stringify(r.up));
  assert.equal(r.own.filed, true, 'a change in this company still is: ' + JSON.stringify(r.own));
  const own = r.asks.find(a => a.ref === 'harness-review:hc-0002');
  assert.doesNotMatch(own.recommendation, /keeps their work running smoothly/);
  const rv = r.asks.find(a => a.ref === 'harness-review:hc-0003');
  assert.ok(rv, 'the owner reviewing a framework change still gets its card');
  assert.match(rv.message, /nothing changes in your company/);
  assert.doesNotMatch(JSON.stringify(r.asks), /keeps this company as it is/);
});

test('M2: the word API alone does not make a key only the owner can get the crew\'s job', () => {
  const scope = require(path.join(REPO, 'company/tools/lib/owner-scope.js'));
  const c = scope.classify({ message: 'Paste your Pyth Hermes API key here, please.' });
  assert.equal(c.scope, 'owner', JSON.stringify(c)); assert.ok(c.owner.includes('account'));
  const k = scope.check({ from: 'Founder', message: 'Paste your Pyth Hermes API key here, please.' }, { rows: [], govOpts: { level: 'auto' } });
  assert.notEqual(k && k.code, 'crew-scope', 'never refused as the crew\'s job: ' + JSON.stringify(k));
  assert.equal(scope.classify({ message: 'Our API client needs a retry on timeouts.' }).scope, 'crew', 'crew tooling is still the crew\'s');
});

test('M3: a crew member\'s name reads as people write it on Today', () => {
  const T = fixture();
  W(T, 'company/tools/loops.json', { agents: { boss: { name: 'Boss', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, people: { name: 'nadia farrell', functions: ['people'], manager: 'boss', inbox: 'to-nadia.md' } } });
  const r = run(T, NEEDS_CTX + `
const N = require(path.join(T, 'company/tools/lib/owner-notice.js'));
const s = N.send({ kind: 'fyi', from: 'nadia farrell', text: 'nadia farrell sent the makers a suggestion. Nothing changes in your company.' }, { root: T });
out({ t: NEEDS.properNames('nadia farrell wants to change one of the safeguards.'), row: s.row });`);
  assert.equal(r.t, 'Nadia Farrell wants to change one of the safeguards.');
  assert.equal(r.row.from, 'Nadia Farrell'); assert.match(r.row.text, /^Nadia Farrell sent the makers/, 'the day message too');
});
