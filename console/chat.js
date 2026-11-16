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

module.exports = function chat(deps) {
  const { co, stationGet, bad, HttpError, tool, owner } = deps;
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
  const FL = () => tool('founder-loop.js');
  const STREAM = id => 'console-' + id;
  const PLACED = ['cabinet', 'workbench', 'notebook', 'dish'].map(t => ({ objectType: t }));
  const svc = () => (co.config.station && co.config.station.serviceName) || 'capheos-station';

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
    if (!cr.ok) out.push({ code: 'station-down', message: 'The station is not answering (' + (cr.error || 'HTTP ' + cr.status) + '), so ' + s.name + ' cannot answer.', fix: 'Start it on the station machine: systemctl --user start ' + svc() + '.service', link: '#/system' });
    if (!m) out.push({ code: 'no-model', message: s.name + ' has no AI model to think with.', fix: 'Connect an AI provider in Setup.', link: '#/setup/provider' });
    else {
      const b = budget();
      const unmetered = (Array.isArray(b.unmeteredProviders) && b.unmeteredProviders.length ? b.unmeteredProviders : ['claude-cli']).map(String);
      if (!unmetered.includes(m.provider) && co.guard('spendCap') && !(Number(b.dailyUsd) > 0)) out.push({ code: 'budget-hold', message: s.name + ' runs on ' + m.provider + ' (' + m.model + '), which bills per token, and the daily cap is $0: the budget holds every metered run.', fix: 'Set a daily budget in Setup, or connect a subscription provider.', link: '#/setup/budget' });
    }
    return { problems: out, jobs: cr.ok && cr.data ? cr.data.jobs || [] : [] };
  }

  async function transcript(id) {
    const r = await stationGet('transcript?agent=' + encodeURIComponent(id) + '&stream=' + encodeURIComponent(STREAM(id)) + '&limit=200', 5000);
    if (!r.ok) return { ok: false, error: r.error || 'HTTP ' + r.status, turns: [] };
    const turns = ((r.data && r.data.turns) || []).filter(t => (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim())
      .map(t => ({ role: t.role, content: t.content, at: t.at || t.ts || null }));
    return { ok: true, turns };
  }

  async function info(id) {
    const s = seatOf(id);
    const cr = await stationGet('cron', 4000);
    const m = await modelFor(s, cr.ok && cr.data ? cr.data.jobs || [] : []);
    const pre = await preflight(s, m);
    const t = await transcript(id);
    return { ok: true, agent: { id, name: s.name || id, title: s.title || '' }, model: m ? m.model : null, provider: m ? m.provider : null, modelFrom: m ? m.from : null,
      streamId: STREAM(id), turns: t.turns, transcriptError: t.ok ? null : t.error, problems: pre.problems };
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

  /* ---------- POST /api/chat/<id>/send: the live run, streamed ---------- */
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
    line('console.user', { text, brief: body.brief || null });
    if (pre.problems.length) { line('console.error', pre.problems[0]); return res.end(); }
    line('console.run', { agentId: id, name: s.name, model: m.model, provider: m.provider, from: m.from });
    // the company folder as a blessed project (idempotent): without it the run cannot read or write a company file
    let root = co.ROOT;
    try {
      const bl = await FL().blessRoot();
      if (bl.ok) root = bl.root || root;
      else line('console.note', { message: 'The company folder is not a blessed project on the station (' + bl.error + '), so ' + s.name + ' cannot read or write company files in this chat.' });
    } catch (e) { line('console.note', { message: 'Could not check the project grant: ' + e.message }); }
    const t = await transcript(id);
    const history = t.turns.slice(-40).map(x => ({ role: x.role, content: x.content }));
    const payload = { agentId: id, model: m.model, provider: m.provider, rosterSystem: true, isTask: false, streamId: STREAM(id),
      messages: history.concat([{ role: 'user', content: text }]), projectRoot: co.ROOT, placed: PLACED };
    let token; try { token = co.stationToken(); } catch (_) { token = null; }
    if (!token) { line('console.error', { code: 'station-down', message: 'No station token (secrets/station-token).', fix: 'Run scripts/setup-station.sh', link: '#/system' }); return res.end(); }
    const u = new URL(co.STATION_URL.replace(/\/+$/, '') + '/api/run');
    const data = JSON.stringify(payload);
    let ended = false, sawEnd = false, sawError = false, buf = '';
    const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'x-starnet-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), accept: 'application/x-ndjson' } }, ur => {
      if (ur.statusCode !== 200) {
        let d = ''; ur.on('data', c => { d += c; }); ur.on('end', () => {
          let msg = d.trim(); try { const j = JSON.parse(msg); msg = j.error || j.reason || msg; } catch (_) {}
          line('console.error', { code: 'station-refused', message: 'The station refused the run (HTTP ' + ur.statusCode + '): ' + (msg || 'no reason given').slice(0, 400), fix: /key|model|provider|credential/i.test(msg) ? 'Check the AI provider in Setup.' : null, link: /key|model|provider|credential/i.test(msg) ? '#/setup/provider' : null });
          ended = true; res.end();
        });
        return;
      }
      ur.setEncoding('utf8');
      ur.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!l.trim()) continue;
          try { const ev = JSON.parse(l); if (ev && ev.name === 'agent.run.end') sawEnd = true; if (ev && ev.name === 'agent.run.error') sawError = true; } catch (_) {}
          try { res.write(l + '\n'); } catch (_) {}
        }
      });
      ur.on('end', () => {
        if (buf.trim()) { try { res.write(buf.trim() + '\n'); } catch (_) {} }
        if (!sawEnd && !sawError) line('console.error', { code: 'cut-off', message: 'The station closed the run before ' + s.name + ' finished.', fix: 'Send the message again; if it keeps happening, look at the station log (System).', link: '#/system' });
        ended = true; res.end();
      });
      ur.on('error', e => { if (!ended) { line('console.error', { code: 'cut-off', message: 'The connection to the station broke: ' + e.message }); ended = true; res.end(); } });
    });
    up.on('error', e => { if (!ended) { line('console.error', { code: 'station-down', message: 'The station is not answering: ' + e.message, fix: 'systemctl --user start ' + svc() + '.service', link: '#/system' }); ended = true; res.end(); } });
    // the owner left (closed the tab, pressed Stop): the station's own rule stops a run whose page is gone
    res.on('close', () => { if (!ended) up.destroy(); });
    up.end(data);
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
    if (!wakers.length) problems.push({ code: 'no-waker', msg: 'no crew member is woken by owner messages', fix: 'Switch "wake on owner message" on for ' + ceoName + ' in Controls, Ticks and cadence.', link: '#/controls/ticks' });
    for (const p of (st.problems || [])) if (p.code !== 'no-model') problems.push({ code: p.code, msg: p.msg, fix: p.fix === 'node company/tools/founder-loop.js ensure' ? 'Run onboarding again: node company/tools/onboard.js --step founder-loop (or pick the AI provider again in Setup).' : p.fix, link: p.code === 'scheduler-off' || p.code === 'disabled' ? '#/automate' : '#/setup/provider' });
    const cad = readJson(co.p('company', 'work', 'ops', 'cadence.json'), null) || readJson(co.p('company', 'defaults', 'work', 'ops', 'cadence.json'), {}) || {};
    const tick = Number(cad.dispatcherTickMin) > 0 ? Number(cad.dispatcherTickMin) : 10;
    let lastTick = null; try { lastTick = fs.statSync(co.p('company', 'work', 'dispatch-log.md')).mtimeMs; } catch (_) {}
    const age = lastTick ? (Date.now() - lastTick) / 60000 : null;
    if (age === null || age > tick * 3 + 2) problems.push({ code: 'dispatcher', msg: age === null ? 'the dispatcher has never run, and it is what wakes ' + ceoName + ' for your messages' : 'the dispatcher last ran ' + Math.round(age) + ' min ago (it should every ' + tick + ' min)', fix: 'Start it: systemctl --user start ' + svc() + '-dispatch.timer', link: '#/system' });
    const ds = readJson(co.p('company', 'work', 'dispatch-state.json'), {}) || {};
    if (ds.owner && ds.owner.flagged) problems.push({ code: 'stalled', msg: ceoName + ' was woken ' + (ds.owner.count || 3) + ' times for these messages without answering, so the fast wake stopped', fix: 'Talk to ' + ceoName + ' live instead.', link: '#/comms/agent:' + ceoId });
    if (ds.askHeld && st.job && String(ds.askHeld).includes(st.job.name)) problems.push({ code: 'ask-mode', msg: ceoName + '\'s approval mode is "ask", so an unattended run could not save anything and the dispatcher holds it', fix: 'Talk to ' + ceoName + ' live, or give the seat full access in Crew.', link: '#/crew/' + ceoId });
    const job = st.job;
    const cooldown = Number(process.env.DISPATCH_OWNER_COOLDOWN_MIN) > 0 ? Number(process.env.DISPATCH_OWNER_COOLDOWN_MIN) : 10;
    const nextTick = age === null ? tick : Math.max(0, tick - age);
    const sinceRun = job && job.lastRunAt ? (Date.now() - Date.parse(job.lastRunAt)) / 60000 : Infinity;
    const cool = Math.max(0, cooldown - sinceRun);
    const nextCheckMin = Math.max(1, Math.ceil(cool > nextTick ? nextTick + Math.ceil((cool - nextTick) / tick) * tick : nextTick));
    return { ok: !problems.length, problems, ceo: { id: ceoId, name: ceoName }, nextCheckMin, working: !!(job && job.inFlight), tickMin: tick, loop: job ? job.name : null };
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

  return { info, send, brief, channelState, messageStates, modelFor, seatOf };
};
