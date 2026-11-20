#!/usr/bin/env node
'use strict';
/* cpu-avoid: keep this company's processes off logical cpus that compute wrongly, and check that they are off them.
 *
 *   node company/tools/cpu-avoid.js status [--json]    the avoid list, the AllowedCPUs it implies, every task in this
 *                                                       company's slice and whether it may run on an avoided cpu
 *   node company/tools/cpu-avoid.js allowed             one line: the AllowedCPUs value (online cpus minus the avoid list);
 *                                                       exit 1 and no line when the list is empty or missing
 *   node company/tools/cpu-avoid.js --duty              read-only duty check (docs/DUTIES.md): exit 0 clean, exit 1 with
 *                                                       one JSON line when a task may run on an avoided cpu, exit 2 broken
 *   node company/tools/cpu-avoid.js selftest            offline: a temp /proc and cgroup tree, never the real ones
 *
 * Why: a physical core of a host can turn unstable and miscompute now and then (wrong decompression, wrong hashes)
 * while every other core reads clean. Once someone has measured which logical cpus those are (the core and its SMT
 * siblings), the company writes them into its own list and its work stays off them.
 *
 * THE LIST. company/state/cpu-avoid.json, per company (company state, never framework):
 *   {"avoid": [<cpu>, ...], "why": "...", "by": "...", "at": "<ISO>"}
 * Every entry is an online cpu number; at least half the online cpus must stay allowed, or the list is refused as
 * broken (exit 2), so a bad list can never pin the company to one core. No file, or "avoid": [], means nothing is
 * avoided and nothing changes: --duty exits 0 and says so on stderr, memory.js apply writes no AllowedCPUs=.
 *
 * WHAT IS CHECKED. The cpus each task is ALLOWED on (Cpus_allowed_list in /proc/<tid>/status), not the cpu it happens
 * to be on: a snapshot of the current cpu passes by chance most of the time, the allowed set does not. Every thread in
 * the slice's cgroup tree is read (cgroup.threads, else cgroup.procs). The slice is lib/memory.js sliceOf, the one every
 * unit of this company runs in (station and every agent run in it, console, dispatcher, background services, owner jobs).
 *
 * FAILS CLOSED. Exit 2, never 0, when: the list is not JSON or names a cpu that is not online or leaves fewer than half;
 * the slice's cgroup cannot be found; the slice holds no readable task (the station runs in it, so an empty read means
 * the wrong place was read). A task that ends between the listing and the read is skipped and counted.
 *
 * Env (tests): CPU_AVOID_PROC (default /proc), CPU_AVOID_CGROUP (the slice's cgroup folder; default from
 * `systemctl --user show -p ControlGroup`), CPU_AVOID_ONLINE (default /sys/devices/system/cpu/online), CAPHEOS_ROOT.
 * This tool changes nothing. Setting AllowedCPUs= on the slice is memory.js apply (it reads the same list).
 * The list is watched by locked-watch.js: deleting it lifts the restriction and quiets this check, so a change is reported.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..'));
const LIST = root => path.join(root, 'company', 'state', 'cpu-avoid.json');

function broken(msg) { const e = new Error(msg); e.broken = true; return e; }

// "0-3,7,9-10" -> sorted unique numbers; throws on anything else
function parseList(s) {
  const t = String(s == null ? '' : s).trim(); const out = new Set();
  if (!t) return [];
  for (const part of t.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw broken('not a cpu list: ' + JSON.stringify(t.slice(0, 60)));
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > 4096) throw broken('not a cpu range: ' + part);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
// sorted numbers -> "0,2-5,7"
function formatList(a) {
  const s = [...new Set(a)].sort((x, y) => x - y); const out = [];
  for (let i = 0; i < s.length;) {
    let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j === i ? String(s[i]) : s[i] + '-' + s[j]); i = j + 1;
  }
  return out.join(',');
}

function online(env) {
  const f = env.CPU_AVOID_ONLINE || '/sys/devices/system/cpu/online';
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { throw broken('cannot read the online cpus (' + f + '): ' + e.code); }
  const a = parseList(t); if (!a.length) throw broken('no online cpus in ' + f); return a;
}

// -> {avoid: [], allowed: [] | null, why, by, at, file}; throws broken on a bad list
function readList(root, env) {
  const f = LIST(root); let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { avoid: [], allowed: null, file: f, missing: true }; throw broken('cannot read ' + f + ': ' + e.code); }
  let j; try { j = JSON.parse(raw); } catch (_) { throw broken(f + ' is not JSON'); }
  if (!j || !Array.isArray(j.avoid)) throw broken(f + ' has no "avoid" array');
  if (!j.avoid.every(n => Number.isInteger(n) && n >= 0)) throw broken(f + ': "avoid" holds something that is not a cpu number');
  const avoid = [...new Set(j.avoid)].sort((x, y) => x - y);
  if (!avoid.length) return { avoid, allowed: null, file: f, why: j.why || null, by: j.by || null, at: j.at || null };
  const on = online(env);
  const off = avoid.filter(n => !on.includes(n));
  if (off.length) throw broken(f + ': cpu ' + off.join(',') + ' is not online here (online ' + formatList(on) + ')');
  const allowed = on.filter(n => !avoid.includes(n));
  if (allowed.length * 2 < on.length) throw broken(f + ': avoiding ' + avoid.length + ' of ' + on.length + ' cpus leaves fewer than half; refused');
  return { avoid, allowed, file: f, why: j.why || null, by: j.by || null, at: j.at || null };
}

function sliceCgroup(root, env) {
  if (env.CPU_AVOID_CGROUP) return env.CPU_AVOID_CGROUP;
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8')); } catch (_) {}
  const slice = require(path.join(root, 'company', 'tools', 'lib', 'memory')).sliceOf(cfg);
  let cg = '';
  try { cg = execFileSync('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', slice], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) {}
  if (!cg) throw broken('no cgroup for ' + slice + ' (systemctl --user show -p ControlGroup)');
  return path.join('/sys/fs/cgroup', cg);
}

// every tid in the cgroup tree
function tasksUnder(dir) {
  if (!fs.existsSync(dir)) throw broken('the slice cgroup ' + dir + ' does not exist');
  const out = new Set(); const stack = [dir];
  while (stack.length) {
    const d = stack.pop(); let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    let t = null;
    for (const f of ['cgroup.threads', 'cgroup.procs']) { try { t = fs.readFileSync(path.join(d, f), 'utf8'); break; } catch (_) {} }
    if (t) for (const l of t.split('\n')) if (/^\d+$/.test(l.trim())) out.add(Number(l.trim()));
    for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
  return [...out].sort((x, y) => x - y);
}

function readTask(procRoot, tid) {
  let t; try { t = fs.readFileSync(path.join(procRoot, String(tid), 'status'), 'utf8'); } catch (_) { return null; }
  const name = (/^Name:\s*(.*)$/m.exec(t) || [])[1] || '?';
  const tgid = Number((/^Tgid:\s*(\d+)/m.exec(t) || [])[1]) || tid;
  const m = /^Cpus_allowed_list:\s*(\S+)/m.exec(t);
  if (!m) return null;
  return { tid, pid: tgid, name, allowed: parseList(m[1]) };
}

function check(o) {
  o = o || {}; const env = o.env || process.env; const root = o.root || ROOT;
  const list = readList(root, env);
  const cg = sliceCgroup(root, env);
  const tids = tasksUnder(cg);
  const procRoot = env.CPU_AVOID_PROC || '/proc';
  const tasks = []; let gone = 0;
  for (const tid of tids) { const r = readTask(procRoot, tid); if (r) tasks.push(r); else gone++; }
  if (!tasks.length) throw broken('no readable task in ' + cg + ' (' + tids.length + ' listed, ' + gone + ' gone): the station runs in this slice, so this is the wrong place');
  const bad = list.avoid.length ? tasks.filter(t => t.allowed.some(c => list.avoid.includes(c))) : [];
  return { list, cgroup: cg, tasks, gone, bad };
}

function dutyLine(r) {
  const pids = [...new Set(r.bad.map(t => t.pid))];
  const names = [...new Set(r.bad.map(t => t.name))].slice(0, 6);
  return r.bad.length + ' of ' + r.tasks.length + ' task(s) in ' + pids.length + ' process(es) of this company may run on avoided cpu ' + formatList(r.list.avoid)
    + ' (' + names.join(', ') + '); AllowedCPUs=' + formatList(r.list.allowed) + ' is not in force on the slice (memory.js apply sets it; an owner action while localComputer is on)';
}

// o: {root, env, out, err} (tests); defaults are the live company and the process's own streams
function main(argv, o) {
  o = o || {}; const root = o.root || ROOT; const env = o.env || process.env;
  const out = o.out || (s => console.log(s)); const err = o.err || (s => console.error(s));
  const cmd = argv[0] || 'status';
  if (cmd === 'selftest' || cmd === '--selftest') return selftest();
  if (cmd === 'allowed') {
    try { const l = readList(root, env); if (!l.allowed) { err('cpu-avoid: no avoid list; nothing to restrict'); return 1; } out(formatList(l.allowed)); return 0; }
    catch (e) { err('cpu-avoid: broken: ' + e.message); return 2; }
  }
  if (cmd === '--duty' || cmd === 'status') {
    let r; try { r = check({ root, env }); } catch (e) { err('cpu-avoid: broken: ' + e.message); return 2; }
    if (cmd === 'status') {
      if (argv.includes('--json')) { out(JSON.stringify({ avoid: r.list.avoid, allowed: r.list.allowed && formatList(r.list.allowed), cgroup: r.cgroup, tasks: r.tasks.length, gone: r.gone, bad: r.bad.map(t => ({ tid: t.tid, pid: t.pid, name: t.name, allowed: formatList(t.allowed) })) })); return r.bad.length ? 1 : 0; }
      out('avoid: ' + (r.list.avoid.length ? formatList(r.list.avoid) + ' (' + (r.list.why || 'no reason given') + '; ' + (r.list.by || '?') + ' ' + (r.list.at || '') + ')' : 'none' + (r.list.missing ? ' (no ' + path.relative(root, r.list.file) + ')' : '')));
      if (r.list.allowed) out('AllowedCPUs=' + formatList(r.list.allowed));
      out('slice cgroup: ' + r.cgroup + ' · ' + r.tasks.length + ' task(s) read' + (r.gone ? ', ' + r.gone + ' ended before the read' : ''));
      out(r.bad.length ? 'NOT CLEAN: ' + dutyLine(r) : 'clean: no task may run on an avoided cpu');
      return r.bad.length ? 1 : 0;
    }
    if (!r.list.avoid.length) { err('cpu-avoid: no avoid list; nothing checked against it (' + r.tasks.length + ' tasks read)'); return 0; }
    if (!r.bad.length) return 0;
    out(JSON.stringify({ due: true, line: dutyLine(r), items: [...new Set(r.bad.map(t => 'pid:' + t.pid))].slice(0, 20) }));
    return 1;
  }
  err('usage: cpu-avoid.js status [--json] | allowed | --duty | selftest (header of company/tools/cpu-avoid.js)');
  return 2;
}

/* ---------------- selftest ---------------- */
// A made-up host: 8 online cpus (0-7), cpus 2 and 6 avoided (one core and its sibling), so 0-1,3-5,7 stay allowed.
function selftest() {
  const assert = require('assert');
  const life = require('./lib/temp-life');
  const T = life.tmpDir('cpu-avoid-selftest-');
  let pass = 0, fail = 0;
  const ok = (name, fn) => { try { fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ': ' + e.message); } };
  const mk = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  function world(o) {
    const d = fs.mkdtempSync(path.join(T, 'w-'));
    const root = path.join(d, 'root'), proc = path.join(d, 'proc'), cg = path.join(d, 'cg');
    mk(path.join(d, 'online'), (o.online || '0-7') + '\n');
    if (o.list !== undefined) mk(LIST(root), typeof o.list === 'string' ? o.list : JSON.stringify(o.list));
    if (!o.noCgroup) fs.mkdirSync(cg, { recursive: true });
    for (const t of o.tasks || []) {
      const tf = path.join(cg, t.cg || '', 'cgroup.threads');
      mk(tf, (fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8') : '') + t.tid + '\n');
      if (!t.gone) mk(path.join(proc, String(t.tid), 'status'), 'Name:\t' + (t.name || 'node') + '\nTgid:\t' + (t.pid || t.tid) + '\nCpus_allowed_list:\t' + t.allowed + '\n');
    }
    return { root, env: { CPU_AVOID_PROC: proc, CPU_AVOID_CGROUP: cg, CPU_AVOID_ONLINE: path.join(d, 'online') } };
  }
  const L = { avoid: [2, 6], why: 'one core miscomputes', by: 'test', at: '2026-01-01T00:00:00Z' };
  const OK = '0-1,3-5,7';
  const run = w => check({ root: w.root, env: w.env });
  const cli = (w, argv) => { const o = [], e = []; const code = main(argv, { root: w.root, env: w.env, out: s => o.push(s), err: s => e.push(s) }); return { code, out: o.join('\n'), err: e.join('\n') }; };
  const throwsBroken = (fn, re) => { let e = null; try { fn(); } catch (x) { e = x; } assert.ok(e && e.broken, 'expected broken, got ' + (e ? e.message : 'no throw')); if (re) assert.ok(re.test(e.message), e.message); };

  ok('C1 parse and format: "0-1,3-5,7" round-trips', () => {
    const a = parseList(OK); assert.strictEqual(a.length, 6); assert.ok(!a.includes(2) && !a.includes(6));
    assert.strictEqual(formatList(a), OK); assert.strictEqual(formatList([5, 3, 4, 9]), '3-5,9');
  });
  ok('C2 allowed list: online 0-7 minus 2,6 is 0-1,3-5,7', () => {
    const w = world({ list: L }); assert.strictEqual(formatList(readList(w.root, w.env).allowed), OK);
  });
  ok('C3 a task allowed on every cpu is flagged (the case this tool exists for)', () => {
    const w = world({ list: L, tasks: [{ tid: 100, allowed: '0-7' }, { tid: 101, pid: 100, allowed: OK }] });
    const r = run(w); assert.strictEqual(r.bad.length, 1); assert.strictEqual(r.bad[0].tid, 100);
  });
  ok('C4 a task allowed only on one avoided cpu is flagged (one is enough)', () => {
    const w = world({ list: L, tasks: [{ tid: 7, allowed: '6' }] }); assert.strictEqual(run(w).bad.length, 1);
  });
  ok('C5 every task on the allowed cpus: clean', () => {
    const w = world({ list: L, tasks: [{ tid: 1, allowed: OK }, { tid: 2, allowed: '5' }] }); assert.strictEqual(run(w).bad.length, 0);
  });
  ok('C6 a task in a nested child cgroup is read (a service unit under the slice)', () => {
    const w = world({ list: L, tasks: [{ tid: 1, allowed: OK }, { tid: 2, cg: 'example-svc-x.service', allowed: '0-7' }] });
    assert.strictEqual(run(w).bad.map(t => t.tid).join(), '2');
  });
  ok('C7 an empty slice is broken, not clean', () => { const w = world({ list: L, tasks: [] }); throwsBroken(() => run(w), /no readable task/); });
  ok('C8 a missing slice cgroup is broken, not clean', () => { const w = world({ list: L, noCgroup: true }); throwsBroken(() => run(w), /does not exist/); });
  ok('C9 a list that is not JSON is broken', () => { const w = world({ list: '{avoid:' }); throwsBroken(() => readList(w.root, w.env), /not JSON/); });
  ok('C10 a cpu that is not online is broken', () => { const w = world({ list: { avoid: [2, 40] } }); throwsBroken(() => readList(w.root, w.env), /not online/); });
  ok('C11 avoiding more than half is refused', () => { const w = world({ online: '0-3', list: { avoid: [0, 1, 2] } }); throwsBroken(() => readList(w.root, w.env), /fewer than half/); });
  ok('C12 no list file: nothing avoided, nothing flagged', () => {
    const w = world({ tasks: [{ tid: 1, allowed: '0-7' }] }); const r = run(w); assert.ok(r.list.missing); assert.strictEqual(r.bad.length, 0);
  });
  ok('C13 a task that ended before the read is counted, not flagged', () => {
    const w = world({ list: L, tasks: [{ tid: 1, allowed: OK }, { tid: 2, gone: true }] }); const r = run(w); assert.strictEqual(r.gone, 1); assert.strictEqual(r.bad.length, 0);
  });
  ok('C14 the duty line names the avoided cpus and the AllowedCPUs value', () => {
    const w = world({ list: L, tasks: [{ tid: 9, name: 'python3', allowed: '0-7' }] }); const line = dutyLine(run(w));
    assert.ok(/avoided cpu 2,6/.test(line) && new RegExp('AllowedCPUs=' + OK).test(line) && /python3/.test(line), line);
  });
  ok('C15 a bad cpu-list string is broken', () => throwsBroken(() => parseList('0-x'), /not a cpu list/));
  ok('C16 --duty on a list that is not JSON exits 2 (fails closed), and so does allowed', () => {
    const w = world({ list: '{avoid:', tasks: [{ tid: 1, allowed: '0-7' }] });
    const d = cli(w, ['--duty']); assert.strictEqual(d.code, 2, 'duty exit ' + d.code); assert.ok(/broken: .*not JSON/.test(d.err), d.err); assert.strictEqual(d.out, '');
    assert.strictEqual(cli(w, ['allowed']).code, 2);
  });
  ok('C17 --duty exit codes: 1 with one due JSON line when flagged, 0 when clean, 0 with a note when there is no list', () => {
    const d = cli(world({ list: L, tasks: [{ tid: 1, allowed: '0-7' }] }), ['--duty']);
    assert.strictEqual(d.code, 1); const j = JSON.parse(d.out); assert.ok(j.due === true && /avoided cpu 2,6/.test(j.line) && j.items[0] === 'pid:1', d.out);
    assert.strictEqual(cli(world({ list: L, tasks: [{ tid: 1, allowed: OK }] }), ['--duty']).code, 0);
    const n = cli(world({ tasks: [{ tid: 1, allowed: '0-7' }] }), ['--duty']); assert.strictEqual(n.code, 0); assert.ok(/no avoid list/.test(n.err), n.err);
  });
  ok('C18 allowed prints the AllowedCPUs value; no list exits 1 with no line', () => {
    const a = cli(world({ list: L }), ['allowed']); assert.strictEqual(a.code, 0); assert.strictEqual(a.out, OK);
    const n = cli(world({}), ['allowed']); assert.strictEqual(n.code, 1); assert.strictEqual(n.out, '');
  });
  life.cleanup();
  console.log((fail ? 'FAILED' : 'PASSED') + ' ' + pass + ' ok, ' + fail + ' FAIL');
  return fail ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseList, formatList, readList, check, dutyLine, main, LIST };
