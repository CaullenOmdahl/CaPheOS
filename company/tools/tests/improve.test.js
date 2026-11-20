#!/usr/bin/env node
/* improve.test.js — the improvement engine's generators (lib/improve.js, docs/IMPROVE.md) on a fixture company, the
 * duty tools' --duty contract, and platform-setup.js plan.
 *
 *   node --test company/tools/tests/improve.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = path.resolve(__dirname, '..');
const I = require('../lib/improve');
const roots = [];
const tmp = p => { const d = require('../lib/temp-life').tmpDir(p); roots.push(d); return d; };
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };

const NOW = Date.parse('2026-11-20T10:00:00Z');   // a Friday
const stamp = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
function fixture(o) {
  const T = tmp('improve-fixture-');
  w(T, 'company/company.json', { name: 'Fixture', slug: 'fixture', owner: { name: 'Pat' }, timezone: 'UTC' });
  w(T, 'company/tools/loops.json', { agents: {
    agent: { name: 'Dee', title: 'CEO', functions: ['ceo'], role: 'agent.md' },
    engineer: { name: 'Nia', title: 'Tool Manager and Engineer', functions: ['tools'], role: 'company/roles/nia.md' },
    researcher: { name: 'Mo', title: 'Research Lead', role: 'company/roles/mo.md' },
    drafter: { name: 'Pia', title: 'Product Manager', role: 'company/roles/pia.md' },
    deployer: { name: 'Om', title: 'DevOps', role: 'company/roles/om.md' } } });
  if (o && o.platform) w(T, 'company/departments.json', { version: 1, departments: [{ id: 'platform', name: 'Platform (CaPheOS)', lead: 'engineer', members: ['engineer', 'deployer'] }] });
  const t = NOW - 30 * 60e3;
  w(T, 'company/work/dispatch-log.md', [
    '# Dispatch log', '',
    '- ' + stamp(NOW - 5 * 3600e3) + ' CONFIG ERROR old line, outside the window',
    '- ' + stamp(t) + ' CONFIG ERROR loops.json: seat x has no inbox',
    '- ' + stamp(t) + ' NO MODEL HOLD Security sweep for deployer: no model can run',
    '- ' + stamp(t) + ' RUN Engineering loop for engineer (duty:improve-health (health: CONFIG ERROR))',
    '- ' + stamp(t) + ' STALLED: the same work woke agent 3 times'].join('\n') + '\n');
  const run = (id, agent, x) => JSON.stringify(Object.assign({ runId: id, agentId: agent, reason: 'done', tokens: 1000, cachedTokens: 0, artifacts: [], toolTrace: [], endedAt: t }, x || {}));
  const rows = [
    run('r1', 'engineer', { reason: 'error', failureCode: 'spend_history_unavailable' }),
    run('r2', 'engineer', { tokens: 3e6, cachedTokens: 0 }),
    run('r3', 'deployer', { toolTrace: [{ name: 'shell_exec', ok: false, isError: true }, { name: 'shell_exec', ok: false }, { name: 'shell_exec', isError: true }] }),
  ];
  for (let i = 0; i < 6; i++) rows.push(run('idle' + i, 'researcher'));
  rows.push(run('old', 'researcher', { endedAt: NOW - 3 * 86400e3, tokens: 10 }));
  w(T, '.starnet-data/workspaces/runs.jsonl', rows.sort((a, b) => JSON.parse(a).endedAt - JSON.parse(b).endedAt).join('\n') + '\n');
  w(T, 'company/owner/outbound.jsonl', [
    JSON.stringify({ id: 'out-1', at: new Date(t).toISOString(), from: 'Dee', text: 'The API endpoint returned a CVE in the token.' }),
    JSON.stringify({ id: 'out-2', at: new Date(t).toISOString(), from: 'Dee', text: 'Everything is fine today.' })].join('\n') + '\n');
  w(T, 'company/work/framework-requests/fr-0001.md', '# Framework change request fr-0001\n\n- File: x\n');
  w(T, 'company/work/framework-requests/fr-0002.md', '# Framework change request fr-0002\n\n**State:** triaged reject\n');
  return T;
}

test('health: dispatch-log codes in the window, failed runs, tool errors; run lines and old lines ignored', () => {
  const T = fixture({ platform: true });
  const r = I.health({ root: T, now: NOW });
  const ids = r.items.map(i => i.id);
  assert.ok(ids.some(i => i.startsWith('health:log:config-error:')), ids.join());
  assert.ok(ids.includes('health:log:no-model:deployer'), ids.join());
  assert.ok(ids.includes('health:log:stalled:agent'), ids.join());
  assert.ok(ids.includes('health:run:spend_history_unavailable:engineer'), ids.join());
  assert.ok(ids.includes('health:tool:shell_exec:deployer'), ids.join());
  assert.equal(ids.filter(i => i.startsWith('health:log:config-error')).length, 1, 'the old line and the RUN line are not findings');
  assert.equal(r.route, 'engineer', 'the platform lead');
  assert.ok(r.reason.length <= 300);
  assert.deepEqual(I.health({ root: T, now: NOW }).key, r.key, 'same findings, same key');
});

test('health: crashloop counts restarts the station made, not lines that mention one', () => {
  const t = stamp(NOW - 30 * 60e3);
  const logWith = lines => { const T = fixture(); fs.appendFileSync(path.join(T, 'company/work/dispatch-log.md'), lines.map(l => '- ' + t + ' ' + l + '\n').join('')); return I.health({ root: T, now: NOW }).items.map(i => i.id); };
  const real = 'Station restarted to load patch 0001 at 05:57; no run was interrupted (scripts/restart-station.sh by owner)';
  // one restart, one wait line, one quoted handoff title: three matches under a loose pattern
  const one = logWith([real,
    'RESTART WAITING (patch 0001): Waiting for a seat to end before restarting the station to load patch 0001; the crew keeps working meanwhile.',
    'WAITING ON UNRESOLVED to-engineer.md "a station restart kills every job" (a seat): job: x names nothing']);
  assert.ok(!one.includes('health:crashloop:station'), 'one restart plus two mentions is not a crash loop: ' + one.join());
  const three = logWith([real, real, real]);
  assert.ok(three.includes('health:crashloop:station'), 'three restarts in the window still raise it: ' + three.join());
});

test('efficiency: big runs, idle wakes, spikes', () => {
  const T = fixture();
  const r = I.efficiency({ root: T, now: NOW });
  const ids = r.items.map(i => i.id);
  assert.ok(ids.includes('eff:big:engineer:2026-11-20'), ids.join());
  assert.ok(ids.includes('eff:idle:researcher:2026-11-20'), ids.join());
  assert.equal(r.route, 'tools', 'no platform department: the tools function');
});

test('owner experience: jargon in an owner message to the product seat; plain ones pass', () => {
  const T = fixture();
  const r = I.ownerExperience({ root: T, now: NOW });
  assert.deepEqual(r.items.map(i => i.id), ['ux:jargon:out-1']);
  assert.equal(r.route, 'drafter');
});

test('framework requests: only those with no State line, and only with a platform department', () => {
  assert.equal(I.frameworkRequests({ root: fixture() }), null);
  const r = I.frameworkRequests({ root: fixture({ platform: true }) });
  assert.deepEqual(r.items.map(i => i.id), ['fr:fr-0001']);
  assert.equal(r.route, 'engineer');
});

test('weekly research and retro: due until their file exists; retro only Friday onward', () => {
  const T = fixture();
  const wk = I.isoWeek('2026-11-20');
  assert.equal(wk, '2026-W47');
  assert.equal(I.isoWeek('2026-01-01'), '2026-W01');
  assert.equal(I.isoWeek('2027-01-01'), '2026-W53');
  const r = I.research({ root: T, now: NOW });
  assert.equal(r.route, 'researcher'); assert.equal(r.items[0].id, 'research:' + wk);
  assert.equal(I.retro({ root: T, now: NOW }).route, 'ceo');
  assert.equal(I.retro({ root: T, now: Date.parse('2026-11-18T10:00:00Z') }), null, 'Wednesday: no retro yet');
  w(T, 'company/work/research/ideas-' + wk + '.md', 'cards');
  w(T, 'company/work/retro/retro-' + wk + '.md', 'retro');
  assert.equal(I.research({ root: T, now: NOW }), null);
  assert.equal(I.retro({ root: T, now: NOW }), null);
});

test('the duty tools follow the --duty contract and change no file', () => {
  const T = fixture({ platform: true });
  const before = JSON.stringify(fs.readdirSync(T, { recursive: true }).sort());
  for (const f of ['improve-health.js', 'improve-efficiency.js', 'improve-owner.js', 'improve-framework-requests.js', 'improve-research.js', 'improve-retro.js']) {
    const r = spawnSync(process.execPath, [path.join(TOOLS, f), '--duty'], { cwd: T, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: T, CAPHEOS_ROOT: T, CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1' } });
    assert.ok(r.status === 0 || r.status === 1, f + ' exit ' + r.status + ' ' + r.stderr);
    if (r.status === 1) { const j = JSON.parse(r.stdout); assert.equal(j.due, true); assert.ok(j.key && j.reason, f); }
  }
  assert.equal(JSON.stringify(fs.readdirSync(T, { recursive: true }).sort()), before);
});

test('platform-setup plan: department, members, dev checkout, role notes; skips what is done', () => {
  const P = require('../platform-setup.js');
  const T = fixture();
  let s = P.steps({ root: T, lead: 'engineer', members: ['deployer', 'nobody'], repo: 'x', skip: [] });
  const txt = s.map(P.show).join('\n');
  assert.match(txt, /departments\.js create platform/);
  assert.match(txt, /add-member platform deployer/);
  assert.match(txt, /member nobody is not on the crew/);
  assert.match(txt, /git clone x/);
  assert.match(txt, /nia\.md \(as lead\)/);
  const T2 = fixture({ platform: true });
  w(T2, 'company/roles/nia.md', '# Nia\n\n## CaPheOS\nalready\n');
  s = P.steps({ root: T2, lead: 'engineer', members: ['deployer'], repo: 'x', skip: [] });
  assert.ok(!s.some(x => x.kind === 'run'), 'department and member already there');
  assert.ok(!s.some(x => x.kind === 'role' && x.seat === 'engineer'), 'the lead already has the section');
  const sec = P.roleSection(path.join(TOOLS, '..', 'runbooks', 'capheos-platform-role.md'), true);
  assert.match(sec, /^\n## CaPheOS/); assert.match(sec, /You lead the platform department/); assert.ok(!/\{\{ROLE\}\}/.test(sec));
});
