#!/usr/bin/env node
/* approvals.js — owner approvals as EXISTING owner-question records (company/pm-inbox.jsonl, read through inbox.js):
 * mint one only when governance says the owner must approve, answer it with compare-and-swap, expire it to its default
 * (deny) server-side, remind in batches. No third store: every row this tool writes is a pm-inbox row (ask with
 * `approval`, approval-amend, approval-journal, answer, approval-reminder); the audit line is company/tools/decision.js add.
 * Docs: docs/CHAT-ACTIONS.md "Approvals in chat".
 *
 *   node company/tools/approvals.js ask --from <seat name> --category <governance category> --message "2-4 sentences"
 *        --params '<json: what exactly is approved>' [--details ".."] [--expires-min N] [--blocking] [--depends-on q-1,q-2]
 *        [--handoff "<heading of the asker's OPEN handoff this waits on>"]
 *   node company/tools/approvals.js amend <id> --params '<json>' --by <asker>       (a new actionDigest: old answers refused)
 *   node company/tools/approvals.js withdraw <id> --why ".." --by <asker>           (inbox.js withdraw + the audit withdraw)
 *   node company/tools/approvals.js list [--all]  |  get <id>  |  blocking-seats
 *   node company/tools/approvals.js answer <id> --verdict yes|no --digest <shown actionDigest> --by owner
 *        (the owner only, from the owner's own shell: lib/owner.js; the surface is always "cli")
 *   node company/tools/approvals.js tick                                            (expire, remind, repair)
 * Tests: node --test company/tools/tests/approvals.test.js, approvals-console.test.js, approvals-dispatch.test.js.
 *
 * GOVERNANCE FIRST (lib/governance.js level(), with triage): `auto` acts and logs (a decisions.md line, no record);
 * `notify` acts, logs and tells (one owner-channel sentence via governance notify; no record, not in the badge, never
 * reminded); `triage` runs the gate-triage model and mints only when it escalates; `approve` and every FIXED owner gate
 * (governance.json `fixed`, the single source; gate-triage's fixed-gate rule must list the same set) mint a record.
 *
 * A RECORD: an inbox.js ask (kind approve) with row.approval = {category, level (approve | triage: what governance said
 * when it was minted), params (canonical), actionDigest (sha256 over the canonical {category, from, params}, computed
 * here at creation and authoritative), expiresAt|null, default 'deny', blocking, dependsOn, handoff}. An amend row
 * replaces params and actionDigest. A record with no actionDigest (an older gate question) is answerable only from
 * Needs you, by the owner. No expiresAt = no expiry.
 *
 * AUTHORITY (owner amendment round 2, 1): a fixed gate, an older record, and any category governance has at `approve`:
 * the OWNER only (an `approve` level means the company waits for the owner). A category governance TRIAGES (level
 * triage, both when minted and now): the owner or the CEO. Never the asking seat. "--by owner" (or the owner's name) is
 * the shared owner rule, lib/owner.js: this process must be the owner's own interactive shell or the owner's console;
 * an agent's run, a detached or env-stripped process is refused. A crew --by must be a real seat (exact crew name or
 * id), the CEO, not the asker, and the caller must BE that seat. That last check cannot be made from a CLI: the
 * transcript check other tools use (provenance.callerConflict, locked-watch verifyRan) only proves a command did NOT
 * run in someone else's run, and an agent's tool calls reach the transcript after the command has run, so a script, a
 * detached process or a not-yet-written transcript all pass it. A late flag cannot take back an approval the asker has
 * already acted on, so crew answers are REFUSED from the CLI; in-process they need S.crewCaller() (the verified seat
 * of the caller, null until the station can say which run is calling) to name the CEO.
 *
 * ANSWER (CAS under a lock beside pm-inbox.jsonl): refused unless the record is pending, shownDigest equals the current
 * actionDigest, the answerer has the authority above, and the surface may answer it. The SURFACE is set by the caller's
 * route, never by a request body: console/server.js passes "chat" for the chat route and "needs-you" for Today; the CLI
 * passes "cli". A fixed gate is answered only on needs-you or cli (by the owner), whatever the surface claims; an
 * older record only on needs-you. The winner writes a journal row, then ONE answer row {surface, shownDigest, by}, then
 * ONE decisions.md line (decision.js add, naming the surface), then wakes the asker through the owner-message path
 * (inbox.js deliver: re <id>, opening with the asker's name) and closes the handoff the record names. Each step is
 * journalled; tick() repairs an answered record whose journal shows no audit line or no wake (a crash in between).
 * The loser gets "already answered by X via <surface> at T" and writes nothing.
 * THE LOCK: a directory with owner.json {pid, host, token, at}. Waiting is an async retry (setTimeout), never a blocking
 * sleep, so the console server's event loop never stalls on it. A lock whose owner pid is dead (same host), one with no
 * owner file after 2 s, or one older than 10 min is stale: it is taken over by an atomic rename (only one taker wins),
 * then re-checked, and released only by the holder whose token is in it.
 * EXPIRY (tick, server-side): a pending record past expiresAt gets the default: an answer row verdict no, surface expiry,
 * appliedBy = who ran it (the dispatcher, the console, the CLI, or the answer path), the audit line naming that actor,
 * and the asker is told. REMINDERS (tick): a record is due 15 min after it was CREATED; due records, plus any minted in
 * the same burst (within 60 s of the earliest due one), go out as one batch per 15-minute window: one approval-reminder
 * row and one owner-channel line with the pending count. Each record is reminded once.
 * DEPENDENTS: a record whose dependsOn names a pending blocking record is suppressed (not reminded, not answerable)
 * until that record is answered, expires or is withdrawn. The dispatcher's hook is a READ: blockingSeats().
 * ANTI-SPAM: per-seat caps from company/defaults/state/approvals-policy.json (company/state/ overrides); an ask whose
 * actionDigest matches a pending record returns that record instead of minting a second one.
 * This tool runs no other tool and no command: decision.js, inbox.js and governance are required in process.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const co = require('./lib/company');
const inbox = require('./inbox.js');
const gov = require('./lib/governance');
const decision = require('./decision.js');
const ownerRule = require('./lib/owner');

// seams for the tests (and nothing else)
const S = { now: () => Date.now(), govOpts: {}, ceo: () => co.ceo(), nameOf: id => co.nameOf(id), owner: () => (co.config.owner && co.config.owner.name) || 'Owner',
  ownerShell: () => ownerRule.shell(), crewCaller: () => null, lockWaitMs: 10e3 };
if (process.env.APPROVALS_DECISIONS_ROOT) decision._internals.S.root = () => process.env.APPROVALS_DECISIONS_ROOT;   // tests only
if (process.env.APPROVALS_GOV_ROOT) S.govOpts = { root: process.env.APPROVALS_GOV_ROOT };                           // tests only

const SURFACES = ['chat', 'needs-you', 'console', 'cli'];      // every surface a stored answer row may name
const ANSWER_SURFACES = ['chat', 'needs-you', 'cli'];          // the ones an answer may come from now (set by the route)
const FIXED_SURFACES = ['needs-you', 'cli'];
const MIN = 60e3;
const BURST_MS = 60e3;

/* ---------- canonical parameters and the digest ---------- */
function canonical(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('params: numbers must be finite'); const n = Number(v.toPrecision(15)); return Object.is(n, -0) ? 0 : n; }
  if (typeof v === 'string') return v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k.normalize('NFC')] = canonical(v[k]); return o; }
  throw new Error('params: unsupported value');
}
const digestOf = x => 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const actionDigestOf = (category, from, params) => digestOf({ category, from: String(from || '').trim().toLowerCase(), params: params || {} });

/* ---------- policy, governance ---------- */
function policy() {
  const d = co.readJson(co.p('company', 'defaults', 'state', 'approvals-policy.json'), {}) || {};
  const o = co.readJson(co.p('company', 'state', 'approvals-policy.json'), {}) || {};
  return Object.assign({ maxPendingPerSeat: 5, maxPerWindowPerSeat: 10, windowMin: 60, reminderMin: 15, defaultExpiryMin: null }, d, o);
}
/* the fixed owner gates: governance.json `fixed`, the one source (a drift test checks gate-triage's rule against it) */
function fixedSet() { return Object.keys((gov.doc(S.govOpts) || {}).fixed || {}); }
const isFixed = c => !!c && fixedSet().includes(c);
const levelNow = c => { try { return gov.level(c, Object.assign({}, S.govOpts, { triage: true })); } catch (_) { return 'approve'; } };

/* ---------- people ---------- */
const low = s => String(s || '').trim().toLowerCase();
const first = s => low(s).split(/\s+/)[0];
const sameSeat = (a, b) => !!low(a) && (low(a) === low(b) || first(a) === first(b));
/* a real seat: an exact crew id or crew name (no first-name guessing for an answerer) */
function seatOf(name) {
  const n = low(name); if (!n) return null;
  const hit = Object.entries(co.crew() || {}).find(([id, c]) => low(id) === n || (c && low(c.name) === n));
  return hit ? { id: hit[0], name: (hit[1] && hit[1].name) || hit[0] } : null;
}
/* the asker's seat id: exact, else the first-name match the inbox uses for "from" */
function askerSeat(from) {
  const exact = seatOf(from); if (exact) return exact.id;
  const hit = Object.entries(co.crew() || {}).find(([id, c]) => c && sameSeat(c.name, from));
  return hit ? hit[0] : null;
}
/* who is answering: { role: 'owner' | 'ceo' | 'crew' | null, seat? } */
function answererOf(by) {
  const b = low(by); if (!b) return { role: null };
  const seat = seatOf(by);
  // "owner" and "commander" always mean the owner; the owner's NAME means the owner unless a crew seat has that name
  if (b === 'owner' || b === 'commander' || (!seat && ownerRule.isOwnerName(by))) return { role: 'owner' };
  if (seat) return { role: seat.id === S.ceo() ? 'ceo' : 'crew', seat };
  return { role: null };
}
/* the decisions.md author for a seat: its crew name, else the CEO (decision.js only takes crew or owner) */
function author(name) {
  const crew = co.crew(); const hit = Object.entries(crew).find(([id, c]) => c && (sameSeat(c.name, name) || low(id) === low(name)));
  return hit ? hit[1].name : S.nameOf(S.ceo()) || S.owner();
}
function audit(by, text) { const r = decision.add({ by, text }); if (r && r.error) throw new Error('audit line not written: ' + r.error); return r; }
/* who runs this process, for the expiry line ("applied by ..."): the caller says so; otherwise the main script */
function processActor() {
  const m = String((require.main && require.main.filename) || '');
  if (/console[\/\\]server\.js$/.test(m)) return 'the console';
  if (/dispatch(er-loop)?\.js$/.test(m)) return 'the dispatcher';
  if (/approvals\.js$/.test(m)) return 'the approvals CLI';
  return m ? path.basename(m) : 'an in-process caller';
}

/* ---------- reading the records ---------- */
const rows = () => inbox.readAll();
function authorityOf(r) {
  if (r.fixed) return { who: ['owner'], why: r.category + ' is a fixed owner gate (governance.json fixed): only the owner decides it, on Today › Needs you' };
  if (r.legacy) return { who: ['owner'], why: 'an older owner question (no action digest): only the owner answers it, on Today › Needs you' };
  if (r.level === 'triage' && levelNow(r.category) === 'triage') return { who: ['owner', 'ceo'], why: 'self-governance ' + r.category + ' is at triage: the owner or the CEO; never the asker' };
  return { who: ['owner'], why: 'self-governance ' + (r.category || 'approval') + ' is at approve: the company waits for the owner; never the asker' };
}
function records() {
  const st = inbox.state(); const all = rows();
  const amends = {}, reminded = new Set(), reminders = [], journal = {};
  for (const r of all) {
    if (r.type === 'approval-amend' && r.id) amends[r.id] = r;
    if (r.type === 'approval-reminder') { reminders.push(r); for (const id of r.ids || []) reminded.add(id); }
    if (r.type === 'approval-journal' && r.id) { const j = journal[r.id] = journal[r.id] || {}; j[r.step] = r; }
  }
  const out = {};
  for (const x of Object.values(st)) {
    if (!x.askedAt || !(x.approval || x.gate)) continue;   // an ask row (state() merges later rows onto it)
    const ap = x.approval || {}; const am = amends[x.id];
    const category = ap.category || (x.gate && x.gate.category) || null;
    let status = 'pending';
    if (x.withdrawnAll) status = 'withdrawn';
    else if (x.answer || x.a) status = x.surface === 'expiry' ? 'expired' : (x.answer && x.answer.verdict === 'yes') ? 'approved' : 'denied';
    else if (x.type === 'close' || x.reclassified) status = 'closed';
    out[x.id] = { id: x.id, from: x.from, message: inbox.messageParts(x).message, askedAt: x.askedAt || x.at, category, fixed: isFixed(category), level: ap.level || 'approve',
      params: am ? am.params : ap.params || null, actionDigest: am ? am.actionDigest : ap.actionDigest || null, auditId: ap.auditId || null,
      expiresAt: ap.expiresAt || null, default: 'deny', blocking: !!(ap.blocking || x.blocking && x.approval), dependsOn: ap.dependsOn || [], handoff: ap.handoff || null,
      status, answer: status === 'pending' || status === 'closed' ? null : x.withdrawnAll ? { by: x.withdrawnAll.by, at: x.withdrawnAll.at, why: x.withdrawnAll.why } : { by: x.by, surface: x.surface || 'needs-you', at: x.answeredAt || x.at, a: x.a, appliedBy: x.appliedBy || null },
      reminded: reminded.has(x.id), legacy: !ap.actionDigest, journal: journal[x.id] || null };
  }
  for (const r of Object.values(out)) {
    const hold = r.dependsOn.map(d => out[d]).find(d => d && d.status === 'pending' && d.blocking);
    r.suppressed = r.status === 'pending' && hold ? { by: hold.id } : null;
    r.chatAnswerable = r.status === 'pending' && !r.fixed && !r.legacy && !r.suppressed;
    r.authority = authorityOf(r);
  }
  out._reminders = reminders;
  return out;
}
const strip = r => { if (!r) return r; const o = Object.assign({}, r); delete o.journal; return o; };
function list(o) { const all = records(); delete all._reminders; return Object.values(all).filter(r => (o && o.all) || r.status === 'pending').map(strip); }
function get(id) { const r = records()[id]; return r && id !== '_reminders' ? strip(r) : null; }
/* the dispatcher's hook, a READ: { <asker seat id or name>: [{ id, category, askedAt, dependents, dependentSeats?, handoff? }] }
 * for pending BLOCKING records. dependents are the records it suppresses; dependentSeats their askers' seats (same order). */
function blockingSeats() {
  const out = {}; const all = list();
  for (const r of all) if (r.blocking) {
    const id = askerSeat(r.from) || r.from;
    const deps = all.filter(d => d.suppressed && d.suppressed.by === r.id);
    const e = { id: r.id, category: r.category, askedAt: r.askedAt, dependents: deps.map(d => d.id) };
    if (deps.length) e.dependentSeats = deps.map(d => askerSeat(d.from) || d.from);   // parallel to dependents
    if (r.handoff) e.handoff = r.handoff;
    (out[id] = out[id] || []).push(e);
  }
  return out;
}

/* ---------- the lock (CAS) ---------- */
const LOCK = () => path.join(path.dirname(inbox.FILE()), '.approvals.lock');
const NO_OWNER_STALE_MS = 2e3, MAX_HOLD_MS = 10 * MIN;
const later = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { if (!(Number(pid) > 0)) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lockInfo(dir) {
  let st; try { st = fs.statSync(dir); } catch (_) { return null; }
  let owner = null; try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch (_) {}
  return { owner, ageMs: Date.now() - st.mtimeMs };
}
function staleWhy(info) {
  if (!info) return null;
  const o = info.owner;
  if (!o) return info.ageMs > NO_OWNER_STALE_MS ? 'no owner file after ' + Math.round(info.ageMs) + ' ms' : null;
  if (o.host === os.hostname() && !alive(o.pid)) return 'owner pid ' + o.pid + ' is not running';
  if (Date.now() - Date.parse(o.at || 0) > MAX_HOLD_MS) return 'held for more than 10 min';
  return null;
}
/* take a stale lock over: rename it away (atomic: one taker wins), then check that what was renamed is what was judged
 * stale; if a live holder had taken it in between, put it back. */
function takeOver(lock, info) {
  const aside = lock + '.stale-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try { fs.renameSync(lock, aside); } catch (_) { return false; }   // someone else moved or released it first
  const moved = lockInfo(aside);
  const sameOne = (moved && moved.owner && moved.owner.token) === (info.owner && info.owner.token);
  if (!sameOne && !staleWhy(moved)) { try { fs.renameSync(aside, lock); } catch (_) {} return false; }
  try { fs.rmSync(aside, { recursive: true, force: true }); } catch (_) {}
  return true;
}
async function withLock(fn) {
  const lock = LOCK(); fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = crypto.randomBytes(12).toString('hex'); const until = Date.now() + S.lockWaitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      const tmp = path.join(lock, 'owner.json.' + token); fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() })); fs.renameSync(tmp, path.join(lock, 'owner.json'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = lockInfo(lock);
      if (info && staleWhy(info) && takeOver(lock, info)) continue;
      if (Date.now() > until) throw new Error('approvals are busy; try again');
      await later(5 + Math.floor(Math.random() * 20));
    }
  }
  try { return await fn(); }
  finally {
    const o = (lockInfo(lock) || {}).owner;
    if (o && o.token === token) { const aside = lock + '.done-' + token; try { fs.renameSync(lock, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch (_) {} }
  }
}
// every row is recorded in the provenance log before it is written (lib/pm-inbox-guard.js): readers trust only recorded rows,
// an answer only from the owner's side (the console, the owner's CLI, the dispatcher's tick), an amend only from the asker
const append = (row, o) => require('./lib/pm-inbox-guard').append(inbox.FILE(), row, 'approvals.js', o);
const journal = (id, step, extra) => append(Object.assign({ type: 'approval-journal', id, step, at: new Date(S.now()).toISOString() }, extra || {}));
const refuse = (code, msg, extra) => Object.assign({ ok: false, code, error: msg }, extra || {});

/* ---------- ask: governance first, then (maybe) a record ---------- */
async function ask(o) {
  const from = String(o.from || '').trim(); const category = String(o.category || '').trim();
  const message = String(o.message || '').trim();
  if (!from || !category || !message) return refuse('usage', 'ask needs --from, --category and --message');
  const g = gov.doc(S.govOpts) || {};
  if (!isFixed(category) && !(g.categories && category in g.categories)) return refuse('usage', 'unknown category "' + category + '" (' + Object.keys(g.categories || {}).concat(fixedSet()).join(', ') + ')');
  let params; try { params = canonical(typeof o.params === 'string' ? JSON.parse(o.params) : o.params || {}); } catch (e) { return refuse('usage', '--params: ' + e.message); }
  const summary = message.replace(/\s+/g, ' ').slice(0, 200);
  let lv = isFixed(category) ? 'approve' : gov.level(category, Object.assign({}, S.govOpts, { triage: true }));
  let tri = null;
  if (lv === 'triage') { tri = gov.triage(category, { by: from, summary }, S.govOpts); if (!tri.escalate) lv = 'notify'; }
  if (lv === 'auto' || lv === 'notify') {
    const why = 'self-governance ' + category + ' is at ' + (tri ? 'triage (' + tri.why + ')' : lv) + ', so no owner approval is needed';
    const a = audit(author(from), from + ' goes ahead: ' + summary + ' (' + why + '; params ' + actionDigestOf(category, from, params).slice(0, 19) + '…)');
    let told = null; if (lv === 'notify') told = gov.notify(from + ' decided to ' + summary.replace(/\.$/, '') + '. (Self-governance: ' + category + ' is set to ' + (tri ? 'triage' : 'notify') + ', so this is done without waiting for you; reply if you want it undone.)', S.govOpts);
    return { ok: true, minted: false, level: lv, allowed: true, audit: a.id, told: !!told };
  }
  const actionDigest = actionDigestOf(category, from, params);
  let handoff = null;
  if (o.handoff && o.handoff !== true) {
    const seat = askerSeat(from); const ib = seat && (co.crew()[seat] || {}).inbox;
    if (!ib) return refuse('usage', '--handoff: ' + from + ' has no handoff inbox in loops.json');
    handoff = { inbox: ib, heading: String(o.handoff).replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
  return withLock(async () => {
    const pend = list();
    const dup = pend.find(r => r.actionDigest === actionDigest);
    if (dup) return { ok: true, minted: false, level: 'approve', deduped: true, id: dup.id, actionDigest };
    const P = policy(); const now = S.now();
    const mine = Object.values(inbox.state()).filter(x => x.type === 'ask' && x.approval && sameSeat(x.from, from));
    if (pend.filter(r => sameSeat(r.from, from)).length >= P.maxPendingPerSeat) return refuse('cap', from + ' already has ' + P.maxPendingPerSeat + ' approvals waiting for the owner (approvals-policy maxPendingPerSeat). Wait for an answer, or withdraw one.');
    if (mine.filter(x => now - Date.parse(x.at) < P.windowMin * MIN).length >= P.maxPerWindowPerSeat) return refuse('cap', from + ' asked for ' + P.maxPerWindowPerSeat + ' approvals in the last ' + P.windowMin + ' min (approvals-policy maxPerWindowPerSeat). Batch them into one request.');
    const deps = String(o['depends-on'] || o.dependsOn || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const d of deps) if (!get(d)) return refuse('usage', '--depends-on: no approval ' + d);
    const expMin = Number(o['expires-min'] || o.expiresMin) > 0 ? Number(o['expires-min'] || o.expiresMin) : Number(P.defaultExpiryMin) > 0 ? Number(P.defaultExpiryMin) : null;
    const expiresAt = expMin ? new Date(now + expMin * MIN).toISOString() : null;
    const a = audit(author(from), 'Approval requested by ' + from + ' (' + category + (isFixed(category) ? ', a fixed owner gate' : '') + '): ' + summary + ' (digest ' + actionDigest.slice(0, 19) + '…' + (expiresAt ? '; expires ' + expiresAt.slice(0, 16).replace('T', ' ') + ' UTC, default deny' : '') + ')');
    const approval = { category, level: tri ? 'triage' : 'approve', params, actionDigest, expiresAt, default: 'deny', blocking: !!o.blocking, dependsOn: deps, auditId: a.id, auditBy: author(from) };
    if (handoff) approval.handoff = handoff;
    const r = inbox.ask({ from, about: 'approval:' + category, message, details: o.details, blocking: !!o.blocking, kind: 'approve', oneDecision: true, approval });
    return { ok: true, minted: true, level: 'approve', id: r.row.id, actionDigest, expiresAt, audit: a.id };
  });
}
async function amend(id, o) {
  return withLock(async () => {
    const r = get(id); if (!r || r.legacy) return refuse('missing', 'no approval record ' + id);
    if (r.status !== 'pending') return refuse('closed', id + ' is ' + r.status);
    if (!sameSeat(o.by, r.from)) return refuse('authority', 'only the asker (' + r.from + ') amends ' + id);
    let seat = null; try { seat = inbox.callerSeat({ id, from: r.from }, o.by, 'amend'); } catch (e) { return refuse('authority', e.message); }
    let params; try { params = canonical(typeof o.params === 'string' ? JSON.parse(o.params) : o.params || {}); } catch (e) { return refuse('usage', '--params: ' + e.message); }
    const actionDigest = actionDigestOf(r.category, r.from, params);
    append({ type: 'approval-amend', id, at: new Date(S.now()).toISOString(), by: o.by, params, actionDigest }, seat ? { seat } : undefined);
    return { ok: true, id, actionDigest, was: r.actionDigest };
  });
}
/* withdraw: under the lock (so it never races an answer), inbox.js withdraw (the record leaves Needs you), then the audit
 * withdraw of the request line (decision.js) and the named handoff closed. The asker is woken only when someone else
 * (the owner) withdrew it: the asker already knows its own withdrawal. */
async function withdraw(id, o) {
  o = o || {};
  const res = await withLock(async () => {
    const r = get(id); if (!r) return refuse('missing', 'no approval record ' + id);
    if (r.status !== 'pending') return refuse('closed', id + ' is already ' + r.status + (r.answer ? ' (by ' + r.answer.by + ')' : '') + '. Nothing changed.', { status: r.status });
    try { inbox.withdraw({ id, by: o.by, why: o.why }); } catch (e) { return refuse(e.code === 3 ? 'authority' : 'closed', e.message); }
    journal(id, 'begin', { kind: 'withdraw', by: o.by });
    return { ok: true, r };
  });
  if (!res.ok) return res;
  const fin = finish(id);
  return { ok: true, id, state: 'withdrawn', audit: fin.audit || null, woke: fin.woke || null };
}

/* ---------- answer (CAS) ---------- */
async function answer(id, o) {
  o = o || {};
  const surface = String(o.surface || ''); if (!ANSWER_SURFACES.includes(surface)) return refuse('usage', 'surface must be one of ' + ANSWER_SURFACES.join(', ') + ' (set by the route that received the answer)');
  const v = o.verdict === 'yes' || o.verdict === true ? 'yes' : o.verdict === 'no' || o.verdict === false ? 'no' : null;
  if (!v) return refuse('usage', 'verdict must be yes or no');
  const who = answererOf(o.by);
  if (who.role === 'owner') { if (!S.ownerShell()) return refuse('authority', '"--by ' + String(o.by).trim() + '" for an approval is accepted ' + ownerRule.REASON); }
  else if (who.role) {
    if (o.cli) return refuse('unverified', who.seat.name + ' cannot answer an approval from the command line: a crew --by cannot be verified there (the run transcript lands after the command). The owner answers on Today › Needs you.');
    if (S.crewCaller() !== who.seat.id) return refuse('unverified', 'this caller is not verified as ' + who.seat.name + ', so it cannot answer for ' + who.seat.name);
  }
  await expire({ actor: 'the answer path (' + surface + ')' });
  const res = await withLock(async () => {
    const r = get(id); if (!r) return refuse('missing', 'no approval record ' + id + ' (a chat block cannot create one)');
    if (r.status !== 'pending') return refuse('closed', r.status === 'withdrawn' ? id + ' was withdrawn by ' + r.answer.by + (r.answer.why ? ': ' + r.answer.why : '') : id + ' is already ' + r.status + (r.answer ? ' (by ' + r.answer.by + ' via ' + r.answer.surface + ' at ' + String(r.answer.at).slice(0, 16).replace('T', ' ') + ')' : '') + '. Nothing changed.', { status: r.status, winner: r.answer });
    if (who.seat && who.seat.id === askerSeat(r.from)) return refuse('authority', who.seat.name + ' asked for ' + id + ', so ' + who.seat.name + ' cannot answer it');
    if (!who.role || !r.authority.who.includes(who.role)) return refuse('authority', (o.by || 'nobody') + ' may not answer ' + id + ': ' + r.authority.why);
    if (r.fixed && !FIXED_SURFACES.includes(surface)) return refuse('route', r.authority.why + '. Open Today › Needs you.', { link: '#/today' });
    if (r.legacy && surface !== 'needs-you') return refuse('route', id + ' is an older record with no action digest: answer it on Today › Needs you.', { link: '#/today' });
    if (r.suppressed) return refuse('held', id + ' waits on ' + r.suppressed.by + ': answer that first.');
    if (!r.legacy && o.shownDigest !== r.actionDigest) return refuse('stale', 'what you saw is no longer what ' + id + ' asks: it changed after it was shown (the amount, target or terms). Nothing was approved; look at it again.', { actionDigest: r.actionDigest });
    const row = inbox.state()[id];
    const form = inbox.formOf(row); const act = form.actions.find(a => a.verdict === v) || { id: v === 'yes' ? 'approve' : 'decline' };
    const by = who.role === 'owner' ? 'Commander' : who.seat.name;
    const plain = (v === 'yes' ? 'yes' : 'no') + ' (via ' + surface + (who.role === 'ceo' ? ', by the CEO ' + by : '') + ')';
    journal(id, 'begin', { kind: 'answer', verdict: v, surface, by });   // the journal first: a crash after this is repaired by tick()
    append({ type: 'answer', id, at: new Date(S.now()).toISOString(), a: plain, answer: { verdict: v, action: act.id, values: {} }, by, surface, shownDigest: o.shownDigest || null, answeredAs: who.role });
    return { ok: true, verdict: v, surface, by };
  });
  if (!res.ok) return res;
  const fin = finish(id);
  return { ok: true, id, state: res.verdict === 'yes' ? 'approved' : 'denied', surface: res.surface, audit: fin.audit, woke: fin.woke };
}

/* ---------- after the CAS: audit, wake, handoff — each journalled, each idempotent ---------- */
function decisionsText() { try { return fs.readFileSync(path.join(decision._internals.S.root(), 'company', 'work', 'decisions.md'), 'utf8'); } catch (_) { return ''; } }
function auditFound(id, kind) {
  const re = kind === 'withdraw' ? new RegExp('\\*\\*Withdraws [^\\n]*approval ' + id + ' withdrawn') : new RegExp('Approval ' + id + ' \\([^)]*\\) (approved|denied|expired)');
  const m = decisionsText().split('\n').find(l => re.test(l)); const d = m && m.match(/\[(d-[0-9a-f]{6})\]/); return d ? d[1] : m ? 'found' : null;
}
function wakeFound(id) { try { return (require('./owner-inbox.js').messages() || []).find(m => m.re === id && /inbox\.js answer/.test(m.via || '')) || null; } catch (_) { return null; } }
function closeHandoff(r) {
  const h = r.handoff; if (!h || !/^[A-Za-z0-9_.-]+\.md$/.test(h.inbox || '') || !h.heading) return null;
  const f = co.p('company', 'work', 'handoffs', h.inbox); let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  const parts = txt.split(/^(?=## )/m); let changed = false;
  const out = parts.map(sec => {
    if (changed || !sec.startsWith('## ') || sec.split('\n')[0].slice(3).trim() !== h.heading) return sec;
    const m = sec.match(/^\*\*Status:\*\*\s*OPEN\b.*$/m); if (!m) return sec;
    changed = true; return sec.replace(m[0], '**Status:** DONE — approval ' + r.id + ' ' + r.status + ' (company/tools/approvals.js)');
  }).join('');
  if (!changed) return null;
  fs.writeFileSync(f, out); return h.inbox + ': ' + h.heading;
}
/* finish(id): whatever of audit / wake / handoff this answered, expired or withdrawn record still lacks. Errors here are
 * not swallowed: the journal keeps the missing step, so the next tick() repairs it, and the caller sees the throw. */
function finish(id) {
  const all = records(); const r = all[id]; if (!r || r.status === 'pending') return {};
  const j = r.journal || {}; const kind = (j.begin && j.begin.kind) || (r.status === 'withdrawn' ? 'withdraw' : r.status === 'expired' ? 'expiry' : 'answer');
  const out = {};
  if (!j.audited) {
    let a = auditFound(id, kind);
    if (!a) {
      if (kind === 'withdraw') {
        if (r.auditId) { const by = (inbox.state()[id].approval || {}).auditBy || author(r.from); const w = decision.change('withdraw', r.auditId, { by, why: 'approval ' + id + ' withdrawn by ' + r.answer.by + ': ' + String(r.answer.why || '').slice(0, 200) }); if (w && w.error) throw new Error('audit line not written: ' + w.error); a = w && w.id; }
        else a = 'none';
      } else if (kind === 'expiry') {
        a = audit(S.owner(), 'Approval ' + id + ' (' + r.category + ') expired with no answer: default deny applied by ' + (r.answer.appliedBy || 'the server') + ' (surface: expiry).').id;
      } else {
        const who = r.answer.by === 'Commander' ? S.owner() : r.answer.by;
        a = audit(who, 'Approval ' + id + ' (' + (r.category || 'approval') + ') ' + (r.status === 'approved' ? 'approved' : 'denied') + ' by ' + who + ' (surface: ' + r.answer.surface + (r.actionDigest ? ', digest ' + r.actionDigest.slice(0, 19) + '…' : '') + '): ' + String(r.message || '').replace(/\s+/g, ' ').slice(0, 160)).id;
      }
    }
    journal(id, 'audited', { audit: a }); out.audit = a;
  } else out.audit = j.audited.audit;
  const needWake = kind !== 'withdraw' || !sameSeat(r.answer.by, r.from);
  if (!j.woken && needWake) {
    let w = wakeFound(id);
    if (!w) {
      const plain = kind === 'withdraw' ? 'withdrawn by ' + r.answer.by + (r.answer.why ? ': ' + r.answer.why : '') + '. Nothing was approved.'
        : kind === 'expiry' ? 'no: expired at ' + String(r.expiresAt).slice(0, 16).replace('T', ' ') + ' UTC with no answer, so the default applies (deny)' : r.answer.a;
      w = inbox.deliver(inbox.state()[id], plain);
    }
    journal(id, 'woken', { woke: w.id }); out.woke = w.id;
  } else if (j.woken) out.woke = j.woken.woke;
  if (!j.handoff && r.handoff) { const c = closeHandoff(r); journal(id, 'handoff', { closed: c }); out.handoff = c; }
  return out;
}
/* repair: an answered / expired / withdrawn record whose journal began but shows no audit line or no wake */
function repair() {
  const done = []; const all = records(); delete all._reminders;
  for (const r of Object.values(all)) {
    const j = r.journal; if (!j || !j.begin || r.status === 'pending') continue;
    const wantWake = !(j.begin.kind === 'withdraw' && sameSeat(r.answer && r.answer.by, r.from));
    if (j.audited && (j.woken || !wantWake) && (j.handoff || !r.handoff)) continue;
    finish(r.id); done.push(r.id);
  }
  return done;
}

/* ---------- tick: expiry (server-side), then batched reminders, then repair ---------- */
async function expire(o) {
  const actor = (o && o.actor) || processActor();
  // the default answer is written on the owner's side (the dispatcher's tick, the console): an agent's run never writes an
  // answer row (lib/pm-inbox-guard.js), so it leaves expiry to them
  try { if (require('./provenance.js').underStation()) return []; } catch (_) {}
  const now = S.now(); const done = [];
  const due = list().filter(r => r.expiresAt && Date.parse(r.expiresAt) <= now);
  for (const d of due) {
    const ok = await withLock(async () => {
      const r = get(d.id); if (!r || r.status !== 'pending') return false;
      const plain = 'no: expired at ' + r.expiresAt.slice(0, 16).replace('T', ' ') + ' UTC with no answer, so the default applies (deny)';
      journal(r.id, 'begin', { kind: 'expiry', by: actor });
      append({ type: 'answer', id: r.id, at: new Date(now).toISOString(), a: plain, answer: { verdict: 'no', action: 'decline', values: {} }, by: 'expiry', surface: 'expiry', appliedBy: actor });
      return true;
    });
    if (!ok) continue;
    finish(d.id);
    done.push(d.id);
  }
  return done;
}
async function remind() {
  const P = policy(); const now = S.now(); const step = P.reminderMin * MIN; const win = Math.floor(now / step);
  return withLock(async () => {
    const all = records(); const reminders = all._reminders; delete all._reminders;
    if (reminders.some(x => x.window === win)) return null;   // one batch per window
    const pend = Object.values(all).filter(r => r.status === 'pending' && !r.legacy && !r.suppressed);
    const due = pend.filter(r => !r.reminded && now - Date.parse(r.askedAt) >= step);   // the clock starts at creation
    if (!due.length) return null;
    const t0 = Math.min(...due.map(r => Date.parse(r.askedAt)));
    const batch = pend.filter(r => !r.reminded && (due.includes(r) || Math.abs(Date.parse(r.askedAt) - t0) <= BURST_MS));
    const ids = batch.map(r => r.id);
    append({ type: 'approval-reminder', at: new Date(now).toISOString(), window: win, ids, pending: pend.length });
    const n = pend.length;
    const text = (n === 1 ? 'One approval is' : n + ' approvals are') + ' waiting for you on Today › Needs you (' + ids.join(', ') + (pend.length > ids.length ? ' and ' + (pend.length - ids.length) + ' more' : '') + '). [Open Needs you](console:#/today)';
    let sent = null; try { sent = require('./owner-inbox.js').send({ from: S.nameOf(S.ceo()) || 'company', text }); } catch (_) {}
    return { ids, pending: n, sent: !!sent };
  });
}
async function tick(o) { const expired = await expire(o); const reminded = await remind(); const repaired = repair(); return { expired, reminded, repaired }; }

module.exports = { ask, amend, withdraw, answer, list, get, records, blockingSeats, expire, remind, repair, tick, canonical, digestOf, actionDigestOf, fixedSet, policy, SURFACES, ANSWER_SURFACES, _S: S, _lock: { withLock, LOCK, staleWhy } };

/* ---------------- CLI ---------------- */
function parse(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a); } return o; }
if (require.main === module) {
  const a = parse(process.argv.slice(2)); const cmd = a._[0];
  const out = (r, bad) => { console.log(JSON.stringify(r, null, 1)); process.exit(bad ? 2 : 0); };
  (async () => {
    if (cmd === 'ask') { const r = await ask(a); out(r, !r.ok); }
    else if (cmd === 'amend') { const r = await amend(a._[1], a); out(r, !r.ok); }
    else if (cmd === 'withdraw') { const r = await withdraw(a._[1], a); out(r, !r.ok); }
    // the CLI's surface is always "cli", whatever --surface says
    else if (cmd === 'answer') { const r = await answer(a._[1], { verdict: a.verdict, shownDigest: a.digest, surface: 'cli', by: a.by, cli: true }); out(r, !r.ok); }
    else if (cmd === 'list') out({ ok: true, approvals: list({ all: !!a.all }) });
    else if (cmd === 'get') { const r = get(a._[1]); out(r ? Object.assign({ ok: true }, r) : refuse('missing', 'no approval ' + a._[1]), !r); }
    else if (cmd === 'blocking-seats') out({ ok: true, seats: blockingSeats() });
    else if (cmd === 'tick') out(Object.assign({ ok: true }, await tick({ actor: 'the approvals CLI' })));
    else out(refuse('usage', 'usage: approvals.js ask|amend|withdraw|answer|list|get|blocking-seats|tick'), true);
  })().catch(e => out(refuse('error', e.message), true));
}
