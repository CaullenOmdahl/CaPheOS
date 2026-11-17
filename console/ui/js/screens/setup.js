// Setup (#/setup): the guided first run. Seven steps, each with its status, one sentence of why, and the controls
// inline. The landing page until onboard.js --certify is green; after that #/setup redirects to Settings, where the
// same steps are embedded (render with ctx.only = [step ids], ctx.embedded = true). API: GET /api/setup,
// POST /api/setup/{company,provider,provider/validate,budget,charter}, /api/governance/preset, /api/guardrails/*,
// /api/onboarding/certify, the station's Claude sign-in (/api/station/auth/claude-cli/*). docs/CONSOLE-API.md "Setup".
import { h, fill, Button, Tag, errLine, Eyebrow, Details, humanError } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { PRESET_WHAT, GUARD_NAMES } from './settings/autonomy.js';
import { mdBlock } from '../md.js';
import { endpointPicker } from '../minimax-endpoint.js';

const STEP_ALIAS = { ai: 'provider', providers: 'provider', model: 'provider', money: 'budget', gov: 'governance', guard: 'guardrails', check: 'certify', checks: 'certify' };
// the certification checks in plain words (onboard.js --certify); the raw id and what is missing go behind Details
export const CHECK_NAMES = { station: 'The station answers', dispatcher: 'The dispatcher wakes the crew on time', guardrails: 'The guardrails are applied', secrets: 'The keys are in place and private',
  ops: 'Health checks and backups are registered', backups: 'A backup can be restored', liveness: 'The dead-man switch is armed', doctor: 'Capability packs and modules pass their checks',
  charter: 'The charter is filled in', console: 'This console runs', founder: 'The Founder has its routine', 'founder-loop': 'The Founder has its routine', kickoff: 'The first plan exists', models: 'The crew has a model it can run on' };
const ss = { set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} } };

const STATUS = { done: ['Done', 'online'], needs: ['Needs you', 'warning'], optional: ['Optional', 'neutral'] };
const BUDGETS = [
  { id: 'zero', daily: 0, per: 0, label: '$0 a day', what: 'Subscription only. Nothing pay-per-token runs.' },
  { id: 'two', daily: 2, per: 1, label: '$2 a day', what: 'A small allowance. Up to $1 per crew member.' },
  { id: 'five', daily: 5, per: 2, label: '$5 a day', what: 'Room for a few metered crew. Up to $2 each.' },
];

export async function render(root, ctx) {
  const { app } = ctx;
  const only = ctx.only || null, embedded = !!ctx.embedded;
  if (!embedded) root.className = 'main gap-32';
  const head = h('div'); const readyEl = h('div'); const stepsEl = h('div', { class: 'stack-16' }); const extraEl = h('div');
  const pageErr = h('div');
  fill(root, head, pageErr, readyEl, stepsEl, extraEl);
  const open = new Set(); let first = true; let S = null;
  let focusStep = ctx.rest[0] ? (STEP_ALIAS[ctx.rest[0]] || ctx.rest[0]) : null;   // #/setup/<step>: open it and scroll to it
  let charter = null;          // GET /api/setup/charter: the text as it stands
  let charterMode = 'view';    // view | edit | form
  let login = null;           // the Claude sign-in in progress: { id, url, timer }
  const keep = {};            // form drafts survive a reload of the data

  async function load() {
    let d;
    try { [d, charter] = await Promise.all([api('/setup'), api('/setup/charter').catch(() => null)]); fill(pageErr); }
    catch (e) { fill(pageErr, errLine(e, 'Setup')); return; }
    S = only ? Object.assign({}, d, { steps: d.steps.filter(s => only.includes(s.id)) }) : d;
    if (app.company) app.company.onboarding = Object.assign({}, app.company.onboarding, { certified: d.certified });
    if (app.refreshSetupNav) app.refreshSetupNav(d.certified);
    if (first && embedded) { if (focusStep) open.add(focusStep); first = false; }
    if (first) { if (focusStep && d.steps.some(s => s.id === focusStep)) open.add(focusStep); else for (const s of d.steps) if (s.status !== 'done') { open.add(s.id); break; } first = false; }
    draw();
    if (focusStep) { const el = document.getElementById('step-' + focusStep); focusStep = null; if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); const sm = el.querySelector('summary'); if (sm) sm.focus({ preventScroll: true }); } }
  }
  function draw() {
    const d = S;
    const next = d.steps.find(s => s.status === 'needs');
    if (embedded) { fill(head); fill(readyEl); } else {
    fill(head, h('header', { class: 'stack-12', style: 'max-width:760px' },
      Eyebrow(['Setup', d.company.name]),
      h('h1', { class: 'h1' }, d.certified ? 'Your company is set up.' : 'Set up your company.'),
      h('p', { class: 'body-l muted' }, d.certified ? 'Everything below can still be changed. Today is your home page now.'
        : 'Seven short steps. Each one says why it matters and has its controls right here. ' + d.done + ' of ' + d.total + ' done' + (next ? '; next: ' + next.title + '.' : '.')),
      h('div', { class: 'meter', role: 'img', 'aria-label': d.done + ' of ' + d.total + ' steps done' }, h('div', { style: 'width:' + Math.round(d.done / d.total * 100) + '%' }))));
    fill(readyEl, d.certified ? h('section', { class: 'card p22', role: 'status', style: 'border-color:var(--status-online);gap:10px' },
      h('h2', { class: 'h3' }, 'Your company is ready.'),
      h('p', { class: 'body-s' }, 'All checks passed' + (d.lastCertify ? ' (' + new Date(d.lastCertify).toLocaleString() + ')' : '') + '. The crew can run on its own; questions that need you land on Today.'),
      h('div', { class: 'row-8' }, Button('Go to Today', { variant: 'primary', href: '#/today' }), Button('Talk to the Founder', { variant: 'secondary', href: '#/chat/agent:' + ((app.company && app.company.ceo && app.company.ceo.id) || 'agent') }))) : null);
    }
    const body = { company: stepCompany, provider: stepProvider, budget: stepBudget, governance: stepGovernance, charter: stepCharter, guardrails: stepGuardrails, certify: stepCertify };
    fill(stepsEl, d.steps.map((s, i) => {
      const [label, st] = STATUS[s.status] || STATUS.needs;
      const det = h('details', { class: 'card p22 setup-step', id: 'step-' + s.id, style: 'gap:12px' + (s.status === 'needs' ? ';border-color:var(--status-warning)' : '') },
        h('summary', { class: 'between-c', style: 'cursor:pointer;gap:12px;min-height:44px' },
          h('span', { class: 'row-8', style: 'align-items:center;gap:12px;flex:1;min-width:0;flex-wrap:nowrap' }, embedded ? null : h('span', { class: 'avatar', 'aria-hidden': 'true', style: 'flex:none' }, String(i + 1)),
            h('span', { class: 'stack-4', style: 'gap:2px;min-width:0' }, h('span', { class: 'h4' }, s.title), h('span', { class: 'body-s muted' }, s.why))),
          Tag(label, { variant: 'status', status: st })),
        h('div', { class: 'stack-14', style: 'padding-top:12px' }, body[s.id] ? body[s.id](d) : null));
      if (open.has(s.id)) det.open = true;
      det.addEventListener('toggle', () => { if (det.open) open.add(s.id); else open.delete(s.id); });
      return det;
    }));
    if (!embedded || ctx.extras) drawExtra(d); else fill(extraEl);
  }
  const errP = () => h('p', { class: 'err-line', role: 'status' });
  async function act(btn, errEl, fn, okMsg, after) {
    errEl.textContent = ''; if (btn) btn.disabled = true;
    try { const r = await fn(); if (okMsg) app.toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); if (after) after(r); await load(); return r; }
    catch (e) { errEl.textContent = humanError(e); return null; }
    finally { if (btn) btn.disabled = false; }
  }
  const field = (label, input, hint) => h('label', { class: 'stack-6' }, h('span', { class: 'label strong' }, label), input, hint ? h('span', { class: 'caption muted' }, hint) : null);
  const copyable = cmd => h('div', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap' }, h('code', { class: 'mono-s sunken', style: 'padding:8px 10px;flex:1;min-width:0;overflow-wrap:anywhere' }, cmd),
    Button('Copy', { variant: 'ghost', size: 'sm', onClick: async () => { try { await navigator.clipboard.writeText(cmd); app.toast('Copied.'); } catch (_) { app.toast('Copy it by hand: ' + cmd, true); } } }));

  /* ---- 1. company ---- */
  function stepCompany(d) {
    const err = errP();
    const name = h('input', { class: 'input', type: 'text', value: d.company.name, maxlength: '80', autocomplete: 'organization' });
    const ownerIn = h('input', { class: 'input', type: 'text', value: d.company.ownerName === 'Owner' ? '' : d.company.ownerName, maxlength: '60', placeholder: 'Your name', autocomplete: 'name' });
    let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) {}
    const tz = h('input', { class: 'input', type: 'text', value: d.company.timezone, list: 'tz-list', autocomplete: 'off', spellcheck: 'false' });
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const save = Button('Save', { variant: 'primary', onClick: () => act(save, err, () => post('/setup/company', { name: name.value, ownerName: ownerIn.value, timezone: tz.value }), r => r.unchanged ? 'Nothing changed.' : 'Saved.', () => { if (app.company) { app.company.name = name.value; } }) });
    return [h('p', { class: 'body-s muted' }, 'The crew signs its work with these names and runs its clocks (reports, quiet hours, deadlines) on this timezone.'),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:14px' },
        field('Company name', name), field('Your name', ownerIn, 'How the crew addresses you.'),
        field('Timezone', tz, here && here !== d.company.timezone ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', style: 'padding:0;min-height:0', onclick: () => { tz.value = here; } }, 'Use this browser\'s: ' + here) : 'An IANA zone, like Europe/London.')),
      h('datalist', { id: 'tz-list' }, zones.map(z => h('option', { value: z }))),
      h('div', { class: 'row-8' }, save), err];
  }

  /* ---- 2. AI provider ---- */
  function stepProvider(d) {
    if (!d.station.up) return [h('p', { class: 'body-s' }, 'The station is not answering, so nothing can be connected yet. Start it on the station machine, then press Check again.'),
      Details('How to start it', h('p', { class: 'caption' }, 'In a terminal on the station machine (the station is at ' + d.station.url + '):'), copyable('systemctl --user start ' + ((app.company && app.company.station && app.company.station.serviceName) || 'capheos-station') + '.service')),
      h('div', { class: 'row-8' }, Button('Check again', { variant: 'secondary', onClick: load }))];
    const cd = d.candidateDefault || {};
    const cards = d.providers.map(p => p.how === 'signin' ? claudeCard(d, p) : keyCard(d, p));
    return [h('p', { class: 'body-s muted' }, 'Connect at least one. A subscription is the simplest: a flat fee, nothing billed per token. New hires interview on the one you pick' + (cd.provider ? ' (now ' + cd.provider + ' / ' + cd.model + ')' : '') + '.'),
      h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:14px' }, cards)];
  }
  const provHead = p => h('div', { class: 'between-c', style: 'gap:8px' }, h('span', { class: 'label strong' }, p.name),
    p.isDefault && p.ready ? Tag('In use', { variant: 'status', status: 'online' }) : p.ready ? Tag('Connected', { variant: 'status', status: 'online' }) : Tag(p.metered && !p.unmetered ? 'Pay per token' : 'Subscription', { variant: 'soft' }));
  function claudeCard(d, p) {
    const err = errP(); const c = d.station.claude || {};
    const box = h('article', { class: 'card p18', style: 'gap:10px' + (p.isDefault ? ';border-color:var(--status-online)' : '') }, provHead(p), h('p', { class: 'body-s muted' }, p.blurb));
    const use = Button(p.isDefault && p.ready ? 'In use for new hires' : 'Use my Claude subscription', { variant: 'primary', disabled: p.isDefault && p.ready,
      onClick: () => act(use, err, () => post('/setup/provider', { provider: 'claude-cli' }), r => 'New hires and the Founder now run on your Claude subscription.' + (r.founderLoop && !r.founderLoop.ok ? ' The Founder loop was not updated: ' + r.founderLoop.text : '')) });
    if (c.installed && c.loggedIn) {
      box.append(h('p', { class: 'body-s' }, 'Signed in' + (c.email ? ' as ' + c.email : '') + (c.subscription ? ' (' + c.subscription + ')' : '') + ' on the station machine.'), h('div', { class: 'row-8' }, use), err);
      return box;
    }
    if (c.installed === false) {
      box.append(h('p', { class: 'body-s' }, 'Claude Code is not installed on the station machine yet.'),
        Details('How to install it', h('p', { class: 'caption' }, 'In a terminal on the station machine, run:'), copyable('npm install -g @anthropic-ai/claude-code && claude auth login')), h('div', { class: 'row-8' }, Button('I have signed in — check', { variant: 'secondary', onClick: load })), err);
      return box;
    }
    const code = h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the code from the Claude page', 'aria-label': 'Sign-in code' });
    const flow = h('div', { class: 'stack-8' });
    const start = Button('Sign in with Claude', { variant: 'primary', onClick: async () => {
      err.textContent = ''; start.disabled = true;
      try {
        const r = await post('/station/auth/claude-cli/start', {});
        if (r.status === 'connected') { await finishClaude(err); return; }
        if (r.status !== 'pending') { err.textContent = r.error || 'The sign-in did not start.'; return; }
        stopLogin(); login = { id: r.login_id, url: r.url };
        login.timer = setInterval(async () => {
          try { const p2 = await post('/station/auth/claude-cli/poll', { login_id: login.id }); if (p2.status === 'connected') { stopLogin(); await finishClaude(err); } else if (p2.status === 'error') { stopLogin(); err.textContent = p2.error; } } catch (_) {}
        }, 2000);
        drawFlow();
      } catch (e) { err.textContent = humanError(e); }
      finally { start.disabled = false; }
    } });
    function drawFlow() {
      if (!login) return fill(flow);
      const send = Button('Send code', { variant: 'secondary', size: 'sm', onClick: async () => {
        if (!code.value.trim()) { err.textContent = 'Paste the code first.'; return; }
        try { const r = await post('/station/auth/claude-cli/code', { login_id: login.id, code: code.value.trim() }); code.value = ''; if (!r.ok) err.textContent = r.error || 'The code was not taken.'; else app.toast('Code sent. Finishing sign-in…'); } catch (e) { err.textContent = e.message; }
      } });
      fill(flow, h('ol', { class: 'stack-6 body-s', style: 'padding-left:18px' },
        h('li', null, login.url ? h('a', { href: login.url, target: '_blank', rel: 'noopener noreferrer', class: 'strong' }, 'Open the Claude sign-in page') : 'Claude is opening its sign-in page on the station machine.', ' and approve.'),
        h('li', null, 'If it shows a code, paste it here:'),
        h('li', { style: 'list-style:none;margin-left:-18px' }, h('div', { class: 'row-8' }, code, send)),
        h('li', null, 'This card turns green by itself once Claude says you are signed in.')),
        Button('Cancel sign-in', { variant: 'ghost', size: 'sm', onClick: async () => { const id = login && login.id; stopLogin(); fill(flow); try { await post('/station/auth/claude-cli/cancel', { login_id: id }); } catch (_) {} } }));
    }
    box.append(h('p', { class: 'body-s' }, 'Claude Code is installed on the station machine but not signed in.'), h('div', { class: 'row-8' }, start), flow,
      h('details', null, h('summary', { class: 'caption muted', style: 'cursor:pointer' }, 'Or sign in from a terminal on the station machine'),
        h('div', { class: 'stack-6', style: 'margin-top:6px' }, copyable('claude auth login'), Button('I have signed in — check', { variant: 'ghost', size: 'sm', onClick: load }))), err);
    drawFlow();
    return box;
  }
  async function finishClaude(err) {
    try { await post('/setup/provider', { provider: 'claude-cli' }); app.toast('Signed in. New hires now run on your Claude subscription.'); }
    catch (e) { err.textContent = humanError(e); }
    await load();
  }
  function stopLogin() { if (login && login.timer) clearInterval(login.timer); login = null; }
  function keyCard(d, p) {
    const err = errP(); const note = h('p', { class: 'caption', role: 'status' });
    const key = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: p.present ? 'A key is saved. Paste a new one to replace it' : 'Paste the API key', 'aria-label': p.name + ' API key' });
    const sub = p.id === 'custom' ? h('input', { type: 'checkbox', checked: true }) : null;
    // MiniMax: where the account is (company.json providers.minimax); switching it re-checks the key before saving
    const keyLink = p.keyUrl ? h('a', { href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Get a key →') : null;
    const ep = p.id === 'custom' ? endpointPicker({ endpoint: p.endpoint, getKey: () => key.value, showCurrent: p.ready, saveLabel: p.ready && !key.value ? 'Switch endpoint' : 'Connect', onChange: () => relabel() }) : null;
    const epBody = () => ep ? ep.value() : {};
    const validate = Button('Validate', { variant: 'secondary', size: 'sm', onClick: async () => {
      err.textContent = ''; note.textContent = 'Checking with ' + p.name + (ep ? ' (' + ep.label() + ')' : '') + '…'; validate.disabled = true;
      try { const r = await post('/setup/provider/validate', Object.assign({ provider: p.id, key: key.value }, epBody())); note.textContent = r.valid ? 'The key works' + (ep ? ' on ' + ep.label() : '') + '.' + (r.modelCount ? ' ' + r.modelCount + ' models available.' : '') : ''; if (!r.valid) err.textContent = 'Not accepted: ' + (r.error || 'unknown reason'); }
      catch (e) { note.textContent = ''; err.textContent = humanError(e); } finally { validate.disabled = false; }
    } });
    const switching = () => !!(ep && p.ready && ep.changed());
    const connect = Button(p.ready && !key.value ? (p.isDefault ? 'In use for new hires' : 'Use for new hires') : 'Connect', { variant: 'primary', size: 'sm', disabled: p.ready && p.isDefault, onClick: () => {
      if (!key.value.trim() && !p.ready) { err.textContent = 'Paste the API key first.'; return; }
      if (switching() && !key.value.trim()) {
        note.textContent = 'Checking your key on ' + ep.label() + ' before switching…';
        act(connect, err, () => post('/setup/provider', Object.assign({ provider: p.id, keepDefault: true }, epBody())), () => 'MiniMax now uses ' + ep.label() + '. The key was checked there first.', () => { note.textContent = ''; });
        return;
      }
      note.textContent = key.value ? 'Checking the key and saving it on the station…' : '';
      act(connect, err, () => post('/setup/provider', Object.assign({ provider: p.id, key: key.value, subscription: sub ? sub.checked : undefined }, epBody())), r => p.name + ' connected' + (ep ? ' (' + ep.label() + ')' : '') + '. New hires and the Founder run on ' + r.model + '.' + (r.runnable ? '' : ' Set a daily budget in step 3 so they can run.') + (r.founderLoop && !r.founderLoop.ok ? ' The Founder loop was not updated: ' + r.founderLoop.text : ''), () => { key.value = ''; note.textContent = ''; });
    } });
    function relabel() {
      if (ep && keyLink) keyLink.href = ep.keyUrl() || p.keyUrl;
      if (switching() && !key.value) { connect.disabled = false; connect.textContent = 'Switch endpoint'; return; }
      if (p.ready && p.isDefault) connect.disabled = !key.value; connect.textContent = key.value ? 'Connect' : p.isDefault ? 'In use for new hires' : 'Use for new hires';
    }
    key.addEventListener('input', relabel);
    return h('article', { class: 'card p18', style: 'gap:10px' + (p.isDefault && p.ready ? ';border-color:var(--status-online)' : ''), 'data-provider': p.id }, provHead(p),
      h('p', { class: 'body-s muted' }, p.blurb, ' ', keyLink),
      ep ? ep.el : null,
      key, sub ? h('label', { class: 'check body-s' }, sub, 'This is a Coding Plan (a flat-fee subscription)') : null,
      h('div', { class: 'row-8' }, validate, connect), note, err,
      h('span', { class: 'caption muted' }, 'The key goes straight to the station and is never shown again.'));
  }

  /* ---- 3. budget ---- */
  function stepBudget(d) {
    const err = errP(); const b = d.budget;
    const cur = BUDGETS.find(x => x.daily === b.dailyUsd && x.per === b.perAgentUsd);
    const custom = h('div', { class: 'row-8', style: 'align-items:flex-end;flex-wrap:wrap', hidden: !!cur && !keep.customBudget });
    const daily = h('input', { class: 'input', type: 'number', min: '0', step: '0.5', value: b.dailyUsd, style: 'width:120px' });
    const per = h('input', { class: 'input', type: 'number', min: '0', step: '0.5', value: b.perAgentUsd, style: 'width:120px' });
    const saveC = Button('Save', { variant: 'primary', size: 'sm', onClick: () => act(saveC, err, () => post('/setup/budget', { dailyUsd: Number(daily.value), perAgentUsd: Number(per.value || 0) }), 'Budget saved.') });
    custom.append(field('Daily cap (USD)', daily), field('Per crew member (USD)', per, '0 = no per-member limit'), saveC);
    const choose = x => act(null, err, () => post('/setup/budget', { dailyUsd: x.daily, perAgentUsd: x.per }), 'Budget: ' + x.label + '.', () => { keep.customBudget = false; });
    const metered = d.providers.filter(p => p.ready && p.metered).map(p => p.name);
    return [h('p', { class: 'body-s' }, 'Subscriptions (Claude, a MiniMax plan) are a flat fee and never count here. This cap is only for pay-per-token AI' +
        (metered.length ? ' (you have ' + metered.join(', ') + ' connected)' : ' (DeepSeek, OpenRouter, the Anthropic API)') + '. At $0, nothing pay-per-token runs at all. The per-member share stops one crew member from using up the whole day.'),
      h('div', { role: 'radiogroup', 'aria-label': 'Daily budget', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(170px,100%),1fr));gap:10px' },
        BUDGETS.map(x => h('button', { type: 'button', role: 'radio', class: 'choice', 'aria-checked': cur === x && !keep.customBudget ? 'true' : 'false', onclick: () => choose(x) }, h('span', { class: 'label' }, x.label), h('span', { class: 'caption' }, x.what))),
        h('button', { type: 'button', role: 'radio', class: 'choice', 'aria-checked': !cur || keep.customBudget ? 'true' : 'false', onclick: () => { keep.customBudget = true; custom.hidden = false; daily.focus(); } },
          h('span', { class: 'label' }, cur ? 'Custom' : 'Custom: $' + b.dailyUsd + ' a day'), h('span', { class: 'caption' }, cur ? 'Your own numbers.' : 'Up to $' + b.perAgentUsd + ' per member.'))),
      custom, err, b.setBy ? h('span', { class: 'caption muted' }, 'Last set by ' + b.setBy + (b.setAt ? ' on ' + String(b.setAt).slice(0, 10) : '') + '.') : null];
  }

  /* ---- 4. governance ---- */
  function stepGovernance(d) {
    const err = errP(); const g = d.governance;
    if (!g) return [h('p', { class: 'body-s muted' }, 'Could not read self-governance.'), h('a', { href: '#/settings/autonomy' }, 'Open Autonomy and guardrails →')];
    const pick = id => act(null, err, () => post('/governance/preset', { preset: id }), 'Preset saved.');
    return [h('p', { class: 'body-s muted' }, 'Pick how often the crew asks before it acts. You can fine-tune each kind of decision in Settings later.'),
      h('div', { role: 'radiogroup', 'aria-label': 'Preset', class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:10px' },
        (g.presets || []).map(p => h('button', { type: 'button', role: 'radio', class: 'choice', 'aria-checked': p.id === g.preset ? 'true' : 'false', onclick: () => pick(p.id) },
          h('span', { class: 'label' }, p.label), h('span', { class: 'caption' }, PRESET_WHAT[p.id] || '')))),
      h('div', { class: 'row-8', style: 'align-items:center' }, !g.chosen && (g.presets || []).some(p => p.id === g.preset) ? Button('Keep ' + g.presetLabel, { variant: 'secondary', size: 'sm', onClick: () => pick(g.preset) }) : null,
        h('a', { href: '#/settings/autonomy/presets', class: 'body-s' }, 'Per-decision settings in Settings →')), err];
  }

  /* ---- 5. charter ---- */
  // The charter as it stands (rendered), with three ways to change it: edit the text, ask the Founder (live chat), or
  // fill the four blanks in a short form. The step flips to Done by itself when no placeholder is left (SSE 'charter').
  const ceoId = () => (app.company && app.company.ceo && app.company.ceo.id) || 'agent';
  function draftWithFounder(notes) {
    ss.set('capheos.briefNotes', JSON.stringify(notes || {}));
    location.hash = '#/chat/agent:' + encodeURIComponent(ceoId()) + '?brief=charter';
  }
  function stepCharter(d) {
    const err = errP(); const c = d.charter; const cv = charter || { text: '', placeholders: c.placeholders || [] };
    const blanks = (cv.placeholders || []).length;
    const modes = h('div', { class: 'row-8', role: 'group', 'aria-label': 'Charter' },
      Button('Draft it with the Founder', { variant: blanks ? 'primary' : 'secondary', onClick: () => draftWithFounder(keepNotes()) }),
      blanks ? Button('Fill the blanks myself', { variant: 'secondary', onClick: () => { charterMode = 'form'; draw(); } }) : Button('Ask the Founder to change it', { variant: 'secondary', href: '#/chat/agent:' + encodeURIComponent(ceoId()) + '?brief=charter-change' }),
      Button('Edit the text', { variant: 'ghost', onClick: () => { charterMode = 'edit'; draw(); } }));
    const head = h('p', { class: 'body-s muted' }, 'The crew reads this before every decision. ' + (blanks ? blanks + ' blank' + (blanks > 1 ? 's' : '') + ' still to fill: ' + cv.placeholders.slice(0, 3).map(x => x.replace(/^<|>$/g, '').slice(0, 50)).join(' · ') + (blanks > 3 ? '…' : '') + '.' : 'No blanks left.') + (cv.at ? ' Last changed ' + new Date(cv.at).toLocaleString() + '.' : ''));
    if (charterMode === 'edit') {
      const t = h('textarea', { class: 'textarea mono-s', rows: '22', 'aria-label': 'Charter text' }); t.value = keep.charterText !== undefined ? keep.charterText : cv.text;
      t.addEventListener('input', () => { keep.charterText = t.value; });
      const save = Button('Save', { variant: 'primary', onClick: () => act(save, err, () => post('/setup/charter', { text: t.value }), r => (r.placeholders || []).length ? 'Saved. ' + r.placeholders.length + ' blank(s) left.' : 'Charter saved.', () => { delete keep.charterText; charterMode = 'view'; }) });
      return [head, t, h('div', { class: 'row-8' }, save, Button('Cancel', { variant: 'ghost', onClick: () => { delete keep.charterText; charterMode = 'view'; draw(); } })), err];
    }
    if (charterMode === 'form') return [head, charterForm(d, err), h('div', { class: 'row-8' }, Button('Back to the charter', { variant: 'ghost', onClick: () => { charterMode = 'view'; draw(); } }))];
    return [head, modes, cv.text ? h('div', { class: 'sunken charter-view', style: 'padding:16px 18px;max-height:520px;overflow:auto' }, mdBlock(cv.text)) : h('p', { class: 'body-s' }, 'There is no charter yet. Draft it with the Founder.'), err];
  }
  function keepNotes() { const c = (S && S.charter) || {}; const v = k => keep[k] !== undefined ? keep[k] : c[k] || ''; return { mandate: v('mandate'), forWhom: v('forWhom'), outOfScope: v('outOfScope'), firstGoal: v('firstGoal') }; }
  function charterForm(d, err) {
    const c = d.charter;
    const ta = (k, rows, ph) => { const t = h('textarea', { class: 'textarea', rows: String(rows), placeholder: ph }); t.value = keep[k] !== undefined ? keep[k] : c[k] || ''; t.addEventListener('input', () => { keep[k] = t.value; }); return t; };
    const mandate = ta('mandate', 3, 'We help independent bookshops run their online store: listings, orders and customer email.');
    const forWhom = ta('forWhom', 1, 'Independent bookshops in the UK');
    const out = ta('outOfScope', 2, 'No paid advertising, no handling of card payments, nothing that needs a licence.');
    const goal = ta('firstGoal', 2, 'A working stock and order tracker for one shop by the end of the month.');
    const save = Button('Save charter', { variant: 'primary', onClick: () => act(save, err, () => post('/setup/charter', { mandate: mandate.value, forWhom: forWhom.value, outOfScope: out.value, firstGoal: goal.value }), 'Charter saved.', () => { for (const k of ['mandate', 'forWhom', 'outOfScope', 'firstGoal']) delete keep[k]; charterMode = 'view'; }) });
    const draft = Button('Draft it with the Founder', { variant: 'secondary', onClick: () => draftWithFounder({ mandate: mandate.value, forWhom: forWhom.value, outOfScope: out.value, firstGoal: goal.value }) });
    return h('div', { class: 'stack-14' }, h('p', { class: 'body-s muted' }, 'A few sentences are enough.'),
      field('What the company does', mandate, 'Two to four sentences: the work, and how it creates value.'), field('For whom', forWhom), field('What it will not do', out, 'Work it turns down even when asked.'), field('First goal', goal),
      h('div', { class: 'row-8' }, save, draft), err);
  }

  /* ---- 6. guardrails ---- */
  function stepGuardrails(d) {
    const err = errP(); const g = d.guardrails;
    if (!g) return [h('p', { class: 'body-s muted' }, 'Could not read the guardrails.'), h('a', { href: '#/settings/autonomy/guardrails' }, 'Open Autonomy and guardrails →')];
    return [h('p', { class: 'body-s muted' }, 'Hard stops the crew cannot get past, whatever it decides. They start on; leave them on unless you know why.'),
      h('ul', { class: 'plain' }, g.guards.map(x => h('li', { class: 'sys-row', style: 'align-items:flex-start' },
        h('span', { class: 'stack-4', style: 'gap:2px' }, h('span', { class: 'strong' }, GUARD_NAMES[x.name] || x.name), h('span', { class: 'caption muted' }, String(x.blocks || '').split(' Off:')[0])),
        Tag(x.on ? 'On' : 'Off', { variant: 'status', status: x.on ? 'online' : 'danger' })))),
      h('div', { class: 'sunken stack-8', style: 'padding:14px 16px' },
        h('div', { class: 'between-c', style: 'gap:12px' }, h('span', { class: 'label strong' }, 'This station runs in a throwaway container or VM'),
          h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-checked': g.sandbox ? 'true' : 'false', 'aria-label': 'Sandboxed station', onclick: () => act(null, err, () => post('/guardrails/sandbox', { on: !g.sandbox }), g.sandbox ? 'Sandbox mark removed.' : 'Marked as sandboxed.') }, h('span', { class: 'knob' }))),
        h('span', { class: 'caption muted' }, 'Your statement, not a setting: it changes nothing on its own. It only records that switching guardrails off here would hurt nothing you care about. Leave it off on your own computer.')),
      h('a', { href: '#/settings/autonomy/guardrails', class: 'body-s' }, 'Switch guardrails in Settings →'), err];
  }

  /* ---- 7. certify ---- */
  const FIX = { charter: 'charter', guardrails: 'guardrails', station: 'provider' };
  const FIX_ROUTE = { charter: '#/settings/company/charter', guardrails: '#/settings/autonomy/guardrails', provider: '#/settings/models/providers' };
  // inside this page when the step is here (the wizard), else the Settings place that holds it
  function fixLink(d, step) {
    const i = d.steps.findIndex(s => s.id === step);
    if (i < 0) return h('a', { href: FIX_ROUTE[step] || '#/settings', class: 'body-s' }, 'Fix it →');
    return h('a', { href: '#step-' + step, class: 'body-s', onclick: e => { e.preventDefault(); open.add(step); draw(); document.getElementById('step-' + step).scrollIntoView({ behavior: 'smooth' }); } }, embedded ? 'Fix it above →' : 'Fix it in step ' + (i + 1) + ' →');
  }
  function stepCertify(d) {
    const err = errP(); const note = h('p', { class: 'caption muted', role: 'status' });
    const runB = Button(d.lastCertify ? 'Run the checks again' : 'Run the checks', { variant: 'primary', onClick: async () => {
      note.textContent = 'Running the checks. This can take a minute…';
      const r = await act(runB, err, () => post('/onboarding/certify'), r => r.certified ? 'Certified: your company is ready.' : 'Not ready yet: see what is left.');
      note.textContent = '';
      if (r && r.certified) window.scrollTo({ top: 0, behavior: 'smooth' });
    } });
    const cmdOf = t => { const m = /((?:node|systemctl|bash|scripts\/)[^:;()]*?)(?=$|;|\s\(|:)/.exec(String(t || '')); return m ? m[1].trim() : null; };
    const rows = d.checks.length ? h('ul', { class: 'plain' }, d.checks.map(c => h('li', { class: 'sys-row', style: 'align-items:flex-start;gap:12px' },
      h('span', { class: 'stack-6', style: 'min-width:0;flex:1' }, h('span', { class: 'strong' }, CHECK_NAMES[c.id] || c.id.replace(/[-_]/g, ' ').replace(/^./, x => x.toUpperCase())),
        c.ok ? null : h('span', { class: 'body-s' }, 'Not yet.'),
        !c.ok && FIX[c.id] ? fixLink(d, FIX[c.id]) : null,
        !c.ok ? Details('Details', h('span', { class: 'caption' }, c.id + ': ' + (c.missing || 'failed')), cmdOf(c.missing) ? copyable(cmdOf(c.missing)) : null) : null),
      Tag(c.ok ? 'Passed' : 'Failed', { variant: 'status', status: c.ok ? 'online' : 'danger' })))) : h('p', { class: 'body-s muted' }, 'Not run yet.');
    return [h('p', { class: 'body-s muted' }, 'Eleven checks that prove the company can actually run: the station answers, the dispatcher ticks, guardrails are applied, secrets are in place, backups verify, the charter is filled, the Founder loop is in place, and so on.'),
      h('div', { class: 'row-8', style: 'align-items:center' }, runB, note), rows, err];
  }

  /* ---- what onboarding asked that the steps do not cover ---- */
  function drawExtra(d) {
    const qs = d.onboardingQuestions || [];
    if (!qs.length) return fill(extraEl);
    fill(extraEl, h('section', { class: 'stack-14' }, h('h2', { class: 'h3' }, 'Also asked during onboarding'),
      h('p', { class: 'body-s muted' }, 'The steps above settle the AI provider question by themselves. Anything else onboarding needs is here; answer in your own words.'),
      qs.map(q => {
        const err = errP(); const ta = h('textarea', { class: 'textarea', rows: '2', placeholder: 'Your answer' });
        const lines = String(q.q || '').split('\n').filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, ''));
        const send = Button('Send answer', { variant: 'secondary', size: 'sm', onClick: () => { if (!ta.value.trim()) { err.textContent = 'Write an answer first.'; return; } act(send, err, () => post('/questions/' + encodeURIComponent(q.id) + '/answer', { verdict: 'reply', text: ta.value.trim() }), 'Answer recorded.'); } });
        return h('article', { class: 'card p18', style: 'gap:10px' }, h('span', { class: 'caption muted' }, 'Asked ' + (q.askedAt ? new Date(q.askedAt).toLocaleDateString() : 'during onboarding')),
          h('ul', { class: 'stack-6 body-s', style: 'padding-left:18px' }, (lines.length ? lines : [q.q]).map(l => h('li', null, l))), ta, h('div', { class: 'row-8' }, send), err);
      })));
  }

  load();
  const off = events.on(['questions', 'governance', 'guardrails', 'charter'], () => { if (!login && charterMode !== 'edit') load(); });
  return () => { off(); stopLogin(); };
}
