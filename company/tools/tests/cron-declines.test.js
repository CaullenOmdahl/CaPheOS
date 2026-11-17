#!/usr/bin/env node
/* cron-declines.test.js — StarNet answers some routine refusals with HTTP 200 {ok:false, declined:true, message}
 * (its dedupe memory keeps the names of deleted routines). lib/station.js judges every routine create/update/remove/arm;
 * the watchdog is created under a unique name and recognised by script + noAgent + name PREFIX. The end-to-end cases
 * (migrate, rollback, dispatcher, the sandbox's "#25f494") are in budget-gate.test.js against tests/mock-station.js.
 *   node --test company/tools/tests/cron-declines.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

const TOOLS = path.resolve(__dirname, '..');
const ST = require('../lib/station');
const SCHED = require('../lib/scheduler');
const DECLINE = { ok: false, declined: true, message: 'this routine already exists — do not recreate it' };
const R = (status, json) => ({ status, body: JSON.stringify(json) });

/* a fake station: names in `declined` are refused with 200; `lie` answers a create ok but never stores it */
function fake(o) {
  o = o || {};
  const S = { jobs: [], calls: [], n: 0 };
  S.call = async (m, p, b) => {
    S.calls.push([m, p, b && b.name]);
    if (m === 'GET' && p === '/api/cron') return R(200, { jobs: S.jobs });
    if (m === 'POST' && p === '/api/cron') {
      if ((o.declined || []).includes(b.name)) return R(200, DECLINE);
      if (o.duplicateOf) return R(200, { ok: true, duplicate: true, job: o.duplicateOf });
      const job = Object.assign({ id: 'j' + (++S.n) }, b); if (!o.lie) S.jobs.push(job); return R(200, { ok: true, job });
    }
    return o.writes === 'decline' ? R(200, DECLINE) : R(200, { ok: true });
  };
  return S;
}

test('cronResult: a 200 with ok:false or declined:true is a failure carrying the station\'s message', () => {
  const d = ST.cronResult(R(200, DECLINE), 'create watchdog');
  assert.equal(d.ok, false); assert.equal(d.declined, true);
  assert.equal(d.reason, 'create watchdog: the station declined (HTTP 200): this routine already exists — do not recreate it');
  assert.equal(ST.cronResult(R(200, { ok: false, error: 'nope' }), 'x').ok, false);
  assert.equal(ST.cronResult({ status: 200, json: DECLINE }, 'x').ok, false, 'the { status, json } caller shape too');
  assert.equal(ST.cronResult(R(200, { ok: true, job: {} }), 'x').ok, true);
  assert.equal(ST.cronResult({ status: 200, body: '' }, 'x').ok, true, 'a bare 200 (old fakes) is still ok');
  assert.match(ST.cronResult(R(404, { error: 'no such routine' }), 'x').reason, /^x: HTTP 404 no such routine/);
  assert.equal(ST.cronResult(null, 'x').ok, false);
});

test('createRoutine: declined, duplicate and "200 but not listed" all fail; a decline is retried under a new name', async () => {
  let S = fake({ declined: ['A'] });
  let r = await ST.createRoutine(S.call, { name: 'A', prompt: 'p' }, { what: 'create A' });
  assert.equal(r.ok, false); assert.match(r.reason, /create A: the station declined \(HTTP 200\): this routine already exists/); assert.equal(S.jobs.length, 0);
  S = fake({ lie: true });
  r = await ST.createRoutine(S.call, { name: 'B', prompt: 'p' }, { what: 'create B' });
  assert.equal(r.ok, false); assert.match(r.reason, /GET \/api\/cron does not list routine j1/);
  S = fake({ duplicateOf: { id: 'old', name: 'C old' } });
  r = await ST.createRoutine(S.call, { name: 'C', prompt: 'p' }, { what: 'create C' });
  assert.equal(r.ok, false); assert.match(r.reason, /existing routine "C old"/);
  S = fake({ declined: ['D'] });
  r = await ST.createRoutine(S.call, { name: 'D', prompt: 'p' }, { what: 'create D', rename: () => 'D #2' });
  assert.equal(r.ok, true); assert.equal(r.name, 'D #2'); assert.equal(r.tries.length, 1); assert.match(r.tries[0], /declined/);
  assert.deepEqual(S.jobs.map(j => j.name), ['D #2']);
});

test('the watchdog: a unique name per create, recognised by script + noAgent + name prefix, never the exact name', async () => {
  const a = SCHED.watchdogSpec('/co', 'agent'), b = SCHED.watchdogSpec('/co', 'agent');
  assert.match(a.name, /^Watchdog \(dispatcher liveness, starts no work\) #[0-9a-f]{6}$/); assert.notEqual(a.name, b.name);
  const base = { noAgent: true, script: 'company/tools/watchdog.js', workdir: '/co' };
  assert.ok(SCHED.isWatchdog(Object.assign({ name: SCHED.WATCHDOG.name + ' #25f494' }, base)), 'the sandbox\'s hand-made one');
  assert.ok(SCHED.isWatchdog(Object.assign({ name: SCHED.WATCHDOG.name }, base)), 'an older bare-named one');
  assert.ok(!SCHED.isWatchdog({ name: SCHED.WATCHDOG.name + ' #25f494' }), 'the name alone is not a watchdog');
  assert.ok(!SCHED.isWatchdog(Object.assign({ name: 'Some other script' }, base)), 'the script alone is not one either');
  assert.equal(SCHED.ownWatchdogs([Object.assign({ id: 'w', name: SCHED.WATCHDOG.name + ' #25f494' }, base)], '/co').length, 1);
  assert.equal(SCHED.plan('dispatcher', { jobs: [Object.assign({ id: 'w', name: SCHED.WATCHDOG.name + ' #25f494' }, base)], crew: {}, root: '/co' }).createWatchdog, false);
  // createWatchdog: a declined name is retried; the result names the routine GET /api/cron lists
  const S = fake(); const first = SCHED.watchdogSpec('/co', 'agent').name;
  const real = S.call; let n = 0;
  S.call = async (m, p, b) => (m === 'POST' && p === '/api/cron' && n++ === 0) ? R(200, DECLINE) : real(m, p, b);
  const r = await SCHED.createWatchdog(S.call, '/co', 'agent');
  assert.equal(r.ok, true); assert.equal(r.tries.length, 1); assert.ok(SCHED.isWatchdog(S.jobs[0])); assert.notEqual(first, r.name);
});

test('routine-rules ensure: a prompt update declined with HTTP 200 is a failure', async () => {
  const RR = require('../routine-rules.js');
  const job = { id: 'j1', name: 'Founder loop', agentId: 'agent', prompt: 'Work.' };
  const call = async (m, p) => m === 'GET' ? R(200, { jobs: [job] }) : R(200, DECLINE);
  const r = await RR.ensure({ call, log: () => {}, blockFor: null, ownFor: null, ownBlocked: null });
  assert.equal(r.changed.length, 0, JSON.stringify(r)); assert.equal(r.failed.length, 1); assert.match(r.failed[0], /declined \(HTTP 200\)/);
});

// Every tool that writes a routine (create, update, remove, arm) judges the answer through lib/station.js (or the
// scheduler's createWatchdog, which uses it). A new caller that reads `status === 200` as success fails here.
test('every routine write in company/tools and modules goes through lib/station.js', () => {
  const REPO = path.resolve(TOOLS, '..', '..');
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!/^(tests|node_modules|ui)$/.test(e.name)) walk(f); } else if (/\.js$/.test(e.name)) files.push(f); } };
  walk(path.join(REPO, 'company', 'tools')); if (fs.existsSync(path.join(REPO, 'modules'))) walk(path.join(REPO, 'modules'));
  const WRITE = /call\(\s*'POST'\s*,\s*'\/api\/cron(\/update|\/remove|\/arm)?'/;
  const offenders = [];
  for (const f of files) {
    if (/lib[\\/]station\.js$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const live = src.split(/\nasync function selftest\(|\nfunction selftest\(/)[0];   // the selftests' own fakes are not callers
    if (WRITE.test(live) && !/require\('\.\/lib\/station'\)|require\('\.\/station'\)|SCHED\.createWatchdog|cronResult|ST\.cron/.test(live)) offenders.push(path.relative(REPO, f));
  }
  assert.deepEqual(offenders, []);
});
