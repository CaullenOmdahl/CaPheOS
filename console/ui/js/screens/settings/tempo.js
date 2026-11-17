// Settings › Tempo and routines (#/settings/tempo[/ticks|seats|routines|log]): how often the crew wakes (the
// dispatcher tick, cooldowns, wake caps, quiet hours, the crew's bounded speed-ups), per-seat cadence, and the routines
// on the station's clock, and Sprint, the owner's start-up switch (was Controls › Ticks and cadence, and Automate). API: /api/cadence*, /api/station/cron,
// /api/dispatch (docs/TEMPO.md).
import { h, fill, Button, Tag, errLine, empty, table, rel, hhmm, Details, Setting, Block, humanError } from '../../ui.js';
import { api, post } from '../../api.js';
import * as events from '../../events.js';
import { mountPanels } from '../../panels.js';
import { parseLogLine } from '../today.js';

export async function render(host, ctx) {
  const { app } = ctx;
  const tz = app.company && app.company.timezone;
  const sprint = h('div'), now = h('div'), base = h('div'), bounds = h('div'), seats = h('div'), routines = h('div'), log = h('div'), side = h('div', { class: 'stack-16' });
  fill(host,
    Block({ id: 'sprint', title: 'Sprint', lede: 'For the start-up phase: work as fast as the open work allows, inside your spend cap.' }, sprint),
    Block({ id: 'ticks', title: 'Ticks and cadence', lede: 'The dispatcher wakes whoever owns open work, every few minutes. These are your base values; the crew may only speed up inside the bounds below, and only for a while.' }, now, base),
    Block({ id: 'bounds', title: 'What the crew may change', lede: 'The range the crew may move the tempo in on its own. Anything outside it is yours.' }, bounds),
    Block({ id: 'seats', title: 'Per-seat cadence', lede: 'How often each crew member may be woken, and what wakes them early.' }, seats),
    Block({ id: 'routines', title: 'Routines', lede: 'Work that runs on a clock, like each seat\'s regular check. Times are in ' + (tz || 'the company timezone') + '.' }, routines),
    Block({ id: 'log', title: 'Recent dispatcher activity' }, log),
    side);
  const act = async (path, b, okMsg) => {
    try { const r = await post(path, b); app.toast(okMsg || 'Saved.'); return r; }
    catch (e) { app.toast('Not saved: ' + humanError(e), true); return null; }
    finally { load(); }
  };
  const when = iso => { if (!iso) return '—'; const t = new Date(iso); return isNaN(t) ? String(iso) : t.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }); };
  const numIn = (val, label, onchange, width) => { const i = h('input', { type: 'number', min: '1', class: 'input', style: 'width:' + (width || 88) + 'px;font:var(--type-mono)', value: val ?? '', 'aria-label': label }); i.addEventListener('change', () => onchange(i.value)); return i; };
  const unit = (input, u) => h('span', { class: 'row-8', style: 'align-items:center;flex-wrap:nowrap' }, input, h('span', { class: 'body-s muted' }, u));

  // Sprint (start-up, docs/TEMPO.md "Sprint"): cadence.js sprint on|off through POST /api/cadence/sprint
  function drawSprint(d) {
    const sp = d.sprint;
    const blk = sprint.closest('section');
    if (blk) blk.hidden = !sp;   // a cadence.js without Sprint: no section at all
    if (!sp) return;
    const floorMin = (sp.config && sp.config.cooldownFloorMin) || 2;
    const hours = h('select', { class: 'select', 'aria-label': 'Sprint length', style: 'width:auto' },
      [['', 'until I turn it off'], ['4', 'for 4 hours'], ['12', 'for 12 hours'], ['24', 'for 24 hours'], ['72', 'for 3 days']].map(([v, l]) => h('option', { value: v }, l)));
    const budget = '$' + (sp.budgetUsd != null ? Number(sp.budgetUsd).toFixed(2) : '—') + (sp.budgetIsDefault ? ' (twice the daily cap)' : '');
    const turnOn = async () => {
      if (!(await app.confirmDialog({ title: 'Turn Sprint on?', confirm: 'Turn Sprint on',
        body: 'This unlocks: a crew member with new work starts as soon as it is free (resting ' + floorMin + ' min, not its cooldown), everyone may start at once, and the hourly and daily wake limits are lifted. It spends faster, up to a Sprint budget of ' + budget + '. Your daily cap, the halts, the guardrails and the subscription stops still hold.' }))) return;
      act('/cadence/sprint', { on: true, hours: hours.value || null }, 'Sprint on' + (hours.value ? ' for ' + hours.value + ' h.' : ' until you turn it off.'));
    };
    const ended = sp.endedAt ? 'Ended ' + when(sp.endedAt) + (sp.endedWhy === 'budget' ? ', when its budget was spent' : sp.endedWhy === 'certified' ? ', 24 h after certification' : sp.endedWhy === 'time' ? ', when its time was up' : '') + '.' : '';
    fill(sprint, Setting({ id: 'set-sprint-switch', title: 'Sprint', value: sp.active ? 'On' : 'Off', valueTone: sp.active ? 'warning' : 'neutral',
      what: sp.active ? 'On' + (sp.by ? ', by ' + sp.by : '') + (sp.until ? ', until ' + when(sp.until) : sp.untilWhy ? ', ' + String(sp.untilWhy).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, x => when(x)) : ', until you turn it off') + '. Crew members with new work start as soon as they are free; those with nothing to do are not woken.'
        : 'Off. ' + ended + ' The crew wakes at your base tempo below.',
      flip: sp.active ? 'Turning it off returns to your base tempo: full cooldowns and the wake limits again.' : 'Turning it on wakes the crew as fast as the work allows and lifts the wake limits, until its budget of ' + budget + ' is spent or its time is up.',
      control: sp.active ? Button('Turn off', { variant: 'secondary', size: 'sm', onClick: () => act('/cadence/sprint', { on: false }, 'Sprint off: back to your base values.') })
        : h('span', { class: 'row-8', style: 'align-items:center' }, hours, Button('Turn on…', { variant: 'primary', size: 'sm', onClick: turnOn })) }));
  }

  function drawCadence(d) {
    drawSprint(d);
    const v = x => x && typeof x === 'object' && 'value' in x ? x.value : x;
    const b = d.bounds || {}, tp = d.tempo || {}, eff = d.effective || {}, w = d.wakes || {}, tmp = d.temporary, lp = d.loop;
    const src = eff.source === 'temporary' ? ['A temporary speed-up', 'warning'] : eff.source === 'sprint' ? ['Sprint', 'warning'] : ['Your base values', 'online'];
    fill(now, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:14px' },
      h('div', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'eyebrow-t' }, 'Right now'),
        h('span', { class: 'body-l num' }, 'every ' + (eff.tickMin ?? d.dispatcherTickMin ?? '—') + ' min'),
        Tag(src[0], { variant: 'status', status: src[1] }), eff.quiet ? h('span', { class: 'caption' }, 'Quiet hours: only your own messages wake anyone.') : null),
      h('div', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'eyebrow-t' }, 'Dispatcher'),
        h('span', { class: 'body-s' }, lp ? 'Last check ' + when(lp.lastTickEndAt || lp.lastTickAt) : 'Has not reported yet'),
        lp ? h('span', { class: 'body-s' }, 'Next ' + (lp.status === 'ticking' ? 'running now' : when(lp.nextTickAt))) : null),
      w.maxPerHour != null || w.hour != null ? h('div', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'eyebrow-t' }, 'Wakes'),
        h('span', { class: 'body-s' }, (w.hour ?? 0) + ' in the last hour (cap ' + (w.maxPerHour ?? '—') + ')'),
        h('span', { class: 'body-s' }, (w.day ?? 0) + ' in 24 h (cap ' + (w.maxPerDay ?? '—') + ')'),
        h('span', { class: 'caption muted' }, 'Your own messages always get through, but they count.')) : null),
      tmp ? h('div', { class: 'alertbox', role: 'status' }, h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, (tmp.by || 'The crew') + ' sped things up until ' + when(tmp.expiresAt)),
        tmp.why ? h('span', { class: 'body-s' }, 'Why: ' + tmp.why) : null), Button('End it now', { variant: 'secondary', size: 'sm', onClick: () => act('/cadence/end-temporary', {}, 'Back to your base values.') })) : null);
    fill(base, h('div', { class: 'stack-10' },
      Setting({ id: 'set-tick', title: 'Dispatcher tick', value: d.dispatcherTickMin + ' min', what: 'How long the dispatcher waits between checks for open work.',
        flip: 'Shorter wakes the crew sooner and uses the day\'s spend and subscriptions faster; longer saves both.',
        control: unit(numIn(d.dispatcherTickMin, 'Dispatcher tick in minutes', val => act('/cadence/default', { minutes: Number(val) }, 'Tick: every ' + val + ' min.')), 'min') }),
      Setting({ id: 'set-cooldown', title: 'Default cooldown', value: d.defaultCooldownMin + ' min', what: 'The least time between two wakes of the same crew member.',
        flip: 'Shorter lets one member work in quick bursts; longer spreads the work out.',
        control: unit(numIn(d.defaultCooldownMin, 'Default cooldown in minutes', val => act('/cadence/default', { cooldown: Number(val) }, 'Cooldown: ' + val + ' min.')), 'min') }),
      Setting({ id: 'set-per-tick', title: 'Wakes per check', value: String(d.maxPerTick), what: 'The most crew members started in one check.',
        flip: 'More runs more people at once (and spends faster); fewer keeps it calm.',
        control: unit(numIn(d.maxPerTick, 'Wakes per check', val => act('/cadence/default', { maxPerTick: Number(val) }, 'Wakes per check: ' + val + '.')), 'people') })));
    const range = (key, label) => {
      const r = Array.isArray(b[key]) ? b[key] : ['', ''];
      const save = () => act('/cadence/bounds', { [key]: [Number(lo.value), Number(hi.value)] }, label + ': ' + lo.value + '–' + hi.value + ' min.');
      const lo = numIn(r[0], label + ' lowest', save, 72), hi = numIn(r[1], label + ' highest', save, 72);
      return h('span', { class: 'row-8', style: 'align-items:center' }, lo, h('span', { class: 'body-s muted' }, 'to'), hi, h('span', { class: 'body-s muted' }, 'min'));
    };
    const quiet = h('input', { type: 'text', class: 'input', style: 'width:150px;font:var(--type-mono)', value: b.quietHours || '', placeholder: '22:00-07:00', 'aria-label': 'Quiet hours' });
    quiet.addEventListener('change', () => act('/cadence/bounds', { quietHours: quiet.value.trim() || null }, quiet.value.trim() ? 'Quiet hours: ' + quiet.value.trim() + '.' : 'Quiet hours off.'));
    const mode = h('select', { class: 'select', 'aria-label': 'Who may change the tempo' },
      [['bounded-auto', 'The crew, inside these bounds'], ['fixed', 'Only you']].map(([val, label]) => h('option', { value: val, selected: tp.mode === val }, label)));
    mode.addEventListener('change', () => act('/cadence/bounds', { mode: mode.value }, mode.value === 'fixed' ? 'Only you change the tempo now.' : 'The crew may speed up inside the bounds.'));
    fill(bounds, h('div', { class: 'stack-10' },
      Setting({ id: 'set-mode', title: 'Who may speed things up', value: tp.mode === 'fixed' ? 'Only you' : 'The crew, inside bounds', what: 'Whether the crew may make a temporary change to the tempo when work piles up.',
        flip: tp.mode === 'fixed' ? 'Letting the crew do it: a speed-up lasts ' + (tp.autoExpireMin ?? 30) + ' min, at most one per ' + (tp.minChangeIntervalMin ?? 15) + ' min, then your values return.' : 'Only you: the tempo never changes unless you change it here.',
        control: mode }),
      Setting({ id: 'set-tick-bounds', title: 'Tick range', value: (b.tickMin || []).join('–') + ' min', what: 'How short or long the crew may make the dispatcher tick.', control: range('tickMin', 'Tick range') }),
      Setting({ id: 'set-cool-bounds', title: 'Cooldown range', value: (b.cooldownMin || []).join('–') + ' min', what: 'How short or long the crew may make a member\'s cooldown.', control: range('cooldownMin', 'Cooldown range') }),
      Setting({ id: 'set-wakes', title: 'Wake caps', value: (b.maxWakesPerHour ?? '—') + ' an hour · ' + (b.maxWakesPerDay ?? '—') + ' a day', what: 'The most wakes in an hour and in a day, however busy it gets.',
        flip: 'Higher lets a busy day run on; lower caps the day\'s activity.',
        control: h('span', { class: 'row-8' }, unit(numIn(b.maxWakesPerHour, 'Wakes per hour', val => act('/cadence/bounds', { maxWakesPerHour: Number(val) }, 'Wakes per hour: ' + val + '.')), '/ hour'),
          unit(numIn(b.maxWakesPerDay, 'Wakes per day', val => act('/cadence/bounds', { maxWakesPerDay: Number(val) }, 'Wakes per day: ' + val + '.')), '/ day')) }),
      Setting({ id: 'set-quiet', title: 'Quiet hours', value: b.quietHours || 'Off', what: 'Company time when nobody is woken except by your own messages.', flip: b.quietHours ? 'Clear the box to switch quiet hours off.' : 'Type a range like 22:00-07:00 to let the company rest at night.', control: quiet }),
      Setting({ id: 'set-speedup', title: 'Speed-up length', value: (tp.autoExpireMin ?? 30) + ' min, ' + (tp.minChangeIntervalMin ?? 15) + ' min apart', what: 'How long a crew speed-up lasts, and how far apart two may be.',
        control: h('span', { class: 'row-8' }, unit(numIn(tp.autoExpireMin, 'Speed-up length', val => act('/cadence/bounds', { autoExpireMin: Number(val) }, 'Speed-ups last ' + val + ' min.')), 'min'),
          unit(numIn(tp.minChangeIntervalMin, 'Least time between speed-ups', val => act('/cadence/bounds', { minChangeIntervalMin: Number(val) }, 'Speed-ups at least ' + val + ' min apart.')), 'apart')) })),
      (d.changes || []).length ? Details('Recent tempo changes', table(['When', 'Who', 'What', 'Why'], d.changes.map(c => h('tr', null, h('td', { class: 'num' }, when(c.at)), h('td', null, c.by || '—'), h('td', null, c.what || ''), h('td', { class: 'muted' }, c.why || '—'))), { minWidth: 560 })) : null);
    const seatRows = Object.entries(d.seats || {});
    const onoff = (seat, field, val, label) => h('label', { class: 'check', style: 'min-height:44px' },
      h('input', { type: 'checkbox', checked: !!val, 'aria-label': label, onchange: e => act('/cadence/seat', { seat, [field]: e.target.checked }) }), val ? 'Yes' : 'No');
    const num = (seat, field, val, label) => h('input', { type: 'number', class: 'input', style: 'width:88px;font:var(--type-mono)', value: val == null ? '' : val, 'aria-label': label,
      onchange: e => act('/cadence/seat', { seat, [field]: e.target.value === '' ? null : Number(e.target.value) }) });
    fill(seats, seatRows.length ? table(['Crew member', 'Own routine', 'Cooldown (min)', 'Priority', 'Woken by handed work', 'Woken by your message'], seatRows.map(([id, s]) => h('tr', null,
      h('th', { scope: 'row', class: 'label strong' }, s.name || id),
      h('td', { class: 'num' }, s.loopEvery || (s.loop ? 'yes' : '—')),
      h('td', null, num(id, 'cooldown', v(s.cooldownMin), (s.name || id) + ' cooldown')),
      h('td', null, num(id, 'priority', v(s.priority), (s.name || id) + ' priority')),
      h('td', null, onoff(id, 'wakeOnInbox', v(s.wakeOnInbox), (s.name || id) + ' woken by handed work')),
      h('td', null, onoff(id, 'wakeOnOwner', v(s.wakeOnOwnerMessage), (s.name || id) + ' woken by your message')))), { minWidth: 820 }) : empty('No crew in the cadence yet.'),
      h('p', { class: 'caption muted' }, 'A higher priority is woken first. Changes apply within a minute.'),
      (d.unknownSeats || []).length ? Details('Details', h('p', { class: 'caption' }, 'Listed in the cadence but not on the crew: ' + d.unknownSeats.join(', '))) : null,
      d.file ? Details('Details', h('p', { class: 'caption mono-s' }, 'Saved to ' + d.file + '; guide: docs/TEMPO.md')) : null);
  }

  let older = [], olderCursor, expanded = false;
  async function drawRoutines() {
    let cron;
    try { cron = await api('/station/cron'); } catch (e) { fill(routines, errLine(e, 'Routines')); return; }
    const jobs = cron.jobs || [];
    fill(routines,
      cron.halted ? h('p', { class: 'body-s danger' }, 'The company is halted, so no routine runs.') : cron.enabled === false ? h('p', { class: 'body-s danger' }, 'The station\'s scheduler is off, so no routine runs.') : null,
      jobs.length ? table(['Routine', 'Crew member', 'When', 'State', ''], jobs.map(j => {
        const st = !j.enabled ? ['Off', 'neutral'] : j.lastStatus === 'error' || j.lastError ? ['Failing', 'danger'] : j.inFlight ? ['Running', 'online'] : ['Ready', 'online'];
        const rowErr = h('span', { class: 'err-line' });
        return h('tr', null, h('th', { scope: 'row', class: 'label strong' }, j.name || j.id), h('td', null, j.agentName || j.agentId || '—'),
          h('td', { class: 'num' }, j.scheduleDisplay || j.schedule || '—', j.nextRunAt || j.nextFireAt ? h('span', { class: 'caption muted', style: 'display:block' }, 'next ' + rel(j.nextRunAt || j.nextFireAt)) : null),
          h('td', null, Tag(st[0], { variant: 'status', status: st[1] })),
          h('td', { style: 'white-space:nowrap' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => {
            if (!(await app.confirmDialog({ title: 'Run "' + (j.name || j.id) + '" now?', body: 'It starts at once, outside its clock. It counts against the day\'s spend like any run.', confirm: 'Run now' }))) return;
            try { await post('/station/cron/run', { id: j.id }); app.toast('Started.'); } catch (e) { rowErr.textContent = humanError(e); }
          } }, 'Run now'), rowErr));
      }), { minWidth: 720 }) : empty('No routines on the station yet.'),
      jobs.some(j => j.model) ? Details('Details', h('ul', { class: 'plain caption mono-s' }, jobs.map(j => h('li', null, (j.name || j.id) + ' · ' + (j.model || '?') + (j.lastError ? ' · last error: ' + String(j.lastError).slice(0, 200) : ''))))) : null);
  }
  async function drawLog() {
    let disp; try { disp = await api('/dispatch'); } catch (e) { fill(log, errLine(e, 'Dispatcher')); return; }
    const lines = (disp.log || []).map(parseLogLine).filter(x => x.text);
    if (olderCursor === undefined) olderCursor = disp.more ? disp.cursor : null;
    const shown = expanded ? older.concat(lines) : lines.slice(-12);
    const canMore = expanded ? olderCursor != null : (lines.length > 12 || olderCursor != null);
    const loadOlder = async () => {
      if (!expanded) { expanded = true; if (lines.length > 12) return drawLog(); }
      try { const d = await api('/dispatch?cursor=' + olderCursor); older = (d.log || []).map(parseLogLine).filter(x => x.text).concat(older); olderCursor = d.more ? d.cursor : null; drawLog(); }
      catch (e) { log.appendChild(errLine(e, 'Dispatcher')); }
    };
    fill(log, shown.length ? Details('Show the last ' + shown.length + ' entries', h('ol', { class: 'timeline' }, shown.slice().reverse().map(e => h('li', null, h('span', { class: 'mono muted' }, e.at || ''), h('span', { class: 'body-s' }, e.text)))),
      canMore ? Button('Load older', { size: 'sm', onClick: loadOlder }) : null)
      : h('p', { class: 'body-s muted' }, 'Nothing yet.'),
      disp.state && (disp.state.lastTick || disp.state.at) ? h('p', { class: 'caption muted' }, 'Last check ' + rel(disp.state.lastTick || disp.state.at) + (tz ? ' (' + hhmm(disp.state.lastTick || disp.state.at, tz) + ')' : '') + '.') : null);
  }
  async function load() {
    try { drawCadence(await api('/cadence')); } catch (e) { fill(now, errLine(e, 'Tempo')); fill(base); }
    drawRoutines(); drawLog();
  }
  load();
  const stopPanels = mountPanels(side, 'side:automate', app);
  const off = events.on(['cadence', 'dispatch'], load);
  return () => { off(); stopPanels(); };
}
