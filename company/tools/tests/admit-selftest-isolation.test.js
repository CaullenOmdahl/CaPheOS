'use strict';
/* A tool run as `<tool>.js selftest` / `--selftest` inside a live company never writes test admissions into that company's
 * real admit log (2026-11-19: ~3,300 rows from external-gate's and halt's selftests in both live companies). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');

test('selftest mode writes no admit row to the company log; a normal run does', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'admit-iso-'));
  try {
    const script = path.join(T, 'tool.js');
    fs.writeFileSync(script, `require(${JSON.stringify(path.join(REPO, 'company', 'tools', 'lib', 'admit.js'))}).admit({ door: 'act', kind: 'act', seat: 'sam' });`);
    const log = path.join(T, 'company', 'state', 'admit-log.jsonl');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'company.json'), JSON.stringify({ name: 'Iso', owner: { name: 'Pat' }, timezone: 'UTC' }));
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, ADMIT_LOG: '' });
    delete env.ADMIT_LOG;
    let r = spawnSync(process.execPath, [script, '--selftest'], { cwd: T, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim() === '', 'selftest wrote nothing');
    r = spawnSync(process.execPath, [script, 'selftest'], { cwd: T, env, encoding: 'utf8' });
    assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8').trim() === '', 'plain selftest wrote nothing');
    r = spawnSync(process.execPath, [script], { cwd: T, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(log, 'utf8'), /"seat":"sam"/, 'a normal run is logged');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
});
