#!/usr/bin/env node
/* profile-console.test.js — Crew › Profile (console/profile.js routes, console/ui/js/screens/crew-profile.js words) on a
 * fixture company, with the routes mounted on a stand-in router and the tool run as the owner's console would run it:
 *   - every label and every sentence the owner reads passes lib/owner-scope.js wordsProblems (no ids, paths, model names)
 *   - a save with a stale base is a 409 in plain words; a fresh one saves; try shows the trial banner; keep ends it
 *   - a proposal shows in the owner's words and Add it applies it
 *   node --test company/tools/tests/profile-console.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const { wordsProblems } = require(path.join(TOOLS, 'lib', 'owner-scope.js'));
const P = require(path.join(TOOLS, 'lib', 'profile.js'));
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });

function fixture() {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-console-')); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: { boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, mar: { name: 'Marisol', functions: ['people'], manager: 'boss', inbox: 'to-marisol.md' }, ben: { name: 'Benny', manager: 'boss', inbox: 'to-benny.md', role: 'company/roles/benny.md' }, ro: { name: 'Rohan', manager: 'boss', inbox: 'to-rohan.md' } } });
  for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json', 'company/defaults/state/governance.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  w('company/work/decisions.md', '# Decisions\n\n');
  w('company/model-policy.json', { seats: { ben: { chain: [{ provider: 'deepseek', model: 'deepseek-flash' }] }, ro: { chain: [{ provider: 'deepseek', model: 'deepseek-pro' }] } } });
  w('company/roles/benny.md', '# Benny\n\n## Archetype\nscout\n\n## Counterpart\nRohan tests every card.\nSign-off: promote, commit\n\n## Example exchanges\n- With Rohan: "Lucky week." — You: "Cheap to check." (pushes back)\n- With the owner: "News?" — You: "Two cards."\n- With Rohan: "Killed." — You: "Next."\n');
  return T;
}
class HttpError extends Error { constructor(status, msg, data) { super(msg); this.status = status; this.data = data; } }
function mount(T) {
  const routes = [];
  const run = (name, args) => new Promise(resolve => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(true); process.argv = [process.argv[0], "x"].concat(' + JSON.stringify(args) + ');' +
      'const r = require(' + JSON.stringify(path.join(TOOLS, name)) + ').run(' + JSON.stringify(args) + '); process.stdout.write(JSON.stringify(r.out)); process.exitCode = r.code;';
    execFile(process.execPath, ['-e', code], { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROFILE_NO_SYNC: '1' }) }, (err, out) => {
      let data = null; try { data = JSON.parse(out); } catch (_) { data = { text: out }; }
      resolve({ code: err ? err.code || 1 : 0, data });
    });
  });
  const runApi = async (name, args) => { const r = await run(name, args); if (r.code === 0 && r.data.ok !== false) return Object.assign({ ok: true }, r.data); throw new HttpError(r.code === 2 ? 400 : 500, r.data.error || 'failed', r.data); };
  const bad = (m, s) => { throw new HttpError(s || 400, m); };
  require(path.join(REPO, 'console', 'profile.js')).mount((method, re, fn) => routes.push({ method, re, fn }), { run, runApi, bad, HttpError, owner: () => 'owner' });
  return async (method, url, body) => { for (const r of routes) { const m = r.method === method && url.match(r.re); if (m) return r.fn(m, new URLSearchParams(), body || {}); } throw new Error('no route ' + url); };
}
const plain = (what, t) => { const p = wordsProblems(String(t).replace(/\*\*/g, '')); assert.deepEqual(p, [], what + ': ' + t); };

test('the owner\'s words: labels, sentences, the trial banner and proposals are plain; a stale save is a plain 409', async () => {
  const T = fixture(); const call = mount(T);
  const mg = await call('POST', '/api/profile/ben/migrate'); assert.equal(mg.ok, true, JSON.stringify(mg));
  await call('POST', '/api/profile/ro/migrate');
  let v = await call('GET', '/api/profile/ben');
  assert.equal(v.profile.version, 1); assert.ok(v.preview.block.includes('YOUR PROFILE')); assert.ok(v.history.length >= 1);
  assert.equal(v.words.counterpart, '**Who checks Benny:** Rohan. Before Benny can **move an idea to a test** or **commit someone else\'s time**, Rohan has to agree.');
  assert.equal(v.words.model, 'Runs on: the cheap setup');
  assert.match(v.words.family[0], /Rohan checks Benny and both run on the same kind of AI/);
  for (const [k, t] of Object.entries(v.words)) for (const x of [].concat(t)) plain('words.' + k, typeof x === 'string' ? x : x.text);
  for (const t of Object.values(v.signoffKinds)) plain('sign-off kind', t);
  for (const s of Object.values(v.temperament.sliders)) { plain('slider', s.label); for (const d of s.values) plain('slider value', d); }
  for (const pr of (await call('GET', '/api/profile/presets')).presets) plain('preset', pr.label);
  // the screen's own labels and buttons
  const src = fs.readFileSync(path.join(REPO, 'console', 'ui', 'js', 'screens', 'crew-profile.js'), 'utf8');
  const lits = [...src.matchAll(/(?:section|Button|h\('(?:h3|label|summary|p)'[^,]*,)\(?'([^']{3,})'/g)].map(m => m[1]).concat([...src.matchAll(/\['\w+', '([^']+)'(?:, '([^']+)')?\]/g)].flatMap(m => [m[1], m[2]].filter(Boolean)));
  assert.ok(lits.length > 20, lits.join(' | '));
  for (const t of lits) plain('screen', t);
  for (const t of ['Profile', 'Who they are', 'Temperament', 'What they believe', 'What they won\'t do', 'What they look after', 'How they sound', 'Example exchanges', 'Who checks them', 'Strengths', 'Blind spots', 'Habits', 'Relationships', 'Experiences', 'Fixed rules', 'Go back to this version', 'Try this change', 'Use profiles for this company']) assert.ok(src.replace(/\\'/g, '\'').includes('\'' + t + '\'') || fs.readFileSync(path.join(REPO, 'console', 'ui', 'js', 'screens', 'crew.js'), 'utf8').includes('\'' + t + '\''), t);
  // a stale base: 409 in plain words; a fresh one saves
  const ok = await call('POST', '/api/profile/ben', { set: { '/voice/words': 'Quick and cheerful.' }, base: 1 });
  assert.equal(ok.version, 2);
  await assert.rejects(call('POST', '/api/profile/ben', { set: { '/voice/words': 'Other.' }, base: 1 }), e => e.status === 409 && /Someone changed this profile while you were editing it/.test(e.message) && !wordsProblems(e.message).length);
  // try: the banner; keep ends it
  const tr = await call('POST', '/api/profile/ben/try', { set: { '/temperament': Object.assign({}, v.profile.temperament, { risk: 1, pace: 1 }) }, base: 2, days: 7 });
  assert.equal(tr.trial.from, 2);
  v = await call('GET', '/api/profile/ben');
  assert.match(v.words.trial, /^You're trying a (more careful|calmer) Benny until \w+day\. Keep it · Go back now\.$/); plain('trial', v.words.trial);
  await call('POST', '/api/profile/ben/trial/keep');
  assert.equal((await call('GET', '/api/profile/ben')).profile.trial, null);
  // a proposal in the owner's words, then Add it
  const pp = await new Promise(res => execFile(process.execPath, [path.join(TOOLS, 'profile.js'), 'propose', 'ben', '--kind', 'experience', '--text', 'The forum tip cost two days and taught him to check the fee first', '--why', 'the weather card', '--by', 'Marisol'], { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) }, (e, out) => res(JSON.parse(out))));
  v = await call('GET', '/api/profile/ben');
  assert.equal(v.words.proposals[0].text, 'Marisol suggests adding to Benny\'s experience: \'The forum tip cost two days and taught him to check the fee first.\' Add it · Not this one · Try it.');
  plain('proposal', v.words.proposals[0].text);
  await call('POST', '/api/profile/proposals/' + pp.id + '/apply');
  assert.equal((await call('GET', '/api/profile/ben')).profile.experiences.length, 1);
  // a preview of unsaved changes writes nothing
  const before = fs.readFileSync(path.join(T, 'company/people/profiles/ben.json'), 'utf8');
  const pv = await call('POST', '/api/profile/ben/preview', { set: { '/convictions': ['Only cheap tests.'] } });
  assert.ok(pv.block.includes('Only cheap tests.')); assert.equal(fs.readFileSync(path.join(T, 'company/people/profiles/ben.json'), 'utf8'), before);
  // the company switch
  assert.equal((await call('POST', '/api/profile/policy', { inject: 'profile' })).policy.inject, 'profile');
  await assert.rejects(call('POST', '/api/profile/ben', { set: { 'bad pointer': 1 }, base: 1 }), e => e.status === 400);
  assert.deepEqual(P.FIXED_BOUNDARIES.flatMap(b => wordsProblems(b.plain)), []);
});
