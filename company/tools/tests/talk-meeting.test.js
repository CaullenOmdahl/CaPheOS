'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
// talk-meeting.test.js — how the owner wants to hear from the crew, in the owner's meeting (console/meeting.js with
// console/talk.js meetingHooks; docs/TALK.md "In meetings and huddles"), with a scripted runner in place of the station:
//   - the rules carry the owner's level once they picked one, and nothing before
//   - a turn more technical than that is never re-run: one check row, a note on the seat's NEXT turn
//   - a Plain owner's page shows paths and commands masked; the stored log and the minutes keep every word
//   node --test company/tools/tests/talk-meeting.test.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const test = require('node:test'); const assert = require('assert');

const T = __LIFE.tmpDir('talk-meeting-selftest-');
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
W('company/company.json', { name: 'Talk Test', owner: { name: 'Avery' }, timezone: 'UTC', station: { port: 1 } });
W('company/tools/loops.json', { agents: { dana: { name: 'Dana', title: 'CEO', functions: ['ceo'], manager: null }, kim: { name: 'Kim', title: 'Builder', manager: 'dana' } } });
W('company/work/decisions.md', '# Decisions\n\n');
process.env.CAPHEOS_ROOT = T; process.env.STARNET_URL = 'http://127.0.0.1:1';
const REPO = path.join(__dirname, '..', '..', '..');
const co = require(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
const meetingLib = require(path.join(REPO, 'console', 'meeting.js'));
const hooks = require(path.join(REPO, 'console', 'talk.js')).meetingHooks(co);
test.after(() => fs.rmSync(T, { recursive: true, force: true }));
const setTalk = o => { const f = path.join(T, 'company/owner/talk.json'); if (!o) fs.rmSync(f, { force: true }); else W('company/owner/talk.json', Object.assign({ v: 1, level: 'plain', length: 'short', often: 'daily', check: 'live', setBy: 'owner' }, o)); };

function makeRunner() {
  const r = { queues: {}, calls: [], seq: 0, pending: new Map() };
  r.script = o => { for (const [k, v] of Object.entries(o)) (r.queues[k] = r.queues[k] || []).push(...[].concat(v)); };
  r.start = async o => {
    const kind = o.purpose === 'turn' ? '' : ':' + o.purpose; const q = r.queues[o.seat + kind] = r.queues[o.seat + kind] || [];
    const e = q.length ? q.shift() : (o.purpose === 'turn' ? 'PASS' : o.purpose === 'hand' ? 'NO' : 'OK');
    const runId = 'r' + (++r.seq);
    r.calls.push(Object.assign({ runId, last: o.messages[o.messages.length - 1].content, all: o.messages.map(m => m.content).join('\n') }, o));
    r.pending.set(runId, e); return { runId };
  };
  r.wait = async runId => { await new Promise(res => setTimeout(res, 3)); return { text: r.pending.get(runId), usd: 0.001, refused: false, complete: true, error: null }; };
  r.cancel = () => {};
  r.turns = seat => r.calls.filter(c => c.purpose === 'turn' && (!seat || c.seat === seat));
  return r;
}
function fresh() {
  fs.rmSync(path.join(T, 'company/state/meetings'), { recursive: true, force: true });
  const runner = makeRunner();
  const M = meetingLib(Object.assign({ co, owner: () => 'Avery', runner, run: async () => ({ code: 0, data: {} }), speedMs: { fast: 1, normal: 1, slow: 1 }, seatBusy: async () => false,
    modelFor: async () => ({ provider: 'claude-cli', model: 'claude-sonnet-5-5' }), profileOf: () => null, pov: false }, hooks));
  M.seatsChange({ add: ['dana', 'kim'] }); M.setLeader({ seat: 'dana' });
  return { M, runner };
}
async function idle(M) { for (let i = 0; i < 400; i++) { if (M.idle()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('the meeting did not settle'); }
const checkRows = () => R('company/state/talk-checks.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('no choice yet: the rules are today\'s, nothing is noted or masked', async () => {
  setTalk(null);
  const { M, runner } = fresh();
  runner.script({ kim: 'I fixed company/state/x.json and the cron.' });
  await M.say({ text: 'How is the shop page?' }); await idle(M);
  assert.ok(!/wants to hear from you/.test(runner.turns('dana')[0].all));
  const said = M._state().LOG.find(e => e.kind === 'say' && e.who === 'kim');
  assert.ok(said && !said.lint, 'no note');
  assert.ok(M.entries(new URLSearchParams()).entries.find(e => e.who === 'kim').text.includes('company/state/x.json'));
});

test('Plain, check on: the rules carry it, a technical turn is noted on the next turn (never re-run) and masked on the page', async () => {
  setTalk({});
  const { M, runner } = fresh();
  runner.script({ kim: ['I fixed company/state/x.json and the cron; `node company/tools/x.js` shows it.', 'The shop page is fixed. Nothing for you to do.'] });
  await M.say({ text: 'How is the shop page?' }); await idle(M);
  assert.ok(/- \[How Avery wants to hear from you\] Avery chose plain words/.test(runner.turns('kim')[0].all), 'the rules carry the owner\'s level');
  assert.strictEqual(runner.turns('kim').length, 1, 'nothing is re-run');
  const said = M._state().LOG.find(e => e.kind === 'say' && e.who === 'kim');
  assert.strictEqual(said.lint.kind, 'talk');
  assert.ok(said.text.includes('company/state/x.json'), 'the stored log keeps every word');
  assert.ok(R('company/work/meetings/meeting-' + new Date().toISOString().slice(0, 10) + '.md').includes('company/state/x.json'), 'so do the minutes');
  const row = checkRows().slice(-1)[0];
  assert.deepStrictEqual([row.where, row.seat, row.action], ['meeting', 'kim', 'shadow']);
  const shown = M.entries(new URLSearchParams()).entries.find(e => e.who === 'kim');
  assert.ok(shown.talkMasked && !/company\/|node /.test(shown.text) && shown.technical.includes('company/state/x.json'), JSON.stringify(shown));
  await M.say({ text: 'And the prices?' }); await idle(M);
  const next = runner.turns('kim')[1];
  assert.ok(/\[Console note on your last reply: it was more technical than Avery asked for \(/.test(next.last) && /Avery chose plain words: say what it means for them/.test(next.last), next.last);
  const plainSay = M._state().LOG.filter(e => e.kind === 'say' && e.who === 'kim')[1];
  assert.ok(plainSay && !plainSay.lint, 'a plain reply is not noted');
});
