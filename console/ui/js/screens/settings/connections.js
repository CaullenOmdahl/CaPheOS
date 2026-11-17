// Settings › Connections and keys (#/settings/connections[/connected|skills|channels|keys]): what the crew can reach
// (station connectors, skills, channels) and the API keys, shown masked: set or replace, never read back (was
// Abilities). API: /api/station/connectors, /api/station/skills, /api/station/channels/status, /api/station/servicekeys,
// /api/setup (providers), POST /api/setup/provider {keepDefault: true}.
import { h, fill, Button, Tag, errLine, empty, statusOf, asArray, Details, Setting, Block, humanError, when } from '../../ui.js';
import { api, post } from '../../api.js';
import { mountPanels } from '../../panels.js';
import { endpointPicker } from '../../minimax-endpoint.js';
import { drawSignIns } from './sign-ins.js';

const SOURCES = [
  ['connected', 'Connected services', 'Accounts and tools the crew can use. Each one is checked against what it was allowed to do, every check.', '/station/connectors', 'connectors'],
  ['skills', 'Skills', 'Know-how the crew has learned or installed.', '/station/skills', 'skills'],
  ['channels', 'Channels', 'Where the company can send and receive messages.', '/station/channels/status', null],
];

export async function render(host, ctx) {
  const { app } = ctx;
  const keys = h('div'), skeys = h('div'), signins = h('div'), side = h('div', { class: 'stack-16' });
  const blocks = SOURCES.map(([id, title, lede]) => { const body = h('div'); return { id, el: Block({ id, title, lede }, body), body }; });
  fill(host, Block({ id: 'keys', title: 'API keys', lede: 'Keys the crew uses to reach paid services. A key goes straight to the station and is never shown again: you can only set or replace it.' }, keys),
    Block({ id: 'sign-ins', title: 'Sign-ins', lede: 'Services that need your own sign-in (Google, GitHub). The sign-in runs on the station; you sign in in your own browser, on this computer or any other, and only the credential it creates stays on the station. The crew never gets your browser session.' }, signins),
    Block({ id: 'service-keys', title: 'Service keys', lede: 'Keys and addresses for the outside services the crew uses: data feeds, exchanges, monitoring. Each is saved on this computer and never shown again; you can add one or replace it at any time.' }, skeys),
    blocks.map(b => b.el), side);
  drawServiceKeys(skeys, app);
  const stopSignIns = drawSignIns(signins, app, ctx.anchor);
  SOURCES.forEach(([id, , , path, key], i) => drawSource(blocks[i], path, key));
  drawKeys(keys, app);
  const unmount = await mountPanels(side, 'side:abilities', app);
  return () => { stopSignIns(); if (typeof unmount === 'function') unmount(); };
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
/* Service keys (console/service-keys.js, GET/POST /api/service-keys): every key the company has in secrets/, set or not,
 * when it changed and who reads it; Add a key and Replace paste into a masked field. A value is never read back. File
 * names and paths sit under Details only. */
function maskedField(label, multiline, address) {
  const attrs = { class: 'input secret-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'aria-label': label };
  const ph = address ? 'Paste the address (https://…)' : multiline ? 'Paste the whole key (a multi-line private key is fine)' : 'Paste the key';
  const el = multiline ? h('textarea', Object.assign({}, attrs, { class: 'textarea secret-input secret-mask', rows: '4', placeholder: ph }))
    : h('input', Object.assign({ type: 'password', placeholder: ph, style: 'max-width:420px;width:100%' }, attrs));
  return { el, value: () => el.value, clear: () => { el.value = ''; } };
}
const noun = k => k.kind === 'address' ? 'address' : 'key';
export async function drawServiceKeys(el, app) {
  let d;
  try { d = await api('/service-keys'); } catch (e) { fill(el, errLine(e, 'Service keys')); return; }
  const keys = d.keys || [], services = d.services || [];
  const saved = new Map(keys.filter(k => k.set).map(k => [k.name, k]));
  const redraw = () => drawServiceKeys(el, app);
  const save = async (body, label, err, btn) => {
    err.textContent = ''; btn.disabled = true;
    try { const r = await post('/service-keys', body); app.toast(r.label + ' ' + (r.replaced ? 'replaced' : 'saved') + '.' + (r.told ? ' ' + r.told + ' was told.' : '')); redraw(); return true; }
    catch (e) { err.textContent = 'Not saved: ' + humanError(e); return false; }
    finally { btn.disabled = false; }
  };
  const row = k => {
    const box = h('div', { class: 'stack-8', hidden: true });
    const fld = maskedField(k.label + ' ' + noun(k), k.multiline, k.kind === 'address');
    const err = h('p', { class: 'err-line', role: 'status' });
    const go = Button(k.set ? 'Save new ' + noun(k) : 'Save ' + noun(k), { variant: 'primary', size: 'sm', onClick: async () => {
      if (!fld.value().trim()) { err.textContent = 'Paste the ' + noun(k) + ' first.'; return; }
      const v = fld.value(); fld.clear(); await save({ name: k.name, value: v, replace: k.set }, k.label, err, go);
    } });
    box.append(fld.el, h('div', { class: 'row-8' }, go, Button('Cancel', { variant: 'ghost', size: 'sm', onClick: () => { fld.clear(); box.hidden = true; err.textContent = ''; } })), err);
    const used = (k.usedBy || []).length ? 'Used by ' + k.usedBy.join(', ') + '.' : 'No tool reads it yet.';
    const s = Setting({ id: 'set-skey-' + k.name, title: k.label, value: k.set ? 'Set' : 'Not set', valueTone: k.set ? 'online' : 'neutral',
      what: k.set ? 'Saved ' + when(k.changedAt) + '. The ' + noun(k) + ' is never shown again.' : 'Not saved yet.' + (k.where ? ' ' + k.where : ''),
      flip: used,
      extra: [box, k.url && !k.set ? h('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer', class: 'caption' }, 'Where to get it →') : null,
        Details('Details', h('p', { class: 'caption mono-s' }, 'Saved as secrets/' + k.name + ' (mode 0600)'), (k.files || []).length ? h('p', { class: 'caption mono-s' }, 'Read by ' + k.files.join(', ')) : null)],
      control: Button(k.set ? 'Replace' : 'Add', { variant: 'secondary', size: 'sm', aria: (k.set ? 'Replace ' : 'Add ') + k.label, onClick: () => { box.hidden = false; fld.el.focus(); } }) });
    s.setAttribute('data-skey', k.name);
    return s;
  };
  // Add a key: pick a service (or Other and a name), where to get it, the masked field
  const add = h('div', { class: 'stack-10 card p18 skey-add', hidden: true, 'data-skey-add': '' });
  const pick = h('select', { class: 'input', 'aria-label': 'Service', style: 'max-width:420px;width:100%' },
    h('option', { value: '' }, 'Pick a service…'), services.map(x => h('option', { value: x.id }, x.label)), h('option', { value: 'other' }, 'Other (type a name)'));
  const nameIn = h('input', { type: 'text', class: 'input mono', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. acme-feed-key', 'aria-label': 'Name for the key', style: 'max-width:420px;width:100%' });
  const nameRow = h('label', { class: 'stack-4', hidden: true }, h('span', { class: 'caption muted' }, 'A short name: letters, digits, - . _ (a web address: end it with -url)'), nameIn);
  const where = h('p', { class: 'body-s' }), link = h('a', { target: '_blank', rel: 'noopener noreferrer', class: 'caption', hidden: true }, 'Where to get it →');
  const already = h('p', { class: 'caption strong', hidden: true });
  const slot = h('div'); let fld = maskedField('The key', false, false);
  const err = h('p', { class: 'err-line', role: 'status' });
  const svc = () => services.find(x => x.id === pick.value) || null;
  const nameOf = () => svc() ? svc().name : nameIn.value.trim();
  const refresh = () => {
    const x = svc(); const other = pick.value === 'other';
    nameRow.hidden = !other;
    where.textContent = x ? x.where : other ? 'Paste the key the service gave you. Ask the crew member who needs it if you are not sure which one.' : '';
    link.hidden = !(x && x.url); if (x && x.url) link.href = x.url;
    const addr = x ? x.kind === 'address' : /(^|[-_.])(url|uri|address|webhook)$/i.test(nameIn.value.trim());
    const v = fld.value(); fld = maskedField(x ? x.label : 'The key', !!(x && x.multiline), addr); fill(slot, fld.el); fld.el.value = v;
    const ex = saved.get(nameOf());
    already.hidden = !ex; already.textContent = ex ? 'Already saved — saving replaces it.' : '';
    go.textContent = addr ? 'Save address' : 'Save key';
  };
  const go = Button('Save key', { variant: 'primary', size: 'sm', onClick: async () => {
    if (!pick.value) { err.textContent = 'Pick a service first.'; return; }
    if (pick.value === 'other' && !nameIn.value.trim()) { err.textContent = 'Give it a name first.'; return; }
    if (!fld.value().trim()) { err.textContent = 'Paste it first.'; return; }
    const v = fld.value(); fld.clear();
    const body = Object.assign({ value: v, replace: saved.has(nameOf()) }, pick.value === 'other' ? { name: nameIn.value.trim() } : { service: pick.value });
    await save(body, '', err, go);
  } });
  pick.addEventListener('change', refresh); nameIn.addEventListener('input', refresh);
  add.append(h('h3', { class: 'h4' }, 'Add a key'), pick, nameRow, where, link, slot, already,
    h('div', { class: 'row-8' }, go, Button('Cancel', { variant: 'ghost', size: 'sm', onClick: () => { fld.clear(); add.hidden = true; err.textContent = ''; } })), err);
  refresh();
  const openAdd = Button('Add a key', { variant: 'secondary', size: 'sm', onClick: () => { add.hidden = false; pick.focus(); } });
  fill(el,
    h('div', { class: 'row-8' }, openAdd),
    add,
    keys.length ? h('div', { class: 'stack-10' }, keys.map(row)) : h('p', { class: 'body-s muted' }, 'No service keys yet. Add one here, or the crew asks on Today when it needs one.'),
    h('p', { class: 'caption muted' }, 'When the crew needs a key it asks on Today with a private field; a key saved here counts too.'));
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
