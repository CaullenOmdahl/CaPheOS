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
let RUNS = 0;
function mount(T) {
  const routes = [];
  const run = (name, args) => new Promise(resolve => {
    const code = 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(true); process.argv = [process.argv[0], "x"].concat(' + JSON.stringify(args) + ');' +
      'const r = require(' + JSON.stringify(path.join(TOOLS, name)) + ').run(' + JSON.stringify(args) + '); process.stdout.write(JSON.stringify(r.out)); process.exitCode = r.code;';
    // a script file, not node -e: a profile is read only as an untainted profile.js recorded it (lib/recorded.js)
    const sf = path.join(T, '.run-' + (++RUNS) + '.js'); fs.writeFileSync(sf, code);
    execFile(process.execPath, [sf], { cwd: T, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROFILE_NO_SYNC: '1' }) }, (err, out) => {
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

test('a Plain owner\'s preview shows the crew\'s words without commands or file paths; every edit wakes the save area; presets ask three ways', async () => {
  const T = fixture(); const call = mount(T);
  await call('POST', '/api/profile/ben/migrate'); await call('POST', '/api/profile/ro/migrate');
  fs.mkdirSync(path.join(T, 'company', 'owner'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'owner', 'talk.json'), JSON.stringify({ v: 1, level: 'plain', length: 'medium', often: 'daily', check: 'live', setBy: 'owner', at: '2026-11-18T00:00:00Z' }));
  const v = await call('GET', '/api/profile/ro');
  assert.equal(v.preview.ownerLevel, 'plain');
  assert.ok(/node company\/tools\/approvals\.js/.test(v.preview.block), 'the crew\'s own block keeps its command (agents stay technical)');
  assert.ok(!/node |company\/|--verdict|\*\*Needs sign-off/.test(v.preview.blockOwner), 'the Plain view has no command, path or markup: ' + v.preview.blockOwner);
  const pv = await call('POST', '/api/profile/ro/preview', { set: { '/convictions': ['Cards live in company/work/ideas/ and I read them all.'] } });
  assert.ok(!/company\/work/.test(pv.blockOwner) && /Cards live in/.test(pv.blockOwner));
  // 2026-11-19 re-review: paths in backticks and short ones (sim/), the blank lines between sections, the technical words
  const pv2 = await call('POST', '/api/profile/ro/preview', { set: { '/convictions': ['Cards live in `company/work/ideas/` and runs in `sim/`.'], '/whereYouLook': ['The fills in `company/work/sim/out/` first.', 'Never merges to the default branch; the pre-merge check and the merge gate first (**FYI:** on Claude, not MiniMax).'] } });
  const bo = pv2.blockOwner;
  assert.ok(!/`|company\/|sim\/|\bsim\b\//.test(bo), 'no path, in backticks or not: ' + bo);
  assert.ok(/Cards live in \(a crew file\)/.test(bo), bo);
  for (const w of ['default branch', 'pre-merge check', 'merge gate', 'Claude', 'MiniMax', '**FYI:**', '**']) assert.ok(!bo.includes(w), 'no "' + w + '" for a Plain owner: ' + bo);
  assert.ok(/\n\nWhose work you check:|\n\nWho checks your work:/.test(bo) && /\n\nFixed rules/.test(bo), 'sections keep their blank lines');
  assert.ok(bo.includes('Never changes the main copy of a project directly'), 'the fixed rules in the tab\'s plain words');
  // the screen: the example fields, the pushes-back box, the With picker and the sign-off boxes all refresh the save area
  const src = fs.readFileSync(path.join(REPO, 'console', 'ui', 'js', 'screens', 'crew-profile.js'), 'utf8');
  const ex = src.slice(src.indexOf('function exampleRow'), src.indexOf('function counterpartPicker'));
  assert.equal((ex.match(/onEdit\(\)/g) || []).length, 4, 'they, you, pushes back and With each call onEdit()');
  const cp = src.slice(src.indexOf('function counterpartPicker'), src.indexOf('function presetWith'));
  assert.ok(/signOff = kinds[^\n]*onEdit\(\)/.test(cp), 'a sign-off box refreshes the save area');
  const pr = src.slice(src.indexOf('function applyPreset'), src.indexOf('load();', src.indexOf('function applyPreset')));
  assert.ok(!/confirm\(/.test(pr), 'the preset choice is not a two-button confirm');
  for (const t of ['Fill only empty fields', 'Replace everything', 'Cancel']) assert.ok(src.includes('\'' + t + '\''), t);
  assert.ok(!/: 'owner';\s*$/m.test(pr) && /presetWith\(ex\.with\)/.test(pr), 'a preset example is said by the right person, not by the owner by default');
  assert.ok(/'data-preview': ''[^\n]*position:sticky/.test(src), 'the preview is pinned in view beside the edits');
  assert.deepEqual(v.relations.checks, ['ben'], 'the screen knows whose work Rohan checks (the preset\'s "eager" example)');
});
