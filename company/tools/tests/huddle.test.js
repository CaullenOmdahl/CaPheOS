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

const T = require('../lib/temp-life').tmpDir('huddle-selftest-');
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const CREW = { dana: ['Dana', 'CEO'], zoe: ['Zoe', 'CFO'], paul: ['Paul', 'IT Admin'], nora: ['Nora', 'Engineer'], owen: ['Owen', 'DevOps'] };
const agents = {}; for (const [id, [name, title]] of Object.entries(CREW)) agents[id] = { name, title, manager: id === 'dana' ? null : 'dana', inbox: 'to-' + id + '.md' };
W('company/company.json', { name: 'Huddle Test', owner: { name: 'Avery' }, timezone: 'UTC', station: { port: 1 } });
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
const CHAT_TURNS = [{ role: 'user', content: 'Is the deploy done?' }, { role: 'assistant', content: 'Let me check with Nora.\nASK: Nora — is the deploy done?', runId: 'run-1' }];
function fresh(opts) {
  opts = opts || {};
  fs.rmSync(path.join(T, 'company/state/huddles'), { recursive: true, force: true });
  const runner = makeRunner(); const models = opts.models || {};
  const H = huddleLib({ co, owner: () => 'Avery', runner, run: async () => ({ code: 0 }), emit: () => {}, idleMs: opts.idleMs,
    seatBusy: async id => !!(opts.busy && opts.busy.includes(id)),
    modelFor: async id => { const m = models[id]; if (m instanceof Error) throw m; return m === undefined ? { provider: 'claude-cli', model: 'claude-sonnet-5-5' } : m; },
    chat: { transcript: async () => ({ ok: true, turns: (opts.turns || CHAT_TURNS).slice() }) } });
  return { H, runner };
}
async function idle(H, host) { const E = H.engine(host || 'dana'); for (let i = 0; i < 400; i++) { if (E.idle()) { await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 5)); if (E.idle()) return E; } await new Promise(r => setTimeout(r, 10)); } throw new Error('the chat did not settle'); }
const LOG = H => H.engine('dana')._state().LOG;

test('an ASK in the host\'s reply opens the chat with the colleague: the chat so far goes in, the guest answers first, the host closes the loop', async () => {
  const { H, runner } = fresh();
  runner.script({ nora: 'The deploy is green.', dana: 'Avery, Nora says the deploy is green.' });
  const r = await H.pullFrom('dana', { text: CHAT_TURNS[1].content, runId: 'run-1' });
  assert.ok(r && r.host === 'dana' && /^m-/.test(r.id));
  await idle(H);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['nora', 'dana']);
  const g = runner.turns()[0];
  assert.ok(/Avery \(owner\): Is the deploy done\?/.test(g.all) && /Dana: Let me check with Nora\./.test(g.all), 'the guest sees the chat so far');
  assert.ok(!/ASK: Nora/.test(g.all.split('Dana asked you directly')[0].split('[THE TABLE]').pop().replace(/ASK: <name>/g, '')), 'the host\'s ASK line is the ask, not repeated as text');
  assert.ok(/live chat with Dana/.test(g.all) && /Dana asked you directly: is the deploy done\?/.test(g.last));
  assert.ok(g.streamPrefix === undefined && g.tools === true, 'tools on, as at the table');
  assert.ok(/Close the loop for Avery/.test(runner.turns()[1].last), 'the host\'s closing turn');
  assert.ok(H.isOpen('dana'));
  const v = await H.view('dana');
  assert.ok(v.open && v.seats.map(s => s.id).join() === 'dana,nora' && v.seats[0].leader);
  assert.ok(fs.existsSync(path.join(T, 'company/work/meetings/chat-dana-' + co.localParts(new Date()).date + '.md')), 'its minutes');
  const adm = R('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind === 'meeting-turn');
  assert.ok(adm.length >= 2 && adm.every(x => x.door === 'chat' && x.decision === 'allow' && /^m-/.test(x.meetingId)), 'every guest run is admitted: door chat, kind meeting-turn');
  // lines that name nobody, or the host itself, open nothing
  assert.strictEqual(H.pullLines('dana', 'ASK: Dana — me?\nINVITE: Zed — who').length, 0);
});

test('the host\'s closing turn runs only when something is new; the owner\'s message goes to everyone, the host first', async () => {
  const { H, runner } = fresh();
  runner.script({ nora: 'PASS' });
  await H.pullFrom('dana', { text: 'Hm.\nINVITE: Nora — the deploy' }); await idle(H);
  assert.deepStrictEqual(runner.turns().map(c => c.seat), ['nora'], 'Nora passed: nothing new, so no closing turn');
  runner.script({ dana: 'Here is the plan.', nora: 'I agree, Dana.' });
  await H.say('dana', { text: 'What now?' }); await idle(H);
  assert.deepStrictEqual(runner.turns().slice(1).map(c => c.seat), ['dana', 'nora']);
});

test('DISMISS by an agent, DISMISS: me, the owner\'s ×; the last guest leaving closes it, with a recap for the host\'s next 1:1 message', async () => {
  const { H, runner } = fresh();
  runner.script({ nora: 'Green.', zoe: 'Budget is fine.\nDISMISS: me — done', dana: ['Thanks.\nDISMISS: Nora — answered', 'Done.'] });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?\nINVITE: Zoe — budget' }); await idle(H);
  const leaves = LOG(H).filter(e => e.kind === 'leave');
  assert.ok(leaves.some(e => e.who === 'zoe' && e.by === 'zoe'), 'DISMISS: me');
  assert.ok(leaves.some(e => e.who === 'nora' && e.by === 'dana'), 'DISMISS by the host');
  assert.ok(!H.isOpen('dana'), 'the last guest left: the chat is 1:1 again');
  assert.strictEqual(H.engine('dana').state(), 'closed');
  const recap = H.takeRecap('dana');
  assert.ok(/^\[While Nora and Zoe were in this chat/.test(recap) && /Nora: Green\./.test(recap) && /Zoe: Budget is fine\./.test(recap), recap);
  const s = Object.assign({ id: 'dana' }, co.crew().dana);
  const note = chatLib.contextNote('dana', s, co, 'hello', recap);
  assert.ok(note.includes('Nora: Green.') && /To bring a colleague into this chat now, end your reply with a line of its own: ASK: <name>/.test(note), 'the recap and the pull-in line are in the host\'s next message');
  assert.strictEqual(H.takeRecap('dana'), '', 'the recap is given once');
  // the owner brings someone in (+ Colleague) and sends them back out (×)
  const v = await H.seats('dana', { add: ['paul'] });
  assert.ok(v.open && v.seats.some(x => x.id === 'paul' && x.guest), 'a guest of this chat');
  assert.ok(LOG(H).some(e => e.kind === 'say' && e.src === 'chat' && /Is the deploy done/.test(e.text)), 'a new chat starts from the chat so far');
  assert.ok(LOG(H).some(e => e.kind === 'join' && e.who === 'paul' && e.by === 'owner'));
  await H.seats('dana', { remove: ['paul'] }); await idle(H);
  assert.ok(!H.isOpen('dana') && LOG(H).some(e => e.kind === 'leave' && e.who === 'paul' && e.by === 'owner'), 'the owner\'s ×');
  await assert.rejects(() => H.seats('dana', { remove: ['dana'] }), /nobody else is in this chat|leads this chat/);
});

test('limits: 3 colleagues at once, 2 invites a round, 8 replies per owner message', async () => {
  const { H, runner } = fresh();
  runner.script({ nora: 'N.', zoe: 'S.', dana: ['PASS', 'INVITE: Paul — p\nINVITE: Owen — o\nINVITE: Owen — o2'], paul: 'P.', owen: 'O.' });
  await H.pullFrom('dana', { text: 'x\nINVITE: Nora — a\nINVITE: Zoe — b\nINVITE: Paul — c' }); await idle(H);
  assert.ok(LOG(H).some(e => e.kind === 'note' && /Dana invited Paul: not this round, 2 people were invited already/.test(e.text)), '2 invites a round');
  await H.say('dana', { text: 'more people' }); await idle(H);
  const notes = LOG(H).filter(e => e.kind === 'note').map(e => e.text).join('\n');
  assert.ok(/3 colleagues are here already, the most at once/.test(notes), notes);
  await assert.rejects(() => H.seats('dana', { add: ['owen'] }), /3 colleagues are here already/);
  runner.script({ dana: ['ASK: Nora — 1?', 'ASK: Nora — 3?', 'ASK: Nora — 5?', 'ASK: Nora — 7?'], nora: ['ASK: Dana — 2?', 'ASK: Dana — 4?', 'ASK: Dana — 6?', 'ASK: Dana — 8?'] });
  const n = runner.turns().length;
  await H.say('dana', { text: 'Talk it through.' }); await idle(H);
  assert.strictEqual(runner.turns().length - n, 8);
  assert.ok(LOG(H).some(e => e.kind === 'note' && e.text === 'The chat paused after 8 replies; write to carry on.'));
});

test('a busy colleague answers at once, talk only; a closed chain or a $0-cap hold sits out in one line', async () => {
  const { H, runner } = fresh({ busy: ['nora'], models: { zoe: null, paul: new Error('Paul runs on deepseek, which bills per token, and the daily cap is $0: the budget holds every metered run.') } });
  runner.script({ nora: 'From what I know: green.' });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?\nINVITE: Zoe — b' }); await idle(H);
  runner.script({ dana: 'INVITE: Paul — c' });
  await H.say('dana', { text: 'And Paul?' }); await idle(H);
  const t = runner.turns().find(c => c.seat === 'nora');
  assert.ok(t && t.tools === false && /no tools this turn/.test(t.last), 'talk only, told so');
  const notes = LOG(H).filter(e => e.kind === 'note').map(e => e.text).join('\n');
  assert.ok(/Nora is in the middle of a routine run, so Nora speaks without tools this turn/.test(notes));
  assert.ok(/Zoe sits this one out: Zoe has no AI model to think with/.test(notes), notes);
  assert.ok(/Paul sits this one out: .*daily cap is \$0/.test(notes), notes);
  assert.ok(!runner.turns().some(c => c.seat === 'zoe' || c.seat === 'paul'));
});

test('a refused guest turn is retried once on the next chain entry', async () => {
  W('company/model-policy.json', { allowed: { 'claude-cli': { models: ['claude-sonnet-5-5'] }, deepseek: { models: ['deepseek-flash'] } }, seats: { nora: { chain: [{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }, { provider: 'deepseek', model: 'deepseek-flash' }] } }, candidateDefault: { provider: 'claude-cli', model: 'claude-sonnet-5-5' } });
  const { H, runner } = fresh();
  runner.script({ nora: { text: 'Green, from DeepSeek.', refuse: true } });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?' }); await idle(H);
  const n = runner.turns().filter(c => c.seat === 'nora').map(c => c.model.provider);
  assert.deepStrictEqual(n, ['claude-cli', 'deepseek']);
  assert.ok(LOG(H).some(e => e.kind === 'say' && e.who === 'nora' && /DeepSeek/.test(e.text)));
});

test('the dispatcher\'s view: a round in progress holds the host and guests; an idle chat holds no one; a 1:1 run holds the host', async () => {
  const { H, runner } = fresh();
  let release; const hold = new Promise(r => { release = r; });
  runner.script({ nora: { text: 'Green.', hold } });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?' });
  for (let i = 0; i < 100 && !runner.turns().length; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(MT().busy('dana') && MT().busy('dana').kind === 'huddle' && MT().busy('nora'), 'both held while the round runs');
  assert.strictEqual(MT().busy('zoe'), null);
  assert.ok(MT().liveWork().some(x => x.kind === 'huddle' && x.host === 'Dana'));
  release(); await idle(H);
  assert.strictEqual(MT().busy('nora'), null, 'idle: nobody held');
  // a plain 1:1 run in flight (live.json, checked against chat-runs.json)
  W('company/state/huddles/zoe/live.json', { seat: 'zoe', runId: 'run-x', at: new Date().toISOString() });
  W('company/state/chat-runs.json', { runs: { 'run-x': { status: 'running', seat: 'zoe' } } });
  assert.ok(MT().busy('zoe') && MT().busy('zoe').kind === 'chat');
  W('company/state/chat-runs.json', { runs: { 'run-x': { status: 'done', seat: 'zoe' } } });
  assert.strictEqual(MT().busy('zoe'), null, 'a finished run holds no one, even with a stale live.json');
});

test('a hard halt refuses; an idle chat closes after 2 hours', async () => {
  const { H, runner } = fresh({ idleMs: 50 });
  runner.script({ nora: 'Green.' });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?' }); await idle(H);
  W('company/state/halt.json', { mode: 'hard', by: 'Avery' });
  await assert.rejects(() => H.say('dana', { text: 'hello?' }), /hard halt/);
  await assert.rejects(() => H.pullFrom('dana', { text: 'ASK: Zoe — b?' }), /hard halt|round/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  await new Promise(r => setTimeout(r, 80));
  await H.sweep();
  assert.ok(!H.isOpen('dana') && LOG(H).some(e => e.kind === 'close' && /nobody wrote for/.test(e.why || '')), 'closed when idle');
});

test('a pull-in refused (a halt) leaves no empty chat behind: nothing opened, no minutes; the next one opens cleanly', async () => {
  const { H, runner } = fresh();
  const mins = path.join(T, 'company/work/meetings/chat-dana-' + co.localParts(new Date()).date + '.md');
  fs.rmSync(mins, { force: true });
  W('company/state/halt.json', { mode: 'soft', by: 'Avery' });
  await assert.rejects(() => H.pullFrom('dana', { text: CHAT_TURNS[1].content, runId: 'run-1' }), /soft halt/);
  fs.unlinkSync(path.join(T, 'company/state/halt.json'));
  const st = H.engine('dana')._state();
  assert.ok(!st.M.opened && !st.LOG.length && !H.isOpen('dana'), 'no room was opened');
  assert.ok(!fs.existsSync(mins), 'no minutes holding only the chat so far');
  assert.ok(!runner.turns().length);
  runner.script({ nora: 'The deploy is green.', dana: 'Green, Avery.' });
  await H.pullFrom('dana', { text: CHAT_TURNS[1].content, runId: 'run-1' }); await idle(H);
  const text = fs.readFileSync(mins, 'utf8');
  assert.strictEqual((text.match(/the meeting opens/g) || []).length, 1, 'one chat in the minutes');
  assert.ok(!/closes|closed/.test(text), 'no empty chat closed before it');
  const said = LOG(H).filter(e => e.kind === 'say' && e.src === 'chat');
  assert.deepStrictEqual(said.map(e => e.who), ['owner', 'dana'], 'the chat so far once, the host\'s ask once');
  assert.ok(said[1].text === 'Let me check with Nora.');
});

test('the owner\'s thinking level and model reach a live chat too (POST /api/huddle/<host>/think); Stop and × wait for the turn; a close waits, then the recap', async () => {
  const { H, runner } = fresh();
  const routes = []; H.mount((method, re, fn) => routes.push({ method, re, fn }));
  const call = (method, url, b) => { const r = routes.find(x => x.method === method && x.re.test(url)); return r.fn(url.match(r.re), new URLSearchParams(), b); };
  let rel; const hold = new Promise(r => { rel = r; });
  runner.script({ nora: { text: 'Green, after a long look.', hold }, 'dana': ['Thanks.'] });
  await H.pullFrom('dana', { text: 'x\nASK: Nora — deploy?' });
  for (let i = 0; i < 200 && !runner.turns().some(c => c.seat === 'nora'); i++) await new Promise(r => setTimeout(r, 5));
  const v = await call('POST', '/api/huddle/dana/think', { level: 'light' });
  assert.ok(v.meeting.think.level === 'light' && /Light thinking/.test(v.note), 'set in this chat, by the owner');
  assert.strictEqual(runner.turns().find(c => c.seat === 'nora').model.effort, 'medium', 'the turn already started keeps its level (Normal by default)');
  // the owner's × on the colleague writing: after the turn; Stop: after the turn
  await H.seats('dana', { remove: ['nora'] });
  const sv = await call('POST', '/api/huddle/dana/stop', {});
  assert.match(sv.note, /Stopping after Nora finishes this turn/);
  assert.ok(!runner.pending.get(runner.turns().find(c => c.seat === 'nora').runId).cancelled, 'Nora is not cut off');
  rel(); await idle(H);
  assert.ok(LOG(H).some(e => e.kind === 'say' && e.who === 'nora' && /Green/.test(e.text)), 'her reply is kept');
  assert.ok(!H.isOpen('dana'), 'then she leaves and the chat is 1:1 again');
  assert.match(H.takeRecap('dana'), /Nora: Green, after a long look\./, 'with the recap');
  // a close while a colleague writes: closes once they finish, recap then
  let rel2; const hold2 = new Promise(r => { rel2 = r; });
  runner.script({ owen: { text: 'Owen, slowly.', hold: hold2 } });
  await H.pullFrom('dana', { text: 'y\nASK: Owen — the logs?' });
  for (let i = 0; i < 200 && !runner.turns().some(c => c.seat === 'owen'); i++) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(runner.turns().find(c => c.seat === 'owen').model.effort, 'low', 'the new turn runs at the owner\'s Light');
  const cv = await H.close('dana', 'closed by Avery');
  assert.match(cv.note || '', /closes once Owen finishes this turn/);
  assert.strictEqual(H.takeRecap('dana'), '', 'no recap before it closes');
  rel2(); await idle(H);
  assert.strictEqual(H.engine('dana').state(), 'closed');
  assert.match(H.takeRecap('dana'), /Owen: Owen, slowly\./);
});
