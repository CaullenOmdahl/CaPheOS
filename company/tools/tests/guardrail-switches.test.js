#!/usr/bin/env node
/* guardrail-switches.test.js — a switch that is OFF governs the check it names (docs/GUARDRAILS.md "A check that ignores
 * its switch"): ownerGates OFF lets governance levels, standing rulings and chat answers treat the four fixed owner gates
 * as ordinary categories; ON keeps them closed. Scratch company roots (CAPHEOS_ROOT in a child process).
 *
 *   node --test company/tools/tests/guardrail-switches.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const roots = [];
test.after(() => { for (const r of roots) try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} });
const w = (root, rel, data) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n'); };

function company(ownerGates) {
  const T = require('../lib/temp-life').tmpDir('guardrail-switches-selftest-'); roots.push(T);
  w(T, 'company/company.json', { name: 'Example', owner: { name: 'Olive Owner', title: 'Owner' }, timezone: 'UTC' });
  w(T, 'company/tools/loops.json', { agents: { agent: { name: 'Founder', manager: null, functions: ['ceo'], inbox: 'to-founder.md' }, sam: { name: 'Sam', manager: 'agent', functions: ['tools'], inbox: 'to-sam.md' } } });
  for (const f of ['company/defaults/state/governance.json', 'company/defaults/state/guardrails.json', 'company/defaults/state/approvals-policy.json', 'company/competence-policy.json'])
    fs.mkdirSync(path.dirname(path.join(T, f)), { recursive: true }), fs.copyFileSync(path.join(REPO, f), path.join(T, f));
  fs.cpSync(path.join(REPO, 'company', 'decision-models'), path.join(T, 'company', 'decision-models'), { recursive: true });
  w(T, 'company/work/decisions.md', '# Decisions\n\n');
  w(T, '.capheos-selftest-fixture', '');
  if (ownerGates === false) w(T, 'company/state/guardrails.json', { guards: { ownerGates: false } });
  return T;
}
function run(T, code) {
  const src = 'Promise.resolve((() => {' + code + '})()).then(v => console.log(JSON.stringify(v === undefined ? null : v)), e => { console.log(JSON.stringify({ threw: e.message })); });';
  const r = spawnSync(process.execPath, ['-e', src], { cwd: T, encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', PROVENANCE_ROOT: T, STARNET_URL: 'http://127.0.0.1:1' }) });
  if (r.status !== 0) throw new Error('child failed: ' + r.stdout + r.stderr);
  const v = JSON.parse(r.stdout.trim().split('\n').pop()); if (v && v.threw) throw new Error(v.threw); return v;
}
const lib = n => JSON.stringify(path.join(REPO, 'company', 'tools', n));
const askAccess = 'const A = require(' + lib('approvals.js') + '); return A.ask({ from: "Sam", category: "access", message: "Could we get read access to the example account? It lets us go on with the work.", params: { account: "example" } });';

test('ownerGates ON: access stays a fixed gate, a standing rule never covers it, governance.js refuses to change it', () => {
  const T = company(true);
  const r = run(T, askAccess); assert.equal(r.ok !== false, true, JSON.stringify(r));
  assert.equal(run(T, 'return require(' + lib('approvals.js') + ').get(' + JSON.stringify(r.id) + ').fixed;'), true);
  assert.equal(run(T, 'return require(' + lib('lib/owner-rulings.js') + ').match({ category: "access" }, { rulings: [{ scope: { categories: ["access"] }, effect: "crew-decides" }], root: process.cwd() });'), null);
  assert.equal(run(T, 'return require(' + lib('governance.js') + ').set("access", "auto", "owner", { root: process.cwd() }).code;'), 2);
  assert.equal(run(T, 'return require(' + lib('lib/governance.js') + ').level("access", { root: process.cwd() });'), 'approve');
});

test('ownerGates OFF: the fixed gate is an ordinary category (not fixed, answerable in chat), a standing rule may cover it, governance.js sets its level', () => {
  const T = company(false);
  const r = run(T, askAccess); assert.equal(r.ok !== false, true, JSON.stringify(r));
  const rec = run(T, 'const A = require(' + lib('approvals.js') + '); const g = A.get(' + JSON.stringify(r.id) + '); return { fixed: g.fixed, chat: g.chatAnswerable };');
  assert.deepEqual(rec, { fixed: false, chat: true });
  const ruling = { scope: { categories: ['access'] }, effect: 'crew-decides' };
  assert.deepEqual(run(T, 'return require(' + lib('lib/owner-rulings.js') + ').match({ category: "access" }, { rulings: [' + JSON.stringify(ruling) + '], root: process.cwd() });'), ruling);
  assert.equal(run(T, 'return require(' + lib('lib/governance.js') + ').level("access", { root: process.cwd() });'), 'approve', 'no level set yet: still approve');
  const set = run(T, 'return require(' + lib('governance.js') + ').set("access", "notify", "owner", { root: process.cwd() });');
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(run(T, 'return require(' + lib('lib/governance.js') + ').level("access", { root: process.cwd() });'), 'notify');
  assert.equal(run(T, 'return require(' + lib('lib/company.js') + ').gate("access");'), 'notify');
  assert.equal(run(T, 'return require(' + lib('governance.js') + ').set("access", "triage", "owner", { root: process.cwd() }).code;'), 2, 'a fixed gate is never triage');
  // switching the guardrail back on closes it again, whatever level was stored
  w(T, 'company/state/guardrails.json', { guards: { ownerGates: true } });
  assert.equal(run(T, 'return require(' + lib('lib/company.js') + ').gate("access");'), 'approve');
});

test('externalActions OFF: a host that is on no allowlist and has no clearance row goes through (logged); ON refuses it', () => {
  const T = company(true);
  const base = 'const G = require(' + lib('external-gate.js') + '); const o = g => ({ ledger: process.cwd() + "/l.jsonl", log: process.cwd() + "/log.jsonl", allowlist: process.cwd() + "/a.txt", level: "auto", guards: { externalActions: g }, govRoot: process.cwd() });' +
    'const req = { category: "network", target: "https://unseen-vendor.example/api", agent: "sam" };';
  assert.equal(run(T, base + 'return G.check(req, o(true)).allow;'), false);
  const off = run(T, base + 'return G.check(req, o(false));');
  assert.equal(off.allow, true); assert.equal(off.guardrailOff, true);
  // the reach module reads the same gate: it is not refused for an unlisted host while the switch is off
  assert.equal(run(T, base + 'return G.check({ category: "network", target: "https://api.unlisted.example/v1", agent: "reach", note: "reach read-only fetch" }, o(false)).allow;'), true);
});
