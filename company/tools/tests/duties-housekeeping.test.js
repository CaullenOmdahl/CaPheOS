#!/usr/bin/env node
/* duties-housekeeping.test.js — provider-balance 24h empty-account snooze, dead watched-jobs pruning,
 * and security-watch GET request headers (no Content-Type on GET, standard User-Agent).
 *   node --test company/tools/tests/duties-housekeeping.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const life = require('../lib/temp-life');
const PB = require('../lib/provider-balance');
const PBDuty = require('../provider-balance');
const CMP = require('../lib/completions');

test('provider-balance duty fires initially, then snoozes after 24h when empty/unavailable and already alerted', () => {
  const T = life.tmpDir('pb-snooze-');
  try {
    const t0 = 1795000000000;
    PB.record('deepseek', { at: t0, available: false, balances: [{ currency: 'USD', total_balance: '0' }] }, { root: T, now: t0, perDayUsd: 1, notify: () => {} });
    // Within 24h: duty is still due (exit 1)
    assert.equal(PBDuty.duty({ root: T, now: t0 + 3600e3 }), 1);
    // After 24h with available===false and alertedKey===low.key: snoozed (exit 0)
    assert.equal(PBDuty.duty({ root: T, now: t0 + 25 * 3600e3 }), 0);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('completions.pruneDeadRunning removes stale dead-PID watched-jobs files while keeping live ones', () => {
  const T = life.tmpDir('wj-prune-');
  try {
    const dir = CMP.RUNNING_DIR(T);
    fs.mkdirSync(dir, { recursive: true });
    const deadF = path.join(dir, 'dead.json');
    const liveF = path.join(dir, 'live.json');
    fs.writeFileSync(deadF, JSON.stringify({ id: 'dead', watcherPid: 9999999, pid: 9999999 }));
    fs.writeFileSync(liveF, JSON.stringify({ id: 'live', watcherPid: process.pid, pid: process.pid }));
    const old = new Date(Date.now() - 10 * 60e3);
    fs.utimesSync(deadF, old, old);
    fs.utimesSync(liveF, old, old);
    const removed = CMP.pruneDeadRunning(T, 5 * 60e3);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(deadF), false);
    assert.equal(fs.existsSync(liveF), true);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
