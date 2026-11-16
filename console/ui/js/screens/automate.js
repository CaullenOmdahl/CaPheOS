// Automate (Automate.dc.html): dispatcher stats, station schedules (cron), workflow/loop/away cards.
import { h, fill, Tag, errLine, empty, screenHead, table, rel, hhmm, NOT_CONNECTED } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { parseLogLine } from './today.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main';
  const tz = app.company && app.company.timezone;
  const head = h('div'), stats = h('div'), sched = h('div'), log = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head,
    h('section', { 'aria-labelledby': 'disp' }, h('h2', { id: 'disp', class: 'sr-only' }, 'Dispatcher'), stats),
    h('section', { 'aria-labelledby': 'sched', class: 'stack-14' },
      h('div', { class: 'between' }, h('h2', { id: 'sched', class: 'h3' }, 'Schedules'), h('span', { class: 'caption muted' }, 'Times in ' + (tz || 'the company timezone') + '. The pacer may move a routine to another model.')),
      sched),
    h('section', { class: 'stack-14' }, h('h2', { class: 'h3' }, 'Dispatch log'), log),
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px' },
      kind('Workflows', 'Conveyor lines: a job moves down a line of stations, each with a step, a test and a trigger.'),
      kind('Goal loops', 'A standing objective that repeats until its check passes, with a verdict gate.'),
      kind('Away work', 'What the crew does while you are away: queue, grants, morning report, keep, later or discard.')),
    side);
  let cron = null, cad = null;
  async function load() {
    let disp = null;
    try { disp = await api('/dispatch'); } catch (e) { fill(log, errLine(e, 'Dispatch')); }
    try { cad = await api('/cadence'); } catch (_) {}
    try { cron = await api('/station/cron'); } catch (e) { cron = { error: e }; }
    const jobs = (cron && cron.jobs) || [];
    fill(head, screenHead({ eyebrow: [cron && !cron.error ? jobs.length + ' routines' : null, cad ? 'Dispatcher every ' + cad.dispatcherTickMin + ' min' : null], title: 'Automate.',
      lede: 'Routines run on a clock. The dispatcher wakes whoever owns open work in between' + (cad ? ', every ' + cad.dispatcherTickMin + ' minutes.' : '.'), max: '640px' }));
    const s = (disp && disp.state) || {};
    const lines = ((disp && disp.log) || []).map(parseLogLine).filter(x => x.text);
    const lastAt = s.lastTick || s.at || s.lastRun;
    fill(stats, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px' },
      stat('Last tick', lastAt ? hhmm(lastAt, tz) : lines.length ? lines[lines.length - 1].at || '—' : '—', lastAt ? rel(lastAt) : lines.length ? lines[lines.length - 1].text.slice(0, 60) : 'no tick recorded'),
      stat('Tick', cad ? cad.dispatcherTickMin + ' min' : '—', 'Controls › Ticks and cadence'),
      stat('Wakes per tick', cad ? String(cad.maxPerTick) : '—', 'most seats started in one tick'),
      stat('Scheduler', cron && !cron.error ? (cron.halted ? 'Halted' : cron.enabled === false ? 'Off' : 'On') : '—', cron && cron.error ? (cron.error.stationDown ? 'Station not running' : cron.error.message) : cron && cron.degraded ? 'degraded: ' + (cron.degraded.reason || '') : 'station cron')));
    if (cron && cron.error) fill(sched, errLine(cron.error, 'Schedules'));
    else fill(sched, jobs.length ? table(['Routine', 'Seat', 'When', 'Model', 'State', ''], jobs.map(j => {
      const st = !j.enabled ? ['Off', 'neutral'] : j.lastStatus === 'error' || j.lastError ? ['Failing', 'danger'] : j.inFlight ? ['Running', 'online'] : ['Armed', 'online'];
      const rowErr = h('span', { class: 'err-line' });
      return h('tr', null, h('td', { class: 'label strong' }, j.name || j.id), h('td', null, j.agentId || '—'),
        h('td', { class: 'num' }, j.scheduleDisplay || j.schedule || '—', j.nextRunAt || j.nextFireAt ? h('span', { class: 'caption muted', style: 'display:block' }, 'next ' + rel(j.nextRunAt || j.nextFireAt)) : null),
        h('td', { class: 'num' }, j.model || '—'), h('td', null, Tag(st[0], { variant: 'status', status: st[1] })),
        h('td', { style: 'white-space:nowrap' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => {
          if (!(await app.confirmDialog({ title: 'Run "' + (j.name || j.id) + '" now?', confirm: 'Run now' }))) return;
          try { await post('/station/cron/run', { id: j.id }); app.toast('Started.'); } catch (e) { rowErr.textContent = e.message; }
        } }, 'Run now'), rowErr));
    }), { minWidth: 820 }) : empty('No routines on the station.'));
    fill(log, lines.length ? h('ol', { class: 'timeline' }, lines.slice(-15).reverse().map(e => h('li', null, h('span', { class: 'mono muted' }, e.at || ''), h('span', { class: 'body-s' }, e.text))))
      : (log.firstChild ? log.firstChild : empty('Nothing in the dispatch log yet.')));
  }
  load();
  const stopPanels = mountPanels(side, 'side:automate', app);
  const off = events.on(['dispatch', 'cadence'], load);
  return () => { off(); stopPanels(); };
}
function stat(l, v, n) { return h('div', { class: 'card p18', style: 'gap:6px' }, h('span', { class: 'eyebrow-t' }, l), h('span', { class: 'big-num-30' }, v), h('span', { class: 'caption muted' }, n)); }
function kind(t, w) { return h('article', { class: 'card p22', style: 'gap:12px' }, h('h3', { class: 'h4' }, t), h('p', { class: 'body-s muted' }, w), h('p', { class: 'caption muted', style: 'margin-top:auto' }, NOT_CONNECTED)); }
