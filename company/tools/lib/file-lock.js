'use strict';
/* lib/file-lock.js — one exclusive, synchronous lock per file, for a read-modify-write of a small JSON file shared by
 * several processes (a CLI tool, the console, a seat's run).
 *
 *   withFileLock(file, fn, { staleMs, retries, waitMs, what }) -> fn(lock)'s value
 *       takes <file>.lock (created with O_EXCL: fs.openSync(.., 'wx')), runs fn, removes the lock (only if it is still
 *       this caller's). A lock older than staleMs (default 30 s: its holder crashed) is broken once and retried. After
 *       `retries` waits of about waitMs (default 200 x 25 ms, about 5-8 s) it throws a LockBusy error (code 'ELOCKBUSY')
 *       and fn never runs, so the caller records nothing.
 *       lock.check() throws LockBusy if the lock is no longer this caller's (it went stale and another writer broke it):
 *       call it right before the write that must not race.
 *
 * The other locks in tools/ (sprint.js makePathLock: mkdir; deps.js, dispatcher-loop.js: their own 'wx' files) are tied
 * to their own state; this is the shared helper for new callers.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LockBusy extends Error { constructor(msg) { super(msg); this.code = 'ELOCKBUSY'; } }
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const sleep = ms => { try { Atomics.wait(SLEEPER, 0, 0, Math.max(1, ms)); } catch (_) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } } };
const readIf = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

function withFileLock(file, fn, o) {
  o = o || {};
  const staleMs = Number(o.staleMs) > 0 ? Number(o.staleMs) : 30000;
  const retries = Number.isInteger(o.retries) && o.retries >= 0 ? o.retries : 200;
  const waitMs = Number(o.waitMs) > 0 ? Number(o.waitMs) : 25;
  const what = o.what || path.basename(file);
  const lockFile = file + '.lock';
  const token = process.pid + '-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0, broke = 0; ; ) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }) + '\n'); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let st = null; try { st = fs.statSync(lockFile); } catch (_) { continue; }   // released meanwhile: try again at once
    if (Date.now() - st.mtimeMs > staleMs && broke < 3) {
      // break a stale lock: rename it aside (only one breaker wins the rename), and put it back if what we moved
      // turns out to be a fresh lock someone else took between our stat and our rename
      broke++;
      const aside = lockFile + '.stale-' + token;
      try {
        fs.renameSync(lockFile, aside);
        const moved = fs.statSync(aside);
        if (Date.now() - moved.mtimeMs > staleMs) fs.rmSync(aside, { force: true });
        else { try { fs.linkSync(aside, lockFile); } catch (_) {} fs.rmSync(aside, { force: true }); }
      } catch (_) {}
      continue;
    }
    if (attempt++ >= retries) {
      let holder = ''; try { const h = JSON.parse(readIf(lockFile) || '{}'); holder = h.pid ? ' (held by process ' + h.pid + ' since ' + new Date(Number(h.at) || st.mtimeMs).toISOString() + ')' : ''; } catch (_) {}
      throw new LockBusy(what + ' is being changed by another writer' + holder + '; nothing was changed or recorded: try again');
    }
    sleep(waitMs + Math.floor(Math.random() * waitMs));
  }
  const mine = () => { const t = readIf(lockFile); return t != null && t.includes(token); };
  const lock = { file: lockFile, token, check() { if (!mine()) throw new LockBusy('the lock on ' + what + ' was lost (it went stale and another writer took it); nothing was changed or recorded: try again'); } };
  try { return fn(lock); }
  finally { try { if (mine()) fs.rmSync(lockFile, { force: true }); } catch (_) {} }
}

module.exports = { withFileLock, LockBusy };
