#!/usr/bin/env node
/* tmp-sweep.js — temp files and headless browsers that nobody uses any more are removed, so a long-running company does
 * not slowly fill RAM. On most Linux hosts /tmp is a tmpfs: every byte left there is memory, and swap once memory is full.
 *
 *   node company/tools/tmp-sweep.js status [--dir D]... [--json]        what would go and why; touches nothing
 *   node company/tools/tmp-sweep.js apply  [--dir D]... [--class c,c] [--min-age SECONDS] [--json]
 *                                                                         remove what is old enough and not in use
 *   node company/tools/tmp-sweep.js browsers [--apply] [--json]          headless browsers left running on a temp profile
 *                                                                         after whatever started them died (listed; ended
 *                                                                         with --apply)
 *   node company/tools/tmp-sweep.js selftest
 *
 * Which dirs: os.tmpdir(), /tmp, and the company's own private temp dir <root>/.starnet-data/tmp (the station, the
 * dispatcher and the console run with TMPDIR there: scripts/setup-station.sh). --dir replaces the list.
 *
 * What may go — only these classes, each with its own minimum age (the newest mtime inside the entry, a bounded walk):
 *   test      CaPheOS test walks and selftests (console-walk-*, routes-walk-*, *-chrome-*, *-selftest-*, capheos-test-*),
 *             and page-preview-* (lib/page-preview.js screenshots, 45 s at most)                                     2 h
 *   build     build leftovers of the crew's Flutter / web / Dart work (bs-*, flutter_tools.*, initialize_from.dill*)    6 h
 *   chrome    Chrome's own temp entries (com.google.Chrome.*, .com.google.Chrome.*, .org.chromium.Chromium.*)          12 h
 *   pytmp     Python tempfile dirs (tmpXXXXXXXX) a test made and never removed                                       12 h
 *   starnet   station leftovers tagged with a pid that is no longer running (starnet-browser-<pid>*, starnet-claude-
 *             cli-<pid>-*: at once), and StarNet test-run dirs (starnet-*-XXXXXX, *.recovery-owner.json.generations)  24 h
 *   private   anything in the company's own private temp dir                                                         24 h
 * Never: an entry owned by another user; anything else in a shared temp dir (another program's files are not ours);
 * starnet-upload-staging-* (the station sweeps it itself); an entry IN USE. In use means some running process has a file
 * open inside it, its working directory or root inside it, a file mapped from it, a listening unix socket inside it, or its
 * command line naming it (a browser's --user-data-dir, a mock station's --root). Removal never follows a symlink.
 *
 * Browsers: a Chrome/Chromium main process whose --user-data-dir is inside one of the temp dirs and whose parent is gone
 * (it was handed to pid 1 or the user's systemd), started headless or for remote debugging (driven, not a window a person
 * opened), older than an hour. A browser the station runs has the station as its
 * parent; the owner's own Chrome has no temp profile; neither is ever listed. --apply sends SIGTERM, then SIGKILL to every
 * process still naming that profile.
 *
 * Scope: each class is 'own' (test, private; starnet leftovers of THIS company's recorded station pids) or 'host' (build,
 * chrome, pytmp, starnet of an unknown pid: names any program on the machine makes, the owner's and another company's
 * too). The automatic sweep (`tick`, which company/tools/reaper.js runs) takes the 'own' scope only; the 'host' classes
 * are cleared only by the owner (reaper.js host-sweep --apply --by owner, or this CLI by hand). `tick` runs at most once
 * an hour, in a company scripts/setup-station.sh set up (its private temp dir exists; CAPHEOS_TMP_SWEEP=0 turns it off).
 * State: company/state/tmp-sweep.json (the last run, what it freed). Browsers: the reaper ends left-behind ones, with proof
 * that they are this company's (lib/owned.js); `browsers` here stays an owner CLI.
 * Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = 3600;
// scope: 'own' = provably this company's or the framework's own (framework test names are unique to CaPheOS; the private
// dir is the company's); 'host' = names any program makes (the owner's own Python, Chrome and builds, another company's):
// only an owner action clears those (reaper.js host-sweep --apply --by owner), never the automatic sweep.
const CLASSES = {
  test: { scope: 'own', minAge: 2 * H, re: [/^(console|today|routes|alarm|services|service-keys|connect|mm|page-kit|huddle)-walk-/, /^(chatwin|chatact|chatres)-/,
    /-chrome-[A-Za-z0-9]{6}$/, /-selftest-[A-Za-z0-9]{6}$/, /^capheos-test-/, /^capheos-test-start\./, /^meeting-ui-/, /^page-preview-/] },
  build: { scope: 'host', minAge: 6 * H, re: [/^bs-/, /^flutter_tools\./, /^initialize_from\.dill/] },
  chrome: { scope: 'host', minAge: 12 * H, re: [/^\.?com\.google\.Chrome\./, /^\.org\.chromium\.Chromium\./] },
  pytmp: { scope: 'host', minAge: 12 * H, re: [/^tmp[a-z0-9_]{8}$/], dirOnly: true },
  starnet: { scope: 'host', minAge: 24 * H, re: [/^starnet-.*-[A-Za-z0-9]{6}$/, /^starnet-.*\.recovery-owner\.json\.generations$/] },
  private: { scope: 'own', minAge: 24 * H, re: [/./] },
};
const NEVER = [/^starnet-upload-staging-/, /^claude-/, /^systemd-private-/, /^\.X11-unix$/, /^\.ICE-unix$/, /^tmux-/, /^ssh-/];
const PID_TAGGED = /^starnet-(?:browser|claude-cli)-(\d+)(?:$|-)/;
const WALK_CAP = 3000;

function privateDir(root) { return path.join(root, '.starnet-data', 'tmp'); }
function defaultDirs(root) {
  const out = [os.tmpdir(), '/tmp'];
  if (root) out.push(privateDir(root));
  return [...new Set(out.map(d => path.resolve(d)))].filter(d => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// the class of one entry, or null when it is not ours to remove
// o.stationPids: this company's recorded station pids (reaper.json): a pid-tagged station leftover is the company's own only
// when its pid is one of them; any other ended pid is the host's (another company's station, a StarNet test run)
function classify(name, isDir, isPrivate, o) {
  if (NEVER.some(r => r.test(name))) return null;
  const tagged = PID_TAGGED.exec(name);
  if (tagged) {
    if ((o.alive || pidAlive)(Number(tagged[1]))) return null;
    const mine = isPrivate || !!(o.stationPids && o.stationPids.has(Number(tagged[1])));
    return { cls: 'starnet', scope: mine ? 'own' : 'host', minAge: 0, why: 'its process ' + tagged[1] + ' has ended' + (mine && !isPrivate ? ' (one of this company\'s stations)' : '') };
  }
  for (const [cls, c] of Object.entries(CLASSES)) {
    if (cls === 'private') continue;
    if (c.dirOnly && !isDir) continue;
    if (c.re.some(r => r.test(name))) return { cls, scope: isPrivate ? 'own' : c.scope, minAge: c.minAge };
  }
  if (isPrivate) return { cls: 'private', scope: 'own', minAge: CLASSES.private.minAge };
  return null;
}

// the newest mtime and the bytes inside an entry, a bounded walk that never follows a symlink
function measure(p) {
  let newest = 0, bytes = 0, n = 0, capped = false;
  const stack = [p];
  while (stack.length) {
    const q = stack.pop();
    let st; try { st = fs.lstatSync(q); } catch (_) { continue; }
    newest = Math.max(newest, st.mtimeMs); bytes += st.isDirectory() ? 0 : st.blocks * 512;
    if (++n >= WALK_CAP) { capped = true; break; }
    if (st.isDirectory()) { try { for (const e of fs.readdirSync(q)) stack.push(path.join(q, e)); } catch (_) {} }
  }
  return { newest, bytes, capped };
}

/* every path a running process holds: open files, cwd, root, mapped files, command-line arguments, unix sockets.
   Returns the set of top-level entry names inside each dir that something holds. Linux /proc; elsewhere nothing
   is known to be held, so apply refuses to run (inUse.known false). */
function heldNames(dirs, o) {
  const procRoot = (o && o.proc) || '/proc';
  const held = new Map(dirs.map(d => [d, new Set()]));
  let known = false;
  const note = p => {
    if (!p || p[0] !== '/') return;
    for (const d of dirs) {
      if (p.length > d.length + 1 && p.startsWith(d + '/')) { held.get(d).add(p.slice(d.length + 1).split('/')[0].replace(/ \(deleted\)$/, '')); }
    }
  };
  let pids = [];
  try { pids = fs.readdirSync(procRoot).filter(e => /^\d+$/.test(e)); known = true; } catch (_) {}
  for (const pid of pids) {
    const base = path.join(procRoot, pid);
    for (const l of ['cwd', 'root', 'exe']) { try { note(fs.readlinkSync(path.join(base, l))); } catch (_) {} }
    try { for (const fd of fs.readdirSync(path.join(base, 'fd'))) { try { note(fs.readlinkSync(path.join(base, 'fd', fd))); } catch (_) {} } } catch (_) {}
    try { for (const line of fs.readFileSync(path.join(base, 'maps'), 'utf8').split('\n')) { const i = line.indexOf('/'); if (i > 0) note(line.slice(i)); } } catch (_) {}
    try {
      for (const a of fs.readFileSync(path.join(base, 'cmdline'), 'utf8').split('\0')) {
        for (const d of dirs) { let i = a.indexOf(d + '/'); while (i >= 0) { note(a.slice(i).split(/[\s'"=,;:]/)[0]); i = a.indexOf(d + '/', i + 1); } }
      }
    } catch (_) {}
  }
  try { for (const line of fs.readFileSync(path.join(procRoot, 'net', 'unix'), 'utf8').split('\n').slice(1)) { const f = line.trim().split(/\s+/); note(f[7]); } } catch (_) {}
  return { held, known };
}

function scan(opt) {
  const o = opt || {};
  const root = o.root === undefined ? safeRoot() : o.root;
  const dirs = (o.dirs && o.dirs.length ? o.dirs : defaultDirs(root)).map(d => path.resolve(d));
  const priv = root ? path.resolve(privateDir(root)) : null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const only = o.classes ? new Set(o.classes) : null;
  const inUse = o.held || heldNames(dirs, o);
  const items = [];
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const name of names) {
      const p = path.join(d, name);
      let st; try { st = fs.lstatSync(p); } catch (_) { continue; }
      if (uid !== null && st.uid !== uid) continue;
      const c = classify(name, st.isDirectory(), d === priv, o);
      if (!c || (only && !only.has(c.cls)) || (o.scope && c.scope !== o.scope)) continue;
      const m = measure(p);
      const ageS = Math.max(0, (now - m.newest) / 1000);
      const minAge = Number.isFinite(o.minAge) ? Math.min(o.minAge, c.minAge) : d === priv && Number.isFinite(o.privateMinAge) ? Math.min(o.privateMinAge, c.minAge) : c.minAge;
      const busy = inUse.held.get(d) && inUse.held.get(d).has(name);
      const go = !busy && ageS >= minAge;
      items.push({ dir: d, name, cls: c.cls, scope: c.scope, bytes: m.bytes, ageS: Math.round(ageS), minAge, busy: !!busy, go, why: busy ? 'in use' : go ? (c.why || 'older than ' + fmtAge(minAge)) : 'touched ' + fmtAge(ageS) + ' ago' });
    }
  }
  return { dirs, items, known: inUse.known };
}

function safeRoot() { try { return require('./lib/company').ROOT; } catch (_) { return null; } }
const fmtAge = s => s >= H ? (s / H).toFixed(s >= 10 * H ? 0 : 1) + ' h' : Math.round(s / 60) + ' min';
const fmtMB = b => (b / 1048576).toFixed(b >= 1048576 * 100 ? 0 : 1) + ' MB';

function apply(opt) {
  const o = opt || {};
  const s = scan(o);
  if (!s.known) return Object.assign(s, { removed: [], freed: 0, refused: 'cannot see running processes (/proc); nothing removed' });
  const removed = []; let freed = 0; const errors = [];
  for (const it of s.items) {
    if (!it.go) continue;
    if (o.dry) { removed.push(it); freed += it.bytes; continue; }
    try { fs.rmSync(path.join(it.dir, it.name), { recursive: true, force: true }); removed.push(it); freed += it.bytes; }
    catch (e) { errors.push(it.name + ': ' + e.message); }
  }
  return Object.assign(s, { removed, freed, errors });
}

/* ---------------- browsers left running on a temp profile ---------------- */
function procInfo(procRoot, pid) {
  try {
    let cmd = fs.readFileSync(path.join(procRoot, pid, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    if (cmd.length === 1 && / --/.test(cmd[0])) cmd = cmd[0].split(' ').filter(Boolean);   // Chrome rewrites its argv into one space-joined title
    const stat = fs.readFileSync(path.join(procRoot, pid, 'stat'), 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const status = fs.readFileSync(path.join(procRoot, pid, 'status'), 'utf8');
    const rss = Number((/VmRSS:\s+(\d+)/.exec(status) || [])[1] || 0) * 1024;
    const uid = Number((/Uid:\s+(\d+)/.exec(status) || [])[1]);
    return { pid: Number(pid), cmd, ppid: Number(rest[1]), start: Number(rest[19]), rss, uid, comm: (/Name:\s+(\S+)/.exec(status) || [])[1] || '' };
  } catch (_) { return null; }
}
function browsers(opt) {
  const o = opt || {};
  const procRoot = o.browserProc || o.proc || '/proc';
  const root = o.root === undefined ? safeRoot() : o.root;
  const dirs = (o.dirs && o.dirs.length ? o.dirs : defaultDirs(root)).map(d => path.resolve(d));
  const minAge = Number.isFinite(o.minAge) ? o.minAge : H;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  let btime = 0, hz = 100;
  try { btime = Number((/btime (\d+)/.exec(fs.readFileSync(path.join(procRoot, 'stat'), 'utf8')) || [])[1]); } catch (_) {}
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const all = new Map();
  try { for (const e of fs.readdirSync(procRoot)) if (/^\d+$/.test(e)) { const i = procInfo(procRoot, e); if (i) all.set(i.pid, i); } } catch (_) {}
  const isInit = ppid => { if (ppid <= 1) return true; const p = all.get(ppid); return !!p && p.comm === 'systemd'; };
  const out = [];
  for (const i of all.values()) {
    if (uid !== null && i.uid !== uid) continue;
    if (!/chrom/i.test(path.basename(i.cmd[0] || ''))) continue;
    if (i.cmd.some(a => a.startsWith('--type='))) continue;
    if (!i.cmd.some(a => /^--(headless|remote-debugging-port|remote-debugging-pipe)\b/.test(a))) continue;   // a driven browser, never one a person opened
    const udd = (i.cmd.find(a => a.startsWith('--user-data-dir=')) || '').slice(16);
    if (!udd || !dirs.some(d => path.resolve(udd).startsWith(d + '/'))) continue;
    if (!isInit(i.ppid)) continue;
    const ageS = btime ? now / 1000 - (btime + i.start / hz) : Infinity;
    const family = [...all.values()].filter(x => x.cmd.some(a => a === '--user-data-dir=' + udd));
    out.push({ pid: i.pid, profile: udd, ageS: Math.round(ageS), rss: family.reduce((s, x) => s + x.rss, 0), pids: family.map(x => x.pid), go: ageS >= minAge });
  }
  if (o.apply) {
    const kill = o.kill || ((pid, sig) => { try { process.kill(pid, sig); } catch (_) {} });
    const wait = o.wait || (ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} });
    const go = out.filter(b => b.go);
    for (const b of go) kill(b.pid, 'SIGTERM');
    if (go.length) wait(3000);
    for (const b of go) for (const pid of b.pids) if (o.kill || pidAlive(pid)) kill(pid, 'SIGKILL');
    for (const b of go) b.ended = true;
  }
  return { dirs, browsers: out };
}

/* ---------------- the automatic sweep (reaper.js runs it; scope own) ---------------- */
function tick(opt) {
  const o = opt || {};
  const root = o.root === undefined ? safeRoot() : o.root;
  const log = o.log || (() => {});
  const stateFile = root ? path.join(root, 'company', 'state', 'tmp-sweep.json') : null;
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (!o.force && st.lastRun && now - st.lastRun < (o.everyMs || 3600e3)) return { skipped: 'ran ' + Math.round((now - st.lastRun) / 60000) + ' min ago' };
  // only a set-up company sweeps: scripts/setup-station.sh makes the private temp dir; a test's temp root has none, so a
  // unit test that runs a dispatcher tick never touches the host's /tmp. CAPHEOS_TMP_SWEEP=0 turns it off (scripts/test.sh).
  if (process.env.CAPHEOS_TMP_SWEEP === '0' && !o.force) return { skipped: 'CAPHEOS_TMP_SWEEP=0' };
  if (!o.dirs && !(root && fs.existsSync(privateDir(root)))) return { skipped: 'no ' + (root ? privateDir(root) : 'company root') + ' (not a set-up company)' };
  // own scope only: the private dir and, in the shared dirs, the framework's test names and this company's own station
  // leftovers. Left-behind browsers are the reaper's (reaper.js: proof that a browser is this company's, not a temp profile)
  const ended = [];
  const r = apply(Object.assign({}, o, { root, scope: 'own' }));
  const byCls = {};
  for (const it of r.removed) byCls[it.cls] = (byCls[it.cls] || 0) + it.bytes;
  if (r.removed.length || ended.length) {
    log('TMP SWEEP' + (o.dry ? ' (dry run)' : '') + ': ' + r.removed.length + ' temp entries, ' + fmtMB(r.freed) +
      (Object.keys(byCls).length ? ' (' + Object.entries(byCls).map(([k, v]) => k + ' ' + fmtMB(v)).join(', ') + ')' : '') +
      (ended.length ? '; ' + ended.length + ' left-behind browser(s) ended, ' + fmtMB(ended.reduce((s, x) => s + x.rss, 0)) + ' of memory' : '') +
      (r.errors && r.errors.length ? '; ERRORS: ' + r.errors.join('; ').slice(0, 200) : ''));
  }
  if (r.refused) log('TMP SWEEP: ' + r.refused);
  if (stateFile && !o.dry) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const t = stateFile + '.tmp-' + process.pid;
      fs.writeFileSync(t, JSON.stringify({ v: 1, lastRun: now, removed: r.removed.length, freedBytes: r.freed, byClass: byCls, browsersEnded: ended.length }, null, 1) + '\n');
      fs.renameSync(t, stateFile);
    } catch (_) {}
  }
  return { removed: r.removed.length, freed: r.freed, browsersEnded: ended.length, refused: r.refused };
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const assert = require('assert');
  const cp = require('child_process');
  let fails = 0;
  const check = async (name, fn) => { try { await fn(); console.log('ok   ' + name); } catch (e) { fails++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); } };
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-sweep-selftest-'));
  const shared = path.join(T, 'shared'); const root = path.join(T, 'co'); const priv = privateDir(root);
  fs.mkdirSync(shared, { recursive: true }); fs.mkdirSync(priv, { recursive: true });
  const old = Date.now() / 1000 - 30 * H;
  const mk = (dir, name, opts) => {
    const p = path.join(dir, name);
    if (opts && opts.file) fs.writeFileSync(p, 'x'.repeat(4096)); else { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'f'), 'x'.repeat(4096)); }
    if (!(opts && opts.fresh)) { for (const q of [path.join(p, 'f'), p]) { try { fs.utimesSync(q, old, old); } catch (_) {} } }
    return p;
  };
  const kids = [];
  try {
    mk(shared, 'routes-walk-Ab12Cd'); mk(shared, 'meeting-ui-chrome-Zz99yy'); mk(shared, 'bs-web-build-info-x1'); mk(shared, 'flutter_tools.Qw3rTy');
    mk(shared, 'com.google.Chrome.aBcDeF'); mk(shared, 'tmpab12cd_9'); mk(shared, 'tmpfile12345', { file: true });   // a file named like pytmp: not a dir, stays
    mk(shared, 'ytmusic-dir-123'); mk(shared, 'someone-elses-thing'); mk(shared, 'starnet-upload-staging-85cd4b');
    mk(shared, 'console-walk-Fresh1', { fresh: true }); mk(shared, 'starnet-browser-999999-abc', { fresh: true });
    mk(shared, 'starnet-browser-' + process.pid, { fresh: true });
    const busy = mk(shared, 'today-walk-BusyX1');
    mk(priv, 'anything-at-all'); mk(priv, 'young-one', { fresh: true });
    // a process with its cwd inside one entry, and another naming one in its command line
    kids.push(cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: busy, stdio: 'ignore' }));
    const named = mk(shared, 'chatwin-Named1');
    kids.push(cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)', '--', '--user-data-dir=' + named], { stdio: 'ignore' }));
    await new Promise(r => setTimeout(r, 300));

    await check('status: classes, ages, in-use and never-ours decided per entry', () => {
      const s = scan({ dirs: [shared, priv], root });
      const by = Object.fromEntries(s.items.map(i => [i.name, i]));
      for (const n of ['routes-walk-Ab12Cd', 'meeting-ui-chrome-Zz99yy', 'bs-web-build-info-x1', 'flutter_tools.Qw3rTy', 'com.google.Chrome.aBcDeF', 'tmpab12cd_9', 'anything-at-all', 'starnet-browser-999999-abc'])
        assert.ok(by[n] && by[n].go, n + ' should go: ' + JSON.stringify(by[n]));
      assert.strictEqual(by['console-walk-Fresh1'].go, false, 'a fresh test dir stays');
      assert.strictEqual(by['young-one'].go, false, 'a fresh private entry stays');
      assert.ok(by['today-walk-BusyX1'].busy && !by['today-walk-BusyX1'].go, 'cwd inside: in use');
      assert.ok(by['chatwin-Named1'].busy, 'named on a command line: in use');
      for (const n of ['ytmusic-dir-123', 'someone-elses-thing', 'starnet-upload-staging-85cd4b', 'tmpfile12345', 'starnet-browser-' + process.pid]) assert.ok(!by[n], n + ' is not ours to judge');
      assert.strictEqual(by['meeting-ui-chrome-Zz99yy'].cls, 'test'); assert.strictEqual(by['flutter_tools.Qw3rTy'].cls, 'build'); assert.strictEqual(by['anything-at-all'].cls, 'private');
    });
    await check('status touches nothing', () => { assert.ok(fs.existsSync(path.join(shared, 'routes-walk-Ab12Cd'))); });
    await check('apply removes exactly the entries that go; dry run removes none', () => {
      const d = apply({ dirs: [shared, priv], root, dry: true });
      assert.ok(d.removed.length >= 8 && fs.existsSync(path.join(shared, 'tmpab12cd_9')));
      const r = apply({ dirs: [shared, priv], root });
      const left = new Set(fs.readdirSync(shared).concat(fs.readdirSync(priv)));
      for (const n of ['routes-walk-Ab12Cd', 'bs-web-build-info-x1', 'com.google.Chrome.aBcDeF', 'tmpab12cd_9', 'anything-at-all', 'starnet-browser-999999-abc']) assert.ok(!left.has(n), n + ' removed');
      for (const n of ['console-walk-Fresh1', 'today-walk-BusyX1', 'chatwin-Named1', 'ytmusic-dir-123', 'someone-elses-thing', 'starnet-upload-staging-85cd4b', 'tmpfile12345', 'young-one', 'starnet-browser-' + process.pid]) assert.ok(left.has(n), n + ' kept');
      assert.ok(r.freed > 0);
    });
    await check('--class and --min-age narrow it', () => {
      mk(shared, 'bs-again-1'); mk(shared, 'alarm-walk-Again1');
      apply({ dirs: [shared], root, classes: ['test'] });
      assert.ok(fs.existsSync(path.join(shared, 'bs-again-1')) && !fs.existsSync(path.join(shared, 'alarm-walk-Again1')));
      apply({ dirs: [shared], root, classes: ['test'], minAge: 0 });
      assert.ok(!fs.existsSync(path.join(shared, 'console-walk-Fresh1')), 'min-age 0 takes a fresh test dir');
      assert.ok(fs.existsSync(path.join(shared, 'today-walk-BusyX1')), 'but never one in use');
    });
    await check('a symlink is removed as a link; its target stays', () => {
      const target = path.join(T, 'target'); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'k');
      const l = path.join(shared, 'bs-link-1'); fs.symlinkSync(target, l); fs.lutimesSync && fs.lutimesSync(l, old, old);
      apply({ dirs: [shared], root, classes: ['build'], minAge: 0 });
      assert.ok(!fs.existsSync(l) && fs.existsSync(path.join(target, 'keep')));
    });
    await check('browsers: only an orphaned Chrome on a temp profile, past the age, is ended', () => {
      const fake = path.join(T, 'proc'); fs.mkdirSync(fake);
      const put = (pid, ppid, comm, cmd, startTicks) => {
        const d = path.join(fake, String(pid)); fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'cmdline'), cmd.join('\0') + '\0');
        fs.writeFileSync(path.join(d, 'stat'), pid + ' (' + comm + ') S ' + ppid + ' 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ' + startTicks + ' 0');
        fs.writeFileSync(path.join(d, 'status'), 'Name:\t' + comm + '\nUid:\t' + process.getuid() + '\t0\t0\t0\nVmRSS:\t  1024 kB\n');
      };
      const now = Date.now(); const btime = Math.floor(now / 1000) - 10 * H;
      fs.writeFileSync(path.join(fake, 'stat'), 'cpu 0\nbtime ' + btime + '\n');
      const oldStart = 100 * 60, newStart = (10 * H - 60) * 100;   // started 9 h 59 min ago / 1 min ago (100 ticks a second)
      put(1058, 1, 'systemd', ['/usr/lib/systemd/systemd', '--user'], 0);
      put(2000, 1058, 'chrome', ['/opt/google/chrome/chrome --headless=new --user-data-dir=' + shared + '/starnet-0018-behav-abcdef'], oldStart);   // one title, as Chrome leaves it
      put(2001, 2000, 'chrome', ['/opt/google/chrome/chrome', '--type=renderer', '--user-data-dir=' + shared + '/starnet-0018-behav-abcdef'], oldStart);
      put(2100, 1058, 'chrome', ['/opt/google/chrome/chrome', '--remote-debugging-port=9333', '--user-data-dir=' + shared + '/fresh-one'], newStart);
      put(2200, 1058, 'chrome', ['/opt/google/chrome/chrome', '--user-data-dir=' + shared + '/a-person-opened-this'], oldStart);   // not driven: a person's window
      put(3000, 1136, 'chrome', ['/opt/google/chrome/chrome'], oldStart);                                                // the owner's own Chrome
      put(4000, 1058, 'chrome', ['/opt/google/chrome/chrome', '--user-data-dir=/home/someone/.config/chrome-x'], oldStart);  // not a temp profile
      put(5000, 4242, 'chrome', ['/opt/google/chrome/chrome', '--user-data-dir=' + shared + '/starnet-browser-4242-x'], oldStart);   // its parent lives
      put(4242, 1058, 'node', ['node', 'sidecar/index.js'], oldStart);
      const sent = [];
      const r = browsers({ proc: fake, dirs: [shared], root, now, apply: true, kill: (pid, sig) => sent.push(pid + ':' + sig), wait: () => {} });
      assert.deepStrictEqual(r.browsers.map(b => b.pid).sort(), [2000, 2100]);
      assert.deepStrictEqual(sent, ['2000:SIGTERM', '2000:SIGKILL', '2001:SIGKILL']);
      assert.strictEqual(r.browsers.find(b => b.pid === 2000).rss, 2 * 1024 * 1024);
    });
    await check('scope: own is the private dir, framework test names and this company\'s station pids; host is the rest', () => {
      mk(shared, 'starnet-browser-999998-mine'); mk(shared, 'starnet-claude-cli-999997-other'); mk(shared, 'bs-scope-1'); mk(shared, 'tmpscope123'); mk(shared, 'com.google.Chrome.scope1'); mk(shared, 'services-walk-Scope1');
      mk(priv, 'tmpprivate12'); mk(priv, 'bs-in-private');
      const s = scan({ dirs: [shared, priv], root, stationPids: new Set([999998]) });
      const by = Object.fromEntries(s.items.map(i => [i.name, i]));
      for (const n of ['starnet-browser-999998-mine', 'services-walk-Scope1', 'tmpprivate12', 'bs-in-private']) assert.strictEqual(by[n].scope, 'own', n);
      for (const n of ['starnet-claude-cli-999997-other', 'bs-scope-1', 'tmpscope123', 'com.google.Chrome.scope1']) assert.strictEqual(by[n].scope, 'host', n);
      const own = scan({ dirs: [shared, priv], root, stationPids: new Set([999998]), scope: 'own' }).items.map(i => i.name);
      assert.ok(own.includes('starnet-browser-999998-mine') && !own.includes('bs-scope-1') && !own.includes('tmpscope123'), own.join());
      for (const c of Object.values(CLASSES)) assert.ok(c.scope === 'own' || c.scope === 'host');
    });
    await check('tick: own scope only, once an hour, one log line, state written', () => {
      mk(shared, 'bs-tick-1'); mk(shared, 'huddle-walk-Tick01');
      const lines = [];
      const a = tick({ dirs: [shared], root, log: l => lines.push(l), force: true });
      assert.ok(a.removed >= 1, JSON.stringify(a)); assert.ok(/^TMP SWEEP: /.test(lines[0]), lines[0]);
      assert.ok(!fs.existsSync(path.join(shared, 'huddle-walk-Tick01')) && fs.existsSync(path.join(shared, 'bs-tick-1')), 'a build leftover in the shared dir is the host\'s: kept');
      const b = tick({ dirs: [shared], root, log: l => lines.push(l) });
      assert.ok(b.skipped, JSON.stringify(b));
      const st = JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'tmp-sweep.json'), 'utf8'));
      assert.ok(st.lastRun && st.removed >= 1);
    });
  } finally {
    for (const k of kids) { try { k.kill('SIGKILL'); } catch (_) {} }
    fs.rmSync(T, { recursive: true, force: true });
  }
  console.log(fails ? 'tmp-sweep selftest: ' + fails + ' FAILED' : 'tmp-sweep selftest: all passed');
  process.exit(fails ? 1 : 0);
}

/* ---------------- CLI ---------------- */
function main(argv) {
  const cmd = argv[0] || 'status';
  const flag = k => argv.includes('--' + k);
  const vals = k => { const out = []; argv.forEach((a, i) => { if (a === '--' + k && argv[i + 1]) out.push(argv[i + 1]); }); return out; };
  const json = flag('json');
  const o = { dirs: vals('dir') };
  const cls = vals('class').join(',').split(',').filter(Boolean); if (cls.length) o.classes = cls;
  const ma = vals('min-age')[0]; if (ma !== undefined) o.minAge = Number(ma);
  if (cmd === 'selftest' || cmd === '--selftest') return selftest();
  if (cmd === 'status' || cmd === 'apply') {
    const r = cmd === 'apply' ? apply(o) : scan(o);
    if (json) { console.log(JSON.stringify(r, null, 1)); return; }
    const sum = {};
    for (const it of r.items) { const k = it.cls; sum[k] = sum[k] || { n: 0, b: 0, goN: 0, goB: 0, busy: 0 }; sum[k].n++; sum[k].b += it.bytes; if (it.go) { sum[k].goN++; sum[k].goB += it.bytes; } if (it.busy) sum[k].busy++; }
    console.log('temp dirs: ' + r.dirs.join(', '));
    for (const [k, v] of Object.entries(sum)) console.log('  ' + k.padEnd(8) + ' ' + String(v.n).padStart(5) + ' entries ' + fmtMB(v.b).padStart(10) + '   ' + (cmd === 'apply' ? 'removed ' : 'would go ') + v.goN + ' (' + fmtMB(v.goB) + ')' + (v.busy ? ', ' + v.busy + ' in use' : ''));
    if (cmd === 'apply') console.log(r.refused ? 'refused: ' + r.refused : 'freed ' + fmtMB(r.freed) + (r.errors && r.errors.length ? '; errors: ' + r.errors.length : ''));
    return;
  }
  if (cmd === 'browsers') {
    const r = browsers(Object.assign(o, { apply: flag('apply') }));
    if (json) { console.log(JSON.stringify(r, null, 1)); return; }
    if (!r.browsers.length) { console.log('no left-behind browsers on a temp profile'); return; }
    for (const b of r.browsers) console.log((b.ended ? 'ended  ' : b.go ? 'would end ' : 'too new ') + 'pid ' + b.pid + '  ' + fmtMB(b.rss) + '  up ' + fmtAge(b.ageS) + '  ' + b.profile);
    return;
  }
  console.error('usage: tmp-sweep.js status|apply|browsers|selftest [--dir D] [--class c,c] [--min-age S] [--apply] [--json]');
  process.exit(2);
}

module.exports = { scan, apply, browsers, tick, classify, measure, heldNames, defaultDirs, fmtMB, CLASSES, privateDir };
if (require.main === module) main(process.argv.slice(2));
