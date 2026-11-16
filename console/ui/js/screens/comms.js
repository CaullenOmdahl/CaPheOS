// Comms (Comms.dc.html): conversations (owner channel, each seat via the station, group chats), chat, delete a group.
import { h, fill, Button, errLine, empty, rel, hhmm } from '../ui.js';
import { api, post, stream } from '../api.js';
import * as events from '../events.js';

export async function render(root, ctx) {
  const { app, mainEl } = ctx;
  // Comms uses its own two-column layout instead of the padded main column
  root.className = 'comms'; root.removeAttribute('style');
  const sel = ctx.rest[0] || 'owner';
  const draft = ctx.query.get('draft') || '';
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
  let runId = null, ctrl = null, history = [];
  const stopBtn = Button('Stop run', { variant: 'secondary', size: 'sm', disabled: true, onClick: async () => {
    if (runId) { try { await post('/station/cancel', { runId }); } catch (e) { app.toast(e.message, true); } }
    if (ctrl) ctrl.abort();
  } });
  const steerBtn = Button('Steer', { variant: 'secondary', size: 'sm', disabled: true, onClick: async () => {
    const text = ta.value.trim(); if (!runId || !text) return app.toast('Write the steer in the box, then press Steer while the run is going.', true);
    try { await post('/station/run/steer', { runId, text }); ta.value = ''; app.toast('Steer sent.'); } catch (e) { app.toast(e.message, true); }
  } });

  let title = 'Owner channel', sub = 'company/owner/inbound.jsonl and outbound.jsonl', placeholder = 'Write to the company…', actions = [];
  if (kind === 'agent') {
    const s = seats.find(x => x.id === cid) || { name: cid };
    title = s.name || cid; placeholder = 'Write to ' + title + '…';
    sub = [s.title, s.station && s.station.model].filter(Boolean).join(' · ') || 'Through the station';
    actions = [steerBtn, stopBtn, Button('Transcript', { variant: 'ghost', size: 'sm', onClick: () => loadThread() })];
  } else if (kind === 'group') {
    const g = groups.find(x => x.id === cid) || {};
    title = g.title || 'Group chat'; sub = (g.members || []).join(', ') || 'Group chat'; placeholder = 'Write to the group…';
    actions = [h('button', { type: 'button', class: 'btn btn-outline-danger btn-sm', onclick: askDelete }, 'Delete chat')];
  }
  const headTitle = h('h1', { class: 'h3' }, title), headSub = h('span', { class: 'caption muted' }, sub);
  fill(chat,
    h('header', { class: 'chat-head' }, h('div', { class: 'stack-4' }, headTitle, headSub), h('div', { class: 'row-8' }, actions)),
    confirmHost, bodyErr, body,
    h('form', { 'aria-label': 'Message', class: 'composer', onsubmit: e => { e.preventDefault(); send(); } },
      h('label', { for: 'msg', class: 'caption muted' }, kind === 'owner' ? 'Message to the company (the CEO reads and routes it; start with a name to address someone)' : 'Message'),
      (ta.placeholder = placeholder, ta),
      h('div', { class: 'between-c', style: 'flex-wrap:wrap' }, sendErr, Button('Send', { variant: 'primary', type: 'submit' }))));
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });

  function bubble(role, text, meta) {
    const el = role === 'me' ? h('div', { class: 'msg-me' }, text) : h('div', { class: 'stack-4' }, h('div', { class: 'msg-them' }, text), meta ? h('span', { class: 'msg-meta' }, meta) : null);
    return el;
  }
  function scrollEnd() { const last = body.lastElementChild; if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' }); }

  async function loadThread() {
    fill(bodyErr);
    try {
      if (kind === 'owner') {
        const d = await api('/owner/messages');
        const msgs = d.messages || [];
        fill(body, msgs.length ? msgs.slice(-200).map(m => m.dir === 'in'
          ? h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me' }, m.text), h('span', { class: 'msg-meta' }, (m.from || 'You') + ' · ' + hhmm(m.at, tz) + (m.acked ? ' · read' : '')))
          : bubble('them', m.text || m.body || '', (m.from || 'Company') + ' · ' + hhmm(m.at, tz))) : empty('No messages yet. Write below to reach the company.'));
      } else if (kind === 'agent') {
        const d = await api('/station/transcript?agent=' + encodeURIComponent(cid) + '&stream=' + encodeURIComponent('console-' + cid) + '&limit=200');
        const turns = (d.turns || []).filter(t => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim());
        history = turns.map(t => ({ role: t.role, content: t.content }));
        fill(body, turns.length ? turns.map(t => bubble(t.role === 'user' ? 'me' : 'them', t.content)) : empty('No messages in this console session yet.'));
      } else if (kind === 'group') {
        const d = await api('/station/groups?id=' + encodeURIComponent(cid));
        const g = d.result || d;
        const msgs = g.messages || [];
        fill(body, msgs.length ? msgs.map(m => m.author === 'owner' || m.author === 'user' || m.author === 'you' ? bubble('me', m.content) : bubble('them', String(m.content || ''), (m.author || '') + (m.at ? ' · ' + hhmm(m.at, tz) : ''))) : empty('No messages in this group yet.'));
      }
      scrollEnd();
    } catch (e) { fill(body); fill(bodyErr, errLine(e, 'Conversation')); }
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
    // agent: POST /api/station/run streams NDJSON {name, payload}
    const emptyEl = body.querySelector('.empty'); if (emptyEl) emptyEl.remove();
    body.appendChild(bubble('me', text)); ta.value = '';
    const out = h('div', { class: 'msg-them' }, ''); const meta = h('span', { class: 'msg-meta' }, 'Thinking…');
    body.appendChild(h('div', { class: 'stack-4' }, out, meta)); scrollEnd();
    const messages = history.slice(-40).concat([{ role: 'user', content: text }]);
    ctrl = new AbortController(); stopBtn.disabled = false; steerBtn.disabled = false;
    try {
      const full = await stream('/station/run', { agentId: cid, messages, streamId: 'console-' + cid }, (delta, ev) => {
        if (delta) { out.textContent += delta; meta.textContent = 'Writing…'; }
        if (ev && ev.payload && ev.payload.runId && !runId) runId = ev.payload.runId;
        if (ev && ev.name === 'agent.tool_call') meta.textContent = 'Using a tool…';
        if (ev && ev.name === 'agent.run.error') meta.textContent = 'Error: ' + (ev.payload.message || 'run failed');
        if (ev && ev.name === 'agent.run.end') meta.textContent = 'Done' + (ev.payload.usd ? ' · $' + Number(ev.payload.usd).toFixed(3) : '');
      }, ctrl.signal);
      history = messages.concat([{ role: 'assistant', content: full }]);
      if (meta.textContent === 'Thinking…' || meta.textContent === 'Writing…') meta.textContent = 'Done';
    } catch (e) {
      meta.textContent = e.name === 'AbortError' ? 'Stopped.' : e.stationDown ? 'Station not running.' : 'Failed: ' + e.message;
      meta.classList.add('danger');
    } finally { runId = null; ctrl = null; stopBtn.disabled = true; steerBtn.disabled = true; scrollEnd(); }
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
  if (kind === 'agent') { const s = seats.find(x => x.id === cid); if (s) { headTitle.textContent = s.name || cid; headSub.textContent = [s.title, s.station && s.station.model].filter(Boolean).join(' · ') || 'Through the station'; ta.placeholder = 'Write to ' + (s.name || cid) + '…'; } }
  if (kind === 'group') { const g = groups.find(x => x.id === cid); if (g) { headTitle.textContent = g.title || 'Group chat'; headSub.textContent = (g.members || []).join(', '); } }
  loadThread();
  if (draft) ta.focus();
  const off = events.on(['owner', 'crew'], t => { if ((t === 'owner' || t === '*') && kind === 'owner') loadThread(); if (t === 'crew' || t === '*') loadList(); });
  return () => { off(); if (ctrl) ctrl.abort(); };
}
