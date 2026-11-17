#!/usr/bin/env node
/* build-inventory.js — writes company/model-inventory.json + company/MODEL_INVENTORY.md
   Sources: station /api/providers snapshot (.providers.json) + liveprices cache. Read-only on the station. */
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const ROOT = co.ROOT;
// --selftest: three spawns of this file against throwaway inputs, because the defect being prevented is a WRITE
// (a blank §1 published over a good one) and only the exit code plus the presence of the file prove it did not happen.
if (process.argv.includes('--selftest')) process.exit(selftest());
function selftest() {
  const cp = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-selftest-'));
  let pass = 0, fail = 0;
  const ok = (name, cond, extra) => { if (cond) { pass++; console.log('ok    ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? ' — ' + extra : '')); } };
  const run = (providersJson, out) => cp.spawnSync(process.execPath, [__filename], { encoding: 'utf8',
    env: Object.assign({}, process.env, { PROVIDERS_JSON: providersJson, INVENTORY_OUT: out, LIVEPRICES_JSON: path.join(tmp, 'no-prices.json') }) });
  const empty = path.join(tmp, 'empty.json');
  fs.writeFileSync(empty, JSON.stringify({ providers: [] }));
  const good = path.join(tmp, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ providers: [{ id: 'deepseek', label: 'DeepSeek', readiness: { configured: true } }] }));

  // 1. an empty provider list refuses and writes nothing.
  let out = path.join(tmp, 'out-empty');
  let r = run(empty, out);
  ok('an empty provider list exits non-zero', r.status === 1, 'exit=' + r.status);
  ok('an empty provider list writes no MODEL_INVENTORY.md', !fs.existsSync(path.join(out, 'MODEL_INVENTORY.md')));
  ok('the refusal names §1 and the snapshot path', /§1 of MODEL_INVENTORY\.md/.test(r.stderr) && r.stderr.includes(empty));

  // 2. a missing snapshot file is the same refusal, not an empty table.
  out = path.join(tmp, 'out-missing');
  r = run(path.join(tmp, 'nope.json'), out);
  ok('a missing snapshot exits non-zero and writes nothing', r.status === 1 && !fs.existsSync(path.join(out, 'MODEL_INVENTORY.md')));

  // 3. a good snapshot still writes, and §1 names the provider — so the guard did not break the tool.
  out = path.join(tmp, 'out-good');
  r = run(good, out);
  const md = fs.existsSync(path.join(out, 'MODEL_INVENTORY.md')) ? fs.readFileSync(path.join(out, 'MODEL_INVENTORY.md'), 'utf8') : '';
  ok('a good snapshot writes MODEL_INVENTORY.md', r.status === 0 && md.length > 0, 'exit=' + r.status);
  ok('§1 names the provider read from the snapshot', /`deepseek`/.test(md.split('## 2.')[0]));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nBUILD-INVENTORY SELFTEST: ' + pass + ' passed, ' + fail + ' failed');
  return fail === 0 ? 0 : 1;
}
// INVENTORY_OUT exists so --selftest can write to a throwaway directory instead of the published files: a blank §1
// published over a good document has to be restored by hand.
const OUT = process.env.INVENTORY_OUT || co.p('company');
fs.mkdirSync(OUT, { recursive: true });

// the station's live price cache; a new company may not have one yet, so a missing cache is an empty §2, not a crash
const LIVEPRICES_JSON = process.env.LIVEPRICES_JSON || co.p('.starnet-data', 'workspaces', 'liveprices.cache.json');
const prices = co.readJson(LIVEPRICES_JSON, {}) || {};
// The station's provider list arrives as a snapshot file. When that file is absent the old code wrote a blank §1 and
// exited 0 — a published document silently degraded, which is worse than a crash because nothing reports it. The
// snapshot path is overridable for the selftest; a missing or empty snapshot is now a refusal, not a blank table.
const PROVIDERS_JSON = process.env.PROVIDERS_JSON || co.p('.providers.json');
let providers = [];
let providersError = null;
try {
  const pj = JSON.parse(fs.readFileSync(PROVIDERS_JSON, 'utf8'));
  providers = Array.isArray(pj) ? pj : (pj.providers ? Object.values(pj.providers) : Object.values(pj));
} catch (e) { providersError = e.message; }
if (!Array.isArray(providers) || !providers.length) {
  console.error('build-inventory: REFUSING to write — 0 providers read from ' + PROVIDERS_JSON +
    (providersError ? ' (' + providersError + ')' : ' (the file lists none)') +
    '.\n  §1 of MODEL_INVENTORY.md would publish an empty Sources table and §2-§7 would still write, so the document would look current while its first section was blank.\n  Refresh the snapshot from the station (GET /api/providers) into that path, or point PROVIDERS_JSON at a good one, and re-run. Nothing was written.');
  process.exit(1);
}

// auth model per provider id (from StarNet registry semantics + docs)
const AUTH = {
  codex: 'ChatGPT sign-in (OAuth device)', grok: 'Grok sign-in (OAuth device)', kimi: 'Kimi sign-in (OAuth device)',
  starnet: 'StarNet subscription / credits', openrouter: 'API key', openai: 'API key (or ChatGPT sign-in)',
  anthropic: 'API key', gemini: 'API key', xai: 'API key', groq: 'API key', mistral: 'API key',
  deepseek: 'API key', together: 'API key', fireworks: 'API key', perplexity: 'API key', cerebras: 'API key',
  'claude-cli': 'Claude Code CLI subscription (local binary)', ollama: 'local endpoint, no key',
  custom: 'local / any OpenAI-compatible endpoint',
};
const LOCAL = new Set(['ollama', 'custom']);

const inv = { generatedAt: new Date().toISOString(), source: 'station /api/providers + liveprices cache', providers: [], families: {}, recommendation: {} };
inv.providers = providers.map(p => ({
  id: p.id, label: p.label, auth: AUTH[p.id] || 'unknown', local: LOCAL.has(p.id),
  baseUrl: p.baseUrl || null, configured: !!(p.readiness && p.readiness.configured),
  credentialSource: p.credentialSource || null,
}));
for (const [fam, models] of Object.entries(prices.byFamily || {})) {
  inv.families[fam] = Object.entries(models).map(([id, p]) => ({ id, usdPerMInput: p.in, usdPerMOutput: p.out }))
    .sort((a, b) => a.usdPerMInput - b.usdPerMInput);
}

// scope -> model chain (the org layer -> fleet mapping), read from company/model-policy.json routing so the inventory
// never disagrees with the policy. Prices come from §2, not from this file.
const policy = co.readJson(co.p('company', 'model-policy.json'), {}) || {};
const rmodels = (policy.routing && policy.routing.models) || {};
inv.recommendation = {};
for (const [scope, sc] of Object.entries((policy.routing && policy.routing.scopes) || {})) {
  if (scope.startsWith('_') || !sc || !Array.isArray(sc.chain)) continue;
  const linkModel = l => { const m = rmodels[l === 'claude' ? 'sonnet' : l]; return m ? m.provider + '/' + m.model : l; };
  inv.recommendation[scope] = { model: sc.chain.map(linkModel).join(' → '), why: sc.why || '' };
}

const md = [];
md.push('# ' + (co.config.name || 'Company') + ' — Model & Source Inventory');
md.push('');
md.push('Generated ' + inv.generatedAt + ' from the running station. Prices are USD per 1M tokens (input / output) as the station reports them. `configured` = the station holds a working credential right now.');
md.push('');
md.push('## 1. Sources (providers) the company can hire from');
md.push('');
md.push('| Provider | Auth | Local | Base URL | Configured |');
md.push('|---|---|---|---|---|');
for (const p of inv.providers) md.push('| `' + p.id + '` ' + p.label + ' | ' + p.auth + ' | ' + (p.local ? 'yes' : 'no') + ' | ' + (p.baseUrl || '—') + ' | ' + (p.configured ? '**YES**' : '—') + ' |');
md.push('');
md.push('## 2. Model families and prices');
for (const [fam, models] of Object.entries(inv.families)) {
  md.push('');
  md.push('### ' + fam + ' (' + models.length + ' models)');
  md.push('');
  md.push('| Model | $ in | $ out |');
  md.push('|---|---|---|');
  for (const m of models) md.push('| `' + m.id + '` | ' + m.usdPerMInput + ' | ' + m.usdPerMOutput + ' |');
}
md.push('');
md.push('## 3. AGY / Antigravity subscription (local CLI source)');
md.push('');
md.push('`agy`, when installed and signed in on this machine, is not an OpenAI-compatible endpoint, so StarNet cannot use it as a *brain* without an adapter; it is wired as a **contractor** (`company/tools/agy-contract.js`, schema-enforced JSON) that a StarNet agent with a workbench can call. Inference is hosted on the subscription: no marginal cost per turn.');
md.push('');
let agyModels = [];
try { agyModels = fs.readFileSync(path.join(OUT, 'agy-models.txt'), 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('|')); } catch (_) {}
let agyVersion = null;
if (!process.env.INVENTORY_OUT) try { const v = require('child_process').spawnSync('agy', ['--version'], { encoding: 'utf8', timeout: 5000 }); if (v.status === 0) agyVersion = String(v.stdout).trim() || null; } catch (_) {}
inv.agy = { cli: 'agy', version: agyVersion, installed: !!agyVersion, auth: 'Antigravity subscription OAuth (local CLI)', contractor: 'company/tools/agy-contract.js', models: agyModels.map(([id, name]) => ({ id, name })) };
if (agyModels.length) {
  md.push('| Model id | Label |');
  md.push('|---|---|');
  for (const [id, name] of agyModels) md.push('| `' + id + '` | ' + name + ' |');
  md.push('');
}
const minimaxKey = !!co.secret('minimax-key');
const mmEp = require('./lib/minimax-endpoint').read(co.ROOT);   // company.json providers.minimax (nothing stored = Global)
md.push('## 4. MiniMax direct (StarNet `custom` provider) — Coding Plan');
md.push('');
md.push('MiniMax Coding Plan key ' + (minimaxKey ? 'on file (`secrets/minimax-key`)' : '**not on file** (`secrets/minimax-key`)') + '. Endpoint: ' + mmEp.label + ' (company.json `providers.minimax`, Settings › Models and subscriptions). The wire is OpenAI-compatible at `' + mmEp.baseUrl + '`, tool calling returns native OpenAI tool_calls, and `thinking:{type:"disabled"}` yields clean output. Registered in StarNet as the `custom` provider, runs come back `unpriced: true` — subscription-billed, so they do not count against the metered daily budget (`company/work/finance/dispatch-budget.json`); the pacer meters them against the plan instead. Prefer a model that separates reasoning into `reasoning_content` (no inline `<think>`).');
md.push('');
let mmModels = [];
try { mmModels = fs.readFileSync(path.join(OUT, 'minimax-models.txt'), 'utf8').trim().split('\n').filter(Boolean); } catch (_) {}
inv.minimax = { region: mmEp.region, baseUrl: mmEp.baseUrl, usageUrl: mmEp.usageUrl, starnetProvider: 'custom', keyOnFile: minimaxKey, auth: 'Coding Plan subscription', tools: true, unpriced: true, models: mmModels };
if (mmModels.length) {
  md.push('| Model id | Wire | Tool calls |');
  md.push('|---|---|---|');
  for (const id of mmModels) md.push('| `' + id + '` | OpenAI-compatible | yes |');
  md.push('');
}
md.push('## 5. Treasury — OpenRouter management key (spend-gated, not a model source)');
md.push('');
md.push('The OpenRouter management key (`secrets/openrouter-mgmt-key`) is a **management + provisioning** key, NOT an inference key: `/chat/completions` returns 401 by design. It is the finance owner\'s instrument. The balance and the provisioned sub-keys are live data, so they are not copied here: run `node company/tools/openrouter-treasury.js` (`--min <usd>` exits 3 when the company must not spend).');
md.push('');
md.push('**Why this matters:** OpenRouter sub-keys carry a hard `limit` and optional `expires_at` — that is the per-role/per-department spending cap StarNet lacks natively. Once the account is funded, the finance owner can mint one limit-bound key per department and the cap is enforced by OpenRouter, not by prompt discipline. Do not piggyback on personal sub-keys that pre-date the company.');
md.push('');
md.push('**Inference key (separate from the management key):** `secrets/openrouter-key` ' + (co.secret('openrouter-key') ? 'is on file' : 'is not on file') + '. It draws from the same account balance, and every OpenRouter run is metered against the daily budget.');
md.push('');
inv.openrouterInference = { keyOnFile: !!co.secret('openrouter-key'), mgmtKeyOnFile: !!co.secret('openrouter-mgmt-key'), registered: 'openrouter', metered: true, treasury: 'company/tools/openrouter-treasury.js' };
md.push('');
md.push('## 6. Model chains by scope (company/model-policy.json routing)');
md.push('');
md.push('| Scope | Model chain (first open link runs) | Why |');
md.push('|---|---|---|');
for (const [k, v] of Object.entries(inv.recommendation)) md.push('| ' + k + ' | `' + v.model + '` | ' + v.why + ' |');
md.push('');
md.push('## 7. Cost sanity check (per 1M tokens in + out)');
md.push('');
md.push('| Model | in+out | 10M-token workday |');
md.push('|---|---|---|');
const pick = ['claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'deepseek-v4-pro', 'deepseek-flash', 'gpt-5.6', 'grok-4.6'];
for (const id of pick) {
  for (const models of Object.values(inv.families)) {
    const m = models.find(x => x.id === id); if (!m) continue;
    const sum = Math.round((m.usdPerMInput + m.usdPerMOutput) * 100) / 100;
    md.push('| `' + id + '` | $' + sum + ' | $' + Math.round(sum * 10 * 100) / 100 + ' |');
  }
}
md.push('');
md.push('Ollama/custom endpoints: $0 per token (compute only).');
md.push('');
md.push('## 8. Open questions for the tools owner');
md.push('');
md.push('- Which Claude source funds the CEO: `anthropic` API key, or `claude-cli` subscription?');
md.push('- Which families get standing keys vs per-hire ephemeral budget?');
md.push('- Local fallback model for when metered budget is exhausted?');
md.push('');
fs.writeFileSync(path.join(OUT, 'model-inventory.json'), JSON.stringify(inv, null, 1) + '\n');
fs.writeFileSync(path.join(OUT, 'MODEL_INVENTORY.md'), md.join('\n') + '\n');
console.log('wrote', path.join(OUT, 'MODEL_INVENTORY.md'), 'and model-inventory.json');
console.log('providers:', inv.providers.length, 'families:', Object.keys(inv.families).length, 'models:', Object.values(inv.families).reduce((a, b) => a + b.length, 0));
