/* console/chat.js — the owner's LIVE chat with a crew member, and what the asynchronous owner channel is waiting on.
 * Spec: docs/CONSOLE-API.md "Live chat" and "Owner channel".
 *
 * Live chat: POST /api/chat/<seat>/send streams the station run (POST /api/run, NDJSON {name, payload}) straight to the
 * browser, with the seat's own model (its loop routine's pair, else its roster row, else model-policy candidateDefault),
 * the company folder as the blessed project root, and files + terminal + memory + web placed, so the crew member can
 * really do what the owner asks (write company/CHARTER.md, for one). The conversation is the station transcript stream
 * console-<seat>, so it is there again when the owner comes back. Every refusal comes back as a line the page shows
 * ({name:'console.error', payload:{message, fix, link}}), never as silence: station down, hard halt, no model, a
 * metered model with a $0 cap.
 *
 * Owner channel: each owner message gets a state: waiting (next check within N min, from the dispatcher tick, the owner
 * cooldown and the loop's last run), working, read (acknowledged), answered (a reply names it with `re`), or stuck (no
 * routine can answer: no Founder loop, scheduler off, company halted, dispatcher not ticking, the fast wake stalled),
 * each stuck state with its fix.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { commandAsk, ownerAsk, recheckNote, CHECK_PREFIX } = require(path.join(__dirname, 'command-ask.js'));
// a reply that tells the owner to run a command: the page shows a notice under it (console/command-ask.js)
const cmdAsk = text => { try { return commandAsk(text); } catch (_) { return null; } };
// the run's last reply line, with that check added (console/chat-runs.js journals it as written)
// a reply that puts crew work to the owner (infrastructure, monitoring, tools) or asks in technical words (owner scope)
const scopeAsk = text => { try { return ownerAsk(text); } catch (_) { return null; } };
const withAsk = l => l.name === 'console.final' && l.payload && typeof l.payload.text === 'string' ? { name: l.name, payload: Object.assign({}, l.payload, { commandAsk: cmdAsk(l.payload.text), ownerAsk: scopeAsk(l.payload.text) }) } : l;


/* What the console knows that the chat would not: this seat's own recent work (its routine runs are separate
   conversations), so "what are you working on?" gets a real answer. Marked as console context, not the owner's words. */
function contextNote(id, s, co, text) {
  const lines = [];
  try {
    const runs = require(co.p('company', 'tools', 'lib', 'bounded.js')).tailLines(co.p('.starnet-data', 'workspaces', 'runs.jsonl'), 400)   // the end only
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(r => r && r.agentId === id && !/^console-/.test(String(r.streamId || '')));
    for (const r of runs.slice(-3)) {
      const when = r.endedAt || r.at || r.ts; const t = when ? new Date(when).toISOString().slice(0, 16).replace('T', ' ') : '';
      lines.push('- ' + (t ? t + ' UTC ' : '') + (String(r.streamId || '').startsWith('cron-') ? 'routine run' : 'run') + ': "' + String(r.title || '').replace(/\s+/g, ' ').slice(0, 70) + '" → ' + (r.reason || '?') + ', ' + (r.turns || 0) + ' steps');
    }
  } catch (_) {}
  const notes = ['company/work/decisions.md', 'company/work/handoffs/to-' + String(s.inbox || '').replace(/^to-|\.md$/g, '') + '.md'].filter(f => fs.existsSync(co.p(f)));
  return '[Console context, not from the owner: you are ' + (s.name || id) + '. The company folder is ' + co.ROOT + ' (your project root; company tools run as `node company/tools/<tool>.js`).'
    + (lines.length ? ' Your own recent runs (separate conversations you can check):\n' + lines.join('\n') : ' No earlier runs of yours are recorded.')
    + (notes.length ? '\nYour written record: ' + notes.join(', ') + '. Read them before claiming what you have done.' : '')
    + '\nRun commands and read or write files by calling your tools. Never write a tool call out as text (<run_command>, <invoke>, <tool_call>, a JSON call): text is not run, and the owner only sees the markup.'
    + '\nThe owner is a busy non-technical person. Handle infrastructure yourself: monitoring, health checks, timers, services, tools, framework bugs and internal process are the crew\'s (yours, the risk, tools or floor seat, or a framework request), never a question for the owner. Ask the owner only for money beyond the company\'s limits, an account or identity in their own name, legal, ownership or commitment decisions, company direction and priorities, risk the governance level reserves for them, or a fixed gate, in two plain sentences that say what they get or risk and what happens if they skip it (your default); technical detail only if they ask for it.'
    + '\nNever ask the owner to run a command or open a terminal (systemctl, sudo, npm/pip install, git push, node …): the owner works only in the console. Do it with your own tools, link the console action that does it ([label](console:#/route)), ask for an approval on Today, or hand it to the tools seat in a handoff; a change to a framework file is a harness-change propose. If agents are refused the command, say so and route it, never hand it over.'
    + '\nWhen you point the owner somewhere in the console, link it: [label](console:#/route). For a quick choice in this conversation, write an ```actions block (company/skills/console-links/SKILL.md "Chat actions").'
    + actionReplyNote(text) + ']\n\n';
}
/* the parse helper for the agent's next turn: the owner clicked a control in an ```actions block, so say so plainly */
function actionReplyNote(text) {
  let p = null; try { p = require(path.join(__dirname, 'ui', 'js', 'actions-schema.js')).parseActionReply(text); } catch (_) {}
  if (!p) return '';
  const r = p.reply;
  return '\nThis message is the owner\'s answer to your actions block "' + r.id + '"' + (r.value !== undefined ? ': value ' + JSON.stringify(r.value) : '') + (r.fields ? '; fields ' + JSON.stringify(r.fields) : '') + (r.stored ? '; a key was stored at secrets/' + r.stored.name + ' (' + r.stored.chars + ' chars), read it with co.secret() in a tool, never print it' : '') + '. The last line, [actionReply {...}], is the machine-readable form.';
}

module.exports = function chat(deps) {
  const { co, stationGet, bad, HttpError, tool, owner } = deps;
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
  const FL = () => tool('founder-loop.js');
  const STREAM = id => 'console-' + id;
  const PLACED = ['cabinet', 'workbench', 'notebook', 'dish'].map(t => ({ objectType: t }));
  const svc = () => (co.config.station && co.config.station.serviceName) || 'capheos-station';
  const RUNS = require(path.join(__dirname, 'chat-runs.js'))({ co, stationGet, finalText: (...a) => finalText(...a) });

  function seatOf(id) {
    const crew = co.crew();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) bad('bad seat id');
    const s = crew[id]; if (!s) bad('no crew member ' + id, 404);
    return Object.assign({ id }, s);
  }
  function budget() { return Object.assign({}, readJson(co.p('company', 'defaults', 'work', 'finance', 'dispatch-budget.json'), {}), readJson(co.p('company', 'work', 'finance', 'dispatch-budget.json'), {}) || {}); }
  function rosterRow(id) { const r = readJson(co.p('.starnet-data', 'workspaces', 'agent.roster.json'), {}) || {}; return (r.agents || []).find(a => a && a.agentId === id) || null; }

  // the seat's model: its loop routine, else its roster row, else the candidate default
  async function modelFor(s, jobs) {
    if (!jobs) { const cr = await stationGet('cron', 4000); jobs = cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : []; }
    const job = s.loop ? FL().findLoop(jobs, { id: s.id, loop: s.loop }) : null;
    if (job && job.model && job.provider) return { model: job.model, provider: job.provider, from: 'its loop routine "' + job.name + '"' };
    const r = rosterRow(s.id);
    if (r && r.model && r.provider) return { model: r.model, provider: r.provider, from: 'its station roster row' };
    const cd = (readJson(co.p('company', 'model-policy.json'), {}) || {}).candidateDefault || {};
    if (cd.model && cd.provider) return { model: cd.model, provider: cd.provider, from: 'the company default (model-policy.json candidateDefault)' };
    return null;
  }

  // what stops a live run before it starts: [{code, message, fix, link}]
  async function preflight(s, m) {
    const out = [];
    const halt = co.haltState();
    if (halt.mode === 'hard') out.push({ code: 'halted', message: 'The company is under a hard halt: the station stops every run, so ' + s.name + ' cannot answer.', fix: 'Resume on the Halt screen.', link: '#/halt' });
    const cr = await stationGet('cron', 4000);
    if (!cr.ok) out.push({ code: 'station-down', message: 'The station is not answering (' + (cr.error || 'HTTP ' + cr.status) + '), so ' + s.name + ' cannot answer.', fix: 'Start it on the station machine: systemctl --user start ' + svc() + '.service', link: '#/settings/system' });
    if (!m) out.push({ code: 'no-model', message: s.name + ' has no AI model to think with.', fix: 'Connect an AI provider.', link: '#/setup/provider' });
    else { const h = meteredHold(s, m); if (h) out.push(h); }
    return { problems: out, jobs: cr.ok && cr.data ? cr.data.jobs || [] : [] };
  }
  // a metered model with a $0 daily cap: the budget holds the run (the chat and the meeting both check it)
  function meteredHold(s, m) {
    const b = budget();
    const unmetered = (Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders : ['claude-cli']).map(String);
    if (!unmetered.includes(m.provider) && co.guard('spendCap') && !(Number(b.dailyUsd) > 0)) return { code: 'budget-hold', message: s.name + ' runs on ' + m.provider + ' (' + m.model + '), which bills per token, and the daily cap is $0: the budget holds every metered run.', fix: 'Set a daily budget in Setup, or connect a subscription provider.', link: '#/setup/budget' };
    return null;
  }

  // how each station run ended, from the station's run log (the end only): a reply whose run was cancelled is cut off
  function runReasons() {
    const out = {};
    try {
      for (const l of require(co.p('company', 'tools', 'lib', 'bounded.js')).tailLines(co.p('.starnet-data', 'workspaces', 'runs.jsonl'), 400)) {
        try { const r = JSON.parse(l); if (r && r.runId && /^console-/.test(String(r.streamId || ''))) out[r.runId] = r.reason || r.outcome || ''; } catch (_) {}
      }
    } catch (_) {}
    return out;
  }
  const CUT = /^(cancelled|canceled|stopped|aborted|error|failed|cut-off|lost|interrupted)$/i;
  async function transcript(id) {
    const r = await stationGet('transcript?agent=' + encodeURIComponent(id) + '&stream=' + encodeURIComponent(STREAM(id)) + '&limit=200', 5000);
    if (!r.ok) return { ok: false, error: r.error || 'HTTP ' + r.status, turns: [] };
    const reasons = runReasons();
    const turns = ((r.data && r.data.turns) || []).filter(t => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
      .map(t => {
        const o = { role: t.role, content: t.role === "user" ? String(t.content).replace(/^\[Console context, not from the owner:[\s\S]*?\]\n\n/, "") : t.content, at: t.at || t.ts || null };
        const rid = t.sourceRunId || t.runId || null;
        // the console's pre-delivery check (a reply that handed the owner a command went back to the agent once): neither
        // the check note nor the reply it sent back is the owner's conversation
        if (t.role === 'user' && String(t.content).startsWith(CHECK_PREFIX)) return null;
        if (t.role === 'assistant' && rid && RUNS.runOf(rid) && RUNS.runOf(rid).superseded) return null;
        if (rid) o.runId = rid;
        // a reply the station kept from a run that did not finish (stopped, cancelled by a dropped connection, failed)
        const mine = rid ? RUNS.runOf(rid) : null;
        const why = mine && mine.status === 'cut' ? mine.reason : rid ? reasons[rid] : null;
        if (t.role === 'assistant' && why && CUT.test(why)) o.cut = why;
        if (t.role === 'assistant') { const ca = cmdAsk(t.content); if (ca) o.commandAsk = ca; const oa = scopeAsk(t.content); if (oa) o.ownerAsk = oa; }
        return o;
      }).filter(Boolean);
    return { ok: true, turns };
  }
  /* the reply as the station's transcript recorded it, for console.final: the turn this run wrote (sourceRunId), else the
     newest reply written since the run started */
  async function finalText(seat, runId, run) {
    const r = await stationGet('transcript?agent=' + encodeURIComponent(seat) + '&stream=' + encodeURIComponent((run && run.streamId) || STREAM(seat)) + '&limit=20', 5000);
    if (!r.ok) return null;
    const turns = ((r.data && r.data.turns) || []).filter(t => t.role === 'assistant' && typeof t.content === 'string');
    const own = turns.filter(t => (t.sourceRunId || t.runId) === runId);
    if (own.length) return { text: own.map(t => t.content).join('\n\n'), exact: true };
    if (turns.some(t => t.sourceRunId || t.runId)) return null;   // this station names runs, and none is this one: no reply was kept
    const since = (run.startedAt || 0) - 2000;
    const late = turns.filter(t => Date.parse(t.at || t.ts || '') >= since);
    return late.length ? { text: late[late.length - 1].content, exact: true } : null;
  }

  async function info(id) {
    const s = seatOf(id);
    const cr = await stationGet('cron', 4000);
    const m = await modelFor(s, cr.ok && cr.data ? cr.data.jobs || [] : []);
    const pre = await preflight(s, m);
    const t = await transcript(id);
    // a run in flight (the page re-attaches to it): its own turns, if the station already wrote them, are left out here
    // and come back with the run's journal, so the page never shows a reply that is still being written as finished
    const live = RUNS.inflight(id);
    let turns = t.turns;
    if (live) {
      turns = turns.filter(x => !(x.runId && x.runId === live.runId));
      const k = turns.length - 1;
      if (k >= 0 && turns[k].role === 'user' && turns[k].content.trim() === String(live.userText || '').trim()) turns = turns.slice(0, k);
    }
    return { ok: true, agent: { id, name: s.name || id, title: s.title || '' }, model: m ? m.model : null, provider: m ? m.provider : null, modelFrom: m ? m.from : null,
      streamId: STREAM(id), turns, transcriptError: t.ok ? null : t.error, problems: pre.problems,
      inflight: live ? { runId: live.runId, startedAt: new Date(live.startedAt).toISOString(), shownText: live.shownText || null, gap: !!live.gap } : null };
  }

  /* ---------- briefs: what a button in the console asks a crew member to do ---------- */
  function charterHeadings() {
    let md = ''; try { md = fs.readFileSync(co.p('company', 'CHARTER.md'), 'utf8'); } catch (_) {}
    return (md.match(/^## .+$/gm) || []).map(x => x.slice(3).trim());
  }
  function brief(kind, notes) {
    notes = notes && typeof notes === 'object' ? notes : {};
    const o = (co.config.owner && co.config.owner.name) || owner();
    if (kind === 'charter') {
      const given = [['What it does', notes.mandate], ['For whom', notes.forWhom], ['What it will not do', notes.outOfScope], ['First goal', notes.firstGoal]]
        .map(([k, v]) => [k, String(v || '').replace(/\s+/g, ' ').trim().slice(0, 2000)]).filter(x => x[1]);
      const heads = charterHeadings();
      return 'Let us write the company charter together, here in this chat.\n\n' +
        'First ask me a few short questions (one message, at most four): what the company does and how it creates value, for whom, what it will never do, and its first goal. Skip what I already answered below.\n' +
        'When you have the answers, write company/CHARTER.md with your file tools: keep every heading of the template (' + (heads.length ? heads.join(', ') : 'Mandate, What is out of scope, Structure, ...') + '), add a "## First goal" section if it is missing, and leave no <...> or {{...}} placeholder anywhere. Read the file back to check.\n' +
        'Then tell me in two or three sentences what you wrote, and end with this link: [Review it in Setup](console:#/setup/charter).' +
        (given.length ? '\n\nWhat ' + o + ' wrote in Setup so far:\n' + given.map(x => '- ' + x[0] + ': ' + x[1]).join('\n') : '');
    }
    if (kind === 'charter-change') {
      const what = String(notes.change || '').trim().slice(0, 4000);
      if (!what) bad('say what to change');
      return 'Please change company/CHARTER.md: ' + what + '\nKeep every heading and leave no placeholder. Read the file back to check, tell me in a sentence what changed, and end with [Review it in Setup](console:#/setup/charter).';
    }
    bad('unknown brief ' + kind);
  }

  /* ---------- POST /api/chat/<id>/send: the live run, streamed ----------
     The run is the station's, not this request's (console/chat-runs.js): with the station's "run-detach" capability
     (StarNet patch 0014) it is started detach:true and followed on the observer feed, so a console restart does not end
     it; either way the browser leaving (a reload, a closed tab) only stops the watching. The browser gets the opening
     lines, then {name:'console.attached', payload:{runId}}, then the run's journal from its first line, and the run's last
     two lines: console.final {text, complete} and console.end. It re-attaches with GET /api/chat/<id>/attach. Stop is
     POST /api/station/cancel {runId}. */
  async function send(req, res, id, body) {
    const line = (name, payload) => { try { res.write(JSON.stringify({ name, payload }) + '\n'); } catch (_) {} };
    const s = seatOf(id);
    let text = String(body.text || '').trim();
    if (body.brief) text = brief(String(body.brief), body.notes);
    if (!text) bad('text is required');
    if (text.length > 20000) bad('text too long');
    const m = await modelFor(s);
    const pre = await preflight(s, m);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    // a blank line every 20 s while the run is quiet: a reverse proxy's read timeout never cuts a long tool call
    const ka = setInterval(() => { try { res.write('\n'); } catch (_) {} }, 20000); ka.unref();
    res.on('close', () => clearInterval(ka)); res.on('finish', () => clearInterval(ka));
    const opening0 = [];   // the lines before the run exists: journaled as its first lines once it does, so a reload shows them
    const say = (name, payload) => { opening0.push({ name, payload }); line(name, payload); };
    say('console.user', { text, brief: body.brief || null });
    if (pre.problems.length) { line('console.error', pre.problems[0]); return res.end(); }
    say('console.run', { agentId: id, name: s.name, model: m.model, provider: m.provider, from: m.from });
    // the company folder as a blessed project (idempotent): without it the run cannot read or write a company file
    try {
      const bl = await FL().blessRoot();
      if (!bl.ok) say('console.note', { message: 'The company folder is not a blessed project on the station (' + bl.error + '), so ' + s.name + ' cannot read or write company files in this chat.' });
    } catch (e) { say('console.note', { message: 'Could not check the project grant: ' + e.message }); }
    const t = await transcript(id);
    const history = t.turns.slice(-40).map(x => ({ role: x.role, content: x.content }));
    // isTask: true is what puts the agent's tools on the wire. With isTask:false the station sends the model NO tool
    // definitions (capability/project-tools.js: advertised = isTask ? coreNames : []), and a model told about its tools
    // writes the calls out as text (<run_command>…</run_command>, 2026-11-17: toolsOk 0 on every console chat).
    const messages = history.concat([{ role: 'user', content: contextNote(id, s, co, text) + text }]);
    let token; try { token = co.stationToken(); } catch (_) { token = null; }
    if (!token) { line('console.error', { code: 'station-down', message: 'No station token (secrets/station-token).', fix: 'Run scripts/setup-station.sh', link: '#/settings/system' }); return res.end(); }
    const shownText = body.brief ? text.split('\n')[0] : text;
    const REF = require(co.p('company', 'tools', 'lib', 'refusal.js'));
    let closed = false;
    res.on('close', () => { closed = true; });
    // one run on one model; a refusal (the model declined it) is retried ONCE on the seat's next model, the same turn,
    // and the owner is told in one plain line (lib/refusal.js); every entry declining is reported plainly, never an error
    /* PRE-DELIVERY COMMAND CHECK (console/command-ask.js): a finished reply that tells the owner to run a command or open a
       terminal is not delivered; it goes back to the agent ONCE with the reason ("the owner uses the console only; offer a
       button or do it yourself"), and the page shows the second reply instead. Only a second reply that still hands over
       a command is delivered, with the notice under it. `check` = {messages} for that second run. */
    const launch = (m, attempt, lead, tried, check) => {
    const opening = lead.slice();
    const payload = { agentId: id, model: m.model, provider: m.provider, rosterSystem: true, isTask: true, streamId: STREAM(id),
      messages: check ? check.messages : messages, projectRoot: co.ROOT, placed: PLACED };
    // the one gate (company/tools/lib/admit.js, door chat): an owner chat is always allowed and always counted
    let tk = null; try { tk = require(co.p('company', 'tools', 'lib', 'admit.js')).admit({ door: 'chat', kind: 'run', seat: id, why: body.brief ? 'console brief ' + body.brief : 'owner chat' }); } catch (_) {}
    for (const l of lead) if (attempt > 0) line(l.name, l.payload);
    return RUNS.prepare(STREAM(id), { seat: id, userText: text, shownText, brief: body.brief || null, model: m.model, provider: m.provider },
      runId => { for (const l of opening) RUNS.journal(runId, l.name, l.payload); }).then(prep => {
    if (prep.source === 'observe') payload.detach = true;
    const u = new URL(co.STATION_URL.replace(/\/+$/, '') + '/api/run');
    const data = JSON.stringify(payload);
    let runId = null, off = null, upEnded = false, sawEnd = false, retrying = null, rechecking = null;
    const watch = rid => {   // the run is known: from here the browser reads its journal
      if (runId || closed) return; runId = rid;
      line('console.attached', { runId: rid });
      off = RUNS.attach(rid, 0, x => {
        const l = withAsk(x);
        if (l.name === 'console.final' && REF.isRefusal(l.payload || {})) {
          const next = attempt === 0 ? REF.nextEntry(id, m, tried) : null;
          if (next) { retrying = next; return; }   // this run's end is replaced by the retry, not shown as a failure
          line(l.name, l.payload);
          line('console.error', { code: 'refused', message: attempt === 0 ? REF.plainLine(m, null) + ' The run stopped; nothing was changed.' : REF.pname(m.provider) + ' declined this too, after ' + REF.pname(tried[0].provider) + ' did. The run stopped; nothing was changed.' });
          try { REF.record({ root: co.ROOT, seat: id, door: 'chat', runId: rid, from: m, to: null }); } catch (_) {}
          return;
        }
        if (l.name === 'console.final' && !check && l.payload && l.payload.complete && l.payload.commandAsk && String(l.payload.text || '').trim()) {
          rechecking = { text: String(l.payload.text), hit: l.payload.commandAsk };   // held back: this run's end starts the check run
          try { const r0 = RUNS.runOf(rid); if (r0) { r0.superseded = true; r0.recheck = { command: l.payload.commandAsk.command }; } } catch (_) {}
          return;
        }
        if (l.name === 'console.end' && rechecking) {
          const rc = rechecking; rechecking = null; if (off) off();
          const note = recheckNote(rc.hit);
          line('console.recheck', { message: s.name + '\'s first reply asked you to run a command, so it went back to ' + s.name + ' to offer a button or do it instead.', command: rc.hit.command });
          return launch(m, attempt, [{ name: 'console.run', payload: { agentId: id, name: s.name, model: m.model, provider: m.provider, from: 'the console\'s check: the first reply asked you to run a command' } }], tried,
            { messages: messages.concat([{ role: 'assistant', content: rc.text }, { role: 'user', content: note }]) });
        }
        if (l.name === 'console.end' && retrying) {
          const next = retrying; retrying = null; if (off) off();
          try { REF.record({ root: co.ROOT, seat: id, door: 'chat', runId: rid, from: m, to: next }); } catch (_) {}
          const note = { message: REF.plainLine(m, next).replace('answered instead.', 'is answering instead.'), refusal: { from: REF.keyOf(m), to: REF.keyOf(next) } };
          return launch(next, 1, [{ name: 'console.note', payload: note }, { name: 'console.run', payload: { agentId: id, name: s.name, model: next.model, provider: next.provider, from: 'the next model in ' + s.name + '\'s chain (the first one declined)' } }], tried.concat([m]), check);
        }
        line(l.name, l.payload);
        if (l.name === 'console.end') { closed = true; if (off) off(); res.end(); }
      });
    };
    prep.started.then(watch);
    const refuse = (p) => { prep.cancel(); if (!runId) { line('console.error', p); closed = true; res.end(); } };
    const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'x-starnet-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'application/x-ndjson' } }, ur => {
      try { require(co.p('company', 'tools', 'lib', 'admit.js')).started(tk, { status: ur.statusCode }); } catch (_) {}
      if (ur.statusCode !== 200) {
        let d = ''; ur.on('data', c => { d += c; }); ur.on('end', () => {
          let msg = d.trim(); try { const j = JSON.parse(msg); msg = j.error || j.reason || msg; } catch (_) {}
          refuse({ code: 'station-refused', message: 'The station refused the run (HTTP ' + ur.statusCode + '): ' + (msg || 'no reason given').slice(0, 400), fix: /key|model|provider|credential/i.test(msg) ? 'Check the AI provider in Setup.' : null, link: /key|model|provider|credential/i.test(msg) ? '#/setup/provider' : null });
        });
        return;
      }
      ur.setEncoding('utf8');
      let buf = '', mine = null;   // mine: this run's id, known synchronously (runId is set a tick later)
      const each = l => {
        let ev; try { ev = JSON.parse(l); } catch (_) { return; }
        if (!ev || !ev.name) return;
        const rid = ev.payload && ev.payload.runId;
        if (ev.name === 'agent.run.start' && rid && !mine) { prep.claim(rid); mine = rid; }   // first to know (the feed may be first instead)
        if (prep.source === 'direct' && mine) { if (rid && rid !== mine) return; if (ev.name === 'agent.run.end') sawEnd = true; RUNS.ingest(mine, ev.name, ev.payload || {}); }
      };
      ur.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) each(l); } });
      ur.on('end', () => {
        upEnded = true; if (buf.trim()) each(buf.trim());
        if (!runId && !mine) return refuse({ code: 'cut-off', message: 'The station closed the run before it started.', fix: 'Send the message again; if it keeps happening, look at the station log (System).', link: '#/settings/system' });
        // read off its own stream, the run is over when the stream is: one that stopped before its end was cut off
        if (prep.source === 'direct' && !sawEnd) RUNS.finish(mine, { reason: 'cut-off' });
      });
      ur.on('error', () => { if (!upEnded && prep.source === 'direct' && mine) RUNS.finish(mine, { reason: 'cut-off' }); else if (!mine) refuse({ code: 'cut-off', message: 'The connection to the station broke before the run started.' }); });
    });
    up.on('error', e => refuse({ code: 'station-down', message: 'The station is not answering: ' + e.message, fix: 'systemctl --user start ' + svc() + '.service', link: '#/settings/system' }));
    // the browser left (a reload, a closed tab): it stops watching; the run goes on, and the page re-attaches. Stop is
    // POST /api/station/cancel, never a dropped connection.
    res.on('close', () => { closed = true; if (off) off(); });
    up.end(data);
    });
    };
    return launch(m, 0, opening0, []);
  }

  /* GET /api/chat/<id>/attach?runId=&from=N: the run's journal from line N, then live, as NDJSON (the same lines /send
     streams after console.attached). An unknown run answers {name:'console.gone'}; a finished one replays to its end. */
  function attach(req, res, id, q) {
    seatOf(id);
    const rid = String(q.get('runId') || ''); const from = Math.max(0, Number(q.get('from')) || 0);
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    const r = RUNS.runOf(rid);
    if (!r || r.seat !== id) { res.write(JSON.stringify({ name: 'console.gone', payload: { runId: rid } }) + '\n'); return res.end(); }
    let off = null, ended = false;
    const ka = setInterval(() => { try { res.write('\n'); } catch (_) {} }, 20000); ka.unref();
    const stop = () => { ended = true; clearInterval(ka); if (off) off(); };
    off = RUNS.attach(rid, from, x => { if (ended) return; const l = withAsk(x); try { res.write(JSON.stringify({ name: l.name, payload: l.payload }) + '\n'); } catch (_) {} if (l.name === 'console.end') { stop(); res.end(); } });
    if (ended) off();
    res.on('close', stop);
  }

  /* ---------- the owner channel: what each message is waiting on ---------- */
  async function channelState() {
    const crew = co.crew();
    const wakers = Object.entries(crew).filter(([, c]) => c && c.wakeOnOwnerMessage);
    const ceoId = co.ceo() || 'agent';
    const ceoName = co.nameOf(ceoId);
    const problems = [];
    let st = null; try { st = await FL().status(); } catch (e) { st = { ok: false, problems: [{ code: 'error', msg: e.message, fix: 'node company/tools/founder-loop.js status' }] }; }
    const halt = co.halted();
    if (halt) problems.push({ code: 'halted', msg: 'the company is under a ' + halt + ' halt, so nobody is woken', fix: 'Resume on the Halt screen.', link: '#/halt' });
    if (!wakers.length) problems.push({ code: 'no-waker', msg: 'no crew member is woken by owner messages', fix: 'Switch "wake on owner message" on for ' + ceoName + ' in Settings › Tempo and routines.', link: '#/settings/tempo/seats' });
    for (const p of (st.problems || [])) if (p.code !== 'no-model') problems.push({ code: p.code, msg: p.msg, fix: p.fix === 'node company/tools/founder-loop.js ensure' ? 'Run onboarding again: node company/tools/onboard.js --step founder-loop (or pick the AI provider again in Setup).' : p.fix, link: p.code === 'scheduler-off' || p.code === 'disabled' ? '#/settings/tempo/routines' : '#/setup/provider' });
    const cad = readJson(co.p('company', 'work', 'ops', 'cadence.json'), null) || readJson(co.p('company', 'defaults', 'work', 'ops', 'cadence.json'), {}) || {};
    // the self-paced dispatcher loop's own state (company/tools/dispatcher-loop.js): its effective tick and next tick
    const lp = readJson(co.p('company', 'state', 'dispatcher-loop.json'), null);
    const tick = lp && lp.tempo && Number(lp.tempo.tickMin) > 0 ? Number(lp.tempo.tickMin) : Number(cad.dispatcherTickMin) > 0 ? Number(cad.dispatcherTickMin) : 10;
    let lastTick = lp && (lp.status === 'ticking' ? Date.now() : Date.parse(lp.lastTickEndAt || lp.lastTickAt || '')) || null;
    if (!lastTick) { try { lastTick = fs.statSync(co.p('company', 'work', 'dispatch-log.md')).mtimeMs; } catch (_) {} }
    const age = lastTick ? (Date.now() - lastTick) / 60000 : null;
    const loopStopped = !!(lp && lp.status === 'stopped');
    if (age === null || age > tick * 3 + 2 || loopStopped) problems.push({ code: 'dispatcher', msg: age === null ? 'the dispatcher has never run, and it is what wakes ' + ceoName + ' for your messages' : loopStopped ? 'the dispatcher loop is stopped, and it is what wakes ' + ceoName + ' for your messages' : 'the dispatcher last ran ' + Math.round(age) + ' min ago (it should every ' + tick + ' min)', fix: 'Start it: systemctl --user start ' + svc() + '-dispatch.service', link: '#/settings/system' });
    const ds = readJson(co.p('company', 'work', 'dispatch-state.json'), {}) || {};
    if (ds.owner && ds.owner.flagged) problems.push({ code: 'stalled', msg: ceoName + ' was woken ' + (ds.owner.count || 3) + ' times for these messages without answering, so the fast wake stopped', fix: 'Talk to ' + ceoName + ' live instead.', link: '#/chat/agent:' + ceoId });
    if (ds.askHeld && st.job && String(ds.askHeld).includes(st.job.name)) problems.push({ code: 'ask-mode', msg: ceoName + '\'s approval mode is "ask", so an unattended run could not save anything and the dispatcher holds it', fix: 'Talk to ' + ceoName + ' live, or give the seat full access in Crew.', link: '#/crew/' + ceoId });
    const job = st.job;
    const cooldown = Number(process.env.DISPATCH_OWNER_COOLDOWN_MIN) > 0 ? Number(process.env.DISPATCH_OWNER_COOLDOWN_MIN) : 10;
    const nextAt = lp && lp.nextTickAt ? Date.parse(lp.nextTickAt) : null;
    const nextTick = nextAt ? Math.max(0, (nextAt - Date.now()) / 60000) : age === null ? tick : Math.max(0, tick - age);
    const sinceRun = job && job.lastRunAt ? (Date.now() - Date.parse(job.lastRunAt)) / 60000 : Infinity;
    const cool = Math.max(0, cooldown - sinceRun);
    const nextCheckMin = Math.max(1, Math.ceil(cool > nextTick ? nextTick + Math.ceil((cool - nextTick) / tick) * tick : nextTick));
    return { ok: !problems.length, problems, ceo: { id: ceoId, name: ceoName }, nextCheckMin, working: !!(job && job.inFlight), tickMin: tick, nextTickAt: nextAt ? new Date(nextAt).toISOString() : null, tempo: lp && lp.tempo ? lp.tempo.source : null, loop: job ? job.name : null };
  }
  function messageStates(rows, ch) {
    const ack = ((readJson(co.p('company', 'state', 'owner-inbox.json'), {}) || {}).acked) || {};
    const replies = {};
    for (const r of rows) if (r.dir === 'out' && r.re) for (const id of String(r.re).split(',').map(x => x.trim())) (replies[id] = replies[id] || []).push(r.id);
    return rows.map(r => {
      if (r.dir !== 'in') return r;
      const a = ack[r.id];
      const rep = replies[r.id] || [];
      let state;
      if (rep.length) state = { status: 'answered', text: 'answered by ' + ch.ceo.name, replies: rep };
      else if (a) state = { status: 'read', text: 'read by ' + (a.by || ch.ceo.name) + (a.note ? ': ' + a.note : ''), at: a.at };
      else if (ch.problems.length) state = { status: 'stuck', text: 'nobody will pick this up: ' + ch.problems[0].msg, fix: ch.problems[0].fix, link: ch.problems[0].link || null, more: ch.problems.slice(1).map(p => p.msg) };
      else if (ch.working) state = { status: 'working', text: ch.ceo.name + ' is working now and reads this in the current or next run' };
      else state = { status: 'waiting', text: 'waiting for ' + ch.ceo.name + ' — next check within ' + ch.nextCheckMin + ' min', nextCheckMin: ch.nextCheckMin };
      return Object.assign({}, r, { state });
    });
  }

  return { info, send, attach, brief, channelState, messageStates, modelFor, meteredHold, seatOf, runs: RUNS };
};
