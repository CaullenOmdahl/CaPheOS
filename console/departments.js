'use strict';
/* console/departments.js — the owner's departments from the browser (Crew › People › Departments; docs/DEPARTMENTS.md).
 * Mounted by console/server.js: require('./departments.js').mount(route, { runApi, bad, owner }).
 *
 *   GET  /api/departments                       departments.js list --json (departments, leads, members, the seats in
 *                                               none, the drift check, open proposals)
 *   POST /api/departments/<id>/lead  { seat }   departments.js set-lead <id> <seat|none> --by <owner>
 *   POST /api/departments/move  { seat, to }    departments.js move <seat> <id|none> --by <owner>
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
}
module.exports = { mount };
