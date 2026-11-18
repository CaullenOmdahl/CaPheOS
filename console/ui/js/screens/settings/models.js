// Settings › Models and subscriptions (#/settings/models[/chains|routing|cutoffs|providers|budget]): every seat's model chain
// (changed in Crew › seat › Model), the routing modes and trials (./routing.js, /api/routing*), the subscription cutoff sliders, the AI providers and the pay-per-token cap (was
// Usage and models, and Setup's provider and budget steps). API: /api/models, /api/pacer/limits, /api/pacer/limit, /api/setup*.
import { h, fill, Button, Tag, errLine, empty, Block, humanError, when as whenAt } from '../../ui.js';
import { personName } from '../../plain.js';
import { api, post } from '../../api.js';
import { sliderControl } from '../today.js';
import { chainsTable } from '../crew-model.js';
import * as setup from '../setup.js';
import * as events from '../../events.js';
import { routingSection } from './routing.js';

export async function render(host, ctx) {
  const { app } = ctx;
  const chains = h('div'), cutoffs = h('div'), providers = h('div'), routing = h('div', { class: 'stack-16' });
  fill(host,
    Block({ id: 'chains', title: 'Who runs on what', lede: 'Each crew member\'s primary model and the fallbacks it moves to when the primary cannot run. Open a name to change it.' }, chains),
    Block({ id: 'routing', title: 'Routing and trials', lede: 'Whether the company may pick a different model for one piece of work: a department\'s preferred model for that kind of work, a cheaper model for routine work, or a trial that compares models on real work. Each starts as recording only; you make it live.' }, routing),
    Block({ id: 'cutoffs', title: 'Subscription cutoffs', lede: 'How much of each subscription\'s week routines may use, and how evenly. The pacer asks on Today when a cutoff is holding the crew back.' }, cutoffs),
    Block({ id: 'providers', title: 'Providers and the pay-per-token cap', lede: 'Where the crew\'s AI comes from, and the most it may spend a day on providers that bill per token.' }, providers));
  chainsTable(chains);
  const reloadRouting = routingSection(routing, app);   // routing modes and trials (console/routing.js)
  const offRouting = events.on('routing', reloadRouting);
  drawCutoffs(cutoffs, app);
  const step = { providers: 'provider', budget: 'budget' }[ctx.anchor] || null;
  const stop = await setup.render(providers, Object.assign({}, ctx, { only: ['provider', 'budget'], embedded: true, rest: step ? [step] : [] }));
  return () => { offRouting(); if (typeof stop === 'function') stop(); };
}

/* Subscription cutoffs (pacer.js limits / limit): per subscription the usage, the reset, the weekly stop and the
 * spread-evenly-or-use-it-now line as sliders, and the seats they affect. Save goes through the recorded pacer.js limit. */
export async function drawCutoffs(el, app) {
  let d;
  try { d = await api('/pacer/limits'); } catch (e) { fill(el, errLine(e, 'Subscription cutoffs')); return; }
  const tz = app && app.company && app.company.timezone;
  const when = ms => whenAt(ms, tz);
  const dd = (k, v) => h('div', null, h('dt', { class: 'caption muted' }, k), h('dd', { class: 'mono strong', style: 'margin:0' }, v));
  const cards = ['claude', 'minimax'].filter(k => d[k]).map(k => {
    const x = d[k]; const fmt = v => v == null ? '—' : (Math.round(v * 10) / 10) + '%';
    const err = h('p', { class: 'err-line', role: 'status' });
    const stop = sliderControl({ id: k + '-stop', label: 'Weekly stop', min: 1, max: 100, step: 1, value: Math.round(x.weekStop), unit: '%', say: 'Let routines use up to {value}% of this week\'s ' + x.name, minLabel: '1%', maxLabel: 'All of it (100%)',
      marks: x.usedPct != null ? [{ value: Math.max(1, Math.min(100, Math.round(x.usedPct))), label: 'used ' + Math.round(x.usedPct) + '%' }] : undefined }, 'cut-' + k + '-stop');
    const spread = x.paceBy === 'fiveHour' ? null : sliderControl({ id: k + '-usenow', label: 'Daily pacing', min: 0, max: 100, step: 10, value: Math.round((x.useNow || 0) / 10) * 10, unit: '%', say: '{value}% of the way from an even share each day to using it all now', sayAt: { 0: 'Spread evenly: an even share of the week each day', 100: 'Use it now: routines may go up to the weekly stop today' }, minLabel: 'Spread evenly', maxLabel: 'Use it now' }, 'cut-' + k + '-usenow');
    const save = Button('Save', { variant: 'primary', size: 'sm', onClick: async () => {
      err.textContent = '';
      try { await post('/pacer/limit', Object.assign({ provider: k, weekStop: stop.get() }, spread ? { useNow: spread.get() } : {})); app.toast(x.name + ' cutoffs saved. They apply on the next dispatcher check.'); drawCutoffs(el, app); }
      catch (e) { err.textContent = 'Not saved: ' + humanError(e); }
    } });
    const set = x.ownerSet ? 'Last set by ' + personName(x.ownerSet.by) + (x.ownerSet.at ? ' ' + when(Date.parse(x.ownerSet.at)) : '') + '.' : x.companySet ? 'Last set by ' + personName(x.companySet.by) + ' (the company decides pacing).' : 'Not set by you yet: the company default applies.';
    return h('article', { class: 'card p22 stack-12', 'data-sub': k },
      h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, x.name), Tag(x.open ? 'Open to routines' : 'Paused for routines', { variant: 'status', status: x.open ? 'online' : 'warning' })),
      h('dl', { style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0' },
        dd('Used this week', fmt(x.usedPct)), dd("Today's line", fmt(x.line)), dd('Resets', x.resetsAt ? when(x.resetsAt) : '—')),
      h('label', { class: 'label strong', for: 'cut-' + k + '-stop' }, 'Weekly stop'),
      h('p', { class: 'caption muted' }, 'Above this share of the week, routines stop using ' + x.name + ' and move to their fallbacks. Your own chats are never stopped.'), stop.el,
      spread ? h('label', { class: 'label strong', for: 'cut-' + k + '-usenow' }, 'Daily pacing') : h('span', { class: 'caption muted' }, x.name + ' is paced by its own 5-hour window; only the weekly stop applies.'),
      spread ? h('p', { class: 'caption muted' }, 'Spread evenly keeps some for every day of the week; use it now lets today take more.') : null,
      spread ? spread.el : null,
      h('span', { class: 'caption muted' }, 'Affects: ' + ((x.affected || []).map(personName).join(', ') || 'no seat right now') + '. ' + set),
      h('div', { class: 'row-8' }, save), err);
  });
  fill(el, cards.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px' }, cards) : empty('No subscription is paced. Connect one below.'));
}
