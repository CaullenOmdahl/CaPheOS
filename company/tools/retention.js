#!/usr/bin/env node
/* retention.js — every growing file the company reads has a bound; this keeps each one inside it without losing a byte.
 *
 *   node company/tools/retention.js status [--json]     each artifact: size, rows, age of its oldest live entry, bound, over/under
 *   node company/tools/retention.js apply [--dry-run]   roll, rotate and archive by the policy (the dispatcher runs this once a day)
 *   node company/tools/retention.js audit               exit 1 if any bounded artifact is over its bound
 *   node company/tools/retention.js find <artifact> <text> [--limit N] [--json]
 *                                                       lines with <text> in the live file and every archive month
 *                                                       (<artifact>: decisions, dispatch-log, to-founder, a path, ...)
 *   node company/tools/retention.js selftest
 *
 * The invariant (docs/RETENTION.md): any file an agent or a per-tick tool reads in full must have a bound.
 * Policy: company/work/ops/retention.json (owner-editable; defaults company/defaults/work/ops/retention.json, merged by id).
 *   roll-monthly / keep-N-days  entries older than keepDays move into <dir>/archive/<name>/YYYY-MM.<ext> by the entry's own
 *                               month; one pointer line stays in the live file. keepLast keeps that many newest entries anyway;
 *                               keepIf "clearance-live" keeps every external-gate clearance that still clears something.
 *                               maxLiveBytes: whichever bound is hit first, days or bytes; past it the oldest entries move
 *                               too (down to rollToFraction, default 0.75, of the bound; the newest entry always stays).
 *                               The dispatcher's hook checks the size on every tick (a stat), the days once a day.
 *                               The pointer line names the archive files and the `find` command.
 *   keep-last-N                 all but the newest keepLast entries move the same way.
 *   size-rotate                 past maxBytes: the file is copied to <file>.1.gz (older copies shift, `keep` are kept) and
 *                               cut back (copytruncate; the bytes written while copying are put back).
 *   archive-dir                 finished records in a folder (commitments: closed/cancelled/suppressed/verified, quiet for
 *                               keepDays) move to <dir>/archive/YYYY-MM/.
 *   run-journal                 StarNet's .run-journal: a journal with a resolution record, quiet for resolvedAfterDays, is
 *                               removed; an unresolved one quiet for keepDays is gzipped to .starnet-data/run-journal-archive/.
 *   never                       not touched; `reason` says who bounds it (StarNet owns runs.jsonl and the transcripts).
 * Never losing a byte: the archive is append-only; before a live file is shortened, each archived chunk is read back and its
 * sha256 and line count checked; the live file is replaced through a temp file and a rename only if it still holds what was
 * read (an append since is carried over). Each archive's size and hash are kept in company/state/retention-state.json and
 * checked before the next append, so an archive edited by hand is refused, not extended. Each roll of a file under company/
 * is recorded in the provenance log (prov.rolled: the bytes left, the bytes before, where every archived byte went), so
 * locked-watch.js rebuilds the file as it was and checks the roll lost nothing. The whole apply runs under locked-watch's lock,
 * and the provenance log's own roll moves the watcher's byte offset in the same operation (locked-watch rebaseProvenance).
 * Lines matching an artifact's `index` patterns are also copied to <archive dir>/index.<ext> (competence anchors), so a
 * reader that needs only those finds them without reading every month.
 * Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const co = require('./lib/company');

const DAY = 86400e3;
const sha = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const lday = ms => co.localParts(new Date(ms)).date;   // YYYY-MM-DD, company time

function ctxOf(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  return { root, P: rel => path.join(root, rel), now: Number.isFinite(o.now) ? o.now : Date.now(), dry: !!o.dry, log: o.log || (() => {}),
    home: o.home, policy: o.policy || null, stateFile: path.join(root, 'company', 'state', 'retention-state.json') };
}
function loadPolicy(ctx) {
  if (ctx.policy) return ctx.policy;
  const def = readJson(ctx.P('company/defaults/work/ops/retention.json'), { artifacts: [] }) || { artifacts: [] };
  const live = readJson(ctx.P('company/work/ops/retention.json'), null);
  const by = new Map((def.artifacts || []).map(a => [a.id, a]));
  for (const a of (live && live.artifacts) || []) if (a && a.id) by.set(a.id, a);
  return { artifacts: [...by.values()] };
}
const loadState = ctx => readJson(ctx.stateFile, null) || { v: 1, archives: {} };
function saveState(ctx, st) { if (ctx.dry) return; fs.mkdirSync(path.dirname(ctx.stateFile), { recursive: true }); const t = ctx.stateFile + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(st, null, 1) + '\n'); fs.renameSync(t, ctx.stateFile); }

/* ---------------- parsing: a file is units whose texts concatenate to the file exactly ---------------- */
const POINTER_MARK = 'moved there by company/tools/retention.js';
function archiveDirOf(rel) {
  const dir = path.posix.dirname(rel), base = path.posix.basename(rel), ext = path.posix.extname(base), stem = base.slice(0, base.length - ext.length);
  return { dir: path.posix.basename(dir) === 'archive' ? dir + '/' + stem : dir + '/archive/' + stem, ext: ext || '.log' };
}
// the pointer line names the archive files (the newest 12; the folder holds the rest) and the command that searches them
function findArg(a, rel) { return a.path.includes('*') ? rel : a.id; }
function pointerText(a, rel, files) {
  const d = archiveDirOf(rel).dir + '/'; const ext = archiveDirOf(rel).ext;
  const fl = (files || []).slice().sort(); const shown = fl.slice(-12); const more = fl.length - shown.length;
  const find = 'node company/tools/retention.js find ' + findArg(a, rel) + ' "<text>"';
  if (a.format === 'jsonl') return JSON.stringify({ _retention: 'rolled', archive: d, files: shown.map(f => d + f), older: more || undefined, find, note: 'older rows were ' + POINTER_MARK + ' (docs/RETENTION.md)' }) + '\n';
  const list = shown.length ? shown.map(f => '`' + f + '`').join(', ') + (more ? ' and ' + more + ' older' : '') : '`YYYY-MM' + ext + '`';
  if (a.format === 'lines') return '# older lines: ' + d + ' ' + shown.join(', ') + (more ? ' (+' + more + ' older)' : '') + '; search: ' + find + ' (' + POINTER_MARK + ')\n';
  return '_Older entries are in `' + d + '`: ' + list + (a.index && a.index.length ? ' (anchors also in `index' + ext + '`)' : '') + '. Search live and archive: `' + find + '` (' + POINTER_MARK + '; docs/RETENTION.md)._\n';
}
// the month files an archive folder holds now
function archiveFiles(ctx, rel) {
  const { dir, ext } = archiveDirOf(rel); const re = new RegExp('^\\d{4}-\\d{2}' + ext.replace(/[.]/g, '\\.') + '$');
  try { return fs.readdirSync(ctx.P(dir)).filter(f => re.test(f)).sort(); } catch (_) { return []; }
}
const isPointer = (a, line) => line.includes(POINTER_MARK) || (a.format === 'jsonl' && /^\{"_retention":/.test(line));
function tsOfRow(r) {
  for (const k of ['at', 'ts', 'time', 'appliedAt', 'endedAt', 'startedAt', 'createdAt']) {
    const v = r && r[k]; if (v == null) continue;
    const t = typeof v === 'number' ? v : Date.parse(String(v)); if (Number.isFinite(t) && t > 0) return t;
  }
  return null;
}
const DATE_ENTRY = /^(?:[-*] |\| )(?:\*\*)?(\d{4}-\d{2}-\d{2})/;
function parse(a, text) {
  const lines = text.split(/(?<=\n)/);   // keeps each "\n"
  const units = [];
  const push = (kind, t, day, ms, row) => units.push({ kind, text: t, day, ms, row });
  if (a.format === 'jsonl' || a.format === 'lines') {
    for (const l of lines) {
      const body = l.replace(/\n$/, '');
      if (isPointer(a, body)) { push('pointer', l); continue; }
      if (!body.trim()) { push('fixed', l); continue; }
      let ms = null, row = null;
      if (a.format === 'jsonl') { try { row = JSON.parse(body); ms = tsOfRow(row); } catch (_) {} }
      else { const m = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(body); if (m) ms = Date.parse(m[1]); }
      if (ms) push('entry', l, lday(ms), ms, row); else push('fixed', l);   // a row with no time is never moved
    }
    return units;
  }
  const entryRe = a.format === 'md-sections' ? /^## .*?(\d{4}-\d{2}-\d{2})/ : new RegExp(a.entry || DATE_ENTRY.source);
  let cur = null;
  for (const l of lines) {
    const body = l.replace(/\n$/, '');
    const m = entryRe.exec(body);
    if (isPointer(a, body)) { cur = null; push('pointer', l); continue; }
    if (m) { push('entry', l, m[1], null); const u = units[units.length - 1]; const hm = /^[ T](\d{2}:\d{2})/.exec(body.slice(m.index + m[0].length)); u.hm = hm ? hm[1] : ''; cur = a.single ? null : u; continue; }
    if (a.format === 'md-sections' && /^## /.test(body)) { push('entry', l, null, null); cur = units[units.length - 1]; continue; }   // a section with no date: kept
    if (cur && !(a.format !== 'md-sections' && /^#/.test(body))) { cur.text += l; continue; }
    cur = null; push('fixed', l);
  }
  return units;
}

/* ---------------- choosing what moves ---------------- */
function clearanceLive(row, now) {
  if (!row || typeof row !== 'object') return true;
  if (row.closedAt) return false;
  const u = Date.parse(String(row.until || ''));
  return !Number.isFinite(u) || u > now;   // no parseable expiry: kept (never guess a row away)
}
function select(a, units, ctx, maxCut) {
  const keepDays = Number(a.keepDays);
  const cutDay = Number.isFinite(keepDays) ? lday(ctx.now - keepDays * DAY) : null;
  const entries = units.map((u, i) => ({ u, i })).filter(x => x.u.kind === 'entry' && x.u.day);
  const keepLast = Number(a.keepLast) || 0;
  const newest = new Set(entries.slice().sort((x, y) => String(y.u.day).localeCompare(String(x.u.day)) || ((y.u.ms || 0) - (x.u.ms || 0)) || (y.i - x.i)).slice(0, keepLast).map(x => x.i));
  const out = new Set();
  for (const { u, i } of entries) {
    if (newest.has(i)) continue;
    if (a.policy === 'keep-last-N') { out.add(i); continue; }
    if (!cutDay || !(u.day < cutDay)) continue;
    if (a.keepIf === 'clearance-live' && clearanceLive(u.row, ctx.now)) continue;
    out.add(i);
  }
  // maxLiveBytes: whichever bound is hit first. Past it, the oldest entries move too, until the live file is back to
  // rollToFraction of the bound (0.75 by default, so the file is not rolled again on the very next entry). The newest
  // entry, the keepLast newest and every still-live clearance always stay.
  const maxB = Number(a.maxLiveBytes);
  if (maxB > 0) {
    const sz = units.reduce((n, u, i) => n + (out.has(i) ? 0 : Buffer.byteLength(u.text)), 0) + (units.some(u => u.kind === 'pointer') ? 0 : 400);
    if (sz > maxB) {
      const target = Math.floor(maxB * (Number(a.rollToFraction) > 0 && Number(a.rollToFraction) <= 1 ? Number(a.rollToFraction) : 0.75));
      const age = x => (x.u.ms ? new Date(x.u.ms).toISOString() : x.u.day + 'T' + (x.u.hm || '00:00'));
      // ties (the same minute) go by file order; which end of the file is newest is read off the entries themselves
      let up = 0, down = 0; for (let k = 1; k < entries.length; k++) { const c = age(entries[k]).localeCompare(age(entries[k - 1])); if (c > 0) up++; else if (c < 0) down++; }
      const newestFirst = down > up;
      const order = entries.slice().sort((x, y) => age(x).localeCompare(age(y)) || (newestFirst ? y.i - x.i : x.i - y.i));
      const youngest = order.length ? order[order.length - 1].i : -1;
      let left = sz;
      for (const { u, i } of order) {
        if (left <= target) break;
        if (out.has(i) || newest.has(i) || i === youngest) continue;
        if (a.keepIf === 'clearance-live' && clearanceLive(u.row, ctx.now)) continue;
        out.add(i); left -= Buffer.byteLength(u.text);
      }
    }
  }
  if (Number.isFinite(maxCut)) {   // the provenance log: only a prefix of rows the watcher already read
    let off = 0; const pre = new Set();
    for (let i = 0; i < units.length; i++) {
      const u = units[i]; off += Buffer.byteLength(u.text);
      if (u.kind === 'pointer') continue;
      if (!out.has(i) || off > maxCut) break;
      pre.add(i);
    }
    return pre;
  }
  return out;
}

/* ---------------- rolling one file ---------------- */
function verifyArchive(ctx, st, rel) {
  const f = ctx.P(rel); const rec = st.archives[rel];
  if (!fs.existsSync(f)) return rec && rec.bytes ? 'the archive ' + rel + ' is gone (it had ' + rec.bytes + ' bytes)' : null;
  if (!rec) return null;
  const b = fs.readFileSync(f);
  if (b.length < rec.bytes || sha(b.subarray(0, rec.bytes)) !== rec.sha256) return 'the archive ' + rel + ' was changed outside retention.js';
  return null;
}
function archiveHeader(a, rel, month) {
  if (a.format === 'jsonl' || a.format === 'lines') return '';
  return '# Archive of ' + rel + ' — ' + month + '\n\nEntries ' + POINTER_MARK + ' from `' + rel + '`. Append-only.\n\n';
}
const countLines = b => { let n = 0; for (let i = 0; i < b.length; i++) if (b[i] === 10) n++; return n; };
function writeAtomic(file, buf, mode) { const t = file + '.retention-tmp'; fs.writeFileSync(t, buf, mode != null ? { mode } : undefined); fs.renameSync(t, file); }

function rollFile(ctx, a, rel, st, opt) {
  const o = opt || {};
  const file = ctx.P(rel);
  let before; try { before = fs.readFileSync(file); } catch (_) { return { rel, skipped: 'absent' }; }
  const text = before.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(before) !== 0) return { rel, skipped: 'not valid UTF-8: left alone' };
  const units = parse(a, text);
  if (units.map(u => u.text).join('') !== text) return { rel, error: 'could not split the file into entries exactly; left alone' };
  const moved = select(a, units, ctx, o.maxCut);
  if (!moved.size) return { rel, moved: 0 };
  const hasPointer = units.some(u => u.kind === 'pointer');
  const { dir, ext } = archiveDirOf(rel);
  // the pointer names every archive file there will be after this roll; an old pointer that names fewer is replaced
  // (its old text goes into the provenance row inline, so locked-watch still rebuilds the file as it was)
  const files = [...new Set(archiveFiles(ctx, rel).concat([...moved].map(i => units[i].day.slice(0, 7) + ext)))];
  const ptrNew = pointerText(a, rel, files);
  const ptrIdx = hasPointer ? units.findIndex(u => u.kind === 'pointer') : -1;
  // where a new pointer goes: after the header (the units before the first entry), or first in a jsonl/lines file
  let pAt = 0;
  if (!hasPointer && a.format !== 'jsonl' && a.format !== 'lines') { pAt = units.findIndex(u => u.kind === 'entry'); if (pAt < 0) pAt = units.length; }
  const ptr = hasPointer ? '' : ptrNew + (a.format !== 'jsonl' && a.format !== 'lines' && pAt < units.length ? '\n' : '');   // a blank line before the first entry
  // archived units in file order, grouped into chunks of one month each; `stream` is every piece the rebuild takes back,
  // in the order of the ops (archive chunks and, for a replaced pointer, its old text inline)
  const chunks = []; const stream = []; const ops = []; const keptParts = []; let afterPos = 0; let ptrWritten = 0;
  for (let i = 0; i < units.length; i++) {
    if (i === pAt && ptr) { ops.push([afterPos, Buffer.byteLength(ptr), 0]); keptParts.push(ptr); afterPos += Buffer.byteLength(ptr); ptrWritten = Buffer.byteLength(ptr); }
    const u = units[i];
    if (i === ptrIdx && u.text !== ptrNew) {
      ops.push([afterPos, Buffer.byteLength(ptrNew), Buffer.byteLength(u.text)]); stream.push({ inline: u.text });
      keptParts.push(ptrNew); afterPos += Buffer.byteLength(ptrNew); ptrWritten = Buffer.byteLength(ptrNew); continue;
    }
    if (!moved.has(i)) { keptParts.push(u.text); afterPos += Buffer.byteLength(u.text); continue; }
    const t = u.text.endsWith('\n') ? u.text : u.text + '\n';   // the last line of a file may lack its newline
    const month = u.day.slice(0, 7); const arel = dir + '/' + month + ext;
    const last = stream[stream.length - 1];
    if (last && last.archive === arel && last.unitEnd === i) { last.text += t; last.unitEnd = i + 1; last.lines += 1; last.extra += t.length - u.text.length; }
    else { const c = { archive: arel, month, text: t, unitEnd: i + 1, lines: 1, extra: t.length - u.text.length }; chunks.push(c); stream.push(c); }
    const lastOp = ops[ops.length - 1];
    if (lastOp && lastOp[0] === afterPos && lastOp[1] === 0) lastOp[2] += Buffer.byteLength(t); else ops.push([afterPos, 0, Buffer.byteLength(t)]);
  }
  if (pAt === units.length && ptr) { ops.push([afterPos, Buffer.byteLength(ptr), 0]); keptParts.push(ptr); ptrWritten = Buffer.byteLength(ptr); }
  if (chunks.some(c => c.extra)) {
    // a moved final line without "\n": the archive gets the newline; the rebuilt file must not, so this one is left for later
    return { rel, skipped: 'the last line has no newline yet; next run' };
  }
  const after = Buffer.from(keptParts.join(''), 'utf8');
  const res = { rel, moved: moved.size, archives: [...new Set(chunks.map(c => c.archive))], bytes: before.length - after.length };
  if (ctx.dry) return Object.assign(res, { dry: true });
  // 1. the archives are what we last left them
  for (const arel of res.archives) { const why = verifyArchive(ctx, st, arel); if (why) return { rel, error: why + '; nothing rolled (docs/RETENTION.md: archives are append-only)' }; }
  if (!fs.readFileSync(file).equals(before)) return { rel, skipped: 'changed while rolling; next run' };
  // 2. append each chunk, then read it back
  const recs = [];
  for (const c of stream) {
    if (c.inline != null) { const buf = Buffer.from(c.inline, 'utf8'); recs.push({ inline: c.inline, bytes: buf.length, sha256: sha(buf) }); continue; }
    const af = ctx.P(c.archive); fs.mkdirSync(path.dirname(af), { recursive: true });
    if (!fs.existsSync(af)) fs.writeFileSync(af, archiveHeader(a, rel, c.month));
    const offset = fs.statSync(af).size; const buf = Buffer.from(c.text, 'utf8');
    fs.appendFileSync(af, buf);
    const fd = fs.openSync(af, 'r'); const back = Buffer.alloc(buf.length);
    try { fs.readSync(fd, back, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    if (sha(back) !== sha(buf) || countLines(back) !== countLines(buf)) return { rel, error: 'the archive ' + c.archive + ' did not read back what was appended; the live file was not touched' };
    recs.push({ archive: c.archive, offset, bytes: buf.length, sha256: sha(buf) });
  }
  // the whole archive's new state (read once, one month at most)
  for (const arel of res.archives) { const b = fs.readFileSync(ctx.P(arel)); st.archives[arel] = { bytes: b.length, sha256: sha(b), at: new Date(ctx.now).toISOString() }; }
  // 3. index lines (competence anchors) for readers that need only those
  if (Array.isArray(a.index) && a.index.length) {
    const res2 = a.index.map(s => new RegExp(s));
    const hits = chunks.map(c => c.text.split('\n').filter(l => res2.some(r => r.test(l))).join('\n')).filter(Boolean);
    if (hits.length) { const ip = ctx.P(dir + '/index' + ext); fs.mkdirSync(path.dirname(ip), { recursive: true }); fs.appendFileSync(ip, hits.join('\n') + '\n'); }
  }
  // 4. replace the live file, carrying over anything appended since it was read
  const mode = fs.statSync(file).mode & 0o7777;
  let now = fs.readFileSync(file);
  let tail = Buffer.alloc(0);
  if (!now.equals(before)) {
    if (now.length > before.length && now.subarray(0, before.length).equals(before)) tail = now.subarray(before.length);
    else return { rel, error: 'changed while rolling (not an append): the archive holds a copy of the moved entries, the live file was left whole; next run moves them again', orphan: recs };
  }
  writeAtomic(file, Buffer.concat([after, tail]), mode);
  now = fs.readFileSync(file);
  if (!now.subarray(0, after.length).equals(after)) return { rel, error: 'the live file changed during the rename; check it' };
  if (!o.noProvenance) { try { require('./provenance.js').rolled(file, { before, after, ops, chunks: recs }, 'retention.js'); } catch (_) {} }
  return Object.assign(res, { ops, chunks: recs, cut: before.length - after.length + ptrWritten, pointer: ptrWritten, hadPointer: hasPointer });
}

/* ---------------- the other policies ---------------- */
function sizeRotate(ctx, a, rel) {
  const file = ctx.P(rel); const max = Number(a.maxBytes) || 50e6; const keep = Math.max(1, Number(a.keep) || 5);
  let size; try { size = fs.statSync(file).size; } catch (_) { return { rel, skipped: 'absent' }; }
  if (size <= max) return { rel, moved: 0 };
  if (ctx.dry) return { rel, dry: true, rotate: size };
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(size); fs.readSync(fd, head, 0, size, 0);
    const gz = zlib.gzipSync(head);
    if (!zlib.gunzipSync(gz).equals(head)) return { rel, error: 'gzip did not round-trip; not rotated' };
    for (let i = keep; i >= 1; i--) { const f = file + '.' + i + '.gz'; if (!fs.existsSync(f)) continue; if (i === keep) fs.unlinkSync(f); else fs.renameSync(f, file + '.' + (i + 1) + '.gz'); }
    writeAtomic(file + '.1.gz', gz);
    // copytruncate: what was written while copying goes back, then the writer (O_APPEND) carries on at the new end
    const now = fs.fstatSync(fd).size; const late = Buffer.alloc(Math.max(0, now - size)); if (late.length) fs.readSync(fd, late, 0, late.length, size);
    fs.ftruncateSync(fd, 0); if (late.length) fs.writeSync(fd, late, 0, late.length, 0);
    return { rel, rotated: size, kept: late.length, archive: rel + '.1.gz' };
  } finally { fs.closeSync(fd); }
}
function runJournal(ctx, a, rel) {
  const dir = ctx.P(rel); let names = []; try { names = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { return { rel, skipped: 'absent' }; }
  const arch = ctx.P('.starnet-data/run-journal-archive'); const out = { rel, removed: 0, archived: 0, expired: 0 };
  const quietResolved = (Number(a.resolvedAfterDays) || 1) * DAY, quiet = (Number(a.keepDays) || 30) * DAY;
  for (const n of names) {
    const f = path.join(dir, n); let st; try { st = fs.statSync(f); } catch (_) { continue; }
    const age = ctx.now - st.mtimeMs; if (age < quietResolved) continue;
    const tail = require('./lib/bounded').tailText(f, 256 * 1024);
    const resolved = /"type":"resolution"|"type":"resolve"/.test(tail);
    if (resolved) { if (!ctx.dry) fs.unlinkSync(f); out.removed++; continue; }
    if (age < quiet) continue;
    if (!ctx.dry) { const b = fs.readFileSync(f); const gz = zlib.gzipSync(b); if (!zlib.gunzipSync(gz).equals(b)) continue; fs.mkdirSync(arch, { recursive: true }); writeAtomic(path.join(arch, n + '.gz'), gz); fs.unlinkSync(f); }
    out.archived++;
  }
  try { for (const n of fs.readdirSync(arch)) { const f = path.join(arch, n); if (ctx.now - fs.statSync(f).mtimeMs > (Number(a.archiveKeepDays) || 365) * DAY) { if (!ctx.dry) fs.unlinkSync(f); out.expired++; } } } catch (_) {}
  return out;
}
function lastActivity(c) {
  let t = Date.parse(c.updatedAt || c.createdAt || '') || 0;
  for (const h of c.history || []) { const x = Date.parse(h.at || ''); if (x > t) t = x; }
  return t;
}
function archiveDir(ctx, a, rel) {
  const dir = ctx.P(rel); let names = []; try { names = fs.readdirSync(dir).filter(f => /^c-.*\.json$/.test(f)); } catch (_) { return { rel, skipped: 'absent' }; }
  const states = a.states || ['closed', 'cancelled', 'suppressed', 'verified']; const quiet = (Number(a.keepDays) || 30) * DAY;
  let moved = 0;
  for (const n of names) {
    const f = path.join(dir, n); const c = readJson(f, null);
    if (!c || !states.includes(c.state)) continue;
    const t = lastActivity(c); if (!t || ctx.now - t < quiet) continue;
    const to = path.join(dir, 'archive', lday(t).slice(0, 7), n);
    if (!ctx.dry) {
      const b = fs.readFileSync(f); fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to) && !fs.readFileSync(to).equals(b)) continue;   // never overwrite a different archived copy
      writeAtomic(to, b);
      if (!fs.readFileSync(to).equals(b)) continue;
      if (fs.readFileSync(f).equals(b)) fs.unlinkSync(f); else { fs.unlinkSync(to); continue; }   // changed meanwhile: stays live
    }
    moved++;
  }
  return { rel, moved };
}

/* ---------------- apply ---------------- */
function expandPaths(ctx, p) {
  if (!p.includes('*')) return [p];
  const dir = path.posix.dirname(p), re = new RegExp('^' + path.posix.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  try { return fs.readdirSync(ctx.P(dir)).filter(n => re.test(n) && fs.statSync(ctx.P(dir + '/' + n)).isFile()).sort().map(n => dir + '/' + n); } catch (_) { return []; }
}
const ROW_POLICIES = ['roll-monthly', 'keep-N-days', 'keep-last-N'];
function apply(opt) {
  const ctx = ctxOf(opt); const pol0 = loadPolicy(ctx); const st = loadState(ctx); const results = [];
  const only = opt && Array.isArray(opt.only) ? new Set(opt.only) : null;   // a size-bound roll between daily applies
  const pol = only ? { artifacts: pol0.artifacts.filter(a => only.has(a.id)) } : pol0;
  const LW = (() => { try { return require('./locked-watch.js'); } catch (_) { return null; } })();
  const lwOpts = { root: ctx.root, home: ctx.home };
  const body = () => {
    let prov = null;
    for (const a of pol.artifacts) {
      try {
        if (ROW_POLICIES.includes(a.policy)) {
          if (a.special === 'provenance') { prov = a; continue; }   // last: the other rolls add rows to it
          for (const rel of expandPaths(ctx, a.path)) results.push(Object.assign({ id: a.id }, rollFile(ctx, a, rel, st)));
        } else if (a.policy === 'size-rotate') results.push(Object.assign({ id: a.id }, sizeRotate(ctx, a, a.path)));
        else if (a.policy === 'run-journal') results.push(Object.assign({ id: a.id }, runJournal(ctx, a, a.path)));
        else if (a.policy === 'archive-dir') results.push(Object.assign({ id: a.id }, archiveDir(ctx, a, a.path)));
      } catch (e) { results.push({ id: a.id, rel: a.path, error: e.message }); }
    }
    if (prov) {
      const one = lim => rollFile(ctx, prov, prov.path, st, { maxCut: lim, noProvenance: true });
      if (ctx.dry || !LW) results.push(Object.assign({ id: prov.id }, one(Infinity)));
      else {
        const r = LW.rebaseProvenance(lwOpts, ({ maxCut }) => one(maxCut));
        results.push(Object.assign({ id: prov.id }, r.refused ? { rel: prov.path, skipped: 'locked-watch: ' + r.refused } : r.result, r.provOffset != null ? { provOffset: r.provOffset } : {}));
      }
    }
    return results;
  };
  let out;
  if (ctx.dry || !LW) out = body();
  else { out = LW.withWatchLock(lwOpts, body); if (out && out.busy) return { busy: true, results: [] }; }
  const sum = { at: new Date(ctx.now).toISOString(), day: lday(ctx.now), moved: out.reduce((n, r) => n + (r.moved || 0), 0), errors: out.filter(r => r.error).length };
  if (only) st.lastSizeRoll = Object.assign(sum, { ids: [...only] }); else st.lastApply = sum;
  saveState(ctx, st);
  return { results: out };
}

/* ---------------- status / audit ---------------- */
function measure(ctx, a, rel) {
  const f = ctx.P(rel); let s; try { s = fs.statSync(f); } catch (_) { return { rel, exists: false }; }
  if (s.isDirectory()) {
    let n = 0, oldest = null;
    try { for (const x of fs.readdirSync(f)) { const st = fs.statSync(path.join(f, x)); if (!st.isFile()) continue; n++; if (oldest == null || st.mtimeMs < oldest) oldest = st.mtimeMs; } } catch (_) {}
    return { rel, exists: true, dir: true, bytes: null, rows: n, ageDays: oldest == null ? 0 : Math.floor((ctx.now - oldest) / DAY) };
  }
  const out = { rel, exists: true, bytes: s.size, rows: null, ageDays: null };
  if (s.size > 64e6) { out.rows = '(large)'; return out; }
  const b = fs.readFileSync(f); out.rows = countLines(b);
  if (ROW_POLICIES.includes(a.policy)) {
    const days = parse(a, b.toString('utf8')).filter(u => u.kind === 'entry' && u.day).map(u => u.day).sort();
    if (days.length) out.ageDays = Math.max(0, Math.floor((Date.parse(lday(ctx.now)) - Date.parse(days[0])) / DAY));
    if (a.keepIf === 'clearance-live') out.ageNote = 'live clearances are kept whatever their age';
  }
  return out;
}
function overOf(a, m) {
  const b = a.bound || {}; const why = [];
  if (!m.exists) return why;
  if (b.bytes && m.bytes != null && m.bytes > b.bytes) why.push(m.bytes + ' bytes > ' + b.bytes);
  if (b.rows && typeof m.rows === 'number' && m.rows > b.rows) why.push(m.rows + ' rows > ' + b.rows);
  if (b.days && m.ageDays != null && m.ageDays > b.days && a.keepIf !== 'clearance-live') why.push('oldest entry ' + m.ageDays + ' days > ' + b.days);
  return why;
}
function status(opt) {
  const ctx = ctxOf(opt); const pol = loadPolicy(ctx); const rows = [];
  for (const a of pol.artifacts) {
    const rels = a.path.includes('*') ? expandPaths(ctx, a.path) : [a.path];
    for (const rel of rels.length ? rels : [a.path]) {
      const m = measure(ctx, a, rel); const over = overOf(a, m);
      rows.push({ id: a.id, path: rel, policy: a.policy, exists: m.exists, bytes: m.bytes, rows: m.rows, ageDays: m.ageDays, bound: a.bound || null, owner: a.owner || 'capheos',
        state: a.policy === 'never' ? 'unbounded by CaPheOS: ' + (a.reason || '') : !m.exists ? 'absent' : over.length ? 'OVER: ' + over.join('; ') : 'under', over: over.length > 0 });
    }
  }
  return { at: new Date(ctx.now).toISOString(), lastApply: (loadState(ctx).lastApply) || null, artifacts: rows };
}
function audit(opt) { const s = status(opt); const over = s.artifacts.filter(r => r.over); return { ok: !over.length, over }; }

/* the dispatcher's daily hook: apply once per company day, then audit; everything it does is one line in the dispatch log */
// the artifacts whose live file is past its maxLiveBytes now (a stat per file: cheap enough for every tick)
function overLiveBytes(ctx, pol) {
  const out = [];
  for (const a of pol.artifacts) {
    if (!ROW_POLICIES.includes(a.policy) || !(Number(a.maxLiveBytes) > 0)) continue;
    if (expandPaths(ctx, a.path).some(rel => { try { return fs.statSync(ctx.P(rel)).size > Number(a.maxLiveBytes); } catch (_) { return false; } })) out.push(a.id);
  }
  return out;
}
function daily(opt) {
  opt = opt || {};
  const ctx = ctxOf(opt); const st = loadState(ctx);
  if (st.lastApply && st.lastApply.day === lday(ctx.now) && !opt.force) {
    // applied today already; a file past its maxLiveBytes rolls now anyway (whichever bound is hit first)
    const over = overLiveBytes(ctx, loadPolicy(ctx));
    if (!over.length) return { skipped: 'already applied today' };
    const r = apply(Object.assign({}, opt, { only: over }));
    if (r.busy) return r;
    const moved = r.results.filter(x => x.moved); const errs = r.results.filter(x => x.error);
    if (moved.length || errs.length) ctx.log('RETENTION (size bound)' + (ctx.dry ? ' (dry run)' : '') + ': ' + (moved.map(x => x.id + (x.rel && x.rel !== x.id ? '(' + path.posix.basename(x.rel) + ')' : '') + ' ' + x.moved).join(', ') || 'nothing moved') + (errs.length ? '; ERRORS: ' + errs.map(x => x.id + ': ' + x.error).join('; ').slice(0, 300) : ''));
    return Object.assign(r, { sizeRoll: over });
  }
  const r = apply(opt);
  if (r.busy) { ctx.log('RETENTION: locked-watch is busy; next tick'); return r; }
  const moved = r.results.filter(x => x.moved || x.rotated || x.removed || x.archived);
  const errs = r.results.filter(x => x.error);
  const a = audit(opt);
  const parts = moved.map(x => x.id + (x.rel && x.rel !== x.id ? '(' + path.posix.basename(x.rel) + ')' : '') + ' ' + (x.moved || x.rotated || '') + (x.removed ? ' removed ' + x.removed : '') + (x.archived ? ' archived ' + x.archived : ''));
  ctx.log('RETENTION' + (ctx.dry ? ' (dry run)' : '') + ': ' + (parts.length ? parts.join(', ') : 'nothing to move') + (errs.length ? '; ERRORS: ' + errs.map(x => x.id + ': ' + x.error).join('; ').slice(0, 300) : '') + (a.ok ? '' : '; OVER BOUND: ' + a.over.map(x => x.path + ' ' + x.state).join('; ').slice(0, 300)));
  return Object.assign(r, { audit: a });
}

/* ---------------- find: search an artifact's live file and its archive ---------------- */
// `artifact` is an id (decisions, dispatch-log, handoff-archives, ...), a live path, or a file's stem (to-founder).
// Lines containing `text` (case-insensitive), the live file first, then the archive months newest first.
function find(opt, artifact, text, limit) {
  const ctx = ctxOf(opt); const pol = loadPolicy(ctx); const want = String(artifact || '').replace(/^\.\//, '');
  const rows = pol.artifacts.filter(a => ROW_POLICIES.includes(a.policy));
  let rels = [];
  const byId = rows.find(a => a.id === want);
  if (byId) rels = expandPaths(ctx, byId.path);
  else for (const a of rows) for (const rel of expandPaths(ctx, a.path)) if (rel === want || path.posix.basename(rel, path.posix.extname(rel)) === want || path.posix.basename(rel) === want) rels.push(rel);
  if (!rels.length) return { error: 'no artifact ' + JSON.stringify(want) + ' (ids: ' + rows.map(a => a.id).join(', ') + ')' };
  const needle = String(text || '').toLowerCase(); if (!needle) return { error: 'give the text to look for' };
  const max = Number(limit) > 0 ? Number(limit) : 200; const hits = []; const searched = [];
  for (const rel of rels) {
    const { dir } = archiveDirOf(rel);
    for (const f of [rel].concat(archiveFiles(ctx, rel).reverse().map(n => dir + '/' + n))) {
      let t; try { t = fs.readFileSync(ctx.P(f), 'utf8'); } catch (_) { continue; }
      searched.push(f);
      const ls = t.split('\n');
      for (let i = 0; i < ls.length && hits.length < max; i++) if (ls[i].toLowerCase().includes(needle)) hits.push({ file: f, line: i + 1, text: ls[i].length > 400 ? ls[i].slice(0, 400) + '…' : ls[i] });
    }
  }
  return { hits, searched, truncated: hits.length >= max };
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const assert = require('assert');
  const os = require('os');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-selftest-'));
  const H = path.join(T, '_home');
  const W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  const R = rel => fs.readFileSync(path.join(T, rel), 'utf8');
  for (const d of ['state']) { const src = co.p('company', 'defaults', d); if (fs.existsSync(src)) fs.cpSync(src, path.join(T, 'company', d), { recursive: true }); }
  fs.cpSync(co.p('company', 'defaults', 'work', 'ops', 'retention.json'), path.join(T, 'company', 'defaults', 'work', 'ops', 'retention.json'));
  process.env.PROVENANCE_ROOT = T;
  const P = require('./provenance.js'); P.pinUnderStation(false);
  const LW = require('./locked-watch.js');
  const now = Date.parse('2026-11-17T12:00:00Z');
  const quiet = { log: () => {} };
  const lwTick = t => LW.tick(Object.assign({ root: T, home: H, now: t || Date.now(), connectors: null, jobs: [] }, quiet));
  let fails = 0; const results = [];
  const check = async (name, fn) => { try { await fn(); results.push('ok    ' + name); } catch (e) { fails++; results.push('FAIL  ' + name + ': ' + (e && e.message || e).toString().slice(0, 400)); } };
  const opts = { root: T, home: H, now, ...quiet };
  const day = (d, hm) => '2026-' + d + ' ' + (hm || '09:00');

  // fixtures: a decisions file written newest first with tool rows appended at the bottom; a dispatch log; a clearance
  // ledger with live and spent rows; an A-class log with recorded appends; the provenance log
  const decisions = ['# Decisions', '', 'Newest first. Who decided, what, why.', '',
    '- ' + day('11-16') + ' Founder **ruled** the plan.', '  continued on a second line', '',
    '- ' + day('10-10') + ' Founder picked the vendor.', '',
    '- ' + day('09-02') + ' Founder set the name.', '',
    '| ' + day('09-03', '10:00') + ' | Competence ledger anchor: 4 events, head `sha256:' + 'a'.repeat(64) + '` (x) | Dispatcher | y |',
    '- ' + day('11-17') + ' delegation row appended by a tool (company/tools/delegation.js)', ''].join('\n');
  W('company/work/decisions.md', decisions);
  const dlog = '# Dispatch log\n\n' + ['09-01', '10-05', '11-10', '11-16', '11-17'].map((d, i) => '- ' + day(d) + ' line ' + i + (i === 1 ? ' COMPETENCE daily: anchored 4 rows, head sha256:' + 'b'.repeat(64) : '')).join('\n') + '\n';
  W('company/work/dispatch-log.md', dlog);
  const clr = [{ id: 'old-live', at: '2026-01-05T10:00:00Z', until: '2027-01-01T00:00:00Z' }, { id: 'old-spent', at: '2026-02-05T10:00:00Z', until: '2026-03-01T00:00:00Z' },
    { id: 'old-closed', at: '2026-03-05T10:00:00Z', until: '2027-01-01T00:00:00Z', closedAt: '2026-03-06T00:00:00Z' }, { id: 'new', at: '2026-11-15T10:00:00Z', until: '2026-11-16T00:00:00Z' }];
  W('company/state/external-clearances.jsonl', clr.map(r => JSON.stringify(r)).join('\n') + '\n');
  // older provenance rows (the watcher has read them all once it has a baseline)
  const pf = path.join(T, 'company/state/locked/provenance.jsonl'); fs.mkdirSync(path.dirname(pf), { recursive: true });
  fs.appendFileSync(pf, ['2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'].map(at => JSON.stringify({ at, file: 'company/x', kind: 'write', sha256: 'sha256:0', bytes: 0, writer: 'x.js' })).join('\n') + '\n');
  const pl = path.join(T, 'company/state/pacer-log.jsonl');
  W('company/state/pacer-log.jsonl', '');
  const pacerAppend = row => { const l = JSON.stringify(row) + '\n'; fs.appendFileSync(pl, l); P.appended(pl, l, 'pacer.js'); };
  pacerAppend({ at: '2026-09-10T00:00:00Z', kind: 'defer' }); pacerAppend({ at: '2026-10-11T00:00:00Z', kind: 'defer' });
  const before = {}; for (const rel of ['company/work/decisions.md', 'company/work/dispatch-log.md', 'company/state/external-clearances.jsonl', 'company/state/pacer-log.jsonl']) before[rel] = R(rel);

  let r0;
  await check('locked-watch builds its baseline, then a quiet tick', async () => {
    const b = await lwTick(); assert.ok(b.initialized, JSON.stringify(b));
    const t = await lwTick(); assert.strictEqual(t.events.length, 0, JSON.stringify(t.events));
  });
  await check('apply rolls old entries out of every row-policy file', async () => {
    r0 = apply(opts);
    const by = id => r0.results.find(x => x.id === id);
    assert.strictEqual(by('decisions').moved, 3, JSON.stringify(by('decisions')));       // 10-10 (> 30 days), 09-02, the 09-03 anchor row
    assert.strictEqual(by('dispatch-log').moved, 3, JSON.stringify(by('dispatch-log')));
    assert.strictEqual(by('external-clearances').moved, 2, JSON.stringify(by('external-clearances')));   // spent + closed; the live old row stays
    assert.strictEqual(by('pacer-log').moved, 2, JSON.stringify(by('pacer-log')));
    assert.ok(R('company/work/decisions.md').includes(POINTER_MARK) && /2026-11-16/.test(R('company/work/decisions.md')) && !/2026-10-10/.test(R('company/work/decisions.md')));
    assert.ok(R('company/state/external-clearances.jsonl').includes('"old-live"') && !R('company/state/external-clearances.jsonl').includes('"old-spent"'));
  });
  await check('roll keeps every byte: live entries + archived entries = the file before, entry for entry', async () => {
    for (const [rel, txt] of Object.entries(before)) {
      const a = loadPolicy(ctxOf(opts)).artifacts.find(x => x.path === rel);
      const ents = t => parse(a, t).filter(u => u.kind === 'entry').map(u => u.text.endsWith('\n') ? u.text : u.text + '\n');
      const { dir } = archiveDirOf(rel);
      const arch = fs.readdirSync(path.join(T, dir)).filter(f => /^\d{4}-\d{2}\./.test(f)).map(f => fs.readFileSync(path.join(T, dir, f), 'utf8')).join('');
      const got = ents(R(rel)).concat(ents(arch)).sort(); const want = ents(txt).sort();
      assert.deepStrictEqual(got, want, rel);
    }
    assert.ok(/Competence ledger anchor: 4 events/.test(fs.readFileSync(path.join(T, 'company/work/archive/decisions/index.md'), 'utf8')), 'anchor copied to the archive index');
  });
  await check('locked-watch is quiet after the roll (it rebuilds each rolled file from its archive)', async () => {
    const t = await lwTick(); assert.strictEqual(t.events.length, 0, JSON.stringify(t.events)); assert.ok(!t.flagOnly, JSON.stringify(t.notes));
  });
  await check('apply again is a no-op (idempotent)', async () => {
    const snap = Object.keys(before).map(R); const r = apply(opts);
    assert.ok(r.results.filter(x => x.id !== 'provenance').every(x => !x.moved), JSON.stringify(r.results.filter(x => x.moved)));
    assert.deepStrictEqual(Object.keys(before).map(R), snap);
  });
  await check('the provenance log rolls too, and the watcher\'s offset follows it', async () => {
    const pr = r0.results.find(x => x.id === 'provenance');
    assert.ok(pr.moved >= 2 && Number.isFinite(pr.provOffset), JSON.stringify(pr));
    assert.ok(!fs.readFileSync(pf, 'utf8').includes('2026-09-01T00:00:00Z') && fs.readFileSync(path.join(T, 'company/state/locked/archive/provenance/2026-09.jsonl'), 'utf8').includes('2026-09-01'));
    pacerAppend({ at: new Date().toISOString(), kind: 'release' });   // a recorded append after the roll is still accepted
    const t = await lwTick(); assert.strictEqual(t.events.length, 0, JSON.stringify(t.events)); assert.ok(!t.notes.some(n => /provenance log was rewritten/.test(n)), JSON.stringify(t.notes));
  });
  await check('appends after a roll and before the next tick are fine; an unrecorded append to the A log is still stripped', async () => {
    fs.appendFileSync(path.join(T, 'company/work/dispatch-log.md'), '- ' + day('11-17', '12:10') + ' after the roll\n');
    fs.appendFileSync(pl, '{"forged":1}\n');
    const t = await lwTick(); const e = t.events.find(x => x.key === 'company/state/pacer-log.jsonl');
    assert.ok(e && e.kind === 'stripped', JSON.stringify(t.events)); assert.ok(!t.events.some(x => x.key === 'company/work/dispatch-log.md'));
  });
  await check('an archive edited after a roll: the roll is not accepted (flagged), and the next apply refuses to extend it', async () => {
    W('company/work/dispatch-log.md', R('company/work/dispatch-log.md'));   // unchanged
    fs.appendFileSync(path.join(T, 'company/work/dispatch-log.md'), '- 2026-11-01 09:00 old line that will roll\n');
    await lwTick();   // the watcher has seen the line before it rolls
    const later = now + 2 * DAY; const r = apply(Object.assign({}, opts, { now: later }));
    assert.ok(r.results.find(x => x.id === 'dispatch-log').moved >= 1, JSON.stringify(r.results.find(x => x.id === 'dispatch-log')));
    const af = path.join(T, 'company/work/archive/dispatch-log/2026-11.md'); fs.writeFileSync(af, fs.readFileSync(af, 'utf8').replace('old line', 'OLD LINE'));
    const t = await lwTick(); const e = t.events.find(x => x.key === 'company/work/dispatch-log.md');
    assert.ok(e && /retention roll/.test(e.why), JSON.stringify(t));
    fs.appendFileSync(path.join(T, 'company/work/dispatch-log.md'), '- 2026-11-02 09:00 another old line\n');
    const r2 = apply(Object.assign({}, opts, { now: later }));
    assert.ok(/changed outside retention/.test(r2.results.find(x => x.id === 'dispatch-log').error || ''), JSON.stringify(r2.results.find(x => x.id === 'dispatch-log')));
  });
  await check('size-rotate: station.log past its bound is gzipped and cut back; no byte lost', async () => {
    const big = Buffer.from('x'.repeat(5000) + '\n'); W('.starnet-data/station.log', big);
    const a = { id: 'station-log', path: '.starnet-data/station.log', policy: 'size-rotate', maxBytes: 1000, keep: 2 };
    const ctx = ctxOf(opts);
    const r = sizeRotate(ctx, a, a.path); assert.strictEqual(r.rotated, big.length);
    assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(T, '.starnet-data/station.log.1.gz'))).equals(big) && fs.statSync(path.join(T, '.starnet-data/station.log')).size === 0);
    for (let i = 0; i < 3; i++) { W('.starnet-data/station.log', big); sizeRotate(ctx, a, a.path); }
    assert.ok(fs.existsSync(path.join(T, '.starnet-data/station.log.2.gz')) && !fs.existsSync(path.join(T, '.starnet-data/station.log.3.gz')), 'keeps 2');
  });
  await check('run journals: a resolved quiet one is removed, an old unresolved one is gzipped aside, a live one is untouched', async () => {
    const jd = '.starnet-data/workspaces/.run-journal/';
    const old = (now - 40 * DAY) / 1000;
    W(jd + 'a.jsonl', '{"type":"begin"}\n{"type":"resolution","payload":{}}\n'); fs.utimesSync(path.join(T, jd + 'a.jsonl'), old, old);
    W(jd + 'b.jsonl', '{"type":"begin"}\n{"type":"tool_intent"}\n'); fs.utimesSync(path.join(T, jd + 'b.jsonl'), old, old);
    W(jd + 'c.jsonl', '{"type":"begin"}\n');
    const r = runJournal(ctxOf(opts), { resolvedAfterDays: 1, keepDays: 30 }, jd.slice(0, -1));
    assert.deepStrictEqual([r.removed, r.archived], [1, 1], JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(T, jd + 'a.jsonl')) && fs.existsSync(path.join(T, jd + 'c.jsonl')) && zlib.gunzipSync(fs.readFileSync(path.join(T, '.starnet-data/run-journal-archive/b.jsonl.gz'))).toString().includes('tool_intent'));
  });
  await check('archive-dir: a long-closed commitment moves to commitments/archive/YYYY-MM/, an open one stays', async () => {
    const c = (id, state, at) => W('company/work/commitments/' + id + '.json', JSON.stringify({ id, state, createdAt: at, history: [{ at, to: state }] }));
    c('c-202609010000-aaaaaa', 'closed', '2026-09-01T00:00:00Z'); c('c-202609010000-bbbbbb', 'in_progress', '2026-09-01T00:00:00Z');
    const r = archiveDir(ctxOf(opts), { states: ['closed'], keepDays: 30 }, 'company/work/commitments');
    assert.strictEqual(r.moved, 1); assert.ok(fs.existsSync(path.join(T, 'company/work/commitments/archive/2026-09/c-202609010000-aaaaaa.json')) && fs.existsSync(path.join(T, 'company/work/commitments/c-202609010000-bbbbbb.json')));
  });
  await check('status and audit: bounds are measured; an over-bound file fails the audit', async () => {
    const s = status(opts); assert.ok(s.artifacts.find(x => x.id === 'decisions').state === 'under', JSON.stringify(s.artifacts.find(x => x.id === 'decisions')));
    const a0 = audit(opts); assert.deepStrictEqual(a0.over.map(x => x.id), ['dispatch-log'], JSON.stringify(a0.over));   // only the file whose roll was refused above
    const pol = loadPolicy(ctxOf(opts)); pol.artifacts.find(x => x.id === 'decisions').bound = { bytes: 10 };
    const a = audit(Object.assign({}, opts, { policy: pol })); assert.ok(!a.ok && a.over.some(x => x.id === 'decisions'));
  });
  await check('daily runs once per company day', async () => {
    const lines = []; const o = Object.assign({}, opts, { now: now + 3 * DAY, log: l => lines.push(l) });
    daily(o); const again = daily(o);
    assert.ok(/^RETENTION/.test(lines[0]) && again.skipped, JSON.stringify(lines));
  });
  // maxLiveBytes: a day's worth of decisions past the byte bound rolls the same day (whichever bound is hit first)
  const tnow = now + 3 * DAY;   // 2026-11-20, the day `daily` above already applied
  const pol = loadPolicy(ctxOf(opts)); pol.artifacts.find(x => x.id === 'decisions').maxLiveBytes = 3000;
  const ho = pol.artifacts.find(x => x.id === 'handoff-archives'); ho.maxLiveBytes = 4000;
  const bopts = Object.assign({}, opts, { now: tnow, policy: pol });
  const DEC = 'company/work/decisions.md';
  const insertTop = lines => { const t = R(DEC); const at = t.indexOf('\n- ') + 1; fs.writeFileSync(path.join(T, DEC), t.slice(0, at) + lines.join('\n') + '\n' + t.slice(at)); };
  const pad = 'x'.repeat(150);
  await check('maxLiveBytes: the oldest entries move the same day, the newest stay, the pointer names every archive file', async () => {
    await lwTick();
    const rows = []; for (let m = 40; m >= 1; m--) rows.push('- 2026-11-20 11:' + String(m).padStart(2, '0') + ' Founder decided thing ' + m + ' ' + pad);
    rows.splice(rows.length - 1, 0, '| 2026-11-20 11:00 | Competence ledger anchor: 7 events, head `sha256:' + 'c'.repeat(64) + '` (x) | Dispatcher | y |');
    rows.splice(rows.length - 1, 0, '| 2026-11-20 11:00 | stamped three rows ahead of the clock | Founder (own error) | y |');
    insertTop(rows); fs.appendFileSync(path.join(T, DEC), '- 2026-11-20 11:59 delegation row appended by a tool (company/tools/delegation.js)\n');
    await lwTick();
    const r = apply(bopts); const d = r.results.find(x => x.id === 'decisions');
    assert.ok(d.moved >= 20, JSON.stringify(d));
    const live = R(DEC);
    assert.ok(Buffer.byteLength(live) <= 3000, 'live ' + Buffer.byteLength(live) + ' bytes');
    assert.ok(/11:59 delegation row/.test(live) && /thing 40 /.test(live), 'the newest entries stay (top and bottom)');
    assert.ok(!/thing 1 /.test(live) && !/anchor: 7 events/.test(live) && !/Founder \*\*ruled\*\* the plan/.test(live), 'the oldest moved (11-16 before the 11-20 ones)');
    const ptr = live.split('\n').find(l => l.includes(POINTER_MARK));
    assert.ok(/2026-09\.md/.test(ptr) && /2026-10\.md/.test(ptr) && /2026-11\.md/.test(ptr) && /retention\.js find decisions/.test(ptr) && /index\.md/.test(ptr), ptr);
    assert.strictEqual(live.split('\n').filter(l => l.includes(POINTER_MARK)).length, 1, 'one pointer line');
    assert.ok(/thing 1 /.test(R('company/work/archive/decisions/2026-11.md')));
  });
  await check('maxLiveBytes: competence anchors and "(own error)" rows that rolled by size are still found (live + archive index)', async () => {
    const C = require('./competence.js'); const t = C.anchorText(path.join(T, DEC));
    assert.ok(/anchor: 7 events/.test(t) && /anchor: 4 events/.test(t), 'both anchors');
    assert.ok(/Founder \(own error\)/.test(R('company/work/archive/decisions/index.md')) && !/own error/.test(R(DEC)), 'the own-error row moved and is in the index');
  });
  await check('maxLiveBytes: locked-watch rebuilds the size roll, replaced pointer line included', async () => {
    const t = await lwTick(); assert.ok(!t.events.some(e => e.key === DEC), JSON.stringify(t.events)); assert.ok(!t.flagOnly, JSON.stringify(t.notes));
  });
  await check('find: one command greps the live file and every archive month', async () => {
    const a = find(bopts, 'decisions', 'decided thing 1 '); assert.ok(a.hits.some(h => h.file === 'company/work/archive/decisions/2026-11.md'), JSON.stringify(a));
    const b = find(bopts, 'decisions', 'decided THING 40 '); assert.ok(b.hits.some(h => h.file === DEC), JSON.stringify(b));
    const c = find(bopts, 'decisions', 'set the name'); assert.ok(c.hits.some(h => h.file === 'company/work/archive/decisions/2026-09.md'), JSON.stringify(c));
    assert.ok(find(bopts, 'nope', 'x').error);
  });
  await check('daily: after the day\'s apply, a file past maxLiveBytes rolls on the next tick; under it, nothing runs', async () => {
    const rows = []; for (let m = 30; m >= 1; m--) rows.push('- 2026-11-20 12:' + String(m).padStart(2, '0') + ' Founder decided later thing ' + m + ' ' + pad);
    insertTop(rows); await lwTick();
    const lines = []; const r = daily(Object.assign({}, bopts, { log: l => lines.push(l) }));
    assert.deepStrictEqual(r.sizeRoll, ['decisions'], JSON.stringify(r)); assert.ok(/^RETENTION \(size bound\): decisions\(decisions\.md\) \d+/.test(lines[0]), JSON.stringify(lines));
    assert.ok(Buffer.byteLength(R(DEC)) <= 3000);
    const again = daily(Object.assign({}, bopts, { log: () => {} })); assert.ok(again.skipped, JSON.stringify(again));
    const t = await lwTick(); assert.ok(!t.events.some(e => e.key === DEC), JSON.stringify(t.events));
  });
  await check('maxLiveBytes on a handoff archive (sections oldest first): the oldest sections move, find reaches them', async () => {
    const HA = 'company/work/handoffs/archive/to-founder.md';
    W(HA, '# Archive: to Founder\n\n' + Array.from({ length: 20 }, (_, i) => '## 2026-11-20 from hire.js — subject ' + i + '\n\n' + 'body '.repeat(80) + '\n\n').join(''));
    const r = apply(bopts); const d = r.results.find(x => x.rel === HA);
    assert.ok(d && d.moved > 0, JSON.stringify(r.results.filter(x => x.id === 'handoff-archives')));
    const live = R(HA); assert.ok(Buffer.byteLength(live) <= 4000 && /subject 19\n/.test(live) && !/subject 0\n/.test(live), live.slice(0, 300));
    assert.ok(/retention\.js find company\/work\/handoffs\/archive\/to-founder\.md/.test(live) && /`2026-11\.md`/.test(live), live.slice(0, 400));
    const f = find(bopts, 'to-founder', 'subject 0'); assert.ok(f.hits.some(h => h.file === 'company/work/handoffs/archive/to-founder/2026-11.md'), JSON.stringify(f));
  });
  P.pinUnderStation(null);
  for (const l of results) console.log(l);
  try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? 'retention selftest: ' + fails + ' FAILED' : 'retention selftest: all passed');
  process.exit(fails ? 1 : 0);
}

module.exports = { apply, status, audit, daily, find, overLiveBytes, parse, rollFile, sizeRotate, runJournal, archiveDir, loadPolicy, archiveDirOf, POINTER_MARK };
if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const json = a.includes('--json'); const dry = a.includes('--dry-run');
  if (cmd === 'selftest' || cmd === '--selftest') selftest().catch(e => { console.error(e); process.exit(1); });
  else if (cmd === 'status') {
    const s = status({});
    if (json) console.log(JSON.stringify(s, null, 1));
    else { console.log('retention status ' + s.at + (s.lastApply ? ' (last apply ' + s.lastApply.at + ')' : ' (never applied)')); for (const r of s.artifacts) console.log('  ' + r.id.padEnd(20) + ' ' + String(r.path).padEnd(52) + ' ' + String(r.bytes == null ? '-' : r.bytes).padStart(10) + ' B ' + String(r.rows == null ? '-' : r.rows).padStart(7) + ' rows ' + String(r.ageDays == null ? '-' : r.ageDays).padStart(4) + ' d  ' + r.state); }
  } else if (cmd === 'apply') { const r = apply({ dry, log: console.log }); console.log(JSON.stringify(r.busy ? r : r.results.map(x => { const y = Object.assign({}, x); delete y.ops; delete y.chunks; return y; }), null, 1)); process.exit(r.results && r.results.some(x => x.error) ? 1 : 0); }
  else if (cmd === 'audit') { const r = audit({}); for (const o of r.over) console.log('OVER  ' + o.path + ': ' + o.state); console.log(r.ok ? 'retention audit: every bounded artifact is inside its bound' : 'retention audit: ' + r.over.length + ' over bound'); process.exit(r.ok ? 0 : 1); }
  else if (cmd === 'find') {
    const li = a.indexOf('--limit'); const lim = li >= 0 ? a[li + 1] : null; const rest = a.slice(1).filter((x, i) => !((li >= 0 && (i + 1 === li || i + 1 === li + 1)) || x === '--json'));
    const r = find({}, rest[0], rest.slice(1).join(' '), lim);
    if (r.error) { console.error('retention find: ' + r.error); process.exit(2); }
    if (json) console.log(JSON.stringify(r, null, 1));
    else { for (const h of r.hits) console.log(h.file + ':' + h.line + ': ' + h.text); console.log('-- ' + r.hits.length + ' line(s)' + (r.truncated ? ' (first ' + r.hits.length + '; --limit N for more)' : '') + ' in ' + r.searched.length + ' file(s): ' + r.searched.join(', ')); }
    process.exit(r.hits.length ? 0 : 1);
  }
  else { console.log('usage: retention.js status [--json] | apply [--dry-run] | audit | find <artifact> <text> [--limit N] | selftest'); process.exit(2); }
}
