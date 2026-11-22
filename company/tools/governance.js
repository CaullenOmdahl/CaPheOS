#!/usr/bin/env node
/* governance.js — the owner's dial: how much the company decides alone, per category.
 *
 *   node company/tools/governance.js show [--json]                       every category, its level, the fixed owner gates
 *   node company/tools/governance.js check <category>                    prints auto | notify | triage | approve (exit 0)
 *   node company/tools/governance.js set <category> <auto|notify|triage|approve> --by <owner>
 *   node company/tools/governance.js preset <approve-everything|gate-money-people|gate-money|autonomous> --by <owner>
 *   node company/tools/governance.js selftest
 *
 * Levels: auto = the accountable seat decides; notify = it decides and the owner is told the same day; triage = the
 * gate-triage decision model (docs/DECISION-MODELS.md) picks notify or approve from the caller's facts; approve = it
 * proposes and waits for the owner (lib/governance.js decide()). No preset uses triage: the owner opts a category in. The four fixed owner gates (access, ownership,
 * commitment, spend beyond the cap) are always approve and cannot be set here.
 *
 * Only the owner sets: --by must be the owner's name (company/company.json owner.name) or "owner", and the command must
 * not run inside an agent's station run (provenance.js underStation()). Agents read levels; they never change them.
 * Writes company/state/governance.json atomically (created from company/defaults/state/governance.json when missing),
 * one line per change in company/work/decisions.md and one JSON row in company/state/governance-log.jsonl.
 * locked-watch.js watches company/state/governance.json; this tool records its own writes (provenance.js).
 * Owner of this tool: the tools function; policy: the owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const gov = require('./lib/governance');

const LEVELS = gov.LEVELS;
function underStation() { if (process.env.GOVERNANCE_ASSUME_AGENT === '1') return true; try { return require('./provenance.js').underStation(); } catch (_) { return false; } }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, text, 'governance.js'); } catch (_) {}
}
function append(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  try { require('./provenance.js').appended(file, text, 'governance.js'); } catch (_) {}
}
function load(opts) {
  const f = gov.files(opts);
  const cur = co.readJson(f.gov, null);
  if (cur && cur.categories) return cur;
  return JSON.parse(JSON.stringify(co.readJson(f.govDefault, null) || co.readJson(co.p('company', 'defaults', 'state', 'governance.json'), {})));
}
function presetOf(d) {
  for (const [id, p] of Object.entries(d.presets || {})) {
    const c = p.categories || {};
    if (Object.keys(d.categories || {}).every(k => c[k] === d.categories[k])) return id;
  }
  return 'custom';
}
function refuseCaller(by) {
  if (!gov.isOwnerName(by)) return 'only the owner sets self-governance: --by must be "' + ((co.config.owner && co.config.owner.name) || 'Owner') + '" or "owner"';
  if (underStation()) return 'this runs inside an agent\'s station run: only the owner, from their own shell, changes self-governance';
  if (!require('./lib/owner').shell()) return 'only the owner changes self-governance, ' + require('./lib/owner').REASON;
  return null;
}
function record(opts, by, changes, d) {
  const f = gov.files(opts);
  const at = new Date().toISOString();
  writeAtomic(f.gov, JSON.stringify(d, null, 2) + '\n');
  append(f.log, JSON.stringify({ at, by, preset: d.preset, changes }) + '\n');
  if (!fs.existsSync(f.decisions)) append(f.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date(at));
  append(f.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + by + ' (owner) set self-governance: ' + changes.map(c => c.category + ' ' + c.from + ' -> ' + c.to).join(', ') + ' (preset ' + d.preset + ', company/tools/governance.js)\n');
}

function set(category, lv, by, opts) {
  const why = refuseCaller(by); if (why) return { ok: false, code: 3, error: why };
  const d = load(opts);
  if ((d.fixed || {})[category]) {
    // the ownerGates guardrail is the switch: ON = always approve; OFF = the owner may give a fixed gate a level (never triage)
    if (gov.guard('ownerGates', opts)) return { ok: false, code: 2, error: category + ' is a fixed owner gate: it is always approve and cannot be changed (the ownerGates guardrail is on)' };
    if (!LEVELS.includes(lv) || lv === 'triage') return { ok: false, code: 2, error: 'level must be auto, notify or approve for a fixed gate' };
    const from = (d.fixedLevels || {})[category] || 'approve';
    if (from === lv) return { ok: true, unchanged: true, category, level: lv };
    d.fixedLevels = Object.assign({}, d.fixedLevels, { [category]: lv });
    record(opts, by, [{ category, from, to: lv }], d);
    return { ok: true, category, from, to: lv, preset: d.preset };
  }
  if (!Object.prototype.hasOwnProperty.call(d.categories || {}, category)) return { ok: false, code: 2, error: 'unknown category ' + category + '; one of ' + Object.keys(d.categories || {}).join(', ') };
  if (!LEVELS.includes(lv)) return { ok: false, code: 2, error: 'level must be one of ' + LEVELS.join(', ') };
  const from = d.categories[category];
  if (from === lv) return { ok: true, unchanged: true, category, level: lv };
  d.categories[category] = lv; d.preset = presetOf(d);
  record(opts, by, [{ category, from, to: lv }], d);
  return { ok: true, category, from, to: lv, preset: d.preset };
}
function preset(id, by, opts) {
  const why = refuseCaller(by); if (why) return { ok: false, code: 3, error: why };
  const d = load(opts);
  const p = (d.presets || {})[id];
  if (!p) return { ok: false, code: 2, error: 'unknown preset ' + id + '; one of ' + Object.keys(d.presets || {}).join(', ') };
  const changes = [];
  for (const [k, v] of Object.entries(p.categories || {})) {
    if ((d.fixed || {})[k] || !LEVELS.includes(v) || !Object.prototype.hasOwnProperty.call(d.categories, k)) continue;
    if (d.categories[k] !== v) changes.push({ category: k, from: d.categories[k], to: v });
    d.categories[k] = v;
  }
  d.preset = id;
  if (!changes.length && co.readJson(gov.files(opts).gov, null)) return { ok: true, unchanged: true, preset: id };
  record(opts, by, changes.length ? changes : [{ category: '(all)', from: 'defaults', to: id }], d);
  return { ok: true, preset: id, changes };
}
function show(opts) {
  const d = load(opts);
  const cats = Object.keys(d.categories || {}).map(k => ({ category: k, level: gov.level(k, Object.assign({}, opts, { triage: true })), what: (d._categories || {})[k] || '' }));
  const ownerGates = gov.guard('ownerGates', opts);
  return { preset: d.preset || presetOf(d), presetLabel: ((d.presets || {})[d.preset] || {}).label || 'Custom', categories: cats,
    fixed: Object.keys(d.fixed || {}).map(k => ({ category: k, level: gov.level(k, opts) })), ownerGatesGuardrail: ownerGates ? 'on' : 'off',
    presets: Object.entries(d.presets || {}).map(([id, p]) => ({ id, label: p.label })) };
}

function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = require('./lib/temp-life').tmpDir('governance-selftest-');
  fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');   // provenance.fixtureRoot: a selftest's throwaway company answers owner checks, also when an agent runs it
  const prevProv = process.env.PROVENANCE_ROOT; process.env.PROVENANCE_ROOT = T;  const prevCR = process.env.CAPHEOS_ROOT; process.env.CAPHEOS_ROOT = T;   // provenance.fixtureRoot reads this: the suite measures the mechanism, not the caller
  const prevAgent = process.env.GOVERNANCE_ASSUME_AGENT; delete process.env.GOVERNANCE_ASSUME_AGENT;
  const opts = { root: T };
  fs.mkdirSync(path.join(T, 'company', 'defaults', 'state'), { recursive: true });
  fs.copyFileSync(co.p('company', 'defaults', 'state', 'governance.json'), path.join(T, 'company', 'defaults', 'state', 'governance.json'));
  const owner = (co.config.owner && co.config.owner.name) || 'Owner';
  const out = []; let bad = 0;
  const t = (n, fn) => { try { fn(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + e.message); } };
  const F = gov.files(opts);
  // the owner's answer as the owner's tools write it: recorded first (lib/pm-inbox-guard.js), else no reader trusts it
  const ownerSays = (id, text) => require('./lib/pm-inbox-guard').append(F.inbox, { type: 'answer', id, at: new Date().toISOString(), a: text, by: 'Commander' }, 'selftest');
  t('no state file: levels come from the defaults copy; unknown category fails closed', () => {
    assert.strictEqual(gov.level('hiring', opts), 'approve'); assert.strictEqual(gov.level('models', opts), 'notify');
    assert.strictEqual(gov.level('no-such-thing', opts), 'approve');
  });
  t('an agent is refused: wrong --by, or a station run even with the owner\'s name', () => {
    assert.strictEqual(set('hiring', 'auto', 'Alex', opts).code, 3);
    process.env.GOVERNANCE_ASSUME_AGENT = '1'; const r = set('hiring', 'auto', owner, opts); delete process.env.GOVERNANCE_ASSUME_AGENT;
    assert.strictEqual(r.code, 3); assert.ok(!fs.existsSync(F.gov));
  });
  t('fixed gates cannot be changed; bad level and unknown category are refused', () => {
    assert.strictEqual(set('access', 'auto', owner, opts).code, 2); assert.strictEqual(set('spendBeyondCap', 'notify', 'owner', opts).code, 2);
    assert.strictEqual(set('hiring', 'sometimes', owner, opts).code, 2); assert.strictEqual(set('nope', 'auto', owner, opts).code, 2);
    assert.strictEqual(gov.level('access', opts), 'approve');
  });
  t('set by the owner: file copied from defaults, changed, preset becomes custom, logged in both logs', () => {
    const r = set('hiring', 'notify', owner, opts); assert.ok(r.ok, r.error);
    assert.strictEqual(gov.level('hiring', opts), 'notify'); assert.strictEqual(co.readJson(F.gov).preset, 'custom');
    assert.ok(/hiring approve -> notify/.test(fs.readFileSync(F.decisions, 'utf8')));
    assert.strictEqual(fs.readFileSync(F.log, 'utf8').trim().split('\n').length, 1);
  });
  t('presets: autonomous sets hiring/budget auto and release notify; approve-everything sets all approve; fixed stay approve', () => {
    assert.ok(preset('autonomous', 'owner', opts).ok);
    assert.deepStrictEqual(['hiring', 'budget', 'release', 'external'].map(k => gov.level(k, opts)), ['auto', 'auto', 'notify', 'auto']);
    assert.strictEqual(show(opts).preset, 'autonomous'); assert.strictEqual(gov.level('commitment', opts), 'approve');
    assert.ok(preset('approve-everything', owner, opts).ok);
    assert.ok(show(opts).categories.every(c => c.level === 'approve'));
    assert.strictEqual(preset('anarchy', owner, opts).code, 2);
  });
  t('ownerGates guardrail off: fixed gates follow their category level (still approve here, never "auto" by accident)', () => {
    fs.writeFileSync(F.guards, JSON.stringify({ guards: { ownerGates: false } }));
    assert.strictEqual(gov.level('access', opts), 'approve');   // not a category: fails closed
    fs.unlinkSync(F.guards);
  });
  t('decide at auto: allowed, nothing written', () => {
    set('hiring', 'auto', owner, opts);
    const d = gov.decide('hiring', { by: 'Sam', summary: 'open a round', ref: 'hiring:open:r1' }, opts);
    assert.deepStrictEqual([d.level, d.allowed], ['auto', true]); assert.ok(!fs.existsSync(path.join(F.ownerDir, 'outbound.jsonl')));
  });
  t('decide at notify: allowed, one plain sentence to the owner, not repeated', () => {
    set('hiring', 'notify', owner, opts);
    const d = gov.decide('hiring', { by: 'Sam', summary: 'open the sales-lead-1 round', ref: 'hiring:open:sales-lead-1' }, opts);
    gov.decide('hiring', { by: 'Sam', summary: 'open the sales-lead-1 round', ref: 'hiring:open:sales-lead-1' }, opts);
    // the owner's plain line: the day's single message (company/owner/digest.jsonl, lib/owner-notice.js), never an immediate message
    const sent = fs.readFileSync(path.join(F.ownerDir, 'digest.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(!fs.existsSync(path.join(F.ownerDir, 'outbound.jsonl')) || !/sales-lead-1/.test(fs.readFileSync(path.join(F.ownerDir, 'outbound.jsonl'), 'utf8')), 'an FYI never goes out at once');
    assert.ok(d.allowed && d.noted); assert.strictEqual(sent.length, 1); assert.ok(/^Sam decided to open the sales-lead-1 round\./.test(sent[0].text));
    assert.ok(!/Self-governance|notify/.test(sent[0].text), 'the governance internals are not in the owner\'s line: ' + sent[0].text);
  });
  t('decide at approve: refused, one question (not two), then allowed after the owner says yes; no denies', () => {
    set('hiring', 'approve', owner, opts);
    const o = { by: 'Sam', summary: 'hire Lee as QA Lead', recommendation: 'yes: best interview', default: 'nobody is hired', ref: 'hiring:hire:qa-1:lee' };
    const d1 = gov.decide('hiring', o, opts); const d2 = gov.decide('hiring', o, opts);
    assert.strictEqual(d1.allowed, false); assert.strictEqual(d1.questionId, d2.questionId);
    assert.strictEqual(gov.pendingGates(opts).length, 1); assert.ok(/Sam recommends yes: best interview/.test(gov.pendingGates(opts)[0].q));
    assert.strictEqual(gov.approved(o.ref, opts), null);
    ownerSays(d1.questionId, 'Yes, go ahead');
    assert.strictEqual(gov.approved(o.ref, opts), true); assert.strictEqual(gov.decide('hiring', o, opts).allowed, true);
    const o2 = Object.assign({}, o, { ref: 'hiring:hire:qa-1:kim', summary: 'hire Kim' });
    const n = gov.decide('hiring', o2, opts); ownerSays(n.questionId, 'no, not yet');
    const n2 = gov.decide('hiring', o2, opts); assert.ok(n2.denied && !n2.allowed); assert.strictEqual(gov.approved(o2.ref, opts), false);
  });
  t('an owner reply on the owner channel that names the question counts only when the console recorded it', () => {
    const OC = require('./lib/owner-channel'); const P = require('./provenance.js'); P.pinUnderStation(false);
    OC.pinMains(r => /governance\.js$/.test(r.main));   // this selftest stands in for the console
    try {
      const d = gov.decide('budget', { by: 'Pat', summary: 'raise the cap', ref: 'budget:x' }, opts);
      const inb = path.join(F.ownerDir, 'inbound.jsonl'); fs.mkdirSync(F.ownerDir, { recursive: true });
      fs.appendFileSync(inb, JSON.stringify({ id: 'm0', at: 'x', from: 'owner', text: 'approve gate ' + d.questionId + ': yes, go ahead', re: d.questionId }) + '\n');
      assert.strictEqual(gov.approved('budget:x', opts), null, 'a forged line is no answer');
      OC.append(inb, { id: 'm1', at: 'x', from: 'owner', text: 'ok (' + d.questionId + ')', re: d.questionId }, 'console', { root: T });
      assert.strictEqual(gov.approved('budget:x', opts), true);
    } finally { OC.pinMains(null); P.pinUnderStation(null); }
  });
  // triage: a decision model picks notify or approve (lib/decision.js, company/decision-models/gate-triage)
  const dm = require('./lib/decision');
  const facts = { reversible: true, recurring: false, seatHistoryOk: true };   // what an acting seat would like to claim
  // the records triage reads: the owner's per-category table (model params) and Sam's competence record
  const comp = path.join(T, 'company', 'work', 'people', 'competence.json'); fs.mkdirSync(path.dirname(comp), { recursive: true });
  fs.writeFileSync(comp, JSON.stringify({ computedAt: '2026-11-01T00:00:00Z', people: { sam: { name: 'Sam' }, lee: { name: 'Lee' } }, serious: [{ agent: 'lee', severity: 'S1' }], waiting: [] }));
  t('triage: set by the owner; callers that do not ask for triage read it as approve; fixed gates refuse it', () => {
    assert.ok(set('tools', 'triage', owner, opts).ok);
    assert.strictEqual(gov.level('tools', opts), 'approve'); assert.strictEqual(gov.level('tools', Object.assign({ triage: true }, opts)), 'triage');
    assert.strictEqual(show(opts).categories.find(c => c.category === 'tools').level, 'triage');
    assert.strictEqual(set('access', 'triage', owner, opts).code, 2);
    assert.ok(Object.values(load(opts).presets).every(p => !Object.values(p.categories).includes('triage')));
  });
  t('provenance: the actor\'s own reversible/recurring/seatHistoryOk claims are not taken; the owner table and competence are', () => {
    let tf = gov.triageFacts('tools', { by: 'Sam', facts }, opts).facts;
    assert.deepStrictEqual([tf.reversible.value, tf.reversible.source, tf.recurring.value, tf.seatHistoryOk.source], [false, 'owner-table', true, 'competence']);
    assert.ok(dm.setParam('gate-triage', 'reversibleCategories', 'tools,schedules', { by: owner }, opts).ok);
    assert.ok(dm.setParam('gate-triage', 'oneOffCategories', 'tools', { by: owner }, opts).ok);
    tf = gov.triageFacts('tools', { by: 'Sam' }, opts).facts; assert.deepStrictEqual([tf.reversible.value, tf.recurring.value, tf.seatHistoryOk.value], [true, false, true]);
    assert.strictEqual(gov.triageFacts('tools', { by: 'Lee' }, opts).facts.seatHistoryOk.value, false);   // an open S1
    assert.strictEqual(gov.triageFacts('tools', { by: 'Nobody' }, opts).facts.seatHistoryOk, undefined);  // no record = absent
  });
  t('triage in shadow mode (the shipped default): escalates like approve, says what it would have done, logs the evaluation with provenance', () => {
    const d = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-1', ref: 'harness:c-1', facts }, opts);
    assert.strictEqual(d.allowed, false); assert.strictEqual(d.level, 'triage'); assert.strictEqual(d.triage.wouldBe, 'proceed-notify'); assert.strictEqual(d.triage.mode, 'shadow');
    assert.ok(/shadow mode; it would have said proceed-notify/.test(gov.pendingGates(opts).find(q => q.ref === 'harness:c-1').q));
    const rows = dm.logRows('gate-triage', opts); assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].version, '2'); assert.strictEqual(rows[0].provenance.reversible.source, 'owner-table'); assert.strictEqual(rows[0].actor, 'Sam');
  });
  t('an actor-supplied reversible:true cannot make a live triage proceed', () => {
    assert.ok(dm.promote('gate-triage', '2', { by: owner, mode: 'live' }, opts).ok);
    const d = gov.decide('models', { by: 'Sam', summary: 'switch a model', ref: 'models:1', facts }, Object.assign({ level: 'triage' }, opts));   // models is not on the owner's reversible list
    assert.strictEqual(d.allowed, false); assert.strictEqual(d.triage.rule, 'not-reversible');
    const n = gov.decide('tools', { by: 'Nobody', summary: 'apply tool change c-9', ref: 'harness:c-9', facts }, opts);   // no competence record: the claim is all there is
    assert.strictEqual(n.allowed, false); assert.ok(n.triage.distrusted.includes('seatHistoryOk'), JSON.stringify(n.triage));
    const last = dm.logRows('gate-triage', opts).pop(); assert.strictEqual(last.claimed.seatHistoryOk, true); assert.ok(/actor/.test(last.provenance.seatHistoryOk.rejected));
  });
  t('triage live: proceed-notify goes ahead; the owner gets a plain digest line, the technical part names the model, version, rule and decision; escalate files a question', () => {
    const seen = [];
    const d = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-2', ref: 'harness:c-2', facts }, Object.assign({ notice: n => { seen.push(n); return n; } }, opts));
    assert.ok(d.allowed && d.noted, JSON.stringify(d));
    const n = seen[seen.length - 1];
    assert.strictEqual(n.kind, 'fyi'); assert.strictEqual(n.text, 'Sam decided to apply tool change c-2. You can undo it on Today.'); assert.ok(n.action && n.action.kind === 'undo-decision' && /^d-[0-9a-f]{12}$/.test(n.action.decisionId), 'the line carries its Undo button');
    assert.ok(/set to triage, and decision model gate-triage v2 let this through: routine-change.*Decision d-[0-9a-f]{12}/.test(n.technical), n.technical);
    assert.strictEqual(n.key, d.triage.decisionId);
    const e = gov.decide('tools', { by: 'Lee', summary: 'apply tool change c-3', ref: 'harness:c-3', facts }, opts);   // Lee has an open S1
    assert.strictEqual(e.allowed, false); assert.ok(e.questionId); assert.strictEqual(e.triage.wouldBe, 'escalate');
  });
  t('outcomes: the owner undoing a proceed-notify joins as bad and demotes the live version to shadow; the owner is told', () => {
    const d = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-6', ref: 'harness:c-6' }, opts); assert.ok(d.allowed);
    // the owner's undo, as the console writes it (this selftest stands in for the console)
    require('./provenance.js').pinUnderStation(false); require('./lib/owner-channel').pinMains(r => /governance\.js$/.test(r.main));
    let n; try {
      require('./lib/owner-channel').append(path.join(F.ownerDir, 'inbound.jsonl'), { id: 'm-undo', at: new Date().toISOString(), from: 'owner', text: 'undo ' + d.triage.decisionId }, 'console', { root: T });
      n = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-7', ref: 'harness:c-7' }, opts);
    } finally { require('./lib/owner-channel').pinMains(null); require('./provenance.js').pinUnderStation(null); }
    assert.strictEqual(n.allowed, false); assert.strictEqual(n.triage.mode, 'shadow');
    assert.strictEqual(dm.state(opts).models['gate-triage'].mode, 'shadow');
    assert.ok(/gate-triage v2 is back in shadow mode/.test(fs.readFileSync(path.join(F.ownerDir, 'digest.jsonl'), 'utf8')));
    assert.ok(dm.outcomes(opts).some(o => o.decisionId === d.triage.decisionId && o.result === 'bad' && o.source === 'owner-reversal'));
  });
  t('a promoted v1 (no safety inputs) never proceeds: it would take the actor\'s word', () => {
    assert.ok(dm.promote('gate-triage', '1', { by: owner, mode: 'live' }, opts).ok);
    const d = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-8', ref: 'harness:c-8', facts }, opts);
    assert.strictEqual(d.allowed, false); assert.ok(/marks no fact as safety/.test(d.triage.why), d.triage.why);
  });
  t('triage fails closed when the model cannot run', () => {
    const mdir = path.join(T, 'company', 'decision-models', 'gate-triage'); fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, '1.json'), '{ not json');
    const d = gov.decide('tools', { by: 'Sam', summary: 'apply tool change c-5', ref: 'harness:c-5', facts }, opts);
    assert.strictEqual(d.allowed, false); assert.ok(/could not run/.test(d.triage.why));
    fs.rmSync(mdir, { recursive: true, force: true });
  });
  if (prevProv === undefined) delete process.env.PROVENANCE_ROOT; else process.env.PROVENANCE_ROOT = prevProv;
  if (prevCR === undefined) delete process.env.CAPHEOS_ROOT; else process.env.CAPHEOS_ROOT = prevCR;
  if (prevAgent !== undefined) process.env.GOVERNANCE_ASSUME_AGENT = prevAgent;
  fs.rmSync(T, { recursive: true, force: true });
  for (const l of out) console.log(l);
  console.log(bad ? 'GOVERNANCE SELFTEST FAILED: ' + bad : 'GOVERNANCE SELFTEST PASSED: ' + out.length + ' cases');
  return bad ? 1 : 0;
}

module.exports = { set, preset, show, load };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const flag = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const pos = a.slice(1).filter((x, i, arr) => !x.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')));
  const done = r => { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : (r.code || 2)); };
  if (cmd === 'selftest' || cmd === '--selftest') { try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}   // a selftest measures the mechanism in its own fixture tree, not the caller: an agent's run must not fail it
    process.exit(selftest()); }
  if (cmd === 'show') {
    const s = show();
    if (a.includes('--json')) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
    console.log('Self-governance: ' + s.presetLabel + ' (' + s.preset + ')');
    for (const c of s.categories) console.log('  ' + c.category.padEnd(10) + ' ' + c.level.padEnd(8) + ' ' + c.what);
    console.log('Fixed owner gates (always approve' + (s.ownerGatesGuardrail === 'off' ? '; the ownerGates guardrail is OFF' : '') + '): ' + s.fixed.map(x => x.category).join(', '));
    console.log('Presets: ' + s.presets.map(p => p.id).join(', '));
    process.exit(0);
  }
  if (cmd === 'check') { if (!pos[0]) done({ ok: false, error: 'check <category>' }); console.log(gov.level(pos[0], { triage: true })); process.exit(0); }
  if (cmd === 'set') { if (pos.length !== 2) done({ ok: false, error: 'set <category> <auto|notify|triage|approve> --by <owner>' }); done(set(pos[0], pos[1], flag('by'))); }
  if (cmd === 'preset') { if (pos.length !== 1) done({ ok: false, error: 'preset <id> --by <owner>' }); done(preset(pos[0], flag('by'))); }
  done({ ok: false, error: 'commands: show [--json], check <category>, set <category> <level> --by <owner>, preset <id> --by <owner>, selftest' });
}
