// Comms (Comms.dc.html): conversations (owner channel, each seat via the station, group chats), chat, delete a group.
// A seat's conversation is a LIVE chat (js/chat.js): the reply streams in. The owner channel is asynchronous: every
// message shows what it is waiting on (docs/CONSOLE-API.md "Owner channel"), then "read", then the reply under it.
// Deep links: #/comms/<seat id> or agent:<seat id>; ?brief=charter sends the charter brief once; a message Today handed
// over (sessionStorage capheos.chatSend) is sent on arrival.
import { h, fill, Button, errLine, empty, rel, hhmm, Tag } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { liveChat } from '../chat.js';
import { mdBlock } from '../md.js';

const ss = { get: k => { try { return sessionStorage.getItem(k); } catch (_) { return null; } }, del: k => { try { sessionStorage.removeItem(k); } catch (_) {} } };

export async function render(root, ctx) {
  const { app, mainEl } = ctx;
  // Comms uses its own two-column layout instead of the padded main column
  root.className = 'comms'; root.removeAttribute('style');
  let sel = ctx.rest[0] || 'owner';
  if (sel !== 'owner' && !sel.includes(':')) sel = 'agent:' + sel;   // #/comms/<seat id>
  const draft = ctx.query.get('draft') || '';
  const briefKind = ctx.query.get('brief') || '';
  const tz = app.company && app.company.timezone;

  const listHost = h('div', { class: 'stack-4' });
  const listErr = h('div');
  const aside = h('aside', { 'aria-label': 'Conversations', class: 'conv-list' },
    h('div', { class: 'seg' }, h('a', { href: '#/comms', class: 'on' }, 'Sessions'), h('a', { href: '#/work/projects' }, 'Projects')),
    listErr, listHost,
    h('div', { class: 'row-8' }, Button('New group chat', { variant: 'secondary', size: 'sm', onClick: newGroup })));
  const chat = h('section', { class: 'chat', 'aria-label': 'Chat' });
  fill(root, aside, chat);

  let seats = [], groups = [];
  async function loadList() {
    fill(listErr);
    const rows = [];
    try { const c = await api('/crew'); seats = c.seats || []; } catch (e) { listErr.appendChild(errLine(e, 'Crew')); }
    try { const g = await api('/station/groups'); groups = ((g.result || g).groups || []); } catch (e) { groups = []; listErr.appendChild(errLine(e, 'Group chats')); }
    rows.push(['owner', 'Owner channel', '', 'You and the company']);
    for (const s of seats) rows.push(['agent:' + s.id, s.name || s.id, '', s.title || '']);
    for (const g of groups) rows.push(['group:' + g.id, g.title || 'Group chat', g.updatedAt ? rel(g.updatedAt) : '', (g.members || []).length + ' members' + (g.busy ? ' · busy' : '')]);
    fill(listHost, rows.map(([id, w, at, last]) => h('a', { href: '#/comms/' + encodeURIComponent(id), class: 'thread', 'aria-current': id === sel ? 'page' : 'false' },
      h('span', { class: 'between-c' }, h('span', { class: 'label strong' }, w), h('span', { class: 'mono-s muted' }, at)),
      h('span', { class: 'body-s muted' }, last))));
  }

  async function newGroup() {
    if (!seats.length) return app.toast('No crew to add.', true);
    const members = seats.map(s => s.id);
    try { const r = await post('/station/groups', { op: 'create', members, title: 'Crew group' }); app.toast('Group created.'); loadList(); const id = (r.result || r).id || ((r.result || r).group || {}).id; if (id) location.hash = '#/comms/group:' + encodeURIComponent(id); }
    catch (e) { app.toast(e.stationDown ? 'Station not running.' : 'Could not create: ' + e.message, true); }
  }

  /* ---------- chat pane ---------- */
  const [kind, ...idParts] = sel.split(':'); const cid = idParts.join(':');
  const body = h('div', { class: 'chat-body', 'aria-live': 'polite' });
  const bodyErr = h('div', { style: 'padding:0 32px' });
  const confirmHost = h('div');
  const ta = h('textarea', { id: 'msg', rows: '3', class: 'textarea' });
  ta.value = draft;
  const sendErr = h('p', { class: 'err-line', role: 'status' });
  let live = null;
  const chanEl = h('div', { style: 'padding:0 32px' });

  let title = 'Owner channel', sub = 'company/owner/inbound.jsonl and outbound.jsonl', placeholder = 'Write to the company…', actions = [];
  if (kind === 'agent') {
    const s = seats.find(x => x.id === cid) || { name: cid };
    title = s.name || cid; placeholder = 'Write to ' + title + '…';
    sub = s.title || 'Live chat';
    actions = [Button('Reload', { variant: 'ghost', size: 'sm', onClick: () => live && live.load() })];
  } else if (kind === 'group') {
    const g = groups.find(x => x.id === cid) || {};
    title = g.title || 'Group chat'; sub = (g.members || []).join(', ') || 'Group chat'; placeholder = 'Write to the group…';
    actions = [h('button', { type: 'button', class: 'btn btn-outline-danger btn-sm', onclick: askDelete }, 'Delete chat')];
  }
  const headTitle = h('h1', { class: 'h3' }, title), headSub = h('span', { class: 'caption muted' }, sub);
  const charterStrip = h('div');
  const liveHost = h('div', { class: 'chat-live' });
  if (kind === 'agent') {
    fill(chat, h('header', { class: 'chat-head' }, h('div', { class: 'stack-4' }, headTitle, headSub), h('div', { class: 'row-8' }, actions)), charterStrip, liveHost);
    live = liveChat(liveHost, { agentId: cid, app, tz, onUpdate: inf => { headSub.textContent = [inf.agent.title, inf.provider ? inf.provider + ' · ' + inf.model : null].filter(Boolean).join(' · ') || 'Live chat'; } });
    if (draft) live.ta.value = draft;
  } else {
    fill(chat,
      h('header', { class: 'chat-head' }, h('div', { class: 'stack-4' }, headTitle, headSub), h('div', { class: 'row-8' }, actions)),
      confirmHost, chanEl, bodyErr, body,
      h('form', { 'aria-label': 'Message', class: 'composer', onsubmit: e => { e.preventDefault(); send(); } },
        h('label', { for: 'msg', class: 'caption muted' }, kind === 'owner' ? 'Message to the company for when you are away (the CEO reads it on its next check). To talk now, open a crew member on the left.' : 'Message'),
        (ta.placeholder = placeholder, ta),
        h('div', { class: 'between-c', style: 'flex-wrap:wrap' }, sendErr, Button('Send', { variant: 'primary', type: 'submit' }))));
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  }
  // the charter brief: a strip that says how far the charter is, flipping to done when the file has no blanks
  async function drawCharterStrip() {
    if (briefKind !== 'charter' && !charterStrip.dataset.on) return;
    charterStrip.dataset.on = '1';
    try {
      const c = await api('/setup/charter');
      const n = (c.placeholders || []).length;
      fill(charterStrip, h('div', { class: 'charter-strip ' + (n ? 'needs' : 'done'), role: 'status' },
        h('span', { class: 'row-8', style: 'align-items:center' }, Tag(n ? 'Charter: ' + n + ' blank' + (n > 1 ? 's' : '') + ' left' : 'Charter done', { variant: 'status', status: n ? 'warning' : 'online' }),
          h('span', { class: 'body-s' }, n ? 'The Founder asks a few questions, then writes company/CHARTER.md. This turns green by itself.' : 'company/CHARTER.md has no blanks left.')),
        h('a', { href: '#/setup/charter', class: 'btn btn-secondary btn-sm' }, n ? 'Back to Setup' : 'Review it in Setup')));
    } catch (_) {}
  }

  function bubble(role, text, meta) {
    const el = role === 'me' ? h('div', { class: 'msg-me' }, text) : h('div', { class: 'stack-4' }, mdBlock(text, 'msg-them'), meta ? h('span', { class: 'msg-meta' }, meta) : null);
    return el;
  }
  function scrollEnd() { const last = body.lastElementChild; if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' }); }

  async function loadThread() {
    fill(bodyErr);
    try {
      if (kind === 'owner') {
        const d = await api('/owner/messages');
        drawOwner(d);
      } else if (kind === 'group') {
        const d = await api('/station/groups?id=' + encodeURIComponent(cid));
        const g = d.result || d;
        const msgs = g.messages || [];
        fill(body, msgs.length ? msgs.map(m => m.author === 'owner' || m.author === 'user' || m.author === 'you' ? bubble('me', m.content) : bubble('them', String(m.content || ''), (m.author || '') + (m.at ? ' · ' + hhmm(m.at, tz) : ''))) : empty('No messages in this group yet.'));
      }
      scrollEnd();
    } catch (e) { fill(body); fill(bodyErr, errLine(e, 'Conversation')); }
  }

  // the owner channel: each message with its state, the replies that name it threaded under it
  const STATE_TAG = { waiting: ['Waiting', 'warning'], working: ['Being read', 'online'], read: ['Read', 'neutral'], answered: ['Answered', 'online'], stuck: ['Nobody will pick this up', 'danger'] };
  function drawOwner(d) {
    const msgs = (d.messages || []).slice(-200);
    const ch = d.channel || {};
    const ceoId = (ch.ceo && ch.ceo.id) || (app.company && app.company.ceo && app.company.ceo.id) || 'agent';
    fill(chanEl, ch.problems && ch.problems.length ? h('div', { class: 'alertbox', role: 'alert', style: 'margin-top:16px' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, 'Messages here are not being picked up: ' + ch.problems[0].msg + '.'),
        h('span', { class: 'body-s' }, 'Fix: ' + ch.problems[0].fix), ch.problems.length > 1 ? h('span', { class: 'caption muted' }, 'Also: ' + ch.problems.slice(1).map(p => p.msg).join('; ') + '.') : null),
      h('div', { class: 'row-8' }, ch.problems[0].link ? h('a', { href: ch.problems[0].link, class: 'btn btn-secondary btn-sm' }, 'Fix it') : null, h('a', { href: '#/comms/agent:' + ceoId, class: 'btn btn-primary btn-sm' }, 'Talk to ' + ((ch.ceo && ch.ceo.name) || 'the Founder') + ' live'))) : null);
    const threaded = new Set();
    const byId = {}; for (const m of msgs) byId[m.id] = m;
    for (const m of msgs) if (m.dir === 'in' && m.state && m.state.replies) for (const r of m.state.replies) threaded.add(r);
    const reply = m => h('div', { class: 'stack-4 msg-them-wrap' }, mdBlock(m.text || m.body || '', 'msg-them'), h('span', { class: 'msg-meta' }, (m.from || 'Company') + ' · ' + hhmm(m.at, tz)));
    const rows = [];
    for (const m of msgs) {
      if (m.dir === 'out') { if (!threaded.has(m.id)) rows.push(reply(m)); continue; }
      const st = m.state || { status: m.acked ? 'read' : 'waiting', text: m.acked ? 'read' : 'waiting' };
      const [label, tone] = STATE_TAG[st.status] || STATE_TAG.waiting;
      rows.push(h('div', { class: 'stack-6 owner-msg', 'data-state': st.status, style: 'align-self:flex-end;align-items:flex-end' },
        h('div', { class: 'msg-me' }, m.text),
        h('span', { class: 'row-8 msg-meta', style: 'align-items:center;justify-content:flex-end;flex-wrap:wrap' }, (m.from || 'You') + ' · ' + hhmm(m.at, tz), Tag(label, { variant: 'status', status: tone })),
        h('span', { class: 'caption ' + (st.status === 'stuck' ? 'danger' : 'muted'), style: 'text-align:right;max-width:520px' }, st.text + (st.fix ? '. Fix: ' + st.fix : '')),
        st.status === 'stuck' && st.link ? h('a', { href: st.link, class: 'caption' }, 'Fix it →') : null));
      for (const rid of (st.replies || [])) if (byId[rid]) rows.push(h('div', { class: 'thread-reply' }, reply(byId[rid])));
    }
    fill(body, rows.length ? rows : empty('No messages yet. Write below; the company reads it on its next check. To talk now, open a crew member on the left.'));
    scrollEnd();
  }

  async function send() {
    const text = ta.value.trim(); if (!text) return;
    sendErr.textContent = '';
    if (kind === 'owner') {
      try { await post('/owner/messages', { text }); ta.value = ''; loadThread(); } catch (e) { sendErr.textContent = 'Not sent: ' + e.message; }
      return;
    }
    if (kind === 'group') {
      try { await post('/station/groups', { op: 'send', id: cid, key: 'console-' + Date.now().toString(36), text }); ta.value = ''; loadThread(); }
      catch (e) { sendErr.textContent = e.stationDown ? 'Station not running.' : 'Not sent: ' + e.message; }
      return;
    }
  }

  function askDelete() {
    const t = 'Delete this chat for everyone?';
    const keep = h('button', { type: 'button', class: 'btn btn-paper', onclick: () => fill(confirmHost) }, 'Keep');
    const del = h('button', { type: 'button', class: 'btn btn-danger btn-md', onclick: async () => {
      del.disabled = true;
      try { await post('/station/groups', { op: 'control', id: cid, action: 'delete' }); app.toast('Chat deleted.'); location.hash = '#/comms'; }
      catch (e) { del.disabled = false; fill(confirmHost.querySelector('.err-slot') || confirmHost, errLine(e, 'Delete failed')); }
    } }, 'Delete');
    fill(confirmHost, h('div', { role: 'alertdialog', 'aria-labelledby': 'del-title', 'aria-describedby': 'del-desc', class: 'alertbox', style: 'margin:20px 32px 0' },
      h('div', { class: 'stack-4', style: 'max-width:520px' }, h('span', { id: 'del-title', class: 'label' }, t),
        h('span', { id: 'del-desc', class: 'body-s' }, 'Running turns stop and the messages go. Files and decisions it produced stay where they were saved.'),
        h('div', { class: 'err-slot' })),
      h('div', { class: 'row-8' }, keep, del)));
    keep.focus();
  }

  await loadList();
  // header text may improve once the list is known
  if (kind === 'agent') { const s = seats.find(x => x.id === cid); if (s) headTitle.textContent = s.name || cid; }
  if (kind === 'group') { const g = groups.find(x => x.id === cid); if (g) { headTitle.textContent = g.title || 'Group chat'; headSub.textContent = (g.members || []).join(', '); } }
  if (kind === 'agent') {
    await live.load();
    drawCharterStrip();
    // hand-offs from other screens, sent once: the charter brief (Setup), a message typed on Today
    let pending = null; try { pending = JSON.parse(ss.get('capheos.chatSend') || 'null'); } catch (_) {}
    if (pending && pending.agentId === cid && pending.text) { ss.del('capheos.chatSend'); live.send(pending.text); }
    else if (briefKind) {
      let notes = {}; try { notes = JSON.parse(ss.get('capheos.briefNotes') || '{}') || {}; } catch (_) {}
      ss.del('capheos.briefNotes');
      history.replaceState(null, '', '#/comms/agent:' + encodeURIComponent(cid));
      if (briefKind === 'charter-change') { live.ta.value = 'Please change the charter: '; live.ta.focus(); }
      else live.sendBrief(briefKind, notes);
    } else if (draft) live.ta.focus();
  } else { loadThread(); if (draft) ta.focus(); }
  const off = events.on(['owner', 'crew', 'charter', 'dispatch'], t => {
    if ((t === 'owner' || t === 'dispatch' || t === '*') && kind === 'owner') loadThread();
    if (t === 'crew' || t === '*') loadList();
    if (t === 'charter' || t === '*') drawCharterStrip();
  });
  return () => { off(); if (live) live.destroy(); };
}
