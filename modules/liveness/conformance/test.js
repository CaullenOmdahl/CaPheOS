#!/usr/bin/env node
// liveness conformance: the contract's files exist, tick.js runs while halted, watch.js and the tool prove themselves.
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const dir = process.env.MODULE_DIR || path.join(__dirname, '..');
const miss = [];
for (const f of ['README.md', 'tick.js', 'watch.js', 'tools/liveness.js', 'module.json']) if (!fs.existsSync(path.join(dir, f))) miss.push('MISSING ' + f);
try { if (require(path.join(dir, 'tick.js')).runWhenHalted !== true) miss.push('MISSING tick.js runWhenHalted: true'); } catch (e) { miss.push('MISSING loadable tick.js: ' + e.message); }
const root = path.join(dir, '..', '..');
for (const f of ['systemd/capheos-liveness.service.in', 'systemd/capheos-liveness.timer.in']) if (!fs.existsSync(path.join(root, f))) miss.push('MISSING ' + f);
if (!miss.length) {
  const r = spawnSync(process.execPath, [path.join(dir, 'watch.js'), '--selftest'], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) miss.push('MISSING a passing watch.js --selftest: ' + String(r.stdout).split('\n').filter(l => /^FAIL/.test(l)).join(' | '));
}
for (const m of miss) console.log(m);
process.exit(miss.length ? 1 : 0);
