'use strict';
/* outbound-scrub.js — removes secrets from what is sent to a model provider that is not one of the company's own
 * subscriptions (docs/FREE-MODELS.md). ONE engine, two places: company/tools/lib/outbound-scrub.js in the framework and
 * sidecar/outbound-scrub.js on the station (StarNet patch 0022 adds it as a byte-identical copy of this file; the patch
 * test checks they are the same). Standalone on purpose: only fs and path, no company or station module.
 *
 * What it removes, in this order, each replaced by [REDACTED:<kind>]:
 *   1. the exact value of every secret the company keeps (each file in its secrets/ folder and its subfolders, up to 3
 *      levels, symlinks followed only when they resolve inside the folder; README* and *.md files are notes, not
 *      secrets: the whole content, each line but comments and lines with no letter or digit, the value of each
 *      KEY=VALUE line and each string inside a JSON file), at least minValueLen characters, also in its JSON-escaped
 *      and standalone base64 forms, longest first (kind secret-file; a file's name is never put in the marker or the
 *      counts);
 *   2. every secret FORMAT in the master list (company/tools/lib/secret-patterns.json: vendor keys, tokens, private
 *      keys, JWTs, bearer and basic credentials, cookies, password=/token= assignments, long high-entropy strings).
 * Text with nothing to remove comes back as the very same string (prompt caches keep their bytes). Values are never
 * logged or returned: a caller gets the cleaned text and counts per kind. Image and audio parts are passed through
 * unread; a base64 data URI (a string, or a file part's file_data) is decoded, and when it is text it is scrubbed and
 * encoded again (binary bytes are left as they are). A body
 * nested deeper than MAX_DEPTH is refused (throws), never sent half read.
 *
 *   const S = require('./outbound-scrub');
 *   const P = S.loadPatterns(file)                 -> compiled list (throws when the file is missing or broken)
 *   const V = S.valuesFromDir(dir, P.minValueLen)  -> [values], longest first ([] for a missing dir)
 *   const s = S.makeScrubber({ patterns: P, values: V })
 *   s.text(str, counts?) -> str'     s.body(obj, counts?) -> obj' (copy on write; the same object when nothing changed)
 *   S.total(counts) -> number      S.dirSignature(dir) -> string (changes when any file the folder feeds changes)
 */
const fs = require('fs');
const path = require('path');

const MARK = kind => '[REDACTED:' + kind + ']';
const MARK_RE = /\[REDACTED:[a-z0-9-]+\]/;
// keys whose string values are wire control, ids or signed bytes, never prose: left exactly as they are
const SKIP_KEYS = new Set(['model', 'models', 'role', 'type', 'tool_call_id', 'tool_choice', 'signature', 'encrypted_content', 'id', 'name', 'provider', 'stream', 'usage', 'cache_control', 'format', 'detail', 'mime_type', 'media_type']);
const SKIP_PART_TYPES = new Set(['image_url', 'image', 'input_image', 'input_audio']);
// only a whole, well-formed base64 data URI is bytes, not text (anything else that starts "data:" is read like any text)
const DATA_URI_RE = /^data:[\w.+-]+\/[\w.+-]+(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/]+={0,2}$/;
const CACHE_MAX = 4000, CACHE_MIN_LEN = 32, BEFORE = 40, MAX_DEPTH = 32, DIR_DEPTH = 3;
const NOTE_FILE_RE = /^readme(?:\.|$)|\.md$/i;

function compile(doc) {
  if (!doc || !Array.isArray(doc.patterns) || !doc.patterns.length) throw new Error('secret pattern list has no patterns');
  const patterns = doc.patterns.map((p, i) => {
    if (!p || typeof p.kind !== 'string' || !/^[a-z0-9-]{2,40}$/.test(p.kind) || typeof p.re !== 'string') throw new Error('secret pattern ' + i + ' is malformed');
    const flags = String(p.flags || '').replace(/g/g, '') + 'g';
    return { kind: p.kind, re: new RegExp(p.re, flags), replace: typeof p.replace === 'string' ? p.replace : null,
      minEntropy: Number(p.minEntropy) || 0, needClasses: Number(p.needClasses) || 0, notAfter: p.notAfter ? new RegExp(p.notAfter, 'i') : null,
      skipValue: p.skipValue ? new RegExp(p.skipValue, 'i') : (p.codeSafe === true && doc.skipValue ? new RegExp(doc.skipValue, 'i') : null) };
  });
  const min = Number(doc.minValueLen);
  return { version: doc.version || 1, minValueLen: Number.isInteger(min) && min >= 6 ? min : 9, patterns };
}
function loadPatterns(file) { return compile(JSON.parse(fs.readFileSync(file, 'utf8'))); }

function entropy(s) {
  const n = s.length; if (!n) return 0;
  const f = new Map(); for (const c of s) f.set(c, (f.get(c) || 0) + 1);
  let h = 0; for (const k of f.values()) { const p = k / n; h -= p * Math.log2(p); }
  return h;
}
function classes(s) { return (/[a-z]/.test(s) ? 1 : 0) + (/[A-Z]/.test(s) ? 1 : 0) + (/[0-9]/.test(s) ? 1 : 0); }

function jsonOrNull(t) { try { return JSON.parse(t); } catch (_) { return null; } }   // a secrets file that is not JSON is plain text
/* the files a secrets folder feeds: regular files, up to DIR_DEPTH levels down, a symlink only when it resolves inside the
   folder, README* and *.md left out (notes about the secrets, not secrets); [] for a missing folder */
function secretFiles(dir) {
  let rootReal; try { rootReal = fs.realpathSync(dir); } catch (_) { return []; }
  const out = [], seen = new Set();
  (function walk(d, depth) {
    let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names.sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const f = path.join(d, e.name);
      let real, st; try { real = fs.realpathSync(f); st = fs.statSync(real); } catch (_) { continue; }
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;   // a link out of the folder
      if (seen.has(real)) continue; seen.add(real);
      if (st.isDirectory()) { if (depth < DIR_DEPTH) walk(f, depth + 1); continue; }
      if (st.isFile() && !NOTE_FILE_RE.test(e.name)) out.push({ file: real, size: st.size, mtimeMs: st.mtimeMs });
    }
  })(rootReal, 1);
  return out;
}
function dirSignature(dir) { return secretFiles(dir).map(x => x.file + ':' + x.size + ':' + x.mtimeMs).join('|') || (dir + ':empty'); }
/* every value a secrets folder holds (unreadable or over-1-MB files skipped), longest first */
function valuesFromDir(dir, minLen) {
  const min = Number(minLen) || 9, out = new Set();
  const put = v => { if (v.length >= min) out.add(v); };
  const add = v => {
    if (typeof v !== 'string') return; v = v.trim();
    if (v.length < min || !/[A-Za-z0-9]/.test(v)) return;
    put(v);
    const esc = JSON.stringify(v).slice(1, -1); if (esc !== v) put(esc);                     // as it reads inside JSON text
    if (v.length <= 4096) put(Buffer.from(v, 'utf8').toString('base64').replace(/=+$/, ''));   // as a standalone base64 value
  };
  for (const { file, size } of secretFiles(dir)) {
    if (size > 1 << 20) continue;
    let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    add(txt);
    for (const line of txt.split(/\r?\n/)) {
      if (/^\s*(?:#|\/\/|;)/.test(line)) continue;   // a comment line is a note
      add(line);
      const m = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*(.*)$/.exec(line);
      if (m) add(m[1].replace(/^(["'])(.*)\1$/, '$2'));
    }
    (function walk(x, depth) { if (depth > 8) return; if (typeof x === 'string') add(x); else if (x && typeof x === 'object') for (const k of Object.keys(x)) walk(x[k], depth + 1); })(jsonOrNull(txt), 0);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function bump(counts, kind, n) { if (counts) counts[kind] = (counts[kind] || 0) + (n || 1); }
function total(counts) { return Object.values(counts || {}).reduce((t, n) => t + (Number(n) || 0), 0); }

function applyPattern(s, p, counts) {
  p.re.lastIndex = 0;
  if (!p.re.test(s)) return s;
  p.re.lastIndex = 0;
  return s.replace(p.re, function () {
    const args = Array.prototype.slice.call(arguments);
    const named = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const str = args[args.length - (named ? 2 : 1)], at = args[args.length - (named ? 3 : 2)];
    const match = args[0], groups = args.slice(1, args.length - (named ? 3 : 2));
    if (MARK_RE.test(match)) return match;
    const secret = p.replace && groups.length ? (groups.length > 1 ? String(groups[groups.length - 1] || '') : match.slice(String(groups[0] || '').length)) : match;
    if (!secret || MARK_RE.test(secret)) return match;
    if (p.minEntropy && entropy(secret) < p.minEntropy) return match;
    if (p.needClasses && classes(secret) < p.needClasses) return match;
    if (p.skipValue && p.skipValue.test(secret)) return match;
    if (p.notAfter && p.notAfter.test(str.slice(Math.max(0, at - BEFORE), at))) return match;
    bump(counts, p.kind);
    if (!p.replace) return MARK(p.kind);
    return p.replace.replace(/\$(\d)|\{R\}/g, (m, n) => (n ? String(groups[Number(n) - 1] == null ? '' : groups[Number(n) - 1]) : MARK(p.kind)));
  });
}

function makeScrubber(o) {
  o = o || {};
  const P = o.patterns || { patterns: [], minValueLen: 9 };
  const values = (o.values || []).filter(v => typeof v === 'string' && v.length >= P.minValueLen);
  const cache = new Map();
  function scrubText(s) {
    const counts = {};
    let out = s;
    for (const v of values) if (out.indexOf(v) >= 0) { const parts = out.split(v); bump(counts, 'secret-file', parts.length - 1); out = parts.join(MARK('secret-file')); }
    for (const p of P.patterns) out = applyPattern(out, p, counts);
    return { out: out === s ? s : out, counts };
  }
  function text(s, counts) {
    if (typeof s !== 'string' || !s) return s;
    let r = s.length >= CACHE_MIN_LEN ? cache.get(s) : null;
    if (!r) {
      r = scrubText(s);
      if (s.length >= CACHE_MIN_LEN) { if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); cache.set(s, r); }
    }
    if (counts) for (const k of Object.keys(r.counts)) bump(counts, k, r.counts[k]);
    return r.out;
  }
  // a file part's file_data: a text file is decoded, scrubbed and encoded again; binary bytes (a PDF, an archive) are not text
  function fileData(fd, counts) {
    const m = /^(data:[^,]*;base64,)([A-Za-z0-9+/]+={0,2})$/.exec(fd);
    if (!m) return text(fd, counts);
    const buf = Buffer.from(m[2], 'base64'), dec = buf.toString('utf8');
    if (buf.indexOf(0) >= 0 || dec.indexOf('\uFFFD') >= 0) return fd;
    const c = {}, out = text(dec, c);
    if (out === dec) return fd;
    for (const k of Object.keys(c)) bump(counts, k, c[k]);
    return m[1] + Buffer.from(out, 'utf8').toString('base64');
  }
  function body(x, counts, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) throw new Error('the request body is nested deeper than ' + MAX_DEPTH + ' levels; not sent');
    if (typeof x === 'string') return DATA_URI_RE.test(x) ? fileData(x, counts) : text(x, counts);
    if (!x || typeof x !== 'object') return x;
    if (Array.isArray(x)) {
      let copy = null;
      for (let i = 0; i < x.length; i++) { const v = body(x[i], counts, depth + 1); if (v !== x[i]) { if (!copy) copy = x.slice(); copy[i] = v; } }
      return copy || x;
    }
    if (SKIP_PART_TYPES.has(x.type)) return x;
    if (x.type === 'file' && x.file && typeof x.file === 'object') {
      const f = x.file, fd = typeof f.file_data === 'string' ? fileData(f.file_data, counts) : f.file_data;
      const fn = typeof f.filename === 'string' ? text(f.filename, counts) : f.filename;
      return fd === f.file_data && fn === f.filename ? x : Object.assign({}, x, { file: Object.assign({}, f, { file_data: fd, filename: fn }) });
    }
    let copy = null;
    for (const k of Object.keys(x)) {
      if (k === '__proto__' || SKIP_KEYS.has(k)) continue;
      const v = body(x[k], counts, depth + 1);
      if (v !== x[k]) { if (!copy) copy = Object.assign({}, x); copy[k] = v; }
    }
    return copy || x;
  }
  return { text, body: (x, counts) => body(x, counts, 0), size: () => values.length };
}

module.exports = { MARK, compile, loadPatterns, valuesFromDir, dirSignature, makeScrubber, total, entropy, _internals: { SKIP_KEYS, SKIP_PART_TYPES, DATA_URI_RE, MAX_DEPTH } };
