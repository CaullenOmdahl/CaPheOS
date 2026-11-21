'use strict';
/* lib/depth.js — how deep one job is, and which kind of work it is, before any model sees it (docs/ROUTING.md
 * "Scoped routing"). No model call, no socket: only the item text, the wake's task class and the earlier wake rows.
 *
 * Depths are the model bench's (packs/model-bench/lib/schema.js DEPTHS): lookup < simple < standard < deep. Kinds are
 * the bench's 10 kinds of work (1 Lookup, 2 Extract, 3 Writing, 4 Planning, 5 Numbers, 6 Simple code, 7 Bigger code,
 * 8 Code review, 9 Tool use, 10 Judgment). Every rule and number comes from the routing policy's `scoped` block
 * (company/work/models/routing-policy.json, lib/routing.js knobs().scoped); a key left out reads as the neutral value
 * named below, never a hidden threshold.
 *
 * One item's depth, in order:
 *   1. an explicit `**Depth:** lookup|simple|standard|deep` line (a lead or the owner writes it) sets the base;
 *   2. else the class baseline: company/state/class-depth.json (the drift, model-rank.js refresh) over
 *      scoped.classDepth[class]; a class in neither reads as standard;
 *   3. `**Effort:** mechanical` caps the base at simple; an item marked with the heavy word (tierCaps.heavyEscape) is deep;
 *   4. size: the item's `**Touches:**` paths and its length: at or above scoped.size.filesStandard / charsStandard at
 *      least standard, at or above filesDeep / charsDeep deep (a size key left out never raises);
 *   5. escalation: every fail on the item moves it one level up (capped at deep). A fail is a line in the block that
 *      matches scoped.escalate.failLines (REVISE verdicts, a Reopened line, a premerge FAIL), plus every earlier routed
 *      wake of the same item (company/state/wakes.jsonl rows with route.scoped) beyond scoped.escalate.freeRepeats.
 *      The models those earlier wakes ran on go on the exclude list, newest first, one per fail, so the retry goes to
 *      another model that clears the new depth.
 * A wake with several items takes the deepest item's depth, the majority kind, every item's exclude list.
 *
 * Kind: an explicit `**Kind:** <1-10>` line wins; else scoped.kinds[class]: a number, or { <depth>: n, default: n }.
 * scoped.alsoNeeds[class]: [{ kind, depth }] further kinds a candidate must also be proven at (code also needs tool use).
 *
 *   const D = require('./lib/depth');
 *   D.DEPTHS, D.KINDS, D.depthIndex(d), D.up(d, n)
 *   D.itemDepth(item, ctx)       -> { depth, base, kind, fails, signals[], exclude[] }
 *   D.estimate(items, ctx)       -> { kind, depth, needs: [{kind, depth}], signals[], exclude[], fails, explicit }
 *     ctx: { seat, class, K (knobs().scoped), departments, heavyEscape, classDepth (the drift doc), wakes (rows) }
 *   D.loadClassDepth(root)       -> company/state/class-depth.json classes ({ <class>: depth }) or {}
 * Pure apart from loadClassDepth. Never throws on odd input (a bad item reads as the class baseline).
 */
const fs = require('fs');
const path = require('path');

const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
const KINDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const KIND_NAMES = { 1: 'lookup', 2: 'extract', 3: 'writing', 4: 'planning', 5: 'numbers', 6: 'simple code', 7: 'bigger code', 8: 'code review', 9: 'tool use', 10: 'judgment' };
const CLASS_DEPTH_REL = 'company/state/class-depth.json';
const depthIndex = d => DEPTHS.indexOf(String(d || ''));
const up = (d, n) => DEPTHS[Math.max(0, Math.min(DEPTHS.length - 1, (depthIndex(d) < 0 ? 2 : depthIndex(d)) + (Number(n) || 0)))];
const field = (text, name) => { const m = String(text || '').match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].replace(/[`*_]/g, '').trim() : null; };
const arr = v => (Array.isArray(v) ? v : []);
const deeper = (a, b) => (depthIndex(a) >= depthIndex(b) ? a : b);
const shallower = (a, b) => (depthIndex(a) <= depthIndex(b) ? a : b);

function depthWord(v) { const w = String(v || '').trim().toLowerCase().split(/[\s,;(]/)[0]; return DEPTHS.includes(w) ? w : null; }
function kindWord(v) { const n = Number(String(v || '').trim().split(/[\s,;(]/)[0]); return KINDS.includes(n) ? n : null; }

function loadClassDepth(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.resolve(root || require('./company').ROOT), CLASS_DEPTH_REL), 'utf8'));
    const out = {};
    for (const [c, v] of Object.entries((j && j.classes) || {})) { const d = depthWord(v && typeof v === 'object' ? v.depth : v); if (d) out[c] = d; }
    return out;
  } catch (_) { return {}; }
}

function kindFor(cls, depth, K) {
  const m = (K && K.kinds) || {};
  const v = m[cls];
  if (KINDS.includes(Number(v))) return Number(v);
  if (v && typeof v === 'object') { const x = v[depth] != null ? v[depth] : v.default; if (KINDS.includes(Number(x))) return Number(x); }
  return null;
}

/* the fail lines of a block (policy scoped.escalate.failLines: regex sources, matched per line, case-insensitive) */
function failLines(text, K) {
  const pats = arr(K && K.escalate && K.escalate.failLines).map(s => { try { return new RegExp(String(s), 'im'); } catch (_) { return null; } }).filter(Boolean);
  if (!pats.length) return 0;
  let n = 0;
  for (const line of String(text || '').split('\n')) if (pats.some(p => p.test(line))) n++;
  return n;
}

/* the earlier routed wakes of one item (wakes.jsonl rows naming the item id, with route.scoped), oldest first */
function priorWakes(id, wakes) {
  if (!id) return [];
  return arr(wakes).filter(w => w && w.route && w.route.scoped && arr(w.items).some(i => i && String(i.id) === String(id)))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

function itemDepth(item, ctx) {
  ctx = ctx || {};
  const K = ctx.K || {};
  const it = typeof item === 'string' ? { text: item } : (item || {});
  const text = String(it.text || '');
  const signals = [];
  let cls = ctx.class || 'general';
  try { cls = require('./taskclass').classOf({ text, class: it.class, effort: it.effort }, ctx.seat, { departments: ctx.departments || { departments: [] } }); } catch (_) {}
  // 1-2: the base
  const explicit = depthWord(field(text, 'Depth'));
  let base;
  if (explicit) { base = explicit; signals.push('Depth line: ' + explicit); }
  else {
    const drift = (ctx.classDepth || {})[cls];
    const shipped = depthWord((K.classDepth || {})[cls]);
    base = drift || shipped || 'standard';
    signals.push('class ' + cls + ' baseline ' + base + (drift ? ' (drifted from ' + (shipped || 'standard') + ')' : shipped ? '' : ' (no baseline set)'));
    // 3: effort
    const eff = String(it.effort || field(text, 'Effort') || '');
    const heavy = ctx.heavyEscape && new RegExp('^\\s*' + String(ctx.heavyEscape).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(eff);
    if (/^\s*mechanical\b/i.test(eff)) { const b = shallower(base, 'simple'); if (b !== base) signals.push('Effort: mechanical caps it at simple'); base = b; }
    if (heavy) { if (base !== 'deep') signals.push('Effort: ' + ctx.heavyEscape + ' makes it deep'); base = 'deep'; }
    // 4: size
    const S = K.size || {};
    let touches = null; try { touches = require('./sprint').parseTouches(field(text, 'Touches')); } catch (_) {}
    const files = touches ? touches.length : 0, chars = text.length;
    const at = (v, lim) => Number(lim) > 0 && v >= Number(lim);
    if (at(files, S.filesDeep) || at(chars, S.charsDeep)) { if (base !== 'deep') signals.push('size: ' + files + ' paths, ' + chars + ' characters makes it deep'); base = 'deep'; }
    else if (at(files, S.filesStandard) || at(chars, S.charsStandard)) { const b = deeper(base, 'standard'); if (b !== base) signals.push('size: ' + files + ' paths, ' + chars + ' characters makes it at least standard'); base = b; }
  }
  // 5: escalation
  const lines = failLines(text, K);
  const prior = priorWakes(it.id, ctx.wakes);
  const free = Number.isFinite(Number(K.escalate && K.escalate.freeRepeats)) ? Math.max(0, Number(K.escalate.freeRepeats)) : Infinity;
  const repeats = Number.isFinite(free) ? Math.max(0, prior.length - free) : 0;
  const fails = lines + repeats;
  const depth = up(base, fails);
  if (lines) signals.push(lines + ' fail line(s) in the block (REVISE, reopened or premerge FAIL)');
  if (repeats) signals.push(prior.length + ' earlier routed wakes of this item (' + free + ' free)');
  if (fails) signals.push('escalated ' + base + ' -> ' + depth);
  const exclude = [];
  if (fails) for (const w of prior.slice().reverse()) {
    const p = w.route && (w.route.provider && w.route.model ? w.route.provider + '/' + w.route.model : null);
    if (p && !exclude.includes(p)) exclude.push(p);
    if (exclude.length >= fails) break;
  }
  const k = kindWord(field(text, 'Kind'));
  const kind = k || kindFor(cls, depth, K);
  if (k) signals.push('Kind line: ' + k);
  return { depth, base, kind, class: cls, fails, signals, exclude, explicit: !!explicit };
}

function estimate(items, ctx) {
  ctx = ctx || {};
  const K = ctx.K || {};
  const list = arr(items);
  const per = list.map(it => itemDepth(it, ctx));
  if (!per.length) per.push(itemDepth({ text: '' }, ctx));
  let depth = per[0].depth; for (const p of per) depth = deeper(depth, p.depth);
  // the majority kind (a tie: the deepest item's), then the class map at the wake's depth when no item named one
  const n = {}; for (const p of per) if (p.kind != null) n[p.kind] = (n[p.kind] || 0) + 1;
  const deepest = per.find(p => p.depth === depth) || per[0];
  let kind = deepest.kind; for (const k of Object.keys(n)) if (n[k] > (n[kind] || 0)) kind = Number(k);
  if (kind == null) kind = kindFor(ctx.class || deepest.class, depth, K);
  const cls = ctx.class || deepest.class;
  const needs = kind == null ? [] : [{ kind, depth }];
  for (const x of arr((K.alsoNeeds || {})[cls])) {
    const kk = Number(x && x.kind), dd = depthWord(x && x.depth);
    if (KINDS.includes(kk) && dd && kk !== kind) needs.push({ kind: kk, depth: shallower(dd, depth) });
  }
  const signals = [...new Set(per.flatMap(p => p.signals))].slice(0, 8);
  const exclude = [...new Set(per.flatMap(p => p.exclude))];
  return { kind, kindName: kind == null ? null : KIND_NAMES[kind], depth, needs, signals, exclude, fails: per.reduce((t, p) => t + p.fails, 0), explicit: per.some(p => p.explicit), class: cls };
}

module.exports = { DEPTHS, KINDS, KIND_NAMES, CLASS_DEPTH_REL, depthIndex, up, depthWord, kindWord, kindFor, failLines, priorWakes, itemDepth, estimate, loadClassDepth };
