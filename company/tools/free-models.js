#!/usr/bin/env node
/* free-models.js — the free-model registry for the OpenRouter fallback (docs/FREE-MODELS.md). No AI.
 *
 *   node company/tools/free-models.js refresh [--force] [--json]   read OpenRouter's public model list (no key), keep the
 *                                                                  free ones, write company/state/free-models.json
 *   node company/tools/free-models.js list [--json]                the stored list, in default order
 *   node company/tools/free-models.js pick [--seat <id>] [--class <c>] [--json]
 *                                                                  which free model `openrouter/free` resolves to now, and why
 *   node company/tools/free-models.js --selftest                   against a stub list; nothing live
 *
 * A model is free when its id ends ':free' or every price the list gives for it is 0 (lib/free-models.js isFreeRow);
 * anything else is never written here. The file: { v, at, source, count, models: [{ id, name, context, maxOut, tools,
 * reasoning, firstSeen, lastSeen }], ranked: [ids in default order], lastTry: { at, ok, why? } }. A failed read keeps the
 * last good list (only lastTry changes); an id the list no longer names is dropped at the next good read.
 * The dispatcher calls refresh() once per tick (company/tools/dispatch.js); it reads the network only when the stored
 * list is older than freeFallback.refreshHours (default 24) and the fallback is on (model-policy.json allowed.openrouter
 * has "free"), and at most once per hour after a failure. CAPHEOS_NO_NETWORK=1 (a duty, a test) never reads it.
 * Env: CAPHEOS_OPENROUTER_BASE (default https://openrouter.ai/api/v1) for a stub. Never reads or prints a key.
 * Owner: the people function (the model manager).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const FM = require('./lib/free-models');

const BASE = () => String(process.env.CAPHEOS_OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const HOUR = 3600e3;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n'); fs.renameSync(tmp, f);
}
const regFile = root => path.join(path.resolve(root || co.ROOT), FM.REG_REL);

/* the catalog rows -> the registry's model rows (free ones only), keeping firstSeen from the last list */
function freeRows(data, prev, at) {
  const seen = new Map(((prev && prev.models) || []).map(m => [m.id, m]));
  const out = [];
  for (const m of Array.isArray(data) ? data : []) {
    if (!FM.isFreeRow(m)) continue;
    const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const old = seen.get(m.id);
    out.push({ id: String(m.id).slice(0, 160), name: String(m.name || m.id).slice(0, 160), context: Number(m.context_length) || 0,
      maxOut: Number(m.top_provider && m.top_provider.max_completion_tokens) || 0, tools: sp.includes('tools'),
      reasoning: sp.includes('reasoning') || sp.includes('include_reasoning'), firstSeen: (old && old.firstSeen) || at, lastSeen: at });
  }
  const ids = new Set(); return out.filter(m => !ids.has(m.id) && ids.add(m.id));
}

async function refresh(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT), f = regFile(root), t = o.now != null ? o.now : Date.now();
  const log = typeof o.log === 'function' ? o.log : () => {};
  const pol = readJson(path.join(root, 'company', 'model-policy.json'), {}) || {};
  const S = FM.settings(pol), refreshH = Number((pol.freeFallback || {}).refreshHours) > 0 ? Number(pol.freeFallback.refreshHours) : 24;
  const prev = readJson(f, null);
  if (!o.force) {
    if (!FM.aliasAllowed(pol)) return { ran: false, why: 'the free-model fallback is off' };
    const at = prev && (Date.parse(prev.at || '') || 0);
    if (at && t - at < refreshH * HOUR) return { ran: false, why: 'the list is ' + Math.round((t - at) / 60e3) + ' min old' };
    const tried = prev && prev.lastTry && !prev.lastTry.ok && Date.parse(prev.lastTry.at || '');
    if (tried && t - tried < HOUR) return { ran: false, why: 'the last read failed less than an hour ago' };
  }
  if (process.env.CAPHEOS_NO_NETWORK === '1' && !o.fetch) return { ran: false, why: 'network off (CAPHEOS_NO_NETWORK)' };
  if (o.dry) return { ran: false, why: 'dry run' };
  const doFetch = o.fetch || fetch;
  const iso = new Date(t).toISOString();
  let rows, why = '';
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), o.timeoutMs || 20000);
    let res; try { res = await doFetch(BASE() + '/models', { headers: { Accept: 'application/json' }, signal: ac.signal }); } finally { clearTimeout(tm); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j || !Array.isArray(j.data) || !j.data.length) throw new Error('the model list was empty or not a list');
    rows = freeRows(j.data, prev, iso);
    if (!rows.length) throw new Error('the model list names no free model');
  } catch (e) { why = String((e && e.message) || e).slice(0, 200); }
  if (!rows) {
    const keep = prev && Array.isArray(prev.models) ? prev : { v: 1, at: null, source: BASE() + '/models', count: 0, models: [], ranked: [] };
    keep.lastTry = { at: iso, ok: false, why };
    writeJson(f, keep);
    log('FREE MODELS: refresh failed, kept the last list (' + (keep.models.length) + ' models): ' + why);
    return { ran: true, ok: false, why, kept: keep.models.length };
  }
  const before = new Set(((prev && prev.models) || []).map(m => m.id));
  const doc = { v: 1, at: iso, source: BASE() + '/models', count: rows.length, models: rows.sort((a, b) => (a.id < b.id ? -1 : 1)), ranked: FM.defaultOrder(rows), lastTry: { at: iso, ok: true } };
  writeJson(f, doc);
  const added = rows.filter(m => !before.has(m.id)).length, dropped = [...before].filter(id => !rows.some(m => m.id === id)).length;
  if (added || dropped || !prev) log('FREE MODELS: ' + rows.length + ' free models listed (' + added + ' new, ' + dropped + ' gone)');
  return { ran: true, ok: true, count: rows.length, added, dropped, maxAgeHours: S.maxAgeHours };
}

function pick(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT), t = o.now != null ? o.now : Date.now();
  let runs = o.runs;
  if (!runs) {
    runs = [];
    try {
      const rows = require('./lib/bounded').jsonlWindow(path.join(root, '.starnet-data', 'workspaces', 'runs.jsonl'), { sinceMs: t - 48 * HOUR, maxBytes: 16 << 20 }).rows;
      for (const r of rows) if (r && r.provider === FM.PROVIDER) runs.push({ provider: r.provider, model: r.model, reason: r.reason, failureCode: r.failureCode || '', error: String(r.error || '').slice(0, 160), at: Number(r.endedAt || r.ts || r.startedAt) || 0 });
    } catch (_) {}
  }
  return FM.resolve({ root, now: t, runs, cls: o.cls || null, hasKey: o.hasKey });
}

/* ---------------- selftest ---------------- */
async function selftest() {
  const life = require('./lib/temp-life');
  const root = life.tmpDir('free-models-selftest-');
  let bad = 0; const ok = (name, cond, detail) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  [' + (detail || '') + ']')); if (!cond) bad++; };
  fs.mkdirSync(path.join(root, 'company'), { recursive: true });
  const pol = { allowed: { openrouter: { models: ['free'] } }, freeFallback: { enabled: true } };
  fs.writeFileSync(path.join(root, 'company', 'model-policy.json'), JSON.stringify(pol));
  const LIST = [
    { id: 'vendor-a/big-model:free', name: 'Big', context_length: 128000, top_provider: { max_completion_tokens: 8000 }, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'reasoning'] },
    { id: 'vendor-b/small:free', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
    { id: 'vendor-c/zero-priced', context_length: 64000, pricing: { prompt: '0', completion: '0', request: '0', image: '0' }, supported_parameters: ['tools'] },
    { id: 'vendor-d/paid', context_length: 200000, pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] },
    { id: 'vendor-e/request-fee', pricing: { prompt: '0', completion: '0', request: '0.01' } },
    { id: 'vendor-f/no-price' },
    { id: 'router/auto', pricing: { prompt: '-1', completion: '-1' } },
    { id: 'openrouter/free', context_length: 2000000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
    { id: 'vendor-g/music', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
  ];
  let calls = 0, sawAuth = false;
  const stub = (status, body) => async (url, init) => { calls++; if (init && init.headers && (init.headers.Authorization || init.headers.authorization)) sawAuth = true; return { ok: status === 200, status, json: async () => body }; };
  const t0 = Date.parse('2026-06-01T10:00:00Z');
  let r = await refresh({ root, now: t0, fetch: stub(200, { data: LIST }) });
  const reg = readJson(regFile(root), null);
  ok('refresh writes the registry', r.ok && reg && reg.count === 4, JSON.stringify(r));
  ok('only free models are kept (":free" or every price 0)', reg && reg.models.map(m => m.id).join() === 'openrouter/free,vendor-a/big-model:free,vendor-b/small:free,vendor-c/zero-priced', reg && reg.models.map(m => m.id).join());
  ok('a request fee, a missing price, a negative price or no text output is not kept', reg && !reg.models.some(m => /paid|request-fee|no-price|auto|music/.test(m.id)));
  ok('default order: tools first, then the larger context; OpenRouter\'s own router last', reg && reg.ranked.join() === 'vendor-a/big-model:free,vendor-c/zero-priced,vendor-b/small:free,openrouter/free', reg && reg.ranked.join());
  ok('the public list is read without a key', calls === 1 && !sawAuth);
  r = await refresh({ root, now: t0 + 3600e3, fetch: stub(200, { data: LIST }) });
  ok('a fresh list is not read again', r.ran === false && calls === 1, JSON.stringify(r));
  r = await refresh({ root, now: t0 + 30 * 3600e3, fetch: stub(503, {}) });
  const kept = readJson(regFile(root), null);
  ok('a failed read keeps the last good list', r.ran && !r.ok && kept.count === 4 && kept.lastTry && kept.lastTry.ok === false && kept.at === reg.at, JSON.stringify(kept.lastTry));
  r = await refresh({ root, now: t0 + 30.5 * 3600e3, fetch: stub(200, { data: LIST }) });
  ok('after a failure, no new read for an hour', r.ran === false, JSON.stringify(r));
  r = await refresh({ root, now: t0 + 32 * 3600e3, fetch: stub(200, { data: LIST.filter(m => m.id !== 'vendor-b/small:free') }) });
  const reg2 = readJson(regFile(root), null);
  ok('a model the list no longer names is dropped; firstSeen is kept', r.ok && r.dropped === 1 && reg2.count === 3 && reg2.models[0].firstSeen === reg.models[0].firstSeen, JSON.stringify(r));
  const off = JSON.parse(JSON.stringify(pol)); off.freeFallback.enabled = false;
  fs.writeFileSync(path.join(root, 'company', 'model-policy.json'), JSON.stringify(off));
  r = await refresh({ root, now: t0 + 100 * 3600e3, fetch: stub(200, { data: LIST }) });
  ok('the fallback off: no read at all', r.ran === false && /off/.test(r.why), JSON.stringify(r));
  fs.writeFileSync(path.join(root, 'company', 'model-policy.json'), JSON.stringify(pol));
  const t1 = Date.parse(reg2.at) + 3600e3;
  let p = pick({ root, now: t1, runs: [], hasKey: true });
  ok('pick: the first in default order', p.ok && p.model === 'vendor-a/big-model:free', JSON.stringify(p));
  p = pick({ root, now: t1, hasKey: true, runs: ['vendor-a/big-model:free', 'vendor-c/zero-priced'].map(m => ({ provider: 'openrouter', model: m, reason: 'error', failureCode: 'provider_unavailable', at: t1 - 60e3 })) });
  ok('pick: a model without tools is never picked; the router is the last resort', p.ok && p.model === 'openrouter/free', JSON.stringify(p));
  p = pick({ root, now: t1, runs: [], hasKey: false });
  ok('pick: no key, nothing runs', !p.ok && /key/.test(p.why));
  p = pick({ root, now: t1, hasKey: true, runs: [{ provider: 'openrouter', model: 'vendor-a/big-model:free', reason: 'error', failureCode: 'rate_limited', error: 'openrouter http 429', at: t1 - 5 * 60e3 }] });
  ok('pick: a model that just failed is skipped for the next one', p.ok && p.model === 'vendor-c/zero-priced' && p.skipped.length === 1, JSON.stringify(p));
  p = pick({ root, now: t1, hasKey: true, runs: [{ provider: 'openrouter', model: 'vendor-c/zero-priced', reason: 'error', error: 'openrouter http 429 — Rate limit exceeded: free-models-per-day', at: t1 - 60e3 }] });
  ok('pick: the daily free limit holds every free model until 00:00 UTC', !p.ok && p.until === FM.nextUtcMidnight(t1), JSON.stringify(p));
  const ranking = { cells: [{ provider: 'openrouter', modelId: 'vendor-c/zero-priced', class: 'code', items: 9, lower: 0.7 }, { provider: 'openrouter', modelId: 'vendor-a/big-model:free', class: 'code', items: 9, lower: 0.4 },
    { provider: 'openrouter', modelId: 'vendor-a/big-model:free', class: 'writing', items: 9, lower: 0.9 }] };
  ok('order: house-ranking lower bound in the class first', FM.order(reg2, ranking, { cls: 'code', minItems: 5 })[0] === 'vendor-c/zero-priced');
  ok('order: another class has its own best', FM.order(reg2, ranking, { cls: 'writing', minItems: 5 })[0] === 'vendor-a/big-model:free');
  ok('order: too few items is not data', FM.order(reg2, ranking, { cls: 'code', minItems: 20 })[0] === 'vendor-a/big-model:free');
  p = pick({ root, now: Date.parse(reg2.at) + 80 * 3600e3, runs: [], hasKey: true });
  ok('pick: a list older than maxAgeHours is not used', !p.ok && /older/.test(p.why), JSON.stringify(p));
  ok('isFreePair: the alias and a :free id are free, a paid id is not', FM.isFreePair('openrouter', 'free') && FM.isFreePair('openrouter', 'x/y:free') && !FM.isFreePair('openrouter', 'vendor-d/paid', root) && FM.isFreePair('openrouter', 'vendor-c/zero-priced', root) && !FM.isFreePair('deepseek', 'x:free'));
  console.log(bad ? 'FREE-MODELS SELFTEST FAILED: ' + bad : 'FREE-MODELS SELFTEST PASSED');
  return bad ? 1 : 0;
}

async function main(argv) {
  const cmd = argv[0] || 'list', json = argv.includes('--json');
  const val = k => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  if (cmd === '--selftest' || cmd === 'selftest' || argv.includes('--selftest')) return selftest();
  if (cmd === 'refresh') {
    const r = await refresh({ force: argv.includes('--force'), log: l => { if (!json) console.log(l); } });
    if (json) console.log(JSON.stringify(r)); else if (!r.ran) console.log('not read: ' + r.why);
    return r.ran && !r.ok ? 1 : 0;
  }
  if (cmd === 'list') {
    const reg = FM.load(co.ROOT);
    if (json) { console.log(JSON.stringify(reg || { models: [] }, null, 1)); return 0; }
    if (!reg || !reg.models.length) { console.log('no free models listed yet: node company/tools/free-models.js refresh'); return 0; }
    console.log(reg.count + ' free models, listed ' + reg.at + (reg.lastTry && !reg.lastTry.ok ? ' (the last read failed: ' + reg.lastTry.why + ')' : ''));
    for (const id of reg.ranked) { const m = reg.models.find(x => x.id === id) || {}; console.log('  ' + id.padEnd(56) + ' ctx ' + String(m.context || '?').padStart(7) + (m.tools ? '  tools' : '') + (m.reasoning ? '  reasoning' : '')); }
    return 0;
  }
  if (cmd === 'pick') {
    const r = pick({ cls: val('--class') });
    if (json) console.log(JSON.stringify(r)); else console.log(r.ok ? 'openrouter/free -> openrouter/' + r.model + (r.alternates && r.alternates.length ? ' (then ' + r.alternates.join(', ') + ')' : '') : 'nothing: ' + r.why);
    return r.ok ? 0 : 1;
  }
  console.error('usage: free-models.js refresh [--force] [--json] | list [--json] | pick [--class c] [--json] | --selftest');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(String(e && e.stack || e)); process.exit(1); });
module.exports = { refresh, pick, freeRows };
