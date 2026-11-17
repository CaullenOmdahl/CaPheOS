// Today's crew line for a seat that is not running, from the dispatcher's last decision about it (dispatch.js writes
// dispatch-state.json seats via company/tools/lib/seat-status.js; console/activity.js passes it on as seat.idle):
//   "Founder: paused to make today's budget last — Rohan and Halima are waiting on it."
//   "Nadia farrell: waiting on Founder for 3 items."   "Ingrid Halvorsen: waiting for new work."
import { personName } from './plain.js';
// Pure, no DOM (tested by company/tools/tests/console-idle.test.js).
export function idleLine(s) {
  const r = String((s && s.idle && s.idle.reason) || 'waiting for new work').trim().replace(/\.$/, '');
  return (personName(s && s.name) || 'Someone') + ': ' + r + '.';
}
