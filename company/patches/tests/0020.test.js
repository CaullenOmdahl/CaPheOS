#!/usr/bin/env node
/* company/patches/tests/0020.test.js — StarNet patch 0020 (memory lifecycle), against a real StarNet checkout.
 *
 *   node company/patches/tests/0020.test.js [--starnet <dir>] [--quick]
 *
 * The checkout is $CAPHEOS_STARNET_SRC, --starnet, or <repo>/starnet (a founded company has one; the framework repo does
 * not, and then this prints SKIP and exits 0). It is never written: sidecar/, test/, shared/ and package.json are copied
 * into a temp dir (node_modules is linked), the record is applied there unless that copy already carries it, and
 * everything runs in the copy. --quick leaves out StarNet's own test files.
 *
 * Cases: StarNet's own shell, browser-view, browser-close-cleanup, procledger and concurrency tests on the patched copy;
 * then, with real processes, one case per STARNET_* variable the record reads (see its header). Chrome cases skip with a
 * reason when no Chrome is installed. Every temp dir, browser and helper goes through company/tools/lib/temp-life.js.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..', '..');
const life = require(path.join(REPO, 'company', 'tools', 'lib', 'temp-life.js'));
const RECORD = path.join(REPO, 'company', 'patches', '0020-memory-lifecycle.diff');
const SC = require('./starnet-copy');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const QUICK = argv.includes('--quick');
const ENV_KEYS = ['STARNET_SHELL_REAP_GROUP', 'STARNET_SHELL_OOM_ADJ', 'STARNET_BROWSER_OWN_GROUP', 'STARNET_BROWSER_LOWMEM',
  'STARNET_BROWSER_RENDERER_LIMIT', 'STARNET_BROWSER_IDLE_MIN', 'STARNET_PRIVATE_BROWSERS_MAX'];

const delay = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await delay(50); } return fn(); }
function naming(needle) {
  const out = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try { if (fs.readFileSync('/proc/' + e + '/cmdline', 'utf8').includes(needle)) out.push(Number(e)); } catch (_) {}
  }
  return out;
}
function findChrome() {
  for (const c of [process.env.STARNET_CHROME, '/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return null;
}
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars || {});
  const restore = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  return Promise.resolve(r).finally(restore);
}

const results = [];
async function tcase(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    if (r && r.skip) { results.push(['SKIP', name, r.skip]); console.log('  SKIP  ' + name + ' — ' + r.skip); }
    else { results.push(['PASS', name]); console.log('  PASS  ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
  } catch (e) { results.push(['FAIL', name, e && e.stack || String(e)]); console.log('  FAIL  ' + name + '\n' + String(e && e.stack || e).split('\n').slice(0, 8).map(l => '        | ' + l).join('\n')); }
}

(async () => {
  if (process.platform !== 'linux') { console.log('SKIP 0020: Linux only (process groups, /proc, cgroups)'); return; }
  const src = SC.findSource(arg('--starnet'));
  if (!src) { console.log('SKIP 0020: no StarNet checkout (set CAPHEOS_STARNET_SRC or run inside a company that has ./starnet)'); return; }
  life.setGrace(800);
  const { dir: SN, applied } = SC.prepare(src, RECORD, 'capheos-0020-');
  console.log('0020 on a copy of ' + src + ' (' + applied + ')');
  const ML = require(path.join(SN, 'sidecar', 'memory-lifecycle.js'));
  const { makeShellTool } = require(path.join(SN, 'sidecar', 'tools', 'builtin', 'shell.js'));
  const { makeEnvironmentManager } = require(path.join(SN, 'sidecar', 'environment.js'));
  const B = require(path.join(SN, 'sidecar', 'tools', 'builtin', 'browser.js'))._internals;
  const { makeBrowserViews } = require(path.join(SN, 'sidecar', 'browser-view.js'));
  const work = life.tmpDir('capheos-0020-w-');

  // ---- StarNet's own tests on the patched copy: unchanged behaviour with every variable unset ----
  if (!QUICK) {
    const files = ['shell.test.js', 'shell.process-tree.test.js', 'shell.fg-ledger.test.js', 'browser-close-cleanup.test.js', 'browser-view.test.js',
      'procledger.test.js', 'concurrency.test.js'].map(f => path.join('test', f)).filter(f => fs.existsSync(path.join(SN, f)));
    for (const [label, vars] of [['unset', {}], ['set', { STARNET_SHELL_REAP_GROUP: '1', STARNET_SHELL_OOM_ADJ: '500', STARNET_BROWSER_OWN_GROUP: '1', STARNET_BROWSER_LOWMEM: '1', STARNET_BROWSER_IDLE_MIN: '5', STARNET_PRIVATE_BROWSERS_MAX: '3' }]]) {
      await tcase('StarNet tests, 0020 variables ' + label + ' (' + files.length + ' files)', async () => {
        const env = Object.assign({}, process.env); for (const k of ENV_KEYS) delete env[k]; Object.assign(env, vars);
        const r = await new Promise(resolve => {
          const kid = life.track(cp.spawn(process.execPath, ['--test', '--test-concurrency=4'].concat(files), { cwd: SN, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }), { group: true });
          let out = ''; kid.stdout.on('data', d => { out += d; }); kid.stderr.on('data', d => { out += d; });
          kid.on('close', code => resolve({ code, out }));
        });
        assert.strictEqual(r.code, 0, 'StarNet tests failed:\n' + r.out.split('\n').filter(l => /^not ok|^# (pass|fail)/.test(l)).join('\n'));
      });
    }
  }

  // ---- shell ----
  const shellVia = {
    'shell.exec (direct)': () => makeShellTool({ spawn: cp.spawn, fs, pathMod: path, root: path.join(work, 'jail'), redact: s => s }).execTool,
    'shell.exec (environment, production)': () => {
      const environment = makeEnvironmentManager({ spawn: cp.spawn, fs, pathMod: path, root: path.join(work, 'ws'), clock: { now: () => Date.now() } });
      return makeShellTool({ environment, spawn: cp.spawn, fs, pathMod: path, root: path.join(work, 'ws2'), redact: s => s }).execTool;
    }
  };
  fs.mkdirSync(path.join(work, 'jail'), { recursive: true });
  fs.mkdirSync(path.join(work, 'ws2'), { recursive: true });
  const ctx = { agentId: 'a1', runId: 'r1', callId: 'c1', emit() {} };
  const stray = tag => 'node -e "setInterval(()=>{},1000)" ' + tag + ' >/dev/null 2>&1 &';
  for (const [label, make] of Object.entries(shellVia)) {
    await tcase(label + ': a finished command leaves its `… &` behind with STARNET_SHELL_REAP_GROUP unset', () => withEnv({}, async () => {
      const tag = 'cap0020-keep-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
      const r = await make().run({ cmd: stray(tag) + ' echo done' }, ctx);
      assert.ok(/done/.test(r.content), 'the command ran');
      const left = await waitFor(() => naming(tag).length ? naming(tag) : null, 3000);
      try { assert.ok(left && left.length, 'today\'s behaviour: the background process outlives the call'); }
      finally { for (const p of naming(tag)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} } }
    }));
    await tcase(label + ': with STARNET_SHELL_REAP_GROUP=1 nothing of the command is left', () => withEnv({ STARNET_SHELL_REAP_GROUP: '1' }, async () => {
      const tag = 'cap0020-reap-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
      const tool = make();
      assert.ok(/background:true/.test(tool.description) && /ends when the command finishes/.test(tool.description), 'the description says so');
      const r = await tool.run({ cmd: stray(tag) + ' echo done' }, ctx);
      assert.ok(/done/.test(r.content));
      const gone = await waitFor(() => naming(tag).length === 0, 4000);
      for (const p of naming(tag)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} }
      assert.ok(gone, 'the background process was ended with the command');
    }));
  }
  await tcase('shell.exec: STARNET_SHELL_OOM_ADJ=500 — the command and its children run at oom_score_adj 500', () => withEnv({ STARNET_SHELL_OOM_ADJ: '500' }, async () => {
    const r = await shellVia['shell.exec (environment, production)']().run({ cmd: 'cat /proc/self/oom_score_adj; sh -c "cat /proc/self/oom_score_adj"' }, ctx);
    const nums = (r.content.match(/^\s*-?\d+\s*$/mg) || []).map(s => Number(s.trim()));
    assert.deepStrictEqual(nums.slice(0, 2), [500, 500], 'read: ' + r.content);
    const r0 = await withEnv({}, () => shellVia['shell.exec (direct)']().run({ cmd: 'cat /proc/self/oom_score_adj' }, ctx));
    const base = Number((r0.content.match(/^\s*-?\d+\s*$/m) || ['-1'])[0].trim());
    assert.notStrictEqual(base, 500, 'unset: inherited score, not 500');
    assert.strictEqual(ML.oomPrefix({ STARNET_SHELL_OOM_ADJ: '1001' }, 'linux'), '', 'out of range: nothing');
    assert.strictEqual(ML.oomPrefix({ STARNET_SHELL_OOM_ADJ: '500' }, 'darwin'), '', 'not Linux: nothing');
  }));
  await tcase('shell.bg: a background-tool process survives with STARNET_SHELL_REAP_GROUP=1', () => withEnv({ STARNET_SHELL_REAP_GROUP: '1' }, async () => {
    const tag = 'cap0020-bg-' + process.pid;
    const { makeShellBg } = require(path.join(SN, 'sidecar', 'shellbg.js'));
    const bg = makeShellBg({ spawn: cp.spawn, redact: x => x, clock: { now: () => Date.now() }, newId: () => require('crypto').randomUUID(), maxPerAgent: 5 });
    const tool = makeShellTool({ spawn: cp.spawn, fs, pathMod: path, root: path.join(work, 'jail'), redact: x => x, bg }).execTool;
    const started = await tool.run({ cmd: 'node -e "setInterval(()=>{},1000)" ' + tag, background: true }, ctx);
    try {
      assert.ok(started && /bg|background/i.test(String(started.content || started.summary || '')), 'started: ' + JSON.stringify(started).slice(0, 300));
      assert.ok(await waitFor(() => naming(tag).length > 0, 3000), 'the background process runs');
      // a foreground command finishing right after must not take the background one with it
      await tool.run({ cmd: 'echo fg' }, ctx);
      await delay(2000);
      assert.ok(naming(tag).length > 0, 'the shell.bg process is still running');
    } finally { try { bg.killAll && bg.killAll(); } catch (_) {} for (const p of naming(tag)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} } }
  }));

  // ---- browser ----
  const chrome = findChrome();
  const noChrome = { skip: 'no Chrome or Chromium installed' };
  async function launch(vars, extra) {
    const prof = life.tmpDir('c20-');   // short: Chrome's singleton socket path must stay under 108 bytes
    const d = B.makeCdpDriver(Object.assign({ chrome, profileDir: prof, cdpPort: 0, forceHeadless: true, headless: true, cleanupProfile: true, networkProxy: false, timeoutMs: 20000 }, extra || {}));
    await d.navigate('about:blank');
    const pid = d.ownedPid();
    return { d, pid, prof };
  }
  await tcase('browser: STARNET_BROWSER_OWN_GROUP=1 — Chrome stays in this cgroup, keeps its temp files in the profile, and close leaves nothing', async () => {
    if (!chrome) return noChrome;
    return withEnv({ STARNET_BROWSER_OWN_GROUP: '1' }, async () => {
      const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('com.google.Chrome.')).length;
      const { d, pid, prof } = await launch();
      try {
        const cg = fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8');
        assert.ok(!/app-com\.google\.Chrome/.test(cg), 'no app-com.google.Chrome scope: ' + cg.trim());
        assert.strictEqual(fs.readFileSync('/proc/self/cgroup', 'utf8'), cg, 'the same cgroup as the station');
        assert.strictEqual(Number(fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[2]), pid, 'Chrome leads its own process group');
        const inside = fs.existsSync(path.join(prof, '.tmp')) ? fs.readdirSync(path.join(prof, '.tmp')).filter(n => n.startsWith('com.google.Chrome.')) : [];
        assert.ok(inside.length >= 1, 'its com.google.Chrome.* temp entries are inside the profile');
        const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('com.google.Chrome.')).length;
        assert.ok(after <= before, 'no new com.google.Chrome.* entry in the shared temp dir (' + before + ' -> ' + after + ')');
      } finally { await d.close(); }
      const left = await waitFor(() => naming(prof).length === 0, 4000);
      assert.ok(left, 'close leaves 0 processes naming the profile (left: ' + naming(prof).join(',') + ')');
    });
  });
  await tcase('browser: STARNET_BROWSER_LOWMEM=1 — the flags are on the command line exactly once, one --disable-features', async () => {
    const args = ML.browserArgs(['--no-first-run', '--disable-features=CalculateNativeWinOcclusion', 'about:blank'], { STARNET_BROWSER_LOWMEM: '1' });
    for (const f of ML.LOWMEM_FLAGS) assert.strictEqual(args.filter(a => a === f).length, 1, f);
    assert.deepStrictEqual(args.filter(a => a.startsWith('--disable-features=')), ['--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints']);
    assert.strictEqual(args[args.length - 1], 'about:blank', 'the start page stays last');
    assert.ok(!args.some(a => a.startsWith('--renderer-process-limit')), 'the renderer limit is not part of the low-memory set');
    assert.deepStrictEqual(ML.browserArgs(['--a', 'about:blank'], {}), ['--a', 'about:blank'], 'unset: unchanged');
    if (!chrome) return { skip: 'flags checked; no Chrome for the live launch' };
    return withEnv({ STARNET_BROWSER_LOWMEM: '1', STARNET_BROWSER_OWN_GROUP: '1' }, async () => {
      const { d, pid } = await launch();
      try {
        const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
        for (const f of ML.LOWMEM_FLAGS) assert.strictEqual(cmd.filter(a => a === f).length, 1, 'live: ' + f);
      } finally { await d.close(); }
    });
  });
  await tcase('browser: with STARNET_BROWSER_OWN_GROUP unset the launch is today\'s (no group, no env change)', () => withEnv({}, async () => {
    assert.deepStrictEqual(ML.browserSpawnOptions({ profileDir: work, persistent: false, headed: false }), {});
    return withEnv({ STARNET_BROWSER_OWN_GROUP: '1' }, () => {
      const o = ML.browserSpawnOptions({ profileDir: path.join(work, 'p'), persistent: true, headed: false });
      assert.strictEqual(o.detached, true);
      assert.notStrictEqual(o.env.DBUS_SESSION_BUS_ADDRESS, 'disabled:', 'the durable profile keeps the session bus (its cookie key is in the keyring)');
      const deep = ML.browserSpawnOptions({ profileDir: '/x/' + 'd'.repeat(90), persistent: false, headed: false });
      assert.notStrictEqual(deep.env.TMPDIR, '/x/' + 'd'.repeat(90) + '/.tmp', 'a profile too deep for the socket keeps the inherited TMPDIR');
    });
  }));
  await tcase('idle: STARNET_BROWSER_IDLE_MIN=1 — a headless station browser closes after 1 minute (fake clock)', async () => {
    assert.strictEqual(ML.stationIdleMs({ STARNET_BROWSER_IDLE_MIN: '1' }), 60000);
    assert.strictEqual(ML.stationIdleMs({}), undefined, 'unset: browser-view.js keeps its own');
    const idx = fs.readFileSync(path.join(SN, 'sidecar', 'index.js'), 'utf8');
    assert.ok(/makeBrowserViews\(\{[\s\S]{0,200}stationIdleMs: require\('\.\/memory-lifecycle\.js'\)\.stationIdleMs\(\)/.test(idx), 'index.js passes it to the station browser');
    let t = 1000, seq = 0; const timers = new Map();
    const clk = { now: () => t, setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; }, clearTimeout: id => timers.delete(id),
      advance(ms) { t += ms; for (const [id, x] of Array.from(timers)) if (x.at <= t) { timers.delete(id); x.fn(); } } };
    let closed = 0, open = false;
    const session = { handoffSurface() { if (!open) throw new Error('no page'); return { visible: false, startStream: () => Promise.resolve(true), stopStream: () => Promise.resolve(true), pageInfo: () => Promise.resolve({ url: 'about:blank' }) }; },
      waitForProfile: async () => {}, tabs: async () => { open = true; return []; }, navigate: async u => { open = true; return u; }, close: async () => { closed++; open = false; } };
    const views = makeBrowserViews({ now: clk.now, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, stationIdleMs: ML.stationIdleMs({ STARNET_BROWSER_IDLE_MIN: '1' }), makeStationSession: () => session });
    await views.open('example.com');
    clk.advance(59 * 1000); await new Promise(r => setImmediate(r));
    assert.strictEqual(closed, 0, 'still open after 59 s');
    clk.advance(2 * 1000); await new Promise(r => setImmediate(r));
    assert.strictEqual(closed, 1, 'closed after a minute idle');
  });
  await tcase('private cap: STARNET_PRIVATE_BROWSERS_MAX=1 — a second per-run browser waits, and starts when the first closes', async () => {
    let t = 0, seq = 0; const timers = new Map();
    const fake = { setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; }, clearTimeout: id => timers.delete(id) };
    const s = ML.makeSlots(Object.assign({ max: 1, waitMs: 600000 }, fake));
    const r1 = await s.acquire();
    let got = null, err = null; s.acquire().then(r => { got = r; }, e => { err = e; });
    await delay(5); assert.strictEqual(got, null, 'the second waits'); assert.strictEqual(s.waiting(), 1);
    r1(); await delay(5); assert.ok(typeof got === 'function', 'it gets the slot when the first is released');
    let err2 = null; s.acquire().catch(e => { err2 = e; });
    t = 600001; for (const [id, x] of Array.from(timers)) if (x.at <= t) { timers.delete(id); x.fn(); } await delay(5);
    assert.ok(err2 && /No browser is free on this station right now \(1 in use\)\. Try again later or work without the browser\./.test(err2.message), 'after 10 minutes: the plain error');
    assert.strictEqual(err, null);
    assert.strictEqual(ML.privateBrowserSlots({}), null, 'unset: no limit');
    assert.strictEqual(ML.privateBrowserSlots({ STARNET_PRIVATE_BROWSERS_MAX: '2' }).max, 2);
    const idx = fs.readFileSync(path.join(SN, 'sidecar', 'index.js'), 'utf8');
    assert.ok(/launchSlot: \(\(\) => \{ const slots = require\('\.\/memory-lifecycle\.js'\)\.privateBrowserSlots\(\)/.test(idx), 'index.js gives per-run browsers the cap');
    if (!chrome) return { skip: 'semaphore checked; no Chrome for the live queue' };
    return withEnv({ STARNET_BROWSER_OWN_GROUP: '1' }, async () => {
      const slots = ML.makeSlots({ max: 1, waitMs: 30000 });
      const a = await launch(null, { launchSlot: () => slots.acquire() });
      const profB = life.tmpDir('c20b-');
      const b = B.makeCdpDriver({ chrome, profileDir: profB, cdpPort: 0, forceHeadless: true, headless: true, cleanupProfile: true, networkProxy: false, timeoutMs: 20000, launchSlot: () => slots.acquire() });
      let bUp = false; const bNav = b.navigate('about:blank').then(() => { bUp = true; });
      await delay(1500);
      assert.strictEqual(bUp, false, 'the second browser has not started while the first holds the only slot');
      assert.strictEqual(naming(profB).length, 0, 'no Chrome on the second profile yet');
      await a.d.close();
      await Promise.race([bNav, delay(20000)]);
      assert.ok(bUp, 'the second started once the first closed');
      await b.close();
      // a run closed while it waits starts nothing
      const hold = await slots.acquire();
      const profC = life.tmpDir('c20c-');
      const c = B.makeCdpDriver({ chrome, profileDir: profC, cdpPort: 0, forceHeadless: true, headless: true, cleanupProfile: true, networkProxy: false, timeoutMs: 20000, launchSlot: () => slots.acquire() });
      const cNav = c.navigate('about:blank').then(() => 'up', e => e.message);
      await delay(300); await c.close(); hold();
      const cr = await Promise.race([cNav, delay(5000).then(() => 'still waiting')]);
      assert.ok(/closed while it waited/.test(cr), 'closed while waiting: ' + cr);
      await delay(500);
      assert.strictEqual(naming(profC).length, 0, 'and no Chrome was started for it');
      assert.strictEqual(slots.inUse(), 0, 'every slot given back');
    });
  });
  await tcase('exit: a sidecar that calls process.exit(0) takes its browser\'s whole group with it', () => withEnv({ STARNET_BROWSER_OWN_GROUP: '1' }, async () => {
    const tag = 'cap0020-exit-' + process.pid;
    const script = path.join(work, 'fake-sidecar.js');
    fs.writeFileSync(script, "'use strict';\nconst cp = require('child_process');\nconst ML = require(" + JSON.stringify(path.join(SN, 'sidecar', 'memory-lifecycle.js')) + ");\n"
      + "const kid = cp.spawn(process.execPath, ['-e', \"require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '" + tag + "-helper'], { stdio: 'ignore' }); setInterval(()=>{},1000)\", '" + tag + "-browser'], { stdio: 'ignore', detached: true });\n"
      + "ML.trackBrowser(kid);\nsetTimeout(() => process.exit(0), 800);\n");
    const sc = life.track(cp.spawn(process.execPath, [script], { stdio: 'ignore', env: process.env }));
    const seen = await waitFor(() => naming(tag + '-helper').length && naming(tag + '-browser').length, 3000);
    assert.ok(seen, 'the fake browser and its helper ran');
    await new Promise(r => sc.once('exit', r));
    const gone = await waitFor(() => naming(tag).length === 0, 3000);
    for (const p of naming(tag)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} }
    assert.ok(gone, 'nothing of the browser group is left after the sidecar exited');
  }));

  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n0020: ' + results.filter(r => r[0] === 'PASS').length + ' passed, ' + fail + ' failed, ' + results.filter(r => r[0] === 'SKIP').length + ' skipped');
  life.cleanup();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); life.cleanup(); process.exit(1); });
