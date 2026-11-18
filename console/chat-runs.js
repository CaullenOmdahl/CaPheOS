/* console/chat-runs.js — the owner's live chat runs, kept by the console so that neither a console restart nor a browser
 * reload ends one or loses its reply. Spec: docs/CONSOLE-API.md "Live chat" (In flight, re-attach, busy).
 *
 * The run belongs to the station, not to an HTTP connection. With StarNet patch 0014 (GET /api/version capability
 * "run-detach") the console starts a chat run with detach:true, so the station keeps it running when the console's
 * request closes, and follows its events on the station's observer feed (GET /api/observe, SSE with a replay cursor).
 * Without the capability it reads the run's own /api/run stream (the old way: a console restart still ends the run, a
 * browser reload no longer does).
 *
 * Every event of a tracked run is appended to a journal, company/state/chat-runs/<runId>.ndjson, one {c?, name, payload}
 * line each (c = the observer cursor it came with), and the run's row is kept in company/state/chat-runs.json
 * {runs: {runId: {seat, streamId, status: running|done|cut, startedAt, endedAt, reason, gap, userText, source}}}. The
 * browser reads a run through attach(runId, from): the journal from line `from`, then the live lines; it re-attaches
 * with the count it already has after a reload or a console restart. A run's last journal line is console.final {text,
 * complete}: the reply as the station's transcript recorded it (complete: the run ended on its own), so the page never
 * takes a cut-off stream for the whole answer.
 *
 * After a console restart, start() reopens the observer feed from the last cursor any running run journaled: what the
 * station's replay ring still holds comes back in order; past it (the ring is 512 events) the run is marked gap and the
 * page waits for console.final. A run that goes quiet is checked against the station's run record (GET /api/runs?runId=)
 * and finished from it. busy() lists the runs in flight (GET /api/console/busy, scripts/restart-console.sh --when-idle).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const QUIET_MS = Number(process.env.CHAT_RUN_QUIET_MS) > 0 ? Number(process.env.CHAT_RUN_QUIET_MS) : 60000;   // then ask the station
const MAX_AGE_MS = 3 * 3600e3;   // a run older than this with no end is given up on (the station's own limit is lower)
const SEAT_STREAM = /^(?:console|meeting|huddle)-([A-Za-z0-9_-]{1,100})$/;   // a console chat, a meeting turn (console/meeting.js), or the same engine in another room

module.exports = function chatRuns(deps) {
  const { co, stationGet } = deps;
  const finalText = deps.finalText || (async () => null);   // (seat, runId, run) -> {text, exact} from the transcript, or null
  const dir = () => co.p('company', 'state', 'chat-runs');
  const stateFile = () => co.p('company', 'state', 'chat-runs.json');
  const journalOf = id => path.join(dir(), id.replace(/[^A-Za-z0-9_-]/g, '') + '.ndjson');
  const listeners = new Map();    // runId -> Set(fn(line))
  const lastAt = new Map();       // runId -> ms of its last event (quiet check)
  const lastSeq = new Map();      // runId -> the observer sequence of its last journaled event (replay dedupe)
  const counts = new Map();       // runId -> journal line count
  let state = null, feed = null, feedReady = null, feedCursor = '', sweepTimer = null, capCache = null;

  function load() {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (_) { state = null; }
    if (!state || typeof state !== 'object' || !state.runs) state = { runs: {} };
    return state;
  }
  function save() {
    const s = load();
    // keep the last 50 finished runs (and their journals); drop older ones
    const done = Object.entries(s.runs).filter(([, r]) => r.status !== 'running').sort((a, b) => (b[1].endedAt || 0) - (a[1].endedAt || 0));
    for (const [id] of done.slice(50)) { delete s.runs[id]; try { fs.unlinkSync(journalOf(id)); } catch (_) {} }
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    const tmp = stateFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, stateFile());
  }
  const seqOf = c => { const m = /:(\d+)$/.exec(String(c || '')); return m ? Number(m[1]) : -1; };
  const epochOf = c => String(c || '').replace(/:\d+$/, '');
  function lines(id) {
    let raw = ''; try { raw = fs.readFileSync(journalOf(id), 'utf8'); } catch (_) {}
    return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  }
  function countOf(id) { if (!counts.has(id)) counts.set(id, lines(id).length); return counts.get(id); }

  // one journal line, to disk then to every attached page
  function append(id, line) {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(journalOf(id), JSON.stringify(line) + '\n');
    counts.set(id, countOf(id) + 1);
    lastAt.set(id, Date.now());
    if (line.c) lastSeq.set(id, seqOf(line.c));
    for (const fn of listeners.get(id) || []) { try { fn(line); } catch (_) {} }
  }

  function track(runId, row) {
    const s = load();
    if (s.runs[runId]) return s.runs[runId];
    s.runs[runId] = Object.assign({ status: 'running', startedAt: Date.now(), endedAt: null, reason: null, gap: false }, row);
    save(); lastAt.set(runId, Date.now()); armSweep();
    return s.runs[runId];
  }

  /* a station event for a run: journal it; agent.run.end finishes the run (the transcript gives the final text) */
  function ingest(runId, name, payload, c) {
    const r = load().runs[runId]; if (!r || r.status !== 'running') return;
    if (c && lastSeq.has(runId) && seqOf(c) <= lastSeq.get(runId) && epochOf(c) === epochOf(r.cursor || c)) return;   // a replay of what is journaled
    if (c) r.cursor = c;
    append(runId, c ? { c, name, payload } : { name, payload });
    if (name === 'agent.run.end') finish(runId, { reason: payload && (payload.reason || payload.outcome) || 'done', outcome: payload && payload.outcome, failureCode: payload && payload.failureCode });
  }

  async function finish(runId, how) {
    const r = load().runs[runId]; if (!r || r.status !== 'running') return;
    r.status = 'finishing'; save();
    const ended = /^(done|succeeded|ok|completed?)$/i.test(String(how.reason || '')) || /^succeeded$/.test(String(how.outcome || ''));
    const streamed = lines(runId).filter(l => l.name === 'agent.token').map(l => (l.payload && l.payload.delta) || '').join('');
    let got = null; try { got = await finalText(r.seat, runId, r, streamed); } catch (_) {}
    const text = got && typeof got.text === 'string' ? got.text : streamed;
    // complete: the run ended on its own, and nothing between was lost (or the transcript named this run's reply exactly)
    append(runId, { name: 'console.final', payload: { runId, text, complete: ended && (!r.gap || !!(got && got.exact)), reason: how.reason || null, outcome: how.outcome || null, failureCode: how.failureCode || null, gap: !!r.gap, lost: !!how.lost } });
    r.status = ended ? 'done' : 'cut'; r.endedAt = Date.now(); r.reason = how.reason || null;
    save();
    append(runId, { name: 'console.end', payload: { runId, status: r.status } });
    listeners.delete(runId); lastAt.delete(runId); lastSeq.delete(runId);
    if (!running().length) stopFeed();
  }

  const running = () => Object.entries(load().runs).filter(([, r]) => r.status === 'running' || r.status === 'finishing').map(([id]) => id);

  /* ---------- the observer feed ---------- */
  function stopFeed() { if (feed) { try { feed.destroy(); } catch (_) {} } feed = null; feedReady = null; }
  function openFeed() {
    if (feedReady) return feedReady;
    feedCursor0 = feedCursor;
    let token = null; try { token = co.stationToken(); } catch (_) {}
    if (!token) return Promise.resolve(false);
    const u = new URL(co.STATION_URL.replace(/\/+$/, '') + '/api/observe' + (feedCursor ? '?cursor=' + encodeURIComponent(feedCursor) : ''));
    feedReady = new Promise(resolve => {
      let settled = false; const settle = v => { if (!settled) { settled = true; resolve(v); } };
      const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'x-starnet-token': token, accept: 'text/event-stream' } }, res => {
        if (res.statusCode !== 200) { res.resume(); settle(false); feedReady = null; return; }
        feed = req; res.setEncoding('utf8'); let buf = '';
        let readyTimer = setTimeout(() => settle(true), 1500);   // a feed with no ready frame (an older station) is still a feed
        res.on('data', d => {
          buf += d; let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            let id = null, data = '';
            for (const l of frame.split('\n')) { if (l.startsWith('id: ')) id = l.slice(4).trim(); else if (l.startsWith('data: ')) data += l.slice(6); }
            if (!data) continue;
            let j; try { j = JSON.parse(data); } catch (_) { continue; }
            if (id) feedCursor = id;
            if (j && j.stream === 'ready') {
              // a cursor the station no longer holds (it restarted, or the replay ring moved past it): what ran meanwhile is lost
              if (j.reset && feedCursor0) for (const rid of running()) { const r = load().runs[rid]; if (r && r.source === 'observe' && !r.gap) { r.gap = true; save(); append(rid, { name: 'console.gap', payload: { runId: rid } }); } }
              feedCursor0 = ''; clearTimeout(readyTimer); settle(true); continue;
            }
            onFeed(j.name, j.payload || {}, id);
          }
        });
        let gone = false;
        const closed = () => { if (gone) return; gone = true; clearTimeout(readyTimer); feed = null; feedReady = null; settle(false); if (running().some(id => (load().runs[id] || {}).source === 'observe')) setTimeout(() => { openFeed(); }, 2000).unref(); };
        res.on('end', closed); res.on('error', closed); res.on('close', closed);
      });
      req.on('error', () => { feedReady = null; settle(false); if (running().length) setTimeout(() => { openFeed(); }, 2000).unref(); });
      setTimeout(() => settle(false), 4000).unref();
    });
    return feedReady;
  }
  let feedCursor0 = '';   // the cursor this (re)open resumed from: a reset on it means a gap
  const pendingStarts = new Map();   // streamId -> {row, resolve}: a send() waiting for its run's start
  /* the run of a pending send() is known (its start on the feed, or on the /api/run response, whichever is first):
     track it at once, synchronously, so the feed's next event in the same chunk is journaled */
  function claim(streamId, runId) {
    const w = pendingStarts.get(streamId);
    if (!w || !runId || load().runs[runId]) return false;
    pendingStarts.delete(streamId);
    track(runId, Object.assign({ streamId }, w.row));
    try { w.onTrack(runId); } catch (_) {}
    w.resolve(runId);
    return true;
  }
  function onFeed(name, p, c) {
    const runId = String(p.runId || '');
    if (name === 'agent.run.start' && SEAT_STREAM.test(String(p.streamId || ''))) claim(String(p.streamId), runId);
    if (runId && load().runs[runId] && load().runs[runId].source === 'observe') ingest(runId, name, p, c);
  }

  /* ---------- the quiet check: a run with no events for a while is asked about at the station ---------- */
  function armSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweep, Math.min(15000, QUIET_MS / 2)); sweepTimer.unref();
  }
  async function sweep() {
    const ids = running();
    if (!ids.length) { clearInterval(sweepTimer); sweepTimer = null; return; }
    for (const id of ids) {
      const r = load().runs[id]; if (!r || r.status !== 'running') continue;
      if (Date.now() - (lastAt.get(id) || r.startedAt) < QUIET_MS) continue;
      lastAt.set(id, Date.now());
      const got = await stationGet('runs?agent=' + encodeURIComponent(r.seat) + '&runId=' + encodeURIComponent(id) + '&limit=5', 5000).catch(() => null);
      const rows = got && got.ok && got.data && Array.isArray(got.data.runs) ? got.data.runs : [];
      const row = rows.find(x => x && x.runId === id && (x.endedAt || x.reason));
      if (row) { if (!r.gap) { r.gap = true; save(); } finish(id, { reason: row.reason || row.outcome || 'done', outcome: row.outcome, failureCode: row.failureCode }); }
      else if (Date.now() - r.startedAt > MAX_AGE_MS) finish(id, { reason: 'lost', lost: true });
    }
  }

  /* ---------- the API chat.js and server.js use ---------- */
  // GET /api/version capabilities: "run-detach" (patch 0014); cached for a minute
  async function canDetach() {
    if (capCache && Date.now() - capCache.at < 60000) return capCache.v;
    const r = await stationGet('version', 3000).catch(() => null);
    const v = !!(r && r.ok && r.data && Array.isArray(r.data.capabilities) && r.data.capabilities.includes('run-detach'));
    capCache = { at: Date.now(), v }; return v;
  }
  /* before a run starts: prepare(streamId, row, onTrack) -> {source, started: Promise(runId), claim(runId), cancel()}.
     source 'observe' (the station can detach: the feed is open and the run's start on it is claimed for this seat) or
     'direct' (the caller reads the /api/run stream and ingests each event itself). onTrack(runId) runs right after the
     run is tracked, before any of its events is journaled (the caller's opening lines go first). */
  async function prepare(streamId, row, onTrack) {
    const source = (await canDetach()) && (await openFeed()) ? 'observe' : 'direct';
    let resolve; const started = new Promise(r => { resolve = r; });
    pendingStarts.set(streamId, { row: Object.assign({}, row, { source }), resolve, onTrack: onTrack || (() => {}) });
    return { source, started, claim: runId => claim(streamId, runId), cancel: () => pendingStarts.delete(streamId) };
  }
  // attach(runId, from, fn) -> unsubscribe | null (unknown run). Replays journal lines from `from`, then live ones.
  function attach(runId, from, fn) {
    const r = load().runs[runId]; if (!r) return null;
    const have = lines(runId); counts.set(runId, have.length);
    for (const l of have.slice(Math.max(0, Number(from) || 0))) fn(l);
    if (r.status !== 'running' && r.status !== 'finishing') return () => {};
    if (!listeners.has(runId)) listeners.set(runId, new Set());
    listeners.get(runId).add(fn);
    return () => { const s = listeners.get(runId); if (s) s.delete(fn); };
  }
  function inflight(seat) {
    const s = load();
    const id = running().filter(x => s.runs[x].seat === seat && !s.runs[x].meeting).sort((a, b) => s.runs[b].startedAt - s.runs[a].startedAt)[0];
    return id ? Object.assign({ runId: id }, s.runs[id]) : null;
  }
  function runOf(id) { return load().runs[id] || null; }
  // the console restarted: reopen the feed from the last cursor a running run journaled, and finish what already ended
  function start() {
    const s = load(); let save1 = false, resumeFrom = '';
    for (const [id, r] of Object.entries(s.runs)) {
      if (r.status === 'finishing') { r.status = 'running'; save1 = true; }
      if (r.status !== 'running') continue;
      const ls = lines(id); counts.set(id, ls.length);
      if (ls.some(l => l.name === 'console.end')) { r.status = (ls.find(l => l.name === 'console.end').payload || {}).status || 'done'; save1 = true; continue; }
      const last = [...ls].reverse().find(l => l.c); if (last) lastSeq.set(id, seqOf(last.c));
      lastAt.set(id, Date.now());
      if (r.source === 'observe') {
        if (last && (!resumeFrom || seqOf(last.c) < seqOf(resumeFrom))) resumeFrom = last.c;
        if (!last) { r.gap = true; save1 = true; }
      } else {
        // a run read off its own /api/run stream died with the old console process: the station says how it ended
        r.gap = true; save1 = true;
      }
      if (ls.some(l => l.name === 'agent.run.end')) { const e = ls.find(l => l.name === 'agent.run.end').payload || {}; setImmediate(() => finish(id, { reason: e.reason || e.outcome || 'done', outcome: e.outcome, failureCode: e.failureCode })); }
    }
    if (save1) save();
    const ids = running();
    if (!ids.length) return;
    armSweep();
    if (ids.some(id => s.runs[id].source === 'observe')) { feedCursor = resumeFrom; openFeed(); }
    // a direct run: its stream is gone with the old process; ask the station right away
    for (const id of ids) if (s.runs[id].source !== 'observe') lastAt.set(id, 0);
    setTimeout(sweep, 500).unref();
  }
  const journal = (id, name, payload) => append(id, { name, payload });
  return { track, ingest, finish, attach, prepare, canDetach, inflight, runOf, busy: running, start, lines, countOf, journal, _state: load };
};
