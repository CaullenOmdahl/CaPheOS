'use strict';
/* lib/departments.js — departments as data (docs/DEPARTMENTS.md): read company/departments.json, check it against the
 * crew (company/tools/loops.json) and the floor plan (company/FLOOR_PLAN.md), answer "which department, which lead".
 *
 * Read only. The one writer of company/departments.json is company/tools/departments.js (a governed change, recorded with
 * provenance); company/tools/locked-watch.js reports any other write. A missing file means the company has no
 * departments: every reader then behaves exactly as before departments existed (deptOf null, leadOf null).
 *
 *   const D = require('./lib/departments');
 *   D.load({ root?, file? })              -> { exists, file, doc, error? }   (doc.departments always an array)
 *   D.settings(doc)                       -> the effective config: limits, newDepartment, leadModelDefault (file values
 *                                            over the framework default company/defaults/departments.json)
 *   D.deptOf(seat, doc)                   -> the department that lists the seat as a member or as its lead, or null
 *   D.leadOf(seat, doc, crew)             -> the department lead's seat id; the seat's loops.json manager when the
 *                                            department has no lead (or its lead is the seat itself, or has left the
 *                                            crew); null when the seat is in no department or nobody is above it
 *   D.validate(doc, crew)                 -> [{ code, msg, dept?, seat? }]   structural problems (unknown seat, a seat in
 *                                            two departments, a lead who is not a member, bad ids, bad classes, ...)
 *   D.parsePlan(text)                     -> { sections: [{ room, department }], rows: [{ name, department }] }
 *                                            FLOOR_PLAN.md section 1 departments and section 2's Department column
 *   D.drift({ doc, crew, plan, exists })  -> { ok, mismatches: [...], notes: [...] }   validate + loops.json + FLOOR_PLAN
 *   D.CLASSES                             the task classes (lib/taskclass.js owns them when it is present)
 *   D.advisorOf(dept, st)                 the department's effective advisor settings (docs/DEPARTMENTS.md §5): its own
 *                                         `advisor` over settings().advisorDefaults, field by field, plus `effective`:
 *                                         'off' | 'shadow' | 'live' (a paused department acts as 'shadow')
 *   D.consultOf(dept, st)                 the department's consult numbers over newDepartment.consult (stuckOnReopen
 *                                         defaults to true)
 *   D.delegationOf(dept, st)              the department's narrow fan-out settings (docs/DEPARTMENTS.md §6): its own
 *                                         `delegation` over settings().delegationDefaults, field by field, plus
 *                                         `effective`: 'off' | 'shadow' | 'live' (a withdrawn department acts as 'shadow')
 *   D.subtree(lead, crew)                 the seats under a lead in the loops.json manager chain (the lead itself left out)
 *   D.accountableOf(dept, st)             the department's accountable-lead settings (docs/DEPARTMENTS.md §8): its own
 *                                         `accountable` over settings().accountableDefaults, field by field (audit,
 *                                         risk, selfCheck, batch and scorecard one level deeper), plus `effective`:
 *                                         'off' | 'shadow' | 'live' (a withdrawn department acts as 'shadow')
 *
 * Every rule a reader might want to tune lives in the file (limits, newDepartment, leadModelDefault); nothing here
 * hardcodes a seat, a name or a company. Owner: the people function (co.seatFor('people')).
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

// The shared task classes (docs/DEPARTMENTS.md). lib/taskclass.js is their owner; until it exists this is the contract.
const CONTRACT_CLASSES = ['code', 'review', 'research', 'writing', 'design', 'ops', 'mechanical', 'general'];
const CLASSES = (() => { try { const t = require('./taskclass'); if (Array.isArray(t.CLASSES) && t.CLASSES.length) return t.CLASSES.slice(); } catch (_) {} return CONTRACT_CLASSES.slice(); })();
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const CONSULT_KEYS = ['maxPerDay', 'stuckAfterFailedRuns', 'stuckAfterRevise', 'stuckAfterIdleWakes'];
const ADVISOR_MODES = ['off', 'shadow', 'live'];
const DELEGATION_MODES = ['off', 'shadow', 'live'];
// the framework's own fallback for delegationDefaults (docs/DEPARTMENTS.md §6): off, at most 3 workers, 20 minutes each
// maxPieces: the most pieces one split may have (2026-11-19 safety re-review: with no limit a lead's own split of up to 99
// pieces let one run start 50 metered workers over hours); it also caps the workers one lead run may start over all its calls
const DELEGATION_FALLBACK = { mode: 'off', workers: [], maxWorkers: 3, workerTimeoutMin: 20, minPieces: 3, maxPieces: 6, prefer: 'lanes' };
const DELEGATION_NUMS = { maxWorkers: [1, 8], workerTimeoutMin: [5, 240], minPieces: [2, 12], maxPieces: [2, 12] };
// the framework's own fallback for advisorDefaults when neither the company file nor company/defaults/departments.json has it
const ADVISOR_FALLBACK = { mode: 'off', routine: 'advise', batch: { minGapMin: 5, maxWaitMin: 10, startAt: 3 }, packetMaxChars: 4000, premerge: 'advisory',
  autoPause: { enabled: false, minItems: 20, minDays: 14, consultRate: [0.10, 0.40], cachedShareMin: 0.85, oneShotGainPoints: 10, reworkCutShare: 0.20 } };

// accountable leads (docs/DEPARTMENTS.md §8): work enters through the lead, members self-check, the lead's audit is binding.
// audit.routine / audit.risky: the FIXED model pairs a routine or a risky audit runs on (null = leadModelDefault); set only by
// the owner (departments.js accountable <id> audit-model), never by a router, a weekly suggestion or the ranking
const ACCOUNTABLE_MODES = ['off', 'shadow', 'live'];
const ACCOUNTABLE_FALLBACK = { mode: 'off', routine: 'lead audit', audit: { routine: null, risky: null },
  risk: { classes: [], paths: ['secrets/', '.github/', 'company/tools/', 'company/state/', 'Dockerfile', 'container/'], minDiffLines: 400, words: ['money', 'payment', 'credential', 'password', 'secret', 'migration', 'delete', 'production', 'trade', 'order'] },
  selfCheck: { timeoutSec: 600, noteMinChars: 20 }, packetMaxChars: 12000, stallHours: 6,
  batch: { minGapMin: 5, maxWaitMin: 15, startAt: 2 },
  scorecard: { days: 28, spotCheckEvery: 10, minItems: 10, expectedCut: 0.75, fallbackBelowCut: 0.25 } };
const ACCOUNTABLE_DEEP = ['audit', 'risk', 'selfCheck', 'batch', 'scorecard'];
const rootOf = o => path.resolve((o && o.root) || co.ROOT);
const fileOf = o => (o && o.file) || path.join(rootOf(o), 'company', 'departments.json');
const defaultFileOf = o => path.join(rootOf(o), 'company', 'defaults', 'departments.json');
const FRAMEWORK_DEFAULT = co.p('company', 'defaults', 'departments.json');
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fb; } };

function load(o) {
  const file = fileOf(o);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { exists: false, file, doc: { departments: [] } }; }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { exists: true, file, doc: { departments: [] }, error: 'company/departments.json is not valid JSON (' + String(e.message).slice(0, 80) + ')' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { exists: true, file, doc: { departments: [] }, error: 'company/departments.json is not a JSON object' };
  if (!Array.isArray(doc.departments)) doc.departments = [];
  return { exists: true, file, doc };
}
function frameworkDefault(o) { return readJson(defaultFileOf(o), null) || readJson(FRAMEWORK_DEFAULT, {}) || {}; }
/* The effective config: the company file's values over the framework default, field by field. */
function settings(doc, o) {
  const d = frameworkDefault(o), c = doc || {};
  const nd = Object.assign({}, d.newDepartment || {}, c.newDepartment || {});
  nd.consult = Object.assign({}, (d.newDepartment || {}).consult || {}, (c.newDepartment || {}).consult || {});
  return {
    leadModelDefault: c.leadModelDefault || d.leadModelDefault || null,
    newDepartment: nd,
    limits: Object.assign({ briefMaxChars: 8000, digestMaxChars: 8000, proposalsKeep: 50 }, d.limits || {}, c.limits || {}),
    advisorDefaults: mergeAdvisor(mergeAdvisor(ADVISOR_FALLBACK, d.advisorDefaults), c.advisorDefaults),
    delegationDefaults: Object.assign({}, DELEGATION_FALLBACK, isObj(d.delegationDefaults) ? d.delegationDefaults : {}, isObj(c.delegationDefaults) ? c.delegationDefaults : {}),
    accountableDefaults: mergeDeep(mergeDeep(ACCOUNTABLE_FALLBACK, d.accountableDefaults, ACCOUNTABLE_DEEP), c.accountableDefaults, ACCOUNTABLE_DEEP),
  };
}
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/* b over a, field by field; batch and autoPause one level deeper (a company may tune one number) */
function mergeAdvisor(a, b) {
  const out = Object.assign({}, a || {}, isObj(b) ? b : {});
  for (const k of ['batch', 'autoPause']) out[k] = Object.assign({}, (a || {})[k] || {}, isObj(b) && isObj(b[k]) ? b[k] : {});
  return out;
}
function mergeDeep(a, b, keys) {
  const out = Object.assign({}, a || {}, isObj(b) ? b : {});
  for (const k of keys) out[k] = Object.assign({}, (a || {})[k] || {}, isObj(b) && isObj(b[k]) ? b[k] : {});
  return out;
}
const isPair = p => isObj(p) && typeof p.provider === 'string' && !!p.provider && typeof p.model === 'string' && !!p.model;
/* the department's accountable-lead settings over the defaults; effective: what the tools act on (withdrawn = shadow; an
   unknown mode reads as off). audit pairs that are not {provider, model} read as null (the lead model) */
function accountableOf(dept, st) {
  const s = st || settings({});
  const own = dept && isObj(dept.accountable) ? dept.accountable : {};
  const a = mergeDeep(s.accountableDefaults || ACCOUNTABLE_FALLBACK, own, ACCOUNTABLE_DEEP);
  a.mode = ACCOUNTABLE_MODES.includes(String(own.mode || '')) ? String(own.mode) : 'off';
  a.audit = { routine: isPair(a.audit.routine) ? a.audit.routine : null, risky: isPair(a.audit.risky) ? a.audit.risky : null };
  a.withdrawn = isObj(own.withdrawn) ? own.withdrawn : null;
  a.since = own.since || null; a.by = own.by || null;
  a.effective = a.mode === 'off' ? 'off' : a.withdrawn ? 'shadow' : a.mode;
  return a;
}
/* the department's advisor settings over the defaults; effective: what the tools act on (paused = shadow; an unknown
   mode reads as off) */
function advisorOf(dept, st) {
  const s = st || settings({});
  const own = dept && isObj(dept.advisor) ? dept.advisor : {};
  const a = mergeAdvisor(s.advisorDefaults || ADVISOR_FALLBACK, own);
  a.mode = ADVISOR_MODES.includes(String(own.mode || '')) ? String(own.mode) : 'off';
  a.paused = isObj(own.paused) ? own.paused : null;
  a.since = own.since || null; a.by = own.by || null;
  a.effective = a.mode === 'off' ? 'off' : a.paused ? 'shadow' : a.mode;
  return a;
}
/* the department's delegation settings over the defaults; effective: what the tools act on (withdrawn = shadow; an
   unknown mode reads as off; a number outside its range reads as the default) */
function delegationOf(dept, st) {
  const s = st || settings({});
  const base = Object.assign({}, DELEGATION_FALLBACK, (s && s.delegationDefaults) || {});
  const own = dept && isObj(dept.delegation) ? dept.delegation : {};
  const a = Object.assign({}, base, own);
  a.mode = DELEGATION_MODES.includes(String(own.mode || '')) ? String(own.mode) : 'off';
  for (const [k, [lo, hi]] of Object.entries(DELEGATION_NUMS)) { const n = Number(a[k]); a[k] = Number.isInteger(n) && n >= lo && n <= hi ? n : DELEGATION_FALLBACK[k]; }
  a.workers = Array.isArray(own.workers) ? [...new Set(own.workers.map(String))] : [];
  a.prefer = a.prefer === 'dispatch' ? 'dispatch' : 'lanes';
  a.withdrawn = isObj(own.withdrawn) ? own.withdrawn : null;
  a.since = own.since || null; a.by = own.by || null;
  a.effective = a.mode === 'off' ? 'off' : a.withdrawn ? 'shadow' : a.mode;
  return a;
}
/* the seats under a lead in the loops.json manager chain (reports, their reports, ...), the lead itself left out */
function subtree(lead, crew) {
  const c = crew || {}, out = new Set(), L = String(lead || '');
  if (!L) return out;
  for (const id of Object.keys(c)) {
    let m = c[id] && c[id].manager, d = 0;
    while (m && d++ < 32) { if (String(m) === L) { if (id !== L) out.add(id); break; } m = c[m] && c[m].manager; }
  }
  return out;
}
function consultOf(dept, st) {
  const s = st || settings({});
  const c = Object.assign({ stuckOnReopen: true }, (s.newDepartment && s.newDepartment.consult) || {}, dept && isObj(dept.consult) ? dept.consult : {});
  for (const k of CONSULT_KEYS) c[k] = Number.isInteger(c[k]) && c[k] >= 0 ? c[k] : 0;
  c.stuckOnReopen = c.stuckOnReopen !== false;
  return c;
}

const list = doc => ((doc && Array.isArray(doc.departments)) ? doc.departments : []).filter(x => x && typeof x === 'object');
const members = d => (Array.isArray(d.members) ? d.members : []).map(String);
function deptOf(seat, doc) {
  if (!seat) return null;
  const s = String(seat);
  return list(doc).find(d => members(d).includes(s)) || list(doc).find(d => d.lead && String(d.lead) === s) || null;
}
function leadOf(seat, doc, crew) {
  const d = deptOf(seat, doc); if (!d) return null;
  const c = crew || {};
  const lead = d.lead ? String(d.lead) : null;
  if (lead && lead !== String(seat) && c[lead]) return lead;
  const m = c[seat] && c[seat].manager;
  return m ? String(m) : null;
}

function validate(doc, crew) {
  const out = []; const c = crew || {};
  const P = (code, msg, extra) => out.push(Object.assign({ code, msg }, extra || {}));
  if (doc && doc.departments !== undefined && !Array.isArray(doc.departments)) P('BAD_FILE', 'departments must be a list');
  const seen = new Set(), names = new Set(), where = new Map();
  for (const d of list(doc)) {
    const id = String(d.id || '');
    if (!ID_RE.test(id)) P('BAD_ID', 'department id "' + id + '" must be lowercase letters, digits and dashes (2-32, starting with a letter)', { dept: id });
    if (seen.has(id)) P('DUPLICATE_ID', 'department id ' + id + ' is used twice', { dept: id });
    seen.add(id);
    const nm = String(d.name || '').trim();
    if (!nm) P('NO_NAME', 'department ' + id + ' has no name', { dept: id });
    else if (names.has(nm.toLowerCase())) P('DUPLICATE_NAME', 'department name "' + nm + '" is used twice', { dept: id });
    names.add(nm.toLowerCase());
    if (d.members !== undefined && !Array.isArray(d.members)) P('BAD_MEMBERS', 'department ' + id + ': members must be a list of seat ids', { dept: id });
    for (const s of members(d)) {
      if (!c[s]) P('UNKNOWN_SEAT', 'department ' + id + ' lists ' + s + ', who is not on the crew (company/tools/loops.json)', { dept: id, seat: s });
      if (!where.has(s)) where.set(s, id);
      else if (where.get(s) !== id) P('DOUBLE_MEMBER', s + ' is a member of both ' + where.get(s) + ' and ' + id + '; a seat belongs to one department', { dept: id, seat: s });
      else P('DUPLICATE_MEMBER', 'department ' + id + ' lists ' + s + ' twice', { dept: id, seat: s });
    }
    if (d.lead != null) {
      const l = String(d.lead);
      if (!c[l]) P('UNKNOWN_SEAT', 'department ' + id + '\'s lead ' + l + ' is not on the crew', { dept: id, seat: l });
      if (!members(d).includes(l)) P('LEAD_NOT_MEMBER', 'department ' + id + '\'s lead ' + l + ' is not one of its members', { dept: id, seat: l });
    }
    if (d.defaultClass != null && !CLASSES.includes(String(d.defaultClass))) P('BAD_CLASS', 'department ' + id + ': defaultClass "' + d.defaultClass + '" is not a task class (' + CLASSES.join(', ') + ')', { dept: id });
    if (d.routes != null) {
      if (typeof d.routes !== 'object' || Array.isArray(d.routes)) P('BAD_ROUTE', 'department ' + id + ': routes must be an object of class -> { provider, model, effort }', { dept: id });
      else for (const [k, r] of Object.entries(d.routes)) {
        if (!CLASSES.includes(k)) P('BAD_ROUTE', 'department ' + id + ': route for "' + k + '", which is not a task class', { dept: id });
        else if (!r || typeof r !== 'object' || !r.provider || !r.model) P('BAD_ROUTE', 'department ' + id + ': the ' + k + ' route needs provider and model', { dept: id });
      }
    }
    if (d.consult != null) {
      if (typeof d.consult !== 'object' || Array.isArray(d.consult)) P('BAD_CONSULT', 'department ' + id + ': consult must be an object', { dept: id });
      else {
        for (const k of CONSULT_KEYS) if (d.consult[k] != null && !(Number.isInteger(d.consult[k]) && d.consult[k] >= 0)) P('BAD_CONSULT', 'department ' + id + ': consult.' + k + ' must be a whole number >= 0', { dept: id });
        if (d.consult.stuckOnReopen != null && typeof d.consult.stuckOnReopen !== 'boolean') P('BAD_CONSULT', 'department ' + id + ': consult.stuckOnReopen must be true or false', { dept: id });
      }
    }
    if (d.advisor != null) {
      if (!isObj(d.advisor)) P('BAD_ADVISOR', 'department ' + id + ': advisor must be an object', { dept: id });
      else if (d.advisor.mode != null && !ADVISOR_MODES.includes(String(d.advisor.mode))) P('BAD_ADVISOR', 'department ' + id + ': advisor.mode must be one of ' + ADVISOR_MODES.join(', '), { dept: id });
    }
    if (d.delegation != null) {
      const g = d.delegation;
      if (!isObj(g)) P('BAD_DELEGATION', 'department ' + id + ': delegation must be an object', { dept: id });
      else {
        if (g.mode != null && !DELEGATION_MODES.includes(String(g.mode))) P('BAD_DELEGATION', 'department ' + id + ': delegation.mode must be one of ' + DELEGATION_MODES.join(', '), { dept: id });
        if (g.workers != null && !(Array.isArray(g.workers) && g.workers.every(x => typeof x === 'string' && x))) P('BAD_DELEGATION', 'department ' + id + ': delegation.workers must be a list of seat ids', { dept: id });
        for (const [k, [lo, hi]] of Object.entries(DELEGATION_NUMS)) if (g[k] != null && !(Number.isInteger(g[k]) && g[k] >= lo && g[k] <= hi)) P('BAD_DELEGATION', 'department ' + id + ': delegation.' + k + ' must be a whole number from ' + lo + ' to ' + hi, { dept: id });
        if (g.prefer != null && !['lanes', 'dispatch'].includes(String(g.prefer))) P('BAD_DELEGATION', 'department ' + id + ': delegation.prefer must be lanes or dispatch', { dept: id });
      }
    }
    if (d.accountable != null) {
      const g = d.accountable;
      if (!isObj(g)) P('BAD_ACCOUNTABLE', 'department ' + id + ': accountable must be an object', { dept: id });
      else {
        if (g.mode != null && !ACCOUNTABLE_MODES.includes(String(g.mode))) P('BAD_ACCOUNTABLE', 'department ' + id + ': accountable.mode must be one of ' + ACCOUNTABLE_MODES.join(', '), { dept: id });
        if (g.audit != null && !isObj(g.audit)) P('BAD_ACCOUNTABLE', 'department ' + id + ': accountable.audit must be { routine, risky } model pairs', { dept: id });
        else if (g.audit) for (const k of ['routine', 'risky']) if (g.audit[k] != null && !isPair(g.audit[k])) P('BAD_ACCOUNTABLE', 'department ' + id + ': accountable.audit.' + k + ' must be { provider, model, effort? } or null', { dept: id });
      }
    }
  }
  return out;
}

/* ---- FLOOR_PLAN.md: the same two places station-floor.js reads (its departments() and planTable()) ---- */
function section(text, re) { const L = String(text || '').split('\n'), i = L.findIndex(l => re.test(l)); if (i < 0) return ''; let j = L.findIndex((l, k) => k > i && /^## /.test(l)); if (j < 0) j = L.length; return L.slice(i + 1, j).join('\n'); }
const decided = d => !!String(d || '').trim() && !/^[—–-]+$/.test(String(d).trim());
function parsePlan(text) {
  const sections = [];
  for (const l of section(text, /^## 1\./).split('\n')) {
    const m = /^- \*\*([^*]+)\*\*[^:]*:\s*\*\*([^*]+)\*\*/.exec(l);
    if (m) sections.push({ room: m[1].trim(), department: m[2].trim() });
  }
  const rows = [];
  const body = section(text, /^## 2\./).split('\n');
  const t0 = body.findIndex(l => /^\|/.test(l));
  if (t0 >= 0) {
    const cells = l => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim());
    const head = cells(body[t0]).map(s => s.toLowerCase()), ca = head.findIndex(h => h.startsWith('agent')), cd = head.findIndex(h => h.startsWith('department'));
    for (let i = t0 + 2; i < body.length && /^\|/.test(body[i]); i++) {
      const c = cells(body[i]); if (ca < 0 || cd < 0) break;
      rows.push({ name: String(c[ca] || '').split(/\s+[—–-]\s+/)[0].trim(), department: String(c[cd] || '').trim() });
    }
  }
  return { sections, rows };
}

/* drift: departments.json against itself, loops.json and FLOOR_PLAN.md. Reports, never fixes.
 * o: { doc, exists, crew, plan (parsePlan output, or null when there is no FLOOR_PLAN.md), ceo (seat id, exempt from
 *      "unassigned") } */
function drift(o) {
  const doc = o.doc || { departments: [] }, crew = o.crew || {}, mismatches = [], notes = [];
  if (!o.exists) { notes.push({ code: 'NO_FILE', msg: 'company/departments.json does not exist: the company has no departments, nothing to check' }); return { ok: true, mismatches, notes }; }
  for (const p of validate(doc, crew)) mismatches.push(p);
  const depts = list(doc);
  const findDept = name => { const n = String(name || '').trim().toLowerCase(); return depts.find(d => String(d.name || '').trim().toLowerCase() === n || String(d.id || '').toLowerCase() === n) || null; };
  // loops.json: an optional seat.department field must agree; a seat in no department is a note (the CEO is exempt)
  for (const [id, s] of Object.entries(crew)) {
    const d = deptOf(id, doc);
    if (s && s.department != null && String(s.department) !== (d ? String(d.id) : '')) mismatches.push({ code: 'LOOPS_MISMATCH', seat: id, msg: 'loops.json says ' + id + ' is in "' + s.department + '"; departments.json ' + (d ? 'has ' + id + ' in ' + d.id : 'has ' + id + ' in no department') });
    else if (!d && depts.length && id !== o.ceo) notes.push({ code: 'UNASSIGNED', seat: id, msg: id + ' is in no department' });
  }
  // no department defined yet (the empty list founding ships): the feature is not in use, so a FLOOR_PLAN.md that names
  // departments is no drift; reporting each of them every hour would only be noise
  if (!depts.length) { notes.push({ code: 'NOT_IN_USE', msg: 'departments.json lists no departments yet: the floor plan was not compared' }); return { ok: !mismatches.length, mismatches, notes }; }
  if (!o.plan) { notes.push({ code: 'NO_FLOOR_PLAN', msg: 'no company/FLOOR_PLAN.md, so the floor plan was not compared' }); return { ok: !mismatches.length, mismatches, notes }; }
  const onPlan = new Set(), unknown = new Map();   // an unknown department is reported once, with its rooms and people
  const miss = (name, what) => { const k = String(name).trim().toLowerCase(); if (!unknown.has(k)) unknown.set(k, { name: String(name).trim(), rooms: [], people: [] }); unknown.get(k)[what[0]].push(what[1]); };
  for (const s of o.plan.sections) {
    const d = findDept(s.department);
    if (d) onPlan.add(d.id); else miss(s.department, ['rooms', s.room]);
  }
  const byName = n => Object.keys(crew).find(id => String((crew[id] || {}).name || '').trim().toLowerCase() === String(n || '').trim().toLowerCase()) || null;
  for (const r of o.plan.rows) {
    if (!decided(r.department)) continue;
    const d = findDept(r.department), seat = byName(r.name), have = seat ? deptOf(seat, doc) : null;
    if (d) onPlan.add(d.id);
    if (!d) { miss(r.department, ['people', r.name]); continue; }
    if (!seat) { notes.push({ code: 'PLAN_UNKNOWN_SEAT', msg: 'FLOOR_PLAN.md section 2 names ' + r.name + ', who is not on the crew' }); continue; }
    if (!have) mismatches.push({ code: 'PLAN_SEAT_MISMATCH', seat, msg: 'FLOOR_PLAN.md puts ' + r.name + ' in ' + d.name + '; departments.json has ' + seat + ' in no department' });
    else if (have.id !== d.id) mismatches.push({ code: 'PLAN_SEAT_MISMATCH', seat, msg: 'FLOOR_PLAN.md puts ' + r.name + ' in ' + d.name + '; departments.json has ' + seat + ' in ' + (have.name || have.id) });
  }
  for (const u of unknown.values()) mismatches.push({ code: 'PLAN_UNKNOWN_DEPT', name: u.name, ref: 'n-' + require('crypto').createHash('sha256').update(u.name.toLowerCase()).digest('hex').slice(0, 6), msg: 'FLOOR_PLAN.md names a "' + u.name + '" department' + (u.rooms.length ? ' (section 1: ' + [...new Set(u.rooms)].join(', ') + ')' : '') + (u.people.length ? ' (section 2: ' + u.people.join(', ') + ')' : '') + '; departments.json has no such department' });
  for (const d of depts) if (!onPlan.has(d.id)) mismatches.push({ code: 'DEPT_NOT_ON_PLAN', dept: d.id, msg: 'department ' + (d.name || d.id) + ' is not in FLOOR_PLAN.md (section 1 rooms or section 2 Department column)' });
  return { ok: !mismatches.length, mismatches, notes };
}

module.exports = { ACCOUNTABLE_MODES, ACCOUNTABLE_FALLBACK, accountableOf, isPair, CLASSES, CONTRACT_CLASSES, ID_RE, CONSULT_KEYS, ADVISOR_MODES, ADVISOR_FALLBACK, DELEGATION_MODES, DELEGATION_FALLBACK, DELEGATION_NUMS, delegationOf, subtree, advisorOf, consultOf, mergeAdvisor, load, settings, frameworkDefault, list, members, deptOf, leadOf, validate, parsePlan, drift, decided, fileOf };
