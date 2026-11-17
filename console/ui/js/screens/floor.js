// Crew › Floor (#/crew/floor, was #/floor; Floor.dc.html): the station's rooms and who sits at which desk, read from
// the station's save (GET /api/station/save → save.station). A headless station has no floor plan: floorOf() is null
// and the Crew screen does not show the tab at all.
import { h, fill, Tag, errLine, empty, initial, Details } from '../ui.js';
import { api } from '../api.js';
import { mountPanels } from '../panels.js';

const list = x => Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [];
const KIND = { hab: 'Living space', bridge: 'Bridge', lab: 'Lab', factory: 'Workshop', quarters: 'Quarters', storage: 'Storage' };

// the floor plan, or null when the station reports none (headless, or not running)
export async function floorOf() {
  try {
    const d = await api('/station/save');
    const st = d && (d.save ? d.save.station : d.station);
    const rooms = list(st && st.rooms);
    return rooms.length ? { rooms, props: list(st.props) } : null;
  } catch (_) { return null; }
}

export async function renderTab(root, ctx) {
  const { app } = ctx;
  const plan = h('section', { 'aria-label': 'Floor plan', class: 'floor-plan' });
  const side = h('div', { class: 'stack-16' });
  fill(root, h('p', { class: 'body-l muted', style: 'max-width:640px' }, 'The rooms of the station and who sits where. A lit desk is someone working right now.'), plan, side);
  const [f, crew, now] = await Promise.all([floorOf(), api('/crew').catch(e => ({ error: e })), api('/now').catch(() => null)]);
  if (!f) { fill(plan, empty('This station has no floor plan.')); return () => {}; }
  const seats = (crew && crew.seats) || [];
  const busy = new Set(((now && now.runs) || []).map(r => r.agentId));
  const nameOf = id => (seats.find(s => s.id === id) || {}).name || null;
  const desks = f.props.filter(p => p.t === 'desk' || p.type === 'desk');
  const inRoom = (p, r) => list(r.rects).some(q => p.x >= q.x1 && p.x <= q.x2 && p.y >= q.y1 && p.y <= q.y2);
  const placed = new Set();
  const rooms = f.rooms.map(r => {
    const mine = desks.filter(d => !placed.has(d) && inRoom(d, r)); mine.forEach(d => placed.add(d));
    return { r, desks: mine };
  });
  const loose = desks.filter(d => !placed.has(d));
  const desk = d => {
    const who = d.agentId ? nameOf(d.agentId) || 'Someone not on the crew' : null;
    return h('div', { class: 'desk' },
      h('span', { class: 'avatar ' + (d.agentId && busy.has(d.agentId) ? 'dot-w' : 'dot-i'), 'aria-hidden': 'true' }, who ? initial(who) : '·'),
      h('span', { class: 'caption strong', style: 'text-align:center' }, who || 'Free desk'));
  };
  fill(plan, h('div', { class: 'rooms' }, rooms.map(({ r, desks: ds }) => h('div', { class: 'room' },
    h('div', { class: 'between-c' }, h('span', { class: 'eyebrow-t' }, r.name || 'Room'), h('span', { class: 'caption muted' }, KIND[r.kind] || '')),
    ds.length ? h('div', { class: 'row-8', style: 'gap:10px;margin-top:auto' }, ds.map(desk)) : h('span', { class: 'caption muted', style: 'margin-top:auto' }, 'No desks'))),
    loose.length ? h('div', { class: 'room' }, h('span', { class: 'eyebrow-t' }, 'Between rooms'), h('div', { class: 'row-8', style: 'gap:10px;margin-top:auto' }, loose.map(desk))) : null),
    h('div', { class: 'row-8', style: 'margin-top:16px;align-items:center' },
      Tag(desks.filter(d => d.agentId).length + ' of ' + desks.length + ' desks taken', { variant: 'soft' }),
      busy.size ? Tag(busy.size + ' working now', { variant: 'status', status: 'online' }) : null),
    crew && crew.error ? errLine(crew.error, 'Crew') : null,
    Details('Details', h('dl', { class: 'kv' }, rooms.map(({ r, desks: ds }) => [h('dt', null, r.name || r.id), h('dd', { class: 'mono-s' }, r.id + ' · ' + (r.kind || '?') + ' · ' + ds.map(d => d.id + (d.agentId ? '=' + d.agentId : '')).join(', '))]))));
  return mountPanels(side, 'side:floor', app);
}
