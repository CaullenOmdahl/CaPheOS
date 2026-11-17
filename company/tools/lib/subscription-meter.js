'use strict';
/* lib/subscription-meter.js — how a provider's use is shown as information (owner ruling 2026-11-18: cost is information,
 * never a gate): metered providers in dollars, subscription plans as a share of their usage windows, anything else as
 * "unknown" (never 0, never "$0.00").
 *
 *   plans()               company/work/finance/subscriptions.json plans (defaults: company/defaults/work/finance/)
 *   kindOf(provider)      'subscription' | 'metered' | 'unknown'
 *   windows(provider)     { week: {usedPct, at} | null, fiveHour: {usedPct, at} | null } from the pacer's readings
 *                         (company/state/pacer-state.json), or nulls when there is none
 *   line(byProvider, o)   one plain line for a set of runs: [{provider, turns, usd, start: windows at the start}]
 * Reads only; no amounts of any balance here (those are the owner's: lib/provider-balance.js).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const NAMES = { 'claude-cli': 'Claude', anthropic: 'Claude', custom: 'MiniMax', minimax: 'MiniMax', deepseek: 'DeepSeek', openrouter: 'OpenRouter' };
const METERED = new Set(['deepseek', 'openrouter']);
const METER_KEY = { 'claude-cli': 'claude', custom: 'minimax', minimax: 'minimax' };

function plans(root) {
  const r = root || co.ROOT;
  const own = readJ(path.join(r, 'company', 'work', 'finance', 'subscriptions.json'));
  const def = readJ(path.join(r, 'company', 'defaults', 'work', 'finance', 'subscriptions.json'));
  return ((own && Array.isArray(own.plans)) ? own.plans : (def && def.plans) || []).filter(p => p && p.provider);
}
function unmetered(root) {
  const r = root || co.ROOT;
  const b = Object.assign({}, readJ(path.join(r, 'company', 'defaults', 'work', 'finance', 'dispatch-budget.json')) || {}, readJ(path.join(r, 'company', 'work', 'finance', 'dispatch-budget.json')) || {});
  return (Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders : ['claude-cli']).map(String);
}
function kindOf(provider, o) {
  const p = String(provider || '');
  if (plans(o && o.root).some(x => x.provider === p) || METER_KEY[p]) return 'subscription';
  if (METERED.has(p) || !unmetered(o && o.root).includes(p)) return 'metered';
  return 'unknown';
}
function windows(provider, o) {
  const st = readJ(path.join((o && o.root) || co.ROOT, 'company', 'state', 'pacer-state.json')) || {};
  const key = METER_KEY[String(provider || '')]; if (!key) return { week: null, fiveHour: null };
  const h = ((st.history || {})[key] || []).filter(x => x && Number.isFinite(Number(x.usedPct)));
  const last = h[h.length - 1];
  const week = last ? { usedPct: Number(last.usedPct), at: Number(last.at) || null } : null;
  let fiveHour = null;
  const rd = key === 'minimax' ? (st.minimax || {}).reading : null;
  if (rd && Number.isFinite(Number(rd.fiveHourLeftPct))) fiveHour = { usedPct: Math.max(0, 100 - Number(rd.fiveHourLeftPct)), at: Number(rd.at) || null };
  const fh = key === 'claude' && st.last && st.last.claude && st.last.claude.fiveHour;
  if (fh && Number.isFinite(Number(fh.usedPct))) fiveHour = { usedPct: Number(fh.usedPct), at: Number(st.last.claude.at) || null };
  return { week, fiveHour };
}
const pct = n => (Math.round(n * 10) / 10).toString().replace(/\.0$/, '') + '%';
function part(x, o) {
  const name = NAMES[x.provider] || x.provider;
  const k = kindOf(x.provider, o);
  if (k === 'metered') { const u = Number(x.usd) || 0; return name + ' ' + (u > 0 && u < 0.005 ? 'under $0.01' : '$' + u.toFixed(2)); }
  if (k === 'subscription') {
    const now = windows(x.provider, o), s = x.start || {};
    const bits = [];
    if (now.fiveHour && s.fiveHour) bits.push(pct(Math.max(0, now.fiveHour.usedPct - s.fiveHour.usedPct)) + ' of the 5-hour window');
    if (now.week && s.week) bits.push(pct(Math.max(0, now.week.usedPct - s.week.usedPct)) + ' of the week');
    const plan = plans(o && o.root).find(p => p.provider === x.provider);
    return name + (plan && plan.name ? ' (' + plan.name + ')' : '') + ': ' + (bits.length ? bits.join(', ') : 'share of the plan unknown (no reading of its windows)');
  }
  return name + ': unknown';
}
function line(byProvider, o) {
  const rows = Object.entries(byProvider || {}).map(([provider, v]) => Object.assign({ provider }, v)).filter(x => x.turns > 0);
  return rows.map(x => part(x, o)).join(' · ');
}
module.exports = { plans, kindOf, windows, line, NAMES };
