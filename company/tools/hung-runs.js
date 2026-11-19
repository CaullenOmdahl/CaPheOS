#!/usr/bin/env node
'use strict';
/* hung-runs.js — a run the station still counts as running, with nothing written for an hour, is stopped.
 *
 * Why: a run's AI process can end without the station recording the run as ended. The station then holds the seat's
 * routine lease (the seat is never woken again) and every "restart when idle" waits on it until it gives up. A shell
 * command is cut off at 10 minutes and a model turn takes minutes, so a run with no transcript row for HUNG_MIN (60) is
 * dead: stopping it (POST /api/cancel, what the console's Stop does) loses nothing and frees the seat and the station.
 * The station already does this for background workers (subagent stall sweep), not for routine runs.
 *
 * Never stopped: the owner's own chat runs (source interactive, not internal), a run younger than HUNG_MIN, a run with a
 * transcript row in the last HUNG_MIN. A run the transcript never names counts from its start.
 *
 *   node company/tools/hung-runs.js tick [--dry-run]     what the dispatcher runs each tick (it calls tick() in process)
 *   node company/tools/hung-runs.js status               the runs in flight and how long each has been silent
 */
const fs = require('fs'), path = require('path');
const co = require('./lib/company');

const HUNG_MIN = 60;
const TAIL_BYTES = 16 * 1024 * 1024;   // the end of the newest transcript segments: an hour of rows fits many times over
const S = { call: (m, p, b) => require('./station-crew.js').call(m, p, b, 15000), now: () => Date.now() };

/* the newest transcript row time per run id, from the end of the newest two segments */
function lastActivity(root, runIds) {
  const want = new Set(runIds), out = {};
  if (!want.size) return out;
  const dir = path.join(root, '.starnet-data', 'workspaces', 'transcript-history-v2');
  let segs = [];
  try { segs = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort().slice(-2); } catch (_) { return out; }
  for (const f of segs) {
    let fd = null;
    try {
      fd = fs.openSync(path.join(dir, f), 'r');
      const size = fs.fstatSync(fd).size, len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.includes('"sourceRunId"')) continue;
        const m = line.match(/"sourceRunId":"([^"]+)"/); if (!m || !want.has(m[1])) continue;
        const t = line.match(/"ts":(\d{12,})/); if (!t) continue;
        const ts = Number(t[1]); if (!out[m[1]] || ts > out[m[1]]) out[m[1]] = ts;
      }
    } catch (_) {} finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
  }
  return out;
}

/* pure: which runs are hung. runs: [{runId, agentId, source, internal, startedAt}], activity: {runId: ms} */
function judge(runs, activity, now, limitMin) {
  const lim = (limitMin || HUNG_MIN) * 60000, out = [];
  for (const r of runs || []) {
    if (!r || !r.runId) continue;
    if (r.source === 'interactive' && !r.internal) continue;          // the owner's own chat: never
    const started = Number(r.startedAt) || Date.parse(r.startedAt) || null;
    if (!started || now - started < lim) continue;
    const last = Math.max(started, Number(activity[r.runId]) || 0);
    const silentMin = Math.floor((now - last) / 60000);
    if (now - last >= lim) out.push({ runId: r.runId, agentId: r.agentId || null, source: r.source || null, silentMin, ageMin: Math.floor((now - started) / 60000) });
  }
  return out;
}

async function inFlight() {
  const r = await S.call('GET', '/api/state/snapshot');
  if (!r || r.status !== 200) throw new Error('GET /api/state/snapshot: HTTP ' + (r && r.status));
  return ((JSON.parse(r.body) || {}).runs || []).filter(Boolean);
}

async function tick(o) {
  o = o || {};
  const log = o.log || (() => {});
  const root = o.root || co.ROOT;
  const runs = await inFlight();
  if (!runs.length) return { stopped: [] };
  const hung = judge(runs, lastActivity(root, runs.map(r => r.runId)), S.now(), o.limitMin);
  const stopped = [];
  for (const h of hung) {
    const who = (co.nameOf && co.nameOf(h.agentId)) || h.agentId || 'a seat';
    if (o.dry) { log('HUNG RUN (dry run): would stop ' + who + '\'s run ' + h.runId.slice(0, 8) + ', silent ' + h.silentMin + ' min'); continue; }
    let ok = false;
    try { const r = await S.call('POST', '/api/cancel', { runId: h.runId }); ok = !!(r && r.status === 200 && (JSON.parse(r.body) || {}).stopped); } catch (_) {}
    try { fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true }); fs.appendFileSync(path.join(root, 'company', 'state', 'hung-runs.jsonl'), JSON.stringify(Object.assign({ at: new Date(S.now()).toISOString(), stopped: ok }, h)) + '\n'); } catch (_) {}
    log('HUNG RUN ' + (ok ? 'STOPPED' : 'NOT STOPPED') + ': ' + who + '\'s run ' + h.runId.slice(0, 8) + ' wrote nothing for ' + h.silentMin + ' min (started ' + h.ageMin + ' min ago); ' + (ok ? 'the seat is free and is woken again as usual' : 'the station did not confirm the stop'));
    if (ok) stopped.push(h);
  }
  return { stopped, hung };
}

module.exports = { judge, lastActivity, tick, S, HUNG_MIN };

if (require.main === module) {
  const a = process.argv.slice(2);
  (async () => {
    if (a[0] === 'tick') { const r = await tick({ dry: a.includes('--dry-run'), log: l => console.log(l) }); if (!r.stopped.length && !(r.hung || []).length) console.log('HUNG RUNS: none'); return 0; }
    if (a[0] === 'status') {
      const runs = await inFlight(); const act = lastActivity(co.ROOT, runs.map(r => r.runId)); const now = S.now();
      if (!runs.length) console.log('no run in flight');
      for (const r of runs) { const st = Number(r.startedAt) || Date.parse(r.startedAt); const last = Math.max(st || 0, act[r.runId] || 0); console.log((r.agentId || '?') + ' ' + r.runId.slice(0, 8) + ' ' + (r.source || '') + ' started ' + Math.floor((now - st) / 60000) + ' min ago, silent ' + Math.floor((now - last) / 60000) + ' min'); }
      return 0;
    }
    console.error('usage: hung-runs.js tick [--dry-run] | status'); return 2;
  })().then(c => process.exit(c), e => { console.error('hung-runs: ' + String(e.message || e)); process.exit(1); });
}
