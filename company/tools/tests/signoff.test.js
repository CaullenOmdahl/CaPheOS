#!/usr/bin/env node
/* signoff.test.js — lib/signoff.js on its own (docs/PROFILES.md "Sign-off"): which blocks are held (an explicit
 * **Needs sign-off:** line, or a kind the profile lists read from unmistakable words), refs (a PR URL and pr:<repo>#<n> are
 * one ref), the records (ask dedupe, answer only by the counterpart and never the asker, a no needs reasons, the CEO's
 * override), and scanTick's late notice to the counterpart's manager after holdMaxHours (once; the block stays held).
 * The dispatcher's side is signoff-dispatch.test.js.
 *   node --test company/tools/tests/signoff.test.js
 */
'use strict';
const __LIFE = require('../lib/temp-life');   // temp dirs and helpers end with the process (check-temp-hygiene)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const SO = require(path.join(TOOLS, 'lib', 'signoff.js'));
const P = require(path.join(TOOLS, 'lib', 'profile.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

const prof = (kinds) => { const p = P.blank('ben', { name: 'Benny' }); p.counterpart = { seat: 'ro', signOff: kinds, why: '' }; return p; };

test('holdFor: an explicit line, or a cue for a kind the profile lists; nothing for other kinds or without a counterpart; a yes clears it', () => {
  const block = '## x from Benny — build it\n**Needs sign-off:** promote\n**Status:** OPEN\n';
  assert.deepEqual(SO.holdFor(block, 'ben', { profile: prof(['promote']) }), { hold: true, kind: 'promote', counterpart: 'ro', id: null, status: 'none' });
  assert.equal(SO.holdFor(block, 'ben', { profile: prof(['merge']) }).hold, false, 'a kind the profile does not list');
  assert.equal(SO.holdFor(block, 'ben', { profile: P.blank('ben') }).hold, false, 'no counterpart');
  assert.equal(SO.holdFor('## x\nPlease move this idea to a test this week.\n', 'ben', { profile: prof(['promote']) }).kind, 'promote', 'the cue');
  // held by default: a handoff from an eager seat to anyone but its counterpart, whatever its words
  assert.equal(SO.holdFor('## x\nPlease look at this idea.\n', 'ben', { profile: prof(['promote']) }).hold, true, 'no wording is needed to be held');
  assert.equal(SO.holdFor('## x\n**Needs sign-off:** plan\nmove this idea to a test\n', 'ben', { profile: prof(['promote']) }).hold, false, 'an explicit line of another kind wins over a cue');
  const recs = SO.records({ rows: [{ op: 'ask', id: 'so-1', ref: 'to-dave.md#d1', kind: 'promote', at: '2026-11-20T00:00:00Z' }, { op: 'answer', id: 'so-1', by: 'ro', verdict: 'yes', at: '2026-11-20T01:00:00Z' }] });
  assert.equal(SO.holdFor(block, 'ben', { profile: prof(['promote']), records: recs, ref: 'to-dave.md#d1' }).hold, false);
  const no = SO.records({ rows: [{ op: 'ask', id: 'so-2', ref: 'to-dave.md#d1', kind: 'promote', at: '2026-11-20T00:00:00Z' }, { op: 'answer', id: 'so-2', by: 'ro', verdict: 'no', at: '2026-11-20T01:00:00Z' }] });
  assert.equal(SO.holdFor(block, 'ben', { profile: prof(['promote']), records: no, ref: 'to-dave.md#d1' }).status, 'no');
});

test('refs: a PR URL and pr:<owner>/<repo>#<n> are one ref; other refs are kept as written', () => {
  assert.equal(SO.normRef('https://github.com/Acme/Shop/pull/12'), 'pr:acme/shop#12');
  assert.equal(SO.normRef('pr:acme/shop#12'), 'pr:acme/shop#12');
  assert.equal(SO.normRef(' to-dave.md#d1 '), 'to-dave.md#d1');
  assert.equal(SO.writerOf('2026-11-20 from Benny — x', { ben: { name: 'Benny Tran' } }), 'ben');
  assert.equal(SO.writerOf('2026-11-20 from Dispatcher — x', { ben: { name: 'Benny Tran' } }), null);
});

function fixture() {
  const T = __LIFE.tmpDir('signoff-lib-'); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'F', owner: { name: 'Olive' }, timezone: 'UTC' });
  w('company/tools/loops.json', { agents: { boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, ben: { name: 'Benny', manager: 'boss', inbox: 'to-benny.md' }, ro: { name: 'Rohan', manager: 'boss', inbox: 'to-rohan.md' }, dave: { name: 'Dave', manager: 'boss', inbox: 'to-dave.md' } } });
  w('company/defaults/people/profile-policy.json', fs.readFileSync(path.join(REPO, 'company/defaults/people/profile-policy.json'), 'utf8'));
  w('company/people/profile-policy.json', { signoff: { mode: 'live', holdMaxHours: 2 } });
  w('company/people/profiles/ben.json', prof(['promote']));
  w('company/people/profiles/boss.json', Object.assign(P.blank('boss', { name: 'Alex' }), { counterpart: { seat: 'ro', signOff: ['promote'], why: '' } }));
  for (const n of ['alex', 'benny', 'rohan']) w('company/work/handoffs/to-' + n + '.md', '# Handoffs\n');
  w('company/work/handoffs/to-dave.md', '# Handoffs\n\n## 2026-11-20 from Benny — build it\n**Id:** d1\n**Needs sign-off:** promote\n**Status:** OPEN\n');
  return { T, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
}
// a script file, not node -e: lib/signoff.js reads only rows recorded by an untainted program (lib/recorded.js)
const w2 = (T, rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
const inRoot = (T, js) => { const sf = path.join(T, '.t-run.js'); fs.writeFileSync(sf, 'const SO = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'signoff.js')) + '); const out = (() => { try { return ' + js + '; } catch (e) { return { threw: e.message }; } })(); process.stdout.write(JSON.stringify(out === undefined ? null : out));'); const p = spawnSync(process.execPath, [sf], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }) }); if (p.status) throw new Error(p.stderr); return JSON.parse(p.stdout); };

test('records: ask dedupes; only the counterpart answers, never the asker; a no needs reasons; only the CEO overrides, with a reason', () => {
  const c = fixture();
  const a = inRoot(c.T, 'SO.ask({ from: "ben", kind: "promote", ref: "to-dave.md#d1" })');
  assert.ok(/^so-[0-9a-f]{8}$/.test(a.id)); assert.equal(a.counterpart, 'ro');
  assert.equal(inRoot(c.T, 'SO.ask({ from: "ben", kind: "promote", ref: "to-dave.md#d1" })').duplicate, true);
  assert.match(inRoot(c.T, 'SO.ask({ from: "ben", kind: "trade", ref: "x" })').threw, /names no counterpart/);
  assert.match(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "ben", verdict: "yes", check: "x" })').threw, /cannot sign off its own/);
  assert.match(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "dave", verdict: "yes", check: "x" })').threw, /only Rohan/);
  assert.match(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "ro", verdict: "no", check: "x" })').threw, /needs --reasons/);
  assert.match(inRoot(c.T, 'SO.override({ id: "' + a.id + '", by: "ro", why: "because I say so" })').threw, /only the CEO/);
  const own = inRoot(c.T, 'SO.ask({ from: "boss", kind: "promote", ref: "to-dave.md#d9" })');
  assert.ok(own.id, JSON.stringify(own)); assert.match(inRoot(c.T, 'SO.override({ id: "' + own.id + '", by: "boss", why: "I want it now" })').threw, /cannot override it/, 'the CEO never overrides its own sign-off');
  assert.equal(inRoot(c.T, 'SO.override({ id: "' + a.id + '", by: "boss", why: "the owner asked for it" })').overridden, true);
  assert.equal(inRoot(c.T, 'SO.cleared("to-dave.md#d1")'), true);
  const lines = c.r('company/state/signoffs.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(lines.filter(l => l.ref !== 'to-dave.md#d9').map(l => l.op), ['ask', 'override'], 'refused answers write nothing');
  assert.ok(!lines.some(l => l.op === 'override' && l.by === 'boss' && lines.find(x => x.op === 'ask' && x.id === l.id && x.from === 'boss')));
});

test('hold by default: any handoff to someone other than the counterpart, unless marked as information only; an idea card is promote', () => {
  const p = prof(['promote', 'commit']);
  const b = SO.holdFor('## 2026-11-20 from Benny — build a scanner\nKwame, please build a scanner for the weather signal.\n**Status:** OPEN\n', 'ben', { profile: p, receiver: 'kw' });
  assert.deepEqual([b.hold, b.kind], [true, 'commit'], 'asking another seat to build something commits their time');
  assert.equal(SO.holdFor('## x\nBuild a scanner from card W-12.\n', 'ben', { profile: p, receiver: 'kw' }).kind, 'promote', 'a handoff that names an idea card is promote');
  assert.equal(SO.holdFor('## x\nBuild it.\n', 'ben', { profile: p, receiver: 'ro' }).hold, false, 'a handoff to the counterpart itself is never held');
  assert.equal(SO.holdFor('## x\n**FYI:** the venue changed its fees.\n', 'ben', { profile: p, receiver: 'kw' }).hold, false, 'marked as information only');
  assert.equal(SO.holdFor('## x\n**Needs sign-off:** none\nA note.\n', 'ben', { profile: p, receiver: 'kw' }).hold, false);
  assert.equal(SO.holdFor('## y\nthe fee table.\n', 'ben', { profile: p, receiver: 'kw', heading: '2026-11-20 from Benny — FYI the fee table' }).hold, false, 'an FYI heading');
});

test('the writer is the seat whose run wrote the block (a heading naming someone else does not dodge the hold)', () => {
  const crew = { ben: { name: 'Benny Tran' }, ro: { name: 'Rohan Iyer' }, dave: { name: 'Dave' } };
  const heading = '2026-11-20 from Dave — build the weather scanner now';
  const calls = [{ agentId: 'ben', raw: JSON.stringify({ path: 'company/work/handoffs/to-kwame.md', content: '## ' + heading + '\nDo it.' }) }];
  assert.equal(SO.writerFor(heading, crew, calls), 'ben', 'the transcript shows Benny wrote it');
  assert.equal(SO.writerFor(heading, crew, []), 'dave', 'no transcript: the heading');
  assert.equal(SO.writerFor('2026-11-20 — build the weather scanner now', crew, calls.map(c => Object.assign({}, c, { raw: c.raw.replace('from Dave ', '') }))), 'ben', 'no "from" in the heading at all: still Benny');
});

test('scanTick: past holdMaxHours with no answer the counterpart\'s manager hears once; the block stays held', () => {
  const c = fixture();
  const t0 = Date.parse('2026-11-20T10:00:00Z');
  const h1 = inRoot(c.T, '(() => { const f = SO.scanTick({ now: ' + t0 + ' }); return f("to-dave.md", { heading: "2026-11-20 from Benny — build it", id: "d1" }); })()');
  assert.equal(h1.kind, 'promote'); assert.equal(h1.who, 'Rohan');
  assert.equal((c.r('company/work/handoffs/to-rohan.md').match(/Sign-off: build it/g) || []).length, 1);
  inRoot(c.T, 'SO.scanTick({ now: ' + (t0 + 3600e3) + ' }) && null');
  assert.ok(!/sign-off waiting on/.test(c.r('company/work/handoffs/to-alex.md')), 'not before holdMaxHours');
  const h3 = inRoot(c.T, '(() => { const f = SO.scanTick({ now: ' + (t0 + 3 * 3600e3) + ' }); return f("to-dave.md", { heading: "2026-11-20 from Benny — build it", id: "d1" }); })()');
  assert.ok(h3, 'still held');
  inRoot(c.T, 'SO.scanTick({ now: ' + (t0 + 5 * 3600e3) + ' }) && null');
  assert.equal((c.r('company/work/handoffs/to-alex.md').match(/sign-off waiting on Rohan/g) || []).length, 1, 'the manager hears once');
  // off: nothing at all
  fs.writeFileSync(path.join(c.T, 'company/people/profile-policy.json'), JSON.stringify({ signoff: { mode: 'off' } }));
  assert.equal(inRoot(c.T, 'SO.scanTick({})("to-dave.md", { heading: "2026-11-20 from Benny — build it", id: "d1" })'), null);
});

test('a row appended by hand never counts, even before locked-watch strips it; the first answer decides and is never changed', () => {
  const c = fixture();
  const log = path.join(c.T, 'company/state/signoffs.jsonl');
  w2(c.T, 'company/people/profiles/ben.json', prof(['external']));
  // the reproduction from the review: an ask and a yes for ext:wire-money appended by hand
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, JSON.stringify({ at: '2026-11-20T00:00:00Z', op: 'ask', id: 'so-forged01', from: 'ben', counterpart: 'ro', kind: 'external', ref: 'ext:wire-money' }) + '\n');
  fs.appendFileSync(log, JSON.stringify({ at: '2026-11-20T00:01:00Z', op: 'answer', id: 'so-forged01', by: 'ro', verdict: 'yes', check: 'x' }) + '\n');
  const g = inRoot(c.T, 'SO.gate({ seat: "ben", kind: "external", refs: ["ext:wire-money"] })');
  assert.equal(g.cleared, false, JSON.stringify(g)); assert.ok(g.refuse, 'live: refused');
  assert.equal(inRoot(c.T, 'SO.gate({ seat: "ben", kind: "external", refs: ["ext:wire-money"], signoffId: "so-forged01" })').cleared, false, 'not by its id either');
  // a real ask answered no; a hand-appended yes after it, and a second answer through the tool, change nothing
  const a = inRoot(c.T, 'SO.ask({ from: "ben", kind: "external", ref: "ext:wire-money" })');
  assert.ok(a.id && !a.duplicate, JSON.stringify(a));
  assert.equal(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "ro", verdict: "no", check: "the amount", reasons: "no invoice" })').verdict, 'no');
  fs.appendFileSync(log, JSON.stringify({ at: '2026-11-20T00:05:00Z', op: 'answer', id: a.id, by: 'ro', verdict: 'yes', check: 'x' }) + '\n');
  assert.equal(inRoot(c.T, 'SO.gate({ seat: "ben", kind: "external", refs: ["ext:wire-money"] })').cleared, false, 'a forged later yes');
  assert.match(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "ro", verdict: "yes", check: "again" })').threw, /already answered/);
  // pure: of two recorded answers the first one stands
  const recs = SO.records({ rows: [{ op: 'ask', id: 'so-1', ref: 'r', kind: 'external', at: 't0' }, { op: 'answer', id: 'so-1', by: 'ro', verdict: 'no', at: 't1' }, { op: 'answer', id: 'so-1', by: 'ro', verdict: 'yes', at: 't2' }] });
  assert.equal(recs.get('so-1').status, 'no');
});

test('a yes for an earlier commit of a pull request: asking again with the new commit opens a new sign-off', () => {
  const c = fixture();
  w2(c.T, 'company/people/profiles/ben.json', prof(['merge']));
  const a = inRoot(c.T, 'SO.ask({ from: "ben", kind: "merge", ref: "pr:acme/shop#7", sha: "aaaaaaa1" })');
  assert.equal(inRoot(c.T, 'SO.answer({ id: "' + a.id + '", by: "ro", verdict: "yes", check: "tests", sha: "aaaaaaa1" })').verdict, 'yes');
  const g = inRoot(c.T, 'SO.gate({ seat: "ben", kind: "merge", refs: ["pr:acme/shop#7"], sha: "bbbbbbb2" })');
  assert.equal(g.cleared, false); assert.match(g.refuse, /--sha bbbbbbb2/);
  assert.equal(inRoot(c.T, 'SO.ask({ from: "ben", kind: "merge", ref: "pr:acme/shop#7", sha: "aaaaaaa1" })').duplicate, true, 'the same commit: the same sign-off');
  const b = inRoot(c.T, 'SO.ask({ from: "ben", kind: "merge", ref: "pr:acme/shop#7", sha: "bbbbbbb2" })');
  assert.ok(b.id && b.id !== a.id && !b.duplicate, JSON.stringify(b));
  inRoot(c.T, 'SO.answer({ id: "' + b.id + '", by: "ro", verdict: "yes", check: "tests", sha: "bbbbbbb2" })');
  assert.equal(inRoot(c.T, 'SO.gate({ seat: "ben", kind: "merge", refs: ["pr:acme/shop#7"], sha: "bbbbbbb2" })').cleared, true);
});
