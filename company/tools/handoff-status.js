#!/usr/bin/env node
/* handoff-status.js — does every handoff section carry its own `**Status:**`, and what is the open set in due order?
 *
 * Why: a reply can sit in a work/handoffs/to-<name>.md inbox with a header and a full body but no Status line at all.
 * `tools/dispatch.js` counts a section open only by its Status line, so it reads "0 OPEN"; the answer is invisible to
 * the dispatcher and to a reader, and the work it asks for goes undone until someone lists every heading and notices
 * one has no status under it. A template paragraph nobody can enforce is cheaper to replace with a check.
 *
 * Why --due: a busy inbox grows to a thousand lines with dozens of OPEN sections, and a 90-minute routine can honestly
 * finish a handful. The deadline is already written in every section — `**Deadline:** 2026-11-17 12:00 — after the review` —
 * but only a human can read it, so a run has to skim the whole file to discover what is due tomorrow morning. This
 * prints the open set sorted by that line.
 *
 * Why the appendix rule: a lint that counted `## Progress …` continuation blocks as handoffs would fail on a Progress
 * block under a Status line that `dispatch.js` never reads as a handoff. A checker that goes red on a correctly
 * written file is a checker people learn to ignore.
 *
 *   node company/tools/handoff-status.js            # lint: report, exit 1 if any handoff section lacks a Status line
 *   node company/tools/handoff-status.js --all      # include work/handoffs/archive/
 *   node company/tools/handoff-status.js --quiet    # only the summary line
 *   node company/tools/handoff-status.js --due      # the OPEN set, sorted by **Deadline:** (report only, exit 0)
 *   node company/tools/handoff-status.js --due --json
 *   node company/tools/handoff-status.js --selftest # prove both behaviours on fixtures, including the failures
 *   node company/tools/handoff-status.js --duty     # read-only duty check (docs/DUTIES.md): exit 1 + JSON when an OPEN handoff
 *                                                   # is past its deadline or a section has no Status line; each item routed
 *                                                   # to the inbox owner's manager, else the CEO. Counts and ids only.
 *
 * Deadlines and the printed times are company local time (company.json timezone), never the machine's clock.
 * Deadline forms understood, in order of preference: `**Deadline:** 2026-11-17 12:00`, `**Deadline:** 2026-11-17`,
 * `**Due:** 2026-11-17 12:00`. Anything else on that line ("with the spike", "none", "today") is left undated on
 * purpose: parsing "today" would date it to the day the message was read, not the day it was written.
 *
 * Exit: 0 clean, 1 findings (lint mode), 2 usage error. `--due` always exits 0 unless --fail-on-overdue.
 * Ownership: the tools owner. Runbook: company/runbooks/tool-management.md §7b (the check and its mutants) and
 * §7c (how to read the queue in due order).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const co = require('./lib/company');
const { localToEpoch, fmtLocal } = require('./lib/core-loop');
const ROOT = co.ROOT;
const DIR = co.p('company', 'work', 'handoffs');
const ARCHIVE = path.join(DIR, 'archive');

// A continuation block under a handoff, not a handoff of its own. dispatch.js keys on the section's own Status line,
// so it never reads these as handoffs either; the lint must agree with the reader or it reports a file as broken
// that is written the way the company says to write it.
const APPENDIX = /^(Progress|Resolved|Correction|Addendum|Update|Follow-?up|Later note|Note)\b/i;

// A section is "## <heading>" up to the next "## " at the same level. The preamble before the first "## " is not a
// handoff (each inbox opens with a title and a note about archiving).
function sections(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) {
      if (cur) out.push(cur);
      cur = { heading: l.slice(3).trim(), line: i + 1, body: [] };
      continue;
    }
    if (/^# /.test(l) && !cur) continue;          // the file title
    if (cur) cur.body.push(l);
  }
  if (cur) out.push(cur);
  return out;
}

function statusOf(sec) {
  for (const l of sec.body) {
    const m = l.match(/^\*\*Status:\*\*\s*(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

const isOpen = st => !!st && /^OPEN\b/i.test(st);

// The deadline as written, as a comparable timestamp. `raw` keeps the prose so a person can see what was meant.
function deadlineOf(sec) {
  for (const l of sec.body) {
    const m = l.match(/^\*\*(Deadline|Due):\*\*\s*(.*)$/i);
    if (!m) continue;
    const raw = m[2].trim();
    const d = raw.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (!d) return { at: null, raw, key: m[1].toLowerCase() };
    const hhmm = d[2] || '23:59';
    const ms = localToEpoch(d[1], hhmm);   // company local time
    const at = Number.isFinite(ms) && fmtLocal(ms) === d[1] + ' ' + hhmm ? new Date(ms) : null;   // an impossible date never rolls over
    return { at, date: d[1], time: hhmm, raw, key: m[1].toLowerCase() };
  }
  return { at: null, raw: null };
}

// classify(text) — every section, its status, whether it is a handoff or an appendix, and its deadline.
// An appendix heading is a continuation only when the section above it carries a Status line; a `## Progress` block
// that opens a file is a handoff somebody forgot to stamp, and is reported as one.
// Two consecutive appendix blocks keep the chain: the second one inherits through the first. The first version reset
// the chain to the appendix's own (absent) status, so the second Progress block under one statused handoff was reported as an unstamped handoff, which is a lint going red on a correctly written file.
function classify(text) {
  const secs = sections(text);
  let prevStatus = null;
  return secs.map(s => {
    const st = statusOf(s);
    const appendix = APPENDIX.test(s.heading) && prevStatus !== null;
    prevStatus = appendix ? prevStatus : st;   // an appendix inherits; a handoff sets (even to null)
    return { heading: s.heading, line: s.line, status: st, appendix, open: !appendix && isOpen(st), deadline: deadlineOf(s) };
  });
}

/* UNREAD DEADLINE — an OPEN block whose **Deadline:** the dispatcher cannot read: missing, or not a plain YYYY-MM-DD (or
 * "today") as the line's first characters (company/HANDOFFS.md). The dispatcher then counts it as due now: it wakes the
 * seat for it and counts it toward STALLED, which looks exactly like an idle seat. A warning, never a failure. */
const DEADLINE_LEAD = /^\*\*Deadline:\*\*\s*(\d{4}-\d{2}-\d{2}\b|today\b)/im;
function unreadDeadlines(text) {
  const out = [];
  const secs = sections(text); const cls = classify(text);
  secs.forEach((s, i) => {
    if (!cls[i] || !cls[i].open) return;
    const body = s.body.join('\n');
    if (DEADLINE_LEAD.test(body)) return;
    const line = (s.body.find(l => /^\*\*Deadline:\*\*/i.test(l)) || '').replace(/^\*\*Deadline:\*\*\s*/i, '');
    out.push({ kind: 'UNREAD DEADLINE', line: s.line, heading: s.heading, deadline: line || null });
  });
  return out;
}

function scan(text) {
  return classify(text).filter(s => !s.appendix && s.status === null);
}

/* ---- STRUCTURE: a status line is not a body, and a second one is not an update ----
 * A batch pass that adds missing `**Status:**` lines at end-of-file instead of inside the section they belong to
 * leaves three shapes behind: a line under a block already marked DONE, so dispatch reads that section OPEN again; a
 * line that duplicates an existing OPEN; and a line that is the only trace of a block whose body never arrived — a
 * status line can then mean 'a block that lacked a status' OR 'a block whose text is missing', and the two need
 * different handling.
 * Three shapes, each a finding with a name:
 *   MISSING NEED      — an OPEN, non-appendix section with no `**Need:**` (or `**Ask:**`) line: nothing to act on.
 *                       A DONE block without one is ordinary — most closes are an FYI plus a Resolved line — so only an
 *                       OPEN block is a finding; that is the shape where dispatch wakes someone for a body that is not there.
 *   DUPLICATE STATUS  — two status lines in one section. A finding when they DISAGREE (DONE then OPEN: the block is
 *                       re-opened by the second line); a warning when both say the same thing.
 *   STATUS IN APPENDIX — a status line inside a Progress/Resolved block: dispatch reads the parent's status, so this line
 *                       either re-opens the parent or is a handoff masquerading as a continuation. A warning: the parent
 *                       still answers for the section, and a person should look.
 * Severity is deliberate: a lint that goes red on 74 historical FYI blocks is a lint people learn to skip. Fails are the
 * two shapes that change what dispatch does; warnings are printed under their own line and do not touch the exit code.
 * Kept beside `scan()` (missing status) so one pass covers the whole shape of a malformed block. */
const NEED = /^\*\*(Need|Ask)\b/i;
// What this check is for is the BODYLESS block — a status line and nothing else — which is what a status-stamping pass
// leaves behind. It is NOT a check for the word "Need": half this company numbers its asks ("**1. Your row is
// written.**"), bullet-lists them, or writes them as prose paragraphs, and a check on the word fires on all three,
// mostly on well-formed blocks. A block has a body when, after the
// bookkeeping lines are removed, anything is left.
const BOOKKEEPING = /^\*\*(Status|Resolved|Evidence|Deadline|Due|Quest|Follow-up)\b/i;
function hasBody(sec) {
  return sec.body.some(l => {
    const t = l.trim();
    if (!t) return false;
    if (BOOKKEEPING.test(t)) return false;
    if (/^(—|--|\*\*\*)\s*$/.test(t)) return false;   // a signature line
    return true;
  });
}
const STATUS_LINE = /^\*\*Status:\*\*/i;
function structureFindings(text) {
  const out = [];
  const secs = sections(text);
  let prevStatus = null;
  for (const s of secs) {
    const st = statusOf(s);
    const appendix = APPENDIX.test(s.heading) && prevStatus !== null;
    const statuses = s.body.map((l, i) => ({ l, line: s.line + 1 + i })).filter(x => STATUS_LINE.test(x.l));
    if (appendix) {
      // A Progress note carrying its own status is a common house convention, so it is not a finding by itself. What
      // matters is CONTRADICTION: an appendix saying OPEN under a parent that says DONE re-opens the parent in a
      // reader's mind even though dispatch reads the parent. Appendix statuses that AGREE with their parent are noise.
      // The check grades the disagreement.
      const first = st ? st.split(/[\s—-]+/)[0].toUpperCase() : null;
      const parent = prevStatus ? prevStatus.split(/[\s—-]+/)[0].toUpperCase() : null;
      if (first && parent && first !== parent) out.push({ kind: 'APPENDIX CONTRADICTS', severity: 'warn', line: (statuses[0] || { line: s.line }).line, heading: s.heading, detail: 'parent ' + parent + ', appendix ' + first });
      continue;
    }
    prevStatus = st;
    if (statuses.length > 1) {
      const first = statuses[0].l.replace(STATUS_LINE, '').trim().split(/[\s—-]+/)[0].toUpperCase();
      const second = statuses[1].l.replace(STATUS_LINE, '').trim().split(/[\s—-]+/)[0].toUpperCase();
      out.push({ kind: 'DUPLICATE STATUS', severity: first === second ? 'warn' : 'fail', line: statuses[1].line, heading: s.heading,
        detail: first + ' then ' + second });
    }
    if (isOpen(st) && !hasBody(s)) out.push({ kind: 'BODYLESS BLOCK', severity: 'fail', line: s.line, heading: s.heading });
  }
  return out;
}

// FUTURE STAMP — a block stamped later than the clock (a heading stamped 14:38 written at 14:12). A stamp is meant to
// come from `date`; one written from a sense of elapsed work reads as a decision taken after the fact it describes.
// Covers the heading ("## <date> <time> ...", "## Progress|Resolved <date> <time> ...") and the bold Progress/Resolved
// line ("**Resolved <date> <time> by ...**"). Stamps are company local time (co.TZ), never the machine's zone.
const STAMP = /^(?:## (?:(?:Progress|Resolved)\s+)?|\*\*(?:Progress|Resolved)\s+)(\d{4}-\d\d-\d\d) (\d\d:\d\d)(?=[\s*:]|$)/;
function futureStamps(text, nowMs) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = STAMP.exec(lines[i]);
    if (!m) continue;
    const t = localToEpoch(m[1], m[2]);
    if (Number.isFinite(t) && t > nowMs) out.push({ kind: 'FUTURE STAMP', line: i + 1, stamp: m[1] + ' ' + m[2], minutesAhead: Math.ceil((t - nowMs) / 60000), heading: lines[i] });
  }
  return out;
}

const fmt = d => fmtLocal(d);   // company local time

// One report line. It lives in a function so the selftest can grade the line the report actually prints — the first
// version graded fmt() alone and a mutant that printed UTC slipped through green ("a selftest case that passes an
// explicit object proves the writing code and not the wiring").
function dueLine(e, now) {
  // Company local time, never toISOString(): the company writes 12:00 in its own timezone and a UTC display reads it
  // hours off, which on a deadline queue is an error in the direction that can make people late.
  const when = e.deadline.at ? (fmt(e.deadline.at) + '  ' + rel(e.deadline.at, now)).padEnd(26) : 'undated'.padEnd(26);
  const flag = e.deadline.at && e.deadline.at < now ? 'OVERDUE ' : (e.deadline.at && e.deadline.at - now <= 24 * 3600 * 1000 ? 'TODAY   ' : '        ');
  return flag + when + ' ' + (e.file + ':' + e.line).padEnd(34) + ' ' + e.heading.slice(0, 96);
}

function rel(at, now) {
  const ms = at - now, h = Math.round(Math.abs(ms) / 3600000);
  const s = h < 48 ? h + 'h' : Math.round(h / 24) + 'd';   // hours up to two days: a due queue is read in hours
  return ms < 0 ? s + ' ago' : 'in ' + s;
}

function dueSet(entries, now) {
  return entries.filter(e => e.open).sort((a, b) => {
    const A = a.deadline.at, B = b.deadline.at;
    if (A && B) return A - B || a.file.localeCompare(b.file) || a.line - b.line;
    if (A) return -1;
    if (B) return 1;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
}

function entriesFrom(files) {
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const c of classify(text)) out.push(Object.assign({ file: path.relative(ROOT, f) }, c));
  }
  return out;
}

/* ---- duty (docs/DUTIES.md): what is overdue or unstamped, as counts and ids, routed to the inbox owner's manager ----
 * entries: entriesFrom(...) rows; crew: loops.json agents; ceo: the CEO seat id. Returns null (nothing due) or the
 * {due, reason, key, items} object. An item id is <inbox>#<6 hex of the heading>, never the heading itself. */
function dutyResult(entries, crew, ceo, now) {
  const seatOf = {}; for (const [id, c] of Object.entries(crew || {})) if (c && c.inbox) seatOf[c.inbox] = id;
  const routeOf = inbox => { const seat = seatOf[inbox]; const mgr = seat && crew[seat] && crew[seat].manager; return (mgr && crew[mgr] ? mgr : ceo) || 'ceo'; };
  const h6 = t => require('crypto').createHash('sha256').update(String(t)).digest('hex').slice(0, 6);
  const items = []; const per = {};
  for (const e of entries) {
    const inbox = path.basename(e.file);
    const overdue = e.open && e.deadline && e.deadline.at && e.deadline.at < now;
    const missing = !e.appendix && e.status === null;
    if (!overdue && !missing) continue;
    items.push({ id: inbox + '#' + h6(e.heading), route: routeOf(inbox) });
    const p = per[inbox] = per[inbox] || { overdue: 0, missing: 0 };
    if (overdue) p.overdue++; else p.missing++;
  }
  if (!items.length) return null;
  const over = Object.values(per).reduce((n, p) => n + p.overdue, 0), miss = Object.values(per).reduce((n, p) => n + p.missing, 0);
  const files = Object.entries(per).map(([f, p]) => f + ' (' + [p.overdue ? p.overdue + ' overdue' : '', p.missing ? p.missing + ' no status' : ''].filter(Boolean).join(', ') + ')');
  const reason = (over + ' OPEN handoff(s) past deadline, ' + miss + ' section(s) without a Status line: ' + files.join('; ')).slice(0, 300);
  const key = 'hs-' + h6(items.map(i => i.id).sort().join(','));
  return { due: true, reason, key, items };
}
function duty() {
  let files;
  try { files = fs.readdirSync(DIR).filter(f => /^to-.*\.md$/.test(f)).map(f => path.join(DIR, f)); } catch (e) { console.error('cannot read the handoffs folder'); return 2; }
  const r = dutyResult(entriesFrom(files), co.crew(), co.ceo(), new Date());
  if (!r) return 0;
  console.log(JSON.stringify(r));
  return 1;
}

/* ---- selftest: each case names the behaviour, and the last two prove the checks can go red ---- */
function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });
  const HEAD = '# Inbox\n\n_note_\n\n';

  const stamped = HEAD + '## 2026-11-15 10:00 from B — a normal handoff\n**Need:** x\n**Status:** OPEN\n**Deadline:** 2026-11-16 12:00 — after q:12\n\n'
    + '## Progress 2026-11-15 11:00 by B — the appendix under it\nnothing here\n';
  let c = classify(stamped);
  ok('appendix after a statused block is not a handoff', c.length === 2 && c[1].appendix === true);
  ok('appendix under a statused block is not a lint finding', scan(stamped).length === 0);

  const orphan = HEAD + '## Progress 2026-11-15 11:00 by B — no block above it\nx\n';
  ok('a Progress block that opens the file is a handoff with no Status (a finding)', scan(orphan).length === 1);

  // two Progress blocks under ONE statused handoff, the second reported as
  // an unstamped handoff because the first had reset the chain.
  const chain = HEAD + '## 2026-11-15 10:00 from B — a normal handoff\n**Need:** x\n**Status:** OPEN\n'
    + '## Progress 2026-11-15 11:00 by B — first continuation\nx\n'
    + '## Progress 2026-11-15 12:00 by B — second continuation under the same handoff\ny\n';
  ok('a second Progress block under one statused handoff is still an appendix', scan(chain).length === 0,
    'scan found ' + scan(chain).length);
  ok('and an unstamped handoff after the appendix chain is still a finding',
    scan(chain + '## 2026-11-15 13:00 from B — forgot the status\n**Need:** y\n').length === 1);

  const plain = HEAD + '## 2026-11-15 10:00 from B — forgot the status line\n**Need:** x\n';
  ok('a handoff with no Status line is a finding', scan(plain).length === 1);

  const dated = HEAD
    + '## late\n**Status:** OPEN\n**Deadline:** 2026-11-18 12:00\n\n'
    + '## soon\n**Status:** OPEN\n**Deadline:** 2026-11-16 09:00 — morning\n\n'
    + '## done\n**Status:** DONE — done\n**Deadline:** 2026-11-15 09:00\n\n'
    + '## undated\n**Status:** OPEN\n**Deadline:** with the spike\n\n'
    + '## due-key\n**Status:** OPEN\n**Due:** 2026-11-17\n';
  const now = new Date(localToEpoch('2026-11-15', '23:00'));
  const set = dueSet(classify(dated).map(e => Object.assign({ file: 'f.md', line: 0 }, e)), now);
  ok('open set is sorted by deadline, soonest first', set.map(e => e.heading).join(',') === 'soon,due-key,late,undated', set.map(e => e.heading).join(','));
  ok('a DONE section is not in the open set', !set.some(e => e.heading === 'done'));
  ok('prose deadline ("with the spike") is undated, not guessed', set[3].deadline.at === null && set[3].deadline.raw === 'with the spike');
  ok('`**Due:**` is accepted as a deadline key', !!set[1].deadline.at && set[1].deadline.key === 'due');
  ok('an undated OPEN section is listed, not dropped', set.length === 4);

  const late = classify('## x\n**Status:** OPEN\n**Deadline:** 2026-11-14 12:00\n')[0];
  ok('a past deadline reads as overdue', late.deadline.at < now && rel(late.deadline.at, now) === '35h ago', rel(late.deadline.at, now));

  const monthBad = classify('## x\n**Status:** OPEN\n**Deadline:** 2026-13-45\n')[0];
  ok('an impossible date is undated, not a Date that silently rolls over', monthBad.deadline.at === null);

  // The display bug this case exists for: a 12:00 local deadline printed through toISOString() reads as UTC. In a
  // company whose timezone is UTC the two agree, so the UTC check below only bites elsewhere (run with CAPHEOS_TZ set).
  const noon = classify('## x\n**Status:** OPEN\n**Deadline:** 2026-11-16 12:00\n')[0];
  const utcHm = noon.deadline.at ? noon.deadline.at.toISOString().slice(11, 16) : '';
  ok('a 12:00 deadline prints as 12:00 company local, not UTC', fmt(noon.deadline.at) === '2026-11-16 12:00', fmt(noon.deadline.at));
  const line = dueLine(Object.assign({ file: 'f.md', line: 7 }, noon), new Date(localToEpoch('2026-11-15', '23:00')));
  ok('the printed report line carries 12:00 local (the wiring, not just fmt)', line.includes('2026-11-16 12:00') && (utcHm === '12:00' || !line.includes(utcHm)), line.trim());
  ok('the printed report line flags a deadline inside 24h as TODAY', /^TODAY/.test(line), line.slice(0, 6));

  const res = classify('## x\n**Status:** Resolved — done\n**Deadline:** 2026-11-14\n')[0];
  ok('only OPEN counts as open (Resolved is not)', res.open === false);

  // STRUCTURE: the shapes a status-fixing pass creates.
  const goodBlock = HEAD + '## 2026-11-15 10:00 from B — a normal handoff\n**Need:** x\n**Status:** OPEN\n\n'
    + '## Progress 2026-11-15 11:00 by B — continuation\nx\n';
  ok('a well-formed block and its appendix produce no structure finding', structureFindings(goodBlock).length === 0,
    JSON.stringify(structureFindings(goodBlock)));
  const noNeed = HEAD + '## 2026-11-15 10:00 from B — stamped but empty\n**Status:** OPEN\n**Evidence:** x\n';
  ok('an OPEN section with only a status line is BODYLESS (the block whose text never arrived)', structureFindings(noNeed).length === 1
    && structureFindings(noNeed)[0].kind === 'BODYLESS BLOCK' && structureFindings(noNeed)[0].severity === 'fail',
    JSON.stringify(structureFindings(noNeed)));
  const doneNoNeed = HEAD + '## 2026-11-15 10:00 from B — an FYI, closed\n**Status:** DONE\n**Resolved:** nothing owed\n';
  ok('a DONE block with no **Need:** is not a finding (most closes are an FYI plus a Resolved line)',
    structureFindings(doneNoNeed).length === 0, JSON.stringify(structureFindings(doneNoNeed)));
  const numberedAsk = HEAD + '## 2026-11-15 10:00 from B — a numbered ask, no **Need:** label\n**Status:** OPEN\n'
    + '**1. Build the thing.** here is what it is\n**2. Answer the other thing.**\n';
  ok('an OPEN block whose asks are numbered is not a finding (the check grades the body, not the label)',
    structureFindings(numberedAsk).length === 0, JSON.stringify(structureFindings(numberedAsk)));
  const proseAsk = HEAD + '## 2026-11-15 10:00 from B — asks written as prose, R1–R5\n**Status:** OPEN\n'
    + 'Protocol accepted as you wrote it. Requests R1–R5, one per case, in the order I would run them.\n';
  ok('an OPEN block whose asks are prose is not a finding', structureFindings(proseAsk).length === 0,
    JSON.stringify(structureFindings(proseAsk)));
  const dup = HEAD + '## 2026-11-15 10:00 from B — done, then re-stamped\n**Need:** x\n**Status:** DONE — resolved\n**Evidence:** y\n'
    + '**Status:** OPEN — written by the CEO in a later session (status line appended)\n';
  ok('DONE then OPEN in one section is DUPLICATE STATUS and it FAILS (the re-open shape)', structureFindings(dup).length === 1
    && structureFindings(dup)[0].kind === 'DUPLICATE STATUS' && structureFindings(dup)[0].severity === 'fail',
    JSON.stringify(structureFindings(dup)));
  const dupSame = HEAD + '## 2026-11-15 10:00 from B — stamped twice the same way\n**Need:** x\n**Status:** OPEN\n**Status:** OPEN\n';
  ok('two status lines that agree are a warning, not a failure', structureFindings(dupSame).length === 1
    && structureFindings(dupSame)[0].severity === 'warn', JSON.stringify(structureFindings(dupSame)));
  const inAppendix = HEAD + '## 2026-11-15 10:00 from B — a handoff\n**Need:** x\n**Status:** DONE — resolved\n\n'
    + '## Resolved 2026-11-15 12:00 by B — closed\n**Status:** OPEN — written by the CEO in a later session\n';
  ok('an appendix status that CONTRADICTS its parent is APPENDIX CONTRADICTS (a re-open in a reader, not in dispatch)',
    structureFindings(inAppendix).length === 1 && structureFindings(inAppendix)[0].kind === 'APPENDIX CONTRADICTS'
    && structureFindings(inAppendix)[0].severity === 'warn',
    JSON.stringify(structureFindings(inAppendix)));
  ok('the appendix finding names the line it is on, not the heading', structureFindings(inAppendix)[0].line === 10,
    'line ' + (structureFindings(inAppendix)[0] && structureFindings(inAppendix)[0].line));
  const appendixAgrees = HEAD + '## 2026-11-15 10:00 from B — a handoff\n**Need:** x\n**Status:** DONE — resolved\n\n'
    + '## Progress 2026-11-15 12:00 by B — the house convention: a progress note that closes its own item\n**Status:** DONE — item 1 built\n';
  ok('a Progress note whose status AGREES with its parent is not a finding', structureFindings(appendixAgrees).length === 0,
    JSON.stringify(structureFindings(appendixAgrees)));

  // FUTURE STAMP: red on a stamp ahead of the clock, green on past, equal and prose forms; read in company time
  const NOW = localToEpoch('2026-11-17', '14:20');
  const fut = HEAD + '## 2026-11-17 14:38 from B — stamped from a sense of elapsed time\n**Need:** x\n**Status:** OPEN\n';
  const fs1 = futureStamps(fut, NOW);
  ok('a heading stamped 18 minutes ahead is a FUTURE STAMP naming its line and the gap',
    fs1.length === 1 && fs1[0].minutesAhead === 18 && fs1[0].line === 5, JSON.stringify(fs1));
  ok('a stamp equal to now or in the past is not a finding',
    futureStamps(HEAD + '## 2026-11-17 14:20 from B — now\n## 2026-11-17 09:00 from B — earlier\n', NOW).length === 0);
  const boldLine = HEAD + '## 2026-11-17 10:00 from B — a handoff\n**Status:** DONE\n**Resolved 2026-11-17 14:31 by B:** done\n'
    + '## Progress 2026-11-17 14:45 by B — note\n';
  ok('the bold Resolved line and a Progress heading are checked too', futureStamps(boldLine, NOW).length === 2, JSON.stringify(futureStamps(boldLine, NOW)));
  ok('prose that merely contains a later date is not a stamp',
    futureStamps(HEAD + 'The release is on 2026-12-01 09:00 per the calendar\n**Deadline:** 2026-12-01 09:00\n', NOW).length === 0);
  ok('the stamp is read in the company timezone (an hour ahead in co.TZ is 60 minutes ahead)',
    (futureStamps('## 2026-11-17 15:20 from B\n', NOW)[0] || {}).minutesAhead === 60);

  // UNREAD DEADLINE: what the dispatcher cannot read is reported, what it can is not
  const dl = d => HEAD + '## 2026-11-17 10:00 from B — ask\n**Need:** x\n' + (d === null ? '' : '**Deadline:** ' + d + '\n') + '**Status:** OPEN\n';
  ok('a leading date or "today" is read (no finding)', unreadDeadlines(dl('2026-11-20')).length === 0 && unreadDeadlines(dl('today')).length === 0 && unreadDeadlines(dl('2026-11-20 (the depth verdict)')).length === 0);
  ok('a date inside a sentence, "none" or a missing line is an UNREAD DEADLINE naming what was written',
    unreadDeadlines(dl('the depth verdict 2026-11-19; the heartbeat 2026-11-20'))[0].deadline === 'the depth verdict 2026-11-19; the heartbeat 2026-11-20'
    && unreadDeadlines(dl('none')).length === 1 && unreadDeadlines(dl(null))[0].deadline === null);
  ok('a DONE block is not checked', unreadDeadlines(dl('next week').replace('**Status:** OPEN', '**Status:** DONE')).length === 0);

  // DUTY: counts and ids only, routed to the inbox owner's manager (the CEO for a seat with none)
  const crewT = { ceo1: { name: 'Alex', inbox: 'to-alex.md', manager: null }, sam: { name: 'Sam', inbox: 'to-sam.md', manager: 'ceo1' } };
  const ent = (file, text) => classify(text).map(c => Object.assign({ file: 'company/work/handoffs/' + file }, c));
  const nowD = new Date(localToEpoch('2026-11-15', '23:00'));
  const secret = 'SECRET-HEADING-WORDS';
  const dr = dutyResult(ent('to-sam.md', '## ' + secret + '\n**Need:** x\n**Status:** OPEN\n**Deadline:** 2026-11-14 12:00\n').concat(ent('to-alex.md', '## forgot\n**Need:** y\n')), crewT, 'ceo1', nowD);
  ok('duty: an overdue OPEN handoff and a section with no status are due', !!dr && dr.due === true && dr.items.length === 2, JSON.stringify(dr));
  ok('duty: routed to the inbox owner\'s manager, else the CEO', dr && dr.items.every(i => i.route === 'ceo1'), JSON.stringify(dr && dr.items));
  ok('duty: the reason carries counts and file names, never a heading', dr && !JSON.stringify(dr).includes(secret) && /1 OPEN handoff\(s\) past deadline, 1 section/.test(dr.reason), dr && dr.reason);
  ok('duty: nothing overdue, nothing missing -> nothing due', dutyResult(ent('to-sam.md', '## a\n**Need:** x\n**Status:** OPEN\n**Deadline:** 2026-11-20\n'), crewT, 'ceo1', nowD) === null);
  ok('duty: the key is stable for the same findings', dr && dr.key === dutyResult(ent('to-sam.md', '## ' + secret + '\n**Need:** x\n**Status:** OPEN\n**Deadline:** 2026-11-14 12:00\n').concat(ent('to-alex.md', '## forgot\n**Need:** y\n')), crewT, 'ceo1', nowD).key);

  const bad = results.filter(r => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.pass ? '' : '  [' + r.detail + ']'));
  console.log(bad.length
    ? 'SELFTEST FAILED: ' + bad.length + ' of ' + results.length + ' case(s) wrong'
    : 'SELFTEST PASSED: ' + results.length + ' cases — appendices, missing status, due order, DONE, prose deadlines, overdue, impossible dates');
  return bad.length ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: handoff-status.js [--all] [--quiet] | --due [--json] [--fail-on-overdue] | --selftest');
    process.exit(0);
  }
  if (argv.includes('--selftest')) process.exit(selftest());
  if (argv.includes('--duty')) process.exit(duty());

  const all = argv.includes('--all');
  const quiet = argv.includes('--quiet');
  const due = argv.includes('--due');
  const json = argv.includes('--json');
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => /^to-.*\.md$/.test(f)).map(f => path.join(DIR, f)); } catch (e) {
    console.error('cannot read ' + DIR + ': ' + e.message); process.exit(2);
  }
  if (all) { try { files = files.concat(fs.readdirSync(ARCHIVE).filter(f => /^to-.*\.md$/.test(f)).map(f => path.join(ARCHIVE, f))); } catch (_) {} }

  if (due) {
    const now = new Date();
    const set = dueSet(entriesFrom(files), now);
    const overdue = set.filter(e => e.deadline.at && e.deadline.at < now);
    const soon = set.filter(e => e.deadline.at && e.deadline.at >= now && e.deadline.at - now <= 24 * 3600 * 1000);
    if (json) {
      console.log(JSON.stringify(set.map(e => ({
        due: e.deadline.at ? e.deadline.at.toISOString() : null,
        raw: e.deadline.raw, file: e.file, line: e.line, heading: e.heading,
        overdue: !!(e.deadline.at && e.deadline.at < now)
      })), null, 1));
    } else {
      console.log('OPEN HANDOFFS by due — read at ' + fmtLocal(now) + ' (' + co.TZ + ')');
      for (const e of set) {
        console.log(dueLine(e, now));
      }
      console.log('DUE SUMMARY: ' + set.length + ' OPEN — ' + overdue.length + ' overdue, ' + soon.length + ' due within 24h, '
        + (set.length - overdue.length - soon.length - set.filter(e => !e.deadline.at).length) + ' dated later, '
        + set.filter(e => !e.deadline.at).length + ' undated');
    }
    process.exit(argv.includes('--fail-on-overdue') && overdue.length ? 1 : 0);
  }

  let findings = 0;
  let total = 0;
  let structural = 0;
  let warns = 0;
  let future = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    total += classify(text).filter(s => !s.appendix).length;
    for (const bad of scan(text)) {
      findings++;
      if (!quiet) console.log('MISSING STATUS  ' + path.relative(ROOT, f) + ':' + bad.line + '  "' + bad.heading.slice(0, 90) + '"');
    }
    for (const u of unreadDeadlines(text)) {
      warns++;
      if (!quiet) console.log('WARN  UNREAD DEADLINE    ' + path.relative(ROOT, f) + ':' + u.line + '  ' + (u.deadline === null ? 'no **Deadline:** line' : '"' + u.deadline.slice(0, 60) + '"') + ' — the dispatcher counts it as due now (start the line with YYYY-MM-DD or today)  "' + u.heading.slice(0, 60) + '"');
    }
    for (const st of futureStamps(text, Date.now())) {
      const rel = path.relative(ROOT, f);
      if (rel.includes(path.sep + 'archive' + path.sep)) { warns++; if (!quiet) console.log('WARN  ' + st.kind.padEnd(20) + rel + ':' + st.line + '  ' + st.stamp); continue; }
      future++;
      if (!quiet) console.log(st.kind.padEnd(20) + rel + ':' + st.line + '  ' + st.stamp + '  (' + st.minutesAhead + ' min ahead of the clock; stamp from `date`)  "' + st.heading.slice(0, 70) + '"');
    }
    for (const s of structureFindings(text)) {
      const rel = path.relative(ROOT, f);
      // An archived thread is never woken by dispatch, so its shape cannot change what dispatch does: report it, do not fail on it.
      const archived = rel.includes(path.sep + 'archive' + path.sep);
      if (s.severity === 'warn' || archived) { warns++; if (!quiet) console.log('WARN  ' + s.kind.padEnd(20) + rel + ':' + s.line + '  "' + s.heading.slice(0, 80) + '"'); continue; }
      structural++;
      if (!quiet) console.log(s.kind.padEnd(20) + rel + ':' + s.line + '  "' + s.heading.slice(0, 80) + '"' + (s.detail ? '  [' + s.detail + ']' : ''));
    }
  }
  console.log((findings ? 'HANDOFF STATUS: FAIL — ' : 'HANDOFF STATUS: PASS — ') + findings + ' of ' + total + ' sections in '
    + files.length + ' file(s) have no **Status:** line' + (findings ? ' (a section without one is invisible to dispatch.js)' : ''));
  console.log((structural ? 'HANDOFF STRUCTURE: FAIL — ' : 'HANDOFF STRUCTURE: PASS — ') + structural
    + ' structural finding(s) that change what dispatch does (an OPEN block with nothing to act on; a block re-opened by a second status line); '
    + warns + ' warning(s) (an appendix status contradicting its parent, two status lines that agree, anything inside an archive)');

  console.log((future ? 'FUTURE STAMPS: FAIL — ' : 'FUTURE STAMPS: PASS — ') + future + ' block(s) stamped later than the clock (a stamp comes from `date`, not from a sense of elapsed work)');

  // Sibling check, run in the same pass: a money figure written through a
  // shell arrives as `/bin/sh.9311` where `$0.9311` belongs, and it still reads as prose. One command
  // covers both lints so neither is a tool somebody has to remember to run.
  let corrupt = 0;
  let corruptFiles = 0;
  try {
    const r = require(path.join(__dirname, 'text-corruption.js')).scanPath(path.join(ROOT, 'company'));
    corruptFiles = r.files;
    corrupt = r.findings.length;
    if (!quiet) for (const f of r.findings) console.log('CORRUPT FIGURE  ' + f.file + ':' + f.line + '  ' + f.found + ' -> ' + f.repair);
    console.log('TEXT INTEGRITY: ' + (corrupt ? 'FAIL — ' : 'PASS — ') + corrupt + ' shell-expanded figure(s) in ' + corruptFiles + ' file(s)');
  } catch (e) {
    console.log('TEXT INTEGRITY: SKIPPED — ' + e.message + ' (the corruption check did not run; this is not a pass)');
  }
  process.exit(findings || structural || future || corrupt ? 1 : 0);
}

if (require.main === module) main();
module.exports = { sections, statusOf, classify, scan, dueSet, deadlineOf, dutyResult, futureStamps, unreadDeadlines };
