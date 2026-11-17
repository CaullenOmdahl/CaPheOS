#!/usr/bin/env node
/* console-plain.test.js — the console's plain words for the owner: question categories, display names, AI usage lines,
 * the Sprint line, seat status and lanes, Spend's candidate row (console/ui/js/plain.js), and run steps / run summaries
 * without raw commands or tool-call markup (console/activity.js).
 *   node --test company/tools/tests/console-plain.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const UI = path.resolve(__dirname, '..', '..', '..', 'console', 'ui', 'js');
const ACT = require(path.resolve(__dirname, '..', '..', '..', 'console', 'activity.js'));

test('Needs you: a human category, never the raw tag', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  assert.equal(P.category({ about: 'governance:hiring', gate: { category: 'hiring' } }), 'Hiring');
  assert.equal(P.category({ about: 'pacing:claude' }), 'AI usage');
  assert.equal(P.category({ about: 'Access gate (gate 2)' }), 'Access');
  assert.equal(P.category({ about: 'budget' }), 'Money');
  assert.equal(P.category({ about: '', form: { fields: [{ type: 'secret' }] } }), 'Access');
  assert.equal(P.category({ about: '' }), 'Question');
});

test('display names: title-cased for display, ids left alone, a candidate id named from its slug', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  assert.equal(P.personName('Nadia farrell'), 'Nadia Farrell');
  assert.equal(P.personName('NADIA FARRELL'), 'Nadia Farrell');
  assert.equal(P.personName('Anne-marie McDonald'), 'Anne-Marie McDonald');
  assert.equal(P.personName('cand-quant-researcher-1-rohan-iy'), 'cand-quant-researcher-1-rohan-iy');
  assert.equal(P.nameFromId('cand-people-manager-1-tobias-lin'), 'Tobias Lin');
});

test('AI usage: the week used and today\'s allowance, and why it is open, in plain words', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  const fmt = () => '02:14';
  const u = P.usageLine({ label: 'Claude', known: true, open: true, usedPct: 78, line: 90, emergencyOpened: true, why: '12 points under today\'s line (0.8 days\' share) — open only because of the emergency' }, { active: true, until: 1 }, fmt);
  assert.equal(u.reading, '78% of this week used; today\'s allowance 90%');
  assert.equal(u.note, 'Open because you lifted today\'s limit until 02:14.');
  assert.doesNotMatch(u.reading + u.note, /days' share|emergency|points under/);
  assert.equal(P.usageLine({ label: 'Claude', known: true, open: true, usedPct: 30, line: 42 }).note, 'Open: 12 points left today.');
  assert.equal(P.railLine({ known: true, pct: 12, perDay: 25 }).reading, '$3 of $25 today');
  assert.equal(P.railLine({ none: true, perDay: 0 }), null);
});

test('Sprint: one plain line, the rest for Details', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  const s = P.sprintSummary({ until: 'x', itemsDone: 56, wakes: 68, idleWakeRatio: 0.39, spentUsd: 0.53, budgetUsd: 10, usdPerItem: 0.009, proposalsPerHour: 3, reviewsPerHour: 2.5 }, () => '14:22 tomorrow');
  assert.equal(s.line, 'Sprint on until 14:22 tomorrow · 56 things done · $0.53 of $10 spent');
  assert.equal(s.details.length, 3);
  assert.doesNotMatch(s.line, /wakes|\/item|proposals/);
});

test('seat status: the dispatcher\'s reason; lanes only while more than one thing runs, never for the CEO', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  const resting = P.seatState({ seat: { idle: { state: 'resting', reason: 'nothing new since its last run' }, lanes: { running: 0, max: 2, live: [] } }, station: { status: 'idle' } });
  assert.deepEqual(resting, { word: 'Resting', line: 'Nothing new since its last run', lanes: '' });
  assert.equal(P.seatState({ run: {}, seat: { running: 1, lanes: { running: 1, max: 1, live: [] } }, isCeo: true }).lanes, '');
  assert.equal(P.seatState({ run: {}, seat: { running: 2, lanes: { live: [{ n: 2 }] } } }).lanes, 'Working on 2 things at once');
  assert.equal(P.seatState({ run: {}, seat: { running: 2, lanes: { live: [{ n: 2 }] } }, isCeo: true }).lanes, '');
  assert.equal(P.seatState({ run: {}, seat: { running: 1 } }).lanes, '');
});

test('Spend › By seat: interview candidates fold into one row with their names', async () => {
  const P = await import(path.join(UI, 'plain.js'));
  const g = P.groupSeats([{ id: 'agent', name: 'Founder', usd: 1 }, { id: 'cand-x-1-nadia', name: 'Nadia farrell', candidate: false, usd: 0.2 },
    { id: 'cand-people-manager-1-tobias-lin', name: 'cand-people-manager-1-tobias-lin', usd: 0.02 }, { id: 'cand-r-1-aisha', name: 'Aisha Bello', candidate: true, usd: 0.01 }]);
  assert.deepEqual(g.seats.map(s => s.name), ['Founder', 'Nadia Farrell']);
  assert.equal(g.candidates.n, 2); assert.equal(g.candidates.usd, 0.03);
  assert.deepEqual(g.candidates.rows.map(r => r.name), ['Tobias Lin', 'Aisha Bello']);
});

test('Now: a running step in plain words, never the raw command', () => {
  const a = ACT({ co: { ROOT: '/home/o/co', crew: () => ({}) }, stationGet: async () => ({}), emit() {}, tool() {} });
  const step = c => a.stepText('shell', JSON.stringify({ cmd: c }));
  assert.equal(step('cd /home/o/co && grep -n "x" company/work/a.md'), 'searching company files');
  assert.equal(step('bash scripts/test.sh'), 'running a test');
  assert.equal(step('node --test company/tools/tests/a.test.js'), 'running a test');
  assert.equal(step('sed -n 1,40p company/tools/hire.js'), 'reading a company tool');
  assert.equal(step('node company/tools/hire.js list'), 'hiring…');
  assert.equal(step('frobnicate --all'), 'running a command');
  for (const c of ['cd /home/o/co && grep -n x y', 'systemctl --user restart a.service']) assert.doesNotMatch(step(c), /\/|`|grep|systemctl/);
});

test('Recent activity: tool-call markup never reaches the owner; "Ran a command" plus Details', () => {
  const raw = '<parameter name="cmd"cd /home/o/co && python3 -I -m py_compile company/work/x.py && systemctl --user restart x.servic';
  const r = ACT.runText(raw, 0);
  assert.equal(r.text, 'Restarted a service.');
  assert.match(r.detail, /systemctl --user restart/);
  assert.equal(ACT.runText('<invoke name="shell"><parameter name="cmd">frob</parameter></invoke>').text, 'Ran a command.');
  assert.equal(ACT.runText('Done: closed. <invoke name="x"><parameter name="cmd">ls</parameter></invoke>').text, 'Done: closed.');
  assert.equal(ACT.runText('', 11).text, '11 tool steps');
  assert.doesNotMatch(ACT.stripToolMarkup('a <parameter name="path">/x</parameter> b').text, /<|parameter/);
});
