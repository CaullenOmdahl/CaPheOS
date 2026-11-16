// A company screen: one panel with placement {area:'screen'} (docs/CONSOLE-PANELS.md §3), listed under the Company nav group.
import { h, fill, errLine, empty, screenHead } from '../ui.js';
import { api } from '../api.js';
import { mountPanel } from '../panels.js';

export async function render(root, ctx) {
  root.className = 'main gap-32';
  const id = ctx.rest[0];
  let meta;
  try { meta = ((await api('/panels')).panels || []).find(p => p.id === id && p.status === 'installed' && !p.hidden && p.valid !== false && p.placement === 'screen'); }
  catch (e) { fill(root, errLine(e, 'Panels')); return; }
  if (!meta) { fill(root, screenHead({ title: 'Not found.' }), empty('No company screen "' + id + '". It may be hidden, broken or removed (see System).')); return; }
  const host = h('div');
  fill(root, screenHead({ eyebrow: ['Company screen', 'added by ' + (meta.owner || '?')], title: (meta.nav || meta.title || id) + '.' }), host);
  return mountPanel(host, meta, ctx.app);
}
