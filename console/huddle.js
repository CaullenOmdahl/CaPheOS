/* console/huddle.js — a colleague brought into the owner's live chat with a crew member, on the meeting's engine
 * (console/meeting.js), so it runs like the table: the host first, then each guest, each seeing everything said, ASK /
 * INVITE / DISMISS / hands as in the meeting. Spec: docs/CONSOLE-API.md "Colleagues in a live chat".
 *
 * How one opens: the host's live chat reply (console/chat.js) ends with ASK: <name> — <question> or INVITE: <name> —
 * <why>; chat.js calls pullFrom(host, ...) when the run ends, and the colleague answers in the same chat right away
 * (no handoff, no waiting for the dispatcher). The owner can also bring someone in (+ Colleague: seats {add}). While a
 * colleague is in the chat, the owner's messages go here (POST /api/chat/<host>/send routes to say()). A guest leaves by
 * the owner's × (seats {remove}) or an agent's DISMISS: <name> (DISMISS: me for oneself); when the last one has left and
 * the round is over, the chat closes and is plain 1:1 again, and the host's next 1:1 message carries a recap of what was
 * said (takeRecap, in chat.js contextNote). An open chat nobody wrote to for 2 hours closes by itself.
 *
 * Every guest turn passes what a meeting turn passes: the owner-only guard, the halt check and timer, the seat's current
 * model (the chain entry models.js and the pacer set; a closed chain sits out in one line), the metered $0-cap hold
 * (deps.modelFor throws it: that seat sits out with the reason), admit() (door chat, kind meeting-turn, owner true), one
 * refusal retry on the next chain entry. A seat in the middle of a routine run answers at once, talk only.
 *
 * State: company/state/huddles/<host>/ (the engine's seats.json, current.json, m/<id>.json, events/<id>.jsonl; recap.json
 * waiting for the host's next 1:1 message; live.json while a plain 1:1 run is in flight, written by chat.js). Minutes:
 * company/work/meetings/chat-<host>-<date>.md. lib/meetings.js reads these so the dispatcher holds the seats while a round
 * runs (and the host during a 1:1 run).
 *
 *   const HUD = require('./huddle.js')(deps); HUD.mount(route); HUD.start();
 *   deps: the meeting's deps (co, owner(), emit, stationPost, runs, run, modelFor, seatJobs, seatBusy, HttpError,
 *         runner?) plus chat (console/chat.js: transcript(seat)) and idleMs (default 2 h)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const meetingLib = require('./meeting.js');

const MAX_HUDDLE_GUESTS = 3, MAX_HUDDLE_INVITES = 2, MAX_HUDDLE_TURNS = 8;
const SEED_TURNS = 6, SEED_BYTES = 20000, RECAP_ENTRIES = 12, RECAP_BYTES = 6000;
const IDLE_MS = 2 * 3600e3;
const SAFE_HOST = /^[A-Za-z0-9_-]{1,64}$/;

module.exports = function huddle(deps) {
  const co = deps.co;
  const owner = () => (typeof deps.owner === 'function' ? deps.owner() : null) || (co.config.owner && co.config.owner.name) || 'Owner';
  const emitRaw = typeof deps.emit === 'function' ? deps.emit : () => {};
  const idleMs = Number(deps.idleMs) > 0 ? Number(deps.idleMs) : IDLE_MS;
  const ROOT = () => co.p('company', 'state', 'huddles');
  const hostDir = host => path.join(ROOT(), host);
  const nameOf = id => { if (id === 'owner') return owner(); const s = co.crew()[id]; return (s && s.name) || id; };
  const first = id => String(nameOf(id)).split(/\s+/)[0];
  const fail = (msg, status) => { if (deps.HttpError) throw new deps.HttpError(status || 400, msg); const e = new Error(msg); e.status = status || 400; throw e; };
  const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
  const writeJ = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(t, f); };
  function checkHost(host) {
    if (!SAFE_HOST.test(String(host || ''))) fail('bad seat id');
    if (!co.crew()[host]) fail('no crew member ' + host, 404);
    return host;
  }

  /* ---------- one engine per host, made when first needed ---------- */
  const engines = new Map();
  const recapWanted = new Set();   // hosts whose chat is closing: the recap is written when the engine finalizes it
  function engine(host) {
    checkHost(host);
    if (engines.has(host)) return engines.get(host);
    const E = meetingLib(Object.assign({}, deps, {
      stateDir: () => hostDir(host), topic: 'huddle', streamPrefix: 'huddle-' + host + '-', minutesPrefix: 'chat-' + host + '-',
      routePrefix: '/api/huddle/' + host, door: 'chat',
      emit: t => { emitRaw(t); settleSoon(host); },
      // the chat closed (at once, or once the current speaker finished: nobody is cut off mid-turn): the host's recap
      onFinalize: f => { if (f.state === 'closed' && recapWanted.delete(host)) { writeRecap(host, f.id, f.LOG); emitRaw('huddle'); } },
      profile: { kind: 'huddle', noun: 'chat', fixedLeader: host, standing: [host], wrapHost: true, noRegister: true, speed: 'instant',
        maxGuests: MAX_HUDDLE_GUESTS, maxInvites: MAX_HUDDLE_INVITES, maxTurnsPerRound: MAX_HUDDLE_TURNS,
        preface: o => 'This is ' + o + '\'s live chat with ' + nameOf(host) + ' in the console (behind the owner\'s sign-in; not a relayed message), and ' + first(host) + ' brought colleagues in to help. ' + o + ' reads every word here.',
        minutesHead: d => '# Chat with ' + nameOf(host) + ': ' + d + '\n\n_' + owner() + '\'s live chat with ' + nameOf(host) + ' while colleagues were in it (Chat in the console), written as it happens: every word, by who said it, with the time and the model each spoke on. Passes are not shown._' },
    }));
    engines.set(host, E);
    return E;
  }
  const opened = E => { const v = E._state(); return !!(v.M && v.M.opened && v.M.state === 'open'); };
  const guestsOf = E => { const v = E._state(); return v.M ? v.M.guests.filter(c => !v.M.excused.includes(c)) : []; };
  const running = E => { const v = E._state(); return !!(v.M && v.M.run); };
  // a colleague is in this chat (or a round with one is still finishing): the owner's messages go here
  function isOpen(host) {
    if (!SAFE_HOST.test(String(host || '')) || !co.crew()[host]) return false;
    if (!engines.has(host) && !fs.existsSync(path.join(hostDir(host), 'current.json'))) return false;
    const E = engine(host);
    return opened(E) && (guestsOf(E).length > 0 || running(E));
  }

  /* ---------- closing: the last guest left and the round is over; a recap waits for the host's next 1:1 message ---------- */
  const settling = new Set();
  function settleSoon(host) {
    if (settling.has(host)) return; settling.add(host);
    setImmediate(() => { settling.delete(host); settle(host).catch(() => {}); });
  }
  async function settle(host) {
    const E = engines.get(host); if (!E) return;
    if (!opened(E) || !E.idle() || guestsOf(E).length) return;
    const v = E._state();
    if (!v.LOG.some(e => e.kind === 'join')) return;   // nobody was ever brought in (an empty room just opened)
    await close(host, 'everyone else went back to their work');
  }
  async function close(host, why) {
    const E = engine(host);
    if (!opened(E)) return view(host);
    recapWanted.add(host);
    const r = await E.close({ why: why || '' });
    return view(host, r && r.note ? { note: r.note } : undefined);
  }
  function writeRecap(host, id, LOG) {
    const guests = [...new Set(LOG.filter(e => e.kind === 'join').map(e => e.who))];
    const body = LOG.filter(e => e.src !== 'chat' && (e.kind === 'say' || e.kind === 'join' || e.kind === 'leave')).slice(-RECAP_ENTRIES)
      .map(e => e.kind === 'say' ? nameOf(e.who) + (e.who === 'owner' ? ' (owner)' : '') + ': ' + String(e.text).slice(0, 1500)
        : '(' + nameOf(e.who) + (e.kind === 'join' ? ' joined' : ' left') + ')');
    let text = body.join('\n'); if (Buffer.byteLength(text) > RECAP_BYTES) text = '…' + Buffer.from(text).subarray(-RECAP_BYTES).toString('utf8').replace(/^[^\n]*\n?/, '');
    if (!text.trim()) return;
    try { writeJ(path.join(hostDir(host), 'recap.json'), { id, at: new Date().toISOString(), guests, text }); } catch (_) {}
  }
  // the host's next 1:1 message: what was said while colleagues were here, once (chat.js contextNote)
  function takeRecap(host) {
    if (!SAFE_HOST.test(String(host || ''))) return '';
    const f = path.join(hostDir(host), 'recap.json'); const r = readJ(f);
    if (!r || !r.text) return '';
    try { fs.unlinkSync(f); } catch (_) {}
    return '[While ' + (r.guests || []).map(nameOf).join(', ').replace(/, ([^,]*)$/, ' and $1') + (r.guests && r.guests.length > 1 ? ' were' : ' was') + ' in this chat (they have left; the minutes are in company/work/meetings/chat-' + host + '-<date>.md):\n' + r.text + '\n(end of the recap)]';
  }

  /* ---------- opening ---------- */
  // the host's reply lines that bring a colleague in: ASK / INVITE naming someone on the crew other than the host
  function pullLines(host, text) {
    const crew = co.crew(); const ids = Object.keys(crew);
    const who = n => { const k = String(n || '').toLowerCase().replace(/^@/, ''); return ids.find(id => id.toLowerCase() === k) || ids.find(id => String(crew[id].name || '').toLowerCase() === k) || ids.find(id => String(crew[id].name || '').toLowerCase().split(/\s+/)[0] === k) || null; };
    return meetingLib.directives(String(text || '')).list.filter(d => (d.kind === 'ASK' || d.kind === 'INVITE') && who(d.name) && who(d.name) !== host);
  }
  // the chat so far (the last turns of console-<host>, at most 20 KB), as said there
  async function seedOf(host, skipRunId) {
    let turns = [];
    try { const t = deps.chat && deps.chat.transcript ? await deps.chat.transcript(host) : null; turns = t && t.ok ? t.turns : []; } catch (_) {}
    let out = turns.filter(x => !(skipRunId && x.role === 'assistant' && x.runId === skipRunId)).slice(-SEED_TURNS).map(x => ({ who: x.role === 'user' ? 'owner' : host, text: x.role === 'assistant' ? meetingLib.directives(x.content).body : String(x.content) }));
    while (out.length > 1 && Buffer.byteLength(JSON.stringify(out)) > SEED_BYTES) out = out.slice(1);
    return out;
  }
  // an engine ready for a new chat with colleagues (a closed or never-opened one starts afresh)
  async function freshRoom(host) {
    const E = engine(host);
    const st = E._state();
    if (st.M.run) fail('a round is running in this chat', 409);
    if (st.M.state === 'interrupted') { try { await E.close({ why: 'a new chat with colleagues' }); } catch (_) {} }
    if (st.M.opened && st.M.state === 'open' && !guestsOf(E).length) await close(host, 'a new chat with colleagues');
    if (E._state().M.state !== 'open' || E._state().M.opened) E.newMeeting({});
    return E;
  }
  /* the host's live chat reply asked a colleague (chat.js, when the run ended): the chat so far goes in, then the ASK /
     INVITE lines run as a round; the guest answers first, then the host closes the loop if something new was said.
     -> {host, id} or null (no line names a colleague) */
  async function pullFrom(host, o) {
    checkHost(host); o = o || {};
    const list = pullLines(host, o.text); if (!list.length) return null;
    const h = co.halted(); if (h) fail('the company is under a ' + h + ' halt, so nobody can speak: resume it on the Halt screen first', 409);
    let E, seed = [];
    if (isOpen(host)) { E = engine(host); if (running(E)) return null; }
    else { E = await freshRoom(host); seed = await seedOf(host, o.runId); }
    /* the chat so far goes in with the ask itself (E.pullIn records it only once its own checks pass), so a pull-in that
       is refused leaves no room opened and no minutes: just the reply that brought them in (its lines are the ask), as
       the host said it, unless the seed or the room already ends with it */
    const body = meetingLib.directives(String(o.text || '')).body;
    const LOG = E._state().LOG; const last = seed.length ? seed[seed.length - 1] : LOG[LOG.length - 1];
    if (body && !(last && (last.kind === undefined || last.kind === 'say') && last.who === host && last.text === body)) seed.push({ who: host, text: body });
    await E.pullIn({ by: host, seed, directives: list });
    return { host, id: E._state().M.id };
  }
  // the owner brings someone in (+ Colleague), or sends one back out (×)
  async function seats(host, b) {
    checkHost(host); b = b || {};
    const add = Array.isArray(b.add) ? b.add : [], remove = Array.isArray(b.remove) ? b.remove : [];
    if (!add.length && !remove.length) fail('say who to bring in or send back out');
    let E;
    if (add.length && !isOpen(host)) { E = await freshRoom(host); E.seed(await seedOf(host)); }
    else E = engine(host);
    if (!opened(E) && remove.length && !add.length) fail('nobody else is in this chat', 409);
    await E.seatsChange({ add, remove });
    settleSoon(host);
    return view(host);
  }
  async function say(host, b) { checkHost(host); if (!isOpen(host)) fail('nobody else is in this chat now: write to ' + first(host) + ' as usual', 409); await engine(host).say(b); return view(host); }

  /* ---------- what the page shows ---------- */
  async function view(host, extra) {
    checkHost(host);
    const hasState = engines.has(host) || fs.existsSync(path.join(hostDir(host), 'current.json'));
    const crew = co.crew();
    const roster = Object.keys(crew).filter(id => id !== host).map(id => ({ id, name: crew[id].name || id, title: crew[id].title || '' }));
    if (!hasState) return Object.assign({ ok: true, host: { id: host, name: nameOf(host) }, open: false, roster, limits: { guests: MAX_HUDDLE_GUESTS } }, extra || {});
    const E = engine(host);
    const v = await E.view();
    const open = isOpen(host);
    const here = new Set((v.seats || []).map(s => s.id));
    return Object.assign({}, v, { host: { id: host, name: nameOf(host) }, open, roster: roster.map(r => Object.assign(r, { seated: open && here.has(r.id) })), limits: { guests: MAX_HUDDLE_GUESTS } }, extra || {});
  }
  /* the earlier chats with colleagues of this host (closed ones), for the 1:1 conversation: when each was and what was
     said, without the chat it started from (that is in the 1:1 transcript) */
  function history(host, n) {
    checkHost(host);
    const dir = path.join(hostDir(host), 'm'); let ids = [];
    try { ids = fs.readdirSync(dir).filter(f => /^m-[a-z0-9]{4,20}\.json$/.test(f)).map(f => f.slice(0, -5)); } catch (_) {}
    const metas = ids.map(id => readJ(path.join(dir, id + '.json'))).filter(m => m && m.opened && m.state === 'closed').sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, n || 5);
    const BOUNDED = require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'bounded.js'));
    return metas.map(m => {
      let rows = [];
      try { rows = BOUNDED.tailText(path.join(hostDir(host), 'events', m.id + '.jsonl'), 2 << 20).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(e => e && e.m === m.id && e.src !== 'chat' && e.kind !== 'nudge' && e.kind !== 'open'); } catch (_) {}
      const named = rows.slice(-80).map(e => Object.assign({}, e, { name: e.who === 'owner' ? owner() : e.who === 'console' ? 'Console' : nameOf(e.who), toName: e.to ? nameOf(e.to) : undefined, byName: e.by ? nameOf(e.by) : undefined }));
      const firstSay = rows.find(e => e.kind === 'join' || e.kind === 'say');
      return { id: m.id, startedAt: (firstSay && firstSay.at) || m.startedAt, closedAt: m.closedAt || null, guests: [...new Set(rows.filter(e => e.kind === 'join').map(e => nameOf(e.who)))], entries: named };
    }).reverse();
  }

  /* ---------- routes: /api/huddle/<host>[/...] ---------- */
  function mount(route) {
    const H = '^\\/api\\/huddle\\/([A-Za-z0-9_-]{1,64})';
    const R = sub => new RegExp(H + sub.replace(/\//g, '\\/') + '$');
    route('GET', R(''), m => view(m[1]));
    route('GET', R('/entries'), (m, q) => { checkHost(m[1]); return engine(m[1]).entries(q); });
    route('GET', R('/history'), m => ({ ok: true, huddles: history(m[1]) }));
    route('POST', R('/say'), (m, q, b) => say(m[1], b));
    route('POST', R('/seats'), (m, q, b) => seats(m[1], b));
    // Stop = after this turn: the colleague writing finishes, nothing after it starts
    route('POST', R('/stop'), async m => { checkHost(m[1]); const r = await engine(m[1]).stop(); return view(m[1], r && r.note ? { note: r.note } : undefined); });
    route('POST', R('/hand'), async m => { checkHost(m[1]); await engine(m[1]).hand(); return view(m[1]); });
    route('POST', R('/continue'), async m => { checkHost(m[1]); await engine(m[1]).carryOn(); return view(m[1]); });
    // how hard they think, and one model for everyone or each person's usual: the owner's, kept with this chat's seats
    route('POST', R('/think'), async (m, q, b) => { checkHost(m[1]); const r = await engine(m[1]).setThink(b); return view(m[1], r && r.note ? { note: r.note } : undefined); });
    route('POST', R('/close'), (m, q, b) => close(checkHost(m[1]), String((b && b.why) || 'closed by ' + owner()).slice(0, 300)));
    route('GET', R('/attach'), (m, q, b, req, res) => { checkHost(m[1]); return engine(m[1]).attach(req, res, q); });
  }
  /* the console started: carry on a chat a previous console left mid-round (its turn in flight is re-attached), and close
     the ones nobody wrote to for 2 hours */
  function start() {
    let hosts = []; try { hosts = fs.readdirSync(ROOT()).filter(h => SAFE_HOST.test(h) && co.crew()[h] && fs.existsSync(path.join(hostDir(h), 'current.json'))); } catch (_) {}
    for (const h of hosts) { try { engine(h).start(); } catch (_) {} }
    const t = setInterval(() => sweep().catch(() => {}), 60000); if (t.unref) t.unref();
  }
  async function sweep() {
    for (const [host, E] of engines) {
      if (!opened(E) || !E.idle()) continue;
      const LOG = E._state().LOG;
      const lastOwner = [...LOG].reverse().find(e => (e.who === 'owner' && e.src !== 'chat') || e.kind === 'open' || e.kind === 'join');
      const at = lastOwner ? Date.parse(lastOwner.at) : 0;
      if (at && Date.now() - at > idleMs) await close(host, 'nobody wrote for ' + Math.round(idleMs / 3600e3) + ' hours');
    }
  }
  return { mount, start, sweep, engine, isOpen, pullFrom, pullLines, seats, say, close, view, history, takeRecap, LIMITS: { MAX_HUDDLE_GUESTS, MAX_HUDDLE_INVITES, MAX_HUDDLE_TURNS, IDLE_MS } };
};
module.exports.LIMITS = { MAX_HUDDLE_GUESTS, MAX_HUDDLE_INVITES, MAX_HUDDLE_TURNS, IDLE_MS };
