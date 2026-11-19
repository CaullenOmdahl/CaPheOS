'use strict';
/* reaper-selftest.js — `node company/tools/reaper.js selftest`: real processes and a real headless Chrome (when one is
 * installed; those cases are skipped with a reason otherwise), all inside a temp company root next to a second company
 * whose name shares its prefix (/x/co and /x/co-2). Never the live companies, never a live port: the mock station is an
 * ephemeral port on 127.0.0.1. Every dir and helper process goes with lib/temp-life.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const cp = require('child_process');
const assert = require('assert');
const life = require('../../lib/temp-life');
const TOOLS = path.join(__dirname, '..', '..');
const RP = require(path.join(TOOLS, 'reaper.js'));
const DR = require(path.join(TOOLS, 'lib', 'duty-runner.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function findChrome() {
  for (const c of [process.env.CHROME, '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/local/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'])
    if (c && fs.existsSync(c)) return c;
  return null;
}
const W = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); return f; };
const OLD = s => Date.now() / 1000 - s;
function ageTree(p, secs) { const t = OLD(secs); const walk = q => { let st; try { st = fs.lstatSync(q); } catch (_) { return; } if (st.isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e)); try { fs.lutimesSync(q, t, t); } catch (_) {} }; walk(p); }

async function selftest() {
  let bad = 0, skipped = 0;
  const check = async (name, fn) => { try { const r = await fn(); if (r && r.skip) { skipped++; console.log('skip ' + name + ' — ' + r.skip); } else console.log('ok   ' + name); } catch (e) { bad++; console.log('FAIL ' + name + ': ' + (e && e.stack || e)); } };
  const T = life.tmpDir('reaper-selftest-');
  const X = path.join(T, 'x'); const co = path.join(X, 'co'); const co2 = path.join(X, 'co-2');
  const shared = path.join(T, 'shared'); const priv = path.join(co, '.starnet-data', 'tmp');
  for (const d of [shared, priv, path.join(co2, '.starnet-data', 'tmp'), path.join(co, 'company', 'state'), path.join(co, 'scratch'), path.join(co, 'home', '.config')]) fs.mkdirSync(d, { recursive: true });
  W(path.join(co, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', slug: 'testco', station: { serviceName: 'testco-station' } }));
  W(path.join(co2, 'company', 'company.json'), JSON.stringify({ name: 'Other Co', slug: 'otherco', station: { serviceName: 'otherco-station' } }));
  W(path.join(co, 'company', 'tools', 'loops.json'), JSON.stringify({ agents: { paul: { name: 'Paul' } } }));
  const DEAD1 = 3999991, DEAD2 = 3999992;
  W(path.join(co, 'company', 'state', 'reaper.json'), JSON.stringify({ v: 1, stationPids: [{ pid: DEAD1, firstSeen: new Date().toISOString() }] }));
  const orphans = [];   // pids of every double-forked helper, ended in finally whatever happened
  // start a program whose parent exits at once: it is handed to init / systemd --user, like a left-behind process
  async function orphan(argv, opts) {
    const r = cp.spawnSync('sh', ['-c', '"$0" "$@" >/dev/null 2>&1 </dev/null & echo $!'].concat(argv), Object.assign({ encoding: 'utf8' }, opts || {}));
    const pid = Number(String(r.stdout).trim()); if (pid) orphans.push(pid);
    await sleep(150);
    return pid;
  }
  const chrome = findChrome();
  const chromeArgs = profile => ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--user-data-dir=' + profile, 'about:blank'];
  // Chrome's own temp files (its singleton socket among them) in a short dir of the test: a unix socket path has at most
  // 107 bytes, and a profile deep in a fixture company plus Chrome's socket name is longer than that
  let tn = 0;
  const chromeEnv = () => { const t = path.join(T, 'c' + (++tn)); fs.mkdirSync(t, { recursive: true }); return Object.assign({}, process.env, { TMPDIR: t, DBUS_SESSION_BUS_ADDRESS: 'disabled:' }); };
  const portOf = async profile => { for (let i = 0; i < 100; i++) { try { const p = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (p) return p; } catch (_) {} await sleep(100); } return 0; };
  const base = (o) => RP.context(Object.assign({ root: co, supervisor: 'none', cgroupOf: () => '', tempDirs: [shared, priv], forceTemp: true, minAgeS: 0, graceMs: 1500, home: path.join(co, 'home'),
    meminfo: 'MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n', noNetwork: true, card: { file: () => ({ filed: false, route: 'crew' }) } }, o || {}));
  const kids = [];
  let sock = null;
  try {
    /* ---------- the proof rules on the live process table ---------- */
    await check('a process whose working folder is in /x/co-2 is not /x/co\'s (prefix), one in /x/co is', async () => {
      const a = life.track(cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { cwd: co2, stdio: 'ignore' }));
      const b = life.track(cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { cwd: path.join(co, 'scratch'), stdio: 'ignore' }));
      await sleep(200);
      const O = require(path.join(TOOLS, 'lib', 'owned.js'));
      const c = O.context({ root: co, cgroupOf: () => '' });
      const all = O.scan(c);
      assert.strictEqual(O.proof(all.get(a.pid), c), null);
      assert.strictEqual(O.proof(all.get(b.pid), c).how, 'path');
      const fc = O.context({ root: co, cgroupOf: pid => pid === b.pid ? '0::/user.slice/user@1000.service/app.slice/someone-else.service' : '' });
      assert.ok(O.foreign(O.scan(fc).get(b.pid), fc), 'in a unit the company does not own: foreign');
      const uc = O.context({ root: co2, cgroupOf: pid => pid === a.pid ? '0::/user.slice/user@1000.service/app.slice/testco-station.service' : '' });
      assert.ok(!O.proof(O.scan(uc).get(a.pid), O.context({ root: co, cgroupOf: () => '' })), 'its cgroup is read per context');
      const ucx = O.context({ root: co, cgroupOf: pid => pid === a.pid ? '0::/user.slice/user@1000.service/app.slice/testco-station.service' : '' });
      assert.strictEqual(O.proof(O.scan(ucx).get(a.pid), ucx).how, 'unit', 'inside the company\'s station unit');
      a.kill('SIGKILL'); b.kill('SIGKILL');
    });

    /* ---------- browsers ---------- */
    let A = null, B = null, C = null, D = null, E = null;
    if (chrome) {
      const pA = path.join(priv, 'walk-chrome-AAAAAA'); fs.mkdirSync(pA); life.own(pA);
      const cwdA = path.join(co, 'scratch', 'paul-walk'); fs.mkdirSync(cwdA);
      A = { profile: pA, pid: await orphan([chrome].concat(chromeArgs(pA)), { cwd: cwdA, env: chromeEnv(pA) }) };
      const pB = path.join(priv, 'live-chrome-BBBBBB'); fs.mkdirSync(pB); life.own(pB);
      B = { profile: pB, proc: life.track(cp.spawn(chrome, chromeArgs(pB), { cwd: co, env: chromeEnv(pB), stdio: 'ignore' })) }; B.pid = B.proc.pid;
      const pC = path.join(priv, 'used-chrome-CCCCCC'); fs.mkdirSync(pC); life.own(pC);
      C = { profile: pC, pid: await orphan([chrome].concat(chromeArgs(pC)), { cwd: co, env: chromeEnv(pC) }) };
      const pD = path.join(co2, '.starnet-data', 'tmp', 'other-chrome-DDDDDD'); fs.mkdirSync(pD); life.own(pD);
      D = { profile: pD, pid: await orphan([chrome].concat(chromeArgs(pD)), { cwd: co2, env: chromeEnv(pD) }) };
      const pE = path.join(co, 'home', '.config', 'chrome-own'); fs.mkdirSync(pE); life.own(pE);
      E = { profile: pE, pid: await orphan([chrome].concat(chromeArgs(pE)), { cwd: co, env: chromeEnv(pE) }) };
      const cport = await portOf(pC);
      await Promise.all([portOf(pA), portOf(pB), portOf(pD), portOf(pE)]);
      sock = net.connect(cport, '127.0.0.1'); await new Promise(r => sock.once('connect', r).once('error', r));
      await sleep(300);
    }

    /* ---------- strays ---------- */
    const sDir = path.join(co, 'scratch', 'paul-stray'); fs.mkdirSync(sDir);
    const sleepBin = cp.execFileSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim();
    const unknownPid = await orphan([sleepBin, '300'], { cwd: sDir });
    const ft = path.join(co, 'bin', 'flutter_tester'); fs.mkdirSync(path.dirname(ft)); fs.copyFileSync(sleepBin, ft); fs.chmodSync(ft, 0o755);
    const flutterPid = await orphan([ft, '301'], { cwd: sDir });

    /* ---------- temp ---------- */
    const mkOld = (dir, name, secs) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); W(path.join(p, 'f'), 'x'.repeat(8192)); ageTree(p, secs); return p; };
    mkOld(priv, 'old-thing', 30 * 3600); mkOld(priv, 'young-thing', 60);
    const held = mkOld(priv, 'held-thing', 30 * 3600);
    kids.push(life.track(cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { cwd: held, stdio: 'ignore' })));
    mkOld(priv, 'half-day-thing', 12 * 3600);
    mkOld(shared, 'tmpabcdefgh', 30 * 3600);
    mkOld(shared, 'starnet-browser-' + DEAD1 + '-x', 60); mkOld(shared, 'starnet-browser-' + DEAD2 + '-y', 60);
    mkOld(shared, 'routes-walk-Old123', 3 * 3600);
    assert.ok(!alive(DEAD1) && !alive(DEAD2), 'the test pids are free');

    /* ---------- retention ---------- */
    const ws = path.join(co, '.starnet-data');
    for (let i = 1; i <= 5; i++) { const d = path.join(ws, 'workspaces.backup-2026111' + i); W(path.join(d, 'f'), 'b'.repeat(4096 * i)); ageTree(d, (10 - i) * 86400); }
    const repo = path.join(T, 'repo');
    const git = (args, cwd) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main'].concat(args), { cwd: cwd || repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) });
    let haveGit = true;
    try {
      fs.mkdirSync(repo); git(['init', '-q']); W(path.join(repo, 'a.txt'), 'a'); git(['add', '-A']); git(['commit', '-qm', 'one']);
      git(['worktree', 'add', '-q', '-b', 'done', path.join(co, 'scratch', 'paul-done')]);
      git(['worktree', 'add', '-q', '-b', 'dirty', path.join(co, 'scratch', 'paul-dirty')]); W(path.join(co, 'scratch', 'paul-dirty', 'new.txt'), 'n');
      ageTree(path.join(co, 'scratch', 'paul-done'), 20 * 86400); ageTree(path.join(co, 'scratch', 'paul-dirty'), 20 * 86400);
    } catch (e) { haveGit = false; }
    W(path.join(co, 'company', 'work', 'ops', 'retention.json'), JSON.stringify({ artifacts: [
      { id: 'workspace-backups', path: '.starnet-data/workspaces.backup-*', policy: 'keep-newest-dirs', keep: 3, keepDays: 0, warnBytes: 1, enforce: false, plain: 'Old copies of the workspace backups' },
      { id: 'scratch-worktrees', path: 'scratch', policy: 'merged-worktrees', keepDays: 14, enforce: true, plain: 'Finished work copies the crew left in the scratch folder' }] }));
    const cards = [];
    const card = { file: (o) => { cards.push(o); return { filed: true, id: 'q-' + cards.length }; } };

    const lines = () => { try { return fs.readFileSync(path.join(co, 'company', 'state', 'reaper.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
    // a first look: an orphan's idle clock starts here (reaper.json browserIdle); nothing is ended on its first idle sighting
    const first = await RP.run(base({ card, browserIdleS: 0 }), { only: ['browsers'] });
    await check('browsers: the first idle sighting of an orphan only starts its clock', async () => {
      if (!chrome) return { skip: 'no Chrome on this machine' };
      assert.ok(alive(A.pid), 'A still runs after the first look');
      assert.match(first.browsers.list.find(x => x.pid === A.pid).decision, /clock starts/);
    });
    const ctx = base({ card, browserIdleS: 0 });
    const res = await RP.run(ctx);

    await check('browsers: an orphaned, idle browser of this company is ended, its temp profile removed, one plain line', async () => {
      if (!chrome) return { skip: 'no Chrome on this machine' };
      await sleep(300);
      assert.ok(!alive(A.pid), 'A ended');
      assert.ok(!fs.existsSync(A.profile), 'its profile is gone');
      const l = lines().find(r => r.kind === 'browser' && r.pid === A.pid);
      assert.ok(l && /^Closed a browser left running by Paul's work \(\d+ min old, \d+ MB\)\.$/.test(l.plain), JSON.stringify(l));
    });
    await check('browsers: one with a live parent, one with a client on its port, one of the other company, one on a ~/.config profile: all kept', async () => {
      if (!chrome) return { skip: 'no Chrome on this machine' };
      for (const [n, b] of [['live parent', B], ['client connected', C], ['other company', D], ['~/.config profile', E]]) assert.ok(alive(b.pid), n + ' still runs');
      const L = res.browsers.list;
      assert.strictEqual(L.find(x => x.pid === B.pid).decision, 'its parent still runs');
      assert.strictEqual(L.find(x => x.pid === C.pid).decision, 'something is connected to it');
      assert.ok(!L.find(x => x.pid === D.pid) && !L.find(x => x.pid === E.pid), 'never listed: not this company\'s / the owner\'s');
    });
    await check('strays: a known kind (flutter_tester) is ended; an unknown one (sleep) is listed and reported, not ended', async () => {
      await sleep(200);
      assert.ok(!alive(flutterPid), 'flutter_tester ended');
      assert.ok(alive(unknownPid), 'sleep kept');
      assert.ok(lines().some(r => r.kind === 'stray' && r.pid === flutterPid && /^Ended a left-behind flutter_tester from Paul's work/.test(r.plain)));
      assert.ok(res.due.some(d => d.id === 'stray:' + unknownPid && /not a kind the reaper may end/.test(d.reason)), JSON.stringify(res.due));
    });
    await check('temp: private old goes; held and young stay; shared: only this company\'s station pids', async () => {
      const left = new Set(fs.readdirSync(priv)); const sh = new Set(fs.readdirSync(shared));
      assert.ok(!left.has('old-thing') && left.has('young-thing') && left.has('held-thing') && left.has('half-day-thing'), [...left].join());
      assert.ok(sh.has('tmpabcdefgh'), 'a Python temp dir in the shared folder is the host\'s: kept');
      assert.ok(!sh.has('starnet-browser-' + DEAD1 + '-x') && sh.has('starnet-browser-' + DEAD2 + '-y'), [...sh].join());
      assert.ok(sh.has('routes-walk-Old123'), 'a test walk in the shared folder may be another company\'s (its own runs keep TMPDIR in its private dir): kept, the owner\'s button');
      assert.ok(lines().some(r => r.kind === 'temp' && /^Removed \d+ old temp items nobody used \(/.test(r.plain)));
    });
    await check('host-sweep lists the shared leftovers it cannot trace; --apply only for the owner', async () => {
      const r = RP.hostSweep({ root: co, dirs: [shared] });
      assert.ok(r.wouldGo >= 1 && r.byClass.pytmp && !r.applied, JSON.stringify(r));
      assert.ok(/owner/.test(RP.hostSweep({ root: co, dirs: [shared], apply: true, by: 'paul' }).refused));
      assert.ok(fs.existsSync(path.join(shared, 'tmpabcdefgh')));
      const a = RP.hostSweep({ root: co, dirs: [shared], apply: true, by: 'owner', ownerShell: () => true });
      assert.ok(a.applied && !fs.existsSync(path.join(shared, 'tmpabcdefgh')) && fs.existsSync(path.join(shared, 'starnet-browser-' + DEAD2 + '-y')) === false, JSON.stringify(a));
      assert.ok(lines().some(l => l.kind === 'host-temp' && /^You cleared/.test(l.plain)));
    });
    await check('retention: a report-first row deletes nothing and asks the owner once; a yes keeps the newest 3', async () => {
      assert.strictEqual(fs.readdirSync(ws).filter(n => n.startsWith('workspaces.backup-')).length, 5);
      assert.strictEqual(cards.length, 1, JSON.stringify(cards.map(c => c.ref)));
      assert.strictEqual(cards[0].ref, 'retention:workspace-backups');
      const OC = require(path.join(TOOLS, 'lib', 'owner-card.js'));
      for (const k of ['lead', 'consequence', 'recommendation']) assert.ok(OC.plain(cards[0][k]), k + ' is plain: ' + cards[0][k] + ' ' + OC.plainProblems(cards[0][k]).join());
      const again = base({ card, answerOf: () => null }); again.forceRetention = true; await RP.run(again, { only: ['retention'] });
      assert.strictEqual(cards.length, 1, 'asked once');
      const yes = base({ card, answerOf: ref => ref === 'retention:workspace-backups' ? { yes: true, id: 'q-1' } : null }); yes.forceRetention = true;
      await RP.run(yes, { only: ['retention'] });
      const left = fs.readdirSync(ws).filter(n => n.startsWith('workspaces.backup-')).sort();
      assert.deepStrictEqual(left, ['workspaces.backup-20261113', 'workspaces.backup-20261114', 'workspaces.backup-20261115']);
      assert.ok(lines().some(l => l.kind === 'retention' && /^Removed 2 of these: old copies of the workspace backups/.test(l.plain)), JSON.stringify(lines().filter(l => l.kind === 'retention')));
      const halted = base({ card, halted: 'soft' }); halted.forceRetention = true;
      assert.strictEqual(RP.stepRetention(halted).skipped, 'halted');
    });
    await check('retention: a merged, clean worktree is removed with git worktree remove; a dirty one is kept', async () => {
      if (!haveGit) return { skip: 'git did not set up the fixture' };
      assert.ok(!fs.existsSync(path.join(co, 'scratch', 'paul-done')), 'merged one removed');
      assert.ok(fs.existsSync(path.join(co, 'scratch', 'paul-dirty', 'new.txt')), 'dirty one kept');
      assert.ok(!/paul-done/.test(git(['worktree', 'list'])), 'git knows it is gone (not rm)');
    });
    await check('pressure: short memory asks the mock station to close its unused browser, halves the temp ages, records it', async () => {
      const calls = [];
      const srv = http.createServer((q, s) => { calls.push(q.method + ' ' + q.url + ' ' + q.headers['x-starnet-token']); s.setHeader('content-type', 'application/json'); s.end(q.method === 'GET' ? JSON.stringify({ ok: true, station: { open: true, driver: null } }) : JSON.stringify({ ok: true, open: false })); });
      await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
      assert.ok(![8800, 8810, 8900, 8910].includes(port));
      W(path.join(co, 'secrets', 'station-token'), 'tok123');
      const cfg = JSON.parse(fs.readFileSync(path.join(co, 'company', 'company.json'), 'utf8')); cfg.station.url = 'http://127.0.0.1:' + port; W(path.join(co, 'company', 'company.json'), JSON.stringify(cfg));
      const p = base({ noNetwork: false, meminfo: 'MemTotal: 8388608 kB\nMemAvailable: 102400 kB\n' });
      // STARNET_URL wins over company.json (as in lib/company.js): scripts/test.sh points it at a closed port, so this
      // case first checks that, then clears it to reach the mock
      const savedUrl = process.env.STARNET_URL;
      process.env.STARNET_URL = 'http://127.0.0.1:1';
      const viaEnv = await RP.run(base({ noNetwork: false, meminfo: 'MemTotal: 8388608 kB\nMemAvailable: 102400 kB\n' }), { only: ['pressure'] });
      assert.ok(viaEnv.pressureStep && viaEnv.pressureStep.short && viaEnv.pressureStep.closed === null && calls.length === 0, 'STARNET_URL is used: the mock was not called ' + JSON.stringify(viaEnv.pressureStep));
      delete process.env.STARNET_URL;
      let r; try { r = await RP.run(p, { only: ['temp', 'pressure'] }); } finally { if (savedUrl === undefined) delete process.env.STARNET_URL; else process.env.STARNET_URL = savedUrl; }
      srv.close();
      assert.ok(r.pressure.short, JSON.stringify(r.pressure));
      assert.deepStrictEqual(calls, ['GET /api/browser/view tok123', 'POST /api/browser/view/close tok123']);
      assert.ok(!fs.existsSync(path.join(priv, 'half-day-thing')), 'a 12 h old entry goes under pressure (6 h, not 24 h)');
      const mp = JSON.parse(fs.readFileSync(path.join(co, 'company', 'state', 'memory-pressure.json'), 'utf8'));
      assert.ok(mp.since && mp.availableMB === 100 && !mp.endedAt);
      const calm = base({}); await RP.run(calm, { only: ['pressure'] });
      assert.ok(JSON.parse(fs.readFileSync(path.join(co, 'company', 'state', 'memory-pressure.json'), 'utf8')).endedAt, 'the end of the pressure is recorded');
    });
    await check('contract: due output is one valid duty JSON; --duty under READONLY changes nothing and prints nothing', async () => {
      const d = RP.dueJson(res);
      const p = DR.parseDue(JSON.stringify(d));
      assert.ok(!p.error && p.route === 'tools' && p.items.some(i => i.id === 'stray:' + unknownPid), JSON.stringify(p));
      assert.strictEqual(RP.dueJson({ due: [] }), null);
      const empty = path.join(T, 'empty'); W(path.join(empty, 'company', 'company.json'), '{"slug":"empty"}');
      const ro = cp.spawnSync(process.execPath, [path.join(TOOLS, 'reaper.js'), '--duty'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: empty, CAPHEOS_ROOT: empty, CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1' } });
      assert.strictEqual(ro.status, 0, ro.stderr); assert.strictEqual(ro.stdout, '');
      assert.ok(!fs.existsSync(path.join(empty, 'company', 'state')), 'nothing written');
      const rw = cp.spawnSync(process.execPath, [path.join(TOOLS, 'reaper.js'), '--duty'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: empty, CAPHEOS_ROOT: empty, CAPHEOS_CHORE: '1', CAPHEOS_NO_NETWORK: '1' } });
      assert.ok(rw.status === 0 || rw.status === 1, rw.stderr);
      if (rw.stdout.trim()) { const j = JSON.parse(rw.stdout); assert.ok(j.acted || j.due); }
      assert.ok(fs.existsSync(path.join(empty, 'company', 'state', 'reaper.json')), 'a chore run records its state');
      const reg = DR.registry().find(x => x.id === 'reaper');
      assert.ok(DR.isChore(reg) && !DR.choreEnv({ CAPHEOS_READONLY: '1', CAPHEOS_NO_NETWORK: '1' }).CAPHEOS_READONLY, 'the runner runs it as a chore');
      assert.ok(!DR.isChore(Object.assign({}, reg, { id: 'tool-parse' })) && !DR.isChore(Object.assign({}, reg, { source: 'modules/x/module.json' })), 'nothing else is');
    });
    await check('pattern and week helpers', async () => {
      assert.strictEqual(RP.patternOf('tmpab12cd_9'), 'tmp*'); assert.strictEqual(RP.patternOf('console-walk-Ab12Cd'), 'console-walk-*');
      assert.strictEqual(RP.isoWeek(Date.parse('2026-11-19T12:00:00Z')), '2026-W47');
    });
  } catch (e) { bad++; console.log('FAIL selftest threw: ' + (e && e.stack || e)); }
  finally {
    try { if (sock) sock.destroy(); } catch (_) {}
    for (const pid of orphans) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    life.cleanup();
  }
  console.log(bad ? 'REAPER SELFTEST FAILED: ' + bad : 'REAPER SELFTEST PASSED' + (skipped ? ' (' + skipped + ' skipped)' : ''));
  return bad ? 1 : 0;
}
module.exports = { selftest };
