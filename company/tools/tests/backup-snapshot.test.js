#!/usr/bin/env node
/* backup-snapshot.test.js — scripts/backup.sh while the company keeps writing.
 * A seat may change or remove a file under company/work while the snapshot is read. GNU tar then exits 1 with a complete
 * archive; the digests must come from the archive (not the live tree afterwards) so the snapshot verifies. A tar exit of
 * 2 or more is a real failure and leaves nothing behind.
 *   node --test company/tools/tests/backup-snapshot.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const REAL_TAR = execFileSync('bash', ['-c', 'command -v tar']).toString().trim();

function scratch(tarExit, complaint) {
  const T = require('../lib/temp-life').tmpDir('backup-snapshot-');
  fs.mkdirSync(path.join(T, 'scripts'));
  fs.copyFileSync(path.join(REPO, 'scripts', 'backup.sh'), path.join(T, 'scripts', 'backup.sh'));
  fs.mkdirSync(path.join(T, 'company', 'work'), { recursive: true });
  fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ slug: 'snap-test' }));
  fs.writeFileSync(path.join(T, 'company', 'work', 'notes.md'), 'before\n');
  fs.writeFileSync(path.join(T, 'company', 'work', 'gone.md'), 'removed mid-run\n');
  // a tar that does the real work, then behaves like a seat writing during the read: the archived file changes and
  // another disappears before the digests are taken; it exits like GNU tar does in that case
  const bin = path.join(T, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tar'), `#!/usr/bin/env bash
"${REAL_TAR}" "$@"; rc=$?
case "$1" in -czf) echo "after" >> company/work/notes.md; rm -f company/work/gone.md; echo "${complaint || 'tar: company/work/notes.md: file changed as we read it'}" >&2; exit ${tarExit};; esac
exit $rc
`, { mode: 0o755 });
  const dir = path.join(T, 'snaps');
  const run = args => spawnSync('bash', [path.join(T, 'scripts', 'backup.sh')].concat(args || []),
    { cwd: T, env: Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, CAPHEOS_BACKUP_DIR: dir }), encoding: 'utf8' });
  return { T, dir, run, done: () => fs.rmSync(T, { recursive: true, force: true }) };
}

test('a file that changes during the read: tar exit 1 still gives a snapshot that verifies, with its digest file', () => {
  const s = scratch(1);
  try {
    const r = s.run([]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^backup .*\.tar\.gz/m);
    assert.match(r.stderr, /tolerated .*file changed as we read it/);
    assert.deepEqual(fs.readdirSync(s.dir).filter(f => f.startsWith('.wip-')), [], 'the work folder is gone');
    const snaps = fs.readdirSync(s.dir).filter(f => f.endsWith('.tar.gz'));
    assert.equal(snaps.length, 1);
    assert.ok(fs.existsSync(path.join(s.dir, snaps[0].replace(/\.tar\.gz$/, '.sha256'))), 'the digest file is written');
    const v = s.run(['verify']);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /^ok /m);
    const digests = fs.readFileSync(path.join(s.dir, snaps[0].replace(/\.tar\.gz$/, '.sha256')), 'utf8');
    assert.match(digests, /  company\/work\/gone\.md$/m, 'a file removed after the read is still in the snapshot and its digests');
    assert.equal((fs.statSync(path.join(s.dir, snaps[0])).mode & 0o777), 0o600);
  } finally { s.done(); }
});

test('a real tar failure (exit 2) fails the backup and keeps nothing', () => {
  const s = scratch(2);
  try {
    const r = s.run([]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAIL tar exited 2/);
    assert.deepEqual(fs.readdirSync(s.dir).filter(f => /\.(tar\.gz|sha256)$/.test(f)), []);
  } finally { s.done(); }
});

test('exit 1 with any other complaint (not "file changed" / "File removed") fails and keeps nothing', () => {
  const s = scratch(1, 'tar: company/work/secret.md: Cannot open: Permission denied');
  try {
    const r = s.run([]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Permission denied/); assert.match(r.stderr, /FAIL tar exited 1/);
    assert.deepEqual(fs.readdirSync(s.dir).filter(f => /\.(tar\.gz|sha256)$/.test(f) || f.startsWith('.wip-')), []);
  } finally { s.done(); }
});
