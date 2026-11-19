// Crew › People › Departments (console/departments.js, docs/DEPARTMENTS.md): each department, its lead and its members,
// the seats in none, and whether FLOOR_PLAN.md agrees. The owner sets a lead or moves a seat here; every change runs
// company/tools/departments.js as the owner, which checks and records it. Nothing shows while the company has no
// departments (they are created by the CEO or the people function; the section then says so in one line).
// A department with a lead also shows the lead's advice (docs/DEPARTMENTS.md §5): the switch Off / Recording only / On
// (On asks first), Pause and Resume, "Asked the lead today", the last advice, and the brief the lead keeps, folded and read
// only, under "What the team is working on". The words are in crew-departments-words.js (checked plain by a test).
// And whether the lead may split big jobs (docs/DEPARTMENTS.md §6): "Splitting big jobs: Off · Recording only · On" (On asks
// first), how many people the lead can hand parts to, and, when the crew stopped it because it did not save money, why and
// a Resume button.
import { h, fill, Button, Tag, errLine, humanError, Details, when as whenAt } from '../ui.js';
import { api, post } from '../api.js';
import * as WD from './crew-departments-words.js';

export function departmentsSection(host, app) {
  let data = null, msg = null, busy = false; const desks = {};
  const tz = app && app.company && app.company.timezone;
  async function confirmed(o) { return !(app && app.confirmDialog) || app.confirmDialog(o); }
  async function load() {
    try { data = await api('/departments'); } catch (e) { fill(host, errLine(e, 'Departments')); return; }
    await Promise.all(((data && data.departments) || []).filter(d => d.lead).map(async d => { try { desks[d.id] = await api('/departments/' + encodeURIComponent(d.id) + '/lead-desk'); } catch (_) { desks[d.id] = null; } }));
    draw();
  }
  async function act(path, body, what) {
    busy = true; msg = null; draw();
    try { const r = await post(path, body); msg = { ok: true, text: r.changed === false ? 'Nothing to change: ' + r.summary : /\/(advisor|delegation)$/.test(path) ? WD.savedLine(what) : what + ' saved: ' + r.summary + '.' }; }
    catch (e) { msg = { ok: false, text: 'Not saved: ' + humanError(e) }; }
    busy = false; await load();
  }
  // the lead's advice on one department card (nothing while the department has no lead)
  function adviceBlock(d) {
    if (!d.lead) return null;
    const lead = d.leadName || 'the lead', ad = d.advisor || { mode: 'off' }, desk = desks[d.id] || {}, info = desk.desk || {};
    const mode = ad.mode || 'off', [label, tone] = WD.ADVICE_SAY[mode] || WD.ADVICE_SAY.off;
    const path = '/departments/' + encodeURIComponent(d.id) + '/advisor';
    const switchRow = h('div', { class: 'row-8', role: 'group', 'aria-label': WD.SWITCH_LABEL + ': ' + d.name, style: 'flex-wrap:wrap;align-items:center' },
      h('span', { class: 'body-s' }, WD.SWITCH_LABEL + ':'),
      ['off', 'shadow', 'live'].map(m => Button(WD.ADVICE_SAY[m][0], { size: 'sm', variant: m === mode ? 'primary' : undefined, disabled: busy || m === mode, aria: WD.SWITCH_LABEL + ': ' + WD.ADVICE_SAY[m][0],
        onClick: async () => { if (m === 'live' && !(await confirmed({ title: WD.onTitle(lead), body: WD.onConfirm(lead), confirm: 'Turn it on' }))) return; act(path, { mode: m }, WD.SWITCH_LABEL + ': ' + WD.ADVICE_SAY[m][0].toLowerCase()); } })));
    const pauseBtn = mode === 'live' ? (ad.paused
      ? Button('Resume', { size: 'sm', variant: 'primary', disabled: busy, onClick: async () => { if (!(await confirmed({ title: WD.resumeTitle(), body: WD.resumeConfirm(), confirm: 'Turn it back on' }))) return; act(path, { resume: true }, 'The lead\'s advice is back on'); } })
      : Button('Pause', { size: 'sm', disabled: busy, onClick: async () => { if (!(await confirmed({ title: WD.pauseTitle(lead), body: WD.pauseConfirm(), confirm: 'Pause' }))) return; act(path, { pause: true, why: 'the owner paused it' }, 'The lead\'s advice is paused'); } })) : null;
    const brief = desk.brief != null && String(desk.brief).trim() ? Details(WD.BRIEF_TITLE, h('pre', { class: 'body-s', style: 'white-space:pre-wrap;margin:0' }, String(desk.brief))) : h('p', { class: 'caption muted' }, WD.noBriefLine());
    const tech = [ad.paused && ad.paused.why ? 'paused: ' + ad.paused.why : null, ad.since ? 'measured since ' + ad.since : null, info.nextWhy ? 'next advice: ' + info.nextWhy : null,
      info.evaluation ? 'evaluation: ' + info.evaluation.verdict + ((info.evaluation.failed || []).length ? ' (' + info.evaluation.failed.join('; ') + ')' : '') : null].filter(Boolean);
    return h('div', { class: 'stack-8' },
      h('p', { class: 'body-s' }, WD.leadLine(lead)),
      h('div', { class: 'row-8', style: 'flex-wrap:wrap;align-items:center' }, switchRow, Tag(ad.paused ? 'Paused' : label, { variant: 'status', status: ad.paused ? 'warning' : tone }), pauseBtn),
      mode === 'shadow' ? h('p', { class: 'caption muted' }, WD.recordingLine(lead)) : null,
      ad.paused ? h('p', { class: 'caption', role: 'status' }, WD.pausedLine(ad.paused, lead, d.name)) : null,
      mode !== 'off' ? h('p', { class: 'caption muted' }, WD.askedLine(info.today, info.maxPerDay != null ? info.maxPerDay : (d.consultLimits || {}).maxPerDay), ' ', WD.lastAdviceLine(info.lastAdviceAt ? whenAt(info.lastAdviceAt, tz) : null)) : null,
      brief,
      tech.length ? Details(WD.TECH, h('ul', { class: 'plain stack-4 caption mono-s' }, tech.map(t => h('li', null, t)))) : null);
  }
  // splitting big jobs on one department card (nothing while the department has no lead)
  function splitBlock(d) {
    if (!d.lead) return null;
    const lead = d.leadName || 'the lead', g = d.delegation || { mode: 'off' }, mode = g.mode || 'off', [label, tone] = WD.SPLIT_SAY[mode] || WD.SPLIT_SAY.off;
    const path = '/departments/' + encodeURIComponent(d.id) + '/delegation';
    const row = h('div', { class: 'row-8', role: 'group', 'aria-label': WD.SPLIT_LABEL + ': ' + d.name, style: 'flex-wrap:wrap;align-items:center' },
      h('span', { class: 'body-s' }, WD.SPLIT_LABEL + ':'),
      ['off', 'shadow', 'live'].map(m => Button(WD.SPLIT_SAY[m][0], { size: 'sm', variant: m === mode ? 'primary' : undefined, disabled: busy || m === mode, aria: WD.SPLIT_LABEL + ': ' + WD.SPLIT_SAY[m][0],
        onClick: async () => { if (m === 'live' && !(await confirmed({ title: WD.splitOnTitle(lead), body: WD.splitOnConfirm(lead), confirm: 'Turn it on' }))) return; act(path, { mode: m }, WD.SPLIT_LABEL + ': ' + WD.SPLIT_SAY[m][0].toLowerCase()); } })),
      Tag(g.withdrawn ? 'Stopped' : label, { variant: 'status', status: g.withdrawn ? 'warning' : tone }),
      g.withdrawn ? Button('Resume', { size: 'sm', variant: 'primary', disabled: busy, onClick: async () => { if (!(await confirmed({ title: WD.splitResumeTitle(), body: WD.splitResumeConfirm(), confirm: 'Start again' }))) return; act(path, { resume: true }, 'Splitting big jobs is back on'); } }) : null);
    const n = Math.min(Number(g.maxWorkers) || 0, (g.workers || []).length);
    const tech = [(g.workers || []).length ? 'workers: ' + g.workers.join(', ') : null, 'at most ' + (g.maxWorkers || 0) + ' at once, ' + (g.workerTimeoutMin || 0) + ' min each', g.withdrawn && g.withdrawn.why ? 'stopped: ' + g.withdrawn.why : null, g.since ? 'measured since ' + g.since : null].filter(Boolean);
    return h('div', { class: 'stack-8' }, row,
      mode !== 'off' ? h('p', { class: 'caption muted' }, n ? WD.splitLine(lead, n) : WD.splitNobodyLine(lead)) : null,
      mode === 'shadow' && !g.withdrawn ? h('p', { class: 'caption muted' }, WD.splitRecordingLine(lead)) : null,
      g.withdrawn ? h('p', { class: 'caption', role: 'status' }, WD.splitWithdrawnLine(g.withdrawn, d.name)) : null,
      mode !== 'off' ? Details(WD.TECH, h('ul', { class: 'plain stack-4 caption mono-s' }, tech.map(t => h('li', null, t)))) : null);
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
        adviceBlock(d),
        splitBlock(d),
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
