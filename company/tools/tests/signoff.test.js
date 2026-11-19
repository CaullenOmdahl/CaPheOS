#!/usr/bin/env node
/* signoff.test.js — lib/signoff.js on its own (docs/PROFILES.md "Sign-off"): which blocks are held (an explicit
 * **Needs sign-off:** line, or a kind the profile lists read from unmistakable words), refs (a PR URL and pr:<repo>#<n> are
 * one ref), the records (ask dedupe, answer only by the counterpart and never the asker, a no needs reasons, the CEO's
 * override), and scanTick's late notice to the counterpart's manager after holdMaxHours (once; the block stays held).
 * The dispatcher's side is signoff-dispatch.test.js.
 *   node --test company/tools/tests/signoff.test.js
 */
'use strict';
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
  assert.equal(SO.holdFor('## x\nPlease look at this idea.\n', 'ben', { profile: prof(['promote']) }).hold, false);
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
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-lib-')); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'F', owner: { name: 'Olive' }, timezone: 'UTC' });
  w('company/tools/loops.json', { agents: { boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, ben: { name: 'Benny', manager: 'boss', inbox: 'to-benny.md' }, ro: { name: 'Rohan', manager: 'boss', inbox: 'to-rohan.md' }, dave: { name: 'Dave', manager: 'boss', inbox: 'to-dave.md' } } });
  w('company/defaults/people/profile-policy.json', fs.readFileSync(path.join(REPO, 'company/defaults/people/profile-policy.json'), 'utf8'));
  w('company/people/profile-policy.json', { signoff: { mode: 'live', holdMaxHours: 2 } });
  w('company/people/profiles/ben.json', prof(['promote']));
  for (const n of ['alex', 'benny', 'rohan']) w('company/work/handoffs/to-' + n + '.md', '# Handoffs\n');
  w('company/work/handoffs/to-dave.md', '# Handoffs\n\n## 2026-11-20 from Benny — build it\n**Id:** d1\n**Needs sign-off:** promote\n**Status:** OPEN\n');
  return { T, r: rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } } };
}
const inRoot = (T, js) => { const p = spawnSync(process.execPath, ['-e', 'const SO = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'signoff.js')) + '); const out = (() => { try { return ' + js + '; } catch (e) { return { threw: e.message }; } })(); process.stdout.write(JSON.stringify(out === undefined ? null : out));'], { cwd: T, encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }) }); if (p.status) throw new Error(p.stderr); return JSON.parse(p.stdout); };

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
  assert.equal(inRoot(c.T, 'SO.override({ id: "' + a.id + '", by: "boss", why: "the owner asked for it" })').overridden, true);
  assert.equal(inRoot(c.T, 'SO.cleared("to-dave.md#d1")'), true);
  const lines = c.r('company/state/signoffs.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.op), ['ask', 'override'], 'refused answers write nothing');
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
