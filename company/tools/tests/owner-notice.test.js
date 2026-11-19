#!/usr/bin/env node
/* owner-notice.test.js — how the company tells the owner things (company/tools/lib/owner-notice.js):
 *   - an FYI never reaches company/owner/outbound.jsonl directly: it waits in company/owner/digest.jsonl;
 *   - the day's FYIs fold into ONE plain message, once a company day, at or after the evening hour (config);
 *   - an urgent notice goes out at once and passes the plain check, or the offending part moves to `technical`;
 *   - the same key is sent once a day; the next day it may go again;
 *   - `owner-inbox.js send` (the CLI the crew uses): the CEO's reply is urgent, anyone else's note is an FYI;
 *   - halt.js tells the owner "The company is paused" / "The company is running again", with no command in the words;
 *   - `owner-inbox.js digest` folds by hand (--force ignores the hour, never the once-a-day rule).
 * A throwaway company; nothing reaches a station or the checkout.
 *
 *   node --test company/tools/tests/owner-notice.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const T = require('../lib/temp-life').tmpDir('owner-notice-test-');
const W = (rel, data) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1)); return f; };
const R = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
const rows = rel => R(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
W('company/company.json', { name: 'Test Co', slug: 'testco', timezone: 'UTC', owner: { name: 'Olive' } });
W('company/tools/loops.json', { agents: { 'a-ceo': { name: 'Alex', manager: null, functions: ['ceo'] }, 'a-two': { name: 'Kim', manager: 'a-ceo', functions: [] } } });
W('company/defaults/work/ops/owner-notices.json', fs.readFileSync(path.join(REPO, 'company', 'defaults', 'work', 'ops', 'owner-notices.json'), 'utf8'));
fs.mkdirSync(path.join(T, 'secrets'), { recursive: true });
process.env.CAPHEOS_ROOT = T; process.env.CAPHEOS_TZ = 'UTC'; delete process.env.OWNER_DIR;
const N = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-notice.js'));
const scope = require(path.join(REPO, 'company', 'tools', 'lib', 'owner-scope.js'));
const reset = () => { for (const f of ['company/owner/outbound.jsonl', 'company/owner/digest.jsonl', 'company/state/owner-digest.json']) fs.rmSync(path.join(T, f), { force: true }); };
const at = iso => Date.parse(iso);
const jargonOf = t => scope.plainScore(String(t).replace(/\]\(console:[^)]*\)/g, ']')).jargon;

test('an fyi never hits outbound.jsonl directly; it waits in digest.jsonl, plain in front', () => {
  reset();
  const r = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim set up the new price list (company/work/prices.md, commit 3fa9c2e1).', now: at('2026-11-18T09:00:00Z') });
  assert.equal(r.sent, 'digest');
  assert.equal(R('company/owner/outbound.jsonl'), '', 'nothing went to the owner at once');
  const [row] = rows('company/owner/digest.jsonl');
  assert.equal(row.text, 'Kim set up the new price list.');
  assert.match(row.technical, /prices\.md/);
  assert.equal(row.kind, 'fyi'); assert.equal(row.day, '2026-11-18');
});

test('the digest folds N fyi rows into ONE plain message, once a day, at the evening hour', () => {
  reset();
  const texts = ['Kim finished the shop page.', 'Alex hired a writer for the blog.', 'Kim fixed a broken link (`docs/x.md`).', 'Kim finished the shop page.'];
  texts.forEach((t, i) => N.send({ kind: 'fyi', from: i === 1 ? 'Alex' : 'Kim', text: t, key: 'k' + i, now: at('2026-11-18T' + String(8 + i).padStart(2, '0') + ':00:00Z') }));
  assert.equal(N.pending().length, 4);
  let d = N.digest({ now: at('2026-11-18T17:59:00Z') });
  assert.equal(d.sent, false); assert.match(d.why, /evening hour/);
  d = N.digest({ now: at('2026-11-18T18:05:00Z') });
  assert.equal(d.sent, true); assert.equal(d.folded, 4);
  const out = rows('company/owner/outbound.jsonl');
  assert.equal(out.length, 1, 'one message for the whole day');
  assert.equal(out[0].kind, 'digest'); assert.equal(out[0].title, 'What the crew did today');
  assert.match(out[0].text, /^What the crew did today:\n- Kim finished the shop page\.\n- Alex hired a writer for the blog\.\n- Kim fixed a broken link\.\n/);
  assert.equal((out[0].text.match(/shop page/g) || []).length, 1, 'the same sentence is listed once');
  assert.deepEqual(jargonOf(out[0].text), [], 'the day message is plain: ' + out[0].text);
  assert.match(out[0].technical, /docs\/x\.md/);
  assert.equal(N.pending().length, 0);
  // once a day: a later FYI and a later tick the same evening send nothing more
  N.send({ kind: 'fyi', from: 'Kim', text: 'Kim tidied the files.', now: at('2026-11-18T20:00:00Z') });
  assert.equal(N.digest({ now: at('2026-11-18T21:00:00Z') }).sent, false);
  assert.equal(N.digest({ now: at('2026-11-18T21:00:00Z'), force: true }).sent, false, '--force ignores the hour, never the once-a-day rule');
  // the next evening it goes, with only the rows not folded yet
  d = N.digest({ now: at('2026-11-19T18:00:00Z') });
  assert.equal(d.sent, true); assert.equal(d.folded, 1);
  assert.equal(rows('company/owner/outbound.jsonl').length, 2);
  assert.equal(N.digest({ now: at('2026-11-20T19:00:00Z') }).why, 'nothing to tell', 'a quiet day sends nothing');
  // a note with nothing plain in it reaches the owner as one plain line by kind, its words only in the technical part
  N.send({ kind: 'fyi', from: 'Kim', text: 'systemctl --user daemon-reload done', now: at('2026-11-21T10:00:00Z') });
  d = N.digest({ now: at('2026-11-21T19:00:00Z') });
  assert.equal(d.sent, true); assert.match(d.row.text, /Kim noted a change to the crew's background jobs\./); assert.doesNotMatch(d.row.text, /systemctl/);
});

test('the evening hour comes from company/work/ops/owner-notices.json over the defaults', () => {
  reset();
  W('company/work/ops/owner-notices.json', { eveningHour: 7 });
  N.send({ kind: 'fyi', from: 'Kim', text: 'Kim wrote the weekly note.', now: at('2026-11-18T06:00:00Z') });
  assert.equal(N.digest({ now: at('2026-11-18T06:30:00Z') }).sent, false);
  assert.equal(N.digest({ now: at('2026-11-18T07:00:00Z') }).sent, true);
  fs.rmSync(path.join(T, 'company/work/ops/owner-notices.json'));
});

test('urgent goes out at once and passes the plain check, or the offending part moves to technical', () => {
  reset();
  const clean = N.send({ kind: 'urgent', from: 'Alex', text: 'The company is paused. Nothing new starts until you start it again.' });
  assert.equal(clean.sent, 'outbound'); assert.equal(clean.row.text, 'The company is paused. Nothing new starts until you start it again.'); assert.equal(clean.row.technical, undefined);
  const r = N.send({ kind: 'urgent', from: 'Watchdog', text: 'The crew has not worked for 40 minutes. The dispatcher heartbeat in company/state/dispatch-state.json is stale (systemctl status capheos-dispatch.timer). Run `node company/tools/watchdog.js --check` [q-123456].' });
  const row = rows('company/owner/outbound.jsonl').pop();
  assert.equal(row.id, r.row.id); assert.equal(row.kind, 'urgent');
  assert.equal(row.text, 'The crew has not worked for 40 minutes.');
  assert.deepEqual(jargonOf(row.text), []);
  for (const bit of ['dispatch-state.json', 'systemctl', 'watchdog.js --check']) assert.ok(row.technical.includes(bit), bit + ' is in the technical part');
  // nothing plain left: a plain lead is written, the whole text is technical
  const t = N.send({ kind: 'urgent', from: 'Alex', text: 'systemctl restart capheos-station.service failed: exit 1', key: 'x' });
  assert.match(t.row.text, /^Alex reports the company has stopped working\. The full message is in the details below/); assert.match(t.row.technical, /systemctl restart/);
  // a key never leaks, in the words or in the technical part
  const k = N.send({ kind: 'urgent', from: 'Alex', text: 'The bank needs you now.', technical: 'token sk-abcdefghijklmnopqrstuvwxyz123456' });
  assert.ok(!JSON.stringify(k.row).includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
});

test('dedupe by key within a company day; the next day it may go again', () => {
  reset();
  const a = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim backed up the files.', key: 'backup', now: at('2026-11-18T09:00:00Z') });
  const b = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim backed up the files again.', key: 'backup', now: at('2026-11-18T15:00:00Z') });
  assert.equal(a.sent, 'digest'); assert.equal(b.duplicate, true);
  const c = N.send({ kind: 'fyi', from: 'Kim', text: 'Kim backed up the files.', key: 'backup', now: at('2026-11-19T09:00:00Z') });
  assert.equal(c.sent, 'digest');
  // without a key the sender and plain text are the key
  N.send({ kind: 'urgent', from: 'Alex', text: 'The bank account is locked.' });
  assert.equal(N.send({ kind: 'urgent', from: 'Alex', text: 'The bank account is locked.' }).duplicate, true);
  assert.equal(rows('company/owner/outbound.jsonl').length, 1);
  assert.equal(rows('company/owner/digest.jsonl').length, 2);
});

const cli = (args, env) => spawnSync(process.execPath, [path.join(REPO, 'company', 'tools', 'owner-inbox.js')].concat(args),
  { env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }, env || {}), encoding: 'utf8', timeout: 60000 });

test('owner-inbox.js send: the CEO\'s reply is urgent, another crew member\'s note is an fyi', () => {
  reset();
  let r = cli(['send', '--by', 'Alex', '--re', 'in-1', '--text', 'Done: the shop is open. I used the price list you sent (company/work/prices.md).']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let out = JSON.parse(r.stdout); assert.equal(out.kind, 'urgent'); assert.equal(out.movedToTechnical, true);
  const row = rows('company/owner/outbound.jsonl').pop();
  assert.equal(row.re, 'in-1'); assert.equal(row.text, 'Done: the shop is open. I used the price list you sent.');
  r = cli(['send', '--by', 'Kim', '--text', 'Kim cleaned up the old files.']);
  out = JSON.parse(r.stdout); assert.equal(out.kind, 'fyi');
  assert.equal(rows('company/owner/outbound.jsonl').length, 1, 'the crew note waits for the day message');
  assert.equal(rows('company/owner/digest.jsonl').length, 1);
  r = cli(['digest']);
  assert.equal(r.status, 0); const d = JSON.parse(r.stdout);
  if (new Date().getUTCHours() < 18) assert.equal(d.sent, false);
  r = cli(['digest', '--force']);
  assert.equal(r.status, 0); assert.ok(JSON.parse(r.stdout).sent || /already sent/.test(JSON.parse(r.stdout).why));
  assert.equal(rows('company/owner/outbound.jsonl').filter(x => x.kind === 'digest').length, 1);
});

test('halt.js: "The company is paused" / "The company is running again", no command in the words', () => {
  reset();
  const script = `
    const h = require(${JSON.stringify(path.join(REPO, 'company', 'tools', 'halt.js'))});
    h.S.call = async (m, p) => ({ status: 200, body: JSON.stringify(p === '/api/cron' ? { enabled: true, jobs: [] } : p === '/api/state/snapshot' ? { runs: [] } : p === '/api/loops' ? { loops: [] } : { ok: true, halted: 1 }) });
    h.S.services = () => {};
    (async () => { await h.hard({ by: 'Olive', why: 'checking the books' }); await h.resume({ by: 'Olive' }); console.log('done'); })().catch(e => { console.error(e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = rows('company/owner/outbound.jsonl');
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.match(out[0].text, /^The company is paused/); assert.match(out[1].text, /^The company is running again/);
  for (const m of out) {
    assert.equal(m.kind, 'urgent');
    assert.ok(!/node |\.js\b|`|--[a-z]|<name>|E-STOP|HTTP/.test(m.text), 'no command or raw detail: ' + m.text);
    assert.deepEqual(jargonOf(m.text), [], m.text);
  }
  assert.match(out[0].technical, /halt\.js resume/, 'the command is for the crew, collapsed');
});

test.after(() => { fs.rmSync(T, { recursive: true, force: true }); });
