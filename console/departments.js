'use strict';
/* console/departments.js — the owner's departments from the browser (Crew › People › Departments; docs/DEPARTMENTS.md).
 * Mounted by console/server.js: require('./departments.js').mount(route, { runApi, bad, owner }).
 *
 *   GET  /api/departments                       departments.js list --json (departments, leads, members, the seats in
 *                                               none, the drift check, open proposals)
 *   POST /api/departments/<id>/lead  { seat }   departments.js set-lead <id> <seat|none> --by <owner>
 *   POST /api/departments/move  { seat, to }    departments.js move <seat> <id|none> --by <owner>
 *   GET  /api/departments/<id>/lead-desk        the lead's desk (docs/DEPARTMENTS.md §5): consult.js status --json --dept
 *                                               <id> (the advice mode, the pause and why, consults today of the limit, the
 *                                               last and next advice, the house ranking's advisor evaluation) and the
 *                                               brief's text (departments.js show <id> --json --brief)
 *   POST /api/departments/<id>/advisor { mode: off|shadow|live } | { pause: true, why? } | { resume: true }
 *                                               departments.js advisor <id> <mode|pause|resume> --by <owner>
 *   GET  /api/departments/<id>/scorecard        the lead's department scorecard (docs/DEPARTMENTS.md §8): accountable.js
 *                                               status --json --dept <id> (plain lines in .words)
 *   POST /api/departments/<id>/accountable { mode: off|shadow|live } | { resume: true }
 *                                               departments.js accountable <id> <mode|resume> --by <owner> (the lead checks
 *                                               every finished job before it counts; the audit models stay in the owner's
 *                                               shell, departments.js accountable <id> audit-model)
 *   POST /api/departments/<id>/delegation { mode: off|shadow|live } | { resume: true }
 *                                               departments.js delegation <id> <mode|resume> --by <owner> (splitting big
 *                                               jobs, docs/DEPARTMENTS.md §6; who the workers are is the CEO's or the
 *                                               owner's shell, departments.js delegation <id> workers)
 *
 * Every write runs the same tool the owner would run in a shell, with --by <owner>; the tool accepts the console as the
 * owner (company/tools/lib/owner.js), refuses an inconsistent change for the owner too, and records it (provenance,
 * decisions.md, the department's DECISIONS.md). All of /api sits behind the console's owner sign-in and CSRF check.
 * Nothing here reads or writes a company file itself.
 */
const ID = /^[a-z][a-z0-9-]{1,31}$/;
const SEAT = /^[A-Za-z0-9_.:-]{1,80}$/;

function mount(route, d) {
  const { runApi, bad, owner } = d;
  const seatArg = (v, what) => { const s = String(v == null ? '' : v).trim(); if (s === '' || s === 'none') return 'none'; if (!SEAT.test(s) || s.startsWith('-')) bad(what + ' must be a seat id'); return s; };
  route('GET', /^\/api\/departments$/, () => runApi('departments.js', ['list', '--json'], { timeout: 20000 }));
  route('POST', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/lead$/, (m, q, b) => {
    if (!ID.test(m[1])) bad('bad department id');
    return runApi('departments.js', ['set-lead', m[1], seatArg(b && b.seat, 'seat'), '--by', owner()], { timeout: 30000 });
  });
  route('POST', /^\/api\/departments\/move$/, (m, q, b) => {
    const seat = seatArg(b && b.seat, 'seat'); if (seat === 'none') bad('seat is required');
    const to = String((b && b.to) == null ? '' : b.to).trim() || 'none';
    if (to !== 'none' && !ID.test(to)) bad('to must be a department id or none');
    return runApi('departments.js', ['move', seat, to, '--by', owner()], { timeout: 30000 });
  });
  route('GET', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/lead-desk$/, async m => {
    if (!ID.test(m[1])) bad('bad department id');
    const [st, show] = await Promise.all([runApi('consult.js', ['status', '--json', '--dept', m[1]], { timeout: 20000 }), runApi('departments.js', ['show', m[1], '--json', '--brief'], { timeout: 20000 })]);
    const desk = ((st && st.departments) || [])[0] || null, d = (show && show.department) || {};
    return { ok: true, dept: m[1], desk, brief: d.briefText == null ? null : String(d.briefText), advisor: d.advisor || null, consultLimits: d.consultLimits || null };
  });
  route('POST', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/advisor$/, (m, q, b) => {
    if (!ID.test(m[1])) bad('bad department id');
    b = b || {};
    if (b.resume === true) return runApi('departments.js', ['advisor', m[1], 'resume', '--by', owner()], { timeout: 30000 });
    if (b.pause === true) return runApi('departments.js', ['advisor', m[1], 'pause', '--by', owner(), '--why', String(b.why || 'the owner paused it').replace(/[\r\n]+/g, ' ').slice(0, 200)], { timeout: 30000 });
    const mode = String(b.mode || '');
    if (!['off', 'shadow', 'live'].includes(mode)) bad('mode must be off, shadow or live (or pause / resume)');
    return runApi('departments.js', ['advisor', m[1], mode, '--by', owner()], { timeout: 30000 });
  });
  route('GET', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/scorecard$/, async m => {
    if (!ID.test(m[1])) bad('bad department id');
    const s = await runApi('accountable.js', ['status', '--json', '--dept', m[1]], { timeout: 20000 });
    return { ok: true, dept: m[1], scorecard: ((s && s.departments) || [])[0] || null };
  });
  route('POST', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/accountable$/, (m, q, b) => {
    if (!ID.test(m[1])) bad('bad department id');
    b = b || {};
    if (b.resume === true) return runApi('departments.js', ['accountable', m[1], 'resume', '--by', owner()], { timeout: 30000 });
    const mode = String(b.mode || '');
    if (!['off', 'shadow', 'live'].includes(mode)) bad('mode must be off, shadow or live (or resume)');
    return runApi('departments.js', ['accountable', m[1], mode, '--by', owner()], { timeout: 30000 });
  });
  route('POST', /^\/api\/departments\/([a-z][a-z0-9-]{1,31})\/delegation$/, (m, q, b) => {
    if (!ID.test(m[1])) bad('bad department id');
    b = b || {};
    if (b.resume === true) return runApi('departments.js', ['delegation', m[1], 'resume', '--by', owner()], { timeout: 30000 });
    const mode = String(b.mode || '');
    if (!['off', 'shadow', 'live'].includes(mode)) bad('mode must be off, shadow or live (or resume)');
    return runApi('departments.js', ['delegation', m[1], mode, '--by', owner()], { timeout: 30000 });
  });
}
module.exports = { mount };
