'use strict';
// provenance.fixtureRoot: only a throwaway company under the OS temp dir, marked .capheos-selftest-fixture, answers owner
// checks as the owner (so a selftest that runs tools as child processes passes inside an agent's run). Anything else does not.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const PROV = path.join(__dirname, '..', 'provenance.js');
const STATION = { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' };
const ask = env => JSON.parse(spawnSync(process.execPath, ['-e', 'const p=require(' + JSON.stringify(PROV) + ');console.log(JSON.stringify({o:p.ownerShell(),u:p.underStation()}))'], { env: Object.assign({}, process.env, STATION, env), encoding: 'utf8' }).stdout);
test('a marked temp company is a fixture: owner, not under the station', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')); fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: true, u: false });
});
test('an unmarked temp company under the station is not the owner', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: false, u: true });
});
test('a marker outside the temp dir grants nothing', () => {
  const T = fs.mkdtempSync(path.join(os.homedir(), '.capheos-fx-')); fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  try { assert.deepStrictEqual(ask({ CAPHEOS_ROOT: T }), { o: false, u: true }); } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
