#!/usr/bin/env node
/* liveness.js — the dead-man's switch, from a shell: both heartbeats, a test ping, one watcher check.
 *
 *   node company/tools/liveness.js status [--json]     heartbeat.json + liveness-watch.json and their ages
 *   node company/tools/liveness.js ping                a test alert to the owner (and the push URL, through the gate)
 *   node company/tools/liveness.js check               what the systemd timer runs (modules/liveness/watch.js)
 *   node company/tools/liveness.js --selftest          runs modules/liveness/watch.js --selftest
 * Module: liveness (modules/liveness/). Owner: risk.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require(fs.existsSync(path.join(__dirname, 'lib', 'company.js')) ? './lib/company' : '../../../company/tools/lib/company');
const W = co.p('modules', 'liveness', 'watch.js');
const a = process.argv.slice(2);
if (a.includes('--selftest')) {
  const r = require('child_process').spawnSync(process.execPath, [W, '--selftest'], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
const w = require(W);
(async () => {
  const cmd = a[0] || 'status';
  const r = cmd === 'status' ? w.status() : cmd === 'ping' ? await w.ping() : cmd === 'check' ? await w.check() : null;
  if (!r) { console.error('usage: liveness.js status|ping|check|--selftest'); process.exit(2); }
  if (cmd === 'status' && !a.includes('--json')) {
    console.log('liveness ' + (r.enabled ? 'enabled' : 'NOT enabled') + ' · dispatcher heartbeat ' + (r.heartbeatAgeMin === null ? 'never' : r.heartbeatAgeMin + ' min ago') + (r.dispatcherStale ? ' (STALE)' : '')
      + ' · watcher ' + (r.watcherAgeMin === null ? 'never' : r.watcherAgeMin + ' min ago') + ' · pinged ' + (r.pingedAt || 'never'));
  } else console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });
