#!/usr/bin/env node
/* company/patches/tests/0023.test.js — StarNet patch 0023 (block sharp VipsForeignLoadSvg in local-voice.js and image.js).
 *
 *   node company/patches/tests/0023.test.js [--starnet <dir>]
 *
 * Skips cleanly (exit 0) when no StarNet checkout is present (e.g. offline framework CI).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RECORD = path.join(REPO, 'company', 'patches', '0023-sharp-block-svg.diff');
const SC = require('./starnet-copy');
const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

const src = SC.findSource(arg('--starnet'));
if (!src) {
  console.log('SKIP 0023.test.js: no StarNet checkout (set CAPHEOS_STARNET_SRC or pass --starnet)');
  process.exit(0);
}

const { dir, applied } = SC.prepare(src, RECORD, 'capheos-0023-');
console.log('0023.test.js: ' + applied);

// 1. Verify patched source blocks VipsForeignLoadSvg in both local-voice.js and image.js
const lvSrc = fs.readFileSync(path.join(dir, 'sidecar', 'local-voice.js'), 'utf8');
assert.ok(lvSrc.includes("'VipsForeignLoadSvg'"), 'local-voice.js blocks VipsForeignLoadSvg');
const imgSrc = fs.readFileSync(path.join(dir, 'sidecar', 'tools', 'builtin', 'image.js'), 'utf8');
assert.ok(imgSrc.includes("'VipsForeignLoadSvg'") && imgSrc.includes('sharp.block('), 'image.js blocks VipsForeignLoadSvg before decode');

// 2. Live sharp check in a child process: SVG decode must fail once blocked, while PNG decode succeeds
const probe = cp.spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const sharp = require('sharp');
  sharp.block({ operation: ['VipsForeignLoadNsgif', 'VipsForeignLoadTiff', 'VipsForeignLoadVips', 'VipsForeignLoadSvg'] });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  (async () => {
    let blocked = false;
    try { await sharp(svg).png().toBuffer(); } catch (e) { blocked = true; }
    assert.strictEqual(blocked, true, 'SVG decode must be blocked by sharp.block');
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    const out = await sharp(png).resize(2, 2).png().toBuffer();
    assert.ok(out.length > 0, 'PNG decode still works');
    console.log('ok   sharp blocks SVG and decodes PNG');
  })().catch(e => { console.error(e); process.exit(1); });
`], { cwd: dir, encoding: 'utf8' });

if (probe.status !== 0) {
  console.error('FAIL 0023 sharp runtime probe:\n' + probe.stdout + probe.stderr);
  process.exit(1);
}
console.log(probe.stdout.trim());
console.log('PASS 0023.test.js');
