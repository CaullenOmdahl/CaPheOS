#!/usr/bin/env node
/* console-idle.test.js — the console's plain idle text (console/ui/js/idle-line.js) and the tempo explanations
 * (console/ui/js/screens/settings/tempo-explain.js), from the shapes the dispatcher and cadence.js write.
 *   node --test company/tools/tests/console-idle.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const UI = path.resolve(__dirname, '..', '..', '..', 'console', 'ui', 'js');
const SS = require('../lib/seat-status');

test('Today: each idle seat says why, in the dispatcher\'s words', async () => {
  const { idleLine } = await import(path.join(UI, 'idle-line.js'));
  assert.equal(idleLine({ name: 'Founder', idle: SS.entry({ state: 'held-money', kind: 'spread', waiting: ['Rohan', 'Halima'] }) }), 'Founder: paused to make today\'s budget last — Rohan and Halima are waiting on it.');
  assert.equal(idleLine({ name: 'Nadia', idle: SS.entry({ state: 'waiting', waits: { Founder: 3 } }) }), 'Nadia: waiting on Founder for 3 items.');
  assert.equal(idleLine({ name: 'Ingrid', idle: SS.entry({ state: 'idle' }) }), 'Ingrid: waiting for new work.');
  assert.equal(idleLine({ name: 'Halima', idle: SS.entry({ state: 'stuck', open: 4, runs: 3, ceoName: 'Founder' }) }), 'Halima: stuck — same 4 items after 3 runs; Founder has been asked.');
});

test('Settings › Tempo: with Sprint on, the base values it overrides say so, until when and with what', async () => {
  const T = await import(path.join(UI, 'screens', 'settings', 'tempo-explain.js'));
  const d = { defaultCooldownMin: 1, maxPerTick: 4, effective: { tickMin: 5, maxPerTick: 7 }, sprint: { active: true, until: '2026-11-18T07:22:22.804Z', config: { cooldownFloorMin: 2, unchangedRestMin: 15, fallbackTickMin: 5 } } };
  const fmt = () => '14:22';
  assert.match(T.sprintOverride('cooldown', d, fmt).note, /^Sprint overrides this until 14:22: an agent with new work rests only 2 min; one whose work has not changed since its last run rests 15 min/);
  assert.equal(T.sprintOverride('perTick', d, fmt).value, 'Sprint: everyone (7)');
  assert.match(T.sprintOverride('wakeCaps', d, fmt).note, /wake caps are lifted/);
  assert.equal(T.sprintOverride('cooldown', Object.assign({}, d, { sprint: { active: false } })), null, 'Sprint off: your value is the rule');
  for (const k of ['tick', 'cooldown', 'perTick', 'wakeCaps', 'spread']) assert.ok(/: /.test(T.EXPLAIN[k]) && T.EXPLAIN[k].length < 300, k);
  assert.equal(T.spreadSetting({ config: { spreadDailyCap: false } }), 'off');
  assert.equal(T.spreadSetting({ config: { spreadOffUntil: new Date(Date.now() + 3600e3).toISOString() } }), 'today');
  assert.equal(T.spreadSetting({ config: {} }), 'on');
});
