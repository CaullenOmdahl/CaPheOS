#!/usr/bin/env node
/* models.js — each seat's own model chain: a primary and ordered fallbacks, set per agent, with automatic failover.
 *
 * The chain lives in company/model-policy.json `seats.<station agent id>.chain`: an ordered list of
 * { provider, model, effort? }, the first entry is the primary. A seat with a chain runs, for both its roster model
 * (POST /api/agent/model) and its routines (POST /api/cron/update), on the FIRST entry that can run right now:
 *   - the model is on the allowed list (company/model-policy.json allowed);
 *   - its provider is connected on the station (GET /api/providers `configured`);
 *   - its subscription is open to routines (pacer.js: Claude over its pacing line / 5-hour window / usage-limit error,
 *     MiniMax out of its window; `claudeReserve` keeps a seat on Claude past the daily line, as the CEO scope does);
 *   - a metered provider (DeepSeek, any pay-per-use provider) is not near the station's daily rail and has credit;
 *   - the seat's last run on it was not held by a budget cap (runs.jsonl reason "budget"), and the seat's last
 *     `errorsInARow` runs on it were not all provider errors (runs.jsonl reason "error" with a provider-side code or
 *     message). An error or budget hold lasts `errorHoldMin`, then the entry is tried again.
 * Moving DOWN off an entry that cannot run happens at the next tick. Moving back UP waits until the better entry has
 * been able to run for `recoverAfterMin` and the seat has not moved for `upAtMostEveryMin` (hysteresis). A seat in a
 * run is never switched until the run ends. Numbers: model-policy.json `failover` (defaults below); mode "shadow" logs
 * what it would do and changes nothing.
 * Every move is logged in company/work/dispatch-log.md (MODELS ...) and company/state/model-moves.jsonl. When a seat has
 * to fall to the LAST entry of its chain, its manager gets an OPEN handoff (the CEO seat: one owner notice).
 * The pacer (pacer.js) leaves the routines of a seat with a chain alone; its routing table still runs every other
 * routine. StarNet's station-wide fallback chain (GET/POST /api/fallback/chain, Settings > Models) stays the final
 * backstop for a single run whose model fails mid-run; this tool never writes it.
 *
 *   node company/tools/models.js show [--seat <id|name>] [--json]      every seat: primary, chain, what it runs now and why
 *   node company/tools/models.js set <seat> --primary p/m [--effort high] --by <name> [--approved "<who>, <where>"]
 *   node company/tools/models.js chain <seat> --set "p/m,p/m@low,…" | --add p/m [--at N] | --remove p/m  --by <name> [--approved ...]
 *   node company/tools/models.js check [--json]                         every chain entry allowed and connected; exit 1 if not
 *   node company/tools/models.js tick [--dry] [--json]                  one failover pass (the dispatcher runs it through pacer.js)
 *   node company/tools/models.js selftest
 * Who may change a chain (hire.js remodel rules): the owner acts directly. Anyone else names who decided in --approved
 * (the seat's manager or the people holder), never for the CEO seat, the CEO also for a needsCeoApproval model, and the
 * self-governance level for `models` (company/state/governance.json) must allow it (approve = exit 3, owner question).
 * Owner of this tool: the people function holder. Never prints a key.
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const co = require('./lib/company');
const gov = require('./lib/governance');
const mm = require('./lib/models-money');

const MIN = 60e3, HOUR = 3600e3;
const REL = {
  policy: 'company/model-policy.json', loops: 'company/tools/loops.json', company: 'company/company.json',
  state: 'company/state/models-state.json', moves: 'company/state/model-moves.jsonl', dispatchLog: 'company/work/dispatch-log.md',
  runs: '.starnet-data/workspaces/runs.jsonl', roster: '.starnet-data/workspaces/agent.roster.json', handoffs: 'company/work/handoffs',
  staffLog: 'company/hiring/staff-log.md',
};
const FAILOVER = { mode: 'live', errorsInARow: 3, errorHoldMin: 60, recoverAfterMin: 30, upAtMostEveryMin: 60 };
const MAX_CHAIN = 8;
const SUBS = ['claude-cli', 'custom'];
const NAMES = { 'claude-cli': 'Claude', custom: 'MiniMax', deepseek: 'DeepSeek' };
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// a run that ended for a reason on the provider's side, not the agent's
const PROVIDER_CODES = ['auth', 'quota_exhausted', 'rate_limited', 'provider_error', 'provider_unavailable', 'network', 'timeout', 'overloaded', 'upstream', 'model_unavailable', 'model_unsuitable', 'model_no_tools', 'concurrency_limit'];
const PROVIDER_RE = /\bhttp\s*(40[1238]|429|5\d\d)\b|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|rate.?limit|overloaded|unavailable|unauthori[sz]ed|invalid api key|insufficient[_ ]balance|quota|usage limit|not connected|no key|credential|network error|upstream/i;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
function writeJson(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n'); fs.renameSync(tmp, f); }
const keyOf = e => e.provider + '/' + e.model;
const label = e => e ? keyOf(e) + (e.effort ? ' (' + e.effort + ')' : '') : 'nothing';
const z = n => String(n).padStart(2, '0');
function hm(ms) { const p = mm.zoneParts(ms, co.TZ); return z(p.hour) + ':' + z(p.minute); }
function stamp(ms) { const p = mm.zoneParts(ms, co.TZ); return p.date + ' ' + z(p.hour) + ':' + z(p.minute); }

/* "p/m", "p/m@effort" or {provider, model, effort} -> entry (null when unreadable) */
function parseEntry(x) {
  if (x && typeof x === 'object') {
    const provider = String(x.provider || '').trim(), model = String(x.model || '').trim(), effort = x.effort ? String(x.effort).trim() : '';
    return provider && model ? Object.assign({ provider, model }, effort ? { effort } : {}) : null;
  }
  const s = String(x || '').trim(); const i = s.indexOf('/'); if (i <= 0) return null;
  let model = s.slice(i + 1), effort = '';
  const at = model.lastIndexOf('@'); if (at > 0) { effort = model.slice(at + 1); model = model.slice(0, at); }
  return model ? Object.assign({ provider: s.slice(0, i), model }, effort ? { effort } : {}) : null;
}
const parseList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(parseEntry);

/* A run on the provider's side: the seat can't run on that model (counted by tick). */
function providerError(r) {
  if (!r || r.reason !== 'error') return false;
  return PROVIDER_CODES.includes(String(r.failureCode || '')) || PROVIDER_RE.test(String(r.error || ''));
}

// one station call: (method, path, body) -> { status, body }; the token goes only in the header
function stationCall(root, host) {
  return (method, p, body, timeoutMs) => new Promise((resolve, reject) => {
    const token = mm.readSecret(root, 'station-token'); if (!token) return reject(new Error('no station token (secrets/station-token)'));
    const u = new URL((host || co.STATION_URL) + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, timeout: timeoutMs || 15000,
      headers: Object.assign({ 'x-starnet-token': token }, body ? { 'Content-Type': 'application/json' } : {}) }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 4e6) d = d.slice(-1e6); }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const parse = r => { try { return JSON.parse(r.body); } catch (_) { return null; } };

function makeModels(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  const P = k => path.join(root, REL[k]);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const call = o.call || stationCall(root, o.host);
  const dry = !!o.dry;
  const sink = typeof o.log === 'function' ? o.log : null;
  const govOpts = Object.assign({ root }, o.gov || {});

  function note(line) {
    if (o.quiet) return;
    if (sink) { sink('MODELS ' + line); return; }
    const t = now(); console.error(stamp(t) + ' MODELS ' + line);
    if (dry) return;
    try { const f = P('dispatchLog'); fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Dispatch log\n\n'); fs.appendFileSync(f, '- ' + stamp(t) + ' MODELS ' + line + '\n'); } catch (_) {}
  }
  const policy = () => readJson(P('policy'), {}) || {};
  const crew = () => (readJson(P('loops'), {}) || {}).agents || {};
  const ownerName = () => String((((readJson(P('company'), {}) || {}).owner) || {}).name || 'Owner');
  const isOwner = by => { const b = String(by || '').trim().toLowerCase(); return !!b && (b === 'owner' || b === ownerName().trim().toLowerCase()); };
  const ceoId = () => { const c = crew(); const ids = Object.keys(c); return ids.find(id => co.holds(c[id], 'ceo')) || ids.find(id => c[id] && c[id].manager == null) || 'agent'; };
  const failover = () => Object.assign({}, FAILOVER, policy().failover || {});
  function seatChains(pol) {
    const out = {};
    for (const [id, s] of Object.entries((pol || policy()).seats || {})) {
      if (id.startsWith('_') || !s || !Array.isArray(s.chain)) continue;
      const chain = s.chain.map(parseEntry).filter(Boolean);
      if (chain.length) out[id] = Object.assign({}, s, { chain });
    }
    return out;
  }
  function allowedWhy(e, pol) {
    const fam = ((pol || policy()).allowed || {})[e.provider];
    if (!fam || !Array.isArray(fam.models) || !fam.models.includes(e.model)) return keyOf(e) + ' is not on the allowed list (company/model-policy.json allowed)';
    if (e.effort && !EFFORTS.includes(e.effort)) return 'effort "' + e.effort + '" is not one of ' + EFFORTS.join(', ');
    return null;
  }
  const tierOf = (e, pol) => e.provider === 'claude-cli' ? ((((pol || policy()).allowed || {})['claude-cli'] || {}).tiers || {})[e.model] || null : null;
  function resolveSeat(x) {
    const c = crew(); const s = String(x || '').trim(); if (!s) return null;
    if (c[s]) return s;
    const low = s.toLowerCase();
    return Object.keys(c).find(id => String(c[id].name || '').toLowerCase() === low) || Object.keys(c).find(id => id.toLowerCase() === low) || null;
  }

  /* ---- station reads ---- */
  async function providers() {
    try {
      const r = await call('GET', '/api/providers', null, 10000);
      const j = parse(r); if (r.status !== 200 || !j || !Array.isArray(j.providers)) return null;
      const out = {}; for (const p of j.providers) if (p && p.id) out[p.id] = { id: p.id, name: p.name || p.label || p.id, configured: p.configured === true, ready: p.unattendedReady !== false, reason: p.reason || null, unmetered: p.unmetered === true };
      return out;
    } catch (_) { return null; }
  }
  async function jobs() { const r = await call('GET', '/api/cron', null, 15000); const j = parse(r); if (r.status !== 200 || !j) throw new Error('GET /api/cron answered HTTP ' + r.status); return j.jobs || []; }
  const rosterRows = () => { const r = readJson(P('roster'), null); return (r && Array.isArray(r.agents)) ? r.agents : []; };
  const jobPair = j => ({ provider: (j.wire && j.wire.provider) || j.provider || '', model: (j.wire && j.wire.model) || j.model || '', effort: j.reasoningEffort || undefined });
  const seatJobs = (all, id) => (all || []).filter(j => j && j.agentId === id && j.noAgent !== true);
  function current(id, all) {
    const c = crew()[id] || {};
    const js = seatJobs(all, id);
    const loop = js.find(j => c.loop && (j.name === c.loop || String(j.name).startsWith(c.loop))) || js[0] || null;
    const row = rosterRows().find(r => r && r.agentId === id) || null;
    const pick = loop ? jobPair(loop) : row ? { provider: row.provider || '', model: row.model || '' } : null;
    return { pick: pick && pick.provider && pick.model ? pick : null, loop, jobs: js, roster: row ? { provider: row.provider || null, model: row.model || null, effort: row.reasoningEffort || null } : null,
      running: js.some(j => j.inFlight || j.state === 'running') };
  }
  // the seat's own runs from the station's run records (the newest last), the last 3 days
  function seatRuns(t) {
    let txt = ''; try { txt = fs.readFileSync(P('runs'), 'utf8'); } catch (_) { return {}; }
    if (txt.length > 6e6) txt = txt.slice(-6e6);
    const out = {}; const since = t - 72 * HOUR;
    for (const l of txt.split('\n')) {
      if (!l || l.indexOf('"agentId"') < 0) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      const end = Number(r.endedAt || r.ts || r.startedAt) || 0; if (end < since || !r.agentId) continue;
      (out[r.agentId] = out[r.agentId] || []).push({ provider: r.provider, model: r.model, reason: r.reason, failureCode: r.failureCode || '', error: String(r.error || '').slice(0, 160), at: end });
    }
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.at - b.at);
    return out;
  }

  /* ---- can this entry run for this seat now? ---- */
  function evaluate(id, e, ctx) {
    const pol = ctx.pol, F = ctx.F, t = ctx.t, m = ctx.m;
    const bad = allowedWhy(e, pol); if (bad) return { ok: false, why: bad, hard: true };
    const pv = ctx.providers;
    if (pv) {
      const p = pv[e.provider];
      if (!p) return { ok: false, why: 'the provider "' + e.provider + '" is not on this station', hard: true, connected: false };
      if (!p.configured) return { ok: false, why: (NAMES[e.provider] || p.name) + ' is not connected on the station (' + (p.reason || 'no key or sign-in') + ')', hard: true, connected: false };
    }
    const connected = pv ? true : null;
    const metered = !SUBS.includes(e.provider) && !(pv && pv[e.provider] && pv[e.provider].unmetered);
    if (m) {
      if (e.provider === 'claude-cli' && m.claude && !m.claude.open) {
        const reserve = ctx.reserve && m.claude.known && !m.claude.hard && typeof m.claude.usedPct === 'number' && m.claude.usedPct < (m.claude.weekCap || 95);
        if (!reserve) return { ok: false, why: 'the pacer has Claude closed to routines: ' + m.claude.why, connected };
      }
      if (e.provider === 'custom' && m.minimax && !m.minimax.open) return { ok: false, why: 'the pacer has MiniMax closed: ' + m.minimax.why, connected };
      if (e.provider === 'deepseek' && m.deepseek && !m.deepseek.open) return { ok: false, why: 'DeepSeek is closed: ' + m.deepseek.why, connected };
      if (metered && m.rail && m.rail.pressure) return { ok: false, why: 'metered: the station\'s daily spend rail is at ' + Math.round(m.rail.pct) + '% (holds from ' + m.rail.holdAtPct + '%)', connected };
    }
    const mine = (ctx.runs[id] || []).filter(r => r.provider === e.provider && (!r.model || r.model === e.model));
    const last = mine[mine.length - 1];
    if (last && last.reason === 'budget' && t - last.at < F.errorHoldMin * MIN) return { ok: false, why: 'a budget cap held this seat\'s run at ' + hm(last.at) + ' (retried after ' + F.errorHoldMin + ' min)', connected };
    let n = 0; for (let i = mine.length - 1; i >= 0 && providerError(mine[i]); i--) n++;
    if (n >= F.errorsInARow && last && t - last.at < F.errorHoldMin * MIN) return { ok: false, why: n + ' provider errors in a row on this seat (the last at ' + hm(last.at) + ': ' + (last.failureCode || last.error || 'error') + ')', connected };
    return { ok: true, why: 'can run' + (e.provider === 'claude-cli' && m && m.claude && !m.claude.open ? ' (claudeReserve: past the daily line, under the weekly stop)' : ''), connected };
  }

  function loadState() { return Object.assign({ v: 1, seats: {} }, readJson(P('state'), {}) || {}); }
  function saveState(st) { if (!dry) writeJson(P('state'), st); }
  function logMove(row) {
    if (dry) return;
    try { fs.mkdirSync(path.dirname(P('moves')), { recursive: true }); fs.appendFileSync(P('moves'), JSON.stringify(row) + '\n'); } catch (_) {}
  }
  function moves(id, n) {
    let txt = ''; try { txt = fs.readFileSync(P('moves'), 'utf8'); } catch (_) { return []; }
    const out = []; for (const l of txt.split('\n')) { if (!l) continue; try { const r = JSON.parse(l); if (!id || r.seat === id) out.push(r); } catch (_) {} }
    return out.slice(-(n || 50));
  }

  /* ---- apply an entry to a seat: roster model and every routine of that seat; idempotent ---- */
  async function applyEntry(id, e, all, cur) {
    const out = { roster: 'kept', routines: [], errors: [] };
    const row = cur && cur.roster;
    const rosterSame = row && row.provider === e.provider && row.model === e.model && (!e.effort || row.effort === e.effort);
    if (!rosterSame) {
      const r = await call('POST', '/api/agent/model', Object.assign({ agentId: id, model: e.model, provider: e.provider }, e.effort ? { effort: e.effort, reasoningEffort: e.effort } : {}));
      const j = parse(r) || {};
      if (r.status === 200 && j.ok !== false) out.roster = 'set' + (j.via ? ' via ' + j.via : '');
      else { out.roster = 'refused'; out.errors.push('POST /api/agent/model: HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160)); }
    }
    for (const j of seatJobs(all, id)) {
      const p = jobPair(j);
      if (p.provider === e.provider && p.model === e.model && (!e.effort || j.reasoningEffort === e.effort)) { out.routines.push({ id: j.id, name: j.name, kept: true }); continue; }
      const r = await call('POST', '/api/cron/update', { id: j.id, patch: Object.assign({ model: e.model, provider: e.provider }, e.effort ? { reasoningEffort: e.effort } : {}) });
      const ok = r.status === 200 && (parse(r) || {}).ok !== false;
      out.routines.push({ id: j.id, name: j.name, set: ok });
      if (ok) { j.provider = e.provider; j.model = e.model; if (j.wire) { j.wire.provider = e.provider; j.wire.model = e.model; } if (e.effort) j.reasoningEffort = e.effort; }
      else out.errors.push('POST /api/cron/update ' + j.name + ': HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 160));
    }
    out.ok = !out.errors.length;
    return out;
  }

  // the seat's manager hears about it when the seat had to fall to the last entry (the CEO seat: the owner, once)
  function tellManager(id, from, to, why, chain) {
    const c = crew(), seat = c[id] || {}, name = seat.name || id;
    const text = name + ' fell to the last model in their chain (' + label(to) + ', from ' + label(from) + '): ' + why + '. Every entry above it cannot run: ' + chain.slice(0, -1).map(x => keyOf(x.e) + ' — ' + x.why).join('; ') + '.';
    if (dry) return 'dry';
    const mgr = seat.manager && c[seat.manager];
    if (mgr) {
      const inbox = mgr.inbox || 'to-' + String(seat.manager).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.md';
      const f = path.join(P('handoffs'), inbox); fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!fs.existsSync(f)) fs.writeFileSync(f, '# Handoffs\n');
      const day = stamp(now()).slice(0, 10);
      fs.appendFileSync(f, '\n## ' + day + ' from models.js — ' + name + ' is on the last model in their chain\n**Need:** ' + text + ' Check the providers above (connected on the station, subscription open, credit), or change the chain with `node company/tools/models.js chain ' + id + ' ...`. The seat moves back up by itself once its primary can run again.\n**Why:** one more failure leaves ' + name + ' with nothing to run on (StarNet\'s station-wide fallback chain is the only backstop left).\n**Deadline:** ' + day + '\n**Status:** OPEN\n**Evidence:** company/state/model-moves.jsonl; `node company/tools/models.js show --seat ' + id + '`\n');
      return 'handoff to ' + (mgr.name || seat.manager);
    }
    try { gov.notify(text + ' It moves back up by itself once its primary can run again.', govOpts); } catch (_) {}
    return 'owner notified';
  }

  /* ---- failover: one pass over every seat with a chain ---- */
  async function tick(a) {
    a = a || {};
    const pol = policy(), seats = seatChains(pol), ids = Object.keys(seats).filter(id => crew()[id]);
    if (!ids.length) return { ok: true, seats: 0, moves: [] };
    const F = Object.assign({}, FAILOVER, pol.failover || {}), t = now();
    const shadow = F.mode === 'shadow';
    const pv = await providers();
    let all = a.jobs; if (!Array.isArray(all)) all = await jobs();
    const st = loadState(), runs = seatRuns(t), out = [];
    for (const id of ids) {
      const s = seats[id], chain = s.chain, ss = st.seats[id] = st.seats[id] || { okSince: {} };
      ss.okSince = ss.okSince || {};
      const ctx = { pol, F, t, m: a.m || null, providers: pv, runs, reserve: s.claudeReserve === true || (s.claudeReserve !== false && id === ceoId()) };
      const ev = chain.map(e => ({ e, ...evaluate(id, e, ctx) }));
      for (const x of ev) { const k = keyOf(x.e); if (x.ok) { if (!ss.okSince[k]) ss.okSince[k] = t; } else delete ss.okSince[k]; }
      const cur = current(id, all), curKey = cur.pick ? keyOf(cur.pick) : null;
      const curIdx = curKey ? chain.findIndex(e => keyOf(e) === curKey) : -1;
      const target = ev.findIndex(x => x.ok);
      const name = (crew()[id] || {}).name || id;
      if (target < 0) {
        const k = ev.map(x => x.why).join('|');
        if (ss.nothingKey !== k) { ss.nothingKey = k; note('NOTHING CAN RUN for ' + name + ': ' + ev.map(x => keyOf(x.e) + ' — ' + x.why).join('; ') + '; it stays on ' + (curKey || 'its current model') + ' (StarNet\'s station-wide fallback chain is the backstop)'); }
        out.push({ seat: id, action: 'stay', why: 'nothing in the chain can run' }); continue;
      }
      ss.nothingKey = '';
      const to = chain[target];
      let dir = null, why = '';
      if (curIdx === target) {
        // in place: keep the roster and every routine on it (an edit elsewhere drifted one of them)
        const drift = (cur.roster && (cur.roster.provider !== to.provider || cur.roster.model !== to.model)) || cur.jobs.some(j => keyOf(jobPair(j)) !== keyOf(to));
        if (drift) { dir = 'sync'; why = 'the roster or a routine was not on ' + keyOf(to); }
      } else if (curIdx < 0) { dir = 'down'; why = (curKey ? curKey + ' is not in the chain' : 'no model on record') + '; ' + keyOf(to) + ' is entry ' + (target + 1) + ' and ' + ev[target].why; }
      else if (!ev[curIdx].ok) { dir = target > curIdx ? 'down' : 'up'; why = keyOf(chain[curIdx]) + ' cannot run (' + ev[curIdx].why + ')'; }
      else if (target < curIdx) {
        const since = ss.okSince[keyOf(to)], last = ss.lastMoveAt;
        if (t - since < F.recoverAfterMin * MIN) { out.push({ seat: id, action: 'wait', why: keyOf(to) + ' can run again since ' + hm(since) + '; back after ' + F.recoverAfterMin + ' min' }); continue; }
        if (last && t - last < F.upAtMostEveryMin * MIN) { out.push({ seat: id, action: 'wait', why: 'moved at ' + hm(last) + '; at most one move back up every ' + F.upAtMostEveryMin + ' min' }); continue; }
        dir = 'up'; why = keyOf(to) + ' has been able to run since ' + hm(since) + (target === 0 ? ' (the primary)' : '');
      }
      if (!dir) { out.push({ seat: id, action: 'stay', index: target }); continue; }
      if (cur.running && dir !== 'sync') { out.push({ seat: id, action: 'wait', why: 'a run is in progress; moved after it ends' }); continue; }
      if (shadow || dry) {
        const k = dir + '>' + keyOf(to);
        if (ss.shadowKey !== k) { ss.shadowKey = k; note((shadow ? 'SHADOW' : 'DRY') + ' would move ' + name + ' ' + (curKey || '?') + ' -> ' + label(to) + ': ' + why); }
        out.push({ seat: id, action: 'would-' + dir, to, why }); continue;
      }
      if (ss.failedAt && t - ss.failedAt < 10 * MIN && ss.failedKey === keyOf(to)) { out.push({ seat: id, action: 'wait', why: 'the last attempt to apply ' + keyOf(to) + ' failed at ' + hm(ss.failedAt) }); continue; }
      const res = await applyEntry(id, to, all, cur);
      const row = { at: new Date(t).toISOString(), seat: id, name, from: curKey, to: keyOf(to), effort: to.effort || null, toIndex: target, of: chain.length, direction: dir, why, applied: res.ok, roster: res.roster, routines: res.routines.length, errors: res.errors };
      if (!res.ok) { ss.failedAt = t; ss.failedKey = keyOf(to); note('MOVE FAILED ' + name + ' -> ' + label(to) + ': ' + res.errors.join('; ')); logMove(row); out.push(Object.assign({ action: 'failed' }, row)); continue; }
      ss.failedAt = null; ss.shadowKey = '';
      if (dir !== 'sync') { ss.lastMoveAt = t; ss.lastWhy = why; ss.index = target; }
      note((dir === 'sync' ? 'SYNC ' : 'MOVE ') + name + ' ' + (curKey || '?') + ' -> ' + label(to) + ' (entry ' + (target + 1) + ' of ' + chain.length + '): ' + why);
      if (dir === 'down' && target === chain.length - 1 && chain.length > 1) row.told = tellManager(id, cur.pick, to, why, ev);
      logMove(row);
      out.push(Object.assign({ action: dir }, row));
    }
    saveState(st);
    return { ok: true, seats: ids.length, moves: out.filter(x => ['down', 'up', 'sync', 'failed'].includes(x.action)), all: out };
  }

  /* ---- show: every seat, its chain and what it runs now ---- */
  async function show(a) {
    a = a || {};
    const pol = policy(), seats = seatChains(pol), c = crew(), F = Object.assign({}, FAILOVER, pol.failover || {}), t = now();
    const pv = await providers();
    let all = []; let stationUp = true; try { all = Array.isArray(a.jobs) ? a.jobs : await jobs(); } catch (_) { stationUp = false; }
    let m = a.m || null;
    if (!m && stationUp && !a.noPacer) {
      try { const PZ = require('./pacer.js').makePacer({ root, readOnly: true, quiet: true }); const pst = PZ.loadState(); m = await PZ.measure(pst, all, { fetch: false }); } catch (_) { m = null; }
    }
    const st = loadState(), runs = seatRuns(t);
    const ids = a.seat ? [a.seat] : Object.keys(c);
    const rows = ids.map(id => {
      const s = seats[id] || null, cur = current(id, all), curKey = cur.pick ? keyOf(cur.pick) : null;
      const ctx = { pol, F, t, m, providers: pv, runs, reserve: !!s && (s.claudeReserve === true || (s.claudeReserve !== false && id === ceoId())) };
      const chain = (s ? s.chain : []).map((e, i) => Object.assign({ index: i, key: keyOf(e), tier: tierOf(e, pol) }, e, evaluate(id, e, ctx)));
      const idx = curKey ? chain.findIndex(x => x.key === curKey) : -1;
      const ss = st.seats[id] || {};
      const last = moves(id, 1)[0] || null;
      let why;
      if (!s) why = 'no chain of its own: ' + (curKey ? 'on ' + curKey + (pol.routing && pol.routing.routines ? ', where the pacer\'s routing table or the last hand change put it' : '') : 'no model on record');
      else if (idx === 0) why = 'the primary' + (chain[0].ok ? ', and it can run' : '; it cannot run (' + chain[0].why + ') and the next tick moves it');
      else if (idx > 0) why = 'fallback ' + idx + ' of ' + (chain.length - 1) + ': ' + (ss.lastWhy || (last && last.why) || 'moved here earlier') + (chain.slice(0, idx).some(x => x.ok) ? '; it moves back up once that has held for ' + F.recoverAfterMin + ' min' : '');
      else why = curKey ? curKey + ' is not in its chain; the next tick moves it to the first entry that can run' : 'no model on record';
      return { id, name: (c[id] || {}).name || id, title: (c[id] || {}).title || '', manager: (c[id] || {}).manager || null, hasChain: !!s,
        primary: chain[0] || null, chain, now: { model: cur.pick, index: idx, why, roster: cur.roster, routines: cur.jobs.map(j => Object.assign({ id: j.id, name: j.name }, jobPair(j))), running: cur.running },
        claudeReserve: ctx.reserve, setBy: s && s.setBy || null, setAt: s && s.setAt || null, history: moves(id, a.seat ? 50 : 10).reverse() };
    });
    return { ok: true, at: new Date(t).toISOString(), station: stationUp ? 'up' : 'down', failover: F, providersKnown: !!pv,
      providers: pv ? Object.values(pv).filter(p => (pol.allowed || {})[p.id]).map(p => ({ id: p.id, name: p.name, connected: p.configured, reason: p.reason })) : [],
      pacer: m ? { claude: m.claude && { open: m.claude.open, why: m.claude.why }, minimax: m.minimax && { open: m.minimax.open, why: m.minimax.why }, deepseek: m.deepseek && { open: m.deepseek.open, why: m.deepseek.why }, rail: m.rail && { pct: m.rail.pct, pressure: m.rail.pressure } } : null,
      backstop: 'StarNet\'s station-wide fallback chain (GET /api/fallback/chain) still catches a single run whose model fails mid-run; this tool never changes it.',
      seats: rows };
  }

  /* ---- check: every chain entry allowed, connected, and a routine-safe tier ---- */
  async function check() {
    const pol = policy(), seats = seatChains(pol), c = crew(), pv = await providers(), problems = [], notes = [];
    for (const [id, s] of Object.entries(seats)) {
      if (!c[id]) problems.push({ seat: id, why: 'seat "' + id + '" has a chain but is not on the crew (company/tools/loops.json)' });
      const seen = new Set();
      s.chain.forEach((e, i) => {
        const where = (c[id] && c[id].name || id) + ' entry ' + (i + 1) + ' (' + keyOf(e) + ')';
        if (seen.has(keyOf(e))) problems.push({ seat: id, entry: keyOf(e), why: where + ' is listed twice' }); seen.add(keyOf(e));
        const bad = allowedWhy(e, pol); if (bad) problems.push({ seat: id, entry: keyOf(e), why: where + ': ' + bad });
        if (!pv) { if (i === 0) notes.push({ seat: id, why: 'the station did not answer GET /api/providers: connections not checked' }); }
        else if (!pv[e.provider]) problems.push({ seat: id, entry: keyOf(e), why: where + ': the provider is not on this station' });
        else if (!pv[e.provider].configured) problems.push({ seat: id, entry: keyOf(e), why: where + ': ' + (NAMES[e.provider] || e.provider) + ' is not connected (' + (pv[e.provider].reason || 'no key or sign-in') + ')' });
        const tier = tierOf(e, pol); if (tier === 'heavy' || tier === 'top') notes.push({ seat: id, entry: keyOf(e), why: where + ' is a ' + tier + ' Claude tier: the model policy keeps routines on Haiku or Sonnet' });
      });
      if (s.chain.length > MAX_CHAIN) problems.push({ seat: id, why: 'the chain has ' + s.chain.length + ' entries (at most ' + MAX_CHAIN + ')' });
    }
    return { ok: !problems.length, seats: Object.keys(seats).length, problems, notes };
  }

  /* ---- set / chain: the governed change ---- */
  function deciders(id) {
    const c = crew(), seat = c[id] || {}, people = Object.keys(c).find(x => co.holds(c[x], 'people')) || ceoId();
    const names = [seat.manager && c[seat.manager] && c[seat.manager].name, c[people] && c[people].name].filter(Boolean);
    return [...new Set(names)];
  }
  function approverOk(text, allowed) {
    const tx = String(text || '').trim().toLowerCase();
    return allowed.some(n => { const full = String(n).trim().toLowerCase(), first = full.split(/\s+/)[0]; const sw = w => w && tx.startsWith(w) && (tx.length === w.length || /[^a-z0-9]/.test(tx.charAt(w.length))); return sw(full) || sw(first); });
  }
  async function change(id, chain, a, what) {
    const by = String(a.by || '').trim(); if (!by || a.by === true) return { code: 2, ok: false, error: '--by <name> is required' };
    const c = crew(); if (!c[id]) return { code: 2, ok: false, error: 'no seat "' + a.seat + '" on the crew (company/tools/loops.json)' };
    if (!chain.length) return { code: 2, ok: false, error: 'the chain needs at least one entry (the primary)' };
    if (chain.some(e => !e)) return { code: 2, ok: false, error: 'chain entries are provider/model, e.g. deepseek/deepseek-flash or claude-cli/claude-sonnet-5-5@high' };
    if (chain.length > MAX_CHAIN) return { code: 2, ok: false, error: 'at most ' + MAX_CHAIN + ' entries' };
    if (new Set(chain.map(keyOf)).size !== chain.length) return { code: 2, ok: false, error: 'an entry is listed twice' };
    const pol = policy();
    for (const e of chain) { const bad = allowedWhy(e, pol); if (bad) return { code: 2, ok: false, error: bad }; }
    const owner = isOwner(by), name = c[id].name || id;
    const summary = (what || 'set the model chain') + ' for ' + name + ': ' + chain.map(label).join(' > ');
    if (!owner) {
      if (id === ceoId()) return { code: 2, ok: false, error: 'the CEO\'s model is the owner\'s call' };
      const allowed = deciders(id);
      if (!approverOk(a.approved, allowed)) return { code: 2, ok: false, error: '--approved must start with who decided: ' + (allowed.join(' or ') || 'the seat\'s manager or the people holder') + ' (then where and when)' };
      const needCeo = (pol.needsCeoApproval || []).map(String), ceoN = String((c[ceoId()] || {}).name || '').toLowerCase();
      if (chain.some(e => needCeo.includes(e.model) || needCeo.includes(keyOf(e))) && !(ceoN && String(a.approved).toLowerCase().split(/[^a-z0-9]+/).includes(ceoN.split(/\s+/)[0])))
        return { code: 2, ok: false, error: 'a chain with ' + chain.filter(e => needCeo.includes(e.model)).map(keyOf).join(', ') + ' also needs the CEO (' + (c[ceoId()] || {}).name + ') named in --approved' };
      const d = gov.decide('models', { by, ref: 'models:chain:' + id + ':' + chain.map(label).join(','), summary, recommendation: 'yes: ' + String(a.approved), default: name + ' keeps the current chain' }, govOpts);
      if (!d.allowed) return { code: 3, ok: false, error: gov.refusal('models', d), governance: { category: 'models', level: d.level, questionId: d.questionId || null, denied: !!d.denied } };
    }
    const before = (seatChains(pol)[id] || {}).chain || null;
    const fresh = policy(); fresh.seats = fresh.seats || {};
    if (!fresh.seats._doc) fresh.seats = Object.assign({ _doc: 'Per-seat model chains (company/tools/models.js): seats.<station agent id>.chain is an ordered list of {provider, model, effort?}; the first entry is the primary, the rest are fallbacks the seat moves down to when one cannot run, and back up when it recovers. The pacer leaves these seats\' routines alone. Change it with models.js set/chain (or the console Crew > seat > Model panel).' }, fresh.seats);
    fresh.seats[id] = Object.assign({}, fresh.seats[id] || {}, { chain: chain.map(e => Object.assign({ provider: e.provider, model: e.model }, e.effort ? { effort: e.effort } : {})), setBy: by, setAt: new Date(now()).toISOString() });
    if (!dry) writeJson(P('policy'), fresh);
    try { if (!dry) { const f = P('staffLog'); fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, '# Staff log\n\nHires, model changes and departures.\n\n'); fs.appendFileSync(f, '- ' + stamp(now()) + ' MODEL CHAIN ' + name + ' (' + id + '): ' + (before ? before.map(label).join(' > ') : 'none') + ' -> ' + chain.map(label).join(' > ') + ' by ' + by + (owner ? ' (owner)' : ' (approved: ' + a.approved + ')') + '\n'); } } catch (_) {}
    // apply: a new primary runs at once; a chain edit moves the seat only when its current model left the chain
    let applied = null;
    try {
      const all = await jobs(); const cur = current(id, all); const curKey = cur.pick ? keyOf(cur.pick) : null;
      const primaryChanged = !before || keyOf(before[0]) !== keyOf(chain[0]) || (before[0].effort || '') !== (chain[0].effort || '');
      const inChain = curKey && chain.some(e => keyOf(e) === curKey);
      if (primaryChanged || !inChain) {
        const to = chain[0];
        applied = dry ? { ok: true, dry: true } : await applyEntry(id, to, all, cur);
        if (!dry) {
          const st = loadState(); st.seats[id] = { okSince: {}, lastMoveAt: now(), lastWhy: 'set by ' + by, index: 0 }; saveState(st);
          logMove({ at: new Date(now()).toISOString(), seat: id, name, from: curKey, to: keyOf(to), effort: to.effort || null, toIndex: 0, of: chain.length, direction: 'set', why: (what || 'chain set') + ' by ' + by, applied: applied.ok, roster: applied.roster, routines: (applied.routines || []).length, errors: applied.errors || [] });
          note('SET ' + name + ' -> ' + label(to) + ' by ' + by + ' (chain ' + chain.map(keyOf).join(' > ') + ')' + (applied.ok ? '' : '; NOT applied: ' + applied.errors.join('; ')));
        }
      } else applied = { ok: true, kept: curKey };
    } catch (e) { applied = { ok: false, errors: ['the station did not answer: ' + e.message + ' (the chain is saved; the next dispatcher tick applies it)'] }; }
    return { code: applied && applied.ok === false ? 1 : 0, ok: !(applied && applied.ok === false), seat: id, name, chain: chain.map(label), before: before ? before.map(label) : null, by, owner, applied };
  }
  async function setPrimary(a) {
    const id = resolveSeat(a.seat); if (!id) return { code: 2, ok: false, error: 'no seat "' + (a.seat || '') + '" on the crew' };
    const e = parseEntry(a.primary); if (!e) return { code: 2, ok: false, error: '--primary provider/model is required' };
    if (a.effort && a.effort !== true) e.effort = String(a.effort);
    const pol = policy(), cur = (seatChains(pol)[id] || {}).chain;
    let rest = cur ? cur.filter(x => keyOf(x) !== keyOf(e)) : null;
    if (!rest) { try { const c0 = current(id, await jobs()).pick; rest = c0 && keyOf(c0) !== keyOf(e) && !allowedWhy(c0, pol) ? [{ provider: c0.provider, model: c0.model }] : []; } catch (_) { rest = []; } }
    return change(id, [e].concat(rest), a, 'set the primary model');
  }
  async function editChain(a) {
    const id = resolveSeat(a.seat); if (!id) return { code: 2, ok: false, error: 'no seat "' + (a.seat || '') + '" on the crew' };
    const pol = policy(); let chain = ((seatChains(pol)[id] || {}).chain || []).slice();
    if (a.set && a.set !== true) chain = parseList(a.set);
    else if (a.add && a.add !== true) {
      const e = parseEntry(a.add); if (!e) return { code: 2, ok: false, error: '--add provider/model' };
      if (!chain.length) { try { const c0 = current(id, await jobs()).pick; if (c0 && !allowedWhy(c0, pol)) chain.push({ provider: c0.provider, model: c0.model }); } catch (_) {} }
      chain = chain.filter(x => keyOf(x) !== keyOf(e));
      const at = a.at != null && a.at !== true ? Math.max(1, Math.min(chain.length + 1, Number(a.at) || chain.length + 1)) : chain.length + 1;
      chain.splice(at - 1, 0, e);
    } else if (a.remove && a.remove !== true) {
      const e = parseEntry(a.remove); if (!e) return { code: 2, ok: false, error: '--remove provider/model' };
      if (!chain.some(x => keyOf(x) === keyOf(e))) return { code: 2, ok: false, error: keyOf(e) + ' is not in the chain' };
      chain = chain.filter(x => keyOf(x) !== keyOf(e));
    } else return { code: 2, ok: false, error: 'chain <seat> --set "p/m,p/m" | --add p/m [--at N] | --remove p/m' };
    return change(id, chain, a, 'set the model chain');
  }

  return { root, policy, seatChains, resolveSeat, evaluate, tick, show, check, setPrimary, editChain, change, moves, providers, applyEntry, current, loadState };
}

/* The default chain for a new hire: [the interviewed model, candidateDefault, a subscription model if one is connected]
   (allowed models only, no duplicates). `providers` is GET /api/providers' list (or a map id -> {configured}). */
function hireChain(cand, providers, pol) {
  pol = pol || readJson(co.p(REL.policy), {}) || {};
  const conn = id => { if (!providers) return false; const list = Array.isArray(providers) ? providers : Object.values(providers); const p = list.find(x => x && x.id === id); return !!(p && p.configured); };
  const ok = e => { const f = (pol.allowed || {})[e.provider]; return !!(f && Array.isArray(f.models) && f.models.includes(e.model)); };
  const out = [];
  const add = e => { e = parseEntry(e); if (e && ok(e) && !out.some(x => keyOf(x) === keyOf(e))) out.push(e); };
  add(cand);
  const cd = pol.candidateDefault || {}; if (cd.provider && cd.model) add({ provider: cd.provider, model: cd.model, effort: cd.effort });
  const rm = (pol.routing && pol.routing.models) || {};
  const subs = [rm.sonnet, rm.haiku, rm.minimax].filter(Boolean).concat([{ provider: 'claude-cli', model: 'claude-sonnet-5-5' }]);
  if (!out.some(e => SUBS.includes(e.provider))) { const s = subs.find(e => e && SUBS.includes(e.provider) && conn(e.provider) && ok(e)); if (s) add(s); }
  return out;
}
/* hire.js: record the new hire's chain in model-policy.json (no station call: the hire already runs on entry 1). */
function recordHireChain(seatId, chain, by, root) {
  const f = path.join(root || co.ROOT, REL.policy);
  const pol = readJson(f, null); if (!pol || !chain || !chain.length) return false;
  pol.seats = pol.seats || {};
  if (pol.seats[seatId] && Array.isArray(pol.seats[seatId].chain) && pol.seats[seatId].chain.length) return false;   // never over a chain someone set
  pol.seats[seatId] = { chain: chain.map(e => Object.assign({ provider: e.provider, model: e.model }, e.effort ? { effort: e.effort } : {})), setBy: by || 'hire.js', setAt: new Date().toISOString(), why: 'hire default: interviewed model, candidateDefault, a connected subscription' };
  writeJson(f, pol);
  return true;
}
/* hire.js remodel: a seat that has a chain takes the new model as its primary (the rest stay behind it), so the next
   failover tick does not move it straight back. No-op for a seat without a chain. */
function putPrimary(seatId, entry, by, root) {
  const f = path.join(root || co.ROOT, REL.policy);
  const pol = readJson(f, null); const s = pol && pol.seats && pol.seats[seatId];
  if (!s || !Array.isArray(s.chain) || !s.chain.length) return false;
  const e = parseEntry(entry); if (!e) return false;
  s.chain = [Object.assign({ provider: e.provider, model: e.model }, e.effort ? { effort: e.effort } : {})].concat(s.chain.filter(x => !(x && x.provider === e.provider && x.model === e.model)));
  s.setBy = by || 'hire.js remodel'; s.setAt = new Date().toISOString();
  writeJson(f, pol);
  return true;
}
/* pacer.js: the station ids whose routines follow a seat chain (the pacer leaves them alone) */
function chainedSeats(root) {
  const pol = readJson(path.join(root || co.ROOT, REL.policy), {}) || {};
  return new Set(Object.entries(pol.seats || {}).filter(([k, s]) => !k.startsWith('_') && s && Array.isArray(s.chain) && s.chain.length).map(([k]) => k));
}
/* the dispatcher's tick (called from pacer.js hookLocked with its measurement): fail-safe, never throws */
async function tick(a) {
  a = a || {};
  try { return await makeModels({ root: a.root, call: a.call, now: a.now, log: a.log, dry: a.dry }).tick({ m: a.m, jobs: a.jobs }); }
  catch (e) { if (typeof a.log === 'function') a.log('MODELS ERROR: ' + String((e && e.message) || e).slice(0, 200)); return { ok: false, error: String(e && e.message || e) }; }
}

/* ---------- selftest: a temp company and a fake station ---------- */
async function selftest() {
  const os = require('os'); const assert = require('assert');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-selftest-'));
  const w = (rel, d) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d, null, 1)); };
  const pol = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'model-policy.json'), 'utf8'));
  delete pol.seats;
  w(REL.policy, pol);
  w(REL.company, { name: 'Selftest Co', owner: { name: 'Pat Owner' } });
  w('secrets/station-token', 'x');
  w(REL.loops, { agents: { agent: { name: 'Alex', functions: ['ceo', 'people'], manager: null, loop: 'Founder loop', inbox: 'to-alex.md' },
    eng: { name: 'Jo', manager: 'agent', loop: 'Jo loop', inbox: 'to-jo.md' } } });
  w('company/state/governance.json', { categories: { models: 'approve' } });
  const S = { providers: { deepseek: true, 'claude-cli': true, custom: false, ollama: true }, calls: [],
    roster: { agent: { provider: 'deepseek', model: 'deepseek-flash' }, eng: { provider: 'claude-cli', model: 'claude-sonnet-5-5' } },
    jobs: [{ id: 'j1', name: 'Founder loop', agentId: 'agent', provider: 'deepseek', model: 'deepseek-flash' }, { id: 'j2', name: 'Jo loop', agentId: 'eng', provider: 'claude-cli', model: 'claude-sonnet-5-5' }] };
  const writeRoster = () => w(REL.roster, { agents: Object.entries(S.roster).map(([agentId, r]) => Object.assign({ agentId }, r)) });
  writeRoster();
  const call = async (method, p, body) => {
    S.calls.push({ method, p, body });
    if (p === '/api/providers') return { status: 200, body: JSON.stringify({ providers: Object.entries(S.providers).map(([id, c]) => ({ id, configured: c, unmetered: id === 'ollama', reason: c ? 'verified' : 'credential missing' })) }) };
    if (p === '/api/cron') return { status: 200, body: JSON.stringify({ jobs: S.jobs }) };
    if (p === '/api/agent/model') { if (!S.providers[body.provider]) return { status: 409, body: '{"error":"not connected"}' }; S.roster[body.agentId] = { provider: body.provider, model: body.model, reasoningEffort: body.effort }; writeRoster(); return { status: 200, body: '{"ok":true,"via":"roster"}' }; }
    if (p === '/api/cron/update') { const j = S.jobs.find(x => x.id === body.id); Object.assign(j, body.patch); return { status: 200, body: JSON.stringify({ ok: true, job: j }) }; }
    return { status: 404, body: '{}' };
  };
  let T = Date.parse('2026-11-17T10:00:00Z');
  const logs = [];
  const M = () => makeModels({ root, call, now: () => T, log: l => logs.push(l) });
  const openM = { claude: { open: true, known: true, why: 'open' }, minimax: { open: true, why: 'open' }, deepseek: { open: true, why: 'open' }, rail: { pct: 10, pressure: false, holdAtPct: 85 } };
  const cases = []; const t = async (n, fn) => { try { await fn(); cases.push([n, true]); console.log('ok   ' + n); } catch (e) { cases.push([n, false]); console.log('FAIL ' + n + ': ' + e.message); } };
  try {
    await t('owner sets a chain directly; it applies the primary to roster and routine', async () => {
      const r = await M().editChain({ seat: 'Jo', set: 'deepseek/deepseek-flash@high,claude-cli/claude-sonnet-5-5,custom/MiniMax-M3.1-Flash', by: 'Pat Owner' });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(readJson(path.join(root, REL.policy)).seats.eng.chain[0], { provider: 'deepseek', model: 'deepseek-flash', effort: 'high' });
      assert.strictEqual(S.roster.eng.provider, 'deepseek'); assert.strictEqual(S.jobs[1].provider, 'deepseek'); assert.strictEqual(S.jobs[1].reasoningEffort, 'high');
    });
    await t('applying again is idempotent (no station writes)', async () => {
      const n = S.calls.filter(c => c.method === 'POST').length;
      const r = await M().tick({ m: openM }); assert.strictEqual(r.moves.length, 0, JSON.stringify(r));
      assert.strictEqual(S.calls.filter(c => c.method === 'POST').length, n);
    });
    await t('an agent needs --approved and the models level: at approve it files an owner question (exit 3)', async () => {
      let r = await M().editChain({ seat: 'eng', add: 'claude-cli/haiku', by: 'Jo' }); assert.strictEqual(r.code, 2, JSON.stringify(r));
      r = await M().editChain({ seat: 'eng', add: 'claude-cli/haiku', by: 'Jo', approved: 'Alex, decisions.md' }); assert.strictEqual(r.code, 3, JSON.stringify(r)); assert.ok(r.governance.questionId);
    });
    await t('nobody but the owner changes the CEO seat; a model off the allowed list is refused', async () => {
      let r = await M().editChain({ seat: 'agent', set: 'deepseek/deepseek-flash', by: 'Alex', approved: 'Alex, now' }); assert.ok(/owner's call/.test(r.error), JSON.stringify(r));
      r = await M().editChain({ seat: 'eng', set: 'deepseek/deepseek-v4-pro', by: 'Pat Owner' }); assert.ok(/not on the allowed list/.test(r.error), JSON.stringify(r));
    });
    await t('failover: 3 provider errors in a row move the seat down at once, logged', async () => {
      const runs = [1, 2, 3].map(i => JSON.stringify({ agentId: 'eng', provider: 'deepseek', model: 'deepseek-flash', reason: 'error', error: 'openai-compatible http 503 upstream', endedAt: T - (4 - i) * MIN }));
      w(REL.runs, runs.join('\n') + '\n');
      const r = await M().tick({ m: openM });
      assert.strictEqual(r.moves[0].direction, 'down', JSON.stringify(r)); assert.strictEqual(S.jobs[1].provider, 'claude-cli'); assert.strictEqual(S.roster.eng.provider, 'claude-cli');
      assert.ok(logs.some(l => /MOVE Jo deepseek\/deepseek-flash -> claude-cli\/claude-sonnet-5-5/.test(l)), logs.join('\n'));
      assert.strictEqual(M().moves('eng').slice(-1)[0].direction, 'down');
    });
    await t('the pacer closing Claude moves it to the last entry; MiniMax unconnected is skipped; nothing can run = stay', async () => {
      const closed = Object.assign({}, openM, { claude: { open: false, known: true, hard: true, why: 'over the line' } });
      let r = await M().tick({ m: closed });
      assert.ok(r.all[0].action === 'stay' && /nothing/.test(r.all[0].why), JSON.stringify(r));
      S.providers.custom = true;
      r = await M().tick({ m: closed });
      assert.strictEqual(S.jobs[1].provider, 'custom', JSON.stringify(r));
      assert.ok(/handoff to Alex/.test(r.moves[0].told), JSON.stringify(r));
      assert.ok(/last model in their chain/.test(fs.readFileSync(path.join(root, REL.handoffs, 'to-alex.md'), 'utf8')));
    });
    await t('recovery waits (hysteresis), then moves back up to the primary', async () => {
      w(REL.runs, '');
      T += 2 * MIN; let r = await M().tick({ m: openM });
      assert.strictEqual(S.jobs[1].provider, 'custom'); assert.strictEqual(r.all[0].action, 'wait', JSON.stringify(r));
      T += 31 * MIN; r = await M().tick({ m: openM });
      assert.strictEqual(r.all[0].action, 'wait', JSON.stringify(r));   // the last move was under an hour ago
      T += 30 * MIN; r = await M().tick({ m: openM });
      assert.strictEqual(r.moves[0].direction, 'up', JSON.stringify(r)); assert.strictEqual(S.jobs[1].provider, 'deepseek'); assert.strictEqual(r.moves[0].toIndex, 0);
    });
    await t('a running seat is not switched; a metered entry near the rail cannot run', async () => {
      S.jobs[1].inFlight = true; S.providers.deepseek = false;
      let r = await M().tick({ m: openM }); assert.strictEqual(r.all[0].action, 'wait', JSON.stringify(r));
      S.jobs[1].inFlight = false; S.providers.deepseek = true;
      const ev = M().evaluate('eng', { provider: 'deepseek', model: 'deepseek-flash' }, { pol, F: FAILOVER, t: T, m: Object.assign({}, openM, { rail: { pct: 90, pressure: true, holdAtPct: 85 } }), providers: { deepseek: { configured: true } }, runs: {} });
      assert.ok(!ev.ok && /rail/.test(ev.why), JSON.stringify(ev));
    });
    await t('shadow mode logs and changes nothing', async () => {
      const p2 = readJson(path.join(root, REL.policy)); p2.failover = { mode: 'shadow' }; w(REL.policy, p2);
      S.providers.deepseek = false; const n = S.calls.filter(c => c.method === 'POST').length;
      const r = await M().tick({ m: openM }); assert.ok(/would-/.test(r.all[0].action), JSON.stringify(r));
      assert.strictEqual(S.calls.filter(c => c.method === 'POST').length, n);
      delete p2.failover; w(REL.policy, p2); S.providers.deepseek = true;
    });
    await t('show and check report each seat, the primary, what runs now and why', async () => {
      const s = await M().show({ noPacer: true });
      const jo = s.seats.find(x => x.id === 'eng'); assert.strictEqual(jo.primary.key, 'deepseek/deepseek-flash'); assert.strictEqual(jo.now.index, 0); assert.ok(/primary/.test(jo.now.why)); assert.ok(jo.history.length >= 3);
      assert.strictEqual(s.seats.find(x => x.id === 'agent').hasChain, false);
      S.providers.custom = false; const c = await M().check(); assert.strictEqual(c.ok, false); assert.ok(c.problems.some(p => /MiniMax is not connected/.test(p.why)), JSON.stringify(c));
    });
    await t('set --primary keeps the rest of the chain behind it', async () => {
      const r = await M().setPrimary({ seat: 'eng', primary: 'claude-cli/haiku', effort: 'low', by: 'owner' });
      assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.deepStrictEqual(r.chain, ['claude-cli/haiku (low)', 'deepseek/deepseek-flash (high)', 'claude-cli/claude-sonnet-5-5', 'custom/MiniMax-M3.1-Flash']);
      assert.strictEqual(S.jobs[1].model, 'haiku');
    });
    await t('hire default chain: interviewed, candidateDefault, a connected subscription', async () => {
      const ch = hireChain({ provider: 'deepseek', model: 'deepseek-flash', effort: 'high' }, [{ id: 'claude-cli', configured: true }], pol);
      assert.deepStrictEqual(ch.map(keyOf), ['deepseek/deepseek-flash', 'claude-cli/claude-sonnet-5-5']);
      const ch2 = hireChain({ provider: 'claude-cli', model: 'haiku' }, [], pol); assert.deepStrictEqual(ch2.map(keyOf), ['claude-cli/haiku', 'deepseek/deepseek-flash']);
      assert.strictEqual(recordHireChain('new1', ch, 'hire.js', root), true); assert.strictEqual(recordHireChain('new1', ch2, 'hire.js', root), false);
      assert.ok(chainedSeats(root).has('new1') && chainedSeats(root).has('eng'));
    });
    await t('provider errors: a code or a provider message counts; an agent-side failure does not', async () => {
      assert.ok(providerError({ reason: 'error', failureCode: 'auth' })); assert.ok(providerError({ reason: 'error', error: 'HTTP 429 rate limit' }));
      assert.ok(!providerError({ reason: 'error', failureCode: 'routine_script_failed', error: 'exit 1' })); assert.ok(!providerError({ reason: 'done' }));
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const bad = cases.filter(c => !c[1]).length;
  console.log(bad ? 'SELFTEST FAILED: ' + bad + ' of ' + cases.length : 'SELFTEST PASSED (' + cases.length + ' cases)');
  return bad ? 1 : 0;
}

/* ---------- command line ---------- */
function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) { const s = argv[i]; if (s.startsWith('--')) { const k = s.slice(2), v = argv[i + 1]; if (v != null && !v.startsWith('--')) { a[k] = v; i++; } else a[k] = true; } else a._.push(s); }
  return a;
}
function showText(r) {
  const L = ['Seat model chains (' + r.seats.filter(s => s.hasChain).length + ' of ' + r.seats.length + ' seats have one; station ' + r.station + '; failover ' + r.failover.mode + ')'];
  for (const s of r.seats) {
    L.push('', s.name + ' (' + s.id + ')' + (s.title ? ', ' + s.title : ''));
    L.push('  now: ' + (s.now.model ? keyOf(s.now.model) : 'unknown') + ' — ' + s.now.why);
    s.chain.forEach((e, i) => L.push('  ' + (i === s.now.index ? '>' : ' ') + ' ' + (i + 1) + '. ' + label(e) + (i === 0 ? ' [primary]' : '') + ' — ' + (e.ok ? 'can run' : e.why)));
  }
  L.push('', r.backstop);
  return L.join('\n');
}
async function main(argv) {
  const a = args(argv), cmd = a._[0] || 'show';
  if (cmd === 'selftest' || a.selftest) return selftest();
  const M = makeModels({ dry: !!a.dry, log: cmd === 'tick' ? null : l => console.error(l) });
  const print = (r, text) => console.log(a.json || !text ? JSON.stringify(r, null, 1) : text(r));
  if (cmd === 'show') {
    let seat = null; if (a.seat && a.seat !== true) { seat = M.resolveSeat(a.seat); if (!seat) { console.error('no seat "' + a.seat + '" on the crew'); return 2; } }
    print(await M.show({ seat }), showText); return 0;
  }
  if (cmd === 'check') { const r = await M.check(); print(r, x => x.ok ? 'models check: every chain entry is allowed and connected (' + x.seats + ' seats)' + x.notes.map(n => '\n  note — ' + n.why).join('') : 'models check: ' + x.problems.length + ' problem(s)\n' + x.problems.map(p => '  ' + p.why).join('\n') + x.notes.map(n => '\n  note — ' + n.why).join('')); return r.ok ? 0 : 1; }
  if (cmd === 'tick') {
    let m = null;
    try { const PZ = require('./pacer.js').makePacer({ readOnly: true, quiet: true }); m = await PZ.measure(PZ.loadState(), await PZ.getJobs(), { fetch: false }); } catch (_) { m = null; }
    const r = await M.tick({ m }); print(r); return r.ok ? 0 : 1;
  }
  if (cmd === 'set' || cmd === 'chain') {
    a.seat = a._[1] || a.seat;
    const r = cmd === 'set' ? await M.setPrimary(a) : await M.editChain(a);
    const code = r.code || 0; delete r.code; console.log(JSON.stringify(r, null, 1)); return code;
  }
  console.error('commands: show [--seat s] [--json], set <seat> --primary p/m [--effort e] --by <name>, chain <seat> --set|--add|--remove ... --by <name>, check [--json], tick [--dry], selftest');
  return 2;
}

module.exports = { makeModels, tick, hireChain, recordHireChain, putPrimary, chainedSeats, parseEntry, providerError, FAILOVER, REL };

if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; });
