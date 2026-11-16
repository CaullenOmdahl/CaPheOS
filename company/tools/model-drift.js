#!/usr/bin/env node
/*
 * model-drift.js — the same setting in three places, checked in one run.
 *
 * Why: the station's picker and `POST /api/agent/model` do not consult `company/model-policy.json`, so a hand edit can put a seat or a routine on a
 * model the company forbids, and nothing in the tooling notices. This is the notice.
 *
 * Three sources, and the check is that they agree:
 *   1. `company/model-policy.json`  — `allowed[provider].models` (what may run at all), `allowed['claude-cli'].tiers`
 *                                     (which model is a tier), `routing.routines` (what each routine should be on).
 *   2. the station roster           — `.starnet-data/workspaces/agent.roster.json`, one row per seat: the model a page
 *                                     edit would change.
 *   3. the routine pins             — `GET /api/cron`, `provider`/`model` per routine: what the scheduler will fire.
 *
 * Findings (exit 1):
 *   seat-model-not-allowed        a roster row's provider+model is not in `allowed`              — S1, forbids the act
 *   routine-model-not-allowed     a routine's provider+model is not in `allowed`                — S1
 *   routine-on-forbidden-subscription  pinned to `custom` while routing says `minimax: false`, or its scope's
 *                                 chain (routing.scopes[scope].chain) has no `minimax` link       — S2
 *   routine-tier-drift            pinned to a Claude tier other than routing's `claude`         — S2
 * Notes (printed, never a finding): a routine on `deepseek` whose routing allows a subscription. The pacer moves
 *   routines onto DeepSeek when the subscriptions are closed, so that state is legitimate and a checker that flagged
 *   it would be turned off within a day.
 *
 *   node company/tools/model-drift.js                 # live: roster file + GET /api/cron + the policy
 *   node company/tools/model-drift.js --json          # machine-readable
 *   node company/tools/model-drift.js --selftest      # fixtures, no station, no network; exit = failed cases
 *   node company/tools/model-drift.js --roster f --cron g --policy h    # point at saved copies (a rehearsal)
 * Owner: the tools seat (co.seatFor('tools')). Rule owner: the people seat (co.seatFor('people')), who keeps the
 * routing table.
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const co = require('./lib/company');

const ROOT = co.ROOT;
const REL = {
  policy: 'company/model-policy.json',
  roster: '.starnet-data/workspaces/agent.roster.json',
};

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// call the station: GET /api/cron with the station token. Nothing leaves the box.
function getCron(cb) {
  let token = '';
  try { token = co.stationToken(); } catch (e) { return cb(e); }
  const u = new URL(co.STATION_URL + '/api/cron');
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { 'x-starnet-token': token }, timeout: 15000 }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => { if (res.statusCode !== 200) return cb(new Error('HTTP ' + res.statusCode + ' ' + b.slice(0, 120))); try { cb(null, JSON.parse(b)); } catch (e) { cb(new Error('unparsable /api/cron: ' + e.message)); } });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', cb);
  req.end();
}

const allowedOf = (policy, provider) => {
  const p = policy && policy.allowed && policy.allowed[provider];
  return p && Array.isArray(p.models) ? p.models : null;
};
const tierOf = (policy, model) => {
  const t = policy && policy.allowed && policy.allowed['claude-cli'] && policy.allowed['claude-cli'].tiers;
  return t ? t[model] || null : null;
};
// routing.routines names the tier by its alias ("sonnet", "haiku"); allowed.tiers names it by its class
// ("standard", "light"). One map, so a comparison of the two cannot be a comparison of two spellings.
const TIER_ALIAS = { light: 'haiku', standard: 'sonnet', heavy: 'opus', top: 'fable' };
const aliasOf = (policy, model) => { const t = tierOf(policy, model); return t ? (TIER_ALIAS[t] || t) : null; };

// audit() is pure: policy + roster rows + cron jobs in, findings and notes out. The selftest is the same function.
function audit(policy, roster, jobs) {
  const findings = [], notes = [];
  const rows = Array.isArray(roster) ? roster : ((roster && roster.agents) || []);
  if (!policy || !policy.allowed) return { findings: [{ code: 'policy-unreadable', why: 'company/model-policy.json is missing or has no `allowed` block' }], notes };

  // 1. every seat
  for (const r of rows) {
    if (!r || !r.agentId) continue;
    const models = allowedOf(policy, r.provider);
    if (!models) { findings.push({ code: 'seat-model-not-allowed', who: r.agentId, name: r.name, provider: r.provider, model: r.model, why: 'provider "' + r.provider + '" has no allow-list in company/model-policy.json' }); continue; }
    if (!models.includes(r.model)) findings.push({ code: 'seat-model-not-allowed', who: r.agentId, name: r.name, provider: r.provider, model: r.model, why: '"' + r.model + '" is not in allowed.' + r.provider + '.models (' + models.join(', ') + ')' });
  }

  // 2. every routine pin, against the allow-list
  const routines = policy.routing && policy.routing.routines || {};
  for (const j of (jobs || [])) {
    if (!j || j.noAgent || !j.provider) continue;
    const models = allowedOf(policy, j.provider);
    if (!models) { findings.push({ code: 'routine-model-not-allowed', who: j.id, name: j.name, provider: j.provider, model: j.model, why: 'provider "' + j.provider + '" has no allow-list' }); continue; }
    if (!models.includes(j.model)) { findings.push({ code: 'routine-model-not-allowed', who: j.id, name: j.name, provider: j.provider, model: j.model, why: '"' + j.model + '" is not in allowed.' + j.provider + '.models' }); continue; }
    // 3. and against the routing table, which is the place the company says what each routine should be on
    // matched as the pacer matches: exact name, or the longest routing key the name starts with
    const n = String(j.name || '');
    const key = Object.keys(routines).filter(k => !k.startsWith('_') && (n === k || n.startsWith(k))).sort((x, y) => y.length - x.length)[0];
    const route = key ? routines[key] : null;
    if (!route) continue;
    const scope = route.scope != null && policy.routing.scopes ? policy.routing.scopes[route.scope] : null;
    const chain = scope && Array.isArray(scope.chain) ? scope.chain : null;
    if (j.provider === 'custom' && (route.minimax === false || (chain && !chain.includes('minimax')))) {
      findings.push({ code: 'routine-on-forbidden-subscription', who: j.id, name: j.name, provider: j.provider, model: j.model, why: route.minimax === false
        ? 'routing.routines["' + key + '"].minimax is false, and the routine is pinned to MiniMax'
        : 'scope "' + route.scope + '" has no minimax link (chain ' + chain.join(', ') + '), and the routine is pinned to MiniMax' });
      continue;
    }
    if (j.provider === 'claude-cli' && route.claude) {
      const tier = aliasOf(policy, j.model);
      if (tier && tier !== route.claude) findings.push({ code: 'routine-tier-drift', who: j.id, name: j.name, provider: j.provider, model: j.model, why: 'routing.routines["' + j.name + '"].claude is "' + route.claude + '", the pin is a "' + tier + '" model' });
      continue;
    }
    if (j.provider === 'deepseek') notes.push({ who: j.id, name: j.name, why: 'on the DeepSeek fallback while routing allows a subscription — legitimate during a closure, and the pacer moves it back' });
  }
  // twelve identical notes is a wall, not a reading: one line, with the names
  const fallback = notes.filter(n => /DeepSeek fallback/.test(n.why));
  if (fallback.length > 1) {
    for (let i = notes.length - 1; i >= 0; i--) if (/DeepSeek fallback/.test(notes[i].why)) notes.splice(i, 1);
    notes.push({ who: 'fallback', name: fallback.length + ' routine(s)', why: 'on the DeepSeek fallback while routing allows a subscription — legitimate during a closure, and the pacer moves them back: ' + fallback.map(n => n.name).join(', ') });
  }
  return { findings, notes };
}

/* ---------- selftest ---------- */
function selftest() {
  const fails = [], ok = [];
  const check = (name, cond, detail) => (cond ? ok.push(name) : fails.push(name + (detail ? ' — ' + detail : '')));
  const policy = {
    allowed: {
      'claude-cli': { models: ['claude-haiku-4-5-20251001', 'haiku', 'claude-sonnet-5-5', 'sonnet'], tiers: { haiku: 'light', 'claude-haiku-4-5-20251001': 'light', 'claude-sonnet-5-5': 'standard', sonnet: 'standard' } },
      custom: { models: ['MiniMax-M3.1-Flash'] },
      deepseek: { models: ['deepseek-flash'] },
    },
    routing: { routines: { 'Morning operating brief': { claude: 'sonnet', minimax: true }, 'Daily PM digest': { claude: 'sonnet', minimax: false },
      'Founder loop': { claude: 'sonnet', minimax: true, scope: 'code' } }, scopes: { code: { chain: ['claude', 'deepseek'] } } },
  };
  const clean = audit(policy,
    [{ agentId: 'agent', name: 'Alex', provider: 'claude-cli', model: 'haiku' }],
    [{ id: 'r1', name: 'Morning operating brief', provider: 'claude-cli', model: 'claude-sonnet-5-5' }]);
  check('a clean roster and a clean routine produce no finding', clean.findings.length === 0, JSON.stringify(clean.findings));

  const badSeat = audit(policy, [{ agentId: 'agent', name: 'Alex', provider: 'deepseek', model: 'deepseek-v4-pro' }], []);
  check('a seat on a forbidden model is a finding', badSeat.findings.some(f => f.code === 'seat-model-not-allowed'), JSON.stringify(badSeat.findings));
  check('the finding names the model and the file it came from', /deepseek-v4-pro/.test(JSON.stringify(badSeat.findings)) && /allowed/.test(JSON.stringify(badSeat.findings)), '');

  const badRoutine = audit(policy, [], [{ id: 'r2', name: 'Security sweep', provider: 'deepseek', model: 'deepseek-v4-pro' }]);
  check('a routine on a forbidden model is a finding', badRoutine.findings.some(f => f.code === 'routine-model-not-allowed'), JSON.stringify(badRoutine.findings));

  const forbiddenSub = audit(policy, [], [{ id: 'r3', name: 'Daily PM digest', provider: 'custom', model: 'MiniMax-M3.1-Flash' }]);
  check('a routine pinned to MiniMax where routing says minimax:false is a finding', forbiddenSub.findings.some(f => f.code === 'routine-on-forbidden-subscription'), JSON.stringify(forbiddenSub.findings));

  const tierDrift = audit(policy, [], [{ id: 'r4', name: 'Daily PM digest', provider: 'claude-cli', model: 'claude-haiku-4-5-20251001' }]);
  check('a routine on the wrong Claude tier is a finding', tierDrift.findings.some(f => f.code === 'routine-tier-drift'), JSON.stringify(tierDrift.findings));

  const fallback = audit(policy, [], [{ id: 'r5', name: 'Morning operating brief', provider: 'deepseek', model: 'deepseek-flash' }]);
  check('a routine on the DeepSeek fallback is a note, not a finding', fallback.findings.length === 0 && fallback.notes.length === 1, JSON.stringify(fallback));

  const offChain = audit(policy, [], [{ id: 'r7', name: 'Founder loop — run the company', provider: 'custom', model: 'MiniMax-M3.1-Flash' }]);
  check('a routine pinned to MiniMax whose scope has no minimax link is a finding (prefix-matched name)', offChain.findings.some(f => f.code === 'routine-on-forbidden-subscription'), JSON.stringify(offChain.findings));
  const onChain = audit(policy, [], [{ id: 'r8', name: 'Founder loop — run the company', provider: 'claude-cli', model: 'claude-sonnet-5-5' }]);
  check('the same routine on its Claude tier is clean', onChain.findings.length === 0, JSON.stringify(onChain.findings));

  const noProvider = audit(policy, [], [{ id: 'r6', name: 'X', provider: 'weird-provider', model: 'm' }]);
  check('an unknown provider fails closed', noProvider.findings.some(f => f.code === 'routine-model-not-allowed'), JSON.stringify(noProvider.findings));

  const noPolicy = audit(null, [], []);
  check('a missing policy is a finding, not a pass over nothing', noPolicy.findings.some(f => f.code === 'policy-unreadable'), JSON.stringify(noPolicy.findings));

  if (fails.length) { console.log('SELFTEST FAILED: ' + fails.length + ' case(s) wrong\n  ' + fails.join('\n  ')); return fails.length; }
  console.log('SELFTEST PASSED (' + ok.length + ' checks)');
  return 0;
}

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) { const k = s.slice(2); const v = argv[i + 1]; if (v != null && !v.startsWith('--')) { a[k] = v; i++; } else a[k] = true; }
    else a._.push(s);
  }
  return a;
}

function report(r) {
  const out = [];
  if (r.findings.length) { out.push('MODEL DRIFT: ' + r.findings.length + ' finding(s)'); for (const f of r.findings) out.push('  ' + f.code + ' — ' + (f.name || f.who || '') + (f.model ? ' [' + f.provider + '/' + f.model + ']' : '') + ': ' + f.why); }
  else out.push('model drift: clean — every seat and every routine pin is on a model company/model-policy.json allows, and on what routing.routines says');
  for (const n of r.notes) out.push('  note — ' + n.name + ': ' + n.why);
  return out.join('\n');
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.selftest) return selftest();
  const policy = readJson(a.policy || path.join(ROOT, REL.policy));
  const roster = readJson(a.roster || path.join(ROOT, REL.roster));
  if (a.policy && !policy) { process.stderr.write('model-drift: cannot read ' + a.policy + '\n'); return 2; }
  if (a.roster && !roster) { process.stderr.write('model-drift: cannot read ' + a.roster + '\n'); return 2; }
  const finish = jobs => {
    const r = audit(policy, roster, jobs);
    if (a.json) console.log(JSON.stringify(r, null, 1)); else console.log(report(r));
    return r.findings.length ? 1 : 0;
  };
  if (a.cron) {
    const saved = readJson(a.cron);
    if (!saved) { process.stderr.write('model-drift: cannot read ' + a.cron + '\n'); return 2; }
    process.exitCode = finish(saved.jobs || saved);
    return;
  }
  // live: the roster file is on disk; the routine pins come from the station
  getCron((err, body) => {
    if (err) { process.stderr.write('model-drift: cannot read the station (/api/cron): ' + err.message + '\n  the routine half did not run; the seat half is below\n'); const r = audit(policy, roster, []); console.log(report(r)); process.exitCode = 2; return; }
    process.exitCode = finish(body.jobs || body);
  });
}

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exit(code);
}

module.exports = { audit, report, REL };
