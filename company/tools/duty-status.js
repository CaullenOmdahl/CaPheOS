#!/usr/bin/env node
/* duty-status.js — what every duty check says now, for people and for the console (docs/DUTIES.md).
 *
 *   node company/tools/duty-status.js            one line per duty: state, who it routes to, when it last ran, why
 *   node company/tools/duty-status.js --json     [{id, route, owner, state ok|due|broken|stale|off|paused, checkedAt, reason,
 *                                                  history: [ok|due|broken ...], everyMin, source, ...}]
 *   node company/tools/duty-status.js --selftest
 * The state is computed here (lib/duty-runner.js view), never by the page that shows it: a duty is ok only if it ran
 * inside 2 x its cadence and said ok; never-run, too-old or skipped is stale. Absence never renders green. While a
 * restart hold is active (co.restartHold()) a stale duty that does not run while halted is `paused`, with the hold's words.
 * Reads company/state/duties.json, the registry (company/tools/duties.js, enabled modules) and the duty policy. Writes
 * nothing. Console source: sources.json tool "duties". Owner: the tools seat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function rows(v) {
  return v.duties.map(d => ({ id: d.id, route: d.route, owner: d.owner, state: d.state, checkedAt: d.checkedAt, reason: d.reason, everyMin: d.everyMin, enabled: d.enabled,
    source: d.source, whileHalted: d.whileHalted, dueSince: d.dueSince, brokenSince: d.brokenSince, waits: d.waits, items: d.items.length, history: d.history.map(h => h.result) }));
}

function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-status-selftest-'));
  try {
    const w = (rel, o) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
    w('company/company.json', { name: 'T', timezone: 'UTC' });
    w('company/tools/loops.json', { agents: { a: { name: 'Alex', functions: ['ceo', 'tools', 'risk'], manager: null } } });
    w('company/defaults/work/ops/duty-policy.json', { duties: {} });
    const now = Date.now(), ago = m => new Date(now - m * 60000).toISOString();
    w('company/state/duties.json', { duties: {
      'tool-parse': { lastRun: ago(5), lastResult: 'ok', history: [{ result: 'broken' }, { result: 'ok' }] },
      'handoff-status': { lastRun: ago(5), lastResult: 'due', reason: '1 OPEN handoff(s) past deadline', items: [{ id: 'to-a.md#abc123' }] },
      'connector-scope': { lastRun: ago(500), lastResult: 'ok' },
      'module-doctor': { lastRun: ago(5), lastResult: 'broken', error: 'exit 7' } } });
    const run = () => { const r = require('child_process').spawnSync(process.execPath, [__filename, '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) }); let j = []; try { j = JSON.parse(r.stdout); } catch (_) {} return { j, out: r.stdout + r.stderr }; };
    let { j, out } = run();
    const by = id => j.find(x => x.id === id) || {};
    ok('ran inside its cadence and said ok -> ok', by('tool-parse').state === 'ok' && by('tool-parse').history.join(',') === 'broken,ok', out);
    ok('due carries its reason and owner', by('handoff-status').state === 'due' && /past deadline/.test(by('handoff-status').reason) && by('handoff-status').owner === 'Alex');
    ok('last ok but older than 2 x its cadence -> stale, not ok', by('connector-scope').state === 'stale');
    ok('never run -> stale (absence never renders green)', by('backup-freshness').state === 'stale' && by('backup-freshness').reason === 'never run');
    ok('broken carries the error', by('module-doctor').state === 'broken' && by('module-doctor').reason === 'exit 7');
    w('company/defaults/work/ops/duty-policy.json', { duties: { 'module-doctor': { enabled: false } } });
    ({ j } = run());
    ok('a duty the policy switches off is off', by('module-doctor').state === 'off');
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log(bad ? 'DUTY-STATUS SELFTEST FAILED: ' + bad : 'DUTY-STATUS SELFTEST PASSED');
  return bad ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest')) process.exit(selftest());
  const v = require('./lib/duty-runner').view();
  const list = rows(v);
  if (a.includes('--json')) { console.log(JSON.stringify(list)); process.exit(0); }
  console.log('duties (policy: ' + v.policySource + (v.policyFlagged ? ', an unrecorded edit is flagged: the last-known-good copy is used' : '') + '; per-tick cap ' + v.tickCapMs + ' ms)');
  for (const d of list) console.log(d.state.toUpperCase().padEnd(7) + ' ' + d.id.padEnd(18) + ' -> ' + String(d.owner || d.route).padEnd(10) + ' ' + (d.checkedAt || 'never').padEnd(25) + ' ' + (d.reason || ''));
  process.exit(0);
}
module.exports = { rows };
