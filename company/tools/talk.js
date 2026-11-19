#!/usr/bin/env node
/* talk.js — how the crew talks to the owner: the only writer of company/owner/talk.json (docs/TALK.md; the reading,
 * the instruction a seat gets and the pre-delivery check are lib/talk.js).
 *
 *   node company/tools/talk.js show [--json] [--console]
 *        the owner's choice (level, length, how often, the check) and the last 30 days of check rows
 *        (company/state/talk-checks.jsonl: delivered, sent back, masked, recorded only). --console: plus the examples,
 *        for Settings › How the crew talks to you
 *   node company/tools/talk.js set [--level plain|some|technical] [--length short|medium|full]
 *        [--often needed|daily|asItHappens] [--check off|shadow|live] --by owner
 *        owner only (lib/owner.js: the owner's own shell or the console). A company without the file reads technical with
 *        the check recording only; the owner's first choice starts from the framework default (plain, short, daily, the
 *        check on), so what they did not name reads as a new company's.
 *        Each change: an atomic write recorded with provenance, and one line in company/work/decisions.md
 *   node company/tools/talk.js examples [--json]    the fixed example messages (company/defaults/owner/talk-examples.json)
 *   node company/tools/talk.js --selftest
 * Exit: 0 done, 1 selftest failed, 2 usage, 3 not the owner.
 * Owner: the tools function (this file); the setting itself is the owner's.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./lib/talk');

const TOOL = 'talk.js';
class Refusal extends Error { constructor(msg, code) { super(msg); this.code = code || 2; } }
const S = { root: () => require('./lib/company').ROOT, now: () => Date.now(), shell: null, decision: o => require('./decision.js').add(o) };   // seams for the tests
const O = () => ({ root: S.root() });
const str = v => (v === true || v == null ? '' : String(v));

function args(argv) {
  const o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2); o[k] = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return o;
}
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }

const SAY = {
  level: { plain: 'Plain words', some: 'Some detail', technical: 'Technical' },
  length: { short: 'short', medium: 'medium length', full: 'as long as needed' },
  often: { needed: 'only when needed, plus a weekly summary', daily: 'a daily summary', asItHappens: 'as things happen' },
  check: { off: 'no check before delivery', shadow: 'the check records only', live: 'a too-technical chat reply goes back once' },
};
const summary = p => SAY.level[p.level] + ', ' + SAY.length[p.length] + ', ' + SAY.often[p.often] + ' (' + SAY.check[p.check] + ')';

function show(a) {
  const p = T.prefs(O());
  const out = { ok: true, prefs: p, picked: p.source === 'file', summary: summary(p), checks: T.stats(Object.assign(O(), { days: 30 })) };
  if (a.console) out.examples = T.examples(O());
  return out;
}
function set(a) {
  const by = str(a.by).trim();
  const own = require('./lib/owner');
  if (!own.isOwnerName(by)) throw new Refusal('how the crew talks to the owner is the owner\'s choice: --by owner from the owner\'s own shell, or the console (Settings › How the crew talks to you)', 3);
  const r = own.refusal(by, 'how the crew talks to you', S.shell ? { shell: S.shell } : undefined);
  if (r) throw new Refusal(r, 3);
  const cur = T.prefs(O());
  // the owner's first choice starts from the framework default (company/defaults/owner/talk.json: plain, short, daily,
  // the check on), so what they did not say reads as a new company's; later changes keep what they chose before
  let base = cur;
  if (cur.source === 'default') {
    let d = null; try { d = JSON.parse(fs.readFileSync(T.files(O()).defaults, 'utf8')); } catch (_) {}
    const pick = (k, list, fb) => d && list.includes(d[k]) ? d[k] : fb;
    base = { level: pick('level', T.LEVELS, 'plain'), length: pick('length', T.LENGTHS, 'short'), often: pick('often', T.OFTEN, 'daily'), check: pick('check', T.CHECKS, 'live') };
  }
  const next = { v: 1, level: base.level, length: base.length, often: base.often, check: base.check };
  const want = { level: [a.level, T.LEVELS], length: [a.length, T.LENGTHS], often: [a.often, T.OFTEN], check: [a.check, T.CHECKS] };
  let given = 0;
  for (const [k, [v, list]] of Object.entries(want)) {
    if (v === undefined) continue;
    if (!list.includes(str(v))) throw new Refusal('--' + k + ' is one of ' + list.join(', '));
    next[k] = str(v); given++;
  }
  if (!given) throw new Refusal('set needs at least one of --level, --length, --often, --check');
  const file = T.files(O()).file;
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (prev && prev.limits && typeof prev.limits === 'object') next.limits = prev.limits;
  next.setBy = 'owner'; next.at = new Date(S.now()).toISOString();
  const same = cur.source === 'file' && ['level', 'length', 'often', 'check'].every(k => cur[k] === next[k]);
  if (same) return { ok: true, changed: false, prefs: T.prefs(O()), summary: summary(next) };
  const text = JSON.stringify(next, null, 1) + '\n';
  writeAtomic(file, text);
  try { require('./provenance.js').wrote(file, text, TOOL); } catch (_) {}
  let decision = null;
  try { decision = S.decision({ by: 'owner', text: 'How the crew talks to the owner: ' + summary(next) + '.', why: 'the owner\'s choice in Settings › How the crew talks to you' }); } catch (e) { decision = { error: e.message }; }
  return { ok: true, changed: true, prefs: T.prefs(O()), summary: summary(next), said: 'Saved. The crew will talk to you this way from their next message.',
    decision: decision && decision.ok ? decision.id : undefined, decisionError: decision && decision.error ? decision.error : undefined };
}
function main(argv) {
  const a = args(argv); const cmd = a.pos[0] || 'show';
  if (cmd === 'show') return { code: 0, out: show(a) };
  if (cmd === 'set') return { code: 0, out: set(a) };
  if (cmd === 'examples') return { code: 0, out: Object.assign({ ok: true }, T.examples(O())) };
  throw new Refusal('usage: talk.js show [--json] [--console] | set [--level ..] [--length ..] [--often ..] [--check ..] --by owner | examples [--json] | --selftest');
}
function run(argv) {
  try { return main(argv); }
  catch (e) { if (e instanceof Refusal) return { code: e.code, out: { ok: false, refused: true, error: e.message } }; return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; }
}
function human(r) {
  const o = r.out; if (!o || o.ok === false) return o && o.error ? 'talk.js: ' + o.error : '';
  if (o.prefs && o.summary) {
    const c = o.checks;
    return 'How the crew talks to the owner: ' + o.summary + (o.picked ? '' : ' — not picked yet (no company/owner/talk.json)') + (o.said ? '\n' + o.said : '')
      + (c ? '\nChecks, last ' + c.days + ' days: ' + c.rows + ' replies, ' + c['sent-back'] + ' sent back, ' + c.masked + ' masked, ' + c.shadow + ' recorded only (' + c.wouldSendBack + ' would have gone back)' : '');
  }
  return JSON.stringify(o, null, 1);
}

/* ---------------- selftest: a throwaway company ---------------- */
function selftest() {
  const os = require('os');
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + String(d || '').slice(0, 400) + ']')); if (!c) bad++; };
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-selftest-'));
  const w = (rel, d) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
  w('company/company.json', { name: 'Fixture', owner: { name: 'Olive' } });
  const REPO = path.resolve(__dirname, '..', '..');
  for (const f of ['company/defaults/owner/talk.json', 'company/defaults/owner/talk-examples.json']) w(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  S.root = () => R; S.shell = () => true; const decided = []; S.decision = o => { decided.push(o); return { ok: true, id: 'd-000000000000' }; };
  try {
    let r = run(['show']);
    ok('no file: technical, full, daily, recording only (today\'s behaviour)', r.code === 0 && r.out.prefs.level === 'technical' && r.out.prefs.check === 'shadow' && r.out.picked === false, JSON.stringify(r.out));
    ok('no file: the seat is told nothing new', T.block(T.prefs({ root: R }), '', { root: R }) === '');
    r = run(['set', '--level', 'plain', '--by', 'Kim']);
    ok('a crew member cannot set it (exit 3)', r.code === 3, JSON.stringify(r));
    S.shell = () => false; r = run(['set', '--level', 'plain', '--by', 'owner']);
    ok('"--by owner" outside the owner\'s shell or console is refused (exit 3)', r.code === 3, JSON.stringify(r)); S.shell = () => true;
    r = run(['set', '--level', 'loud', '--by', 'owner']);
    ok('a level that does not exist is refused', r.code === 2, JSON.stringify(r));
    r = run(['set', '--level', 'plain', '--by', 'owner']);
    const p = T.prefs({ root: R });
    ok('the owner\'s first pick: plain, and the check switches on', r.code === 0 && r.out.changed && p.level === 'plain' && p.check === 'live' && p.source === 'file', JSON.stringify(r.out));
    ok('one line for the decision log', decided.length === 1 && /Plain words/.test(decided[0].text));
    ok('the saved words are plain', !require('./lib/owner-scope').wordsProblems(r.out.said).length, r.out.said);
    r = run(['set', '--often', 'needed', '--check', 'shadow', '--by', 'owner']);
    ok('a later change keeps the rest and takes --check as given', r.code === 0 && T.prefs({ root: R }).level === 'plain' && T.prefs({ root: R }).often === 'needed' && T.prefs({ root: R }).check === 'shadow');
    r = run(['set', '--often', 'needed', '--by', 'owner']);
    ok('the same choice again changes nothing', r.code === 0 && r.out.changed === false && decided.length === 2);
    const b = T.block(T.prefs({ root: R }), 'warm and brief', { root: R });
    ok('the plain block names the owner, the word cap and the seat\'s own voice', /^\[How Olive wants to hear from you\] Olive chose plain words/.test(b) && /about 80 words/.test(b) && /warm and brief$/.test(b), b);
    ok('the block stays short (under ~90 tokens without the voice)', T.block(T.prefs({ root: R }), '', { root: R }).split(/\s+/).length <= 70);
    r = run(['examples']);
    ok('examples: three messages at three levels and three lengths', r.code === 0 && r.out.messages.length === 3 && r.out.messages.every(m => ['plain', 'some', 'technical'].every(l => ['short', 'medium', 'full'].every(n => typeof m.levels[l][n] === 'string'))));
    T.record({ seat: 'a', level: 'plain', problems: [{ kind: 'path', words: ['x/y'] }], action: 'shadow' }, { root: R });
    r = run(['show']);
    ok('show counts the check rows', r.out.checks.rows === 1 && r.out.checks.wouldSendBack === 1, JSON.stringify(r.out.checks));
  } finally { try { fs.rmSync(R, { recursive: true, force: true }); } catch (_) {} }
  console.log(bad ? 'TALK SELFTEST FAILED: ' + bad : 'TALK SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { run, summary, _S: S };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  const json = argv.includes('--json') || argv.includes('--console') || (r.out && r.out.ok === false && argv.includes('--json'));
  console.log(json || typeof r.out !== 'object' ? (typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1)) : human(r));
  process.exit(r.code);
}
