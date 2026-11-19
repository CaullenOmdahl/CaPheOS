'use strict';
/* lib/accountable.js — accountable leads (docs/DEPARTMENTS.md §8; the owner's 2026-11-19 direction: "the middle management
 * leads ... are going to be fully responsible for the employees that work underneath them ... review the work ... and then
 * pass it to where it needs to go ... the big thing with the middle management is that it should have accountability").
 *
 * The pathway, per department (departments.json accountable, lib/departments.js accountableOf; off | shadow | live):
 *   1. intake through the lead   work for a member that the lead did not assign (sent straight to the member) is recorded
 *                                as the lead's and copied to the lead's inbox (a DONE copy: for the record, it wakes nobody)
 *   2. workers on the lower tier the members' own chains and routes (routing classes, tier caps; code never on MiniMax)
 *   3. the self-check            a member hands back with `accountable.js handback`: the item's acceptance check is
 *                                required, its check command (and any --test-cmd) is RUN and must pass, and a "what I
 *                                checked" note is required. A failed self-check is recorded and never reaches the lead.
 *   4. the binding audit         the packet (the diff + the acceptance check + the self-check note, nothing else) goes to
 *                                the lead's inbox; the lead answers ACCEPT or REVISE with what to fix
 *                                (`accountable.js audit`). Until ACCEPT the dispatcher holds the item's DONE (a DONE set
 *                                by hand is put back to OPEN), the onward handoff (held for its receiver) and the merge
 *                                (merge-gate.js asks gate()). Routine audits run on accountable.audit.routine, risky ones
 *                                on accountable.audit.risky (both null = leadModelDefault, the lead's top tier): fixed pairs
 *                                the owner sets, never chosen by a router, a weekly suggestion or the ranking. A pair that
 *                                is shut makes the audit WAIT; it is never run on another model.
 *   5. the lead passes it on     a member's handoff to anyone outside the department is held until the lead passes it on
 *                                (`accountable.js pass`), so the receiver deals with one accountable person
 *   6. the scorecard             on the lead (scorecard()): on time, sent-back rate, cost per accepted item, escapes
 *                                (problems found later in accepted work, charged to the lead's review) and spot-check
 *                                results (1 in scorecard.spotCheckEvery accepts is checked again by the people function, so
 *                                rubber-stamping shows); the department card shows it in plain words
 *   7. escalation one level      a member's block to the CEO is outside the department, so it waits for the lead; the lead
 *                                passes it to the CEO only naming why (cross-department, or one of the four owner gates:
 *                                money, access, ownership, commitment), and the lead's own escalation to the CEO without
 *                                that reason is held too
 *   8. the saving                model-rank.js accountableEvaluation compares cost per accepted item with the lead doing
 *                                the same class of work alone; a cut under scorecard.fallbackBelowCut over minItems
 *                                withdraws the department to recording only (once per evaluation hash), and the owner is
 *                                told in one plain line
 * Mode: off = nothing is computed. shadow ("recording only") = intake, handbacks, would-holds and would-audits are
 * recorded (WOULD … in the dispatch log); nothing is copied, held, reopened or delivered. live = all of it.
 *
 *   const AC = require('./lib/accountable');
 *   AC.rows(o) / AC.audits(rows)            the ledger rows (only what accountable.js recorded, lib/recorded.js) / id -> audit
 *   AC.acceptanceOf(block) / AC.checkCommandOf(block) / AC.riskOf({block, cls, diff, a})   pure
 *   AC.handback(o) / AC.audit(o) / AC.pass(o) / AC.escape(o) / AC.spot(o) / AC.drop(o)      the CLI's commands
 *   AC.scanTick(o)                          the dispatcher's step: intake, copies, held DONEs, onward and escalation holds,
 *                                           spot-check picks, escapes on reopened accepted items -> (inbox, item) -> hold|null
 *   await AC.auditStep(ctx)                 the dispatcher's audit runs (door audit), the routine, the auto fallback
 *   AC.gate({seat, refs, sha}, o)           merge-gate.js: a member's merge needs an ACCEPT for this PR at this commit
 *   AC.leadEntries(seat, o)                 the audit pairs a live lead's audit run may use (lib/override-allow.js)
 *   AC.scorecard({dept, root, now})         the department scorecard (plain words for the card in .words)
 *   AC.status(o)                            per department: mode, open audits, held items, the scorecard
 * Files: company/state/accountable.jsonl (class A, append only, every row recorded with provenance as accountable.js;
 * a hand-written row is never read), company/state/accountable-state.json (the dispatcher's memory). Owner: the tools
 * function.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const co = require('./company');
const D = require('./departments');
const W = require('./wakes');

const WRITER = 'accountable.js';
const VERDICTS = ['ACCEPT', 'REVISE'];
const OWNER_GATES = ['money', 'access', 'ownership', 'commitment'];
const MIN = 60e3, DAY = 86400e3;
const AUDIT_LINE = 'Open audits for you:';
const AUDIT_HEAD = /^Audit:/;
const PASS_HEAD = /^Pass on:/;

const rootOf = o => path.resolve((o && o.root) || co.ROOT);
function paths(o) {
  const r = rootOf(o), J = (...a) => path.join(r, ...a);
  return { root: r, ledger: J('company', 'state', 'accountable.jsonl'), state: J('company', 'state', 'accountable-state.json'), handoffs: J('company', 'work', 'handoffs'),
    loops: J('company', 'tools', 'loops.json'), runs: J('.starnet-data', 'workspaces', 'runs.jsonl'), wakes: J('company', 'state', 'wakes.jsonl'), log: J('company', 'work', 'dispatch-log.md'),
    evaluation: J('company', 'work', 'models', 'routing-evaluation.json'),
    template: J('company', 'work', 'departments', 'audit-prompt.md'), templateDefault: J('company', 'defaults', 'work', 'departments', 'audit-prompt.md') };
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const one = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 300);
const nowOf = o => (o && Number.isFinite(o.now) ? o.now : Date.now());
const dayOf = ms => co.localParts(new Date(ms)).date;
const crewOf = o => (o && o.crew) || ((readJson(paths(o).loops, {}) || {}).agents || {});
const nameOf = (crew, s) => (crew[s] && crew[s].name) || s;
const firstName = n => String(n || '').split(/\s+/)[0];
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const sections = text => String(text || '').split(/^(?=## )/m);
const field = (sec, name) => { const m = String(sec).match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };
const newId = (p, now) => p + '-' + Number(now).toString(36) + '-' + crypto.randomBytes(2).toString('hex');
const itemRef = (inbox, it) => { const id = W.itemId(inbox, it.heading, it.id); return id.includes('#') ? id : inbox + '#' + id; };
const isDispatcherBlock = h => /^\S+\s+from\s+Dispatcher\b/i.test(String(h || ''));
// the CEO and the people seat of THIS crew (o.ceo wins; a test root's crew, not the process's company)
const ceoOf = (o, crew) => (o && o.ceo) || Object.keys(crew || {}).find(k => co.holds(crew[k], 'ceo')) || Object.keys(crew || {}).find(k => crew[k] && crew[k].manager == null) || co.ceo();
const peopleOf = crew => Object.keys(crew || {}).find(k => co.holds(crew[k], 'people')) || null;
const seatOf = (crew, by) => { const s = String(by == null ? '' : by).trim(); if (!s) return null; if (crew[s]) return s; const low = s.toLowerCase(); return Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low) || Object.keys(crew).find(k => firstName((crew[k] || {}).name).toLowerCase() === low) || null; };

/* ---------------- the ledger (read as accountable.js recorded it) ---------------- */
function rows(o) {
  const f = paths(o).ledger;
  let t = ''; try { t = require('./bounded').tailText(f, 8 << 20); } catch (_) { t = readText(f) || ''; }
  const out = [];
  for (const l of require('./recorded').lines(f, [WRITER], { root: rootOf(o), text: t })) { try { const r = JSON.parse(l); if (r && r.op) out.push(r); } catch (_) {} }
  return out;
}
function append(row, o) {
  if (o && o.dry) return row;
  const f = paths(o).ledger; const line = JSON.stringify(row) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line);
  try { require('../provenance.js').appended(f, line, WRITER, { root: rootOf(o) }); } catch (_) {}
  return row;
}
// id -> { id, hb, verdict (the FIRST verdict decides), escapes, spots, status: open | accepted | revise }
function audits(rs) {
  const m = new Map();
  for (const r of rs || []) {
    if (r.op === 'handback' && r.id && !m.has(r.id)) m.set(r.id, { id: r.id, hb: r, verdict: null, escapes: [], spots: [], status: 'open' });
    const x = r.id ? m.get(r.id) : null; if (!x) continue;
    if (r.op === 'verdict' && !x.verdict) { x.verdict = r; x.status = r.verdict === 'ACCEPT' ? 'accepted' : 'revise'; }
    else if (r.op === 'escape') x.escapes.push(r);
    else if (r.op === 'spot') { if (!x.spots.some(s => s.by === r.by)) x.spots.push(r); }
  }
  return m;
}
const latestFor = (m, ref) => { let best = null; for (const x of m.values()) if (x.hb.ref === ref && (!best || Number(x.hb.at) >= Number(best.hb.at))) best = x; return best; };

/* ---------------- departments ---------------- */
function deptState(o) {
  const L = D.load({ root: rootOf(o) }); const st = D.settings(L.doc, { root: rootOf(o) });
  return { L, st, list: D.list(L.doc).map(d => ({ d, a: D.accountableOf(d, st) })) };
}
const leadOk = (d, ceo) => !!(d && d.lead && String(d.lead) !== String(ceo || ''));
// the department a seat is a member of (not its lead) with the pathway on, or null
function memberDept(seat, ds, ceo) { return ds.list.find(e => e.a.mode !== 'off' && leadOk(e.d, ceo) && D.members(e.d).includes(String(seat)) && String(e.d.lead) !== String(seat)) || null; }
const leadDept = (seat, ds, ceo) => ds.list.find(e => e.a.mode !== 'off' && leadOk(e.d, ceo) && String(e.d.lead) === String(seat)) || null;

/* ---------------- pure: the item's check, its risk ---------------- */
// the acceptance check: **Acceptance check:** / **Check:** / an "### Acceptance check" section
function acceptanceOf(block) {
  const s = String(block || '');
  const f = field(s, 'Acceptance check') || field(s, 'Check');
  if (f && f.replace(/[`*]/g, '').trim()) return one(f, 600);
  const m = /^#{3,4} Acceptance check\s*\n([\s\S]*?)(?=^#{2,4} |(?![\s\S]))/m.exec(s);
  return m && m[1].trim() ? one(m[1], 600) : '';
}
// the command the self-check runs: **Check command:** `…`
function checkCommandOf(block) { const f = field(block, 'Check command'); if (!f) return ''; const m = /`([^`]+)`/.exec(f); return (m ? m[1] : f).trim().slice(0, 500); }
const diffFiles = diff => [...new Set([...String(diff || '').matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1].trim()))];
const diffLines = diff => String(diff || '').split('\n').filter(l => /^[+-](?![+-]{2} )/.test(l)).length;
// risky -> the lead's top tier: the department's risky classes, risky paths, a big diff, risky words in the item, an
// explicit **Risk:** high, or an act the sign-off kinds name (merge, external, trade)
function riskOf(o) {
  const a = o.a || D.ACCOUNTABLE_FALLBACK, r = a.risk || {}, why = [];
  const block = String(o.block || ''), files = o.files || diffFiles(o.diff);
  const explicit = String(field(block, 'Risk') || '').toLowerCase();
  if (/^(?:routine|low)\b/.test(explicit)) return { risky: false, why: ['marked routine'] };
  if (/^(?:high|risky)\b/.test(explicit)) why.push('marked risky');
  if ((r.classes || []).includes(String(o.cls || ''))) why.push(o.cls + ' work is risky in this department');
  const hit = files.find(f => (r.paths || []).some(p => p.endsWith('/') ? f.startsWith(p) || ('/' + f).includes('/' + p) : f === p || f.endsWith('/' + p)));
  if (hit) why.push('it touches ' + hit);
  const n = diffLines(o.diff); if (Number(r.minDiffLines) > 0 && n >= Number(r.minDiffLines)) why.push(n + ' changed lines');
  const w = (r.words || []).find(x => new RegExp('\\b' + String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(block.split('\n')[0] + '\n' + (field(block, 'Need') || '')));
  if (w) why.push('the item mentions ' + w);
  try { const SO = require('./signoff'); for (const k of ['merge', 'external', 'trade']) if (SO.KIND_CUES[k] && SO.KIND_CUES[k].test(block)) { why.push('it asks to ' + k); break; } } catch (_) {}
  return { risky: why.length > 0, why };
}
// the pair an audit runs on: fixed config, never a router (null pairs = the department's lead model)
function auditPair(tier, a, st) {
  const p = (tier === 'risky' ? a.audit.risky : a.audit.routine) || (st && st.leadModelDefault) || null;
  return p && p.provider && p.model ? Object.assign({ provider: String(p.provider), model: String(p.model) }, p.effort ? { effort: String(p.effort) } : {}) : null;
}
// "cross-department" or "owner: <gate>" (one of the four owner gates)
function escalationOk(line) {
  const t = String(line || '').toLowerCase().replace(/[`*_]/g, '').trim();
  if (/^cross[- ]department\b/.test(t)) return { ok: true, kind: 'cross-department' };
  const m = /^owner\s*[:—–-]?\s*([a-z]+)/.exec(t);
  if (m && OWNER_GATES.includes(m[1])) return { ok: true, kind: 'owner:' + m[1] };
  return { ok: false };
}
const readsAsEscalation = (heading, block) => /\bescalat/i.test(String(heading || '')) || field(block, 'Escalation') != null;

/* ---------------- the packet ---------------- */
function renderPacket(p) {
  const L = ['## Audit: ' + one(p.title, 80) + ' (' + p.date + ')', '**Id:** ' + p.id, '**Item:** ' + one(p.item, 200), '**From:** ' + one(p.from, 120), '**Class:** ' + (p.class || 'general'),
    '**Risk:** ' + (p.risky ? 'risky (' + one(p.riskWhy.join('; '), 200) + '): audited on your top tier' : 'routine'), p.pr ? '**PR:** ' + one(p.pr, 200) + (p.sha ? ' at ' + String(p.sha).slice(0, 12) : '') : null,
    '**Status:** OPEN', '', '### Acceptance check', String(p.check || '').trim(), '### Self-check (what ' + firstName(p.from) + ' checked)', String(p.note || '').trim(),
    p.ran.length ? p.ran.map(r => '- ran `' + one(r.cmd, 200) + '`: exit ' + r.exit).join('\n') : '- (no check command: the note above is the self-check)',
    p.tests ? '- tests: ' + one(p.tests, 400) : null, '### Diff', p.diff ? '```diff\n' + p.diff.replace(/\n+$/, '').replace(/```/g, '`​``') + '\n```' : '(no diff: ' + one(p.noDiff || 'not a code change', 200) + ')',
    '', 'Answer: node company/tools/accountable.js audit ' + p.id + ' --verdict ACCEPT|REVISE --check "<what you checked>" [--finding "<what to fix>"]... --by ' + firstName(p.leadName)];
  return '\n' + L.filter(x => x != null).join('\n') + '\n';
}
const parsePacketId = sec => (/^## Audit:/.test(String(sec)) ? (field(sec, 'Id') || '').replace(/`/g, '').trim() : '');

/* ---------------- handback (the member's self-check, then the packet) ----------------
 * o: { root, now, by (the member), item (an id, or words of its heading), note, tests?, testCmds?, diff? (text), diffFile?,
 *      cwd?, base?, pr?, sha?, noDiff? (why there is none), dry?, crew?, ceo?, timeoutSec? }
 * -> { ok, id, delivered, risky, tier } | { ok:false, code (2 refused, 3 the self-check failed), error } */
function findItem(o, inbox, want) {
  const t = readText(path.join(paths(o).handoffs, inbox)); if (t == null) return null;
  const SP = require('./sprint'); const parts = sections(t); const w = String(want || '').trim(), hits = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('## ')) continue;
    const it = SP.parseItems(parts[i])[0]; if (!it) continue;
    const id = W.itemId(inbox, it.heading, it.id), ref = itemRef(inbox, it);
    if (id === w || ref === w || it.id === w || (w.length >= 6 && it.heading.toLowerCase().includes(w.toLowerCase()))) hits.push({ i, it, id, ref, sec: parts[i], parts, text: t });
  }
  return hits.length === 1 ? hits[0] : hits.length ? { many: hits.length } : null;
}
function runCheck(cmd, cwd, timeoutSec) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: Math.max(5, Number(timeoutSec) || 600) * 1000, maxBuffer: 4 << 20, env: process.env });
  const exit = r.error && r.error.code === 'ETIMEDOUT' ? 'timeout' : r.status == null ? 'signal ' + (r.signal || '?') : r.status;
  return { cmd, exit, ok: exit === 0, tail: String((r.stdout || '') + (r.stderr || '')).split('\n').slice(-8).join('\n').slice(-800) };
}
function handback(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const by = seatOf(crew, o.by); if (!by) return bad('--by must be a crew seat');
  const ds = deptState(o), e = memberDept(by, ds, ceo);
  if (!e) { const l = leadDept(by, ds, ceo); return bad(l ? 'you lead ' + (l.d.name || l.d.id) + ': your own work goes to the CEO as before; handback is for the members a lead audits' : nameOf(crew, by) + ' is in no department whose lead audits its work (accountable leads is off)'); }
  const lead = String(e.d.lead), leadName = nameOf(crew, lead), inbox = (crew[by] || {}).inbox;
  if (!inbox) return bad(nameOf(crew, by) + ' has no inbox (loops.json)');
  const f = findItem(o, inbox, o.item);
  if (!f) return bad('no item "' + one(o.item, 80) + '" in your inbox (' + inbox + ')');
  if (f.many) return bad('"' + one(o.item, 80) + '" matches ' + f.many + ' items in your inbox: give its id');
  if (!f.it.open) return bad('that item is not OPEN');
  const check = acceptanceOf(f.sec);
  if (!check) return bad('the item names no acceptance check (**Acceptance check:**): ask ' + firstName(leadName) + ' to add one; you cannot hand back work nobody can check');
  const note = String(o.note || '').trim();
  if (note.length < (Number(e.a.selfCheck.noteMinChars) || 20)) return bad('--note "<what you checked, and how>" is required (at least ' + (Number(e.a.selfCheck.noteMinChars) || 20) + ' characters): the lead reads it with the diff');
  const all = audits(rows(o)), open = latestFor(all, f.ref);
  if (open && open.status === 'open') return bad('this item is with ' + firstName(leadName) + ' for audit already (' + open.id + ')');
  // the self-check: the item's check command and every --test-cmd are RUN; one failure and nothing goes to the lead
  const cwd = path.resolve(o.cwd || rootOf(o));
  const cmds = [checkCommandOf(f.sec)].concat([].concat(o.testCmds || [])).map(x => String(x || '').trim()).filter(Boolean);
  const ran = [];
  for (const c of cmds) {
    const r = runCheck(c, cwd, o.timeoutSec || e.a.selfCheck.timeoutSec); ran.push(r);
    if (!r.ok) {
      append({ op: 'selfcheck', at: now, ts: new Date(now).toISOString(), ok: false, ref: f.ref, item: f.id, file: inbox, seat: by, dept: String(e.d.id), cmd: one(c, 300), exit: r.exit }, o);
      return Object.assign(bad('your own check failed: `' + one(c, 120) + '` exited ' + r.exit + '. Nothing went to ' + firstName(leadName) + '; fix it and hand back again.' + (r.tail ? '\n' + r.tail : ''), 3), { selfCheck: { cmd: c, exit: r.exit } });
    }
  }
  // the diff: given, from a file, or git diff <base>...HEAD in --cwd
  let diff = o.diff != null ? String(o.diff) : null;
  if (diff == null && o.diffFile) { diff = readText(path.resolve(o.diffFile)); if (diff == null) return bad('cannot read --diff-file ' + o.diffFile); }
  if (diff == null && o.cwd) { const g = spawnSync('git', ['-C', cwd, 'diff', (o.base || 'origin/HEAD') + '...HEAD'], { encoding: 'utf8', maxBuffer: 32 << 20 }); if (g.status === 0) diff = g.stdout; }
  const cls = (() => { try { return require('./taskclass').classOf({ text: f.sec, effort: f.it.effort }, by, { departments: { departments: [e.d] } }); } catch (_) { return e.d.defaultClass || 'general'; } })();
  if (!String(diff || '').trim() && cls === 'code' && !o.noDiff) return bad('code work is handed back with its diff (--cwd <repo> [--base <ref>], or --diff-file <file>); say --no-diff "<why>" when there is none');
  const risk = riskOf({ block: f.sec, cls, diff, a: e.a });
  const tier = risk.risky ? 'risky' : 'routine';
  const id = newId('ac', now), max = Math.max(2000, Number(e.a.packetMaxChars) || 12000);
  const pr = o.pr || field(f.sec, 'PR') || null, sha = o.sha ? String(o.sha).trim().toLowerCase() : null;
  if (sha && !/^[0-9a-f]{7,64}$/.test(sha)) return bad('--sha takes the head commit');
  const pk = { id, date: dayOf(now), title: f.it.heading.replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, ''), item: f.ref, from: nameOf(crew, by), class: cls, risky: risk.risky, riskWhy: risk.why, pr, sha, check, note, tests: o.tests || '', ran, diff: String(diff || ''), noDiff: o.noDiff, leadName };
  let text = renderPacket(pk), clipped = false;
  if (text.length > max) { const over = text.length - max + 40; pk.diff = pk.diff.slice(0, Math.max(0, pk.diff.length - over)) + '\n… (clipped: the whole diff is in the branch)'; text = renderPacket(pk); clipped = true; }
  const live = e.a.effective === 'live', leadInbox = (crew[lead] || {}).inbox;
  if (live && !leadInbox) return bad('the lead ' + leadName + ' has no inbox (loops.json)');
  if (live && !o.dry) {
    fs.appendFileSync(path.join(paths(o).handoffs, leadInbox), text);
    const parts = f.parts, m = /\n*$/.exec(parts[f.i]); parts[f.i] = parts[f.i].slice(0, m.index) + '\n**Handed back:** ' + id + ' to ' + leadName + ' for audit (' + dayOf(now) + ')' + (m[0] || '\n');
    writeAtomic(path.join(paths(o).handoffs, inbox), parts.join(''));
  }
  const dsha = 'sha256:' + crypto.createHash('sha256').update(String(diff || '')).digest('hex').slice(0, 16);
  append(Object.assign({ op: 'handback', at: now, ts: new Date(now).toISOString(), id, ref: f.ref, item: f.id, file: inbox, title: one(f.it.heading, 160), seat: by, dept: String(e.d.id), lead, class: cls,
    risky: risk.risky, riskWhy: risk.why, tier, check: one(check, 600), note: one(note, 1200), tests: o.tests ? one(o.tests, 400) : undefined, ran: ran.map(r => ({ cmd: one(r.cmd, 300), exit: r.exit })),
    diffSha: dsha, diffLines: diffLines(diff), files: diffFiles(diff).slice(0, 40), pr: pr ? one(pr, 200) : undefined, sha: sha || undefined, chars: text.length, clipped: clipped || undefined, deadline: field(f.sec, 'Deadline') || undefined,
    runId: process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : undefined }, live ? {} : { shadow: true }), o);
  if (!live && !o.dry) logLine(o, 'WOULD AUDIT ' + id + ' ' + f.ref + ' (' + nameOf(crew, by) + ' -> ' + leadName + ', ' + tier + '): recording only, nothing sent');
  return { ok: true, id, delivered: live, risky: risk.risky, tier, riskWhy: risk.why, chars: text.length, next: live ? leadName + ' audits it; you are not woken for this item until then, and it is DONE only when ' + firstName(leadName) + ' accepts it' : 'recorded only (accountable leads is in recording-only mode): carry on as before' };
}
function logLine(o, text) { try { fs.appendFileSync(paths(o).log, '- ' + new Date(nowOf(o)).toISOString().slice(0, 16).replace('T', ' ') + ' ' + text + '\n'); } catch (_) {} }

/* ---------------- the lead's audit (binding) ----------------
 * o: { root, now, id, verdict: ACCEPT|REVISE, check, findings[], by (the lead), dry?, crew? } */
function editBlock(o, inbox, match, fn) {
  const f = path.join(paths(o).handoffs, inbox), t = readText(f); if (t == null) return false;
  const parts = sections(t); let hit = false;
  for (let i = 0; i < parts.length; i++) if (match(parts[i])) { const n = fn(parts[i]); if (n != null && n !== parts[i]) { parts[i] = n; hit = true; } break; }
  if (hit && !o.dry) writeAtomic(f, parts.join(''));
  return hit;
}
const setStatus = (sec, text) => /^\*\*Status:\*\*.*$/m.test(sec) ? sec.replace(/^\*\*Status:\*\*.*$/m, '**Status:** ' + text) : sec.replace(/\n*$/, '\n**Status:** ' + text + '\n');
const addLine = (sec, line) => { const m = /\n*$/.exec(sec); return sec.slice(0, m.index) + '\n' + line + (m[0] || '\n'); };
function itemMatcher(file, ref) { const SP = require('./sprint'); return sec => { if (!sec.startsWith('## ')) return false; const it = SP.parseItems(sec)[0]; return !!it && itemRef(file, it) === ref; }; }
function audit(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x) return bad('no audit ' + o.id + ' (accountable.js list --open)');
  if (x.hb.shadow) return bad(x.id + ' was recorded only (recording-only mode): there is nothing to audit');
  if (x.verdict) return bad(x.id + ' is answered already (' + x.verdict.verdict + '); an audit verdict is never changed: a new hand-back gets a new audit');
  const ds = deptState(o), e = ds.list.find(y => String(y.d.id) === x.hb.dept);
  if (!e || !leadOk(e.d, ceo)) return bad('the department ' + x.hb.dept + ' has no lead now');
  const by = seatOf(crew, o.by);
  if (by !== String(e.d.lead)) return bad('only the lead of ' + (e.d.name || e.d.id) + ' (' + nameOf(crew, e.d.lead) + ') audits its members\' work');
  if (by === x.hb.seat) return bad('nobody audits their own work');
  const verdict = String(o.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) return bad('--verdict ACCEPT|REVISE');
  const check = one(o.check, 300); if (!check) return bad('--check "<what you checked: the diff against the acceptance check>" is required');
  const findings = [].concat(o.findings || []).map(f => one(f, 300)).filter(Boolean).slice(0, 12);
  if (verdict === 'REVISE' && !findings.length) return bad('REVISE needs at least one --finding "<what to fix>"');
  const leadName = nameOf(crew, by);
  const line = '**Verdict:** ' + verdict + ' by ' + leadName + ' — check: ' + check + (findings.length ? ' — ' + findings.map((f, i) => (i + 1) + '. ' + f).join(' ') : '');
  append({ op: 'verdict', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, verdict, by, check, findings: findings.length ? findings : undefined, sha: x.hb.sha || undefined, runId: process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : undefined }, o);
  const li = (crew[by] || {}).inbox;
  if (li) editBlock(o, li, sec => parsePacketId(sec) === x.id, sec => addLine(setStatus(sec, 'DONE — ' + verdict + ' (' + dayOf(now) + ')'), line));
  editBlock(o, x.hb.file, itemMatcher(x.hb.file, x.hb.ref), sec => {
    const s = addLine(sec, line);
    return verdict === 'ACCEPT' ? setStatus(s, 'DONE — accepted by ' + leadName + ' (' + x.id + ', ' + dayOf(now) + ')') : setStatus(s, 'OPEN — sent back by ' + leadName + ' (' + x.id + '): fix the findings, check it again, hand it back');
  });
  return { ok: true, id: x.id, verdict, line, next: verdict === 'ACCEPT' ? 'the item is DONE; a merge of its change at this commit may go ahead, and you pass anything it hands on with accountable.js pass' : nameOf(crew, x.hb.seat) + ' is woken to fix it and hands it back again' };
}

/* ---------------- pass on, return, drop, escapes, spot checks ---------------- */
// a held block: { inbox, ref } written by a member of the lead's department to someone outside it
function pass(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const by = seatOf(crew, o.by), ds = deptState(o), e = by ? leadDept(by, ds, ceo) : null;
  if (!e) return bad('only a department lead passes on its team\'s work');
  const ref = String(o.ref || '').trim(), inbox = ref.split('#')[0];
  const recv = Object.keys(crew).find(k => (crew[k] || {}).inbox === inbox);
  if (!recv) return bad('--ref <inbox>#<item id> names the held block (accountable.js list --held)');
  const SP = require('./sprint'), t = readText(path.join(paths(o).handoffs, inbox)) || '';
  const sec = sections(t).find(s => { if (!s.startsWith('## ')) return false; const it = SP.parseItems(s)[0]; return it && itemRef(inbox, it) === ref; });
  if (!sec) return bad('no block ' + ref);
  const already = rows(o).find(r => (r.op === 'pass' || r.op === 'return') && r.ref === ref);
  if (already) return bad(ref + ' was ' + (already.op === 'pass' ? 'passed on' : 'returned') + ' already');
  const leadName = nameOf(crew, by);
  // the lead's Pass on block for this ref is done once it is passed on or returned
  const closePassItem = what => { const li = (crew[by] || {}).inbox; if (li) editBlock(o, li, s => String(field(s, 'Pass-on') || '').trim() === ref && /^\*\*Status:\*\*\s*OPEN/m.test(s), s => setStatus(s, 'DONE — ' + what + ' (' + dayOf(now) + ')')); };
  if (o.ret) {
    const why = one(o.why, 300); if (!why) return bad('--return needs --why "<what the member does instead>"');
    append({ op: 'return', at: now, ts: new Date(now).toISOString(), ref, by, dept: String(e.d.id), to: recv, why }, o);
    editBlock(o, inbox, s => s === sec, s => setStatus(addLine(s, '**Returned by:** ' + leadName + ' (lead): ' + why), 'DONE — returned by ' + leadName + ', not passed on'));
    closePassItem('returned');
    return { ok: true, ref, returned: true };
  }
  let esc = null;
  if (recv === String(ceo)) {
    esc = escalationOk(o.escalation);
    if (!esc.ok) return bad('one level at a time: a lead takes a member\'s matter to the CEO only when it crosses departments or is one of the four owner gates. Add --escalation cross-department or --escalation "owner: money|access|ownership|commitment", or solve it in the department and --return it');
  }
  append(Object.assign({ op: 'pass', at: now, ts: new Date(now).toISOString(), ref, by, dept: String(e.d.id), to: recv }, esc ? { escalation: esc.kind } : {}), o);
  editBlock(o, inbox, s => s === sec, s => { const L = s.split('\n'); L.splice(1, 0, '**Passed on by:** ' + leadName + ' (lead of ' + (e.d.name || e.d.id) + ', accountable for it)' + (esc ? '\n**Escalation:** ' + esc.kind : '')); return L.join('\n'); });
  closePassItem('passed on');
  return { ok: true, ref, passed: true, escalation: esc ? esc.kind : undefined };
}
function drop(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const by = seatOf(crew, o.by), ds = deptState(o), e = by ? leadDept(by, ds, ceo) : null;
  if (!e) return { ok: false, code: 2, error: 'only a department lead drops its team\'s item' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why is required' };
  append({ op: 'drop', at: now, ts: new Date(now).toISOString(), ref: String(o.ref || ''), by, dept: String(e.d.id), why }, o);
  return { ok: true, ref: o.ref, dropped: true };
}
// a problem found later in work the lead accepted: charged to the lead's review (anyone but the lead records it; the
// dispatcher records one by itself when an accepted item is reopened)
function escape(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o);
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x || x.status !== 'accepted') return { ok: false, code: 2, error: 'no accepted audit ' + o.id };
  const by = o.by === 'dispatcher' ? 'dispatcher' : seatOf(crew, o.by) || (require('./owner').isOwnerName(String(o.by || '')) ? 'owner' : null);
  if (!by) return { ok: false, code: 2, error: '--by must be a crew seat or the owner' };
  if (by === x.verdict.by) return { ok: false, code: 2, error: 'the lead does not record escapes against its own review' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why "<what was found>" is required' };
  if (x.escapes.some(r => r.why === why)) return { ok: true, id: x.id, duplicate: true };
  append({ op: 'escape', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, lead: x.verdict.by, by, why }, o);
  return { ok: true, id: x.id, escape: true, chargedTo: x.verdict.by };
}
function spot(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o);
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x || x.status !== 'accepted') return { ok: false, code: 2, error: 'no accepted audit ' + o.id };
  const by = seatOf(crew, o.by); if (!by) return { ok: false, code: 2, error: '--by must be a crew seat' };
  if (by === x.verdict.by || by === x.hb.seat) return { ok: false, code: 2, error: 'a spot check is done by someone other than the lead and the member' };
  const result = String(o.result || '').toLowerCase(); if (!['agree', 'disagree'].includes(result)) return { ok: false, code: 2, error: '--result agree|disagree' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why "<what you checked>" is required' };
  if (x.spots.some(s => s.by === by)) return { ok: false, code: 2, error: 'you answered this spot check already' };
  append({ op: 'spot', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, lead: x.verdict.by, by, result, why }, o);
  const ib = (crew[by] || {}).inbox; if (ib) editBlock(o, ib, s => String(field(s, 'Spot check') || '').trim() === x.id && /^\*\*Status:\*\*\s*OPEN/m.test(s), s => setStatus(s, 'DONE — ' + result + ' (' + dayOf(now) + ')'));
  return { ok: true, id: x.id, result };
}

/* ---------------- the dispatcher's step: intake, holds, spot picks ---------------- */
function readState(o) { const s = readJson(paths(o).state, null); return Object.assign({ v: 1, seen: {}, copied: {}, doneHeld: {}, passAsked: {}, escNoted: {}, spots: {}, autoEscapes: {}, would: {}, routines: {}, lastAudit: {}, fellBack: {} }, s && typeof s === 'object' ? s : {}); }
function writeState(st, o) {
  if (o.dry) return;
  const doc = 'Accountable leads (lib/accountable.js, written by the dispatcher): items seen per department (how they came in), the copies sent to leads, DONEs put back, pass-on and escalation notes, spot checks picked, the audit routines and the last audit run.';
  const f = paths(o).state, text = JSON.stringify(Object.assign({ _doc: doc }, st), null, 1) + '\n';
  writeAtomic(f, text); try { require('../provenance.js').wrote(f, text, WRITER, { root: rootOf(o) }); } catch (_) {}
}
function appendBlock(o, inbox, heading, fields) {
  if (!inbox || o.dry) return;
  const f = path.join(paths(o).handoffs, inbox);
  fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Handoffs\n');
  fs.appendFileSync(f, '\n## ' + dayOf(nowOf(o)) + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + v).join('\n') + '\n');
}
function scanTick(o) {
  o = o || {}; const log = typeof o.log === 'function' ? o.log : () => {};
  const crew = crewOf(o), ceo = ceoOf(o, crew); let ds; try { ds = deptState(o); } catch (_) { return () => null; }
  const on = ds.list.filter(e => e.a.mode !== 'off' && leadOk(e.d, ceo));
  if (!on.length) return () => null;
  const now = nowOf(o), SP = require('./sprint'), SO = require('./signoff');
  const st = readState(o), rs = rows(o), all = audits(rs), holds = new Map(); let dirty = false;
  let calls = o.calls; if (!Array.isArray(calls)) { try { calls = require('../provenance.js').recentCalls(rootOf(o), now - 7 * DAY); } catch (_) { calls = []; } }
  const passed = new Set(rs.filter(r => r.op === 'pass' || r.op === 'return').map(r => r.ref));
  const dropped = new Set(rs.filter(r => r.op === 'drop').map(r => r.ref));
  const hold = (inbox, heading, v) => holds.set(inbox + '\n' + heading, v);
  const would = (key, text) => { if (st.would[key]) return; st.would[key] = new Date(now).toISOString(); dirty = true; log(text); };
  const texts = new Map(); const textOf = ib => { if (!texts.has(ib)) texts.set(ib, readText(path.join(paths(o).handoffs, ib)) || ''); return texts.get(ib); };
  for (const e of on) {
    const dept = String(e.d.id), lead = String(e.d.lead), leadName = nameOf(crew, lead), live = e.a.effective === 'live', leadInbox = (crew[lead] || {}).inbox;
    const members = D.members(e.d).filter(s => s !== lead && crew[s]);
    const inDept = new Set(members.concat([lead]));
    try {
      // the first tick a department is on: the work already there is noted as from before (no copies, no holds on it)
      if (!(st.started = st.started || {})[dept]) {
        for (const m of members) { const ib = (crew[m] || {}).inbox; if (!ib) continue; for (const it of SP.parseItems(textOf(ib))) { const ref = itemRef(ib, it); if (!st.seen[ref]) st.seen[ref] = { via: 'before', dept, at: now }; } }
        for (const [rid, c] of Object.entries(crew)) { if (!c || !c.inbox || inDept.has(rid)) continue; for (const it of SP.parseItems(textOf(c.inbox)).filter(i => i.open)) st.seen['out:' + itemRef(c.inbox, it)] = { via: 'before', dept, at: now }; }
        st.started[dept] = new Date(now).toISOString(); dirty = true;
        log('ACCOUNTABLE ' + dept + ' (' + leadName + '): ' + (live ? 'on' : 'recording only') + ' from now; the work already open is left as it was');
        continue;
      }
      // the audit packets in the lead's inbox are the audit run's work, not its loop's (live, once the routine exists)
      if (live && leadInbox && st.routines[dept]) for (const it of SP.parseItems(textOf(leadInbox)).filter(i => i.open && AUDIT_HEAD.test(i.heading))) hold(leadInbox, it.heading, { who: null, packet: true, kind: 'audit-packet' });
      for (const m of members) {
        const ib = (crew[m] || {}).inbox; if (!ib) continue;
        const txt = textOf(ib); const secs = new Map(sections(txt).filter(s => s.startsWith('## ')).map(s => [s.slice(3).split('\n')[0].trim(), s]));
        for (const it of SP.parseItems(txt)) {
          if (isDispatcherBlock(it.heading)) continue;
          const ref = itemRef(ib, it), sec = secs.get(it.heading) || '', seen = st.seen[ref];
          const last = latestFor(all, ref);
          // 1. intake: how open work reached the member
          if (it.open && !seen) {
            const writer = SO.writerFor(it.heading, crew, calls);
            const via = writer === lead ? 'lead' : writer && writer !== m ? 'direct' : null;
            if (!via) { st.seen[ref] = { via: 'self', dept, at: now }; dirty = true; continue; }
            st.seen[ref] = { via, dept, at: now, writer }; dirty = true;
            append({ op: 'intake', at: now, ts: new Date(now).toISOString(), ref, file: ib, title: one(it.heading, 160), seat: m, dept, lead, via, writer, shadow: live ? undefined : true }, o);
            // the member learns the way back on the item itself: check it, then hand it back to the lead (live)
            if (live && field(sec, 'Hand back') == null) { editBlock(o, ib, s => s === sec, s => addLine(s, '**Hand back:** to ' + leadName + ' for audit when it is done: check it against its acceptance check, then node company/tools/accountable.js handback ' + (it.id || ref) + ' --note "<what you checked>" --by ' + firstName(nameOf(crew, m)) + ' (it is DONE only when ' + firstName(leadName) + ' accepts it)' + (acceptanceOf(sec) ? '' : '. It has no acceptance check yet: ask ' + firstName(leadName) + ' for one'))); texts.delete(ib); }
            if (via === 'direct') {
              if (live && !st.copied[ref]) {
                appendBlock(o, leadInbox, 'copy: ' + one(it.heading.replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, ''), 90) + ' (sent straight to ' + firstName(nameOf(crew, m)) + ')', {
                  'Copy of': ref, FYI: nameOf(crew, writer) + ' sent this straight to ' + nameOf(crew, m) + '. It counts as yours: ' + firstName(nameOf(crew, m)) + ' hands it back to you for audit, and it is done only when you accept it. Reassign it or add its acceptance check if it needs one.',
                  Status: 'DONE — a copy for the record (the work is in ' + ib + ')' });
                st.copied[ref] = new Date(now).toISOString(); log('ACCOUNTABLE COPY ' + ref + ' -> ' + leadName + ': sent straight to ' + nameOf(crew, m) + ' by ' + nameOf(crew, writer));
              } else if (!live) would('copy:' + ref, 'WOULD COPY ' + ref + ' to ' + leadName + ' (sent straight to ' + nameOf(crew, m) + ' by ' + nameOf(crew, writer) + '; recording only)');
            }
            continue;
          }
          if (!seen || seen.via === 'self' || seen.via === 'before') continue;
          // 2. handed back and waiting for the audit: the member is not woken for it
          if (it.open && last && last.status === 'open' && !last.hb.shadow && live) { hold(ib, it.heading, { who: leadName, kind: 'audit' }); continue; }
          // 3. DONE without the lead's ACCEPT: put back to OPEN (live), once per closing
          if (!it.open && !(last && last.status === 'accepted') && !dropped.has(ref) && seen.dept === dept) {
            const key = ref + ':' + crypto.createHash('sha1').update(String(it.status || '')).digest('hex').slice(0, 10);
            if (/^DONE\b/i.test(String(it.status || '')) && !st.doneHeld[key]) {
              if (live) {
                editBlock(o, ib, s => s === sec, s => setStatus(s, 'OPEN — not done until ' + leadName + ' accepts it: check it against its acceptance check, then hand it back (node company/tools/accountable.js handback ' + (it.id || ref) + ' --note "<what you checked>" --by ' + firstName(nameOf(crew, m)) + ')'));
                texts.delete(ib);
                append({ op: 'done-held', at: now, ts: new Date(now).toISOString(), ref, seat: m, dept, lead, status: one(it.status, 120) }, o);
                st.doneHeld[key] = new Date(now).toISOString(); dirty = true;
                log('ACCOUNTABLE DONE HELD ' + ref + ' (' + nameOf(crew, m) + '): set DONE without ' + leadName + '\'s accept; back to OPEN');
              } else would('done:' + key, 'WOULD HOLD DONE ' + ref + ' (' + nameOf(crew, m) + '): no accept from ' + leadName + ' (recording only)');
            }
          }
          // 4. an accepted item reopened later: an escape, charged to the lead's review (once per audit)
          if (it.open && last && last.status === 'accepted' && !st.autoEscapes[last.id]) {
            st.autoEscapes[last.id] = new Date(now).toISOString(); dirty = true;
            const r = escape({ root: rootOf(o), now, id: last.id, by: 'dispatcher', why: 'the accepted item was reopened (' + one(it.status, 100) + ')', crew, dry: o.dry });
            if (r.ok) log('ACCOUNTABLE ESCAPE ' + last.id + ' ' + ref + ': accepted by ' + leadName + ', reopened since; charged to the lead\'s review');
          }
        }
      }
      // 5. onward handoffs: a member's open block to anyone outside the department waits for the lead to pass it on
      for (const [rid, c] of Object.entries(crew)) {
        if (!c || !c.inbox || inDept.has(rid)) continue;
        const txt = textOf(c.inbox); const secs = new Map(sections(txt).filter(s => s.startsWith('## ')).map(s => [s.slice(3).split('\n')[0].trim(), s]));
        for (const it of SP.parseItems(txt).filter(i => i.open)) {
          if (isDispatcherBlock(it.heading)) continue;
          const sec = secs.get(it.heading) || '', ref = itemRef(c.inbox, it);
          if (passed.has(ref) || field(sec, 'Passed on by') != null || st.seen['out:' + ref]) continue;
          const writer = SO.writerFor(it.heading, crew, calls);
          if (writer === lead && rid === String(ceo) && readsAsEscalation(it.heading, sec) && !escalationOk(field(sec, 'Escalation')).ok) {
            // the lead's own escalation to the CEO names no reason that belongs there
            if (live) {
              hold(c.inbox, it.heading, { who: leadName, kind: 'escalation' });
              if (!st.escNoted[ref]) { appendBlock(o, leadInbox, 'escalation held: ' + one(it.heading, 90), { Need: 'Your escalation to ' + nameOf(crew, ceo) + ' ("' + one(it.heading, 120) + '") is held: one level at a time, a lead takes a matter to the CEO only when it crosses departments or is one of the four owner gates. Add **Escalation:** cross-department or **Escalation:** owner: money|access|ownership|commitment to that block, or solve it in the department and set it DONE.', Status: 'OPEN' }); st.escNoted[ref] = new Date(now).toISOString(); dirty = true; log('ACCOUNTABLE ESCALATION HELD ' + ref + ' (' + leadName + ' -> CEO): no cross-department or owner-gate reason'); }
            } else would('esc:' + ref, 'WOULD HOLD ESCALATION ' + ref + ' (' + leadName + ' -> CEO): no cross-department or owner-gate reason (recording only)');
            continue;
          }
          if (!writer || !members.includes(writer) || SO.isFyi(sec, it.heading)) continue;
          if (live) {
            hold(c.inbox, it.heading, { who: leadName, kind: 'pass' });
            if (!st.passAsked[ref]) {
              const toCeo = rid === String(ceo);
              appendBlock(o, leadInbox, 'Pass on: ' + one(it.heading.replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, ''), 80) + ' (' + firstName(nameOf(crew, writer)) + ' -> ' + firstName(nameOf(crew, rid)) + ')', {
                'Pass-on': ref, Need: nameOf(crew, writer) + ' wrote to ' + nameOf(crew, rid) + ' ("' + one(it.heading, 120) + '" in ' + c.inbox + '). It waits for you: work leaves the department through its lead. Pass it on (node company/tools/accountable.js pass ' + ref + (toCeo ? ' --escalation cross-department|"owner: money|access|ownership|commitment"' : '') + ' --by ' + firstName(leadName) + ') once the work behind it is accepted, or return it (--return --why "<what to do instead>").' + (toCeo ? ' It goes to the CEO, so it passes only when it crosses departments or is one of the four owner gates.' : ''),
                Status: 'OPEN' });
              st.passAsked[ref] = new Date(now).toISOString(); dirty = true;
              log('ACCOUNTABLE PASS HELD ' + ref + ' (' + nameOf(crew, writer) + ' -> ' + nameOf(crew, rid) + '): waits for ' + leadName + ' to pass it on');
            }
          } else would('pass:' + ref, 'WOULD HOLD ' + ref + ' (' + nameOf(crew, writer) + ' -> ' + nameOf(crew, rid) + ') for ' + leadName + ' to pass on (recording only)');
        }
      }
      // 6. spot checks: 1 in spotCheckEvery accepts (in time order) is checked again by the people function
      const every = Math.max(0, Number(e.a.scorecard.spotCheckEvery) || 0);
      if (live && every > 0) {
        const acc = [...all.values()].filter(x => x.hb.dept === dept && x.status === 'accepted').sort((a, b) => Number(a.verdict.at) - Number(b.verdict.at));
        const people = peopleOf(crew), checker = people && people !== lead ? people : (crew[lead] || {}).manager || ceo;
        acc.forEach((x, i) => {
          if ((i + 1) % every !== 0 || st.spots[x.id] || !crew[checker] || checker === x.hb.seat) return;
          appendBlock(o, (crew[checker] || {}).inbox, 'spot check: ' + one(x.hb.title.replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, ''), 80) + ' (accepted by ' + firstName(leadName) + ')', {
            'Spot check': x.id, Need: 'Check again, cheaply, one item ' + leadName + ' accepted: ' + x.hb.ref + ' (acceptance check: ' + one(x.hb.check, 200) + '). Read the change against that check and answer: node company/tools/accountable.js spot ' + x.id + ' --result agree|disagree --why "<what you checked>" --by ' + firstName(nameOf(crew, checker)) + '. It goes on ' + firstName(leadName) + '\'s department scorecard, so rubber-stamping shows.',
            Status: 'OPEN' });
          st.spots[x.id] = new Date(now).toISOString(); dirty = true; log('ACCOUNTABLE SPOT CHECK ' + x.id + ' -> ' + nameOf(crew, checker));
        });
      }
    } catch (err) { log('ACCOUNTABLE ERROR (' + dept + '): ' + String(err && err.message || err).slice(0, 200)); }
  }
  if (dirty) writeState(st, o);
  return (inbox, it) => (it ? holds.get(inbox + '\n' + it.heading) || null : null);
}

/* ---------------- merge-gate.js ---------------- */
// a member of a live department merges only a change its lead accepted at this commit; shadow records the would-refuse
function gate(a, o) {
  o = o || {}; const crew = crewOf(o), ceo = ceoOf(o, crew);
  const seat = seatOf(crew, a.seat); if (!seat) return { needed: false };
  let ds; try { ds = deptState(o); } catch (_) { return { needed: false }; }
  const e = memberDept(seat, ds, ceo); if (!e) return { needed: false };
  const norm = r => { const m = String(r || '').match(/([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)/); return m ? m[1].toLowerCase() + '#' + m[2] : String(r || '').toLowerCase(); };
  const want = (a.refs || []).map(norm), sha = String(a.sha || '').toLowerCase();
  const acc = [...audits(rows(o)).values()].filter(x => x.status === 'accepted' && x.hb.seat === seat && x.hb.pr && want.includes(norm(x.hb.pr)));
  const ok = acc.find(x => !sha || !x.hb.sha || sha.startsWith(x.hb.sha) || x.hb.sha.startsWith(sha));
  const leadName = nameOf(crew, e.d.lead);
  if (ok) return { needed: true, cleared: true, mode: e.a.effective, audit: ok.id };
  const stale = acc.length > 0;
  const why = nameOf(crew, seat) + '\'s work is audited by ' + leadName + ' (the lead of ' + (e.d.name || e.d.id) + '), and there is no accept for ' + (want[0] || 'this pull request') + (stale ? ' at this commit (the accept was for an earlier one: hand it back again)' : '') + ': hand it back with node company/tools/accountable.js handback <item> --pr <url> --sha <head> --note ".." --by ' + firstName(nameOf(crew, seat)) + ', and merge once ' + firstName(leadName) + ' accepts';
  if (e.a.effective === 'live') return { needed: true, cleared: false, mode: 'live', refuse: why };
  return { needed: true, cleared: false, mode: e.a.effective, would: true, why };
}

/* ---------------- the audit run (door audit) ---------------- */
function template(o) { return readText(paths(o).template) || readText(paths(o).templateDefault) || 'You are {{LEAD}}, the lead of {{DEPT_NAME}}: audit the open Audit blocks in your inbox with node company/tools/accountable.js audit.\n\n' + AUDIT_LINE + ' (none)\n'; }
const auditLine = ids => AUDIT_LINE + ' ' + (ids && ids.length ? ids.join(', ') + ' (in your inbox).' : '(none)');
function auditPrompt(o) {
  const t = String(o.template != null ? o.template : template(o)).replace(/\{\{LEAD\}\}/g, o.lead).replace(/\{\{DEPT_ID\}\}/g, o.deptId).replace(/\{\{DEPT_NAME\}\}/g, o.deptName || o.deptId);
  const L = t.replace(/\s+$/, '').split('\n'); const i = L.map(l => l.startsWith(AUDIT_LINE)).lastIndexOf(true);
  if (i >= 0) L[i] = auditLine(o.ids); else L.push('', auditLine(o.ids));
  return L.join('\n') + '\n';
}
function withOwnText(current, own) { const s = String(current || ''); const i = s.indexOf(AUDIT_LINE); if (i < 0) return own; const j = s.indexOf('\n', i); return own.replace(/\n$/, '') + (j < 0 ? '' : s.slice(j)); }
// the pairs a live lead's audit run may use as a one-run override (lib/override-allow.js)
function leadEntries(seatId, o) {
  try {
    const ds = deptState(o), e = ds.list.find(x => x.d.lead && String(x.d.lead) === String(seatId) && x.a.effective === 'live');
    if (!e) return [];
    const out = []; for (const t of ['routine', 'risky']) { const p = auditPair(t, e.a, ds.st); if (p && !out.some(q => q.provider === p.provider && q.model === p.model)) out.push(p); }
    return out;
  } catch (_) { return []; }
}
const pendingAudits = (all, dept) => [...all.values()].filter(x => x.hb.dept === dept && x.status === 'open' && !x.hb.shadow);
async function auditStep(ctx) {
  const o = { root: rootOf(ctx), dry: !!ctx.dry, now: nowOf(ctx) };
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const crew = crewOf(o), ds = deptState(o), ceo = ceoOf(ctx, crew), st = readState(o), st0 = JSON.stringify(st);
  const live = ds.list.filter(e => e.a.effective === 'live' && leadOk(e.d, ceo));
  if (!live.length && !Object.keys(st.routines || {}).length && !ds.list.some(e => e.a.mode !== 'off')) return { live: 0 };
  const jobs = ctx.jobs || [], now = o.now, out = { live: live.length, ran: [], held: [], fellBack: [] };
  const ST = require('./station'), SCHED = require('./scheduler'), A = require('./admit'), C = require('./consult');
  // the audit routines: one per live lead ("<Lead> lead audit", never scheduled by the station)
  const want = new Map(live.map(e => [String(e.d.id), e]));
  for (const [dept, r] of Object.entries(st.routines)) {
    const e = want.get(dept);
    if (e && String(e.d.lead) === r.lead && jobs.some(j => j.id === r.jobId)) continue;
    if (jobs.some(j => j.id === r.jobId)) { if (o.dry) { log('WOULD remove the audit routine "' + r.name + '"'); continue; } const x = await ST.cron(ctx.call, 'POST', '/api/cron/remove', { id: r.jobId }, 'remove "' + r.name + '"'); log(x.ok ? 'AUDIT ROUTINE removed "' + r.name + '"' : 'AUDIT ROUTINE ERROR: ' + x.reason); if (!x.ok) continue; }
    delete st.routines[dept];
  }
  const tmpl = template(o);
  for (const [dept, e] of want) {
    if (st.routines[dept]) continue;
    const leadName = nameOf(crew, e.d.lead);
    const spec = SCHED.adviseSpec({ root: o.root, agentId: String(e.d.lead), leadName, suffix: e.a.routine || 'lead audit', prompt: auditPrompt({ template: tmpl, lead: leadName, deptId: dept, deptName: e.d.name, ids: [] }), model: ds.st.leadModelDefault });
    if (o.dry) { log('WOULD create the audit routine "' + spec.name + '"'); continue; }
    const r = await ST.createRoutine(ctx.call, spec, { what: 'create "' + spec.name + '"', rename: () => ST.uniqueName(spec.name, 2), attempts: 3 });
    if (r.ok) { st.routines[dept] = { jobId: r.job.id, lead: String(e.d.lead), name: r.name, at: new Date(now).toISOString() }; jobs.push(r.job); log('AUDIT ROUTINE created "' + r.name + '" for ' + leadName + ' (the dispatcher starts it)'); }
    else log('AUDIT ROUTINE ERROR: ' + r.reason);
  }
  const all = audits(rows(o)), ran = new Set(rows(o).filter(r => r.op === 'auditrun' && !r.shadow).flatMap(r => r.ids || []));
  const order = Array.isArray(ctx.order) ? ctx.order : [], say = typeof ctx.say === 'function' ? ctx.say : () => {};
  const dropSeat = id => { const i = order.indexOf(id); if (i >= 0) order.splice(i, 1); };
  for (const e of live) {
    const dept = String(e.d.id), lead = String(e.d.lead), leadName = nameOf(crew, lead);
    try {
      const r = st.routines[dept], job = r && jobs.find(j => j.id === r.jobId); if (!job) continue;
      const loopJob = crew[lead] && crew[lead].loop ? SCHED.crewLoopOf(jobs, crew[lead].loop) : null;
      const busy = !!(job.inFlight || job.state === 'running'), loopBusy = !!(loopJob && (loopJob.inFlight || loopJob.state === 'running'));
      if (busy) { dropSeat(lead); say(lead, { state: 'working' }); continue; }
      const open = pendingAudits(all, dept).filter(x => !ran.has(x.id));
      for (const tier of ['risky', 'routine']) {
        const mine = open.filter(x => x.hb.tier === tier); if (!mine.length) continue;
        const bd = C.batchDue({ pending: mine.map(x => ({ id: x.id, at: x.hb.at })), lastAdvise: st.lastAudit[dept], inFlight: loopBusy ? leadName + '\'s own loop is running' : false, batch: e.a.batch, now });
        if (!bd.start) continue;
        const pair = auditPair(tier, e.a, ds.st), ids = mine.map(x => x.id);
        if (!pair) { log('AUDIT HOLD ' + leadName + ' (' + tier + '): no audit model is set and the department has no lead model'); out.held.push(dept); break; }
        // the fixed pair, or wait: an audit is never moved to another model (no router chooses it)
        const classes = ['review'].concat(e.d.defaultClass && e.d.defaultClass !== 'review' ? [String(e.d.defaultClass)] : []);
        let shut = null;
        if (classes.includes('code') && pair.provider === 'custom') shut = 'code is never audited on the MiniMax plan';
        if (!shut) try { const R = require('./routing'); const L = R.loadPolicy(o.root); if (L) for (const c of classes) if (!R.routeAllowed(c, { provider: pair.provider, model: pair.model }, R.knobs(L.policy))) { shut = 'the class rules deny it for ' + c + ' work'; break; } } catch (_) {}
        if (!shut) shut = require('./override-allow').openFor(lead, pair, { root: o.root });
        if (!shut) shut = require('./delegate-allow').moneyFn(ctx.budget)(lead, pair.provider);
        if (!shut && ctx.modes && ctx.modes[lead] === 'ask' && !ctx.allowAsk) shut = 'its approval mode is "ask", so an unattended run could not save anything';
        if (shut) { log('AUDIT HOLD ' + leadName + ' (' + tier + ', ' + pair.provider + '/' + pair.model + '): ' + shut + '; the audit waits for its own model'); out.held.push(dept); break; }
        if (o.dry) { log('WOULD start ' + job.name + ' for ' + leadName + ' (' + tier + ': ' + ids.join(', ') + ')'); break; }
        const prompt = withOwnText(job.prompt, auditPrompt({ template: tmpl, lead: leadName, deptId: dept, deptName: e.d.name, ids }));
        if (prompt !== job.prompt) { const u = await ST.cron(ctx.call, 'POST', '/api/cron/update', { id: job.id, patch: { prompt } }, 'update "' + job.name + '"'); if (!u.ok) { log('AUDIT ERROR: ' + u.reason); break; } job.prompt = prompt; }
        const why = 'audit ' + ids.join(', ');
        const tk = A.admit({ door: 'audit', kind: 'run', seat: lead, jobId: job.id, provider: pair.provider, why: why.slice(0, 200) });
        if (tk.decision === 'hold') { log('AUDIT HOLD ' + job.name + ': ' + tk.reason); break; }
        const res = await ctx.fireRun(job.id, pair);
        const runId = res.status === 200 ? W.runIdOf(res.body) : null;
        A.started(tk, Object.assign({}, res, { runId }));
        if (res.status !== 200) { log('AUDIT HOLD ' + job.name + ' for ' + leadName + ': the station refused ' + pair.provider + '/' + pair.model + ' (HTTP ' + res.status + '); the audit waits for its own model'); break; }
        const wakeId = W.newWakeId(now);
        W.record({ wakeId, seat: lead, runId, admitId: tk.id, jobId: job.id, door: 'audit', items: mine.map(x => ({ file: x.hb.file, id: x.hb.item, title: x.hb.title, due: null })), why });
        append({ op: 'auditrun', at: now, ts: new Date(now).toISOString(), ids, dept, lead, tier, pair, wakeId, runId, admitId: tk.id }, o);
        st.lastAudit[dept] = now; out.ran.push(dept + ':' + tier); dropSeat(lead); say(lead, { state: 'working' });
        log('AUDIT ' + job.name + ' for ' + leadName + ' (' + tier + ' on ' + pair.provider + '/' + pair.model + (pair.effort ? '@' + pair.effort : '') + '): ' + ids.join(', ') + ' — ' + bd.why);
        break;   // one audit run per department per tick
      }
    } catch (err) { log('AUDIT ERROR (' + dept + '): ' + String(err && err.message || err).slice(0, 200)); }
  }
  // the saving did not show (model-rank.js accountableEvaluation): back to recording only, once per evaluation hash
  const ev = readJson(paths(o).evaluation, null);
  for (const r of ((ev && ev.accountable && ev.accountable.departments) || [])) {
    const e = ds.list.find(x => String(x.d.id) === String(r.dept));
    if (!e || e.a.mode !== 'live' || e.a.withdrawn || r.verdict !== 'fall back' || !r.hash || st.fellBack[r.dept] === r.hash) continue;
    const bar = one((r.reasons || []).join('; '), 280) || 'the saving did not show';
    if (o.dry) { log('WOULD fall ' + r.dept + ' back from accountable leads: ' + bar); continue; }
    st.fellBack[r.dept] = r.hash;
    let res; try { res = require('../departments.js').run(['accountable', r.dept, 'withdraw', '--by', 'dispatcher', '--auto', '--why', bar, '--hash', String(r.hash)]); } catch (err) { res = { code: 1, out: { error: err.message } }; }
    if (res.code !== 0) { log('ACCOUNTABLE FALLBACK ERROR (' + r.dept + '): ' + ((res.out && res.out.error) || 'failed')); continue; }
    out.fellBack.push(r.dept);
    const leadName = nameOf(crew, e.d.lead);
    log('ACCOUNTABLE FALLBACK ' + r.dept + ' (' + leadName + '): ' + bar + ' (evaluation ' + String(r.hash).slice(0, 19) + '; only the owner turns it back on)');
    try { require('./owner-notice').send({ kind: 'fyi', from: 'the dispatcher', text: fallbackWords(leadName, e.d.name || r.dept), technical: 'accountableEvaluation ' + r.dept + ': ' + bar, key: 'accountable-fallback:' + r.dept + ':' + r.hash }); } catch (_) {}
  }
  if (JSON.stringify(st) !== st0) writeState(st, o);
  return out;
}
const fallbackWords = (lead, dept) => 'The crew stopped having ' + lead + ' check every finished job in ' + dept + ': it did not cost less than ' + lead + ' doing the work alone. You can turn it back on from the ' + dept + ' card.';

/* ---------------- the department scorecard (on the lead) ---------------- */
function runCosts(o, since) {
  const B = require('./bounded'), cost = new Map(), byWake = new Map();
  let runs = [], wakes = []; try { runs = B.jsonlWindow(paths(o).runs, { sinceMs: since - DAY }).rows; } catch (_) {}
  try { wakes = B.jsonlWindow(paths(o).wakes, { sinceMs: since - DAY, tsOf: r => Number(r.at) || 0 }).rows; } catch (_) {}
  const usd = new Map(runs.filter(r => r && r.runId).map(r => [String(r.runId), { usd: Math.max(0, Number(r.usd) || 0), tokens: Math.max(0, Number(r.tokens) || 0) }]));
  for (const w of wakes) { if (!w || !w.runId || !usd.has(String(w.runId))) continue; const items = (w.items || []).filter(i => i && i.id); if (!items.length) continue; const c = usd.get(String(w.runId)); for (const i of items) { const k = String(i.id), x = cost.get(k) || { usd: 0, tokens: 0, audit: 0 }; x.usd += c.usd / items.length; x.tokens += c.tokens / items.length; if (w.door === 'audit') x.audit += c.usd / items.length; cost.set(k, x); } byWake.set(w.wakeId, w); }
  return cost;
}
function scorecard(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const ds = deptState(o), e = ds.list.find(x => String(x.d.id) === String(o.dept));
  if (!e) return null;
  const days = Math.max(1, Number(e.a.scorecard.days) || 28), since = now - days * DAY;
  const all = [...audits(rows(o)).values()].filter(x => x.hb.dept === String(e.d.id) && Number(x.hb.at) >= since && !x.hb.shadow);
  const done = all.filter(x => x.verdict), acc = done.filter(x => x.status === 'accepted'), rev = done.filter(x => x.status === 'revise');
  const withDl = acc.filter(x => /^\d{4}-\d{2}-\d{2}/.test(String(x.hb.deadline || '')));
  const onTime = withDl.filter(x => dayOf(Number(x.verdict.at)) <= String(x.hb.deadline).slice(0, 10));
  const cost = runCosts(o, since);
  const items = new Set(acc.map(x => x.hb.item)); let usd = 0, tokens = 0, audit = 0;
  for (const i of items) { const c = cost.get(i); if (c) { usd += c.usd; tokens += c.tokens; audit += c.audit; } }
  const escapes = acc.reduce((n, x) => n + x.escapes.length, 0), spots = acc.flatMap(x => x.spots), disagree = spots.filter(s => s.result === 'disagree').length;
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const sc = { dept: String(e.d.id), name: e.d.name || e.d.id, lead: e.d.lead || null, leadName: e.d.lead ? nameOf(crew, e.d.lead) : null, mode: e.a.mode, effective: e.a.effective, withdrawn: e.a.withdrawn, since: e.a.since, days,
    handedBack: all.length, audited: done.length, accepted: acc.length, sentBack: rev.length, sentBackRate: done.length ? r4(rev.length / done.length) : null,
    onTime: withDl.length ? { onTime: onTime.length, withDeadline: withDl.length } : null, costPerAccepted: acc.length ? { usd: r4(usd / acc.length), tokens: Math.round(tokens / acc.length), auditUsd: r4(audit / acc.length) } : null,
    escapes, escapeRate: acc.length ? r4(escapes / acc.length) : null, spotChecks: { done: spots.length, disagree }, selfCheckFails: rows(o).filter(r => r.op === 'selfcheck' && r.dept === String(e.d.id) && Number(r.at) >= since).length,
    openAudits: pendingAudits(audits(rows(o)), String(e.d.id)).length, enough: acc.length >= (Number(e.a.scorecard.minItems) || 10) };
  sc.words = scorecardWords(sc);
  return sc;
}
// the card's plain lines (checked by lib/owner-scope.js wordsProblems in the tests)
function scorecardWords(sc) {
  const L = sc.leadName || 'the lead', out = [];
  if (!sc.accepted && !sc.sentBack) { out.push('Nothing finished has been checked by ' + L + ' yet in the last ' + sc.days + ' days.'); return out; }
  out.push(L + ' checked ' + sc.audited + ' finished ' + (sc.audited === 1 ? 'job' : 'jobs') + ' in the last ' + sc.days + ' days: ' + sc.accepted + ' accepted, ' + sc.sentBack + ' sent back to be fixed.');
  if (sc.onTime) out.push('On time: ' + sc.onTime.onTime + ' of the ' + sc.onTime.withDeadline + ' with a deadline.');
  if (sc.costPerAccepted && sc.costPerAccepted.usd > 0) out.push('Cost per accepted job: about $' + (sc.costPerAccepted.usd < 1 ? sc.costPerAccepted.usd.toFixed(2) : sc.costPerAccepted.usd.toFixed(1)) + ', checking included.');
  out.push(sc.escapes ? sc.escapes + ' problem' + (sc.escapes === 1 ? ' was' : 's were') + ' found later in work ' + L + ' accepted; they count against ' + L + '\'s checking.' : 'No problems found later in the work ' + L + ' accepted.');
  if (sc.spotChecks.done) out.push('Second looks at accepted work: ' + sc.spotChecks.done + ', and ' + (sc.spotChecks.disagree ? sc.spotChecks.disagree + ' disagreed with ' + L : 'all agreed with ' + L) + '.');
  if (sc.audited >= 5 && sc.sentBack === 0 && !sc.spotChecks.disagree) out.push(L + ' has sent nothing back yet; the second looks show whether that is earned.');
  return out;
}
function status(o) {
  o = o || {}; const ds = deptState(o), out = [];
  for (const e of ds.list) { if (o.dept && String(e.d.id) !== String(o.dept)) continue; const sc = scorecard(Object.assign({}, o, { dept: e.d.id })); if (sc) out.push(Object.assign(sc, { audit: e.a.audit, risk: e.a.risk })); }
  return { ok: true, at: new Date(nowOf(o)).toISOString(), departments: out };
}

module.exports = { WRITER, VERDICTS, OWNER_GATES, AUDIT_LINE, paths, rows, append, audits, acceptanceOf, checkCommandOf, riskOf, auditPair, escalationOk, readsAsEscalation, diffFiles, diffLines,
  renderPacket, handback, audit, pass, drop, escape, spot, scanTick, gate, leadEntries, auditPrompt, template, withOwnText, auditStep, scorecard, scorecardWords, status, fallbackWords, readState };
