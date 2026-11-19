#!/usr/bin/env node
/* departments.js — the one writer of company/departments.json: who is in which department and who leads it
 * (docs/DEPARTMENTS.md). Reading is lib/departments.js; co.deptOf / co.leadOf / co.departmentsOf in lib/company.js.
 *
 *   node company/tools/departments.js list [--json]                       every department, its lead and members, the
 *                                                                          seats in none, the drift check, open proposals
 *   node company/tools/departments.js show <id> [--json]
 *   node company/tools/departments.js check [--json]                      departments.json vs loops.json vs FLOOR_PLAN.md,
 *                                                                          plus each brief's size; exit 1 on a mismatch
 *   node company/tools/departments.js create <id> --name "<Name>" [--class <task class>] [--lead <seat>] --by <name> [--why ".."]
 *   node company/tools/departments.js set-lead <id> <seat|none> --by <name> [--why ".."]
 *   node company/tools/departments.js add-member <id> <seat> --by <name> [--why ".."]
 *   node company/tools/departments.js remove-member <id> <seat> --by <name> [--why ".."]
 *   node company/tools/departments.js move <seat> <id|none> --by <name> [--why ".."]
 *   node company/tools/departments.js proposals [--json]                  open proposals from the people function
 *   node company/tools/departments.js apply <proposal id> --by <CEO|owner>
 *   node company/tools/departments.js reject <proposal id> --by <CEO|owner> [--why ".."]
 *   node company/tools/departments.js advisor <id> off|shadow|live --by owner          whether the lead gives advice (§5)
 *   node company/tools/departments.js advisor <id> pause --by owner --why ".."        (or --by dispatcher --auto [--hash h]:
 *                                                                          the house ranking said it does not pay)
 *   node company/tools/departments.js advisor <id> resume --by owner                  only the owner resumes
 *   node company/tools/departments.js brief <id> --file <path> --by <lead>            replace BRIEF.md (limits.briefMaxChars)
 *   node company/tools/departments.js digest <id> --file <path> --by <lead>           replace INBOX-DIGEST.md (digestMaxChars)
 *   node company/tools/departments.js note <id> --text ".." --by <lead>               one line at the top of DECISIONS.md
 *   node company/tools/departments.js show <id> --json --brief                        the department with its brief's text
 *   node company/tools/departments.js delegation <id> off|shadow|live --by owner       whether the lead may split big jobs (§6)
 *   node company/tools/departments.js delegation <id> workers <seat,seat> --by <CEO|owner>   who the lead may hand pieces to
 *                                                                          (only seats under the lead in loops.json; org)
 *   node company/tools/departments.js delegation <id> withdraw --by dispatcher --auto --why ".." [--hash h]   (or --by owner):
 *                                                                          the house ranking said splitting does not save money
 *   node company/tools/departments.js delegation <id> resume --by owner                only the owner resumes
 *   node company/tools/departments.js set-route <id> <class> <provider/model[@effort]> --by <owner|CEO|routing-proposal> [--proposal <rp-id>]
 *                                                                          the ONE writer of a department's routes: the class
 *                                                                          rules first (code never on the MiniMax plan, for the
 *                                                                          owner too); the CEO at the owner's models level; the
 *                                                                          weekly suggestion only from the dispatcher's own
 *                                                                          process, after its veto window passed with no veto
 *   node company/tools/departments.js set-route <id> <class> none --by <owner|CEO>      drop the route (the class runs on each seat's chain)
 *   node company/tools/departments.js --duty                              read-only duty (docs/DUTIES.md)
 *   node company/tools/departments.js --selftest
 *
 * Who may change the structure (a governance decision, category "org" in company/state/governance.json):
 *   the owner  (--by owner, from the owner's shell or the console: lib/owner.js)   applies at once
 *   the CEO    applies at the level the owner set for "org": auto / notify go ahead (notify tells the owner); approve
 *              files one owner question and stops (exit 3); the same command run again after the owner's yes goes ahead
 *   the people function (when it is not the CEO)   proposes: the change is kept in company/state/departments-proposals.json
 *              and the departments duty hands it to the CEO, who applies it (apply <id>) or rejects it
 *   anyone else is refused. A change that would make the file inconsistent (an unknown seat, a seat in two departments,
 *   a lead who is not on the crew) is refused for everyone, the owner included.
 * Every applied change: company/departments.json replaced atomically and its bytes recorded (provenance.js wrote), one
 * line in company/work/decisions.md (decision.js) and one at the top of the department's DECISIONS.md. `create` also
 * writes the department's folder: company/work/departments/<id>/BRIEF.md (limits.briefMaxChars), DECISIONS.md
 * (append-only, newest first), INBOX-DIGEST.md. It never rewrites FLOOR_PLAN.md or loops.json: check reports drift and
 * the floor and people owners fix their own files.
 * Exit: 0 done (or nothing to change), 1 check found a mismatch / selftest failed / duty due, 2 usage or refused,
 * 3 waiting for the owner (governance). Output is one JSON object, except list/show/check/proposals without --json.
 * Owner of this tool: the people function (co.seatFor('people')); company/departments.json is locked-watched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const co = require('./lib/company');
const D = require('./lib/departments');

const TOOL = 'departments.js';
const S = {   // seams for the tests (company/tools/tests/departments.test.js)
  root: () => co.ROOT,
  now: () => Date.now(),
  crew: () => co.crew(),
  ceo: () => co.ceo(),
  owner: () => require('./lib/owner'),
  prov: () => require('./provenance.js'),
  gov: () => require('./lib/governance'),
  decision: o => require('./decision.js').add(o),
  // the weekly routing suggestion's readiness (routing.js proposalReady): null when it may be applied now, else why not
  proposalReady: (id, want) => require('./routing.js').proposalReady(id, want),
};
const P = (...x) => path.join(S.root(), ...x);
const prov = () => S.prov();
const PROPOSALS = () => P('company', 'state', 'departments-proposals.json');
const PLAN = () => P('company', 'FLOOR_PLAN.md');
const deptDir = id => P('company', 'work', 'departments', id);
const rel = f => path.relative(S.root(), f);
const readIf = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const clean = (t, n) => String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n || 300);
const clone = o => JSON.parse(JSON.stringify(o == null ? null : o));
function writeAtomic(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
function stamp() { const lp = co.localParts(new Date(S.now())); return lp.date + ' ' + lp.time; }

class Refusal extends Error { constructor(msg, code, extra) { super(msg); this.code = code || 2; this.extra = extra || {}; } }

/* ---------------- reading ---------------- */
function state() {
  const L = D.load({ root: S.root() });
  if (L.error) throw new Refusal(L.error + '; fix or restore it (locked-watch.js revert company/departments.json --by <name>) before changing departments', 2);
  return L;
}
const nameOf = (crew, id) => (crew[id] && crew[id].name) || id;
function report(o) {
  o = o || {};
  const crew = S.crew(), L = D.load({ root: S.root() }), doc = L.doc, st = D.settings(doc, { root: S.root() });
  const planText = readIf(PLAN());
  const dr = D.drift({ doc, exists: L.exists && !L.error, crew, plan: planText == null ? null : D.parsePlan(planText), ceo: S.ceo() });
  if (L.error) dr.mismatches.unshift({ code: 'BAD_FILE', msg: L.error }), dr.ok = false;
  // each department's own files: present, and inside their size limits
  for (const d of D.list(doc)) {
    if (!D.ID_RE.test(String(d.id || ''))) continue;
    const b = readIf(path.join(deptDir(d.id), 'BRIEF.md')), g = readIf(path.join(deptDir(d.id), 'INBOX-DIGEST.md'));
    if (b == null) dr.mismatches.push({ code: 'BRIEF_MISSING', dept: d.id, msg: 'company/work/departments/' + d.id + '/BRIEF.md is missing' });
    else if (b.length > st.limits.briefMaxChars) dr.mismatches.push({ code: 'BRIEF_TOO_LONG', dept: d.id, msg: 'company/work/departments/' + d.id + '/BRIEF.md is ' + b.length + ' characters; the limit is ' + st.limits.briefMaxChars });
    if (g != null && g.length > st.limits.digestMaxChars) dr.mismatches.push({ code: 'DIGEST_TOO_LONG', dept: d.id, msg: 'company/work/departments/' + d.id + '/INBOX-DIGEST.md is ' + g.length + ' characters; the limit is ' + st.limits.digestMaxChars });
  }
  // advisor leads (§5): advice on with no lead, or with the CEO as the lead (the CEO is never a lead)
  for (const d of D.list(doc)) {
    const ad = D.advisorOf(d, st); if (ad.mode === 'off') continue;
    if (!d.lead) dr.mismatches.push({ code: 'ADVISOR_NO_LEAD', dept: d.id, msg: 'department ' + (d.name || d.id) + ' has the lead\'s advice ' + ad.mode + ' but no lead (departments.js set-lead, or advisor ' + d.id + ' off)' });
    else if (String(d.lead) === String(S.ceo())) dr.mismatches.push({ code: 'ADVISOR_CEO_LEAD', dept: d.id, seat: d.lead, msg: 'department ' + (d.name || d.id) + ' names the CEO as its lead while its advice is ' + ad.mode + '; the CEO is never a lead (set another lead, or advisor ' + d.id + ' off)' });
  }
  // narrow fan-out (§6): splitting on with no lead (or the CEO as lead), and an allowlisted worker outside the lead's reports
  for (const d of D.list(doc)) {
    const g = D.delegationOf(d, st);
    if (g.mode !== 'off' && (!d.lead || String(d.lead) === String(S.ceo()))) dr.mismatches.push({ code: 'DELEGATE_NO_LEAD', dept: d.id, msg: 'department ' + (d.name || d.id) + ' has splitting ' + g.mode + ' but ' + (d.lead ? 'the CEO as its lead' : 'no lead') + ' (set a lead, or delegation ' + d.id + ' off)' });
    const under = d.lead ? D.subtree(d.lead, crew) : new Set();
    for (const w of g.workers) if (!crew[w] || !under.has(w)) dr.mismatches.push({ code: 'DELEGATE_OUTSIDE_SUBTREE', dept: d.id, seat: w, msg: 'department ' + (d.name || d.id) + ' lists ' + w + ' as a worker for its lead, but ' + (crew[w] ? w + ' does not report to ' + (d.lead ? nameOf(crew, d.lead) : 'a lead') + ' in loops.json' : w + ' is not on the crew') });
  }
  dr.ok = !dr.mismatches.length;
  const departments = D.list(doc).map(d => {
    const b = readIf(path.join(deptDir(String(d.id)), 'BRIEF.md'));
    return { id: d.id, name: d.name, lead: d.lead || null, leadName: d.lead ? nameOf(crew, d.lead) : null,
      members: D.members(d).map(s => ({ id: s, name: nameOf(crew, s), onCrew: !!crew[s], manager: (crew[s] && crew[s].manager) || null, isLead: s === d.lead, escalatesTo: D.leadOf(s, doc, crew) })),
      defaultClass: d.defaultClass || null, brief: d.brief || null, briefChars: b == null ? null : b.length, routes: d.routes || {}, consult: d.consult || {},
      advisor: (({ mode, effective, paused, since, by, batch, autoPause }) => ({ mode, effective, paused, since, by, batch, autoPause }))(D.advisorOf(d, st)), consultLimits: D.consultOf(d, st),
      delegation: (({ mode, effective, workers, maxWorkers, workerTimeoutMin, minPieces, prefer, since, by, withdrawn }) => ({ mode, effective, workers, maxWorkers, workerTimeoutMin, minPieces, prefer, since, by, withdrawn }))(D.delegationOf(d, st)),
      briefText: o && o.brief ? b : undefined };
  });
  const unassigned = Object.keys(crew).filter(id => !D.deptOf(id, doc)).map(id => ({ id, name: nameOf(crew, id), isCeo: id === S.ceo() }));
  return { ok: true, exists: L.exists, file: 'company/departments.json', classes: D.CLASSES, leadModelDefault: st.leadModelDefault, limits: st.limits,
    departments, unassigned, drift: dr, proposals: proposals().filter(p => p.status === 'open') };
}

/* ---------------- planning a change (pure: doc in, doc out) ---------------- */
function needSeat(crew, s) { const id = String(s || '').trim(); if (!id || id === 'true') throw new Refusal('name a seat (its station id from company/tools/loops.json)'); if (!crew[id]) throw new Refusal(id + ' is not a seat on the crew (company/tools/loops.json): departments hold crew seats only'); return id; }
function needDept(doc, id) { const d = D.list(doc).find(x => String(x.id) === String(id)); if (!d) throw new Refusal('no department "' + id + '" (departments.js list)'); return d; }
function noOther(doc, seat, id) { const o = D.deptOf(seat, doc); if (o && String(o.id) !== String(id)) throw new Refusal(seat + ' is already in ' + (o.name || o.id) + ' (' + o.id + '); a seat belongs to one department: move it instead (departments.js move ' + seat + ' ' + id + ')'); }
// a department in the owner's words: "the Research department", or "one of the departments" when its name is not plain
function deptWords(name) {
  const n = String(name || '').trim(); const g = (() => { try { return S.gov(); } catch (_) { return null; } })();
  const ok = n && g && typeof g.plainPart === 'function' && g.plainPart('the ' + n + ' department');
  return ok ? 'the ' + n.replace(/\s+department$/i, '') + ' department' : 'one of the departments';
}
function plan(op, a, doc0, crew, st) {
  const doc = clone(doc0); doc.departments = D.list(doc);
  let summary, plain = null, touched = [], created = null;
  if (op === 'create') {
    const id = String(a.pos[1] || '').trim();
    if (!D.ID_RE.test(id)) throw new Refusal('the department id must be lowercase letters, digits and dashes, 2-32 characters, starting with a letter (got "' + id + '")');
    if (D.list(doc).some(d => String(d.id) === id)) throw new Refusal('department ' + id + ' already exists');
    const name = clean(a.name, 60); if (!name || a.name === true) throw new Refusal('create needs --name "<Name>"');
    if (D.list(doc).some(d => String(d.name || '').toLowerCase() === name.toLowerCase())) throw new Refusal('a department is already called "' + name + '"');
    const cls = a.class && a.class !== true ? String(a.class) : String(st.newDepartment.defaultClass || 'general');
    if (!D.CLASSES.includes(cls)) throw new Refusal('--class must be one of ' + D.CLASSES.join(', '));
    let lead = null; if (a.lead && a.lead !== true) { lead = needSeat(crew, a.lead); noOther(doc, lead, id); }
    doc.departments.push({ id, name, lead, members: lead ? [lead] : [], defaultClass: cls, brief: 'company/work/departments/' + id + '/BRIEF.md',
      routes: clone(st.newDepartment.routes || {}), consult: clone(st.newDepartment.consult || {}) });
    summary = 'create the ' + name + ' department (' + id + ', default class ' + cls + (lead ? ', lead ' + nameOf(crew, lead) : ', no lead yet') + ')';
    plain = 'start ' + deptWords(name) + (lead ? ' led by ' + nameOf(crew, lead) : '');
    touched = [id]; created = { id, name };
  } else if (op === 'set-lead') {
    const d = needDept(doc, a.pos[1]), raw = String(a.pos[2] || '').trim();
    if (raw === 'none' || raw === 'null') {
      if (!d.lead) return { unchanged: true, summary: d.id + ' has no lead already' };
      summary = 'leave the ' + (d.name || d.id) + ' department without a lead (was ' + nameOf(crew, d.lead) + '; each member\'s manager stands in)';
      plain = 'leave ' + deptWords(d.name) + ' without a lead, so ' + nameOf(crew, d.lead) + ' no longer leads it'; d.lead = null;
    } else {
      const s = needSeat(crew, raw); noOther(doc, s, d.id);
      if (d.lead === s) return { unchanged: true, summary: nameOf(crew, s) + ' already leads ' + d.id };
      d.members = D.members(d); if (!d.members.includes(s)) d.members.push(s);
      summary = 'make ' + nameOf(crew, s) + ' (' + s + ') the lead of ' + (d.name || d.id) + (d.lead ? ' (was ' + nameOf(crew, d.lead) + ')' : '');
      plain = 'make ' + nameOf(crew, s) + ' the lead of ' + deptWords(d.name) + (d.lead ? ' instead of ' + nameOf(crew, d.lead) : ''); d.lead = s;
    }
    touched = [d.id];
  } else if (op === 'add-member') {
    const d = needDept(doc, a.pos[1]), s = needSeat(crew, a.pos[2]); noOther(doc, s, d.id);
    d.members = D.members(d); if (d.members.includes(s)) return { unchanged: true, summary: s + ' is already in ' + d.id };
    d.members.push(s); summary = 'add ' + nameOf(crew, s) + ' (' + s + ') to ' + (d.name || d.id); plain = 'add ' + nameOf(crew, s) + ' to ' + deptWords(d.name); touched = [d.id];
  } else if (op === 'remove-member') {
    const d = needDept(doc, a.pos[1]), s = String(a.pos[2] || '').trim();
    if (!D.members(d).includes(s) && d.lead !== s) throw new Refusal(s + ' is not in ' + d.id);
    d.members = D.members(d).filter(x => x !== s); const wasLead = d.lead === s; if (wasLead) d.lead = null;
    summary = 'take ' + nameOf(crew, s) + ' (' + s + ') out of ' + (d.name || d.id) + (wasLead ? ', which leaves it without a lead' : '');
    plain = 'take ' + nameOf(crew, s) + ' out of ' + deptWords(d.name) + (wasLead ? ', which leaves it without a lead' : ''); touched = [d.id];
  } else if (op === 'move') {
    const s = needSeat(crew, a.pos[1]), to = String(a.pos[2] || '').trim();
    if (!to || to === 'true') throw new Refusal('move <seat> <department id|none>');
    const from = D.deptOf(s, doc), dest = to === 'none' ? null : needDept(doc, to);
    if ((from && from.id) === (dest && dest.id) || (!from && !dest)) return { unchanged: true, summary: s + ' is already ' + (dest ? 'in ' + dest.id : 'in no department') };
    let wasLead = false;
    if (from) { from.members = D.members(from).filter(x => x !== s); if (from.lead === s) { from.lead = null; wasLead = true; } touched.push(from.id); }
    if (dest) { dest.members = D.members(dest).concat([s]); touched.push(dest.id); }
    summary = 'move ' + nameOf(crew, s) + ' (' + s + ') ' + (from ? 'from ' + (from.name || from.id) + ' ' : '') + (dest ? 'to ' + (dest.name || dest.id) : 'out of every department') + (wasLead ? ' (' + (from.name || from.id) + ' is left without a lead)' : '');
    plain = 'move ' + nameOf(crew, s) + (dest ? ' to ' + deptWords(dest.name) : ' out of every department') + (wasLead ? ', which leaves ' + deptWords(from.name) + ' without a lead' : '');
  } else throw new Refusal('unknown change ' + op);
  // refuse a change that adds a structural problem; problems the file already had do not block a fix
  const key = p => p.code + ':' + (p.dept || '') + ':' + (p.seat || '');
  const before = new Set(D.validate(doc0, crew).map(key));
  const added = D.validate(doc, crew).filter(p => !before.has(key(p)));
  if (added.length) throw new Refusal('refused, it would make company/departments.json inconsistent: ' + added.map(p => p.msg).join('; '));
  return { doc, summary, plain, touched, created };
}

/* ---------------- who is asking ---------------- */
function actor(by, cmd) {
  const name = String(by == null ? '' : by).trim();
  if (!name || by === true) throw new Refusal('--by <name> is required (who decides)');
  const own = S.owner();
  if (own.isOwnerName(name)) {
    const r = own.refusal(name, 'a department change'); if (r) throw new Refusal(r, 2);
    return { kind: 'owner', name: 'owner', label: (co.config.owner && co.config.owner.name) || 'the owner' };
  }
  const crew = S.crew(), low = name.toLowerCase();
  const id = crew[name] ? name : Object.keys(crew).find(k => String((crew[k] || {}).name || '').trim().toLowerCase() === low);
  if (!id) throw new Refusal('--by "' + name + '" is not on the crew (company/tools/loops.json) and is not the owner');
  // inside an agent's run the --by claim must be that run's own seat
  let pv = null; try { pv = prov(); } catch (_) {}
  if (pv && pv.underStation()) {
    const env = String(process.env.STARNET_AGENT_ID || '').trim();
    if (env && env !== id) throw new Refusal('this run is ' + nameOf(crew, env) + '\'s, not ' + nameOf(crew, id) + '\'s: --by names the seat running the command', 2);
    const c = pv.callerConflict(S.root(), [TOOL, cmd], id);
    if (c) throw new Refusal('this command claims --by ' + nameOf(crew, id) + ' but ran in another seat\'s run (' + c.runId + ')', 2);
  }
  const seat = crew[id];
  const kind = id === S.ceo() ? 'ceo' : co.holds(seat, 'people') ? 'people' : 'other';
  return { kind, id, name: seat.name || id, label: seat.name || id };
}

/* ---------------- governance: category "org" ---------------- */
function orgOpts() {
  // a company founded before the org category existed has no line for it: the framework default applies (as deps.js)
  try {
    const g = S.gov().doc({ root: S.root() });
    if (g && g.categories && !Object.prototype.hasOwnProperty.call(g.categories, 'org')) {
      const def = co.readJson(co.p('company', 'defaults', 'state', 'governance.json'), {}) || {};
      const v = def.categories && def.categories.org;
      if (['auto', 'notify', 'approve'].includes(v)) return { level: v };
    }
  } catch (_) {}
  return {};
}
const refOf = (op, a) => 'org:' + op + ':' + a.pos.slice(1).map(x => String(x).toLowerCase()).join(':') + (op === 'create' ? ':' + String(a.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') : '');

/* ---------------- writing ---------------- */
function brief(id, name, st) {
  return '# ' + name + ' — department brief\n\n' +
    '_Kept by the department lead (company/departments.json). At most ' + st.limits.briefMaxChars + ' characters: `departments.js check` reports a longer one. ' +
    'What the next run needs to know, not a diary; decisions go in DECISIONS.md, the members\' inbox summary in INBOX-DIGEST.md._\n\n' +
    '## Purpose\n\nWhat this department is for, in two or three sentences.\n\n' +
    '## Current priorities\n\n1. (none yet)\n\n' +
    '## Standing rules\n\n- (none yet)\n\n' +
    '## Open questions\n\n- (none yet)\n';
}
const DEC_HEAD = name => '# ' + name + ' — decisions\n\nNewest first and append-only: a new entry goes at the top, an earlier one is never edited (correct it with a new entry that names it).\n\n';
function digest(name, st) { return '# ' + name + ' — inbox digest\n\n_Rewritten by the lead from the members\' inboxes; at most ' + st.limits.digestMaxChars + ' characters._\n\nNothing yet.\n'; }
function deptDecision(id, name, line) {
  const f = path.join(deptDir(id), 'DECISIONS.md');
  let text = readIf(f); if (text == null) text = DEC_HEAD(name);
  const L = text.split('\n'); let at = L.findIndex(l => /^- \d{4}-\d{2}-\d{2}/.test(l));
  if (at < 0) { if (text.length && !text.endsWith('\n')) text += '\n'; writeAtomic(f, text + line + '\n'); return; }
  L.splice(at, 0, line); writeAtomic(f, L.join('\n'));
}
function commit(p, who, a, extra) {
  const L = D.load({ root: S.root() }), st = D.settings(p.doc, { root: S.root() });
  // a company with no file yet starts from the framework default (its _doc, config and limits), with these departments
  const base = L.exists ? L.doc : Object.assign(clone(D.frameworkDefault({ root: S.root() })), { departments: [] });
  const next = Object.assign({}, base, { departments: p.doc.departments });
  const text = JSON.stringify(next, null, 2) + '\n';
  writeAtomic(D.fileOf({ root: S.root() }), text);
  try { prov().wrote(D.fileOf({ root: S.root() }), text, TOOL); } catch (_) {}
  const files = [];
  if (p.created) {
    const dir = deptDir(p.created.id); fs.mkdirSync(dir, { recursive: true });
    const put = (n, t) => { const f = path.join(dir, n); if (!fs.existsSync(f)) { writeAtomic(f, t); files.push(rel(f)); } };
    put('BRIEF.md', brief(p.created.id, p.created.name, st)); put('DECISIONS.md', DEC_HEAD(p.created.name)); put('INBOX-DIGEST.md', digest(p.created.name, st));
  }
  const why = a.why && a.why !== true ? clean(a.why, 300) : '';
  const by = who.kind === 'owner' ? who.label + ' (owner)' : who.label;
  for (const id of p.touched) {
    const d = D.list(next).find(x => String(x.id) === id) || { name: id };
    try { deptDecision(id, d.name || id, '- ' + stamp() + ' ' + by + ': ' + p.summary + (why ? '. Why: ' + why : '') + (extra && extra.note ? ' (' + extra.note + ')' : '') + ' (departments.js)'); } catch (_) {}
  }
  let decision = null;
  try { decision = S.decision({ by: who.kind === 'owner' ? 'owner' : who.name, text: 'Departments: ' + p.summary + (extra && extra.note ? ' (' + extra.note + ')' : '') + '.', why: why || undefined }); } catch (e) { decision = { error: e.message }; }
  return { ok: true, changed: true, summary: p.summary, by: who.label, departments: p.touched, files: files.length ? files : undefined,
    decision: decision && decision.ok ? decision.id : undefined, decisionError: decision && decision.error ? decision.error : undefined };
}

/* ---------------- proposals (company/state/departments-proposals.json, bounded) ---------------- */
function proposals() { const j = co.readJson(PROPOSALS(), null); return j && Array.isArray(j.proposals) ? j.proposals : []; }
function saveProposals(list, keep) {
  const open = list.filter(p => p.status === 'open'), closed = list.filter(p => p.status !== 'open').slice(-Math.max(0, keep));
  const text = JSON.stringify({ _doc: 'Department changes the people function proposed (company/tools/departments.js). Open ones reach the CEO through the departments duty; apply <id> or reject <id>. Bounded: every open proposal and the newest limits.proposalsKeep closed ones.', proposals: list.filter(p => open.includes(p) || closed.includes(p)) }, null, 1) + '\n';
  writeAtomic(PROPOSALS(), text);
}
function propose(op, a, p, who) {
  const all = proposals(), sig = op + ' ' + a.pos.slice(1).join(' ') + (op === 'create' ? ' ' + JSON.stringify({ name: a.name || null, class: a.class || null, lead: a.lead || null }) : '');
  const dup = all.find(x => x.status === 'open' && x.sig === sig);
  if (dup) return { ok: true, proposed: true, id: dup.id, duplicate: true, summary: dup.summary, next: 'the CEO or the owner applies it: departments.js apply ' + dup.id + ' --by <CEO>' };
  const id = 'dp-' + crypto.createHash('sha256').update(sig + ':' + S.now() + ':' + process.pid).digest('hex').slice(0, 6);
  const row = { id, at: new Date(S.now()).toISOString(), by: who.name, seat: who.id, op, pos: a.pos.slice(1).map(String), name: a.name && a.name !== true ? String(a.name) : undefined,
    class: a.class && a.class !== true ? String(a.class) : undefined, lead: a.lead && a.lead !== true ? String(a.lead) : undefined, why: a.why && a.why !== true ? clean(a.why, 300) : undefined, summary: p.summary, sig, status: 'open' };
  all.push(row); saveProposals(all, D.settings(state().doc, { root: S.root() }).limits.proposalsKeep);
  return { ok: true, proposed: true, id, summary: p.summary, next: 'the CEO or the owner applies it: departments.js apply ' + id + ' --by <CEO>' };
}
function argsOfProposal(r) { return { pos: [r.op].concat(r.pos || []), name: r.name, class: r.class, lead: r.lead, why: r.why }; }

/* ---------------- one change, by whoever asks ---------------- */
function change(op, a) {
  const who = actor(a.by, op);
  const L = state(), crew = S.crew(), st = D.settings(L.doc, { root: S.root() });
  const p = plan(op, a, L.doc, crew, st);
  if (p.unchanged) return { ok: true, changed: false, summary: p.summary };
  if (who.kind === 'owner') return commit(p, who, a);
  if (who.kind === 'people') return propose(op, a, p, who);
  if (who.kind !== 'ceo') throw new Refusal(who.label + ' may not change departments: the CEO or the people function proposes, the CEO or the owner applies (docs/DEPARTMENTS.md)');
  return governed(op, a, p, who);
}
/* ASK(plan, args): what a governed department change says to the owner (lib/governance.js decide): the plan's plain
 * words, the ids and classes in `technical`. Exported so a test files it at approve. */
function ASK(p, a) {
  const g = S.gov(); const why = a && a.why && a.why !== true ? g.plainPart(clean(a.why, 200).replace(/[.!]$/, '')) : null;
  return { summary: p.plain || 'change how the crew is organised into departments', recommendation: why ? 'yes: ' + why.replace(/^./, c => c.toLowerCase()) : 'yes',
    default: 'the departments stay as they are', technical: 'departments: ' + p.summary + (a && a.why && a.why !== true ? '. Why: ' + clean(a.why, 300) : '') };
}
function governed(op, a, p, who, extra, category) {
  const gov = S.gov(), cat = category || 'org';
  const d = gov.decide(cat, Object.assign({ by: who.name, ref: refOf(op, a) }, ASK(p, a)), cat === 'org' ? orgOpts() : {});
  if (!d.allowed) throw new Refusal(gov.refusal(cat, d), d.denied ? 2 : 3, { governance: { category: cat, level: d.level, questionId: d.questionId || null, denied: !!d.denied } });
  return commit(p, who, a, Object.assign({}, extra, d.level === 'approve' ? { note: [extra && extra.note, 'owner approved ' + d.questionId].filter(Boolean).join('; ') } : {}));
}
function applyProposal(pid, a) {
  const who = actor(a.by, 'apply');
  if (who.kind !== 'owner' && who.kind !== 'ceo') throw new Refusal('only the CEO or the owner applies a department proposal');
  const all = proposals(), r = all.find(x => x.id === pid);
  if (!r) throw new Refusal('no proposal ' + pid + ' (departments.js proposals)');
  if (r.status !== 'open') throw new Refusal(pid + ' is ' + r.status + ' already');
  const pa = argsOfProposal(r), L = state(), crew = S.crew();
  const p = plan(r.op, pa, L.doc, crew, D.settings(L.doc, { root: S.root() }));
  const note = 'proposal ' + pid + ' by ' + r.by;
  const res = p.unchanged ? { ok: true, changed: false, summary: p.summary } : who.kind === 'owner' ? commit(p, who, pa, { note }) : governed(r.op, pa, p, who, { note });
  const now = proposals(); const x = now.find(y => y.id === pid);
  if (x) { Object.assign(x, { status: 'applied', closedAt: new Date(S.now()).toISOString(), closedBy: who.label }); saveProposals(now, D.settings(D.load({ root: S.root() }).doc, { root: S.root() }).limits.proposalsKeep); }
  return Object.assign({ proposal: pid }, res);
}
function rejectProposal(pid, a) {
  const who = actor(a.by, 'reject');
  if (who.kind !== 'owner' && who.kind !== 'ceo') throw new Refusal('only the CEO or the owner rejects a department proposal');
  const all = proposals(), r = all.find(x => x.id === pid);
  if (!r) throw new Refusal('no proposal ' + pid);
  if (r.status !== 'open') throw new Refusal(pid + ' is ' + r.status + ' already');
  Object.assign(r, { status: 'rejected', closedAt: new Date(S.now()).toISOString(), closedBy: who.label, reason: a.why && a.why !== true ? clean(a.why, 300) : undefined });
  saveProposals(all, D.settings(D.load({ root: S.root() }).doc, { root: S.root() }).limits.proposalsKeep);
  return { ok: true, proposal: pid, rejected: true };
}

/* ---------------- advisor leads (docs/DEPARTMENTS.md §5) ----------------
 * advisor <id> off|shadow|live   the owner only. On (shadow or live) needs a lead who is not the CEO.
 * advisor <id> pause             the owner, or the dispatcher with --auto (the house ranking's advisor evaluation said
 *                                pause; lib/consult.js consultStep): a paused department acts as recording only
 * advisor <id> resume            the owner only; the measurement starts again from today (since = now) */
function setAdvisor(d, next) { const L = state(); const doc = clone(L.doc); const x = D.list(doc).find(y => String(y.id) === String(d.id)); x.advisor = next; return doc; }
function advisorCmd(a) {
  const id = String(a.pos[1] || ''), op = String(a.pos[2] || '');
  const L = state(), st = D.settings(L.doc, { root: S.root() }), d = needDept(L.doc, id), cur = D.advisorOf(d, st), crew = S.crew();
  const own = d.advisor && typeof d.advisor === 'object' ? clone(d.advisor) : {};
  const nowIso = new Date(S.now()).toISOString(), leadName = d.lead ? nameOf(crew, d.lead) : null;
  let who, next, summary, plain;
  if (['off', 'shadow', 'live'].includes(op)) {
    who = actor(a.by, 'advisor');
    if (who.kind !== 'owner') throw new Refusal('only the owner switches whether a lead gives advice (advisor ' + id + ' ' + op + ' --by owner)');
    if (op !== 'off' && !d.lead) throw new Refusal((d.name || d.id) + ' has no lead: set one first (set-lead ' + id + ' <seat>)', 2, { problem: 'ADVISOR_NO_LEAD' });
    if (op !== 'off' && String(d.lead) === String(S.ceo())) throw new Refusal('the CEO is never a department lead: set another lead for ' + (d.name || d.id) + ' first', 2, { problem: 'ADVISOR_CEO_LEAD' });
    if (cur.mode === op) return { ok: true, changed: false, summary: 'the lead\'s advice for ' + (d.name || d.id) + ' is ' + op + ' already' };
    next = Object.assign(own, { mode: op, since: op === 'live' ? nowIso : (own.since || null), by: 'owner', paused: op === 'off' ? null : (own.paused || null) });
    summary = 'the lead\'s advice for ' + (d.name || d.id) + ' (' + (leadName || 'no lead') + '): ' + cur.mode + ' -> ' + op;
  } else if (op === 'pause') {
    const why = a.why && a.why !== true ? clean(a.why, 300) : '';
    if (!why) throw new Refusal('pause needs --why ".." (what failed)');
    if (String(a.by || '').trim().toLowerCase() === 'dispatcher') {
      if (a.auto !== true) throw new Refusal('the dispatcher pauses only with --auto (the house ranking\'s advisor evaluation)');
      let pv = null; try { pv = prov(); } catch (_) {}
      if (pv && pv.underStation()) throw new Refusal('--by dispatcher is the dispatcher\'s own tick, never an agent\'s run');
      const ceo = S.ceo(); who = { kind: 'dispatcher', name: (crew[ceo] && crew[ceo].name) || 'owner', label: 'the dispatcher (automatic)' };
    } else {
      who = actor(a.by, 'advisor');
      if (who.kind !== 'owner') throw new Refusal('only the owner pauses a lead\'s advice by hand (the dispatcher pauses it with --auto when it does not pay)');
    }
    if (cur.mode !== 'live') throw new Refusal('the lead\'s advice for ' + (d.name || d.id) + ' is ' + cur.mode + ', not on: there is nothing to pause');
    if (cur.paused) return { ok: true, changed: false, summary: (d.name || d.id) + '\'s lead advice is paused already (' + (cur.paused.why || '') + ')' };
    next = Object.assign(own, { paused: Object.assign({ at: nowIso, by: who.kind === 'dispatcher' ? 'auto' : 'owner', why }, a.hash && a.hash !== true ? { evaluationHash: clean(a.hash, 80) } : {}) });
    summary = 'pause the lead\'s advice for ' + (d.name || d.id) + ' (' + (leadName || 'no lead') + '): ' + why;
  } else if (op === 'resume') {
    if (String(a.by || '').trim().toLowerCase() === 'dispatcher') throw new Refusal('only the owner resumes a lead\'s advice');
    who = actor(a.by, 'advisor');
    if (who.kind !== 'owner') throw new Refusal('only the owner resumes a lead\'s advice');
    if (!cur.paused) return { ok: true, changed: false, summary: (d.name || d.id) + '\'s lead advice is not paused' };
    next = Object.assign(own, { paused: null, since: nowIso });
    summary = 'resume the lead\'s advice for ' + (d.name || d.id) + ' (' + (leadName || 'no lead') + '); measured again from today';
  } else throw new Refusal('advisor <id> off|shadow|live|pause|resume --by owner');
  const p = { doc: setAdvisor(d, next), summary, plain, touched: [String(d.id)] };
  return Object.assign(commit(p, who, a), { advisor: (({ mode, paused, since }) => ({ mode, paused, since }))(D.advisorOf(Object.assign({}, d, { advisor: next }), st)) });
}
/* ---------------- narrow fan-out (docs/DEPARTMENTS.md §6) ----------------
 * delegation <id> off|shadow|live   the owner only; shadow or live needs a lead who is not the CEO
 * delegation <id> workers a,b       the CEO (at the owner's org level) or the owner; every seat under the lead in loops.json
 * delegation <id> withdraw          the dispatcher with --auto (the house ranking's fan-out evaluation said it does not
 *                                   save money; once per evaluation hash), or the owner; a withdrawn department records only
 * delegation <id> resume            the owner only */
function setDelegation(d, next) { const L = state(); const doc = clone(L.doc); const x = D.list(doc).find(y => String(y.id) === String(d.id)); x.delegation = next; return doc; }
function delegationCmd(a) {
  const id = String(a.pos[1] || ''), op = String(a.pos[2] || '');
  const L = state(), st = D.settings(L.doc, { root: S.root() }), d = needDept(L.doc, id), cur = D.delegationOf(d, st), crew = S.crew();
  const own = d.delegation && typeof d.delegation === 'object' ? clone(d.delegation) : {};
  const nowIso = new Date(S.now()).toISOString(), leadName = d.lead ? nameOf(crew, d.lead) : null, dn = d.name || d.id;
  let who, next, summary, plain = null, governedOp = null;
  if (['off', 'shadow', 'live'].includes(op)) {
    who = actor(a.by, 'delegation');
    if (who.kind !== 'owner') throw new Refusal('only the owner switches whether a lead may split big jobs (delegation ' + id + ' ' + op + ' --by owner)');
    if (op !== 'off' && !d.lead) throw new Refusal(dn + ' has no lead: set one first (set-lead ' + id + ' <seat>)', 2, { problem: 'DELEGATE_NO_LEAD' });
    if (op !== 'off' && String(d.lead) === String(S.ceo())) throw new Refusal('the CEO is never a department lead: set another lead for ' + dn + ' first', 2, { problem: 'DELEGATE_NO_LEAD' });
    if (cur.mode === op) return { ok: true, changed: false, summary: 'splitting big jobs for ' + dn + ' is ' + op + ' already' };
    next = Object.assign(own, { mode: op, since: op === 'live' ? nowIso : (own.since || null), by: 'owner', withdrawn: op === 'off' ? null : (own.withdrawn || null) });
    summary = 'splitting big jobs for ' + dn + ' (' + (leadName || 'no lead') + '): ' + cur.mode + ' -> ' + op;
  } else if (op === 'workers') {
    who = actor(a.by, 'delegation');
    if (who.kind !== 'owner' && who.kind !== 'ceo') throw new Refusal('only the CEO or the owner sets who a lead may hand pieces to');
    if (!d.lead) throw new Refusal(dn + ' has no lead: set one first', 2, { problem: 'DELEGATE_NO_LEAD' });
    const list = [...new Set(String(a.pos[3] || '').split(',').map(x => x.trim()).filter(x => x && x !== 'none'))];
    const under = D.subtree(d.lead, crew);
    const bad = list.filter(w => !crew[w] || !under.has(w));
    if (bad.length) throw new Refusal('refused: ' + bad.map(w => crew[w] ? nameOf(crew, w) + ' (' + w + ') does not report to ' + leadName + ' in loops.json' : w + ' is not on the crew').join('; ') + ': a lead hands pieces only to its own team', 2, { problem: 'DELEGATE_OUTSIDE_SUBTREE' });
    if (JSON.stringify(cur.workers) === JSON.stringify(list)) return { ok: true, changed: false, summary: dn + '\'s workers are ' + (list.join(', ') || 'none') + ' already' };
    next = Object.assign(own, { workers: list });
    summary = 'the workers ' + leadName + ' may hand pieces of a big job to in ' + dn + ': ' + (list.map(w => nameOf(crew, w)).join(', ') || 'none');
    plain = 'let ' + leadName + ' hand parts of a big job to ' + (list.length ? list.map(w => nameOf(crew, w)).join(', ') : 'nobody') + ' in ' + deptWords(d.name);
    governedOp = 'delegation-workers';
  } else if (op === 'withdraw') {
    const why = a.why && a.why !== true ? clean(a.why, 300) : '';
    if (!why) throw new Refusal('withdraw needs --why ".." (what the evaluation found)');
    if (String(a.by || '').trim().toLowerCase() === 'dispatcher') {
      if (a.auto !== true) throw new Refusal('the dispatcher withdraws only with --auto (the house ranking\'s fan-out evaluation)');
      let pv = null; try { pv = prov(); } catch (_) {}
      if (pv && pv.underStation()) throw new Refusal('--by dispatcher is the dispatcher\'s own tick, never an agent\'s run');
      const ceo = S.ceo(); who = { kind: 'dispatcher', name: (crew[ceo] && crew[ceo].name) || 'owner', label: 'the dispatcher (automatic)' };
    } else {
      who = actor(a.by, 'delegation');
      if (who.kind !== 'owner') throw new Refusal('only the owner withdraws splitting by hand (the dispatcher withdraws it with --auto when it does not save money)');
    }
    if (cur.mode === 'off') throw new Refusal('splitting big jobs for ' + dn + ' is off: there is nothing to withdraw');
    if (cur.withdrawn) return { ok: true, changed: false, summary: dn + '\'s splitting is withdrawn already (' + (cur.withdrawn.why || '') + ')' };
    next = Object.assign(own, { withdrawn: Object.assign({ at: nowIso, by: who.kind === 'dispatcher' ? 'auto' : 'owner', why }, a.hash && a.hash !== true ? { evaluationHash: clean(a.hash, 80) } : {}) });
    summary = 'withdraw splitting big jobs for ' + dn + ' (' + (leadName || 'no lead') + '): ' + why;
  } else if (op === 'resume') {
    if (String(a.by || '').trim().toLowerCase() === 'dispatcher') throw new Refusal('only the owner resumes splitting');
    who = actor(a.by, 'delegation');
    if (who.kind !== 'owner') throw new Refusal('only the owner resumes splitting');
    if (!cur.withdrawn) return { ok: true, changed: false, summary: dn + '\'s splitting is not withdrawn' };
    next = Object.assign(own, { withdrawn: null, since: nowIso });
    summary = 'resume splitting big jobs for ' + dn + ' (' + (leadName || 'no lead') + '); measured again from today';
  } else throw new Refusal('delegation <id> off|shadow|live|workers <seat,seat>|withdraw|resume --by <name>');
  const p = { doc: setDelegation(d, next), summary, plain, touched: [String(d.id)] };
  const res = who.kind === 'ceo' && governedOp ? governed(governedOp, a, p, who) : commit(p, who, a);
  return Object.assign(res, { delegation: (({ mode, effective, workers, withdrawn, since }) => ({ mode, effective, workers, withdrawn, since }))(D.delegationOf(Object.assign({}, d, { delegation: next }), st)) });
}

/* set-route <id> <class> <provider/model[@effort]|none>: the one writer of a department's routes. */
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function parsePair(raw) {
  const t = String(raw || '').trim(), sl = t.indexOf('/');
  if (sl <= 0) return null;
  const provider = t.slice(0, sl), rest = t.slice(sl + 1), at = rest.lastIndexOf('@');
  const model = at > 0 ? rest.slice(0, at) : rest, effort = at > 0 ? rest.slice(at + 1) : null;
  if (!/^[a-z0-9_.-]+$/.test(provider) || !model || !/^[A-Za-z0-9_.:\[\]-]+$/.test(model) || (effort && !EFFORTS.includes(effort))) return null;
  return Object.assign({ provider, model }, effort ? { effort } : {});
}
// the class rules (routing-policy.json classRules, else the framework default's); the owner ruling "code is never on the
// MiniMax plan" holds even with no policy at all
function routeDenied(cls, pair) {
  if (cls === 'code' && pair.provider === 'custom') return 'code is never written on the MiniMax plan (owner ruling)';
  try {
    const R = require('./lib/routing'); const L = R.loadPolicy(S.root());
    if (L && !R.routeAllowed(cls, pair, R.knobs(L.policy))) return 'the class rules deny ' + pair.provider + '/' + pair.model + ' for ' + cls + ' work (routing-policy.json classRules)';
  } catch (_) {}
  return null;
}
const routeLabel = r => r ? r.provider + '/' + r.model + (r.effort ? '@' + r.effort : '') : 'none';
function setRoute(a) {
  const id = String(a.pos[1] || ''), cls = String(a.pos[2] || ''), raw = String(a.pos[3] || '');
  const L = state(), d = needDept(L.doc, id), dn = d.name || d.id;
  if (!D.CLASSES.includes(cls)) throw new Refusal('set-route <id> <class> <provider/model[@effort]|none>: class must be one of ' + D.CLASSES.join(', '));
  const pair = raw === 'none' ? null : parsePair(raw);
  if (raw !== 'none' && !pair) throw new Refusal('the route is provider/model[@effort] (got "' + raw + '")');
  if (pair) {
    const deny = routeDenied(cls, pair); if (deny) throw new Refusal('refused: ' + deny + ' — for everyone, the owner included', 2, { problem: 'CLASS_RULE' });
    const allowed = ((co.readJson(P('company', 'model-policy.json'), {}) || {}).allowed || {})[pair.provider];
    if (!allowed || !Array.isArray(allowed.models) || !allowed.models.includes(pair.model)) throw new Refusal('refused: ' + pair.provider + '/' + pair.model + ' is not on the company\'s allowed list (company/model-policy.json allowed)');
  }
  const crew = S.crew(), by = String(a.by || '').trim().toLowerCase();
  let who;
  if (by === 'routing-proposal') {
    let pv = null; try { pv = prov(); } catch (_) {}
    if (pv && pv.underStation()) throw new Refusal('--by routing-proposal is the dispatcher\'s weekly suggestion, never an agent\'s run');
    const pid = a.proposal && a.proposal !== true ? String(a.proposal) : '';
    if (!pid) throw new Refusal('--by routing-proposal needs --proposal <id>');
    if (!pair) throw new Refusal('a weekly suggestion moves a route, it never drops one');
    let why = null; try { why = S.proposalReady(pid, { dept: String(d.id), class: cls, to: pair }); } catch (e) { why = e.message; }
    if (why) throw new Refusal('refused: suggestion ' + pid + ' is not ready to apply: ' + why);
    const ceo = S.ceo(); who = { kind: 'routing-proposal', name: (crew[ceo] && crew[ceo].name) || 'owner', label: 'the weekly routing suggestion (automatic, not vetoed)' };
  } else {
    who = actor(a.by, 'set-route');
    if (who.kind !== 'owner' && who.kind !== 'ceo') throw new Refusal('only the owner or the CEO changes a department\'s route (the weekly suggestion does it after the owner\'s veto window)');
  }
  const cur = (d.routes && d.routes[cls]) || null;
  if (routeLabel(cur) === routeLabel(pair)) return { ok: true, changed: false, summary: dn + '\'s ' + cls + ' route is ' + routeLabel(pair) + ' already' };
  const doc = clone(L.doc), x = D.list(doc).find(y => String(y.id) === String(d.id));
  x.routes = Object.assign({}, x.routes || {}); if (pair) x.routes[cls] = pair; else delete x.routes[cls];
  const summary = 'the ' + cls + ' route of ' + dn + ': ' + routeLabel(cur) + ' -> ' + routeLabel(pair) + (who.kind === 'routing-proposal' ? ' (weekly suggestion ' + a.proposal + ', not vetoed)' : '');
  const p = { doc, summary, plain: 'change which AI setup does ' + cls + ' work in ' + deptWords(d.name), touched: [String(d.id)] };
  const res = who.kind === 'ceo' ? governed('set-route', a, p, who, null, 'models') : commit(p, who, a, who.kind === 'routing-proposal' ? { note: 'proposal ' + a.proposal } : null);
  return Object.assign(res, { route: { dept: String(d.id), class: cls, from: cur, to: pair } });
}

/* brief / digest / note: the lead's own department files (the owner may too). brief and digest are replaced whole, inside
   their size limits; a note is one line at the top of DECISIONS.md (newest first, append-only). */
function leadOnly(a, cmd, d) {
  const who = actor(a.by, cmd);
  if (who.kind === 'owner' || (d.lead && who.id === String(d.lead))) return who;
  throw new Refusal('only the lead of ' + (d.name || d.id) + (d.lead ? ' (' + nameOf(S.crew(), d.lead) + ')' : ' (it has none)') + ' or the owner writes its ' + cmd);
}
function deptFile(a, cmd) {
  const id = String(a.pos[1] || ''); const L = state(), st = D.settings(L.doc, { root: S.root() }), d = needDept(L.doc, id);
  const who = leadOnly(a, cmd, d);
  if (cmd === 'note') {
    const text = a.text && a.text !== true ? clean(a.text, 600) : ''; if (!text) throw new Refusal('note needs --text ".."');
    deptDecision(String(d.id), d.name || d.id, '- ' + stamp() + ' ' + (who.kind === 'owner' ? who.label + ' (owner)' : who.label) + ': ' + text + ' (departments.js note)');
    return { ok: true, changed: true, dept: d.id, file: 'company/work/departments/' + d.id + '/DECISIONS.md' };
  }
  const src = a.file && a.file !== true ? path.resolve(String(a.file)) : null; if (!src) throw new Refusal(cmd + ' needs --file <a file you wrote>');
  let text; try { if (fs.statSync(src).size > 1024 * 1024) throw new Error('over 1 MB'); text = fs.readFileSync(src, 'utf8'); } catch (e) { throw new Refusal('cannot read ' + a.file + ': ' + e.message); }
  const max = cmd === 'brief' ? st.limits.briefMaxChars : st.limits.digestMaxChars;
  if (text.length > max) throw new Refusal('the ' + cmd + ' is ' + text.length + ' characters; the limit is ' + max + ' (limits.' + (cmd === 'brief' ? 'briefMaxChars' : 'digestMaxChars') + ')');
  if (!text.trim()) throw new Refusal('the ' + cmd + ' is empty');
  const f = path.join(deptDir(String(d.id)), cmd === 'brief' ? 'BRIEF.md' : 'INBOX-DIGEST.md');
  if (readIf(f) === text) return { ok: true, changed: false, dept: d.id };
  writeAtomic(f, text); try { prov().wrote(f, text, TOOL); } catch (_) {}
  return { ok: true, changed: true, dept: d.id, file: rel(f), chars: text.length };
}

/* ---------------- duty (read only, counts and ids) ---------------- */
function duty() {
  const r = report();
  // ids only (docs/DUTIES.md): a department or seat id from the files' keys, a digest for a name only FLOOR_PLAN.md has
  const items = r.drift.mismatches.map(m => ({ id: 'departments:' + m.code + ':' + (m.dept || m.seat || m.ref || 'file'), route: 'people' }))
    .concat(r.proposals.map(p => ({ id: 'departments-proposal:' + p.id, route: 'ceo' })));
  const seen = new Set(); const uniq = items.filter(i => !seen.has(i.id) && seen.add(i.id));
  if (!uniq.length) return { code: 0 };
  const codes = [...new Set(r.drift.mismatches.map(m => m.code))];
  const reason = [r.drift.mismatches.length ? r.drift.mismatches.length + ' department mismatch' + (r.drift.mismatches.length === 1 ? '' : 'es') + ' (' + codes.join(', ') + '): departments.js check' : null,
    r.proposals.length ? r.proposals.length + ' open department proposal' + (r.proposals.length === 1 ? '' : 's') + ' (' + r.proposals.map(p => p.id).join(', ') + '): departments.js proposals' : null].filter(Boolean).join('; ');
  const key = crypto.createHash('sha256').update(uniq.map(i => i.id).sort().join('\n')).digest('hex').slice(0, 16);
  return { code: 1, out: { due: true, reason: reason.slice(0, 300), route: 'people', key, items: uniq.slice(0, 50) } };
}

/* ---------------- text output ---------------- */
function listText(r) {
  const L = [];
  if (!r.exists) L.push('No company/departments.json: the company has no departments.');
  else if (!r.departments.length) L.push('No departments yet (departments.js create <id> --name "<Name>" --by <name>).');
  for (const d of r.departments) {
    L.push(d.name + ' (' + d.id + ') — lead: ' + (d.leadName ? d.leadName + ' (' + d.lead + ')' : 'none (managers stand in)') + ', class ' + (d.defaultClass || '-'));
    for (const m of d.members) L.push('  ' + (m.isLead ? '* ' : '- ') + m.name + ' (' + m.id + ')' + (m.onCrew ? '' : ' [not on the crew]') + (m.escalatesTo ? ' -> ' + m.escalatesTo : ''));
  }
  if (r.exists && r.unassigned.length) L.push('In no department: ' + r.unassigned.map(u => u.name + ' (' + u.id + ')').join(', '));
  L.push(checkText(r.drift));
  if (r.proposals.length) L.push('Open proposals: ' + r.proposals.map(p => p.id + ' ' + p.summary + ' (by ' + p.by + ')').join('; '));
  return L.join('\n');
}
function checkText(dr) { return dr.ok ? 'Check: departments.json, loops.json and FLOOR_PLAN.md agree.' + (dr.notes.length ? ' Notes: ' + dr.notes.map(n => n.msg).join('; ') : '') : 'Check: ' + dr.mismatches.length + ' mismatch(es):\n' + dr.mismatches.map(m => '  ' + m.code + ' ' + m.msg).join('\n'); }

/* ---------------- CLI ---------------- */
function args(argv) {
  const o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    o[k] = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return o;
}
function main(argv) {
  const a = args(argv), cmd = a.pos[0] || 'list';
  if (argv.length === 1 && argv[0] === '--duty') return duty();
  if (cmd === 'list') { const r = report(); return { code: 0, out: a.json ? r : listText(r) }; }
  if (cmd === 'show') {
    const r = report({ brief: !!a.brief }), d = r.departments.find(x => x.id === a.pos[1]);
    if (!d) throw new Refusal('no department "' + (a.pos[1] || '') + '" (departments.js list)');
    return { code: 0, out: a.json ? { ok: true, department: d } : listText(Object.assign({}, r, { departments: [d], unassigned: [], proposals: [] })) };
  }
  if (cmd === 'check') { const r = report(); return { code: r.drift.ok ? 0 : 1, out: a.json ? { ok: r.drift.ok, mismatches: r.drift.mismatches, notes: r.drift.notes } : checkText(r.drift) }; }
  if (cmd === 'proposals') { const open = proposals().filter(p => p.status === 'open'); return { code: 0, out: a.json ? { ok: true, proposals: open } : (open.length ? open.map(p => p.id + '  ' + p.summary + '  (by ' + p.by + ', ' + p.at + ')').join('\n') : 'No open proposals.') }; }
  if (cmd === 'apply') return { code: 0, out: applyProposal(String(a.pos[1] || ''), a) };
  if (cmd === 'reject') return { code: 0, out: rejectProposal(String(a.pos[1] || ''), a) };
  if (['create', 'set-lead', 'add-member', 'remove-member', 'move'].includes(cmd)) return { code: 0, out: change(cmd, a) };
  if (cmd === 'advisor') return { code: 0, out: advisorCmd(a) };
  if (cmd === 'delegation') return { code: 0, out: delegationCmd(a) };
  if (cmd === 'set-route') return { code: 0, out: setRoute(a) };
  if (['brief', 'digest', 'note'].includes(cmd)) return { code: 0, out: deptFile(a, cmd) };
  throw new Refusal('usage: departments.js list|show <id>|check|create <id> --name ..|set-lead <id> <seat|none>|add-member <id> <seat>|remove-member <id> <seat>|move <seat> <id|none>|proposals|apply <pid>|reject <pid>|advisor <id> off|shadow|live|pause|resume|delegation <id> off|shadow|live|workers <s,s>|withdraw|resume|set-route <id> <class> <p/m@e|none>|brief <id> --file f|digest <id> --file f|note <id> --text ".." (--by <name> on every change) | --duty | --selftest');
}
function run(argv) {
  try { return main(argv); }
  catch (e) { if (e instanceof Refusal) return { code: e.code, out: Object.assign({ ok: false, error: e.message, refused: true }, e.extra) }; return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; }
}

/* ---------------- selftest: the pure parts (the CLI and its governance: tests/departments.test.js) ---------------- */
function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  const crew = { ceo: { name: 'Ada', manager: null }, a: { name: 'Bo', manager: 'ceo' }, b: { name: 'Cy', manager: 'a' }, p: { name: 'Pat', manager: 'ceo', functions: ['people'] } };
  const st = D.settings({}, {});
  const doc = { departments: [{ id: 'eng', name: 'Engineering', lead: 'a', members: ['a', 'b'], defaultClass: 'code' }] };
  ok('the framework default has no departments and the documented config', Array.isArray(D.frameworkDefault().departments) && !D.frameworkDefault().departments.length && st.limits.briefMaxChars === 8000 && st.newDepartment.consult.maxPerDay === 12);
  const c1 = plan('create', { pos: ['create', 'ops'], name: 'Operations', class: 'ops' }, doc, crew, st);
  ok('create adds a department with the configured consult defaults', c1.doc.departments[1].id === 'ops' && c1.doc.departments[1].consult.stuckAfterFailedRuns === 2 && c1.created.id === 'ops');
  let e = null; try { plan('add-member', { pos: ['add-member', 'ops', 'b'] }, c1.doc, crew, st); } catch (x) { e = x; }
  ok('a seat already in a department cannot be added to another', e && /already in Engineering/.test(e.message), e && e.message);
  e = null; try { plan('add-member', { pos: ['add-member', 'eng', 'ghost'] }, doc, crew, st); } catch (x) { e = x; }
  ok('an unknown seat is refused', e && /not a seat on the crew/.test(e.message));
  const mv = plan('move', { pos: ['move', 'a', 'ops'] }, c1.doc, crew, st);
  ok('moving the lead leaves the old department without a lead', mv.doc.departments[0].lead === null && mv.doc.departments[1].members.includes('a') && /without a lead/.test(mv.summary));
  ok('set-lead of a non-member adds the member', plan('set-lead', { pos: ['set-lead', 'eng', 'p'] }, doc, crew, st).doc.departments[0].members.includes('p'));
  ok('an unchanged request changes nothing', plan('set-lead', { pos: ['set-lead', 'eng', 'a'] }, doc, crew, st).unchanged === true);
  ok('leadOf: the lead, the manager without a lead, null outside', D.leadOf('b', doc, crew) === 'a' && D.leadOf('b', mv.doc, crew) === 'a' && D.leadOf('a', doc, crew) === 'ceo' && D.leadOf('p', doc, crew) === null);
  console.log(bad ? 'DEPARTMENTS SELFTEST FAILED: ' + bad : 'DEPARTMENTS SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { ASK, run, plan, report, actor, S, Refusal };
if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  if (r.out !== undefined) console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  process.exit(r.code);
}
