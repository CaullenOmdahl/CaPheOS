#!/usr/bin/env node
'use strict';
/* Conformance for the model-bench unit. Offline: no model is called, no network. Exit 0 conformant, 1 not, 2 the test
 * itself could not run.
 *   1. the manifest and its files check out (company/tools/lib/units.js), the plugin registers the skill;
 *   2. every task file validates, the counts per kind and depth are the spec's, the files match dev/make-tasks.js;
 *   3. every generator gives the same output from the same seed;
 *   4. every scorer passes its oracle answer and fails its known-bad answer: every task runs end to end through the
 *      runner with a stub model (the oracle, then the known-bad answer; generated kinds on two seeds), exec tasks with our
 *      own oracle actions in the trusted engine; an unparseable answer counts as an outright failure;
 *   4b. the expected answer follows from the generated files (conformance/derive.js: kinds 1, 2, 3, 5 and 9 re-derived by
 *      code written apart from the generators), so a generator whose files and expected value disagree is caught;
 *   5. every kind 6, 7 and 8 planted bug fails its test with the bug in place and passes without it;
 *   5b. a symlink planted in the workspace never carries a host-side write, read or hidden test outside it;
 *   6. a sandboxed task is refused, never run, when there is no sandbox engine;
 *   7. check-deployment-leaks finds nothing in the unit or in generated task text, and no task names a real company,
 *      person or product (conformance/real-names.txt); every task, template and fixture text file carries the canary.
 * A toolchain that is not installed (dart, python3) is reported, and the tasks that need it are not verified here.
 * Env: MODEL_BENCH_QUICK=1 skips step 4's second seed. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const UNIT = path.join(__dirname, '..');

function rootDir() {
  if (process.env.CAPHEOS_ROOT) return path.resolve(process.env.CAPHEOS_ROOT);
  // packs/model-bench -> the repo; company/state/units/model-bench/<v> -> the company root
  const up = path.resolve(UNIT, '..', '..');
  if (fs.existsSync(path.join(up, 'company'))) return up;
  return path.resolve(UNIT, '..', '..', '..', '..', '..');
}
const has = bin => spawnSync('bash', ['-c', 'command -v ' + bin], { stdio: 'ignore' }).status === 0;

(async () => {
  const B = require('../lib/bench');
  const S = require('../lib/sandbox');
  const W = require('../lib/world');
  const C6 = require('../gen/code-fix');
  const F = require('../gen/feature');
  const R = require('../gen/review');
  const K8 = require('../fixtures/k8/tasks');
  const WR = require('../gen/writing');
  const problems = [], notes = [];
  const root = rootDir();
  const work = path.join(root, 'company', 'work', 'units', 'model-bench', 'sandbox');
  const tc = { dart: !!S.dartBin(), python3: has('python3'), git: has('git') };
  const skipLang = l => (l === 'dart' && !tc.dart) || (l === 'py' && !tc.python3);
  const repoLang = { 'node-svc': 'js', 'ts-web': 'ts', 'py-pkg': 'py', 'dart-pkg': 'dart' };
  const skipTask = t => (t.kind === 6 && skipLang(C6.CASES.find(c => c.id === t.params.case).lang)) ||
    (t.kind === 7 && skipLang(repoLang[F.TASKS.find(x => x.id === t.params.case).repo])) ||
    (t.kind === 8 && skipLang(repoLang[K8.TASKS.find(x => x.id === t.params.case).repo])) || (t.kind === 9 && !tc.git);
  for (const [k, v] of Object.entries(tc)) if (!v) notes.push(k + ' is not installed: the tasks that need it are not verified here');

  // 1. manifest and plugin
  let U = null; try { U = require(path.join(UNIT, '..', '..', 'company', 'tools', 'lib', 'units.js')); } catch (_) {}
  if (U) problems.push(...U.check(UNIT).findings);
  const mod = await import(require('url').pathToFileURL(path.join(UNIT, 'host', 'index.js')).href);
  const got = []; mod.apply({ skills: { registerProvider: make => got.push(make()) } });
  if (got.length !== 1) problems.push('the plugin must register one skill provider');
  else { const l = await got[0].list(); if (l.length !== 1 || l[0].name !== 'model-bench') problems.push('the provider must list exactly model-bench'); else { const s = await got[0].get(l[0]); if (!/^---\nname: model-bench\n/.test(s.content)) problems.push('the skill text is not the shipped SKILL.md'); } }
  const lim = JSON.parse(fs.readFileSync(path.join(UNIT, 'limits', 'bench.json'), 'utf8'));
  for (const [k, v] of Object.entries(lim)) if (!k.startsWith('_') && v !== 0) problems.push('limits/bench.json must ship closed: ' + k + ' is ' + v);

  // 2. task files
  let tasks = [];
  try { tasks = B.loadTasks(UNIT); } catch (e) { problems.push(...(e.problems || [e.message])); }
  const want = { 7: { lookup: 6, simple: 6, standard: 5, deep: 4 } };
  for (let k = 1; k <= 10; k++) for (const d of ['lookup', 'simple', 'standard', 'deep']) {
    const n = tasks.filter(t => t.kind === k && t.depth === d).length, w = (want[k] && want[k][d]) || 6;
    if (n !== w) problems.push('kind ' + k + ' ' + d + ': ' + n + ' tasks, the spec says ' + w);
  }
  if (tasks.length !== 237) problems.push(tasks.length + ' tasks in all, the spec says 237');
  const mk = spawnSync(process.execPath, [path.join(UNIT, 'dev', 'make-tasks.js'), '--check'], { encoding: 'utf8' });
  if (mk.status !== 0) problems.push('task files: ' + (mk.stdout || mk.stderr).trim());

  // 3. deterministic generators
  const strip = inst => JSON.stringify(inst);
  for (const t of tasks) for (const seed of [0, 1]) {
    try { if (strip(B.instantiate(UNIT, t, seed)) !== strip(B.instantiate(UNIT, t, seed))) problems.push(t.id + ': the generator is not deterministic for seed ' + seed); }
    catch (e) { problems.push(t.id + ': the generator failed: ' + e.message); }
  }

  // 4. every task end to end with a stub model: the oracle passes, the known-bad answer fails, garbage is unparseable
  fs.mkdirSync(work, { recursive: true });
  const genKinds = [1, 2, 3, 4, 5, 9, 10], codeKinds = [6, 7, 8];
  const live = tasks.filter(t => !skipTask(t));
  const skipped = tasks.length - live.length; if (skipped) notes.push(skipped + ' task(s) not run here for a missing toolchain');
  const runAll = async (mode, kinds, repeat) => {
    const bad = [];
    const r = await B.run({ unitDir: UNIT, root, model: 'stub/' + mode, driver: B.stubDriver(mode), allowTrusted: true, kinds, repeat,
      judgeFor: inst => WR.stubJudge(inst.expected), only: live,
      onInstance: rec => { if (skipTask(tasks.find(t => t.id === rec.task))) return; const ok = mode === 'oracle' ? rec.pass : !rec.pass; if (!ok) bad.push(rec.task + ' (seed ' + rec.seed + '): ' + (rec.failure || '') + ' ' + String(rec.detail || '').slice(0, 200)); } });
    return { bad, result: r.result, records: r.records };
  };
  for (const mode of ['oracle', 'bad']) {
    const a = await runAll(mode, genKinds, process.env.MODEL_BENCH_QUICK ? 1 : 2), b = await runAll(mode, codeKinds, 1);
    for (const x of a.bad.concat(b.bad)) problems.push((mode === 'oracle' ? 'the oracle answer fails: ' : 'the known-bad answer passes: ') + x);
    if (mode === 'oracle') {
      const res = a.result;
      if (res.schema !== 'model-bench/1' || !res.kinds['1'] || !res.kinds['1'].levels.lookup || res.kinds['1'].levels.lookup.taskVersions['k1-lookup-01'] !== 1) problems.push('the result does not follow the output contract');
    }
  }
  const garbage = await B.run({ unitDir: UNIT, root, model: 'stub/garbage', driver: B.stubDriver('garbage'), allowTrusted: true, kinds: [2], depth: 'lookup' });
  if (!garbage.records.every(r => r.failure === 'unparseable' && !r.pass)) problems.push('an answer without a json block must count as unparseable');

  // 4b. the expected answers follow from the files the model is given (re-derived apart from the generators, on 4 seeds)
  for (const x of await require('./derive').derive(UNIT, tasks, [0, 1, 2, 3])) problems.push('expected does not match the files: ' + x);

  // 5. planted bugs: each fails its test with the bug in place and passes without it
  const exec = async (files, cmds, setup) => {
    const sb = S.makeInstance(root, 'conformance-' + process.pid, 'x' + Math.random().toString(16).slice(2, 10));
    try { S.writeFiles(sb.work, files); if (setup) await S.exec(sb, setup, { engine: 'trusted', timeoutSec: 120 }); for (const c of cmds) { const r = await S.exec(sb, c, { engine: 'trusted', timeoutSec: 120 }); if (r.code !== 0) return false; } return true; }
    finally { S.removeInstance(sb); }
  };
  for (const c of C6.CASES) {
    if (skipLang(c.lang)) continue;
    const inst = C6.generate(null, { case: c.id });
    const withBug = Object.assign({}, inst.files, inst.expected.hidden);
    const fixed = Object.assign({}, withBug, { [c.file]: c.fixed });
    if (await exec(withBug, inst.expected.testCmds)) problems.push('k6 ' + c.id + ': the hidden tests pass with the bug in place');
    if (!(await exec(fixed, inst.expected.testCmds))) problems.push('k6 ' + c.id + ': the hidden tests fail on the fixed code');
  }
  for (const t of F.TASKS) {
    if (skipLang(repoLang[t.repo])) continue;
    const inst = F.generate(null, { case: t.id }, { unitDir: UNIT });
    if (await exec(Object.assign({}, inst.files, inst.expected.hidden), inst.expected.testCmds, inst.setupCmd)) problems.push('k7 ' + t.id + ': the hidden tests pass before the feature exists');
    if (!(await exec(inst.files, inst.expected.suiteCmds.concat(inst.expected.lintCmds), inst.setupCmd))) problems.push('k7 ' + t.id + ': the base repo\'s suite or lint fails');
  }
  for (const spec of K8.TASKS) {
    if (skipLang(repoLang[spec.repo])) continue;
    const setup = F.REPOS[spec.repo].setup;
    const confirm = async (b, c) => c.rule ? R.ruleOk(c.rule, c.file, b.base, b.after) : exec(Object.assign({}, b.after, c.files), [c.cmd], setup);
    const clean = R.build(UNIT, spec, () => false);
    for (const c of clean.confirms) if (!(await confirm(clean, c))) problems.push('k8 ' + spec.id + ': part ' + c.part + ' fails its test without the planted defect');
    for (const c of clean.confirms.filter(x => x.defect)) {
      const one = R.build(UNIT, spec, i => i === c.part);
      if (await confirm(one, one.confirms.find(x => x.part === c.part))) problems.push('k8 ' + spec.id + ': the planted defect in part ' + c.part + ' passes its test');
    }
  }

  // 5b. a symlink the model plants never carries a host-side write, read or hidden test outside the workspace
  {
    const sb = S.makeInstance(root, 'conformance-' + process.pid, 'symlink'), out = path.join(sb.dir, 'outside');
    try {
      fs.mkdirSync(out, { recursive: true }); fs.symlinkSync(out, path.join(sb.work, 'esc')); fs.writeFileSync(path.join(out, 'f'), 'host');
      fs.symlinkSync(path.join(out, 'f'), path.join(sb.work, 'lnk'));
      const before = S.tree(sb.work);
      const C = require('../lib/checks');
      if (S.safeWrite(sb.work, 'esc/sub/x', 'a') || S.safeWrite(sb.work, 'lnk', 'a') || S.safeRead(sb.work, 'lnk', 'utf8') !== null || S.inside(sb.work, '../x')) problems.push('a host-side file tool follows a planted symlink or a .. path');
      let threw = false; try { C.place({ work: sb.work }, { 'esc/hidden.test.js': 'x' }); } catch (_) { threw = true; }
      if (!threw || fs.existsSync(path.join(out, 'hidden.test.js')) || fs.existsSync(path.join(out, 'sub'))) problems.push('a hidden test was written through a planted symlink');
      if (fs.readFileSync(path.join(out, 'f'), 'utf8') !== 'host') problems.push('a file outside the workspace was changed through a symlink');
      if (!before.esc || !String(before.esc).startsWith('symlink:')) problems.push('the scope check does not see symlinks');
    } finally { S.removeInstance(sb); }
  }

  // 6. no sandbox engine: a sandboxed task is refused, never run
  const ref = await B.run({ unitDir: UNIT, root, model: 'stub/oracle', driver: B.stubDriver('oracle'), kinds: [9], depth: 'lookup', config: { sandbox: { engine: 'none-refuse' } } });
  const L9 = ref.result.kinds['9'].levels.lookup;
  if (!ref.records.every(r => r.failure === 'sandbox') || L9.passRate !== null || !L9.notProvenReason) problems.push('a sandboxed task must be refused, recorded as not proven, when there is no sandbox engine');
  // gating: a subscription model is refused while the limits are closed; a paid model without a money cap too
  if (B.gate('claude-cli/some-model', UNIT, root).ok) problems.push('a subscription model must be refused with the limits closed');
  if (B.gate('deepseek/some-model', UNIT, root).ok) problems.push('a paid model must be refused without a money cap');
  if (!B.gate('stub/oracle', UNIT, root).ok || !B.gate('openrouter/some-model:free', UNIT, root).ok) problems.push('stub and free models must be allowed');

  // 7. words: the leak check, the real-name list, the canary
  const texts = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!['node_modules', '.dart_tool', '__pycache__'].includes(e.name)) walk(p); } else texts.push({ file: path.relative(UNIT, p), text: fs.readFileSync(p, 'utf8') }); } };
  walk(UNIT);
  const generated = [];
  for (const t of tasks) { const inst = B.instantiate(UNIT, t, 0); generated.push({ file: t.id + ' (seed 0)', text: inst.prompt + '\n' + Object.values(inst.files).map(v => typeof v === 'string' ? v : v.text).join('\n') }); }
  try {
    const L = require(path.join(UNIT, '..', '..', 'scripts', 'check-deployment-leaks.js'));
    const Wd = L.words(); const re = L.matcher(Wd.words);
    if (re) { const items = []; for (const x of texts.concat(generated)) x.text.split('\n').forEach((t, i) => items.push({ file: x.file, line: i + 1, text: t })); for (const h of L.scanLines(items, re, Wd.words)) problems.push('deployment leak: ' + h.file + ':' + h.line + ' carries a ' + h.kind); }
  } catch (_) { notes.push('scripts/check-deployment-leaks.js is not beside this unit: the leak check ran only where it is'); }
  const names = fs.readFileSync(path.join(__dirname, 'real-names.txt'), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const nameRe = new RegExp('(?<![A-Za-z0-9])(' + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![A-Za-z0-9])');
  const taskFacing = texts.filter(x => /^(tasks|templates|fixtures|judge|gen)\//.test(x.file)).concat(generated);
  for (const x of taskFacing) { const m = nameRe.exec(x.text); if (m) problems.push('a real name in task content: ' + x.file + ' names ' + m[1]); }
  for (const x of texts) if (/^(tasks|templates|judge)\//.test(x.file) || (/^fixtures\//.test(x.file) && /\.(md|js|ts|mjs|py|dart)$/.test(x.file) && !/__init__\.py$/.test(x.file) && x.text.length > 200)) if (!x.text.includes(W.CANARY)) problems.push(x.file + ' does not carry the canary');

  fs.rmSync(path.join(work, 'conformance-' + process.pid), { recursive: true, force: true });
  for (const n of notes) console.log('note: ' + n);
  if (problems.length) { console.log('NOT CONFORMANT (' + problems.length + ')\n- ' + problems.slice(0, 60).join('\n- ')); process.exit(1); }
  console.log('model-bench: conformant (' + tasks.length + ' tasks, ' + live.length + ' run end to end, ' + C6.CASES.length + ' kind 6 bugs, ' + F.TASKS.length + ' kind 7 features, ' + K8.TASKS.length + ' kind 8 reviews checked)');
  process.exit(0);
})().catch(e => { console.log('conformance test broken: ' + (e.stack || e.message)); process.exit(2); });
