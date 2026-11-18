'use strict';
/* lib/meetings.js — what the rest of the company may know about the owner's meeting (console/meeting.js) and the owner's
 * live chats (console/chat.js, with colleagues brought in: console/huddle.js), read only.
 *
 *   current()        the meeting on record now: { id, type, title, state, running, seats: [ids present], speaking,
 *                    startedAt } or null. No words, no amounts: the minutes are the record.
 *   huddles()        the live chats with colleagues on record: [{ kind: 'huddle', host, id, state, running, opened,
 *                    seats: [host, guests...], speaking, startedAt }]
 *   liveChats()      the plain 1:1 live chat runs in flight: [{ kind: 'chat', seat, runId, since }]
 *   busy(seat)       what holds this seat now, or null: the meeting it sits in while a round runs, a chat with colleagues
 *                    it is in while a round runs ({kind: 'huddle'}), or the owner's 1:1 chat with it while the reply is
 *                    being written ({kind: 'chat'}). The dispatcher does not wake such a seat (no double runs, and no
 *                    routine taking the company folder from under the owner's chat) and does not count it idle; the next
 *                    tick after it wakes the seat as usual.
 *   liveWork()       [{ kind: 'meeting', ... }, { kind: 'huddle', ... }, { kind: 'chat', ... }] for continuity and the halt
 *                    screen: a meeting in progress, a chat with colleagues in it, a 1:1 reply being written. The meeting
 *                    comes first.
 * State: company/state/meetings/ (seats.json, current.json, m/<id>.json); company/state/huddles/<host>/ (the same files,
 * and live.json while a 1:1 run is in flight, checked against company/state/chat-runs.json). Nothing here writes.
 */
const fs = require('fs');
const path = require('path');
const co = require('./company');

const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const SAFE_ID = /^m-[a-z0-9]{4,20}$/, SAFE_HOST = /^[A-Za-z0-9_-]{1,64}$/;
const LIVE_MAX_MS = 3 * 3600e3;   // a live.json older than this with no run record is stale (chat-runs gives up then too)
const dir = () => co.p('company', 'state', 'meetings');
const hudDir = () => co.p('company', 'state', 'huddles');

function roomOf(d, standing) {
  const cur = readJ(path.join(d, 'current.json'));
  if (!cur || !SAFE_ID.test(String(cur.id || ''))) return null;
  const m = readJ(path.join(d, 'm', cur.id + '.json')); if (!m || m.id !== cur.id) return null;
  const std = readJ(path.join(d, 'seats.json')) || {};
  const base = standing || (Array.isArray(std.seats) ? std.seats : []);
  const seats = base.filter(s => !(m.excused || []).includes(s)).concat((m.guests || []).filter(g => !base.includes(g) && !(m.excused || []).includes(g)));
  return { m, seats };
}
function current() {
  const r = roomOf(dir()); if (!r) return null; const m = r.m;
  return { id: m.id, type: m.type || 'decision', title: m.title || '', state: m.state || 'open', running: !!m.run, opened: !!m.opened, seats: r.seats,
    speaking: m.run && m.run.current ? m.run.current.seat : null, startedAt: m.startedAt || null };
}
const hosts = () => { try { return fs.readdirSync(hudDir()).filter(h => SAFE_HOST.test(h)); } catch (_) { return []; } };
function huddles() {
  const out = [];
  for (const host of hosts()) {
    const r = roomOf(path.join(hudDir(), host), [host]); if (!r) continue; const m = r.m;
    out.push({ kind: 'huddle', host, id: m.id, state: m.state || 'open', running: !!m.run, opened: !!m.opened, seats: r.seats,
      guests: r.seats.filter(s => s !== host), speaking: m.run && m.run.current ? m.run.current.seat : null, startedAt: m.startedAt || null });
  }
  return out;
}
function liveChats() {
  const out = []; let runs = null;
  for (const host of hosts()) {
    const l = readJ(path.join(hudDir(), host, 'live.json')); if (!l || !l.runId) continue;
    if (runs === null) runs = ((readJ(co.p('company', 'state', 'chat-runs.json')) || {}).runs) || {};
    const r = runs[l.runId];
    const live = r ? (r.status === 'running' || r.status === 'finishing') : Date.now() - Date.parse(l.at || '') < LIVE_MAX_MS;
    if (live) out.push({ kind: 'chat', seat: host, runId: l.runId, since: l.at || null });
  }
  return out;
}
function busy(seat) {
  const m = current(); if (m && m.state === 'open' && m.running && m.seats.includes(seat)) return m;
  const h = huddles().find(x => x.state === 'open' && x.running && x.seats.includes(seat)); if (h) return h;
  return liveChats().find(x => x.seat === seat) || null;
}
function liveWork() {
  const out = [];
  const m = current();
  if (m && m.opened && m.state !== 'closed') out.push({ kind: 'meeting', id: m.id, type: m.type, title: m.title, state: m.state, running: m.running, seats: m.seats.map(id => co.nameOf(id)), speaking: m.speaking ? co.nameOf(m.speaking) : null, since: m.startedAt });
  for (const h of huddles()) if (h.opened && h.state === 'open' && (h.guests.length || h.running))
    out.push({ kind: 'huddle', id: h.id, host: co.nameOf(h.host), state: h.state, running: h.running, seats: h.seats.map(id => co.nameOf(id)), speaking: h.speaking ? co.nameOf(h.speaking) : null, since: h.startedAt });
  for (const c of liveChats()) out.push({ kind: 'chat', seat: co.nameOf(c.seat), running: true, since: c.since });
  return out;
}
module.exports = { current, huddles, liveChats, busy, liveWork };
