'use strict';
/* lib/capability.js — what each model is proven to do: its depth per kind of work, from the model bench and then from
 * validated live work (docs/ROUTING.md "Scoped routing", docs/RANKING.md §11). Also the owner's per-model "routable"
 * switch and the list of models the router may pick from.
 *
 * The table: company/work/models/model-capability.json, rewritten whole by model-rank.js refresh (locked-watch.js class
 * R, writer model-rank.js) only when its body changed:
 *   { v: 1, at, passMark, minItems, models: { "<provider/model>": { bench: true|false, kinds: { "<kind>": {
 *       bench: <proven depth from the bench, or null>, current: <the depth the router trusts now, or null>,
 *       levels: { <depth>: { passRate, timeSecP50, tokens } },          the bench's numbers per depth (tokens per task)
 *       live: { <depth>: { n, oneShot, lower, upper, timeSecP50 } },    validated live items (model-rank.js analyze)
 *       why } } } } }
 *   current starts at the bench's proven depth (or null: a model with no bench result is a new model). Then, at most one
 *   move per kind per refresh, each returned in moves[] (model-rank.js logs them, op capability):
 *     drop   a depth at or under current with at least minItems live items whose Wilson UPPER bound of the one-shot
 *            rate is under the pass mark: current becomes the depth under it (null under lookup)
 *     raise  live items at current + 1 (or at lookup for a null current) whose Wilson LOWER bound is at or over the pass
 *            mark: current moves up one level
 *   A new bench result (a different bench depth than the table recorded) resets current to it.
 *
 *   const C = require('./lib/capability');
 *   C.REL, C.BENCH_DIR
 *   C.benchResults(root)                 -> [result]  every company/state/model-bench/<model>.json (schema model-bench/1;
 *                                           stub models and .prev.json left out)
 *   C.build({ bench, live, prev, passMark, minItems, z, now }) -> { doc, moves }   pure
 *   C.load(root)                         -> the table, or null
 *   C.currentOf(doc, pair, kind)         -> { current, entry } (entry null: the model is not in the table)
 *   C.routable(pair, modelPolicy)        -> { ok, why }  the owner's switch (model-policy.json routable; a key may end in
 *                                           '*'; the longest match wins; no match: routable, except a needsCeoApproval
 *                                           model, which is not routable until the owner switches it on)
 *   C.candidates(modelPolicy, { root, capability }) -> [{provider, model}]  every pair the router may consider: each model
 *                                           on the allowed lists (openrouter/free expanded to the listed free models
 *                                           while the free fallback is on), plus every model in the capability table
 *                                           whose pair is allowed; routable ones only
 *   C.routableList(modelPolicy, { root, capability }) -> the console's list: [{ pair, routable, why, set, bench }]
 * Pure apart from the reads named. Never throws from load / candidates.
 */
const fs = require('fs');
const path = require('path');

const REL = 'company/work/models/model-capability.json';
const BENCH_DIR = 'company/state/model-bench';
const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
const di = d => DEPTHS.indexOf(String(d || ''));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const rootOf = r => path.resolve(r || require('./company').ROOT);
const keyOf = p => String(p.provider) + '/' + String(p.model);
const rnd = (x, d) => (x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x) * 10 ** d) / 10 ** d);

function wilson(successes, n, z) {
  if (!n) return { lower: null, upper: null };
  const p = Math.min(1, Math.max(0, successes / n)), z2 = z * z, den = 1 + z2 / n;
  const mid = p + z2 / (2 * n), half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { lower: (mid - half) / den, upper: (mid + half) / den };
}

function benchResults(root) {
  const dir = path.join(rootOf(root), BENCH_DIR);
  let names = []; try { names = fs.readdirSync(dir).filter(f => /\.json$/.test(f) && !/\.prev\.json$/.test(f)).sort(); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    const j = readJson(path.join(dir, f), null);
    if (!j || j.schema !== 'model-bench/1' || typeof j.model !== 'string' || !/^[^/]+\/.+$/.test(j.model) || /^stub\//.test(j.model) || !j.kinds || typeof j.kinds !== 'object') continue;
    out.push(j);
  }
  return out;
}

function benchLevels(kindRes) {
  const out = {};
  for (const d of DEPTHS) {
    const L = kindRes && kindRes.levels && kindRes.levels[d]; if (!L) continue;
    const inst = Math.max(1, Number(L.instances) || Number(L.tasks) || 1);
    out[d] = { passRate: L.passRate == null ? null : Number(L.passRate), timeSecP50: Number.isFinite(Number(L.timeSecP50)) ? Number(L.timeSecP50) : null,
      tokens: Math.round(((Number(L.tokensIn) || 0) + (Number(L.tokensOut) || 0)) / inst) || null };
  }
  return out;
}

/* live: [{ model: 'provider/model', kind, depth, n, oneShot (successes), timeSecP50 }] */
function build(a) {
  a = a || {};
  const passMark = Number(a.passMark) > 0 ? Number(a.passMark) : 0.9;
  const minItems = Math.max(1, Number(a.minItems) || 20);
  const z = Number(a.z) > 0 ? Number(a.z) : 1.2816;
  const prev = (a.prev && a.prev.models) || {};
  const models = {}, moves = [];
  const ensure = m => (models[m] = models[m] || { bench: false, kinds: {} });
  for (const r of a.bench || []) {
    const m = ensure(r.model); m.bench = true; if (r.benchVersion) m.benchVersion = String(r.benchVersion); if (r.ranAt) m.benchAt = String(r.ranAt);
    for (const [k, kr] of Object.entries(r.kinds || {})) {
      if (!/^(10|[1-9])$/.test(k)) continue;
      m.kinds[k] = { bench: DEPTHS.includes(kr && kr.proven) ? kr.proven : null, levels: benchLevels(kr), live: {} };
    }
  }
  for (const l of a.live || []) {
    if (!l || !l.model || !/^(10|[1-9])$/.test(String(l.kind)) || !DEPTHS.includes(l.depth)) continue;
    const m = ensure(l.model); const k = String(l.kind);
    const e = m.kinds[k] = m.kinds[k] || { bench: null, levels: {}, live: {} };
    const n = Number(l.n) || 0, s = Number(l.oneShot) || 0, w = wilson(s, n, z);
    e.live[l.depth] = { n, oneShot: rnd(s, 4), lower: rnd(w.lower, 4), upper: rnd(w.upper, 4), timeSecP50: l.timeSecP50 == null ? null : rnd(l.timeSecP50, 1) };
  }
  for (const [mk, m] of Object.entries(models)) for (const [k, e] of Object.entries(m.kinds)) {
    const p = prev[mk] && prev[mk].kinds && prev[mk].kinds[k];
    let cur = e.bench, why = e.bench ? 'bench proven at ' + e.bench : m.bench ? 'the bench proved no depth' : 'new model: no bench result';
    if (p && (p.bench || null) === (e.bench || null) && (p.current === null || DEPTHS.includes(p.current))) { cur = p.current; why = p.why || why; }
    else if (p && (p.bench || null) !== (e.bench || null)) why = 'new bench result: ' + (e.bench || 'no depth proven') + (p.current !== undefined ? ' (was ' + (p.current || 'none') + ')' : '');
    // one move per kind per refresh: a drop first (the shallowest failing depth at or under current), else a raise
    let moved = null;
    if (cur) for (const d of DEPTHS.slice(0, di(cur) + 1)) {
      const L = e.live[d]; if (!L || L.n < minItems || L.upper == null || !(L.upper < passMark)) continue;
      const to = di(d) > 0 ? DEPTHS[di(d) - 1] : null;
      moved = { op: 'drop', from: cur, to, why: 'live ' + d + ': ' + L.oneShot + ' of ' + L.n + ' one-shot, upper bound ' + L.upper + ' < ' + passMark };
      break;
    }
    if (!moved) {
      const next = cur ? DEPTHS[di(cur) + 1] : 'lookup';
      const L = next ? e.live[next] : null;
      if (L && L.n >= minItems && L.lower != null && L.lower >= passMark) moved = { op: 'raise', from: cur, to: next, why: 'live ' + next + ': ' + L.oneShot + ' of ' + L.n + ' one-shot, lower bound ' + L.lower + ' >= ' + passMark };
    }
    if (moved) { cur = moved.to; why = moved.op + ' ' + (moved.from || 'none') + ' -> ' + (moved.to || 'none') + ': ' + moved.why; moves.push(Object.assign({ model: mk, kind: Number(k) }, moved)); }
    e.current = cur; e.why = why;
  }
  return { doc: { v: 1, at: a.now != null ? new Date(a.now).toISOString() : new Date().toISOString(), passMark, minItems, models: sortObj(models) }, moves };
}
function sortObj(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }

function load(root) { const j = readJson(path.join(rootOf(root), REL), null); return j && j.v === 1 && j.models && typeof j.models === 'object' ? j : null; }
function currentOf(doc, pair, kind) {
  const m = doc && doc.models && doc.models[keyOf(pair)];
  if (!m) return { current: null, entry: null, model: null };
  const e = m.kinds && m.kinds[String(kind)];
  return { current: e && DEPTHS.includes(e.current) ? e.current : null, entry: e || null, model: m };
}

/* ---- the owner's routable switch (company/model-policy.json routable) ---- */
function matchKey(map, key) {
  let best = null;
  for (const k of Object.keys(map || {})) {
    if (k.startsWith('_') || typeof map[k] !== 'boolean') continue;
    const hit = k.endsWith('*') ? key.startsWith(k.slice(0, -1)) : key === k;
    if (hit && (!best || k.length > best.length)) best = k;
  }
  return best;
}
function routable(pair, mp) {
  const key = keyOf(pair), map = (mp && mp.routable && typeof mp.routable === 'object') ? mp.routable : {};
  const k = matchKey(map, key);
  if (k) return map[k] ? { ok: true, why: 'the owner lets it be picked automatically (' + k + ')', key: k } : { ok: false, why: 'the owner has it off for automatic picks (' + k + ')', key: k };
  const ceo = ((mp && mp.needsCeoApproval) || []).map(String);
  if (ceo.includes(String(pair.model)) || ceo.includes(key)) return { ok: false, why: String(pair.model) + ' needs the CEO\'s approval, so it is not picked automatically unless the owner switches it on', key: null };
  return { ok: true, why: 'routable (no owner setting)', key: null };
}

function allowedPairs(mp, o) {
  o = o || {};
  const FM = require('./free-models');
  const out = [];
  const add = p => { if (p && p.provider && p.model && !out.some(x => keyOf(x) === keyOf(p))) out.push({ provider: String(p.provider), model: String(p.model) }); };
  for (const [prov, fam] of Object.entries((mp && mp.allowed) || {})) {
    if (!fam || !Array.isArray(fam.models)) continue;
    for (const m of fam.models) {
      if (FM.isAlias({ provider: prov, model: m })) {
        if (!FM.aliasAllowed(mp)) continue;
        const reg = o.freeRegistry !== undefined ? o.freeRegistry : FM.load(o.root);
        for (const x of (reg && Array.isArray(reg.models) ? reg.models : [])) if (x && x.id && (x.tools === true)) add({ provider: FM.PROVIDER, model: x.id });
        continue;
      }
      add({ provider: prov, model: m });
    }
  }
  // a model with a capability row (a bench result, or live work) whose pair is allowed (a listed free model, for one)
  const cap = o.capability !== undefined ? o.capability : load(o.root);
  for (const mk of Object.keys((cap && cap.models) || {})) {
    const i = mk.indexOf('/'); if (i < 1) continue;
    const p = { provider: mk.slice(0, i), model: mk.slice(i + 1) };
    const fam = (mp && mp.allowed || {})[p.provider];
    if ((fam && Array.isArray(fam.models) && fam.models.includes(p.model)) || FM.allowedPair(mp, p.provider, p.model, o.root)) add(p);
  }
  return out;
}
function candidates(mp, o) {
  try { return allowedPairs(mp, o).filter(p => routable(p, mp).ok); } catch (_) { return []; }
}
function routableList(mp, o) {
  o = o || {};
  const cap = o.capability !== undefined ? o.capability : load(o.root);
  const set = (mp && mp.routable && mp.routable._set) || {};
  // every allowed model, plus every model with a bench result or a routable setting (so a model that is not allowed
  // yet, such as a top tier, shows with its switch)
  const pairs = allowedPairs(mp, Object.assign({}, o, { capability: cap }));
  const extra = Object.keys((cap && cap.models) || {}).concat(Object.keys((mp && mp.routable) || {}).filter(k => !k.startsWith('_') && !k.endsWith('*')));
  for (const mk of extra) { const i = mk.indexOf('/'); if (i > 0 && !pairs.some(p => keyOf(p) === mk)) pairs.push({ provider: mk.slice(0, i), model: mk.slice(i + 1), notAllowed: true }); }
  return pairs.map(p => {
    const r = routable(p, mp), m = cap && cap.models && cap.models[keyOf(p)];
    const proven = m ? Object.entries(m.kinds || {}).filter(([, e]) => e && e.current).map(([k, e]) => ({ kind: Number(k), depth: e.current })) : [];
    return { pair: keyOf(p), provider: p.provider, model: p.model, allowed: !p.notAllowed, routable: r.ok, why: r.why, setting: r.key, set: set[keyOf(p)] || null, bench: !!(m && m.bench), proven };
  }).sort((a, b) => (a.pair < b.pair ? -1 : 1));
}

module.exports = { REL, BENCH_DIR, DEPTHS, wilson, benchResults, benchLevels, build, load, currentOf, routable, matchKey, allowedPairs, candidates, routableList, keyOf };
