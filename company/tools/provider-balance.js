#!/usr/bin/env node
/* provider-balance.js — the low-balance duty for a prepaid provider (docs/DUTIES.md; lib/provider-balance.js).
 *
 *   node company/tools/provider-balance.js --duty      exit 1 with {due, reason, route, key} while DeepSeek's credit is
 *                                                      below its low line (about 3 days of use), so the finance seat makes
 *                                                      sure the owner has it in hand before calls fail (HTTP 402). No
 *                                                      amount is ever printed: agents never see amounts, the owner does
 *                                                      (Spend in the console). Read only, no network.
 *   node company/tools/provider-balance.js selftest
 * There is no command that prints a balance: the owner reads it in the console. Owner of this tool: the finance function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const PB = require('./lib/provider-balance');

function duty(o) {
  const s = PB.status('deepseek', o);
  if (!s.low) return 0;
  const now = (o && o.now) || Date.now();
  // Once an empty/unavailable account has been alerted for >24h with no change, don't keep waking finance every 30m
  if (s.available === false && s.alerted && s.since && (now - s.since) >= 24 * 3600e3) return 0;
  process.stdout.write(JSON.stringify({ due: true, route: 'finance', key: 'balance-' + String(s.key).replace(/[^a-z0-9:,-]/gi, '').slice(0, 80),
    reason: 'DeepSeek prepaid credit is below its low line (about ' + PB.DAYS + ' days of use) in ' + s.currencies.length + ' currenc' + (s.currencies.length === 1 ? 'y' : 'ies') + '; topping it up is the owner\'s (they have the amount on Spend): make sure it is in hand, or move DeepSeek seats to their next model before calls fail' }) + '\n');
  return 1;
}
function selftest() {
  const os = require('os');
  const T = require('./lib/temp-life').tmpDir('provider-balance-selftest-');
  let fails = 0; const ok = (n, c, x) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 300))); };
  try {
    const told = []; const o = { root: T, perDayUsd: 1, notify: t => told.push(t) };
    let r = PB.record('deepseek', { at: 1, available: true, balances: [{ currency: 'USD', total_balance: '9.50', granted_balance: '0', topped_up_balance: '9.50' }, { currency: 'CNY', total_balance: '100' }] }, o);
    ok('above the line: no alert', !r.low && !told.length);
    const f = PB.file({ root: T });
    ok('the amounts are kept in owner state, mode 600, each currency apart', (fs.statSync(f).mode & 0o777) === 0o600 && JSON.parse(fs.readFileSync(f, 'utf8')).deepseek.balances.map(b => b.currency + ' ' + b.total).join() === 'USD 9.5,CNY 100');
    r = PB.record('deepseek', { at: 2, available: true, balances: [{ currency: 'USD', total_balance: '2.40' }, { currency: 'CNY', total_balance: '100' }] }, o);
    ok('below 3 days of use ($3 at $1 a day): the owner is told once, with no amount', r.low && r.alerted && told.length === 1 && !/\d+\.\d|\$\d|2\.4/.test(told[0]), told);
    r = PB.record('deepseek', { at: 3, available: true, balances: [{ currency: 'USD', total_balance: '1.90' }, { currency: 'CNY', total_balance: '100' }] }, o);
    ok('still low: not told again', r.low && !r.alerted && told.length === 1);
    PB.record('deepseek', { at: 4, available: true, balances: [{ currency: 'USD', total_balance: '20' }] }, o);
    PB.record('deepseek', { at: 5, available: true, balances: [{ currency: 'USD', total_balance: '1' }] }, o);
    ok('after a top-up, the next drop alerts again', told.length === 2);
    ok('the floor holds when there is no use: $2 (USD), ¥15 (CNY), never summed or converted', PB.lowLine('USD', 0) === 2 && PB.lowLine('CNY', 50) === 15 && PB.lowLine('usd', 5) === 15);
    process.env.CAPHEOS_ROOT = T;
    const { spawnSync } = require('child_process');
    const d = spawnSync(process.execPath, [__filename, '--duty'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T }) });
    ok('the duty is due while low, routes to finance and prints no amount', d.status === 1 && JSON.parse(d.stdout).route === 'finance' && !/\d+\.\d|\$/.test(JSON.parse(d.stdout).reason), d.stdout + d.stderr);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + 'provider-balance selftest'); return fails ? 1 : 0;
}
const a = process.argv.slice(2);
if (require.main === module) {
  if (a[0] === '--duty') process.exit(duty());
  if (a[0] === 'selftest' || a[0] === '--selftest') process.exit(selftest());
  console.error('usage: provider-balance.js --duty | selftest   (the amount is the owner\'s: Spend in the console)'); process.exit(2);
}
module.exports = { duty };
