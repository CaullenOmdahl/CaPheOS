// Today (Main.dc.html): Needs you (live), crew, AI usage, company panels, overnight, message the Founder.
import { h, fill, Button, Tag, Eyebrow, errLine, empty, initial, rel, hhmm, statusOf } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';
import { mountPanels } from '../panels.js';

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
  const ceo = 'the Founder';
  const hr = new Date().getHours();
  const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  let dateLabel = ''; try { dateLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: co.timezone || undefined }).format(new Date()); } catch (_) { dateLabel = new Date().toDateString(); }

  const lede = h('p', { class: 'lede' }, '');
  const askInput = h('input', { id: 'ask', type: 'text', class: 'input', placeholder: 'Tell the Founder something…', autocomplete: 'off' });
  const askErr = h('p', { class: 'err-line', role: 'status' });
  const askForm = h('form', { class: 'ask-form', 'aria-label': 'Message the Founder', onsubmit: async e => {
    e.preventDefault(); const text = askInput.value.trim(); if (!text) return;
    askErr.textContent = '';
    try { await post('/owner/messages', { text }); askInput.value = ''; app.toast('Sent to the company.'); }
    catch (er) { askErr.textContent = 'Not sent: ' + er.message; }
  } }, h('label', { for: 'ask', class: 'sr-only' }, 'Message the Founder'), askInput, Button('Send', { variant: 'primary', type: 'submit' }), askErr);

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
    h('section', { 'aria-labelledby': 'needs', class: 'stack-16' },
      h('div', { class: 'between', style: 'gap:16px' },
        h('div', { class: 'row-8', style: 'align-items:center;gap:12px' }, h('h2', { id: 'needs', class: 'h3' }, 'Needs you'), liveDot),
        h('span', { class: 'caption muted' }, 'Questions land here the moment they are asked. Your self-governance settings decide which ones come to you.')),
      needsErr, allClear, gatesEl, answeredEl),
    h('section', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:32px' },
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Crew right now'), h('a', { href: '#/crew', class: 'body-s' }, 'All crew →')), crewEl),
      h('div', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'AI usage today'), h('a', { href: '#/usage', class: 'body-s' }, 'Usage →')), usageEl)),
    panelsEl,
    h('section', { class: 'stack-16' }, h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Overnight'), h('a', { href: '#/work', class: 'body-s' }, 'All work →')), overnightEl));

  const onLive = e => { liveDot.textContent = e.detail ? 'Live' : 'Polling'; liveDot.classList.toggle('off', !e.detail); };
  document.addEventListener('capheos:live', onLive);

  /* ---- Needs you ---- */
  const replying = new Set(); const drafts = {};
  let lastQs = [];
  async function loadNeeds() {
    let d;
    try { d = await api('/questions'); fill(needsErr); }
    catch (e) { fill(needsErr, errLine(e, 'Questions')); return; }
    const qs = d.questions || [];
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
      p.why ? h('p', { class: 'body-s q-body' }, p.why) : null,
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
        Button('Discuss', { variant: 'ghost', size: 'sm', href: '#/comms/owner?draft=' + encodeURIComponent('About ' + q.id + ': ') })),
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
          const state = st.status || st.state || (d.station === 'down' ? 'Unknown' : st.busy ? 'Working' : 'Idle');
          const doing = st.doing || st.activity || st.task || (s.loop ? s.loop : '');
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

  /* ---- overnight ---- */
  async function loadOvernight() {
    try {
      const d = await api('/dispatch');
      const lines = (d.log || []).map(parseLogLine).filter(x => x.text).slice(-8).reverse();
      fill(overnightEl, lines.length ? h('ol', { class: 'timeline' }, lines.map(e => h('li', null, h('span', { class: 'mono muted' }, e.at),
        h('span', { class: 'body-s' }, e.who ? h('strong', { class: 'strong', style: 'font-weight:600' }, e.who + ' ') : null, e.text))))
        : empty('Nothing in the dispatch log yet.'));
    } catch (e) { fill(overnightEl, errLine(e, 'Dispatch log')); }
  }

  loadNeeds(); loadCrew(); loadUsage(); loadOvernight();
  const stopPanels = mountPanels(panelsEl, 'today', app);
  const offs = [events.on('questions', loadNeeds), events.on('crew', loadCrew), events.on('dispatch', loadOvernight),
  ];
  const usageTimer = setInterval(() => { if (!document.hidden) loadUsage(); }, 60000);
  return () => { offs.forEach(f => f()); stopPanels(); clearInterval(usageTimer); document.removeEventListener('capheos:live', onLive); };
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
