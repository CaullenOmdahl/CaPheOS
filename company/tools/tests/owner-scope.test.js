#!/usr/bin/env node
/* owner-scope.test.js — the owner-scope rule (company/tools/lib/owner-scope.js) in the ask composer (inbox.js ask,
 * approvals.js ask): the classifier on the sandbox Founder's real questions of 2026-11-17, crew-scope refused with where
 * it goes, the plain-language scorer, owner-scope pass-through, the 7-day "not now" backoff, and the house rules.
 *   node --test company/tools/tests/owner-scope.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const S = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-scope.js'));

// the sandbox Founder's three owner questions of 2026-11-17 (capheos-sandbox company/pm-inbox.jsonl), as asked
const REAL = {
  'q-559031': { from: 'Founder', about: 'kill switch duty, commitments tool, recorder heartbeat',
    message: 'Three things only you can do, all access rather than policy, and each is safe to decline. The kill switch that decides whether trading halts only watched 25 of the last 46 minutes because of a systemd start limit, and the staged repair needs one daemon-reload that agents are refused. Our own house rules send every seat to a commitments tool that is switched off here, and only you can switch a module on. And the outside heartbeat you approved this morning needs its ping address from an account in your name. Recommendations: yes to all three; none of them changes what anyone may spend, access or decide.',
    details: 'KILL SWITCH DUTY: journal 17:17:55-18:05 = 25 completed passes, 21 start-limit-hit refusals; unit reads StartLimitBurst=5 / StartLimitIntervalSec=10min. HEARTBEAT: approved by you at 2026-11-17 05:23 (owner question q-435440, answer yes). No external ping support exists in company/tools/liveness.js yet.' },
  'q-623640': { from: 'Founder', about: 'recorder heartbeat',
    q: 'One more healthchecks check, please: name it recorder, period 5 minutes, grace 15, and paste its ping URL. It lets the order-book recorder page you if it dies, separately from the agents. If you skip it, the recorder stays covered only by the local watchdog.' },
  'q-766259': { from: 'Founder', about: '',
    message: 'The healthy-ping timer your setup run installed at 21:55 is working (HTTP 200 at 22:00:36) but is not on the service register, so a duty flags it every run. Adopting only records it: nothing new runs and there is no new egress.',
    details: 'Units: capheos-sandbox-station-liveness-heartbeat.service and .timer, oneshot, node modules/liveness/watch.js heartbeat, every 5 min. Certified by Ingrid Halvorsen in company/work/security/egress-heartbeat-2026-11-17.md, lapses 2026-11-24.' },
};
const SEATS = { risk: 'Ingrid Halvorsen', tools: 'Tomas Berg', floor: 'Marisol Vance' };

test('classifier: the two health-check plumbing asks are crew scope; the mixed one is owner scope only for its account part', () => {
  const a = S.classify(REAL['q-623640']);
  assert.equal(a.scope, 'crew'); assert.ok(a.crew.some(c => c.area === 'monitoring' && c.seat === 'risk'), JSON.stringify(a));
  const b = S.classify(REAL['q-766259']);
  assert.equal(b.scope, 'crew'); assert.ok(['timer', 'egress', 'register', 'service register'].some(w => b.crew.some(c => c.hit === w)), JSON.stringify(b));
  const c = S.classify(REAL['q-559031']);
  assert.equal(c.scope, 'owner'); assert.ok(c.owner.includes('account'), JSON.stringify(c.owner)); assert.ok(c.crew.length >= 3, 'its systemd, module and heartbeat parts are crew signals');
  for (const [m, topic] of [['May I spend $40 on X?', 'money'], ['Could you sign up for a free Acme account in your name?', 'account'], ['May we sign the pilot agreement with Acme?', 'legal'],
    ['Which market should we focus on first, sports or weather?', 'direction'], ['Are you comfortable with the risk of trading real money this week?', 'risk']])
    assert.ok(S.classify({ message: m }).owner.includes(topic), m + ' -> ' + topic);
  assert.equal(S.classify({ message: 'Shall we adopt the timer?', category: 'access', fixed: true }).scope, 'owner', 'a fixed gate is always the owner\'s');
});

test('each real Founder question is refused or returned for a rewrite by the composer', () => {
  for (const [id, q] of Object.entries(REAL)) {
    const r = S.check(q, { seats: SEATS });
    assert.ok(r, id + ' passed the composer');
    assert.ok(['crew-scope', 'plain'].includes(r.code), id + ': ' + r.code);
    if (r.code === 'plain') assert.ok(r.suggestion && S.plainScore(r.suggestion.replace(/<[^>]+>/g, 'it')).jargon.length === 0, id + ' suggestion is plain: ' + r.suggestion);
  }
  const mixed = S.check(REAL['q-559031'], { seats: SEATS });
  assert.equal(mixed.code, 'plain');
  assert.match(mixed.error, /systemd|daemon|module/); assert.match(mixed.error, /crew's/);
  assert.match(mixed.suggestion, /^Could you create a free <service> account in your name/);
});

test('crew scope is refused with the routing hint in plain words: the seat by name, yourself, or a framework request', () => {
  const r = S.check(REAL['q-623640'], { seats: SEATS });
  assert.equal(r.code, 'crew-scope'); assert.equal(r.route, 'risk');
  assert.match(r.error, /^Not asked: this is the crew's job, not the owner's/);
  assert.match(r.error, /hand it to Ingrid Halvorsen \(the risk seat\) in a handoff/);
  assert.match(r.error, /money beyond the company's own limits; accounts or identity in their own name/);
  const own = S.check(REAL['q-623640'], { seats: Object.assign({}, SEATS, { risk: 'Founder' }) });
  assert.match(own.error, /you hold the risk seat, so it is yours/);
  const t = S.check(REAL['q-766259'], { seats: SEATS });
  assert.equal(t.code, 'crew-scope'); assert.match(t.error, /Tomas Berg \(the tools seat\)/);
  const fw = S.check({ from: 'Founder', message: 'The house rules point at a tool that is off here; may I fix the framework bug?' }, { seats: SEATS });
  assert.equal(fw.code, 'crew-scope'); assert.match(fw.error, /file a framework request: node company\/tools\/harness-change\.js propose/);
});

test('the plain-language scorer: sentences, sentence length, jargon, ids and paths, numbers, the gain and the default', () => {
  const good = S.plainScore('Could you make a free Pyth account and paste its key here? It lets us test our main idea; if you skip it, that idea waits.');
  assert.equal(good.ok, true, JSON.stringify(good)); assert.ok(good.score >= 90);
  const jar = S.plainScore('Please add a check with period 5 and grace 15 and paste its ping URL. It protects us; if you skip it, nothing changes.');
  assert.equal(jar.ok, false); for (const w of ['period', 'grace', 'ping', 'URL']) assert.ok(jar.jargon.includes(w), w + ' ' + JSON.stringify(jar.jargon));
  const ids = S.plainScore('Please approve q-435440 for company/tools/liveness.js at 22:00:36. It helps; if you skip it, we wait.');
  assert.ok(ids.jargon.some(j => /an id/.test(j)) && ids.jargon.some(j => /file path|file or tool name/.test(j)) && ids.jargon.some(j => /clock time/.test(j)), JSON.stringify(ids.jargon));
  const long = S.plainScore('We would like it. It is good. It helps us; if you skip it, we wait.');
  assert.ok(long.problems.some(p => /3 sentences/.test(p)));
  const wordy = S.plainScore('Could you please let us know whether it would be all right for the company to go ahead with the plan we talked about last week with the team? It helps; if you skip it, we wait.');
  assert.ok(wordy.problems.some(p => /words; keep each under 25/.test(p)), JSON.stringify(wordy.problems));
  const bare = S.plainScore('Can you look at the landing page?');
  assert.ok(bare.problems.some(p => /gets or risks/.test(p)) && bare.problems.some(p => /skip it/.test(p)));
  const nums = S.plainScore('Pick 3, 7 or 12 for the trial. It helps us; if you skip it, we pick 7.');
  assert.ok(nums.problems.some(p => /numbers/.test(p)));
  assert.equal(S.plainScore('May we buy the data plan for $20? It unblocks the study.', { approval: true }).ok, true, 'an approval states its own default (deny)');
  assert.ok(good.score > jar.score && jar.score >= 0);
});

test('owner scope passes through: a money question, a plain account ask, a direction question, an approval', () => {
  assert.equal(S.check({ message: 'May I spend $40 on X?' }), null, 'money: the amount is the risk, nothing spent is the default');
  assert.equal(S.check({ message: 'Could you create a free Acme account in your name and paste what it gives you here? It lets us test the price idea; if you skip it, we use the free feed.' }), null);
  assert.equal(S.check({ message: 'Should we focus on sports markets first? It gives us the quickest test; if you skip it, we start with weather.' }), null);
  assert.equal(S.check({ message: 'May we sign the example pilot agreement? It lets us go on with the work.', category: 'commitment', fixed: true }), null);
});

// a scratch company for the composer end to end (inbox.js and approvals.js in a child, CAPHEOS_ROOT = the scratch root)
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
function company() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-scope-selftest-')); roots.push(T);
  w(T, 'company/company.json', { name: 'Example', owner: { name: 'Olive Owner', title: 'Owner' }, timezone: 'UTC' });
  w(T, 'company/tools/loops.json', { agents: { agent: { name: 'Founder', manager: null, functions: ['ceo', 'people', 'floor', 'finance'], inbox: 'to-founder.md' },
    ing: { name: 'Ingrid', manager: 'agent', functions: ['risk'], inbox: 'to-ingrid.md' }, tom: { name: 'Tomas', manager: 'agent', functions: ['tools'], inbox: 'to-tomas.md' } } });
  for (const f of ['company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/state/approvals-policy.json', 'company/competence-policy.json'])
    fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(T, f));
  fs.cpSync(path.join(REPO, 'company', 'decision-models'), path.join(T, 'company', 'decision-models'), { recursive: true });
  w(T, 'company/work/decisions.md', '# Decisions\n\n');
  w(T, '.capheos-selftest-fixture', '');
  return T;
}
function run(T, code) {
  const src = 'const A = require(' + JSON.stringify(path.join(REPO, 'company', 'tools', 'approvals.js')) + '); const I = require(' + JSON.stringify(path.join(REPO, 'company', 'tools', 'inbox.js')) + ');\n' +
    'const tryAsk = o => { try { return { ok: true, id: I.ask(o).row.id }; } catch (e) { return { ok: false, code: e.code, error: e.message, suggestion: e.suggestion || null }; } };\n' +
    'Promise.resolve((() => {' + code + '})()).then(v => console.log(JSON.stringify(v === undefined ? null : v)), e => { console.log(JSON.stringify({ threw: e.message })); });';
  const r = spawnSync(process.execPath, ['-e', src], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T, STARNET_URL: 'http://127.0.0.1:1' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop()); if (v && v.threw) throw new Error(v.threw); return v;
}

test('inbox.js ask: the real questions are refused (crew scope names the real seat holder); approvals.js ask is held to the plain rule before it writes an audit line', () => {
  const T = company();
  const r = run(T, 'return [' + Object.values(REAL).map(q => 'tryAsk(' + JSON.stringify(q) + ')').join(',') + '];');
  assert.ok(r.every(x => !x.ok), JSON.stringify(r));
  assert.deepEqual(r.map(x => x.code), ['shell', 'crew-scope', 'crew-scope'], 'q-559031 hands the owner a daemon-reload, so the older command rule refuses it first');
  assert.match(r[1].error, /hand it to Ingrid \(the risk seat\)/);
  const ok = run(T, 'return tryAsk({ from: "Founder", message: "May I spend $40 on X?" });');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = run(T, 'return A.ask({ from: "Founder", category: "spend", message: "Approve PO-1234 for the ingest endpoint and webhook config.", params: { amountUsd: 40 } });');
  assert.equal(bad.ok, false); assert.equal(bad.code, 'plain'); assert.ok(bad.suggestion);
  assert.doesNotMatch(fs.readFileSync(path.join(T, 'company', 'work', 'decisions.md'), 'utf8'), /PO-1234/, 'a refused approval leaves no audit line');
  const good = run(T, 'return A.ask({ from: "Founder", category: "spend", message: "May we spend $40 on a month of market data? It lets us test the price idea.", params: { amountUsd: 40 } });');
  assert.equal(good.ok, true, JSON.stringify(good)); assert.equal(good.minted, true);
});

test('backoff: a topic the owner answered "not now" is refused for 7 days unless --changed says what changed; other topics and old answers pass', () => {
  const T = company();
  const plain = 'Could you create a free Acme account in your name for the recorder alerts? It lets us hear when the recorder stops; if you skip it, the local check stays.';
  const first = run(T, 'return tryAsk({ from: "Founder", about: "recorder alerts", message: ' + JSON.stringify(plain) + ' });');
  assert.equal(first.ok, true, JSON.stringify(first));
  const ans = run(T, 'return I.answer({ id: ' + JSON.stringify(first.id) + ', by: "Commander", text: "Not now. Health-check plumbing is the crew\'s job.", quiet: true });');
  assert.equal(ans.ok, true, JSON.stringify(ans));
  const again = run(T, 'return tryAsk({ from: "Founder", about: "recorder alerts", message: "Could you make the free Acme account in your name for the recorder alerts after all? It lets us hear when the recorder stops; if you skip it, the local check stays." });');
  assert.equal(again.ok, false); assert.equal(again.code, 'backoff'); assert.match(again.error, /answered the same topic "not now"/); assert.match(again.error, /--changed/);
  const changed = run(T, 'return tryAsk({ from: "Founder", about: "recorder alerts", changed: "the recorder lost two hours of data last night", message: "Could you make the free Acme account in your name for the recorder alerts after all? It lets us hear when the recorder stops; if you skip it, the local check stays." });');
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const other = run(T, 'return tryAsk({ from: "Founder", about: "pricing", message: "May I spend $40 on a month of market data?" });');
  assert.equal(other.ok, true, 'another topic is not held back');
  // the same "not now" eight days ago no longer holds the topic back
  const rows = [{ type: 'ask', id: 'q-1', about: 'recorder alerts', message: plain }, { type: 'answer', id: 'q-1', at: new Date(Date.now() - 8 * 864e5).toISOString(), a: 'Not now.', by: 'Commander' }];
  assert.equal(S.backoff({ about: 'recorder alerts', message: plain }, rows), null);
  rows[1].at = new Date(Date.now() - 6 * 864e5).toISOString();
  assert.equal(S.backoff({ about: 'recorder alerts', message: plain }, rows).id, 'q-1');
  assert.equal(S.backoff({ about: 'recorder alerts', message: plain }, [rows[0], Object.assign({}, rows[1], { a: 'yes', answer: { verdict: 'yes' } })]), null, 'a yes is not a not-now');
  assert.equal(S.backoff({ about: 'x', message: plain }, [rows[0], Object.assign({}, rows[1], { by: 'expiry', surface: 'expiry', answer: { verdict: 'no' } })]), null, 'an expiry default is not the owner saying not now');
});

test('the guidance carries the rule: house rules, the Founder loop, the role template, decision rights, the chat context note', () => {
  const RR = require(path.join(REPO, 'company', 'tools', 'routine-rules.js'));
  assert.ok(Number(String(RR.VERSION).slice(1)) >= 10, RR.VERSION);   // v10 brought the owner-scope rule; later versions keep it
  assert.match(RR.BLOCK, /The owner is a busy non-technical person\. Handle infrastructure yourself/);
  assert.match(RR.BLOCK, /in two plain sentences that say what they get or risk and what happens if they skip it \(your default\)/);
  const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8');
  assert.match(read('company/tools/founder-loop.js'), /The owner is a busy non-technical person\. Handle infrastructure yourself/);
  assert.match(read('company/roles/templates/founder.md'), /The owner is a busy non-technical person\. Handle infrastructure yourself/);
  assert.match(read('company/DECISION_RIGHTS.md'), /## Owner scope: what may go to the owner at all/);
  assert.match(read('company/skills/owner-questions/SKILL.md'), /The owner is a busy non-technical person\. Handle infrastructure yourself\./);
  assert.match(read('console/chat.js'), /The owner is a busy non-technical person\. Handle infrastructure yourself/);
});
