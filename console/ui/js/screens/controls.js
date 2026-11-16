// Controls (Controls.dc.html): self-governance, guardrails, ticks and cadence, console panels.
import { h, fill, Button, Tag, errLine, empty, tabs, screenHead, table, statusOf } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';

export const PRESET_WHAT = {
  'approve-everything': 'Every decision waits for you',
  'gate-money-people': 'You approve hires and money; the rest is reported',
  'gate-money': 'You approve money; the crew hires and reports',
  'autonomous': 'The crew hires and budgets itself; gates still hold',
};
const CAT_NAMES = { hiring: 'Hiring', release: 'Releasing someone', budget: 'Budgeting', spend: 'Spend inside the cap', models: 'Model changes',
  tools: 'Tool and policy changes', schedules: 'Schedules and ticks', external: 'Acting outside', dashboard: 'Console panels', packs: 'Capability packs' };
const CAT_SEAT = { hiring: 'People', release: 'People', budget: 'Finance', spend: 'Finance', models: 'People', tools: 'Tools', schedules: 'Tools', external: 'CEO', dashboard: 'Tools', packs: 'CEO' };
export const GUARD_NAMES = { ownerGates: 'Owner gates', spendCap: 'Spend cap', externalActions: 'External actions', harnessSelfEdit: 'Harness self-edit',
  defaultBranch: 'Default branch', secrets: 'Secrets', localComputer: 'Local computer', privilegedShell: 'Privileged shell', promptInjection: 'Injection tripwire', halt: 'Halt' };
const CONFIRM = 'I understand there are no guardrails';
const LEVELS = [['auto', 'Crew decides'], ['notify', 'Decides, tells you'], ['triage', 'Model triages'], ['approve', 'You approve']];
// Triage is offered only for self-governed categories (never the fixed owner gates); the server's /governance/set passes
// the level to governance.js, which accepts it. Decision models: GET /api/decision-models -> decide.js list --json.

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-32';
  let tab = ctx.rest[0] || 'gov';
  const eyebrowHost = h('div');
  const tabsHost = h('div');
  const body = h('div', { class: 'stack-14', style: 'gap:32px' });
  fill(root, h('header', { class: 'stack-12', style: 'max-width:760px' }, eyebrowHost,
    h('h1', { class: 'h1' }, 'Controls.'),
    h('p', { class: 'body-l muted' }, 'How much the company decides alone, what it can never do, how often it wakes, and what it may add to this console.')),
    tabsHost, body);
  let gov = null, guards = null;
  const eyebrow = () => fill(eyebrowHost, h('p', { class: 'eyebrow' }, [gov ? 'Preset: ' + (gov.presetLabel || gov.preset) : null,
    guards ? ((guards.off || []).length ? guards.off.length + ' guardrails off' : 'All guardrails on') : null].filter(Boolean).join(' / ')));
  const pick = id => { tab = id; history.replaceState(null, '', '#/controls/' + id); drawTabs(); load(); };
  const drawTabs = () => fill(tabsHost, tabs([['gov', 'Self-governance'], ['guard', 'Guardrails'], ['ticks', 'Ticks and cadence'], ['panels', 'Console panels']], tab, pick, 'Controls'));
  drawTabs();
  const act = async (path, b, okMsg) => {
    try { const r = await post(path, b); app.toast(okMsg || 'Saved.'); return r; }
    catch (e) { app.toast(e.message, true); return null; }
    finally { load(); }
  };

  async function load() {
    // header numbers come from both stores
    api('/governance').then(d => { gov = d; eyebrow(); }).catch(() => {});
    api('/guardrails').then(d => { guards = d; eyebrow(); }).catch(() => {});
    try {
      if (tab === 'gov') return drawGov(await api('/governance'));
      if (tab === 'guard') return drawGuards(await api('/guardrails'));
      if (tab === 'ticks') return drawTicks(await api('/cadence'));
      if (tab === 'panels') return drawPanels(await api('/panels'));
    } catch (e) { fill(body, errLine(e, 'Could not load')); }
  }

  function drawGov(d) {
    gov = d; eyebrow();
    const presets = d.presets || Object.keys(PRESET_WHAT).map(id => ({ id, label: id }));
    const levelOf = {}; for (const c of d.categories || []) levelOf[c.category] = c.level;
    fill(body,
      h('section', { 'aria-labelledby': 'presets', class: 'stack-14' },
        h('h2', { id: 'presets', class: 'h4' }, 'Self-governance'),
        h('div', { role: 'radiogroup', 'aria-label': 'Preset', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px' },
          presets.map(p => h('button', { type: 'button', role: 'radio', 'aria-checked': p.id === d.preset ? 'true' : 'false', class: 'choice',
            onclick: () => p.id !== d.preset && act('/governance/preset', { preset: p.id }, 'Preset: ' + p.label) },
            h('span', { class: 'label' }, p.label), h('span', { class: 'caption' }, PRESET_WHAT[p.id] || ''))),
          d.preset === 'custom' || !presets.some(p => p.id === d.preset) ? h('div', { class: 'choice', 'aria-checked': 'true', role: 'radio' }, h('span', { class: 'label' }, 'Custom'), h('span', { class: 'caption' }, 'Set per category below')) : null)),
      table(['Decision', 'Decided by'].concat(LEVELS.map(l => l[1])),
        (d.categories || []).map(c => h('tr', null,
          h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, CAT_NAMES[c.category] || c.category), h('span', { class: 'caption muted' }, c.what || '')),
          h('td', { class: 'muted' }, CAT_SEAT[c.category] || '—'),
          LEVELS.map(([l]) => l === 'triage' && (d.fixed || []).some(f => f.category === c.category) ? h('td', { class: 'subtle' }, '—') : h('td', null, h('button', { type: 'button', class: 'level-btn', 'aria-pressed': c.level === l ? 'true' : 'false', 'aria-label': (CAT_NAMES[c.category] || c.category) + ': ' + l,
            onclick: () => c.level !== l && act('/governance/set', { category: c.category, level: l }, (CAT_NAMES[c.category] || c.category) + ': ' + l) }, c.level === l ? '●' : '○')))))
          .concat([h('tr', { style: 'background:var(--bg-sunken)' },
            h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, 'Access, ownership, commitments, spend beyond the cap'),
              h('span', { class: 'caption muted' }, 'The four owner gates. Loosened only by switching off the Owner gates guardrail' + (d.ownerGatesGuardrail ? ' (now ' + d.ownerGatesGuardrail + ')' : '') + '.')),
            h('td', { class: 'muted' }, '—'), h('td', { class: 'subtle' }, '—'), h('td', { class: 'subtle' }, '—'), h('td', { class: 'subtle' }, '—'), h('td', { class: 'label strong' }, 'Always'))])),
      modelsHost);
    drawModels();
  }

  // Decision models: deterministic rules the company runs instead of an LLM (docs/DECISION-MODELS.md). Read-only here;
  // the owner promotes a version or sets a threshold from their shell (decide.js promote|set-param --by owner).
  const modelsHost = h('section', { 'aria-labelledby': 'dmodels', class: 'stack-14' });
  async function drawModels() {
    const head = [h('h2', { id: 'dmodels', class: 'h4' }, 'Decision models'),
      h('p', { class: 'body-s muted', style: 'max-width:720px' }, 'Rules, not prompts: each one turns facts into an action, is versioned and tested, and logs every evaluation. A category at “Model triages” asks gate-triage; in shadow mode it always asks you and records what it would have done. Promote or set thresholds with decide.js promote|set-param --by owner.')];
    let d;
    try { d = await api('/decision-models'); }
    catch (e) { return fill(modelsHost, head, h('p', { class: 'caption muted' }, e.status === 404 ? 'Not wired in this console yet (GET /api/decision-models runs decide.js list --json).' : 'Could not load decision models: ' + e.message)); }
    const rows = d.models || [];
    const params = p => Object.entries(p || {}).map(([k, v]) => k + ' ' + v).join(', ') || '—';
    fill(modelsHost, head, rows.length ? table(['Model', 'Version', 'Mode', 'Thresholds', 'Cases', 'Evaluations', 'Last'], rows.map(m => h('tr', null,
      h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, m.title || m.id), h('span', { class: 'mono-s subtle' }, m.id)),
      h('td', { class: 'num' }, 'v' + (m.active || '?') + (m.versions && m.versions.length > 1 ? ' of ' + m.versions.join(', ') : '')),
      h('td', null, m.valid === false ? Tag('Invalid', { variant: 'status', status: 'danger' }) : Tag(m.mode === 'live' ? 'Live' : 'Shadow', { variant: 'status', status: m.mode === 'live' ? 'online' : 'neutral' })),
      h('td', { class: 'mono-s' }, params(m.params)), h('td', { class: 'num' }, String(m.cases || 0)), h('td', { class: 'num' }, String(m.evaluations || 0)),
      h('td', { class: 'caption muted' }, m.lastAt ? String(m.lastAt).replace('T', ' ').slice(0, 16) : '—'))), { minWidth: 720 }) : empty('No decision models.'));
  }

  function drawGuards(d) {
    guards = d; eyebrow();
    const off = (d.guards || []).filter(g => !g.on);
    fill(body,
      off.length ? h('div', { role: 'alert', class: 'between', style: 'padding:16px 20px;border-radius:var(--radius-lg);background:var(--status-danger-tint);color:var(--ink-900)' },
        h('span', { class: 'label' }, off.length + ' guardrails off. ' + (d.sandbox ? 'The station is marked as sandboxed.' : 'The station is not marked as sandboxed.')),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'color:var(--status-danger)', onclick: () => act('/guardrails/sandbox', { on: !d.sandbox }, d.sandbox ? 'Sandbox mark removed.' : 'Marked as running in a container.') },
          d.sandbox ? 'Unmark container' : 'Mark as running in a container')) : null,
      d.banner ? h('p', { class: 'body-s danger' }, String(d.banner)) : null,
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px' },
        (d.guards || []).map(g => {
          const name = GUARD_NAMES[g.name] || g.name;
          const sw = h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': g.on ? 'true' : 'false', 'aria-label': name, disabled: g.fixed,
            onclick: async () => {
              let why;
              if (g.on) { const ok = await app.confirmDialog({ title: 'Switch off ' + name + '?', body: 'Off: ' + (String(g.blocks || '').split('Off:')[1] || 'this stop no longer holds.').trim(), confirm: 'Switch off', danger: true }); if (!ok) return; why = 'owner, from the console'; }
              act('/guardrails/set', { name: g.name, on: !g.on, why }, name + (g.on ? ' off' : ' on'));
            } }, h('span', { class: 'knob' }));
          return h('div', { class: 'card p18', style: 'flex-direction:row;gap:16px;align-items:flex-start;padding:18px 20px' },
            h('div', { class: 'stack-6', style: 'flex:1' },
              h('span', { class: 'label strong' }, name, g.fixed ? h('span', { class: 'caption muted' }, ' · always on') : null),
              h('span', { class: 'body-s muted' }, String(g.blocks || '').split(' Off:')[0]),
              h('span', { class: 'mono-s subtle' }, (g.enforcedIn || []).map(f => f.replace(/^company\/tools\//, '')).join(' · ')),
              g.note ? h('span', { class: 'caption muted' }, g.note) : null),
            sw);
        })),
      h('div', { class: 'row-8' },
        Button('All guardrails on', { variant: 'secondary', size: 'sm', onClick: () => act('/guardrails/all', { on: true }, 'All guardrails on.') }),
        Button('Run with no guardrails…', { variant: 'ghost', size: 'sm', onClick: async () => {
          const ok = await app.confirmDialog({ title: 'Run with no guardrails?', danger: true, confirm: 'Switch everything off', typed: CONFIRM,
            body: 'Every switch except halt goes off: owner gates, spend cap, external gate, harness self-edit, default branch, secrets, local computer, privileged shell and the injection tripwire. Only do this on a machine you can throw away.' });
          if (ok) act('/guardrails/all', { on: false, confirm: CONFIRM }, 'All guardrails off.');
        } })));
  }

  function drawTicks(d) {
    // base values: the owner's tempo; the crew can only make a temporary change inside the bounds below
    const defaults = [
      ['dispatcherTickMin', 'minutes', 'Dispatcher tick', 'minutes', 'How long the dispatcher loop sleeps between ticks.'],
      ['defaultCooldownMin', 'cooldown', 'Default cooldown', 'minutes', 'Least time between two wakes of one seat.'],
      ['maxPerTick', 'maxPerTick', 'Wakes per tick', 'seats', 'Most seats started in one tick.'],
    ];
    const err = h('p', { class: 'err-line', role: 'status' });
    const seatRows = Object.entries(d.seats || {});
    const v = x => x && typeof x === 'object' && 'value' in x ? x.value : x;
    const b = d.bounds || {}, tp = d.tempo || {}, eff = d.effective || {}, w = d.wakes || {}, tmp = d.temporary, lp = d.loop;
    const when = iso => { if (!iso) return '—'; const t = new Date(iso); return isNaN(t) ? iso : t.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }); };
    const onoff = (seat, field, val) => h('label', { class: 'check', style: 'min-height:44px' },
      h('input', { type: 'checkbox', checked: !!val, onchange: e => act('/cadence/seat', { seat, [field]: e.target.checked }) }), val ? 'On' : 'Off');
    const num = (seat, field, val, label) => h('input', { type: 'number', class: 'input', style: 'width:96px;font:var(--type-mono)', value: val == null ? '' : val, 'aria-label': label,
      onchange: e => act('/cadence/seat', { seat, [field]: e.target.value === '' ? null : Number(e.target.value) }) });
    const numIn = (val, label, onchange, width) => { const i = h('input', { type: 'number', min: '1', class: 'input', style: 'width:' + (width || 80) + 'px;font:var(--type-mono)', value: val ?? '', 'aria-label': label }); i.addEventListener('change', () => { err.textContent = ''; onchange(i.value); }); return i; };
    const range = (key, label) => {
      const r = Array.isArray(b[key]) ? b[key] : ['', ''];
      const lo = numIn(r[0], label + ' low', () => act('/cadence/bounds', { [key]: [Number(lo.value), Number(hi.value)] }, label + ': ' + lo.value + '–' + hi.value + ' min'));
      const hi = numIn(r[1], label + ' high', () => act('/cadence/bounds', { [key]: [Number(lo.value), Number(hi.value)] }, label + ': ' + lo.value + '–' + hi.value + ' min'));
      return h('span', { class: 'row-8', style: 'align-items:center' }, lo, h('span', { class: 'body-s muted' }, 'to'), hi, h('span', { class: 'body-s muted' }, 'min'));
    };
    const capLine = (n, cap) => h('span', { class: 'num' }, String(n ?? 0) + ' / ' + (cap ?? '—'));
    const quiet = h('input', { type: 'text', class: 'input', style: 'width:140px;font:var(--type-mono)', value: b.quietHours || '', placeholder: 'off, or 22:00-07:00', 'aria-label': 'Quiet hours' });
    quiet.addEventListener('change', () => act('/cadence/bounds', { quietHours: quiet.value.trim() || null }, quiet.value.trim() ? 'Quiet hours: ' + quiet.value.trim() : 'Quiet hours off'));
    const mode = h('select', { class: 'input', 'aria-label': 'Crew tempo changes' },
      [['bounded-auto', 'Crew may speed up inside the bounds'], ['fixed', 'Only you change the tempo']].map(([val, label]) => h('option', { value: val, selected: tp.mode === val }, label)));
    mode.addEventListener('change', () => act('/cadence/bounds', { mode: mode.value }, 'Tempo mode: ' + mode.value));
    const card = (title, ...kids) => h('div', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'label strong' }, title), ...kids);
    fill(body,
      h('section', { class: 'stack-12' },
        h('h2', { class: 'h3' }, 'Right now'),
        h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' },
          card('Effective tempo', h('span', { class: 'body-l num' }, 'tick ' + (eff.tickMin ?? '—') + ' min · cooldown ' + (eff.cooldownMin ?? '—') + ' min'),
            Tag(eff.source === 'temporary' ? 'Temporary speed-up' : 'Your base values', { variant: 'status', status: eff.source === 'temporary' ? 'warning' : 'online' }),
            eff.quiet ? h('span', { class: 'caption' }, 'Quiet hours: only your own messages wake anyone.') : null),
          card('Dispatcher loop', h('span', { class: 'body-s' }, 'Last tick ' + when(lp && (lp.lastTickEndAt || lp.lastTickAt))), h('span', { class: 'body-s' }, 'Next tick ' + (lp && lp.status === 'ticking' ? 'running now' : when(lp && lp.nextTickAt))),
            h('span', { class: 'caption muted' }, lp ? 'State: ' + (lp.status || '?') : 'The loop has not written its state yet (company/state/dispatcher-loop.json).')),
          card('Wakes against the caps', h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'body-s' }, 'Last hour'), capLine(w.hour, w.maxPerHour)),
            h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'body-s' }, 'Last 24 h'), capLine(w.day, w.maxPerDay)),
            h('span', { class: 'caption muted' }, 'Your own messages are never held, but they count.'))),
        tmp ? h('div', { class: 'card p18', style: 'gap:8px' },
          h('span', { class: 'label strong' }, 'Temporary speed-up by ' + (tmp.by || '?')),
          h('span', { class: 'body-s' }, Object.entries(tmp.set || {}).map(([k, x]) => k + ' ' + x).join(', ') + ' · until ' + when(tmp.expiresAt)),
          h('span', { class: 'body-s muted' }, 'Why: ' + (tmp.why || '—')),
          h('div', { class: 'row-8' }, Button('End it now', { variant: 'secondary', size: 'sm', onClick: () => act('/cadence/end-temporary', {}, 'Back to your base values.') }))) : null),
      h('section', { class: 'stack-12' },
        h('h2', { class: 'h3' }, 'Your base values'),
        h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px' },
          defaults.map(([k, field, name, unit, note]) => h('label', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'label strong' }, name),
            h('span', { class: 'row-8', style: 'align-items:center' }, numIn(d[k], name, val => act('/cadence/default', { [field]: Number(val) }, name + ': ' + val + ' ' + unit), 96), h('span', { class: 'body-s muted' }, unit)),
            h('span', { class: 'caption muted' }, note))))),
      h('section', { class: 'stack-12' },
        h('h2', { class: 'h3' }, 'Bounds'),
        h('p', { class: 'body-s muted', style: 'max-width:720px' }, 'The range the crew may move the tempo in on its own. Inside it, a change is temporary: it ends after ' + (tp.autoExpireMin ?? 30) + ' min and goes back to your base values, at most one per ' + (tp.minChangeIntervalMin ?? 15) + ' min. Anything outside, and these bounds themselves, is yours (or a change reviewed by finance, risk and people). The tempo sets how fast the day\'s spend is used, not only how much.'),
        h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px' },
          card('Dispatcher tick', range('tickMin', 'Tick bounds')),
          card('Seat cooldown', range('cooldownMin', 'Cooldown bounds')),
          card('Wakes per hour', h('span', { class: 'row-8', style: 'align-items:center' }, numIn(b.maxWakesPerHour, 'Wakes per hour', val => act('/cadence/bounds', { maxWakesPerHour: Number(val) }, 'Wakes per hour: ' + val)), h('span', { class: 'body-s muted' }, 'wakes'))),
          card('Wakes per day', h('span', { class: 'row-8', style: 'align-items:center' }, numIn(b.maxWakesPerDay, 'Wakes per day', val => act('/cadence/bounds', { maxWakesPerDay: Number(val) }, 'Wakes per day: ' + val)), h('span', { class: 'body-s muted' }, 'wakes in 24 h'))),
          card('Quiet hours', quiet, h('span', { class: 'caption muted' }, 'Company time. Nobody is woken then except for your messages.')),
          card('Crew changes', mode,
            h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'body-s muted' }, 'last'), numIn(tp.autoExpireMin, 'Speed-up length', val => act('/cadence/bounds', { autoExpireMin: Number(val) }, 'Speed-ups last ' + val + ' min')), h('span', { class: 'body-s muted' }, 'min')),
            h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'body-s muted' }, 'apart'), numIn(tp.minChangeIntervalMin, 'Least time between changes', val => act('/cadence/bounds', { minChangeIntervalMin: Number(val) }, 'Changes at least ' + val + ' min apart')), h('span', { class: 'body-s muted' }, 'min'))))),
      err,
      seatRows.length ? table(['Seat', 'Own loop', 'Cooldown (min)', 'Priority', 'Wake on handoff', 'Wake on your message'], seatRows.map(([id, s]) => h('tr', null,
        h('th', { scope: 'row', class: 'label strong' }, s.name || id),
        h('td', { class: 'num' }, s.loop || '—'),
        h('td', null, num(id, 'cooldown', v(s.cooldownMin), (s.name || id) + ' cooldown')),
        h('td', null, num(id, 'priority', v(s.priority), (s.name || id) + ' priority')),
        h('td', null, onoff(id, 'wakeOnInbox', v(s.wakeOnInbox))),
        h('td', null, onoff(id, 'wakeOnOwner', v(s.wakeOnOwnerMessage))))), { minWidth: 860 }) : empty('No seats in cadence yet.'),
      (d.unknownSeats || []).length ? h('p', { class: 'caption danger' }, 'In cadence.json but not in loops.json: ' + d.unknownSeats.join(', ')) : null,
      (d.changes || []).length ? h('section', { class: 'stack-12' }, h('h2', { class: 'h3' }, 'Recent tempo changes'),
        table(['When', 'Who', 'What', 'Why'], d.changes.map(c => h('tr', null, h('td', { class: 'num' }, when(c.at)), h('td', null, c.by || '—'), h('td', null, c.what || ''), h('td', { class: 'muted' }, c.why || '—'))), { minWidth: 640 })) : null,
      h('span', { class: 'caption muted' }, 'Changes are written to ' + (d.file || 'cadence.json') + '; the dispatcher loop picks them up within a minute, and seat changes are applied to loops.json. Guide: docs/TEMPO.md.'));
  }

  function drawPanels(d) {
    const rows = d.panels || [];
    const btn = (label, fn) => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: fn }, label);
    const op = (p, o) => act('/panels/' + encodeURIComponent(p.id) + '/' + o, {}, (p.title || p.id) + ': ' + o);
    fill(body,
      h('p', { class: 'body-s muted', style: 'max-width:720px' }, 'The crew may add panels that fit how this company works. Panels read only from allowed files, tools and station reads, act only through handoffs and questions, and can never hide Needs you, the halt controls or these Controls. Guide: docs/CONSOLE-PANELS.md.'),
      rows.length ? table(['Panel', 'Where', 'Kind', 'Owner', 'State', ''], rows.map(p => {
        const state = p.status === 'proposed' ? 'Proposed' : !p.valid ? 'Broken (' + p.findings + ')' : p.hidden ? 'Hidden' : 'Live';
        return h('tr', null,
          h('th', { scope: 'row', class: 'label strong' }, p.title || p.id),
          h('td', null, placeLabel(p)), h('td', { class: 'num' }, p.view || '?'), h('td', null, p.owner || '—'),
          h('td', null, Tag(state, { variant: 'status', status: p.status === 'proposed' ? 'warning' : !p.valid ? 'danger' : p.hidden ? 'neutral' : 'online' })),
          h('td', { style: 'white-space:nowrap' }, p.status === 'proposed'
            ? [btn('Approve', () => op(p, 'approve')), btn('Reject', async () => { if (await app.confirmDialog({ title: 'Reject ' + (p.title || p.id) + '?', confirm: 'Reject', danger: true })) op(p, 'reject'); })]
            : [p.hidden ? btn('Unhide', () => op(p, 'unhide')) : btn('Hide', () => op(p, 'hide')),
               btn('Remove', async () => { if (await app.confirmDialog({ title: 'Remove ' + (p.title || p.id) + '?', body: 'Removes the installed panel. The owner seat is told.', confirm: 'Remove', danger: true })) op(p, 'remove'); })]));
      }), { minWidth: 760 }) : empty('No panels yet. When the crew adds one, it shows here.'));
  }

  load();
  const off = events.on(['governance', 'guardrails', 'cadence', 'panels'], load);
  return () => off();
}
function placeLabel(p) {
  const k = String(p.placement || '');
  if (k === 'today') return 'Today';
  if (k.startsWith('side:')) return k.slice(5).replace(/^./, c => c.toUpperCase()) + ' side column';
  if (k === 'screen') return 'Own screen' + (p.nav ? ' (' + p.nav + ')' : '');
  return k || '?';
}
