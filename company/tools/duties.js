#!/usr/bin/env node
/* duties.js — the company tools' duties: which read-only checks the dispatcher runs to find work (docs/DUTIES.md).
 *
 * This file is CODE, not data, on purpose: what the dispatcher runs on every tick is reviewed like any tool (a change
 * goes through harness-change.js, and locked-watch.js watches this file). The only data is the policy of overrides
 * (company/work/ops/duty-policy.json: enabled and everyMin per duty, clamped to the bounds below), and modules declare
 * their own duties in modules/<id>/module.json "duties".
 *
 * Each entry: { id, tool, route, everyMin, timeoutMs, whileHalted, enabledByDefault }
 *   tool      a file in company/tools/ that implements `--duty` (invoked exactly `node company/tools/<tool> --duty`)
 *   route     a function (ceo, people, tools, risk, floor, finance) or a seat id; a result's own route/items[].route wins
 *   everyMin  how often it runs (the policy may move it inside EVERY_MIN_BOUNDS)
 *
 *   node company/tools/duties.js list [--json]     the company tools' duties (the dispatcher adds the enabled modules')
 *   node company/tools/duties.js --selftest        the registry is well formed and every tool has a --duty mode
 * Owner: the tools seat.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DUTIES = [
  { id: 'handoff-status', tool: 'handoff-status.js', route: 'ceo', everyMin: 30, timeoutMs: 15000, whileHalted: false, enabledByDefault: true,
    why: 'OPEN handoffs past their deadline, and handoff sections with no Status line (to the inbox owner\'s manager, else the CEO)' },
  { id: 'tool-parse', tool: 'tool-parse.js', route: 'tools', everyMin: 60, timeoutMs: 30000, whileHalted: false, enabledByDefault: true,
    why: 'a tool in company/tools/ that does not parse' },
  { id: 'connector-scope', tool: 'connector-scope.js', route: 'risk', everyMin: 30, timeoutMs: 10000, whileHalted: false, enabledByDefault: true,
    why: 'a connector out of the recorded scope (saved policy header, or a drift locked-watch has flagged)' },
  { id: 'backup-freshness', tool: 'backup-freshness.js', route: 'risk', everyMin: 60, timeoutMs: 10000, whileHalted: false, enabledByDefault: true,
    why: 'no state snapshot in the last 26 hours' },
  { id: 'module-doctor', tool: 'module.js', route: 'tools', everyMin: 360, timeoutMs: 30000, whileHalted: false, enabledByDefault: true,
    why: 'an enabled core module that no longer passes its static checks' },
  { id: 'unregistered-services', tool: 'service.js', route: 'risk', everyMin: 30, timeoutMs: 10000, whileHalted: false, enabledByDefault: true,
    why: 'a systemd user unit running from this company folder that service.js did not register, a registered unit not company-scoped by name, one edited by hand, or a registered service whose runs fail (3 in an hour, or any for a halt-related one; to the seat that asked for it)' },
  { id: 'budget-drift', tool: 'budget.js', route: 'finance', everyMin: 30, timeoutMs: 15000, whileHalted: false, enabledByDefault: true,
    why: 'the station\'s spending caps differ from the company settings (budget.js apply), or, with the dispatcher owning the schedule, a crew loop is armed on the station, the watchdog routine is missing or the station\'s own schedule started a run (docs/BUDGET.md)' },
];

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const EVERY_MIN_BOUNDS = [5, 1440];
const TIMEOUT_BOUNDS = [1000, 60000];

// one entry's problems ([] = well formed). `where` names the file for the message.
function check(d, where) {
  const out = []; const w = (where || 'duty') + ' ' + (d && d.id || '?') + ': ';
  if (!d || typeof d !== 'object') return [w + 'not an object'];
  if (!ID_RE.test(String(d.id || ''))) out.push(w + 'id must match ' + ID_RE);
  if (typeof d.tool !== 'string' || !/^[A-Za-z0-9_./-]+\.js$/.test(d.tool) || d.tool.split('/').includes('..') || d.tool.startsWith('/')) out.push(w + 'tool must be a relative .js path inside its folder');
  if (typeof d.route !== 'string' || !(FUNCTIONS.includes(d.route) || /^[A-Za-z0-9_-]{2,64}$/.test(d.route))) out.push(w + 'route must be a function or a seat id');
  if (!(Number.isFinite(d.everyMin) && d.everyMin >= EVERY_MIN_BOUNDS[0] && d.everyMin <= EVERY_MIN_BOUNDS[1])) out.push(w + 'everyMin must be ' + EVERY_MIN_BOUNDS.join('-'));
  if (!(Number.isFinite(d.timeoutMs) && d.timeoutMs >= TIMEOUT_BOUNDS[0] && d.timeoutMs <= TIMEOUT_BOUNDS[1])) out.push(w + 'timeoutMs must be ' + TIMEOUT_BOUNDS.join('-'));
  if (typeof d.whileHalted !== 'boolean') out.push(w + 'whileHalted must be true or false');
  if (typeof d.enabledByDefault !== 'boolean') out.push(w + 'enabledByDefault must be true or false');
  return out;
}

function selftest() {
  let bad = 0; const ok = (name, cond, detail) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  [' + (detail || '') + ']')); if (!cond) bad++; };
  const problems = [].concat(...DUTIES.map(d => check(d, 'duties.js')));
  ok('every entry is well formed', !problems.length, problems.join('; '));
  ok('ids are unique', new Set(DUTIES.map(d => d.id)).size === DUTIES.length);
  for (const d of DUTIES) {
    const f = path.join(__dirname, d.tool);
    const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    ok(d.id + ': ' + d.tool + ' exists and has a --duty mode', /--duty\b/.test(src));
  }
  ok('no company duty runs while halted (only liveness does, from its module)', DUTIES.every(d => d.whileHalted === false));
  ok('a malformed entry is refused', check({ id: 'X', tool: '../x.js', route: '', everyMin: 1, timeoutMs: 0 }).length >= 5);
  console.log(bad ? 'DUTIES SELFTEST FAILED: ' + bad : 'DUTIES SELFTEST PASSED');
  return bad ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest') || a[0] === 'selftest') process.exit(selftest());
  if (!a.length || a[0] === 'list') {
    if (a.includes('--json')) console.log(JSON.stringify(DUTIES, null, 1));
    else for (const d of DUTIES) console.log(d.id.padEnd(18) + ' every ' + String(d.everyMin).padStart(4) + ' min  -> ' + d.route.padEnd(7) + ' ' + d.tool + '  ' + d.why);
    process.exit(0);
  }
  console.error('usage: duties.js list [--json] | --selftest'); process.exit(2);
}
module.exports = { DUTIES, check, FUNCTIONS, EVERY_MIN_BOUNDS, TIMEOUT_BOUNDS, ID_RE };
