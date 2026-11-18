#!/usr/bin/env node
/* decide.js — decision models: deterministic, versioned, logged, replayable rules that turn observed state into an action.
 *
 *   node company/tools/decide.js list [--json]                          every model: versions, active version, mode, params, log size
 *   node company/tools/decide.js show <id> [--version <v>]              the model as data, its sha, its validation
 *   node company/tools/decide.js eval <id> --input <file|json> [--version <v>] [--no-log]
 *   node company/tools/decide.js replay <id> --version <v> [--from <iso>] [--json]   re-run logged inputs through version v
 *   node company/tools/decide.js test <id> [--version <v>|--all]        company/decision-models/<id>/cases.json; exit 1 on a miss
 *   node company/tools/decide.js promote <id> <version> [--mode shadow|live] --by <owner>   owner-only; cases must pass
 *   node company/tools/decide.js set-param <id> <name> <value> --by <owner>                  owner-only (closed defaults)
 *   node company/tools/decide.js outcome <decisionId> --result good|bad --by <seat|owner> [--note "..."]   how a decision turned out
 *   node company/tools/decide.js join                                   record outcomes later records already answer (owner undo,
 *                                                                       ledger credit note/refund, breached commitment naming the decisionId)
 *   node company/tools/decide.js health [--id <model>] [--json]         per model+version: proceed decisions, good/bad, precision over
 *                                                                       the model's window; demotes a live version over its bad limit
 *   node company/tools/decide.js register                               write the locked-watch entries (company/state/locked-extra.json)
 *   node company/tools/decide.js selftest
 *
 * Library: company/tools/lib/decision.js. Models: company/decision-models/<id>/<version>.json (pure data, no code).
 * Inputs may carry provenance ({ value, source, ref }); a `safety` input counts only from one of its `sources`, never the actor.
 * Outcomes: company/work/decision-outcomes.jsonl. Log: company/work/decisions/<id>.jsonl. Promotions and params: company/state/decision-models.json (class A, writer
 * decide.js) + company/state/decision-models-log.jsonl + a line in company/work/decisions.md. Guide: docs/DECISION-MODELS.md.
 * Exit: 0 ok, 1 test miss / refused promotion, 2 usage or bad model, 3 not the owner.
 * Owner of this tool: the risk function; models' policy: the owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const dm = require('./lib/decision');

function parseInput(s) {
  if (s == null) throw new Error('--input <file|json> is required');
  const t = String(s).trim();
  if (t.startsWith('{')) return JSON.parse(t);
  return JSON.parse(fs.readFileSync(path.resolve(t), 'utf8'));
}

function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'decide-selftest-'));
  const prevProv = process.env.PROVENANCE_ROOT; process.env.PROVENANCE_ROOT = T;
  const prevAgent = process.env.DECIDE_ASSUME_AGENT; delete process.env.DECIDE_ASSUME_AGENT;
  const opts = { root: T };
  const out = []; let bad = 0;
  const t = (n, fn) => { try { fn(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + e.message); } };
  const mdir = path.join(T, 'company', 'decision-models', 'toy'); fs.mkdirSync(mdir, { recursive: true });
  const toy = v => ({ id: 'toy', version: String(v), mode: 'live', actions: ['yes', 'no'], inputs: { n: { type: 'number', required: true }, tag: { type: 'string' }, secret: { type: 'string', sensitive: true } },
    params: { limit: { type: 'number', default: 0 } },
    scoring: [{ id: 'tagged', when: { field: 'tag', op: 'exists' }, weight: 2 }],
    rules: v === 1 ? [{ id: 'under', when: { field: 'n', op: 'lt', param: 'limit' }, action: 'yes' }]
      : [{ id: 'under', when: { all: [{ field: 'n', op: 'lt', param: 'limit' }, { field: 'tag', op: 'regex', value: '^ok' }] }, action: 'yes' }, { id: 'scored', when: { field: '$score', op: 'gte', value: 2 }, action: 'yes' }],
    default: { action: 'no', why: 'closed' } });
  fs.writeFileSync(path.join(mdir, '1.json'), JSON.stringify(toy(1)));
  fs.writeFileSync(path.join(mdir, '2.json'), JSON.stringify(toy(2)));
  fs.writeFileSync(path.join(mdir, 'cases.json'), JSON.stringify({ cases: [{ input: { n: 1 }, expect: 'no' }, { input: { n: 1 }, params: { limit: 5 }, expect: 'yes' }] }));
  const logf = path.join(T, 'company', 'work', 'decisions', 'toy.jsonl');

  t('the shipped gate-triage model is valid and its cases pass', () => {
    const r = dm.test('gate-triage', opts); assert.ok(r.ok, JSON.stringify(r.results && r.results.filter(x => !x.pass)));
    assert.ok(r.cases >= 10);
  });
  t('unpromoted versions run in shadow even when they declare live; the highest version is active', () => {
    const r = dm.evaluate('toy', { n: 1 }, opts);
    assert.strictEqual(r.mode, 'shadow'); assert.strictEqual(r.model.version, '2'); assert.strictEqual(r.action, 'no'); assert.strictEqual(r.rule, '(default)');
    assert.ok(/^[0-9a-f]{12}$/.test(r.model.sha));
  });
  t('closed param default: n < 0 never passes; params override; scoring feeds $score', () => {
    assert.strictEqual(dm.evaluate('toy', { n: -1 }, Object.assign({ version: '1', log: false }, opts)).action, 'yes');
    assert.strictEqual(dm.evaluate('toy', { n: 3 }, Object.assign({ version: '1', log: false, params: { limit: 5 } }, opts)).action, 'yes');
    const s = dm.evaluate('toy', { n: 9, tag: 'x' }, Object.assign({ log: false }, opts)); assert.strictEqual(s.score, 2); assert.strictEqual(s.rule, 'scored');
  });
  t('missing or mistyped required input takes the default; unknown fields are ignored and reported', () => {
    const r = dm.evaluate('toy', { n: 'one', extra: 1 }, Object.assign({ log: false, params: { limit: 5 } }, opts));
    assert.strictEqual(r.rule, '(input-invalid)'); assert.strictEqual(r.action, 'no'); assert.deepStrictEqual(r.ignored, ['extra']);
  });
  t('every evaluation is logged with a digest; sensitive fields stay out of the log', () => {
    const before = dm.logRows('toy', opts).length;
    dm.evaluate('toy', { n: 1, secret: 'hunter2', tag: 'ok' }, opts);
    const rows = dm.logRows('toy', opts); assert.strictEqual(rows.length, before + 1);
    const last = rows[rows.length - 1]; assert.ok(last.inputDigest && last.output.action && last.params);
    assert.deepStrictEqual(last.redacted, ['secret']); assert.ok(!fs.readFileSync(logf, 'utf8').includes('hunter2'));
  });
  t('invalid models fail closed: action null with the reason', () => {
    const b = toy(3); b.rules[0].when = { field: 'n', op: 'eval', value: 'process.exit()' }; fs.writeFileSync(path.join(mdir, '3.json'), JSON.stringify(b));
    const r = dm.evaluate('toy', { n: 1 }, Object.assign({ version: '3', log: false }, opts)); assert.strictEqual(r.action, null); assert.ok(/op eval/.test(r.error));
    const c = toy(4); c.rules[0].when = { field: 'nope', op: 'eq', value: 1 }; c.rules[0].action = 'maybe'; fs.writeFileSync(path.join(mdir, '4.json'), JSON.stringify(c));
    const e = dm.load('toy', '4', opts).errors; assert.ok(e.some(x => /not a declared input/.test(x)) && e.some(x => /not in actions/.test(x)));
    assert.strictEqual(dm.evaluate('no-such-model', {}, opts).action, null);
    fs.unlinkSync(path.join(mdir, '3.json')); fs.unlinkSync(path.join(mdir, '4.json'));
  });
  t('replay: logged inputs through another version report agreements and disagreements', () => {
    fs.writeFileSync(logf, '');
    dm.evaluate('toy', { n: 1, tag: 'okay' }, Object.assign({ version: '2', params: { limit: 5 } }, opts));   // v2: yes (under)
    dm.evaluate('toy', { n: 9 }, Object.assign({ version: '2' }, opts));                                       // v2: no
    const r = dm.replay('toy', '1', opts);   // v1 with logged params: n=1<5 yes (agree), n=9<0 no (agree)
    assert.deepStrictEqual([r.rows, r.agree, r.disagree], [2, 2, 0]);
    dm.evaluate('toy', { n: 9, tag: 'z' }, Object.assign({ version: '2' }, opts));                             // v2: yes (scored); v1: no
    const r2 = dm.replay('toy', '1', opts); assert.strictEqual(r2.disagree, 1); assert.strictEqual(r2.disagreements[0].was.action, 'yes');
    assert.strictEqual(dm.replay('toy', '1', Object.assign({ from: new Date(Date.now() + 60000).toISOString() }, opts)).rows, 0);
  });
  t('test: cases pass on v1 and v2; a miss is reported', () => {
    assert.ok(dm.test('toy', Object.assign({ version: '1' }, opts)).ok);
    fs.writeFileSync(path.join(mdir, 'cases.json'), JSON.stringify({ cases: [{ input: { n: 1 }, expect: 'yes' }] }));
    const r = dm.test('toy', opts); assert.strictEqual(r.ok, false); assert.strictEqual(r.misses, 1);
  });
  t('promote: refused for an agent or a station run, and while cases miss', () => {
    assert.strictEqual(dm.promote('toy', '1', { by: 'Alex' }, opts).code, 3);
    process.env.DECIDE_ASSUME_AGENT = '1'; assert.strictEqual(dm.promote('toy', '1', { by: 'owner' }, opts).code, 3); delete process.env.DECIDE_ASSUME_AGENT;
    assert.strictEqual(dm.promote('toy', '1', { by: 'owner' }, opts).code, 1);
    assert.ok(!fs.existsSync(path.join(T, 'company', 'state', 'decision-models.json')));
  });
  t('promote by the owner: that version becomes active and live; logged; locked-watch entries registered', () => {
    fs.writeFileSync(path.join(mdir, 'cases.json'), JSON.stringify({ cases: [{ input: { n: 1 }, expect: 'no' }] }));
    const r = dm.promote('toy', '1', { by: 'owner', mode: 'live' }, opts); assert.ok(r.ok, r.error);
    const e = dm.evaluate('toy', { n: 1 }, Object.assign({ log: false }, opts)); assert.deepStrictEqual([e.model.version, e.mode], ['1', 'live']);
    assert.strictEqual(dm.evaluate('toy', { n: 1 }, Object.assign({ log: false, version: '2' }, opts)).mode, 'shadow');
    const f1 = path.join(mdir, '1.json'); const keep = fs.readFileSync(f1, 'utf8'); fs.writeFileSync(f1, keep + '\n');
    assert.strictEqual(dm.evaluate('toy', { n: 1 }, Object.assign({ log: false }, opts)).mode, 'shadow');   // edited after promotion
    fs.writeFileSync(f1, keep);
    assert.ok(/promoted decision model toy to v1 \(live\)/.test(fs.readFileSync(path.join(T, 'company', 'work', 'decisions.md'), 'utf8')));
    const le = JSON.parse(fs.readFileSync(path.join(T, 'company', 'state', 'locked-extra.json'), 'utf8'));
    assert.ok(le.entries.some(x => x.p === 'company/state/decision-models.json' && x.cls === 'A' && x.writers.includes('decide.js')));
    assert.ok(le.entries.every(x => typeof x.p === 'string' && ['A', 'F', 'R'].includes(x.cls) && x.owner && x.area && x.why));
  });
  t('register keeps other tools\' entries and is idempotent', () => {
    const f = path.join(T, 'company', 'state', 'locked-extra.json'); const le = JSON.parse(fs.readFileSync(f, 'utf8'));
    le.entries.push({ p: 'company/work/packs/x/l.jsonl', cls: 'A', writers: ['x.js'], owner: 'finance', area: 'record', why: 'x', pack: 'x' }); fs.writeFileSync(f, JSON.stringify(le));
    dm.register(opts); assert.ok(dm.register(opts).unchanged);
    const after = JSON.parse(fs.readFileSync(f, 'utf8')).entries; assert.ok(after.some(x => x.pack === 'x')); assert.strictEqual(after.filter(x => x.source === 'decide.js').length, dm.LOCKED.length);
  });
  t('set-param: owner only, typed, applies to evaluation, cases still see the closed default', () => {
    assert.strictEqual(dm.setParam('toy', 'limit', '5', { by: 'Sam' }, opts).code, 3);
    assert.strictEqual(dm.setParam('toy', 'limit', 'lots', { by: 'owner' }, opts).code, 2);
    assert.strictEqual(dm.setParam('toy', 'nope', '1', { by: 'owner' }, opts).code, 2);
    assert.ok(dm.setParam('toy', 'limit', '5', { by: 'owner' }, opts).ok);
    assert.strictEqual(dm.evaluate('toy', { n: 1 }, Object.assign({ log: false }, opts)).action, 'yes');
    assert.ok(dm.test('toy', opts).ok);
  });
  t('list shows both models with active version, mode and log size', () => {
    const l = dm.list(opts); const toyRow = l.find(x => x.id === 'toy');
    assert.ok(l.some(x => x.id === 'gate-triage'));
    assert.deepStrictEqual([toyRow.active, toyRow.mode, toyRow.params.limit], ['1', 'live', 5]); assert.ok(toyRow.evaluations >= 3);
  });
  t('provenance: a safety input counts only from an allowed source that is not the actor; the log keeps provenance and rejected claims', () => {
    const pdir = path.join(T, 'company', 'decision-models', 'prov'); fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, '1.json'), JSON.stringify({ id: 'prov', version: '1', mode: 'live', actions: ['go', 'wait'],
      inputs: { safe: { type: 'boolean', safety: true, sources: ['ledger', 'tool:*'] }, note: { type: 'string' } },
      rules: [{ id: 'safe', when: { field: 'safe', op: 'eq', value: true }, action: 'go' }], default: { action: 'wait' } }));
    const ev = (inp, actor) => dm.evaluate('prov', inp, Object.assign({ actor }, opts));
    assert.strictEqual(ev({ safe: true }).action, 'wait');                                         // plain value: no provenance
    assert.strictEqual(ev({ safe: { value: true, source: 'actor' } }).action, 'wait');
    assert.strictEqual(ev({ safe: { value: true, source: 'self' } }).action, 'wait');
    assert.strictEqual(ev({ safe: { value: true } }).action, 'wait');                              // missing source
    assert.strictEqual(ev({ safe: { value: true, source: 'owner' } }).action, 'wait');             // not on this input's list
    assert.strictEqual(ev({ safe: { value: true, source: 'sam' } }, 'Sam').action, 'wait');        // the actor by name
    assert.strictEqual(ev({ safe: { value: true, source: 'tool:sam' } }, 'sam').action, 'go');    // a tool named like the actor is still a tool
    const ok = ev({ safe: { value: true, source: 'ledger', ref: 'row-9' }, note: { value: 'hi', source: 'actor' } }, 'Sam');
    assert.strictEqual(ok.action, 'go');
    const rows = dm.logRows('prov', opts); const last = rows[rows.length - 1];
    assert.deepStrictEqual(last.provenance.safe, { source: 'ledger', ref: 'row-9' }); assert.strictEqual(last.actor, 'Sam'); assert.ok(/^d-[0-9a-f]{12}$/.test(last.decisionId));
    const rej = rows[1]; assert.strictEqual(rej.claimed.safe, true); assert.ok(/actor/.test(rej.provenance.safe.rejected));
    const bad = { id: 'prov', version: '2', mode: 'live', actions: ['go'], inputs: { safe: { type: 'boolean', safety: true, sources: ['actor'] } }, rules: [], default: { action: 'go' } };
    assert.ok(dm.validate(bad).some(e => /never the actor/.test(e)));
    const r = dm.replay('prov', '1', opts); assert.strictEqual(r.disagree, 0, JSON.stringify(r.disagreements));   // replay re-applies provenance
  });
  t('gate-triage v2: an actor-supplied reversible:true cannot make triage proceed; v1 stays replayable and its cases pass', () => {
    const vouched = { category: 'tools', recurring: { value: false, source: 'owner-table' }, seatHistoryOk: { value: true, source: 'competence' } };
    const run = rev => dm.evaluate('gate-triage', Object.assign({}, vouched, { reversible: rev }), Object.assign({ version: '2', log: false, actor: 'Sam' }, opts)).action;
    assert.strictEqual(run({ value: true, source: 'owner-table' }), 'proceed-notify');
    for (const rev of [true, { value: true, source: 'actor' }, { value: true, source: 'Sam' }, { value: true, source: 'agent' }, { value: true }]) assert.strictEqual(run(rev), 'escalate', JSON.stringify(rev));
    assert.ok(dm.test('gate-triage', Object.assign({ version: '1' }, opts)).ok); assert.ok(dm.test('gate-triage', Object.assign({ version: '2' }, opts)).ok);
    assert.ok(dm.replay('gate-triage', '1', opts).ok);
  });
  t('outcomes: manual and joined; health reports precision; any bad proceed outcome demotes a live version and tells the owner', () => {
    const odir = path.join(T, 'company', 'decision-models', 'outc'); fs.mkdirSync(odir, { recursive: true });
    const om = { id: 'outc', version: '1', mode: 'live', actions: ['go', 'wait'], inputs: { n: { type: 'number' } }, outcomes: { windowDays: 30 },
      rules: [{ id: 'small', when: { field: 'n', op: 'lt', value: 10 }, action: 'go' }], default: { action: 'wait' } };
    fs.writeFileSync(path.join(odir, '1.json'), JSON.stringify(om)); fs.writeFileSync(path.join(odir, 'cases.json'), JSON.stringify({ cases: [{ input: { n: 1 }, expect: 'go' }] }));
    assert.ok(dm.promote('outc', '1', { by: 'owner', mode: 'live' }, opts).ok);
    const a = dm.evaluate('outc', { n: 1 }, Object.assign({ actor: 'Sam' }, opts)); const b = dm.evaluate('outc', { n: 2 }, Object.assign({ actor: 'Sam' }, opts));
    dm.evaluate('outc', { n: 50 }, opts);
    assert.strictEqual(dm.outcome(a.decisionId, { result: 'good', by: 'Sam' }, opts).code, 3);                 // no grading your own act good
    assert.strictEqual(dm.outcome('d-000000000000', { result: 'good', by: 'Lee' }, opts).code, 2);
    assert.strictEqual(dm.outcome(a.decisionId, { result: 'meh', by: 'Lee' }, opts).code, 2);
    assert.ok(dm.outcome(a.decisionId, { result: 'good', by: 'Lee', note: 'fine' }, opts).ok);
    let h = dm.health(Object.assign({ id: 'outc' }, opts)).models[0];
    assert.deepStrictEqual([h.proceed, h.judged, h.good, h.bad, h.precision, h.live], [2, 1, 1, 0, 1, true]);
    fs.mkdirSync(path.join(T, 'company', 'work', 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'work', 'ledger', 'ledger.jsonl'), JSON.stringify({ seq: 1, type: 'credit-note', invoice: 'inv-1', amount: 5, reason: 'refund for ' + b.decisionId, by: 'Pat', hash: 'h1' }) + '\n');
    const H = dm.health(Object.assign({ id: 'outc', apply: true }, opts)); h = H.models[0];
    assert.strictEqual(H.joined, 1); assert.deepStrictEqual([h.bad, h.precision, h.demoted], [1, 0.5, true]);
    assert.strictEqual(dm.state(opts).models.outc.mode, 'shadow'); assert.strictEqual(dm.evaluate('outc', { n: 1 }, Object.assign({ log: false }, opts)).mode, 'shadow');
    assert.ok(/outc v1 is back in shadow mode/.test(fs.readFileSync(path.join(T, 'company', 'owner', 'digest.jsonl'), 'utf8')));   // an FYI (lib/owner-notice.js)
    assert.ok(/demoted decision model outc v1 from live to shadow/.test(fs.readFileSync(path.join(T, 'company', 'work', 'decisions.md'), 'utf8')));
    assert.strictEqual(dm.join(opts).recorded.length, 0);                                                     // idempotent
    fs.mkdirSync(path.join(T, 'company', 'work', 'commitments'), { recursive: true });
    fs.writeFileSync(path.join(T, 'company', 'work', 'commitments', 'c-1.json'), JSON.stringify({ id: 'c-1', state: 'breached', note: 'from ' + a.decisionId }));
    assert.strictEqual(dm.join(opts).recorded[0].source, 'commitment-breached');
  });
  if (prevProv === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prevProv;
  if (prevAgent !== undefined) process.env.DECIDE_ASSUME_AGENT = prevAgent;
  fs.rmSync(T, { recursive: true, force: true });
  for (const l of out) console.log(l);
  console.log(bad ? 'DECIDE SELFTEST FAILED: ' + bad : 'DECIDE SELFTEST PASSED: ' + out.length + ' cases');
  return bad ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const flag = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const BOOL = new Set(['--json', '--no-log', '--all']);
  const pos = a.slice(1).filter((x, i, arr) => !x.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--') && !BOOL.has(arr[i - 1])));
  const json = a.includes('--json');
  const done = (r, code) => { console.log(JSON.stringify(r, null, 1)); process.exit(code != null ? code : (r.ok === false ? (r.code || 2) : 0)); };
  if (cmd === 'selftest' || cmd === '--selftest') { try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}   // a selftest measures the mechanism in its own fixture tree, not the caller: an agent's run must not fail it
    process.exit(selftest()); }
  try {
    if (cmd === 'list') {
      const models = dm.list();
      if (json) done({ ok: true, models });
      if (!models.length) console.log('No decision models.');
      for (const m of models) console.log(m.id.padEnd(16) + ' v' + String(m.active).padEnd(5) + ' ' + m.mode.padEnd(7) + ' versions ' + m.versions.join(',') + '  cases ' + m.cases + '  evaluations ' + m.evaluations + (m.valid ? '' : '  INVALID: ' + m.error));
      process.exit(0);
    }
    if (cmd === 'show') {
      if (!pos[0]) done({ ok: false, error: 'show <id> [--version <v>]' });
      const L = dm.load(pos[0], flag('version'));
      done({ ok: !L.error, error: L.error || undefined, id: pos[0], version: L.version, sha: L.sha, active: dm.activeVersion(pos[0]), promoted: dm.state().models[pos[0]] || null, model: L.model }, L.model ? 0 : 2);
    }
    if (cmd === 'eval') {
      if (!pos[0]) done({ ok: false, error: 'eval <id> --input <file|json>' });
      const r = dm.evaluate(pos[0], parseInput(flag('input')), { version: flag('version'), log: !a.includes('--no-log'), caller: 'decide.js eval' });
      done(Object.assign({ ok: r.action != null }, r), r.action != null ? 0 : 2);
    }
    if (cmd === 'replay') {
      if (!pos[0] || !flag('version')) done({ ok: false, error: 'replay <id> --version <v> [--from <iso>]' });
      const r = dm.replay(pos[0], flag('version'), { from: flag('from') });
      if (!r.ok || json) done(r);
      console.log(r.id + ' v' + r.version + ' over ' + r.rows + ' logged evaluations: ' + r.agree + ' agree, ' + r.disagree + ' disagree' + (r.partialInputs ? ' (' + r.partialInputs + ' had sensitive fields left out of the log)' : ''));
      for (const d of r.disagreements.slice(0, 20)) console.log('  ' + d.at + ' ' + d.inputDigest + ': was ' + d.was.action + ' (v' + d.was.version + ' ' + d.was.rule + '), now ' + d.now.action + ' (' + d.now.rule + ')');
      process.exit(0);
    }
    if (cmd === 'test') {
      if (!pos[0]) done({ ok: false, error: 'test <id> [--version <v>|--all]' });
      const vs = a.includes('--all') ? dm.versions(pos[0]) : [flag('version')];
      let miss = false;
      for (const v of vs) {
        const r = dm.test(pos[0], { version: v });
        if (!r.ok && r.error) done(r);
        if (json) { console.log(JSON.stringify(r, null, 1)); } else {
          for (const x of r.results) if (!x.pass) console.log('MISS ' + x.name + ': expected ' + x.expect + ', got ' + x.got + ' (' + x.rule + ')');
          console.log(r.id + ' v' + r.version + ': ' + (r.cases - r.misses) + '/' + r.cases + ' cases pass');
        }
        if (!r.ok) miss = true;
      }
      process.exit(miss ? 1 : 0);
    }
    if (cmd === 'promote') {
      if (pos.length !== 2) done({ ok: false, error: 'promote <id> <version> [--mode shadow|live] --by <owner>' });
      done(dm.promote(pos[0], pos[1], { by: flag('by'), mode: flag('mode') }));
    }
    if (cmd === 'set-param') {
      if (pos.length !== 3) done({ ok: false, error: 'set-param <id> <name> <value> --by <owner>' });
      done(dm.setParam(pos[0], pos[1], pos[2], { by: flag('by') }));
    }
    if (cmd === 'register') done(dm.register());
    if (cmd === 'outcome') {
      if (!pos[0]) done({ ok: false, error: 'outcome <decisionId> --result good|bad --by <seat|owner> [--note "..."]' });
      done(dm.outcome(pos[0], { result: flag('result'), by: flag('by'), note: flag('note') }));
    }
    if (cmd === 'join') done(dm.join());
    if (cmd === 'health') {
      const h = dm.health({ id: flag('id') || undefined, apply: true });
      if (json) done(h);
      if (h.joined) console.log('joined ' + h.joined + ' outcome(s) from later records');
      if (!h.models.length) console.log('No logged decisions with ids yet.');
      for (const m of h.models) console.log(m.id.padEnd(16) + ' v' + String(m.version).padEnd(5) + ' ' + (m.live ? 'live  ' : 'shadow') + '  proceed ' + m.proceed + ' in ' + m.windowDays + 'd, judged ' + m.judged + ' (good ' + m.good + ', bad ' + m.bad + ')  precision ' + (m.precision == null ? '-' : m.precision) + '  bad limit ' + m.maxBad + (m.demoted ? '  DEMOTED to shadow' : m.overThreshold ? '  OVER LIMIT' : ''));
      process.exit(0);
    }
  } catch (e) { done({ ok: false, error: e.message }, 2); }
  done({ ok: false, error: 'commands: list [--json], show <id>, eval <id> --input <file|json>, replay <id> --version <v> [--from <iso>], test <id>, promote <id> <version> --by <owner>, set-param <id> <name> <value> --by <owner>, outcome <decisionId> --result good|bad --by <x>, join, health [--id <model>] [--json], register, selftest' });
}

module.exports = { selftest };
