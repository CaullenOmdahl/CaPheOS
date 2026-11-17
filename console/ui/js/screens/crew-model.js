// Crew > seat > Model (console/models.js endpoints): the seat's primary model, its ordered fallback chain, what it runs
// on right now and why, and its history of moves. Also the Usage screen's table of every seat's chain.
import { h, fill, Button, Tag, errLine, empty, table } from '../ui.js';
import { api, post } from '../api.js';

const key = e => e.provider + '/' + e.model;
const lab = e => key(e) + (e.effort ? ' · ' + e.effort : '');
function when(t) { const d = new Date(t); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

export function modelPanel(host, seatId) {
  let seat = null, providers = [], catalogs = {}, draft = null, msg = null, busy = false;
  const cat = async p => { if (!catalogs[p]) { try { catalogs[p] = (await api('/models/catalog/' + encodeURIComponent(p))).models || []; } catch (_) { catalogs[p] = []; } } return catalogs[p]; };
  const connected = p => { const x = providers.find(y => y.id === p); return x ? x.connected : null; };

  async function load() {
    fill(host, h('p', { class: 'caption muted', 'aria-busy': 'true' }, 'Loading the model chain…'));
    try {
      const [s, pv] = await Promise.all([api('/models/seat/' + encodeURIComponent(seatId)), api('/models/providers').catch(() => ({ providers: [] }))]);
      seat = (s.seats || [])[0] || null; providers = pv.providers || [];
      draft = seat && seat.chain.length ? seat.chain.map(e => ({ provider: e.provider, model: e.model, effort: e.effort || '' }))
        : seat && seat.now && seat.now.model ? [{ provider: seat.now.model.provider, model: seat.now.model.model, effort: '' }] : [];
    } catch (e) { fill(host, errLine(e, 'Model chain')); return; }
    draw();
  }
  async function save(chain, what) {
    busy = true; msg = null; draw();
    try {
      const r = await post('/models/seat/' + encodeURIComponent(seatId) + '/chain', { chain: chain.map(e => Object.assign({ provider: e.provider, model: e.model }, e.effort ? { effort: e.effort } : {})) });
      msg = { ok: true, text: what + ' saved: ' + (r.chain || []).join(' > ') + (r.applied && r.applied.kept ? ' (it stays on ' + r.applied.kept + ')' : r.applied && r.applied.roster ? ' (applied: roster ' + r.applied.roster + ', ' + (r.applied.routines || []).length + ' routine(s))' : '') };
      busy = false; await load(); return;
    } catch (e) { msg = { ok: false, text: e.message }; }
    busy = false; draw();
  }

  // the primary picker: provider (connected or not) -> its allowed models -> effort
  function picker(onPick, initial, label) {
    const prov = h('select', { class: 'select', 'aria-label': label + ' provider' }, providers.map(p => h('option', { value: p.id, selected: initial && initial.provider === p.id }, p.name + (p.connected === false ? ' (not connected)' : p.connected ? ' (connected)' : ''))));
    const model = h('select', { class: 'select', 'aria-label': label + ' model' });
    const effort = h('select', { class: 'select', 'aria-label': label + ' effort' });
    const fillModels = async () => {
      const list = await cat(prov.value);
      fill(model, list.map(m => h('option', { value: m.id, selected: initial && initial.model === m.id }, m.name + (m.tier ? ' · ' + m.tier : '') + (m.onStation ? '' : ' (not in the station\'s list)'))));
      fillEfforts();
    };
    const fillEfforts = () => {
      const m = (catalogs[prov.value] || []).find(x => x.id === model.value);
      const opts = [''].concat((m && m.efforts) || ['low', 'medium', 'high']);
      fill(effort, opts.map(v => h('option', { value: v, selected: initial && (initial.effort || '') === v }, v || 'default effort')));
    };
    prov.addEventListener('change', fillModels); model.addEventListener('change', fillEfforts);
    fillModels();
    return h('div', { class: 'row-8', style: 'flex-wrap:wrap;align-items:center' }, prov, model, effort,
      Button(label, { variant: 'primary', size: 'sm', disabled: busy, onClick: () => model.value && onPick({ provider: prov.value, model: model.value, effort: effort.value }) }));
  }

  function draw() {
    if (!seat) { fill(host, empty('No such seat.')); return; }
    const now = seat.now || {};
    const runsOn = now.model ? key(now.model) : 'unknown';
    const rows = draft.map((e, i) => {
      const ev = seat.chain.find(x => key(x) === key(e)) || {};
      const conn = connected(e.provider);
      const move = (d) => { const c = draft.slice(); const [x] = c.splice(i, 1); c.splice(i + d, 0, x); save(c, 'Order'); };
      return h('li', { class: 'card', style: 'padding:12px 14px;gap:6px;flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap' },
        h('div', { class: 'stack-4', style: 'min-width:0' },
          h('span', { class: 'label strong' }, (i + 1) + '. ' + lab(e) + (i === 0 ? '  · primary' : '  · fallback ' + i) + (now.index === i ? '  · running now' : '')),
          h('span', { class: 'caption muted' }, ev.why ? (ev.ok ? 'Can run' : ev.why) : 'saved with the next change')),
        h('div', { class: 'row-8', style: 'align-items:center' },
          Tag(conn === true ? 'Connected' : conn === false ? 'Not connected' : 'Unknown', { variant: 'status', status: conn === true ? 'online' : conn === false ? 'danger' : 'neutral' }),
          Button('Up', { size: 'sm', disabled: busy || i === 0, aria: 'Move ' + key(e) + ' up', onClick: () => move(-1) }),
          Button('Down', { size: 'sm', disabled: busy || i === draft.length - 1, aria: 'Move ' + key(e) + ' down', onClick: () => move(1) }),
          Button('Remove', { size: 'sm', disabled: busy || draft.length < 2, aria: 'Remove ' + key(e), onClick: () => save(draft.filter((_, j) => j !== i), 'Removal') })));
    });
    const hist = (seat.history || []).slice(0, 20);
    fill(host,
      h('div', { class: 'stack-16' },
        h('div', { class: 'card', style: 'padding:16px;gap:6px' },
          h('span', { class: 'eyebrow-t' }, 'Running now'),
          h('span', { class: 'label strong' }, 'On ' + runsOn + (now.running ? ' (in a run)' : '')),
          h('span', { class: 'body-s muted' }, 'Because ' + (now.why || 'no reason on record')),
          seat.hasChain ? null : h('span', { class: 'caption muted' }, 'This seat has no chain of its own yet: saving one below gives it a primary and fallbacks, and the pacer stops routing it.')),
        h('section', { class: 'stack-8' }, h('h3', { class: 'h4' }, 'Primary model'),
          picker(e => save([e].concat(draft.filter(x => key(x) !== key(e))), 'Primary'), draft[0], 'Set primary')),
        h('section', { class: 'stack-8' }, h('h3', { class: 'h4' }, 'Fallback chain'),
          h('p', { class: 'caption muted' }, 'Top to bottom: the seat runs on the first entry that can run (connected, subscription open, under the rail, no run of errors) and moves back up once the better one has held. StarNet\'s station-wide fallback chain stays the last backstop.'),
          draft.length ? h('ol', { class: 'stack-8', style: 'list-style:none;padding:0;margin:0' }, rows) : empty('No models yet: pick a primary above.'),
          picker(e => save(draft.filter(x => key(x) !== key(e)).concat([e]), 'Fallback'), null, 'Add fallback')),
        msg ? h('p', { class: msg.ok ? 'caption' : 'err-line', role: 'status' }, msg.text) : null,
        h('section', { class: 'stack-8' }, h('h3', { class: 'h4' }, 'History of moves'),
          hist.length ? table(['When', 'Move', 'From', 'To', 'Why'], hist.map(m => h('tr', null, h('td', null, when(m.at)), h('td', null, m.direction + (m.applied === false ? ' (failed)' : '')), h('td', { class: 'mono' }, m.from || '—'), h('td', { class: 'mono' }, m.to), h('td', null, m.why || ''))), { minWidth: 640 })
            : empty('No moves yet.'))));
  }
  load();
}

// Usage: every seat's chain in one table
export async function chainsTable(host) {
  let d; try { d = await api('/models'); } catch (e) { fill(host, errLine(e, 'Seat model chains')); return; }
  const seats = d.seats || [];
  if (!seats.length) { fill(host, empty('No seats.')); return; }
  fill(host, h('div', { class: 'stack-8' },
    table(['Seat', 'Running now', 'Primary', 'Fallbacks', 'Why'], seats.map(s => h('tr', null,
      h('td', null, h('a', { href: '#/crew/' + encodeURIComponent(s.id) }, s.name)),
      h('td', { class: 'mono' }, s.now && s.now.model ? key(s.now.model) : '—'),
      h('td', { class: 'mono' }, s.primary ? lab(s.primary) + (s.primary.ok ? '' : ' (cannot run)') : 'no chain'),
      h('td', { class: 'mono' }, s.chain.slice(1).map(e => lab(e) + (e.ok ? '' : ' ✕')).join(' > ') || '—'),
      h('td', { class: 'caption' }, s.now ? s.now.why : ''))), { minWidth: 820 }),
    h('p', { class: 'caption muted' }, (d.failover && d.failover.mode === 'shadow' ? 'Failover is in shadow mode: moves are logged, not made. ' : '') + (d.backstop || ''))));
}
