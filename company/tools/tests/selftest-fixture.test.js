'use strict';
// provenance.fixtureRoot: only a throwaway company under the OS temp dir, marked .capheos-selftest-fixture, answers owner
// checks as the owner (so a selftest that runs tools as child processes passes inside an agent's run). Anything else does not.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const PROV = path.join(__dirname, '..', 'provenance.js');
const STATION = { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' };
const ask = env => JSON.parse(spawnSync(process.execPath, ['-e', 'const p=require(' + JSON.stringify(PROV) + ');console.log(JSON.stringify({o:p.ownerShell(),u:p.underStation()}))'], { env: Object.assign({}, process.env, STATION, env), encoding: 'utf8' }).stdout);
test('a marked temp company is a fixture: owner, not under the station', () => {
  const T = require('../lib/temp-life').tmpDir('fx-'); fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: true, u: false });
});
test('an unmarked temp company under the station is not the owner', () => {
  const T = require('../lib/temp-life').tmpDir('fx-');
  assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: false, u: true });
});
test('a marker outside the temp dir grants nothing', () => {
  const T = require('../lib/temp-life').tmpDir('.capheos-fx-', { base: os.homedir() }); fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  try { assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: false, u: true }); } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
// Phil's Q4 condition (2026-11-19): a suite that pins CAPHEOS_ROOT to a fixture and restores it must leave no fixture behind -
// a later check in the same process (the next suite, or the real tool) is judged on the real caller again, not on the cached pin.
const inProc = body => JSON.parse(spawnSync(process.execPath, ['-e', 'const fs=require("fs"),os=require("os"),path=require("path");const p=require(' + JSON.stringify(PROV) + ');' + body], { env: Object.assign({}, process.env, STATION, { CAPHEOS_ROOT: '' }), encoding: 'utf8' }).stdout.trim());
const SUITE = 'const T=fs.mkdtempSync(path.join(os.tmpdir(),"fx-"));fs.writeFileSync(path.join(T,".capheos-selftest-fixture"),"");const prev=process.env.CAPHEOS_ROOT;process.env.CAPHEOS_ROOT=T;const during=p.ownerShell();const duringU=p.underStation();if(prev===undefined)delete process.env.CAPHEOS_ROOT;else process.env.CAPHEOS_ROOT=prev;';
test('after a suite restores CAPHEOS_ROOT, a later owner check in the same process is not a fixture', () => {
  const r = inProc(SUITE + 'console.log(JSON.stringify({during,duringU,after:p.ownerShell()}))');
  assert.deepStrictEqual({ d: r.during, du: r.duringU, after: r.after }, { d: true, du: false, after: false });
});
// KNOWN DEFECT (measured 2026-11-19): underStation() caches STATION=false while the fixture pin is live and never recomputes after the
// restore, so the real caller reads as not under the station. provenance.js is a locked tool (tier 3): the fix is Phil's/the owner's, not this branch's.
test('after a suite restores CAPHEOS_ROOT, underStation() is judged on the real caller again', { todo: 'provenance.js caches STATION across the restore; reported to Phil' }, () => {
  const r = inProc(SUITE + 'console.log(JSON.stringify({duringU,under:p.underStation()}))');
  assert.deepStrictEqual({ duringU: r.duringU, under: r.under }, { duringU: false, under: true });
});
