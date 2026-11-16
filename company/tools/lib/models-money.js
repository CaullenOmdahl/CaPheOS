'use strict';
/* models-money.js — shared helpers for the "models and money" tools (pacer.js, offpeak-*.js, cap-numerator.js).
 *
 *   const mm = require('./lib/models-money');
 *   mm.pacingPolicy(root)            company/work/finance/pacing-policy.json, else the company/defaults copy, else {}
 *   mm.peakConfig(root, 'deepseek')  that provider's peak-price windows from pacingPolicy().peakPricing, normalised:
 *                                    { provider, known, timezone, days:Set(0-6), blocks:[[startMin,endMin]], marginMin }
 *                                    known:false (no config) means "no peak hours": nothing is held or flagged.
 *   mm.mustNotMove(root)             pacingPolicy().offpeakHold.mustNotMove (array of routine-name prefixes), or null
 *                                    when the key is missing or not an array (callers then exempt every routine)
 *   mm.zoneParts(ms, tz)             wall-clock pieces of `ms` in IANA zone `tz`: { day:0-6, min, hour, minute, date }
 *   mm.zonedMs(tz, y, mo, d, h, mi)  the millisecond of that wall-clock time in `tz` (mo 1-12)
 *   mm.readSecret(root, name)        secrets/<name> under `root`; for the real company root also env (co.secret)
 *
 * Peak-price hours are a provider's pricing fact, so they are config keyed by provider and stated in the provider's
 * own timezone, never in the company's: a company in another timezone reads the same file and gets the right hours.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const POLICY_REL = path.join('company', 'work', 'finance', 'pacing-policy.json');
const DEFAULT_POLICY_REL = path.join('company', 'defaults', 'work', 'finance', 'pacing-policy.json');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pacingPolicy(root) {
  const r = root || co.ROOT;
  return co.readJson(path.join(r, POLICY_REL), null) || co.readJson(path.join(r, DEFAULT_POLICY_REL), null) || {};
}

const hhmmToMin = v => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

function normalisePeak(provider, raw) {
  const out = { provider, known: false, timezone: 'UTC', days: new Set(), blocks: [], marginMin: 0 };
  if (!raw || typeof raw !== 'object') return out;
  try { new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone || 'UTC' }); out.timezone = raw.timezone || 'UTC'; } catch (_) { return out; }
  for (const d of Array.isArray(raw.days) ? raw.days : []) {
    const i = typeof d === 'number' ? d : DAYS.indexOf(String(d).slice(0, 3).toLowerCase());
    if (i >= 0 && i <= 6) out.days.add(i);
  }
  for (const b of Array.isArray(raw.blocks) ? raw.blocks : []) {
    const s = hhmmToMin(b && b[0]), e = hhmmToMin(b && b[1]);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) out.blocks.push([s, e]);
  }
  const mg = Number(raw.marginMin);
  out.marginMin = Number.isFinite(mg) && mg >= 0 && mg <= 120 ? mg : 0;
  out.known = out.days.size > 0 && out.blocks.length > 0;
  return out;
}

function peakConfig(root, provider) {
  const pv = provider || 'deepseek';
  const pp = (pacingPolicy(root) || {}).peakPricing || {};
  return normalisePeak(pv, pp[pv]);
}

function mustNotMove(root) {
  const oh = (pacingPolicy(root) || {}).offpeakHold;
  return oh && Array.isArray(oh.mustNotMove) ? oh.mustNotMove.map(String) : null;
}

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }));
  return fmtCache.get(tz);
}
function zoneParts(ms, tz) {
  const o = {};
  for (const x of fmt(tz || 'UTC').formatToParts(new Date(ms))) o[x.type] = x.value;
  const hour = Number(o.hour) % 24, minute = Number(o.minute);
  return { day: DAYS.indexOf(String(o.weekday).slice(0, 3).toLowerCase()), hour, minute, min: hour * 60 + minute, date: o.year + '-' + o.month + '-' + o.day };
}
// the wall-clock time in `tz` as a millisecond: guess it as UTC, then correct by the zone's offset (twice, for DST edges)
function zonedMs(tz, y, mo, d, h, mi) {
  const want = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(t, tz);
    const [py, pm, pd] = p.date.split('-').map(Number);
    t += want - Date.UTC(py, pm - 1, pd, p.hour, p.minute);
  }
  return t;
}

function readSecret(root, name) {
  if (!root || path.resolve(root) === path.resolve(co.ROOT)) return co.secret(name);
  try { return fs.readFileSync(path.join(root, 'secrets', name), 'utf8').trim() || null; } catch (_) { return null; }
}

module.exports = { POLICY_REL, DEFAULT_POLICY_REL, pacingPolicy, peakConfig, normalisePeak, mustNotMove, zoneParts, zonedMs, readSecret };
