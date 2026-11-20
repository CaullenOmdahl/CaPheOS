#!/usr/bin/env node
/* unit-system.test.js — phase 0.5 of the unit system: a format-2 unit is checked, installed and enabled on the current
 * stack; the compat host runs its Cordis plugin; the skill it provides becomes a company skill that skills.js knows.
 *   node --test company/tools/tests/unit-system.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const prov = require('../provenance.js');
const unit = require('../unit.js');
const U = require('../lib/units.js');
const haveRuntime = fs.existsSync(path.join(REPO, 'runtime', 'node_modules', 'cordis'));

test('check refuses a bad manifest with plain reasons, and passes the shipped web-pages unit', () => {
  const dir = require('../lib/temp-life').tmpDir('unit-bad-');
  try {
    const bad = path.join(dir, 'Bad Unit'); fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'module.json'), JSON.stringify({ format: 1, id: 'Bad Unit', provides: { tools: [{ name: 'x' }] } }));
    const r = U.check(bad);
    assert.equal(r.ok, false);
    assert.ok(r.findings.some(f => /format must be 2/.test(f)) && r.findings.some(f => /not supported on the current stack/.test(f)), r.findings.join('; '));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const good = unit.checkDir(path.join(REPO, 'packs', 'web-pages'));
  assert.equal(good.ok, true, good.findings.join('; '));
});

test('install + enable: the compat host runs the plugin and the skill becomes a company skill', { skip: haveRuntime ? false : 'runtime not installed (npm ci in runtime/)' }, () => {
  const root = require('../lib/temp-life').tmpDir('unit-co-');
  prov.pinOwnerShell(true); prov.pinUnderStation(false);
  try {
    fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
    let r = unit.cmd(['install', path.join(REPO, 'packs', 'web-pages'), '--by', 'owner'], { root });
    assert.equal(r.code, 0, JSON.stringify(r.out)); assert.equal(r.out.state, 'installed');
    assert.deepEqual(U.enabledSkills(root), [], 'installed is not enabled');
    r = unit.cmd(['enable', 'web-pages', '--by', 'owner'], { root, noPush: true });
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.deepEqual(r.out.skills, ['web-pages']);
    const s = U.enabledSkills(root);
    assert.equal(s.length, 1); assert.match(fs.readFileSync(s[0].file, 'utf8'), /^---\nname: web-pages\n[\s\S]*Look before you ship/);
    r = unit.cmd(['disable', 'web-pages', '--by', 'owner'], { root });
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.deepEqual(U.enabledSkills(root), [], 'a disabled unit\'s skill leaves the list');
    r = unit.cmd(['enable', 'web-pages', '--by', 'someone-else'], { root, noPush: true });
    assert.equal(r.code, 3, 'enabling is the owner\'s');
  } finally { prov.pinOwnerShell(null); prov.pinUnderStation(null); fs.rmSync(root, { recursive: true, force: true }); }
});
