// Page kit gallery (#/kit, linked from System): every unit kind a company page can use, drawn with sample data and
// shown next to its declaration. Living documentation for docs/CONSOLE-DESIGN.md: if it looks right here, it looks
// right on a company page. Also the owner's theme choice (light, dark, follow the device).
import { h, fill, screenHead } from '../ui.js';
import { renderUnit } from '../panels.js';

const D = 864e5, now = Date.now();
const at = (days, hh, mm) => { const d = new Date(now + days * D); if (hh != null) d.setHours(hh, mm || 0, 0, 0); return d.toISOString(); };
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function sampleData() {
  let cum = 0, px = 100;
  const pnl = Array.from({ length: 30 }, (_, i) => { cum += Math.round((rnd() - 0.42) * 9000); return { at: at(i - 29, 17), cumulative: cum, desk: Math.round(cum * 0.6), algo: Math.round(cum * 0.4) }; });
  const bars = Array.from({ length: 24 }, (_, i) => { const o = px; const c = +(o * (1 + (rnd() - 0.47) * 0.05)).toFixed(2); px = c; return { at: at(i - 23, 0), open: o, high: +(Math.max(o, c) * (1 + rnd() * 0.015)).toFixed(2), low: +(Math.min(o, c) * (1 - rnd() * 0.015)).toFixed(2), close: c }; });
  const mix = ['Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov'].map((m, i) => ({ month: m, equity: 30 + i * 1.5, bonds: 18 + (i % 3), cash: 4 + (i % 2) }));
  const scatter = Array.from({ length: 24 }, () => { const x = Math.round(rnd() * 100); return { size: x, margin: +(8 + x * 0.12 + (rnd() - 0.5) * 8).toFixed(1) }; });
  const st = s => Array.from({ length: 20 }, (_, i) => s === 'down' && i > 16 ? 'down' : s === 'degraded' && i > 13 && i % 2 ? 'degraded' : 'up');
  return {
    book: { summary: { upnl: 6249, realised: 4820.5, orders: 5, exposure: 595617 }, limits: { gross: 900000, var: 0.035 }, exposure: { gross: 595617, var: 0.031, loss: 6200, budget: 31 },
      positions: [{ symbol: 'BTC-USD', side: 'long', qty: 1.8, entry: 61250, mark: 63840 }, { symbol: 'ETH-USD', side: 'long', qty: 24, entry: 3380, mark: 3291 }, { symbol: 'SOL-USD', side: 'short', qty: 400, entry: 148.2, mark: 151.9 }, { symbol: 'AAPL', side: 'long', qty: 300, entry: 214.1, mark: 222.35 }] },
    pnl, bars: { bars }, mix, scatter,
    checks: [['API gateway', 'Edge', 'up', 'p95 42 ms'], ['CDN', 'Edge', 'up', 'p95 18 ms'], ['Web app', 'Apps', 'degraded', 'p95 640 ms'], ['Billing', 'Apps', 'up', 'p95 95 ms'], ['Replica DB', 'Data', 'down', 'No answer for 3 checks'], ['Backups', 'Data', 'unknown', 'Last check did not run']]
      .map(([service, group, state, detail], i) => ({ service, group, state, detail, checkedAt: at(-(i + 1) / 1440), history: state === 'unknown' ? [] : st(state) })),
    incidents: [{ id: 'inc-311', at: at(-12 / 1440), title: 'Replica DB not answering', text: 'No answer for 3 checks. Primary is fine.', severity: 'critical', service: 'Replica DB', acked: false },
      { id: 'inc-310', at: at(-47 / 1440), title: 'Web app slow', text: 'p95 above the 400 ms objective.', severity: 'warning', service: 'Web app', acked: true },
      { id: 'inc-305', at: at(-3), title: 'CDN errors back to normal', severity: 'resolved', service: 'CDN', acked: true }],
    videos: [['Spring launch teaser', 'Northwind', 'script', 'Mai', 2, 1, 'ok'], ['Founder interview', 'Contoso', 'shoot', 'Tom', 5, 3, 'ok'], ['How-to in 60 s', 'Northwind', 'edit', 'Lena', -1, 4, 'late'],
      ['Case study', 'Fabrikam', 'edit', 'Raj', 4, 3, 'stuck'], ['Event recap', 'Tailspin', 'review', 'Mai', 1, 5, 'ok'], ['Shorts pack', 'Tailspin', 'brief', 'Tom', 9, 0, 'ok']]
      .map(([title, client, stage, owner, due, done, risk], i) => ({ id: 'vid-' + (201 + i), title, client, stage, owner, due: at(due, 17), stepsDone: done, stepsTotal: 6, format: i % 2 ? '9:16' : '16:9', stuck: risk === 'stuck', risk })),
    events: [[0, 9.5, 0.5, 'Stand-up', 'meeting'], [0, 14, 1, 'Client review: Contoso', 'client'], [1, 11, 1, 'Hiring panel', 'meeting'], [2, 0, 0, 'VAT return due', 'deadline', true],
      [3, 10, 1.5, 'Quarterly planning', 'meeting'], [7, 0, 0, 'Contract renewal', 'deadline', true], [9, 9, 56, 'Trade show', 'travel'], [-2, 15, 1, 'Supplier call', 'meeting']]
      .map(([d, hh, len, title, kind, allDay]) => { const s = new Date(at(d, Math.floor(hh), (hh % 1) * 60)); return { start: s.toISOString(), end: new Date(+s + len * 36e5).toISOString(), title, kind, allDay: !!allDay }; }),
    stages: [{ label: 'Applied', count: 48, stuck: 0 }, { label: 'Screened', count: 21, stuck: 3 }, { label: 'Interview', count: 9, stuck: 1 }, { label: 'Offer', count: 2, stuck: 0 }, { label: 'Hired', count: 1, stuck: 0 }],
    deadlines: [{ due: at(2), title: 'VAT return', owner: 'finance', late: false }, { due: at(-1), title: 'Insurance renewal', owner: 'risk', late: true }, { due: at(7), title: 'Contract renewal', owner: 'ceo', late: false }],
  };
}

const UNITS = [
  ['stat-row', 'Headline numbers', 'Two to six numbers the owner reads first. Put it at the top, full width.',
    { id: 'stats', span: 12, view: { kind: 'stat-row', items: [{ source: 'book', value: 'summary.upnl', label: 'Unrealised P&L', format: 'money' }, { source: 'book', value: 'summary.realised', label: 'Realised today', format: 'money' }, { source: 'book', value: 'summary.orders', label: 'Open orders', format: 'integer' }, { source: 'checks', value: 'length', label: 'Services checked', format: 'integer' }] } }],
  ['positions', 'Positions', 'A table preset for a trading book: side, size, entry, mark, unrealised P&L signed and coloured by sign, totals.',
    { id: 'positions', title: 'Open positions', span: 8, view: { kind: 'positions', source: 'book', rows: 'positions', symbol: 'symbol', side: 'side', size: 'qty', entry: 'entry', mark: 'mark', format: 'money' }, actions: ['ask'] }],
  ['gauge', 'Gauge', 'A figure against a limit. Neutral under the warn point, warn near it, bad over it; the word says which.',
    { id: 'gauge', title: 'Exposure against limits', span: 4, view: { kind: 'gauge', source: 'book', items: [{ label: 'Gross exposure', value: 'exposure.gross', max: 'limits.gross', format: 'money' }, { label: 'Value at risk', value: 'exposure.var', max: 'limits.var', format: 'percent' }] } }],
  ['chart: area', 'Area chart', 'One measure over time, with a reference line for a limit.',
    { id: 'area', title: 'Cumulative P&L', span: 6, view: { kind: 'chart', chart: 'area', source: 'pnl', x: { key: 'at', time: true, format: 'date' }, series: [{ key: 'cumulative', label: 'Cumulative P&L', format: 'money' }], y: { format: 'money' }, refs: [{ label: 'Drawdown limit', value: -25000, tone: 'bad' }] } }],
  ['chart: line', 'Line chart', 'Up to six series over time; a legend always shows for two or more.',
    { id: 'line', title: 'P&L by desk', span: 6, view: { kind: 'chart', chart: 'line', source: 'pnl', x: { key: 'at', time: true, format: 'date' }, series: [{ key: 'desk', label: 'Desk', format: 'money' }, { key: 'algo', label: 'Algo', format: 'money' }], y: { format: 'money', zero: true } } }],
  ['chart: candlestick', 'Candlestick', 'Open, high, low, close per period. Up and down are the only chart colours that carry meaning.',
    { id: 'candles', title: 'Price, daily', span: 6, view: { kind: 'chart', chart: 'candlestick', source: 'bars', rows: 'bars', x: { key: 'at', time: true, format: 'date' }, ohlc: { open: 'open', high: 'high', low: 'low', close: 'close' } } }],
  ['chart: stacked-bar', 'Stacked bar', 'Parts of a whole per period.',
    { id: 'stack', title: 'Assets by class ($m)', span: 6, view: { kind: 'chart', chart: 'stacked-bar', source: 'mix', x: { key: 'month' }, series: [{ key: 'equity', label: 'Equity' }, { key: 'bonds', label: 'Bonds' }, { key: 'cash', label: 'Cash' }] } }],
  ['chart: bar', 'Bar chart', 'Comparing a few categories.',
    { id: 'bar', title: 'Assets by month ($m)', span: 6, view: { kind: 'chart', chart: 'bar', source: 'mix', x: { key: 'month' }, series: [{ key: 'equity', label: 'Equity' }, { key: 'bonds', label: 'Bonds' }] } }],
  ['chart: scatter', 'Scatter', 'Two measures against each other (not time). At most three series.',
    { id: 'scatter', title: 'Deal size against margin', span: 6, view: { kind: 'chart', chart: 'scatter', source: 'scatter', x: { key: 'size', label: 'Deal size' }, series: [{ key: 'margin', label: 'Margin %' }], y: { zero: false } } }],
  ['status-grid', 'Status grid', 'Health tiles grouped, worst first, with the last checks as a sparkline. State is always written, not only coloured.',
    { id: 'grid', title: 'Checks', span: 8, view: { kind: 'status-grid', source: 'checks', name: 'service', state: 'state', group: 'group', checked: 'checkedAt', detail: 'detail', history: 'history', stateMap: { up: 'ok', degraded: 'warn', down: 'bad' } } }],
  ['feed', 'Feed', 'Alerts newest first. Acknowledge is an action: a handoff to the owning seat, never a direct write.',
    { id: 'feed', title: 'Incidents', span: 4, view: { kind: 'feed', source: 'incidents', at: 'at', title: 'title', text: 'text', severity: 'severity', origin: 'service', acked: 'acked', ack: 'ack' } }],
  ['pipeline', 'Pipeline', 'Steps with counts and stuck flags.',
    { id: 'pipe', title: 'Hiring pipeline', span: 12, view: { kind: 'pipeline', source: 'stages', label: 'label', count: 'count', stuck: 'stuck' } }],
  ['kanban', 'Kanban', 'Cards in columns, with steps, assignee and due date. Move is an action: the owning seat moves the card.',
    { id: 'board', title: 'Production board', span: 12, rows: 3, view: { kind: 'kanban', source: 'videos', column: 'stage', columns: [{ id: 'brief', label: 'Brief' }, { id: 'script', label: 'Script' }, { id: 'shoot', label: 'Shoot' }, { id: 'edit', label: 'Edit', limit: 1 }, { id: 'review', label: 'Review' }], title: 'title', subtitle: 'client', badges: ['format'], assignee: 'owner', due: 'due', steps: { done: 'stepsDone', total: 'stepsTotal' }, tone: 'risk', toneMap: { late: 'warn', stuck: 'bad' }, move: 'move' } }],
  ['calendar', 'Calendar', 'Month, week and agenda, in the company timezone.',
    { id: 'cal', title: 'Calendar', span: 8, rows: 3, view: { kind: 'calendar', source: 'events', start: 'start', end: 'end', title: 'title', allDay: 'allDay', tone: 'kind', toneMap: { deadline: 'bad', client: 'accent', travel: 'warn' } } }],
  ['progress', 'Progress', 'Bars against a limit, or toward a target (goodWhen: high).',
    { id: 'prog', title: 'Error budget used', span: 4, view: { kind: 'progress', source: 'book', items: [{ label: 'Error budget', value: 'exposure.budget', max: 43, unit: 'min', format: 'integer' }, { label: 'Loss today', value: 'exposure.loss', max: 15000, format: 'money' }, { label: 'Sales target', value: 'summary.realised', max: 6000, format: 'money', goodWhen: 'high' }] } }],
  ['table', 'Table', 'Rows and columns; `flag` gives a cell the warn tone.',
    { id: 'table', title: 'Deadlines', span: 6, view: { kind: 'table', source: 'deadlines', columns: [{ key: 'due', label: 'Due', format: 'date', flag: 'late' }, { key: 'title', label: 'What' }, { key: 'owner', label: 'Owner' }], sort: { key: 'due', dir: 'asc' } } }],
  ['timeline', 'Timeline', 'Events by time, newest first.',
    { id: 'tl', title: 'Recent', span: 6, view: { kind: 'timeline', source: 'incidents', at: 'at', text: 'title', who: 'service' } }],
];
const ACTIONS = [
  { id: 'ask', label: 'Ask', kind: 'handoff', to: 'finance', scope: 'row', text: 'Owner question on {{row.symbol}}.' },
  { id: 'ack', label: 'Acknowledge', kind: 'handoff', to: 'tools', scope: 'row', text: 'Owner acknowledges {{row.id}}.' },
  { id: 'move', label: 'Move', kind: 'handoff', to: 'ceo', scope: 'move', text: 'Move {{row.title}} from {{move.from}} to {{move.to}}.' },
];

function themePicker() {
  const cur = () => document.documentElement.dataset.theme || 'auto';
  const set = t => { if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; try { if (t === 'auto') localStorage.removeItem('capheos-theme'); else localStorage.setItem('capheos-theme', t); } catch (_) {} draw(); };
  const el = h('div', { class: 'theme-pick', role: 'group', 'aria-label': 'Theme' });
  const draw = () => fill(el, [['auto', 'Follow device'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(cur() === k), onclick: () => set(k) }, l)));
  draw(); return el;
}
function swatches() {
  const chip = (name, note) => h('li', null, h('span', { class: 'chip', style: 'background:var(' + name + ')' }), h('code', { class: 'mono-s' }, name), note ? h('span', { class: 'muted' }, note) : null);
  return h('section', { class: 'card stack-14', 'aria-labelledby': 'kit-colours' }, h('h2', { id: 'kit-colours', class: 'h4' }, 'Colours that carry data'),
    h('p', { class: 'body-s muted' }, 'Series take these six in order, never cycled. Good, warn and bad are for state only, always with a word or a sign.'),
    h('ul', { class: 'swatches' }, [1, 2, 3, 4, 5, 6].map(i => chip('--chart-' + i, 'series ' + i)), chip('--status-online', 'good'), chip('--status-warning', 'warn'), chip('--status-danger', 'bad'), chip('--accent', 'accent')));
}

export async function render(root, ctx) {
  root.className = 'main gap-32 kit-gallery';
  const r = { id: 'gallery', title: 'Gallery', data: sampleData(), sources: {}, actions: ACTIONS };
  const note = h('p', { class: 'caption muted', role: 'status', 'aria-live': 'polite' });
  const onAction = (a, row, extra) => { note.textContent = 'Gallery: "' + a.label + '" would open ' + (a.kind === 'handoff' ? 'a handoff to ' + a.to : 'a message') + (extra && extra.move ? ' to move it from ' + extra.move.from + ' to ' + extra.move.to : '') + '. Nothing was sent.'; };
  const states = [
    renderUnit({ id: 'loading', title: 'Loading', span: 4, view: { kind: 'table', source: 'x', columns: [{ key: 'a', label: 'A' }] } }, { id: 'g', loading: true, data: {}, sources: {} }, onAction),
    renderUnit({ id: 'empty', title: 'Empty', span: 4, view: { kind: 'feed', source: 'x', at: 'at', title: 't', empty: 'No alerts. All quiet.' } }, { id: 'g', data: { x: [] }, sources: { x: { ok: true } } }, onAction),
    renderUnit({ id: 'error', title: 'Error', span: 4, view: { kind: 'chart', chart: 'line', source: 'x', x: { key: 'a' }, series: [{ key: 'b', label: 'B' }] } }, { id: 'g', data: { x: null }, sources: { x: { ok: false, error: 'no file matches company/work/desk/pnl.json' } } }, onAction),
  ];
  fill(root,
    screenHead({ eyebrow: ['System', 'page kit'], title: 'Page kit.', lede: 'Every unit a company page can be built from, with sample data. Agents copy a scaffold (console-panel.js scaffold) and pick from these; docs/CONSOLE-DESIGN.md has the rules.', max: '760px', actions: [themePicker()] }),
    swatches(), note,
    h('section', { class: 'stack-14', 'aria-labelledby': 'kit-states' }, h('h2', { id: 'kit-states', class: 'h3' }, 'Every unit has a loading, empty and error state'),
      h('div', { class: 'page-wrap' }, h('div', { class: 'page-grid' }, states))),
    h('section', { class: 'stack-14', 'aria-labelledby': 'kit-units' }, h('h2', { id: 'kit-units', class: 'h3' }, 'Units'),
      h('div', { class: 'page-wrap' }, h('div', { class: 'page-grid' }, UNITS.map(([kind, name, what, u]) => {
        const unit = renderUnit(u, r, onAction);
        unit.dataset.galleryKind = kind;
        unit.append(h('p', { class: 'caption muted' }, h('strong', { class: 'strong' }, name + ' · '), what),
          h('details', null, h('summary', { class: 'caption', style: 'min-height:32px;color:var(--text-accent)' }, 'Declaration (' + kind + ')'), h('pre', { class: 'decl' }, JSON.stringify(u, null, 2))));
        return unit;
      })))));
}
