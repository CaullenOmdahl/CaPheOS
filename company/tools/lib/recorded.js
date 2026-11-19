'use strict';
/* lib/recorded.js — what a named tool really wrote, checked when the file is READ (not only on locked-watch's next tick).
 *
 * Why: company/tools/locked-watch.js puts back a hand edit of a locked record only on the dispatcher's tick. A gate that
 * reads the record in between (external-gate.js, merge-gate.js, the weekly routing suggestions, a seat's profile) would
 * otherwise act on a forged line or edit in that minute. So these readers keep only what the record's own writer recorded
 * in the provenance log (company/tools/provenance.js), with the same trust rule locked-watch.js uses (trustProvRow): a row
 * from a tainted node (-e, -r, preload) never counts; a row from an agent's run counts only when the running program IS
 * the writer tool it names (or the dispatcher); a row from outside the station (the dispatcher, the owner's shell, the
 * console) counts.
 *
 *   const RC = require('./lib/recorded');
 *   RC.lines(file, writers, o)       the complete lines of an append-only record whose bytes match a recorded append by one
 *                                    of `writers` (each recorded append matches once); o: { root, text (the file's text, if
 *                                    already read) }. Lines nobody recorded are left out.
 *   RC.newestWrite(file, writers, o) { sha, any }: the sha256 of the newest recorded whole-file write by `writers` (null if
 *                                    none) and whether any provenance row names the file at all
 *   RC.sha(buf)                      'sha256:<hex>'
 * The live provenance log is read first; its archive (retention.js rolls it after 14 days) only when something is not
 * found there. Each file is parsed once per process while it is unchanged.
 * Not proof: everyone runs as one Unix user, so a determined forger can still fake a provenance row (see provenance.js);
 * this makes a forgery take several deliberate steps, each visible in the agent's transcript.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha = b => 'sha256:' + crypto.createHash('sha256').update(Buffer.isBuffer(b) ? b : Buffer.from(String(b))).digest('hex');
const TOOL_PREFIX = 'company/tools/';
const rootOf = o => path.resolve((o && o.root) || process.env.PROVENANCE_ROOT || require('./company').ROOT);
const relOf = (file, root) => { const p = path.resolve(String(file || '')); return p.startsWith(root + path.sep) ? path.relative(root, p).split(path.sep).join('/') : null; };

// locked-watch.js trustProvRow, plus the writer name
function trusted(row, writers) {
  if (!row || row.tainted === true) return false;
  if (!writers.some(w => String(row.writer || '').split(' ')[0] === w)) return false;
  if (row.main === undefined) return true;   // a row from before `main` was recorded
  if (!row.underStation) return true;        // the dispatcher, the console or the owner's shell: not an agent run
  return writers.map(w => TOOL_PREFIX + w).concat([TOOL_PREFIX + 'dispatch.js']).includes(String(row.main));
}

/* one provenance log file, parsed into rows by file, cached while its size and mtime are unchanged */
const CACHE = new Map();
function byFile(f) {
  let st; try { st = fs.statSync(f); } catch (_) { return new Map(); }
  const c = CACHE.get(f); if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.map;
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return new Map(); }
  const map = new Map();
  for (const l of txt.split('\n')) { if (!l) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } if (!r || typeof r.file !== 'string') continue; if (!map.has(r.file)) map.set(r.file, []); map.get(r.file).push(r); }
  CACHE.set(f, { size: st.size, mtimeMs: st.mtimeMs, map });
  return map;
}
function provRows(root, rel, withArchive) {
  const dir = path.join(root, 'company', 'state', 'locked');
  const live = byFile(path.join(dir, 'provenance.jsonl')).get(rel) || [];
  if (!withArchive) return live;
  let names = []; try { names = fs.readdirSync(path.join(dir, 'archive', 'provenance')).filter(n => n.endsWith('.jsonl')).sort(); } catch (_) {}
  return names.reduce((a, n) => a.concat(byFile(path.join(dir, 'archive', 'provenance', n)).get(rel) || []), []).concat(live);
}

function lines(file, writers, o) {
  o = o || {};
  const root = rootOf(o), rel = relOf(file, root);
  let buf; if (o.text != null) buf = Buffer.from(String(o.text)); else { try { buf = fs.readFileSync(file); } catch (_) { return []; } }
  if (!rel) return [];
  const all = []; let p = 0;
  while (p < buf.length) { const nl = buf.indexOf(10, p); if (nl < 0) break; all.push(buf.subarray(p, nl + 1)); p = nl + 1; }
  if (!all.length) return [];
  const pass = withArchive => {
    const avail = new Map();
    for (const r of provRows(root, rel, withArchive)) if (r.kind === 'append' && r.chunkSha && trusted(r, writers)) avail.set(r.chunkSha, (avail.get(r.chunkSha) || 0) + 1);
    const out = []; let missing = false;
    for (const l of all) { const s = sha(l), n = avail.get(s) || 0; if (n > 0) { avail.set(s, n - 1); out.push(l.toString('utf8').replace(/\n$/, '')); } else if (l.length > 1) missing = true; }
    return { out, missing };
  };
  let r = pass(false); if (r.missing) r = pass(true);
  return r.out;
}

function newestWrite(file, writers, o) {
  const root = rootOf(o), rel = relOf(file, root); if (!rel) return { sha: null, any: false };
  const pick = rows => { let best = null; for (const r of rows) if (r.kind === 'write' && r.sha256 && trusted(r, writers)) best = r; return best; };
  let rows = provRows(root, rel, false), best = pick(rows);
  if (!best) { rows = provRows(root, rel, true); best = pick(rows); }
  return { sha: best ? best.sha256 : null, any: rows.length > 0 };
}

module.exports = { lines, newestWrite, trusted, sha, _clearCache: () => CACHE.clear() };
