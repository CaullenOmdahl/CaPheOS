#!/usr/bin/env node
'use strict';
/* model-bench.js — the runner of the model bench unit (packs/model-bench, docs in its README): our own test of whether a
 * model can do our work, 10 kinds at four depths. It only measures: it never routes work or changes a model chain.
 *
 *   node company/tools/model-bench.js run --model <provider/model> [--kinds 1,5,10] [--depth lookup|simple|standard|deep]
 *                                          [--seed N] [--repeat N] [--dry-run] [--json] [--seat <id>]
 *   node company/tools/model-bench.js show <provider/model> [--json]
 *   node company/tools/model-bench.js list-tasks [--kinds 1,2] [--depth simple] [--json]
 *   node company/tools/model-bench.js limits [--json]                        what the owner has opened for the bench
 *   node company/tools/model-bench.js limits --by owner [--subscription-pct N] [--metered-usd N] [--judge provider/model|none]   the owner opens room / sets the writing judge
 *   node company/tools/model-bench.js --selftest
 *
 * The functions live in the unit (lib/bench.js): the installed copy company/state/units/model-bench/<version>/ when the
 * owner installed it, else the framework copy packs/model-bench/ (list-tasks, --dry-run and stub models only; a real model
 * runs only from the installed unit). Models are driven through the station's run API (talk only); the bench's own tools
 * act inside each task's sandbox (docker or bwrap; with neither, sandboxed tasks are refused). Stub models for tests:
 * stub/oracle, stub/bad, stub/garbage.
 * Gating (unit README "What does not run automatically"): free models run; paid-per-use models need an open money cap;
 * subscription models need room the owner opened and the pacer's yes. The owner's room lives in
 * company/state/model-bench/limits.json, written only by `limits --by owner` from the owner's own shell (or the console):
 * the gate trusts it only when its newest recorded write (provenance) matches the file and came from outside an agent's
 * run, from this tool or the console. A hand edit or a seat's write = nothing opened. The file is also locked-watched.
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

// the owner's room for the bench (spec section 8): trusted only as the owner's own recorded write (see the header)
const LIMITS_REL = 'company/state/model-bench/limits.json';
const LIMIT_KEYS = { 'subscription-pct': 'subscriptionPctPerRun', 'metered-usd': 'meteredUsdPerRun' };
const OWNER_WRITERS = ['company/tools/model-bench.js', 'console/server.js'];
const shaOf = t => 'sha256:' + require('crypto').createHash('sha256').update(t).digest('hex');
function ownerLimits(root) {
  const f = path.join(root, LIMITS_REL);
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return { limits: null, why: 'nothing opened' }; }
  let rec = null;
  try { for (const r of require('./lib/owner-channel')._lib.provRows(root, LIMITS_REL, true)) if (r.kind === 'write') rec = r; } catch (_) {}
  if (!rec) return { limits: null, why: 'the limits file has no recorded write, so it is not the owner\'s' };
  if (rec.sha256 !== shaOf(txt)) return { limits: null, why: 'the limits file was changed after the owner\'s recorded write' };
  if (rec.underStation !== false || rec.tainted === true) return { limits: null, why: 'the limits file was written from an agent\'s run, not by the owner' };
  if (!OWNER_WRITERS.includes(require('./lib/pm-inbox-guard').mainRel(rec.main))) return { limits: null, why: 'the limits file was not written by model-bench.js or the console' };
  try { const d = JSON.parse(txt); return { limits: d && typeof d === 'object' ? d : null, why: null }; } catch (_) { return { limits: null, why: 'the limits file is not valid json' }; }
}
function setLimits(root, a, o) {
  const O = require('./lib/owner');
  if (!O.isOwnerName(a.by, { aliases: ['commander'] })) return { code: 3, out: { ok: false, refused: true, why: 'only the owner opens room for the bench (--by owner)' } };
  const no = O.refusal(a.by, 'the bench limits', Object.assign({ aliases: ['commander'] }, o && typeof o.shell === 'function' ? { shell: o.shell } : {}));
  if (no) return { code: 3, out: { ok: false, refused: true, why: no } };
  const cur = Object.assign({ subscriptionPctPerRun: 0, meteredUsdPerRun: 0 }, ownerLimits(root).limits || {});
  let changed = 0;
  for (const [flag, key] of Object.entries(LIMIT_KEYS)) {
    if (a[flag] === undefined) continue;
    const n = Number(a[flag]);
    if (!Number.isFinite(n) || n < 0 || (key === 'subscriptionPctPerRun' && n > 100)) return { code: 2, out: { ok: false, error: '--' + flag + ' must be a number from 0' + (key === 'subscriptionPctPerRun' ? ' to 100' : '') } };
    cur[key] = n; changed++;
  }
  if (a.judge !== undefined) {   // the fixed judge for kind 3 (writing): one model, provider/model, or "none" to clear it
    const j = String(a.judge);
    if (j === 'none' || j === '') cur.judgeModel = null;
    else if (!/^[^/\s]+\/\S+$/.test(j)) return { code: 2, out: { ok: false, error: '--judge must be provider/model (or none)' } };
    else cur.judgeModel = j;
    changed++;
  }
  if (!changed) return { code: 2, out: { ok: false, error: 'say what to open: --subscription-pct N, --metered-usd N and/or --judge provider/model' } };
  const f = path.join(root, LIMITS_REL); fs.mkdirSync(path.dirname(f), { recursive: true });
  const txt = JSON.stringify(Object.assign({ _doc: 'The owner\'s room for the model bench (model-bench.js limits --by owner). A hand edit opens nothing.' }, cur, { at: new Date().toISOString() }), null, 1) + '\n';
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, 'model-bench.js', { root }); } catch (_) {}
  return { code: 0, out: Object.assign({ ok: true }, cur) };
}

// writer: the label provenance records (model-bench.js, or apprentice.js for the apprentice's bench result); both are
// the locked-watch writers of company/state/model-bench/
function writeResult(root, res, line, writer) {
  const W = writer || 'model-bench.js';
  const dir = stateDir(root); fs.mkdirSync(dir, { recursive: true });
  const B = { slug: m => String(m).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) };
  const f = path.join(dir, B.slug(res.model) + '.json');
  if (fs.existsSync(f)) {
    const prev = f.replace(/\.json$/, '.prev.json'), old = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(prev, old);
    try { require('./provenance.js').wrote(prev, old, W, { root }); } catch (_) {}
  }
  const txt = JSON.stringify(res, null, 1) + '\n';
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, W, { root }); } catch (_) {}
  const h = path.join(dir, 'history.jsonl'), row = JSON.stringify(line) + '\n';
  fs.appendFileSync(h, row);
  try { require('./provenance.js').appended(h, row, W, { root }); } catch (_) {}
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
  if (sub === 'limits') {
    if (a.by !== undefined) return setLimits(root, a, o);
    const L = ownerLimits(root), out = Object.assign({ subscriptionPctPerRun: 0, meteredUsdPerRun: 0 }, L.limits || {}, { trusted: !!L.limits, why: L.why });
    return a.json ? { code: 0, out } : { code: 0, text: 'subscription: ' + out.subscriptionPctPerRun + '% of the week per run; paid models: ' + out.meteredUsdPerRun + ' per run' + (L.why ? ' (' + L.why + ')' : '') };
  }
  if (sub === 'run') {
    const model = a.model; if (!model || model === true || !/^[^/]+\/.+$/.test(model)) return { code: 2, out: { ok: false, error: '--model <provider/model> is required' } };
    const B = bench(U.dir);
    const depth = a.depth === true ? undefined : a.depth;
    if (depth && !['lookup', 'simple', 'standard', 'deep'].includes(depth)) return { code: 2, out: { ok: false, error: '--depth is one of lookup, simple, standard, deep' } };
    const common = { unitDir: U.dir, root, model, kinds: kindsOf(a.kinds), depth, seed: Number(a.seed) || 0, repeat: Number(a.repeat) || undefined, config: o.config,
      pacerRoom: o.pacerRoom || (m => pacerRoom(m, root)), fromDuty: !!a['from-duty'], ownerLimits: ownerLimits(root).limits };
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
      const ol = ownerLimits(root).limits || {};   // the owner's judge (limits --judge) wins over the unit default
      const cfg = B.config(U.dir, ol.judgeModel ? Object.assign({}, o.config || {}, { judge: Object.assign({}, (o.config || {}).judge || {}, { model: ol.judgeModel }) }) : o.config);
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
  return { code: 2, out: { ok: false, error: 'usage: model-bench.js run --model <provider/model> [--kinds] [--depth] [--seed] [--repeat] [--dry-run] | show <provider/model> | list-tasks | limits [--by owner --subscription-pct N --metered-usd N --judge provider/model] | --selftest' } };
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
    // a seat cannot open it: a hand-written limits file (no recorded owner write) opens nothing, nor does --by a seat
    const lim = path.join(root, 'company', 'state', 'model-bench', 'limits.json');
    fs.mkdirSync(path.dirname(lim), { recursive: true }); fs.writeFileSync(lim, JSON.stringify({ subscriptionPctPerRun: 50, meteredUsdPerRun: 0 }));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit, pacerRoom: () => 90 });
    t('a hand-written limits file opens nothing', r.code === 3 && /has not let the bench use/.test(r.out.why), r.out && r.out.why);
    fs.rmSync(lim);
    r = await cmd(['limits', '--by', 'some-seat', '--subscription-pct', '50'], { root, unit });
    t('only the owner opens room', r.code === 3 && !fs.existsSync(lim), r.out && r.out.why);
    r = await cmd(['limits', '--by', 'owner', '--subscription-pct', '2'], { root, unit, shell: () => true });
    t('the owner opens room through the tool', r.code === 0 && fs.existsSync(lim), JSON.stringify(r.out));
    const lt = await cmd(['limits', '--json'], { root, unit });
    t('the owner\'s recorded write is trusted', lt.out.trusted === true && lt.out.subscriptionPctPerRun === 2, JSON.stringify(lt.out));
    r = await cmd(['limits', '--by', 'owner', '--judge', 'not-a-model'], { root, unit, shell: () => true });
    t('a judge that is not provider/model is refused', r.code === 2, JSON.stringify(r.out));
    r = await cmd(['limits', '--by', 'owner', '--judge', 'claude-cli/judge-model'], { root, unit, shell: () => true });
    const lj = await cmd(['limits', '--json'], { root, unit });
    t('the owner sets the writing judge, and the room already opened is kept', r.code === 0 && lj.out.judgeModel === 'claude-cli/judge-model' && lj.out.subscriptionPctPerRun === 2 && lj.out.trusted === true, JSON.stringify(lj.out));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit, pacerRoom: () => 1 });
    t('with room opened, the pacer having less room still refuses', r.code === 3 && /pacer has 1% room/.test(r.out.why), r.out && r.out.why);
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--dry-run'], { root, unit, pacerRoom: () => 10 });
    t('with room opened and free, the gate opens', r.code === 0 && r.out.gate.ok);
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--from-duty'], { root, unit, pacerRoom: () => 10 });
    t('a subscription model never starts from a duty', r.code === 3 && /duty/.test(r.out.why));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1'], { root, unit, pacerRoom: () => 10 });
    t('a real model needs the installed unit', r.code === 3 && /not installed/.test(r.out.why), r.out && r.out.why);
    // an edit after the owner's write is not trusted
    fs.writeFileSync(lim, fs.readFileSync(lim, 'utf8').replace('"subscriptionPctPerRun": 2', '"subscriptionPctPerRun": 60'));
    r = await cmd(['run', '--model', 'claude-cli/some-model', '--kinds', '1', '--dry-run'], { root, unit, pacerRoom: () => 90 });
    t('a seat\'s edit of the owner\'s limits opens nothing', r.code === 0 && !r.out.gate.ok && /has not let the bench use/.test(r.out.gate.reason), JSON.stringify(r.out.gate));
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

module.exports = { cmd, pacerRoom, unitDir, writeResult };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) selftest().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
  else cmd(argv).then(r => {
    if (r.text !== undefined && !argv.includes('--json')) console.log(r.text);
    else console.log(JSON.stringify(r.out, null, 1));
    process.exit(r.code);
  }, e => { console.error('model-bench: ' + (e && e.message || e)); process.exit(2); });
}
