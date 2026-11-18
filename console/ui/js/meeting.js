// Chat › Meeting (#/chat/meeting): the owner's meeting with the crew, beside the plain group chat (docs/MEETINGS.md),
// shown the way the owner's terminal table showed it. Everyone seated answers in turn, the leader first, and turns flow
// on by themselves; the turn in flight streams word by word under the speaker's name, in a colour that stays that
// person's, with each tool step as a dim "· Name: what they are doing" line. What happens between turns is one dim line
// each, in order: "(Phil passes)", "(Nadia answers Dave)", "(hands? Sharon, Phil…)", "(Sharon raises a hand: …)",
// "(Rachel calls on Nadia)", "(Omar joins, invited by Dave: …)". In view: the seat strip (crown = leader, × = remove,
// hover or tap an avatar for its model, + Add), Round, Raise hand / Continue, Stop, Observe (rounds) / Take part; the
// rest (Talk only, how hard they think and on which model, Pause, pace, agenda, register, minutes, catch-up, a new
// meeting, close) is under More. Esc raises a hand while they talk (only that: nobody is cut off). Stop is "stop after
// this turn": the speaker finishes, nothing after starts. The cost line shows the meeting so far and the next round's
// estimate at the current setting. The messages are the chat's rolling window (backscroll, Jump to latest).
// Live updates: the messages and the speaking-now line follow every change (events.onLive); the seat strip and the More
// panel, which hold dropdowns and fields, redraw through events.on, so an open dropdown is never closed under the owner.
import { composerKeys, COMPOSER_HINT } from './keys.js';
import { h, fill, Button, errLine, empty, when, humanError, initial } from './ui.js';
import { api, post } from './api.js';
import { mdBlock, md } from './md.js';
import { personName, toolStep } from './plain.js';
import * as events from './events.js';

export const ACTIONS = {   // the controls and the API action each one calls (tests/meeting-ui-walk.js checks the map)
  think: '/meeting/think', round: '/meeting/round', hand: '/meeting/hand', continue: '/meeting/continue', stop: '/meeting/stop', observe: '/meeting/observe',
  next: '/meeting/next', talkOnly: '/meeting/talkonly', register: '/meeting/register', explain: '/meeting/explain', glossary: '/meeting/glossary', pace: '/meeting/pace', hold: '/meeting/hold', catchup: '/meeting/catchup', newMeeting: '/meeting/new', agenda: '/meeting/agenda', close: '/meeting/close', resume: '/meeting/resume', lead: '/meeting/lead', seats: '/meeting/seats', say: '/meeting/say',
};
export const maybePass = t => String(t).trim().length <= 8 && 'PASS'.startsWith(String(t).toUpperCase().replace(/[^A-Z]/g, ''));
// each person keeps one colour, from their seat id (the table's fixed colours): the chart palette, themed for dark too
export const COLORS = 6;
// a tool step in plain words (plain.js toolStep); a bare path as its summary reads as that file
export const stepOf = (n, a) => { const raw = String(a || '').trim(); return toolStep(n, raw && !raw.startsWith('{') && /^[\w./-]{1,200}$/.test(raw) ? JSON.stringify({ path: raw }) : raw); };
export function colorOf(id) { let x = 0; for (const c of String(id || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % COLORS; }

export function meetingPane(host, opts) {
  const { app, tz } = opts;
  let v = null, destroyed = false, lastI = 0, firstI = null, meetingId = null, more = false, cursor = null;
  const nm = n => personName(n) || n;
  const running = () => !!(v && v.live && v.live.phase !== 'idle');

  /* ---------- the frame ---------- */
  const subEl = h('span', { class: 'caption muted mtg-sub' }, '');
  const costEl = h('span', { class: 'caption muted mtg-cost', role: 'status' }, '');
  const head = h('header', { class: 'chat-head' },
    h('div', { class: 'stack-4' }, h('h1', { class: 'h3' }, 'Meeting'), subEl, costEl),
    h('div', { class: 'row-8 mtg-head-actions' }, opts.modeSwitch || null));
  const seatsHost = h('div', { class: 'mtg-seats', role: 'group', 'aria-label': 'Seats, in speaking order' });
  const agendaHost = h('div', { class: 'mtg-agenda', role: 'group', 'aria-label': 'Agenda' });
  const stateHost = h('div', { class: 'mtg-state' });
  // the controls in view (redrawn on every live update) and More (built once, so it stays open, with whatever is being
  // typed in it, across live updates): everything that is not needed while they talk, in a panel over the messages
  const btnsHost = h('div', { class: 'mtg-btns', role: 'toolbar', 'aria-label': 'Meeting controls' });
  const moreCtrl = h('div', { class: 'row-8 mtg-more-ctrl', role: 'group', 'aria-label': 'More meeting controls' });
  const moreEl = h('details', { class: 'mtg-more' }, h('summary', { class: 'btn btn-secondary btn-sm', 'data-act': 'more', 'aria-label': 'More: talk only, pause, pace, agenda, register, minutes, a new meeting' }, 'More'),
    h('div', { class: 'mtg-more-panel stack-8' }, moreCtrl, agendaHost));
  const ctrlHost = h('div', { class: 'mtg-controls' }, btnsHost, moreEl);
  const onOutside = e => { if (moreEl.open && !moreEl.contains(e.target) && !(e.target.closest && e.target.closest('dialog'))) moreEl.open = false; };
  document.addEventListener('pointerdown', onOutside);
  moreEl.addEventListener('keydown', e => { if (e.key === 'Escape' && moreEl.open) { e.preventDefault(); e.stopPropagation(); moreEl.open = false; moreEl.querySelector('summary').focus(); } });
  const liveLine = h('p', { class: 'mtg-live caption', role: 'status', 'aria-live': 'polite' });
  const errHost = h('div', { class: 'mtg-err' });
  const body = h('div', { class: 'chat-body', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Meeting messages' });
  // Scrolling is the reader's: nothing scrolls or jumps by itself. New turns are counted on a pill; reading back is never
  // pulled away. Where you left off is kept per meeting (this browser) and the meeting opens there.
  let unseen = 0;
  const jump = h('button', { type: 'button', class: 'btn btn-secondary btn-sm chat-jump', hidden: true, onclick: () => { toBottom(); } }, 'Jump to latest ↓');
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  function toBottom() { body.scrollTop = body.scrollHeight; unseen = 0; jump.hidden = true; markRead(); }
  function newBelow(n) { if (n <= 0) return; if (atBottom() && body.scrollHeight <= body.clientHeight + 4) { markRead(); return; } unseen += n; jump.hidden = false; jump.textContent = unseen + ' new below ↓'; }
  const readKey = () => 'capheos.meeting.read.' + (v && v.meeting ? v.meeting.id : '');
  const lsGet = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, x) => { try { localStorage.setItem(k, x); } catch (_) {} };
  let lastRead = 0;
  function markRead() {
    const box = body.getBoundingClientRect(); let max = lastRead;
    for (const el of body.querySelectorAll('[data-i]')) { const r = el.getBoundingClientRect(); if (r.top < box.bottom && r.bottom > box.top) max = Math.max(max, Number(el.dataset.i) || 0); }
    if (max > lastRead) { lastRead = max; lsSet(readKey(), String(lastRead)); }
    if (atBottom()) { unseen = 0; jump.hidden = true; }
  }
  body.addEventListener('scroll', () => { markRead(); if (body.scrollTop < 120) showEarlier(); });
  const earlierBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm chat-earlier', onclick: () => showEarlier() }, 'Show earlier messages');
  const ta = h('textarea', { id: 'msg', rows: '3', class: 'textarea', placeholder: 'Write to everyone seated, or start with @name…', 'aria-autocomplete': 'list', 'aria-controls': 'mtg-ac' });
  const ac = h('ul', { id: 'mtg-ac', class: 'mtg-ac plain', role: 'listbox', hidden: true, 'aria-label': 'People to address' });
  const sendErr = h('p', { class: 'err-line', role: 'status' });
  const sendBtn = Button('Send', { variant: 'primary', type: 'submit' });
  const form = h('form', { 'aria-label': 'Message to the meeting', class: 'composer mtg-composer', onsubmit: e => { e.preventDefault(); send(); } },
    h('label', { for: 'msg', class: 'caption muted' }, COMPOSER_HINT + ' · @name to ask particular people · Esc raises your hand while they talk'),
    h('div', { class: 'mtg-ta-wrap' }, ta, ac),
    h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, sendErr, sendBtn));
  fill(host, head, stateHost, seatsHost, ctrlHost, liveLine, errHost, h('div', { class: 'row-8 mtg-readbar' }, null), h('div', { class: 'chat-scroll' }, body, jump), form);

  /* ---------- actions ---------- */
  async function act(path, b, okMsg) {
    askNotify();
    try { const r = await post(path, b); if (r && r.note && r.note !== 'sent') app.toast(r.note); else if (okMsg) app.toast(okMsg); v = r && r.meeting ? r : v; if (r && r.meeting) { drawControls(); drawLive(); drawSeats(); drawAgenda(); } refreshEntries(); return r; }
    catch (e) { app.toast(humanError(e), true); return null; }
  }
  async function send() {
    const text = ta.value.trim(); if (!text) return;
    sendErr.textContent = '';
    try { const r = await post(ACTIONS.say, { text }); ta.value = ''; closeAc(); if (r && r.note && r.note !== 'sent') app.toast(r.note); if (r && r.missing && r.missing.length) app.toast(r.missing.join(', ') + ' not seated: the message went to the others.'); v = r; drawControls(); drawLive(); refreshEntries(); }
    catch (e) { sendErr.textContent = 'Not sent: ' + humanError(e); }
  }
  // Esc raises your hand: the floor is yours after the current speaker. It never stops anyone (that would waste what
  // they already thought); Stop is a button, and it too waits for the current speaker to finish.
  const raiseHand = () => {
    if (!running()) return;
    if (v.live.phase === 'round' && !v.live.ownerHand) act(ACTIONS.hand, {});
  };

  /* ---------- the seat strip (held while a dropdown in it is open) ---------- */
  function drawSeats() {
    if (!v) return;
    const seats = v.seats || [];
    const unseated = (v.roster || []).filter(r => !r.seated);
    const items = seats.map((s, i) => {
      const model = s.model ? s.model.label : (s.modelError || 'no model');
      const modelEl = h('span', { class: 'caption muted mtg-model', hidden: true }, model);
      const av = h('button', { type: 'button', class: 'avatar mtg-av mtg-c' + colorOf(s.id) + (s.leader ? ' lead' : ''), title: nm(s.name) + ' · ' + model, 'aria-label': nm(s.name) + ', speaks ' + ordinal(i + 1) + ', on ' + model + '. Show the model',
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
    seatsHost.title = seats.length ? 'Who is at the table, in speaking order: ' + seats.map(s => nm(s.name) + (s.leader ? ' (leads)' : '') + ' on ' + (s.model ? s.model.label : (s.modelError || 'no model'))).join('; ') : '';
    fill(seatsHost, items.length ? items : h('span', { class: 'caption muted' }, 'Nobody is seated yet.'), h('div', { class: 'row-8 mtg-add' }, pick, addBtn, noLead));
  }
  function drawAgenda() {
    if (!v) return;
    const M = v.meeting, items = M.agenda || [];
    const row = it => {
      const now = it.id === M.agendaAt;
      const on = 'toolsOn' in it ? !!it.toolsOn : !!it.tools;
      const tools = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' + (on ? ' on' : ''), 'data-act': 'item-tools', 'data-item': it.id, 'aria-pressed': String(on),
        'aria-label': (on ? 'Tools are on for ' : 'Talk only for ') + it.title + '. Switch', onclick: () => act(ACTIONS.agenda, { op: 'tools', id: it.id, on: !on }) }, on ? 'Tools on' : 'Talk only');
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
        h('span', { class: 'caption muted' }, 'Agenda · each item follows the meeting (' + (M.talkOnly ? 'talk only' : 'tools on') + ') unless you switch it' + (M.toolsOn ? ' · tools are on now' : ' · talk only now')),
        items.length ? h('ul', { class: 'plain mtg-items' }, items.map(row)) : null,
        h('div', { class: 'row-8 mtg-add' }, title, Button('Add item', { variant: 'secondary', size: 'sm', onClick: addItem }))),
      h('div', { class: 'row-8 mtg-add' }, speed(M), type, nb));
  }
  function speed(M) {
    const label = { manual: 'Next (I advance)', instant: 'Flowing (as at the table)', fast: 'Fast', normal: 'Normal', slow: 'Slow' };
    const sel = h('select', { class: 'select mtg-speed', id: 'mtg-speed', 'aria-label': 'Pace: how the meeting advances', onchange: e => act(ACTIONS.pace, { speed: e.target.value }) },
      (M.speeds || []).map(x => h('option', { value: x, selected: x === M.speed }, 'Pace: ' + (label[x] || x))));
    return sel;
  }
  function drawState() {
    if (!v) return;
    const M = v.meeting;
    const label = (M.type || 'decision').charAt(0).toUpperCase() + (M.type || 'decision').slice(1) + ' meeting' + (M.title ? ': ' + M.title : '');
    if (M.state === 'closed') fill(stateHost, h('div', { class: 'alertbox mtg-banner', role: 'status' }, h('span', { class: 'body-s' }, label + ' · closed' + (M.closedBy ? ' by ' + nm(M.closedBy) : '') + (M.closedAt ? ' · ' + when(M.closedAt, tz) : '') + '. Start a new meeting below.')));
    else if (M.state === 'interrupted') fill(stateHost, h('div', { class: 'alertbox mtg-banner', role: 'status' }, h('span', { class: 'body-s' }, label + ' · interrupted' + (M.reason ? ': ' + M.reason : '') + '.'), Button('Resume', { variant: 'primary', size: 'sm', onClick: () => act(ACTIONS.resume, {}) })));
    else fill(stateHost, h('p', { class: 'caption muted mtg-kind' }, label));
  }
  /* how hard they think (Light / Normal / Deep, Max only on purpose) and on which model (each person's usual, or one for
     everyone): the owner's, in plain words; hand checks always run Light */
  function thinkControls(T) {
    if (!T) return [];
    const lv = h('select', { class: 'select mtg-think', id: 'mtg-think', 'data-act': 'think', 'aria-label': 'How hard they think: every turn uses this, whatever level their own work uses; hand checks stay Light' },
      T.levels.map(x => h('option', { value: x.id, selected: x.id === T.level }, 'How hard they think: ' + x.label + (x.deliberate ? ' (costs the most)' : ''))));
    lv.addEventListener('change', () => {
      const id = lv.value;
      if (id === 'max' && !window.confirm('Max thinking costs the most, on every turn. Use it for this meeting?')) { lv.value = T.level; return; }
      act(ACTIONS.think, id === 'max' ? { level: id, sure: true } : { level: id });
    });
    const pinV = T.pin ? T.pin.provider + '/' + T.pin.model : '';
    const md = h('select', { class: 'select mtg-pin', id: 'mtg-pin', 'data-act': 'pin', 'aria-label': 'Which model: each person\'s usual, or one for everyone (someone who cannot use it right now sits the turn out)' },
      h('option', { value: '', selected: !pinV }, 'Model: each person\'s usual'),
      (T.choices || []).map(c => h('option', { value: c.provider + '/' + c.model, selected: pinV === c.provider + '/' + c.model }, 'Model: ' + c.label + ' for everyone')));
    md.addEventListener('change', () => act(ACTIONS.think, { pin: md.value || 'usual' }));
    return [lv, md];
  }
  const ordinal = n => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n - 1] || 'number ' + n;

  /* ---------- the controls and the speaking-now line (live) ---------- */
  function drawControls() {
    if (!v) return;
    const L = v.live, M = v.meeting, run = running();
    const b = (label, act, o) => { const el = Button(label, Object.assign({ size: 'sm', variant: 'secondary' }, o)); el.dataset.act = act; return el; };
    const items = [], more = [];
    items.push(b('Round', 'round', { variant: run ? 'secondary' : 'primary', disabled: run || !(v.seats || []).length, aria: 'An open round: they answer each other, with no new message from you', onClick: () => act(ACTIONS.round, {}) }));
    if (L.phase === 'floor') items.push(b('Continue', 'continue', { variant: 'primary', aria: 'Let them carry on', onClick: () => act(ACTIONS.continue, {}) }));
    else if (run) items.push(b(L.ownerHand ? 'Hand raised' : 'Raise hand', 'hand', { disabled: L.ownerHand || L.phase === 'stopping', aria: 'Take the floor after the current speaker (Esc)', onClick: () => act(ACTIONS.hand, {}) }));
    if (run && L.waitNext) items.unshift(b(L.next && L.next[0] ? 'Next: ' + nm(L.next[0].name) : 'Next', 'next', { variant: 'primary', aria: 'You have read it: let the next person speak', onClick: () => act(ACTIONS.next, {}) }));
    if (run) items.push(b(L.phase === 'stopping' ? 'Stopping…' : 'Stop after this turn', 'stop', { disabled: L.phase === 'stopping', aria: 'Stop after this turn: the current speaker finishes, nothing after it starts', onClick: () => act(ACTIONS.stop, {}) }));
    const isOpen = M.state === 'open';
    if (M.observer) items.push(b('Take part', 'take-part', { aria: 'Take part again: the meeting waits for you after each round', onClick: () => act(ACTIONS.observe, { on: false }) }));
    else {
      const minus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-step', 'data-act': 'rounds-down', 'aria-label': 'Fewer rounds', disabled: M.observeRounds <= 1, onclick: () => act(ACTIONS.observe, { on: false, rounds: M.observeRounds - 1 }) }, '−');
      const plus = h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-step', 'data-act': 'rounds-up', 'aria-label': 'More rounds', disabled: M.observeRounds >= 30, onclick: () => act(ACTIONS.observe, { on: false, rounds: M.observeRounds + 1 }) }, '+');
      items.push(h('span', { class: 'mtg-observe row-4' }, b('Observe', 'observe', { aria: 'Watch: you get no turn and they carry on by themselves for up to ' + M.observeRounds + ' rounds', onClick: () => act(ACTIONS.observe, { on: true, rounds: M.observeRounds }) }),
        minus, h('span', { class: 'caption mtg-rounds', 'aria-label': M.observeRounds + ' rounds' }, M.observeRounds + ' rounds'), plus));
    }
    // under More
    more.push(...thinkControls(M.think));
    more.push(b(M.talkOnly ? 'Tools: off (talk only)' : 'Tools: on', 'talk-only', { variant: 'ghost', aria: M.talkOnly ? 'Talk only: nobody has tools. Switch tools back on, so they can check what they say' : 'Tools are on: they can read and check what they say. Switch to talk only', onClick: () => act(ACTIONS.talkOnly, { on: !M.talkOnly }) }));
    more[0].setAttribute('aria-pressed', String(!M.talkOnly));
    if (run && L.phase !== 'floor' && !L.pausedFor) more.push(L.paused ? b('Carry on', 'unpause', { variant: 'primary', aria: 'Carry on: the next turn may start', onClick: () => act(ACTIONS.hold, { on: false }) })
      : b('Pause', 'pause', { variant: 'ghost', aria: 'Hold the floor: the current turn finishes, then nothing new starts (and nothing is spent)', onClick: () => act(ACTIONS.hold, { on: true }) }));
    if (M.opened) more.push(b('Catch me up', 'catchup', { variant: 'ghost', aria: 'Five bullets of what you missed, what was decided and what is still asked', onClick: async () => { const r = await act(ACTIONS.catchup, { since: lastRead }); if (r) app.toast('Your catch-up is in the messages.'); } }));
    more.push(b('Register', 'register', { variant: 'ghost', aria: 'The action register: rulings, actions, open questions, kill conditions', onClick: () => openRegister() }));
    more.push(b('Open minutes', 'minutes', { variant: 'ghost', aria: 'Open the minutes of this meeting', onClick: () => openMinutes() }));
    if (isOpen && M.opened) more.push(b('Close meeting', 'close', { variant: 'ghost', aria: 'Close this meeting now, with or without an END from the leader', onClick: () => act(ACTIONS.close, {}, 'Meeting closed.') }));
    if (!isOpen) for (const x of items) if (/^(round|hand|observe|rounds-up|rounds-down)$/.test(x.dataset.act || '')) x.disabled = true;
    fill(btnsHost, items);
    fill(moreCtrl, more);
    const lead = (v.seats || []).find(s => s.leader);
    subEl.textContent = [lead ? nm(lead.name) + ' leads' : 'No leader', M.observer ? 'you are observing (up to ' + M.observeRounds + ' rounds at a time)' : null, M.toolsOn ? 'tools on' : 'talk only', M.speed && M.speed !== 'instant' ? 'pace: ' + ({ manual: 'you press Next', fast: 'fast', normal: 'normal', slow: 'slow' }[M.speed] || M.speed) : null].filter(Boolean).join(' · ');
    drawState();
    costEl.textContent = [M.costLine || ('This meeting so far: ' + M.cost.turns + ' turn' + (M.cost.turns === 1 ? '' : 's')), M.estimateLine || ''].filter(Boolean).join(' · ');
  }
  function drawLive() {
    if (!v) return;
    const L = v.live; const parts = [];
    if (L.phase === 'floor') parts.push(h('strong', {}, 'Your turn: you have the floor.'), L.floorWhy ? ' ' + L.floorWhy + '.' : '', ' Write to everyone, or press Continue to let them carry on.');
    else if (L.phase === 'stopping') parts.push(L.stoppingAfter ? 'Stopping after ' + nm(L.stoppingAfter) + ' finishes this turn' + (L.closing ? ', then the meeting closes' : '') + '…' : 'Stopping the round…');
    else if (L.phase === 'round') {
      if (L.speaking) parts.push(h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ', h('strong', {}, 'Speaking now: ' + nm(L.speaking.name)), L.speaking.kind === 'ask' && L.speaking.from ? ' (answering ' + nm(nameOfId(L.speaking.from)) + ')' : L.speaking.kind === 'hand' ? ' (has the floor)' : '');
      else if (L.checking) parts.push(L.checking.kind === 'hands' ? 'Asking ' + L.checking.names.map(nm).join(', ') + ' whether they want to come in…' : nm(L.checking.names[0]) + ' is deciding on the raised hands…');
      else parts.push('The round is moving on…');
      if (L.next && L.next.length) parts.push(' · Next up: ' + L.next.map(x => nm(x.name)).join(', '));
      if (L.hands && L.hands.length) parts.push(' · Hands raised: ' + L.hands.map(x => nm(x.name) + (x.why ? ' (' + x.why + ')' : '')).join('; '));
      if (L.ownerHand) parts.push(' · Your hand is up: the floor is yours after this speaker');
      if (L.round) parts.push(' · Round ' + L.round.auto + ' of up to ' + L.round.cap);
      if (L.pausedFor) parts.push(' · Paused: ' + nm(L.pausedFor.seat) + ' asked to use ' + (L.pausedFor.tool || 'a tool') + '. ', h('a', { href: '#/today' }, 'Answer it on Today'), ' and the meeting carries on.');
      else if (L.paused) parts.push(' · Paused: nothing new starts until you carry on');
      else if (L.waitNext && !L.speaking) parts.push(' · Waiting for you to press Next');
      else if (L.nextAt && !L.speaking) parts.push(' · Next turn in ' + Math.max(0, Math.round((L.nextAt - Date.now()) / 1000)) + ' s');
    }
    fill(liveLine, parts);
    liveLine.hidden = !parts.length;
    notifyTurn(L);
    // in the flow too, as the table printed it: who is being asked for a hand, who decides on the hands
    const chk = L.phase === 'round' && L.checking ? (L.checking.kind === 'hands' ? '(hands? ' + L.checking.names.map(nm).join(', ') + '…)' : '(' + nm(L.checking.names[0]) + ' looks at the raised hands…)') : '';
    liveNote.textContent = chk; liveNote.hidden = !chk;
    follow(L);
  }
  const nameOfId = id => ((v && v.roster) || []).concat({ id: 'owner', name: v && v.owner }).find(r => r.id === id)?.name || id;

  /* ---------- the messages ---------- */
  const entryEl = e => renderEntry(e, { tz, onExplain: x => act(ACTIONS.explain, { i: x.i }), onRegister: () => openRegister(), lintNotice });
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

  /* ---------- the turn in flight, streamed (GET /api/meeting/attach: the run's journal, then live) ----------
     As at the table: the words appear as they are written, under the speaker's name, held back while they could still
     turn out to be PASS (at the start and again after each tool step); each tool step is a dim "· Name: …" line. A
     reload or a console restart re-attaches from the lines already shown. The finished turn then arrives as an entry. */
  const liveTurn = h('div', { class: 'mtg-liveturn', hidden: true });
  const liveNote = h('p', { class: 'caption muted mtg-ev mtg-ev-live', hidden: true, role: 'status' });
  const liveArea = h('div', { class: 'mtg-livearea', 'data-live': '1' }, liveTurn, liveNote);
  let S = null;
  function follow(L) {
    const sp = L && L.phase !== 'idle' && L.speaking && L.speaking.runId ? L.speaking : null;
    if (S && (!sp || sp.runId !== S.runId)) endStream();
    if (sp && !S) startStream(sp);
  }
  async function startStream(sp) {
    const st = S = { runId: sp.runId, seat: sp.id, name: sp.name, ctrl: new AbortController(), count: 0, ended: false, held: '', live: false, seg: null, tools: 0 };
    for (let tries = 0; S === st && !st.ended && !destroyed && tries < 30; tries++) {
      try {
        const r = await fetch('/api/meeting/attach?runId=' + encodeURIComponent(st.runId) + '&from=' + st.count, { credentials: 'same-origin', signal: st.ctrl.signal, headers: { Accept: 'application/x-ndjson' } });
        if (!r.ok || !r.body) throw new Error('attach ' + r.status);
        const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) streamLine(st, l); }
        }
      } catch (e) { if (e && e.name === 'AbortError') return; }
      if (S !== st || st.ended) return;
      await new Promise(r => setTimeout(r, 1000));   // the console restarted or the network blinked: pick up where it was
    }
  }
  function streamLine(st, l) {
    let x; try { x = JSON.parse(l); } catch (_) { return; }
    if (S !== st) return;
    if (x.name === 'console.gone') { st.ended = true; return; }
    st.count++;
    const p = x.payload || {};
    const stick = atBottom();
    if (x.name === 'agent.token' && typeof p.delta === 'string') {
      if (st.live) show(st, p.delta);
      else { st.held += p.delta; if (!maybePass(st.held)) { st.live = true; const t = st.held; st.held = ''; show(st, t); } }
    } else if (x.name === 'agent.tool_call') {
      if (st.held.trim()) show(st, st.held);
      st.held = ''; st.live = false; st.seg = null; st.tools++;
      streamHead(st);
      liveTurn.appendChild(h('p', { class: 'caption muted mtg-tool', 'data-tool': p.name || '' }, '· ' + nm(st.name) + ': ' + stepOf(p.name, p.argsSummary)));
    } else if (x.name === 'console.end') {
      st.ended = true;
      if (st.held.trim() && !maybePass(st.held) && !/^\W*pass\W*$/i.test(st.held)) show(st, st.held);
      st.held = '';
    }
    if (stick && !liveTurn.hidden) body.scrollTop = body.scrollHeight;   // following the latest only if you already were there
  }
  function streamHead(st) {
    if (!liveTurn.hidden) return;
    fill(liveTurn, h('span', { class: 'label strong mtg-who' }, nm(st.name)));
    liveTurn.className = 'mtg-liveturn stack-4 mtg-c' + colorOf(st.seat); liveTurn.dataset.who = st.seat; liveTurn.hidden = false;
  }
  function show(st, t) {
    streamHead(st);
    if (!st.seg) { st.seg = h('div', { class: 'msg-them mtg-stream' }); liveTurn.appendChild(st.seg); t = t.replace(/^\s+/, ''); }
    st.seg.appendChild(document.createTextNode(t));
  }
  // the turn is over: the streamed words give way to its entry (which carries its tool steps)
  function endStream() {
    const st = S; S = null; if (!st) return;
    try { st.ctrl.abort(); } catch (_) {}
    fill(liveTurn); liveTurn.hidden = true;
  }

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
        fill(body, more ? earlierBtn : null, list.length ? list.map(entryEl) : empty('Nobody has spoken yet. Write below and everyone seated answers in turn, the leader first. Start with @name to ask particular people.'), liveArea);
        applyMode();
        // open where the owner left off: the first turn after their last read, with a marker; else at the latest
        lastRead = Number(lsGet(readKey())) || 0;
        const firstNew = lastRead ? [...body.querySelectorAll('[data-i]')].find(el => Number(el.dataset.i) > lastRead) : null;
        if (firstNew) { body.insertBefore(h('p', { class: 'caption mtg-leftoff', role: 'note' }, 'You left off here'), firstNew); body.scrollTop = Math.max(0, firstNew.offsetTop - body.offsetTop - 40); }
        else body.scrollTop = body.scrollHeight;
        markRead(); return;
      }
      const fresh = list.filter(e => e.i > lastI);
      if (!fresh.length) return;
      const emptyEl = body.querySelector('.empty'); if (emptyEl) emptyEl.remove();
      const top = body.scrollTop;
      for (const e of fresh) body.insertBefore(entryEl(e), liveArea.isConnected ? liveArea : null);
      body.scrollTop = top;   // never moved by an arrival
      applyMode();
      lastI = fresh[fresh.length - 1].i;
      newBelow(fresh.filter(e => e.kind === 'say').length);
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

  /* ---------- the register: each owner's lines; the owner's rulings ---------- */
  async function openRegister() {
    let d; try { d = await api('/meeting/register'); } catch (e) { app.toast(humanError(e), true); return; }
    const old = document.querySelector('dialog.mtg-register'); if (old) old.remove();
    const r = d.register; const bad = new Map((d.problems || []).map(p => [p.section + ':' + p.n, p.errors]));
    const flag = (s, n) => bad.has(s + ':' + n) ? h('span', { class: 'caption danger' }, ' Fails validation: ' + bad.get(s + ':' + n).join('; ') + '.') : null;
    const who = id => id === 'owner' ? 'you' : nm(nameOfId(id));
    const sec = (title, rows, render) => h('section', { class: 'stack-6' }, h('h3', { class: 'label strong' }, title), rows.length ? h('ul', { class: 'plain stack-6' }, rows.map(render)) : h('p', { class: 'caption muted' }, 'None yet.'));
    const reload = () => { dlg.close(); openRegister(); };
    const rtext = h('input', { class: 'input', placeholder: 'Your ruling', 'aria-label': 'Your ruling', id: 'mtg-ruling-text' });
    const rplain = h('input', { class: 'input', placeholder: 'In plain words (one sentence anyone can read)', 'aria-label': 'Your ruling in plain words', id: 'mtg-ruling-plain' });
    const nrec = h('input', { class: 'input', placeholder: 'Something not recorded here (e.g. no money was spent)', 'aria-label': 'Not recorded here', id: 'mtg-notrec' });
    const dlg = h('dialog', { class: 'keys-dialog mtg-register', 'aria-label': 'Action register' },
      h('h2', { class: 'h3' }, 'Action register'),
      h('p', { class: 'caption muted' }, 'What the meeting decided and who does what. Nobody writes a line for someone else: each owner updates their own. File: ' + d.file),
      r.summary ? h('p', { class: 'body-s' }, h('strong', {}, 'Closed with: '), r.summary.text + (r.summary.plain ? ' — in plain words: ' + r.summary.plain : ''), r.summary.plain || r.summary.plainOptional ? null : h('span', { class: 'caption danger' }, ' Fails validation: no plain-language line.')) : null,
      sec('Your rulings', r.rulings, x => h('li', { class: 'stack-4', 'data-ruling': x.n }, h('span', { class: 'body-s' }, x.n + '. ' + x.text + (x.plain ? ' — in plain words: ' + x.plain : '')),
        h('span', { class: 'caption muted' }, x.confirmed ? 'Confirmed by you' + (x.decisionId ? ' · in Decisions (' + x.decisionId + ')' : '') : 'Proposed by ' + who(x.proposedBy) + ': not yours until you confirm it'), flag('rulings', x.n),
        x.confirmed ? null : Button('Confirm ruling', { variant: 'primary', size: 'sm', onClick: async () => { try { await post(ACTIONS.register, { op: 'confirm', n: x.n }); app.toast('Confirmed: it is in Decisions.'); reload(); } catch (e) { app.toast(humanError(e), true); } } }))),
      h('div', { class: 'row-8' }, rtext, rplain, Button('Add your ruling', { variant: 'secondary', size: 'sm', onClick: async () => { try { await post(ACTIONS.register, { op: 'ruling', text: rtext.value, plain: rplain.value }); app.toast('Ruling recorded, and in Decisions.'); reload(); } catch (e) { app.toast(humanError(e), true); } } })),
      sec('Actions', r.actions, x => h('li', { class: 'stack-2', 'data-action': x.n }, h('span', { class: 'body-s' }, x.n + '. ' + x.text), h('span', { class: 'body-s muted' }, 'In plain words: ' + (x.plain || '—')),
        h('span', { class: 'caption muted' }, who(x.owner) + ' · ' + (x.date || 'no date') + ' · ' + (x.status || 'no status') + (x.affects ? ' · affects ' + x.affects : '') + ' · ' + who(x.owner) + ' updates this line'), flag('actions', x.n))),
      sec('Open questions', r.questions, x => h('li', { class: 'body-s' }, x.text + (x.plain ? ' — in plain words: ' + x.plain : '') + ' (' + who(x.owner) + ')', flag('questions', x.n))),
      sec('Kill conditions', r.kills, x => h('li', { class: 'body-s' }, x.text + (x.plain ? ' — in plain words: ' + x.plain : '') + ' (' + who(x.owner) + ')', flag('kills', x.n))),
      sec('Not recorded here', r.notRecorded, x => h('li', { class: 'body-s' }, x.text)),
      termsBox(),
      h('div', { class: 'row-8' }, nrec, Button('Add', { variant: 'secondary', size: 'sm', onClick: async () => { try { await post(ACTIONS.register, { op: 'not-recorded', text: nrec.value }); reload(); } catch (e) { app.toast(humanError(e), true); } } })),
      h('form', { method: 'dialog' }, h('button', { class: 'btn btn-secondary btn-sm' }, 'Close')));
    document.body.appendChild(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }

  // terms the room may not share: the meeting's acronym check (no model), and the glossary to define them in
  function termsBox() {
    const box = h('section', { class: 'stack-6 mtg-terms' }, h('h3', { class: 'label strong' }, 'Terms the room may not share'), h('p', { class: 'caption muted' }, 'Checking…'));
    api('/meeting/terms').then(d => {
      const list = d.undefined || [];
      fill(box, h('h3', { class: 'label strong' }, 'Terms the room may not share'),
        h('p', { class: 'caption muted' }, list.length ? 'Used without a definition. Define one here and it goes into ' + d.glossary + '.' : 'Every short term used so far is defined (' + d.glossary + ').'),
        list.length ? h('ul', { class: 'plain stack-4' }, list.map(x => { const inp = h('input', { class: 'input', placeholder: 'What ' + x.term + ' means', 'aria-label': 'What ' + x.term + ' means' });
          return h('li', { class: 'row-8', 'data-term': x.term, style: 'align-items:center' }, h('span', { class: 'body-s' }, h('strong', {}, x.term), ' (first used by ' + nm(x.firstBy) + ')'), inp,
            Button('Define', { variant: 'secondary', size: 'sm', onClick: async () => { try { await post(ACTIONS.glossary, { term: x.term, meaning: inp.value }); app.toast(x.term + ' is in the glossary.'); inp.closest('li').remove(); } catch (e) { app.toast(humanError(e), true); } } })); })) : null);
    }).catch(() => {});
    return box;
  }

  /* ---------- the minutes ---------- */
  function searchBox() {
    const out = h('ul', { class: 'plain stack-4 mtg-search-out' });
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search meetings: a name, a decision, an action, q:78…', 'aria-label': 'Search meetings', id: 'mtg-search' });
    const go = async () => { let d; try { d = await api('/meeting/search?q=' + encodeURIComponent(q.value)); } catch (_) { return; }
      fill(out, (d.meetings || []).length ? d.meetings.map(m => h('li', { class: 'body-s' }, h('strong', {}, String(m.startedAt || '').slice(0, 10) + ' · ' + m.type + (m.title ? ': ' + m.title : '')), ' — ' + (m.participants || []).join(', ') + (m.decisions && m.decisions.length ? ' · decided: ' + m.decisions.join('; ') : '') + (m.actions && m.actions.length ? ' · ' + m.actions.length + ' actions' : '') + ' (' + m.state + ')')) : h('li', { class: 'caption muted' }, 'No meeting matches.')); };
    q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    return h('div', { class: 'stack-6' }, h('div', { class: 'row-8' }, q, Button('Search', { variant: 'secondary', size: 'sm', onClick: go })), out);
  }
  async function openMinutes(date) {
    let d; try { d = await api('/meeting/minutes' + (date ? '?date=' + encodeURIComponent(date) : '')); } catch (e) { app.toast(humanError(e), true); return; }
    const old = document.querySelector('dialog.mtg-minutes'); if (old) old.remove();
    const days = (d.days || []).length ? h('select', { class: 'select', 'aria-label': 'Which day', onchange: e => openMinutes(e.target.value) }, d.days.map(x => h('option', { value: x, selected: x === d.date }, x))) : null;
    const dlg = h('dialog', { class: 'keys-dialog mtg-minutes', 'aria-label': 'Meeting minutes' },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('h2', { class: 'h3' }, 'Minutes'), days),
      h('p', { class: 'caption muted' }, 'Every word, as it was said: ' + d.path),
      searchBox(),
      d.text ? mdBlock(d.text, 'mtg-minutes-body') : empty('No minutes for this day yet.'),
      h('form', { method: 'dialog' }, h('button', { class: 'btn btn-secondary btn-sm' }, 'Close')));
    document.body.appendChild(dlg); dlg.addEventListener('close', () => dlg.remove()); dlg.showModal();
  }

  /* ---------- reading aids: modes, the timeline, your-turn notice, presence ---------- */
  let mode = lsGet('capheos.meeting.mode') || 'all';
  const SKIM = new Set(['end', 'ruling', 'register', 'ask', 'hand', 'call', 'later', 'lower', 'parse', 'close', 'catchup']);
  const modeBar = h('nav', { class: 'seg mtg-modes', 'aria-label': 'Reading mode' }, ['all', 'speaker', 'skim'].map(m => h('button', { type: 'button', 'data-mode': m, class: m === mode ? 'on' : '', 'aria-pressed': String(m === mode), onclick: () => { mode = m; lsSet('capheos.meeting.mode', m); for (const x of modeBar.children) { x.classList.toggle('on', x.dataset.mode === m); x.setAttribute('aria-pressed', String(x.dataset.mode === m)); } applyMode(); } }, m === 'all' ? 'Everything' : m === 'speaker' ? 'By speaker' : 'Skim: decisions, asks, hands')));
  function applyMode() {
    for (const el of body.querySelectorAll('[data-i]')) {
      const k = el.dataset.kind || (el.classList.contains('mtg-end') ? (el.classList.contains('mtg-catchup') ? 'catchup' : el.classList.contains('mtg-closed') ? 'close' : 'end') : el.classList.contains('msg-them-wrap') ? 'say' : '');
      el.hidden = mode === 'skim' && !SKIM.has(k);
      el.classList.toggle('mtg-collapsed', mode === 'speaker' && el.classList.contains('msg-them-wrap'));
    }
  }
  const tlHost = h('details', { class: 'mtg-timeline' }, h('summary', { class: 'caption' }, 'Timeline'), h('ol', { class: 'plain' }));
  tlHost.addEventListener('toggle', async () => {
    if (!tlHost.open) return;
    let d; try { d = await api('/meeting/timeline'); } catch (_) { return; }
    fill(tlHost.querySelector('ol'), (d.moments || []).map(m => h('li', {}, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-to': m.i, onclick: () => scrub(m.i) }, (m.at ? when(m.at, tz) + ' · ' : '') + ({ end: 'END', ruling: 'Ruling', close: 'Closed', resume: 'Resumed', agenda: 'Agenda', ask: 'Ask', call: 'Call', catchup: 'Catch-up', open: 'Opened' }[m.kind] || m.kind) + ': ' + m.text))));
  });
  async function scrub(i) {
    let el = body.querySelector('[data-i="' + i + '"]');
    if (!el) {   // not loaded yet: load from that moment on
      let d; try { d = await api('/meeting/entries?limit=200&from=' + i); } catch (_) { return; }
      more = d.more; cursor = d.cursor;
      fill(body, more ? earlierBtn : null, (d.entries || []).map(entryEl), liveArea);
      lastI = d.entries && d.entries.length ? d.entries[d.entries.length - 1].i : lastI;
      applyMode(); el = body.querySelector('[data-i="' + i + '"]');
    }
    if (el) { body.scrollTop = Math.max(0, el.offsetTop - body.offsetTop - 20); el.classList.add('mtg-flash'); setTimeout(() => el.classList.remove('mtg-flash'), 1600); }
  }
  let wasTurn = false; const baseTitle = document.title;
  function notifyTurn(L) {
    const now = !!(L && L.yourTurn);
    if (now && !wasTurn) {
      app.toast('Your turn: ' + (L.floorWhy || 'you have the floor') + '.');
      document.title = '● Your turn · ' + baseTitle;
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification('Your turn in the meeting', { body: L.floorWhy || 'You have the floor.' }); } catch (_) {}
    }
    if (!now && wasTurn) document.title = baseTitle;
    wasTurn = now;
  }
  const askNotify = () => { try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch (_) {} };
  // presence: the tab is visible and was used in the last 2 minutes (owner ruling): Next pacing applies while present
  let usedAt = Date.now();
  const used = () => { usedAt = Date.now(); };
  for (const evn of ['pointerdown', 'keydown', 'wheel', 'touchstart']) host.addEventListener(evn, used, { passive: true });
  const beat = () => { if (destroyed) return; const here = !document.hidden && Date.now() - usedAt < 120000; post('/meeting/presence', { here }).catch(() => {}); };
  const beatTimer = setInterval(beat, 20000);
  const onVis = () => { if (!document.hidden) used(); beat(); };
  document.addEventListener('visibilitychange', onVis);

  /* ---------- load and live updates ---------- */
  async function load() {
    try { v = await api('/meeting'); } catch (e) { fill(errHost, errLine(e, 'Meeting')); return null; }
    fill(errHost);
    fill(host.querySelector('.mtg-readbar'), modeBar, tlHost);
    beat();
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
  return { load, ta, destroy: () => { destroyed = true; if (S) { try { S.ctrl.abort(); } catch (_) {} S = null; } offLive(); offSeats(); document.removeEventListener('pointerdown', onOutside); clearInterval(beatTimer); document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis); document.title = baseTitle; }, _view: () => v };
}

/* one entry of a meeting (or of a live chat with colleagues in it) as the page shows it, the way the table printed it:
   a say under its speaker's name and colour with its tool steps as "· Name: …" lines; what happened between turns as one
   dim line ("(Phil passes)", "(Sharon raises a hand: …)"). ctx: { tz, noun, onExplain(e), onRegister(), lintNotice(e) } */
export function renderEntry(e, ctx) {
  ctx = ctx || {};
  const tz = ctx.tz, nm = n => personName(n) || n, noun = ctx.noun || 'meeting';
  const ev = (e, kind, text, extra) => h('p', { class: 'caption muted mtg-ev', 'data-kind': kind, 'data-i': e.i, title: e.at ? when(e.at, tz) : '' }, '(' + text + ')', extra || null);
  const who = e => nm(e.name);
  const toolLines = e => e.tools && e.tools.length ? h('div', { class: 'stack-2 mtg-tools' }, e.tools.map(x => h('p', { class: 'caption muted mtg-tool', 'data-tool': x.name || '' }, '· ' + nm(e.name) + ': ' + stepOf(x.name, x.args)))) : null;
  const t = e.at ? when(e.at, tz) : '';
  if (e.kind === 'say' && e.who === 'owner') return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end', 'data-i': e.i, 'data-kind': 'say' }, h('div', { class: 'msg-me' }, e.text), h('span', { class: 'msg-meta' }, 'You · ' + t));
  if (e.kind === 'say') {
    const meta = [t, e.model, e.explains ? 'explaining for the room' : null, e.src === 'chat' ? 'in the chat' : null].filter(Boolean).join(' · ');
    const ex = e.explains || !ctx.onExplain ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-explain', 'data-act': 'explain', 'data-i': null, 'aria-label': 'Ask ' + nm(e.name) + ' to explain this for the room, in plain words',
      onclick: async evt => { evt.currentTarget.disabled = true; await ctx.onExplain(e); } }, 'Explain for the room');
    const lead = e.to ? h('p', { class: 'caption muted mtg-ev mtg-ev-lead' }, '(' + nm(e.name) + ' answers ' + nm(e.toName) + ')') : e.interject ? h('p', { class: 'caption muted mtg-ev mtg-ev-lead' }, '(' + nm(e.name) + ' has the floor)') : null;
    return h('div', { class: 'stack-4 msg-them-wrap mtg-c' + colorOf(e.who), 'data-i': e.i, 'data-who': e.who, 'data-kind': 'say' }, lead, toolLines(e), h('span', { class: 'label strong mtg-who' }, nm(e.name)), mdBlock(e.text, 'msg-them'), e.lint && ctx.lintNotice ? ctx.lintNotice(e) : null, h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'msg-meta' }, meta), ex));
  }
  if (e.kind === 'pass') return e.tools && e.tools.length ? h('div', { class: 'stack-2 mtg-c' + colorOf(e.who), 'data-i': e.i, 'data-kind': 'pass', 'data-who': e.who }, toolLines(e), h('p', { class: 'caption muted mtg-ev', 'data-kind': 'pass' }, '(' + who(e) + ' passes)')) : ev(e, 'pass', who(e) + ' passes');
  if (e.kind === 'join') return ev(e, 'join', who(e) + ' joins' + (e.by ? ', invited by ' + nm(e.byName) : '') + (e.why ? ': ' + e.why : ''));
  if (e.kind === 'leave') return ev(e, 'leave', who(e) + ' leaves' + (e.by && e.by !== e.who ? ', dismissed by ' + nm(e.byName) : '') + (e.why ? ': ' + e.why : ''));
  if (e.kind === 'ask') return ev(e, 'ask', who(e) + ' asks ' + nm(e.toName) + ': ' + e.text);
  if (e.kind === 'hand') return ev(e, 'hand', who(e) + ' raises a hand' + (e.why ? ': ' + e.why : ''));
  if (e.kind === 'call') return ev(e, e.later ? 'later' : 'call', e.to === 'owner' ? who(e) + ' gives you the floor' : e.later ? who(e) + ' will take ' + nm(e.toName) + ' once the exchange is done' : who(e) + ' calls on ' + nm(e.toName));
  if (e.kind === 'lower') return ev(e, 'lower', who(e) + ' lowers ' + nm(e.toName) + '\'s hand');
  if (e.kind === 'end') return h('p', { class: 'mtg-ev mtg-ev-end body-s', 'data-kind': 'end', 'data-i': e.i, role: 'note', title: t }, h('strong', {}, '(' + who(e) + ' closes the discussion'), (e.text ? ': ' + e.text : '') + (e.plain ? ' — in plain words: ' + e.plain : '') + ')');
  if (e.kind === 'ruling') return ev(e, 'ruling', e.who === 'owner' ? 'You ruled: ' + e.text : who(e) + ' proposes a ruling for you to confirm: ' + e.text + (e.plain ? ' — in plain words: ' + e.plain : ''),
    e.who === 'owner' || !ctx.onRegister ? null : h('button', { type: 'button', class: 'btn btn-ghost btn-sm mtg-ev-btn', 'data-act': 'open-register', onclick: () => ctx.onRegister() }, 'Confirm in the register'));
  if (e.kind === 'register') return ev(e, 'register', who(e) + ' adds ' + ({ actions: 'an action', questions: 'an open question', kills: 'a kill condition' }[e.section] || 'a line') + ': ' + e.text + (e.date ? ' · by ' + e.date : '') + (e.plain ? ' — in plain words: ' + e.plain : '') + (e.affects ? ' · affects ' + e.affects : ''));
  if (e.kind === 'parse') return h('p', { class: 'caption mtg-ev mtg-parse', 'data-kind': 'parse', 'data-i': e.i, role: 'status' }, '(The console could not read ' + who(e) + '\'s line "' + e.line + '": ' + e.why + '. Nothing was done with it; ' + who(e) + ' is told on their next turn.)');
  if (e.kind === 'close') return h('div', { class: 'mtg-end mtg-closed', 'data-i': e.i, 'data-kind': 'close', role: 'note' }, h('span', { class: 'mtg-chip-k' }, e.state === 'interrupted' ? 'INTERRUPTED' : 'CLOSED'), h('span', { class: 'body-s' }, (e.line || '') + ' · ' + t));
  if (e.kind === 'catchup') return h('div', { class: 'mtg-end mtg-catchup', 'data-i': e.i, 'data-kind': 'catchup', role: 'note' }, h('span', { class: 'mtg-chip-k' }, 'FOR YOU'), h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, 'Catch-up by ' + nm(e.name) + ' (only you see this)'), mdBlock(e.text, 'body-s'), h('span', { class: 'caption muted' }, t)));
  if (e.kind === 'consent') return ev(e, 'consent', e.op === 'asked' ? who(e) + ' asks to use ' + (e.tool || 'a tool') + '; paused until you answer it on Today' : who(e) + ' · ' + (e.tool || 'a tool') + ': ' + (e.decision === 'once' ? 'allowed' : e.decision === 'deny' ? 'declined' : e.decision) + '; the meeting carries on',
    e.op === 'asked' ? h('a', { href: '#/today', class: 'mtg-ev-btn' }, ' Answer it on Today') : null);
  if (e.kind === 'open') return h('p', { class: 'caption muted mtg-line', 'data-i': e.i, 'data-kind': 'open' }, 'The ' + noun + ' opened · ' + t);
  return h('p', { class: 'caption muted mtg-line', 'data-i': e.i, 'data-kind': e.kind }, (e.line || e.text || '') + (t ? ' · ' + t : ''));
}
