'use strict';
// lib/owner.js isConsoleMain(): only this company's own console/server.js is the owner's console. A script that is
// merely named console/server.js somewhere else (a scratch copy, another checkout) is not.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const life = require('../lib/temp-life.js');
const { spawnSync } = require('child_process');
const OWNER = path.resolve(__dirname, '..', 'lib', 'owner.js');

test('a look-alike console/server.js elsewhere is not the console', () => {
  const dir = life.tmpDir('owner-console-');
  try {
    fs.mkdirSync(path.join(dir, 'console'));
    const fake = path.join(dir, 'console', 'server.js');
    fs.writeFileSync(fake, 'process.stdout.write(String(require(' + JSON.stringify(OWNER) + ').isConsoleMain()));\n');
    const r = spawnSync(process.execPath, [fake], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, 'false');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a tool run directly is not the console', () => {
  assert.strictEqual(require(OWNER).isConsoleMain(), false);
});
