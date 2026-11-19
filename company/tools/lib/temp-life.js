/* temp-life.js — a test or tool that makes temp dirs or starts helper processes (headless Chrome, a mock station, a
 * console) registers them here, and they are gone when the process ends: on a normal exit, on an uncaught error, and on
 * SIGINT / SIGTERM / SIGHUP (the signal scripts/test.sh's `timeout` sends, and Ctrl-C). Without this a walk killed by
 * its timeout left its Chrome running, reparented to the user's systemd, and its profile (100-600 MB) in /tmp, which is
 * RAM on most Linux hosts.
 *
 *   const life = require('../company/tools/lib/temp-life');
 *   const dir = life.tmpDir('console-walk-');          // fs.mkdtempSync under os.tmpdir(), removed at exit
 *   const kid = life.track(spawn(...));                 // killed at exit (SIGTERM, then SIGKILL after a grace)
 *   const { proc, dir: udd } = life.chrome(bin, args, { prefix: 'chatwin-' })
 *                                                       // a fresh profile, --user-data-dir added, Chrome's own temp files
 *                                                       // (com.google.Chrome.*) kept inside the profile via TMPDIR
 *   life.cleanup()                                      // the same, now (idempotent); exit runs it anyway
 *
 * Order at cleanup: every tracked process gets SIGTERM (its process group too when it leads one), up to graceMs
 * (default 1500) for them to end, SIGKILL for the rest, a short wait, then any process still naming a registered dir
 * in its command line (a Chrome helper that outlived its browser) gets SIGKILL, then the dirs are removed with retries.
 * Chrome writes into its profile until it is gone, so removing the dir before the browser ended is what used to leave
 * half-deleted profiles behind. Everything is synchronous, because an 'exit' handler cannot wait for a promise.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = new Set();
const kids = new Set();
let installed = false;
let cleaned = false;
let graceMs = 1500;

const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch (_) {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const exited = c => !c || !c.pid || c.exitCode !== null || c.signalCode !== null || !alive(c.pid);

function signal(c, sig) {
  if (!c || !c.pid) return;
  if (c.__lifeGroup) { try { process.kill(-c.pid, sig); return; } catch (_) {} }
  try { process.kill(c.pid, sig); } catch (_) {}
}

// processes (other than us) whose command line names one of our dirs: Chrome's zygote, renderers and utility processes
// carry --user-data-dir=<dir>; on Linux only, elsewhere this is a no-op
function namingPids(list) {
  if (process.platform !== 'linux' || !list.length) return [];
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync('/proc'); } catch (_) { return out; }
  for (const e of ents) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + e + '/cmdline', 'utf8'); } catch (_) { continue; }
    if (list.some(d => cmd.includes(d))) out.push(Number(e));
  }
  return out;
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const live = [...kids].filter(c => !exited(c));
  for (const c of live) signal(c, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (live.some(c => !exited(c)) && Date.now() < until) pause(50);
  for (const c of live) if (!exited(c)) signal(c, 'SIGKILL');
  if (live.length) pause(100);
  const list = [...dirs];
  for (const pid of namingPids(list)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  for (const d of list) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
      if (!fs.existsSync(d)) break;
      pause(100);
    }
    if (!fs.existsSync(d)) dirs.delete(d);
  }
  kids.clear();
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', cleanup);
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(sig, () => { cleanup(); process.exit(128 + n); });
  }
}

// a fresh dir under os.tmpdir() (or opts.base), removed at exit
function tmpDir(prefix, opts) {
  install();
  const base = (opts && opts.base) || os.tmpdir();
  const d = fs.mkdtempSync(path.join(base, prefix || 'capheos-'));
  dirs.add(d);
  return d;
}
// an existing dir to remove at exit (one a test made itself)
function own(d) { install(); if (d) dirs.add(path.resolve(d)); return d; }
// a child process to end at exit; { group: true } when it was spawned detached (its own process group)
function track(child, opts) {
  install();
  if (child) { if (opts && opts.group) child.__lifeGroup = true; kids.add(child); if (child.once) child.once('exit', () => kids.delete(child)); }
  return child;
}
// the environment for a browser whose profile is `dir`: its temp files go inside the profile, removed with it
function chromeEnv(dir, env) { return Object.assign({}, env || process.env, { TMPDIR: dir }); }
// start Chrome on a fresh, registered profile; opts.prefix names the profile dir, opts.spawnOpts are passed through
function chrome(bin, args, opts) {
  const o = opts || {};
  const dir = tmpDir(o.prefix || 'capheos-chrome-');
  const so = Object.assign({ stdio: 'ignore' }, o.spawnOpts || {});
  so.env = chromeEnv(dir, so.env);
  const proc = track(require('child_process').spawn(bin, (args || []).concat(['--user-data-dir=' + dir]), so));
  return { proc, dir };
}
function setGrace(ms) { if (Number.isFinite(ms) && ms >= 0) graceMs = ms; }
function registered() { return { dirs: [...dirs], pids: [...kids].map(c => c.pid) }; }

module.exports = { tmpDir, own, track, chrome, chromeEnv, cleanup, setGrace, registered };
