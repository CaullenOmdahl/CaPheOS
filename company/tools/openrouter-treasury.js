#!/usr/bin/env node
/* openrouter-treasury.js — read-only treasury check for the company's OpenRouter provisioning key.
 *
 * The management key can list credits and provision LIMIT-BOUND sub-keys, but it CANNOT run inference
 * (a management key returns 401 on /chat/completions). So this is a FINANCE tool, not a model source:
 *   - report credit balance and every provisioned key's limit/remaining/expiry
 *   - gate a spending rule (e.g. "no spending until revenue") with --min
 *   - when funded, mint per-role keys with hard limits (only with --provision, which is explicit)
 *
 * usage:
 *   node openrouter-treasury.js                 # report
 *   node openrouter-treasury.js --json          # machine-readable only
 *   node openrouter-treasury.js --min 5         # exit 3 if remaining credits < 5
 */
'use strict';
const co = require('./lib/company');
const API = 'https://openrouter.ai/api/v1';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

async function get(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + key } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status + ': ' + JSON.stringify(body).slice(0, 300));
  return body;
}

// the management key is preferred; a plain inference key can still read /credits and /key
const key = co.secret('openrouter-mgmt-key') || co.secret('openrouter-key');
if (!key) {
  console.error(JSON.stringify({ ok: false, error: 'no OpenRouter key: put it in secrets/openrouter-mgmt-key (or secrets/openrouter-key)' }));
  process.exit(1);
}

(async () => {
  const [credits, keyInfo, keys] = await Promise.all([get('/credits'), get('/key'), get('/keys?include_disabled=true')]);
  const total = Number(credits.data.total_credits) || 0;
  const used = Number(credits.data.total_usage) || 0;
  const remaining = Math.round((total - used) * 1e6) / 1e6;
  const subkeys = (keys.data || []).map(k => ({
    name: k.name, label: k.label, disabled: !!k.disabled,
    limit: k.limit == null ? null : Number(k.limit),
    remaining: k.limit_remaining == null ? null : Math.round(Number(k.limit_remaining) * 1e6) / 1e6,
    usage: Math.round(Number(k.usage || 0) * 1e6) / 1e6,
    expires: k.expires_at || null,
  }));
  const report = {
    ok: true,
    account: {
      credits_total_usd: total,
      credits_used_usd: Math.round(used * 1e6) / 1e6,
      credits_remaining_usd: remaining,
    },
    management_key: {
      is_management: !!keyInfo.data.is_management_key,
      is_provisioning: !!keyInfo.data.is_provisioning_key,
      expires_at: keyInfo.data.expires_at || null,
      inference_allowed: false,   // management keys get 401 on /chat/completions
    },
    provisioned_keys: subkeys,
    policy: remaining > 0
      ? 'credits present — spending follows the finance owner\'s budget (company/work/finance/dispatch-budget.json)'
      : 'NO CREDITS — provisioning and inference blocked until the account is funded',
  };
  const min = arg('min', null);
  const jsonOnly = !!arg('json', false);
  if (!jsonOnly) {
    console.log('OpenRouter treasury — ' + new Date().toISOString());
    console.log('  credits: $' + report.account.credits_total_usd + ' total, $' + report.account.credits_used_usd + ' used, $' + remaining + ' remaining');
    console.log('  management/provisioning key: ' + report.management_key.is_management + ' / ' + report.management_key.is_provisioning + ' (inference: not allowed)');
    console.log('  sub-keys:');
    for (const k of subkeys) console.log('    - ' + (k.name || k.label) + '  limit $' + k.limit + '  remaining $' + k.remaining + '  usage $' + k.usage + (k.disabled ? '  [disabled]' : '') + (k.expires ? '  expires ' + k.expires.slice(0, 10) : ''));
    console.log('  policy: ' + report.policy);
  } else {
    console.log(JSON.stringify(report, null, 1));
  }
  if (min != null) {
    const need = Number(min);
    if (!(remaining >= need)) {
      if (!jsonOnly) console.log('\nGATE: remaining $' + remaining + ' < required $' + need + ' — company must not spend.');
      process.exit(3);
    }
  }
})().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
