/* lib/minimax-endpoint.js — where this company's MiniMax account lives: Global, Mainland China, or a custom base URL.
 *
 * ONE SOURCE OF TRUTH: company/company.json `providers.minimax`:
 *   { "region": "global" }                       (no entry at all = global, the behaviour before regions existed)
 *   { "region": "cn" }
 *   { "region": "custom", "baseUrl": "https://…/v1", "usageUrl"?: "https://…/v1/token_plan/remains", "other"?: true }
 * Everything that needs a MiniMax address reads it from here: console Setup/Settings (StarNet's `custom` provider
 * baseUrl sent on connect, the "Get a key" link), the typed owner question that stores a MiniMax key, pacer.js (the
 * plan's usage URL: pacing-policy.json minimax.url only wins when it is set to something other than a built-in
 * default), and build-inventory.js.
 *
 * The facts, from MiniMax's own docs (read 2026-11-17):
 *   Global, OpenAI-compatible  https://api.minimax.io/v1          https://platform.minimax.io/docs/api-reference/text-openai-api
 *   Global, Anthropic-compat.  https://api.minimax.io/anthropic   https://platform.minimax.io/docs/api-reference/text-anthropic-api
 *   Global, API keys           https://platform.minimax.io/user-center/basic-information/interface-key
 *                              (https://platform.minimax.io/docs/guides/quickstart-preparation)
 *   China, OpenAI-compatible   https://api.minimax.cn/v1          https://platform.minimaxi.com/docs/api-reference/text-openai-api
 *   China, Anthropic-compat.   https://api.minimax.cn/anthropic   https://platform.minimaxi.com/docs/api-reference/text-anthropic-api
 *   China, API keys            https://platform.minimaxi.com/user-center/basic-information/interface-key
 *                              (https://platform.minimaxi.com/docs/guides/quickstart-preparation; platform.minimaxi.com
 *                              now redirects its docs to platform.minimax.cn)
 *   Both regions offer an OpenAI-compatible /v1 AND an Anthropic-compatible /anthropic endpoint. StarNet's `custom`
 *   provider speaks the OpenAI wire, so baseUrl is always the /v1 one.
 *   Plan usage: the docs only point at the web page (https://platform.minimax.io/docs/m-plan/usage-rules: console/usage,
 *   or `mmx quota`). MiniMax's official CLI (https://github.com/MiniMax-AI/cli, src/client/endpoints.ts) calls
 *   `${host}/v1/token_plan/remains` with host api.minimax.io / api.minimax.cn, and treats api.minimaxi.com as the
 *   China host too (src/errors/api.ts).
 * Choices made here:
 *   - China uses api.minimaxi.com (the CLI's documented China host, still served) rather than the newer api.minimax.cn
 *     alias: StarNet patch 0007 (MiniMax reasoning replay) recognises *.minimax.io and *.minimaxi.com only, so
 *     api.minimax.cn would silently lose the replay. Custom accepts api.minimax.cn (see the warning it gets).
 *   - Global usage stays https://www.minimax.io/v1/token_plan/remains, the URL the pacer has read successfully since
 *     before regions existed (an existing company keeps its exact behaviour).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REGIONS = {
  global: {
    id: 'global', label: 'Global', what: 'Your account is on minimax.io (anywhere outside mainland China).',
    baseUrl: 'https://api.minimax.io/v1', anthropicUrl: 'https://api.minimax.io/anthropic',
    usageUrl: 'https://www.minimax.io/v1/token_plan/remains',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  },
  cn: {
    id: 'cn', label: 'Mainland China', what: 'Your account is on minimaxi.com (the mainland China service).',
    baseUrl: 'https://api.minimaxi.com/v1', anthropicUrl: 'https://api.minimaxi.com/anthropic',
    usageUrl: 'https://api.minimaxi.com/v1/token_plan/remains',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
};
const CUSTOM = { id: 'custom', label: 'Custom', what: 'A different address, for example a company proxy in front of MiniMax.' };
const ORDER = ['global', 'cn'];   // what "Find my endpoint" tries, in this order
// usage URLs that are built-in defaults, never an owner override (pacing-policy.json copies made before regions held one)
const DEFAULT_USAGE = new Set(['https://www.minimax.io/v1/token_plan/remains', 'https://api.minimax.io/v1/token_plan/remains',
  REGIONS.cn.usageUrl, 'https://api.minimax.cn/v1/token_plan/remains']);
const MINIMAX_HOST = /(^|\.)(minimax\.io|minimaxi\.com|minimax\.cn)$/i;
const REPLAY_HOST = /(^|\.)minimaxi?\.(io|com)$/i;   // what StarNet patch 0007 recognises

// the options the owner picks from: plain words in `what`; the addresses only for the Details line and the key link
const choices = () => ORDER.map(k => ({ id: k, label: REGIONS[k].label, what: REGIONS[k].what, baseUrl: REGIONS[k].baseUrl, keyUrl: REGIONS[k].keyUrl })).concat([{ id: CUSTOM.id, label: CUSTOM.label, what: CUSTOM.what }]);

// a custom base URL: https only, no credentials, query or fragment; a non-MiniMax host only with other=true (and a warning)
function checkCustomUrl(raw, other) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: 'type the base URL (it starts with https)' };
  if (s.length > 300) return { ok: false, error: 'that address is too long' };
  let u; try { u = new URL(s); } catch (_) { return { ok: false, error: 'that is not a web address (it should look like api.example.com/v1, with https in front)' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'the address must be a secure one (starting with https) so the key is never sent in the clear' };
  if (u.username || u.password) return { ok: false, error: 'the address must not carry a user name or password' };
  if (u.search || u.hash) return { ok: false, error: 'the address must not have a ? or # part' };
  const host = u.hostname.toLowerCase();
  const minimax = MINIMAX_HOST.test(host);
  if (!minimax && other !== true) return { ok: false, code: 'not-minimax', error: host + ' is not a MiniMax address. Tick "This is not a MiniMax address" if you mean it.' };
  const baseUrl = (u.origin + u.pathname).replace(/\/+$/, '');
  const warnings = [];
  if (!minimax) warnings.push('This is not a MiniMax address: your MiniMax key will be sent to ' + host + '. Only use it if you trust that service.');
  else if (!REPLAY_HOST.test(host)) warnings.push('The station keeps MiniMax\'s thinking between steps only on minimax.io and minimaxi.com addresses; on ' + host + ' agents may repeat work.');
  if (!/\/v1$/.test(baseUrl)) warnings.push('The station speaks the OpenAI-compatible wire, which MiniMax serves under /v1. This address does not end in /v1.');
  return { ok: true, baseUrl, host, minimax, warnings };
}

// {region, baseUrl?, usageUrl?, other?} -> the full endpoint, or {ok:false, error}
function resolve(input) {
  const i = input && typeof input === 'object' ? input : {};
  const region = String(i.region || 'global').trim().toLowerCase();
  if (REGIONS[region]) { const r = REGIONS[region]; return { ok: true, region, label: r.label, baseUrl: r.baseUrl, usageUrl: r.usageUrl, keyUrl: r.keyUrl, custom: false, warnings: [] }; }
  if (region !== 'custom') return { ok: false, error: 'the MiniMax endpoint is global, cn or custom (not "' + region.slice(0, 20) + '")' };
  const c = checkCustomUrl(i.baseUrl, i.other === true);
  if (!c.ok) return c;
  let usageUrl = null;
  if (i.usageUrl) { const u = checkCustomUrl(i.usageUrl, i.other === true); if (!u.ok) return { ok: false, error: 'usage address: ' + u.error }; usageUrl = u.baseUrl; }
  else usageUrl = new URL(c.baseUrl).origin + '/v1/token_plan/remains';
  // the key page: the platform the custom host belongs to (a non-MiniMax host gets the global page)
  const keyUrl = /(^|\.)(minimaxi\.com|minimax\.cn)$/i.test(c.host) ? REGIONS.cn.keyUrl : REGIONS.global.keyUrl;
  return { ok: true, region: 'custom', label: CUSTOM.label, baseUrl: c.baseUrl, usageUrl, keyUrl, custom: true, other: !c.minimax, warnings: c.warnings };
}

const companyFile = root => path.join(root, 'company', 'company.json');
function readCfg(root) { try { return JSON.parse(fs.readFileSync(companyFile(root), 'utf8')); } catch (_) { return {}; } }
// the stored endpoint (company.json providers.minimax); nothing stored = global. A broken entry falls back to global
// and says why in `problem` (Settings shows it), so a typo never stops the company.
function fromConfig(cfg) {
  const m = cfg && cfg.providers && cfg.providers.minimax;
  if (!m || !m.region) return Object.assign(resolve({ region: 'global' }), { stored: false });
  const r = resolve(m);
  if (r.ok) return Object.assign(r, { stored: true, setBy: m.setBy || '', setAt: m.setAt || '' });
  return Object.assign(resolve({ region: 'global' }), { stored: true, problem: 'company.json providers.minimax is not usable (' + r.error + '); Global is used' });
}
const read = root => fromConfig(readCfg(root));
// what is written to company.json: the region, and for custom the address (presets are never copied: one source)
function entryOf(ep, by) {
  const e = { region: ep.region };
  if (ep.region === 'custom') { e.baseUrl = ep.baseUrl; if (ep.usageUrl && ep.usageUrl !== new URL(ep.baseUrl).origin + '/v1/token_plan/remains') e.usageUrl = ep.usageUrl; if (ep.other) e.other = true; }
  if (by) { e.setBy = by; e.setAt = new Date().toISOString(); }
  return e;
}
const same = (a, b) => !!a && !!b && a.region === b.region && a.baseUrl === b.baseUrl && a.usageUrl === b.usageUrl;
// the usage URL the pacer polls: an explicit pacing-policy.json minimax.url wins unless it is a built-in default
function usageUrlFor(policyUrl, ep) {
  const u = String(policyUrl || '').trim();
  if (u && !DEFAULT_USAGE.has(u.replace(/\/+$/, ''))) return { url: u, from: 'pacing-policy.json minimax.url' };
  return { url: (ep || REGIONS.global).usageUrl, from: 'company.json providers.minimax (' + ((ep && ep.region) || 'global') + ')' };
}
// the MiniMax key the company already holds: secrets/minimax-key, then the station's provider-key store
function storedKey(root) {
  try { const k = fs.readFileSync(path.join(root, 'secrets', 'minimax-key'), 'utf8').trim(); if (k) return k; } catch (_) {}
  try { const j = JSON.parse(fs.readFileSync(path.join(root, '.starnet-data', 'workspaces', '.secrets', 'provider-keys.json'), 'utf8')); const k = String(((j.providers || {}).custom || {}).key || '').trim(); if (k) return k; } catch (_) {}
  return '';
}
// owner-facing summary, no URL unless custom
const plain = ep => ep.region === 'custom' ? 'Custom address' + (ep.other ? ' (not MiniMax)' : '') : ep.label;

module.exports = { REGIONS, CUSTOM, ORDER, DEFAULT_USAGE, choices, checkCustomUrl, resolve, readCfg, fromConfig, read, entryOf, same, usageUrlFor, storedKey, plain, companyFile };
