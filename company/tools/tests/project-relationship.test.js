#!/usr/bin/env node
/* project-relationship.test.js — a taken-over product is client work: every project row starts as relationship client,
 * list/status/assert show it, only the Commander marks a row own, and the seats' context line names it.
 *   node --test company/tools/tests/project-relationship.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const TOOL = path.join(REPO, 'company', 'tools', 'project.js');
const LIB = path.join(REPO, 'company', 'tools', 'lib', 'projects.js');

function scratch() {
  const T = require('../lib/temp-life').tmpDir('project-relationship-selftest-');
  fs.mkdirSync(path.join(T, 'company'), { recursive: true });
  fs.cpSync(path.join(REPO, 'company', 'company.json'), path.join(T, 'company', 'company.json'));
  return T;
}
const env = T => Object.assign({}, process.env, { CAPHEOS_ROOT: T });
function run(T, ...args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(T) });
  return { code: r.status, out: JSON.parse(r.stdout || '{}') };
}

test('a project starts as client work and shows it; only the Commander marks it own', () => {
  const T = scratch();
  try {
    let r = run(T, 'request', '--id', 'example-app', '--name', 'Example App', '--scope', 'maintain it', '--by', 'Alex');
    assert.equal(r.code, 0); assert.equal(r.out.requested.relationship, 'client');
    assert.equal(run(T, 'discover', '--id', 'other-app', '--remote', 'https://example.com/x.git', '--by', 'Alex').out.discovered.relationship, 'client');
    // a row written before the field existed reads as client
    const f = path.join(T, 'company', 'projects.json'); const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete db.projects[0].relationship; fs.writeFileSync(f, JSON.stringify(db));
    assert.equal(run(T, 'approve', '--id', 'example-app', '--by', 'Commander').out.approved.relationship, 'client');
    r = run(T, 'assert', '--id', 'example-app');
    assert.equal(r.code, 0); assert.equal(r.out.relationship, 'client'); assert.match(r.out.brief, /current behaviour, equipment, staff routine and release flow are the brief/);
    assert.ok(run(T, 'list').out.projects.every(p => p.relationship === 'client'));
    assert.equal(run(T, 'status', '--id', 'example-app').out.project.relationship, 'client');
    // a seat cannot mark it the company's own; a bad value is refused; the Commander can
    r = run(T, 'relationship', '--id', 'example-app', '--set', 'own', '--by', 'Alex');
    assert.equal(r.code, 3); assert.match(r.out.error, /only the Commander/);
    assert.equal(run(T, 'relationship', '--id', 'example-app', '--set', 'mine', '--by', 'Commander').code, 2);
    r = run(T, 'relationship', '--id', 'example-app', '--set', 'own', '--by', 'Commander');
    assert.equal(r.code, 0); assert.equal(r.out.relationship, 'own');
    assert.equal(run(T, 'relationship', '--id', 'example-app', '--set', 'client', '--by', 'Alex').out.relationship, 'client');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('the seats\' context line lists live projects with their relationship', () => {
  const T = scratch();
  try {
    fs.writeFileSync(path.join(T, 'company', 'projects.json'), JSON.stringify({ projects: [
      { id: 'a', name: 'App A', state: 'active' }, { id: 'b', name: 'App B', state: 'active', relationship: 'own' }, { id: 'c', name: 'App C', state: 'requested' }] }));
    const code = 'process.stdout.write(require(' + JSON.stringify(LIB) + ').contextLine())';
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: env(T) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /App A \(client: client work: its current behaviour/);
    assert.match(r.stdout, /App B \(own: the company's own product\)/);
    assert.doesNotMatch(r.stdout, /App C/);
    fs.writeFileSync(path.join(T, 'company', 'projects.json'), JSON.stringify({ projects: [] }));
    assert.equal(spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: env(T) }).stdout, '');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});

test('dossier.js: a seat\'s context and the CEO identity carry the projects line when a project is live', () => {
  const T = require('../lib/temp-life').tmpDir('project-relationship-dossier-');
  try {
    const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
    w('company/company.json', { name: 'Fixture Co', owner: { name: 'Olive' }, timezone: 'UTC', station: { url: 'http://127.0.0.1:9' } });
    w('company/tools/loops.json', { agents: { boss: { name: 'Alex', title: 'CEO', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, ben: { name: 'Noah', title: 'Tester', manager: 'boss', inbox: 'to-noah.md' } } });
    for (const f of ['company/defaults/people/profile-policy.json', 'company/defaults/people/temperament.json', 'company/defaults/people/presets.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
    w('company/roles/noah.md', '# Noah\n\n## Scope\n- tests\n');
    w('company/roles/alex.md', '# Alex\n\n## Personality\nCalm.\n\n## Backstory and motivation\nRan a shop.\n\n## Sources\n- https://example.com/a\n- https://example.com/b\n- https://example.com/c\n');
    const D = JSON.stringify(path.join(REPO, 'company', 'tools', 'dossier.js')), CO = JSON.stringify(path.join(REPO, 'company', 'tools', 'lib', 'company.js'));
    const js = 'const D = require(' + D + '); const co = require(' + CO + '); const b = D.build("ben", co.crew().ben, null); const c = D.buildCeoIdentity({ name: "Alex", docs: { identity: "" } }); process.stdout.write(JSON.stringify({ context: b.context, identity: b.identity, ceo: c && c.identity }));';
    const go = () => { const r = spawnSync(process.execPath, ['-e', js], { cwd: T, encoding: 'utf8', env: env(T) }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
    let o = go();
    assert.doesNotMatch(o.context, /Projects the company works on/);
    assert.match(o.identity, /on client work the client's current way is the brief/);
    w('company/projects.json', { projects: [{ id: 'a', name: 'App A', state: 'approved' }] });
    o = go();
    assert.match(o.context, /Projects the company works on \(company\/projects\.json\): App A \(client: /);
    assert.ok(o.ceo, 'a researched CEO charter builds the CEO identity'); assert.match(o.ceo, /App A \(client: /);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
