'use strict';
/* lib/owned.js — which running processes are provably THIS company's (the reaper and memory.js status use it).
 *
 * Proof is required; without it a process is left alone. A process is this company's only if at least one holds:
 *   path        its --user-data-dir, its working directory (also a deleted one: "<path> (deleted)") or TMPDIR in its
 *               environment is inside this company root (realpath'd; the test is path + separator, so /x/co never
 *               claims /x/co-2)
 *   unit        its /proc/<pid>/cgroup names one of this company's units, by exact name, never a prefix (a company whose
 *               service is cpd-station-2 is not cpd-station's): <svc>.service, the framework's <svc>-console / -dispatch /
 *               -liveness / -liveness-heartbeat, an owner job <svc>-owner-job-<kind>-<14 digits>-<4 hex> (console
 *               owner-ops.js), and a service registered in company/state/services.json under <slug>-svc-*
 *   station-pid its pid is one of this company's recorded station pids (company/state/reaper.json stationPids)
 *   ledger      it is a receipt in .starnet-data/workspaces/proc-ledger.json, matched by pid AND identity (its creation
 *               time when the receipt has one, else its command line AND the receipt's startedAt: a receipt with
 *               neither proves nothing); a reused pid never matches
 * Never this company's to touch, whatever else holds: another uid; a process in a unit or scope this company does not own
 * (an app scope Chrome put itself in is allowed for a driven browser whose profile is ours); the owner's own Chrome (not
 * driven: no --headless / --remote-debugging-*; or no --user-data-dir, the default profile; or a profile under
 * ~/.config); the live station, console or dispatcher
 * (their MainPID); anything matched by name only.
 *
 *   const O = require('./lib/owned');
 *   const c = O.context({ root, config, proc?, home?, cgroupOf?, mainPids?, stationPids? })
 *   O.scan(c)              Map pid -> {pid, ppid, pgid, uid, comm, cmd[], startMs, ageS, rssKB}
 *   O.proof(info, c)       null | {how, detail}
 *   O.foreign(info, c)     true when it sits in a unit or scope this company does not own
 *   O.browsers(c)          this company's driven Chrome main processes, with family pids, PSS, parent kind and idle state
 *   O.strays(c)            this company's processes handed to init / systemd --user, outside its units, with their kind
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const real = p => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
const inside = (p, root) => !!p && !!root && (p === root || p.startsWith(root + path.sep));

function readStationPids(root) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'reaper.json'), 'utf8')); return (j.stationPids || []).map(x => Number(x.pid)).filter(Boolean); } catch (_) { return []; }
}
function readRegistered(root) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'services.json'), 'utf8')); return Object.values(j.services || {}).filter(e => e && e.unit).map(e => e.unit + '.service'); } catch (_) { return []; }
}
function readLedger(root) {
  try { const j = JSON.parse(fs.readFileSync(path.join(root, '.starnet-data', 'workspaces', 'proc-ledger.json'), 'utf8')); return Array.isArray(j.procs) ? j.procs : []; } catch (_) { return []; }
}

function context(o) {
  o = o || {};
  const root = real(o.root);
  const config = o.config || (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8')); } catch (_) { return {}; } })();
  const svc = String((config.station && config.station.serviceName) || 'capheos-station');
  const slug = String(config.slug || config.shortName || 'company').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'company';
  const procRoot = o.proc || '/proc';
  let btime = 0; try { btime = Number((/btime (\d+)/.exec(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8')) || [])[1]) || 0; } catch (_) {}
  return {
    root, config, svc, slug, procRoot, btime, hz: o.hz || 100,
    now: Number.isFinite(o.now) ? o.now : Date.now(),
    home: o.home || os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    stationPids: new Set(o.stationPids || readStationPids(root)),
    mainPids: new Set((o.mainPids || []).map(Number).filter(Boolean)),
    stationMain: Number(o.stationMain) || null,
    ledger: o.ledger || readLedger(root),
    registered: new Set(o.registered || readRegistered(root)),
    cgroupOf: o.cgroupOf || null,
    netTcp: o.netTcp || null,
    tempDirs: (o.tempDirs || [path.join(root, '.starnet-data', 'tmp'), os.tmpdir(), '/tmp']).map(real),
    cache: new Map(),
  };
}

/* ---------------- /proc readers ---------------- */
function rd(c, pid, f) { try { return fs.readFileSync(path.join(c.procRoot, String(pid), f), 'utf8'); } catch (_) { return null; } }
function info(c, pid) {
  const cmdRaw = rd(c, pid, 'cmdline'); const stat = rd(c, pid, 'stat'); const status = rd(c, pid, 'status');
  if (cmdRaw == null || !stat || !status) return null;
  let cmd = cmdRaw.split('\0').filter(Boolean);
  if (cmd.length === 1 && / --/.test(cmd[0])) cmd = cmd[0].split(' ').filter(Boolean);   // Chrome rewrites its argv into one title
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTicks = Number(rest[19]) || 0;
  const cpuTicks = (Number(rest[11]) || 0) + (Number(rest[12]) || 0);   // utime + stime: CPU it has used so far
  const startMs = c.btime ? (c.btime + startTicks / c.hz) * 1000 : null;
  return { pid: Number(pid), ppid: Number(rest[1]), pgid: Number(rest[2]), cmd, comm: (/Name:\s+(\S+)/.exec(status) || [])[1] || '',
    uid: Number((/Uid:\s+(\d+)/.exec(status) || [])[1]), rssKB: Number((/VmRSS:\s+(\d+)/.exec(status) || [])[1] || 0), startMs, cpuTicks,
    ageS: startMs ? Math.max(0, Math.round((c.now - startMs) / 1000)) : null };
}
function scan(c) {
  if (c.cache.has('scan')) return c.cache.get('scan');
  const all = new Map();
  let ents = []; try { ents = fs.readdirSync(c.procRoot); } catch (_) {}
  for (const e of ents) if (/^\d+$/.test(e)) { const i = info(c, e); if (i) all.set(i.pid, i); }
  c.cache.set('scan', all);
  return all;
}
function cwdOf(c, pid) { try { return fs.readlinkSync(path.join(c.procRoot, String(pid), 'cwd')); } catch (_) { return null; } }
function envTmp(c, pid) { const t = rd(c, pid, 'environ'); if (!t) return null; const m = t.split('\0').find(x => x.startsWith('TMPDIR=')); return m ? m.slice(7) : null; }
function cgroup(c, pid) { if (c.cgroupOf) return c.cgroupOf(pid) || ''; return rd(c, pid, 'cgroup') || ''; }
function pssMB(c, pid) {
  const t = rd(c, pid, 'smaps_rollup');
  const m = t && /^Pss:\s+(\d+)/m.exec(t);
  if (m) return Number(m[1]) / 1024;
  const i = scan(c).get(Number(pid)); return i ? i.rssKB / 1024 : 0;
}
const uddOf = i => { const a = i.cmd.find(x => x.startsWith('--user-data-dir=')); return a ? a.slice(16) : null; };

/* ---------------- units ---------------- */
// the innermost unit or scope a process sits in ('' when cgroup v1 or unknown)
function unitOf(c, pid) {
  const segs = String(cgroup(c, pid)).split('\n').map(l => l.split(':').slice(2).join(':')).filter(Boolean).join('/').split('/');
  for (let i = segs.length - 1; i >= 0; i--) if (/\.(service|scope)$/.test(segs[i]) && !/^user@\d+\.service$/.test(segs[i])) return segs[i];
  return '';
}
// the framework's units for this station (systemd/*.in: capheos-station* -> <svc>*, capheos-* -> <svc>-*)
const FW_SUFFIXES = ['', '-console', '-dispatch', '-liveness', '-liveness-heartbeat'];
const OWNER_JOB = /^-owner-job-[a-z][a-z-]{0,40}-\d{14}-[0-9a-f]{4}\.service$/;
const RESTART_JOB = /^-restart-when-idle-\d{14}-[0-9a-f]{4}\.service$/;   // framework-update.js outlast()
function ourUnit(c, u) {
  if (!u) return false;
  if (FW_SUFFIXES.some(x => u === c.svc + x + '.service')) return true;
  if (u.startsWith(c.svc + '-owner-job-') && OWNER_JOB.test(u.slice(c.svc.length))) return true;
  if (u.startsWith(c.svc + '-restart-when-idle-') && RESTART_JOB.test(u.slice(c.svc.length))) return true;
  return u.startsWith(c.slug + '-svc-') && /\.(service|scope)$/.test(u) && c.registered.has(u.replace(/\.scope$/, '.service'));
}
const APP_SCOPE = /^app-(?:com\.google\.Chrome|org\.chromium\.Chromium|google-chrome|chromium)[-@].*\.scope$/;

/* ---------------- proof ---------------- */
function proof(i, c) {
  const root = c.root;
  const udd = uddOf(i);
  if (udd && inside(real(udd), root)) return { how: 'path', detail: 'profile ' + udd };
  let cwd = cwdOf(c, i.pid);
  if (cwd) { const del = / \(deleted\)$/.test(cwd); cwd = cwd.replace(/ \(deleted\)$/, ''); if (inside(del ? path.resolve(cwd) : real(cwd), root)) return { how: 'path', detail: 'working folder ' + cwd + (del ? ' (deleted)' : '') }; }
  const tmp = envTmp(c, i.pid);
  if (tmp && inside(real(tmp), root)) return { how: 'path', detail: 'TMPDIR ' + tmp };
  const u = unitOf(c, i.pid);
  if (ourUnit(c, u)) return { how: 'unit', detail: u };
  if (c.stationPids.has(i.pid)) return { how: 'station-pid', detail: 'station pid ' + i.pid };
  for (const r of c.ledger) {
    if (Number(r.pid) !== i.pid) continue;
    if (Number(r.created) > 0 && i.startMs) { if (Math.abs(Number(r.created) - i.startMs) <= 2000) return { how: 'ledger', detail: (r.kind || 'proc') + ' receipt' }; continue; }
    // by command line only with a time to check it against: a receipt without startedAt (or a process whose start time
    // is unknown) proves nothing, since a reused pid may run a command that starts the same way
    const rec = String(r.cmd || '').trim(); const live = i.cmd.join(' ');
    if (!(Number(r.startedAt) > 0) || !i.startMs) continue;
    if (rec && (live === rec || live.startsWith(rec) || (rec.length >= 24 && live.includes(rec.slice(0, 200))))) {
      if (i.startMs <= Number(r.startedAt) + 5000) return { how: 'ledger', detail: (r.kind || 'proc') + ' receipt' };
    }
  }
  return null;
}
function isChrome(i) { return /chrom/i.test(path.basename(i.cmd[0] || '')) || /^chrom/i.test(i.comm); }
const driven = i => i.cmd.some(a => /^--(headless|remote-debugging-port|remote-debugging-pipe)\b/.test(a));
function ownersChrome(i, c) {
  if (!isChrome(i)) return false;
  if (!driven(i)) return true;
  const udd = uddOf(i);
  if (!udd) return true;   // no --user-data-dir: Chrome runs on the default profile under ~/.config, the owner's own
  return inside(real(udd), real(path.join(c.home, '.config')));
}
function foreign(i, c) {
  const u = unitOf(c, i.pid);
  if (!u || ourUnit(c, u)) return false;
  if (APP_SCOPE.test(u) && isChrome(i) && driven(i)) return false;
  return true;
}
function touchable(i, c) {
  if (c.uid !== null && i.uid !== c.uid) return false;
  if (i.pid === process.pid || c.mainPids.has(i.pid)) return false;
  if (ownersChrome(i, c)) return false;
  if (foreign(i, c)) return false;
  return true;
}

/* ---------------- browsers ---------------- */
function isInit(c, ppid) { if (ppid <= 1) return true; const p = scan(c).get(ppid); return !p || p.comm === 'systemd'; }
function isStationProc(c, pid) {
  if (!pid) return false;
  if (c.stationMain && pid === c.stationMain) return true;
  const p = scan(c).get(pid);
  return !!p && c.stationPids.has(pid) && p.cmd.some(a => /sidecar[\/\\]index\.js$/.test(a));
}
function tcpText(c) {
  if (c.netTcp) return c.netTcp;
  return ['tcp', 'tcp6'].map(f => { try { return fs.readFileSync(path.join(c.procRoot, 'net', f), 'utf8'); } catch (_) { return ''; } }).join('\n');
}
// any ESTABLISHED connection whose REMOTE port is the browser's debugging port: a client is attached to it
function clientOnPort(c, port) {
  if (!port) return false;
  for (const l of tcpText(c).split('\n')) {
    const f = l.trim().split(/\s+/); if (f.length < 4 || !/:/.test(f[2] || '')) continue;
    if (f[3] !== '01') continue;
    if (parseInt(f[2].split(':')[1], 16) === port) return true;
  }
  return false;
}
function portOf(i) {
  const a = i.cmd.find(x => x.startsWith('--remote-debugging-port=')); const n = a ? Number(a.split('=')[1]) : 0;
  if (n > 0) return n;
  const udd = uddOf(i);
  if (udd) { try { const p = Number(fs.readFileSync(path.join(udd, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (p > 0) return p; } catch (_) {} }
  return 0;
}
function browsers(c) {
  const all = scan(c); const out = [];
  for (const i of all.values()) {
    if (!isChrome(i) || i.cmd.some(a => a.startsWith('--type=')) || !driven(i)) continue;
    if (!touchable(i, c)) continue;
    const pr = proof(i, c); if (!pr) continue;
    const udd = uddOf(i);
    const family = [i].concat([...all.values()].filter(x => x.pid !== i.pid && ((udd && x.cmd.some(a => a === '--user-data-dir=' + udd)) || x.ppid === i.pid)));
    const parent = isStationProc(c, i.ppid) ? 'station' : isInit(c, i.ppid) ? 'orphan' : 'live';
    const port = portOf(i); const pipe = i.cmd.some(a => a === '--remote-debugging-pipe');
    const idle = pipe ? parent === 'orphan' : !clientOnPort(c, port);
    const u = unitOf(c, i.pid);
    out.push({ pid: i.pid, pgid: i.pgid, ppid: i.ppid, profile: udd, ageS: i.ageS, startMs: i.startMs, pids: family.map(x => x.pid), pssMB: Math.round(family.reduce((s, x) => s + pssMB(c, x.pid), 0)),
      parent, port, pipe, idle, inUnit: ourUnit(c, u), unit: u || null, proof: pr, cwd: (cwdOf(c, i.pid) || '').replace(/ \(deleted\)$/, '') || null });
  }
  return out;
}

/* ---------------- strays ---------------- */
const KINDS = [
  { kind: 'flutter_tester', re: /(^|\/)flutter_tester(\s|$)/ },
  { kind: 'dart frontend_server', re: /dart.*frontend_server/ },
  { kind: 'dart analysis_server', re: /dart.*analysis_server/ },
  { kind: 'gradle daemon', re: /GradleDaemon/, idleH: 3 },
  { kind: 'kotlin daemon', re: /kotlin-daemon|KotlinCompileDaemon/, idleH: 3 },
  { kind: 'esbuild service', re: /esbuild.*--service/ },
  { kind: 'mock station', re: /node.*(mock-api\.js|-walk\.js)(\s|$)/ },
  { kind: 'pytest', re: /(^|[\s\/])(py\.test|pytest)(\s|$)|-m pytest/ },
];
function kindInfo(i) { const line = i.cmd.join(' '); return KINDS.find(k => k.re.test(line)) || null; }
function kindOf(i, c) {
  const k = kindInfo(i); if (k) return k.kind;
  const line = i.cmd.join(' ');
  if (/sidecar[\/\\]index\.js(\s|$)/.test(line)) {
    const cwd = cwdOf(c, i.pid) || '';
    if (/ \(deleted\)$/.test(cwd) || /[\/\\](scratch|tmp)[\/\\]/.test(cwd)) return 'test station';
  }
  return null;
}
function strays(c, opts) {
  opts = opts || {};
  const minAgeS = Number.isFinite(opts.minAgeS) ? opts.minAgeS : 6 * 3600;
  const all = scan(c); const out = [];
  for (const i of all.values()) {
    if (!isInit(c, i.ppid) || i.ppid === i.pid) continue;
    if (isChrome(i)) continue;                       // browsers are the browser step's
    if (!touchable(i, c)) continue;
    const u = unitOf(c, i.pid); if (ourUnit(c, u)) continue;   // inside a company unit: it belongs to that unit's life
    if (c.registered.has(u)) continue;
    if (i.comm === 'systemd' || i.pid <= 1) continue;
    if (i.pid === c.stationMain || c.stationPids.has(i.pid)) continue;   // the station itself (now or a recorded one) is never a stray
    const pr = proof(i, c); if (!pr || pr.how === 'unit') continue;
    if (i.ageS != null && i.ageS < minAgeS) continue;
    const k = kindInfo(i);
    // idleH: a daemon that serves builds (Gradle, Kotlin) is ended only after that long without using any CPU (the
    // reaper keeps cpuTicks between runs), never for its age alone: a long-lived daemon may be serving a build right now
    out.push({ pid: i.pid, pgid: i.pgid, comm: i.comm, cmd: i.cmd.join(' ').slice(0, 300), ageS: i.ageS, startMs: i.startMs, cpuTicks: i.cpuTicks, rssMB: Math.round(i.rssKB / 1024), kind: kindOf(i, c), idleH: k && k.idleH || null, proof: pr, cwd: (cwdOf(c, i.pid) || '') || null });
  }
  return out;
}
// an argument names the path `p` exactly: --user-data-dir=<p>, or <p> as a whole path (start of the argument or after
// '=', then the end or a separator), so /x/.browser-profile never matches /x/.browser-profile-2
function namesPath(a, p) {
  if (!p) return false;
  if (a === '--user-data-dir=' + p) return true;
  for (let i = a.indexOf(p); i >= 0; i = a.indexOf(p, i + 1)) {
    const before = i === 0 ? '' : a.charAt(i - 1); const after = a.charAt(i + p.length);
    if ((before === '' || before === '=') && (after === '' || after === '/' || after === path.sep)) return true;
  }
  return false;
}
// Chrome processes (other than this one) whose arguments name the profile `p` exactly (every helper of that browser:
// crashpad's --database=<p>/Crashpad among them), that this company may touch (same uid, not a live main, not in a
// unit or scope it does not own). Only Chrome: a crew command that names the path is never one of a browser's helpers.
function naming(c, p) { return [...scan(c).values()].filter(i => i.pid !== process.pid && isChrome(i) && (c.uid === null || i.uid === c.uid) && !c.mainPids.has(i.pid) && !foreign(i, c) && i.cmd.some(a => namesPath(a, p))).map(i => i.pid); }

module.exports = { FW_SUFFIXES, OWNER_JOB, RESTART_JOB, readRegistered, context, scan, proof, foreign, touchable, browsers, strays, naming, namesPath, unitOf, ourUnit, inside, real, clientOnPort, portOf, kindOf, isChrome, driven, uddOf, KINDS, readStationPids };
