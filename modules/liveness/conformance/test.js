#!/usr/bin/env node
// liveness conformance: the contract's files exist, tick.js runs while halted, watch.js and the tool prove themselves.
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const dir = process.env.MODULE_DIR || path.join(__dirname, '..');
const miss = [];
for (const f of ['README.md', 'tick.js', 'watch.js', 'alarm-test.js', 'http.js', 'tools/liveness.js', 'module.json']) if (!fs.existsSync(path.join(dir, f))) miss.push('MISSING ' + f);
try { if (require(path.join(dir, 'tick.js')).runWhenHalted !== true) miss.push('MISSING tick.js runWhenHalted: true'); } catch (e) { miss.push('MISSING loadable tick.js: ' + e.message); }
const root = path.join(dir, '..', '..');
for (const f of ['systemd/capheos-liveness.service.in', 'systemd/capheos-liveness.timer.in', 'systemd/capheos-liveness-heartbeat.service.in', 'systemd/capheos-liveness-heartbeat.timer.in']) if (!fs.existsSync(path.join(root, f))) miss.push('MISSING ' + f);
// the outside ping and the dispatcher-silence check are separate units: an alarm test pauses only the ping
try {
  const svc = f => fs.readFileSync(path.join(root, 'systemd', f), 'utf8');
  if (!/watch\.js heartbeat\b/.test(svc('capheos-liveness-heartbeat.service.in'))) miss.push('MISSING the heartbeat unit running watch.js heartbeat');
  if (/watch\.js heartbeat\b/.test(svc('capheos-liveness.service.in'))) miss.push('MISSING separate units: the watcher unit runs the heartbeat');
} catch (_) {}
if (!miss.length) {
  const r = spawnSync(process.execPath, [path.join(dir, 'watch.js'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) miss.push('MISSING a passing watch.js --selftest: ' + String(r.stdout).split('\n').filter(l => /^FAIL/.test(l)).join(' | '));
  const r2 = spawnSync(process.execPath, [path.join(dir, 'alarm-test.js'), '--selftest'], { encoding: 'utf8', timeout: 90000 });
  if (r2.status !== 0) miss.push('MISSING a passing alarm-test.js --selftest: ' + String(r2.stdout).split('\n').filter(l => /^FAIL/.test(l)).join(' | '));
}
for (const m of miss) console.log(m);
process.exit(miss.length ? 1 : 0);
