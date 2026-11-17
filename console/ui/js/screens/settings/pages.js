// Settings › Console pages (#/settings/pages): the panels and pages the crew added to this console, with approve,
// reject, hide, unhide and remove (was Controls › Console panels and System's broken and hidden panels). A panel can
// never hide Needs you, the halt controls or Settings. API: GET /api/panels, POST /api/panels/:id/<op> (docs/CONSOLE-PANELS.md).
import { h, fill, Tag, errLine, empty, table, Details, Block, Setting, humanError } from '../../ui.js';
import { api, post } from '../../api.js';
import * as events from '../../events.js';

export function render(host, ctx) {
  const { app } = ctx;
  const body = h('div', { class: 'stack-14' });
  const theme = ({ light: 'Light', dark: 'Dark' })[document.documentElement.dataset.theme] || 'Follows your device';
  fill(host, Block({ id: 'panels', title: 'Panels and pages', lede: 'The crew may add panels that fit how this company works. They only read what they are allowed to, and act only by handing work over or asking you.' }, body),
    Block({ id: 'look', title: 'Look' },
      Setting({ id: 'set-theme', title: 'Theme', value: theme, what: 'Light or dark, for this browser.', flip: 'Change it in the page kit gallery, which also shows every building block a company page can use.',
        control: h('a', { href: '#/kit', class: 'btn btn-secondary btn-sm' }, 'Open the gallery') })));
  const op = async (p, o, okMsg) => {
    try { await post('/panels/' + encodeURIComponent(p.id) + '/' + o, {}); app.toast(okMsg); }
    catch (e) { app.toast('Not done: ' + humanError(e), true); }
    load();
  };
  async function load() {
    let d; try { d = await api('/panels'); } catch (e) { fill(body, errLine(e, 'Console pages')); return; }
    const rows = d.panels || [];
    const btn = (label, fn) => h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: fn }, label);
    const name = p => p.title || p.id;
    fill(body, rows.length ? table(['Panel', 'Where', 'Added by', 'State', ''], rows.map(p => {
      const state = p.status === 'proposed' ? ['Waiting for you', 'warning'] : p.valid === false ? ['Broken, not shown', 'danger'] : p.hidden ? ['Hidden', 'neutral'] : ['Showing', 'online'];
      return h('tr', null,
        h('th', { scope: 'row' }, h('span', { class: 'label strong', style: 'display:block' }, name(p)),
          p.valid === false ? Details('Why it is broken', h('p', { class: 'caption' }, (p.findings || 'Some') + ' problem(s) found when it was checked.'), h('p', { class: 'caption mono-s' }, 'console-panel.js validate ' + p.id)) : null),
        h('td', null, p.type === 'page' ? 'Its own page' + (p.nav ? ' (' + p.nav + ')' : '') : placeLabel(p)), h('td', null, p.owner || '—'),
        h('td', null, Tag(state[0], { variant: 'status', status: state[1] })),
        h('td', { style: 'white-space:nowrap' }, p.status === 'proposed'
          ? [btn('Approve', () => op(p, 'approve', name(p) + ' approved.')), btn('Reject', async () => { if (await app.confirmDialog({ title: 'Reject ' + name(p) + '?', body: 'It is not installed, and the crew member who proposed it is told.', confirm: 'Reject', danger: true })) op(p, 'reject', name(p) + ' rejected.'); })]
          : [p.hidden ? btn('Unhide', () => op(p, 'unhide', name(p) + ' is showing again.')) : btn('Hide', () => op(p, 'hide', name(p) + ' hidden.')),
             btn('Remove', async () => { if (await app.confirmDialog({ title: 'Remove ' + name(p) + '?', body: 'It is uninstalled from this console, and its owner is told. Hide it instead if you may want it back.', confirm: 'Remove', danger: true })) op(p, 'remove', name(p) + ' removed.'); })]));
    }), { minWidth: 680 }) : empty('No panels yet. When the crew adds one, it shows here first.'),
      rows.length ? h('p', { class: 'caption muted' }, 'Hide keeps a panel installed but out of sight. Remove uninstalls it.') : null);
  }
  load();
  const off = events.on('panels', load);
  return () => off();
}
function placeLabel(p) {
  const k = String(p.placement || '');
  const SCREEN = { comms: 'Chat', chat: 'Chat', usage: 'Spend', spend: 'Spend', hiring: 'Crew › Hiring', floor: 'Crew › Floor', automate: 'Settings › Tempo', abilities: 'Settings › Connections', crew: 'Crew', work: 'Work', today: 'Today' };
  if (k === 'today') return 'Today';
  if (k.startsWith('side:')) return 'Beside ' + (SCREEN[k.slice(5)] || k.slice(5));
  if (k === 'screen') return 'Its own page' + (p.nav ? ' (' + p.nav + ')' : '');
  return k || '—';
}
