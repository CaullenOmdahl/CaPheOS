#!/usr/bin/env node
/* competence.js — the company's competence ledger, v1 (shadow mode). No LLM, costs $0.
 *
 * WHY: StarNet's own Lv/XP only moves on the owner's ratings, and the owner is out of the loop, so nobody's record
 * shows whether their work holds up. This keeps an append-only ledger of VERIFIED work and VERIFIED flaws, built only
 * from hard signals another person (or a gate the author did not write) produced, and derives two numbers per person
 * per skill bucket: experience (how much verified work, never undone by a small flaw in big work) and competence
 * (how often the work holds up, moves both ways). Rules in plain words: company/work/people/COMPETENCE.md.
 * SHADOW MODE: scores are computed and shown; nothing else (routing, merge depth, pay, StarNet levels) uses them.
 *
 *   node company/tools/competence.js collect [--dry-run]     # read hard signals + soft signals, append new ledger rows
 *   node company/tools/competence.js compute                 # derive scores -> company/work/people/competence.json
 *   node company/tools/competence.js show [--agent <name>]   # print the scores (one person: their events too)
 *   node company/tools/competence.js scoreboard              # write company/work/people/scoreboard.md
 *   node company/tools/competence.js verify                  # re-check the hash chain and every anchor (exit 1 on a problem)
 *   node company/tools/competence.js amend <ev_id> --by <people owner> --reason "<why>" [--severity S2] [--reach R3]
 *                                       [--caught after] [--agent <name>] [--bucket <b>] [--void | --uphold]
 *   node company/tools/competence.js daily [--ledger-only] [--force]   # the dispatcher's once-a-day job
 *   node company/tools/competence.js selftest                # offline fixtures (tests/fixtures/competence); exit 1 on a failure
 *
 * daily = collect, compute, scoreboard, serious flags (an OPEN handoff to the people owner per confirmed S0/S1, FYI to the manager),
 * the merged-without-gate audit (a collector), and the chain anchor (one row in company/work/decisions.md plus
 * company/state/competence-state.json when the head moved). --ledger-only writes only the ledger and the scoreboard
 * (no handoffs, no anchor, no state).
 * Reads the station ONLY with GET /api/runs (never the raw runs.jsonl). A run that appears in /api/runs only after an
 * earlier collect had already covered its end time is not used (the station reloads runs.jsonl on restart).
 * Writes: company/work/people/{competence-events.jsonl,competence.json,scoreboard.md},
 * company/state/{competence-state.json,competence-runs-seen.json,competence-pr-cache/}, and (daily) handoffs + one
 * decisions.md row. Exit codes: 0 ok, 1 verify/selftest failure, 2 usage or refused.
 *
 * Collector versions: every row the collector writes carries `collector: N` (policy collectorVersion). When the collector
 * changes how it reads a source, N goes up, the next collect re-reads every source under new ids, and compute scores only
 * the rows of the newest collector; older rows stay in the chain as history. Rulings carry over (they match by srcKey).
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { execFileSync } = require('child_process');

const co = require('./lib/company');

const ROOT = process.env.COMPETENCE_ROOT ? path.resolve(process.env.COMPETENCE_ROOT) : co.ROOT;
const STATION_ROOT = process.env.STARNET_PROJECT_ROOT ? path.resolve(process.env.STARNET_PROJECT_ROOT) : ROOT;   // run artifact paths are stripped of this prefix
const HOST = co.STATION_URL;
const OWNER_DIR = process.env.OWNER_DIR ? path.resolve(process.env.OWNER_DIR) : path.join(ROOT, 'company', 'owner');
const J = (...a) => path.join(ROOT, ...a);
const F = {
  ledger: J('company', 'work', 'people', 'competence-events.jsonl'),
  out: J('company', 'work', 'people', 'competence.json'),
  scoreboard: J('company', 'work', 'people', 'scoreboard.md'),
  state: J('company', 'state', 'competence-state.json'),
  runsSeen: J('company', 'state', 'competence-runs-seen.json'),
  prCache: J('company', 'state', 'competence-pr-cache'),
  lock: J('company', 'state', 'competence.lock'),
  policy: process.env.COMPETENCE_POLICY ? path.resolve(process.env.COMPETENCE_POLICY) : J('company', 'competence-policy.json'),   // override: dry-run a policy change before installing it
  loops: J('company', 'tools', 'loops.json'),
  decisions: J('company', 'work', 'decisions.md'),
  dispatchLog: J('company', 'work', 'dispatch-log.md'),
  premergeDir: J('company', 'work', 'evidence'),
  testEvidenceDir: J('company', 'work', 'engineering', 'evidence'),
  defectsDir: J('company', 'work', 'engineering', 'defects'),
  work: J('company', 'work'),
  handoffs: J('company', 'work', 'handoffs'),
  reposDir: J('company', 'repos'),
  ownerInbox: J('company', 'state', 'owner-inbox.json'),
  ownerInbound: path.join(OWNER_DIR, 'inbound.jsonl'),     // owner -> company, {id, at, from, text}
  ownerOutbound: path.join(OWNER_DIR, 'outbound.jsonl'),   // company -> owner, {id, at, from, text, re?}
};
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const SEV = ['N', 'S3', 'S2', 'S1', 'S0'], REACH = ['R1', 'R2', 'R3', 'R4'];
const CAUGHT = ['self', 'review', 'self-reported', 'after', 'owner', 'external'];
const GENESIS = 'sha256:genesis';
const COLLECT_WRITER = 'competence.js collect';
// Local times are company time (co.TZ, company/company.json), never the process time zone. The offset is looked up per
// instant, so a zone with daylight saving is right on both sides of the change.
let TZ = co.TZ, tzFmt = null;
function setTimeZone(tz) { TZ = tz || co.TZ; tzFmt = null; }
function offsetMin(ms) {
  if (!tzFmt) tzFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {}; for (const x of tzFmt.formatToParts(new Date(Number(ms)))) o[x.type] = x.value;
  const wall = Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), Number(o.hour) % 24, Number(o.minute));
  return Math.round((wall - Math.floor(Number(ms) / MIN) * MIN) / MIN);
}
// a company wall-clock time (as if it were UTC) -> the real instant
function fromWall(wallMs) { const g = wallMs - offsetMin(wallMs) * MIN; return wallMs - offsetMin(g) * MIN; }

/* ---------------- small helpers ---------------- */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const round = (x, d = 2) => Math.round((Number(x) || 0) * 10 ** d) / 10 ** d;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const z2 = n => String(n).padStart(2, '0');
const shifted = ms => new Date(Number(ms) + offsetMin(ms) * MIN);
function localDay(ms) { const d = shifted(ms); return d.getUTCFullYear() + '-' + z2(d.getUTCMonth() + 1) + '-' + z2(d.getUTCDate()); }
function localStamp(ms) { const d = shifted(ms); return localDay(ms) + ' ' + z2(d.getUTCHours()) + ':' + z2(d.getUTCMinutes()); }
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, text, 'competence.js'); } catch (_) {}   // locked-watch.js: this tool's own write
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const globCache = new Map();
function globRe(g) {
  if (globCache.has(g)) return globCache.get(g);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const r = new RegExp('^' + re + '$'); globCache.set(g, r); return r;
}
const matchAny = (p, globs) => (globs || []).some(g => globRe(g).test(p));
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); o[k] = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
    else o._.push(a);
  }
  return o;
}
// ids come from the source, so collecting twice never doubles anything; collector versions above 1 get their own ids,
// and srcKey (the version-free id) lets a ruling made on one version's row follow the source to the next
function mkId(signal, ref, agent, bucket, kind, key, ver) {
  const parts = [signal, ref, agent || '', bucket || '', kind, key || ''];
  if (Number(ver) > 1) parts.push('c' + Number(ver));
  return 'ev_' + sha256(parts.join('|')).slice(0, 16);
}

/* ---------------- policy and crew ---------------- */
function loadPolicy(file) {
  const p = readJson(file || F.policy, null);
  if (!p || !p.version) throw new Error('policy missing or unreadable: ' + rel(file || F.policy));
  return p;
}
function loadCrew(file) { return makeCrew((readJson(file || F.loops, {}) || {}).agents || {}); }
function makeCrew(agents) {
  const byName = {}, ids = new Set(Object.keys(agents));
  for (const [id, c] of Object.entries(agents)) { if (c && c.name) byName[String(c.name).toLowerCase()] = id; byName[id.toLowerCase()] = id; }
  // the people owner (seat.functions 'people', legacy hr:true) rules on events; with nobody holding it, the CEO does
  const holder = fn => (Object.entries(agents).find(([, c]) => co.holds(c, fn)) || [])[0] || null;
  const ceoId = holder('ceo') || (Object.entries(agents).find(([, c]) => c && c.manager == null) || [])[0] || null;
  return {
    agents, ids, hrId: holder('people') || ceoId, ceoId, holder,
    idOf: n => (n ? byName[String(n).trim().toLowerCase()] || null : null),
    nameOf: id => (agents[id] && agents[id].name) || id || 'unknown',
  };
}
const pts = (P, sev) => (P.severity[sev] || { points: 0 }).points;
const reachF = (P, r) => (P.reach[r] || { factor: 1 }).factor;
const caughtF = (P, c) => (P.caught[c] || { factor: 1 }).factor;
function demeritD(P, f) {
  let d = pts(P, f.severity) * reachF(P, f.reach) * caughtF(P, f.caught);
  if (f.ownUp) d *= (P.soft && P.soft.ownError && P.soft.ownError.ownUpMultiplier) || 1;
  return Math.min(P.caps.demeritPerEvent, d);
}
function bucketOf(P, p) { for (const r of P.pathBuckets) if (matchAny(p, r.match)) return r.bucket; return 'build'; }
function sizeClassOf(P, p) { for (const [k, c] of Object.entries(P.sizeClasses)) if (matchAny(p, c.match)) return k; return 'code'; }
const perLine = (P, cls) => (P.sizeClasses[cls] || { perLine: 0 }).perLine;
function sizeWeight(P, c) { const s = P.competence.sizeWeight; return clamp(s.base + s.perPoint * c, s.base, s.max); }
// files [{path, additions, deletions}] -> {lines, pts, bucket}
function sizeFiles(P, files) {
  let lines = 0, ptsSum = 0; const byBucket = {};
  for (const f of files) {
    const cls = sizeClassOf(P, f.path); const churn = (Number(f.additions) || 0) + (Number(f.deletions) || 0);
    if (cls === 'excluded') continue;
    lines += churn; ptsSum += churn * perLine(P, cls);
    const b = bucketOf(P, f.path); byBucket[b] = (byBucket[b] || 0) + churn;
  }
  let bucket = 'build';
  for (const [b, n] of Object.entries(byBucket)) if (lines > 0 && n / lines >= P.majorityShare) bucket = b;
  return { lines, pts: ptsSum, bucket };
}

/* ---------------- ledger: append-only, locked, hash-chained ---------------- */
function readLedger(file) {
  const txt = readText(file || F.ledger);
  if (!txt) return [];
  return txt.split('\n').filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch (_) { return { _bad: true, _line: i + 1 }; } });
}
function rowHash(prev, row) { const o = Object.assign({}, row); delete o.hash; return 'sha256:' + sha256(prev + '\n' + canon(o)); }
function withLock(lockFile, fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd = null;
  for (let i = 0; i < 100 && fd === null; i++) {
    try { fd = fs.openSync(lockFile, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 10 * MIN) { fs.unlinkSync(lockFile); continue; } } catch (_) {}
      sleepMs(100);
    }
  }
  if (fd === null) throw new Error('ledger is locked by another writer (' + rel(lockFile) + ')');
  try { fs.writeSync(fd, String(process.pid) + ' ' + new Date().toISOString()); return fn(); }
  finally { try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(lockFile); } catch (_) {} }
}
// append rows whose id is not already in the ledger; returns the rows actually written (.skipped: ids too big to write)
function appendRows(rows, opt) {
  const o = Object.assign({ ledger: F.ledger, lock: F.lock, dry: false }, opt || {});
  const out = []; out.skipped = [];
  if (!rows.length) return out;
  const go = () => {
    const have = readLedger(o.ledger);
    const ids = new Set(have.map(r => r.id));
    let prev = have.length ? have[have.length - 1].hash : GENESIS;
    const lines = [];
    for (const r0 of rows) {
      if (!r0 || !r0.id || ids.has(r0.id)) continue;
      const r = Object.assign({}, r0, { recordedAt: r0.recordedAt || new Date().toISOString(), prev });
      delete r.hash;
      let line = JSON.stringify(Object.assign(r, { hash: rowHash(prev, r) }));
      if (Buffer.byteLength(line) > 4000) {   // keep each line under 4 KB: trim free text first, then lists
        if (Array.isArray(r.evidence)) r.evidence = r.evidence.slice(0, 3).map(s => String(s).slice(0, 160));
        if (r.note) r.note = String(r.note).slice(0, 300);
        if (r.reason) r.reason = String(r.reason).slice(0, 600);
        if (Array.isArray(r.files)) r.files = r.files.slice(0, 40);
        delete r.hash; r.hash = rowHash(prev, r); line = JSON.stringify(r);
      }
      if (Buffer.byteLength(line) > 4000) {
        if (Array.isArray(r.files)) { r.filesCount = r.files.length; r.files = r.files.slice(0, 5); }
        if (Array.isArray(r.verifiers)) r.verifiers = r.verifiers.slice(0, 3);
        if (r.note) r.note = String(r.note).slice(0, 120);
        delete r.hash; r.hash = rowHash(prev, r); line = JSON.stringify(r);
      }
      if (Buffer.byteLength(line) > 4000) { out.skipped.push(r.id); continue; }   // never block the rest of the collect
      ids.add(r.id); prev = r.hash; out.push(r); lines.push(line);
    }
    if (lines.length && !o.dry) {
      fs.mkdirSync(path.dirname(o.ledger), { recursive: true });
      const chunk = lines.join('\n') + '\n';
      const fd = fs.openSync(o.ledger, 'a'); try { fs.writeSync(fd, chunk); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { require('./provenance.js').appended(o.ledger, chunk, 'competence.js'); } catch (_) {}
    }
    return out;
  };
  return o.dry ? go() : withLock(o.lock, go);
}
function parseAnchors(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/Competence ledger anchor: (\d+) events?, head `(sha256:[0-9a-f]{64})`/g)) out.push({ n: Number(m[1]), head: m[2] });
  return out;
}
// the dispatcher logs the daily summary, which carries the anchored head: a third copy of every anchor
function parseLogAnchors(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/anchored (\d+) rows, head (sha256:[0-9a-f]{64})/g)) out.push({ n: Number(m[1]), head: m[2] });
  return out;
}
function stateAnchorsOf(state, rows) {
  const s = state || {};
  if (Array.isArray(s.anchors) && s.anchors.length) return s.anchors.map(a => ({ n: Number(a.n) || null, head: a.head }));
  if (s.lastAnchor) { const i = (rows || []).findIndex(r => r.hash === s.lastAnchor); return [{ n: i >= 0 ? i + 1 : null, head: s.lastAnchor }]; }
  return [];
}
// tamper-EVIDENT, not tamper-proof: everyone runs as one Unix user. The chain catches an edited, removed or reordered
// row; each anchor (decisions.md, competence-state.json, the dispatch log) pins the history before it. Rewriting history
// unnoticed means recomputing the chain AND rewriting all three anchor copies. Rows after the last anchor are unpinned.
function verifyLedger(rows, decisionsText, extra) {
  const x = extra || {};
  const problems = [], warnings = []; let prev = GENESIS; const seen = new Set();
  rows.forEach((r, i) => {
    const n = i + 1;
    if (r._bad) { problems.push('line ' + n + ': not JSON'); return; }
    if (r.prev !== prev) problems.push('line ' + n + ' (' + r.id + '): prev does not match the line before — a row was removed, reordered or edited');
    const h = rowHash(r.prev, r);
    if (h !== r.hash) problems.push('line ' + n + ' (' + r.id + '): hash does not match its content — the row was edited');
    if (seen.has(r.id)) problems.push('line ' + n + ': duplicate id ' + r.id);
    seen.add(r.id); prev = r.hash;
  });
  const check = (a, where) => {
    if (a.n == null) { problems.push('the head ' + String(a.head).slice(0, 19) + '… recorded in ' + where + ' is not in the ledger — rows were removed or rewritten'); return; }
    const r = rows[a.n - 1];
    if (!r) problems.push(where + ' anchor at ' + a.n + ' events: the ledger now has only ' + rows.length + ' rows — rows were removed');
    else if (r.hash !== a.head) problems.push(where + ' anchor at ' + a.n + ' events: row ' + a.n + ' hash ' + String(r.hash).slice(0, 19) + '… differs from the anchored ' + a.head.slice(0, 19) + '… — history before the anchor was rewritten');
  };
  const anchors = parseAnchors(decisionsText);
  for (const a of anchors) check(a, 'decisions.md');
  const st = x.stateAnchors || [];
  for (const a of st) {
    check(a, 'competence-state.json');
    if (a.n != null && decisionsText != null && !anchors.some(b => b.n === a.n && b.head === a.head)) problems.push('the anchor at ' + a.n + ' events recorded in company/state/competence-state.json is missing from decisions.md — an anchor row was removed or rewritten');
  }
  for (const a of anchors) if (x.stateAnchors && !st.some(b => b.head === a.head)) warnings.push('decisions.md anchor at ' + a.n + ' events is not in competence-state.json (the state file was reset or edited)');
  const logA = parseLogAnchors(x.logText);
  for (const a of logA) check(a, 'dispatch-log.md');
  const last = [].concat(anchors, st, logA).reduce((m, a) => Math.max(m, Number(a.n) || 0), 0);
  return { ok: problems.length === 0, rows: rows.length, head: rows.length ? rows[rows.length - 1].hash : GENESIS, anchors: anchors.length, stateAnchors: st.length, logAnchors: logA.length,
    unanchored: Math.max(0, rows.length - last), problems, warnings };
}

/* ---------------- station (GET only) and git/gh ---------------- */
function stationGet(p, timeoutMs) {
  return new Promise((resolve, reject) => {
    let token = '';
    try { token = co.stationToken(); } catch (e) { return reject(e); }
    const u = new URL(HOST + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { 'x-starnet-token': token }, timeout: timeoutMs || 30000 }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end();
  });
}
async function fetchRuns() {
  const out = []; let before = '', through = '';
  for (let page = 0; page < 50; page++) {
    const q = '/api/runs?agent=*&limit=500' + (through ? '&through=' + through : '') + (before ? '&beforeRunId=' + encodeURIComponent(before) : '');
    const r = await stationGet(q);
    if (r.status !== 200) throw new Error('GET /api/runs HTTP ' + r.status);
    const j = JSON.parse(r.body);
    out.push(...(j.runs || []));
    if (!through && j.snapshotAt) through = String(j.snapshotAt);
    if (!j.nextCursor || j.nextCursor === before) break;
    before = j.nextCursor;
  }
  const seen = new Set();
  return out.filter(r => r && r.runId && !seen.has(r.runId) && seen.add(r.runId));
}
const runEnd = r => Number(r.endedAt || r.ts) || Number(r.startedAt) || 0;
const seenKey = id => String(id).slice(0, 16);
// runs that were not in the store when an earlier collect already covered their end time
function lateRuns(runs, seen, slackMs, horizonMs) {
  if (!seen || !seen.at || !seen.ids) return [];
  return (runs || []).filter(r => { const end = runEnd(r); return !seen.ids[seenKey(r.runId)] && end < seen.at - slackMs && end >= (horizonMs || 0); });
}
function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  for (const base of [STATION_ROOT, ROOT]) if (s.startsWith(base + '/')) s = s.slice(base.length + 1);
  const i = s.indexOf('/company/'); if (s.startsWith('/') && i >= 0) s = s.slice(i + 1);
  return s.replace(/^\.\//, '');
}
// index of runs: who was running when, doing what (effects are the commands; arts the files the run wrote)
function runIndex(runs) {
  const by = {};
  for (const r of runs || []) {
    const start = Number(r.startedAt) || 0, end = runEnd(r) || start;
    const eff = ((r.completionEvidence || {}).effects) || [];
    const effects = eff.map(e => String(e.target || ''));
    const arts = [...new Set((r.artifacts || []).map(a => normPath(a.path)).concat(eff.filter(e => /^fs\./.test(String(e.tool || ''))).map(e => normPath(e.target))))];
    (by[r.agentId] = by[r.agentId] || []).push({ runId: r.runId, agentId: r.agentId, start, end, effects, arts, model: r.model || null, provider: r.provider || null });
  }
  const test = (re, t) => (typeof re === 'function' ? re(t) : re.test(t));
  const covering = (agentId, ms, before, after) => (by[agentId] || []).filter(x => x.start - before <= ms && ms <= x.end + (after == null ? before : after));
  const api = {
    by, covering,
    // a run by agentId around time ms with an effect matching re (a RegExp or a function); re is required
    find(agentId, ms, slack, re, after) { return covering(agentId, ms, slack, after).find(x => x.effects.some(t => test(re, t))) || null; },
    findAny(ms, slack, re, after, ids) { for (const a of Object.keys(by)) { if (ids && !ids.has(a)) continue; const x = api.find(a, ms, slack, re, after); if (x) return x; } return null; },
    // a run by agentId that wrote file, optionally starting at or before ms
    wrote(agentId, file, beforeMs, earliest) { const f = normPath(file); return (by[agentId] || []).filter(x => x.arts.includes(f) && (!beforeMs || x.start <= beforeMs)).sort((a, b) => (earliest ? a.end - b.end : b.end - a.end))[0] || null; },
    wroteAround(agentId, file, ms, slack) { const f = normPath(file); return (by[agentId] || []).find(x => x.arts.includes(f) && x.start - slack <= ms && ms <= x.end + slack) || null; },
    writers(file) { const f = normPath(file); return Object.keys(by).filter(a => by[a].some(x => x.arts.includes(f))); },
  };
  return api;
}
function sh(cmd, argv, opt) { return execFileSync(cmd, argv, Object.assign({ encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }, opt || {})).trim(); }
const git = (dir, argv) => sh('git', ['-C', dir].concat(argv), { timeout: 30000 });
const gh = argv => sh('gh', argv);
function repos() {
  let names = []; try { names = fs.readdirSync(F.reposDir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(F.reposDir, n);
    try {
      if (!fs.existsSync(path.join(dir, '.git'))) continue;
      const url = git(dir, ['remote', 'get-url', 'origin']);
      const m = url.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/);
      if (m) out.push({ dir, slug: m[1], name: m[1].split('/')[1] });
    } catch (_) {}
  }
  return out;
}

/* ---------------- parsers and matchers (exported for selftest) ---------------- */
const APPROVE_ISH = /^(APPROVE|APPROVED|APPROVE WITH COMMENTS|APPROVE WITH CHANGES|NO OBJECTION|PASS)$/;
const VERDICT_WORDS = /\b(REQUEST CHANGES|CHANGES REQUESTED|APPROVE WITH CHANGES|APPROVE WITH COMMENTS|APPROVED|APPROVE|NO OBJECTION|REJECTED|REJECT|BLOCKED|PASS|FAIL)\b/;
const NEG_WORDS = /\b(REQUEST CHANGES|CHANGES REQUESTED|REJECTED|REJECT|BLOCKED|FAIL)\b/;
const NOT_APPROVING = /\bnot\s+(?:yet\s+)?approv(?:e|ed|ing)\b|\b(?:do|does|can|will)\s*(?:not|n't)\s+approve\b/i;
// {word, line}: a VERDICT/OVERALL line wins, then "Reviewer: Name — VERDICT"; with neither, a negative anywhere beats an
// approval, and a bare PASS ("tests PASS") is not a review verdict
function findVerdict(text) {
  const t = String(text || ''); const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t#>*_]*(OVERALL|VERDICT|Verdict|Overall)\b/.test(lines[i])) continue;
    if (NOT_APPROVING.test(lines[i])) return { word: 'REQUEST CHANGES', line: lines[i] };
    const m = lines[i].match(VERDICT_WORDS); if (m) return { word: m[1], line: lines[i] };
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      if (!lines[k].trim()) continue;
      if (NOT_APPROVING.test(lines[k])) return { word: 'REQUEST CHANGES', line: lines[k] };
      const n = lines[k].match(VERDICT_WORDS); if (n) return { word: n[1], line: lines[i] + '\n' + lines[k] };
      break;
    }
  }
  const rl = t.match(/Reviewer:\s*[A-Za-z][\w-]*\s*[—–-]+\s*\**\s*(REQUEST CHANGES|APPROVE WITH CHANGES|APPROVE WITH COMMENTS|APPROVED|APPROVE|NO OBJECTION|PASS|FAIL)\b[^\n]*/);
  if (rl) return { word: rl[1], line: rl[0] };
  const neg = t.match(NEG_WORDS);
  if (neg) return { word: neg[1], line: null };
  if (NOT_APPROVING.test(t)) return { word: 'REQUEST CHANGES', line: null };
  const ap = t.match(/\b(APPROVE WITH CHANGES|APPROVE WITH COMMENTS|APPROVED|APPROVE|NO OBJECTION)\b/);
  return { word: ap ? ap[1] : null, line: null };
}
function verdictOf(text) { return findVerdict(text).word; }
function reviewerNameOf(text) {
  const t = String(text || '');
  const m = t.match(/Reviewer:\s*\**\s*([A-Z][a-z][A-Za-z0-9_-]*)/) || t.match(/review\s*(?:—|-|:)\s*([A-Z][a-z]+)\b/) || t.match(/Answered:\**[^\n]*?\bby\s+([A-Z][a-z]+)/)
    || t.match(/^_([A-Z][a-z]+)\s*\(/m) || t.match(/—\s*([A-Z][a-z]+)\s*\(/);
  return m ? m[1] : null;
}
// a declared scope: "Scope:", "Doc reviewed:", "Reviewed against <file>", "Page re-read:", "Code read …:", a "What I verified" section, or "scope: …"
const SCOPE_LINE = /(?:^|[.;]\s+)[ \t>*_]*(?:Scope\**\s*[:.]|Doc reviewed\**\s*:|Reviewed against\s+\S|Page re-read\**\s*:|Code read[^:\n]*:)|\bscope:\s*\S|^#+\s*(?:\d+\.\s*)?What I verified\b/im;
function parseFindings(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    let m = line.match(/^\|\s*\**([A-Z]\d+[a-z]?)\**\s*\|\s*\**(S[0-3])\**\s*\|/);
    if (m) { const r = (line.match(/\b(R[1-4])\b/) || [])[1]; out.push({ id: m[1], severity: m[2], reach: r || null }); continue; }
    m = line.match(/^\s*(?:[-*]\s+|#+\s*)\**([A-Z]\d+[a-z]?)\s*\(([^)]*)\)/);
    if (m) { const s = (m[2].match(/\b(S[0-3])\b/) || [])[1]; if (s) out.push({ id: m[1], severity: s, reach: (m[2].match(/\b(R[1-4])\b/) || [])[1] || null }); }
  }
  const seen = new Set(); return out.filter(f => !seen.has(f.id) && seen.add(f.id));
}
// lines of the document a scope covers: "lines 30-42", or "§7" sections (heading to the next heading of the same level);
// a named section that cannot be found counts as an average top-level section. null = the scope names no part.
function sectionLines(docText, scopeText) {
  const s = String(scopeText || '');
  const lines = String(docText || '').split('\n');
  const lr = [...s.matchAll(/\blines?\s+(\d+)\s*[–-]\s*(\d+)/gi)];
  if (lr.length) return lr.reduce((n, m) => n + Math.max(0, Number(m[2]) - Number(m[1]) + 1), 0);
  const secs = [...new Set([...s.matchAll(/§\s*(\d+(?:\.\d+)*)/g)].map(m => m[1]))];
  if (!secs.length) return null;
  const tops = Math.max(1, lines.filter(l => /^##\s/.test(l)).length);
  let total = 0;
  for (const sec of secs) {
    const re = new RegExp('^(#+)\\s*(?:§\\s*)?' + escRe(sec) + '(?:[.):\\s]|$)');
    const i = lines.findIndex(l => re.test(l));
    if (i < 0) { total += Math.round(lines.length / tops); continue; }
    const level = lines[i].match(/^#+/)[0].length;
    let j = i + 1;
    while (j < lines.length && !(/^#+\s/.test(lines[j]) && lines[j].match(/^#+/)[0].length <= level)) j++;
    total += j - i;
  }
  return total;
}
function parseVerdictFile(text) {
  const t = String(text || '');
  const lines = t.split('\n');
  const scopeLines = lines.filter(l => SCOPE_LINE.test(l));
  const scopeText = scopeLines.join('\n');
  const requester = ((t.match(/Asked by:\**\s*([A-Z][a-z]+)/) || t.match(/Answers:?[^\n]*?\bfrom\s+([A-Z][a-z]+)/) || t.match(/Answers:?\s+([A-Z][a-z]+)'s\b/) || [])[1]) || null;
  const commits = [...new Set((scopeText.match(/\b[0-9a-f]{7,40}\b/g) || []))];
  const files = [...new Set([...scopeText.matchAll(/`([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,6})`/g)].map(m => m[1]))];
  const declaredLines = Number((scopeText.match(/\((\d+)\s+lines/) || [])[1]) || null;
  const head = lines.slice(0, 12).join('\n');
  const cls = head.match(/\bseverity\b[^\n.]{0,24}?`?(S[0-3])\b/i);
  // what the verdict is ABOUT comes from its title only; evidence it cites further down is not its subject
  const title = lines.find(l => /^#\s/.test(l)) || '';
  const fv = findVerdict(t);
  const vline = fv.line || '';
  const blocking = /\bblocking\b/i.test(vline.replace(/\bnon[- ]?blocking\b/gi, '')) && !/\b(?:no|zero|0|none)\s+blocking\b/i.test(vline);
  return {
    reviewer: reviewerNameOf(t), requester, verdict: fv.word, verdictLine: vline.slice(0, 200), blocking, scopeDeclared: scopeLines.length > 0, scopeText: scopeText.slice(0, 400),
    commits, files, declaredLines, classification: cls ? cls[1] : null, findings: parseFindings(t), title: title.slice(0, 200),
    subject: {
      ids: [...new Set(title.match(/\b[A-Z]{2,4}-\d{3}\b/g) || [])],
      issues: [...new Set([...title.matchAll(/(?:issue\s*#|issues\/)(\d{2,6})/gi)].map(m => Number(m[1])))],
      files: [...new Set([...title.matchAll(/(company\/work\/engineering\/defects\/[A-Za-z0-9_.-]+\.md)/g)].map(m => m[1]))],
    },
  };
}
function parseDefect(text) {
  const t = String(text || '');
  const id = (t.match(/^#\s*Defect\s+([A-Z]+-\d+)/m) || [])[1] || null;
  const finder = (t.match(/\*\*Found by:\*\*\s*([A-Z][a-z]+)/) || [])[1] || null;
  const severity = (t.match(/\*\*Severity:\*\*\s*\**\s*(S[0-3])\b/) || [])[1] || null;
  const reach = (t.match(/\*\*Reach:\*\*\s*\**\s*(R[1-4])\b/) || [])[1] || null;
  const fixOwner = (t.match(/\*\*Owner of the fix:\*\*\s*([A-Z][a-z]+)/) || [])[1] || null;
  const issue = Number((t.match(/issues\/(\d+)/) || [])[1]) || null;
  const build = (t.match(/\*\*Build:\*\*[^\n]*?\b([0-9a-f]{7,40})\b/) || [])[1] || null;
  const introducedBy = (t.match(/\*\*Introduced by:\*\*\s*`?([^\s`]+)/) || [])[1] || null;
  const date = (t.match(/\*\*Found by:\*\*[^\n]*?(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  const refs = [];
  for (const m of t.matchAll(/`([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]{1,6}):(\d+)(?:\s*[–-]\s*(\d+))?`/g)) refs.push({ path: m[1].replace(/^company\/repos\/[^/]+\//, ''), from: Number(m[2]), to: Number(m[3] || m[2]) });
  return { id, finder, severity, reach, fixOwner, issue, build, introducedBy, date, refs };
}
// "(own error)" in the Owner column of company/work/decisions.md: [{line, at, names:[...], text}]
function parseOwnErrors(text) {
  const out = []; const lines = String(text || '').split('\n');
  lines.forEach((l, i) => {
    if (!l.startsWith('|')) return;
    const cells = l.split('|').map(s => s.trim());
    if (cells.length < 5) return;
    const owner = cells[3] || '';
    const ms = [...owner.matchAll(/([A-Z][a-z]+)\s*\(own error\)/g)];
    if (!ms.length) return;
    const d = cells[1].match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
    if (!d) return;
    // decisions.md times are company local time (co.TZ), whatever the process time zone is
    const at = fromWall(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), d[4] ? Number(d[4]) : 12, d[5] ? Number(d[5]) : 0));
    const full = cells[2].replace(/\*\*/g, '');
    out.push({ line: i + 1, at, date: d[0], names: ms.map(m => m[1]), text: full.slice(0, 200), hash: sha256(full).slice(0, 12),
      msgTimes: [...new Set([...full.matchAll(/\b(\d{1,2}:\d{2}) message\b/g)].map(m => m[1].padStart(5, '0')))] });   // "His 16:33 message": the owner messages it answers
  });
  return out;
}
// a test-substrate record is a hard signal only if it predates the merge, passed, ran on a clean tree, and every
// required lane ran more than 0 cases (D1's "0\n0" record fails this). opt.ctimeMs: the file must not have changed
// after the merge (a typed ranAt is not proof)
function laneCases(o) {
  if (o == null) return 0;
  if (typeof o === 'number') return 0;
  if (Array.isArray(o)) return o.reduce((s, x) => s + laneCases(x), 0);
  if (typeof o !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if ((k === 'cases' || k === 'pass') && typeof v === 'number' && Number.isFinite(v)) n += v;
    else if (v && typeof v === 'object') n += laneCases(v);
  }
  return n;
}
function testRecordSignal(rec, mergedMs, opt) {
  const o = opt || {};
  if (!rec || typeof rec !== 'object') return { ok: false, why: 'no record' };
  const ran = Date.parse(rec.ranAt || rec.at || '');
  if (!Number.isFinite(ran)) return { ok: false, why: 'record has no ranAt' };
  if (!(ran < mergedMs)) return { ok: false, why: 'record written after the merge (' + (rec.ranAt || rec.at) + ')' };
  if (o.ctimeMs != null && o.ctimeMs > mergedMs + MIN) return { ok: false, why: 'record file last changed after the merge (' + iso(o.ctimeMs) + '), so its ranAt is not proof' };
  if (String(rec.verdict || '').toUpperCase() !== 'PASS') return { ok: false, why: 'verdict ' + rec.verdict };
  if (rec.dirty_files !== undefined && Number(rec.dirty_files) !== 0) return { ok: false, why: 'dirty tree' };
  const req = String(rec.required_lanes || Object.keys(rec.lanes || {}).join(',')).split(',').map(s => s.trim()).filter(Boolean);
  if (!req.length) return { ok: false, why: 'no lanes' };
  const cases = {};
  for (const l of req) { cases[l] = laneCases((rec.lanes || {})[l]); if (!(cases[l] > 0)) return { ok: false, why: 'lane ' + l + ' ran 0 cases', cases }; }
  return { ok: true, cases, ranAt: rec.ranAt || rec.at, command: rec.command || '' };
}
// the run that ran the record's test script when the record says it ran (a background run may finish up to `hours` later)
function testRecordRun(RI, rec, mergedMs, opt) {
  const o = opt || {};
  const script = (String((rec && rec.command) || '').match(/([A-Za-z0-9_.-]+\.(?:sh|js|mjs|cjs|py|ts))\b/) || [])[1];
  const ran = Date.parse((rec && (rec.ranAt || rec.at)) || '');
  if (!script || !Number.isFinite(ran)) return null;
  const after = (o.hours == null ? 2 : o.hours) * HOUR, slack = o.slack == null ? 10 * MIN : o.slack;
  for (const [agent, list] of Object.entries(RI.by)) {
    if (o.ids && !o.ids.has(agent)) continue;
    const x = list.find(r => r.start - slack <= ran && ran <= r.end + after && r.start < mergedMs && r.effects.some(t => t.includes(script)));
    if (x) return x;
  }
  return null;
}
function fullSubject(c) {
  let s = String(c.messageHeadline || ''), b = String(c.messageBody || '');
  if (s.endsWith('…') && b.startsWith('…')) { s = s.slice(0, -1) + b.split('\n')[0].slice(1); b = b.split('\n').slice(1).join('\n'); }
  return { subject: s, body: b };
}
function commitAuthorName(c, prAuthor) {
  const { subject, body } = fullSubject(c);
  const m = subject.match(/\(([A-Z][a-z]+)\)(?:\s*\(#\d+\))*\s*$/) || subject.match(/\(([A-Z][a-z]+)\)\s*[—–-]/);
  if (m) return m[1];
  const t = body.match(/^Author:\s*([A-Z][A-Za-z0-9_-]*)/m); if (t) return t[1];
  return prAuthor || null;
}
function prAuthorName(body) {
  const b = String(body || '');
  return ((b.match(/^[ \t>*_]*Author[ \t*_]*[:—–-][ \t*_]*([A-Z][A-Za-z0-9_-]*)/im) || [])[1]) || ((b.match(/^[ \t>*_]*Author[ \t*_]+([A-Z][A-Za-z0-9_-]*)\b/m) || [])[1]) || null;
}
// an author counts only if THEIR run made THIS commit: a git commit/cherry-pick/revert/am/merge/push or a
// gh pr create whose command names the commit's subject, one of the files it changed, or the PR's head branch
const MAKES_COMMIT = /\bgit\b[^\n]*?\b(commit|cherry-pick|revert|am|merge|push)\b|\bgh\s+pr\s+create\b/;
const normCmd = s => String(s || '').replace(/['"\\`]/g, '').replace(/\s+/g, ' ');
function subjectNeedle(subject) {
  let t = String(subject || '').trim();
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\((?:[A-Z][a-z]+|#\d+)\)\s*$/, '').trim();
  return t.length > 24 ? t.slice(0, 24) : (t.length >= 8 ? t : null);
}
function commitNeedles(subject, paths, headRef) {
  const out = [subjectNeedle(subject)];
  if (headRef && String(headRef).length >= 6) out.push(String(headRef));
  for (const p of paths || []) { if (!p) continue; out.push(p); const b = path.posix.basename(p); if (b.length >= 8 && b.includes('.')) out.push(b); }
  return out.filter(Boolean);
}
function commitEffect(t, needles) {
  if (!MAKES_COMMIT.test(t)) return false;
  const n = normCmd(t);
  return (needles || []).some(x => x && n.includes(normCmd(x)));
}
// `gh pr <verb> ... N` for PR number N (also `#N` and .../pull/N), in the given repo when the command names one
function ghPrCmd(t, verbs, n, slug) {
  for (const m of String(t || '').matchAll(new RegExp('\\bgh\\s+pr\\s+(?:' + verbs + ')\\b([^\\n|;&]*)', 'g'))) {
    const rest = m[1];
    if (!new RegExp('(?:^|[\\s#/=])' + Number(n) + '(?=$|[\\s"\'):])').test(rest)) continue;
    const r = rest.match(/(?:--repo|-R)[\s=]+([\w.-]+\/[\w.-]+)/);
    if (slug && r && r[1].toLowerCase() !== String(slug).toLowerCase()) continue;
    return true;
  }
  return false;
}
// a premerge PASS that counts for a merge: the latest PASS (current verdict or history) at or before the merge
function gatePassFor(rec, mergedMs) {
  if (!rec) return null;
  const entries = [{ verdict: rec.verdict, at: rec.at }].concat(Array.isArray(rec.history) ? rec.history : []);
  return entries.filter(e => e && String(e.verdict).toUpperCase() === 'PASS' && Date.parse(e.at) <= mergedMs).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] || null;
}
// an amendment counts only if the amender's own run ran `competence.js amend <target>` with the same changes
function amendMatches(r, text, crew) {
  const t = normCmd(text);
  if (!/competence\.js\b/.test(t) || !new RegExp('\\bamend ' + escRe(r.target) + '\\b').test(t)) return false;
  const ch = r.changes || {};
  const need = [];
  if (ch.void) need.push(/--void\b/);
  if (ch.uphold) need.push(/--uphold\b/);
  for (const k of ['severity', 'reach', 'caught', 'bucket']) if (ch[k] !== undefined) need.push(new RegExp('--' + k + '[ =]' + escRe(ch[k]) + '\\b'));
  if (ch.agent !== undefined) { const nm = crew ? crew.nameOf(ch.agent) : ch.agent; need.push(new RegExp('--agent[ =](?:' + escRe(ch.agent) + '|' + escRe(nm) + ')\\b', 'i')); }
  return need.every(re => re.test(t));
}
function scopeShareOf(scopeText, paths) {
  if (!scopeText || !paths.length) return { share: 1, paths: paths.slice() };
  const s = String(scopeText);
  const inScope = paths.filter(p => s.includes(p) || s.includes(path.posix.basename(p)));
  if (!inScope.length) return { share: 1 / paths.length, paths: [] };   // a scope that names none of the changed paths covers at most one path's worth
  return { share: inScope.length / paths.length, paths: inScope };
}
const sevOf = text => (String(text || '').match(/\b(?:Severity|sev)\s*[:=]\s*\**\s*`?(S[0-3])\b/i) || [])[1] || null;
const reachOf = text => (String(text || '').match(/\b(?:Reach)\s*[:=]\s*\**\s*`?(R[1-4])\b/i) || [])[1] || null;

/* ---------------- collectors ---------------- */
function base(P, o) {
  const ver = Number(P.collectorVersion) || 1;
  const ref = o.source && o.source.ref;
  const row = Object.assign({ schema: 1, policy: P.version, writer: COLLECT_WRITER, collector: ver }, o, { id: mkId(o.signal, ref, o.agent, o.bucket, o.kind, o.key, ver) });
  if (ver > 1) row.srcKey = mkId(o.signal, ref, o.agent, o.bucket, o.kind, o.key);
  return row;
}
function listFiles(dir, re, skip) {
  const out = [];
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!skip || !skip.test(rel(p))) walk(p); } else if (re.test(e.name)) out.push(p); } };
  walk(dir); return out;
}
async function collect(opt) {
  const o = Object.assign({ dry: false, now: Date.now(), log: () => {}, saveState: true }, opt || {});   // saveState: the PR cache and the runs-seen file (off for dry runs and --ledger-only)
  const P = loadPolicy(), crew = loadCrew();
  const VER = Number(P.collectorVersion) || 1;
  const mk = (signal, ref, agent, bucket, kind, key) => mkId(signal, ref, agent, bucket, kind, key, VER);
  const startMs = Date.parse(P.companyStart), settle = (P.settleHours || 2) * HOUR, slack = P.verification.slackMinutes * MIN;
  const report = { collector: VER, prs: {}, defects: {}, verdicts: {}, reverts: {}, tests: {}, soft: {}, gate: {}, rulings: {}, errors: [] };
  const rows = [];
  let runs = [], runsOk = false, fetchedAt = o.now;
  try { runs = await fetchRuns(); runsOk = true; fetchedAt = Date.now(); } catch (e) { report.errors.push('runs: ' + e.message + ' (authors, reviewers and finders cannot be verified, so nothing that needs them is written)'); }
  const seen = readJson(F.runsSeen, null);
  const keepDays = P.verification.runsSeenKeepDays || 120;
  if (runsOk) {
    const late = lateRuns(runs, seen, slack, o.now - keepDays * DAY);
    if (late.length) {
      report.lateRuns = late.length;
      report.errors.push(late.length + ' run record(s) appeared after an earlier collect had already covered their end time, so they are not used: ' + late.slice(0, 5).map(r => String(r.runId).slice(0, 8) + ' (' + r.agentId + ')').join(', '));
      const bad = new Set(late.map(r => r.runId)); runs = runs.filter(r => !bad.has(r.runId));
    }
  }
  const RI = runIndex(runs);
  const haveRuns = runs.length > 0;
  const ledgerAll = readLedger();
  const ledger = ledgerAll.filter(r => r.writer !== COLLECT_WRITER || (Number(r.collector) || 1) === VER);

  /* --- verdict files (read first: PR approvals need them) --- */
  const verdictFiles = listFiles(F.work, /verdict.*\.md$/i, /^company\/work\/(handoffs|people|archive)/).filter(f => !/template/i.test(path.basename(f)));
  const verdicts = [];
  for (const f of verdictFiles) {
    const v = parseVerdictFile(readText(f));
    v.file = rel(f);
    v.reviewerId = crew.idOf(v.reviewer); v.requesterId = crew.idOf(v.requester);
    if (!v.reviewerId) {   // no name in the text: the one crew member (not the requester) whose runs wrote the verdict file is its reviewer
      const ws = RI.writers(v.file).filter(x => crew.ids.has(x) && x !== v.requesterId);
      if (ws.length === 1) { v.reviewerId = ws[0]; v.reviewer = crew.nameOf(ws[0]); }
    }
    const run = v.reviewerId ? RI.wrote(v.reviewerId, v.file, 0, true) : null;   // the verdict's time is the FIRST run that wrote it: a later edit does not move it past a merge
    v.corroboratedBy = run ? run.runId : null;
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch (_) {}
    v.at = run ? run.end : mtime;
    v.fresh = !run && o.now - mtime < settle;
    verdicts.push(v);
  }
  report.verdicts.files = verdicts.length;

  /* --- merged PRs in company/repos/* (a merged PR's view is cached: it does not change, and re-reading every PR every day would not fit the daily timeout) --- */
  const prs = [];
  const viewPr = (repo, n) => {
    const cf = path.join(F.prCache, repo.slug.replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + n + '.json');
    const c = readJson(cf, null); if (c && c.number === n && c.mergedAt) { report.prs.cached = (report.prs.cached || 0) + 1; return c; }
    const d = JSON.parse(gh(['pr', 'view', String(n), '--repo', repo.slug, '--json', 'number,title,body,mergedAt,mergeCommit,headRefOid,headRefName,labels,additions,deletions,files,commits,comments,reviews']));
    if (!o.dry && o.saveState && d && d.mergedAt) { try { atomicWrite(cf, JSON.stringify(d)); } catch (_) {} }
    return d;
  };
  let prsComplete = haveRuns;
  for (const repo of (haveRuns ? repos() : [])) {
    let list = [];
    try { list = JSON.parse(gh(['pr', 'list', '--repo', repo.slug, '--state', 'merged', '--limit', '1000', '--search', 'merged:>=' + P.companyStart.slice(0, 10), '--json', 'number,mergedAt'])); }
    catch (e) { prsComplete = false; report.errors.push('gh pr list ' + repo.slug + ': ' + String(e.message).split('\n')[0].slice(0, 160)); continue; }
    for (const it of list) {
      const mergedMs = Date.parse(it.mergedAt);
      if (!(mergedMs >= startMs)) continue;
      if (o.now - mergedMs < settle) { report.prs.settling = (report.prs.settling || 0) + 1; continue; }
      let d; try { d = viewPr(repo, it.number); }
      catch (e) { prsComplete = false; report.errors.push('gh pr view #' + it.number + ': ' + String(e.message).split('\n')[0].slice(0, 160)); continue; }
      prs.push({
        repo, number: d.number, ref: repo.slug + '#' + d.number, title: d.title || '', body: d.body || '', mergedMs, mergedAt: d.mergedAt,
        mergeSha: (d.mergeCommit && d.mergeCommit.oid) || '', headSha: d.headRefOid || '', headRef: d.headRefName || '',
        labels: (d.labels || []).map(l => l.name), files: (d.files || []).map(f => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
        commits: (d.commits || []).map(c => ({ oid: c.oid, authoredMs: Date.parse(c.authoredDate), committedMs: Date.parse(c.committedDate), raw: c })),
        items: [].concat((d.reviews || []).map(r => ({ at: Date.parse(r.submittedAt), body: r.body || '', kind: 'review' })), (d.comments || []).map(c => ({ at: Date.parse(c.createdAt), body: c.body || '', kind: 'comment' }))).sort((a, b) => a.at - b.at),
      });
    }
  }
  report.prs.companyEra = prs.length;
  const prOfSha = sha => prs.find(p => [p.mergeSha, p.headSha].concat(p.commits.map(c => c.oid)).some(x => x && sha && x.startsWith(sha))) || null;
  const creditIdsOf = {};   // pr.ref -> {agentId|name: creditId}
  const prAuthorsOf = {};   // pr.ref -> Set of every declared author id/name (verified or not) — for independence
  const prVerifiedAuthors = {};   // pr.ref -> [agentId] whose run made their commits
  const prApproved = {};    // pr.ref -> true when a corroborated independent approval exists
  const prReviewSev = {};   // pr.ref -> [{by, sev, reach}] severities stated by corroborated independent reviewers
  const prSize = {};

  for (const pr of prs) {
    const declared = prAuthorName(pr.body);
    const size = sizeFiles(P, pr.files); prSize[pr.ref] = size;
    // who wrote which commit, verified against the run records
    const commitInfo = pr.commits.map(c => {
      const name = commitAuthorName(c.raw, declared); const agentId = crew.idOf(name);
      let churn = null, paths = [];
      try {
        const ns = git(pr.repo.dir, ['show', '--numstat', '--format=', c.oid]).split('\n').filter(Boolean);
        paths = ns.map(l => l.split('\t')[2]).filter(Boolean);
        churn = ns.reduce((s, l) => { const [a, dd, p] = l.split('\t'); return sizeClassOf(P, p || '') === 'excluded' ? s : s + (Number(a) || 0) + (Number(dd) || 0); }, 0);
      } catch (_) {}
      const needles = commitNeedles(fullSubject(c.raw).subject, paths, pr.headRef);
      let run = null;
      if (agentId) for (const t of [c.authoredMs, c.committedMs]) { run = run || RI.find(agentId, t, slack, x => commitEffect(x, needles)); }
      return { oid: c.oid, name, agentId, run, churn, at: Math.max(c.authoredMs || 0, c.committedMs || 0) };
    });
    const churnKnown = !commitInfo.some(c => c.churn == null);
    if (!churnKnown) commitInfo.forEach(c => { c.churn = 1; });   // commit not local: split by commit count
    const authors = {};
    for (const c of commitInfo) {
      const k = c.agentId || ('name:' + (c.name || 'unknown'));
      const a = authors[k] = authors[k] || { key: k, agentId: c.agentId, name: c.name, churn: 0, verified: true, run: null, commits: [] };
      a.churn += c.churn; a.commits.push(c.oid.slice(0, 8));
      if (!c.run) a.verified = false; else a.run = a.run || c.run;
    }
    const totalChurn = Object.values(authors).reduce((s, a) => s + a.churn, 0) || 1;
    prAuthorsOf[pr.ref] = new Set(Object.values(authors).map(a => a.agentId || a.name).concat(declared ? [crew.idOf(declared) || declared] : []).filter(Boolean));
    prVerifiedAuthors[pr.ref] = Object.values(authors).filter(a => a.agentId && a.verified).map(a => a.agentId);
    const refs = [...new Set([...(pr.title + '\n' + pr.body).matchAll(/#(\d+)\b/g)].map(m => Number(m[1])).concat([...String(pr.headRef).matchAll(/(?:^|\/)(\d{2,6})(?=-|$)/g)].map(m => Number(m[1]))).filter(n => n && n !== pr.number))];
    // reviewers: PR comments/reviews + verdict files on any commit of this PR
    const revs = [];
    const apiRe = new RegExp('gh\\s+api\\s[^\\n]*(?:issues|pulls)/' + pr.number + '/(?:comments|reviews)');
    for (const it of pr.items) {
      if (it.at > pr.mergedMs) continue;
      const name = reviewerNameOf(it.body); const verdict = verdictOf(it.body);
      if (!name || !verdict) continue;
      const id = crew.idOf(name);
      // the reviewer's own run posted a comment on THIS PR carrying THIS verdict (or a body file)
      const vre = new RegExp('\\b' + escRe(verdict.split(' ')[0]) + '\\b', 'i');
      const match = t => (ghPrCmd(t, 'comment|review', pr.number, pr.repo.slug) || apiRe.test(t)) && (vre.test(t) || /--body-file\b|\s-F\s/.test(t));
      const run = id ? RI.find(id, it.at, slack, match) : null;
      const sc = (it.body.match(/\bscope\s*:\s*([^\n]+)/i) || [])[1] || null;
      revs.push({ id, name, verdict, at: it.at, scope: sc, corroboratedBy: run ? run.runId : null, source: 'gh-' + it.kind, ref: pr.ref, findings: parseFindings(it.body), model: run ? run.model : null, sev: sevOf(it.body), reach: reachOf(it.body) });
    }
    for (const v of verdicts) {
      if (!v.reviewerId || !v.verdict || !v.commits.length || !v.commits.some(sha => prOfSha(sha) === pr)) continue;
      if (!v.scopeDeclared || v.at > pr.mergedMs) continue;
      revs.push({ id: v.reviewerId, name: v.reviewer, verdict: v.verdict, at: v.at, scope: v.scopeText, corroboratedBy: v.corroboratedBy, source: 'verdict-file', ref: v.file, findings: v.findings, model: null, sev: null, reach: null });
      v.usedFor = pr.ref;
    }
    const authorIds = prAuthorsOf[pr.ref];
    const independent = revs.filter(r => r.id && !authorIds.has(r.id));
    prReviewSev[pr.ref] = independent.filter(r => r.corroboratedBy && r.sev).map(r => ({ by: r.id, sev: r.sev, reach: r.reach }));
    const latestBy = {};
    for (const r of independent.sort((a, b) => a.at - b.at)) {   // the latest CORROBORATED verdict per reviewer wins; uncorroborated only if none is
      const cur = latestBy[r.id];
      if (!cur || (r.corroboratedBy || !cur.corroboratedBy)) latestBy[r.id] = r;
    }
    const approvals = Object.values(latestBy).filter(r => APPROVE_ISH.test(r.verdict));
    const corroboratedApproval = approvals.some(r => r.corroboratedBy);
    prApproved[pr.ref] = corroboratedApproval;
    // hard signal: the test record for the merged head, written before the merge, by a run that ran the test then
    const recFile = path.join(F.testEvidenceDir, pr.headSha + '.json');
    let rec = null, recCtime = null; try { rec = JSON.parse(fs.readFileSync(recFile, 'utf8')); recCtime = fs.statSync(recFile).ctimeMs; } catch (_) {}
    let ts = rec ? testRecordSignal(rec, pr.mergedMs, { ctimeMs: recCtime }) : { ok: false, why: 'no record' };
    if (ts.ok) {
      const trun = testRecordRun(RI, rec, pr.mergedMs, { ids: crew.ids, slack, hours: P.verification.testRecordRunHours });
      if (!trun) ts = { ok: false, why: 'no run record shows the test command (' + String(rec.command || '').slice(0, 60) + ') running when the record says it ran' };
      else ts.runId = trun.runId;
    }
    const script = ts.ok ? ((ts.command.match(/(company\/tools\/[A-Za-z0-9_.-]+)/) || [])[1] || '') : '';
    report.tests[pr.ref] = ts.ok ? 'hard signal (' + Object.entries(ts.cases).map(([k, n]) => k + ' ' + n).join(', ') + ')' : ts.why;
    for (const a of Object.values(authors)) {
      const share = a.churn / totalChurn;
      const selfHard = ts.ok && P.hardSignalAuthors && P.hardSignalAuthors[script] === a.agentId;
      let v = 0;
      if (corroboratedApproval) v = ts.ok ? (selfHard ? P.verification.approvalPlusSelfAuthoredHard : P.verification.approvalPlusIndependentHard) : P.verification.approvalOnly;
      else if (ts.ok && !selfHard) v = P.verification.independentHardOnly;
      const pending = !a.agentId ? 'unknown-agent' : !a.verified ? 'author-unverified' : v < P.verification.minToCount ? (approvals.length ? 'reviewer-uncorroborated' : 'no-verified-review') : null;
      const agent = a.agentId || a.name || 'unknown';
      const row = base(P, {
        kind: 'credit', signal: 'pr.merged', agent, bucket: size.bucket, at: pr.mergedAt,
        source: { type: 'gh-pr', ref: pr.ref, sha: pr.mergeSha.slice(0, 12), head: pr.headSha.slice(0, 12), commits: a.commits },
        files: pr.files.map(f => f.path), headRef: pr.headRef, refs, lines: Math.round(size.lines * share), share: round(share, 4), sizePts: round(size.pts * share, 3), prSizePts: round(size.pts, 3),
        v, pending, authorCorroboratedBy: a.run ? a.run.runId : null, model: a.run ? a.run.model : null,
        verifiers: approvals.map(r => ({ agent: r.id, verdict: r.verdict, at: iso(r.at), source: r.source, corroboratedBy: r.corroboratedBy })).concat(ts.ok ? [{ hard: 'test-record', head: pr.headSha.slice(0, 12), cases: ts.cases, ranAt: ts.ranAt, runId: ts.runId, selfAuthored: !!selfHard }] : []),
        evidence: ['gh pr view ' + pr.number + ' --repo ' + pr.repo.slug],
      });
      rows.push(row);
      (creditIdsOf[pr.ref] = creditIdsOf[pr.ref] || {})[a.agentId || a.key] = row.id;
      report.prs.credits = (report.prs.credits || 0) + 1;
      if (pending) report.prs.pending = (report.prs.pending || 0) + 1;
    }
    // one approval row per independent reviewer whose latest verdict before the merge approves
    for (const r of approvals) {
      const sc = scopeShareOf(r.scope, pr.files.map(f => f.path));
      rows.push(base(P, {
        kind: 'credit', signal: 'review.approve', agent: r.id, bucket: 'review', at: pr.mergedAt, acceptedAt: pr.mergedAt,
        source: { type: r.source, ref: r.ref, pr: pr.ref, verdictAt: iso(r.at) }, key: pr.ref,
        links: { parents: Object.values(creditIdsOf[pr.ref] || {}), pr: pr.ref }, prSizePts: round(size.pts, 3), files: sc.paths.length ? sc.paths : pr.files.map(f => f.path),
        vReviewer: r.corroboratedBy ? 1 : P.verification.uncorroboratedReviewer, scopeShare: round(sc.share, 4), corroboratedBy: r.corroboratedBy, verdict: r.verdict,
        pending: r.corroboratedBy ? null : 'uncorroborated', model: r.model,
      }));
      report.prs.approvals = (report.prs.approvals || 0) + 1;
    }
    // findings carrying a severity in a corroborated pre-merge verdict: caught in review (never stand alone); fixLines =
    // what the author changed after the finding, which scales the experience cap like a post-merge fix does
    for (const r of Object.values(latestBy).filter(x => x.corroboratedBy)) {
      for (const fd of (revs.filter(x => x.id === r.id && x.corroboratedBy).flatMap(x => x.findings.map(f => Object.assign({ ref: x.ref, at: x.at }, f))))) {
        const fixLines = churnKnown ? commitInfo.filter(c => c.at > fd.at).reduce((s, c) => s + c.churn, 0) : null;
        for (const a of Object.values(authors)) {
          if (!a.agentId) continue;
          rows.push(base(P, {
            kind: 'demerit', signal: 'flaw.in-review', agent: a.agentId, bucket: size.bucket, at: iso(fd.at), key: fd.ref + ':' + fd.id,
            severity: fd.severity, reach: fd.reach || 'R2', caught: 'review', finder: r.id, findingKey: fd.ref + ':' + fd.id, fixLines,
            source: { type: 'review-finding', ref: fd.ref, finding: fd.id, pr: pr.ref }, links: { parent: (creditIdsOf[pr.ref] || {})[a.agentId] || null }, share: round(a.churn / totalChurn, 4),
          }));
          report.verdicts.inReviewFindings = (report.verdicts.inReviewFindings || 0) + 1;
        }
      }
    }
  }
  if (!prsComplete && haveRuns) report.errors.push('PR data incomplete: defects, reverts and the gate audit are skipped this collect (they depend on it) and run next time');

  /* --- defect files carrying a Severity line --- */
  const defects = [];
  for (const f of (prsComplete ? listFiles(F.defectsDir, /\.md$/i) : [])) {
    const d = parseDefect(readText(f)); d.file = rel(f);
    if (!d.severity) { report.defects.noSeverity = (report.defects.noSeverity || 0) + 1; continue; }
    const finderId = crew.idOf(d.finder);
    const run = finderId ? RI.wrote(finderId, d.file) : null;
    let mtime = 0; try { mtime = fs.statSync(f).mtimeMs; } catch (_) {}
    if (!run && o.now - mtime < settle) { report.defects.settling = (report.defects.settling || 0) + 1; continue; }
    const at = run ? run.end : mtime;
    // who wrote the flawed lines: git blame of the cited path:line refs in the product repo, at the build the finder named
    let era = 'unknown', parent = null, codeAgent = null, files = [];
    for (const repo of repos()) {
      const rev = d.build || 'origin/master';
      const shas = new Set(); let blamed = 0;
      for (const r of d.refs.slice(0, 12)) {
        try {
          const out = git(repo.dir, ['blame', '-L', r.from + ',' + r.to, '--porcelain', rev, '--', r.path]);
          blamed++; files.push(r.path);
          for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) shas.add(m[1]);
        } catch (_) {}
      }
      if (!blamed) continue;
      const times = [...shas].map(s => { try { return Number(git(repo.dir, ['show', '-s', '--format=%at', s])) * 1000; } catch (_) { return NaN; } });
      if (d.introducedBy) {
        const t = /^#?\d+$/.test(d.introducedBy) ? prs.find(p => p.number === Number(d.introducedBy.replace('#', ''))) : prOfSha(d.introducedBy);
        if (t) { era = 'company'; const ids = creditIdsOf[t.ref] || {}; const k = Object.keys(ids).find(x => crew.ids.has(x)); if (k) { codeAgent = k; parent = ids[k]; } }
      } else if (times.length && times.every(t => t < startMs)) era = 'pre-company';
      else if (times.length && times.every(t => t >= startMs)) {
        const owners = new Set([...shas].map(s => prOfSha(s)).filter(Boolean).map(p => p.ref));
        if (owners.size === 1) { const ref = [...owners][0]; era = 'company'; const ids = creditIdsOf[ref] || {}; const ks = Object.keys(ids).filter(x => crew.ids.has(x)); if (ks.length === 1) { codeAgent = ks[0]; parent = ids[ks[0]]; } }
      }
      break;
    }
    const cited = [...new Set(d.refs.map(r => r.path))];
    const row = base(P, {
      kind: 'demerit', signal: 'defect.confirmed', agent: codeAgent, bucket: files.length ? bucketOf(P, files[0]) : 'build', at: iso(at), key: d.file,
      severity: d.severity, reach: d.reach || P.defaultReach.product, caught: 'after', finder: finderId, finderCorroboratedBy: run ? run.runId : null,
      codeEra: era, links: { parent }, files: [...new Set(files)], cited, source: { type: 'defect-file', ref: d.file, id: d.id, issue: d.issue }, evidence: [d.file],
    });
    rows.push(row); defects.push(Object.assign({ rowId: row.id, at, cited }, d));
    report.defects[era] = (report.defects[era] || 0) + 1;
    if (!run) report.defects.finderUnverified = (report.defects.finderUnverified || 0) + 1;
  }
  // a finder's run that shows up after the defect row was written still confirms it (rows are never edited)
  for (const r of ledger.filter(x => x.signal === 'defect.confirmed' && !x.finderCorroboratedBy && x.finder)) {
    const run = RI.wrote(r.finder, (r.source || {}).ref || '');
    if (!run) continue;
    rows.push(base(P, { kind: 'record', signal: 'finding.corroborated', agent: r.finder, bucket: 'review', at: iso(run.end), key: r.id, target: r.id, corroboratedBy: run.runId, source: { type: 'run', ref: run.runId } }));
    report.defects.laterCorroborated = (report.defects.laterCorroborated || 0) + 1;
  }
  // fixes that merged for a defect: a later company-era PR naming the defect's issue or id AND touching a cited file
  // (a PR that only names the id is not its fix). compute sums every fix's lines.
  for (const d of defects) {
    for (const pr of prs) {
      if (pr.mergedMs < d.at - DAY) continue;
      const text = pr.title + '\n' + pr.body + '\n' + pr.headRef;
      const hit = (d.issue && new RegExp('#' + d.issue + '\\b').test(text)) || (d.id && new RegExp('\\b' + escRe(d.id) + '\\b', 'i').test(text));
      if (!hit) continue;
      if (d.cited.length && !pr.files.some(f => d.cited.includes(f.path))) { report.defects.fixNotTouchingCitedLines = (report.defects.fixNotTouchingCitedLines || 0) + 1; continue; }
      rows.push(base(P, { kind: 'record', signal: 'defect.fix-merged', agent: (prVerifiedAuthors[pr.ref] || [])[0] || crew.idOf(prAuthorName(pr.body)), bucket: 'review', at: pr.mergedAt, key: d.rowId,
        target: d.rowId, fixLines: sizeFiles(P, pr.files).lines, source: { type: 'gh-pr', ref: pr.ref } }));
      report.defects.fixesMerged = (report.defects.fixesMerged || 0) + 1;
    }
  }
  // classifications: a verdict file whose TITLE names one defect and that states its severity (the classifier, not the finder, sets it)
  for (const v of verdicts) {
    if (!v.classification || !v.reviewerId || v.fresh) continue;
    const s = v.subject;
    let target = null;
    if (s.ids.length) target = s.ids.length === 1 ? defects.find(d => d.id === s.ids[0]) || null : null;
    else if (s.files.length === 1) target = defects.find(d => d.file === s.files[0]) || null;
    else if (s.issues.length === 1) target = defects.find(d => d.issue === s.issues[0]) || null;
    if (!target) { if (s.ids.length || s.issues.length) (report.verdicts.classificationsNoDefectFile = report.verdicts.classificationsNoDefectFile || []).push(v.file); continue; }
    rows.push(base(P, { kind: 'record', signal: 'defect.classified', agent: v.reviewerId, bucket: 'review', at: iso(v.at), key: target.rowId,
      target: target.rowId, severity: v.classification, corroboratedBy: v.corroboratedBy, source: { type: 'verdict-file', ref: v.file } }));
    v.usedFor = target.file;
    report.verdicts.classifications = (report.verdicts.classifications || 0) + 1;
  }

  /* --- reverts and fix-forward PRs (after defects: a fix PR for a known defect is that defect's fix, not a second flaw) --- */
  const namesDefect = pr => { const text = pr.title + '\n' + pr.body + '\n' + pr.headRef; return defects.some(d => (d.issue && new RegExp('#' + d.issue + '\\b').test(text)) || (d.id && new RegExp('\\b' + escRe(d.id) + '\\b', 'i').test(text))); };
  for (const pr of (prsComplete ? prs : [])) {
    const text = pr.title + '\n' + pr.body;
    const textRevert = /^revert\b/i.test(pr.title) || /This reverts commit [0-9a-f]{7,40}/.test(text) || /\bReverts\s+[\w.-]+\/[\w.-]+#\d+/.test(text);
    const cited = new Set();
    for (const m of text.matchAll(/#(\d+)\b/g)) { const n = Number(m[1]); const t = prs.find(p => p.repo.slug === pr.repo.slug && p.number === n && p.number !== pr.number && p.mergedMs < pr.mergedMs); if (t) cited.add(t); }
    for (const m of text.matchAll(/\b([0-9a-f]{7,40})\b/g)) { const t = prOfSha(m[1]); if (t && t !== pr && t.mergedMs < pr.mergedMs) cited.add(t); }
    const isFix = /^fix(\(|:|!)/i.test(pr.title) || /\b(regression|fix-forward|follow-up to)\b/i.test(text);
    if (!cited.size || (!textRevert && !isFix)) continue;
    if (namesDefect(pr)) { report.reverts.fixesOfKnownDefects = (report.reverts.fixesOfKnownDefects || 0) + 1; continue; }
    // the fix PR is itself verified work: its author's run made it, or a corroborated reviewer approved it
    const fixers = prVerifiedAuthors[pr.ref] || [];
    if (!fixers.length && !prApproved[pr.ref]) { report.reverts.unverifiedFixPRs = (report.reverts.unverifiedFixPRs || 0) + 1; continue; }
    const finder = fixers.length === 1 ? fixers[0] : null;
    const fixLines = sizeFiles(P, pr.files).lines;
    for (const t of cited) {
      const ids = creditIdsOf[t.ref] || {};
      const removes = pr.files.filter(f => t.files.some(x => x.path === f.path)).reduce((s, f) => s + (Number(f.deletions) || 0), 0);
      const added = t.files.reduce((s, f) => s + (Number(f.additions) || 0), 0) || 1;
      const revert = removes / added >= P.revert.removesShare;   // a revert is measured, not declared: a title cannot void anyone's work
      for (const [agentId, cid] of Object.entries(ids)) {
        if (!crew.ids.has(agentId)) continue;
        // severity and reach come only from a corroborated reviewer of the fix PR who is neither its author nor the person
        // charged, else the policy default; never from the fix author's own text or labels
        const rs = (prReviewSev[pr.ref] || []).filter(x => x.by !== agentId && !fixers.includes(x.by)).pop() || null;
        rows.push(base(P, {
          kind: 'demerit', signal: revert ? 'pr.reverted' : 'pr.fix-forward', agent: agentId, bucket: prSize[t.ref] ? prSize[t.ref].bucket : 'build', at: pr.mergedAt, key: t.ref,
          severity: (rs && rs.sev) || (revert ? P.revert.defaultSeverity : P.fixForward.defaultSeverity), reach: (rs && rs.reach) || P.defaultReach.product,
          severityBy: rs ? rs.by : 'policy default', caught: fixers.includes(agentId) ? 'self-reported' : 'after',
          finder: finder && finder !== agentId ? finder : null, fixLines, links: { parent: cid },
          source: { type: 'gh-pr', ref: pr.ref, target: t.ref }, files: pr.files.map(f => f.path), evidence: ['gh pr view ' + pr.number + ' --repo ' + pr.repo.slug],
        }));
        report.reverts[revert ? 'reverts' : 'fixForwards'] = (report.reverts[revert ? 'reverts' : 'fixForwards'] || 0) + 1;
      }
    }
  }

  /* --- verdict files on company documents (not PRs): the approved work and the reviewer --- */
  const skip = (v, why) => (report.verdicts.skipped = report.verdicts.skipped || []).push(v.file + ': ' + why);
  for (const v of verdicts) {
    if (v.usedFor) continue;
    if (!v.scopeDeclared) { skip(v, 'no declared scope'); continue; }
    if (!v.verdict) { skip(v, 'no verdict word'); continue; }
    if (!v.reviewerId) { skip(v, 'reviewer not on the crew'); continue; }
    if (v.fresh || !haveRuns) continue;
    const subject = v.files.map(normPath).find(p => p.startsWith('company/') && !/verdict/i.test(p) && fs.existsSync(J(p)));
    if (!subject) { skip(v, 'scope names no company document'); continue; }
    // a reviewer who also wrote the document is not independent of it
    if (RI.writers(subject).includes(v.reviewerId)) { skip(v, crew.nameOf(v.reviewerId) + ' also wrote ' + subject + ', so the review is not independent'); continue; }
    // the author: the requester if their runs wrote the document, else the one other crew member whose runs did
    let author = null, arun = null;
    if (v.requesterId && v.requesterId !== v.reviewerId) { arun = RI.wrote(v.requesterId, subject, v.at); if (arun) author = v.requesterId; }
    if (!author) { const ws = RI.writers(subject).filter(a => a !== v.reviewerId && crew.ids.has(a)); if (ws.length === 1) { author = ws[0]; arun = RI.wrote(author, subject, v.at); } }
    const docText = readText(J(subject)) || '';
    // size = the part the scope names ("(280 lines)", "lines 30-42", "§7"), else the whole document
    const lines = v.declaredLines || sectionLines(docText, v.scopeText) || docText.split('\n').length;
    const sizePts = round(lines * perLine(P, sizeClassOf(P, subject)), 3);
    const approve = APPROVE_ISH.test(v.verdict);
    const conditional = approve && v.blocking;   // "APPROVE WITH CHANGES — two blocking": not accepted until a later verdict approves
    const bucket = bucketOf(P, subject);
    const creditAgent = author || v.requesterId || 'unknown';
    const creditId = mk('work.reviewed', v.file, creditAgent, bucket, 'credit', '');
    if (approve) {
      rows.push(base(P, {
        kind: 'credit', signal: 'work.reviewed', agent: creditAgent, bucket, at: iso(v.at), source: { type: 'verdict-file', ref: v.file, subject },
        files: [subject], lines, sizePts, prSizePts: sizePts, share: 1, v: v.corroboratedBy ? P.verification.approvalOnly : 0,
        pending: !author ? 'author-unverified' : !v.corroboratedBy ? 'reviewer-uncorroborated' : conditional ? 'conditional-approval' : null, authorCorroboratedBy: arun ? arun.runId : null, model: arun ? arun.model : null,
        verifiers: [{ agent: v.reviewerId, verdict: v.verdict, at: iso(v.at), source: 'verdict-file', corroboratedBy: v.corroboratedBy }], evidence: [v.file], note: conditional ? v.verdictLine.slice(0, 160) : undefined,
      }));
      rows.push(base(P, {
        kind: 'credit', signal: 'review.approve', agent: v.reviewerId, bucket: 'review', at: iso(v.at), acceptedAt: iso(v.at), key: subject,
        source: { type: 'verdict-file', ref: v.file, subject }, links: { parents: [creditId] }, prSizePts: sizePts, files: [subject],
        vReviewer: v.corroboratedBy ? 1 : P.verification.uncorroboratedReviewer, scopeShare: 1, corroboratedBy: v.corroboratedBy, verdict: v.verdict,
        pending: !v.corroboratedBy ? 'uncorroborated' : conditional ? 'conditional-approval' : null,
      }));
      report.verdicts[conditional ? 'conditionalApprovals' : 'documentApprovals'] = (report.verdicts[conditional ? 'conditionalApprovals' : 'documentApprovals'] || 0) + 1;
    } else report.verdicts.requestChanges = (report.verdicts.requestChanges || 0) + 1;
    if (author && v.corroboratedBy) for (const fd of v.findings) {
      rows.push(base(P, { kind: 'demerit', signal: 'flaw.in-review', agent: author, bucket, at: iso(v.at), key: v.file + ':' + fd.id, severity: fd.severity, reach: fd.reach || 'R2', caught: 'review',
        finder: v.reviewerId, findingKey: v.file + ':' + fd.id, fixLines: null, links: { parent: approve ? creditId : null, parentKey: author + '|' + subject }, source: { type: 'review-finding', ref: v.file, finding: fd.id }, share: 1 }));
      report.verdicts.inReviewFindings = (report.verdicts.inReviewFindings || 0) + 1;
    }
  }

  /* --- post-merge gate audit: a merge after gateAuditFrom needs a PASS premerge record for its head, at or before it --- */
  const auditFrom = Date.parse(P.gateAuditFrom);
  for (const pr of (prsComplete ? prs : [])) {
    if (!(pr.mergedMs >= auditFrom)) { report.gate.preRule = (report.gate.preRule || 0) + 1; continue; }
    const recFile = path.join(F.premergeDir, 'premerge-' + pr.repo.name + '-' + pr.headSha + '.json');
    const rec = readJson(recFile, null);
    const pass = gatePassFor(rec, pr.mergedMs);   // a later re-run (FAIL: "PR is open") does not erase the PASS the merge relied on
    const mergeMatch = t => ghPrCmd(t, 'merge', pr.number, pr.repo.slug);
    const merger = [...crew.ids].find(a => RI.find(a, pr.mergedMs, 15 * MIN, mergeMatch)) || null;
    if (pass) {
      const prun = RI.findAny(Date.parse(pass.at), slack, t => /premerge-check\.js\b/.test(t) && new RegExp('--pr[\\s=]+#?' + pr.number + '\\b').test(t), null, crew.ids);
      rows.push(base(P, { kind: 'record', signal: 'gate.pass', agent: merger, bucket: 'ops', at: pr.mergedAt, key: pr.headSha, passAt: pass.at, corroboratedBy: prun ? prun.runId : null, source: { type: 'premerge-record', ref: pr.ref, record: rel(recFile) } }));
      report.gate.pass = (report.gate.pass || 0) + 1;
      if (!prun) (report.gate.passNotMatchedToRun = report.gate.passNotMatchedToRun || []).push(pr.ref);
      continue;
    }
    const G = P.gateAudit;
    rows.push(base(P, { kind: 'demerit', signal: 'process.merged-without-gate', agent: merger, bucket: G.bucket, at: pr.mergedAt, key: pr.headSha,
      severity: G.severity, reach: G.reach, caught: G.caught, source: { type: 'gh-pr', ref: pr.ref, head: pr.headSha.slice(0, 12), record: rel(recFile) },
      note: rec ? 'no PASS at or before the merge (record verdict ' + rec.verdict + ' at ' + rec.at + ')' : 'no premerge-check record for the merged head', links: { parent: null } }));
    report.gate.withoutGate = (report.gate.withoutGate || 0) + 1;
  }

  /* --- soft signals (H.5): owner corrections and "(own error)" rows, each matched to the run of the person it names --- */
  const S = P.soft;
  const softSkip = why => (report.soft.skipped = report.soft.skipped || []).push(why);
  const inbound = (readText(F.ownerInbound) || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const acked = (readJson(F.ownerInbox, {}) || {}).acked || {};
  const ackRe = new RegExp(S.ackCorrectionPattern, 'i'), replyRe = new RegExp(S.replyAdmissionPattern, 'i');
  const correction = (msg, agentId, how, evidence, extra) => {
    const at = Date.parse(msg.at);
    const d = S.ownerCorrection;
    rows.push(base(P, Object.assign({ kind: 'demerit', signal: 'owner.correction', agent: agentId, bucket: d.bucket, at: msg.at, key: msg.id, soft: true, appliesAt: iso(at + S.applyAfterHours * HOUR),
      severity: d.severity, reach: d.reach, caught: d.caught, source: { type: how, ref: msg.id }, evidence, note: String(msg.text || msg.body || '').replace(/\s+/g, ' ').slice(0, 200), links: { parent: null } }, extra || {})));
    report.soft.ownerCorrections = (report.soft.ownerCorrections || 0) + 1;
  };
  // replies first: a crew reply on the owner channel (company/owner/outbound.jsonl), sent by that person's own run, that
  // admits the error answers the owner message it names (re), else the owner message just before it
  const replyOf = {};   // msg.id -> {by, at, runId}
  for (const l of (haveRuns ? (readText(F.ownerOutbound) || '').split('\n').filter(Boolean) : [])) {
    let r; try { r = JSON.parse(l); } catch (_) { continue; }
    const from = String(r.from || r.by || '');
    const by = crew.idOf(from.split(/[\s(]/)[0]);
    if (!by || !replyRe.test(String(r.text || r.preview || ''))) continue;
    const t = Date.parse(r.at);
    const msg = (r.re && inbound.find(m => m.id === r.re && Date.parse(m.at) <= t))
      || inbound.filter(m => Date.parse(m.at) <= t && t - Date.parse(m.at) <= S.replyLinkHours * HOUR).sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
    if (!msg || replyOf[msg.id]) continue;
    const tool = new RegExp('\\b' + escRe(String(r.via || 'owner-inbox')) + '\\.js\\b[^\\n]*\\bsend\\b');
    const run = RI.find(by, t, slack, x => tool.test(x));
    if (!run) { softSkip('owner-channel reply at ' + r.at + ' by ' + from + ': no run of theirs sent it'); continue; }
    replyOf[msg.id] = { by, at: r.at, runId: run.runId, msg };
  }
  // the person admitted it in their own reply: owned up, so x ownUpMultiplier like an "(own error)" row
  const seenMsg = new Set();
  for (const m of (haveRuns ? inbound : [])) {
    const a = acked[m.id]; if (!a || !ackRe.test(String(a.note || ''))) continue;
    const agentId = crew.idOf(String(a.by || '').split(/[\s(]/)[0]);
    if (!agentId) { report.soft.skippedNonCrew = (report.soft.skippedNonCrew || 0) + 1; continue; }
    const id8 = String(m.id).slice(0, 8);
    const run = RI.find(agentId, Date.parse(a.at), slack, t => /owner-inbox\.js\b[^\n]*\back\b/.test(t) && t.includes(id8));
    if (!run) { softSkip('owner-inbox ack of ' + id8 + ' by ' + a.by + ': no run of theirs ran the ack'); continue; }
    const rep = replyOf[m.id] && replyOf[m.id].by === agentId ? replyOf[m.id] : null;
    seenMsg.add(m.id);
    correction(m, agentId, 'owner-inbox', ['company/state/owner-inbox.json acked.' + m.id, rel(F.ownerInbound) + ' ' + m.id].concat(rep ? [rel(F.ownerOutbound) + ' ' + rep.at] : []), rep ? { ownUp: true, corroboratedBy: run.runId } : { corroboratedBy: run.runId });
  }
  for (const [id, rep] of Object.entries(replyOf)) {
    if (seenMsg.has(id)) continue;
    seenMsg.add(id); correction(rep.msg, rep.by, 'owner-outbound', [rel(F.ownerOutbound) + ' ' + rep.at, rel(F.ownerInbound) + ' ' + id], { ownUp: true, corroboratedBy: rep.runId });
  }
  // the live file plus the archive index: an "(own error)" row that rolled out (retention.js: decisions.md is also
  // bound by size, so a row can leave the live file the day it is written) was copied to the index as it moved
  const ownErrIdx = path.join(path.dirname(F.decisions), 'archive', path.basename(F.decisions, '.md'), 'index.md');
  const ownErrSeen = new Set();
  const ownErrs = haveRuns ? parseOwnErrors(readText(F.decisions)).concat(parseOwnErrors(readText(ownErrIdx)).map(e => Object.assign(e, { archived: true })))
    .filter(e => { const k = e.date + '|' + e.hash; if (ownErrSeen.has(k)) return false; ownErrSeen.add(k); return true; }) : [];
  for (const e of ownErrs) {
    for (const n of e.names) {
      const agentId = crew.idOf(n); if (!agentId) continue;
      const d = S.ownError;
      // an "(own error)" row counts only if the person it names wrote it: their run wrote decisions.md around that time
      const run = RI.wroteAround(agentId, F.decisions, e.at, (d.writerSlackMinutes || 30) * MIN);
      if (!run) { softSkip('decisions.md:' + e.line + ' "' + n + ' (own error)": no run of ' + n + "'s wrote decisions.md then, so it is not counted as theirs"); continue; }
      rows.push(base(P, { kind: 'demerit', signal: 'own-error', agent: agentId, bucket: d.bucket, at: iso(e.at), key: e.date + '|' + e.hash, soft: true, msgTimes: e.msgTimes,
        appliesAt: iso(e.at + S.applyAfterHours * HOUR), severity: d.severity, reach: d.reach, caught: d.caught, ownUp: true, source: { type: 'decisions-own-error', ref: 'company/work/decisions.md' }, line: e.line,
        corroboratedBy: run.runId, note: e.text, evidence: [(e.archived ? rel(ownErrIdx) : 'company/work/decisions.md') + ':' + e.line], links: { parent: null } }));
      report.soft.ownErrors = (report.soft.ownErrors || 0) + 1;
    }
  }

  /* --- amendments: counted once the amender's own run ran `competence.js amend <id>` with the same changes --- */
  const corroborated = new Set(ledger.filter(r => r.signal === 'ruling.corroborated').map(r => r.target));
  for (const r of ledgerAll.filter(x => x.kind === 'ruling' && !corroborated.has(x.id))) {
    const t = Date.parse(r.recordedAt || r.at);
    const run = RI.find(r.byAgent, t, slack, x => amendMatches(r, x, crew));
    if (!run) { report.rulings.waiting = (report.rulings.waiting || 0) + 1; continue; }
    rows.push(base(P, { kind: 'record', signal: 'ruling.corroborated', agent: r.byAgent, bucket: r.bucket || 'review', at: iso(run.end), key: r.id, target: r.id, corroboratedBy: run.runId, source: { type: 'run', ref: run.runId } }));
    report.rulings.corroborated = (report.rulings.corroborated || 0) + 1;
  }

  const written = appendRows(rows, { dry: o.dry });
  report.written = written.length; report.seen = rows.length;
  if (written.skipped.length) report.errors.push(written.skipped.length + ' row(s) over 4 KB not written: ' + written.skipped.slice(0, 5).join(', '));
  // remember which runs this collect saw, so a run inserted later behind our back is noticed
  if (!o.dry && o.saveState && runsOk && runs.length) {
    try {
      const ids = Object.assign({}, (seen && seen.ids) || {});
      for (const r of runs) ids[seenKey(r.runId)] = Math.round(runEnd(r) / MIN);
      const horizon = Math.round((o.now - keepDays * DAY) / MIN);
      for (const [k, v] of Object.entries(ids)) if (v < horizon) delete ids[k];
      atomicWrite(F.runsSeen, JSON.stringify({ v: 1, firstAt: (seen && seen.firstAt) || fetchedAt, at: fetchedAt, ids }) + '\n');
    } catch (e) { report.errors.push('runs-seen: ' + e.message); }
  }
  report.byPerson = {};
  for (const r of written) { const k = crew.nameOf(r.agent); const b = report.byPerson[k] = report.byPerson[k] || {}; b[r.signal] = (b[r.signal] || 0) + 1; }
  return report;
}

/* ---------------- compute (pure: rows + policy + crew + now) ---------------- */
function compute(rows, P, crew, nowMs) {
  const C = P.competence, now = nowMs || Date.now();
  const all = rows.filter(r => r && !r._bad);
  // only the newest collector's rows are scored; older collector rows stay in the chain as history
  const collVer = r => (r.writer === COLLECT_WRITER ? (Number(r.collector) || 1) : null);
  const maxVer = all.reduce((m, r) => Math.max(m, collVer(r) || 0), 0);
  const valid = all.filter(r => { const v = collVer(r); return v == null || v === maxVer; });
  const isCrew = a => !!a && crew.ids.has(a);
  // one defect file is one flaw, however its blame moved between collects (prefer the row that names a crew member)
  const canonDefect = new Map(), alias = new Map();
  for (const r of valid) if (r.signal === 'defect.confirmed') { const k = (r.source && r.source.ref) || r.id; const cur = canonDefect.get(k); if (!cur || (!isCrew(cur.agent) && isCrew(r.agent))) canonDefect.set(k, r); }
  for (const r of valid) if (r.signal === 'defect.confirmed') alias.set(r.id, canonDefect.get((r.source && r.source.ref) || r.id).id);
  const canon = id => alias.get(id) || id;
  const corrob = new Set(valid.filter(r => r.signal === 'ruling.corroborated').map(r => r.target));
  const rulings = valid.filter(r => r.kind === 'ruling').sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const eff = new Map();
  for (const r of rulings) {
    if (!corrob.has(r.id)) continue;
    const k = canon(r.target); const e = eff.get(k) || { rulings: [] };
    const ch = r.changes || {};
    if (ch.uphold) delete e.void;
    Object.assign(e, ch); e.amendedAt = Date.parse(r.at); e.rulings.push(r.id); eff.set(k, e);
  }
  const effOf = r => eff.get(r.id) || (r.srcKey ? eff.get(r.srcKey) : undefined);
  const E = r => { const e = effOf(r); if (!e) return r; const o = Object.assign({}, r, e); if (e.agent !== undefined) o.agent = e.agent; return o; };
  const xpItems = [], samples = [], pendingItems = [], serious = [], waiting = [], notes = [], unconfirmed = [], attribution = [];
  const addXp = (agent, bucket, xp, at, why, id) => { if (isCrew(agent) && xp > 0) xpItems.push({ agent, bucket, xp, at, why, id }); };
  const addSample = (agent, bucket, q, w, at, why, id) => { if (isCrew(agent) && w > 0) samples.push({ agent, bucket, q: clamp(q, 0, 1), w, at, why, id }); };
  const addPending = (agent, bucket, xp, why, id) => { if (isCrew(agent) && xp > 0) pendingItems.push({ agent, bucket, xp, why, id }); };

  /* work credits -> units (rollup by author + overlapping files, the same branch or the same issue, within the window) */
  const credits = valid.filter(r => r.kind === 'credit' && (r.signal === 'pr.merged' || r.signal === 'work.reviewed')).map(E);
  const verified = [];
  for (const c of credits) {
    if (c.void) continue;
    const ok = !c.pending && c.v >= P.verification.minToCount && isCrew(c.agent);
    if (ok) { verified.push(c); continue; }
    const age = now - Date.parse(c.at);
    if (age > P.pending.expireDays * DAY) continue;   // pending credits expire to nothing
    addPending(c.agent, c.bucket, Math.min(P.caps.xpPerUnit, (c.sizePts || 0) * P.verification.approvalOnly), 'work waiting for verification (' + (c.pending || 'v ' + c.v) + ')', c.id);
  }
  const linked = (a, b) => (a.files || []).some(f => (b.files || []).includes(f)) || (!!a.headRef && a.headRef === b.headRef) || (a.refs || []).some(n => (b.refs || []).includes(n));
  const unitOf = new Map(); const units = [];
  const byAgent = {};
  for (const c of verified) (byAgent[c.agent] = byAgent[c.agent] || []).push(c);
  for (const list of Object.values(byAgent)) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const parent = list.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (Math.abs(Date.parse(list[j].at) - Date.parse(list[i].at)) > P.rollup.windowDays * DAY) continue;
      if (linked(list[i], list[j])) parent[find(j)] = find(i);
    }
    const groups = {};
    list.forEach((c, i) => (groups[find(i)] = groups[find(i)] || []).push(c));
    for (const members of Object.values(groups)) {
      // the same document approved twice is one piece of work: size it once (largest), not twice
      const docMax = {}; let prPts = 0;
      for (const m of members) { if (m.signal === 'work.reviewed') { const k = (m.files || [])[0]; docMax[k] = Math.max(docMax[k] || 0, m.sizePts || 0); } else prPts += m.sizePts || 0; }
      const cBase = prPts + Object.values(docMax).reduce((s, x) => s + x, 0);
      const memSum = members.reduce((s, m) => s + (m.sizePts || 0), 0) || 1;
      const bucketPts = {}; for (const m of members) bucketPts[m.bucket] = (bucketPts[m.bucket] || 0) + (m.sizePts || 0);
      let bucket = members[0].bucket; let best = -1; for (const [b, x] of Object.entries(bucketPts)) if (x > best) { best = x; bucket = b; }
      const u = { id: members[0].id, agent: members[0].agent, members, cBase, cXp: Math.min(P.caps.xpPerUnit, cBase), memSum, bucket,
        v: members.reduce((s, m) => s + m.v * (m.sizePts || 0), 0) / memSum, lines: members.reduce((s, m) => s + (m.lines || 0), 0),
        at: Math.max(...members.map(m => Date.parse(m.at))), flaws: [], void: false };
      units.push(u); for (const m of members) unitOf.set(m.id, u);
    }
  }

  /* flaws, their fixes and classifications; a defect counts only when confirmed */
  const recs = valid.filter(r => r.kind === 'record');
  const fixesOf = {}; for (const r of recs) if (r.signal === 'defect.fix-merged') (fixesOf[canon(r.target)] = fixesOf[canon(r.target)] || []).push(r);
  const classOf = {}; for (const r of recs.filter(x => x.signal === 'defect.classified').sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) classOf[canon(r.target)] = r;
  const finderSeen = new Set(recs.filter(x => x.signal === 'finding.corroborated').map(x => canon(x.target)));
  const flawSignals = new Set(['flaw.in-review', 'defect.confirmed', 'pr.fix-forward', 'pr.reverted']);
  const flaws = [];
  for (const r of valid) {
    if (r.kind !== 'demerit' || !flawSignals.has(r.signal)) continue;
    if (r.signal === 'defect.confirmed' && canon(r.id) !== r.id) continue;
    const e = effOf(r); const f = E(r);
    if (f.void) continue;
    const cl = classOf[r.id];
    const clOk = !!(cl && cl.corroboratedBy && cl.agent !== r.finder && cl.agent !== f.agent);
    if (clOk && !(e && e.severity)) f.severity = cl.severity;   // the classifier's severity stands over the finder's
    if (f.severity === 'N') continue;
    // confirmed = the finder's own run wrote the defect file, or a corroborated classifier (not the finder, not the
    // author) rated it, or the people owner ruled on it. In-review findings, fix-forwards and reverts are confirmed by collection.
    f.finderOk = !!(r.finderCorroboratedBy || finderSeen.has(r.id));
    f.confirmed = r.signal !== 'defect.confirmed' || f.finderOk || clOk || !!e;
    f.D = demeritD(P, f) * (f.signal === 'flaw.in-review' && f.share != null ? f.share : 1);   // one finding on a shared PR is split by authorship
    f.atMs = Date.parse(f.at);
    f.inReview = f.signal === 'flaw.in-review' || f.caught === 'review' || f.caught === 'self';
    f.serious = P.seriousSeverities.includes(f.severity);
    const fx = fixesOf[r.id] || [];
    if (fx.length) { f.fixLines = fx.reduce((s, x) => s + (Number(x.fixLines) || 0), 0); f.fixedAt = Math.min(...fx.map(x => Date.parse(x.at))); }   // every fix PR's lines: a decoy first fix cannot shrink the cap
    else if (f.signal === 'pr.fix-forward' || f.signal === 'pr.reverted') f.fixedAt = f.atMs;
    f.settled = f.fixedAt != null || now - f.atMs > P.minorCap.settleWithoutFixDays * DAY;
    f.settledAt = f.fixedAt != null ? f.fixedAt : f.atMs + P.minorCap.settleWithoutFixDays * DAY;
    if (!f.confirmed) {
      unconfirmed.push({ id: f.id, agent: f.agent || null, finder: f.finder || null, severity: f.severity, signal: f.signal, source: f.source,
        why: 'no run record shows ' + (f.finder ? crew.nameOf(f.finder) : 'a crew finder') + ' writing it, and no classifier has rated it' });
      continue;
    }
    flaws.push(f);
  }
  const parentless = [];
  for (const f of flaws) {
    const pid = f.links && f.links.parent;
    const u = pid ? unitOf.get(pid) : null;
    if (u && u.agent === f.agent) { u.flaws.push(f); f.unit = u; }
    else if (pid && !u && !(effOf(f) || {}).agent) f.waitingParent = true;   // the work it belongs to is not verified yet: charge nobody yet, tell the people owner
    else parentless.push(f);
  }

  /* experience and competence per unit */
  const findingPay = [];   // {finder, amount, at, flaw, kind}
  for (const u of units) {
    const post = u.flaws.filter(f => !f.inReview), rev = u.flaws.filter(f => f.inReview && f.severity !== 'S3');
    u.void = post.some(f => f.signal === 'pr.reverted');
    // competence: the full demerits of minor flaws (post-acceptance S2/S3, in-review S2+), no floor
    const dq = post.filter(f => !f.serious).reduce((s, f) => s + f.D, 0) + rev.reduce((s, f) => s + f.D, 0);
    const q = u.void ? 0 : Math.max(0, 1 - dq / (u.cBase || 1));
    addSample(u.agent, u.bucket, q, u.v * sizeWeight(P, u.cBase), u.at, 'work (' + u.members.length + ' item' + (u.members.length > 1 ? 's' : '') + ')', u.id);
    u.q = q;
    if (u.void) { for (const f of u.flaws) f.charge = 0; continue; }
    // experience: charges under the cap, the cap scaled by how much of the work the fix touched
    const scaleOf = n => clamp(P.minorCap.fixShareFactor * n / (u.lines || 1), P.minorCap.fixShareMin, 1);
    const settledPost = post.filter(f => f.settled);
    const fixLines = settledPost.reduce((s, f) => s + (f.fixedAt != null && f.fixLines != null ? f.fixLines : (u.lines || 1) / P.minorCap.fixShareFactor), 0);
    const scale = scaleOf(fixLines);
    const cap3 = P.minorCap.S3share * u.cXp * scale, cap23 = P.minorCap.S2S3share * u.cXp * scale;
    const s3 = settledPost.filter(f => f.severity === 'S3').reduce((s, f) => s + f.D, 0);
    const s2p = settledPost.filter(f => f.severity !== 'S3').reduce((s, f) => s + f.D, 0);
    const s3c = Math.min(s3, cap3);
    const chargeP = Math.min(s3c + s2p, cap23);
    const ratioP = (s3c + s2p) > 0 ? chargeP / (s3c + s2p) : 0;
    for (const f of settledPost) f.charge = (f.severity === 'S3' ? f.D * (s3 > 0 ? s3c / s3 : 0) : f.D) * ratioP;
    // caught in review: the same cap, scaled by what the author changed after the finding (unknown = the smallest
    // share), so a catch in review never costs more than the same flaw found after the merge
    const sR = rev.reduce((s, f) => s + f.D, 0);
    const chargeR = Math.min(sR, P.minorCap.S2S3share * u.cXp * scaleOf(rev.reduce((s, f) => s + (Number(f.fixLines) || 0), 0)));
    for (const f of rev) f.charge = sR > 0 ? f.D * chargeR / sR : 0;
    let total = chargeP + chargeR;
    const capAll = P.minorCap.S2S3share * u.cXp;
    if (total > capAll) { const k = capAll / total; for (const f of settledPost.concat(rev)) f.charge *= k; total = capAll; }
    u.charge = total;
    for (const m of u.members) addXp(u.agent, u.bucket, m.v * ((m.sizePts || 0) / u.memSum) * Math.max(0, u.cXp - total), Date.parse(m.at), m.signal + ' ' + (m.source && m.source.ref), m.id);
    for (const f of post.filter(x => !x.settled)) addPending(u.agent, u.bucket, 0, 'flaw waiting for its fix (experience charge settles then)', f.id);
  }
  /* standalone samples and serious flags: every confirmed S0/S1 after acceptance in company-era work is flagged, even
     when nobody can be charged yet; only a flaw on a person's verified work charges a sample */
  const sw = d => Math.min(C.standaloneWeightMax, d / C.standaloneWeightDivisor);
  const flagOf = (f, agent, how) => ({ id: f.id, srcKey: f.srcKey || f.id, agent: agent || null, attribution: how, severity: f.severity, signal: f.signal, at: f.at, D: round(f.D), source: f.source, evidence: f.evidence || [] });
  for (const f of flaws) {
    if (f.inReview || !f.unit || !f.serious) continue;
    addSample(f.agent, f.unit.bucket, 0, sw(f.D), f.atMs, f.signal + ' ' + f.severity, f.id);
    serious.push(flagOf(f, f.agent, 'verified'));
  }
  for (const f of flaws) {
    if (!f.waitingParent || f.inReview) continue;
    attribution.push({ id: f.id, agent: f.agent || null, severity: f.severity, signal: f.signal, source: f.source, why: 'the work it is in names ' + crew.nameOf(f.agent) + ' as the author, but no run record shows ' + crew.nameOf(f.agent) + ' making that commit' });
    if (f.serious) serious.push(flagOf(f, f.agent, 'work-unverified'));
  }
  for (const f of parentless) {
    if (f.inReview) continue;   // caught before acceptance: never stands alone
    if (f.signal === 'defect.confirmed' && f.codeEra === 'pre-company') continue;   // nobody at the company wrote it
    if (!isCrew(f.agent)) {
      attribution.push({ id: f.id, agent: null, severity: f.severity, signal: f.signal, source: f.source, why: f.codeEra === 'company' ? 'company-era code, but blame names more than one PR or author' : 'the code era is unknown (no cited lines could be blamed)' });
      if (f.serious) serious.push(flagOf(f, null, 'unattributed'));
      continue;
    }
    addSample(f.agent, f.bucket, 0, sw(f.D), f.atMs, f.signal + ' ' + f.severity + ' (no parent work)', f.id);
    if (f.serious) serious.push(flagOf(f, f.agent, (effOf(f) || {}).agent ? 'amended' : 'verified'));
  }

  /* finders: paid exactly what the author lost (the charge after the cap, x the work's verification), so planting and
     finding a flaw never pays the pair; old code flat once a fix merges; cosmetic in review 1 each */
  const reviewGroups = {};
  for (const f of flaws) {
    if (!f.finder || !isCrew(f.finder) || f.finder === f.agent) continue;   // plant-and-find: a finder who wrote the work earns nothing
    if (f.signal === 'defect.confirmed' && !f.finderOk) { addPending(f.finder, 'review', 1, 'finding waiting for a run record', f.id); continue; }
    if (f.waitingParent) { addPending(f.finder, 'review', 1, 'finding on work that is not verified yet', f.id); continue; }
    if (f.inReview) { (reviewGroups[(f.source && f.source.ref) + '|' + f.finder] = reviewGroups[(f.source && f.source.ref) + '|' + f.finder] || []).push(f); continue; }
    if (f.signal === 'defect.confirmed' && f.codeEra === 'pre-company') {
      if (f.fixedAt != null) findingPay.push({ finder: f.finder, amount: P.findings.oldCodeFlat[f.severity] || 0, at: f.fixedAt, flaw: f, kind: 'old code, fix merged' });
      else addPending(f.finder, 'review', P.findings.oldCodeFlat[f.severity] || 0, 'old-code finding: pays when the fix merges', f.id);
      continue;
    }
    if (f.unit) {
      if (f.unit.agent === f.finder) continue;
      if (f.unit.void) {   // the work was reverted: the author lost it all, the finder of a real defect in it is paid flat
        if (f.signal === 'defect.confirmed' && f.settled) findingPay.push({ finder: f.finder, amount: P.findings.oldCodeFlat[f.severity] || 0, at: f.settledAt, flaw: f, kind: 'flaw in work later reverted' });
        continue;
      }
      if (f.settled) findingPay.push({ finder: f.finder, amount: (f.charge || 0) * f.unit.v, at: f.settledAt, flaw: f, kind: f.serious ? 'serious flaw found' : 'flaw found after acceptance' });
      else addPending(f.finder, 'review', 0, 'finding waiting for the fix', f.id);
      continue;
    }
    if (isCrew(f.agent)) {   // attributed (e.g. by an amendment) but no parent work: flat, once fixed
      if (f.fixedAt != null) findingPay.push({ finder: f.finder, amount: P.findings.oldCodeFlat[f.severity] || 0, at: f.fixedAt, flaw: f, kind: 'finding, fix merged' });
    } else addPending(f.finder, 'review', P.findings.oldCodeFlat[f.severity] || 0, 'finding waiting for attribution', f.id);
  }
  for (const group of Object.values(reviewGroups)) {
    if (!group.some(f => f.unit)) continue;   // the reviewed work was never accepted, so nothing was caught for anyone yet
    const byKey = {}; for (const f of group) (byKey[f.findingKey || f.id] = byKey[f.findingKey || f.id] || []).push(f);
    let cos = 0;
    for (const list of Object.values(byKey)) {
      const f = list[0];
      if (f.severity === 'S3') { if (cos >= P.review.cosmeticMaxPerReview) continue; cos++; findingPay.push({ finder: f.finder, amount: P.review.cosmeticPay, at: f.atMs, flaw: f, kind: 'cosmetic finding in review' }); continue; }
      const lost = list.reduce((s, x) => s + (x.unit ? (x.charge || 0) * x.unit.v : 0), 0);   // what every author of the work lost for it
      findingPay.push({ finder: f.finder, amount: lost, at: f.atMs, flaw: f, kind: 'finding in review' });
    }
  }
  // finder daily cap
  const fday = {};
  for (const p of findingPay) { const k = p.finder + '|' + localDay(p.at); (fday[k] = fday[k] || []).push(p); }
  for (const list of Object.values(fday)) {
    const sum = list.reduce((s, p) => s + p.amount, 0);
    const k = sum > P.caps.finderPerDay ? P.caps.finderPerDay / sum : 1;
    for (const p of list) {
      const amt = p.amount * k;
      addXp(p.finder, 'review', amt, p.at, p.kind + ' (' + p.flaw.signal + ' ' + p.flaw.severity + ')', p.flaw.id);
      addSample(p.finder, 'review', 1, Math.min(C.findingWeightMax, amt / C.findingWeightDivisor), p.at, p.kind, p.flaw.id);
    }
  }

  /* reviewer approvals: escrow, with the approval sample's quality set by the outcome. The credit is 0.3 x the work's
     CAPPED points, so approving big work never pays more than writing it; one approval per reviewer per
     piece of work in the rollup window, so three verdicts on one plan pay once */
  const A_of = a => P.review.approvalShare * Math.min(P.caps.xpPerUnit, a.prSizePts || 0) * (a.vReviewer || 0) * (a.scopeShare == null ? 1 : a.scopeShare);
  const accOf = a => Date.parse(a.acceptedAt || a.at);
  const itemOf = a => (a.source && (a.source.subject || a.source.pr)) || (a.links && a.links.pr) || a.key || a.id;
  // the piece of work an approval is about: the author's rolled-up unit when there is one (four slices of one feature
  // are one piece of work for the reviewer too), else the PR or document
  const subjOf = a => { const u = ((a.links || {}).parents || []).map(id => unitOf.get(id)).find(Boolean); return u ? 'unit:' + u.id : itemOf(a); };
  const aGroups = {};
  for (const a of valid.filter(r => r.signal === 'review.approve').map(E)) { if (a.void || !isCrew(a.agent)) continue; (aGroups[a.agent + '|' + subjOf(a)] = aGroups[a.agent + '|' + subjOf(a)] || []).push(a); }
  const approvals = [];
  for (const list of Object.values(aGroups)) {
    list.sort((x, y) => accOf(x) - accOf(y));
    let cluster = [];
    const flush = () => {
      if (!cluster.length) return;
      const best = cluster.slice().sort((x, y) => ((x.pending ? 1 : 0) - (y.pending ? 1 : 0)) || (A_of(y) - A_of(x)))[0];
      if (cluster.length === 1) { approvals.push(best); cluster = []; return; }
      // one approval for the whole piece: sized by its distinct PRs/documents together (the same document twice counts once)
      const sizeBy = {}; for (const a of cluster) sizeBy[itemOf(a)] = Math.max(sizeBy[itemOf(a)] || 0, a.prSizePts || 0);
      const parents = [...new Set(cluster.flatMap(a => (a.links || {}).parents || []))], files = [...new Set(cluster.flatMap(a => a.files || []))];
      approvals.push(Object.assign({}, best, { prSizePts: Object.values(sizeBy).reduce((s, x) => s + x, 0), links: Object.assign({}, best.links, { parents }), files }));
      notes.push(crew.nameOf(cluster[0].agent) + ' approved one piece of work ' + cluster.length + ' times within ' + P.rollup.windowDays + ' days (' + [...new Set(cluster.map(itemOf))].join(', ') + '): paid once');
      cluster = [];
    };
    for (const a of list) { if (cluster.length && accOf(a) - accOf(cluster[0]) > P.rollup.windowDays * DAY) flush(); cluster.push(a); }
    flush();
  }
  for (const a of approvals) {
    const A = A_of(a);
    if (a.pending) { addPending(a.agent, 'review', A, 'approval waiting (' + a.pending + ')', a.id); continue; }
    const acc = accOf(a);
    const parents = ((a.links || {}).parents || []);
    const pUnits = [...new Set(parents.map(id => unitOf.get(id)).filter(Boolean))];
    const scopeFiles = new Set(a.files || []);
    const inScope = f => !f.files || !f.files.length || f.files.some(x => scopeFiles.has(x)) || !scopeFiles.size;
    const postFlaws = flaws.filter(f => !f.inReview && parents.includes((f.links || {}).parent) && f.atMs >= acc && inScope(f));
    const due = acc + P.review.escrowDays * DAY;
    addXp(a.agent, 'review', A / 2, acc, 'approval (first half) ' + ((a.source || {}).pr || (a.source || {}).subject || ''), a.id);
    const voided = pUnits.some(u => u.void);
    if (now >= due) {
      const early = postFlaws.filter(f => f.atMs <= due);
      if (!early.length && !voided) addXp(a.agent, 'review', A / 2, due, 'approval (escrow half, nothing found in 14 days)', a.id);
      const dsum = postFlaws.reduce((s, f) => s + f.D, 0);
      const q = voided ? 0 : Math.max(0, 1 - dsum / ((a.prSizePts || 1)));
      addSample(a.agent, 'review', q, C.approvalWeightShare * (a.vReviewer || 0) * sizeWeight(P, a.prSizePts || 0) * (a.scopeShare == null ? 1 : a.scopeShare), acc, 'approval outcome', a.id);
    } else {
      addPending(a.agent, 'review', A / 2, 'approval escrow, due ' + localDay(due), a.id);
      if (postFlaws.length || voided) addPending(a.agent, 'review', 0, 'approved work drew a flaw before escrow ended', a.id);
    }
  }

  /* soft signals and process demerits (parentless, applied after their window unless amended) */
  const softs = valid.filter(r => r.kind === 'demerit' && r.soft).map(E);
  const used = new Set();
  // an "(own error)" row and an owner correction about the same person within the link window are one charge, owned up
  for (const own of softs.filter(s => s.signal === 'own-error')) {
    const t = Date.parse(own.at), win = P.soft.ownError.linkOwnerCorrectionHours * HOUR;
    const cands = softs.filter(s => s.signal === 'owner.correction' && s.agent === own.agent && !used.has(s.id));
    const hhmm = ms => localStamp(ms).slice(11);
    // the owner message the row names ("His 16:33 message"), else the nearest correction before the row inside the window
    const corr = cands.find(s => (own.msgTimes || []).includes(hhmm(Date.parse(s.at))) && localDay(Date.parse(s.at)) === localDay(t))
      || cands.filter(s => Date.parse(s.at) <= t && t - Date.parse(s.at) <= win).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (corr) { used.add(corr.id); own.mergedWith = corr.id; own.caught = (effOf(own) || {}).caught || corr.caught; corr.mergedInto = own.id; }
  }
  const softById = new Map(softs.map(s => [s.id, s]));
  for (const s of softs) {
    if (s.mergedInto) continue;
    const mw = s.mergedWith ? softById.get(s.mergedWith) : null;
    const e = effOf(s) || (mw ? effOf(mw) : null) || null;
    if (s.void || (e && e.void)) continue;
    const applies = Date.parse(s.appliesAt), amended = e && e.amendedAt;
    const applied = amended || now >= applies;
    const f = Object.assign({}, s, e && mw && !effOf(s) ? e : {});
    const D = demeritD(P, f);
    if (!applied) { waiting.push({ id: s.id, agent: s.agent, signal: s.signal, severity: f.severity, reach: f.reach, caught: f.caught, D: round(D), appliesAt: s.appliesAt, note: s.note, mergedWith: s.mergedWith || null }); continue; }
    if (!isCrew(f.agent)) continue;
    addSample(f.agent, f.bucket || 'planning', 0, sw(D), amended || applies, s.signal + ' ' + f.severity, s.id);
    if (P.seriousSeverities.includes(f.severity)) serious.push({ id: s.id, srcKey: s.srcKey || s.id, agent: f.agent, attribution: 'verified', severity: f.severity, signal: s.signal, at: s.at, D: round(D), source: s.source, evidence: s.evidence || [] });
  }
  for (const g of valid.filter(r => r.signal === 'process.merged-without-gate').map(E)) {
    if (g.void) continue;
    if (!isCrew(g.agent)) { notes.push('merged without gate, merger unknown: ' + (g.source || {}).ref); continue; }
    const D = demeritD(P, g);
    addSample(g.agent, g.bucket, 0, sw(D), Date.parse(g.at), 'merged without a premerge PASS record', g.id);
    if (P.seriousSeverities.includes(g.severity)) serious.push({ id: g.id, srcKey: g.srcKey || g.id, agent: g.agent, attribution: 'verified', severity: g.severity, signal: g.signal, at: g.at, D: round(D), source: g.source, evidence: g.evidence || [] });
  }

  /* per-person daily XP cap, then aggregate */
  const dayGroups = {};
  for (const x of xpItems) { const k = x.agent + '|' + localDay(x.at); (dayGroups[k] = dayGroups[k] || []).push(x); }
  for (const list of Object.values(dayGroups)) { const sum = list.reduce((s, x) => s + x.xp, 0); if (sum > P.caps.xpPerAgentPerDay) for (const x of list) x.xp *= P.caps.xpPerAgentPerDay / sum; }
  const buckets = Object.keys(P.buckets);
  const people = {};
  for (const id of crew.ids) {
    const row = { name: crew.nameOf(id), title: (crew.agents[id] || {}).title || '', xp: 0, pendingXp: 0, buckets: {} };
    for (const b of buckets) row.buckets[b] = { xp: 0, pendingXp: 0, samples: 0, weight: 0, competence: null, calibrating: true };
    people[id] = row;
  }
  for (const x of xpItems) { const p = people[x.agent]; if (!p) continue; const b = p.buckets[x.bucket] || p.buckets.build; b.xp += x.xp; p.xp += x.xp; }
  for (const x of pendingItems) { const p = people[x.agent]; if (!p) continue; const b = p.buckets[x.bucket] || p.buckets.build; b.pendingXp += x.xp; p.pendingXp += x.xp; }
  const acc = {};
  for (const s of samples) {
    const k = s.agent + '|' + s.bucket; const a = acc[k] = acc[k] || { dw: 0, dwq: 0, n: 0 };
    const d = Math.pow(0.5, Math.max(0, now - s.at) / (C.halfLifeDays * DAY));
    a.dw += d * s.w; a.dwq += d * s.w * s.q; a.n++;
  }
  for (const [k, a] of Object.entries(acc)) {
    const [agent, b] = k.split('|'); const p = people[agent]; if (!p || !p.buckets[b]) continue;
    const cell = p.buckets[b];
    cell.samples = a.n; cell.weight = round(a.dw, 3);
    cell.competence = round(100 * (a.dwq + C.k * C.prior) / (a.dw + C.k), 1);
    cell.calibrating = !(a.dw >= C.calibrateMinWeight && a.n >= C.calibrateMinSamples);
  }
  for (const p of Object.values(people)) { p.xp = round(p.xp, 2); p.pendingXp = round(p.pendingXp, 2); for (const c of Object.values(p.buckets)) { c.xp = round(c.xp, 2); c.pendingXp = round(c.pendingXp, 2); } }
  const pendingRulings = rulings.filter(r => !corrob.has(r.id)).map(r => ({ id: r.id, target: r.target, by: r.by, at: r.at }));
  return {
    v: 1, policy: P.version, collector: maxVer || null, computedAt: iso(now), shadowUntil: P.shadowUntil,
    ledger: { rows: all.length, scored: valid.length, head: all.length ? all[all.length - 1].hash : GENESIS },
    people, serious, waiting, attribution, unconfirmed, pendingRulings, notes,
    units: units.map(u => ({ id: u.id, agent: u.agent, bucket: u.bucket, cBase: round(u.cBase, 3), cXp: round(u.cXp, 3), v: round(u.v, 3), q: round(u.q, 4), charge: round(u.charge || 0, 3), void: u.void, members: u.members.map(m => m.id), flaws: u.flaws.map(f => ({ id: f.id, severity: f.severity, D: round(f.D, 3), charge: round(f.charge || 0, 3), settled: f.settled })) })),
    xpItems: xpItems.map(x => Object.assign({}, x, { xp: round(x.xp, 3), at: iso(x.at) })), samples: samples.map(s => Object.assign({}, s, { q: round(s.q, 4), w: round(s.w, 4), at: iso(s.at) })), pending: pendingItems.map(x => Object.assign({}, x, { xp: round(x.xp, 3) })),
  };
}

/* ---------------- outputs ---------------- */
function cell(c) {
  if (!c || (!c.samples && !c.xp && !c.pendingXp)) return 'no data';
  const parts = [];
  parts.push(Math.round(c.xp) + ' xp');
  if (c.competence != null) parts.push(Math.round(c.competence) + ' (' + c.samples + ' sample' + (c.samples === 1 ? '' : 's') + (c.calibrating ? ', calibrating' : '') + ')');
  else parts.push('no samples yet');
  if (c.pendingXp >= 0.5) parts.push('+' + Math.round(c.pendingXp) + ' pending');
  return parts.join(' · ');
}
function renderScoreboard(res, P, crew, extra) {
  const x = extra || {};
  const b = Object.keys(P.buckets);
  const L = [];
  const ref = s => ((s && s.source && s.source.ref) || '');
  const po = crew.hrId ? crew.nameOf(crew.hrId) + ' (people owner)' : 'the people owner';
  L.push('# Competence scoreboard (shadow mode)', '');
  L.push('Written by `company/tools/competence.js` on ' + localStamp(Date.parse(res.computedAt)) + ' (policy ' + res.policy + ', collector ' + (res.collector || '-') + '). **Shadow mode until ' + res.shadowUntil + ': nothing uses these numbers yet** — not routing, not merge depth, not StarNet levels. How it works and how to dispute: `company/work/people/COMPETENCE.md`.', '');
  L.push('Each cell: lifetime experience (xp) · competence 0–100 (samples). "calibrating" = too little evidence to read anything into (fewer than ' + P.competence.calibrateMinSamples + ' samples or a weight under ' + P.competence.calibrateMinWeight + '). "no data" = nothing verified yet; it is never filled from a proxy. Customer has no collector in v1.', '');
  L.push('| Person | ' + b.map(k => P.buckets[k].label).join(' | ') + ' | Total xp |');
  L.push('|---|' + b.map(() => '---').join('|') + '|---|');
  for (const id of Object.keys(res.people)) {
    const p = res.people[id];
    L.push('| ' + p.name + ' (' + p.title + ') | ' + b.map(k => (k === 'customer' && !p.buckets[k].samples) ? 'no data' : cell(p.buckets[k])).join(' | ') + ' | ' + Math.round(p.xp) + (p.pendingXp >= 0.5 ? ' (+' + Math.round(p.pendingXp) + ' pending)' : '') + ' |');
  }
  L.push('');
  L.push('## Serious flaws (S0/S1)', '');
  if (!res.serious.length) L.push('None confirmed.');
  for (const s of res.serious) L.push('- `' + s.id + '` ' + (s.agent ? crew.nameOf(s.agent) : 'unattributed') + ': ' + s.severity + ' ' + s.signal + ' (' + ref(s) + '), demerit ' + s.D + (s.attribution === 'work-unverified' ? ' — the work is not verified as theirs yet, so nothing is charged until ' + po + ' confirms it' : s.attribution === 'unattributed' ? ' — nobody attributed yet; ' + po + ' attributes it' : '') + '. Goes to ' + po + ' as an OPEN handoff, once.');
  L.push('', '## Waiting for ' + po + ' (soft signals: they apply at their default after ' + P.soft.applyAfterHours + ' hours unless amended)', '');
  if (!res.waiting.length) L.push('Nothing waiting.');
  for (const w of res.waiting) L.push('- `' + w.id + '` ' + crew.nameOf(w.agent) + ' — ' + w.signal + ', default ' + w.severity + ' ' + w.reach + ' caught ' + w.caught + ' = ' + w.D + ', applies ' + localStamp(Date.parse(w.appliesAt)) + (w.mergedWith ? ' (same incident as `' + w.mergedWith + '`, charged once)' : '') + '. ' + (w.note ? '"' + String(w.note).slice(0, 140) + '"' : ''));
  if (res.attribution && res.attribution.length) {
    L.push('', '## Waiting for attribution (' + po + ': `amend <id> --agent <name>` or `--void`)', '');
    for (const a of res.attribution) L.push('- `' + a.id + '` ' + a.severity + ' ' + a.signal + ' (' + ref(a) + '): ' + a.why + '.');
  }
  if (res.unconfirmed && res.unconfirmed.length) {
    L.push('', '## Unconfirmed findings (not counted for anyone)', '');
    for (const u of res.unconfirmed) L.push('- `' + u.id + '` ' + u.severity + ' (' + ref(u) + '): ' + u.why + '.');
  }
  if (res.pendingRulings.length) { L.push('', 'Amendments waiting for a matching run record: ' + res.pendingRulings.map(r => '`' + r.id + '` (' + r.by + ' on `' + r.target + '`)').join(', ') + '.'); }
  if (x.collect) {
    const c = x.collect;
    L.push('', '## Last collect', '');
    L.push('- merged PRs (company era): ' + (c.prs.companyEra || 0) + '; work credits ' + (c.prs.credits || 0) + ' (' + (c.prs.pending || 0) + ' pending verification); approvals ' + (c.prs.approvals || 0));
    L.push('- test records before merge: ' + (Object.entries(c.tests).map(([k, v]) => k + ' — ' + v).join('; ') || 'none'));
    L.push('- defect files: ' + (Object.entries(c.defects).map(([k, v]) => k + ' ' + v).join(', ') || 'none'));
    L.push('- verdict files: ' + (c.verdicts.files || 0) + ' read; document approvals ' + (c.verdicts.documentApprovals || 0) + ', conditional approvals ' + (c.verdicts.conditionalApprovals || 0) + ', classifications ' + (c.verdicts.classifications || 0) + ', in-review findings with a severity ' + (c.verdicts.inReviewFindings || 0) + (c.verdicts.skipped && c.verdicts.skipped.length ? '; not scored: ' + c.verdicts.skipped.join('; ') : '') + (c.verdicts.classificationsNoDefectFile ? '; classifications with no defect file: ' + c.verdicts.classificationsNoDefectFile.join(', ') : ''));
    L.push('- reverts ' + (c.reverts.reverts || 0) + ', fix-forward PRs ' + (c.reverts.fixForwards || 0) + (c.reverts.fixesOfKnownDefects ? ', fixes of known defects ' + c.reverts.fixesOfKnownDefects : '') + (c.reverts.unverifiedFixPRs ? ', fix PRs not verified ' + c.reverts.unverifiedFixPRs : ''));
    L.push('- gate audit (merges from ' + P.gateAuditFrom + '): ' + (c.gate.pass || 0) + ' with a PASS record, ' + (c.gate.withoutGate || 0) + ' without; ' + (c.gate.preRule || 0) + ' earlier merges not audited (the rule is not retroactive)' + (c.gate.passNotMatchedToRun ? '; PASS records no run matches: ' + c.gate.passNotMatchedToRun.join(', ') : ''));
    L.push('- soft: owner corrections ' + (c.soft.ownerCorrections || 0) + ', own-error rows ' + (c.soft.ownErrors || 0) + (c.soft.skipped && c.soft.skipped.length ? '; not counted: ' + c.soft.skipped.join('; ') : ''));
    if (c.errors.length) L.push('- errors: ' + c.errors.join('; '));
  }
  if (res.notes.length) L.push('', 'Notes: ' + res.notes.join('; '));
  const v = x.verify;
  L.push('', 'Ledger: `company/work/people/competence-events.jsonl`, ' + res.ledger.rows + ' rows (' + res.ledger.scored + ' scored), head `' + res.ledger.head + '`' + (v ? (v.ok ? ' (chain verified; ' + v.unanchored + ' rows after the last anchor)' : ' (**chain problem: ' + v.problems.length + '**, run `competence.js verify`)') : '') + '.');
  return L.join('\n') + '\n';
}
function writeScoreboard(res, P, crew, extra) { const txt = renderScoreboard(res, P, crew, extra); atomicWrite(F.scoreboard, txt); return txt; }

/* serious flags: an OPEN handoff to the people owner per confirmed S0/S1 event, once, with an FYI to the person's manager */
function seriousFlags(res, crew, state, opt) {
  const o = Object.assign({ dry: false, log: () => {} }, opt || {});
  state.flagged = state.flagged || {};
  const hr = crew.hrId; const issued = [];
  const day = localDay(Date.now());
  const append = (inbox, heading, fields) => {
    const f = path.join(F.handoffs, inbox);
    const block = '\n## ' + day + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + v).join('\n') + '\n';
    if (!o.dry) fs.appendFileSync(f, block);
  };
  for (const s of res.serious) {
    const key = s.srcKey || s.id;
    if (state.flagged[key] || state.flagged[s.id]) continue;
    const known = !!(s.agent && crew.agents[s.agent]);
    const name = known ? crew.nameOf(s.agent) : null;
    const who = known ? crew.agents[s.agent] : {};
    const charged = known && s.attribution !== 'work-unverified';
    const mgrId = charged ? (who.manager || null) : null, mgr = mgrId ? crew.agents[mgrId] : null;
    const hrRow = hr ? crew.agents[hr] : null;
    // the people owner's own flaw goes to their manager; everyone else's (and every unattributed one) to the people owner
    // (company/MODEL_POLICY.md people process)
    const toId = charged && s.agent === hr ? (mgrId || hr) : hr;
    const to = toId && crew.agents[toId] && crew.agents[toId].inbox;
    if (!to) { o.log('SERIOUS FLAG ' + s.id + ' has nowhere to go (no people-owner inbox in loops.json)'); continue; }
    const toName = crew.nameOf(toId);
    const amendCmd = '`node company/tools/competence.js amend ' + s.id + ' --by ' + toName + ' --reason "<why>" [--agent <name>] [--severity S2] [--void]`';
    const heading = 'competence serious flag: ' + (name || 'unattributed') + ', ' + s.severity + ' (' + s.id + ')';
    const need = s.attribution === 'unattributed'
      ? 'a confirmed ' + s.severity + ' flaw that nobody is attributed to yet. Find who wrote it and attribute it with ' + amendCmd + ', or void it if it is not a flaw; then decide with that person\'s manager what, if anything, changes: a fix to the cause, coaching, a model change, or nothing. Shadow mode: the score itself changes nothing yet. Close this handoff with what you decided.'
      : s.attribution === 'work-unverified'
        ? 'look at this confirmed ' + s.severity + ' flaw. The work it is in names ' + name + ' as the author, but no run record shows ' + name + ' making that commit, so nothing is charged yet. Confirm it with ' + amendCmd.replace('[--agent <name>]', '--agent ' + name) + ' or re-attribute or void it, then decide with ' + name + "'s manager what, if anything, changes. Shadow mode: the score itself changes nothing yet. Close this handoff with what you decided."
        : 'look at this confirmed ' + s.severity + ' flaw and decide with ' + (mgr && mgrId !== toId ? name + "'s manager " + mgr.name : 'the record') + ' what, if anything, changes: a fix to the cause, coaching, a model change, or nothing. If the severity, reach or attribution is wrong, amend it: ' + amendCmd + '. Shadow mode: the score itself changes nothing yet. Close this handoff with what you decided.';
    append(to, heading, {
      Need: need,
      Why: s.signal + ' recorded by `company/tools/competence.js` from ' + ((s.source && s.source.ref) || 'the ledger') + ' (demerit ' + s.D + ').',
      Deadline: 'today', Status: 'OPEN',
      Evidence: '`company/work/people/scoreboard.md`; ledger row `' + s.id + '` in `company/work/people/competence-events.jsonl`' + (s.evidence && s.evidence.length ? '; ' + s.evidence.slice(0, 2).map(e => '`' + e + '`').join(', ') : ''),
    });
    if (mgr && mgr.inbox && mgrId !== toId) append(mgr.inbox, 'FYI: ' + heading, {
      Need: 'nothing yet. ' + ((hrRow && hrRow.name) || 'The people owner') + ' (people owner) is looking at it and will come to you before anything changes for ' + name + '.',
      Why: s.signal + ' (' + s.severity + ')', Deadline: 'none', Status: 'DONE — FYI', Evidence: '`company/work/people/scoreboard.md`',
    });
    state.flagged[key] = new Date().toISOString();
    issued.push(s.id);
    o.log('COMPETENCE SERIOUS FLAG ' + (name || 'unattributed') + ' ' + s.severity + ' ' + s.id + ' — handed to ' + to.replace(/^to-|\.md$/g, ''));
  }
  return issued;
}
function anchor(verifyRes, state, opt) {
  const o = Object.assign({ dry: false }, opt || {});
  if (!verifyRes.rows || state.lastAnchor === verifyRes.head || (state.anchors || []).some(a => a.head === verifyRes.head)) return null;
  if (!verifyRes.ok) return null;   // never anchor a broken chain
  const line = '| ' + localStamp(Date.now()) + ' | Competence ledger anchor: ' + verifyRes.rows + ' events, head `' + verifyRes.head + '` (tamper-evident: `competence.js verify` checks the ledger still matches this row) | Dispatcher (competence.js daily) | `company/work/people/competence-events.jsonl` |\n';
  if (!o.dry) {
    const cur = readText(F.decisions) || '';
    fs.appendFileSync(F.decisions, (cur && !cur.endsWith('\n') ? '\n' : '') + line);
    state.lastAnchor = verifyRes.head;
    state.anchors = (state.anchors || []).concat([{ n: verifyRes.rows, head: verifyRes.head, at: new Date().toISOString() }]).slice(-400);
  }
  return line.trim();
}

/* ---------------- amend (the people owner's ruling, with a recorded reason) ---------------- */
function amend(id, a) {
  const P = loadPolicy(), crew = loadCrew();
  const rows = readLedger();
  const target = rows.find(r => r.id === id);
  const refuse = m => { const e = new Error(m); e.code = 2; throw e; };
  if (!target) refuse('no ledger event ' + id);
  if (target.kind === 'ruling' || target.kind === 'record') refuse(id + ' is a ' + target.kind + ' row; amend the event it is about');
  const byId = crew.idOf(a.by);
  if (!byId) refuse('--by must be a crew member (name or id)');
  const reason = String(a.reason || '').trim();
  if (reason.length < (P.amend.minReasonChars || 10)) refuse('--reason is required (at least ' + (P.amend.minReasonChars || 10) + ' characters): say why');
  // events about the people owner are ruled on by someone independent of them: policy amend.hrSelfReviewers (station
  // ids) if set, else the risk and finance function holders and the people owner's manager
  const hr = crew.hrId;
  const selfReviewers = [...new Set((P.amend.hrSelfReviewers || []).concat([crew.holder('risk'), crew.holder('finance'), hr && (crew.agents[hr] || {}).manager]))]
    .filter(x => x && x !== hr && crew.ids.has(x));
  const selfMsg = () => 'events about the people owner (' + crew.nameOf(hr) + ') are amended by ' + (selfReviewers.length ? selfReviewers.map(crew.nameOf).join(' or ') : 'nobody yet: no independent seat (risk, finance or a manager) exists');
  const subject = target.agent;
  if (subject && subject === byId) refuse('nobody amends their own events');
  if (subject && subject === hr) { if (!selfReviewers.includes(byId)) refuse(selfMsg()); }
  else if (byId !== hr) refuse('only ' + crew.nameOf(hr) + ' (the people owner) amends events');
  if (target.finder === byId || (target.verifiers || []).some(v => v.agent === byId)) refuse(crew.nameOf(byId) + ' is the finder or verifier of this event, so cannot rule on it');
  const changes = {};
  if (a.severity !== undefined) { if (!SEV.includes(String(a.severity))) refuse('--severity must be one of ' + SEV.join(', ')); changes.severity = String(a.severity); }
  if (a.reach !== undefined) { if (!REACH.includes(String(a.reach))) refuse('--reach must be one of ' + REACH.join(', ')); changes.reach = String(a.reach); }
  if (a.caught !== undefined) { if (!CAUGHT.includes(String(a.caught))) refuse('--caught must be one of ' + CAUGHT.join(', ')); changes.caught = String(a.caught); }
  if (a.agent !== undefined) { const ag = crew.idOf(a.agent); if (!ag) refuse('--agent must be a crew member'); if (ag === byId) refuse('nobody attributes an event to themselves'); if (ag === hr && byId === hr) refuse(selfMsg()); changes.agent = ag; }
  if (a.bucket !== undefined) { if (!P.buckets[a.bucket]) refuse('--bucket must be one of ' + Object.keys(P.buckets).join(', ')); changes.bucket = String(a.bucket); }
  if (a.void) changes.void = true;
  if (a.uphold) changes.uphold = true;
  if (!Object.keys(changes).length) refuse('nothing to change: pass --uphold, --void, --severity, --reach, --caught, --agent or --bucket');
  const at = new Date().toISOString();
  const row = { schema: 1, policy: P.version, writer: 'competence.js amend', kind: 'ruling', signal: 'ruling', agent: subject, bucket: target.bucket, at, target: id, by: crew.nameOf(byId), byAgent: byId, changes, reason,
    id: mkId('ruling', id, byId, target.bucket, 'ruling', at + '|' + canon(changes)) };
  return appendRows([row])[0];
}

/* ---------------- commands ---------------- */
function show(res, crew, agentArg, rows) {
  const out = [];
  const ids = agentArg ? [crew.idOf(agentArg)].filter(Boolean) : Object.keys(res.people);
  if (agentArg && !ids.length) { out.push('no crew member "' + agentArg + '"'); return out.join('\n'); }
  for (const id of ids) {
    const p = res.people[id];
    out.push(p.name + ' (' + id + ', ' + p.title + '): ' + Math.round(p.xp) + ' xp' + (p.pendingXp >= 0.5 ? ' (+' + Math.round(p.pendingXp) + ' pending)' : '') + ' | ' + Object.entries(p.buckets).map(([b, c]) => b + ' ' + cell(c)).join(' | '));
    if (agentArg) {
      out.push('  experience:'); for (const x of res.xpItems.filter(x => x.agent === id)) out.push('    +' + x.xp + ' ' + x.bucket + ' ' + x.why + ' `' + x.id + '`');
      out.push('  competence samples:'); for (const s of res.samples.filter(x => x.agent === id)) out.push('    q ' + s.q + ' w ' + s.w + ' ' + s.bucket + ' ' + s.why + ' `' + s.id + '`');
      out.push('  pending:'); for (const x of res.pending.filter(x => x.agent === id)) out.push('    ' + x.xp + ' ' + x.bucket + ' ' + x.why + ' `' + x.id + '`');
      const maxVer = res.collector || 1;
      out.push('  ledger rows about ' + p.name + ' (scored collector ' + maxVer + '):'); for (const r of rows.filter(r => (r.agent === id || r.finder === id) && (r.writer !== COLLECT_WRITER || (Number(r.collector) || 1) === maxVer))) out.push('    ' + r.id + ' ' + r.kind + ' ' + r.signal + (r.severity ? ' ' + r.severity : '') + ' ' + ((r.source || {}).ref || r.target || '') + (r.pending ? ' [pending: ' + r.pending + ']' : ''));
    }
  }
  return out.join('\n');
}
// decisions.md and the dispatch log roll monthly (company/tools/retention.js, docs/RETENTION.md): an anchor row that rolled
// out of the live file is copied, as it moves, to <dir>/archive/<name>/index.md, so the anchors are the live file plus
// that index — every anchor ever written, without reading every month of the archive
function anchorText(file) {
  const live = readText(file);
  const idx = readText(path.join(path.dirname(file), 'archive', path.basename(file, '.md'), 'index.md'));
  return live == null && idx == null ? null : (idx ? idx + '\n' : '') + (live || '');
}
function verifyNow(rows) {
  return verifyLedger(rows, anchorText(F.decisions), { stateAnchors: stateAnchorsOf(readJson(F.state, {}), rows), logText: anchorText(F.dispatchLog) });
}
async function daily(a) {
  const P = loadPolicy(), crew = loadCrew();
  const ledgerOnly = !!a['ledger-only'];
  const state = readJson(F.state, {});
  const today = localDay(Date.now());
  if (!a.force && !ledgerOnly && state.lastDaily === today) return { skipped: 'already ran today (' + today + ')' };
  const summary = { day: today, mode: ledgerOnly ? 'ledger-only' : 'full' };
  const logs = [];
  let col = null;
  try { col = await collect({ saveState: !ledgerOnly }); summary.collect = { seen: col.seen, written: col.written, byPerson: col.byPerson, errors: col.errors }; } catch (e) { summary.collectError = e.message; }
  const rows = readLedger();
  const ver = verifyLedger(rows, anchorText(F.decisions), { stateAnchors: stateAnchorsOf(state, rows), logText: anchorText(F.dispatchLog) });
  summary.verify = { ok: ver.ok, rows: ver.rows, unanchored: ver.unanchored, problems: ver.problems.slice(0, 5) };
  const res = compute(rows, P, crew, Date.now());
  if (!ledgerOnly) atomicWrite(F.out, JSON.stringify(res, null, 1) + '\n');
  writeScoreboard(res, P, crew, { collect: col, verify: ver });
  summary.serious = res.serious.length; summary.waiting = res.waiting.length; summary.attribution = res.attribution.length;
  if (!ledgerOnly) {
    if (!Array.isArray(state.anchors)) state.anchors = stateAnchorsOf(state, rows).filter(x => x.n);
    try { summary.flagsIssued = seriousFlags(res, crew, state, { log: l => logs.push(l) }); } catch (e) { summary.flagError = e.message; }
    try { summary.anchor = anchor(ver, state) ? 'anchored ' + ver.rows + ' rows, head ' + ver.head : 'unchanged'; } catch (e) { summary.anchorError = e.message; }
    state.lastDaily = today; state.lastDailyAt = new Date().toISOString();
    atomicWrite(F.state, JSON.stringify(state, null, 1) + '\n');
  }
  summary.log = logs;
  return summary;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  try {
    if (cmd === 'collect') { const r = await collect({ dry: !!a['dry-run'] }); console.log(JSON.stringify(r, null, 1)); return 0; }
    if (cmd === 'compute') { const P = loadPolicy(), crew = loadCrew(); const res = compute(readLedger(), P, crew, Date.now()); atomicWrite(F.out, JSON.stringify(res, null, 1) + '\n'); console.log('wrote ' + rel(F.out) + ': ' + res.ledger.rows + ' rows (' + res.ledger.scored + ' scored), ' + res.serious.length + ' serious, ' + res.waiting.length + ' waiting, ' + res.attribution.length + ' waiting for attribution'); return 0; }
    if (cmd === 'show') { const P = loadPolicy(), crew = loadCrew(); const rows = readLedger(); console.log(show(compute(rows, P, crew, Date.now()), crew, a.agent, rows)); return 0; }
    // The tamper check must not read an array scoring has already touched: compute() writes its own scoring
    // fields onto the row objects it is given, so verifying AFTER compute reports rows as edited on a clean ledger.
    // daily() verifies before compute too.
    if (cmd === 'scoreboard') { const P = loadPolicy(), crew = loadCrew(); const rows = readLedger(); const ver = verifyNow(rows); const res = compute(rows, P, crew, Date.now()); writeScoreboard(res, P, crew, { verify: ver }); console.log('wrote ' + rel(F.scoreboard)); return 0; }
    if (cmd === 'verify') { const r = verifyNow(readLedger()); console.log(JSON.stringify(r, null, 1)); return r.ok ? 0 : 1; }
    if (cmd === 'amend') { const row = amend(a._[1], a); console.log('recorded ruling ' + row.id + ' on ' + row.target + ': ' + JSON.stringify(row.changes) + ' — it counts once the run records show ' + row.by + "'s run ran this amend command (next daily collect)"); return 0; }
    if (cmd === 'daily') { const r = await daily(a); console.log(JSON.stringify(r)); return 0; }
    if (cmd === 'selftest') return require(path.join(__dirname, 'tests', 'fixtures', 'competence', 'cases.js')).run(module.exports);
    console.log('usage: competence.js collect [--dry-run] | compute | show [--agent <name>] | scoreboard | verify | amend <ev_id> --by <name> --reason "<why>" [...] | daily [--ledger-only] [--force] | selftest');
    return 2;
  } catch (e) {
    console.error('competence: ' + e.message);
    return e.code === 2 ? 2 : 1;
  }
}

module.exports = { compute, verifyLedger, appendRows, readLedger, rowHash, mkId, canon, parseVerdictFile, parseDefect, parseOwnErrors, parseFindings, testRecordSignal, testRecordRun, verdictOf, findVerdict, reviewerNameOf,
  anchorText, commitAuthorName, prAuthorName, scopeShareOf, sizeFiles, sectionLines, demeritD, loadPolicy, loadCrew, makeCrew, renderScoreboard, amend, anchor, localDay, localStamp, seriousFlags, runIndex, globRe, withLock,
  commitEffect, commitNeedles, subjectNeedle, ghPrCmd, gatePassFor, amendMatches, lateRuns, stateAnchorsOf, parseLogAnchors, sevOf, setTimeZone, offsetMin, FILES: F, GENESIS, COLLECT_WRITER };
if (require.main === module) main().then(c => process.exit(c || 0), e => { console.error('competence: ' + e.message); process.exit(1); });
