#!/usr/bin/env node
/* backup-freshness.js — is there a state snapshot (scripts/backup.sh) from the last 26 hours?
 *
 * Why: backup.sh runs from a timer nobody watches. A timer that stopped, a full disk or a moved backup folder means the
 * newest snapshot quietly gets older, and nobody learns it until a restore is needed. This only reads the folder.
 *
 *   node company/tools/backup-freshness.js            newest snapshot and its age; exit 0 fresh, 1 stale or none
 *   node company/tools/backup-freshness.js --json
 *   node company/tools/backup-freshness.js --duty     read-only duty check (docs/DUTIES.md): exit 0 fresh, 1 + JSON
 *                                                     {due, reason, key} when the newest is older than 26 h or there is none
 *   node company/tools/backup-freshness.js --selftest
 * Folder: $CAPHEOS_BACKUP_DIR, else ~/.local/share/capheos-backups/<company.json slug> (the same rule as backup.sh).
 * Owner: the risk seat. Changes nothing, opens no socket.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const co = require('./lib/company');

const MAX_AGE_H = 26;
const dirOf = env => (env || process.env).CAPHEOS_BACKUP_DIR || path.join((env || process.env).HOME || os.homedir(), '.local', 'share', 'capheos-backups', String(co.config.slug || 'company'));

function newest(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => /\.tar\.gz$/.test(n)); } catch (_) { return null; }
  let best = null;
  for (const n of names) { try { const m = fs.statSync(path.join(dir, n)).mtimeMs; if (!best || m > best.mtimeMs) best = { name: n, mtimeMs: m }; } catch (_) {} }
  return best;
}
function judge(dir, now) {
  const n = newest(dir);
  const ageH = n ? Math.round((now - n.mtimeMs) / 360000) / 10 : null;
  return { dir, newest: n ? n.name : null, ageH, fresh: !!n && ageH <= MAX_AGE_H };
}
function dutyResult(v) {
  if (v.fresh) return null;
  return { due: true, reason: v.newest ? 'the newest state snapshot is ' + v.ageH + ' h old (more than ' + MAX_AGE_H + ' h): is the backup timer running?' : 'no state snapshot found in the backup folder: scripts/backup.sh has not run, or its folder moved',
    key: 'bk-' + (v.newest ? v.newest.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) : 'none') };
}

function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-fresh-selftest-'));
  const now = Date.now();
  try {
    let v = judge(path.join(d, 'nope'), now);
    ok('no folder: not fresh, due "no snapshot"', !v.fresh && /no state snapshot/.test(dutyResult(v).reason));
    fs.writeFileSync(path.join(d, '20301010T000000Z.tar.gz'), 'x'); fs.utimesSync(path.join(d, '20301010T000000Z.tar.gz'), (now - 30 * 3600e3) / 1000, (now - 30 * 3600e3) / 1000);
    v = judge(d, now);
    ok('a 30 h old snapshot is stale and due', !v.fresh && v.ageH === 30 && dutyResult(v).key === 'bk-20301010T000000Z.tar.gz', JSON.stringify(v));
    fs.writeFileSync(path.join(d, '20301011T000000Z.tar.gz'), 'x');
    v = judge(d, now);
    ok('a fresh snapshot is not due', v.fresh && dutyResult(v) === null, JSON.stringify(v));
    ok('the folder follows CAPHEOS_BACKUP_DIR', dirOf({ CAPHEOS_BACKUP_DIR: d, HOME: '/x' }) === d);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
  console.log(bad ? 'BACKUP-FRESHNESS SELFTEST FAILED: ' + bad : 'BACKUP-FRESHNESS SELFTEST PASSED');
  return bad ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest')) process.exit(selftest());
  const v = judge(dirOf(), Date.now());
  if (a.includes('--duty')) { const r = dutyResult(v); if (r) console.log(JSON.stringify(r)); process.exit(r ? 1 : 0); }
  if (a.includes('--json')) console.log(JSON.stringify(v));
  else console.log(v.newest ? 'newest snapshot ' + v.newest + ', ' + v.ageH + ' h old' + (v.fresh ? '' : ' (STALE, more than ' + MAX_AGE_H + ' h)') : 'no snapshot in ' + v.dir);
  process.exit(v.fresh ? 0 : 1);
}
module.exports = { judge, dutyResult, dirOf, MAX_AGE_H };
