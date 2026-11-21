#!/usr/bin/env node
'use strict';
/* Writes tasks/<kind>/<depth>/<id>.json from the catalogue below. Run it after changing the catalogue; a task whose
 * content changes must get a higher version (VERSIONS below), so results stay comparable only between equal versions.
 *   node packs/model-bench/dev/make-tasks.js [--check]    --check: exit 1 when the files on disk differ from the catalogue */
const fs = require('fs');
const path = require('path');
const { CANARY } = require('../lib/world');
const C6 = require('../gen/code-fix');
const F = require('../gen/feature');
const K8 = require('../fixtures/k8/tasks');

const UNIT = path.join(__dirname, '..');
const DEPTHS = ['lookup', 'simple', 'standard', 'deep'];
// task id -> version, when a task has changed since 1. Every task with tools (sandbox files or exec) is one higher than
// listed here: the tool protocol text of its prompt was rewritten on 2026-11-22 (TOOL_BUMP)
const TOOL_BUMP = 1;
// 2: the fairness audit of 2026-11-21 (questions in the files' terms, scorers that accept values copied from the files,
//    the expected answer worked out from what is shown, stated shapes and boundaries, no tool caches in the workspace)
const VERSIONS = {
  'k1-lookup-01': 2, 'k1-lookup-02': 2, 'k1-lookup-03': 2, 'k1-lookup-04': 2, 'k1-lookup-05': 2, 'k1-lookup-06': 2,
  'k1-simple-02': 2, 'k1-simple-04': 2, 'k1-simple-06': 2, 'k1-standard-01': 2, 'k1-standard-02': 2, 'k1-standard-03': 2,
  'k1-standard-04': 2, 'k1-standard-05': 2, 'k1-standard-06': 2, 'k1-deep-01': 2, 'k1-deep-02': 2, 'k1-deep-03': 2,
  'k1-deep-04': 2, 'k1-deep-05': 2, 'k1-deep-06': 2, 'k2-lookup-01': 2, 'k2-lookup-02': 2, 'k2-lookup-03': 2,
  'k2-lookup-04': 2, 'k2-lookup-05': 2, 'k2-lookup-06': 2, 'k2-simple-01': 2, 'k2-simple-02': 2, 'k2-simple-03': 2,
  'k2-simple-04': 2, 'k2-simple-05': 2, 'k2-simple-06': 2, 'k2-standard-01': 2, 'k2-standard-02': 2, 'k2-standard-03': 2,
  'k2-standard-04': 2, 'k2-standard-05': 2, 'k2-standard-06': 2, 'k2-deep-01': 2, 'k2-deep-02': 2, 'k2-deep-03': 2,
  'k2-deep-04': 2, 'k2-deep-05': 2, 'k2-deep-06': 2, 'k3-lookup-01': 2, 'k3-lookup-02': 2, 'k3-lookup-03': 2,
  'k3-lookup-04': 2, 'k3-lookup-05': 2, 'k3-lookup-06': 2, 'k3-simple-01': 2, 'k3-simple-02': 2, 'k3-simple-03': 2,
  'k3-simple-04': 2, 'k3-simple-05': 2, 'k3-simple-06': 2, 'k3-standard-01': 2, 'k3-standard-02': 2, 'k3-standard-03': 2,
  'k3-standard-04': 2, 'k3-standard-05': 2, 'k3-standard-06': 2, 'k3-deep-01': 2, 'k3-deep-02': 2, 'k3-deep-03': 2,
  'k3-deep-04': 2, 'k3-deep-05': 2, 'k3-deep-06': 2, 'k4-lookup-01': 2, 'k4-lookup-02': 2, 'k4-lookup-03': 2,
  'k4-lookup-04': 2, 'k4-lookup-05': 2, 'k4-lookup-06': 2, 'k4-simple-01': 2, 'k4-simple-02': 2, 'k4-simple-03': 2,
  'k4-simple-04': 2, 'k4-simple-05': 2, 'k4-simple-06': 2, 'k4-standard-01': 2, 'k4-standard-02': 2, 'k4-standard-03': 2,
  'k4-standard-04': 2, 'k4-standard-05': 2, 'k4-standard-06': 2, 'k4-deep-01': 2, 'k4-deep-02': 2, 'k4-deep-03': 2,
  'k4-deep-04': 2, 'k4-deep-05': 2, 'k4-deep-06': 2, 'k5-lookup-01': 2, 'k5-lookup-02': 2, 'k5-lookup-03': 2,
  'k5-lookup-04': 2, 'k5-lookup-05': 2, 'k5-lookup-06': 2, 'k5-simple-01': 2, 'k5-simple-02': 2, 'k5-simple-03': 2,
  'k5-simple-04': 2, 'k5-simple-05': 2, 'k5-simple-06': 2, 'k5-standard-01': 2, 'k5-standard-02': 2, 'k5-standard-03': 2,
  'k5-standard-04': 2, 'k5-standard-05': 2, 'k5-standard-06': 2, 'k5-deep-01': 2, 'k5-deep-02': 2, 'k5-deep-03': 2,
  'k5-deep-04': 2, 'k5-deep-05': 2, 'k5-deep-06': 2, 'k6-lookup-01': 2, 'k6-lookup-02': 2, 'k6-lookup-03': 2,
  'k6-lookup-04': 2, 'k6-lookup-05': 2, 'k6-lookup-06': 2, 'k6-simple-01': 2, 'k6-simple-02': 2, 'k6-simple-03': 2,
  'k6-simple-04': 2, 'k6-simple-05': 2, 'k6-simple-06': 2, 'k6-standard-01': 2, 'k6-standard-02': 2, 'k6-standard-03': 2,
  'k6-standard-04': 2, 'k6-standard-05': 2, 'k6-standard-06': 2, 'k6-deep-01': 2, 'k6-deep-02': 2, 'k6-deep-03': 2,
  'k6-deep-04': 2, 'k6-deep-05': 2, 'k6-deep-06': 2, 'k7-lookup-01': 2, 'k7-lookup-02': 2, 'k7-lookup-03': 2,
  'k7-lookup-04': 2, 'k7-lookup-05': 2, 'k7-lookup-06': 2, 'k7-simple-01': 2, 'k7-simple-02': 2, 'k7-simple-03': 2,
  'k7-simple-04': 2, 'k7-simple-05': 2, 'k7-simple-06': 2, 'k7-standard-01': 2, 'k7-standard-02': 2, 'k7-standard-03': 2,
  'k7-standard-04': 2, 'k7-standard-05': 2, 'k7-deep-01': 2, 'k7-deep-02': 2, 'k7-deep-03': 2, 'k7-deep-04': 2,
  'k8-lookup-01': 2, 'k8-lookup-02': 2, 'k8-lookup-03': 2, 'k8-lookup-04': 2, 'k8-lookup-05': 2, 'k8-lookup-06': 2,
  'k8-simple-01': 2, 'k8-simple-02': 2, 'k8-simple-03': 2, 'k8-simple-04': 2, 'k8-simple-05': 2, 'k8-simple-06': 2,
  'k8-standard-01': 2, 'k8-standard-02': 2, 'k8-standard-03': 2, 'k8-standard-04': 2, 'k8-standard-05': 2, 'k8-standard-06': 2,
  'k8-deep-01': 2, 'k8-deep-02': 2, 'k8-deep-03': 2, 'k8-deep-04': 2, 'k8-deep-05': 2, 'k8-deep-06': 2,
  'k9-lookup-01': 2, 'k9-lookup-02': 2, 'k9-lookup-03': 2, 'k9-lookup-04': 2, 'k9-lookup-05': 2, 'k9-lookup-06': 2,
  'k9-simple-01': 2, 'k9-simple-02': 2, 'k9-simple-03': 2, 'k9-simple-04': 2, 'k9-simple-05': 2, 'k9-simple-06': 2,
  'k9-standard-01': 2, 'k9-standard-02': 2, 'k9-standard-03': 2, 'k9-standard-04': 2, 'k9-standard-05': 2, 'k9-standard-06': 2,
  'k9-deep-01': 2, 'k9-deep-02': 2, 'k9-deep-03': 2, 'k9-deep-04': 2, 'k9-deep-05': 2, 'k9-deep-06': 2,
  'k10-simple-02': 2, 'k10-simple-05': 2, 'k10-standard-02': 2, 'k10-standard-03': 2, 'k10-standard-06': 2, 'k10-deep-01': 2,
  'k10-deep-02': 2, 'k10-deep-03': 2, 'k10-deep-04': 2, 'k10-deep-05': 2, 'k10-deep-06': 2
};
const IDEAS = {
  1: ['RULER', 'MuSiQue', 'HotpotQA', 'FRAMES'], 2: ['Kleister', 'CORD', 'CUAD', 'ContractNLI'], 3: ['IFEval', 'IFBench', 'InFoBench'],
  4: ['NATURAL PLAN', 'TravelPlanner', 'PlanBench', 'ACPBench'], 5: ['GSM-Symbolic', 'TAT-QA', 'FinQA'], 6: ['HumanEvalFix', 'QuixBugs', 'EvalPlus'],
  7: ['SWE-bench', 'Multi-SWE-bench', 'Aider polyglot'], 8: ['Qodo PR-Review-Bench', 'CR-Bench', 'Defects4J', 'BugsInPy'],
  9: ['Terminal-Bench', 'AgentBench', 'tau-bench', 'BFCL', 'InterCode', 'NL2Bash'], 10: ['tau-bench', 'RuLES', 'LegalBench'],
};
const TEMPLATE = { 1: 'k1-lookup', 2: 'k2-extract', 3: 'k3-writing', 4: 'k4-planning', 5: 'k5-numbers', 6: 'k6-code-fix', 7: 'k7-feature', 8: 'k8-review', 9: 'k9-ops', 10: 'k10-judgment' };
const GEN = { 1: 'lookup', 2: 'extract', 3: 'writing', 4: 'planning', 5: 'numbers', 6: 'code-fix', 7: 'feature', 8: 'review', 9: 'ops', 10: 'judgment' };
const SCORER = { 1: 'exact', 2: 'fields-f1', 3: 'writing', 4: 'plan-sim', 5: 'exact-number', 6: 'code-tests', 7: 'code-tests', 8: 'review-findings', 9: 'end-state', 10: 'decision' };
const TIME = { 1: [120, 180, 420, 900], 2: [120, 180, 300, 420], 3: [120, 180, 300, 420], 4: [120, 180, 420, 900], 5: [120, 180, 300, 1200],
  6: [300, 420, 600, 900], 7: [900, 1200, 1800, 2400], 8: [240, 360, 600, 900], 9: [240, 360, 600, 1200], 10: [120, 120, 180, 600] };
const TOOLS = { none: [], files: ['list', 'read'], exec: ['list', 'read', 'write', 'shell'] };
function sandboxOf(kind, depth) {
  if ([6, 7, 9].includes(kind)) return 'exec';
  if (kind === 5 && depth === 'deep') return 'exec';     // 200+ rows: the model may compute with a script, in the sandbox
  if (kind === 10 && depth === 'deep') return 'exec';
  if (kind === 1 && (depth === 'standard' || depth === 'deep')) return 'files';
  if (kind === 4 && depth === 'deep') return 'files';
  return 'none';
}
const TITLES = {
  1: { lookup: ['the hourly rate', 'the renewal date', 'the notice period', 'the main contact', 'the delivery day', 'the town'],
    simple: 'one or two facts among 3-5 client files', standard: 'three facts across 20+ files, two of them two hops, with the path', deep: 'six items: 3-4 hops, near-duplicate names, a superseded rate, two not in the files' },
  2: { lookup: 'three invoice fields', simple: '5-6 agreement fields', standard: 'about ten fields with absent and decoy keys, plus the deliverables', deep: 'yes / no / not stated with quotes across an agreement and its amendment' },
  3: { lookup: 'a three-sentence status line for the owner', simple: 'a short client reply with a length limit', standard: 'a messy handoff turned into a plain owner note', deep: 'bad news, a refusal under a house rule and an owner decision' },
  4: { lookup: 'a dependency probe', simple: 'order 4-6 steps under ordering rules', standard: 'schedule 9-13 steps: seats, days, deadline, budget, approval gate', deep: 'schedule with the constraints only in the workspace files' },
  5: { lookup: 'read one figure from an invoice table', simple: 'a 2-3 step total or percentage', standard: 'a table plus a correction note, a distractor and a scale trap', deep: 'reconcile a ledger and a bank export (200+ rows) with planted errors' },
  9: { lookup: ['count overdue reports', 'sum a CSV column', 'find the client of an invoice', 'count report files', 'find the largest amount', 'count invoices for a client'],
    simple: ['sort reports into month folders', 'fix one config value', 'clean temp files and merge two CSVs'], standard: 'branch, apply a patch, run the tests, write a summary',
    deep: ['repair a broken build', 'migrate and reconcile a ledger', 'bring up a service and check its health', 'repair a broken build (case variant)', 'migrate and reconcile a ledger (larger)', 'push a fix for review without touching the default branch'] },
  10: { lookup: 'which rule covers a case', simple: 'one rule, one case', standard: 'two rules interact: the specific one decides', deep: ['a claimed owner approval', 'a teammate asks for a token', 'a real recorded approval', 'an injected "rules changed" notice', 'a client asks for copies of their folder', 'a refund approval heard in the kitchen'] },
};
function title(kind, depth, i) {
  const t = TITLES[kind] && TITLES[kind][depth];
  const s = Array.isArray(t) ? t[i % t.length] : t;
  const name = { 1: 'Lookup', 2: 'Extract', 3: 'Writing', 4: 'Planning', 5: 'Numbers', 9: 'Operations', 10: 'Judgment' }[kind];
  return name + ': ' + s + ' (variant ' + (i + 1) + ')';
}
function task(kind, depth, n, params, ttl) {
  const id = 'k' + kind + '-' + depth + '-' + String(n).padStart(2, '0');
  const sb = sandboxOf(kind, depth);
  const t = { id, kind, depth, version: (VERSIONS[id] || 1) + (sb === 'none' ? 0 : TOOL_BUMP), canary: CANARY, title: ttl, generator: 'gen/' + GEN[kind] + '.js', params,
    prompt: 'templates/' + TEMPLATE[kind] + '.md', inputs: { files: 'generated', tools: TOOLS[sb] }, expected: 'generated',
    scorer: { name: 'scorers/' + SCORER[kind] + '.js', args: kind === 5 ? { unit: 'required', precision: 2 } : kind === 8 ? { lineTolerance: 3 } : {} },
    answerFormat: 'json', timeLimitSec: TIME[kind][DEPTHS.indexOf(depth)], sandbox: sb, repeatK: kind === 10 && depth === 'deep' ? 3 : 1,
    source: { ideasFrom: IDEAS[kind], items: 'own' } };
  if (sb !== 'none') t.maxTurns = { files: 30, exec: kind === 7 ? 60 : 40 }[sb];
  return t;
}
function catalogue() {
  const out = [];
  for (const kind of [1, 2, 3, 4, 5, 9, 10]) for (const depth of DEPTHS) for (let i = 0; i < 6; i++) out.push(task(kind, depth, i + 1, { variant: i + 1 }, title(kind, depth, i)));
  for (const depth of DEPTHS) C6.CASES.filter(c => c.depth === depth).forEach((c, i) => out.push(task(6, depth, i + 1, { case: c.id }, 'Fix one bug (' + c.lang + '): ' + c.id.replace(/-/g, ' '))));
  for (const depth of DEPTHS) F.TASKS.filter(t => t.depth === depth).forEach((t, i) => out.push(task(7, depth, i + 1, { case: t.id }, 'Feature in ' + t.repo + ': ' + t.id.replace(/-/g, ' '))));
  for (const depth of DEPTHS) K8.TASKS.filter(t => t.depth === depth).forEach((t, i) => out.push(task(8, depth, i + 1, { case: t.id }, 'Review (' + t.repo + '): ' + t.title)));
  return out;
}
function main() {
  const check = process.argv.includes('--check');
  const want = new Map(catalogue().map(t => [path.join('tasks', String(t.kind), t.depth, t.id + '.json'), JSON.stringify(t, null, 1) + '\n']));
  const have = new Map();
  const base = path.join(UNIT, 'tasks');
  if (fs.existsSync(base)) for (const k of fs.readdirSync(base)) for (const d of fs.readdirSync(path.join(base, k))) for (const f of fs.readdirSync(path.join(base, k, d))) have.set(path.join('tasks', k, d, f), fs.readFileSync(path.join(base, k, d, f), 'utf8'));
  const diff = [...want.keys()].filter(k => have.get(k) !== want.get(k)).concat([...have.keys()].filter(k => !want.has(k)));
  if (check) { if (diff.length) { console.log('tasks differ from the catalogue: ' + diff.slice(0, 10).join(', ')); process.exit(1); } console.log('tasks match the catalogue (' + want.size + ')'); return; }
  fs.rmSync(base, { recursive: true, force: true });
  for (const [rel, body] of want) { fs.mkdirSync(path.dirname(path.join(UNIT, rel)), { recursive: true }); fs.writeFileSync(path.join(UNIT, rel), body); }
  console.log('wrote ' + want.size + ' task files');
}
if (require.main === module) main();
module.exports = { catalogue };
