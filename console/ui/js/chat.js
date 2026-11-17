// Live chat with a crew member (docs/CONSOLE-API.md "Live chat"): GET /api/chat/<id> loads the conversation (the
// station transcript, so it is there when you come back), POST /api/chat/<id>/send streams the run as NDJSON. The reply
// arrives token by token under a visible "thinking… / writing… / using a tool" state, tool steps are listed compactly,
// Stop cancels the run, approvals the run asks for are answered inline, and every failure says what happened and how to
// fix it. Never silence.
import { composerKeys, COMPOSER_HINT } from './keys.js';
import { h, fill, Button, errLine, empty, hhmm, humanError } from './ui.js';
import { api, post } from './api.js';
import { md, mdBlock } from './md.js';

const stepWords = (name, args) => {
  const a = String(args || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const m = /node\s+(company\/tools\/[\w.-]+\.js)(\s+[\w-]+)?/.exec(a);
  if (m) return 'running ' + m[1].replace('company/tools/', '') + (m[2] || '');
  if (/read/i.test(name)) return 'reading ' + a;
  if (/list/i.test(name)) return 'looking through ' + (a || 'a folder');
  if (/write|append|edit|patch/i.test(name)) return 'writing ' + a;
  if (/web|search|fetch/i.test(name)) return 'searching' + (a ? ': ' + a : '');
  if (/code\.run|shell|terminal/i.test(name)) return 'running ' + (a || 'a command');
  return String(name || 'a tool').replace(/[_.]/g, ' ') + (a ? ' ' + a : '');
};

// liveChat(host, { agentId, app, tz, onUpdate }) -> { load, send, sendBrief, stop, destroy, ta }
export function liveChat(host, opts) {
  const { agentId, app } = opts;
  const tz = opts.tz;
  let info = null, runId = null, ctrl = null, busy = false;
  const banner = h('div', { class: 'chat-banner' });
  const body = h('div', { class: 'chat-body', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Messages' });
  // a rolling window: the message list scrolls on its own, the composer stays put. It follows new messages while you are
  // at the bottom; scroll up to read back and it stays where you are, with a button back to the latest.
  let pinned = true;
  const jump = h('button', { type: 'button', class: 'btn btn-secondary btn-sm chat-jump', hidden: true, onclick: () => { pinned = true; toBottom(); } }, 'Jump to latest ↓');
  const atBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  function toBottom() { body.scrollTop = body.scrollHeight; jump.hidden = true; }
  body.addEventListener('scroll', () => { pinned = atBottom(); if (pinned) jump.hidden = true; if (body.scrollTop < 120) showEarlier(); });
  const PAGE = 40; let older = [];   // turns not rendered yet, oldest first
  const earlierBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm chat-earlier', onclick: () => showEarlier() }, 'Show earlier messages');
  function turnEl(t) { return t.role === 'user' ? mine(t.content) : theirs(t.content, t.at ? name() + ' · ' + hhmm(t.at, tz) : name()); }
  function showEarlier() {
    if (!older.length) return;
    const chunk = older.splice(Math.max(0, older.length - PAGE));
    const before = body.scrollHeight, top = body.scrollTop;
    const anchor = earlierBtn.isConnected ? earlierBtn.nextSibling : body.firstChild;
    for (const t of chunk) body.insertBefore(turnEl(t), anchor);
    if (!older.length) earlierBtn.remove();
    body.scrollTop = top + (body.scrollHeight - before);   // keep the reader's place
  }
  const ta = h('textarea', { id: 'msg', rows: '3', class: 'textarea', placeholder: 'Write…' });
  const sendErr = h('p', { class: 'err-line', role: 'status' });
  const stateEl = h('span', { class: 'chat-state caption muted', role: 'status', 'aria-live': 'polite' }, '');
  const sendBtn = Button('Send', { variant: 'primary', type: 'submit' });
  const stopBtn = Button('Stop', { variant: 'secondary', size: 'sm', onClick: () => stop() });
  stopBtn.hidden = true;
  const form = h('form', { 'aria-label': 'Message', class: 'composer', onsubmit: e => { e.preventDefault(); send(ta.value); } },
    h('label', { for: 'msg', class: 'caption muted' }, 'Live chat: the reply streams in here · ' + COMPOSER_HINT),
    ta, h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('span', { class: 'row-8', style: 'align-items:center' }, stateEl, sendErr), h('span', { class: 'row-8' }, stopBtn, sendBtn)));
  composerKeys(ta, () => send(ta.value), () => { if (busy) stop(); });
  const bodyWrap = h('div', { class: 'chat-scroll' }, body, jump);
  fill(host, banner, bodyWrap, form);

  const name = () => (info && info.agent && info.agent.name) || agentId;
  // a brief a console button sent (the charter) shows as its first line, the full text one click away
  const BRIEF = /^(Let us write the company charter together|Please change company\/CHARTER\.md)/;
  function mine(text) {
    const t = String(text || '');
    if (BRIEF.test(t)) {
      const first = t.split('\n')[0];
      return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me' }, first,
        h('details', { class: 'brief' }, h('summary', { class: 'caption', style: 'cursor:pointer;color:inherit;opacity:.8' }, 'The brief the console sent'), h('div', { class: 'caption', style: 'white-space:pre-wrap;margin-top:6px' }, t.slice(first.length).trim()))));
    }
    return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me' }, t));
  }
  function theirs(text, meta) { return h('div', { class: 'stack-4 msg-them-wrap' }, mdBlock(text, 'msg-them'), meta ? h('span', { class: 'msg-meta' }, meta) : null); }
  function scrollEnd() { if (pinned) toBottom(); else jump.hidden = false; }
  function problemCard(p, kind) {
    return h('div', { class: 'alertbox chat-problem', role: kind === 'error' ? 'alert' : 'status' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, p.message || p.msg || 'Something went wrong.'),
        p.fix ? h('span', { class: 'body-s' }, 'Fix: ' + p.fix) : null),
      p.link ? h('a', { href: p.link, class: 'btn btn-secondary btn-sm' }, 'Open') : null);
  }

  async function load() {
    try { info = await api('/chat/' + encodeURIComponent(agentId)); }
    catch (e) { fill(body, errLine(e, 'Conversation')); return null; }
    ta.placeholder = 'Write to ' + name() + '…';
    fill(banner, (info.problems || []).map(p => problemCard(p)));
    const turns = info.turns || [];
    older = turns.slice(0, Math.max(0, turns.length - PAGE));
    const recent = turns.slice(-PAGE);
    fill(body, turns.length ? [older.length ? earlierBtn : null].concat(recent.map(turnEl)).filter(Boolean)
      : empty('No messages yet. Write below; ' + name() + ' answers here, live.'));
    pinned = true;
    if (info.transcriptError) body.prepend(h('p', { class: 'caption muted' }, 'Earlier messages could not be loaded (' + info.transcriptError + ').'));
    scrollEnd();
    if (opts.onUpdate) opts.onUpdate(info);
    return info;
  }

  function setState(t, cls) { stateEl.textContent = t; stateEl.className = 'chat-state caption ' + (cls || 'muted'); }

  async function stream(payload, shownText) {
    if (busy) { app.toast(name() + ' is still answering. Press Stop first to send something else.', true); return; }
    busy = true; sendErr.textContent = ''; sendBtn.disabled = true; stopBtn.hidden = false; stopBtn.disabled = false;
    const emptyEl = body.querySelector('.empty'); if (emptyEl) emptyEl.remove();
    pinned = true;
    const meBox = shownText ? mine(shownText) : null; if (meBox) body.appendChild(meBox);
    const steps = h('ul', { class: 'chat-steps plain' });
    const reply = h('div', { class: 'md msg-them' });
    const meta = h('span', { class: 'msg-meta' }, '');
    const card = h('div', { class: 'stack-4 msg-them-wrap live' }, h('span', { class: 'chat-who caption' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ' + name() + ' is thinking…'), steps, reply, meta);
    body.appendChild(card); scrollEnd();
    const who = card.firstChild;
    const say = t => { who.lastChild.textContent = ' ' + t; setState(t); };
    say(name() + ' is thinking…');
    let text = '', lead = null, sawEnd = false, failed = null, raf = 0, consentHost = null;
    const render = () => { raf = 0; fill(reply, md(text)); scrollEnd(); };
    const fail = (p) => { failed = p; card.appendChild(problemCard(p, 'error')); };
    ctrl = new AbortController();
    try {
      const res = await fetch('/api/chat/' + encodeURIComponent(agentId) + '/send', { method: 'POST', credentials: 'same-origin', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload) });
      if (!res.ok || !res.body) {
        let msg = res.status + ' ' + res.statusText; try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
        if (res.status === 401) msg = 'Not signed in: open the login link the console printed.';
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      const handle = line => {
        let ev; try { ev = JSON.parse(line); } catch (_) { return; }
        const p = ev.payload || {};
        switch (ev.name) {
          case 'console.user': if (!meBox) body.insertBefore(mine(p.text), card); break;
          case 'console.run': card.dataset.model = p.provider + '/' + p.model; say(name() + ' is thinking… (' + p.provider + ' · ' + p.model + ')'); break;
          case 'console.note': card.insertBefore(h('p', { class: 'caption muted' }, p.message), reply); break;
          case 'console.error': fail(p); break;
          case 'agent.run.start': if (!lead) { lead = p.runId; runId = p.runId; } break;
          case 'agent.token': if (lead && p.runId && p.runId !== lead) break; text += p.delta || ''; say(name() + ' is writing…'); if (!raf) raf = requestAnimationFrame(render); break;
          case 'agent.tool_call': { if (lead && p.runId !== lead && p.runId) break; const w = stepWords(p.name, p.argsSummary);
            steps.appendChild(h('li', { class: 'chat-step', 'data-call': p.callId || '' }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', { class: 'mono-s' }, w)));
            say(name() + ' is ' + w + '…'); scrollEnd(); break; }
          case 'agent.tool_result': { const li = [...steps.children].find(x => x.dataset.call === String(p.callId || '')); if (li) { li.classList.add(p.ok && !p.isError ? 'ok' : 'bad'); if (p.summary) li.appendChild(h('span', { class: 'caption muted' }, ' — ' + String(p.summary).slice(0, 120))); } break; }
          case 'permission.prompt': consentHost = consentCard(p, card); break;
          case 'permission.response': { const c = card.querySelector('[data-prompt="' + (p.promptId || '') + '"]'); if (c) c.replaceWith(h('p', { class: 'caption muted' }, 'Approval: ' + (p.decision || 'answered') + (p.expired ? ' (no answer in time)' : ''))); break; }
          case 'agent.run.error': if (!lead || !p.runId || p.runId === lead) fail({ message: name() + ' hit an error: ' + (p.message || 'the run failed'), fix: /budget|cap|quota|limit/i.test(p.message || '') ? 'Check the budget in Setup.' : /key|auth|401|403|credential/i.test(p.message || '') ? 'Check the AI provider in Setup.' : null, link: /budget|cap/i.test(p.message || '') ? '#/setup/budget' : /key|auth|401|403|credential/i.test(p.message || '') ? '#/setup/provider' : null }); break;
          case 'agent.run.end': if (lead && p.runId && p.runId !== lead) break; sawEnd = true;
            meta.textContent = name() + ' · ' + hhmm(new Date().toISOString(), tz) + (card.dataset.model ? ' · ' + card.dataset.model : '') + (p.usd ? ' · $' + Number(p.usd).toFixed(4) : '');
            if (p.outcome && /fail|error/.test(p.outcome) && !failed) fail({ message: name() + ' could not finish (' + (p.failureCode || p.reason || p.outcome) + ').' });
            break;
          default: break;
        }
      };
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(l); }
      }
      if (buf.trim()) handle(buf.trim());
      if (raf) { cancelAnimationFrame(raf); } render();
      if (!sawEnd && !failed) fail({ message: 'The answer stopped before ' + name() + ' finished.', fix: 'Send it again.' });
      else if (sawEnd && !text.trim() && !failed) fail({ message: name() + ' finished without writing a reply.', fix: 'Ask again, or look at the steps above.' });
    } catch (e) {
      if (e.name === 'AbortError') { render(); card.appendChild(h('p', { class: 'caption muted' }, 'Stopped.')); }
      else fail({ message: /Failed to fetch|NetworkError/.test(e.message) ? 'The console server is not reachable.' : 'Not sent: ' + humanError(e), fix: e.status === 404 ? 'This crew member is not on the crew any more.' : null });
    } finally {
      who.remove(); card.classList.remove('live');
      busy = false; runId = null; ctrl = null; sendBtn.disabled = false; stopBtn.hidden = true;
      setState(failed ? 'Not answered: see above.' : '', failed ? 'danger' : 'muted');
      if (consentHost && consentHost.isConnected) consentHost.remove();
      scrollEnd();
    }
  }
  function consentCard(p, card) {
    const answer = async d => {
      try { await post('/station/consent', { runId: runId || p.runId, promptId: p.promptId, decision: d }); el.replaceWith(h('p', { class: 'caption muted' }, d === 'deny' ? 'You said no.' : 'You allowed it.')); }
      catch (e) { app.toast('Not answered: ' + humanError(e), true); }
    };
    const el = h('div', { class: 'alertbox', role: 'alertdialog', 'data-prompt': p.promptId || '' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, name() + ' asks to use ' + (p.tool || 'a tool')), h('span', { class: 'mono-s' }, String(p.argsSummary || '').slice(0, 400))),
      h('div', { class: 'row-8' }, Button('Allow once', { variant: 'primary', size: 'sm', onClick: () => answer('once') }), Button('Allow in this chat', { variant: 'secondary', size: 'sm', onClick: () => answer('session') }), Button('No', { variant: 'ghost', size: 'sm', onClick: () => answer('deny') })));
    card.appendChild(el); scrollEnd();
    setState(name() + ' is waiting for your answer…', 'warning');
    return el;
  }
  async function stop() {
    stopBtn.disabled = true;
    if (runId) { try { await post('/station/cancel', { runId }); } catch (e) { app.toast('Stop: ' + humanError(e), true); } }
    if (ctrl) ctrl.abort();
  }
  function send(raw) {
    const text = String(raw || '').trim(); if (!text) return;
    ta.value = '';
    return stream({ text }, text);
  }
  function sendBrief(brief, notes) { return stream({ brief, notes: notes || {} }, null); }
  return { load, send, sendBrief, stop, ta, isBusy: () => busy, destroy: () => { if (ctrl) ctrl.abort(); } };
}
