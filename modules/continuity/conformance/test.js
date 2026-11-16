#!/usr/bin/env node
// continuity conformance: files present, the tool's selftest (which drives halt.js) passes.
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const dir = process.env.MODULE_DIR || path.join(__dirname, '..');
const miss = [];
for (const f of ['README.md', 'lib.js', 'http.js', 'tools/continuity.js']) if (!fs.existsSync(path.join(dir, f))) miss.push('MISSING ' + f);
if (!/continuity/.test(fs.readFileSync(path.join(dir, '..', '..', 'company', 'tools', 'halt.js'), 'utf8'))) miss.push('MISSING halt.js continuity integration');
if (!miss.length) { const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'continuity.js'), '--selftest'], { encoding: 'utf8', timeout: 90000 }); if (r.status !== 0) miss.push('MISSING a passing continuity.js --selftest: ' + String(r.stdout).split('\n').filter(l => /^FAIL/.test(l)).join(' | ')); }
for (const m of miss) console.log(m);
process.exit(miss.length ? 1 : 0);
