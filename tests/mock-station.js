#!/usr/bin/env node
/* mock-station.js — a small in-memory imitation of the StarNet station API, for end-to-end tests of the CaPheOS tools.
 *
 *   node tests/mock-station.js --port 8899 --token <token> --log /tmp/x/requests.jsonl [--root <company root>]
 *
 * Covers the endpoints the tools in company/tools call (grep "'/api/" there): roster, agent/*, run (NDJSON events),
 * run/stream, observe (SSE; POST /__live starts a fake in-flight run), transcript, consent, projects (+ bless), cron (list, create, update, run, arm, remove, history), halt (+ status, resume), loops (+ control),
 * quests (+ update, mint, confirm), state/snapshot, runs, connectors, servicekeys, groups, save, budget/status and a few
 * read-only odds and ends. Every request needs header x-starnet-token (401 otherwise, like the station).
 *
 * Every request is appended to --log as one JSON line {at, method, path, query, body, status}; a test asserts on it.
 * Unknown routes answer 404 {error:"mock: no route"} and are logged too, so a test can list what the mock lacks.
 * With --root, POST /api/roster also writes <root>/.starnet-data/workspaces/agent.roster.json, as the station does
 * (station-crew.js reads the roster from that file), and the mock starts from that file's roster when it exists.
 * --fresh: a station whose page never ran (StarNet headless): GET /api/save answers {save:null} with a first-boot
 * lineage, the roster is empty, and the agent routes answer 404 for an agent the roster does not have, as the station
 * does. station-seed.js selftest drives it. --save-file <json>: start from that save instead (a GET /api/save reply
 * {save, head} or a bare save doc), e.g. a copy of a live station's save for an offline hire.js run.
 * No dependencies. Never point a test at a live station.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const PORT = Number(opt('port', process.env.MOCK_PORT || 0));
const TOKEN = String(opt('token', process.env.MOCK_TOKEN || 'mock-token'));
const LOG = opt('log', process.env.MOCK_LOG || '');
const ROOT = opt('root', process.env.MOCK_ROOT || '');
const FRESH = argv.includes('--fresh') || process.env.MOCK_FRESH === '1';
const SAVE_FILE = opt('save-file', process.env.MOCK_SAVE_FILE || '');

/* ---------------- state ---------------- */
const S = {
  // a fresh station's scheduler starts disarmed (StarNet's arm gate); onboarding arms it (POST /api/cron/arm)
  cron: { enabled: false, halted: false, jobs: [], nextId: 1, history: [] },
  projects: [],          // blessed project roots (POST /api/projects/bless)
  transcripts: {},       // streamId -> [{role, content, at}] (written by POST /api/run, read by GET /api/transcript)
  halt: { halted: false, at: null },
  loops: [],
  quests: [],
  runs: [],
  roster: [],
  groups: [],
  save: {
    revision: 1,
    doc: {
      agent: { id: 'agent', name: 'FOUNDER', model: 'deepseek-flash', provider: 'deepseek', approvalMode: 'full', docs: {} },
      agents: [{ id: 'agent', name: 'FOUNDER', model: 'deepseek-flash', provider: 'deepseek', approvalMode: 'full', docs: {} }],
      station: { _nid: 10, props: [], meta: { name: 'Mock station' } },
      dossier: {},
    },
  },
  runSeq: 1,
  dossierBlock: '', posture: null,
  live: [],              // runs in flight (GET /api/state/snapshot); a test starts one with POST /__live
};
/* the observer feed (GET /api/observe): SSE frames `data: {name, payload}` for every run event, like sidecar/observer.js */
const watchers = new Set();
function observe(name, payload) { const f = 'data: ' + JSON.stringify({ name, payload }) + '\n\n'; for (const w of watchers) { try { w.write(f); } catch (_) {} } }
// POST /__live {agentId, routine?, steps?: [[tool, args]], usd?, text?}: a fake in-flight run, announced on the observer feed
function startLive(B) {
  const runId = 'live-' + (S.runSeq++);
  const job = S.cron.jobs.find(j => j.agentId === (B.agentId || 'agent') && (!B.routine || j.name === B.routine));
  const r = { runId, agentId: B.agentId || 'agent', startedAt: Date.now() - (Number(B.ageSec) || 0) * 1000, source: 'cron', streamId: 'cron-' + runId };
  S.live.push(r); if (job) { job.inFlight = true; job.lastRunId = runId; }
  observe('agent.run.start', { runId, agentId: r.agentId, model: job ? job.model : '', trigger: 'cron', streamId: r.streamId });
  (B.steps || [['fs_read', 'company/CHARTER.md']]).forEach(([n, a], i) => { observe('agent.tool_call', { runId, agentId: r.agentId, callId: 'c' + i, name: n, argsSummary: a }); observe('agent.tool_result', { runId, callId: 'c' + i, ok: true, summary: 'ok' }); });
  if (B.usd) observe('agent.cost', { runId, usd: Number(B.usd) });
  if (B.text) observe('agent.token', { runId, delta: String(B.text) });
  return r;
}
if (FRESH) S.save = { revision: 0, doc: null };
if (SAVE_FILE) { const j = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); const doc = j && j.save !== undefined ? j.save : j; S.save = { revision: Number((j && j.head && j.head.revision) || (doc && doc._saveRevision) || 1), doc }; }
if (ROOT) { try { S.roster = JSON.parse(fs.readFileSync(path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json'), 'utf8')).agents || []; } catch (_) {} }
const nowIso = () => new Date().toISOString();
function rosterFile() { return ROOT ? path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json') : null; }
function writeRoster() {
  const f = rosterFile(); if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ agents: S.roster, updatedAt: Date.now() }, null, 1));
}
const findJob = id => S.cron.jobs.find(j => j.id === String(id || ''));
function parseSchedule(s, tz) {
  const ev = /^every\s+(\d+)\s*(minute|min|hour|h)s?$/i.exec(String(s || '').trim());
  if (ev) { const minutes = Number(ev[1]) * (/^h/i.test(ev[2]) ? 60 : 1); return { kind: 'interval', minutes, display: 'every ' + (minutes % 60 ? minutes + 'm' : minutes / 60 + 'h'), tz: tz || null }; }
  if (s && typeof s === 'object') return { kind: 'cron', expr: String(s.expr || ''), tz: s.tz || tz || null };
  return { kind: 'cron', expr: String(s || ''), tz: tz || null };
}

/* ---------------- helpers ---------------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return status;
}
function ndjson(res, events) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const e of events) res.write(JSON.stringify(e) + '\n');
  res.end();
  return 200;
}
function logReq(row) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch (_) {}
}
const CANNED = 'I would start by reading the charter and every open handoff, then agree the first three priorities with my manager. ' +
  'I measure myself on handoffs closed with evidence, not on activity, and I say plainly when something is blocked.';

/* ---------------- routes ---------------- */
function handle(method, p, q, body, res) {
  const B = body || {};
  // --- crew ---
  if (p === '/api/roster' && method === 'GET') return send(res, 200, { ok: true, agents: S.roster });
  if (p === '/api/roster' && method === 'POST') {
    if (!Array.isArray(B.agents)) return send(res, 400, { error: 'agents must be an array' });
    if (!B.agents.length) return send(res, 400, { error: 'agents must not be empty' });   // the station refuses the wipe
    S.roster = B.agents; writeRoster();
    return send(res, 200, { ok: true, count: S.roster.length });
  }
  if (p === '/api/agent/personality' && method === 'POST') {
    const r = S.roster.find(x => x.agentId === B.agentId);
    if (!r) return send(res, 404, { error: 'no agent "' + B.agentId + '" on this station' });
    if (typeof B.system !== 'string' || !B.system.trim()) return send(res, 409, { error: 'no StarNet page is open to compose the new prompt, and none was sent' });
    r.system = B.system; writeRoster();
    return send(res, 200, { ok: true, agentId: B.agentId, personality: B.personality, via: 'roster' });
  }
  if (p === '/api/agent/approval' && method === 'POST') {
    const r = S.roster.find(x => x.agentId === B.agentId);
    if (!r) return send(res, 404, { error: 'no agent "' + B.agentId + '" on this station' });
    if (B.mode !== 'full' && B.mode !== 'ask') return send(res, 400, { error: 'approval is "ask" or "full"' });
    r.approvalMode = B.mode; writeRoster();
    return send(res, 200, { ok: true, agentId: B.agentId, mode: B.mode, via: 'roster' });
  }
  if (p === '/api/agent/model' && method === 'POST') {
    const r = S.roster.find(x => x.agentId === B.agentId); if (r) { r.model = B.model; r.provider = B.provider; writeRoster(); }
    return send(res, 200, { ok: true, via: 'roster' });
  }
  if (p === '/api/agent/delete' && method === 'POST') {
    S.roster = S.roster.filter(x => x.agentId !== B.agentId); writeRoster();
    return send(res, 200, { ok: true, agentId: B.agentId });
  }
  if (p === '/api/save' && method === 'GET') {
    const lineage = { version: 1, onboardingAllowed: true, station: { state: S.save.doc ? 'current' : 'none' } };
    if (!S.save.doc) return send(res, 200, { save: null, recovery: null, lineage });
    return send(res, 200, { ok: true, save: JSON.parse(JSON.stringify(S.save.doc)), head: { revision: S.save.revision }, lineage });
  }
  if (p === '/api/save' && method === 'POST') {
    if (B._saveRevision != null && Number(B._saveRevision) !== S.save.revision) return send(res, 200, { ok: false, conflict: true, revision: S.save.revision });
    const doc = Object.assign({}, B); delete doc._saveRevision;
    S.save.doc = doc; S.save.revision++; S.save.doc._saveRevision = S.save.revision;
    return send(res, 200, { ok: true, revision: S.save.revision });
  }
  if (p === '/api/dossier' && method === 'POST') { S.dossierBlock = String(B.block || ''); return send(res, 200, { ok: true }); }
  if (p === '/api/autonomy/posture' && method === 'POST') { S.posture = Object.assign({}, S.posture || {}, B); return send(res, 200, { ok: true }); }
  if (p === '/api/autonomy/posture' && method === 'GET') return send(res, 200, { ok: true, posture: S.posture });
  // --- runs ---
  if (p === '/api/run' && method === 'POST') {
    if (!B.model) { res.writeHead(400); res.end('no model selected — pick a model first'); return 400; }
    const runId = 'run-' + (S.runSeq++);
    S.runs.push({ runId, agentId: B.agentId, source: 'interactive', streamId: B.streamId || null, startedAt: Date.now(), endedAt: Date.now(), usd: 0, internal: true, projectRoot: B.projectRoot || null, placed: B.placed || null });
    const msgs = Array.isArray(B.messages) ? B.messages : [];
    const last = msgs.length ? String(msgs[msgs.length - 1].content || '') : '';
    // a console chat (streamId console-*): stream the reply in pieces with a tool step, keep the transcript; a charter
    // brief also writes company/CHARTER.md under --root, as the Founder would with its file tools
    if (B.streamId && /^console-/.test(B.streamId)) {
      const reply = /\[fail\]/.test(last) ? null : /charter/i.test(last)
        ? 'Happy to. Three quick questions: what does the company do, for whom, and what will it never do? I have drafted company/CHARTER.md from what you told me so far. [Review it in Setup](console:#/setup/charter)'
        : 'Got it. ' + CANNED;
      const t = S.transcripts[B.streamId] = S.transcripts[B.streamId] || [];
      t.push({ role: 'user', content: last, at: nowIso() });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const evs = [{ name: 'agent.run.start', payload: { runId, agentId: B.agentId } }];
      if (!reply) evs.push({ name: 'agent.run.error', payload: { runId, message: 'provider error: HTTP 401 (mock)', failureCode: 'provider_auth' } }, { name: 'agent.run.end', payload: { runId, reason: 'error', outcome: 'failed', usd: 0 } });
      else {
        evs.push({ name: 'agent.tool_call', payload: { runId, callId: 'c1', name: 'fs_read', argsSummary: 'company/CHARTER.md' } }, { name: 'agent.tool_result', payload: { runId, callId: 'c1', ok: true, ms: 3, summary: 'read 40 lines' } });
        for (const w of reply.match(/\S+\s*/g)) evs.push({ name: 'agent.token', payload: { runId, delta: w } });
        evs.push({ name: 'agent.run.end', payload: { runId, reason: 'done', outcome: 'succeeded', usd: 0.0012 } });
      }
      let i = 0;
      const tick = () => {
        if (i >= evs.length) {
          if (reply) {
            t.push({ role: 'assistant', content: reply, at: nowIso() });
            if (/charter/i.test(last) && ROOT && B.projectRoot) {
              try { const f = path.join(ROOT, 'company', 'CHARTER.md'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/<(?!none yet>)[A-Za-z][^<>\n]{0,200}>/g, 'Drafted with the owner in the console.')); } catch (_) {}
            }
          }
          return res.end();
        }
        res.write(JSON.stringify(evs[i++]) + '\n'); setTimeout(tick, 40);
      };
      tick();
      return 200;
    }
    return ndjson(res, [
      { name: 'agent.run.start', payload: { runId, agentId: B.agentId } },
      { name: 'agent.token', payload: { runId, delta: CANNED } },
      { name: 'agent.run.end', payload: { runId, reason: 'done', usd: 0 } },
    ]);
  }
  if (p === '/api/transcript' && method === 'GET') {
    const stream = q.get('stream') || 'global';
    return send(res, 200, { stream, turns: (S.transcripts[stream] || []).slice(-(Number(q.get('limit')) || 200)) });
  }
  if (p === '/api/consent' && method === 'POST') return send(res, 200, { ok: true, decision: B.decision || 'deny' });
  // --- projects (the blessed folders an agent may work in) ---
  if (p === '/api/projects' && method === 'GET') return send(res, 200, { projects: S.projects });
  if (p === '/api/projects/bless' && method === 'POST') {
    if (!B.path || !path.isAbsolute(String(B.path))) return send(res, 400, { ok: false, reason: 'an absolute path is required' });
    if (!S.projects.some(x => x.root === B.path)) S.projects.push({ root: String(B.path), displayPath: String(B.path), grantedAt: Date.now(), blessed: true });
    return send(res, 200, { ok: true, root: String(B.path) });
  }
  if (p === '/api/run/stream' && method === 'GET') return ndjson(res, [{ name: 'stream.hello', payload: {} }]);
  if (p === '/api/run/steer') return send(res, 200, { ok: true });
  if (p === '/api/runs' && method === 'GET') return send(res, 200, { ok: true, runs: S.runs.slice(-200) });
  if (p === '/api/state/snapshot' && method === 'GET') return send(res, 200, { ok: true, runs: S.live.map(r => ({ runId: r.runId, agentId: r.agentId, startedAt: r.startedAt, source: r.source, streamId: r.streamId, stoppable: true })), agents: S.roster.map(r => ({ agentId: r.agentId, name: r.name })) });
  if (p === '/api/cancel' && method === 'POST' && S.live.some(r => r.runId === B.runId)) { const r = S.live.find(x => x.runId === B.runId); S.live = S.live.filter(x => x !== r); observe('agent.run.end', { runId: r.runId, agentId: r.agentId, reason: 'cancelled', outcome: 'cancelled', usd: 0.001 }); return send(res, 200, { ok: true }); }
  if (p === '/api/cancel') return send(res, 200, { ok: true });
  if (p === '/api/state' && method === 'GET') return send(res, 200, { ok: true, agents: S.roster });
  // --- routines ---
  if (p === '/api/cron' && method === 'GET') return send(res, 200, { ok: true, enabled: S.cron.enabled, halted: S.cron.halted, jobs: S.cron.jobs });
  if (p === '/api/cron' && method === 'POST') {
    if (!B.name || !B.prompt) return send(res, 400, { error: 'name and prompt are required' });
    const dup = S.cron.jobs.find(j => j.name === B.name && j.agentId === (B.agentId || 'agent'));
    if (dup) return send(res, 200, { ok: true, duplicate: true, job: dup });
    const job = { id: 'job-' + (S.cron.nextId++), name: String(B.name), agentId: String(B.agentId || 'agent'), schedule: parseSchedule(B.schedule, B.tz),
      prompt: String(B.prompt), workdir: B.workdir || null, deliver: B.deliver || 'local', enabled: B.enabled !== false, model: B.model || null,
      provider: B.provider || null, unattendedGrants: Array.isArray(B.unattendedGrants) ? B.unattendedGrants.filter(g => ['workbench', 'connectors', 'studio'].includes(g)) : [],
      createdAt: nowIso(), lastRunAt: null, lastStatus: null, inFlight: false };
    S.cron.jobs.push(job);
    if (B.arm === true && !S.cron.armSet) { S.cron.enabled = true; S.cron.armSet = true; }
    return send(res, 200, { ok: true, job, scheduler: { armed: S.cron.enabled } });
  }
  if (p === '/api/cron/update' && method === 'POST') {
    const job = findJob(B.id); if (!job) return send(res, 404, { error: 'no such routine' });
    const patch = B.patch && typeof B.patch === 'object' ? B.patch : null;
    if (!patch || !Object.keys(patch).length) return send(res, 400, { error: 'missing patch' });
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'schedule') job.schedule = parseSchedule(v, patch.timezone || (job.schedule && job.schedule.tz));
      else if (k === 'timezone') job.schedule = Object.assign({}, job.schedule, { tz: v });
      else job[k] = v;
    }
    return send(res, 200, { ok: true, job });
  }
  if (p === '/api/cron/run' && method === 'POST') {
    const job = findJob(B.id); if (!job) return send(res, 404, { error: 'no such routine' });
    if (S.halt.halted) return send(res, 409, { error: 'station is halted' });
    const runId = 'run-' + (S.runSeq++);
    job.lastRunAt = nowIso(); job.lastStatus = 'ok'; job.inFlight = false;   // the mock run finishes at once
    S.cron.history.push({ jobId: job.id, runId, at: job.lastRunAt, status: 'ok' });
    S.runs.push({ runId, agentId: job.agentId, source: 'cron', startedAt: Date.now(), endedAt: Date.now(), usd: 0, provider: job.provider });
    return send(res, 200, { ok: true, runId, detached: !!B.detach });
  }
  if (p === '/api/cron/arm' && method === 'POST') {
    if (typeof B.enabled !== 'boolean') return send(res, 400, { error: 'enabled (boolean) is required' });
    S.cron.enabled = B.enabled; S.cron.halted = false; S.cron.armSet = true;
    return send(res, 200, { ok: true, enabled: S.cron.enabled });
  }
  if (p === '/api/cron/remove' && method === 'POST') {
    const before = S.cron.jobs.length; S.cron.jobs = S.cron.jobs.filter(j => j.id !== String(B.id || ''));
    return before === S.cron.jobs.length ? send(res, 404, { error: 'no such routine' }) : send(res, 200, { ok: true });
  }
  if (p === '/api/cron/history' && method === 'GET') return send(res, 200, { ok: true, runs: S.cron.history.filter(h => !q.get('id') || h.jobId === q.get('id')) });
  // --- halt ---
  if (p === '/api/halt' && method === 'POST') {
    S.halt = { halted: true, at: nowIso() }; S.cron.halted = true;
    for (const j of S.cron.jobs) j.inFlight = false;
    return send(res, 200, { ok: true, halted: 1, cronAborted: 0, loopAborted: 0 });
  }
  if (p === '/api/halt' && method === 'GET') return send(res, 200, { ok: true, halted: S.halt.halted, at: S.halt.at });
  if (p === '/api/halt/resume' && method === 'POST') {
    if (B.confirm !== true) return send(res, 400, { error: 'explicit confirm:true is required to resume' });
    S.halt = { halted: false, at: null }; S.cron.halted = false;
    return send(res, 200, { ok: true });
  }
  // --- goal loops ---
  if (p === '/api/loops' && method === 'GET') return send(res, 200, { ok: true, loops: S.loops });
  if (p === '/api/loops/control' && method === 'POST') {
    const l = S.loops.find(x => x.id === B.id); if (!l) return send(res, 404, { error: 'no such loop' });
    if (B.action === 'pause') l.state = 'paused'; else if (B.action === 'resume') l.state = 'idle';
    return send(res, 200, { ok: true, loop: l });
  }
  // --- quests ---
  if (p === '/api/quests' && method === 'GET') return send(res, 200, { ok: true, quests: S.quests });
  if (p === '/api/quests/mint' && method === 'POST') {
    const qn = { id: 'q:' + (S.quests.length + 1), title: String(B.title || 'quest'), agentId: B.agentId || null, status: 'open', steps: (B.steps || []).map((s, i) => ({ key: 's' + i, text: String(s.text || s), done: false })), contract: B.contract || null };
    S.quests.push(qn); return send(res, 200, { ok: true, quest: qn });
  }
  if ((p === '/api/quests/update' || p === '/api/quests/confirm') && method === 'POST') {
    const qn = S.quests.find(x => x.id === B.id); if (!qn) return send(res, 404, { error: 'no such quest' });
    if (p.endsWith('confirm')) qn.status = B.ok ? 'done' : 'open';
    return send(res, 200, { ok: true, quest: qn });
  }
  // --- odds and ends the tools read ---
  if (p === '/api/connectors' && method === 'GET') return send(res, 200, { ok: true, connectors: [] });
  if (p === '/api/servicekeys' && method === 'GET') return send(res, 200, { ok: true, keys: [] });
  if (p === '/api/servicekeys/autonomy' && method === 'POST') return send(res, 200, { ok: true });
  if (p === '/api/groups' && method === 'GET') return send(res, 200, { ok: true, groups: S.groups });
  if (p === '/api/groups' && method === 'POST') {
    if (B.op === 'control' && B.action === 'delete') { S.groups = S.groups.filter(g => g.id !== B.id); return send(res, 200, { ok: true }); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/budget/status' && method === 'GET') return send(res, 200, { ok: true, providers: {} });
  if (p === '/api/version' && method === 'GET') return send(res, 200, { ok: true, version: 'mock-station' });
  if (p === '/api/providers' && method === 'GET') return send(res, 200, { ok: true, providers: [{ id: 'deepseek', configured: true, unattendedReady: true }] });
  if (p.startsWith('/api/models/') && method === 'GET') return send(res, 200, { ok: true, models: [{ id: 'deepseek-flash' }] });
  if (p === '/api/permissions' && method === 'GET') return send(res, 200, { ok: true, bypass: false });
  if (p === '/api/permissions/bypass' && method === 'POST') return send(res, 200, { ok: true, bypass: !!B.on });
  if (p === '/api/computer-control') return send(res, 200, { ok: true, backend: 'off' });
  if (p === '/api/channels/events') return send(res, 200, { ok: true, events: [] });
  if (p === '/api/runtime/agent' || p === '/api/runtime/knobs') return send(res, 200, { ok: true });
  if (p === '/api/skills' || p === '/api/skill-market' || p.startsWith('/api/agent-skills')) return send(res, 200, { ok: true, skills: [], candidates: [] });
  return send(res, 404, { error: 'mock: no route ' + method + ' ' + p });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://mock');
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 4e6) req.destroy(); });
  req.on('end', () => {
    let body = null;
    if (raw.trim()) { try { body = JSON.parse(raw); } catch (_) { body = { _raw: raw.slice(0, 500) }; } }
    const row = { at: nowIso(), method: req.method, path: u.pathname, query: u.search || '', body };
    if (req.headers['x-starnet-token'] !== TOKEN) { row.status = send(res, 401, { error: 'token required' }); return logReq(row); }
    if (u.pathname === '/__state') { row.status = send(res, 200, S); return logReq(row); }
    if (u.pathname === '/__live' && req.method === 'POST') { row.status = send(res, 200, { ok: true, run: startLive(body || {}) }); return logReq(row); }
    if (u.pathname === '/api/observe' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }); res.write('retry: 3000\n\n');
      watchers.add(res); res.on('close', () => watchers.delete(res));   // not req 'close': it fires once the request body is read
      row.status = 200; return logReq(row);
    }
    try { row.status = handle(req.method, u.pathname, u.searchParams, body, res); }
    catch (e) { row.status = send(res, 500, { error: 'mock: ' + e.message }); }
    // keep the log small: drop prompt/system bodies beyond 300 chars
    if (row.body) for (const k of ['prompt', 'system']) if (typeof row.body[k] === 'string' && row.body[k].length > 300) row.body[k] = row.body[k].slice(0, 300) + '…';
    if (row.path === '/api/save' && row.body) row.body = { _save: true, _saveRevision: row.body._saveRevision };
    logReq(row);
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ok: true, port: server.address().port, pid: process.pid }));
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
