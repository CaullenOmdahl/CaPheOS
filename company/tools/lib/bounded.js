'use strict';
/* bounded.js — read the end of a growing file without reading all of it (docs/RETENTION.md: "any file an agent or a
 * per-tick tool reads in full must have a bound"). Used by the readers of files CaPheOS does not own (StarNet's
 * runs.jsonl) and of logs that only matter at their end (the dispatch log, decisions, the console's lists).
 *
 *   const B = require('./lib/bounded')
 *   B.tailText(file, maxBytes)                 the last maxBytes of a file, starting at a line boundary
 *   B.tailLines(file, n, { maxBytes })         the last n non-empty lines (reads backwards in 256 KB steps)
 *   B.page(file, { limit, cursor, match })     lines newest first, `limit` at a time; cursor = the byte offset the
 *                                              next page ends at (null when the start of the file was reached)
 *   B.jsonlWindow(file, { sinceMs, tsOf, maxBytes, slackMs })
 *                                              the rows of a time-ordered JSONL log newer than sinceMs, read from the
 *                                              end; stops at the first 256 KB step whose rows are all older than
 *                                              sinceMs - slackMs, or at maxBytes (then truncated:true)
 *   B.jsonlWindowText(file, sinceMs)          the same window as JSONL text (for readers that split lines themselves)
 *   B.jsonlSeek(file, targetMs, { tsOf, spanBytes })
 *                                              binary search for the region of a time-ordered JSONL log around
 *                                              targetMs; returns the parsed rows of up to spanBytes from there
 * Every function reads at most its bound; a missing file is an empty answer, never a throw.
 * Owner: the tools function.
 */
const fs = require('fs');

const STEP = 256 * 1024;
const MB = 1024 * 1024;
function sizeOf(file) { try { return fs.statSync(file).size; } catch (_) { return -1; } }
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n < len ? b.subarray(0, n) : b; }

function tailText(file, maxBytes) {
  const size = sizeOf(file); if (size <= 0) return '';
  const want = Math.min(size, Math.max(1, Number(maxBytes) || 4 * MB));
  const fd = fs.openSync(file, 'r');
  try {
    const t = readAt(fd, size - want, want).toString('utf8');
    return want < size ? t.slice(t.indexOf('\n') + 1) : t;
  } finally { fs.closeSync(fd); }
}

// lines ending at byte `end`, newest first, until `limit` matching lines or `maxBytes` read. Each line comes with the
// byte offset it starts at; the cursor of the next page is the start of the oldest line returned.
function backwards(file, { end, limit, maxBytes, match }) {
  const size = sizeOf(file); if (size <= 0) return { lines: [], cursor: null, bytes: 0 };
  let pos = Math.min(Number.isFinite(end) && end >= 0 ? end : size, size);
  const cap = Number(maxBytes) || 32 * MB; let read = 0;
  const out = []; let tail = Buffer.alloc(0);   // the start of a line whose beginning is not read yet
  const fd = fs.openSync(file, 'r');
  try {
    while (pos > 0 && out.length < limit && read < cap) {
      const len = Math.min(STEP, pos); pos -= len; read += len;
      const buf = Buffer.concat([readAt(fd, pos, len), tail]);
      let from = 0;
      if (pos > 0) { const nl = buf.indexOf(10); if (nl < 0) { tail = buf; continue; } from = nl + 1; tail = buf.subarray(0, nl); }
      else tail = Buffer.alloc(0);
      const parts = buf.subarray(from).toString('utf8').split('\n');
      const starts = []; let off = pos + from; for (const l of parts) { starts.push(off); off += Buffer.byteLength(l) + 1; }
      for (let i = parts.length - 1; i >= 0 && out.length < limit; i--) { const l = parts[i]; if (l.trim() && (!match || match(l))) out.push({ line: l, at: starts[i] }); }
    }
  } finally { fs.closeSync(fd); }
  const last = out[out.length - 1];
  const cursor = out.length >= limit ? (last && last.at > 0 ? last.at : null) : (pos > 0 ? pos + tail.length : null);
  return { lines: out, cursor, bytes: read };
}
function tailLines(file, n, opt) {
  const r = backwards(file, { limit: Math.max(1, Number(n) || 1), maxBytes: (opt && opt.maxBytes) || 8 * MB });
  return r.lines.map(x => x.line).reverse();
}
function page(file, opt) {
  const o = opt || {};
  const limit = Math.min(Math.max(1, Number(o.limit) || 50), 1000);
  const end = o.cursor == null || o.cursor === '' ? undefined : Number(o.cursor);
  const r = backwards(file, { end, limit, maxBytes: o.maxBytes || 8 * MB, match: o.match });
  return { lines: r.lines.map(x => x.line), cursor: r.cursor, more: r.cursor != null };
}

const runTs = r => Number(r && (r.endedAt || r.startedAt || r.ts)) || (r && Date.parse(r.at)) || 0;
function parseRows(text, out) { for (const l of text.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && typeof r === 'object' && !r._retention) out.push(r); } catch (_) {} } return out; }
function jsonlWindow(file, opt) {
  const o = opt || {};
  const tsOf = o.tsOf || runTs; const since = Number(o.sinceMs) || 0; const slack = o.slackMs == null ? 6 * 3600e3 : o.slackMs;
  const cap = Number(o.maxBytes) || 64 * MB;
  const size = sizeOf(file); if (size <= 0) return { rows: [], truncated: false, bytes: 0 };
  const fd = fs.openSync(file, 'r'); const chunks = []; let pos = size, read = 0, truncated = false, carry = Buffer.alloc(0);
  try {
    while (pos > 0) {
      if (read >= cap) { truncated = true; break; }
      const len = Math.min(STEP * 4, pos); pos -= len; read += len;
      const buf = Buffer.concat([readAt(fd, pos, len), carry]);
      const cut = pos > 0 ? buf.indexOf(10) : -1;
      carry = cut >= 0 ? buf.subarray(0, cut + 1) : (pos > 0 ? buf : Buffer.alloc(0));
      const body = cut >= 0 ? buf.subarray(cut + 1) : (pos > 0 ? Buffer.alloc(0) : buf);
      const rows = parseRows(body.toString('utf8'), []);
      chunks.unshift(rows);
      if (since && rows.length && rows.every(r => { const t = tsOf(r); return t && t < since - slack; })) break;
    }
    if (pos === 0 && carry.length) chunks.unshift(parseRows(carry.toString('utf8'), []));
  } finally { fs.closeSync(fd); }
  const rows = [].concat(...chunks);
  return { rows: since ? rows.filter(r => { const t = tsOf(r); return !t || t >= since - slack; }) : rows, truncated, bytes: read };
}
// the same window as text, one JSON row per line, for readers that parse lines themselves
function jsonlWindowText(file, sinceMs, opt) {
  const w = jsonlWindow(file, Object.assign({ sinceMs }, opt || {}));
  return w.rows.map(r => JSON.stringify(r)).join('\n') + (w.rows.length ? '\n' : '');
}
// rows around targetMs in a log appended in (roughly) time order: binary search on the first row after each probe
function jsonlSeek(file, targetMs, opt) {
  const o = opt || {}; const tsOf = o.tsOf || runTs; const span = Number(o.spanBytes) || 4 * MB; const back = Number(o.backMs) || 0;
  const size = sizeOf(file); if (size <= 0) return [];
  const fd = fs.openSync(file, 'r');
  try {
    const rowAt = p => {   // the first whole row starting after byte p, and where it starts
      const b = readAt(fd, p, Math.min(2 * MB, size - p)).toString('utf8');
      let i = p === 0 ? 0 : b.indexOf('\n') + 1; if (p > 0 && i === 0) return null;
      while (i < b.length) { const j = b.indexOf('\n', i); const l = b.slice(i, j < 0 ? b.length : j); try { const r = JSON.parse(l); const t = tsOf(r); if (t) return { t, at: p + Buffer.byteLength(b.slice(0, i)) }; } catch (_) {} if (j < 0) break; i = j + 1; }
      return null;
    };
    let lo = 0, hi = size;
    while (hi - lo > 64 * 1024) {
      const mid = Math.floor((lo + hi) / 2); const r = rowAt(mid);
      if (!r || r.t >= targetMs - back) hi = mid; else lo = mid;
    }
    const start = Math.max(0, lo - 64 * 1024);
    const t = readAt(fd, start, Math.min(span, size - start)).toString('utf8');
    const body = start > 0 ? t.slice(t.indexOf('\n') + 1) : t;
    return parseRows(start + span < size ? body.slice(0, body.lastIndexOf('\n') + 1) : body, []);
  } finally { fs.closeSync(fd); }
}

module.exports = { tailText, tailLines, page, jsonlWindow, jsonlWindowText, jsonlSeek, runTs, sizeOf, MB };
