#!/usr/bin/env node
/* liveness.js — the dead-man's switch, from a shell: both heartbeats, a test ping, one watcher check.
 *
 *   node company/tools/liveness.js status [--json]     heartbeat.json + liveness-watch.json and their ages
 *   node company/tools/liveness.js ping                a test alert to the owner (and the push URL, through the gate)
 *   node company/tools/liveness.js check               what the systemd timer runs (modules/liveness/watch.js)
 *   node company/tools/liveness.js --selftest          runs modules/liveness/watch.js --selftest
 *   node company/tools/liveness.js --duty              read-only duty check (docs/DUTIES.md), run even while halted: exit 1 +
 *                                                      JSON when the watcher's own heartbeat is missing or older than 3 of its
 *                                                      intervals (the dead-man's switch is blind)
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
if (a.includes('--duty')) {
  const s = w.status();
  const limitMin = 3 * (Number(s.watchMin) || 5);
  const blind = s.enabled && (s.watcherAgeMin === null || s.watcherAgeMin > limitMin);
  if (blind) console.log(JSON.stringify({ due: true, reason: s.watcherAgeMin === null ? 'the liveness watcher has never written its heartbeat: its systemd timer is not running, so a stopped dispatcher would go unnoticed' : 'the liveness watcher last wrote its heartbeat ' + s.watcherAgeMin + ' min ago (limit ' + limitMin + ' min): its timer has stopped, so a stopped dispatcher would go unnoticed', key: 'lv-' + (s.watcherAgeMin === null ? 'never' : String((s.watcher && s.watcher.at) || 'old').replace(/[^A-Za-z0-9:.-]/g, '').slice(0, 30)) }));
  process.exit(blind ? 1 : 0);
}
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
