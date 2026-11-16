// Crew (Crew.dc.html): functions, seats, dossier.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, initial, statusOf, NOT_CONNECTED } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';

const FUNCS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const FN_LABEL = { ceo: 'CEO', people: 'People', tools: 'Tools', risk: 'Risk', floor: 'Floor', finance: 'Finance' };

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main';
  let selId = ctx.rest[0] || null, tab = 'brief';
  const head = h('div'), fnHost = h('div'), listHost = h('div', { style: 'flex:1 1 320px;display:flex;flex-direction:column;border-top:1px solid var(--border-hairline)' }),
    dossier = h('article', { 'aria-labelledby': 'dossier', class: 'card p28', style: 'flex:2 1 480px;min-width:0;gap:24px' }), errEl = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head, errEl,
    h('section', { 'aria-labelledby': 'fn', class: 'stack-16' }, h('h2', { id: 'fn', class: 'h4' }, 'Who holds each function'), fnHost),
    h('section', { style: 'display:flex;flex-wrap:wrap;gap:32px' }, listHost, dossier), side);
  let data = null;

  async function load() {
    try { data = await api('/crew'); fill(errEl, data.station === 'down' ? h('p', { class: 'err-line' }, 'Station not running: live status and dossiers are unavailable.') : null); }
    catch (e) { fill(errEl, errLine(e, 'Crew')); data = { seats: [] }; }
    const seats = data.seats || [];
    let templates = []; try { templates = (await api('/hiring')).templates || []; } catch (_) {}
    fill(head, screenHead({ eyebrow: [seats.length + (seats.length === 1 ? ' seat' : ' seats'), templates.length ? templates.length + ' templates' : null], title: 'Crew.',
      actions: [Button('Open a role', { variant: 'secondary', href: '#/hiring' }), Button('Recruit', { variant: 'primary', href: '#/hiring' })] }));
    fill(fnHost, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px' }, FUNCS.map(fn => {
      const holder = seats.find(s => (s.functions || []).includes(fn));
      return h('div', { class: 'card', style: 'gap:6px;padding:16px' }, h('span', { class: 'eyebrow-t' }, FN_LABEL[fn]),
        h('span', { class: 'label strong' }, holder ? holder.name || holder.id : 'Nobody'), h('span', { class: 'caption muted' }, holder ? (holder.manager ? 'reports to ' + nameOf(seats, holder.manager) : 'talks to the owner') : 'unfilled'));
    })));
    if (!seats.length) { fill(listHost, empty('No seats yet.')); fill(dossier, empty(NOT_CONNECTED)); return; }
    if (!selId || !seats.some(s => s.id === selId)) selId = seats[0].id;
    fill(listHost, seats.map(s => {
      const st = s.station || {}; const state = st.status || st.state || (data.station === 'down' ? 'Unknown' : 'Idle');
      return h('button', { type: 'button', class: 'crew-item', 'aria-current': s.id === selId ? 'true' : 'false', onclick: () => { selId = s.id; history.replaceState(null, '', '#/crew/' + encodeURIComponent(s.id)); load(); } },
        h('span', { class: 'avatar lg', 'aria-hidden': 'true' }, initial(s.name)),
        h('span', { class: 'stack-4', style: 'gap:3px;min-width:0' }, h('span', { class: 'label strong' }, s.name || s.id),
          h('span', { class: 'body-s muted' }, (s.title || '') + ' · reports to ' + (s.manager ? nameOf(seats, s.manager) : 'the owner'))),
        Tag(cap(state), { variant: 'status', status: statusOf(state) }));
    }));
    drawDossier(seats.find(s => s.id === selId), seats);
  }

  function drawDossier(s, seats) {
    const defs = [['brief', 'Brief'], ['growth', 'Growth'], ['record', 'Record'], ['memory', 'Memory'], ['competence', 'Competence'], ['latitude', 'Own section'], ['config', 'Config']];
    const other = {
      growth: 'XP, ratings and corrections over time; the competence scoreboard by skill bucket.',
      record: 'Logbook of every run with its transcript, and restore to a checkpoint.',
      memory: 'Memory records, pending proposals, declined items, pins and forget.',
      competence: 'Experience and verified flaws per skill bucket (competence.js scoreboard).',
      latitude: 'Their own section of their routine prompts (my-section.js) and change history.',
      config: 'Purpose, instructions, model and effort, personality preset, access and approval mode, appearance, skills.',
    };
    const st = s.station || {};
    const tabHost = h('div');
    const pane = h('div', { class: 'stack-24' });
    const drawPane = () => {
      fill(tabHost, tabs(defs, tab, id => { tab = id; drawPane(); }, 'Dossier'));
      if (tab === 'brief') fill(pane,
        h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px' },
          kv('Functions', (s.functions || []).map(f => FN_LABEL[f] || f).join(', ') || 'None'),
          kv('Runs on', [st.model, st.provider].filter(Boolean).join(' · ') || 'Model not reported (station roster)'),
          kv('Loop', [s.loop, s.cooldownMin ? 'cooldown ' + s.cooldownMin + ' min' : null, s.wakeOnInbox ? 'woken early by handoffs' : null].filter(Boolean).join(' · ') || '—')),
        h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px' },
          kpi(s.priority != null ? s.priority : '—', 'dispatch priority'), kpi(s.inbox || '—', 'handoff inbox'), kpi(s.log || '—', 'work log'), kpi(s.role || '—', 'charter')));
      else fill(pane, h('div', { class: 'empty' }, h('p', null, other[tab]), h('p', null, NOT_CONNECTED)));
    };
    fill(dossier,
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'stack-6' }, h('h2', { id: 'dossier', class: 'h2' }, s.name || s.id),
          h('span', { class: 'body-s muted' }, [s.title, s.seat ? 'seat ' + s.seat : null, 'id ' + s.id].filter(Boolean).join(' · '))),
        h('div', { class: 'row-8', style: 'align-items:flex-start' }, Button('Message', { variant: 'secondary', size: 'sm', href: '#/comms/agent:' + encodeURIComponent(s.id) }))),
      tabHost, pane);
    drawPane();
  }

  load();
  const stopPanels = mountPanels(side, 'side:crew', app);
  const off = events.on('crew', load);
  return () => { off(); stopPanels(); };
}
function kv(k, v) { return h('div', { class: 'stack-8' }, h('span', { class: 'eyebrow-t' }, k), h('p', { class: 'body-s' }, v)); }
function kpi(v, l) { return h('div', { class: 'kpi' }, h('span', { class: 'big-num ellip', style: 'font-size:' + (String(v).length > 6 ? '15px' : '28px') }, String(v)), h('span', { class: 'caption muted' }, l)); }
function nameOf(seats, id) { const s = seats.find(x => x.id === id); return s ? s.name || id : id; }
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
