// A request with several questions (company/tools/inbox.js `questions`): one card, a numbered sub-card per question.
// The owner answers each on its own: picking a button marks that question's answer, "Send N answered" sends the ones
// picked so far, and the request stays on Today until every required question is answered or the owner closes the rest
// (those are recorded as skipped). A key question is stored at once by its Store button (the value never waits in
// the page). An untyped question the console reshaped (q.inferred) and the follow-up of one that was closed by a key
// alone (q.followUp) show their full text open, so no part of what was asked is hidden.
import { h, fill, Button, Tag, rel, humanError } from '../ui.js';
import { mdBlock } from '../md.js';

export function requestCard(q, fresh, d) {
  const { fieldControl, post, app, reload, picks, freshIds, seat, questionText, parseQuestion, looksLikeKeyText, snoozeUntil, whenLabel, tz } = d;
  const p = parseQuestion(q); const qt = questionText(q);
  const mine = picks[q.id] = picks[q.id] || {};
  const errEl = h('p', { class: 'err-line', role: 'status' });
  const url = '/questions/' + encodeURIComponent(q.id) + '/answer';
  const total = q.questions.length;
  const answeredN = q.questions.filter(x => x.answered).length;
  const progress = h('span', { class: 'caption muted', 'data-progress': answeredN + '/' + total });
  const sendBtn = Button('Send', { variant: 'primary', size: 'sm', onClick: () => send(false) });
  const subs = [];
  const update = () => {
    const picked = subs.filter(s => mine[s.p.id]).length;
    progress.textContent = answeredN + ' of ' + total + ' answered' + (picked ? ' · ' + picked + ' picked, not sent yet' : '');
    sendBtn.textContent = picked ? 'Send ' + picked + ' answered' : 'Send';
    sendBtn.disabled = !picked;
    for (const s of subs) for (const [aid, b] of Object.entries(s.buttons)) { const on = mine[s.p.id] === aid; b.classList.toggle('btn-primary', on); b.classList.toggle('btn-secondary', !on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  };
  const bodyOf = (s, aid) => {
    const values = {}; const replace = {}; const secretNames = {};
    for (const c of s.controls) {
      if (!c.get) continue;
      const v = c.get(); if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) values[c.f.id] = v;
      if (c.replace && c.replace()) replace[c.f.id] = true;
      if (c.name) secretNames[c.f.id] = c.name();
    }
    const act = s.p.form.actions.find(a => a.id === aid);
    if (act && act.needs === 'none') for (const c of s.controls) if (c.f.type === 'secret') delete values[c.f.id];
    const out = { action: aid, values };
    if (Object.keys(replace).length) out.replace = replace; if (Object.keys(secretNames).length) out.secretNames = secretNames;
    return out;
  };
  const busy = on => card.querySelectorAll('button, input, textarea, select').forEach(b => { b.disabled = on; });
  async function postParts(parts, closeRest, okText) {
    errEl.textContent = ''; busy(true);
    try {
      const r = await post(url, Object.assign({ parts }, closeRest ? { closeRest: true } : {}));
      for (const pid of Object.keys(parts)) delete mine[pid];
      if (r.state === 'answered') { delete picks[q.id]; freshIds.delete(q.id); }
      app.toast(okText || (r.state === 'answered' ? 'All answered. ' + (q.from || 'The asker') + ' has every answer.' : r.answered + ' of ' + r.total + ' answered. The rest stay here.'));
      reload(); return r;
    } catch (e) { errEl.textContent = 'Not recorded: ' + humanError(e); busy(false); update(); }
  }
  function send(closeRest) {
    const parts = {};
    for (const s of subs) if (mine[s.p.id]) parts[s.p.id] = bodyOf(s, mine[s.p.id]);
    for (const v of Object.values(parts)) for (const x of Object.values(v.values)) if (typeof x === 'string' && looksLikeKeyText(x)) { errEl.textContent = 'This looks like a key. Use a key question\'s secure field instead.'; return; }
    if (!Object.keys(parts).length && !closeRest) { errEl.textContent = 'Pick an answer for at least one question first.'; return; }
    return postParts(parts, closeRest);
  }
  q.questions.forEach((qp, i) => {
    const head = h('div', { class: 'row-8', style: 'align-items:baseline' }, h('span', { class: 'q-num mono strong', 'aria-hidden': 'true' }, (i + 1) + '.'),
      h('div', { style: 'flex:1;min-width:0' }, mdBlock(qp.prompt, 'body-s q-prompt')), qp.required === false ? h('span', { class: 'caption muted' }, 'optional') : null);
    if (qp.answered) {
      subs.push({ p: qp, controls: [], buttons: {} });
      return void (subs[subs.length - 1].el = h('section', { class: 'q-part answered', 'data-part': qp.id, 'aria-label': 'Question ' + (i + 1) + ', answered' }, head,
        h('p', { class: 'caption muted', style: 'margin-left:24px' }, h('span', { class: 'strong' }, 'Answered ✓ '), String(qp.answered.a || '').slice(0, 300))));
    }
    const isKey = qp.form.fields.some(f => f.type === 'secret');
    const pq = Object.assign({}, q, { id: q.id + '-' + qp.id });
    const s = { p: qp, buttons: {} };
    // a key question: Store answers THAT question now (the request stays open while others are left)
    const storeAct = isKey ? qp.form.actions.find(a => a.verdict === 'done') : null;
    s.controls = qp.form.fields.filter(f => f.id !== 'note' || !isKey).map(f => fieldControl(pq, f, f.type === 'secret' && storeAct ? { onStore: async () => {
      const r = await post(url, { parts: { [qp.id]: bodyOf(s, storeAct.id) } });
      app.toast(r.state === 'answered' ? 'Key stored. That was the last question.' : 'Key stored. ' + (r.total - r.answered) + ' question' + (r.total - r.answered === 1 ? '' : 's') + ' still need' + (r.total - r.answered === 1 ? 's' : '') + ' you.');
      reload(); return (r.stored || [])[0];
    } } : null));
    const acts = qp.form.actions.filter(a => a !== storeAct);
    for (const a of acts) s.buttons[a.id] = Button(a.label, { variant: 'secondary', size: 'sm', onClick: () => { mine[qp.id] = mine[qp.id] === a.id ? undefined : a.id; if (!mine[qp.id]) delete mine[qp.id]; update(); } });
    s.el = h('section', { class: 'q-part', 'data-part': qp.id, 'aria-label': 'Question ' + (i + 1) }, head,
      s.controls.length ? h('div', { class: 'stack-8 q-form', style: 'margin-left:24px' }, s.controls.map(c => c.el)) : null,
      acts.length ? h('div', { class: 'row-8', style: 'margin-left:24px' }, acts.map(a => s.buttons[a.id])) : null);
    subs.push(s);
  });
  // Reply (to the request as a whole), Snooze, Discuss: as on every card
  let replying = false;
  const ta = h('textarea', { rows: '6', class: 'textarea', placeholder: 'Write as much as you need…', 'aria-label': 'Your reply to ' + (q.from || 'the asker'), hidden: true });
  const snoozeMenu = h('div', { class: 'row-8 snooze-menu', hidden: true },
    [['In an hour', 'hour'], ['Tomorrow morning', 'tomorrow'], ['Next week', 'week']].map(([label, k]) => Button(label, { variant: 'ghost', size: 'sm', onClick: async () => {
      const until = snoozeUntil(k);
      try { await post('/questions/' + encodeURIComponent(q.id) + '/snooze', { until: until.toISOString() }); app.toast('Snoozed until ' + whenLabel(until.toISOString(), tz) + '.'); reload(); }
      catch (e) { errEl.textContent = 'Not snoozed: ' + humanError(e); }
    } })));
  const quote = qt.message.split('\n').map(l => '> ' + l).join('\n').slice(0, 600);
  const openText = !!(q.inferred || q.followUp);
  const card = h('article', { class: 'gate request' + (fresh ? ' fresh' : ''), 'data-id': q.id, 'data-kind': 'multi', 'aria-labelledby': 'g-' + q.id },
    h('div', { class: 'between-c' },
      h('span', { class: 'row-8', style: 'align-items:center' }, Tag(p.cat, { variant: 'accent' }), Tag(total + ' questions', { variant: 'soft' }), fresh ? h('span', { class: 'just-now' }, 'Just now') : null),
      h('span', { class: 'mono muted' }, [q.from, q.id, rel(q.askedAt)].filter(Boolean).join(' · '))),
    q.followUp ? h('p', { class: 'q-followup strong', role: 'note', style: 'border-left:3px solid var(--status-warning);padding-left:10px' }, q.followUp.note) : null,
    h('div', { id: 'g-' + q.id, class: 'q-message' }, mdBlock(qt.message, 'body q-msg')),
    qt.details ? h('details', { class: 'q-details', open: openText }, h('summary', { class: 'caption muted' }, openText ? 'The full request' : 'More detail'), mdBlock(qt.details, 'body-s q-body')) : null,
    q.inferred ? h('p', { class: 'caption muted' }, 'This came without a form, so each decision it lists is its own question below. Answer each one; nothing is decided for the rest.') : null,
    h('ol', { class: 'plain stack-12 q-parts', style: 'border-left:2px solid var(--border-hairline);padding-left:12px' }, subs.map(s => h('li', null, s.el))),
    progress,
    h('label', { class: 'stack-6' }, ta),
    h('div', { class: 'row-8', style: 'margin-top:auto;flex-wrap:wrap' },
      sendBtn,
      Button('Close the rest', { variant: 'ghost', size: 'sm', aria: 'Send what is picked and close the questions left unanswered (recorded as skipped)', onClick: () => send(true) }),
      Button('Reply', { variant: 'ghost', size: 'sm', onClick: () => {
        if (!replying) { replying = true; ta.hidden = false; ta.focus(); return; }
        const text = ta.value.trim(); if (!text) { errEl.textContent = 'Write a reply first.'; return; }
        if (looksLikeKeyText(text)) { errEl.textContent = 'This looks like a key. Use the secure field instead.'; return; }
        busy(true); post(url, { verdict: 'reply', text }).then(() => { delete picks[q.id]; app.toast('Reply sent.'); reload(); }, e => { errEl.textContent = 'Not recorded: ' + humanError(e); busy(false); });
      } }),
      Button('Snooze', { variant: 'ghost', size: 'sm', aria: 'Ask me later', onClick: () => { snoozeMenu.hidden = !snoozeMenu.hidden; } }),
      Button('Discuss', { variant: 'ghost', size: 'sm', href: '#/chat/agent:' + encodeURIComponent(seat) + '?draft=' + encodeURIComponent(quote + '\n\nAbout ' + q.id + ': ') })),
    snoozeMenu, errEl);
  update();
  return card;
}
