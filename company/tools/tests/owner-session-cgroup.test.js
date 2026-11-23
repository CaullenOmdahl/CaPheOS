'use strict';
// provenance.js sessionCgroup(): the owner's own login, read from the kernel cgroup, so a terminal program missing from
// the INTERACTIVE list still counts. Nothing the company runs (station, dispatcher, services, owner jobs) and no
// detached run-* unit an agent could start counts.
const test = require('node:test');
const assert = require('assert');
const P = require('../provenance.js');
const U = '0::/user.slice/user-1000.slice';

test('login sessions and desktop terminals are the owner', () => {
  for (const c of [U + '/session-19.scope', U + '/user@1000.service/app.slice/app-gnome-org.gnome.Ptyxis-1234.scope',
    U + '/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-1a2b.scope', U + '/user@1000.service/app.slice/app-kitty-9.scope'])
    assert.strictEqual(P.sessionCgroup(c), true, c);
});

test('company units, detached runs, browsers and system services are not', () => {
  for (const c of [U + '/user@1000.service/capheos.slice/capheos-co.slice/co-station-dispatch.service',
    U + '/user@1000.service/app.slice/co-station.service', U + '/user@1000.service/app.slice/co-svc-rec.service',
    U + '/user@1000.service/app.slice/run-u123.service', U + '/user@1000.service/app.slice/run-r1.scope',
    U + '/user@1000.service/app.slice/app-com.google.Chrome-1.scope', U + '/user@1000.service/app.slice/app-co-station-owner-job-x.scope',
    '0::/system.slice/sshd.service', '', null])
    assert.strictEqual(P.sessionCgroup(c), false, String(c));
});

test('classify: a session cgroup makes the owner unless the run is under the station', () => {
  assert.strictEqual(P.classify({ chain: [['bash']], env: {}, cgroup: U + '/session-3.scope' }).ownerShell, true);
  const stationEnv = { STARNET_USER_CONTROL_MODE: 'preserve', STARNET_COMPUTER_DRIVER: '0', STARNET_MCP_STDIO: '0', BROWSER: 'none' };
  assert.strictEqual(P.classify({ chain: [['bash']], env: stationEnv, cgroup: U + '/session-3.scope' }).ownerShell, false, 'a station run\'s shell is never the owner');
  assert.strictEqual(P.classify({ chain: [['node', '/x/sidecar/index.js'], ['bash']], env: {}, cgroup: U + '/session-3.scope' }).ownerShell, false, 'under the station is never the owner');
  assert.strictEqual(P.classify({ chain: [['bash']], env: {}, cgroup: U + '/user@1000.service/app.slice/run-u9.service' }).ownerShell, false);
});
