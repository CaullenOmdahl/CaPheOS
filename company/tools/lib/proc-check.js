'use strict';
/* lib/proc-check.js — what a process really is, read from /proc, before a tool trusts a pid it was handed.
 *
 *   argvOf(pid)                      the command line (array) or null; argv.cwd is the process's real working folder
 *   startTicks(pid) / ppidOf(pid)    /proc/<pid>/stat field 22 (start time, in ticks since boot) / field 4
 *   scriptOf(argv)                   the script node runs (null for a shell, an editor, an eval)
 *   runsScript(argv, rel, o)         node runs <rel>; with o.root the script must resolve under that root (o.exact: be
 *                                    exactly <root>/<rel>); without it, a path ending /<rel> is enough
 *   isDescendant(pid, ancestor, o)   ancestor is on pid's parent chain (or is pid)
 *   superviseTarget(root, name, rel) read company/state/supervise/<name>.pid and return the pid to signal ONLY when it
 *                                    is verified: the supervisor must be `scripts/supervise.js --name <name>`, else the
 *                                    child must run <rel> under the root. A stale file whose pid was recycled by an
 *                                    unrelated process gives null ("not running"), never a signal.
 * A pidfile is a hint, never an authority: a pid in it can be dead, and the number reused by anything.
 * Same Unix user as the agents: this is a seatbelt against accidents, not a security boundary (provenance.js header). */
const fs = require('fs');
const path = require('path');

const NODE_BIN = /(^|\/)(node|nodejs)(\d+)?$/;
const NODE_ARG_FLAGS = /^(-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print|--input-type|--conditions|-C)$/;
function scriptOf(argv) {
  if (!Array.isArray(argv) || !NODE_BIN.test(String(argv[0] || ''))) return null;
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--') return argv[i + 1] != null ? String(argv[i + 1]) : null;
    if (/^(-e|--eval|-p|--print)$/.test(a)) return null;   // an eval runs no script file
    if (a.startsWith('-')) { if (NODE_ARG_FLAGS.test(a)) i++; continue; }
    return a;
  }
  return null;
}
const real = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
function argvOf(pid) {
  try {
    const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
    if (!argv.length) return null;
    let cwd; try { cwd = fs.realpathSync('/proc/' + pid + '/cwd'); } catch (_) {}
    Object.defineProperty(argv, 'cwd', { value: cwd, enumerable: false });
    return argv;
  } catch (_) { return null; }
}
function statFields(pid) {   // fields 3.. of /proc/<pid>/stat (index 0 = field 3, the state)
  try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); return st.slice(st.lastIndexOf(')') + 2).split(' '); } catch (_) { return null; }
}
const startTicks = pid => { const f = statFields(pid); return f && f[19] ? String(f[19]) : null; };
const ppidOf = pid => { const f = statFields(pid); return f ? Number(f[1]) : null; };
function runsScript(argv, rel, o) {
  o = o || {};
  const s = scriptOf(argv);
  if (!s) return false;
  if (!o.root) return s === rel || s.endsWith('/' + rel);
  const cwd = o.cwd || (argv && argv.cwd);
  const abs = path.isAbsolute(s) ? s : (cwd ? path.resolve(cwd, s) : null);
  if (!abs) return false;
  const r = real(abs), root = real(o.root);
  if (o.exact) return r === path.join(root, rel);
  return r.startsWith(root + path.sep) && r.endsWith(path.sep + rel);
}
function isDescendant(pid, ancestor, o) {
  const parent = (o && o.ppidOf) || ppidOf;
  pid = Number(pid); ancestor = Number(ancestor);
  for (let i = 0; i < 64 && Number.isInteger(pid) && pid > 1; i++) {
    if (pid === ancestor) return true;
    pid = parent(pid);
  }
  return false;
}
// `node scripts/supervise.js [--name N] ...` (options end at `--`)
function isSupervisorArgv(argv, name) {
  const s = scriptOf(argv);
  if (!s || !/(^|\/)scripts\/supervise\.js$/.test(s)) return false;
  const rest = argv.slice(argv.indexOf(s) + 1), end = rest.indexOf('--'), opts = end < 0 ? rest : rest.slice(0, end);
  const i = opts.indexOf('--name');
  return i >= 0 && opts[i + 1] === name;
}
const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function superviseTarget(root, name, rel, o) {
  o = o || {};
  let sup = null;
  try { sup = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'supervise', name + '.pid'), 'utf8')); } catch (_) { return null; }
  if (!sup) return null;
  const get = o.argvOf || argvOf;
  const sp = Number(sup.supervisorPid), cp = Number(sup.childPid);
  if (sp > 1 && alive(sp) && isSupervisorArgv(get(sp), name)) return { pid: sp, signal: 'SIGUSR1', via: 'supervise' };
  if (cp > 1 && alive(cp)) { const a = get(cp); if (a && rel && runsScript(a, rel, { root })) return { pid: cp, signal: 'SIGTERM', via: 'supervise-child' }; }
  return null;
}
module.exports = { scriptOf, argvOf, startTicks, ppidOf, runsScript, isDescendant, isSupervisorArgv, superviseTarget, alive, real };
