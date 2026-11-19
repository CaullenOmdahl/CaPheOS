#!/usr/bin/env node
/* talk.test.js — how the crew talks to the owner (company/tools/lib/talk.js, lib/owner-notice.js; docs/TALK.md):
 *   - the check: at plain a command, a path, a backticked tool name, a model id and "the cron's idempotency key" each give
 *     a problem of the right kind, "the price checker is back" passes; at some a word explained in the same sentence
 *     passes and a path does not; at technical only a command handed over is flagged; length is the owner's word cap
 *   - mask removes every flagged span, and what is left passes the check at plain
 *   - the block: nothing until the owner picks; the owner's words and the seat's voice after
 *   - injection: the block is in the chat's context note and the meeting's rules, never in routine prompts or the
 *     lead's advise template
 *   - how often: needed folds the notes into one weekly summary and no daily message; asItHappens sends each note at
 *     once; urgent is always immediate; plain masks a notice's technical leftovers
 *   node --test company/tools/tests/talk.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');

const REPO = path.resolve(__dirname, '..', '..', '..');
const T = __LIFE.tmpDir('talk-test-');
const W = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const rows = rel => R(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
W('company/company.json', { name: 'Test Co', slug: 'testco', timezone: 'UTC', owner: { name: 'Olive' } });
W('company/tools/loops.json', { agents: { 'a-ceo': { name: 'Alex', manager: null, functions: ['ceo'] }, 'a-two': { name: 'Kim', manager: 'a-ceo', functions: [] } } });
for (const f of ['company/defaults/work/ops/owner-notices.json', 'company/defaults/owner/talk.json', 'company/defaults/owner/talk-examples.json']) W(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
fs.mkdirSync(path.join(T, 'secrets'), { recursive: true });
process.env.CAPHEOS_ROOT = T; process.env.CAPHEOS_TZ = 'UTC'; delete process.env.OWNER_DIR;
const TK = require(path.join(REPO, 'company', 'tools', 'lib', 'talk.js'));
const N = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-notice.js'));
const setTalk = o => { if (o === null) fs.rmSync(path.join(T, 'company/owner/talk.json'), { force: true }); else W('company/owner/talk.json', Object.assign({ v: 1, level: 'plain', length: 'short', often: 'daily', check: 'live', setBy: 'owner' }, o)); };
const kinds = c => c.problems.map(p => p.kind);
const reset = () => { for (const f of ['company/owner/outbound.jsonl', 'company/owner/digest.jsonl', 'company/state/owner-digest.json']) fs.rmSync(path.join(T, f), { force: true }); };
const at = iso => Date.parse(iso);

test('the check at plain: each technical thing is a problem of its kind; plain words pass', () => {
  const cases = [['Restart it with systemctl restart x when you can.', 'command'], ['I wrote it to company/state/foo.json.', 'path'], ['The `dispatch.js` tool did it.', 'tool'],
    ['It now runs on claude-sonnet-5-5.', 'model'], ['That was the cron\'s idempotency key.', 'jargon']];
  for (const [t, k] of cases) { const c = TK.check(t, 'plain', 'full'); assert.ok(!c.ok && kinds(c).includes(k), t + ' -> ' + JSON.stringify(c.problems)); }
  assert.ok(TK.check('The cron\'s idempotency key.', 'plain', 'full').problems.find(p => p.kind === 'jargon').words.join() === 'cron,idempotency');
  const ok = TK.check('The price checker is back and has caught up on the morning\'s prices. Nothing for you to do.', 'plain', 'short');
  assert.deepEqual(ok, { ok: true, problems: [] });
  // a console link is a button, and a ```actions block the console's own controls: neither is words the owner reads
  assert.ok(TK.check('Pick one: [Open Settings](console:#/settings/talk).\n```actions\n{"id":"x","items":[]}\n```', 'plain', 'short').ok);
});

test('the check at some and technical; length is the owner\'s word cap', () => {
  assert.ok(TK.check('The price checker runs on a cron (a timer that runs a job) and is back.', 'some', 'short').ok);
  assert.ok(kinds(TK.check('I wrote it to company/state/foo.json (the notes file).', 'some', 'short')).includes('path'));
  assert.ok(kinds(TK.check('The cron is back.', 'some', 'short')).includes('jargon'), 'an unexplained word is still a problem at some');
  const tech = TK.check('I wrote company/state/foo.json and the cron on claude-sonnet-5-5 is back.', 'technical', 'short');
  assert.ok(tech.ok, 'technical: paths, jargon and models are fine');
  assert.deepEqual(kinds(TK.check('Please run `sudo apt install jq` in your terminal.', 'technical', 'short')), ['command'], 'technical: only a command handed over');
  const long = Array(110).fill('word').join(' ') + '.';
  assert.ok(kinds(TK.check(long, 'plain', 'short')).includes('length'), 'over about 80 words at short');
  assert.ok(TK.check(long, 'plain', 'medium').ok && TK.check(long, 'plain', 'full').ok);
});

test('mask removes every flagged part, and what is left passes the check at plain', () => {
  const texts = ['Please run `sudo apt install jq` in your terminal and tell me when it is done.', 'I saved it in company/state/foo.json and ran node company/tools/talk.js show.',
    'It runs on claude-sonnet-5-5 and the cron\'s idempotency key is q-123456.', 'Done.\n\n```\nsystemctl --user restart capheos-station.service\n```\nAll good now.',
    'The `routine-rules.js` check uses dispatchTick=5 and deadbeef1234 now.'];
  for (const t of texts) {
    const m = TK.mask(t);
    assert.ok(TK.check(m.text, 'plain', 'full').ok, t + ' -> ' + m.text + ' ' + JSON.stringify(TK.check(m.text, 'plain', 'full').problems));
    assert.ok(m.technical.length > 0 && m.text.includes(TK.PLACEHOLDER));
    assert.ok(!/company\/|systemctl|sudo|\.js\b|sonnet/.test(m.text), m.text);
  }
  const keep = TK.mask('All set. [Open Today](console:#/today) when you have a minute.');
  assert.equal(keep.text, 'All set. [Open Today](console:#/today) when you have a minute.', 'a plain reply with a console link is left as it is');
});

test('the block: nothing until the owner picks; then the level, the cap and the seat\'s own way with the owner', () => {
  setTalk(null);
  const p0 = TK.prefs();
  assert.equal(p0.level, 'technical'); assert.equal(p0.check, 'shadow'); assert.equal(p0.source, 'default');
  assert.equal(TK.block(p0, 'warm'), '');
  setTalk({});
  const b = TK.block(TK.prefs(), 'warm and brief');
  assert.match(b, /^\[How Olive wants to hear from you\] Olive chose plain words: no technical terms, no commands, file names or tool names, no model names\. Say what it means for them\. Keep it under about 80 words\. If they need to act, link the console button\. Your own way with them: warm and brief$/);
  setTalk({ level: 'some', length: 'full' });
  assert.match(TK.block(TK.prefs()), /some detail/); assert.doesNotMatch(TK.block(TK.prefs()), /about \d+ words/);
  setTalk({ level: 'technical' });
  assert.match(TK.block(TK.prefs()), /colleague on the crew, but never ask them to run a command/);
  const n = TK.recheckNote([{ kind: 'path', words: ['company/x.json'] }, { kind: 'length', words: ['120 words'] }], 'plain', { length: 'short' });
  assert.ok(n.startsWith('[Console check, not from the owner:') && /file path \(company\/x\.json\)/.test(n) && /120 words/.test(n) && /about 80/.test(n), n);
  const both = TK.recheckNote([{ kind: 'jargon', words: ['cron'] }], 'plain', { command: { command: 'sudo apt install jq', action: null } });
  assert.ok(/asked them to run a command \(sudo apt install jq\)/.test(both) && /also not shown because it was more technical/.test(both) && (both.match(/\[Console check/g) || []).length === 1, both);
});

test('injection: the chat context note and the meeting rules carry the block; routine prompts and the advise template never do', () => {
  setTalk({});
  const chat = require(path.join(REPO, 'console', 'chat.js'));
  const co = { ROOT: T, p: (...a) => path.join(T, ...a) };
  const note = chat.contextNote('a-two', { name: 'Kim', inbox: 'to-kim.md' }, co, 'hello', '');
  assert.match(note, /\[How Olive wants to hear from you\] Olive chose plain words/);
  setTalk(null);
  assert.doesNotMatch(chat.contextNote('a-two', { name: 'Kim', inbox: 'to-kim.md' }, co, 'hello', ''), /wants to hear from you/, 'no choice yet: the note is today\'s');
  setTalk({});
  const hooks = require(path.join(REPO, 'console', 'talk.js')).meetingHooks({ ROOT: T, config: { owner: { name: 'Olive' } } });
  assert.match(hooks.ownerTalk(), /^- \[How Olive wants to hear from you\]/);
  const RR = require(path.join(REPO, 'company', 'tools', 'routine-rules.js'));
  const prompt = RR.withRules('Do your loop.', RR.blockFor([], []));
  assert.doesNotMatch(prompt, /wants to hear from you|chose plain words/);
  const advise = fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'departments', 'advise-prompt.md'), 'utf8');
  assert.doesNotMatch(advise, /wants to hear from you|chose plain words/);
  for (const f of ['inbox.js', 'consult.js', 'lib/consult.js', 'routine-rules.js', 'dossier.js']) assert.doesNotMatch(fs.readFileSync(path.join(REPO, 'company', 'tools', f), 'utf8'), /lib\/talk|require\('\.\/talk'\)|talk\.block/, f + ' never injects the owner\'s talk block');
  // a meeting turn more technical than the owner asked for: a note for the next turn, a check row, nothing re-run
  const lint = hooks.ownerTalkLint('I fixed company/state/x.json and the cron.', 'a-two');
  assert.equal(lint.kind, 'talk'); assert.match(lint.fix, /Olive chose plain words/);
  assert.equal(rows('company/state/talk-checks.jsonl').slice(-1)[0].where, 'meeting');
  const shown = hooks.ownerShown('I fixed company/state/x.json.');
  assert.ok(shown.talkMasked && !/company\//.test(shown.text) && shown.technical.includes('company/state/x.json'));
  setTalk({ check: 'shadow' });
  assert.equal(hooks.ownerTalkLint('I fixed company/state/x.json.', 'a-two'), null, 'recording only: no note');
  assert.equal(hooks.ownerShown('I fixed company/state/x.json.'), null);
});

test('how often: needed is one weekly summary and no daily message; urgent is always immediate', () => {
  reset(); setTalk({ often: 'needed' });
  N.send({ kind: 'fyi', from: 'Kim', text: 'Kim finished the shop page.', now: at('2026-11-17T09:00:00Z') });   // a Tuesday
  N.send({ kind: 'fyi', from: 'Alex', text: 'Alex hired a writer for the blog.', now: at('2026-11-18T09:00:00Z') });
  assert.equal(R('company/owner/outbound.jsonl'), '', 'nothing at once');
  const tue = N.digest({ now: at('2026-11-17T19:00:00Z') });
  assert.equal(tue.sent, false); assert.match(tue.why, /only when needed/);
  assert.equal(N.digest({ now: at('2026-11-18T19:00:00Z') }).sent, false, 'no daily message on Wednesday either');
  const fri = N.digest({ now: at('2026-11-20T19:00:00Z') });   // weeklyDay 5: Friday, at the evening hour
  assert.equal(fri.sent, true); assert.equal(fri.folded, 2);
  const out = rows('company/owner/outbound.jsonl');
  assert.equal(out.length, 1); assert.match(out[0].text, /^What the crew did this week:/);
  N.send({ kind: 'fyi', from: 'Kim', text: 'Kim tidied the price list.', now: at('2026-11-21T09:00:00Z') });
  assert.equal(N.digest({ now: at('2026-11-21T19:00:00Z'), force: true }).sent, false, 'one summary a week, even by hand');
  const u = N.send({ kind: 'urgent', from: 'Alex', text: 'The company has stopped working.', now: at('2026-11-21T10:00:00Z') });
  assert.equal(u.sent, 'outbound', 'urgent goes at once whatever the choice');
});

test('how often: as things happen sends each note at once and never folds it again; daily is the day\'s message', () => {
  reset(); setTalk({ often: 'asItHappens' });
  const a = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim finished the shop page.', now: at('2026-11-18T09:00:00Z') });
  const b = N.send({ kind: 'fyi', from: 'Alex', text: 'Alex hired a writer for the blog.', now: at('2026-11-18T10:00:00Z') });
  assert.equal(a.sent, 'outbound'); assert.equal(b.sent, 'outbound');
  const out = rows('company/owner/outbound.jsonl');
  assert.equal(out.length, 2, 'one message each'); assert.ok(out.every(r => r.kind === 'fyi'));
  assert.equal(rows('company/owner/digest.jsonl').filter(r => r.sentNow).length, 2, 'kept for Today, marked sent');
  assert.equal(N.digest({ now: at('2026-11-18T19:00:00Z') }).sent, false, 'nothing left to fold');
  assert.equal(N.send({ kind: 'fyi', from: 'Kim', text: 'Kim finished the shop page.', now: at('2026-11-18T11:00:00Z') }).duplicate, true, 'the same note once a day');
  reset(); setTalk({ often: 'daily' });
  N.send({ kind: 'fyi', from: 'Kim', text: 'Kim finished the shop page.', now: at('2026-11-18T09:00:00Z') });
  assert.equal(R('company/owner/outbound.jsonl'), '');
  assert.equal(N.digest({ now: at('2026-11-18T19:00:00Z') }).sent, true);
});

test('a Plain owner\'s notice: what the plain check let through but the talk check does not is masked, kept under technical', () => {
  reset(); setTalk({});
  const r = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim refactored the backend so the shop page loads faster.', now: at('2026-11-18T09:00:00Z') });
  assert.doesNotMatch(r.row.text, /refactor|backend/); assert.match(r.row.technical, /refactored|backend/);
  reset(); setTalk({ level: 'technical' });
  const t = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim refactored the backend so the shop page loads faster.', now: at('2026-11-18T09:00:00Z') });
  assert.match(t.row.text, /refactored the backend/, 'at technical the notice is as before');
  setTalk(null);
});

test('a Plain owner\'s urgent notice, an ask and a sentence aimed at the owner are never masked whole: only their technical words', () => {
  reset(); setTalk({});
  const u = N.send({ kind: 'urgent', from: 'Kim', text: 'Urgent: someone may have your password; please change it in your terminal now.', now: at('2026-11-18T09:00:00Z') });
  const text = u.row.text;
  assert.match(text, /someone may have your password/, 'the owner still reads what is wrong: ' + text);
  assert.ok(text.replace(TK.PLACEHOLDER, '').trim() !== '' && !/^\(a technical detail the crew handles\)\.?$/.test(text.trim()), text);
  reset();
  const ask = N.send({ kind: 'fyi', asks: true, from: 'Kim', text: 'Can you approve the hosting change before the weekend? The cron job config needs it.', now: at('2026-11-18T09:00:00Z') });
  assert.match(ask.row.text, /Can you approve the hosting change before the weekend\?/, ask.row.text);
  reset();
  const money = N.send({ kind: 'fyi', from: 'Kim', text: 'Please pay the $40 invoice from the hosting vendor by Friday, or the backend goes down.', now: at('2026-11-18T09:00:00Z') });
  assert.match(money.row.text, /pay the \$40 invoice/, 'a sentence about money and a deadline keeps its words: ' + money.row.text);
  assert.doesNotMatch(money.row.text, /backend/, '...its technical word is masked');
  // the chat's masking is unchanged: without ownerAimed a technical sentence still goes whole
  assert.equal(TK.mask('Run it in your terminal with the sidecar flag.').text.includes('your terminal'), TK.mask('Run it in your terminal with the sidecar flag.', { ownerAimed: false }).text.includes('your terminal'));
  setTalk(null);
});

test.after(() => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} });
