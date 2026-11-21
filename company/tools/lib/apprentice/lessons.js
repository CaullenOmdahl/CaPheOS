'use strict';
/* apprentice/lessons.js — turns a finished, validated production job into a shadow task for the apprentice and scores
 * its answer with the model bench's own scorers (docs/APPRENTICE.md "How a lesson is made"). No model call, no network.
 *
 *   const L = require('./lessons')
 *   L.eligible(items, cfg, done)                 -> { take: [item], skipped: { reason: n } }
 *        items: model-rank.js analyze().items. Taken: not excluded, settled (the undo window has passed), oneShot 1
 *        (no REVISE, reopen, revert or fix-forward), hard, with a run id, not shadowed before.
 *   L.transcript(root, run, cfg, now, cache?)   -> { state: 'ok' | 'waiting' | 'none', rows, segments }
 *        the run's rows from StarNet's transcript segments (only the segments whose index time range or stream list
 *        covers the run, byte-capped). 'waiting': no segment reaches the run's end yet (transcripts are written late).
 *   L.teacherAndReads(rows, runId, cfg)          -> { teacher, files, reads, tainted }
 *        the run's last assistant message without tool calls, and what the run read (fs_read and friends, read-only
 *        shell commands on the allowlist), capped per file and in total
 *   L.facts(text, cfg)                           -> [{ label, value }]   the labelled facts of a production answer
 *   L.kindDepth({ item, sec, wake, cfg, facts }) -> { kind, depth, why } | { skip, why }
 *   L.toExpected(kind, facts)                    -> { expected, ask: [{ id, label }] } | null
 *   L.instructions(sec, facts)                   -> the job's own text, with its answer and verdict lines cut
 *   L.promptFor(unitDir, kind, instr, ask, files) -> the bench prompt (the bench's own template, no tools, one answer)
 *   await L.score(unitDir, kind, answerText, expected) -> { pass, score, detail, failure? }
 */
const fs = require('fs');
const path = require('path');

const TEMPLATES = { 1: 'templates/k1-lookup.md', 2: 'templates/k2-extract.md', 5: 'templates/k5-numbers.md' };
const SCORERS = { 1: 'scorers/exact.js', 2: 'scorers/fields-f1.js', 5: 'scorers/exact-number.js' };
const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
const toMs = v => { if (v == null || v === '') return 0; const n = Number(v); if (Number.isFinite(n)) return n; const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

/* ---------------- which items ---------------- */
function eligible(items, cfg, done) {
  const sh = (cfg && cfg.shadow) || {}, take = [], skipped = {};
  for (const it of items || []) {
    if (!it || it.excluded) { bump(skipped, 'excluded'); continue; }
    if (!it.settled) { bump(skipped, 'settling'); continue; }
    if (it.oneShot !== 1) { bump(skipped, 'not-one-shot'); continue; }
    if (!it.hard) { bump(skipped, 'reopened-or-reverted'); continue; }
    if (!it.runId) { bump(skipped, 'no-run'); continue; }
    if (sh.requirePassVerdict && !(it.verdicts || []).some(v => v && !v.fail)) { bump(skipped, 'no-pass-verdict'); continue; }
    if (done && done[it.key]) { bump(skipped, 'done'); continue; }
    take.push(it);
  }
  // oldest first: the longest-settled work goes first
  take.sort((a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0) || (a.key < b.key ? -1 : 1));
  return { take, skipped };
}

/* ---------------- the run's transcript ---------------- */
const segDir = (root, cfg) => path.join(root, (cfg && cfg.shadow && cfg.shadow.transcriptsDir) || '.starnet-data/workspaces/transcript-history-v2');
function transcript(root, run, cfg, now, cache) {
  const sh = (cfg && cfg.shadow) || {};
  const dir = segDir(root, cfg), runId = String(run && run.runId || '');
  const start = toMs(run && run.startedAt), end = toMs(run && run.endedAt) || start;
  let names = []; try { names = fs.readdirSync(dir).filter(f => /^segment-\d+\.index\.json$/.test(f)).sort(); } catch (_) {}
  const idx = [];
  for (const n of names) { try { const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); idx.push({ n, minTs: toMs(j.minTs), maxTs: toMs(j.maxTs), streams: j.streams && typeof j.streams === 'object' ? j.streams : null }); } catch (_) {} }
  const covered = idx.some(x => x.maxTs >= end);
  const tooOld = (Number(now) || Date.now()) - end > (Number(sh.maxWaitDays) || 3) * 864e5;
  if (!covered) return { state: tooOld ? 'none' : 'waiting', rows: [], segments: 0 };
  const slack = 60e3;
  let pick = run && run.streamId ? idx.filter(x => x.streams && Object.prototype.hasOwnProperty.call(x.streams, run.streamId)) : [];
  if (!pick.length) pick = idx.filter(x => x.minTs <= end + slack && x.maxTs >= start - slack);
  pick = pick.slice(-(Number(sh.maxSegments) || 8));
  const cap = Number(sh.maxSegmentBytes) || 32 * 1024 * 1024, rows = [];
  for (const x of pick) {
    const f = path.join(dir, x.n.replace(/\.index\.json$/, '.jsonl'));
    let st; try { st = fs.statSync(f); } catch (_) { continue; }
    if (st.size > cap) continue;
    // one pass reads each segment once (cache: a Map the caller keeps for the pass, at most 96 MB of text)
    const ck = f + ':' + st.size + ':' + st.mtimeMs;
    let txt = cache ? cache.get(ck) : null;
    if (txt == null) {
      try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
      if (cache) { const used = cache.bytes || 0; if (used + txt.length <= 96 * 1024 * 1024) { cache.set(ck, txt); cache.bytes = used + txt.length; } }
    }
    for (const line of txt.split('\n')) {
      if (!line || line.indexOf(runId) < 0) continue;
      let r; try { r = JSON.parse(line); } catch (_) { continue; }
      if (r && r.sourceRunId === runId) rows.push(r);
    }
  }
  return { state: rows.length ? 'ok' : 'none', rows, segments: pick.length };
}

const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && typeof p === 'object' ? (p.text || p.content || '') : String(p || ''))).join('') : c == null ? '' : String(c);
function callsOf(r) {
  let tc = r.toolCalls;
  if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch (_) { tc = null; } }
  if (!Array.isArray(tc)) tc = Array.isArray(r.tool_calls) ? r.tool_calls : [];
  return tc.filter(c => c && typeof c === 'object').map(c => {
    const fn = c.function || c; let args = fn.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
    return { id: String(c.id || ''), name: String(fn.name || c.name || ''), args: args && typeof args === 'object' ? args : {} };
  });
}
const DEF_READ_TOOLS = ['fs_read', 'fs_list', 'fs_search', 'notebook_read'];
const DEF_SHELL = ['cat', 'sed -n', 'head', 'tail', 'grep', 'rg', 'jq', 'ls', 'wc'];
function readOnlyShell(cmd, allow) {
  const c = String(cmd || '').trim();
  if (!c || c.length > 400 || /[;&<>`$\\]|\n/.test(c)) return false;   // no chaining, redirects, substitutions
  const words = allow || DEF_SHELL;
  return c.split('|').every(seg => { const s = seg.trim(); return words.some(w => s === w || s.startsWith(w + ' ')) && !/\s-i\b|--in-place/.test(s); });
}
function teacherAndReads(rows, runId, cfg) {
  const sh = (cfg && cfg.shadow) || {};
  const mine = (rows || []).filter(r => r && r.sourceRunId === runId).sort((a, b) => toMs(a.ts) - toMs(b.ts));
  const readTools = new Set(sh.readTools || DEF_READ_TOOLS);
  const calls = new Map();
  let teacher = '';
  for (const r of mine) {
    if (r.role !== 'assistant') continue;
    const cs = callsOf(r);
    for (const c of cs) if (c.id) calls.set(c.id, c);
    const t = textOf(r.content).trim();
    if (!cs.length && t) teacher = t;
  }
  const perFile = Number(sh.maxFileBytes) || 16000, total = Number(sh.maxReadBytes) || 64000;
  const files = {}; let used = 0, reads = 0, tainted = 0;
  for (const r of mine) {
    if (r.role !== 'tool') continue;
    const c = calls.get(String(r.toolCallId || r.tool_call_id || '')); if (!c) continue;
    let key = null;
    if (readTools.has(c.name)) key = String(c.args.path || c.args.file || c.args.query || c.args.pattern || c.name).slice(0, 200);
    else if (sh.shellReads !== false && c.name === 'shell_exec' && readOnlyShell(c.args.command || c.args.cmd, sh.shellAllow)) key = '$ ' + String(c.args.command || c.args.cmd).trim().slice(0, 200);
    if (!key) continue;
    let t = textOf(r.content); if (!t.trim()) continue;
    if (r.taint && r.taint !== 'none') tainted++;
    if (Buffer.byteLength(t) > perFile) t = Buffer.from(t).subarray(0, perFile).toString('utf8') + '\n[cut]';
    const n = Buffer.byteLength(t); if (used + n > total) break;
    if (files[key] != null) { if (files[key] === t) continue; key = key + ' (' + (++reads) + ')'; }
    files[key] = t; used += n; reads++;
  }
  return { teacher, files, reads, bytes: used, tainted };
}

/* ---------------- labelled facts ---------------- */
const NOT_FACT = new Set(['status', 'resolved', 'verdict', 'review', 'note', 'notes', 'id', 'item', 'pr', 'class', 'effort', 'kind', 'depth', 'from', 'to', 'need', 'why', 'next', 'next step', 'next steps', 'source', 'sources', 'files', 'file', 'path', 'link', 'see', 'by', 'when', 'done', 'summary', 'answer', 'result', 'reopened', 'cc', 'owner ask', 'ask']);
const cleanV = v => String(v || '').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim().replace(/[.;,]$/, '').trim();
const cleanL = l => String(l || '').replace(/\*\*|`|_/g, '').replace(/\s+/g, ' ').trim().replace(/[:\-–—]+$/, '').trim();
function facts(text, cfg) {
  const sh = (cfg && cfg.shadow) || {}, max = Number(sh.maxFacts) || 12, maxLen = Number(sh.maxValueLen) || 120, maxWords = Number(sh.maxFactWords) || 8;
  const out = [], seen = new Set();
  const put = (l, v) => {
    const label = cleanL(l), value = cleanV(v);
    if (!label || !value || label.length > 60 || value.length > maxLen) return;
    if (label.split(' ').length > 7 || !/[A-Za-z]/.test(label) || NOT_FACT.has(label.toLowerCase())) return;
    if (/^https?:/i.test(label) || /^(yes|no)$/i.test(label)) return;
    // a fact is short: a sentence after a colon ("My reading: the run looks fine because ...") is prose, not a fact
    if (/^(my|our|i|we|this|that|it|its|then|so|but|also|here|there|why|how|what)\b/i.test(label)) return;
    if (value.split(' ').length > maxWords) return;
    const k = label.toLowerCase(); if (seen.has(k)) return; seen.add(k);
    out.push({ label, value });
  };
  const lines = String(text || '').split(/\r?\n/);
  let fence = false;
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const raw = lines[i].trim();
    if (/^```/.test(raw)) { fence = !fence; continue; }
    if (fence || !raw || /^#/.test(raw)) continue;   // code and headings are not facts
    // a two-column table row (not the header above a separator, not the separator)
    if (/^\|.*\|$/.test(raw)) {
      if (/^\|[\s:|-]+\|$/.test(raw)) continue;
      if (lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) continue;
      const cells = raw.slice(1, -1).split('|').map(s => s.trim());
      if (cells.length === 2) put(cells[0], cells[1]);
      continue;
    }
    const s = raw.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    let m;
    if ((m = /^\*\*([^*]{1,60}?):?\*\*:?\s+(.+)$/.exec(s))) { put(m[1], m[2]); continue; }
    if ((m = /^([A-Za-z][\w ()/.'&-]{0,59}?):\s+(.+)$/.exec(s))) { put(m[1], m[2]); continue; }
    if ((m = /^([A-Za-z][\w ()/.'&-]{0,59}?)\s+[—–]\s+(.+)$/.exec(s))) { put(m[1], m[2]); continue; }
  }
  return out;
}
const CUR = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
const CODES = /^(EUR|USD|GBP|VND|JPY|AUD|CAD|CHF|SGD)$/i;
function numeric(v) {
  const m = /^\s*(EUR|USD|GBP|VND|JPY|AUD|CAD|CHF|SGD|€|\$|£)?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(EUR|USD|GBP|VND|JPY|AUD|CAD|CHF|SGD|€|\$|£|%|[A-Za-z]{1,8})?\s*$/.exec(String(v || ''));
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, '')); if (!Number.isFinite(n)) return null;
  let unit = m[1] || m[3] || null; if (unit) unit = CUR[unit] || (CODES.test(unit) ? unit.toUpperCase() : unit);
  return { n, unit, currency: !!unit && (CODES.test(unit) || /^(EUR|USD|GBP)$/.test(unit)) };
}

/* ---------------- kind and depth ---------------- */
const field = (text, name) => { const m = String(text || '').match(new RegExp('^\\*\\*' + name + ':\\*\\*\\s*(.*)$', 'mi')); return m ? m[1].replace(/[`*]/g, '').trim() : null; };
function mapKind(v, depth) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return v[depth] != null ? Number(v[depth]) : v.default != null ? Number(v.default) : null;
  return Number(v) || null;
}
function kindDepth(o) {
  const sh = (o.cfg && o.cfg.shadow) || {}, cls = (o.item && o.item.cell && o.item.cell.class) || 'general';
  const scoped = o.wake && o.wake.route && o.wake.route.scoped && typeof o.wake.route.scoped === 'object' ? o.wake.route.scoped : null;
  const dLine = field(o.sec, 'Depth'), kLine = field(o.sec, 'Kind');
  let depth = (dLine && DEPTHS.includes(dLine.toLowerCase()) ? dLine.toLowerCase() : null) || (scoped && DEPTHS.includes(scoped.depth) ? scoped.depth : null) || (sh.classDepth || {})[cls] || 'standard';
  if (cls === 'mechanical' && DEPTHS.indexOf(depth) > 1) depth = 'simple';
  const explicit = kLine && /^\d+/.test(kLine) ? Number(kLine.match(/^\d+/)[0]) : null;
  let kind = explicit || (scoped && Number(scoped.kind)) || mapKind((sh.kinds || {})[cls], depth);
  let why = explicit ? 'kind line' : scoped && scoped.kind ? 'route.scoped' : 'class ' + cls;
  const fs_ = o.facts || [];
  if (!explicit && kind != null) {
    const nums = fs_.map(f => numeric(f.value)).filter(x => x && x.unit);
    const share = fs_.length ? nums.length / fs_.length : 0;
    if (share >= (Number(sh.numericShare) || 0.6) && nums.length) { kind = 5; why += ', numbers with a unit'; }
    else if (kind === 5) { kind = fs_.length >= 2 ? 2 : 1; why += ', not numbers'; }
    else if (kind === 2 && fs_.length < 2) { kind = 1; why += ', one fact'; }
  }
  const allowK = sh.allowKinds || [1, 2, 5], allowD = sh.allowDepths || ['lookup', 'simple'];
  if (kind == null || !allowK.includes(kind)) return { skip: 'kind-out-of-scope', why: 'kind ' + kind + ' (' + why + ')' };
  if (!allowD.includes(depth)) return { skip: 'kind-out-of-scope', why: 'depth ' + depth + ' (' + why + ')' };
  return { kind, depth, why };
}

/* ---------------- expected answer, prompt, score ---------------- */
const slugKey = (s, used) => { let k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field'; let i = 2; const b = k; while (used.has(k)) k = b + '_' + (i++); used.add(k); return k; };
function toExpected(kind, fs_) {
  const list = fs_ || [];
  if (!list.length) return null;
  if (kind === 1) {
    const items = list.map((f, i) => ({ id: 'q' + (i + 1), value: f.value }));
    return { expected: { items }, ask: list.map((f, i) => ({ id: 'q' + (i + 1), label: f.label })) };
  }
  if (kind === 2) {
    const used = new Set(), fields = {}, types = {}, ask = [];
    for (const f of list) {
      const k = slugKey(f.label, used);
      fields[k] = f.value; ask.push({ id: k, label: f.label });
      const nu = numeric(f.value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(f.value)) types[k] = 'date';
      else if (nu && nu.currency) types[k] = 'money';
      else if (/^-?\d+$/.test(f.value)) types[k] = 'int';
    }
    return { expected: { fields, types }, ask };
  }
  if (kind === 5) {
    const nums = list.map(f => ({ f, x: numeric(f.value) })).filter(y => y.x && y.x.unit);
    if (!nums.length) return null;
    const by = {}; for (const y of nums) by[y.x.unit] = (by[y.x.unit] || 0) + 1;
    const unit = Object.keys(by).sort((a, b) => by[b] - by[a] || (a < b ? -1 : 1))[0];
    const used = new Set(), values = {}, ask = [];
    for (const y of nums.filter(z => z.x.unit === unit)) { const k = slugKey(y.f.label, used); values[k] = y.x.n; ask.push({ id: k, label: y.f.label }); }
    return { expected: { values, unit, precision: 2 }, ask };
  }
  return null;
}
const CUT = /^\*\*(Resolved|Status|Verdict|Review|Result|Results|Answer|Outcome|Done|Delivered|Reply|Reopened|Premerge|Finding|Findings)\b/i;
function instructions(sec, fs_) {
  const A = { norm: v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim() };
  const lines = String(sec || '').split('\n'), keep = [];
  for (const l of lines) { if (CUT.test(l.trim())) break; keep.push(l); }
  const vals = (fs_ || []).map(f => A.norm(f.value)).filter(v => v.length >= 3);
  let dropped = 0;
  const out = keep.filter(l => { const n = A.norm(l); if (vals.some(v => n.includes(v))) { dropped++; return false; } return true; });
  return { text: out.join('\n').trim().slice(0, 4000), dropped };
}
function promptFor(unitDir, kind, instr, ask, files) {
  const B = require(path.join(unitDir, 'lib', 'bench.js'));
  const head = 'A colleague gave you this job:\n"""\n' + String(instr || '').trim() + '\n"""\n\n';
  const list = (ask || []).map(a => '- ' + a.id + ': ' + a.label).join('\n');
  const body = kind === 1 ? head + 'Find these facts. Answer each by its id:\n' + list
    : kind === 2 ? head + 'Give these fields (the keys of "fields", each the value the job asked for):\n' + list
      : head + 'Work out these values (the keys of "values") and give the unit:\n' + list;
  const task = { prompt: TEMPLATES[kind], sandbox: 'none', inputs: { tools: [] } };
  return B.prompt(unitDir, task, { prompt: body, files: files || {} });
}
async function score(unitDir, kind, answerText, expected) {
  const A = require(path.join(unitDir, 'lib', 'answer.js'));
  const a = A.extract(answerText);
  if (!a.ok) return { pass: false, score: 0, failure: 'unparseable', detail: a.error };
  const sc = require(path.join(unitDir, SCORERS[kind]));
  const s = await sc.score(a.value, expected, { args: {} });
  return { pass: !!s.pass, score: Number(s.score) || 0, detail: String(s.detail || '').slice(0, 300) };
}

module.exports = { eligible, transcript, teacherAndReads, facts, numeric, kindDepth, toExpected, instructions, promptFor, score, readOnlyShell, callsOf, TEMPLATES, SCORERS, toMs };
