// A company screen (docs/CONSOLE-PANELS.md §3, §12), listed under the Company nav group: either one panel with
// placement {area:'screen'}, or a page (page.json) of units on a 12-column grid.
import { h, fill, errLine, empty, screenHead } from '../ui.js';
import { api } from '../api.js';
import { mountPanel, mountPage } from '../panels.js';

export async function render(root, ctx) {
  root.className = 'main gap-32';
  const id = ctx.rest[0];
  let meta;
  try { meta = ((await api('/panels')).panels || []).find(p => p.id === id && p.status === 'installed' && !p.hidden && p.valid !== false && p.placement === 'screen'); }
  catch (e) { fill(root, errLine(e, 'Panels')); return; }
  if (!meta) { fill(root, screenHead({ title: 'Not found.' }), empty('No company screen "' + id + '". It may be hidden, broken or removed (see Settings › Console pages).')); return; }
  const head = screenHead({ eyebrow: ['Company ' + (meta.type === 'page' ? 'page' : 'screen'), 'added by ' + (meta.owner || '?')], title: (meta.nav || meta.title || id) + '.', lede: meta.type === 'page' ? meta.description : null });
  if (meta.type === 'page') return mountPage(root, meta, ctx.app, head);
  const host = h('div');
  fill(root, head, host);
  return mountPanel(host, meta, ctx.app);
}
