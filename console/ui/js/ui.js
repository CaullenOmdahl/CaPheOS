// Small DOM helpers and the design-system stand-ins (Button, Tag, Eyebrow, Logo).
// Everything is built with textContent, so data never becomes markup.

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'style') el.setAttribute('style', v);
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function fill(el, ...kids) { clear(el); add(el, kids); return el; }

// ---- tokens-styled components ----
export function Button(label, opts = {}) {
  const v = opts.variant || 'secondary', s = opts.size || 'md';
  const cls = 'btn btn-' + v + ' btn-' + s + (opts.class ? ' ' + opts.class : '');
  if (opts.href) return h('a', { class: cls, href: opts.href, 'aria-label': opts.aria }, label);
  return h('button', { type: opts.type || 'button', class: cls, onclick: opts.onClick, disabled: opts.disabled, 'aria-label': opts.aria }, label);
}
export function Tag(label, opts = {}) {
  const v = opts.variant || 'soft';
  const t = h('span', { class: 'tag tag-' + v + (v === 'status' ? ' st-' + (opts.status || 'neutral') : '') });
  if (v === 'status') t.appendChild(h('span', { class: 'tag-dot', 'aria-hidden': 'true' }));
  t.appendChild(document.createTextNode(label == null ? '' : String(label)));
  return t;
}
export function Eyebrow(items) {
  return h('p', { class: 'eyebrow' }, (items || []).filter(Boolean).join(' / '));
}
export function Logo(size = 28) {
  return h('span', { class: 'logo-mark', 'aria-hidden': 'true', style: `width:${Math.round(size * 220 / 310)}px;height:${size}px` });
}

// ---- states ----
// Errors in plain words. The raw message (a tool's output, an HTTP status, a route) goes behind a "Details" disclosure.
const TECH = /(company\/|\.js\b|\.jsonl?\b|\.md\b|\/api\/|https?:|ENOENT|EACCES|ECONN|\bHTTP\b|\b[45]\d\d\b|no such API route|Unknown path|stack|at \w+ \()/;
export function humanError(e) {
  const m = String(e && e.message || e || '');
  if (e && e.auth) return 'You are not signed in. Open the login link the console printed when it started.';
  if (e && e.stationDown) return 'The station is not running. Start it, then try again.';
  if (/no such API route|Unknown path|not found/i.test(m) || (e && e.status === 404)) return 'The station does not support this yet.';
  if (e && (e.status === 504 || /timed? ?out/i.test(m))) return 'That took too long. Try again in a minute.';
  if (/Console server not reachable/.test(m)) return 'The console server is not answering. Check that it is running.';
  if (e && e.status === 403) return 'Not allowed from here.' + (TECH.test(m) ? '' : ' ' + m);
  if (!m || TECH.test(m) || m.length > 160) return 'Something went wrong. Try again; if it keeps happening, the details below help.';
  return m.replace(/^\w/, c => c.toUpperCase()).replace(/([^.!?])$/, '$1.');
}
export function Details(summary, ...kids) {
  return h('details', { class: 'tech' }, h('summary', { class: 'caption muted' }, summary || 'Details'), h('div', { class: 'tech-body stack-6' }, kids));
}
export function errLine(e, what) {
  const human = humanError(e), raw = String(e && e.message || e || '');
  return h('div', { class: 'err-block stack-4', role: 'status' }, h('p', { class: 'err-line' }, (what ? what + ': ' : '') + human),
    raw && raw !== human && !(e && e.stationDown) ? Details('Details', h('code', { class: 'mono-s' }, raw)) : null);
}
// A setting: its name, current value, a sentence on what it does, what changes if you flip it, and the control.
export function Setting({ id, title, value, valueTone, what, flip, control, extra }) {
  return h('div', { class: 'setting', id: id || null },
    h('div', { class: 'setting-text stack-4' },
      h('div', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'label strong' }, title),
        value != null && value !== '' ? Tag(String(value), { variant: 'status', status: valueTone || 'neutral' }) : null),
      what ? h('p', { class: 'body-s muted' }, what) : null,
      flip ? h('p', { class: 'caption' }, flip) : null,
      extra || null),
    control ? h('div', { class: 'setting-control' }, control) : null);
}
// A titled block inside a screen or a Settings section.
export function Block({ id, title, lede, actions }, ...kids) {
  return h('section', { class: 'stack-14 block', id: id ? 'set-' + id : null, 'aria-labelledby': id ? 'h-' + id : null },
    h('div', { class: 'between-c', style: 'flex-wrap:wrap' }, h('h2', { class: 'h3', id: id ? 'h-' + id : null }, title), actions || null),
    lede ? h('p', { class: 'body-s muted', style: 'max-width:720px' }, lede) : null, kids);
}
export function empty(text, opts = {}) {
  return h('div', { class: 'empty' + (opts.solid ? ' empty-solid' : '') }, opts.title ? h('h3', { class: 'h4' }, opts.title) : null, h('p', null, text));
}
export const NOT_CONNECTED = 'Not available on this station yet.';
export function loading() { return h('p', { class: 'muted caption', 'aria-busy': 'true' }, 'Loading…'); }

export function tabs(defs, current, pick, label) {
  return h('div', { role: 'tablist', 'aria-label': label, class: 'tabs' },
    defs.map(([id, text, n]) => h('button', { type: 'button', role: 'tab', 'aria-selected': id === current ? 'true' : 'false', class: 'tab', onclick: () => pick(id) },
      text, n != null && n !== '' ? h('span', { class: 'tab-n' }, ' ' + n) : null)));
}

export function screenHead({ eyebrow, title, lede, ledeClass, actions, max }) {
  return h('header', { class: 'screen-head' },
    h('div', { class: 'stack-12', style: max ? 'max-width:' + max : '' },
      eyebrow ? Eyebrow(eyebrow) : null,
      h('h1', { class: 'h1' }, title),
      lede ? h('p', { class: ledeClass || 'body-l muted' }, lede) : null),
    actions && actions.length ? h('div', { class: 'row-8' }, actions) : null);
}

export function table(cols, rows, opts = {}) {
  return h('div', { class: 'table-wrap' + (opts.bare ? ' bare' : '') },
    h('table', { class: 'tbl', style: 'min-width:' + (opts.minWidth || 760) + 'px' },
      cols ? h('thead', null, h('tr', null, cols.map(c => h('th', { scope: 'col' }, c)))) : null,
      h('tbody', null, rows)));
}

export function statusOf(s) {
  s = String(s || '').toLowerCase();
  if (/(work|run|busy|online|ok|live|armed|in.?scope|active|settled|done|pass|healthy|open$)/.test(s)) return 'online';
  if (/(block|wait|warn|finish|shut|propos|moved|near|degrad|overdue|stale|pending)/.test(s)) return 'warning';
  if (/(error|fail|down|danger|dead|broken|off.?line|crash)/.test(s)) return 'danger';
  return 'neutral';
}

// ---- formatting ----
export function initial(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
export function rel(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!ms || isNaN(ms)) return '';
  const d = Date.now() - ms, a = Math.abs(d), m = Math.round(a / 60000);
  const s = m < 1 ? 'just now' : m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d';
  return m < 1 ? s : d >= 0 ? s + ' ago' : 'in ' + s;
}
export function hhmm(t, tz) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  if (!ms || isNaN(ms)) return '';
  try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }).format(ms); }
  catch (_) { return new Date(ms).toTimeString().slice(0, 5); }
}
export function asArray(d, ...keys) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of keys) if (Array.isArray(d[k])) return d[k];
  for (const k of keys) if (d[k] && typeof d[k] === 'object') return Object.entries(d[k]).map(([id, v]) => Object.assign({ id }, v));
  return [];
}
export function dig(o, p) {
  if (!p) return o;
  for (const k of String(p).split('.')) { if (o == null) return undefined; o = k === 'length' && Array.isArray(o) ? o.length : o[k]; }
  return o;
}

// onboarding questions (filed by company/tools/onboard.js, about 'onboarding') are answered in Setup, never as Approve/Decline
export function isSetupQuestion(q) { return !!q && (q.from === 'onboard.js' || /^onboarding\b/i.test(String(q.about || ''))); }
