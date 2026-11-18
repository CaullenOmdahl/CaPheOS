// Crew › People › Departments (console/departments.js, docs/DEPARTMENTS.md): each department, its lead and its members,
// the seats in none, and whether FLOOR_PLAN.md agrees. The owner sets a lead or moves a seat here; every change runs
// company/tools/departments.js as the owner, which checks and records it. Nothing shows while the company has no
// departments (they are created by the CEO or the people function; the section then says so in one line).
import { h, fill, Button, errLine, humanError, Details } from '../ui.js';
import { api, post } from '../api.js';

export function departmentsSection(host) {
  let data = null, msg = null, busy = false;
  async function load() {
    try { data = await api('/departments'); } catch (e) { fill(host, errLine(e, 'Departments')); return; }
    draw();
  }
  async function act(path, body, what) {
    busy = true; msg = null; draw();
    try { const r = await post(path, body); msg = { ok: true, text: r.changed === false ? 'Nothing to change: ' + r.summary : what + ' saved: ' + r.summary + '.' }; }
    catch (e) { msg = { ok: false, text: 'Not saved: ' + humanError(e) }; }
    busy = false; await load();
  }
  const pickSeat = (options, current, label) => h('select', { class: 'select', 'aria-label': label },
    options.map(([v, t]) => h('option', { value: v, selected: v === current }, t)));

  function draw() {
    const depts = (data && data.departments) || [];
    if (!depts.length) { fill(host); host.hidden = true; return; }
    host.hidden = false;
    const moveTo = [['none', 'No department']].concat(depts.map(d => [d.id, d.name]));
    const seatRow = (m, d) => {
      const sel = pickSeat(moveTo, d ? d.id : 'none', 'Move ' + m.name);
      return h('li', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap;justify-content:space-between' },
        h('span', { class: 'body-s' }, m.name + (m.isLead ? ' · lead' : '') + (m.onCrew === false ? ' · not on the crew' : '')),
        h('span', { class: 'row-8', style: 'align-items:center' }, sel,
          Button('Move', { size: 'sm', disabled: busy, aria: 'Move ' + m.name, onClick: () => sel.value !== (d ? d.id : 'none') && act('/departments/move', { seat: m.id, to: sel.value }, 'Move') })));
    };
    const cards = depts.map(d => {
      const leadSel = pickSeat([['none', 'No lead (each member\'s manager stands in)']].concat(d.members.map(m => [m.id, m.name])), d.lead || 'none', d.name + ' lead');
      return h('article', { class: 'card p20', 'aria-label': d.name },
        h('div', { class: 'stack-4' }, h('h3', { class: 'h4' }, d.name),
          h('span', { class: 'caption muted' }, (d.leadName ? 'Led by ' + d.leadName : 'No lead') + ' · ' + d.members.length + (d.members.length === 1 ? ' member' : ' members') + (d.defaultClass ? ' · ' + d.defaultClass + ' work by default' : ''))),
        h('div', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap' }, leadSel,
          Button('Set lead', { size: 'sm', variant: 'primary', disabled: busy, onClick: () => leadSel.value !== (d.lead || 'none') && act('/departments/' + encodeURIComponent(d.id) + '/lead', { seat: leadSel.value }, 'Lead') })),
        d.members.length ? h('ul', { class: 'plain stack-8' }, d.members.map(m => seatRow(m, d))) : h('p', { class: 'caption muted' }, 'No members yet.'));
    });
    const free = (data.unassigned || []);
    const drift = data.drift || { ok: true, mismatches: [] };
    fill(host,
      h('h2', { id: 'depts', class: 'h4' }, 'Departments'),
      h('p', { class: 'body-s muted' }, 'A department\'s lead is who its members go to when an item is stuck. Changes are recorded in the decision log.'),
      msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null,
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px' }, cards),
      free.length ? h('div', { class: 'card p20' }, h('h3', { class: 'h4' }, 'In no department'), h('ul', { class: 'plain stack-8' }, free.map(m => seatRow(m, null)))) : null,
      drift.ok ? h('p', { class: 'caption muted' }, 'The floor plan and the crew list agree with the departments.')
        : Details(drift.mismatches.length + (drift.mismatches.length === 1 ? ' thing does' : ' things do') + ' not agree with the floor plan or the crew list; the departments duty hands it to the people function',
          h('ul', { class: 'plain stack-4' }, drift.mismatches.map(m => h('li', { class: 'caption' }, m.msg)))));
  }
  load();
  return load;
}
