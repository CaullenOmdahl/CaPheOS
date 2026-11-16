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
      needsErr, allClear, gatesEl, answeredEl),
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

  /* ---- Needs you ---- */
  const replying = new Set(); const drafts = {};
  let lastQs = [];
  async function loadNeeds() {
    let d;
    try { d = await api('/questions'); fill(needsErr); }
    catch (e) { fill(needsErr, errLine(e, 'Questions')); return; }
    const qs = (d.questions || []).filter(q => !isSetupQuestion(q));
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
  function redraw() { fill(gatesEl, lastQs.map(q => gateCard(q, freshIds.has(q.id)))); }
  function gateCard(q, fresh) {
    const p = parseQuestion(q);
    const errEl = h('p', { class: 'err-line', role: 'status' });
    const ta = h('textarea', { rows: '3', class: 'textarea', placeholder: 'Yes, but…', 'aria-label': 'Your answer' });
    ta.value = drafts[q.id] || ''; ta.addEventListener('input', () => { drafts[q.id] = ta.value; });
    const isReplying = replying.has(q.id);
    const answer = async (verdict, text) => {
      errEl.textContent = '';
      card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { await post('/questions/' + encodeURIComponent(q.id) + '/answer', text ? { verdict, text } : { verdict }); replying.delete(q.id); delete drafts[q.id]; freshIds.delete(q.id); app.toast('Answer recorded.'); loadNeeds(); }
      catch (e) { errEl.textContent = 'Not recorded: ' + e.message; card.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    const card = h('article', { class: 'gate' + (fresh ? ' fresh' : ''), 'data-id': q.id, 'aria-labelledby': 'g-' + q.id },
      h('div', { class: 'between-c' },
        h('span', { class: 'row-8', style: 'align-items:center' }, Tag(p.cat, { variant: 'accent' }), fresh ? h('span', { class: 'just-now' }, 'Just now') : null),
        h('span', { class: 'mono muted' }, [q.from, q.id, rel(q.askedAt)].filter(Boolean).join(' · '))),
      h('h3', { id: 'g-' + q.id, class: 'h4' }, p.title),
      p.why ? mdBlock(p.why, 'body-s q-body') : null,
      (p.rec || p.dflt) ? h('div', { class: 'sunken' },
        h('span', { class: 'eyebrow-t' }, 'Recommendation'),
        h('span', { class: 'body-s strong' }, p.rec || '—'),
        p.dflt ? h('span', { class: 'caption muted' }, 'If silent: ' + p.dflt) : null) : null,
      isReplying ? h('label', { class: 'stack-6' }, h('span', { class: 'caption muted' }, 'Your answer goes to ' + (q.from || 'the asker')), ta) : null,
      h('div', { class: 'row-8', style: 'margin-top:auto' },
        Button('Approve', { variant: 'primary', size: 'sm', onClick: () => answer('yes', isReplying ? ta.value.trim() : '') }),
        Button('Decline', { variant: 'secondary', size: 'sm', onClick: () => answer('no', isReplying ? ta.value.trim() : '') }),
        Button(isReplying ? 'Send answer' : 'Reply', { variant: 'ghost', size: 'sm', onClick: () => {
          if (!isReplying) { replying.add(q.id); redraw(); const t = gatesEl.querySelector('[data-id="' + CSS.escape(q.id) + '"] textarea'); if (t) t.focus(); return; }
          if (!ta.value.trim()) { errEl.textContent = 'Write an answer first.'; return; }
          answer('reply', ta.value.trim());
        } }),
        Button('Discuss', { variant: 'ghost', size: 'sm', href: '#/comms/agent:' + encodeURIComponent(ceoId) + '?draft=' + encodeURIComponent('About ' + q.id + ': ') })),
      errEl);
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
          h('span', { class: 'strong' }, parseQuestion(a).title), h('span', { class: 'mono muted' }, String(a.answer || '').slice(0, 60) + (a.answeredAt ? ' · ' + hhmm(a.answeredAt, co.timezone) : '')))))) : null);
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
    const idle = d.seats.filter(s => !s.running).map(s => h('li', { class: 'body-s muted now-idle' }, s.name + ' is idle' +
      (s.loop ? (s.enabled === false ? '; its loop "' + s.loop + '" is switched off' : s.schedulerOn === false ? '; the scheduler is off, so its loop does not run on schedule' : s.nextRunAt ? '; next run ' + hhmm(s.nextRunAt, co.timezone) + ' (' + rel(s.nextRunAt) + ')' : '') : '; it has no loop routine') +
      (s.soonerBecause.length ? ', or sooner: ' + s.soonerBecause.join(', ') : s.wakesOnMessage ? ', or sooner if you message it' : '') + '.'));
    fill(nowEl, h('div', { class: 'between-c' }, h('h2', { id: 'now-h', class: 'h3' }, 'Now'), d.station.up ? null : h('span', { class: 'err-line' }, 'Station not running: nobody can work.')),
      kickEl, runs.length ? h('ul', { class: 'plain stack-8' }, runs) : null, idle.length ? h('ul', { class: 'plain stack-4' }, idle) : null);
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
