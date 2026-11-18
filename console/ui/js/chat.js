// Live chat with a crew member (docs/CONSOLE-API.md "Live chat"): GET /api/chat/<id> loads the conversation (the
// station transcript, so it is there when you come back), POST /api/chat/<id>/send streams the run as NDJSON. The reply
// arrives token by token under a visible "thinking… / writing… / using a tool" state, tool steps are listed compactly,
// Stop cancels the run, approvals the run asks for are answered inline, and every failure says what happened and how to
// fix it. Never silence.
import { composerKeys, COMPOSER_HINT } from './keys.js';
import { h, fill, Button, errLine, empty, when, humanError } from './ui.js';
import { api, post } from './api.js';
import { md, mdBlock } from './md.js';
import { actionsBlock } from './chat-actions.js';
import { blockStates, parseActionReply } from './actions-schema.js';
import { personName, modelName, toolStep, toolStepResult } from './plain.js';
import { leakedToolCalls } from './leaked-tools.js';

const stepWords = toolStep;

// liveChat(host, { agentId, app, tz, onUpdate }) -> { load, send, sendBrief, stop, destroy, ta }
export function liveChat(host, opts) {
  const { agentId, app } = opts;
  const tz = opts.tz;
  let info = null, runId = null, ctrl = null, busy = false, curL = null;
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
  // chat actions (chat-actions.js): each block's state from the transcript (answered by a later reply, superseded by a
  // later block with the same id), and the latest block per id (a newer one expires the older)
  let states = new Map(); const registry = new Map();
  const actionsFor = (i, at) => block => actionsBlock(block, { state: (states.get(i) || new Map()).get(block.id), at, who: name(), tz, app, registry, send: sendAction });
  function turnEl(t, i) { return t.role === 'user' ? mine(t.content) : theirs(t.content, t.at ? name() + ' · ' + when(t.at, tz) : name(), { actions: actionsFor(i, t.at), cut: t.cut, commandAsk: t.commandAsk, ownerAsk: t.ownerAsk }); }
  function showEarlier() {
    if (!older.length) return;
    const chunk = older.splice(Math.max(0, older.length - PAGE));
    const before = body.scrollHeight, top = body.scrollTop;
    const anchor = earlierBtn.isConnected ? earlierBtn.nextSibling : body.firstChild;
    const base = older.length; chunk.forEach((t, k) => body.insertBefore(turnEl(t, base + k), anchor));
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
    h('label', { for: 'msg', class: 'caption muted' }, COMPOSER_HINT),
    ta, h('div', { class: 'between-c', style: 'flex-wrap:wrap;gap:8px' }, h('span', { class: 'row-8', style: 'align-items:center' }, stateEl, sendErr), h('span', { class: 'row-8' }, stopBtn, sendBtn)));
  composerKeys(ta, () => send(ta.value), () => { if (busy) stop(); });
  const bodyWrap = h('div', { class: 'chat-scroll' }, body, jump);
  fill(host, banner, bodyWrap, form);

  const name = () => personName(info && info.agent && info.agent.name) || agentId;
  // a brief a console button sent (the charter) shows as its first line, the full text one click away
  const BRIEF = /^(Let us write the company charter together|Please change company\/CHARTER\.md)/;
  function mine(text) {
    const ar = parseActionReply(text);
    if (ar) return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me action-reply', 'data-reply-id': ar.reply.id }, ar.shown));
    const t = String(text || '');
    if (BRIEF.test(t)) {
      const first = t.split('\n')[0];
      return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me' }, first,
        h('details', { class: 'brief' }, h('summary', { class: 'caption', style: 'cursor:pointer;color:inherit;opacity:.8' }, 'The brief the console sent'), h('div', { class: 'caption', style: 'white-space:pre-wrap;margin-top:6px' }, t.slice(first.length).trim()))));
    }
    return h('div', { class: 'stack-4', style: 'align-self:flex-end;align-items:flex-end' }, h('div', { class: 'msg-me' }, t));
  }
  function theirs(text, meta, opts) {
    const lk = leakedToolCalls(text);
    return h('div', { class: 'stack-4 msg-them-wrap' }, lk ? h('div', { class: 'msg-them' }, leakNode(lk)) : mdBlock(text, 'msg-them', opts),
      opts && opts.cut ? h('p', { class: 'caption muted chat-cut' }, 'This reply was cut off before ' + name() + ' finished (' + opts.cut + ').') : null,
      opts && opts.commandAsk ? commandNotice(opts.commandAsk) : null,
      opts && opts.ownerAsk && !opts.commandAsk ? scopeNotice(opts.ownerAsk) : null,
      meta ? h('span', { class: 'msg-meta' }, meta) : null);
  }
  // a reply that tells the owner to run a command (the server's check, console/command-ask.js): the owner never needs a
  // terminal, so say so and point at the console action, or ask the crew member to use one
  function commandNotice(ca) {
    const a = ca.action;
    const ask = () => send('You asked me to run a command' + (ca.command ? ' (' + ca.command + ')' : '') + '. I do not use a terminal. Do it with your own tools, a console action, an approval on Today or a handoff to the tools seat, and tell me only what you need me to decide.');
    return h('div', { class: 'alertbox command-ask', role: 'status' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, 'This asks you to run a command.'),
        h('span', { class: 'body-s' }, 'You don\'t need a terminal for this: ', a ? h('a', { href: a.href, class: 'command-ask-link' }, a.label) : 'tell ' + name() + ' to use a console action.')),
      a ? null : Button('Ask for a console action', { variant: 'secondary', size: 'sm', onClick: () => { if (busy) { app.toast(name() + ' is still answering. Press Stop first.', true); return; } ask(); } }));
  }
  // a reply that puts crew work to the owner, or asks in technical words (the server's owner-scope lint, console/command-ask.js)
  function scopeNotice(oa) {
    const seat = oa.route && oa.route !== 'framework' ? 'the ' + oa.route + ' seat' : oa.route === 'framework' ? 'a framework request' : null;
    const text = oa.kind === 'crew-scope'
      ? 'This is the crew\'s job, not yours. You can tell ' + name() + ' to handle it' + (seat ? ' or hand it to ' + seat : '') + '.'
      : 'This asks you in technical words. You can ask ' + name() + ' to say it plainly.';
    const msg = oa.kind === 'crew-scope'
      ? 'That is crew work, not a question for me: handle it yourself' + (seat ? ' or hand it to ' + seat : '') + '. Ask me only for money, accounts in my name, legal or commitment decisions, or company direction.'
      : 'Please ask me that again in two plain sentences: what you need, what I get, and what happens if I skip it.';
    return h('div', { class: 'alertbox command-ask', role: 'status' },
      h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, oa.kind === 'crew-scope' ? 'The crew can handle this.' : 'This is hard to follow.'), h('span', { class: 'body-s' }, text)),
      Button(oa.kind === 'crew-scope' ? 'Tell them to handle it' : 'Ask for plain words', { variant: 'secondary', size: 'sm', onClick: () => { if (busy) { app.toast(name() + ' is still answering. Press Stop first.', true); return; } send(msg); } }));
  }
  // a reply as the page shows it: markdown, or (tool calls written out as text) the leak card, never markdown
  function replyNodes(text, o) { const lk = leakedToolCalls(text); return lk ? leakNode(lk, o && o.live) : md(text, o); }
  function leakNode(lk, live) {
    const n = lk.count;
    return h('div', { class: 'leaked-tools stack-8' },
      h('div', { class: 'alertbox leaked-tools-note', role: 'status' },
        h('div', { class: 'stack-4' }, h('span', { class: 'label strong' }, name() + ' wrote ' + n + ' command' + (n === 1 ? '' : 's') + ' as text instead of running them'),
          h('span', { class: 'body-s' }, 'Nothing was run. Ask again and ' + name() + ' runs them with its tools.')),
        live ? null : Button('Ask again', { variant: 'secondary', size: 'sm', onClick: () => askAgain() })),
      lk.prose ? h('div', { class: 'leaked-prose' }, lk.prose) : null,   // plain text (textContent): no markdown, so no _italics_ in paths
      h('details', { class: 'leaked-raw' }, h('summary', { class: 'caption' }, 'Details: the reply as written (' + n + ' command' + (n === 1 ? '' : 's') + ')'), h('pre', { class: 'md-pre' }, lk.raw)));
  }
  function askAgain() {
    if (busy) { app.toast(name() + ' is still answering. Press Stop first.', true); return; }
    send('You wrote those commands out as text, so nothing ran. Run them with your tools (the terminal and file tools you have in this chat), then answer my last message.');
  }
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
    if (busy) { if (opts.onUpdate) opts.onUpdate(info); return info; }   // a reply is live on the page: keep it
    const turns = info.turns || [];
    states = blockStates(turns); registry.clear();
    older = turns.slice(0, Math.max(0, turns.length - PAGE));
    const recent = turns.slice(-PAGE); const off = older.length;
    fill(body, turns.length ? [older.length ? earlierBtn : null].concat(recent.map((t, k) => turnEl(t, off + k))).filter(Boolean)
      : empty('No messages yet. Write below; ' + name() + ' answers here, live.'));
    pinned = true;
    if (info.transcriptError) body.prepend(h('p', { class: 'caption muted' }, 'Earlier messages could not be loaded (' + info.transcriptError + ').'));
    scrollEnd();
    if (opts.onUpdate) opts.onUpdate(info);
    // a reply still being written (a reload, or the console restarted under this page): follow it again
    if (info.inflight) resume(info.inflight);
    return info;
  }

  function setState(t, cls) { stateEl.textContent = t; stateEl.className = 'chat-state caption ' + (cls || 'muted'); }

  /* The live reply. POST /send streams the opening lines, console.attached {runId}, then the run's journal (console/chat-runs.js)
     up to console.final {text, complete} and console.end. When the stream breaks before console.end (a console restart, a
     network blip) the card stays live and re-attaches with GET /attach?runId=&from=<lines it has>; after a page reload load()
     finds info.inflight and re-attaches from line 0. A reply is shown as finished only on console.final, and one that did
     not complete says so. (An older console that never sends console.attached: the stream's end is the run's end.) */
  function liveCard(shownText) {
    const emptyEl = body.querySelector('.empty'); if (emptyEl) emptyEl.remove();
    pinned = true;
    const meBox = shownText ? mine(shownText) : null; if (meBox) body.appendChild(meBox);
    const steps = h('ul', { class: 'chat-steps plain' });
    // the steps show while the reply is written, then fold away under one line the owner can open
    const stepsBox = h('details', { class: 'chat-steps-box', open: true }, h('summary', { class: 'caption muted' }, 'Working…'), steps);
    const reply = h('div', { class: 'md msg-them' });
    const meta = h('span', { class: 'msg-meta' }, '');
    const card = h('div', { class: 'stack-4 msg-them-wrap live' }, h('span', { class: 'chat-who caption' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), ' ' + name() + ' is thinking…'), stepsBox, reply, meta);
    body.appendChild(card); scrollEnd();
    return { card, steps, stepsBox, reply, meta, who: card.firstChild, userShown: !!meBox, text: '', lead: null, sawEnd: false, failed: null, raf: 0, consentHost: null,
      final: false, attached: false, count: 0, gotEnd: false, finalP: null, userStop: false, noted: {} };
  }
  async function stream(payload, shownText) {
    if (busy) { app.toast(name() + ' is still answering. Press Stop first to send something else.', true); return; }
    const L = liveCard(shownText);
    return follow(L, () => fetch('/api/chat/' + encodeURIComponent(agentId) + '/send', { method: 'POST', credentials: 'same-origin', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload) }));
  }
  // re-attach to a run in flight (after a reload): the journal from its first line
  function resume(inflight) {
    if (busy || !inflight || !inflight.runId) return;
    const L = liveCard(null);
    L.attached = true; L.lead = inflight.runId; runId = inflight.runId;
    return follow(L, null);
  }
  async function follow(L, first) {
    curL = L;
    busy = true; sendErr.textContent = ''; sendBtn.disabled = true; stopBtn.hidden = false; stopBtn.disabled = false;
    const { card, steps, reply, meta, who } = L;
    const say = t => { if (who.isConnected) who.lastChild.textContent = ' ' + t; setState(t); };
    say(name() + ' is thinking…');
    const liveActions = block => L.final ? actionsBlock(block, { state: null, at: new Date().toISOString(), who: name(), tz, app, registry, send: sendAction }) : h('p', { class: 'caption muted chat-actions-pending' }, 'Preparing buttons…');
    const render = () => { L.raf = 0; fill(reply, replyNodes(L.text, { actions: liveActions, live: !L.final })); scrollEnd(); };
    const fail = (p) => { L.failed = p; card.appendChild(problemCard(p, 'error')); };
    const note = (k, t) => { if (L.noted[k]) return; L.noted[k] = h('p', { class: 'caption muted chat-note', 'data-note': k }, t); card.insertBefore(L.noted[k], reply); };
    const unnote = k => { if (L.noted[k]) { L.noted[k].remove(); delete L.noted[k]; } };
    const handle = line => {
      let ev; try { ev = JSON.parse(line); } catch (_) { return; }
      if (L.attached && ev.name !== 'console.attached') L.count++;
      const p = ev.payload || {};
      switch (ev.name) {
        case 'console.attached': L.attached = true; L.count = 0; L.lead = p.runId; runId = p.runId; break;
        case 'console.user': if (!L.userShown) { body.insertBefore(mine(p.text), card); L.userShown = true; } break;
        case 'console.run': card.dataset.model = p.provider + '/' + p.model; say(name() + ' is thinking… (' + p.provider + ' · ' + p.model + ')'); break;
        case 'console.note': card.insertBefore(h('p', { class: 'caption muted' }, p.message), reply); break;
        case 'console.error': fail(p); break;
        case 'console.gap': note('gap', 'The console restarted while ' + name() + ' was writing, so part of the live view is missing. The whole reply appears here when ' + name() + ' finishes.'); break;
        case 'console.gone': L.gone = true; break;
        case 'console.final': L.finalP = p; if (typeof p.text === 'string') L.text = p.text; break;
        case 'console.end': L.gotEnd = true; break;
        case 'agent.run.start': if (!L.lead) { L.lead = p.runId; runId = p.runId; } break;
        case 'agent.token': if (L.lead && p.runId && p.runId !== L.lead) break; L.text += p.delta || ''; say(name() + ' is writing…'); if (!L.raf) L.raf = requestAnimationFrame(render); break;
        case 'agent.tool_call': { if (L.lead && p.runId !== L.lead && p.runId) break; const w = stepWords(p.name, p.argsSummary);
          steps.appendChild(h('li', { class: 'chat-step', 'data-call': p.callId || '' }, h('span', { class: 'step-dot', 'aria-hidden': 'true' }), h('span', null, w)));
          say(name() + ' is ' + w + '…'); scrollEnd(); break; }
        case 'agent.tool_result': { const li = [...steps.children].find(x => x.dataset.call === String(p.callId || '')); if (li) { const ok = p.ok && !p.isError; li.classList.add(ok ? 'ok' : 'bad'); const rs = toolStepResult(p.summary, ok); if (rs) li.appendChild(h('span', { class: 'caption muted' }, ' — ' + rs)); } break; }
        case 'permission.prompt': L.consentHost = consentCard(p, card); break;
        case 'permission.response': { const c = card.querySelector('[data-prompt="' + (p.promptId || '') + '"]'); if (c) c.replaceWith(h('p', { class: 'caption muted' }, 'Approval: ' + (p.decision || 'answered') + (p.expired ? ' (no answer in time)' : ''))); break; }
        case 'agent.run.error': if (!L.lead || !p.runId || p.runId === L.lead) fail({ message: name() + ' hit an error: ' + (p.message || 'the run failed'), fix: /budget|cap|quota|limit/i.test(p.message || '') ? 'Check the budget in Setup.' : /key|auth|401|403|credential/i.test(p.message || '') ? 'Check the AI provider in Setup.' : null, link: /budget|cap/i.test(p.message || '') ? '#/setup/budget' : /key|auth|401|403|credential/i.test(p.message || '') ? '#/setup/provider' : null }); break;
        case 'agent.run.end': if (L.lead && p.runId && p.runId !== L.lead) break; L.sawEnd = true; L.endP = p;
          meta.textContent = name() + ' · ' + when(new Date().toISOString(), tz) + (card.dataset.model ? ' · ' + modelName(card.dataset.model) : '') + (p.usd ? ' · $' + Number(p.usd).toFixed(4) : '');
          if (p.outcome && /fail|error/.test(p.outcome) && !L.failed) fail({ message: name() + ' could not finish (' + (p.failureCode || p.reason || p.outcome) + ').' });
          break;
        default: break;
      }
    };
    const read = async res => {
      if (!res.ok || !res.body) {
        let msg = res.status + ' ' + res.statusText; try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
        if (res.status === 401) msg = 'Not signed in: open the login link the console printed.';
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true }); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) handle(l); }
      }
      if (buf.trim()) handle(buf.trim());
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    ctrl = new AbortController();
    try {
      if (first) { try { await read(await first()); } catch (e) { if (e.name === 'AbortError' || !L.attached) throw e; } }
      // attached to a run: read its journal until console.end, re-attaching after every break (a console restart takes seconds)
      for (let tries = 0; L.attached && !L.gotEnd && !L.gone; ) {
        if (first || tries) { note('reconnect', 'Reconnecting to ' + name() + '\'s reply…'); say('Reconnecting…'); await sleep(Math.min(5000, 600 + tries * 400)); }
        first = true;
        try {
          const r = await fetch('/api/chat/' + encodeURIComponent(agentId) + '/attach?runId=' + encodeURIComponent(L.lead) + '&from=' + L.count, { credentials: 'same-origin', signal: ctrl.signal, headers: { Accept: 'application/x-ndjson' } });
          const before = L.count; await read(r); unnote('reconnect');
          tries = L.count > before ? 0 : tries + 1;
        } catch (e) { if (e.name === 'AbortError') throw e; tries++; }
        if (tries > 90) { L.lostView = true; break; }   // about five minutes of a console that does not come back
      }
      if (L.raf) { cancelAnimationFrame(L.raf); } L.final = true; render();
      if (L.finalP && L.finalP.commandAsk && L.text.trim()) card.insertBefore(commandNotice(L.finalP.commandAsk), meta);
      else if (L.finalP && L.finalP.ownerAsk && L.text.trim()) card.insertBefore(scopeNotice(L.finalP.ownerAsk), meta);
      unnote('reconnect');
      const fp = L.finalP;
      if (L.gone) note('gone', 'The console has no record of this reply any more. Refresh the conversation to see what ' + name() + ' wrote.');
      else if (L.lostView) note('lost', 'The live view of this reply was lost and the console did not come back. ' + name() + ' may still be writing: refresh the conversation in a minute.');
      else if (L.attached && fp && !fp.complete && !L.failed) {
        if (L.userStop || /cancel|stop/i.test(fp.reason || '')) card.appendChild(h('p', { class: 'caption muted chat-cut' }, L.userStop ? 'Stopped. The reply above is unfinished.' : 'This reply was cut off before ' + name() + ' finished (' + (fp.reason || 'stopped') + ').'));
        else card.appendChild(h('p', { class: 'caption muted chat-cut' }, fp.gap ? 'Part of this reply was lost in a console restart; what is above is what reached the console.' : 'This reply was cut off before ' + name() + ' finished (' + (fp.reason || 'cut off') + ').'));
      }
      else if (!L.attached && !L.sawEnd && !L.failed) fail({ message: 'The answer stopped before ' + name() + ' finished.', fix: 'Send it again.' });
      else if ((L.sawEnd || (fp && fp.complete)) && !L.text.trim() && !L.failed) fail({ message: name() + ' finished without writing a reply.', fix: 'Ask again, or look at the steps above.' });
    } catch (e) {
      if (e.name === 'AbortError') { L.final = true; render(); card.appendChild(h('p', { class: 'caption muted chat-cut' }, 'Stopped. The reply above is unfinished.')); }
      else fail({ message: /Failed to fetch|NetworkError/.test(e.message) ? 'The console server is not reachable.' : 'Not sent: ' + humanError(e), fix: e.status === 404 ? 'This crew member is not on the crew any more.' : null });
    } finally {
      who.remove(); card.classList.remove('live');
      if (L.stepsBox) { const n = L.steps.children.length; if (!n) L.stepsBox.remove(); else { L.stepsBox.open = false; L.stepsBox.firstChild.textContent = 'What ' + name() + ' looked at (' + n + ' step' + (n === 1 ? '' : 's') + ')'; } }
      busy = false; runId = null; ctrl = null; sendBtn.disabled = false; stopBtn.hidden = true;
      setState(L.failed ? 'Not answered: see above.' : '', L.failed ? 'danger' : 'muted');
      if (L.consentHost && L.consentHost.isConnected) L.consentHost.remove();
      scrollEnd();
    }
  }
  function consentCard(p, card) {
    const answer = async d => {
      try { await post('/station/consent', { runId: runId || p.runId, promptId: p.promptId, decision: d }); el.replaceWith(h('p', { class: 'caption muted' }, d === 'deny' ? 'You said no.' : 'You allowed it.')); }
      catch (e) { app.toast('Not answered: ' + humanError(e), true); }
    };
    const el = h('div', { class: 'alertbox tool-permission', role: 'alertdialog', 'data-prompt': p.promptId || '' },
      h('div', { class: 'stack-4' }, h('span', { class: 'consent-prov caption strong' }, 'Tool permission · station'), h('span', { class: 'label strong' }, name() + ' asks to use ' + (p.tool || 'a tool')), h('span', { class: 'mono-s' }, String(p.argsSummary || '').slice(0, 400))),
      h('div', { class: 'row-8' }, Button('Allow once', { variant: 'primary', size: 'sm', onClick: () => answer('once') }), Button('Allow in this chat', { variant: 'secondary', size: 'sm', onClick: () => answer('session') }), Button('No', { variant: 'ghost', size: 'sm', onClick: () => answer('deny') })));
    card.appendChild(el); scrollEnd();
    setState(name() + ' is waiting for your answer…', 'warning');
    return el;
  }
  // Stop cancels the run at the station; the reply then ends with its console.final (not complete), and the page says so.
  // Without a run id yet (it has not started), the request itself is dropped.
  async function stop() {
    stopBtn.disabled = true;
    if (curL) curL.userStop = true;
    if (runId) { try { await post('/station/cancel', { runId }); return; } catch (e) { app.toast('Stop: ' + humanError(e), true); } }
    if (ctrl) ctrl.abort();
  }
  function send(raw) {
    const text = String(raw || '').trim(); if (!text) return;
    ta.value = '';
    return stream({ text }, text);
  }
  function sendBrief(brief, notes) { return stream({ brief, notes: notes || {} }, null); }
  // a chat action's reply: the owner's next message (the visible line + the actionReply line); false when not sent
  async function sendAction(text) {
    if (busy) { app.toast(name() + ' is still answering. Press Stop first, then choose again.', true); return false; }
    stream({ text }, text); return true;
  }
  return { load, send, sendBrief, stop, ta, isBusy: () => busy, destroy: () => { if (ctrl) ctrl.abort(); } };
}
