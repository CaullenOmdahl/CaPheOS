// Halt (Halt.dc.html): soft halt with deadline/escalate/why, hard halt, settling progress, resume.
import { h, fill, Button, Tag, Eyebrow, errLine, hhmm, rel, statusOf, humanError } from '../ui.js';
import { api, post } from '../api.js';
import * as events from '../events.js';

export async function render(root, ctx) {
  const { app } = ctx;
  root.className = 'main gap-32';
  const tz = app.company && app.company.timezone;
  const head = h('div'); const body = h('div', { class: 'stack-20', style: 'gap:32px' }); const errEl = h('div');
  fill(root, head, errEl, body,
    h('p', { class: 'caption muted', style: 'max-width:720px' }, "Each crew member's soft-shutdown procedure is written in its charter, under “Soft shutdown”. The halt guardrail can never be switched off."));
  const focus = ctx.query.get('mode');
  let busy = false, lastMode = null;

  async function load() {
    let st;
    try { st = await api('/halt'); fill(errEl); } catch (e) { fill(errEl, errLine(e, 'Halt status')); st = { mode: 'unknown' }; }
    const m = st.mode;
    const title = m === 'soft' ? (st.settledAt ? 'Soft halt complete.' : 'Soft halt in progress.') : m === 'hard' ? 'Hard halt.' : 'Stop the company.';
    const lede = m === 'soft' ? (st.settledAt ? 'Nothing is running. Resume when you are ready.' : 'Nothing new is starting. Seats are finishing and running their shutdown procedures.')
      : m === 'hard' ? 'Every run was stopped at once.' : 'Choose how. A soft halt lets running work finish safely; a hard halt cuts it off now.';
    const eyebrow = m === 'soft' ? ['Soft halt', 'started ' + hhmm(st.at, tz) + (st.by ? ' by ' + st.by : '')] : m === 'hard' ? ['Hard halt', hhmm(st.at, tz) + (st.by ? ' by ' + st.by : '')] : [m === 'running' ? 'Running' : 'Status unknown'];
    fill(head, h('header', { class: 'stack-12', style: 'max-width:760px' }, Eyebrow(eyebrow), h('h1', { class: 'h1' }, title), h('p', { class: 'body-l muted' }, lede)));
    if (m !== 'running' && m !== 'unknown') lastMode = m;
    if (m === 'soft') { fill(body, settling(st), commitmentsEl); loadCommitments(); return; }
    if (m === 'hard') return fill(body, h('section', { class: 'inverse between', style: 'align-items:center;gap:16px;padding:28px' },
      h('div', { class: 'stack-6' }, h('h2', { class: 'h3' }, 'Everything is stopped.'),
        h('span', { class: 'body-s', style: 'color:var(--text-on-inverse-muted)' }, (st.why ? 'Why: ' + st.why + '. ' : '') + 'Transcripts are kept; nothing restarts until you resume.')),
      Button('Resume', { variant: 'inverse', onClick: resume })));
    if (lastMode !== m) fill(body, choose());
    lastMode = m;
  }

  function choose() {
    const sel = h('select', { class: 'select', id: 'h-deadline' }, [['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['', 'The default']].map(([v, l]) => h('option', { value: v }, l)));
    const esc = h('input', { type: 'checkbox', id: 'h-esc' });
    const why = h('input', { type: 'text', id: 'h-why', class: 'input', placeholder: 'Pausing for the weekend' });
    const hwhy = h('input', { type: 'text', id: 'h-hwhy', class: 'input', placeholder: 'Something is going wrong' });
    const softErr = h('p', { class: 'err-line', role: 'status' }), hardErr = h('p', { class: 'err-line', role: 'status' });
    const soft = h('article', { class: 'card p28', style: 'border-color:var(--border-strong)' + (focus === 'soft' ? ';box-shadow:var(--focus-ring)' : ''), 'aria-labelledby': 'h-soft' },
      h('h2', { id: 'h-soft', class: 'h3' }, 'Soft halt'),
      h('p', { class: 'body-s' }, 'Nothing new starts. Work already running finishes. Each seat runs its own soft-shutdown procedure, for example a trading desk closing or hedging positions and cancelling resting orders.'),
      h('label', { class: 'stack-6 body-s', for: 'h-deadline' }, h('span', { class: 'label strong' }, 'Give it up to'), sel),
      h('label', { class: 'check', for: 'h-esc' }, esc, 'Hard halt if anything is still running at the deadline'),
      h('label', { class: 'stack-6 body-s', for: 'h-why' }, h('span', { class: 'label strong' }, 'Why (the crew sees this)'), why),
      h('button', { type: 'button', class: 'btn btn-dark btn-tall', onclick: async () => {
        if (busy) return; busy = true; softErr.textContent = '';
        try { await post('/halt/soft', { why: why.value.trim() || undefined, deadlineMin: sel.value ? Number(sel.value) : undefined, escalate: esc.checked }); app.toast('Soft halt started.'); }
        catch (e) { softErr.textContent = 'Not started: ' + humanError(e); }
        busy = false; load(); app.refreshSidebar();
      } }, 'Start soft halt'), softErr);
    const hard = h('article', { class: 'card p28', style: 'border-color:var(--status-danger)' + (focus === 'hard' ? ';box-shadow:0 0 0 3px rgba(180,35,24,.25)' : ''), 'aria-labelledby': 'h-hard' },
      h('h2', { id: 'h-hard', class: 'h3', style: 'color:var(--status-danger)' }, 'Hard halt'),
      h('p', { class: 'body-s' }, 'Every run stops now, mid-step. Schedules, lines and away work stop with it. Use it when something is going wrong faster than a soft halt can settle.'),
      h('label', { class: 'stack-6 body-s', for: 'h-hwhy' }, h('span', { class: 'label strong' }, 'Why (optional)'), hwhy),
      h('button', { type: 'button', class: 'btn btn-danger btn-tall', style: 'margin-top:auto', onclick: () => hardHalt(hwhy.value.trim(), hardErr) }, 'Hard halt now'), hardErr);
    return h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px' }, soft, hard);
  }

  function settling(st) {
    const err = h('p', { class: 'err-line', role: 'status' });
    const rows = (st.shutdowns || []).map(s => {
      const state = s.done ? 'Done' + (s.lastStatus ? ' (' + s.lastStatus + ')' : '') : s.overdue ? 'Overdue' : s.status === 'fired' ? 'Shutting down' : s.status || 'Pending';
      return h('li', { class: 'between-c hair-top', style: 'padding:14px 0' },
        h('span', { class: 'stack-4' }, h('span', { class: 'label strong' }, s.seat || s.name || '?'), h('span', { class: 'body-s muted' }, (s.routine || '') + (s.maxMinutes ? ' · up to ' + s.maxMinutes + ' min' : ''))),
        Tag(state, { variant: 'status', status: s.done ? 'online' : s.overdue ? 'danger' : 'warning' }));
    });
    const left = (st.left || []).map(x => h('li', { class: 'between-c hair-top', style: 'padding:14px 0' }, h('span', { class: 'body-s strong' }, String(x)), Tag('Finishing', { variant: 'status', status: 'warning' })));
    return h('section', { 'aria-labelledby': 'settle', class: 'card p28', style: 'gap:16px' },
      h('div', { class: 'between' }, h('h2', { id: 'settle', class: 'h3' }, st.settledAt ? 'Settled' : 'Settling'),
        h('span', { class: 'mono muted' }, (st.deadline ? 'deadline ' + hhmm(st.deadline, tz) + ' (' + rel(st.deadline) + ')' : 'no deadline') + ' · ' + (st.escalate ? 'then hard halt' : 'then tell you, no hard halt'))),
      st.why ? h('p', { class: 'body-s' }, 'Why: ' + st.why) : null,
      rows.length || left.length ? h('ul', { class: 'plain' }, rows, left) : h('p', { class: 'body-s muted' }, st.settledAt ? 'Settled ' + rel(st.settledAt) + '. Nothing is running.' : 'No seat has a shutdown procedure; waiting for running work to end.'),
      h('div', { class: 'row-8' },
        h('button', { type: 'button', class: 'btn btn-danger btn-md', onclick: () => hardHalt('', err) }, 'Hard halt now'),
        h('button', { type: 'button', class: 'btn btn-secondary btn-md', onclick: resume }, st.settledAt ? 'Resume' : 'Cancel and resume')),
      err);
  }

  // continuity module (when enabled): open commitments by party and due; reassign or notify a party (gated)
  const commitmentsEl = h('div');
  async function loadCommitments() {
    let d; try { d = await api('/m/continuity/open'); } catch (e) { fill(commitmentsEl); return; }   // module not enabled: nothing to show
    const unowned = new Set(d.unowned || []);
    const err = h('p', { class: 'err-line', role: 'status' });
    const party = (p, cs) => {
      const text = h('input', { type: 'text', class: 'input', placeholder: 'Tell ' + p + ' what happens to their work' });
      return h('div', { class: 'stack-8 hair-top', style: 'padding-top:12px' },
        h('div', { class: 'between-c' }, h('h3', { class: 'h4' }, p),
          p !== '(no party)' ? h('span', { class: 'row-8' }, text, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: async () => {
            err.textContent = ''; try { await post('/m/continuity/notify', { party: p, text: text.value.trim() }); app.toast('Notice queued for ' + p + '.'); text.value = ''; } catch (e) { err.textContent = 'Not sent: ' + humanError(e); }
          } }, 'Notify')) : null),
        h('ul', { class: 'plain' }, cs.map(c => {
          const to = h('input', { type: 'text', class: 'input', placeholder: 'seat id', style: 'max-width:140px' });
          return h('li', { class: 'between-c', style: 'padding:8px 0;gap:12px' },
            h('span', { class: 'stack-4' }, h('span', { class: 'label strong' }, c.title), h('span', { class: 'body-s muted' }, c.id + ' · ' + c.state + ' · due ' + (c.dueAt ? hhmm(c.dueAt, tz) + ' (' + rel(c.dueAt) + ')' : c.ackBy ? 'ack ' + rel(c.ackBy) : '—') + ' · owner ' + (c.owner || 'none'))),
            h('span', { class: 'row-8' }, unowned.has(c.id) ? Tag('Unowned', { variant: 'status', status: 'danger' }) : null, to,
              h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => {
                err.textContent = ''; try { await post('/m/continuity/reassign', { id: c.id, to: to.value.trim() }); app.toast('Reassigned.'); loadCommitments(); } catch (e) { err.textContent = 'Not reassigned: ' + humanError(e); }
              } }, 'Reassign')));
        })));
    };
    fill(commitmentsEl, h('section', { class: 'card p28', style: 'gap:12px' },
      h('div', { class: 'between' }, h('h2', { class: 'h3' }, 'Open commitments'), h('span', { class: 'mono muted' }, d.count + ' open · ' + unowned.size + ' unowned')),
      unowned.size ? h('p', { class: 'body-s' }, 'The soft halt will not report settled while a commitment with a due time has no owner.') : null,
      d.count ? Object.entries(d.byParty || {}).map(([p, cs]) => party(p, cs)) : h('p', { class: 'body-s muted' }, 'No open commitments.'), err));
  }

  async function hardHalt(why, errEl2) {
    const ok = await app.confirmDialog({ title: 'Hard halt now?', body: 'Every run stops mid-step. Schedules, lines and away work stop with it.', confirm: 'Hard halt', danger: true });
    if (!ok) return;
    try { await post('/halt/hard', why ? { why } : {}); app.toast('Hard halt done.'); }
    catch (e) { if (errEl2) errEl2.textContent = 'Hard halt failed: ' + humanError(e); else app.toast(humanError(e), true); }
    load(); app.refreshSidebar();
  }
  async function resume() {
    try { await post('/halt/resume'); app.toast('Resumed.'); } catch (e) { app.toast('Resume failed: ' + humanError(e), true); }
    load(); app.refreshSidebar();
  }

  load();
  const off = events.on('halt', load);
  const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
  return () => { off(); clearInterval(t); };
}
