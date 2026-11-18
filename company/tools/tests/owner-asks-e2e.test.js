#!/usr/bin/env node
/* owner-asks-e2e.test.js — the owner is asked only what is theirs, in plain words, end to end across the four pieces:
 * the crew's tools (harness-change.js, service.js, halt.js) -> lib/owner-card.js (one plain card, or back to the crew)
 * and lib/owner-notice.js (urgent now, everything else in the one daily digest) -> the console (Today › Needs you,
 * "The crew is handling", standing rules, and a yes that does what the card asks: console/owner-needs.js).
 *
 * Owner direction 2026-11-18: "It's asking me for permissions for a lot of things that we've already scoped agents for
 * permission to do … people who are non-technical need to be able to use this."
 *
 *   (a) a change to a locked tool at tools=auto: no owner card, no owner message, one plain digest line
 *   (b) at tools=approve: exactly one plain card in Needs you (no path, diff or id in the lead), the technical part
 *       present, and the owner's yes in the console applies the change
 *   (c) a safe-profile background job at schedules=notify: installed, one digest line, no card
 *   (d) a background job talking to a new outside host: one plain card; the console's yes installs it
 *   (e) a soft halt: the owner's message is plain and carries no command (the command is in the technical part)
 *   (f) a standing rule "the crew decides models" hides a models card, and never a fixed-gate card
 *   (g) a card filed while its category was at approve, open after the owner moved it to notify: under "The crew is
 *       handling", not Needs you
 *   (h) the old-shape cards of a real company (capheos-sandbox's latest ask row of each shape, values redacted:
 *       tests/fixtures/owner-asks/sandbox-old-cards.jsonl) still render and can be answered
 *
 * Real modules throughout (no stand-ins): a temp copy of company/ and console/, the crew's steps as child processes
 * with the company root set, the real console server on loopback with a fake station, a fake systemctl.
 *
 *   node --test company/tools/tests/owner-asks-e2e.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const scope = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-scope.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n'); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return ''; } };
const jsonl = (root, rel) => read(root, rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
const asks = root => jsonl(root, 'company/pm-inbox.jsonl').filter(r => r.type === 'ask');
const CREW = {
  ceo: { name: 'Alex', title: 'CEO', manager: null, functions: ['ceo'], inbox: 'to-alex.md' },
  people: { name: 'Kwame', title: 'People', manager: 'ceo', functions: ['people'], inbox: 'to-kwame.md' },
  engineer: { name: 'Max', title: 'Engineer', manager: 'ceo', functions: ['tools'], inbox: 'to-max.md' },
  auditor: { name: 'Riley', title: 'Auditor', manager: 'ceo', functions: ['risk'], inbox: 'to-riley.md' },
  data: { name: 'Halima', title: 'Data', manager: 'ceo', inbox: 'to-halima.md' },
};

/* plain for the owner: nothing a non-technical person trips on (owner-scope's jargon list, and the obvious tells) */
const TELLS = /\/|\.js\b|\.json\b|\bhc-\d+|\bq-\d{6}\b|^[+-]{3} |@@|`|--[a-z]|\bnode\b|\bsystemctl\b|\*-\*-\*/m;
function assertPlain(text, what) {
  const t = String(text || '').replace(/\]\(console:[^)]*\)/g, ']');
  assert.ok(t.trim(), what + ' is empty');
  assert.deepEqual(scope.plainScore(t).jargon, [], what + ' has jargon: ' + t);
  assert.doesNotMatch(t, TELLS, what + ' has a path, id, diff or command: ' + t);
}

function fixture(levels) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-asks-e2e-')); roots.push(root);
  fs.cpSync(path.join(REPO, 'company'), path.join(root, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'console'), path.join(root, 'console'), { recursive: true });
  for (const f of ['company/state/locked', 'company/pm-inbox.jsonl', 'company/state/governance.json', 'company/state/owner-rulings.json', 'company/owner',
    'company/state/services.json', 'company/state/halt.json', 'company/work/changes', 'company/state/owner-digest.json']) fs.rmSync(path.join(root, f), { recursive: true, force: true });
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive', addressAs: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  const gov = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'state', 'governance.json'), 'utf8'));
  Object.assign(gov.categories, levels || {});
  w(root, 'company/state/governance.json', gov);
  w(root, 'company/work/jobs/report.sh', 'echo 1\n');
  fs.mkdirSync(path.join(root, 'company/work/handoffs'), { recursive: true });
  w(root, 'secrets/station-token', 'fake-token\n');
  // a systemctl stand-in: every call is logged, nothing touches the real service manager
  const sc = w(root, 'fake-systemctl', '#!/bin/sh\necho "$@" >> ' + JSON.stringify(path.join(root, 'fake-systemctl.log')) + '\ncase "$2" in show) echo ActiveState=active;; esac\nexit 0\n');
  fs.chmodSync(sc, 0o755);
  fs.mkdirSync(path.join(root, 'units'), { recursive: true }); fs.mkdirSync(path.join(root, 'tr'), { recursive: true });
  return root;
}
const setLevel = (root, cat, lv) => { const f = path.join(root, 'company/state/governance.json'); const g = JSON.parse(fs.readFileSync(f, 'utf8')); g.categories[cat] = lv; fs.writeFileSync(f, JSON.stringify(g, null, 1) + '\n'); };

function envFor(root, extra) {
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', CONSOLE_HOST: '127.0.0.1',
    SERVICE_SYSTEMCTL: path.join(root, 'fake-systemctl'), SERVICE_JOURNALCTL: '/bin/true', SERVICE_UNIT_DIR: path.join(root, 'units'), SERVICE_TRANSIENT_DIR: path.join(root, 'tr') }, extra || {});
  for (const k of ['OWNER_DIR', 'PM_INBOX_FILE', 'GOVERNANCE_ROOT', 'HARNESS_ROOT', 'PROVENANCE_ROOT', 'STARNET_AGENT_ID', 'CONSOLE_PORT', 'CAPHEOS_READONLY', 'INBOX_SECRETS_DIR']) delete env[k];
  return env;
}
/* one crew step, as its own process in the fixture company (the fixture's copy of the tools, the real modules) */
let seq = 0;
function crew(root, body) {
  const script = w(root, 'scratch/step-' + (++seq) + '.js', "'use strict';\nconst path = require('path');\nconst ROOT = " + JSON.stringify(root) + ";\n" +
    "const T = p => require(path.join(ROOT, 'company', 'tools', p));\n" +
    "(async () => { const out = await (async () => {\n" + body + "\n})(); process.stdout.write('\\n@@RESULT@@' + JSON.stringify(out === undefined ? null : out)); })()" +
    ".catch(e => { console.error((e && e.stack) || e); process.exit(1); });\n");
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: envFor(root), timeout: 120000 });
  assert.equal(r.status, 0, 'crew step failed: ' + r.stderr + r.stdout);
  const i = r.stdout.lastIndexOf('@@RESULT@@');
  return JSON.parse(r.stdout.slice(i + '@@RESULT@@'.length));
}
// the crew's own run (an agent seat), as the tools see it in a station run
const HC_CTX = "T('harness-change.js').context({ root: ROOT, now: Date.now(), underStation: true, ownerShell: false, skipSelftest: true, call: async () => ({ status: 500 }) })";
const SV_CTX = "T('service.js').context({ root: ROOT, unitDir: path.join(ROOT, 'units'), transientDir: path.join(ROOT, 'tr'), systemctl: () => ({ code: 0, out: '' }), journal: () => '', isAgent: () => true, ownerShell: () => false, guard: () => true, halted: () => false, callerConflict: () => null, gov: { root: ROOT } })";
const NEW_TOOL = "'use strict';\n// count a report only once in the totals\nmodule.exports = { counted: 'once' };\n";

async function consoleOn(root, fn) {
  const fake = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fake"}'); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = envFor(root, { STARNET_URL: 'http://127.0.0.1:' + fake.address().port });
  const child = spawn(process.execPath, [path.join(root, 'console', 'server.js'), '--port', '0', '--host', '127.0.0.1', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 20000); });
    const token = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j, text: x }); });
      });
      req.setTimeout(120000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    await fn(call, () => errText);
  } finally { child.kill(); fake.close(); }
}
const byRef = (list, ref) => (list || []).find(q => q && ((q.gate && q.gate.ref === ref) || (q.question && q.question.gate && q.question.gate.ref === ref)));

test('(a) a locked tool changed at tools=auto: no owner card, no owner message, one plain digest line', () => {
  const root = fixture({ tools: 'auto' });
  const r = crew(root, `
    const HC = T('harness-change.js'); const C = () => ${HC_CTX};
    const r = await HC.propose(C(), { kind: 'tool', target: 'company/tools/competence.js', why: 'count a report only once in the totals', change: ${JSON.stringify(NEW_TOOL)}, by: 'Kwame' });
    HC.review(C(), r.id, { by: 'Riley' }, 'approve'); HC.review(C(), r.id, { by: 'Max' }, 'approve');
    const a = await HC.applyChange(C(), r.id, { by: 'Max' });
    return { id: r.id, locked: r.target.locked, reviewers: r.reviewers.map(x => x.name), status: a.status };`);
  assert.equal(r.locked, true, 'competence.js is a locked tool');
  assert.deepEqual(r.reviewers, ['Riley', 'Max'], 'the risk and tools seats review it, not the owner');
  assert.equal(r.status, 'applied');
  assert.equal(read(root, 'company/tools/competence.js'), NEW_TOOL);
  assert.equal(asks(root).length, 0, 'no owner card');
  assert.equal(read(root, 'company/owner/outbound.jsonl'), '', 'no owner message');
  const d = jsonl(root, 'company/owner/digest.jsonl');
  assert.equal(d.length, 1, 'one digest line: ' + JSON.stringify(d));
  assert.equal(d[0].kind, 'fyi');
  assert.equal(d[0].text, 'Kwame changed how the crew\'s work is measured, after two colleagues reviewed it.');
  assertPlain(d[0].text, 'the digest line');
  assert.match(d[0].technical, /competence\.js/, 'the file is for the crew, in the technical part');
});

test('(b) at tools=approve: exactly one plain card in Needs you, technical details present, and the console yes applies the change', async () => {
  const root = fixture({ tools: 'approve' });
  const r = crew(root, `
    const HC = T('harness-change.js'); const C = () => ${HC_CTX};
    const r = await HC.propose(C(), { kind: 'tool', target: 'company/tools/competence.js', why: 'count a report only once in the totals', change: ${JSON.stringify(NEW_TOOL)}, by: 'Kwame', plain: 'It only changes how a report is counted.' });
    HC.review(C(), r.id, { by: 'Riley' }, 'approve'); HC.review(C(), r.id, { by: 'Max' }, 'approve');
    let refused = null; try { await HC.applyChange(C(), r.id, { by: 'Max' }); } catch (e) { refused = e.message; }
    return { id: r.id, refused };`);
  assert.match(r.refused || '', /waits for the owner/);
  assert.equal(asks(root).length, 1, 'exactly one card');
  assert.equal(read(root, 'company/owner/outbound.jsonl'), '', 'a card, not a message');
  const before = read(root, 'company/tools/competence.js');
  assert.notEqual(before, NEW_TOOL, 'nothing applied before the owner says yes');
  await consoleOn(root, async (call, err) => {
    let q = await call('GET', '/api/questions');
    assert.equal(q.status, 200, JSON.stringify(q.json) + err());
    const mine = q.json.questions.filter(x => x.gate && /^harness-review:/.test(x.gate.ref));
    assert.equal(mine.length, 1, 'one card in Needs you: ' + JSON.stringify(q.json.questions.map(x => x.id)));
    const c = mine[0];
    assert.equal(c.gate.ref, 'harness-review:' + r.id);
    assert.ok(!byRef(q.json.crewHandling, 'harness-review:' + r.id), 'not also under The crew is handling');
    assertPlain(c.message, 'the card lead');
    assert.doesNotMatch(c.message, new RegExp(r.id), 'no change id in the lead');
    for (const k of ['consequence', 'recommendation']) if (c[k]) assertPlain(c[k], 'the card ' + k);
    assert.ok(c.technical && /competence\.js/.test(c.technical) && /count a report only once/.test(c.technical), 'the technical part carries the file and the change: ' + c.technical);
    assert.equal(c.effectKind, 'harnessApply'); assertPlain(c.effectSays, 'what yes does');
    const t = await call('GET', '/api/today'); assert.equal(t.json.needsYou.count, 1, 'the badge counts it');
    const a = await call('POST', '/api/questions/' + c.id + '/answer', { action: 'approve', cardDigest: c.cardDigest });   // as Today sends it
    assert.equal(a.status, 200, JSON.stringify(a.json) + err());
    assert.equal(a.json.applied && a.json.applied.applied, true, JSON.stringify(a.json));
    assertPlain(a.json.said, 'what the console said after yes');
    q = await call('GET', '/api/questions');
    assert.ok(!q.json.questions.some(x => x.id === c.id), 'the card is answered');
  });
  assert.equal(read(root, 'company/tools/competence.js'), NEW_TOOL, 'the yes applied the change');
  assert.equal(JSON.parse(read(root, 'company/work/changes/' + r.id + '.json')).status, 'applied');
});

test('(c) a safe-profile background job at schedules=notify: installed, one digest line, no card', () => {
  const root = fixture({ schedules: 'notify' });
  const r = crew(root, `
    const SV = T('service.js'); const ctx = ${SV_CTX};
    return SV.propose(ctx, 'nightly', { by: 'data', kind: 'timer', exec: 'bash company/work/jobs/report.sh', 'on-calendar': '*-*-* 02:00:00', why: 'builds the nightly report', network: 'none' });`);
  assert.equal(r.status, 'installed', JSON.stringify(r));
  assert.equal(asks(root).length, 0, 'no card');
  assert.equal(read(root, 'company/owner/outbound.jsonl'), '', 'no owner message');
  const d = jsonl(root, 'company/owner/digest.jsonl');
  assert.equal(d.length, 1, 'one digest line: ' + JSON.stringify(d));
  assert.equal(d[0].kind, 'fyi'); assert.match(d[0].text, /^Halima set up a background job/);
  assertPlain(d[0].text, 'the digest line');
});

test('(d) a background job talking to a new outside host: one plain card; the console yes installs it', async () => {
  const root = fixture({ schedules: 'auto' });
  const r = crew(root, `
    const SV = T('service.js'); const ctx = ${SV_CTX};
    const o = { by: 'data', kind: 'timer', exec: 'bash company/work/jobs/report.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.new.example' };
    const a = SV.propose(ctx, 'feed', o); const b = SV.propose(ctx, 'feed', o);
    return { a, b };`);
  assert.ok(r.a.waiting && r.b.waiting, JSON.stringify(r));
  const q0 = asks(root);
  assert.equal(q0.length, 1, 'one card, the same spec never twice');
  assert.equal(q0[0].gate.category, 'localComputer'); assert.deepEqual(q0[0].effect, { serviceApprove: { name: 'feed' } });
  assert.equal(JSON.parse(read(root, 'company/state/services.json')).services.feed.status, 'proposed');
  await consoleOn(root, async (call, err) => {
    const q = await call('GET', '/api/questions');
    const c = q.json.questions.find(x => x.id === q0[0].id);
    assert.ok(c, 'the card is in Needs you: ' + JSON.stringify(q.json));
    assertPlain(c.message, 'the card lead'); assert.ok(c.technical && /api\.new\.example/.test(c.technical), 'the host is in the technical part');
    assert.equal(c.effectKind, 'serviceApprove');
    const a = await call('POST', '/api/questions/' + c.id + '/answer', { action: 'approve', cardDigest: c.cardDigest });   // as Today sends it
    assert.equal(a.status, 200, JSON.stringify(a.json) + err());
    assert.equal(a.json.applied && a.json.applied.applied, true, JSON.stringify(a.json) + err());
    assertPlain(a.json.said, 'what the console said after yes');
  });
  const s = JSON.parse(read(root, 'company/state/services.json')).services.feed;
  assert.equal(s.status, 'installed', JSON.stringify(s));
  assert.match(s.approval.via, /the owner said yes/);
  assert.ok(read(root, 'fake-systemctl.log').trim(), 'installed through the (fake) service manager');
});

test('(e) a soft halt: the owner message is plain and has no command', () => {
  const root = fixture();
  crew(root, `
    const h = T('halt.js');
    h.S.call = async (m, p) => ({ status: 200, body: JSON.stringify(p === '/api/cron' ? { enabled: true, jobs: [] } : p === '/api/state/snapshot' ? { runs: [] } : p === '/api/loops' ? { loops: [] } : { ok: true, halted: 1 }) });
    h.S.services = () => {};
    return await h.soft({ by: 'Olive', why: 'checking the books' });`);
  const out = jsonl(root, 'company/owner/outbound.jsonl');
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].kind, 'urgent', 'the company stopping is urgent');
  assert.match(out[0].text, /^The company is pausing/);
  assertPlain(out[0].text, 'the halt message');
  assert.ok(String(out[0].technical || '').trim(), 'the station detail is in the technical part');
});

test('(f) a standing rule "the crew decides models" hides a models card, never a fixed-gate card', async () => {
  const root = fixture({ models: 'approve' });
  const filed = crew(root, `
    const card = T('lib/owner-card.js');
    const m = card.file({ asker: 'engineer', category: 'models', ref: 'models:writing-helper', lead: 'Max wants to move the crew\\'s writing work to a cheaper helper, to save money.',
      consequence: 'If you say yes, the writing work moves over. If you say no, nothing changes.', recommendation: 'The crew recommends yes; it can be moved back any time.', technical: 'routing trial: writing class, cheaper model', effect: { none: true } });
    const f = card.file({ asker: 'auditor', category: 'access', fixedGate: 'access', ref: 'access:bank', lead: 'Riley needs you to sign in to the bank account in your name, so suppliers can be paid.',
      consequence: 'If you say yes, the crew can pay suppliers. If you say no, payments wait.', recommendation: 'The crew recommends yes.' });
    return { m, f };`);
  assert.ok(filed.m.filed && filed.f.filed, JSON.stringify(filed));
  await consoleOn(root, async (call, err) => {
    let q = await call('GET', '/api/questions');
    assert.ok(q.json.questions.some(x => x.id === filed.m.id), 'before the rule the models card needs the owner');
    let r = await call('POST', '/api/rulings', { text: 'The crew decides which models to use.', scope: { categories: ['models'] }, effect: 'crew-decides' });
    assert.equal(r.status, 200, JSON.stringify(r.json) + err());
    r = await call('POST', '/api/rulings', { text: 'Handle bank sign-ins yourselves.', scope: { categories: ['access'] }, effect: 'crew-decides' });
    assert.equal(r.status, 400, 'a rule cannot cover a fixed gate'); assert.match(r.json.error, /always yours/);
    q = await call('GET', '/api/questions');
    assert.ok(!q.json.questions.some(x => x.id === filed.m.id), 'the models card left Needs you');
    const h = q.json.crewHandling.find(x => x.id === filed.m.id);
    assert.ok(h && /You made a standing rule/.test(h.line), JSON.stringify(q.json.crewHandling));
    assert.ok(q.json.questions.some(x => x.id === filed.f.id), 'the fixed-gate card still needs the owner');
  });
  // the tools read the same rule (lib/owner-rulings.js): a new models card is not filed, a fixed-gate one always is
  const again = crew(root, `
    const card = T('lib/owner-card.js');
    const m = card.file({ asker: 'engineer', category: 'models', ref: 'models:coding-helper', lead: 'Max wants to try a cheaper helper for routine coding, to save money.', consequence: 'If you say yes, it is tried for a week. If you say no, nothing changes.' });
    const f = card.file({ asker: 'auditor', category: 'access', fixedGate: 'access', ref: 'access:shop', lead: 'Riley needs you to open the shop account in your name, so the crew can list products.', consequence: 'If you say yes, the shop opens. If you say no, it waits.' });
    return { m, f };`);
  assert.equal(again.m.filed, false); assert.equal(again.m.route, 'ruling');
  assert.equal(again.f.filed, true, 'a fixed gate always reaches the owner');
});

test('(g) a card filed at approve, open after the owner moved its category to notify: under The crew is handling, not Needs you', async () => {
  const root = fixture({ hiring: 'approve' });
  const filed = crew(root, `
    return T('lib/owner-card.js').file({ asker: 'people', category: 'hiring', ref: 'hiring:writer-1', lead: 'Kwame wants to hire a part-time writer for the blog, so posts go out every week.',
      consequence: 'If you say yes, the writer starts next week. If you say no, nobody is hired.', recommendation: 'The crew recommends yes.' });`);
  assert.ok(filed.filed, JSON.stringify(filed));
  setLevel(root, 'hiring', 'notify');
  await consoleOn(root, async call => {
    const q = await call('GET', '/api/questions');
    assert.ok(!q.json.questions.some(x => x.id === filed.id), 'not in Needs you');
    const h = q.json.crewHandling.find(x => x.id === filed.id);
    assert.ok(h, 'under The crew is handling'); assert.match(h.line, /Your settings let the crew decide hiring and tell you afterwards\./);
    assertPlain(h.lead, 'the read-only line');
    const t = await call('GET', '/api/today');
    assert.equal(t.json.needsYou.count, 0, 'not in the badge');
  });
});

test('(h) the old-shape cards in a real company inbox still render and can be answered', async () => {
  const root = fixture();
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'owner-asks', 'sandbox-old-cards.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(rows.length >= 5, 'one row per old shape');
  const now = Date.now();
  rows.forEach((r, i) => { r.at = new Date(now - (rows.length - i) * 60e3).toISOString(); });
  const scriptRows = rows.map(r => { const o = Object.assign({}, r); delete o._shape; return o; });
  crew(root, `const G = T('lib/pm-inbox-guard.js'); for (const r of ${JSON.stringify(scriptRows)}) G.append(path.join(ROOT, 'company', 'pm-inbox.jsonl'), r, 'governance'); return true;`);
  const shape = Object.fromEntries(rows.map(r => [r._shape, r.id]));
  await consoleOn(root, async (call, err) => {
    let q = await call('GET', '/api/questions');
    assert.equal(q.status, 200, JSON.stringify(q.json) + err());
    for (const r of rows) {
      const inNeeds = q.json.questions.filter(x => x.id === r.id).length, inCrew = q.json.crewHandling.filter(x => x.id === r.id).length;
      assert.equal(inNeeds + inCrew, 1, r._shape + ' (' + r.id + ') is shown exactly once');
      const shown = q.json.questions.find(x => x.id === r.id) || q.json.crewHandling.find(x => x.id === r.id).question;
      assert.ok(String(shown.message || shown.q || '').trim(), r._shape + ' has words to show');
      assert.ok(shown.form || shown.questions, r._shape + ' has a way to answer it');
    }
    // the harness review at the default tools level (notify) is the crew's now; the old service card still needs the owner
    assert.ok(q.json.crewHandling.some(x => x.id === shape['gate+gate']), 'the old harness review card is with the crew');
    assert.ok(q.json.questions.some(x => x.id === shape['gate+form+gate']), 'the old background-job card still needs the owner');
    const answers = [
      [shape.plain, { action: 'approve' }],
      [shape.form, { action: 'skip' }],
      [shape['gate+form+gate'], { action: 'decline' }],
      [shape['gate+gate'], { action: 'approve' }],   // "Decide it yourself" under The crew is handling: the same answer route
      [shape['form+fyi'], { action: 'keep' }],
      [shape.multi, { parts: { reload: { action: 'decline' }, commitments: { action: 'decline' }, heartbeat: { action: 'decline' } } }],
    ].filter(([id]) => id);
    for (const [id, body] of answers) {
      const a = await call('POST', '/api/questions/' + id + '/answer', body);
      assert.equal(a.status, 200, id + ' ' + JSON.stringify(body) + ' -> ' + JSON.stringify(a.json) + err());
      assert.notEqual(a.json.state, 'open', id + ' is closed by the answer: ' + JSON.stringify(a.json));
    }
    q = await call('GET', '/api/questions');
    for (const [id] of answers) assert.ok(!q.json.questions.some(x => x.id === id) && !q.json.crewHandling.some(x => x.id === id), id + ' is answered');
  });
});
