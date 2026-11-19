/* starnet-copy.js — a throwaway copy of a StarNet checkout with one patch record applied, for the patch tests.
 *
 *   const SC = require('./starnet-copy');
 *   const src = SC.findSource(argvDir);                 // $CAPHEOS_STARNET_SRC, the given dir, or <root>/starnet; or null
 *   const { dir, applied } = SC.prepare(src, record);   // a temp dir (temp-life: removed at exit), node_modules linked
 *
 * The checkout itself is only read. The copy leaves out the big trees a station test never loads (frontend but its app/
 * modules, website, docs, output, qa, src-tauri) and git; the record is applied unless the copy already carries it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const LEAVE_OUT = new Set(['frontend', 'website', 'docs', 'output', 'qa', 'src-tauri', 'node_modules', '.git']);

function findSource(given) {
  const cands = [given, process.env.CAPHEOS_STARNET_SRC, path.join(process.env.CAPHEOS_ROOT || REPO, 'starnet'), path.join(REPO, 'starnet')].filter(Boolean);
  return cands.find(d => fs.existsSync(path.join(d, 'sidecar', 'index.js')) && fs.existsSync(path.join(d, 'node_modules'))) || null;
}
function prepare(src, record, prefix) {
  const dir = life.tmpDir(prefix || 'capheos-starnet-');
  const names = fs.readdirSync(src).filter(n => !LEAVE_OUT.has(n));
  // frontend/app: the sidecar requires a few of its modules (usertext, turnkinds, …); the rest of frontend is the page
  if (fs.existsSync(path.join(src, 'frontend', 'app'))) names.push('frontend/app');
  const tar = cp.spawnSync('bash', ['-c', 'src="$1"; dst="$2"; shift 2; tar -C "$src" -cf - "$@" | tar -C "$dst" -xf -', '_', src, dir].concat(names), { stdio: ['ignore', 'ignore', 'pipe'] });
  if (tar.status !== 0) throw new Error('copy failed: ' + tar.stderr);
  fs.symlinkSync(path.join(src, 'node_modules'), path.join(dir, 'node_modules'));
  const git = a => cp.spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  if (git(['apply', '-R', '--check', record]).status === 0) return { dir, applied: 'already carried by this checkout' };
  const chk = git(['apply', '--check', record]);
  if (chk.status !== 0) throw new Error('the record no longer applies to this checkout: ' + chk.stderr.trim());
  const ap = git(['apply', '--whitespace=nowarn', record]);
  if (ap.status !== 0) throw new Error('apply failed: ' + ap.stderr);
  return { dir, applied: 'applied to the copy' };
}
module.exports = { findSource, prepare };
