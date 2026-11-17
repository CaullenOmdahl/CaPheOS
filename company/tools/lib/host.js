'use strict';
/* lib/host.js — what kind of machine the company runs on, for the parts that differ on a server or in a container.
 *
 *   host.supervisor()   'container' (env CAPHEOS_SUPERVISOR=container, /.dockerenv or /run/.containerenv), another
 *                       CAPHEOS_SUPERVISOR value ('supervise': scripts/supervise.js), 'systemd' (a systemd user manager:
 *                       XDG_RUNTIME_DIR/systemd exists) or 'none'
 *   host.linger([user]) { state: 'on'|'off'|'unknown'|'n/a', user, fix? } — systemd user lingering. Off on a server
 *                       means every `systemctl --user` unit (the station, the dispatcher, the console) is stopped the
 *                       moment the account's last login session ends, e.g. when the owner's SSH session closes.
 *                       'n/a' in a container (the container's own supervisor keeps the processes, not systemd).
 *                       Env LOGINCTL names the loginctl to run (tests put a stand-in there).
 *   node company/tools/lib/host.js [--json]    print both
 */
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

function supervisor(env, exists) {
  env = env || process.env; exists = exists || fs.existsSync;
  if (env.CAPHEOS_SUPERVISOR === 'container' || exists('/.dockerenv') || exists('/run/.containerenv')) return 'container';
  if (env.CAPHEOS_SUPERVISOR && env.CAPHEOS_SUPERVISOR !== 'systemd') return env.CAPHEOS_SUPERVISOR;   // e.g. 'supervise' (scripts/supervise.js), 'none'
  const rt = env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? '/run/user/' + process.getuid() : '');
  return rt && exists(rt + '/systemd') ? 'systemd' : 'none';
}
function linger(user, opts) {
  opts = opts || {}; const env = opts.env || process.env;
  const u = user || env.USER || (() => { try { return os.userInfo().username; } catch (_) { return ''; } })();
  if (supervisor(env, opts.exists) === 'container') return { state: 'n/a', user: u, why: 'in a container the container runtime keeps the processes running, not systemd' };
  const fix = 'sudo loginctl enable-linger ' + u + '   (once, by whoever administers the server; or `loginctl enable-linger` as ' + u + ' where polkit allows it)';
  const r = spawnSync(env.LOGINCTL || 'loginctl', ['show-user', u, '--property=Linger', '--value'], { encoding: 'utf8', timeout: 5000, env });
  if (r.error || r.status !== 0) {
    // no session record for the user (never logged in, or the manager is not running) reads as "no linger" on systemd
    const msg = String((r.stderr || '') + (r.error ? r.error.message : '')).trim();
    if (/not logged in|No such|does not exist|not found/i.test(msg) && !r.error) return { state: 'off', user: u, fix };
    return { state: 'unknown', user: u, why: msg || 'loginctl did not answer', fix };
  }
  const v = String(r.stdout || '').trim().toLowerCase();
  return v === 'yes' ? { state: 'on', user: u } : v === 'no' ? { state: 'off', user: u, fix } : { state: 'unknown', user: u, why: 'loginctl said ' + JSON.stringify(v), fix };
}
module.exports = { supervisor, linger };

if (require.main === module) {
  const out = { supervisor: supervisor(), linger: linger() };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 1));
  else console.log('supervisor: ' + out.supervisor + '\nlinger: ' + out.linger.state + (out.linger.fix && out.linger.state !== 'on' ? '\n  fix: ' + out.linger.fix : ''));
}
