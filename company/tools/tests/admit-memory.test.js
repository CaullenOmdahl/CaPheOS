'use strict';
// admit-memory.test.js — lib/admit.js's memory gate (docs/BUDGET.md "Memory"): while the computer is short of memory a
// new start that can wait (a dispatcher wake, a lane, a pacer re-fire) is held; the owner's chat, a health check and the
// liveness check always pass; the hold lifts only past the upper line; a stale pressure file is ignored.
//   node --test company/tools/tests/admit-memory.test.js
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('assert');
const life = require('../lib/temp-life');

const T = life.tmpDir('admit-memory-test-');
fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
process.env.CAPHEOS_ROOT = T;
const A = require('../lib/admit');
const cfg = keep => fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'M', runtime: { memory: { profile: 'normal', keepFreeMB: keep } } }));
const mem = availMB => 'MemTotal:       16000000 kB\nMemFree:          100000 kB\nMemAvailable:   ' + Math.round(availMB * 1024) + ' kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n';
const holdFile = path.join(T, 'company', 'state', 'memory-hold.json');
const pressFile = path.join(T, 'company', 'state', 'memory-pressure.json');
const log = path.join(T, 'admit.jsonl');
const ask = (door, availMB, extra) => A.admit(Object.assign({ door, kind: door === 'watchdog' ? 'watchdog' : 'run', seat: 'sam' }, extra || {}), { root: T, file: log, meminfo: mem(availMB), now: Date.now() });
const reset = () => { fs.rmSync(holdFile, { force: true }); fs.rmSync(pressFile, { force: true }); };

test('below keepFree + 256 MB: a dispatcher wake waits, the owner\'s chat and a health check pass; lifts only past keepFree + 768 MB', () => {
  cfg(8192); reset();
  const held = ask('dispatch', 8192 + 100);
  assert.strictEqual(held.decision, 'hold'); assert.strictEqual(held.memory, true); assert.strictEqual(held.memoryEdge, 'start');
  assert.strictEqual(held.plain, 'Holding new work: the computer is short of memory');
  assert.ok(fs.existsSync(holdFile));
  for (const d of ['chat', 'health', 'meeting', 'console', 'hire', 'onboard', 'halt']) assert.strictEqual(ask(d, 8192 + 100).decision, 'allow', d + ' always passes');
  assert.strictEqual(ask('watchdog', 8192 + 100).decision, 'allow', 'the liveness check passes');
  assert.strictEqual(ask('lane', 8192 + 100).decision, 'hold', 'a lane waits'); assert.strictEqual(ask('pacer', 8192 + 100).decision, 'hold', 'a pacer re-fire waits');
  const mid = ask('dispatch', 8192 + 500);
  assert.strictEqual(mid.decision, 'hold', 'between the lines: still held (no flapping)'); assert.strictEqual(mid.memoryEdge, undefined, 'no second start line');
  const up = ask('dispatch', 8192 + 800);
  assert.strictEqual(up.decision, 'allow'); assert.strictEqual(up.memoryEdge, 'lift', 'past the upper line: lifted, one line');
  assert.ok(!fs.existsSync(holdFile));
  assert.strictEqual(ask('dispatch', 8192 + 500).decision, 'allow', 'between the lines after a lift: not held again');
});

test('the reaper\'s pressure file holds while fresh and open; older than 20 minutes or ended it is ignored', () => {
  cfg(0); reset();
  fs.writeFileSync(pressFile, JSON.stringify({ since: new Date(Date.now() - 60e3).toISOString(), at: new Date(Date.now() - 30e3).toISOString(), availableMB: 200 }));
  assert.strictEqual(ask('dispatch', 30000).decision, 'hold', 'fresh pressure holds even with memory free now');
  reset();
  fs.writeFileSync(pressFile, JSON.stringify({ since: new Date(Date.now() - 3 * 3600e3).toISOString(), at: new Date(Date.now() - 21 * 60e3).toISOString(), availableMB: 200 }));
  assert.strictEqual(ask('dispatch', 30000).decision, 'allow', 'a stale pressure file is ignored');
  fs.writeFileSync(pressFile, JSON.stringify({ since: new Date(Date.now() - 60e3).toISOString(), at: new Date().toISOString(), endedAt: new Date().toISOString() }));
  assert.strictEqual(ask('dispatch', 30000).decision, 'allow', 'an ended pressure spell is ignored');
});

test('nothing kept free under normal: held only when the machine is nearly out (under 256 MB)', () => {
  cfg(0); reset();
  assert.strictEqual(ask('dispatch', 1024).decision, 'allow');
  assert.strictEqual(ask('dispatch', 300).decision, 'allow');
  assert.strictEqual(ask('dispatch', 200).decision, 'hold');
  reset();
});

test('fail open, and a caller\'s selftest (file: null) is never judged on this machine\'s memory', () => {
  cfg(8192); reset();
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 'x' }, { root: T, file: log, meminfo: 'garbage' }).decision, 'allow', 'unreadable meminfo never holds');
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 'x' }, { root: T, file: null }).decision, 'allow');
  assert.ok(!fs.existsSync(holdFile));
  const dry = A.admit({ door: 'dispatch', kind: 'run', seat: 'x' }, { root: T, file: log, meminfo: mem(100), dry: true });
  assert.strictEqual(dry.decision, 'hold'); assert.ok(!fs.existsSync(holdFile), 'a dry run writes nothing');
  life.cleanup();
});

test('a dispatcher wake for what the owner wrote passes the memory gate', () => {
  const T2 = life.tmpDir('admit-memory-owner-');
  fs.mkdirSync(path.join(T2, 'company', 'state'), { recursive: true });
  fs.writeFileSync(path.join(T2, 'company', 'company.json'), JSON.stringify({ runtime: { memory: { profile: 'normal', keepFreeMB: 4096 } } }));
  const o = { root: T2, file: path.join(T2, 'a.jsonl'), meminfo: mem(100) };
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 's', owner: true }, o).decision, 'allow');
  assert.strictEqual(A.admit({ door: 'dispatch', kind: 'run', seat: 's' }, o).decision, 'hold');
  life.cleanup();
});
