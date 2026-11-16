// Usage and models (Usage.dc.html): pacer plans, routing, tiles.
import { h, fill, Tag, errLine, empty, screenHead, table, NOT_CONNECTED } from '../ui.js';
import { api } from '../api.js';
import { mountPanels } from '../panels.js';
import { usagePlans } from './today.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main';
  const head = h('div'), plans = h('div'), routing = h('div'), tiles = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head,
    h('section', { 'aria-labelledby': 'plans', class: 'stack-16' }, h('h2', { id: 'plans', class: 'h3' }, 'Plans this week'), plans),
    h('section', { 'aria-labelledby': 'routing', class: 'stack-14' },
      h('div', { class: 'between' }, h('h2', { id: 'routing', class: 'h3' }, 'Who runs on what'), h('span', { class: 'caption muted' }, 'Routing owned by People; numbers owned by Finance. Cheapest model that does the job.')),
      routing),
    tiles, side);
  let d = {};
  try { d = await api('/usage'); } catch (e) { fill(plans, errLine(e, 'Pacer')); }
  fill(head, screenHead({ eyebrow: [d.mode ? 'Pacer ' + d.mode : null, d.live ? 'live' : d.mode ? 'not live' : null, d.emergency && d.emergency.active ? 'Emergency on' : null],
    title: 'Usage and models.', lede: 'Subscriptions get a daily line from their weekly limit. This company has its share of accounts it may share with another company on this machine.', max: '720px' }));
  if (d.claude || d.minimax || d.deepseek) {
    const subs = ['claude', 'minimax', 'deepseek'].filter(k => d[k]).map(k => {
      const p = d[k];
      const open = p.open; const st = p.hard ? 'danger' : open ? 'online' : 'warning';
      const fmt = v => v == null ? '—' : typeof v === 'number' ? (Math.round(v * 10) / 10) + '%' : String(v);
      return h('article', { class: 'card p22', style: 'gap:14px' },
        h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, p.label || k), Tag(p.hard ? 'Stopped' : open ? 'Open' : 'Closed', { variant: 'status', status: st })),
        k !== 'deepseek' ? h('dl', { style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0' },
          dd('Share', fmt(p.share)), dd('Week used', fmt(p.usedPct)), dd("Today's line", fmt(p.line))) : dd('Balance', p.reading == null ? '—' : String(p.reading)),
        h('span', { class: 'caption muted' }, p.why || ''),
        p.lastError ? h('span', { class: 'caption danger' }, p.lastError) : null);
    });
    fill(plans, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' }, subs));
  } else if (!plans.firstChild) fill(plans, empty('The pacer returned no plans.'));
  fill(routing, d.routing || d.plan ? h('pre', { class: 'pre card' }, JSON.stringify(d.routing || d.plan, null, 1)) : empty('Per-seat model chains (pacer.js plan, model-policy.json routing): ' + NOT_CONNECTED));
  const pr = d.problems || [];
  fill(tiles, h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px' },
    tile('Emergency', d.emergency ? (d.emergency.active ? 'On' : 'Off') : '—', d.emergency && d.emergency.why || 'lifts the line to the ceiling'),
    tile('Boost', d.boost ? (d.boost.on ? 'On' : 'Off') : '—', d.boost && d.boost.why || ''),
    tile('Spend rail', d.rail && d.rail.known ? Math.round(d.rail.pct) + '%' : '—', d.rail ? '$' + d.rail.perDay + '/day · ' + (d.rail.source || '') : ''),
    tile('Problems', String(pr.length), pr[0] || 'none')));
  const stopPanels = mountPanels(side, 'side:usage', app);
  return () => stopPanels();
}
function dd(k, v) { return h('div', null, h('dt', { class: 'caption muted' }, k), h('dd', { class: 'mono strong', style: 'margin:0' }, v)); }
function tile(l, v, n) { return h('div', { class: 'card p18', style: 'gap:6px' }, h('span', { class: 'eyebrow-t' }, l), h('span', { class: 'big-num' }, v), h('span', { class: 'caption muted' }, n)); }
