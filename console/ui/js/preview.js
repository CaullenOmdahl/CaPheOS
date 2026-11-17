// Page preview (docs/CONSOLE-PANELS.md §12): /preview/<id>[?dir=company/work/...][&theme=dark]. Draws a page or a
// panel exactly as its company screen would, from GET /api/preview/<id>, before (or after) `console-panel.js add`.
// Served by the console behind the owner token, and by `console-panel.js render --page <dir> --png` on a private port.
// Actions are shown but never sent: a preview opens no door.
import { h, fill, screenHead, errLine } from './ui.js';
import { api } from './api.js';
import { renderPageGrid, renderKind } from './panels.js';

const q = new URLSearchParams(location.search);
const theme = q.get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
const id = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const main = document.getElementById('content');
window.capheos = { company: null };
const note = h('p', { class: 'caption muted', role: 'status', 'aria-live': 'polite' });
const onAction = (a, row, extra) => { note.textContent = 'Preview: "' + a.label + '" would open ' + (a.kind === 'handoff' ? 'a handoff to ' + a.to : a.kind === 'ask-ceo' ? 'a message to the CEO' : 'a draft in Comms') + (extra && extra.move ? ' (move from ' + extra.move.from + ' to ' + extra.move.to + ')' : '') + '. Nothing was sent.'; };

(async () => {
  try { window.capheos.company = await api('/company'); } catch (_) {}
  let r;
  try { r = await api('/preview/' + encodeURIComponent(id) + (q.get('dir') ? '?dir=' + encodeURIComponent(q.get('dir')) : '')); }
  catch (e) { fill(main, screenHead({ title: 'Preview.' }), errLine(e, 'Preview')); document.body.dataset.ready = 'error'; return; }
  const findings = r.findings || [];
  const head = screenHead({ eyebrow: ['Preview', r.kind === 'page' ? 'page' : 'panel', 'owner ' + (r.owner || '?')], title: ((r.placement && r.placement.nav) || r.title || id) + '.', lede: r.description || null });
  const warn = findings.length ? h('div', { class: 'alertbox', role: 'alert' }, h('div', { class: 'stack-6' }, h('strong', null, findings.length + ' finding(s): fix them before add'), h('ul', null, findings.slice(0, 12).map(f => h('li', { class: 'mono-s' }, f))))) : null;
  if (!r.view && !r.units) { fill(main, head, warn || errLine(new Error(r.error || 'render failed'), 'Preview')); document.body.dataset.ready = 'error'; return; }
  const body = r.kind === 'page' ? renderPageGrid(r, onAction) : h('section', { class: 'card' }, h('h2', { class: 'h4' }, r.title), renderKind(r.view || {}, r, onAction));
  fill(main, head, warn, note, body);
  document.body.dataset.ready = findings.length ? 'findings' : 'ok';
})();
