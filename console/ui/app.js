// CaPheOS owner console: shell, sidebar and hash router. No build step.
import { h, fill, Logo, Tag, Button, rel, isSetupQuestion } from './js/ui.js';
import { api } from './js/api.js';
import * as events from './js/events.js';

const SCREENS = {
  today: () => import('./js/screens/today.js'),
  setup: () => import('./js/screens/setup.js'),
  comms: () => import('./js/screens/comms.js'),
  crew: () => import('./js/screens/crew.js'),
  work: () => import('./js/screens/work.js'),
  hiring: () => import('./js/screens/hiring.js'),
  controls: () => import('./js/screens/controls.js'),
  automate: () => import('./js/screens/automate.js'),
  governance: () => import('./js/screens/governance.js'),
  usage: () => import('./js/screens/usage.js'),
  floor: () => import('./js/screens/floor.js'),
  abilities: () => import('./js/screens/abilities.js'),
  system: () => import('./js/screens/system.js'),
  map: () => import('./js/screens/map.js'),
  halt: () => import('./js/screens/halt.js'),
  p: () => import('./js/screens/panel-screen.js'),
  kit: () => import('./js/screens/kit-gallery.js'),
};
const TITLES = { today: 'Today', setup: 'Setup', comms: 'Comms', crew: 'Crew', work: 'Work', hiring: 'Hiring', controls: 'Controls', automate: 'Automate',
  governance: 'Governance', usage: 'Usage and models', floor: 'Floor', abilities: 'Abilities', system: 'System', map: 'Feature map', halt: 'Halt', p: 'Company', kit: 'Page kit' };
const NAV = [
  ['Company', [['setup', 'Setup'], ['today', 'Today'], ['comms', 'Comms'], ['crew', 'Crew'], ['work', 'Work'], ['hiring', 'Hiring']]],
  ['Operations', [['controls', 'Controls'], ['automate', 'Automate'], ['governance', 'Governance'], ['usage', 'Usage and models']]],
  ['Station', [['floor', 'Floor'], ['abilities', 'Abilities'], ['system', 'System'], ['map', 'Feature map']]],
];

// The route map (docs/CONSOLE-LINKS.md): every place an agent may link to with `console:#/…`. Aliases keep the
// readable names working: #/controls/guardrails is the Guardrails tab, #/setup/ai the provider step, and so on.
export const ALIASES = {
  controls: { governance: 'gov', 'self-governance': 'gov', guardrails: 'guard', cadence: 'ticks', schedule: 'ticks', tempo: 'ticks', sprint: 'ticks' },
  work: { quest: 'quests', handoff: 'handoffs', decision: 'decisions', project: 'projects' },
  abilities: { connectors: 'connected', 'api-keys': 'keys' },
};

// shared app context handed to every screen
export const app = { company: null, counts: {}, toast, confirmDialog, refreshSidebar: () => refreshSidebar() };
window.capheos = app;

const sideEl = document.getElementById('side');
const mainEl = document.getElementById('main');
let current = { id: null, cleanup: null, token: 0 };

/* ---------- sidebar ---------- */
const counts = {};
// the Setup nav item shows until the company is certified (System links to Setup afterwards)
app.refreshSetupNav = certified => { const l = navLinks.setup; if (l) l.a.hidden = !!certified; };
const setupDone = () => !!(app.company && app.company.onboarding && app.company.onboarding.certified);
const navLinks = {};
const needsN = h('span', { class: 'n', 'aria-live': 'polite' }, '');
const stationTag = h('span', null, Tag('Checking', { variant: 'status', status: 'neutral' }));
const stationLine = h('span', { class: 'mono muted' }, '');
const coName = h('span', { class: 'caption muted' }, '');
const companyGroup = h('div', { class: 'nav-group', hidden: true });
async function loadCompanyNav() {
  try {
    const d = await api('/panels');
    const list = (d.panels || []).filter(p => p.status === 'installed' && !p.hidden && p.valid !== false && p.placement === 'screen').slice(0, 8);
    companyGroup.hidden = !list.length;
    fill(companyGroup, h('span', { class: 'nav-label' }, 'Company'), list.map(p => {
      const a = h('a', { href: '#/p/' + encodeURIComponent(p.id), class: 'nav-item', 'aria-current': 'false' }, h('span', null, p.nav || p.title || p.id), h('span', { class: 'n' }, ''));
      navLinks['p/' + p.id] = { a, n: a.lastChild };
      return a;
    }));
  } catch (_) { companyGroup.hidden = true; }
}
let collapsed = window.matchMedia('(max-width: 860px)').matches;

function buildSidebar() {
  const toggle = Button('Menu', { variant: 'ghost', size: 'sm', class: 'side-toggle', onClick: () => { collapsed = !collapsed; nav.classList.toggle('collapsed', collapsed); toggle.setAttribute('aria-expanded', String(!collapsed)); } });
  toggle.setAttribute('aria-expanded', String(!collapsed));
  const nav = h('nav', { 'aria-label': 'Console', class: 'side' + (collapsed ? ' collapsed' : '') },
    h('div', { class: 'brand' }, Logo(28),
      h('div', { class: 'stack-4', style: 'gap:2px' }, h('span', { class: 'brand-name' }, 'CaPheOS'), coName),
      toggle),
    h('a', { href: '#/today', class: 'needs-link' }, h('span', null, 'Needs you'), needsN),
    NAV.map(([label, items]) => h('div', { class: 'nav-group' },
      h('span', { class: 'nav-label' }, label),
      items.map(([id, text]) => {
        const n = h('span', { class: 'n' }, '');
        const a = h('a', { href: '#/' + id, class: 'nav-item', 'aria-current': 'false', onclick: () => { if (collapsed) { collapsed = true; } } }, h('span', null, text), n);
        navLinks[id] = { a, n };
        return a;
      }))),
    companyGroup,
    h('div', { class: 'station-box' },
      h('div', { class: 'between-c' }, h('span', { class: 'label strong' }, 'Station'), stationTag),
      stationLine,
      h('div', { class: 'halt-btns' },
        h('a', { href: '#/halt?mode=soft', class: 'halt-soft' }, 'Soft halt'),
        h('a', { href: '#/halt?mode=hard', class: 'halt-hard' }, 'Hard halt'))));
  fill(sideEl, nav);
}
function setCount(id, n) {
  counts[id] = n; app.counts[id] = n;
  if (id === 'needs') needsN.textContent = n == null ? '' : String(n);
  else if (navLinks[id]) navLinks[id].n.textContent = n ? String(n) : '';
}
app.setCount = setCount;

async function refreshSidebar() {
  api('/questions').then(d => setCount('needs', (d.questions || []).filter(q => !isSetupQuestion(q)).length)).catch(() => setCount('needs', '!'));
  api('/crew').then(d => setCount('crew', (d.seats || []).length)).catch(() => {});
  // a pulse on Crew while anyone is running (who and what is on Today's "Now")
  api('/now').then(d => { const l = navLinks.crew; if (!l) return; const n = (d.runs || []).length; l.a.classList.toggle('working', n > 0); l.a.title = n ? n + ' running now: ' + d.runs.map(r => r.name).join(', ') : ''; }).catch(() => {});
  api('/handoffs').then(d => setCount('work', (d.items || []).length)).catch(() => {});
  api('/hiring').then(d => setCount('hiring', (d.rounds || []).filter(r => !r.hired && r.status !== 'closed').length)).catch(() => {});
  const [halt, disp, health] = await Promise.allSettled([api('/halt'), api('/dispatch'), fetch('/api/station/health', { credentials: 'same-origin' })]);
  const up = health.status === 'fulfilled' && health.value.ok;
  const mode = halt.status === 'fulfilled' ? halt.value.mode : null;
  let label = up ? 'Running' : 'Not running', st = up ? 'online' : 'danger';
  if (mode === 'soft') { label = 'Soft halt'; st = 'warning'; } else if (mode === 'hard') { label = 'Hard halt'; st = 'danger'; }
  fill(stationTag, Tag(label, { variant: 'status', status: st }));
  let port = ''; try { port = ':' + new URL(app.company && app.company.station && app.company.station.url).port; } catch (_) {}
  let last = '';
  if (disp.status === 'fulfilled') {
    const s = disp.value.state || {};
    const at = s.lastTick || s.at || s.lastRun || s.tickAt;
    if (at) last = 'dispatcher ' + rel(at);
    else if ((disp.value.log || []).length) last = 'dispatcher log ' + (disp.value.log.length) + ' lines';
  }
  stationLine.textContent = [up ? port || 'up' : 'station not running', last].filter(Boolean).join(' · ');
}

/* ---------- toast + confirm ---------- */
let toastTimer = null;
function toast(text, bad) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
  t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}
// confirmDialog({title, body, confirm, danger, typed}) -> Promise<boolean>. `typed` = sentence the owner must type.
function confirmDialog(o) {
  return new Promise(resolve => {
    const input = o.typed ? h('input', { class: 'input', type: 'text', 'aria-label': 'Type the sentence to confirm', autocomplete: 'off' }) : null;
    const ok = Button(o.confirm || 'Confirm', { variant: o.danger ? 'danger' : 'primary', disabled: !!o.typed });
    const cancel = Button(o.cancel || 'Cancel', { variant: 'secondary' });
    const d = h('dialog', { class: 'modal', 'aria-labelledby': 'dlg-t' },
      h('div', { class: 'stack-14' },
        h('h2', { id: 'dlg-t', class: 'h4' }, o.title),
        o.body ? h('p', { class: 'body-s' }, o.body) : null,
        o.typed ? h('label', { class: 'stack-6' }, h('span', { class: 'caption muted' }, 'Type: ', h('strong', { class: 'strong' }, o.typed)), input) : null,
        h('div', { class: 'row-8' }, cancel, ok)));
    if (input) input.addEventListener('input', () => { ok.disabled = input.value.trim() !== o.typed; });
    const done = v => { d.close(); d.remove(); resolve(v); };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    d.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    document.body.appendChild(d);
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    (input || cancel).focus();
  });
}

/* ---------- router ---------- */
function parseHash() {
  // the landing page is Setup until onboard.js --certify is green, then Today
  const raw = (location.hash && location.hash !== '#' && location.hash !== '#/' ? location.hash : app.company && app.company.onboarding && !setupDone() ? '#/setup' : '#/today').replace(/^#\/?/, '');
  const [p, qs] = raw.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  const id = SCREENS[parts[0]] ? parts[0] : 'today';
  const rest = parts.slice(1);
  if (rest[0] && ALIASES[id] && ALIASES[id][rest[0].toLowerCase()]) rest[0] = ALIASES[id][rest[0].toLowerCase()];
  return { id, rest, query: new URLSearchParams(qs || '') };
}
async function route() {
  const r = parseHash();
  const token = ++current.token;
  if (current.cleanup) { try { current.cleanup(); } catch (_) {} current.cleanup = null; }
  const navId = r.id === 'p' ? 'p/' + (r.rest[0] || '') : r.id;
  for (const [id, l] of Object.entries(navLinks)) l.a.setAttribute('aria-current', id === navId ? 'page' : 'false');
  document.title = TITLES[r.id] + ' · CaPheOS';
  mainEl.className = 'shell-main';
  fill(mainEl, h('main', { class: 'main', id: 'content', tabindex: '-1' }, h('p', { class: 'caption muted' }, 'Loading…')));
  try {
    const mod = await SCREENS[r.id]();
    if (token !== current.token) return;
    const root = mainEl.firstChild;
    const cleanup = await mod.render(root, Object.assign({ app, mainEl }, r));
    if (token !== current.token) { if (typeof cleanup === 'function') cleanup(); return; }
    current.cleanup = typeof cleanup === 'function' ? cleanup : null;
    current.id = r.id;
  } catch (e) {
    console.error(e);
    fill(mainEl.firstChild, h('p', { class: 'err-line' }, 'This screen failed to load: ' + e.message));
  }
}

/* ---------- boot ---------- */
async function boot() {
  buildSidebar();
  try { app.company = await api('/company'); coName.textContent = app.company.name || ''; app.refreshSetupNav(setupDone()); }
  catch (e) { coName.textContent = e.auth ? 'Not signed in' : ''; app.companyError = e; }
  events.start();
  events.on(['questions', 'halt', 'crew', 'dispatch', 'handoffs', 'now'], () => refreshSidebar());
  events.on('panels', loadCompanyNav); loadCompanyNav();
  refreshSidebar();
  window.addEventListener('hashchange', route);
  route();
}
boot();
