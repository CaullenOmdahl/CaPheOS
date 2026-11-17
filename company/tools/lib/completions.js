'use strict';
/* lib/completions.js — the record of watched jobs that ended (company/state/completions.jsonl) and of the ones still
 * running (company/state/watched-jobs/<id>.json). Written only by company/tools/notify-when.js (provenance: every append
 * is a whole-file write recorded with provenance.js, and locked-watch.js puts back anything else); read by the
 * dispatcher (a completion is a wake source, and it satisfies `**Waiting on:** job:<id>` / `service:<name>`) and by the
 * console (Work › Handoffs: running jobs and recent completions, in plain words).
 *
 *   C.FILE(root) / C.RUNNING_DIR(root)
 *   C.recent(root, n)        the last n completion rows (bounded read: lib/bounded.js tailLines), oldest first
 *   C.running(root)          the watched jobs still running (a record whose pid is gone is dropped from the answer)
 *   C.append(root, row)      notify-when.js only: one row, then the retention bound (MAX_ROWS rows / MAX_BYTES)
 *   C.redact(text, root)     secrets out of an output tail: every value in secrets/ and common key shapes
 *   C.words(row)             "your gold backfill finished: exit 0 after 41 min" (or "FAILED: exit 2 after 3 min")
 * Row: { id, job, seat:[ids], why, cmd, service, pid, startedAt, endedAt, durationMs, exit, signal, status, tail:[lines], by }
 *   status: ok | failed | killed | timeout | ended (a watched --pid whose exit code nobody can read)
 * Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const B = require('./bounded');

const MAX_ROWS = 400, KEEP_ROWS = 300, MAX_BYTES = 1024 * 1024;
const FILE = root => path.join(root, 'company', 'state', 'completions.jsonl');
const RUNNING_DIR = root => path.join(root, 'company', 'state', 'watched-jobs');

function parse(l) { try { const r = JSON.parse(l); return r && typeof r === 'object' && r.id ? r : null; } catch (_) { return null; } }
function recent(root, n) { return B.tailLines(FILE(root), Math.max(1, n || 100), { maxBytes: MAX_BYTES * 2 }).map(parse).filter(Boolean); }
function alive(pid) { if (!(Number(pid) > 0)) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function running(root) {
  let names = []; try { names = fs.readdirSync(RUNNING_DIR(root)).filter(f => f.endsWith('.json')); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    let r = null; try { r = JSON.parse(fs.readFileSync(path.join(RUNNING_DIR(root), f), 'utf8')); } catch (_) {}
    if (r && r.id && alive(r.watcherPid || r.pid)) out.push(r);
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}
function redact(text, root) {
  let out = String(text == null ? '' : text);
  try {
    const dir = path.join(root, 'secrets');
    for (const f of fs.readdirSync(dir)) {
      if (f === 'README.md') continue;
      let v = ''; try { v = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (_) {}
      if (v.length >= 8) out = out.split(v).join('[secret ' + f + ']');
    }
  } catch (_) {}
  return out
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '[redacted key]')
    .replace(/\b((?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\b["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}=*/g, '$1[redacted]');
}
// one row, then the bound: the file is rewritten whole (atomic rename, provenance.wrote with the exact bytes, so
// locked-watch.js class A accepts it), keeping its newest KEEP_ROWS rows once it passes MAX_ROWS rows or MAX_BYTES.
// A mkdir lock keeps two jobs that end together from losing a row.
function append(root, row) {
  const f = FILE(root); const prov = require('../provenance.js'); const lock = f + '.lock';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmdirSync(lock); continue; } } catch (_) {}
      if (i > 400) throw new Error('completions lock busy: ' + lock);
      const t = Date.now(); while (Date.now() - t < 10) { /* wait briefly */ }
    }
  }
  try {
    let rows = B.tailLines(f, MAX_ROWS, { maxBytes: MAX_BYTES }).filter(parse);
    rows.push(JSON.stringify(row));
    let size = rows.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    if (rows.length > MAX_ROWS || size > MAX_BYTES) rows = rows.slice(-KEEP_ROWS);
    while (rows.length > 1 && (size = rows.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)) > MAX_BYTES) rows.shift();
    const text = rows.join('\n') + '\n';
    const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f); prov.wrote(f, text, 'notify-when.js');
  } finally { try { fs.rmdirSync(lock); } catch (_) {} }
  return row;
}
const mins = ms => { const m = Math.round((Number(ms) || 0) / 60000); return m < 1 ? Math.max(1, Math.round((Number(ms) || 0) / 1000)) + ' s' : m < 120 ? m + ' min' : (m / 60).toFixed(1).replace(/\.0$/, '') + ' h'; };
function failed(r) { return r && r.status !== 'ok' && r.status !== 'ended'; }
function words(r) {
  const what = r.why || r.job || (r.service ? 'the ' + r.service + ' run' : 'job');
  const how = r.status === 'ok' ? 'finished: exit 0' : r.status === 'ended' ? 'ended (exit code unknown)' : r.status === 'killed' ? 'FAILED: killed' + (r.signal ? ' (' + r.signal + ')' : '') : r.status === 'timeout' ? 'FAILED: timed out' : 'FAILED: exit ' + r.exit;
  return what + ' ' + how + ' after ' + mins(r.durationMs);
}
module.exports = { FILE, RUNNING_DIR, MAX_ROWS, KEEP_ROWS, MAX_BYTES, recent, running, append, redact, words, failed, alive, mins };
