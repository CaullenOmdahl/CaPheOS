'use strict';
// framework-update.js outlast(): the restart-when-idle waiter runs as its own transient unit, so the owner job or the
// dispatcher that started the update cannot take it down when they stop (KillMode=mixed kills a detached child too).
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const FU = require('../framework-update.js');
const O = require('../lib/owned.js');

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-waiter-'));
  fs.mkdirSync(path.join(root, 'company'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ station: { serviceName: 'testco-station' } }));
  const bin = path.join(root, 'fake-systemd-run');
  fs.writeFileSync(bin, '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/args.txt"\nexit ${FAKE_RC:-0}\n', { mode: 0o755 });
  return { root, bin };
}

test('the waiter runs as <svc>-restart-when-idle-<stamp>-<hex>.service in the company slice', () => {
  const { root, bin } = fakeRoot();
  process.env.FRAMEWORK_UPDATE_SYSTEMD_RUN = bin;
  try {
    const r = FU.outlast(root, ['bash', path.join(root, 'scripts', 'restart-station.sh'), '--when-idle']);
    assert.ok(r && r.unit, 'a unit was started');
    assert.match(r.unit, /^testco-station-restart-when-idle-\d{14}-[0-9a-f]{4}\.service$/);
    const args = fs.readFileSync(path.join(root, 'args.txt'), 'utf8').split('\n');
    assert.ok(args.includes('--user') && args.includes('--collect'));
    assert.ok(args.includes('--unit=' + r.unit));
    assert.ok(args.some(a => a.startsWith('--slice=')));
    const dd = args.indexOf('--');
    assert.deepStrictEqual(args.slice(dd + 1, dd + 4), ['bash', path.join(root, 'scripts', 'restart-station.sh'), '--when-idle']);
    // the company counts the unit as its own (reaper, unregistered-services duty)
    assert.ok(O.ourUnit({ svc: 'testco-station', slug: 'testco', registered: new Set() }, r.unit));
  } finally { delete process.env.FRAMEWORK_UPDATE_SYSTEMD_RUN; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a failed systemd-run returns null so the caller falls back to a detached child', () => {
  const { root, bin } = fakeRoot();
  process.env.FRAMEWORK_UPDATE_SYSTEMD_RUN = bin; process.env.FAKE_RC = '1';
  try { assert.strictEqual(FU.outlast(root, ['true']), null); }
  finally { delete process.env.FRAMEWORK_UPDATE_SYSTEMD_RUN; delete process.env.FAKE_RC; fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stand-in restart command (no argv) never makes a unit', () => {
  assert.strictEqual(FU.outlast('/nonexistent', null), null);
});
