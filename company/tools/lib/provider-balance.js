'use strict';
/* lib/provider-balance.js — a prepaid provider's balance, the OWNER's information only (owner ruling 2026-11-18: agents
 * never see amounts; the owner does).
 *
 * company/state/provider-balance.json (0600): { deepseek: { at, available, balances: [{currency, total, granted,
 * toppedUp}], low: {key, since, currencies} | null, alertedKey } }. Written only by the pacer's balance poll; read by the
 * console (Spend, Today) for the owner. Never copied into a log, a report, the pacer's own state or an agent's prompt.
 * Currencies are kept apart, as DeepSeek reports them (USD or CNY): never summed, never converted.
 *
 *   record(provider, reading, o)   keep the reading; when a currency drops below its low line, tell the owner ONCE per
 *                                  drop (o.notify(text): a plain line with no amount), before the account runs dry
 *   lowLine(currency, perDayUsd)   the low line: about 3 days of the last 7 days' use, at least $2 (USD) or ¥15 (CNY);
 *                                  another currency: its floor is unknown, so only "empty" counts
 *   status(provider, o)            { low: bool, key, currencies } for the duty (no amounts leave this function)
 *   read(o)                        the whole file, for the owner's console only
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const FLOOR = { USD: 2, CNY: 15 };
const DAYS = 3;
const file = o => path.join((o && o.root) || co.ROOT, 'company', 'state', 'provider-balance.json');
const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
function read(o) { return readJ(file(o)) || {}; }
function write(doc, o) {
  const f = file(o); fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(doc, null, 1), { mode: 0o600 }); fs.renameSync(t, f);
  try { fs.chmodSync(f, 0o600); } catch (_) {}
}
function lowLine(currency, perDayUsd) {
  const c = String(currency || '').toUpperCase();
  if (c === 'USD') return Math.max(FLOOR.USD, DAYS * (Number(perDayUsd) || 0));
  if (FLOOR[c] != null) return FLOOR[c];   // no conversion: the floor only
  return 0;
}
function parse(infos) {
  return (Array.isArray(infos) ? infos : []).map(b => ({ currency: String(b.currency || '').toUpperCase().slice(0, 8), total: Number(b.total_balance != null ? b.total_balance : b.total), granted: Number(b.granted_balance != null ? b.granted_balance : b.granted) || 0, toppedUp: Number(b.topped_up_balance != null ? b.topped_up_balance : b.toppedUp) || 0 }))
    .filter(b => b.currency && Number.isFinite(b.total));
}
// the last 7 days of this provider's metered use, per day, from StarNet's run records (bounded read)
function perDayUsd(provider, o) {
  try {
    const B = require('./bounded'); const now = (o && o.now) || Date.now();
    const rows = B.jsonlWindow(path.join((o && o.root) || co.ROOT, '.starnet-data', 'workspaces', 'runs.jsonl'), { sinceMs: now - 7 * 86400e3, maxBytes: 16 << 20 }).rows;
    return rows.filter(r => r && r.provider === provider).reduce((s, r) => s + (Number(r.usd) || 0), 0) / 7;
  } catch (_) { return 0; }
}
function record(provider, reading, o) {
  o = o || {};
  const doc = read(o); const prev = doc[provider] || {};
  const balances = parse(reading && reading.balances);
  const perDay = o.perDayUsd != null ? Number(o.perDayUsd) : perDayUsd(provider, o);
  const lowCur = balances.filter(b => b.total <= lowLine(b.currency, perDay) || (reading && reading.available === false)).map(b => b.currency);
  const low = lowCur.length ? { key: provider + ':' + lowCur.join(',') + ':' + (prev.low && prev.low.key ? prev.low.since : Date.now()), since: prev.low && prev.low.since ? prev.low.since : Date.now(), currencies: lowCur } : null;
  if (low && prev.low && prev.low.currencies && prev.low.currencies.join() === lowCur.join()) low.key = prev.low.key;
  const cur = { at: (reading && reading.at) || Date.now(), available: reading ? reading.available : null, balances, low, alertedKey: prev.alertedKey || null };
  let alerted = false;
  if (low && cur.alertedKey !== low.key) {
    const name = provider === 'deepseek' ? 'DeepSeek' : provider;
    const text = name + '\'s prepaid credit is running low (' + (reading && reading.available === false ? 'it has run out' : 'under about ' + DAYS + ' days of use') + '). Top it up to keep the seats on it running; the amount is on Spend in the console.';
    try { if (typeof o.notify === 'function') o.notify(text); } catch (_) {}
    cur.alertedKey = low.key; alerted = true;
  }
  if (!low) cur.alertedKey = null;   // back above the line: the next drop alerts again
  doc[provider] = cur; write(doc, o);
  return { low: !!low, alerted, currencies: low ? low.currencies : [] };
}
function status(provider, o) { const d = read(o)[provider]; return d ? { low: !!d.low, key: d.low ? d.low.key : null, currencies: d.low ? d.low.currencies : [], at: d.at } : { low: false, key: null, currencies: [], at: null }; }
module.exports = { record, read, status, lowLine, parse, FLOOR, DAYS, file };
