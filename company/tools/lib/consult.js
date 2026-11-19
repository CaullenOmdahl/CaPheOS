'use strict';
/* lib/consult.js — advisor leads (docs/DEPARTMENTS.md §5, the middle-management plan's P4): consult packets, the consult
 * ledger, the stuck triggers, the batched advise run and the lead's verdicts.
 *
 * A member (or the dispatcher on its behalf, or the pre-merge gate) asks its department's lead with a CONSULT: one short
 * handoff block in the lead's inbox (at most advisor.packetMaxChars characters, heading included):
 *   ## Consult: <item title> (<date>)          **Id:** cs-…  **Item:** <item id>  **From:**  **Kind:** ask|stuck|plan|premerge
 *   **Trigger:** asked|failed-runs:N|revise:N|idle-wakes:N|reopened   **Class:**  **PR:** (premerge)  **Status:** OPEN
 *   ### Question / ### What was tried / ### Acceptance check
 * The dispatcher batches open consults into ONE separate advise run of the lead (door `consult`, lib/admit.js), on the
 * department's leadModelDefault as a one-run override, and the lead answers each with consult.js answer: the verdict line
 * goes into the consult and into the member's item block, where model-rank.js reads it like any verdict.
 *
 * Mode per department (departments.json advisor, lib/departments.js advisorOf): off = nothing is computed; shadow (and a
 * paused department) = packets accepted and recorded in the ledger, stuck triggers evaluated, the advise run that would
 * start logged (WOULD ADVISE); no packet is delivered and no run starts; live = all of it.
 *
 *   const C = require('./lib/consult');
 *   C.parsePacket(sectionText)                      the fields of one Consult block (null when it is not one)
 *   C.renderPacket(p)                                the block's text
 *   C.writePacket(p, o)                              open one consult: field, size, dedupe and daily-cap checks, the ledger
 *                                                    row, the block in the lead's inbox (live only) -> {ok, id, delivered}
 *                                                    | {ok:false, dropped, why}
 *   C.ledger({root}) / C.consults(rows)              the ledger rows / id -> {id, open, advised, verdict, dropped, status}
 *   C.stuckScan({items, wakes, runs, state, now, excludeKinds, answered})   pure: the triggers to open, the next state
 *   C.batchDue({pending, lastAdvise, inFlight, batch, now})               pure: {start, why, nextAt?}
 *   C.verdictLine({verdict, by, check, findings, tier})                     the **Verdict:** line
 *   C.answer({id, verdict, check, findings, tier, by, root, now})            the lead's answer (consult.js answer)
 *   C.advisePrompt({template, lead, deptId, deptName, ids})                  the advise routine's prompt: byte-identical up
 *                                                                            to its last line, which names the open consults
 *   C.holdFn({root})                                 (inbox, item) -> null | {who}: an item the dispatcher does not wake
 *                                                    for (its consult is open; a packet is the advise run's work)
 *   await C.consultStep(ctx)                         the dispatcher's step each tick (dispatch.js): stuck consults, the
 *                                                    advise routine, the batch, busy seats, the auto-pause
 *   C.leadEntries(seatId, {root})                    the leadModelDefault pair for a live lead (lib/override-allow.js)
 *   C.premergeAdvice(o)                              premerge-check.js: the lead's advisory verdict on a PR (opens a
 *                                                    premerge consult once per PR head when none is there)
 *   C.status({root, dept, now})                      per department: mode, pause, consults today, next and last advice
 * Narrow fan-out (docs/DEPARTMENTS.md §6, the plan's P5): a lead splits one big item into pieces, either answering a
 * consult with SPLIT or on its own item (consult.js split). Both are recorded as a `split` row in the ledger; a Pieces
 * block someone wrote into a handoff by hand is never delegated.
 *   C.parsePieces(block)                             the **Pieces:** list and **Fan-out:** of one block (pure)
 *   C.splitOk(block, {minPieces, maxPieces})         pure: {ok, pieces, fanout, why}: ok only with minPieces to maxPieces
 *                                                    pieces, each naming files: and check:, no file in two pieces
 *   C.renderPieces(pieces, fanout)                   the block's Pieces and Fan-out lines
 *   C.split({item, pieces, fanout, check, by, root, now})   the lead's own split of an item it owns (consult.js split)
 *   C.splitCandidates({root, crew, now})             the recorded, still valid splits of live departments, for
 *                                                    lib/delegate-allow.js (Fan-out dispatch) and lanes.js (lanes)
 * Files: company/state/consults.jsonl (class A, appended only here, each row recorded with provenance appended),
 * company/state/consult-state.json (rewritten whole here: stuck counters, the last advise per department, the advise
 * routines). Every number is config (departments.json advisorDefaults / consult). Owner: the tools function.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./company');
const D = require('./departments');
const W = require('./wakes');

const WRITER = 'lib/consult.js';
const KINDS = ['ask', 'stuck', 'plan', 'premerge'];
// SPLIT (P5): the lead splits the item into pieces for its team; like ESCALATE it neither passes nor fails in the ranking
const VERDICTS = ['APPROVE', 'REVISE', 'ESCALATE-TIER', 'TAKE-OVER', 'ESCALATE', 'SPLIT'];
const FANOUTS = ['lanes', 'dispatch'];
const DROP_WHY = ['daily cap', 'duplicate', 'too long', 'mode off'];
const MIN = 60e3, DAY = 86400e3;
const CONSULT_LINE = 'Open consults for you:';

const rootOf = o => path.resolve((o && o.root) || co.ROOT);
function paths(o) {
  const r = rootOf(o), J = (...a) => path.join(r, ...a);
  return { root: r, ledger: J('company', 'state', 'consults.jsonl'), state: J('company', 'state', 'consult-state.json'), handoffs: J('company', 'work', 'handoffs'),
    loops: J('company', 'tools', 'loops.json'), runs: J('.starnet-data', 'workspaces', 'runs.jsonl'), wakes: J('company', 'state', 'wakes.jsonl'),
    evaluation: J('company', 'work', 'models', 'routing-evaluation.json'),
    template: J('company', 'work', 'departments', 'advise-prompt.md'), templateDefault: J('company', 'defaults', 'work', 'departments', 'advise-prompt.md') };
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const one = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 300);
const nowOf = o => (o && Number.isFinite(o.now) ? o.now : Date.now());
const dayOf = ms => co.localParts(new Date(ms)).date;
const crewOf = o => (o && o.crew) || ((readJson(paths(o).loops, {}) || {}).agents || {});
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
const prov = () => { try { return require('../provenance.js'); } catch (_) { return null; } };
const sections = text => String(text || '').split(/^(?=## )/m);
const field = (sec, name) => { const m = String(sec).match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };
const newId = now => 'cs-' + Number(now).toString(36) + '-' + crypto.randomBytes(2).toString('hex');

/* ---------------- packets ---------------- */
function renderPacket(p) {
  const title = one(p.title, 80) || one(p.item, 80);
  const L = ['## Consult: ' + title + ' (' + (p.date || dayOf(p.now || Date.now())) + ')',
    '**Id:** ' + p.id, '**Item:** ' + one(p.item, 200), '**From:** ' + one(p.from, 120), '**Kind:** ' + p.kind, '**Trigger:** ' + (p.trigger || 'asked'),
    '**Class:** ' + (p.class || 'general')];
  if (p.pr) L.push('**PR:** ' + one(p.pr, 200));
  L.push('**Status:** OPEN', '', '### Question', String(p.question || '').trim(), '### What was tried', String(p.tried || '').trim() || '- (nothing yet)',
    '### Acceptance check', String(p.check || '').trim() || '- (none named)');
  return '\n' + L.join('\n') + '\n';
}
function parsePacket(sec) {
  const s = String(sec || '');
  const head = s.split('\n')[0];
  const m = /^## Consult:\s*(.*?)(?:\s*\((\d{4}-\d{2}-\d{2})\))?\s*$/.exec(head);
  if (!m) return null;
  const part = name => { const r = new RegExp('^### ' + name + '\\s*\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))', 'm').exec(s); return r ? r[1].trim() : ''; };
  return { title: m[1], date: m[2] || null, id: (field(s, 'Id') || '').replace(/`/g, ''), item: field(s, 'Item'), from: field(s, 'From'), kind: field(s, 'Kind'),
    trigger: field(s, 'Trigger'), class: field(s, 'Class'), pr: field(s, 'PR'), status: field(s, 'Status'), question: part('Question'), tried: part('What was tried'), check: part('Acceptance check') };
}
const isPacketHeading = h => /^Consult:/.test(String(h || ''));

/* ---------------- the ledger ---------------- */
function ledger(o) {
  let txt = ''; try { txt = require('./bounded').tailText(paths(o).ledger, 8 * 1024 * 1024); } catch (_) { return []; }
  const out = []; for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.op) out.push(r); } catch (_) {} }
  return out;
}
function append(row, o) {
  if (o && o.dry) return row;
  const f = paths(o).ledger; const line = JSON.stringify(row) + '\n';
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, line);
  const p = prov(); if (p) try { p.appended(f, line, WRITER); } catch (_) {}
  return row;
}
function consults(rows) {
  const m = new Map();
  const get = id => { if (!m.has(id)) m.set(id, { id, open: null, advised: [], verdict: null, dropped: null, status: 'open' }); return m.get(id); };
  for (const r of rows || []) {
    if (r.op === 'open' && r.id) get(r.id).open = r;
    else if (r.op === 'dropped' && r.id) { const c = get(r.id); c.dropped = r; if (!c.open) c.open = r; }
    else if (r.op === 'verdict' && r.id) get(r.id).verdict = r;
    else if (r.op === 'advise') for (const id of r.ids || []) get(id).advised.push(r);
  }
  for (const c of m.values()) c.status = c.verdict ? 'done' : c.dropped ? 'dropped' : c.open ? 'open' : 'unknown';
  for (const [id, c] of m) if (!c.open) m.delete(id);
  return m;
}

/* ---------------- departments ---------------- */
function deptState(o) {
  const L = D.load({ root: rootOf(o) }); const st = D.settings(L.doc, { root: rootOf(o) });
  return { L, st, list: D.list(L.doc).map(d => ({ d, a: D.advisorOf(d, st), c: D.consultOf(d, st) })) };
}
const leadOk = (d, ceo) => !!(d && d.lead && String(d.lead) !== String(ceo || ''));
function inboxPath(o, inbox) { return path.join(paths(o).handoffs, inbox); }
function appendBlock(o, inbox, text) { if (o.dry) return; const f = inboxPath(o, inbox); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, text); if (/^## \S+ from Dispatcher\b/m.test(text)) require('./tool-blocks').record(f, text, { root: rootOf(o) }); }
function managerNote(o, crew, seat, heading, fields) {
  const ceo = o.ceo || co.ceo();
  const mgr = (crew[seat] && crew[seat].manager) || ceo; const ib = mgr && crew[mgr] && crew[mgr].inbox;
  if (!ib) return null;
  const day = dayOf(nowOf(o));
  appendBlock(o, ib, '\n## ' + day + ' from Dispatcher — ' + heading + '\n' + Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + v).join('\n') + '\n');
  return mgr;
}

/* writePacket(p, o): open one consult.
 * p: { dept, item, file?, title, from (words), fromSeat, kind, trigger?, class?, pr?, head?, question, tried?, check? }
 * o: { root, now, dry, clip (the dispatcher's own packet: What was tried is clipped to fit), crew, ceo }
 * -> { ok: true, id, delivered, chars } | { ok: false, dropped: why, id?, refused: bool, error } */
function writePacket(p, o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o);
  const ds = deptState(o), x = ds.list.find(e => String(e.d.id) === String(p.dept));
  const fail = (why, error, refused) => ({ ok: false, dropped: why, error, refused: !!refused });
  if (!x) return fail(null, 'no department "' + p.dept + '"', true);
  if (!KINDS.includes(String(p.kind))) return fail(null, '--kind must be one of ' + KINDS.join(', '), true);
  if (!one(p.question)) return fail(null, 'a consult needs a question', true);
  if ((p.kind === 'plan' || p.kind === 'premerge') && !one(p.check)) return fail(null, 'a ' + p.kind + ' consult needs the acceptance check (--check)', true);
  if (!leadOk(x.d, o.ceo || co.ceo())) return fail(null, 'the ' + (x.d.name || x.d.id) + ' department has no lead to ask (the CEO is never a lead)', true);
  if (String(p.fromSeat || '') === String(x.d.lead)) return fail(null, 'a lead does not consult itself', true);
  const base = { at: now, ts: new Date(now).toISOString(), dept: String(x.d.id), lead: String(x.d.lead), item: one(p.item, 200), file: p.file ? one(p.file, 120) : null, title: one(p.title, 160),
    from: one(p.from, 120), fromSeat: p.fromSeat ? one(p.fromSeat, 80) : null, kind: p.kind, trigger: p.trigger || 'asked', class: p.class || x.d.defaultClass || 'general' };
  if (p.pr) base.pr = one(p.pr, 200);
  if (p.head) base.head = one(p.head, 60);
  const drop = (why, extra) => { const id = newId(now); append(Object.assign({ op: 'dropped', id, why }, base, extra || {}), o); return id; };
  if (x.a.mode === 'off') { const id = drop('mode off'); return Object.assign(fail('mode off', 'the lead of ' + (x.d.name || x.d.id) + ' does not give advice (advisor mode off)', true), { id }); }
  const all = consults(ledger(o));
  const dup = [...all.values()].find(c => c.status === 'open' && c.open.dept === base.dept && c.open.item === base.item && c.open.kind === base.kind);
  if (dup) { const id = drop('duplicate', { duplicateOf: dup.id }); return Object.assign(fail('duplicate', 'a ' + base.kind + ' consult on this item is already open (' + dup.id + ')'), { id, duplicateOf: dup.id }); }
  const today = dayOf(now);
  const opened = [...all.values()].filter(c => c.open.op === 'open' && c.open.dept === base.dept && dayOf(Number(c.open.at) || 0) === today).length;
  if (x.c.maxPerDay > 0 && opened >= x.c.maxPerDay) {
    const id = drop('daily cap');
    const seat = base.fromSeat || null;
    if (seat && crew[seat]) managerNote(o, crew, seat, 'FYI: ' + ((crew[seat] || {}).name || seat) + '\'s question to the lead was not sent today', { Need: 'nothing unless it matters today: the ' + (x.d.name || x.d.id) + ' department reached its ' + x.c.maxPerDay + ' consults for the day, so "' + one(base.title, 90) + '" (' + base.kind + ', ' + base.trigger + ') was recorded and not sent. Help with it yourself, or raise the limit (departments.json consult.maxPerDay).', Why: 'a consult past the daily limit is dropped, never lost silently.', Deadline: 'none', Status: 'DONE — FYI', Evidence: 'company/state/consults.jsonl ' + id });
    return Object.assign(fail('daily cap', 'the ' + (x.d.name || x.d.id) + ' department has used its ' + x.c.maxPerDay + ' consults for today'), { id });
  }
  const max = Math.max(500, Number(x.a.packetMaxChars) || 4000);
  const id = newId(now);
  const pk = Object.assign({}, p, { id, now, date: today, class: base.class, trigger: base.trigger, from: p.from });
  let text = renderPacket(pk);
  if (text.length > max) {
    if (!o.clip) { drop('too long', { chars: text.length }); return Object.assign(fail('too long', 'the consult is ' + text.length + ' characters; the limit is ' + max + ' (shorten the question and what was tried)', true), { chars: text.length }); }
    const over = text.length - max + 20;
    pk.tried = String(pk.tried || '').slice(0, Math.max(0, String(pk.tried || '').length - over)).trimEnd() + '\n- … (clipped)';
    text = renderPacket(pk);
    if (text.length > max) { pk.question = String(pk.question).slice(0, Math.max(40, String(pk.question).length - (text.length - max) - 4)) + ' …'; text = renderPacket(pk); }
  }
  const live = x.a.effective === 'live';
  if (live) { const ib = crew[x.d.lead] && crew[x.d.lead].inbox; if (!ib) return fail(null, 'the lead ' + x.d.lead + ' has no inbox (loops.json)', true); appendBlock(o, ib, text); }
  append(Object.assign({ op: 'open', id }, base, { chars: text.length }, live ? {} : { shadow: true }, p.wakeId ? { wakeId: p.wakeId } : {}), o);
  return { ok: true, id, delivered: live, chars: text.length, text };
}

/* ---------------- stuck triggers (pure) ----------------
 * items: [{ id, file, seat, dept, title, sig, revise (fail verdicts on it), reopens (**Reopened** lines) }]
 * wakes: wakes.jsonl rows; runs: runs.jsonl rows; state: consult-state.json items; settings: dept id -> consultOf numbers
 * answered: item ids the lead answered since the last scan (their counters reset); excludeKinds: run kinds that are never
 * a failure (the ranking's exclude.runKinds: provider errors, dispatch slice cuts)
 * A counter is reset by progress (the block's text changed, verdict and consult lines aside) or by the lead's answer.
 * One trigger opens one consult: a counter that has opened one stays quiet until it resets and crosses again. */
function runKindOf(r) {
  if (r.outcome === 'refused' || r.failureCode === 'content_policy_blocked' || r.reason === 'refusal') return 'refused';
  if (r.reason === 'done') return 'finished';
  if (r.reason === 'error' || r.reason === 'empty') return 'providerError';
  if ((r.reason === 'cancelled' || r.reason === 'interrupted') && (r.dispatchDelivery && r.dispatchDelivery.reason === 'timeout')) return 'sliceCut';
  if (/quota|rate_limit|usage|overloaded|provider|auth/.test(String(r.failureCode || ''))) return 'providerError';
  return r.reason ? 'failed' : 'other';
}
function stuckScan(o) {
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const prev = (o.state && o.state.items) || {}, next = {}, triggers = [];
  const settings = o.settings || {};
  const exclude = new Set(o.excludeKinds || ['providerError', 'sliceCut']);
  const answered = new Set(o.answered || []);
  const runById = new Map(); for (const r of o.runs || []) if (r && r.runId && (r.agentId || r.parentRunId) && r.kind !== 'dispatch-delivery') runById.set(String(r.runId), r);
  const wakesOf = new Map();
  for (const w of o.wakes || []) { if (!w || w.door === 'consult') continue; for (const i of w.items || []) { if (!wakesOf.has(i.id)) wakesOf.set(i.id, []); wakesOf.get(i.id).push(w); } }
  for (const it of o.items || []) {
    const c = settings[it.dept] || {};
    const fresh = () => ({ seat: it.seat, dept: it.dept, sig: it.sig, failedRuns: 0, revise: 0, idleWakes: 0, reopened: 0, reviseBase: it.revise || 0, reopenBase: it.reopens || 0,
      counted: [], fired: {}, lastConsultId: null, lastTrigger: null, countersSince: now });
    let s = prev[it.id] ? JSON.parse(JSON.stringify(prev[it.id])) : null;
    if (!s) { next[it.id] = fresh(); continue; }   // first sight: a baseline, nothing before it counts
    s.seat = it.seat; s.dept = it.dept;
    const crossed = [];
    // a reopen is seen before the progress reset: reopening a block also changes its text
    if (c.stuckOnReopen !== false && (it.reopens || 0) > (s.reopenBase || 0) && !s.fired.reopened) crossed.push(['reopened', 'reopened']);
    if (s.sig !== it.sig || answered.has(it.id)) {
      const keep = { lastConsultId: s.lastConsultId, lastTrigger: s.lastTrigger };
      s = Object.assign(fresh(), keep);
      if (crossed.length) { s.fired.reopened = true; s.reopenBase = it.reopens || 0; }
    } else {
      for (const w of (wakesOf.get(it.id) || []).filter(w => w.seat === it.seat && w.runId && (Number(w.at) || 0) >= s.countersSince)) {
        const rid = String(w.runId); if (s.counted.includes(rid)) continue;
        const r = runById.get(rid); if (!r || !(Number(r.endedAt) > 0)) continue;   // still running: not counted yet
        s.counted.push(rid);
        const k = runKindOf(r);
        if (exclude.has(k) || k === 'refused') continue;
        if (k === 'finished') s.idleWakes++; else s.failedRuns++;
      }
      if (s.counted.length > 50) s.counted = s.counted.slice(-50);
      s.revise = Math.max(0, (it.revise || 0) - (s.reviseBase || 0));
      s.reopened = Math.max(0, (it.reopens || 0) - (s.reopenBase || 0));
      const T = (k, v, name) => { const n = Number(c[k]) || 0; if (n > 0 && v >= n && !s.fired[name]) crossed.push([name, name + ':' + n]); };
      T('stuckAfterFailedRuns', s.failedRuns, 'failed-runs');
      T('stuckAfterRevise', s.revise, 'revise');
      T('stuckAfterIdleWakes', s.idleWakes, 'idle-wakes');
    }
    if (crossed.length) {
      for (const [name] of crossed) s.fired[name] = true;
      const trig = crossed[0][1];
      s.lastTrigger = trig;
      const tried = s.counted.slice(-4).map(id => runById.get(id)).filter(Boolean).map(r => '- run ' + String(r.runId).slice(0, 12) + ': ' + (r.reason || '?') + (r.failureCode ? ' (' + one(r.failureCode, 40) + ')' : '') + (r.endedAt ? ', ended ' + new Date(Number(r.endedAt)).toISOString().slice(0, 16).replace('T', ' ') : ''));
      triggers.push({ item: it.id, file: it.file, title: it.title, seat: it.seat, dept: it.dept, trigger: trig, tried: tried.join('\n') });
    }
    next[it.id] = s;
  }
  return { triggers, state: Object.assign({}, o.state || {}, { items: next }) };
}

/* ---------------- the batch (pure) ---------------- */
function batchDue(o) {
  const now = Number.isFinite(o.now) ? o.now : Date.now(), b = o.batch || {};
  const pending = (o.pending || []).filter(Boolean);
  const gapMs = Math.max(0, Number(b.minGapMin) || 0) * MIN, waitMs = Math.max(0, Number(b.maxWaitMin) || 0) * MIN, startAt = Math.max(1, Number(b.startAt) || 1);
  if (!pending.length) return { start: false, why: 'no open consult waits for advice' };
  if (o.inFlight) return { start: false, why: o.inFlight === true ? 'the lead is busy (a run is in flight)' : String(o.inFlight) };
  const last = Number(o.lastAdvise) || 0;
  if (last && now - last < gapMs) return { start: false, why: 'the last advise run started ' + Math.round((now - last) / MIN) + ' min ago (at least ' + b.minGapMin + ' min between two)', nextAt: last + gapMs };
  const oldest = Math.min(...pending.map(p => Number(p.at) || now));
  if (pending.length >= startAt) return { start: true, why: pending.length + ' open consult(s) (start at ' + startAt + ')' };
  if (now - oldest >= waitMs) return { start: true, why: 'the oldest consult has waited ' + Math.round((now - oldest) / MIN) + ' min (at most ' + b.maxWaitMin + ')' };
  return { start: false, why: pending.length + ' open consult(s), fewer than ' + startAt + '; the oldest waits until ' + new Date(oldest + waitMs).toISOString(), nextAt: Math.max(oldest + waitMs, last + gapMs) };
}

/* ---------------- verdicts ---------------- */
function parseTier(t) { const m = /^([a-z0-9_.-]+)\/([A-Za-z0-9_.:\[\]-]+)(?:@([a-z]+))?$/.exec(String(t || '').trim()); return m ? { provider: m[1], model: m[2], effort: m[3] || null } : null; }
function verdictLine(v) {
  const f = (v.findings || []).map(x => one(x)).filter(Boolean);
  return '**Verdict:** ' + v.verdict + ' by ' + one(v.by, 80) + ' — check: ' + one(v.check, 300) + (f.length ? ' — ' + f.map((x, i) => (i + 1) + '. ' + x).join(' ') : '') +
    (v.tier ? ' — tier: ' + v.tier.provider + '/' + v.tier.model + (v.tier.effort ? '@' + v.tier.effort : '') : '');
}
/* answer(o) -> { ok, id, verdict, line, wrote: [files] } | { ok:false, code, error } */
function answer(o) {
  const now = nowOf(o), crew = crewOf(o);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const c = consults(ledger(o)).get(String(o.id || ''));
  if (!c) return bad('no consult ' + o.id + ' (consult.js list --open)');
  if (c.status !== 'open') return bad(c.id + ' is ' + c.status + ' already');
  const ds = deptState(o), x = ds.list.find(e => String(e.d.id) === c.open.dept);
  if (!x || !x.d.lead) return bad('the department ' + c.open.dept + ' has no lead now');
  if (String(o.by) !== String(x.d.lead)) return bad('only the lead of ' + (x.d.name || x.d.id) + ' (' + ((crew[x.d.lead] || {}).name || x.d.lead) + ') answers its consults');
  const verdict = String(o.verdict || '').toUpperCase().replace(/\s+/g, '-');
  if (!VERDICTS.includes(verdict)) return bad('--verdict must be one of ' + VERDICTS.join(', '));
  if (!one(o.check)) return bad('--check "<the acceptance check you ran or read>" is required');
  let tier = null;
  if (verdict === 'ESCALATE-TIER') { tier = parseTier(o.tier); if (!tier) return bad('ESCALATE-TIER needs --tier <provider>/<model>@<effort>'); }
  let findings = [].concat(o.findings || []).map(f => one(f, 300)).filter(Boolean).slice(0, 12);
  const leadName = (crew[x.d.lead] || {}).name || x.d.lead;
  // SPLIT: the pieces, checked like the lead's own split; recording only while the department's delegation is shadow
  let sp = null;
  if (verdict === 'SPLIT') {
    const g = D.delegationOf(x.d, ds.st);
    if (g.effective === 'off') return bad('splitting big jobs is off for ' + (x.d.name || x.d.id) + ' (departments.js delegation ' + x.d.id + ' shadow|live --by owner)');
    const block = renderPieces([].concat(o.pieces || []).map(t => parsePieceLine(String(t))).filter(Boolean), o.fanout);
    const chk = splitOk(block, { minPieces: g.minPieces, maxPieces: g.maxPieces });
    if (![].concat(o.pieces || []).length) return bad('SPLIT needs the pieces: --piece "<title> — files: a, b — check: <acceptance check>" (at least ' + g.minPieces + ')');
    if (!chk.ok) return bad('SPLIT refused: ' + chk.why);
    sp = { pieces: chk.pieces, fanout: chk.fanout, block, live: g.effective === 'live' };
    findings = chk.pieces.map(p => p.title).slice(0, 12);
  }
  const line = verdictLine({ verdict, by: leadName, check: o.check, findings, tier }) + (sp && !sp.live ? ' — recorded only: splitting is in recording-only mode, so the item stays with ' + ((crew[c.open.fromSeat] || {}).name || c.open.fromSeat || 'its holder') : '');
  const wrote = [];
  const edit = (inbox, fn) => { if (!inbox) return; const f = inboxPath(o, inbox); const t = readText(f); if (t == null) return; const n = fn(t); if (n != null && n !== t) { if (!o.dry) writeAtomic(f, n); wrote.push('company/work/handoffs/' + inbox); } };
  // the consult block in the lead's inbox: the verdict, then DONE
  if (!c.open.shadow) edit((crew[x.d.lead] || {}).inbox, t => { const parts = sections(t); for (let i = 0; i < parts.length; i++) { const p = parsePacket(parts[i]); if (p && p.id === c.id) { parts[i] = parts[i].replace(/^\*\*Status:\*\*\s*OPEN\b.*$/m, line + '\n**Status:** DONE — ' + verdict + ' (' + dayOf(now) + ')'); return parts.join(''); } } return null; });
  // the member's item block: the same line at its end, where model-rank.js reads verdicts
  if (c.open.file) edit(c.open.file, t => {
    const SP = require('./sprint'); const parts = sections(t);
    for (let i = 0; i < parts.length; i++) { if (!parts[i].startsWith('## ')) continue; const it = SP.parseItems(parts[i])[0]; if (it && W.itemId(c.open.file, it.heading, it.id) === c.open.item) { const m = /\n*$/.exec(parts[i]); const body = sp && sp.live ? stripPieces(parts[i].slice(0, m.index)) : parts[i].slice(0, m.index); parts[i] = body + '\n' + (sp && sp.live ? sp.block + '\n' : '') + line + (m[0] || '\n'); return parts.join(''); } }
    return null;
  });
  const runId = process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : null;
  append({ op: 'verdict', at: now, ts: new Date(now).toISOString(), id: c.id, dept: c.open.dept, item: c.open.item, verdict, by: String(x.d.lead), check: one(o.check, 300), findings: findings.length ? findings : undefined, tier: tier || undefined, runId }, o);
  if (sp) append(Object.assign({ op: 'split', at: now, ts: new Date(now).toISOString(), id: 'sp-' + Number(now).toString(36) + '-' + crypto.randomBytes(2).toString('hex'), consult: c.id, dept: c.open.dept, lead: String(x.d.lead), item: c.open.item, file: c.open.file || null,
    title: c.open.title, seat: c.open.fromSeat || null, pieces: sp.pieces, fanout: sp.fanout, hash: piecesHash(sp.pieces, sp.fanout), class: c.open.class, runId }, sp.live ? {} : { shadow: true }), o);
  if (sp && !sp.live) wouldDelegateLog(o, c.open, sp);
  return { ok: true, id: c.id, verdict, line, wrote, split: sp ? { live: sp.live, pieces: sp.pieces.length, fanout: sp.fanout, wouldDelegate: !sp.live || undefined } : undefined };
}

/* ---------------- narrow fan-out: pieces (pure) ----------------
 * In the item's block (the lead writes it, through consult.js answer --verdict SPLIT or consult.js split):
 *   **Pieces:**
 *   1. <title> — files: api/a.ts, api/b.ts — check: <acceptance check>
 *   **Fan-out:** lanes | dispatch        (lanes when absent) */
// one piece line: "<n>. <title> — files: a, b — check: <check>" (the parts after the title in either order; — – or -)
function parsePieceLine(l, n) {
  const raw = String(l || '').trim(); if (!raw) return null;
  const m = /^(\d{1,2})[.)]\s+([\s\S]*)$/.exec(raw);
  const num = m ? Number(m[1]) : (n || 1), rest = m ? m[2] : raw;
  const parts = rest.split(/\s+[—–]{1,2}\s+|\s+-{1,2}\s+(?=(?:files?|check):)/i);
  const out = { n: num, title: one(parts[0], 160), files: [], check: '' };
  for (const p of parts.slice(1)) {
    const f = /^files?:\s*(.*)$/i.exec(p.trim()), c = /^check:\s*(.*)$/i.exec(p.trim());
    if (f) out.files = f[1].split(/[,;]\s*|\s+and\s+/).map(x => x.replace(/[`*]/g, '').trim().replace(/^\.\//, '')).filter(Boolean);
    else if (c) out.check = one(c[1], 300);
    else out.title = one(out.title + ' — ' + p, 160);
  }
  return out.title ? out : null;
}
function parsePieces(block) {
  const L = String(block || '').split('\n'); const pieces = []; let i = L.findIndex(l => /^\*\*Pieces:\*\*\s*$/i.test(l.trim()) || /^\*\*Pieces:\*\*/i.test(l));
  if (i >= 0) for (let k = i + 1; k < L.length; k++) { if (!/^\s*\d{1,2}[.)]\s/.test(L[k])) break; const p = parsePieceLine(L[k]); if (p) pieces.push(p); }
  const f = String(field(block, 'Fan-out') || '').replace(/[`*]/g, '').trim().toLowerCase();
  return { found: i >= 0, pieces, fanout: FANOUTS.includes(f) ? f : f ? null : 'lanes', fanoutRaw: f || null };
}
function splitOk(block, o) {
  const min = Math.max(2, Number((o && o.minPieces) || 3) || 3);
  const max = Math.max(min, Number((o && o.maxPieces) || 6) || 6);
  const P = parsePieces(block);
  const fail = why => ({ ok: false, pieces: P.pieces, fanout: P.fanout, why });
  if (!P.found) return fail('no **Pieces:** list');
  if (P.fanout == null) return fail('**Fan-out:** must be lanes or dispatch (got "' + P.fanoutRaw + '")');
  if (P.pieces.length < min) return fail(P.pieces.length + ' piece' + (P.pieces.length === 1 ? '' : 's') + '; a split needs at least ' + min);
  if (P.pieces.length > max) return fail(P.pieces.length + ' pieces; a split has at most ' + max + ' (delegation.maxPieces): group them into fewer, bigger pieces');
  const noFiles = P.pieces.filter(p => !p.files.length), noCheck = P.pieces.filter(p => !p.check);
  if (noFiles.length) return fail('piece ' + noFiles.map(p => p.n || '?').join(', ') + ' names no files (— files: a, b)');
  if (noCheck.length) return fail('piece ' + noCheck.map(p => p.n || '?').join(', ') + ' has no acceptance check (— check: ..)');
  const SP = require('./sprint');
  for (let a = 0; a < P.pieces.length; a++) for (let b = a + 1; b < P.pieces.length; b++) {
    const hit = P.pieces[a].files.find(x => P.pieces[b].files.some(y => SP.pathOverlap(x, y)));
    if (hit) return fail('pieces ' + P.pieces[a].n + ' and ' + P.pieces[b].n + ' both touch ' + hit + ' (each piece works on its own files)');
  }
  return { ok: true, pieces: P.pieces.map((p, i) => ({ n: i + 1, title: p.title, files: p.files, check: p.check })), fanout: P.fanout, why: P.pieces.length + ' pieces on separate files, each with a check' };
}
function renderPieces(pieces, fanout) {
  const f = FANOUTS.includes(String(fanout || '')) ? String(fanout) : 'lanes';
  return '**Pieces:**\n' + (pieces || []).map((p, i) => (i + 1) + '. ' + one(p.title, 160) + ' — files: ' + (p.files || []).join(', ') + ' — check: ' + one(p.check, 300)).join('\n') + '\n**Fan-out:** ' + f;
}
// an older Pieces list and Fan-out line in a block (a new split replaces them)
function stripPieces(text) {
  const L = String(text).split('\n'); const out = []; let skip = false;
  for (const l of L) {
    if (/^\*\*Pieces:\*\*/i.test(l)) { skip = true; continue; }
    if (skip && /^\s*\d{1,2}[.)]\s/.test(l)) continue;
    skip = false;
    if (/^\*\*Fan-out:\*\*/i.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n+$/, '');
}
const piecesHash = (pieces, fanout) => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify([(pieces || []).map(p => [p.title, p.files, p.check]), fanout || 'lanes'])).digest('hex').slice(0, 16);
function wouldDelegateLog(o, open, sp) {
  if (o.dry) return;
  try { const f = path.join(rootOf(o), 'company', 'work', 'dispatch-log.md'); fs.appendFileSync(f, '- ' + new Date(nowOf(o)).toISOString().slice(0, 16).replace('T', ' ') + ' WOULD DELEGATE ' + open.item + ' (' + open.dept + '): ' + sp.pieces.length + ' pieces by ' + sp.fanout + ' (splitting is recording only)\n'); } catch (_) {}
}
/* the lead's own split of an item in its own inbox (consult.js split <item> --piece .. --by <lead>) */
function split(o) {
  const now = nowOf(o), crew = crewOf(o);
  const bad = (error, code) => ({ ok: false, code: code || 2, error });
  const ds = deptState(o), x = ds.list.find(e => e.d.lead && String(e.d.lead) === String(o.by));
  if (!x) return bad('only a department lead splits an item (' + ((crew[o.by] || {}).name || o.by) + ' leads no department)');
  if (String(x.d.lead) === String(o.ceo || co.ceo())) return bad('the CEO is never a department lead');
  const g = D.delegationOf(x.d, ds.st);
  if (g.effective === 'off') return bad('splitting big jobs is off for ' + (x.d.name || x.d.id) + ' (departments.js delegation ' + x.d.id + ' shadow|live --by owner)');
  const ib = (crew[x.d.lead] || {}).inbox; if (!ib) return bad('the lead has no inbox (loops.json)');
  const file = inboxPath(o, ib), t = readText(file) || '';
  const SP = require('./sprint'); const parts = sections(t); let hit = -1, it = null;
  for (let i = 0; i < parts.length; i++) { if (!parts[i].startsWith('## ')) continue; const p = SP.parseItems(parts[i])[0]; if (p && p.open && (W.itemId(ib, p.heading, p.id) === String(o.item) || p.id === String(o.item))) { hit = i; it = p; break; } }
  if (hit < 0) return bad('no OPEN item ' + o.item + ' in your inbox (' + ib + ')');
  const block = renderPieces([].concat(o.pieces || []).map(t2 => parsePieceLine(String(t2))).filter(Boolean), o.fanout);
  const chk = splitOk(block, { minPieces: g.minPieces, maxPieces: g.maxPieces });
  if (!chk.ok) return bad('split refused: ' + chk.why);
  const live = g.effective === 'live', itemId = W.itemId(ib, it.heading, it.id);
  if (live && !o.dry) { const m = /\n*$/.exec(parts[hit]); parts[hit] = stripPieces(parts[hit].slice(0, m.index)) + '\n' + block + (m[0] || '\n'); writeAtomic(file, parts.join('')); }
  const cls = require('./taskclass').classOf({ text: parts[hit], effort: it.effort }, String(x.d.lead), { departments: { departments: [x.d] } });
  const row = append(Object.assign({ op: 'split', at: now, ts: new Date(now).toISOString(), id: 'sp-' + Number(now).toString(36) + '-' + crypto.randomBytes(2).toString('hex'), consult: null, dept: String(x.d.id), lead: String(x.d.lead), item: itemId, file: ib,
    title: one(it.heading, 160), seat: String(x.d.lead), pieces: chk.pieces, fanout: chk.fanout, hash: piecesHash(chk.pieces, chk.fanout), class: cls, runId: process.env.STARNET_RUN_ID ? one(process.env.STARNET_RUN_ID, 80) : null }, live ? {} : { shadow: true }), o);
  if (!live) wouldDelegateLog(o, { item: itemId, dept: String(x.d.id) }, chk);
  return { ok: true, id: row.id, item: itemId, live, pieces: chk.pieces.length, fanout: chk.fanout, wouldDelegate: !live || undefined, next: live ? (chk.fanout === 'dispatch' ? 'the dispatcher lists you for team.dispatch to your team for this item on its next tick' : 'the dispatcher offers each piece to a free worker on your team as a lane') : 'recorded only: splitting is in recording-only mode, so you keep the item' };
}
/* the recorded splits that are still work: the department's delegation live (not withdrawn), its lead unchanged, the
 * item still OPEN in its file with exactly the recorded pieces (hash), one per item (the newest split row wins) */
function splitCandidates(o) {
  o = o || {}; const crew = crewOf(o), ceo = co.ceo();
  let ds; try { ds = deptState(o); } catch (_) { return []; }
  const live = new Map(ds.list.map(e => [String(e.d.id), { e, g: D.delegationOf(e.d, ds.st) }]).filter(([, v]) => v.g.effective === 'live' && leadOk(v.e.d, ceo)));
  if (!live.size) return [];
  const newest = new Map();
  for (const r of ledger(o)) if (r.op === 'split' && !r.shadow && r.item && r.file) newest.set(r.file + '\n' + r.item, r);
  const SP = require('./sprint'), out = [], texts = new Map();
  for (const r of newest.values()) {
    const v = live.get(String(r.dept)); if (!v || String(v.e.d.lead) !== String(r.lead)) continue;
    if (!texts.has(r.file)) texts.set(r.file, readText(inboxPath(o, r.file)) || '');
    for (const sec of sections(texts.get(r.file))) {
      if (!sec.startsWith('## ')) continue;
      const it = SP.parseItems(sec)[0]; if (!it || !it.open || W.itemId(r.file, it.heading, it.id) !== r.item) continue;
      const chk = splitOk(sec, { minPieces: v.g.minPieces, maxPieces: v.g.maxPieces });
      if (!chk.ok || piecesHash(chk.pieces, chk.fanout) !== r.hash) break;   // edited since the split: not delegated
      out.push({ split: r.id, dept: String(r.dept), lead: String(r.lead), leadName: (crew[r.lead] || {}).name || r.lead, item: r.item, file: r.file, heading: it.heading, text: sec, seat: r.seat, class: r.class || 'general', pieces: chk.pieces, fanout: chk.fanout, delegation: v.g });
      break;
    }
  }
  return out.sort((a, b) => (a.dept + a.item < b.dept + b.item ? -1 : 1));
}

/* ---------------- the advise prompt ---------------- */
function template(o) { return readText(paths(o).template) || readText(paths(o).templateDefault) || 'You are {{LEAD}}, the lead of {{DEPT_NAME}} ({{DEPT_ID}}): answer the open consults in your inbox with node company/tools/consult.js answer.\n\n' + CONSULT_LINE + ' (none)\n'; }
const consultLine = ids => CONSULT_LINE + ' ' + (ids && ids.length ? ids.join(', ') + ' (in your inbox).' : '(none)');
/* the whole own text: the template with the names filled in; only its last line (the consult ids) varies between wakes */
function advisePrompt(o) {
  const t = String(o.template != null ? o.template : template(o)).replace(/\{\{LEAD\}\}/g, o.lead).replace(/\{\{DEPT_ID\}\}/g, o.deptId).replace(/\{\{DEPT_NAME\}\}/g, o.deptName || o.deptId);
  const L = t.replace(/\s+$/, '').split('\n'); const i = L.map(l => l.startsWith(CONSULT_LINE)).lastIndexOf(true);
  if (i >= 0) L[i] = consultLine(o.ids); else L.push('', consultLine(o.ids));
  return L.join('\n') + '\n';
}
/* the routine's current prompt with its own text replaced (house rules and the other blocks after it are kept) */
function withOwnText(current, own) {
  const s = String(current || ''); const i = s.indexOf(CONSULT_LINE);
  if (i < 0) return own;
  const j = s.indexOf('\n', i); return own.replace(/\n$/, '') + (j < 0 ? '' : s.slice(j));
}

/* ---------------- the dispatcher's hold ---------------- */
function holdFn(o) {
  o = o || {};
  let ds; try { ds = deptState(o); } catch (_) { return () => null; }
  const live = ds.list.filter(e => e.a.effective === 'live' && e.d.lead);
  if (!live.length) return () => null;
  const crew = crewOf(o);
  const leadInbox = new Set(live.map(e => (crew[e.d.lead] || {}).inbox).filter(Boolean));
  const liveIds = new Set(live.map(e => String(e.d.id)));
  const held = new Map();
  for (const c of consults(ledger(o)).values()) if (c.status === 'open' && !c.open.shadow && liveIds.has(c.open.dept) && c.open.file) held.set(c.open.file + '\n' + c.open.item, (crew[c.open.lead] || {}).name || c.open.lead);
  return (inbox, it) => {
    if (!it) return null;
    if (leadInbox.has(inbox) && isPacketHeading(it.heading) && /^cs-/.test(String(it.id || ''))) return { who: null, packet: true };   // the advise run's work
    const who = held.get(inbox + '\n' + W.itemId(inbox, it.heading, it.id));
    return who ? { who } : null;
  };
}

/* ---------------- override allowlist: the lead's model ---------------- */
function leadEntries(seatId, o) {
  try {
    const ds = deptState(o);
    const x = ds.list.find(e => e.d.lead && String(e.d.lead) === String(seatId) && e.a.mode === 'live' && e.a.effective === 'live');
    const m = ds.st.leadModelDefault;
    if (!x || !m || !m.provider || !m.model) return [];
    return [Object.assign({ provider: String(m.provider), model: String(m.model) }, m.effort ? { effort: String(m.effort) } : {})];
  } catch (_) { return []; }
}

/* ---------------- items of a department (for the stuck scan) ---------------- */
const SIG_SKIP = /^\*\*(Verdict|Review|Reopened)\b.*$/gim;
function deptItems(o, e, crew, held) {
  const SP = require('./sprint'), STALL = require('./stall'), out = [];
  const failWords = ['REVISE', 'CHANGES-REQUESTED', 'REQUEST-CHANGES', 'REJECT', 'TAKE-OVER'];
  for (const seat of D.members(e.d)) {
    if (seat === String(e.d.lead)) continue;
    const ib = (crew[seat] || {}).inbox; if (!ib) continue;
    const t = readText(inboxPath(o, ib)); if (!t) continue;
    for (const sec of sections(t)) {
      if (!sec.startsWith('## ')) continue;
      const it = SP.parseItems(sec)[0]; if (!it || !it.open || isPacketHeading(it.heading)) continue;
      const id = W.itemId(ib, it.heading, it.id);
      if (held && held(ib, it)) continue;   // its consult is open: nothing new counts until the lead answers
      const verdicts = [...sec.matchAll(/^\*\*(?:Verdict|Review):\*\*\s*(.+)$/gim)].map(m => m[1].replace(/[`*_]/g, '').trim().toUpperCase().replace(/\s+/g, '-'));
      out.push({ id, file: ib, seat, dept: String(e.d.id), title: it.heading, sig: STALL.bodySig(sec.replace(SIG_SKIP, '')), revise: verdicts.filter(v => failWords.some(w => v.startsWith(w))).length,
        reopens: (sec.match(/^\*\*Reopened\b/gim) || []).length, class: require('./taskclass').classOf({ text: sec, effort: it.effort }, seat, { departments: { departments: [e.d] } }) });
    }
  }
  return out;
}

/* ---------------- state ---------------- */
function readState(o) { const s = readJson(paths(o).state, null); return s && typeof s === 'object' ? Object.assign({ v: 1, items: {}, daily: {}, lastAdvise: {}, routines: {}, autoPaused: {} }, s) : { v: 1, items: {}, daily: {}, lastAdvise: {}, routines: {}, autoPaused: {} }; }
function writeState(st, o) {
  if (o.dry) return;
  const doc = 'Consult state (lib/consult.js, written by the dispatcher\'s consult step): stuck counters per item, consults opened per department today, the last advise run per department, the advise routines it keeps on the station, the evaluation hashes it already paused on.';
  const f = paths(o).state; const text = JSON.stringify(Object.assign({ _doc: doc }, st, { _doc: doc }), null, 1) + '\n';
  writeAtomic(f, text); const p = prov(); if (p) try { p.wrote(f, text, WRITER); } catch (_) {}
}

/* ---------------- the dispatcher's step ----------------
 * ctx: { dry, log, jobs, order, say, call (the dispatcher's station call), fireRun (jobId, override) -> {status, body},
 *        now?, root? }. Fail-safe per department: an error is one log line. Writes nothing while no department's advisor
 *        is on and it keeps no advise routine. */
async function consultStep(ctx) {
  const o = { root: rootOf(ctx), dry: !!ctx.dry, now: nowOf(ctx) };
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};
  const ds = deptState(o), crew = crewOf(o), ceo = co.ceo();
  const active = ds.list.filter(e => e.a.mode !== 'off');
  let st = readState(o);
  if (!active.length && !Object.keys(st.routines || {}).length) return { active: 0 };
  const now = o.now, jobs = ctx.jobs || [];
  const ST = require('./station'), SCHED = require('./scheduler'), A = require('./admit');
  const rows = ledger(o); let all = consults(rows);
  const out = { active: active.length, opened: [], dropped: [], advised: [], wouldAdvise: [], paused: [] };
  // 1. answers since the last scan reset their item's counters
  const lastScan = Number(st.lastScanAt) || 0;
  const answered = rows.filter(r => r.op === 'verdict' && (Number(r.at) || 0) > lastScan).map(r => r.item).filter(Boolean);
  // 2. the stuck scan over the active departments' open items
  let exclude = ['providerError', 'sliceCut'];
  try { const MR = require('../model-rank.js'); const pol = MR.loadPolicy(o.root); if (pol) exclude = [...MR.knobs(pol.policy).excludeKinds]; } catch (_) {}
  const hold = holdFn(o);
  const items = []; const settings = {};
  for (const e of active) { if (!leadOk(e.d, ceo)) continue; settings[String(e.d.id)] = e.c; items.push(...deptItems(o, e, crew, hold)); }
  const B = require('./bounded');
  const wakes = B.jsonlWindow(paths(o).wakes, { sinceMs: now - 7 * DAY, tsOf: r => Number(r.at) || 0 }).rows;
  const runs = B.jsonlWindow(paths(o).runs, { sinceMs: now - 8 * DAY }).rows;
  const sc = stuckScan({ items, wakes, runs, state: st, now, excludeKinds: exclude, answered, settings });
  st = sc.state;
  for (const t of sc.triggers) {
    const seatName = (crew[t.seat] || {}).name || t.seat;
    const it = items.find(i => i.id === t.item) || {};
    const words = t.trigger.startsWith('failed-runs') ? 'its last runs on it failed' : t.trigger.startsWith('revise') ? 'it was sent back for changes more than once' : t.trigger.startsWith('idle-wakes') ? 'its last runs on it changed nothing' : 'it was reopened after it was done';
    const r = writePacket({ dept: t.dept, item: t.item, file: t.file, title: t.title, from: 'dispatcher on behalf of ' + seatName, fromSeat: t.seat, kind: 'stuck', trigger: t.trigger, class: it.class,
      question: seatName + '\'s item "' + one(t.title, 120) + '" looks stuck: ' + words + ' (' + t.trigger + '). What should ' + seatName + ' do next?', tried: t.tried, check: '' }, Object.assign({ clip: true, crew }, o));
    if (r.ok) { st.items[t.item].lastConsultId = r.id; out.opened.push(r.id); log('CONSULT ' + (r.delivered ? 'OPENED ' : 'RECORDED (shadow) ') + r.id + ' for ' + seatName + ' "' + one(t.title, 80) + '" (' + t.trigger + ') -> ' + ((crew[(ds.list.find(e => String(e.d.id) === t.dept) || { d: {} }).d.lead] || {}).name || 'the lead')); }
    else { out.dropped.push(r.dropped || r.error); log('CONSULT DROPPED for ' + seatName + ' "' + one(t.title, 80) + '" (' + t.trigger + '): ' + (r.error || r.dropped)); }
  }
  all = consults(ledger(o));
  // 3. the advise routines: one per live department with a lead (mode live, paused or not); removed when it leaves live
  const want = new Map(active.filter(e => e.a.mode === 'live' && leadOk(e.d, ceo)).map(e => [String(e.d.id), e]));
  st.routines = st.routines || {};
  for (const [dept, r] of Object.entries(st.routines)) {
    const e = want.get(dept);
    if (e && String(e.d.lead) === r.lead && jobs.some(j => j.id === r.jobId)) continue;
    if (jobs.some(j => j.id === r.jobId)) {
      if (o.dry) log('WOULD remove the advise routine "' + r.name + '"');
      else { const x = await ST.cron(ctx.call, 'POST', '/api/cron/remove', { id: r.jobId }, 'remove "' + r.name + '"'); log(x.ok ? 'ADVISE ROUTINE removed "' + r.name + '" (' + (e ? 'the lead changed' : 'the department\'s advice is not on') + ')' : 'ADVISE ROUTINE ERROR: ' + x.reason); if (!x.ok) continue; }
    }
    delete st.routines[dept];
  }
  const tmpl = template(o);
  for (const [dept, e] of want) {
    if (st.routines[dept]) continue;
    const leadName = (crew[e.d.lead] || {}).name || e.d.lead;
    const spec = SCHED.adviseSpec({ root: o.root, agentId: String(e.d.lead), leadName, suffix: e.a.routine, prompt: advisePrompt({ template: tmpl, lead: leadName, deptId: dept, deptName: e.d.name, ids: [] }), model: ds.st.leadModelDefault });
    if (o.dry) { log('WOULD create the advise routine "' + spec.name + '"'); continue; }
    const r = await ST.createRoutine(ctx.call, spec, { what: 'create "' + spec.name + '"', rename: () => ST.uniqueName(spec.name, 2), attempts: 3 });
    if (r.ok) { st.routines[dept] = { jobId: r.job.id, lead: String(e.d.lead), name: r.name, at: new Date(now).toISOString() }; jobs.push(r.job); log('ADVISE ROUTINE created "' + r.name + '" for ' + leadName + ' (' + (e.d.name || dept) + '; the dispatcher starts it)'); }
    else log('ADVISE ROUTINE ERROR: ' + r.reason);
  }
  // 4. the batch, per active department
  st.lastAdvise = st.lastAdvise || {}; st.daily = {};
  const order = Array.isArray(ctx.order) ? ctx.order : [];
  const say = typeof ctx.say === 'function' ? ctx.say : () => {};
  const drop = id => { const i = order.indexOf(id); if (i >= 0) order.splice(i, 1); };
  for (const e of active) {
    const dept = String(e.d.id); if (!leadOk(e.d, ceo)) continue;
    const lead = String(e.d.lead), leadName = (crew[lead] || {}).name || lead;
    const mine = [...all.values()].filter(c => c.open.dept === dept);
    st.daily[dept] = { day: dayOf(now), opened: mine.filter(c => c.open.op === 'open' && dayOf(Number(c.open.at) || 0) === dayOf(now)).length };
    try {
      const open = mine.filter(c => c.status === 'open');
      if (e.a.effective !== 'live') {   // shadow or paused: what would start is logged and recorded, nothing runs
        const pending = open.filter(c => !c.advised.length).map(c => ({ id: c.id, at: c.open.at }));
        const bd = batchDue({ pending, lastAdvise: st.lastAdvise[dept + ':shadow'], batch: e.a.batch, now });
        if (bd.start) {
          const ids = pending.map(p => p.id);
          append({ op: 'advise', at: now, ts: new Date(now).toISOString(), ids, dept, lead, shadow: true, wakeId: null, runId: null, admitId: null }, o);
          st.lastAdvise[dept + ':shadow'] = now; out.wouldAdvise.push(dept);
          log('WOULD ADVISE ' + leadName + ' (' + (e.d.name || dept) + (e.a.paused ? ', paused' : ', recording only') + '): ' + ids.join(', ') + ' — ' + bd.why);
        }
        continue;
      }
      const r = st.routines[dept]; const job = r && jobs.find(j => j.id === r.jobId);
      const loopJob = crew[lead] && crew[lead].loop ? SCHED.crewLoopOf(jobs, crew[lead].loop) : null;
      const adviseBusy = !!(job && (job.inFlight || job.state === 'running'));
      const loopBusy = !!(loopJob && (loopJob.inFlight || loopJob.state === 'running'));
      if (adviseBusy) { drop(lead); say(lead, { state: 'working' }); }   // the advise run is busy work: no loop on top of it
      if (!job) continue;
      const pending = open.filter(c => !c.open.shadow && !c.advised.some(a => !a.shadow)).map(c => ({ id: c.id, at: c.open.at }));
      const bd = batchDue({ pending, lastAdvise: st.lastAdvise[dept], inFlight: adviseBusy ? 'an advise run is in flight' : loopBusy ? leadName + '\'s own loop is running' : false, batch: e.a.batch, now });
      if (!bd.start) continue;
      const ids = open.filter(c => !c.open.shadow).map(c => c.id);
      const consulted = open.filter(c => !c.open.shadow);
      const why = 'advise ' + ids.join(', ');
      if (o.dry) { log('WOULD start ' + job.name + ' for ' + leadName + ' (' + why + ') — ' + bd.why); continue; }
      const prompt = withOwnText(job.prompt, advisePrompt({ template: tmpl, lead: leadName, deptId: dept, deptName: e.d.name, ids }));
      if (prompt !== job.prompt) { const u = await ST.cron(ctx.call, 'POST', '/api/cron/update', { id: job.id, patch: { prompt } }, 'update "' + job.name + '"'); if (!u.ok) { log('ADVISE ERROR: ' + u.reason); continue; } job.prompt = prompt; }
      const pair = ds.st.leadModelDefault || null;
      // the same rules as any other wake, for the model the run will really use: the approval mode ("ask" cannot save
      // unattended), the money check (the daily metered cap, the per-agent share, the Sprint budget and spread: lib/admit.js
      // money() with the dispatcher's numbers; no numbers = held) and the pacer (the override allowlist this tick lists the
      // pair open for the lead: a stop, a closure or the pacer's hold shuts it). The lead model first, else the routine's
      // own; neither open = the advise run waits for a later tick.
      if (ctx.modes && ctx.modes[lead] === 'ask' && !ctx.allowAsk) { log('ADVISE HOLD ' + job.name + ' for ' + leadName + ': its approval mode is "ask", so an unattended run could not save anything'); continue; }
      const moneyWhy = require('./delegate-allow').moneyFn(ctx.budget);
      const OA = require('./override-allow');
      // the class rules for review AND for the department's own default class: an advise run may TAKE OVER with workbench
      // tools, so in a code department it is code work and never runs on MiniMax (2026-11-19 safety re-review)
      const classes = ['review'].concat(e.d.defaultClass && e.d.defaultClass !== 'review' ? [String(e.d.defaultClass)] : []);
      const classDeny = p => { if (classes.includes('code') && String(p.provider) === 'custom') return 'code is never on the MiniMax plan'; try { const R = require('./routing'); const L = R.loadPolicy(o.root); if (L) for (const c of classes) if (!R.routeAllowed(c, { provider: p.provider, model: p.model }, R.knobs(L.policy))) return 'the class rules deny it for ' + c + ' work'; } catch (_) {} return null; };
      const usable = (p, viaOverride) => { const cd = classDeny(p); if (cd) return (viaOverride ? 'the lead model: ' : 'its own model: ') + cd; const sh = OA.openFor(lead, p, { root: o.root }); if (sh) return (viaOverride ? 'the lead model is ' : 'its own model is ') + sh; const m = moneyWhy(lead, p.provider); return m ? m : null; };
      let override = null, note = '', held = null;
      if (pair && pair.provider && pair.model) {
        const shut = usable(pair, true);
        if (!shut) override = Object.assign({ provider: pair.provider, model: pair.model }, pair.effort ? { effort: pair.effort } : {});
        else note = ' (on its own model: ' + shut + ')';
      }
      const own = { provider: String(job.provider || ''), model: String(job.model || '') };
      if (!override) { const w2 = own.provider && own.model ? usable(own, false) : 'its routine names no model'; if (w2) held = (note ? note.replace(/^ \(on its own model: |\)$/g, '') + '; ' : '') + w2; }
      if (held) { log('ADVISE HOLD ' + job.name + ' for ' + leadName + ': ' + held); continue; }
      const tk = A.admit({ door: 'consult', kind: 'run', seat: lead, jobId: job.id, provider: (override && override.provider) || job.provider, why: why.slice(0, 200) });
      if (tk.decision === 'hold') { log('ADVISE HOLD ' + job.name + ' for ' + leadName + ': ' + tk.reason); continue; }
      let res = await ctx.fireRun(job.id, override);
      if (override && res.status === 403) {
        // the station refused the lead model: the routine's own model only when it passes the same checks
        const w3 = own.provider && own.model ? usable(own, false) : 'its routine names no model';
        if (w3) { A.started(tk, Object.assign({}, res, { runId: null })); log('ADVISE HOLD ' + job.name + ' for ' + leadName + ': the station refused the lead model and ' + w3); continue; }
        note = ' (the station refused the lead model; on its own model)'; override = null; res = await ctx.fireRun(job.id);
      }
      const runId = res.status === 200 ? W.runIdOf(res.body) : null;
      A.started(tk, Object.assign({}, res, { runId }));
      if (res.status !== 200) { log('ADVISE refused for ' + leadName + ': HTTP ' + res.status + ' ' + String(res.body || '').slice(0, 160)); continue; }
      const wakeId = W.newWakeId(now);
      W.record({ wakeId, seat: lead, runId, admitId: tk.id, jobId: job.id, door: 'consult', items: consulted.map(c => ({ file: c.open.file || ((crew[c.open.fromSeat] || {}).inbox) || '', id: c.open.item, title: c.open.title, due: null })), why });
      append({ op: 'advise', at: now, ts: new Date(now).toISOString(), ids, dept, lead, wakeId, runId, admitId: tk.id }, o);
      st.lastAdvise[dept] = now; out.advised.push(dept);
      drop(lead); say(lead, { state: 'working' });
      log('ADVISE ' + job.name + ' for ' + leadName + ': ' + ids.join(', ') + ' — ' + bd.why + (override ? ' (on ' + override.provider + '/' + override.model + (override.effort ? '@' + override.effort : '') + ', one-run override)' : note));
    } catch (err) { log('CONSULT ERROR (' + dept + '): ' + String(err && err.message || err).slice(0, 200)); }
  }
  // 5. the auto-pause: the house ranking's advisor evaluation said pause (once per evaluation hash)
  const ev = readJson(paths(o).evaluation, null);
  for (const r of ((ev && ev.advisor && ev.advisor.departments) || [])) {
    const e = active.find(x => String(x.d.id) === String(r.dept)); if (!e) continue;
    if (!(e.a.autoPause && e.a.autoPause.enabled) || e.a.mode !== 'live' || e.a.paused || r.verdict !== 'pause' || !r.hash) continue;
    if (st.autoPaused[r.dept] === r.hash) continue;
    const bar = one((r.failed || []).join('; ') || (r.reasons || []).join('; '), 280) || 'the advice did not pay';
    if (o.dry) { log('WOULD pause the advice of ' + r.dept + ': ' + bar); continue; }
    st.autoPaused[r.dept] = r.hash;
    let res; try { res = require('../departments.js').run(['advisor', r.dept, 'pause', '--by', 'dispatcher', '--auto', '--why', bar, '--hash', String(r.hash)]); } catch (err) { res = { code: 1, out: { error: err.message } }; }
    if (res.code !== 0) { log('ADVISOR PAUSE ERROR (' + r.dept + '): ' + ((res.out && res.out.error) || 'failed')); continue; }
    out.paused.push(r.dept);
    const leadName = (crew[e.d.lead] || {}).name || e.d.lead;
    log('ADVISOR PAUSED ' + r.dept + ' (' + leadName + '): ' + bar + ' (evaluation ' + String(r.hash).slice(0, 19) + '; only the owner resumes)');
    try { require('./owner-notice').send({ kind: 'fyi', from: 'the dispatcher', text: pausedWords(leadName, e.d.name || r.dept), technical: 'advisorEvaluation ' + r.dept + ': ' + bar, key: 'advisor-pause:' + r.dept + ':' + r.hash }); } catch (_) {}
  }
  st.lastScanAt = now;
  writeState(st, o);
  return out;
}
const pausedWords = (lead, dept) => 'The crew paused ' + lead + '\'s advice for ' + dept + ': over the last two weeks it cost more than it saved. You can turn it back on from the ' + dept + ' card.';

/* ---------------- the pre-merge gate's advisory row ----------------
 * o: { root?, repo, pr (number), head (sha), authorAgent (a crew name or id), title?, url? }
 * -> null (the PR's author is in no live advisor department, or is its lead) | { lead: {verdict, by, consult, check, advisory}, words, opened? } */
function premergeAdvice(o) {
  const crew = crewOf(o), ceo = co.ceo();
  const low = String(o.authorAgent || '').trim().toLowerCase(); if (!low || low === 'unknown') return null;
  const seat = Object.keys(crew).find(id => id.toLowerCase() === low || String((crew[id] || {}).name || '').trim().toLowerCase() === low || String((crew[id] || {}).name || '').trim().toLowerCase().split(/\s+/)[0] === low);
  if (!seat) return null;
  const ds = deptState(o), e = ds.list.find(x => D.members(x.d).includes(seat) || String(x.d.lead) === seat);
  if (!e || e.a.effective !== 'live' || !leadOk(e.d, ceo) || String(e.d.lead) === seat) return null;
  const repoName = String(o.repo || '').split('/').pop().toLowerCase(), key = repoName + '#' + o.pr;
  const url = o.url || ('https://github.com/' + o.repo + '/pull/' + o.pr);
  const prKey = s => { const m = /\/([\w.-]+)\/pull\/(\d+)/.exec(String(s || '')) || /([\w.-]+)#(\d+)/.exec(String(s || '')); return m ? m[1].split('/').pop().toLowerCase() + '#' + m[2] : null; };
  const asked = [...consults(ledger(o)).values()].filter(c => c.open.kind === 'premerge' && c.open.dept === String(e.d.id) && prKey(c.open.pr) === key);
  const mine = asked.filter(c => c.open.op === 'open').sort((a, b) => (Number(a.open.at) || 0) - (Number(b.open.at) || 0));
  const leadName = (crew[e.d.lead] || {}).name || e.d.lead;
  const done = mine.filter(c => c.verdict).sort((a, b) => (Number(a.verdict.at) || 0) - (Number(b.verdict.at) || 0)).pop() || null;
  let opened = null;
  if (!asked.some(c => c.open.head === o.head)) {   // once per PR head (a drop counts: it is not asked again)
    // the item: the author's handoff block that names this PR, else the PR itself
    let file = (crew[seat] || {}).inbox || null, item = 'pr:' + key, title = one(o.title || ('pull request ' + key), 80);
    if (file) { const t = readText(inboxPath(o, file)) || ''; const SP = require('./sprint'); for (const sec of sections(t)) { if (!sec.startsWith('## ')) continue; if (!(sec.includes(url) || new RegExp('#' + o.pr + '\\b').test(field(sec, 'PR') || ''))) continue; const it = SP.parseItems(sec)[0]; if (it) { item = W.itemId(file, it.heading, it.id); title = one(it.heading, 80); } } }
    const r = writePacket({ dept: String(e.d.id), item, file, title, from: 'the pre-merge gate on behalf of ' + ((crew[seat] || {}).name || seat), fromSeat: seat, kind: 'premerge', trigger: 'asked', pr: url, head: o.head,
      question: 'Is this change ready to merge? The pre-merge gate is checking it now; your answer is advice and never blocks the merge.', tried: '- the gate\'s own checks (premerge-check.js) on head ' + String(o.head || '').slice(0, 12), check: 'the pre-merge gate\'s rows for this head, and the change against its item\'s acceptance check' }, Object.assign({ clip: true, crew }, o));
    opened = r.ok ? r.id : null;
  }
  const v = done && done.verdict;
  const lead = { verdict: v && ['APPROVE', 'REVISE'].includes(v.verdict) ? v.verdict : null, by: leadName, consult: (done || mine[mine.length - 1] || {}).id || opened || null, check: v ? v.check : null, advisory: true };
  if (v && !lead.verdict) lead.raw = v.verdict;
  const words = v ? leadName + ' said ' + v.verdict + (v.check ? ' (check: ' + one(v.check, 120) + ')' : '') + (v.findings && v.findings.length ? ': ' + v.findings.slice(0, 3).join('; ') : '') : (opened || mine.length ? 'asked ' + leadName + '; no answer yet' : 'not asked');
  return { lead, words, opened };
}

/* ---------------- status ---------------- */
function status(o) {
  o = o || {}; const now = nowOf(o), crew = crewOf(o), ceo = co.ceo();
  const ds = deptState(o), all = [...consults(ledger(o)).values()], st = readState(o);
  const ev = readJson(paths(o).evaluation, null);
  const evals = new Map((((ev && ev.advisor) || {}).departments || []).map(r => [String(r.dept), r]));
  const out = [];
  for (const e of ds.list) {
    const dept = String(e.d.id); if (o.dept && o.dept !== dept) continue;
    const mine = all.filter(c => c.open.dept === dept);
    const today = mine.filter(c => c.open.op === 'open' && dayOf(Number(c.open.at) || 0) === dayOf(now));
    const open = mine.filter(c => c.status === 'open');
    const pending = open.filter(c => !c.open.shadow && !c.advised.some(a => !a.shadow)).map(c => ({ id: c.id, at: c.open.at }));
    const bd = e.a.effective === 'live' ? batchDue({ pending, lastAdvise: (st.lastAdvise || {})[dept], batch: e.a.batch, now }) : null;
    const advices = mine.flatMap(c => c.advised).filter(a => !a.shadow).map(a => Number(a.at) || 0);
    const lastVerdict = mine.filter(c => c.verdict).map(c => Number(c.verdict.at) || 0);
    out.push({ dept, name: e.d.name || dept, lead: e.d.lead || null, leadName: e.d.lead ? ((crew[e.d.lead] || {}).name || e.d.lead) : null, leadIsCeo: !!e.d.lead && String(e.d.lead) === String(ceo),
      mode: e.a.mode, effective: e.a.effective, paused: e.a.paused, since: e.a.since, autoPause: !!(e.a.autoPause && e.a.autoPause.enabled),
      today: today.length, maxPerDay: e.c.maxPerDay, open: open.length, openIds: open.map(c => c.id), dropped: mine.filter(c => c.status === 'dropped' && dayOf(Number(c.open.at) || 0) === dayOf(now)).length,
      lastAdviceAt: advices.length ? new Date(Math.max(...advices)).toISOString() : null, lastAnswerAt: lastVerdict.length ? new Date(Math.max(...lastVerdict)).toISOString() : null,
      nextAdvice: bd ? (bd.start ? 'next dispatcher tick' : bd.nextAt ? new Date(bd.nextAt).toISOString() : null) : null, nextWhy: bd ? bd.why : null,
      evaluation: evals.get(dept) || null });
  }
  return { ok: true, at: new Date(now).toISOString(), departments: out };
}

module.exports = { FANOUTS, parsePieces, parsePieceLine, splitOk, renderPieces, stripPieces, piecesHash, split, splitCandidates, WRITER, KINDS, VERDICTS, DROP_WHY, CONSULT_LINE, paths, renderPacket, parsePacket, isPacketHeading, ledger, consults, writePacket, stuckScan, runKindOf, batchDue,
  verdictLine, parseTier, answer, template, advisePrompt, consultLine, withOwnText, holdFn, leadEntries, deptItems, readState, writeState, consultStep, premergeAdvice, status, pausedWords };
