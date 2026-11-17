#!/usr/bin/env node
/* house-rules-modules.test.js — house rules v8 name a module's tool only while that module is enabled: in a company
 * without the commitments module the waiting rule routes to a handoff instead of commitments.js, and enabling the
 * module brings the commitments line back on the next ensure (the dispatcher's house-rule refresh).
 *   node --test company/tools/tests/house-rules-modules.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const RR = path.join(REPO, 'company', 'tools', 'routine-rules.js');

// a scratch company root: the framework's modules/ (read-only use), its own company/state/modules.json
function scratch(enabled) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'house-rules-selftest-'));
  fs.mkdirSync(path.join(T, 'company', 'state'), { recursive: true });
  fs.cpSync(path.join(REPO, 'company', 'company.json'), path.join(T, 'company', 'company.json'));
  fs.cpSync(path.join(REPO, 'modules'), path.join(T, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'state', 'modules.json'), JSON.stringify({ enabled: Object.fromEntries(enabled.map(id => [id, { at: 'x' }])) }));
  return T;
}
// run ensure() in a child with CAPHEOS_ROOT = the scratch root, against a fake station holding one routine
function ensureIn(T, prompt) {
  const code = `const R=require(${JSON.stringify(RR)});const job={id:'j1',name:'Job',agentId:'a',workdir:R.ROOT,prompt:${JSON.stringify(prompt)}};
R.ensure({log:()=>{},blockFor:()=>'',ownFor:()=>'',ownBlocked:()=>{},call:async(m,p,b)=>{if(m==='GET')return{status:200,body:JSON.stringify({jobs:[job]})};job.prompt=b.patch.prompt;return{status:200,body:'{}'};}})
.then(()=>process.stdout.write(JSON.stringify({prompt:job.prompt,block:R.BLOCK,version:R.VERSION})));`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('without the commitments module, no seat is sent to the commitments tool', () => {
  const T = scratch([]);
  try {
    const r = ensureIn(T, 'You are Jo.\n\nDo the work.');
    assert.equal(r.version, 'v13');
    assert.ok(r.prompt.includes('[HOUSE RULES FOR SCHEDULED RUNS v13]'));
    // v13: meeting etiquette (ASK, INVITE, DISMISS, END; short replies; PASS)
    assert.match(r.prompt, /Meeting etiquette .*reply PASS when you have nothing to add.*ASK: <name> — <question>.*INVITE: <name>.*DISMISS: <name>.*END: <what was decided/);
    // v12: work that waits on work names it in Waiting on; a long job goes through notify-when.js; Not before is a clock time
    assert.match(r.prompt, /Use \*\*Waiting on:\*\* for anything that waits on other work/);
    assert.match(r.prompt, /node company\/tools\/notify-when\.js --seat <you>/);
    assert.match(r.prompt, /Never park work to look busy-free or to avoid stall checks/);
    // v11: a connector is checked through its own verify command; a credential file is never read or printed
    assert.match(r.prompt, /connector's verify command in company\/connectors\/<id>\.json/);
    assert.match(r.prompt, /Never read, cat, list, grep or print a credential file/);
    assert.doesNotMatch(r.prompt, /commitments\.js/);
    assert.match(r.prompt, /handoff to yourself/);
    assert.match(r.prompt, /service\.js propose/);   // the rest of the waiting rule stays
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('an existing v7 routine is refreshed: the fallback replaces the commitments line; enabling the module brings it back', () => {
  const v7 = 'You are Jo.\n\n[HOUSE RULES FOR SCHEDULED RUNS v7]\n- Never wait ... node company/tools/commitments.js create ...\n[END HOUSE RULES]';
  const off = scratch([]), on = scratch(['commitments']);
  try {
    const a = ensureIn(off, v7);
    assert.doesNotMatch(a.prompt, /commitments\.js|v7\]/);
    const b = ensureIn(on, a.prompt);
    assert.ok(b.prompt.includes(b.block), 'with the module on, the full house rules');
    assert.match(b.prompt, /commitments\.js create/);
    assert.equal(b.prompt.split('[HOUSE RULES FOR SCHEDULED RUNS').length, 2);
  } finally { for (const T of [off, on]) fs.rmSync(T, { recursive: true, force: true }); }
});

test('blockFor: every module enabled is BLOCK byte for byte; a module line without a fallback is left out', () => {
  const R = require(RR);
  assert.equal(R.blockFor(['commitments'], { commitments: 'commitments' }), R.BLOCK);
  const b = R.blockFor([], { 'my-section': 'some-module' });
  assert.ok(!b.includes('my-section.js') && b.split('\n').length === R.BLOCK.split('\n').length - 1);
  assert.equal(R.moduleTools().commitments, 'commitments');
});

test('house rules v10 carry the owner-scope rule: infrastructure is the crew\'s, the owner gets only the short list in two plain sentences with a default', () => {
  const T = scratch([]);
  try {
    const r = ensureIn(T, 'You are Jo.\n\nDo the work.');
    assert.match(r.prompt, /The owner is a busy non-technical person\. Handle infrastructure yourself/);
    assert.match(r.prompt, /Ask the owner only for money beyond the company's limits, an account or identity in their own name, legal, ownership or commitment decisions, company direction and priorities, risk the governance level reserves for them, or a fixed gate, in two plain sentences/);
    assert.match(r.prompt, /what happens if they skip it \(your default\)/);
    assert.match(r.prompt, /"not now" is not asked again for 7 days/);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
