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

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-selftest-'));
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const CREW = { dave: ['Dave', 'CEO'], sharon: ['Sharon', 'CFO'], phil: ['Phil', 'IT Admin'], rachel: ['Rachel', 'Hiring Manager'], nadia: ['Nadia', 'Engineer'], omar: ['Omar', 'DevOps'], leo: ['Leo', 'Designer'] };
const FNS = { dave: ['ceo', 'people', 'floor'], sharon: ['finance'], phil: ['risk'], nadia: ['tools'] };
const agents = {}; for (const [id, [name, title]] of Object.entries(CREW)) agents[id] = Object.assign({ name, title, manager: id === 'dave' ? null : 'dave' }, FNS[id] ? { functions: FNS[id] } : {});
W('company/company.json', { name: 'Meeting Test', owner: { name: 'Caullen' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents });
W('company/model-policy.json', { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5'] }, deepseek: { models: ['deepseek-flash'] } },
  seats: { dave: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } }, candidateDefault: { provider: 'deepseek', model: 'deepseek-flash' } });
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
  const M = meetingLib({ co, owner: () => 'Caullen', runner, run, speedMs: { fast: 1, normal: 1, slow: 1 }, consentPollMs: 20, seatBusy: async id => !!(opts && opts.busy && opts.busy.includes(id)), modelFor: async id => models[id] || { provider: 'claude-cli', model: 'claude-sonnet-5-5' } });
  if (opts && opts.seats && Object.keys(CREW).some(x => !opts.seats.includes(x))) M.seatsChange({ remove: Object.keys(CREW).filter(x => !opts.seats.includes(x)) });
  if (opts && opts.seats) M.seatsChange({ add: opts.seats });
  if (opts && 'leader' in opts) M.setLeader({ seat: opts.leader });
  return { M, runner };
}
async function idle(M) { for (let i = 0; i < 400; i++) { if (M.idle()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('the meeting did not settle'); }
const said = M => M._state().LOG.filter(e => e.kind === 'say').map(e => e.who + ': ' + e.text);
const kinds = (M, k) => M._state().LOG.filter(e => e.kind === k);

test('turn order: everyone seated in turn, the leader first, each seeing what came before; a pass is not shown', async () => {
  const { M, runner } = fresh({ seats: ['sharon', 'phil', 'dave'], leader: 'dave' });
  runner.script({ dave: 'Dave here.', sharon: 'PASS', phil: 'Phil agrees with Dave.' });
  await M.say({ text: 'What should we do first?' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'sharon', 'phil'], 'the leader first, then the standing order');
  const phil = runner.turns()[2];
  assert.ok(/Caullen \(owner\): What should we do first\?/.test(phil.all) && /Dave: Dave here\./.test(phil.all), 'Phil sees the owner and Dave');
  assert.deepStrictEqual(said(M), ['owner: What should we do first?', 'dave: Dave here.', 'phil: Phil agrees with Dave.']);
  const e = M.entries(new URLSearchParams()).entries;
  assert.ok(!e.some(x => x.kind === 'pass'), 'passes are not shown');
  assert.ok(kinds(M, 'pass').length === 1, 'but they are kept, so Sharon is not asked again with nothing new');
  // the meeting carries on: the next message sees the earlier part; New meeting starts clean with the same seats
  runner.script({ dave: 'Still here.' });
  await M.say({ text: 'And next?' }); await idle(M);
  assert.ok(/Dave here\./.test(runner.turns().filter(c => c.seat === 'dave').pop().all), 'the meeting carries on');
  await assert.rejects(async () => M.newMeeting(), /one meeting at a time: close this meeting first/);
  await M.close({}); await M.newMeeting();
  runner.script({ dave: 'Fresh start.' });
  await M.say({ text: 'New topic.' }); await idle(M);
  const last = runner.turns().filter(c => c.seat === 'dave').pop();
  assert.ok(!/Dave here\./.test(last.all) && /New topic/.test(last.all), 'New meeting: same seats, nothing from before');
  assert.deepStrictEqual((await M.view()).seats.map(s => s.id), ['dave', 'sharon', 'phil'], 'same seats after New meeting');
});

test('@name: a message that starts with @names goes only to those seats', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  runner.script({ phil: 'Only me.' });
  await M.say({ text: '@phil what is the risk?' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['phil']);
  assert.ok(/Caullen put this to Phil/.test(runner.turns()[0].last));
  await assert.rejects(async () => M.say({ text: '@nobody hello' }), /nobody called @nobody/);
  await assert.rejects(async () => M.say({ text: '@rachel hello' }), /Rachel is not seated/);
});

test('Round: an open round with no new owner message; only seats with something new speak', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: 'Opening.', sharon: 'Answer to Dave.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const n = runner.turns().length;
  runner.script({ dave: 'Replying to Sharon.' });
  await M.openRound(); await idle(M);
  const round = runner.turns().slice(n);
  assert.strictEqual(round[0].seat, 'dave');
  assert.ok(/No new message from Caullen: this is an open round/.test(round[0].last), round[0].last);
  assert.ok(!said(M).some(x => x.startsWith('owner:') && x !== 'owner: Go.'), 'no owner message in an open round');
});

test('the leader: speaks first, can be set, kept across meetings, "no leader" works, and cannot be dismissed', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'sharon' });
  runner.script({ dave: 'Done here.\nDISMISS: Sharon — her part is done', sharon: 'I lead.' });
  await M.say({ text: 'Start.' }); await idle(M);
  assert.strictEqual(runner.turns()[0].seat, 'sharon', 'the leader speaks first');
  assert.ok(/You lead this meeting/.test(runner.turns()[0].last));
  assert.ok((await M.view()).seats.some(s => s.id === 'sharon' && s.leader), 'the leader stays');
  assert.ok(kinds(M, 'note').some(e => /who leads the meeting; only the owner changes that/.test(e.text)));
  await M.close({}); await M.newMeeting();
  assert.strictEqual((await M.view()).meeting.leader, 'sharon', 'kept across meetings');
  M.setLeader({ seat: null });
  assert.strictEqual((await M.view()).meeting.leader, null, 'no leader');
  const def = meetingLib({ co, owner: () => 'Caullen', runner, run, modelFor: async () => ({ provider: 'claude-cli', model: 'x' }) });
  fs.rmSync(path.join(T, 'company/state/meetings/seats.json'));
  def._reload();
  assert.strictEqual((await def.view()).meeting.leader, 'dave', 'the default leader is the CEO seat');
});

test('observe: no owner turn, told not to ask the owner, carries on up to N rounds; stops on END or a silent round', async () => {
  let { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  M.setObserve({ on: true, rounds: 4 });
  runner.script({ dave: ['Plan A.', 'Agreed.\nEND: Plan A, Sharon writes it up — plain: we go with plan A and Sharon writes it down'], sharon: ['Plan A works.', 'PASS'] });
  await M.say({ text: 'Decide among yourselves.' }); await idle(M);
  assert.ok(runner.turns().every(c => /Caullen is observing: they will not speak unless they step in, so do not put questions to them/.test(c.last)), 'told not to ask the owner');
  assert.ok(/Open round, carried on without Caullen/.test(runner.turns()[2].last), 'the second round started by itself');
  assert.strictEqual(kinds(M, 'end').length, 1, 'END closes it');
  assert.strictEqual(runner.turns().length, 3, 'nothing after END');
  const rg = M.registerView();
  assert.ok(rg.register.summary && rg.register.summary.text === 'Plan A, Sharon writes it up' && rg.register.summary.plain === 'we go with plan A and Sharon writes it down', 'END is the register\'s summary with its plain line');
  assert.ok(!/Plan A, Sharon writes it up/.test(R('company/work/decisions.md')), 'an END is not an owner ruling: not in decisions.md');
  // a round with nothing said stops it
  ({ M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' }));
  M.setObserve({ on: true, rounds: 6 });
  runner.script({ dave: ['One.'], sharon: ['Two.'] });
  await M.say({ text: 'Talk.' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /gone quiet/.test(e.text)), 'a silent round stops it');
  // the cap: N rounds at most
  ({ M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' }));
  M.setObserve({ on: true, rounds: 2 });
  runner.script({ dave: ['a', 'b', 'c', 'd'], sharon: ['e', 'f', 'g', 'h'] });
  await M.say({ text: 'Talk.' }); await idle(M);
  assert.strictEqual(runner.turns().length, 4, '2 rounds of 2');
  assert.ok(kinds(M, 'note').some(e => /2 rounds ran on their own/.test(e.text)));
  M.setObserve({ on: false });
  assert.strictEqual((await M.view()).meeting.observer, false, 'Take part');
});

test('ASK: the seat answers next and may ask back; at most 6 direct questions a round', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: null });
  const back = i => 'Point ' + i + '.\nASK: ' + (i % 2 ? 'Dave' : 'Sharon') + ' — question ' + (i + 1) + '?';
  runner.script({ dave: ['Start.\nASK: Sharon — question 1?', back(2), back(4), back(6)], sharon: [back(1), back(3), back(5), back(7)] });
  await M.say({ text: 'Go.' }); await idle(M);
  const order = runner.turns().map(c => c.seat);
  assert.deepStrictEqual(order.slice(0, 7), ['dave', 'sharon', 'dave', 'sharon', 'dave', 'sharon', 'dave'], 'each question is answered next, and asked back: ' + order.join());
  assert.strictEqual(kinds(M, 'ask').length, 6, 'six direct questions');
  assert.ok(kinds(M, 'note').some(e => /has had 6 direct questions/.test(e.text)));
  assert.ok(/Sharon asked you directly: question 2\? Answer Sharon, Dave; you may ASK back/.test(runner.turns()[2].last));
  assert.ok(runner.turns().some(c => c.seat === 'phil'), 'the normal order carries on after the exchange');
  // ASK of someone not seated calls them in
  const t2 = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  t2.runner.script({ dave: 'ASK: Omar — can you deploy?', omar: 'Yes.' });
  await t2.M.say({ text: 'Go.' }); await idle(t2.M);
  assert.ok(kinds(t2.M, 'join').some(e => e.who === 'omar' && e.by === 'dave'));
  assert.strictEqual(t2.runner.turns()[1].seat, 'omar');
});

test('hands: after each answer the others are polled in parallel, talk only; at most 3 hands a round; no leader: a hand speaks next', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil', 'rachel', 'nadia'], leader: null });
  runner.script({ dave: ['ASK: Sharon — q1?', 'ASK: Sharon — q2?'], sharon: ['a1.', 'a2.'],
    'phil:hand': ['HAND — on cost'], 'rachel:hand': ['HAND — on hiring'], 'nadia:hand': ['NO', 'HAND — on tools'], 'phil:hand ': [] });
  runner.script({ phil: ['Cost point.\nASK: Sharon — q3?'], rachel: ['Hiring point.'], 'phil:hand': [], 'rachel:hand': [] });
  runner.script({ 'nadia:hand': [] });
  runner.script({ sharon: ['a3.'] });
  // after a3 the poll would give hands again, but the round has had 3
  runner.script({ 'dave:hand': ['HAND — me too'], 'rachel:hand': ['HAND — again'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const checks = runner.calls.filter(c => c.purpose === 'hand');
  assert.ok(checks.length >= 3 && checks.every(c => c.tools === false), 'hand checks are talk only');
  assert.ok(runner.maxLive >= 2, 'polled in parallel (' + runner.maxLive + ' at once)');
  assert.ok(kinds(M, 'hand').length <= 3, 'at most 3 hands a round: ' + kinds(M, 'hand').length);
  const order = runner.turns().map(c => c.seat);
  assert.strictEqual(order[2], 'phil', 'no leader: a raised hand speaks next: ' + order.join());
  assert.ok(kinds(M, 'say').some(e => e.who === 'phil' && e.interject), 'recorded as interjecting');
});

test('CALL / LATER / LOWER: with a leader, the leader decides raised hands; CALL: at the end of any leader reply', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil', 'rachel', 'nadia'], leader: 'dave' });
  runner.script({ dave: ['Sharon, over to you.\nASK: Sharon — the budget?', 'Wrap: thanks.'], sharon: ['Budget is fine.'], 'rachel:hand': ['HAND — a hire'], 'nadia:hand': ['HAND — a tool'], 'phil:hand': ['HAND — risk'],
    'dave:call': ['CALL: Rachel\nLATER: Phil\nLOWER: Nadia'], rachel: ['The hire point.'], phil: ['The risk point.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const order = runner.turns().map(c => c.seat);
  assert.deepStrictEqual(order.slice(0, 4), ['dave', 'sharon', 'rachel', 'phil'], 'CALL now, then LATER once the exchange is done: ' + order.join());
  assert.ok(runner.calls.some(c => c.purpose === 'call' && c.tools === false && /RAISED HANDS/.test(c.last)), 'the leader decides, talk only');
  assert.ok(kinds(M, 'lower').some(e => e.to === 'nadia'), 'LOWER');
  assert.ok(kinds(M, 'call').some(e => e.to === 'phil' && e.later), 'LATER');
  assert.ok(!kinds(M, 'say').some(e => e.who === 'nadia' && e.interject), 'a lowered hand does not get the floor');
  // CALL: at the end of a leader's reply gives the floor next
  const t2 = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  t2.runner.script({ dave: 'Phil first.\nCALL: Phil', phil: 'Here.', sharon: 'Me.' });
  await t2.M.say({ text: 'Go.' }); await idle(t2.M);
  assert.deepStrictEqual(t2.runner.turns().map(c => c.seat).slice(0, 2), ['dave', 'phil']);
  // only the leader calls on people
  const t3 = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  t3.runner.script({ sharon: 'CALL: Phil' });
  await t3.M.say({ text: 'Go.' }); await idle(t3.M);
  assert.ok(kinds(t3.M, 'note').some(e => /only the leader calls on people/.test(e.text)));
});

test('INVITE: joins at once, speaks after the others that round, at most 3 a round', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  runner.script({ dave: 'We need people.\nINVITE: Rachel, Nadia, Omar, Leo — the plan needs them', rachel: 'R.', nadia: 'N.', omar: 'O.', sharon: 'S.', phil: 'P.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'sharon', 'phil', 'rachel', 'nadia', 'omar'], 'after the others, in order');
  assert.strictEqual(kinds(M, 'join').length, 3);
  assert.ok(kinds(M, 'note').some(e => /invited Leo: not this round, 3 people were invited already/.test(e.text)));
  assert.ok(/Dave: We need people\./.test(runner.turns()[3].all), 'an invited seat sees the meeting so far');
});

test('DISMISS and seats: agent changes last for this meeting only; the owner\'s add and remove set the standing seats', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  runner.script({ dave: 'INVITE: Rachel — hiring', phil: 'Nothing more from me.\nDISMISS: me — my part is done', rachel: 'Hi.' });
  await M.say({ text: 'Go.' }); await idle(M);
  let v = await M.view();
  assert.ok(!v.seats.some(s => s.id === 'phil') && v.seats.some(s => s.id === 'rachel' && s.guest && s.invitedBy === 'dave'), 'Phil left, Rachel is a guest');
  assert.ok(kinds(M, 'leave').some(e => e.who === 'phil' && e.by === 'phil'));
  await M.close({}); await M.newMeeting();
  v = await M.view();
  assert.deepStrictEqual(v.seats.map(s => s.id), ['dave', 'sharon', 'phil'], 'the next meeting: standing seats again (Phil back, Rachel gone)');
  // the owner's changes override: adding a dismissed seat seats it for good; removing a guest
  runner.script({ phil: 'DISMISS: me — done', dave: 'INVITE: Nadia — tools' });
  await M.say({ text: 'Again.' }); await idle(M);
  M.seatsChange({ add: ['phil'], remove: ['nadia'] });
  v = await M.view();
  assert.ok(v.seats.some(s => s.id === 'phil' && s.standing) && !v.seats.some(s => s.id === 'nadia'));
  M.seatsChange({ add: ['nadia'] }); await M.close({}); await M.newMeeting();
  assert.ok((await M.view()).seats.some(s => s.id === 'nadia' && s.standing), 'the owner\'s add is a standing seat');
});

test('talk only is the default: zero tool calls, hand checks too; tools only for an agenda item switched on', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  runner.script({ dave: 'ASK: Sharon — budget?', sharon: 'Fine.' });
  await M.say({ text: 'Talk only by default.' }); await idle(M);
  assert.ok(runner.calls.length >= 3 && runner.calls.every(c => c.tools === false), 'every run, hand checks included, has no tools');
  assert.ok(/Talk only: nobody has tools in this part of the meeting/.test(runner.turns()[0].last));
  assert.strictEqual((await M.view()).meeting.toolsOn, false);
  M.agenda({ op: 'add', title: 'Check the ledger' });
  const it = (await M.view()).meeting.agenda[0];
  M.agenda({ op: 'tools', id: it.id, on: true });
  runner.script({ dave: 'c', sharon: 'd' });
  const n = runner.calls.length;
  await M.say({ text: 'Now with tools.' }); await idle(M);
  const after = runner.calls.slice(n).filter(c => c.purpose === 'turn');
  assert.ok(after.length && after.every(c => c.tools === true && /Agenda item now: Check the ledger/.test(c.last)), 'tools on for that item');
  M.agenda({ op: 'add', title: 'Next topic' }); const it2 = (await M.view()).meeting.agenda[1];
  M.agenda({ op: 'current', id: it2.id });
  assert.strictEqual((await M.view()).meeting.toolsOn, false, 'the next item is talk only again');
});

test('admit: every turn passes admit() as a meeting-turn (zero-token check), and no budget file is created', async () => {
  const before = new Set(listAll(T));
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: 'x', sharon: 'y' });
  const f = path.join(T, 'company/state/admit-log.jsonl'); const n0 = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).length;
  await M.say({ text: 'admit' }); await idle(M);
  const rows = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).slice(n0).map(l => JSON.parse(l));
  assert.strictEqual(rows.length, runner.calls.length, 'one admit row per run');
  assert.ok(rows.every(r => r.door === 'meeting' && r.kind === 'meeting-turn' && r.decision === 'allow' && r.meetingId), JSON.stringify(rows));
  const created = listAll(T).filter(x => !before.has(x));
  assert.ok(!created.some(x => /budget|envelope|estimate/i.test(x)), 'no budget file: ' + created.join());
  const A = require(path.join(REPO, 'company/tools/lib/admit.js'));
  assert.strictEqual(A.admit({ door: 'meeting', kind: 'meeting-turn', seat: 'dave', owner: false }, { file: null }).decision, 'refuse', 'a turn of a meeting the owner did not open is refused');
});
function listAll(dir, out, base) { out = out || []; base = base || dir; for (const n of fs.readdirSync(dir)) { const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) listAll(p, out, base); else out.push(path.relative(base, p)); } return out; }

test('owner-only: inside an agent\'s or a routine\'s run, nothing can start, steer or close a meeting', async () => {
  const { M } = fresh({ seats: ['dave'], leader: 'dave' });
  const prov = require(path.join(REPO, 'company/tools/provenance.js'));
  prov.pinUnderStation(true);
  try {
    for (const [what, fn] of [['start', () => M.say({ text: 'hi' })], ['a round', () => M.openRound()], ['steer', () => M.setLeader({ seat: 'dave' })], ['seats', () => M.seatsChange({ add: ['phil'] })],
      ['new', () => M.newMeeting()], ['close', () => M.close({})], ['agenda', () => M.agenda({ op: 'add', title: 'x' })]])
      await assert.rejects(async () => fn(), /the meeting is the owner's/, what);
  } finally { prov.pinUnderStation(null); }
});

test('Close without END records closed and who closed it; meeting states; one meeting at a time; an incident interrupts and the meeting resumes', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: 'No END from me.', sharon: 'Nor me.' });
  await M.say({ text: 'Talk.' }); await idle(M);
  await M.close({ why: 'enough for today' });
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'closed'); assert.strictEqual(v.meeting.closedBy, 'Caullen');
  assert.ok(kinds(M, 'close').some(e => e.who === 'owner' && e.state === 'closed' && e.why === 'enough for today'));
  assert.ok(/The meeting was closed by Caullen: enough for today/.test(R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md')));
  await assert.rejects(async () => M.say({ text: 'again?' }), /this meeting is closed/);
  // an incident meeting interrupts a planning meeting; closing it resumes the planning meeting
  await M.newMeeting({ type: 'planning', title: 'Q1 plan' });
  runner.script({ dave: 'Plan point.' });
  await M.say({ text: 'Plan.' }); await idle(M);
  const planId = (await M.view()).meeting.id;
  await assert.rejects(async () => M.newMeeting({ type: 'review' }), /one meeting at a time/);
  await M.newMeeting({ type: 'incident', title: 'Site down' });
  assert.strictEqual(M.list().find(m => m.id === planId).state, 'interrupted');
  runner.script({ dave: 'Incident point.' });
  await M.say({ text: 'What broke?' }); await idle(M);
  assert.ok(/This is an incident meeting/.test(runner.turns().pop().last), 'the type selects the prompt block');
  await M.close({});
  const back = await M.view();
  assert.ok(back.meeting.id === planId && back.meeting.state === 'open', 'the planning meeting carries on');
  // close during a round stops it first
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: { text: 'long', hold }, sharon: 'never' });
  await M.say({ text: 'One more.' }); await new Promise(r => setTimeout(r, 30));
  const p = M.close({}); release(); await p;
  assert.strictEqual((await M.view()).meeting.state, 'closed');
  assert.ok(!runner.turns().some(c => c.seat === 'sharon' && /One more/.test(c.all) && c.last.includes('Your turn, Sharon') && c.all.includes('long')), 'nobody after the close');
});

test('a malformed ASK / CALL / END surfaces a visible parse failure, and the writer is told', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: ['My view.\nASK Sharon what about cost?\nEND -  done\nCALL: Nobody', 'Fixed.'], sharon: ['Ok.', 'Ok.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const pf = kinds(M, 'parse');
  assert.ok(pf.some(e => /^ASK Sharon/.test(e.line) && /needs a colon/.test(e.why)), JSON.stringify(pf));
  assert.ok(pf.some(e => /^END/.test(e.line)), 'END without a colon');
  assert.ok(pf.some(e => /CALL: Nobody/.test(e.line) && /nobody called Nobody/.test(e.why)), 'an unknown name');
  const said0 = kinds(M, 'say').find(e => e.who === 'dave');
  assert.ok(/ASK Sharon what about cost\?/.test(said0.text), 'the unreadable line stays visible in what was said');
  assert.ok(M.entries(new URLSearchParams()).entries.some(e => e.kind === 'parse'), 'shown on the page');
  await M.say({ text: 'Again.' }); await idle(M);
  assert.ok(/could not be read, so nothing was done with them/.test(runner.turns().filter(c => c.seat === 'dave').pop().last), 'the writer is told on the next turn');
});

test('minutes: written as it happens, every word by speaker with times and models, in the reference shape', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'phil'], leader: 'dave', models: { phil: { provider: 'deepseek', model: 'deepseek-flash' } } });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: 'First words.\nRULING: Phil owns the fix — plain: Phil fixes it', phil: { text: 'Second words.', hold } });
  await M.say({ text: 'Minutes check.' });
  const day = co.localParts(new Date()).date; const f = 'company/work/meetings/meeting-' + day + '.md';
  for (let i = 0; i < 200 && !/First words/.test(R(f)); i++) await new Promise(r => setTimeout(r, 10));
  const mid = R(f);
  assert.ok(/^# Meeting: \d{4}-\d{2}-\d{2}/.test(mid) && /## \d\d:\d\d: the meeting opens/.test(mid) && /\*\*Caullen\*\* \(\d\d:\d\d\):\nMinutes check\./.test(mid) && /\*\*Dave\*\* \(\d\d:\d\d, Claude Sonnet\):\nFirst words\./.test(mid), 'written as it happens: ' + mid);
  assert.ok(!/Second words/.test(mid), 'Phil has not spoken yet');
  release(); await idle(M);
  const all = R(f);
  assert.ok(/\*\*Phil\*\* \(\d\d:\d\d, DeepSeek \(deepseek-flash\)\):\nSecond words\./.test(all), all);
  assert.ok(/_\d\d:\d\d: Dave proposed a ruling for Caullen to confirm: Phil owns the fix\._/.test(all));
  assert.ok(!/Phil owns the fix/.test(R('company/work/decisions.md')), 'a proposed ruling is not in decisions.md until the owner confirms it');
  assert.ok(!/PASS/.test(all), 'passes are not shown');
});

test('a refused turn mid-meeting is retried once on the next chain entry, said in one plain line', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: { text: 'Answered on the next model.', refuse: true }, sharon: 'Fine.' });
  await M.say({ text: 'Go.' }); await idle(M);
  const d = runner.turns().filter(c => c.seat === 'dave');
  assert.deepStrictEqual(d.map(c => c.model.provider), ['claude-cli', 'deepseek']);
  assert.ok(kinds(M, 'note').some(e => e.text === 'Dave: Claude declined this; DeepSeek is answering instead.'));
  assert.ok(kinds(M, 'say').some(e => e.who === 'dave' && e.model === 'DeepSeek (deepseek-flash)' && /next model/.test(e.text)));
  assert.ok(/"door":"meeting"/.test(R('company/state/model-moves.jsonl')), 'recorded on the seat');
  assert.strictEqual(runner.turns().filter(c => c.seat === 'sharon').length, 1, 'the meeting carries on');
});

test('owner scope: crew work put to the owner is flagged and corrected on the next turn; while observing, any question to the owner', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ sharon: ['Could you add a healthchecks check named recorder, period 5, grace 15, and paste its ping URL?', 'Handled it myself.'], dave: ['Ok.', 'Ok.'] });
  await M.say({ text: 'Go.' }); await idle(M);
  const s = kinds(M, 'say').find(e => e.who === 'sharon');
  assert.ok(s.lint && s.lint.kind === 'crew-scope', JSON.stringify(s));
  await M.say({ text: 'Next.' }); await idle(M);
  assert.ok(/Console note on your last reply: it puts crew work to Caullen/.test(runner.turns().filter(c => c.seat === 'sharon').pop().last));
  M.setObserve({ on: true, rounds: 1 });
  runner.script({ dave: 'Caullen, could you confirm the budget before we go on?\nASK: Caullen — which market?' });
  await M.say({ text: 'Observe.' }); await idle(M);
  const q = kinds(M, 'say').filter(e => e.who === 'dave').pop();
  assert.ok(q.lint && q.lint.kind === 'observe-question', JSON.stringify(q));
  assert.ok(kinds(M, 'note').some(e => /put a question to Caullen, who is observing/.test(e.text)), 'an ASK of the observing owner is not put to them');
});

test('Raise hand, Continue, Stop round, a message during a round', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: { text: 'Long answer.', hold }, sharon: 'S.', phil: 'P.' });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  M.hand();
  assert.strictEqual((await M.view()).live.ownerHand, true);
  release();
  for (let i = 0; i < 100 && (await M.view()).live.phase !== 'floor'; i++) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual((await M.view()).live.phase, 'floor', 'the floor is the owner\'s after the current speaker');
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave']);
  M.carryOn(); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'sharon', 'phil'], 'Continue lets them carry on');
  // a message typed while a round runs starts the next round after the current speaker
  let rel2; const hold2 = new Promise(r => { rel2 = r; });
  runner.script({ dave: [{ text: 'Again.', hold: hold2 }, 'On your point.'], sharon: ['S2.', 'S3.'], phil: ['P2.', 'P3.'] });
  await M.say({ text: 'Round two.' });
  await new Promise(r => setTimeout(r, 30));
  await M.say({ text: 'Actually, one more thing.' });
  rel2(); await idle(M);
  const after = said(M).slice(-4);
  assert.deepStrictEqual(after[0], 'owner: Actually, one more thing.', 'taken after the current speaker: ' + said(M).join(' | '));
  // Stop round stops now
  let rel3; const hold3 = new Promise(r => { rel3 = r; });
  runner.script({ dave: { text: 'Never finished.', hold: hold3 } });
  const n = runner.turns().length;
  await M.say({ text: 'Stop test.' });
  await new Promise(r => setTimeout(r, 30));
  M.stop(); rel3(); await idle(M);
  assert.strictEqual(runner.turns().length, n + 1, 'nobody after the stopped speaker');
  assert.ok(kinds(M, 'note').some(e => e.text === 'Round stopped.'));
});

test('soft halt: the turn in progress finishes, the minutes are written, the meeting is interrupted', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: { text: 'I finish my sentence.', hold }, sharon: 'never' });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  W('company/state/halt.json', { mode: 'soft', by: 'Caullen' });
  await new Promise(r => setTimeout(r, 1200));
  assert.ok(!runner.pending.get(runner.turns()[0].runId).cancelled, 'a soft halt does not cut the turn off');
  release(); await idle(M);
  assert.ok(kinds(M, 'say').some(e => e.who === 'dave' && e.text === 'I finish my sentence.'), 'the turn finished whole');
  assert.ok(!runner.turns().some(c => c.seat === 'sharon'), 'nobody starts after it');
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'interrupted'); assert.match(v.meeting.reason, /soft halt/);
  const mins = R('company/work/meetings/meeting-' + co.localParts(new Date()).date + '.md');
  assert.ok(/I finish my sentence\./.test(mins) && /The meeting was interrupted: soft halt/.test(mins), 'the minutes are written');
  await assert.rejects(async () => M.say({ text: 'Hello?' }), /halt/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
});

test('hard halt: the turn is aborted, the meeting marked interrupted, and it can be resumed after the halt', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: { text: 'Mid-sentence', hold }, sharon: ['never', 'After the halt.'] });
  await M.say({ text: 'Go.' });
  await new Promise(r => setTimeout(r, 30));
  W('company/state/halt.json', { mode: 'hard', by: 'Caullen' });
  await new Promise(r => setTimeout(r, 1200)); release(); await idle(M);
  assert.ok(runner.pending.get(runner.turns()[0].runId).cancelled, 'the turn in flight is cancelled');
  assert.ok(!runner.turns().some(c => c.seat === 'sharon'), 'nobody speaks after the halt');
  const v = await M.view();
  assert.strictEqual(v.meeting.state, 'interrupted'); assert.match(v.meeting.reason, /hard halt: aborted/);
  await assert.rejects(async () => M.resume({}), /halt/, 'not under the halt');
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  await M.resume({});
  assert.strictEqual((await M.view()).meeting.state, 'open', 'resumable');
  await M.say({ text: '@sharon carry on' }); await idle(M);
  assert.ok(kinds(M, 'say').some(e => e.who === 'sharon'));
});

test('a consent prompt inside a turn goes to the approvals path (Today) and pauses the meeting until answered', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  M.agenda({ op: 'add', title: 'Check', tools: true });
  runner.script({ dave: { text: 'I checked the folder.', consent: true }, sharon: 'Thanks.' });
  await M.say({ text: 'Check it.' });
  let v; for (let i = 0; i < 100; i++) { v = await M.view(); if (v.live.pausedFor) break; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(v.live.paused && v.live.pausedFor && v.live.pausedFor.tool === 'code.run' && v.live.pausedFor.qid, JSON.stringify(v.live));
  const inbox = require(path.join(REPO, 'company/tools/inbox.js'));
  const q = inbox.state()[v.live.pausedFor.qid];
  assert.ok(q && q.type === 'ask' && /Dave wants to use code\.run during your meeting/.test(q.message), 'an owner question on Today');
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(runner.calls.map(c => c.seat), ['dave'], 'nothing else starts while it waits');
  const prov = require(path.join(REPO, 'company/tools/provenance.js'));
  prov.pinOwnerShell(true);
  try { inbox.answer({ id: q.id, a: 'yes', answer: { verdict: 'yes' }, by: 'owner' }); } finally { prov.pinOwnerShell(null); }
  await idle(M);
  assert.deepStrictEqual(runner.consents.map(c => c.decision), ['once'], 'the answer goes back to the station');
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'sharon'], 'then the meeting carries on');
  assert.ok(kinds(M, 'consent').some(e => e.op === 'answered' && e.decision === 'once'));
});

test('a seat in the middle of a routine run sits the turn out: the meeting does not stall on it', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave', busy: ['sharon'] });
  runner.script({ dave: 'D.', sharon: 'never', phil: 'P.' });
  await M.say({ text: 'Go.' }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'phil']);
  assert.ok(kinds(M, 'note').some(e => /Sharon is in the middle of a routine run, so they sit this turn out/.test(e.text)));
});

test('state: under company/state/meetings, mode 600, read bounded, covered by retention', async () => {
  const { M, runner } = fresh({ seats: ['dave'], leader: 'dave' });
  runner.script({ dave: 'x' });
  await M.say({ text: 'state' }); await idle(M);
  const id = (await M.view()).meeting.id;
  for (const f of ['seats.json', 'current.json', 'm/' + id + '.json', 'events/' + id + '.jsonl']) assert.strictEqual(fs.statSync(path.join(T, 'company/state/meetings', f)).mode & 0o777, 0o600, f);
  for (const d of ['', 'm', 'events']) assert.strictEqual(fs.statSync(path.join(T, 'company/state/meetings', d)).mode & 0o777, 0o700, d);
  const ret = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/work/ops/retention.json'), 'utf8')).artifacts;
  assert.ok(ret.some(a => a.path === 'company/state/meetings/events/*.jsonl' && a.policy === 'roll-monthly' && a.maxLiveBytes), 'each meeting\'s events are bounded by retention.js');
  assert.ok(/tailText\(F\.events\(id\), LOG_READ_BYTES\)/.test(fs.readFileSync(path.join(REPO, 'console/meeting.js'), 'utf8')), 'read from its end (lib/bounded.js)');
  // a console restart reads the meeting back
  const again = meetingLib({ co, owner: () => 'Caullen', runner, run, modelFor: async () => ({ provider: 'claude-cli', model: 'x' }) });
  assert.ok(again._state().LOG.some(e => e.kind === 'say' && e.text === 'x'));
  const cost = (await again.view()).meeting.cost;
  assert.ok(cost.turns >= 1 && cost.usd > 0, JSON.stringify(cost));
});

test('protocol lines are parsed and hidden from what was said', () => {
  const d = meetingLib.directives('My point.\n**ASK:** @Sharon — what is the budget?\nINVITE: Rachel and Nadia (hiring)\nDISMISS: me — done\nCALL: Phil\nEND: decided X\nRULING: Phil owns it');
  assert.strictEqual(d.body, 'My point.');
  assert.deepStrictEqual(d.list.map(x => x.kind + ':' + x.name), ['ASK:Sharon', 'INVITE:Rachel', 'INVITE:Nadia', 'DISMISS:me', 'CALL:Phil', 'END:', 'RULING:']);
  assert.strictEqual(d.list[0].why, 'what is the budget?');
  assert.ok(meetingLib.isPass('PASS') && meetingLib.isPass(' pass. ') && !meetingLib.isPass('I pass on that, but'));
  assert.strictEqual(meetingLib.handReply('HAND — on cost.'), 'on cost'); assert.strictEqual(meetingLib.handReply('NO'), null);
});

test('pacing: with the owner present and manual pacing, a 7-seat 3-round meeting never advances without Next', async () => {
  const seats = ['dave', 'sharon', 'phil', 'rachel', 'nadia', 'omar', 'leo'];
  const { M, runner } = fresh({ seats, leader: 'dave' });
  M.setObserve({ on: true, rounds: 3 });
  const script = {}; for (const id of seats) script[id] = ['r1 ' + id, 'r2 ' + id, 'r3 ' + id];
  runner.script(script);
  M.presence({ here: true });
  assert.strictEqual((await M.view()).meeting.effectiveSpeed, 'manual', 'Next is the default while the owner is present');
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
  const t2 = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  t2.runner.script({ dave: 'a', sharon: 'b' });
  t2.M.presence({ here: false });
  await t2.M.say({ text: 'While I am away.' }); await idle(t2.M);
  assert.strictEqual(t2.runner.turns().length, 2, 'advances with nobody pressing Next');
});

test('pause: the current turn finishes, nothing new starts and nothing is spent until released', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ dave: { text: 'Finishing my point.', hold }, sharon: 'S.', phil: 'P.' });
  await M.say({ text: 'Go.' }); await new Promise(r => setTimeout(r, 30));
  M.hold({ on: true }); release();
  await new Promise(r => setTimeout(r, 150));
  assert.deepStrictEqual(runner.calls.map(c => c.seat), ['dave'], 'no new run while paused');
  assert.ok(kinds(M, 'say').some(e => e.who === 'dave'), 'the turn in progress finished and is shown');
  assert.ok((await M.view()).live.paused);
  M.hold({ on: false }); await idle(M);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['dave', 'sharon', 'phil']);
});

test('your turn: an ASK of the owner or a CALL from the leader gives the owner the floor; Catch me up is one talk-only turn for the owner', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave' });
  runner.script({ dave: 'Over to you.\nASK: Caullen — which market first?', sharon: 'S.' });
  await M.say({ text: 'Go.' });
  for (let i = 0; i < 100 && (await M.view()).live.phase !== 'floor'; i++) await new Promise(r => setTimeout(r, 10));
  const v = await M.view();
  assert.ok(v.live.yourTurn && /Dave asked you: which market first\?/.test(v.live.floorWhy), JSON.stringify(v.live));
  await M.say({ text: 'Sports first.' }); await idle(M);
  runner.script({ 'dave:catchup': 'Summary bullets.\n- a\n- b' });
  const n = runner.calls.length;
  await M.catchUp({ since: 0 });
  const c = runner.calls.slice(n);
  assert.ok(c.length === 1 && c[0].purpose === 'catchup' && c[0].tools === false && /CATCH-UP for Caullen/.test(c[0].last));
  assert.ok(kinds(M, 'catchup').length === 1 && !kinds(M, 'say').some(e => /Summary bullets/.test(e.text)), 'shown to the owner, not part of the meeting');
  runner.script({ sharon: 'Later.' });
  await M.say({ text: 'Next.' }); await idle(M);
  assert.ok(!/Summary bullets/.test(runner.turns().pop().all), 'the seats never see the catch-up');
  assert.ok(M.timeline().moments.some(m => m.kind === 'ask'), 'the timeline has the moments to scrub to');
});

test('the action register: rows come from their owners\' lines, a row without a plain line fails visibly, only confirmed owner rulings reach decisions.md, each owner updates their own lines', async () => {
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave' });
  runner.script({ dave: 'Proposal.\nRULING: Email stays on Proton for now — plain: we keep the email we have', sharon: 'I will price it.\nACTION: Price both email options — by 2026-11-20 — plain: Sharon finds what each email option costs — affects: Finance, Risk\nQUESTION: Does mail from home deliver? — plain: can we send mail from the office line', phil: 'ACTION: Check port 25 — by own loop' });
  await M.say({ text: 'Email: what do we do?' }); await idle(M);
  const rv = M.registerView(); const r = rv.register;
  assert.deepStrictEqual(r.actions.map(a => [a.n, a.owner, a.date, a.status, a.affects]), [[1, 'sharon', '2026-11-20', 'open', 'Finance, Risk']], 'Sharon\'s own line');
  assert.strictEqual(r.actions[0].plain, 'Sharon finds what each email option costs');
  assert.ok(kinds(M, 'parse').some(e => e.who === 'phil' && /no plain-language line/.test(e.why)), 'Phil\'s line without a plain part is refused, visibly');
  assert.ok(r.questions.length === 1 && r.questions[0].owner === 'sharon');
  assert.ok(r.rulings.length === 1 && !r.rulings[0].confirmed && r.rulings[0].proposedBy === 'dave', 'the leader proposes; the owner confirms');
  assert.ok(!/Email stays on Proton/.test(R('company/work/decisions.md')));
  await M.register({ op: 'confirm', n: 1 });
  assert.ok(/Caullen \[d-[0-9a-f]{6}\] Meeting ruling \(\d{4}-\d{2}-\d{2}\): Email stays on Proton for now In plain words: we keep the email we have/.test(R('company/work/decisions.md')), R('company/work/decisions.md').slice(0, 400));
  await M.register({ op: 'ruling', text: 'No new tools this week', plain: 'we use what we have this week' });
  await assert.rejects(async () => M.register({ op: 'ruling', text: 'No plain line' }), /plain-language line/);
  await assert.rejects(async () => M.register({ op: 'update', section: 'actions', n: 1, status: 'done' }), /only sharon updates this line/);
  await M.register({ op: 'not-recorded', text: 'No outside party was contacted.' });
  const md = R(path.relative(T, path.join(T, M.registerView().file)));
  assert.ok(/## Owner rulings/.test(md) && /confirmed by the owner/.test(md) && /\| 1 \| Price both email options \| Sharon finds what each email option costs \| Sharon \| 2026-11-20 \| open \| Finance, Risk \|/.test(md) && /## Not recorded here\n- No outside party was contacted\./.test(md), md);
  // searchable: participants, decisions, actions, links
  runner.script({ dave: 'See q:78 and to-sharon.md.' });
  await M.say({ text: '@dave links?' }); await idle(M);
  const s1 = M.search(new URLSearchParams('q=price both email')).meetings;
  assert.ok(s1.length === 1 && s1[0].actions[0].owner === 'Sharon' && s1[0].participants.includes('Sharon'));
  const s2 = M.search(new URLSearchParams('q=q:78')).meetings;
  assert.ok(s2.length === 1 && s2[0].links.quests.includes('q:78') && s2[0].links.handoffs.includes('to-sharon.md'), JSON.stringify(s2));
});

test('legibility: seat frames name the speaker\'s function and what the others in the room need; the speaking contract; the company language', async () => {
  const { M, runner } = fresh({ seats: ['sharon', 'phil', 'nadia'], leader: null });
  runner.script({ sharon: 'S.', phil: 'P.', nadia: 'N.' });
  co.config.locale = 'vi';
  try { await M.say({ text: 'Should we self-host email?' }); await idle(M); } finally { co.config.locale = 'en'; }
  const sh = runner.turns().find(c => c.seat === 'sharon');
  assert.match(sh.last, /Your seat: Finance\. In the room: Phil \(Risk and legal: needs the exposure, and any commitment or promise it makes for the company\); Nadia \(Tools and IT: needs what has to change in how things run, and who builds and checks it\)/, 'a Finance + Tools + Risk table addresses the room');
  assert.match(runner.turns().find(c => c.seat === 'phil').last, /Your seat: Risk and legal\. In the room: Sharon \(Finance: needs what it costs/);
  assert.match(sh.all, /Your point first, in one line[\s\S]*Define any term the room may not share[\s\S]*Say what your point means for the other functions present/, 'the speaking contract');
  assert.match(sh.last, /Speak Vietnamese \(the company's language, company\.json locale vi\)/);
});

test('Explain for the room: one cheap talk-only turn of that speaker; the term check (no model) and the glossary', async () => {
  const { M, runner } = fresh({ seats: ['sharon', 'phil'], leader: null });
  runner.script({ sharon: 'Our CAC is up and the MRR (monthly recurring revenue) is flat; the SLA holds.', phil: 'PASS', 'sharon:explain': 'In short: getting each customer costs more, income is flat.' });
  await M.say({ text: 'Numbers?' }); await idle(M);
  const e = kinds(M, 'say').find(x => x.who === 'sharon');
  const n = runner.calls.length;
  await M.explain({ i: e.i });
  const c = runner.calls.slice(n);
  assert.ok(c.length === 1 && c[0].purpose === 'explain' && c[0].tools === false && c[0].seat === 'sharon' && /EXPLAIN FOR THE ROOM/.test(c[0].last), 'one talk-only turn of the speaker');
  assert.ok(kinds(M, 'say').some(x => x.explains === e.i && /getting each customer costs more/.test(x.text)), 'everyone in the room sees it');
  const before = runner.calls.length;
  const t1 = M.terms().undefined.map(x => x.term);
  assert.strictEqual(runner.calls.length, before, 'the term check runs no model');
  assert.deepStrictEqual(t1.sort(), ['CAC', 'SLA'], 'MRR is defined in the text; CAC and SLA are not');
  M.addTerm({ term: 'CAC', meaning: 'what it costs to win one customer' });
  assert.ok(/- \*\*CAC\*\*: what it costs to win one customer/.test(R('company/work/meetings/glossary.md')));
  assert.deepStrictEqual(M.terms().undefined.map(x => x.term), ['SLA']);
  await M.close({});
  assert.ok(kinds(M, 'note').some(x => /Terms used without a definition: SLA \(first used by Sharon\)/.test(x.text)), 'the check runs after the meeting, into the minutes');
});

test('the cost line is information: dollars for a metered model, the share of a subscription\'s windows (never $0.00), "unknown" for an unmetered one', async () => {
  W('company/work/finance/dispatch-budget.json', { dailyUsd: 5, unmeteredProviders: ['claude-cli', 'local'] });
  W('company/work/finance/subscriptions.json', { plans: [{ provider: 'claude-cli', name: 'Claude Max', seats: 1, price: 100, currency: 'USD', cycle: 'monthly', meter: 'pacer', windows: ['five_hour', 'seven_day'] }] });
  const pst = { history: { claude: [{ at: Date.now() - 1000, usedPct: 40 }] }, last: { claude: { at: Date.now() - 1000, fiveHour: { usedPct: 10 } } } };
  W('company/state/pacer-state.json', pst);
  const { M, runner } = fresh({ seats: ['dave', 'sharon', 'phil'], leader: 'dave', models: { sharon: { provider: 'deepseek', model: 'deepseek-flash' }, phil: { provider: 'local', model: 'llama' } } });
  runner.script({ dave: 'D.', sharon: 'S.', phil: 'P.' });
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
  const { M, runner } = fresh({ seats: ['dave', 'sharon'], leader: 'dave', models });
  models.sharon = {};   // no usable model (a seat with no chain and no roster model)
  runner.script({ dave: ['D1.', 'D2.'], sharon: ['S2.'] });
  await M.say({ text: 'First.' }); await idle(M);
  assert.ok(kinds(M, 'note').some(e => /^Sharon sits this one out: Sharon has no AI model to think with/.test(e.text)), 'a visible note, not a silent drop');
  models.sharon = { provider: 'deepseek', model: 'deepseek-flash' }; models.dave = { provider: 'deepseek', model: 'deepseek-flash' };
  await M.say({ text: 'Second.' }); await idle(M);
  const last = runner.turns().slice(-2);
  assert.deepStrictEqual(last.map(c => c.seat + '/' + c.model.provider), ['dave/deepseek', 'sharon/deepseek'], 'the model is read again for every turn');
});
