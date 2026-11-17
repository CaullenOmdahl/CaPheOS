// Work (Work.dc.html): quests (station), handoffs, decisions, and the project folders the crew may work in.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, table, rel, Details } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { personName, nameFromId } from '../plain.js';


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
        const [d, names] = await Promise.all([api('/station/quests'), seatNames()]);
        const qs = d.quests || [];
        const who = q => q.agentName ? personName(q.agentName) : names[q.agentId] || nameFromId(q.agentId) || '';
        // an empty column collapses to a slim header; In progress takes the room (a flex board, stacked on a phone)
        const col = (name, list, grow) => h('section', { class: 'stack-12 quest-col' + (list.length ? '' : ' empty-col'), 'data-col': name, style: list.length ? 'flex-grow:' + grow : null },
          h('h2', { class: 'eyebrow-t' }, name + ' · ' + list.length), list.length ? list.map(q => questCard(q, who(q))) : null);
        const open = qs.filter(q => q.status === 'open');
        const blocked = open.filter(q => /block|wait/i.test(String(q.disposition || '') + ' ' + String(q.whyNow || '')));
        const progress = open.filter(q => !blocked.includes(q));
        const done = qs.filter(q => q.status === 'done').slice(-6);
        fill(body, qs.length ? h('div', { class: 'quest-board' },
          col('In progress', progress, 2), col('Blocked', blocked, 1), col('Done', done, 1)) : empty('No quests on the station yet.'));
      } else if (tab === 'handoffs') {
        const [d, pk] = await Promise.all([api('/handoffs'), api('/handoffs/parked').catch(() => null)]);
        const it = d.items || [];
        fill(body, parkedCard(pk, load), jobsCard(pk), it.length ? table(['Deadline', 'For', 'Ask', 'Status'], it.map(x => h('tr', null,
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
// a quest title often ends "-> company/work/…/file.md" or "→ floor-met.md": the place it delivers to goes behind Details.
// The station cuts long titles (sometimes right after the arrow): a dangling arrow is dropped and a cut title says so (…)
export function questTitle(q) {
  const raw = String(q.title || '').trim();
  const m = /^(.*?)\s*(?:->|→)\s*(\S*)\s*$/.exec(raw);
  let title = m ? m[1] : raw; const to = (m && m[2]) || (q.contract && q.contract.key) || null;
  if (!m && raw.length >= 76 && !/[.!?)]$/.test(raw)) title = raw + '…';
  return { title: title || '(untitled)', to };
}
// steps come as {label, done} or [label, done]
const stepOf = s => Array.isArray(s) ? { label: s[0], done: !!s[1] } : s || {};
// the bar and the line under it: a done quest is a full bar; unticked steps on a done quest are said, not drawn
export function questProgress(q) {
  const steps = (q.steps || []).map(stepOf); const ticked = steps.filter(s => s.done).length;
  if (q.status === 'done') return { pct: 100, line: 'Done' + (steps.length && ticked < steps.length ? ' (' + ticked + ' of ' + steps.length + ' steps ticked)' : '') + (q.attest ? ' · attested' : ''), aria: 'Done' };
  const next = steps.find(s => !s.done);
  return { pct: steps.length ? Math.round(ticked / steps.length * 100) : 0, line: next ? 'Next: ' + (next.label || next.key) : q.whyNow || '', aria: ticked + ' of ' + steps.length + ' steps done' };
}
// seat id -> display name, from the crew and the hiring rounds' candidates
async function seatNames() {
  const out = {};
  try { for (const r of (await api('/hiring')).rounds || []) for (const c of r.candidates || []) if (c.agentId && c.name) out[c.agentId] = personName(c.name); } catch (_) {}
  try { for (const s of (await api('/crew')).seats || []) if (s.id && s.name) out[s.id] = personName(s.name); } catch (_) {}
  return out;
}
function questCard(q, owner) {
  const pr = questProgress(q); const t = questTitle(q);
  return h('article', { class: 'card p18 quest-card', 'data-quest': q.id, 'data-status': q.status, style: 'gap:10px' },
    h('h3', { class: 'label strong quest-title', style: 'line-height:1.35;margin:0' }, t.title),
    owner ? h('span', { class: 'caption muted quest-owner' }, owner) : null,
    h('div', { class: 'meter thin', role: 'img', 'aria-label': pr.aria }, h('div', { style: 'width:' + pr.pct + '%' })),
    pr.line ? h('span', { class: 'caption muted quest-line' }, pr.line) : null,
    Details('Details', q.desc ? h('p', { class: 'caption' }, String(q.desc).slice(0, 600)) : null, h('code', { class: 'mono-s' }, 'Quest ' + q.id + (q.agentId ? ' · owner ' + q.agentId : '') + (t.to ? ' · delivers ' + t.to : ''))));
}

// Parked: open items set aside for now, in plain words, each with the owner's Start now (it removes the gate, is
// recorded, and the holder is woken on the next check). Waiting on another item, a file, a quest step, a service run or
// a watched job is released by itself the moment it is met; a Not before is a real clock time with its reason.
function parkedCard(pk, reload) {
  const items = (pk && pk.items) || [];
  if (!items.length) return null;
  const ask = hd => String(hd || '').replace(/^#+\s*/, '').split(' — ').slice(1).join(' — ') || String(hd || '');
  return h('section', { class: 'card stack-12', 'data-parked': '' },
    h('h2', { class: 'eyebrow-t' }, 'Parked for now · ' + items.length),
    h('p', { class: 'caption muted' }, 'Set aside until what they wait for happens. Start now releases one at once.'),
    table(['For', 'Item', 'Why it waits', ''], items.map(x => h('tr', null,
      h('td', { style: 'white-space:nowrap' }, personName(x.name || x.seat)),
      h('td', { class: 'strong' }, ask(x.heading)),
      h('td', null, x.words),
      h('td', null, Button('Start now', { size: 'sm', onClick: async ev => {
        const b = ev && ev.currentTarget; if (b) b.disabled = true;
        try { await post('/handoffs/start-now', { inbox: x.inbox, heading: x.heading }); reload(); }
        catch (e) { if (b) { b.disabled = false; b.parentNode.appendChild(errLine(e, 'Start now')); } }
      } })))), { minWidth: 640 }));
}
// Background jobs the crew started through notify-when.js: what is running, and what ended (a failure says so)
function jobsCard(pk) {
  const run = (pk && pk.running) || [], done = (pk && pk.completions) || [];
  if (!run.length && !done.length) return null;
  const who = l => (l || []).length ? ' · wakes ' + l.map(personName).join(', ') : '';
  return h('section', { class: 'card stack-12', 'data-jobs': '' },
    h('h2', { class: 'eyebrow-t' }, 'Background jobs'),
    run.map(r => h('p', { class: 'body-s' }, Tag('Running', { variant: 'status', status: 'online' }), ' ', String(r.why || r.job || 'a job'), h('span', { class: 'caption muted' }, ' · since ' + rel(r.since) + who(r.wakes)))),
    done.map(r => h('p', { class: 'body-s' }, Tag(r.failed ? 'Failed' : 'Ended', { variant: 'status', status: r.failed ? 'danger' : 'neutral' }), ' ', r.words, h('span', { class: 'caption muted' }, ' · ' + rel(r.at) + who(r.wakes)))));
}
