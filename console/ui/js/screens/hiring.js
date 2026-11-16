// Hiring (Hiring.dc.html): rounds from company/hiring/*/round.json, seat templates.
import { h, fill, Tag, errLine, empty, screenHead, table, rel } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';

const STEPS = ['Research', 'Role spec', 'Model fit', 'Interviews', 'Pick', 'Hire'];
const TEMPLATE_WHAT = { 'people-manager': 'Hiring, charters, models, performance.', 'tool-builder': 'Tools, routines, skills, the station service.',
  'risk-manager': 'Access, the external gate, locked files, compliance.', 'finance-manager': 'Spend cap, pacing, ledger, monthly close.',
  'floor-manager': 'Floor plan, desks, the office look.', specialist: 'Any domain role, scoped from real listings.' };

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main';
  const head = h('div'), errEl = h('div'), rounds = h('div', { class: 'stack-24' }), tpl = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head, errEl, rounds,
    h('section', { 'aria-labelledby': 'tpl', class: 'stack-16' }, h('h2', { id: 'tpl', class: 'h3' }, 'Seat templates'),
      h('p', { class: 'body-s muted', style: 'max-width:640px' }, 'Hiring one moves its function from the Founder to the hire (hire.js --functions). Rounds are opened by the CEO with hire.js; the console shows them.'), tpl),
    side);
  async function load() {
    let d, seats = [];
    try { d = await api('/hiring'); fill(errEl); } catch (e) { fill(errEl, errLine(e, 'Hiring')); d = { rounds: [], templates: [] }; }
    try { seats = (await api('/crew')).seats || []; } catch (_) {}
    const open = (d.rounds || []).filter(r => !r.hired && r.status !== 'closed');
    fill(head, screenHead({ eyebrow: [open.length + (open.length === 1 ? ' round open' : ' rounds open'), seats.length + ' seats filled'], title: 'Hiring.',
      lede: 'The CEO opens a role. People scopes it from real listings, interviews three, hires one. You see the pick; you decide only when it costs beyond the cap.', max: '640px' }));
    fill(rounds, (d.rounds || []).length ? d.rounds.slice().reverse().map(roundCard) : empty('No hiring rounds yet. A round appears here when the CEO runs hire.js open.'));
    const filled = t => seats.find(s => (s.role || '').replace(/\.md$/, '') === t || (s.title || '').toLowerCase().replace(/\s+/g, '-') === t);
    fill(tpl, (d.templates || []).length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' }, d.templates.map(t => {
      const who = filled(t);
      return h('article', { class: 'card p20', style: 'gap:10px' },
        h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, titleCase(t)), Tag(who ? 'filled' : t === 'specialist' ? 'domain' : 'open', { variant: who ? 'soft' : t === 'specialist' ? 'outline' : 'accent' })),
        h('p', { class: 'body-s muted' }, TEMPLATE_WHAT[t] || 'company/roles/templates/' + t + '.md'),
        h('span', { class: 'body-s', style: 'margin-top:auto;color:var(--text-accent)' }, who ? who.name : 'company/roles/templates/' + t + '.md'));
    })) : empty('No seat templates in company/roles/templates.'));
  }
  function roundCard(r) {
    const cands = r.candidates || [];
    const at = r.hired ? 5 : cands.some(c => c.interviewedAt) ? 4 : cands.length ? 3 : r.spec || r.roleSpec ? 2 : 1;
    return h('section', { 'aria-labelledby': 'round-' + r.id, class: 'card p28', style: 'gap:20px' },
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'stack-6' }, h('span', { class: 'mono muted' }, r.id),
          h('h2', { id: 'round-' + r.id, class: 'h2' }, r.title || r.role || titleCase(r.id)),
          h('span', { class: 'body-s muted' }, [r.openedBy || r.by ? 'Opened by ' + (r.openedBy || r.by) : null, r.reportsTo ? 'reports to ' + r.reportsTo : null, r.template ? 'from template ' + r.template : null, r.openedAt || r.at ? rel(r.openedAt || r.at) : null].filter(Boolean).join(' · '))),
        h('ol', { class: 'plain row-8 steps', style: 'gap:6px;align-items:flex-start' }, STEPS.map((s, i) => h('li', { class: i < at ? 'done' : i === at ? 'now' : '' }, s)))),
      cands.length ? table(['Candidate', 'Model', 'Status', 'Interviewed', 'Transcript'], cands.map(c => h('tr', null,
        h('td', { class: 'label strong' }, c.name || c.agentId), h('td', { class: 'num' }, [c.provider, c.model].filter(Boolean).join(' · ')),
        h('td', null, Tag(c.status || '?', { variant: 'status', status: c.status === 'hired' ? 'online' : c.status === 'released' ? 'neutral' : 'warning' })),
        h('td', { class: 'num' }, c.interviewedAt ? rel(c.interviewedAt) : '—'), h('td', { class: 'mono-s muted' }, c.transcript || '—'))), { minWidth: 760, bare: true })
        : h('p', { class: 'body-s muted' }, 'No candidates yet.'));
  }
  load();
  const stopPanels = mountPanels(side, 'side:hiring', app);
  const off = events.on('crew', load);
  return () => { off(); stopPanels(); };
}
function titleCase(s) { return String(s).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
