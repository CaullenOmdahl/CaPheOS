#!/usr/bin/env node
/* owner-asks-safety.test.js — regression tests for the owner-asks safety review (2026-11-18): the proofs of concept that
 * showed an owner's "no" becoming a go-ahead, a card from an agent's own script carrying owner authority, and one click
 * installing a hand-written background job. Each case runs the real tools in a throwaway company (child processes, so
 * every one has its own CAPHEOS_ROOT); nothing reaches a station, systemd or a network port.
 *
 *   B1  a fixed-gate change the owner said no to, proposed again: refused, never applied (harness-change.js); a service the
 *       owner declined, re-proposed with a small change, or covered by a never-ask ruling: not installed (service.js)
 *   B2  an effect is kept only on a card the owning tool recorded (an agent script's card, from outside the root or
 *       inside it, keeps its words but not its effect); effect kinds with no producer are refused; the console names
 *       every parameter; an asker's update never changes the effect; a yes applies only the card as shown (cardDigest)
 *   B3  service.js owner-approve re-validates a hand-written registry entry and refuses it
 *   S1  a ruling never hides a key request or the money hold's question (console), nor refuses a key request (inbox.js)
 *   S2  a loose ruling cannot hand an outside-the-safe-profile service to the crew
 *   S3  a second urgent notice the same day still goes out
 *   S4  a standing-rules file with no owner-side provenance (hand-made, or written from an agent's run) is not read
 *   S5  a one-seat company with harnessSelfEdit on never applies a protected tool unreviewed
 *   S6  the code that decides what reaches the owner is owner-gated and locked
 *   and the watchdog keeps its alert id.
 *
 *   node --test company/tools/tests/owner-asks-safety.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-asks-safety-scripts-'));   // helpers live outside every company
const roots = [SCRIPTS];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const W = (root, rel, v) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); return f; };
const STATION_ENV = ['STARNET_USER_CONTROL_MODE', 'STARNET_COMPUTER_DRIVER', 'STARNET_MCP_STDIO', 'STARNET_AGENT_ID', 'OWNER_DIR', 'PM_INBOX_FILE', 'GOVERNANCE_ROOT', 'CONSOLE_PORT'];
function envFor(T, extra) { const e = Object.assign({}, process.env, { REPO, T, CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }, extra || {}); for (const k of STATION_ENV) delete e[k]; return e; }
let nScript = 0;
/* run(T, code, {file}) -> the JSON the script printed last. `file`: where the script lives (a path that matters to the guard) */
function run(T, code, o) {
  const f = (o && o.file) || path.join(SCRIPTS, 's' + (++nScript) + '.js');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "'use strict';\nconst fs = require('fs'), path = require('path');\nconst REPO = process.env.REPO, T = process.env.T;\nconst out = o => console.log(JSON.stringify(o));\n" + code);
  const r = spawnSync(process.execPath, [f], { env: envFor(T, o && o.env), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'script failed: ' + r.stderr + r.stdout);
  const last = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(last); } catch (_) { throw new Error('no JSON from the script: ' + r.stdout + r.stderr); }
}
function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-asks-safety-')); roots.push(T);
  W(T, 'company/company.json', { name: 'OC', slug: 'oc', owner: { name: 'Pat Owner' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  W(T, 'company/tools/loops.json', { agents: o.agents || {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' },
    designer: { name: 'Jo', manager: 'agent', inbox: 'to-jo.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' },
    auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    sam: { name: 'Sam Lee', manager: 'agent', inbox: 'to-sam.md' } } });
  fs.mkdirSync(path.join(T, 'company', 'work', 'handoffs'), { recursive: true });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8'));
  Object.assign(g.categories, o.levels || {});
  W(T, 'company/defaults/state/governance.json', g); W(T, 'company/state/governance.json', g);
  W(T, 'company/defaults/state/guardrails.json', fs.readFileSync(path.join(REPO, 'company/defaults/state/guardrails.json'), 'utf8'));
  if (o.strict) W(T, '.pm-inbox-guard-strict', '');
  if (o.fixture) W(T, '.capheos-selftest-fixture', '');
  return T;
}
// a fake service manager for service.js (every call kept in calls.log)
const SVC_CTX = `
const S = require(path.join(REPO, 'company/tools/service.js'));
const calls = [];
const svcOpts = x => Object.assign({ root: T, unitDir: path.join(T, 'units'), transientDir: path.join(T, 'transient'), systemctl: a => { calls.push(a.join(' ')); return { code: 0, out: '', err: '' }; },
  journal: () => '', isAgent: () => true, ownerShell: () => false, guard: () => true, halted: () => false, callerConflict: () => null }, x || {});
const tryIt = fn => { try { return { ok: true, r: fn() }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const units = () => { try { return fs.readdirSync(path.join(T, 'units')); } catch (_) { return []; } };
const G = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js'));
const INBOX = path.join(T, 'company/pm-inbox.jsonl');
const ownerSays = (id, v) => G.append(INBOX, { type: 'answer', id, at: new Date().toISOString(), by: 'owner', a: v, answer: { verdict: v } }, 'console', { root: T });
`;

/* ---------------- B1 ---------------- */
test('B1: a fixed-gate change the owner said no to, proposed again, is refused and never applied (poc-harness)', () => {
  const T = company({ levels: { tools: 'approve' }, fixture: true });
  W(T, 'company/tools/external-gate.js', "'use strict';\nmodule.exports = {};\n");
  const r = run(T, `
const P = require(path.join(REPO, 'company/tools/provenance.js')); P.pinUnderStation(false);
const H = require(path.join(REPO, 'company/tools/harness-change.js'));
const G = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js'));
const INBOX = path.join(T, 'company/pm-inbox.jsonl');
const C = () => H.context({ root: T, underStation: true, ownerShell: false, skipSelftest: true, call: async () => ({ status: 200, body: '{}' }) });
(async () => {
  const change = "'use strict';\\n// open\\nmodule.exports = {};\\n";
  const r1 = await H.propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'open the external gate a crack for my sends', change, by: 'Jo' });
  H.review(C(), r1.id, { by: 'Riley' }, 'approve'); H.review(C(), r1.id, { by: 'Max' }, 'approve');
  const ask = G.rows({ file: INBOX, noAlert: true }).find(x => x.type === 'ask' && x.gate && x.gate.ref === 'harness-review:' + r1.id);
  G.append(INBOX, { type: 'answer', id: ask.id, at: new Date().toISOString(), by: 'owner', a: 'no', answer: { verdict: 'no' } }, 'console', { root: T });
  await H.tick({ root: T, underStation: true, ownerShell: false, skipSelftest: true, log: () => {}, call: async () => ({ status: 200, body: '{}' }) });
  const rec = id => JSON.parse(fs.readFileSync(path.join(T, 'company/work/changes', id + '.json'), 'utf8'));
  const r2 = await H.propose(C(), { kind: 'tool', target: 'company/tools/external-gate.js', why: 'open the external gate a crack, second try', change, by: 'Jo' });
  H.review(C(), r2.id, { by: 'Riley' }, 'approve'); H.review(C(), r2.id, { by: 'Max' }, 'approve');
  let applied = null; try { await H.applyChange(C(), r2.id, { by: 'Max' }); applied = true; } catch (e) { applied = e.message; }
  out({ firstCard: !!ask, r1: rec(r1.id).status, r2: rec(r2.id).status, waived: rec(r2.id).ownerWaived || null, applied, opened: fs.readFileSync(path.join(T, 'company/tools/external-gate.js'), 'utf8').includes('// open') });
})().catch(e => { console.error(e); process.exit(1); });`);
  assert.equal(r.firstCard, true); assert.equal(r.r1, 'rejected');
  assert.equal(r.waived, null, 'the owner\'s "not now" is never a waiver: ' + JSON.stringify(r.waived));
  assert.equal(r.r2, 'rejected', 'the second try is refused');
  assert.notEqual(r.applied, true); assert.equal(r.opened, false, 'the fixed-gate file is unchanged');
});

test('B1: a declined service re-proposed with a small change, or covered by a never-ask ruling, is not installed', () => {
  const T = company({ levels: { schedules: 'approve' } });
  W(T, 'company/work/job.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
require(path.join(REPO, 'company/tools/provenance.js')).pinUnderStation(false);
const spec = x => Object.assign({ by: 'sam', kind: 'timer', exec: 'python3 company/work/job.py', every: '1h', why: 'collects the shop numbers each hour' }, x || {});
// outside the safe profile (it may use any website): the owner is asked, and says no
const a = tryIt(() => S.propose(S.context(svcOpts()), 'nightly', spec()));
ownerSays(a.r.questionId, 'no');
// the same job with a little less memory: a new spec, so a new card would be needed; the owner's no must stand
const b = tryIt(() => S.propose(S.context(svcOpts()), 'nightly', spec({ memory: '256M' })));
// inside the safe profile, but the owner's standing rule says never ask about it: the default (no) stands
const R = require(path.join(REPO, 'company/tools/lib/owner-rulings.js'));
const added = R.add({ by: 'owner', text: 'Never ask me about the tidy job.', effect: 'never-ask', scope: { topics: ['tidy'] } }, { root: T, shell: () => true });
const c = tryIt(() => S.propose(S.context(svcOpts()), 'tidy', spec({ network: 'none', why: 'tidies the shop notes once an hour' })));
const reg = JSON.parse(fs.readFileSync(path.join(T, 'company/state/services.json'), 'utf8')).services;
out({ a: a.ok && a.r.waiting, b, c, added: added.ok, nightly: reg.nightly.status, tidy: reg.tidy && reg.tidy.status, units: units(), calls });`);
  assert.equal(r.a, true); assert.equal(r.added, true);
  assert.equal(r.b.ok, false, 'the re-proposal is refused: ' + JSON.stringify(r.b)); assert.equal(r.b.code, 3);
  assert.equal(r.c.ok, false, 'never-ask is a no: ' + JSON.stringify(r.c)); assert.equal(r.c.code, 3);
  assert.notEqual(r.nightly, 'installed'); assert.notEqual(r.tidy, 'installed');
  assert.deepEqual(r.units, []); assert.deepEqual(r.calls, []);
});

test('B1: only crew, digest or a crew-decides ruling is covered; a "not now" and a never-ask ruling are refused', () => {
  const card = require(path.join(REPO, 'company/tools/lib/owner-card.js'));
  assert.equal(card.coveredByCrew({ filed: false, route: 'crew' }), true);
  assert.equal(card.coveredByCrew({ filed: false, route: 'digest' }), true);
  assert.equal(card.coveredByCrew({ filed: false, route: 'ruling', ruling: { effect: 'crew-decides' } }), true);
  assert.equal(card.coveredByCrew({ filed: false, route: 'ruling', ruling: { effect: 'never-ask' } }), false);
  assert.equal(card.coveredByCrew({ filed: false, route: 'ruling', backoff: { id: 'q-1' } }), false);
  assert.equal(card.coveredByCrew({ filed: false, route: 'declined', backoff: { id: 'q-1' } }), false);
  assert.equal(card.refusedByOwner({ filed: false, route: 'declined' }), true);
  assert.equal(card.refusedByOwner({ filed: false, route: 'ruling', ruling: { effect: 'never-ask' } }), true);
  assert.equal(card.refusedByOwner({ filed: false, route: 'duplicate' }), false);
});

/* ---------------- B2 ---------------- */
