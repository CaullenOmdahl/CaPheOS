/* console/activity.js — the crew's work, visible: who is running now, what each run did, and when each seat runs next.
 * Spec: docs/CONSOLE-API.md "Now and activity".
 *
 * Live: the console keeps ONE connection to the station's observer feed (GET /api/observe, SSE frames
 * `data: {name, payload}` for every non-internal run: tool calls, tokens, cost, end) and folds it into a table of runs
 * in flight, merged with GET /api/state/snapshot (the runs the station holds, including ones that started before the
 * console connected). Every change emits the console SSE topic `now`.
 *   GET /api/now                    runs in flight (seat, routine or chat, current step in words, elapsed, cost so far)
 *                                   + each seat's next wake and why it would wake sooner
 *   GET /api/now/run/<runId>?after=N   the run's events after N (the Watch view polls it), and whether it ended
 *   GET /api/activity               recent activity: finished runs (outcome, first sentence of the reply, cost), hiring,
 *                                   owner-channel replies and decisions, each with links into the console (route map)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

module.exports = function activity(deps) {
  const { co, stationGet, emit, tool } = deps;
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
  const live = new Map();     // runId -> run
  const ended = [];           // the last runs that ended while we watched (newest last)
  let seq = 0, feed = { up: false, since: null, error: null };

  /* ---------- the current step, in words ---------- */
  const rel = p => String(p || '').replace(co.ROOT + path.sep, '').replace(/^\.\//, '');
  function stepText(name, args) {
    let raw = String(args || '').trim(), obj = null;
    if (/^\{/.test(raw)) { try { obj = JSON.parse(raw); } catch (_) { const m = /"(cmd|command|path|file|query|url|q)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw); if (m) obj = { [m[1]]: m[2].replace(/\\"/g, '"') }; } }
    const host = u => { try { return new URL(u).host; } catch (_) { return String(u).slice(0, 60); } };
    if (obj && typeof obj === 'object') {
      const cmd = obj.cmd || obj.command;
      if (cmd) {
        const c = rel(String(cmd)).replace(/\s+/g, ' ');
        const tool = /node\s+(?:\S*\/)?(company\/tools\/[\w.-]+\.js)(\s+[\w-]+)?/.exec(c);
        if (tool) return 'running ' + tool[1].replace('company/tools/', '') + (tool[2] || '') + '…';
        const url = /https?:\/\/[^\s"']+/.exec(c);
        if (/^\s*(curl|wget)\b/.test(c) && url) return 'fetching ' + host(url[0]);
        return 'running `' + c.slice(0, 70) + (c.length > 70 ? '…' : '') + '`';
      }
      if (obj.url) return 'reading ' + host(obj.url);
      if (obj.query || obj.q) return 'searching for “' + String(obj.query || obj.q).slice(0, 60) + '”';
      raw = obj.path || obj.file || obj.dir || '';
    }
    const a = rel(String(raw).replace(/\s+/g, ' ').trim()).slice(0, 120);
    const n = String(name || '');
    const m = /node\s+(company\/tools\/[\w.-]+\.js)(\s+[\w-]+)?/.exec(a);
    if (/^(code\.run|shell|shell_bg|terminal)/i.test(n) && m) return 'running ' + m[1].replace('company/tools/', '') + (m[2] || '') + '…';
    if (/fs_read|read_file|fs\.read/i.test(n)) return 'reading ' + a;
    if (/fs_list|list_dir|fs\.list/i.test(n)) return 'looking through ' + (a || 'a folder');
    if (/fs_write|fs_append|fs_edit|fs_patch|write_file/i.test(n)) return 'writing ' + a;
    if (/web|search|fetch/i.test(n)) return 'searching the web' + (a ? ': ' + a : '');
    if (/^(code\.run|shell|shell_bg|terminal)/i.test(n)) return 'running ' + (a || 'a command');
    if (/memory/i.test(n)) return 'checking its notes';
    if (/team\.|dispatch|spawn/i.test(n)) return 'handing work to a colleague';
    return n.replace(/[_.]/g, ' ') + (a ? ' ' + a : '');
  }
  function runRow(id) { let r = live.get(id); if (!r) { r = { runId: id, agentId: '', startedAt: Date.now(), events: [], text: '', usd: 0, step: null, steps: 0 }; live.set(id, r); } return r; }
  function push(r, ev) { ev.seq = ++seq; r.events.push(ev); if (r.events.length > 400) r.events.splice(0, r.events.length - 400); }
  function onEvent(name, p) {
    if (!p || !p.runId) return;
    if (name === 'agent.run.start') {
      const r = runRow(p.runId); Object.assign(r, { agentId: p.agentId || r.agentId, model: p.model || null, trigger: p.trigger || null, surface: p.surface || null, streamId: p.streamId || null, prompt: p.prompt || null, startedAt: r.startedAt || Date.now() });
      push(r, { name: 'start' }); emit('now'); return;
    }
    const r = live.get(p.runId) || (name === 'agent.run.end' ? null : runRow(p.runId));
    if (!r) return;
    if (p.agentId && !r.agentId) r.agentId = p.agentId;
    if (name === 'agent.token') { r.text = (r.text + p.delta).slice(-6000); push(r, { name: 'token', delta: p.delta }); }
    else if (name === 'agent.tool_call') { r.step = stepText(p.name, p.argsSummary); r.steps++; push(r, { name: 'tool', tool: p.name, text: r.step, callId: p.callId }); emit('now'); }
    else if (name === 'agent.tool_result') push(r, { name: 'result', callId: p.callId, ok: !!p.ok && !p.isError, summary: p.summary || '' });
    else if (name === 'agent.cost') { r.usd += Number(p.usd) || 0; }
    else if (name === 'agent.run.error') push(r, { name: 'error', message: p.message || 'run failed' });
    else if (name === 'agent.run.end') {
      r.usd = Number(p.usd) || r.usd; push(r, { name: 'end', reason: p.reason, outcome: p.outcome || null, usd: r.usd });
      r.endedAt = Date.now(); r.outcome = p.outcome || (p.reason === 'done' ? 'succeeded' : p.reason);
      live.delete(r.runId); ended.push(r); if (ended.length > 40) ended.shift(); emit('now'); emit('activity');
    }
  }

  /* ---------- one observer connection, reconnecting ---------- */
  let req = null, retry = null, stopped = false;
  function connect() {
    if (stopped) return;
    let token; try { token = co.stationToken(); } catch (_) { token = null; }
    if (!token) { feed = { up: false, error: 'no station token' }; retry = setTimeout(connect, 15000); if (retry.unref) retry.unref(); return; }
    let u; try { u = new URL(co.STATION_URL.replace(/\/+$/, '') + '/api/observe'); } catch (e) { feed = { up: false, error: e.message }; return; }
    req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { 'x-starnet-token': token, accept: 'text/event-stream' } }, res => {
      if (res.statusCode !== 200) { res.resume(); feed = { up: false, error: 'HTTP ' + res.statusCode }; again(); return; }
      feed = { up: true, since: new Date().toISOString(), error: null };
      res.setEncoding('utf8'); let buf = '';
      res.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const l of frame.split('\n')) if (l.startsWith('data:')) { try { const ev = JSON.parse(l.slice(5).trim()); if (ev && ev.name) onEvent(ev.name, ev.payload); } catch (_) {} }
        }
      });
      res.on('end', again); res.on('error', again);
    });
    req.on('error', e => { feed = { up: false, error: e.message }; again(); });
    req.end();
  }
  function again() { if (stopped) return; clearTimeout(retry); feed.up = false; retry = setTimeout(connect, 5000); if (retry.unref) retry.unref(); }
  function start() { connect(); }
  function stop() { stopped = true; clearTimeout(retry); try { if (req) req.destroy(); } catch (_) {} }

  /* ---------- views ---------- */
  function crewName(id) { const c = co.crew()[id]; return (c && c.name) || id || 'someone'; }
  function openHandoffs(inbox) {
    let t = ''; try { t = fs.readFileSync(co.p('company', 'work', 'handoffs', inbox), 'utf8'); } catch (_) { return 0; }
    return t.split(/^(?=## )/m).filter(s => /^## /.test(s) && /^\*\*Status:\*\*\s*OPEN\b/m.test(s)).length;
  }
  function kindOf(r, jobs) {
    const sid = String(r.streamId || '');
    if (/^console-/.test(sid)) return { kind: 'chat', label: 'live chat with you', href: '#/comms/agent:' + sid.slice(8) };
    const job = (jobs || []).find(j => j.lastRunId === r.runId || (sid && sid === 'cron-' + r.runId && j.agentId === r.agentId && j.inFlight)) ||
      (r.source === 'cron' || /^cron-/.test(sid) ? (jobs || []).find(j => j.agentId === r.agentId && (j.inFlight || j.state === 'running')) : null);
    if (job) return { kind: 'routine', label: 'routine "' + job.name + '"', href: '#/automate' };
    return { kind: r.source || r.surface || 'run', label: r.source === 'cron' ? 'a routine' : 'a run', href: '#/crew/' + r.agentId };
  }
  async function now() {
    const [snap, cr] = await Promise.all([stationGet('state/snapshot', 3000), stationGet('cron', 3000)]);
    const jobs = cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : [];
    const held = snap.ok && snap.data && Array.isArray(snap.data.runs) ? snap.data.runs : null;
    const ids = new Set();
    const runs = [];
    for (const s of held || []) {
      ids.add(s.runId);
      const r = live.get(s.runId) || {};
      runs.push(view(Object.assign({}, s, r, { startedAt: s.startedAt || r.startedAt, agentId: s.agentId || r.agentId, streamId: s.streamId || r.streamId, source: s.source }), jobs));
    }
    // runs the observer saw start that the snapshot does not list (yet): still in flight
    if (!held) for (const r of live.values()) if (!ids.has(r.runId)) runs.push(view(r, jobs));
    const crew = co.crew();
    let unread = 0; try { unread = tool('owner-inbox.js').unacked().length; } catch (_) {}
    const seats = Object.entries(crew).map(([id, c]) => {
      const job = c.loop ? jobs.find(j => j.name === c.loop || String(j.name || '').startsWith(c.loop)) : null;
      const running = runs.filter(r => r.agentId === id);
      const sooner = [];
      const oh = c.inbox ? openHandoffs(c.inbox) : 0;
      if (oh) sooner.push(oh + ' open handoff' + (oh > 1 ? 's' : ''));
      if (c.wakeOnOwnerMessage && unread) sooner.push(unread + ' unread message' + (unread > 1 ? 's' : '') + ' from you');
      const next = job ? job.nextRunAt || job.nextFireAt || null : null;
      return { id, name: c.name || id, title: c.title || '', running: running.length, loop: job ? job.name : null, enabled: job ? job.enabled !== false : null,
        nextRunAt: next, lastRunAt: job ? job.lastRunAt || null : null, schedule: job ? job.scheduleDisplay || (job.schedule && (job.schedule.display || job.schedule.expr)) || null : null,
        soonerBecause: sooner, wakesOnMessage: !!c.wakeOnOwnerMessage, schedulerOn: cr.ok ? cr.data.enabled !== false && !cr.data.halted : null };
    });
    // Sprint (start-up, cadence.js): while it is on, a seat's next wake is its open work, not a clock
    let sprint = null;
    try {
      const cad = tool('cadence.js'); const v = cad.sprintOf(cad.load(), Date.now());
      if (v.active) {
        const s = cad.sprintStatus({ view: v });
        sprint = { on: true, since: v.since, until: v.until, untilWhy: v.untilWhy, by: v.by, floorMin: v.config.cooldownFloorMin, wakes: s.wakes, idleWakes: s.idleWakes, idleWakeRatio: s.idleWakeRatio,
          itemsDone: s.itemsDone, spentUsd: s.spentUsd, budgetUsd: s.budgetUsd, usdPerItem: s.usdPerItem, proposalsPerHour: s.proposalsPerHour, reviewsPerHour: s.reviewsPerHour };
        for (const x of seats) {
          const ln = (s.lanes || {})[x.id] || {};
          x.lanes = { running: x.running, max: ln.max || 1, possible: ln.possible || 0, why: ln.why || null };
          x.sprint = x.running ? 'working' : x.soonerBecause.length ? 'working' : 'waiting for work';
        }
      }
    } catch (_) { sprint = null; }
    return { ok: true, station: { up: !!snap.ok, error: snap.ok ? null : snap.error || 'HTTP ' + snap.status, feed: feed.up }, runs, seats, sprint };
  }
  function view(r, jobs) {
    const k = kindOf(r, jobs);
    const lr = live.get(r.runId);
    return { runId: r.runId, agentId: r.agentId, name: crewName(r.agentId), startedAt: r.startedAt, elapsedSec: r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : null,
      kind: k.kind, label: k.label, href: k.href, step: (lr && lr.step) || null, steps: (lr && lr.steps) || 0, usd: lr ? Math.round(lr.usd * 10000) / 10000 : null, stoppable: r.stoppable !== false, watched: !!lr };
  }
  function runEvents(id, after) {
    const r = live.get(id) || ended.find(x => x.runId === id);
    if (!r) return { ok: true, known: false, events: [], done: null };
    const a = Number(after) || 0;
    return { ok: true, known: true, runId: id, agentId: r.agentId, name: crewName(r.agentId), startedAt: r.startedAt, events: r.events.filter(e => e.seq > a), seq, done: !!r.endedAt, outcome: r.outcome || null, usd: r.usd };
  }

  /* ---------- recent activity ---------- */
  const firstSentence = t => { const s = String(t || '').replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim(); const m = /^(.{8,220}?[.!?])(\s|$)/.exec(s); return (m ? m[1] : s.slice(0, 200)) || ''; };
  function linksFor(text) {
    const out = []; const t = String(text || '');
    const add = (label, href) => { if (!out.some(x => x.href === href)) out.push({ label, href }); };
    if (/CHARTER\.md/.test(t)) add('Charter', '#/setup/charter');
    if (/handoffs\//.test(t)) add('Handoffs', '#/work/handoffs');
    if (/decisions\.md/.test(t)) add('Decisions', '#/work/decisions');
    if (/company\/hiring\/|hire\.js/.test(t)) add('Hiring', '#/hiring');
    if (/inbox\.js ask|question/.test(t)) add('Needs you', '#/today');
    if (/quests?\b/.test(t)) add('Quests', '#/work/quests');
    return out;
  }
  // company-local "YYYY-MM-DD HH:MM" (the tools' stamps, co.TZ) -> ISO
  function localIso(date, time) {
    const lp = co.localParts(new Date()); const off = Date.parse(lp.date + 'T' + lp.time + ':00Z') - Math.floor(Date.now() / 60000) * 60000;
    const t = Date.parse(date + 'T' + (time || '00:00') + ':00Z'); return Number.isFinite(t) ? new Date(t - off).toISOString() : null;
  }
  function govLevel(cat) { try { return co.gate(cat); } catch (_) { return null; } }
  const LEVEL_WORDS = { auto: 'Crew decides: done without asking you', notify: 'Crew decides and tells you', triage: 'A model triaged it', approve: 'You approved it' };
  async function recent() {
    const since = Date.now() - 48 * 3600e3;
    const items = [];
    const cr = await stationGet('cron', 3000);
    const jobs = cr.ok && cr.data && Array.isArray(cr.data.jobs) ? cr.data.jobs : [];
    // finished runs (runs.jsonl), the reply's first sentence from the routine's last output or what we watched
    let lines = []; try { lines = require(co.p('company', 'tools', 'lib', 'bounded.js')).tailLines(co.p('.starnet-data', 'workspaces', 'runs.jsonl'), 400); } catch (_) {}   // the end only (runs.jsonl is StarNet's and only grows)
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || r.internal || !(Number(r.endedAt || r.ts) >= since)) continue;
      if (/^(aicheck|health)/i.test(String(r.streamId || '')) || /^Health check/i.test(String(r.title || ''))) continue;
      const job = jobs.find(j => j.id === r.cronJobId);
      const seen = ended.find(x => x.runId === r.runId);
      const out = (job && job.lastRunId === r.runId && job.lastOutput) || (seen && seen.text) || r.deliveryText || '';
      const what = /^console-/.test(String(r.streamId || '')) ? 'chatted with you' : job ? 'ran "' + job.name + '"' : r.surface === 'autonomous' ? 'ran a routine' : 'ran';
      items.push({ at: new Date(Number(r.endedAt || r.ts)).toISOString(), kind: 'run', who: crewName(r.agentId), agentId: r.agentId, runId: r.runId,
        title: crewName(r.agentId) + ' ' + what, outcome: r.outcome || (r.reason === 'done' ? 'succeeded' : r.reason || null), usd: Number(r.usd) || 0,
        text: firstSentence(out) || (r.toolsOk ? r.toolsOk + ' tool steps' : ''), links: linksFor(out).concat([{ label: crewName(r.agentId), href: '#/crew/' + r.agentId }]) });
    }
    // runs we watched end that runs.jsonl does not have yet
    for (const r of ended) if (!items.some(x => x.runId === r.runId) && r.endedAt >= since) items.push({ at: new Date(r.endedAt).toISOString(), kind: 'run', who: crewName(r.agentId), agentId: r.agentId, runId: r.runId, title: crewName(r.agentId) + ' ran', outcome: r.outcome, usd: r.usd, text: firstSentence(r.text), links: linksFor(r.text) });
    // hiring: every round's log (open, interviews, hire), with the governance level that let it happen
    const lvl = govLevel('hiring');
    let rounds = []; try { rounds = fs.readdirSync(co.p('company', 'hiring')).filter(d => fs.existsSync(co.p('company', 'hiring', d, 'log.md'))); } catch (_) {}
    for (const d of rounds) {
      let t = ''; try { t = fs.readFileSync(co.p('company', 'hiring', d, 'log.md'), 'utf8'); } catch (_) {}
      for (const l of t.split('\n').filter(x => /^- \d{4}-\d{2}-\d{2}/.test(x)).slice(-12)) {
        const m = /^- (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})?\S*\s+(.*)$/.exec(l); if (!m) continue;
        const at = localIso(m[1], m[2]); if (!at) continue;
        if (Date.parse(at) < since) continue;
        const hired = /^HIRED /.test(m[3]);
        items.push({ at, kind: 'hiring', who: 'Hiring', title: hired ? 'Hired: ' + m[3].replace(/^HIRED /, '').split(';')[0] : 'Hiring round ' + d + ': ' + m[3].slice(0, 120),
          text: hired ? (LEVEL_WORDS[lvl] || '') + (lvl === 'auto' || lvl === 'notify' ? ' (hiring is set to "' + lvl + '"; change it in Controls)' : '') : '', level: lvl,
          links: [{ label: 'Crew', href: '#/crew' }, { label: 'Hiring', href: '#/hiring' }].concat(lvl === 'auto' || lvl === 'notify' ? [{ label: 'Hiring level', href: '#/controls/gov' }] : []) });
      }
    }
    // each open round's live stage (candidates created, interviewing 2/3, waiting for pick by X), one item per round
    let H = null; try { H = tool('hire.js'); } catch (_) {}
    for (const d of rounds) {
      const rd = readJson(co.p('company', 'hiring', d, 'round.json'), null);
      if (!rd || rd.hired || rd.closed || !H) continue;
      let st = null; try { st = H.roundStage(co.p('company', 'hiring', d), rd); } catch (_) {}
      if (!st) continue;
      const tl = (st.timeline || []).filter(x => x.at).map(x => x.step + ' ' + String(x.at).slice(11, 16)).join(' · ');
      items.push({ at: st.at || rd.openedAt || new Date().toISOString(), kind: 'hiring-stage', who: 'Hiring', live: true, stage: st.key,
        title: (rd.role || d) + ': ' + st.label, text: tl, links: [{ label: 'Hiring', href: '#/hiring' }] });
    }
    // replies on the owner channel
    try { for (const m of tool('owner-inbox.js').sent()) if (Date.parse(m.at) >= since) items.push({ at: m.at, kind: 'message', who: m.from || 'Company', title: (m.from || 'The company') + ' wrote to you', text: firstSentence(m.text), links: [{ label: 'Open', href: '#/comms/owner' }].concat(linksFor(m.text)) }); } catch (_) {}
    // decisions
    let dec = ''; try { dec = fs.readFileSync(co.p('company', 'work', 'decisions.md'), 'utf8'); } catch (_) {}   // bounded: retention.js keeps 30 days live (docs/RETENTION.md)
    for (const l of dec.split('\n').filter(x => /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(x)).slice(-20)) {
      const m = /^- (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.*)$/.exec(l); if (!m) continue;
      const at = localIso(m[1], m[2]); if (!at || Date.parse(at) < since) continue;
      items.push({ at, kind: 'decision', who: 'Decision', title: m[3].slice(0, 200), text: '', links: [{ label: 'Decisions', href: '#/work/decisions' }].concat(linksFor(m[3])) });
    }
    items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { ok: true, items: items.slice(0, 60) };
  }

  return { start, stop, now, runEvents, recent, onEvent, stepText, feed: () => feed };
};
