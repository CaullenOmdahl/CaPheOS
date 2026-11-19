#!/usr/bin/env node
/* console-owner-needs.test.js — Today › Needs you shows only what still needs the owner (console/owner-needs.js), a yes
 * does what the card asks (a typed effect, applied by the console as the owner), standing rulings, and the daily digest.
 * The real console server on a fixture company (a temp copy of the framework), with a fake station on loopback.
 *
 *   node --test company/tools/tests/console-owner-needs.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const CREW = { boss: { name: 'Boss', title: 'CEO', functions: ['ceo'], manager: null, inbox: 'to-boss.md' }, hal: { name: 'Hal', title: 'People', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' } };

function fixture() {
  const root = require('../lib/temp-life').tmpDir('owner-needs-test-'); roots.push(root);
  fs.cpSync(path.join(REPO, 'company'), path.join(root, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
  fs.cpSync(path.join(REPO, 'console'), path.join(root, 'console'), { recursive: true });
  for (const f of ['company/state/locked/provenance.jsonl', 'company/pm-inbox.jsonl', 'company/state/governance.json', 'company/state/owner-rulings.json', 'company/owner/digest.jsonl']) try { fs.rmSync(path.join(root, f)); } catch (_) {}
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive', addressAs: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  w(root, 'secrets/station-token', 'fake-token\n');
  return root;
}
// cards are filed the way company/tools/lib/owner-card.js and lib/governance.js file them: a recorded ask row
function file(root, rows) {
  const script = w(root, 'scratch-file-cards.js', 'const G = require(' + JSON.stringify(path.join(root, 'company', 'tools', 'lib', 'pm-inbox-guard.js')) + ');\n' +
    'for (const r of ' + JSON.stringify(rows) + ') G.append(' + JSON.stringify(path.join(root, 'company', 'pm-inbox.jsonl')) + ', r, "governance");\n');
  const r = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }) });
  assert.equal(r.status, 0, r.stderr);
}
let seq = 100;
const card = (category, o) => {
  const id = 'q-' + String(++seq).padStart(6, '0');
  return Object.assign({ type: 'ask', id, at: new Date().toISOString(), from: 'Boss', about: 'governance:' + category, q: (o && o.message) || 'May we go ahead?', message: (o && o.message) || 'May we go ahead? It lets us move on; if you skip it, we wait.',
    blocking: true, batch: 'gate', gate: Object.assign({ category, ref: 'test:' + id, by: 'Boss', summary: 'go ahead' }, o && o.fixedGate ? { fixedGate: o.fixedGate } : {}) }, o && o.extra || {});
};

async function consoleOn(root, fn) {
  const fake = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fake"}'); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: root, STARNET_URL: 'http://127.0.0.1:' + fake.address().port, CAPHEOS_TZ: 'UTC' });
  delete env.CONSOLE_PORT; delete env.CAPHEOS_READONLY;
  const child = require('../lib/temp-life').track(spawn(process.execPath, [path.join(root, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 15000); });
    const token = fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.setTimeout(60000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    await fn(call, () => errText);
  } finally { child.kill(); fake.close(); }
}
const govLevel = (root, c) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'governance.json'), 'utf8')).categories[c]; } catch (_) { return null; } };

test('Needs you: a notify-level card is not in Needs you nor the badge; a fixed-gate card is; the rest is "The crew is handling"', async () => {
  const root = fixture();
  const notify = card('tools', { message: 'May I change the report tool? It lets us ship faster; if you skip it, we keep the old one.' });
  const fixed = card('access', { fixedGate: 'access', message: 'Could you sign in to the bank in your name? It lets us pay suppliers; if you skip it, we wait.' });
  const approve = card('hiring');
  file(root, [notify, fixed, approve]);
  await consoleOn(root, async call => {
    const r = await call('GET', '/api/questions');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ids = r.json.questions.map(q => q.id);
    assert.ok(!ids.includes(notify.id), 'a notify-level card is not in Needs you: ' + ids);
    assert.ok(ids.includes(fixed.id), 'a fixed-gate card is in Needs you');
    assert.ok(ids.includes(approve.id), 'an approve-level card is in Needs you');
    const h = r.json.crewHandling.find(x => x.id === notify.id);
    assert.ok(h, 'the notify card is under The crew is handling');
    assert.equal(h.from, 'Boss');
    assert.match(h.line, /Your settings let the crew decide changes to the crew's own tools and tell you afterwards\./);
    const t = await call('GET', '/api/today');
    assert.equal(t.json.needsYou.count, 2, 'the badge counts only what needs the owner');
    assert.ok(t.json.crewHandling.some(x => x.id === notify.id));
  });
});

test('an effect kind no tool files ({governance}, an unknown one) is never applied: a yes is recorded and changes nothing', async () => {
  const root = fixture();
  const gc = card('hiring', { extra: { effect: { governance: { category: 'hiring', level: 'notify' } }, consequence: 'Yes: the crew hires without asking you first. No: you keep approving each hire.', recommendation: 'Yes; you still hear about each hire.', technical: 'governance.js set hiring notify' } });
  const no = card('release', { extra: { effect: { governance: { category: 'release', level: 'auto' } } } });
  const odd = card('budget', { extra: { effect: { launchRockets: { now: true } } } });
  file(root, [gc, no, odd]);
  assert.equal(govLevel(root, 'hiring'), null, 'no company governance file yet: the defaults hold (hiring approve)');
  await consoleOn(root, async (call, err) => {
    let r = await call('GET', '/api/questions');
    const q = r.json.questions.find(x => x.id === gc.id);
    assert.ok(q, 'the governance card is in Needs you');
    assert.equal(q.effectKind, 'none', 'its effect was dropped by the reader (no tool files a governance effect)');
    assert.ok(!q.effectSays, 'nothing is promised for yes');
    assert.equal(q.technical, 'governance.js set hiring notify', 'the technical part is carried for the collapsed details');
    assert.match(q.consequence, /^Yes: the crew hires/);
    r = await call('POST', '/api/questions/' + gc.id + '/answer', { action: 'approve' });
    assert.equal(r.status, 200, JSON.stringify(r.json) + err());
    assert.ok(!(r.json.applied && r.json.applied.applied), JSON.stringify(r.json.applied));
    assert.equal(govLevel(root, 'hiring'), null, 'the level did not change');
    r = await call('POST', '/api/questions/' + no.id + '/answer', { action: 'decline' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.notEqual(govLevel(root, 'release'), 'auto');
    r = await call('POST', '/api/questions/' + odd.id + '/answer', { action: 'approve' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(!(r.json.applied && r.json.applied.applied));
  });
});

test('a standing rule hides a matching card; a fixed gate can never be ruled away; Settings lists and removes rules', async () => {
  const root = fixture();
  const a = card('release'), b = card('release'), org = card('org'), fixed = card('ownership', { fixedGate: 'ownership', message: 'May we sign the shop lease? It lets us open; if you skip it, we keep looking.' });
  file(root, [a, b, org, fixed]);
  await consoleOn(root, async (call, err) => {
    let r = await call('GET', '/api/questions');
    assert.ok(r.json.questions.some(q => q.id === b.id), 'the release card needs the owner before any rule');
    // the owner answers one with "Make this a standing rule"
    r = await call('POST', '/api/questions/' + a.id + '/answer', { action: 'approve', rule: { text: 'You decide releases yourselves.' } });
    assert.equal(r.status, 200, JSON.stringify(r.json) + err());
    assert.equal(r.json.ruling.effect, 'crew-decides'); assert.deepEqual(r.json.ruling.scope, { categories: ['release'] });
    assert.match(r.json.rulingSaid, /Saved as a standing rule/);
    const doc = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'owner-rulings.json'), 'utf8'));
    assert.equal(doc.rulings.length, 1); assert.equal(doc.rulings[0].by, 'owner'); assert.equal(doc.rulings[0].text, 'You decide releases yourselves.');
    r = await call('GET', '/api/questions');
    assert.ok(!r.json.questions.some(q => q.id === b.id), 'the matching card left Needs you');
    const h = r.json.crewHandling.find(x => x.id === b.id);
    assert.ok(h && /You made a standing rule: “You decide releases yourselves\.”/.test(h.line), JSON.stringify(r.json.crewHandling));
    // a free-text reply that makes a rule on an approval card: the rule is saved, the card stays open with the crew
    r = await call('POST', '/api/questions/' + org.id + '/answer', { verdict: 'reply', text: 'Organise the team as you see fit.', rule: {} });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.state, 'open'); assert.equal(r.json.ruling.text, 'Organise the team as you see fit.');
    r = await call('GET', '/api/questions');
    assert.ok(!r.json.questions.some(q => q.id === org.id) && r.json.crewHandling.some(x => x.id === org.id), 'the ruled card is with the crew, still open');
    await call('POST', '/api/rulings/' + (await call('GET', '/api/rulings')).json.rulings.find(x => x.text.startsWith('Organise')).id + '/remove', {});
    // a fixed gate: no rule, and the answer is not recorded either
    r = await call('POST', '/api/questions/' + fixed.id + '/answer', { action: 'approve', rule: { text: 'Sign leases yourselves.' } });
    assert.equal(r.status, 400); assert.match(r.json.error, /always yours/);
    r = await call('POST', '/api/rulings', { text: 'Handle ownership yourselves.', scope: { categories: ['ownership'] } });
    assert.equal(r.status, 400); assert.match(r.json.error, /always yours/);
    r = await call('GET', '/api/questions');
    assert.ok(r.json.questions.some(q => q.id === fixed.id), 'the fixed-gate card still needs the owner');
    // Settings › Autonomy › Standing rules: list, then remove; the card comes back
    r = await call('GET', '/api/rulings');
    assert.equal(r.json.rulings.length, 1); assert.deepEqual(r.json.rulings[0].covers, ['releasing someone']);
    r = await call('POST', '/api/rulings/' + r.json.rulings[0].id + '/remove', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call('GET', '/api/questions');
    assert.ok(r.json.questions.some(q => q.id === b.id), 'without the rule the card needs the owner again');
  });
});

test('the digest: the day\'s fyi notices as one card, deduped by key; project approve has a console control', async () => {
  const root = fixture();
  const now = Date.now();
  const rows = [{ at: new Date(now - 3600e3).toISOString(), kind: 'fyi', from: 'Boss', text: 'The weekly report went out.', key: 'report' },
    { at: new Date(now - 1800e3).toISOString(), kind: 'fyi', from: 'Boss', text: 'The weekly report went out again, fixed.', key: 'report', technical: 'report.js exit 0' },
    { at: new Date(now - 60e3).toISOString(), kind: 'fyi', from: 'Hal', text: 'Hal tidied the hiring notes.' },
    { at: new Date(now - 3 * 864e5).toISOString(), kind: 'fyi', from: 'Hal', text: 'Old news.' }];
  w(root, 'company/owner/digest.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  w(root, 'company/projects.json', { version: 1, projects: [{ id: 'shop-app', name: 'Shop App', state: 'requested', root: '/tmp/x', scope: 'the shop front' }] });
  await consoleOn(root, async call => {
    let r = await call('GET', '/api/digest');
    assert.equal(r.status, 200);
    assert.equal(r.json.title, 'What the crew did today');
    assert.deepEqual(r.json.items.map(x => x.text), ['The weekly report went out again, fixed.', 'Hal tidied the hiring notes.']);
    assert.equal(r.json.items[0].technical, 'report.js exit 0');
    r = await call('GET', '/api/today');
    assert.equal(r.json.digest.items.length, 2);
    r = await call('GET', '/api/projects');
    assert.equal(r.json.projects[0].state, 'requested');
    r = await call('POST', '/api/projects/shop-app/approve', {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p0 = JSON.parse(fs.readFileSync(path.join(root, 'company', 'projects.json'), 'utf8')).projects[0];
    assert.ok(['approved', 'active'].includes(p0.state) && p0.approvedBy, JSON.stringify(p0));
  });
});

test('effects are typed: one known key only; what yes does is described by the console, never by the asker', () => {
  const co = require(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
  const N = require(path.join(REPO, 'console', 'owner-needs.js')).make({ co });
  assert.equal(N.effectKind({ harnessApply: { id: 'hc-0001' } }), 'harnessApply');
  assert.equal(N.effectKind({ governance: { category: 'hiring', level: 'notify' } }), null, 'no tool files a governance effect');
  assert.equal(N.effectKind({ serviceApprove: {}, harnessApply: {} }), null, 'two effects in one: unknown');
  assert.equal(N.effectKind({ rm: true }), null);
  assert.equal(N.effectKind('governance'), null);
  assert.match(N.describeEffect({ serviceApprove: { name: 'feed' } }), /the background job called “feed”/);
  assert.match(N.describeEffect({ harnessApply: { id: 'hc-0012' } }), /the crew's change number 12\b/);
  assert.match(N.describeEffect({ launch: 1 }), /cannot apply this kind of change itself/);
  assert.equal(N.describeEffect({ none: true }), null);
});
