// The MiniMax endpoint picker, shown wherever a MiniMax key is entered: Setup › AI provider (and Settings › Models and
// subscriptions › Providers, the same card), Settings › Connections and keys, and a typed owner question that asks for
// the MiniMax key. "Where is your MiniMax account? Global / Mainland China / Custom", one line each; the address shows
// only under Details, or in the field when Custom is picked. "Find my endpoint" asks the console server to try the key
// on each region through the station (POST /api/setup/provider/detect); the browser never calls MiniMax itself.
// The stored choice lives in company/company.json providers.minimax (company/tools/lib/minimax-endpoint.js).
import { h, fill, Button, Details, humanError } from './ui.js';
import { api, post } from './api.js';

let seq = 0;
const FALLBACK = { region: 'global', label: 'Global', choices: [
  { id: 'global', label: 'Global', what: 'Your account is on minimax.io (anywhere outside mainland China).' },
  { id: 'cn', label: 'Mainland China', what: 'Your account is on minimaxi.com (the mainland China service).' },
  { id: 'custom', label: 'Custom', what: 'A different address, for example a company proxy in front of MiniMax.' }] };

// the stored endpoint, for a place that has no /api/setup payload at hand (a question on Today)
export async function loadEndpoint() { try { const r = await api('/setup/minimax-endpoint'); return r.endpoint || FALLBACK; } catch (_) { return FALLBACK; } }

// endpointPicker({ endpoint, getKey, onChange }) -> { el, value(), changed(), keyUrl() }
//   endpoint: the stored one ({region, label, baseUrl, choices, warnings, problem, stored}); getKey(): the pasted key
//   (empty = the server tries the key the company already holds)
export function endpointPicker(opts) {
  const cur = Object.assign({}, FALLBACK, opts.endpoint || {});
  const choices = cur.choices && cur.choices.length ? cur.choices : FALLBACK.choices;
  const name = 'mm-ep-' + (++seq);
  const radios = choices.map(c => ({ c, input: h('input', { type: 'radio', name, value: c.id, checked: c.id === cur.region }) }));
  const url = h('input', { class: 'input mono', type: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…/v1', 'aria-label': 'Custom MiniMax base URL', value: cur.region === 'custom' ? cur.baseUrl || '' : '' });
  const other = h('input', { type: 'checkbox', checked: !!cur.other });
  const warn = h('p', { class: 'caption', role: 'note', style: 'color:var(--status-warning);margin:0' });
  const customBox = h('div', { class: 'stack-6' }, h('label', { class: 'stack-4' }, h('span', { class: 'caption muted' }, 'Base URL (OpenAI-compatible, usually ends in /v1)'), url),
    h('label', { class: 'check body-s' }, other, 'This is not a MiniMax address (my key will be sent to it)'), warn);
  const details = h('div');
  const status = h('p', { class: 'caption', role: 'status', style: 'margin:0' });
  const picked = () => (radios.find(r => r.input.checked) || radios[0]).c;
  const draw = quiet => {
    const c = picked();
    customBox.hidden = c.id !== 'custom';
    warn.textContent = c.id === 'custom' && other.checked ? 'Only use an address you trust: the MiniMax key goes to it on every request.' : '';
    const addr = c.id === 'custom' ? null : c.baseUrl || (c.id === cur.region ? cur.baseUrl : null);
    fill(details, addr ? Details('Details', h('p', { class: 'caption mono-s' }, 'OpenAI-compatible address: ' + addr)) : null);
    if (opts.onChange && quiet !== true) opts.onChange();
  };
  radios.forEach(r => r.input.addEventListener('change', () => draw()));
  other.addEventListener('change', () => draw());
  url.addEventListener('input', () => { if (opts.onChange) opts.onChange(); });
  const find = Button('Find my endpoint', { variant: 'ghost', size: 'sm', onClick: async () => {
    status.style.color = ''; status.textContent = 'Trying your key on Global, then Mainland China…'; find.disabled = true;
    try {
      const r = await post('/setup/provider/detect', { provider: 'custom', key: opts.getKey ? opts.getKey() : '' });
      if (r.found) { const hit = radios.find(x => x.c.id === r.found); if (hit) { hit.input.checked = true; draw(); } status.textContent = r.text + ' It is selected; press ' + (opts.saveLabel || 'Connect') + ' to save it.'; }
      else { status.style.color = 'var(--status-danger)'; status.textContent = r.text; }
    } catch (e) { status.style.color = 'var(--status-danger)'; status.textContent = humanError(e); }
    finally { find.disabled = false; }
  } });
  const el = h('fieldset', { class: 'stack-6 mm-endpoint', 'data-endpoint': cur.region, style: 'border:0;padding:0;margin:0' },
    h('legend', { class: 'label strong', style: 'padding:0' }, 'Where is your MiniMax account?'),
    cur.stored || opts.showCurrent ? h('p', { class: 'caption muted', style: 'margin:0' }, 'Now: ' + (cur.plain || cur.label) + '.') : null,
    cur.problem ? h('p', { class: 'caption', style: 'color:var(--status-warning);margin:0' }, 'The saved endpoint could not be used, so Global is in use. Pick yours again.') : null,
    radios.map(r => h('label', { class: 'check body-s', style: 'align-items:flex-start;min-height:36px' }, r.input,
      h('span', { class: 'stack-4', style: 'gap:2px' }, h('span', { class: 'strong' }, r.c.label), h('span', { class: 'caption muted' }, r.c.what)))),
    customBox, details, h('div', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap' }, find), status);
  draw(true);
  return {
    el,
    value: () => { const c = picked(); return c.id === 'custom' ? { region: 'custom', baseUrl: url.value.trim(), other: other.checked } : { region: c.id }; },
    changed: () => { const c = picked(); if (c.id !== cur.region) return true; return c.id === 'custom' && (url.value.trim().replace(/\/+$/, '') !== (cur.baseUrl || '') || other.checked !== !!cur.other); },
    keyUrl: () => { const c = picked(); return c.keyUrl || cur.keyUrl || null; },
    label: () => picked().label,
  };
}
