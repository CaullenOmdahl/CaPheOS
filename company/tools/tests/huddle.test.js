'use strict';
// huddle.test.js — a colleague brought into the owner's live chat (console/huddle.js on console/meeting.js's engine),
// with a scripted runner in place of the station: an ASK in the host's reply opens it and the guest answers first; the
// host's closing turn only when something is new; DISMISS by an agent, DISMISS: me, the owner's ×; the last guest leaving
// closes it and leaves a recap for the host's next 1:1 message (chat.js contextNote); 3 guests and 8 replies at most; a
// busy guest answers talk only; a closed chain sits out; admit rows (door chat, kind meeting-turn); a hard halt refuses;
// the 2-hour idle close. The station path is tests/huddle-walk.js.
//   node --test company/tools/tests/huddle.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-selftest-'));
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const CREW = { dave: ['Dave', 'CEO'], sharon: ['Sharon', 'CFO'], phil: ['Phil', 'IT Admin'], nadia: ['Nadia', 'Engineer'], omar: ['Omar', 'DevOps'] };
const agents = {}; for (const [id, [name, title]] of Object.entries(CREW)) agents[id] = { name, title, manager: id === 'dave' ? null : 'dave', inbox: 'to-' + id + '.md' };
W('company/company.json', { name: 'Huddle Test', owner: { name: 'Caullen' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents });
W('company/model-policy.json', { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5'] } }, candidateDefault: { provider: 'claude-cli', model: 'claude-sonnet-5-5' } });
process.env.CAPHEOS_ROOT = T; process.env.STARNET_URL = 'http://127.0.0.1:1';
const REPO = path.join(__dirname, '..', '..', '..');
const co = require(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
const huddleLib = require(path.join(REPO, 'console', 'huddle.js'));
const chatLib = require(path.join(REPO, 'console', 'chat.js'));
const MT = () => { delete require.cache[require.resolve(path.join(REPO, 'company', 'tools', 'lib', 'meetings.js'))]; return require(path.join(REPO, 'company', 'tools', 'lib', 'meetings.js')); };
test.after(() => fs.rmSync(T, { recursive: true, force: true }));

function makeRunner() {
  const r = { queues: {}, calls: [], seq: 0, pending: new Map() };
  r.script = o => { for (const [k, v] of Object.entries(o)) (r.queues[k] = r.queues[k] || []).push(...[].concat(v)); };
  r.start = async o => {
    const kind = o.purpose === 'turn' ? '' : ':' + o.purpose; const q = r.queues[o.seat + kind] = r.queues[o.seat + kind] || [];
    let e = q[0]; if (e === undefined) e = o.purpose === 'turn' ? 'PASS' : o.purpose === 'hand' ? 'NO' : 'OK';
    if (typeof e === 'string') e = { text: e };
    const refused = !!e.refuse && o.model.provider === 'claude-cli';
    if (!refused) q.shift();
    const runId = 'r' + (++r.seq);
    r.calls.push(Object.assign({ runId, last: o.messages[o.messages.length - 1].content, all: o.messages.map(m => m.content).join('\n') }, o));
    r.pending.set(runId, { text: e.text, refused, hold: e.hold });
    return { runId };
  };
  r.wait = async runId => { const p = r.pending.get(runId); await new Promise(res => setTimeout(res, 3)); if (p.hold) await p.hold; if (p.cancelled) return { text: '', usd: 0, refused: false, complete: false, error: 'cancelled' }; return { text: p.refused ? '' : p.text, usd: 0, refused: p.refused, complete: !p.refused, error: null }; };
  r.cancel = runId => { const p = r.pending.get(runId); if (p) p.cancelled = true; };
  r.consent = () => {};
  r.turns = () => r.calls.filter(c => c.purpose === 'turn');
  return r;
}
const CHAT_TURNS = [{ role: 'user', content: 'Is the deploy done?' }, { role: 'assistant', content: 'Let me check with Nadia.\nASK: Nadia — is the deploy done?', runId: 'run-1' }];
function fresh(opts) {
  opts = opts || {};
  fs.rmSync(path.join(T, 'company/state/huddles'), { recursive: true, force: true });
  const runner = makeRunner(); const models = opts.models || {};
  const H = huddleLib({ co, owner: () => 'Caullen', runner, run: async () => ({ code: 0 }), emit: () => {}, idleMs: opts.idleMs,
    seatBusy: async id => !!(opts.busy && opts.busy.includes(id)),
    modelFor: async id => { const m = models[id]; if (m instanceof Error) throw m; return m === undefined ? { provider: 'claude-cli', model: 'claude-sonnet-5-5' } : m; },
    chat: { transcript: async () => ({ ok: true, turns: (opts.turns || CHAT_TURNS).slice() }) } });
  return { H, runner };
}
async function idle(H, host) { const E = H.engine(host || 'dave'); for (let i = 0; i < 400; i++) { if (E.idle()) { await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 5)); if (E.idle()) return E; } await new Promise(r => setTimeout(r, 10)); } throw new Error('the chat did not settle'); }
const LOG = H => H.engine('dave')._state().LOG;

test('an ASK in the host\'s reply opens the chat with the colleague: the chat so far goes in, the guest answers first, the host closes the loop', async () => {
  const { H, runner } = fresh();
  runner.script({ nadia: 'The deploy is green.', dave: 'Caullen, Nadia says the deploy is green.' });
  const r = await H.pullFrom('dave', { text: CHAT_TURNS[1].content, runId: 'run-1' });
  assert.ok(r && r.host === 'dave' && /^m-/.test(r.id));
  await idle(H);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['nadia', 'dave']);
  const g = runner.turns()[0];
  assert.ok(/Caullen \(owner\): Is the deploy done\?/.test(g.all) && /Dave: Let me check with Nadia\./.test(g.all), 'the guest sees the chat so far');
  assert.ok(!/ASK: Nadia/.test(g.all.split('Dave asked you directly')[0].split('[THE TABLE]').pop().replace(/ASK: <name>/g, '')), 'the host\'s ASK line is the ask, not repeated as text');
  assert.ok(/live chat with Dave/.test(g.all) && /Dave asked you directly: is the deploy done\?/.test(g.last));
  assert.ok(g.streamPrefix === undefined && g.tools === true, 'tools on, as at the table');
  assert.ok(/Close the loop for Caullen/.test(runner.turns()[1].last), 'the host\'s closing turn');
  assert.ok(H.isOpen('dave'));
  const v = await H.view('dave');
  assert.ok(v.open && v.seats.map(s => s.id).join() === 'dave,nadia' && v.seats[0].leader);
  assert.ok(fs.existsSync(path.join(T, 'company/work/meetings/chat-dave-' + co.localParts(new Date()).date + '.md')), 'its minutes');
  const adm = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind === 'meeting-turn');
  assert.ok(adm.length >= 2 && adm.every(x => x.door === 'chat' && x.decision === 'allow' && /^m-/.test(x.meetingId)), 'every guest run is admitted: door chat, kind meeting-turn');
  // lines that name nobody, or the host itself, open nothing
  assert.strictEqual(H.pullLines('dave', 'ASK: Dave — me?\nINVITE: Zed — who').length, 0);
});

test('the host\'s closing turn runs only when something is new; the owner\'s message goes to everyone, the host first', async () => {
  const { H, runner } = fresh();
  runner.script({ nadia: 'PASS' });
  await H.pullFrom('dave', { text: 'Hm.\nINVITE: Nadia — the deploy' }); await idle(H);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['nadia'], 'Nadia passed: nothing new, so no closing turn');
  runner.script({ dave: 'Here is the plan.', nadia: 'I agree, Dave.' });
  await H.say('dave', { text: 'What now?' }); await idle(H);
  assert.deepStrictEqual(runner.turns().slice(1).map(c => c.seat), ['dave', 'nadia']);
});

test('DISMISS by an agent, DISMISS: me, the owner\'s ×; the last guest leaving closes it, with a recap for the host\'s next 1:1 message', async () => {
  const { H, runner } = fresh();
  runner.script({ nadia: 'Green.', sharon: 'Budget is fine.\nDISMISS: me — done', dave: ['Thanks.\nDISMISS: Nadia — answered', 'Done.'] });
  await H.pullFrom('dave', { text: 'x\nASK: Nadia — deploy?\nINVITE: Sharon — budget' }); await idle(H);
  const leaves = LOG(H).filter(e => e.kind === 'leave');
  assert.ok(leaves.some(e => e.who === 'sharon' && e.by === 'sharon'), 'DISMISS: me');
  assert.ok(leaves.some(e => e.who === 'nadia' && e.by === 'dave'), 'DISMISS by the host');
  assert.ok(!H.isOpen('dave'), 'the last guest left: the chat is 1:1 again');
  assert.strictEqual(H.engine('dave').state(), 'closed');
  const recap = H.takeRecap('dave');
  assert.ok(/^\[While Nadia and Sharon were in this chat/.test(recap) && /Nadia: Green\./.test(recap) && /Sharon: Budget is fine\./.test(recap), recap);
  const s = Object.assign({ id: 'dave' }, co.crew().dave);
  const note = chatLib.contextNote('dave', s, co, 'hello', recap);
  assert.ok(note.includes('Nadia: Green.') && /To bring a colleague into this chat now, end your reply with a line of its own: ASK: <name>/.test(note), 'the recap and the pull-in line are in the host\'s next message');
  assert.strictEqual(H.takeRecap('dave'), '', 'the recap is given once');
  // the owner brings someone in (+ Colleague) and sends them back out (×)
  const v = await H.seats('dave', { add: ['phil'] });
  assert.ok(v.open && v.seats.some(x => x.id === 'phil' && x.guest), 'a guest of this chat');
  assert.ok(LOG(H).some(e => e.kind === 'say' && e.src === 'chat' && /Is the deploy done/.test(e.text)), 'a new chat starts from the chat so far');
  assert.ok(LOG(H).some(e => e.kind === 'join' && e.who === 'phil' && e.by === 'owner'));
  await H.seats('dave', { remove: ['phil'] }); await idle(H);
  assert.ok(!H.isOpen('dave') && LOG(H).some(e => e.kind === 'leave' && e.who === 'phil' && e.by === 'owner'), 'the owner\'s ×');
  await assert.rejects(() => H.seats('dave', { remove: ['dave'] }), /nobody else is in this chat|leads this chat/);
});

test('limits: 3 colleagues at once, 2 invites a round, 8 replies per owner message', async () => {
  const { H, runner } = fresh();
  runner.script({ nadia: 'N.', sharon: 'S.', dave: ['PASS', 'INVITE: Phil — p\nINVITE: Omar — o\nINVITE: Omar — o2'], phil: 'P.', omar: 'O.' });
  await H.pullFrom('dave', { text: 'x\nINVITE: Nadia — a\nINVITE: Sharon — b\nINVITE: Phil — c' }); await idle(H);
  assert.ok(LOG(H).some(e => e.kind === 'note' && /Dave invited Phil: not this round, 2 people were invited already/.test(e.text)), '2 invites a round');
  await H.say('dave', { text: 'more people' }); await idle(H);
  const notes = LOG(H).filter(e => e.kind === 'note').map(e => e.text).join('\n');
  assert.ok(/3 colleagues are here already, the most at once/.test(notes), notes);
  await assert.rejects(() => H.seats('dave', { add: ['omar'] }), /3 colleagues are here already/);
  runner.script({ dave: ['ASK: Nadia — 1?', 'ASK: Nadia — 3?', 'ASK: Nadia — 5?', 'ASK: Nadia — 7?'], nadia: ['ASK: Dave — 2?', 'ASK: Dave — 4?', 'ASK: Dave — 6?', 'ASK: Dave — 8?'] });
  const n = runner.turns().length;
  await H.say('dave', { text: 'Talk it through.' }); await idle(H);
  assert.strictEqual(runner.turns().length - n, 8);
  assert.ok(LOG(H).some(e => e.kind === 'note' && e.text === 'The chat paused after 8 replies; write to carry on.'));
});

test('a busy colleague answers at once, talk only; a closed chain or a $0-cap hold sits out in one line', async () => {
  const { H, runner } = fresh({ busy: ['nadia'], models: { sharon: null, phil: new Error('Phil runs on deepseek, which bills per token, and the daily cap is $0: the budget holds every metered run.') } });
  runner.script({ nadia: 'From what I know: green.' });
  await H.pullFrom('dave', { text: 'x\nASK: Nadia — deploy?\nINVITE: Sharon — b' }); await idle(H);
  runner.script({ dave: 'INVITE: Phil — c' });
  await H.say('dave', { text: 'And Phil?' }); await idle(H);
  const t = runner.turns().find(c => c.seat === 'nadia');
  assert.ok(t && t.tools === false && /no tools this turn/.test(t.last), 'talk only, told so');
  const notes = LOG(H).filter(e => e.kind === 'note').map(e => e.text).join('\n');
  assert.ok(/Nadia is in the middle of a routine run, so Nadia speaks without tools this turn/.test(notes));
  assert.ok(/Sharon sits this one out: Sharon has no AI model to think with/.test(notes), notes);
  assert.ok(/Phil sits this one out: .*daily cap is \$0/.test(notes), notes);
  assert.ok(!runner.turns().some(c => c.seat === 'sharon' || c.seat === 'phil'));
});

test('a refused guest turn is retried once on the next chain entry', async () => {
  W('company/model-policy.json', { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5'] }, deepseek: { models: ['deepseek-flash'] } }, seats: { nadia: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } }, candidateDefault: { provider: 'claude-cli', model: 'claude-sonnet-5-5' } });
  const { H, runner } = fresh();
  runner.script({ nadia: { text: 'Green, from DeepSeek.', refuse: true } });
  await H.pullFrom('dave', { text: 'x\nASK: Nadia — deploy?' }); await idle(H);
  const n = runner.turns().filter(c => c.seat === 'nadia').map(c => c.model.provider);
  assert.deepStrictEqual(n, ['claude-cli', 'deepseek']);
  assert.ok(LOG(H).some(e => e.kind === 'say' && e.who === 'nadia' && /DeepSeek/.test(e.text)));
});

test('the dispatcher\'s view: a round in progress holds the host and guests; an idle chat holds no one; a 1:1 run holds the host', async () => {
  const { H, runner } = fresh();
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ nadia: { text: 'Green.', hold } });
  await H.pullFrom('dave', { text: 'x\nASK: Nadia — deploy?' });
  for (let i = 0; i < 100 && !runner.turns().length; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(MT().busy('dave') && MT().busy('dave').kind === 'huddle' && MT().busy('nadia'), 'both held while the round runs');
  assert.strictEqual(MT().busy('sharon'), null);
  assert.ok(MT().liveWork().some(x => x.kind === 'huddle' && x.host === 'Dave'));
  release(); await idle(H);
  assert.strictEqual(MT().busy('nadia'), null, 'idle: nobody held');
  // a plain 1:1 run in flight (live.json, checked against chat-runs.json)
  W('company/state/huddles/sharon/live.json', { seat: 'sharon', runId: 'run-x', at: new Date().toISOString() });
  W('company/state/chat-runs.json', { runs: { 'run-x': { status: 'running', seat: 'sharon' } } });
  assert.ok(MT().busy('sharon') && MT().busy('sharon').kind === 'chat');
  W('company/state/chat-runs.json', { runs: { 'run-x': { status: 'done', seat: 'sharon' } } });
  assert.strictEqual(MT().busy('sharon'), null, 'a finished run holds no one, even with a stale live.json');
});

test('a hard halt refuses; an idle chat closes after 2 hours', async () => {
  const { H, runner } = fresh({ idleMs: 50 });
  runner.script({ nadia: 'Green.' });
  await H.pullFrom('dave', { text: 'x\nASK: Nadia — deploy?' }); await idle(H);
  W('company/state/halt.json', { mode: 'hard', by: 'Caullen' });
  await assert.rejects(() => H.say('dave', { text: 'hello?' }), /hard halt/);
  await assert.rejects(() => H.pullFrom('dave', { text: 'ASK: Sharon — b?' }), /hard halt|round/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  await new Promise(r => setTimeout(r, 80));
  await H.sweep();
  assert.ok(!H.isOpen('dave') && LOG(H).some(e => e.kind === 'close' && /nobody wrote for/.test(e.why || '')), 'closed when idle');
});

test('a pull-in refused (a halt) leaves no empty chat behind: nothing opened, no minutes; the next one opens cleanly', async () => {
  const { H, runner } = fresh();
  const mins = path.join(T, 'company/work/meetings/chat-dave-' + co.localParts(new Date()).date + '.md');
  fs.rmSync(mins, { force: true });
  W('company/state/halt.json', { mode: 'soft', by: 'Caullen' });
  await assert.rejects(() => H.pullFrom('dave', { text: CHAT_TURNS[1].content, runId: 'run-1' }), /soft halt/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  const st = H.engine('dave')._state();
  assert.ok(!st.M.opened && !st.LOG.length && !H.isOpen('dave'), 'no room was opened');
  assert.ok(!fs.existsSync(mins), 'no minutes holding only the chat so far');
  assert.ok(!runner.turns().length);
  runner.script({ nadia: 'The deploy is green.', dave: 'Green, Caullen.' });
  await H.pullFrom('dave', { text: CHAT_TURNS[1].content, runId: 'run-1' }); await idle(H);
  const text = fs.readFileSync(mins, 'utf8');
  assert.strictEqual((text.match(/the meeting opens/g) || []).length, 1, 'one chat in the minutes');
  assert.ok(!/closes|closed/.test(text), 'no empty chat closed before it');
  const said = LOG(H).filter(e => e.kind === 'say' && e.src === 'chat');
  assert.deepStrictEqual(said.map(e => e.who), ['owner', 'dave'], 'the chat so far once, the host\'s ask once');
  assert.ok(said[1].text === 'Let me check with Nadia.');
});
