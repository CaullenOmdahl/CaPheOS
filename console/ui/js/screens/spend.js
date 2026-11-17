// Spend (#/spend, was the read-only half of Usage and models): today's pay-per-token spend against the daily cap, by
// seat and by provider, and how much of each subscription this week has used. Read-only: the cap, the cutoffs and the
// model chains are set in Settings › Models and subscriptions. API: GET /api/spend (docs/CONSOLE-API.md).
import { h, fill, Tag, errLine, empty, screenHead, table, Details, Block } from '../ui.js';
import { api } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { groupSeats, usageLine } from '../plain.js';

const PROVIDER = { 'claude-cli': 'Claude subscription', claude: 'Claude', anthropic: 'Anthropic API', deepseek: 'DeepSeek', custom: 'MiniMax', minimax: 'MiniMax', openrouter: 'OpenRouter', openai: 'OpenAI', unknown: 'Not recorded' };
const usd = v => '$' + (Number(v) || 0).toFixed(Number(v) >= 10 ? 0 : 2);
const pct = v => v == null ? '—' : Math.round(v) + '%';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-36';
  const head = h('div'), todayEl = h('div'), seatsEl = h('div'), provEl = h('div'), subsEl = h('div'), pacerEl = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, head, todayEl,
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:32px' },
      Block({ id: 'seats', title: 'By seat', lede: 'Pay-per-token spend in the last 24 hours, per crew member.' }, seatsEl),
      Block({ id: 'providers', title: 'By provider', lede: 'Everything billed in the last 24 hours. Subscriptions are a flat fee and never count against the cap.' }, provEl)),
    Block({ id: 'subscriptions', title: 'Subscriptions this week', lede: 'How much of each subscription\'s weekly allowance is used, and where routines stop.' }, subsEl),
    pacerEl, side);
  fill(head, screenHead({ title: 'Spend.', lede: 'What the company spends on AI today, and who spends it. To change the cap or the cutoffs, go to Settings.', max: '720px',
    actions: [h('a', { href: '#/settings/models', class: 'btn btn-secondary btn-md' }, 'Change limits')] }));

  async function load() {
    let d;
    try { d = await api('/spend'); }
    catch (e) { fill(todayEl, errLine(e, 'Spend')); return; }
    const t = d.today || {};
    const cap = t.capUsd || 0, used = t.usd || 0, share = cap ? used / cap * 100 : null;
    const tone = cap === 0 ? 'neutral' : share >= 90 ? 'danger' : share >= 70 ? 'warning' : 'online';
    fill(todayEl, h('section', { class: 'card p28', 'aria-labelledby': 'today-spend', style: 'gap:16px' },
      h('div', { class: 'between-c', style: 'flex-wrap:wrap' }, h('h2', { id: 'today-spend', class: 'h3' }, 'Today'), Tag(cap === 0 ? 'Cap is $0: nothing pay-per-token runs' : Math.round(share) + '% of the cap', { variant: 'status', status: tone })),
      h('div', { class: 'row-8', style: 'align-items:baseline;gap:12px' }, h('span', { class: 'big-num-30' }, usd(used)), h('span', { class: 'body-l muted' }, 'of ' + usd(cap) + ' a day')),
      cap ? h('div', { class: 'meter', role: 'img', 'aria-label': usd(used) + ' of ' + usd(cap) + ' spent today' }, h('div', { class: share >= 90 ? 'over' : '', style: 'width:' + Math.min(100, Math.round(share)) + '%' })) : null,
      h('p', { class: 'body-s muted' }, (t.perSeatCapUsd ? 'Each crew member may spend at most ' + usd(t.perSeatCapUsd) + ' of it. ' : 'No per-member limit. ') +
        (t.ownerPaidUsd ? usd(t.ownerPaidUsd) + ' more went to providers billed outside the cap. ' : '') + (t.inFlightRuns ? t.inFlightRuns + ' run(s) still in flight are counted at their estimate.' : '')),
      d.known ? null : h('p', { class: 'caption muted' }, 'The spend records could not be read, so these numbers may be low.'),
      d.error ? Details('Details', h('code', { class: 'mono-s' }, d.error)) : null));
    // the crew one row each; interview candidates folded into one row that opens to their names
    const g = groupSeats(d.bySeat || []);
    const rows = g.seats.map(s => h('tr', null,
      h('th', { scope: 'row' }, h('a', { href: '#/crew/' + encodeURIComponent(s.id) }, s.name)),
      h('td', { class: 'num' }, usd(s.usd), t.perSeatCapUsd && s.usd >= t.perSeatCapUsd ? h('span', { class: 'caption danger' }, ' at the limit') : null)));
    if (g.candidates) rows.push(h('tr', { 'data-candidates': String(g.candidates.n) },
      h('th', { scope: 'row' }, h('details', { class: 'cand-group' }, h('summary', { class: 'label' }, 'Interview candidates (' + g.candidates.n + ')'),
        h('ul', { class: 'plain stack-4', style: 'margin-top:6px' }, g.candidates.rows.map(c => h('li', { class: 'between body-s', style: 'gap:12px' }, h('span', null, c.name), h('span', { class: 'mono-s muted' }, usd(c.usd))))))),
      h('td', { class: 'num', style: 'vertical-align:top' }, usd(g.candidates.usd))));
    fill(seatsEl, rows.length ? table(['Crew member', 'Today'], rows, { minWidth: 280 }) : empty('Nobody has spent anything pay-per-token today.'));
    const prov = d.byProvider || [];
    fill(provEl, prov.length ? table(['Provider', 'Today', ''], prov.map(p => h('tr', null,
      h('th', { scope: 'row' }, PROVIDER[p.id] || p.id), h('td', { class: 'num' }, usd(p.usd)),
      h('td', null, Tag(p.capped ? 'Counts against the cap' : 'Outside the cap', { variant: p.capped ? 'soft' : 'outline' })))), { minWidth: 280 })
      : empty('Nothing billed in the last 24 hours.'));
    const subs = d.subscriptions || [];
    const em = d.pacer && d.pacer.emergency;
    fill(subsEl, subs.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:16px' }, subs.map(s => {
      const u = Number(s.usedPct) || 0, stop = Number(s.weekStop) || 100;
      return h('article', { class: 'card p22', style: 'gap:12px', 'data-sub': s.id },
        h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, s.name), Tag(s.open ? 'Open to routines' : 'Paused for routines', { variant: 'status', status: s.open ? 'online' : 'warning' })),
        h('div', { class: 'row-8', style: 'align-items:baseline;gap:10px' }, h('span', { class: 'big-num' }, pct(u)), h('span', { class: 'body-s muted' }, 'used this week · routines stop at ' + pct(stop))),
        h('div', { class: 'meter', role: 'img', 'aria-label': pct(u) + ' of the week used' }, h('div', { class: u >= stop ? 'over' : '', style: 'width:' + Math.min(100, Math.round(u)) + '%' })),
        h('p', { class: 'caption muted' }, (s.resetsAt ? 'Resets ' + when(s.resetsAt, app) + '. ' : '') + (s.paceBy === 'fiveHour' ? 'Paced by its own 5-hour window.' : s.line != null ? 'Today\'s allowance: ' + pct(s.line) + '.' : '')),
        h('p', { class: 'caption muted' }, usageLine({ label: s.name, known: s.usedPct != null, usedPct: s.usedPct, line: s.line, open: s.open, paceBy: s.paceBy, emergencyOpened: /emergency/.test(String(s.why || '')) }, em, t => when(t, app)).note),
        s.why ? Details('Details', h('p', { class: 'caption' }, s.why)) : null);
    })) : empty('No subscription is connected, or the pacer is not reporting yet.'));
    const p = d.pacer;
    fill(pacerEl, p && ((p.emergency && p.emergency.active) || (p.boost && p.boost.on) || (p.problems || []).length) ? Block({ id: 'pacer', title: 'Right now' },
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px' },
        p.emergency && p.emergency.active ? note('Emergency lift is on', 'Routines may use more of a subscription today than the even daily share.', p.emergency.why) : null,
        p.boost && p.boost.on ? note('Boost is on', 'More crew may run at once while subscriptions have room to spare.', p.boost.why) : null,
        (p.problems || []).length ? note('The pacer reports a problem', String(p.problems[0]).slice(0, 140), p.problems.join('\n')) : null)) : null);
  }
  load();
  const stopPanels = mountPanels(side, 'side:usage', app);
  const off = events.on(['dispatch', 'cadence'], load);
  return () => { off(); stopPanels(); };
}
function note(title, text, why) { return h('div', { class: 'card p18', style: 'gap:8px' }, h('span', { class: 'label strong' }, title), h('span', { class: 'body-s muted' }, text), why ? Details('Why', h('p', { class: 'caption' }, why)) : null); }
function when(ms, app) {
  const tz = app && app.company && app.company.timezone;
  try { return new Intl.DateTimeFormat('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }).format(new Date(ms)); } catch (_) { return new Date(ms).toLocaleString(); }
}
