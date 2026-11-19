'use strict';
/* lib/owner-channel.js — which lines of company/owner/inbound.jsonl (owner -> company) are really the owner's words.
 *
 * Everyone runs as one Unix user, so any agent can append a line to the owner channel that claims to come from the owner.
 * The legitimate writers record each line in the provenance log (company/tools/provenance.js) BEFORE they append it:
 *   console     console/server.js, the owner typing in the console (POST /api/owner/messages)
 *   inbox.js    an answer delivered to its asker (inbox.js deliver: the console in process, the owner's CLI under the
 *               lib/owner.js rule, or the dispatcher repairing an approvals.js wake)
 *   owner-inbox.js   the owner's CLI (`owner-inbox.js say`, refused unless lib/owner.js shell())
 * A row counts only when it is an append to this file, not from an agent's run (underStation false), not tainted (no
 * preload / eval), and its program (`main`) is one the writer runs as. Readers match each line by its chunk hash.
 *
 *   const OC = require('./lib/owner-channel');
 *   OC.append(file, row, writer)      record, then append one {id, at, from, text, re?} line (skipped in an agent's run)
 *   OC.judge({ file, root })          every line with trust 'verified' | 'historic' | 'unverified' (+ offset, sha)
 *   OC.messages({ file, root, gate }) the trusted rows: verified + historic; gate:true = verified only (gate answers)
 *   OC.ensureCutover({ file, root })  record the cutover once (outside an agent's run)
 *
 * Existing companies: lines written before this change have no provenance. The first process outside an agent's run that
 * touches the channel records a cutover row (kind 'cutover': the file's size and the hash of those bytes). Lines inside that
 * prefix are 'historic': read as the owner's (the CEO's inbox, addressing, the wake) but NEVER as a gate answer; a gate
 * answer is a verified line or comes through the approvals API (inbox.js / approvals.js records). The earliest cutover row
 * wins, so a later one cannot widen history; a prefix whose bytes no longer match makes every historic line unverified.
 * Unverified lines are ignored, logged once each ("unverified owner-channel line ignored",
 * company/work/security/owner-channel-ignored.jsonl) and raised once to the risk seat; company/tools/locked-watch.js
 * strips them from the file within a tick and keeps them in company/state/locked/quarantine/.
 * Not proof: a determined forger can still fake a provenance row; this makes forging take deliberate steps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const prov = () => require('../provenance.js');

const REL = 'company/owner/inbound.jsonl';
const WRITERS = {
  console: ['console/server.js'],
  'inbox.js': ['console/server.js', 'company/tools/inbox.js', 'company/tools/approvals.js', 'company/tools/dispatch.js', 'company/tools/dispatcher-loop.js'],
  'owner-inbox.js': ['company/tools/owner-inbox.js'],
};
const IGNORED_MSG = 'unverified owner-channel line ignored';
const sha = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const rootOf = o => path.resolve((o && o.root) || process.env.PROVENANCE_ROOT || co.ROOT);
const fileOf = o => (o && o.file) || path.join(rootOf(o), REL);
const relOf = (file, root) => { const p = path.resolve(file); return p.startsWith(root + path.sep) ? path.relative(root, p).split(path.sep).join('/') : null; };
const underStation = () => { try { return prov().underStation(); } catch (_) { return true; } };

// tests only (in this process): a function deciding whether a row's program may write, instead of the WRITERS table
let PIN = null;
function pinMains(fn) { PIN = typeof fn === 'function' ? fn : null; }
function trusted(row) {
  if (!row || row.tainted === true || row.underStation !== false || typeof row.main !== 'string') return false;
  const w = String(row.writer || '').split(' ')[0];
  if (!WRITERS[w]) return false;
  if (PIN) return !!PIN(row);
  return WRITERS[w].some(m => row.main === m || row.main.endsWith('/' + m));
}

/* provenance rows for this file: the live log, then (only when needed) its archive (retention.js rolls it after 14 days) */
const CACHE = new Map();
function rowsOf(f, rel) {
  let st; try { st = fs.statSync(f); } catch (_) { return []; }
  const k = f + '|' + rel; const c = CACHE.get(k);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows;
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return []; }
  const needle = '"file":' + JSON.stringify(rel); const rows = [];
  for (const l of txt.split('\n')) { if (!l.includes(needle)) continue; try { const r = JSON.parse(l); if (r && r.file === rel) rows.push(r); } catch (_) {} }
  CACHE.set(k, { size: st.size, mtimeMs: st.mtimeMs, rows });
  return rows;
}
function provRows(root, rel, withArchive) {
  const dir = path.join(root, 'company', 'state', 'locked');
  let rows = rowsOf(path.join(dir, 'provenance.jsonl'), rel);
  if (withArchive) {
    let names = []; try { names = fs.readdirSync(path.join(dir, 'archive', 'provenance')).filter(n => n.endsWith('.jsonl')).sort(); } catch (_) {}
    rows = names.reduce((a, n) => a.concat(rowsOf(path.join(dir, 'archive', 'provenance', n), rel)), []).concat(rows);
  }
  return rows;
}
// the earliest trusted cutover row: any process outside an agent's run that is not tainted (the dispatcher, the console,
// the owner's shell)
const cutoverRow = rows => rows.filter(r => r.kind === 'cutover' && r.underStation === false && r.tainted !== true && Number(r.bytes) >= 0)
  .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;

function ensureCutover(o) {
  const root = rootOf(o), file = fileOf(o), rel = relOf(file, root);
  if (!rel || underStation()) return null;
  if (cutoverRow(provRows(root, rel, true))) return null;
  let buf = Buffer.alloc(0); try { buf = fs.readFileSync(file); } catch (_) {}
  try { return prov().noted(file, { kind: 'cutover', bytes: buf.length, sha256: sha(buf) }, 'owner-channel', { root }); } catch (_) { return null; }
}

/* judge(): every complete line of the file, in order, with its trust */
function judge(o) {
  o = o || {};
  const root = rootOf(o), file = fileOf(o), rel = relOf(file, root);
  let buf = o.buf; if (!buf) { try { buf = fs.readFileSync(file); } catch (_) { buf = Buffer.alloc(0); } }
  const lines = []; let p = 0;
  while (p < buf.length) { const nl = buf.indexOf(10, p); if (nl < 0) break; lines.push({ offset: p, bytes: nl + 1 - p, raw: buf.subarray(p, nl + 1) }); p = nl + 1; }
  for (const l of lines) l.sha = sha(l.raw);
  if (!rel) return { lines: lines.map(l => Object.assign(l, { trust: 'unverified', why: 'the file is outside the company root' })), cutover: null, outside: true };
  const pass = withArchive => {
    const rows = provRows(root, rel, withArchive);
    const cut = cutoverRow(rows);
    const avail = new Map(); for (const r of rows) if (r.kind === 'append' && trusted(r)) avail.set(r.chunkSha, (avail.get(r.chunkSha) || 0) + 1);
    const histOk = !!cut && buf.length >= Number(cut.bytes) && sha(buf.subarray(0, Number(cut.bytes))) === cut.sha256;
    let missing = !cut;
    for (const l of lines) {
      const n = avail.get(l.sha) || 0;
      if (n > 0) { avail.set(l.sha, n - 1); l.trust = 'verified'; l.why = null; continue; }
      if (cut && l.offset + l.bytes <= Number(cut.bytes)) { l.trust = histOk ? 'historic' : 'unverified'; l.why = histOk ? null : 'the lines before the cutover were changed'; continue; }
      l.trust = 'unverified'; l.why = cut ? 'no provenance row from an allowed writer' : 'no cutover recorded yet'; missing = true;
    }
    return { cut, missing };
  };
  let r = pass(false); if (r.missing) r = pass(true);
  return { lines, cutover: r.cut ? { bytes: Number(r.cut.bytes), at: r.cut.at } : null };
}

/* once per line: log it and tell the risk seat (state: company/state/owner-channel-alerts.json) */
function raise(bad, o) {
  if (!bad.length || (o && o.noAlert)) return;
  const root = rootOf(o);
  const stF = path.join(root, 'company', 'state', 'owner-channel-alerts.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stF, 'utf8')) || {}; } catch (_) {}
  st.seen = st.seen || {};
  const fresh = bad.filter(l => !st.seen[l.sha]); if (!fresh.length) return;
  const at = new Date().toISOString();
  try {
    const logF = path.join(root, 'company', 'work', 'security', 'owner-channel-ignored.jsonl'); fs.mkdirSync(path.dirname(logF), { recursive: true });
    fs.appendFileSync(logF, fresh.map(l => { let id = null; try { id = JSON.parse(l.raw.toString('utf8')).id || null; } catch (_) {} return JSON.stringify({ at, msg: IGNORED_MSG, id, offset: l.offset, sha: l.sha, why: l.why }); }).join('\n') + '\n');
  } catch (_) {}
  try {
    const crew = co.readJson(path.join(root, 'company', 'tools', 'loops.json'), {}).agents || {};
    const risk = Object.values(crew).find(c => co.holds(c, 'risk')) || Object.values(crew).find(c => co.holds(c, 'ceo')) || null;
    if (risk && /^[A-Za-z0-9_.-]+\.md$/.test(risk.inbox || '')) {
      const lp = co.localParts();
      const block = '\n## ' + lp.date + ' ' + lp.time + ' from the owner channel check (company/tools/lib/owner-channel.js) — ' + fresh.length + ' ' + IGNORED_MSG + (fresh.length > 1 ? 's' : '') + '\n' +
        '**Need:** find who appended to company/owner/inbound.jsonl outside the console. Nothing acted on these lines: the CEO, addressing, the wake and the gates ignore them, and company/tools/locked-watch.js moves them to company/state/locked/quarantine/.\n' +
        '**Why:** only the console (the owner typing) and the owner\'s own tools write the owner channel; a line no allowed writer recorded claims to be the owner without being the owner.\n' +
        '**Deadline:** none\n**Status:** DONE — FYI\n**Evidence:** ' + fresh.slice(0, 10).map(l => 'offset ' + l.offset + ' ' + l.sha.slice(0, 19) + ' (' + l.why + ')').join('; ') + '. Log: `company/work/security/owner-channel-ignored.jsonl`.\n';
      const hf = path.join(root, 'company', 'work', 'handoffs', risk.inbox); fs.mkdirSync(path.dirname(hf), { recursive: true }); require('./tool-blocks').append(hf, block, { root });
    }
  } catch (_) {}
  for (const l of fresh) st.seen[l.sha] = at;
  try { fs.mkdirSync(path.dirname(stF), { recursive: true }); fs.writeFileSync(stF, JSON.stringify(st, null, 1) + '\n'); } catch (_) {}
}

/* messages(): the parsed rows the company may read as the owner's. gate:true = verified only. */
function messages(o) {
  o = o || {};
  if (!o.noCutover) ensureCutover(o);
  const j = judge(o); const out = []; const bad = [];
  for (const l of j.lines) {
    let r = null; try { r = JSON.parse(l.raw.toString('utf8')); } catch (_) {}
    if (!r || typeof r !== 'object') continue;   // junk lines were never messages
    if (l.trust === 'unverified') { bad.push(l); continue; }
    if (o.gate && l.trust !== 'verified') continue;
    out.push(Object.assign({}, r, { trust: l.trust }));
  }
  if (!j.outside) raise(bad, o);   // a file outside the company root is nobody's owner channel: nothing to report there
  return out;
}

/* append(): record first, then write; a write from an agent's run is not made (it would only be quarantined) */
function append(file, row, writer, o) {
  if (underStation()) return Object.assign({}, row, { id: null, skipped: 'an agent run does not write the owner channel' });
  const root = rootOf(o);
  ensureCutover({ file, root });
  const line = JSON.stringify(row) + '\n';
  try { prov().appended(file, line, writer, { root }); } catch (_) {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  return row;
}

// the provenance readers, shared with lib/pm-inbox-guard.js (the same mechanism for company/pm-inbox.jsonl)
module.exports = { REL, WRITERS, IGNORED_MSG, trusted, judge, messages, append, ensureCutover, pinMains, _lib: { provRows, cutoverRow, sha } };
