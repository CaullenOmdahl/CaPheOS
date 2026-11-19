'use strict';
// framework-edits.test.js — a crew edit of a framework file in a running company is caught by the change watcher within
// one tick: saved as a framework request with its diff, the file put back, the editor and the CEO told; company-owned
// files are never touched; nothing is filed for a file that matches HEAD.
//   node --test company/tools/tests/framework-edits.test.js
// (The update path is in framework-update.js selftest and scripts/instance-update-test.sh.)
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test'); const assert = require('assert');

const T = fs.realpathSync(require('../lib/temp-life').tmpDir('framework-edits-selftest-')); const H = path.join(T, 'home');
const W = (rel, v) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, v); return f; };
const R = rel => fs.readFileSync(path.join(T, rel), 'utf8');
const G = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-C', T, ...a], { encoding: 'utf8' });
W('company/company.json', JSON.stringify({ name: 'Fw Test', owner: { name: 'Pat' }, timezone: 'UTC', station: { port: 1 } }));
W('company/CHARTER.md', '# Fw Test\n');
W('company/HANDOFFS.md', '# Handoffs\n\nThe protocol as shipped.\n');
W('company/skills/x/SKILL.md', '# A skill\n');
W('company/tools/loops.json', JSON.stringify({ agents: { founder: { name: 'Avery', functions: ['ceo', 'people', 'tools', 'risk', 'finance'], manager: null, inbox: 'to-avery.md' }, sam: { name: 'Sam', manager: 'founder', inbox: 'to-sam.md' } } }));
W('.gitignore', 'company/work/\ncompany/state/\n.starnet-data/\nhome/\n');
G('init', '-q'); G('add', '-A'); G('commit', '-qm', 'framework');
W('company/work/.founded', 'x\n'); W('company/work/handoffs/to-avery.md', '# Avery\n'); W('company/work/handoffs/to-sam.md', '# Sam\n');
process.env.CAPHEOS_ROOT = T; process.env.PROVENANCE_ROOT = T; process.env.STARNET_URL = 'http://127.0.0.1:1';
const P = require('../provenance.js'); P.pinUnderStation(false);
const LW = require('../locked-watch.js');
const FE = require('../lib/framework-edits');
test.after(() => { P.pinUnderStation(null); fs.rmSync(T, { recursive: true, force: true }); });

test('a crew edit of a framework doc is caught within a tick: filed with its diff, put back, the editor and the CEO told; owned files untouched', async () => {
  let now = Date.now();
  const C = () => ({ root: T, home: H, now, log: () => {}, underStation: false, jobs: [] });
  await LW.tick(C());   // the first look: the baseline
  // Sam edits the framework's HANDOFFS.md in place (the transcript records the write); the owner edits the charter (company-owned)
  W('company/HANDOFFS.md', '# Handoffs\n\nThe protocol as shipped.\nAnd my own version of the owner\'s ruling.\n');
  G('update-index', '--skip-worktree', 'company/skills/x/SKILL.md');   // hidden but unchanged: nothing to file
  W('company/CHARTER.md', '# Fw Test\nOur mandate.\n');
  const seg = W('.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl', JSON.stringify({ streamId: 'cron-1', agentId: 'sam', role: 'assistant', ts: now - 60000, sourceRunId: 'run-sam-1',
    toolCalls: JSON.stringify([{ id: 'c1', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'company/HANDOFFS.md', content: 'x' }) } }]) }) + '\n');
  assert.ok(fs.existsSync(seg));
  now += 60000;
  await LW.tick(C());
  const reqs = fs.readdirSync(path.join(T, 'company/work/framework-requests'));
  assert.equal(reqs.length, 1, reqs.join(', '));
  const req = R('company/work/framework-requests/' + reqs[0]);
  assert.match(reqs[0], /^fr-0001\.md$/);
  assert.match(req, /- File: `company\/HANDOFFS\.md`/); assert.match(req, /^\+And my own version of the owner's ruling\.$/m); assert.match(req, /Proposed by: Sam \(sam, run run-sam-/);
  assert.equal(R('company/HANDOFFS.md'), '# Handoffs\n\nThe protocol as shipped.\n', 'put back to the framework\'s version');
  assert.equal(R('company/CHARTER.md'), '# Fw Test\nOur mandate.\n', 'a company-owned file is never touched');
  assert.match(R('company/work/handoffs/to-sam.md'), /your edit of company\/HANDOFFS\.md is saved as fr-0001[\s\S]*Framework files are changed upstream/);
  assert.match(R('company/work/handoffs/to-avery.md'), /company\/HANDOFFS\.md` framework-request: a framework file edited in this company: framework files are changed upstream, so the edit is saved as fr-0001/);
  // nothing more to file: the next tick files no second request (the file matches HEAD; the hidden skill is unchanged)
  now += 60000; await LW.tick(C());
  assert.equal(fs.readdirSync(path.join(T, 'company/work/framework-requests')).length, 1);
  assert.deepStrictEqual(FE.crewEdits(T), []);
});

test('the framework-request id sequence counts hand-written titled files too (fr-0007-title.md)', () => {
  const d = require('../lib/temp-life').tmpDir('fr-ids-');
  try { fs.writeFileSync(path.join(d, 'fr-0007-providers-guard.md'), 'x'); fs.writeFileSync(path.join(d, 'fr-0003.md'), 'x'); assert.equal(FE.nextRequestId(d), 'fr-0008'); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the framework checkout itself (not founded) is never swept', () => {
  const D = fs.realpathSync(require('../lib/temp-life').tmpDir('fw-dev-'));
  try {
    fs.writeFileSync(path.join(D, 'a.md'), 'x\n'); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q', D]); spawnSync('git', ['-C', D, 'add', '-A']); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', D, 'commit', '-qm', 'x']);
    fs.writeFileSync(path.join(D, 'a.md'), 'a developer edit\n');
    assert.deepStrictEqual(FE.sweep(D).edits, []); assert.equal(fs.readFileSync(path.join(D, 'a.md'), 'utf8'), 'a developer edit\n');
  } finally { fs.rmSync(D, { recursive: true, force: true }); }
});
