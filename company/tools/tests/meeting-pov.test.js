'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
// meeting-pov.test.js — point of view in the owner's meeting (console/meeting.js, docs/MEETINGS.md "Point of view";
// docs/PROFILES.md), with a scripted runner in place of the station. Crew: Dana (CEO, leads), Noah (scout; his profile
// names Ravi as the counterpart who signs off promote), Ravi (tester).
//   - each seat's history is a projection of the one stored log: Ravi sees "Noah, your counterpart, said", the owner as
//     "(the owner)"; the stored log is unchanged (neutral)
//   - every reply's STANCE line is parsed and stripped (stored as say.stance; shown dim; in the minutes); a reply with none
//     gets a console note on its next turn, and is never re-run
//   - the gatekeeper's private first take: a talk-only run before its turn with only the owner's message and its profile;
//     never in another seat's history; its real turn carries the take and the re-check line
//   - the profile reminder is the last line of the turn
//   - echo stats at close (no model call): deterministic on a fixture, in stats.jsonl and the minutes' close line
//   node --test company/tools/tests/meeting-pov.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = __LIFE.tmpDir('meeting-pov-selftest-');
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
W('company/company.json', { name: 'Pov Test', owner: { name: 'Avery' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents: { dana: { name: 'Dana', title: 'CEO', functions: ['ceo'], manager: null }, noah: { name: 'Noah', title: 'Idea Scout', manager: 'dana' }, ravi: { name: 'Ravi', title: 'Data Scientist', manager: 'dana' } } });
W('company/work/decisions.md', '# Decisions\n\n');
process.env.CAPHEOS_ROOT = T; process.env.STARNET_URL = 'http://127.0.0.1:1';
const REPO = path.join(__dirname, '..', '..', '..');
const co = require(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
const meetingLib = require(path.join(REPO, 'console', 'meeting.js'));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

const PROFILES = {
  noah: { seat: 'noah', identity: { name: 'Noah' }, counterpart: { seat: 'ravi', signOff: ['promote'], why: 'tests every card' }, reminder: 'You are Noah, the scout. Reply only as Noah.' },
  ravi: { seat: 'ravi', identity: { name: 'Ravi' }, counterpart: null, reminder: 'You are Ravi, the tester. Reply only as Ravi; hold your position without new evidence.' },
};
function makeRunner() {
  const r = { queues: {}, calls: [], seq: 0, pending: new Map() };
  r.script = o => { for (const [k, v] of Object.entries(o)) (r.queues[k] = r.queues[k] || []).push(...[].concat(v)); };
  r.start = async o => {
    const kind = o.purpose === 'turn' ? '' : ':' + o.purpose; const q = r.queues[o.seat + kind] = r.queues[o.seat + kind] || [];
    let e = q.length ? q.shift() : (o.purpose === 'turn' ? 'PASS' : o.purpose === 'hand' ? 'NO' : 'OK');
    const runId = 'r' + (++r.seq);
    r.calls.push(Object.assign({ runId, last: o.messages[o.messages.length - 1].content, all: o.messages.map(m => m.content).join('\n') }, o));
    r.pending.set(runId, e); return { runId };
  };
  r.wait = async runId => { await new Promise(res => setTimeout(res, 3)); return { text: r.pending.get(runId), usd: 0.001, refused: false, complete: true, error: null }; };
  r.cancel = () => {};
  r.turns = seat => r.calls.filter(c => c.purpose === 'turn' && (!seat || c.seat === seat));
  return r;
}
function fresh(pov) {
  fs.rmSync(path.join(T, 'company/state/meetings'), { recursive: true, force: true });
  const runner = makeRunner();
  const M = meetingLib({ co, owner: () => 'Avery', runner, run: async () => ({ code: 0, data: {} }), speedMs: { fast: 1, normal: 1, slow: 1 }, seatBusy: async () => false,
    modelFor: async () => ({ provider: 'claude-cli', model: 'claude-sonnet-5-5' }), profileOf: id => PROFILES[id] || null, pov });
  M.seatsChange({ add: ['dana', 'noah', 'ravi'] }); M.setLeader({ seat: 'dana' });
  return { M, runner };
}
async function idle(M) { for (let i = 0; i < 400; i++) { if (M.idle()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('the meeting did not settle'); }

test('point of view: projected labels, STANCE parsed and stripped, the first take, the reminder last; the stored log is neutral', async () => {
  const { M, runner } = fresh(true);
  runner.script({ dana: ['We go with the weather card.', 'STANCE: ship — Ravi wants a test\n\nFine, a day of testing.'],
    noah: ['STANCE: try the bold card — Ravi wants a cheap test\n\nLet us try the weather markets this week.', 'STANCE: wait for the data\n\nOk, I am convinced, we wait.'],
    'ravi:draft': 'Test it on last month first; one day, kill it if fees eat it.', ravi: 'STANCE: test first — Noah wants to move fast\n\nOne day on last month\'s prices, then we decide.' });
  await M.say({ text: 'Should we chase the weather idea?' }); await idle(M);
  // the private first take: only Ravi (Noah's counterpart) drafts, talk only, before reading anyone
  const drafts = runner.calls.filter(c => c.purpose === 'draft');
  assert.deepStrictEqual(drafts.map(d => d.seat), ['ravi']);
  assert.strictEqual(drafts[0].tools, false);
  assert.ok(/Should we chase the weather idea\?/.test(drafts[0].all) && /Write your own position before you read anyone else: two to four sentences\./.test(drafts[0].all));
  assert.ok(!/weather markets this week|We go with the weather card/.test(drafts[0].all), 'the draft holds only the owner\'s message and its own profile');
  assert.ok(drafts[0].all.endsWith(PROFILES.ravi.reminder));
  // Ravi's real turn: Noah labelled as his counterpart, the owner as the owner, the draft and the re-check, the reminder last
  const ro = runner.turns('ravi')[0];
  assert.ok(ro.all.includes('Noah, your counterpart, said (stance: try the bold card — Ravi wants a cheap test): Let us try the weather markets this week.'), ro.all);
  assert.ok(ro.all.includes('Avery (the owner) said: Should we chase the weather idea?'));
  assert.ok(ro.all.includes('Dana said: We go with the weather card.'));
  assert.ok(ro.last.includes('[Your first take, before you read the others: "Test it on last month first; one day, kill it if fees eat it." Has anything said since given you new evidence? Say which, or hold your position.]'));
  assert.ok(ro.last.endsWith('\n\n' + PROFILES.ravi.reminder), 'the reminder is the last line of the turn');
  assert.ok(/Start every reply with a line of its own: STANCE:/.test(ro.all), 'the rule is in the table\'s rules');
  // Noah sees Ravi as his counterpart too (a second round); the draft is never in his history
  await M.say({ text: 'And now?' }); await idle(M);
  const be = runner.turns('noah')[1];
  assert.ok(be.all.includes('Ravi, your counterpart, said (stance: test first — Noah wants to move fast):'));
  assert.ok(!be.all.includes('Test it on last month first'), 'the draft is in nobody else\'s history');
  assert.ok(!runner.turns('dana')[1].all.includes('Test it on last month first'));
  // the stored log: neutral text, stance stored apart; the draft as its own event
  const LOG = M._state().LOG;
  const says = LOG.filter(e => e.kind === 'say' && e.who !== 'owner');
  assert.ok(says.every(e => !/^STANCE/m.test(e.text)), 'stripped');
  assert.strictEqual(says.find(e => e.who === 'ravi').stance, 'test first — Noah wants to move fast');
  assert.ok(LOG.some(e => e.kind === 'draft' && e.who === 'ravi' && /last month first/.test(e.text)));
  // Dana's first reply had no STANCE: a console note on his next turn (never a re-run)
  assert.ok(says.find(e => e.who === 'dana').nostance);
  assert.ok(runner.turns('dana')[1].last.includes('your last reply had no STANCE line'));
  assert.strictEqual(runner.turns('dana').length, 2, 'not re-run');
  const min = fs.readdirSync(path.join(T, 'company/work/meetings')).filter(f => /^meeting-/.test(f)).map(f => R('company/work/meetings/' + f)).join('');
  assert.ok(/_Stance: test first — Noah wants to move fast_/.test(min));
  assert.ok(/<details><summary>Ravi's first take, before hearing the others/.test(min));
  // echo stats at close: deterministic, one row in stats.jsonl, the close line carries them
  await M.close({});
  const rows = R('company/work/meetings/stats.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].seats, { noah: { replies: 2, withStance: 2, share: 1 }, dana: { replies: 2, withStance: 1, share: 0.5 }, ravi: { replies: 1, withStance: 1, share: 1 } });
  assert.deepStrictEqual(rows[0].unexplainedShifts.map(s => [s.seat, s.from, s.to]), [['noah', 'try the bold card — Ravi wants a cheap test', 'wait for the data']], 'Noah changed position citing no number, link or file');
  assert.ok(rows[0].pairs.every(p => p.overlap >= 0 && p.overlap <= 1));
  const close = M._state().LOG.find(e => e.kind === 'close');
  assert.ok(/^Echo check: 4 of 5 replies stated a stance/.test(close.echo), close.echo);
});

test('point of view off (the default outside the sandbox): one transcript for everyone, no STANCE rule, no first take, no reminder', async () => {
  const { M, runner } = fresh(false);
  runner.script({ dana: 'Go.', noah: 'STANCE: bold\n\nYes.', ravi: 'Test first.' });
  await M.say({ text: 'Weather?' }); await idle(M);
  assert.strictEqual(runner.calls.filter(c => c.purpose === 'draft').length, 0);
  const ro = runner.turns('ravi')[0];
  assert.ok(ro.all.includes('Noah: STANCE: bold') && ro.all.includes('Avery (owner): Weather?'));
  assert.ok(!/STANCE: <your position/.test(ro.all) && !ro.last.endsWith(PROFILES.ravi.reminder));
  await M.close({});
  assert.strictEqual(R('company/work/meetings/stats.jsonl').split('\n').filter(Boolean).length, 1, 'no new stats row with point of view off');
});
