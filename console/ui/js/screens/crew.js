// Crew (#/crew): People (who holds each function, the seats, one seat's dossier), Hiring and, when the station has a
// floor plan, Floor. Routes: #/crew, #/crew/<seat id>[/model], #/crew/hiring, #/crew/floor.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, initial, statusOf, Details } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { modelPanel } from './crew-model.js';
import * as hiring from './hiring.js';
import * as floor from './floor.js';

const FUNCS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const FN_LABEL = { ceo: 'CEO', people: 'People', tools: 'Tools', risk: 'Risk', floor: 'Floor', finance: 'Finance' };

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-32';
  const first = ctx.rest[0] || '';
  let tab = first === 'hiring' ? 'hiring' : first === 'floor' ? 'floor' : 'people';
  const head = h('div'), tabsHost = h('div'), body = h('div', { class: 'stack-32' });
  fill(root, head, tabsHost, body);
  let hasFloor = tab === 'floor';   // the Floor tab shows only when the station reports a floor plan
  let openRounds = null, seatsN = null;
  const drawHead = () => fill(head, screenHead({ eyebrow: [seatsN != null ? seatsN + (seatsN === 1 ? ' seat' : ' seats') : null, openRounds ? openRounds + (openRounds === 1 ? ' role open' : ' roles open') : null], title: 'Crew.' }));
  const drawTabs = () => fill(tabsHost, tabs([['people', 'People', seatsN], ['hiring', 'Hiring', openRounds || null]].concat(hasFloor ? [['floor', 'Floor']] : []), tab, pick, 'Crew'));
  let stop = null;
  function pick(id) {
    tab = id; history.replaceState(null, '', '#/crew' + (id === 'people' ? '' : '/' + id));
    drawTabs(); show();
  }
  function show() {
    if (stop) { try { stop(); } catch (_) {} stop = null; }
    const host = h('div', { class: 'stack-32' }); fill(body, host);
    const sub = Object.assign({}, ctx, { rest: tab === 'people' ? ctx.rest.filter(x => x !== 'hiring' && x !== 'floor') : [] });
    const r = tab === 'hiring' ? hiring.renderTab(host, sub) : tab === 'floor' ? floor.renderTab(host, sub) : people(host, sub);
    Promise.resolve(r).then(fn => { if (typeof fn === 'function') { if (host.isConnected) stop = fn; else fn(); } });
  }
  drawHead(); drawTabs(); show();
  floor.floorOf().then(f => { if (!!f !== hasFloor) { hasFloor = !!f; if (!hasFloor && tab === 'floor') pick('people'); else drawTabs(); } });
  const counts = () => {
    api('/hiring').then(d => { openRounds = (d.rounds || []).filter(r => !r.hired && r.status !== 'closed' && !r.closed).length; drawHead(); drawTabs(); }).catch(() => {});
    api('/crew').then(d => { seatsN = (d.seats || []).length; drawHead(); drawTabs(); }).catch(() => {});
  };
  counts();
  const off = events.on(['crew'], counts);
  return () => { off(); if (stop) stop(); };
}

/* ---------- People ---------- */
function people(root, ctx) {
  const { app } = ctx;
  let selId = ctx.rest[0] || null, tab = ctx.rest[1] === 'model' ? 'model' : 'brief';
  const fnHost = h('div'), listHost = h('div', { style: 'flex:1 1 320px;display:flex;flex-direction:column;border-top:1px solid var(--border-hairline)' }),
    dossier = h('article', { 'aria-labelledby': 'dossier', class: 'card p28', style: 'flex:2 1 480px;min-width:0;gap:24px' }), errEl = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, errEl,
    h('section', { 'aria-labelledby': 'fn', class: 'stack-16' }, h('h2', { id: 'fn', class: 'h4' }, 'Who holds each function'), fnHost),
    h('section', { style: 'display:flex;flex-wrap:wrap;gap:32px' }, listHost, dossier), side);
  let data = null, modelView = null;

  async function load() {
    try { data = await api('/crew'); fill(errEl, data.station === 'down' ? h('p', { class: 'err-line' }, 'The station is not running, so live status is unavailable.') : null); }
    catch (e) { fill(errEl, errLine(e, 'Crew')); data = { seats: [] }; }
    const seats = data.seats || [];
    let now = null; try { now = await api('/now'); } catch (_) {}
    fill(fnHost, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px' }, FUNCS.map(fn => {
      const holder = seats.find(s => (s.functions || []).includes(fn));
      return h('div', { class: 'card', style: 'gap:6px;padding:16px' }, h('span', { class: 'eyebrow-t' }, FN_LABEL[fn]),
        h('span', { class: 'label strong' }, holder ? holder.name || holder.id : 'Nobody'), h('span', { class: 'caption muted' }, holder ? (holder.manager ? 'reports to ' + nameOf(seats, holder.manager) : 'talks to you') : 'unfilled: hire for it in Hiring'));
    })));
    if (!seats.length) { fill(listHost, empty('No crew yet. The Founder opens the first roles once the charter is written.')); fill(dossier); dossier.hidden = true; return; }
    dossier.hidden = false;
    if (!selId || !seats.some(s => s.id === selId)) selId = seats[0].id;
    fill(listHost, seats.map(s => {
      const st = s.station || {}; const run = now && (now.runs || []).find(r => r.agentId === s.id); const nx = now && (now.seats || []).find(x => x.id === s.id);
      const state = run ? 'Working' : st.status || st.state || (data.station === 'down' ? 'Unknown' : 'Idle');
      return h('button', { type: 'button', class: 'crew-item', 'aria-current': s.id === selId ? 'true' : 'false', onclick: () => { selId = s.id; history.replaceState(null, '', '#/crew/' + encodeURIComponent(s.id) + (tab === 'model' ? '/model' : '')); load(); } },
        h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initial(s.name)),
        h('span', { class: 'stack-4', style: 'gap:3px;min-width:0' }, h('span', { class: 'label strong' }, s.name || s.id),
          h('span', { class: 'body-s muted' }, (s.title || '') + ' · reports to ' + (s.manager ? nameOf(seats, s.manager) : 'you')),
          s.hire ? h('span', { class: 'caption muted' }, 'hired ' + whenOf(s.hire.at) + (s.firstRun ? ' · first run ' + whenOf(s.firstRun.at) + (s.firstRun.outcome ? ', ' + s.firstRun.outcome : '') : run ? ' · first run in progress' : ' · first run pending')) : null,
          now && now.sprint && nx && nx.lanes ? h('span', { class: 'caption muted', title: nx.lanes.why || '' }, 'Sprint: ' + nx.lanes.running + ' of ' + nx.lanes.max + (nx.lanes.max === 1 ? ' lane' : ' lanes') + ' running'
            + (nx.lanes.possible > nx.lanes.max ? ' · ' + nx.lanes.possible + ' items could run in parallel' : '') + (nx.lanes.running ? '' : ' · ' + nx.sprint)) : null,
          run ? h('span', { class: 'caption row-8', style: 'align-items:center' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), cap(run.step || run.label)) : now && now.sprint && nx && nx.sprint ? null : nx && nx.nextRunAt ? h('span', { class: 'caption muted' }, 'next run ' + new Date(nx.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ((nx.soonerBecause || []).length ? ', sooner: ' + nx.soonerBecause.join(', ') : '')) : null),
        Tag(cap(state), { variant: 'status', status: statusOf(state) }));
    }));
    drawDossier(seats.find(s => s.id === selId), seats);
  }

  function drawDossier(s, seats) {
    const defs = [['brief', 'Brief'], ['model', 'Model']];
    const st = s.station || {};
    const tabHost = h('div');
    const pane = h('div', { class: 'stack-24' });
    const drawPane = () => {
      fill(tabHost, tabs(defs, tab, id => { tab = id; history.replaceState(null, '', '#/crew/' + encodeURIComponent(s.id) + (id === 'model' ? '/model' : '')); drawPane(); }, 'Dossier'));
      if (tab === 'brief') fill(pane,
        h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px' },
          kv('Functions', (s.functions || []).map(f => FN_LABEL[f] || f).join(', ') || 'None'),
          kv('Runs on', [st.model, st.provider].filter(Boolean).join(' · ') || 'Not reported by the station'),
          kv('Wakes', [s.loop ? 'on its own routine' : null, s.cooldownMin ? 'at most every ' + s.cooldownMin + ' min' : null, s.wakeOnInbox ? 'early when work is handed to it' : null].filter(Boolean).join(', ') || 'only when asked'),
          kv('Priority', s.priority != null ? String(s.priority) + (s.priority >= 80 ? ' (woken first)' : '') : 'Default')),
        Details('Details', h('dl', { class: 'kv' },
          h('dt', null, 'Seat id'), h('dd', { class: 'mono-s' }, s.id),
          s.seat ? [h('dt', null, 'Seat'), h('dd', { class: 'mono-s' }, s.seat)] : null,
          s.role ? [h('dt', null, 'Role file'), h('dd', { class: 'mono-s' }, s.role)] : null,
          s.inbox ? [h('dt', null, 'Handoff inbox'), h('dd', { class: 'mono-s' }, s.inbox)] : null,
          s.log ? [h('dt', null, 'Work log'), h('dd', { class: 'mono-s' }, s.log)] : null,
          s.loop ? [h('dt', null, 'Routine'), h('dd', { class: 'mono-s' }, s.loop)] : null)));
      else {
        // kept across the crew screen's live reloads, so a choice being made in the picker is not wiped
        if (!modelView || modelView.id !== s.id) { modelView = { id: s.id, el: h('div') }; modelPanel(modelView.el, s.id); }
        fill(pane, modelView.el, h('p', { class: 'caption muted' }, 'Every seat\'s chain and the subscription cutoffs: ', h('a', { href: '#/settings/models' }, 'Settings › Models and subscriptions'), '.'));
      }
    };
    fill(dossier,
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'stack-6' }, h('h2', { id: 'dossier', class: 'h2' }, s.name || s.id),
          h('span', { class: 'body-s muted' }, s.title || '')),
        h('div', { class: 'row-8', style: 'align-items:flex-start' }, Button('Message', { variant: 'secondary', size: 'sm', href: '#/chat/agent:' + encodeURIComponent(s.id) }))),
      tabHost, pane);
    drawPane();
  }

  load();
  const stopPanels = mountPanels(side, 'side:crew', app);
  const off = events.on(['crew', 'now'], load);
  return () => { off(); stopPanels(); };
}
function kv(k, v) { return h('div', { class: 'stack-8' }, h('span', { class: 'eyebrow-t' }, k), h('p', { class: 'body-s' }, v)); }
function whenOf(t) { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function nameOf(seats, id) { const s = seats.find(x => x.id === id); return s ? s.name || id : id; }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
