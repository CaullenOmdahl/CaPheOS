// Chat › Meeting (#/chat/meeting): the owner's meeting with the crew, beside the plain group chat (docs/MEETINGS.md).
// Everyone seated answers in turn, the leader first; the agents' ASK / INVITE / DISMISS / CALL / END / RULING lines show
// as small labelled chips, passes are hidden. The meeting's commands are controls here: the seat strip (crown = leader,
// × = remove, tap an avatar for its model, + Add), Round, Raise hand / Continue, Stop round, Observe (rounds) / Take
// part, New meeting, Talk only. The messages are the chat's rolling window (backscroll, Jump to latest).
// Live updates: the messages and the speaking-now line follow every change (events.onLive); the seat strip, which holds
// the roster dropdown, redraws through events.on, so an open dropdown is never closed under the owner.
import { composerKeys, COMPOSER_HINT } from './keys.js';
import { h, fill, Button, errLine, empty, when, humanError, initial } from './ui.js';
import { api, post } from './api.js';
import { mdBlock, md } from './md.js';
import { personName } from './plain.js';
import * as events from './events.js';

export const ACTIONS = {   // the controls and the API action each one calls (tests/meeting-ui-walk.js checks the map)
  round: '/meeting/round', hand: '/meeting/hand', continue: '/meeting/continue', stop: '/meeting/stop', observe: '/meeting/observe',
  newMeeting: '/meeting/new', agenda: '/meeting/agenda', close: '/meeting/close', resume: '/meeting/resume', lead: '/meeting/lead', seats: '/meeting/seats', say: '/meeting/say',
};
const CHIP = { ask: 'ASK', hand: 'HAND', call: 'CALL', lower: 'LOWER', ruling: 'RULING' };
const maybePass = t => String(t).trim().length <= 8 && 'PASS'.startsWith(String(t).toUpperCase().replace(/[^A-Z]/g, ''));

export function meetingPane(host, opts) {
  const { app, tz } = opts;
  let v = null, destroyed = false, liveCtl = null, liveRun = null, lastI = 0, firstI = null, meetingId = null, more = false, cursor = null;
  const nm = n => personName(n) || n;
  const running = () => !!(v && v.live && v.live.phase !== 'idle');

  /* ---------- the frame ---------- */
  const subEl = h('span', { class: 'caption muted mtg-sub' }, '');
  const costEl = h('span', { class: 'caption muted mtg-cost', role: 'status' }, '');
  const minutesBtn = Button('Open minutes', { variant: 'ghost', size: 'sm', aria: 'Open the minutes of this meeting', onClick: () => openMinutes() });
  const head = h('header', { class: 'chat-head' },
    h('div', { class: 'stack-4' }, h('h1', { class: 'h3' }, 'Meeting'), subEl, costEl),
    h('div', { class: 'row-8 mtg-head-actions' }, opts.modeSwitch || null, minutesBtn));
  const seatsHost = h('div', { class: 'mtg-seats', role: 'group', 'aria-label': 'Seats, in speaking order' });
  const agendaHost = h('div', { class: 'mtg-agenda', role: 'group', 'aria-label': 'Agenda' });
  const stateHost = h('div', { class: 'mtg-state' });
  const ctrlHost = h('div', { class: 'mtg-controls', role: 'toolbar', 'aria-label': 'Meeting controls' });
  const liveLine = h('p', { class: 'mtg-live caption', role: 'status', 'aria-live': 'polite' });
  const errHost = h('div', { class: 'mtg-err' });
  const body = h('div', { class: 'chat-body', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Meeting messages' });
  let pinned = true;
  const jump = h('button', { type: 'button', class: 'btn btn-secondary btn-sm chat-jump', hidden: true, onclick: () => { pinned = true; toBottom(); } }, 'Jump to latest ↓');
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  function toBottom() { body.scrollTop = body.scrollHeight; jump.hidden = true; }
  function scrollEnd() { if (pinned) toBottom(); else jump.hidden = false; }
  body.addEventListener('scroll', () => { pinned = atBottom(); if (pinned) jump.hidden = true; if (body.scrollTop < 120) showEarlier(); });
  const earlierBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm chat-earlier', onclick: () => showEarlier() }, 'Show earlier messages');
  const ta = h('textarea', { id: 'msg', rows: '3', class: 'textarea', placeholder: 'Write to everyone seated, or start with @name…', 'aria-autocomplete': 'list', 'aria-controls': 'mtg-ac' });
  const ac = h('ul', { id: 'mtg-ac', class: 'mtg-ac plain', role: 'listbox', hidden: true, 'aria-label': 'People to address' });
  const sendErr = h('p', { class: 'err-line', role: 'status' });
  const sendBtn = Button('Send', { variant: 'primary', type: 'submit' });
  const form = h('form', { 'aria-label': 'Message to the meeting', class: 'composer mtg-composer', onsubmit: e => { e.preventDefault(); send(); } },
    h('label', { for: 'msg', class: 'caption muted' }, COMPOSER_HINT + ' · @name to ask particular people · Esc raises your hand while they talk'),
    h('div', { class: 'mtg-ta-wrap' }, ta, ac),
    h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, sendErr, sendBtn));
  fill(host, head, stateHost, seatsHost, agendaHost, ctrlHost, liveLine, errHost, h('div', { class: 'chat-scroll' }, body, jump), form);

  /* ---------- actions ---------- */
  async function act(path, b, okMsg) {
    try { const r = await post(path, b); if (r && r.note && r.note !== 'sent') app.toast(r.note); else if (okMsg) app.toast(okMsg); v = r && r.meeting ? r : v; if (r && r.meeting) { drawControls(); drawLive(); drawSeats(); drawAgenda(); } refreshEntries(); return r; }
    catch (e) { app.toast(humanError(e), true); return null; }
  }
  async function send() {
    const text = ta.value.trim(); if (!text) return;
    sendErr.textContent = '';
    try { const r = await post(ACTIONS.say, { text }); ta.value = ''; closeAc(); if (r && r.note && r.note !== 'sent') app.toast(r.note); if (r && r.missing && r.missing.length) app.toast(r.missing.join(', ') + ' not seated: the message went to the others.'); v = r; drawControls(); drawLive(); pinned = true; refreshEntries(); }
    catch (e) { sendErr.textContent = 'Not sent: ' + humanError(e); }
  }
  const raiseHand = () => { if (running() && v.live.phase === 'round' && !v.live.ownerHand) act(ACTIONS.hand, {}); };

  /* ---------- the seat strip (held while a dropdown in it is open) ---------- */
  function drawSeats() {
    if (!v) return;
    const seats = v.seats || [];
    const unseated = (v.roster || []).filter(r => !r.seated);
    const items = seats.map((s, i) => {
      const model = s.model ? s.model.label : (s.modelError || 'no model');
      const modelEl = h('span', { class: 'caption muted mtg-model', hidden: true }, model);
      const av = h('button', { type: 'button', class: 'avatar mtg-av' + (s.leader ? ' lead' : ''), title: nm(s.name) + ' · ' + model, 'aria-label': nm(s.name) + ', speaks ' + ordinal(i + 1) + ', on ' + model + '. Show the model',
        'aria-expanded': 'false', onclick: () => { modelEl.hidden = !modelEl.hidden; av.setAttribute('aria-expanded', String(!modelEl.hidden)); } }, initial(s.name));
      const crown = h('button', { type: 'button', class: 'mtg-crown' + (s.leader ? ' on' : ''), 'aria-pressed': String(!!s.leader), 'data-act': 'lead', 'data-seat': s.id,
        'aria-label': s.leader ? nm(s.name) + ' leads the meeting' : 'Make ' + nm(s.name) + ' the leader', title: s.leader ? 'Leads the meeting' : 'Make leader',
        onclick: () => { if (!s.leader) act(ACTIONS.lead, { seat: s.id }, nm(s.name) + ' leads the meeting.'); } }, '♛');
      const rm = h('button', { type: 'button', class: 'mtg-rm', 'data-act': 'remove', 'data-seat': s.id, 'aria-label': 'Remove ' + nm(s.name) + ' from the seats', title: 'Remove',
        onclick: () => act(ACTIONS.seats, { remove: [s.id] }, nm(s.name) + ' left the seats.') }, '×');
      return h('div', { class: 'mtg-seat' + (s.leader ? ' leader' : '') + (v.live.speaking && v.live.speaking.id === s.id ? ' speaking' : ''), 'data-seat': s.id },
        av, h('span', { class: 'stack-2 mtg-seat-name' }, h('span', { class: 'label' }, nm(s.name)), h('span', { class: 'caption muted' }, s.guest ? 'guest' + (s.invitedBy ? ' of ' + nm((seats.find(x => x.id === s.invitedBy) || { name: s.invitedBy }).name) : '') : (s.title || '')), modelEl),
        crown, rm);
    });
    const pick = h('select', { class: 'select mtg-pick', 'aria-label': 'Someone to seat', id: 'mtg-pick' },
      h('option', { value: '' }, unseated.length ? 'Add someone…' : 'Everyone is seated'), unseated.map(r => h('option', { value: r.id }, nm(r.name) + (r.title ? ' · ' + r.title : ''))));
    pick.disabled = !unseated.length;
    const addBtn = Button('+ Add', { variant: 'secondary', size: 'sm', aria: 'Seat the person picked', onClick: () => { if (pick.value) act(ACTIONS.seats, { add: [pick.value] }, 'Seated.'); else pick.focus(); } });
    addBtn.dataset.act = 'add';
    const noLead = v.meeting.leader ? Button('No leader', { variant: 'ghost', size: 'sm', aria: 'Run the meeting with no leader', onClick: () => act(ACTIONS.lead, { seat: null }, 'No leader now.') }) : null;
    if (noLead) noLead.dataset.act = 'no-leader';
    fill(seatsHost, items.length ? items : h('span', { class: 'caption muted' }, 'Nobody is seated yet.'), h('div', { class: 'row-8 mtg-add' }, pick, addBtn, noLead));
  }
  function drawAgenda() {
    if (!v) return;
    const M = v.meeting, items = M.agenda || [];
    const row = it => {
      const now = it.id === M.agendaAt;
      const tools = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' + (it.tools ? ' on' : ''), 'data-act': 'item-tools', 'data-item': it.id, 'aria-pressed': String(!!it.tools),
        'aria-label': (it.tools ? 'Tools are on for ' : 'Talk only for ') + it.title + '. Switch', onclick: () => act(ACTIONS.agenda, { op: 'tools', id: it.id, on: !it.tools }) }, it.tools ? 'Tools on' : 'Talk only');
      return h('li', { class: 'mtg-item' + (now ? ' now' : '') + (it.done ? ' done' : ''), 'data-item': it.id },
        h('span', { class: 'body-s mtg-item-t' }, (now ? '▸ ' : '') + it.title),
        now ? h('span', { class: 'caption muted' }, 'now') : Button('Discuss now', { variant: 'ghost', size: 'sm', onClick: () => act(ACTIONS.agenda, { op: 'current', id: it.id }) }),
        tools,
        it.done ? null : Button('Done', { variant: 'ghost', size: 'sm', aria: 'Mark ' + it.title + ' done', onClick: () => act(ACTIONS.agenda, { op: 'done', id: it.id }) }),
        h('button', { type: 'button', class: 'mtg-rm', 'aria-label': 'Remove ' + it.title + ' from the agenda', onclick: () => act(ACTIONS.agenda, { op: 'remove', id: it.id }) }, '×'));
    };
    const title = h('input', { class: 'input mtg-item-new', id: 'mtg-item-new', placeholder: 'Add an agenda item…', 'aria-label': 'New agenda item', maxlength: '200' });
    const addItem = () => { const t = title.value.trim(); if (t) act(ACTIONS.agenda, { op: 'add', title: t }); };
    title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } });
    const type = h('select', { class: 'select mtg-type', id: 'mtg-type', 'aria-label': 'Type of the next meeting' }, (M.types || []).map(t => h('option', { value: t, selected: t === M.type }, t.charAt(0).toUpperCase() + t.slice(1))));
    const nb = Button('New meeting', { variant: M.state === 'open' ? 'ghost' : 'primary', size: 'sm', aria: 'Start a new meeting of the type picked, same seats', onClick: () => act(ACTIONS.newMeeting, { type: type.value }, 'A new meeting, same seats.') });
    nb.dataset.act = 'new';
    fill(agendaHost,
      h('div', { class: 'stack-6' },
        h('span', { class: 'caption muted' }, 'Agenda · talk only unless you switch tools on for an item' + (M.toolsOn ? ' · tools are on now' : '')),
        items.length ? h('ul', { class: 'plain mtg-items' }, items.map(row)) : null,
        h('div', { class: 'row-8 mtg-add' }, title, Button('Add item', { variant: 'secondary', size: 'sm', onClick: addItem }))),
      h('div', { class: 'row-8 mtg-add' }, type, nb));
  }
  function drawState() {
    if (!v) return;
    const M = v.meeting;
    const label = (M.type || 'decision').charAt(0).toUpperCase() + (M.type || 'decision').slice(1) + ' meeting' + (M.title ? ': ' + M.title : '');
    if (M.state === 'closed') fill(stateHost, h('div', { class: 'alertbox mtg-banner', role: 'status' }, h('span', { class: 'body-s' }, label + ' · closed' + (M.closedBy ? ' by ' + nm(M.closedBy) : '') + (M.closedAt ? ' · ' + when(M.closedAt, tz) : '') + '. Start a new meeting below.')));
    else if (M.state === 'interrupted') fill(stateHost, h('div', { class: 'alertbox mtg-banner', role: 'status' }, h('span', { class: 'body-s' }, label + ' · interrupted' + (M.reason ? ': ' + M.reason : '') + '.'), Button('Resume', { variant: 'primary', size: 'sm', onClick: () => act(ACTIONS.resume, {}) })));
    else fill(stateHost, h('p', { class: 'caption muted mtg-kind' }, label));
  }
  const ordinal = n => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n - 1] || 'number ' + n;

  /* ---------- the controls and the speaking-now line (live) ---------- */
  function drawControls() {
    if (!v) return;
    const L = v.live, M = v.meeting, run = running();
    const b = (label, act, o) => { const el = Button(label, Object.assign({ size: 'sm', variant: 'secondary' }, o)); el.dataset.act = act; return el; };
    const items = [];
    items.push(b('Round', 'round', { variant: run ? 'secondary' : 'primary', disabled: run || !(v.seats || []).length, aria: 'An open round: they answer each other, with no new message from you', onClick: () => act(ACTIONS.round, {}) }));
    if (L.phase === 'floor') items.push(b('Continue', 'continue', { variant: 'primary', aria: 'Let them carry on', onClick: () => act(ACTIONS.continue, {}) }));
    else if (run) items.push(b(L.ownerHand ? 'Hand raised' : 'Raise hand', 'hand', { disabled: L.ownerHand || L.phase === 'stopping', aria: 'Take the floor after the current speaker (Esc)', onClick: () => act(ACTIONS.hand, {}) }));
    if (run) items.push(b('Stop round', 'stop', { aria: 'Stop the round now', onClick: () => act(ACTIONS.stop, {}, 'Round stopped.') }));
    const isOpen = M.state === 'open';
    if (M.observer) items.push(b('Take part', 'take-part', { aria: 'Take part again: the meeting waits for you after each round', onClick: () => act(ACTIONS.observe, { on: false }) }));
    else {
      const minus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-step', 'data-act': 'rounds-down', 'aria-label': 'Fewer rounds', disabled: M.observeRounds <= 1, onclick: () => act(ACTIONS.observe, { on: false, rounds: M.observeRounds - 1 }) }, '−');
      const plus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-step', 'data-act': 'rounds-up', 'aria-label': 'More rounds', disabled: M.observeRounds >= 30, onclick: () => act(ACTIONS.observe, { on: false, rounds: M.observeRounds + 1 }) }, '+');
      items.push(h('span', { class: 'mtg-observe row-4' }, b('Observe', 'observe', { aria: 'Watch: you get no turn and they carry on by themselves for up to ' + M.observeRounds + ' rounds', onClick: () => act(ACTIONS.observe, { on: true, rounds: M.observeRounds }) }),
        minus, h('span', { class: 'caption mtg-rounds', 'aria-label': M.observeRounds + ' rounds' }, M.observeRounds + ' rounds'), plus));
    }
    if (isOpen && M.opened) items.push(b('Close meeting', 'close', { variant: 'ghost', aria: 'Close this meeting now, with or without an END from the leader', onClick: () => act(ACTIONS.close, {}, 'Meeting closed.') }));
    if (!isOpen) for (const x of items) if (/^(round|hand|observe|rounds-up|rounds-down)$/.test(x.dataset.act || '')) x.disabled = true;
    fill(ctrlHost, items);
    const lead = (v.seats || []).find(s => s.leader);
    subEl.textContent = [lead ? nm(lead.name) + ' leads' : 'No leader', M.observer ? 'you are observing (up to ' + M.observeRounds + ' rounds at a time)' : null, M.toolsOn ? 'tools on for this item' : 'talk only'].filter(Boolean).join(' · ');
    drawState();
    costEl.textContent = 'This meeting so far: ' + M.cost.turns + ' turn' + (M.cost.turns === 1 ? '' : 's') + ', $' + Number(M.cost.usd || 0).toFixed(2);
  }
  function drawLive() {
    if (!v) return;
    const L = v.live; const parts = [];
    if (L.phase === 'floor') parts.push(h('strong', {}, 'You have the floor.'), ' Write to everyone, or press Continue to let them carry on.');
    else if (L.phase === 'stopping') parts.push('Stopping the round…');
    else if (L.phase === 'round') {
      if (L.speaking) parts.push(h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ', h('strong', {}, 'Speaking now: ' + nm(L.speaking.name)), L.speaking.kind === 'ask' && L.speaking.from ? ' (answering ' + nm(nameOfId(L.speaking.from)) + ')' : L.speaking.kind === 'hand' ? ' (has the floor)' : '');
      else if (L.checking) parts.push(L.checking.kind === 'hands' ? 'Asking ' + L.checking.names.map(nm).join(', ') + ' whether they want to come in…' : nm(L.checking.names[0]) + ' is deciding on the raised hands…');
      else parts.push('The round is moving on…');
      if (L.next && L.next.length) parts.push(' · Next up: ' + L.next.map(x => nm(x.name)).join(', '));
      if (L.hands && L.hands.length) parts.push(' · Hands raised: ' + L.hands.map(x => nm(x.name) + (x.why ? ' (' + x.why + ')' : '')).join('; '));
      if (L.ownerHand) parts.push(' · Your hand is up: the floor is yours after this speaker');
      if (L.round) parts.push(' · Round ' + L.round.auto + ' of up to ' + L.round.cap);
    }
    fill(liveLine, parts);
    liveLine.hidden = !parts.length;
    follow(L.phase === 'round' && L.speaking && L.speaking.runId ? L.speaking : null);
  }
  const nameOfId = id => ((v && v.roster) || []).concat({ id: 'owner', name: v && v.owner }).find(r => r.id === id)?.name || id;

  /* ---------- the messages ---------- */
  function entryEl(e) {
    const t = e.at ? when(e.at, tz) : '';
    if (e.kind === 'say' && e.who === 'owner') return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end', 'data-i': e.i }, h('div', { class: 'msg-me' }, e.text), h('span', { class: 'msg-meta' }, 'You · ' + t));
    if (e.kind === 'say') {
      const meta = [nm(e.name), t, e.model, e.to ? 'answering ' + nm(e.toName) : null, e.interject ? 'interjecting' : null].filter(Boolean).join(' · ');
      return h('div', { class: 'stack-4 msg-them-wrap', 'data-i': e.i, 'data-who': e.who }, h('span', { class: 'label strong mtg-who' }, nm(e.name)), mdBlock(e.text, 'msg-them'), e.lint ? lintNotice(e) : null, h('span', { class: 'msg-meta' }, meta));
    }
    if (e.kind === 'end') return h('div', { class: 'mtg-end', 'data-i': e.i, role: 'note' }, h('span', { class: 'mtg-chip-k' }, 'END'), h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, 'Discussion closed by ' + nm(e.name)), e.text ? mdBlock(e.text, 'body-s') : null, h('span', { class: 'caption muted' }, t + ' · recorded in Decisions')));
    if (e.kind === 'join' || e.kind === 'leave') {
      const k = e.kind === 'join' ? (e.by ? 'INVITE' : 'SEATED') : (e.by ? 'DISMISS' : 'LEFT');
      return chip(k, e.kind === 'join' ? nm(e.name) + ' joined' + (e.by ? ', invited by ' + nm(e.byName) : '') : nm(e.name) + ' left' + (e.by && e.by !== e.who ? ', dismissed by ' + nm(e.byName) : ''), e.why, e);
    }
    if (e.kind === 'ask') return chip('ASK', nm(e.name) + ' → ' + nm(e.toName), e.text, e);
    if (e.kind === 'call') return chip(e.later ? 'LATER' : 'CALL', nm(e.name) + (e.later ? ' takes ' : ' calls on ') + nm(e.toName) + (e.later ? ' once the exchange is done' : ''), null, e);
    if (e.kind === 'lower') return chip('LOWER', nm(e.name) + ' lowered ' + nm(e.toName) + '\'s hand', null, e);
    if (e.kind === 'hand') return chip('HAND', nm(e.name) + ' raised a hand', e.why, e);
    if (e.kind === 'ruling') return chip('RULING', nm(e.name) + ' recorded a ruling', e.text, e);
    if (e.kind === 'parse') return h('div', { class: 'mtg-chip mtg-parse', 'data-kind': 'parse', 'data-i': e.i, role: 'status' }, h('span', { class: 'mtg-chip-k' }, 'COULD NOT READ'), h('span', { class: 'body-s' }, nm(e.name) + ': "' + e.line + '"'), h('span', { class: 'body-s muted' }, e.why + '. Nothing was done with it; ' + nm(e.name) + ' is told on their next turn.'));
    if (e.kind === 'close') return h('div', { class: 'mtg-end mtg-closed', 'data-i': e.i, role: 'note' }, h('span', { class: 'mtg-chip-k' }, e.state === 'interrupted' ? 'INTERRUPTED' : 'CLOSED'), h('span', { class: 'body-s' }, (e.line || '') + ' · ' + t));
    if (e.kind === 'open') return h('p', { class: 'caption muted mtg-line', 'data-i': e.i }, 'The meeting opened · ' + t);
    return h('p', { class: 'caption muted mtg-line', 'data-i': e.i }, (e.line || e.text || '') + (t ? ' · ' + t : ''));
  }
  function chip(k, who, text, e) {
    return h('div', { class: 'mtg-chip', 'data-kind': k.toLowerCase(), 'data-i': e.i }, h('span', { class: 'mtg-chip-k' }, k), h('span', { class: 'body-s' }, who + (text ? ': ' : '')), text ? h('span', { class: 'body-s muted' }, text) : null);
  }
  // the owner-scope lint (console/command-ask.js, the chat's): plain words and what to do
  function lintNotice(e) {
    const L = e.lint; const who = nm(e.name);
    const head = L.kind === 'command' ? 'This asks you to run a command.' : L.kind === 'observe-question' ? 'This puts a question to you while you observe.' : L.kind === 'jargon' ? 'This is hard to follow.' : 'The crew can handle this.';
    const say = L.kind === 'command' ? '@' + firstName(who) + ' I do not use a terminal. Do that with your own tools or a handoff, and tell me only what I need to decide.'
      : L.kind === 'observe-question' ? null
      : L.kind === 'jargon' ? '@' + firstName(who) + ' please say that again in two plain sentences: what you need, what I get, and what happens if I skip it.'
      : '@' + firstName(who) + ' that is crew work, not a question for me: handle it among yourselves or hand it to the right seat.';
    return h('div', { class: 'alertbox command-ask', role: 'status' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, head), h('span', { class: 'body-s' }, L.kind === 'observe-question' ? who + ' was told you are observing; the meeting carries on without your answer.' : 'You don\'t need to answer it. ' + who + ' is told on their next turn.')),
      say ? Button('Tell them', { variant: 'secondary', size: 'sm', onClick: () => { ta.value = say; ta.focus(); } }) : null);
  }
  const firstName = n => String(n || '').split(/\s+/)[0];

  async function refreshEntries(all) {
    try {
      const d = await api('/meeting/entries?limit=60');
      if (destroyed) return;
      const list = d.entries || [];
      const newMeeting = v && v.meeting && meetingId !== v.meeting.id;
      if (all || newMeeting || !body.querySelector('[data-i]') && list.length) {
        meetingId = v && v.meeting ? v.meeting.id : null;
        more = d.more; cursor = d.cursor;
        firstI = list.length ? list[0].i : null; lastI = list.length ? list[list.length - 1].i : 0;
        fill(body, more ? earlierBtn : null, list.length ? list.map(entryEl) : empty('Nobody has spoken yet. Write below and everyone seated answers in turn, the leader first. Start with @name to ask particular people.'));
        pinned = true; scrollEnd(); return;
      }
      const fresh = list.filter(e => e.i > lastI);
      if (!fresh.length) return;
      const emptyEl = body.querySelector('.empty'); if (emptyEl) emptyEl.remove();
      const liveCard = body.querySelector('.mtg-livecard');
      for (const e of fresh) body.insertBefore(entryEl(e), liveCard && !(e.kind === 'say' && liveRun && e.who === liveRun.id) ? liveCard : null);
      if (fresh.some(e => e.kind === 'say' && liveRun && e.who === liveRun.id) && liveCard) { liveCard.remove(); }
      lastI = fresh[fresh.length - 1].i;
      scrollEnd();
    } catch (e) { if (!destroyed) fill(errHost, errLine(e, 'Meeting')); }
  }
  async function showEarlier() {
    if (!more || !cursor || showEarlier.busy) return;
    showEarlier.busy = true;
    try {
      const d = await api('/meeting/entries?limit=60&before=' + cursor);
      const before = body.scrollHeight, top = body.scrollTop;
      const anchor = earlierBtn.isConnected ? earlierBtn.nextSibling : body.firstChild;
      for (const e of d.entries || []) body.insertBefore(entryEl(e), anchor);
      more = d.more; cursor = d.cursor; if (!more) earlierBtn.remove();
      body.scrollTop = top + (body.scrollHeight - before);
    } catch (_) {} finally { showEarlier.busy = false; }
  }

  /* ---------- the speaker's words as they come (GET /api/meeting/live) ---------- */
  function follow(sp) {
    if (liveRun && sp && liveRun.runId === sp.runId) return;
    if (liveCtl) { liveCtl.abort(); liveCtl = null; }
    const old = body.querySelector('.mtg-livecard'); if (old) old.remove();
    liveRun = sp;
    if (!sp) return;
    const text = h('div', { class: 'md msg-them' });
    const steps = h('span', { class: 'caption muted' }, '');
    const card = h('div', { class: 'stack-4 msg-them-wrap live mtg-livecard', 'data-who': sp.id }, h('span', { class: 'chat-who caption' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ' + nm(sp.name) + ' is thinking…'), steps, text);
    body.appendChild(card); scrollEnd();
    const ctl = liveCtl = new AbortController(); let got = '', from = 0;
    const draw = () => { if (maybePass(got)) return; const shown = got.replace(/^[ \t>*_-]*(INVITE|DISMISS|ASK|CALL|LATER|LOWER|END|RULING)\b.*$/gim, '').trim(); fill(text, md(shown)); card.firstChild.lastChild.textContent = ' ' + nm(sp.name) + ' is speaking…'; scrollEnd(); };
    (async () => {
      for (let tries = 0; tries < 30 && !ctl.signal.aborted; tries++) {
        try {
          const res = await fetch('/api/meeting/live?runId=' + encodeURIComponent(sp.runId) + '&from=' + from, { credentials: 'same-origin', signal: ctl.signal });
          const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', end = false;
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true }); let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
              let ev; try { ev = JSON.parse(l); } catch (_) { continue; }
              from++;
              if (ev.name === 'agent.token') { got += ev.payload.delta || ''; draw(); }
              else if (ev.name === 'agent.tool_call') steps.textContent = 'checking: ' + String(ev.payload.name || '').replace(/[_.]/g, ' ') + (ev.payload.argsSummary ? ' ' + String(ev.payload.argsSummary).slice(0, 80) : '');
              else if (ev.name === 'permission.prompt') consent(card, sp, ev.payload || {});
              else if (ev.name === 'permission.response') { const c = card.querySelector('[data-prompt="' + ((ev.payload || {}).promptId || '') + '"]'); if (c) c.replaceWith(h('p', { class: 'caption muted' }, 'Approval: ' + ((ev.payload || {}).decision || 'answered'))); }
              else if (ev.name === 'console.end' || ev.name === 'console.gone') end = true;
            }
          }
          if (end) return;
        } catch (e) { if (e.name === 'AbortError') return; }
        await new Promise(r => setTimeout(r, 800));
      }
    })();
  }

  // an approval the speaker's run asks for (a tool it may not use unasked): answered here, as in the chat
  function consent(card, sp, p) {
    if (card.querySelector('[data-prompt="' + (p.promptId || '') + '"]')) return;
    const answer = async d => {
      try { await post('/station/consent', { runId: sp.runId, promptId: p.promptId, decision: d }); el.replaceWith(h('p', { class: 'caption muted' }, d === 'deny' ? 'You said no.' : 'You allowed it.')); }
      catch (e) { app.toast('Not answered: ' + humanError(e), true); }
    };
    const el = h('div', { class: 'alertbox tool-permission', role: 'alertdialog', 'data-prompt': p.promptId || '' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, nm(sp.name) + ' asks to use ' + (p.tool || 'a tool')), h('span', { class: 'mono-s' }, String(p.argsSummary || '').slice(0, 400))),
      h('div', { class: 'row-8' }, Button('Allow once', { variant: 'primary', size: 'sm', onClick: () => answer('once') }), Button('No', { variant: 'ghost', size: 'sm', onClick: () => answer('deny') })));
    card.appendChild(el); scrollEnd();
  }

  /* ---------- @name autocomplete ---------- */
  let acIdx = -1, acItems = [];
  function wordAtCaret() { const p = ta.selectionStart, s = ta.value.slice(0, p); const m = /(^|\s)@([\w-]*)$/.exec(s); return m ? { start: p - m[2].length - 1, q: m[2].toLowerCase() } : null; }
  function openAc() {
    const w = wordAtCaret(); if (!w || !v) return closeAc();
    const seated = new Set((v.seats || []).map(s => s.id));
    const people = (v.roster || []).slice().sort((a, b) => (seated.has(b.id) ? 1 : 0) - (seated.has(a.id) ? 1 : 0)).concat([{ id: 'all', name: 'all', title: 'everyone seated' }]);
    acItems = people.filter(p => p.name.toLowerCase().startsWith(w.q) || p.name.toLowerCase().split(/\s+/).some(x => x.startsWith(w.q)) || p.id.toLowerCase().startsWith(w.q)).slice(0, 8);
    if (!acItems.length) return closeAc();
    acIdx = 0; drawAc();
  }
  function drawAc() {
    fill(ac, acItems.map((p, i) => h('li', { role: 'option', id: 'mtg-ac-' + i, 'aria-selected': String(i === acIdx), class: i === acIdx ? 'on' : '', onmousedown: e => { e.preventDefault(); pickAc(i); } },
      h('span', { class: 'label' }, '@' + firstName(nm(p.name))), h('span', { class: 'caption muted' }, ' ' + (p.id === 'all' ? p.title : (v.seats || []).some(s => s.id === p.id) ? 'seated' : 'not seated')))));
    ac.hidden = false; ta.setAttribute('aria-activedescendant', 'mtg-ac-' + acIdx); ta.setAttribute('aria-expanded', 'true');
  }
  function closeAc() { ac.hidden = true; acItems = []; acIdx = -1; ta.removeAttribute('aria-activedescendant'); ta.setAttribute('aria-expanded', 'false'); }
  function pickAc(i) {
    const w = wordAtCaret(); const p = acItems[i]; if (!w || !p) return closeAc();
    const ins = '@' + (p.id === 'all' ? 'all' : firstName(nm(p.name)).toLowerCase()) + ' ';
    ta.value = ta.value.slice(0, w.start) + ins + ta.value.slice(ta.selectionStart);
    const at = w.start + ins.length; ta.setSelectionRange(at, at); closeAc(); ta.focus();
  }
  ta.addEventListener('input', openAc);
  ta.addEventListener('blur', () => setTimeout(closeAc, 100));
  ta.addEventListener('keydown', e => {
    if (ac.hidden || !acItems.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIdx = (acIdx + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length; drawAc(); }
    else if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); pickAc(acIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeAc(); }
  });
  // Shift/Ctrl+Enter sends; Esc raises a hand while a round runs (in the message box and anywhere on the page)
  composerKeys(ta, () => send(), raiseHand);
  const onKey = e => { if (e.key !== 'Escape' || e.defaultPrevented || e.target === ta || document.querySelector('dialog[open]')) return; if (/^(SELECT|INPUT)$/.test((e.target || {}).tagName || '')) return; raiseHand(); };
  document.addEventListener('keydown', onKey);

  /* ---------- the minutes ---------- */
  async function openMinutes(date) {
    let d; try { d = await api('/meeting/minutes' + (date ? '?date=' + encodeURIComponent(date) : '')); } catch (e) { app.toast(humanError(e), true); return; }
    const old = document.querySelector('dialog.mtg-minutes'); if (old) old.remove();
    const days = (d.days || []).length ? h('select', { class: 'select', 'aria-label': 'Which day', onchange: e => openMinutes(e.target.value) }, d.days.map(x => h('option', { value: x, selected: x === d.date }, x))) : null;
    const dlg = h('dialog', { class: 'keys-dialog mtg-minutes', 'aria-label': 'Meeting minutes' },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h2', { class: 'h3' }, 'Minutes'), days),
      h('p', { class: 'caption muted' }, 'Every word, as it was said: ' + d.path),
      d.text ? mdBlock(d.text, 'mtg-minutes-body') : empty('No minutes for this day yet.'),
      h('form', { method: 'dialog' }, h('button', { class: 'btn btn-secondary btn-sm' }, 'Close')));
    document.body.appendChild(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }

  /* ---------- load and live updates ---------- */
  async function load() {
    try { v = await api('/meeting'); } catch (e) { fill(errHost, errLine(e, 'Meeting')); return null; }
    fill(errHost);
    drawSeats(); drawAgenda(); drawControls(); drawLive(); await refreshEntries(true);
    return v;
  }
  async function liveUpdate() {
    if (destroyed) return;
    try { v = await api('/meeting'); fill(errHost); } catch (e) { fill(errHost, errLine(e, 'Meeting')); return; }
    drawControls(); drawLive(); refreshEntries();
  }
  async function seatUpdate() { if (destroyed) return; try { const x = await api('/meeting'); v = x; drawSeats(); drawAgenda(); } catch (_) {} }
  const offLive = events.onLive(['meeting'], liveUpdate);
  const offSeats = events.on(['meeting', 'crew'], seatUpdate);
  return { load, ta, destroy: () => { destroyed = true; offLive(); offSeats(); document.removeEventListener('keydown', onKey); if (liveCtl) liveCtl.abort(); }, _view: () => v };
}
