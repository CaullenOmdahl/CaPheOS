// System (System.dc.html): halt band, company, health, panels needing attention (broken, hidden).
import { h, fill, Button, errLine, screenHead, NOT_CONNECTED } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-36';
  const groups = h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' });
  const panels = h('div');
  const diag = {};
  fill(root,
    screenHead({ eyebrow: ['CaPheOS console', app.company && app.company.name], title: 'System.', actions: [Button('Copy diagnostics', { variant: 'secondary', onClick: async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 1)); app.toast('Diagnostics copied.'); } catch (e) { app.toast('Could not copy: ' + e.message, true); }
    } })] }),
    h('section', { 'aria-labelledby': 'halt', class: 'inverse between', style: 'align-items:center;gap:20px;padding:24px 28px' },
      h('div', { class: 'stack-6', style: 'max-width:640px' }, h('h2', { id: 'halt', class: 'h4' }, 'Stop the company'),
        h('p', { class: 'body-s', style: 'color:var(--text-on-inverse-muted)' }, "Soft halt starts nothing new and lets running work finish through each seat's shutdown procedure. Hard halt cuts every run off now.")),
      h('div', { class: 'row-8' }, Button('Soft halt', { variant: 'inverse', href: '#/halt?mode=soft' }), h('a', { href: '#/halt?mode=hard', class: 'btn btn-danger btn-md' }, 'Hard halt'))),
    groups, panels);

  async function load() {
    const co = app.company || {};
    const [health, halt, disp, gr] = await Promise.allSettled([fetch('/api/station/health', { credentials: 'same-origin' }).then(async r => ({ ok: r.ok, text: (await r.text()).slice(0, 80) })),
      api('/halt'), api('/dispatch'), api('/guardrails')]);
    Object.assign(diag, { at: new Date().toISOString(), company: co, health: health.value || String(health.reason), halt: halt.value || String(halt.reason), guardrails: gr.value ? { off: gr.value.off, sandbox: gr.value.sandbox } : String(gr.reason) });
    const r = (a, b, href) => h('li', { class: 'sys-row' }, href ? h('a', { href, class: 'strong' }, a) : h('span', { class: 'strong' }, a), h('span', { class: 'mono muted', style: 'text-align:right' }, b));
    const card = (t, rows) => h('article', { class: 'card p22', style: 'gap:12px' }, h('h2', { class: 'h4' }, t), h('ul', { class: 'plain' }, rows));
    const owner = co.owner && (co.owner.name || co.owner) || '—';
    fill(groups,
      card('Company', [r('Name', co.name || '—'), r('Owner', String(owner)), r('Timezone', co.timezone || '—'), r('Station', co.station && co.station.url || '—'),
        r('Owner channel', typeof co.ownerChannel === 'object' ? (co.ownerChannel && (co.ownerChannel.adapter || co.ownerChannel.type)) || 'set' : co.ownerChannel || '—')]),
      card('Health', [r('Station API', health.value ? (health.value.ok ? 'ok' : 'down: ' + health.value.text) : 'not running'),
        r('Halt', halt.value ? halt.value.mode : 'unknown', '#/halt'),
        r('Dispatcher log', disp.value ? (disp.value.log || []).length + ' recent lines' : 'unreadable', '#/automate'),
        r('Guardrails off', gr.value ? String((gr.value.off || []).length) : '?', '#/controls/guard'),
        r('Live updates', document.querySelector('.live-dot.off') ? 'polling' : 'SSE')]),
      card('You', [r('About you, aims, preferences', NOT_CONNECTED)]),
      card('Spending limits', [r('Pacer and caps', 'see Usage', '#/usage')]),
      card('App and backup', [r('Export, recovery, updates', NOT_CONNECTED)]),
      card('Look, sound and alerts', [r('Theme', 'Light'), r('Notifications, voice, remote', NOT_CONNECTED)]));
    // §11: broken panels with findings; unhide list
    try {
      const d = await api('/panels');
      const broken = (d.panels || []).filter(p => !p.valid), hidden = (d.panels || []).filter(p => p.hidden);
      fill(panels, h('section', { class: 'stack-14' }, h('h2', { class: 'h3' }, 'Console panels'),
        !broken.length && !hidden.length ? h('p', { class: 'body-s muted' }, 'No broken or hidden panels.') : null,
        broken.length ? h('div', { class: 'card', style: 'border-color:var(--status-danger)' }, h('h3', { class: 'h4' }, 'Broken (not shown)'),
          h('ul', { class: 'plain' }, broken.map(p => r(p.title || p.id, p.findings + ' findings · run console-panel.js validate ' + p.id)))) : null,
        hidden.length ? h('div', { class: 'card' }, h('h3', { class: 'h4' }, 'Hidden'),
          h('ul', { class: 'plain' }, hidden.map(p => h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, p.title || p.id),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => { try { await post('/panels/' + encodeURIComponent(p.id) + '/unhide'); app.toast('Unhidden.'); load(); } catch (e) { app.toast(e.message, true); } } }, 'Unhide'))))) : null));
    } catch (e) { fill(panels, errLine(e, 'Panels')); }
  }
  load();
  const off = events.on(['panels', 'halt', 'guardrails'], load);
  return () => off();
}
