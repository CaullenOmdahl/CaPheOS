#!/usr/bin/env node
/* routing-controls.test.js — the owner's routing switches (company/tools/routing.js, console/routing.js; docs/ROUTING.md), on a
 * fixture company: Boss (CEO), Hal (the people function), Kim and Lee (engineers in the eng department).
 * Each case runs the tool in a child process with CAPHEOS_ROOT at a fresh fixture and pins "is this the owner's shell"
 * in that process (provenance.pinOwnerShell). The last case starts the real console server on a free loopback port
 * (with a fake station on another) and drives the owner's buttons through HTTP: the console's owner path end to end.
 *
 *   node --test company/tools/tests/routing-controls.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const POLICY = 'company/work/models/routing-policy.json';
const LOG = 'company/work/models/routing-log.jsonl';
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const read = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };
const lines = (root, rel) => (read(root, rel) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));

const CREW = {
  boss: { name: 'Boss', title: 'CEO', functions: ['ceo'], manager: null, inbox: 'to-boss.md' },
  hal: { name: 'Hal', title: 'People', functions: ['people'], manager: 'boss', inbox: 'to-hal.md' },
  kim: { name: 'Kim', title: 'Engineer', manager: 'boss', inbox: 'to-kim.md' },
  lee: { name: 'Lee', title: 'Engineer', manager: 'kim', inbox: 'to-lee.md' },
};
const DEPTS = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: 'kim', members: ['kim', 'lee'], defaultClass: 'code', routes: {}, consult: {} }] };
const MODEL_POLICY = { allowed: {
  'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2[1m]'] },
  custom: { models: ['MiniMax-M3.1-Pro', 'MiniMax-M3.1-Flash'] },
  deepseek: { models: ['deepseek-flash'] } } };

function fixture(o) {
  const root = require('../lib/temp-life').tmpDir('routing-test-'); roots.push(root);
  if (o && o.full) {   // the whole framework (the console server needs it), then the fixture's own files on top
    fs.cpSync(path.join(REPO, 'company'), path.join(root, 'company'), { recursive: true, filter: s => !/[\/\\]\.starnet-data([\/\\]|$)/.test(s) });
    fs.cpSync(path.join(REPO, 'console'), path.join(root, 'console'), { recursive: true });
    for (const f of ['company/state/locked/provenance.jsonl', 'company/state/wakes.jsonl', POLICY, LOG]) try { fs.rmSync(path.join(root, f)); } catch (_) {}
  }
  w(root, 'company/company.json', { name: 'Fixture Co', slug: 'fixture-co', timezone: 'UTC', owner: { name: 'Olive', addressAs: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
  w(root, 'company/tools/loops.json', { agents: CREW });
  w(root, 'company/departments.json', DEPTS);
  w(root, 'company/model-policy.json', MODEL_POLICY);
  const def = 'company/defaults/work/models/routing-policy.json';
  w(root, def, fs.readFileSync(path.join(REPO, def), 'utf8'));
  w(root, 'company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n\n');
  return root;
}
function tool(root, argv, o) {
  o = o || {};
  const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    (o.pre || '') + 'const r = require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_READONLY: '' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  return JSON.parse(r.stdout);
}
const CREATE = ['trial', 'create', 'code-cmp', '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5@high', '--arm', 'claude-cli/claude-opus-5-5@medium', '--scope-dept', 'eng'];

test('owner-only actions are refused for a seat, and for "--by owner" outside the owner\'s shell or console', () => {
  const root = fixture();
  for (const argv of [['mode', 'live', '--by', 'Hal'], ['tiercaps', 'live', '--by', 'Boss'], ['trial', 'start', 'x', '--by', 'Hal'], ['trial', 'stop', 'x', '--by', 'Kim']]) {
    const r = tool(root, argv);
    assert.equal(r.code, 2, argv.join(' ')); assert.match(r.out.error, /owner's decision/);
  }
  const fake = tool(root, ['mode', 'live', '--by', 'owner'], { owner: false });
  assert.equal(fake.code, 2); assert.match(fake.out.error, /owner's own interactive shell or the console/);
  assert.equal(read(root, POLICY), null, 'nothing was written');
  // the owner, from the owner's shell
  const ok = tool(root, ['mode', 'live', '--by', 'Olive', '--why', 'ready to apply'], { owner: true });
  assert.equal(ok.code, 0, JSON.stringify(ok.out)); assert.equal(ok.out.changed, true); assert.equal(ok.out.created, true);
  const doc = JSON.parse(read(root, POLICY));
  assert.equal(doc.mode, 'live'); assert.equal(doc.tierCaps.mode, 'shadow', 'the tier caps keep their own mode');
  assert.ok(doc._doc && doc.classRules.code.denyProviders.includes('custom'), 'created from the framework default');
  assert.deepEqual(lines(root, LOG).map(r => [r.op, r.from, r.to, r.by]), [['mode', 'shadow', 'live', 'owner']]);
  assert.match(read(root, 'company/work/decisions.md'), /Model routing: the routing mode shadow -> live.*Why: ready to apply/);
  const prov = lines(root, 'company/state/locked/provenance.jsonl');
  assert.ok(prov.some(p => p.writer === 'routing.js' && p.file === POLICY), 'the write is recorded for locked-watch');
  assert.equal(tool(root, ['mode', 'live', '--by', 'owner'], { owner: true }).out.changed, false, 'the same mode again changes nothing');
  assert.equal(tool(root, ['mode', 'fast', '--by', 'owner'], { owner: true }).code, 2, 'an unknown mode is refused');
});

test('the people function drafts a trial; another seat may not; only the owner starts it', () => {
  const root = fixture();
  assert.equal(tool(root, CREATE.concat(['--by', 'Kim'])).code, 2, 'a seat without the people function is refused');
  assert.equal(read(root, POLICY), null);
  const r = tool(root, CREATE.concat(['--entry-share', '0.2', '--min-items', '25', '--by', 'Hal', '--why', 'bigger model at lower effort']));
  assert.equal(r.code, 0, JSON.stringify(r.out));
  const t = JSON.parse(read(root, POLICY)).trials.find(x => x.id === 'code-cmp');
  assert.deepEqual([t.status, t.class, t.entryShare, t.minItemsPerArm, t.createdBy, t.arms.length, t.scope.departments, t.pauseWhenHeld], ['draft', 'code', 0.2, 25, 'Hal', 2, ['eng'], ['claude-cli']]);
  assert.deepEqual(t.arms[0], { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' });
  assert.equal(lines(root, LOG).pop().op, 'trial-create');
  assert.match(read(root, 'company/work/decisions.md'), /Hal \[d-[0-9a-f]{6}\] Model routing: draft trial code-cmp/);
  // Hal cannot start it; the owner can; the transitions are checked
  assert.equal(tool(root, ['trial', 'start', 'code-cmp', '--by', 'Hal']).code, 2);
  assert.equal(tool(root, ['trial', 'resume', 'code-cmp', '--by', 'owner'], { owner: true }).code, 2, 'a draft cannot be resumed');
  const s = tool(root, ['trial', 'start', 'code-cmp', '--by', 'owner'], { owner: true });
  assert.equal(s.code, 0, JSON.stringify(s.out)); assert.match(s.out.summary, /routing is shadow, so its arms are recorded, not applied/);
  const p = tool(root, ['trial', 'pause', 'code-cmp', '--by', 'owner', '--why', 'window tight'], { owner: true });
  assert.equal(p.code, 0);
  const st = tool(root, ['status', '--json']).out.trials[0];
  assert.equal(st.status, 'paused'); assert.match(st.reasons[0], /paused by owner.*window tight/);
  assert.equal(tool(root, ['trial', 'resume', 'code-cmp', '--by', 'owner'], { owner: true }).out.trial.status, 'running');
  assert.equal(tool(root, ['trial', 'stop', 'code-cmp', '--by', 'owner'], { owner: true }).out.trial.status, 'done');
  assert.equal(tool(root, ['trial', 'start', 'code-cmp', '--by', 'owner'], { owner: true }).code, 2, 'a finished trial does not start again');
  assert.deepEqual(lines(root, LOG).map(r => r.op), ['trial-create', 'trial-start', 'trial-pause', 'trial-resume', 'trial-stop']);
  // the owner may draft too
  assert.equal(tool(root, ['trial', 'create', 'rs-cmp', '--class', 'research', '--arm', 'deepseek/deepseek-flash', '--arm', 'custom/MiniMax-M3.1-Pro', '--scope-seat', 'lee', '--by', 'owner'], { owner: true }).code, 0);
});

test('validation refusals: unknown model, a code trial with a MiniMax-plan arm, no arms, a duplicate id (nothing written)', () => {
  const root = fixture();
  assert.equal(tool(root, CREATE.concat(['--by', 'Hal'])).code, 0);
  const before = read(root, POLICY), logBefore = read(root, LOG);
  const cases = [
    [['trial', 'create', 'a1', '--class', 'code', '--arm', 'claude-cli/gpt-9@high', '--arm', 'claude-cli/claude-sonnet-5-5', '--scope-dept', 'eng'], /gpt-9 is not an allowed claude-cli model/],
    [['trial', 'create', 'a2', '--class', 'code', '--arm', 'openai/gpt-9', '--arm', 'claude-cli/claude-sonnet-5-5', '--scope-dept', 'eng'], /provider openai is not allowed/],
    [['trial', 'create', 'a3', '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5', '--arm', 'custom/MiniMax-M3.1-Pro', '--scope-dept', 'eng'], /code work may not run on custom \(the MiniMax plan\).*owner ruling/],
    [['trial', 'create', 'a4', '--class', 'code', '--scope-dept', 'eng'], /needs arms/],
    [CREATE.slice(), /exists already/],
    [['trial', 'create', 'a5', '--class', 'code', '--arm', 'claude-cli/haiku@turbo', '--arm', 'claude-cli/claude-sonnet-5-5', '--scope-dept', 'eng'], /effort must be one of/],
    [['trial', 'create', 'a6', '--class', 'code', '--arm', 'claude-cli/haiku', '--arm', 'claude-cli/claude-sonnet-5-5', '--scope-dept', 'ops'], /no department "ops"/],
    [['trial', 'create', 'a7', '--class', 'code', '--arm', 'claude-cli/haiku', '--arm', 'claude-cli/haiku', '--scope-dept', 'eng'], /listed twice/],
    [['trial', 'create', 'a8', '--class', 'juggling', '--arm', 'claude-cli/haiku', '--arm', 'claude-cli/claude-sonnet-5-5', '--scope-dept', 'eng'], /--class must be one of/],
  ];
  for (const [argv, re] of cases) {
    const r = tool(root, argv.concat(['--by', 'Hal']));
    assert.equal(r.code, 2, argv.join(' ')); assert.match(r.out.error, re);
  }
  assert.equal(read(root, POLICY), before, 'a refused draft writes nothing');
  assert.equal(read(root, LOG), logBefore);
});

test('status: arm counts from wakes.jsonl route fields (applied and shadow, items once per arm), hold reasons, the last 20 log rows', () => {
  const root = fixture();
  assert.equal(tool(root, CREATE.concat(['--min-items', '2', '--by', 'Hal'])).code, 0);
  assert.equal(tool(root, ['trial', 'start', 'code-cmp', '--by', 'owner'], { owner: true }).code, 0);
  const started = Date.parse(JSON.parse(read(root, POLICY)).trials[0].startedAt);
  const row = (dt, items, route) => ({ at: started + dt, ts: new Date(started + dt).toISOString(), wakeId: 'wk-' + dt, seat: 'lee', items: items.map(id => ({ file: 'to-lee.md', id, title: id })), why: 'work', route });
  const rows = [
    row(-60e3, ['old'], { source: 'trial', trial: 'code-cmp', arm: 0, applied: true, provider: 'claude-cli', model: 'claude-sonnet-5-5' }),   // before the start: left out
    row(1e3, ['i1'], { class: 'code', source: 'trial', trial: 'code-cmp', arm: 0, applied: true, provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }),
    row(2e3, ['i1', 'i2'], { class: 'code', source: 'trial', trial: 'code-cmp', arm: 0, applied: true, provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }),
    row(3e3, ['i3'], { class: 'code', source: 'chain', applied: false, wouldApply: { source: 'trial', arm: 'code-cmp:1', provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' } }),
    row(4e3, ['i4'], { class: 'code', source: 'trial', trialId: 'code-cmp', applied: true, provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }),   // arm found by its model
    row(5e3, ['i5'], { class: 'code', source: 'route', applied: false, reasons: ['not in trial'] }),
    row(6e3, ['i6'], { class: 'code', source: 'chain', applied: false, trialPaused: [{ trial: 'code-cmp', why: 'claude-cli held by the pacer' }] }),
  ];
  w(root, 'company/state/wakes.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  let s = tool(root, ['status', '--json']);
  assert.equal(s.code, 0, JSON.stringify(s.out));
  const t = s.out.trials[0];
  assert.deepEqual(t.arms.map(a => [a.label, a.wakes, a.items, a.shadowWakes, a.shadowItems]),
    [['claude-cli/claude-sonnet-5-5@high', 2, 2, 0, 0], ['claude-cli/claude-opus-5-5@medium', 1, 1, 1, 1]]);
  assert.equal(t.progress.enough, true); assert.equal(t.progress.lowestArm, 2);
  assert.match(t.reasons.join(' '), /held: claude-cli held by the pacer/);
  assert.equal(s.out.mode, 'shadow'); assert.equal(s.out.tierCaps.mode, 'shadow'); assert.equal(s.out.source, 'company');
  // the router's own log row ends the hold
  fs.appendFileSync(path.join(root, LOG), JSON.stringify({ at: started + 7e3, ts: new Date(started + 7e3).toISOString(), op: 'trial-unheld', trial: 'code-cmp', by: 'dispatcher' }) + '\n');
  s = tool(root, ['status', '--json']);
  assert.equal(s.out.trials[0].hold, null); assert.deepEqual(s.out.trials[0].reasons, []);
  // trial show, and the log capped at 20, newest first
  for (let i = 0; i < 25; i++) fs.appendFileSync(path.join(root, LOG), JSON.stringify({ at: started + 8e3 + i, ts: new Date(started + 8e3 + i).toISOString(), op: 'trial-held', trial: 'other', by: 'dispatcher', why: 'n' + i }) + '\n');
  s = tool(root, ['status', '--json']);
  assert.equal(s.out.log.length, 20); assert.equal(s.out.log[0].why, 'n24');
  const show = tool(root, ['trial', 'show', 'code-cmp', '--json']);
  assert.equal(show.code, 0); assert.equal(show.out.trial.id, 'code-cmp');
  assert.equal(tool(root, ['trial', 'show', 'nope']).code, 2);
  // a status from a company with no policy copy reads the framework default
  const bare = fixture();
  const b = tool(bare, ['status', '--json']).out;
  assert.deepEqual([b.source, b.mode, b.tierCaps.mode, b.trials.length], ['default', 'shadow', 'shadow', 0]);
});

// one child per writer, all started together: each loads its modules, then waits for the same instant before it runs
function racer(root, argv, o, at) {
  const pre = ['provenance.js', 'routing.js', 'decision.js', 'lib/owner.js', 'lib/departments.js', 'lib/taskclass.js'].map(f => 'try { require(' + JSON.stringify(path.join(TOOLS, f)) + '); } catch (_) {}').join(' ');
  const code = pre + ' const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o.owner ? 'true' : 'false') + ');' +
    'while (Date.now() < ' + at + ') {} const r = require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').run(' + JSON.stringify(argv) + '); process.stdout.write(JSON.stringify(r));';
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', code], { cwd: root, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', CAPHEOS_READONLY: '' }) });
    let out = '', err = ''; c.stdout.on('data', x => { out += x; }); c.stderr.on('data', x => { err += x; });
    c.on('exit', st => { try { resolve(Object.assign(JSON.parse(out), { argv })); } catch (e) { reject(new Error('child ' + st + ': ' + out + err)); } });
  });
}

test('concurrent writers: 8 trial creates and an owner mode change all land (or fail cleanly), one log row per landed change', async () => {
  const root = fixture();
  const ids = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  const at = Date.now() + 2500;
  const jobs = ids.map(id => racer(root, ['trial', 'create', id, '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5@high', '--arm', 'claude-cli/claude-opus-5-5@medium', '--scope-dept', 'eng', '--by', 'Hal'], {}, at))
    .concat([racer(root, ['mode', 'live', '--by', 'owner', '--why', 'race'], { owner: true }, at)]);
  const res = await Promise.all(jobs);
  const doc = JSON.parse(read(root, POLICY)), log = lines(root, LOG), dec = read(root, 'company/work/decisions.md');
  const landed = [];
  for (const r of res) {
    const id = r.argv[0] === 'trial' ? r.argv[2] : null;
    const rows = log.filter(x => id ? x.trial === id : x.op === 'mode');
    if (r.code === 0) {
      landed.push(r);
      assert.equal(rows.length, 1, 'one log row for ' + (id || 'the mode change'));
      if (id) { assert.ok(doc.trials.some(t => t.id === id), id + ' is in the policy (' + doc.trials.map(t => t.id).join(',') + ')'); assert.match(dec, new RegExp('draft trial ' + id + ' for')); }
      else { assert.equal(doc.mode, 'live', 'the mode change is in the policy'); assert.match(dec, /the routing mode shadow -> live/); }
    } else {
      assert.match(r.out.error, /another writer|lock/, 'a writer that lost fails clearly: ' + r.out.error);
      assert.equal(rows.length, 0, 'and records nothing');
      if (id) { assert.ok(!doc.trials.some(t => t.id === id)); assert.doesNotMatch(dec, new RegExp('draft trial ' + id + ' for')); }
    }
  }
  assert.equal(log.length, landed.length, 'exactly one routing-log row per change that landed');
  assert.equal(doc.trials.length, landed.filter(r => r.argv[0] === 'trial').length, 'every landed create is in the file');
  assert.ok(landed.length >= 1);
  assert.ok(!fs.existsSync(path.join(root, POLICY + '.lock')), 'the lock is released');
});

test('a writer that cannot get the policy lock fails clearly and records nothing; a stale lock is broken', () => {
  const root = fixture();
  const lock = w(root, POLICY + '.lock', JSON.stringify({ pid: 999999, at: Date.now(), token: 'other' }) + '\n');
  const quick = { pre: 'require(' + JSON.stringify(path.join(TOOLS, 'routing.js')) + ').S.lockOpts = () => ({ retries: 3, waitMs: 5 });' };
  let r = tool(root, CREATE.concat(['--by', 'Hal']), quick);
  assert.equal(r.code, 2); assert.match(r.out.error, /being changed by another writer \(held by process 999999.*nothing was changed or recorded/);
  r = tool(root, ['mode', 'live', '--by', 'owner'], Object.assign({ owner: true }, quick));
  assert.equal(r.code, 2);
  assert.equal(read(root, POLICY), null); assert.equal(read(root, LOG), null);
  assert.doesNotMatch(read(root, 'company/work/decisions.md'), /Model routing/);
  assert.ok(fs.existsSync(lock), 'another writer\'s lock is left alone');
  const old = (Date.now() - 120e3) / 1000; fs.utimesSync(lock, old, old);
  r = tool(root, CREATE.concat(['--by', 'Hal']), quick);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(lines(root, LOG).length, 1); assert.ok(!fs.existsSync(lock), 'the stale lock was broken and this writer\'s own lock released');
});

test('pauseWhenHeld covers every arm on a subscription the pacer meters (claude-cli, custom)', () => {
  const root = fixture();
  const rs = (id, arms, extra) => ['trial', 'create', id, '--class', 'research'].concat(...arms.map(a => ['--arm', a]), ['--scope-seat', 'lee'], extra || [], ['--by', 'Hal']);
  let r = tool(root, rs('mm-ds', ['deepseek/deepseek-flash', 'custom/MiniMax-M3.1-Pro']));
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.deepEqual(r.out.trial.pauseWhenHeld.slice().sort(), ['claude-cli', 'custom'], 'the MiniMax arm adds custom to the default');
  r = tool(root, rs('mm-only', ['deepseek/deepseek-flash', 'custom/MiniMax-M3.1-Pro'], ['--pause-when-held', 'deepseek']));
  assert.equal(r.code, 2); assert.match(r.out.error, /--pause-when-held.*custom/);
  r = tool(root, rs('cl-drop', ['claude-cli/haiku', 'custom/MiniMax-M3.1-Flash'], ['--pause-when-held', 'custom']));
  assert.equal(r.code, 2); assert.match(r.out.error, /--pause-when-held.*claude-cli/);
  r = tool(root, rs('both', ['claude-cli/haiku', 'custom/MiniMax-M3.1-Flash'], ['--pause-when-held', 'custom,claude-cli']));
  assert.equal(r.code, 0, JSON.stringify(r.out)); assert.deepEqual(r.out.trial.pauseWhenHeld, ['custom', 'claude-cli']);
  r = tool(root, rs('ds-only', ['deepseek/deepseek-flash', 'claude-cli/haiku'], ['--pause-when-held', 'deepseek']));
  assert.equal(r.code, 2, 'dropping the Claude arm\'s subscription is refused');
  // the file the router reads keeps trials[].pauseWhenHeld
  const doc = JSON.parse(read(root, POLICY));
  assert.deepEqual(doc.trials.map(t => [t.id, t.pauseWhenHeld.slice().sort()]), [['mm-ds', ['claude-cli', 'custom']], ['both', ['claude-cli', 'custom']]]);
  // status (what the console reads) says which subscriptions hold each trial, and names a gap in an older hand-made trial
  doc.trials.push({ id: 'old-gap', class: 'research', status: 'draft', arms: [{ provider: 'custom', model: 'MiniMax-M3.1-Pro' }, { provider: 'deepseek', model: 'deepseek-flash' }], scope: { seats: ['lee'] }, entryShare: 0.1, minItemsPerArm: 5, pauseWhenHeld: ['claude-cli'] });
  w(root, POLICY, doc);
  const s = tool(root, ['status', '--json']).out;
  const g = id => s.trials.find(t => t.id === id).heldGuard;
  assert.deepEqual(g('mm-ds'), { providers: ['claude-cli', 'custom'], subscriptions: ['custom'], missing: [] });
  assert.deepEqual(g('old-gap').missing, ['custom']);
  assert.deepEqual(s.trialLimits.subscriptionProviders, ['claude-cli', 'custom'], 'the list comes from the pacer, not this tool');
});

test('the console trial card and Start dialog say plainly what a trial compares and which plans pause it', async () => {
  const E = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'settings', 'routing-explain.js'));
  const t = { arms: [{ provider: 'custom' }, { provider: 'deepseek' }], pauseWhenHeld: ['claude-cli', 'custom'], heldGuard: { providers: ['claude-cli', 'custom'], subscriptions: ['custom'], missing: [] } };
  assert.equal(E.heldLine(t), 'Pauses itself while the Claude or MiniMax plan is at its limit.');
  assert.match(E.startBody(t, 'seat Lee', false), /shared out evenly between the two models being compared.*It pauses itself while the Claude or MiniMax plan is at its limit\.$/);
  const gap = { arms: [{ provider: 'custom' }], pauseWhenHeld: ['claude-cli'], heldGuard: { providers: ['claude-cli'], subscriptions: ['custom'], missing: ['custom'] } };
  assert.match(E.heldLine(gap), /keeps going when the MiniMax plan is at its limit/);
  assert.match(E.startBody(gap, 'x', true), /watching only.*keeps going when the MiniMax plan is at its limit/);
  assert.equal(E.heldLine({ arms: [], pauseWhenHeld: [] }), 'Never pauses for a plan limit.');
  // a non-technical owner's words: what it compares and how far it got; the ids only in the technical lines
  const three = { id: 'code-claude', class: 'code', entryShare: 0.1, minItemsPerArm: 30, progress: { minItemsPerArm: 30 }, arms: [{ provider: 'claude-cli', model: 'haiku', items: 1 }, { provider: 'claude-cli', model: 'claude-sonnet-5-5', items: 1, shadowItems: 0 }, { provider: 'claude-cli', model: 'claude-opus-5-5', items: 0 }] };
  assert.equal(E.trialTitle(three), 'Comparing three Claude models on coding work');
  assert.equal(E.progressLine(three), '2 of 90 results so far');
  assert.equal(E.trialTitle({ class: 'writing', arms: [{ provider: 'claude-cli' }, { provider: 'custom' }] }), 'Comparing Claude and MiniMax models on writing work');
  for (const line of [E.trialTitle(three), E.progressLine(three), E.heldLine(three), E.startBody(three, 'the eng team', true)])
    assert.doesNotMatch(line, /claude-|MiniMax-|deepseek-|haiku|\barms?\b|entry share|shadow|tier cap|allowlist|pacer/i, line);
  assert.ok(E.technicalLines(three).some(l => /claude-cli\/claude-opus-5-5/.test(l)) && E.technicalLines(three).some(l => /entry share 10%/.test(l)), 'the ids are kept for the crew');
});

test('the console route runs routing.js as the owner with fixed arguments', async () => {
  const calls = [], routes = [];
  require(path.join(REPO, 'console', 'routing.js')).mount((m, re, fn) => routes.push([m, re, fn]), {
    runApi: async (name, args) => { calls.push([name].concat(args)); return { ok: true }; }, bad: msg => { throw new Error(msg); }, owner: () => 'Olive' });
  const hit = async (m, p, b) => { for (const [mm, re, fn] of routes) { const x = mm === m && re.exec(p); if (x) return fn(x, null, b); } throw new Error('no route ' + p); };
  await hit('GET', '/api/routing');
  await hit('POST', '/api/routing/mode', { mode: 'live' });
  await hit('POST', '/api/routing/tiercaps', { mode: 'off', why: 'not yet' });
  await hit('POST', '/api/routing/trials/code-cmp/pause', {});
  await assert.rejects(() => hit('POST', '/api/routing/mode', { mode: '--by' }));
  await assert.rejects(() => hit('POST', '/api/routing/mode', { mode: 'live', why: '--by x' }));
  await assert.rejects(() => hit('POST', '/api/routing/trials/code-cmp/delete', {}));
  await assert.rejects(() => hit('POST', '/api/routing/trials/--by/start', {}));
  assert.deepEqual(calls, [['routing.js', 'status', '--json'], ['routing.js', 'mode', 'live', '--by', 'Olive'], ['routing.js', 'tiercaps', 'off', '--by', 'Olive', '--why', 'not yet'], ['routing.js', 'trial', 'pause', 'code-cmp', '--by', 'Olive']]);
});

test('console round trip: the owner switches routing live and starts a trial from the console; the tool records it', async () => {
  const tmp = fixture({ full: true });
  w(tmp, 'secrets/station-token', 'fake-token\n');
  assert.equal(tool(tmp, CREATE.concat(['--by', 'Hal'])).code, 0);
  // a fake station on a free loopback port: the console asks it for things at startup; routing needs nothing from it
  const fake = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"fake"}'); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + fake.address().port, CAPHEOS_TZ: 'UTC' });
  delete env.CONSOLE_PORT; delete env.CAPHEOS_READONLY;
  const child = require('../lib/temp-life').track(spawn(process.execPath, [path.join(tmp, 'console', 'server.js'), '--port', '0', '--print-port'], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  let errText = ''; child.stderr.on('data', x => { errText += x; });
  try {
    const port = await new Promise((resolve, reject) => { let buf = ''; child.stdout.on('data', x => { buf += x; const m = buf.match(/\{"port":(\d+)\}/); if (m) resolve(Number(m[1])); }); child.on('exit', c => reject(new Error('server exited ' + c + ': ' + errText))); setTimeout(() => reject(new Error('server did not start: ' + errText)), 15000); });
    const token = fs.readFileSync(path.join(tmp, 'secrets', 'console-token'), 'utf8').trim();
    const call = (method, p, body, hdr) => new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign(hdr || { 'x-console-token': token }, data ? { 'content-type': 'application/json' } : {}) }, res => {
        let x = ''; res.on('data', c => { x += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(x); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
      });
      req.setTimeout(60000, () => req.destroy(new Error('timeout ' + p))); req.on('error', reject); if (data) req.write(data); req.end();
    });
    let r = await call('GET', '/api/routing', undefined, {});
    assert.equal(r.status, 401, 'owner-only: no token, no answer');
    r = await call('GET', '/api/routing');
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.mode, 'shadow'); assert.equal(r.json.trials[0].status, 'draft');
    r = await call('POST', '/api/routing/mode', { mode: 'live', why: 'from the console' });
    assert.equal(r.status, 200, JSON.stringify(r.json) + errText); assert.equal(r.json.changed, true);
    r = await call('POST', '/api/routing/trials/code-cmp/start', {});
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.trial.status, 'running');
    r = await call('POST', '/api/routing/trials/code-cmp/resume', {});
    assert.equal(r.status, 200); assert.equal(r.json.changed, false, 'resuming a running trial changes nothing');
    r = await call('POST', '/api/routing/trials/no-such/start', {});
    assert.equal(r.status, 400, 'the tool\'s refusal comes back as 400'); assert.match(r.json.error, /no trial/);
    r = await call('POST', '/api/routing/mode', { mode: 'turbo' });
    assert.equal(r.status, 400);
    const doc = JSON.parse(read(tmp, POLICY));
    assert.equal(doc.mode, 'live'); assert.equal(doc.trials[0].status, 'running'); assert.equal(doc.trials[0].startedBy, 'owner');
    assert.deepEqual(lines(tmp, LOG).map(x => [x.op, x.by]), [['trial-create', 'Hal'], ['mode', 'owner'], ['trial-start', 'owner']]);
    r = await call('GET', '/api/routing');
    assert.equal(r.json.mode, 'live'); assert.equal(r.json.log[0].op, 'trial-start');
  } finally { child.kill(); fake.close(); }
});
