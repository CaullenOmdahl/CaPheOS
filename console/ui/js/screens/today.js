// Today (Main.dc.html): Now (who is running, the current step, Watch, Stop; each seat's next wake), Needs you (live: only
// what still needs the owner, console/owner-needs.js), The crew is handling (read only), What the crew did today (the
// daily digest), crew, AI usage, company panels, recent activity, and the box that opens a live chat with the Founder.
import { h, fill, Button, Tag, Eyebrow, errLine, empty, initial, rel, when, statusOf, isSetupQuestion, humanError, Details } from '../ui.js';
import { category, personName, usageLine, railLine, sprintSummary, seatState, leadLine } from '../plain.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { mdBlock } from '../md.js';
import { idleLine } from '../idle-line.js';
import { requestCard } from './today-requests.js';
import { endpointPicker, loadEndpoint } from '../minimax-endpoint.js';
import { meetingStrip } from '../meeting-strip.js';

const ss = { set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (_) {} } };
const dur = sec => sec == null ? '' : sec < 60 ? sec + ' s' : sec < 3600 ? Math.floor(sec / 60) + ' min' : Math.floor(sec / 3600) + ' h ' + Math.floor(sec % 3600 / 60) + ' min';

const seen = new Set(); const freshIds = new Set(); let firstLoad = true; // question ids seen this page session, for "Just now"

export function parseQuestion(q) {
  const lines = String(q.q || '').split('\n').map(s => s.trim()).filter(Boolean);
  let rec = '', dflt = ''; const rest = [];
  for (const l of lines) {
    const r = /^Recommendation(?: from ([^:]+))?:\s*(.*)$/i.exec(l);
    const d = /^If you do not answer:\s*(.*)$/i.exec(l);
    if (r) rec = r[2]; else if (d) dflt = d[1]; else if (!/^Reply yes or no/i.test(l) && !(q.gate && q.gate.summary && /^Approval needed \(/i.test(l))) rest.push(l);
  }
  const g = q.gate || {};
  let title = g.summary || rest.shift() || q.id;
  title = title.replace(/^Approval needed \([^)]*\):\s*/i, '');
  return { title, why: rest.join('\n'), rec, dflt, cat: category(q) };
}

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-48';
  const co = app.company || {};
  const ownerName = co.owner && (co.owner.name || co.owner.first || co.owner) || '';
  const ceoId = (co.ceo && co.ceo.id) || 'agent';
  const ceoName = personName(co.ceo && co.ceo.name) || 'the Founder';
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  let dateLabel = ''; try { dateLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: co.timezone || undefined }).format(new Date()); } catch (_) { dateLabel = new Date().toDateString(); }

  const lede = h('p', { class: 'lede' }, '');
  // the box opens a LIVE chat with the Founder and sends the message there (js/chat.js): the reply streams in
  const askInput = h('input', { id: 'ask', type: 'text', class: 'input', placeholder: 'Ask ' + ceoName + ' something…', autocomplete: 'off' });
  const askErr = h('p', { class: 'err-line', role: 'status' });
  const askForm = h('form', { class: 'ask-form', 'aria-label': 'Message ' + ceoName, onsubmit: e => {
    e.preventDefault(); const text = askInput.value.trim(); if (!text) return;
    ss.set('capheos.chatSend', JSON.stringify({ agentId: ceoId, text }));
    location.hash = '#/chat/agent:' + encodeURIComponent(ceoId);
  } }, h('label', { for: 'ask', class: 'sr-only' }, 'Message ' + ceoName), askInput, Button('Send', { variant: 'primary', type: 'submit' }), askErr);
  const nowEl = h('section', { class: 'stack-12', 'aria-labelledby': 'now-h', 'aria-live': 'polite' });

  const onboardEl = h('div'); const meetEl = h('div');
  const liveDot = h('span', { class: 'live-dot' + (events.isLive() ? '' : ' off') }, events.isLive() ? 'Live' : 'Polling');
  const needsErr = h('div');
  const gatesEl = h('div', { class: 'gates', 'aria-live': 'polite', 'aria-relevant': 'additions removals' });
  const allClear = h('div');
  const answeredEl = h('div');
  const snoozedEl = h('div');
  const handlingEl = h('div');   // The crew is handling: open cards the owner's settings or rulings leave to the crew (read only)
  const digestEl = h('section', { class: 'stack-12', 'aria-labelledby': 'digest-h' });
  const crewEl = h('div'); const usageEl = h('div'); const panelsEl = h('div', { class: 'stack-24' }); const overnightEl = h('div');

  fill(root,
    h('header', { class: 'screen-head', style: 'gap:24px' },
      h('div', { class: 'stack-14', style: 'max-width:720px' }, Eyebrow([dateLabel, co.name]),
        h('h1', { class: 'h1' }, greet + (ownerName ? ', ' + personName(String(ownerName).split(' ')[0]) : '') + '.'), lede),
      askForm),
    onboardEl, meetEl, nowEl,
    h('section', { 'aria-labelledby': 'needs', class: 'stack-16' },
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'row-8', style: 'align-items:center;gap:12px' }, h('h2', { id: 'needs', class: 'h3' }, 'Needs you'), liveDot),
        h('span', { class: 'caption muted' }, 'Questions land here the moment they are asked. Your self-governance settings decide which ones come to you.')),
      needsErr, allClear, gatesEl, snoozedEl, answeredEl, handlingEl),
    digestEl,
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:32px' },
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Crew right now'), h('a', { href: '#/crew', class: 'body-s' }, 'All crew →')), crewEl),
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'AI usage today'), h('a', { href: '#/spend', class: 'body-s' }, 'Spend →')), usageEl)),
    panelsEl,
    h('section', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Recent activity'), h('a', { href: '#/work', class: 'body-s' }, 'All work →')), overnightEl));

  // Setup banner: shown until onboard.js --certify is green, or while onboarding still asks something. Onboarding
  // questions are answered in Setup (#/setup, Settings › Company once certified), never as an Approve/Decline card here.
  async function loadOnboarding() {
    let d; try { d = await api('/setup'); } catch (_) { fill(onboardEl); return; }
    const asks = (d.onboardingQuestions || []).length;
    if (d.certified && !asks) return fill(onboardEl);
    const next = (d.steps || []).find(s => s.status === 'needs');
    fill(onboardEl, h('section', { class: 'card p22', role: 'status', style: 'border-color:var(--status-warning);gap:10px' },
      h('div', { class: 'between-c', style: 'gap:12px;flex-wrap:wrap' },
        h('div', { class: 'stack-4' }, h('h2', { class: 'h4' }, d.certified ? 'Onboarding asked you something' : 'Finish setup — ' + d.done + ' of ' + d.total + ' done'),
          h('p', { class: 'body-s' }, d.certified ? 'Answer it in Settings › Company and charter.' : next ? 'Next: ' + next.title + '. ' + next.why : 'Run the final check to finish.')),
        Button(d.certified ? 'Answer it' : 'Continue setup', { variant: 'primary', href: d.certified ? '#/settings/company' : '#/setup' })),
      h('div', { class: 'meter', role: 'img', 'aria-label': d.done + ' of ' + d.total + ' setup steps done' }, h('div', { style: 'width:' + Math.round(d.done / d.total * 100) + '%' }))));
  }
  loadOnboarding();

  const onLive = e => { liveDot.textContent = e.detail ? 'Live' : 'Polling'; liveDot.classList.toggle('off', !e.detail); };
  document.addEventListener('capheos:live', onLive);

  /* ---- Needs you: each question is a form its asker composed (company/tools/inbox.js) ---- */
  const replying = new Set(); const drafts = {}; const picks = {};   // picks: a request's chosen-but-unsent answers
  let lastQs = []; let snoozedQs = []; let handling = [];
  async function loadNeeds() {
    let d;
    try { d = await api('/questions'); fill(needsErr); }
    catch (e) { fill(needsErr, errLine(e, 'Questions')); return; }
    const all = (d.questions || []).filter(q => !isSetupQuestion(q));
    handling = (d.crewHandling || []).filter(x => !isSetupQuestion(x.question || x));
    const now = Date.now();
    const qs = all.filter(q => !(q.snoozedUntil && Date.parse(q.snoozedUntil) > now));
    snoozedQs = all.filter(q => q.snoozedUntil && Date.parse(q.snoozedUntil) > now);
    lastQs = qs;
    app.setCount && app.setCount('needs', qs.length);
    const n = qs.length;
    lede.textContent = n === 0 ? 'Nothing needs you.' : (n === 1 ? 'One thing needs you.' : (['', '', 'Two', 'Three', 'Four', 'Five', 'Six'][n] || n) + ' things need you.');
    fill(allClear, n ? null : h('div', { class: 'empty' }, 'Nothing needs you right now. New questions will appear here as they come in.'));
    for (const q of qs) { if (!seen.has(q.id) && (!firstLoad || Date.now() - Date.parse(q.askedAt) < 5 * 60e3)) freshIds.add(q.id); }
    qs.forEach(q => seen.add(q.id)); firstLoad = false;
    redraw();
    loadAnswered();
  }
  function redraw() {
    fill(gatesEl, lastQs.map(q => gateCard(q, freshIds.has(q.id))));
    fill(snoozedEl, snoozedQs.length ? h('details', { class: 'hair-top', style: 'padding-top:12px' },
      h('summary', { class: 'label muted', style: 'min-height:32px' }, 'Snoozed (' + snoozedQs.length + ')'),
      h('ul', { class: 'plain stack-8', style: 'margin-top:8px' }, snoozedQs.map(q => h('li', { class: 'between body-s', 'data-snoozed': q.id },
        h('span', { class: 'strong' }, questionText(q).message.slice(0, 120)), h('span', { class: 'mono muted' }, 'back ' + whenLabel(q.snoozedUntil, co.timezone)))))) : null);
    // read only: who has it and one plain line; the card itself (to decide anyway) sits behind "Decide it yourself"
    fill(handlingEl, handling.length ? h('details', { class: 'hair-top crew-handling', style: 'padding-top:12px' },
      h('summary', { class: 'label muted', style: 'min-height:32px' }, 'The crew is handling (' + handling.length + ')'),
      h('p', { class: 'caption muted' }, 'Open questions your settings leave to the crew. Nothing here needs you.'),
      h('ul', { class: 'plain stack-12', style: 'margin-top:8px' }, handling.map(x => h('li', { class: 'stack-4', 'data-handling': x.id },
        h('span', { class: 'body-s' }, h('span', { class: 'strong' }, personName(x.from) || 'The crew'), ' · ' + x.lead),
        h('span', { class: 'caption muted' }, x.line),
        x.question ? Details('Decide it yourself', gateCard(Object.assign({}, x.question, { handled: true }), false)) : null)))) : null);
  }
  function gateCard(q, fresh) {
    if (q.questions && q.questions.length) return requestCard(q, fresh, { fieldControl, post, app, reload: loadNeeds, picks, freshIds, seat: q.askerSeat || ceoId, questionText, parseQuestion, looksLikeKeyText, snoozeUntil, whenLabel, tz: co.timezone, moreMenu, cardMeta, cardDetails, approveSays, leadLine });
    const p = parseQuestion(q);
    const qt = questionText(q);
    const form = q.form && Array.isArray(q.form.actions) && q.form.actions.length ? q.form : { fields: [], actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true }, { id: 'decline', label: 'Decline', verdict: 'no' }] };
    const errEl = h('p', { class: 'err-line', role: 'status' });
    const isReplying = replying.has(q.id);
    // a key inside a form that asks for more is stored on its own (Store) and the question stays open; a key-only
    // question (q.secretOnly) is answered by its Store button as before
    const onStore = f => q.secretOnly ? null : async (value, rep, name, endpoint) => {
      const body = { store: f.id, values: { [f.id]: value } }; if (rep) body.replace = { [f.id]: true }; if (name) body.secretNames = { [f.id]: name }; if (endpoint) body.endpoints = { [f.id]: endpoint };
      const r = await post('/questions/' + encodeURIComponent(q.id) + '/answer', body);
      app.toast('Key stored securely. The question stays open: answer the rest.'); return (r.stored || [])[0];
    };
    const controls = form.fields.map(f => fieldControl(q, f, f.type === 'secret' ? { onStore: onStore(f), stored: (q.stored || {})[f.id] } : null));
    const busy = on => card.querySelectorAll('button, input, textarea, select').forEach(b => { b.disabled = on; });
    const send = async (body, okText) => {
      errEl.textContent = ''; busy(true);
      try {
        const r = await post('/questions/' + encodeURIComponent(q.id) + '/answer', body);
        controls.forEach(c => c.clear && c.clear());
        // what the answer did, in the console's words (a typed effect applied, a standing rule saved)
        replying.delete(q.id); delete drafts[q.id]; freshIds.delete(q.id); app.toast([r && r.said, r && r.rulingSaid].filter(Boolean).join(' ') || okText || 'Answer recorded.', !!(r && r.applied && r.applied.kind && !r.applied.applied && r.applied.technical)); loadNeeds(); return r;
      } catch (e) {
        controls.forEach(c => c.onError && c.onError(e));
        errEl.textContent = 'Not recorded: ' + humanError(e); busy(false);
      }
    };
    const act = a => {
      const values = {}; const replace = {}; const secretNames = {}; const endpoints = {};
      for (const c of controls) {
        if (!c.get) continue;
        const v = c.get(); if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) values[c.f.id] = v;
        if (c.replace && c.replace()) replace[c.f.id] = true;
        if (c.name) secretNames[c.f.id] = c.name();
        if (c.endpoint && c.endpoint()) endpoints[c.f.id] = c.endpoint();
      }
      if (a.needs === 'none') for (const c of controls) if (c.f.type === 'secret') delete values[c.f.id];
      const body = { action: a.id, values };
      if (q.approval && q.approval.actionDigest) body.shownDigest = q.approval.actionDigest;   // approvals.js: refused if the record changed since
      if (q.cardDigest) body.cardDigest = q.cardDigest;   // an owner card: its yes applies only the card as shown here
      if (Object.keys(replace).length) body.replace = replace;
      if (Object.keys(endpoints).length) body.endpoints = endpoints;
      if (Object.keys(secretNames).length) body.secretNames = secretNames;
      const rl = ruleBody(a.verdict); if (rl === false) return; if (rl) body.rule = rl;
      const stores = controls.some(c => c.f.type === 'secret' && values[c.f.id] !== undefined);
      send(body, stores ? 'Key stored securely. Answer recorded.' : 'Answer recorded.');
    };
    const ta = h('textarea', { rows: '6', class: 'textarea', placeholder: 'Write as much as you need…', 'aria-label': 'Your reply to ' + (personName(q.from) || 'the asker') });
    ta.value = drafts[q.id] || ''; ta.addEventListener('input', () => { drafts[q.id] = ta.value; });
    const seat = q.askerSeat || ceoId;
    const quote = qt.message.split('\n').map(l => '> ' + l).join('\n').slice(0, 600);
    const sendReply = () => {
      const text = ta.value.trim(); if (!text) { errEl.textContent = 'Write a reply first.'; return; }
      if (looksLikeKeyText(text)) { errEl.textContent = 'This looks like a key. Use the secure field instead, so it is stored as a file and never written into a message.'; return; }
      const rl = ruleBody('reply', text); if (rl === false) return;
      send(Object.assign({ verdict: 'reply', text }, rl ? { rule: rl } : {}));
    };
    // "Make this a standing rule": the owner's own words become a rule the crew follows from now on (never on a fixed gate)
    const canRule = q.needsWhy !== 'fixed-gate' && !(q.approval && q.approval.fixed) && !q.questions;
    const ruleTick = h('input', { type: 'checkbox', id: 'rule-' + q.id });
    const ruleText = h('input', { type: 'text', class: 'input', id: 'rule-t-' + q.id, maxlength: '500', placeholder: 'In your words, e.g. “You decide these yourselves.”', hidden: true, 'aria-label': 'Your standing rule, in your own words' });
    ruleTick.addEventListener('change', () => { ruleText.hidden = !ruleTick.checked; if (ruleTick.checked) ruleText.focus(); });
    // on a free-text answer: the reply itself is the rule's wording unless the owner writes a shorter one
    const ruleEl = canRule ? h('div', { class: 'stack-4 q-rule' }, h('label', { class: 'check caption', for: 'rule-' + q.id }, ruleTick, 'Make this a standing rule, so the crew does not ask me about this again'), ruleText) : null;
    ruleText.placeholder = 'The rule in a few words (optional; your reply is used otherwise)';
    function ruleBody(verdict, replyText) {
      if (!canRule || !ruleTick.checked) return null;
      const t = ruleText.value.trim() || String(replyText || '').trim();
      if (t.length < 3) { errEl.textContent = 'Write the rule in your own words first.'; ruleText.hidden = false; ruleText.focus(); return false; }
      return { text: t, effect: verdict === 'no' ? 'never-ask' : 'crew-decides' };
    }
    const more = moreMenu(q, {
      onReply: () => { replying.add(q.id); redraw(); const t = gatesEl.querySelector('[data-id="' + CSS.escape(q.id) + '"] textarea[aria-label^="Your reply"]'); if (t) t.focus(); },
      onSnooze: async k => {
        const until = snoozeUntil(k);
        try { await post('/questions/' + encodeURIComponent(q.id) + '/snooze', { until: until.toISOString() }); app.toast('Snoozed until ' + whenLabel(until.toISOString(), co.timezone) + '. ' + (personName(q.from) || 'The asker') + ' sees that.'); loadNeeds(); }
        catch (e) { errEl.textContent = 'Not snoozed: ' + humanError(e); }
      },
      discuss: '#/chat/agent:' + encodeURIComponent(seat) + '?draft=' + encodeURIComponent(quote + '\n\nAbout this question: '),
    });
    const titled = !!(q.gate && q.gate.summary);
    const card = h('article', { class: 'gate' + (fresh || (q.approval && q.approval.reminded) ? ' fresh' : ''), 'data-id': q.id, 'data-kind': q.kind || 'approve', 'aria-labelledby': 'g-' + q.id },
      cardMeta(q, p.cat, fresh),
      titled ? h('h3', { id: 'g-' + q.id, class: 'h4' }, p.title) : null,
      titled && qt.message.replace(/\.$/, '') === p.title.replace(/\.$/, '') ? null : h('div', titled ? { class: 'q-message' } : { id: 'g-' + q.id, class: 'q-message' }, mdBlock(qt.message, 'body q-msg')),
      qt.details ? h('details', { class: 'q-details' }, h('summary', { class: 'caption muted' }, 'More detail'), mdBlock(qt.details, 'body-s q-body')) : null,
      controls.length ? h('div', { class: 'stack-12 q-form' }, controls.map(c => c.el)) : null,
      isReplying ? h('div', { class: 'stack-6 q-reply' }, h('label', { class: 'caption muted', for: 'rp-' + q.id }, 'Your reply goes to ' + (personName(q.from) || 'the asker') + ' in your own words.'), Object.assign(ta, { id: 'rp-' + q.id }), ruleEl,
        h('div', { class: 'row-8' }, Button('Send reply', { variant: 'primary', size: 'sm', onClick: sendReply }), Button('Cancel', { variant: 'ghost', size: 'sm', onClick: () => { replying.delete(q.id); redraw(); } }))) : null,
      q.consequence ? h('p', { class: 'body-s q-consequence' }, q.consequence) : null,
      q.recommendation ? h('p', { class: 'body-s q-recommendation' }, h('span', { class: 'strong' }, 'The crew recommends: '), q.recommendation) : null,
      q.effectSays ? h('p', { class: 'caption q-effect', 'data-effect': q.effectKind || '' }, q.effectSays) : approveSays(q, form),
      q.technical ? h('details', { class: 'q-technical' }, h('summary', { class: 'caption muted' }, 'Technical details (for the crew)'), h('pre', { class: 'mono-s q-tech', style: 'white-space:pre-wrap' }, q.technical)) : null,
      h('div', { class: 'row-8 q-actions' },
        form.actions.map(a => Button(a.label, { variant: a.primary ? 'primary' : 'secondary', size: 'sm', onClick: () => act(a) })),
        more.el),
      errEl, cardDetails(q));
    return card;
  }
  async function loadAnswered() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    try {
      const d = await api('/questions/answered?since=' + encodeURIComponent(start.toISOString()));
      const rows = d.answered || [];
      fill(answeredEl, rows.length ? h('details', { class: 'hair-top', style: 'padding-top:12px' },
        h('summary', { class: 'label muted', style: 'min-height:32px' }, 'Answered today (' + rows.length + ')'),
        h('ul', { class: 'plain stack-8', style: 'margin-top:8px' }, rows.map(a => a.withdrawn
          // a question its asker withdrew: one line, "withdrawn by Founder: the rerender fixed it"
          ? h('li', { class: 'body-s muted q-withdrawn', 'data-withdrawn': a.id + (a.part ? ':' + a.part : '') }, h('span', { class: 'strong' }, leadLine(questionText(a).message, 100)), ' — withdrawn by ' + personName(a.withdrawn.by) + ': ' + a.withdrawn.why + (a.answeredAt ? ' · ' + when(a.answeredAt, co.timezone) : ''))
          : h('li', { class: 'between body-s' },
          h('span', { class: 'strong' }, questionText(a).message.slice(0, 120)), h('span', { class: 'mono muted' }, String(a.answer || '').slice(0, 140) + (String(a.answer || '').length > 140 ? '…' : '') + (a.answeredAt ? ' · ' + when(a.answeredAt, co.timezone) : '')))))) : null);
    } catch (e) { fill(answeredEl, errLine(e, 'Answered today')); }
  }

  /* ---- crew ---- */
  let crewData = null;
  async function loadCrew() {
    try { crewData = await api('/crew'); drawCrew(); } catch (e) { fill(crewEl, errLine(e, 'Crew')); }
  }
  function drawCrew() {
    const d = crewData; if (!d) return;
    {
      const seats = d.seats || [];
      if (!seats.length) return fill(crewEl, empty('No crew yet.'));
      fill(crewEl, d.station === 'down' ? h('p', { class: 'err-line' }, 'Station not running: live status unavailable.') : null,
        h('ul', { class: 'plain hair-top' }, seats.map(s => {
          const st = s.station || {};
          const run = nowData && nowData.runs.find(r => r.agentId === s.id);
          const nx = nowData && (nowData.seats || []).find(x => x.id === s.id);
          const ss = seatState({ run, seat: nx, station: st, stationDown: d.station === 'down', isCeo: s.id === ceoId });
          const doing = run ? cap(run.step || run.label) : ss.line || (s.loop && !nx ? personName(s.loop) : '');
          return h('li', { class: 'crew-row', 'data-seat': s.id }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(personName(s.name))),
            h('div', { class: 'stack-4', style: 'gap:2px;min-width:0' },
              h('span', { class: 'label strong' }, personName(s.name) || s.id, ' ', h('span', { style: 'font-weight:400;color:var(--text-muted)' }, '· ' + (s.title || s.seat || ''))),
              h('span', { class: 'body-s muted ellip' }, [ss.lanes, doing].filter(Boolean).join(' · '))),
            Tag(ss.word, { variant: 'status', status: statusOf(ss.word) }));
        })));
    }
  }

  /* ---- usage ---- */
  async function loadUsage() {
    try {
      const d = await api('/usage');
      fill(usageEl, h('div', { class: 'card', style: 'gap:18px' }, usagePlans(d, t => dayTime(t, co.timezone)).map(p => h('div', { class: 'stack-8 usage-row', 'data-plan': p.key || '' },
        h('div', { class: 'between-c', style: 'gap:8px;flex-wrap:wrap' }, h('span', { class: 'label strong' }, p.name), h('span', { class: 'body-s muted' }, p.reading)),
        h('div', { class: 'meter', role: 'img', 'aria-label': p.aria }, h('div', { class: p.over ? 'over' : '', style: 'width:' + p.pct + '%' }), p.mark != null ? h('span', { class: 'meter-mark', style: 'left:' + p.mark + '%', title: 'Today\'s allowance' }) : null),
        h('span', { class: 'caption muted' }, p.note)))));
    } catch (e) { fill(usageEl, errLine(e, 'Usage')); }
  }

  /* ---- now: who is running, what step, Watch / Stop; when each seat runs next ---- */
  let nowData = null; const watching = new Map();   // runId -> { el, after, timer }
  async function loadNow() {
    let d, c = null;
    try { [d, c] = await Promise.all([api('/now'), api('/company').catch(() => null)]); }
    catch (e) { fill(nowEl, h('h2', { id: 'now-h', class: 'h3' }, 'Now'), errLine(e, 'Now')); return; }
    for (const x of [].concat(d.runs || [], d.seats || [], d.lanes || [])) if (x && x.name) x.name = personName(x.name);
    nowData = d; drawNow(c); drawCrew();
  }
  let nowCo = null;
  function drawNow(c) {
    if (c !== undefined) nowCo = c; else c = nowCo;
    const d = nowData; if (!d) return;
    const kick = c && c.onboarding && c.onboarding.kickoff;
    const ceoRun = d.runs.find(r => r.agentId === ceoId);
    const kickEl = kick && kick.planOpen ? h('div', { class: 'card p18 now-kick', role: 'status' },
      h('span', { class: 'row-8', style: 'align-items:center' }, ceoRun ? h('span', { class: 'pulse', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'label strong' }, ceoRun ? ceoName + ' is drafting the first plan…' : ceoName + ' has the first plan on its desk (' + (kick.status === 'ok' ? 'started ' + rel(kick.at) : 'waiting for its next run') + ').')),
      h('span', { class: 'body-s muted' }, 'It turns the charter into goals (quests), the roles it will open, and the first tasks, then writes to you with links.')) : null;
    const runs = d.runs.map(r => {
      const w = watching.get(r.runId);
      const row = h('li', { class: 'now-run', 'data-run': r.runId },
        h('div', { class: 'between-c', style: 'gap:12px;flex-wrap:wrap' },
          h('span', { class: 'row-8', style: 'align-items:center;min-width:0;flex:1 1 220px' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }),
            h('span', { class: 'stack-4', style: 'gap:2px;min-width:0' },
              h('span', { class: 'label strong' }, r.name, h('span', { style: 'font-weight:400;color:var(--text-muted)' }, ' · ', h('a', { href: r.href }, r.label))),
              h('span', { class: 'body-s ellip now-step' }, r.step ? cap(r.step) : r.watched ? 'Thinking…' : 'Working (started before the console was watching)'))),
          h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'mono-s muted' }, [dur(r.elapsedSec), r.usd != null ? '$' + Number(r.usd).toFixed(4) : null, r.steps ? r.steps + (r.steps === 1 ? ' step' : ' steps') : null].filter(Boolean).join(' · ')),
            Button(w ? 'Hide' : 'Watch', { variant: 'secondary', size: 'sm', onClick: () => toggleWatch(r) }),
            r.stoppable ? Button('Stop', { variant: 'ghost', size: 'sm', onClick: async () => { if (!await app.confirmDialog({ title: 'Stop ' + r.name + '\'s run?', body: 'The run stops at its next step. Work already saved stays.', confirm: 'Stop it', danger: true })) return; try { await post('/station/cancel', { runId: r.runId }); app.toast('Stop sent.'); } catch (e) { app.toast('Stop: ' + e.message, true); } } }) : null)),
        w ? w.el : null);
      return row;
    });
    // Sprint (start-up): a chip with the end time, the key numbers and an Off button; seats say working / waiting for work
    const sp = d.sprint;
    const spx = sp ? sprintSummary(sp, t => dayTime(t, co.timezone)) : null;
    const sprintEl = sp ? h('div', { class: 'card p18 row-8 sprint-chip', role: 'status', style: 'flex-direction:row;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 16px' },
      h('span', { class: 'pulse warn', 'aria-hidden': 'true' }),
      h('span', { class: 'body-s strong sprint-line', style: 'flex:1;min-width:200px' }, spx.line),
      spx.details.length ? h('span', { class: 'sprint-more' }, Details('Details', h('ul', { class: 'plain stack-4 caption' }, spx.details.map(x => h('li', null, x))))) : null,
      Button('Off', { variant: 'secondary', size: 'sm', onClick: async () => { if (!await app.confirmDialog({ title: 'Turn Sprint off?', body: 'The company goes back to your base tempo: seats rest their full cooldown again and the wake limits apply.', confirm: 'Turn it off' })) return; try { await post('/cadence/sprint', { on: false }); app.toast('Sprint off.'); loadNow(); } catch (e) { app.toast('Sprint: ' + humanError(e), true); } } }),
      Button('Settings', { variant: 'ghost', size: 'sm', href: '#/settings/tempo/sprint' })) : null;
    // the dispatcher's own reason from its last tick (dispatch-state.json seats), with Decide when a question waits on the owner
    const decide = qid => Button('Decide', { variant: 'secondary', size: 'sm', onClick: () => { const c = document.querySelector('[data-id="' + CSS.escape(qid) + '"]'); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); const f = c.querySelector('button, input, [tabindex]'); if (f) f.focus({ preventScroll: true }); } else location.hash = '#/today'; } });
    // Sprint lanes (company/tools/lanes.js): each running lane, whose it is, the handoff it owns and since when (its run is
    // also in the list above as "lane n: …" while the station reports it)
    const lanesEl = (d.lanes || []).length ? h('div', { class: 'stack-4', 'aria-label': 'Lanes running' }, h('span', { class: 'eyebrow-t' }, 'Lanes running'),
      h('ul', { class: 'plain stack-4' }, d.lanes.map(l => h('li', { class: 'body-s row-8', 'data-lane': l.id, style: 'align-items:center' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }),
        h('span', null, l.name + ' · lane ' + l.n + ': ' + String(l.handoff || '').replace(/^\S+ from \S+ — /, '') + ' · since ' + when(l.since, co.timezone) + ' (' + rel(l.since) + ')'))))) : null;
    const idle = d.seats.filter(s => !s.running).map(s => s.idle && s.idle.reason ? h('li', { class: 'body-s muted now-idle row-8', 'data-seat': s.id, 'data-state': s.idle.state, style: 'align-items:center;flex-wrap:wrap' },
      h('span', null, idleLine(s)), s.idle.qid ? decide(s.idle.qid) : null) : sp && s.sprint ? h('li', { class: 'body-s muted now-idle' }, s.name + (s.sprint === 'working' ? ': working — ' + s.soonerBecause.join(', ') + '; starts as soon as the next tick sees it' : ': waiting for work') + '.') : h('li', { class: 'body-s muted now-idle' }, s.name + ' is idle' +
      (s.loop ? (s.enabled === false ? '; its loop "' + s.loop + '" is switched off' : s.schedulerOn === false ? '; the scheduler is off, so its loop does not run on schedule' : s.nextRunAt ? '; next run ' + when(s.nextRunAt, co.timezone) + ' (' + rel(s.nextRunAt) + ')' : '') : '; it has no loop routine') +
      (s.soonerBecause.length ? ', or sooner: ' + s.soonerBecause.join(', ') : s.wakesOnMessage ? ', or sooner if you message it' : '') + '.'));
    fill(nowEl, h('div', { class: 'between-c' }, h('h2', { id: 'now-h', class: 'h3' }, 'Now'), d.station.up ? null : h('span', { class: 'err-line' }, 'Station not running: nobody can work.')),
      sprintEl, kickEl, runs.length ? h('ul', { class: 'plain stack-8' }, runs) : null, lanesEl, idle.length ? h('ul', { class: 'plain stack-4' }, idle) : null);
  }
  function toggleWatch(r) {
    const w = watching.get(r.runId);
    if (w) { clearTimeout(w.timer); watching.delete(r.runId); drawNow(); return; }
    const steps = h('ul', { class: 'chat-steps plain' }); const text = h('div', { class: 'md msg-them' }); const status = h('span', { class: 'caption muted' }, 'Connecting…');
    const el = h('div', { class: 'now-watch sunken stack-8' }, steps, text, status);
    const st = { el, after: 0, timer: null, raw: '' };
    watching.set(r.runId, st);
    const poll = async () => {
      try {
        const d = await api('/now/run/' + encodeURIComponent(r.runId) + '?after=' + st.after);
        if (!d.known) status.textContent = 'This run started before the console was watching; new steps appear as they happen. The full transcript is in Chat once it ends.';
        for (const e of d.events || []) {
          st.after = Math.max(st.after, e.seq);
          if (e.name === 'tool') steps.appendChild(h('li', { class: 'chat-step', 'data-call': e.callId || '' }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'body-s' }, cap(e.text)),
            e.raw ? h('code', { class: 'mono-s muted step-raw' }, e.raw) : null));
          else if (e.name === 'result') { const li = [...steps.children].find(x => x.dataset.call === String(e.callId || '')); if (li) li.classList.add(e.ok ? 'ok' : 'bad'); }
          else if (e.name === 'token') st.raw += e.delta || '';
          else if (e.name === 'error') steps.appendChild(h('li', { class: 'danger body-s' }, e.message));
        }
        fill(text, mdBlock(st.raw.slice(-4000)));
        if (d.done) { status.textContent = 'Finished: ' + (d.outcome || 'done') + (d.usd ? ' · $' + Number(d.usd).toFixed(4) : '') + '.'; return; }
        if (d.known) status.textContent = 'Live.';
      } catch (e) { status.textContent = 'Watch: ' + humanError(e); }
      if (watching.get(r.runId) === st) st.timer = setTimeout(poll, 1500);
    };
    poll(); drawNow();
  }

  /* ---- recent activity: finished runs, hiring, replies, decisions ---- */
  const OUT = { succeeded: ['Done', 'online'], failed: ['Failed', 'danger'], cancelled: ['Stopped', 'neutral'], stopped: ['Stopped', 'neutral'] };
  async function loadOvernight() {
    try {
      const d = await api('/activity');
      const items = (d.items || []).slice(0, 25);
      fill(overnightEl, items.length ? h('ol', { class: 'timeline' }, items.map(e => {
        const o = e.outcome ? OUT[e.outcome] || [cap(e.outcome), statusOf(e.outcome)] : null;
        return h('li', null, h('span', { class: 'mono muted' }, when(e.at, co.timezone)),
          h('span', { class: 'stack-4', style: 'gap:2px' },
            h('span', { class: 'body-s row-8', style: 'align-items:center;flex-wrap:wrap' }, h('strong', { class: 'strong', style: 'font-weight:600' }, e.title), o ? Tag(o[0], { variant: 'status', status: o[1] }) : null, e.usd ? h('span', { class: 'mono-s muted' }, '$' + Number(e.usd).toFixed(4)) : null),
            e.text ? mdBlock(e.text, 'body-s muted') : null,
            e.detail ? Details('Details', h('code', { class: 'mono-s' }, e.detail)) : null,
            (e.links || []).length ? h('span', { class: 'row-8 caption' }, e.links.slice(0, 4).map(l => h('a', { href: l.href }, l.label + ' →'))) : null));
      })) : empty('Nothing has happened yet. Runs, hires, replies and decisions show here as they happen.'));
    } catch (e) { fill(overnightEl, errLine(e, 'Recent activity')); }
  }

  /* ---- What the crew did today: the one plain digest (company/owner/digest.jsonl, GET /api/digest) ---- */
  async function loadDigest() {
    let d; try { d = await api('/digest'); } catch (_) { fill(digestEl); return; }
    const items = d.items || [];
    if (!items.length) return fill(digestEl);
    fill(digestEl, h('h2', { id: 'digest-h', class: 'h3' }, d.title || 'What the crew did today'),
      h('article', { class: 'card p20 stack-12 digest-card' },
        h('p', { class: 'caption muted' }, 'Things you may want to know. Nothing here needs an answer.'),
        h('ul', { class: 'plain stack-8' }, items.map(x => h('li', { class: 'stack-4 digest-item' },
          h('span', { class: 'body-s' }, x.from ? h('span', { class: 'strong' }, personName(x.from) + ': ') : null, x.text, h('span', { class: 'caption muted' }, ' · ' + when(x.at, co.timezone))),
          x.technical ? h('details', { class: 'q-technical' }, h('summary', { class: 'caption muted' }, 'Technical details (for the crew)'), h('pre', { class: 'mono-s', style: 'white-space:pre-wrap' }, x.technical)) : null)))));
  }
  loadNeeds(); loadCrew(); loadUsage(); loadOvernight(); loadNow(); loadDigest();
  const stopPanels = mountPanels(panelsEl, 'today', app);
  const offs = [events.on('questions', () => { loadNeeds(); loadOnboarding(); }), events.on('crew', loadCrew), events.on(['dispatch', 'activity', 'owner'], () => { loadOvernight(); loadDigest(); }),
    events.on(['now', 'crew', 'dispatch'], () => { loadNow(); loadCrew(); }), events.on('handoffs', loadNow),
  ];
  // elapsed time ticks while something runs; a slow poll keeps "Now" honest when SSE is down
  const nowTimer = setInterval(() => { if (document.hidden) return; if (nowData && nowData.runs.length) loadNow(); }, 5000);
  const usageTimer = setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
  const offMeet = meetingStrip(meetEl);
  return () => { offMeet(); offs.forEach(f => f()); stopPanels(); clearInterval(usageTimer); clearInterval(nowTimer); for (const w of watching.values()) clearTimeout(w.timer); document.removeEventListener('capheos:live', onLive); };
}

/* a Needs-you card's head: a human category, who asked and when (the question id and raw tags go under Details) */
export function cardMeta(q, cat, fresh, extra) {
  return h('div', { class: 'between-c q-meta' },
    h('span', { class: 'row-8', style: 'align-items:center;flex-wrap:wrap' }, cat ? Tag(cat, { variant: 'accent' }) : null, extra || null, fresh ? h('span', { class: 'just-now' }, 'Just now') : null),
    h('span', { class: 'caption muted q-asker' }, [personName(q.from), rel(q.askedAt)].filter(Boolean).join(' · ')));
}
export function cardDetails(q) {
  const g = q.gate || {};
  const rows = [['Question id', q.id], ['Asked by', q.from], ['About', q.about], g.category ? ['Gate', g.category + (g.ref ? ' · ' + g.ref : '')] : null, q.askedAt ? ['Asked at', q.askedAt] : null].filter(r => r && r[1]);
  return h('div', { class: 'q-card-details' }, Details('Who asked, and the question id', h('dl', { class: 'kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono-s' }, String(v))]))));
}
/* what Approve will do, said before the owner presses it: the asker's own words (action.does), else "Approve tells
 * <asker> yes". Only on an Approve/Decline question (a yes and a no action, no field but an optional note). */
export function approveSays(q, form) {
  const acts = (form && form.actions) || [];
  const yes = acts.find(a => a.verdict === 'yes'); const no = acts.find(a => a.verdict === 'no');
  if (!yes || !no || (form.fields || []).some(f => f.type !== 'info' && !(f.type === 'text' && !f.required))) return null;
  const who = personName(q.from) || 'the asker';
  const text = yes.does ? yes.does.replace(/^(?!approve)/i, yes.label + ': ') : yes.label + ' tells ' + who + ' yes; ' + no.label + ' tells ' + who + ' no.';
  return h('p', { class: 'caption muted q-does', 'data-does': yes.does ? 'asker' : 'default' }, text.replace(/([^.!?])$/, '$1.'));
}
/* "More ▾": the secondary actions every card has (Reply, Snooze, Discuss) behind one menu button */
let menuSeq = 0;
export function moreMenu(q, { onReply, onSnooze, discuss }) {
  const id = 'more-' + (++menuSeq);
  const snoozeRow = h('div', { class: 'row-8 snooze-menu', hidden: true, role: 'group', 'aria-label': 'Snooze until' },
    [['In an hour', 'hour'], ['Tomorrow morning', 'tomorrow'], ['Next week', 'week']].map(([label, k]) => Button(label, { variant: 'ghost', size: 'sm', onClick: () => { close(); onSnooze(k); } })));
  const item = (label, opts) => { const b = Button(label, Object.assign({ variant: 'ghost', size: 'sm', class: 'more-item' }, opts)); b.setAttribute('role', 'menuitem'); return b; };
  const menu = h('div', { id, class: 'more-menu card', role: 'menu', hidden: true, 'aria-label': 'More for this question', onkeydown: e => { if (e.key === 'Escape') { close(); button.focus(); } } },
    item('Reply', { aria: 'Reply in your own words', onClick: () => { close(); onReply(); } }),
    item('Snooze', { aria: 'Ask me later', onClick: () => { snoozeRow.hidden = !snoozeRow.hidden; } }),
    snoozeRow,
    item('Discuss', { href: discuss, aria: 'Discuss it in a chat with the asker' }));
  const button = Button('More ▾', { variant: 'ghost', size: 'sm', class: 'more-btn', onClick: () => { menu.hidden ? open() : close(); } });
  button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id);
  function open() { menu.hidden = false; button.setAttribute('aria-expanded', 'true'); const f = menu.querySelector('[role=menuitem]'); if (f) f.focus({ preventScroll: true }); }
  function close() { menu.hidden = true; snoozeRow.hidden = true; button.setAttribute('aria-expanded', 'false'); }
  return { button, menu, el: h('span', { class: 'more' }, button, menu) };
}

// the plain message first, dense detail under "More detail"; an old question shows its first two sentences
export function questionText(q) {
  if (q && q.message) return { message: String(q.message), details: q.details ? String(q.details) : '' };
  const p = parseQuestion(q || {});
  const src = [p.title, p.why].filter(Boolean).join('\n');
  const first = src.split('\n')[0] || '';
  const ss = first.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z("'`*\[])/);
  let msg = ss.slice(0, 2).join(' '); if (msg.length > 400) msg = ss[0].slice(0, 399) + (ss[0].length > 399 ? '…' : '');
  const rest = src.slice(src.indexOf(msg.replace(/…$/, '')) + msg.replace(/…$/, '').length).trim();
  const extra = [rest, p.rec ? 'Recommendation: ' + p.rec : '', p.dflt ? 'If you do not answer: ' + p.dflt : ''].filter(Boolean).join('\n');
  return { message: msg || q.id, details: extra };
}
export function looksLikeKeyText(t) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(t) || /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(t);
}
function snoozeUntil(k) {
  const d = new Date();
  if (k === 'hour') return new Date(Date.now() + 3600e3);
  d.setDate(d.getDate() + (k === 'week' ? 7 : 1)); d.setHours(9, 0, 0, 0); return d;
}
function whenLabel(iso, tz) { return when(iso, tz); }
let fieldSeq = 0;
/* one form field -> { f, el, get?, clear?, replace?, name?, onError? }. A secret's value lives only in its input. */
export function fieldControl(q, f, opts) {
  opts = opts || {};
  const uid = 'qf-' + q.id + '-' + f.id + '-' + (++fieldSeq);
  const help = f.help ? mdBlock(f.help, 'caption muted') : null;
  const lab = (text, forId) => h('label', { for: forId, class: 'label strong' }, text, f.required ? null : (/optional/i.test(text || '') ? null : h('span', { class: 'caption muted' }, ' (optional)')));
  if (f.type === 'info') return { f, el: h('div', { class: 'q-info' }, mdBlock(f.text, 'body-s')) };
  if (f.type === 'text') {
    const el = f.multiline ? h('textarea', { id: uid, rows: f.required ? '4' : '2', class: 'textarea', placeholder: f.placeholder || '', maxlength: f.maxLength || null }) : h('input', { id: uid, type: 'text', class: 'input', placeholder: f.placeholder || '', maxlength: f.maxLength || null });
    const count = (f.minLength || f.maxLength) ? h('span', { class: 'caption muted' }) : null;
    const upd = () => { if (count) count.textContent = el.value.trim().length + (f.maxLength ? ' / ' + f.maxLength : '') + ' characters' + (f.minLength ? ' (at least ' + f.minLength + ')' : ''); };
    el.addEventListener('input', upd); upd();
    // an optional note or reason (the approve / choice / link shortcuts add one): an "Add a note" link that opens it
    if (!f.required && /^(reason|note)$/.test(f.id)) {
      const box = h('div', { class: 'stack-6 q-note', hidden: true }, h('label', { for: uid, class: 'label strong' }, String(f.label || 'Note').replace(/\s*\(optional\)\s*$/i, '')), help, el);
      const link = h('button', { type: 'button', class: 'link-btn q-note-open', 'aria-expanded': 'false', 'aria-controls': uid, onclick: () => { box.hidden = false; link.hidden = true; link.setAttribute('aria-expanded', 'true'); el.focus(); } }, 'Add a note');
      return { f, el: h('div', { class: 'stack-6' }, link, box), get: () => el.value.trim(), clear: () => { el.value = ''; } };
    }
    return { f, el: h('div', { class: 'stack-6' }, lab(f.label, uid), help, el, count), get: () => el.value.trim(), clear: () => { el.value = ''; } };
  }
  if (f.type === 'url') {
    // a web address (a ping URL, a webhook): plain, visible, checked as https before it is sent
    const el = h('input', { id: uid, type: 'url', class: 'input', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: f.placeholder || 'https://…' });
    const err = h('span', { class: 'err-line caption', role: 'status' });
    const ok = v => { try { const u = new URL(v); return (u.protocol === 'https:' || (f.allowHttp && u.protocol === 'http:')) && !u.username && !u.password; } catch (_) { return false; } };
    el.addEventListener('input', () => { const v = el.value.trim(); err.textContent = v && !ok(v) ? 'A web address starting with https://' : ''; el.setAttribute('aria-invalid', v && !ok(v) ? 'true' : 'false'); });
    return { f, el: h('div', { class: 'stack-6 q-url', 'data-field': f.id }, lab(f.label, uid), help, el, err),
      get: () => { const v = el.value.trim(); if (v && !ok(v)) { err.textContent = 'A web address starting with https://'; return undefined; } return v || undefined; }, clear: () => { el.value = ''; } };
  }
  if (f.type === 'secret') {
    // password input (or a masked textarea for a multi-line PEM key); never autofilled, never echoed back
    let multi = !!f.multiline;
    const attrs = { id: uid, class: 'input secret-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'aria-describedby': uid + '-note' };
    const one = h('input', Object.assign({ type: 'password', name: 'q-secret-' + f.id }, attrs));
    const many = h('textarea', Object.assign({}, attrs, { class: 'textarea secret-input secret-mask', rows: '4', placeholder: 'Paste the key (a multi-line private key is fine)' }));
    const slot = h('div'); fill(slot, multi ? many : one);
    let shown = false;
    const showBtn = h('button', { type: 'button', class: 'link-btn', 'aria-label': 'Show or hide the key', onclick: () => { shown = !shown; one.type = shown ? 'text' : 'password'; many.classList.toggle('secret-mask', !shown); showBtn.textContent = shown ? 'Hide' : 'Show'; } }, 'Show');
    const multiBtn = h('button', { type: 'button', class: 'link-btn', onclick: () => { const v = (multi ? many : one).value; multi = !multi; (multi ? many : one).value = v; one.value = multi ? '' : one.value; many.value = multi ? many.value : ''; fill(slot, multi ? many : one); multiBtn.textContent = multi ? 'One line' : 'Multi-line key'; } }, multi ? 'One line' : 'Multi-line key');
    const replace = h('input', { type: 'checkbox', id: uid + '-replace' });
    const nameIn = f.hinted ? h('input', { type: 'text', class: 'input mono', id: uid + '-name', value: f.name, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'File name under secrets/' }) : null;
    // a MiniMax key: where the account is (Global / Mainland China / Custom); the key is checked there when stored
    const mm = minimaxField(f);
    let picker = null; const pickSlot = mm ? h('div', { class: 'q-endpoint' }) : null;
    if (mm) loadEndpoint().then(ep => { picker = endpointPicker({ endpoint: ep, getKey: () => (multi ? many : one).value, saveLabel: 'Store' }); fill(pickSlot, picker.el); });
    const note = h('span', { id: uid + '-note', class: 'caption muted' }, 'Stored safely on this computer; never shown again, and never sent in a message.');
    const where = h('span', { class: 'mono-s' }, 'Saved as secrets/' + f.name + ' (owner-only, mode 0600). ' + (personName(q.from) || 'The asker') + ' only learns where it is.');
    if (nameIn) nameIn.addEventListener('input', () => { where.textContent = 'Saved as secrets/' + (nameIn.value.trim() || '…') + ' (owner-only, mode 0600).'; });
    // inside a form that asks for more than the key: Store writes the key now and the question STAYS OPEN; the field
    // then reads "Stored ✓ (replace)" and the final button answers the whole question (the key as {stored, chars})
    let storedNow = opts.stored || null;
    const storedLine = h('div', { class: 'row-8 q-stored', style: 'align-items:center;flex-wrap:wrap' });
    const storeErr = h('span', { class: 'err-line store-err', role: 'status' });
    const showStored = () => {
      fill(storedLine, storedNow ? [h('span', { class: 'label strong', 'data-stored': storedNow.stored }, 'Stored ✓'), h('span', { class: 'caption muted mono' }, storedNow.stored + (storedNow.chars ? ' (' + storedNow.chars + ' chars)' : '')),
        Button('(replace)', { variant: 'ghost', size: 'sm', aria: 'Replace the stored key', onClick: () => { storedNow = null; replace.checked = true; showStored(); } })] : null);
      inputRow.hidden = !!storedNow || keepSaved; storedLine.hidden = !storedNow; savedLine.hidden = !!storedNow || !keepSaved;
    };
    // a key that is already in secrets/ (Settings › Connections and keys): "Already saved — replace?", the field closed
    let keepSaved = !!(f.saved && !storedNow);
    const savedLine = h('div', { class: 'row-8 q-saved', style: 'align-items:center;flex-wrap:wrap', 'data-saved': f.name },
      h('span', { class: 'label strong' }, 'Already saved — replace?'), f.saved && f.saved.at ? h('span', { class: 'caption muted' }, 'Saved ' + when(f.saved.at) + '.') : null,
      Button('Replace', { variant: 'secondary', size: 'sm', aria: 'Replace the saved key', onClick: () => { keepSaved = false; replace.checked = true; showStored(); (multi ? many : one).focus(); } }));
    const anyTime = h('span', { class: 'caption muted q-anytime' }, 'You can also add or replace keys any time in ', h('a', { href: '#/settings/connections/service-keys' }, 'Settings › Connections and keys'), '.');
    const storeBtn = opts.onStore ? Button('Store', { variant: 'secondary', size: 'sm', aria: 'Store the key now (the question stays open)', onClick: async () => {
      const v = (multi ? many : one).value; if (!v.trim()) { storeErr.textContent = 'Paste the key first.'; return; }
      storeErr.textContent = ''; storeBtn.disabled = true;
      try { const r = await opts.onStore(v, replace.checked, nameIn ? nameIn.value.trim() : null, picker ? picker.value() : null); one.value = ''; many.value = ''; storedNow = r || { stored: 'secrets/' + f.name }; showStored(); }
      catch (e) { storeErr.textContent = 'Not stored: ' + humanError(e); if (e && e.status === 409) replace.parentElement.classList.add('attn'); }
      storeBtn.disabled = false;
    } }) : null;
    const inputRow = h('div', { class: 'stack-6' }, h('div', { class: 'q-secret-row' }, h('div', { class: 'q-secret-slot' }, slot), storeBtn),
      h('div', { class: 'row-8 caption', style: 'align-items:center;gap:16px;flex-wrap:wrap' }, showBtn, multiBtn),
      note,
      h('label', { class: 'check', for: uid + '-replace' }, replace, 'Replace the saved key'), storeErr,
      Details('Details', where, nameIn ? h('label', { class: 'stack-4' }, h('span', { class: 'caption muted' }, 'File name under secrets/'), nameIn) : null));
    const el = h('div', { class: 'stack-6 q-secret', 'data-field': f.id }, lab(f.label, uid), f.provider ? h('span', { class: 'caption' }, 'Where to get it: ', mdBlock(f.provider, 'caption')) : null, help, pickSlot, savedLine, inputRow, storedLine, anyTime);
    showStored();
    return { f, el, get: () => { if (storedNow) return undefined; const v = (multi ? many : one).value; return v.trim() ? v : undefined; }, clear: () => { one.value = ''; many.value = ''; },
      isStored: () => !!storedNow, endpoint: mm ? () => picker ? picker.value() : null : null,
      replace: () => replace.checked, name: nameIn ? () => nameIn.value.trim() : null,
      onError: e => { if (e && e.status === 409) replace.parentElement.classList.add('attn'); } };
  }
  if (f.type === 'choice') {
    const type = f.multi ? 'checkbox' : 'radio'; const nm = uid + '-c';
    const boxes = (f.options || []).map(o => ({ o, input: h('input', { type, name: nm, value: o.id, checked: !f.multi && !!o.recommended }) }));
    const other = f.allowOther ? { input: h('input', { type, name: nm, value: '__other' }), text: h('input', { type: 'text', class: 'input', style: 'flex:1;min-width:0;height:36px', placeholder: 'Something else…', 'aria-label': 'Your own answer' }) } : null;
    if (other) other.text.addEventListener('input', () => { if (other.text.value.trim()) other.input.checked = true; });
    return { f, el: h('fieldset', { class: 'stack-4 q-choice' }, h('legend', { class: 'label strong' }, f.label), help,
      boxes.map(b => h('label', { class: 'check' }, b.input, b.o.label, b.o.recommended ? Tag('Recommended', { variant: 'soft' }) : null)),
      other ? h('label', { class: 'check' }, other.input, other.text) : null),
      get: () => {
        const picked = boxes.filter(b => b.input.checked).map(b => b.o.id);
        if (other && other.input.checked && other.text.value.trim()) picked.push(other.text.value.trim());
        return f.multi ? picked : picked[0];
      } };
  }
  if (f.type === 'link') {
    let host = ''; try { host = new URL(f.url).host; } catch (_) {}
    const done = h('input', { type: 'checkbox', id: uid });
    return { f, el: h('div', { class: 'stack-6 q-link sunken' }, h('span', { class: 'label strong' }, f.label), h('span', { class: 'body-s' }, f.action), help,
      h('div', { class: 'row-8', style: 'align-items:center' }, h('a', { class: 'btn btn-secondary btn-sm', href: f.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open ' + (host || 'the page') + ' ↗'),
        h('label', { class: 'check', for: uid }, done, 'I did this'))),
      get: () => done.checked ? 'done' : undefined };
  }
  if (f.type === 'number') {
    const el = h('input', { id: uid, type: 'number', class: 'input', step: 'any', min: f.min != null ? String(f.min) : null, max: f.max != null ? String(f.max) : null, inputmode: 'decimal', style: 'max-width:200px' });
    return { f, el: h('div', { class: 'stack-6' }, lab(f.label, uid), help, h('div', { class: 'row-8', style: 'align-items:center' }, el, f.unit ? h('span', { class: 'body-s muted' }, f.unit) : null)),
      get: () => el.value === '' ? undefined : Number(el.value) };
  }
  if (f.type === 'date') {
    const el = h('input', { id: uid, type: 'date', class: 'input', min: f.min || null, max: f.max || null, style: 'max-width:220px' });
    return { f, el: h('div', { class: 'stack-6' }, lab(f.label, uid), help, el), get: () => el.value || undefined };
  }
  if (f.type === 'slider') { const c = sliderControl(f, uid); return { f, el: h('div', { class: 'stack-6' }, help ? [lab(f.label, uid), help] : lab(f.label, uid), c.el), get: c.get }; }
  if (f.type === 'checkbox') {
    const el = h('input', { type: 'checkbox', id: uid });
    return { f, el: h('div', { class: 'stack-4' }, h('label', { class: 'check', for: uid }, el, f.label), help), get: () => el.checked ? true : undefined };
  }
  return { f, el: h('p', { class: 'caption muted' }, 'This console cannot show a "' + f.type + '" field; use Reply.') };
}

/* a slider (inbox.js type "slider"): a native range input, so arrows, Page Up/Down and Home/End work; the live value in
 * plain words (f.say with {value}) is shown beside it and read out (aria-valuetext, aria-live). Also used by Usage. */
export function sliderWords(f, v) {
  const val = String(Math.round(Number(v) * 1e6) / 1e6);
  if (f.sayAt && f.sayAt[val]) return f.sayAt[val];
  if (f.say) return f.say.split('{value}').join(val);
  return (f.label || f.id) + ': ' + val + (f.unit ? (/^[%°]/.test(f.unit) ? '' : ' ') + f.unit : '');
}
export function sliderControl(f, uid, onInput) {
  const listId = f.marks && f.marks.length ? uid + '-marks' : null;
  const el = h('input', { id: uid, type: 'range', class: 'q-range', min: String(f.min), max: String(f.max), step: String(f.step || 1), value: String(f.value != null ? f.value : f.min), list: listId, 'aria-describedby': uid + '-say' });
  const say = h('output', { id: uid + '-say', for: uid, class: 'body-s strong q-say', 'aria-live': 'polite' });
  const upd = () => { const w = sliderWords(f, el.value); say.textContent = w; el.setAttribute('aria-valuetext', w); if (onInput) onInput(Number(el.value)); };
  el.addEventListener('input', upd); upd();
  const ends = (f.minLabel || f.maxLabel) ? h('div', { class: 'between caption muted q-range-ends' }, h('span', null, f.minLabel || ''), h('span', null, f.maxLabel || '')) : null;
  const marks = listId ? h('datalist', { id: listId }, f.marks.map(m => h('option', { value: String(m.value), label: m.label }))) : null;
  // a mark is a tick (datalist) only: its label would crowd the end labels, and the live sentence already says it
  return { el: h('div', { class: 'stack-4 q-slider' }, say, el, marks, ends), get: () => Number(el.value), input: el, set: v => { el.value = String(v); upd(); } };
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

export function parseLogLine(line) {
  const s = String(line || '').replace(/^[-*]\s*/, '').trim();
  if (!s || /^#/.test(s)) return { text: '' };
  const m = /^(?:\*\*)?(?:(\d{4}-\d\d-\d\d)[T ])?(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?(?:\*\*)?\s*[-–—:]?\s*(.*)$/.exec(s);
  return m ? { at: m[2], text: m[3].replace(/\*\*/g, '') } : { at: '', text: s.replace(/\*\*/g, '') };
}

// a secret field that holds a MiniMax key (console/server.js minimaxField: the same rule)
const minimaxField = f => f.validate === 'custom' || (!f.validate && /minimax/i.test(String(f.name || '')));
// pacer status → meter rows (Claude / MiniMax plans, metered DeepSeek, the station-wide limit), in plain words (plain.js)
export function usagePlans(d, fmt) {
  const out = [];
  for (const k of ['claude', 'minimax']) {
    const p = d && d[k]; if (!p) continue;
    const u = usageLine(Object.assign({ key: k }, p), d.emergency, fmt);
    out.push(Object.assign({ key: k }, u, { reading: u.reading }));
  }
  if (d && d.deepseek) {
    const p = d.deepseek;
    out.push({ key: 'deepseek', name: p.label || 'Metered', pct: 0, mark: null, reading: p.open ? 'Open' : 'Closed', aria: (p.label || 'Metered') + (p.open ? ' open' : ' closed'), note: p.open ? 'Pay-per-token: billed by use, under your daily cap.' : 'Not usable right now: its balance or limit ran out.' });
  }
  const rl = d && railLine(d.rail);
  if (rl) out.push(Object.assign({ key: 'rail', mark: null, aria: rl.name + ': ' + rl.reading }, rl));
  if (!out.length) out.push({ name: 'AI usage', pct: 0, mark: null, reading: '—', aria: 'no reading', note: 'No usage reading yet.' });
  return out;
}
// the one time format (plain.js whenText): "today 14:22", "tomorrow 14:22", "Nov 17 03:25"
export function dayTime(t, tz) { return when(t, tz); }
