#!/usr/bin/env node
/* provenance.js — a tool that writes a locked file says so here, so company/tools/locked-watch.js can tell the tool's own
 * write from anyone else's.
 *
 * Why: agents may not edit what measures, limits or protects them. Some of
 * those files have exactly one legitimate writer, a tool (corrections.js for the correction records, pacer.js for its state,
 * competence.js for the ledger, my-section.js for the agents' own sections, ...). Each such tool calls this module right
 * after it writes, with the exact bytes it wrote. locked-watch.js then accepts a change whose bytes match a recorded write
 * and puts back anything else.
 *
 *   const prov = require('./provenance.js');
 *   prov.wrote(file, text, 'corrections.js')        after a whole-file write (atomic rename) of `text` (o.root: another
 *                                                   company root, as appended() takes)
 *   prov.appended(file, chunk, 'pacer.js')          after appending `chunk` to an append-only log
 *   prov.noted(file, { kind: 'cutover', bytes, sha256 }, 'owner-channel')   a marker, not a write (lib/owner-channel.js,
 *                                                   lib/pm-inbox-guard.js)
 *   prov.rolled(file, { before, after, ops, chunks }, 'retention.js')   after a retention roll (docs/RETENTION.md)
 *   prov.inserted(file, { before, after, offset }, 'decision.js')    after inserting bytes at `offset` of a grow-only record
 *                                                   (decisions.md is newest first: a new entry goes in at the top)
 *   prov.removed(file, 'console (owner disconnect)')   after deleting a key file (a connector's credential, Disconnect)
 *   node company/tools/provenance.js record <file> <writer>   for a shell tool (test-substrate.sh): hashes the file on disk
 *   node company/tools/provenance.js tail [n]       print the last n rows (no file contents, only hashes)
 *
 * The hash is taken from the bytes the tool meant to write, never re-read from disk, so a write that lands right after the
 * tool's own cannot borrow its record. Only files under company/ are recorded (selftests that write in temp folders are
 * ignored). Recording never throws: a tool's own work must not fail because this log could not be written.
 * Each row also says which program was running (`main`, the script node was started with, relative to the project root),
 * whether node was started with a preload or eval flag (`tainted`), and whether an agent's run started it (`underStation`).
 * locked-watch.js accepts a row only when `main` is the named writer itself or the dispatcher, and never a tainted one.
 * What it is not: proof. Everyone runs as the same Unix user, so a determined forger can still fake a row; the checks
 * above make a forgery take several deliberate steps, each visible in the agent's transcript, which the watcher reads.
 * SAME-UID LIMIT (owner decision: a separate uid for agents was ruled out): the owner check, including the console's
 * owner-job grants (console/owner-ops.js, verified below), is a seatbelt against accidents, not a security boundary.
 * Any process running as this Unix user that can read secrets/console-token can sign a grant, read /proc, start a
 * process under the console, or edit these very files, and so act as the owner. Real separation needs the console to
 * run as another user or in another container, with secrets/ out of the agents' reach: a deployment choice (docs/DEPLOY-SERVER.md),
 * not something this module can add.
 *
 * underStation(): an agent's run started this process (an ancestor is node running the StarNet sidecar, the process is in
 * the station's cgroup, or it carries the environment pins the station puts on every child it starts). ownerShell(): the
 * opposite, positively: not under the station, AND an ancestor is an interactive session (a terminal, sshd, tmux/screen,
 * Claude Code working for the owner) or the owner's console. "--by owner" is accepted only when ownerShell() is true;
 * every owner-only command asks through company/tools/lib/owner.js. classify() is the same rule over injected ancestry.
 * transcripts: callerConflict() looks at the agents' recent tool calls (in memory only; nothing is printed or kept) for
 * the command now running, so a tool can refuse a --by claim made from somebody else's run.
 * Log: company/state/locked/provenance.jsonl (append-only). Owner of this tool: the tools seat (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const pc = require('./lib/proc-check.js');
const LIVE_ROOT = co.ROOT;
const rootOf = () => path.resolve(process.env.PROVENANCE_ROOT || LIVE_ROOT);   // env only for selftests
const homeOf = () => path.resolve(process.env.PROVENANCE_HOME || require('os').homedir());   // env only for selftests
const logFile = root => path.join(root, 'company', 'state', 'locked', 'provenance.jsonl');
const sha = data => 'sha256:' + crypto.createHash('sha256').update(Buffer.isBuffer(data) ? data : Buffer.from(String(data))).digest('hex');

/* ---------------- who is running ---------------- */
let CHAIN = null, CHAIN_CG = '';
// the command lines of this process's ancestors, nearest first
function ancestry() {
  if (CHAIN) return CHAIN;
  CHAIN = [];
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    try {
      const argv = pc.argvOf(pid) || [];
      CHAIN.push(argv);
      try { CHAIN_CG += fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8') + '\n'; } catch (_) {}
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      pid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    } catch (_) { break; }
  }
  return CHAIN;
}
// the pins StarNet's sanitizeChildEnv puts on every process an agent's run starts (sidecar/environment.js)
const stationEnv = env => env.STARNET_USER_CONTROL_MODE === 'preserve' && env.STARNET_COMPUTER_DRIVER === '0' && env.STARNET_MCP_STDIO === '0' && env.BROWSER === 'none';
// The script a node process runs: argv[0] is node, the script is its first non-option argument. Anything else (a shell
// whose `-c` text merely MENTIONS a path, an editor opening the file, `git diff starnet/sidecar/index.js`) runs no script.
// Measured, 2026-11-17: the old test was /sidecar\/index\.js/ over the ancestor's whole joined command line, so the
// owner's own `bash -c "node company/tools/locked-watch.js accept starnet/sidecar/index.js --by owner ..."` (Claude
// Code's bash tool and its `!` prompt both run each command that way) counted as the station, and every --by owner in
// that shell was refused, for any key run in the same command line.
const scriptOf = pc.scriptOf;
const isStationArgv = argv => pc.runsScript(argv, 'sidecar/index.js');
// the owner's console (console/server.js, behind the owner token) runs tools as the owner; it is the owner's own UI.
// Only THIS company's console counts: the script must resolve to <root>/console/server.js (a copy elsewhere is nobody's console)
const isConsoleArgv = (argv, root) => pc.runsScript(argv, 'console/server.js', { root: root || rootOf(), exact: true });
const INTERACTIVE = /(^|\/)(sshd|login|tmux|tmux: server|screen|SCREEN|ptyxis|ptyxis-agent|gnome-terminal-server|konsole|kitty|alacritty|foot|wezterm-gui|xterm|terminator|tilix|claude)$/;
// Claude Code working for the owner: the native binary (argv[0] "claude", whatever /proc/<pid>/comm says), or node
// running its cli (…/claude, …/claude.js, …/@anthropic-ai/claude-code/cli.js)
const isInteractiveArgv = argv => Array.isArray(argv) && argv.length > 0 && (INTERACTIVE.test(String(argv[0])) ||
  (() => { const s = scriptOf(argv); return !!s && (/(^|\/)claude(\.js)?$/.test(s) || /claude-code\/cli(\.m?js)?$/.test(s)); })());
// this process's cgroup is the station's unit (/<serviceName>.service; the -dispatch/-console units do not match)
function stationUnit() { try { return '/' + ((co.config.station && co.config.station.serviceName) || 'capheos-station') + '.service'; } catch (_) { return '/capheos-station.service'; } }
const inStationCgroup = (cgroupText, unit) => String(cgroupText || '').split('\n').some(l => { const p = l.slice(l.lastIndexOf(':') + 1); return p.endsWith(unit) || p.includes(unit + '/'); });
// Console-spawned transient owner-job unit (<svc>-owner-job-<id>.service): verify kernel cgroup + live console PID +
// HMAC-SHA256 grant signed with secrets/console-token (written by console/owner-ops.js, mode 0600, deleted on exit).
function ownerJobFromCgroup(cgroupText, unit) {
  const svc = String(unit || stationUnit()).replace(/^\//, '').replace(/\.service$/, '');
  const prefix = svc + '-owner-job-';
  for (const l of String(cgroupText || '').split('\n')) {
    const seg = l.slice(l.lastIndexOf(':') + 1).split('/').filter(Boolean).pop() || '';
    if (!seg.startsWith(prefix) || !seg.endsWith('.service')) continue;
    const id = seg.slice(prefix.length, -'.service'.length);
    if (/^[A-Za-z0-9_-]{4,80}$/.test(id)) return { id, unit: seg };
  }
  return null;
}
/* A grant (company/state/owner-ops/<id>.grant, 0600) is written by the console AFTER systemd-run started the unit, bound to
 * that unit's InvocationID, its main pid and that pid's start time, and to the console's own pid and start time, all under an
 * HMAC with secrets/console-token. It is accepted only for a caller that is the unit's main pid or a descendant of it
 * (the /proc parent chain), while the unit's InvocationID is still the one in the grant and the live console is still the
 * process that signed it (a recycled console pid has another start time). The job's own wrapper deletes it before it exits.
 * Seatbelt, not a boundary: whoever reads secrets/console-token can sign one (see the header). */
function invocationOf(unit) {
  const { spawnSync } = require('child_process');
  const bin = ['/usr/bin/systemctl', '/bin/systemctl'].find(b => fs.existsSync(b)) || 'systemctl';
  const r = spawnSync(bin, ['--user', 'show', '-p', 'InvocationID', '--value', unit], { encoding: 'utf8', timeout: 4000 });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
const grantText = g => [g.id, g.unit, g.invocationId, String(g.mainPid), String(g.mainStart), String(g.consolePid), String(g.consoleStart), String(g.startedAt)].join(':');
function validOwnerJobGrant(o) {
  o = o || {};
  const hit = ownerJobFromCgroup(o.cgroup, o.unit);
  if (!hit) return false;
  const root = path.resolve(o.root || rootOf());
  let grant = null;
  try {
    grant = o.readGrant ? o.readGrant(hit.id) : JSON.parse(fs.readFileSync(path.join(root, 'company', 'state', 'owner-ops', hit.id + '.grant'), 'utf8'));
  } catch (_) { return false; }
  if (!grant || grant.id !== hit.id || grant.unit !== hit.unit) return false;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ts = Date.parse(String(grant.startedAt || ''));
  if (!Number.isFinite(ts) || now - ts > 6 * 3600e3 || now - ts < -60e3) return false;
  const mainPid = Number(grant.mainPid), consolePid = Number(grant.consolePid);
  if (!Number.isInteger(mainPid) || mainPid <= 1 || !Number.isInteger(consolePid) || consolePid <= 1) return false;
  if (!grant.invocationId || !grant.mainStart || !grant.consoleStart) return false;
  // the signature first: nothing below is believed unless the console signed these exact values
  let token = '';
  try { token = String(o.readToken ? o.readToken() : fs.readFileSync(path.join(root, 'secrets', 'console-token'), 'utf8')).trim(); } catch (_) { return false; }
  if (!token) return false;
  const expected = crypto.createHmac('sha256', token).update(grantText(grant)).digest();
  const got = Buffer.from(String(grant.hmac || ''), 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return false;
  // the live console is the process that signed it: this company's console/server.js, same start time
  const argvOf = o.readArgv || pc.argvOf, startOf = o.readStart || pc.startTicks;
  let cmd = null;
  try { cmd = argvOf(consolePid); } catch (_) { return false; }
  if (!cmd || !isConsoleArgv(cmd, root)) return false;
  if (String(startOf(consolePid)) !== String(grant.consoleStart)) return false;
  // the unit is still the invocation the console started, and the caller is inside it
  if (String(startOf(mainPid)) !== String(grant.mainStart)) return false;
  let inv = '';
  try { inv = String(o.readInvocation ? o.readInvocation(grant.unit) : invocationOf(grant.unit)); } catch (_) { return false; }
  if (!inv || inv !== String(grant.invocationId)) return false;
  return pc.isDescendant(Number.isInteger(o.pid) ? o.pid : process.pid, mainPid, { ppidOf: o.ppidOf });
}
/* The one rule, as a pure function so a test can hand it any ancestry:
 *   underStation: the station's environment pins, or the station's cgroup, or an ancestor that IS node running sidecar/index.js;
 *   ownerShell:   not underStation, and an ancestor is an interactive session or the owner's console (or a verified console owner-job unit). */
function classify(o) {
  o = o || {};
  const chain = Array.isArray(o.chain) ? o.chain : [];
  const under = stationEnv(o.env || {}) || inStationCgroup(o.cgroup, o.unit || stationUnit()) || chain.some(isStationArgv);
  return { underStation: under, ownerShell: !under && (chain.some(a => isInteractiveArgv(a) || isConsoleArgv(a, o.root)) || !!o.ownerJobValid) };
}
let CGROUP = null;
// this process's cgroup and its ancestors' (the merge gate's check: an ancestor in the station's unit)
const ownCgroup = () => { if (CGROUP === null) { try { CGROUP = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch (_) { CGROUP = ''; } ancestry(); CGROUP += '\n' + CHAIN_CG; } return CGROUP; };
let STATION = null, OWNER = null;
function underStation() {
  if (STATION !== null) return STATION;
  if (fixtureRoot()) return (STATION = false);   // a selftest's throwaway company (fixtureRoot): measure the mechanism, not the caller
  STATION = classify({ chain: ancestry(), env: process.env, cgroup: ownCgroup() }).underStation;
  return STATION;
}
// A selftest must measure the mechanism, not the caller's environment. When an agent's run runs a selftest, this
// process IS under the station, so every row it records is re-checked against `main` — and eight locked-watch cases
// that are about something else then fail on the caller rather than on the code. pinUnderStation(false) pins the
// answer for the duration of a test; pinUnderStation(null) restores the live computation. Nothing else uses it.
// pinOwnerShell is the same for ownerShell (in this process only; there is no environment variable for either).
function pinUnderStation(v) { STATION = (v === null || v === undefined) ? null : !!v; return STATION; }
function pinOwnerShell(v) { OWNER = (v === null || v === undefined) ? null : !!v; return OWNER; }
// A selftest's own throwaway company (a folder under the OS temp dir that the test marks with .capheos-selftest-fixture,
// named by CAPHEOS_ROOT) answers owner checks as the owner, so a test that runs tools as child processes passes when an
// agent runs it too. It grants nothing real: the owner of a fake company in /tmp is whoever made it.
function fixtureRoot() {
  const r = process.env.CAPHEOS_ROOT; if (!r) return false;
  try { const os = require('os'); const t = fs.realpathSync(os.tmpdir()), real = fs.realpathSync(r);
    return real.startsWith(t + path.sep) && fs.existsSync(path.join(real, '.capheos-selftest-fixture')); } catch (_) { return false; }
}
function ownerShell() {
  if (OWNER !== null) return OWNER;
  if (fixtureRoot()) return true;
  if (underStation()) return false;
  const cg = ownCgroup();
  return classify({ chain: ancestry(), env: process.env, cgroup: cg, ownerJobValid: validOwnerJobGrant({ cgroup: cg, root: rootOf() }) }).ownerShell;
}
function mainInfo(root) {
  let main = '[none]';
  try { if (require.main && require.main.filename) { const f = fs.realpathSync(require.main.filename); main = f.startsWith(root + path.sep) ? path.relative(root, f).split(path.sep).join('/') : f; } } catch (_) {}
  const flags = (process.execArgv || []).join(' ') + ' ' + String(process.env.NODE_OPTIONS || '');
  return { main, tainted: /(^|\s)(-r|--require|--import|--loader|--experimental-loader|-e|--eval|-p|--print|--inspect\S*)(\s|=|$)/.test(flags) };
}

/* ---------------- recording ---------------- */
// a file in the home folder, outside the project (a connector's credential, ~/.config/<cli>/...): '~/<path>', the key
// locked-watch.js uses for it. Only keys the console records (writer "console", hashes only) are ever written this way.
function homeRel(p) {
  const home = homeOf(); if (!p.startsWith(home + path.sep)) return null;
  const r = path.relative(home, p).split(path.sep).join('/');
  return r && !r.split('/').includes('..') ? '~/' + r : null;
}
function relOf(file, root, o) {
  const p = path.resolve(String(file || ''));
  if (!p.startsWith(root + path.sep)) return o && o.home ? homeRel(p) : null;
  const r = path.relative(root, p).split(path.sep).join('/');
  // under company/, plus the station's folder grants (lanes.js records the grant of each lane folder it blesses) and the
  // station's key store (providers.js records the files the station wrote for an owner-approved setting; hashes only),
  // and the company's own keys in secrets/ (the console records each key the owner saves; hashes only, never the value)
  const ownKey = /^secrets\/[^/]+$/.test(r) && r !== 'secrets/README.md';
  if ((!r.startsWith('company/') && r !== '.starnet-data/workspaces/permissions.allow.json' && !r.startsWith('.starnet-data/workspaces/.secrets/') && !ownKey) || r.startsWith('company/state/locked/')) return null;
  return r;
}
function append(row, root) {
  const f = logFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(row) + '\n');   // one short line: a single O_APPEND write
}
function common(root, writer) { const m = mainInfo(root); return { writer: String(writer || '?'), pid: process.pid, underStation: underStation(), main: m.main, tainted: m.tainted }; }
function wrote(file, data, writer, o) {
  try {
    const root = o && o.root ? path.resolve(o.root) : rootOf(), rel = relOf(file, root, { home: /^console\b/.test(String(writer || '')) }); if (!rel) return false;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'write', sha256: sha(buf), bytes: buf.length }, common(root, writer)), root);
    return true;
  } catch (_) { return false; }
}
// a key file the console deleted (Disconnect): locked-watch.js accepts its absence instead of flagging "a key changed"
function removed(file, writer) {
  try {
    const root = rootOf(), rel = relOf(file, root, { home: true }); if (!rel) return false;
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'delete' }, common(root, writer)), root);
    return true;
  } catch (_) { return false; }
}
function appended(file, chunk, writer, o) {
  try {
    const root = o && o.root ? path.resolve(o.root) : rootOf(), rel = relOf(file, root); if (!rel) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!buf.length) return false;
    // o.seat: the seat a writer verified as its caller (lib/pm-inbox-guard.js: an asker's own withdraw / reclassify)
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'append', chunkSha: sha(buf), chunkBytes: buf.length }, common(root, writer), o && o.seat ? { seat: String(o.seat) } : {}), root);
    return true;
  } catch (_) { return false; }
}
// a marker about a file, not a write (lib/owner-channel.js: kind 'cutover', the owner channel's size and prefix hash when
// its provenance began). Only kinds named here; locked-watch ignores them.
function noted(file, info, writer, o) {
  try {
    const root = o && o.root ? path.resolve(o.root) : rootOf(), rel = relOf(file, root); if (!rel || !info || !['cutover', 'schedule'].includes(info.kind)) return false;
    // kind 'schedule': a tool set a routine's schedule on the station (cadence.js), so locked-watch knows the change was its
    const extra = info.kind === 'schedule' ? { jobId: String(info.jobId || ''), expr: String(info.expr || ''), tz: info.tz ? String(info.tz) : null } : {};
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: info.kind, bytes: Number(info.bytes) || 0, sha256: String(info.sha256 || '') }, extra, common(root, writer)), root);
    return true;
  } catch (_) { return false; }
}
// after retention.js rolled `file` (moved old entries into its archive): enough to rebuild the file as it was, so
// locked-watch can check the roll lost nothing. before = after with each op applied: at after-offset op[0], drop op[1]
// bytes (the pointer line) and put back op[2] bytes taken in order from the archived chunks ({archive, offset, bytes, sha256};
// a replaced pointer line's old text is carried inline: {inline, bytes, sha256}).
function rolled(file, info, writer) {
  try {
    const root = rootOf(), rel = relOf(file, root); if (!rel || !info) return false;
    const chunks = (info.chunks || []).map(c => c.inline != null ? { inline: String(c.inline), bytes: Number(c.bytes), sha256: String(c.sha256) } : { archive: String(c.archive), offset: Number(c.offset), bytes: Number(c.bytes), sha256: String(c.sha256) });
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'roll', sha256: sha(info.after), bytes: info.after.length, beforeSha: sha(info.before), beforeBytes: info.before.length,
      ops: (info.ops || []).map(o => [Number(o[0]), Number(o[1]), Number(o[2])]), chunks }, common(root, writer)), root);
    return true;
  } catch (_) { return false; }
}
// after a grow-only record was written with new bytes inserted at `offset` (everything else unchanged): enough for
// locked-watch to take the insert back out (even after later appends or a retention roll) and check the rest is history.
// Row: sha256/bytes of the file after, beforeSha/beforeBytes of the file before, offset, chunkSha/chunkBytes of the insert.
function inserted(file, info, writer) {
  try {
    const root = rootOf(), rel = relOf(file, root); if (!rel || !info) return false;
    const before = Buffer.isBuffer(info.before) ? info.before : Buffer.from(String(info.before));
    const after = Buffer.isBuffer(info.after) ? info.after : Buffer.from(String(info.after));
    const off = Number(info.offset); const n = after.length - before.length;
    if (!(n > 0) || !(off >= 0) || off > before.length) return false;
    append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'insert', sha256: sha(after), bytes: after.length, beforeSha: sha(before), beforeBytes: before.length,
      offset: off, chunkSha: sha(after.subarray(off, off + n)), chunkBytes: n }, common(root, writer)), root);
    return true;
  } catch (_) { return false; }
}
// rows after byte offset `from` of the log (locked-watch keeps the offset it has read up to)
function readFrom(from, root) {
  const f = logFile(path.resolve(root || rootOf()));
  let size = 0; try { size = fs.statSync(f).size; } catch (_) { return { rows: [], end: 0 }; }
  const start = Number(from) >= 0 && Number(from) <= size ? Number(from) : 0;
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const txt = buf.toString('utf8'); const cut = txt.lastIndexOf('\n');
  const rows = [];
  for (const l of (cut >= 0 ? txt.slice(0, cut) : '').split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (r && r.file) rows.push(r); } catch (_) {} }
  return { rows, end: start + (cut >= 0 ? Buffer.byteLength(txt.slice(0, cut + 1)) : 0) };
}

/* ---------------- recent agent tool calls (for --by checks) ---------------- */
const SHELLISH = /shell|exec|bash|terminal|run_command/i;
const FILE_WRITE = /^fs_(write|edit|append|patch)/;
// tool calls of agent runs since sinceMs, from the newest transcript segments. The arguments stay in memory.
function recentCalls(root, sinceMs) {
  const dir = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2');
  let files = []; try { files = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort().slice(-2); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    let txt = '';
    try { const p = path.join(dir, f); const size = fs.statSync(p).size; const want = Math.min(size, 3 * 1024 * 1024); const buf = Buffer.alloc(want); const fd = fs.openSync(p, 'r'); try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); } txt = buf.toString('utf8'); if (want < size) txt = txt.slice(txt.indexOf('\n') + 1); } catch (_) { continue; }
    for (const l of txt.split('\n')) {
      if (!l.includes('toolCalls')) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.agentId || !(Number(r.ts) >= sinceMs)) continue;
      let calls; try { calls = typeof r.toolCalls === 'string' ? JSON.parse(r.toolCalls) : r.toolCalls; } catch (_) { continue; }
      for (const tc of Array.isArray(calls) ? calls : []) {
        const fn = (tc && tc.function) || {}; const name = String(fn.name || '');
        let a = fn.arguments; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = { _raw: a }; } }
        a = a || {};
        const wpath = FILE_WRITE.test(name) && typeof a.path === 'string' ? a.path : null;
        out.push({ agentId: String(r.agentId), runId: String(r.sourceRunId || '').slice(0, 8), ts: Number(r.ts), tool: name, shell: SHELLISH.test(name), script: !!wpath && !/\.(md|txt)$/i.test(wpath), raw: JSON.stringify(a) });
      }
    }
  }
  return out;
}
// The command now running claims to be `claimedId` (an agent id, or 'owner'). If an agent's shell call or a script an
// agent wrote in the last 10 minutes contains every one of `parts` and the claimed person's own runs show no such call,
// return who ran it ({ agentId, runId }); else null. Quoting a command in a handoff (.md) is not running it.
function callerConflict(root, parts, claimedId, nowMs) {
  try {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const hits = recentCalls(path.resolve(root || rootOf()), now - 10 * 60000).filter(c => (c.shell || c.script) && parts.every(p => c.raw.includes(String(p))));
    if (!hits.length) return null;
    if (claimedId !== 'owner' && hits.some(c => c.agentId === claimedId)) return null;
    const other = hits.filter(c => c.agentId !== claimedId).pop();
    return other ? { agentId: other.agentId, runId: other.runId } : null;
  } catch (_) { return null; }
}

module.exports = { wrote, removed, appended, noted, rolled, inserted, readFrom, sha, logFile, underStation, pinUnderStation, pinOwnerShell, ownerShell, classify, recentCalls, callerConflict, _internals: { stationEnv, mainInfo, scriptOf, inStationCgroup, ownerJobFromCgroup, validOwnerJobGrant, grantText, isConsoleArgv, isStationArgv } };

if (require.main === module) {
  const [cmd, n, w] = process.argv.slice(2);
  if (cmd === 'tail') { const r = readFrom(0).rows.slice(-(Number(n) || 20)); for (const x of r) console.log(x.at + '  ' + x.kind.padEnd(6) + ' ' + x.writer.padEnd(16) + ' ' + x.file + (x.underStation ? '  (agent run)' : '') + (x.main ? '  main ' + x.main : '') + (x.tainted ? '  TAINTED' : '')); }
  else if (cmd === 'record') {
    // a shell tool records its own write: the writer must be the shell script that is running this command
    const writer = String(w || ''); const root = rootOf();
    const script = ancestry().some(a => /(^|\/)(ba|da|z)?sh$/.test(a[0] || '') && a.slice(1).some(x => !x.startsWith('-') && (() => { try { return fs.realpathSync(path.resolve(x)) === path.join(root, 'company', 'tools', writer); } catch (_) { return false; } })()));
    if (!/^[A-Za-z0-9_.-]+\.sh$/.test(writer) || !script) { console.error('provenance: record is only for a company/tools/*.sh script recording its own write'); process.exit(2); }
    let buf; try { buf = fs.readFileSync(path.resolve(String(n || ''))); } catch (e) { console.error('provenance: ' + e.message); process.exit(2); }
    const rel = relOf(n, root); if (!rel) process.exit(0);
    try { append(Object.assign({ at: new Date().toISOString(), file: rel, kind: 'write', sha256: sha(buf), bytes: buf.length }, common(root, writer), { main: 'company/tools/' + writer }), root); } catch (_) {}
  }
  else if (cmd === 'selftest') {
    const os = require('os'); const T = require('./lib/temp-life').tmpDir('prov-selftest-');
    process.env.PROVENANCE_ROOT = T; let bad = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
    ok(wrote(path.join(T, 'company/work/x.json'), '{"a":1}\n', 'test') === true, 'records a write under company/');
    ok(wrote(path.join(T, 'scratch/x.json'), 'x', 'test') === false, 'ignores a file outside company/');
    ok(wrote('/elsewhere/company/x', 'x', 'test') === false, 'ignores a file outside the root');
    ok(appended(path.join(T, 'company/work/log.jsonl'), 'line\n', 'test') === true, 'records an append');
    const r = readFrom(0, T).rows;
    ok(r.length === 2 && r[0].sha256 === sha('{"a":1}\n') && r[1].chunkSha === sha('line\n') && r[1].chunkBytes === 5, 'rows carry the hash of the bytes written');
    ok(typeof r[0].main === 'string' && r[0].tainted === false, 'rows say which program wrote them and whether node was started with a preload');
    const end = readFrom(0, T).end; appended(path.join(T, 'company/work/log.jsonl'), 'two\n', 'test');
    ok(readFrom(end, T).rows.length === 1, 'reads on from an offset');
    ok(wrote(path.join(T, 'secrets/quotely-api-key'), 'k\n', 'console (owner key)') === true && wrote(path.join(T, 'secrets/README.md'), 'x', 'test') === false && wrote(path.join(T, 'secrets/sub/x'), 'x', 'test') === false, 'records a key saved in secrets/ (hash only), never its README or a subfolder');
    ok(stationEnv({ STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' }) && !stationEnv({ BROWSER: 'none' }), 'recognises the station\'s environment pins');
    // the owner/station rule over injected ancestry (nearest first)
    const wrap = cmd => ['/usr/bin/bash', '-c', 'source snap.sh && eval \'' + cmd + '\' && pwd -P >| /tmp/x'];
    const desk = cmd => [wrap(cmd), ['claude', '--dangerously-skip-permissions'], ['/usr/bin/bash'], ['/usr/lib/ptyxis-agent', '--socket-fd=3'], ['/usr/bin/ptyxis', '--gapplication-service']];
    for (const key of ['starnet/sidecar/index.js', '.starnet-data/workspaces/.secrets/provider-keys.json', 'company/work/finance/pacing-policy.json', '~/.config/x.json'])
      ok(classify({ chain: desk('node company/tools/locked-watch.js accept ' + key + ' --by owner --why x'), env: {} }).ownerShell === true, 'the owner\'s Claude Code shell is the owner, whatever key the command names: ' + key);
    ok(classify({ chain: [['/usr/bin/bash', '-c', 'x starnet/sidecar/index.js'], ['node', 'sidecar/index.js'], ['/usr/lib/systemd/systemd', '--user']], env: {} }).ownerShell === false, 'node sidecar/index.js as an ancestor is the station');
    ok(classify({ chain: [['/usr/bin/node', '--max-old-space-size=4096', '/srv/co/starnet/sidecar/index.js']], env: {} }).underStation === true, 'the sidecar by absolute path, with node flags, is the station');
    ok(classify({ chain: desk('ls'), env: { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' } }).ownerShell === false, 'the station\'s environment pins refuse even under a terminal');
    ok(classify({ chain: desk('ls'), env: {}, cgroup: '0::/user.slice/user@1000.service/app.slice/capheos-station.service', unit: '/capheos-station.service' }).ownerShell === false, 'the station\'s cgroup refuses even under a terminal');
    ok(classify({ chain: desk('ls'), env: {}, cgroup: '0::/user.slice/user@1000.service/app.slice/capheos-station-dispatch.service', unit: '/capheos-station.service' }).underStation === false, 'the dispatcher\'s unit is not the station\'s');
    ok(classify({ chain: [['node', '/srv/co/company/tools/dispatcher-loop.js'], ['/usr/lib/systemd/systemd', '--user']], env: {} }).ownerShell === false, 'a detached service is not the owner');
    ok(classify({ chain: [['/usr/bin/node', '/srv/co/console/server.js'], ['/usr/lib/systemd/systemd', '--user']], env: {}, root: '/srv/co' }).ownerShell === true, 'the owner\'s console is the owner');
    ok(classify({ chain: [['/usr/bin/node', '/tmp/evil/console/server.js'], ['/usr/lib/systemd/systemd', '--user']], env: {}, root: '/srv/co' }).ownerShell === false, 'a console/server.js of some other folder is not the owner');
    {
      const jobId = 'update-20261122-abcd', jobUnit = 'capheos-station-owner-job-' + jobId + '.service';
      const startedAt = new Date().toISOString(), tok = 'secret-console-tok';
      const g = { id: jobId, unit: jobUnit, invocationId: 'inv-1', mainPid: 5000, mainStart: '777', consolePid: 4242, consoleStart: '555', startedAt };
      g.hmac = crypto.createHmac('sha256', tok).update(grantText(g)).digest('hex');
      const cg = '0::/user.slice/user@1000.service/app.slice/' + jobUnit;
      const parents = { 5100: 5050, 5050: 5000, 5000: 1, 9000: 1 };
      const base = { cgroup: cg, unit: '/capheos-station.service', root: '/srv/co', pid: 5100, readGrant: () => g, readToken: () => tok, readInvocation: () => 'inv-1',
        readArgv: () => ['/usr/bin/node', '/srv/co/console/server.js'], readStart: p => ({ 4242: '555', 5000: '777' }[p]), ppidOf: p => parents[p] };
      const good = validOwnerJobGrant(base);
      ok(good === true && classify({ chain: [['/usr/lib/systemd/systemd', '--user']], env: {}, cgroup: cg, unit: '/capheos-station.service', ownerJobValid: good }).ownerShell === true, 'verified console owner-job unit is accepted as the owner');
      ok(validOwnerJobGrant(Object.assign({}, base, { readToken: () => 'wrong-tok' })) === false, 'owner-job grant rejects wrong HMAC/token');
      ok(validOwnerJobGrant(Object.assign({}, base, { readArgv: () => ['/usr/bin/bash'] })) === false, 'owner-job grant rejects non-console PID');
      ok(validOwnerJobGrant(Object.assign({}, base, { readArgv: () => ['/usr/bin/node', '/tmp/evil/console/server.js'] })) === false, 'owner-job grant rejects another folder\'s console/server.js');
      ok(validOwnerJobGrant(Object.assign({}, base, { now: Date.parse(startedAt) + 7 * 3600e3 })) === false, 'owner-job grant rejects expired grant');
      ok(validOwnerJobGrant(Object.assign({}, base, { readStart: p => ({ 4242: '999', 5000: '777' }[p]) })) === false, 'owner-job grant rejects a recycled console pid');
      ok(validOwnerJobGrant(Object.assign({}, base, { readStart: p => ({ 4242: '555', 5000: '778' }[p]) })) === false, 'owner-job grant rejects a recycled job pid');
      ok(validOwnerJobGrant(Object.assign({}, base, { readInvocation: () => 'inv-2' })) === false, 'owner-job grant rejects another invocation of the unit');
      ok(validOwnerJobGrant(Object.assign({}, base, { pid: 9000 })) === false, 'owner-job grant rejects a caller that is not the unit\'s process or its descendant');
      ok(classify({ chain: [['/usr/lib/systemd/systemd', '--user']], env: { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' }, cgroup: cg, unit: '/capheos-station.service', ownerJobValid: true }).ownerShell === false, 'station env still refuses even with owner-job grant');
    }
    ok(classify({ chain: [['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'], ['/usr/bin/bash']], env: {} }).ownerShell === true, 'Claude Code as node cli.js is interactive');
    ok(classify({ chain: [['/usr/bin/bash', '-c', 'echo claude'], ['vim', 'sidecar/index.js']], env: {} }).underStation === false, 'a command that only names sidecar/index.js is not the station');
    // callerConflict on a fake transcript
    const seg = path.join(T, '.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl'); fs.mkdirSync(path.dirname(seg), { recursive: true });
    const row = (agentId, name, args) => JSON.stringify({ agentId, sourceRunId: 'run-' + agentId, ts: Date.now() - 1000, toolCalls: JSON.stringify([{ function: { name, arguments: JSON.stringify(args) } }]) });
    fs.writeFileSync(seg, row('researcher', 'shell_exec', { command: 'node company/tools/locked-watch.js accept company/work/finance/pacing-policy.json --by Alex --why x' }) + '\n' + row('agent', 'fs_append', { path: 'company/work/handoffs/to-alex.md', content: 'run locked-watch.js accept pacing-policy.json --by Alex' }) + '\n');
    const c = callerConflict(T, ['locked-watch.js', 'accept', 'pacing-policy.json', 'Alex'], 'treasurer');
    ok(c && c.agentId === 'researcher', 'a --by claim typed in another agent\'s run is found');
    ok(callerConflict(T, ['locked-watch.js', 'accept', 'pacing-policy.json', 'Alex'], 'researcher') === null, 'the claimed person\'s own call is fine');
    ok(callerConflict(T, ['my-section.js', 'set'], 'designer') === null, 'no matching call: no conflict');
    fs.rmSync(T, { recursive: true, force: true });
    console.log(bad ? bad + ' FAILED' : 'all checks passed'); process.exit(bad ? 1 : 0);
  } else { console.log('usage: provenance.js tail [n] | record <file> <writer.sh> | selftest'); process.exit(2); }
}
