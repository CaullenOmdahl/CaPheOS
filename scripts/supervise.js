#!/usr/bin/env node
/* supervise.js — keep one process running without systemd: the adapter for a container (or any box without a systemd
 * user manager). It starts the command, starts it again whenever it exits (1 s, doubling to 30 s while it keeps
 * failing; back to 1 s after a minute up), and passes SIGTERM / SIGINT on and stops.
 *
 *   node scripts/supervise.js [--name console] -- node console/server.js
 *
 * The child gets CAPHEOS_SUPERVISOR=supervise (unless set), so the console restarts itself by exiting when no chat is
 * streaming (console/owner-ops.js) instead of calling systemctl. Nothing it keeps is lost on a restart: the console's
 * sessions are signed cookies (console/auth.js) and every other state is on disk under the company root.
 */
'use strict';
const { spawn } = require('child_process');
const a = process.argv.slice(2);
const dd = a.indexOf('--');
const cmd = dd >= 0 ? a.slice(dd + 1) : [];
const ni = a.indexOf('--name'); const name = ni >= 0 && ni < (dd < 0 ? a.length : dd) ? a[ni + 1] : (cmd[1] || cmd[0] || 'child');
if (!cmd.length) { console.error('usage: supervise.js [--name N] -- <command> [args...]'); process.exit(2); }
let child = null, stopping = false, delay = 1000, startedAt = 0;
const say = m => console.error('[supervise ' + name + '] ' + m);
function start() {
  startedAt = Date.now();
  child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: Object.assign({ CAPHEOS_SUPERVISOR: 'supervise' }, process.env) });
  child.on('exit', (code, sig) => {
    child = null; if (stopping) return process.exit(0);
    if (Date.now() - startedAt > 60000) delay = 1000;
    say('exited (' + (sig || code) + '); starting again in ' + delay / 1000 + ' s');
    setTimeout(start, delay); delay = Math.min(delay * 2, 30000);
  });
}
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { stopping = true; if (child) child.kill(s); else process.exit(0); });
start();
