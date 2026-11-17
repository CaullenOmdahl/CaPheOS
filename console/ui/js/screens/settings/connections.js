// Settings › Connections and keys (#/settings/connections[/connected|skills|channels|keys]): what the crew can reach
// (station connectors, skills, channels) and the API keys, shown masked: set or replace, never read back (was
// Abilities). API: /api/station/connectors, /api/station/skills, /api/station/channels/status, /api/station/servicekeys,
// /api/setup (providers), POST /api/setup/provider {keepDefault: true}.
import { h, fill, Button, Tag, errLine, empty, statusOf, asArray, Details, Setting, Block, humanError } from '../../ui.js';
import { api, post } from '../../api.js';
import { mountPanels } from '../../panels.js';
import { endpointPicker } from '../../minimax-endpoint.js';

const SOURCES = [
  ['connected', 'Connected services', 'Accounts and tools the crew can use. Each one is checked against what it was allowed to do, every check.', '/station/connectors', 'connectors'],
  ['skills', 'Skills', 'Know-how the crew has learned or installed.', '/station/skills', 'skills'],
  ['channels', 'Channels', 'Where the company can send and receive messages.', '/station/channels/status', null],
];

export async function render(host, ctx) {
  const { app } = ctx;
  const keys = h('div'), side = h('div', { class: 'stack-16' });
  const blocks = SOURCES.map(([id, title, lede]) => { const body = h('div'); return { id, el: Block({ id, title, lede }, body), body }; });
  fill(host, Block({ id: 'keys', title: 'API keys', lede: 'Keys the crew uses to reach paid services. A key goes straight to the station and is never shown again: you can only set or replace it.' }, keys),
    blocks.map(b => b.el), side);
  SOURCES.forEach(([id, , , path, key], i) => drawSource(blocks[i], path, key));
  drawKeys(keys, app);
  return mountPanels(side, 'side:abilities', app);
}

async function drawSource(b, path, key) {
  let d;
  try { d = await api(path); }
  catch (e) { if (e.status === 404 || /no such API route/i.test(e.message)) { b.el.hidden = true; return; } fill(b.body, errLine(e, 'Station')); return; }
  const items = key ? asArray(d, key) : Object.entries(d || {}).filter(([k]) => k !== 'ok').map(([id, v]) => Object.assign({ id }, typeof v === 'object' && v ? v : { state: v }));
  if (!items.length) return fill(b.body, h('p', { class: 'body-s muted' }, 'None yet. The crew adds these as it needs them.'));
  fill(b.body, h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:14px' }, items.map(i => {
    const name = i.name || i.title || i.label || i.id;
    const state = i.status || i.state || (i.connected === true ? 'Connected' : i.connected === false ? 'Not connected' : i.enabled === true ? 'On' : i.enabled === false ? 'Off' : i.paired ? 'Paired' : '');
    const what = i.description || i.desc || i.what || i.summary || '';
    return h('article', { class: 'card p18', style: 'gap:8px' },
      h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, String(name)), state ? Tag(cap(state), { variant: 'status', status: statusOf(state) }) : null),
      what ? h('p', { class: 'body-s muted' }, String(what).slice(0, 240)) : null,
      [i.kind || i.type, i.scope, i.provider].some(Boolean) ? Details('Details', h('p', { class: 'caption mono-s' }, [i.id, i.kind || i.type, i.scope, i.provider].filter(Boolean).join(' · '))) : null);
  })));
}

async function drawKeys(el, app) {
  let d = null, sk = null;
  try { d = await api('/setup'); } catch (e) { fill(el, errLine(e, 'Keys')); return; }
  try { sk = await api('/station/servicekeys'); } catch (_) {}
  const provs = (d.providers || []).filter(p => p.how === 'key');
  const signin = (d.providers || []).filter(p => p.how === 'signin');
  const row = p => {
    const box = h('div', { class: 'stack-8', hidden: true });
    const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the new key', 'aria-label': p.name + ' API key', style: 'max-width:420px' });
    const err = h('p', { class: 'err-line', role: 'status' });
    // MiniMax: the endpoint picker; with no new key, a changed endpoint is a switch (the key on file is re-checked there)
    const ep = p.id === 'custom' ? endpointPicker({ endpoint: p.endpoint, getKey: () => key.value, showCurrent: true, saveLabel: 'Save', onChange: () => { save.textContent = !key.value && ep.changed() ? 'Switch endpoint' : 'Save key'; } }) : null;
    const save = Button('Save key', { variant: 'primary', size: 'sm', onClick: async () => {
      const switchOnly = ep && !key.value.trim() && ep.changed();
      if (!key.value.trim() && !switchOnly) { err.textContent = 'Paste the key first.'; return; }
      err.textContent = ''; save.disabled = true;
      try { await post('/setup/provider', Object.assign({ provider: p.id, key: key.value, keepDefault: true }, ep ? ep.value() : {})); key.value = ''; app.toast(switchOnly ? 'MiniMax now uses ' + ep.label() + '. The key was checked there first.' : p.name + ' key saved' + (ep ? ' (' + ep.label() + ')' : '') + '.'); drawKeys(el, app); }
      catch (e) { err.textContent = 'Not saved: ' + humanError(e); } finally { save.disabled = false; key.value = ''; }
    } });
    box.append(...(ep ? [ep.el] : []), key, h('div', { class: 'row-8' }, save, Button('Cancel', { variant: 'ghost', size: 'sm', onClick: () => { key.value = ''; box.hidden = true; } })), err);
    const isSet = p.present || p.ready;
    return Setting({ id: 'set-key-' + p.id, title: p.name, value: (isSet ? 'Set' : 'Not set') + (p.endpoint && (isSet || p.endpoint.stored) ? ' · ' + p.endpoint.plain : ''), valueTone: isSet ? 'online' : 'neutral',
      what: p.present || p.ready ? 'Saved on the station as ••••••••. It is never shown again.' : 'No key yet.' + (p.blurb ? ' ' + p.blurb : ''),
      flip: p.present || p.ready ? 'Replacing it changes the key only; who new hires run on stays the same.' : 'Setting one lets crew members use ' + p.name + '. Pick it for new hires under Models and subscriptions.',
      extra: [box, p.keyUrl ? h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer', class: 'caption' }, 'Get a key →') : null],
      control: Button(p.present || p.ready ? (ep ? 'Replace or switch' : 'Replace') : 'Set', { variant: 'secondary', size: 'sm', onClick: () => { box.hidden = false; key.focus(); } }) });
  };
  const service = sk && Array.isArray(sk.keys) ? sk.keys : [];
  fill(el,
    !d.station.up ? h('p', { class: 'body-s muted' }, 'The station is not running, so keys cannot be set right now.') : null,
    h('div', { class: 'stack-10' }, provs.map(row),
      signin.map(p => Setting({ title: p.name, value: p.ready ? 'Signed in' : 'Not signed in', valueTone: p.ready ? 'online' : 'neutral',
        what: 'Uses your subscription through a sign-in on the station machine; there is no key to paste.', flip: p.ready ? null : 'Sign in under Models and subscriptions.',
        control: p.ready ? null : Button('Sign in', { variant: 'secondary', size: 'sm', href: '#/settings/models/providers' }) }))),
    service.length ? h('div', { class: 'stack-8' }, h('h3', { class: 'h4' }, 'Service keys on the station'),
      h('ul', { class: 'plain' }, service.map(k => h('li', { class: 'sys-row' }, h('span', { class: 'strong' }, k.name || k.label || k.id || 'Key'), h('span', { class: 'mono-s muted' }, '••••••••'))))) : null,
    h('p', { class: 'caption muted' }, 'When the crew needs a key it asks on Today with a private field; the value is stored and never echoed.'));
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
