// Chat actions (docs/CHAT-ACTIONS.md): an agent's ```actions block as controls, built from Today's own field
// components (screens/today.js fieldControl), so a choice, a text or URL field, a slider and a key field look and behave
// as they do on Today. What a click can do, and nothing else:
//   a reply button or field  -> ctx.send(text): the owner's next message in the same chat ("Chose: …" + actionReply line)
//   a link                   -> navigates (console:#/…) or opens a new tab (https), the md.js allowlist
//   a secret field           -> POST /api/chat-actions/secret (the key store); the reply says "Stored <name> (N chars)"
//   an approval              -> GET/POST /api/approvals/<id>[/answer]: an EXISTING record, answered through the approval
//                               API (digest, CAS, surface "chat"); a fixed gate or an older record links to Needs you
// No click runs a command or calls a tool. State: answered (locked, shows the choice), superseded or older than
// MAX_AGE_HOURS (expired), from the transcript on reload.
import { h, fill, Button, humanError, when } from './ui.js';
import { api, post } from './api.js';
import { mdBlock, safeHref } from './md.js';
import { fieldControl, looksLikeKeyText } from './screens/today.js';
import { replyFor, isStale, MAX_AGE_HOURS } from './actions-schema.js';

// ctx: { send(text, shown) -> Promise<bool>, state: {answered?, superseded?}, at, who, tz, app, registry: Map }
export function actionsBlock(block, ctx) {
  const st = ctx.state || {};
  const el = h('div', { class: 'chat-actions', 'data-actions-id': block.id, role: 'group', 'aria-label': block.prompt || 'Choices from ' + (ctx.who || 'the agent') });
  if (block.items.some(i => i.type === 'approval')) return approvalsBlock(block, ctx, el);
  const errEl = h('p', { class: 'err-line', role: 'status' });
  const q = { id: 'ca-' + block.id.replace(/[^A-Za-z0-9_-]/g, '_'), from: ctx.who || 'the agent' };
  const fields = []; const buttons = [];
  const spec = it => it.type === 'choice' ? { id: it.id, type: 'choice', label: it.label, help: it.help, options: it.options, required: true }
    : it.type === 'slider' ? { id: it.id, type: 'slider', label: it.label, help: it.help, min: it.min, max: it.max, step: it.step, value: it.value, unit: it.unit, minLabel: it.minLabel, maxLabel: it.maxLabel, required: true }
    : it.type === 'secret' ? { id: it.id, type: 'secret', label: it.label, help: it.help, name: it.name, provider: it.provider, required: true }
    : { id: it.id, type: it.type, label: it.label, help: it.help, placeholder: it.placeholder, maxLength: it.maxLength, required: true };
  const parts = block.items.map(it => {
    if (it.type === 'link') {
      const s = safeHref(it.href); if (!s) return h('span', { class: 'caption muted' }, it.label);
      return s.inApp ? h('a', { class: 'btn btn-secondary btn-sm chat-action-link', href: s.href }, it.label + ' →') : h('a', { class: 'btn btn-secondary btn-sm chat-action-link', href: s.href, target: '_blank', rel: 'noopener noreferrer' }, it.label + ' ↗');
    }
    if (it.type === 'button') { const b = Button(it.label, { variant: it.tone === 'primary' ? 'primary' : it.tone === 'danger' ? 'danger' : 'secondary', size: 'sm', onClick: () => reply({ button: it }) }); b.dataset.value = String(it.value); buttons.push(b); return b; }
    const c = fieldControl(q, spec(it), it.type === 'secret' ? { onStore: (v, rep) => storeSecret(it, v, rep) } : null);
    fields.push({ it, c }); return c.el;
  });
  const hasSecret = fields.some(f => f.it.type === 'secret');
  const sendBtn = fields.length && !buttons.length && !hasSecret ? Button('Send', { variant: 'primary', size: 'sm', onClick: () => reply({}) }) : null;
  const status = h('p', { class: 'caption chat-actions-state', role: 'status' });
  fill(el, block.prompt ? mdBlock(block.prompt, 'body-s') : null,
    h('div', { class: 'stack-8 chat-actions-fields' }, parts.filter((p, i) => block.items[i].type !== 'button' && block.items[i].type !== 'link')),
    h('div', { class: 'row-8 chat-actions-row', style: 'flex-wrap:wrap' }, parts.filter((p, i) => block.items[i].type === 'button' || block.items[i].type === 'link'), sendBtn),
    status, errEl);

  const controls = () => el.querySelectorAll('button, input, textarea, select');
  function lock(state, text) {
    el.dataset.state = state; controls().forEach(c => { c.disabled = true; });
    el.querySelectorAll('a.chat-action-link').forEach(a => a.setAttribute('aria-disabled', state === 'answered' ? 'false' : 'true'));
    status.textContent = text; status.className = 'caption chat-actions-state ' + (state === 'answered' ? 'strong' : 'muted');
  }
  async function reply(pick) {
    errEl.textContent = '';
    const values = {};
    for (const f of fields) {
      if (f.it.type === 'secret') continue;
      const v = f.c.get(); if (v === undefined || v === '') { errEl.textContent = f.it.label + ': ' + (f.it.type === 'url' ? 'a web address starting with https://' : 'fill it in'); return; }
      if (typeof v === 'string' && looksLikeKeyText(v)) { errEl.textContent = 'This looks like a key. Keys go in a secure field, never in a message.'; return; }
      values[f.it.id] = v;
    }
    const r = replyFor(block, { button: pick.button, fields: values });
    return finish(r);
  }
  async function storeSecret(it, value, rep) {
    const r = await post('/chat-actions/secret', { name: it.name, value, replace: !!rep });
    const rr = replyFor(block, { stored: { name: r.name, chars: r.chars } });
    await finish(rr);
    return { stored: r.stored, chars: r.chars };
  }
  async function finish(r) {
    controls().forEach(c => { c.disabled = true; });
    let ok = false; try { ok = await ctx.send(r.text, r.shown); } catch (e) { errEl.textContent = 'Not sent: ' + humanError(e); }
    if (ok === false) { controls().forEach(c => { c.disabled = false; }); return; }
    lock('answered', 'Answered: ' + r.shown);
  }
  if (st.answered) lock('answered', 'Answered: ' + (st.answered.shown || 'replied'));
  else if (st.superseded) lock('expired', 'Expired: a newer set of these choices is below.');
  else if (isStale(ctx.at)) lock('expired', 'Expired: older than ' + MAX_AGE_HOURS + ' hours. Ask ' + (ctx.who || 'the agent') + ' again if you still need it.');
  // a newer block with the same id supersedes this one, also when it arrives live
  if (ctx.registry && !st.answered) {
    const prev = ctx.registry.get(block.id);
    if (prev && prev !== el && prev.isConnected && prev.dataset.state !== 'answered') prev.dispatchEvent(new CustomEvent('ca-supersede'));
    ctx.registry.set(block.id, el);
  }
  el.addEventListener('ca-supersede', () => { if (el.dataset.state !== 'answered') lock('expired', 'Expired: a newer set of these choices is below.'); });
  return el;
}

/* ---------- approvals: an existing record, read from the approval API ---------- */
function approvalsBlock(block, ctx, el) {
  const links = block.items.filter(i => i.type === 'link').map(it => { const s = safeHref(it.href); return s ? h('a', Object.assign({ class: 'btn btn-secondary btn-sm chat-action-link', href: s.href }, s.inApp ? {} : { target: '_blank', rel: 'noopener noreferrer' }), it.label) : null; });
  fill(el, block.prompt ? mdBlock(block.prompt, 'body-s') : null, block.items.filter(i => i.type === 'approval').map(it => approvalCard(it, ctx)), links.length ? h('div', { class: 'row-8' }, links) : null);
  el.classList.add('has-approval');
  return el;
}
const NEEDS = 'Open Needs you';
function approvalCard(it, ctx) {
  const card = h('section', { class: 'company-approval', 'data-ref': it.ref, 'aria-label': 'Company approval ' + it.ref },
    h('span', { class: 'approval-prov caption strong' }, 'Company approval · recorded in decisions'), h('p', { class: 'caption muted' }, 'Loading ' + it.ref + '…'));
  const draw = async () => {
    let r;
    try { r = await api('/approvals/' + encodeURIComponent(it.ref)); }
    catch (e) {
      // a block naming no existing record is inert: text, no control (a block never creates an approval)
      card.dataset.state = 'inert';
      return fill(card, h('span', { class: 'approval-prov caption strong' }, 'Company approval · recorded in decisions'),
        h('p', { class: 'body-s' }, (it.label ? it.label + ': ' : '') + 'there is no approval ' + it.ref + ' on file, so there is nothing to answer here.'), h('p', { class: 'caption muted' }, e.status === 404 ? 'Approvals are asked for through the company\'s records and appear on Today › Needs you.' : 'Not loaded: ' + humanError(e)));
    }
    card.dataset.state = r.status; card.dataset.digest = r.actionDigest || '';
    const head = [h('span', { class: 'approval-prov caption strong' }, 'Company approval · recorded in decisions'),
      h('p', { class: 'body-s strong' }, it.label || r.message), it.label ? h('p', { class: 'caption' }, r.message) : null,
      r.params ? h('p', { class: 'mono-s approval-params' }, Object.entries(r.params).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' · ')) : null,
      h('p', { class: 'caption muted' }, 'Asked by ' + r.from + ' · ' + r.id + (r.category ? ' · ' + r.category : ''))];
    const expiry = h('p', { class: 'caption approval-expiry' }, r.expiresAt ? 'expires ' + when(r.expiresAt, ctx.tz) + ' · default: deny' : 'no expiry · default: deny');
    if (r.status !== 'pending') {
      const words = { approved: 'Approved', denied: 'Denied', expired: 'Expired: the default (deny) applied', withdrawn: 'Withdrawn by ' + (r.answer && r.answer.by) }[r.status] || r.status;
      return fill(card, head, h('p', { class: 'label strong approval-done' }, words + (r.answer && r.answer.surface && r.status !== 'withdrawn' ? ' · via ' + r.answer.surface : '') + (r.answer && r.answer.at ? ' · ' + when(r.answer.at, ctx.tz) : '')));
    }
    if (!r.chatAnswerable) {
      const why = r.fixed ? r.authority.why : r.suppressed ? 'It waits on ' + r.suppressed.by + ': that one is answered first.' : 'This is an older record without an action digest, so it is answered on Needs you, not in chat.';
      return fill(card, head, expiry, h('p', { class: 'caption approval-route' }, why), h('a', { class: 'btn btn-primary btn-sm', href: '#/today' }, NEEDS + ' →'));
    }
    const err = h('p', { class: 'err-line', role: 'status' });
    const answer = async verdict => {
      card.querySelectorAll('button').forEach(b => { b.disabled = true; }); err.textContent = '';
      try { await post('/approvals/' + encodeURIComponent(r.id) + '/answer', { verdict, shownDigest: r.actionDigest, surface: 'chat' }); if (ctx.app) ctx.app.toast(verdict === 'yes' ? 'Approved. Recorded in decisions; ' + r.from + ' is told.' : 'Denied. Recorded in decisions; ' + r.from + ' is told.'); }
      catch (e) { err.textContent = 'Not recorded: ' + humanError(e); }
      draw();
    };
    fill(card, head, expiry,
      h('div', { class: 'row-8' }, Button('Approve', { variant: 'primary', size: 'sm', onClick: () => answer('yes') }), Button('Deny', { variant: 'secondary', size: 'sm', onClick: () => answer('no') }), h('a', { class: 'link-btn caption', href: '#/today' }, 'or on Needs you')), err);
  };
  draw();
  return card;
}
