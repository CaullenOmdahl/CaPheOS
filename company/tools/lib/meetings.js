'use strict';
/* lib/meetings.js — what the rest of the company may know about the owner's meeting (console/meeting.js), read only.
 *
 *   current()        the meeting on record now: { id, type, title, state, running, seats: [ids present], speaking,
 *                    startedAt } or null. No words, no amounts: the minutes are the record.
 *   busy(seat)       the meeting this seat sits in while a round is running, or null. The dispatcher does not wake such
 *                    a seat (no double runs) and does not count it idle; it is woken by the next tick after the round.
 *   liveWork()       [{ kind: 'meeting', ... }] for continuity and the halt screen: a meeting in progress is live work.
 * State: company/state/meetings/ (seats.json, current.json, m/<id>.json). Nothing here writes.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const dir = () => co.p('company', 'state', 'meetings');
function current() {
  const cur = readJ(path.join(dir(), 'current.json'));
  if (!cur || !/^m-[a-z0-9]{4,20}$/.test(String(cur.id || ''))) return null;
  const m = readJ(path.join(dir(), 'm', cur.id + '.json')); if (!m || m.id !== cur.id) return null;
  const std = readJ(path.join(dir(), 'seats.json')) || {};
  const seats = (Array.isArray(std.seats) ? std.seats : []).filter(s => !(m.excused || []).includes(s)).concat((m.guests || []).filter(g => !(std.seats || []).includes(g) && !(m.excused || []).includes(g)));
  return { id: m.id, type: m.type || 'decision', title: m.title || '', state: m.state || 'open', running: !!m.run, opened: !!m.opened, seats,
    speaking: m.run && m.run.current ? m.run.current.seat : null, startedAt: m.startedAt || null };
}
function busy(seat) { const m = current(); return m && m.state === 'open' && m.running && m.seats.includes(seat) ? m : null; }
function liveWork() {
  const m = current();
  if (!m || !m.opened || m.state === 'closed') return [];
  return [{ kind: 'meeting', id: m.id, type: m.type, title: m.title, state: m.state, running: m.running, seats: m.seats.map(id => co.nameOf(id)), speaking: m.speaking ? co.nameOf(m.speaking) : null, since: m.startedAt }];
}
module.exports = { current, busy, liveWork };
