// Today (Main.dc.html): Now (who is running, the current step, Watch, Stop; each seat's next wake), Needs you (live),
// crew, AI usage, company panels, recent activity, and the box that opens a live chat with the Founder.
import { h, fill, Button, Tag, Eyebrow, errLine, empty, initial, rel, hhmm, statusOf, isSetupQuestion } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';
import { mdBlock } from '../md.js';

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
  const cat = g.category || String(q.about || '').replace(/^governance:/, '') || (q.blocking ? 'Blocking' : 'Question');
  return { title, why: rest.join('\n'), rec, dflt, cat: cat.charAt(0).toUpperCase() + cat.slice(1) };
}

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-48';
  const co = app.company || {};
  const ownerName = co.owner && (co.owner.name || co.owner.first || co.owner) || '';
  const ceoId = (co.ceo && co.ceo.id) || 'agent';
  const ceoName = (co.ceo && co.ceo.name) || 'the Founder';
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
    location.hash = '#/comms/agent:' + encodeURIComponent(ceoId);
  } }, h('label', { for: 'ask', class: 'sr-only' }, 'Message ' + ceoName), askInput, Button('Send', { variant: 'primary', type: 'submit' }), askErr);
  const nowEl = h('section', { class: 'stack-12', 'aria-labelledby': 'now-h', 'aria-live': 'polite' });

  const onboardEl = h('div');
  const liveDot = h('span', { class: 'live-dot' + (events.isLive() ? '' : ' off') }, events.isLive() ? 'Live' : 'Polling');
  const needsErr = h('div');
  const gatesEl = h('div', { class: 'gates', 'aria-live': 'polite', 'aria-relevant': 'additions removals' });
  const allClear = h('div');
  const answeredEl = h('div');
  const snoozedEl = h('div');
  const crewEl = h('div'); const usageEl = h('div'); const panelsEl = h('div', { class: 'stack-24' }); const overnightEl = h('div');

  fill(root,
    h('header', { class: 'screen-head', style: 'gap:24px' },
      h('div', { class: 'stack-14', style: 'max-width:720px' }, Eyebrow([dateLabel, co.name]),
        h('h1', { class: 'h1' }, greet + (ownerName ? ', ' + String(ownerName).split(' ')[0] : '') + '.'), lede),
      askForm),
    onboardEl, nowEl,
    h('section', { 'aria-labelledby': 'needs', class: 'stack-16' },
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'row-8', style: 'align-items:center;gap:12px' }, h('h2', { id: 'needs', class: 'h3' }, 'Needs you'), liveDot),
        h('span', { class: 'caption muted' }, 'Questions land here the moment they are asked. Your self-governance settings decide which ones come to you.')),
      needsErr, allClear, gatesEl, snoozedEl, answeredEl),
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:32px' },
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Crew right now'), h('a', { href: '#/crew', class: 'body-s' }, 'All crew →')), crewEl),
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'AI usage today'), h('a', { href: '#/usage', class: 'body-s' }, 'Usage →')), usageEl)),
    panelsEl,
    h('section', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Recent activity'), h('a', { href: '#/work', class: 'body-s' }, 'All work →')), overnightEl));

  // Setup banner: shown until onboard.js --certify is green, or while onboarding still asks something. Onboarding
  // questions are answered in Setup (#/setup), never as an Approve/Decline card here.
  async function loadOnboarding() {
    let d; try { d = await api('/setup'); } catch (_) { fill(onboardEl); return; }
    const asks = (d.onboardingQuestions || []).length;
    if (d.certified && !asks) return fill(onboardEl);
    const next = (d.steps || []).find(s => s.status === 'needs');
    fill(onboardEl, h('section', { class: 'card p22', role: 'status', style: 'border-color:var(--status-warning);gap:10px' },
      h('div', { class: 'between-c', style: 'gap:12px;flex-wrap:wrap' },
        h('div', { class: 'stack-4' }, h('h2', { class: 'h4' }, d.certified ? 'Onboarding asked you something' : 'Finish setup — ' + d.done + ' of ' + d.total + ' done'),
          h('p', { class: 'body-s' }, d.certified ? 'Answer it in Setup.' : next ? 'Next: ' + next.title + '. ' + next.why : 'Run the final check to finish.')),
        Button(d.certified ? 'Open Setup' : 'Continue setup', { variant: 'primary', href: '#/setup' })),
      h('div', { class: 'meter', role: 'img', 'aria-label': d.done + ' of ' + d.total + ' setup steps done' }, h('div', { style: 'width:' + Math.round(d.done / d.total * 100) + '%' }))));
  }
  loadOnboarding();

  const onLive = e => { liveDot.textContent = e.detail ? 'Live' : 'Polling'; liveDot.classList.toggle('off', !e.detail); };
  document.addEventListener('capheos:live', onLive);

  /* ---- Needs you: each question is a form its asker composed (company/tools/inbox.js) ---- */
  const replying = new Set(); const drafts = {};
  let lastQs = []; let snoozedQs = [];
  async function loadNeeds() {
    let d;
    try { d = await api('/questions'); fill(needsErr); }
    catch (e) { fill(needsErr, errLine(e, 'Questions')); return; }
    const all = (d.questions || []).filter(q => !isSetupQuestion(q));
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
  }
  function gateCard(q, fresh) {
    const p = parseQuestion(q);
    const qt = questionText(q);
    const form = q.form && Array.isArray(q.form.actions) && q.form.actions.length ? q.form : { fields: [], actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true }, { id: 'decline', label: 'Decline', verdict: 'no' }] };
    const errEl = h('p', { class: 'err-line', role: 'status' });
    const isReplying = replying.has(q.id);
    const controls = form.fields.map(f => fieldControl(q, f));
    const busy = on => card.querySelectorAll('button, input, textarea, select').forEach(b => { b.disabled = on; });
    const send = async (body, okText) => {
      errEl.textContent = ''; busy(true);
      try {
        const r = await post('/questions/' + encodeURIComponent(q.id) + '/answer', body);
        controls.forEach(c => c.clear && c.clear());
        replying.delete(q.id); delete drafts[q.id]; freshIds.delete(q.id); app.toast(okText || 'Answer recorded.'); loadNeeds(); return r;
      } catch (e) {
        controls.forEach(c => c.onError && c.onError(e));
        errEl.textContent = 'Not recorded: ' + e.message; busy(false);
      }
    };
    const act = a => {
      const values = {}; const replace = {}; const secretNames = {};
      for (const c of controls) {
        if (!c.get) continue;
        const v = c.get(); if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) values[c.f.id] = v;
        if (c.replace && c.replace()) replace[c.f.id] = true;
        if (c.name) secretNames[c.f.id] = c.name();
      }
      if (a.needs === 'none') for (const c of controls) if (c.f.type === 'secret') delete values[c.f.id];
      const body = { action: a.id, values };
      if (Object.keys(replace).length) body.replace = replace;
      if (Object.keys(secretNames).length) body.secretNames = secretNames;
      const stores = controls.some(c => c.f.type === 'secret' && values[c.f.id] !== undefined);
      send(body, stores ? 'Key stored securely. Answer recorded.' : 'Answer recorded.');
    };
    const ta = h('textarea', { rows: '6', class: 'textarea', placeholder: 'Write as much as you need…', 'aria-label': 'Your reply to ' + (q.from || 'the asker') });
    ta.value = drafts[q.id] || ''; ta.addEventListener('input', () => { drafts[q.id] = ta.value; });
    const snoozeMenu = h('div', { class: 'row-8 snooze-menu', hidden: true },
      [['In an hour', 'hour'], ['Tomorrow morning', 'tomorrow'], ['Next week', 'week']].map(([label, k]) => Button(label, { variant: 'ghost', size: 'sm', onClick: async () => {
        const until = snoozeUntil(k);
        try { await post('/questions/' + encodeURIComponent(q.id) + '/snooze', { until: until.toISOString() }); app.toast('Snoozed until ' + whenLabel(until.toISOString(), co.timezone) + '. ' + (q.from || 'The asker') + ' sees that.'); loadNeeds(); }
        catch (e) { errEl.textContent = 'Not snoozed: ' + e.message; }
      } })));
    const seat = q.askerSeat || ceoId;
    const quote = qt.message.split('\n').map(l => '> ' + l).join('\n').slice(0, 600);
    const card = h('article', { class: 'gate' + (fresh ? ' fresh' : ''), 'data-id': q.id, 'data-kind': q.kind || 'approve', 'aria-labelledby': 'g-' + q.id },
      h('div', { class: 'between-c' },
        h('span', { class: 'row-8', style: 'align-items:center' }, Tag(p.cat, { variant: 'accent' }), fresh ? h('span', { class: 'just-now' }, 'Just now') : null),
        h('span', { class: 'mono muted' }, [q.from, q.id, rel(q.askedAt)].filter(Boolean).join(' · '))),
      q.gate && q.gate.summary ? h('h3', { id: 'g-' + q.id, class: 'h4' }, p.title) : null,
      q.gate && q.gate.summary && qt.message.replace(/\.$/, '') === p.title.replace(/\.$/, '') ? null : h('div', q.gate && q.gate.summary ? { class: 'q-message' } : { id: 'g-' + q.id, class: 'q-message' }, mdBlock(qt.message, 'body q-msg')),
      qt.details ? h('details', { class: 'q-details' }, h('summary', { class: 'caption muted' }, 'More detail'), mdBlock(qt.details, 'body-s q-body')) : null,
      controls.length ? h('div', { class: 'stack-12 q-form' }, controls.map(c => c.el)) : null,
      isReplying ? h('label', { class: 'stack-6' }, h('span', { class: 'caption muted' }, 'Your reply goes to ' + (q.from || 'the asker') + ' in your own words.'), ta) : null,
      h('div', { class: 'row-8', style: 'margin-top:auto' },
        form.actions.map(a => Button(a.label, { variant: a.primary ? 'primary' : 'secondary', size: 'sm', onClick: () => act(a) })),
        Button(isReplying ? 'Send reply' : 'Reply', { variant: 'ghost', size: 'sm', onClick: () => {
          if (!isReplying) { replying.add(q.id); redraw(); const t = gatesEl.querySelector('[data-id="' + CSS.escape(q.id) + '"] textarea[aria-label^="Your reply"]'); if (t) t.focus(); return; }
          const text = ta.value.trim(); if (!text) { errEl.textContent = 'Write a reply first.'; return; }
          if (looksLikeKeyText(text)) { errEl.textContent = 'This looks like a key. Use the secure field instead, so it is stored as a file and never written into a message.'; return; }
          send({ verdict: 'reply', text });
        } }),
        Button('Snooze', { variant: 'ghost', size: 'sm', aria: 'Ask me later', onClick: () => { snoozeMenu.hidden = !snoozeMenu.hidden; } }),
        Button('Discuss', { variant: 'ghost', size: 'sm', href: '#/comms/agent:' + encodeURIComponent(seat) + '?draft=' + encodeURIComponent(quote + '\n\nAbout ' + q.id + ': ') })),
      snoozeMenu, errEl);
    return card;
  }
  async function loadAnswered() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    try {
      const d = await api('/questions/answered?since=' + encodeURIComponent(start.toISOString()));
      const rows = d.answered || [];
      fill(answeredEl, rows.length ? h('details', { class: 'hair-top', style: 'padding-top:12px' },
        h('summary', { class: 'label muted', style: 'min-height:32px' }, 'Answered today (' + rows.length + ')'),
        h('ul', { class: 'plain stack-8', style: 'margin-top:8px' }, rows.map(a => h('li', { class: 'between body-s' },
          h('span', { class: 'strong' }, questionText(a).message.slice(0, 120)), h('span', { class: 'mono muted' }, String(a.answer || '').slice(0, 140) + (String(a.answer || '').length > 140 ? '…' : '') + (a.answeredAt ? ' · ' + hhmm(a.answeredAt, co.timezone) : '')))))) : null);
    } catch (e) { fill(answeredEl, errLine(e, 'Answered today')); }
  }

  /* ---- crew ---- */
  async function loadCrew() {
    try {
      const d = await api('/crew');
      const seats = d.seats || [];
      if (!seats.length) return fill(crewEl, empty('No seats in loops.json yet.'));
      fill(crewEl, d.station === 'down' ? h('p', { class: 'err-line' }, 'Station not running: live status unavailable.') : null,
        h('ul', { class: 'plain hair-top' }, seats.map(s => {
          const st = s.station || {};
          const run = nowData && nowData.runs.find(r => r.agentId === s.id);
          const state = run ? 'Working' : st.status || st.state || (d.station === 'down' ? 'Unknown' : st.busy ? 'Working' : 'Idle');
          const doing = run ? cap(run.step || run.label) : st.doing || st.activity || st.task || (s.loop ? s.loop : '');
          return h('li', { class: 'crew-row' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initial(s.name)),
            h('div', { class: 'stack-4', style: 'gap:2px;min-width:0' },
              h('span', { class: 'label strong' }, s.name || s.id, ' ', h('span', { style: 'font-weight:400;color:var(--text-muted)' }, '· ' + (s.title || s.seat || ''))),
              h('span', { class: 'body-s muted ellip' }, doing)),
            Tag(cap(state), { variant: 'status', status: statusOf(state) }));
        })));
    } catch (e) { fill(crewEl, errLine(e, 'Crew')); }
  }

  /* ---- usage ---- */
  async function loadUsage() {
    try {
      const d = await api('/usage');
      fill(usageEl, h('div', { class: 'card', style: 'gap:18px' }, usagePlans(d).map(p => h('div', { class: 'stack-8' },
        h('div', { class: 'between-c' }, h('span', { class: 'label strong' }, p.name), h('span', { class: 'mono muted' }, p.reading)),
        h('div', { class: 'meter', role: 'img', 'aria-label': p.aria }, h('div', { class: p.over ? 'over' : '', style: 'width:' + p.pct + '%' })),
        h('span', { class: 'caption muted' }, p.note)))));
    } catch (e) { fill(usageEl, errLine(e, 'Usage')); }
  }

  /* ---- now: who is running, what step, Watch / Stop; when each seat runs next ---- */
  let nowData = null; const watching = new Map();   // runId -> { el, after, timer }
  async function loadNow() {
    let d, c = null;
    try { [d, c] = await Promise.all([api('/now'), api('/company').catch(() => null)]); }
    catch (e) { fill(nowEl, h('h2', { id: 'now-h', class: 'h3' }, 'Now'), errLine(e, 'Now')); return; }
    nowData = d; drawNow(c);
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
          h('span', { class: 'row-8', style: 'align-items:center;min-width:0;flex:1' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }),
            h('span', { class: 'stack-4', style: 'gap:2px;min-width:0' },
              h('span', { class: 'label strong' }, r.name, h('span', { style: 'font-weight:400;color:var(--text-muted)' }, ' · ', h('a', { href: r.href }, r.label))),
              h('span', { class: 'body-s ellip' }, r.step ? cap(r.step) : r.watched ? 'thinking…' : 'working (started before the console was watching)'))),
          h('span', { class: 'row-8', style: 'align-items:center' }, h('span', { class: 'mono-s muted' }, [dur(r.elapsedSec), r.usd != null ? '$' + Number(r.usd).toFixed(4) : null, r.steps ? r.steps + (r.steps === 1 ? ' step' : ' steps') : null].filter(Boolean).join(' · ')),
            Button(w ? 'Hide' : 'Watch', { variant: 'secondary', size: 'sm', onClick: () => toggleWatch(r) }),
            r.stoppable ? Button('Stop', { variant: 'ghost', size: 'sm', onClick: async () => { if (!await app.confirmDialog({ title: 'Stop ' + r.name + '\'s run?', body: 'The run stops at its next step. Work already saved stays.', confirm: 'Stop it', danger: true })) return; try { await post('/station/cancel', { runId: r.runId }); app.toast('Stop sent.'); } catch (e) { app.toast('Stop: ' + e.message, true); } } }) : null)),
        w ? w.el : null);
      return row;
    });
    // Sprint (start-up): a chip with the end time, the key numbers and an Off button; seats say working / waiting for work
    const sp = d.sprint;
    const sprintEl = sp ? h('div', { class: 'card p18 row-8', role: 'status', style: 'flex-direction:row;flex-wrap:wrap;align-items:center;gap:12px;padding:12px 16px' },
      Tag('Sprint on — ' + (sp.until ? 'until ' + hhmm(sp.until, co.timezone) + ' (' + rel(sp.until) + ')' : sp.untilWhy && /certified/.test(sp.untilWhy) ? 'until certified + 24 h' : 'until you turn it off'), { variant: 'status', status: 'warning' }),
      h('span', { class: 'mono-s muted', style: 'flex:1;min-width:200px' }, [sp.itemsDone + ' done', sp.wakes + ' wakes' + (sp.idleWakeRatio != null ? ' (' + Math.round(sp.idleWakeRatio * 100) + '% did nothing)' : ''),
        '$' + Number(sp.spentUsd || 0).toFixed(2) + ' of $' + Number(sp.budgetUsd || 0).toFixed(2), sp.usdPerItem != null ? '$' + Number(sp.usdPerItem).toFixed(3) + '/item' : null,
        sp.proposalsPerHour != null ? sp.proposalsPerHour + ' proposals/h vs ' + sp.reviewsPerHour + ' reviews/h' : null].filter(Boolean).join(' · ')),
      Button('Off', { variant: 'secondary', size: 'sm', onClick: async () => { if (!await app.confirmDialog({ title: 'Turn Sprint off?', body: 'The company goes back to your base tempo: seats rest their full cooldown again and the wake limits apply.', confirm: 'Turn it off' })) return; try { await post('/cadence/sprint', { on: false }); app.toast('Sprint off.'); loadNow(); } catch (e) { app.toast('Sprint: ' + e.message, true); } } }),
      Button('Tempo', { variant: 'ghost', size: 'sm', href: '#/controls/ticks' })) : null;
    const idle = d.seats.filter(s => !s.running).map(s => sp && s.sprint ? h('li', { class: 'body-s muted now-idle' }, s.name + (s.sprint === 'working' ? ': working — ' + s.soonerBecause.join(', ') + '; starts as soon as the next tick sees it' : ': waiting for work') + '.') : h('li', { class: 'body-s muted now-idle' }, s.name + ' is idle' +
      (s.loop ? (s.enabled === false ? '; its loop "' + s.loop + '" is switched off' : s.schedulerOn === false ? '; the scheduler is off, so its loop does not run on schedule' : s.nextRunAt ? '; next run ' + hhmm(s.nextRunAt, co.timezone) + ' (' + rel(s.nextRunAt) + ')' : '') : '; it has no loop routine') +
      (s.soonerBecause.length ? ', or sooner: ' + s.soonerBecause.join(', ') : s.wakesOnMessage ? ', or sooner if you message it' : '') + '.'));
    fill(nowEl, h('div', { class: 'between-c' }, h('h2', { id: 'now-h', class: 'h3' }, 'Now'), d.station.up ? null : h('span', { class: 'err-line' }, 'Station not running: nobody can work.')),
      sprintEl, kickEl, runs.length ? h('ul', { class: 'plain stack-8' }, runs) : null, idle.length ? h('ul', { class: 'plain stack-4' }, idle) : null);
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
        if (!d.known) status.textContent = 'This run started before the console was watching; new steps appear as they happen. The full transcript is in Comms once it ends.';
        for (const e of d.events || []) {
          st.after = Math.max(st.after, e.seq);
          if (e.name === 'tool') steps.appendChild(h('li', { class: 'chat-step', 'data-call': e.callId || '' }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono-s' }, e.text)));
          else if (e.name === 'result') { const li = [...steps.children].find(x => x.dataset.call === String(e.callId || '')); if (li) li.classList.add(e.ok ? 'ok' : 'bad'); }
          else if (e.name === 'token') st.raw += e.delta || '';
          else if (e.name === 'error') steps.appendChild(h('li', { class: 'danger body-s' }, e.message));
        }
        fill(text, mdBlock(st.raw.slice(-4000)));
        if (d.done) { status.textContent = 'Finished: ' + (d.outcome || 'done') + (d.usd ? ' · $' + Number(d.usd).toFixed(4) : '') + '.'; return; }
        if (d.known) status.textContent = 'Live.';
      } catch (e) { status.textContent = 'Watch: ' + e.message; }
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
        return h('li', null, h('span', { class: 'mono muted' }, hhmm(e.at, co.timezone)),
          h('span', { class: 'stack-4', style: 'gap:2px' },
            h('span', { class: 'body-s row-8', style: 'align-items:center;flex-wrap:wrap' }, h('strong', { class: 'strong', style: 'font-weight:600' }, e.title), o ? Tag(o[0], { variant: 'status', status: o[1] }) : null, e.usd ? h('span', { class: 'mono-s muted' }, '$' + Number(e.usd).toFixed(4)) : null),
            e.text ? mdBlock(e.text, 'body-s muted') : null,
            (e.links || []).length ? h('span', { class: 'row-8 caption' }, e.links.slice(0, 4).map(l => h('a', { href: l.href }, l.label + ' →'))) : null));
      })) : empty('Nothing has happened yet. Runs, hires, replies and decisions show here as they happen.'));
    } catch (e) { fill(overnightEl, errLine(e, 'Recent activity')); }
  }

  loadNeeds(); loadCrew(); loadUsage(); loadOvernight(); loadNow();
  const stopPanels = mountPanels(panelsEl, 'today', app);
  const offs = [events.on('questions', () => { loadNeeds(); loadOnboarding(); }), events.on('crew', loadCrew), events.on(['dispatch', 'activity', 'owner'], loadOvernight),
    events.on(['now', 'crew', 'dispatch'], () => { loadNow(); loadCrew(); }), events.on('handoffs', loadNow),
  ];
  // elapsed time ticks while something runs; a slow poll keeps "Now" honest when SSE is down
  const nowTimer = setInterval(() => { if (document.hidden) return; if (nowData && nowData.runs.length) loadNow(); }, 5000);
  const usageTimer = setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
  return () => { offs.forEach(f => f()); stopPanels(); clearInterval(usageTimer); clearInterval(nowTimer); for (const w of watching.values()) clearTimeout(w.timer); document.removeEventListener('capheos:live', onLive); };
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
function whenLabel(iso, tz) {
  try { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }).format(new Date(iso)); } catch (_) { return new Date(iso).toLocaleString(); }
}
let fieldSeq = 0;
/* one form field -> { f, el, get?, clear?, replace?, name?, onError? }. A secret's value lives only in its input. */
function fieldControl(q, f) {
  const uid = 'qf-' + q.id + '-' + f.id + '-' + (++fieldSeq);
  const help = f.help ? mdBlock(f.help, 'caption muted') : null;
  const lab = (text, forId) => h('label', { for: forId, class: 'label strong' }, text, f.required ? null : (/optional/i.test(text || '') ? null : h('span', { class: 'caption muted' }, ' (optional)')));
  if (f.type === 'info') return { f, el: h('div', { class: 'q-info' }, mdBlock(f.text, 'body-s')) };
  if (f.type === 'text') {
    const el = f.multiline ? h('textarea', { id: uid, rows: f.required ? '4' : '2', class: 'textarea', placeholder: f.placeholder || '', maxlength: f.maxLength || null }) : h('input', { id: uid, type: 'text', class: 'input', placeholder: f.placeholder || '', maxlength: f.maxLength || null });
    const count = (f.minLength || f.maxLength) ? h('span', { class: 'caption muted' }) : null;
    const upd = () => { if (count) count.textContent = el.value.trim().length + (f.maxLength ? ' / ' + f.maxLength : '') + ' characters' + (f.minLength ? ' (at least ' + f.minLength + ')' : ''); };
    el.addEventListener('input', upd); upd();
    return { f, el: h('div', { class: 'stack-6' }, lab(f.label, uid), help, el, count), get: () => el.value.trim(), clear: () => { el.value = ''; } };
  }
  if (f.type === 'secret') {
    // password input (or a masked textarea for a multi-line PEM key); never autofilled, never echoed back
    let multi = !!f.multiline;
    const attrs = { id: uid, class: 'input secret-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'aria-describedby': uid + '-note' };
    const one = h('input', Object.assign({ type: 'password', name: 'q-secret-' + f.id }, attrs));
    const many = h('textarea', Object.assign({}, attrs, { class: 'textarea secret-input secret-mask', rows: '4', placeholder: 'Paste the key (a multi-line private key is fine)' }));
    const slot = h('div'); fill(slot, multi ? many : one);
    let shown = false;
    const showBtn = Button('Show', { variant: 'ghost', size: 'sm', aria: 'Show or hide the key', onClick: () => { shown = !shown; one.type = shown ? 'text' : 'password'; many.classList.toggle('secret-mask', !shown); showBtn.textContent = shown ? 'Hide' : 'Show'; } });
    const multiBtn = Button(multi ? 'One line' : 'Multi-line key', { variant: 'ghost', size: 'sm', onClick: () => { const v = (multi ? many : one).value; multi = !multi; (multi ? many : one).value = v; one.value = multi ? '' : one.value; many.value = multi ? many.value : ''; fill(slot, multi ? many : one); multiBtn.textContent = multi ? 'One line' : 'Multi-line key'; } });
    const replace = h('input', { type: 'checkbox', id: uid + '-replace' });
    const nameIn = f.hinted ? h('input', { type: 'text', class: 'input mono', id: uid + '-name', value: f.name, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'File name under secrets/' }) : null;
    const note = h('span', { id: uid + '-note', class: 'caption muted' }, 'Stored on the console machine at secrets/' + f.name + ' (owner-only, mode 0600). It is never shown again and never goes into a message; ' + (q.from || 'the asker') + ' only learns where it is.');
    if (nameIn) nameIn.addEventListener('input', () => { note.textContent = 'Stored at secrets/' + (nameIn.value.trim() || '…') + ' (owner-only, mode 0600). Never shown again, never sent in a message.'; });
    const body = h('div', { class: 'stack-6 q-secret' }, lab(f.label, uid), f.provider ? h('span', { class: 'caption' }, 'Where to get it: ', mdBlock(f.provider, 'caption')) : null, help,
      h('div', { class: 'row-8', style: 'align-items:flex-start;flex-wrap:nowrap' }, h('div', { style: 'flex:1;min-width:0' }, slot), showBtn, multiBtn),
      nameIn ? h('label', { class: 'stack-4' }, h('span', { class: 'caption muted' }, 'File name under secrets/'), nameIn) : null,
      h('label', { class: 'check', for: uid + '-replace' }, replace, 'Replace the stored key if secrets/' + f.name + ' already exists'), note);
    const el = f.hinted ? h('details', { class: 'q-secret-hint' }, h('summary', { class: 'label' }, 'Asked for a key? Store it securely instead of pasting it'), body) : body;
    return { f, el, get: () => { const v = (multi ? many : one).value; return v.trim() ? v : undefined; }, clear: () => { one.value = ''; many.value = ''; },
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
  const markRow = listId ? h('div', { class: 'caption muted q-range-marks' }, f.marks.map(m => h('span', { style: 'left:' + ((m.value - f.min) / (f.max - f.min) * 100) + '%' }, m.label))) : null;
  return { el: h('div', { class: 'stack-4 q-slider' }, say, el, marks, markRow, ends), get: () => Number(el.value), input: el, set: v => { el.value = String(v); upd(); } };
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

export function parseLogLine(line) {
  const s = String(line || '').replace(/^[-*]\s*/, '').trim();
  if (!s || /^#/.test(s)) return { text: '' };
  const m = /^(?:\*\*)?(?:(\d{4}-\d\d-\d\d)[T ])?(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?(?:\*\*)?\s*[-–—:]?\s*(.*)$/.exec(s);
  return m ? { at: m[2], text: m[3].replace(/\*\*/g, '') } : { at: '', text: s.replace(/\*\*/g, '') };
}

// pacer status → meter rows (Claude / MiniMax plans, metered DeepSeek)
export function usagePlans(d) {
  const out = [];
  for (const k of ['claude', 'minimax']) {
    const p = d && d[k]; if (!p) continue;
    const used = p.usedToday != null ? p.usedToday : p.usedPct;
    const line = p.line;
    const known = p.known && used != null;
    const pct = known && line ? Math.min(100, Math.round(used / line * 100)) : known ? Math.min(100, Math.round(used)) : 0;
    out.push({ name: p.label || k, pct, over: known && line != null && used > line,
      reading: known ? round(used) + '%' + (line != null ? ' of ' + round(line) + '% today' : '') : 'no reading',
      aria: (p.label || k) + (known ? ': ' + round(used) + ' percent used' + (line != null ? ', daily line ' + round(line) + ' percent' : '') : ': no reading'),
      note: p.why || (p.weekEnd ? 'Week resets ' + new Date(p.weekEnd).toLocaleString() : '') });
  }
  if (d && d.deepseek) {
    const p = d.deepseek;
    out.push({ name: p.label || 'Metered', pct: 0, reading: p.open ? 'open' : 'closed', aria: (p.label || 'Metered') + (p.open ? ' open' : ' closed'), note: p.why || '' });
  }
  if (d && d.rail && d.rail.known) out.push({ name: 'Station spend rail', pct: Math.min(100, Math.round(d.rail.pct || 0)), over: d.rail.pressure, reading: Math.round(d.rail.pct || 0) + '% of $' + d.rail.perDay, aria: 'Station spend rail ' + Math.round(d.rail.pct || 0) + ' percent', note: d.rail.source || '' });
  if (!out.length) out.push({ name: 'Pacer', pct: 0, reading: '—', aria: 'no pacer reading', note: 'The pacer returned no plans.' });
  return out;
}
function round(n) { return Math.round(Number(n) * 10) / 10; }
