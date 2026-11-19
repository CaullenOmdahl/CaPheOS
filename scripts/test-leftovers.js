#!/usr/bin/env node
/* test-leftovers.js — the processes a scripts/test.sh run left behind.
 *
 *   node scripts/test-leftovers.js <run-id> [--kill] [--json]
 *
 * A process is the run's when its environment carries CAPHEOS_TEST_RUN=<run-id> (test.sh exports it; every step, walk,
 * mock station and browser inherits it) or its command line names the run's work dir (the same id). This process and
 * its ancestors (test.sh itself) are never counted. Only this user's processes are readable, so nobody else's are
 * looked at. Prints one line per process, exits 1 when any were found; --kill ends them (SIGTERM, then SIGKILL) after
 * listing them. Linux only (/proc); elsewhere it reports nothing.
 */
'use strict';
const fs = require('fs');

function ancestors() {
  const out = new Set([process.pid]);
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    let ppid = 0;
    try { ppid = Number(fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[1]); } catch (_) { break; }
    if (!ppid) break; out.add(ppid); pid = ppid;
  }
  return out;
}
function leftovers(id) {
  if (process.platform !== 'linux' || !id) return [];
  const skip = ancestors(), mark = 'CAPHEOS_TEST_RUN=' + id, out = [];
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e) || skip.has(Number(e))) continue;
    let env = '', cmd = '';
    try { env = fs.readFileSync('/proc/' + e + '/environ', 'utf8'); } catch (_) {}
    try { cmd = fs.readFileSync('/proc/' + e + '/cmdline', 'utf8'); } catch (_) { continue; }
    if (!cmd) continue;   // a zombie or a kernel thread
    if (env.split('\0').includes(mark) || cmd.includes(id)) out.push({ pid: Number(e), cmd: cmd.split('\0').join(' ').trim().slice(0, 200) });
  }
  return out;
}
if (require.main === module) {
  const id = process.argv[2];
  if (!id || id.startsWith('--')) { console.error('usage: test-leftovers.js <run-id> [--kill] [--json]'); process.exit(2); }
  const found = leftovers(id);
  if (process.argv.includes('--json')) console.log(JSON.stringify(found));
  else for (const p of found) console.log('left behind: pid ' + p.pid + '  ' + p.cmd);
  if (found.length && process.argv.includes('--kill')) {
    for (const p of found) { try { process.kill(p.pid, 'SIGTERM'); } catch (_) {} }
    const until = Date.now() + 1500;
    while (Date.now() < until && found.some(p => { try { process.kill(p.pid, 0); return true; } catch (_) { return false; } })) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    for (const p of found) { try { process.kill(p.pid, 'SIGKILL'); } catch (_) {} }
  }
  process.exit(found.length ? 1 : 0);
}
module.exports = { leftovers };
