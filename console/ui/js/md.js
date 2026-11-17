// Safe markdown for agent-written text (live chat, owner-channel replies, questions, handoffs, the charter).
// Built from DOM nodes with textContent only: no string ever becomes markup. Links: `console:#/…` and `#/…` become
// in-app links; http(s) opens in a new tab with rel="noopener noreferrer"; any other scheme (javascript:, data:, …)
// is dropped and only its text is kept. An old route (#/comms, #/controls/guard, …) is rewritten to its new home
// (routes.js redirect), so the link the owner hovers is the place it opens. Covers what agents write: paragraphs, line breaks, # headings, - and 1. lists,
// > quotes, ``` code blocks, `code`, **bold**, *em*, [text](url), bare URLs and tables (shown as code blocks).
// A ```actions fence (docs/CHAT-ACTIONS.md) goes, validated, to opts.actions(block) where the page can answer it (live chat,
// the owner channel); elsewhere it shows read-only. A malformed one is plain text with a note, never broken controls.
import { h } from './ui.js';
import { redirect } from './routes.js';
import { parseActions } from './actions-schema.js';

export function safeHref(url) {
  const u = String(url || '').trim();
  if (/^console:?#\//i.test(u)) return inApp(u.replace(/^console:?/i, ''));   // agents also write console#/… (no colon)
  if (/^#\//.test(u)) return inApp(u);
  if (/^https?:\/\/[^\s<>"]+$/i.test(u)) return { href: u, inApp: false };
  return null;
}
function inApp(href) { return { href: redirect(href) || href, inApp: true }; }
function link(text, url) {
  const s = safeHref(url);
  if (!s) return document.createTextNode(text);
  return s.inApp ? h('a', { href: s.href, class: 'md-link' }, text) : h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer', class: 'md-link' }, text);
}

// inline: code spans first, then links, then bold / em, then bare URLs and bare console links
function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`)|\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(https?:\/\/[^\s<>()"]+[^\s<>()".,;:!?'])|(console:?#\/[^\s<>()"]*[^\s<>()".,;:!?'])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) out.push(h('code', { class: 'md-code' }, m[1].slice(1, -1)));
    else if (m[2] !== undefined) out.push(link(m[2], m[3]));
    else if (m[4]) out.push(h('strong', null, inline(m[4].slice(2, -2))));
    else if (m[5]) out.push(h('em', null, inline(m[5].slice(1, -1))));
    else if (m[6]) out.push(link(m[6], m[6]));
    else if (m[7]) out.push(link(m[7].replace(/^console:?/, ''), m[7]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}
function withBreaks(lines) { const out = []; lines.forEach((l, i) => { if (i) out.push(h('br')); out.push(...inline(l)); }); return out; }

// markdown -> a DocumentFragment-like array of nodes
export function md(src, opts) {
  const lines = String(src == null ? '' : src).replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```\s*actions\s*$/i.test(l)) {
      const buf = []; i++; while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      const closed = i < lines.length; i++;
      out.push(actionsNode(buf.join('\n'), closed, opts)); continue;
    }
    const fence = /^\s*```/.exec(l);
    if (fence) { const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(h('pre', { class: 'md-pre' }, h('code', null, buf.join('\n')))); continue; }
    const hd = /^(#{1,4})\s+(.*)$/.exec(l);
    if (hd) { out.push(h('h' + Math.min(6, hd[1].length + 2), { class: 'md-h md-h' + hd[1].length }, inline(hd[2]))); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) { const buf = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]); out.push(table(buf)); continue; }
    if (/^\s*>\s?/.test(l)) { const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); out.push(h('blockquote', { class: 'md-quote' }, withBreaks(buf))); continue; }
    const ul = /^\s*[-*+]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(l) || ol.test(l)) {
      const ordered = ol.test(l) && !ul.test(l); const re = ordered ? ol : ul; const items = [];
      while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (re.test(lines[i])) items.push([lines[i].replace(re, '')]); else items[items.length - 1].push(lines[i].trim());
        i++;
      }
      out.push(h(ordered ? 'ol' : 'ul', { class: 'md-list' }, items.map(x => h('li', null, withBreaks(x)))));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(h('p', { class: 'md-p' }, withBreaks(buf)));
  }
  return out;
}
function table(rows) {
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const body = rows.filter(r => !/^[\s|:-]+$/.test(r));
  const [head, ...rest] = body;
  return h('div', { class: 'table-wrap md-table' }, h('table', { class: 'tbl' },
    head ? h('thead', null, h('tr', null, cells(head).map(c => h('th', { scope: 'col' }, inline(c))))) : null,
    h('tbody', null, rest.map(r => h('tr', null, cells(r).map(c => h('td', null, inline(c))))))));
}
// one block element holding the rendered markdown
export function mdBlock(src, cls, opts) { return h('div', { class: 'md' + (cls ? ' ' + cls : '') }, md(src, opts)); }

// an actions block: still streaming -> a placeholder; malformed -> its text and a note; a page that answers it ->
// opts.actions; anywhere else -> read-only (its prompt, its choices as plain words, links that still work)
function actionsNode(raw, closed, opts) {
  if (!closed) return h('p', { class: 'caption muted chat-actions-pending' }, 'Preparing buttons…');
  const p = parseActions(raw);
  if (!p.ok) return h('div', { class: 'chat-actions-bad' }, h('pre', { class: 'md-pre' }, h('code', null, raw)), h('p', { class: 'caption muted', role: 'note' }, 'Couldn\'t show these buttons (' + p.error + ').'));
  if (opts && opts.actions) return opts.actions(p.block);
  const b = p.block;
  return h('div', { class: 'chat-actions readonly', 'data-actions-id': b.id }, b.prompt ? h('p', { class: 'md-p' }, inline(b.prompt)) : null,
    h('ul', { class: 'md-list' }, b.items.map(it => h('li', null, it.type === 'link' ? link(it.label, it.href) : it.type === 'approval' ? 'Approval ' + it.ref + ' (on Today › Needs you)' : it.label + (it.options ? ': ' + it.options.map(o => o.label).join(' / ') : '')))),
    h('p', { class: 'caption muted' }, 'Answer these in a live chat or the owner channel.'));
}
