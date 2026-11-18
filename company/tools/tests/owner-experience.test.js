#!/usr/bin/env node
/* owner-experience.test.js — regression tests for the owner-experience review (2026-11-18): what a non-technical owner
 * reads and is asked. Each case runs the real tools in a throwaway company (child processes, so each has its own
 * CAPHEOS_ROOT); nothing reaches a station, systemd or a network port.
 *
 *   B1  background jobs have no network unless they ask; a website goes through the `external` level (an allowlisted
 *       one at external=auto is not asked); the owner is never told a job reaches "only" some websites; crew guidance
 *       says how to declare them
 *   B2  "Make this a standing rule" works on a background-job card, is not offered where it cannot work (the money
 *       hold, a guardrail's card), and never shows an internal identifier
 *   B3  the notice plain check uses the card's patterns; every real sender template reads plainly; nothing is
 *       swallowed and Today never shows "noted something technical"
 *   B4  every instruction to the owner has a console control (undo, practice mode, add-on install, protected-file
 *       accept, add-on switch-on, model trials)
 *   B5  an FYI never lands in Needs you, and the daily message never contradicts Today
 *   and the jargon list and M-items (M1 makers-only changes, M2 "API" alone, M3 names).
 *
 *   node --test company/tools/tests/owner-experience.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exp-scripts-'));
const roots = [SCRIPTS];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const W = (root, rel, v) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n'); return f; };
const STATION_ENV = ['STARNET_USER_CONTROL_MODE', 'STARNET_COMPUTER_DRIVER', 'STARNET_MCP_STDIO', 'STARNET_AGENT_ID', 'OWNER_DIR', 'PM_INBOX_FILE', 'GOVERNANCE_ROOT', 'CONSOLE_PORT', 'CAPHEOS_NOTICE_STRICT'];
function envFor(T, extra) { const e = Object.assign({}, process.env, { REPO, T, CAPHEOS_ROOT: T, PROVENANCE_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' }, extra || {}); for (const k of STATION_ENV) if (!(extra && k in extra)) delete e[k]; return e; }
let nScript = 0;
/* run(T, code) -> the JSON the script printed last */
function run(T, code, o) {
  const f = path.join(SCRIPTS, 's' + (++nScript) + '.js');
  fs.writeFileSync(f, "'use strict';\nconst fs = require('fs'), path = require('path');\nconst REPO = process.env.REPO, T = process.env.T;\nconst out = o => console.log(JSON.stringify(o));\n" +
    "try { require(path.join(REPO, 'company/tools/provenance.js')).pinUnderStation(false); } catch (_) {}\n" + code);
  const r = spawnSync(process.execPath, [f], { env: envFor(T, o && o.env), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'script failed: ' + r.stderr + r.stdout);
  const last = r.stdout.trim().split('\n').pop();
  try { return JSON.parse(last); } catch (_) { throw new Error('no JSON from the script: ' + r.stdout + r.stderr); }
}
function company(o) {
  o = o || {};
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-exp-')); roots.push(T);
  W(T, 'company/company.json', { name: 'OC', slug: 'oc', owner: { name: 'Pat Owner' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
  W(T, 'company/tools/loops.json', { agents: o.agents || {
    agent: { name: 'Alex', manager: null, functions: ['ceo'], inbox: 'to-alex.md' },
    engineer: { name: 'Max', manager: 'agent', functions: ['tools'], inbox: 'to-max.md' },
    auditor: { name: 'Riley', manager: 'agent', functions: ['risk'], inbox: 'to-riley.md' },
    people: { name: 'nadia farrell', manager: 'agent', functions: ['people'], inbox: 'to-nadia.md' },
    sam: { name: 'Sam Lee', manager: 'agent', inbox: 'to-sam.md' } } });
  fs.mkdirSync(path.join(T, 'company', 'work', 'handoffs'), { recursive: true });
  const g = JSON.parse(fs.readFileSync(path.join(REPO, 'company/defaults/state/governance.json'), 'utf8'));
  Object.assign(g.categories, o.levels || {});
  W(T, 'company/defaults/state/governance.json', g); W(T, 'company/state/governance.json', g);
  W(T, 'company/defaults/state/guardrails.json', fs.readFileSync(path.join(REPO, 'company/defaults/state/guardrails.json'), 'utf8'));
  if (o.allowlist) W(T, 'company/state/external-allowlist.txt', o.allowlist.join('\n') + '\n');
  return T;
}
// a fake service manager for service.js (every call kept)
const SVC_CTX = `
const S = require(path.join(REPO, 'company/tools/service.js'));
const calls = [];
const svcOpts = x => Object.assign({ root: T, unitDir: path.join(T, 'units'), transientDir: path.join(T, 'transient'), systemctl: a => { calls.push(a.join(' ')); return { code: 0, out: '', err: '' }; },
  journal: () => '', isAgent: () => true, ownerShell: () => false, guard: () => true, halted: () => false, callerConflict: () => null }, x || {});
const tryIt = fn => { try { return { ok: true, r: fn() }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const G = require(path.join(REPO, 'company/tools/lib/pm-inbox-guard.js'));
const INBOX = path.join(T, 'company/pm-inbox.jsonl');
const asks = () => G.rows({ file: INBOX, noAlert: true }).filter(x => x.type === 'ask');
const unitText = n => { try { return fs.readFileSync(path.join(T, 'units', 'oc-svc-' + n + '.service'), 'utf8'); } catch (_) { return null; } };
`;

/* ---------------- B1: background jobs ---------------- */
test('B1: a job proposed with no network flags has no network and installs at schedules=auto, with no owner card', () => {
  const T = company({ levels: { schedules: 'auto' } });
  W(T, 'company/work/backup.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
const a = tryIt(() => S.propose(S.context(svcOpts()), 'state-backup', { by: 'sam', kind: 'timer', exec: 'python3 company/work/backup.py', every: '1d', why: 'backs up the company state once a day' }));
out({ a, asks: asks().length, unit: unitText('state-backup') });`);
  assert.equal(r.a.ok, true, JSON.stringify(r.a));
  assert.equal(r.a.r.status, 'installed', 'the crew installs it: ' + JSON.stringify(r.a));
  assert.equal(r.asks, 0, 'no owner card');
  assert.match(r.unit || '', /RestrictAddressFamilies=AF_UNIX/, 'the unit has no network');
});

test('B1: a website on the allowlist at external=auto is not asked; a new one follows the external level', () => {
  const T = company({ levels: { schedules: 'auto', external: 'auto' }, allowlist: ['api.kalshi.com'] });
  W(T, 'company/work/feed.py', 'print(1)\n');
  const r = run(T, SVC_CTX + `
const p = (n, hosts) => tryIt(() => S.propose(S.context(svcOpts()), n, { by: 'sam', kind: 'timer', exec: 'python3 company/work/feed.py', every: '1h', why: 'pulls prices for the desk every hour', hosts }));
const known = p('bank-freshness', 'api.kalshi.com');
const fresh = p('seal-nowcast', 'hermes.pyth.network');
const g = JSON.parse(fs.readFileSync(path.join(T, 'company/state/governance.json'), 'utf8')); g.categories.external = 'approve';
fs.writeFileSync(path.join(T, 'company/state/governance.json'), JSON.stringify(g));
const ask = p('eia-slot', 'api.eia.gov');
const card = asks().pop() || null;
out({ known, fresh, ask, card: card && { category: card.gate.category, guardrail: !!card.gate.guardrail, message: card.message, recommendation: card.recommendation, technical: card.technical } });`);
  assert.equal(r.known.r.status, 'installed', 'an allowlisted website at external=auto: installed: ' + JSON.stringify(r.known));
  assert.equal(r.fresh.r.status, 'installed', 'a new website at external=auto: the crew decides: ' + JSON.stringify(r.fresh));
  assert.equal(r.ask.r.waiting, true, 'a new website at external=approve waits for the owner');
  assert.ok(r.card, 'one card');
  assert.equal(r.card.category, 'external'); assert.equal(r.card.guardrail, false, 'not a guardrail card: a standing rule can cover it');
  assert.match(r.card.message, /It connects to the Eia website, which the crew has not used before\./);
  assert.doesNotMatch(r.card.message + r.card.recommendation, /\bonly\b|any website/, 'never claims the job reaches only some websites');
  assert.doesNotMatch(r.card.recommendation, /keeps their work running smoothly/, 'no canned reason');
  assert.match(r.card.technical, /declared, not enforced/);
});

test('B1: crew guidance tells agents how to declare the websites a job needs', () => {
  const h = fs.readFileSync(path.join(REPO, 'company/HANDOFFS.md'), 'utf8');
  assert.match(h, /--hosts/, 'HANDOFFS.md names --hosts');
  assert.match(h, /--plain/, 'and the owner\'s own words');
  const s = require(path.join(REPO, 'company/tools/service.js'));
  const r = s.checkCommand({ isAgent: () => true, guard: () => true, root: os.tmpdir(), P: (...p) => path.join(os.tmpdir(), ...p), log: path.join(SCRIPTS, 'svc-log.jsonl'), now: () => Date.now() }, 'systemctl', ['--user', 'enable', 'x.service']);
  assert.match(r.why, /--hosts/, 'the shim\'s refusal names --hosts');
});
