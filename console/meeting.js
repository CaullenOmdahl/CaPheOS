/* console/meeting.js — the owner's meeting with the crew, in the console (Chat › Meeting). Spec: docs/MEETINGS.md.
 *
 * The owner speaks; everyone seated answers in turn, the leader first, each seeing everything said before them; a seat
 * with nothing to add passes (passes are not shown). The meeting carries on until New meeting. Agents run it like a
 * call with lines at the end of a reply: ASK: <name> — <q> (that seat answers next and may ask back; the others are
 * polled, talk only, for a raised hand), INVITE: / DISMISS: (seat changes for this meeting only), CALL: (the leader gives
 * the floor), END: <summary> (the leader closes the discussion) and RULING: <what was decided> (recorded). The owner's
 * controls are console buttons: Round, Raise hand / Continue, Stop round, Observe (N rounds) / Take part, New meeting,
 * Talk only, the leader, and the standing seats.
 *
 * Runs: every turn is a station run (POST /api/run, isTask true unless talk only) on the seat's current model (the entry
 * of its model-policy chain models.js has applied: console/chat.js modelFor), admitted through company/tools/lib/admit.js
 * (door 'meeting'), tracked by console/chat-runs.js (detach + observer feed), so a console restart re-attaches to the
 * turn in flight and the meeting carries on from its saved queue. A refused turn is retried once on the seat's next
 * chain entry with one plain line (lib/refusal.js). A halt stops the meeting.
 *
 * State (company/state/meetings/, mode 600): seats.json (the standing seats, leader, talk only, observe rounds),
 * meeting.json (this meeting: guests, dismissals, observe, cost, the round in progress), log.jsonl (every event, all
 * meetings; read from its end with lib/bounded.js, rolled by retention.js). Minutes: company/work/meetings/meeting-<date>.md,
 * written as it happens. END summaries and RULING lines go to company/work/decisions.md through decision.js add.
 *
 *   const M = require('./meeting.js')(deps); M.mount(route); M.start();
 *   deps: { co, owner(), emit(topic), stationPost, modelFor(seat), runs (chat-runs), run(tool, args) } — tests pass
 *   runner: { start(o) -> {runId}|{error}, wait(runId) -> result, cancel(runId) } instead of the station
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
function handReply(t) { const m = /^\W*HAND\b[\s—–:,-]*(.*)$/is.exec(String(t || '').trim()); return m ? m[1].split('\n')[0].trim().replace(/[.\s]+$/, '').slice(0, 200) : null; }
function fitHistory(msgs) {
  let m = msgs.slice(-HISTORY_MAX_MSGS);
  while (m.length > 1 && (m[0].role !== 'user' || Buffer.byteLength(JSON.stringify(m)) > HISTORY_MAX_BYTES)) m = m.slice(1);
  return { messages: m, dropped: msgs.length - m.length };
}
function modelLabel(m) {
  if (!m) return '';
  const p = m.provider, id = String(m.model || '');
  if (p === 'claude-cli' || p === 'anthropic') return 'Claude ' + (/haiku/i.test(id) ? 'Haiku' : /sonnet/i.test(id) ? 'Sonnet' : /opus/i.test(id) ? 'Opus' : id);
  if (p === 'custom' || p === 'minimax') return 'MiniMax (' + id + ')';
  if (p === 'deepseek') return 'DeepSeek (' + id + ')';
  return p + ' ' + id;
}

module.exports = function meeting(deps) {
  const co = deps.co;
  const owner = () => (typeof deps.owner === 'function' ? deps.owner() : null) || (co.config.owner && co.config.owner.name) || 'Owner';
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const LIB = path.join(__dirname, '..', 'company', 'tools', 'lib');
  const REF = require(path.join(LIB, 'refusal.js'));
  const BOUNDED = require(path.join(LIB, 'bounded.js'));
  const admitLib = () => require(path.join(LIB, 'admit.js'));
  const lint = require(path.join(__dirname, 'command-ask.js'));
  const DIR = () => co.p('company', 'state', 'meetings');
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
    const ids = Object.keys(crew()); const ceo = ceoId();
    return (ceo && ids.includes(ceo) ? [ceo].concat(ids.filter(x => x !== ceo)) : ids).slice(0, 6);
  }
  function loadStd() {
    const c = readJ(F.seats()) || {};
    std = { seats: Array.isArray(c.seats) ? c.seats.filter(x => typeof x === 'string') : defaultSeats(),
      leader: 'leader' in c ? (typeof c.leader === 'string' ? c.leader : null) : ceoId(),
      speed: typeof c.speed === 'string' ? c.speed : 'manual', observeRounds: Number.isInteger(c.observeRounds) && c.observeRounds > 0 ? Math.min(c.observeRounds, MAX_OBSERVE) : OBSERVE_ROUNDS };
    return std;
  }
  const saveStd = () => writeJ(F.seats(), Object.assign({}, std, { updatedAt: new Date().toISOString() }));
  const TYPES = ['decision', 'incident', 'planning', 'review'];
  const fresh = (type, title) => ({ v: 2, id: 'm-' + Date.now().toString(36), type: TYPES.includes(type) ? type : 'decision', title: String(title || '').trim().slice(0, 200),
    state: 'open', openedBy: 'owner', startedAt: new Date().toISOString(), opened: false, guests: [], excused: [], observer: false, agenda: [], agendaAt: null,
    cost: { turns: 0, usd: 0 }, ownerHand: false, run: null, resumeAfter: null });
  /* pacing, built for a reader: Next (manual) is the default while the owner is present; when they are away (or set a
     speed) it advances by itself, waiting the speed's reading time between completed turns. The type sets the speed
     used when the owner is away. A paused meeting starts nothing new, so it spends nothing. */
  const SPEEDS = ['instant', 'fast', 'normal', 'slow', 'manual'];
  const SPEED_MS = Object.assign({ instant: 0, fast: 2000, normal: 8000, slow: 20000 }, deps.speedMs || {});
  const TYPE_SPEED = { decision: 'normal', incident: 'fast', planning: 'normal', review: 'slow' };
  const PRESENT_MS = 45000;   // the page says the owner is there (tab visible, used in the last 2 minutes) every 20 s
  let lastSeen = 0;
  const ownerPresent = () => Date.now() - lastSeen < PRESENT_MS;
  const effectiveSpeed = () => { const sp = SPEEDS.includes(std.speed) ? std.speed : 'manual'; return ownerPresent() ? sp : (sp === 'manual' ? TYPE_SPEED[M.type] || 'normal' : sp); };
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
  const joinText = e => nameOf(e.who) + ' joined the meeting' + (e.by ? ', invited by ' + nameOf(e.by) : '') + (e.why ? ': ' + e.why : '');
  const leaveText = e => nameOf(e.who) + ' left the meeting' + (e.by && e.by !== e.who ? ', dismissed by ' + nameOf(e.by) : '') + (e.why ? ': ' + e.why : '');
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
  const closeText = e => e.state === 'interrupted' ? 'The meeting was interrupted' + (e.why ? ': ' + e.why : '') : 'The meeting was closed by ' + nameOf(e.who) + (e.why ? ': ' + e.why : '');
  const resumeText = e => owner() + ' resumed the meeting';
  const registerText = e => nameOf(e.who) + ' put in the register (' + ({ actions: 'action', questions: 'open question', kills: 'kill condition' }[e.section] || e.section) + ' ' + e.n + '): ' + e.text + (e.plain ? ' — in plain words: ' + e.plain : '');
  const consentText = e => e.op === 'asked' ? nameOf(e.who) + ' asked to use ' + (e.tool || 'a tool') + '; the meeting is paused until you answer it on Today' : 'Approval for ' + nameOf(e.who) + ' (' + (e.tool || 'a tool') + '): ' + (e.decision === 'once' ? 'allowed' : e.decision === 'deny' ? 'declined' : e.decision) + '; the meeting carries on';
  const TEXTS = { join: joinText, leave: leaveText, lead: leadText, ask: askText, hand: handText, call: callText, lower: lowerText, end: endText, ruling: rulingText, observe: observeText, agenda: agendaText, parse: parseText, close: closeText, resume: resumeText, consent: consentText, register: registerText, note: e => e.text };
  const minutesFile = d => path.join(MINUTES_DIR(), 'meeting-' + (d || day()) + '.md');
  function minutes(text, kind) {
    try {
      fs.mkdirSync(MINUTES_DIR(), { recursive: true });
      const f = minutesFile();
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, '# Meeting: ' + day() + '\n\n_Minutes of the owner\'s meeting with the crew (Chat › Meeting in the console), written as it happens: every word, by who said it, with the time and the model each spoke on. Passes are not shown._\n');
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
    if (e.kind === 'say') minutes('\n**' + nameOf(e.who) + '** (' + t + (e.model ? ', ' + e.model : '') + (e.to ? ', answering ' + nameOf(e.to) : '') + (e.interject ? ', interjecting' : '') + (e.explains ? ', explaining for the room' : '') + '):\n' + e.text + '\n', e.kind);
    else if (e.kind === 'open') { M.opened = true; minutes('\n## ' + t + ': the meeting opens\n\nAt the meeting: ' + e.text + '.\n', e.kind); }
    else if (TEXTS[e.kind]) { const s = TEXTS[e.kind](e); minutes('\n_' + t + ': ' + s + (/[.!?]$/.test(s) ? '' : '.') + '_\n', e.kind); }
    if (e.kind === 'say' || e.kind === 'open' || e.kind === 'agenda') reindex();   // searchable as it goes
    emit('meeting');
    return e;
  }
  const note = text => record({ who: 'console', kind: 'note', text });

  /* ---------- what each seat is sent ---------- */
  const PRE = () => '[THE MEETING] The owner, ' + owner() + ', has called the company to a meeting in the console (Chat › Meeting, behind the owner\'s sign-in; not a relayed message). Everyone seated sees everything said there; each message is labelled with who said it, and people take turns. ' + owner() + ' opened this meeting, so speaking here is not contacting the owner; what you need from them outside the meeting still goes to the CEO or the owner channel.\n' +
    'When it is your turn (the speaking contract):\n' +
    '- Your point first, in one line. Then the reasons, briefly.\n' +
    '- Define any term the room may not share (an acronym, a tool name, a finance or legal word) the first time you use it, in a few plain words.\n' +
    '- Say what your point means for the other functions present (the turn note lists who is in the room and what each needs).\n' +
    '- Speak as yourself, from your own area, as you would in a meeting: short and to the point, a few sentences unless asked for more. Answer what was put to you; agree, disagree or build on what the others said, by name; do not repeat what someone already covered.\n' +
    '- If you have nothing to add, reply with exactly PASS and nothing else.\n' +
    '- Check the facts you state, but do not start long work during the meeting: say what you will do, write it where your own loop picks it up (your files or a handoff), and do it there. When the turn note says talk only, you have no tools: say only what you know, and never claim you read or changed something.\n' +
    '- The owner is a busy non-technical person. In a meeting too, infrastructure, monitoring, tools, framework bugs and internal process are the crew\'s: settle them among yourselves or route them, never put them to the owner, and never ask the owner to run a command.\n' +
    '- The meeting may have a leader (each turn note names them). The leader runs it: keeps it on the owner\'s question, brings in the right people, and closes each topic with what was decided and who does what. A decision the owner makes here is an owner ruling: the leader ends a reply with a line of its own, RULING: <what was decided, who does it> — plain: <one sentence anyone can read>; it goes into the meeting\'s register as proposed, and the owner confirms it (only then is it in company/work/decisions.md). With no leader, whoever the ruling concerns writes that line.\n' +
    '- The register is the meeting\'s output, and nobody writes a line for someone else. For what is yours to do, end your reply with ACTION: <what> — by <date, or own loop> — plain: <one sentence anyone can read> — affects: <who it touches>. An open question of yours: QUESTION: <it> — plain: <…>. A condition that would stop the work: KILL: <it> — plain: <…>. A line without its plain part is refused. Later you update only your own lines: node company/tools/meeting-register.js update <meeting> actions <n> --by <your name> --status "…".\n' +
    '- To ask someone a question directly, end your reply with a line of its own: ASK: <name> — <your question>. They answer next and may ASK you back; keep such an exchange short. While two people are in an exchange, the others are asked after each answer whether they want to interject; then reply HAND — <what you want to add> to come in now, otherwise NO. The leader calls on raised hands (with no leader, a raised hand gets the floor next); the leader can also give anyone the floor by ending a reply with CALL: <name>.\n' +
    '- When the owner is observing (the turn note says so), they will not speak unless they step in: do not put questions to them or wait for their answer; keep the discussion going among yourselves. The leader runs it through to a result and, when it is complete, ends a reply with a line of its own: END: <one line on what was decided and who does what> — plain: <the same in one sentence anyone can read>. With no leader, anyone may close it that way.\n' +
    '- You can bring people in and out, as on a call: INVITE: <name> — <why the discussion needs them> (they join at once, see the meeting so far and speak after the others this round), DISMISS: <name> — <why> (yourself included, when you have nothing more to give). Invite only when the discussion needs that person. The leader stays unless the owner changes it.\n' +
    '- The minutes, every word as said, are in company/work/meetings/meeting-<date>.md.]';
  // talk only is the default: tools are on only for the agenda item the owner switched them on for
  const currentItem = () => (M.agenda || []).find(a => a.id === M.agendaAt) || null;
  const toolsOn = () => { const it = currentItem(); return !!(it && it.tools); };
  const TYPE_BLOCK = {
    decision: 'This is a decision meeting: bring it to a choice ' + '%OWNER% can rule on: the options, what each costs or risks, and your recommendation.',
    incident: 'This is an incident meeting: what is broken, who is affected, what stops the harm now, and who does what next. Facts before theories; say what you checked.',
    planning: 'This is a planning meeting: agree what gets done, by whom and by when, and what waits.',
    review: 'This is a review meeting: what happened against what was planned, what we learned, and what changes.',
  };
  /* seat frames (company/defaults/work/meetings/frames.json, a company override in company/work/meetings/frames.json):
     each turn names the speaker's own function and what the others in the room need from it, from loops.json functions */
  function frames() {
    const d = readJ(path.join(__dirname, '..', 'company', 'defaults', 'work', 'meetings', 'frames.json')) || {}, o = readJ(co.p('company', 'work', 'meetings', 'frames.json')) || {};
    return Object.assign({}, d.functions || {}, o.functions || {});
  }
  function frameOf(id, F) {
    const fns = ((crew()[id] || {}).functions || []).filter(f => F[f]);
    return fns.length ? { labels: fns.map(f => F[f].label), needs: fns.map(f => F[f].needs) } : { labels: [titleOf(id) || 'their own area'], needs: ['what it means for ' + (titleOf(id) ? 'the ' + titleOf(id) + ' work' : 'their work')] };
  }
  function roomLine(id) {
    const F = frames(); const me = frameOf(id, F);
    const others = present().filter(x => x !== id).map(x => { const f = frameOf(x, F); return nameOf(x) + ' (' + f.labels.join(', ') + ': needs ' + f.needs.join('; ') + ')'; });
    return ' [Your seat: ' + me.labels.join(', ') + '. In the room: ' + (others.length ? others.join('; ') : 'nobody else') + (present().length ? '' : '') + '. Lead with your point in one line, define any term the room may not share the first time you use it, and say what your point means for each of them.]';
  }
  // the company's language (company.json locale): every seat speaks it
  function localeLine() {
    const loc = String((co.config && co.config.locale) || '').trim(); if (!loc || /^en(\b|-)/i.test(loc)) return '';
    let name = loc; try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(loc) || loc; } catch (_) {}
    return ' Speak ' + name + ' (the company\'s language, company.json locale ' + loc + '); protocol words (ASK, PASS, END, plain: …) stay in English.';
  }
  const typeBlock = () => (TYPE_BLOCK[M.type] || TYPE_BLOCK.decision).replace('%OWNER%', owner());
  function context() {
    const l = leader(), others = notHere(), it = currentItem();
    return 'At the meeting now: ' + seatList() + '.' + (l ? ' ' + nameOf(l) + ' leads the meeting.' : ' There is no meeting leader.')
      + ' ' + typeBlock() + (M.title ? ' Topic: ' + M.title + '.' : '') + (it ? ' Agenda item now: ' + it.title + '.' : '')
      + (observing() ? ' ' + owner() + ' is observing: they will not speak unless they step in, so do not put questions to them or wait for them.' : '')
      + (toolsOn() ? ' Tools are on for this item: check what you state, briefly.' : ' Talk only: nobody has tools in this part of the meeting; say only what you know and never claim you read or changed something.')
      + (others ? ' Not at the meeting (you may INVITE them): ' + others + '.' : '');
  }
  // a correction for this seat's last reply that broke the owner-scope rule (the chat lint), shown to it on its next turn
  function lintLine(id) {
    const parse = [];
    for (let i = LOG.length - 1; i >= 0; i--) {
      const e = LOG[i];
      if (e.kind === 'parse' && e.who === id) { parse.push(e); continue; }
      if (e.who !== id || (e.kind !== 'say' && e.kind !== 'pass')) continue;
      const p = parse.length ? ' [Console note: these lines of your last reply could not be read, so nothing was done with them: ' + parse.map(x => '"' + x.line + '" (' + x.why + ')').join('; ') + '. Write each on a line of its own, exactly as the protocol says.]' : '';
      if (!e.lint) return p;
      return p + ' [Console note on your last reply: ' + e.lint.why + '. ' + (e.lint.kind === 'observe-question' ? owner() + ' is observing: put the question to the people seated, or settle it yourselves.' : 'That is the crew\'s, not the owner\'s: settle it among yourselves or route it.') + ']';
    }
    return '';
  }
  function turnLine(id, item, ctl) {
    const n = nameOf(id), isLead = id === leader();
    const upList = Object.entries((ctl && ctl.up) || {});
    const up = upList.length ? upList.map(([c, why]) => nameOf(c) + (why ? ' (' + why + ')' : '')).join('; ') : '';
    const lead = isLead ? ' You lead this meeting.' + (up ? ' Hands up: ' + up + '; end your reply with CALL: <name> to give one the floor.' : '')
      + (observing() ? ' Move it to a result; when the discussion is complete, end your reply with END: <what was decided and who does what> — plain: <one sentence anyone can read>.' : '') : '';
    const tail = lintLine(id) + roomLine(id) + localeLine();
    if (item.kind === 'ask') return '[' + nameOf(item.from) + ' asked you directly: ' + item.text + ' Answer ' + nameOf(item.from) + ', ' + n + '; you may ASK back.' + lead + ' ' + context() + ']' + tail;
    if (item.kind === 'hand') return '[' + (item.calledBy ? nameOf(item.calledBy) + ' called on you' : 'You raised your hand') + (item.why ? ' (' + item.why + ')' : '')
      + ' and you have the floor, ' + n + ': make your point briefly.' + lead + ' ' + context() + ']' + tail;
    if (item.followUp) return '[' + (observing() ? 'Open round, carried on without ' + owner() + ', who is observing.' : 'No new message from ' + owner() + ': this is an open round for the meeting to answer each other.')
      + ' Your turn, ' + n + ': add to, answer or challenge what was said' + (observing() ? ', or move the discussion to its next point' : '') + '; or reply PASS.' + lead + ' ' + context() + ']' + tail;
    return '[Your turn, ' + n + '.' + (item.addressed && item.addressed.length ? ' ' + owner() + ' put this to ' + item.addressed.map(nameOf).join(', ') + '.' : '')
      + lead + ' ' + context() + ' Reply PASS if you have nothing to add.]' + tail;
  }
  function historyFor(id, lastLine) {
    const msgs = []; let buf = [];
    const flush = () => { if (buf.length) { msgs.push({ role: 'user', content: buf.join('\n\n') }); buf = []; } };
    for (const e of LOG) {
      if (e.who === id && (e.kind === 'say' || e.kind === 'pass')) {
        flush();
        const content = e.kind === 'pass' ? 'PASS' : e.text, last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') last.content += '\n\n' + content; else msgs.push({ role: 'assistant', content });
      }
      else if (e.kind === 'say') buf.push(nameOf(e.who) + (e.who === 'owner' ? ' (owner)' : '') + (e.to ? ' (answering ' + nameOf(e.to) + ')' : '') + (e.interject ? ' (interjecting)' : '') + (e.explains ? ' (explaining for the room)' : '') + ': ' + e.text);
      else if (e.kind === 'open') buf.push('[The meeting opened. At the meeting: ' + e.text + '.]');
      else if (e.kind !== 'ask' && e.kind !== 'pass' && TEXTS[e.kind]) buf.push('[' + TEXTS[e.kind](e) + '.]');
    }
    buf.push(lastLine); flush();
    const fit = fitHistory(msgs); const out = fit.messages;
    if (out[0].role !== 'user') out.unshift({ role: 'user', content: '' });
    out[0] = { role: 'user', content: PRE() + '\n[You are ' + nameOf(id) + (titleOf(id) ? ', ' + titleOf(id) : '') + '. The company folder is your project root; company tools run as `node company/tools/<tool>.js`.]\n\n'
      + (fit.dropped ? '[The earliest part of this meeting is left out here; it is long. The full minutes are in company/work/meetings/.]\n\n' : '') + out[0].content };
    return out;
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
  const active = new Set();   // runIds in flight (the turn and any hand checks), for Stop and halt
  const stationRunner = {
    start(o) {
      return new Promise(resolve => {
        let token = null; try { token = co.stationToken(); } catch (_) {}
        if (!token) return resolve({ error: 'no station token (secrets/station-token)' });
        const streamId = 'meeting-' + o.seat + (o.purpose === 'turn' ? '' : '-' + o.purpose);
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
          if (onEvent && (l.name === 'permission.prompt' || l.name === 'permission.response')) { try { onEvent({ name: l.name, payload: p }); } catch (_) {} }
        });
        if (!off) { over = true; resolve({ text: '', usd: 0, refused: false, error: 'the console has no record of this run any more' }); }
      });
    },
    cancel(runId) { return deps.stationPost ? deps.stationPost('cancel', { runId }, 8000) : null; },
    consent(runId, promptId, decision) { return deps.stationPost ? deps.stationPost('consent', { runId, promptId, decision }, 8000) : null; },
  };
  const runner = deps.runner || stationRunner;
  async function modelFor(id) {
    try { const m = await deps.modelFor(id); if (m && m.provider && m.model) return m; return { error: nameOf(id) + ' has no AI model to think with' }; }
    catch (e) { return { error: nameOf(id) + ': ' + e.message }; }
  }
  /* every turn, hand check and leader call: admit() first (company/tools/lib/admit.js, kind 'meeting-turn': a zero-token
     permission and routing check, logged; it refuses a turn of a meeting the owner did not open, holds one under a hard
     halt or a refusal block on the provider). There is no budget or estimate: cost is information (the cost line). */
  function admitTurn(o) {
    try {
      const jobIds = typeof deps.seatJobs === 'function' ? deps.seatJobs(o.seat) : undefined;
      const t = admitLib().admit({ door: 'meeting', kind: 'meeting-turn', seat: o.seat, provider: o.model.provider, owner: M.openedBy === 'owner', meetingId: M.id, jobIds, why: 'owner meeting ' + o.purpose + (o.tools ? ' (tools)' : ' (talk only)') });
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
    active.add(st.runId);
    try { const r = await runner.wait(st.runId); cost(r); return r; } finally { active.delete(st.runId); }
  }
  function cost(r) { M.cost.turns++; M.cost.usd = Math.round((M.cost.usd + (Number(r && r.usd) || 0)) * 1e6) / 1e6; }

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
    try { const r = REG.add(reg(), section, row, by); saveReg(); return r; }
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
      const r = await deps.run('decision.js', ['add', '--by', name, '--text', clean(text), '--why', why + ' (minutes: company/work/meetings/meeting-' + day() + '.md)']);
      if (r && r.code) { note('Not recorded in decisions.md: ' + String((r.data && (r.data.error || r.data.text)) || 'decision.js refused').slice(0, 200)); return null; }
      const m = /\[(d-[0-9a-f]{6})\]/.exec(JSON.stringify((r && r.data) || '')); return m ? m[1] : 'recorded';
    } catch (e) { note('Not recorded in decisions.md: ' + e.message); return null; }
  }

  /* ---------- the agent lines ---------- */
  function applyDirectives(by, list, ctl, pending) {
    const callNow = [];
    for (const d of list) {
      if (d.kind === 'END') {
        if (leader() && by !== leader()) { note(nameOf(by) + ' suggested closing; only the leader, ' + nameOf(leader()) + ', closes the discussion'); continue; }
        const pl = REG.parseLine('END', d.why);
        ctl.ended = pl.text || d.why || 'closed';
        record({ who: by, kind: 'end', text: pl.text || d.why, plain: pl.plain || null });
        reg().summary = { text: pl.text || d.why, plain: pl.plain || null, by, at: new Date().toISOString() }; saveReg();
        if (!pl.plain) record({ who: by, kind: 'parse', line: 'END: ' + d.why, why: 'END needs a plain-language line: END: <summary> — plain: <one sentence anyone can read>; the register marks the summary as failing until it has one' });
        continue;
      }
      if (d.kind === 'RULING') {
        if (leader() && by !== leader()) { note(nameOf(by) + ' wrote a ruling; the leader, ' + nameOf(leader()) + ', records rulings'); continue; }
        const pl = REG.parseLine('RULING', d.why);
        const row = regAdd('rulings', { text: pl.text, plain: pl.plain, proposedBy: by }, by, 'RULING: ' + d.why);
        if (row) record({ who: by, kind: 'ruling', text: pl.text, plain: pl.plain, n: row.n, proposed: true });
        continue;
      }
      if (d.kind === 'ACTION' || d.kind === 'QUESTION' || d.kind === 'KILL') {   // the speaker's own line in the register
        const section = d.kind === 'ACTION' ? 'actions' : d.kind === 'QUESTION' ? 'questions' : 'kills';
        const pl = REG.parseLine(d.kind, d.why);
        const row = regAdd(section, Object.assign({}, pl, { owner: by }), by, d.kind + ': ' + d.why);
        if (row) record({ who: by, kind: 'register', section, n: row.n, text: row.text, plain: row.plain, date: row.date || null, affects: row.affects || null });
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
        if (ctl.invites >= MAX_INVITES_PER_ROUND) { note(nameOf(by) + ' invited ' + nameOf(target) + ': not this round, ' + MAX_INVITES_PER_ROUND + ' people were invited already'); return false; }
        if (present().length >= MAX_SEATS) { note(nameOf(by) + ' invited ' + nameOf(target) + ': the meeting is full (' + MAX_SEATS + ' seats)'); return false; }
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
        M.guests = M.guests.filter(c => c !== target);
        if (std.seats.includes(target) && !M.excused.includes(target)) M.excused.push(target);
        save();
        record({ who: target, kind: 'leave', by, why: d.why });
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
    const m = await modelFor(l);
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
      const m = await modelFor(c); if (m.error) return null;
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
      if (h && (!M.run.stopping || (h === 'hard' && M.run.stopping === 'halt-soft'))) {
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
        if (co.halted() && !R.stopping) R.stopping = 'halt-' + co.halted();
        if (R.floor && !R.stopping) { save(); emit('meeting'); return; }   // the owner has the floor: wait for them
        if (!R.round) {
          if (R.stopping) {
            const h = String(R.stopping);
            if (h.startsWith('halt')) {   // halted: the meeting is interrupted, its minutes written; Resume after the halt
              const hard = h === 'halt-hard';
              endRun('The company is halted, so the meeting stopped' + (hard ? ' mid-turn.' : ' after the turn in progress.'));
              finalize('interrupted', 'console', hard ? 'hard halt: aborted mid-turn; resume it after the halt' : 'soft halt: the turn in progress finished, then the meeting stopped');
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
          if (![...ctl.front, ...ctl.after, ...ctl.normal].some(speaks)) { finishRound(); if (!M.run || !M.run.pending) { R.gate = false; R.waitNext = false; } continue; }   // nobody left this round: Next only if another round follows
        }
        if (!R.current && gateWait(R)) return;
        if (!R.current) {
          const item = ctl.front.shift() || ctl.after.shift() || ctl.normal.shift();
          if (!item) { finishRound(); continue; }
          if (item.kind === 'hand') delete ctl.up[item.cmd];
          if (!present().includes(item.cmd) || (item.kind === 'turn' && !hasNewFor(item.cmd))) { save(); continue; }
          const m = await modelFor(item.cmd);
          if (m.error) { note(nameOf(item.cmd) + ' sits this one out: ' + m.error); save(); continue; }
          let mid = false; try { mid = typeof deps.seatBusy === 'function' && await deps.seatBusy(item.cmd); } catch (_) {}
          if (mid) { note(nameOf(item.cmd) + ' is in the middle of a routine run, so they sit this turn out (no double run); they hear it all next time.'); save(); continue; }
          R.current = { item, seat: item.cmd, model: m, attempt: 0, tried: [], runId: null };
          save(); emit('meeting');
        }
        await turn(R);
        R.gate = true; R.gateUntil = null;
        if (ctl.ended) { R.round.ended = ctl.ended; finishRound(); }
      }
    } finally { driving = false; }
  }
  function beginRound(p) {
    if (p.text) {
      M.run.gate = false; M.run.gateUntil = null; M.run.waitNext = false; M.floorWhy = null;   // the owner just spoke: the first answer starts now
      if (!M.opened) record({ who: 'owner', kind: 'open', text: seatList() });
      record({ who: 'owner', kind: 'say', text: p.text });
    }
    const only = p.only && p.only.length ? p.only : null;
    M.run.round = { only, followUp: !p.text, said: 0, answered: 0, ended: null,
      ctl: { invites: 0, asks: 0, hands: 0, raised: [], front: [], after: [], up: {}, ended: null,
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
    if (msg && !(M.closeAfter && msg === 'Round stopped.')) note(msg);
    M.run = null; M.ownerHand = false; save(); emit('meeting');
    if (M.closeAfter) finalize(M.closeAfter.state, M.closeAfter.by, M.closeAfter.why);
  }
  async function turn(R) {
    const cur = R.current, ctl = R.round.ctl, item = cur.item;
    let res = null;
    for (;;) {
      if (!cur.runId) {
        if (R.stopping) { res = { stopped: true }; break; }
        const st = await startRun({ seat: cur.seat, model: cur.model, messages: historyFor(cur.seat, turnLine(cur.seat, item, ctl)), tools: toolsOn(), purpose: 'turn' });
        if (st.error) { res = { error: st.error, text: '' }; break; }
        cur.runId = st.runId; save(); emit('meeting'); armHalt();
      }
      active.add(cur.runId);
      try { res = await runner.wait(cur.runId, ev => runEvent(cur, ev)); } finally { active.delete(cur.runId); }
      if (R.consent && R.consent.runId === cur.runId) consentClear(R, null);
      cost(res);
      if (res.refused) {
        const next = cur.attempt === 0 ? REF.nextEntry(cur.seat, cur.model, cur.tried, { root: co.ROOT }) : null;
        try { REF.record({ root: co.ROOT, seat: cur.seat, door: 'meeting', runId: cur.runId, from: cur.model, to: next }); } catch (_) {}
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
    if (res.skip || res.stopped) { emit('meeting'); return; }
    const raw = res.text || '';
    const { body, list, failures } = res.error ? { body: raw, list: [], failures: [] } : directives(raw);
    const passed = !res.error && (isPass(body) || (!body && list.length > 0));
    const extra = item.kind === 'ask' ? { to: item.from } : item.kind === 'hand' ? { interject: true } : {};
    if (passed) { R.round.answered++; record({ who: cur.seat, kind: 'pass' }); }
    else if (body) {
      R.round.answered++; R.round.said++;
      const lt = res.error ? null : lintOf(body, list);
      record(Object.assign({ who: cur.seat, kind: 'say', text: res.error ? body + '\n\n[stopped before the end]' : body, model: modelLabel(cur.model), provider: cur.model.provider, modelId: cur.model.model }, extra, lt ? { lint: lt } : {}));
    } else if (res.error && !R.stopping) note(nameOf(cur.seat) + ' could not answer: ' + String(res.error).slice(0, 200));
    if (!passed && !body && !res.error && list.length === 0) note(nameOf(cur.seat) + ' finished without writing a reply.');
    for (const f of failures || []) record({ who: cur.seat, kind: 'parse', line: f.line, why: f.why });
    if (list.length) { const pending = []; applyDirectives(cur.seat, list, ctl, pending); await Promise.all(pending); }
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
      if (l && freshHands.some(h => h.cmd !== l) && !R.stopping) {
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
    if (M.run) {
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
  function presence(b) { if (b && b.here === false) lastSeen = 0; else lastSeen = Date.now(); if (M.run && !driving) kick(); return { ok: true, present: ownerPresent(), speed: effectiveSpeed() }; }
  /* Catch me up: one cheap talk-only turn (the leader, else the first seat) for the owner: five bullets of what was said
     since they last read, then what was decided and what is still asked. Shown to the owner only, not to the seats. */
  async function catchUp(b) {
    guard();
    const since = Math.max(0, Number(b && b.since) || 0);
    const seat = leader() || present()[0]; if (!seat) fail('nobody is seated');
    const m = await modelFor(seat); if (m.error) fail(m.error, 409);
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
    const m = await modelFor(e.who); if (m.error) fail(m.error, 409);
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
  function stop() {
    guard();
    if (!M.run) return view();
    M.run.stopping = 'owner'; M.run.floor = false; M.ownerHand = false; M.run.interjection = null; save();
    for (const id of active) Promise.resolve(runner.cancel(id)).catch(() => {});
    if (M.run.current && M.run.current.runId && !active.has(M.run.current.runId)) Promise.resolve(runner.cancel(M.run.current.runId)).catch(() => {});
    kick(); emit('meeting'); return view();
  }
  function setObserve(b) {
    guard();
    const on = !!(b && b.on);
    if (b && b.rounds != null) { const n = Number(b.rounds); if (!Number.isInteger(n) || n < 1 || n > MAX_OBSERVE) fail('rounds is a whole number from 1 to ' + MAX_OBSERVE); std.observeRounds = n; saveStd(); }
    if (on !== observing()) { M.observer = on; save(); if (M.opened) record({ who: 'owner', kind: 'observe', on }); }
    emit('meeting'); return view();
  }
  // the agenda: items, the one now under discussion, and tools switched on per item (talk only is the default)
  function agenda(b) {
    guard();
    const op = String((b && b.op) || '');
    const find = () => { const it = M.agenda.find(a => a.id === String(b.id || '')); if (!it) fail('no agenda item ' + b.id, 404); return it; };
    if (op === 'add') {
      const title = str(b.title, 200); if (!title) fail('give the item a title');
      if (M.agenda.length >= 30) fail('30 agenda items at most');
      const it = { id: 'a' + (M.agenda.reduce((n, a) => Math.max(n, Number(String(a.id).slice(1)) || 0), 0) + 1), title, tools: b.tools === true, done: false };
      M.agenda.push(it); if (!M.agendaAt) M.agendaAt = it.id;
      save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'add', text: it.title, tools: it.tools });
    } else if (op === 'tools') { const it = find(); it.tools = b.on === true; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'tools', text: it.title, tools: it.tools }); }
    else if (op === 'current') { const it = find(); M.agendaAt = it.id; it.done = false; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'current', text: it.title, tools: it.tools }); }
    else if (op === 'done') { const it = find(); it.done = true; if (M.agendaAt === it.id) { const nx = M.agenda.find(a => !a.done); M.agendaAt = nx ? nx.id : null; } save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'done', text: it.title }); }
    else if (op === 'remove') { const it = find(); M.agenda = M.agenda.filter(a => a !== it); if (M.agendaAt === it.id) M.agendaAt = (M.agenda.find(a => !a.done) || {}).id || null; save(); if (M.opened) record({ who: 'owner', kind: 'agenda', op: 'remove', text: it.title }); }
    else fail('op is add, tools, current, done or remove');
    emit('meeting'); return view();
  }
  function setLeader(b) {
    guard();
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
      if (!std.seats.includes(id)) { if (std.seats.length >= MAX_SEATS) fail('the meeting is full (' + MAX_SEATS + ' seats)'); std.seats.push(id); saveStd(); }
      M.guests = M.guests.filter(c => c !== id); M.excused = M.excused.filter(c => c !== id); save();
      if (!wasHere && M.opened) record({ who: id, kind: 'join' });
    }
    for (const k of remove) {
      const id = resolve(String(k)) || String(k);
      const wasHere = present().includes(id);
      if (std.seats.includes(id)) { std.seats = std.seats.filter(c => c !== id); saveStd(); }
      M.guests = M.guests.filter(c => c !== id); M.excused = M.excused.filter(c => c !== id); save();
      if (wasHere && M.opened) record({ who: id, kind: 'leave' });
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
    if (M.run) { M.closeAfter = { state: 'closed', by: 'owner', why }; save(); stop(); for (let i = 0; i < 300 && M.run; i++) await new Promise(r => setTimeout(r, 20)); }
    if (M.run) fail('the round is still stopping: try again in a moment', 409);
    finalize('closed', 'owner', why);
    return view();
  }
  function finalize(state, by, why) {
    M.closeAfter = null;
    M.state = state; M.closedAt = new Date().toISOString(); M.closedBy = by; if (why) M.reason = why;
    if (M.opened) {
      const tm = terms().undefined;
      if (tm.length) record({ who: 'console', kind: 'note', terms: tm.map(x => x.term), text: 'Terms used without a definition: ' + tm.map(x => x.term + ' (first used by ' + x.firstBy + ')').join(', ') + '. Add them to company/work/meetings/glossary.md.' });
      record({ who: by, kind: 'close', state, why });
    }
    save(); reindex();
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
      row.decisionId = await decide('owner', 'Meeting ruling (' + day() + (M.title ? ', ' + M.title : '') + '): ' + row.text + ' In plain words: ' + row.plain, 'the owner\'s ruling at the meeting');
      saveReg(); if (M.opened) record({ who: 'owner', kind: 'ruling', text: row.text, plain: row.plain, n: row.n, proposed: false });
    } else if (op === 'confirm') {
      const row = REG.update(r, 'rulings', b.n, { confirmed: true, plain: b.plain, text: b.text }, 'owner', true);
      if (!row.decisionId) row.decisionId = await decide('owner', 'Meeting ruling (' + day() + (M.title ? ', ' + M.title : '') + '): ' + row.text + ' In plain words: ' + row.plain, 'proposed by ' + nameOf(row.proposedBy || 'owner') + ', confirmed by the owner at the meeting');
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
      const m = await modelFor(id);
      return { id, name: nameOf(id), title: titleOf(id), leader: id === leader(), guest: M.guests.includes(id), invitedBy: M.guests.includes(id) ? invitedBy(id) : null,
        standing: std.seats.includes(id), model: m.error ? null : { provider: m.provider, model: m.model, label: modelLabel(m), from: m.from || null }, modelError: m.error || null };
    }));
    const R = M.run;
    let live = { phase: 'idle', speaking: null, next: [], hands: [], ownerHand: !!M.ownerHand, checking: null, round: null, interjection: false, paused: false, waitNext: false, yourTurn: false };
    if (R) {
      const ctl = R.round && R.round.ctl;
      const queue = ctl ? [...ctl.front, ...ctl.after, ...ctl.normal].filter(x => present().includes(x.cmd) && (x.kind !== 'turn' || hasNewFor(x.cmd) || (R.current && R.current.seat === x.cmd))) : [];
      const seen = new Set(R.current ? [R.current.seat] : []); const next = [];
      for (const x of queue) if (!seen.has(x.cmd)) { seen.add(x.cmd); next.push({ id: x.cmd, name: nameOf(x.cmd), kind: x.kind }); }
      live = { phase: R.floor ? 'floor' : R.stopping ? 'stopping' : 'round', ownerHand: !!M.ownerHand, interjection: !!R.interjection,
        paused: !!R.paused, pausedFor: R.paused === 'consent' && R.consent ? { seat: nameOf(R.consent.seat), tool: R.consent.tool, qid: R.consent.qid } : null, waitNext: !!R.waitNext, nextAt: R.gateUntil || null, yourTurn: !!R.floor, floorWhy: R.floor ? M.floorWhy || null : null,
        speaking: R.current ? { id: R.current.seat, name: nameOf(R.current.seat), kind: R.current.item.kind, from: R.current.item.from || null, runId: R.current.runId, model: modelLabel(R.current.model) } : null,
        next: next.slice(0, 4), hands: ctl ? Object.entries(ctl.up).map(([id, why]) => ({ id, name: nameOf(id), why })) : [],
        checking: R.checking ? { kind: R.checking.kind, names: R.checking.seats.map(nameOf) } : null,
        round: observing() && R ? { auto: (R.auto || 0) + 1, cap: std.observeRounds } : null };
    }
    const roster = Object.keys(crew()).map(id => ({ id, name: nameOf(id), title: titleOf(id), seated: present().includes(id) }));
    const shown = LOG.filter(e => e.kind !== 'pass');
    return Object.assign({ ok: true, owner: owner(),
      meeting: { id: M.id, type: M.type, title: M.title, state: M.state, reason: M.reason || null, closedBy: M.closedBy ? nameOf(M.closedBy) : null, closedAt: M.closedAt || null, resumeAfter: M.resumeAfter || null,
        agenda: M.agenda, agendaAt: M.agendaAt, toolsOn: toolsOn(), types: TYPES, speed: std.speed || 'manual', speeds: SPEEDS, effectiveSpeed: effectiveSpeed(), ownerPresent: ownerPresent(),
        startedAt: M.startedAt, opened: !!M.opened, observer: observing(), observeRounds: std.observeRounds, leader: std.leader, leaderSeated: !!leader(),
        cost: M.cost, minutes: 'company/work/meetings/meeting-' + day() + '.md', excused: M.excused.map(id => ({ id, name: nameOf(id) })) },
      seats, roster, live, total: shown.length }, extra || {});
  }
  function entries(q) {
    const shown = LOG.filter(e => e.kind !== 'pass');
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
    let days = []; try { days = fs.readdirSync(MINUTES_DIR()).map(f => (/^meeting-(\d{4}-\d{2}-\d{2})\.md$/.exec(f) || [])[1]).filter(Boolean).sort().reverse().slice(0, 60); } catch (_) {}
    return { ok: true, date: d, path: 'company/work/meetings/meeting-' + d + '.md', text, days };
  }
  function mount(route) {
    route('GET', /^\/api\/meeting$/, () => view());
    route('GET', /^\/api\/meeting\/entries$/, (m, q) => entries(q));
    route('GET', /^\/api\/meeting\/minutes$/, (m, q) => minutesText(q));
    route('POST', /^\/api\/meeting\/say$/, (m, q, b) => say(b));
    route('POST', /^\/api\/meeting\/round$/, () => openRound());
    route('POST', /^\/api\/meeting\/hand$/, () => hand());
    route('POST', /^\/api\/meeting\/continue$/, () => carryOn());
    route('POST', /^\/api\/meeting\/stop$/, () => stop());
    route('POST', /^\/api\/meeting\/observe$/, (m, q, b) => setObserve(b));
    route('POST', /^\/api\/meeting\/agenda$/, (m, q, b) => agenda(b));
    route('POST', /^\/api\/meeting\/close$/, (m, q, b) => close(b));
    route('POST', /^\/api\/meeting\/resume$/, (m, q, b) => resume(b));
    route('GET', /^\/api\/meeting\/list$/, () => ({ ok: true, meetings: list() }));
    route('GET', /^\/api\/meeting\/timeline$/, () => timeline());
    route('GET', /^\/api\/meeting\/register$/, () => registerView());
    route('GET', /^\/api\/meeting\/terms$/, () => terms());
    route('POST', /^\/api\/meeting\/glossary$/, (m, q, b) => addTerm(b));
    route('POST', /^\/api\/meeting\/explain$/, (m, q, b) => explain(b));
    route('POST', /^\/api\/meeting\/register$/, regSafe((m, q, b) => register(b)));
    route('GET', /^\/api\/meeting\/search$/, (m, q) => search(q));
    route('GET', /^\/api\/meeting\/status$/, () => ({ ok: true, live: require(path.join(LIB, 'meetings.js')).liveWork() }));
    route('POST', /^\/api\/meeting\/next$/, () => next());
    route('POST', /^\/api\/meeting\/pace$/, (m, q, b) => pace(b));
    route('POST', /^\/api\/meeting\/hold$/, (m, q, b) => hold(b));
    route('POST', /^\/api\/meeting\/presence$/, (m, q, b) => presence(b));
    route('POST', /^\/api\/meeting\/catchup$/, (m, q, b) => catchUp(b));
    route('POST', /^\/api\/meeting\/lead$/, (m, q, b) => setLeader(b));
    route('POST', /^\/api\/meeting\/seats$/, (m, q, b) => seatsChange(b));
    route('POST', /^\/api\/meeting\/new$/, (m, q, b) => newMeeting(b));
  }
  // the console started: carry on a meeting a previous console process left mid-round (the turn in flight is re-attached)
  function start() {
    load();
    if (M.run) { M.run.checking = null; save(); armHalt(); if (M.run.consent) armConsent(); if (!M.run.floor) kick(); }
  }
  load();
  return { mount, start, view, entries, minutesText, say, openRound, hand, carryOn, stop, setObserve, agenda, setLeader, seatsChange, newMeeting, close, resume, list, register: regSafe(b => register(b)), registerView, search: q => search(q), reindex, explain, terms, addTerm, next, pace, hold, presence, catchUp, timeline, busy,
    idle: () => !M.run && !driving, _state: () => ({ std, M, LOG }), _reload: load };
};
module.exports.directives = directives;
module.exports.isPass = isPass;
module.exports.maybePass = maybePass;
module.exports.handReply = handReply;
module.exports.fitHistory = fitHistory;
module.exports.modelLabel = modelLabel;
module.exports.LIMITS = { MAX_INVITES_PER_ROUND, MAX_ASKS_PER_ROUND, MAX_HANDS_PER_ROUND, OBSERVE_ROUNDS };
