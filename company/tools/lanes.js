#!/usr/bin/env node
/* lanes.js — Sprint parallel lanes: a worker seat with two or more OPEN, independent handoffs works them at the same time.
 *
 * docs/TEMPO.md "Parallel lanes". While Sprint is on and cadence.json tempo.sprint.lanes > 1, the dispatcher calls
 * dispatchHook() once per tick (one fail-safe call in dispatch.js, after the pacer). For each worker seat whose OPEN,
 * actionable handoffs declare disjoint `**Touches:**` paths (lib/sprint.js lanePlan / overlaps), it starts extra lanes up
 * to the seat's limit: each lane is its OWN station run (a disabled one-off routine "Lane <8 hex>" fired with
 * POST /api/cron/run, never the seat's loop fired twice), on the seat's agent id and the model the seat's loop routine
 * has right now (the pacer and models.js chains already moved it this tick), in its own folder:
 *   company/work/lanes/<seat>/<n>  a git worktree on branch lane/<seat>-<n>-<stamp> when the seat writes code and the
 *                                   item's paths are in one git repository, else a scratch folder (its own `git init`,
 *                                   so the station blesses exactly that folder). company/work/ is gitignored.
 * The lane's prompt names the ONE handoff it owns and says to touch only its declared paths. A per-path lock
 * (lib/sprint.js makePathLock, company/state/lane-locks.json) is held for the lane's life; an item whose paths overlap a
 * live lane's waits. The handoff gets a `**Lane:** n, run <id>, since <time>` line, and the dispatcher does not wake the
 * seat's main loop for items only lanes own (HANDOFFS.md: a section with a Lane line is not the main loop's).
 * When a lane ends (or times out, or a hard halt cuts it off) the next tick: releases its lock, removes its routine,
 * writes its result (LANE-RESULT.md in its folder) into the handoff, and leaves its branch for the seat's normal review
 * flow (a branch with no commits is deleted; nothing is ever merged into the main checkout or pushed).
 *
 * Safety: the CEO seat never gets lanes. Lanes count against the Sprint budget, the daily metered cap and the per-agent
 * share (same rules as a wake: dispatch.js capDecision), the Sprint spread, the wake caps (cadence.js tempoAllows) and
 * the pacer (a seat the pacer held this tick, or whose loop is paused or on "ask", gets no lane). Caps: tempo.sprint.lanes
 * runs per seat INCLUDING its main loop, tempo.sprint.maxLanesTotal extra lanes in the company, tempo.sprint.laneTimeoutMin
 * per lane (owner: cadence.js sprint config --lanes N --max-lanes-total N --lane-timeout-min N). A soft halt starts no new
 * lane (the dispatcher wakes nobody while halted); a hard halt cuts them off (halt.js hard calls cutOff()). Lanes need a
 * station with patch 0012 (GET /api/version capabilities "workspace-lease-per-folder"): without it no lane starts, the
 * dispatch log says so once, and Crew shows why.
 *
 *   node company/tools/lanes.js status [--json]        live lanes, the last ended ones, what the station allows
 *   node company/tools/lanes.js end <seat>/<n> --by <name> [--why "…"]    stop one lane now (its result is reported as usual)
 *
 * PIECE LANES (narrow fan-out, docs/DEPARTMENTS.md §6): a department lead's RECORDED split (lib/consult.js
 * splitCandidates: a SPLIT answer or the lead's consult.js split, **Fan-out:** lanes, the department's delegation live) is
 * offered to the lead's allowlisted workers (departments.json delegation.workers, inside the lead's reports in loops.json,
 * not busy), ONE piece per lane and at most delegation.maxWorkers at once. A piece lane runs on the WORKER's agent and
 * model, touches only the piece's files, has its own time limit (delegation.workerTimeoutMin) and the same money, tempo,
 * class-rule and pacer checks as any lane; Sprint need not be on. The item's block gets `**Piece n lane:**` while it runs
 * and `**Piece n result (...):**` when it ends; the item itself is never closed by a piece (its holder or the lead closes it).
 * Its wakes.jsonl row carries split {item, piece, lead}, which model-rank.js fanoutEvaluation reads.
 *
 * State: company/state/lanes.json (recorded with provenance.js). It is never trusted to name a routine: a lane's routine is
 * cancelled or removed only when the station shows it is one (isLaneJob). Owner: the tools seat.
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const SP = require('./lib/sprint');
const A = require('./lib/admit');
const SCHED = require('./lib/scheduler');
const REF = require('./lib/refusal');

const CAPABILITY = 'workspace-lease-per-folder';
const HOOK_TIMEOUT_MS = 60000;
const DEFAULTS = { maxLanesTotal: 6, laneTimeoutMin: 95 };
const S = {   // seams: the tests point these at a temp company and the mock station
  root: () => co.ROOT,
  now: () => Date.now() + (Number(process.env.LANES_CLOCK_SKEW_MIN) || 0) * 60000,   // the skew: tests only (a lane's time limit)
  call: (method, p, body, timeoutMs) => httpCall(method, p, body, timeoutMs),
  fire: (jobId, override) => fireRun(jobId, override),
};
const rel = (...a) => path.join(S.root(), ...a);
const stateFile = () => rel('company', 'state', 'lanes.json');
const lockFile = () => rel('company', 'state', 'lane-locks.json');
const lanesDir = () => rel('company', 'work', 'lanes');
const inboxPath = inbox => rel('company', 'work', 'handoffs', inbox);
const iso = t => new Date(t).toISOString();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };

/* ---------- station ---------- */
function httpCall(method, p, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(co.STATION_URL + p);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign({ 'x-starnet-token': co.stationToken() }, body ? { 'Content-Type': 'application/json' } : {}), timeout: timeoutMs || 15000 }, res => {
      let d = ''; res.on('data', c => { d += c; if (d.length > 2e6) d = d.slice(-1e6); });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
// POST /api/cron/run {detach:true}: admitted on a 200, the run keeps going after the socket closes. Read up to 4 s of
// the run's opening lines for its runId (cron.fire / agent.run.start), then let go.
function fireRun(jobId, override) {
  return new Promise(resolve => {
    let token; try { token = co.stationToken(); } catch (e) { resolve({ status: 0, body: e.message }); return; }
    const u = new URL(co.STATION_URL + '/api/cron/run');
    let done = false, d = '', status = 0;
    const finish = () => { if (done) return; done = true; const m = /"runId"\s*:\s*"([^"]+)"/.exec(d); resolve({ status, body: d.slice(0, 300), runId: m ? m[1] : null }); try { req.destroy(); } catch (_) {} };
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-starnet-token': token, 'Content-Type': 'application/json' } }, res => {
      status = res.statusCode;
      res.on('data', c => { d += c; if (status !== 200 || /"runId"\s*:\s*"[^"]+"/.test(d)) finish(); });
      res.on('end', finish); res.on('error', finish);
      setTimeout(finish, 4000);
    });
    req.setTimeout(15000, finish);
    req.on('error', e => { d = e.message; finish(); });
    req.write(JSON.stringify(override ? Object.assign({ id: jobId, detach: true }, override) : { id: jobId, detach: true }));   // a one-run override only when the router applied one
    req.end();
  });
}
const j = r => { try { return JSON.parse(r.body); } catch (_) { return null; } };
/* the capability probe: does this station key the workspace lease by folder (patch 0012)? */
async function probe() {
  try {
    const r = await S.call('GET', '/api/version', null, 5000);
    const v = r.status === 200 ? j(r) : null;
    if (v && Array.isArray(v.capabilities) && v.capabilities.includes(CAPABILITY)) return { ok: true };
    return { ok: false, why: 'this station has not applied patch 0012 (StarNet lets one run of an agent hold its files and shell at a time, so a second lane would wait 45 s and fail): re-run scripts/setup-station.sh, then restart the station when idle (scripts/restart-station.sh --when-idle)' };
  } catch (e) { return { ok: false, why: 'the station did not answer GET /api/version (' + String(e.message).slice(0, 80) + ')' }; }
}

/* ---------- state ---------- */
function load() { const s = readJson(stateFile(), null) || {}; return { lanes: Array.isArray(s.lanes) ? s.lanes : [], history: Array.isArray(s.history) ? s.history : [], notes: s.notes || {} }; }
function save(st) {
  const f = stateFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
  const txt = JSON.stringify({ _doc: 'Sprint lanes (company/tools/lanes.js): live lanes, the last 50 that ended. Written only by lanes.js.', lanes: st.lanes, history: st.history.slice(-50), notes: st.notes }, null, 1) + '\n';
  const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, f);
  try { require('./provenance.js').wrote(f, txt, 'lanes.js'); } catch (_) {}
}
function config(sprint) {
  let raw = {}; try { raw = (require('./cadence.js').load().tempo || {}).sprint || {}; } catch (_) {}
  const num = (v, d, lo) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= lo ? n : d; };
  const src = Object.assign({}, raw, sprint || {});
  return { perSeat: num(src.lanes, 1, 1), maxLanesTotal: num(src.maxLanesTotal, DEFAULTS.maxLanesTotal, 0), timeoutMin: num(src.laneTimeoutMin, DEFAULTS.laneTimeoutMin, 5) };
}

/* ---------- handoff sections ---------- */
const fieldOf = (sec, name) => { const m = String(sec).match(new RegExp('^\\*\\*' + name + ':\\*\\*(.*)$', 'mi')); return m ? m[1].trim() : null; };
function sections(file) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return { txt: null, parts: [] }; }
  return { txt, parts: txt.split(/^(?=## )/m) };
}
// rewrite one section (matched by its exact heading) of an inbox file; fn(sectionText) -> new text
function editSection(file, heading, fn) {
  const { parts } = sections(file); let hit = false;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('## ')) continue;
    if (parts[i].split('\n')[0].slice(3).trim() !== heading) continue;
    const nx = fn(parts[i]); if (nx !== parts[i]) { parts[i] = nx; hit = true; } break;
  }
  if (hit) fs.writeFileSync(file, parts.join(''));
  return hit;
}
const LANE_LINE = /^\*\*Lane:\*\*.*\n?/m;
const pieceLine = n => new RegExp('^\\*\\*Piece ' + Number(n) + ' lane:\\*\\*.*\\n?', 'm');
const ANY_PIECE_LINE = /^\*\*Piece (\d+) lane:\*\*.*$/gm;
function markPiece(file, heading, n, line) {
  return editSection(file, heading, sec => { const s = sec.replace(pieceLine(n), ''); return s.replace(/\s*$/, '') + '\n**Piece ' + n + ' lane:** ' + line + '\n' + (/\n\n$/.test(sec) ? '\n' : ''); });
}
function reportPiece(file, heading, o) {
  return editSection(file, heading, sec => {
    const s = sec.replace(pieceLine(o.piece), '');
    const note = '**Piece ' + o.piece + ' result (lane ' + o.n + ', ' + o.who + ', run ' + String(o.runId || '?').slice(0, 12) + ', ' + o.when + '):** ' + o.text;
    return s.replace(/\s*$/, '') + '\n' + note.replace(/\n+/g, ' ') + '\n' + (/\n\n$/.test(sec) ? '\n' : '');
  });
}
function markLane(file, heading, line) {
  return editSection(file, heading, sec => {
    const s = sec.replace(LANE_LINE, '');
    return /^\*\*Status:\*\*.*$/m.test(s) ? s.replace(/^(\*\*Status:\*\*.*)$/m, '$1\n**Lane:** ' + line) : s.replace(/\n?$/, '\n**Lane:** ' + line + '\n');
  });
}
function reportLane(file, heading, o) {
  return editSection(file, heading, sec => {
    let s = sec.replace(LANE_LINE, '');
    if (o.done) s = s.replace(/^\*\*Status:\*\*\s*OPEN\b.*$/m, '**Status:** DONE — ' + o.done);
    const note = '**Lane result (lane ' + o.n + ', run ' + String(o.runId || '?').slice(0, 12) + ', ' + o.when + '):** ' + o.text;
    return s.replace(/\s*$/, '') + '\n' + note.replace(/\n+/g, ' ') + '\n' + (/\n\n$/.test(sec) ? '\n' : '');
  });
}

/* ---------- git ---------- */
const git = (cwd, args, o) => execFileSync('git', ['-C', cwd].concat(args), Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }, o || {})).trim();
function topLevel(dir) { try { return fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel'])); } catch (_) { return null; } }
function writesCode(c) {
  if (c && typeof c.writesCode === 'boolean') return c.writesCode;
  if (!c) return false;
  return co.holds(c, 'tools') || /engineer|developer|programmer|coder|devops/i.test([c.title, c.role, c.seat].filter(Boolean).join(' '));
}
/* where a lane works: { kind: 'worktree', repo, touches (relative to the repo) } or { kind: 'scratch' } */
function placeOf(c, touches) {
  if (!writesCode(c)) return { kind: 'scratch', why: 'the seat does not write code' };
  const root = fs.realpathSync(S.root());
  let repo = root, rt = touches;
  const m = touches.map(t => /^company\/repos\/([^/]+)(?:\/(.*))?$/.exec(t));
  if (m.every(Boolean) && new Set(m.map(x => x[1])).size === 1) { repo = path.join(root, 'company', 'repos', m[0][1]); rt = m.map(x => x[2] || '.'); }
  if (topLevel(repo) !== fs.realpathSync(repo)) return { kind: 'scratch', why: path.relative(root, repo) + ' is not a git repository' };
  for (const t of rt) { try { git(repo, ['check-ignore', '-q', t]); return { kind: 'scratch', why: t + ' is not tracked (gitignored)' }; } catch (_) { /* exit 1: not ignored */ } }
  return { kind: 'worktree', repo, touches: rt };
}
function prepare(seat, n, place) {
  const dir = path.join(lanesDir(), seat, String(n));
  if (place.kind === 'worktree') {
    if (fs.existsSync(dir)) { try { git(place.repo, ['worktree', 'remove', '--force', dir]); } catch (_) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} try { git(place.repo, ['worktree', 'prune']); } catch (_) {} }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const base = git(place.repo, ['rev-parse', 'HEAD']);
    const branch = 'lane/' + seat + '-' + n + '-' + new Date(S.now()).toISOString().replace(/[-:]/g, '').slice(0, 13);
    git(place.repo, ['worktree', 'add', '-q', '-b', branch, dir, base]);
    return { dir: fs.realpathSync(dir), branch, base, repo: place.repo };
  }
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) { try { git(dir, ['init', '-q']); } catch (_) {} }   // its own project root: the station blesses this folder, not the company root
  try { fs.rmSync(path.join(dir, 'LANE-RESULT.md'), { force: true }); } catch (_) {}
  return { dir: fs.realpathSync(dir), branch: null, base: null, repo: null };
}

/* ---------- the lane's prompt ---------- */
function promptFor(o) {
  const lines = [
    'You are ' + o.name + ', working ONE handoff as a parallel lane (Sprint lane ' + o.id + '). Your main loop works your other items at the same time, so stay inside this one.',
    '',
    'YOUR HANDOFF: "' + o.heading + '" in company/work/handoffs/' + o.inbox + ' (the full file: ' + inboxPath(o.inbox) + '). Its text:',
    '<<<', String(o.text || '').replace(/^\*\*Lane:\*\*.*$/m, '').trim().slice(0, 3000), '>>>',
    'Do NOT edit the inbox file: the lane tool reports your result into it when you finish.',
    '',
    o.piece ? 'YOUR PIECE ' + o.piece.n + ' of this item: ' + o.piece.title + '. ' + (o.lead || 'Your lead') + ' split the item and handed this piece to you; the other pieces go to other people, so do only yours. ACCEPTANCE CHECK: ' + o.piece.check : null,
    'TOUCH ONLY THESE PATHS: ' + o.touches.join(', ') + '. If the work needs anything else, do not change it: say so in your result, and ' + (o.piece ? (o.lead || 'your lead') + ' picks it up.' : 'your main loop picks it up.'),
    o.kind === 'worktree'
      ? 'YOUR FOLDER: ' + o.dir + ' is a git worktree of ' + o.repo + ' on branch ' + o.branch + '. Work there with relative paths and commit your changes on this branch (git add + git commit). Never push, never switch or merge branches; the seat\'s normal review flow merges it.'
      : 'YOUR FOLDER: ' + o.dir + ' is a scratch folder for notes and drafts. Your declared paths are in the company folder ' + S.root() + ': write them there.',
    '',
    'WHEN YOU FINISH, write LANE-RESULT.md in your folder. First line: `Status: DONE — <one line>` or `Status: BLOCKED — <why>` or `Status: OPEN — <what is left>`. Then a few lines: what you changed (files, commits), what you checked. Then stop: take no other work.',
  ].filter(l => l !== null);
  return lines.join('\n');
}

/* ---------- budget: the same rules as a wake, from the one copy (lib/admit.js money()) ----------
 * No money rule lives here: the dispatcher's numbers (a.budget) go to A.money(), and a lane's start goes through admit()
 * (door lane). Phase 1 keeps the lane's inputs as they were (no `blocking` passed to the spread); phase 2 decides in admit(). */
function moneyHold(seatJob, b, agentId) {
  if (!b) return null;
  const m = A.money({ metered: !(b.unmetered || ['claude-cli']).includes(String(seatJob.provider || '')), capOn: b.capOn, capped: b.capped,
    share: { usd: b.perAgentUsd, spent: (b.byAgent || {})[agentId] }, sprintBudgetLeft: b.sprintBudgetLeft,
    spread: { on: b.spread !== false, cap: b.dailyUsd, spent24h: b.spent, spentLastHour: b.lastHourMetered, hoursLeft: b.hoursLeft } });
  return m.verdict === 'run' || m.verdict === 'wouldHold' ? null : m.why;
}

/* ---------- end a lane ---------- */
async function finish(st, lane, how, ctx) {
  const say = (ctx && ctx.log) || (() => {});
  const crew = co.crew() || {}; const name = (crew[lane.seat] || {}).name || lane.seat;
  // only ever a lane's own routine and run: lanes.json is a plain file, so a stale or edited row must not reach a loop routine
  let jobs = null; try { const r = await S.call('GET', '/api/cron', null, 10000); const v = r.status === 200 ? j(r) : null; if (v && Array.isArray(v.jobs)) jobs = v.jobs; } catch (_) {}
  const job = jobs && jobs.find(x => x && x.id === lane.jobId);
  const ours = !!job && isLaneJob(job, jobs);
  if (how.cancel && lane.runId && ours && (!job.inFlightRunId || job.inFlightRunId === lane.runId)) { try { await S.call('POST', '/api/cancel', { runId: lane.runId }, 10000); } catch (_) {} }
  let result = null; try { result = fs.readFileSync(path.join(lane.dir, 'LANE-RESULT.md'), 'utf8').slice(0, 4000); } catch (_) {}
  const first = result ? (result.split('\n').find(l => l.trim()) || '') : '';
  const m = /^\s*\**Status:?\**:?\s*(DONE|BLOCKED|OPEN)\b\s*[—:-]*\s*(.*)$/i.exec(first);
  const status = m ? m[1].toUpperCase() : null, summary = m ? m[2].trim().slice(0, 200) : first.trim().slice(0, 200);
  let commits = 0, branchNote = '';
  if (lane.kind === 'worktree' && lane.repo) {
    try { fs.rmSync(path.join(lane.dir, 'LANE-RESULT.md'), { force: true }); } catch (_) {}
    try {
      if (git(lane.dir, ['status', '--porcelain'])) { git(lane.dir, ['add', '-A']); git(lane.dir, ['-c', 'user.name=' + name, '-c', 'user.email=lane@capheos.local', 'commit', '-q', '--no-verify', '-m', 'lane ' + lane.id + ': work left uncommitted when the lane ended (' + how.why + ')']); }
    } catch (_) {}
    try { commits = Number(git(lane.repo, ['rev-list', '--count', lane.base + '..' + lane.branch])) || 0; } catch (_) {}
    try { git(lane.repo, ['worktree', 'remove', '--force', lane.dir]); } catch (_) {}
    if (commits) branchNote = 'branch `' + lane.branch + '` in ' + (path.relative(S.root(), lane.repo) || 'the company repo') + ' has ' + commits + ' commit(s), not merged: review and merge it in your normal flow (`git log ' + lane.base.slice(0, 10) + '..' + lane.branch + '`)';
    else { try { git(lane.repo, ['branch', '-D', lane.branch]); } catch (_) {} branchNote = 'no commits'; }
  } else { try { fs.rmSync(path.join(lane.dir, 'LANE-RESULT.md'), { force: true }); } catch (_) {} }
  if (ours) { const rm = await require('./lib/station').cron((m, u, b) => S.call(m, u, b, 10000), 'POST', '/api/cron/remove', { id: lane.jobId }, 'remove lane routine "' + (job.name || lane.jobId) + '"'); if (!rm.ok) say('LANES: could not ' + rm.reason); }
  try { SP.makePathLock(lockFile()).release(lane.id); } catch (_) {}
  const outcome = how.why === 'ended' ? (status || 'no result file') : how.why;
  const text = (how.why === 'ended' ? '' : 'the lane was ' + (how.why === 'timeout' ? 'stopped after its ' + lane.timeoutMin + ' min limit' : how.why === 'halt' ? 'cut off by a hard halt' : how.why === 'lost' ? 'never seen running on the station' : 'stopped (' + how.why + ')') + '. ')
    + (status ? status + (summary ? ' — ' + summary : '') : result ? summary : 'it wrote no LANE-RESULT.md') + (branchNote ? '; ' + branchNote : '') + (status === 'DONE' && !commits ? '' : '. The main loop takes it from here.');
  const done = status === 'DONE' && !commits && how.why === 'ended' ? (summary || 'done by lane ' + lane.n) + ' (lane ' + lane.n + ')' : null;
  if (lane.piece) { try { reportPiece(inboxPath(lane.inbox), lane.heading, { piece: lane.piece, n: lane.n, who: name, runId: lane.runId, when: iso(S.now()), text: text.replace('. The main loop takes it from here.', '. ' + (lane.leadName || 'The lead') + ' takes it from here.') }); } catch (_) {} }
  else try { reportLane(inboxPath(lane.inbox), lane.heading, { n: lane.n, runId: lane.runId, when: iso(S.now()), text, done }); } catch (_) {}
  st.lanes = st.lanes.filter(x => x.id !== lane.id);
  st.history.push(Object.assign({}, lane, { endedAt: iso(S.now()), outcome, commits, summary: summary || null }));
  if (ctx && ctx.state && ctx.state.sprintSig) delete ctx.state.sprintSig[lane.seat];   // the seat's main loop sees the result at its next tick
  say('LANE END ' + lane.id + ' (' + name + ', "' + lane.heading.slice(0, 80) + '"): ' + outcome + (commits ? ', ' + commits + ' commit(s) on ' + lane.branch : ''));
}
/* a lane run the model refused (lib/refusal.js, owner ruling): the lane is re-run ONCE on the seat's next model, the same
 * item and folder; a retry refused again, or no other model in the chain, is said plainly and the item goes back to the
 * seat's main loop */
function runRecord(runId) {
  try {
    for (const l of require('./lib/bounded').tailLines(rel('.starnet-data', 'workspaces', 'runs.jsonl'), 400).reverse()) {
      if (!l.includes(runId)) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (r && r.runId === runId) return r;
    }
  } catch (_) {}
  return null;
}
async function refused(st, lane, jobs, ctx) {
  const say = (ctx && ctx.log) || (() => {});
  const from = { provider: lane.provider, model: lane.model };
  const next = lane.retryOf ? null : REF.nextEntry(lane.seat, from, lane.tried || []);
  await finish(st, lane, { why: next ? 'refused' : 'refused by every model' }, ctx);
  if (!next) { say('LANE REFUSED ' + lane.id + ': ' + (lane.retryOf ? REF.pname(lane.provider) + ' declined it too after a retry' : REF.plainLine(from, null)) + '; the item goes back to the seat\'s main loop'); REF.record({ root: S.root(), seat: lane.seat, door: 'lane', runId: lane.runId, from, to: null }); return; }
  const c = (co.crew() || {})[lane.seat] || {};
  const loop = (jobs || []).filter(x => x && c.loop && (x.name === c.loop || String(x.name).startsWith(c.loop)))[0] || { agentId: lane.seat };
  const sec = sections(inboxPath(lane.inbox)).parts.find(x => x.startsWith('## ') && x.split('\n')[0].slice(3).trim() === lane.heading) || '';
  const n = lane.n, laneId = lane.id;
  try {
    const lock = SP.makePathLock(lockFile()).acquire(laneId, lane.touches);
    if (lock && lock.ok === false) throw new Error('its paths are held by another lane');
    // the retry asks the router like any lane start: the class rules hold (a code item is never re-run on a denied pair;
    // a hold throws, and the catch below hands the item back to the seat's main loop, where the router holds it too)
    const r = await start({ id: lane.seat, n, laneId, c, job: Object.assign({}, loop, { model: next.model, provider: next.provider }), it: { heading: lane.heading, text: sec, touches: lane.touches }, cfg: { timeoutMin: lane.timeoutMin } , routing: ctx && ctx.routing, log: say });
    r.retryOf = lane.runId; r.tried = [REF.keyOf(from)];
    st.lanes.push(r);
    REF.record({ root: S.root(), seat: lane.seat, door: 'lane', runId: lane.runId, retryRunId: r.runId, from, to: next });
    say('LANE RETRY ' + laneId + ': ' + REF.plainLine(from, next).replace('answered instead.', 'takes the lane instead') + ' (run ' + String(r.runId || '?').slice(0, 12) + ')');
  } catch (e) { try { SP.makePathLock(lockFile()).release(laneId); } catch (_) {} say('LANE RETRY ' + laneId + ' could not start: ' + String(e.message).slice(0, 160) + '; the item goes back to the seat\'s main loop'); }
}
/* reconcile(): every live lane is checked against the station; finished, timed-out and (hard halt) cut-off lanes end */
async function reconcile(st, jobs, ctx) {
  const now = S.now(); const hard = co.halted() === 'hard';
  for (const lane of st.lanes.slice()) {
    const job = (jobs || []).find(x => x && x.id === lane.jobId);
    const live = !!(job && (job.inFlight || job.state === 'running' || (lane.runId && job.inFlightRunId === lane.runId)));
    const ranAfter = job && job.lastRunAt && Date.parse(job.lastRunAt) >= Date.parse(lane.firedAt) - 2000;
    const ended = !job || (!live && (ranAfter || (lane.runId && job.lastRunId === lane.runId)));
    if (hard && !ended) await finish(st, lane, { why: 'halt', cancel: true }, ctx);
    else if (ended && lane.runId && REF.isRefusal(runRecord(lane.runId) || {})) await refused(st, lane, jobs, ctx);
    else if (ended) await finish(st, lane, { why: 'ended' }, ctx);
    else if (now - Date.parse(lane.startedAt) > lane.timeoutMin * 60000) await finish(st, lane, { why: 'timeout', cancel: true }, ctx);
    else if (!live && now - Date.parse(lane.firedAt) > 3 * 60000) await finish(st, lane, { why: 'lost', cancel: true }, ctx);
  }
  // a Lane line no live lane owns (a crash between marking and recording) is taken off, so the main loop takes the item
  const owned = new Set(st.lanes.filter(l => !l.piece).map(l => l.inbox + '\u0000' + l.heading));
  const ownedPiece = new Set(st.lanes.filter(l => l.piece).map(l => l.inbox + '\u0000' + l.heading + '\u0000' + l.piece));
  for (const c of Object.values(co.crew() || {})) {
    if (!c || !c.inbox) continue;
    for (const sec of sections(inboxPath(c.inbox)).parts) {
      if (!sec.startsWith('## ')) continue;
      const h = sec.split('\n')[0].slice(3).trim();
      if (LANE_LINE.test(sec) && !owned.has(c.inbox + '\u0000' + h)) { try { editSection(inboxPath(c.inbox), h, s => s.replace(LANE_LINE, '')); } catch (_) {} }
      for (const m of sec.matchAll(ANY_PIECE_LINE)) if (!ownedPiece.has(c.inbox + '\u0000' + h + '\u0000' + Number(m[1]))) { try { editSection(inboxPath(c.inbox), h, s => s.replace(pieceLine(m[1]), '')); } catch (_) {} }
    }
  }
}

/* ---------- the dispatcher hook ---------- */
async function dispatchHook(a) {
  a = a || {};
  let timer;
  const timeout = new Promise(res => { timer = setTimeout(() => res({ timeout: true }), Number(a.timeoutMs) > 0 ? Number(a.timeoutMs) : HOOK_TIMEOUT_MS); });
  let r;
  try { r = await Promise.race([hook(a).catch(e => { (a.log || (() => {}))('LANES ERROR: ' + String((e && e.message) || e).slice(0, 200)); return { error: true }; }), timeout]); }
  finally { clearTimeout(timer); }
  if (r && r.timeout && a.log) a.log('LANES TIMEOUT: no answer in ' + Math.round((Number(a.timeoutMs) || HOOK_TIMEOUT_MS) / 1000) + ' s; this tick starts no lane');
  return r || {};
}
async function hook(a) {
  const log = a.log || (() => {});
  const st = load();
  const sprint = a.sprint || null;
  const cfg = config(sprint);
  const crew = co.crew() || {}; const ceo = co.ceo();
  // fresh routines: the pacer and models.js may have moved the seats' models after dispatch.js read them
  let jobs = a.jobs || [], fresh = false;
  if (st.lanes.length || (sprint && cfg.perSeat > 1)) { try { const r = await S.call('GET', '/api/cron'); const v = r.status === 200 ? j(r) : null; if (v && Array.isArray(v.jobs)) { jobs = v.jobs; fresh = true; } } catch (_) {} }
  const snap = () => JSON.stringify([st.lanes, st.history, st.notes]); const before = snap();
  if (!a.dry && (fresh || !st.lanes.length)) await reconcile(st, jobs, a);   // never judge a lane ended on a routine list the station did not give
  const out = { started: [], held: [], skippedMain: [] };
  const SM = a.metrics || null;
  const loopOf = id => { const c = crew[id]; if (!c || !c.loop) return null; const hits = jobs.filter(x => x && (x.name === c.loop || String(x.name).startsWith(c.loop))); return hits.length === 1 ? hits[0] : null; };
  const laneCount = id => st.lanes.filter(l => l.seat === id).length;
  const possible = {};
  let station = null;
  if (sprint && cfg.perSeat > 1 && !co.halted()) {
    station = await probe();
    if (a.budget && a.budget.sprintBudgetLeft === undefined) { try { const ss = require('./cadence.js').sprintStatus(); a.budget.sprintBudgetLeft = Number.isFinite(Number(ss.budgetUsd)) && Number(ss.budgetUsd) > 0 ? Number(ss.budgetUsd) - (Number(ss.spentUsd) || 0) : null; } catch (_) { a.budget.sprintBudgetLeft = null; } }
    const noCap = [];
    const held = st.lanes.map(l => l.touches).flat();
    for (const id of a.order || Object.keys(crew)) {
      const c = crew[id]; if (!c || !c.inbox) continue;
      const isCeo = id === ceo;
      const { parts } = sections(inboxPath(c.inbox));
      const mine = new Set(st.lanes.filter(l => l.inbox === c.inbox).map(l => l.heading));   // its own lanes and piece lanes on its items
      const names = Object.fromEntries(Object.entries(crew).map(([k, v]) => [k, (v && v.name) || k]));
      const items = [];
      const notYet = new Set(String((((a.state || {}).agents || {})[id] || {}).deferred || '').split('|').filter(Boolean));
      for (const sec of parts) {
        if (!sec.startsWith('## ')) continue;
        const it = SP.parseItems(sec)[0]; if (!it || !it.open) continue;
        if (mine.has(it.heading)) continue;   // a live lane has it
        if (st.history.some(h => h.inbox === c.inbox && h.heading === it.heading)) continue;   // one lane per item: one that ended without finishing goes back to the main loop
        if (typeof SP.waitingOn === 'function' && SP.waitingOn(it.status, names, id, ceo)) continue;   // not actionable: waits on someone
        if (notYet.has(it.heading)) continue;   // set aside by its own **Not before:** (dispatch.js notBeforeDeferrals)
        items.push(Object.assign(it, { text: sec }));
      }
      const plan = SP.lanePlan(items, { lanes: Math.max(1, cfg.perSeat), isCeo, held });
      possible[id] = plan.lanes.length;
      if (isCeo || plan.lanes.length < 2) continue;
      if (!station.ok) { noCap.push((c.name || id) + ' (' + plan.lanes.length + ' independent)'); continue; }
      const job = loopOf(id);
      // the main loop's run may be working any of these items right now: lanes start only between its runs, and the
      // main loop fired later in this same tick sees the Lane line on what the lanes took
      const ow = job && SCHED.mode() === 'dispatcher' ? SCHED.readState(S.root()).owned[job.id] : null;   // paused on the station because the dispatcher starts it: not paused
      const hold = !job ? 'its loop routine was not found' : job.enabled === false && !(ow && ow.on !== false) ? 'its loop routine is paused (the pacer or the owner)' : (a.modes || {})[id] === 'ask' && !a.allowAsk ? 'its approval mode is "ask"'
        : job.inFlight || job.state === 'running' ? 'its main loop is running (lanes start between its runs)' : null;
      if (hold) { out.held.push(id + ': ' + hold); continue; }
      for (let k = 1; k < plan.lanes.length; k++) {
        if (laneCount(id) >= cfg.perSeat - 1) break;
        if (st.lanes.length >= cfg.maxLanesTotal) { out.held.push(id + ': the company is at its ' + cfg.maxLanesTotal + ' lanes'); break; }
        const money = moneyHold(job, a.budget, id);
        if (money) { out.held.push(id + ': ' + money); break; }
        const it = plan.lanes[k][0];
        if (a.dry) { log('WOULD start lane for ' + (c.name || id) + ': "' + it.heading + '"'); continue; }
        const tempo = require('./cadence.js').tempoAllows(id, S.now(), { record: true });
        if (!tempo.ok) { out.held.push(id + ': ' + tempo.reason); break; }
        const n = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(x => !st.lanes.some(l => l.seat === id && l.n === x));
        const laneId = id + '/' + n;
        const lock = SP.makePathLock(lockFile()).acquire(laneId, it.touches);
        if (!lock.ok) { out.held.push(id + ': ' + it.touches.join(', ') + ' is held by lane ' + lock.holder); continue; }   // a conflict waits
        try {
          const r = await start({ id, n, laneId, c, job, it, cfg, routing: a.routing || null, log });
          st.lanes.push(r); out.started.push(laneId); held.push(...it.touches);
          log('LANE START ' + laneId + ' (' + (c.name || id) + ', run ' + String(r.runId || '?').slice(0, 12) + ', ' + r.kind + (r.branch ? ' ' + r.branch : '') + ', ' + job.provider + '/' + job.model + '): "' + it.heading.slice(0, 100) + '" touches ' + it.touches.join(', '));
        } catch (e) {
          SP.makePathLock(lockFile()).release(laneId);
          log('LANE NOT STARTED ' + laneId + ' (' + (c.name || id) + '): ' + String(e.message).slice(0, 200));
          break;
        }
      }
    }
    // a station without patch 0012: no lane starts (it would wait 45 s on the workspace lease and fail), said once per change
    const pk = noCap.length ? noCap.join(', ') + ' could run in parallel, but ' + station.why : null;
    if (pk && st.notes.probe !== pk) log('SPRINT LANES held at 1: ' + pk);
    if (pk) st.notes.probe = pk; else delete st.notes.probe;
    const hk = out.held.join('; ');
    if (hk && st.notes.held !== hk) log('SPRINT LANES held: ' + hk);
    if (hk) st.notes.held = hk; else delete st.notes.held;
  }
  // narrow fan-out: the pieces of a lead's recorded split, one per lane, to its free workers (see the header)
  if (!co.halted()) { try { await pieceLanes(st, jobs, a, out, log, cfg); } catch (e) { log('PIECE LANES ERROR: ' + String((e && e.message) || e).slice(0, 200)); } }
  // the main loop is not woken for items only live lanes own
  for (const id of Object.keys(crew)) {
    const c = crew[id]; if (!c || !c.inbox || !a.order || !a.order.includes(id)) continue;
    const mine = new Set(st.lanes.filter(l => l.inbox === c.inbox).map(l => l.heading)); if (!mine.size) continue;
    const open = SP.parseItems(sections(inboxPath(c.inbox)).txt || '').filter(i => i.open);
    const other = open.filter(i => !mine.has(i.heading));
    const why = String((a.reason || {})[id] || '');
    const elsewhere = ((a.work || {})[id] || []).length || (a.ownerWake && a.ownerWake.has(id)) || (a.hiringWake && a.hiringWake.has(id)) || /artifact present/.test(why);
    if (!other.length && !elsewhere) { a.order.splice(a.order.indexOf(id), 1); out.skippedMain.push(id); }
  }
  if (out.skippedMain.length) { const k = out.skippedMain.join(','); if (st.notes.skipped !== k) log('LANES: main loop not woken for ' + out.skippedMain.map(id => (crew[id] || {}).name || id).join(', ') + ': every open item is owned by a live lane'); st.notes.skipped = k; } else delete st.notes.skipped;
  // the numbers Crew and Today show (sprint-metrics.json lanes, written by dispatch.js)
  if (SM && SM.lanes) for (const id of Object.keys(SM.lanes)) {
    const x = SM.lanes[id]; const live = st.lanes.filter(l => l.seat === id);
    x.max = id === ceo ? 1 : station && station.ok ? Math.max(1, cfg.perSeat) : 1;
    x.lanes = live.length; x.running = (x.running || 0) + live.length;
    x.live = live.map(l => ({ n: l.n, handoff: l.heading, since: l.startedAt, runId: l.runId, kind: l.kind, branch: l.branch }));
    if (possible[id] != null) x.possible = possible[id];
    x.why = id === ceo ? 'the CEO works one run at a time' : !sprint || cfg.perSeat < 2 ? 'one lane allowed (cadence.js sprint config --lanes N)' : station && !station.ok ? station.why : (out.held.find(h => h.startsWith(id + ': ')) || '').slice(id.length + 2) || x.why || null;
  }
  if (!a.dry && snap() !== before) save(st);
  return out;
}
/* the piece lanes (see the header): one tick's offers. Every check a lane has, plus the worker's own: on the lead's
   allowlist and team, free, its loop routine found and not paused or on "ask", its model allowed for the item's class. */
async function pieceLanes(st, jobs, a, out, log, cfg) {
  const C = require('./lib/consult'), D = require('./lib/departments');
  const cands = C.splitCandidates({ root: S.root() }).filter(x => x.fanout === 'lanes');
  if (!cands.length) return;
  const crew = co.crew() || {};
  const loopOf = id => { const c = crew[id]; if (!c || !c.loop) return null; const hits = jobs.filter(x => x && (x.name === c.loop || String(x.name).startsWith(c.loop))); return hits.length === 1 ? hits[0] : null; };
  let M = null; try { M = require('./lib/meetings'); } catch (_) {}
  const denied = (() => { let K = null; try { const R = require('./lib/routing'); const L = R.loadPolicy(S.root()); K = L ? R.knobs(L.policy) : null; } catch (_) {} return (cls, j) => (cls === 'code' && String(j.provider) === 'custom') || (K ? !require('./lib/routing').routeAllowed(cls, { provider: String(j.provider || ''), model: String(j.model || '') }, K) : false); })();
  for (const cand of cands) {
    const g = cand.delegation;
    const live = st.lanes.filter(l => l.piece && l.inbox === cand.file && l.heading === cand.heading);
    const done = new Set(st.history.filter(h => h.piece && h.inbox === cand.file && h.heading === cand.heading).map(h => h.piece));
    const todo = cand.pieces.filter(p => !live.some(l => l.piece === p.n) && !done.has(p.n));
    if (!todo.length) continue;
    const under = D.subtree(cand.lead, crew);
    const free = g.workers.filter(w => {
      if (!crew[w] || !under.has(w) || w === cand.lead) return false;
      if (st.lanes.some(l => l.seat === w)) return false;
      const j = loopOf(w); if (!j || j.inFlight || j.state === 'running' || j.enabled === false) return false;
      if ((a.modes || {})[w] === 'ask' && !a.allowAsk) return false;
      if (M && M.busy(w)) return false;
      return !denied(cand.class, j);
    });
    let room = Math.max(0, g.maxWorkers - live.length);
    for (const piece of todo) {
      if (!room || !free.length) break;
      if (st.lanes.length >= cfg.maxLanesTotal) { out.held.push(cand.lead + ': the company is at its ' + cfg.maxLanesTotal + ' lanes'); return; }
      const w = free[0], c = crew[w], job = loopOf(w);
      const money = moneyHold(job, a.budget, w);
      if (money) { out.held.push(w + ': ' + money); free.shift(); continue; }
      if (a.dry) { log('WOULD start piece ' + piece.n + ' of "' + cand.heading.slice(0, 80) + '" for ' + (c.name || w) + ' (split by ' + cand.leadName + ')'); free.shift(); room--; continue; }
      const tempo = require('./cadence.js').tempoAllows(w, S.now(), { record: true });
      if (!tempo.ok) { out.held.push(w + ': ' + tempo.reason); free.shift(); continue; }
      const n = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(x => !st.lanes.some(l => l.seat === w && l.n === x));
      const laneId = w + '/' + n;
      const lock = SP.makePathLock(lockFile()).acquire(laneId, piece.files);
      if (!lock.ok) { out.held.push(w + ': ' + piece.files.join(', ') + ' is held by lane ' + lock.holder); continue; }
      try {
        const r = await start({ id: w, n, laneId, c, job, it: { heading: cand.heading, id: cand.item, text: cand.text, touches: piece.files }, cfg: { timeoutMin: g.workerTimeoutMin }, routing: a.routing || null, log,
          piece, inbox: cand.file, lead: cand.leadName, split: { lead: cand.lead, split: cand.split } });
        st.lanes.push(r); out.started.push(laneId); free.shift(); room--;
        log('PIECE LANE START ' + laneId + ' (' + (c.name || w) + ', piece ' + piece.n + ' of "' + cand.heading.slice(0, 80) + '", split by ' + cand.leadName + ', ' + job.provider + '/' + job.model + ', ' + g.workerTimeoutMin + ' min): touches ' + piece.files.join(', '));
      } catch (e) {
        SP.makePathLock(lockFile()).release(laneId);
        log('PIECE LANE NOT STARTED ' + laneId + ' (' + (c.name || w) + '): ' + String(e.message).slice(0, 200));
        free.shift();
      }
    }
  }
}
async function start({ id, n, laneId, c, job, it, cfg, routing, log, piece, inbox, lead, split }) {
  const itemInbox = inbox || c.inbox;
  const place = placeOf(c, it.touches);
  const p = prepare(id, n, place);
  const b = j(await S.call('POST', '/api/projects/bless', { path: p.dir })) || {};
  const blessed = b.root ? (() => { try { return fs.realpathSync(b.root); } catch (_) { return b.root; } })() : null;
  if (!b.ok || blessed !== p.dir) throw new Error('the station did not bless ' + p.dir + ' as its own folder (' + (b.reason || 'blessed ' + (b.root || 'nothing')) + ')');
  try { const pf = rel('.starnet-data', 'workspaces', 'permissions.allow.json'); if (fs.existsSync(pf)) require('./provenance.js').wrote(pf, fs.readFileSync(pf), 'lanes.js'); } catch (_) {}
  // the name shares no word with the seat's loop or another lane: StarNet's mint gate answers a near-duplicate name of the
  // agent's routines with the EXISTING routine, and a removed routine's name is declined for that agent from then on
  // (HTTP 200 {ok:false, declined:true}); lib/station.js suffix() is the same unique-name mechanism the watchdog uses
  const ST = require('./lib/station');
  let name = 'Lane ' + ST.suffix(4);
  const prompt = promptFor({ name: c.name || id, id: laneId, heading: it.heading, inbox: itemInbox, text: it.text, touches: place.touches || it.touches, kind: place.kind, dir: p.dir, repo: p.repo, branch: p.branch, piece: piece || null, lead: lead || null });
  const body = { name, agentId: job.agentId || id, prompt, schedule: 'every 24h', enabled: false, workdir: p.dir, deliver: 'local', model: job.model, provider: job.provider,
    unattendedGrants: Array.isArray(job.unattendedGrants) ? job.unattendedGrants.slice() : [] };
  for (const k of ['skills', 'enabledToolsets', 'reasoningEffort']) if (job[k] != null) body[k] = job[k];
  // a decline or a duplicate answer is not a lane routine; created only when GET /api/cron lists it (one retry, new name)
  const made = await ST.createRoutine((m, u, b) => S.call(m, u, b), body, { what: 'POST /api/cron (lane routine)', rename: () => 'Lane ' + ST.suffix(4) });
  if (!made.ok) throw new Error('the lane routine was not created: ' + made.tries.join('; '));
  name = made.name; const cr = { job: made.job };
  const firedAt = S.now();
  const tk = A.admit({ door: 'lane', kind: 'run', seat: id, jobId: cr.job.id, why: 'lane ' + laneId + ': ' + (piece ? 'piece ' + piece.n + ' of ' : '') + it.heading });   // phase 1: always allow, recorded
  // the router (lib/routing.js), exactly as for a wake: decided and recorded with a policy, applied only when live and open
  const W = require('./lib/wakes'), RT = require('./lib/routing');
  const wakeId = W.newWakeId(S.now());
  const route = routing ? RT.forWake(routing, { seat: id, wakeId, job: Object.assign({}, job, cr.job), items: [{ text: it.text || '' }] }) : null;
  { const rl = RT.line(id, route); if (rl && log) log(rl + ' [lane ' + laneId + ']'); }
  const drop = async () => { await ST.cron(S.call, 'POST', '/api/cron/remove', { id: cr.job.id }, 'remove lane routine'); if (place.kind === 'worktree') { try { git(place.repo, ['worktree', 'remove', '--force', p.dir]); git(place.repo, ['branch', '-D', p.branch]); } catch (_) {} } };
  // the class rules always hold: the seat's pair is denied for this item's class and no allowed entry is open: not started
  if (route && route.hold) {
    RT.record(routing, { wakeId, seat: id, door: 'lane', jobId: cr.job.id, runId: null, status: 'held', route });
    A.started(tk, { status: 0 });   // the admitted start never went out
    await drop();
    throw new Error('held by the class rules: ' + route.holdWhy);
  }
  let f = await S.fire(cr.job.id, RT.overrideOf(route));
  if (route && route.applied && f.status === 403 && route.chainDenied) {   // refused, and the chain is denied for the class: never run on it
    route.reasons.push('the station refused the override (HTTP 403 ' + String(f.body).slice(0, 120) + '); the chain is denied (' + route.chainDenied + '): held');
    route.applied = false; route.hold = true; route.holdWhy = 'the station refused the override and the class rules deny the chain (' + route.chainDenied + ')';
  } else if (route && route.applied && f.status === 403) {   // the station's gate refused it: the lane runs on the seat's model, as without one
    route.reasons.push('the station refused the override (HTTP 403 ' + String(f.body).slice(0, 120) + '); ran on the chain');
    route.wouldApply = { source: route.source, provider: route.provider, model: route.model }; route.applied = false; route.source = 'chain';
    route.provider = job.provider || null; route.model = job.model || null; delete route.effort; delete route.trial; delete route.arm;
    f = await S.fire(cr.job.id);
  }
  A.started(tk, f);
  if (route) RT.record(routing, { wakeId, seat: id, door: 'lane', jobId: cr.job.id, runId: f.runId || null, status: f.status, route });
  // run-to-item link (lib/wakes.js): a lane is one wake for one item
  if (f.status === 200) W.record({ wakeId, seat: id, runId: f.runId || null, admitId: tk.id, jobId: cr.job.id, door: 'lane', items: [{ file: itemInbox, id: W.itemId(itemInbox, it.heading, it.id), title: it.heading, due: null }], why: 'lane ' + laneId + (piece ? ' piece ' + piece.n : ''), route: route || undefined,
    split: piece ? { item: W.itemId(itemInbox, it.heading, it.id), piece: piece.n, lead: split && split.lead, split: split && split.split } : undefined }, { file: rel('company', 'state', 'wakes.jsonl') });
  if (f.status !== 200) { await drop(); throw new Error('the station refused the run: HTTP ' + f.status + ' ' + String(f.body).slice(0, 120)); }
  const lane = { id: laneId, seat: id, n, heading: it.heading, inbox: itemInbox, touches: it.touches, jobId: cr.job.id, jobName: name, runId: f.runId || null,
    firedAt: iso(firedAt), startedAt: iso(firedAt), timeoutMin: cfg.timeoutMin, dir: p.dir, kind: place.kind, why: place.why || null, repo: p.repo, branch: p.branch, base: p.base,
    provider: job.provider || null, model: job.model || null };
  if (piece) {
    Object.assign(lane, { piece: piece.n, pieceTitle: piece.title, lead: split && split.lead, leadName: lead || null, item: W.itemId(itemInbox, it.heading, it.id), split: split && split.split });
    markPiece(inboxPath(itemInbox), it.heading, piece.n, (c.name || id) + ', lane ' + n + ', run ' + (lane.runId || 'starting') + ', since ' + lane.startedAt + ' (' + piece.title + ')');
  } else markLane(inboxPath(c.inbox), it.heading, n + ', run ' + (lane.runId || 'starting') + ', since ' + lane.startedAt + ' (a parallel lane owns this item: the main loop does not work or edit it)');
  return lane;
}

/* hard halt (halt.js hard): every live lane is cut off now; its lock is released and its handoff told */
async function cutOff(o) {
  const st = load(); if (!st.lanes.length) return { cut: 0 };
  let jobs = []; try { const r = await S.call('GET', '/api/cron'); jobs = (j(r) || {}).jobs || []; } catch (_) {}
  const n = st.lanes.length;
  for (const lane of st.lanes.slice()) await finish(st, lane, { why: 'halt', cancel: true }, { log: (o && o.log) || (() => {}) });
  save(st); return { cut: n, jobs: jobs.length };
}
/* for locked-watch: a lane routine is the seat's own (same agent, the same Commander-only fields as its loop, its
 * folder under company/work/lanes/<seat>/), so it is recognised as the seat's and never flagged as a new routine. */
function isLaneJob(job, jobs, root) {
  if (!job || !/^Lane [0-9a-f]{8}$/.test(String(job.name || ''))) return false;
  const crew = co.crew() || {}; const seat = Object.keys(crew).find(id => id === job.agentId); if (!seat) return false;
  const c = crew[seat]; const loop = (jobs || []).find(x => x && x.id !== job.id && x.agentId === job.agentId && c.loop && (x.name === c.loop || String(x.name).startsWith(c.loop)));
  if (!loop) return false;
  const same = k => JSON.stringify(job[k] == null ? null : job[k]) === JSON.stringify(loop[k] == null ? null : loop[k]);
  const under = String(job.workdir || '').startsWith(path.join(fs.realpathSync(root || S.root()), 'company', 'work', 'lanes', seat) + path.sep);
  return under && ['agentId', 'skills', 'script', 'contextFrom', 'noAgent', 'enabledToolsets'].every(same) && JSON.stringify((job.unattendedGrants || []).slice().sort()) === JSON.stringify((loop.unattendedGrants || []).slice().sort());
}
function view() { const st = load(); return { lanes: st.lanes.map(l => ({ id: l.id, seat: l.seat, n: l.n, handoff: l.heading, since: l.startedAt, runId: l.runId, kind: l.kind, branch: l.branch, timeoutMin: l.timeoutMin })), history: st.history.slice(-10).reverse(), probe: st.notes.probe || null, held: st.notes.held || null }; }

module.exports = { dispatchHook, cutOff, isLaneJob, view, load, config, probe, promptFor, placeOf, writesCode, markLane, reportLane, markPiece, reportPiece, pieceLanes, CAPABILITY, DEFAULTS, S };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  (async () => {
    if (a[0] === 'status' || !a[0]) {
      const v = view(); const p = await probe().catch(() => ({ ok: false, why: 'station unreadable' }));
      if (a.includes('--json')) return console.log(JSON.stringify(Object.assign({ station: p }, v), null, 1));
      console.log('station: ' + (p.ok ? 'lanes allowed (patch 0012)' : 'no lanes — ' + p.why));
      console.log(v.lanes.length ? v.lanes.map(l => 'LIVE ' + l.id + ' since ' + l.since + ' run ' + (l.runId || '?') + ' (' + l.kind + (l.branch ? ' ' + l.branch : '') + '): ' + l.handoff).join('\n') : 'no live lanes');
      for (const h of v.history) console.log('ended ' + h.id + ' ' + h.endedAt + ' ' + h.outcome + ': ' + h.heading);
      return;
    }
    if (a[0] === 'end') {
      const by = opt('by'); if (!a[1] || !by) { console.error('usage: lanes.js end <seat>/<n> --by <name> [--why "…"]'); process.exit(2); }
      const st = load(); const lane = st.lanes.find(l => l.id === a[1]); if (!lane) { console.error('no live lane ' + a[1]); process.exit(1); }
      await finish(st, lane, { why: 'ended by ' + by + (opt('why') ? ': ' + opt('why') : ''), cancel: true }, { log: l => console.log(l) }); save(st); return;
    }
    console.error('commands: status [--json] | end <seat>/<n> --by <name>'); process.exit(2);
  })().catch(e => { console.error('lanes: ' + e.message); process.exit(1); });
}
