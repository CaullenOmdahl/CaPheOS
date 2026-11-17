// Settings (#/settings/<section>[/<anchor>]): one screen, a section list on the left (tabs on a phone), one section at
// a time on the right. Every setting the owner can change lives here; the five working screens only show and act.
// Sections are modules under screens/settings/ that export render(host, ctx) and return a cleanup.
import { h, fill } from '../ui.js';
import { SETTINGS_SECTIONS } from '../routes.js';

const MODULES = {
  company: () => import('./settings/company.js'),
  autonomy: () => import('./settings/autonomy.js'),
  tempo: () => import('./settings/tempo.js'),
  models: () => import('./settings/models.js'),
  connections: () => import('./settings/connections.js'),
  pages: () => import('./settings/pages.js'),
  system: () => import('./settings/system.js'),
};
const LEDE = {
  company: 'Who the company is, what it is for, and whether it is ready to run.',
  autonomy: 'How much the crew decides alone, and the hard stops it can never get past.',
  tempo: 'How often the crew wakes, and the routines that run on a clock.',
  models: 'Which AI each crew member runs on, how much of each subscription routines may use, and the pay-per-token cap.',
  connections: 'What the crew can reach: connected services, skills, channels and keys.',
  pages: 'Panels and pages the crew added to this console. Hide or remove any of them.',
  system: 'Health, certification, backups, background services, sign-in and access, flags, modules, restarts, framework updates, and how to stop the company.',
};

export async function render(root, ctx) {
  root.className = 'main gap-32';
  const id = MODULES[ctx.rest[0]] ? ctx.rest[0] : 'company';
  const anchor = ctx.rest[1] || null;
  const label = SETTINGS_SECTIONS.find(s => s[0] === id)[1];
  const host = h('div', { class: 'stack-36 settings-body', id: 'settings-' + id });
  fill(root,
    h('header', { class: 'stack-8' }, h('h1', { class: 'h1' }, 'Settings.')),
    h('div', { class: 'settings' },
      h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
        SETTINGS_SECTIONS.map(([sid, text]) => h('a', { href: '#/settings/' + sid, class: 'settings-link', 'aria-current': sid === id ? 'page' : 'false' }, text))),
      h('section', { class: 'settings-main stack-24', 'aria-labelledby': 'settings-h' },
        h('div', { class: 'stack-6' }, h('h2', { id: 'settings-h', class: 'h2' }, label), h('p', { class: 'body-l muted', style: 'max-width:720px' }, LEDE[id])),
        host)));
  const mod = await MODULES[id]();
  const cleanup = await mod.render(host, Object.assign({}, ctx, { rest: anchor ? [anchor].concat(ctx.rest.slice(2)) : [], anchor }));
  if (anchor) focusAnchor(host, anchor);
  return typeof cleanup === 'function' ? cleanup : undefined;
}

// open and scroll to #set-<anchor> once the section has drawn it (sections load their data after render returns)
export function focusAnchor(host, anchor) {
  let tries = 0;
  const go = () => {
    const el = host.querySelector('#set-' + CSS.escape(anchor)) || host.querySelector('#step-' + CSS.escape(anchor));
    if (!el) { if (++tries < 25) setTimeout(go, 200); return; }
    if (el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ block: 'start' });
  };
  go();
}
