#!/usr/bin/env node
/* onboard.js — onboarding is certification, not provisioning (docs/CORE-MODULES.md "Onboarding is certification").
 *
 * Two states, never conflated: PROVISIONED (files written, station installed, secrets created: found-company.sh,
 * setup-station.sh) and CERTIFIED (`--certify` green: the company proved it can run). Deterministic, re-runnable, safe
 * to interrupt, fails closed; no wizard.
 *
 *   node company/tools/onboard.js --check [--json]        provisioning steps + the last certification, what is missing; writes nothing
 *   node company/tools/onboard.js --resume [--json]       do the idempotent steps that can be done now (candidate default,
 *                                                         ops registrations, a first backup, the owner-gate batch, guardrails apply,
 *                                                         the Founder loop: routine + blessed company folder + armed scheduler)
 *   node company/tools/onboard.js --step <name> [--json]  one resume step (station-seed, founder-loop, kickoff, candidate-default, ops-registered, guardrails-applied)
 *   node company/tools/onboard.js --certify [--json]      the 11 checks; exit 0 only when all pass (then state.certified)
 *   node company/tools/onboard.js --teardown [--purge] --by owner   stop the units, archive (scripts/backup.sh + verify);
 *                                                         --purge then removes company/work|state|owner|hiring — never without a verified archive
 *   node company/tools/onboard.js --record <step> <ok|failed|pending> [--note ".."]   (found-company.sh / setup-station.sh)
 *   node company/tools/onboard.js --selftest
 *
 * State: company/state/onboarding-state.json { steps: {<step>: {status, at, note}}, certified, certifiedAt, checks, gates };
 * ledger: company/state/onboarding-log.jsonl (one row per step / check run). Replaces company/work/.founded (still
 * written by found-company.sh for older tools).
 * Env: CONSOLE_URL (else company.json console.port, else station port + 100), CAPHEOS_BACKUP_DIR (backup.sh),
 * ONBOARD_NO_SYSTEMCTL=1 (teardown skips systemctl; tests).
 * Exit: 0 ok, 1 not certified / refused, 2 usage.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync } = require('child_process');
const co = require('./lib/company');

const F = {
  state: co.p('company', 'state', 'onboarding-state.json'),
  log: co.p('company', 'state', 'onboarding-log.jsonl'),
  founded: co.p('company', 'work', '.founded'),
  charter: co.p('company', 'CHARTER.md'),
  dispatchLog: co.p('company', 'work', 'dispatch-log.md'),
  targets: co.p('company', 'work', 'ops', 'health-targets.json'),
  backups: co.p('company', 'work', 'ops', 'backups.json'),
  modelPolicy: co.p('company', 'model-policy.json'),
  budget: co.p('company', 'work', 'finance', 'dispatch-budget.json'),
  cadence: co.p('company', 'work', 'ops', 'cadence.json'),
  loopState: co.p('company', 'state', 'dispatcher-loop.json'),
};
const STEPS = [
  ['founded', 'company.json written and defaults copied (scripts/found-company.sh)'],
  ['station-installed', 'StarNet checkout, patches, env and systemd units (scripts/setup-station.sh)'],
  ['station-answers', 'the station answers GET /api/cron with the token (scripts/setup-station.sh --start)'],
  ['candidate-default', 'hiring candidates default to a model the company can actually run'],
  ['ops-registered', 'company/work/ops/health-targets.json and backups.json registered'],
  ['first-backup', 'one backup written and verified (scripts/backup.sh)'],
  ['owner-gates', 'the owner gates the enabled packs and modules need, asked once on Today'],
  ['guardrails-applied', 'guardrails.js apply: station-side switches pushed'],
  ['station-seed', 'the headless station has its save and the Founder (save + roster, approval mode from self-governance): station-seed.js'],
  ['founder-loop', 'the Founder loop routine exists (company root workdir, terminal grant), the company folder is a blessed project, the scheduler is armed (founder-loop.js)'],
  ['kickoff', 'after certification: the Founder\'s first planning run (one OPEN handoff + one loop run), once'],
];
const CHECKS = [
  ['station', 'station answers GET /api/cron with the token'],
  ['dispatcher', 'the dispatcher wrote dispatch-log.md within one tick'],
  ['guardrails', 'guardrails.js apply --dry-run clean (everything applied)'],
  ['secrets', 'every enabled pack\'s and module\'s required secrets present, non-empty, mode 0600'],
  ['ops', 'health-targets.json and backups.json registered, and one backup verified'],
  ['liveness', 'the dead-man\'s switch (liveness module) enabled and pinged once'],
  ['doctor', 'pack.js doctor --all and module.js doctor --all green'],
  ['charter', 'the charter has no {{COMPANY}} / <...> placeholders'],
  ['console', 'the console answers /api/company with the owner token'],
  ['station-seed', 'the station has its save and the Founder in save and roster with the approval mode self-governance gives (station-seed.js status)'],
  ['founder-loop', 'the CEO seat has its loop routine (company root workdir, terminal grant), the company folder is blessed and the scheduler is on'],
];
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 2) + '\n'); fs.renameSync(t, f); };
const now = () => new Date().toISOString();
function state() { const s = readJson(F.state, null) || {}; s.version = 1; s.steps = s.steps || {}; s.gates = s.gates || {}; return s; }
function ledger(row) { fs.mkdirSync(path.dirname(F.log), { recursive: true }); fs.appendFileSync(F.log, JSON.stringify(Object.assign({ at: now() }, row)) + '\n'); }
function setStep(name, status, note) {
  const s = state();
  const prev = s.steps[name] || {};
  s.steps[name] = { status, at: now(), note: note || null };
  if (s.provisioned !== provisionedOf(s)) s.provisioned = provisionedOf(s);
  writeJson(F.state, s);
  if (prev.status !== status || prev.note !== (note || null)) ledger({ step: name, status, note: note || null });
  return s.steps[name];
}
const provisionedOf = s => ['founded', 'station-installed', 'station-answers'].every(k => (s.steps[k] || {}).status === 'ok');
const tool = n => path.join(__dirname, n);
const node = (args, opts) => spawnSync(process.execPath, args, Object.assign({ cwd: co.ROOT, encoding: 'utf8', timeout: 120000, env: process.env }, opts || {}));
const jsonOf = r => { for (const s of [r.stdout, r.stderr]) { try { return JSON.parse(String(s || '').trim()); } catch (_) {} } return null; };

/* ---------- small HTTP ---------- */
function get(url, headers, ms) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: headers || {} }, res => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) {} resolve({ ok: res.statusCode === 200, status: res.statusCode, json: j }); });
    });
    req.setTimeout(ms || 4000, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end();
  });
}
const stationGet = p => { const t = co.secret('station-token'); return t ? get(co.STATION_URL + p, { 'x-starnet-token': t }) : Promise.resolve({ ok: false, error: 'no secrets/station-token' }); };
function consoleUrl() {
  if (process.env.CONSOLE_URL) return process.env.CONSOLE_URL.replace(/\/$/, '');
  const cc = co.config.console || {};
  let sp = 0; try { sp = Number(new URL(co.STATION_URL).port) || 0; } catch (_) {}
  const port = cc.port || (sp ? sp + 100 : 8901);
  return 'http://' + (cc.host && cc.host !== '0.0.0.0' ? cc.host : '127.0.0.1') + ':' + port;
}
function tickMin() { for (const f of [F.cadence, co.p('company', 'defaults', 'work', 'ops', 'cadence.json')]) { const n = Number((readJson(f, {}) || {}).dispatcherTickMin); if (n > 0) return n; } return 10; }
function backupDir() { return process.env.CAPHEOS_BACKUP_DIR || path.join(os.homedir(), '.local', 'share', 'capheos-backups', String(co.config.slug || 'company')); }
function enabledModules() { return Object.keys(((readJson(co.p('company', 'state', 'modules.json'), {}) || {}).enabled) || {}); }

/* ---------- resume steps ---------- */
// The first-light finding: candidates defaulted to a metered model while a new company's metered cap is $0, so a fresh
// company could not interview. Rule: an owner's choice is never overwritten. A default the owner set (setBy is a person,
// not a tool — console Setup writes the owner's name) is only checked: if it cannot run, that is a needs-you item
// pointing at Setup. A default no owner set is kept while it can run (subscription, or metered with a cap above $0);
// only when it cannot is it replaced by a subscription provider (dispatch-budget unmeteredProviders) that the station
// has configured and model-policy allows; else it is left and the owner-gate batch asks the owner.
async function resolveCandidateDefault() {
  const pol = readJson(F.modelPolicy, null);
  if (!pol || !pol.allowed) return { status: 'failed', note: 'company/model-policy.json missing or has no allowed models' };
  const budget = readJson(F.budget, null) || readJson(co.p('company', 'defaults', 'work', 'finance', 'dispatch-budget.json'), {}) || {};
  const unmetered = (Array.isArray(budget.unmeteredProviders) && budget.unmeteredProviders.length ? budget.unmeteredProviders : ['claude-cli']).map(String);
  const cur = pol.candidateDefault || {};
  if (cur.provider && unmetered.includes(cur.provider)) return { status: 'ok', note: 'candidates default to subscription provider ' + cur.provider + '/' + cur.model };
  if (cur.provider && Number(budget.dailyUsd) > 0) return { status: 'ok', note: 'metered default ' + cur.provider + '/' + cur.model + ' with a $' + budget.dailyUsd + ' daily cap' };
  const ownerSet = !!(cur.provider && cur.setBy && !/\.(js|sh|py)$/.test(String(cur.setBy)));
  if (ownerSet) return { status: 'pending', gate: { kind: 'candidateDefault', name: 'candidate model', text: 'Hiring candidates default to ' + cur.provider + '/' + cur.model + ' (your choice in console Setup, kept as set), which bills per token, but the metered daily cap is $0, so no candidate can run. Open console Setup and either set a daily cap (step Budget) or pick a subscription provider (step AI provider).' }, note: 'owner-set default ' + cur.provider + '/' + cur.model + ' cannot run (metered, $0 cap); kept as the owner set it — needs the owner in console Setup' };
  const pr = await stationGet('/api/providers');
  if (!pr.ok) return { status: 'pending', note: 'station unreachable for GET /api/providers (' + (pr.error || 'HTTP ' + pr.status) + ')' };
  const list = (pr.json && (pr.json.providers || pr.json.items)) || [];
  const ready = new Set(list.filter(p => p && (p.configured !== false) && p.unattendedReady !== false).map(p => String(p.id || p.provider || p.name)));
  const sub = unmetered.find(p => ready.has(p) && pol.allowed[p] && (pol.allowed[p].models || []).length);
  if (sub) {
    const fam = pol.allowed[sub]; const tiers = fam.tiers || {};
    const model = (fam.models.find(m => tiers[m] === 'light') || fam.preferred || fam.models[0]);
    pol.candidateDefault = Object.assign({}, cur, { provider: sub, model, effort: cur.effort || 'high', setBy: 'onboard.js', setAt: now(), why: 'subscription provider present on the station; metered cap is ' + (budget.dailyUsd || 0) });
    writeJson(F.modelPolicy, pol);
    return { status: 'ok', note: 'candidates now default to subscription provider ' + sub + '/' + model };
  }
  return { status: 'pending', gate: { kind: 'candidateDefault', name: 'candidate model', text: 'Hiring candidates default to the metered model ' + (cur.provider || '?') + '/' + (cur.model || '?') + ', but the metered daily cap is $0 and the station has no subscription provider (' + unmetered.join(', ') + ') ready. Either connect a subscription provider on the station, or set a metered cap in company/work/finance/dispatch-budget.json (dailyUsd).' }, note: 'no usable candidate default: metered model with a $0 cap and no subscription provider on the station' };
}
function registerOps() {
  const made = [];
  if (!fs.existsSync(F.targets)) { writeJson(F.targets, []); made.push('health-targets.json (empty: add product endpoints as {name, url, expect})'); }
  if (!fs.existsSync(F.backups)) { writeJson(F.backups, [{ name: 'company state', dir: backupDir(), maxDays: 2 }]); made.push('backups.json (' + backupDir() + ')'); }
  const ok = Array.isArray(readJson(F.targets, null)) && Array.isArray(readJson(F.backups, null));
  return { status: ok ? 'ok' : 'failed', note: made.length ? 'registered ' + made.join(', ') : ok ? 'already registered' : 'health-targets.json or backups.json is not a JSON array' };
}
function backupScript(args) { return spawnSync('bash', [co.p('scripts', 'backup.sh')].concat(args || []), { cwd: co.ROOT, encoding: 'utf8', timeout: 300000, env: process.env }); }
function firstBackup() {
  let v = backupScript(['verify']);
  if (v.status === 0) return { status: 'ok', note: String(v.stdout).trim().split('\n').pop() };
  const b = backupScript([]);
  if (b.status !== 0) return { status: 'failed', note: 'backup.sh failed: ' + String(b.stderr || b.stdout).trim().slice(0, 200) };
  v = backupScript(['verify']);
  return v.status === 0 ? { status: 'ok', note: String(v.stdout).trim().split('\n').pop() } : { status: 'failed', note: 'backup did not verify: ' + String(v.stdout || v.stderr).trim().slice(0, 200) };
}
function ownerGates(extra) {
  const s = state();
  let items = [];
  try { items = require('./module.js').gates().filter(g => g.satisfied !== true); } catch (_) {}
  for (const g of extra || []) items.push(g);
  const key = g => g.kind + ':' + g.name + ':' + (g.from || '');
  const asked = new Set(((s.gates.asked || [])).map(key));
  const fresh = items.filter(g => !asked.has(key(g)));
  // answers come back through inbox.js; record them in the ledger once
  try {
    const qs = require('./inbox.js').state();
    for (const b of s.gates.batches || []) { const q = qs[b.questionId]; const a = q && (q.a || q.answer); if (a && !b.answer) { b.answer = a; b.answeredAt = now(); ledger({ step: 'owner-gates', answered: b.questionId, answer: String(a).slice(0, 300) }); } }
  } catch (_) {}
  if (!fresh.length) { writeJson(F.state, Object.assign(state(), { gates: s.gates })); return { status: 'ok', note: items.length ? items.length + ' gate(s) asked; answers in the ledger' : 'no owner gates needed' }; }
  const lines = fresh.map(g => '- ' + (g.text || (g.kind === 'secret' ? 'provide secrets/' + g.name + ' (0600) for ' + g.from : g.kind === 'externalGate' ? 'decide clearance policy for external-gate category "' + g.name + '" (' + g.from + ')' : g.kind === 'stationAbility' ? 'station ability "' + g.name + '" for ' + g.from : g.kind + ' ' + g.name)));
  const q = 'Onboarding: what the enabled packs and modules need from you (one batch, asked once):\n' + lines.join('\n') + '\nRecommendation: answer each line; secrets go in secrets/<name> with mode 0600, never in a message.\nIf you do not answer: those packs and modules stay uncertified.';
  const r = node([tool('inbox.js'), 'ask', '--from', 'onboard.js', '--about', 'onboarding', '--q', q], { timeout: 15000 });
  const j = jsonOf(r);
  if (r.status !== 0 || !j || !j.id) return { status: 'failed', note: 'could not ask the owner: ' + String(r.stderr || r.stdout).trim().slice(0, 200) };
  s.gates.asked = (s.gates.asked || []).concat(fresh.map(g => ({ kind: g.kind, name: g.name, from: g.from || '' })));
  s.gates.batches = (s.gates.batches || []).concat([{ questionId: j.id, at: now(), items: fresh.length }]);
  const cur = state(); cur.gates = s.gates; writeJson(F.state, cur);
  return { status: 'ok', note: 'asked the owner ' + fresh.length + ' gate(s) in question ' + j.id };
}
function applyGuardrails() {
  const d = jsonOf(node([tool('guardrails.js'), 'apply', '--dry-run', '--json'], { timeout: 60000 })) || {};
  const unreach = (d.notes || []).filter(n => /ECONNREFUSED|unreachable|timeout|no station token/i.test(n));
  if (unreach.length) return { status: 'pending', note: 'station unreachable: ' + unreach[0].slice(0, 160) };
  if (!(d.steps || []).length) return { status: 'ok', note: 'nothing to apply' };
  const r = node([tool('guardrails.js'), 'apply', '--by', 'owner', '--json'], { timeout: 120000 });
  const j = jsonOf(r) || {};
  return r.status === 0 && j.ok !== false ? { status: 'ok', note: 'applied ' + (d.steps || []).length + ' station-side step(s)' } : { status: 'failed', note: 'guardrails apply: ' + (j.error || String(r.stderr).slice(0, 160)) };
}
// The Founder's loop routine on the station (founder-loop.js ensure): without it nothing ever wakes the Founder, and an
// owner message waits forever. Idempotent: an existing routine (found by name prefix) is updated, never duplicated.
async function founderLoop() {
  const FL = require('./founder-loop.js');
  const r = await FL.ensure();
  if (r.ok) return { status: 'ok', note: FL.summary(r) };
  return { status: /unreachable|GET \/api\/cron/.test(r.error || '') ? 'pending' : 'failed', note: r.error };
}
// A headless station has no save and no Founder until it is seeded (station-seed.js, StarNet's own WAKE step).
async function stationSeed() {
  const S = require('./station-seed.js');
  try {
    const r = await S.seed({ by: (co.config.owner && co.config.owner.name) || 'owner' });
    const st = await S.status();
    if (st.ok) return { status: 'ok', note: (r && r.changed && r.changed.length ? 'seeded: ' + r.changed.join('; ').slice(0, 200) : 'save and Founder already in place') + ' (approval ' + ((r && r.approval && r.approval.mode) || '?') + ')' };
    return { status: 'failed', note: 'after seeding: ' + st.problems.map(p => p.code).join(', ') };
  } catch (e) { return { status: /ECONNREFUSED|unreachable|timeout|station-down/i.test(e.message) ? 'pending' : 'failed', note: 'station-seed.js: ' + String(e.message).slice(0, 200) }; }
}
const ONE_STEP = { 'station-seed': stationSeed, kickoff: async () => { const r = await kickoff(); return { status: r.status, note: r.note }; }, 'founder-loop': founderLoop, 'candidate-default': resolveCandidateDefault, 'ops-registered': async () => registerOps(), 'guardrails-applied': async () => applyGuardrails() };
async function step(name) {
  if (!ONE_STEP[name]) return { ok: false, error: 'unknown step ' + name + ' (one of ' + Object.keys(ONE_STEP).join(', ') + ')' };
  const r = await ONE_STEP[name]();
  const st = setStep(name, r.status, r.note);
  return { ok: st.status === 'ok', step: name, status: st.status, note: st.note };
}
async function resume() {
  const out = {};
  const s0 = state();
  if (!(s0.steps.founded || {}).status && (fs.existsSync(F.founded) || (co.config.name && co.config.owner && co.config.owner.name !== 'Owner'))) out.founded = setStep('founded', fs.existsSync(F.founded) ? 'ok' : 'pending', fs.existsSync(F.founded) ? 'from company/work/.founded' : 'company.json named; run scripts/found-company.sh');
  if ((s0.steps['station-answers'] || {}).status !== 'ok') { const st = await stationGet('/api/cron'); if (st.ok) out['station-answers'] = setStep('station-answers', 'ok', 'GET /api/cron answered'); }
  const cd = await resolveCandidateDefault(); out['candidate-default'] = setStep('candidate-default', cd.status, cd.note);
  const ops = registerOps(); out['ops-registered'] = setStep('ops-registered', ops.status, ops.note);
  const fb = firstBackup(); out['first-backup'] = setStep('first-backup', fb.status, fb.note);
  const og = ownerGates(cd.gate ? [cd.gate] : []); out['owner-gates'] = setStep('owner-gates', og.status, og.note);
  const ga = applyGuardrails(); out['guardrails-applied'] = setStep('guardrails-applied', ga.status, ga.note);
  const sd = await stationSeed(); out['station-seed'] = setStep('station-seed', sd.status, sd.note);
  const fl = await founderLoop(); out['founder-loop'] = setStep('founder-loop', fl.status, fl.note);
  return { ok: Object.values(out).every(x => x.status === 'ok'), steps: out };
}

/* ---------- certification ---------- */
function modeOk(f) { try { const st = fs.statSync(f); return st.size > 0 && (st.mode & 0o077) === 0; } catch (_) { return false; } }
async function certify() {
  const res = {};
  const put = (id, ok, missing) => { res[id] = { ok: !!ok, missing: ok ? null : missing }; };
  // 1
  const st = await stationGet('/api/cron');
  put('station', st.ok && st.json && Array.isArray(st.json.jobs), st.error ? 'station unreachable at ' + co.STATION_URL + ' (' + st.error + ')' : 'GET /api/cron answered HTTP ' + st.status + ' (token wrong or station not ready)');
  // 2
  // the self-paced loop's state (company/tools/dispatcher-loop.js): a tick running now, or the last one ended within one
  // effective tick; an install without the loop yet falls back to dispatch-log.md's age
  const lp = readJson(F.loopState, null);
  const lpTick = lp && lp.tempo && Number(lp.tempo.tickMin) > 0 ? Number(lp.tempo.tickMin) : tickMin();
  const lpAt = lp && (lp.status === 'ticking' ? Date.now() : Date.parse(lp.lastTickEndAt || lp.lastTickAt || ''));
  let age = null; if (lpAt) age = (Date.now() - lpAt) / 60000; else { try { age = (Date.now() - fs.statSync(F.dispatchLog).mtimeMs) / 60000; } catch (_) {} }
  const lim = Math.max(lpTick, tickMin());
  put('dispatcher', age !== null && age <= lim + 1 && !(lp && lp.status === 'stopped'), age === null ? 'company/work/dispatch-log.md does not exist: the dispatcher has never ticked (systemctl --user start <station>-dispatch.service)' : lp && lp.status === 'stopped' ? 'the dispatcher loop is stopped (company/state/dispatcher-loop.json): systemctl --user start <station>-dispatch.service' : (lpAt ? 'the dispatcher loop last ticked ' : 'dispatch-log.md last written ') + Math.round(age) + ' min ago (tick is ' + lim + ' min)');
  // 3
  const gd = jsonOf(node([tool('guardrails.js'), 'apply', '--dry-run', '--json'], { timeout: 60000 }));
  const unreach = ((gd && gd.notes) || []).filter(n => /ECONNREFUSED|unreachable|timeout|no station token/i.test(n));
  put('guardrails', gd && gd.ok !== false && !(gd.steps || []).length && !unreach.length, !gd ? 'guardrails.js apply --dry-run gave no answer' : unreach.length ? 'guardrails dry-run could not read the station: ' + unreach[0].slice(0, 120) : (gd.steps || []).length + ' station-side step(s) not applied: node company/tools/guardrails.js apply --by owner');
  // 4
  const need = new Set(['station-token']);
  for (const id of enabledModules()) for (const x of (((readJson(co.p('modules', id, 'module.json'), {}) || {}).requires || {}).secrets || [])) need.add(x);
  for (const id of Object.keys(((readJson(co.p('company', 'state', 'packs.json'), {}) || {}).installed) || {})) for (const x of (((readJson(co.p('company', 'state', 'packs', 'installed', id, 'pack.json'), {}) || {}).requires || {}).secrets || [])) need.add(x);
  const badSec = [...need].filter(x => !modeOk(path.join(co.SECRETS_DIR, x)));
  put('secrets', !badSec.length, 'missing, empty or not 0600: ' + badSec.map(x => 'secrets/' + x).join(', '));
  // 5
  const opsBad = [];
  if (!Array.isArray(readJson(F.targets, null))) opsBad.push('company/work/ops/health-targets.json not registered');
  if (!Array.isArray(readJson(F.backups, null))) opsBad.push('company/work/ops/backups.json not registered');
  const v = backupScript(['verify']);
  if (v.status !== 0) opsBad.push('no verified backup (scripts/backup.sh, then backup.sh verify): ' + String(v.stdout || v.stderr).trim().split('\n').pop().slice(0, 120));
  put('ops', !opsBad.length, opsBad.join('; '));
  // 6
  let lv = null; try { lv = require(co.p('modules', 'liveness', 'watch.js')).status(); } catch (_) {}
  put('liveness', lv && lv.enabled && lv.heartbeat && lv.pingedAt, !lv || !lv.enabled ? 'liveness module not enabled: node company/tools/module.js enable liveness --by owner' : !lv.heartbeat ? 'no dispatcher heartbeat yet (company/state/heartbeat.json): wait one dispatcher tick' : 'never pinged: node company/tools/liveness.js ping');
  // 7
  const pd = node([tool('pack.js'), 'doctor', '--all', '--json'], { timeout: 300000 });
  const md = node([tool('module.js'), 'doctor', '--all', '--json'], { timeout: 300000 });
  const bad = [];
  if (pd.status !== 0) bad.push('pack.js doctor --all: ' + (((jsonOf(pd) || {}).packs || []).filter(x => x.installed && x.status !== 'conformant').map(x => x.id).join(', ') || 'exit ' + pd.status));
  if (md.status !== 0) bad.push('module.js doctor --all: ' + (((jsonOf(md) || {}).modules || []).filter(x => x.enabled && x.status !== 'conformant').map(x => x.id + ' (' + (x.findings || [])[0] + ')').join(', ') || 'exit ' + md.status));
  put('doctor', !bad.length, bad.join('; '));
  // 8
  let ch = ''; try { ch = fs.readFileSync(F.charter, 'utf8'); } catch (_) {}
  const body = ch.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')   /* code (paths like `roles/<name>.md`) is not a blank */;
  const ph = [...new Set((body.match(/\{\{[A-Z_]+\}\}|<(?!none yet>)[A-Za-z][^<>\n]{0,200}>/g) || []))];
  put('charter', ch && !ph.length, !ch ? 'company/CHARTER.md missing' : 'placeholders left: ' + ph.slice(0, 4).map(x => x.slice(0, 50)).join(' · ') + (ph.length > 4 ? ' (+' + (ph.length - 4) + ')' : ''));
  // 9
  const ct = co.secret('console-token');
  const cr = ct ? await get(consoleUrl() + '/api/company', { 'x-console-token': ct }) : { ok: false, error: 'no secrets/console-token (start the console once: scripts/console.sh)' };
  put('console', cr.ok && cr.json && cr.json.ok, cr.error ? 'console at ' + consoleUrl() + ': ' + cr.error : 'console answered HTTP ' + cr.status);
  // 10
  let ss = null; try { ss = await require('./station-seed.js').status(); } catch (e) { ss = { ok: false, problems: [{ code: e.message }] }; }
  put('station-seed', ss.ok, (ss.problems || []).map(p => p.code + (p.fix ? ' (fix: ' + p.fix + ')' : '')).join('; '));
  // 11
  let fl = null; try { fl = await require('./founder-loop.js').status(); } catch (e) { fl = { ok: false, problems: [{ msg: e.message, fix: 'node company/tools/founder-loop.js status' }] }; }
  put('founder-loop', fl.ok, (fl.problems || []).map(p => p.msg + ' (fix: ' + p.fix + ')').join('; '));
  const ok = Object.values(res).every(x => x.ok);
  const s = state();
  const was = s.certified;
  s.checks = { at: now(), ok, results: res };
  s.certified = ok; if (ok && !was) s.certifiedAt = now();
  writeJson(F.state, s);
  ledger({ certify: ok, failed: Object.keys(res).filter(k => !res[k].ok) });
  if (ok && !was) { try { require('./owner-inbox.js').send({ from: 'onboard.js', text: 'Onboarding: the company is CERTIFIED (all ' + CHECKS.length + ' checks green). It is operational. The Founder is drafting the first plan now: [watch it on Today](console:#/today).' }); } catch (_) {} }
  let kick = null;
  if (ok) { try { kick = await kickoff(); } catch (e) { kick = { status: 'failed', note: e.message }; setStep('kickoff', 'failed', e.message); } }
  return { ok, certified: ok, results: res, kickoff: kick };
}

/* ---------- kickoff: the Founder's first planning run, once ---------- */
// When the company certifies, the Founder gets one OPEN handoff (turn the charter into a first plan) and its loop is
// fired once (POST /api/cron/run, detached). Recorded as the step `kickoff`; never fired twice.
const KICKOFF_TITLE = 'turn the charter into the first plan';
async function kickoff() {
  const s0 = state();
  if ((s0.steps.kickoff || {}).status === 'ok') return { status: 'ok', note: 'already kicked off ' + s0.steps.kickoff.at, already: true };
  const FL = require('./founder-loop.js');
  const seat = FL.seat();
  const inbox = co.p('company', 'work', 'handoffs', seat.inbox);
  let txt = ''; try { txt = fs.readFileSync(inbox, 'utf8'); } catch (_) {}
  if (!txt.includes(KICKOFF_TITLE)) {
    const day = co.localParts().date;
    const block = '\n## ' + day + ' from onboard.js — ' + KICKOFF_TITLE + '\n' +
      '**Need:** read company/CHARTER.md and turn it into the company\'s first plan. (1) Goals: mint each as a station quest whose contract is a company/work/ file (see your loop prompt for the mint command and the domain list). ' +
      '(2) Roles: the seats you will open first and why; open them with `node company/tools/hire.js open` — the hiring governance level (`node company/tools/governance.js check hiring`) decides whether the owner is asked first — and write each round\'s files (role-spec.md, interview.md, scorecard.md, profiles/<name>.md); the rounds then advance on their own (candidates, parallel interviews) and each pick comes back to you as a handoff. ' +
      '(3) First tasks: as quest steps or handoffs, each with an owner and a date. Write the plan to company/work/plan.md, then send the owner a short summary (owner-inbox.js send) with links: ' +
      '[the plan\'s quests](console:#/work/quests), [hiring](console:#/hiring), [handoffs](console:#/work/handoffs). Close this handoff with the evidence.\n' +
      '**Why:** the company just certified; until there is a plan nobody knows what to build first.\n**Deadline:** ' + day + '\n**Status:** OPEN\n**Evidence:** company/state/onboarding-state.json (certified)\n';
    fs.mkdirSync(path.dirname(inbox), { recursive: true });
    fs.appendFileSync(inbox, (txt ? '' : '# Handoffs to ' + seat.name + '\n') + block);
  }
  const cr = await FL.stationCall('GET', '/api/cron');
  const job = cr.json && Array.isArray(cr.json.jobs) ? FL.findLoop(cr.json.jobs, seat) : null;
  if (!job) { const st = setStep('kickoff', 'pending', 'handoff written; no "' + seat.loop + '" routine to fire (the dispatcher wakes the Founder once it exists)'); return st; }
  const r = await FL.stationCall('POST', '/api/cron/run', { id: job.id, detach: true }, 20000);
  const ok = r.status === 200;
  return setStep('kickoff', ok ? 'ok' : 'pending', ok ? 'fired "' + job.name + '" for the first plan' + (r.json && r.json.runId ? ' (run ' + r.json.runId + ')' : '') : 'handoff written; firing "' + job.name + '" answered ' + (r.error || 'HTTP ' + r.status) + ' (the dispatcher wakes it for the open handoff)');
}

/* ---------- check (read only) ---------- */
function check() {
  const s = state();
  const steps = STEPS.map(([id, what]) => { const r = s.steps[id] || {}; return { id, what, status: r.status || (id === 'founded' && fs.existsSync(F.founded) ? 'ok' : 'pending'), at: r.at || null, note: r.note || null }; });
  const last = s.checks || null;
  const checks = CHECKS.map(([id, what]) => { const r = last && last.results && last.results[id]; return { id, what, status: r ? (r.ok ? 'ok' : 'failed') : 'unchecked', missing: r ? r.missing : null }; });
  const provisioned = ['founded', 'station-installed', 'station-answers'].every(k => steps.find(x => x.id === k).status === 'ok');
  return { ok: true, provisioned, certified: !!s.certified, certifiedAt: s.certifiedAt || null, lastCertify: last ? last.at : null, steps, checks,
    missing: steps.filter(x => x.status !== 'ok').map(x => x.id + ': ' + (x.note || x.what)).concat(checks.filter(x => x.status !== 'ok').map(x => x.id + ': ' + (x.missing || 'run onboard.js --certify'))), gates: s.gates || {} };
}

/* ---------- teardown ---------- */
function teardown({ by, purge }) {
  const b = String(by || '').toLowerCase();
  if (!(b === 'owner' || (co.config.owner && b === String(co.config.owner.name || '').toLowerCase()))) return { ok: false, error: 'only the owner tears a company down (--by owner)' };
  try { if (require('./provenance.js').underStation()) return { ok: false, error: 'refused inside an agent\'s station run' }; } catch (_) {}
  const svc = co.config.station.serviceName || 'capheos-station';
  const stopped = [];
  if (process.env.ONBOARD_NO_SYSTEMCTL !== '1') for (const u of [svc + '-liveness.timer', svc + '-dispatch.timer', svc + '-dispatch.service', svc + '.service']) { const r = spawnSync('systemctl', ['--user', 'disable', '--now', u], { encoding: 'utf8', timeout: 60000 }); stopped.push({ unit: u, code: r.status }); }
  const bk = backupScript([]);
  const v = backupScript(['verify']);
  const archived = bk.status === 0 && v.status === 0;
  const out = { ok: archived, stopped, archive: archived ? String(bk.stdout).trim().split('\n').pop() : null, verify: String(v.stdout || v.stderr).trim().split('\n').pop() };
  if (!archived) { out.error = 'archive failed or did not verify; nothing deleted'; ledger({ teardown: false, error: out.error }); return out; }
  setStep('teardown', 'ok', out.archive);
  if (purge) { for (const d of ['work', 'state', 'owner', 'hiring']) fs.rmSync(co.p('company', d), { recursive: true, force: true }); out.purged = ['company/work', 'company/state', 'company/owner', 'company/hiring']; fs.mkdirSync(path.dirname(F.log), { recursive: true }); ledger({ teardown: true, purged: out.purged, archive: out.archive }); }
  return out;
}

/* ---------- selftest ---------- */
async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-selftest-'));
  let fails = 0, n = 0;
  const t = (name, ok, x) => { n++; if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || x === undefined ? '' : ' :: ' + JSON.stringify(x).slice(0, 600))); };
  const repo = path.resolve(__dirname, '..', '..');
  const srv = http.createServer((req, res) => {
    const tok = req.headers['x-starnet-token'] === 'tok';
    const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!tok) return send(401, { ok: false });
    if (req.url === '/api/cron') return send(200, { ok: true, enabled: true, jobs: [] });
    if (req.url === '/api/providers') return send(200, { ok: true, providers: srv.providers });
    return send(404, { ok: false });
  });
  srv.providers = [{ id: 'deepseek', configured: true, unattendedReady: true }];
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    fs.cpSync(path.join(repo, 'company'), path.join(tmp, 'company'), { recursive: true, filter: s => !/[\/\\]company[\/\\](state|work|owner|hiring)[\/\\]./.test(s) });
    fs.cpSync(path.join(repo, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
    if (fs.existsSync(path.join(repo, 'modules'))) fs.cpSync(path.join(repo, 'modules'), path.join(tmp, 'modules'), { recursive: true });
    for (const d of ['state', 'work', 'owner']) fs.mkdirSync(path.join(tmp, 'company', d), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'secrets', 'station-token'), 'tok\n', { mode: 0o644 });
    const cj = readJson(path.join(tmp, 'company', 'company.json'), {}); cj.name = 'Test Co'; cj.slug = 'test-co'; cj.owner = { name: 'Alex' }; cj.station = { port };
    fs.writeFileSync(path.join(tmp, 'company', 'company.json'), JSON.stringify(cj));
    fs.mkdirSync(path.join(tmp, 'company', 'work', 'finance'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'company', 'defaults', 'work', 'finance', 'dispatch-budget.json'), path.join(tmp, 'company', 'work', 'finance', 'dispatch-budget.json'));
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: tmp, STARNET_URL: 'http://127.0.0.1:' + port, CAPHEOS_BACKUP_DIR: path.join(tmp, 'backups'), CONSOLE_URL: 'http://127.0.0.1:1', ONBOARD_NO_SYSTEMCTL: '1' });
    const run = (...a) => new Promise(resolve => { const c = require('child_process').spawn(process.execPath, [path.join(tmp, 'company', 'tools', 'onboard.js'), ...a, '--json'], { cwd: tmp, env }); let o = '', e = ''; c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; }); c.on('close', code => { let j = null; try { j = JSON.parse(o); } catch (_) {} resolve({ code, j, out: o + e }); }); });
    let r = await run('--check');
    t('--check on a fresh root: not provisioned, not certified', r.code === 0 && r.j.provisioned === false && r.j.certified === false && r.j.checks.every(c => c.status === 'unchecked'), r.out);
    r = await run('--certify');
    const f = r.j && r.j.results;
    t('--certify on a fresh root fails closed, exit 1', r.code === 1 && r.j.ok === false, r.out);
    t('certify: station passes (it answers), dispatcher fails (never ticked)', f && f.station.ok && !f.dispatcher.ok && /never ticked/.test(f.dispatcher.missing), f);
    t('certify: a 0644 station token fails the secrets check', f && !f.secrets.ok && /station-token/.test(f.secrets.missing), f && f.secrets);
    t('certify: ops, liveness, charter and console fail with what is missing', f && /health-targets/.test(f.ops.missing) && /liveness module not enabled/.test(f.liveness.missing) && /placeholders|missing/.test(f.charter.missing) && !f.console.ok, f);
    t('certify: doctor passes with nothing installed', f && f.doctor.ok, f && f.doctor);
    r = await run('--resume');
    const s = r.j && r.j.steps;
    t('--resume: metered default with a $0 cap and no subscription is a pending gate', s && s['candidate-default'].status === 'pending' && /\$0 cap/.test(s['candidate-default'].note), s && s['candidate-default']);
    t('--resume: ops registered, first backup verified', s && s['ops-registered'].status === 'ok' && s['first-backup'].status === 'ok', s);
    t('--resume: the owner-gate batch filed one question', s && s['owner-gates'].status === 'ok' && /question q-/.test(s['owner-gates'].note), s && s['owner-gates']);
    r = await run('--resume');
    t('a second --resume asks nothing new (asked once)', r.j && /answers in the ledger/.test(r.j.steps['owner-gates'].note), r.j && r.j.steps['owner-gates']);
    srv.providers.push({ id: 'claude-cli', configured: true, unattendedReady: true });
    {
      // an owner's choice is never overwritten (the sandbox finding: Setup chose DeepSeek, --resume swapped in claude-cli)
      const polF = path.join(tmp, 'company', 'model-policy.json'), budF = path.join(tmp, 'company', 'work', 'finance', 'dispatch-budget.json');
      const pol0 = fs.readFileSync(polF, 'utf8'), bud0 = fs.readFileSync(budF, 'utf8');
      const pol = JSON.parse(pol0); pol.candidateDefault = Object.assign({}, pol.candidateDefault, { provider: 'deepseek', model: 'deepseek-flash', setBy: 'Alex', setAt: '2026-11-16T00:00:00Z' }); fs.writeFileSync(polF, JSON.stringify(pol));
      const bud = JSON.parse(bud0); bud.dailyUsd = 5; fs.writeFileSync(budF, JSON.stringify(bud));
      r = await run('--step', 'candidate-default');
      let cd = readJson(polF, {}).candidateDefault;
      t('candidate-default: owner-set metered default with a $5 cap is kept, though a subscription is on the station', r.j && r.j.status === 'ok' && cd.provider === 'deepseek' && cd.setBy === 'Alex', { r: r.j, cd });
      bud.dailyUsd = 0; fs.writeFileSync(budF, JSON.stringify(bud));
      r = await run('--step', 'candidate-default');
      cd = readJson(polF, {}).candidateDefault;
      t('candidate-default: owner-set default that cannot run ($0 cap) is a needs-you item, never changed', r.j && r.j.status === 'pending' && /owner/.test(r.j.note) && cd.provider === 'deepseek' && cd.setBy === 'Alex', { r: r.j, cd });
      fs.writeFileSync(polF, pol0); fs.writeFileSync(budF, bud0);
    }
    r = await run('--resume');
    t('--resume: a subscription provider on the station becomes the candidate default', r.j && r.j.steps['candidate-default'].status === 'ok' && readJson(path.join(tmp, 'company', 'model-policy.json'), {}).candidateDefault.provider === 'claude-cli', r.j && r.j.steps['candidate-default']);
    r = await run('--record', 'station-installed', 'ok');
    t('--record writes a step and a ledger row', r.code === 0 && readJson(path.join(tmp, 'company', 'state', 'onboarding-state.json'), {}).steps['station-installed'].status === 'ok' && fs.readFileSync(path.join(tmp, 'company', 'state', 'onboarding-log.jsonl'), 'utf8').includes('station-installed'), r.out);
    r = await run('--teardown', '--by', 'Sam');
    t('--teardown refused for anyone but the owner', r.code === 1 && /only the owner/.test(r.out), r.out);
    r = await run('--teardown', '--purge', '--by', 'owner');
    t('--teardown --purge archives and verifies before deleting', r.code === 0 && r.j.archive && r.j.purged && !fs.existsSync(path.join(tmp, 'company', 'work', 'ops')) && fs.readdirSync(path.join(tmp, 'backups')).some(x => x.endsWith('.tar.gz')), r.out);
  } catch (e) { t('selftest crashed', false, e.stack); }
  finally { srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log((fails ? 'FAIL ' : 'PASS ') + (n - fails) + '/' + n);
  return fails ? 1 : 0;
}

module.exports = { check, certify, resume, step, state, setStep, STEPS, CHECKS };
if (require.main === module) {
  const a = process.argv.slice(2);
  const has = k => a.includes('--' + k);
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : undefined; };
  const show = (r, human) => { if (has('json') || !human) console.log(JSON.stringify(r, null, 1)); else human(r); };
  (async () => {
    if (has('selftest') || a[0] === 'selftest') process.exit(await selftest());
    if (has('record')) {
      const i = a.indexOf('--record'); const step = a[i + 1], st = a[i + 2];
      if (!step || !['ok', 'failed', 'pending'].includes(st)) { console.error('--record <step> <ok|failed|pending> [--note ..]'); process.exit(2); }
      show(setStep(step, st, opt('note'))); process.exit(0);
    }
    if (has('step')) { const r = await step(opt('step')); show(r, x => console.log((x.status || 'failed') + ' ' + (x.step || '') + ' — ' + (x.note || x.error || ''))); process.exit(r.ok ? 0 : 1); }
    if (has('check')) { const r = check(); show(r, x => { console.log((x.certified ? 'CERTIFIED' : 'NOT CERTIFIED') + ' · ' + (x.provisioned ? 'provisioned' : 'not provisioned')); for (const s of x.steps) console.log('  step  ' + s.status.padEnd(9) + ' ' + s.id + (s.note ? ' — ' + s.note : '')); for (const c of x.checks) console.log('  check ' + c.status.padEnd(9) + ' ' + c.id + (c.missing ? ' — ' + c.missing : '')); }); process.exit(0); }
    if (has('resume')) { const r = await resume(); show(r, x => { for (const [k, v] of Object.entries(x.steps)) console.log('  ' + v.status.padEnd(8) + ' ' + k + (v.note ? ' — ' + v.note : '')); }); process.exit(r.ok ? 0 : 1); }
    if (has('certify')) { const r = await certify(); show(r, x => { console.log(x.ok ? 'CERTIFIED' : 'NOT CERTIFIED'); for (const [k, v] of Object.entries(x.results)) console.log('  ' + (v.ok ? 'ok  ' : 'FAIL') + ' ' + k + (v.missing ? ' — ' + v.missing : '')); }); process.exit(r.ok ? 0 : 1); }
    if (has('teardown')) { const r = teardown({ by: opt('by'), purge: has('purge') }); show(r); process.exit(r.ok ? 0 : 1); }
    console.error('usage: onboard.js --check | --resume | --step <name> | --certify | --teardown [--purge] --by owner | --record <step> <status> | --selftest   [--json]');
    process.exit(2);
  })().catch(e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
