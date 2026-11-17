#!/usr/bin/env node
/* approvals.js — owner approvals as EXISTING owner-question records (company/pm-inbox.jsonl, read through inbox.js):
 * mint one only when governance says the owner must approve, answer it from any surface with compare-and-swap, expire
 * it to its default (deny) server-side, remind in batches. No third store: every row this tool writes is a pm-inbox row
 * (ask with `approval`, approval-amend, answer, approval-reminder); the audit line is company/tools/decision.js add.
 * Docs: docs/CHAT-ACTIONS.md "Approvals in chat".
 *
 *   node company/tools/approvals.js ask --from <seat name> --category <governance category> --message "2-4 sentences"
 *        --params '<json: what exactly is approved>' [--details ".."] [--expires-min N] [--blocking] [--depends-on q-1,q-2]
 *   node company/tools/approvals.js amend <id> --params '<json>' --by <asker>       (a new actionDigest: old answers refused)
 *   node company/tools/approvals.js withdraw <id> --why ".." --by <asker>           (inbox.js withdraw + the audit withdraw)
 *   node company/tools/approvals.js list [--all]  |  get <id>  |  blocking-seats
 *   node company/tools/approvals.js answer <id> --verdict yes|no --digest <shown actionDigest> --surface cli --by <owner|CEO>
 *   node company/tools/approvals.js tick                                            (expire, then remind; the console runs it every minute)
 * Tests: node --test company/tools/tests/approvals.test.js (scripts/test.sh runs it).
 *
 * GOVERNANCE FIRST (lib/governance.js level(), with triage): `auto` acts and logs (a decisions.md line, no record);
 * `notify` acts, logs and tells (one owner-channel sentence via governance notify; no record, not in the badge, never
 * reminded); `triage` runs the gate-triage model and mints only when it escalates; `approve` and every FIXED owner gate
 * (governance.json `fixed`, the single source; gate-triage's fixed-gate rule must list the same set) mint a record.
 *
 * A RECORD: an inbox.js ask (kind approve) with row.approval = {category, params (canonical), actionDigest (sha256 over
 * the canonical {category, from, params}, computed here at creation and authoritative), expiresAt|null, default 'deny',
 * blocking, dependsOn}. An amend row replaces params and actionDigest. A record with no actionDigest (an older gate
 * question) is answerable only from Needs you, never from chat. No expiresAt = no expiry.
 *
 * ANSWER (CAS under a lock beside pm-inbox.jsonl): refused unless the record is pending, shownDigest equals the current
 * actionDigest, the answerer has the authority (a fixed gate: the owner only; any other category: the owner or the CEO;
 * never the asking seat), and the surface may answer it (chat: never a fixed gate, never a record with no digest). The
 * winner writes ONE answer row {surface, shownDigest, by}, ONE decisions.md line (decision.js add, naming the surface),
 * and wakes the asker through the owner-message path (inbox.js deliver: re <id>, opening with the asker's name). The
 * loser gets "already answered by X via <surface> at T" and writes nothing.
 * EXPIRY (tick, server-side): a pending record past expiresAt gets the default — an answer row verdict no, surface
 * expiry — the audit line, and the asker is told. REMINDERS (tick): a record is due 15 min after it was CREATED; due
 * records, plus any minted in the same burst (within 60 s of the earliest due one), go out as one batch per 15-minute
 * window: one approval-reminder row and one owner-channel line with the pending count. Each record is reminded once.
 * DEPENDENTS: a record whose dependsOn names a pending blocking record is suppressed (not reminded, not answerable)
 * until that record is answered, expires or is withdrawn. The dispatcher's hook is a READ: blockingSeats().
 * ANTI-SPAM: per-seat caps from company/defaults/state/approvals-policy.json (company/state/ overrides); an ask whose
 * actionDigest matches a pending record returns that record instead of minting a second one.
 * This tool runs no other tool and no command: decision.js, inbox.js and governance are required in process.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const inbox = require('./inbox.js');
const gov = require('./lib/governance');
const decision = require('./decision.js');

// seams for the selftest (and nothing else)
const S = { now: () => Date.now(), govOpts: {}, ceo: () => co.ceo(), nameOf: id => co.nameOf(id), owner: () => (co.config.owner && co.config.owner.name) || 'Owner' };
if (process.env.APPROVALS_DECISIONS_ROOT) decision._internals.S.root = () => process.env.APPROVALS_DECISIONS_ROOT;   // tests only
if (process.env.APPROVALS_GOV_ROOT) S.govOpts = { root: process.env.APPROVALS_GOV_ROOT };                           // tests only

const SURFACES = ['chat', 'needs-you', 'console', 'cli'];
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

/* ---------- people ---------- */
const low = s => String(s || '').trim().toLowerCase();
const first = s => low(s).split(/\s+/)[0];
function roleOf(by) {
  const b = low(by); if (!b) return null;
  if (b === 'owner' || b === 'commander' || b === low(S.owner())) return 'owner';
  const ceo = S.ceo(); if (ceo && (b === low(ceo) || b === low(S.nameOf(ceo)) || b === first(S.nameOf(ceo)))) return 'ceo';
  return 'other';
}
const sameSeat = (a, b) => !!low(a) && (low(a) === low(b) || first(a) === first(b));
/* the decisions.md author for a seat: its crew name, else the CEO (decision.js only takes crew or owner) */
function author(name) {
  const crew = co.crew(); const hit = Object.entries(crew).find(([id, c]) => c && (sameSeat(c.name, name) || low(id) === low(name)));
  return hit ? hit[1].name : S.nameOf(S.ceo()) || S.owner();
}
function audit(by, text) { const r = decision.add({ by, text }); if (r && r.error) throw new Error('audit line not written: ' + r.error); return r; }

/* ---------- reading the records ---------- */
const rows = () => inbox.readAll();
function records() {
  const st = inbox.state(); const all = rows();
  const amends = {}, reminded = new Set(), reminders = [];
  for (const r of all) {
    if (r.type === 'approval-amend' && r.id) amends[r.id] = r;
    if (r.type === 'approval-reminder') { reminders.push(r); for (const id of r.ids || []) reminded.add(id); }
  }
  const out = {};
  for (const x of Object.values(st)) {
    if (!x.askedAt || !(x.approval || x.gate)) continue;   // an ask row (state() merges later rows onto it)
    const ap = x.approval || {}; const am = amends[x.id];
    const category = ap.category || (x.gate && x.gate.category) || null;
    let status = 'pending';
    if (x.withdrawnAll) status = 'withdrawn';
    else if (x.answer || x.a) status = x.surface === 'expiry' ? 'expired' : (x.answer && x.answer.verdict === 'yes') ? 'approved' : 'denied';
    out[x.id] = { id: x.id, from: x.from, message: inbox.messageParts(x).message, askedAt: x.askedAt || x.at, category, fixed: isFixed(category),
      params: am ? am.params : ap.params || null, actionDigest: am ? am.actionDigest : ap.actionDigest || null, auditId: ap.auditId || null,
      expiresAt: ap.expiresAt || null, default: 'deny', blocking: !!(ap.blocking || x.blocking && x.approval), dependsOn: ap.dependsOn || [],
      status, answer: status === 'pending' ? null : x.withdrawnAll ? { by: x.withdrawnAll.by, at: x.withdrawnAll.at, why: x.withdrawnAll.why } : { by: x.by, surface: x.surface || 'needs-you', at: x.answeredAt || x.at, a: x.a },
      reminded: reminded.has(x.id), legacy: !ap.actionDigest };
  }
  for (const r of Object.values(out)) {
    const hold = r.dependsOn.map(d => out[d]).find(d => d && d.status === 'pending' && d.blocking);
    r.suppressed = r.status === 'pending' && hold ? { by: hold.id } : null;
    r.chatAnswerable = r.status === 'pending' && !r.fixed && !r.legacy && !r.suppressed;
    r.authority = r.fixed ? { who: ['owner'], why: r.category + ' is a fixed owner gate (governance.json fixed): only the owner decides it, on Today › Needs you' } : { who: ['owner', 'ceo'], why: 'self-governance ' + (r.category || 'approval') + ': the owner or the CEO; never the asker' };
  }
  out._reminders = reminders;
  return out;
}
function list(o) { const all = records(); delete all._reminders; return Object.values(all).filter(r => (o && o.all) || r.status === 'pending'); }
function get(id) { const r = records()[id]; return r && id !== '_reminders' ? r : null; }
/* the dispatcher's hook, a READ: { <asker seat id or name>: [{ id, category, askedAt }] } for pending BLOCKING records */
function blockingSeats() {
  const crew = co.crew(); const out = {};
  for (const r of list()) if (r.blocking) {
    const id = (Object.entries(crew).find(([k, c]) => c && (sameSeat(c.name, r.from) || low(k) === low(r.from))) || [r.from])[0];
    (out[id] = out[id] || []).push({ id: r.id, category: r.category, askedAt: r.askedAt, dependents: list().filter(d => d.suppressed && d.suppressed.by === r.id).map(d => d.id) });
  }
  return out;
}

/* ---------- the lock (CAS) ---------- */
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(fn) {
  const lock = path.join(path.dirname(inbox.FILE()), '.approvals.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30e3) { fs.rmdirSync(lock); continue; } } catch (_) {}
      if (i > 400) throw new Error('approvals are busy; try again');
      sleep(10 + Math.floor(Math.random() * 15));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch (_) {} }
}
const append = row => { fs.mkdirSync(path.dirname(inbox.FILE()), { recursive: true }); fs.appendFileSync(inbox.FILE(), JSON.stringify(row) + '\n'); };
const refuse = (code, msg, extra) => Object.assign({ ok: false, code, error: msg }, extra || {});

/* ---------- ask: governance first, then (maybe) a record ---------- */
function ask(o) {
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
  return withLock(() => {
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
    const approval = { category, params, actionDigest, expiresAt, default: 'deny', blocking: !!o.blocking, dependsOn: deps, auditId: a.id, auditBy: author(from) };
    const r = inbox.ask({ from, about: 'approval:' + category, message, details: o.details, blocking: !!o.blocking, kind: 'approve', oneDecision: true, approval });
    return { ok: true, minted: true, level: 'approve', id: r.row.id, actionDigest, expiresAt, audit: a.id };
  });
}
function amend(id, o) {
  return withLock(() => {
    const r = get(id); if (!r || r.legacy) return refuse('missing', 'no approval record ' + id);
    if (r.status !== 'pending') return refuse('closed', id + ' is ' + r.status);
    if (!sameSeat(o.by, r.from)) return refuse('authority', 'only the asker (' + r.from + ') amends ' + id);
    let params; try { params = canonical(typeof o.params === 'string' ? JSON.parse(o.params) : o.params || {}); } catch (e) { return refuse('usage', '--params: ' + e.message); }
    const actionDigest = actionDigestOf(r.category, r.from, params);
    append({ type: 'approval-amend', id, at: new Date(S.now()).toISOString(), by: o.by, params, actionDigest });
    return { ok: true, id, actionDigest, was: r.actionDigest };
  });
}
/* withdraw: inbox.js withdraw (the record leaves Needs you), then the audit withdraw of the request line (decision.js) */
function withdraw(id, o) {
  const r = get(id); if (!r) return refuse('missing', 'no approval record ' + id);
  try { inbox.withdraw({ id, by: o.by, why: o.why }); } catch (e) { return refuse(e.code === 3 ? 'authority' : 'closed', e.message); }
  let w = null;
  if (r.auditId) { const by = (inbox.state()[id].approval || {}).auditBy || author(r.from); w = decision.change('withdraw', r.auditId, { by, why: 'approval ' + id + ' withdrawn by ' + o.by + ': ' + String(o.why || '').slice(0, 200) }); }
  return { ok: true, id, state: 'withdrawn', audit: w && w.id };
}

/* ---------- answer (CAS) ---------- */
function answer(id, o) {
  o = o || {};
  const surface = String(o.surface || ''); if (!SURFACES.includes(surface)) return refuse('usage', 'surface must be one of ' + SURFACES.join(', '));
  const v = o.verdict === 'yes' || o.verdict === true ? 'yes' : o.verdict === 'no' || o.verdict === false ? 'no' : null;
  if (!v) return refuse('usage', 'verdict must be yes or no');
  expire();
  const res = withLock(() => {
    const r = get(id); if (!r) return refuse('missing', 'no approval record ' + id + ' (a chat block cannot create one)');
    if (r.status !== 'pending') return refuse('closed', r.status === 'withdrawn' ? id + ' was withdrawn by ' + r.answer.by + (r.answer.why ? ': ' + r.answer.why : '') : id + ' is already ' + r.status + (r.answer ? ' (by ' + r.answer.by + ' via ' + r.answer.surface + ' at ' + String(r.answer.at).slice(0, 16).replace('T', ' ') + ')' : '') + '. Nothing changed.', { status: r.status, winner: r.answer });
    const role = roleOf(o.by);
    if (sameSeat(o.by, r.from) && role !== 'owner') return refuse('authority', o.by + ' asked for ' + id + ', so ' + o.by + ' cannot answer it');
    if (!role || !r.authority.who.includes(role)) return refuse('authority', (o.by || 'nobody') + ' may not answer ' + id + ': ' + r.authority.why);
    if (surface === 'chat' && r.fixed) return refuse('route', r.authority.why + '. Open Today › Needs you.', { link: '#/today' });
    if (surface === 'chat' && r.legacy) return refuse('route', id + ' is an older record with no action digest: answer it on Today › Needs you.', { link: '#/today' });
    if (r.suppressed) return refuse('held', id + ' waits on ' + r.suppressed.by + ': answer that first.');
    if (!r.legacy && o.shownDigest !== r.actionDigest) return refuse('stale', 'what you saw is no longer what ' + id + ' asks: it changed after it was shown (the amount, target or terms). Nothing was approved; look at it again.', { actionDigest: r.actionDigest });
    const row = inbox.state()[id];
    const form = inbox.formOf(row); const act = form.actions.find(a => a.verdict === v) || { id: v === 'yes' ? 'approve' : 'decline' };
    const by = role === 'owner' ? 'Commander' : S.nameOf(S.ceo());
    const plain = (v === 'yes' ? 'yes' : 'no') + ' (via ' + surface + (role === 'ceo' ? ', by the CEO ' + by : '') + ')';
    append({ type: 'answer', id, at: new Date(S.now()).toISOString(), a: plain, answer: { verdict: v, action: act.id, values: {} }, by, surface, shownDigest: o.shownDigest || null, answeredAs: role });
    return { ok: true, id, verdict: v, surface, by, r, row, plain };
  });
  if (!res.ok) return res;
  const who = res.by === 'Commander' ? S.owner() : res.by;
  const line = audit(who, 'Approval ' + id + ' (' + (res.r.category || 'approval') + ') ' + (res.verdict === 'yes' ? 'approved' : 'denied') + ' by ' + who + ' (surface: ' + res.surface + (res.r.actionDigest ? ', digest ' + res.r.actionDigest.slice(0, 19) + '…' : '') + '): ' + String(res.r.message || '').replace(/\s+/g, ' ').slice(0, 160));
  let woke = null; try { woke = inbox.deliver(res.row, res.plain).id; } catch (_) {}
  return { ok: true, id, state: res.verdict === 'yes' ? 'approved' : 'denied', surface: res.surface, audit: line.id, woke };
}

/* ---------- tick: expiry (server-side), then batched reminders ---------- */
function expire() {
  const now = S.now(); const done = [];
  const due = list().filter(r => r.expiresAt && Date.parse(r.expiresAt) <= now);
  for (const d of due) {
    const res = withLock(() => {
      const r = get(d.id); if (!r || r.status !== 'pending') return null;
      const plain = 'no: expired at ' + r.expiresAt.slice(0, 16).replace('T', ' ') + ' UTC with no answer, so the default applies (deny)';
      append({ type: 'answer', id: r.id, at: new Date(now).toISOString(), a: plain, answer: { verdict: 'no', action: 'decline', values: {} }, by: 'expiry', surface: 'expiry' });
      return { r, plain, row: inbox.state()[r.id] };
    });
    if (!res) continue;
    try { audit(S.owner(), 'Approval ' + res.r.id + ' (' + res.r.category + ') expired with no answer: default deny applied by the console (surface: expiry).'); } catch (_) {}
    try { inbox.deliver(res.row, res.plain); } catch (_) {}
    done.push(res.r.id);
  }
  return done;
}
function remind() {
  const P = policy(); const now = S.now(); const step = P.reminderMin * MIN; const win = Math.floor(now / step);
  return withLock(() => {
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
function tick() { return { expired: expire(), reminded: remind() }; }

module.exports = { ask, amend, withdraw, answer, list, get, records, blockingSeats, expire, remind, tick, canonical, digestOf, actionDigestOf, fixedSet, policy, SURFACES, _S: S };

/* ---------------- CLI ---------------- */
function parse(argv) { const o = { _: [] }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); o[k] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else o._.push(a); } return o; }
if (require.main === module) {
  const a = parse(process.argv.slice(2)); const cmd = a._[0];
  const out = (r, bad) => { console.log(JSON.stringify(r, null, 1)); process.exit(bad ? 2 : 0); };
  if (cmd === 'ask') { const r = ask(a); out(r, !r.ok); }
  else if (cmd === 'amend') { const r = amend(a._[1], a); out(r, !r.ok); }
  else if (cmd === 'withdraw') { const r = withdraw(a._[1], a); out(r, !r.ok); }
  else if (cmd === 'answer') { const r = answer(a._[1], { verdict: a.verdict, shownDigest: a.digest, surface: a.surface, by: a.by }); out(r, !r.ok); }
  else if (cmd === 'list') out({ ok: true, approvals: list({ all: !!a.all }) });
  else if (cmd === 'get') { const r = get(a._[1]); out(r ? Object.assign({ ok: true }, r) : refuse('missing', 'no approval ' + a._[1]), !r); }
  else if (cmd === 'blocking-seats') out({ ok: true, seats: blockingSeats() });
  else if (cmd === 'tick') out(Object.assign({ ok: true }, tick()));
  else out(refuse('usage', 'usage: approvals.js ask|amend|withdraw|answer|list|get|blocking-seats|tick'), true);
}
