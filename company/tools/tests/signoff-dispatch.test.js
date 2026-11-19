#!/usr/bin/env node
/* signoff-dispatch.test.js — a counterpart's sign-off, enforced by the real dispatch.js against tests/mock-station.js
 * (docs/PROFILES.md "Sign-off"; the harness of consult-dispatch.test.js). Fixture crew:
 *   agent Alex (CEO)   ben Noah (scout: eager; counterpart Ravi, signs off promote and external)
 *   ravi Ravi (tester: Noah's counterpart)   dana Dana (builder: receives Noah's handoff)
 *   live     Noah's block to Dana with **Needs sign-off:** promote is held (Dana is not woken), Ravi gets exactly one
 *            sign-off item (a second tick adds none); a yes releases it on the next tick; a no keeps it held and writes the
 *            reasons to Noah's inbox
 *   shadow   nothing is held (Dana is woken) and WOULD HOLD is logged
 *   CLI      the asker cannot answer its own sign-off, a seat that is not the counterpart cannot either; the CEO's
 *            override is recorded and releases it
 *   gates    external-gate.js refuses in live without a yes and acts after one; merge-gate.js asks lib/signoff.js gate
 *   node --test company/tools/tests/signoff-dispatch.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const DISPATCH = path.join(TOOLS, 'dispatch.js');
const MOCK = path.join(REPO, 'tests', 'mock-station.js');
const P = require(path.join(TOOLS, 'lib', 'profile.js'));
const MIN = 60e3;
const TOKEN = 'signoff-test-token';
const TZ = (() => { const h = new Date().getUTCHours(); const off = ((2 - h + 36) % 24) - 12; return off === 0 ? 'UTC' : off > 0 ? 'Etc/GMT-' + off : 'Etc/GMT+' + (-off); })();

const SEATS = {
  agent: { name: 'Alex', functions: ['ceo', 'people'], loop: 'Founder loop', inbox: 'to-founder.md', wakeOnInbox: true, priority: 100, manager: null },
  ben: { name: 'Noah', loop: 'Noah loop', inbox: 'to-noah.md', manager: 'agent' },
  ravi: { name: 'Ravi', loop: 'Ravi loop', inbox: 'to-ravi.md', manager: 'agent' },
  dana: { name: 'Dana', loop: 'Dana loop', inbox: 'to-dana.md', manager: 'agent' },
};
const HANDOFF = '\n## 2026-11-17 from Noah — build the weather-market idea\n**Id:** dana-1\n**Need:** build the small test from the card\n**Needs sign-off:** promote\n**Status:** OPEN\n';
function profile(seat, name, arch, cp) {
  const p = P.blank(seat, { name, title: arch }); p.identity.archetype = arch;
  if (cp) p.counterpart = { seat: cp, signOff: ['promote', 'external'], why: 'tests every card' };
  p.examples = [{ with: 'owner', they: 'a', you: 'b', pushback: true }, { with: 'owner', they: 'c', you: 'd' }, { with: 'owner', they: 'e', you: 'f' }];
  p.hash = P.hashOf(p); return p;
}

let mock = null, port = 0;
const roots = [];
test.before(async () => {
  const log = path.join(__LIFE.tmpDir('signoff-mock-'), 'req.jsonl'); roots.push(path.dirname(log));
  mock = spawn(process.execPath, [MOCK, '--port', '0', '--token', TOKEN, '--log', log], { stdio: ['ignore', 'pipe', 'inherit'] });
  port = await new Promise((res, rej) => { let d = ''; mock.stdout.on('data', c => { d += c; const m = /"port":(\d+)/.exec(d); if (m) res(Number(m[1])); }); mock.on('exit', c => rej(new Error('mock exited ' + c))); });
  for (const bad of [8800, 8810, 8900, 8910]) assert.notEqual(port, bad);
  mock.logFile = log;
});
test.after(() => { try { mock.kill(); } catch (_) {} for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

async function st(method, p, body) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { 'x-starnet-token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}
const reqs = () => fs.readFileSync(mock.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

async function company(o) {
  o = o || {};
  const T = __LIFE.tmpDir('signoff-co-'); roots.push(T);
  const w = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); };
  w('company/company.json', { name: 'Signoff Test ' + path.basename(T), owner: { name: 'Pat' }, timezone: TZ, station: { port, serviceName: 'signoff-test' } });
  w('secrets/station-token', TOKEN + '\n');
  const cad = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'cadence.json'), 'utf8'));
  cad.tempo.sprint = { on: false };
  w('company/work/ops/cadence.json', cad);
  w('company/work/finance/dispatch-budget.json', { dailyUsd: 1, perAgentUsd: 0, unmeteredProviders: ['claude-cli'] });
  w('company/state/governance.json', { categories: {} });
  w('company/state/guardrails.json', { guards: { externalActions: false } });
  w('company/owner/inbound.jsonl', '');
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  w('.starnet-data/workspaces/runs.jsonl', '');
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/people/profile-policy.json', { signoff: { mode: o.mode || 'live', holdMaxHours: 24, ceoOverride: true } });
  w('company/people/profiles/ben.json', profile('ben', 'Noah', 'scout', 'ravi'));
  w('company/people/profiles/ravi.json', profile('ravi', 'Ravi', 'tester', null));
  for (const s of Object.values(SEATS)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n' + (s.inbox === 'to-dana.md' ? HANDOFF : ''));
  const agents = {}, ids = {};
  for (const [id, s] of Object.entries(SEATS)) {
    const name = s.loop + ' ' + path.basename(T);
    const r = await st('POST', '/api/cron', { name, agentId: id, prompt: 'Read company/work/handoffs/' + s.inbox + '.', provider: 'claude-cli', model: 'haiku', schedule: 'every 2h', workdir: T });
    ids[id] = r.job.id;
    await st('POST', '/api/cron/update', { id: r.job.id, patch: { lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false } });
    agents[id] = Object.assign({}, s, { loop: name });
  }
  w('company/tools/loops.json', { agents });
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_TZ: TZ, DISPATCH_SPRINT_RESOLVE_SEC: '0', DISPATCH_HIRING_TIMEOUT_SEC: '30', DISPATCH_NO_SYSTEMCTL: '1', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), DISPATCH_COOLDOWN_MIN: '', DISPATCH_MAX_PER_TICK: '', PROFILE_NO_SYNC: '1' });
  const c = { T, ids, env, w, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
  c.jsonl = rel => c.r(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
  c.cli = argv => { const p = spawnSync(process.execPath, [path.join(TOOLS, 'approvals.js')].concat(argv), { cwd: T, encoding: 'utf8', env }); let j = null; try { j = JSON.parse(p.stdout); } catch (_) {} return { code: p.status, out: j, raw: p.stdout + p.stderr }; };
  c.tick = async () => {
    // a woken seat's loop is idle again before the next tick (the mock leaves a started run in flight)
    for (const id of Object.values(ids)) await st('POST', '/api/cron/update', { id, patch: { lastRunAt: new Date(Date.now() - 600 * MIN).toISOString(), inFlight: false } });
    const before = reqs().length;
    const p = spawnSync(process.execPath, [DISPATCH], { cwd: T, encoding: 'utf8', timeout: 170000, env });
    const runs = reqs().slice(before).filter(r => r.path === '/api/cron/run' && r.method === 'POST').map(r => r.body);
    const bySeat = {}; for (const b of runs) { const k = Object.keys(ids).find(x => ids[x] === b.id); if (k) bySeat[k] = b; }
    return { code: p.status, out: (p.stdout || '') + (p.stderr || ''), bySeat, log: c.r('company/work/dispatch-log.md') };
  };
  c.items = inbox => (c.r('company/work/handoffs/' + inbox).match(/^## .*Sign-off: /gm) || []).length;
  return c;
}

test('live: the held block, one sign-off item, a yes releases it on the next tick; the wake records the profile version', async () => {
  const c = await company();
  const r = await c.tick();
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.bySeat.dana, 'Dana is not woken for a block that waits on Ravi\'s sign-off: ' + r.log.slice(-2000));
  assert.equal(c.items('to-ravi.md'), 1, 'Ravi gets exactly one sign-off item');
  assert.match(c.r('company/work/handoffs/to-ravi.md'), /\*\*Sign-off:\*\* so-[0-9a-f]{8}[\s\S]*Noah wants to move an idea or card to a test or a build/);
  const asks = c.jsonl('company/state/signoffs.jsonl').filter(x => x.op === 'ask');
  assert.equal(asks.length, 1); assert.equal(asks[0].from, 'ben'); assert.equal(asks[0].counterpart, 'ravi'); assert.equal(asks[0].kind, 'promote'); assert.equal(asks[0].ref, 'to-dana.md#dana-1');
  assert.match(r.log, /HOLD sign-off promote to-dana\.md#dana-1/);
  const parked = JSON.parse(c.r('company/state/parked.json')).items;
  assert.ok(parked.some(x => x.seat === 'dana' && x.kind === 'signoff' && /Ravi/.test(x.words)), JSON.stringify(parked));
  const r2 = await c.tick();
  assert.ok(!r2.bySeat.dana); assert.equal(c.items('to-ravi.md'), 1, 'a second tick adds no second item');
  assert.equal(c.jsonl('company/state/signoffs.jsonl').filter(x => x.op === 'ask').length, 1);
  // Noah cannot answer his own request; Dana (not the counterpart) cannot either
  assert.equal(c.cli(['signoff', 'answer', asks[0].id, '--verdict', 'yes', '--check', 'looks fine', '--by', 'Noah']).code, 2);
  const dv = c.cli(['signoff', 'answer', asks[0].id, '--verdict', 'yes', '--check', 'fine', '--by', 'Dana']); assert.equal(dv.code, 2); assert.match(dv.out.error, /only Ravi/);
  const yes = c.cli(['signoff', 'answer', asks[0].id, '--verdict', 'yes', '--check', 'the card has a one-day test and a kill line', '--by', 'Ravi']);
  assert.equal(yes.code, 0, yes.raw);
  assert.match(c.r('company/work/handoffs/to-ravi.md'), /\*\*Status:\*\* DONE — answered yes by Ravi/);
  const r3 = await c.tick();
  assert.ok(r3.bySeat.dana, 'a yes releases the block on the next tick: ' + r3.log.slice(-1500));
  const wk = c.jsonl('company/state/wakes.jsonl').filter(x => x.seat === 'ben' || x.seat === 'ravi').concat(c.jsonl('company/state/wakes.jsonl').filter(x => x.seat === 'dana'));
  assert.ok(c.jsonl('company/state/wakes.jsonl').some(x => x.seat === 'ravi' && x.profile && x.profile.version === 1 && /^[0-9a-f]{12}$/.test(x.profile.hash)), 'the wake row carries the woken seat\'s profile: ' + JSON.stringify(wk));
  assert.ok(c.jsonl('company/state/wakes.jsonl').filter(x => x.seat === 'dana').every(x => !x.profile), 'a seat with no profile has none');
});

test('live: a no keeps the block held and writes the reasons back to the asker; the CEO\'s override is recorded and releases it', async () => {
  const c = await company();
  await c.tick();
  const id = c.jsonl('company/state/signoffs.jsonl').find(x => x.op === 'ask').id;
  assert.equal(c.cli(['signoff', 'answer', id, '--verdict', 'no', '--check', 'read the card', '--by', 'Ravi']).code, 2, 'a no needs reasons');
  assert.equal(c.cli(['signoff', 'answer', id, '--verdict', 'no', '--check', 'read the card', '--reasons', 'no kill line; add one and the fee check', '--by', 'Ravi']).code, 0);
  assert.match(c.r('company/work/handoffs/to-noah.md'), /Ravi did not sign off to-dana\.md#dana-1: no kill line; add one and the fee check/);
  const r = await c.tick();
  assert.ok(!r.bySeat.dana, 'a no keeps it held');
  assert.equal(c.cli(['signoff', 'override', id, '--by', 'Ravi', '--why', 'I changed my mind']).code, 2, 'only the CEO overrides');
  const ov = c.cli(['signoff', 'override', id, '--by', 'Alex', '--why', 'the owner wants this test this week']);
  assert.equal(ov.code, 0, ov.raw);
  const row = c.jsonl('company/state/signoffs.jsonl').find(x => x.op === 'override');
  assert.equal(row.by, 'agent'); assert.match(row.why, /owner wants/);
  const r2 = await c.tick();
  assert.ok(r2.bySeat.dana, 'the override releases it');
  const list = c.cli(['signoff', 'list']).out.signoffs;
  assert.equal(list[0].status, 'overridden');
});

test('shadow: nothing is held, WOULD HOLD is logged once, no sign-off record is made', async () => {
  const c = await company({ mode: 'shadow' });
  const r = await c.tick();
  assert.ok(r.bySeat.dana, 'shadow holds nothing');
  assert.match(r.log, /WOULD HOLD sign-off promote to-dana\.md#dana-1/);
  assert.equal(c.items('to-ravi.md'), 0);
  assert.equal(c.r('company/state/signoffs.jsonl'), '');
  await c.tick();
  assert.equal((c.r('company/work/dispatch-log.md').match(/WOULD HOLD sign-off/g) || []).length, 1, 'logged once per block');
});

test('gates: external-gate refuses Noah\'s act in live without a yes, acts after one; shadow records the would-refuse; merge-gate asks the same', async () => {
  const c = await company();
  const check = () => { const p = spawnSync(process.execPath, [path.join(TOOLS, 'external-gate.js'), 'check', '--category', 'message', '--target', 'email:someone@example.com', '--agent', 'ben'], { cwd: c.T, encoding: 'utf8', env: c.env }); return { code: p.status, out: p.stdout + p.stderr }; };
  const no = check();
  assert.equal(no.code, 3, no.out); assert.match(no.out, /counterpart sign-off/);
  const other = spawnSync(process.execPath, [path.join(TOOLS, 'external-gate.js'), 'check', '--category', 'message', '--target', 'email:someone@example.com', '--agent', 'dana'], { cwd: c.T, encoding: 'utf8', env: c.env });
  assert.equal(other.status, 0, 'a seat whose profile lists nothing is not affected (the guardrail is off in this fixture)');
  const ask = c.cli(['signoff', 'ask', '--kind', 'external', '--ref', 'ext:email:someone@example.com', '--by', 'Noah']);
  assert.equal(ask.code, 0, ask.raw);
  assert.equal(c.cli(['signoff', 'answer', ask.out.id, '--verdict', 'yes', '--check', 'the message is plain and true', '--by', 'Ravi']).code, 0);
  assert.equal(check().code, 0, 'acts after the yes');
  // the yes is for that target only: naming it (by id or by ref) never clears another target; the id form works
  const wire = (extra, env) => spawnSync(process.execPath, [path.join(TOOLS, 'external-gate.js'), 'check', '--category', 'message', '--target', 'wire-money-to-vendor'].concat(extra), { cwd: c.T, encoding: 'utf8', env: env || c.env });
  assert.equal(wire(['--agent', 'ben', '--signoff', 'ext:email:someone@example.com']).status, 3, 'a yes for another target named as --signoff does not clear this one');
  assert.equal(wire(['--agent', 'ben', '--signoff', ask.out.id]).status, 3, 'a sign-off id for another target does not clear this one');
  const wa = c.cli(['signoff', 'ask', '--kind', 'external', '--ref', 'ext:wire-money-to-vendor', '--by', 'Noah']);
  c.cli(['signoff', 'answer', wa.out.id, '--verdict', 'yes', '--check', 'the invoice matches the order', '--by', 'Ravi']);
  assert.equal(wire(['--agent', 'ben', '--signoff', wa.out.id]).status, 0, 'the documented form --signoff so-<id> works for its own target');
  // inside an agent's run --agent cannot name another seat: the station's own id decides
  const c2 = c.cli(['signoff', 'ask', '--kind', 'external', '--ref', 'ext:post-blog-draft', '--by', 'Noah']);
  const blog = env => spawnSync(process.execPath, [path.join(TOOLS, 'external-gate.js'), 'check', '--category', 'message', '--target', 'post-to-forum', '--agent', 'dana'], { cwd: c.T, encoding: 'utf8', env });
  assert.equal(blog(Object.assign({}, c.env, { STARNET_AGENT_ID: 'ben' })).status, 3, 'Noah\'s run passing --agent dana is still checked as Noah');
  assert.ok(c2.out.id);
  // shadow: allowed, the would-refuse recorded
  c.w('company/people/profile-policy.json', { signoff: { mode: 'shadow' } });
  const sh = spawnSync(process.execPath, [path.join(TOOLS, 'external-gate.js'), 'check', '--category', 'message', '--target', 'email:else@example.com', '--agent', 'ben'], { cwd: c.T, encoding: 'utf8', env: c.env });
  assert.equal(sh.status, 0);
  assert.ok(c.jsonl('company/state/signoff-gates.jsonl').some(x => x.seat === 'ben' && x.kind === 'external' && x.would === 'refuse'));
  // merge: the gate's call (merge-gate.js runs gh, so its decision is checked through the same library call it makes)
  const src = fs.readFileSync(path.join(TOOLS, 'merge-gate.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/signoff'\)\.gate\(\{ seat: presenter\(\)\.agent, kind: 'merge', refs: \['pr:' \+ repo \+ '#' \+ h\.pr\], sha: h\.sha/);
  c.w('company/people/profiles/ben.json', Object.assign(profile('ben', 'Noah', 'scout', 'ravi'), { counterpart: { seat: 'ravi', signOff: ['merge'], why: 'x' } }));
  c.w('company/people/profile-policy.json', { signoff: { mode: 'live' } });
  const gate = sha => JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(path.join(TOOLS, 'lib', 'signoff.js')) + ').gate({ seat: "ben", kind: "merge", refs: ["https://github.com/acme/shop/pull/12"], sha: ' + JSON.stringify(sha || '') + ' })))'], { cwd: c.T, encoding: 'utf8', env: c.env }).stdout);
  assert.ok(gate('abcdef1234567').refuse, 'live: no yes for the PR refuses');
  const a2 = c.cli(['signoff', 'ask', '--kind', 'merge', '--ref', 'pr:acme/shop#12', '--by', 'Noah']);
  const noSha = c.cli(['signoff', 'answer', a2.out.id, '--verdict', 'yes', '--check', 'premerge passed and I read the diff', '--by', 'Ravi']);
  assert.equal(noSha.code, 2, 'a yes to a pull request names the commit it checked'); assert.match(noSha.raw, /--sha/);
  c.cli(['signoff', 'answer', a2.out.id, '--verdict', 'yes', '--check', 'premerge passed and I read the diff', '--sha', 'abcdef1234567', '--by', 'Ravi']);
  assert.equal(gate('abcdef1234567890').cleared, true, 'the yes for pr:acme/shop#12 at that commit clears the URL form of the same PR');
  const later = gate('0123456789abcdef');
  assert.ok(later.refuse && /earlier one/.test(later.refuse), 'a commit pushed after the yes needs a new yes: ' + JSON.stringify(later));
});
