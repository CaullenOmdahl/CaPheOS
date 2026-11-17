// Crew › Hiring (#/crew/hiring, was #/hiring; Hiring.dc.html): the hiring rounds and the seat templates.
import { h, fill, Tag, errLine, empty, table, rel, Details } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';

const STEPS = ['Research', 'Role spec', 'Model fit', 'Interviews', 'Pick', 'Hire'];
const TEMPLATE_WHAT = { 'people-manager': 'Hiring, charters, models, performance.', 'tool-builder': 'Tools, routines, skills, the station service.',
  'risk-manager': 'Access, the external gate, locked files, compliance.', 'finance-manager': 'Spend cap, pacing, ledger, monthly close.',
  'floor-manager': 'Floor plan, desks, the office look.', specialist: 'Any domain role, scoped from real listings.' };

export async function renderTab(root, ctx) {
  const { app } = ctx;
  const head = h('div'), errEl = h('div'), rounds = h('div', { class: 'stack-24' }), tpl = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head, errEl, rounds,
    h('section', { 'aria-labelledby': 'tpl', class: 'stack-16' }, h('h2', { id: 'tpl', class: 'h3' }, 'Seat templates'),
      h('p', { class: 'body-s muted', style: 'max-width:640px' }, 'The kinds of seat the company can hire for. Filling one moves that function from the Founder to the new hire.'), tpl),
    side);
  async function load() {
    let d, seats = [];
    try { d = await api('/hiring'); fill(errEl); } catch (e) { fill(errEl, errLine(e, 'Hiring')); d = { rounds: [], templates: [] }; }
    try { seats = (await api('/crew')).seats || []; } catch (_) {}
    const open = (d.rounds || []).filter(r => !r.hired && r.status !== 'closed' && !r.closed);
    fill(head, h('p', { class: 'body-l muted', style: 'max-width:640px' }, 'The CEO opens a role. People scopes it from real listings, interviews three and hires one. You see the pick, and decide only when it costs more than the spend cap allows.'));
    fill(rounds, (d.rounds || []).length ? d.rounds.slice().reverse().map(roundCard) : empty('No hiring rounds yet. A round appears here when the CEO opens a role.'));
    const filled = t => seats.find(s => (s.role || '').replace(/\.md$/, '') === t || (s.title || '').toLowerCase().replace(/\s+/g, '-') === t);
    fill(tpl, (d.templates || []).length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' }, d.templates.map(t => {
      const who = filled(t);
      return h('article', { class: 'card p20', style: 'gap:10px' },
        h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, titleCase(t)), Tag(who ? 'filled' : t === 'specialist' ? 'domain' : 'open', { variant: who ? 'soft' : t === 'specialist' ? 'outline' : 'accent' })),
        h('p', { class: 'body-s muted' }, TEMPLATE_WHAT[t] || 'A seat the company defined itself.'),
        who ? h('span', { class: 'body-s', style: 'margin-top:auto;color:var(--text-accent)' }, who.name) : null);
    })) : empty('No seat templates yet.'));
  }
  // the live stage from hire.js roundStage (GET /api/hiring rounds[].stage), else the old guess from the files
  const STAGE_AT = { 'needs-files': 1, candidates: 3, interviewing: 3, 'interviews-failed': 3, 'waiting-pick': 4, picked: 5, 'waiting-owner': 5, declined: 4, hired: 6, closed: 6 };
  const STAGE_TONE = { hired: 'online', 'waiting-pick': 'warning', 'waiting-owner': 'warning', declined: 'danger', 'interviews-failed': 'danger', 'needs-files': 'warning', closed: 'neutral' };
  function stageLine(st) {
    if (!st) return null;
    const tl = (st.timeline || []).filter(x => x.at);
    return h('div', { class: 'stack-6' },
      h('div', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap' }, Tag(st.label, { variant: 'status', status: STAGE_TONE[st.key] || 'info' }), st.at ? h('span', { class: 'caption muted' }, 'since ' + rel(st.at)) : null),
      tl.length ? h('ol', { class: 'plain row-8 caption muted', style: 'flex-wrap:wrap;gap:4px 14px' }, tl.map(x => h('li', null, x.step + ' ' + new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))) : null);
  }
  function roundCard(r) {
    const cands = r.candidates || [];
    const at = r.stage && STAGE_AT[r.stage.key] !== undefined ? STAGE_AT[r.stage.key] : r.hired ? 5 : cands.some(c => c.interviewedAt) ? 4 : cands.length ? 3 : r.spec || r.roleSpec ? 2 : 1;
    return h('section', { 'aria-labelledby': 'round-' + r.id, class: 'card p28', style: 'gap:20px' },
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'stack-6' },
          h('h2', { id: 'round-' + r.id, class: 'h2' }, r.title || r.role || titleCase(r.id)),
          h('span', { class: 'body-s muted' }, [r.openedBy || r.by ? 'Opened by ' + (r.openedBy || r.by) : null, r.reportsTo ? 'reports to ' + r.reportsTo : null, r.template ? 'from the ' + titleCase(r.template).toLowerCase() + ' template' : null, r.openedAt || r.at ? rel(r.openedAt || r.at) : null].filter(Boolean).join(' · '))),
        h('ol', { class: 'plain row-8 steps', style: 'gap:6px;align-items:flex-start' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, s)))),
      stageLine(r.stage),
      cands.length ? table(['Candidate', 'Model', 'Status', 'Interviewed'], cands.map(c => h('tr', null,
        h('td', { class: 'label strong' }, c.name || c.agentId), h('td', { class: 'num' }, [c.provider, c.model].filter(Boolean).join(' · ')),
        h('td', null, Tag(c.status || '?', { variant: 'status', status: c.status === 'hired' ? 'online' : c.status === 'released' ? 'neutral' : 'warning' })),
        h('td', { class: 'num' }, c.interviewedAt ? rel(c.interviewedAt) : '—'))), { minWidth: 640, bare: true })
        : h('p', { class: 'body-s muted' }, 'No candidates yet.'),
      Details('Details', h('dl', { class: 'kv' }, h('dt', null, 'Round'), h('dd', { class: 'mono-s' }, r.id),
        cands.filter(c => c.transcript).map(c => [h('dt', null, (c.name || c.agentId) + ' transcript'), h('dd', { class: 'mono-s' }, c.transcript)]))));
  }
  load();
  const stopPanels = mountPanels(side, 'side:hiring', app);
  const off = events.on(['crew', 'dispatch', 'activity'], load);
  // a round moves on its own (interviews finish in the background): refresh while one is open
  const iv = setInterval(load, 20000);
  return () => { off(); clearInterval(iv); stopPanels(); };
}
function titleCase(s) { return String(s).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
