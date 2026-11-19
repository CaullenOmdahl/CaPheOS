#!/usr/bin/env node
/* accountable.test.js — accountable leads (lib/accountable.js, company/tools/accountable.js, docs/DEPARTMENTS.md §8) on a
 * fixture company, every call in a child (a script file, so its provenance rows are trusted: lib/recorded.js):
 *   boss Alex (CEO)   mar Marisol (people)   kwa Kwame (lead of Engineering)   ben Ben, cat Cat (members)   dan Dan (Ops)
 * Each rule of the owner's pathway has a test: intake through the lead (a copy when work goes straight to a member), the
 * self-check (acceptance check, check command run, note; a failed one never reaches the lead), the packet (diff + check +
 * note, no history), the binding audit (ACCEPT / REVISE with findings; DONE, the onward handoff and the merge held until
 * ACCEPT), the audit tier (routine vs risky, fixed pairs, never a router; a shut pair waits), the lead passing work on,
 * escalation one level at a time, the scorecard (on time, sent back, cost, escapes, spot checks) in plain words, the
 * per-department switch (off / recording only / live) and the fall back when the saving does not show.
 *   node --test company/tools/tests/accountable.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOLS = path.join(REPO, 'company', 'tools');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const DAY = 86400e3;
const CREW = {
  boss: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' },
  mar: { name: 'Marisol', functions: ['people'], manager: 'boss', inbox: 'to-marisol.md' },
  kwa: { name: 'Kwame', manager: 'boss', inbox: 'to-kwame.md', loop: 'Kwame loop' },
  ben: { name: 'Ben', manager: 'kwa', inbox: 'to-ben.md' },
  cat: { name: 'Cat', manager: 'kwa', inbox: 'to-cat.md' },
  dan: { name: 'Dan', manager: 'boss', inbox: 'to-dan.md' },
};
const LEAD = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' };
const MID = { provider: 'claude-cli', model: 'claude-sonnet-4-6', effort: 'medium' };
const depts = acc => ({ version: 1, leadModelDefault: LEAD, departments: [
  { id: 'eng', name: 'Engineering', lead: 'kwa', members: ['kwa', 'ben', 'cat'], defaultClass: 'code', routes: {}, consult: {}, accountable: acc },
  { id: 'ops', name: 'Operations', lead: null, members: ['dan'], defaultClass: 'ops', routes: {}, consult: {} }] });
const ITEM = (id, from, head, extra) => '\n## 2026-11-19 from ' + from + ' — ' + head + '\n**Id:** ' + id + '\n**Need:** a long history line the lead never needs to read in the packet: HISTORY-MARKER\n' + (extra || '') + '**Status:** OPEN\n';

function fixture(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'accountable-test-')); roots.push(T);
  const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  w('company/company.json', { name: 'Accountable Co', slug: 'acc-co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  w('company/tools/loops.json', { agents: CREW });
  w('company/defaults/departments.json', fs.readFileSync(path.join(REPO, 'company/defaults/departments.json'), 'utf8'));
  w('company/defaults/work/departments/audit-prompt.md', fs.readFileSync(path.join(REPO, 'company/defaults/work/departments/audit-prompt.md'), 'utf8'));
  w('company/departments.json', depts(o.acc === undefined ? { mode: 'live', since: '2026-11-01T00:00:00Z', by: 'owner' } : o.acc));
  w('company/state/governance.json', { categories: {} });
  w('company/work/decisions.md', '# Decisions\n\nNewest first.\n\n');
  for (const f of ['BRIEF.md', 'DECISIONS.md', 'INBOX-DIGEST.md']) w('company/work/departments/eng/' + f, '# x\n');
  for (const s of Object.values(CREW)) w('company/work/handoffs/' + s.inbox, '# Handoffs\n');
  w('company/work/dispatch-log.md', '');
  const r = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
  const add = (inbox, text) => fs.appendFileSync(path.join(T, 'company/work/handoffs', inbox), text);
  // a child script at the fixture root: lib/accountable.js as AC, departments.js as DEPT; o2.owner pins the owner's shell
  const js = (expr, o2) => {
    o2 = o2 || {};
    const sf = path.join(T, '.t-run.js');
    fs.writeFileSync(sf, 'const prov = require(' + JSON.stringify(path.join(TOOLS, 'provenance.js')) + '); prov.pinUnderStation(false); prov.pinOwnerShell(' + (o2.owner ? 'true' : 'false') + ');' +
      'const AC = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'accountable.js')) + '); const DEPT = require(' + JSON.stringify(path.join(TOOLS, 'departments.js')) + ');' +
      '(async () => { let out; try { out = await (async () => ' + expr + ')(); } catch (e) { out = { threw: e.stack }; } process.stdout.write(JSON.stringify(out === undefined ? null : out)); })();');
    const p = spawnSync(process.execPath, [sf], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9', LOCKED_WATCH_HOME: path.join(T, 'guard-home'), STARNET_AGENT_ID: '' }) });
    if (p.status !== 0) throw new Error('child failed: ' + p.stdout + p.stderr);
    const out = JSON.parse(p.stdout); if (out && out.threw) throw new Error(out.threw); return out;
  };
  const tick = (extra) => js('(() => { const lines = []; const h = AC.scanTick({ log: l => lines.push(l)' + (extra ? ', ' + extra : '') + ', calls: [] }); const holds = {}; const SP = require(' + JSON.stringify(path.join(TOOLS, 'lib', 'sprint.js')) + '); for (const ib of ' + JSON.stringify(Object.values(CREW).map(s => s.inbox)) + ') for (const it of SP.parseItems(require("fs").readFileSync("company/work/handoffs/" + ib, "utf8")).filter(i => i.open)) { const x = h(ib, it); if (x) holds[ib + " | " + it.heading] = x; } return { lines, holds }; })()');
  const ledger = () => r('company/state/accountable.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { T, w, r, add, js, tick, ledger };
}
// a code department's hand-back needs a check that runs: the tests pass `true` unless they say otherwise
const hb = (c, a) => c.js('AC.handback(' + JSON.stringify(Object.assign({ testCmds: ['true'] }, a)) + ')');
const DIFF = 'diff --git a/src/parse.js b/src/parse.js\n--- a/src/parse.js\n+++ b/src/parse.js\n@@ -1 +1 @@\n-old\n+new\n';
const wordsProblems = t => require(path.join(TOOLS, 'lib', 'owner-scope.js')).wordsProblems(t);

test('intake through the lead: the first tick leaves existing work alone; work sent straight to a member is copied to the lead once and counts as the lead\'s; work the lead assigned is not copied', () => {
  const c = fixture();
  c.add('to-ben.md', ITEM('old-1', 'Alex', 'something from before'));
  const t0 = c.tick();
  assert.ok(t0.lines.some(l => /on from now; the work already there is left as it was/.test(l)), t0.lines.join('\n'));
  c.add('to-ben.md', ITEM('ben-1', 'Dan', 'fix the parser for Ops', '**Acceptance check:** the parser tests pass\n'));
  c.add('to-cat.md', ITEM('cat-1', 'Kwame', 'write the cache docs'));
  c.tick(); c.tick();
  const lead = c.r('company/work/handoffs/to-kwame.md');
  assert.equal((lead.match(/copy: fix the parser for Ops \(sent straight to Ben\)/g) || []).length, 1, 'one copy, even after two ticks: ' + lead);
  assert.match(lead, /\*\*Copy of:\*\* to-ben\.md#ben-1/); assert.match(lead, /It counts as yours/); assert.match(lead, /\*\*Status:\*\* DONE — a copy for the record/);
  assert.ok(!/cache docs/.test(lead), 'work the lead assigned is not copied back to it');
  assert.ok(!/something from before/.test(lead), 'work from before the switch is left alone');
  const intake = c.ledger().filter(x => x.op === 'intake');
  assert.deepEqual(intake.map(x => [x.ref, x.via]).sort(), [['to-ben.md#ben-1', 'direct'], ['to-cat.md#cat-1', 'lead']]);
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Hand back:\*\* to Kwame for audit when it is done[\s\S]*accountable\.js handback ben-1/);
  assert.match(c.r('company/work/handoffs/to-cat.md'), /It has no acceptance check yet: ask Kwame for one/);
});

test('the self-check: the acceptance check and a note are required, the check command is RUN, and a failed self-check never reaches the lead', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n**Check command:** `test -f ok.flag`\n'));
  c.add('to-cat.md', ITEM('cat-1', 'Kwame', 'tidy the docs'));
  c.tick();
  assert.match(hb(c, { by: 'Cat', item: 'cat-1', note: 'I read every page twice and fixed the links', noDiff: 'docs only' }).error, /names no acceptance check/);
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note: 'short', diff: DIFF }).error, /--note/);
  assert.match(hb(c, { by: 'Kwame', item: 'ben-1', note: 'I checked it all very carefully', diff: DIFF }).error, /you lead Engineering/);
  assert.match(hb(c, { by: 'Dan', item: 'x', note: 'I checked it all very carefully' }).error, /accountable leads is off/);
  const fail = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF });
  assert.equal(fail.code, 3, JSON.stringify(fail)); assert.match(fail.error, /your own check failed: `test -f ok\.flag` exited 1\. Nothing went to Kwame/);
  const fail2 = (() => { fs.writeFileSync(path.join(c.T, 'ok.flag'), ''); return hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF, testCmds: ['exit 4'] }); })();
  assert.equal(fail2.code, 3, 'every --test-cmd must pass too');
  assert.ok(!/## Audit:/.test(c.r('company/work/handoffs/to-kwame.md')), 'a failed self-check never reaches the lead');
  assert.equal(c.ledger().filter(x => x.op === 'selfcheck' && x.ok === false).length, 2);
  assert.equal(c.ledger().filter(x => x.op === 'handback').length, 0);
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side' }).error, /code work is handed back with its diff/);
});

test('the packet is the diff + the acceptance check + the self-check note, never the history; the member is not woken for it until the lead answers', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n**Check command:** `true`\n'));
  c.tick();
  const r = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green; read the diff once more', tests: 'npm test -- parser (12 passed)', diff: DIFF, testCmds: ['true'] });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.tier, 'routine'); assert.equal(r.delivered, true);
  const lead = c.r('company/work/handoffs/to-kwame.md');
  const pk = lead.slice(lead.indexOf('## Audit:'));
  assert.match(pk, /### Acceptance check\nthe parser tests pass/); assert.match(pk, /### Self-check \(what Ben checked\)\nran the parser tests/); assert.match(pk, /- ran `true`: exit 0/);
  assert.match(pk, /```diff\n[\s\S]*\+new\n```/); assert.ok(!/HISTORY-MARKER/.test(pk), 'no history in the packet');
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Handed back:\*\* ac-[a-z0-9]+-[0-9a-f]{4} to Kwame for audit/);
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green; read the diff once more', diff: DIFF }).error, /with Kwame for audit already/);
  const t = c.tick();
  assert.deepEqual(t.holds['to-ben.md | 2026-11-19 from Kwame — fix the parser'], { who: 'Kwame', kind: 'audit' }, JSON.stringify(t.holds));
});

test('the audit is binding: only the lead, REVISE needs what to fix, the first verdict decides; a DONE set by hand goes back to OPEN; ACCEPT makes it DONE', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n'));
  c.tick();
  const id1 = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF }).id;
  assert.match(c.js('AC.audit({ id: "' + id1 + '", verdict: "ACCEPT", check: "read the diff", by: "Cat" })').error, /only the lead of Engineering/);
  assert.match(c.js('AC.audit({ id: "' + id1 + '", verdict: "REVISE", check: "read the diff", by: "Kwame" })').error, /at least one --finding/);
  assert.match(c.js('AC.audit({ id: "' + id1 + '", verdict: "ACCEPT", by: "Kwame" })').error, /--check/);
  // a forged ACCEPT row appended by hand is never read
  fs.appendFileSync(path.join(c.T, 'company/state/accountable.jsonl'), JSON.stringify({ op: 'verdict', id: id1, verdict: 'ACCEPT', by: 'kwa', at: Date.now() }) + '\n');
  assert.equal(c.js('[...AC.audits(AC.rows()).values()][0].status'), 'open', 'the hand-written row does not count');
  const rv = c.js('AC.audit({ id: "' + id1 + '", verdict: "REVISE", check: "the diff against the parser tests", findings: ["the empty-line case still throws"], by: "Kwame" })');
  assert.equal(rv.ok, true, JSON.stringify(rv));
  assert.match(c.js('AC.audit({ id: "' + id1 + '", verdict: "ACCEPT", check: "x", by: "Kwame" })').error, /answered already \(REVISE\)/);
  let ben = c.r('company/work/handoffs/to-ben.md');
  assert.match(ben, /\*\*Verdict:\*\* REVISE by Kwame — check: the diff against the parser tests — 1\. the empty-line case still throws/);
  assert.match(ben, /\*\*Status:\*\* OPEN — sent back by Kwame/);
  assert.match(c.r('company/work/handoffs/to-kwame.md'), /\*\*Status:\*\* DONE — REVISE/);
  assert.equal(Object.keys(c.tick().holds).filter(k => /to-ben/.test(k)).length, 0, 'sent back: Ben is woken to fix it');
  // Ben sets it DONE himself: the dispatcher puts it back
  fs.writeFileSync(path.join(c.T, 'company/work/handoffs/to-ben.md'), ben.replace(/\*\*Status:\*\* OPEN — sent back by Kwame.*$/m, '**Status:** DONE — fixed it'));
  const t = c.tick();
  assert.ok(t.lines.some(l => /ACCOUNTABLE DONE HELD to-ben\.md#ben-1/.test(l)), t.lines.join('\n'));
  ben = c.r('company/work/handoffs/to-ben.md');
  assert.match(ben, /\*\*Status:\*\* OPEN — not done until Kwame accepts it/);
  const id2 = hb(c, { by: 'Ben', item: 'ben-1', note: 'fixed the empty-line case and ran the parser tests again', diff: DIFF }).id;
  assert.notEqual(id2, id1);
  assert.equal(c.js('AC.audit({ id: "' + id2 + '", verdict: "ACCEPT", check: "the diff against the parser tests; the empty-line test is there", by: "Kwame" })').ok, true);
  ben = c.r('company/work/handoffs/to-ben.md');
  assert.match(ben, /\*\*Status:\*\* DONE — accepted by Kwame/); assert.match(ben, /\*\*Verdict:\*\* ACCEPT by Kwame/);
  c.tick();
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* DONE — accepted by Kwame/, 'an accepted DONE stays DONE');
});

function gitRepo(dir) {
  const env = Object.assign({}, process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1', HOME: dir });
  const g = (...a) => { const r = spawnSync('git', ['-C', dir].concat(a), { encoding: 'utf8', env }); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'src', 'parse.js'), 'old\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'fix'); fs.writeFileSync(path.join(dir, 'src', 'parse.js'), 'new\n'); g('commit', '-qam', 'fix');
  return { g, head: g('rev-parse', 'HEAD') };
}

test('the merge: the accept is for one PR at exactly the commit handed back (a PR needs --sha, and the packet diff is git\'s at it); the PR decides whether it is needed, not who merges; recording only lets it through', () => {
  const c = fixture();
  const repo = path.join(c.T, 'repo'), { head } = gitRepo(repo);
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n**PR:** https://github.com/acme/shop/pull/12\n'));
  c.tick();
  const gate = (sha, seat) => c.js('AC.gate({ seat: "' + (seat || 'Ben') + '", refs: ["pr:acme/shop#12"], sha: "' + sha + '" })');
  assert.ok(gate(head).refuse, 'no accept: refused');
  assert.match(gate(head, 'dan').refuse || '', /Ben's work is audited by Kwame[\s\S]*whoever merges it/, 'Dan merging Ben\'s PR still needs Kwame\'s accept: the PR decides, not who merges');
  assert.match(gate(head, 'boss').refuse || '', /audited by Kwame/, 'nor the CEO');
  assert.equal(c.js('AC.gate({ seat: "dan", refs: ["pr:acme/shop#99"], sha: "' + head + '" })').needed, false, 'a PR no member is behind is not affected');
  const note = 'ran the parser tests, all green on my side';
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note, diff: DIFF }).error, /--sha <head>/, 'a PR without its commit is refused');
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note, diff: DIFF, sha: head }).error, /--sha needs --cwd/);
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note, cwd: repo, base: 'main', sha: '9999999999999' }).error, /is not in/);
  const r = hb(c, { by: 'Ben', item: 'ben-1', note, cwd: repo, base: 'main', sha: head.slice(0, 10), diff: 'diff --git a/x b/x\n+++ b/x\n+FAKE-DIFF\n' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const pk = c.r('company/work/handoffs/to-kwame.md');
  assert.match(pk, /\(from git at [0-9a-f]{12}, against main\)/); assert.match(pk, /\+new/); assert.ok(!/FAKE-DIFF/.test(pk), 'a typed-in diff is never used with a commit');
  assert.match(pk, /- ran in .*repo \(the member chose the folder\)/);
  assert.equal(c.ledger().find(x => x.op === 'handback').sha, head, 'the full commit is recorded');
  assert.ok(gate(head).refuse, 'handed back is not accepted');
  c.js('AC.audit({ id: "' + r.id + '", verdict: "ACCEPT", check: "the diff against the parser tests", by: "Kwame" })');
  assert.equal(gate(head).cleared, true);
  assert.equal(gate(head, 'dan').cleared, true, 'cleared for whoever merges it');
  assert.match(gate('0123456789abc').refuse, /another one/, 'a commit after the accept needs a new hand-back');
  assert.ok(c.js('AC.gate({ seat: "Ben", refs: ["pr:acme/shop#12"] })').refuse, 'no commit named: never cleared');
  assert.match(fs.readFileSync(path.join(TOOLS, 'merge-gate.js'), 'utf8'), /require\('\.\/lib\/accountable'\)\.gate\(\{ seat: presenter\(\)\.agent, refs: \['pr:' \+ repo \+ '#' \+ h\.pr\], sha: h\.sha \}\)/);
  c.w('company/departments.json', depts({ mode: 'shadow' }));
  const sh = gate('0123456789abc'); assert.equal(sh.would, true); assert.ok(!sh.refuse);
});

test('the lead passes accepted work on: a member\'s handoff out of the department waits; FYI is not held; to the CEO only cross-department or an owner gate; the lead\'s own escalation needs that reason too', () => {
  const c = fixture();
  c.tick();
  c.add('to-dan.md', ITEM('dan-1', 'Ben', 'deploy the new parser for Ops'));
  c.add('to-dan.md', '\n## 2026-11-19 from Ben — FYI the parser is faster now\n**Id:** dan-2\n**FYI:** nothing to do\n**Status:** OPEN\n');
  c.add('to-cat.md', ITEM('cat-9', 'Ben', 'review my tests'));
  c.add('to-alex.md', ITEM('alex-1', 'Ben', 'I need more budget for the parser'));
  c.add('to-alex.md', ITEM('alex-2', 'Kwame', 'escalation: the parser team needs a new tool'));
  c.add('to-alex.md', ITEM('alex-3', 'Kwame', 'escalation: Ops and Engineering disagree on the deploy day', '**Escalation:** cross-department\n'));
  const t = c.tick(); c.tick();
  const H = t.holds;
  assert.deepEqual(H['to-dan.md | 2026-11-19 from Ben — deploy the new parser for Ops'], { who: 'Kwame', kind: 'pass' });
  assert.ok(!H['to-dan.md | 2026-11-19 from Ben — FYI the parser is faster now'], 'FYI is not held');
  assert.ok(!H['to-cat.md | 2026-11-19 from Ben — review my tests'], 'inside the department is not held');
  assert.deepEqual(H['to-alex.md | 2026-11-19 from Ben — I need more budget for the parser'], { who: 'Kwame', kind: 'pass' }, 'member to CEO: one level at a time, through the lead');
  assert.deepEqual(H['to-alex.md | 2026-11-19 from Kwame — escalation: the parser team needs a new tool'], { who: 'Kwame', kind: 'escalation' });
  assert.ok(!H['to-alex.md | 2026-11-19 from Kwame — escalation: Ops and Engineering disagree on the deploy day'], 'a cross-department escalation goes up');
  const lead = c.r('company/work/handoffs/to-kwame.md');
  assert.equal((lead.match(/## .*Pass on: deploy the new parser for Ops/g) || []).length, 1, 'one pass-on item per block');
  assert.match(lead, /escalation held: /);
  assert.match(c.js('AC.pass({ ref: "to-alex.md#alex-1", by: "Kwame" })').error, /one level at a time/);
  assert.match(c.js('AC.pass({ ref: "to-alex.md#alex-1", by: "Kwame", escalation: "owner: tooling" })').error, /one level at a time/);
  assert.equal(c.js('AC.pass({ ref: "to-alex.md#alex-1", by: "Kwame", escalation: "owner: money" })').escalation, 'owner:money');
  assert.match(c.js('AC.pass({ ref: "to-dan.md#dan-1", by: "Ben" })').error, /only a department lead/);
  assert.equal(c.js('AC.pass({ ref: "to-dan.md#dan-1", by: "Kwame" })').passed, true);
  assert.match(c.r('company/work/handoffs/to-dan.md'), /\*\*Passed on by:\*\* Kwame \(lead of Engineering, accountable for it\)/);
  assert.match(c.r('company/work/handoffs/to-kwame.md'), /\*\*Pass-on:\*\* to-dan\.md#dan-1[\s\S]*?\*\*Status:\*\* DONE — passed on/, 'the lead\'s pass-on item is done');
  const t2 = c.tick();
  assert.ok(!t2.holds['to-dan.md | 2026-11-19 from Ben — deploy the new parser for Ops'], 'released once passed on');
  assert.ok(!t2.holds['to-alex.md | 2026-11-19 from Ben — I need more budget for the parser']);
  assert.match(c.js('AC.pass({ ref: "to-dan.md#dan-1", by: "Kwame" })').error, /passed on already/);
});

test('recording only: intake, would-holds and hand-backs are recorded once; nothing is copied, held, reopened or delivered; off computes nothing', () => {
  const c = fixture({ acc: { mode: 'shadow' } });
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Dan', 'fix the parser for Ops', '**Acceptance check:** the parser tests pass\n'));
  c.add('to-dan.md', ITEM('dan-1', 'Ben', 'deploy the new parser for Ops'));
  const t = c.tick(); c.tick();
  assert.deepEqual(t.holds, {}, 'nothing is held');
  assert.ok(!/copy:/.test(c.r('company/work/handoffs/to-kwame.md')));
  assert.ok(!/Hand back/.test(c.r('company/work/handoffs/to-ben.md')), 'the member\'s item is not touched');
  const r = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF });
  assert.equal(r.delivered, false); assert.ok(!/## Audit:/.test(c.r('company/work/handoffs/to-kwame.md')));
  assert.match(c.js('AC.audit({ id: "' + r.id + '", verdict: "ACCEPT", check: "x", by: "Kwame" })').error, /recorded only/);
  const ben = c.r('company/work/handoffs/to-ben.md'); fs.writeFileSync(path.join(c.T, 'company/work/handoffs/to-ben.md'), ben.replace('**Status:** OPEN', '**Status:** DONE — done'));
  c.tick(); c.tick();
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* DONE — done/, 'not reopened');
  const log = c.r('company/state/accountable-state.json');
  for (const k of ['copy:to-ben.md#ben-1', 'pass:to-dan.md#dan-1']) assert.ok(log.includes(k), k);
  assert.match(c.r('company/work/dispatch-log.md'), /WOULD AUDIT ac-/);
  assert.equal(c.ledger().filter(x => x.op === 'intake').length, 1, 'intake recorded once');
  const off = fixture({ acc: null });
  off.add('to-ben.md', ITEM('ben-1', 'Dan', 'x'));
  assert.deepEqual(off.tick().lines, []); assert.equal(off.r('company/state/accountable.jsonl'), ''); assert.equal(off.r('company/state/accountable-state.json'), '');
});

test('the audit tier: routine and risky audits run on the owner\'s fixed pairs; a shut pair waits and never moves to another model; door audit; one run per tick', async () => {
  const c = fixture({ acc: { mode: 'live', since: '2026-11-01T00:00:00Z', audit: { routine: MID, risky: null }, batch: { startAt: 1, minGapMin: 5, maxWaitMin: 15 } } });
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n'));
  c.add('to-cat.md', ITEM('cat-1', 'Kwame', 'rotate the payment credential handling', '**Acceptance check:** the key tests pass\n'));
  c.tick();
  const a = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF });
  const b = hb(c, { by: 'Cat', item: 'cat-1', note: 'ran the key tests and read the diff again', diff: DIFF.replace(/src\/parse\.js/g, 'secrets/handler.js') });
  assert.equal(a.tier, 'routine'); assert.equal(b.tier, 'risky'); assert.ok(b.riskWhy.some(x => /secrets\/handler\.js|credential|payment/.test(x)), JSON.stringify(b.riskWhy));
  c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { routines: { eng: { jobId: 'j-audit', lead: 'kwa', name: 'Kwame lead audit' } } }));
  const allow = pairs => c.w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: { kwa: pairs } });
  const step = () => c.js('(async () => { const fired = [], lines = []; const jobs = [{ id: "j-audit", name: "Kwame lead audit", prompt: "x\\nOpen audits for you: (none)\\n" }]; const r = await AC.auditStep({ jobs, log: l => lines.push(l), call: async () => ({ status: 200, body: "{\\"ok\\":true}" }), fireRun: async (id, ov) => { fired.push({ id, ov }); return { status: 200, body: JSON.stringify({ runId: "run-" + fired.length }) }; }, budget: { capOn: false, unmetered: ["claude-cli"], byAgent: {} } }); return { r, fired, lines }; })()');
  allow([MID]);   // only the mid tier is open: the risky audit waits (it never runs on the mid tier)
  const s1 = step();
  assert.equal(s1.fired.length, 0, JSON.stringify(s1));
  assert.ok(s1.lines.some(l => /AUDIT HOLD Kwame \(risky, claude-cli\/claude-opus-5-5\): not open[\s\S]*waits for its own model/.test(l)), s1.lines.join('\n'));
  allow([MID, LEAD]);
  const s2 = step();
  assert.equal(s2.fired.length, 1); assert.deepEqual(s2.fired[0].ov, LEAD, 'the risky audit on the lead\'s top tier');
  const s3 = step();
  assert.equal(s3.fired.length, 0, 'not again inside minGapMin');
  c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { lastAudit: {} }));
  const s4 = step();
  assert.equal(s4.fired.length, 1); assert.deepEqual(s4.fired[0].ov, MID, 'the routine audit on the owner\'s mid-tier pair');
  const wakes = c.r('company/state/wakes.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(wakes.map(w => w.door), ['audit', 'audit']); assert.deepEqual(wakes.map(w => w.items[0].id), ['cat-1', 'ben-1']);
  const adm = c.r('company/state/admit-log.jsonl').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.door);
  assert.equal(adm.length, 2); assert.ok(adm.every(x => x.door === 'audit'), JSON.stringify(adm));
  assert.deepEqual(c.ledger().filter(x => x.op === 'auditrun').map(x => x.tier), ['risky', 'routine']);
  // a code department's audit is never on the MiniMax plan, even when the owner's pair says so: it waits
  c.w('company/departments.json', depts({ mode: 'live', since: '2026-11-01T00:00:00Z', audit: { routine: { provider: 'custom', model: 'MiniMax-M2' }, risky: null }, batch: { startAt: 1 } }));
  c.add('to-ben.md', ITEM('ben-2', 'Kwame', 'fix the lexer', '**Acceptance check:** the lexer tests pass\n')); c.tick();
  hb(c, { by: 'Ben', item: 'ben-2', note: 'ran the lexer tests, all green on my side', diff: DIFF });
  c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { lastAudit: {} }));
  allow([MID, LEAD, { provider: 'custom', model: 'MiniMax-M2' }]);
  const s5 = step();
  assert.equal(s5.fired.length, 0); assert.ok(s5.lines.some(l => /never audited on the MiniMax plan/.test(l)), s5.lines.join('\n'));
  // the override list offers the lead exactly the audit pairs, and nothing a router picked
  assert.deepEqual(c.js('AC.leadEntries("kwa")'), [{ provider: 'custom', model: 'MiniMax-M2' }, LEAD]);
  assert.deepEqual(c.js('require(' + JSON.stringify(path.join(TOOLS, 'lib', 'override-allow.js')) + ').auditModel("kwa", { K: null })'), [{ provider: 'custom', model: 'MiniMax-M2' }, LEAD]);
});

test('audit models are set only by the owner, never by the CEO, the dispatcher or a weekly suggestion; the class rules first; the switch is the owner\'s; check reports a missing lead', () => {
  const c = fixture({ acc: { mode: 'shadow' } });
  const dep = (argv, owner) => c.js('DEPT.run(' + JSON.stringify(argv) + ')', { owner });
  assert.match(dep(['accountable', 'eng', 'audit-model', 'routine', 'claude-cli/claude-sonnet-4-6@medium', '--by', 'Alex']).out.error, /only the owner sets the model a lead audits on/);
  assert.match(dep(['accountable', 'eng', 'audit-model', 'routine', 'claude-cli/claude-sonnet-4-6', '--by', 'routing-proposal']).out.error, /no router, weekly suggestion or ranking/);
  assert.match(dep(['accountable', 'eng', 'audit-model', 'routine', 'claude-cli/x', '--by', 'dispatcher']).out.error, /no router/);
  assert.match(dep(['accountable', 'eng', 'audit-model', 'routine', 'custom/MiniMax-M2', '--by', 'owner'], true).out.error, /never written on the MiniMax plan/);
  const ok = dep(['accountable', 'eng', 'audit-model', 'routine', 'claude-cli/claude-sonnet-4-6@medium', '--by', 'owner'], true);
  assert.equal(ok.code, 0, JSON.stringify(ok)); assert.deepEqual(ok.out.accountable.audit, { routine: MID, risky: null });
  assert.match(dep(['set-route', 'eng', 'audit', 'claude-cli/x', '--by', 'owner'], true).out.error, /class must be one of/, 'set-route (the routers\' one writer) cannot touch audits');
  assert.match(dep(['accountable', 'eng', 'live', '--by', 'Alex']).out.error, /only the owner switches/);
  assert.equal(dep(['accountable', 'eng', 'live', '--by', 'owner'], true).out.accountable.effective, 'live');
  assert.match(dep(['accountable', 'ops', 'shadow', '--by', 'owner'], true).out.error, /has no lead/);
  assert.match(dep(['accountable', 'eng', 'resume', '--by', 'dispatcher']).out.error, /only the owner resumes/);
  const wd = dep(['accountable', 'eng', 'withdraw', '--by', 'dispatcher', '--auto', '--why', 'cut 10% under 25%', '--hash', 'h1']);
  assert.equal(wd.code, 0, JSON.stringify(wd)); assert.equal(wd.out.accountable.effective, 'shadow');
  assert.equal(dep(['accountable', 'eng', 'resume', '--by', 'owner'], true).out.accountable.effective, 'live');
  c.w('company/departments.json', Object.assign(depts({ mode: 'live' }), {}));
  const d2 = JSON.parse(c.r('company/departments.json')); d2.departments[0].lead = null; c.w('company/departments.json', d2);
  assert.ok(dep(['check', '--json']).out.mismatches.some(m => m.code === 'ACCOUNTABLE_NO_LEAD'));
  assert.ok(c.js('require(' + JSON.stringify(path.join(TOOLS, 'lib', 'departments.js')) + ').validate({ departments: [{ id: "eng", name: "E", members: [], accountable: { mode: "maybe" } }] }, {})').some(p => p.code === 'BAD_ACCOUNTABLE'));
});

test('the scorecard on the lead: accepted, sent back, on time, cost per accepted item, escapes (a reopened accepted item is one, charged to the lead) and spot checks, in plain words', () => {
  const c = fixture({ acc: { mode: 'live', since: '2026-11-01T00:00:00Z', scorecard: { spotCheckEvery: 1 } } });
  c.tick();
  const mk = (id, seat, inbox, dl) => { c.add(inbox, ITEM(id, 'Kwame', 'job ' + id, '**Acceptance check:** its tests pass\n' + (dl ? '**Deadline:** ' + dl + '\n' : ''))); };
  mk('b1', 'ben', 'to-ben.md', '2099-01-01'); mk('b2', 'ben', 'to-ben.md', '2000-01-01'); mk('c1', 'cat', 'to-cat.md');
  c.tick();
  const ids = {};
  for (const [seat, it] of [['Ben', 'b1'], ['Ben', 'b2'], ['Cat', 'c1']]) ids[it] = hb(c, { by: seat, item: it, note: 'ran its tests, all green on my side', diff: DIFF }).id;
  c.js('AC.audit({ id: "' + ids.b1 + '", verdict: "ACCEPT", check: "diff vs its tests", by: "Kwame" })');
  c.js('AC.audit({ id: "' + ids.b2 + '", verdict: "ACCEPT", check: "diff vs its tests", by: "Kwame" })');
  c.js('AC.audit({ id: "' + ids.c1 + '", verdict: "REVISE", check: "diff vs its tests", findings: ["the cache key is wrong"], by: "Kwame" })');
  // runs booked to the items (a wake row naming the item, its run's cost)
  c.w('.starnet-data/workspaces/runs.jsonl', [{ runId: 'r1', agentId: 'ben', usd: 0.4, tokens: 1000 }, { runId: 'r2', agentId: 'kwa', usd: 0.2, tokens: 300 }].map(x => JSON.stringify(x)).join('\n') + '\n');
  c.w('company/state/wakes.jsonl', [{ at: Date.now(), wakeId: 'w1', seat: 'ben', runId: 'r1', door: 'dispatch', items: [{ file: 'to-ben.md', id: 'b1' }, { file: 'to-ben.md', id: 'b2' }] }, { at: Date.now(), wakeId: 'w2', seat: 'kwa', runId: 'r2', door: 'audit', items: [{ file: 'to-ben.md', id: 'b1' }] }].map(x => JSON.stringify(x)).join('\n') + '\n');
  // b1 reopened after the accept: an escape, charged to Kwame's review, once; the lead cannot record one against itself
  const ben = c.r('company/work/handoffs/to-ben.md');
  const parts = ben.split(/^(?=## )/m).map(s => /\*\*Id:\*\* b1\b/.test(s) ? s.replace(/^\*\*Status:\*\*.*$/m, '**Status:** OPEN — the parser broke again in production') : s);
  fs.writeFileSync(path.join(c.T, 'company/work/handoffs/to-ben.md'), parts.join(''));
  const t = c.tick(); c.tick();
  assert.ok(t.lines.some(l => /ACCOUNTABLE ESCAPE .* charged to the lead's review/.test(l)), t.lines.join('\n'));
  assert.match(c.js('AC.escape({ id: "' + ids.b2 + '", why: "nothing", by: "Kwame" })').error, /does not record escapes against its own review/);
  // spot checks (here every accept) go to the people function, who answers; the lead and the member cannot
  assert.match(c.r('company/work/handoffs/to-marisol.md'), new RegExp('\\*\\*Spot check:\\*\\* ' + ids.b2));
  assert.match(c.r('company/work/handoffs/to-marisol.md'), new RegExp('\\*\\*Spot check:\\*\\* ' + ids.b1));
  assert.match(c.js('AC.spot({ id: "' + ids.b2 + '", result: "agree", why: "x", by: "Kwame" })').error, /someone other than the lead/);
  assert.equal(c.js('AC.spot({ id: "' + ids.b2 + '", result: "disagree", why: "the deadline test is missing", by: "Marisol" })').ok, true);
  assert.match(c.r('company/work/handoffs/to-marisol.md'), /\*\*Status:\*\* DONE — disagree/);
  // the lead disputes the escape: it does not count until the people seat rules; upheld, it counts again
  assert.match(c.js('AC.dispute({ id: "' + ids.b1 + '", why: "x", by: "Ben" })').error, /only the one who accepted it/);
  const dp = c.js('AC.dispute({ id: "' + ids.b1 + '", why: "Ben reopened it to add a feature, not because it broke", by: "Kwame" })');
  assert.equal(dp.ok, true, JSON.stringify(dp)); assert.equal(dp.judge, 'mar');
  assert.match(c.r('company/work/handoffs/to-marisol.md'), /escape disputed:[\s\S]*accountable\.js ruling/);
  const sd = c.js('AC.scorecard({ dept: "eng" })');
  assert.equal(sd.escapes, 0); assert.equal(sd.disputedEscapes, 1);
  for (const l of sd.words) assert.deepEqual(wordsProblems(l), [], l);
  assert.match(sd.words.join(' '), /Kwame says 1 more problem was not a miss/);
  assert.match(c.js('AC.ruling({ id: "' + ids.b1 + '", result: "uphold", why: "x", by: "Kwame" })').error, /decided by Marisol/);
  assert.equal(c.js('AC.ruling({ id: "' + ids.b1 + '", result: "uphold", why: "the reopen names a parser crash", by: "Marisol" })').ok, true);
  const sc = c.js('AC.scorecard({ dept: "eng" })');
  assert.equal(sc.disputedEscapes, 0);
  assert.equal(sc.accepted, 2); assert.equal(sc.sentBack, 1); assert.equal(sc.sentBackRate, 0.3333);
  assert.deepEqual(sc.onTime, { onTime: 1, withDeadline: 2 });
  assert.equal(sc.escapes, 1); assert.deepEqual(sc.spotChecks, { done: 1, disagree: 1 });
  assert.equal(sc.costPerAccepted.usd, 0.3, 'r1 split over two items + the audit run on b1, over two accepted: (0.2 + 0.2 + 0.2) / 2');
  assert.equal(sc.costPerAccepted.auditUsd, 0.1);
  assert.ok(sc.words.length >= 4, JSON.stringify(sc.words));
  assert.match(sc.words.join(' '), /Kwame checked 3 finished jobs in the last 28 days: 2 accepted, 1 sent back to be fixed\./);
  assert.match(sc.words.join(' '), /1 problem was found later in work Kwame accepted; they count against Kwame's checking\./);
  for (const l of sc.words) assert.deepEqual(wordsProblems(l), [], l);
  const st = c.js('AC.status({})');
  assert.equal(st.departments.find(d => d.dept === 'eng').accepted, 2);
});

test('the saving: model-rank.js accountableEvaluation falls the department back when cost per accepted item is not cut enough against the lead alone, keeps it otherwise; the dispatcher withdraws once per hash and tells the owner plainly', () => {
  const MR = require(path.join(TOOLS, 'model-rank.js'));
  const K = { scoreCost: 'listUsd' };
  // items as the ranking scores them; whether the lead accepted one is read from the trusted audit ledger only
  let n = 0;
  const item = (seat, cls, cost, closed, typedAccept) => ({ seat, file: 'to-' + seat + '.md', id: seat + '-' + (++n), cell: { class: cls }, cost: { listUsd: cost }, oneShot: 1, closedAt: Date.parse(closed || '2026-11-10T00:00:00Z'), verdicts: typedAccept ? [{ by: 'kwa', fail: false, w: 0.5, word: 'ACCEPT' }] : [] });
  const handed = (it, verdict) => [{ op: 'handback', id: 'ac-' + it.id, at: 1, dept: 'eng', file: it.file, item: it.id, seat: it.seat }].concat(verdict ? [{ op: 'verdict', id: 'ac-' + it.id, at: 2, verdict, by: 'kwa' }] : []);
  const inp = rows => ({ departments: depts({ mode: 'live', since: '2026-11-01T00:00:00Z', scorecard: { minItems: 3 } }), deptSettings: null, now: Date.parse('2026-11-19T00:00:00Z'), accountableRows: rows });
  const run = (pathCost, extra) => {
    n = 0; extra = extra || {};
    const acc = [item('ben', 'code', pathCost), item('cat', 'code', pathCost), item('ben', 'code', pathCost)];
    const typed = item('ben', 'code', 99, null, true);   // a **Verdict:** ACCEPT typed into the inbox, no ledger row: not the pathway's
    const alone = [item('kwa', 'code', 1), item('kwa', 'code', 1), item('kwa', 'code', 100, '2020-01-01T00:00:00Z')];   // the last is outside the measured span
    const sentBack = extra.wasted != null ? [item('cat', 'code', extra.wasted)] : [];
    const rows = acc.flatMap(it => handed(it, 'ACCEPT')).concat(sentBack.flatMap(it => handed(it, 'REVISE').concat([{ op: 'drop', at: 3, ref: it.file + '#' + it.id }])));
    return MR.accountableEvaluation(inp(rows), { items: acc.concat([typed], alone, sentBack) }, K, { minItems: 10, expectedCut: 0.75, fallbackBelowCut: 0.25 }, () => true).departments[0];
  };
  const good = run(0.25);
  assert.equal(good.verdict, 'keep', JSON.stringify(good)); assert.equal(good.cut, 0.75); assert.equal(good.pathway.items, 3, 'only items the lead accepted in the ledger count as accepted');
  assert.equal(good.leadAlone.items, 2, 'the lead-alone side is limited to the measured span');
  const bad = run(0.9);
  assert.equal(bad.verdict, 'fall back'); assert.match(bad.reasons.join(), /cut cost per accepted item by 10%/);
  assert.equal(JSON.stringify(run(0.9)), JSON.stringify(bad), 'deterministic');
  // a job sent back and then dropped was paid for and never accepted: its cost counts against the pathway
  const wasted = run(0.25, { wasted: 2 });
  assert.equal(wasted.pathway.items, 3); assert.equal(wasted.pathway.notAccepted, 1); assert.equal(wasted.verdict, 'fall back', JSON.stringify(wasted));
  // the dispatcher's side: once per hash, withdrawn to recording only, the owner told in plain words
  const c = fixture();
  c.w('company/work/models/routing-evaluation.json', { accountable: { departments: [{ dept: 'eng', verdict: 'fall back', hash: 'sha256:abc', reasons: ['cut 10%'] }] } });
  const step = () => c.js('AC.auditStep({ jobs: [], log: () => {}, call: async () => ({ status: 200, body: "{}" }), fireRun: async () => ({ status: 500 }) })');
  assert.deepEqual(step().fellBack, ['eng']);
  assert.equal(JSON.parse(c.r('company/departments.json')).departments[0].accountable.withdrawn.by, 'auto');
  assert.deepEqual(step().fellBack, [], 'once per hash');
  const words = c.js('AC.fallbackWords("Kwame", "Engineering")');
  assert.deepEqual(wordsProblems(words), [], words);
});

test('the department card and the audit prompt: plain words, and a prompt byte-identical up to its last line', () => {
  const c = fixture();
  const a = c.js('AC.auditPrompt({ lead: "Kwame", deptId: "eng", deptName: "Engineering", ids: ["ac-1"] })'), b = c.js('AC.auditPrompt({ lead: "Kwame", deptId: "eng", deptName: "Engineering", ids: ["ac-2", "ac-3"] })');
  const head = s => s.slice(0, s.lastIndexOf('Open audits for you:'));
  assert.equal(head(a), head(b)); assert.match(a, /Open audits for you: ac-1 \(in your inbox\)\./);
  assert.match(a, /You will not: accept work you did not check[\s\S]*ask another senior model for a second opinion/);
});

test('the console: the scorecard route reads accountable.js status, the switch runs departments.js accountable as the owner, and nothing else', async () => {
  const routes = [], calls = [];
  require(path.join(REPO, 'console', 'departments.js')).mount((method, re, fn) => routes.push({ method, re, fn }), { runApi: async (tool, argv) => { calls.push([tool].concat(argv)); return tool === 'accountable.js' ? { departments: [{ dept: 'eng', words: ['x'] }] } : { ok: true }; }, bad: m => { throw new Error(m); }, owner: () => 'Olive' });
  const hit = (method, url, body) => { const r = routes.find(x => x.method === method && x.re.test(url)); return r.fn(url.match(r.re), {}, body); };
  assert.deepEqual((await hit('GET', '/api/departments/eng/scorecard')).scorecard, { dept: 'eng', words: ['x'] });
  await hit('POST', '/api/departments/eng/accountable', { mode: 'shadow' });
  await hit('POST', '/api/departments/eng/accountable', { resume: true });
  await assert.rejects(async () => hit('POST', '/api/departments/eng/accountable', { mode: 'audit-model' }), /mode must be/);
  assert.deepEqual(calls, [['accountable.js', 'status', '--json', '--dept', 'eng'], ['departments.js', 'accountable', 'eng', 'shadow', '--by', 'Olive'], ['departments.js', 'accountable', 'eng', 'resume', '--by', 'Olive']]);
  const W = await import(path.join(REPO, 'console', 'ui', 'js', 'screens', 'crew-departments-words.js'));
  for (const l of [W.CHECK_LABEL, W.checkLine('Kwame'), W.checkOnConfirm('Kwame'), W.checkStoppedLine({ by: 'auto' }, 'Kwame', 'Engineering'), W.SCORE_TITLE]) assert.deepEqual(wordsProblems(l), [], l);
});

/* ---------------- the 2026-11-19 review of accountable leads (blocking B1-B5, should-fix 1-8) ---------------- */
const setStatusIn = (c, inbox, id, status) => { const f = path.join(c.T, 'company/work/handoffs', inbox); const parts = fs.readFileSync(f, 'utf8').split(/^(?=## )/m).map(s => new RegExp('\\*\\*Id:\\*\\* ' + id + '\\b').test(s) ? s.replace(/^\*\*Status:\*\*.*$/m, '**Status:** ' + status) : s); fs.writeFileSync(f, parts.join('')); };
const H = 3600e3;

test('B1: switching recording only -> on takes a fresh baseline: nothing handled while recording only is reopened or locked; off -> on the same', () => {
  const c = fixture({ acc: { mode: 'shadow' } });
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n'));
  c.add('to-ben.md', ITEM('ben-2', 'Kwame', 'fix the lexer', '**Acceptance check:** the lexer tests pass\n'));
  c.tick();
  assert.equal(hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF }).delivered, false);
  setStatusIn(c, 'to-ben.md', 'ben-1', 'DONE — done'); setStatusIn(c, 'to-ben.md', 'ben-2', 'DONE — done');
  c.tick();
  c.w('company/departments.json', depts({ mode: 'live', since: '2026-11-19T00:00:00Z', by: 'owner' }));
  const t = c.tick(); c.tick();
  assert.ok(t.lines.some(l => /on from now \(was recording only\); the work already there is left as it was/.test(l)), t.lines.join('\n'));
  assert.ok(!c.r('company/work/dispatch-log.md').includes('DONE HELD') && !t.lines.some(l => /DONE HELD/.test(l)), 'nothing from before is reopened');
  assert.equal((c.r('company/work/handoffs/to-ben.md').match(/\*\*Status:\*\* DONE — done/g) || []).length, 2);
  // the recording-only hand-back is never something to wait for: the item reopened later can be handed back
  setStatusIn(c, 'to-ben.md', 'ben-1', 'OPEN');
  const r = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests again, all green on my side', diff: DIFF });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.delivered, true);
  // off -> on: work finished while it was off is not reopened either
  c.add('to-ben.md', ITEM('ben-4', 'Kwame', 'fix the printer', '**Acceptance check:** the printer tests pass\n'));
  c.tick();
  c.w('company/departments.json', depts(null)); c.tick();
  setStatusIn(c, 'to-ben.md', 'ben-4', 'DONE — finished while it was off');
  c.tick();
  c.w('company/departments.json', depts({ mode: 'live', since: '2026-11-19T00:00:00Z', by: 'owner' }));
  const t2 = c.tick(); c.tick();
  assert.ok(t2.lines.some(l => /on from now \(was off\)/.test(l)), t2.lines.join('\n'));
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* DONE — finished while it was off/);
});

test('B2 + should-fix 3: a typed "Passed on by" line or an FYI that asks for something is still held; only the lead\'s recorded pass releases; a block to the people seat is never held', () => {
  const c = fixture();
  c.tick();
  c.add('to-dan.md', ITEM('dan-1', 'Ben', 'deploy the new parser', '**Passed on by:** Kwame (lead of Engineering, accountable for it)\n'));
  c.add('to-dan.md', '\n## 2026-11-19 from Ben — FYI the parser can ship today\n**Id:** dan-2\n**FYI:** for your records\n**Need:** deploy it tonight\n**Status:** OPEN\n');
  c.add('to-dan.md', '\n## 2026-11-19 from Ben — FYI the parser is faster now\n**Id:** dan-3\n**FYI:** nothing to do\n**Status:** OPEN\n');
  c.add('to-marisol.md', ITEM('mar-1', 'Ben', 'I want to talk about how Kwame reviews my work'));
  const h = c.tick().holds;
  assert.deepEqual(h['to-dan.md | 2026-11-19 from Ben — deploy the new parser'], { who: 'Kwame', kind: 'pass' }, 'a typed pass-on line counts for nothing');
  assert.deepEqual(h['to-dan.md | 2026-11-19 from Ben — FYI the parser can ship today'], { who: 'Kwame', kind: 'pass' }, 'an FYI with a Need is held');
  assert.ok(!h['to-dan.md | 2026-11-19 from Ben — FYI the parser is faster now'], 'an FYI that asks for nothing goes');
  assert.ok(!h['to-marisol.md | 2026-11-19 from Ben — I want to talk about how Kwame reviews my work'], 'the people seat hears a member directly');
  assert.equal(c.js('AC.pass({ ref: "to-dan.md#dan-1", by: "Kwame" })').passed, true);
  assert.ok(!c.tick().holds['to-dan.md | 2026-11-19 from Ben — deploy the new parser'], 'released by the recorded pass');
  assert.equal(c.js('AC.fyiOnly("**FYI:** x\\n**Need:** do it", "FYI x")'), false);
});

test('B5: work from a writer nobody can tell, and a member\'s own item, go through the lead like work sent straight to the member', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Olive', 'update the price list', '**Acceptance check:** the prices match the sheet\n'));
  c.add('to-ben.md', ITEM('ben-2', 'Ben', 'tidy my notes', '**Acceptance check:** the notes read cleanly\n'));
  c.add('to-ben.md', '\n## a heading that names nobody\n**Id:** ben-3\n**Status:** DONE — done before anyone looked\n');
  c.tick();
  const intake = Object.fromEntries(c.ledger().filter(x => x.op === 'intake').map(x => [x.ref, x.via]));
  assert.deepEqual(intake, { 'to-ben.md#ben-1': 'direct', 'to-ben.md#ben-2': 'own', 'to-ben.md#ben-3': 'direct' });
  const lead = c.r('company/work/handoffs/to-kwame.md');
  assert.match(lead, /copy: update the price list \(sent straight to Ben\)[\s\S]*Someone the crew could not identify sent this straight to Ben/);
  assert.match(lead, /copy: tidy my notes \(Ben's own item\)[\s\S]*Ben wrote this for themselves/);
  const ben = c.r('company/work/handoffs/to-ben.md');
  assert.equal((ben.match(/\*\*Hand back:\*\* to Kwame/g) || []).length, 2);
  assert.match(ben, /a heading that names nobody[\s\S]*\*\*Status:\*\* OPEN — not done until Kwame accepts it/, 'an item that arrives DONE is held too');
  setStatusIn(c, 'to-ben.md', 'ben-1', 'DONE — done'); setStatusIn(c, 'to-ben.md', 'ben-2', 'DONE — done');
  c.tick();
  assert.equal((c.r('company/work/handoffs/to-ben.md').match(/OPEN — not done until Kwame accepts it/g) || []).length, 3);
});

test('B3 (from the code): a hand-back with a PR from the item\'s own **PR:** line needs the commit too', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n**PR:** acme/shop#12\n'));
  c.tick();
  assert.match(hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF }).error, /has a pull request \(acme\/shop#12\)[\s\S]*--sha <head>/);
});

test('B4: an audit that waits is put to the CEO after stallHours in one plain line (and to the owner when the cause is the owner\'s); the CEO may then answer or drop it; a missing routine says so', () => {
  const c = fixture({ acc: { mode: 'live', since: '2026-11-01T00:00:00Z', batch: { startAt: 1, minGapMin: 5, maxWaitMin: 15 } } });
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n'));
  c.add('to-ben.md', ITEM('ben-2', 'Kwame', 'fix the lexer', '**Acceptance check:** the lexer tests pass\n'));
  c.tick();
  const a = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF });
  const b = hb(c, { by: 'Ben', item: 'ben-2', note: 'ran the lexer tests, all green on my side', diff: DIFF });
  const step = (jobs, now) => c.js('(async () => { const lines = []; const r = await AC.auditStep({ now: ' + now + ', jobs: ' + JSON.stringify(jobs) + ', log: l => lines.push(l), call: async () => ({ status: 500, body: "{}" }), fireRun: async () => ({ status: 200, body: "{\\"runId\\":\\"r\\"}" }), budget: { capOn: false, unmetered: ["claude-cli"], byAgent: {} } }); return { r, lines }; })()');
  // the routine could not be made (the station refuses): said, not silent
  const s0 = step([], Date.now());
  assert.ok(s0.lines.some(l => /AUDIT HOLD Kwame: the audit routine is missing/.test(l)), s0.lines.join('\n'));
  assert.ok(!/waiting for Kwame/.test(c.r('company/work/handoffs/to-alex.md')), 'not yet: under stallHours');
  // the routine exists, the lead's model is shut: the audit waits; after 6 hours the CEO and the owner are told once
  c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { routines: { eng: { jobId: 'j-audit', lead: 'kwa', name: 'Kwame lead audit' } } }));
  c.w('company/state/override-allow.json', { v: 1, at: Date.now(), by: 'dispatcher', agents: { kwa: [] } });
  const jobs = [{ id: 'j-audit', name: 'Kwame lead audit', prompt: 'x\nOpen audits for you: (none)\n' }];
  const later = Date.now() + 7 * H;
  const s1 = step(jobs, later);
  assert.ok(s1.lines.some(l => /AUDIT HOLD Kwame \(routine/.test(l)), s1.lines.join('\n'));
  assert.ok(s1.lines.some(l => /ACCOUNTABLE STALLED .*told Alex and the owner/.test(l)), s1.lines.join('\n'));
  const ceo = c.r('company/work/handoffs/to-alex.md');
  assert.match(ceo, /2 jobs have waited 7 hours for Kwame's check: Kwame's model is closed right now\./);
  assert.match(ceo, /answer in Kwame's place[\s\S]*--by Alex/);
  const owner = c.r('company/owner/digest.jsonl') + c.r('company/owner/outbound.jsonl');
  assert.match(owner, /2 jobs have waited 7 hours for Kwame's check: Kwame's model is closed right now/);
  assert.deepEqual(wordsProblems("2 jobs have waited 7 hours for Kwame's check: Kwame's model is closed right now."), []);
  step(jobs, later + H);
  assert.equal((c.r('company/work/handoffs/to-alex.md').match(/waiting for Kwame's check/g) || []).length, 1, 'told once');
  assert.equal(c.ledger().filter(x => x.op === 'stalled').length, 2);
  // the CEO answers one in Kwame's place and drops the other; Dan cannot
  assert.match(c.js('AC.audit({ id: "' + a.id + '", verdict: "ACCEPT", check: "x", by: "Dan" })').error, /only the lead/);
  const v = c.js('AC.audit({ id: "' + a.id + '", verdict: "ACCEPT", check: "the diff against the parser tests", by: "Alex" })');
  assert.equal(v.ok, true, JSON.stringify(v)); assert.match(v.line, /ACCEPT by Alex \(in Kwame's place: the check waited too long\)/);
  const d = c.js('AC.drop({ ref: "to-ben.md#ben-2", why: "not needed any more", by: "Alex" })');
  assert.equal(d.ok, true, JSON.stringify(d)); assert.deepEqual(d.closed, [b.id]);
  assert.match(c.r('company/work/handoffs/to-ben.md'), /\*\*Status:\*\* DONE — dropped by Alex/);
  assert.match(c.js('AC.audit({ id: "' + b.id + '", verdict: "ACCEPT", check: "x", by: "Kwame" })').error, /was dropped/);
  assert.equal(c.js('AC.status({})').departments.find(x => x.dept === 'eng').openAudits, 0, 'nothing waits any more');
  // before an audit has stalled, the CEO cannot answer in the lead's place
  c.add('to-ben.md', ITEM('ben-5', 'Kwame', 'fix the reader', '**Acceptance check:** the reader tests pass\n')); c.tick();
  const e5 = hb(c, { by: 'Ben', item: 'ben-5', note: 'ran the reader tests, all green on my side', diff: DIFF });
  assert.match(c.js('AC.audit({ id: "' + e5.id + '", verdict: "ACCEPT", check: "x", by: "Alex" })').error, /only once the check has waited too long/);
});

test('B4: an item with no acceptance check is put to the lead after stallHours and to the CEO after twice that, once each', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'tidy the build'));
  c.tick();
  c.tick('now: ' + (Date.now() + 7 * H));
  assert.match(c.r('company/work/handoffs/to-kwame.md'), /acceptance check needed: tidy the build \(Ben\)[\s\S]*has had no acceptance check for 7 hours/);
  assert.ok(!/waiting for an acceptance check/.test(c.r('company/work/handoffs/to-alex.md')));
  c.tick('now: ' + (Date.now() + 13 * H)); c.tick('now: ' + (Date.now() + 14 * H));
  assert.equal((c.r('company/work/handoffs/to-alex.md').match(/waiting for an acceptance check: tidy the build/g) || []).length, 1);
  assert.equal((c.r('company/work/handoffs/to-kwame.md').match(/acceptance check needed: tidy the build/g) || []).length, 1);
});

test('should-fix 1 + 2: a code department needs a check that runs; a changed check command is shown to the lead; a routine mark the member added never lowers the tier', () => {
  const c = fixture();
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n**Check command:** `test -f nowhere.flag`\n'));
  c.add('to-ben.md', ITEM('ben-2', 'Kwame', 'fix the payment page', '**Acceptance check:** the page tests pass\n'));
  c.add('to-cat.md', ITEM('cat-1', 'Kwame', 'fix the payment footer', '**Acceptance check:** the footer tests pass\n**Risk:** routine\n'));
  c.tick();
  assert.match(hb(c, { by: 'Ben', item: 'ben-2', note: 'trust me it is all fine really', diff: DIFF, testCmds: [] }).error, /code work needs a self-check that runs/);
  // Ben edits the item's check command to one that always passes: it goes through, and Kwame sees it changed
  const f = path.join(c.T, 'company/work/handoffs/to-ben.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('`test -f nowhere.flag`', '`true`'));
  const r = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF, testCmds: [] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(c.r('company/work/handoffs/to-kwame.md'), /\*\*Changed since it was assigned:\*\* the check command was `test -f nowhere\.flag` when the item came in/);
  assert.deepEqual(c.ledger().find(x => x.op === 'handback' && x.id === r.id).changed, ['check command']);
  // a routine mark Ben added himself: ignored (the item mentions payment: risky)
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('**Acceptance check:** the page tests pass\n', '**Acceptance check:** the page tests pass\n**Risk:** routine\n'));
  assert.equal(hb(c, { by: 'Ben', item: 'ben-2', note: 'ran the page tests, all green on my side', diff: DIFF }).tier, 'risky');
  // the routine mark Kwame wrote when he assigned it: honoured for the words, never over a risky path
  assert.equal(hb(c, { by: 'Cat', item: 'cat-1', note: 'ran the footer tests, all green on my side', diff: DIFF }).tier, 'routine');
});

test('should-fix 1b: a risky path stays risky under a trusted routine mark', () => {
  const c = fixture();
  c.tick();
  c.add('to-cat.md', ITEM('cat-1', 'Kwame', 'tidy the CI file', '**Acceptance check:** CI passes\n**Risk:** routine\n'));
  c.tick();
  const r = hb(c, { by: 'Cat', item: 'cat-1', note: 'ran CI locally, all green on my side', diff: DIFF.replace(/src\/parse\.js/g, '.github/workflows/ci.yml') });
  assert.equal(r.tier, 'risky'); assert.ok(r.riskWhy.some(x => /\.github/.test(x)), JSON.stringify(r.riskWhy));
});

test('should-fix 4 + 5: the lead\'s message to the CEO that asks for anything needs a reason; a "Pass on" block waits for the audit run, not the lead\'s loop', () => {
  const c = fixture();
  c.tick();
  c.add('to-alex.md', ITEM('alex-1', 'Kwame', 'need a decision on the parser rewrite'));
  c.add('to-alex.md', '\n## 2026-11-19 from Kwame — FYI the weekly numbers\n**Id:** alex-2\n**FYI:** nothing to do\n**Status:** OPEN\n');
  c.add('to-dan.md', ITEM('dan-1', 'Ben', 'deploy the new parser'));
  c.tick();
  c.w('company/state/accountable-state.json', Object.assign(JSON.parse(c.r('company/state/accountable-state.json')), { routines: { eng: { jobId: 'j-audit', lead: 'kwa', name: 'Kwame lead audit' } } }));
  const h = c.tick().holds;
  assert.deepEqual(h['to-alex.md | 2026-11-19 from Kwame — need a decision on the parser rewrite'], { who: 'Kwame', kind: 'escalation' });
  assert.ok(!h['to-alex.md | 2026-11-19 from Kwame — FYI the weekly numbers'], 'an FYI report goes');
  const k = Object.keys(h).find(x => /^to-kwame\.md \| .*Pass on: deploy the new parser/.test(x));
  assert.ok(k, JSON.stringify(h)); assert.equal(h[k].kind, 'pass-packet');
  assert.equal(c.js('AC.readsAsEscalation("2026-11-19 from Kwame — status", "**Status:** OPEN")'), false);
});

test('should-fix 6: a new item that fixes accepted work is an escape; spot checks are picked by the audit id, not every Nth in order', () => {
  const c = fixture({ acc: { mode: 'live', since: '2026-11-01T00:00:00Z', scorecard: { spotCheckEvery: 0 } } });
  c.tick();
  c.add('to-ben.md', ITEM('ben-1', 'Kwame', 'fix the parser', '**Acceptance check:** the parser tests pass\n'));
  c.tick();
  const id = hb(c, { by: 'Ben', item: 'ben-1', note: 'ran the parser tests, all green on my side', diff: DIFF }).id;
  c.js('AC.audit({ id: "' + id + '", verdict: "ACCEPT", check: "the diff against the parser tests", by: "Kwame" })');
  c.add('to-cat.md', ITEM('cat-1', 'Dan', 'fix the parser crash on empty lines', '**Fixes:** ben-1\n'));
  c.add('to-cat.md', ITEM('cat-2', 'Dan', 'fix the docs typo'));
  const t = c.tick(); c.tick();
  assert.ok(t.lines.some(l => new RegExp('ACCOUNTABLE ESCAPE ' + id + ' to-ben\\.md#ben-1: to-cat\\.md#cat-1 fixes work Kwame accepted').test(l)), t.lines.join('\n'));
  assert.equal(c.ledger().filter(x => x.op === 'escape').length, 1, 'once, and an unrelated fix is not one');
  assert.equal(c.js('AC.scorecard({ dept: "eng" })').escapes, 1);
  // the pick: deterministic per id, about 1 in N, never "every Nth accept in order"
  const picks = c.js('Array.from({ length: 2000 }, (_, i) => AC.spotPicked("ac-x-" + i, 10)).filter(Boolean).length');
  assert.ok(picks > 140 && picks < 260, String(picks));
  assert.equal(c.js('AC.spotPicked("ac-1", 10) === AC.spotPicked("ac-1", 10)'), true);
  assert.equal(c.js('AC.spotPicked("ac-1", 1)'), true);
});

test('should-fix 8: with no cheaper setup chosen for everyday checks the card says the saving will not show yet, in plain words', () => {
  const c = fixture();
  const w = c.js('AC.scorecard({ dept: "eng" })').words;
  const line = w.find(l => /cheaper one for everyday checks/.test(l));
  assert.ok(line, JSON.stringify(w)); assert.deepEqual(wordsProblems(line), [], line);
  const c2 = fixture({ acc: { mode: 'live', since: '2026-11-01T00:00:00Z', audit: { routine: MID, risky: null } } });
  assert.ok(!c2.js('AC.scorecard({ dept: "eng" })').words.some(l => /cheaper one/.test(l)));
});
