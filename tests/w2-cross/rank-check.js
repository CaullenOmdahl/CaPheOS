// (2) the router's real decisions (lib/routing.js decide, on the policy routing.js wrote) feed model-rank.js evaluate and
// routing.js status. E2E_REPO=<worktree> node rank-check.js
'use strict';
process.env.CAPHEOS_TZ = 'UTC';
const fs = require('fs'), path = require('path'), os = require('os'); const { spawnSync } = require('child_process');
const REPO = process.env.E2E_REPO, TOOLS = path.join(REPO, 'company', 'tools');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-rank-'));
fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
const w = (rel, d) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1) + '\n'); };
const env = Object.assign({}, process.env, { CAPHEOS_ROOT: T, CAPHEOS_TZ: 'UTC', STARNET_URL: 'http://127.0.0.1:9' });
const CREW = { lee: { name: 'Lee', functions: ['ceo'], inbox: 'to-lee.md', manager: null }, hal: { name: 'Hal', functions: ['people'], inbox: 'to-hal.md', manager: 'lee' },
  sam: { name: 'Sam', inbox: 'to-sam.md', manager: 'lee' }, kim: { name: 'Kim', inbox: 'to-kim.md', manager: 'lee' } };
const DEPS = { version: 1, departments: [{ id: 'eng', name: 'Engineering', lead: 'lee', members: ['sam', 'kim'], defaultClass: 'code', routes: {}, consult: {} }] };
w('company/company.json', { name: 'Rank Co', slug: 'rank', timezone: 'UTC', owner: { name: 'Olive' }, station: { url: 'http://127.0.0.1:9' } });
w('company/tools/loops.json', { agents: CREW });
w('company/departments.json', DEPS);
w('company/model-policy.json', { allowed: { 'claude-cli': { models: ['haiku', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'] }, deepseek: { models: ['deepseek-flash'] } } });
w('company/work/decisions.md', '# Decisions\n\n');
for (const rel of ['company/defaults/work/models/routing-policy.json', 'company/defaults/work/models/ranking-policy.json']) w(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
const rt = argv => { const p = spawnSync(process.execPath, [path.join(TOOLS, 'routing.js'), ...argv], { cwd: T, env, encoding: 'utf8' }); if (p.status !== 0) throw new Error(argv.join(' ') + ': ' + p.stdout + p.stderr); return p.stdout; };
rt(['trial', 'create', 'code-cmp', '--class', 'code', '--arm', 'claude-cli/claude-sonnet-5-5@high', '--arm', 'claude-cli/claude-opus-5-5@medium', '--scope-seat', 'sam', '--entry-share', '0.5', '--min-items', '10', '--by', 'Hal']);
rt(['trial', 'start', 'code-cmp', '--by', 'owner']);
rt(['mode', 'live', '--by', 'owner']);
const R = require(path.join(TOOLS, 'lib', 'routing.js'));
const policy = R.loadPolicy(T).policy;
const SON = { provider: 'claude-cli', model: 'claude-sonnet-5-5', effort: 'high' }, OPUS = { provider: 'claude-cli', model: 'claude-opus-5-5', effort: 'medium' }, FAB = { provider: 'claude-cli', model: 'claude-fable-5-2', effort: 'medium' };
const strip = p => ({ provider: p.provider, model: p.model });
const NOW = Date.UTC(2030, 1, 1), H = 3600e3;
const wakes = [], runs = [], inbox = { 'to-sam.md': ['# Sam\n'], 'to-kim.md': ['# Kim\n'] };
let seq = 0;
function item(seat, id, d, route, fail) {
  const file = 'to-' + seat + '.md', at = Date.UTC(2030, 0, d) + 10 * H + (seq % 50) * 60e3;
  const runId = 'run-' + id + '-' + String(++seq).padStart(4, '0');
  const ran = route.provider ? route : null;
  runs.push({ runId, parentRunId: '', agentId: seat, provider: ran.provider, model: ran.model, servedModel: ran.model, reasoningEffort: ran.effort, reason: 'done', turns: 8, tokens: 400000, cachedTokens: 200000, usd: 0, unmetered: true, startedAt: at + 60e3, endedAt: at + 31 * 60e3, ts: at + 31 * 60e3 });
  wakes.push({ at, ts: new Date(at).toISOString(), wakeId: route._wakeId, seat, runId, admitId: 'adm-' + seq, jobId: 'job-' + seat, door: 'dispatch', items: [{ file, id, title: 'task ' + id, due: null }], why: '1 OPEN in ' + file, route: route._route });
  inbox[file].push(['## ' + new Date(at - H).toISOString().slice(0, 16).replace('T', ' ') + ' from Lee — task ' + id, '**Id:** ' + id, '**Need:** task ' + id, '**Class:** code', ...(fail ? ['**Verdict:** REVISE by Lee — check: fails — one finding'] : []), '**Status:** DONE', '**Resolved ' + new Date(at + 4 * H).toISOString().slice(0, 16).replace('T', ' ') + ' by ' + CREW[seat].name + '**'].join('\n') + '\n');
}
const txt = '## x\n**Class:** code\n**Status:** OPEN\n';
const counts = { live: { 0: 0, 1: 0, none: 0, applied: 0, control: 0 }, shadow: { 0: 0, 1: 0, none: 0, recordedWithTrial: 0 }, capApplied: 0, capBaseline: 0 };
// (a) live trial: sam's chain is Opus@medium (arm 1 = control), both arms open
for (let k = 0; k < 120; k++) {
  const wakeId = 'wk-live-' + k;
  const d = R.decide({ policy, seat: 'sam', items: [{ text: txt }], wakeId, departments: DEPS, crew: CREW, chain: [OPUS, SON], current: OPUS, held: [], allow: [strip(SON), strip(OPUS)] });
  if (d.trial !== 'code-cmp') { counts.live.none++; continue; }
  counts.live[d.arm]++; if (d.applied) counts.live.applied++; else counts.live.control++;
  item('sam', 'L' + k, 2 + (k % 20), Object.assign({ _wakeId: wakeId, _route: d }, d), k % 7 === 0);
}
// (b) the same trial in shadow: what does the router record when the assigned arm is the chain's own pair?
const shadowPolicy = Object.assign({}, policy, { mode: 'shadow' });
const shadowRoutes = [];
for (let k = 0; k < 120; k++) {
  const wakeId = 'wk-sh-' + k;
  const g = R.assign(policy.trials[0], wakeId); if (!g.entered) continue;
  const d = R.decide({ policy: shadowPolicy, seat: 'sam', items: [{ text: txt }], wakeId, departments: DEPS, crew: CREW, chain: [OPUS, SON], current: OPUS, held: [], allow: [strip(SON), strip(OPUS)] });
  counts.shadow[g.arm]++;
  const named = (d.wouldApply && d.wouldApply.trial) || d.trial; if (named) counts.shadow.recordedWithTrial++;
  shadowRoutes.push({ arm: g.arm, route: d });
}
// (c) tier caps on kim (not exempt, not a lead): chain Fable, Sonnet. live + Sonnet open = applied; shadow = baseline
for (const [mode, n, open] of [['live', 25, true], ['shadow', 25, true]]) {
  const P = JSON.parse(JSON.stringify(policy)); P.tierCaps.mode = mode; P.mode = 'off';
  for (let k = 0; k < n; k++) {
    const wakeId = 'wk-cap-' + mode + k;
    const d = R.decide({ policy: P, seat: 'kim', items: [{ text: txt }], wakeId, departments: DEPS, crew: CREW, chain: [FAB, SON], current: FAB, held: [], allow: open ? [strip(SON), strip(FAB)] : [] });
    if (d.source === 'tierCap' && d.applied) counts.capApplied++; else if (d.wouldApply && d.wouldApply.source === 'tierCap') counts.capBaseline++;
    item('kim', (mode === 'live' ? 'C' : 'B') + k, 2 + (k % 20), Object.assign({ _wakeId: wakeId, _route: d }, d.applied ? d : { provider: FAB.provider, model: FAB.model, effort: FAB.effort }), mode === 'live' ? k % 10 === 0 : k % 10 === 0);
  }
}
wakes.sort((a, b) => a.at - b.at || (a.wakeId < b.wakeId ? -1 : 1)); runs.sort((a, b) => a.ts - b.ts);
for (const [f, parts] of Object.entries(inbox)) w('company/work/handoffs/' + f, parts.join('\n'));
w('company/state/wakes.jsonl', wakes.map(x => JSON.stringify(x)).join('\n') + '\n');
w('.starnet-data/workspaces/runs.jsonl', runs.map(x => JSON.stringify(x)).join('\n') + '\n');
const M = require(path.join(TOOLS, 'model-rank.js'));
const ev = M.evaluate(M.load({ root: T, now: NOW }));
const t = ev.trials.find(x => x.id === 'code-cmp');
const cap = (ev.tierCaps.classes || []).find(c => c.class === 'code');
console.log('router counts', JSON.stringify(counts));
console.log('model-rank trial arms', JSON.stringify(t && t.arms.map(a => ({ arm: a.arm, items: a.items, shadowItems: a.shadowItems, mismatches: a.mismatches }))), 'decision', t && t.decision.state);
console.log('model-rank tier cap code', JSON.stringify(cap && { capped: cap.capped && cap.capped.items, baseline: cap.baseline && cap.baseline.items, verdict: cap.verdict }));
if (!cap) console.log('tierCaps raw', JSON.stringify(ev.tierCaps).slice(0, 800));
// routing.js status reads the same wakes (it filters by startedAt, which is now: wakes are in 2030)
const st = JSON.parse(rt(['status', '--json']));
console.log('routing.js status arms', JSON.stringify(st.trials[0].arms.map(a => ({ arm: a.index, wakes: a.wakes, items: a.items, shadowWakes: a.shadowWakes, shadowItems: a.shadowItems }))));
console.log('shadow sample (arm = chain pair):', JSON.stringify(shadowRoutes.find(x => x.arm === 1).route));
console.log('shadow sample (arm != chain):', JSON.stringify(shadowRoutes.find(x => x.arm === 0).route));
console.log('ROOT', T);
