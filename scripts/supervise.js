#!/usr/bin/env node
/* supervise.js — keep one process running without systemd: the adapter for a container (or any box without a systemd
 * user manager). It starts the command, starts it again whenever it exits (1 s, doubling to 30 s while it keeps
 * failing; back to 1 s after a minute up), passes SIGTERM / SIGINT on and stops, and restarts the child immediately
 * on SIGUSR1 without exiting the supervisor.
 *
 *   node scripts/supervise.js [--name console] [--pidfile <path>] -- node console/server.js
 *
 * The child gets CAPHEOS_SUPERVISOR=supervise (unless set), and when --pidfile or CAPHEOS_ROOT is set, a small JSON
 * pidfile ({ supervisorPid, childPid, name, startedAt }) is maintained at company/state/supervise/<name>.pid so
 * restart-station.js, restart-console.sh, framework-update.js and console/owner-ops.js can signal SIGUSR1 cleanly
 * inside containers without systemd.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const a = process.argv.slice(2);
const dd = a.indexOf('--');
const opts = dd < 0 ? a : a.slice(0, dd);
const cmd = dd >= 0 ? a.slice(dd + 1) : [];
const opt = flag => { const i = opts.indexOf(flag); return i >= 0 && i + 1 < opts.length ? opts[i + 1] : null; };
const name = opt('--name') || (cmd[1] || cmd[0] || 'child');
const safeName = String(name).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'child';
const pidfile = opt('--pidfile') || (process.env.CAPHEOS_ROOT ? path.join(process.env.CAPHEOS_ROOT, 'company', 'state', 'supervise', safeName + '.pid') : null);
if (!cmd.length) { console.error('usage: supervise.js [--name N] [--pidfile P] -- <command> [args...]'); process.exit(2); }
let child = null, stopping = false, restarting = false, delay = 1000, startedAt = 0, killTimer = null;
const say = m => console.error('[supervise ' + name + '] ' + m);
function writePid(cpid) {
  if (!pidfile) return;
  try {
    fs.mkdirSync(path.dirname(pidfile), { recursive: true });
    // tmp + rename: a reader (restart tools) never sees half a file
    const tmp = pidfile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ supervisorPid: process.pid, childPid: cpid, name, startedAt: new Date(startedAt || Date.now()).toISOString() }) + '\n');
    fs.renameSync(tmp, pidfile);
  } catch (_) {}
}
function clearPid() { if (pidfile) try { fs.unlinkSync(pidfile); } catch (_) {} }
// A node child gets --disable-sigusr1 (where this node knows it): a stray SIGUSR1 must not open its inspector. Not the
// station (the sidecar is not ours: it may handle SIGUSR1 itself); this supervisor handles SIGUSR1 itself (below).
function childArgv() {
  const isNode = /(^|\/)(node|nodejs)(\d+)?$/.test(cmd[0]);
  if (!isNode || !process.allowedNodeEnvironmentFlags.has('--disable-sigusr1') || cmd.includes('--disable-sigusr1') || cmd.some(a => /(^|\/)sidecar\/index\.js$/.test(a))) return cmd.slice(1);
  return ['--disable-sigusr1'].concat(cmd.slice(1));
}
function start() {
  startedAt = Date.now();
  restarting = false;
  child = spawn(cmd[0], childArgv(), { stdio: 'inherit', env: Object.assign({ CAPHEOS_SUPERVISOR: 'supervise' }, process.env) });
  writePid(child.pid);
  child.on('exit', (code, sig) => {
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    child = null;
    if (stopping) { clearPid(); return process.exit(0); }
    const wait = restarting ? 200 : delay;
    if (restarting || Date.now() - startedAt > 60000) delay = 1000;
    say((restarting ? 'restarting after signal' : 'exited (' + (sig || code) + ')') + '; starting again in ' + wait / 1000 + ' s');
    setTimeout(start, wait);
    if (!restarting) delay = Math.min(delay * 2, 30000);
  });
}
process.on('SIGUSR1', () => {
  if (stopping) return;
  restarting = true;
  if (!child) return;
  say('restart requested (SIGUSR1); stopping child pid ' + child.pid);
  try { child.kill('SIGTERM'); } catch (_) {}
  if (killTimer) clearTimeout(killTimer);
  const target = child;
  killTimer = setTimeout(() => { if (child === target) { say('child did not exit after 15 s; sending SIGKILL'); try { target.kill('SIGKILL'); } catch (_) {} } }, 15000);
  if (killTimer.unref) killTimer.unref();
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = true; if (child) child.kill(s); else { clearPid(); process.exit(0); } });
start();
