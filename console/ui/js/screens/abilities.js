// Abilities (Abilities.dc.html): connectors, skills, channels (station reads); the rest honest empty states.
import { h, fill, Tag, errLine, empty, tabs, screenHead, statusOf, asArray, NOT_CONNECTED } from '../ui.js';
import { api } from '../api.js';
import { mountPanels } from '../panels.js';

const DEFS = [['connected', 'Connected'], ['skills', 'Skills'], ['channels', 'Channels'], ['keys', 'API keys'], ['tools', 'Tools'], ['apps', 'Apps'], ['browser', 'Browser']];
const SOURCES = { connected: ['/station/connectors', 'connectors'], skills: ['/station/skills', 'skills'], channels: ['/station/channels/status', null] };
const WHAT = { keys: 'Service API keys and the secrets/ folder: exposed to runs as environment variables, never printed.', tools: 'Per-toolset kill switches, hooks and plugins, extensions.',
  apps: 'Apps the crew built from a description.', browser: 'Watch or take over an agent’s browser; saved sign-ins.' };

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-32';
  let tab = ctx.rest[0] || 'connected';
  const tabsHost = h('div'), body = h('div'), side = h('div', { class: 'stack-16' });
  fill(root, screenHead({ eyebrow: ['Station abilities'], title: 'Abilities.', lede: 'What the crew can reach. Each connector is checked against its recorded scope every tick.', max: '640px' }), tabsHost, body, side);
  const draw = () => fill(tabsHost, tabs(DEFS, tab, id => { tab = id; history.replaceState(null, '', '#/abilities/' + id); draw(); load(); }, 'Abilities'));
  draw();
  async function load() {
    const src = SOURCES[tab];
    if (!src) return fill(body, h('div', { class: 'empty' }, h('p', null, WHAT[tab]), h('p', null, NOT_CONNECTED)));
    fill(body, h('p', { class: 'caption muted' }, 'Loading…'));
    try {
      const d = await api(src[0]);
      let items = src[1] ? asArray(d, src[1]) : Object.entries(d || {}).filter(([k]) => k !== 'ok').map(([id, v]) => Object.assign({ id }, typeof v === 'object' ? v : { state: v }));
      if (!items.length) return fill(body, empty('Nothing here yet.'));
      fill(body, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px' }, items.map(i => {
        const name = i.name || i.title || i.label || i.id;
        const state = i.status || i.state || (i.connected === true ? 'Connected' : i.connected === false ? 'Not connected' : i.enabled === true ? 'On' : i.enabled === false ? 'Off' : i.paired ? 'Paired' : '');
        return h('article', { class: 'card p20', style: 'gap:10px' },
          h('div', { class: 'between-c' }, h('h2', { class: 'h4' }, String(name)), state ? Tag(String(state), { variant: 'status', status: statusOf(state) }) : null),
          h('p', { class: 'body-s muted' }, String(i.description || i.desc || i.what || i.summary || '')),
          h('span', { class: 'mono muted' }, [i.kind || i.type, i.scope, i.provider].filter(Boolean).join(' · ')));
      })));
    } catch (e) { fill(body, errLine(e, 'Station')); }
  }
  load();
  const stopPanels = mountPanels(side, 'side:abilities', app);
  return () => stopPanels();
}
