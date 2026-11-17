// System (System.dc.html): halt band, company, health, panels needing attention (broken, hidden).
import { h, fill, Button, Tag, errLine, screenHead, NOT_CONNECTED } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-36';
  const groups = h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px' });
  const panels = h('div');
  const prov = h('div');
  const diag = {};
  fill(root,
    screenHead({ eyebrow: ['CaPheOS console', app.company && app.company.name], title: 'System.', actions: [Button('Copy diagnostics', { variant: 'secondary', onClick: async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(diag, null, 1)); app.toast('Diagnostics copied.'); } catch (e) { app.toast('Could not copy: ' + e.message, true); }
    } })] }),
    h('section', { 'aria-labelledby': 'halt', class: 'inverse between', style: 'align-items:center;gap:20px;padding:24px 28px' },
      h('div', { class: 'stack-6', style: 'max-width:640px' }, h('h2', { id: 'halt', class: 'h4' }, 'Stop the company'),
        h('p', { class: 'body-s', style: 'color:var(--text-on-inverse-muted)' }, "Soft halt starts nothing new and lets running work finish through each seat's shutdown procedure. Hard halt cuts every run off now.")),
      h('div', { class: 'row-8' }, Button('Soft halt', { variant: 'inverse', href: '#/halt?mode=soft' }), h('a', { href: '#/halt?mode=hard', class: 'btn btn-danger btn-md' }, 'Hard halt'))),
    prov, groups, panels);

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
      card('Setup', [r('Guided setup', 'company, AI, budget, charter, checks', '#/setup')]),
      card('You', [r('About you, aims, preferences', NOT_CONNECTED)]),
      card('Spending limits', [r('Pacer and caps', 'see Usage', '#/usage')]),
      card('App and backup', [r('Export, recovery, updates', NOT_CONNECTED)]),
      card('Look, sound and alerts', [r('Theme', ({ light: 'Light', dark: 'Dark' })[document.documentElement.dataset.theme] || 'Follows your device', '#/kit'), r('Page kit gallery', 'every unit a company page can use', '#/kit'), r('Notifications, voice, remote', NOT_CONNECTED)]));
    // Provisioning / certification (company/tools/onboard.js): per step status and what is missing
    try {
      const d = await api('/onboarding');
      const tag = st => Tag(st === 'ok' ? 'OK' : st === 'failed' ? 'Failed' : st === 'unchecked' ? 'Unchecked' : 'Pending', { variant: 'status', status: st === 'ok' ? 'online' : st === 'failed' ? 'danger' : 'warning' });
      const row = (label, st, note) => h('li', { class: 'sys-row', style: 'align-items:flex-start' }, h('span', { class: 'stack-4' }, h('span', { class: 'strong' }, label), note ? h('span', { class: 'body-s muted' }, note) : null), tag(st));
      const err = h('p', { class: 'err-line', role: 'status' });
      fill(prov, h('section', { class: 'stack-14' },
        h('div', { class: 'between-c' }, h('h2', { class: 'h3' }, 'Provisioning ' + (d.certified ? '· certified' : '· not certified')),
          Button('Run certification', { variant: 'secondary', onClick: async () => { err.textContent = ''; try { const r = await post('/onboarding/certify'); app.toast(r.certified ? 'Certified.' : 'Not certified yet.'); load(); } catch (e) { err.textContent = e.message; } } })),
        h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px' },
          h('article', { class: 'card p22', style: 'gap:8px' }, h('h3', { class: 'h4' }, 'Provisioned (steps)'), h('ul', { class: 'plain' }, (d.steps || []).map(s => row(s.what, s.status, s.note)))),
          h('article', { class: 'card p22', style: 'gap:8px' }, h('h3', { class: 'h4' }, 'Certified (checks)' + (d.lastCertify ? ' · ' + new Date(d.lastCertify).toLocaleString() : '')), h('ul', { class: 'plain' }, (d.checks || []).map(c => row(c.what, c.status, c.missing))))),
        h('p', { class: 'caption muted' }, 'node company/tools/onboard.js --check | --resume | --certify'), err));
    } catch (e) { fill(prov, errLine(e, 'Provisioning')); }
    // §11: broken panels with findings; unhide list
    try {
      const d = await api('/panels');
      const broken = (d.panels || []).filter(p => !p.valid), hidden = (d.panels || []).filter(p => p.hidden);
      fill(panels, h('section', { class: 'stack-14' }, h('div', { class: 'between-c' }, h('h2', { class: 'h3' }, 'Console panels and pages'), h('a', { href: '#/kit', class: 'btn btn-ghost btn-sm' }, 'Page kit gallery')),
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
