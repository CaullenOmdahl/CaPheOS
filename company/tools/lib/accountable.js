'use strict';
/* lib/accountable.js — accountable leads (docs/DEPARTMENTS.md §8; the owner's 2026-11-19 direction: "the middle management
 * leads ... are going to be fully responsible for the employees that work underneath them ... review the work ... and then
 * pass it to where it needs to go ... the big thing with the middle management is that it should have accountability").
 *
 * The pathway, per department (departments.json accountable, lib/departments.js accountableOf; off | shadow | live):
 *   1. intake through the lead   work for a member that the lead did not assign (sent straight to the member, written by
 *                                the member itself, or by a writer nobody can tell) is recorded as the lead's and copied to
 *                                the lead's inbox (a DONE copy: for the record, it wakes nobody); a fresh baseline each time
 *                                a department becomes live or comes back from off, so the switch never reopens old work
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
 *   5. the lead passes it on     a member's handoff to anyone outside the department is held until the lead's recorded
 *                                pass (`accountable.js pass`; a typed "Passed on by" line counts for nothing), so the
 *                                receiver deals with one accountable person; an FYI that asks for nothing and a block to the
 *                                people seat are not held. The writer is the run seen writing the block into that inbox
 *                                (runWriter) or, for the dispatcher and the tools (the owner's routed message too), their own
 *                                record (lib/tool-blocks.js); a heading's name is only a claim, and a claim of the department
 *                                or the dispatcher is held too; a block whose heading names a sender outside the department
 *                                is never put on a member by guess. A pass is for the sender's words (blockFp): a new block
 *                                under a passed Id or heading is held again, while lines added later by a lane or the
 *                                receiver never are (sameBlock). A P0 is never held on a guess about its writer
 *   stalls                       an audit, a held pass-on (worked out from the holds, never from the lead's "Pass on" block,
 *                                which goes back to OPEN when closed by hand) or an item with no acceptance check waiting stallHours is put to
 *                                the CEO in one plain line, the owner too when the cause is the owner's; the CEO may then
 *                                answer or drop the audit, or pass or return the message, in the lead's place
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
 *   AC.handback(o) / AC.audit(o) / AC.pass(o) / AC.escape(o) / AC.spot(o) / AC.drop(o) / AC.dispute(o) / AC.ruling(o)   the CLI's commands
 *   AC.scanTick(o)                          the dispatcher's step: intake, copies, held DONEs, onward and escalation holds,
 *                                           spot-check picks, escapes on reopened accepted items -> (inbox, item) -> hold|null
 *   await AC.auditStep(ctx)                 the dispatcher's audit runs (door audit), the routine, the auto fallback
 *   AC.gate({seat, refs, sha, info?}, o)    merge-gate.js: a PR behind a member's work (whoever merges it) needs an ACCEPT for
 *                                           this PR at exactly this commit; info() (the PR's branch, author, body, commits) is
 *                                           read only when no hand-back or item names the PR
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
const TB = require('./tool-blocks');
const W = require('./wakes');

const WRITER = 'accountable.js';
const VERDICTS = ['ACCEPT', 'REVISE'];
const OWNER_GATES = ['money', 'access', 'ownership', 'commitment'];
const MIN = 60e3, DAY = 86400e3;
const AUDIT_LINE = 'Open audits for you:';
const AUDIT_HEAD = /^Audit:/;
const PASS_HEAD = /^(?:\S+\s+from\s+Dispatcher\s+[—–-]\s*)?Pass on:/i;
const HOUR = 3600e3;

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
const headWords = h => String(h || '').replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, '').trim();
/* who wrote a block. A tool's block (the dispatcher's) is known only by provenance (lib/tool-blocks.js), never by a
 * heading that says "from Dispatcher". A crew seat's block is known by its run: an agent's recent tool call (provenance
 * recentCalls rows) that carries the block's heading line (any length: the date and the "from" are part of it) or its
 * heading words. With the inbox named (always, from scanTick): the heading words count only in a call that writes into
 * THIS inbox (a title is forwarded all the time: the lead's write of "deploy the parser" into a member's inbox never makes
 * the lead the writer of the member's block to someone else), and the full heading line in a call that writes into this
 * inbox, else in one that does not write into another crew inbox. A call that writes wins over one that only reads; when
 * the runs disagree, the seat the heading names wins, else the earliest. The heading's "from <name>" alone proves
 * nothing: it is only what the block claims (claimOf). */
const WRITE_TOOL = /write|edit|append|create|insert|replace|patch/i;
const writesFile = (c, name) => { const raw = String(c.raw || ''); if (!raw.includes(name)) return false; if (c.shell) return /(?:>>?|\btee\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\bmv\b|\bcp\b|writeFile|appendFile)/.test(raw); return WRITE_TOOL.test(String(c.tool || '')); };
function runWriter(heading, sec, crew, calls, inbox) {
  const probes = [], w = headWords(heading), h = String(heading || '').trim();
  if (h) probes.push({ text: h.slice(0, 80), full: true });
  if (w.length >= 12) probes.push({ text: w.slice(0, 60), full: false });
  const others = inbox ? Object.values(crew || {}).map(c => c && c.inbox).filter(x => x && x !== inbox) : [];
  let named = null; try { named = claimOf(heading, crew); } catch (_) {}
  for (const pr of probes) {
    const probe = JSON.stringify(pr.text).slice(1, -1);
    let hits = (calls || []).filter(c => c && c.agentId && crew[c.agentId] && String(c.raw || '').includes(probe));
    if (inbox) {
      const here = hits.filter(c => writesFile(c, inbox));
      hits = here.length || !pr.full ? here : hits.filter(c => !others.some(ib => writesFile(c, ib)));
    }
    if (!hits.length) continue;
    const by = (c => Number(c.ts) || 0), writes = hits.filter(c => c.shell || WRITE_TOOL.test(String(c.tool || '')));
    const pool = writes.length ? writes : hits;
    if (named && pool.some(c => String(c.agentId) === String(named))) return String(named);
    return String(pool.slice().sort((a, b) => by(a) - by(b))[0].agentId);
  }
  return null;
}
// a heading that names its sender ("<date> [time] from <someone> — …"): a tool, the owner, a seat
const namedSender = h => /^\S+(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?\s+from\s+\S.*?(?:\s[—–-]\s|\s[—–]|[—–]\s)/.test(String(h || '').trim());
const claimOf = (heading, crew) => require('./signoff').writerOf(heading, crew);
// a block that asks for something: a Need / Ask / Decision line, or a heading that asks a question or for a decision
const ASK_RE = /\?|\b(?:please|can you|could you|would you|need (?:you|a|an|your|more|help)|decide|decision|approve|approval|sign[- ]?off|unblock|blocked|help)\b/i;
const asks = (sec, heading) => ['Need', 'Ask', 'Decision', 'Needs sign-off'].some(k => field(sec, k) != null) || ASK_RE.test(headWords(heading));
// FYI that asks for nothing (an FYI marker on a block with a Need is not FYI: it is held like any other block)
const fyiOnly = (sec, heading) => require('./signoff').isFyi(sec, heading) && !asks(sec, heading);
/* what a block IS, not only its ref (the **Id:** line or a hash of the heading, which anyone can reuse):
 *   blockFp(sec)   a block out of the department: the sender's words, less its status and the lines the tools add (the
 *                  pass's **Passed on by:** and **Escalation:**, **Returned by:**, a **Resolved** stamp, a lane's **Lane:**,
 *                  **Piece n lane:**, **Piece n result …:** and **Lane result …:**). A pass, a return, a hold and the out-of-department memory
 *                  are for these words: a new block under a passed Id or heading is held again
 *   blockLines(sec) those words as short line hashes, kept with each pass, return, hold and baseline: the same block with
 *                  lines ADDED since (the receiver's progress notes, evidence) is still that block (sameBlock), unless a
 *                  member's run is seen writing an added line (new words from the department wait for the lead again)
 *   headFp(heading) an item in a member's inbox: its heading. The intake, the hand-back and the audit carry it, so a new
 *                  item under an accepted item's Id is a new item (its own intake, copy and audit), never a reopen */
const TOOL_LINE = /^\*\*(?:Status|Passed on by|Returned by|Resolved[^*]*|Hand back|Handed back|Verdict|Dropped by|Lane|Piece \d+ lane|Piece \d+ result[^*]*|Lane result[^*]*):\*\*/;
function senderLines(sec) {
  const L = String(sec || '').replace(/\r/g, '').split('\n'), out = [];
  for (let i = 0; i < L.length; i++) {
    const l = L[i].replace(/\s+$/, ''); if (!l.trim() || TOOL_LINE.test(l)) continue;
    if (/^\*\*Escalation:\*\*/.test(l) && i > 0 && /^\*\*Passed on by:\*\*/.test(L[i - 1])) continue;
    out.push(l);
  }
  return out;
}
function blockFp(sec) { return crypto.createHash('sha256').update(senderLines(sec).join('\n')).digest('hex').slice(0, 12); }
const lineHash = l => crypto.createHash('sha256').update(String(l)).digest('hex').slice(0, 8);
const MAX_LINES = 400;
const blockLines = sec => { const L = senderLines(sec); return L.length <= MAX_LINES ? L.map(lineHash) : undefined; };
// the lines of sec added since rec (a { fp, lines } record) when sec is rec's block with lines only added; null otherwise
function addedSince(rec, sec) {
  if (!rec) return null; const L = senderLines(sec);
  if (rec.fp && blockFp(sec) === rec.fp) return [];
  const want = Array.isArray(rec.lines) ? rec.lines : null; if (!want || !want.length || !L.length) return null;
  const hs = L.map(lineHash); if (hs[0] !== want[0]) return null;   // the heading is the same
  const added = []; let j = 0;
  for (let i = 0; i < hs.length; i++) { if (j < want.length && hs[i] === want[j]) j++; else added.push(L[i]); }
  return j === want.length ? added : null;
}
// an added line a member of the department is seen writing into that inbox (since the record): new words from the team
function memberWrote(lines, inbox, members, calls, since) {
  const t0 = (Number(since) || 0) - 10 * 60e3;
  return (lines || []).some(l => { const s = String(l).trim(); if (s.length < 8) return false; const probe = JSON.stringify(s).slice(1, -1);
    return (calls || []).some(c => c && members.includes(String(c.agentId)) && (Number(c.ts) || 0) >= t0 && writesFile(c, inbox) && String(c.raw || '').includes(probe)); });
}
const atMs = v => (typeof v === 'number' ? v : Date.parse(v || '') || 0);
// sec is still the block of rec (same words, or only lines added that no member of the department wrote)
function sameBlock(rec, sec, inbox, members, calls) { const a = addedSince(rec, sec); return !!a && (!a.length || !memberWrote(a, inbox, members || [], calls, atMs(rec.at))); }
const headFp = heading => crypto.createHash('sha256').update('head:' + String(heading || '').trim()).digest('hex').slice(0, 10);
// a row or record carries the fingerprint it was made for; one made before fingerprints (none) matches any block
const fpMatch = (have, want) => !have || have === want;
// a P0 block (**Priority:** P0): never held on a guess about its writer; one a member's run wrote stalls after an hour
const isP0 = sec => /^P0\b/i.test(String(field(sec, 'Priority') || '').trim());
const spotPicked = (id, every) => every > 0 && parseInt(crypto.createHash('sha256').update('spot:' + String(id)).digest('hex').slice(0, 8), 16) % every === 0;
const stallMs = a => Math.max(1, Number(a && a.stallHours) || 6) * HOUR;
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
// id -> { id, hb, verdict (the FIRST verdict decides), escapes, spots, disputes, rulings, stalled, status: open | accepted |
// revise | dropped }. A drop of the item closes its open audit (status dropped: nothing is waited for any more)
function audits(rs) {
  const m = new Map();
  for (const r of rs || []) {
    if (r.op === 'handback' && r.id && !m.has(r.id)) m.set(r.id, { id: r.id, hb: r, verdict: null, escapes: [], spots: [], disputes: [], rulings: [], stalled: null, status: 'open' });
    if (r.op === 'drop' && r.ref) { for (const y of m.values()) if (y.hb.ref === r.ref && (!r.hfp || fpMatch(y.hb.hfp, r.hfp)) && y.status === 'open') y.status = 'dropped'; continue; }
    const x = r.id ? m.get(r.id) : null; if (!x) continue;
    if (r.op === 'verdict' && !x.verdict && x.status === 'open') { x.verdict = r; x.status = r.verdict === 'ACCEPT' ? 'accepted' : 'revise'; }
    else if (r.op === 'escape') x.escapes.push(r);
    else if (r.op === 'spot') { if (!x.spots.some(s => s.by === r.by)) x.spots.push(r); }
    else if (r.op === 'dispute') { if (!x.disputes.some(d => d.escape === r.escape)) x.disputes.push(r); }
    else if (r.op === 'ruling') { if (!x.rulings.some(d => d.escape === r.escape)) x.rulings.push(r); }
    else if (r.op === 'stalled' && !x.stalled) x.stalled = r;
  }
  return m;
}
// the escapes that count against the lead: not disputed, or disputed and upheld by the people seat (or the CEO)
function countedEscapes(x) {
  return x.escapes.filter(r => { const key = escapeKey(r), d = x.disputes.find(y => y.escape === key); if (!d) return true; const ru = x.rulings.find(y => y.escape === key); return !!ru && ru.result === 'uphold'; });
}
const escapeKey = r => crypto.createHash('sha1').update(String(r.at) + '\n' + String(r.why)).digest('hex').slice(0, 12);
// the latest LIVE hand-back of an item (a recording-only one is a record, never something to wait for)
// (hfp: the item's heading fingerprint; a hand-back for another item under the same ref is not this item's)
const latestFor = (m, ref, hfp) => { let best = null; for (const x of m.values()) if (x.hb.ref === ref && (hfp == null || fpMatch(x.hb.hfp, hfp)) && !x.hb.shadow && (!best || Number(x.hb.at) >= Number(best.hb.at))) best = x; return best; };
const intakeOf = (rs, ref, hfp) => { let best = null; for (const r of rs || []) if (r.op === 'intake' && r.ref === ref && (hfp == null || fpMatch(r.hfp, hfp))) best = r; return best; };

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
// explicit **Risk:** high, or an act the sign-off kinds name (merge, external, trade). An explicit **Risk:** routine counts
// only when the lead or whoever assigned the item wrote it (o.routineTrusted: handback compares the item with its intake
// record), and even then it never outweighs a risky path, the diff size or a **Risk:** high: it only sets aside the
// department's risky classes, words and act cues
function riskOf(o) {
  const a = o.a || D.ACCOUNTABLE_FALLBACK, r = a.risk || {}, hard = [], soft = [];
  const block = String(o.block || ''), files = o.files || diffFiles(o.diff);
  const explicit = String(field(block, 'Risk') || '').toLowerCase();
  const routine = /^(?:routine|low)\b/.test(explicit) && o.routineTrusted === true;
  if (/^(?:high|risky)\b/.test(explicit)) hard.push('marked risky');
  const hit = files.find(f => (r.paths || []).some(p => p.endsWith('/') ? f.startsWith(p) || ('/' + f).includes('/' + p) : f === p || f.endsWith('/' + p)));
  if (hit) hard.push('it touches ' + hit);
  const n = diffLines(o.diff); if (Number(r.minDiffLines) > 0 && n >= Number(r.minDiffLines)) hard.push(n + ' changed lines');
  if ((r.classes || []).includes(String(o.cls || ''))) soft.push(o.cls + ' work is risky in this department');
  const w = (r.words || []).find(x => new RegExp('\\b' + String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(block.split('\n')[0] + '\n' + (field(block, 'Need') || '')));
  if (w) soft.push('the item mentions ' + w);
  try { const SO = require('./signoff'); for (const k of ['merge', 'external', 'trade']) if (SO.KIND_CUES[k] && SO.KIND_CUES[k].test(block)) { soft.push('it asks to ' + k); break; } } catch (_) {}
  const why = hard.concat(routine ? [] : soft);
  if (!why.length && routine) return { risky: false, why: ['marked routine'] };
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
// the lead's block to the CEO is an escalation when it says so, or when it asks for anything (FYI-only reports are not)
const readsAsEscalation = (heading, block) => /\bescalat/i.test(String(heading || '')) || field(block, 'Escalation') != null || (!fyiOnly(block, heading) && asks(block, heading));

/* ---------------- the packet ---------------- */
function renderPacket(p) {
  const L = ['## Audit: ' + one(p.title, 80) + ' (' + p.date + ')', '**Id:** ' + p.id, '**Item:** ' + one(p.item, 200), '**From:** ' + one(p.from, 120), '**Class:** ' + (p.class || 'general'),
    '**Risk:** ' + (p.risky ? 'risky (' + one(p.riskWhy.join('; '), 200) + '): audited on your top tier' : 'routine'), p.pr ? '**PR:** ' + one(p.pr, 200) + (p.sha ? ' at ' + String(p.sha).slice(0, 12) : '') : null,
    p.again ? '**Again:** accepted at ' + String(p.again.sha).slice(0, 12) + ' (' + p.again.id + '); this is the same pull request at a new commit (a rebase or a fix): what changed since is git diff ' + String(p.again.sha).slice(0, 12) + '..' + String(p.sha || '').slice(0, 12) : null,
    '**Status:** OPEN', '', '### Acceptance check', String(p.check || '').trim(),
    ...(p.changed || []).map(c => '- **Changed since it was assigned:** the ' + c.what + ' was ' + (c.was ? '`' + one(c.was, 200) + '`' : '(none)') + ' when the item came in; read the change with that in mind'),
    '### Self-check (what ' + firstName(p.from) + ' checked)', String(p.note || '').trim(),
    p.ran.length ? p.ran.map(r => '- ran `' + one(r.cmd, 200) + '`: exit ' + r.exit).join('\n') + (p.cwd ? '\n- ran in ' + one(p.cwd, 200) + ' (the member chose the folder)' : '') : '- (no check command: the note above is the self-check)',
    p.tests ? '- tests: ' + one(p.tests, 400) : null, '### Diff',
    p.diff ? (p.diffFrom === 'git' ? '(from git' + (p.sha ? ' at ' + String(p.sha).slice(0, 12) : '') + ', against ' + one(p.base || 'origin/HEAD', 80) + ')' : '(as ' + firstName(p.from) + ' gave it: not read from git)') : null,
    p.diff ? '```diff\n' + p.diff.replace(/\n+$/, '').replace(/```/g, '`​``') + '\n```' : '(no diff: ' + one(p.noDiff || 'not a code change', 200) + ')',
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
  // two blocks under one Id (a new item reusing an accepted one's): the open one is the one being worked
  const open = hits.length > 1 ? hits.filter(h => h.it.open) : hits;
  return hits.length === 1 ? hits[0] : open.length === 1 ? open[0] : hits.length ? { many: hits.length } : null;
}
/* an accepted item that is no longer in the inbox (handoff-archive.js moves a DONE section out after 3 hours): found by
 * its ref, its id or words of its heading, or by the PR (--pr) of the member's accepted hand-back, so a rebase or a
 * conflict fix on its PR is still handed back again at the new commit. The section comes from the archive (the newest
 * copy), or is rebuilt from the ledger (its heading, check and PR); handback puts it back into the inbox. */
function archivedItem(o, by, inbox, want, cwd) {
  const w = String(want || '').trim(), all = audits(rows(o)), pk = o.pr ? prKeyOf(o.pr, cwd) : null;
  const acc = [...all.values()].filter(x => !x.hb.shadow && x.hb.seat === by && x.hb.file === inbox && x.hb.pr && x.hb.sha && x.status === 'accepted');
  const hits = acc.filter(x => (w && (x.hb.ref === w || x.hb.item === w || x.hb.ref === inbox + '#' + w || (w.length >= 6 && String(x.hb.title || '').toLowerCase().includes(w.toLowerCase())))) || (!w && pk && normPr(x.hb.pr) === pk))
    .filter(x => latestFor(all, x.hb.ref, x.hb.hfp || null) === x);   // the item's newest hand-back is this accept
  const refs = [...new Set(hits.map(x => x.hb.ref + '@' + (x.hb.hfp || '')))];
  if (!refs.length) return null;
  if (refs.length > 1) return { many: refs.length };
  const x = hits.sort((a, b) => Number(b.hb.at) - Number(a.hb.at))[0], SP = require('./sprint');
  // still in the inbox (named by its PR only): that block, never a second copy
  const here = findItem(o, inbox, x.hb.ref); if (here && !here.many && fpMatch(x.hb.hfp, headFp(here.it.heading))) return here;
  const arch = readText(path.join(paths(o).handoffs, 'archive', inbox)) || '';
  let sec = null;
  for (const s of sections(arch)) { if (!s.startsWith('## ')) continue; const it = SP.parseItems(s)[0]; if (it && itemRef(inbox, it) === x.hb.ref && fpMatch(x.hb.hfp, headFp(it.heading))) sec = s; }
  if (!sec) {
    const ik = intakeOf(rows(o), x.hb.ref, x.hb.hfp || null), id = String(x.hb.item || '');
    sec = '## ' + x.hb.title + '\n' + (id && !id.includes('#') ? '**Id:** ' + id + '\n' : '') + '**Acceptance check:** ' + x.hb.check + '\n' + (ik && ik.checkCmd ? '**Check command:** `' + ik.checkCmd + '`\n' : '') + '**PR:** ' + x.hb.pr + '\n**Status:** DONE — accepted (' + x.id + ')\n';
  }
  sec = sec.replace(/\s*$/, '\n');
  const it = SP.parseItems(sec)[0]; if (!it) return null;
  const t = readText(path.join(paths(o).handoffs, inbox)) || '# Handoffs\n', parts = sections(t.replace(/\n*$/, '\n\n')).concat([sec]);
  return { i: parts.length - 1, it, id: W.itemId(inbox, it.heading, it.id), ref: itemRef(inbox, it), sec, parts, text: t, restored: x.id };
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
  let f = o.item ? findItem(o, inbox, o.item) : null;
  // gone from the inbox (archived): an accepted item with a PR is found in the ledger, so a new commit is handed back
  if (!f && (o.sha || o.pr)) f = archivedItem(o, by, inbox, o.item, o.cwd ? path.resolve(o.cwd) : null);
  if (!f) return bad(o.item ? 'no item "' + one(o.item, 80) + '" in your inbox (' + inbox + ')' + (o.sha ? ', nor an accepted one of yours with a pull request' : '') : 'name the item: handback <item id> (or, for an accepted pull request, --pr <owner/repo#n> --cwd <repo> --sha <head>)');
  if (f.many) return bad('"' + one(o.item || o.pr, 80) + '" matches ' + f.many + ' items: give its id');
  const hfp = headFp(f.it.heading);
  // an accepted item whose PR got a new commit (a rebase, a conflict fix) is handed back again at that commit: no reopen,
  // no escape (the accept was for the old commit, and the new one gets its own audit)
  const prev = (() => { const x = latestFor(audits(rows(o)), f.ref, hfp); return x && x.status === 'accepted' && x.hb.pr && x.hb.sha ? x : null; })();
  if (f.restored && !prev) return bad('no item "' + one(o.item || o.pr, 80) + '" in your inbox (' + inbox + ')');
  if (!f.it.open && !prev) return bad('that item is not OPEN');
  const check = acceptanceOf(f.sec);
  if (!check) return bad('the item names no acceptance check (**Acceptance check:**): ask ' + firstName(leadName) + ' to add one; you cannot hand back work nobody can check');
  const note = String(o.note || '').trim();
  if (note.length < (Number(e.a.selfCheck.noteMinChars) || 20)) return bad('--note "<what you checked, and how>" is required (at least ' + (Number(e.a.selfCheck.noteMinChars) || 20) + ' characters): the lead reads it with the diff');
  const rs0 = rows(o), all = audits(rs0), open = latestFor(all, f.ref, hfp);
  if (open && open.status === 'open') return bad('this item is with ' + firstName(leadName) + ' for audit already (' + open.id + ')');
  if (!f.it.open && !o.sha) return bad('that item was accepted (' + prev.id + ' at ' + String(prev.hb.sha).slice(0, 12) + '): a new commit on its pull request is handed back with --pr ' + prev.hb.pr + ' --cwd <repo> --sha <the new head>');
  const cls = (() => { try { return require('./taskclass').classOf({ text: f.sec, effort: f.it.effort }, by, { departments: { departments: [e.d] } }); } catch (_) { return e.d.defaultClass || 'general'; } })();
  const codeDept = cls === 'code' || e.d.defaultClass === 'code';
  let pr = o.pr || field(f.sec, 'PR') || null;
  let sha = o.sha ? String(o.sha).trim().toLowerCase() : null;
  if (sha && !/^[0-9a-f]{7,64}$/.test(sha)) return bad('--sha takes the head commit');
  // the accept is for one commit of one pull request: a hand-back with a PR names its head commit
  if (pr && !sha) return bad('this work has a pull request (' + one(pr, 120) + '): hand it back with its head commit, --cwd <repo> --sha <head>, so ' + firstName(leadName) + '\'s accept is for exactly what you checked');
  // the self-check: the item's check command and every --test-cmd are RUN; one failure and nothing goes to the lead
  const cwd = path.resolve(o.cwd || rootOf(o));
  const cmds = [checkCommandOf(f.sec)].concat([].concat(o.testCmds || [])).map(x => String(x || '').trim()).filter(Boolean);
  if (codeDept && !cmds.length) return bad('code work needs a self-check that runs: the item\'s **Check command:** or --test-cmd "<the command that checks it>"; a note alone is not a check');
  const ran = [];
  for (const c of cmds) {
    const r = runCheck(c, cwd, o.timeoutSec || e.a.selfCheck.timeoutSec); ran.push(r);
    if (!r.ok) {
      append({ op: 'selfcheck', at: now, ts: new Date(now).toISOString(), ok: false, ref: f.ref, item: f.id, file: inbox, seat: by, dept: String(e.d.id), cmd: one(c, 300), exit: r.exit }, o);
      return Object.assign(bad('your own check failed: `' + one(c, 120) + '` exited ' + r.exit + '. Nothing went to ' + firstName(leadName) + '; fix it and hand back again.' + (r.tail ? '\n' + r.tail : ''), 3), { selfCheck: { cmd: c, exit: r.exit } });
    }
  }
  // the diff: with a commit (--sha), always git's diff <base>...<sha> in --cwd (a diff typed in is never used then); else
  // given, from a file, or git diff <base>...HEAD in --cwd
  let diff = null, diffFrom = 'given';
  const base = o.base || 'origin/HEAD';
  const git = argv => spawnSync('git', ['-C', cwd].concat(argv), { encoding: 'utf8', maxBuffer: 32 << 20 });
  if (sha) {
    if (!o.cwd) return bad('--sha needs --cwd <repo>: the packet shows ' + firstName(leadName) + ' the diff git has at that commit, never one typed in');
    const full = git(['rev-parse', '--verify', '--quiet', sha + '^{commit}']);
    if (full.status !== 0) return bad('commit ' + sha + ' is not in ' + cwd);
    sha = String(full.stdout).trim().toLowerCase();
    // the PR must say which repository it is in (owner/repo#n or its URL), or --cwd's GitHub remote says it: the merge gate
    // matches the accept to owner/repo#n, so a bare "#12" would leave the merge stuck, or ungated for another merger
    if (pr) {
      const key = prKeyOf(pr, cwd);
      if (!key) return bad('say which repository the pull request is in: --pr owner/repo#' + (String(pr).match(/\d+/) || ['<n>'])[0] + ' or its URL ("' + one(pr, 80) + '" does not, and ' + cwd + ' has no GitHub remote named origin)');
      pr = key;
    }
    if (prev && !f.it.open) {
      if (pr !== normPr(prev.hb.pr)) return bad('that item was accepted for ' + prev.hb.pr + ': only a new commit of that same pull request is handed back again (other work is a new item)');
      if (sha === String(prev.hb.sha)) return bad('that item was accepted at this commit already (' + prev.id + '): nothing to hand back');
    }
    const g = git(['diff', base + '...' + sha]);
    if (g.status !== 0) return bad('cannot diff ' + base + '...' + sha + ' in ' + cwd + ': give --base <the branch it goes into>');
    diff = g.stdout; diffFrom = 'git';
  } else {
    diff = o.diff != null ? String(o.diff) : null;
    if (diff == null && o.diffFile) { diff = readText(path.resolve(o.diffFile)); if (diff == null) return bad('cannot read --diff-file ' + o.diffFile); }
    if (diff == null && o.cwd) { const g = git(['diff', base + '...HEAD']); if (g.status === 0) { diff = g.stdout; diffFrom = 'git'; } }
  }
  if (!String(diff || '').trim() && cls === 'code' && !o.noDiff) return bad('code work is handed back with its diff (--cwd <repo> [--base <ref>], or --diff-file <file>); say --no-diff "<why>" when there is none');
  // what changed on the item since it came in (the intake record): the check command, the acceptance check, the risk mark
  const ik = intakeOf(rs0, f.ref, hfp), changed = [];
  if (ik && ik.checkCmd !== undefined && String(ik.checkCmd || '') !== checkCommandOf(f.sec)) changed.push({ what: 'check command', was: ik.checkCmd || '' });
  if (ik && ik.check !== undefined && String(ik.check || '') !== check) changed.push({ what: 'acceptance check', was: ik.check || '' });
  const riskNow = String(field(f.sec, 'Risk') || '').trim();
  const routineTrusted = !!(ik && (ik.via === 'lead' || ik.via === 'direct') && ik.writer && ik.writer !== by && String(ik.risk || '') === riskNow);
  const risk = riskOf({ block: f.sec, cls, diff, a: e.a, routineTrusted });
  const tier = risk.risky ? 'risky' : 'routine';
  const id = newId('ac', now), max = Math.max(2000, Number(e.a.packetMaxChars) || 12000);
  const pk = { id, date: dayOf(now), title: f.it.heading.replace(/^\S+\s+from\s+[^—–-]+[—–-]\s*/, ''), item: f.ref, from: nameOf(crew, by), class: cls, risky: risk.risky, riskWhy: risk.why, pr, sha, check, note, tests: o.tests || '', ran, diff: String(diff || ''), diffFrom, base, changed,
    cwd: ran.length && o.cwd && path.resolve(o.cwd) !== rootOf(o) ? cwd : null, noDiff: o.noDiff, leadName };
  if (prev && !f.it.open) pk.again = { id: prev.id, sha: prev.hb.sha };
  let text = renderPacket(pk), clipped = false;
  if (text.length > max) { const over = text.length - max + 40; pk.diff = pk.diff.slice(0, Math.max(0, pk.diff.length - over)) + '\n… (clipped: the whole diff is in the branch)'; text = renderPacket(pk); clipped = true; }
  const live = e.a.effective === 'live', leadInbox = (crew[lead] || {}).inbox;
  if (live && !leadInbox) return bad('the lead ' + leadName + ' has no inbox (loops.json)');
  const dsha = 'sha256:' + crypto.createHash('sha256').update(String(diff || '')).digest('hex').slice(0, 16);
  append(Object.assign({ op: 'handback', at: now, ts: new Date(now).toISOString(), id, ref: f.ref, hfp, item: f.id, file: inbox, title: one(f.it.heading, 160), restored: f.restored ? true : undefined, seat: by, dept: String(e.d.id), lead, class: cls,
    risky: risk.risky, riskWhy: risk.why, tier, check: one(check, 600), note: one(note, 1200), tests: o.tests ? one(o.tests, 400) : undefined, ran: ran.map(r => ({ cmd: one(r.cmd, 300), exit: r.exit })),
    diffSha: dsha, diffFrom, diffLines: diffLines(diff), files: diffFiles(diff).slice(0, 40), pr: pr ? one(pr, 200) : undefined, sha: sha || undefined, changed: changed.length ? changed.map(c => c.what) : undefined, cwd: o.cwd ? one(cwd, 200) : undefined, chars: text.length, clipped: clipped || undefined, deadline: field(f.sec, 'Deadline') || undefined,
    runId: process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : undefined, again: pk.again ? pk.again.id : undefined }, live ? {} : { shadow: true }), o);
  // the ledger first, then the inboxes: a tick in between sees the new hand-back, never an accepted item reopened
  if (live && !o.dry) {
    fs.appendFileSync(path.join(paths(o).handoffs, leadInbox), text);
    // an archived item comes back into the inbox for this audit (handoff-archive.js moves it out again once it is DONE)
    if (f.restored) { const cur = readText(path.join(paths(o).handoffs, inbox)) || '# Handoffs\n'; f.parts = sections(cur.replace(/\n*$/, '\n\n')).concat([f.sec]); f.i = f.parts.length - 1; }
    const parts = f.parts, m = /\n*$/.exec(parts[f.i]); parts[f.i] = parts[f.i].slice(0, m.index) + '\n**Handed back:** ' + id + ' to ' + leadName + ' for audit (' + dayOf(now) + ')' + (pk.again ? ', at a new commit ' + String(sha).slice(0, 12) : '') + (f.restored ? ' (brought back from the archive)' : '') + (m[0] || '\n');
    if (pk.again) parts[f.i] = setStatus(parts[f.i], 'OPEN — handed back again at a new commit (' + String(sha).slice(0, 12) + '): with ' + leadName + ' for audit');
    writeAtomic(path.join(paths(o).handoffs, inbox), parts.join(''));
  }
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
// the item under ref (and, given hfp, with that heading: a new item reusing the Id is not it)
function itemMatcher(file, ref, hfp) { const SP = require('./sprint'); return sec => { if (!sec.startsWith('## ')) return false; const it = SP.parseItems(sec)[0]; return !!it && itemRef(file, it) === ref && (!hfp || headFp(it.heading) === hfp); }; }
function audit(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x) return bad('no audit ' + o.id + ' (accountable.js list --open)');
  if (x.hb.shadow) return bad(x.id + ' was recorded only (recording-only mode): there is nothing to audit');
  if (x.verdict) return bad(x.id + ' is answered already (' + x.verdict.verdict + '); an audit verdict is never changed: a new hand-back gets a new audit');
  if (x.status === 'dropped') return bad(x.id + ' was dropped: there is nothing to audit');
  const ds = deptState(o), e = ds.list.find(y => String(y.d.id) === x.hb.dept);
  if (!e || !leadOk(e.d, ceo)) return bad('the department ' + x.hb.dept + ' has no lead now');
  const by = seatOf(crew, o.by);
  // the CEO answers in the lead's place only for an audit the dispatcher recorded as waiting too long (auditStep)
  const inPlace = by && by === String(ceo) && by !== String(e.d.lead) && !!x.stalled;
  if (by !== String(e.d.lead) && !inPlace) return bad('only the lead of ' + (e.d.name || e.d.id) + ' (' + nameOf(crew, e.d.lead) + ') audits its members\' work' + (by === String(ceo) ? ' (the CEO answers only once the check has waited too long and the dispatcher said so)' : ''));
  if (by === x.hb.seat) return bad('nobody audits their own work');
  const verdict = String(o.verdict || '').toUpperCase();
  if (!VERDICTS.includes(verdict)) return bad('--verdict ACCEPT|REVISE');
  const check = one(o.check, 300); if (!check) return bad('--check "<what you checked: the diff against the acceptance check>" is required');
  const findings = [].concat(o.findings || []).map(f => one(f, 300)).filter(Boolean).slice(0, 12);
  if (verdict === 'REVISE' && !findings.length) return bad('REVISE needs at least one --finding "<what to fix>"');
  const leadName = nameOf(crew, by) + (inPlace ? ' (in ' + nameOf(crew, e.d.lead) + '\'s place: the check waited too long)' : '');
  const line = '**Verdict:** ' + verdict + ' by ' + leadName + ' — check: ' + check + (findings.length ? ' — ' + findings.map((f, i) => (i + 1) + '. ' + f).join(' ') : '');
  append({ op: 'verdict', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, verdict, by, inPlaceOf: inPlace ? String(e.d.lead) : undefined, check, findings: findings.length ? findings : undefined, sha: x.hb.sha || undefined, runId: process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : undefined }, o);
  const li = (crew[String(e.d.lead)] || {}).inbox;
  if (li) editBlock(o, li, sec => parsePacketId(sec) === x.id, sec => addLine(setStatus(sec, 'DONE — ' + verdict + ' (' + dayOf(now) + ')'), line));
  editBlock(o, x.hb.file, itemMatcher(x.hb.file, x.hb.ref, x.hb.hfp), sec => {
    const s = addLine(sec, line);
    return verdict === 'ACCEPT' ? setStatus(s, 'DONE — accepted by ' + leadName + ' (' + x.id + ', ' + dayOf(now) + ')') : setStatus(s, 'OPEN — sent back by ' + leadName + ' (' + x.id + '): fix the findings, check it again, hand it back');
  });
  return { ok: true, id: x.id, verdict, line, next: verdict === 'ACCEPT' ? 'the item is DONE; a merge of its change at this commit may go ahead, and you pass anything it hands on with accountable.js pass' : nameOf(crew, x.hb.seat) + ' is woken to fix it and hands it back again' };
}

/* ---------------- pass on, return, drop, escapes, spot checks ---------------- */
// a held block: { inbox, ref } written by a member of the lead's department to someone outside it. A pass (or return) is
// for that block's words (blockFp): a new block under the same ref is held again. o.block names the block when two share
// the ref (the "Block" line of the lead's "Pass on" block)
function pass(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const ref = String(o.ref || '').trim(), inbox = ref.split('#')[0], want = String(o.block || '').trim().toLowerCase();
  const by = seatOf(crew, o.by), ds = deptState(o);
  const recv = Object.keys(crew).find(k => (crew[k] || {}).inbox === inbox);
  const SP = require('./sprint'), t = readText(path.join(paths(o).handoffs, inbox)) || '', rs = rows(o);
  const cands = sections(t).filter(s => { if (!s.startsWith('## ')) return false; const it = SP.parseItems(s)[0]; return it && itemRef(inbox, it) === ref; });
  // a block is the one held, passed or returned when its words are the same, or only lines were added since that no
  // member of the department wrote (a lane's mark, the receiver's notes): sameBlock. The pass is recorded under the fp
  // the hold was made for, so the hold, its "Pass on" block and the pass all name the same block
  let calls = o.calls; if (!Array.isArray(calls)) { try { calls = require('../provenance.js').recentCalls(rootOf(o), now - 7 * DAY); } catch (_) { calls = []; } }
  const membersOf = dept => { const y = ds.list.find(x => String(x.d.id) === String(dept)); return y ? D.members(y.d).filter(s => s !== String(y.d.lead)) : []; };
  const asked = Object.values(readState(o).passAsked || {}).filter(v => v && typeof v === 'object' && v.ref === ref && v.fp);
  const askedFor = s => asked.find(v => blockFp(s) === v.fp) || asked.find(v => sameBlock(v, s, inbox, membersOf(v.dept), calls)) || null;
  const doneRow = s => rs.find(r => (r.op === 'pass' || r.op === 'return') && r.ref === ref && r.fp && (r.fp === blockFp(s) || sameBlock(r, s, inbox, membersOf(r.dept), calls))) || null;
  const alreadyBad = r => bad(ref + ' was ' + (r.op === 'pass' ? 'passed on' : 'returned') + ' already');
  let sec = null;
  if (recv && cands.length) {
    let pick = want ? cands.filter(s => blockFp(s).startsWith(want) || (askedFor(s) && askedFor(s).fp.startsWith(want))) : cands.filter(s => !doneRow(s));
    if (want && !pick.length) return bad('no block ' + ref + ' with --block ' + want);
    if (!pick.length) return alreadyBad(doneRow(cands[0]));
    if (pick.length > 1) { const op = pick.filter(s => (SP.parseItems(s)[0] || {}).open); if (op.length === 1) pick = op; else return bad(pick.length + ' blocks in ' + inbox + ' are ' + ref + ': name the one you mean with --block <the Block line of its "Pass on" item>'); }
    sec = pick[0]; const d = doneRow(sec); if (d) return alreadyBad(d);
  }
  const heldRec = sec ? askedFor(sec) : null;
  const fp = sec ? (heldRec ? heldRec.fp : blockFp(sec)) : null, lines = sec ? blockLines(sec) : undefined;
  let e = by ? leadDept(by, ds, ceo) : null, inPlace = false;
  // the CEO decides in the lead's place only for a block the dispatcher recorded as waiting too long (auditStep)
  if (!e && by && by === String(ceo)) {
    const sr = rs.find(r => r.op === 'stalled' && r.kind === 'pass' && r.ref === ref && (!fp || fpMatch(r.fp, fp)));
    if (sr) { e = ds.list.find(y => String(y.d.id) === String(sr.dept) && leadOk(y.d, ceo)) || null; inPlace = !!e; }
    if (!e) return bad('only a department lead passes on its team\'s work (the CEO only a message that has waited too long for its lead, once the dispatcher said so)');
  }
  if (!e) return bad('only a department lead passes on its team\'s work');
  if (!recv) return bad('--ref <inbox>#<item id> names the held block (accountable.js list --held)');
  if (!sec) return bad('no block ' + ref);
  const leadName = nameOf(crew, by) + (inPlace ? ' (in ' + nameOf(crew, e.d.lead) + '\'s place: it waited too long)' : '');
  // the lead's Pass on block for this block is done once it is passed on or returned
  const closePassItem = what => { const li = (crew[String(e.d.lead)] || {}).inbox; if (li) editBlock(o, li, s => String(field(s, 'Pass-on') || '').trim() === ref && fpMatch(String(field(s, 'Block') || '').trim(), fp) && /^\*\*Status:\*\*\s*OPEN/m.test(s), s => setStatus(s, 'DONE — ' + what + ' (' + dayOf(now) + ')')); };
  if (o.ret) {
    const why = one(o.why, 300); if (!why) return bad('--return needs --why "<what the member does instead>"');
    append({ op: 'return', at: now, ts: new Date(now).toISOString(), ref, fp, lines, by, dept: String(e.d.id), to: recv, why, inPlaceOf: inPlace ? String(e.d.lead) : undefined }, o);
    editBlock(o, inbox, s => s === sec, s => setStatus(addLine(s, '**Returned by:** ' + leadName + (inPlace ? '' : ' (lead)') + ': ' + why), 'DONE — returned by ' + leadName + ', not passed on'));
    closePassItem('returned');
    return { ok: true, ref, block: fp, returned: true, inPlaceOf: inPlace ? String(e.d.lead) : undefined };
  }
  let esc = null;
  if (recv === String(ceo) && !inPlace) {
    esc = escalationOk(o.escalation);
    if (!esc.ok) return bad('one level at a time: a lead takes a member\'s matter to the CEO only when it crosses departments or is one of the four owner gates. Add --escalation cross-department or --escalation "owner: money|access|ownership|commitment", or solve it in the department and --return it');
  }
  append(Object.assign({ op: 'pass', at: now, ts: new Date(now).toISOString(), ref, fp, lines, by, dept: String(e.d.id), to: recv }, esc ? { escalation: esc.kind } : {}, inPlace ? { inPlaceOf: String(e.d.lead) } : {}), o);
  editBlock(o, inbox, s => s === sec, s => { const L = s.split('\n'); L.splice(1, 0, '**Passed on by:** ' + leadName + (inPlace ? ' (the CEO)' : ' (lead of ' + (e.d.name || e.d.id) + ', accountable for it)') + (esc ? '\n**Escalation:** ' + esc.kind : '')); return L.join('\n'); });
  closePassItem('passed on');
  return { ok: true, ref, block: fp, passed: true, escalation: esc ? esc.kind : undefined, inPlaceOf: inPlace ? String(e.d.lead) : undefined };
}
// the item is not needed: its open audit closes (nothing waits for it), the item is DONE as dropped, a DONE is not put
// back. The lead drops its team's items; the CEO only an item whose audit the dispatcher recorded as waiting too long
function drop(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const ref = String(o.ref || '').trim(), by = seatOf(crew, o.by), ds = deptState(o);
  let e = by ? leadDept(by, ds, ceo) : null, inPlace = false;
  if (!e && by && by === String(ceo)) {
    const st = [...audits(rows(o)).values()].find(x => x.hb.ref === ref && x.status === 'open' && x.stalled);
    if (st) { e = ds.list.find(y => String(y.d.id) === st.hb.dept) || null; inPlace = !!e; }
  }
  if (!e) return { ok: false, code: 2, error: 'only a department lead drops its team\'s item (the CEO only one whose check has waited too long)' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why is required' };
  const inbox = ref.split('#')[0];
  if (!ref.includes('#') || !Object.values(crew).some(c => c && c.inbox === inbox)) return { ok: false, code: 2, error: '<inbox>#<item id> names the item' };
  // the block dropped: the open one under the ref when two share it (a new item reusing an Id)
  const SP = require('./sprint'), under = sections(readText(path.join(paths(o).handoffs, inbox)) || '').filter(itemMatcher(inbox, ref)).map(s => SP.parseItems(s)[0]);
  const target = under.find(it => it.open) || under[0] || null, hfp = target ? headFp(target.heading) : undefined;
  const open = [...audits(rows(o)).values()].filter(x => x.hb.ref === ref && (!hfp || fpMatch(x.hb.hfp, hfp)) && x.status === 'open');
  append({ op: 'drop', at: now, ts: new Date(now).toISOString(), ref, hfp, by, dept: String(e.d.id), why, inPlaceOf: inPlace ? String(e.d.lead) : undefined }, o);
  const who = nameOf(crew, by);
  editBlock(o, inbox, itemMatcher(inbox, ref, hfp), sec => setStatus(addLine(sec, '**Dropped by:** ' + who + ': ' + why), 'DONE — dropped by ' + who + ', not needed (' + dayOf(now) + ')'));
  const li = (crew[String(e.d.lead)] || {}).inbox;
  if (li) for (const x of open) editBlock(o, li, sec => parsePacketId(sec) === x.id, sec => setStatus(sec, 'DONE — dropped by ' + who + ' (' + dayOf(now) + ')'));
  return { ok: true, ref, dropped: true, closed: open.map(x => x.id) };
}
// the lead disputes an escape charged to its review (a reopen it says was not a miss): the people seat (or the CEO when
// there is none) rules; until then the escape does not count, once upheld it does
function dispute(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = ceoOf(o, crew);
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x || x.status !== 'accepted') return { ok: false, code: 2, error: 'no accepted audit ' + o.id };
  const by = seatOf(crew, o.by); if (!by || by !== String(x.verdict.by)) return { ok: false, code: 2, error: 'only the one who accepted it disputes an escape against it' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why "<why it was not a miss>" is required' };
  const esc = x.escapes.find(r => !x.disputes.some(d => d.escape === escapeKey(r)));
  if (!esc) return { ok: false, code: 2, error: 'no undisputed escape on ' + x.id };
  const key = escapeKey(esc), judge = peopleOf(crew) && peopleOf(crew) !== by ? peopleOf(crew) : String(ceo);
  append({ op: 'dispute', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, escape: key, by, why, judge }, o);
  appendBlock(o, (crew[judge] || {}).inbox, 'escape disputed: ' + one(headWords(x.hb.title), 80) + ' (' + firstName(nameOf(crew, by)) + ')', {
    'Escape dispute': x.id + ' ' + key, Need: nameOf(crew, by) + ' says the problem charged to their check of ' + x.hb.ref + ' ("' + one(esc.why, 160) + '") was not a miss: "' + why + '". Decide: node company/tools/accountable.js ruling ' + x.id + ' --result uphold|clear --why "<what you found>" --by ' + firstName(nameOf(crew, judge)) + '. Until you decide it does not count on the scorecard.',
    Status: 'OPEN' });
  return { ok: true, id: x.id, escape: key, judge };
}
function ruling(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o);
  const x = audits(rows(o)).get(String(o.id || '').trim());
  if (!x) return { ok: false, code: 2, error: 'no audit ' + o.id };
  const by = seatOf(crew, o.by);
  const d = x.disputes.find(y => !x.rulings.some(r => r.escape === y.escape));
  if (!d) return { ok: false, code: 2, error: 'no open dispute on ' + x.id };
  if (!by || by !== d.judge) return { ok: false, code: 2, error: 'this dispute is decided by ' + nameOf(crew, d.judge) };
  const result = String(o.result || '').toLowerCase(); if (!['uphold', 'clear'].includes(result)) return { ok: false, code: 2, error: '--result uphold|clear' };
  const why = one(o.why, 300); if (!why) return { ok: false, code: 2, error: '--why is required' };
  append({ op: 'ruling', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept: x.hb.dept, escape: d.escape, by, result, why }, o);
  const ib = (crew[by] || {}).inbox; if (ib) editBlock(o, ib, s => String(field(s, 'Escape dispute') || '').trim() === x.id + ' ' + d.escape && /^\*\*Status:\*\*\s*OPEN/m.test(s), s => setStatus(s, 'DONE — ' + result + ' (' + dayOf(now) + ')'));
  return { ok: true, id: x.id, result };
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
function readState(o) { const s = readJson(paths(o).state, null); return Object.assign({ v: 1, seen: {}, copied: {}, doneHeld: {}, passAsked: {}, escNoted: {}, spots: {}, autoEscapes: {}, would: {}, routines: {}, lastAudit: {}, fellBack: {}, told: {}, mode: {}, holdWhy: {}, stallTold: {} }, s && typeof s === 'object' ? s : {}); }
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
  require('./tool-blocks').append(f, '\n## ' + dayOf(nowOf(o)) + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + v).join('\n') + '\n', { root: rootOf(o) });
}
function scanTick(o) {
  o = o || {}; const log = typeof o.log === 'function' ? o.log : () => {};
  const crew = crewOf(o), ceo = ceoOf(o, crew); let ds; try { ds = deptState(o); } catch (_) { return () => null; }
  const st = readState(o); let dirty = false;
  // the mode each department was in at the last tick: a department that becomes live (from off or recording only), or
  // comes back from off, gets a fresh baseline, so work handled while it was not live is never reopened or held
  st.mode = st.mode || {}; const prevMode = {};
  for (const e of ds.list) {
    const id = String(e.d.id), m = leadOk(e.d, ceo) ? e.a.effective : 'off';
    prevMode[id] = st.mode[id] || ((st.started || {})[id] ? m : 'off');
    if ((st.mode[id] || 'off') !== m) { st.mode[id] = m; dirty = true; }
  }
  const on = ds.list.filter(e => e.a.mode !== 'off' && leadOk(e.d, ceo));
  if (!on.length) { if (dirty) writeState(st, o); return () => null; }
  const now = nowOf(o), SP = require('./sprint'), SO = require('./signoff');
  const rs = rows(o), all = audits(rs), holds = new Map();
  let calls = o.calls; if (!Array.isArray(calls)) { try { calls = require('../provenance.js').recentCalls(rootOf(o), now - 7 * DAY); } catch (_) { calls = []; } }
  // released only by the lead's recorded pass or return, for that block's words (a **Passed on by:** line typed into the
  // block counts for nothing, and a pass of one block never releases another block under the same Id or heading)
  const passed = new Set(rs.filter(r => (r.op === 'pass' || r.op === 'return') && r.fp).map(r => r.ref + '@' + r.fp));
  // a drop is for the item it named (its heading fingerprint; a drop from before fingerprints, for the ref)
  const dropped = new Set(rs.filter(r => r.op === 'drop').map(r => r.hfp ? r.ref + '@' + r.hfp : r.ref));
  const isDropped = (ref, hfp) => dropped.has(ref + '@' + hfp) || dropped.has(ref);
  const people = peopleOf(crew);
  const hold = (inbox, heading, v) => holds.set(inbox + '\n' + heading, v);
  const would = (key, text) => { if (st.would[key]) return; st.would[key] = new Date(now).toISOString(); dirty = true; log(text); };
  const texts = new Map(); const textOf = ib => { if (!texts.has(ib)) texts.set(ib, readText(path.join(paths(o).handoffs, ib)) || ''); return texts.get(ib); };
  // an inbox as its blocks, in file order: [{ sec, it }] (two blocks may share a ref: a reused Id or heading)
  const blocksOf = ib => sections(textOf(ib)).filter(s => s.startsWith('## ')).map(sec => ({ sec, it: SP.parseItems(sec)[0] })).filter(b => b.it);
  const tell = (key, inbox, heading, fields, line) => { if (st.told[key]) return; appendBlock(o, inbox, heading, fields); st.told[key] = new Date(now).toISOString(); dirty = true; log(line); };
  st.told = st.told || {}; st.passReopened = st.passReopened || {};
  // what the dispatcher remembers of a member's item is keyed by its ref and heading (ref@hfp): a new item under a known Id
  // is a new item. A record from before fingerprints (keyed by the ref alone) goes to the first block under that ref
  const seenOf = (ref, hfp) => {
    const k = ref + '@' + hfp; if (st.seen[k]) return st.seen[k];
    const v = st.seen[ref]; if (v && typeof v === 'object' && !v.hfp) { st.seen[k] = Object.assign({}, v, { hfp }); delete st.seen[ref]; dirty = true; return st.seen[k]; }
    return null;
  };
  const outSeen = (ref, fp) => {
    const k = 'out:' + ref + '@' + fp; if (st.seen[k]) return true;
    const v = st.seen['out:' + ref]; if (v && typeof v === 'object' && !v.fp) { st.seen[k] = Object.assign({}, v, { fp }); delete st.seen['out:' + ref]; dirty = true; return true; }
    return false;
  };
  for (const e of on) {
    const dept = String(e.d.id), lead = String(e.d.lead), leadName = nameOf(crew, lead), live = e.a.effective === 'live', leadInbox = (crew[lead] || {}).inbox;
    const members = D.members(e.d).filter(s => s !== lead && crew[s]);
    const inDept = new Set(members.concat([lead]));
    const stall = stallMs(e.a);
    try {
      const prev = prevMode[dept] || 'off';
      const fresh = !(st.started = st.started || {})[dept] || prev === 'off' || (live && prev !== 'live');
      if (fresh) {
        for (const m of members) { const ib = (crew[m] || {}).inbox; if (!ib) continue; for (const b of blocksOf(ib)) st.seen[itemRef(ib, b.it) + '@' + headFp(b.it.heading)] = { via: 'before', dept, at: now, hfp: headFp(b.it.heading) }; }
        for (const [rid, c] of Object.entries(crew)) { if (!c || !c.inbox || inDept.has(rid)) continue; for (const b of blocksOf(c.inbox).filter(x => x.it.open)) { const fp = blockFp(b.sec); st.seen['out:' + itemRef(c.inbox, b.it) + '@' + fp] = { via: 'before', dept, at: now, fp, lines: blockLines(b.sec) }; } }
        const again = !!st.started[dept];
        st.started[dept] = new Date(now).toISOString(); dirty = true;
        log('ACCOUNTABLE ' + dept + ' (' + leadName + '): ' + (live ? 'on' : 'recording only') + ' from now' + (again ? ' (was ' + (prev === 'shadow' ? 'recording only' : prev) + ')' : '') + '; the work already there is left as it was');
        continue;
      }
      // a "Pass on" block the lead closed by hand, with no recorded pass or return, goes back to OPEN (like a member's DONE):
      // only accountable.js pass releases the held message. Once per closing
      if (live && leadInbox) {
        const parts = sections(textOf(leadInbox)); let changed = false;
        for (let i = 0; i < parts.length; i++) {
          const s = parts[i]; if (!s.startsWith('## ')) continue; const it = SP.parseItems(s)[0];
          if (!it || it.open || !PASS_HEAD.test(it.heading)) continue;
          const pref = String(field(s, 'Pass-on') || '').trim(), pfp = String(field(s, 'Block') || '').trim(), key = pref + '@' + pfp, v = st.passAsked[key];
          if (!pref || !pfp || !v || typeof v !== 'object' || String(v.dept) !== dept || passed.has(key) || !heldOpen(o, v, textOf, st.passAsked)) continue;
          const k2 = key + ':' + crypto.createHash('sha1').update(String(it.status || '')).digest('hex').slice(0, 10);
          if (st.passReopened[k2]) continue;
          parts[i] = setStatus(s, 'OPEN — not passed on yet: a DONE typed here releases nothing. Pass it on (node company/tools/accountable.js pass ' + pref + ' --block ' + pfp + ' --by ' + firstName(leadName) + ') or return it (--return --why "<what to do instead>")');
          st.passReopened[k2] = new Date(now).toISOString(); dirty = true; changed = true;
          log('ACCOUNTABLE PASS-ON REOPENED ' + pref + ' (' + leadName + '): its "Pass on" block was set "' + one(it.status, 60) + '" with no recorded pass or return; back to OPEN');
        }
        if (changed && !o.dry) { writeAtomic(path.join(paths(o).handoffs, leadInbox), parts.join('')); texts.delete(leadInbox); }
      }
      // the audit packets and the pass-on blocks in the lead's inbox are the audit run's work, not its loop's (live, once
      // the routine exists): neither wakes the lead's own loop on its top tier
      if (live && leadInbox && st.routines[dept]) for (const it of SP.parseItems(textOf(leadInbox)).filter(i => i.open && (AUDIT_HEAD.test(i.heading) || PASS_HEAD.test(i.heading)))) hold(leadInbox, it.heading, { who: null, packet: true, kind: AUDIT_HEAD.test(it.heading) ? 'audit-packet' : 'pass-packet' });
      const accepted = [...all.values()].filter(x => x.hb.dept === dept && x.status === 'accepted');
      for (const m of members) {
        const ib = (crew[m] || {}).inbox; if (!ib) continue;
        const blocks = blocksOf(ib), tools = TB.picker(rootOf(o), ib)(blocks.map(b => b.it));
        for (const { sec, it } of blocks) {
          if (tools.has(it)) continue;   // the dispatcher's own block (by provenance, never by its heading)
          const ref = itemRef(ib, it), hfp = headFp(it.heading), skey = ref + '@' + hfp;
          let seen = seenOf(ref, hfp);
          const last = latestFor(all, ref, hfp);
          // 1. intake: how the work reached the member. Every item counts as the lead's: assigned by the lead, sent
          // straight to the member by someone else, written by the member itself, or by a writer nobody can tell
          // (the console, a script, a heading that names nobody): the last two are never let past the lead. A new item
          // under a known Id (another heading) is a new item: its own intake, never a reopen of the old one
          if (!seen) {
            // the writer is the seat whose run wrote it; a heading's "from <name>" is only a claim (recorded, never trusted)
            const writer = runWriter(it.heading, sec, crew, calls, ib) || null, claimed = writer ? undefined : (claimOf(it.heading, crew) || (isDispatcherBlock(it.heading) ? 'Dispatcher' : undefined));
            const via = writer === lead ? 'lead' : writer === m ? 'own' : 'direct';
            const reused = Object.keys(st.seen).some(k => k.startsWith(ref + '@') && k !== skey) || rs.some(r => r.op === 'intake' && r.ref === ref && r.hfp && r.hfp !== hfp);
            seen = st.seen[skey] = { via, dept, at: now, writer, hfp }; dirty = true;
            append({ op: 'intake', at: now, ts: new Date(now).toISOString(), ref, hfp, file: ib, title: one(it.heading, 160), seat: m, dept, lead, via, writer, claimed, reused: reused || undefined, checkCmd: checkCommandOf(sec), check: acceptanceOf(sec), risk: String(field(sec, 'Risk') || '').trim(), shadow: live ? undefined : true }, o);
            // the member learns the way back on the item itself: check it, then hand it back to the lead (live)
            if (live && it.open && field(sec, 'Hand back') == null) { editBlock(o, ib, s => s === sec, s => addLine(s, '**Hand back:** to ' + leadName + ' for audit when it is done: check it against its acceptance check, then node company/tools/accountable.js handback ' + (it.id || ref) + ' --note "<what you checked>" --by ' + firstName(nameOf(crew, m)) + ' (it is DONE only when ' + firstName(leadName) + ' accepts it)' + (acceptanceOf(sec) ? '' : '. It has no acceptance check yet: ask ' + firstName(leadName) + ' for one'))); texts.delete(ib); }
            if (via !== 'lead') {
              const who = writer ? nameOf(crew, writer) : 'Someone the crew could not identify' + (claimed ? ' (the heading says ' + (claimed === 'Dispatcher' ? 'the dispatcher' : nameOf(crew, claimed)) + ')' : '');
              const how = (via === 'own' ? nameOf(crew, m) + ' wrote this for themselves.' : who + ' sent this straight to ' + nameOf(crew, m) + '.') + (reused ? ' It reuses the Id of an earlier item (' + ref + '), but it is a new item.' : '');
              if (live && !st.copied[skey]) {
                appendBlock(o, leadInbox, 'copy: ' + one(headWords(it.heading), 90) + ' (' + (via === 'own' ? firstName(nameOf(crew, m)) + '\'s own item' : 'sent straight to ' + firstName(nameOf(crew, m))) + ')', {
                  'Copy of': ref, FYI: how + ' It counts as yours: ' + firstName(nameOf(crew, m)) + ' hands it back to you for audit, and it is done only when you accept it. Reassign it, drop it or add its acceptance check if it needs one.',
                  Status: 'DONE — a copy for the record (the work is in ' + ib + ')' });
                st.copied[skey] = new Date(now).toISOString(); log('ACCOUNTABLE COPY ' + ref + ' -> ' + leadName + ': ' + how);
              } else if (!live) would('copy:' + skey, 'WOULD COPY ' + ref + ' to ' + leadName + ' (' + how + ' Recording only)');
            } else if (reused) log('ACCOUNTABLE NEW ITEM ' + ref + ' (' + nameOf(crew, m) + '): a new item under a known Id; its own intake');
            // 1b. a new item that fixes work the lead accepted (it names the accepted item, its audit or its PR, and asks
            // for a fix): an escape, charged to the lead's review, once per accepted audit and item. Not one: an item that
            // only moves the same PR to a new commit (a rebase, fixing its merge conflicts) and names no fixed item
            const body = it.heading + '\n' + sec, words = headWords(it.heading) + '\n' + (field(sec, 'Need') || '') + '\n' + (field(sec, 'Fixes') || '');
            const FIX_RE = /\b(?:fix|fixes|bug|broke|broken|regress\w*|revert\w*|still fails?|failing|wrong)\b/i;
            if (FIX_RE.test(words)) {
              const onlyMoves = /\b(?:rebas\w*|conflicts?|update (?:the )?branch|onto (?:main|master)|catch(?:es|ing)? up with (?:main|master))\b/i.test(words) && field(sec, 'Fixes') == null
                && !FIX_RE.test(words.replace(/\bfix(?:es|ing)?\s+(?:the\s+|any\s+|its\s+|all\s+)?(?:merge\s+|rebase\s+)?conflicts?\b/gi, ' '));
              const itemPr = field(sec, 'PR') ? normPr(field(sec, 'PR')) : null;
              for (const x of accepted) {
                if (x.hb.ref === ref && fpMatch(x.hb.hfp, hfp)) continue;
                const byPr = !!x.hb.pr && (body.includes(String(x.hb.pr)) || (itemPr && itemPr === normPr(x.hb.pr)));
                const byItem = body.includes(x.id) || body.includes(x.hb.ref) || (x.hb.item && new RegExp('(?:^|[\\s(`#])' + String(x.hb.item).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[\\s),.`])', 'm').test(String(field(sec, 'Fixes') || '')));
                const key = x.id + ':' + skey;
                if (!(byItem || byPr) || st.autoEscapes[key]) continue;
                st.autoEscapes[key] = new Date(now).toISOString(); dirty = true;
                if (onlyMoves && !byItem) { log('ACCOUNTABLE REBASE ' + ref + ': moves ' + x.hb.pr + ' (accepted in ' + x.id + ') to a new commit; not a problem in ' + nameOf(crew, x.verdict.by) + '\'s check'); continue; }
                const r = escape({ root: rootOf(o), now, id: x.id, by: 'dispatcher', why: 'a new item fixes it: ' + ref + ' (' + one(headWords(it.heading), 100) + ')', crew, dry: o.dry });
                if (r.ok) log('ACCOUNTABLE ESCAPE ' + x.id + ' ' + x.hb.ref + ': ' + ref + ' fixes work ' + nameOf(crew, x.verdict.by) + ' accepted; charged to the lead\'s review');
              }
            }
            if (it.open) continue;
          }
          if (seen.via === 'before') continue;
          // 2. handed back and waiting for the audit: the member is not woken for it
          if (it.open && last && last.status === 'open' && live) { hold(ib, it.heading, { who: leadName, kind: 'audit' }); continue; }
          // 2b. an open item with no acceptance check cannot be handed back: the lead is told once after stallHours, the CEO
          // once after twice that
          if (it.open && !acceptanceOf(sec) && !isDropped(ref, hfp) && !(last && last.status === 'open')) {
            const age = now - Number(seen.at || now), hrs = Math.floor(age / HOUR);
            if (age >= stall) {
              if (!live) would('nocheck:' + skey, 'WOULD ASK ' + leadName + ' for an acceptance check on ' + ref + ' (' + hrs + 'h without one; recording only)');
              else tell('nocheck:' + skey, leadInbox, 'acceptance check needed: ' + one(headWords(it.heading), 80) + ' (' + firstName(nameOf(crew, m)) + ')', {
                'Needs check': ref, Need: nameOf(crew, m) + '\'s item ' + ref + ' has had no acceptance check for ' + hrs + ' hours, so ' + firstName(nameOf(crew, m)) + ' cannot hand it back and it cannot be done. Add **Acceptance check:** (and a **Check command:** that runs) to it, or drop it (node company/tools/accountable.js drop ' + ref + ' --why "<why>" --by ' + firstName(leadName) + ').', Status: 'OPEN' },
                'ACCOUNTABLE NO CHECK ' + ref + ' (' + nameOf(crew, m) + '): ' + hrs + 'h with no acceptance check; ' + leadName + ' asked to add one');
              if (live && age >= 2 * stall && crew[ceo] && ceo !== lead) tell('nocheck-ceo:' + skey, (crew[ceo] || {}).inbox, 'waiting for an acceptance check: ' + one(headWords(it.heading), 80), {
                'Needs check': ref, Need: nameOf(crew, m) + '\'s job (' + ref + ') has waited ' + hrs + ' hours for ' + leadName + ' to say how it will be checked, so it cannot be finished. ' + firstName(leadName) + ' was asked ' + Math.floor(stall / HOUR) + ' hours ago. Settle it with ' + firstName(leadName) + '.', Status: 'OPEN' },
                'ACCOUNTABLE NO CHECK ' + ref + ': ' + hrs + 'h; told ' + nameOf(crew, ceo));
            }
          }
          // 3. DONE without the lead's ACCEPT: put back to OPEN (live), once per closing
          if (!it.open && !(last && last.status === 'accepted') && !isDropped(ref, hfp) && seen.dept === dept) {
            const key = skey + ':' + crypto.createHash('sha1').update(String(it.status || '')).digest('hex').slice(0, 10);
            if (/^DONE\b/i.test(String(it.status || '')) && !st.doneHeld[key]) {
              if (live) {
                editBlock(o, ib, s => s === sec, s => setStatus(s, 'OPEN — not done until ' + leadName + ' accepts it: check it against its acceptance check, then hand it back (node company/tools/accountable.js handback ' + (it.id || ref) + ' --note "<what you checked>" --by ' + firstName(nameOf(crew, m)) + ')'));
                texts.delete(ib);
                append({ op: 'done-held', at: now, ts: new Date(now).toISOString(), ref, hfp, seat: m, dept, lead, status: one(it.status, 120) }, o);
                st.doneHeld[key] = new Date(now).toISOString(); dirty = true;
                log('ACCOUNTABLE DONE HELD ' + ref + ' (' + nameOf(crew, m) + '): set DONE without ' + leadName + '\'s accept; back to OPEN');
              } else would('done:' + key, 'WOULD HOLD DONE ' + ref + ' (' + nameOf(crew, m) + '): no accept from ' + leadName + ' (recording only)');
            }
          }
          // 4. an accepted item reopened later: an escape, charged to the lead's review (once per audit; the lead may
          // dispute it, accountable.js dispute, and the people seat rules). Only the accepted item itself: last is the
          // hand-back of this heading, so a new item under its Id is never counted as a reopen
          if (it.open && last && last.status === 'accepted' && !st.autoEscapes[last.id]) {
            st.autoEscapes[last.id] = new Date(now).toISOString(); dirty = true;
            const r = escape({ root: rootOf(o), now, id: last.id, by: 'dispatcher', why: 'the accepted item was reopened (' + one(it.status, 100) + ')', crew, dry: o.dry });
            if (r.ok) log('ACCOUNTABLE ESCAPE ' + last.id + ' ' + ref + ': accepted by ' + leadName + ', reopened since; charged to the lead\'s review');
          }
        }
      }
      // 5. onward handoffs: a member's open block to anyone outside the department waits for the lead to pass it on. Not
      // held: a block to the people seat (a member's complaint about its lead goes straight there) and an FYI that asks
      // for nothing. Who wrote it (outWriter): the run that wrote it; else what the heading claims, when it claims the
      // department (a member, the lead) or the dispatcher (whose real blocks are known by provenance, so a claim is a
      // forgery); else a member whose run wrote into that inbox around the time the block appeared. A heading's claim is
      // never let past the lead: the lead passes it, or returns it. Every record here is for the block's words (blockFp):
      // a new block reusing a passed block's Id or heading is held again. A P0 is never held on a guess about its writer
      // (a tool's notice, a security alarm): only when a member's run is seen writing it, and then it stalls after an hour
      st.outWho = st.outWho || {}; st.outFirst = st.outFirst || {};
      const outWriter = (inbox, it, sec, key) => {
        if (st.outWho[key]) return st.outWho[key];
        const keep = v => { st.outWho[key] = v; dirty = true; return v; };
        const tw = runWriter(it.heading, sec, crew, calls, inbox);
        if (tw) return keep({ writer: tw, sure: true, at: now });
        const cl = claimOf(it.heading, crew);
        if (cl && inDept.has(cl)) return { writer: cl, sure: false, claimed: cl };
        if (isDispatcherBlock(it.heading)) return { writer: null, sure: false, claimed: 'Dispatcher' };
        // a heading that names its sender outside the department (the owner's routed message, a tool's notice, another
        // seat) is never given to a member on the guess that its run wrote into that inbox around then
        if (namedSender(it.heading)) return null;
        const first = Number(st.outFirst[key]) || now; if (!st.outFirst[key]) { st.outFirst[key] = now; dirty = true; }
        const t = (calls || []).filter(x => x && members.includes(String(x.agentId)) && Number(x.ts) >= first - 3 * HOUR && Number(x.ts) <= first + 30 * MIN && writesFile(x, inbox));
        if (t.length) return keep({ writer: String(t[t.length - 1].agentId), sure: false, touched: true, at: now });
        return null;
      };
      for (const [rid, c] of Object.entries(crew)) {
        if (!c || !c.inbox || inDept.has(rid)) continue;
        const blocks = blocksOf(c.inbox), tools = TB.picker(rootOf(o), c.inbox)(blocks.map(b => b.it));
        for (const { sec, it } of blocks) {
          if (!it.open || tools.has(it)) continue;   // the dispatcher's and the tools' own blocks (by provenance)
          const ref = itemRef(c.inbox, it);
          let fp = blockFp(sec), key = ref + '@' + fp;
          if (passed.has(key) || outSeen(ref, fp)) continue;
          // the same block with lines added since its pass, return, baseline or hold (a lane's mark, the receiver's notes)
          // is still that block; lines a member is seen adding are new words, held again
          const same = rec => sameBlock(rec, sec, c.inbox, members, calls);
          if (rs.some(r => (r.op === 'pass' || r.op === 'return') && r.ref === ref && r.fp && Array.isArray(r.lines) && same(r))) continue;
          if (Object.keys(st.seen).some(k => k.startsWith('out:' + ref + '@') && st.seen[k] && typeof st.seen[k] === 'object' && Array.isArray(st.seen[k].lines) && same(st.seen[k]))) continue;
          const prior = Object.values(st.passAsked).find(v => v && typeof v === 'object' && v.ref === ref && v.inbox === c.inbox && v.fp && v.fp !== fp && same(v));
          if (prior) { fp = prior.fp; key = ref + '@' + fp; if (passed.has(key)) continue; }
          const w = outWriter(c.inbox, it, sec, key), writer = w ? w.writer : null;
          if (w && w.sure && writer === lead && rid === String(ceo) && readsAsEscalation(it.heading, sec) && !escalationOk(field(sec, 'Escalation')).ok) {
            // the lead's own escalation to the CEO names no reason that belongs there
            if (live) {
              hold(c.inbox, it.heading, { who: leadName, kind: 'escalation' });
              if (!st.escNoted[key]) { appendBlock(o, leadInbox, 'escalation held: ' + one(it.heading, 90), { Need: 'Your message to ' + nameOf(crew, ceo) + ' ("' + one(it.heading, 120) + '") asks for something, so it is held: one level at a time, a lead takes a matter to the CEO only when it crosses departments or is one of the four owner gates. Add **Escalation:** cross-department or **Escalation:** owner: money|access|ownership|commitment to that block, mark it FYI if it asks for nothing, or solve it in the department and set it DONE.', Status: 'OPEN' }); st.escNoted[key] = new Date(now).toISOString(); dirty = true; log('ACCOUNTABLE ESCALATION HELD ' + ref + ' (' + leadName + ' -> CEO): no cross-department or owner-gate reason'); }
            } else would('esc:' + key, 'WOULD HOLD ESCALATION ' + ref + ' (' + leadName + ' -> CEO): no cross-department or owner-gate reason (recording only)');
            continue;
          }
          if (!w || (w.sure && !members.includes(writer)) || (people && rid === people) || fyiOnly(sec, it.heading)) continue;
          const p0 = isP0(sec);
          if (p0 && !w.sure) {
            // urgent, and only a guess says a member wrote it: delivered, and the lead is told
            const guess = w.touched ? nameOf(crew, writer) + '\'s run wrote into ' + c.inbox + ' then' : 'the heading says ' + (w.claimed === 'Dispatcher' ? 'the dispatcher' : nameOf(crew, writer));
            if (live) tell('p0:' + key, leadInbox, 'FYI P0 not held: ' + one(headWords(it.heading), 80) + ' (to ' + firstName(nameOf(crew, rid)) + ')', {
              'P0 not held': ref, FYI: 'An urgent (P0) message reached ' + nameOf(crew, rid) + ' ("' + one(it.heading, 120) + '" in ' + c.inbox + ') without waiting for you: nothing shows who wrote it (' + guess + '), and an urgent notice is never held on a guess. If one of your team wrote it, talk to them.', Status: 'DONE — FYI' },
              'ACCOUNTABLE P0 NOT HELD ' + ref + ' (-> ' + nameOf(crew, rid) + '): no run shows a member wrote it (' + guess + '); delivered, ' + leadName + ' told');
            else would('p0:' + key, 'WOULD LET P0 THROUGH ' + ref + ' (-> ' + nameOf(crew, rid) + '): no run shows a member wrote it (recording only)');
            continue;
          }
          // who the lead is told wrote it: the member, or what the heading claims when no run shows the writer
          const whoName = w.sure || w.touched ? nameOf(crew, writer) : w.claimed === 'Dispatcher' ? 'someone (the heading says the dispatcher)' : nameOf(crew, writer);
          const whoWords = w.sure ? nameOf(crew, writer) : w.touched ? nameOf(crew, writer) + ' (whose run wrote into that inbox then)' : 'A message that says it is from ' + (w.claimed === 'Dispatcher' ? 'the dispatcher' : nameOf(crew, writer)) + ' (the crew cannot confirm who wrote it, so it goes through you)';
          const short = w.claimed === 'Dispatcher' ? '?' : firstName(nameOf(crew, writer));
          if (live) {
            hold(c.inbox, it.heading, { who: leadName, kind: 'pass' });
            if (!st.passAsked[key]) {
              const toCeo = rid === String(ceo), dup = blocks.filter(b => itemRef(c.inbox, b.it) === ref).length > 1;
              const head = 'Pass on: ' + one(headWords(it.heading), 80) + ' (' + short + ' -> ' + firstName(nameOf(crew, rid)) + ')';
              appendBlock(o, leadInbox, head, {
                'Pass-on': ref, Block: fp, Need: (p0 ? 'URGENT (P0). ' : '') + whoWords + ' wrote to ' + nameOf(crew, rid) + ' ("' + one(it.heading, 120) + '" in ' + c.inbox + ').' + (passedBefore(rs, ref, fp) ? ' It reuses the Id or heading of a message you already passed on, but its words are new, so it waits for you again.' : '') + ' It waits for you: work leaves the department through its lead. Pass it on (node company/tools/accountable.js pass ' + ref + (dup ? ' --block ' + fp : '') + (toCeo ? ' --escalation cross-department|"owner: money|access|ownership|commitment"' : '') + ' --by ' + firstName(leadName) + ') once the work behind it is accepted, or return it (--return --why "<what to do instead>"). Setting this block DONE by hand releases nothing.' + (toCeo ? ' It goes to the CEO, so it passes only when it crosses departments or is one of the four owner gates.' : ''),
                Status: 'OPEN' });
              st.passAsked[key] = { at: new Date(now).toISOString(), dept, ref, fp, lines: blockLines(sec), inbox: c.inbox, heading: head, p0: p0 || undefined }; dirty = true;
              log('ACCOUNTABLE PASS HELD ' + ref + ' (' + whoName + ' -> ' + nameOf(crew, rid) + '): waits for ' + leadName + ' to pass it on' + (w.sure ? '' : w.touched ? ' (no heading names the writer; ' + nameOf(crew, writer) + '\'s run wrote into ' + c.inbox + ')' : ' (the heading\'s writer is not confirmed by any run)'));
            }
          } else would('pass:' + key, 'WOULD HOLD ' + ref + ' (' + whoName + ' -> ' + nameOf(crew, rid) + ') for ' + leadName + ' to pass on (recording only)');
        }
      }
      // 6. spot checks: about 1 in spotCheckEvery accepts, picked by the audit's own id (random, so the lead cannot tell
      // which ones), checked again by the people function
      const every = Math.max(0, Number(e.a.scorecard.spotCheckEvery) || 0);
      if (live && every > 0) {
        const checker = people && people !== lead ? people : (crew[lead] || {}).manager || ceo;
        for (const x of accepted) {
          if (!spotPicked(x.id, every) || st.spots[x.id] || !crew[checker] || checker === x.hb.seat || checker === x.verdict.by) continue;
          appendBlock(o, (crew[checker] || {}).inbox, 'spot check: ' + one(headWords(x.hb.title), 80) + ' (accepted by ' + firstName(leadName) + ')', {
            'Spot check': x.id, Need: 'Check again, cheaply, one item ' + leadName + ' accepted: ' + x.hb.ref + ' (acceptance check: ' + one(x.hb.check, 200) + '). Read the change against that check and answer: node company/tools/accountable.js spot ' + x.id + ' --result agree|disagree --why "<what you checked>" --by ' + firstName(nameOf(crew, checker)) + '. It goes on ' + firstName(leadName) + '\'s department scorecard, so rubber-stamping shows.',
            Status: 'OPEN' });
          st.spots[x.id] = new Date(now).toISOString(); dirty = true; log('ACCOUNTABLE SPOT CHECK ' + x.id + ' -> ' + nameOf(crew, checker));
        }
      }
    } catch (err) { log('ACCOUNTABLE ERROR (' + dept + '): ' + String(err && err.message || err).slice(0, 200)); }
  }
  // what step 5 remembers about blocks out of a department is kept 14 days
  for (const k of ['outWho', 'outFirst']) for (const [r, v] of Object.entries(st[k] || {})) { const at = typeof v === 'object' ? Number(v && v.at) : Number(v); if (!(at > now - 14 * DAY)) { delete st[k][r]; dirty = true; } }
  if (dirty) writeState(st, o);
  return (inbox, it) => (it ? holds.get(inbox + '\n' + it.heading) || null : null);
}
// a pass or return recorded for another block under the same ref (the Id or heading reused)
const passedBefore = (rs, ref, fp) => rs.some(r => (r.op === 'pass' || r.op === 'return') && r.ref === ref && r.fp !== fp);
// the held block of a pass-on record ({ ref, fp, lines, inbox }) is still there and OPEN: the same words, or lines only
// added since (a lane's mark, the receiver's notes), unless those words are now held under another record (asked)
function heldOpen(o, v, textOf, asked) {
  const SP = require('./sprint'), t = textOf ? textOf(v.inbox) : (readText(path.join(paths(o).handoffs, v.inbox)) || '');
  const other = s => Object.values(asked || {}).some(w => w && typeof w === 'object' && w !== v && w.ref === v.ref && w.fp && w.fp !== v.fp && w.fp === blockFp(s));
  return sections(t).some(s => { if (!s.startsWith('## ')) return false; const it = SP.parseItems(s)[0]; return !!it && it.open && itemRef(v.inbox, it) === v.ref && (blockFp(s) === v.fp || (!!addedSince(v, s) && !other(s))); });
}

/* ---------------- merge-gate.js ---------------- */
// whether a PR needs a lead's accept is decided by the PR, not by who merges it: a PR a member of an accountable department
// handed back, or one a member's item names (**PR:**), or any PR the merging seat (a member) presents. It clears only with
// an ACCEPT for that PR at exactly this head commit (the hand-back's --sha). Recording only lets it through and says so
const normPr = r => { const m = String(r || '').match(/([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)/); return m ? m[1].toLowerCase() + '#' + m[2] : String(r || '').toLowerCase(); };
// owner/repo#n for a PR reference that names its repository, or a bare number (#12, PR 12) in --cwd's GitHub origin; else null
function prKeyOf(ref, cwd) {
  const r = String(ref || '').trim();
  if (/([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)/.test(r)) return normPr(r);
  const n = /^(?:pr|pull(?: request)?)?\s*#?\s*(\d+)$/i.exec(r); if (!n || !cwd) return null;
  const u = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = u.status === 0 ? /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(u.stdout).trim()) : null;
  return m ? (m[1] + '/' + m[2]).toLowerCase() + '#' + n[1] : null;
}
// the member an accountable department audits that a PR names as its maker (null if none): the head branch's first part
// ("ben/fix-parser"), the PR author's GitHub login (loops.json github), an "Author: <name>" line in the PR or a commit,
// a "(Name)" commit subject, or a commit's git author name
function prMember(inf, ds, crew, ceo) {
  const cand = [];
  const br = String(inf.headRefName || inf.branch || '').trim(); if (br) cand.push(br.split(/[\/]/)[0], br.split(/[\/_-]/)[0]);
  const login = String((inf.author && (inf.author.login || inf.author.name)) || inf.author || '').trim().toLowerCase();
  const au = t => { const m = String(t || '').match(/^[ \t>*_]*Author[ \t*_]*[:—–-][ \t*_]*([A-Za-z][A-Za-z0-9_-]*)/im); return m ? m[1] : null; };
  if (au(inf.body)) cand.push(au(inf.body));
  for (const c of inf.commits || []) {
    const subj = String(c.messageHeadline || c.subject || '').trim(), m = subj.match(/\(([A-Z][a-z]+)\)(?:\s*\(#\d+\))*\s*$/);
    if (m) cand.push(m[1]); if (au(c.messageBody || c.body)) cand.push(au(c.messageBody || c.body));
    for (const x of c.authors || []) if (x && x.name) cand.push(x.name);
  }
  for (const y of ds.list) {
    if (y.a.mode === 'off' || !leadOk(y.d, ceo)) continue;
    for (const m of D.members(y.d)) {
      if (m === String(y.d.lead) || !crew[m]) continue;
      const names = [m, crew[m].name, firstName(crew[m].name)].filter(Boolean).map(x => String(x).toLowerCase());
      if ((login && crew[m].github && String(crew[m].github).toLowerCase() === login) || cand.some(x => names.includes(String(x).toLowerCase()))) return { e: y, seat: m };
    }
  }
  return null;
}
function gate(a, o) {
  o = o || {}; const crew = crewOf(o), ceo = ceoOf(o, crew);
  let ds; try { ds = deptState(o); } catch (_) { return { needed: false }; }
  const want = (a.refs || []).map(normPr).filter(Boolean), sha = String(a.sha || '').trim().toLowerCase();
  const onDept = id => ds.list.find(y => String(y.d.id) === String(id) && y.a.mode !== 'off' && leadOk(y.d, ceo)) || null;
  const handed = [...audits(rows(o)).values()].filter(x => !x.hb.shadow && x.hb.pr && want.includes(normPr(x.hb.pr)));
  let e = null, owner = null;
  for (const x of handed.slice().reverse()) { const y = onDept(x.hb.dept); if (y) { e = y; owner = x.hb.seat; break; } }
  if (!e) {
    const SP = require('./sprint');
    outer: for (const y of ds.list) {
      if (y.a.mode === 'off' || !leadOk(y.d, ceo)) continue;
      for (const m of D.members(y.d)) {
        if (m === String(y.d.lead) || !crew[m] || !crew[m].inbox) continue;
        for (const sec of sections(readText(path.join(paths(o).handoffs, crew[m].inbox)) || '')) {
          if (!sec.startsWith('## ') || !SP.parseItems(sec)[0]) continue;
          const p = field(sec, 'PR'); if (p && want.includes(normPr(p))) { e = y; owner = m; break outer; }
        }
      }
    }
  }
  const seat = seatOf(crew, a.seat);
  if (!e && seat) { e = memberDept(seat, ds, ceo); owner = e ? seat : null; }
  // a PR nobody handed back or named: the PR itself says whose run made it (its head branch, its author, an Author line
  // or a "(Name)" commit subject, as competence.js reads authorship), so a member's PR needs the accept whoever merges it
  // When the PR cannot be read (gh failed): with a live department that has members, refused (fail closed: a member's PR
  // would otherwise merge unchecked), and logged; with recording only, let through and logged
  if (!e && typeof a.info === 'function') {
    let inf = null, err = null; try { inf = a.info(); } catch (x) { err = x; }
    if (!inf || typeof inf !== 'object') {
      const liveDept = ds.list.find(y => y.a.effective === 'live' && leadOk(y.d, ceo) && D.members(y.d).some(m => m !== String(y.d.lead) && crew[m]));
      const why = one(err ? (err.message || err) : 'no answer', 160);
      logLine(o, 'ACCOUNTABLE GATE ' + (want[0] || 'a pull request') + ': could not read who made it (' + why + '); ' + (liveDept ? 'refused until it can be read' : 'let through (recording only)'));
      if (liveDept) return { needed: true, cleared: false, mode: 'live', unread: true, refuse: 'the crew could not read who made ' + (want[0] || 'this pull request') + ' (' + why + '), and a team member\'s work in ' + (liveDept.d.name || liveDept.d.id) + ' merges only once ' + nameOf(crew, liveDept.d.lead) + ' accepts it: try again in a few minutes' };
      return { needed: false, unread: true };
    }
    const hit = prMember(inf, ds, crew, ceo); if (hit) { e = hit.e; owner = hit.seat; }
  }
  if (!e) return { needed: false };
  const acc = handed.filter(x => x.status === 'accepted' && x.hb.dept === String(e.d.id));
  const ok = sha ? acc.find(x => x.hb.sha && (sha.startsWith(x.hb.sha) || x.hb.sha.startsWith(sha)) && Math.min(sha.length, x.hb.sha.length) >= 7) : null;
  const leadName = nameOf(crew, e.d.lead);
  if (ok) return { needed: true, cleared: true, mode: e.a.effective, audit: ok.id };
  // a stale accept (another commit): the same item is handed back again at this head, found by its id even once it is
  // archived (handback looks it up in the ledger), so the refusal names that exact command
  const last = acc.slice().sort((x, y) => Number(y.hb.at) - Number(x.hb.at))[0] || null, mem = firstName(nameOf(crew, (last && last.hb.seat) || owner));
  const why = nameOf(crew, owner) + '\'s work is audited by ' + leadName + ' (the lead of ' + (e.d.name || e.d.id) + '), and there is no accept for ' + (want[0] || 'this pull request') + (seat && seat !== owner ? ' (whoever merges it)' : '')
    + (last ? ' at this commit (the accept was for another commit, ' + String(last.hb.sha).slice(0, 12) + '): ' + mem + ' hands the same item back at this head with node company/tools/accountable.js handback ' + (last.hb.item && !String(last.hb.item).includes('#') ? last.hb.item : last.hb.ref) + ' --pr ' + last.hb.pr + ' --cwd <repo> --sha ' + (sha || '<head>') + ' --note ".." --by ' + mem + ' (no reopen needed, also once the item is archived), and it merges once ' + firstName(leadName) + ' accepts'
      : ': hand it back with node company/tools/accountable.js handback <item> --pr <url> --cwd <repo> --sha <head> --note ".." --by ' + firstName(nameOf(crew, owner)) + ', and merge once ' + firstName(leadName) + ' accepts');
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
// the messages held for the lead's pass: { ref, fp, key, at (when the hold began), heading, file, p0 }. Worked out from the
// holds themselves (passAsked: a block held, with no recorded pass or return for its words, still OPEN where it is), not
// from the lead's "Pass on" block, so a "Pass on" block closed or deleted by hand never hides a held message. A "Pass on"
// block from before these records (no Block line) still counts while it is OPEN
function heldPasses(o, crew, lead, st, dept, rs) {
  const li = (crew[lead] || {}).inbox, out = [], keys = new Set(), now = nowOf(o);
  const done = new Set((rs || []).filter(r => (r.op === 'pass' || r.op === 'return') && r.fp).map(r => r.ref + '@' + r.fp));
  const cache = new Map(), textOf = ib => { if (!cache.has(ib)) cache.set(ib, readText(path.join(paths(o).handoffs, ib)) || ''); return cache.get(ib); };
  for (const [key, v] of Object.entries((st && st.passAsked) || {})) {
    if (!v || typeof v !== 'object' || String(v.dept) !== String(dept) || done.has(key) || !heldOpen(o, v, textOf, st && st.passAsked)) continue;
    keys.add(key); out.push({ ref: v.ref, fp: v.fp, key, at: Date.parse(v.at || '') || now, heading: v.heading || 'Pass on: a message', file: li, p0: !!v.p0 });
  }
  if (!li) return out;
  const SP = require('./sprint');
  for (const sec of sections(textOf(li))) {
    if (!sec.startsWith('## ')) continue; const it = SP.parseItems(sec)[0];
    if (!it || !it.open || !PASS_HEAD.test(it.heading) || field(sec, 'Block')) continue;
    const ref = String(field(sec, 'Pass-on') || '').trim(); if (!ref) continue;
    const at = ((st && st.passAsked) || {})[ref];
    out.push({ ref, fp: null, key: ref, at: Date.parse(typeof at === 'string' ? at : '') || now, heading: it.heading, file: li, p0: false });
  }
  return out;
}
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
  st.holdWhy = st.holdWhy || {}; st.stallTold = st.stallTold || {};
  const SP = require('./sprint');
  for (const e of live) {
    const dept = String(e.d.id), lead = String(e.d.lead), leadName = nameOf(crew, lead), lf = firstName(leadName);
    // why the audit waits, in the owner's words (owner: the cause is one the owner controls), for the stall notice below
    const held = (why, owner, tech) => { st.holdWhy[dept] = { why, owner: !!owner, tech: one(tech || why, 200), at: now }; out.held.push(dept); };
    const waitingPasses = heldPasses(o, crew, lead, st, dept, rows(o));
    // the run: a missing routine or a busy run falls through to the stall check below (break step), never past it
    step: try {
      const r = st.routines[dept], job = r && jobs.find(j => j.id === r.jobId);
      if (!job) { if ((pendingAudits(all, dept).length || waitingPasses.length) && !o.dry) { const t = 'AUDIT HOLD ' + leadName + ': the audit routine is missing (it is made again on the next tick)'; log(t); held('the run that does ' + lf + '\'s checks could not be set up', false, t); } break step; }
      const loopJob = crew[lead] && crew[lead].loop ? SCHED.crewLoopOf(jobs, crew[lead].loop) : null;
      const busy = !!(job.inFlight || job.state === 'running'), loopBusy = !!(loopJob && (loopJob.inFlight || loopJob.state === 'running'));
      if (busy) { dropSeat(lead); say(lead, { state: 'working' }); break step; }
      const open = pendingAudits(all, dept).filter(x => !ran.has(x.id));
      // the lead's open "Pass on" blocks are this run's work too (routine tier), so they never wake its loop on the top tier
      const passes = waitingPasses.filter(p => !ran.has('pass:' + p.key)).map(p => ({ id: 'pass:' + p.key, hb: { at: p.at, tier: 'routine', file: p.file, item: p.ref, title: p.heading } }));
      for (const tier of ['risky', 'routine']) {
        const mine = open.filter(x => x.hb.tier === tier).concat(tier === 'routine' ? passes : []); if (!mine.length) continue;
        const bd = C.batchDue({ pending: mine.map(x => ({ id: x.id, at: x.hb.at })), lastAdvise: st.lastAudit[dept], inFlight: loopBusy ? leadName + '\'s own loop is running' : false, batch: e.a.batch, now });
        if (!bd.start) continue;
        const pair = auditPair(tier, e.a, ds.st), ids = mine.map(x => x.id);
        if (!pair) { const t = 'AUDIT HOLD ' + leadName + ' (' + tier + '): no audit model is set and the department has no lead model'; log(t); held('no setup is chosen for ' + lf + '\'s checks', true, t); break; }
        // the fixed pair, or wait: an audit is never moved to another model (no router chooses it)
        const classes = ['review'].concat(e.d.defaultClass && e.d.defaultClass !== 'review' ? [String(e.d.defaultClass)] : []);
        let shut = null, plain = null;
        if (classes.includes('code') && pair.provider === 'custom') { shut = 'code is never audited on the MiniMax plan'; plain = 'the setup chosen for ' + lf + '\'s checks is not allowed for code'; }
        if (!shut) try { const R = require('./routing'); const L = R.loadPolicy(o.root); if (L) for (const c of classes) if (!R.routeAllowed(c, { provider: pair.provider, model: pair.model }, R.knobs(L.policy))) { shut = 'the class rules deny it for ' + c + ' work'; plain = 'the rules for which setup does which work do not allow ' + lf + '\'s checking setup'; break; } } catch (_) {}
        if (!shut) { shut = require('./override-allow').openFor(lead, pair, { root: o.root }); if (shut) plain = lf + '\'s model is closed right now'; }
        if (!shut) { shut = require('./delegate-allow').moneyFn(ctx.budget)(lead, pair.provider); if (shut) plain = 'the spending limit for today is reached'; }
        if (!shut && ctx.modes && ctx.modes[lead] === 'ask' && !ctx.allowAsk) { shut = 'its approval mode is "ask", so an unattended run could not save anything'; plain = lf + ' is set to ask you before acting, so the checks cannot run on their own'; }
        if (shut) { const t = 'AUDIT HOLD ' + leadName + ' (' + tier + ', ' + pair.provider + '/' + pair.model + '): ' + shut + '; the audit waits for its own model'; log(t); held(plain, true, t); break; }
        if (o.dry) { log('WOULD start ' + job.name + ' for ' + leadName + ' (' + tier + ': ' + ids.join(', ') + ')'); break; }
        const prompt = withOwnText(job.prompt, auditPrompt({ template: tmpl, lead: leadName, deptId: dept, deptName: e.d.name, ids }));
        if (prompt !== job.prompt) { const u = await ST.cron(ctx.call, 'POST', '/api/cron/update', { id: job.id, patch: { prompt } }, 'update "' + job.name + '"'); if (!u.ok) { log('AUDIT ERROR: ' + u.reason); break; } job.prompt = prompt; }
        const why = 'audit ' + ids.join(', ');
        const tk = A.admit({ door: 'audit', kind: 'run', seat: lead, jobId: job.id, provider: pair.provider, why: why.slice(0, 200) });
        if (tk.decision === 'hold') { const t = 'AUDIT HOLD ' + job.name + ': ' + tk.reason; log(t); held('the crew\'s limits on runs are holding it', false, t); break; }
        const res = await ctx.fireRun(job.id, pair);
        const runId = res.status === 200 ? W.runIdOf(res.body) : null;
        A.started(tk, Object.assign({}, res, { runId }));
        if (res.status !== 200) { const t = 'AUDIT HOLD ' + job.name + ' for ' + leadName + ': the station refused ' + pair.provider + '/' + pair.model + ' (HTTP ' + res.status + '); the audit waits for its own model'; log(t); held('the run would not start', res.status === 403, t); break; }
        const wakeId = W.newWakeId(now);
        W.record({ wakeId, seat: lead, runId, admitId: tk.id, jobId: job.id, door: 'audit', items: mine.map(x => ({ file: x.hb.file, id: x.hb.item, title: x.hb.title, due: null })), why });
        delete st.holdWhy[dept];
        append({ op: 'auditrun', at: now, ts: new Date(now).toISOString(), ids, dept, lead, tier, pair, wakeId, runId, admitId: tk.id }, o);
        st.lastAudit[dept] = now; out.ran.push(dept + ':' + tier); dropSeat(lead); say(lead, { state: 'working' });
        log('AUDIT ' + job.name + ' for ' + leadName + ' (' + tier + ' on ' + pair.provider + '/' + pair.model + (pair.effort ? '@' + pair.effort : '') + '): ' + ids.join(', ') + ' — ' + bd.why);
        break;   // one audit run per department per tick
      }
    } catch (err) { log('AUDIT ERROR (' + dept + '): ' + String(err && err.message || err).slice(0, 200)); }
    // an audit that has waited stallHours: recorded once (the CEO may then answer or drop it in the lead's place), the CEO
    // told in one plain line, and the owner too when the cause is one the owner controls (a model, the money, a mode)
    try {
      const stall = stallMs(e.a), late = pendingAudits(all, dept).filter(x => now - Number(x.hb.at) >= stall && !st.stallTold[x.id] && !x.stalled);
      if (late.length) {
        const hw = st.holdWhy[dept] && now - Number(st.holdWhy[dept].at) < stall ? st.holdWhy[dept] : null;
        const why = hw ? hw.why : (ran.has(late[0].id) ? lf + ' has not answered it yet' : lf + '\'s check has not started');
        const hrs = Math.floor((now - Math.min(...late.map(x => Number(x.hb.at)))) / HOUR);
        const lines = late.map(x => firstName(nameOf(crew, x.hb.seat)) + '\'s job (' + x.hb.ref + ', ' + x.id + ')');
        const plainLine = (late.length === 1 ? firstName(nameOf(crew, late[0].hb.seat)) + '\'s job has' : late.length + ' jobs have') + ' waited ' + hrs + ' hours for ' + lf + '\'s check: ' + why + '.';
        if (o.dry) log('WOULD tell ' + nameOf(crew, ceo) + ': ' + plainLine);
        else {
          for (const x of late) { append({ op: 'stalled', at: now, ts: new Date(now).toISOString(), id: x.id, ref: x.hb.ref, dept, lead, why, tech: hw ? hw.tech : undefined }, o); st.stallTold[x.id] = new Date(now).toISOString(); }
          appendBlock(o, (crew[ceo] || {}).inbox, 'waiting for ' + lf + '\'s check: ' + one(lines.join(', '), 120), {
            'Stalled audits': late.map(x => x.id).join(', '), Need: plainLine + ' Waiting: ' + lines.join('; ') + '. Clear the cause with ' + lf + ', or answer in ' + lf + '\'s place (node company/tools/accountable.js audit <ac-id> --verdict ACCEPT|REVISE --check "<what you checked>" [--finding ".."] --by ' + firstName(nameOf(crew, ceo)) + ') or drop the job (accountable.js drop <ref> --why ".." --by ' + firstName(nameOf(crew, ceo)) + ').',
            Status: 'OPEN' });
          log('ACCOUNTABLE STALLED ' + late.map(x => x.id).join(', ') + ' (' + leadName + ', ' + hrs + 'h): ' + (hw ? hw.tech : why) + '; told ' + nameOf(crew, ceo) + (hw && hw.owner ? ' and the owner' : ''));
          if (hw && hw.owner) try { require('./owner-notice').send({ kind: 'fyi', from: 'the dispatcher', text: plainLine, technical: 'accountable audit stalled ' + dept + ': ' + hw.tech, key: 'accountable-stall:' + dept + ':' + dayOf(now) }); } catch (_) {}
        }
      }
    } catch (err) { log('AUDIT ERROR (' + dept + ' stall): ' + String(err && err.message || err).slice(0, 200)); }
    // a member's message out of the department held stallHours for the lead's pass: the same notice (the CEO, and the
    // owner when the cause is the owner's), recorded once per block; the CEO may then pass it on or return it in the
    // lead's place (accountable.js pass <ref> --by <CEO>)
    try {
      // a P0 that a member's run wrote waits an hour at most, not stallHours
      const stall = stallMs(e.a), late = waitingPasses.filter(p => now - Number(p.at) >= (p.p0 ? Math.min(stall, HOUR) : stall) && !st.stallTold['pass:' + p.key]);
      if (late.length) {
        const hw = st.holdWhy[dept] && now - Number(st.holdWhy[dept].at) < stall ? st.holdWhy[dept] : null;
        const why = hw ? hw.why : (late.some(p => ran.has('pass:' + p.key)) ? lf + ' has not answered it yet' : lf + '\'s check has not started');
        const hrs = Math.floor((now - Math.min(...late.map(p => Number(p.at)))) / HOUR);
        const what = p => { const fromTo = /\(([^()]*?) -> ([^()]*?)\)\s*$/.exec(p.heading); return (fromTo ? (fromTo[1] === '?' ? 'a message' : fromTo[1] + '\'s message') + ' to ' + fromTo[2] : 'a message') + ' (' + p.ref + ')'; };
        const lines = late.map(what);
        const plainLine = (late.length === 1 ? what(late[0]).replace(/ \([^()]*\)$/, '').replace(/^a/, 'A') + ' has' : late.length + ' messages have') + ' waited ' + hrs + ' hours for ' + lf + ' to pass ' + (late.length === 1 ? 'it' : 'them') + ' on: ' + why + '.';
        const cf = firstName(nameOf(crew, ceo));
        if (o.dry) log('WOULD tell ' + nameOf(crew, ceo) + ': ' + plainLine);
        else {
          for (const p of late) { append({ op: 'stalled', kind: 'pass', at: now, ts: new Date(now).toISOString(), ref: p.ref, fp: p.fp || undefined, dept, lead, why, tech: hw ? hw.tech : undefined }, o); st.stallTold['pass:' + p.key] = new Date(now).toISOString(); }
          appendBlock(o, (crew[ceo] || {}).inbox, 'waiting for ' + lf + ' to pass on: ' + one(lines.join(', '), 120), {
            'Stalled pass-ons': late.map(p => p.ref).join(', '), Need: plainLine + ' Waiting: ' + lines.join('; ') + '. Clear the cause with ' + lf + ', or decide in ' + lf + '\'s place: pass it on (node company/tools/accountable.js pass <ref> --by ' + cf + ') or return it to the sender (accountable.js pass <ref> --return --why "<what to do instead>" --by ' + cf + ').',
            Status: 'OPEN' });
          log('ACCOUNTABLE STALLED PASS ' + late.map(p => p.ref).join(', ') + ' (' + leadName + ', ' + hrs + 'h): ' + (hw ? hw.tech : why) + '; told ' + nameOf(crew, ceo) + (hw && hw.owner ? ' and the owner' : ''));
          if (hw && hw.owner) try { require('./owner-notice').send({ kind: 'fyi', from: 'the dispatcher', text: plainLine, technical: 'accountable pass-on stalled ' + dept + ': ' + hw.tech, key: 'accountable-stall-pass:' + dept + ':' + dayOf(now) }); } catch (_) {}
        }
      }
    } catch (err) { log('AUDIT ERROR (' + dept + ' pass stall): ' + String(err && err.message || err).slice(0, 200)); }
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
  const escapes = acc.reduce((n, x) => n + countedEscapes(x).length, 0), disputed = acc.reduce((n, x) => n + x.disputes.filter(d => !x.rulings.some(r => r.escape === d.escape)).length, 0), spots = acc.flatMap(x => x.spots), disagree = spots.filter(s => s.result === 'disagree').length;
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const sc = { dept: String(e.d.id), name: e.d.name || e.d.id, lead: e.d.lead || null, leadName: e.d.lead ? nameOf(crew, e.d.lead) : null, mode: e.a.mode, effective: e.a.effective, withdrawn: e.a.withdrawn, since: e.a.since, days,
    handedBack: all.length, audited: done.length, accepted: acc.length, sentBack: rev.length, sentBackRate: done.length ? r4(rev.length / done.length) : null,
    onTime: withDl.length ? { onTime: onTime.length, withDeadline: withDl.length } : null, costPerAccepted: acc.length ? { usd: r4(usd / acc.length), tokens: Math.round(tokens / acc.length), auditUsd: r4(audit / acc.length) } : null,
    escapes, disputedEscapes: disputed, escapeRate: acc.length ? r4(escapes / acc.length) : null, routineAuditOnLeadModel: !e.a.audit.routine, spotChecks: { done: spots.length, disagree }, selfCheckFails: rows(o).filter(r => r.op === 'selfcheck' && r.dept === String(e.d.id) && Number(r.at) >= since).length,
    openAudits: pendingAudits(audits(rows(o)), String(e.d.id)).length, enough: acc.length >= (Number(e.a.scorecard.minItems) || 10) };
  sc.words = scorecardWords(sc);
  return sc;
}
// the card's plain lines (checked by lib/owner-scope.js wordsProblems in the tests)
function scorecardWords(sc) {
  const L = sc.leadName || 'the lead', out = [];
  // every check on the lead's own top model keeps each job near the lead's own price: the saving cannot show until the
  // owner picks a cheaper setup for everyday checks (departments.js accountable <id> audit-model routine)
  const cheap = sc.routineAuditOnLeadModel && sc.effective !== 'off' ? 'Every check runs on ' + L + '\'s own best setup until you choose a cheaper one for everyday checks, so the saving will not show yet.' : null;
  if (!sc.accepted && !sc.sentBack) { out.push('Nothing finished has been checked by ' + L + ' yet in the last ' + sc.days + ' days.'); if (cheap) out.push(cheap); return out; }
  out.push(L + ' checked ' + sc.audited + ' finished ' + (sc.audited === 1 ? 'job' : 'jobs') + ' in the last ' + sc.days + ' days: ' + sc.accepted + ' accepted, ' + sc.sentBack + ' sent back to be fixed.');
  if (sc.onTime) out.push('On time: ' + sc.onTime.onTime + ' of the ' + sc.onTime.withDeadline + ' with a deadline.');
  if (sc.costPerAccepted && sc.costPerAccepted.usd > 0) out.push('Cost per accepted job: about $' + (sc.costPerAccepted.usd < 1 ? sc.costPerAccepted.usd.toFixed(2) : sc.costPerAccepted.usd.toFixed(1)) + ', checking included.');
  out.push(sc.escapes ? sc.escapes + ' problem' + (sc.escapes === 1 ? ' was' : 's were') + ' found later in work ' + L + ' accepted; they count against ' + L + '\'s checking.' : 'No problems found later in the work ' + L + ' accepted.');
  if (sc.disputedEscapes) out.push(L + ' says ' + sc.disputedEscapes + ' more ' + (sc.disputedEscapes === 1 ? 'problem was' : 'problems were') + ' not a miss; a second opinion decides, and until then ' + (sc.disputedEscapes === 1 ? 'it does' : 'they do') + ' not count.');
  if (cheap) out.push(cheap);
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
  renderPacket, prKeyOf, prMember, runWriter, handback, audit, pass, drop, escape, spot, dispute, ruling, countedEscapes, spotPicked, asks, fyiOnly, normPr, scanTick, gate, leadEntries, auditPrompt, template, withOwnText, auditStep, scorecard, scorecardWords, status, fallbackWords, readState };
