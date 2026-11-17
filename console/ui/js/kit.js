// Page kit: the console's built-in unit kinds (docs/CONSOLE-PANELS.md §4, docs/CONSOLE-DESIGN.md).
// Every kind is drawn here with design-system classes from kit.css; no agent code runs. Data never becomes markup
// (h() uses textContent), and SVG is built with createElementNS and attributes only.
import { h, fill, dig, rel, table } from './ui.js';

/* ---------- formats ---------- */
const company = () => (window.capheos && window.capheos.company) || {};
export function tz() { return company().timezone || undefined; }
export function fmt(v, f) {
  if (v == null || v === '') return '—';
  switch (f) {
    case 'number': return typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v);
    case 'integer': return typeof v === 'number' ? Math.round(v).toLocaleString() : String(v);
    case 'percent': return typeof v === 'number' ? (Math.abs(v) <= 1 ? (v * 100).toFixed(0) : v.toFixed(0)) + '%' : String(v);
    case 'money': return typeof v === 'number' ? v.toLocaleString(undefined, Object.assign({ style: 'currency', currency: company().currency || 'USD' }, Math.abs(v) >= 1000 ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {})) : String(v);
    case 'date': return dateFmt(v, { day: '2-digit', month: 'short' });
    case 'datetime': return dateFmt(v, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    case 'time': return dateFmt(v, { hour: '2-digit', minute: '2-digit' });
    case 'relative': return rel(v) || String(v);
    case 'duration': return typeof v === 'number' ? (v >= 3600 ? (v / 3600).toFixed(1) + ' h' : v >= 60 ? Math.round(v / 60) + ' min' : v + ' s') : String(v);
    case 'bool': return v ? 'Yes' : 'No';
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}
export function dateFmt(v, o) {
  const ms = typeof v === 'number' ? v : Date.parse(v); if (isNaN(ms)) return String(v);
  try { return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz() }, o)).format(ms); } catch (_) { return new Date(ms).toLocaleString(); }
}
const signed = (n, f) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), f);
const num = v => { const n = typeof v === 'number' ? v : v == null || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : NaN; };
const ms = v => typeof v === 'number' ? v : Date.parse(v);

/* calendar arithmetic in the company timezone */
function parts(t) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(t)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, key: o.year + '-' + o.month + '-' + o.day, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday), hm: o.hour + ':' + o.minute };
}
// a civil date (y, m, d) as a key, and stepping by days without timezone drift (noon UTC never crosses a date line here)
const civil = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d, 12)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), key: t.toISOString().slice(0, 10), wd: (t.getUTCDay() + 6) % 7 }; };

/* ---------- states ---------- */
export function stateLine(text, cls) { return h('p', { class: 'unit-state' + (cls ? ' ' + cls : ''), role: 'status' }, text); }
export function loadingState() { return h('div', { class: 'stack-8', 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div', { class: 'unit-skel', style: 'width:60%' }), h('div', { class: 'unit-skel', style: 'width:85%' }), h('div', { class: 'unit-skel', style: 'width:40%' })); }
export function emptyState(v, fallback) { return stateLine(v.empty || fallback || 'Nothing to show yet.'); }

export function srcData(r, name) { return r && r.data ? r.data[name] : undefined; }
export function rowsOf(r, v, key) { const d = dig(srcData(r, v.source), v.rows || (key ? v[key] : undefined)); return Array.isArray(d) ? d : d == null ? [] : [d]; }
function cmp(a, b) { if (a == null) return 1; if (b == null) return -1; return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)); }
const TONES = ['neutral', 'accent', 'good', 'warn', 'bad'];
function toneOf(val, map) {
  if (val == null) return null;
  const s = String(val).toLowerCase();
  if (map && map[val] != null) return map[val];
  if (map && map[s] != null) return map[s];
  return TONES.includes(s) ? s : null;
}
const HEALTH = { ok: ['ok', 'OK', 'good'], warn: ['warn', 'Warning', 'warn'], bad: ['bad', 'Down', 'bad'], unknown: ['unknown', 'Unknown', 'neutral'] };
function healthOf(val, map) {
  if (val == null) return 'unknown';
  if (map && map[val]) return map[val];
  const s = String(val).toLowerCase();
  if (map && map[s]) return map[s];
  if (HEALTH[s]) return s;
  if (/^(up|healthy|pass|green|online|running|operational)$/.test(s)) return 'ok';
  if (/^(degraded|slow|amber|yellow|warning|flapping)$/.test(s)) return 'warn';
  if (/^(down|fail|failed|red|error|critical|offline|outage)$/.test(s)) return 'bad';
  return 'unknown';
}
const SEV = { critical: 'bad', high: 'bad', error: 'bad', bad: 'bad', major: 'bad', warning: 'warn', warn: 'warn', medium: 'warn', minor: 'warn', info: 'neutral', low: 'neutral', notice: 'neutral', ok: 'good', resolved: 'good' };
const TONE_WORD = { bad: 'Critical', warn: 'Warning', good: 'Resolved', neutral: 'Info', accent: 'Note' };
function rowButtons(acts, row, onAction) { return acts.map(a => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => onAction(a, row) }, a.label)); }

/* ---------- the dispatcher: one entry point for every kind ---------- */
// ctx = { onAction(actionDecl, row, extra), rowActions: [decl] (row actions offered in this unit), all: [decl] }
export function renderView(v, r, ctx) {
  ctx = ctx || {}; const on = ctx.onAction || (() => {});
  switch (v.kind) {
    case 'stat': return statEl(v, r);
    case 'stat-row': return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px' }, (v.items || []).map(i => statEl(i, r)));
    case 'table': return tableView(v, r, ctx.rowActions || [], on);
    case 'list': return listView(v, r, ctx.rowActions || [], on);
    case 'timeline': return timelineView(v, r);
    case 'chart': return chartView(v, r);
    case 'kanban': return kanbanView(v, r, ctx);
    case 'calendar': return calendarView(v, r);
    case 'status-grid': return statusGridView(v, r);
    case 'positions': return positionsView(v, r, ctx.rowActions || [], on);
    case 'gauge': return meterView(v, r, true);
    case 'progress': return meterView(v, r, false);
    case 'pipeline': return pipelineView(v, r);
    case 'feed': return feedView(v, r, ctx);
    default: return stateLine('This kind (' + (v.kind || '?') + ') is not drawn here.');
  }
}

function statEl(i, r) {
  const val = dig(srcData(r, i.source), i.value);
  const n = num(val); let tone = '';
  if (i.goodWhen === 'zero' && Number.isFinite(n)) tone = n === 0 ? 'good' : 'warn';
  if (i.goodWhen === 'nonzero' && Number.isFinite(n)) tone = n !== 0 ? 'good' : 'warn';
  return h('div', { class: 'kpi' }, h('span', { class: 'big-num' }, fmt(val, i.format) + (i.unit ? ' ' + i.unit : '')),
    h('span', { class: 'caption muted' }, i.label || ''), tone ? h('span', { class: 'state tone-' + tone }, tone === 'good' ? 'As it should be' : 'Look at this') : null);
}
function tableView(v, r, acts, on) {
  let rows = rowsOf(r, v);
  if (v.sort && v.sort.key) rows = rows.slice().sort((a, b) => cmp(dig(a, v.sort.key), dig(b, v.sort.key)) * (v.sort.dir === 'desc' ? -1 : 1));
  rows = rows.slice(0, Math.min(v.limit || 200, 200));
  if (!rows.length) return emptyState(v, 'Nothing to show.');
  const cols = v.columns || [];
  const body = rows.map(row => h('tr', null,
    cols.map((c, i) => h('td', { class: (c.flag && dig(row, c.flag) ? 'warn ' : '') + (i === 0 ? 'num strong' : ''), style: c.width === 'wide' ? 'min-width:260px' : c.width === 'narrow' ? 'white-space:nowrap' : '' }, fmt(dig(row, c.key), c.format))),
    acts.length ? h('td', { style: 'text-align:right;white-space:nowrap' }, rowButtons(acts, row, on)) : null));
  return table(cols.map(c => c.label || c.key).concat(acts.length ? [''] : []), body, { minWidth: Math.min(560, 140 * cols.length), bare: true });
}
function listView(v, r, acts, on) {
  const rows = rowsOf(r, v, 'items').slice(0, v.limit || 50);
  if (!rows.length) return emptyState(v, 'Nothing to show.');
  return h('ul', { class: 'plain hair-top' }, rows.map(row => h('li', { class: 'between', style: 'padding:12px 0;border-bottom:1px solid var(--border-hairline)' },
    h('span', { class: 'stack-4' }, h('span', { class: 'label strong' }, fmt(dig(row, v.title))), v.subtitle ? h('span', { class: 'body-s muted' }, fmt(dig(row, v.subtitle))) : null),
    h('span', { class: 'row-8', style: 'align-items:center' }, v.badge && dig(row, v.badge) != null ? h('span', { class: 'tag tag-soft' }, fmt(dig(row, v.badge))) : null, rowButtons(acts, row, on)))));
}
function timelineView(v, r) {
  const rows = rowsOf(r, v, 'items').slice().sort((a, b) => cmp(dig(b, v.at), dig(a, v.at))).slice(0, v.limit || 50);
  if (!rows.length) return emptyState(v, 'Nothing yet.');
  return h('ol', { class: 'timeline' }, rows.map(row => h('li', null, h('span', { class: 'mono muted' }, fmt(dig(row, v.at), 'datetime')),
    h('span', { class: 'body-s' }, v.who ? h('strong', { class: 'strong', style: 'font-weight:600' }, fmt(dig(row, v.who)) + ' ') : null, fmt(dig(row, v.text))))));
}

/* ---------- positions ---------- */
function isShort(side, size) { const s = String(side || '').toLowerCase(); return /^(short|sell|s)$/.test(s) || (!s && size < 0); }
export function positionRows(v, r) {
  return rowsOf(r, v).map(row => {
    const size = num(dig(row, v.size)), entry = num(dig(row, v.entry)), mark = num(dig(row, v.mark));
    const side = v.side ? dig(row, v.side) : null; const short = isShort(side, size);
    let pnl = v.pnl ? num(dig(row, v.pnl)) : NaN;
    if (!Number.isFinite(pnl) && [size, entry, mark].every(Number.isFinite)) pnl = (mark - entry) * Math.abs(size) * (short ? -1 : 1);
    const value = Number.isFinite(mark) && Number.isFinite(size) ? Math.abs(size) * mark : NaN;
    return { row, symbol: dig(row, v.symbol), side: short ? 'Short' : 'Long', size, entry, mark, pnl, value };
  });
}
function positionsView(v, r, acts, on) {
  let rows = positionRows(v, r);
  if (v.sort && v.sort.key) rows.sort((a, b) => cmp(dig(a.row, v.sort.key), dig(b.row, v.sort.key)) * (v.sort.dir === 'desc' ? -1 : 1));
  else rows.sort((a, b) => Math.abs(b.pnl || 0) - Math.abs(a.pnl || 0));
  rows = rows.slice(0, v.limit || 200);
  if (!rows.length) return emptyState(v, 'No open positions.');
  const f = v.format || 'money';
  const pnlCell = n => h('td', { class: 'n ' + (n > 0 ? 't-pos' : n < 0 ? 't-neg' : '') }, Number.isFinite(n) ? signed(n, f) : '—');
  const th = (t, n) => h('th', { scope: 'col', class: n ? 'n' : '' }, t);
  const total = rows.reduce((s, x) => s + (Number.isFinite(x.pnl) ? x.pnl : 0), 0);
  const gross = rows.reduce((s, x) => s + (Number.isFinite(x.value) ? x.value : 0), 0);
  return h('div', { class: 'table-wrap bare pos' }, h('table', { class: 'tbl', style: 'min-width:560px' },
    h('caption', { class: 'sr-only' }, 'Open positions: symbol, side, size, entry, mark and unrealised profit or loss'),
    h('thead', null, h('tr', null, th('Symbol'), th('Side'), th('Size', 1), th('Entry', 1), th('Mark', 1), th('Unrealised P&L', 1), acts.length ? th('') : null)),
    h('tbody', null, rows.map(x => h('tr', null, h('th', { scope: 'row', class: 'strong' }, fmt(x.symbol)), h('td', null, h('span', { class: 'pside ' + (x.side === 'Short' ? 'muted' : 'strong') }, x.side)),
      h('td', { class: 'n' }, fmt(Math.abs(x.size), 'number')), h('td', { class: 'n' }, fmt(x.entry, 'number')), h('td', { class: 'n' }, fmt(x.mark, 'number')), pnlCell(x.pnl),
      acts.length ? h('td', { style: 'text-align:right;white-space:nowrap' }, rowButtons(acts, x.row, on)) : null))),
    v.totals === false ? null : h('tfoot', null, h('tr', null, h('td', { colspan: '2' }, 'Total (' + rows.length + ')'), h('td', { class: 'n', colspan: '3' }, 'Gross ' + fmt(gross, f)), pnlCell(total), acts.length ? h('td') : null))));
}

/* ---------- gauge / progress ---------- */
export function meterState(it, value, max) {
  const ratio = max > 0 ? value / max : NaN;
  const warnAt = it.warnAt != null ? it.warnAt : 0.8, badAt = it.badAt != null ? it.badAt : 1;
  if (!Number.isFinite(ratio)) return { ratio, tone: 'neutral', word: 'No data' };
  if (it.goodWhen === 'high') return ratio >= 1 ? { ratio, tone: 'good', word: 'Reached' } : { ratio, tone: 'accent', word: Math.round(ratio * 100) + '% of target' };
  if (ratio >= badAt) return { ratio, tone: 'bad', word: 'Over the limit' };
  if (ratio >= warnAt) return { ratio, tone: 'warn', word: 'Near the limit' };
  return { ratio, tone: 'neutral', word: 'Within the limit' };
}
function meterView(v, r, arc) {
  const items = (v.items || []).map(it => {
    const d = srcData(r, it.source || v.source);
    const value = num(dig(d, it.value)); const max = typeof it.max === 'number' ? it.max : num(dig(d, it.max));
    return Object.assign({ it, value, max }, meterState(it, value, max));
  });
  if (!items.length || items.every(x => !Number.isFinite(x.value))) return emptyState(v, 'No figures yet.');
  const val = x => fmt(x.value, x.it.format) + (x.it.unit ? ' ' + x.it.unit : '');
  const of = x => (x.it.goodWhen === 'high' ? 'Target ' : 'Limit ') + fmt(x.max, x.it.format) + (x.it.unit ? ' ' + x.it.unit : '');
  if (!arc) return h('ul', { class: 'prog' }, items.map(x => {
    const pct = Math.max(0, Math.min(1, x.ratio || 0));
    return h('li', { class: 'tone-' + x.tone },
      h('div', { class: 'top' }, h('span', { class: 'strong' }, x.it.label), h('span', null, h('span', { class: 'v' }, val(x)), h('span', { class: 'muted' }, ' / ' + fmt(x.max, x.it.format)))),
      h('div', { class: 'meter', role: 'meter', 'aria-label': x.it.label, 'aria-valuemin': '0', 'aria-valuemax': String(x.max), 'aria-valuenow': String(x.value), 'aria-valuetext': val(x) + ', ' + x.word }, h('div', { style: 'width:' + (pct * 100).toFixed(1) + '%' })),
      h('span', { class: 'state tone-' + x.tone }, x.word + (Number.isFinite(x.ratio) ? ' · ' + Math.round(x.ratio * 100) + '%' : '')));
  }));
  return h('div', { class: 'meters' }, items.map(x => {
    const pct = Math.max(0, Math.min(1, x.ratio || 0));
    const R = 50, cx = 60, cy = 60, len = Math.PI * R;
    const svg = s('svg', { viewBox: '0 0 120 72', role: 'img', 'aria-label': x.it.label + ': ' + val(x) + ', ' + of(x).toLowerCase() + ', ' + x.word.toLowerCase() });
    const arcD = 'M' + (cx - R) + ' ' + cy + ' A' + R + ' ' + R + ' 0 0 1 ' + (cx + R) + ' ' + cy;
    svg.append(s('path', { d: arcD, class: 'g-track' }), s('path', { d: arcD, class: 'g-val', 'stroke-dasharray': (len * pct).toFixed(2) + ' ' + len.toFixed(2) }),
      s('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', class: 'g-num' }, Number.isFinite(x.ratio) ? Math.round(x.ratio * 100) + '%' : '—'));
    return h('div', { class: 'gauge tone-' + x.tone }, svg, h('span', { class: 'g-label' }, x.it.label), h('span', { class: 'g-of' }, val(x) + ' · ' + of(x)), h('span', { class: 'state tone-' + x.tone }, x.word));
  }));
}

/* ---------- pipeline ---------- */
export function pipelineStages(v, r) {
  const rows = rowsOf(r, v);
  if (v.by) {
    const order = (v.stages || []).map(s => ({ id: String(s.id), label: s.label, count: 0, stuck: 0 }));
    const at = new Map(order.map(s => [s.id, s]));
    for (const row of rows) {
      const k = String(dig(row, v.by) ?? '—');
      let st = at.get(k); if (!st) { if (v.stages) continue; st = { id: k, label: k, count: 0, stuck: 0 }; at.set(k, st); order.push(st); }
      st.count++; if (v.stuck && dig(row, v.stuck)) st.stuck++;
    }
    return order;
  }
  return rows.map(row => { const st = dig(row, v.stuck); return { id: String(dig(row, v.label)), label: dig(row, v.label), count: num(dig(row, v.count)), stuck: typeof st === 'number' ? st : st ? 1 : 0 }; });
}
function pipelineView(v, r) {
  const st = pipelineStages(v, r);
  if (!st.length) return emptyState(v, 'Nothing in the pipeline.');
  return h('ol', { class: 'pipe', 'aria-label': 'Pipeline stages' }, st.map((x, i) => h('li', { class: x.stuck ? 'stuck' : '' },
    h('span', { class: 'p-label' }, (i + 1) + '. ' + fmt(x.label)), h('span', { class: 'p-n' }, fmt(x.count, 'integer')),
    x.stuck ? h('span', { class: 'p-stuck' }, x.stuck + ' stuck') : h('span', { class: 'p-ok' }, 'none stuck'))));
}

/* ---------- feed ---------- */
function feedView(v, r, ctx) {
  const rows = rowsOf(r, v).slice().sort((a, b) => cmp(ms(dig(b, v.at)), ms(dig(a, v.at)))).slice(0, v.limit || 50);
  if (!rows.length) return emptyState(v, 'No alerts. All quiet.');
  const ack = v.ack && (ctx.all || []).find(a => a.id === v.ack);
  const on = ctx.onAction || (() => {});
  return h('ul', { class: 'feed' }, rows.map(row => {
    const sev = v.severity ? dig(row, v.severity) : null;
    const tone = toneOf(sev, v.severityMap) || SEV[String(sev || '').toLowerCase()] || 'neutral';
    const acked = v.acked ? !!dig(row, v.acked) : false;
    return h('li', { class: 'tone-' + tone + (acked ? ' acked' : '') },
      h('div', { class: 'stack-4' }, h('span', { class: 'f-title' }, fmt(dig(row, v.title))), v.text && dig(row, v.text) != null ? h('span', { class: 'f-text' }, fmt(dig(row, v.text))) : null,
        h('span', { class: 'f-meta' }, sev != null ? h('span', { class: 'state tone-' + tone }, String(sev).charAt(0).toUpperCase() + String(sev).slice(1)) : h('span', { class: 'state tone-' + tone }, TONE_WORD[tone]),
          v.origin && dig(row, v.origin) != null ? h('span', null, fmt(dig(row, v.origin))) : null,
          h('time', { datetime: String(dig(row, v.at) || '') , title: fmt(dig(row, v.at), 'datetime') }, fmt(dig(row, v.at), 'relative')))),
      h('div', { class: 'f-side' }, acked ? h('span', { class: 'caption muted' }, 'Acknowledged') : ack ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => on(ack, row) }, ack.label) : null,
        rowButtons((ctx.rowActions || []).filter(a => a !== ack), row, on)));
  }));
}

/* ---------- status grid ---------- */
function statusGridView(v, r) {
  const rows = rowsOf(r, v).slice(0, v.limit || 200);
  if (!rows.length) return emptyState(v, 'Nothing is being checked yet.');
  const N = v.historyN || 20;
  const tiles = rows.map(row => ({ row, st: healthOf(dig(row, v.state), v.stateMap), group: v.group ? String(dig(row, v.group) ?? 'Other') : '' }));
  const count = k => tiles.filter(t => t.st === k).length;
  const groups = []; const gi = new Map();
  for (const t of tiles) { if (!gi.has(t.group)) { gi.set(t.group, []); groups.push(t.group); } gi.get(t.group).push(t); }
  const rank = { bad: 0, warn: 1, unknown: 2, ok: 3 };
  return h('div', { class: 'stack-14' },
    h('div', { class: 'sg-sum', role: 'status' }, ['bad', 'warn', 'ok', 'unknown'].filter(k => count(k) || k === 'ok').map(k => h('span', { class: 'state tone-' + k }, count(k) + ' ' + HEALTH[k][1].toLowerCase()))),
    groups.map(g => h('section', { class: 'sg-group', 'aria-label': g || 'Checks' }, g ? h('h3', { class: 'sg-gname' }, g) : null,
      h('ul', { class: 'sg-tiles' }, gi.get(g).slice().sort((a, b) => rank[a.st] - rank[b.st]).map(t => {
        const hist = v.history ? dig(t.row, v.history) : null;
        const checked = v.checked ? dig(t.row, v.checked) : null;
        return h('li', { class: 'sg-tile tone-' + t.st },
          h('span', { class: 'state tone-' + t.st }, HEALTH[t.st][1]),
          h('span', { class: 'sg-name' }, fmt(dig(t.row, v.name))),
          v.detail && dig(t.row, v.detail) != null ? h('span', { class: 'sg-detail' }, fmt(dig(t.row, v.detail))) : null,
          Array.isArray(hist) && hist.length ? sparkline(hist.slice(-N), v.stateMap) : null,
          checked ? h('span', { class: 'sg-when' }, 'checked ' + fmt(checked, 'relative')) : null);
      }))))
  );
}
function sparkline(hist, map) {
  const W = 120, H = 20; const n = hist.length;
  const numeric = hist.every(x => typeof x === 'number');
  const svg = s('svg', { class: 'spark', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img' });
  if (numeric) {
    const lo = Math.min(...hist), hi = Math.max(...hist), span = hi - lo || 1;
    svg.setAttribute('aria-label', 'Last ' + n + ' checks: from ' + fmt(hist[0], 'number') + ' to ' + fmt(hist[n - 1], 'number'));
    svg.append(s('polyline', { class: 'sk-line', points: hist.map((x, i) => (n === 1 ? W / 2 : (i * W) / (n - 1)).toFixed(1) + ',' + (H - 2 - ((x - lo) / span) * (H - 4)).toFixed(1)).join(' '), 'vector-effect': 'non-scaling-stroke' }));
    return svg;
  }
  const st = hist.map(x => healthOf(x, map));
  const bad = st.filter(x => x !== 'ok').length;
  svg.setAttribute('aria-label', 'Last ' + n + ' checks: ' + (n - bad) + ' ok, ' + bad + ' not ok');
  const w = W / n;
  st.forEach((x, i) => svg.append(s('rect', { class: 'sk-' + x, x: (i * w + 0.5).toFixed(2), y: x === 'ok' ? 6 : 0, width: Math.max(1, w - 1.5).toFixed(2), height: x === 'ok' ? H - 6 : H, rx: 1 })));
  return svg;
}

/* ---------- kanban ---------- */
export function kanbanColumns(v, r) {
  const rows = rowsOf(r, v);
  const cols = v.columns ? v.columns.map(c => ({ id: String(c.id), label: c.label, limit: c.limit, cards: [] })) : [];
  const at = new Map(cols.map(c => [c.id, c]));
  for (const row of rows) {
    const k = String(dig(row, v.column) ?? '—');
    let c = at.get(k);
    if (!c) { if (v.columns) continue; c = { id: k, label: k, cards: [] }; at.set(k, c); cols.push(c); }
    if (c.cards.length < (v.limit || 100)) c.cards.push(row);
  }
  return cols;
}
function kanbanView(v, r, ctx) {
  const cols = kanbanColumns(v, r);
  if (!cols.length || cols.every(c => !c.cards.length)) return emptyState(v, 'No cards yet.');
  const move = v.move && (ctx.all || []).find(a => a.id === v.move);
  const on = ctx.onAction || (() => {});
  const today = parts(Date.now()).key;
  const card = (row, col) => {
    const due = v.due ? dig(row, v.due) : null; const dueKey = due && !isNaN(ms(due)) ? parts(ms(due)).key : null;
    const late = dueKey && dueKey < today;
    const done = v.steps ? num(dig(row, v.steps.done)) : NaN, total = v.steps ? num(dig(row, v.steps.total)) : NaN;
    const who = v.assignee ? dig(row, v.assignee) : null;
    const tone = v.tone ? toneOf(dig(row, v.tone), v.toneMap) : null;
    const li = h('li', { class: 'kb-card' + (tone ? ' tone-' + tone : '') },
      h('span', { class: 'kb-title' }, fmt(dig(row, v.title))),
      v.subtitle && dig(row, v.subtitle) != null ? h('span', { class: 'kb-sub' }, fmt(dig(row, v.subtitle))) : null,
      v.badges ? h('span', { class: 'kb-badges' }, v.badges.map(b => dig(row, b)).filter(x => x != null && x !== '').flatMap(x => Array.isArray(x) ? x : [x]).slice(0, 6).map(x => h('span', { class: 'tag tag-soft' }, fmt(x)))) : null,
      Number.isFinite(total) && total > 0 ? h('span', { class: 'kb-steps' }, h('span', { class: 'meter thin', role: 'meter', 'aria-label': 'Steps done', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done || 0) }, h('div', { style: 'width:' + Math.min(100, ((done || 0) / total) * 100).toFixed(0) + '%' })), (done || 0) + '/' + total + ' steps') : null,
      (who || due) ? h('span', { class: 'kb-foot' }, who ? h('span', { class: 'kb-who' }, h('span', { class: 'kb-av', 'aria-hidden': 'true' }, String(who).trim().charAt(0).toUpperCase()), String(who)) : h('span'),
        due ? h('span', { class: 'kb-due' + (late ? ' late' : '') }, (late ? 'Overdue · ' : 'Due ') + fmt(due, 'date')) : null) : null);
    if (move) {
      const others = cols.filter(c => c.id !== col.id);
      const sel = h('select', { class: 'select', 'aria-label': 'Move "' + fmt(dig(row, v.title)) + '" to' }, others.map(c => h('option', { value: c.id }, c.label)));
      li.append(h('div', { class: 'kb-move' }, sel, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { const to = cols.find(c => c.id === sel.value); on(move, row, { move: { from: col.label, to: to ? to.label : sel.value, fromId: col.id, toId: sel.value } }); } }, move.label)));
    }
    return li;
  };
  return h('div', { class: 'kb', role: 'list', 'aria-label': 'Board' }, cols.map(c => h('section', { class: 'kb-col', role: 'listitem', 'aria-label': c.label + ', ' + c.cards.length + ' cards' },
    h('div', { class: 'kb-col-head' }, h('span', null, c.label), h('span', { class: 'kb-n' + (c.limit && c.cards.length > c.limit ? ' over' : '') }, c.cards.length + (c.limit ? ' / ' + c.limit : ''))),
    c.cards.length ? h('ul', { class: 'kb-cards' }, c.cards.map(row => card(row, c))) : h('p', { class: 'kb-empty' }, 'Nothing here.'))));
}

/* ---------- calendar ---------- */
function calendarView(v, r) {
  const rows = rowsOf(r, v).slice(0, v.limit || 500);
  const evs = rows.map(row => {
    const a = ms(dig(row, v.start)); const b = v.end ? ms(dig(row, v.end)) : NaN;
    return { row, a, b: Number.isFinite(b) && b > a ? b : a, title: fmt(dig(row, v.title)), tone: v.tone ? toneOf(dig(row, v.tone), v.toneMap) : null, allDay: v.allDay ? !!dig(row, v.allDay) : false };
  }).filter(e => Number.isFinite(e.a)).sort((x, y) => x.a - y.a);
  const views = v.views || ['month', 'week', 'agenda'];
  let mode = views.includes(v.view) ? v.view : views[0];
  const now = parts(Date.now());
  let cur = civil(now.y, now.m, now.d);
  const wrap = h('div', { class: 'stack-10' });
  const dayKeys = e => { const out = []; const s0 = parts(e.a), s1 = parts(e.b); let d = civil(s0.y, s0.m, s0.d); for (let i = 0; i < 62 && d.key <= s1.key; i++) { out.push(d.key); d = civil(d.y, d.m, d.d + 1); } return out; };
  const byDay = new Map();
  for (const e of evs) for (const k of dayKeys(e)) { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const chip = e => h('span', { class: 'cal-ev' + (e.tone ? ' tone-' + e.tone : ''), title: e.title + ' · ' + (e.allDay ? 'all day' : fmt(e.a, 'datetime')) }, (e.allDay ? '' : parts(e.a).hm + ' ') + e.title);
  const draw = () => {
    const tabsEl = views.length > 1 ? h('div', { class: 'theme-pick', role: 'group', 'aria-label': 'Calendar view' }, views.map(m => h('button', { type: 'button', 'aria-pressed': String(m === mode), onclick: () => { mode = m; draw(); } }, m.charAt(0).toUpperCase() + m.slice(1)))) : null;
    const step = dir => { if (mode === 'month') cur = civil(cur.y, cur.m + dir, 1); else if (mode === 'week') cur = civil(cur.y, cur.m, cur.d + 7 * dir); else cur = civil(cur.y, cur.m, cur.d + 14 * dir); draw(); };
    let title, body;
    if (mode === 'month') {
      const first = civil(cur.y, cur.m, 1); const start = civil(first.y, first.m, 1 - first.wd);
      title = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(first.y, first.m - 1, 1, 12));
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = civil(start.y, start.m, start.d + i); if (i === 35 && d.m !== first.m) break;
        const list = byDay.get(d.key) || [];
        cells.push(h('div', { class: 'cal-day' + (d.m !== first.m ? ' out' : '') + (d.key === now.key ? ' today' : ''), role: 'gridcell', 'aria-label': d.d + ' ' + title + (list.length ? ', ' + list.length + ' event' + (list.length > 1 ? 's' : '') + ': ' + list.map(e => e.title).join('; ') : '') },
          h('span', { class: 'cal-num', 'aria-hidden': 'true' }, String(d.d)), list.slice(0, 3).map(chip), list.length > 3 ? h('span', { class: 'cal-more' }, '+' + (list.length - 3) + ' more') : null));
      }
      body = h('div', { class: 'cal-month', role: 'grid', 'aria-label': title }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => h('div', { class: 'cal-dow', role: 'columnheader' }, x)), cells);
    } else if (mode === 'week') {
      const start = civil(cur.y, cur.m, cur.d - cur.wd);
      const days = Array.from({ length: 7 }, (_, i) => civil(start.y, start.m, start.d + i));
      const lab = d => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).format(Date.UTC(d.y, d.m - 1, d.d, 12));
      title = 'Week of ' + lab(days[0]);
      body = h('div', { class: 'cal-week' }, days.map(d => h('section', { class: 'cal-wcol', 'aria-label': lab(d) }, h('span', { class: 'cal-whead' + (d.key === now.key ? ' today' : '') }, lab(d)),
        (byDay.get(d.key) || []).map(chip), (byDay.get(d.key) || []).length ? null : h('span', { class: 'cal-more' }, '—'))));
    } else {
      const from = cur.key; const upto = civil(cur.y, cur.m, cur.d + 30).key;
      const list = evs.filter(e => { const k0 = parts(e.a).key, k1 = parts(e.b).key; return k1 >= from && k0 <= upto; });
      title = 'Next 30 days';
      body = list.length ? h('ul', { class: 'cal-agenda' }, list.map(e => h('li', null, h('span', { class: 'cal-time' }, fmt(e.a, e.allDay ? 'date' : 'datetime')), chip(e)))) : emptyState(v, 'Nothing in the next 30 days.');
    }
    fill(wrap, h('div', { class: 'cal-bar' }, h('span', { class: 'cal-title', 'aria-live': 'polite' }, title),
      h('div', { class: 'cal-nav' }, h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { cur = civil(now.y, now.m, now.d); draw(); } }, 'Today'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Next', onclick: () => step(1) }, '›')), tabsEl),
      body, h('span', { class: 'caption muted' }, 'Times in ' + (tz() || 'local time') + '.'));
  };
  if (!evs.length) return emptyState(v, 'Nothing on the calendar.');
  draw();
  return wrap;
}

/* ---------- charts: hand-written SVG, sized to the unit, table fallback ---------- */
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, text) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, String(v)); if (text != null) el.textContent = String(text); return el; }
function niceTicks(lo, hi, n) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo; const step0 = Math.pow(10, Math.floor(Math.log10(span / n))); const err = (n * step0) / span;
  const step = step0 * (err <= 0.15 ? 10 : err <= 0.35 ? 5 : err <= 0.75 ? 2 : 1);
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step; const out = [];
  for (let x = a; x <= b + step / 2; x += step) out.push(Math.round(x / step) * step);
  return out;
}
const short = (n, f) => { if (f === 'percent') return fmt(n, f); const a = Math.abs(n); const pre = f === 'money' ? '' : ''; return a >= 1e9 ? pre + (n / 1e9).toFixed(1) + 'B' : a >= 1e6 ? pre + (n / 1e6).toFixed(1) + 'M' : a >= 1e4 ? pre + (n / 1e3).toFixed(0) + 'k' : fmt(n, 'number'); };
export function chartModel(v, r) {
  const rows = rowsOf(r, v).slice(0, v.limit || 500);
  const isTime = !!(v.x && v.x.time);
  const pts = rows.map(row => ({ row, x: dig(row, v.x.key) })).filter(p => p.x != null);
  if (isTime) pts.sort((a, b) => ms(a.x) - ms(b.x));
  const series = (v.series || []).map((sr, i) => ({ key: sr.key, label: sr.label, format: sr.format || (v.y && v.y.format), cls: 's' + (i + 1), tone: sr.tone }));
  const refs = (v.refs || []).map(rf => ({ label: rf.label, tone: rf.tone, value: rf.value != null ? rf.value : num(dig(srcData(r, v.source), rf.from)) })).filter(x => Number.isFinite(x.value));
  return { rows: pts, series, refs, isTime };
}
function chartView(v, r) {
  const m = chartModel(v, r);
  if (!m.rows.length) return emptyState(v, 'No data to chart yet.');
  const host = h('div', { class: 'ch' });
  const tip = h('div', { class: 'ch-tip', hidden: true, role: 'presentation' });
  const legend = legendEl(v, m);
  const yf = (v.y && v.y.format) || (m.series[0] && m.series[0].format) || 'number';
  const tableCols = [v.x.label || v.x.key].concat(v.chart === 'candlestick' ? ['Open', 'High', 'Low', 'Close'] : m.series.map(x => x.label));
  const tb = m.rows.map(p => h('tr', null, h('td', { class: 'num' }, fmt(p.x, v.x.format || (m.isTime ? 'datetime' : null))),
    (v.chart === 'candlestick' ? ['open', 'high', 'low', 'close'].map(k => dig(p.row, v.ohlc[k])) : m.series.map(sr => dig(p.row, sr.key))).map((x, i) => h('td', { class: 'num' }, fmt(num(x), v.chart === 'candlestick' ? yf : m.series[i].format || yf)))));
  const fallback = h('details', { class: 'as-table' }, h('summary', null, 'Show as a table'), table(tableCols, tb, { minWidth: 120 * tableCols.length, bare: true }));
  let lastW = 0;
  const draw = () => { const W = Math.max(260, Math.round(host.clientWidth || 600)); if (W === lastW) return; lastW = W; fill(host, drawChart(v, m, W, tip, yf), tip); };
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  if (ro) ro.observe(host);
  requestAnimationFrame(draw);
  return h('div', { class: 'stack-8' }, host, legend, fallback);
}
function legendEl(v, m) {
  const items = [];
  if (v.chart === 'candlestick') items.push(h('li', null, h('span', { class: 'sw box up' }), 'Up (close above open)'), h('li', null, h('span', { class: 'sw box down' }), 'Down'));
  else if (m.series.length > 1 || v.legend) m.series.forEach(sr => items.push(h('li', null, h('span', { class: 'sw ' + (v.chart === 'line' ? '' : 'box ') + sr.cls }), sr.label)));
  m.refs.forEach(rf => items.push(h('li', { class: rf.tone ? 'tone-' + rf.tone : '' }, h('span', { class: 'sw ref' }), rf.label + ' (' + short(rf.value, (v.y && v.y.format)) + ')')));
  return items.length ? h('ul', { class: 'legend', 'aria-label': 'Legend' }, items) : null;
}
function drawChart(v, m, W, tip, yf) {
  const H = v.height || 220; const padL = 52, padR = m.refs.length ? 16 : 12, padT = 12, padB = 28;
  const iw = W - padL - padR, ih = H - padT - padB;
  const kind = v.chart; const n = m.rows.length;
  const val = (p, k) => num(dig(p.row, k));
  // y domain
  let lo = Infinity, hi = -Infinity;
  const see = x => { if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } };
  if (kind === 'candlestick') m.rows.forEach(p => { see(val(p, v.ohlc.low)); see(val(p, v.ohlc.high)); });
  else if (kind === 'stacked-bar') m.rows.forEach(p => { let pos = 0, neg = 0; m.series.forEach(sr => { const x = val(p, sr.key); if (x > 0) pos += x; else if (x < 0) neg += x; }); see(pos); see(neg); });
  else m.rows.forEach(p => m.series.forEach(sr => see(val(p, sr.key))));
  m.refs.forEach(rf => see(rf.value));
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  const wantZero = v.y && v.y.zero != null ? v.y.zero : ['bar', 'stacked-bar', 'area'].includes(kind);
  if (wantZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (kind === 'scatter' || kind === 'candlestick' || (!wantZero)) { const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad; }
  const ticks = niceTicks(lo, hi, Math.max(3, Math.min(6, Math.round(ih / 44))));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const Y = x => padT + ih - ((x - y0) / (y1 - y0 || 1)) * ih;
  // x positions
  const banded = ['bar', 'stacked-bar', 'candlestick'].includes(kind) || (!m.isTime && kind !== 'scatter');
  let X, band = 0, xs;
  if (kind === 'scatter') { xs = m.rows.map(p => num(p.x)); const a = Math.min(...xs), b = Math.max(...xs); const t = niceTicks(a, b, 5); X = i => padL + ((xs[i] - t[0]) / (t[t.length - 1] - t[0] || 1)) * iw; X.ticks = t.map(tv => ({ at: padL + ((tv - t[0]) / (t[t.length - 1] - t[0] || 1)) * iw, label: short(tv, v.x.format) })); }
  else if (banded && kind !== 'line' && kind !== 'area') { band = iw / n; X = i => padL + band * (i + 0.5); }
  else if (m.isTime) { xs = m.rows.map(p => ms(p.x)); const a = xs[0], b = xs[n - 1]; X = i => padL + (b === a ? iw / 2 : ((xs[i] - a) / (b - a)) * iw); }
  else X = i => padL + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': summary(v, m, yf) });
  // grid + y labels
  const g = s('g', { class: 'grid' });
  const big = Math.max(...ticks.map(Math.abs)); const ylab = t => yf === 'percent' ? fmt(t, yf) : big >= 1e6 ? +(t / 1e6).toFixed(1) + 'M' : big >= 1e4 ? +(t / 1e3).toFixed(1) + 'k' : fmt(t, 'number');
  ticks.forEach(t => { g.append(s('line', { x1: padL, x2: W - padR, y1: Y(t).toFixed(1), y2: Y(t).toFixed(1) })); svg.append(s('text', { x: padL - 8, y: Y(t) + 4, 'text-anchor': 'end' }, ylab(t))); });
  svg.append(g);
  if (y0 < 0 && y1 > 0) svg.append(s('line', { class: 'axis', x1: padL, x2: W - padR, y1: Y(0), y2: Y(0) }));
  svg.append(s('line', { class: 'axis', x1: padL, x2: W - padR, y1: padT + ih, y2: padT + ih }));
  // x labels: at most ~W/90 of them
  const xfmt = v.x.format || (m.isTime ? (spanDays(m) > 2 ? 'date' : 'time') : null);
  if (X.ticks) X.ticks.forEach(t => svg.append(s('text', { x: t.at, y: H - 8, 'text-anchor': 'middle' }, t.label)));
  else { const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 90)))); for (let i = 0; i < n; i += every) svg.append(s('text', { x: X(i), y: H - 8, 'text-anchor': i === 0 && !band ? 'start' : 'middle' }, fmt(m.rows[i].x, xfmt))); }
  // marks
  const marks = s('g');
  if (kind === 'line' || kind === 'area') m.series.forEach(sr => {
    const pts = m.rows.map((p, i) => [X(i), val(p, sr.key)]).filter(q => Number.isFinite(q[1]));
    if (!pts.length) return;
    const d = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + Y(q[1]).toFixed(1)).join(' ');
    if (kind === 'area') marks.append(s('path', { class: 'ar ' + sr.cls, d: d + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + Y(Math.max(y0, 0)).toFixed(1) + ' L' + pts[0][0].toFixed(1) + ' ' + Y(Math.max(y0, 0)).toFixed(1) + ' Z' }));
    marks.append(s('path', { class: 'ln ' + sr.cls, d }));
    if (pts.length <= 2) pts.forEach(q => marks.append(s('circle', { class: 'dot ' + sr.cls, cx: q[0], cy: Y(q[1]), r: 4 })));
  });
  if (kind === 'bar') { const k = m.series.length; const bw = Math.max(2, Math.min(28, (band * 0.72) / k)); m.rows.forEach((p, i) => m.series.forEach((sr, j) => { const x = val(p, sr.key); if (!Number.isFinite(x)) return; const top = Y(Math.max(x, 0)), bot = Y(Math.min(x, 0)); marks.append(s('rect', { class: 'bar ' + sr.cls, x: (X(i) - (bw * k) / 2 + j * bw + 1).toFixed(1), y: top.toFixed(1), width: Math.max(1, bw - 2).toFixed(1), height: Math.max(1, bot - top).toFixed(1), rx: 2 })); })); }
  if (kind === 'stacked-bar') { const bw = Math.max(4, Math.min(40, band * 0.66)); m.rows.forEach((p, i) => { let pos = 0, neg = 0; m.series.forEach(sr => { const x = val(p, sr.key); if (!Number.isFinite(x) || !x) return; const a = x > 0 ? pos : neg; const b = a + x; if (x > 0) pos = b; else neg = b; const top = Y(Math.max(a, b)), bot = Y(Math.min(a, b)); marks.append(s('rect', { class: 'bar ' + sr.cls, x: (X(i) - bw / 2).toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: Math.max(1, bot - top - 1).toFixed(1), rx: 1 })); }); }); }
  if (kind === 'candlestick') { const bw = Math.max(3, Math.min(16, band * 0.6)); m.rows.forEach((p, i) => { const o = val(p, v.ohlc.open), hh = val(p, v.ohlc.high), l = val(p, v.ohlc.low), c = val(p, v.ohlc.close); if (![o, hh, l, c].every(Number.isFinite)) return; const cls = c >= o ? 'up' : 'down'; marks.append(s('line', { class: 'wick ' + cls, x1: X(i), x2: X(i), y1: Y(hh), y2: Y(l) })); const top = Y(Math.max(o, c)), bot = Y(Math.min(o, c)); marks.append(s('rect', { class: cls, x: (X(i) - bw / 2).toFixed(1), y: top.toFixed(1), width: bw.toFixed(1), height: Math.max(1.5, bot - top).toFixed(1), rx: 1 })); }); }
  if (kind === 'scatter') m.series.forEach(sr => m.rows.forEach((p, i) => { const y = val(p, sr.key); if (Number.isFinite(y) && Number.isFinite(xs[i])) marks.append(s('circle', { class: 'dot ' + sr.cls, cx: X(i).toFixed(1), cy: Y(y).toFixed(1), r: 4.5 })); }));
  svg.append(marks);
  // reference lines (limits): dashed, labelled in text ink
  m.refs.forEach(rf => { const y = Y(rf.value); const gr = s('g', { class: rf.tone ? 'tone-' + rf.tone : '' }); gr.append(s('line', { class: 'ref', x1: padL, x2: W - padR, y1: y, y2: y }), s('text', { class: 'ref-l', x: W - padR - 4, y: y - 5, 'text-anchor': 'end' }, rf.label)); svg.append(gr); });
  // hover: crosshair + tooltip, nearest x
  const cross = s('line', { class: 'cross', y1: padT, y2: padT + ih, visibility: 'hidden' });
  svg.append(cross);
  const hit = s('rect', { class: 'hit', x: padL, y: padT, width: iw, height: ih });
  const show = ev => {
    const box = svg.getBoundingClientRect(); const px = ((ev.clientX - box.left) / box.width) * W;
    let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - px); if (d < bd) { bd = d; best = i; } }
    const p = m.rows[best]; cross.setAttribute('x1', X(best)); cross.setAttribute('x2', X(best)); cross.setAttribute('visibility', 'visible');
    const lines = kind === 'candlestick' ? ['open', 'high', 'low', 'close'].map(k => [k.charAt(0).toUpperCase() + k.slice(1), fmt(val(p, v.ohlc[k]), yf), '']) : m.series.map(sr => [sr.label, fmt(val(p, sr.key), sr.format || yf), sr.cls]);
    fill(tip, h('strong', null, fmt(p.x, v.x.format || (m.isTime ? 'datetime' : null))), lines.map(([a, b, cls]) => h('div', { class: 'row' }, h('span', null, cls ? h('span', { class: 'sw box ' + cls, style: 'margin-right:6px' }) : null, a), h('span', { class: 'v' }, b))));
    tip.hidden = false; const left = (X(best) / W) * box.width; tip.style.left = Math.max(0, Math.min(box.width - 180, left + 12)) + 'px'; tip.style.top = '8px';
  };
  hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  svg.append(hit);
  return svg;
}
function spanDays(m) { if (!m.isTime || m.rows.length < 2) return 0; return (ms(m.rows[m.rows.length - 1].x) - ms(m.rows[0].x)) / 864e5; }
function summary(v, m, yf) {
  const name = { line: 'Line chart', bar: 'Bar chart', area: 'Area chart', 'stacked-bar': 'Stacked bar chart', candlestick: 'Candlestick chart', scatter: 'Scatter plot' }[v.chart] || 'Chart';
  const xf = v.x.format || (m.isTime ? 'date' : null);
  const first = m.rows[0], last = m.rows[m.rows.length - 1];
  const tail = v.chart === 'candlestick' ? 'last close ' + fmt(num(dig(last.row, v.ohlc.close)), yf) : m.series.map(sr => sr.label + ' latest ' + fmt(num(dig(last.row, sr.key)), sr.format || yf)).join('; ');
  return name + ' of ' + (v.chart === 'candlestick' ? 'price' : m.series.map(x => x.label).join(', ')) + ', ' + m.rows.length + ' points from ' + fmt(first.x, xf) + ' to ' + fmt(last.x, xf) + '; ' + tail + (m.refs.length ? '; reference lines: ' + m.refs.map(rf => rf.label + ' ' + fmt(rf.value, yf)).join(', ') : '') + '. A table view follows.';
}
