'use strict';
/* lib/free-models.js — the free-model fallback's shared rules (docs/FREE-MODELS.md). No IO beyond reading files.
 *
 * The registry is company/state/free-models.json, written by company/tools/free-models.js refresh from OpenRouter's
 * public model list: only models whose id ends ':free' or whose every listed price is 0. A seat chain names the
 * virtual entry `openrouter/free`; models.js resolves it to ONE real model id at each tick with resolve() below, and
 * that id is what the seat's roster and routines are set to, so every run row (and the grading of its work) names the
 * real model.
 *
 *   const FM = require('./lib/free-models');
 *   FM.PROVIDER, FM.ALIAS                     'openrouter', 'free'
 *   FM.isAlias(entry)                         entry is { provider: 'openrouter', model: 'free' }
 *   FM.settings(policy)                       model-policy.json freeFallback with defaults (enabled, maxAgeHours, coolMin, minItems, maxAlternates)
 *   FM.aliasAllowed(policy)                   'free' is on allowed.openrouter.models and freeFallback.enabled is not false
 *   FM.load(root) / FM.fresh(reg, now, pol)   the registry (null when missing or broken) / whether it is recent enough
 *   FM.isFreeRow(catalogRow)                  the catalog row is a free model (':free' or every price 0)
 *   FM.isFreeId(id, reg?)                     ':free' or listed in the registry
 *   FM.isFreePair(provider, model, root?)     a run on this pair costs nothing (openrouter + a free id, or the alias)
 *   FM.allowedPair(policy, provider, model, root?)  the pair is allowed through the alias (for checkers of allowed lists)
 *   FM.order(reg, ranking, { cls, minItems }) the registry's ids, best first: house-ranking cells first (see below)
 *   FM.resolve({ root, policy, now, runs, cls, reg?, ranking?, hasKey? }) -> { ok, model?, why, skipped: [{ id, why }] }
 *   FM.dailyLimitUntil(runs, now)             epoch ms the account's free-model daily limit lifts (0 = not hit today)
 *
 * Ordering: a registry id with a house-ranking cell (company/work/models/house-ranking.json, provider openrouter) that has
 * at least minItems graded items goes first, by the cell's lower bound of the one-shot rate (the Wilson lower bound; a
 * free cell has no cost, so the quality bound alone decides between free models), in the given task class when the
 * ranking has cells there, else its best class. The rest follow the registry's default order (tools support first,
 * then the larger context window, then the larger output limit, then the id).
 */
const fs = require('fs');
const path = require('path');

const PROVIDER = 'openrouter';
const ALIAS = 'free';
const REG_REL = 'company/state/free-models.json';
const RANK_REL = 'company/work/models/house-ranking.json';
const DEFAULTS = { enabled: true, maxAgeHours: 72, coolMin: 30, minItems: 5, maxAlternates: 2 };
const DAILY_RE = /free-models-per-day|free[ _-]?models?[^.]{0,40}per[ _-]?day|daily[^.]{0,30}free[^.]{0,20}limit|free_daily_limit/i;
const PROVIDER_ERR_RE = /\bhttp\s*(40[23]|408|429|5\d\d)\b|rate.?limit|overloaded|unavailable|no endpoints|timed? ?out|upstream|provider returned error|quota/i;
const PROVIDER_CODES = ['quota_exhausted', 'rate_limited', 'provider_error', 'provider_unavailable', 'network', 'timeout', 'overloaded', 'upstream', 'model_unavailable', 'model_unsuitable', 'model_no_tools', 'concurrency_limit', 'free_daily_limit'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const rootOf = r => path.resolve(r || require('./company').ROOT);

const isAlias = e => !!e && e.provider === PROVIDER && e.model === ALIAS;
function settings(pol) {
  const s = Object.assign({}, DEFAULTS, (pol && pol.freeFallback && typeof pol.freeFallback === 'object') ? pol.freeFallback : {});
  for (const k of ['maxAgeHours', 'coolMin', 'minItems', 'maxAlternates']) { const n = Number(s[k]); s[k] = Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k]; }
  s.enabled = s.enabled !== false;
  return s;
}
function aliasAllowed(pol) {
  const fam = pol && pol.allowed && pol.allowed[PROVIDER];
  return !!(fam && Array.isArray(fam.models) && fam.models.includes(ALIAS) && settings(pol).enabled);
}

function load(root) {
  const r = readJson(path.join(rootOf(root), REG_REL), null);
  return r && Array.isArray(r.models) ? r : null;
}
function fresh(reg, now, pol) {
  if (!reg || !reg.models || !reg.models.length) return false;
  const at = Date.parse(reg.at || '') || Number(reg.at) || 0;
  return !!at && (now - at) <= settings(pol).maxAgeHours * 3600e3;
}

const zero = v => v == null || v === '' || Number(v) === 0;
function isFreeRow(m) {
  if (!m || typeof m.id !== 'string' || !m.id) return false;
  // a model that does not answer in text (an image or music generator priced 0) is no agent seat
  const out = m.architecture && Array.isArray(m.architecture.output_modalities) ? m.architecture.output_modalities : null;
  if (out && !out.includes('text')) return false;
  if (/:free$/.test(m.id)) return true;
  const p = m.pricing;
  if (!p || typeof p !== 'object') return false;
  if (p.prompt == null || p.completion == null) return false;   // a row that states no price is not free, it is unknown
  return ['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning', 'input_cache_read', 'input_cache_write'].every(k => zero(p[k]))
    && Number(p.prompt) === 0 && Number(p.completion) === 0;
}
function isFreeId(id, reg) {
  const s = String(id || '');
  if (!s) return false;
  if (/:free$/.test(s)) return true;
  return !!(reg && Array.isArray(reg.models) && reg.models.some(m => m && m.id === s));
}
function isFreePair(provider, model, root) {
  if (String(provider || '') !== PROVIDER) return false;
  if (model === ALIAS) return true;
  if (/:free$/.test(String(model || ''))) return true;
  return isFreeId(model, load(root));
}
function allowedPair(pol, provider, model, root) {
  return String(provider || '') === PROVIDER && aliasAllowed(pol) && model !== ALIAS && isFreeId(model, load(root));
}

// OpenRouter's own routers (openrouter/...) go last: which model serves them changes per call (the run row still says)
const isRouter = id => /^openrouter\//.test(String(id || ''));
function defaultOrder(models) {
  return models.slice().sort((a, b) => (isRouter(a.id) - isRouter(b.id)) || ((b.tools === true) - (a.tools === true)) || ((Number(b.context) || 0) - (Number(a.context) || 0))
    || ((Number(b.maxOut) || 0) - (Number(a.maxOut) || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(m => m.id);
}
function order(reg, ranking, o) {
  o = o || {};
  const ids = reg && Array.isArray(reg.models) ? reg.models.map(m => m && m.id).filter(Boolean) : [];
  if (!ids.length) return [];
  const base = (Array.isArray(reg.ranked) && reg.ranked.length ? reg.ranked.filter(id => ids.includes(id)).concat(ids.filter(id => !reg.ranked.includes(id))) : defaultOrder(reg.models));
  const minItems = o.minItems != null ? Number(o.minItems) : DEFAULTS.minItems;
  const cells = (ranking && Array.isArray(ranking.cells) ? ranking.cells : []).filter(c => c && c.provider === PROVIDER && ids.includes(String(c.modelId)) && Number(c.items) >= minItems && typeof c.lower === 'number');
  const inClass = o.cls ? cells.filter(c => c.class === o.cls) : [];
  const use = inClass.length ? inClass : cells;
  const best = new Map();
  for (const c of use) { const id = String(c.modelId); if (!best.has(id) || c.lower > best.get(id)) best.set(id, c.lower); }
  const ranked = [...best.entries()].sort((a, b) => (b[1] - a[1]) || (base.indexOf(a[0]) - base.indexOf(b[0]))).map(x => x[0]);
  return ranked.concat(base.filter(id => !best.has(id)));
}

function nextUtcMidnight(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); }
function startUtcDay(t) { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
const flat = runs => Array.isArray(runs) ? runs : Object.values(runs || {}).reduce((a, x) => a.concat(x || []), []);
function dailyLimitUntil(runs, now) {
  const day = startUtcDay(now);
  const hit = flat(runs).some(r => r && r.provider === PROVIDER && Number(r.at) >= day && (DAILY_RE.test(String(r.error || '')) || r.failureCode === 'free_daily_limit'));
  return hit ? nextUtcMidnight(now) : 0;
}
function providerErr(r) { return !!r && r.reason === 'error' && (PROVIDER_CODES.includes(String(r.failureCode || '')) || PROVIDER_ERR_RE.test(String(r.error || ''))); }

function resolve(a) {
  a = a || {};
  const root = rootOf(a.root), pol = a.policy || readJson(path.join(root, 'company', 'model-policy.json'), {}) || {};
  const S = settings(pol), t = a.now != null ? a.now : Date.now();
  if (!aliasAllowed(pol)) return { ok: false, why: 'the free-model fallback is off (allowed.openrouter.models has no "free", or freeFallback.enabled is false)', skipped: [] };
  const hasKey = a.hasKey !== undefined ? !!a.hasKey : !!require('./models-money').readSecret(root, 'openrouter-key');
  if (!hasKey) return { ok: false, why: 'no OpenRouter key (secrets/openrouter-key)', skipped: [] };
  const reg = a.reg !== undefined ? a.reg : load(root);
  if (!reg || !reg.models || !reg.models.length) return { ok: false, why: 'no free models listed yet (company/tools/free-models.js refresh)', skipped: [] };
  if (!fresh(reg, t, pol)) return { ok: false, why: 'the free-model list is older than ' + S.maxAgeHours + ' h (company/tools/free-models.js refresh)', skipped: [] };
  const until = dailyLimitUntil(a.runs, t);
  if (until) return { ok: false, why: 'OpenRouter\'s daily free-model limit was reached today; open again at ' + new Date(until).toISOString().slice(0, 16) + ' UTC', until, skipped: [] };
  const ranking = a.ranking !== undefined ? a.ranking : readJson(path.join(root, RANK_REL), null);
  const ids = order(reg, ranking, { cls: a.cls, minItems: S.minItems });
  const all = flat(a.runs).filter(r => r && r.provider === PROVIDER).sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0));
  const skipped = [];
  const tooled = new Set(reg.models.filter(m => m && m.tools === true).map(m => m.id));
  for (const id of ids) {
    if (!tooled.has(id)) { skipped.push({ id, why: 'does not take tools' }); continue; }
    const mine = all.filter(r => r.model === id);
    const last = mine[mine.length - 1];
    if (last && providerErr(last) && t - Number(last.at) < S.coolMin * 60e3) { skipped.push({ id, why: 'provider error ' + Math.round((t - Number(last.at)) / 60e3) + ' min ago (' + String(last.failureCode || last.error || 'error').slice(0, 80) + ')' }); continue; }
    const alternates = ids.filter(x => x !== id && !skipped.some(s => s.id === x)).slice(0, S.maxAlternates);
    return { ok: true, model: id, why: 'free model ' + id + (skipped.length ? ' (skipped ' + skipped.length + ' cooling)' : ''), alternates, skipped };
  }
  return { ok: false, why: 'every listed free model had a provider error in the last ' + S.coolMin + ' min', skipped };
}

module.exports = { PROVIDER, ALIAS, REG_REL, DEFAULTS, DAILY_RE, isAlias, settings, aliasAllowed, load, fresh, isFreeRow, isFreeId, isFreePair, allowedPair, defaultOrder, order, resolve, dailyLimitUntil, nextUtcMidnight };
