// Floor (Floor.dc.html): rooms with desks. Seats come from /api/crew; room layout is not exposed by an endpoint yet.
import { h, fill, Tag, errLine, empty, screenHead, initial, NOT_CONNECTED } from '../ui.js';
import { api } from '../api.js';
import { mountPanels } from '../panels.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-32';
  const plan = h('section', { 'aria-label': 'Floor plan', class: 'floor-plan', style: 'flex:3 1 560px;min-width:0' });
  const aside = h('aside', { 'aria-label': 'Floor details', class: 'stack-20', style: 'flex:1 1 260px' });
  const head = h('div'); const side = h('div', { class: 'stack-16' });
  fill(root, head, h('div', { style: 'display:flex;flex-wrap:wrap;gap:24px' }, plan, aside), side);
  let seats = [], err = null, live = null;
  try { const d = await api('/crew'); seats = d.seats || []; } catch (e) { err = e; }
  try { live = await api('/station/state/snapshot'); } catch (_) {}
  fill(head, screenHead({ eyebrow: [seats.length + ' seated', live ? (asLen(live.runs)) + ' runs live' : null], title: 'Floor.' }));
  // group by function into "rooms": the station room layout endpoint is not connected yet
  const room = (name, kind, desks) => h('div', { class: 'room' },
    h('div', { class: 'between-c' }, h('span', { class: 'eyebrow-t' }, name), h('span', { class: 'mono-s subtle' }, kind)),
    h('div', { class: 'row-8', style: 'gap:10px;margin-top:auto' }, desks.map(s => h('div', { class: 'desk' },
      h('span', { class: 'avatar ' + (s.station && (s.station.busy || /work|run/i.test(s.station.status || '')) ? 'dot-w' : 'dot-i'), 'aria-hidden': 'true' }, initial(s.name)),
      h('span', { class: 'caption strong', style: 'text-align:center' }, s.name || s.id)))));
  fill(plan, err ? errLine(err, 'Crew') : seats.length ? h('div', { class: 'rooms' }, seats.map(s => room((s.functions || [])[0] ? String(s.functions[0]).toUpperCase() : 'Desk', s.title || 'seat', [s])))
    : empty('No seats yet.'));
  fill(aside,
    h('div', { class: 'card p20', style: 'gap:10px' }, h('h2', { class: 'h4' }, 'Room layout'), h('span', { class: 'body-s muted' }, 'Rooms, desks and props from the station floor: ' + NOT_CONNECTED + ' Seats are grouped by their first function for now.')),
    h('div', { class: 'card p20', style: 'gap:10px' }, h('h2', { class: 'h4' }, 'Floor audit'), Tag('Not run here', { variant: 'status', status: 'neutral' }), h('span', { class: 'caption muted' }, 'station-floor.js audit: ' + NOT_CONNECTED)),
    h('div', { class: 'card p20', style: 'gap:10px' }, h('h2', { class: 'h4' }, 'Live runs'),
      live ? h('span', { class: 'body-s strong' }, asLen(live.runs) + ' runs, ' + asLen(live.queues) + ' queues') : h('span', { class: 'body-s muted' }, 'Station not running.'),
      h('a', { href: '#/automate', class: 'body-s' }, 'Automate →')));
  const stopPanels = mountPanels(side, 'side:floor', app);
  return () => stopPanels();
}
function asLen(x) { return Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0; }
