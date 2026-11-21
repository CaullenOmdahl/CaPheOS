#!/usr/bin/env node
'use strict';
/* model-bench.js — the runner of the model bench unit (packs/model-bench, docs in its README): our own test of whether a
 * model can do our work, 10 kinds at four depths. It only measures: it never routes work or changes a model chain.
 *
 *   node company/tools/model-bench.js run --model <provider/model> [--kinds 1,5,10] [--depth lookup|simple|standard|deep]
 *                                          [--seed N] [--repeat N] [--dry-run] [--json] [--seat <id>]
 *   node company/tools/model-bench.js show <provider/model> [--json]
 *   node company/tools/model-bench.js list-tasks [--kinds 1,2] [--depth simple] [--json]
 *   node company/tools/model-bench.js --selftest
 *
 * The functions live in the unit (lib/bench.js): the installed copy company/state/units/model-bench/<version>/ when the
 * owner installed it, else the framework copy packs/model-bench/ (list-tasks, --dry-run and stub models only; a real model
 * runs only from the installed unit). Models are driven through the station's run API (talk only); the bench's own tools
 * act inside each task's sandbox (docker or bwrap; with neither, sandboxed tasks are refused). Stub models for tests:
 * stub/oracle, stub/bad, stub/garbage.
 * Gating (unit README "What does not run automatically"): free models run; paid-per-use models need an open money cap;
 * subscription models need room the owner opened (company/work/units/model-bench/limits/bench.json) and the pacer's yes.
 * Results: company/state/model-bench/<model>.json (replaced whole, the previous kept as .prev.json; locked-watch class A,
 * written only by this tool) and one line per run in company/state/model-bench/history.jsonl.
 * Exit: 0 done, 1 selftest failed, 2 usage, 3 refused (gating, no sandbox, unit not installed). Owner: the people function.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const co = require('./lib/company');

const FRAMEWORK_UNIT = path.join(__dirname, '..', '..', 'packs', 'model-bench');
function unitDir(root) {
  try {
    const U = require('./lib/units');
    const u = U.registry(root).units['model-bench'];
    if (u) { const d = U.installedDir('model-bench', u.version, root); if (fs.existsSync(path.join(d, 'lib', 'bench.js'))) return { dir: d, installed: true }; }
  } catch (_) {}
  return { dir: FRAMEWORK_UNIT, installed: false };
}
const bench = dir => require(path.join(dir, 'lib', 'bench.js'));
const stateDir = root => path.join(root, 'company', 'state', 'model-bench');

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) { const k = x.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) a[k] = true; else { a[k] = v; i++; } }
    else a._.push(x);
  }
  return a;
}
const kindsOf = s => (s && s !== true) ? String(s).split(',').map(Number).filter(n => n >= 1 && n <= 10) : undefined;

// the pacer's room on a subscription now (percent of this week's limit), or null when it cannot say
function pacerRoom(model, root) {
  const key = { 'claude-cli': 'claude', claude: 'claude', minimax: 'minimax' }[String(model).split('/')[0]];
  if (!key) return null;
  const r = spawnSync(process.execPath, [path.join(__dirname, 'pacer.js'), 'limits', '--json'], { cwd: root, encoding: 'utf8', timeout: 30000, env: Object.assign({}, process.env, { CAPHEOS_ROOT: root }) });
  try {
    const v = JSON.parse(r.stdout)[key];
    if (!v || typeof v.usedPct !== 'number') return null;
    const cap = Math.min(Number(v.weekStop) || 100, v.useNow == null ? 100 : Number(v.useNow));
    return cap - v.usedPct;
  } catch (_) { return null; }
}

function writeResult(root, res, line) {
  const dir = stateDir(root); fs.mkdirSync(dir, { recursive: true });
  const B = { slug: m => String(m).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) };
  const f = path.join(dir, B.slug(res.model) + '.json');
  if (fs.existsSync(f)) {
    const prev = f.replace(/\.json$/, '.prev.json'), old = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(prev, old);
    try { require('./provenance.js').wrote(prev, old, 'model-bench.js'); } catch (_) {}
  }
  const txt = JSON.stringify(res, null, 1) + '\n';
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, 'model-bench.js'); } catch (_) {}
  const h = path.join(dir, 'history.jsonl'), row = JSON.stringify(line) + '\n';
  fs.appendFileSync(h, row);
  try { require('./provenance.js').appended(h, row, 'model-bench.js'); } catch (_) {}
  return f;
}
function summaryLines(res) {
  const out = [res.model + ' (bench ' + res.benchVersion + ', seed ' + res.seed + ', ' + res.ranAt + ')'];
  for (const [k, v] of Object.entries(res.kinds)) {
    const lv = Object.entries(v.levels).map(([d, L]) => d + ' ' + (L.passRate == null ? 'not proven (' + L.notProvenReason + ')' : L.passed + '/' + L.instances)).join(', ');
    out.push('  kind ' + k + ': proven ' + (v.proven || 'none') + (v.gaps.length ? ' (gaps: ' + v.gaps.join(', ') + ')' : '') + ' | ' + lv);
  }
  return out;
}

async function cmd(argv, o) {
  o = o || {};
  const root = o.root || co.ROOT;
  const a = args(argv);
  const sub = a._[0];
  const U = o.unit || unitDir(root);
  if (sub === 'list-tasks') {
    const B = bench(U.dir);
    const ts = B.loadTasks(U.dir, { kinds: kindsOf(a.kinds), depth: a.depth === true ? undefined : a.depth });
    if (a.json) return { code: 0, out: ts.map(t => ({ id: t.id, kind: t.kind, depth: t.depth, version: t.version, sandbox: t.sandbox, title: t.title })) };
    return { code: 0, text: ts.map(t => t.id + '  v' + t.version + '  ' + t.sandbox.padEnd(5) + '  ' + t.title).join('\n') + '\n' + ts.length + ' task(s)' };
  }
  if (sub === 'show') {
    const model = a._[1]; if (!model) return { code: 2, out: { ok: false, error: 'usage: show <provider/model>' } };
    const f = path.join(stateDir(root), String(model).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) + '.json');
    let res; try { res = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { code: 1, out: { ok: false, error: 'no bench result for ' + model } }; }
    return a.json ? { code: 0, out: res } : { code: 0, text: summaryLines(res).join('\n') };
  }
  if (sub === 'run') {
    const model = a.model; if (!model || model === true || !/^[^/]+\/.+$/.test(model)) return { code: 2, out: { ok: false, error: '--model <provider/model> is required' } };
    const B = bench(U.dir);
    const depth = a.depth === true ? undefined : a.depth;
    if (depth && !['lookup', 'simple', 'standard', 'deep'].includes(depth)) return { code: 2, out: { ok: false, error: '--depth is one of lookup, simple, standard, deep' } };
    const common = { unitDir: U.dir, root, model, kinds: kindsOf(a.kinds), depth, seed: Number(a.seed) || 0, repeat: Number(a.repeat) || undefined, config: o.config,
      pacerRoom: o.pacerRoom || (m => pacerRoom(m, root)), fromDuty: !!a['from-duty'] };
    if (a['dry-run']) { const d = B.dryRun(common); return { code: 0, out: Object.assign({ ok: true, unit: U.installed ? 'installed' : 'framework copy' }, d) }; }
    const g = B.gate(model, U.dir, root, common);
    if (!g.ok) return { code: 3, out: { ok: false, refused: true, why: g.reason } };
    const stub = model.startsWith('stub/');
    if (!stub && !U.installed) return { code: 3, out: { ok: false, refused: true, why: 'the model-bench unit is not installed in this company (node company/tools/unit.js install packs/model-bench --by owner)' } };
    let driver, judgeDriver = null, judgeModel = null;
    if (stub) {
      const mode = model.split('/')[1]; if (!['oracle', 'bad', 'garbage'].includes(mode)) return { code: 2, out: { ok: false, error: 'stub models: stub/oracle, stub/bad, stub/garbage' } };
      driver = B.stubDriver(mode);
    } else {
      const seat = a.seat && a.seat !== true ? a.seat : (co.seatFor && co.seatFor('people'));
      if (!seat) return { code: 3, out: { ok: false, refused: true, why: 'no seat to run the bench on (--seat <id>)' } };
      const base = { seat, stationUrl: co.STATION_URL, token: co.stationToken() };
      driver = B.stationDriver(Object.assign({ model }, base));
      const cfg = B.config(U.dir, o.config);
      judgeModel = cfg.judge && cfg.judge.model;
      if (judgeModel) { const jg = B.gate(judgeModel, U.dir, root, common); if (jg.ok) judgeDriver = B.stationDriver(Object.assign({ model: judgeModel }, base)); }
    }
    const t0 = Date.now();
    const r = await B.run(Object.assign({}, common, { driver, judgeDriver, judgeModel, onInstance: o.onInstance }));
    const res = r.result;
    if (stub && !a.write) return { code: 0, out: res };
    const f = writeResult(root, res, { at: res.ranAt, model, seed: res.seed, benchVersion: res.benchVersion, complete: res.complete, minutes: Math.round((Date.now() - t0) / 600) / 100,
      proven: Object.fromEntries(Object.entries(res.kinds).map(([k, v]) => [k, v.proven])), instances: r.records.length, passed: r.records.filter(x => x.pass).length });
    return a.json ? { code: 0, out: res } : { code: 0, text: summaryLines(res).concat(['written: ' + path.relative(root, f)]).join('\n') };
  }
  return { code: 2, out: { ok: false, error: 'usage: model-bench.js run --model <provider/model> [--kinds] [--depth] [--seed] [--repeat] [--dry-run] | show <provider/model> | list-tasks | --selftest' } };
}

async function selftest() {
  let fails = 0;
  const t = (name, ok, extra) => { if (ok) console.log('  ok   ' + name); else { fails++; console.log('  FAIL ' + name + (extra ? ': ' + extra : '')); } };
  // a scratch company root under the unit's own work folder (never the system temp dir), removed at the end
  const root = path.join(co.ROOT, 'company', 'work', 'units', 'model-bench', 'selftest-' + process.pid);
  fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
  const unit = { dir: FRAMEWORK_UNIT, installed: false };
  try {
    let r = await cmd(['list-tasks', '--json'], { root, unit });
    t('list-tasks lists 237 tasks', r.code === 0 && r.out.length === 237, r.out && r.out.length);
    r = await cmd(['list-tasks', '--kinds', '7', '--depth', 'deep', '--json'], { root, unit });
    t('list-tasks filters by kind and depth', r.code === 0 && r.out.length === 4 && r.out.every(x => x.kind === 7 && x.depth === 'deep'));
    r = await cmd(['run'], { root, unit }); t('run without --model is a usage error', r.code === 2);
    r = await cmd(['run', '--model', 'stub/oracle', '--depth', 'medium'], { root, unit }); t('a bad --depth is a usage error', r.code === 2);
    r = await cmd(['run', '--model', 'stub/oracle', '--kinds', '1,5', '--dry-run'], { root, unit });
    t('--dry-run lists the instances and runs nothing', r.code === 0 && r.out.instances === 48 && r.out.tokensInEst > 0 && r.out.gate.ok && !fs.existsSync(path.join(root, 'company', 'state', 'model-bench')));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--dry-run'], { root, unit });
    t('--dry-run of a subscription model shows the refusal', r.code === 0 && r.out.cls === 'subscription' && !r.out.gate.ok);
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit });
    t('a subscription model is refused while the limits are closed', r.code === 3 && /has not let the bench use/.test(r.out.why), r.out && r.out.why);
    r = await cmd(['run', '--model', 'deepseek/some-model', '--kinds', '1'], { root, unit });
    t('a paid model is refused without a money cap', r.code === 3 && /money cap/.test(r.out.why), r.out && r.out.why);
    // the owner opens 2% of the week: the pacer decides
    const lim = path.join(root, 'company', 'work', 'units', 'model-bench', 'limits', 'bench.json');
    fs.mkdirSync(path.dirname(lim), { recursive: true }); fs.writeFileSync(lim, JSON.stringify({ subscriptionPctPerRun: 2, meteredUsdPerRun: 0 }));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit, pacerRoom: () => 1 });
    t('with room opened, the pacer having less room still refuses', r.code === 3 && /pacer has 1% room/.test(r.out.why), r.out && r.out.why);
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--dry-run'], { root, unit, pacerRoom: () => 10 });
    t('with room opened and free, the gate opens', r.code === 0 && r.out.gate.ok);
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--from-duty'], { root, unit, pacerRoom: () => 10 });
    t('a subscription model never starts from a duty', r.code === 3 && /duty/.test(r.out.why));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit, pacerRoom: () => 10 });
    t('a real model needs the installed unit', r.code === 3 && /not installed/.test(r.out.why), r.out && r.out.why);
    fs.rmSync(lim);
    // a stub run, written: the result, the previous copy, the history line, show
    r = await cmd(['run', '--model', 'stub/oracle', '--kinds', '1,2', '--depth', 'lookup', '--write'], { root, unit });
    const f = path.join(root, 'company', 'state', 'model-bench', 'stub_oracle.json');
    const res = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    t('a run writes the result contract', r.code === 0 && res && res.schema === 'model-bench/1' && res.kinds['1'].proven === 'lookup' && res.kinds['2'].levels.lookup.passRate === 1 && res.complete === false);
    await cmd(['run', '--model', 'stub/oracle', '--kinds', '1', '--depth', 'lookup', '--write', '--seed', '3'], { root, unit });
    const hist = fs.readFileSync(path.join(root, 'company', 'state', 'model-bench', 'history.jsonl'), 'utf8').trim().split('\n');
    t('a second run keeps the previous result and appends history', fs.existsSync(f.replace(/\.json$/, '.prev.json')) && hist.length === 2 && JSON.parse(hist[1]).seed === 3);
    r = await cmd(['show', 'stub/oracle'], { root, unit });
    t('show prints the proven depth per kind', r.code === 0 && /kind 1: proven lookup/.test(r.text), r.text);
    r = await cmd(['run', '--model', 'stub/bad', '--kinds', '4', '--depth', 'simple'], { root, unit });
    t('the known-bad stub proves nothing', r.code === 0 && r.out.kinds['4'].proven === null && r.out.kinds['4'].levels.simple.passed === 0);
    r = await cmd(['run', '--model', 'stub/garbage', '--kinds', '1', '--depth', 'lookup'], { root, unit });
    t('an answer without json counts as unparseable', r.code === 0 && r.out.kinds['1'].levels.lookup.failures.unparseable === 6);
    // kind 3 without a judge: layer 1 runs, the level is not proven (never failed)
    r = await cmd(['run', '--model', 'stub/oracle', '--kinds', '3', '--depth', 'lookup'], { root, unit });
    t('kind 3 without a judge is not proven, not failed', r.code === 0 && r.out.kinds['3'].levels.lookup.passRate === null && r.out.kinds['3'].levels.lookup.notProvenReason === 'judge-unset', JSON.stringify(r.out.kinds['3'] && r.out.kinds['3'].levels.lookup));
    // no sandbox engine: refused, not proven
    r = await cmd(['run', '--model', 'stub/oracle', '--kinds', '6', '--depth', 'lookup'], { root, unit, config: { sandbox: { engine: 'none-refuse' } } });
    t('with no sandbox, kind 6 is refused and not proven', r.code === 0 && r.out.kinds['6'].levels.lookup.passRate === null && r.out.kinds['6'].levels.lookup.failures.sandbox === 6);
    // the unit's own conformance test, offline (every scorer, generator and planted bug)
    const c = spawnSync(process.execPath, [path.join(FRAMEWORK_UNIT, 'conformance', 'test.js')], { encoding: 'utf8', timeout: 170000, env: Object.assign({}, process.env, { MODEL_BENCH_QUICK: '1', CAPHEOS_ROOT: root }) });
    t('the unit conformance test passes', c.status === 0, (c.stdout || c.stderr || '').trim().split('\n').slice(-8).join(' | '));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  console.log(fails ? 'model-bench selftest: ' + fails + ' failed' : 'model-bench selftest: all passed');
  return fails ? 1 : 0;
}

module.exports = { cmd, pacerRoom, unitDir };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
  else cmd(argv).then(r => {
    if (r.text !== undefined && !argv.includes('--json')) console.log(r.text);
    else console.log(JSON.stringify(r.out, null, 1));
    process.exit(r.code);
  }, e => { console.error('model-bench: ' + (e && e.message || e)); process.exit(2); });
}
