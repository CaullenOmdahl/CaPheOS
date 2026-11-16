// Work (Work.dc.html): quests (station), handoffs, decisions; the rest honest empty states.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, table, NOT_CONNECTED, rel } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';

const OTHER = {
  tasks: ['Tasks', 'Kanban of every agent task with owner and session. Station: deliverables, line-jobs.'],
  deliverables: ['Deliverables', 'Every finished file, filterable by agent and project; preview, open, clean up with undo.'],
  review: ['To review', 'Away-work results waiting for Keep, Later or Discard, and quests attested but not yet closed.'],
  projects: ['Projects', 'Ownership records (project.js): request, scope, state. Only you approve or revoke a takeover.'],
};

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-36';
  let tab = ctx.rest[0] || 'quests';
  const head = h('div'), tabsHost = h('div'), body = h('div', { class: 'stack-16' }), side = h('div', { class: 'stack-16' });
  fill(root, head, tabsHost, body, side);
  const n = {};
  const drawHead = () => fill(head, screenHead({ eyebrow: [n.quests != null ? n.quests + ' quests' : null, n.handoffs != null ? n.handoffs + ' open handoffs' : null, n.overdue != null ? n.overdue + ' overdue' : null],
    title: 'Work.', actions: [] }));
  const drawTabs = () => fill(tabsHost, tabs([['quests', 'Quests', n.quests], ['handoffs', 'Handoffs', n.handoffs], ['tasks', 'Tasks'], ['deliverables', 'Deliverables'], ['review', 'To review'], ['decisions', 'Decisions', n.decisions], ['projects', 'Projects']],
    tab, id => { tab = id; history.replaceState(null, '', '#/work/' + id); drawTabs(); load(); }, 'Work views'));
  drawHead(); drawTabs();

  async function counts() {
    api('/handoffs').then(d => { const it = d.items || []; n.handoffs = it.length; n.overdue = it.filter(x => x.overdue).length; drawHead(); drawTabs(); }).catch(() => {});
    api('/station/quests').then(d => { n.quests = (d.quests || []).filter(q => q.status === 'open').length; drawHead(); drawTabs(); }).catch(() => {});
  }

  async function load() {
    fill(body, h('p', { class: 'caption muted' }, 'Loading…'));
    try {
      if (tab === 'quests') {
        const d = await api('/station/quests');
        const qs = d.quests || [];
        const col = (name, list) => h('section', { class: 'stack-12' }, h('h2', { class: 'eyebrow-t' }, name + ' · ' + list.length),
          list.length ? list.map(questCard) : h('p', { class: 'caption muted' }, 'None.'));
        const open = qs.filter(q => q.status === 'open');
        const blocked = open.filter(q => /block|wait/i.test(String(q.disposition || '') + ' ' + String(q.whyNow || '')));
        const progress = open.filter(q => !blocked.includes(q));
        const done = qs.filter(q => q.status === 'done').slice(-6);
        fill(body, qs.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px' },
          col('In progress', progress), col('Blocked', blocked), col('Done', done)) : empty('No quests on the station yet.'));
      } else if (tab === 'handoffs') {
        const d = await api('/handoffs');
        const it = d.items || [];
        fill(body, it.length ? table(['Deadline', 'Inbox', 'Ask', 'Status'], it.map(x => h('tr', null,
          h('td', { class: 'num strong', style: 'white-space:nowrap' }, x.raw || x.due || '—'),
          h('td', { style: 'white-space:nowrap' }, String(x.file || '').replace(/^company\/work\/handoffs\//, '')),
          h('td', { class: 'strong' }, String(x.heading || x.ask || '').replace(/^#+\s*/, '')),
          h('td', null, Tag(x.overdue ? 'Overdue' : x.due ? 'Open' : 'Undated', { variant: 'status', status: x.overdue ? 'danger' : x.due ? 'warning' : 'neutral' })))), { minWidth: 720 })
          : empty('No open handoffs.'));
      } else if (tab === 'decisions') {
        const d = await api('/decisions');
        const ent = (d.entries || []).filter(e => String(e.text).trim());
        n.decisions = ent.filter(e => /^#{1,3}\s|^-\s|^\*\*/.test(e.text)).length || null; drawTabs();
        fill(body, ent.length ? h('div', { class: 'card' }, h('span', { class: 'caption muted' }, 'company/work/decisions.md, last 100 lines, newest last'), h('pre', { class: 'pre' }, ent.map(e => e.text).join('\n')))
          : empty('No decisions recorded yet.'));
      } else {
        const [t, x] = OTHER[tab];
        fill(body, h('div', { class: 'empty' }, h('h2', { class: 'h4' }, t), h('p', null, x), h('p', null, NOT_CONNECTED)));
      }
    } catch (e) { fill(body, errLine(e, 'Could not load')); }
  }
  counts(); load();
  const stopPanels = mountPanels(side, 'side:work', app);
  const off = events.on(['handoffs'], () => { counts(); if (tab === 'handoffs') load(); });
  return () => { off(); stopPanels(); };
}

function questCard(q) {
  const steps = q.steps || []; const done = steps.filter(s => s.done).length;
  const pct = steps.length ? Math.round(done / steps.length * 100) : q.status === 'done' ? 100 : 0;
  const next = steps.find(s => !s.done);
  return h('article', { class: 'card p18', style: 'gap:10px' },
    h('div', { class: 'between-c' }, h('span', { class: 'mono muted' }, q.id), h('span', { class: 'caption muted' }, q.agentId || q.createdBy || '')),
    h('h3', { class: 'label strong', style: 'line-height:1.35;margin:0' }, q.title || '(untitled)'),
    h('div', { class: 'meter thin', role: 'img', 'aria-label': done + ' of ' + steps.length + ' steps done' }, h('div', { style: 'width:' + pct + '%' })),
    h('span', { class: 'caption muted' }, q.status === 'done' ? 'Done' + (q.attest ? ' · attested' : '') : next ? 'Next: ' + (next.label || next.key) : q.whyNow || ''));
}
