#!/usr/bin/env node
/* corrections.js — 1-on-1s: a short, written correction for a habit that keeps coming back, shown to that person on
 * every routine run until it has stayed fixed.
 *
 * Design: corrections are for HABITUAL issues only (the same thing twice or more),
 * per person, written down, shown on every run, small, and self-cleaning. If one does not stick, it goes once to the
 * tool owner as a request for a mechanical gate. A correction is the remedy, never a second punishment: this tool
 * never writes a competence demerit or a performance flag. Plain-words process: company/work/people/ONE-ON-ONES.md.
 *
 *   node company/tools/corrections.js tick [--dry-run] [--json]   detect, activate, record recurrences, escalate, retire
 *   node company/tools/corrections.js list [--agent <id>] [--all]
 *   node company/tools/corrections.js show <id>
 *   node company/tools/corrections.js block <agentId>             print the block that person's routine prompts carry
 *   node company/tools/corrections.js add <agentId> --title "…" --rule "…" --instead "…" --example "…" --evidence "…" --by <Name> [--class <slug>]
 *   node company/tools/corrections.js edit <id> --by <Name> [--title "…"] [--rule "…"] [--instead "…"] [--example "…"]
 *   node company/tools/corrections.js recur <id> --by <Name> --evidence "…"   the habit happened again (manual corrections)
 *   node company/tools/corrections.js retire <id> --by <Name> [--reason "…"]
 *   node company/tools/corrections.js selftest
 *
 * Who may add, edit, record or retire by hand: the person's manager, or the holder of the `people` function. When the
 * manager is the CEO, the people owner alone (the CEO is not bothered with people matters). --by is a claim this tool records; it is NOT cryptographically
 * verified (everyone runs as the same Unix user), so the log keeps who claimed what.
 *
 * Detectors (deterministic, no model calls; each counts only what happened after its rule took effect, see the policy):
 *   long-wait               a routine run ASKED shell_bg_wait for a timeoutMs above 240000 (the rule's own words; read
 *                           from the transcript arguments) and the wait really ran that long (house rules v1).
 *                           A wait that runs out measures a few ms over its request, so a legal 240000 wait that
 *                           measures 240003 never counts; without the arguments, only a wait over 240 s + toleranceMs
 *   absolute-path-write     a routine run that works in the company root gave fs_write/fs_edit/fs_append/fs_patch a
 *                           path under the company root's absolute path (run summaries, and the transcript arguments
 *                           for fs_patch: Add/Update/Delete/Move headers, parsed as loosely as StarNet's own parser)
 *   quest-without-domain    a quest minted with no domain; the minter is the run whose mint call names the quest
 *                           (createdBy defaults to the quest's OWNER, so it is used only when it names someone else)
 *   repeat-flag-<type>      the same performance flag type twice for one person (from the dispatch log); refusal and
 *                           limit flags are model or limit problems, not habits, and never count
 *   competence-<bucket>     flaws in one skill bucket: a hook that stays off until the competence shadow period ends
 * A pattern is recurring at `threshold` occurrences (default 2) within windowDays (14). One occurrence = one run (or one
 * quest, or one flag). One active correction per person per class, at most maxActivePerPerson (5) per person.
 * Every active correction is shown: each line of the block gets an equal share of maxBlockChars (about 215 characters
 * with the defaults), so all five always fit. A hand-written line longer than that is refused; a correction that still
 * cannot be shown (a policy changed under it) is never counted as a recurrence and never escalated.
 *
 * Files: company/work/people/corrections-policy.json (numbers and dates), company/work/people/corrections/<agentId>.json
 * (the store), company/work/people/corrections/README.md (per-person summary), company/work/people/corrections-log.jsonl
 * (append-only history), company/state/corrections-state.json (parsed flag history and a transcript lookup cache).
 * Wiring: the dispatcher calls tick() once per tick; routine-rules.js ensure() calls blockFor() for every routine.
 * Owner of this tool: the `tools` function holder. Owner of the process: the `people` function holder (loops.json
 * seat.functions, read through lib/company.js). Times shown to people are company time (company.json timezone).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const DEFAULT_ROOT = co.ROOT;

const START = '[YOUR STANDING CORRECTIONS]';
const END = '[END STANDING CORRECTIONS]';
const HEADER = 'Habits that came up in your 1-on-1s. Follow each one on this run.';
const FILE_TOOLS = new Set(['fs_write', 'fs_edit', 'fs_append', 'fs_patch']);
const ACTIVE = new Set(['active', 'escalated']);
const FALLBACK_DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
const TOOL_NAME = 'Corrections';

const DEFAULT_POLICY = {
  version: 1,
  liveSince: null,   // null = from the beginning; founding sets it to the day the company starts
  utcOffsetMinutes: null,   // null = the company timezone (company.json); a number pins a fixed offset
  companyRoot: null,
  windowDays: 14,
  retireAfterCleanDays: 14,
  escalateAfterRecurrences: 2,
  escalationDeadlineDays: 3,
  maxActivePerPerson: 5,
  maxBlockChars: 1200,
  exemptAgents: [],
  classes: {
    'long-wait': { enabled: true, since: null, threshold: 2, routineOnly: true, maxWaitMs: 240000, toleranceMs: 5000 },
    'absolute-path-write': { enabled: true, since: null, threshold: 2, routineOnly: true, rootOnly: true },
    'quest-without-domain': { enabled: true, since: null, threshold: 2, routineOnly: true },
    'repeat-performance-flag': { enabled: true, since: null, threshold: 2, excludeTypes: ['refusal', 'limit'] },
    'competence-flaw': { enabled: false, notBefore: null, threshold: 2 },
  },
};

/* ---------------- built-in correction texts (plain words; one line each in the prompt) ---------------- */
function builtinText(cls, ctx) {
  const root = companyRoot(ctx);
  if (cls === 'long-wait') return {
    title: 'Long waits on background jobs',
    rule: 'Never give shell_bg_wait a timeoutMs above 240000.',
    doInstead: 'wait in steps of 240000 ms or less; for a longer job, log under scratch/ and hand off.',
    example: 'shell_bg_wait timeoutMs 120000, check, wait again.',
    gate: 'make the station clamp or refuse a shell_bg_wait timeoutMs above 240000 in routine runs, with an error that says why',
  };
  if (cls === 'absolute-path-write') return {
    title: 'Absolute paths in file tools',
    rule: 'Never give fs_write, fs_edit, fs_append or fs_patch a path starting ' + root + '/.',
    doInstead: 'use the path relative to the company root.',
    example: 'company/work/handoffs/to-founder.md',
    gate: 'make the station rewrite or refuse a file-tool path under ' + root + '/ in routine runs (starnet/sidecar/pathtrust.js), so the write never snapshots the whole disk',
  };
  if (cls === 'quest-without-domain') return {
    title: 'Quests minted without a domain',
    rule: 'Every quest you mint needs a domain.',
    doInstead: 'add "domain" with one of: ' + domains(ctx).join(', ') + '.',
    example: '"domain":"operations" in the /api/quests/mint body.',
    gate: 'make /api/quests/mint refuse a quest with no domain (or default it from the person\'s role), and add "domain" to the mint example in the routine prompts that company/tools/hire.js writes',
  };
  if (cls.startsWith('repeat-flag-')) {
    const type = cls.slice('repeat-flag-'.length);
    const t = {
      failing: { title: 'Runs that do not finish (flagged twice)', rule: 'Finish every run with a final reply.',
        doInstead: 'save as you go, start nothing new after minute 60, and end by 75; if blocked, write a handoff and end.',
        example: 'at 60 min: write the log entry and handoffs, then stop.' },
      unreliable: { title: 'Many unfinished runs (flagged twice)', rule: 'Stop leaving runs unfinished.',
        doInstead: 'take one small piece you can finish in this run, and write where you stopped and what comes next.',
        example: 'in your log: stopped after step 2 of 4; next, draft section 3.' },
      overdue: { title: 'Handoffs past their deadline (flagged twice)', rule: 'Do not let handoffs to you pass their deadline.',
        doInstead: 'answer or close each OPEN handoff by its deadline; if you cannot, write back with a new date.',
        example: 'reply: need until Tuesday, waiting on the review.' },
    }[type] || { title: 'Repeated performance flag: ' + type, rule: 'The same performance flag (' + type + ') came up twice.',
      doInstead: 'read what it measures in company/work/performance.md and fix that first.',
      example: 'start by checking the flag\'s reason line.' };
    return Object.assign({ gate: 'find what makes this keep happening (a tool, permission, limit or prompt problem) and fix that cause mechanically' }, t);
  }
  if (cls.startsWith('competence-')) {
    const bucket = cls.slice('competence-'.length);
    return { title: 'Repeated flaws in ' + bucket + ' work', rule: 'Others found flaws in your ' + bucket + ' work more than once.',
      doInstead: 'get an independent review before you call it done; check the last flaw\'s fix is in.',
      example: '"Reviewer: <name>" in the delivering handoff.', gate: 'a check in the merge or review gate that catches this kind of flaw before acceptance' };
  }
  return null;
}
function textFor(cls, ctx) {
  const base = builtinText(cls, ctx);
  const cfg = classConfig(ctx, cls);
  const o = cfg && cfg.text && typeof cfg.text === 'object' ? cfg.text : {};
  return base ? Object.assign({}, base, pick(o, ['title', 'rule', 'doInstead', 'example', 'gate'])) : null;
}

/* ---------------- context, policy, crew ---------------- */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const pick = (o, keys) => Object.fromEntries(keys.filter(k => typeof o[k] === 'string' && o[k].trim()).map(k => [k, o[k]]));
function context(opts) {
  opts = opts || {};
  const root = path.resolve(opts.root || process.env.CORRECTIONS_ROOT || DEFAULT_ROOT);
  const P = rel => path.join(root, rel);
  const ctx = {
    root, now: Number.isFinite(opts.now) ? opts.now : Date.now(),
    paths: {
      policy: P('company/work/people/corrections-policy.json'), dir: P('company/work/people/corrections'),
      readme: P('company/work/people/corrections/README.md'), log: P('company/work/people/corrections-log.jsonl'),
      state: P('company/state/corrections-state.json'), lock: P('company/state/corrections.lock'),
      loops: P('company/tools/loops.json'), runs: P('.starnet-data/workspaces/runs.jsonl'),
      transcripts: P('.starnet-data/workspaces/transcript-history-v2'), dispatchLog: P('company/work/dispatch-log.md'),
      handoffs: P('company/work/handoffs'), competence: P('company/work/people/competence-events.jsonl'),
      competencePolicy: P('company/competence-policy.json'), journey: P('starnet/sidecar/journey-store.js'),
    },
  };
  ctx.policy = loadPolicy(ctx);
  ctx.crew = loadCrew(ctx);
  return ctx;
}
function loadPolicy(ctx) {
  const f = readJson(ctx.paths.policy, {}) || {};
  const p = Object.assign({}, DEFAULT_POLICY, f);
  p.classes = {};
  for (const k of new Set(Object.keys(DEFAULT_POLICY.classes).concat(Object.keys(f.classes || {})))) {
    p.classes[k] = Object.assign({}, DEFAULT_POLICY.classes[k] || {}, (f.classes || {})[k] || {});
  }
  return p;
}
function loadCrew(ctx) {
  const agents = (readJson(ctx.paths.loops, {}) || {}).agents || {};
  // seats are found by function (seat.functions, or the legacy hr/toolsOwner flags), never by name; this reads the
  // loops.json under ctx.root so the selftest can use its own crew
  const ceoE = Object.entries(agents).find(([, c]) => co.holds(c, 'ceo')) || Object.entries(agents).find(([, c]) => c && c.manager == null);
  const ceoId = ceoE ? ceoE[0] : null;
  const rowBy = fn => { const e = Object.entries(agents).find(([, c]) => co.holds(c, fn)) || (ceoId ? [ceoId, agents[ceoId]] : null); return e ? Object.assign({ id: e[0] }, e[1]) : null; };
  return { agents, people: rowBy('people'), tools: rowBy('tools'), ceoId };
}
function classConfig(ctx, cls) {
  const C = ctx.policy.classes;
  if (C[cls]) return C[cls];
  if (cls.startsWith('repeat-flag-')) return C['repeat-performance-flag'];
  if (cls.startsWith('competence-')) return C['competence-flaw'];
  return null;
}
const detectorOf = cls => cls.startsWith('repeat-flag-') ? 'repeat-performance-flag' : cls.startsWith('competence-') ? 'competence-flaw' : cls;
const companyRoot = ctx => String(ctx.policy.companyRoot || ctx.root).replace(/\/+$/, '');
const tms = v => { const t = v == null ? NaN : (typeof v === 'number' ? v : Date.parse(v)); return Number.isFinite(t) ? t : NaN; };
function sinceOf(ctx, cls) { const c = classConfig(ctx, cls) || {}; const s = tms(c.since); return Number.isFinite(s) ? s : (tms(ctx.policy.liveSince) || 0); }
function domains(ctx) {
  try { const m = fs.readFileSync(ctx.paths.journey, 'utf8').match(/const DOMAINS\s*=\s*\[([^\]]*)\]/); if (m) { const d = [...m[1].matchAll(/'([a-z]+)'|"([a-z]+)"/g)].map(x => x[1] || x[2]); if (d.length) return d; } } catch (_) {}
  return FALLBACK_DOMAINS;
}
// minutes east of UTC at that instant: the policy's fixed utcOffsetMinutes when it sets one, else the company timezone
function offsetMin(ms, ctx) {
  const pinned = ctx.policy.utcOffsetMinutes;
  if (pinned != null && Number.isFinite(Number(pinned))) return Number(pinned);
  const t = Math.floor(ms / 60000) * 60000, lp = co.localParts(new Date(t));
  const [y, mo, d] = lp.date.split('-').map(Number);
  return Math.round((Date.UTC(y, mo - 1, d, lp.hour, lp.minute) - t) / 60000);
}
function local(ms, ctx) {   // company time, for people to read
  const o = offsetMin(ms, ctx);
  const d = new Date(ms + o * 60000).toISOString().slice(0, 19);
  const sign = o >= 0 ? '+' : '-', a = Math.abs(o);
  return d + sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
const stamp = (ms, ctx) => local(ms, ctx).slice(0, 16).replace('T', ' ');
const nameOf = (ctx, id) => ((ctx.crew.agents[id] || {}).name) || id;
const safeId = id => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw new Error('bad agent id: ' + id); return String(id); };
const oneLine = (s, n) => String(s == null ? '' : s).replace(/[\[\]]/g, m => (m === '[' ? '(' : ')')).replace(/\s+/g, ' ').trim().slice(0, n);
const sentence = s => { const t = String(s || '').trim(); return !t ? t : /[.!?:"')]$/.test(t) ? t : t + '.'; };
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/* ---------------- store ---------------- */
const personFile = (ctx, id) => path.join(ctx.paths.dir, safeId(id) + '.json');
function loadPerson(ctx, id) {
  const r = readJson(personFile(ctx, id), null);
  return r && Array.isArray(r.corrections) ? r : { agentId: id, name: nameOf(ctx, id), corrections: [] };
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  try { require('./provenance.js').wrote(file, text, 'corrections.js'); } catch (_) {}   // locked-watch.js: this tool's own write
}
function savePerson(ctx, rec) { rec.name = nameOf(ctx, rec.agentId); rec.updatedAt = local(ctx.now, ctx); writeAtomic(personFile(ctx, rec.agentId), JSON.stringify(rec, null, 1) + '\n'); }
function allPeople(ctx) {
  let files = []; try { files = fs.readdirSync(ctx.paths.dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)); } catch (_) {}
  return files.map(f => loadPerson(ctx, f.slice(0, -5)));
}
function findCorrection(ctx, id) {
  const m = /^([A-Za-z0-9_-]+)-c\d+$/.exec(String(id || ''));
  if (!m) return null;
  const rec = loadPerson(ctx, m[1]);
  const c = rec.corrections.find(x => x.id === id);
  return c ? { rec, c } : null;
}
function appendLog(ctx, ev) { fs.mkdirSync(path.dirname(ctx.paths.log), { recursive: true }); const line = JSON.stringify(Object.assign({ at: local(ctx.now, ctx) }, ev)) + '\n'; fs.appendFileSync(ctx.paths.log, line); try { require('./provenance.js').appended(ctx.paths.log, line, 'corrections.js'); } catch (_) {} }
function withLock(ctx, waitMs, fn) {
  fs.mkdirSync(path.dirname(ctx.paths.lock), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { const fd = fs.openSync(ctx.paths.lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(ctx.paths.lock).mtimeMs > 120000) { fs.unlinkSync(ctx.paths.lock); continue; } } catch (_) { continue; }
      if (Date.now() >= until) throw new Error('corrections store is busy (lock ' + path.relative(ctx.root, ctx.paths.lock) + ')');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);   // sleep 100 ms
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(ctx.paths.lock); } catch (_) {} }
}
const activeOf = rec => rec.corrections.filter(c => ACTIVE.has(c.status));
function nextId(rec) { let n = 0; for (const c of rec.corrections) { const m = /-c(\d+)$/.exec(c.id || ''); if (m) n = Math.max(n, Number(m[1])); } return rec.agentId + '-c' + (n + 1); }

/* ---------------- prompt block ---------------- */
function fullLine(c) { return '- ' + sentence(oneLine(c.rule, 200)) + ' Instead: ' + sentence(cap(oneLine(c.doInstead, 200))) + ' Example: ' + oneLine(c.example, 160); }   // no period after the example: it may be a path
// Each correction line gets an equal share of the block, so maxActivePerPerson lines always fit in maxBlockChars and no
// active correction is ever left out (about 215 characters with the defaults). 0 = no usable share (a tiny limit).
function lineBudget(ctx) {
  const max = Number(ctx.policy.maxBlockChars) || 1200, n = Math.max(1, Number(ctx.policy.maxActivePerPerson) || 5);
  const b = Math.floor((max - (START.length + HEADER.length + END.length + 2)) / n) - 1;   // the fixed lines with their newlines; each line takes one more
  return b >= 60 ? b : 0;
}
// a line over its share (only a policy text or a changed limit can make one) is cut, never dropped
function lineOf(c, budget) { const l = fullLine(c); return budget > 0 && l.length > budget ? l.slice(0, budget - 1).replace(/\s+$/, '') + '…' : l; }
function renderInfo(ctx, rec, opts) {
  opts = opts || {};
  const list = activeOf(rec).filter(c => !(opts.companyRoot === false && c.rootOnly)).sort((a, b) => tms(a.at) - tms(b.at) || String(a.id).localeCompare(String(b.id)));
  if (!list.length) return { text: '', shown: [], hidden: [] };
  const max = Number(ctx.policy.maxBlockChars) || 1200, budget = lineBudget(ctx);
  const lines = list.map(c => lineOf(c, budget));
  const build = (ls, more) => [START, HEADER].concat(ls, more ? ['- (' + more + ' more in company/work/people/corrections/' + rec.agentId + '.json)'] : [], [END]).join('\n');
  // last resort, only when more corrections are active than the policy allows now or the limit is tiny: drop the newest
  let keep = lines.length, out = build(lines, 0);
  while (out.length > max && keep > 0) { keep--; out = build(lines.slice(0, keep), lines.length - keep); }
  if (out.length > max) { out = build([], lines.length).slice(0, max - END.length - 1) + '\n' + END; keep = 0; }
  return { text: out, shown: list.slice(0, keep).map(c => c.id), hidden: list.slice(keep).map(c => c.id) };
}
const renderBlock = (ctx, rec, opts) => renderInfo(ctx, rec, opts).text;
// What a dry-run tick would change, so a dry ensure() in the same process (dispatch.js --dry-run) shows the prompt
// updates those changes would cause. Only blockFor(id, { dry: true }) reads it; a real tick clears it.
let DRY_VIEW = null;
// The block for one person's routine prompts ('' when they have none). routine-rules.js ensure() calls this on every tick.
function blockFor(agentId, opts) {
  opts = opts || {};
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(agentId || ''))) return '';
  const ctx = context({ root: opts.root });
  if (opts.dry === true && DRY_VIEW && DRY_VIEW.root === ctx.root && DRY_VIEW.recs.has(agentId)) return renderBlock(ctx, DRY_VIEW.recs.get(agentId), opts);
  if (!fs.existsSync(personFile(ctx, agentId))) return '';
  return renderBlock(ctx, loadPerson(ctx, agentId), opts);
}

/* ---------------- sources ---------------- */
const RUNS_WINDOW_DAYS = 60;   // detectors look back days, not months; older runs are never re-read
function readRuns(ctx) {
  fs.statSync(ctx.paths.runs);   // throws when missing: the run detectors then report not-ok
  // the last RUNS_WINDOW_DAYS only, read from the end (lib/bounded.js): runs.jsonl is StarNet's and only grows
  const txt = require('./lib/bounded').jsonlWindowText(ctx.paths.runs, (ctx.now || Date.now()) - RUNS_WINDOW_DAYS * 86400e3);
  const out = [];
  for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l); if (r && r.runId && r.agentId) out.push(r); } catch (_) {} }
  return out;
}
function segmentFiles(ctx, fromMs) {
  const dir = ctx.paths.transcripts;
  let files; try { files = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort(); } catch (_) { return null; }
  const man = readJson(path.join(dir, 'manifest.json'), {}) || {};
  const range = new Map((man.segments || []).map(s => [s.file, s]));
  return files.filter(f => { const s = range.get(f); return !s || !Number.isFinite(Number(s.maxTs)) || Number(s.maxTs) >= fromMs; }).map(f => path.join(dir, f));
}
// one pass over the transcript rows that hold tool calls; visit(row, call, argsObject) for calls whose raw line has `needle`
function scanTranscripts(ctx, fromMs, needle, visit) {
  const files = segmentFiles(ctx, fromMs);
  if (!files) return false;
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const l of txt.split('\n')) {
      if (!l || !l.includes(needle) || !l.includes('toolCalls')) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.toolCalls || !(Number(r.ts) >= fromMs)) continue;
      let calls; try { calls = typeof r.toolCalls === 'string' ? JSON.parse(r.toolCalls) : r.toolCalls; } catch (_) { continue; }
      for (const tc of Array.isArray(calls) ? calls : []) {
        const fn = (tc && tc.function) || {};
        let a = fn.arguments; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = { _raw: a }; } }
        visit(r, tc, fn.name, a || {});
      }
    }
  }
  return true;
}
// every path a file-tool call names: its path argument, and each header of a V4A patch, matched as loosely as StarNet's
// own parser (starnet/sidecar/artifacts.js patchWrites: any spacing, CRLF, "Move to:" and "Move File: a -> b")
const pathsInArgs = a => {
  const out = [];
  if (a && typeof a.path === 'string') out.push(a.path);
  if (a && typeof a.patch === 'string') {
    for (const line of a.patch.replace(/\r\n?/g, '\n').split('\n')) {
      let m;
      if ((m = /^\*\*\*\s*(?:Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line)) || (m = /^\*\*\*\s*Move to:\s*(.+?)\s*$/.exec(line))) out.push(m[1]);
      else if ((m = /^\*\*\*\s*Move File:\s*(.+?)\s*->\s*(.+?)\s*$/.exec(line))) out.push(m[1], m[2]);
    }
  }
  return out;
};
function routineName(env, r) { const j = (env.jobs || []).find(x => x && x.id === r.cronJobId); return j ? j.name : 'routine'; }
// does this run's routine work in the company root? Unknown routines (deleted, or the station did not answer) count as yes.
// The same test routine-rules.js uses to decide whether a routine carries a rootOnly correction.
function worksInRoot(ctx, env, r) {
  const j = (env.jobs || []).find(x => x && x.id === r.cronJobId);
  return !j || path.resolve(String(j.workdir || '')) === path.resolve(companyRoot(ctx));
}
const isRoutine = r => !!r.cronJobId;
const inCrew = (ctx, id) => !!ctx.crew.agents[id] && !(ctx.policy.exemptAgents || []).includes(id);

/* ---------------- detectors ---------------- */
function detectLongWait(ctx, env) {
  const cls = 'long-wait', cfg = classConfig(ctx, cls), since = sinceOf(ctx, cls), lim = Number(cfg.maxWaitMs) || 240000;
  const tol = Number.isFinite(Number(cfg.toleranceMs)) && cfg.toleranceMs !== null ? Number(cfg.toleranceMs) : 5000;
  // The rule limits what a run ASKS for ("never call shell_bg_wait with timeoutMs above 240000"). A wait that runs out
  // measures a few ms over its request (240000 -> 240003), so the requested timeout from the transcript decides; only
  // when the arguments cannot be found does the measured time decide, with a tolerance. Either way the wait must also
  // really have run longer than the limit (a 300000 request that returned after 239 s did no harm and does not count).
  const cache = env.state.argCache = env.state.argCache || {};
  const ck = (r, t) => 'wait:' + r.runId + ':' + t.callId;
  const long = t => t && t.name === 'shell_bg_wait' && Number(t.ms) > lim;
  const runs = env.runs.filter(r => inCrew(ctx, r.agentId) && (!cfg.routineOnly || isRoutine(r)));
  const lookFrom = ctx.now - (Number(ctx.policy.windowDays) + 1) * 86400e3;
  const want = new Map();   // runId:callId -> { at, settled } for long waits after the rule whose request is not known yet
  for (const r of runs) {
    if (!(Number(r.startedAt) >= since) || !(Number(r.startedAt) >= lookFrom)) continue;
    for (const t of r.toolTrace || []) if (long(t) && t.callId && !(ck(r, t) in cache)) want.set(r.runId + ':' + t.callId, { at: Number(t.startedAt) || Number(r.startedAt), settled: ctx.now - Number(r.endedAt || r.startedAt) > 600e3 });
  }
  if (want.size) {
    const scanned = scanTranscripts(ctx, Math.min(...[...want.values()].map(w => w.at)) - 3600e3, 'shell_bg_wait', (row, tc, name, a) => {
      if (name !== 'shell_bg_wait') return;
      const k = row.sourceRunId + ':' + (tc && tc.id), w = want.get(k);
      if (!w) return;
      const req = a.timeoutMs != null ? a.timeoutMs : a.timeout_ms;   // StarNet's own reading (sidecar/tools/builtin/shell.js), default 30 s
      cache['wait:' + k] = { at: w.at, req: req == null ? 30000 : (Number.isFinite(Number(req)) ? Number(req) : null) };
    });
    // not in the transcript ten minutes after the run ended: it never will be, so the measured time decides from now on
    if (scanned) for (const [k, w] of want) if (w.settled && !(('wait:' + k) in cache)) cache['wait:' + k] = { at: w.at, req: null };
  }
  const reqOf = (r, t) => { const c = cache[ck(r, t)]; return c && Number.isFinite(c.req) ? c.req : null; };
  const hit = (r, t) => { if (!long(t)) return false; const q = reqOf(r, t); return q !== null ? q > lim : Number(t.ms) > lim + tol; };
  const occ = [], before = {};
  for (const r of runs) {
    const hits = (r.toolTrace || []).filter(t => hit(r, t));
    if (!hits.length) continue;
    if (!(Number(r.startedAt) >= since)) { before[r.agentId] = (before[r.agentId] || 0) + 1; continue; }
    const top = hits.reduce((a, b) => (Number(b.ms) > Number(a.ms) ? b : a));
    const q = reqOf(r, top);
    occ.push({ cls, agentId: r.agentId, key: 'run:' + r.runId, at: Number(hits[0].startedAt) || Number(r.startedAt), told: Number(r.startedAt),
      ref: 'run ' + r.runId.slice(0, 8) + ' (' + routineName(env, r) + ') ' + stamp(Number(hits[0].startedAt) || Number(r.startedAt), ctx) + ': shell_bg_wait ' + (q !== null ? 'asked for timeoutMs ' + q + ' and ' : '') + 'waited ' + Math.round(Number(top.ms) / 1000) + ' s' + (hits.length > 1 ? ' (' + hits.length + ' long waits in the run)' : '') });
  }
  return { ok: true, occurrences: occ, before };
}
function detectAbsolutePath(ctx, env) {
  const cls = 'absolute-path-write', cfg = classConfig(ctx, cls), since = sinceOf(ctx, cls), root = companyRoot(ctx) + '/';
  const named = s => typeof s === 'string' && (s.startsWith(root) || s === root.slice(0, -1));
  const cache = env.state.argCache = env.state.argCache || {};
  const want = new Map();   // runId:callId -> earliest ms, for calls whose summary does not name a path
  // rootOnly: the correction is shown only in routines that work in the company root (elsewhere an absolute path is
  // right), so only those runs count
  const runs = env.runs.filter(r => inCrew(ctx, r.agentId) && (!cfg.routineOnly || isRoutine(r)) && (!cfg.rootOnly || worksInRoot(ctx, env, r)));
  const before = {};
  const lookFrom = ctx.now - (Number(ctx.policy.windowDays) + 1) * 86400e3;   // every run is checked within a tick of ending; older ones never need a new lookup
  for (const r of runs) {
    const after = Number(r.startedAt) >= since;
    if (!after) { if ((r.toolTrace || []).some(t => t && FILE_TOOLS.has(t.name) && String(t.summary || '').includes(root))) before[r.agentId] = (before[r.agentId] || 0) + 1; continue; }   // context only: by summary, one per run
    for (const t of r.toolTrace || []) {
      if (!t || !FILE_TOOLS.has(t.name)) continue;
      const s = String(t.summary || '');
      const k = r.runId + ':' + t.callId;
      if (!s.includes(root) && (t.name === 'fs_patch' || !/\//.test(s)) && !(k in cache) && Number(r.startedAt) >= lookFrom) want.set(k, Number(t.startedAt) || Number(r.startedAt));
    }
  }
  let scanned = true;
  if (want.size) {
    const from = Math.min(...want.values()) - 3600e3;
    scanned = scanTranscripts(ctx, from, 'fs_', (row, tc, name, a) => {
      if (!FILE_TOOLS.has(name)) return;
      const k = row.sourceRunId + ':' + (tc && tc.id);
      if (!want.has(k)) return;
      const hit = pathsInArgs(a).find(named);
      cache[k] = { at: want.get(k), abs: hit ? oneLine(hit, 200) : null };   // one line: it ends up in a handoff
    });
  }
  const occ = [];
  for (const r of runs) {
    if (!(Number(r.startedAt) >= since)) continue;
    const hits = [];
    for (const t of r.toolTrace || []) {
      if (!t || !FILE_TOOLS.has(t.name)) continue;
      const s = String(t.summary || ''), k = r.runId + ':' + t.callId;
      if (s.includes(root)) hits.push({ t, p: (s.match(new RegExp(root.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\S*')) || [root])[0] });
      else if (cache[k] && cache[k].abs) hits.push({ t, p: oneLine(cache[k].abs, 200) });
    }
    if (!hits.length) continue;
    occ.push({ cls, agentId: r.agentId, key: 'run:' + r.runId, at: Number(hits[0].t.startedAt) || Number(r.startedAt), told: Number(r.startedAt),
      ref: 'run ' + r.runId.slice(0, 8) + ' (' + routineName(env, r) + ') ' + stamp(Number(hits[0].t.startedAt) || Number(r.startedAt), ctx) + ': ' + hits.length + ' file-tool call(s) with an absolute path, e.g. ' + hits[0].t.name + ' ' + hits[0].p.slice(0, 120) });
  }
  return { ok: scanned !== false || !want.size, occurrences: occ, before, error: scanned === false ? 'transcripts unreadable' : undefined };
}
function detectQuestDomain(ctx, env) {
  const cls = 'quest-without-domain', cfg = classConfig(ctx, cls), since = sinceOf(ctx, cls);
  if (!Array.isArray(env.quests)) return { ok: false, occurrences: [], error: 'no quest list (station unreachable?)' };
  const winFrom = ctx.now - (Number(ctx.policy.windowDays) + 1) * 86400e3;
  const cands = env.quests.filter(q => q && q.id && !q.domain && Number(q.createdAt) >= since && Number(q.createdAt) >= winFrom);
  const qc = env.state.questCache = env.state.questCache && typeof env.state.questCache === 'object' ? env.state.questCache : {};
  for (const id of Object.keys(qc)) if (!cands.some(q => q.id === id)) delete qc[id];   // gone, given a domain, or out of the window
  if (!cands.length) return { ok: true, occurrences: [], unattributed: [] };
  const open = cands.filter(q => !qc[q.id]);
  const mints = [];
  const scanned = !open.length ? true : scanTranscripts(ctx, Math.min(...open.map(q => Number(q.createdAt))) - 15 * 60e3, 'quests/mint', (row, tc, name, a) => {
    const text = JSON.stringify(a || {});
    if (text.includes('quests/mint')) mints.push({ ts: Number(row.ts), agentId: row.agentId, runId: row.sourceRunId, stream: String(row.streamId || ''), text });
  });
  const runsById = new Map(env.runs.map(r => [r.runId, r]));
  const occ = [], unattributed = [];
  for (const q of cands) {
    if (qc[q.id]) { const c = qc[q.id]; if (!c.who) { unattributed.push(q.id); continue; } if (cfg.routineOnly && !c.routine) continue; if (!inCrew(ctx, c.who)) continue;
      occ.push({ cls, agentId: c.who, key: 'quest:' + q.id, at: Number(q.createdAt), told: c.told, ref: c.ref }); continue; }
    const head = String(q.title || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    const esc = JSON.stringify(head).slice(1, -1);
    const m = mints.filter(x => Math.abs(x.ts - Number(q.createdAt)) <= 15 * 60e3 && head && (x.text.includes(head) || x.text.includes(esc)))
      .sort((a, b) => Math.abs(a.ts - q.createdAt) - Math.abs(b.ts - q.createdAt))[0];
    let who = null, run = null, how = '';
    let routine = true;   // a run still in flight has no run record yet: its transcript stream (cron-<id>) says it is a routine
    if (m) { who = m.agentId; run = runsById.get(m.runId) || null; how = 'run ' + String(m.runId || '').slice(0, 8); routine = run ? isRoutine(run) : m.stream.startsWith('cron-'); }
    else { const cb = /^agent:([A-Za-z0-9_-]+)$/.exec(String(q.createdBy || '')); if (cb && cb[1] !== q.agentId) { who = cb[1]; how = 'createdBy'; } }
    const told = run ? Number(run.startedAt) : Number(q.createdAt);
    const ref = 'quest ' + q.id + ' "' + oneLine(q.title, 60) + '" minted ' + stamp(Number(q.createdAt), ctx) + ' with no domain (' + how + ')';
    // remember the answer once it is final: the minting run has its run record, or two hours have passed (a routine run
    // ends within 90 minutes, and the transcript row lands within seconds of the mint)
    if (scanned !== false && ((m && run) || ctx.now - Number(q.createdAt) > 2 * 3600e3)) qc[q.id] = { who: who && inCrew(ctx, who) ? who : null, routine, told, ref };
    if (!who || !inCrew(ctx, who)) { unattributed.push(q.id); continue; }
    if (cfg.routineOnly && !routine) continue;   // minted in a chat with the owner: not a routine habit
    occ.push({ cls, agentId: who, key: 'quest:' + q.id, at: Number(q.createdAt), told, ref });
  }
  return { ok: scanned !== false, occurrences: occ, unattributed, error: scanned === false ? 'transcripts unreadable' : undefined };
}
function detectPerfFlags(ctx, env) {
  const cfg = classConfig(ctx, 'repeat-performance-flag'), since = sinceOf(ctx, 'repeat-performance-flag');
  const excl = new Set((cfg.excludeTypes || []).map(String));
  const seen = env.state.perfFlags = Array.isArray(env.state.perfFlags) ? env.state.perfFlags : [];
  const keys = new Set(seen.map(f => f.key));
  let txt = ''; let ok = true;
  try { txt = fs.readFileSync(ctx.paths.dispatchLog, 'utf8'); } catch (e) { ok = fs.existsSync(ctx.paths.dispatchLog) ? false : true; }
  for (const l of txt.split('\n')) {
    const m = /^- (\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) PERFORMANCE FLAG (.+?) \(([A-Za-z0-9_-]+)\): (.*)$/.exec(l);
    if (!m) continue;
    const naive = Date.parse(m[1] + 'T' + m[2] + ':' + m[3] + ':00Z');
    const at = naive - offsetMin(naive, ctx) * 60000;
    for (const t of m[6].matchAll(/(?:^|; )([a-z][a-z-]*) — ([^;]*)/g)) {
      const key = 'perf:' + m[5] + ':' + t[1] + ':' + at;
      if (keys.has(key)) continue;
      keys.add(key); seen.push({ key, agentId: m[5], type: t[1], at, why: oneLine(t[2].replace(/ — handed to .*$/, ''), 160) });
    }
  }
  const keepFrom = ctx.now - (Number(ctx.policy.windowDays) + 60) * 86400e3;
  env.state.perfFlags = seen.filter(f => f.at >= keepFrom);
  const occ = env.state.perfFlags.filter(f => f.at >= since && !excl.has(f.type) && inCrew(ctx, f.agentId)).map(f => ({
    cls: 'repeat-flag-' + f.type, agentId: f.agentId, key: f.key, at: f.at, told: f.at,
    ref: 'performance flag "' + f.type + '" ' + stamp(f.at, ctx) + ': ' + f.why }));
  return { ok, occurrences: occ };
}
function competenceGate(ctx) {
  const cfg = classConfig(ctx, 'competence-flaw') || {};
  const shadow = (readJson(ctx.paths.competencePolicy, {}) || {}).shadowUntil;
  const dayStart = d => { const n = Date.parse(d + 'T00:00:00Z'); return n - offsetMin(n, ctx) * 60000; };   // midnight, company time
  const shadowEnd = shadow ? (String(shadow).length <= 10 ? dayStart(shadow) : tms(shadow)) : NaN;
  const notBefore = Math.max(tms(cfg.notBefore) || 0, Number.isFinite(shadowEnd) ? shadowEnd : 0);
  return { on: cfg.enabled === true && ctx.now >= notBefore, notBefore };
}
// The demerits as the competence system itself reads them (company/tools/competence.js compute): only the newest
// collector's rows; one defect file is one flaw; the people owner's rulings apply once corroborated (a ruling.corroborated row
// targets them), in time order: --void removes the flaw, --uphold undoes a void, --severity N means not a flaw,
// --agent and --bucket re-attribute it; a soft signal counts once it applies (amended, or past appliesAt).
const COLLECT_WRITER = 'competence.js collect';
function effectiveDemerits(rows, now, isCrew) {
  isCrew = isCrew || (a => !!a);
  const collVer = r => (r.writer === COLLECT_WRITER ? (Number(r.collector) || 1) : null);
  const maxVer = rows.reduce((m, r) => Math.max(m, collVer(r) || 0), 0);
  const valid = rows.filter(r => { const v = collVer(r); return v == null || v === maxVer; });
  const canonDefect = new Map(), alias = new Map();
  const srcOf = r => (r.source && r.source.ref) || r.id;
  for (const r of valid) if (r.signal === 'defect.confirmed') { const k = srcOf(r); const cur = canonDefect.get(k); if (!cur || (!isCrew(cur.agent) && isCrew(r.agent))) canonDefect.set(k, r); }   // prefer the row that names a crew member
  for (const r of valid) if (r.signal === 'defect.confirmed') alias.set(r.id, canonDefect.get(srcOf(r)).id);
  const canon = id => alias.get(id) || id;
  const corrob = new Set(valid.filter(r => r.signal === 'ruling.corroborated').map(r => r.target));
  const eff = new Map();
  for (const r of valid.filter(x => x.kind === 'ruling').sort((a, b) => (tms(a.at) || 0) - (tms(b.at) || 0))) {
    if (!corrob.has(r.id) || !r.target) continue;
    const k = canon(r.target), e = eff.get(k) || {}, ch = r.changes && typeof r.changes === 'object' ? r.changes : {};
    if (ch.uphold) delete e.void;
    Object.assign(e, ch); e.amendedAt = tms(r.at); eff.set(k, e);
  }
  const out = [];
  for (const r of valid) {
    if (r.kind !== 'demerit' || r.mergedInto) continue;
    if (r.signal === 'defect.confirmed' && canon(r.id) !== r.id) continue;
    const e = eff.get(r.id) || (r.srcKey ? eff.get(r.srcKey) : undefined) || {};
    const o = Object.assign({}, r, e);
    if (o.void || o.severity === 'N') continue;
    if (r.soft && !e.amendedAt && tms(r.appliesAt) > now) continue;
    out.push(o);
  }
  return out;
}
function detectCompetence(ctx) {
  const g = competenceGate(ctx);
  if (!g.on) return { ok: true, occurrences: [], off: 'off until ' + stamp(g.notBefore, ctx) + ' and until enabled in the policy' };
  const since = Math.max(g.notBefore, sinceOf(ctx, 'competence-flaw'));
  const occ = [], dupe = new Set();
  let txt; try { txt = fs.readFileSync(ctx.paths.competence, 'utf8'); } catch (_) { return { ok: false, occurrences: [], error: 'competence ledger unreadable' }; }
  const rows = [];
  for (const l of txt.split('\n')) { if (!l.trim()) continue; try { const e = JSON.parse(l); if (e && typeof e === 'object') rows.push(e); } catch (_) {} }
  for (const e of effectiveDemerits(rows, ctx.now, id => inCrew(ctx, id))) {
    if (!e.agent || !e.bucket || !inCrew(ctx, e.agent)) continue;
    const at = tms(e.at); if (!(at >= since)) continue;
    const d = [e.agent, e.bucket, e.signal, e.at, e.key].join('|'); if (dupe.has(d)) continue; dupe.add(d);   // one flaw, many collector versions
    occ.push({ cls: 'competence-' + e.bucket, agentId: e.agent, key: 'competence:' + d, at, told: at, ref: 'competence ' + e.id + ' ' + (e.severity || '') + ' ' + (e.signal || '') + ' ' + stamp(at, ctx) });
  }
  return { ok: true, occurrences: occ };
}
function detect(ctx, env) {
  const res = { ok: {}, errors: [], occurrences: [], before: {}, unattributed: [], notes: [] };
  let runs = null;
  try { runs = readRuns(ctx); } catch (e) { res.errors.push('runs: ' + e.message); }
  env.runs = runs || [];
  const C = ctx.policy.classes;
  const run = (name, fn, needsRuns) => {
    if (!C[name] || C[name].enabled === false && name !== 'competence-flaw') { res.ok[name] = true; return; }
    if (needsRuns && !runs) { res.ok[name] = false; return; }
    try {
      const r = fn(ctx, env);
      res.ok[name] = r.ok !== false;
      if (r.error) res.errors.push(name + ': ' + r.error);
      if (r.off) res.notes.push(name + ': ' + r.off);
      res.occurrences.push(...(r.occurrences || []));
      for (const [a, n] of Object.entries(r.before || {})) ((res.before[a] = res.before[a] || {})[name] = n);
      if (r.unattributed && r.unattributed.length) res.unattributed.push(...r.unattributed);
    } catch (e) { res.ok[name] = false; res.errors.push(name + ': ' + e.message); }
  };
  run('long-wait', detectLongWait, true);
  run('absolute-path-write', detectAbsolutePath, true);
  run('quest-without-domain', detectQuestDomain, false);
  run('repeat-performance-flag', detectPerfFlags, false);
  run('competence-flaw', detectCompetence, false);
  const ac = env.state.argCache || {}; const keepFrom = ctx.now - (Number(ctx.policy.windowDays) + 2) * 86400e3;
  for (const k of Object.keys(ac)) if (!(ac[k] && ac[k].at >= keepFrom)) delete ac[k];
  return res;
}

/* ---------------- handoffs ---------------- */
function inboxOf(ctx, id) { const c = ctx.crew.agents[id]; return c && c.inbox ? c.inbox : null; }
// FYIs about a person go to their manager; when the manager is the CEO (or nobody), to the people owner instead.
function fyiTarget(ctx, agentId) {
  const mgr = (ctx.crew.agents[agentId] || {}).manager;
  if (mgr && mgr !== ctx.crew.ceoId && ctx.crew.agents[mgr] && ctx.crew.agents[mgr].inbox) return { id: mgr, inbox: ctx.crew.agents[mgr].inbox };
  return ctx.crew.people && ctx.crew.people.inbox ? { id: ctx.crew.people.id, inbox: ctx.crew.people.inbox } : null;
}
// every value on one line: evidence can carry text from transcript arguments, and a line break there could start a
// "## " section or a "**Status:** OPEN" line that wakes someone
const flat = v => String(v == null ? '' : v).replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
function handoffText(ctx, heading, fields) {
  return '\n## ' + stamp(ctx.now, ctx) + ' from ' + TOOL_NAME + ' (company/tools/corrections.js) — ' + flat(heading) + '\n' +
    Object.entries(fields).map(([k, v]) => '**' + k + ':** ' + flat(v)).join('\n') + '\n';
}
function writeHandoff(ctx, inbox, text) {
  const f = path.join(ctx.paths.handoffs, inbox);
  if (!path.resolve(f).startsWith(path.resolve(ctx.paths.handoffs) + path.sep)) throw new Error('bad inbox ' + inbox);
  fs.mkdirSync(path.dirname(f), { recursive: true }); require('./lib/tool-blocks').append(f, text);   // recorded (lib/tool-blocks.js)
}
const ruleLine = c => fullLine(c).slice(2);
const evidenceList = (list, n) => list.slice(0, n).map(e => e.ref).join('; ') + (list.length > n ? '; +' + (list.length - n) + ' more' : '');
function activationFyi(ctx, c) {
  const who = nameOf(ctx, c.agentId), file = 'company/work/people/corrections/' + c.agentId + '.json';
  const t = fyiTarget(ctx, c.agentId); if (!t) return null;
  const esc = ctx.crew.tools ? ctx.crew.tools.name : 'the tool owner';
  return { to: t.inbox, text: handoffText(ctx, '1-on-1: standing correction ' + c.id + ' for ' + who + ' (' + c.issueClass + ')', {
    Need: 'nothing; this is an FYI. The correction is already at the end of every routine prompt of ' + who + '\'s. You may change or end it: `node company/tools/corrections.js edit ' + c.id + ' --by <you> --rule "…" --instead "…" --example "…"` or `node company/tools/corrections.js retire ' + c.id + ' --by <you> --reason "…"`.',
    Why: c.whatHappened.summary + ' What ' + who + ' now reads on every run: "' + ruleLine(c) + '" It ends by itself after ' + ctx.policy.retireAfterCleanDays + ' clean days; if it happens ' + ctx.policy.escalateAfterRecurrences + ' more times while shown, ' + esc + ' is asked for a mechanical gate. This is not a performance flag and charges nobody (company/work/people/ONE-ON-ONES.md).',
    Deadline: 'none', Status: 'DONE — FYI',
    Evidence: evidenceList(c.whatHappened.evidence, 4) + '; `' + file + '`',
  }) };
}
function escalationHandoffs(ctx, c) {
  const who = nameOf(ctx, c.agentId), file = 'company/work/people/corrections/' + c.agentId + '.json';
  const tools = ctx.crew.tools && ctx.crew.tools.inbox ? ctx.crew.tools : (ctx.crew.people || null);
  const gate = c.gate || 'a check that makes the corrected action fail loudly instead of happening';
  const out = [];
  const due = local(ctx.now + (Number(ctx.policy.escalationDeadlineDays) || 3) * 86400e3, ctx).slice(0, 10);
  if (tools) out.push({ to: tools.inbox, text: handoffText(ctx, 'gate request: ' + who + ' keeps doing "' + c.title + '" despite standing correction ' + c.id, {
    Need: 'a mechanical gate that blocks the action itself: ' + gate + '. If a gate cannot be built, say why in this thread. Close this handoff with what you changed.',
    Why: who + '\'s correction ' + c.id + ' has been at the end of every routine prompt of theirs since ' + stamp(tms(c.at), ctx) + ' ("' + ruleLine(c) + '"), and it happened ' + c.recurrences.length + ' more times. A written rule is not enough for this one. This is not a performance matter: nothing is charged to ' + who + '.',
    Deadline: due, Status: 'OPEN',
    Evidence: evidenceList(c.recurrences, 4) + '; `' + file + '`',
  }) });
  if (ctx.crew.people && ctx.crew.people.inbox && (!tools || ctx.crew.people.inbox !== tools.inbox)) out.push({ to: ctx.crew.people.inbox, text: handoffText(ctx, 'FYI: correction ' + c.id + ' for ' + who + ' did not stick; asked ' + (tools ? tools.name : 'the tool owner') + ' for a gate', {
    Need: 'nothing; this is an FYI. The correction stays in ' + who + '\'s prompts. A correction is the remedy, not a second punishment: do not add a flag or a demerit for this.',
    Why: c.recurrences.length + ' recurrences while the correction was shown (since ' + stamp(tms(c.at), ctx) + ').',
    Deadline: 'none', Status: 'DONE — FYI', Evidence: evidenceList(c.recurrences, 3) + '; `' + file + '`',
  }) });
  return out;
}

/* ---------------- tick ---------------- */
function newCorrection(ctx, rec, cls, occs) {
  const t = textFor(cls, ctx) || {};
  const cfg = classConfig(ctx, cls) || {};
  const who = nameOf(ctx, rec.agentId);
  const first = occs[0], last = occs[occs.length - 1];
  return {
    id: nextId(rec), agentId: rec.agentId, issueClass: cls, title: t.title || cls,
    whatHappened: { summary: who + ': ' + occs.length + ' times in ' + ctx.policy.windowDays + ' days (' + stamp(first.at, ctx) + ' to ' + stamp(last.at, ctx) + '), after the rule took effect ' + stamp(sinceOf(ctx, cls), ctx) + '.',
      evidence: occs.slice(-50).map(o => ({ key: o.key, at: local(o.at, ctx), ref: o.ref })) },
    rule: t.rule, doInstead: t.doInstead, example: t.example, gate: t.gate || null, rootOnly: !!cfg.rootOnly,
    by: TOOL_NAME + ' tool (detector ' + detectorOf(cls) + ')', byVerified: 'automatic', at: local(ctx.now, ctx), status: 'active',
    lastSeenAt: local(last.at, ctx), cleanSince: local(ctx.now, ctx), recurrences: [], history: [{ at: local(ctx.now, ctx), by: TOOL_NAME, change: 'activated' }],
  };
}
async function tick(opts) {
  opts = opts || {};
  const ctx = context(opts);
  const dry = !!opts.dry; const log = typeof opts.log === 'function' ? opts.log : () => {};
  const state = readJson(ctx.paths.state, {}) || {};
  let quests = opts.quests;
  if (!Array.isArray(quests) && ctx.policy.classes['quest-without-domain'].enabled !== false && !opts.noStation) {
    try { const r = await require('./station-crew.js').call('GET', '/api/quests'); quests = r.status === 200 ? (JSON.parse(r.body).quests || []) : null; } catch (_) { quests = null; }
  }
  let jobs = opts.jobs;
  if (!Array.isArray(jobs) && !opts.noStation) { try { const r = await require('./station-crew.js').call('GET', '/api/cron'); jobs = r.status === 200 ? (JSON.parse(r.body).jobs || []) : []; } catch (_) { jobs = []; } }
  const env = { quests, jobs: jobs || [], state };
  const det = detect(ctx, env);
  const go = () => apply(ctx, det, state, dry, log);
  const result = dry ? go() : withLock(ctx, 5000, go);
  return Object.assign(result, { errors: det.errors, notes: det.notes, unattributed: det.unattributed, before: det.before, detectorsOk: det.ok });
}
function apply(ctx, det, state, dry, log) {
  const P = ctx.policy, W = 'WOULD ';
  const winMs = Number(P.windowDays) * 86400e3, cleanMs = Number(P.retireAfterCleanDays) * 86400e3;
  const result = { at: local(ctx.now, ctx), dry, counts: {}, activated: [], recurred: [], escalated: [], retired: [], skipped: [] };
  const groups = new Map();
  for (const o of det.occurrences) { const k = o.agentId + '|' + o.cls; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
  for (const g of groups.values()) g.sort((a, b) => a.at - b.at);
  const ids = new Set(Object.keys(ctx.crew.agents).filter(id => inCrew(ctx, id)));
  for (const rec of allPeople(ctx)) if (inCrew(ctx, rec.agentId)) ids.add(rec.agentId);
  const handoffs = [], events = [], dirty = new Set(), recs = new Map();
  state.skippedCap = state.skippedCap || {};
  for (const id of ids) {
    const rec = loadPerson(ctx, id); recs.set(id, rec);
    // what this person's routine prompts carry right now (every routine of the crew works in the company root); a
    // correction they were not shown is never counted as a recurrence and never escalated
    const shown = new Set(renderInfo(ctx, rec, { companyRoot: true }).shown);
    const mine = [...groups.entries()].filter(([k]) => k.startsWith(id + '|'));
    for (const [k, occs] of mine) {
      const cls = k.slice(id.length + 1);
      const cfg = classConfig(ctx, cls) || {};
      const known = new Set();
      for (const c of rec.corrections.filter(x => x.issueClass === cls)) { for (const e of (c.whatHappened && c.whatHappened.evidence) || []) known.add(e.key); for (const e of (c.recurrences || []).concat(c.whileHidden || [])) known.add(e.key); }
      const active = rec.corrections.find(x => x.issueClass === cls && ACTIVE.has(x.status));
      const inWin = occs.filter(o => o.at >= ctx.now - winMs);
      (result.counts[id] = result.counts[id] || {})[cls] = inWin.length;
      if (active && !shown.has(active.id)) {
        // not in the prompt (only a policy changed under it can do this): the habit is not clean, but it is not a
        // recurrence either, because nobody showed the person the rule
        const fresh = occs.filter(o => o.told > tms(active.at) && !known.has(o.key));
        for (const o of fresh) {
          active.whileHidden = (active.whileHidden || []).concat([{ key: o.key, at: local(o.at, ctx), ref: o.ref }]);
          if (!(tms(active.lastSeenAt) >= o.at)) active.lastSeenAt = local(o.at, ctx);
          if (!(tms(active.cleanSince) >= o.at)) active.cleanSince = local(o.at, ctx);
          dirty.add(id);
        }
        if (fresh.length) {
          result.skipped.push({ agentId: id, cls, why: active.id + ' is not shown (the block is over its size limit), so ' + fresh.length + ' new occurrence(s) are not counted as recurrences' });
          events.push({ event: 'not-shown', id: active.id, agentId: id, issueClass: cls, occurrences: fresh.length });
          log((dry ? W : '') + 'CORRECTION NOT SHOWN ' + active.id + ' (' + nameOf(ctx, id) + ', ' + cls + '): ' + fresh.length + ' new occurrence(s) not counted; the block is over ' + P.maxBlockChars + ' characters');
        }
        continue;
      }
      if (active) {
        const fresh = occs.filter(o => o.told > tms(active.at) && !known.has(o.key));
        for (const o of fresh) {
          active.recurrences.push({ key: o.key, at: local(o.at, ctx), ref: o.ref });
          if (!(tms(active.lastSeenAt) >= o.at)) active.lastSeenAt = local(o.at, ctx);
          if (!(tms(active.cleanSince) >= o.at)) active.cleanSince = local(o.at, ctx);
          result.recurred.push({ id: active.id, agentId: id, cls, ref: o.ref });
          events.push({ event: 'recurrence', id: active.id, agentId: id, issueClass: cls, ref: o.ref });
          log((dry ? W : '') + 'CORRECTION RECURRED ' + active.id + ' (' + nameOf(ctx, id) + ', ' + cls + '): ' + o.ref);
          dirty.add(id);
        }
        continue;
      }
      const lastRetired = Math.max(0, ...rec.corrections.filter(x => x.issueClass === cls && x.retiredAt).map(x => tms(x.retiredAt) || 0));
      const eligible = inWin.filter(o => !known.has(o.key) && o.at > lastRetired && o.told > lastRetired);
      const need = Math.max(1, Number(cfg.threshold) || 2);
      if (eligible.length < need) continue;
      if (activeOf(rec).length >= (Number(P.maxActivePerPerson) || 5)) {
        result.skipped.push({ agentId: id, cls, why: 'already ' + activeOf(rec).length + ' active corrections (the most one person carries)' });
        const day = local(ctx.now, ctx).slice(0, 10);
        if (state.skippedCap[k] !== day) { if (!dry) state.skippedCap[k] = day; events.push({ event: 'skipped-cap', agentId: id, issueClass: cls, occurrences: eligible.length }); log((dry ? W : '') + 'CORRECTION HELD for ' + nameOf(ctx, id) + ' (' + cls + '): ' + eligible.length + ' occurrences, but ' + activeOf(rec).length + ' corrections are already active'); }
        continue;
      }
      const c = newCorrection(ctx, rec, cls, eligible);
      rec.corrections.push(c);
      const view = renderInfo(ctx, rec, { companyRoot: true });
      if (view.hidden.length) {   // it would not be shown, or would push another out: the FYI could not say it is in the prompt
        rec.corrections.pop();
        result.skipped.push({ agentId: id, cls, why: 'would not fit in the ' + P.maxBlockChars + '-character block' });
        const day = local(ctx.now, ctx).slice(0, 10);
        if (state.skippedCap[k] !== day) { if (!dry) state.skippedCap[k] = day; events.push({ event: 'skipped-size', agentId: id, issueClass: cls, occurrences: eligible.length }); log((dry ? W : '') + 'CORRECTION HELD for ' + nameOf(ctx, id) + ' (' + cls + '): ' + eligible.length + ' occurrences, but it would not fit in the ' + P.maxBlockChars + '-character block'); }
        continue;
      }
      dirty.add(id);
      const fyi = activationFyi(ctx, c); if (fyi) handoffs.push(fyi);
      result.activated.push({ id: c.id, agentId: id, cls, occurrences: eligible.length, fyiTo: fyi ? fyi.to : null, evidence: eligible.map(o => o.ref) });
      events.push({ event: 'activated', id: c.id, agentId: id, issueClass: cls, by: c.by, occurrences: eligible.length, evidence: eligible.map(o => o.key) });
      log((dry ? W : '') + 'CORRECTION ACTIVATED ' + c.id + ' for ' + nameOf(ctx, id) + ' (' + cls + '): ' + eligible.length + ' times in ' + P.windowDays + ' days; FYI to ' + (fyi ? fyi.to.replace(/^to-|\.md$/g, '') : 'nobody'));
    }
    for (const c of activeOf(rec)) {
      if (c.status === 'active' && shown.has(c.id) && (c.recurrences || []).length >= (Number(P.escalateAfterRecurrences) || 2)) {
        c.status = 'escalated'; c.escalatedAt = local(ctx.now, ctx);
        const hs = escalationHandoffs(ctx, c); handoffs.push(...hs);
        c.escalation = { to: hs.map(h => h.to) };
        c.history = (c.history || []).concat([{ at: local(ctx.now, ctx), by: TOOL_NAME, change: 'escalated: ' + c.recurrences.length + ' recurrences' }]);
        result.escalated.push({ id: c.id, agentId: id, cls: c.issueClass, to: hs.map(h => h.to) });
        events.push({ event: 'escalated', id: c.id, agentId: id, issueClass: c.issueClass, recurrences: c.recurrences.length, to: hs.map(h => h.to) });
        log((dry ? W : '') + 'CORRECTION ESCALATED ' + c.id + ' (' + nameOf(ctx, id) + ', ' + c.issueClass + '): ' + c.recurrences.length + ' recurrences while shown; gate request to ' + hs.map(h => h.to.replace(/^to-|\.md$/g, '')).join(' + '));
        dirty.add(id);
      }
      const dOk = c.issueClass.startsWith('manual-') ? true : det.ok[detectorOf(c.issueClass)] !== false;
      if (dOk && ctx.now - (tms(c.cleanSince) || tms(c.at) || ctx.now) >= cleanMs) {
        const was = c.status;
        c.status = 'retired'; c.retiredAt = local(ctx.now, ctx); c.retiredBy = TOOL_NAME; c.retireReason = P.retireAfterCleanDays + ' clean days since ' + stamp(tms(c.cleanSince), ctx);
        c.history = (c.history || []).concat([{ at: local(ctx.now, ctx), by: TOOL_NAME, change: 'retired (was ' + was + '): ' + c.retireReason }]);
        result.retired.push({ id: c.id, agentId: id, cls: c.issueClass, reason: c.retireReason });
        events.push({ event: 'retired', id: c.id, agentId: id, issueClass: c.issueClass, by: TOOL_NAME, reason: c.retireReason });
        log((dry ? W : '') + 'CORRECTION RETIRED ' + c.id + ' (' + nameOf(ctx, id) + ', ' + c.issueClass + '): ' + c.retireReason);
        dirty.add(id);
      }
    }
  }
  DRY_VIEW = dry ? { root: ctx.root, recs: new Map([...dirty].map(id => [id, recs.get(id)])) } : null;
  if (!dry) {
    for (const id of dirty) savePerson(ctx, recs.get(id));
    for (const h of handoffs) writeHandoff(ctx, h.to, h.text);
    for (const e of events) appendLog(ctx, e);
    if (dirty.size || !fs.existsSync(ctx.paths.readme)) writeReadme(ctx);
    state.lastTick = local(ctx.now, ctx);
    writeAtomic(ctx.paths.state, JSON.stringify(state) + '\n');
  }
  result.handoffs = handoffs.map(h => ({ to: h.to, heading: h.text.split('\n')[1] }));
  return result;
}

/* ---------------- README ---------------- */
function writeReadme(ctx) {
  const out = ['# Standing corrections (1-on-1s)', '',
    'Written by `company/tools/corrections.js` from the files in this folder; do not edit it by hand. How it works and who may change what: `company/work/people/ONE-ON-ONES.md`. Updated ' + stamp(ctx.now, ctx) + ' (company time).', ''];
  const people = new Map(allPeople(ctx).map(r => [r.agentId, r]));
  const none = [];
  for (const [id, c] of Object.entries(ctx.crew.agents)) {
    const rec = people.get(id); people.delete(id);
    if (!rec || !rec.corrections.length) { none.push(c.name || id); continue; }
    out.push(...personSection(ctx, rec));
  }
  for (const rec of people.values()) if (rec.corrections.length) out.push(...personSection(ctx, rec));
  out.push(out.length > 4 ? '## Nobody else has a correction' : '## Nobody has a correction', '', none.length ? none.join(', ') : '—', '');
  writeAtomic(ctx.paths.readme, out.join('\n'));
}
function personSection(ctx, rec) {
  const row = ctx.crew.agents[rec.agentId] || {};
  const mgr = row.manager ? nameOf(ctx, row.manager) : 'none';
  const act = activeOf(rec), past = rec.corrections.filter(c => !ACTIVE.has(c.status)).slice(-5).reverse();
  const out = ['## ' + (row.name || rec.agentId) + ' (' + rec.agentId + ')' + (row.title ? ', ' + row.title : '') + ', manager ' + mgr, ''];
  if (!act.length) out.push('No active corrections.');
  for (const c of act) out.push('- **' + c.id + '** ' + c.status + ' since ' + stamp(tms(c.at), ctx) + ' · ' + c.title + ' (`' + c.issueClass + '`) · ' + (c.recurrences || []).length + ' recurrence(s) · clean since ' + stamp(tms(c.cleanSince), ctx) + ' · by ' + c.by, '  ' + ruleLine(c));
  if (past.length) { out.push('', 'Past:'); for (const c of past) out.push('- ' + c.id + ' ' + c.status + ' ' + (c.retiredAt ? stamp(tms(c.retiredAt), ctx) : '') + ' · ' + c.title + (c.retireReason ? ' (' + c.retireReason + ')' : '')); }
  out.push('');
  return out;
}

/* ---------------- manual commands ---------------- */
function allowedBy(ctx, agentId) {
  const row = ctx.crew.agents[agentId] || {};
  const names = [];
  if (ctx.crew.people && ctx.crew.people.name) names.push(ctx.crew.people.name);
  if (row.manager && row.manager !== ctx.crew.ceoId && ctx.crew.agents[row.manager] && ctx.crew.agents[row.manager].name) names.push(ctx.crew.agents[row.manager].name);
  return [...new Set(names)];
}
function checkBy(ctx, agentId, by) {
  const ok = allowedBy(ctx, agentId);
  if (!by || by === true) throw new Error('--by <Name> is required (' + ok.join(' or ') + ')');
  if (!ok.some(n => n.toLowerCase() === String(by).trim().toLowerCase())) throw new Error(String(by) + ' may not change corrections for ' + nameOf(ctx, agentId) + ': only ' + ok.join(' or ') + (((ctx.crew.agents[agentId] || {}).manager === ctx.crew.ceoId) ? ' (their manager is the CEO, so the people owner handles it alone)' : ''));
  return ok.find(n => n.toLowerCase() === String(by).trim().toLowerCase());
}
const LIM = { title: 80, rule: 160, doInstead: 160, example: 140, evidence: 600, reason: 300 };
function need(o, k, n) { const v = o[k]; if (v == null || v === true || !String(v).trim()) throw new Error('--' + k + ' is required'); return oneLine(v, n); }
// a hand-written line must fit its share of the block, so the person always sees every correction they carry
function checkFits(ctx, c) {
  const b = lineBudget(ctx), n = fullLine(c).length;
  if (b > 0 && n > b) throw new Error('too long for one line of the block: rule + instead + example come to ' + n + ' characters with the labels, and one line may be at most ' + b + ' (so that all ' + (Number(ctx.policy.maxActivePerPerson) || 5) + ' corrections a person can carry fit in ' + (Number(ctx.policy.maxBlockChars) || 1200) + '). Shorten it by ' + (n - b) + '; nothing was changed');
}
function addManual(ctx, agentId, o) {
  safeId(agentId);
  if (!ctx.crew.agents[agentId]) throw new Error('no crew member ' + agentId + ' in company/tools/loops.json');
  const by = checkBy(ctx, agentId, o.by);
  const f = { title: need(o, 'title', LIM.title), rule: need(o, 'rule', LIM.rule), doInstead: need(o, 'instead', LIM.doInstead), example: need(o, 'example', LIM.example), evidence: need(o, 'evidence', LIM.evidence) };
  const slug = o.class && o.class !== true ? String(o.class).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) : f.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const cls = builtinText(slug, ctx) ? slug : 'manual-' + (slug.replace(/^manual-/, '') || 'note');
  checkFits(ctx, { rule: f.rule, doInstead: f.doInstead, example: f.example });
  return withLock(ctx, 10000, () => {
    const rec = loadPerson(ctx, agentId);
    if (rec.corrections.some(c => c.issueClass === cls && ACTIVE.has(c.status))) throw new Error(nameOf(ctx, agentId) + ' already has an active correction of class ' + cls + ': edit it instead');
    if (activeOf(rec).length >= (Number(ctx.policy.maxActivePerPerson) || 5)) throw new Error(nameOf(ctx, agentId) + ' already has ' + activeOf(rec).length + ' active corrections, the most one person carries: retire one first');
    const c = { id: nextId(rec), agentId, issueClass: cls, title: f.title, whatHappened: { summary: f.evidence, evidence: [{ key: 'manual:' + ctx.now, at: local(ctx.now, ctx), ref: f.evidence }] },
      rule: f.rule, doInstead: f.doInstead, example: f.example, gate: null, rootOnly: false, by, byVerified: 'claimed (--by is not cryptographically verified)',
      at: local(ctx.now, ctx), status: 'active', lastSeenAt: local(ctx.now, ctx), cleanSince: local(ctx.now, ctx), recurrences: [],
      history: [{ at: local(ctx.now, ctx), by, change: 'added by hand' }] };
    rec.corrections.push(c); savePerson(ctx, rec);
    appendLog(ctx, { event: 'added', id: c.id, agentId, issueClass: cls, by, claim: 'unverified', title: c.title });
    writeReadme(ctx);
    return c;
  });
}
function editManual(ctx, id, o) {
  return withLock(ctx, 10000, () => {
    const hit = findCorrection(ctx, id); if (!hit) throw new Error('no correction ' + id);
    const { rec, c } = hit; const by = checkBy(ctx, c.agentId, o.by);
    if (!ACTIVE.has(c.status)) throw new Error(id + ' is ' + c.status + '; only an active correction can be edited');
    const changed = [];
    for (const [flag, field] of [['title', 'title'], ['rule', 'rule'], ['instead', 'doInstead'], ['example', 'example']]) {
      if (o[flag] == null || o[flag] === true) continue;
      const v = oneLine(o[flag], LIM[field]); if (!v) throw new Error('--' + flag + ' cannot be empty');
      if (v !== c[field]) { c[field] = v; changed.push(field); }
    }
    if (!changed.length) throw new Error('nothing to change: pass --title, --rule, --instead or --example');
    checkFits(ctx, c);   // throws before anything is saved
    c.history = (c.history || []).concat([{ at: local(ctx.now, ctx), by, change: 'edited ' + changed.join(', ') }]);
    savePerson(ctx, rec); appendLog(ctx, { event: 'edited', id, agentId: c.agentId, issueClass: c.issueClass, by, claim: 'unverified', fields: changed }); writeReadme(ctx);
    return c;
  });
}
function retireManual(ctx, id, o) {
  return withLock(ctx, 10000, () => {
    const hit = findCorrection(ctx, id); if (!hit) throw new Error('no correction ' + id);
    const { rec, c } = hit; const by = checkBy(ctx, c.agentId, o.by);
    if (!ACTIVE.has(c.status)) throw new Error(id + ' is already ' + c.status);
    const reason = o.reason && o.reason !== true ? oneLine(o.reason, LIM.reason) : 'retired by hand';
    const was = c.status; c.status = 'retired'; c.retiredAt = local(ctx.now, ctx); c.retiredBy = by; c.retireReason = reason;
    c.history = (c.history || []).concat([{ at: local(ctx.now, ctx), by, change: 'retired (was ' + was + '): ' + reason }]);
    savePerson(ctx, rec); appendLog(ctx, { event: 'retired', id, agentId: c.agentId, issueClass: c.issueClass, by, claim: 'unverified', reason }); writeReadme(ctx);
    return c;
  });
}
function recurManual(ctx, id, o) {
  return withLock(ctx, 10000, () => {
    const hit = findCorrection(ctx, id); if (!hit) throw new Error('no correction ' + id);
    const { rec, c } = hit; const by = checkBy(ctx, c.agentId, o.by);
    if (!ACTIVE.has(c.status)) throw new Error(id + ' is ' + c.status + '; a new occurrence starts a new correction (add)');
    const ev = need(o, 'evidence', LIM.evidence);
    c.recurrences.push({ key: 'manual:' + ctx.now, at: local(ctx.now, ctx), ref: ev + ' (recorded by ' + by + ')' });
    c.lastSeenAt = local(ctx.now, ctx); c.cleanSince = local(ctx.now, ctx);
    c.history = (c.history || []).concat([{ at: local(ctx.now, ctx), by, change: 'recurrence recorded' }]);
    savePerson(ctx, rec); appendLog(ctx, { event: 'recurrence', id, agentId: c.agentId, issueClass: c.issueClass, by, claim: 'unverified', ref: ev }); writeReadme(ctx);
    return c;
  });
}

module.exports = { tick, blockFor, renderBlock, detect, context, addManual, editManual, retireManual, recurManual, allowedBy, START, END, _internals: { builtinText, competenceGate, loadPerson, fyiTarget, lineBudget, renderInfo, fullLine, effectiveDemerits, handoffText, pathsInArgs, parseArgs } };

/* ---------------- selftest ---------------- */
async function selftest() {
  const os = require('os');
  const assert = require('assert');
  const T = require('./lib/temp-life').tmpDir('corrections-selftest-');
  const W = rel => path.join(T, rel);
  const put = (rel, v) => { fs.mkdirSync(path.dirname(W(rel)), { recursive: true }); fs.writeFileSync(W(rel), typeof v === 'string' ? v : JSON.stringify(v, null, 1)); };
  const results = []; let failed = 0;
  const check = (name, fn) => { try { fn(); results.push('ok   ' + name); } catch (e) { failed++; results.push('FAIL ' + name + ': ' + e.message); } };
  const H = 3600e3, D = 86400e3;
  const T0 = Date.parse('2026-11-16T09:00:00Z');
  const ROOTP = T;
  put('company/tools/loops.json', { agents: {
    agent: { name: 'Alex', title: 'CEO', inbox: 'to-alex.md', manager: null, functions: ['ceo', 'risk', 'floor', 'finance'] },
    drafter: { name: 'Sam', title: 'PM', inbox: 'to-sam.md', manager: 'agent' },
    engineer: { name: 'Kai', title: 'Tools', inbox: 'to-kai.md', manager: 'agent', functions: ['tools'] },
    hiring: { name: 'Jordan', title: 'HR', inbox: 'to-jordan.md', manager: 'agent', functions: ['people'] },
    designer: { name: 'Robin', title: 'Design', inbox: 'to-robin.md', manager: 'drafter' },
    deployer: { name: 'Casey', title: 'DevOps', inbox: 'to-casey.md', manager: 'agent' } } });
  // the test's rules took effect at fixed instants, and its clock is UTC (utcOffsetMinutes pins it)
  const TP = extra => Object.assign({ liveSince: '2026-11-15T20:00:00Z', utcOffsetMinutes: 0 }, extra || {}, { classes: Object.assign({
    'long-wait': { since: '2026-11-15T17:00:00Z' }, 'absolute-path-write': { since: '2026-11-15T17:00:00Z' } }, (extra || {}).classes || {}) });
  put('company/work/people/corrections-policy.json', TP());
  put('starnet/sidecar/journey-store.js', "const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];\n");
  put('company/competence-policy.json', { shadowUntil: '2026-12-15' });
  put('company/work/people/competence-events.jsonl', [
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'defect.confirmed', at: '2026-12-16T01:00:00Z', key: 'k1', id: 'ev_1', severity: 'S2' },
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'defect.confirmed', at: '2026-12-16T02:00:00Z', key: 'k2', id: 'ev_2', severity: 'S2' },
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'defect.confirmed', at: '2026-12-16T02:00:00Z', key: 'k2', id: 'ev_2b', severity: 'S2' },
    // Jordan's rulings: void ev_3, move ev_4 to another bucket, rate ev_5 "not a flaw" (all corroborated); a ruling that
    // voids ev_1 has no corroborating run yet, so it does not count
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'flaw.in-review', at: '2026-12-16T03:00:00Z', key: 'k3', id: 'ev_3', severity: 'S2' },
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'flaw.in-review', at: '2026-12-16T03:30:00Z', key: 'k4', id: 'ev_4', severity: 'S2' },
    { kind: 'demerit', agent: 'deployer', bucket: 'ops', signal: 'flaw.in-review', at: '2026-12-16T03:40:00Z', key: 'k5', id: 'ev_5', severity: 'S2' },
    { kind: 'ruling', signal: 'ruling', id: 'ev_r1', target: 'ev_3', changes: { void: true }, at: '2026-12-16T04:00:00Z', by: 'Jordan' },
    { kind: 'ruling', signal: 'ruling', id: 'ev_r2', target: 'ev_4', changes: { bucket: 'design' }, at: '2026-12-16T04:00:00Z', by: 'Jordan' },
    { kind: 'ruling', signal: 'ruling', id: 'ev_r3', target: 'ev_5', changes: { severity: 'N' }, at: '2026-12-16T04:00:00Z', by: 'Jordan' },
    { kind: 'ruling', signal: 'ruling', id: 'ev_r4', target: 'ev_1', changes: { void: true }, at: '2026-12-16T04:00:00Z', by: 'Jordan' },
    ...['ev_r1', 'ev_r2', 'ev_r3'].map(t => ({ kind: 'record', signal: 'ruling.corroborated', id: 'ev_c' + t, target: t, at: '2026-12-16T04:10:00Z' }))].map(x => JSON.stringify(x)).join('\n') + '\n');
  for (const f of ['to-alex.md', 'to-sam.md', 'to-kai.md', 'to-jordan.md', 'to-robin.md', 'to-casey.md']) put('company/work/handoffs/' + f, '# Handoffs\n');
  put('company/work/dispatch-log.md', '# Dispatch log\n');
  const runs = [];
  const run = (id, agentId, start, trace, routine) => runs.push({ runId: id, agentId, startedAt: start, endedAt: start + H, cronJobId: routine === false ? undefined : 'job-' + agentId, toolTrace: trace });
  const wait = (ms, at) => ({ callId: 'w' + at, name: 'shell_bg_wait', ok: true, ms, summary: 'exited 0', startedAt: at, endedAt: at + ms });
  const write = (name, summary, at, callId) => ({ callId: callId || ('f' + at), name, ok: true, ms: 4, summary, startedAt: at, endedAt: at + 4 });
  // long-wait: Robin twice after the rule (one run has two long waits: still one occurrence), once before it, once in a chat
  run('r-robin-before', 'designer', Date.parse('2026-11-15T16:00:00Z'), [wait(300000, Date.parse('2026-11-15T16:05:00Z'))]);
  run('r-robin-1', 'designer', T0 - 14 * H, [wait(300000, T0 - 14 * H + 60000), wait(260000, T0 - 14 * H + 600000)]);
  run('r-robin-chat', 'designer', T0 - 12 * H, [wait(300000, T0 - 12 * H + 60000)], false);
  run('r-robin-2', 'designer', T0 - 10 * H, [wait(250000, T0 - 10 * H + 60000), wait(200000, T0 - 10 * H + 120000)]);
  run('r-casey-1', 'deployer', T0 - 10 * H, [wait(250000, T0 - 10 * H + 60000)]);   // one only: not recurring
  // compliant waits that measure over 240000 never count: a 240000 request that ran out (240003), the same with no
  // arguments in the transcript (240004, inside the tolerance), and a 300000 request that returned after 239.8 s
  run('r-casey-2', 'deployer', T0 - 9 * H, [wait(240003, T0 - 9 * H + 60000)]);
  run('r-casey-3', 'deployer', T0 - 9 * H + 600000, [wait(240004, T0 - 9 * H + 660000)]);
  run('r-casey-4', 'deployer', T0 - 8 * H - 600000, [wait(239819, T0 - 8 * H - 540000)]);
  // absolute fs_patch targets in the looser header forms StarNet also accepts: extra spaces, and a Move to
  run('r-casey-p1', 'deployer', T0 - 7 * H, [write('fs_patch', 'patched 1 file', T0 - 7 * H + 1000, 'op1')]);
  run('r-casey-p2', 'deployer', T0 - 7 * H + 600000, [write('fs_patch', 'patched 1 file', T0 - 7 * H + 601000, 'op2')]);
  run('r-ghost', 'cand-x', T0 - 10 * H, [wait(250000, T0 - 10 * H + 60000), wait(250000, T0 - 9 * H)]);   // not on the crew
  // absolute paths: Sam once by summary, once by fs_patch arguments (transcript), relative writes ignored
  run('r-sam-1', 'drafter', T0 - 8 * H, [write('fs_write', 'wrote ' + ROOTP + '/company/work/x.md (1 KB)', T0 - 8 * H + 1000), write('fs_edit', 'edited company/work/y.md (1x)', T0 - 8 * H + 2000)]);
  run('r-sam-2', 'drafter', T0 - 6 * H, [write('fs_patch', 'patched 1 file', T0 - 6 * H + 1000, 'p1')]);
  run('r-sam-3', 'drafter', T0 - 5 * H, [write('fs_patch', 'patched 1 file', T0 - 5 * H + 1000, 'p2')]);
  // a routine that works outside the company root: there an absolute path is right, and the correction is not shown
  runs.push({ runId: 'r-sam-off', agentId: 'drafter', startedAt: T0 - 5 * H + 600000, endedAt: T0 - 4 * H, cronJobId: 'job-off', toolTrace: [write('fs_write', 'wrote ' + ROOTP + '/company/work/q.md (1 KB)', T0 - 5 * H + 601000)] });
  // quests: two of Alex's mints with no domain although createdBy names the owner Sam; one with a domain; one too early
  const mintRow = (runId, agentId, ts, title, domain) => JSON.stringify({ streamId: 'cron-' + runId, agentId, role: 'assistant', ts, sourceRunId: runId, kind: 'turn',
    toolCalls: JSON.stringify([{ id: 'm' + ts, type: 'function', function: { name: 'shell_exec', arguments: JSON.stringify({ command: 'curl -X POST http://127.0.0.1:8801/api/quests/mint -d \'' + JSON.stringify(Object.assign({ title, agentId: 'drafter' }, domain ? { domain } : {})) + '\'' }) } }]) });
  run('r-alex-1', 'agent', T0 - 4 * H, []); run('r-alex-2', 'agent', T0 - 3 * H, []);
  const waitRow = (runId, agentId, at, timeoutMs) => JSON.stringify({ streamId: 'cron-' + runId, agentId, ts: at - 100, sourceRunId: runId, toolCalls: JSON.stringify([{ id: 'w' + at, type: 'function', function: { name: 'shell_bg_wait', arguments: JSON.stringify({ id: 'bg_1', timeoutMs }) } }]) });
  const patchRow = (runId, agentId, ts, id, patch) => JSON.stringify({ streamId: 'cron-' + runId, agentId, ts, sourceRunId: runId, toolCalls: JSON.stringify([{ id, type: 'function', function: { name: 'fs_patch', arguments: JSON.stringify({ patch }) } }]) });
  put('.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl', [
    JSON.stringify({ streamId: 's', agentId: 'drafter', ts: T0 - 6 * H + 900, sourceRunId: 'r-sam-2', toolCalls: JSON.stringify([{ id: 'p1', type: 'function', function: { name: 'fs_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Update File: ' + ROOTP + '/company/work/z.md\n@@\n-a\n+b\n*** End Patch' }) } }]) }),
    JSON.stringify({ streamId: 's', agentId: 'drafter', ts: T0 - 5 * H + 900, sourceRunId: 'r-sam-3', toolCalls: JSON.stringify([{ id: 'p2', type: 'function', function: { name: 'fs_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Update File: company/work/z.md\n@@\n-a\n+b\n*** End Patch' }) } }]) }),
    waitRow('r-casey-2', 'deployer', T0 - 9 * H + 60000, 240000),
    waitRow('r-casey-4', 'deployer', T0 - 8 * H - 540000, 300000),
    waitRow('r-robin-2', 'designer', T0 - 10 * H + 60000, 250000),
    patchRow('r-casey-p1', 'deployer', T0 - 7 * H + 900, 'op1', '*** Begin Patch\r\n***  Update File:   ' + ROOTP + '/company/work/z.md  \r\n@@\n-a\n+b\n*** End Patch'),
    patchRow('r-casey-p2', 'deployer', T0 - 7 * H + 600900, 'op2', '*** Begin Patch\n*** Update File: company/work/a.md\n*** Move to: ' + ROOTP + '/company/work/b.md\n@@\n-a\n+b\n*** End Patch'),
    mintRow('r-alex-1', 'agent', T0 - 4 * H + 5000, 'Launch notes -> company/work/a.md'),
    mintRow('r-alex-2', 'agent', T0 - 3 * H + 5000, 'Pilot checklist -> company/work/b.md'),
    mintRow('r-alex-2', 'agent', T0 - 3 * H + 9000, 'Has a domain -> company/work/c.md', 'operations'),
    mintRow('r-alex-chat', 'agent', T0 - 3 * H + 20000, 'Asked for in a chat -> company/work/d.md').replace('"streamId":"cron-r-alex-chat"', '"streamId":"chat-1"'),
  ].join('\n') + '\n');
  const quests = [
    { id: 'q:90', title: 'Launch notes -> company/work/a.md', createdBy: 'agent:drafter', agentId: 'drafter', domain: null, createdAt: T0 - 4 * H + 5000 },
    { id: 'q:91', title: 'Pilot checklist -> company/work/b.md', createdBy: 'agent:drafter', agentId: 'drafter', domain: null, createdAt: T0 - 3 * H + 5000 },
    { id: 'q:92', title: 'Has a domain -> company/work/c.md', createdBy: 'agent:drafter', agentId: 'drafter', domain: 'operations', createdAt: T0 - 3 * H + 9000 },
    { id: 'q:93', title: 'Asked for in a chat -> company/work/d.md', createdBy: 'agent:drafter', agentId: 'drafter', domain: null, createdAt: T0 - 3 * H + 20000 },
    { id: 'q:80', title: 'Before go-live', createdBy: 'agent:drafter', agentId: 'drafter', domain: null, createdAt: Date.parse('2026-11-15T12:00:00Z') },
    { id: 'q:81', title: 'Orphan quest nobody minted in a run', createdBy: 'agent:drafter', agentId: 'drafter', domain: null, createdAt: T0 - 2 * H } ];
  const putRuns = () => put('.starnet-data/workspaces/runs.jsonl', runs.map(r => JSON.stringify(r)).join('\n') + '\n');
  putRuns();
  // performance flags: Casey overdue twice (counts), limit and refusal twice (never count), Jordan failing once
  fs.appendFileSync(W('company/work/dispatch-log.md'), [
    '- 2026-11-16 01:00 PERFORMANCE FLAG Casey (deployer): overdue — 2 handoffs 2+ days past deadline: a | b; limit — 3 routine runs in a row were stopped by a spending or token limit — handed to jordan',
    '- 2026-11-16 06:00 PERFORMANCE FLAG Casey (deployer): overdue — 3 handoffs 2+ days past deadline: a | b | c; refusal — 1 routine run(s) refused — handed to jordan',
    '- 2026-11-16 07:00 PERFORMANCE FLAG Casey (deployer): limit — again; refusal — again — handed to kai',
    '- 2026-11-16 07:30 PERFORMANCE FLAG Jordan (hiring): failing — 3 routine runs in a row did not finish (3 error) — handed to alex'].join('\n') + '\n');
  const snapshot = () => { const out = {}; const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else out[path.relative(T, p)] = fs.readFileSync(p, 'utf8'); } }; walk(T); return out; };
  const base = { root: T, quests, jobs: [{ id: 'job-off', name: 'Off-root loop', agentId: 'drafter', workdir: '/elsewhere' }], noStation: true };

  // 1. dry run: finds everything, writes nothing
  const snap0 = snapshot();
  const dry = await tick(Object.assign({}, base, { now: T0, dry: true }));
  check('dry run writes nothing', () => assert.deepStrictEqual(snapshot(), snap0));
  const act = k => dry.activated.find(a => a.agentId + '|' + a.cls === k);
  check('long-wait: 2 runs after the rule -> activate for Robin (a run with two waits is one occurrence; before-rule and chat runs ignored)', () => { assert.ok(act('designer|long-wait')); assert.strictEqual(act('designer|long-wait').occurrences, 2); assert.strictEqual(dry.before.designer['long-wait'], 1); });
  check('long-wait: one occurrence is not a habit (Casey)', () => assert.ok(!act('deployer|long-wait')));
  check('long-wait: a compliant wait never counts (240000 asked, 240003 measured; 240004 with no arguments; 300000 asked but back in 239.8 s)', () => assert.strictEqual(dry.counts.deployer['long-wait'], 1));
  check('long-wait: the evidence names the requested timeout when the transcript has it', () => assert.ok(act('designer|long-wait').evidence.some(e => /asked for timeoutMs 250000 and waited 250 s/.test(e)), JSON.stringify(act('designer|long-wait').evidence)));
  check('absolute-path: patch headers parsed like StarNet (extra spaces, CRLF, Move to)', () => { const a = act('deployer|absolute-path-write'); assert.ok(a, JSON.stringify(dry.counts.deployer)); assert.strictEqual(a.occurrences, 2); });
  check('absolute-path: a routine outside the company root does not count (the correction is not shown there)', () => assert.strictEqual(dry.counts.drafter['absolute-path-write'], 2));
  check('pathsInArgs reads Add/Update/Delete/Move to/Move File like StarNet', () => assert.deepStrictEqual(module.exports._internals.pathsInArgs({ patch: '*** Add File:  a\r\n***Delete File: b\n*** Update File: c\n*** Move to: d\n*** Move File: e -> f' }), ['a', 'b', 'c', 'd', 'e', 'f']));
  check('a dry-run tick shows its would-be blocks only to a dry ensure() in the same process', () => { assert.ok(blockFor('designer', { root: T, dry: true }).includes('shell_bg_wait')); assert.strictEqual(blockFor('designer', { root: T }), ''); });
  check('non-crew agent ignored', () => assert.ok(!dry.activated.some(a => a.agentId === 'cand-x')));
  check('absolute-path: summary + fs_patch transcript args (relative patch ignored)', () => { const a = act('drafter|absolute-path-write'); assert.ok(a); assert.strictEqual(a.occurrences, 2); });
  check('quest-without-domain: attributed to the minting run (Alex), not to createdBy (the owner); domain set, minted in a chat, pre-go-live and orphan ignored', () => { const a = act('agent|quest-without-domain'); assert.ok(a, JSON.stringify(dry.activated)); assert.strictEqual(a.occurrences, 2); assert.ok(!act('drafter|quest-without-domain')); assert.deepStrictEqual(dry.unattributed, ['q:81']); });
  check('performance flags: overdue twice counts; limit and refusal never do; one failing flag is not a habit', () => { assert.ok(act('deployer|repeat-flag-overdue')); assert.ok(!act('deployer|repeat-flag-limit')); assert.ok(!act('deployer|repeat-flag-refusal')); assert.ok(!act('hiring|repeat-flag-failing')); });
  check('competence hook is off before the shadow end date', () => assert.ok(!dry.activated.some(a => a.cls.startsWith('competence-'))));
  check('FYI goes to the manager (Sam for Robin), or to Jordan when the manager is Alex or nobody', () => { assert.strictEqual(act('designer|long-wait').fyiTo, 'to-sam.md'); assert.strictEqual(act('drafter|absolute-path-write').fyiTo, 'to-jordan.md'); assert.strictEqual(act('agent|quest-without-domain').fyiTo, 'to-jordan.md'); assert.ok(!dry.handoffs.some(h => h.to === 'to-alex.md')); });

  // 2. the real tick
  const t1 = await tick(Object.assign({}, base, { now: T0 }));
  check('real tick activates the same set as the dry run', () => assert.deepStrictEqual(t1.activated.map(a => a.id).sort(), dry.activated.map(a => a.id).sort()));
  const robin = () => module.exports._internals.loadPerson(context({ root: T }), 'designer');
  check('store row has every field', () => { const c = robin().corrections[0]; for (const k of ['id', 'agentId', 'issueClass', 'title', 'whatHappened', 'rule', 'doInstead', 'example', 'by', 'at', 'status', 'lastSeenAt', 'cleanSince', 'recurrences']) assert.ok(k in c, k); assert.strictEqual(c.status, 'active'); assert.ok(c.whatHappened.evidence.length === 2); });
  check('FYI handoffs are DONE (they never wake anyone), and nothing went to Alex', () => { const p = fs.readFileSync(W('company/work/handoffs/to-sam.md'), 'utf8'); assert.ok(/standing correction designer-c1/.test(p)); assert.ok(/\*\*Status:\*\* DONE — FYI/.test(p)); assert.ok(!/\*\*Status:\*\*\s*OPEN/.test(p)); assert.strictEqual(fs.readFileSync(W('company/work/handoffs/to-alex.md'), 'utf8'), '# Handoffs\n'); });
  check('log is appended, README written', () => { const l = fs.readFileSync(W('company/work/people/corrections-log.jsonl'), 'utf8').trim().split('\n'); assert.ok(l.length >= 4); assert.ok(fs.readFileSync(W('company/work/people/corrections/README.md'), 'utf8').includes('designer-c1')); });
  check('never writes a demerit or a performance flag', () => { assert.strictEqual(fs.readFileSync(W('company/work/people/competence-events.jsonl'), 'utf8'), snap0['company/work/people/competence-events.jsonl']); assert.strictEqual(fs.readFileSync(W('company/work/dispatch-log.md'), 'utf8'), snap0['company/work/dispatch-log.md']); assert.ok(!fs.existsSync(W('company/work/performance.md'))); });
  const t2 = await tick(Object.assign({}, base, { now: T0 + 600000 }));
  check('second tick is idempotent (one active correction per person per class)', () => { assert.strictEqual(t2.activated.length + t2.recurred.length + t2.escalated.length, 0); assert.strictEqual(robin().corrections.length, 1); });

  // 3. the block
  const blk = blockFor('designer', { root: T });
  check('block: markers, one line with rule + Instead + Example, under the size limit', () => { assert.ok(blk.startsWith(START) && blk.endsWith(END)); const ls = blk.split('\n').filter(x => x.startsWith('- ')); assert.strictEqual(ls.length, 1); assert.ok(/Instead: .* Example: /.test(ls[0])); assert.ok(blk.length <= 1200); });
  check('block: empty for a person with none', () => assert.strictEqual(blockFor('engineer', { root: T }), ''));
  check('block: an absolute-path correction is left out of a routine outside the company root', () => { assert.ok(blockFor('drafter', { root: T }).includes('relative')); assert.strictEqual(blockFor('drafter', { root: T, companyRoot: false }), ''); });

  // 4. manual corrections and who may make them
  const C0 = context({ root: T, now: T0 + H });
  check('manual add: only the manager or Jordan; Alex never for his reports', () => {
    assert.throws(() => addManual(C0, 'designer', { by: 'Casey', title: 't', rule: 'r', instead: 'i', example: 'e', evidence: 'ev' }), /may not/);
    assert.throws(() => addManual(C0, 'deployer', { by: 'Alex', title: 't', rule: 'r', instead: 'i', example: 'e', evidence: 'ev' }), /may not/);
    assert.throws(() => addManual(C0, 'designer', { by: 'Sam', title: 't', rule: 'r', instead: 'i', example: 'e' }), /--evidence is required/);
    const c = addManual(C0, 'designer', { by: 'Sam', title: 'Cite the brief', rule: 'Name the brief file in every design handoff', instead: 'put its path on the Evidence line', example: 'Evidence: company/work/design/brief.md', evidence: 'two handoffs on 2026-11-15 named no brief' });
    assert.strictEqual(c.issueClass, 'manual-cite-the-brief'); assert.ok(/not cryptographically verified/.test(c.byVerified));
    assert.ok(addManual(C0, 'deployer', { by: 'jordan', title: 'Say which env', rule: 'Name the environment in every deploy note', instead: 'start the note with prod or staging', example: 'prod: api 1.4.2', evidence: 'x' }));
  });
  check('manual edit/retire: by the manager, recorded in history and log', () => {
    const c = editManual(C0, 'designer-c2', { by: 'Sam', example: 'Evidence: company/work/design/brief-v2.md' });
    assert.ok(c.history.some(h => /edited example/.test(h.change)));
    assert.throws(() => retireManual(C0, 'designer-c2', { by: 'Kai' }), /may not/);
  });
  // 5. cap at five and the size limit
  const C1 = context({ root: T, now: T0 + 2 * H });
  const { lineBudget: LB, fullLine: FL } = module.exports._internals;
  const B = LB(C1);
  check('each line\'s share of the block: ' + B + ' characters, so 5 always fit in 1,200', () => { assert.ok(B >= 200 && B <= 215, String(B)); });
  check('a hand-written line longer than its share is refused, and nothing is saved', () => {
    const n = robin().corrections.length;
    assert.throws(() => addManual(C1, 'designer', { by: 'Jordan', title: 'Too long', rule: 'A deliberately long rule text that takes up most of the room a rule may use in one line', instead: 'a deliberately long instead text that also takes most of its room so the line is too long', example: 'an example that is long as well', evidence: 'test' }), /too long for one line/);
    assert.throws(() => editManual(C1, 'designer-c2', { by: 'Sam', instead: 'x'.repeat(150) }), /too long for one line/);
    assert.strictEqual(robin().corrections.length, n); assert.ok(!robin().corrections.find(c => c.id === 'designer-c2').doInstead.includes('xxxx'));
  });
  const fullAt = i => { const f = { rule: 'Rule ' + i + ' ' + 'r'.repeat(80), instead: 'instead ', example: 'example ' + i }; f.instead += 'i'.repeat(B - FL({ rule: f.rule, doInstead: f.instead + 'i', example: f.example }).length + 1); return f; };
  for (let i = 3; i <= 5; i++) addManual(C1, 'designer', Object.assign({ by: 'Jordan', title: 'Long habit number ' + i, evidence: 'test' }, fullAt(i)));
  check('at most 5 active per person', () => assert.throws(() => addManual(C1, 'designer', { by: 'Jordan', title: 'sixth', rule: 'r', instead: 'i', example: 'e', evidence: 'x' }), /retire one first/));
  const big = blockFor('designer', { root: T });
  check('5 active corrections at full length: every one is in the block, within 1,200 characters', () => { assert.ok(big.length <= 1200, String(big.length)); assert.strictEqual(big.split('\n').filter(l => l.startsWith('- ')).length, 5); assert.ok(!/more in company/.test(big)); assert.ok(big.endsWith(END)); assert.ok(robin().corrections.filter(c => c.status === 'active').every(c => FL(c).length <= B)); });
  check('every built-in correction text fits its share of the block', () => { for (const cls of ['long-wait', 'absolute-path-write', 'quest-without-domain', 'repeat-flag-failing', 'repeat-flag-unreliable', 'repeat-flag-overdue', 'repeat-flag-stalled', 'competence-planning', 'competence-research']) { const t = module.exports._internals.builtinText(cls, C1); assert.ok(FL(t).length <= B, cls + ' ' + FL(t).length); } });

  // 6. recurrence and escalation: Robin waits long twice more after the correction is shown
  run('r-robin-3', 'designer', T0 + 3 * H, [wait(300000, T0 + 3 * H + 1000)]);
  run('r-robin-old', 'designer', T0 - 1 * H, [wait(300000, T0 + 1000)]);   // started before activation: the agent had not seen it
  putRuns();
  const t3 = await tick(Object.assign({}, base, { now: T0 + 4 * H }));
  check('one recurrence is recorded, not escalated; a run that started before activation is not a recurrence', () => { assert.strictEqual(t3.recurred.filter(r => r.id === 'designer-c1').length, 1); assert.strictEqual(t3.escalated.length, 0); });
  run('r-robin-4', 'designer', T0 + 5 * H, [wait(300000, T0 + 5 * H + 1000)]); putRuns();
  const t4 = await tick(Object.assign({}, base, { now: T0 + 6 * H }));
  check('two recurrences escalate once: OPEN gate request to Kai, DONE FYI to Jordan, status escalated', () => {
    assert.strictEqual(t4.escalated.length, 1); assert.deepStrictEqual(t4.escalated[0].to, ['to-kai.md', 'to-jordan.md']);
    const n = fs.readFileSync(W('company/work/handoffs/to-kai.md'), 'utf8'); assert.ok(/gate request: Robin/.test(n) && /\*\*Status:\*\* OPEN/.test(n));
    assert.strictEqual(robin().corrections[0].status, 'escalated');
  });
  run('r-robin-5', 'designer', T0 + 7 * H, [wait(300000, T0 + 7 * H + 1000)]); putRuns();
  const t5 = await tick(Object.assign({}, base, { now: T0 + 8 * H }));
  check('escalation happens only once; an escalated correction stays in the prompt', () => { assert.strictEqual(t5.escalated.length, 0); assert.strictEqual((fs.readFileSync(W('company/work/handoffs/to-kai.md'), 'utf8').match(/gate request/g) || []).length, 1); assert.ok(blockFor('designer', { root: T }).includes('shell_bg_wait')); });

  // 7. retirement after 14 clean days; a broken source never retires anything
  const later = T0 + 8 * H + 14 * D + H;
  fs.renameSync(W('.starnet-data/workspaces/runs.jsonl'), W('runs.hidden'));
  const t6 = await tick(Object.assign({}, base, { now: later }));
  check('no retirement while the run records cannot be read', () => { assert.ok(!t6.retired.some(r => r.id === 'designer-c1' || r.id === 'drafter-c1')); assert.ok(t6.errors.some(e => /runs/.test(e))); });
  fs.renameSync(W('runs.hidden'), W('.starnet-data/workspaces/runs.jsonl'));
  const t7 = await tick(Object.assign({}, base, { now: later }));
  check('retires after 14 clean days (escalated ones too, and manual ones)', () => { assert.ok(t7.retired.some(r => r.id === 'designer-c1')); assert.ok(t7.retired.some(r => r.id === 'drafter-c1')); assert.ok(t6.retired.some(r => r.id === 'designer-c2')); assert.ok(robin().corrections.every(c => c.status === 'retired')); });
  check('block removed when nothing is active', () => assert.strictEqual(blockFor('drafter', { root: T }), ''));
  const t8 = await tick(Object.assign({}, base, { now: later + H }));
  check('old occurrences never re-open a retired correction', () => assert.ok(!t8.activated.some(a => a.agentId === 'designer' && a.cls === 'long-wait')));

  // 8. the competence hook: off before the date even when enabled; on after it only when enabled
  put('company/work/people/corrections-policy.json', TP({ classes: { 'competence-flaw': { enabled: true } } }));
  const ce = await tick(Object.assign({}, base, { now: Date.parse('2026-12-14T12:00:00Z'), dry: true }));
  check('competence hook stays off before 2026-12-15 even when enabled', () => assert.ok(!ce.activated.some(a => a.cls.startsWith('competence-'))));
  const cf = await tick(Object.assign({}, base, { now: Date.parse('2026-12-16T12:00:00Z'), dry: true }));
  check('competence hook works after the date when enabled (same flaw from two collector versions counts once; corroborated rulings void, re-bucket or clear a flaw, an uncorroborated one does not)', () => { const a = cf.activated.find(x => x.cls === 'competence-ops'); assert.ok(a); assert.strictEqual(a.occurrences, 2); assert.ok(!cf.activated.some(x => x.cls === 'competence-design')); assert.deepStrictEqual(module.exports._internals.effectiveDemerits(fs.readFileSync(W('company/work/people/competence-events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)), Date.parse('2026-12-17T00:00:00Z')).map(e => e.id + ':' + e.bucket).sort(), ['ev_1:ops', 'ev_2:ops', 'ev_2b:ops', 'ev_4:design']); });

  // 9. the combination with routine-rules.js: idempotent, refreshes, removes when empty, keeps the house rules
  const RR = require('./routine-rules.js');
  const job = { id: 'j1', name: 'Design loop', agentId: 'designer', workdir: RR.ROOT, prompt: 'You are Robin.\n\nDo the work.' };
  const posted = [];
  const fake = async (m, p, body) => { if (m === 'GET') return { status: 200, body: JSON.stringify({ jobs: [job] }) }; posted.push(body); job.prompt = body.patch.prompt; return { status: 200, body: '{"ok":true}' }; };
  const bf = (id, o) => blockFor(id, Object.assign({ root: T }, o));
  const C2 = context({ root: T, now: later + 2 * H });
  addManual(C2, 'designer', { by: 'Sam', title: 'Name the brief', rule: 'Name the brief file in every design handoff', instead: 'put its path on the Evidence line', example: 'Evidence: company/work/design/brief.md', evidence: 'test' });
  await RR.ensure({ call: fake, blockFor: bf, log: () => {} });
  check('ensure adds the house rules and then the corrections block, once', () => { assert.ok(job.prompt.includes(RR.rulesBlock())); assert.strictEqual(job.prompt.split(START).length, 2); assert.ok(job.prompt.indexOf(RR.rulesBlock()) < job.prompt.indexOf(START)); assert.ok(job.prompt.startsWith('You are Robin.')); });
  const n1 = posted.length; await RR.ensure({ call: fake, blockFor: bf, log: () => {} });
  check('ensure is idempotent', () => assert.strictEqual(posted.length, n1));
  editManual(context({ root: T, now: later + 3 * H }), 'designer-c6', { by: 'Sam', example: 'Evidence: company/work/design/brief-v3.md' });
  await RR.ensure({ call: fake, blockFor: bf, log: () => {} });
  check('ensure refreshes a changed block in place', () => { assert.ok(job.prompt.includes('brief-v3.md') && !job.prompt.includes('design/brief.md')); assert.strictEqual(job.prompt.split(START).length, 2); });
  retireManual(context({ root: T, now: later + 4 * H }), 'designer-c6', { by: 'Sam', reason: 'fixed' });
  await RR.ensure({ call: fake, blockFor: bf, log: () => {} });
  check('ensure removes the block when the person has none, house rules stay', () => { assert.ok(!job.prompt.includes(START) && !job.prompt.includes(END)); assert.ok(job.prompt.endsWith(RR.rulesBlock())); });

  // 10. a policy that leaves no room (maxBlockChars 300): a correction that would not be shown is held, and an active
  // one that is not shown collects no recurrences and is never escalated
  put('company/work/people/corrections-policy.json', TP({ maxBlockChars: 300 }));
  const L0 = later + 6 * H;
  run('r-jor-1', 'hiring', L0 - 3 * H, [wait(300000, L0 - 3 * H + 1000)]); run('r-jor-2', 'hiring', L0 - 2 * H, [wait(300000, L0 - 2 * H + 1000)]); putRuns();
  const h1 = await tick(Object.assign({}, base, { now: L0 }));
  check('held, not activated, when it would not fit in the block', () => { assert.ok(!h1.activated.some(a => a.agentId === 'hiring'), JSON.stringify(h1.activated)); assert.ok(h1.skipped.some(s => s.agentId === 'hiring' && /would not fit/.test(s.why))); });
  put('company/work/people/corrections/engineer.json', { agentId: 'engineer', corrections: [{ id: 'engineer-c1', agentId: 'engineer', issueClass: 'long-wait', title: 'Long waits', whatHappened: { summary: 's', evidence: [] },
    rule: 'Never ask shell_bg_wait for a timeoutMs above 240000 (4 minutes), and here is a long tail of text so that this line alone does not fit in the 300-character test block', doInstead: 'wait in steps of 240000 ms or less.', example: 'timeoutMs 120000',
    status: 'active', at: new Date(L0 - H).toISOString(), lastSeenAt: new Date(L0 - H).toISOString(), cleanSince: new Date(L0 - H).toISOString(), recurrences: [] }] });
  run('r-kai-1', 'engineer', L0 + H, [wait(300000, L0 + H + 1000)]); run('r-kai-2', 'engineer', L0 + 2 * H, [wait(300000, L0 + 2 * H + 1000)]); putRuns();
  const h2 = await tick(Object.assign({}, base, { now: L0 + 4 * H }));
  check('a correction that is not shown collects no recurrences and is never escalated', () => {
    const c = module.exports._internals.loadPerson(context({ root: T }), 'engineer').corrections[0];
    assert.ok(!h2.recurred.some(r => r.id === 'engineer-c1')); assert.ok(!h2.escalated.some(r => r.id === 'engineer-c1'));
    assert.strictEqual(c.status, 'active'); assert.strictEqual(c.recurrences.length, 0); assert.strictEqual((c.whileHidden || []).length, 2);
    assert.ok(h2.skipped.some(s => s.agentId === 'engineer' && /not shown/.test(s.why)));
  });
  put('company/work/people/corrections-policy.json', TP());

  // 11. hardening: one line per handoff field; strict command-line options
  check('handoff fields stay on one line: a line break in evidence cannot start a section or an OPEN status', () => {
    const t = module.exports._internals.handoffText(context({ root: T, now: T0 }), 'h\n## x', { Status: 'DONE — FYI', Evidence: 'a/b\n**Status:** OPEN\n## fake section' });
    assert.strictEqual(t.split('\n').filter(l => /^\*\*Status:\*\*/.test(l)).length, 1); assert.ok(!/^\*\*Status:\*\*\s*OPEN/m.test(t)); assert.strictEqual(t.split(/^## /m).length, 2);
  });
  check('options are strict: tick --dry and --dryrun are refused (no real tick); --dry-run is accepted', () => {
    const pa = module.exports._internals.parseArgs;
    assert.throws(() => pa('tick', ['--dry']), /unknown option --dry .*did you mean --dry-run/); assert.throws(() => pa('tick', ['--dryrun']), /unknown option/);
    assert.throws(() => pa('list', ['--agnet', 'x']), /unknown option/); assert.throws(() => pa('retire', ['x-c1', '--by']), /needs a value/);
    assert.deepStrictEqual(pa('tick', ['--dry-run', '--json']).o, { 'dry-run': true, json: true }); assert.deepStrictEqual(pa('add', ['designer', '--by', 'Sam']).pos, ['designer']);
    const before = fs.readFileSync(W('company/state/corrections-state.json'), 'utf8');
    const r = require('child_process').spawnSync(process.execPath, [__filename, 'tick', '--dry'], { env: Object.assign({}, process.env, { CORRECTIONS_ROOT: T }), encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 2, r.stderr + r.stdout); assert.ok(/did you mean --dry-run/.test(r.stderr)); assert.strictEqual(fs.readFileSync(W('company/state/corrections-state.json'), 'utf8'), before);
  });

  if (process.env.CORRECTIONS_SELFTEST_KEEP === '1') results.push('kept fixtures in ' + T); else try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) {}
  return { results, failed };
}

/* ---------------- CLI ---------------- */
// Strict options: an unknown or misspelt option (tick --dry, --dryrun) stops the command before it does anything,
// instead of being ignored and running a real tick.
const CLI = {
  tick: { pos: 0, bool: ['dry-run', 'json'], val: ['quests-file'] }, list: { pos: 0, bool: ['all'], val: ['agent'] },
  show: { pos: 1 }, block: { pos: 1 }, selftest: { pos: 0 },
  add: { pos: 1, val: ['title', 'rule', 'instead', 'example', 'evidence', 'by', 'class'] },
  edit: { pos: 1, val: ['by', 'title', 'rule', 'instead', 'example'] },
  recur: { pos: 1, val: ['by', 'evidence'] }, retire: { pos: 1, val: ['by', 'reason'] },
};
function parseArgs(cmd, rest) {
  const s = CLI[cmd]; if (!s) return null;
  const o = {}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const x = String(rest[i]);
    if (!x.startsWith('--')) { pos.push(x); continue; }
    const k = x.slice(2);
    if ((s.bool || []).includes(k)) { o[k] = true; continue; }
    if ((s.val || []).includes(k)) { const v = rest[i + 1]; if (v == null || String(v).startsWith('--')) throw Object.assign(new Error('--' + k + ' needs a value; nothing was done'), { usage: true }); o[k] = String(v); i++; continue; }
    const hint = /^dry/i.test(k) && (s.bool || []).includes('dry-run') ? ' (did you mean --dry-run?)' : '';
    throw Object.assign(new Error('unknown option ' + x + ' for ' + cmd + hint + '; nothing was done'), { usage: true });
  }
  if (pos.length > s.pos) throw Object.assign(new Error('unexpected argument "' + pos[s.pos] + '" for ' + cmd + '; nothing was done'), { usage: true });
  return { o, pos };
}
if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  let parsed = null;
  try { parsed = parseArgs(cmd, a.slice(1)); } catch (e) { console.error('corrections: ' + e.message); process.exit(2); }
  const P0 = parsed || { o: {}, pos: [] };
  const opt = k => (k in P0.o ? P0.o[k] : null);
  const flags = ks => Object.fromEntries(ks.map(k => [k, opt(k)]).filter(([, v]) => v != null));
  const arg1 = P0.pos[0];
  const ctx = () => context({});
  const print = c => console.log(c.id + '  ' + c.status.padEnd(9) + ' ' + nameOf(ctx(), c.agentId) + ' (' + c.agentId + ')  ' + c.issueClass + '  since ' + String(c.at).slice(0, 16).replace('T', ' ') + '  recurrences ' + (c.recurrences || []).length + '\n    ' + ruleLine(c));
  (async () => {
    if (cmd === 'tick') {
      const dry = opt('dry-run') === true;
      const lines = [];
      const qf = opt('quests-file');
      const r = await tick({ dry, log: l => lines.push(l), quests: qf ? (JSON.parse(fs.readFileSync(qf, 'utf8')).quests || []) : undefined });
      if (opt('json')) { console.log(JSON.stringify(r, null, 1)); return; }
      const C = ctx();
      console.log((dry ? 'DRY RUN (nothing written) ' : '') + 'tick at ' + r.at);
      console.log('Occurrences counted per person (after each rule took effect, last ' + C.policy.windowDays + ' days):');
      const people = new Set(Object.keys(C.crew.agents).concat(Object.keys(r.counts), Object.keys(r.before)));
      for (const id of people) {
        const cnt = r.counts[id] || {}, bef = r.before[id] || {};
        const s = Object.entries(cnt).map(([k, v]) => k + ' ' + v).join(', ') || 'none';
        const b = Object.entries(bef).map(([k, v]) => k + ' ' + v).join(', ');
        console.log('  ' + nameOf(C, id).padEnd(8) + ' ' + s + (b ? '   [before the rule, not counted: ' + b + ' run(s)]' : ''));
      }
      for (const l of lines) console.log('  ' + l);
      if (!lines.length) console.log('  no corrections to activate, record, escalate or retire');
      if (r.unattributed.length) console.log('Quests with no domain and no minting run found (not counted): ' + r.unattributed.join(', '));
      for (const n of r.notes) console.log('Note: ' + n);
      for (const e of r.errors) console.log('ERROR: ' + e);
      return;
    }
    if (cmd === 'block') { const id = arg1; if (!id) throw new Error('usage: block <agentId>'); const b = blockFor(id); console.log(b || '(no standing corrections for ' + id + ')'); return; }
    if (cmd === 'list') {
      const C = ctx(); const ag = opt('agent'); const all = opt('all') === true;
      const list = allPeople(C).filter(r => !ag || r.agentId === ag).flatMap(r => r.corrections).filter(c => all || ACTIVE.has(c.status));
      if (!list.length) console.log(all ? 'no corrections' : 'no active corrections');
      for (const c of list) print(c);
      return;
    }
    if (cmd === 'show') { const hit = findCorrection(ctx(), arg1); if (!hit) throw new Error('no correction ' + arg1); console.log(JSON.stringify(hit.c, null, 1)); return; }
    if (cmd === 'add') { const c = addManual(ctx(), arg1, flags(['title', 'rule', 'instead', 'example', 'evidence', 'by', 'class'])); console.log('added ' + c.id + ' (claimed by ' + c.by + '; --by is not cryptographically verified). It reaches ' + nameOf(ctx(), c.agentId) + '\'s routine prompts within one dispatcher tick.'); print(c); return; }
    if (cmd === 'edit') { const c = editManual(ctx(), arg1, flags(['title', 'rule', 'instead', 'example', 'by'])); console.log('edited ' + c.id); print(c); return; }
    if (cmd === 'retire') { const c = retireManual(ctx(), arg1, flags(['by', 'reason'])); console.log('retired ' + c.id + ': ' + c.retireReason); return; }
    if (cmd === 'recur') { const c = recurManual(ctx(), arg1, flags(['by', 'evidence'])); console.log('recorded a recurrence on ' + c.id + ' (' + c.recurrences.length + ' so far; ' + ctx().policy.escalateAfterRecurrences + ' escalate it on the next tick)'); return; }
    if (cmd === 'selftest') { const { results, failed } = await selftest(); for (const l of results) console.log(l); console.log(failed ? failed + ' FAILED' : 'all ' + results.length + ' checks passed'); process.exit(failed ? 1 : 0); }
    console.log('usage: corrections.js tick [--dry-run] [--json] | list [--agent <id>] [--all] | show <id> | block <agentId> | add <agentId> --title --rule --instead --example --evidence --by <Name> [--class] | edit <id> --by <Name> [--title --rule --instead --example] | recur <id> --by <Name> --evidence | retire <id> --by <Name> [--reason] | selftest');
    process.exit(2);
  })().catch(e => { console.error('corrections: ' + e.message); process.exit(1); });
}
