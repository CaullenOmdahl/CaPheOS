// Company panels (docs/CONSOLE-PANELS.md). Built-in kinds drawn here; `custom` in a sandboxed srcdoc iframe (§6).
import { h, fill, Button, errLine, dig, rel, table } from './ui.js';
import { api, post } from './api.js';
import * as events from './events.js';

const LIMITS = { today: 6, side: 3 };

// list panels for a placement key ('today' or 'side:<screen>'), enforcing hidden/valid/limit at render (§11)
export async function panelsFor(key) {
  const d = await api('/panels');
  const list = (d.panels || []).filter(p => p.status === 'installed' && !p.hidden && p.valid !== false && p.placement === key);
  return list.sort((a, b) => (a.order || 50) - (b.order || 50) || String(a.id).localeCompare(b.id)).slice(0, key === 'today' ? LIMITS.today : LIMITS.side);
}

// mount every panel for `key` into `host`; returns cleanup
export function mountPanels(host, key, app) {
  const stops = [];
  let alive = true;
  const load = async () => {
    let list;
    try { list = await panelsFor(key); }
    catch (e) { fill(host, errLine(e, 'Panels')); return; }
    if (!alive) return;
    stops.splice(0).forEach(f => f());
    fill(host);
    for (const p of list) { const el = h('div'); host.appendChild(el); stops.push(mountPanel(el, p, app)); }
  };
  load();
  const off = events.on('panels', load);
  return () => { alive = false; off(); stops.forEach(f => f()); };
}

export function mountPanel(el, meta, app) {
  const body = h('div', { class: 'stack-8' }, h('p', { class: 'caption muted' }, 'Loading…'));
  const sub = h('span', { class: 'caption muted' }, 'Panel · refreshes every ' + fmtSecs(Math.max(meta.refresh || 300, 30)));
  const info = h('details', { class: 'body-s' }, h('summary', { style: 'min-height:32px;color:var(--text-accent)' }, 'About this panel'), h('div', { class: 'stack-6 caption muted', style: 'padding-top:6px;max-width:520px' }));
  const hide = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => {
    if (!(await app.confirmDialog({ title: 'Hide "' + (meta.title || meta.id) + '"?', body: 'It stays installed; unhide it from Controls › Console panels.', confirm: 'Hide' }))) return;
    try { await post('/panels/' + encodeURIComponent(meta.id) + '/hide'); app.toast('Panel hidden.'); } catch (e) { app.toast('Could not hide: ' + e.message, true); }
  } }, 'Hide');
  const headId = 'panel-' + meta.id;
  const sec = h('section', { 'aria-labelledby': headId, class: 'card' },
    h('div', { class: 'between' },
      h('div', { class: 'stack-4' }, h('h2', { id: headId, class: 'h4' }, meta.title || meta.id), sub),
      h('div', { class: 'row-14', style: 'align-items:flex-start' }, hide, info)),
    body);
  fill(el, sec);
  let frameCtl = null, timer = null, dead = false, want = 200;   // a list panel's rows: 200 at a time, "Load more" asks for 200 more
  const load = async () => {
    if (document.hidden) return;
    let r;
    try { r = await api('/panels/' + encodeURIComponent(meta.id) + '/data?limit=' + want); }
    catch (e) { fill(body, errLine(e, 'Panel data')); return; }
    if (dead) return;
    sub.textContent = 'Panel by ' + (r.owner || meta.owner || '?') + ' · refreshes every ' + fmtSecs(r.refresh || 300);
    fill(info.lastChild, h('span', null, h('strong', null, 'Why: '), r.why || '—'), h('span', null, h('strong', null, 'Owner: '), r.owner || '—'), h('span', null, h('strong', null, 'Id: '), r.id));
    const failed = Object.entries(r.sources || {}).filter(([, s]) => s && !s.ok && !s.offline);
    if (r.view && r.view.kind === 'custom') {
      if (!frameCtl) { fill(body); frameCtl = customFrame(body, meta, r, app); } else frameCtl.send(r);
    } else {
      fill(body, renderKind(r.view || {}, r, (a, row) => runAction(r, a, row, app)),
        failed.length ? h('p', { class: 'err-line' }, 'Source ' + failed.map(([n, s]) => n + ': ' + (s.error || 'failed')).join('; ')) : null,
        r.page && r.page.more ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { want = Math.min(1000, want + 200); load(); } }, 'Load more (' + (r.page.total - r.data.length) + ' more)') : null,
        panelActions(r, app));
    }
    clearTimeout(timer);
    timer = setTimeout(load, Math.max(r.refresh || 300, 30) * 1000);
  };
  const vis = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', vis);
  load();
  return () => { dead = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); if (frameCtl) frameCtl.stop(); };
}
function fmtSecs(s) { return s >= 3600 ? Math.round(s / 3600) + ' h' : s >= 60 ? Math.round(s / 60) + ' min' : s + ' s'; }

function panelActions(r, app) {
  const acts = (r.actions || []).filter(a => a.scope !== 'row');
  if (!acts.length) return null;
  return h('div', { class: 'row-8' }, acts.map(a => Button(a.label, { variant: 'secondary', size: 'sm', onClick: () => runAction(r, a, null, app) })));
}

/* ---------- formats ---------- */
export function fmt(v, f) {
  if (v == null || v === '') return '—';
  switch (f) {
    case 'number': return typeof v === 'number' ? v.toLocaleString() : String(v);
    case 'integer': return typeof v === 'number' ? Math.round(v).toLocaleString() : String(v);
    case 'percent': return typeof v === 'number' ? (Math.abs(v) <= 1 ? (v * 100).toFixed(0) : v.toFixed(0)) + '%' : String(v);
    case 'money': return typeof v === 'number' ? v.toLocaleString(undefined, { style: 'currency', currency: (window.capheos.company && window.capheos.company.currency) || 'USD' }) : String(v);
    case 'date': return dateFmt(v, { day: '2-digit', month: 'short' });
    case 'datetime': return dateFmt(v, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    case 'relative': return rel(v) || String(v);
    case 'duration': return typeof v === 'number' ? (v >= 3600 ? (v / 3600).toFixed(1) + ' h' : v >= 60 ? Math.round(v / 60) + ' min' : v + ' s') : String(v);
    case 'bool': return v ? 'Yes' : 'No';
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}
function dateFmt(v, o) {
  const ms = Date.parse(v); if (isNaN(ms)) return String(v);
  const tz = window.capheos.company && window.capheos.company.timezone;
  try { return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz || undefined }, o)).format(ms); } catch (_) { return new Date(ms).toLocaleString(); }
}

/* ---------- built-in kinds ---------- */
function srcData(r, name) { return r.data ? r.data[name] : undefined; }
function rowsOf(r, v) { const d = dig(srcData(r, v.source), v.rows || v.items); return Array.isArray(d) ? d : d == null ? [] : [d]; }

export function renderKind(v, r, onAction) {
  const rowActs = (r.actions || []).filter(a => a.scope === 'row');
  switch (v.kind) {
    case 'stat': return statEl(v, r);
    case 'stat-row': return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px' }, (v.items || []).map(i => statEl(i, r)));
    case 'table': case 'chart': {
      let rows = rowsOf(r, v);
      const cols = v.kind === 'chart' ? [v.x].concat(v.series || []) : (v.columns || []);
      if (v.sort && v.sort.key) rows = rows.slice().sort((a, b) => cmp(a[v.sort.key], b[v.sort.key]) * (v.sort.dir === 'desc' ? -1 : 1));
      rows = rows.slice(0, Math.min(v.limit || 200, 200));
      if (!rows.length) return h('p', { class: 'body-s muted' }, v.empty || 'Nothing to show.');
      const body = rows.map(row => h('tr', null,
        cols.map((c, i) => h('td', { class: (c.flag && row[c.flag] ? 'warn ' : '') + (i === 0 ? 'num strong' : ''), style: c.width === 'wide' ? 'min-width:260px' : c.width === 'narrow' ? 'white-space:nowrap' : '' }, fmt(row[c.key], c.format || (v.kind === 'chart' && i ? 'number' : null)))),
        rowActs.length ? h('td', { style: 'text-align:right;white-space:nowrap' }, rowActs.map(a => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => onAction(a, row) }, a.label))) : null));
      return h('div', { class: 'stack-6' },
        table(cols.map(c => c.label || c.key).concat(rowActs.length ? [''] : []), body, { minWidth: 560, bare: true }),
        v.kind === 'chart' ? h('span', { class: 'caption muted' }, 'Chart shown as a table for now.') : null);
    }
    case 'list': {
      const rows = rowsOf(r, v).slice(0, v.limit || 50);
      if (!rows.length) return h('p', { class: 'body-s muted' }, v.empty || 'Nothing to show.');
      return h('ul', { class: 'plain hair-top' }, rows.map(row => h('li', { class: 'between', style: 'padding:12px 0;border-bottom:1px solid var(--border-hairline)' },
        h('span', { class: 'stack-4' }, h('span', { class: 'label strong' }, fmt(dig(row, v.title))), v.subtitle ? h('span', { class: 'body-s muted' }, fmt(dig(row, v.subtitle))) : null),
        h('span', { class: 'row-8', style: 'align-items:center' }, v.badge && dig(row, v.badge) != null ? h('span', { class: 'tag tag-soft' }, fmt(dig(row, v.badge))) : null,
          rowActs.map(a => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => onAction(a, row) }, a.label))))));
    }
    case 'timeline': {
      const rows = rowsOf(r, v).slice().sort((a, b) => cmp(dig(b, v.at), dig(a, v.at))).slice(0, v.limit || 50);
      if (!rows.length) return h('p', { class: 'body-s muted' }, v.empty || 'Nothing yet.');
      return h('ol', { class: 'timeline' }, rows.map(row => h('li', null, h('span', { class: 'mono muted' }, fmt(dig(row, v.at), 'datetime')),
        h('span', { class: 'body-s' }, v.who ? h('strong', { class: 'strong', style: 'font-weight:600' }, fmt(dig(row, v.who)) + ' ') : null, fmt(dig(row, v.text))))));
    }
    case 'markdown': return markdown(String(srcData(r, v.source) || ''));
    default: return h('p', { class: 'body-s muted' }, 'This panel kind (' + (v.kind || '?') + ') is not drawn yet.');
  }
}
function statEl(i, r) {
  const val = dig(srcData(r, i.source), i.value);
  return h('div', { class: 'kpi' }, h('span', { class: 'big-num' }, fmt(val, i.format) + (i.unit ? ' ' + i.unit : '')), h('span', { class: 'caption muted' }, i.label || ''));
}
function cmp(a, b) { if (a == null) return 1; if (b == null) return -1; return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)); }

// sanitised markdown: text only, no HTML, no images, links as text (§4)
export function markdown(src) {
  const out = h('div', { class: 'md' }); let list = null;
  const inline = (s) => { const span = h('span'); const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g; let last = 0, m;
    while ((m = re.exec(s))) { if (m.index > last) span.appendChild(document.createTextNode(s.slice(last, m.index))); const t = m[0];
      if (t.startsWith('**')) span.appendChild(h('strong', null, t.slice(2, -2))); else if (t.startsWith('`')) span.appendChild(h('code', null, t.slice(1, -1)));
      else { const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(t); span.appendChild(document.createTextNode(mm[1] + ' (' + mm[2] + ')')); } last = re.lastIndex; }
    if (last < s.length) span.appendChild(document.createTextNode(s.slice(last))); return span; };
  for (const line of src.split('\n').slice(0, 400)) {
    const l = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const li = /^\s*([-*]|\d+\.)\s+(.*)/.exec(l);
    if (li) { if (!list) { list = h('ul'); out.appendChild(list); } list.appendChild(h('li', null, inline(li[2]))); continue; }
    list = null;
    const hd = /^(#{1,6})\s+(.*)/.exec(l);
    if (hd) out.appendChild(h(hd[1].length <= 2 ? 'h3' : 'h4', { class: 'label strong' }, inline(hd[2])));
    else if (l.trim()) out.appendChild(h('p', null, inline(l)));
  }
  return out;
}

/* ---------- actions: only declared ids, three doors, owner confirms (§7) ---------- */
function fillTemplate(t, r, row) {
  return String(t || '').replace(/\{\{\s*(panel\.title|row\.[A-Za-z0-9_.-]+)\s*\}\}/g, (_, k) => k === 'panel.title' ? r.title : String(dig(row || {}, k.slice(4)) ?? '')).slice(0, 2000);
}
async function runAction(r, a, row, app) {
  const decl = (r.actions || []).find(x => x.id === (a && a.id));
  if (!decl) { console.warn('panel action not declared', r.id, a); return; }
  const text = fillTemplate(decl.text, r, row);
  const where = decl.kind === 'handoff' ? 'a handoff to ' + decl.to : decl.kind === 'ask-ceo' ? 'a message to the CEO' : 'your Comms composer (nothing is sent yet)';
  if (!(await app.confirmDialog({ title: decl.label, body: 'This goes to ' + where + ':\n\n' + text, confirm: decl.kind === 'owner-question-draft' ? 'Open draft' : 'Send' }))) return;
  try {
    if (decl.kind === 'owner-question-draft') { location.hash = '#/comms/owner?draft=' + encodeURIComponent(text); return; }
    let to;
    if (decl.kind === 'handoff') {
      try { const c = await api('/crew'); const seat = (c.seats || []).find(s => s.id === decl.to || s.name === decl.to || (s.functions || []).includes(decl.to)); to = seat && seat.name; } catch (_) {}
    }
    await post('/owner/messages', to ? { text, to } : { text });
    app.toast('Sent.');
  } catch (e) { app.toast('Could not send: ' + e.message, true); }
}

/* ---------- custom view: sandboxed iframe (§6) ---------- */
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
function capTokens() {
  const cs = getComputedStyle(document.documentElement); const v = n => cs.getPropertyValue(n).trim();
  return {
    '--cap-bg': v('--bg-page'), '--cap-surface': v('--surface-card'), '--cap-surface-2': v('--bg-sunken'), '--cap-text': v('--text-strong'),
    '--cap-muted': v('--text-muted'), '--cap-border': v('--border-hairline'), '--cap-accent': v('--accent'), '--cap-accent-text': v('--text-on-accent'),
    '--cap-good': v('--status-online'), '--cap-warn': v('--status-warning'), '--cap-bad': v('--status-danger'),
    '--cap-font': v('--font-sans'), '--cap-mono': v('--font-mono'), '--cap-size-s': '13px', '--cap-size-m': '14px', '--cap-size-l': '20px',
    '--cap-radius': v('--radius-md'), '--cap-space-1': '4px', '--cap-space-2': '8px', '--cap-space-3': '12px', '--cap-space-4': '16px',
  };
}
function customFrame(host, meta, first, app) {
  let latest = first, frame = null;
  const clamp = n => Math.max(120, Math.min(1200, Number(n) || 320));
  const onMsg = ev => {
    if (!frame || ev.source !== frame.contentWindow) return;
    const m = ev.data || {};
    if (m.type === 'capheos:panel-ready') send(latest);
    else if (m.type === 'capheos:panel-resize') frame.style.height = clamp(m.height) + 'px';
    else if (m.type === 'capheos:panel-action') runAction(latest, { id: m.action }, m.row, app);
  };
  const send = r => {
    latest = r;
    if (!frame || !frame.contentWindow) return;
    const msg = { type: 'capheos:panel-data', version: 1, id: r.id, at: r.at, data: r.data, sources: r.sources };
    frame.contentWindow.postMessage(msg, '*');
  };
  window.addEventListener('message', onMsg);
  (async () => {
    let html;
    try {
      const res = await fetch('/api/panels/' + encodeURIComponent(meta.id) + '/view', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      html = await res.text();
      if (/^\s*\{/.test(html)) { try { const j = JSON.parse(html); html = j.html || j.text || ''; } catch (_) {} }
    } catch (e) { fill(host, errLine(e, 'Panel view')); return; }
    const toks = capTokens();
    const head = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '"><style>:root{' + Object.entries(toks).map(([k, v]) => k + ':' + v.replace(/[<>]/g, '')).join(';') + '}</style>';
    frame = h('iframe', { class: 'panel-frame', sandbox: 'allow-scripts', title: meta.title || meta.id, style: 'height:' + clamp(first.view && first.view.height) + 'px' });
    frame.srcdoc = head + html;
    frame.addEventListener('load', () => send(latest));
    fill(host, frame);
  })();
  return { send, stop: () => window.removeEventListener('message', onMsg) };
}
