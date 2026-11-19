/* console/meeting.js — the owner's meeting with the crew, in the console (Chat › Meeting), run the way the owner's
 * terminal table ran (~/.local/lib/cpd/table.js). Spec: docs/MEETINGS.md.
 *
 * The owner speaks; everyone seated answers in turn, the leader first, each seeing everything said before them; turns
 * flow one after another (no Next to press unless the owner picks that pace) and the page streams each one as it is
 * written. A seat with nothing to add passes, shown as one dim line. Turns have tools by default, as at the table (a
 * meeting-wide Talk only switch, and per agenda item). Agents run it like a call with lines at the end of a reply:
 * ASK: <name> — <q> (that seat answers next and may ask back; the others are polled, talk only, for a raised hand),
 * INVITE: / DISMISS: (seat changes for this meeting only), CALL: (the leader gives the floor), END: <summary> (the
 * leader closes the discussion), RULING / ACTION / QUESTION / KILL (the register; "— plain: …" is welcome, not required).
 *
 * Runs: every turn is a station run (POST /api/run, isTask true with the tools placed unless talk only) on the seat's
 * current model (console/chat.js modelFor), admitted through company/tools/lib/admit.js (door 'meeting'), tracked by
 * console/chat-runs.js (detach + observer feed), so a console restart re-attaches to the turn in flight and the meeting
 * carries on from its saved queue; GET <routePrefix>/attach streams the turn in flight. A refused turn is retried once on
 * the seat's next chain entry (lib/refusal.js). A seat in the middle of a routine run still speaks, talk only for that
 * turn. A halt stops the meeting.
 *
 * How hard they think and on which model are the owner's (seats.json think: {level, pin}; POST <routePrefix>/think): one
 * level for every turn (Normal by default; hand checks, the leader's call, Catch me up and Explain Light; Max only on
 * purpose), each person's usual model or one for everyone (a picked model still passes the company's list, the station's
 * override list, the $0 cap and admit; closed = that person sits out, never another model). The cost line carries an
 * estimate for the next round at that setting. No turn is ever cut off: Stop is "after this turn", a leave waits for the
 * speaker's turn to end, a long turn gets one soft nudge (a steer note) and only a run with no output for an hour is
 * ended; only a company hard halt aborts mid-turn.
 *
 * State (company/state/meetings/ by default, mode 600, folders 700): seats.json (standing seats, leader, pace, talk
 * only, frames, observe rounds), current.json ({id}), m/<id>.json (one per meeting: guests, dismissals, observe, cost,
 * the round in progress), events/<id>.jsonl (each meeting's events, read from its end with lib/bounded.js, rolled by
 * retention.js). Minutes: company/work/meetings/meeting-<date>.md, written as it happens. Rulings reach
 * company/work/decisions.md only when the owner confirms them (decision.js add).
 *
 *   const M = require('./meeting.js')(deps); M.mount(route); M.start();
 *   deps: { co, owner(), emit(topic), stationPost, modelFor(seat), runs (chat-runs), run(tool, args), seatBusy(seat),
 *           seatJobs(seat), seatVoice(seat) -> text added after the rules (per-seat point of view; default none),
 *           effortsFor(provider, model) -> the efforts the model offers | null, modelHold(seat, model) -> a hold message | null,
 *           pinCheck(seat, pair) -> null | why (tests; default lib/override-allow.js openFor), onFinalize({state, id, LOG}),
 *           nudgeMs, stallMs, watchTickMs (tests) }
 *   one engine, other rooms (a colleague brought into a live chat): deps may also carry
 *     stateDir (string | () => string), topic (emit topic, default 'meeting'), streamPrefix (default 'meeting-'),
 *     minutesPrefix (default 'meeting-'), routePrefix (default '/api/meeting'), door (admit door, default 'meeting'),
 *     profile { kind, noun, preface(owner) -> text, fixedLeader, standing: [ids] (fixed: the owner's picks join as
 *               guests), wrapHost, maxTurnsPerRound, maxGuests, maxInvites, noRegister, speed, minutesHead(date) }
 *   tests pass runner: { start(o) -> {runId}|{error}, wait(runId, onEvent) -> result, cancel(runId), steer?(runId, text) }
 *   instead of the station
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_INVITES_PER_ROUND = 3, MAX_ASKS_PER_ROUND = 6, MAX_HANDS_PER_ROUND = 3, OBSERVE_ROUNDS = 6, MAX_OBSERVE = 30, MAX_SEATS = 16;
const EVERYONE = new Set(['all', 'everyone', 'table']);
const PLACED = ['cabinet', 'workbench', 'notebook', 'dish'].map(t => ({ objectType: t }));
const HISTORY_MAX_MSGS = 120, HISTORY_MAX_BYTES = 1 << 20;
const LOG_READ_BYTES = 16 << 20;   // the end of log.jsonl read on start (lib/bounded.js); older rows are in the minutes
/* how hard they think (the owner's setting, Meeting › More and in a live chat): one level for every turn, whatever level
   the seat's own work uses; hand checks, the leader's call on hands, Catch me up and Explain always run Light. Max only
   when the owner picks it deliberately (sure: true). The effort sent is the closest one the model offers at or below the
   level (never above it unless the model offers nothing lower). */
const THINK = { light: { effort: 'low', label: 'Light' }, normal: { effort: 'medium', label: 'Normal' }, deep: { effort: 'high', label: 'Deep' }, max: { effort: 'max', label: 'Max' } };
const THINK_DEFAULT = 'normal';
const LIGHT_PURPOSES = new Set(['hand', 'call', 'catchup', 'explain']);
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_WEIGHT = { none: 0.3, minimal: 0.3, low: 0.5, medium: 1, high: 2, xhigh: 3, max: 4 };   // the estimate's rough scale between levels
/* a turn is never cut off: after NUDGE_MS the speaker is asked (a steer note) to finish its point, and only a run with no
   output at all for STALL_MS (a stalled run, the safety ceiling) is ended. Only a company hard halt aborts mid-turn. */
const NUDGE_MS = 10 * 60e3, STALL_MS = 60 * 60e3, WATCH_TICK_MS = 5000;
function fitEffort(want, supported) {
  const rank = e => EFFORT_RANK.indexOf(e);
  const ok = (Array.isArray(supported) ? supported : []).map(String).filter(e => rank(e) >= 0);
  if (!ok.length || ok.includes(want)) return want;
  const below = ok.filter(e => rank(e) <= rank(want)).sort((a, b) => rank(b) - rank(a));
  return below.length ? below[0] : ok.sort((a, b) => rank(a) - rank(b))[0];
}
function parsePin(v) {
  if (v && typeof v === 'object' && typeof v.provider === 'string' && typeof v.model === 'string' && v.provider && v.model) return { provider: v.provider.slice(0, 40), model: v.model.slice(0, 120) };
  const m = /^([a-z0-9_-]{1,40})\/(\S{1,120})$/.exec(String(v || '').trim());
  return m ? { provider: m[1], model: m[2] } : null;
}

/* ---------------- the protocol: pure functions (unit-tested) ---------------- */
const DIRECTIVE = /^[ \t>*_-]*(INVITE|DISMISS|ASK|CALL|LATER|LOWER|END|RULING|ACTION|QUESTION|KILL)\b[*_]*\s*:\s*(.+?)\s*$/gim;
const cleanName = n => String(n || '').replace(/^[@*_`\s]+|[*_`.,:;\s]+$/g, '');
// a line that starts like a protocol line but cannot be read (no colon, an ASK with no question, an END with no
// summary): reported as a parse failure, shown to the owner and to the writer, never silently taken as plain text
const LOOKS_LIKE = /^[ \t>*_-]*\**(INVITE|DISMISS|ASK|CALL|LATER|LOWER|END|RULING|ACTION|QUESTION|KILL)\b(?![*_]*\s*:)\s*[—–-]?\s*(.*)$/gm;
function directives(text) {
  const list = [], failures = [];
  const body = String(text || '').replace(DIRECTIVE, (line, kind, rest) => {
    kind = kind.toUpperCase();
    rest = rest.replace(/^[*_`\s]+/, '');
    if (kind === 'END' || kind === 'RULING' || kind === 'ACTION' || kind === 'QUESTION' || kind === 'KILL') {
      if (!rest.trim()) { failures.push({ line: line.trim(), why: kind + ' needs a line after the colon' }); return ''; }
      list.push({ kind, name: '', why: rest.trim() }); return '';
    }
    if (kind === 'ASK') {
      const m = /^(\S+?)(?:\s+[—–-]+\s+|\s*[:,]\s+|\s+)(.+)$/.exec(rest);
      if (m) list.push({ kind, name: cleanName(m[1]), why: m[2].trim() });
      else failures.push({ line: line.trim(), why: 'ASK needs a name and a question: ASK: <name> — <question>' });
      return '';
    }
    const [names, ...why] = rest.split(/\s+[—–-]+\s+|:\s+|\s+\(/);
    for (const n of names.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean))
      list.push({ kind, name: cleanName(n), why: why.join(' ').replace(/\)\s*$/, '').replace(/[.\s]+$/, '').trim() });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  for (const m of body.matchAll(LOOKS_LIKE)) {
    const k = m[1].toUpperCase();
    if (/^(END|ASK|CALL|INVITE|DISMISS|RULING|ACTION|QUESTION|KILL)$/.test(k) && /^[A-Z]+\b/.test(m[0].trim().replace(/^[>*_\s-]+/, ''))) failures.push({ line: m[0].trim().slice(0, 200), why: k + ' needs a colon: ' + k + ': …' });
  }
  return { body, list, failures };
}
const isPass = t => /^\W*pass\W*$/i.test(String(t || '').trim());
const maybePass = h => String(h).trim().length <= 8 && 'PASS'.startsWith(String(h).toUpperCase().replace(/[^A-Z]/g, ''));
// a raised hand's reason, one line, cut at the last word boundary before 200 characters ("…" when cut)
function clip(t, n) {
  t = String(t || ''); if (t.length <= n) return t;
  const cut = t.slice(0, n - 1); const sp = cut.search(/\s\S*$/);
  return (sp > n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.—–-]+$/, '') + '…';
}
function handReply(t) { const m = /^\W*HAND\b[\s—–:,-]*(.*)$/is.exec(String(t || '').trim()); return m ? clip(m[1].split('\n')[0].trim().replace(/[.\s]+$/, ''), 200) : null; }
function fitHistory(msgs) {
  let m = msgs.slice(-HISTORY_MAX_MSGS);
  while (m.length > 1 && (m[0].role !== 'user' || Buffer.byteLength(JSON.stringify(m)) > HISTORY_MAX_BYTES)) m = m.slice(1);
  return { messages: m, dropped: msgs.length - m.length };
}
function modelLabel(m) {
  if (!m) return '';
  const p = m.provider, id = String(m.model || '');
  if (p === 'claude-cli' || p === 'anthropic') return 'Claude ' + (/haiku/i.test(id) ? 'Haiku' : /sonnet/i.test(id) ? 'Sonnet' : /opus/i.test(id) ? 'Opus' : /fable/i.test(id) ? 'Fable' : id);
  if (p === 'custom' || p === 'minimax') return 'MiniMax (' + id + ')';
  if (p === 'deepseek') return 'DeepSeek (' + id + ')';
  return p + ' ' + id;
}

module.exports = function meeting(deps) {
  const co = deps.co;
  const owner = () => (typeof deps.owner === 'function' ? deps.owner() : null) || (co.config.owner && co.config.owner.name) || 'Owner';
  /* the room: the owner's meeting by default; the same engine runs other rooms (a colleague in a live chat) */
  const P = Object.assign({ kind: 'meeting', noun: 'meeting' }, deps.profile || {});
  const TOPIC = deps.topic || 'meeting';
  const STREAM = deps.streamPrefix || 'meeting-';
  const MIN_PREFIX = deps.minutesPrefix || 'meeting-';
  const ROUTE = deps.routePrefix || '/api/meeting';
  const DOOR = deps.door || 'meeting';
  const emitRaw = typeof deps.emit === 'function' ? deps.emit : () => {};
  const emit = () => emitRaw(TOPIC);
  const MAX_INVITES = Number.isInteger(P.maxInvites) && P.maxInvites > 0 ? P.maxInvites : MAX_INVITES_PER_ROUND;
  const MAX_GUESTS = Number.isInteger(P.maxGuests) && P.maxGuests >= 0 ? P.maxGuests : Infinity;
  const MAX_TURNS = Number.isInteger(P.maxTurnsPerRound) && P.maxTurnsPerRound > 0 ? P.maxTurnsPerRound : Infinity;
  const NOUN = P.noun;
  const LIB = path.join(__dirname, '..', 'company', 'tools', 'lib');
  const REF = require(path.join(LIB, 'refusal.js'));
  const BOUNDED = require(path.join(LIB, 'bounded.js'));
  const admitLib = () => require(path.join(LIB, 'admit.js'));
  const lint = require(path.join(__dirname, 'command-ask.js'));
  /* full profiles (company/tools/lib/profile.js, docs/PROFILES.md §Meetings): each seat's counterpart, its reminder, and
     the company's point-of-view default. deps.profileOf(seat) -> profile | null and deps.pov (tests) override the files. */
  const PROF = () => require(path.join(LIB, 'profile.js'));
  const profileOf = id => { try { return typeof deps.profileOf === 'function' ? deps.profileOf(id) : PROF().load(id, { root: co.ROOT }); } catch (_) { return null; } };
  const povDefault = () => { if (typeof deps.pov === 'boolean') return deps.pov; try { return PROF().policy({ root: co.ROOT }).pov === true; } catch (_) { return false; } };
  const DIR = () => deps.stateDir ? (typeof deps.stateDir === 'function' ? deps.stateDir() : deps.stateDir) : co.p('company', 'state', 'meetings');
  const F = { seats: () => path.join(DIR(), 'seats.json'), current: () => path.join(DIR(), 'current.json'), meta: id => path.join(DIR(), 'm', id + '.json'), events: id => path.join(DIR(), 'events', id + '.jsonl') };
  const SAFE_ID = /^m-[a-z0-9]{4,20}$/;
  const MINUTES_DIR = () => co.p('company', 'work', 'meetings');
  const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const ensureDir = () => { for (const d of [DIR(), path.join(DIR(), 'm'), path.join(DIR(), 'events')]) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch (_) {} } };
  const writeJ = (f, v) => { ensureDir(); const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
  const day = () => co.localParts(new Date()).date, hm = () => co.localParts(new Date()).time;
  const HttpError = deps.HttpError;
  const fail = (msg, status) => { if (HttpError) throw new HttpError(status || 400, msg); const e = new Error(msg); e.status = status || 400; throw e; };

  /* ---------- who ---------- */
  const crew = () => co.crew();
  const ceoId = () => co.ceo();
  function nameOf(id) { if (id === 'owner') return owner(); const s = crew()[id]; return (s && s.name) || id; }
  const firstName = id => String(nameOf(id)).split(/\s+/)[0];
  const titleOf = id => (crew()[id] || {}).title || '';
  const isOwnerKey = k => { const s = String(k || '').toLowerCase().replace(/^@/, ''); const on = owner().toLowerCase(); return s === 'owner' || s === 'you' || s === on || s === on.split(/\s+/)[0]; };
  function resolve(key, by) {
    const k = String(key || '').trim().toLowerCase().replace(/^@/, '').replace(/[.,:;!?]+$/, '');
    if (!k) return null;
    if (by && /^(me|myself|self)$/.test(k)) return by;
    const c = crew();
    if (c[key]) return key;
    const ids = Object.keys(c);
    return ids.find(id => id.toLowerCase() === k) || ids.find(id => String(c[id].name || '').toLowerCase() === k)
      || ids.find(id => String(c[id].name || '').toLowerCase().split(/\s+/)[0] === k) || null;
  }

  /* ---------- state ---------- */
  let std = null, M = null, LOG = [], seq = 0;
  function defaultSeats() {
    if (Array.isArray(P.standing)) return P.standing.filter(x => typeof x === 'string');
    const ids = Object.keys(crew()); const ceo = ceoId();
    return (ceo && ids.includes(ceo) ? [ceo].concat(ids.filter(x => x !== ceo)) : ids).slice(0, 6);
  }
  /* the standing seats and the room's settings. Turns flow as at the table: the pace is 'instant' unless the owner picks
     another (Next stays one of the paces). A seats.json still on 'manual' from the old default moves to 'instant' once
     (speedMigrated); a pace the owner picks after that is kept. Tools are on unless talkOnly; seat frames are off unless
     frames. */
  function loadStd() {
    const c = readJ(F.seats()) || {};
    const DEF = SPEEDS.includes(P.speed) ? P.speed : 'instant';
    let speed = typeof c.speed === 'string' && SPEEDS.includes(c.speed) ? c.speed : DEF, migrate = false;
    if (speed === 'manual' && !c.speedMigrated) { speed = DEF; migrate = true; }
    // a room with fixed standing seats (a live chat: only its host) keeps them; everyone else is a guest
    std = { seats: Array.isArray(P.standing) ? defaultSeats() : Array.isArray(c.seats) ? c.seats.filter(x => typeof x === 'string') : defaultSeats(),
      leader: P.fixedLeader ? P.fixedLeader : 'leader' in c ? (typeof c.leader === 'string' ? c.leader : null) : ceoId(),
      speed, speedMigrated: true, talkOnly: c.talkOnly === true, frames: c.frames === true, pov: typeof c.pov === 'boolean' ? c.pov : null,
      observeRounds: Number.isInteger(c.observeRounds) && c.observeRounds > 0 ? Math.min(c.observeRounds, MAX_OBSERVE) : OBSERVE_ROUNDS,
      think: { level: c.think && THINK[c.think.level] ? c.think.level : THINK_DEFAULT, pin: c.think ? parsePin(c.think.pin) : null } };
    if (migrate) { try { saveStd(); } catch (_) {} }
    return std;
  }
  const saveStd = () => writeJ(F.seats(), Object.assign({}, std, { updatedAt: new Date().toISOString() }));
  const TYPES = ['decision', 'incident', 'planning', 'review'];
  const fresh = (type, title) => ({ v: 2, id: 'm-' + Date.now().toString(36), type: TYPES.includes(type) ? type : 'decision', title: String(title || '').trim().slice(0, 200),
    state: 'open', openedBy: 'owner', startedAt: new Date().toISOString(), opened: false, guests: [], excused: [], observer: false, agenda: [], agendaAt: null,
    cost: { turns: 0, usd: 0 }, ownerHand: false, run: null, resumeAfter: null });
  /* pacing: turns flow (instant) by default, as at the table. The owner may pick a reading pace (fast, normal, slow: a
     pause between completed turns) or Next (manual: each turn waits for Next while the owner is present; when they are
     away it advances at the meeting type's speed). A paused meeting starts nothing new, so it spends nothing. */
  const SPEEDS = ['instant', 'fast', 'normal', 'slow', 'manual'];
  const SPEED_MS = Object.assign({ instant: 0, fast: 2000, normal: 8000, slow: 20000 }, deps.speedMs || {});
  const TYPE_SPEED = { decision: 'normal', incident: 'fast', planning: 'normal', review: 'slow' };
  const PRESENT_MS = 45000;   // the page says the owner is there (tab visible, used in the last 2 minutes) every 20 s
  let lastSeen = 0;
  const ownerPresent = () => Date.now() - lastSeen < PRESENT_MS;
  const effectiveSpeed = () => { const sp = SPEEDS.includes(std.speed) ? std.speed : 'instant'; return sp !== 'manual' || ownerPresent() ? sp : TYPE_SPEED[M.type] || 'normal'; };
  let gateTimer = null;
  // after a completed turn: wait for Next, or the reading time, or the owner's release of a pause; true = wait now
  function gateWait(R) {
    if (R.paused) { save(); emit('meeting'); return true; }
    if (!R.gate) return false;
    const sp = effectiveSpeed();
    if (sp === 'manual') { if (!R.waitNext) { R.waitNext = true; save(); emit('meeting'); } return true; }
    R.waitNext = false;
    const ms = SPEED_MS[sp] || 0;
    if (ms > 0) {
      if (!R.gateUntil) { R.gateUntil = Date.now() + ms; save(); emit('meeting'); }
      const left = R.gateUntil - Date.now();
      if (left > 0) { clearTimeout(gateTimer); gateTimer = setTimeout(kick, left + 5); if (gateTimer.unref) gateTimer.unref(); return true; }
    }
    R.gate = false; R.gateUntil = null; return false;
  }
  function readMeeting(id) { if (!SAFE_ID.test(String(id || ''))) return null; const m = readJ(F.meta(id)); return m && m.id === id ? m : null; }
  function readEvents(id) {
    const out = [];
    try {
      for (const l of BOUNDED.tailText(F.events(id), LOG_READ_BYTES).split('\n')) {
        if (!l.trim()) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; }
        if (r && r.m === id && !r._retention) out.push(r);
      }
    } catch (_) {}
    return out;
  }
  function load(id) {
    loadStd();
    M = readMeeting(id || (readJ(F.current()) || {}).id);
    if (!M) M = fresh();
    if (!M.state) M.state = 'open';
    for (const k of ['guests', 'excused', 'agenda']) if (!Array.isArray(M[k])) M[k] = [];
    for (const k of ['guests', 'excused']) if (!Array.isArray(M[k])) M[k] = [];
    if (!M.cost) M.cost = { turns: 0, usd: 0 };
    LOG = readEvents(M.id);
    seq = LOG.length ? Math.max(...LOG.map(e => e.i || 0)) : 0;
  }
  const save = () => { writeJ(F.meta(M.id), M); writeJ(F.current(), { id: M.id }); };

  const present = () => std.seats.filter(c => !M.excused.includes(c)).concat(M.guests.filter(c => !std.seats.includes(c) && !M.excused.includes(c)));
  const leader = () => std.leader && present().includes(std.leader) ? std.leader : null;
  const ordered = () => { const l = leader(); return l ? [l].concat(present().filter(c => c !== l)) : present(); };
  const observing = () => M.observer === true;
  const invitedBy = id => { for (let i = LOG.length - 1; i >= 0; i--) { const e = LOG[i]; if (e.who === id && e.kind === 'join') return e.by || null; } return null; };
  const seatList = () => [owner() + ' (owner)'].concat(ordered().map(c => {
    const by = M.guests.includes(c) ? invitedBy(c) : null;
    return nameOf(c) + ' (' + (titleOf(c) || 'crew') + (c === leader() ? ', leads the meeting' : '') + (by ? ', invited by ' + nameOf(by) : '') + ')';
  })).join(', ');
  const notHere = () => Object.keys(crew()).filter(id => !present().includes(id)).map(id => nameOf(id) + ' (' + (titleOf(id) || 'crew') + ')').join(', ');

  /* ---------- the record: log + minutes ---------- */
  const joinText = e => nameOf(e.who) + ' joined the ' + NOUN + (e.by ? ', invited by ' + nameOf(e.by) : '') + (e.why ? ': ' + e.why : '');
  const leaveText = e => nameOf(e.who) + ' left the ' + NOUN + (e.by && e.by !== e.who ? ', dismissed by ' + nameOf(e.by) : '') + (e.why ? ': ' + e.why : '');
  const leadText = e => e.who === 'owner' ? owner() + ' set no meeting leader' : owner() + ' made ' + nameOf(e.who) + ' the meeting leader';
  const askText = e => nameOf(e.who) + ' asked ' + nameOf(e.to) + ' directly: ' + e.text;
  const handText = e => nameOf(e.who) + ' raised a hand' + (e.why ? ': ' + e.why : '');
  const callText = e => nameOf(e.who) + ' called on ' + nameOf(e.to) + (e.later ? ', once the exchange is done' : '');
  const lowerText = e => nameOf(e.who) + ' lowered ' + nameOf(e.to) + '\'s hand';
  const endText = e => nameOf(e.who) + ' closed the discussion' + (e.text ? ': ' + e.text : '');
  const rulingText = e => e.who === 'owner' ? owner() + ' ruled: ' + e.text : nameOf(e.who) + ' proposed a ruling for ' + owner() + ' to confirm: ' + e.text;
  const observeText = e => e.on ? owner() + ' is observing: they will not speak unless they step in' : owner() + ' is taking part again';
  const agendaText = e => e.op === 'add' ? 'Agenda item added: ' + e.text + (e.tools ? ' (tools on)' : '') : e.op === 'current' ? 'Now on: ' + e.text + (e.tools ? ' (tools on: people may read and check)' : ' (talk only)') : e.op === 'tools' ? (e.tools ? 'Tools on for "' + e.text + '": people may read and check' : 'Talk only for "' + e.text + '"') : e.op === 'done' ? 'Done: ' + e.text : 'Agenda item removed: ' + e.text;
  const parseText = e => 'The console could not read ' + nameOf(e.who) + '\'s line "' + e.line + '": ' + e.why;
  const closeText = e => (e.state === 'interrupted' ? 'The meeting was interrupted' + (e.why ? ': ' + e.why : '') : 'The meeting was closed by ' + nameOf(e.who) + (e.why ? ': ' + e.why : '')) + (e.echo ? '. ' + e.echo : '');
  const resumeText = e => owner() + ' resumed the meeting';
  const registerText = e => nameOf(e.who) + ' put in the register (' + ({ actions: 'action', questions: 'open question', kills: 'kill condition' }[e.section] || e.section) + ' ' + e.n + '): ' + e.text + (e.plain ? ' — in plain words: ' + e.plain : '');
  const consentText = e => e.op === 'asked' ? nameOf(e.who) + ' asked to use ' + (e.tool || 'a tool') + '; the meeting is paused until you answer it on Today' : 'Approval for ' + nameOf(e.who) + ' (' + (e.tool || 'a tool') + '): ' + (e.decision === 'once' ? 'allowed' : e.decision === 'deny' ? 'declined' : e.decision) + '; the meeting carries on';
  const thinkText = e => owner() + ' set how hard they think to ' + ((THINK[e.level] || {}).label || e.level) + (e.pin ? ', with one model for everyone: ' + modelLabel(e.pin) : ', each on their usual model');
  const TEXTS = { think: thinkText, join: joinText, leave: leaveText, lead: leadText, ask: askText, hand: handText, call: callText, lower: lowerText, end: endText, ruling: rulingText, observe: observeText, agenda: agendaText, parse: parseText, close: closeText, resume: resumeText, consent: consentText, register: registerText, note: e => e.text };
  const minutesRel = d => 'company/work/meetings/' + MIN_PREFIX + (d || day()) + '.md';
  const minutesFile = d => path.join(MINUTES_DIR(), MIN_PREFIX + (d || day()) + '.md');
  function minutes(text, kind) {
    try {
      fs.mkdirSync(MINUTES_DIR(), { recursive: true });
      const f = minutesFile();
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, (P.minutesHead ? P.minutesHead(day()) : '# Meeting: ' + day() + '\n\n_Minutes of the owner\'s meeting with the crew (Chat › Meeting in the console), written as it happens: every word, by who said it, with the time and the model each spoke on. Passes are not shown._') + '\n');
        if (kind !== 'open' && M.opened) fs.appendFileSync(f, '\n## ' + hm() + ': the meeting carries on from ' + String(M.startedAt).slice(0, 10) + '\n\nAt the meeting: ' + seatList() + '.\n');
      }
      fs.appendFileSync(f, text);
    } catch (_) { /* the log still has it */ }
  }
  function record(e) {
    e.m = M.id; e.i = ++seq; e.at = new Date().toISOString();
    LOG.push(e);
    try { ensureDir(); fs.appendFileSync(F.events(M.id), JSON.stringify(e) + '\n', { mode: 0o600 }); } catch (_) {}
    const t = hm();
    if (e.kind === 'say') minutes('\n**' + nameOf(e.who) + '** (' + t + (e.model ? ', ' + e.model : '') + (e.to ? ', answering ' + nameOf(e.to) : '') + (e.interject ? ', interjecting' : '') + (e.explains ? ', explaining for the room' : '') + '):\n' + (e.stance ? '_Stance: ' + e.stance + '_\n' : '') + e.text + '\n', e.kind);
    else if (e.kind === 'draft') minutes('\n<details><summary>' + firstName(e.who) + '\'s first take, before hearing the others (' + t + ')</summary>\n\n' + e.text + '\n\n</details>\n', e.kind);
    else if (e.kind === 'open') { M.opened = true; minutes('\n## ' + t + ': the meeting opens\n\nAt the meeting: ' + e.text + '.\n', e.kind); }
    else if (TEXTS[e.kind]) { const s = TEXTS[e.kind](e); minutes('\n_' + t + ': ' + s + (/[.!?]$/.test(s) ? '' : '.') + '_\n', e.kind); }
    if (e.kind === 'say' || e.kind === 'open' || e.kind === 'agenda') reindex();   // searchable as it goes
    emit('meeting');
    return e;
  }
  const note = text => record({ who: 'console', kind: 'note', text });

  /* ---------- point of view, stance, the gatekeeper's first take (docs/MEETINGS.md "Point of view") ---------- */
  // on when seats.json pov says so, else the company's profile policy (pov: true in the sandbox; absent elsewhere = off)
  const povOn = () => (std && typeof std.pov === 'boolean' ? std.pov : povDefault());
  const cpOf = id => { const p = profileOf(id); return p && p.counterpart && p.counterpart.seat ? p.counterpart : null; };
  // a and b are counterparts when either profile names the other
  const opposed = (a, b) => { const x = cpOf(a), y = cpOf(b); return !!((x && x.seat === b) || (y && y.seat === a)); };
  // the seats this seat checks (their profile names it as counterpart) and are seated now, with the kinds they need signed off
  const checksHere = id => present().filter(o => o !== id).map(o => ({ seat: o, cp: cpOf(o) })).filter(x => x.cp && x.cp.seat === id);
  const RELEVANT = { decision: null, planning: null, review: ['promote', 'merge', 'plan'], incident: [] };   // null: any kind
  function isGatekeeper(id) {
    const want = Object.prototype.hasOwnProperty.call(RELEVANT, M.type) ? RELEVANT[M.type] : null;
    return checksHere(id).some(x => (x.cp.signOff || []).some(k => want === null || want.includes(k)));
  }
  const reminderOf = id => { const p = profileOf(id); if (!p) return ''; try { return PROF().reminder(p, { crew: crew() }); } catch (_) { return ''; } };
  const STANCE_RE = /^\s*[*_]*STANCE[*_]*\s*:\s*(.+?)\s*$/im;
  // the reply's STANCE line (its first non-empty line), taken out of the shown text
  function stanceOf(text) {
    const t = String(text || ''); const lines = t.split('\n'); const i = lines.findIndex(l => l.trim());
    if (i < 0) return { stance: null, body: t };
    const m = lines[i].match(STANCE_RE); if (!m) return { stance: null, body: t };
    return { stance: m[1].replace(/[*_]+$/, '').slice(0, 200), body: lines.slice(i + 1).join('\n').replace(/^\s+/, '') };
  }
  const draftOf = id => (M.run && M.run.round && M.run.round.drafts && M.run.round.drafts[id]) || null;
  // a round the owner started (a new message), and this seat's first turn in it, and it checks someone seated
  const needsDraft = (R, cur) => povOn() && R.round && R.round.fromOwner && cur.item.kind === 'turn' && !cur.item.wrap && !cur.item.followUp && !(R.round.drafts || {})[cur.seat] && isGatekeeper(cur.seat);
  function draftMessages(id) {
    const o = owner(); let msg = '';
    for (let i = LOG.length - 1; i >= 0; i--) if (LOG[i].kind === 'say' && LOG[i].who === 'owner') { msg = LOG[i].text; break; }
    const it = currentItem(), voice = voiceOf(id), rem = reminderOf(id);
    return [{ role: 'user', content: '[A PRIVATE FIRST TAKE] ' + (voice ? voice + '\n\n' : '') + 'You are ' + nameOf(id) + (titleOf(id) ? ', ' + titleOf(id) : '') + ', at ' + o + '\'s ' + NOUN + '. ' + o + ' said to the table: "' + String(msg).slice(0, 4000) + '"' + (M.title ? ' Topic: ' + M.title + '.' : '') + (it ? ' Agenda item now: ' + it.title + '.' : '')
      + '\n\nWrite your own position before you read anyone else: two to four sentences. Nobody else at the table sees it; ' + o + ' can read it folded, and you will see it again on your turn.' + (rem ? '\n\n' + rem : '') }];
  }
  async function firstTake(R, cur) {
    const r = await oneRun({ seat: cur.seat, model: cur.model, messages: draftMessages(cur.seat), tools: false, purpose: 'draft' });
    const text = r && !r.error && !r.refused ? String(directives(String(r.text || '')).body || '').trim().slice(0, 2000) : '';
    R.round.drafts = Object.assign({}, R.round.drafts || {}, { [cur.seat]: text || '(no first take)' });
    if (text) record({ who: cur.seat, kind: 'draft', text, round: R.round.no || null });
    save();
  }
  /* echo stats at close (no model call): per seat the share of replies with a stance; per pair the word-trigram overlap of
     consecutive replies; stances that changed in a reply that cites no new fact (no number, link or file) */
  function echoStats() {
    const says = LOG.filter(e => e.kind === 'say' && e.who !== 'owner' && e.who !== 'console' && !e.explains);
    const seats = {}, pairs = {}, shifts = [];
    const tri = t => { const w = String(t || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean); const s = new Set(); for (let i = 0; i + 2 < w.length; i++) s.add(w[i] + ' ' + w[i + 1] + ' ' + w[i + 2]); return s; };
    const jac = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
    const last = {};
    for (let i = 0; i < says.length; i++) {
      const e = says[i], s = seats[e.who] = seats[e.who] || { replies: 0, withStance: 0 };
      s.replies++; if (e.stance) s.withStance++;
      if (i > 0 && says[i - 1].who !== e.who) { const k = [says[i - 1].who, e.who].sort().join('|'); const p = pairs[k] = pairs[k] || { n: 0, sum: 0 }; p.n++; p.sum += jac(tri(says[i - 1].text), tri(e.text)); }
      const norm = x => String(x || '').toLowerCase().replace(/—.*$/, '').replace(/[^a-z0-9 ]/g, '').trim();
      if (e.stance && last[e.who] && norm(last[e.who]) !== norm(e.stance) && !/\d|https?:\/\/|\b[\w-]+\.(?:md|js|json|csv|py|txt)\b/.test(String(e.text || ''))) shifts.push({ seat: e.who, from: last[e.who], to: e.stance, i: e.i });
      if (e.stance) last[e.who] = e.stance;
    }
    const r4 = x => Math.round(x * 10000) / 10000;
    return { seats: Object.fromEntries(Object.entries(seats).sort().map(([k, v]) => [k, Object.assign(v, { share: v.replies ? r4(v.withStance / v.replies) : null })])),
      pairs: Object.entries(pairs).sort().map(([k, v]) => ({ seats: k.split('|'), replies: v.n, overlap: r4(v.sum / v.n) })), unexplainedShifts: shifts };
  }
  function echoLine(st) {
    const tot = Object.values(st.seats).reduce((a, s) => [a[0] + s.withStance, a[1] + s.replies], [0, 0]);
    const hi = st.pairs.slice().sort((a, b) => b.overlap - a.overlap)[0];
    return 'Echo check: ' + tot[0] + ' of ' + tot[1] + ' replies stated a stance' + (hi ? '; the most similar pair was ' + hi.seats.map(nameOf).join(' and ') + ' (' + Math.round(100 * hi.overlap) + '% of phrases shared)' : '') + (st.unexplainedShifts.length ? '; ' + st.unexplainedShifts.length + ' change(s) of position with no new fact cited' : '');
  }

  /* ---------- what each seat is sent ---------- */
  /* the table's rules (~/.local/lib/cpd/table.js PRE), for the console: speak as yourself, short, by name; PASS; check
     facts but do no long work here; the leader; the call lines. A room's profile may add a preface (a colleague brought
     into a live chat), and deps.seatVoice(seat) adds that seat's own point of view after the rules. */
  const PRE = () => {
    const o = owner(), N = NOUN;
    const pre = typeof P.preface === 'function' ? P.preface(o) : P.preface;
    return '[THE TABLE] ' + (pre ? pre : 'The owner, ' + o + ', has called the company to the table: a meeting in the console (Chat › Meeting, behind the owner\'s sign-in; not a relayed message).') + ' Everyone at the table sees everything said there; each message is labelled with who said it, and people take turns. ' + o + ' opened this ' + N + ', so speaking here is not contacting the owner; what you need from ' + o + ' outside it still goes to the CEO or the owner channel.\n' +
    'When it is your turn:\n' +
    '- Speak as yourself, from your own area, as you would in a meeting: short and to the point, a few sentences unless ' + o + ' asks for more. Answer what was put to you; agree, disagree or build on what the others said, by name; do not repeat what someone has already covered.\n' +
    '- If you have nothing to add, reply with exactly PASS and nothing else.\n' +
    '- Check the facts you state (read what you need), but do not start long work during the ' + N + ': say what you will do, write it where your own loop will pick it up (your files or a handoff), and do it there. When the turn note says you have no tools, say only what you know and never claim you read or changed something.\n' +
    '- ' + o + ' is not technical: infrastructure, tools and internal process are the crew\'s to settle among yourselves or route, never ' + o + '\'s, and ' + o + ' never runs a command.\n' +
    '- The ' + N + ' may have a leader (each turn note names them). The leader runs it: keeps it on the owner\'s question, brings in the right people, and closes each topic with what was decided and who does what.\n' +
    (P.noRegister ? '- What ' + o + ' decides here is an owner ruling; everyone writes down only what is theirs to do, in their own files or a handoff.\n'
      : '- What ' + o + ' decides here is an owner ruling. The leader proposes it with a line of its own: RULING: <what was decided, who does it>; ' + o + ' confirms it (only then is it in company/work/decisions.md). Everyone else writes down only what is theirs to do, with lines of their own: ACTION: <what> — by <date, or own loop>; QUESTION: <an open question of yours>; KILL: <a condition that would stop the work>. You may add "— plain: <one sentence anyone can read>" to any of them. With no leader, whoever a ruling concerns writes it.\n') +
    '- To ask someone a question directly, end your reply with a line of its own: ASK: <name> — <your question>. They answer next and may ASK you back; keep such an exchange short and to the point. While two people are in an exchange, the others are asked after each answer whether they want to interject; when you are, reply HAND — <what you want to add> if you need to come in now, otherwise NO. The leader calls on raised hands (with no leader, a raised hand gets the floor next); the leader can also give anyone the floor by ending a reply with CALL: <name>.\n' +
    '- When the owner is observing (the turn note says so), ' + o + ' will not speak unless they step in: do not put questions to them or wait for their answer, and keep the discussion going among yourselves. The leader runs it through to a result and, when it is complete, ends a reply with a line of its own: END: <one line on what was decided and who does what>. With no leader, anyone may close it that way.\n' +
    '- You can bring people in and out, as on a call. To invite someone from the company who is not at the table, end your reply with a line of its own: INVITE: <name> — <why the discussion needs them>. To dismiss someone whose part is done (yourself included, when you have nothing more to give), end with: DISMISS: <name> — <why>. An invited person joins at once, sees the ' + N + ' so far and speaks after the others this round; a dismissed person leaves this ' + N + '. Invite only when the discussion needs that person, not to be thorough. The leader stays unless the owner changes it.\n' +
    (povOn() ? '- Start every reply with a line of its own: STANCE: <your position in a few words> — <what your counterpart wants, if they are here>. Then speak, as yourself only: never write lines for anyone else at the table, and do not just agree; say where you differ, and change your position only for a new fact you name.\n' : '') +
    '- The minutes, every word as said, are in company/work/meetings/' + MIN_PREFIX + '<date>.md, so anyone can read it later.]';
  };
  /* tools are on by default, as at the table (a run reads and checks); the owner's Talk only switch turns them off for the
     whole meeting, and an agenda item can set its own (tools: true / false; null follows the meeting) */
  const currentItem = () => (M.agenda || []).find(a => a.id === M.agendaAt) || null;
  const toolsOn = () => { const it = currentItem(); return it && typeof it.tools === 'boolean' ? it.tools : !std.talkOnly; };
  const TYPE_BLOCK = {
    decision: 'This is a decision meeting: bring it to a choice %OWNER% can rule on.',
    incident: 'This is an incident meeting: what is broken, what stops the harm now, and who does what next.',
    planning: 'This is a planning meeting: agree what gets done, by whom and by when.',
    review: 'This is a review meeting: what happened against the plan, and what changes.',
  };
  /* seat frames (company/defaults/work/meetings/frames.json, a company override in company/work/meetings/frames.json):
     each turn names the speaker's own function and what the others in the room need from it, from loops.json functions.
     Off by default (the table had none); the owner switches them on (seats.json frames). Explain for the room uses them. */
  function frames() {
    const d = readJ(path.join(__dirname, '..', 'company', 'defaults', 'work', 'meetings', 'frames.json')) || {}, o = readJ(co.p('company', 'work', 'meetings', 'frames.json')) || {};
    return Object.assign({}, d.functions || {}, o.functions || {});
  }
  function frameOf(id, F) {
    const fns = ((crew()[id] || {}).functions || []).filter(f => F[f]);
    return fns.length ? { labels: fns.map(f => F[f].label), needs: fns.map(f => F[f].needs) } : { labels: [titleOf(id) || 'their own area'], needs: ['what it means for ' + (titleOf(id) ? 'the ' + titleOf(id) + ' work' : 'their work')] };
  }
  function roomLine(id) {
    if (!std.frames) return '';
    const F = frames(); const me = frameOf(id, F);
    const others = present().filter(x => x !== id).map(x => { const f = frameOf(x, F); return nameOf(x) + ' (' + f.labels.join(', ') + ': needs ' + f.needs.join('; ') + ')'; });
    return ' [Your seat: ' + me.labels.join(', ') + '. In the room: ' + (others.length ? others.join('; ') : 'nobody else') + '. Say what your point means for each of them.]';
  }
  // the company's language (company.json locale): every seat speaks it
  function localeLine() {
    const loc = String((co.config && co.config.locale) || '').trim(); if (!loc || /^en(\b|-)/i.test(loc)) return '';
    let name = loc; try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(loc) || loc; } catch (_) {}
    return ' Speak ' + name + ' (the company\'s language, company.json locale ' + loc + '); protocol words (ASK, PASS, END, …) stay in English.';
  }
  const typeBlock = () => P.kind !== 'meeting' ? '' : (TYPE_BLOCK[M.type] || TYPE_BLOCK.decision).replace('%OWNER%', owner());
  function context(noTools) {
    const l = leader(), others = notHere(), it = currentItem(), tb = typeBlock(), N = NOUN;
    return 'At the table now: ' + seatList() + '.' + (l ? ' ' + nameOf(l) + ' leads the ' + N + '.' : ' There is no leader.')
      + (tb ? ' ' + tb : '') + (M.title ? ' Topic: ' + M.title + '.' : '') + (it ? ' Agenda item now: ' + it.title + '.' : '')
      + (observing() ? ' ' + owner() + ' is observing: they will not speak unless they step in, so do not put questions to them or wait for them.' : '')
      + (noTools ? '' : toolsOn() ? '' : ' Talk only: nobody has tools in this part of the ' + N + '; say only what you know and never claim you read or changed something.')
      + (others ? ' Not at the table (you may INVITE them): ' + others + '.' : '');
  }
  // console notes for this seat on its last reply: lines that could not be read, a register line with no plain part, a
  // reply that broke the owner-scope rule (the chat lint); shown to it on its next turn
  function lintLine(id) {
    const parse = [], nudge = [];
    for (let i = LOG.length - 1; i >= 0; i--) {
      const e = LOG[i];
      if (e.kind === 'parse' && e.who === id) { parse.push(e); continue; }
      if (e.kind === 'nudge' && e.who === id) { nudge.push(e); continue; }
      if (e.who !== id || (e.kind !== 'say' && e.kind !== 'pass')) continue;
      const p = parse.length ? ' [Console note: these lines of your last reply could not be read, so nothing was done with them: ' + parse.map(x => '"' + x.line + '" (' + x.why + ')').join('; ') + '. Write each on a line of its own, exactly as the protocol says.]' : '';
      const n = nudge.length ? ' [Console note: ' + nudge.map(x => x.text).join(' ') + ']' : '';
      const sn = e.kind === 'say' && e.nostance ? ' [Console note: your last reply had no STANCE line. Start every reply with STANCE: <your position> — <what your counterpart wants>.]' : '';
      if (!e.lint) return p + n + sn;
      return p + n + sn + ' [Console note on your last reply: ' + e.lint.why + '. ' + (e.lint.kind === 'observe-question' ? owner() + ' is observing: put the question to the people seated, or settle it yourselves.' : 'That is the crew\'s, not the owner\'s: settle it among yourselves or route it.') + ']';
    }
    return '';
  }
  const BUSY_NOTE = ' [You are in the middle of a routine run, so you have no tools this turn: say what you know.]';
  function turnLine(id, item, ctl, noTools) {
    const n = nameOf(id), isLead = id === leader();
    const upList = Object.entries((ctl && ctl.up) || {});
    const up = upList.length ? upList.map(([c, why]) => nameOf(c) + (why ? ' (' + why + ')' : '')).join('; ') : '';
    const lead = isLead ? ' You lead this ' + NOUN + '.' + (up ? ' Hands up: ' + up + '; end your reply with CALL: <name> to give one the floor.' : '')
      + (observing() ? ' Move it to a result; when the discussion is complete, end your reply with END: <what was decided and who does what>.' : '') : '';
    const dr = povOn() ? draftOf(id) : null, rem = povOn() ? reminderOf(id) : '';
    const tail = sinceNote(id) + (noTools ? BUSY_NOTE : '') + lintLine(id) + roomLine(id) + localeLine()
      + (dr ? ' [Your first take, before you read the others: "' + clip(dr, 1200) + '" Has anything said since given you new evidence? Say which, or hold your position.]' : '')
      + (rem ? '\n\n' + rem : '');
    const ctx = context(noTools);
    if (item.kind === 'ask') return '[' + nameOf(item.from) + ' asked you directly: ' + item.text + ' Answer ' + nameOf(item.from) + ', ' + n + '; you may ASK back.' + lead + ' ' + ctx + ']' + tail;
    if (item.kind === 'hand') return '[' + (item.calledBy ? nameOf(item.calledBy) + ' called on you' : 'You raised your hand') + (item.why ? ' (' + item.why + ')' : '')
      + ' and you have the floor, ' + n + ': make your point briefly.' + lead + ' ' + ctx + ']' + tail;
    if (item.wrap) return '[The others have spoken, ' + n + '. Close the loop for ' + owner() + ': say what you learned and what it means for what they asked, briefly; or reply PASS.' + lead + ' ' + ctx + ']' + tail;
    if (item.followUp) return '[' + (observing() ? 'Open round, carried on without ' + owner() + ', who is observing.' : 'No new message from ' + owner() + ': this is an open round for the table to answer each other.')
      + ' Your turn, ' + n + ': add to, answer or challenge what was said' + (observing() ? ', or move the discussion to its next point' : '') + '; or reply PASS.' + lead + ' ' + ctx + ']' + tail;
    return '[Your turn, ' + n + '.' + (item.addressed && item.addressed.length ? ' ' + owner() + ' put this to ' + item.addressed.map(nameOf).join(', ') + '.' : '')
      + lead + ' ' + ctx + ' Reply PASS if you have nothing to add.]' + tail;
  }
  function voiceOf(id) {
    if (typeof deps.seatVoice !== 'function') return '';
    try { const v = deps.seatVoice(id); return typeof v === 'string' ? v.trim() : ''; } catch (_) { return ''; }
  }
  // with point of view on, each seat's history is a projection of the one stored log: its counterpart's lines labelled
  // "<Name>, your counterpart, said:", the owner's "<Owner> (the owner) said:", its own past lines its own (assistant)
  // turns; a draft (a gatekeeper's private first take) is never in anyone's history
  function historyFor(id, lastLine) {
    const msgs = []; let buf = []; const pov = povOn();
    const flush = () => { if (buf.length) { msgs.push({ role: 'user', content: buf.join('\n\n') }); buf = []; } };
    for (const e of LOG) {
      if (e.who === id && (e.kind === 'say' || e.kind === 'pass')) {
        flush();
        const content = e.kind === 'pass' ? 'PASS' : e.text, last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') last.content += '\n\n' + content; else msgs.push({ role: 'assistant', content });
      }
      else if (e.kind === 'say' && pov) buf.push((e.who === 'owner' ? owner() + ' (the owner)' : nameOf(e.who) + (opposed(id, e.who) ? ', your counterpart,' : '')) + (e.to ? (e.to === id ? ' (answering you)' : ' (answering ' + nameOf(e.to) + ')') : '') + (e.interject ? ' (interjecting)' : '') + (e.explains ? ' (explaining for the room)' : '') + ' said' + (e.stance ? ' (stance: ' + e.stance + ')' : '') + ': ' + e.text);
      else if (e.kind === 'say') buf.push(nameOf(e.who) + (e.who === 'owner' ? ' (owner)' : '') + (e.to ? ' (answering ' + nameOf(e.to) + ')' : '') + (e.interject ? ' (interjecting)' : '') + (e.explains ? ' (explaining for the room)' : '') + ': ' + e.text);
      else if (e.kind === 'open') buf.push('[The ' + NOUN + ' opened. At the table: ' + e.text + '.]');
      else if (e.kind !== 'ask' && e.kind !== 'pass' && e.kind !== 'nudge' && e.kind !== 'think' && TEXTS[e.kind]) buf.push('[' + TEXTS[e.kind](e) + '.]');
    }
    buf.push(lastLine); flush();
    const fit = fitHistory(msgs); const out = fit.messages;
    if (out[0].role !== 'user') out.unshift({ role: 'user', content: '' });
    const voice = voiceOf(id);
    out[0] = { role: 'user', content: PRE() + (voice ? '\n' + voice : '') + '\n[You are ' + nameOf(id) + (titleOf(id) ? ', ' + titleOf(id) : '') + '. The company folder is your project root; company tools run as `node company/tools/<tool>.js`.]\n\n'
      + (fit.dropped ? '[The earliest part of this ' + NOUN + ' is left out here; it is long. The full minutes are in company/work/meetings/.]\n\n' : '') + out[0].content };
    return out;
  }
  /* STAY IN THE ROOM (owner, 2026-11-19): every turn ends with where the discussion is now, so a speaker builds on the
     latest instead of re-answering. Runs start only when it is that seat's turn (no draft-ahead), from the whole log;
     this note says what changed since the seat last spoke and which questions are already answered. */
  const SINCE_MAX = 8;
  function sinceNote(id) {
    let from = 0;
    for (let i = LOG.length - 1; i >= 0; i--) { const e = LOG[i]; if (e.who === id && (e.kind === 'say' || e.kind === 'pass')) { from = i + 1; break; } }
    const win = LOG.slice(from), said = [], answered = [], mine = [];
    for (let i = 0; i < win.length; i++) {
      const e = win[i];
      if (e.kind === 'say' && e.who !== id) said.push(nameOf(e.who) + (e.who === 'owner' ? ' (owner)' : '') + (e.to ? ' (answering ' + nameOf(e.to) + ')' : '') + ': ' + clip(String(e.text || '').replace(/\s+/g, ' ').trim(), 140).replace(/\.+$/, ''));
      else if ((e.kind === 'join' || e.kind === 'leave') && e.who !== id) said.push('[' + TEXTS[e.kind](e) + ']');
      if (e.kind === 'ask' && e.to && e.to !== id) {
        const by = win.slice(i + 1).find(x => x.kind === 'say' && x.who === e.to);
        if (by) answered.push(nameOf(e.who) + ' asked ' + nameOf(e.to) + ' "' + clip(e.text, 100) + '": ' + firstName(e.to) + ' answered it');
      }
      if (e.kind === 'say' && e.who === 'owner') {
        const by = []; for (const x of win.slice(i + 1)) { if (x.kind === 'say' && x.who === 'owner') break; if (x.kind === 'say' && x.who !== id && !by.includes(x.who)) by.push(x.who); }
        const q = owner() + '\'s "' + clip(String(e.text || '').replace(/\s+/g, ' ').trim(), 100) + '"';
        // put to this seat by name: the others' answers do not answer for it; it gives its own, adding what is new
        if (by.length && Array.isArray(e.only) && e.only.includes(id)) mine.push(q + ' was put to you by name; ' + by.map(nameOf).join(', ') + ' already answered: give your own answer, adding only what is new');
        else if (by.length) answered.push(q + ': answered by ' + by.map(nameOf).join(', '));
      }
    }
    const list = said.length > SINCE_MAX ? ['(' + (said.length - SINCE_MAX) + ' earlier, above)'].concat(said.slice(-SINCE_MAX)) : said;
    return ' [' + (list.length ? 'Since you last spoke: ' + list.join(' | ') + '. ' : '')
      + (answered.length ? 'Questions already answered: ' + answered.join('; ') + '. ' : '')
      + (mine.length ? mine.join('; ') + '. ' : '')
      + 'Reply to where the discussion is now: build on or disagree with the latest; do not re-answer' + (mine.length ? ' what others said' : '') + '.]';
  }
  function hasNewFor(id) {
    for (let i = LOG.length - 1; i >= 0; i--) {
      const e = LOG[i];
      if (e.who === id && (e.kind === 'say' || e.kind === 'pass')) return false;
      if (e.who !== id && (e.kind === 'say' || e.kind === 'join' || e.kind === 'leave')) return true;
    }
    return false;
  }
  // "@sharon @phil ..." at the START of a message puts it to those seats only (@all: everyone)
  function mentions(text) {
    const at = [], missing = [], unknown = [];
    const lead = String(text).match(/^\s*((?:@[A-Za-z][\w-]*[\s,:;]*)+)/);
    let everyone = false;
    if (lead) for (const m of lead[1].matchAll(/@([A-Za-z][\w-]*)/g)) {
      if (EVERYONE.has(m[1].toLowerCase())) { everyone = true; continue; }
      const id = resolve(m[1]);
      if (!id) { unknown.push('@' + m[1]); continue; }
      if (present().includes(id)) { if (!at.includes(id)) at.push(id); } else if (!missing.includes(nameOf(id))) missing.push(nameOf(id));
    }
    return { at: everyone ? [] : at, missing, unknown, addressed: !!lead && !everyone };
  }
  // the owner-scope lint (console/command-ask.js, the chat's): crew work put to the owner, a command for the owner, and
  // with the owner observing, any question to them
  function lintOf(text, list) {
    try {
      const ca = lint.commandAsk(text); if (ca) return { kind: 'command', why: 'it asks ' + owner() + ' to run a command (' + ca.command + ')', command: ca.command, action: ca.action };
      const oa = lint.ownerAsk(text); if (oa) return { kind: oa.kind, why: oa.kind === 'crew-scope' ? 'it puts crew work to ' + owner() + ' (' + oa.why + ')' : 'it asks ' + owner() + ' in technical words', route: oa.route, question: oa.question };
      if (observing()) {
        const q = lint.observeAsk(text, owner()) || ((list || []).find(d => d.kind === 'ASK' && isOwnerKey(d.name)) ? { question: 'ASK: ' + owner() } : null);
        if (q) return { kind: 'observe-question', why: 'it puts a question to ' + owner() + ', who is observing', question: q.question };
      }
    } catch (_) {}
    return null;
  }

  /* ---------- runs: the station (default) or a test's runner ---------- */
  const RUNS = deps.runs;
  const active = new Set();   // runIds in flight (the turn and any hand checks), for a hard halt
  const checks = new Set();   // the hand checks and the leader's call in flight: not turns, so Stop cancels them
  const stationRunner = {
    start(o) {
      return new Promise(resolve => {
        let token = null; try { token = co.stationToken(); } catch (_) {}
        if (!token) return resolve({ error: 'no station token (secrets/station-token)' });
        const streamId = STREAM + o.seat + (o.purpose === 'turn' ? '' : '-' + o.purpose);
        const payload = { agentId: o.seat, model: o.model.model, provider: o.model.provider, rosterSystem: true, isTask: !!o.tools, streamId, messages: o.messages, projectRoot: co.ROOT };
        if (o.tools) payload.placed = PLACED;
        if (o.model.effort) payload.reasoningEffort = o.model.effort;
        const tk = o.ticket || null;
        RUNS.prepare(streamId, { seat: o.seat, meeting: M.id, purpose: o.purpose, userText: '', model: o.model.model, provider: o.model.provider }).then(prep => {
          if (prep.source === 'observe') payload.detach = true;
          let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
          prep.started.then(runId => fin({ runId }));
          const u = new URL(co.STATION_URL.replace(/\/+$/, '') + '/api/run'); const data = JSON.stringify(payload);
          const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-starnet-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'application/x-ndjson' } }, ur => {
            try { admitLib().started(tk, { status: ur.statusCode }); } catch (_) {}
            if (ur.statusCode !== 200) { let d = ''; ur.on('data', c => { d += c; }); ur.on('end', () => { prep.cancel(); let msg = d.trim(); try { const j = JSON.parse(msg); msg = j.error || j.reason || msg; } catch (_) {} fin({ error: 'the station refused the run (HTTP ' + ur.statusCode + '): ' + String(msg || 'no reason').slice(0, 300) }); }); return; }
            ur.setEncoding('utf8'); let buf = '', mine = null, sawEnd = false;
            const each = l => {
              let ev; try { ev = JSON.parse(l); } catch (_) { return; } if (!ev || !ev.name) return;
              const rid = ev.payload && ev.payload.runId;
              if (ev.name === 'agent.run.start' && rid && !mine) { prep.claim(rid); mine = rid; }
              if (prep.source === 'direct' && mine) { if (rid && rid !== mine) return; if (ev.name === 'agent.run.end') sawEnd = true; RUNS.ingest(mine, ev.name, ev.payload || {}); }
            };
            ur.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) each(l); } });
            ur.on('end', () => { if (buf.trim()) each(buf.trim()); if (!mine) { prep.cancel(); fin({ error: 'the station closed the run before it started' }); } else if (prep.source === 'direct' && !sawEnd) RUNS.finish(mine, { reason: 'cut-off' }); });
            ur.on('error', () => { if (prep.source === 'direct' && mine) RUNS.finish(mine, { reason: 'cut-off' }); else if (!mine) fin({ error: 'the connection to the station broke' }); });
          });
          up.on('error', e => { prep.cancel(); fin({ error: 'the station is not answering: ' + e.message }); });
          up.end(data);
        }, e => resolve({ error: e.message }));
      });
    },
    wait(runId, onEvent) {
      return new Promise(resolve => {
        let usd = 0, errMsg = null, final = null, over = false, off = null;
        const end = () => { if (over) return; over = true; if (off) off();
          const refused = !!final && REF.isRefusal(final);
          const text = final && typeof final.text === 'string' ? final.text : '';
          const ok = final && final.complete;
          resolve({ text, usd, refused, complete: !!ok, error: refused || ok ? null : (errMsg || (final && (final.failureCode || final.reason)) || 'the run did not finish') }); };
        off = RUNS.attach(runId, 0, l => {
          const p = l.payload || {};
          if (l.name === 'agent.run.end') usd += Number(p.usd) || 0;
          else if (l.name === 'agent.run.error') errMsg = p.message || errMsg;
          else if (l.name === 'console.final') final = p;
          else if (l.name === 'console.end') setImmediate(end);
          // every line goes to onEvent (the turn's watchdog counts any output as life; runEvent acts on the ones it knows)
          if (onEvent) { try { onEvent({ name: l.name, payload: p }); } catch (_) {} }
        });
        if (!off) { over = true; resolve({ text: '', usd: 0, refused: false, error: 'the console has no record of this run any more' }); }
      });
    },
    cancel(runId) { return deps.stationPost ? deps.stationPost('cancel', { runId }, 8000) : null; },
    steer(runId, text) { return deps.stationPost ? deps.stationPost('run/steer', { runId, text }, 8000) : null; },
    consent(runId, promptId, decision) { return deps.stationPost ? deps.stationPost('consent', { runId, promptId, decision }, 8000) : null; },
  };
  const runner = deps.runner || stationRunner;
  async function modelFor(id) {
    try { const m = await deps.modelFor(id); if (m && m.provider && m.model) return m; return { error: nameOf(id) + ' has no AI model to think with' }; }
    catch (e) { return { error: nameOf(id) + ': ' + e.message }; }
  }
  /* the model and effort of one run: each person's usual model (the seat's current chain entry), or the one model the owner
     picked for everyone. A picked model still passes everything the seat's own would: it must be on the company's list
     (model-policy.json allowed), open for that seat now in the station's override list (company/state/override-allow.json,
     lib/override-allow.js: the pacer, the subscription stops, refusal blocks, as the dispatcher last saw them), and not held
     by the $0 cap on a metered model (deps.modelHold); admit() then runs on its provider. When it is not open, that person
     sits the turn out with a plain line: never a move to another model. The effort is the owner's level (Light for hand
     checks, the leader's call, Catch me up and Explain), fitted to what the model offers (deps.effortsFor). */
  const OA = () => require(path.join(LIB, 'override-allow.js'));
  function pinChoices() {
    const allowed = (readJ(co.p('company', 'model-policy.json')) || {}).allowed || {}, out = [], seen = new Set();
    for (const [provider, fam] of Object.entries(allowed)) for (const model of (fam && Array.isArray(fam.models) ? fam.models : [])) {
      const label = modelLabel({ provider, model }); if (seen.has(label)) continue; seen.add(label);
      out.push({ provider, model, label });
    }
    return out;
  }
  const samePair = (a, b) => !!a && !!b && a.provider === b.provider && a.model === b.model;
  function pinClosed(id, pin) {
    if (!pinChoices().some(c => samePair(c, pin))) return 'no longer on the company\'s list of models';
    let why = null;
    try { why = typeof deps.pinCheck === 'function' ? deps.pinCheck(id, pin) : OA().openFor(id, pin, { root: co.ROOT, ownerPick: true }); } catch (e) { why = 'not open for them right now'; }
    if (why) return why;
    try { if (typeof deps.modelHold === 'function') { const h = deps.modelHold(id, pin); if (h) return 'held: ' + h; } } catch (_) {}
    return null;
  }
  async function effortFor(m, want) {
    let list = null;
    if (typeof deps.effortsFor === 'function') { try { list = await deps.effortsFor(m.provider, m.model); } catch (_) {} }
    return fitEffort(want, list);
  }
  const levelFor = purpose => LIGHT_PURPOSES.has(purpose) ? 'light' : std.think.level;
  async function seatModel(id, purpose) {
    const level = levelFor(purpose), pin = std.think.pin;
    let m;
    if (pin) {
      const why = pinClosed(id, pin);
      if (why) return { error: 'the model picked for this ' + NOUN + ' (' + modelLabel(pin) + ') is ' + why, pinned: true };
      m = { provider: pin.provider, model: pin.model, from: 'the model picked for this ' + NOUN, pinned: true };
    } else { m = await modelFor(id); if (m.error) return m; m = Object.assign({}, m); }
    m.level = level; m.effort = await effortFor(m, THINK[level].effort);
    return m;
  }
  /* every turn, hand check and leader call: admit() first (company/tools/lib/admit.js, kind 'meeting-turn': a zero-token
     permission and routing check, logged; it refuses a turn of a meeting the owner did not open, holds one under a hard
     halt or a refusal block on the provider). There is no budget or estimate: cost is information (the cost line). */
  function admitTurn(o) {
    try {
      const jobIds = typeof deps.seatJobs === 'function' ? deps.seatJobs(o.seat) : undefined;
      const t = admitLib().admit({ door: DOOR, kind: 'meeting-turn', seat: o.seat, provider: o.model.provider, owner: M.openedBy === 'owner', meetingId: M.id, jobIds, why: 'owner ' + NOUN + ' ' + o.purpose + (o.tools ? ' (tools)' : ' (talk only)') });
      return t;
    } catch (e) { return { decision: 'allow', reason: 'admit unavailable: ' + e.message }; }
  }
  async function startRun(o) {
    const tk = admitTurn(o);
    if (tk.decision !== 'allow') return { error: 'not admitted: ' + tk.reason, held: true };
    return runner.start(Object.assign({}, o, { ticket: tk }));
  }
  async function oneRun(o) {   // start + wait, for the short talk-only checks (no retry: a refused check is a "no")
    const st = await startRun(o); if (st.error) return { error: st.error };
    const check = o.purpose === 'hand' || o.purpose === 'call';
    active.add(st.runId); if (check) checks.add(st.runId);
    const wd = watchdog(st.runId, { onStall: () => { Promise.resolve(runner.cancel(st.runId)).catch(() => {}); } });
    try { const r = await runner.wait(st.runId, () => wd.saw()); cost(r, o.model, o.purpose); return r; } finally { wd.off(); active.delete(st.runId); checks.delete(st.runId); }
  }
  /* a run's watchdog: never a time limit on a turn. onNudge once, after NUDGE_MS since the run started (the speaker is
     asked to finish); onStall only when nothing at all came from the run for STALL_MS (a run waiting on the owner's
     approval is not stalled). saw() on every line of the run's journal. */
  const NUDGE = Number(deps.nudgeMs) > 0 ? Number(deps.nudgeMs) : NUDGE_MS;
  const STALL = Number(deps.stallMs) > 0 ? Number(deps.stallMs) : STALL_MS;
  const TICK = Number(deps.watchTickMs) > 0 ? Number(deps.watchTickMs) : WATCH_TICK_MS;
  function watchdog(runId, o) {
    const started = Number(o.startedAt) || Date.now(); let last = Date.now(), nudged = !!o.nudged, over = false;
    const t = setInterval(() => {
      if (over) return;
      const now = Date.now();
      if (M.run && M.run.consent && M.run.consent.runId === runId) { last = now; return; }
      if (!nudged && o.onNudge && now - started >= NUDGE) { nudged = true; try { o.onNudge(); } catch (_) {} }
      if (now - last >= STALL) { over = true; clearInterval(t); try { o.onStall(); } catch (_) {} }
    }, Math.min(TICK, NUDGE, STALL));
    if (t.unref) t.unref();
    return { saw: () => { last = Date.now(); }, off: () => { over = true; clearInterval(t); } };
  }
  /* cost is information, never a gate (no budget, no estimate): turns, and per provider the dollars of a metered model or
     the share of a subscription's windows since the meeting first used it (lib/subscription-meter.js), else "unknown" */
  const METER = require(path.join(LIB, 'subscription-meter.js'));
  function cost(r, model, purpose) {
    M.cost.turns++; M.cost.usd = Math.round((M.cost.usd + (Number(r && r.usd) || 0)) * 1e6) / 1e6;
    const p = (model && model.provider) || 'unknown';
    const bp = M.cost.byProvider = M.cost.byProvider || {};
    if (!bp[p]) { let w = null; try { w = METER.windows(p); } catch (_) {} bp[p] = { turns: 0, usd: 0, start: w }; }
    bp[p].turns++; bp[p].usd = Math.round((bp[p].usd + (Number(r && r.usd) || 0)) * 1e6) / 1e6;
    // turns only, weighted by level: the short Light checks (hands, the leader's call) add their cost to usd, not to w,
    // so a turn's share in the estimate carries the checks around it
    bp[p].w = Math.round(((Number(bp[p].w) || 0) + (purpose === 'turn' ? EFFORT_WEIGHT[model && model.effort] || 1 : 0)) * 1000) / 1000;
  }
  function costLine() {
    let l = ''; try { l = METER.line(M.cost.byProvider || {}); } catch (_) {}
    return 'This meeting so far: ' + M.cost.turns + ' turn' + (M.cost.turns === 1 ? '' : 's') + (l ? ' · ' + l : '');
  }
  /* the estimate for the next round at the current setting (information, never a gate): one turn for each person seated,
     at the owner's level, on the model each would use; per provider, from what this meeting's runs cost so far (scaled
     between levels: EFFORT_WEIGHT), dollars for a metered model or the share of a subscription's 5-hour window (else the
     week), "not known yet" before that provider's first run here. seatModels: [{provider, effort}] */
  function estimateLine(seatModels) {
    const list = (seatModels || []).filter(x => x && x.provider);
    const lab = THINK[std.think.level].label;
    if (!list.length) return '';
    const by = {};
    for (const x of list) { const b = by[x.provider] = by[x.provider] || { n: 0, w: 0 }; b.n++; b.w += EFFORT_WEIGHT[x.effort] || 1; }
    const bp = M.cost.byProvider || {};
    const pct = n => (n < 0.1 ? 'under 0.1' : (Math.round(n * 10) / 10).toString().replace(/\.0$/, '')) + '%';
    const parts = Object.entries(by).map(([p, b]) => {
      const name = (METER.NAMES && METER.NAMES[p]) || p, seen = bp[p], w = seen ? Number(seen.w != null ? seen.w : seen.turns) || 0 : 0;
      let kind = 'unknown'; try { kind = METER.kindOf(p); } catch (_) {}
      if (kind === 'metered') {
        if (!w) return name + ' not known yet';
        const u = (Number(seen.usd) || 0) / w * b.w;
        return name + ' about ' + (u < 0.01 ? 'under $0.01' : '$' + u.toFixed(2));
      }
      if (kind === 'subscription') {
        let now = null; try { now = METER.windows(p); } catch (_) {}
        const st = (seen && seen.start) || {};
        for (const [k, words] of [['fiveHour', 'of the 5-hour window'], ['week', 'of the week']]) {
          if (w && now && now[k] && st[k]) return name + ' about ' + pct(Math.max(0, now[k].usedPct - st[k].usedPct) / w * b.w) + ' ' + words;
        }
        return name + ' share not known yet';
      }
      return name + ' unknown';
    });
    return 'Next round at ' + lab + ': about ' + list.length + ' turn' + (list.length === 1 ? '' : 's') + ' · ' + parts.join(' · ') + ' (a rough guess from this ' + NOUN + ' so far; more if they ask each other or raise hands)';
  }

  /* ---------- the action register (company/tools/lib/meeting-register.js): the meeting's first-class output ----------
     Rows come from the lines their owners write (ACTION / QUESTION / KILL: the speaker owns the row; RULING from the
     leader: proposed, the owner confirms it) and from the owner's controls. No model writes a row for anyone. Only a
     ruling the owner confirms goes to decisions.md (owner ruling: register lines stay in the register). */
  const REG = require(path.join(LIB, 'meeting-register.js'));
  const regNames = x => x === 'owner' ? owner() : nameOf(x);
  let regCache = null;
  const reg = () => { if (!regCache || regCache.id !== M.id) regCache = REG.load(M.id, { date: String(M.startedAt).slice(0, 10), title: M.title, type: M.type }); return regCache; };
  const saveReg = () => { const r = reg(); r.title = M.title; r.type = M.type; REG.save(r, regNames); reindex(); emit('meeting'); };
  function regAdd(section, row, by, line) {
    try { const r = REG.add(reg(), section, row, by, { plainOptional: true }); saveReg(); return r; }
    catch (e) { record({ who: by, kind: 'parse', line: String(line || row.text).slice(0, 200), why: String(e.message).replace(/^not recorded: /, 'not put in the register: ') }); return null; }
  }
  /* ---------- the search index (company/state/meetings/index.json): one small row per meeting ---------- */
  function reindex() {
    try {
      const f = path.join(DIR(), 'index.json'); const idx = (readJ(f) || {}).meetings || [];
      const r = reg(); const said = LOG.filter(e => e.kind === 'say');
      const text = said.map(e => e.text).join('\n') + '\n' + REG.SECTIONS.map(s => r[s].map(x => x.text + ' ' + (x.plain || '') + ' ' + (x.status || '')).join('\n')).join('\n');
      const row = { id: M.id, type: M.type, title: M.title, state: M.state, startedAt: M.startedAt, closedAt: M.closedAt || null,
        agenda: (M.agenda || []).map(a => a.title), participants: [...new Set(said.map(e => e.who === 'owner' ? owner() : nameOf(e.who)).concat(present().map(nameOf)))],
        decisions: r.rulings.map(x => x.text).concat(r.summary ? [r.summary.text] : []), actions: r.actions.map(a => ({ n: a.n, text: a.text, owner: regNames(a.owner), status: a.status })),
        links: { quests: [...new Set((text.match(/\bq[:-]?\d{1,6}\b/gi) || []).map(x => x.toLowerCase().replace(/^q[:-]?/, 'q:')))].slice(0, 50), handoffs: [...new Set(text.match(/\bto-[a-z0-9-]+\.md\b/g) || [])].slice(0, 50) } };
      const out = [row].concat(idx.filter(x => x && x.id !== M.id)).slice(0, 1000);
      writeJ(f, { v: 1, meetings: out });
    } catch (_) {}
  }
  function search(q) {
    const s = String((q && q.get && q.get('q')) || '').trim().toLowerCase();
    const idx = (readJ(path.join(DIR(), 'index.json')) || {}).meetings || [];
    const hit = x => !s || JSON.stringify(x).toLowerCase().includes(s);
    return { ok: true, q: s, meetings: idx.filter(hit).slice(0, 100) };
  }
  // decisions.md, for an owner ruling the owner confirmed (decision.js add, by the owner)
  async function decide(by, text, why) {
    const clean = s => String(s || '').replace(/^[-\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 900);
    if (!clean(text)) return;
    const name = by === 'owner' ? owner() : nameOf(by);
    try {
      const r = await deps.run('decision.js', ['add', '--by', name, '--text', clean(text), '--why', why + ' (minutes: ' + minutesRel() + ')']);
      if (r && r.code) { note('Not recorded in decisions.md: ' + String((r.data && (r.data.error || r.data.text)) || 'decision.js refused').slice(0, 200)); return null; }
      const m = /\[(d-[0-9a-f]{6})\]/.exec(JSON.stringify((r && r.data) || '')); return m ? m[1] : 'recorded';
    } catch (e) { note('Not recorded in decisions.md: ' + e.message); return null; }
  }

  /* ---------- leaving: never mid-turn. Someone dismissed (by an agent) or removed (by the owner) while speaking leaves once
     their turn is over; their reply is kept. ---------- */
  const speakingNow = id => !!(M.run && M.run.current && M.run.current.seat === id && M.run.current.runId);
  function deferLeave(x) {
    const R = M.run;
    R.leaveAfter = (R.leaveAfter || []).filter(y => y.who !== x.who).concat([x]); save();
    note(nameOf(x.who) + ' leaves the ' + NOUN + ' once ' + firstName(x.who) + ' finishes this turn.');
  }
  function dismissSeat(target, by, why) {
    M.guests = M.guests.filter(c => c !== target);
    if (std.seats.includes(target) && !M.excused.includes(target)) M.excused.push(target);
    save();
    record({ who: target, kind: 'leave', by, why });
  }
  // the owner's remove: the standing seats, and this meeting's guests and dismissals
  function removeSeat(id) {
    const wasHere = present().includes(id);
    if (std.seats.includes(id)) { std.seats = std.seats.filter(c => c !== id); saveStd(); }
    M.guests = M.guests.filter(c => c !== id); M.excused = M.excused.filter(c => c !== id); save();
    if (wasHere && M.opened) record(Array.isArray(P.standing) ? { who: id, kind: 'leave', by: 'owner' } : { who: id, kind: 'leave' });
  }
  function applyLeaves(R) {
    const list = (R && R.leaveAfter) || []; if (!list.length) return;
    R.leaveAfter = [];
    for (const x of list) {
      if (R.current && R.current.seat === x.who && R.current.runId) { R.leaveAfter.push(x); continue; }
      if (x.op === 'remove') removeSeat(x.who); else if (present().includes(x.who) && x.who !== leader()) dismissSeat(x.who, x.by, x.why);
    }
    save(); emit('meeting');
  }

  /* ---------- the agent lines ---------- */
  function applyDirectives(by, list, ctl, pending) {
    const callNow = [];
    for (const d of list) {
      // "— plain: …" is welcome, not required: a line without it is kept as written, and the writer is told once
      const plainNudge = (kind, has) => { if (!has) record({ who: by, kind: 'nudge', text: 'your ' + kind + ' line was recorded as written. When ' + owner() + ' may not follow it, add "— plain: <one sentence anyone can read>".' }); };
      if (d.kind === 'END') {
        if (leader() && by !== leader()) { note(nameOf(by) + ' suggested closing; only the leader, ' + nameOf(leader()) + ', closes the discussion'); continue; }
        const pl = REG.parseLine('END', d.why);
        ctl.ended = pl.text || d.why || 'closed';
        record({ who: by, kind: 'end', text: pl.text || d.why, plain: pl.plain || null });
        if (!P.noRegister) { reg().summary = { text: pl.text || d.why, plain: pl.plain || null, plainOptional: !pl.plain || undefined, by, at: new Date().toISOString() }; saveReg(); }
        continue;
      }
      if ((d.kind === 'RULING' || d.kind === 'ACTION' || d.kind === 'QUESTION' || d.kind === 'KILL') && P.noRegister) {   // no register in this room: kept as said
        record({ who: by, kind: 'note', text: nameOf(by) + ' noted (' + d.kind.toLowerCase() + '): ' + d.why });
        continue;
      }
      if (d.kind === 'RULING') {
        if (leader() && by !== leader()) { note(nameOf(by) + ' wrote a ruling; the leader, ' + nameOf(leader()) + ', records rulings'); continue; }
        const pl = REG.parseLine('RULING', d.why);
        const row = regAdd('rulings', { text: pl.text, plain: pl.plain, proposedBy: by }, by, 'RULING: ' + d.why);
        if (row) { record({ who: by, kind: 'ruling', text: pl.text, plain: pl.plain, n: row.n, proposed: true }); plainNudge('RULING', !!row.plain); }
        continue;
      }
      if (d.kind === 'ACTION' || d.kind === 'QUESTION' || d.kind === 'KILL') {   // the speaker's own line in the register
        const section = d.kind === 'ACTION' ? 'actions' : d.kind === 'QUESTION' ? 'questions' : 'kills';
        const pl = REG.parseLine(d.kind, d.why);
        const row = regAdd(section, Object.assign({}, pl, { owner: by }), by, d.kind + ': ' + d.why);
        if (row) { record({ who: by, kind: 'register', section, n: row.n, text: row.text, plain: row.plain, date: row.date || null, affects: row.affects || null }); plainNudge(d.kind, !!row.plain); }
        continue;
      }
      if (d.kind === 'LATER' || d.kind === 'LOWER') continue;   // only in the leader's answer on raised hands
      if (d.kind === 'ASK' && isOwnerKey(d.name)) {
        if (observing()) note(nameOf(by) + ' put a question to ' + owner() + ', who is observing; it is left for the people seated');
        else { record({ who: by, kind: 'ask', to: 'owner', text: d.why }); M.ownerHand = true; M.floorWhy = nameOf(by) + ' asked you: ' + d.why; }
        continue;
      }
      if (d.kind === 'CALL' && isOwnerKey(d.name)) {   // the leader gives the owner the floor
        if (by !== leader()) continue;
        record({ who: by, kind: 'call', to: 'owner' }); M.ownerHand = true; M.floorWhy = nameOf(by) + ' gave you the floor';
        continue;
      }
      const target = resolve(d.name, by);
      if (!target) { record({ who: by, kind: 'parse', line: d.kind + ': ' + d.name + (d.why ? ' — ' + d.why : ''), why: 'nobody called ' + d.name + ' is on the crew' }); continue; }
      if (d.kind === 'CALL') {
        if (by !== leader()) { note(nameOf(by) + ' tried to call on ' + nameOf(target) + '; only the leader calls on people'); continue; }
        if (target === by || !present().includes(target)) continue;
        const why = ctl.up[target] || '';
        delete ctl.up[target]; ctl.after = ctl.after.filter(x => x.cmd !== target);
        record({ who: by, kind: 'call', to: target });
        callNow.push({ cmd: target, kind: 'hand', why, calledBy: by });
        continue;
      }
      const here = present().includes(target);
      const invite = why => {
        if (ctl.invites >= MAX_INVITES) { note(nameOf(by) + ' invited ' + nameOf(target) + ': not this round, ' + MAX_INVITES + ' people were invited already'); return false; }
        if (present().length >= MAX_SEATS) { note(nameOf(by) + ' invited ' + nameOf(target) + ': the ' + NOUN + ' is full (' + MAX_SEATS + ' seats)'); return false; }
        if (!std.seats.includes(target) && M.guests.filter(c => !M.excused.includes(c)).length >= MAX_GUESTS) { note(nameOf(by) + ' invited ' + nameOf(target) + ': ' + MAX_GUESTS + ' colleague' + (MAX_GUESTS === 1 ? ' is' : 's are') + ' here already, the most at once'); return false; }
        M.excused = M.excused.filter(c => c !== target);
        if (!std.seats.includes(target) && !M.guests.includes(target)) M.guests.push(target);
        save();
        record({ who: target, kind: 'join', by, why });
        ctl.invites++;
        return true;
      };
      if (d.kind === 'INVITE') {
        if (here) continue;
        if (invite(d.why)) ctl.normal.push({ cmd: target, kind: 'turn' });
      } else if (d.kind === 'DISMISS') {
        if (!here) continue;
        if (target === leader()) { note(nameOf(by) + ' asked to dismiss ' + nameOf(target) + ', who leads the meeting; only the owner changes that'); continue; }
        if (speakingNow(target)) { deferLeave({ who: target, by, why: d.why, op: 'dismiss' }); continue; }   // after their turn
        dismissSeat(target, by, d.why);
      } else if (d.kind === 'ASK') {
        if (target === by) continue;
        if (ctl.asks >= MAX_ASKS_PER_ROUND) { note(nameOf(by) + ' asked ' + nameOf(target) + ' a question; the round has had ' + MAX_ASKS_PER_ROUND + ' direct questions, so it moves on'); continue; }
        if (!here && !invite('to answer ' + nameOf(by) + '\'s question')) continue;   // asking someone not seated calls them in
        ctl.asks++;
        record({ who: by, kind: 'ask', to: target, text: d.why });
        ctl.front.push({ cmd: target, kind: 'ask', from: by, text: d.why });
      }
    }
    if (callNow.length) ctl.front.unshift(...callNow);
  }

  // with a leader seated, raised hands wait for the leader: a short talk-only turn that answers CALL / LATER / LOWER
  async function leaderCall(l, up, a, b) {
    const res = { call: [], later: [], lower: [] };
    const m = await seatModel(l, 'call');
    if (m.error || stopping()) { res.later = up.map(([c]) => c); return res; }
    const line = '[RAISED HANDS, not your turn. During the exchange between ' + nameOf(a) + ' and ' + nameOf(b) + ', hands are up: '
      + up.map(([c, why]) => nameOf(c) + (why ? ' (' + why + ')' : '')).join('; ') + '. You lead the meeting, so you call on them. Reply '
      + 'only with lines of their own: CALL: <names> gives them the floor now, in that order; LATER: <names> lets them speak once this '
      + 'exchange is done; LOWER: <names> lowers their hands. Anyone you do not name speaks later.]';
    M.run.checking = { kind: 'call', seats: [l] }; emit('meeting');
    const r = await oneRun({ seat: l, model: m, messages: historyFor(l, line), tools: false, purpose: 'call' });
    if (M.run) M.run.checking = null;
    const named = new Set();
    for (const d of directives(r.error ? '' : r.text).list) {
      const t = resolve(d.name);
      if (!t || !up.some(([c]) => c === t) || named.has(t)) continue;
      named.add(t);
      (d.kind === 'CALL' ? res.call : d.kind === 'LOWER' ? res.lower : res.later).push(t);
    }
    for (const [c] of up) if (!named.has(c)) res.later.push(c);
    return res;
  }
  // after an answer in an exchange, the others are asked (in parallel, talk only) whether they want to come in now
  async function handCheck(a, b, ctl) {
    const others = present().filter(c => c !== a && c !== b && !ctl.raised.includes(c));
    if (!others.length || ctl.hands >= MAX_HANDS_PER_ROUND || stopping() || M.ownerHand || M.run.paused) return [];
    const line = '[HAND CHECK, not your turn: ' + nameOf(a) + ' and ' + nameOf(b) + ' are in an exchange. If you need to interject right now, '
      + 'reply with one line: HAND — <what you want to add>. Otherwise reply with exactly: NO]';
    M.run.checking = { kind: 'hands', seats: others }; emit('meeting');
    const out = await Promise.all(others.map(async c => {
      const m = await seatModel(c, 'hand'); if (m.error || stopping()) return null;
      const r = await oneRun({ seat: c, model: m, messages: historyFor(c, line), tools: false, purpose: 'hand' });
      const why = !r.error ? handReply(r.text) : null;
      return why !== null ? { cmd: c, why } : null;
    }));
    if (M.run) M.run.checking = null;
    return out.filter(Boolean);
  }

  /* ---------- an approval a turn asks for (a station permission prompt): the normal approvals path, the meeting paused ----
     The prompt becomes an owner question on Today › Needs you (inbox.js ask, kind approve). The meeting is paused while it
     waits (no new turn starts, nothing is spent); the answer goes back to the station as the consent, then it carries on. */
  const inbox = () => require(path.join(__dirname, '..', 'company', 'tools', 'inbox.js'));
  let consentTimer = null;
  function runEvent(cur, ev) {
    const R = M.run; if (!R) return;
    const p = ev.payload || {};
    /* a routine of this seat took the company folder between the busy check and this turn's first write: the station
       answers its write with workspace-busy (after its wait). One dim line; the turn carries on without changing files. */
    // the turn's tool steps, kept on its entry so the page shows them as "· Name: …" lines (the table printed them)
    if (ev.name === 'agent.tool_call') {
      cur.tools = cur.tools || [];
      if (cur.tools.length < 20) cur.tools.push({ name: String(p.name || '').slice(0, 80), args: clip(String(p.argsSummary || '').replace(/\s+/g, ' '), 200) });
      return;
    }
    if (ev.name === 'agent.tool_result') {
      if (p.summary === 'workspace-busy' && !cur.wsBusy) { cur.wsBusy = true; note(nameOf(cur.seat) + '\'s routine is using the company folder; ' + firstName(cur.seat) + ' answers without changing files.'); }
      return;
    }
    if (ev.name === 'permission.prompt' && p.promptId && !(R.consent && R.consent.promptId === p.promptId)) {
      let qid = null;
      try {
        const tool = String(p.tool || 'a tool').slice(0, 80);
        const r = inbox().ask({ from: nameOf(cur.seat), scopeExempt: true, oneDecision: true, about: 'meeting',
          message: nameOf(cur.seat) + ' wants to use ' + tool + ' during your meeting. Approve lets this one use go ahead; Decline stops it and the meeting carries on.',
          details: 'Meeting ' + M.id + (M.title ? ' (' + M.title + ')' : '') + '. What it asked: ' + String(p.argsSummary || '').slice(0, 600), spec: { does: 'Approve lets ' + nameOf(cur.seat) + ' use ' + tool + ' once' } });
        qid = r && (r.id || (r.row && r.row.id)) || null;
      } catch (e) { note('The approval could not be put on Today: ' + e.message); }
      R.consent = { promptId: p.promptId, runId: cur.runId, seat: cur.seat, tool: p.tool || null, qid, since: Date.now(), wasPaused: !!R.paused };
      R.paused = 'consent'; save();
      record({ who: cur.seat, kind: 'consent', op: 'asked', tool: p.tool || null, qid });
      armConsent();
    } else if (ev.name === 'permission.response' && R.consent && (!p.promptId || p.promptId === R.consent.promptId)) consentClear(R, p.decision || 'answered');
  }
  function armConsent() {
    if (consentTimer) return;
    consentTimer = setInterval(() => {
      const R = M.run; if (!R || !R.consent) { clearInterval(consentTimer); consentTimer = null; return; }
      if (!R.consent.qid) return;
      let st = null; try { st = inbox().state()[R.consent.qid]; } catch (_) {}
      if (!st || !(st.answeredAt || st.type === 'close')) return;
      const v = String((st.answer && st.answer.verdict) || st.a || '').toLowerCase();
      const yes = /^(yes|approve|ok|allow)/.test(v);
      Promise.resolve(runner.consent(R.consent.runId, R.consent.promptId, yes ? 'once' : 'deny')).catch(() => {});
      consentClear(R, yes ? 'once' : 'deny');
    }, Number(deps.consentPollMs) > 0 ? Number(deps.consentPollMs) : 2000);
    if (consentTimer.unref) consentTimer.unref();
  }
  function consentClear(R, decision) {
    if (!R.consent) return;
    const c = R.consent; R.consent = null;
    if (R.paused === 'consent') R.paused = c.wasPaused || false;
    if (decision) record({ who: c.seat, kind: 'consent', op: 'answered', tool: c.tool, decision, qid: c.qid });
    save(); emit('meeting'); kick();
  }

  /* ---------- the engine: one meeting, driven step by step, saved after each step ---------- */
  let driving = false, haltTimer = null;
  const stopping = () => !!(M.run && M.run.stopping);
  function kick() { if (!driving) drive().catch(e => { try { note('The meeting stopped on an error: ' + e.message); } catch (_) {} M.run = null; save(); driving = false; emit('meeting'); }); }
  function armHalt() {
    if (haltTimer) return;
    haltTimer = setInterval(() => {
      if (!M.run) { clearInterval(haltTimer); haltTimer = null; return; }
      const h = co.halted();
      // a halt overrides the owner's Stop / Close (stopping 'owner'); a hard one also overrides a soft one
      if (h && (!M.run.stopping || M.run.stopping === 'owner' || (h === 'hard' && M.run.stopping === 'halt-soft'))) {
        M.run.stopping = 'halt-' + h; M.run.floor = false; M.run.paused = false; save();
        if (h === 'hard') for (const id of active) Promise.resolve(runner.cancel(id)).catch(() => {});   // a hard halt aborts the turn; a soft one lets it finish
        emit('meeting'); kick();
      }
    }, 1000);
    if (haltTimer.unref) haltTimer.unref();
  }
  async function drive() {
    driving = true;
    try {
      while (M.run) {
        const R = M.run;
        if (co.halted() && (!R.stopping || R.stopping === 'owner')) R.stopping = 'halt-' + co.halted();
        if (R.floor && !R.stopping) { save(); emit('meeting'); return; }   // the owner has the floor: wait for them
        if (!R.round) {
          if (R.stopping) {
            const h = String(R.stopping);
            if (h.startsWith('halt')) {   // halted: the meeting is interrupted, its minutes written; Resume after the halt
              const hard = h === 'halt-hard';
              const closing = !!M.closeAfter;   // the owner had pressed Close: it closes, as asked, rather than waiting to resume
              endRun('The company is halted, so the meeting stopped' + (hard ? ' mid-turn.' : ' after the turn in progress.'));
              if (!closing) finalize('interrupted', 'console', hard ? 'hard halt: aborted mid-turn; resume it after the halt' : 'soft halt: the turn in progress finished, then the meeting stopped');
            } else endRun('Round stopped.');
            return;
          }
          if (!R.pending) { endRun(null); return; }
          if (R.pending.open && gateWait(R)) return;   // an observe round carries on at the reader's pace
          beginRound(R.pending); R.pending = null; save();
          continue;
        }
        const ctl = R.round.ctl;
        if (R.stopping) { R.round = null; R.current = null; continue; }
        if (!R.current && R.interjection) {   // the owner's message, typed while the round ran: it starts the next round now
          R.pending = { text: R.interjection.text, only: R.interjection.only }; R.interjection = null; R.round = null; M.ownerHand = false; R.auto = 0; save(); continue;
        }
        if (!R.current && M.ownerHand) { M.ownerHand = false; R.floor = true; R.gate = false; R.waitNext = false; save(); emit('meeting'); return; }
        if (!R.current && R.gate) {
          const speaks = x => present().includes(x.cmd) && (x.kind !== 'turn' || hasNewFor(x.cmd));
          if (![...ctl.front, ...ctl.after, ...ctl.normal].some(speaks)) { if (wrapUp(R)) continue; finishRound(); if (!M.run || !M.run.pending) { R.gate = false; R.waitNext = false; } continue; }   // nobody left this round: Next only if another round follows
        }
        if (!R.current && gateWait(R)) return;
        if (!R.current) {
          const item = ctl.front.shift() || ctl.after.shift() || ctl.normal.shift();
          if (!item) { if (wrapUp(R)) continue; finishRound(); continue; }
          if (item.kind === 'hand') delete ctl.up[item.cmd];
          if (!present().includes(item.cmd) || (item.kind === 'turn' && !hasNewFor(item.cmd))) { save(); continue; }
          if ((ctl.turns || 0) >= MAX_TURNS) {   // a room with a cap on replies per owner message (a live chat): it waits for the owner
            note('The ' + NOUN + ' paused after ' + MAX_TURNS + ' replies; write to carry on.');
            ctl.front = []; ctl.after = []; ctl.normal = []; R.round.capped = true; finishRound(); continue;
          }
          const m = await seatModel(item.cmd, 'turn');
          if (m.error) { note(nameOf(item.cmd) + ' sits this one out: ' + m.error); save(); continue; }
          /* a seat in the middle of a routine run still speaks, as at the table, but talk only for this turn: a talk-only
             run makes no change in the company folder, so it cannot clash with the routine's hold on it */
          let mid = false; try { mid = typeof deps.seatBusy === 'function' && await deps.seatBusy(item.cmd); } catch (_) {}
          if (mid) note(nameOf(item.cmd) + ' is in the middle of a routine run, so ' + firstName(item.cmd) + ' speaks without tools this turn.');
          ctl.turns = (ctl.turns || 0) + 1;
          R.current = { item, seat: item.cmd, model: m, attempt: 0, tried: [], runId: null, noTools: mid || undefined };
          save(); emit('meeting');
        }
        await turn(R);
        R.gate = true; R.gateUntil = null;
        if (ctl.ended) { R.round.ended = ctl.ended; finishRound(); }
      }
    } finally { driving = false; }
  }
  /* the host's closing turn (profile wrapHost): when a round the host started by bringing someone in ends (or every round,
     wrapHost 'always'), the host speaks once more if something was said since, to close the loop for the owner */
  function wrapUp(R) {
    const rd = R.round; if (!P.wrapHost || !rd || rd.wrapped || rd.capped || R.stopping || rd.ctl.ended) return false;
    if (!(rd.wrap || P.wrapHost === 'always')) return false;
    const l = leader(); if (!l || !saidSince(l)) return false;
    rd.wrapped = true; rd.ctl.normal.push({ cmd: l, kind: 'turn', wrap: true }); save();
    return true;
  }
  // someone else said something since this seat last spoke (a join or a pass alone is nothing to close the loop on)
  function saidSince(id) {
    for (let i = LOG.length - 1; i >= 0; i--) { const e = LOG[i]; if (e.who === id && (e.kind === 'say' || e.kind === 'pass')) return false; if (e.who !== id && e.kind === 'say') return true; }
    return false;
  }
  function beginRound(p) {
    if (p.pullIn) {   // a seat brought someone in (a colleague into a live chat): its ASK / INVITE lines start the round
      const only = null;
      M.run.round = { only, followUp: true, said: 0, answered: 0, ended: null, wrap: true,
        ctl: { invites: 0, asks: 0, hands: 0, turns: 0, raised: [], front: [], after: [], up: {}, ended: null, normal: [] } };
      applyDirectives(p.pullIn.by, p.pullIn.list || [], M.run.round.ctl, []);
      return;
    }
    if (p.text) {
      M.run.gate = false; M.run.gateUntil = null; M.run.waitNext = false; M.floorWhy = null;   // the owner just spoke: the first answer starts now
      if (!M.opened) record({ who: 'owner', kind: 'open', text: seatList() });
      record(Object.assign({ who: 'owner', kind: 'say', text: p.text }, p.only && p.only.length ? { only: p.only.slice() } : {}));
    }
    const only = p.only && p.only.length ? p.only : null;
    M.rounds = (M.rounds || 0) + 1;
    M.run.round = { only, followUp: !p.text, fromOwner: !!p.text, no: M.rounds, drafts: {}, said: 0, answered: 0, ended: null,
      ctl: { invites: 0, asks: 0, hands: 0, turns: 0, raised: [], front: [], after: [], up: {}, ended: null,
        normal: (only || ordered()).map(cmd => ({ cmd, kind: 'turn', followUp: !p.text, addressed: only })) } };
  }
  function finishRound() {
    const R = M.run, rd = R.round; R.round = null; R.current = null;
    if (R.stopping) { save(); return; }
    if (!observing() || !rd) { save(); return; }
    if (rd.ended) { note('The discussion is closed. Write to carry on, or press Round for more.'); save(); return; }
    if (!rd.said) { note('The meeting has gone quiet: a round passed with nothing said.'); save(); return; }
    const cap = std.observeRounds;
    const done = (R.auto || 0) + 1;
    if (done >= cap) { note(done + ' rounds ran on their own; the meeting waits for you. Write to carry on, or press Round for more.'); save(); return; }
    R.auto = done; R.pending = { open: true }; save();
  }
  function endRun(msg) {
    if (M.run) { M.run.current = null; applyLeaves(M.run); }
    if (msg && !(M.closeAfter && msg === 'Round stopped.')) note(msg);
    const after = M.run && M.run.afterStop;
    M.run = null; M.ownerHand = false; save(); emit('meeting');
    // a message the owner wrote while it was stopping: its round starts now
    if (after && !M.closeAfter && M.state === 'open' && !co.halted()) { M.run = { auto: 0, pending: after, round: null, current: null }; save(); setImmediate(kick); return; }
    if (M.closeAfter) finalize(M.closeAfter.state, M.closeAfter.by, M.closeAfter.why);
  }
  async function turn(R) {
    const cur = R.current, ctl = R.round.ctl, item = cur.item;
    let res = null;
    for (;;) {
      if (!cur.runId) {
        if (R.stopping || !present().includes(cur.seat)) { res = { stopped: true }; break; }
        // a gatekeeper's private first take, before it reads anyone else (talk only, admitted as a meeting turn, in the cost line)
        if (needsDraft(R, cur)) { try { await firstTake(R, cur); } catch (_) { R.round.drafts = Object.assign({}, R.round.drafts || {}, { [cur.seat]: '(no first take)' }); } if (R.stopping || !present().includes(cur.seat)) { res = { stopped: true }; break; } }
        const st = await startRun({ seat: cur.seat, model: cur.model, messages: historyFor(cur.seat, turnLine(cur.seat, item, ctl, !!cur.noTools)), tools: cur.noTools ? false : toolsOn(), purpose: 'turn' });
        if (st.error) { res = { error: st.error, text: '' }; break; }
        cur.runId = st.runId; cur.startedAt = Date.now(); save(); emit('meeting'); armHalt();
      }
      active.add(cur.runId);
      cur.tools = [];   // wait() reads the run's journal from its first line (again, after a console restart)
      const rid = cur.runId;
      const wd = watchdog(rid, { startedAt: cur.startedAt, nudged: cur.nudged,
        onNudge: () => {   // a soft nudge, never a cut: the speaker is asked to finish its point
          cur.nudged = true; save();
          Promise.resolve(runner.steer ? runner.steer(rid, '[Console note: you have been on this turn for ' + Math.round(NUDGE / 60e3) + ' minutes. Finish your point now, in a few sentences; longer work goes to your own loop.]') : null).catch(() => {});
          note(nameOf(cur.seat) + ' has been on this turn for ' + Math.round(NUDGE / 60e3) + ' minutes; the console asked ' + firstName(cur.seat) + ' to wrap up. Nobody is cut off.');
        },
        onStall: () => {   // the safety ceiling: only a run with no output at all for that long
          cur.stalled = true; save();
          note(nameOf(cur.seat) + '\'s turn stalled: nothing came from it for ' + Math.round(STALL / 60e3) + ' minutes, so the console ended it.');
          Promise.resolve(runner.cancel(rid)).catch(() => {});
        } });
      try { res = await runner.wait(rid, ev => { wd.saw(); runEvent(cur, ev); }); } finally { wd.off(); active.delete(rid); }
      if (R.consent && R.consent.runId === cur.runId) consentClear(R, null);
      cost(res, cur.model, 'turn');
      if (res.refused) {
        // a model picked for everyone is never swapped for another: that person sits this turn out
        let next = cur.attempt === 0 && !cur.model.pinned ? REF.nextEntry(cur.seat, cur.model, cur.tried, { root: co.ROOT }) : null;
        if (next) next = Object.assign({}, next, { level: cur.model.level, effort: await effortFor(next, THINK[cur.model.level || std.think.level].effort) });
        try { REF.record({ root: co.ROOT, seat: cur.seat, door: DOOR, runId: cur.runId, from: cur.model, to: next }); } catch (_) {}
        if (next && !R.stopping) {
          note(nameOf(cur.seat) + ': ' + REF.plainLine(cur.model, next).replace('answered instead.', 'is answering instead.'));
          cur.tried.push({ provider: cur.model.provider, model: cur.model.model }); cur.model = next; cur.attempt = 1; cur.runId = null; save();
          continue;
        }
        note(nameOf(cur.seat) + ': ' + (cur.attempt === 0 ? REF.plainLine(cur.model, null) : REF.pname(cur.model.provider) + ' declined this too, after ' + REF.pname(cur.tried[0].provider) + ' did.') + ' Nothing was said.');
        res = { skip: true };
      }
      break;
    }
    R.current = null; save();
    if (res.skip || res.stopped) { applyLeaves(R); emit('meeting'); return; }
    let raw = res.text || '', stance = null;
    if (povOn() && !res.error) { const sx = stanceOf(raw); stance = sx.stance; raw = sx.body; }
    const { body, list, failures } = res.error ? { body: raw, list: [], failures: [] } : directives(raw);
    const passed = !res.error && (isPass(body) || (!body && list.length > 0));
    const extra = item.kind === 'ask' ? { to: item.from } : item.kind === 'hand' ? { interject: true } : {};
    const steps = cur.tools && cur.tools.length ? { tools: cur.tools } : {};
    if (passed) { R.round.answered++; record(Object.assign({ who: cur.seat, kind: 'pass' }, steps)); }
    else if (body) {
      R.round.answered++; R.round.said++;
      const lt = res.error ? null : lintOf(body, list);
      record(Object.assign({ who: cur.seat, kind: 'say', text: res.error ? body + '\n\n[stopped before the end]' : body, model: modelLabel(cur.model), provider: cur.model.provider, modelId: cur.model.model }, extra, steps, lt ? { lint: lt } : {}, stance ? { stance } : povOn() && !res.error ? { nostance: true } : {}));
    } else if (res.error && !R.stopping && !cur.stalled) note(nameOf(cur.seat) + ' could not answer: ' + String(res.error).slice(0, 200));
    if (!passed && !body && !res.error && list.length === 0) note(nameOf(cur.seat) + ' finished without writing a reply.');
    for (const f of failures || []) record({ who: cur.seat, kind: 'parse', line: f.line, why: f.why });
    if (list.length) { const pending = []; applyDirectives(cur.seat, list, ctl, pending); await Promise.all(pending); }
    applyLeaves(R);   // someone removed or dismissed while speaking leaves now, after their reply (and before the hand check)
    save();
    if (ctl.ended || R.stopping || res.error) return;
    // an answer in an exchange: the others may raise a hand. With no leader a raised hand speaks next; with one, the
    // leader calls on it now, takes it once the exchange is done, or lowers it.
    if (item.kind === 'ask') {
      const freshHands = [];
      for (const h of await handCheck(item.from, cur.seat, ctl)) {
        if (ctl.hands >= MAX_HANDS_PER_ROUND) break;
        ctl.hands++; ctl.raised.push(h.cmd);
        record({ who: h.cmd, kind: 'hand', why: h.why });
        freshHands.push(h);
      }
      const l = leader(), now = [];
      for (const h of freshHands) { if (!l || h.cmd === l) now.push({ cmd: h.cmd, kind: 'hand', why: h.why }); else ctl.up[h.cmd] = h.why; }
      if (l && freshHands.some(h => h.cmd !== l) && !R.stopping && !M.ownerHand) {
        const dec = await leaderCall(l, Object.entries(ctl.up), item.from, cur.seat);
        const whyOf = c => ctl.up[c] || '';
        for (const c of dec.call) { record({ who: l, kind: 'call', to: c }); now.push({ cmd: c, kind: 'hand', why: whyOf(c), calledBy: l }); ctl.after = ctl.after.filter(x => x.cmd !== c); delete ctl.up[c]; }
        for (const c of dec.lower) { record({ who: l, kind: 'lower', to: c }); ctl.after = ctl.after.filter(x => x.cmd !== c); delete ctl.up[c]; }
        for (const c of dec.later) if (!ctl.after.some(x => x.cmd === c)) { record({ who: l, kind: 'call', to: c, later: true }); ctl.after.push({ cmd: c, kind: 'hand', why: whyOf(c), calledBy: l }); }
      }
      ctl.front.unshift(...now);
      save();
    }
  }

  /* ---------- the owner's controls ---------- */
  const busy = () => !!M.run;
  function guard() {
    // the owner's, only: the console behind its sign-in, never a console started inside an agent's run (lib/owner.js)
    let under = false; try { under = require(path.join(LIB, 'owner.js')).underStation(); } catch (_) {}
    if (under) fail('the meeting is the owner\'s: refused inside an agent\'s run', 403);
  }
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 20000);
  const haltCheck = () => { const h = co.halted(); if (h) fail('the company is under a ' + h + ' halt, so nobody can speak: resume it on the Halt screen first', 409); };
  const openCheck = () => { if (M.state === 'closed') fail('this meeting is closed: start a new meeting', 409); if (M.state === 'interrupted') fail('this meeting was interrupted: resume it first', 409); };
  function say(b) {
    guard(); haltCheck(); openCheck();
    const text = str(b && b.text); if (!text) fail('write something first');
    if (String(b.text).length > 20000) fail('that message is too long (20,000 characters at most)');
    if (!present().length) fail('nobody is seated: add someone first');
    const mt = mentions(text);
    if (mt.unknown.length) fail('nobody called ' + mt.unknown.join(', ') + ' is on the crew');
    if (mt.addressed && !mt.at.length) fail(mt.missing.join(', ') + (mt.missing.length === 1 ? ' is' : ' are') + ' not seated: add them first');
    if (M.closeAfter && M.run) fail('the ' + NOUN + ' is closing once the current speaker finishes, so your message was not sent: start a new ' + NOUN + ' to carry on', 409);
    if (M.run) {
      if (M.run.stopping === 'owner') {   // stopping after this turn: the message starts a round once it is over
        M.run.afterStop = { text, only: mt.at }; save(); emit('meeting');
        return view({ note: 'Your message goes to the table once the current speaker finishes.' });
      }
      if (M.run.floor) { M.run.floor = false; M.run.interjection = null; M.run.round = null; M.run.current = null; M.run.pending = { text, only: mt.at }; M.run.auto = 0; save(); kick(); return view({ note: 'sent' }); }
      M.run.interjection = { text, only: mt.at }; M.ownerHand = true; save(); emit('meeting');
      return view({ note: 'Your message is taken after the current speaker.' });
    }
    M.run = { auto: 0, pending: { text, only: mt.at }, round: null, current: null };
    save(); kick();
    return view({ missing: mt.missing });
  }
  function openRound() {
    guard(); haltCheck(); openCheck();
    if (M.run) fail('a round is running: raise your hand, or stop it first', 409);
    if (!present().length) fail('nobody is seated: add someone first');
    M.run = { auto: 0, pending: { open: true }, round: null, current: null };
    save(); kick(); return view();
  }
  function hand() { guard(); if (!M.run) fail('no round is running', 409); if (M.run.floor) return view(); M.ownerHand = true; save(); emit('meeting'); return view({ note: 'Your hand is up: the floor is yours after the current speaker.' }); }
  function carryOn() { guard(); M.floorWhy = null; if (!M.run || !M.run.floor) { M.ownerHand = false; save(); return view(); } M.run.floor = false; M.ownerHand = false; save(); kick(); return view(); }
  // Next: the owner has read the last turn; the next one may start
  function next() { guard(); if (M.run && (M.run.waitNext || M.run.gate)) { M.run.waitNext = false; M.run.gate = false; M.run.gateUntil = null; save(); kick(); } return view(); }
  function pace(b) { guard(); const sp = String((b && b.speed) || ''); if (!SPEEDS.includes(sp)) fail('speed is ' + SPEEDS.join(', ')); std.speed = sp; saveStd(); if (M.run) kick(); emit('meeting'); return view(); }
  // hold the floor: the current turn finishes and is shown, nothing new starts (so nothing is spent) until released
  function hold(b) { guard(); const on = !!(b && b.on); if (!M.run) return view(); M.run.paused = on; save(); if (!on) kick(); emit('meeting'); return view({ note: on ? 'Paused: the current turn finishes, then nothing new starts until you carry on.' : null }); }
  // Talk only (the whole meeting: no tools on any turn) and seat frames: the owner's switches, kept with the seats
  function setTalkOnly(b) { guard(); std.talkOnly = !!(b && b.on); saveStd(); emit('meeting'); return view({ note: std.talkOnly ? 'Talk only: nobody has tools in this meeting until you switch it off.' : 'Tools on: people may read and check what they say.' }); }
  function setFrames(b) { guard(); std.frames = !!(b && b.on); saveStd(); emit('meeting'); return view(); }
  // point of view (each seat its own transcript, the STANCE line, the gatekeeper's first take): the owner's switch, kept with
  // the seats; { on: null } goes back to the company's profile policy
  function setPov(b) { guard(); std.pov = b && typeof b.on === 'boolean' ? b.on : null; saveStd(); emit('meeting'); return view(); }
  /* a seat brought someone in (console/huddle.js: a colleague into the owner's live chat with that seat): the recent
     conversation goes in first as what was said (src 'chat'), then the seat's ASK / INVITE lines run as a round, the
     host closing it if something new was said. b = { by: seat, seed: [{who: 'owner'|seat, text}], directives: [{kind,
     name, why}] | text: the seat's reply with its lines } */
  function pullIn(b) {
    guard(); haltCheck(); openCheck();
    b = b || {};
    const by = resolve(String(b.by || '')); if (!by) fail('who brought them in?');
    if (M.run) fail('a round is running', 409);
    const list = Array.isArray(b.directives) ? b.directives.filter(d => d && /^(ASK|INVITE)$/.test(String(d.kind))) : directives(String(b.text || '')).list.filter(d => d.kind === 'ASK' || d.kind === 'INVITE');
    if (!list.length) fail('no ASK or INVITE line to act on');
    seedIn(b.seed);
    M.run = { auto: 0, pending: { pullIn: { by, list } }, round: null, current: null };
    save(); kick(); return view();
  }
  // the conversation so far, from another place (the live chat a colleague is brought into): recorded as said there
  // (src 'chat'), after the room's open line. seed = [{who: 'owner' | seat, text}]
  function seedIn(list) {
    if (!M.opened) record({ who: 'owner', kind: 'open', text: seatList() });
    for (const e of Array.isArray(list) ? list : []) {
      const who = e && (e.who === 'owner' ? 'owner' : resolve(String(e.who || '')));
      const text = str(e && e.text, 20000); if (!who || !text) continue;
      record({ who, kind: 'say', text, src: 'chat' });
    }
  }
  function seed(list) { guard(); openCheck(); seedIn(list); save(); emit(); return view(); }
  /* GET <prefix>/attach?runId=&from=N: the turn in flight (or a finished one) as NDJSON, from journal line N, then live:
     the same lines the live chat streams (agent.token, agent.tool_call, …, console.final, console.end). A run this room
     did not start answers console.gone. */
  function attach(req, res, q) {
    const rid = String((q && q.get && q.get('runId')) || ''); const from = Math.max(0, Number(q && q.get && q.get('from')) || 0);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const r = RUNS && RUNS.runOf ? RUNS.runOf(rid) : null;
    if (!r || r.meeting !== M.id || !String(r.streamId || '').startsWith(STREAM)) { res.write(JSON.stringify({ name: 'console.gone', payload: { runId: rid } }) + '\n'); return res.end(); }
    let off = null, ended = false;
    const ka = setInterval(() => { try { res.write('\n'); } catch (_) {} }, 20000); if (ka.unref) ka.unref();
    const stop = () => { ended = true; clearInterval(ka); if (off) off(); };
    off = RUNS.attach(rid, from, x => { if (ended) return; try { res.write(JSON.stringify({ name: x.name, payload: x.payload }) + '\n'); } catch (_) {} if (x.name === 'console.end') { stop(); res.end(); } });
    if (!off) { res.write(JSON.stringify({ name: 'console.gone', payload: { runId: rid } }) + '\n'); return res.end(); }
    if (ended) off();
    res.on('close', stop);
  }
  function presence(b) { if (b && b.here === false) lastSeen = 0; else lastSeen = Date.now(); if (M.run && !driving) kick(); return { ok: true, present: ownerPresent(), speed: effectiveSpeed() }; }
  /* Catch me up: one cheap talk-only turn (the leader, else the first seat) for the owner: five bullets of what was said
     since they last read, then what was decided and what is still asked. Shown to the owner only, not to the seats. */
  async function catchUp(b) {
    guard();
    const since = Math.max(0, Number(b && b.since) || 0);
    const seat = leader() || present()[0]; if (!seat) fail('nobody is seated');
    const m = await seatModel(seat, 'catchup'); if (m.error) fail(m.error, 409);
    const part = LOG.filter(e => e.i > since && e.kind === 'say');
    if (!part.length) fail('nothing has been said since you last read', 409);
    const line = '[CATCH-UP for ' + owner() + ', not your turn and not part of the meeting: ' + owner() + ' stepped away and is back. In plain words, write exactly five bullets of what was said since they left (the messages after "' + String(part[0].text).slice(0, 60).replace(/\s+/g, ' ') + '"), then a line "Decided:" with what was decided (or "nothing yet"), then a line "Open asks:" with what is still asked of anyone. No protocol lines.]';
    const r = await oneRun({ seat, model: m, messages: historyFor(seat, line), tools: false, purpose: 'catchup' });
    if (r.error || !String(r.text || '').trim()) fail('the catch-up did not come back: ' + (r.error || 'no text'), 502);
    record({ who: seat, kind: 'catchup', text: String(r.text).trim().slice(0, 4000), since, model: modelLabel(m) });
    return view();
  }
  /* Explain for the room: one cheap, talk-only turn of the speaker of one message, in plain words for everyone seated */
  async function explain(b) {
    guard(); openCheck();
    const i = Number(b && b.i); const e = LOG.find(x => x.i === i);
    if (!e || e.kind !== 'say' || e.who === 'owner' || !crew()[e.who]) fail('pick a message a crew member wrote', 404);
    const m = await seatModel(e.who, 'explain'); if (m.error) fail(m.error, 409);
    const F = frames(); const room = present().filter(x => x !== e.who).map(x => nameOf(x) + ' (' + frameOf(x, F).labels.join(', ') + ')').join(', ');
    const line = '[EXPLAIN FOR THE ROOM: ' + owner() + ' asked you to explain your message "' + String(e.text).replace(/\s+/g, ' ').slice(0, 120) + '…" for everyone seated (' + (room || 'the room') + '). In plain words: your point in one line, every term defined, and what it means for each of them. At most five sentences. No protocol lines.' + localeLine() + ']';
    const r = await oneRun({ seat: e.who, model: m, messages: historyFor(e.who, line), tools: false, purpose: 'explain' });
    if (r.error || !String(r.text || '').trim()) fail('the explanation did not come back: ' + (r.error || 'no text'), 502);
    record({ who: e.who, kind: 'say', text: directives(r.text).body || String(r.text).trim(), explains: i, model: modelLabel(m), provider: m.provider, modelId: m.model });
    return view();
  }
  /* the glossary (company/work/meetings/glossary.md, one line a term: "- **TERM**: what it means") and a deterministic
     acronym lint at no model cost: a short capitalised term used in the meeting that neither the glossary nor the text
     itself ("TERM (what it means)", "what it means (TERM)") defines */
  const GLOSSARY = () => co.p('company', 'work', 'meetings', 'glossary.md');
  const STOP = new Set(['I', 'A', 'OK', 'PASS', 'NO', 'YES', 'ASK', 'CALL', 'END', 'HAND', 'LATER', 'LOWER', 'INVITE', 'DISMISS', 'RULING', 'ACTION', 'QUESTION', 'KILL', 'TODO', 'FYI', 'AM', 'PM', 'UTC', 'USD', 'EUR', 'VND', 'CNY', 'GBP', 'US', 'UK', 'EU', 'OPEN', 'DONE', 'BLOCKED', 'CLOSED', 'AI', 'ID']);
  function glossaryTerms() {
    let t = ''; try { t = BOUNDED.tailText(GLOSSARY(), 1 << 20); } catch (_) {}
    const out = new Set(); for (const m of t.matchAll(/^[-*]\s*\**([A-Za-z0-9&/ .-]{1,40}?)\**\s*[:—–-]\s+\S/gm)) out.add(m[1].trim().toUpperCase());
    return out;
  }
  function terms() {
    const gl = glossaryTerms(); const said = LOG.filter(e => e.kind === 'say' && e.who !== 'owner' && e.who !== 'console');
    const all = said.map(e => e.text).join('\n');
    const seen = new Map();
    for (const e of said) for (const m of String(e.text).replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ').matchAll(/\b([A-Z][A-Z0-9&]{1,7})s?\b/g)) {
      const t = m[1]; if (STOP.has(t) || gl.has(t) || /^\d/.test(t)) continue;
      const esc = t.replace(/[&]/g, '\\&');
      if (new RegExp('\\b' + esc + 's?\\s*\\(([^)]{3,})\\)').test(all) || new RegExp('\\(\\s*' + esc + '\\s*\\)').test(all) || new RegExp('\\b' + esc + '\\s+(means|stands for|is short for)\\b', 'i').test(all)) continue;
      const r = seen.get(t) || { term: t, firstBy: nameOf(e.who), count: 0 }; r.count++; seen.set(t, r);
    }
    return { ok: true, glossary: path.relative(co.ROOT, GLOSSARY()), undefined: [...seen.values()].sort((a, b) => b.count - a.count).slice(0, 50) };
  }
  function addTerm(b) {
    guard();
    const term = str(b && b.term, 40).toUpperCase(), meaning = str(b && b.meaning, 300).replace(/\n/g, ' ');
    if (!/^[A-Z0-9&/ .-]{2,40}$/.test(term) || !meaning) fail('a term and what it means, in plain words');
    const f = GLOSSARY(); fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!fs.existsSync(f)) fs.writeFileSync(f, '# Glossary\n\nTerms the company uses, in plain words. One line a term: - **TERM**: what it means. Anyone may add one; the meeting\'s term check reads this file.\n\n');
    fs.appendFileSync(f, '- **' + term + '**: ' + meaning + ' (added by ' + owner() + ', ' + day() + ')\n');
    return terms();
  }
  function timeline() {
    const KEY = new Set(['open', 'end', 'ruling', 'close', 'resume', 'agenda', 'ask', 'call', 'catchup']);
    return { ok: true, moments: LOG.filter(e => KEY.has(e.kind) && (e.kind !== 'agenda' || e.op === 'current') && (e.kind !== 'call' || e.to === 'owner') && true)
      .map(e => ({ i: e.i, kind: e.kind, at: e.at, name: e.who === 'owner' ? owner() : nameOf(e.who), text: String(e.text || (TEXTS[e.kind] ? TEXTS[e.kind](e) : '')).slice(0, 140) })) };
  }
  /* Stop = stop after this turn: the current speaker finishes (never cut off: that would waste what they already thought);
     the queued turns, the hand checks and the round are cancelled. Only a company hard halt aborts a turn mid-way. */
  function stop() {
    guard();
    if (!M.run) return view();
    const R = M.run;
    if (!String(R.stopping || '').startsWith('halt')) R.stopping = 'owner';
    R.floor = false; M.ownerHand = false; R.interjection = null; R.pending = null; save();
    for (const id of checks) Promise.resolve(runner.cancel(id)).catch(() => {});   // hand checks and the leader's call: not turns
    const sp = R.current && R.current.runId ? R.current.seat : null;
    kick(); emit('meeting');
    return view({ note: sp ? 'Stopping after ' + firstName(sp) + ' finishes this turn; nothing after it starts.' : 'Stopped.' });
  }
  /* how hard they think, and one model for everyone or each person's usual: the owner's setting (Meeting › More, and in
     a live chat with colleagues), kept with the seats. Agents cannot change it (no line does; the route is the owner's). */
  function thinkView() {
    const t = std.think;
    return { level: t.level, label: THINK[t.level].label, effort: THINK[t.level].effort, levels: Object.keys(THINK).map(id => ({ id, label: THINK[id].label, effort: THINK[id].effort, deliberate: id === 'max' })),
      checks: THINK.light.label, pin: t.pin ? Object.assign({ label: modelLabel(t.pin) }, t.pin) : null, choices: pinChoices() };
  }
  function setThink(b) {
    guard(); b = b || {};
    const t = Object.assign({}, std.think);
    if (b.level !== undefined) {
      const lv = String(b.level || '');
      if (!THINK[lv]) fail('how hard they think is light, normal, deep or max');
      if (lv === 'max' && t.level !== 'max' && b.sure !== true) fail('Max thinking costs the most: pick it deliberately (sure: true)');
      t.level = lv;
    }
    if (b.pin !== undefined) {
      if (b.pin === null || b.pin === '' || b.pin === 'usual') t.pin = null;
      else {
        const pin = parsePin(b.pin); if (!pin) fail('pick a model as provider/model, or "usual" for each person\'s usual model');
        if (!pinChoices().some(c => samePair(c, pin))) fail(modelLabel(pin) + ' is not on the company\'s list of models (model-policy.json allowed)');
        t.pin = pin;
      }
    }
    const changed = t.level !== std.think.level || !(t.pin ? samePair(t.pin, std.think.pin) : !std.think.pin);
    std.think = t; saveStd();
    if (changed && M.opened) record({ who: 'owner', kind: 'think', level: t.level, pin: t.pin });
    emit('meeting');
    return view(changed ? { note: 'From the next turn: ' + THINK[t.level].label + ' thinking' + (t.pin ? ', everyone on ' + modelLabel(t.pin) : ', each on their usual model') + '. Hand checks stay ' + THINK.light.label + '.' } : {});
  }
  function setObserve(b) {
    guard();
    const on = !!(b && b.on);
    if (b && b.rounds != null) { const n = Number(b.rounds); if (!Number.isInteger(n) || n < 1 || n > MAX_OBSERVE) fail('rounds is a whole number from 1 to ' + MAX_OBSERVE); std.observeRounds = n; saveStd(); }
    if (on !== observing()) { M.observer = on; save(); if (M.opened) record({ who: 'owner', kind: 'observe', on }); }
    emit('meeting'); return view();
  }
  // the agenda: items, the one now under discussion, and tools per item (an item follows the meeting's Talk only switch
  // until the owner sets it: tools true or false)
  const itemTools = it => typeof it.tools === 'boolean' ? it.tools : !std.talkOnly;
  function agenda(b) {
    guard();
    const op = String((b && b.op) || '');
    const find = () => { const it = M.agenda.find(a => a.id === String(b.id || '')); if (!it) fail('no agenda item ' + b.id, 404); return it; };
    if (op === 'add') {
      const title = str(b.title, 200); if (!title) fail('give the item a title');
      if (M.agenda.length >= 30) fail('30 agenda items at most');
      const it = { id: 'a' + (M.agenda.reduce((n, a) => Math.max(n, Number(String(a.id).slice(1)) || 0), 0) + 1), title, tools: typeof b.tools === 'boolean' ? b.tools : null, done: false };
      M.agenda.push(it); if (!M.agendaAt) M.agendaAt = it.id;
      save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'add', text: it.title, tools: itemTools(it) });
    } else if (op === 'tools') { const it = find(); it.tools = b.on === true; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'tools', text: it.title, tools: it.tools }); }
    else if (op === 'current') { const it = find(); M.agendaAt = it.id; it.done = false; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'current', text: it.title, tools: itemTools(it) }); }
    else if (op === 'done') { const it = find(); it.done = true; if (M.agendaAt === it.id) { const nx = M.agenda.find(a => !a.done); M.agendaAt = nx ? nx.id : null; } save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'done', text: it.title }); }
    else if (op === 'remove') { const it = find(); M.agenda = M.agenda.filter(a => a !== it); if (M.agendaAt === it.id) M.agendaAt = (M.agenda.find(a => !a.done) || {}).id || null; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'remove', text: it.title }); }
    else fail('op is add, tools, current, done or remove');
    emit('meeting'); return view();
  }
  function setLeader(b) {
    guard();
    if (P.fixedLeader) fail(nameOf(P.fixedLeader) + ' leads this ' + NOUN + '; that does not change', 409);
    const raw = b ? b.seat : null;
    if (raw === null || raw === undefined || raw === '' || /^(none|nobody|no|off)$/i.test(String(raw))) {
      if (std.leader) { std.leader = null; saveStd(); if (M.opened) record({ who: 'owner', kind: 'lead' }); }
      emit('meeting'); return view();
    }
    const id = resolve(String(raw)); if (!id) fail('nobody called ' + raw + ' is on the crew', 404);
    if (!present().includes(id)) seatsChange({ add: [id] }, true);
    if (std.leader !== id) { std.leader = id; saveStd(); if (M.opened) record({ who: id, kind: 'lead' }); }
    emit('meeting'); return view();
  }
  // the owner's add and remove set the STANDING seats, and override what an agent did in this meeting
  function seatsChange(b, inner) {
    if (!inner) guard();
    const add = Array.isArray(b && b.add) ? b.add : [], remove = Array.isArray(b && b.remove) ? b.remove : [];
    if (!add.length && !remove.length) fail('say who to add or remove');
    for (const k of add) {
      const id = resolve(String(k)); if (!id) fail('nobody called ' + k + ' is on the crew', 404);
      const wasHere = present().includes(id);
      if (Array.isArray(P.standing)) {   // a room with fixed standing seats: the owner's pick joins as a guest of this one
        if (wasHere) continue;
        if (present().length >= MAX_SEATS) fail('the ' + NOUN + ' is full (' + MAX_SEATS + ' seats)');
        if (M.guests.filter(c => !M.excused.includes(c)).length >= MAX_GUESTS) fail(MAX_GUESTS + ' colleague' + (MAX_GUESTS === 1 ? ' is' : 's are') + ' here already, the most at once: send one back out first', 409);
        M.excused = M.excused.filter(c => c !== id); if (!M.guests.includes(id)) M.guests.push(id); save();
        if (!M.opened) record({ who: 'owner', kind: 'open', text: seatList() });
        record({ who: id, kind: 'join', by: 'owner' });
        continue;
      }
      if (!std.seats.includes(id)) { if (std.seats.length >= MAX_SEATS) fail('the meeting is full (' + MAX_SEATS + ' seats)'); std.seats.push(id); saveStd(); }
      M.guests = M.guests.filter(c => c !== id); M.excused = M.excused.filter(c => c !== id); save();
      if (!wasHere && M.opened) record({ who: id, kind: 'join' });
    }
    for (const k of remove) {
      const id = resolve(String(k)) || String(k);
      if (P.fixedLeader && id === P.fixedLeader) fail(nameOf(id) + ' leads this ' + NOUN + ' and stays', 409);
      if (speakingNow(id)) { deferLeave({ who: id, by: 'owner', op: 'remove' }); continue; }   // never cut off mid-turn
      removeSeat(id);
    }
    emit('meeting');
    return inner ? null : view();
  }
  /* one meeting at a time: a new one needs the current one closed (or never opened); an incident meeting may interrupt
     an open meeting of another type, which resumes when the incident meeting is closed */
  function newMeeting(b) {
    guard();
    b = b || {};
    if (M.run) fail('a round is running: stop it first', 409);
    const type = TYPES.includes(b.type) ? b.type : (b.type ? fail('type is ' + TYPES.join(', ')) : 'decision');
    let resumeAfter = null;
    if (M.opened && M.state === 'open') {
      if (type === 'incident' && M.type !== 'incident') { M.state = 'interrupted'; M.reason = 'paused for an incident meeting'; record({ who: 'owner', kind: 'close', state: 'interrupted', why: M.reason }); save(); resumeAfter = M.id; }
      else fail('one meeting at a time: close this meeting first (an incident meeting may interrupt it)', 409);
    }
    M = fresh(type, b.title); M.resumeAfter = resumeAfter; LOG = []; seq = 0; save(); emit('meeting'); return view();
  }
  // Close: the owner ends the meeting, with or without an END from the leader; it records who closed it
  async function close(b) {
    guard();
    const why = str(b && b.why, 300);
    if (M.state === 'closed') return view();
    if (M.run) {   // the current speaker finishes first (never cut off), then it closes by itself
      M.closeAfter = { state: 'closed', by: 'owner', why }; save(); stop();
      for (let i = 0; i < 50 && M.run; i++) await new Promise(r => setTimeout(r, 20));   // a turn about to end ends here; a long one closes later
      if (M.run) { const sp = M.run.current && M.run.current.seat; return view({ note: 'The ' + NOUN + ' closes once ' + (sp ? firstName(sp) : 'the current speaker') + ' finishes this turn.', closing: true }); }
      return view();
    }
    finalize('closed', 'owner', why);
    return view();
  }
  function finalize(state, by, why) {
    M.closeAfter = null;
    M.state = state; M.closedAt = new Date().toISOString(); M.closedBy = by; if (why) M.reason = why;
    if (M.opened) {
      const tm = terms().undefined;
      if (tm.length) record({ who: 'console', kind: 'note', terms: tm.map(x => x.term), text: 'Terms used without a definition: ' + tm.map(x => x.term + ' (first used by ' + x.firstBy + ')').join(', ') + '. Add them to company/work/meetings/glossary.md.' });
      let echo = null;
      if (povOn()) { try { echo = echoStats(); const f = path.join(MINUTES_DIR(), 'stats.jsonl'); fs.mkdirSync(MINUTES_DIR(), { recursive: true }); fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), meeting: M.id, kind: P.kind, type: M.type, seats: echo.seats, pairs: echo.pairs, unexplainedShifts: echo.unexplainedShifts }) + '\n'); } catch (_) { echo = null; } }
      record(Object.assign({ who: by, kind: 'close', state, why }, echo ? { echo: echoLine(echo) } : {}));
    }
    save(); reindex();
    if (typeof deps.onFinalize === 'function') { try { deps.onFinalize({ state, id: M.id, LOG: LOG.slice() }); } catch (_) {} }
    if (state === 'closed' && M.resumeAfter) {   // the meeting an incident interrupted carries on
      const back = readMeeting(M.resumeAfter);
      if (back && back.state === 'interrupted') { load(back.id); M.state = 'open'; M.reason = null; save(); record({ who: 'owner', kind: 'resume' }); }
    }
    emit('meeting');
  }
  function resume(b) {
    guard(); haltCheck();
    const id = b && b.id ? String(b.id) : M.id;
    if (M.run) fail('a round is running', 409);
    if (id !== M.id) { if (M.opened && M.state === 'open') fail('one meeting at a time: close this meeting first', 409); const m = readMeeting(id); if (!m) fail('no meeting ' + id, 404); load(id); }
    if (M.state !== 'interrupted') fail('this meeting is ' + M.state + ', not interrupted', 409);
    M.state = 'open'; M.reason = null; save(); record({ who: 'owner', kind: 'resume' }); emit('meeting');
    return view();
  }
  // the owner's register controls: an owner ruling (confirmed: decisions.md), confirming a proposed one, "not recorded
  // here", an open question of their own, and their own lines only (each owner updates their own)
  async function register(b) {
    guard();
    b = b || {}; const op = String(b.op || '');
    const r = reg();
    if (op === 'ruling') {
      const row = REG.add(r, 'rulings', { text: b.text, plain: b.plain, confirmed: true }, 'owner');
      row.decisionId = await decide('owner', 'Meeting ruling (' + day() + (M.title ? ', ' + M.title : '') + '): ' + row.text + (row.plain ? ' In plain words: ' + row.plain : ''), 'the owner\'s ruling at the meeting');
      saveReg(); if (M.opened) record({ who: 'owner', kind: 'ruling', text: row.text, plain: row.plain, n: row.n, proposed: false });
    } else if (op === 'confirm') {
      const row = REG.update(r, 'rulings', b.n, { confirmed: true, plain: b.plain, text: b.text }, 'owner', true);
      if (!row.decisionId) row.decisionId = await decide('owner', 'Meeting ruling (' + day() + (M.title ? ', ' + M.title : '') + '): ' + row.text + (row.plain ? ' In plain words: ' + row.plain : ''), 'proposed by ' + nameOf(row.proposedBy || 'owner') + ', confirmed by the owner at the meeting');
      saveReg(); if (M.opened) record({ who: 'owner', kind: 'note', text: owner() + ' confirmed ruling ' + row.n + ': ' + row.text });
    } else if (op === 'not-recorded') { REG.add(r, 'notRecorded', { text: b.text }, 'owner'); saveReg(); }
    else if (op === 'question' || op === 'kill') { REG.add(r, op === 'question' ? 'questions' : 'kills', { text: b.text, plain: b.plain, owner: 'owner' }, 'owner'); saveReg(); }
    else if (op === 'update') { REG.update(r, String(b.section || ''), b.n, b, 'owner', true); saveReg(); }
    else fail('op is ruling, confirm, not-recorded, question, kill or update');
    return registerView();
  }
  const registerView = () => { const r = reg(); return { ok: true, register: r, problems: REG.problems(r), file: path.relative(co.ROOT, REG.mdFile(r)) }; };
  const regSafe = fn => async (...a) => { try { return await fn(...a); } catch (e) { if (e.code === 'invalid' || e.code === 'not-yours' || e.code === 'missing') fail(e.message, e.code === 'missing' ? 404 : e.code === 'not-yours' ? 403 : 400); throw e; } };
  // the meetings on record, newest first (the meta files are small: one per meeting)
  function list() {
    let ids = []; try { ids = fs.readdirSync(path.join(DIR(), 'm')).filter(f => /^m-[a-z0-9]+\.json$/.test(f)).map(f => f.slice(0, -5)); } catch (_) {}
    return ids.map(readMeeting).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 200)
      .map(m => ({ id: m.id, type: m.type, title: m.title, state: m.state, startedAt: m.startedAt, closedAt: m.closedAt || null, closedBy: m.closedBy || null, current: m.id === M.id }));
  }

  /* ---------- what the page shows ---------- */
  async function view(extra) {
    const seats = await Promise.all(ordered().map(async id => {
      const m = await seatModel(id, 'turn');
      return { id, name: nameOf(id), title: titleOf(id), leader: id === leader(), guest: M.guests.includes(id), invitedBy: M.guests.includes(id) ? invitedBy(id) : null,
        standing: std.seats.includes(id), model: m.error ? null : { provider: m.provider, model: m.model, label: modelLabel(m), from: m.from || null, effort: m.effort || null, pinned: !!m.pinned }, modelError: m.error || null };
    }));
    const R = M.run;
    let live = { phase: 'idle', speaking: null, next: [], hands: [], ownerHand: !!M.ownerHand, checking: null, round: null, interjection: false, paused: false, waitNext: false, yourTurn: false };
    if (R) {
      const ctl = R.round && R.round.ctl;
      const queue = ctl ? [...ctl.front, ...ctl.after, ...ctl.normal].filter(x => present().includes(x.cmd) && (x.kind !== 'turn' || hasNewFor(x.cmd) || (R.current && R.current.seat === x.cmd))) : [];
      const seen = new Set(R.current ? [R.current.seat] : []); const next = [];
      for (const x of queue) if (!seen.has(x.cmd)) { seen.add(x.cmd); next.push({ id: x.cmd, name: nameOf(x.cmd), kind: x.kind }); }
      live = { phase: R.floor ? 'floor' : R.stopping ? 'stopping' : 'round', ownerHand: !!M.ownerHand, interjection: !!R.interjection || !!R.afterStop,
        stoppingAfter: R.stopping && R.current && R.current.runId ? nameOf(R.current.seat) : null, closing: !!M.closeAfter,
        paused: !!R.paused, pausedFor: R.paused === 'consent' && R.consent ? { seat: nameOf(R.consent.seat), tool: R.consent.tool, qid: R.consent.qid } : null, waitNext: !!R.waitNext, nextAt: R.gateUntil || null, yourTurn: !!R.floor, floorWhy: R.floor ? M.floorWhy || null : null,
        speaking: R.current ? { id: R.current.seat, name: nameOf(R.current.seat), kind: R.current.item.kind, from: R.current.item.from || null, why: R.current.item.why || null, calledBy: R.current.item.calledBy || null, wrap: !!R.current.item.wrap, runId: R.current.runId, model: modelLabel(R.current.model), noTools: !!R.current.noTools } : null,
        next: next.slice(0, 4), hands: ctl ? Object.entries(ctl.up).map(([id, why]) => ({ id, name: nameOf(id), why })) : [],
        checking: R.checking ? { kind: R.checking.kind, names: R.checking.seats.map(nameOf) } : null,
        round: observing() && R ? { auto: (R.auto || 0) + 1, cap: std.observeRounds } : null };
    }
    const roster = Object.keys(crew()).map(id => ({ id, name: nameOf(id), title: titleOf(id), seated: present().includes(id) }));
    const shown = LOG.filter(SHOWN);
    return Object.assign({ ok: true, owner: owner(), kind: P.kind,
      meeting: { id: M.id, type: M.type, title: M.title, state: M.state, reason: M.reason || null, closedBy: M.closedBy ? nameOf(M.closedBy) : null, closedAt: M.closedAt || null, resumeAfter: M.resumeAfter || null,
        agenda: M.agenda.map(a => Object.assign({}, a, { toolsOn: itemTools(a) })), agendaAt: M.agendaAt, toolsOn: toolsOn(), talkOnly: !!std.talkOnly, frames: !!std.frames, pov: povOn(), fixedLeader: P.fixedLeader || null, types: TYPES, speed: std.speed || 'instant', speeds: SPEEDS, effectiveSpeed: effectiveSpeed(), ownerPresent: ownerPresent(),
        startedAt: M.startedAt, opened: !!M.opened, observer: observing(), observeRounds: std.observeRounds, leader: std.leader, leaderSeated: !!leader(),
        cost: M.cost, costLine: costLine(), estimateLine: estimateLine(seats.filter(x => x.model).map(x => x.model)), think: thinkView(), minutes: minutesRel(), excused: M.excused.map(id => ({ id, name: nameOf(id) })) },
      seats, roster, live, total: shown.length }, extra || {});
  }
  // what the page shows: everything said and done, passes included (one dim line each, as at the table); the console's
  // notes to a seat about its own lines are the seat's, not the page's
  const SHOWN = e => e.kind !== 'nudge';
  function entries(q) {
    const shown = LOG.filter(SHOWN);
    const limit = Math.min(200, Math.max(1, Number(q && q.get && q.get('limit')) || 60));
    const before = q && q.get && q.get('before') ? Number(q.get('before')) : null;
    const from = q && q.get && q.get('from') ? Number(q.get('from')) : null;
    const upto = before ? shown.filter(e => e.i < before) : shown;
    const page = from ? upto.filter(e => e.i >= from).slice(0, limit) : upto.slice(-limit);
    if (from) return { ok: true, entries: page.map(e => Object.assign({}, e, { name: e.who === 'owner' ? owner() : e.who === 'console' ? 'Console' : nameOf(e.who), toName: e.to ? (e.to === 'owner' ? owner() : nameOf(e.to)) : undefined, byName: e.by ? nameOf(e.by) : undefined, line: TEXTS[e.kind] && e.kind !== 'note' ? TEXTS[e.kind](e) : undefined })),
      cursor: page.length && page[0].i > (shown[0] || {}).i ? page[0].i : null, more: !!(page.length && page[0].i > (shown[0] || {}).i), after: page.length && page[page.length - 1].i < (shown[shown.length - 1] || {}).i };
    const name = e => e.who === 'owner' ? owner() : e.who === 'console' ? 'Console' : nameOf(e.who);
    return { ok: true, entries: page.map(e => Object.assign({}, e, { name: name(e), toName: e.to ? (e.to === 'owner' ? owner() : nameOf(e.to)) : undefined, byName: e.by ? nameOf(e.by) : undefined, line: TEXTS[e.kind] && e.kind !== 'note' ? TEXTS[e.kind](e) : undefined })),
      cursor: page.length && upto.length > page.length ? page[0].i : null, more: upto.length > page.length };
  }
  function minutesText(q) {
    const d = q && q.get && q.get('date') ? String(q.get('date')) : day();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail('date is YYYY-MM-DD');
    let text = ''; try { text = BOUNDED.tailText(minutesFile(d), 2 << 20); } catch (_) {}
    let days = []; try { days = fs.readdirSync(MINUTES_DIR()).map(f => (f.startsWith(MIN_PREFIX) && /^(\d{4}-\d{2}-\d{2})\.md$/.exec(f.slice(MIN_PREFIX.length)) || [])[1]).filter(Boolean).sort().reverse().slice(0, 60); } catch (_) {}
    return { ok: true, date: d, path: minutesRel(d), text, days };
  }
  function mount(route) {
    const esc = ROUTE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const R = sub => new RegExp('^' + esc + sub.replace(/\//g, '\\/') + '$');
    route('GET', R(''), () => view());
    route('GET', R('/entries'), (m, q) => entries(q));
    route('GET', R('/minutes'), (m, q) => minutesText(q));
    route('POST', R('/say'), (m, q, b) => say(b));
    route('POST', R('/round'), () => openRound());
    route('POST', R('/hand'), () => hand());
    route('POST', R('/continue'), () => carryOn());
    route('POST', R('/stop'), () => stop());
    route('POST', R('/observe'), (m, q, b) => setObserve(b));
    route('POST', R('/agenda'), (m, q, b) => agenda(b));
    route('POST', R('/close'), (m, q, b) => close(b));
    route('POST', R('/resume'), (m, q, b) => resume(b));
    route('GET', R('/list'), () => ({ ok: true, meetings: list() }));
    route('GET', R('/timeline'), () => timeline());
    route('GET', R('/register'), () => registerView());
    route('GET', R('/terms'), () => terms());
    route('POST', R('/glossary'), (m, q, b) => addTerm(b));
    route('POST', R('/explain'), (m, q, b) => explain(b));
    route('POST', R('/register'), regSafe((m, q, b) => register(b)));
    route('GET', R('/search'), (m, q) => search(q));
    route('GET', R('/status'), () => ({ ok: true, live: require(path.join(LIB, 'meetings.js')).liveWork() }));
    route('POST', R('/next'), () => next());
    route('POST', R('/pace'), (m, q, b) => pace(b));
    route('POST', R('/hold'), (m, q, b) => hold(b));
    route('POST', R('/presence'), (m, q, b) => presence(b));
    route('POST', R('/catchup'), (m, q, b) => catchUp(b));
    route('POST', R('/lead'), (m, q, b) => setLeader(b));
    route('POST', R('/seats'), (m, q, b) => seatsChange(b));
    route('POST', R('/new'), (m, q, b) => newMeeting(b));
    route('POST', R('/talkonly'), (m, q, b) => setTalkOnly(b));
    route('POST', R('/frames'), (m, q, b) => setFrames(b));
    route('POST', R('/pov'), (m, q, b) => setPov(b));
    route('POST', R('/think'), (m, q, b) => setThink(b));
    route('GET', R('/attach'), (m, q, b, req, res) => attach(req, res, q));
  }
  // the console started: carry on a meeting a previous console process left mid-round (the turn in flight is re-attached)
  function start() {
    load();
    if (M.run) { M.run.checking = null; save(); armHalt(); if (M.run.consent) armConsent(); if (!M.run.floor) kick(); }
  }
  load();
  return { mount, start, view, entries, minutesText, say, openRound, setPov, hand, carryOn, stop, setObserve, agenda, setLeader, seatsChange, newMeeting, close, resume, list, register: regSafe(b => register(b)), registerView, search: q => search(q), reindex, explain, terms, addTerm, next, pace, hold, presence, catchUp, timeline, busy,
    setTalkOnly, setFrames, setThink, pullIn, seed, attach, profile: P, present: () => (M ? present() : []), state: () => (M ? M.state : null),
    idle: () => !M.run && !driving, _state: () => ({ std, M, LOG }), _reload: load };
};
module.exports.directives = directives;
module.exports.isPass = isPass;
module.exports.maybePass = maybePass;
module.exports.handReply = handReply;
module.exports.fitHistory = fitHistory;
module.exports.modelLabel = modelLabel;
module.exports.fitEffort = fitEffort;
module.exports.THINK = THINK;
module.exports.TIMING = { NUDGE_MS, STALL_MS };
module.exports.LIMITS = { MAX_INVITES_PER_ROUND, MAX_ASKS_PER_ROUND, MAX_HANDS_PER_ROUND, OBSERVE_ROUNDS };
