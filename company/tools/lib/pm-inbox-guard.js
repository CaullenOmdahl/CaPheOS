'use strict';
/* lib/pm-inbox-guard.js — which rows of company/pm-inbox.jsonl (the owner's questions and their answers) really came from
 * who they claim. The same mechanism as the owner channel (lib/owner-channel.js), applied to the question log.
 *
 * Everyone runs as one Unix user, so any agent can append an `answer` row (the owner said yes), or a withdraw / reclassify
 * row for somebody else's question. The legitimate writers record each row in the provenance log
 * (company/tools/provenance.js) BEFORE they append it, and every reader trusts only recorded rows:
 *   OWNER rows   answer, part, secret, close, snooze: carry the owner's authority. Trusted only from an owner path: a
 *                process outside an agent's run (underStation false) whose program is the console or one of the owner's
 *                tools (OWNER_MAINS: inbox.js / approvals.js under the lib/owner.js rule, the dispatcher's approvals tick).
 *                An agent's run never writes one (append() refuses: code 3).
 *   AGENT rows   ask, withdraw, reclassify, approval-amend, and the answer that closes a request when its asker withdrew the
 *                last open question (closedBy 'withdraw'): carry the asker's authority. Trusted from a company tool
 *                (company/tools/*.js, console/server.js). withdraw / reclassify / amend must name the question's asker
 *                (`by`), and when an agent's run wrote it, the provenance row's `seat` must be the asker's seat: the
 *                writer verified the caller (inbox.js callerSeat: the station's agent id when it gives one, and the
 *                transcript check provenance.callerConflict). Outside an agent's run the owner may also withdraw.
 *   SYSTEM rows  approval-journal, approval-reminder: no authority of their own; trusted from a company tool.
 * Each row also needs a provenance row that is not tainted (no preload / eval). Readers match each line by chunk hash.
 * In a throwaway company under the OS temp dir (selftests) only the program check is relaxed; see throwaway() below.
 *
 *   const G = require('./lib/pm-inbox-guard');
 *   G.append(file, row, writer, { seat })   record, then append one row (throws code 3 for an owner row in an agent's run)
 *   G.judge({ file })                       every line with trust 'verified' | 'historic' | 'unverified' and authority
 *   G.rows({ file, gate })                  the parsed rows readers may use; gate:true = never a historic owner row and
 *                                           never an asker's own closing answer (what governance.answerOf reads)
 *   G.ensureCutover({ file })               record the cutover once (outside an agent's run)
 *
 * Existing companies: rows written before this change have no provenance. The first process outside an agent's run that
 * reads the file records a cutover row (kind 'cutover': the file's size and the hash of those bytes; the earliest wins).
 * Rows inside that prefix are 'historic': Today, the asker's list and the approvals view read them, but a historic answer
 * is NEVER a gate answer (governance.answerOf, approved, providers' endpoint approval). A prefix whose bytes changed makes
 * every historic row unverified. Unverified rows are ignored, logged once each ("unverified pm-inbox row ignored",
 * company/work/security/pm-inbox-ignored.jsonl) and raised once to the risk seat; company/tools/locked-watch.js strips them
 * from the file within a tick and keeps them in company/state/locked/quarantine/.
 * The root of a file is the folder that holds its company/ (the provenance log is <root>/company/state/locked/).
 * Not proof: a determined forger can still fake a provenance row; this makes forging take deliberate steps.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const OC = () => require('./owner-channel');
const prov = () => require('../provenance.js');

const REL = 'company/pm-inbox.jsonl';
const OWNER_TYPES = new Set(['answer', 'part', 'secret', 'close', 'snooze']);
const AGENT_TYPES = new Set(['ask', 'withdraw', 'reclassify', 'approval-amend']);
const SYSTEM_TYPES = new Set(['approval-journal', 'approval-reminder']);
const ASKER_ONLY = new Set(['withdraw', 'reclassify', 'approval-amend']);
const OWNER_MAINS = ['console/server.js', 'company/tools/inbox.js', 'company/tools/approvals.js', 'company/tools/dispatch.js', 'company/tools/dispatcher-loop.js'];
// a program's path relative to the company root. provenance.js records `main` relative to the root when the program is
// inside it, else absolute; an absolute `main` counts only when it is this checkout's own code (a fixture's tools run from
// the checkout), never a look-alike path elsewhere (/tmp/x/company/tools/a.js). Matched whole, never by suffix.
const TOOL_MAIN = /^(company\/tools\/[A-Za-z0-9._-]+\.js|console\/server\.js)$/;
const OWN_ROOT = (() => { try { return fs.realpathSync(path.resolve(__dirname, '..', '..', '..')); } catch (_) { return path.resolve(__dirname, '..', '..', '..'); } })();
function mainRel(main) {
  const m = String(main || '');
  if (!m || m === '[none]') return null;
  if (!m.startsWith('/')) return m.split('/').includes('..') ? null : m;
  return m.startsWith(OWN_ROOT + '/') ? m.slice(OWN_ROOT.length + 1) : null;
}
const WRITERS = ['inbox.js', 'approvals.js', 'governance', 'service.js', 'harness-change.js', 'console'];
const IGNORED_MSG = 'unverified pm-inbox row ignored';
const sha = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');
const low = s => String(s == null ? '' : s).trim().toLowerCase();
const first = s => low(s).split(/\s+/)[0];

function rootOf(o) {
  if (o && o.root) return path.resolve(o.root);
  const f = o && o.file ? path.resolve(o.file) : null;
  if (f && f.endsWith(path.sep + path.join('company', 'pm-inbox.jsonl'))) return path.dirname(path.dirname(f));
  return path.resolve(process.env.PROVENANCE_ROOT || co.ROOT);
}
const fileOf = o => (o && o.file) || path.join(rootOf(o), REL);
const relOf = (file, root) => { const p = path.resolve(file); return p.startsWith(root + path.sep) ? path.relative(root, p).split(path.sep).join('/') : null; };
const underStation = () => { try { return prov().underStation(); } catch (_) { return true; } };

/* which authority a row claims */
function authorityOf(r) {
  const t = r && r.type;
  if (t === 'answer' && r.closedBy === 'withdraw') return 'asker';
  if (AGENT_TYPES.has(t)) return 'asker';
  if (SYSTEM_TYPES.has(t)) return 'system';
  return 'owner';   // answer, part, secret, close, snooze, and any type nobody declared: the strictest rule
}

/* the crew of this root: seat id of a question's asker (`from`: an exact id or name, else the first name) */
function crewOf(root) { try { return co.readJson(path.join(root, 'company', 'tools', 'loops.json'), {}).agents || {}; } catch (_) { return {}; } }
function seatOfName(crew, name) {
  const n = low(name); if (!n) return null;
  for (const [id, c] of Object.entries(crew)) if (low(id) === n || (c && low(c.name) === n)) return id;
  for (const [id, c] of Object.entries(crew)) if (c && c.name && first(c.name) === first(name)) return id;
  return null;
}
const sameAsker = (by, from) => !!low(by) && (low(by) === low(from) || first(by) === first(from));
const ownerNames = root => { let n = ''; try { n = (co.readJson(path.join(root, 'company', 'company.json'), {}).owner || {}).name || ''; } catch (_) {} return ['owner', 'commander', low(n)].filter(Boolean); };

// tests only (in this process): a function deciding whether a row's program may write, instead of the tables above
let PIN = null;
function pinMains(fn) { PIN = typeof fn === 'function' ? fn : null; }
const mainOk = (p, list) => typeof p.main === 'string' && (PIN ? !!PIN(p) : (() => { const r = mainRel(p.main); return !!r && (list ? list.includes(r) : TOOL_MAIN.test(r)); })());

/* An owner card's effect (what the console applies on the owner's yes) carries owner authority, so it is kept only on an
 * ask whose provenance row names the ONE program that files that effect (lib/owner-card.js EFFECT_PRODUCERS): an ask
 * any other program recorded keeps its words but its effect becomes {none:true} (effectDropped says why). Effect kinds
 * with no producer are always dropped. In a throwaway company (selftests) only the program check is off, as above. */
function effectKindOf(e) { if (!e || typeof e !== 'object' || Array.isArray(e)) return null; const k = Object.keys(e); return k.length === 1 ? k[0] : '?'; }
function effectOk(row, p, ctx) {
  const k = effectKindOf(row && row.effect); if (!k || (k === 'none' && row.effect.none === true)) return true;
  let prod = null; try { prod = require('./owner-card').EFFECT_PRODUCERS[k]; } catch (_) { prod = undefined; }
  if (!Array.isArray(prod)) return false;   // no producer: never
  if (ctx.throwaway && !PIN) return true;
  if (!p || p.tainted === true) return false;
  const r = mainRel(p.main); return !!r && prod.includes(r);
}

/* A throwaway company under the OS temp dir (a selftest's or test.sh's copy) takes any program's write as its own tools'
 * (the selftests answer in process, some from `node -e`): there only the program check is off. Every other rule holds
 * (provenance recorded; an owner row never from an agent's run; a withdraw / reclassify only by the asker's seat). It
 * grants nothing real: the live company is never under the temp dir. A `.pm-inbox-guard-strict` file in the root keeps
 * the program check on there too (this guard's own test). */
function throwaway(root) {
  try { const t = fs.realpathSync(require('os').tmpdir()); const r = fs.realpathSync(root);
    return r.startsWith(t + path.sep) && !fs.existsSync(path.join(r, '.pm-inbox-guard-strict')); } catch (_) { return false; }
}
const progOk = (p, list, ctx) => (ctx.throwaway && !PIN) || (p.tainted !== true && mainOk(p, list));

/* may provenance row p vouch for parsed line r? ctx: { asks (id -> ask row), crew, owners, throwaway } */
function vouches(p, r, ctx) {
  if (!p || typeof p.main !== 'string') return false;
  const auth = authorityOf(r);
  if (auth === 'owner') return p.underStation === false && progOk(p, OWNER_MAINS, ctx);
  if (!progOk(p, null, ctx)) return false;
  if (auth === 'system' || r.type === 'ask') return true;
  // the asker's own act on its own question
  const q = ctx.asks[r.id];
  if (!q) return false;
  const byOwner = ctx.owners.includes(low(r.by));
  if (p.underStation === false && byOwner && r.type !== 'approval-amend') return progOk(p, OWNER_MAINS, ctx);   // the owner withdrew / reclassified it
  if (r.type !== 'answer' && !sameAsker(r.by, q.from)) return false;
  if (p.underStation !== false) { const seat = seatOfName(ctx.crew, q.from); return !!seat && p.seat === seat; }
  return true;
}

// the earliest trusted cutover row: outside an agent's run, not tainted (a throwaway company: tainted too, see above)
const cutoverOf = loose => rows => rows.filter(r => r.kind === 'cutover' && r.underStation === false && (loose || r.tainted !== true) && Number(r.bytes) >= 0)
  .sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] || null;

// the judgement of one file state, kept while the file and the provenance log are unchanged
const MEMO = new Map();
function judge(o) {
  o = o || {};
  const root = rootOf(o), file = fileOf(o), rel = relOf(file, root);
  let buf = o.buf; if (!buf) { try { buf = fs.readFileSync(file); } catch (_) { buf = Buffer.alloc(0); } }
  const lines = []; let p = 0;
  while (p < buf.length) { const nl = buf.indexOf(10, p); if (nl < 0) break; lines.push({ offset: p, bytes: nl + 1 - p, raw: buf.subarray(p, nl + 1) }); p = nl + 1; }
  if (!rel) { for (const l of lines) Object.assign(l, { sha: sha(l.raw), trust: 'unverified', why: 'the file is outside the company root' }); return { lines, cutover: null, outside: true }; }
  const provF = path.join(root, 'company', 'state', 'locked', 'provenance.jsonl');
  let ps = null; try { const s = fs.statSync(provF); ps = s.size + ':' + s.mtimeMs; } catch (_) {}
  const key = root + '|' + rel; const hash = sha(buf); const m = MEMO.get(key);
  if (!PIN && m && m.hash === hash && m.ps === ps) return m.result;
  for (const l of lines) { l.sha = sha(l.raw); try { l.row = JSON.parse(l.raw.toString('utf8')); } catch (_) { l.row = null; } if (l.row && typeof l.row !== 'object') l.row = null; }
  const ctx = { asks: {}, crew: crewOf(root), owners: ownerNames(root), throwaway: throwaway(root) };
  const { provRows } = OC()._lib; const cutoverRow = cutoverOf(ctx.throwaway);
  const pass = withArchive => {
    const rows = provRows(root, rel, withArchive);
    const cut = cutoverRow(rows);
    const avail = new Map(); for (const r of rows) if (r.kind === 'append') { const a = avail.get(r.chunkSha) || []; a.push(r); avail.set(r.chunkSha, a); }
    const histOk = !!cut && buf.length >= Number(cut.bytes) && sha(buf.subarray(0, Number(cut.bytes))) === cut.sha256;
    let missing = !cut; ctx.asks = {};
    for (const l of lines) {
      l.authority = l.row ? authorityOf(l.row) : null;
      const cands = avail.get(l.sha) || [];
      const i = l.row ? cands.findIndex(c => vouches(c, l.row, ctx)) : -1;
      if (i >= 0) { const pr = cands.splice(i, 1)[0]; l.trust = 'verified'; l.why = null; if (l.row && l.row.type === 'ask' && l.row.effect !== undefined && !effectOk(l.row, pr, ctx)) l.effectDropped = 'the card was not filed by the tool that owns this effect (' + (mainRel(pr.main) || pr.main) + ')'; }
      else if (cut && l.offset + l.bytes <= Number(cut.bytes)) { l.trust = histOk ? 'historic' : 'unverified'; l.why = histOk ? null : 'the rows before the cutover were changed'; if (l.row && l.row.type === 'ask' && l.row.effect !== undefined && !effectOk(l.row, null, ctx)) l.effectDropped = 'a card from before the provenance cutover'; }
      else {
        l.trust = 'unverified'; missing = true;
        l.why = !cut ? 'no cutover recorded yet' : cands.length && l.row && ASKER_ONLY.has(l.row.type) ? 'not written by the asker of ' + l.row.id + ' (' + ((ctx.asks[l.row.id] || {}).from || 'unknown question') + ')'
          : cands.length ? 'recorded, but not by a writer allowed for a ' + (l.row && l.row.type) + ' row (' + l.authority + ' authority)' : 'no provenance row from an allowed writer';
      }
      if (l.row && l.row.type === 'ask' && l.trust !== 'unverified' && l.row.id && !ctx.asks[l.row.id]) ctx.asks[l.row.id] = l.row;
    }
    return { cut, missing };
  };
  let r = pass(false); if (r.missing) r = pass(true);
  const result = { lines, cutover: r.cut ? { bytes: Number(r.cut.bytes), at: r.cut.at } : null };
  if (!PIN) { MEMO.clear(); MEMO.set(key, { hash, ps, result }); }
  return result;
}

function ensureCutover(o) {
  const root = rootOf(o), file = fileOf(o), rel = relOf(file, root);
  if (!rel || underStation()) return null;
  const { provRows } = OC()._lib;
  if (cutoverOf(throwaway(root))(provRows(root, rel, true))) return null;
  let buf = Buffer.alloc(0); try { buf = fs.readFileSync(file); } catch (_) {}
  try { return prov().noted(file, { kind: 'cutover', bytes: buf.length, sha256: sha(buf) }, 'pm-inbox-guard', { root }); } catch (_) { return null; }
}

/* once per row: log it and tell the risk seat (state: company/state/pm-inbox-alerts.json) */
function raise(bad, o) {
  if (!bad.length || (o && o.noAlert)) return;
  const root = rootOf(o);
  const stF = path.join(root, 'company', 'state', 'pm-inbox-alerts.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stF, 'utf8')) || {}; } catch (_) {}
  st.seen = st.seen || {};
  const fresh = bad.filter(l => !st.seen[l.sha]); if (!fresh.length) return;
  const at = new Date().toISOString();
  const what = l => (l.row && l.row.type || '?') + ' ' + (l.row && l.row.id || '?');
  try {
    const logF = path.join(root, 'company', 'work', 'security', 'pm-inbox-ignored.jsonl'); fs.mkdirSync(path.dirname(logF), { recursive: true });
    fs.appendFileSync(logF, fresh.map(l => JSON.stringify({ at, msg: IGNORED_MSG, type: l.row && l.row.type || null, id: l.row && l.row.id || null, by: l.row && l.row.by || null, offset: l.offset, sha: l.sha, why: l.why })).join('\n') + '\n');
  } catch (_) {}
  try {
    const crew = crewOf(root);
    const risk = Object.values(crew).find(c => co.holds(c, 'risk')) || Object.values(crew).find(c => co.holds(c, 'ceo')) || null;
    if (risk && /^[A-Za-z0-9_.-]+\.md$/.test(risk.inbox || '')) {
      const lp = co.localParts();
      const block = '\n## ' + lp.date + ' ' + lp.time + ' from the owner-question check (company/tools/lib/pm-inbox-guard.js) — ' + fresh.length + ' ' + IGNORED_MSG + (fresh.length > 1 ? 's' : '') + '\n' +
        '**Need:** find who appended to company/pm-inbox.jsonl outside its tools. Nothing acted on these rows: Today, the gates, approvals and the dispatcher ignore them, and company/tools/locked-watch.js moves them to company/state/locked/quarantine/.\n' +
        '**Why:** only the console and the owner\'s own tools write an answer, close or snooze (the owner\'s authority), and only the asking seat\'s own tool run writes its ask, withdraw or reclassify; a row no allowed writer recorded claims an authority it does not have.\n' +
        '**Deadline:** none\n**Status:** DONE — FYI\n**Evidence:** ' + fresh.slice(0, 10).map(l => what(l) + ' at offset ' + l.offset + ' (' + l.why + ')').join('; ') + '. Log: `company/work/security/pm-inbox-ignored.jsonl`.\n';
      const hf = path.join(root, 'company', 'work', 'handoffs', risk.inbox); fs.mkdirSync(path.dirname(hf), { recursive: true }); fs.appendFileSync(hf, block);
    }
  } catch (_) {}
  for (const l of fresh) st.seen[l.sha] = at;
  try { fs.mkdirSync(path.dirname(stF), { recursive: true }); fs.writeFileSync(stF, JSON.stringify(st, null, 1) + '\n'); } catch (_) {}
}

/* rows(): the parsed rows readers may use (verified + historic). gate:true = what may count as the owner's answer: no
 * historic owner row and no asker-written closing answer. */
function rows(o) {
  o = o || {};
  if (!o.noCutover) ensureCutover(o);
  const j = judge(o); const out = []; const bad = [];
  for (const l of j.lines) {
    if (!l.row) continue;   // junk lines were never rows
    if (l.trust === 'unverified') { bad.push(l); continue; }
    if (o.gate && l.authority === 'owner' && l.trust !== 'verified') continue;
    if (o.gate && l.row.type === 'answer' && l.authority !== 'owner') continue;
    out.push(l.effectDropped ? Object.assign({}, l.row, { effect: { none: true }, effectDropped: l.effectDropped }) : l.row);
  }
  if (!j.outside) raise(bad, o);
  return out.map(r => Object.assign({}, r));
}

/* append(): record first, then write. An owner row from an agent's run is refused (it would only be quarantined). */
function append(file, row, writer, o) {
  o = o || {};
  if (authorityOf(row) === 'owner' && underStation()) { const e = new Error('an agent\'s run does not write the owner\'s ' + row.type + ' (only the console and the owner\'s own tools do)'); e.code = 3; throw e; }
  const root = rootOf({ file, root: o.root });
  ensureCutover({ file, root });
  const line = JSON.stringify(row) + '\n';
  try { prov().appended(file, line, writer, Object.assign({ root }, o.seat ? { seat: String(o.seat) } : {})); } catch (_) {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  return row;
}

module.exports = { REL, WRITERS, OWNER_TYPES, AGENT_TYPES, SYSTEM_TYPES, OWNER_MAINS, IGNORED_MSG, authorityOf, judge, rows, append, ensureCutover, pinMains, seatOfName, rootOf, mainRel, throwaway };
