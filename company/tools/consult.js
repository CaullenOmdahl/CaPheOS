#!/usr/bin/env node
/* consult.js — ask your department's lead, and the lead's answer (docs/DEPARTMENTS.md §5; the library is lib/consult.js).
 *
 *   node company/tools/consult.js ask --item <item id> --question ".." [--kind ask|plan|premerge] [--check ".."] [--pr <url>] --by <seat>
 *        a member asks its department's lead. The item is one of your handoff blocks (its **Id:** line, or the
 *        `<inbox>#<6 hex>` id handoff-status.js shows). plan and premerge need --check (the acceptance check). The packet,
 *        heading included, is at most advisor.packetMaxChars characters (4000 by default): a longer one is refused.
 *   node company/tools/consult.js answer <cs-id> --verdict APPROVE|REVISE|ESCALATE-TIER|TAKE-OVER|ESCALATE --check ".." [--finding ".."]... [--tier <provider>/<model>@<effort>] --by <lead>
 *        only the department's lead answers. The verdict line goes into the consult block and the member's item block, and
 *        the consult is closed (**Status:** DONE).
 *        --verdict SPLIT --piece "<title> — files: a, b — check: <acceptance check>" (3 or more, delegation.minPieces)
 *        [--fanout lanes|dispatch]: split the member's item into pieces for the lead's team (docs/DEPARTMENTS.md §6). The
 *        pieces go into the item's block (**Pieces:**, **Fan-out:**) when the department's splitting is on; while it is
 *        recording only, the split is recorded (WOULD DELEGATE) and the item stays with the member.
 *   node company/tools/consult.js split <item id> --piece ".." --piece ".." --piece ".." [--fanout lanes|dispatch] --by <lead>
 *        the lead splits an OPEN item in its own inbox the same way. Only a recorded split is ever delegated: a Pieces
 *        list written into a handoff by hand is not.
 *   node company/tools/consult.js list [--dept <id>] [--open] [--json]
 *   node company/tools/consult.js status [--dept <id>] [--json]   per department: the mode, the pause and why, consults today
 *                                                                  of the daily limit, the next and the last advice, the
 *                                                                  house ranking's advisor evaluation
 *   node company/tools/consult.js --duty       read-only: due while a live department has an open consult older than
 *                                              batch.maxWaitMin x 3 (an advise run that never came); routes to people
 *   node company/tools/consult.js --selftest
 * Inside an agent's run --by must be that run's own seat. Exit: 0 done, 1 duty due / selftest failed, 2 usage or refused
 * (a non-lead answering, a packet too long, advice off), 3 a consult dropped and recorded (a duplicate, the daily limit).
 * Output: one JSON object (list/status without --json: text). Owner: the tools function.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const C = require('./lib/consult');
const D = require('./lib/departments');
const W = require('./lib/wakes');

const TOOL = 'consult.js';
class Refusal extends Error { constructor(msg, code, extra) { super(msg); this.code = code || 2; this.extra = extra || {}; } }

function args(argv) {
  const o = { pos: [], finding: [], piece: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2), v = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    if (k === 'finding' || k === 'piece') { if (v !== true) o[k].push(v); } else o[k] = v;
  }
  return o;
}
const str = v => (v === true || v == null ? '' : String(v));

/* the seat running the command: a crew seat id or name; inside a run, that run's own seat */
function seatOf(by, cmd) {
  const name = str(by).trim(); if (!name) throw new Refusal('--by <seat> is required');
  const crew = co.crew(), low = name.toLowerCase();
  const id = crew[name] ? name : Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low);
  if (!id) throw new Refusal('--by "' + name + '" is not on the crew (company/tools/loops.json)');
  let pv = null; try { pv = require('./provenance.js'); } catch (_) {}
  if (pv && pv.underStation()) {
    const env = String(process.env.STARNET_AGENT_ID || '').trim();
    if (env && env !== id) throw new Refusal('this run is ' + ((crew[env] || {}).name || env) + '\'s, not ' + ((crew[id] || {}).name || id) + '\'s: --by names the seat running the command');
    const c = pv.callerConflict(co.ROOT, [TOOL, cmd], id);
    if (c) throw new Refusal('this command claims --by ' + ((crew[id] || {}).name || id) + ' but ran in another seat\'s run (' + c.runId + ')');
  }
  return id;
}

/* the item a member asks about: a block in its own inbox (else any inbox) whose id is --item */
function findItem(seat, item) {
  const crew = co.crew(), SP = require('./lib/sprint');
  const inboxes = [(crew[seat] || {}).inbox].concat(Object.values(crew).map(c => c && c.inbox)).filter(Boolean);
  for (const ib of [...new Set(inboxes)]) {
    let t = ''; try { t = fs.readFileSync(co.p('company', 'work', 'handoffs', ib), 'utf8'); } catch (_) { continue; }
    for (const sec of t.split(/^(?=## )/m)) {
      if (!sec.startsWith('## ')) continue;
      const it = SP.parseItems(sec)[0]; if (!it) continue;
      if (W.itemId(ib, it.heading, it.id) === item || it.id === item) return { file: ib, id: W.itemId(ib, it.heading, it.id), title: it.heading, text: sec, effort: it.effort };
    }
  }
  return null;
}

function ask(a) {
  const seat = seatOf(a.by, 'ask'), crew = co.crew();
  const item = str(a.item).trim(); if (!item) throw new Refusal('--item <item id> is required (handoff-status.js shows each block\'s id)');
  const L = D.load({}), d = D.deptOf(seat, L.doc);
  if (!d) throw new Refusal(((crew[seat] || {}).name || seat) + ' is in no department, so there is no lead to ask');
  const found = findItem(seat, item);
  if (!found) throw new Refusal('no handoff block with the id ' + item + ' (node company/tools/handoff-status.js lists them)');
  const kind = str(a.kind) || 'ask';
  const cls = require('./lib/taskclass').classOf({ text: found.text, effort: found.effort }, seat, { departments: L.doc });
  const r = C.writePacket({ dept: String(d.id), item: found.id, file: found.file, title: found.title, from: (crew[seat] || {}).name || seat, fromSeat: seat, kind, trigger: 'asked', class: cls,
    pr: str(a.pr) || null, question: str(a.question), check: str(a.check), tried: str(a.tried) }, {});
  if (r.ok) return { code: 0, out: { ok: true, id: r.id, delivered: r.delivered, chars: r.chars, next: r.delivered ? 'the dispatcher starts ' + (((crew[d.lead] || {}).name) || 'the lead') + '\'s advise run for it; until the answer, the dispatcher does not wake you for this item' : 'recorded only: the lead\'s advice is in recording-only mode (or paused), so nothing is sent' } };
  if (r.refused || !r.dropped) throw new Refusal(r.error, 2, { dropped: r.dropped || undefined, id: r.id || undefined });
  return { code: 3, out: { ok: false, dropped: r.dropped, id: r.id, error: r.error, duplicateOf: r.duplicateOf } };
}

function answer(a) {
  const id = str(a.pos[1]).trim(); if (!/^cs-/.test(id)) throw new Refusal('answer <cs-id> --verdict .. --check .. --by <lead>');
  const by = seatOf(a.by, 'answer');
  const r = C.answer({ id, verdict: str(a.verdict), check: str(a.check), findings: a.finding, tier: str(a.tier), pieces: a.piece, fanout: str(a.fanout) || undefined, by });
  if (!r.ok) throw new Refusal(r.error, r.code || 2);
  return { code: 0, out: r };
}
function split(a) {
  const item = str(a.pos[1]).trim(); if (!item) throw new Refusal('split <item id> --piece ".." (3 or more) [--fanout lanes|dispatch] --by <lead>');
  const by = seatOf(a.by, 'split');
  const r = C.split({ item, pieces: a.piece, fanout: str(a.fanout) || undefined, by });
  if (!r.ok) throw new Refusal(r.error, r.code || 2);
  return { code: 0, out: r };
}

function list(a) {
  const all = [...C.consults(C.ledger({})).values()].filter(c => (!a.dept || c.open.dept === a.dept) && (!a.open || c.status === 'open'))
    .sort((x, y) => (Number(y.open.at) || 0) - (Number(x.open.at) || 0)).slice(0, 200)
    .map(c => ({ id: c.id, status: c.status, dept: c.open.dept, lead: c.open.lead, item: c.open.item, title: c.open.title, from: c.open.from, kind: c.open.kind, trigger: c.open.trigger, at: c.open.ts, shadow: !!c.open.shadow,
      dropped: c.dropped ? c.dropped.why : undefined, advised: c.advised.filter(x => !x.shadow).length, verdict: c.verdict ? c.verdict.verdict : undefined, answeredAt: c.verdict ? c.verdict.ts : undefined }));
  if (a.json) return { code: 0, out: { ok: true, consults: all } };
  return { code: 0, out: all.length ? all.map(c => c.id + '  ' + c.status + (c.verdict ? ' ' + c.verdict : '') + (c.dropped ? ' (' + c.dropped + ')' : '') + (c.shadow ? ' [recorded only]' : '') + '  ' + c.dept + '  ' + c.kind + '/' + c.trigger + '  "' + String(c.title || c.item).slice(0, 70) + '"  from ' + c.from).join('\n') : 'No consults.' };
}

function statusText(s) {
  const L = [];
  for (const d of s.departments) {
    L.push(d.name + ' (' + d.dept + '): advice ' + d.mode + (d.paused ? ', PAUSED by ' + d.paused.by + ' (' + (d.paused.why || '') + ')' : '') + (d.lead ? ', lead ' + d.leadName : ', no lead') +
      ' — consults today ' + d.today + ' of ' + d.maxPerDay + ', open ' + d.open + (d.lastAdviceAt ? ', last advice ' + d.lastAdviceAt : '') + (d.nextAdvice ? ', next ' + d.nextAdvice : '') +
      (d.evaluation ? ', evaluation: ' + d.evaluation.verdict : ''));
  }
  return L.length ? L.join('\n') : 'No departments.';
}

function duty() {
  const s = C.status({}), items = [];
  for (const d of s.departments) {
    if (d.effective !== 'live') continue;
    const x = D.advisorOf(D.list(D.load({}).doc).find(y => String(y.id) === d.dept), D.settings(D.load({}).doc));
    const limit = Math.max(1, Number(x.batch.maxWaitMin) || 10) * 3 * 60e3;
    for (const c of C.consults(C.ledger({})).values()) if (c.status === 'open' && !c.open.shadow && c.open.dept === d.dept && Date.now() - (Number(c.open.at) || 0) > limit) items.push({ id: 'consult:' + c.id, route: 'people' });
  }
  if (!items.length) return { code: 0 };
  const key = crypto.createHash('sha256').update(items.map(i => i.id).sort().join('\n')).digest('hex').slice(0, 16);
  return { code: 1, out: { due: true, route: 'people', key, items: items.slice(0, 50), reason: (items.length + ' consult(s) waited more than 3 x the batch wait with no answer: the lead\'s advise run did not come or did not answer (consult.js status; the dispatch log ADVISE lines)').slice(0, 300) } };
}

function main(argv) {
  const a = args(argv), cmd = a.pos[0] || 'status';
  if (argv.length === 1 && argv[0] === '--duty') return duty();
  if (cmd === 'ask') return ask(a);
  if (cmd === 'answer') return answer(a);
  if (cmd === 'split') return split(a);
  if (cmd === 'list') return list(a);
  if (cmd === 'status') { const s = C.status({ dept: str(a.dept) || null }); return { code: 0, out: a.json ? s : statusText(s) }; }
  throw new Refusal('usage: consult.js ask --item <id> --question ".." [--kind ask|plan|premerge] [--check ".."] [--pr <url>] --by <seat> | answer <cs-id> --verdict <V> --check ".." [--finding ".."]... [--tier p/m@e] [--piece ".."]... [--fanout lanes|dispatch] --by <lead> | split <item id> --piece ".."... [--fanout lanes|dispatch] --by <lead> | list [--dept d] [--open] [--json] | status [--dept d] [--json] | --duty | --selftest');
}
function run(argv) {
  try { return main(argv); }
  catch (e) { if (e instanceof Refusal) return { code: e.code, out: Object.assign({ ok: false, refused: true, error: e.message }, e.extra) }; return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; }
}

/* ---------------- selftest: the pure parts (the CLI, the dispatcher and the gate: tests/consult*.test.js) ---------------- */
function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + String(d || '').slice(0, 300) + ']')); if (!c) bad++; };
  const now = Date.parse('2026-11-20T10:00:00Z'), M = 60e3;
  const b = { minGapMin: 5, maxWaitMin: 10, startAt: 3 };
  ok('batch: three open consults start one advise run', C.batchDue({ pending: [{ at: now - 2 * M }, { at: now - M }, { at: now }], batch: b, now }).start === true);
  ok('batch: one consult waits until maxWaitMin', C.batchDue({ pending: [{ at: now - 3 * M }], batch: b, now }).start === false && C.batchDue({ pending: [{ at: now - 10 * M }], batch: b, now }).start === true);
  ok('batch: nothing inside minGapMin of the last advise run', C.batchDue({ pending: [{ at: now }, { at: now }, { at: now }], lastAdvise: now - 2 * M, batch: b, now }).start === false);
  const items = [{ id: 'to-ben.md#abc123', file: 'to-ben.md', seat: 'ben', dept: 'eng', title: 'fix it', sig: 's1', revise: 0, reopens: 0 }];
  const settings = { eng: { stuckAfterFailedRuns: 2, stuckAfterRevise: 2, stuckAfterIdleWakes: 2, stuckOnReopen: true } };
  let s = C.stuckScan({ items, wakes: [], runs: [], state: {}, now, settings }).state;
  const wk = (n, reason) => ({ wakes: [{ at: now + n * M, seat: 'ben', runId: 'r' + n, door: 'dispatch', items: [{ id: 'to-ben.md#abc123' }] }], runs: [{ runId: 'r' + n, agentId: 'ben', endedAt: now + n * M + 1, reason }] });
  const acc = { wakes: [], runs: [] }; const add = x => { acc.wakes.push(...x.wakes); acc.runs.push(...x.runs); };
  add(wk(1, 'max_iters')); let r = C.stuckScan(Object.assign({ items, state: s, now: now + 2 * M, settings }, acc)); s = r.state;
  ok('stuck: one failed run opens nothing', r.triggers.length === 0, JSON.stringify(r.triggers));
  add(wk(2, 'max_iters')); r = C.stuckScan(Object.assign({ items, state: s, now: now + 3 * M, settings }, acc)); s = r.state;
  ok('stuck: two failed runs open exactly one consult', r.triggers.length === 1 && r.triggers[0].trigger === 'failed-runs:2', JSON.stringify(r.triggers));
  add(wk(3, 'max_iters')); r = C.stuckScan(Object.assign({ items, state: s, now: now + 4 * M, settings }, acc)); s = r.state;
  ok('stuck: a third failed run opens none', r.triggers.length === 0);
  add(wk(4, 'error')); r = C.stuckScan(Object.assign({ items, state: s, now: now + 5 * M, settings }, acc));
  ok('stuck: a provider error is not a failed run', r.state.items['to-ben.md#abc123'].failedRuns === 3, JSON.stringify(r.state.items));
  ok('packet: rendered and parsed back', (() => { const p = C.parsePacket(C.renderPacket({ id: 'cs-x-1', item: 'i', from: 'Ben', kind: 'plan', title: 'T', question: 'Q?', check: 'npm test', now }).slice(1)); return p && p.id === 'cs-x-1' && p.kind === 'plan' && p.question === 'Q?' && p.check === 'npm test'; })());
  const t1 = C.advisePrompt({ template: 'You are {{LEAD}} of {{DEPT_NAME}}.\n\nOpen consults for you: (none)\n', lead: 'Kwame', deptId: 'eng', deptName: 'Engineering', ids: ['cs-a'] });
  const t2 = C.advisePrompt({ template: 'You are {{LEAD}} of {{DEPT_NAME}}.\n\nOpen consults for you: (none)\n', lead: 'Kwame', deptId: 'eng', deptName: 'Engineering', ids: ['cs-b', 'cs-c'] });
  const pre = t1.slice(0, t1.indexOf(C.CONSULT_LINE));
  ok('advise prompt: the same bytes up to the consult line', pre.length > 10 && t2.startsWith(pre) && t1 !== t2);
  const pk = n => '**Pieces:**\n' + Array.from({ length: n }, (_, i) => (i + 1) + '. part ' + i + ' — files: src/p' + i + '.js — check: npm test').join('\n');
  ok('splitOk: three pieces on separate files, each with a check, fan-out lanes by default', C.splitOk(pk(3)).ok && C.splitOk(pk(3)).fanout === 'lanes');
  ok('splitOk: two pieces are refused', !C.splitOk(pk(2)).ok && /at least 3/.test(C.splitOk(pk(2)).why));
  ok('splitOk: a piece with no check is refused', !C.splitOk(pk(3).replace(/ — check: npm test$/, '')).ok);
  ok('splitOk: two pieces sharing a file are refused', /both touch/.test(C.splitOk(pk(3).replace('src/p2.js', 'src/p1.js')).why));
  ok('splitOk: a fan-out that is not lanes or dispatch is refused', !C.splitOk(pk(3) + '\n**Fan-out:** everyone').ok && C.splitOk(pk(3) + '\n**Fan-out:** dispatch').fanout === 'dispatch');
  ok('verdict line: the shape model-rank.js reads', C.verdictLine({ verdict: 'REVISE', by: 'Kwame', check: 'npm test', findings: ['a', 'b'] }) === '**Verdict:** REVISE by Kwame — check: npm test — 1. a 2. b');
  console.log(bad ? 'CONSULT SELFTEST FAILED: ' + bad : 'CONSULT SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { run, Refusal };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  if (r.out !== undefined) console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  process.exit(r.code);
}
