#!/usr/bin/env node
/* git-shim-author.test.js — a commit made from a crew seat's run names that seat as its author (company/tools/shims/git).
 *
 * 2026-11-20, owner: "Nadia logged that she wrote it. I like that. We should do that." The shim sets the author to
 * "<name> (<company>)" <first@capheos.invalid> when STARNET_AGENT_ID names a seat in loops.json and no author is set;
 * the committer, the owner's own commits and an author a seat chose itself are left alone.
 *
 *   node --test company/tools/tests/git-shim-author.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const SHIM = path.join(__dirname, '..', 'shims', 'git');

test('a seat\'s commit is authored by the seat; the owner and a chosen author are untouched', () => {
  const root = require('../lib/temp-life').tmpDir('git-shim-author-');
  try {
    fs.mkdirSync(path.join(root, 'company', 'tools', 'shims'), { recursive: true });
    fs.copyFileSync(SHIM, path.join(root, 'company', 'tools', 'shims', 'git'));
    fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ name: 'Test Co' }));
    fs.writeFileSync(path.join(root, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { 'seat-x': { name: 'Nadia Farrell' } } }));
    const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
    const base = Object.assign({}, process.env, { GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'o@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    delete base.STARNET_AGENT_ID; delete base.GIT_AUTHOR_NAME; delete base.GIT_AUTHOR_EMAIL;
    const shim = path.join(root, 'company', 'tools', 'shims', 'git');
    const run = (env, msg) => execFileSync('bash', [shim, 'commit', '-q', '--allow-empty', '-m', msg], { cwd: repo, env: Object.assign({}, base, env) });
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repo, env: base });
    run({ GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'o@x' }, 'owner');
    run({ STARNET_AGENT_ID: 'seat-x' }, 'seat');
    run({ STARNET_AGENT_ID: 'seat-x', GIT_AUTHOR_NAME: 'Chosen', GIT_AUTHOR_EMAIL: 'c@x' }, 'chosen');
    run({ STARNET_AGENT_ID: 'not-a-seat', GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'o@x' }, 'unknown seat');
    const log = execFileSync('/usr/bin/git', ['log', '--format=%s|%an|%ae|%cn'], { cwd: repo, env: base, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(log, [
      'unknown seat|Owner|o@x|Owner',
      'chosen|Chosen|c@x|Owner',
      'seat|Nadia Farrell (Test Co)|nadia@capheos.invalid|Owner',
      'owner|Owner|o@x|Owner',
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
