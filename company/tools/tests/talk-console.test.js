#!/usr/bin/env node
/* talk-console.test.js — Settings › How the crew talks to you (console/talk.js routes, console/ui/js/screens/settings/
 * talk-words.js, company/defaults/owner/talk-examples.json) on a fixture company, the routes on a stand-in router and the
 * tool run as the owner's console runs it:
 *   - every label and example the owner reads passes lib/owner-scope.js wordsProblems, except the Technical examples,
 *     allowlisted by id (they are the preview of that choice)
 *   - GET gives the choice and the examples; POST saves through talk.js as the owner and says so plainly; a choice that
 *     is not an option is a 400; the same POST outside the owner's shell or console is refused
 *   node --test company/tools/tests/talk-console.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const { wordsProblems } = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

function fixture() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-console-')); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: { boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' } } });
  for (const f of ['company/defaults/owner/talk.json', 'company/defaults/owner/talk-examples.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  return T;
}
class HttpError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }
function mount(T, shell) {
  const routes = [];
  const run = (name, args) => new Promise(resolve => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (shell !== false) + ');' +
      'const r = require(' + JSON.stringify(path.join(TOOLS, name)) + ').run(' + JSON.stringify(args) + '); process.stdout.write(JSON.stringify(r.out)); process.exitCode = r.code;';
    execFile(process.execPath, ['-e', code], { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T }) }, (err, out) => {
      let data = null; try { data = JSON.parse(out); } catch (_) { data = { text: out }; }
      resolve({ code: err ? err.code || 1 : 0, data });
    });
  });
  const runApi = async (name, args) => { const r = await run(name, args); if (r.code === 0 && r.data.ok !== false) return Object.assign({ ok: true }, r.data); throw new HttpError(r.code === 3 ? 403 : r.code === 2 ? 400 : 500, r.data.error || 'failed', r.data); };
  const bad = (m, s) => { throw new HttpError(s || 400, m); };
  require(path.join(REPO, 'console', 'talk.js')).mount((method, re, fn) => routes.push({ method, re, fn }), { runApi, bad, owner: () => 'Olive' });
  return async (method, url, body) => { for (const r of routes) { const m = r.method === method && url.match(r.re); if (m) return r.fn(m, new URLSearchParams(), body || {}); } throw new Error('no route ' + url); };
}
const plain = (what, t) => assert.deepEqual(wordsProblems(String(t)), [], what + ': ' + t);

test('the owner\'s words: every label and every example but the Technical ones are plain', async () => {
  const W = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'settings', 'talk-words.js'));
  for (const [k, v] of Object.entries(W)) {
    if (typeof v === 'string') plain(k, v);
    else if (Array.isArray(v)) for (const row of v) for (const x of row.slice(1)) if (x) plain(k, x);
    else if (typeof v === 'function') plain(k, v({ 'sent-back': 2, masked: 1, wouldSendBack: 4 }));
  }
  assert.equal(W.SAVED, 'Saved. The crew will talk to you this way from their next message.');
  assert.deepEqual(W.LEVELS.map(l => l[3]), ['Everyday words. They tell you what it means for you, not how it works.', 'Mostly plain, with the odd technical word explained.', 'The crew talks the way they talk to each other.']);
  assert.deepEqual(W.OFTEN.map(o => o[1]), ['Only when they need you (and a weekly summary)', 'A daily summary', 'As things happen']);
  const TK = require(path.join(TOOLS, 'lib', 'talk.js'));
  plain('masked notice', TK.MASKED_NOTICE); plain('technical title', TK.TECH_TITLE);
  const E = JSON.parse(fs.readFileSync(path.join(REPO, 'company', 'defaults', 'owner', 'talk-examples.json'), 'utf8'));
  let n = 0;
  for (const m of E.messages) {
    plain('label ' + m.id, m.label);
    for (const lv of ['plain', 'some', 'technical']) for (const len of ['short', 'medium', 'full']) {
      const t = m.levels[lv][len]; assert.ok(typeof t === 'string' && t.length > 20, m.id + '.' + lv + '.' + len);
      if (E.technicalIds.includes(m.id + '.' + lv)) { assert.equal(lv, 'technical'); assert.ok(wordsProblems(t).length > 0, 'a Technical example reads technical: ' + t); continue; }
      plain(m.id + '.' + lv + '.' + len, t); assert.ok(TK.check(t, lv, len).ok, m.id + '.' + lv + '.' + len + ' passes its own level: ' + JSON.stringify(TK.check(t, lv, len).problems)); n++;
    }
  }
  assert.equal(n, 18);
  assert.equal(E.messages.find(m => m.id === 'progress').levels.plain.short, 'The price checker is back and has caught up on the morning\'s prices. Nothing for you to do.');
  assert.equal(E.messages.find(m => m.id === 'progress').levels.some.short, 'The price checker (the job that saves market prices every minute) restarted and filled the 40 minutes it missed. Nothing for you to do.');
});

test('GET shows the choice and the examples; POST saves through talk.js as the owner', async () => {
  const T = fixture(); const call = mount(T);
  let v = await call('GET', '/api/settings/talk');
  assert.equal(v.picked, false); assert.equal(v.prefs.level, 'technical'); assert.equal(v.examples.messages.length, 3);
  await assert.rejects(call('POST', '/api/settings/talk', { level: 'loud' }), e => e.status === 400 && !wordsProblems(e.message).length);
  await assert.rejects(call('POST', '/api/settings/talk', {}), e => e.status === 400);
  const r = await call('POST', '/api/settings/talk', { level: 'some', length: 'medium', often: 'needed' });
  assert.equal(r.changed, true); assert.equal(r.said, 'Saved. The crew will talk to you this way from their next message.');
  const f = JSON.parse(fs.readFileSync(path.join(T, 'company', 'owner', 'talk.json'), 'utf8'));
  assert.deepEqual([f.level, f.length, f.often, f.check, f.setBy], ['some', 'medium', 'needed', 'live', 'owner']);
  assert.match(fs.readFileSync(path.join(T, 'company', 'work', 'decisions.md'), 'utf8'), /How the crew talks to the owner: Some detail, medium length, only when needed/);
  v = await call('GET', '/api/settings/talk');
  assert.equal(v.picked, true); assert.equal(v.prefs.level, 'some');
  const refused = mount(T, false);
  await assert.rejects(refused('POST', '/api/settings/talk', { level: 'plain' }), e => e.status === 403);
  assert.equal(JSON.parse(fs.readFileSync(path.join(T, 'company', 'owner', 'talk.json'), 'utf8')).level, 'some', 'nothing changed');
});
