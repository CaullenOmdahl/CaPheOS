'use strict';
// temp-life.test.js — a test's temp dirs and helper processes are gone when it ends, however it ends (lib/temp-life.js):
// a normal exit, an uncaught error, SIGTERM (what scripts/test.sh's `timeout` sends) and SIGINT. A helper that ignores
// SIGTERM is killed after the grace; a grandchild that names the dir on its command line (a Chrome renderer) goes too.
//   node --test company/tools/tests/temp-life.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const test = require('node:test');
const assert = require('assert');

const LIB = path.join(__dirname, '..', 'lib', 'temp-life.js');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a child that registers a dir and two helpers (one ignores SIGTERM; one only names the dir), prints them, then `how`
function run(how) {
  const code = `
    const life = require(${JSON.stringify(LIB)}); const { spawn } = require('child_process'); const fs = require('fs');
    life.setGrace(400);
    const d = life.tmpDir('temp-life-selftest-'); fs.writeFileSync(d + '/f', 'x');
    const a = life.track(spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
    const b = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + d], { stdio: 'ignore', detached: true }); b.unref();
    setTimeout(() => {
      console.log(JSON.stringify({ d, a: a.pid, b: b.pid }));
      const how = ${JSON.stringify(how)};
      if (how === 'exit') process.exit(0);
      if (how === 'throw') throw new Error('boom');
    }, 300);
    setInterval(() => {}, 1000);`;
  return cp.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
}
async function scenario(how, signal) {
  const c = run(how);
  let out = ''; c.stdout.on('data', x => { out += x; });
  const t0 = Date.now();
  while (!/\}\s*$/.test(out) && Date.now() - t0 < 10000) await sleep(50);
  const info = JSON.parse(out.trim().split('\n')[0]);
  assert.ok(fs.existsSync(info.d), 'the dir exists while it runs');
  if (signal) c.kill(signal);
  const code = await new Promise(r => c.on('exit', (cd, sg) => r(cd === null ? sg : cd)));
  await sleep(150);
  return Object.assign(info, { code });
}
function settle(info) {
  for (const p of [info.a, info.b]) { if (alive(p)) { try { process.kill(p, 'SIGKILL'); } catch (_) {} } }
  try { fs.rmSync(info.d, { recursive: true, force: true }); } catch (_) {}
}

for (const [how, signal, want] of [['exit', null, 0], ['throw', null, 1], ['wait', 'SIGTERM', 143], ['wait', 'SIGINT', 130]]) {
  test('ends by ' + (signal || how) + ': dir removed, helpers ended', async () => {
    const info = await scenario(how, signal);
    try {
      assert.strictEqual(info.code, want);
      assert.ok(!fs.existsSync(info.d), 'dir removed');
      assert.ok(!alive(info.a), 'a helper that ignores SIGTERM is killed after the grace');
      if (process.platform === 'linux') assert.ok(!alive(info.b), 'a process naming the dir is killed');
    } finally { settle(info); }
  });
}

test('chrome(): a fresh registered profile, --user-data-dir added, TMPDIR inside it', () => {
  const life = require(LIB);
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'temp-life-selftest-')), 'fake-chrome.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "$TMPDIR|$*"\n'); fs.chmodSync(fake, 0o755);
  const { proc, dir } = life.chrome(fake, ['--headless=new'], { prefix: 'temp-life-chrome-', spawnOpts: { stdio: ['ignore', 'pipe', 'ignore'] } });
  assert.ok(life.registered().dirs.includes(dir));
  return new Promise((resolve, reject) => {
    let out = ''; proc.stdout.on('data', x => { out += x; });
    proc.on('close', () => {
      try { assert.strictEqual(out.trim(), dir + '|--headless=new --user-data-dir=' + dir); life.cleanup(); assert.ok(!fs.existsSync(dir)); resolve(); } catch (e) { reject(e); }
      finally { fs.rmSync(path.dirname(fake), { recursive: true, force: true }); }
    });
  });
});
