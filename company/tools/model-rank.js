#!/usr/bin/env node
/* model-rank.js — the house ranking: which model (and effort) does each kind of our work best for the money
 * (docs/RANKING.md). Measurement only: it routes nothing. Proposals it writes are records (shadow); applying one is a
 * later, owner-switched step.
 *
 *   node company/tools/model-rank.js refresh [--force] [--dry-run] [--now <ms>]   recompute; rewrite the files only when
 *                                         the computed body changed (the dispatcher runs this at most every
 *                                         refreshMinutes, default hourly)
 *   node company/tools/model-rank.js show [--json]        the stored ranking (company/work/models/house-ranking.md|json)
 *   node company/tools/model-rank.js compute [--now <ms>] the ranking computed now, printed (writes nothing)
 *   node company/tools/model-rank.js verify               the history file's hash chain (exit 1 on a break)
 *   node company/tools/model-rank.js decide <proposal id> --verdict noted|declined --by <seat> [--reason "..."]
 *                                         record that a routing proposal was looked at (nothing is applied)
 *   node company/tools/model-rank.js --duty               read-only: due (exit 1) when a routing proposal is open
 *   node company/tools/model-rank.js --selftest           offline checks (the golden fixture in tests/fixtures/ranking)
 *
 * The unit is the handoff ITEM, not the run. company/state/wakes.jsonl (lib/wakes.js) links each item to the runs that
 * worked it; a run that worked several items splits its cost evenly between them, and a delegated child run (lib/family.js)
 * is costed with its lead's run. Cell = (task class, model, effort): the class from lib/taskclass.js, the model the
 * provider SERVED (runs.jsonl servedModel) or, when the row does not say, the model requested, marked claimed. Signals:
 * one-shot (accepted with no REVISE verdict, no reopen, revert or fix-forward within the window), rework (extra runs and
 * REVISE rounds), defects (competence ledger, by severity), premerge first-time pass, owner corrections, cost per item
 * (usd for metered runs; subscription runs priced from list prices, and their window share as its own column) and tail
 * cost. Score = the lower bound of the one-shot rate's interval / cost per item; a cell needs minItems before it can
 * steer anything. Every rule, threshold and weight: company/work/models/ranking-policy.json (default
 * company/defaults/work/models/ranking-policy.json). No policy file: nothing is ranked.
 *
 * Writes (refresh only): company/work/models/house-ranking.json and .md (overwritten, only when the body changed),
 * company/work/models/house-ranking-history.jsonl (one hash-chained row per change; retention rolls it monthly),
 * company/work/models/routing-proposals.jsonl (proposal and decision rows; rolled monthly), company/state/model-rank.json
 * (when it last checked). Reads every input bounded, from its end (lib/bounded.js). No socket, no model run.
 * Owner: the people function (the model manager).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const B = require('./lib/bounded');
const W = require('./lib/wakes');
const F = require('./lib/family');
const TC = require('./lib/taskclass');

const DAY = 86400e3, MIN = 60e3;
const GENESIS = 'sha256:genesis';

/* ---------------- small helpers ---------------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]); return o; }
  return v;
}
const canon = v => JSON.stringify(sortKeys(v));
const rnd = (x, d) => { if (x == null || !Number.isFinite(Number(x))) return null; const f = 10 ** (d == null ? 6 : d); return Math.round(Number(x) * f) / f; };
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const iso = ms => new Date(ms).toISOString();
const field = (sec, name) => { const m = String(sec).match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };

function paths(root) {
  const r = root || co.ROOT; const J = (...a) => path.join(r, ...a);
  return {
    root: r,
    policy: J('company', 'work', 'models', 'ranking-policy.json'),
    policyDefault: J('company', 'defaults', 'work', 'models', 'ranking-policy.json'),
    json: J('company', 'work', 'models', 'house-ranking.json'),
    md: J('company', 'work', 'models', 'house-ranking.md'),
    history: J('company', 'work', 'models', 'house-ranking-history.jsonl'),
    proposals: J('company', 'work', 'models', 'routing-proposals.jsonl'),
    state: J('company', 'state', 'model-rank.json'),
    wakes: J('company', 'state', 'wakes.jsonl'),
    admit: J('company', 'state', 'admit-log.jsonl'),
    runs: J('.starnet-data', 'workspaces', 'runs.jsonl'),
    handoffs: J('company', 'work', 'handoffs'),
    ledger: J('company', 'work', 'people', 'competence-events.jsonl'),
    corrections: J('company', 'work', 'people', 'corrections-log.jsonl'),
    evidence: J('company', 'work', 'evidence'),
    loops: J('company', 'tools', 'loops.json'),
  };
}

/* the policy: the company's copy, else the default shipped with it; none = nothing is ranked */
function loadPolicy(root) {
  const P = paths(root);
  for (const [f, source] of [[P.policy, 'company/work/models/ranking-policy.json'], [P.policyDefault, 'company/defaults/work/models/ranking-policy.json']]) {
    const j = readJson(f, null);
    if (j && typeof j === 'object' && !Array.isArray(j)) return { policy: j, source };
  }
  return null;
}
// the numbers the code needs, read from the policy (a missing key is read as "off"/0, never as a hidden default)
function knobs(P) {
  const g = (o, k, d) => (o && o[k] !== undefined ? o[k] : d);
  const sig = g(P, 'signals', {}) || {};
  return {
    refreshMin: clamp(num(P.refreshMinutes, 60), 60, 1440),
    windowDays: Math.max(1, num(P.windowDays, 30)),
    oneShotDays: Math.max(0, num(P.oneShotWindowDays, 0)),
    countUnsettled: P.countUnsettled === true,
    minItems: Math.max(1, num(P.minItems, 1)),
    confidence: clamp(num(g(P.interval, 'confidence', 0.8), 0.8), 0.5, 0.999),
    scoreCost: ['usd', 'listUsd', 'windowTokens'].includes(g(P.score, 'cost')) ? P.score.cost : 'listUsd',
    scorePer: g(P.score, 'per') === 'change' ? 'change' : 'item',
    sig: k => sig[k] === true,
    failOn: new Set(Array.isArray(g(P.oneShot, 'failOn')) ? P.oneShot.failOn : []),
    vFail: (g(P.verdicts, 'fail') || []).map(s => String(s).toUpperCase()),
    vPass: (g(P.verdicts, 'pass') || []).map(s => String(s).toUpperCase()),
    requireCheck: g(P.verdicts, 'requireCheck') !== false,
    wLead: num(g(P.weights, 'leadOnOwnReport'), 1), wOther: num(g(P.weights, 'other'), 1),
    defectSignals: new Set(g(P.defects, 'signals') || []), severity: g(P.defects, 'severity') || {},
    revertSignals: new Set(g(P.rework, 'revert') || []), fixSignals: new Set(g(P.rework, 'fixForward') || []),
    ocSignals: new Set(g(P.ownerCorrections, 'ledgerSignals') || []), ocLine: g(P.ownerCorrections, 'handoffLine') || null,
    excludeKinds: new Set(g(P.exclude, 'runKinds') || []),
    prices: g(P.cost, 'listPrices') || {}, outputShare: clamp(num(g(P.cost, 'outputShare'), 0), 0, 1),
    windowProviders: new Set(g(g(P.cost, 'window'), 'providers') || []), cachedWeight: num(g(g(P.cost, 'window'), 'cachedWeight'), 0),
    pct: clamp(num(g(P.tail, 'percentile'), 0.9), 0.5, 1), hardest: clamp(num(g(P.tail, 'hardestShare'), 0.1), 0.01, 1),
    driftPoints: num(g(P.graders, 'driftPoints'), 25), minVerdicts: Math.max(1, num(g(P.graders, 'minVerdicts'), 10)),
    pMode: String(g(P.proposals, 'mode') || 'shadow'), margin: Math.max(0, num(g(P.proposals, 'margin'), 0)),
    requireRouteData: g(P.proposals, 'requireRouteData') !== false, allowClaimed: g(P.proposals, 'allowClaimed') === true,
    rb: Object.assign({ runsMaxBytes: 64 * B.MB, handoffMaxBytes: 8 * B.MB, ledgerMaxBytes: 16 * B.MB, correctionsMaxBytes: 4 * B.MB, evidenceMaxFiles: 2000 }, P.readBounds || {}),
  };
}
const policyDigest = P => 'sha256:' + sha(canon(P)).slice(0, 16);

/* ---------------- statistics ---------------- */
// inverse standard normal CDF (Acklam), for the z of a two-sided interval
function zOf(confidence) {
  const p = 1 - (1 - confidence) / 2;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= 1 - pl) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}
// lower bound of the Wilson score interval for `successes` (may be fractional: half-weight verdicts) out of n
function wilsonLower(successes, n, z) {
  if (!n) return null;
  const p = clamp(successes / n, 0, 1), z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}
function percentile(sorted, p) { if (!sorted.length) return null; return sorted[clamp(Math.ceil(p * sorted.length) - 1, 0, sorted.length - 1)]; }
const median = s => { if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------------- runs ---------------- */
// the same buckets as model-stats.js, plus the dispatch-slice cut of a delegated child
function runKind(r, delivery) {
  if (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') return 'refused';
  if (r.reason === 'done') return 'finished';
  if (r.reason === 'max_iters') return 'outOfSteps';
  if (r.reason === 'budget') return 'outOfBudget';
  if (r.reason === 'error' || r.reason === 'empty') return 'providerError';
  if (r.reason === 'cancelled' || r.reason === 'interrupted') {
    const dd = (delivery && delivery.get(r.runId)) || r.dispatchDelivery || null;
    if (r.parentRunId && dd && dd.reason === 'timeout') return 'sliceCut';
    return 'stopped';
  }
  return 'other';
}
const normModel = m => String(m || '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase();
function priceOf(prices, model) {
  const m = normModel(model); let best = null;
  for (const k of Object.keys(prices || {})) { if (k.startsWith('_') || k === 'asOf') continue; const p = prices[k]; if (!p || typeof p !== 'object') continue; if (m.startsWith(k.toLowerCase()) && (!best || k.length > best.k.length)) best = { k, p }; }
  return best ? best.p : null;
}
function runCost(r, K) {
  const tokens = Math.max(0, num(r.tokens, 0)), cached = clamp(num(r.cachedTokens, 0), 0, tokens), unc = tokens - cached;
  const metered = r.unmetered !== true;
  const usd = metered ? Math.max(0, num(r.usd, 0)) : 0;
  let listUsd = usd, unpriced = false;
  if (!metered) {
    const p = priceOf(K.prices, r.servedModel || r.model);
    if (p) { const out = unc * K.outputShare; listUsd = ((unc - out) * num(p.input, 0) + cached * num(p.cachedRead, 0) + out * num(p.output, 0)) / 1e6; } else { listUsd = 0; unpriced = true; }
  }
  const windowTokens = K.windowProviders.has(String(r.provider || '')) ? unc + cached * K.cachedWeight : 0;
  return { usd, listUsd, windowTokens, unpriced };
}

/* ---------------- handoffs ---------------- */
// every inbox and its archive (the same files lib/wakes.js doneItems reads), each read bounded from its end
function handoffFiles(root, sinceMs, maxBytes) {
  const dir = paths(root).handoffs, arch = path.join(dir, 'archive');
  const sinceMonth = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString().slice(0, 7) : '0000-00';
  const out = [];
  const ls = d => { try { return fs.readdirSync(d).sort(); } catch (_) { return []; } };
  const add = (file, p) => { try { out.push({ file, text: B.tailText(p, maxBytes) }); } catch (_) {} };
  for (const f of ls(dir)) if (/^[A-Za-z0-9_.-]+\.md$/.test(f) && f !== 'README.md') add(f, path.join(dir, f));
  for (const f of ls(arch)) {
    if (/\.md$/.test(f)) add(f, path.join(arch, f));
    else for (const m of ls(path.join(arch, f))) if (/^\d{4}-\d{2}\.md$/.test(m) && m.slice(0, 7) >= sinceMonth) add(f + '.md', path.join(arch, f, m));
  }
  return out;
}
function sectionsOf(files) {
  const SP = require('./lib/sprint');
  const out = [];
  for (const { file, text } of files || []) for (const sec of String(text || '').split(/^## /m).slice(1)) {
    const it = SP.parseItems('## ' + sec)[0]; if (!it) continue;
    out.push({ file, id: W.itemId(file, it.heading, it.id), heading: it.heading, text: '## ' + sec, effort: it.effort });
  }
  return out;
}
// PR references in a block: **PR:** lines and pull-request URLs -> "repo#n" (or "#n" when no repo is named)
function prRefs(text) {
  const out = new Set(); const s = String(text || '');
  for (const m of s.matchAll(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/gi)) out.add(m[1].toLowerCase() + '#' + m[2]);
  for (const m of s.matchAll(/^\*\*PR:\*\*\s*(.+)$/gim)) for (const x of m[1].matchAll(/(?:([\w.-]+\/)?([\w.-]+))?#(\d+)/g)) out.add((x[2] ? x[2].toLowerCase() : '') + '#' + x[3]);
  return [...out].sort();
}
function prKey(ref) {
  const s = String(ref || ''); let m = s.match(/([\w.-]+)#(\d+)\s*$/); if (m) return m[1].split('/').pop().toLowerCase() + '#' + m[2];
  m = s.match(/\/([\w.-]+)\/pull\/(\d+)/); return m ? m[1].toLowerCase() + '#' + m[2] : null;
}
const prMatches = (itemRefs, key) => !!key && itemRefs.some(r => r === key || (r.startsWith('#') && key.endsWith(r)));

/* the seat a name in a verdict line means: a seat id or display name in loops.json */
function seatByName(text, crew) {
  const t = String(text || '').trim().toLowerCase(); if (!t) return null;
  const cand = [];
  for (const [id, s] of Object.entries(crew || {})) for (const n of [id, s && s.name].filter(Boolean)) { const nn = String(n).toLowerCase(); if (t === nn || t.startsWith(nn + ' ') || t.startsWith(nn + ',') || t.startsWith(nn + ';')) cand.push({ id, len: nn.length }); }
  cand.sort((a, b) => b.len - a.len || (a.id < b.id ? -1 : 1));
  return cand.length ? cand[0].id : null;
}
function verdictsIn(text, K, crew) {
  const out = [];
  for (const m of String(text || '').matchAll(/^\*\*(?:Verdict|Review):\*\*\s*(.+)$/gim)) {
    const line = m[1].replace(/[`*_]/g, '').trim();
    const head = line.toUpperCase().replace(/\s+/g, '-');
    const pick = list => list.filter(w => head.startsWith(w)).sort((a, b) => b.length - a.length)[0] || null;
    const fail = pick(K.vFail), pass = pick(K.vPass);
    const word = fail && (!pass || fail.length >= pass.length) ? fail : pass;
    if (!word) continue;
    const byM = line.match(/\bby\s+(.+)$/i);
    const by = byM ? seatByName(byM[1], crew) : null;
    out.push({ word, fail: word === fail, by, check: /\bcheck:\s*\S/i.test(line) });
  }
  return out;
}

/* ---------------- loading (bounded reads) ---------------- */
function load(o) {
  o = o || {};
  const root = o.root || co.ROOT, P = paths(root);
  const pol = o.policy ? { policy: o.policy, source: 'given' } : loadPolicy(root);
  if (!pol) return null;
  const K = knobs(pol.policy);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const since = now - K.windowDays * DAY, linkSince = since - 7 * DAY;
  const crew = (readJson(P.loops, {}) || {}).agents || {};
  const departments = TC.departments({ file: path.join(root, 'company', 'departments.json') });
  const wakes = B.jsonlWindow(P.wakes, { sinceMs: linkSince, tsOf: r => Number(r.at) || 0, slackMs: 0 }).rows;
  const runs = B.jsonlWindow(P.runs, { sinceMs: linkSince - DAY, maxBytes: Number(K.rb.runsMaxBytes) || undefined }).rows;
  let attributed = [];
  try { const A = require('./lib/admit'); attributed = A.attribute(runs, B.jsonlWindow(P.admit, { sinceMs: linkSince - DAY, tsOf: r => Number(r.at) || Date.parse(r.ts) || 0 }).rows); } catch (_) { attributed = []; }
  const files = handoffFiles(root, since, Number(K.rb.handoffMaxBytes) || 8 * B.MB);
  const parse = t => { const out = []; for (const l of String(t || '').split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && typeof r === 'object' && !r._retention) out.push(r); } catch (_) {} } return out; };
  const ledger = parse(B.tailText(P.ledger, Number(K.rb.ledgerMaxBytes) || 16 * B.MB));
  const corrections = parse(B.tailText(P.corrections, Number(K.rb.correctionsMaxBytes) || 4 * B.MB));
  let evidence = [];
  try {
    const names = fs.readdirSync(P.evidence).filter(f => /^premerge-.*\.json$/.test(f)).sort();
    for (const f of names.slice(-Number(K.rb.evidenceMaxFiles || 2000))) { const j = readJson(path.join(P.evidence, f), null); if (j && typeof j === 'object') evidence.push(j); }
  } catch (_) { evidence = []; }
  return { policy: pol.policy, policySource: pol.source, now, crew, departments, wakes, runs, attributed, files, ledger, corrections, evidence };
}

/* ---------------- the ranking (pure) ---------------- */
function rank(inp) {
  const P = inp.policy, K = knobs(P), now = inp.now;
  const since = now - K.windowDays * DAY, settleMs = K.oneShotDays * DAY;
  const crew = inp.crew || {}, deps = inp.departments || { departments: [] };
  const z = zOf(K.confidence);

  // runs: one row per run (side rows carry the dispatch-slice reason), their families
  const delivery = new Map(), runById = new Map();
  for (const r of inp.runs || []) {
    if (!r || typeof r !== 'object' || !r.runId) continue;
    if (r.kind === 'dispatch-delivery') { if (r.dispatchDelivery) delivery.set(String(r.runId), r.dispatchDelivery); continue; }
    if (!r.agentId && !r.parentRunId) continue;
    runById.set(String(r.runId), r);
  }
  const fam = F.leads([...runById.values()]);
  const childrenOf = new Map();
  for (const [id, f] of fam) if (f.child && f.rootRunId) { if (!childrenOf.has(f.rootRunId)) childrenOf.set(f.rootRunId, []); childrenOf.get(f.rootRunId).push(id); }
  for (const l of childrenOf.values()) l.sort();

  // which items each run was started for (its cost is split evenly between them)
  const runOfAdmit = new Map(); for (const a of inp.attributed || []) if (a && a.admitId && a.runId) runOfAdmit.set(a.admitId, a.runId);
  const wakeRun = w => (w.runId ? String(w.runId) : (w.admitId && runOfAdmit.get(w.admitId)) || null);
  const runItems = new Map(), wakeById = new Map(), wakesOfItem = new Map();
  for (const w of inp.wakes || []) {
    if (!w) continue; if (w.wakeId) wakeById.set(w.wakeId, w);
    const rid = wakeRun(w);
    for (const i of w.items || []) {
      const k = i.file + '\n' + i.id;
      if (!wakesOfItem.has(k)) wakesOfItem.set(k, []); wakesOfItem.get(k).push(w);
      if (rid) { if (!runItems.has(rid)) runItems.set(rid, new Set()); runItems.get(rid).add(k); }
    }
  }

  // items: the DONE blocks closed in the window, linked to their runs
  const done = W.closedItems(inp.files, { sinceMs: since, untilMs: now });
  const doneByKey = new Map(done.map(d => [d.file + '\n' + d.id, d]));
  const linked = W.linkItems(inp.wakes || [], done, { attributed: inp.attributed || [] }).items;
  const secs = sectionsOf(inp.files);
  const secByKey = new Map(); for (const s of secs) if (!secByKey.has(s.file + '\n' + s.id)) secByKey.set(s.file + '\n' + s.id, s);
  const refsTo = new Map();   // item id -> texts of other blocks that name it (**Item:** line): consult verdicts
  for (const s of secs) { const v = field(s.text, 'Item'); if (!v) continue; for (const id of v.replace(/`/g, '').split(/[,;\s]+/).filter(Boolean)) { if (!refsTo.has(id)) refsTo.set(id, []); refsTo.get(id).push(s.text); } }
  const inboxSeat = new Map(); for (const [id, s] of Object.entries(crew)) if (s && s.inbox) inboxSeat.set(s.inbox, id);

  // competence ledger: voids, credit -> author run, the rows that can count against an item
  const corrob = new Set(inp.ledger.filter(r => r.signal === 'ruling.corroborated').map(r => r.target));
  const voided = new Set(), sevOver = new Map();
  for (const r of inp.ledger.filter(x => x.kind === 'ruling' && corrob.has(x.id)).sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    const ch = r.changes || {}; if (ch.void) voided.add(r.target); if (ch.uphold) voided.delete(r.target); if (ch.severity) sevOver.set(r.target, ch.severity);
  }
  const creditRun = new Map(); for (const r of inp.ledger) if (r.kind === 'credit' && r.id && r.authorCorroboratedBy) creditRun.set(r.id, String(r.authorCorroboratedBy));
  const ledgerRows = inp.ledger.filter(r => r && r.id && !voided.has(r.id) && (r.kind === 'demerit' || r.kind === 'record')).map(r => {
    const L = r.links || {};
    const runs = [r.authorCorroboratedBy, r.authorRunId, creditRun.get(L.parent)].concat((L.parents || []).map(p => creditRun.get(p))).filter(Boolean).map(String);
    const prs = [L.pr, r.source && r.source.pr, r.source && r.source.type === 'gh-pr' ? r.source.ref : null, /^pr\./.test(String(r.signal)) ? r.key : null].map(prKey).filter(Boolean);
    return { r, runs, prs, at: Date.parse(r.at) || 0, json: JSON.stringify(r), severity: sevOver.get(r.id) || r.severity };
  });
  const corrRows = (inp.corrections || []).map(r => JSON.stringify(r));
  // premerge evidence: every verdict a PR's heads got, in time order
  const premergeOf = new Map();
  for (const e of inp.evidence || []) {
    const key = prKey(String(e.repo || '') + '#' + e.pr); if (!key) continue;
    const list = premergeOf.get(key) || [];
    for (const h of (e.history || []).concat([{ verdict: e.verdict, at: e.at }])) if (h && h.verdict) list.push({ verdict: String(h.verdict).toUpperCase(), at: Date.parse(h.at) || 0 });
    premergeOf.set(key, list);
  }

  const items = [];
  // notWork: blocks DONE when written (notices, FYIs) that no wake ever listed: not items (lib/wakes.js linkItems)
  const totals = { done: done.length, notWork: done.length - linked.length, unlinked: 0, excluded: 0, settling: 0, scored: 0, selfGradesIgnored: 0, uncitedIgnored: 0, unattributedIgnored: 0 };
  for (const li of linked) {
    const key = li.file + '\n' + li.id;
    if (!li.linked) { totals.unlinked++; continue; }
    const d = doneByKey.get(key) || {};
    const sec = secByKey.get(key) || { text: '', effort: null };
    const ws = (li.wakes || []).map(id => wakeById.get(id)).filter(Boolean).sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    const seat = (ws[0] && ws[0].seat) || inboxSeat.get(li.file) || null;
    const cls = TC.classOf({ text: sec.text, effort: sec.effort }, seat, { departments: deps });
    // the runs: the ones its wakes started, and every delegated child under them
    const tops = [...new Set(li.runs)].filter(id => runById.has(id));
    const all = []; for (const t of tops) { all.push(t); for (const c of childrenOf.get(t) || []) all.push(c); }
    const cost = { usd: 0, listUsd: 0, windowTokens: 0, excludedListUsd: 0, unpricedRuns: 0 };
    let excludedRuns = 0;
    const kinds = new Map();
    for (const id of all) {
      const r = runById.get(id); const k = runKind(r, delivery); kinds.set(id, k);
      const root = (fam.get(id) && fam.get(id).rootRunId) || id;
      const share = 1 / Math.max(1, (runItems.get(root) || new Set([key])).size);
      const c = runCost(r, K);
      if (K.excludeKinds.has(k)) { excludedRuns++; cost.excludedListUsd += c.listUsd * share; continue; }
      cost.usd += c.usd * share; cost.listUsd += c.listUsd * share; cost.windowTokens += c.windowTokens * share; if (c.unpriced) cost.unpricedRuns++;
    }
    const good = tops.filter(id => !K.excludeKinds.has(kinds.get(id))).map(id => runById.get(id)).sort((a, b) => (num(a.startedAt, 0) - num(b.startedAt, 0)) || (String(a.runId) < String(b.runId) ? -1 : 1));
    const primary = good.find(r => r.agentId === seat) || good[0] || null;
    const first = primary || tops.map(id => runById.get(id)).sort((a, b) => num(a.startedAt, 0) - num(b.startedAt, 0))[0];
    if (!first) { totals.unlinked++; continue; }
    const served = primary ? primary.servedModel : first.servedModel;
    const prov = String(first.provider || '?');
    const model = prov + '/' + String(served || first.model || '?');
    const claimed = !served;
    const effort = String(first.reasoningEffort || 'default');
    const cell = { class: cls, model, provider: prov, modelId: String(served || first.model || '?'), effort, claimed };
    const base = { key, file: li.file, id: li.id, seat, cell, cost };
    if (!primary) { totals.excluded++; items.push(Object.assign(base, { excluded: true, excludedRuns })); continue; }
    const closedAt = d.closedAt || li.closedAt || 0, closedBy = d.closedBy || closedAt;
    const settled = now - closedAt >= settleMs;
    const authors = new Set([seat].concat(all.map(id => runById.get(id).agentId)).filter(Boolean));
    const runSet = new Set(all);
    // verdicts on this item (its own block, and blocks that name it)
    const lead = TC.leadOf(seat, deps, crew);
    let failW = 0, reviseRounds = 0; const counted = [];
    if (K.sig('revise')) for (const t of [sec.text].concat(refsTo.get(li.id) || [])) for (const v of verdictsIn(t, K, crew)) {
      if (!v.by) { totals.unattributedIgnored++; continue; }
      if (authors.has(v.by)) { totals.selfGradesIgnored++; continue; }
      if (K.requireCheck && !v.check) { totals.uncitedIgnored++; continue; }
      const w = v.by === lead ? K.wLead : K.wOther;
      counted.push({ by: v.by, fail: v.fail, w });
      if (v.fail) { reviseRounds += w; failW = Math.max(failW, w); }
    }
    const inWin = t => t >= closedAt && t <= closedAt + settleMs;
    const reopened = K.sig('reopen') && ((wakesOfItem.get(key) || []).some(w => (Number(w.at) || 0) > closedBy + 10 * MIN && (Number(w.at) || 0) <= closedAt + settleMs) || /^\*\*Reopened\b/mi.test(sec.text));
    const prs = prRefs(sec.text);
    const mine = lr => lr.runs.some(id => runSet.has(id)) || lr.prs.some(k => prMatches(prs, k));
    const reverted = K.sig('revert') && ledgerRows.some(lr => K.revertSignals.has(lr.r.signal) && inWin(lr.at) && mine(lr));
    const fixForward = K.sig('fixForward') && ledgerRows.some(lr => K.fixSignals.has(lr.r.signal) && inWin(lr.at) && mine(lr));
    let defectPoints = 0, defects = 0;
    if (K.sig('defects')) for (const lr of ledgerRows) if (lr.r.kind === 'demerit' && K.defectSignals.has(lr.r.signal) && mine(lr)) { defects++; defectPoints += num(K.severity[lr.severity], 0); }
    let ownerCorrections = 0;
    if (K.sig('ownerCorrections')) {
      const names = [li.id].concat(all);
      for (const lr of ledgerRows) if (K.ocSignals.has(lr.r.signal) && names.some(n => lr.json.includes(n))) ownerCorrections++;
      for (const j of corrRows) if (all.some(id => j.includes(id) || j.includes('run ' + id.slice(0, 8)))) ownerCorrections++;
      if (K.ocLine && field(sec.text, K.ocLine)) ownerCorrections++;
    }
    let premergeFirstPass = null;
    if (K.sig('premerge') && prs.length) {
      const vs = []; for (const [k, list] of premergeOf) if (prMatches(prs, k)) vs.push(...list);
      vs.sort((a, b) => a.at - b.at || (a.verdict < b.verdict ? -1 : 1));
      if (vs.length) premergeFirstPass = vs[0].verdict === 'PASS';
    }
    const ownTops = good.filter(r => r.agentId === seat);
    const extraRuns = Math.max(0, ownTops.length - 1);
    let fail = 0;
    if (K.failOn.has('revise')) fail = Math.max(fail, failW);
    for (const [s, hit] of [['reopen', reopened], ['revert', reverted], ['fixForward', fixForward], ['defect', defects > 0], ['ownerCorrection', ownerCorrections > 0], ['premergeFail', premergeFirstPass === false]]) if (K.failOn.has(s) && hit) fail = 1;
    const hard = !(reopened || reverted || fixForward);
    items.push(Object.assign(base, { excluded: false, excludedRuns, settled, closedAt, oneShot: clamp(1 - fail, 0, 1), hard, reviseRounds, extraRuns, otherRuns: good.length - ownTops.length,
      reopened, reverted, fixForward, defects, defectPoints, ownerCorrections, premergeFirstPass, changes: prs.length ? prs : [li.id], verdicts: counted }));
  }

  // cells
  const cells = new Map();
  const cellId = c => c.class + '|' + c.model + '|' + c.effort + '|' + (c.claimed ? 'claimed' : 'served');
  for (const it of items) {
    const id = cellId(it.cell);
    if (!cells.has(id)) cells.set(id, { cell: it.cell, scored: [], settling: 0, excluded: 0, excludedRuns: 0, excludedListUsd: 0 });
    const c = cells.get(id);
    c.excludedRuns += it.excludedRuns || 0; c.excludedListUsd += it.cost.excludedListUsd;
    if (it.excluded) { c.excluded++; continue; }
    if (!it.settled && !K.countUnsettled) { c.settling++; totals.settling++; continue; }
    c.scored.push(it); totals.scored++;
  }
  const metric = it => it.cost[K.scoreCost];
  const out = [];
  for (const [id, c] of [...cells].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const s = c.scored, n = s.length;
    const sum = f => s.reduce((t, x) => t + f(x), 0);
    const succ = sum(x => x.oneShot);
    const lower = wilsonLower(succ, n, z);
    const costs = s.map(metric).sort((a, b) => a - b);
    const total = sum(metric);
    const changes = new Set(s.flatMap(x => x.changes)).size;
    const unit = K.scorePer === 'change' ? (changes ? total / changes : null) : (n ? total / n : null);
    const enough = n >= K.minItems;
    const score = enough && lower != null && unit != null && unit > 0 ? lower / unit : null;
    const hardN = Math.max(1, Math.ceil(K.hardest * n));
    const pm = s.filter(x => x.premergeFirstPass != null);
    out.push({
      id, class: c.cell.class, model: c.cell.model, provider: c.cell.provider, modelId: c.cell.modelId, effort: c.cell.effort, claimed: c.cell.claimed,
      items: n, settling: c.settling, excludedItems: c.excluded, excludedRuns: c.excludedRuns, excludedListUsd: rnd(c.excludedListUsd),
      enough, status: enough ? (score == null ? 'no cost recorded' : 'ok') : 'not enough data',
      oneShot: rnd(succ, 4), oneShotRate: n ? rnd(succ / n, 4) : null, lower: rnd(lower, 4),
      costPerItem: n ? rnd(total / n) : null, costPerChange: changes ? rnd(total / changes) : null, costUnit: K.scoreCost, score: rnd(score, 4),
      usd: rnd(sum(x => x.cost.usd)), listUsd: rnd(sum(x => x.cost.listUsd)), windowTokens: Math.round(sum(x => x.cost.windowTokens)),
      windowTokensPerItem: n ? Math.round(sum(x => x.cost.windowTokens) / n) : null, unpricedRuns: sum(x => x.cost.unpricedRuns),
      medianCost: rnd(median(costs)), tailCost: rnd(percentile(costs, K.pct)), hardestCost: n ? rnd(costs.slice(-hardN).reduce((t, x) => t + x, 0) / hardN) : null,
      extraRunsPerItem: n ? rnd(sum(x => x.extraRuns) / n, 4) : null, revisePerItem: n ? rnd(sum(x => x.reviseRounds) / n, 4) : null,
      reopened: s.filter(x => x.reopened).length, reverted: s.filter(x => x.reverted).length, fixForward: s.filter(x => x.fixForward).length,
      defects: sum(x => x.defects), defectPoints: rnd(sum(x => x.defectPoints), 4), ownerCorrections: sum(x => x.ownerCorrections),
      premergeKnown: pm.length, premergeFirstPassRate: pm.length ? rnd(pm.filter(x => x.premergeFirstPass).length / pm.length, 4) : null,
      changes, itemsPerChange: changes ? rnd(n / changes, 4) : null,
    });
  }
  // rank inside each class, among the cells that may steer
  const byClass = new Map(); for (const c of out) { if (!byClass.has(c.class)) byClass.set(c.class, []); byClass.get(c.class).push(c); }
  for (const list of byClass.values()) {
    const ranked = list.filter(c => c.score != null).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    for (const c of list) c.rank = ranked.includes(c) ? ranked.indexOf(c) + 1 : null;
  }
  out.sort((a, b) => (a.class < b.class ? -1 : a.class > b.class ? 1 : 0) || ((a.rank == null) - (b.rank == null)) || ((a.rank || 0) - (b.rank || 0)) || (a.id < b.id ? -1 : 1));

  // graders: approval rate vs the hard one-shot rate of what they graded
  const g = new Map();
  for (const it of items) for (const v of it.verdicts || []) { const x = g.get(v.by) || { verdicts: 0, approvals: 0, hard: 0, weight: 0 }; x.verdicts++; if (!v.fail) x.approvals++; if (it.hard) x.hard++; x.weight += v.w; g.set(v.by, x); }
  const graders = [...g].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([seat, x]) => {
    const ar = x.approvals / x.verdicts, hr = x.hard / x.verdicts;
    return { seat, verdicts: x.verdicts, weight: rnd(x.weight, 4), approvalRate: rnd(ar, 4), hardOneShotRate: rnd(hr, 4), drift: rnd(100 * (ar - hr), 2), flagged: x.verdicts >= K.minVerdicts && Math.abs(100 * (ar - hr)) > K.driftPoints };
  });

  // routing proposals: a cell with enough data beats a department's current route for its class by the margin
  const proposals = [];
  for (const dep of (deps.departments || []).slice().sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))) {
    for (const cls of Object.keys(dep.routes || {}).sort()) {
      const route = dep.routes[cls] || {};
      const rModel = String(route.provider || '?') + '/' + String(route.model || '?'), rEffort = String(route.effort || 'default');
      const routeCell = out.filter(c => c.class === cls && c.model === rModel && c.effort === rEffort).sort((a, b) => b.items - a.items || (a.id < b.id ? -1 : 1))[0] || null;
      const routeScore = routeCell && routeCell.score != null ? routeCell.score : null;
      if (routeScore == null && K.requireRouteData) continue;
      const best = out.filter(c => c.class === cls && c.score != null && c.enough && (!routeCell || c.id !== routeCell.id) && (K.allowClaimed || !c.claimed) && !(c.model === rModel && c.effort === rEffort))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))[0];
      if (!best) continue;
      if (routeScore != null && !(best.score > routeScore * (1 + K.margin))) continue;
      const pid = 'rp-' + sha([dep.id, cls, rModel, rEffort, best.id].join('|')).slice(0, 12);
      proposals.push({ id: pid, mode: K.pMode, department: String(dep.id), class: cls,
        from: { provider: String(route.provider || '?'), model: String(route.model || '?'), effort: rEffort, cell: routeCell ? routeCell.id : null, score: routeScore },
        to: { provider: best.provider, model: best.modelId, effort: best.effort, cell: best.id, score: best.score },
        fromModel: String(route.provider || '?') + '/' + String(route.model || '?') + ' @ ' + rEffort, toModel: best.model + ' @ ' + best.effort,
        gain: routeScore ? rnd(best.score / routeScore - 1, 4) : null });
    }
  }

  return { version: 1, policyVersion: P.version == null ? null : P.version, policyDigest: policyDigest(P), windowDays: K.windowDays, oneShotWindowDays: K.oneShotDays, minItems: K.minItems,
    confidence: K.confidence, score: { cost: K.scoreCost, per: K.scorePer }, totals, cells: out, proposals, graders };
}

/* ---------------- rendering and files ---------------- */
const bodyHash = body => 'sha256:' + sha(canon(body));
function fileText(body, computedAt) { return JSON.stringify(Object.assign({ computedAt, hash: bodyHash(body) }, sortKeys(body)), null, 1) + '\n'; }
function renderMd(body, computedAt) {
  const f = (v, d) => (v == null ? '–' : typeof v === 'number' ? String(rnd(v, d == null ? 4 : d)) : String(v));
  const pc = v => (v == null ? '–' : Math.round(1000 * v) / 10 + '%');
  const L = ['# House ranking: which model does each kind of our work best for the money', '',
    'Written by `company/tools/model-rank.js` (docs/RANKING.md); computed ' + computedAt + '. Items closed in the last ' + body.windowDays + ' days; an item is one-shot when nothing undid it within ' + body.oneShotWindowDays +
    ' days. Score = the lower bound of the ' + Math.round(100 * body.confidence) + '% interval on the one-shot rate / ' + body.score.cost + ' per ' + body.score.per + '. A cell needs ' + body.minItems + ' items before it may steer anything. ' +
    '"(claimed)" = the provider did not confirm which model it served. Policy ' + body.policyDigest + '.', '',
    'Items: ' + body.totals.done + ' closed (' + body.totals.notWork + ' of them notices nobody worked), ' + body.totals.scored + ' scored, ' + body.totals.settling + ' still settling, ' + body.totals.excluded + ' excluded (only provider errors or slice cuts), ' + body.totals.unlinked + ' with no linked run. ' +
    'Verdicts ignored: ' + body.totals.selfGradesIgnored + ' self-grades, ' + body.totals.uncitedIgnored + ' without a cited check, ' + body.totals.unattributedIgnored + ' with no known grader.', ''];
  const classes = [...new Set(body.cells.map(c => c.class))];
  if (!classes.length) L.push('No scored work yet.', '');
  for (const cls of classes) {
    L.push('## ' + cls, '', '| Rank | Model | Effort | Items | One-shot | Lower | Cost/item | Score | Tail cost | Extra runs/item | REVISE/item | Defect pts | Premerge 1st pass | Items/change | Window tokens/item | Status |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of body.cells.filter(x => x.class === cls)) L.push('| ' + f(c.rank) + ' | `' + c.model + '`' + (c.claimed ? ' (claimed)' : '') + ' | ' + c.effort + ' | ' + c.items + (c.settling ? ' (+' + c.settling + ' settling)' : '') + ' | ' + pc(c.oneShotRate) + ' | ' + pc(c.lower) + ' | ' + f(c.costPerItem) + ' | ' + f(c.score) + ' | ' +
      f(c.tailCost) + ' | ' + f(c.extraRunsPerItem, 2) + ' | ' + f(c.revisePerItem, 2) + ' | ' + f(c.defectPoints, 2) + ' | ' + pc(c.premergeFirstPassRate) + ' | ' + f(c.itemsPerChange, 2) + ' | ' + f(c.windowTokensPerItem) + ' | ' + c.status + ' |');
    L.push('');
  }
  L.push('## Routing proposals (' + (body.proposals[0] ? body.proposals[0].mode : 'shadow') + ')', '');
  if (!body.proposals.length) L.push('None: no cell with enough data beats a department\'s current route by the margin.');
  for (const p of body.proposals) L.push('- `' + p.id + '` ' + p.department + ' / ' + p.class + ': `' + p.from.provider + '/' + p.from.model + '` @ ' + p.from.effort + ' (score ' + f(p.from.score) + ') -> `' + p.to.provider + '/' + p.to.model + '` @ ' + p.to.effort + ' (score ' + f(p.to.score) + ', ' + (p.gain == null ? 'route has no score' : '+' + Math.round(100 * p.gain) + '%') + '). Not applied.');
  L.push('');
  const flagged = body.graders.filter(x => x.flagged);
  if (flagged.length) { L.push('## Graders whose approvals drift from the hard results', ''); for (const x of flagged) L.push('- ' + x.seat + ': approves ' + pc(x.approvalRate) + ', hard one-shot ' + pc(x.hardOneShotRate) + ' over ' + x.verdicts + ' verdicts.'); L.push(''); }
  return L.join('\n') + '\n';
}
function historyRow(body, computedAt, prev) {
  const row = { at: computedAt, hash: bodyHash(body), prev: prev || GENESIS, policyDigest: body.policyDigest,
    cells: body.cells.map(c => [c.id, c.items, c.lower, c.costPerItem, c.score, c.enough]), proposals: body.proposals.map(p => p.id) };
  row.rowHash = 'sha256:' + sha(canon(row));
  return row;
}
function readRows(file, maxBytes) {
  const out = []; for (const l of B.tailText(file, maxBytes || 16 * B.MB).split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch (_) { out.push({ _bad: l.slice(0, 80) }); } } return out;
}
function verifyChain(file) {
  const rows = readRows(file, 64 * B.MB);
  const problems = []; let prev = null, rolled = false, n = 0;
  for (const [i, r] of rows.entries()) {
    if (r._retention) { rolled = true; continue; }
    if (r._bad) { problems.push('line ' + (i + 1) + ': not JSON'); continue; }
    const { rowHash, ...rest } = r;
    if ('sha256:' + sha(canon(rest)) !== rowHash) problems.push('row ' + (i + 1) + ' (' + r.at + '): its hash does not match its contents');
    if (prev == null) { if (r.prev !== GENESIS && !rolled) problems.push('row ' + (i + 1) + ': the chain does not start at genesis and no retention roll is recorded (rows removed from the start)'); }
    else if (r.prev !== prev) problems.push('row ' + (i + 1) + ' (' + r.at + '): prev does not match the row before (a row was removed or changed)');
    prev = rowHash; n++;
  }
  return { ok: !problems.length, rows: n, problems };
}
function proposalRows(file) { return readRows(file, 4 * B.MB).filter(r => r && !r._bad && !r._retention); }
function decidedIds(file) { return new Set(proposalRows(file).filter(r => r.kind === 'decision').map(r => r.id)); }

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, text, 'model-rank.js'); } catch (_) {}   // locked-watch.js: this tool's own write
}
function appendLine(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(row) + '\n'; fs.appendFileSync(file, line);
  try { require('./provenance.js').appended(file, line, 'model-rank.js'); } catch (_) {}
}

/* is a refresh due? (cheap: one small state file) */
function refreshDue(o) {
  o = o || {}; const root = o.root || co.ROOT; const now = Number.isFinite(o.now) ? o.now : Date.now();
  const pol = loadPolicy(root); if (!pol) return false;
  const st = readJson(paths(root).state, null);
  return !st || !Number.isFinite(st.checkedAt) || now - st.checkedAt >= knobs(pol.policy).refreshMin * MIN || st.policyDigest !== policyDigest(pol.policy);
}
/* refresh({ root, now, force, dry }) -> { skipped? , changed, body, newProposals } */
function refresh(o) {
  o = o || {}; const root = o.root || co.ROOT; const now = Number.isFinite(o.now) ? o.now : Date.now(); const P = paths(root);
  if (!o.force && !refreshDue({ root, now })) return { skipped: 'not due' };
  const inp = load({ root, now }); if (!inp) return { skipped: 'no ranking policy' };
  const body = rank(inp); const hash = bodyHash(body);
  const stored = readJson(P.json, null);
  const changed = !stored || stored.hash !== hash;
  const res = { changed, hash, body, newProposals: [] };
  if (o.dry) return res;
  if (changed) {
    const computedAt = iso(now);
    writeAtomic(P.json, fileText(body, computedAt));
    writeAtomic(P.md, renderMd(body, computedAt));
    const last = readRows(P.history, 256 * 1024).filter(r => r && r.rowHash).pop();
    appendLine(P.history, historyRow(body, computedAt, last ? last.rowHash : null));
    const have = new Set(proposalRows(P.proposals).filter(r => r.kind === 'proposal').map(r => r.id));
    for (const p of body.proposals) if (!have.has(p.id)) { appendLine(P.proposals, Object.assign({ kind: 'proposal', at: computedAt }, sortKeys(p))); res.newProposals.push(p.id); }
  }
  writeAtomic(P.state, JSON.stringify({ checkedAt: now, hash, policyDigest: body.policyDigest }) + '\n');
  return res;
}
/* --duty: read only. Due when a routing proposal is open (not yet noted or declined). */
function duty(o) {
  o = o || {}; const root = o.root || co.ROOT;
  const inp = load({ root, now: o.now }); if (!inp) return { due: false };
  const body = rank(inp);
  const decided = decidedIds(paths(root).proposals);
  const open = body.proposals.filter(p => !decided.has(p.id));
  if (!open.length) return { due: false };
  const ids = open.map(p => p.id).sort();
  const where = [...new Set(open.map(p => p.department + '/' + p.class))].sort().join(', ');
  return { due: true, route: 'people', key: 'rp-' + sha(ids.join(',')).slice(0, 16), items: ids.map(id => ({ id })),
    reason: open.length + ' routing proposal(s) in ' + open[0].mode + ' mode (' + where + '): a model cell with enough data beats the current route; nothing is applied. See model-rank.js show, then decide <id> --verdict noted|declined' };
}

function decide(id, o) {
  o = o || {}; const root = o.root || co.ROOT; const P = paths(root);
  const verdict = String(o.verdict || ''); if (!['noted', 'declined'].includes(verdict)) return { code: 2, error: '--verdict noted|declined' };
  const crew = (readJson(P.loops, {}) || {}).agents || {};
  const by = seatByName(String(o.by || ''), crew); if (!by) return { code: 2, error: '--by must be a seat in loops.json' };
  const rows = proposalRows(P.proposals);
  if (!rows.some(r => r.kind === 'proposal' && r.id === id)) return { code: 1, error: 'no proposal ' + id + ' in company/work/models/routing-proposals.jsonl' };
  if (rows.some(r => r.kind === 'decision' && r.id === id)) return { code: 1, error: id + ' is already decided' };
  const row = { kind: 'decision', id, at: iso(Date.now()), verdict, by, claim: 'unverified', reason: String(o.reason || '').replace(/\s+/g, ' ').slice(0, 300) };
  appendLine(P.proposals, row);
  return { code: 0, row };
}

/* ---------------- selftest ---------------- */
function selftest() {
  const os = require('os'); const { spawnSync } = require('child_process');
  let bad = 0; const ok = (name, cond, detail) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  [' + String(detail || '').slice(0, 300) + ']')); if (!cond) bad++; };
  ok('Wilson lower bound: 18/20 at 80% is 0.7816', Math.abs(wilsonLower(18, 20, zOf(0.8)) - 0.7816) < 0.0005, wilsonLower(18, 20, zOf(0.8)));
  ok('z of an 80% interval is 1.2816', Math.abs(zOf(0.8) - 1.2816) < 1e-3, zOf(0.8));
  ok('a price is matched by the longest key, a [..] suffix ignored', priceOf({ 'claude-opus-5': { input: 5 }, 'claude-opus-5-5': { input: 4 } }, 'claude-opus-5-5[1m]').input === 4);
  ok('PR refs: a URL and a PR line', prRefs('**PR:** acme/web#12\nsee https://github.com/acme/api/pull/7').join(',') === 'api#7,web#12');
  const FIX = path.join(__dirname, 'tests', 'fixtures', 'ranking');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'model-rank-'));
  try {
    fs.cpSync(path.join(FIX, 'root'), T, { recursive: true });
    const now = String(readJson(path.join(FIX, 'now.json'), {}).now);
    const run = (...a) => spawnSync(process.execPath, [__filename].concat(a), { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC' }), timeout: 60000 });
    const r1 = run('refresh', '--force', '--now', now);
    ok('refresh runs on the golden fixture', r1.status === 0, r1.stderr + r1.stdout);
    const got = fs.readFileSync(path.join(T, 'company', 'work', 'models', 'house-ranking.json'), 'utf8');
    ok('house-ranking.json matches the golden file byte for byte', got === fs.readFileSync(path.join(FIX, 'expected-house-ranking.json'), 'utf8'));
    const r2 = run('refresh', '--force', '--now', String(Number(now) + 3600e3));
    ok('a rerun on the same inputs leaves the file byte-identical', r2.status === 0 && fs.readFileSync(path.join(T, 'company', 'work', 'models', 'house-ranking.json'), 'utf8') === got);
    const v = run('verify'); ok('the history chain verifies (one row)', v.status === 0 && /1 row/.test(v.stdout), v.stdout + v.stderr);
  } finally { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {} }
  console.log(bad ? 'MODEL-RANK SELFTEST FAILED: ' + bad : 'MODEL-RANK SELFTEST PASSED');
  return bad ? 1 : 0;
}

/* ---------------- cli ---------------- */
function argOf(a, k) { const i = a.indexOf(k); return i >= 0 && a[i + 1] !== undefined && !String(a[i + 1]).startsWith('--') ? a[i + 1] : null; }
function main() {
  const a = process.argv.slice(2);
  if (a[0] === '--duty' && a.length === 1) {
    // MODEL_RANK_NOW: a fixed clock for tests only (the dispatcher's duty environment never passes it)
    let r; try { r = duty({ now: Number(process.env.MODEL_RANK_NOW) || undefined }); } catch (e) { console.error('model-rank --duty: ' + e.message); process.exit(2); }
    if (!r.due) process.exit(0);
    console.log(JSON.stringify(r)); process.exit(1);
  }
  if (a.includes('--selftest') || a[0] === 'selftest') process.exit(selftest());
  const now = argOf(a, '--now') != null ? Number(argOf(a, '--now')) : undefined;
  const cmd = a[0];
  if (cmd === 'refresh') {
    const r = refresh({ now, force: a.includes('--force'), dry: a.includes('--dry-run') });
    if (r.skipped) { console.log('house ranking: ' + r.skipped); process.exit(0); }
    console.log('house ranking: ' + (r.changed ? 'changed' : 'unchanged') + ' (' + r.body.cells.length + ' cells, ' + r.body.cells.filter(c => c.enough).length + ' with enough data, ' + r.body.proposals.length + ' routing proposal(s), ' + r.newProposals.length + ' new)' + (a.includes('--dry-run') ? ' [dry run: nothing written]' : ''));
    process.exit(0);
  }
  if (cmd === 'compute') { const inp = load({ now }); if (!inp) { console.log('no ranking policy'); process.exit(0); } console.log(JSON.stringify(sortKeys(rank(inp)), null, 1)); process.exit(0); }
  if (cmd === 'show') {
    const P = paths();
    if (a.includes('--json')) { const j = readJson(P.json, null); console.log(JSON.stringify(j || { computedAt: null, cells: [], proposals: [] }, null, 1)); process.exit(0); }
    try { process.stdout.write(fs.readFileSync(P.md, 'utf8')); } catch (_) { console.log('no house ranking yet (model-rank.js refresh)'); }
    process.exit(0);
  }
  if (cmd === 'verify') { const v = verifyChain(paths().history); console.log(v.ok ? 'history chain ok (' + v.rows + ' row' + (v.rows === 1 ? '' : 's') + ')' : 'HISTORY CHAIN BROKEN:\n  ' + v.problems.join('\n  ')); process.exit(v.ok ? 0 : 1); }
  if (cmd === 'decide') { const r = decide(a[1], { verdict: argOf(a, '--verdict'), by: argOf(a, '--by'), reason: argOf(a, '--reason') }); if (r.code) console.error('model-rank decide: ' + r.error); else console.log('recorded: ' + r.row.id + ' ' + r.row.verdict + ' by ' + r.row.by); process.exit(r.code); }
  console.error('usage: model-rank.js refresh [--force] [--dry-run] [--now ms] | show [--json] | compute [--now ms] | verify | decide <id> --verdict noted|declined --by <seat> | --duty | --selftest');
  process.exit(2);
}

module.exports = { rank, load, loadPolicy, knobs, refresh, refreshDue, duty, decide, verifyChain, historyRow, fileText, renderMd, bodyHash, wilsonLower, zOf, prRefs, verdictsIn, runKind, runCost, priceOf, paths, sortKeys };
if (require.main === module) main();
