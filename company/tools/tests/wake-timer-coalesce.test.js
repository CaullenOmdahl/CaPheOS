#!/usr/bin/env node
/* wake-timer-coalesce.test.js — --wake on high-frequency timers requires --wake-on-failure, --on-failure skips waking
 * on exit 0 while still recording the completion, and dispatch coalesces repeated service completions & respects cooldown.
 *   node --test company/tools/tests/wake-timer-coalesce.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const cp = require('child_process');
const life = require('../lib/temp-life');

const TOOLS = path.resolve(__dirname, '..');

test('service.js: rejects --wake on <15min timer without --wake-on-failure, accepts with --wake-on-failure', () => {
  const S = require('../service.js');
  const T = life.tmpDir('wake-svc-');
  try {
    const R = path.join(T, 'co');
    for (const d of ['company/state', 'company/tools', 'company/work/scripts', 'company/defaults/state', 'company/owner']) fs.mkdirSync(path.join(R, d), { recursive: true });
    fs.writeFileSync(path.join(R, 'company/company.json'), JSON.stringify({ name: 'Test Co', slug: 'testco', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }));
    fs.writeFileSync(path.join(R, 'company/tools/loops.json'), JSON.stringify({ agents: { data: { name: 'Hollis' } } }));
    fs.writeFileSync(path.join(R, 'company/work/scripts/sample.sh'), 'echo ok\n');
    const ctx = S.context({ root: R, memPlan: { defaultMax: '512M', ceiling: '4G' } });
    assert.throws(
      () => S.specOf(ctx, 'fast', { kind: 'timer', every: '1min', exec: 'bash company/work/scripts/sample.sh', why: 'samples cpu every minute', wake: 'data' }, { resolve: false }),
      /faster than 15min requires --wake-on-failure/
    );
    const okSpec = S.specOf(ctx, 'fast', { kind: 'timer', every: '1min', exec: 'bash company/work/scripts/sample.sh', why: 'samples cpu every minute', wake: 'data', 'wake-on-failure': true }, { resolve: false });
    assert.equal(okSpec.wakeOnFailure, true);
    const units = S.render(ctx, okSpec);
    assert.match(units['testco-svc-fast.service'], /"--service-run" "fast" "--seat" "data" "--on-failure" "--"/);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('notify-when.js: --service-run --on-failure clears seat on exit 0 and keeps seat on non-zero exit', () => {
  const T = life.tmpDir('wake-nw-');
  try {
    const w = (rel, s) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
    w('company/tools/loops.json', JSON.stringify({ agents: { data: { name: 'Hollis', inbox: 'to-hollis.md' } } }));
    w('company/company.json', '{"name":"T"}');
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T });
    const run = args => cp.spawnSync(process.execPath, [path.join(TOOLS, 'notify-when.js')].concat(args), { cwd: T, env, encoding: 'utf8' });

    const rOk = run(['--service-run', 'sampler', '--seat', 'data', '--on-failure', '--', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(rOk.status, 0, rOk.stderr);
    const rFail = run(['--service-run', 'sampler', '--seat', 'data', '--on-failure', '--', process.execPath, '-e', 'process.exit(2)']);
    assert.equal(rFail.status, 2);

    const rows = fs.readFileSync(path.join(T, 'company/state/completions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].seat, [], 'exit 0 with --on-failure records service run without waking seat');
    assert.equal(rows[0].service, 'sampler');
    assert.deepEqual(rows[1].seat, ['data'], 'non-zero exit with --on-failure still wakes seat');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
