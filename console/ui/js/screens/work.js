// Work (Work.dc.html): quests (station), handoffs, decisions, and the project folders the crew may work in.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, table, rel, Details } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';


export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-36';
  const TABS = ['quests', 'handoffs', 'decisions', 'projects'];
  let tab = TABS.includes(ctx.rest[0]) ? ctx.rest[0] : 'quests';
  const head = h('div'), tabsHost = h('div'), body = h('div', { class: 'stack-16' }), side = h('div', { class: 'stack-16' });
  fill(root, head, tabsHost, body, side);
  const n = {};
  const drawHead = () => fill(head, screenHead({ eyebrow: [n.quests != null ? n.quests + ' quests' : null, n.handoffs != null ? n.handoffs + ' open handoffs' : null, n.overdue != null ? n.overdue + ' overdue' : null],
    title: 'Work.', actions: [] }));
  const drawTabs = () => fill(tabsHost, tabs([['quests', 'Quests', n.quests], ['handoffs', 'Handoffs', n.handoffs], ['decisions', 'Decisions', n.decisions], ['projects', 'Projects']],
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
        fill(body, it.length ? table(['Deadline', 'For', 'Ask', 'Status'], it.map(x => h('tr', null,
          h('td', { class: 'num strong', style: 'white-space:nowrap' }, x.raw || x.due || '—'),
          h('td', { style: 'white-space:nowrap' }, inboxName(x.file)),
          h('td', { class: 'strong' }, String(x.heading || x.ask || '').replace(/^#+\s*/, '')),
          h('td', null, Tag(x.overdue ? 'Overdue' : x.due ? 'Open' : 'Undated', { variant: 'status', status: x.overdue ? 'danger' : x.due ? 'warning' : 'neutral' })))), { minWidth: 720 })
          : empty('No open handoffs.'));
      } else if (tab === 'decisions') {
        // paged from the end of the file (GET /api/decisions?cursor=): "Load older" fetches the 100 lines before these
        let ent = [], cursor = null;
        const more = async () => {
          const d = await api('/decisions' + (cursor != null ? '?cursor=' + cursor : ''));
          ent = (d.entries || []).filter(e => String(e.text).trim()).concat(ent); cursor = d.more ? d.cursor : null;
          n.decisions = ent.filter(e => /^#{1,3}\s|^-\s|^\*\*/.test(e.text)).length || null; drawTabs();
          fill(body, ent.length ? h('div', { class: 'card' }, h('span', { class: 'caption muted' }, 'The company\'s decision log, newest last (' + ent.length + ' lines). Older months are archived.'),
            cursor != null ? Button('Load older', { size: 'sm', onClick: () => more().catch(e => body.appendChild(errLine(e, 'Decisions'))) }) : null,
            h('pre', { class: 'pre' }, ent.map(e => e.text).join('\n')))
            : empty('No decisions recorded yet.'));
        };
        await more();
      } else if (tab === 'projects') {
        const d = await api('/station/projects');
        const ps = d.projects || [];
        fill(body, h('p', { class: 'body-s muted', style: 'max-width:640px' }, 'Folders the crew may work in. Only you approve or take back a folder.'),
          ps.length ? table(['Project', 'Last touched', ''], ps.map(p => h('tr', null,
            h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, folderName(p.displayPath || p.root)), Details('Details', h('code', { class: 'mono-s' }, p.displayPath || p.root))),
            h('td', null, p.lastTouchedAt ? rel(p.lastTouchedAt) : '—'),
            h('td', null, Tag(p.blessed ? 'Allowed' : 'Waiting for you', { variant: 'status', status: p.blessed ? 'online' : 'warning' }), p.isGitRepo ? h('span', { class: 'caption muted' }, ' · version-controlled') : null))), { minWidth: 560 })
          : empty('No project folders yet.'));
      }
    } catch (e) { fill(body, errLine(e, 'Could not load')); }
  }
  counts(); load();
  const stopPanels = mountPanels(side, 'side:work', app);
  const off = events.on(['handoffs'], () => { counts(); if (tab === 'handoffs') load(); });
  return () => { off(); stopPanels(); };
}

function inboxName(f) { const b = String(f || '').split('/').pop().replace(/\.md$/, '').replace(/^to-/, ''); return b ? b.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase()) : '—'; }
function folderName(p) { const parts = String(p || '').split('/').filter(Boolean); return parts.pop() || 'Project'; }
// a quest title often ends "-> company/work/…/file.md": the place it delivers to goes behind Details
function questTitle(q) { const m = /^(.*?)\s*(?:->|→)\s*(\S+\/\S+)\s*$/.exec(String(q.title || '')); return m ? { title: m[1], to: m[2] } : { title: q.title || '(untitled)', to: q.contract && q.contract.key || null }; }
function questCard(q) {
  const steps = q.steps || []; const done = steps.filter(s => s.done).length;
  const pct = steps.length ? Math.round(done / steps.length * 100) : q.status === 'done' ? 100 : 0;
  const next = steps.find(s => !s.done);
  return h('article', { class: 'card p18', style: 'gap:10px' },
    h('div', { class: 'between-c' }, h('span', { class: 'mono muted' }, q.id), h('span', { class: 'caption muted' }, q.agentName || q.agentId || '')),
    h('h3', { class: 'label strong', style: 'line-height:1.35;margin:0' }, questTitle(q).title),
    h('div', { class: 'meter thin', role: 'img', 'aria-label': done + ' of ' + steps.length + ' steps done' }, h('div', { style: 'width:' + pct + '%' })),
    h('span', { class: 'caption muted' }, q.status === 'done' ? 'Done' + (q.attest ? ' · attested' : '') : next ? 'Next: ' + (next.label || next.key) : q.whyNow || ''),
    questTitle(q).to ? Details('Details', h('code', { class: 'mono-s' }, 'Delivers ' + questTitle(q).to)) : null);
}
