#!/usr/bin/env node
/* delegation.js — while the owner is away, someone they name answers some of their approval questions for them.
 *
 *   node company/tools/delegation.js grant --to <seat|person> --categories a,b --until <ISO, at most 14 days> --by <owner> [--why "..."]
 *   node company/tools/delegation.js revoke <dg-id> --by <owner> [--why "..."]
 *   node company/tools/delegation.js list [--json]                       active and past delegations
 *   node company/tools/delegation.js answer <q-id> --by <delegate> --a "yes ..."   the delegate answers one gate question
 *   node company/tools/delegation.js register                            write the locked-watch entries (company/state/locked-extra.json)
 *   node company/tools/delegation.js selftest
 *
 * While a delegation is active, lib/governance.js treats the delegate's answer to an approve/triage question in those
 * self-governance categories as the owner's answer, recorded as "delegate X for owner". Rules:
 *   - only the owner grants or revokes, from their own shell (never inside an agent's station run); never to themselves;
 *   - never for the four fixed owner gates (access, ownership, commitment, spendBeyondCap), never for packs, guardrails
 *     or governance itself; only for categories in company/state/governance.json;
 *   - expires hard at --until (at most 14 days out); revoke ends it at once;
 *   - a delegate never answers a question they raised themselves; an owner answer always wins over a delegate's;
 *   - every answer is a row in company/state/delegations-log.jsonl, a line in company/work/decisions.md, and one
 *     sentence to the owner (owner-inbox.js send).
 * State: company/state/delegations.json (class A, writer delegation.js) + company/state/delegations-log.jsonl (append),
 * both registered in company/state/locked-extra.json (source delegation.js). Exit: 0 ok, 2 usage/refused, 3 not allowed.
 * Owner of this tool: the CEO function; the delegations themselves: the owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');

const MAX_DAYS = 14;
const NEVER = ['access', 'ownership', 'commitment', 'spendBeyondCap', 'packs', 'guardrails', 'governance'];
const rootOf = opts => path.resolve((opts && opts.root) || process.env.DELEGATION_ROOT || co.ROOT);
const files = opts => { const r = rootOf(opts); return { root: r, state: path.join(r, 'company', 'state', 'delegations.json'), log: path.join(r, 'company', 'state', 'delegations-log.jsonl'),
  lockedExtra: path.join(r, 'company', 'state', 'locked-extra.json'), decisions: path.join(r, 'company', 'work', 'decisions.md') }; };
const gov = () => require('./lib/governance');
const norm = s => String(s == null ? '' : s).trim().toLowerCase();
function prov(file, text, kind) { try { require('./provenance.js')[kind || 'wrote'](file, text, 'delegation.js'); } catch (_) {} }
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, file); prov(file, text); }
function append(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text); prov(file, text, 'appended'); }
function underStation() { if (process.env.DELEGATION_ASSUME_AGENT === '1') return true; try { return require('./provenance.js').underStation(); } catch (_) { return false; } }
function load(opts) { const s = co.readJson(files(opts).state, null) || {}; s.delegations = Array.isArray(s.delegations) ? s.delegations : []; return s; }
function save(s, opts) {
  s._doc = 'Owner delegations: while one is active, its delegate answers the owner\'s approve/triage questions in its categories. Written only by company/tools/delegation.js grant|revoke --by <owner>; watched by locked-watch.js (company/state/locked-extra.json).';
  writeAtomic(files(opts).state, JSON.stringify(s, null, 2) + '\n');
  register(opts);
}
function logRow(row, opts) { append(files(opts).log, JSON.stringify(row) + '\n'); }
function decisionsLine(text, opts) {
  const f = files(opts); if (!fs.existsSync(f.decisions)) append(f.decisions, '# Decisions\n\n');
  const lp = co.localParts(new Date()); append(f.decisions, '- ' + lp.date + ' ' + lp.time + ' ' + text + ' (company/tools/delegation.js)\n');
}
function ownerRefusal(by) {
  if (!gov().isOwnerName(by)) return 'only the owner grants or revokes a delegation: --by must be "' + ((co.config.owner && co.config.owner.name) || 'Owner') + '" or "owner"';
  if (underStation()) return 'this runs inside an agent\'s station run: only the owner, from their own shell, delegates';
  if (!require('./lib/owner').shell()) return 'only the owner delegates, ' + require('./lib/owner').REASON;
  return null;
}
const isActive = (d, at) => { const t = at == null ? Date.now() : at; return Date.parse(d.at) <= t && t < Date.parse(d.until) && !(d.revokedAt && Date.parse(d.revokedAt) <= t); };
function allowedCategories(opts) {
  const g = gov().doc({ root: rootOf(opts) }) || {};
  const fixed = Object.keys(g.fixed || {});
  return Object.keys(g.categories || {}).filter(c => !NEVER.includes(c) && !fixed.includes(c));
}

function grant(o, opts) {
  o = o || {};
  const why = ownerRefusal(o.by); if (why) return { ok: false, code: 3, error: why };
  const to = String(o.to || '').trim();
  if (!to) return { ok: false, code: 2, error: '--to <seat|person> is required' };
  if (gov().isOwnerName(to) || norm(to) === norm(o.by)) return { ok: false, code: 2, error: 'a delegation is never to the owner themselves' };
  const cats = String(o.categories || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!cats.length) return { ok: false, code: 2, error: '--categories a,b is required' };
  const never = cats.filter(c => NEVER.includes(c)); if (never.length) return { ok: false, code: 2, error: 'never delegated: ' + never.join(', ') + ' (the fixed owner gates, packs, guardrails and governance stay the owner\'s)' };
  const ok = allowedCategories(opts); const bad = cats.filter(c => !ok.includes(c));
  if (bad.length) return { ok: false, code: 2, error: 'not a delegable self-governance category: ' + bad.join(', ') + '; one of ' + ok.join(', ') };
  const until = Date.parse(o.until || ''); const now = Date.now();
  if (!Number.isFinite(until)) return { ok: false, code: 2, error: '--until <ISO date-time> is required' };
  if (until <= now) return { ok: false, code: 2, error: '--until is in the past' };
  if (until > now + MAX_DAYS * 86400000) return { ok: false, code: 2, error: '--until is more than ' + MAX_DAYS + ' days out' };
  const s = load(opts);
  let n = s.delegations.length + 1; let id; do { id = 'dg-' + String(n++).padStart(3, '0'); } while (s.delegations.some(d => d.id === id));
  const d = { id, to, categories: cats, at: new Date(now).toISOString(), until: new Date(until).toISOString(), by: o.by, why: o.why ? String(o.why).slice(0, 300) : undefined };
  s.delegations.push(d); save(s, opts);
  logRow(Object.assign({ op: 'grant' }, d), opts);
  decisionsLine(o.by + ' (owner) delegated ' + cats.join(', ') + ' questions to ' + to + ' until ' + d.until + ' (' + id + ')', opts);
  return { ok: true, delegation: d };
}
function revoke(id, o, opts) {
  o = o || {};
  const why = ownerRefusal(o.by); if (why) return { ok: false, code: 3, error: why };
  const s = load(opts); const d = s.delegations.find(x => x.id === id);
  if (!d) return { ok: false, code: 2, error: 'no delegation ' + id };
  if (d.revokedAt) return { ok: true, already: true, delegation: d };
  d.revokedAt = new Date().toISOString(); d.revokedBy = o.by; if (o.why) d.revokedWhy = String(o.why).slice(0, 300);
  save(s, opts); logRow({ op: 'revoke', id, at: d.revokedAt, by: o.by, why: d.revokedWhy }, opts);
  decisionsLine(o.by + ' (owner) revoked delegation ' + id + ' (' + d.to + ')', opts);
  return { ok: true, delegation: d };
}
function list(opts) { const now = Date.now(); return load(opts).delegations.map(d => Object.assign({}, d, { active: isActive(d, now) })); }
function rows(opts) { return gov().readLines(files(opts).log); }

/* Is `answer` (a log row) valid for gate question q under some delegation? -> the delegation or a reason */
function check(q, by, at, opts) {
  const cat = q && q.gate && q.gate.category;
  if (!cat) return { why: 'not a self-governance question' };
  if (NEVER.includes(cat) || !allowedCategories(opts).includes(cat)) return { why: cat + ' is never delegated' };
  if (q.gate.by && norm(q.gate.by) === norm(by)) return { why: 'a delegate does not answer a question they raised' };
  const d = load(opts).delegations.find(x => norm(x.to) === norm(by) && (x.categories || []).includes(cat) && isActive(x, at));
  return d ? { delegation: d } : { why: 'no active delegation from the owner to ' + by + ' for ' + cat };
}
/* the owner's line: who answered what kind of question for them, until when, and where to take the permission back
 * (Settings › Autonomy › Permission to answer for you); the question id, the answer and the delegation id are technical */
const KIND_WORDS = { hiring: 'a hiring', release: 'a question about letting someone go', budget: 'a budget', spend: 'a spending', models: 'a question about which AI the crew uses', tools: 'a question about the crew\'s tools',
  schedules: 'a timing', external: 'a question about acting outside the company', dashboard: 'a question about the console', deps: 'a software', org: 'a question about how the team is organised', profiles: 'a question about a crew member\'s profile' };
function answeredNotice(by, category, until) {
  const kind = KIND_WORDS[category] || 'one'; const q = /question/.test(kind) ? kind : kind + ' question';
  let day = String(until || '').slice(0, 10); try { day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: co.TZ || undefined }).format(new Date(until)); } catch (_) {}
  return { text: by + ' answered ' + q + ' for you, using the permission you gave them until ' + day + '. You can take that permission back in Settings › Autonomy.' };
}
function answer(qid, o, opts) {
  o = o || {};
  const by = String(o.by || '').trim(); const text = String(o.a || '').trim();
  if (!by || !text) return { ok: false, code: 2, error: 'answer <q-id> --by <delegate> --a "yes ..." ' };
  if (gov().isOwnerName(by)) return { ok: false, code: 2, error: 'the owner answers with company/tools/inbox.js answer' };
  const G = gov(); const gopts = { root: rootOf(opts) };
  const q = G.gateAsks(gopts).find(r => r.id === qid); if (!q) return { ok: false, code: 2, error: 'no self-governance question ' + qid };
  if (G.answerOf(qid, gopts)) return { ok: false, code: 2, error: qid + ' is already answered' };
  if (G.verdict(text) === null) return { ok: false, code: 2, error: 'start the answer with yes or no' };
  const c = check(q, by, Date.now(), opts); if (!c.delegation) return { ok: false, code: 3, error: c.why };
  const row = { op: 'answer', id: qid, at: new Date().toISOString(), by, a: text.slice(0, 500), delegation: c.delegation.id, category: q.gate.category, ref: q.gate.ref };
  logRow(row, opts);
  decisionsLine(by + ' (delegate ' + c.delegation.id + ' for the owner) answered ' + qid + ' (' + q.gate.category + ': ' + String(q.gate.summary || q.gate.ref).slice(0, 120) + '): ' + text.slice(0, 120), opts);
  let told = null;
  try { const n = answeredNotice(by, q.gate.category, c.delegation.until); told = G.notify(n.text, Object.assign({}, gopts, { technical: by + ' answered ' + qid + ' for you (' + q.gate.category + ': ' + String(q.gate.summary || q.gate.ref).slice(0, 160) + '): "' + text.slice(0, 200) + '". Delegation ' + c.delegation.id + ' until ' + c.delegation.until + '.' })); } catch (_) {}
  return { ok: true, answer: row, ownerTold: !!told };
}
/* Read side for lib/governance.answerOf: the delegate's answer to q, if one was valid when given. */
function answerFor(q, opts) {
  const as = rows(opts).filter(r => r.op === 'answer' && r.id === q.id);
  for (let i = as.length - 1; i >= 0; i--) {
    const a = as[i]; const c = check(q, a.by, Date.parse(a.at), opts);
    if (c.delegation && c.delegation.id === a.delegation) return { text: String(a.a), via: 'delegate', by: a.by, delegationId: a.delegation };
  }
  return null;
}

const LOCKED = [
  { p: 'company/state/delegations.json', cls: 'A', writers: ['delegation.js'], owner: 'ceo', area: 'policy', why: 'who answers the owner\'s approval questions while the owner is away, for which categories, until when' },
  { p: 'company/state/delegations-log.jsonl', cls: 'A', append: true, writers: ['delegation.js'], owner: 'ceo', area: 'record', why: 'every grant, revoke and delegate answer' },
];
function register(opts) {
  const f = files(opts); const cur = co.readJson(f.lockedExtra, null) || {};
  const mine = LOCKED.map(e => Object.assign({}, e, { source: 'delegation.js' }));
  const next = Object.assign({}, cur, { entries: (cur.entries || []).filter(e => e.source !== 'delegation.js').concat(mine) });
  const text = JSON.stringify(next, null, 2) + '\n';
  let before = null; try { before = fs.readFileSync(f.lockedExtra, 'utf8'); } catch (_) {}
  if (before === text) return { ok: true, unchanged: true, entries: mine.length };
  writeAtomic(f.lockedExtra, text);
  return { ok: true, entries: mine.length };
}

function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-selftest-'));
  const env = { PROVENANCE_ROOT: process.env.PROVENANCE_ROOT, DELEGATION_ASSUME_AGENT: process.env.DELEGATION_ASSUME_AGENT };
  process.env.PROVENANCE_ROOT = T; delete process.env.DELEGATION_ASSUME_AGENT;
  const opts = { root: T }; const G = require('./lib/governance');
  const out = []; let bad = 0;
  const t = (n, fn) => { try { fn(); out.push('ok   ' + n); } catch (e) { bad++; out.push('FAIL ' + n + ': ' + e.message); } };
  const gdir = path.join(T, 'company', 'state'); fs.mkdirSync(gdir, { recursive: true });
  const g = co.readJson(co.p('company', 'defaults', 'state', 'governance.json'), {});
  g.categories.hiring = 'approve'; g.categories.spend = 'approve'; fs.writeFileSync(path.join(gdir, 'governance.json'), JSON.stringify(g));
  const inDays = d => new Date(Date.now() + d * 86400000).toISOString();
  const gov = (cat, o) => G.decide(cat, o, Object.assign({ guards: { ownerGates: true } }, opts));
  t('only the owner grants; never to the owner; never fixed gates, packs, guardrails or governance; max 14 days', () => {
    assert.strictEqual(grant({ to: 'Pat', categories: 'spend', until: inDays(3), by: 'Sam' }, opts).code, 3);
    process.env.DELEGATION_ASSUME_AGENT = '1'; assert.strictEqual(grant({ to: 'Pat', categories: 'spend', until: inDays(3), by: 'owner' }, opts).code, 3); delete process.env.DELEGATION_ASSUME_AGENT;
    assert.strictEqual(grant({ to: 'owner', categories: 'spend', until: inDays(3), by: 'owner' }, opts).code, 2);
    for (const c of ['access', 'packs', 'guardrails', 'governance', 'commitment', 'spendBeyondCap', 'nope']) assert.strictEqual(grant({ to: 'Pat', categories: 'spend,' + c, until: inDays(3), by: 'owner' }, opts).code, 2, c);
    assert.strictEqual(grant({ to: 'Pat', categories: 'spend', until: inDays(15), by: 'owner' }, opts).code, 2);
    assert.strictEqual(grant({ to: 'Pat', categories: 'spend', until: inDays(-1), by: 'owner' }, opts).code, 2);
    assert.ok(!fs.existsSync(files(opts).state));
  });
  let dg;
  t('grant: stored, logged, locked-extra registered in the pack.js entry shape', () => {
    const r = grant({ to: 'Pat', categories: 'spend,hiring', until: inDays(7), by: 'owner', why: 'away a week' }, opts); assert.ok(r.ok, r.error); dg = r.delegation;
    assert.ok(list(opts)[0].active);
    const le = co.readJson(files(opts).lockedExtra, {}); assert.ok(le.entries.some(e => e.p === 'company/state/delegations.json' && e.cls === 'A' && e.writers.includes('delegation.js') && e.owner && e.area && e.why));
    assert.ok(/delegated spend, hiring questions to Pat/.test(fs.readFileSync(files(opts).decisions, 'utf8')));
  });
  t('a delegate yes counts as the owner\'s: "delegate Pat for owner"; the owner is told; logged', () => {
    const o = { by: 'Sam', summary: 'buy a domain', ref: 'spend:domain-1' };
    const d1 = gov('spend', o); assert.strictEqual(d1.allowed, false);
    const r = answer(d1.questionId, { by: 'Pat', a: 'yes, go' }, opts); assert.ok(r.ok && r.ownerTold, JSON.stringify(r));
    const d2 = gov('spend', o); assert.ok(d2.allowed); assert.strictEqual(d2.approvedBy, 'delegate Pat for owner');
    const sent = fs.readFileSync(path.join(T, 'company', 'owner', 'digest.jsonl'), 'utf8');   // an FYI (lib/owner-notice.js) assert.ok(/Pat answered q-\d+ for you/.test(sent));
    assert.ok(rows(opts).some(x => x.op === 'answer' && x.delegation === dg.id));
    assert.strictEqual(answer(d1.questionId, { by: 'Pat', a: 'no' }, opts).code, 2);   // already answered
  });
  t('refused: a category outside the grant, the delegate\'s own question, someone else, an owner answer wins', () => {
    const b = gov('budget', { by: 'Sam', summary: 'raise the cap', ref: 'budget:1' }); assert.strictEqual(answer(b.questionId, { by: 'Pat', a: 'yes' }, opts).code, 3);
    const own = gov('spend', { by: 'Pat', summary: 'Pat buys a tool', ref: 'spend:pat' }); assert.strictEqual(answer(own.questionId, { by: 'Pat', a: 'yes' }, opts).code, 3);
    const x = gov('spend', { by: 'Sam', summary: 'x', ref: 'spend:x' }); assert.strictEqual(answer(x.questionId, { by: 'Lee', a: 'yes' }, opts).code, 3);
    require('./lib/pm-inbox-guard').append(path.join(T, 'company', 'pm-inbox.jsonl'), { type: 'answer', id: x.questionId, a: 'no', by: 'Commander', at: new Date().toISOString() }, 'selftest');
    assert.strictEqual(answer(x.questionId, { by: 'Pat', a: 'yes' }, opts).code, 2);
    assert.ok(gov('spend', { by: 'Sam', summary: 'x', ref: 'spend:x' }).denied);
  });
  t('revoke ends it at once; an expired or revoked delegation does not count, even for an answer row written by hand', () => {
    const h = gov('hiring', { by: 'Sam', summary: 'hire Kim', ref: 'hiring:kim' });
    assert.ok(revoke(dg.id, { by: 'owner' }, opts).ok);
    assert.strictEqual(answer(h.questionId, { by: 'Pat', a: 'yes' }, opts).code, 3);
    fs.appendFileSync(files(opts).log, JSON.stringify({ op: 'answer', id: h.questionId, at: new Date().toISOString(), by: 'Pat', a: 'yes', delegation: dg.id, category: 'hiring' }) + '\n');
    assert.strictEqual(gov('hiring', { by: 'Sam', summary: 'hire Kim', ref: 'hiring:kim' }).allowed, false);
    const s = load(opts); s.delegations.push({ id: 'dg-old', to: 'Pat', categories: ['hiring'], at: inDays(-10), until: inDays(-1), by: 'owner' }); fs.writeFileSync(files(opts).state, JSON.stringify(s));
    fs.appendFileSync(files(opts).log, JSON.stringify({ op: 'answer', id: h.questionId, at: new Date().toISOString(), by: 'Pat', a: 'yes', delegation: 'dg-old', category: 'hiring' }) + '\n');
    assert.strictEqual(gov('hiring', { by: 'Sam', summary: 'hire Kim', ref: 'hiring:kim' }).allowed, false);
  });
  t('a hand-edited grant for a fixed gate or packs is ignored on read', () => {
    const s = load(opts); s.delegations.push({ id: 'dg-bad', to: 'Pat', categories: ['packs'], at: inDays(-1), until: inDays(3), by: 'owner' }); fs.writeFileSync(files(opts).state, JSON.stringify(s));
    const q = { id: 'q-x', gate: { category: 'packs', by: 'Sam', ref: 'packs:x' } };
    assert.ok(check(q, 'Pat', Date.now(), opts).why);
  });
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(T, { recursive: true, force: true });
  for (const l of out) console.log(l);
  console.log(bad ? 'DELEGATION SELFTEST FAILED: ' + bad : 'DELEGATION SELFTEST PASSED: ' + out.length + ' cases');
  return bad ? 1 : 0;
}

module.exports = { answeredNotice, grant, revoke, list, answer, answerFor, check, register, files, NEVER, MAX_DAYS, LOCKED };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const flag = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const pos = a.slice(1).filter((x, i, arr) => !x.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--') && arr[i - 1] !== '--json'));
  const done = r => { console.log(JSON.stringify(r, null, 1)); process.exit(r.ok ? 0 : (r.code || 2)); };
  if (cmd === 'selftest' || cmd === '--selftest') { try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}   // a selftest measures the mechanism in its own fixture tree, not the caller: an agent's run must not fail it
    process.exit(selftest()); }
  if (cmd === 'grant') done(grant({ to: flag('to'), categories: flag('categories'), until: flag('until'), by: flag('by'), why: flag('why') }));
  if (cmd === 'revoke') { if (!pos[0]) done({ ok: false, error: 'revoke <dg-id> --by <owner>' }); done(revoke(pos[0], { by: flag('by'), why: flag('why') })); }
  if (cmd === 'answer') { if (!pos[0]) done({ ok: false, error: 'answer <q-id> --by <delegate> --a "yes ..."' }); done(answer(pos[0], { by: flag('by'), a: flag('a') })); }
  if (cmd === 'register') done(register());
  if (cmd === 'list') {
    const l = list();
    if (a.includes('--json')) done({ ok: true, delegations: l });
    if (!l.length) console.log('No delegations.');
    for (const d of l) console.log(d.id + '  ' + (d.active ? 'ACTIVE ' : d.revokedAt ? 'revoked' : 'ended  ') + '  ' + d.to + '  ' + d.categories.join(',') + '  until ' + d.until + (d.why ? '  (' + d.why + ')' : ''));
    process.exit(0);
  }
  done({ ok: false, error: 'commands: grant --to <x> --categories a,b --until <iso> --by <owner> [--why], revoke <id> --by <owner>, list [--json], answer <q-id> --by <delegate> --a "...", register, selftest' });
}
