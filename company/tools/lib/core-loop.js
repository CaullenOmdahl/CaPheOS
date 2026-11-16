'use strict';
/* core-loop.js — small time helpers shared by the core-loop tools (dispatch, handoff-status, handoff-archive).
 *
 * Handoff headings, Resolved lines and Deadline lines are written as wall-clock "YYYY-MM-DD HH:MM" with no zone. They
 * mean company local time (company.json timezone, co.TZ), never the clock of whatever machine runs the tool.
 */
const co = require('./company');

/* epoch ms of a wall-clock date + "HH:MM" in the company timezone (DST-safe to the minute); NaN if impossible. */
function localToEpoch(date, hm) {
  const guess = Date.parse(date + 'T' + (hm || '00:00') + ':00Z');
  if (!Number.isFinite(guess)) return NaN;
  const lp = co.localParts(new Date(guess));
  const asUtc = Date.parse(lp.date + 'T' + String(lp.hour).padStart(2, '0') + ':' + String(lp.minute).padStart(2, '0') + ':00Z');
  const t = guess - (asUtc - guess);
  // a second pass settles a guess that landed on the other side of a DST change
  const lp2 = co.localParts(new Date(t));
  const back = Date.parse(lp2.date + 'T' + String(lp2.hour).padStart(2, '0') + ':' + String(lp2.minute).padStart(2, '0') + ':00Z');
  return t - (back - guess);
}
/* "YYYY-MM-DD HH:MM" in the company timezone. */
function fmtLocal(d) { const lp = co.localParts(d instanceof Date ? d : new Date(d)); return lp.date + ' ' + lp.time; }

module.exports = { localToEpoch, fmtLocal };
