// Settings › Security (#/settings/security): the security watch (company/tools/security-watch.js) in plain words. What it
// is, when it last checked, each known hole in a part the company uses and who is on it; every id, version and package name
// only inside "Technical details". Check now asks the next dispatcher tick to check (POST /api/security/check).
import { h, fill, Button, Tag, errLine, empty, Details, Block, humanError, rel } from '../../ui.js';
import { api, post } from '../../api.js';

export function render(host, ctx) {
  const { app } = ctx;
  const status = h('div', { class: 'stack-14' }), list = h('div', { class: 'stack-14' }), more = h('div', { class: 'stack-8' });
  fill(host,
    Block({ id: 'watch', title: 'Security watch', lede: 'Known security holes in the parts the company uses, and who is fixing them.' }, status),
    Block({ id: 'holes', title: 'Known holes' }, list),
    Block({ id: 'covered', title: 'What is checked' }, more));
  async function load() {
    let d; try { d = await api('/security'); } catch (e) { fill(status, errLine(e, 'Security watch')); fill(list); fill(more); return; }
    const tone = !d.checkedAt || d.stale ? 'warning' : d.rows.some(r => r.tone === 'danger') ? 'danger' : d.rows.some(r => r.tone === 'warning') ? 'warning' : 'online';
    const word = !d.checkedAt ? 'Not checked yet' : d.stale ? 'Check overdue' : tone === 'online' ? 'All clear' : 'Being fixed';
    const check = Button(d.checkNowPending ? 'Check requested' : 'Check now', { variant: 'secondary', size: 'sm', disabled: !!d.checkNowPending, onClick: async () => {
      try { await post('/security/check', {}); app.toast('The next check starts within a few minutes.'); load(); } catch (e) { app.toast('Not done: ' + humanError(e), true); }
    } });
    fill(status,
      h('div', { class: 'sys-row', style: 'align-items:center' }, h('span', { class: 'body-l strong' }, d.headline), Tag(word, { variant: 'status', status: tone })),
      h('p', { class: 'body-s', style: 'max-width:720px' }, d.explain),
      h('p', { class: 'caption muted' }, d.checkedAt ? 'Last checked ' + rel(d.checkedAt) + (d.offline ? '. The last try could not reach the public list of warnings, so these are the last known results.' : '.') : 'The first check runs within a few minutes of the company starting.'),
      check);
    const rows = d.rows;
    fill(list, rows.length ? rows.map(r => h('article', { class: 'card p22', style: 'gap:8px' + (r.tone === 'danger' ? ';border-color:var(--status-danger)' : '') },
      h('div', { class: 'sys-row', style: 'align-items:center' }, h('h3', { class: 'h4' }, cap(r.part)), Tag(r.state === 'fixed' ? 'Fixed' : r.level === 'P0' ? 'Fixing now' : r.level === 'P1' ? 'Workaround' : 'Small', { variant: 'status', status: r.tone })),
      h('p', { class: 'body-s' }, r.how + ' ' + r.status + '.'),
      Details('Technical details (for the crew)', h('dl', { class: 'kv' },
        kv('Advisory', [r.technical.advisory].concat(r.technical.ids.filter(x => x !== r.technical.advisory)).join(', ')),
        kv('Package', r.technical.package + ' ' + r.technical.versions.join(', ')), kv('Fixed in', r.technical.fixed || 'no fixed release yet'),
        kv('Severity', r.technical.severity + (r.technical.kev ? ', exploited in the wild' : '')), kv('Where', r.technical.where.join('; ') || '—'),
        r.technical.mitigation ? kv('Workaround', r.technical.mitigation) : null, r.technical.issue ? kv('Framework issue', r.technical.issue) : null,
        kv('Finding', r.id))))) : empty(d.checkedAt ? 'Nothing to fix. The company keeps checking every ' + d.everyHours + ' hours.' : 'No results yet.'));
    fill(more, h('p', { class: 'body-s' }, (d.parts || 0) + ' parts are checked: the program the crew works in, the company\'s own software, the tools the crew added, the company\'s projects, and the browser and engine on this machine.'),
      d.unmatched.length ? Details('Not covered by the public warnings (for the crew)', h('ul', { class: 'plain' }, d.unmatched.map(u => h('li', { class: 'caption' }, u)))) : null);
  }
  load();
  const t = setInterval(load, 60000);
  return () => clearInterval(t);
}
const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const kv = (k, v) => [h('dt', null, k), h('dd', { class: 'mono-s' }, v)];
