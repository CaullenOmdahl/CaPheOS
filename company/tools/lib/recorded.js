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
 *   RC.health(o)                     { ok, why, trustedTo, allBad }: whether the live provenance log still matches the
 *                                    watcher's baseline (company/state/locked/baseline.json, its hash mirrored outside the
 *                                    company). Not ok when the log is missing, emptied or shorter than the baseline read,
 *                                    when its bytes before that point changed (allBad: no live row counts), when the
 *                                    baseline is gone while its mirror is there or no longer matches it (allBad), or when
 *                                    locked-watch flagged that an agent wrote to the log directly (provFlagged): then
 *                                    live rows from byte trustedTo on do not count until the owner rebuilds the baseline
 *                                    (a flag from before trustedTo was recorded is reported as legacyFlag and not acted on).
 *                                    With no baseline and no mirror (a fixture, a company before the watcher) it is ok.
 *   RC.lastGood(file, o)             { known, exists, buf }: locked-watch's last-known-good copy of the file, only from a
 *                                    trusted baseline whose sha matches the copy (known false otherwise). A reader whose
 *                                    record cannot be trusted (health not ok) falls back to this, never to the raw file.
 * The live provenance log is read first; its archive (retention.js rolls it after 14 days) only when something is not
 * found there. Each file is parsed once per process while it is unchanged.
 * Not proof: everyone runs as one Unix user, so a determined forger can still fake a provenance row (see provenance.js);
 * this makes a forgery take several deliberate steps, each visible in the agent's transcript.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
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
  const map = new Map(); let off = 0;
  for (const l of txt.split('\n')) {
    const at = off; off += Buffer.byteLength(l) + 1; if (!l) continue;
    let r; try { r = JSON.parse(l); } catch (_) { continue; } if (!r || typeof r.file !== 'string') continue;
    Object.defineProperty(r, '_off', { value: at, enumerable: false }); if (!map.has(r.file)) map.set(r.file, []); map.get(r.file).push(r);
  }
  CACHE.set(f, { size: st.size, mtimeMs: st.mtimeMs, map });
  return map;
}
/* ---------- the log's health against the watcher's baseline ---------- */
const PROV_KEY = 'company/state/locked/provenance.jsonl';
function slugOf(root) { let j = null; try { j = JSON.parse(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8')); } catch (_) {} return String((j && j.slug) || 'company').replace(/[^A-Za-z0-9_.-]/g, '_'); }
const mirrorOf = root => path.join(path.resolve(process.env.LOCKED_WATCH_HOME || os.homedir()), '.local', 'share', 'capheos-guard', slugOf(root), 'locked-baseline.sha256');
const statKey = f => { try { const s = fs.statSync(f); return s.size + ':' + s.mtimeMs; } catch (_) { return '-'; } };
const HCACHE = new Map();
// the baseline as locked-watch keeps it: { base, trusted } (base null when there is none)
function baselineOf(root) {
  const bf = path.join(root, 'company', 'state', 'locked', 'baseline.json');
  let txt = null; try { txt = fs.readFileSync(bf, 'utf8'); } catch (_) {}
  let mirror = null; try { mirror = fs.readFileSync(mirrorOf(root), 'utf8').trim(); } catch (_) {}
  // the mirror is keyed by the company's slug, so two checkouts on one machine can share it: locked-watch writes the root
  // it belongs to beside it (locked-baseline.root); a mirror for another root is not this company's
  let owner = null; try { owner = fs.readFileSync(mirrorOf(root).replace(/\.sha256$/, '.root'), 'utf8').trim(); } catch (_) {}
  const ours = owner != null && path.resolve(owner) === root;
  if (owner != null && !ours) mirror = null;
  let base = null; if (txt != null) { try { base = JSON.parse(txt); } catch (_) { base = null; } }
  return { base, txt, mirror, ours, trusted: !!(base && mirror && mirror === sha(txt) && !base.untrusted) };
}
function health(o) {
  const root = rootOf(o), dir = path.join(root, 'company', 'state', 'locked'), lf = path.join(dir, 'provenance.jsonl');
  const ck = root + '|' + statKey(path.join(dir, 'baseline.json')) + '|' + statKey(mirrorOf(root)) + '|' + statKey(mirrorOf(root).replace(/\.sha256$/, '.root')) + '|' + statKey(lf);
  const c = HCACHE.get(root); if (c && c.ck === ck) return c.h;
  const h = (() => {
    const B = baselineOf(root);
    if (!B.base) return B.mirror && B.ours ? { ok: false, allBad: true, why: 'the watcher\'s baseline is missing or unreadable while its mirror is there' } : { ok: true };
    if (!B.trusted) return { ok: false, allBad: true, why: 'the watcher\'s baseline does not match its mirror (or is marked untrusted)' };
    let st = null; try { st = fs.statSync(lf); } catch (_) {}
    const pb = (B.base.files || {})[PROV_KEY], off = Number(B.base.provOffset) || 0;
    const need = Math.max(off, pb && pb.exists ? Number(pb.bytes) || 0 : 0);
    if (need > 0 && !st) return { ok: false, allBad: true, why: 'the provenance log is missing' };
    if (st && st.size < need) return { ok: false, allBad: true, why: 'the provenance log is shorter than the watcher read (emptied or cut)' };
    if (pb && pb.exists && pb.sha256 && Number(pb.bytes) > 0) {
      const range = (pos, len) => { try { const fd = fs.openSync(lf, 'r'); try { const b = Buffer.alloc(Math.max(0, len)); const n = fs.readSync(fd, b, 0, b.length, pos); return n === b.length ? b : null; } finally { fs.closeSync(fd); } } catch (_) { return null; } };
      const n = Number(pb.bytes), K = 64 * 1024;   // a "lite" entry (a big log) keeps only its first and last 64 KB
      const same = pb.lite ? (x => x && sha(x) === pb.headSha)(range(0, Math.min(K, n))) && (x => x && sha(x) === pb.tailSha)(range(Math.max(0, n - K), Math.min(K, n))) : (x => x && sha(x) === pb.sha256)(range(0, n));
      if (!same) return { ok: false, allBad: true, why: 'the provenance log was rewritten before the point the watcher read' };
    }
    const pf = B.base.provFlagged;
    if (pf && Number.isFinite(Number(pf.trustedTo))) return { ok: false, allBad: false, trustedTo: Number(pf.trustedTo), why: 'locked-watch found an agent writing to the provenance log; rows after that point do not count until the owner rebuilds the baseline' };
    if (pf) return { ok: true, legacyFlag: true };   // a flag from before trustedTo was recorded: where it starts is unknown (rebuild the baseline)
    return { ok: true };
  })();
  HCACHE.set(root, { ck, h });
  return h;
}
function lastGood(file, o) {
  const root = rootOf(o), rel = relOf(file, root); if (!rel) return { known: false };
  const B = baselineOf(root); if (!B.trusted) return { known: false };
  const b = (B.base.files || {})[rel]; if (!b) return { known: false };
  if (!b.exists) return { known: true, exists: false, buf: null };
  if (!b.lkgSha) return { known: false };
  let buf = null; try { buf = fs.readFileSync(path.join(root, 'company', 'state', 'locked', 'lkg', rel)); } catch (_) { return { known: false }; }
  return sha(buf) === b.lkgSha ? { known: true, exists: true, buf } : { known: false };
}

function provRows(root, rel, withArchive) {
  const dir = path.join(root, 'company', 'state', 'locked');
  const H = health({ root });
  let live = byFile(path.join(dir, 'provenance.jsonl')).get(rel) || [];
  if (!H.ok) live = H.allBad ? [] : live.filter(r => r._off < H.trustedTo);
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

module.exports = { lines, newestWrite, trusted, sha, health, lastGood, _clearCache: () => { CACHE.clear(); HCACHE.clear(); } };
