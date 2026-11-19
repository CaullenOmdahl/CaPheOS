'use strict';
// meeting.test.js — the owner's meeting (console/meeting.js) with a scripted runner in place of the station: turn order
// and passes, @name, open rounds, the leader, observe, ASK / hands / CALL / LATER / LOWER, INVITE / DISMISS, seats for
// this meeting vs standing seats, talk only, minutes, the action register (END, RULING, ACTION; owner-confirmed rulings to decisions.md), refusal fallback, the owner-scope
// lint, halt, state files. The station path (isTask on the wire, admit, restart re-attach, owner-only) is
// tests/meeting-walk.js against tests/mock-station.js.
//   node --test company/tools/tests/meeting.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');
const { execFile } = require('child_process');

const T = require('../lib/temp-life').tmpDir('meeting-selftest-');
fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');   // provenance.fixtureRoot: this throwaway company answers owner checks, also when an agent runs the test
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const CREW = { dana: ['Dana', 'CEO'], zoe: ['Zoe', 'CFO'], paul: ['Paul', 'IT Admin'], reba: ['Reba', 'Hiring Manager'], nora: ['Nora', 'Engineer'], owen: ['Owen', 'DevOps'], luca: ['Luca', 'Designer'] };
const FNS = { dana: ['ceo', 'people', 'floor'], zoe: ['finance'], paul: ['risk'], nora: ['tools'] };
const agents = {}; for (const [id, [name, title]] of Object.entries(CREW)) agents[id] = Object.assign({ name, title, manager: id === 'dana' ? null : 'dana' }, FNS[id] ? { functions: FNS[id] } : {});
W('company/company.json', { name: 'Meeting Test', owner: { name: 'Avery' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents });
W('company/model-policy.json', { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5'] }, deepseek: { models: ['deepseek-flash'] } },
  seats: { dana: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } }, candidateDefault: { provider: 'deepseek', model: 'deepseek-flash' } });
W('company/work/decisions.md', '# Decisions\n\nNewest first. Who decided, what, why.\n\n');
process.env.CAPHEOS_ROOT = T; process.env.STARNET_URL = 'http://127.0.0.1:1';
const REPO = path.join(__dirname, '..', '..', '..');
const co = require(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
const meetingLib = require(path.join(REPO, 'console', 'meeting.js'));
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

/* a scripted runner: queues[seat | seat:hand | seat:call] = [reply | {text, refuse}] */
function makeRunner() {
  const r = { queues: {}, calls: [], seq: 0, live: 0, maxLive: 0, gate: null, pending: new Map() };
  r.script = o => { for (const [k, v] of Object.entries(o)) (r.queues[k] = r.queues[k] || []).push(...[].concat(v)); };
  r.start = async o => {
    const kind = o.purpose === 'turn' ? '' : ':' + o.purpose; const q = r.queues[o.seat + kind] = r.queues[o.seat + kind] || [];
    let e = q[0]; if (e === undefined) e = o.purpose === 'turn' ? 'PASS' : o.purpose === 'hand' ? 'NO' : 'OK';
    if (typeof e === 'string') e = { text: e };
    const refused = !!e.refuse && o.model.provider === 'claude-cli';
    if (!refused) q.shift();
    const runId = 'r' + (++r.seq);
    r.calls.push(Object.assign({ runId, last: o.messages[o.messages.length - 1].content, all: o.messages.map(m => m.content).join('\n') }, o));
    r.pending.set(runId, { text: e.text, refused, hold: e.hold, consent: e.consent });
    return { runId };
  };
  r.consents = [];
  r.wait = async (runId, onEvent) => {
    const p = r.pending.get(runId); r.live++; r.maxLive = Math.max(r.maxLive, r.live);
    await new Promise(res => setTimeout(res, 5));
    if (p.consent && onEvent) { await new Promise(res => { p.consentDone = res; onEvent({ name: 'permission.prompt', payload: { promptId: 'p-' + runId, tool: 'code.run', argsSummary: 'ls company/work' } }); }); }
    if (p.hold) await p.hold;
    r.live--;
    if (p.cancelled) return { text: '', usd: 0.001, refused: false, complete: false, error: 'cancelled' };
    return { text: p.refused ? '' : p.text, usd: 0.002, refused: p.refused, complete: !p.refused, error: null };
  };
  r.consent = (runId, promptId, decision) => { r.consents.push({ runId, promptId, decision }); const p = r.pending.get(runId); if (p && p.consentDone) p.consentDone(); };
  r.cancel = runId => { const p = r.pending.get(runId); if (p) p.cancelled = true; };
  r.turns = () => r.calls.filter(c => c.purpose === 'turn');
  return r;
}
const run = (name, args) => new Promise(resolve => execFile(process.execPath, [path.join(REPO, 'company', 'tools', name)].concat(args), { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) }, (err, out, errOut) => resolve({ code: err ? err.code || 1 : 0, data: { text: out, error: errOut } })));
function fresh(opts) {
  for (const f of ['company/state/meetings']) fs.rmSync(path.join(T, f), { recursive: true, force: true });
  const runner = makeRunner();
  const models = (opts && opts.models) || {};
  const M = meetingLib(Object.assign({ co, owner: () => 'Avery', runner, run, speedMs: { fast: 1, normal: 1, slow: 1 }, consentPollMs: 20, seatBusy: async id => !!(opts && opts.busy && opts.busy.includes(id)), modelFor: async id => models[id] || { provider: 'claude-cli', model: 'claude-sonnet-5-5' } }, (opts && opts.deps) || {}));
  if (opts && opts.seats && Object.keys(CREW).some(x => !opts.seats.includes(x))) M.seatsChange({ remove: Object.keys(CREW).filter(x => !opts.seats.includes(x)) });
  if (opts && opts.seats) M.seatsChange({ add: opts.seats });
  if (opts && 'leader' in opts) M.setLeader({ seat: opts.leader });
  return { M, runner };
}
async function idle(M) { for (let i = 0; i < 400; i++) { if (M.idle()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('the meeting did not settle'); }
const said = M => M._state().LOG.filter(e => e.kind === 'say').map(e => e.who + ': ' + e.text);
const kinds = (M, k) => M._state().LOG.filter(e => e.kind === k);

test('turn order: everyone seated in turn, the leader first, each seeing what came before; a pass is one dim line', async () => {
  const { M, runner } = fresh({ seats: ['zoe', 'paul', 'dana'], leader: 'dana' });
  runner.script({ dana: 'Dana here.', zoe: 'PASS', paul: 'Paul agrees with Dana.' });
  await M.say({ text: 'What should we do first?' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe', 'paul'], 'the leader first, then the standing order');
  const paul = runner.turns()[2];
  assert.ok(/Avery \(owner\): What should we do first\?/.test(paul.all) && /Dana: Dana here\./.test(paul.all), 'Paul sees the owner and Dana');
  assert.deepStrictEqual(said(M), ['owner: What should we do first?', 'dana: Dana here.', 'paul: Paul agrees with Dana.']);
  const e = M.entries(new URLSearchParams()).entries;
  assert.deepStrictEqual(e.filter(x => x.kind === 'pass').map(x => x.who), ['zoe'], 'a pass is shown, as at the table ("Zoe passes")');
  assert.ok(kinds(M, 'pass').length === 1, 'and kept, so Zoe is not asked again with nothing new');
  // the meeting carries on: the next message sees the earlier part; New meeting starts clean with the same seats
  runner.script({ dana: 'Still here.' });
  await M.say({ text: 'And next?' }); await idle(M);
  assert.ok(/Dana here\./.test(runner.turns().filter(c => c.seat === 'dana').pop().all), 'the meeting carries on');
  await assert.rejects(async () => M.newMeeting(), /one meeting at a time: close this meeting first/);
  await M.close({}); await M.newMeeting();
  runner.script({ dana: 'Fresh start.' });
  await M.say({ text: 'New topic.' }); await idle(M);
  const last = runner.turns().filter(c => c.seat === 'dana').pop();
  assert.ok(!/Dana here\./.test(last.all) && /New topic/.test(last.all), 'New meeting: same seats, nothing from before');
  assert.deepStrictEqual((await M.view()).seats.map(s => s.id), ['dana', 'zoe', 'paul'], 'same seats after New meeting');
});

test('@name: a message that starts with @names goes only to those seats', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  runner.script({ paul: 'Only me.' });
  await M.say({ text: '@paul what is the risk?' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['paul']);
  assert.ok(/Avery put this to Paul/.test(runner.turns()[0].last));
  await assert.rejects(async () => M.say({ text: '@nobody hello' }), /nobody called @nobody/);
  await assert.rejects(async () => M.say({ text: '@reba hello' }), /Reba is not seated/);
});

test('Round: an open round with no new owner message; only seats with something new speak', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: 'Opening.', zoe: 'Answer to Dana.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const n = runner.turns().length;
  runner.script({ dana: 'Replying to Zoe.' });
  await M.openRound(); await idle(M);
  const round = runner.turns().slice(n);
  assert.strictEqual(round[0].seat, 'dana');
  assert.ok(/No new message from Avery: this is an open round/.test(round[0].last), round[0].last);
  assert.ok(!said(M).some(x => x.startsWith('owner:') && x !== 'owner: Go.'), 'no owner message in an open round');
});

test('the leader: speaks first, can be set, kept across meetings, "no leader" works, and cannot be dismissed', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'zoe' });
  runner.script({ dana: 'Done here.\nDISMISS: Zoe — her part is done', zoe: 'I lead.' });
  await M.say({ text: 'Start.' }); await idle(M);
  assert.strictEqual(runner.turns()[0].seat, 'zoe', 'the leader speaks first');
  assert.ok(/You lead this meeting/.test(runner.turns()[0].last));
  assert.ok((await M.view()).seats.some(s => s.id === 'zoe' && s.leader), 'the leader stays');
  assert.ok(kinds(M, 'note').some(e => /who leads the meeting; only the owner changes that/.test(e.text)));
  await M.close({}); await M.newMeeting();
  assert.strictEqual((await M.view()).meeting.leader, 'zoe', 'kept across meetings');
  M.setLeader({ seat: null });
  assert.strictEqual((await M.view()).meeting.leader, null, 'no leader');
  const def = meetingLib({ co, owner: () => 'Avery', runner, run, modelFor: async () => ({ provider: 'claude-cli', model: 'x' }) });
  fs.rmSync(path.join(T, 'company/state/meetings/seats.json'));
  def._reload();
  assert.strictEqual((await def.view()).meeting.leader, 'dana', 'the default leader is the CEO seat');
});

test('observe: no owner turn, told not to ask the owner, carries on up to N rounds; stops on END or a silent round', async () => {
  let { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  M.setObserve({ on: true, rounds: 4 });
  runner.script({ dana: ['Plan A.', 'Agreed.\nEND: Plan A, Zoe writes it up — plain: we go with plan A and Zoe writes it down'], zoe: ['Plan A works.', 'PASS'] });
  await M.say({ text: 'Decide among yourselves.' }); await idle(M);
  assert.ok(runner.turns().every(c => /Avery is observing: they will not speak unless they step in, so do not put questions to them/.test(c.last)), 'told not to ask the owner');
  assert.ok(/Open round, carried on without Avery/.test(runner.turns()[2].last), 'the second round started by itself');
  assert.strictEqual(kinds(M, 'end').length, 1, 'END closes it');
  assert.strictEqual(runner.turns().length, 3, 'nothing after END');
  const rg = M.registerView();
  assert.ok(rg.register.summary && rg.register.summary.text === 'Plan A, Zoe writes it up' && rg.register.summary.plain === 'we go with plan A and Zoe writes it down', 'END is the register\'s summary with its plain line');
  assert.ok(!/Plan A, Zoe writes it up/.test(R('company/work/decisions.md')), 'an END is not an owner ruling: not in decisions.md');
  // a round with nothing said stops it
  ({ M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' }));
  M.setObserve({ on: true, rounds: 6 });
  runner.script({ dana: ['One.'], zoe: ['Two.'] });
  await M.say({ text: 'Talk.' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /gone quiet/.test(e.text)), 'a silent round stops it');
  // the cap: N rounds at most
  ({ M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' }));
  M.setObserve({ on: true, rounds: 2 });
  runner.script({ dana: ['a', 'b', 'c', 'd'], zoe: ['e', 'f', 'g', 'h'] });
  await M.say({ text: 'Talk.' }); await idle(M);
  assert.strictEqual(runner.turns().length, 4, '2 rounds of 2');
  assert.ok(kinds(M, 'note').some(e => /2 rounds ran on their own/.test(e.text)));
  M.setObserve({ on: false });
  assert.strictEqual((await M.view()).meeting.observer, false, 'Take part');
});

test('ASK: the seat answers next and may ask back; at most 6 direct questions a round', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: null });
  const back = i => 'Point ' + i + '.\nASK: ' + (i % 2 ? 'Dana' : 'Zoe') + ' — question ' + (i + 1) + '?';
  runner.script({ dana: ['Start.\nASK: Zoe — question 1?', back(2), back(4), back(6)], zoe: [back(1), back(3), back(5), back(7)] });
  await M.say({ text: 'Go.' }); await idle(M);
  const order = runner.turns().map(c => c.seat);
  assert.deepStrictEqual(order.slice(0, 7), ['dana', 'zoe', 'dana', 'zoe', 'dana', 'zoe', 'dana'], 'each question is answered next, and asked back: ' + order.join());
  assert.strictEqual(kinds(M, 'ask').length, 6, 'six direct questions');
  assert.ok(kinds(M, 'note').some(e => /has had 6 direct questions/.test(e.text)));
  assert.ok(/Zoe asked you directly: question 2\? Answer Zoe, Dana; you may ASK back/.test(runner.turns()[2].last));
  assert.ok(runner.turns().some(c => c.seat === 'paul'), 'the normal order carries on after the exchange');
  // ASK of someone not seated calls them in
  const t2 = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  t2.runner.script({ dana: 'ASK: Owen — can you deploy?', owen: 'Yes.' });
  await t2.M.say({ text: 'Go.' }); await idle(t2.M);
  assert.ok(kinds(t2.M, 'join').some(e => e.who === 'owen' && e.by === 'dana'));
  assert.strictEqual(t2.runner.turns()[1].seat, 'owen');
});

test('hands: after each answer the others are polled in parallel, talk only; at most 3 hands a round; no leader: a hand speaks next', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul', 'reba', 'nora'], leader: null });
  runner.script({ dana: ['ASK: Zoe — q1?', 'ASK: Zoe — q2?'], zoe: ['a1.', 'a2.'],
    'paul:hand': ['HAND — on cost'], 'reba:hand': ['HAND — on hiring'], 'nora:hand': ['NO', 'HAND — on tools'], 'paul:hand ': [] });
  runner.script({ paul: ['Cost point.\nASK: Zoe — q3?'], reba: ['Hiring point.'], 'paul:hand': [], 'reba:hand': [] });
  runner.script({ 'nora:hand': [] });
  runner.script({ zoe: ['a3.'] });
  // after a3 the poll would give hands again, but the round has had 3
  runner.script({ 'dana:hand': ['HAND — me too'], 'reba:hand': ['HAND — again'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const checks = runner.calls.filter(c => c.purpose === 'hand');
  assert.ok(checks.length >= 3 && checks.every(c => c.tools === false), 'hand checks are talk only');
  assert.ok(runner.maxLive >= 2, 'polled in parallel (' + runner.maxLive + ' at once)');
  assert.ok(kinds(M, 'hand').length <= 3, 'at most 3 hands a round: ' + kinds(M, 'hand').length);
  const order = runner.turns().map(c => c.seat);
  assert.strictEqual(order[2], 'paul', 'no leader: a raised hand speaks next: ' + order.join());
  assert.ok(kinds(M, 'say').some(e => e.who === 'paul' && e.interject), 'recorded as interjecting');
});

test('CALL / LATER / LOWER: with a leader, the leader decides raised hands; CALL: at the end of any leader reply', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul', 'reba', 'nora'], leader: 'dana' });
  runner.script({ dana: ['Zoe, over to you.\nASK: Zoe — the budget?', 'Wrap: thanks.'], zoe: ['Budget is fine.'], 'reba:hand': ['HAND — a hire'], 'nora:hand': ['HAND — a tool'], 'paul:hand': ['HAND — risk'],
    'dana:call': ['CALL: Reba\nLATER: Paul\nLOWER: Nora'], reba: ['The hire point.'], paul: ['The risk point.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const order = runner.turns().map(c => c.seat);
  assert.deepStrictEqual(order.slice(0, 4), ['dana', 'zoe', 'reba', 'paul'], 'CALL now, then LATER once the exchange is done: ' + order.join());
  assert.ok(runner.calls.some(c => c.purpose === 'call' && c.tools === false && /RAISED HANDS/.test(c.last)), 'the leader decides, talk only');
  assert.ok(kinds(M, 'lower').some(e => e.to === 'nora'), 'LOWER');
  assert.ok(kinds(M, 'call').some(e => e.to === 'paul' && e.later), 'LATER');
  assert.ok(!kinds(M, 'say').some(e => e.who === 'nora' && e.interject), 'a lowered hand does not get the floor');
  // CALL: at the end of a leader's reply gives the floor next
  const t2 = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  t2.runner.script({ dana: 'Paul first.\nCALL: Paul', paul: 'Here.', zoe: 'Me.' });
  await t2.M.say({ text: 'Go.' }); await idle(t2.M);
  assert.deepStrictEqual(t2.runner.turns().map(c => c.seat).slice(0, 2), ['dana', 'paul']);
  // only the leader calls on people
  const t3 = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  t3.runner.script({ zoe: 'CALL: Paul' });
  await t3.M.say({ text: 'Go.' }); await idle(t3.M);
  assert.ok(kinds(t3.M, 'note').some(e => /only the leader calls on people/.test(e.text)));
});

test('INVITE: joins at once, speaks after the others that round, at most 3 a round', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  runner.script({ dana: 'We need people.\nINVITE: Reba, Nora, Owen, Luca — the plan needs them', reba: 'R.', nora: 'N.', owen: 'O.', zoe: 'S.', paul: 'P.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe', 'paul', 'reba', 'nora', 'owen'], 'after the others, in order');
  assert.strictEqual(kinds(M, 'join').length, 3);
  assert.ok(kinds(M, 'note').some(e => /invited Luca: not this round, 3 people were invited already/.test(e.text)));
  assert.ok(/Dana: We need people\./.test(runner.turns()[3].all), 'an invited seat sees the meeting so far');
});

test('DISMISS and seats: agent changes last for this meeting only; the owner\'s add and remove set the standing seats', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  runner.script({ dana: 'INVITE: Reba — hiring', paul: 'Nothing more from me.\nDISMISS: me — my part is done', reba: 'Hi.' });
  await M.say({ text: 'Go.' }); await idle(M);
  let v = await M.view();
  assert.ok(!v.seats.some(s => s.id === 'paul') && v.seats.some(s => s.id === 'reba' && s.guest && s.invitedBy === 'dana'), 'Paul left, Reba is a guest');
  assert.ok(kinds(M, 'leave').some(e => e.who === 'paul' && e.by === 'paul'));
  await M.close({}); await M.newMeeting();
  v = await M.view();
  assert.deepStrictEqual(v.seats.map(s => s.id), ['dana', 'zoe', 'paul'], 'the next meeting: standing seats again (Paul back, Reba gone)');
  // the owner's changes override: adding a dismissed seat seats it for good; removing a guest
  runner.script({ paul: 'DISMISS: me — done', dana: 'INVITE: Nora — tools' });
  await M.say({ text: 'Again.' }); await idle(M);
  M.seatsChange({ add: ['paul'], remove: ['nora'] });
  v = await M.view();
  assert.ok(v.seats.some(s => s.id === 'paul' && s.standing) && !v.seats.some(s => s.id === 'nora'));
  M.seatsChange({ add: ['nora'] }); await M.close({}); await M.newMeeting();
  assert.ok((await M.view()).seats.some(s => s.id === 'nora' && s.standing), 'the owner\'s add is a standing seat');
});

test('tools are on by default, as at the table; Talk only switches them off for the meeting; an agenda item can set its own; hand checks stay talk only', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  runner.script({ dana: 'ASK: Zoe — budget?', zoe: 'Fine.' });
  await M.say({ text: 'Tools by default.' }); await idle(M);
  const turns = runner.turns(), checks = runner.calls.filter(c => c.purpose !== 'turn');
  assert.ok(turns.length >= 2 && turns.every(c => c.tools === true), 'every turn has tools: ' + turns.map(c => c.tools));
  assert.ok(checks.length && checks.every(c => c.tools === false), 'hand checks and the leader\'s call are talk only');
  assert.ok(!/Talk only/.test(turns[0].last), 'no talk-only line when tools are on');
  assert.strictEqual((await M.view()).meeting.toolsOn, true);
  await M.setTalkOnly({ on: true });
  runner.script({ dana: 'a', zoe: 'b', paul: 'c' });
  let n = runner.calls.length;
  await M.say({ text: 'Now talk only.' }); await idle(M);
  let after = runner.calls.slice(n).filter(c => c.purpose === 'turn');
  assert.ok(after.length && after.every(c => c.tools === false && /Talk only: nobody has tools/.test(c.last)), 'Talk only: no tools on any turn');
  assert.strictEqual((await M.view()).meeting.talkOnly, true, 'kept with the seats');
  M.agenda({ op: 'add', title: 'Check the ledger' });
  const it = (await M.view()).meeting.agenda[0];
  assert.strictEqual(it.toolsOn, false, 'a new item follows the meeting');
  M.agenda({ op: 'tools', id: it.id, on: true });
  runner.script({ dana: 'c', zoe: 'd', paul: 'e' });
  n = runner.calls.length;
  await M.say({ text: 'Now with tools.' }); await idle(M);
  after = runner.calls.slice(n).filter(c => c.purpose === 'turn');
  assert.ok(after.length && after.every(c => c.tools === true && /Agenda item now: Check the ledger/.test(c.last)), 'tools on for that item');
  M.agenda({ op: 'add', title: 'Next topic' }); const it2 = (await M.view()).meeting.agenda[1];
  M.agenda({ op: 'current', id: it2.id });
  assert.strictEqual((await M.view()).meeting.toolsOn, false, 'the next item follows the meeting again');
  await M.setTalkOnly({ on: false });
  assert.strictEqual((await M.view()).meeting.toolsOn, true);
});

test('admit: every turn passes admit() as a meeting-turn (zero-token check), and no budget file is created', async () => {
  const before = new Set(listAll(T));
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: 'x', zoe: 'y' });
  const f = path.join(T, 'company/state/admit-log.jsonl'); const n0 = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).length;
  await M.say({ text: 'admit' }); await idle(M);
  const rows = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).slice(n0).map(l => JSON.parse(l));
  assert.strictEqual(rows.length, runner.calls.length, 'one admit row per run');
  assert.ok(rows.every(r => r.door === 'meeting' && r.kind === 'meeting-turn' && r.decision === 'allow' && r.meetingId), JSON.stringify(rows));
  const created = listAll(T).filter(x => !before.has(x));
  assert.ok(!created.some(x => /budget|envelope|estimate/i.test(x)), 'no budget file: ' + created.join());
  const A = require(path.join(REPO, 'company/tools/lib/admit.js'));
  assert.strictEqual(A.admit({ door: 'meeting', kind: 'meeting-turn', seat: 'dana', owner: false }, { file: null }).decision, 'refuse', 'a turn of a meeting the owner did not open is refused');
});
function listAll(dir, out, base) { out = out || []; base = base || dir; for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) listAll(p, out, base); else out.push(path.relative(base, p)); } return out; }

test('owner-only: inside an agent\'s or a routine\'s run, nothing can start, steer or close a meeting', async () => {
  const { M } = fresh({ seats: ['dana'], leader: 'dana' });
  const prov = require(path.join(REPO, 'company/tools/provenance.js'));
  prov.pinUnderStation(true);
  try {
    for (const [what, fn] of [['start', () => M.say({ text: 'hi' })], ['a round', () => M.openRound()], ['steer', () => M.setLeader({ seat: 'dana' })], ['seats', () => M.seatsChange({ add: ['paul'] })],
      ['new', () => M.newMeeting()], ['close', () => M.close({})], ['agenda', () => M.agenda({ op: 'add', title: 'x' })]])
      await assert.rejects(async () => fn(), /the meeting is the owner's/, what);
  } finally { prov.pinUnderStation(null); }
});

test('Close without END records closed and who closed it; meeting states; one meeting at a time; an incident interrupts and the meeting resumes', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: 'No END from me.', zoe: 'Nor me.' });
  await M.say({ text: 'Talk.' }); await idle(M);
  await M.close({ why: 'enough for today' });
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'closed'); assert.strictEqual(v.meeting.closedBy, 'Avery');
  assert.ok(kinds(M, 'close').some(e => e.who === 'owner' && e.state === 'closed' && e.why === 'enough for today'));
  assert.ok(/The meeting was closed by Avery: enough for today/.test(R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md')));
  await assert.rejects(async () => M.say({ text: 'again?' }), /this meeting is closed/);
  // an incident meeting interrupts a planning meeting; closing it resumes the planning meeting
  await M.newMeeting({ type: 'planning', title: 'Q1 plan' });
  runner.script({ dana: 'Plan point.' });
  await M.say({ text: 'Plan.' }); await idle(M);
  const planId = (await M.view()).meeting.id;
  await assert.rejects(async () => M.newMeeting({ type: 'review' }), /one meeting at a time/);
  await M.newMeeting({ type: 'incident', title: 'Site down' });
  assert.strictEqual(M.list().find(m => m.id === planId).state, 'interrupted');
  runner.script({ dana: 'Incident point.' });
  await M.say({ text: 'What broke?' }); await idle(M);
  assert.ok(/This is an incident meeting/.test(runner.turns().pop().last), 'the type selects the prompt block');
  await M.close({});
  const back = await M.view();
  assert.ok(back.meeting.id === planId && back.meeting.state === 'open', 'the planning meeting carries on');
  // close during a round stops it first
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: { text: 'long', hold }, zoe: 'never' });
  await M.say({ text: 'One more.' }); await new Promise(r => setTimeout(r, 30));
  const p = M.close({}); release(); await p;
  assert.strictEqual((await M.view()).meeting.state, 'closed');
  assert.ok(!runner.turns().some(c => c.seat === 'zoe' && /One more/.test(c.all) && c.last.includes('Your turn, Zoe') && c.all.includes('long')), 'nobody after the close');
});

test('a malformed ASK / CALL / END surfaces a visible parse failure, and the writer is told', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: ['My view.\nASK Zoe what about cost?\nEND -  done\nCALL: Nobody', 'Fixed.'], zoe: ['Ok.', 'Ok.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const pf = kinds(M, 'parse');
  assert.ok(pf.some(e => /^ASK Zoe/.test(e.line) && /needs a colon/.test(e.why)), JSON.stringify(pf));
  assert.ok(pf.some(e => /^END/.test(e.line)), 'END without a colon');
  assert.ok(pf.some(e => /CALL: Nobody/.test(e.line) && /nobody called Nobody/.test(e.why)), 'an unknown name');
  const said0 = kinds(M, 'say').find(e => e.who === 'dana');
  assert.ok(/ASK Zoe what about cost\?/.test(said0.text), 'the unreadable line stays visible in what was said');
  assert.ok(M.entries(new URLSearchParams()).entries.some(e => e.kind === 'parse'), 'shown on the page');
  await M.say({ text: 'Again.' }); await idle(M);
  assert.ok(/could not be read, so nothing was done with them/.test(runner.turns().filter(c => c.seat === 'dana').pop().last), 'the writer is told on the next turn');
});

test('minutes: written as it happens, every word by speaker with times and models, in the reference shape', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'paul'], leader: 'dana', models: { paul: { provider: 'deepseek', model: 'deepseek-flash' } } });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: 'First words.\nRULING: Paul owns the fix — plain: Paul fixes it', paul: { text: 'Second words.', hold } });
  await M.say({ text: 'Minutes check.' });
  const day = co.localParts(new Date()).date; const f = 'company/work/meetings/meeting-' + day + '.md';
  for (let i = 0; i < 200 && !/First words/.test(R(f)); i++) await new Promise(r => setTimeout(r, 10));
  const mid = R(f);
  assert.ok(/^# Meeting: \d{4}-\d{2}-\d{2}/.test(mid) && /## \d\d:\d\d: the meeting opens/.test(mid) && /\*\*Avery\*\* \(\d\d:\d\d\):\nMinutes check\./.test(mid) && /\*\*Dana\*\* \(\d\d:\d\d, Claude Sonnet\):\nFirst words\./.test(mid), 'written as it happens: ' + mid);
  assert.ok(!/Second words/.test(mid), 'Paul has not spoken yet');
  release(); await idle(M);
  const all = R(f);
  assert.ok(/\*\*Paul\*\* \(\d\d:\d\d, DeepSeek \(deepseek-flash\)\):\nSecond words\./.test(all), all);
  assert.ok(/_\d\d:\d\d: Dana proposed a ruling for Avery to confirm: Paul owns the fix\._/.test(all));
  assert.ok(!/Paul owns the fix/.test(R('company/work/decisions.md')), 'a proposed ruling is not in decisions.md until the owner confirms it');
  assert.ok(!/PASS/.test(all), 'passes are not shown');
});

test('a refused turn mid-meeting is retried once on the next chain entry, said in one plain line', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: { text: 'Answered on the next model.', refuse: true }, zoe: 'Fine.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const d = runner.turns().filter(c => c.seat === 'dana');
  assert.deepStrictEqual(d.map(c => c.model.provider), ['claude-cli', 'deepseek']);
  assert.ok(kinds(M, 'note').some(e => e.text === 'Dana: Claude declined this; DeepSeek is answering instead.'));
  assert.ok(kinds(M, 'say').some(e => e.who === 'dana' && e.model === 'DeepSeek (deepseek-flash)' && /next model/.test(e.text)));
  assert.ok(/"door":"meeting"/.test(R('company/state/model-moves.jsonl')), 'recorded on the seat');
  assert.strictEqual(runner.turns().filter(c => c.seat === 'zoe').length, 1, 'the meeting carries on');
});

test('owner scope: crew work put to the owner is flagged and corrected on the next turn; while observing, any question to the owner', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ zoe: ['Could you add a healthchecks check named recorder, period 5, grace 15, and paste its ping URL?', 'Handled it myself.'], dana: ['Ok.', 'Ok.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const s = kinds(M, 'say').find(e => e.who === 'zoe');
  assert.ok(s.lint && s.lint.kind === 'crew-scope', JSON.stringify(s));
  await M.say({ text: 'Next.' }); await idle(M);
  assert.ok(/Console note on your last reply: it puts crew work to Avery/.test(runner.turns().filter(c => c.seat === 'zoe').pop().last));
  M.setObserve({ on: true, rounds: 1 });
  runner.script({ dana: 'Avery, could you confirm the budget before we go on?\nASK: Avery — which market?' });
  await M.say({ text: 'Observe.' }); await idle(M);
  const q = kinds(M, 'say').filter(e => e.who === 'dana').pop();
  assert.ok(q.lint && q.lint.kind === 'observe-question', JSON.stringify(q));
  assert.ok(kinds(M, 'note').some(e => /put a question to Avery, who is observing/.test(e.text)), 'an ASK of the observing owner is not put to them');
});

test('Raise hand, Continue, Stop round, a message during a round', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: { text: 'Long answer.', hold }, zoe: 'S.', paul: 'P.' });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  M.hand();
  assert.strictEqual((await M.view()).live.ownerHand, true);
  release();
  for (let i = 0; i < 100 && (await M.view()).live.phase !== 'floor'; i++) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual((await M.view()).live.phase, 'floor', 'the floor is the owner\'s after the current speaker');
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana']);
  M.carryOn(); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe', 'paul'], 'Continue lets them carry on');
  // a message typed while a round runs starts the next round after the current speaker
  let rel2; const hold2 = new Promise(r => { rel2 = r; });
  runner.script({ dana: [{ text: 'Again.', hold: hold2 }, 'On your point.'], zoe: ['S2.', 'S3.'], paul: ['P2.', 'P3.'] });
  await M.say({ text: 'Round two.' });
  await new Promise(r => setTimeout(r, 30));
  await M.say({ text: 'Actually, one more thing.' });
  rel2(); await idle(M);
  const after = said(M).slice(-4);
  assert.deepStrictEqual(after[0], 'owner: Actually, one more thing.', 'taken after the current speaker: ' + said(M).join(' | '));
  // Stop = stop after this turn: the speaker finishes (never cancelled), nobody after
  let rel3; const hold3 = new Promise(r => { rel3 = r; });
  runner.script({ dana: { text: 'Finished anyway.', hold: hold3 } });
  const n = runner.turns().length;
  await M.say({ text: 'Stop test.' });
  await new Promise(r => setTimeout(r, 30));
  const sv = await M.stop();
  assert.match(sv.note, /^Stopping after Dana finishes this turn/, sv.note);
  assert.strictEqual(sv.live.phase, 'stopping'); assert.strictEqual(sv.live.stoppingAfter, 'Dana');
  rel3(); await idle(M);
  assert.ok(!runner.pending.get(runner.turns()[n].runId).cancelled, 'the turn in flight is not cancelled');
  assert.strictEqual(runner.turns().length, n + 1, 'nobody after the stopped speaker');
  assert.ok(said(M).includes('dana: Finished anyway.'), 'what they said is kept');
  assert.ok(kinds(M, 'note').some(e => e.text === 'Round stopped.'));
});

test('soft halt: the turn in progress finishes, the minutes are written, the meeting is interrupted', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: { text: 'I finish my sentence.', hold }, zoe: 'never' });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  W('company/state/halt.json', { mode: 'soft', by: 'Avery' });
  await new Promise(r => setTimeout(r, 1200));
  assert.ok(!runner.pending.get(runner.turns()[0].runId).cancelled, 'a soft halt does not cut the turn off');
  release(); await idle(M);
  assert.ok(kinds(M, 'say').some(e => e.who === 'dana' && e.text === 'I finish my sentence.'), 'the turn finished whole');
  assert.ok(!runner.turns().some(c => c.seat === 'zoe'), 'nobody starts after it');
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'interrupted'); assert.match(v.meeting.reason, /soft halt/);
  const mins = R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md');
  assert.ok(/I finish my sentence\./.test(mins) && /The meeting was interrupted: soft halt/.test(mins), 'the minutes are written');
  await assert.rejects(async () => M.say({ text: 'Hello?' }), /halt/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
});

test('hard halt: the turn is aborted, the meeting marked interrupted, and it can be resumed after the halt', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: { text: 'Mid-sentence', hold }, zoe: ['never', 'After the halt.'] });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  W('company/state/halt.json', { mode: 'hard', by: 'Avery' });
  await new Promise(r => setTimeout(r, 1200)); release(); await idle(M);
  assert.ok(runner.pending.get(runner.turns()[0].runId).cancelled, 'the turn in flight is cancelled');
  assert.ok(!runner.turns().some(c => c.seat === 'zoe'), 'nobody speaks after the halt');
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'interrupted'); assert.match(v.meeting.reason, /hard halt: aborted/);
  await assert.rejects(async () => M.resume({}), /halt/, 'not under the halt');
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  await M.resume({});
  assert.strictEqual((await M.view()).meeting.state, 'open', 'resumable');
  await M.say({ text: '@zoe carry on' }); await idle(M);
  assert.ok(kinds(M, 'say').some(e => e.who === 'zoe'));
});

test('a consent prompt inside a turn goes to the approvals path (Today) and pauses the meeting until answered', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  M.agenda({ op: 'add', title: 'Check', tools: true });
  runner.script({ dana: { text: 'I checked the folder.', consent: true }, zoe: 'Thanks.' });
  await M.say({ text: 'Check it.' });
  let v; for (let i = 0; i < 100; i++) { v = await M.view(); if (v.live.pausedFor) break; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(v.live.paused && v.live.pausedFor && v.live.pausedFor.tool === 'code.run' && v.live.pausedFor.qid, JSON.stringify(v.live));
  const inbox = require(path.join(REPO, 'company/tools/inbox.js'));
  const q = inbox.state()[v.live.pausedFor.qid];
  assert.ok(q && q.type === 'ask' && /Dana wants to use code\.run during your meeting/.test(q.message), 'an owner question on Today');
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(runner.calls.map(c => c.seat), ['dana'], 'nothing else starts while it waits');
  const prov = require(path.join(REPO, 'company/tools/provenance.js'));
  prov.pinOwnerShell(true);
  try { inbox.answer({ id: q.id, a: 'yes', answer: { verdict: 'yes' }, by: 'owner' }); } finally { prov.pinOwnerShell(null); }
  await idle(M);
  assert.deepStrictEqual(runner.consents.map(c => c.decision), ['once'], 'the answer goes back to the station');
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe'], 'then the meeting carries on');
  assert.ok(kinds(M, 'consent').some(e => e.op === 'answered' && e.decision === 'once'));
});

test('a seat in the middle of a routine run still speaks, talk only for that turn, with a note to it and one dim line', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana', busy: ['zoe'] });
  runner.script({ dana: 'D.', zoe: 'From what I know.', paul: 'P.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe', 'paul'], 'nobody sits out');
  const sh = runner.turns()[1];
  assert.strictEqual(sh.tools, false, 'the busy seat has no tools this turn');
  assert.ok(/You are in the middle of a routine run, so you have no tools this turn: say what you know\./.test(sh.last), sh.last);
  assert.ok(runner.turns()[0].tools === true && runner.turns()[2].tools === true, 'the others keep their tools');
  assert.ok(kinds(M, 'say').some(e => e.who === 'zoe' && e.text === 'From what I know.'));
  assert.ok(kinds(M, 'note').some(e => e.text === 'Zoe is in the middle of a routine run, so Zoe speaks without tools this turn.'));
  assert.ok(/_\d\d:\d\d: Zoe is in the middle of a routine run/.test(R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md')), 'one dim line in the minutes');
});

test('a turn\'s tool steps are kept on its entry (the page\'s "· Name: …" lines); workspace-busy gets one dim line and the turn carries on', async () => {
  const { M, runner } = fresh({ seats: ['dana'], leader: 'dana' });
  const wait0 = runner.wait;
  runner.wait = async (runId, onEvent) => { if (onEvent) { onEvent({ name: 'agent.tool_call', payload: { name: 'fs_read', argsSummary: 'company/CHARTER.md' } }); onEvent({ name: 'agent.tool_call', payload: { name: 'fs_write', argsSummary: 'company/work/x.md' } }); onEvent({ name: 'agent.tool_result', payload: { ok: false, summary: 'workspace-busy' } }); onEvent({ name: 'agent.tool_result', payload: { ok: false, summary: 'workspace-busy' } }); } return wait0(runId, onEvent); };
  runner.script({ dana: 'Answered without writing.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const n = kinds(M, 'note').filter(e => /routine is using the company folder; Dana answers without changing files/.test(e.text));
  assert.strictEqual(n.length, 1, 'once per turn');
  const say = kinds(M, 'say').find(e => e.who === 'dana' && e.text === 'Answered without writing.');
  assert.deepStrictEqual(say && say.tools, [{ name: 'fs_read', args: 'company/CHARTER.md' }, { name: 'fs_write', args: 'company/work/x.md' }], 'the steps, in order');
  assert.ok(!/fs_read/.test(R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md')), 'not in the minutes (every word said, as at the table)');
});

test('state: under company/state/meetings, mode 600, read bounded, covered by retention', async () => {
  const { M, runner } = fresh({ seats: ['dana'], leader: 'dana' });
  runner.script({ dana: 'x' });
  await M.say({ text: 'state' }); await idle(M);
  const id = (await M.view()).meeting.id;
  for (const f of ['seats.json', 'current.json', 'm/' + id + '.json', 'events/' + id + '.jsonl']) assert.strictEqual(fs.statSync(path.join(T, 'company/state/meetings', f)).mode & 0o777, 0o600, f);
  for (const d of ['', 'm', 'events']) assert.strictEqual(fs.statSync(path.join(T, 'company/state/meetings', d)).mode & 0o777, 0o700, d);
  const ret = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/ops/retention.json'), 'utf8')).artifacts;
  assert.ok(ret.some(a => a.path === 'company/state/meetings/events/*.jsonl' && a.policy === 'roll-monthly' && a.maxLiveBytes), 'each meeting\'s events are bounded by retention.js');
  assert.ok(/tailText\(F\.events\(id\), LOG_READ_BYTES\)/.test(fs.readFileSync(path.join(REPO, 'console/meeting.js'), 'utf8')), 'read from its end (lib/bounded.js)');
  // a console restart reads the meeting back
  const again = meetingLib({ co, owner: () => 'Avery', runner, run, modelFor: async () => ({ provider: 'claude-cli', model: 'x' }) });
  assert.ok(again._state().LOG.some(e => e.kind === 'say' && e.text === 'x'));
  const cost = (await again.view()).meeting.cost;
  assert.ok(cost.turns >= 1 && cost.usd > 0, JSON.stringify(cost));
});

test('protocol lines are parsed and hidden from what was said', () => {
  const d = meetingLib.directives('My point.\n**ASK:** @Zoe — what is the budget?\nINVITE: Reba and Nora (hiring)\nDISMISS: me — done\nCALL: Paul\nEND: decided X\nRULING: Paul owns it');
  assert.strictEqual(d.body, 'My point.');
  assert.deepStrictEqual(d.list.map(x => x.kind + ':' + x.name), ['ASK:Zoe', 'INVITE:Reba', 'INVITE:Nora', 'DISMISS:me', 'CALL:Paul', 'END:', 'RULING:']);
  assert.strictEqual(d.list[0].why, 'what is the budget?');
  assert.ok(meetingLib.isPass('PASS') && meetingLib.isPass(' pass. ') && !meetingLib.isPass('I pass on that, but'));
  assert.strictEqual(meetingLib.handReply('HAND — on cost.'), 'on cost'); assert.strictEqual(meetingLib.handReply('NO'), null);
});

test('pacing: turns flow by default (no Next to press), as at the table; an old manual default moves to instant once', async () => {
  const seats = ['dana', 'zoe', 'paul', 'reba'];
  const { M, runner } = fresh({ seats, leader: 'dana' });
  M.presence({ here: true });
  const v0 = await M.view();
  assert.ok(v0.meeting.speed === 'instant' && v0.meeting.effectiveSpeed === 'instant', 'instant is the default, present or not: ' + v0.meeting.speed);
  M.setObserve({ on: true, rounds: 2 });
  const script = {}; for (const id of seats) script[id] = ['r1 ' + id, 'r2 ' + id];
  runner.script(script);
  let sawWait = false; const watch = setInterval(async () => { const v = await M.view(); if (v.live.waitNext) sawWait = true; }, 3);
  await M.say({ text: 'Two rounds, flowing.' }); await idle(M); clearInterval(watch);
  assert.strictEqual(runner.turns().length, 8, '4 seats x 2 rounds, nobody pressing Next');
  assert.ok(!sawWait && !kinds(M, 'note').some(e => /Next/.test(e.text)), 'the default pace never waits for Next');
  // a seats.json saved under the old default ('manual') moves to instant once; a pace picked after that is kept
  const F = path.join(T, 'company/state/meetings/seats.json');
  const old = JSON.parse(fs.readFileSync(F, 'utf8')); delete old.speedMigrated; old.speed = 'manual'; fs.writeFileSync(F, JSON.stringify(old));
  M._reload();
  assert.strictEqual((await M.view()).meeting.speed, 'instant', 'migrated');
  assert.strictEqual(JSON.parse(fs.readFileSync(F, 'utf8')).speedMigrated, true, 'once: saved with the flag');
  M.pace({ speed: 'manual' }); M._reload();
  assert.strictEqual((await M.view()).meeting.speed, 'manual', 'Next picked by the owner after that is kept');
});

test('pacing: with Next picked and the owner present, a 7-seat 3-round meeting never advances without Next', async () => {
  const seats = ['dana', 'zoe', 'paul', 'reba', 'nora', 'owen', 'luca'];
  const { M, runner } = fresh({ seats, leader: 'dana' });
  M.pace({ speed: 'manual' });
  M.setObserve({ on: true, rounds: 3 });
  const script = {}; for (const id of seats) script[id] = ['r1 ' + id, 'r2 ' + id, 'r3 ' + id];
  runner.script(script);
  M.presence({ here: true });
  assert.strictEqual((await M.view()).meeting.effectiveSpeed, 'manual', 'Next while the owner is present');
  await M.say({ text: 'Three rounds, at my pace.' });
  const wait = async n => { for (let i = 0; i < 200 && runner.turns().length < n; i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 60)); };
  for (let k = 1; k <= 21; k++) {
    await wait(k);
    M.presence({ here: true });
    assert.strictEqual(runner.turns().length, k, 'turn ' + k + ' and no further without Next');
    const v = await M.view();
    if (k < 21) { assert.ok(v.live.waitNext, 'waiting for Next after turn ' + k); M.next(); }
  }
  await idle(M);
  assert.strictEqual(runner.turns().length, 21, '7 seats x 3 rounds');
  // away: the meeting advances by itself at the type's speed
  const t2 = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  t2.M.pace({ speed: 'manual' });
  t2.runner.script({ dana: 'a', zoe: 'b' });
  t2.M.presence({ here: false });
  await t2.M.say({ text: 'While I am away.' }); await idle(t2.M);
  assert.strictEqual(t2.runner.turns().length, 2, 'advances with nobody pressing Next');
});

test('pause: the current turn finishes, nothing new starts and nothing is spent until released', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dana: { text: 'Finishing my point.', hold }, zoe: 'S.', paul: 'P.' });
  await M.say({ text: 'Go.' }); await new Promise(r => setTimeout(r, 30));
  M.hold({ on: true }); release();
  await new Promise(r => setTimeout(r, 150));
  assert.deepStrictEqual(runner.calls.map(c => c.seat), ['dana'], 'no new run while paused');
  assert.ok(kinds(M, 'say').some(e => e.who === 'dana'), 'the turn in progress finished and is shown');
  assert.ok((await M.view()).live.paused);
  M.hold({ on: false }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dana', 'zoe', 'paul']);
});

test('your turn: an ASK of the owner or a CALL from the leader gives the owner the floor; Catch me up is one talk-only turn for the owner', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  runner.script({ dana: 'Over to you.\nASK: Avery — which market first?', zoe: 'S.' });
  await M.say({ text: 'Go.' });
  for (let i = 0; i < 100 && (await M.view()).live.phase !== 'floor'; i++) await new Promise(r => setTimeout(r, 10));
  const v = await M.view();
  assert.ok(v.live.yourTurn && /Dana asked you: which market first\?/.test(v.live.floorWhy), JSON.stringify(v.live));
  await M.say({ text: 'Sports first.' }); await idle(M);
  runner.script({ 'dana:catchup': 'Summary bullets.\n- a\n- b' });
  const n = runner.calls.length;
  await M.catchUp({ since: 0 });
  const c = runner.calls.slice(n);
  assert.ok(c.length === 1 && c[0].purpose === 'catchup' && c[0].tools === false && /CATCH-UP for Avery/.test(c[0].last));
  assert.ok(kinds(M, 'catchup').length === 1 && !kinds(M, 'say').some(e => /Summary bullets/.test(e.text)), 'shown to the owner, not part of the meeting');
  runner.script({ zoe: 'Later.' });
  await M.say({ text: 'Next.' }); await idle(M);
  assert.ok(!/Summary bullets/.test(runner.turns().pop().all), 'the seats never see the catch-up');
  assert.ok(M.timeline().moments.some(m => m.kind === 'ask'), 'the timeline has the moments to scrub to');
});

test('the action register: rows come from their owners\' lines, "plain:" is welcome not required (kept, the writer told), only confirmed owner rulings reach decisions.md, each owner updates their own lines', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  runner.script({ dana: 'Proposal.\nRULING: Email stays on Proton for now — plain: we keep the email we have', zoe: 'I will price it.\nACTION: Price both email options — by 2026-11-20 — plain: Zoe finds what each email option costs — affects: Finance, Risk\nQUESTION: Does mail from home deliver? — plain: can we send mail from the office line', paul: 'ACTION: Check port 25 — by own loop' });
  await M.say({ text: 'Email: what do we do?' }); await idle(M);
  const rv = M.registerView(); const r = rv.register;
  assert.deepStrictEqual(r.actions.map(a => [a.n, a.owner, a.date, a.status, a.affects]), [[1, 'zoe', '2026-11-20', 'open', 'Finance, Risk'], [2, 'paul', 'own loop', 'open', '']], 'each speaker\'s own line');
  assert.strictEqual(r.actions[0].plain, 'Zoe finds what each email option costs');
  assert.ok(r.actions[1].text === 'Check port 25' && !r.actions[1].plain, 'Paul\'s line without a plain part is kept as written');
  assert.ok(!kinds(M, 'parse').some(e => e.who === 'paul'), 'not refused');
  assert.ok(!rv.problems.some(p => p.section === 'actions'), 'and not failing validation: ' + JSON.stringify(rv.problems));
  assert.ok(kinds(M, 'nudge').some(e => e.who === 'paul' && /ACTION line was recorded as written/.test(e.text)), 'Paul is told');
  assert.ok(!M.entries(new URLSearchParams()).entries.some(e => e.kind === 'nudge'), 'the note to Paul is not on the page');
  assert.ok(r.questions.length === 1 && r.questions[0].owner === 'zoe');
  assert.ok(r.rulings.length === 1 && !r.rulings[0].confirmed && r.rulings[0].proposedBy === 'dana', 'the leader proposes; the owner confirms');
  assert.ok(!/Email stays on Proton/.test(R('company/work/decisions.md')));
  await M.register({ op: 'confirm', n: 1 });
  assert.ok(/Avery \[d-[0-9a-f]{6}\] Meeting ruling \(\d{4}-\d{2}-\d{2}\): Email stays on Proton for now In plain words: we keep the email we have/.test(R('company/work/decisions.md')), R('company/work/decisions.md').slice(0, 400));
  await M.register({ op: 'ruling', text: 'No new tools this week', plain: 'we use what we have this week' });
  await assert.rejects(async () => M.register({ op: 'ruling', text: 'No plain line' }), /plain-language line/);
  await assert.rejects(async () => M.register({ op: 'update', section: 'actions', n: 1, status: 'done' }), /only zoe updates this line/);
  await M.register({ op: 'not-recorded', text: 'No outside party was contacted.' });
  const md = R(path.relative(T, path.join(T, M.registerView().file)));
  assert.ok(!/fails validation/.test(md) && /## Owner rulings/.test(md) && /confirmed by the owner/.test(md) && /\| 1 \| Price both email options \| Zoe finds what each email option costs \| Zoe \| 2026-11-20 \| open \| Finance, Risk \|/.test(md) && /## Not recorded here\n- No outside party was contacted\./.test(md), md);
  runner.script({ paul: 'PASS' });
  await M.say({ text: '@paul anything else?' }); await idle(M);
  assert.ok(/Console note: your ACTION line was recorded as written/.test(runner.turns().filter(c => c.seat === 'paul').pop().last), 'told on his next turn');
  // searchable: participants, decisions, actions, links
  runner.script({ dana: 'See q:78 and to-zoe.md.' });
  await M.say({ text: '@dana links?' }); await idle(M);
  const s1 = M.search(new URLSearchParams('q=price both email')).meetings;
  assert.ok(s1.length === 1 && s1[0].actions[0].owner === 'Zoe' && s1[0].participants.includes('Zoe'));
  const s2 = M.search(new URLSearchParams('q=q:78')).meetings;
  assert.ok(s2.length === 1 && s2[0].links.quests.includes('q:78') && s2[0].links.handoffs.includes('to-zoe.md'), JSON.stringify(s2));
});

test('the rules are the table\'s: speak as yourself, short, by name, PASS, check facts, the lines; no speaking contract; seat frames off unless switched on; the company language', async () => {
  const { M, runner } = fresh({ seats: ['zoe', 'paul', 'nora'], leader: null });
  runner.script({ zoe: 'S.', paul: 'P.', nora: 'N.' });
  co.config.locale = 'vi';
  try { await M.say({ text: 'Should we self-host email?' }); await idle(M); } finally { co.config.locale = 'en'; }
  const sh = runner.turns().find(c => c.seat === 'zoe');
  assert.match(sh.all, /^\[THE TABLE\]/, 'the table\'s preamble');
  assert.match(sh.all, /Speak as yourself, from your own area, as you would in a meeting: short and to the point, a few sentences unless Avery asks for more\. Answer what was put to you; agree, disagree or build on what the others said, by name; do not repeat/);
  assert.match(sh.all, /If you have nothing to add, reply with exactly PASS and nothing else\./);
  assert.match(sh.all, /Check the facts you state \(read what you need\), but do not start long work/);
  assert.match(sh.all, /ASK: <name> — <your question>[\s\S]*HAND — <what you want to add>[\s\S]*INVITE: <name> — <why the discussion needs them>[\s\S]*DISMISS: <name> — <why>/);
  assert.match(sh.all, /You may add "— plain: <one sentence anyone can read>"/, 'plain is optional');
  assert.ok(!/speaking contract|Your point first|Define any term the room|A line without its plain part is refused/.test(sh.all), 'none of the added contract');
  assert.ok(!/Your seat:|In the room:/.test(sh.last), 'no seat frames by default');
  assert.match(sh.last, /Speak Vietnamese \(the company's language, company\.json locale vi\)/);
  assert.ok(sh.all.length < 5200, 'the preamble is short again: ' + sh.all.length);
  await M.setFrames({ on: true });
  runner.script({ zoe: 'S2.', paul: 'P2.', nora: 'N2.' });
  await M.say({ text: 'And the cost?' }); await idle(M);
  const sh2 = runner.turns().filter(c => c.seat === 'zoe').pop();
  assert.match(sh2.last, /Your seat: Finance\. In the room: Paul \(Risk and legal: needs the exposure, and any commitment or promise it makes for the company\); Nora \(Tools and IT: needs what has to change in how things run, and who builds and checks it\)/, 'frames when switched on');
});

test('seatVoice: a seat\'s own point of view goes in after the rules, for that seat only', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana', deps: { seatVoice: id => id === 'zoe' ? '[YOUR VIEW] Zoe watches the money first.' : '' } });
  runner.script({ dana: 'D.', zoe: 'S.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const sh = runner.turns().find(c => c.seat === 'zoe'), dv = runner.turns().find(c => c.seat === 'dana');
  assert.match(sh.messages[0].content, /^\[THE TABLE\][\s\S]*The minutes[\s\S]*\]\n\[YOUR VIEW\] Zoe watches the money first\.\n\[You are Zoe, CFO\./, 'after the rules, before who they are');
  assert.ok(!/YOUR VIEW/.test(dv.all), 'only that seat');
  const broken = fresh({ seats: ['dana'], leader: 'dana', deps: { seatVoice: () => { throw new Error('x'); } } });
  broken.runner.script({ dana: 'still speaks' });
  await broken.M.say({ text: 'Go.' }); await idle(broken.M);
  assert.ok(kinds(broken.M, 'say').some(e => e.text === 'still speaks'), 'a failing hook never stops a turn');
});

test('a raised hand\'s reason is cut at a word boundary with "…", never mid-word', () => {
  const long = 'HAND — ' + 'the budget line for the second quarter does not include the hosting renewal we agreed last month, '.repeat(4);
  const w = meetingLib.handReply(long);
  assert.ok(w.length <= 200 && w.endsWith('…'), w);
  assert.ok(long.includes(w.slice(0, -1)) && /\w…$/.test(w) && / [a-z]+…$/.test(w), 'whole words: ' + w);
  assert.ok(!/\s…$/.test(w));
  assert.strictEqual(meetingLib.handReply('HAND — short point.'), 'short point');
});

test('one engine, other rooms: options for the state folder, topic, minutes, routes; a fixed host, a guest cap, a reply cap, a pull-in round with the host\'s closing turn', async () => {
  const dir = path.join(T, 'company/state/huddles/dana');
  fs.rmSync(dir, { recursive: true, force: true });
  const runner = makeRunner(); const topics = [];
  const H = meetingLib({ co, owner: () => 'Avery', runner, run, emit: t => topics.push(t), modelFor: async () => ({ provider: 'claude-cli', model: 'claude-sonnet-5-5' }),
    stateDir: dir, topic: 'huddle', streamPrefix: 'huddle-dana-', minutesPrefix: 'chat-dana-', routePrefix: '/api/huddle/dana', door: 'chat',
    profile: { kind: 'huddle', noun: 'chat', preface: o => 'This is ' + o + '\'s live chat with Dana; Dana brought you in.', fixedLeader: 'dana', standing: ['dana'], wrapHost: true, maxGuests: 2, maxInvites: 2, maxTurnsPerRound: 4, noRegister: true } });
  const v0 = await H.view();
  assert.deepStrictEqual(v0.seats.map(s => s.id), ['dana'], 'only the host is standing');
  assert.ok(v0.meeting.speed === 'instant' && v0.meeting.fixedLeader === 'dana');
  assert.throws(() => H.setLeader({ seat: 'zoe' }), /Dana leads this chat/);
  assert.throws(() => H.seatsChange({ remove: ['dana'] }), /Dana leads this chat and stays/);
  // the host's reply asked a colleague: the conversation so far, then the ASK, the guest answers, the host closes the loop
  runner.script({ nora: 'The deploy is green.', dana: ['Avery: Nora says the deploy is green.'] });
  await H.pullIn({ by: 'dana', seed: [{ who: 'owner', text: 'Is the deploy done?' }, { who: 'dana', text: 'Let me check with Nora.' }], text: 'Let me check with Nora.\nASK: Nora — is the deploy done?' });
  await idle(H);
  const order = runner.turns().map(c => c.seat);
  assert.deepStrictEqual(order, ['nora', 'dana'], 'the guest answers first, then the host closes the loop: ' + order.join());
  assert.ok(/This is Avery's live chat with Dana; Dana brought you in\./.test(runner.turns()[0].all) && /Avery \(owner\): Is the deploy done\?/.test(runner.turns()[0].all), 'the guest sees the chat so far');
  assert.ok(/Dana asked you directly: is the deploy done\?/.test(runner.turns()[0].last));
  assert.ok(/The others have spoken, Dana\. Close the loop for Avery/.test(runner.turns()[1].last), 'the host\'s closing turn');
  assert.ok(H._state().LOG.some(e => e.kind === 'join' && e.who === 'nora' && e.by === 'dana'), 'asking someone not here brings them in');
  assert.ok(!/RULING: <what was decided/.test(runner.turns()[0].all), 'no register lines in this room');
  for (const f of ['current.json', 'm', 'events']) assert.ok(fs.existsSync(path.join(dir, f)), 'state under its own folder: ' + f);
  assert.ok(fs.existsSync(path.join(T, 'company/work/meetings/chat-dana-' + co.localParts(new Date()).date + '.md')), 'its own minutes');
  assert.ok(topics.length && topics.every(t => t === 'huddle'), 'its own live topic');
  const adm = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.door === 'chat' && x.kind === 'meeting-turn');
  assert.ok(adm.length >= 2 && adm.every(x => x.decision === 'allow'), 'admitted through the chat door as meeting-turns');
  // the host stays when no wrap is due: nothing new since the host spoke
  runner.script({ dana: 'Only me.' });
  const n0 = runner.turns().length;
  await H.say({ text: '@dana thanks' }); await idle(H);
  assert.deepStrictEqual(runner.turns().slice(n0).map(c => c.seat), ['dana'], 'no closing turn when the host is the only one who spoke');
  // guest cap: 2 colleagues at once
  runner.script({ dana: 'INVITE: Zoe — cost\nINVITE: Paul — risk', zoe: 'S.', paul: 'P.' });
  await H.say({ text: '@dana bring people' }); await idle(H);
  assert.ok(H._state().LOG.some(e => e.kind === 'note' && /2 colleagues are here already, the most at once/.test(e.text)), 'the guest cap holds');
  // reply cap: at most 4 agent turns per owner message
  runner.script({ dana: ['ASK: Nora — a?', 'ASK: Nora — c?', 'x'], nora: ['ASK: Dana — b?', 'ASK: Dana — d?'] });
  const n1 = runner.turns().length;
  await H.say({ text: 'Talk it through.' }); await idle(H);
  assert.strictEqual(runner.turns().length - n1, 4, 'four replies, then it waits for the owner');
  assert.ok(H._state().LOG.some(e => e.kind === 'note' && e.text === 'The chat paused after 4 replies; write to carry on.'));
  // routes under the room's prefix, attach among them
  const routes = []; H.mount((m, re) => routes.push(m + ' ' + re.source));
  assert.ok(routes.includes('GET ^\\/api\\/huddle\\/dana$') && routes.includes('GET ^\\/api\\/huddle\\/dana\\/attach$') && !routes.some(r => /meeting/.test(r)), routes.join('\n'));
});

test('Explain for the room: one cheap talk-only turn of that speaker; the term check (no model) and the glossary', async () => {
  const { M, runner } = fresh({ seats: ['zoe', 'paul'], leader: null });
  runner.script({ zoe: 'Our CAC is up and the MRR (monthly recurring revenue) is flat; the SLA holds.', paul: 'PASS', 'zoe:explain': 'In short: getting each customer costs more, income is flat.' });
  await M.say({ text: 'Numbers?' }); await idle(M);
  const e = kinds(M, 'say').find(x => x.who === 'zoe');
  const n = runner.calls.length;
  await M.explain({ i: e.i });
  const c = runner.calls.slice(n);
  assert.ok(c.length === 1 && c[0].purpose === 'explain' && c[0].tools === false && c[0].seat === 'zoe' && /EXPLAIN FOR THE ROOM/.test(c[0].last), 'one talk-only turn of the speaker');
  assert.ok(kinds(M, 'say').some(x => x.explains === e.i && /getting each customer costs more/.test(x.text)), 'everyone in the room sees it');
  const before = runner.calls.length;
  const t1 = M.terms().undefined.map(x => x.term);
  assert.strictEqual(runner.calls.length, before, 'the term check runs no model');
  assert.deepStrictEqual(t1.sort(), ['CAC', 'SLA'], 'MRR is defined in the text; CAC and SLA are not');
  M.addTerm({ term: 'CAC', meaning: 'what it costs to win one customer' });
  assert.ok(/- \*\*CAC\*\*: what it costs to win one customer/.test(R('company/work/meetings/glossary.md')));
  assert.deepStrictEqual(M.terms().undefined.map(x => x.term), ['SLA']);
  await M.close({});
  assert.ok(kinds(M, 'note').some(x => /Terms used without a definition: SLA \(first used by Zoe\)/.test(x.text)), 'the check runs after the meeting, into the minutes');
});

test('the cost line is information: dollars for a metered model, the share of a subscription\'s windows (never $0.00), "unknown" for an unmetered one', async () => {
  W('company/work/finance/dispatch-budget.json', { dailyUsd: 5, unmeteredProviders: ['claude-cli', 'local'] });
  W('company/work/finance/subscriptions.json', { plans: [{ provider: 'claude-cli', name: 'Claude Max', seats: 1, price: 100, currency: 'USD', cycle: 'monthly', meter: 'pacer', windows: ['five_hour', 'seven_day'] }] });
  const pst = { history: { claude: [{ at: Date.now() - 1000, usedPct: 40 }] }, last: { claude: { at: Date.now() - 1000, fiveHour: { usedPct: 10 } } } };
  W('company/state/pacer-state.json', pst);
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana', models: { zoe: { provider: 'deepseek', model: 'deepseek-flash' }, paul: { provider: 'local', model: 'llama' } } });
  runner.script({ dana: 'D.', zoe: 'S.', paul: 'P.' });
  await M.say({ text: 'Cost?' });
  await new Promise(r => setTimeout(r, 15));
  pst.history.claude.push({ at: Date.now(), usedPct: 42 }); pst.last.claude.fiveHour.usedPct = 13.5; W('company/state/pacer-state.json', pst);
  await idle(M);
  const line = (await M.view()).meeting.costLine;
  assert.match(line, /^This meeting so far: 3 turns · /);
  assert.match(line, /Claude \(Claude Max\): 3\.5% of the 5-hour window, 2% of the week/, line);
  assert.match(line, /DeepSeek under \$0\.01/, line);
  assert.match(line, /local: unknown/, line);
  assert.doesNotMatch(line, /Claude[^·]*\$0\.00/, 'never $0.00 for a subscription');
  assert.ok(!fs.readdirSync(path.join(T, 'company/work/finance')).some(f => /budget-meeting|envelope|estimate/.test(f)), 'no meeting budget or estimate file');
  fs.unlinkSync(path.join(T, 'company/state/pacer-state.json')); fs.unlinkSync(path.join(T, 'company/work/finance/subscriptions.json')); fs.unlinkSync(path.join(T, 'company/work/finance/dispatch-budget.json'));
});

test('seats vs roster: a seat with no usable model sits the turn out with one plain line; the model is resolved per turn, never snapshotted', async () => {
  const models = {};
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana', models });
  models.zoe = {};   // no usable model (a seat with no chain and no roster model)
  runner.script({ dana: ['D1.', 'D2.'], zoe: ['S2.'] });
  await M.say({ text: 'First.' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /^Zoe sits this one out: Zoe has no AI model to think with/.test(e.text)), 'a visible note, not a silent drop');
  models.zoe = { provider: 'deepseek', model: 'deepseek-flash' }; models.dana = { provider: 'deepseek', model: 'deepseek-flash' };
  await M.say({ text: 'Second.' }); await idle(M);
  const last = runner.turns().slice(-2);
  assert.deepStrictEqual(last.map(c => c.seat + '/' + c.model.provider), ['dana/deepseek', 'zoe/deepseek'], 'the model is read again for every turn');
});


/* ---------- how hard they think, one model for everyone (spec: table follow-ups §1) ---------- */
test('thinking level: Normal on every turn by default, whatever the seat\'s own work uses; hand checks, the leader\'s call, Catch me up and Explain run Light; Max only on purpose', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul', 'reba'], leader: 'dana', models: { zoe: { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'max' } } });
  runner.script({ dana: ['ASK: Zoe — the budget?'], zoe: ['Fine.'], 'paul:hand': ['HAND — risk'], 'dana:call': ['LATER: Paul'], paul: ['Risk point.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const turns = runner.turns();
  assert.ok(turns.length >= 3 && turns.every(c => c.model.effort === 'medium'), 'every turn at Normal (medium): ' + turns.map(c => c.seat + '@' + c.model.effort));
  assert.ok(turns.find(c => c.seat === 'zoe').model.effort === 'medium', 'not the seat\'s own max');
  const checks = runner.calls.filter(c => c.purpose === 'hand' || c.purpose === 'call');
  assert.ok(checks.length >= 2 && checks.every(c => c.model.effort === 'low'), 'hand checks and the leader\'s call at Light: ' + checks.map(c => c.purpose + '@' + c.model.effort));
  let v = await M.view();
  assert.deepStrictEqual([v.meeting.think.level, v.meeting.think.label, v.meeting.think.pin], ['normal', 'Normal', null]);
  assert.deepStrictEqual(v.meeting.think.levels.map(x => x.label), ['Light', 'Normal', 'Deep', 'Max']);
  // Deep: high on the next turns, hand checks still Light
  v = M.setThink({ level: 'deep' }); v = await v;
  assert.match(v.note, /Deep thinking, each on their usual model\. Hand checks stay Light/);
  assert.ok(kinds(M, 'think').some(e => e.level === 'deep'), 'recorded (minutes), not sent to the seats');
  runner.script({ dana: 'Deep.' });
  await M.say({ text: '@dana again' }); await idle(M);
  assert.strictEqual(runner.turns().pop().model.effort, 'high');
  assert.ok(!/set how hard they think/.test(runner.turns().pop().all), 'the setting is not meeting content');
  await M.catchUp({ since: 0 });
  assert.strictEqual(runner.calls.filter(c => c.purpose === 'catchup').pop().model.effort, 'low', 'Catch me up runs Light');
  // Max only when picked deliberately
  await assert.rejects(async () => M.setThink({ level: 'max' }), /pick it deliberately/);
  await assert.rejects(async () => M.setThink({ level: 'huge' }), /light, normal, deep or max/);
  await M.setThink({ level: 'max', sure: true });
  assert.strictEqual((await M.view()).meeting.think.level, 'max');
  await M.setThink({ level: 'normal' });
  // kept with the seats (seats.json), owner-only
  assert.strictEqual(JSON.parse(R('company/state/meetings/seats.json')).think.level, 'normal');
  const prov = require(path.join(REPO, 'company/tools/provenance.js'));
  prov.pinUnderStation(true);
  try { await assert.rejects(async () => M.setThink({ level: 'light' }), /the meeting is the owner's/, 'an agent cannot change it'); } finally { prov.pinUnderStation(null); }
});

test('the effort is fitted to what the model offers, never above the level unless it offers nothing lower', async () => {
  assert.strictEqual(meetingLib.fitEffort('medium', ['none', 'low', 'high', 'max']), 'low');
  assert.strictEqual(meetingLib.fitEffort('medium', ['low', 'medium', 'high']), 'medium');
  assert.strictEqual(meetingLib.fitEffort('low', ['high', 'max']), 'high');
  assert.strictEqual(meetingLib.fitEffort('high', null), 'high');
  const { M, runner } = fresh({ seats: ['zoe'], leader: null, models: { zoe: { provider: 'deepseek', model: 'deepseek-flash' } }, deps: { effortsFor: async (p, m) => p === 'deepseek' && m === 'deepseek-flash' ? ['none', 'low', 'high', 'max'] : null } });
  runner.script({ zoe: 'S.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.strictEqual(runner.turns()[0].model.effort, 'low', 'Normal on a model with no medium: low, not high');
});

test('one model for everyone: still behind the company list, the override list, the $0 cap and admit; closed = sits out with a plain line, never another model', async () => {
  const OAF = path.join(T, 'company/state/override-allow.json');
  const writeOA = agents => { fs.mkdirSync(path.dirname(OAF), { recursive: true }); fs.writeFileSync(OAF, JSON.stringify({ v: 1, at: Date.now(), by: 'dispatcher', agents })); };
  writeOA({ dana: [{ provider: 'deepseek', model: 'deepseek-flash' }], zoe: [] });
  const holds = {};
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana', deps: { modelHold: id => holds[id] || null } });
  await assert.rejects(async () => M.setThink({ pin: 'claude-cli/claude-opus-5-5' }), /not on the company's list/);
  await assert.rejects(async () => M.setThink({ pin: 'nonsense' }), /provider\/model/);
  const v = await M.setThink({ pin: { provider: 'deepseek', model: 'deepseek-flash' } });
  assert.match(v.note, /everyone on DeepSeek \(deepseek-flash\)/);
  assert.deepStrictEqual(v.meeting.think.choices.map(c => c.provider + '/' + c.model), ['claude-cli/claude-sonnet-5-5', 'deepseek/deepseek-flash'], 'the choices: the company\'s list');
  // Zoe has nothing of her own open (an idea seat whose only AI is closed): the owner's pick still runs for her, because
  // DeepSeek is open for someone this tick (2026-11-19, Noah on MiniMax only with Haiku picked)
  assert.ok(v.seats.find(x => x.id === 'dana').model.pinned && v.seats.find(x => x.id === 'zoe').model.pinned, 'the strip shows both on the pick');
  runner.script({ dana: 'On DeepSeek.', zoe: 'Me too.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat + '/' + c.model.provider + '/' + c.model.model), ['dana/deepseek/deepseek-flash', 'zoe/deepseek/deepseek-flash'], 'both on the pick');
  // a pick open for nobody: everyone sits out, nobody is moved to another model
  const turns0 = runner.turns().length;
  await M.setThink({ pin: { provider: 'claude-cli', model: 'claude-sonnet-5-5' } });
  runner.script({ dana: 'never', zoe: 'never' });
  await M.say({ text: 'Sonnet now.' }); await idle(M);
  assert.equal(runner.turns().length, turns0, 'nobody ran');
  assert.ok(kinds(M, 'note').some(e => /^Zoe sits this one out: the model picked for this meeting \(.*\) is not open for them right now \(that AI is closed for everyone right now\)/.test(e.text)), kinds(M, 'note').map(e => e.text).join(' | '));
  await M.setThink({ pin: { provider: 'deepseek', model: 'deepseek-flash' } });
  // admit runs on the picked provider
  const admits = fs.readFileSync(path.join(T, 'company/state/admit-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'meeting-turn');
  assert.ok(admits.length && admits[admits.length - 1].provider === 'deepseek', 'admit() saw the picked provider');
  // the $0 cap on a metered model holds it
  holds.dana = 'the daily cap is $0';
  runner.script({ dana: 'never' });
  await M.say({ text: 'Again.' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /^Dana sits this one out: .*held: the daily cap is \$0/.test(e.text)));
  delete holds.dana;
  // a stale list closes it for everyone
  fs.writeFileSync(OAF, JSON.stringify({ v: 1, at: Date.now() - 31 * 60e3, agents: { dana: [{ provider: 'deepseek', model: 'deepseek-flash' }] } }));
  await M.say({ text: 'Stale?' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /^Dana sits this one out: .*out of date/.test(e.text)));
  // a refused turn on the picked model is not retried on another model
  writeOA({ dana: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }] });
  await M.setThink({ pin: 'claude-cli/claude-sonnet-5-5' });
  const before = runner.turns().length;
  runner.script({ dana: { text: 'x', refuse: true } });
  await M.say({ text: '@dana refused?' }); await idle(M);
  assert.strictEqual(runner.turns().length, before + 1, 'one attempt only');
  runner.queues.dana = [];
  // back to each person's usual
  await M.setThink({ pin: 'usual' });
  assert.strictEqual((await M.view()).meeting.think.pin, null);
  fs.rmSync(OAF, { force: true });
});

test('the cost line: a running total for the meeting and an estimate per round at the current setting', async () => {
  W('company/work/finance/dispatch-budget.json', { dailyUsd: 5, unmeteredProviders: ['claude-cli'] });
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana', models: { dana: { provider: 'deepseek', model: 'deepseek-flash' }, zoe: { provider: 'deepseek', model: 'deepseek-flash' } } });
  let v = await M.view();
  assert.match(v.meeting.estimateLine, /^Next round at Normal: about 2 turns · DeepSeek not known yet/, v.meeting.estimateLine);
  runner.script({ dana: 'D.', zoe: 'S.' });
  await M.say({ text: 'Go.' }); await idle(M);
  v = await M.view();
  assert.match(v.meeting.costLine, /^This meeting so far: 2 turns · DeepSeek under \$0\.01/);
  assert.match(v.meeting.estimateLine, /^Next round at Normal: about 2 turns · DeepSeek about under \$0\.01/, v.meeting.estimateLine);
  // the estimate scales with the level: Max costs about 4x Normal here (0.002 a turn -> 0.008 x 2)
  await M.setThink({ level: 'max', sure: true });
  v = await M.view();
  assert.match(v.meeting.estimateLine, /^Next round at Max: about 2 turns · DeepSeek about \$0\.02/, v.meeting.estimateLine);
  fs.unlinkSync(path.join(T, 'company/work/finance/dispatch-budget.json'));
});

/* ---------- never hard-stop a turn (spec: table follow-ups §2) ---------- */
test('Stop is "after this turn": hand checks are cancelled (not turns), the speaker is not; a message written meanwhile starts after it', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: null });
  let relHand; const handHold = new Promise(r => { relHand = r; });
  runner.script({ dana: ['ASK: Zoe — q?'], zoe: ['Answer.'], 'paul:hand': [{ text: 'HAND — x', hold: handHold }] });
  await M.say({ text: 'Go.' });
  for (let i = 0; i < 200 && !runner.calls.some(c => c.purpose === 'hand'); i++) await new Promise(r => setTimeout(r, 5));
  M.stop();
  const hc = runner.calls.find(c => c.purpose === 'hand');
  assert.ok(runner.pending.get(hc.runId).cancelled, 'the hand check is cancelled');
  relHand(); await idle(M);
  assert.ok(!kinds(M, 'hand').length && !runner.turns().some(c => c.seat === 'paul'), 'no hand, no more turns');
  // a message written while it stops goes to the table once the speaker finishes
  let rel; const hold = new Promise(r => { rel = r; });
  runner.script({ dana: [{ text: 'Long one.', hold }, 'On the new point.'], zoe: ['S.'], paul: ['P.'] });
  await M.say({ text: 'Round two.' }); await new Promise(r => setTimeout(r, 30));
  await M.stop();
  const r2 = await M.say({ text: 'New point.' });
  assert.match(r2.note, /once the current speaker finishes/);
  rel(); await idle(M);
  const s = said(M);
  assert.deepStrictEqual(s.slice(s.indexOf('dana: Long one.')), ['dana: Long one.', 'owner: New point.', 'dana: On the new point.', 'zoe: S.', 'paul: P.'], s.join(' | '));
});

test('leaving is never mid-turn: the owner\'s × on the speaker takes effect after the turn, their reply kept; Close waits for the speaker', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana' });
  let rel; const hold = new Promise(r => { rel = r; });
  runner.script({ dana: 'D.', zoe: { text: 'Zoe finishes.', hold }, paul: 'P.' });
  await M.say({ text: 'Go.' });
  for (let i = 0; i < 200 && !((await M.view()).live.speaking || {}).runId || (await M.view()).live.speaking.id !== 'zoe'; i++) await new Promise(r => setTimeout(r, 5));
  M.seatsChange({ remove: ['zoe'] });
  assert.ok((await M.view()).seats.some(s => s.id === 'zoe'), 'still seated while speaking');
  assert.ok(kinds(M, 'note').some(e => /Zoe leaves the meeting once Zoe finishes this turn/.test(e.text)));
  assert.ok(!runner.pending.get(runner.turns().find(c => c.seat === 'zoe').runId).cancelled);
  rel(); await idle(M);
  const log = M._state().LOG.filter(e => e.who === 'zoe').map(e => e.kind);
  assert.deepStrictEqual(log.slice(-2), ['say', 'leave'], 'the reply, then the leave');
  assert.ok(!(await M.view()).seats.some(s => s.id === 'zoe') && !JSON.parse(R('company/state/meetings/seats.json')).seats.includes('zoe'), 'then removed from the standing seats');
  assert.ok(said(M).includes('paul: P.'), 'the round carries on');
  // Close during a long turn: it answers at once and closes once the speaker is done
  let rel2; const hold2 = new Promise(r => { rel2 = r; });
  runner.script({ dana: { text: 'Last words.', hold: hold2 } });
  await M.say({ text: 'Closing soon.' }); await new Promise(r => setTimeout(r, 30));
  const cl = await M.close({ why: 'done' });
  assert.ok(cl.closing && /closes once Dana finishes this turn/.test(cl.note), cl.note);
  assert.strictEqual((await M.view()).meeting.state, 'open');
  rel2(); await idle(M);
  assert.strictEqual((await M.view()).meeting.state, 'closed');
  assert.ok(said(M).includes('dana: Last words.'));
}).timeout = 30000;

test('no turn timeout: a soft nudge after a while, and only a run stalled with no output is ended (the safety ceiling); an approval wait is not a stall', async () => {
  const steers = [];
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana', deps: { nudgeMs: 40, stallMs: 400, watchTickMs: 10 } });
  runner.steer = (runId, text) => { steers.push({ runId, text }); };
  // a long turn that keeps writing: nudged once, never cut
  let rel; const hold = new Promise(r => { rel = r; });
  const w0 = runner.wait;
  runner.wait = async (runId, onEvent) => { const p = runner.pending.get(runId); if (p.ticks) { const t = setInterval(() => onEvent && onEvent({ name: 'agent.token', payload: { delta: '.' } }), 20); try { return await w0(runId, onEvent); } finally { clearInterval(t); } } return w0(runId, onEvent); };
  runner.script({ dana: { text: 'A long but live answer.', hold } });
  const st = runner.start; runner.start = async o => { const r = await st(o); if (o.seat === 'dana') runner.pending.get(r.runId).ticks = true; return r; };
  await M.say({ text: '@dana go' });
  await new Promise(r => setTimeout(r, 600));
  assert.strictEqual(steers.length, 1, 'one nudge');
  assert.match(steers[0].text, /Finish your point now/);
  assert.ok(!runner.pending.get(runner.turns()[0].runId).cancelled, 'a live run is never cut, even past the ceiling');
  assert.ok(kinds(M, 'note').some(e => /Dana has been on this turn for .* the console asked Dana to wrap up\. Nobody is cut off/.test(e.text)));
  rel(); await idle(M);
  assert.ok(said(M).includes('dana: A long but live answer.'));
  // a run with no output at all past the ceiling is ended, with one plain line
  runner.start = st;
  let rel2; const hold2 = new Promise(r => { rel2 = r; });
  runner.script({ zoe: { text: 'never', hold: hold2 } });
  const w1 = runner.wait; runner.wait = async (runId, onEvent) => { const p = runner.pending.get(runId); const iv = setInterval(() => { if (p.cancelled) { clearInterval(iv); rel2(); } }, 5); try { return await w1(runId, onEvent); } finally { clearInterval(iv); } };
  await M.say({ text: '@zoe go' });
  await idle(M);
  assert.ok(runner.pending.get(runner.turns().pop().runId).cancelled, 'the stalled run is ended');
  assert.ok(kinds(M, 'note').some(e => /^Zoe's turn stalled: nothing came from it for/.test(e.text)));
  assert.ok(!kinds(M, 'note').some(e => /Zoe could not answer/.test(e.text)), 'one line, not two');
});

test('stay in the room: every turn says what was said since that seat last spoke and which questions are answered; no draft-ahead', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: null });
  runner.script({ dana: 'Ship Friday.\nASK: Zoe — is the budget set?', zoe: ['Budget is set at 40.', 'Agree with Paul.'], paul: ['Friday works.', 'PASS'], });
  await M.say({ text: 'When do we ship?' }); await idle(M);
  const t = runner.turns();
  // runs start one at a time, only when it is that seat's turn: never two turns in flight
  assert.strictEqual(runner.maxLive, 1, 'no draft-ahead: one turn run at a time');
  const first = t[0];
  assert.ok(/Since you last spoke: Avery \(owner\): When do we ship\?/.test(first.last), 'the first speaker sees the owner\'s message');
  assert.ok(/Reply to where the discussion is now: build on or disagree with the latest; do not re-answer\./.test(first.last));
  assert.ok(!/Questions already answered/.test(first.last), 'nothing answered yet');
  const paul = t.find(c => c.seat === 'paul');
  assert.ok(/Since you last spoke: Avery \(owner\): When do we ship\? \| Dana: Ship Friday \| Zoe \(answering Dana\): Budget is set at 40\. /.test(paul.last), paul.last);
  assert.ok(/Questions already answered: Avery's "When do we ship\?": answered by Dana, Zoe; Dana asked Zoe "is the budget set\?": Zoe answered it\. /.test(paul.last), paul.last);
  // every turn carries it, an ASK answer too
  assert.ok(t.every(c => /do not re-answer\.\]/.test(c.last)), 'all turns');
  // a seat that spoke before only sees what came after its own reply
  await M.say({ text: 'Anything else?' }); await idle(M);
  const sharon2 = runner.turns().filter(c => c.seat === 'zoe').pop();
  assert.ok(!/Ship Friday/.test(sharon2.last.split('Since you last spoke:')[1] || ''), 'only what is new since Zoe last spoke');
  assert.ok(/Since you last spoke: Paul: Friday works \| Avery \(owner\): Anything else\?/.test(sharon2.last), sharon2.last);
});

/* ---------- review follow-ups: halt over Stop/Close, a message while closing, put-to-you-by-name, the estimate ---------- */
test('a hard halt still aborts the turn after Stop (the meeting is interrupted) and after Close (it closes)', async () => {
  for (const how of ['stop', 'close']) {
    const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
    let release; const hold = new Promise(r => { release = r; });
    runner.script({ dana: { text: 'Mid-sentence', hold }, zoe: ['never'] });
    await M.say({ text: 'Go.' });
    await new Promise(r => setTimeout(r, 30));
    if (how === 'stop') M.stop(); else await M.close({ why: 'done' });
    W('company/state/halt.json', { mode: 'hard', by: 'Avery' });
    for (let i = 0; i < 300 && !runner.pending.get(runner.turns()[0].runId).cancelled; i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(runner.pending.get(runner.turns()[0].runId).cancelled, how + ': the hard halt cancels the turn');
    release(); await idle(M);
    const v = await M.view();
    fs.unlinkSync(path.join(T, 'company/state/halt.json'));
    assert.ok(!runner.turns().some(c => c.seat === 'zoe'), how + ': nobody speaks after the halt');
    if (how === 'stop') { assert.strictEqual(v.meeting.state, 'interrupted'); assert.match(v.meeting.reason, /hard halt: aborted/); }
    else assert.strictEqual(v.meeting.state, 'closed', 'the owner asked to close: it closes');
    assert.ok(kinds(M, 'note').some(e => /The company is halted, so the meeting stopped mid-turn\./.test(e.text)));
  }
}).timeout = 30000;

test('a message written while the meeting is closing is refused in plain words, never silently dropped', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe'], leader: 'dana' });
  let rel; const hold = new Promise(r => { rel = r; });
  runner.script({ dana: { text: 'Last words.', hold } });
  await M.say({ text: 'Wrap up.' }); await new Promise(r => setTimeout(r, 30));
  const cl = await M.close({});
  assert.ok(cl.closing);
  await assert.rejects(async () => M.say({ text: 'One more thing.' }), /meeting is closing once the current speaker finishes, so your message was not sent/);
  rel(); await idle(M);
  assert.strictEqual((await M.view()).meeting.state, 'closed');
  assert.ok(!said(M).includes('owner: One more thing.'));
});

test('a question put to several people by name: one answering does not tell the others not to answer', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'nora', 'paul'], leader: null });
  runner.script({ dana: 'I think A.', nora: 'I think B.' });
  await M.say({ text: '@Dana @Nora what does each of you think?' }); await idle(M);
  const nora = runner.turns().find(c => c.seat === 'nora');
  assert.ok(nora, 'Nora gets her turn');
  assert.ok(/Avery put this to Dana, Nora\./.test(nora.last), nora.last);
  assert.ok(!/Questions already answered: Avery's/.test(nora.last), 'not "already answered" for her: ' + nora.last);
  assert.ok(/Avery's "@Dana @Nora what does each of you think\?" was put to you by name; Dana already answered: give your own answer, adding only what is new\./.test(nora.last), nora.last);
  assert.ok(/do not re-answer what others said\.\]$/.test(nora.last), nora.last);
  const ownerSay = M._state().LOG.find(e => e.who === 'owner' && e.kind === 'say');
  assert.deepStrictEqual(ownerSay.only, ['dana', 'nora'], 'who it was put to is kept with the message');
  // an open message (to nobody by name) still counts as answered for the next speaker
  runner.script({ dana: 'Fine.', nora: 'PASS', paul: 'PASS' });
  await M.say({ text: 'Anything else?' }); await idle(M);
  const n2 = runner.turns().filter(c => c.seat === 'nora').pop();
  assert.ok(/Questions already answered: Avery's "Anything else\?": answered by Dana\./.test(n2.last), n2.last);
});

test('the estimate weighs turns only: hand checks and the leader\'s call add their cost, not runs', async () => {
  const { M, runner } = fresh({ seats: ['dana', 'zoe', 'paul'], leader: 'dana', models: { dana: { provider: 'deepseek', model: 'deepseek-flash' }, zoe: { provider: 'deepseek', model: 'deepseek-flash' }, paul: { provider: 'deepseek', model: 'deepseek-flash' } } });
  runner.script({ dana: ['ASK: Zoe — q?', 'PASS'], zoe: ['Answer.'], 'paul:hand': ['NO'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const v = await M.view();
  const bp = v.meeting.cost.byProvider.deepseek;
  const turns = runner.turns().length, checks = runner.calls.length - turns;
  assert.ok(checks >= 1, 'a hand check ran');
  assert.strictEqual(bp.turns, turns + checks, 'every run is counted in the total');
  assert.strictEqual(bp.w, turns, 'only turns are weighed (Normal: 1 each)');
  assert.match(v.meeting.estimateLine, /\(a rough guess from this meeting so far; more if they ask each other or raise hands\)$/, v.meeting.estimateLine);
});
