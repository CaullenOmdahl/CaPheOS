#!/usr/bin/env node
/* external-gate.js — THE CHOKEPOINT for every action that leaves the company.
 *
 * Why this exists: an agent company holds paths that can act outside it with no human in the loop (a code host
 * signed in as the owner, a deploy platform, a chat or mail account, a model key with no cap). The risk owner's
 * inventory (company/work/security/external-capability-inventory.md) lists them; this file is the control that
 * decides whether a company tool may use one of them.
 *
 * The rule, and it fails CLOSED:
 *   1. An external action needs a CLEARANCE ROW: who cleared it (the owner or the CEO, never the acting agent), what
 *      action, on what target, until when, and the file that justified it.
 *   2. No row → the action does not happen, and the attempt is written to company/work/external-actions.jsonl
 *      with agent, category, target and the refusal reason. A refusal is a record, not an error to route around.
 *   3. Two clearers only: the owner (company.json owner.name) and the CEO seat (by its display name, read at runtime).
 *      An agent that cleared its own action is not cleared.
 *   4. One written exception: the owner channel pin (company/state/owner-channel-policy.json), by default target
 *      `owner:file` (company/owner/outbound.jsonl) for the CEO seat and the dispatcher. The CEO answering the owner
 *      on the company's own channel is not an act on the world. Everything else — another person, another channel,
 *      a public post, a deploy, a purchase, a new domain — needs a row.
 *
 *   node company/tools/external-gate.js check  --category message --target owner:file --agent <ceo-station-id>
 *   node company/tools/external-gate.js guard  --category publish --target github:<owner>/<repo>#<branch> --agent <id>
 *   node company/tools/external-gate.js clear  --by <owner or CEO name> --category publish --target github:<owner>/<repo>#<ref> \
 *                                              --until <ISO instant> --justification company/work/...md --note "..." \
                                              --acts push,comment | --own-act merge|deploy|publish|release   # a publish row names what it clears
 *   node company/tools/external-gate.js close --id <row> --by <owner or CEO name> --why "<what act consumed it>"
 *                                              # end a spent row: it records the close, never deletes the line
 *   node company/tools/external-gate.js list           # every row: state valid | pending | invalid | closed
 *   node company/tools/external-gate.js session        # is a clearing (CEO) session provable right now?
 *   node company/tools/external-gate.js --selftest      # one refusal per category; exit 1 if any category can act
 *
 * Self-governance (company/state/governance.json category external): auto = as above; notify = as above and the owner is
 * told of each allowed act on a CEO row; approve = only a row whose clearedBy is the owner clears. The externalActions
 * guardrail (company/state/guardrails.json) off = every act is logged as allowed-guardrail-off and allowed.
 *
 *   node company/tools/external-gate.js check --category spend ... [--amount-usd N]   # a spend act is also recorded by admit() (door act)
 *   node company/tools/external-gate.js check ... --idem <key> [--idem-ttl <seconds>|forever]
 *                                              # idempotent act: a key that already went out is answered duplicate
 *   node company/tools/external-gate.js idem list | sent --attempt <id> | release --category <c> --key <k> --by owner --why ".."
 *
 * Exit codes: 0 allowed, 3 refused (and logged), 4 duplicate (an idempotency key that already went out; NOT sent
 * again — the answer names the prior attempt id), 2 bad usage.
 * Module use: require this file, then `gate.check({category,target,agent,idem?})` → {allow, reason, clearanceId, clearedBy,
 * attemptId?} or {allow:false, duplicate:true, priorAttempt, priorState}
 * and `gate.mustPass(...)` which throws a GateRefusal instead of acting.
 *
 * NOT behind this gate, stated plainly: a bare `gh` (or other CLI) command run straight from a shell, and anything
 * reached through root. Those are closed by making a gated wrapper the only documented path and by the company's
 * standing rules; they are not interceptable from inside Node.
 *
 * Ownership: the tools seat (this file). Policy: the CEO. Certification: the risk seat.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const gov = require('./lib/governance');

const ROOT = co.ROOT;
const LEDGER = path.join(ROOT, 'company', 'state', 'external-clearances.jsonl');
const LOG = path.join(ROOT, 'company', 'work', 'external-actions.jsonl');
const ALLOWLIST = path.join(ROOT, 'company', 'state', 'external-allowlist.txt');
// Where justification and claim-source files are resolved. The selftest points it at a scratch tree so it never
// depends on (or writes) the live company's files.
let FILE_ROOT_OVERRIDE = null;
const fileRoot = () => FILE_ROOT_OVERRIDE || ROOT;

/* ---- PROVENANCE: who may record a clearance ----
 * `clear --by <CEO name>` alone is a string any agent could type, and an agent-authored row naming the CEO would then
 * authorise an act for a different agent. Nothing on this machine can PROVE who ran a process — every agent is the
 * same OS user on the same filesystem, so a signing key here would be a key every agent can read. What can be proven
 * is that a row was written while a CEO run existed: StarNet records every run (agent, startedAt, endedAt) in
 * runs.jsonl, and the station knows whether the CEO's routine is in flight right now. So a row is clearance only when
 * (a) it was recorded by the CEO session, and (b) a CEO run covers the moment it claims. That turns "someone typed the
 * CEO's name" into "a claim with a record behind it", and makes a forgery detectable by any later audit. */

/* ---- WHAT THE LEDGER IS ----
 * The clearance ledger is an AUDIT RECORD, not a permission system. No file permission, mode bit or signature on this
 * machine can prove who wrote a row. What the ledger buys is the opposite of secrecy: a claimed clearance that names a
 * person, a target, an expiry, a justifying file and the run it was written inside — so a later reader can check the
 * claim instead of trusting it, and a forged row is visibly inconsistent rather than invisible. If a future decision
 * needs a real permission, it needs something this machine does not have (a key only the CEO session can reach). */
const RUNS = path.join(ROOT, '.starnet-data', 'workspaces', 'runs.jsonl');
const CLEARING_AGENT = co.ceo() || 'agent';   // the CEO's station id — the only session allowed to record a clearance row
const CEO_NAME = co.nameOf(CLEARING_AGENT);
const OWNER_NAME = (co.config.owner && co.config.owner.name) || 'Owner';
const PROVENANCE_GRACE_MS = 3 * 60 * 1000;    // a row may be written seconds after the CEO's run closes, not later
// A run with no `endedAt` would otherwise cover Infinity, so a run that never recorded its end would make EVERY later
// forged row "written inside a CEO run". An unterminated run covers a bounded window only; the number is policy and
// belongs to the risk seat — change it in one place.
const PROVENANCE_MAX_OPEN_MS = 30 * 60 * 1000;
let RUNS_OVERRIDE = null;              // selftest injects a synthetic CEO run; never set outside a test

/* ---- LIVE PROVENANCE, SECOND SOURCE: the station's run journal ----
 * /api/cron's `lastRunAt` points at the run that ENDED, so on that view alone the gate is open for the grace after the
 * previous run and shut again while the CEO is still working — and the honest case, a row written mid-run, fails.
 *
 * The station records every run in its own journal: `.starnet-data/workspaces/.run-journal/<sha256(runId)>.jsonl`,
 * created at run start with a `begin` record carrying runId, agentId, cronJobId and startedAt, and appended to for the
 * life of the run. That is evidence of a run IN FLIGHT. A source only counts when all four of these hold:
 *   (a) the journal's first record is `begin` for the CEO's station id — a worker run is not a clearing session;
 *   (b) the run is not in runs.jsonl with an endedAt — the station has not recorded it as finished;
 *   (c) the journal file was written within JOURNAL_QUIET_MS — a run that stopped writing is not proven live;
 *   (d) the record is the newest qualifying one, and addClearance stamps its runId onto the row.
 * A stale `inFlight` flag still proves nothing, and nothing here is read from a flag. The residual window is bounded:
 * a run killed hard (no endedAt, journal frozen) keeps this source open for at most JOURNAL_QUIET_MS after its last
 * write. Fail closed: unreadable directory, unparseable journal and empty result all answer "no live session".
 *
 * Reading the journal robustly:
 *   - the begin record carries the whole directive as `directiveTitle`, so its first line can be tens of KB; the read
 *     grows up to 1 MB instead of taking a fixed-size prefix;
 *   - every file that does not qualify carries a reason, and the error sentence says how many files were examined;
 *   - a record that names no `agentId` names a ROUTINE (`cronJobId`), which the station's scheduler maps to the agent
 *     that runs it (read from /api/cron, never from a flag). A record that DOES name an agent is authoritative and is
 *     never re-attributed by that lookup. */
const JOURNAL_DIR = path.join(ROOT, '.starnet-data', 'workspaces', '.run-journal');
const JOURNAL_QUIET_MS = 15 * 60 * 1000;   // a live run must have written to its journal inside this window
let JOURNAL_DIR_OVERRIDE = null;           // selftest points this at a throwaway directory
const SCHEDULER_URL = co.STATION_URL.replace(/\/+$/, '') + '/api/cron';
let SCHEDULER_OVERRIDE = null;             // selftest injects a routine→agent map; never set outside a test
let schedulerCache = { at: 0, map: null, error: null };
const SCHEDULER_CACHE_MS = 30 * 1000;
function stationCron() {
  const token = co.stationToken();
  return require('child_process').execFileSync('curl', ['-s', '--max-time', '5', '-H', 'x-starnet-token: ' + token,
    SCHEDULER_URL], { encoding: 'utf8', timeout: 8000 });
}
function schedulerAgents() {
  if (SCHEDULER_OVERRIDE) return { map: SCHEDULER_OVERRIDE, error: null };
  const now = nowMs();
  if (schedulerCache.map && now - schedulerCache.at < SCHEDULER_CACHE_MS) return { map: schedulerCache.map, error: null };
  try {
    const body = stationCron();
    const jobs = (JSON.parse(body) || {}).jobs || [];
    const map = {};
    for (const j of jobs) { if (j && j.id) map[String(j.id)] = String(j.agentId || ''); }
    schedulerCache = { at: now, map, error: null };
    return { map, error: null };
  } catch (e) {
    schedulerCache = { at: 0, map: null, error: String((e && e.message) || e) };
    return { map: null, error: schedulerCache.error };
  }
}
// The station names each journal `sha256(runId).jsonl`, so requiring that name is free and it costs a fabricator a second lie: a hand-written journal under an arbitrary name
// is skipped, and a correctly named forgery names a runId that never appears in runs.jsonl once the "run" closes.
function sha256Hex(s) { return require('crypto').createHash('sha256').update(String(s)).digest('hex'); }

/* ---- LEGACY ROWS: company data, not code ----
 * Two rules below (the prefix stamp and the own-act rule) cannot judge a row that was written before they existed. A
 * company that adopts this gate on a ledger that already holds such rows lists their ids in
 * `company/state/external-gate-legacy.json` (a locked state file: locked-watch.js reports any edit to it):
 *   { "unstamped": ["<id>", ...],           // rows written before the prefix stamp: accepted without a stamp
 *     "publishWithoutActs": ["<id>", ...] } // publish rows written before acts/ownAct: still answer, flagged unnarrowed
 * A missing, unreadable or malformed file is the neutral default: both lists empty, so nothing is exempt. An id cannot be
 * added by the row itself, only by editing that file, so the exemption is a decision with a diff, not a field a writer types.
 * Delete an id once its row has expired. */
const LEGACY_FILE = path.join(ROOT, 'company', 'state', 'external-gate-legacy.json');
let LEGACY_OVERRIDE = null;               // selftest points this at a throwaway legacy list
function legacyIds() {
  const j = LEGACY_OVERRIDE || co.readJson(LEGACY_FILE, null);
  const list = v => new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);
  return { unstamped: list(j && j.unstamped), publishWithoutActs: list(j && j.publishWithoutActs) };
}

/* ---- ORDER RULE ----
 * A row's `at` is whatever its writer typed (every agent shares the ledger's uid), so provenance bound to `at` alone
 * lets a row appended NOW but dated inside a past CEO run pass. The ledger is append-only, so file order is the only
 * write-time evidence there is: a row dated EARLIER than a row above it, or later than now, was not written when it says.
 * `orderViolations(rows, now)` returns {index: reason}. A violating row never raises the high-water mark, so one forged
 * row cannot make every legitimate row after it look backdated. ORDER_SKEW_MS absorbs two writers racing by seconds.
 * LIMIT, stated not fixed: a forged row dated AFTER the newest real row (inside a recent run), or the first row of an
 * empty ledger, has nothing above it to contradict it; those ride on the live-session check, not on this rule. */
const ORDER_SKEW_MS = 2 * 60 * 1000;
function orderViolations(rows, now) {
  const out = {};
  let high = -Infinity;
  (rows || []).forEach((row, i) => {
    const t = Date.parse(String(row && row.at || ''));
    if (!Number.isFinite(t)) return;               // validateRow already refuses a row with no usable timestamp
    if (t > now + ORDER_SKEW_MS) { out[i] = 'dated ' + new Date(t).toISOString() + ', in the future — a row cannot be written before it exists'; return; }
    if (t < high - ORDER_SKEW_MS) { out[i] = 'dated ' + new Date(t).toISOString() + ' but sits below a row dated ' + new Date(high).toISOString() + ' — backdated, not written when it says'; return; }
    if (t > high) high = t;
  });
  return out;
}

/* ---- PREFIX STAMP ----
 * The order rule cannot see a forged row when the ledger holds one row, or when it is dated after the newest real row:
 * there is nothing above it to contradict it. So `addClearance` stamps each row it writes with `prefixSha`: sha256 over
 * the canonical bytes of every line ABOVE it (clearances and close records alike) plus the row's own
 * id|at|category|target|agent. `check()` recomputes it. A row that was appended by hand later, moved, re-dated (the
 * row's `at` is inside its own stamp), or written above lines that were edited or inserted, no longer matches. A close is
 * an appended line (it never rewrites a row), so closing a row does not disturb the stamps below it. NOT mtime: `touch`
 * and any rewrite set mtime, so it proves nothing.
 * A row with NO stamp is accepted only if its id is in the `unstamped` list of the legacy file (above). There is no
 * "unstamped but dated just now" arm: it would leave a typed row valid for the skew window inside a live CEO run.
 * LIMIT, stated not fixed: every agent shares the ledger's uid, so someone who reads this function can compute a
 * matching stamp. The stamp turns a one-line edit into a deliberate act that a reader of the ledger can recompute and a
 * diff of this file shows; it does not make the ledger tamper-proof. A retention roll (company/tools/retention.js) that
 * removes lines above a live row changes that row's prefix: the row then needs to be re-cleared. */
function canonRow(row) { return JSON.stringify(row); }
function stampFor(rowsAbove, row) {
  const prefix = sha256Hex((rowsAbove || []).map(canonRow).join('\n'));
  return sha256Hex(prefix + '|' + [row.id, row.at, row.category, row.target, row.agent].join('|'));
}
function stampViolations(rows, now) {
  const out = {};
  const legacy = legacyIds().unstamped;
  (rows || []).forEach((row, i) => {
    if (!row || typeof row !== 'object' || row.type === 'close') return;
    if (typeof row.prefixSha === 'string' && row.prefixSha) {
      if (stampFor(rows.slice(0, i), row) !== row.prefixSha) out[i] = 'prefix stamp does not match: the ledger above this row, or the row\'s own id/at/target, is not what it was when `clear` wrote it';
      return;
    }
    if (legacy.has(row.id)) return;
    const t = Date.parse(String(row.at || ''));
    out[i] = 'unstamped row, not in the legacy list: only `clear` writes a row that lasts (no prefix stamp, dated ' + (Number.isFinite(t) ? new Date(t).toISOString() : 'nothing usable') + ')';
  });
  return out;
}
let LEGACY_ALL = false;   // selftest only: the pre-rule cases run as legacy rows (no stamp needed, no act needed); the new-rule cases turn it off
// Order and stamp verdicts for the ledger's lines, aligned with the clearance rows ledgerRows() returns (close records
// are lines of the ledger but not clearances, so they take no slot in the result).
function ledgerVerdicts(all, now) {
  const ob = orderViolations(all, now), sb = LEGACY_ALL ? {} : stampViolations(all, now);
  const out = [];
  (all || []).forEach((r, i) => { if (!(r && r.type === 'close')) out.push(ob[i] || sb[i] || null); });
  return out;
}

/* runs.jsonl is StarNet's and only grows (docs/RETENTION.md: StarNet owns its retention), so a check never parses all of
 * it. readRuns() is the last RUNS_WINDOW_MS of it, read from the end (lib/bounded.js jsonlWindow: the file is appended as
 * runs END, so it is in endedAt order) and kept per process while the file is unchanged. That window answers every
 * question about runs in flight or just finished. A clearance row written BEFORE the window (a long-lived row) is
 * matched by runsAround(at): a binary search of the file for the rows that ended around `at`, at most a few MB read.
 * Either way the rows come from runs.jsonl itself, never from a copy an agent could edit. */
const B = require('./lib/bounded');
const RUNS_WINDOW_MS = 72 * 3600 * 1000;
const RUNS_SEEK_SPAN = 8 * 1024 * 1024;
let runsCache = null;
let RUNS_FILE_OVERRIDE = null;          // in-process tests only (setRunsFile)
const runsFile = () => RUNS_FILE_OVERRIDE || RUNS;
const runOk = r => r && r.runId && r.agentId && Number.isFinite(r.startedAt);
function readRuns() {
  if (RUNS_OVERRIDE) return RUNS_OVERRIDE;
  let st; try { st = fs.statSync(runsFile()); } catch (_) { return []; }
  const key = runsFile() + ':' + st.size + ':' + st.mtimeMs;
  if (runsCache && runsCache.key === key && nowMs() - runsCache.at < 60 * 1000) return runsCache.rows;
  const since = nowMs() - RUNS_WINDOW_MS;
  const w = B.jsonlWindow(runsFile(), { sinceMs: since, maxBytes: 64 * 1024 * 1024 });
  const rows = w.rows.filter(runOk);
  runsCache = { key, at: nowMs(), since: w.truncated ? Infinity : since, rows };
  return rows;
}
// rows of runs that ended around `at` (a run covers a moment from its start to its end plus the grace)
function runsAround(at) {
  if (RUNS_OVERRIDE) return RUNS_OVERRIDE;
  try { return B.jsonlSeek(runsFile(), at, { backMs: PROVENANCE_GRACE_MS + 60 * 1000, spanBytes: RUNS_SEEK_SPAN }).filter(runOk); } catch (_) { return []; }
}
// the runs that can cover `at`: the recent window, plus the file around `at` when `at` is older than the window can answer
function runsFor(at) {
  const recent = readRuns();
  if (RUNS_OVERRIDE || !Number.isFinite(at)) return recent;
  const from = runsCache ? runsCache.since : nowMs() - RUNS_WINDOW_MS;
  if (at - PROVENANCE_GRACE_MS - 60 * 1000 >= from + 12 * 3600 * 1000) return recent;   // a run ending up to 12 h after `at` is inside the window
  const ids = new Set(recent.map(r => r.runId));
  return recent.concat(runsAround(at).filter(r => !ids.has(r.runId)));
}

// The CEO run that covers `at` — the moment inside its window, or within the grace after it ended — or null.
function clearingRunFor(at) {
  let best = null;
  for (const r of runsFor(at)) {
    if (String(r.agentId) !== CLEARING_AGENT) continue;
    const start = r.startedAt - 60 * 1000;
    const end = Number.isFinite(r.endedAt) ? r.endedAt + PROVENANCE_GRACE_MS : r.startedAt + PROVENANCE_MAX_OPEN_MS;
    if (at >= start && at <= end && (!best || r.startedAt > best.startedAt)) best = r;
  }
  return best;
}

// First line of a file, bounded — a run journal can be megabytes and only the `begin` record matters here.
/* The `begin` record carries the whole directive as `directiveTitle`, so a first line can be far longer than any fixed
 * read. The bound grows up to 1 MB; past that the caller is told the record was too long rather than being handed a
 * fragment that looks like a corrupt journal. */
const FIRST_LINE_MAX = 1024 * 1024;
function firstLine(file, maxBytes) {
  const cap = maxBytes || FIRST_LINE_MAX;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    let size = Math.min(16384, cap);
    for (;;) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf8');
      const i = text.indexOf('\n');
      if (i !== -1) return text.slice(0, i);
      if (n < buf.length || buf.length >= cap) return text;   // end of file, or the 1 MB cap: the caller decides
      size = Math.min(cap, buf.length * 2);
    }
  } catch (_) {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Who ran this run, from the record itself. A named agent is authoritative; a record that names none is resolved from
// the routine it names (see the run-journal notes above). Never a flag, never a default, and the reason is always returned.
function journalIdentity(p) {
  const own = p && typeof p.agentId === 'string' ? p.agentId.trim() : '';
  if (own) return { agent: own, source: 'begin.agentId', why: '' };
  const jobId = p && typeof p.cronJobId === 'string' ? p.cronJobId.trim() : '';
  if (jobId) {
    const s = schedulerAgents();
    const agent = s.map ? String(s.map[jobId] || '') : '';
    if (agent) return { agent, source: 'scheduler.cronJobId', why: '' };
    return { agent: '', source: null, why: 'begin names no agentId and routine ' + jobId.slice(0, 8) + '… is not resolvable (' + (s.error ? 'scheduler unreadable: ' + s.error : 'no such routine') + ')' };
  }
  return { agent: '', source: null, why: 'begin names no agentId and no routine — this record cannot prove who ran it' };
}

// A CEO run in flight, proven from the station's own run journal. Returns { live:false, error } with the reason when
// nothing qualifies — never a "cannot tell" that a caller could read as permission.
function liveJournalRun(at) {
  const now = Number.isFinite(at) ? at : nowMs();
  const dir = JOURNAL_DIR_OVERRIDE || JOURNAL_DIR;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
  catch (e) { return { live: false, runId: null, error: 'run journal unreadable (' + (e.code || e.message) + ') at ' + path.relative(ROOT, dir) }; }
  const completed = new Set(readRuns().filter(r => Number.isFinite(r.endedAt)).map(r => r.runId));
  let best = null, quiet = 0, finished = 0, otherAgent = 0, misnamed = 0, noIdentity = 0;
  const skipped = [];   // EVERY file that does not qualify says why: a silent `continue` makes a failure unreadable.
  for (const f of files) {
    const abs = path.join(dir, f);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { skipped.push(f.slice(0, 12) + '…: unreadable (' + ((e && e.code) || 'stat') + ')'); continue; }
    if (now - st.mtimeMs > JOURNAL_QUIET_MS) { quiet++; continue; }
    const line = firstLine(abs);
    let begin = null;
    try { begin = JSON.parse(line); } catch (_) {
      skipped.push(f.slice(0, 12) + '…: first record is not one line of JSON (' + Buffer.byteLength(line, 'utf8') + ' bytes read'
        + (Buffer.byteLength(line, 'utf8') >= FIRST_LINE_MAX ? ', at the 1 MB bound' : '') + ')');
      continue;
    }
    if (!begin || begin.type !== 'begin') { skipped.push(f.slice(0, 12) + '…: first record is "' + (begin && begin.type) + '", not begin'); continue; }
    const p = begin.payload || {};
    const id = journalIdentity(p);
    if (!id.agent) { noIdentity++; skipped.push(f.slice(0, 12) + '…: ' + id.why); continue; }
    if (id.agent !== CLEARING_AGENT) { otherAgent++; skipped.push(f.slice(0, 12) + '…: run was agent "' + id.agent + '" (' + id.source + ')'); continue; }
    // The top-level record names the run too; a payload that omits it is not a reason to discard a live journal.
    const runId = String(p.runId || begin.runId || '');
    const startedAt = Number.isFinite(p.startedAt) ? p.startedAt : begin.ts;
    if (!runId || !Number.isFinite(startedAt)) { skipped.push(f.slice(0, 12) + '…: begin names no runId/startedAt'); continue; }
    if (f !== sha256Hex(runId) + '.jsonl') { misnamed++; skipped.push(f.slice(0, 12) + '…: runId ' + runId.slice(0, 8) + '… does not hash to this file name'); continue; }
    if (completed.has(runId)) { finished++; continue; }
    if (!best || startedAt > best.startedAt) best = { runId, jobId: p.cronJobId || null,
      startedAt, journal: f, agentId: id.agent, identitySource: id.source };
  }
  if (best) return Object.assign({ live: true, error: null, source: 'run-journal' }, best);
  const why = files.length === 0 ? 'no run journals on disk'
    : 'no live CEO run in the journal (' + files.length + ' file(s): ' + quiet + ' quiet, ' + finished + ' finished, ' + otherAgent + ' another agent, '
      + noIdentity + ' with no identity, ' + misnamed + ' misnamed)'
      + (skipped.length ? ' — ' + skipped.slice(0, 6).join('; ') : '');
  return { live: false, runId: null, error: why };
}

// Live view: is the CEO session running right now? Fail closed if the station cannot be read, because "I could not
// check" and "there was no session" must have the same answer at a chokepoint.
function liveClearingSession() {
  if (RUNS_OVERRIDE) return { live: true, inFlight: true, jobId: 'selftest', lastRunAt: null, error: null, source: 'selftest' };
  if (process.env.EXTERNAL_GATE_SESSION === 'none') return { live: false, error: 'station session check disabled by EXTERNAL_GATE_SESSION=none (test only)' };
  // Source 1: a run in flight, read from the station's run journal. This is the source that stays true
  // for the whole of a long session; the cron view below only knows when the previous run ended.
  const journal = liveJournalRun(nowMs());
  if (journal.live) {
    return { live: true, inFlight: true, runId: journal.runId, startedAt: journal.startedAt, jobId: journal.jobId,
      lastRunAt: null, error: null, source: 'run-journal', identitySource: journal.identitySource || null };
  }
  let body = '';
  try {
    body = stationCron();
  } catch (e) { return { live: false, error: 'station API unreachable (' + e.message + ') — cannot prove a CEO session, so no row is written' }; }
  let jobs = [];
  try { jobs = (JSON.parse(body) || {}).jobs || []; } catch (_) { return { live: false, error: 'station API returned an unparseable job list' }; }
  // The CEO's routine: the job the scheduler runs as the CEO's station id, or (older stations) the loop name in loops.json.
  const loopName = String(((co.crew()[CLEARING_AGENT]) || {}).loop || '').toLowerCase();
  const job = jobs.find(j => j && String(j.agentId || '') === CLEARING_AGENT)
    || (loopName ? jobs.find(j => j && String(j.name || '').toLowerCase().startsWith(loopName)) : null);
  if (!job) return { live: false, error: 'no CEO routine on the station — the clearing session cannot be identified; journal: ' + journal.error };
  const last = job.lastRunAt ? Date.parse(job.lastRunAt) : 0;
  const recent = Number.isFinite(last) && last > 0 && (nowMs() - last) <= PROVENANCE_GRACE_MS;
  // `inFlight` can be a STALE flag: a job can report state "scheduled" with inFlight: true long after the run closed,
  // and a bare flag would make this function report a live CEO session — so a worker shell could write a row stamped
  // with the CEO's name that then AUTHORISES.
  // A flag counts as a live clearing session only when the station says the job is RUNNING, or when the flag is
  // corroborated by a run that ended inside the grace window. A stale flag with no recent run is UNKNOWN, and
  // UNKNOWN fails closed: no row, no authorisation.
  const stateRunning = String(job.state || '').toLowerCase() === 'running';
  const inFlight = stateRunning || (!!job.inFlight && recent);
  return { live: inFlight || recent, inFlight: inFlight, jobId: job.id || null, lastRunAt: job.lastRunAt || null,
    error: (inFlight || recent) ? null : CEO_NAME + ' (CEO) has no run in flight and the last CEO run ended more than ' + Math.round(PROVENANCE_GRACE_MS / 60000) + ' minutes ago; journal: ' + journal.error };
}

// The literal part of a target pattern. `*` is the only wildcard; a pattern made of nothing but wildcards clears
// every target in its category, which is not a clearance but a blank cheque.
function targetStem(target) {
  const t = String(target || '');
  const i = t.indexOf('*');
  return (i === -1 ? t : t.slice(0, i)).trim();
}
function targetStemOk(target) {
  // The literal part must be a SUBJECT, not the scheme word: stripping only non-alphanumerics would let `github:*`
  // reduce to `github` — six letters of scheme — and pass as if it named something.
  const stem = targetStem(target).replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '');
  return stem.replace(/[^A-Za-z0-9]/g, '').length >= 3;
}

/* ---- ROW SCOPE ----
 * A row written for one change that names only `github:<owner>/<repo>` (and puts the change in its note) clears any
 * push or PR on that repository until it expires: the gate matches on the target, not the note — a green record over
 * a subject it does not cover. The fix is not to parse the note (a note is for the human reading the row); it is to require the thing being cleared
 * to name itself. A `github:` act is a repository AT A REF, so the ref is part of the target:
 *     github:<owner>/<repo>#<branch|sha>        e.g. github:example-org/example-app#fix/login-timeout
 * Scoped to `github:` on purpose: a deploy target names an environment, which is already the act. Wildcards inside a
 * ref are refused — a ref prefix is how "the branch I meant" becomes "any branch of mine". */
function isGithubTarget(t) { return /^github:/i.test(String(t || '').trim()); }
function refOf(target) { const t = String(target || ''); const i = t.indexOf('#'); return i === -1 ? '' : t.slice(i + 1).trim(); }
function publishScopeOk(target, who) {
  if (!isGithubTarget(target)) return null;
  const t = String(target).trim();
  const ref = refOf(t);
  if (!ref) return 'a publish clearance must name the ref it acts on — the ' + who + ' target "' + t + '" names a repository, not an act; write github:<owner>/<repo>#<branch|sha>';
  if (ref.includes('*')) return 'a publish target may not wildcard its ref ("' + ref + '") — a ref prefix is how "the branch I meant" becomes "any branch of mine"';
  return null;
}

/* ---- ACTS ----
 * Without this, a row written to allow a COMMENT and a row written to allow a MERGE are the same permission, because check()
 * matches on category + target + agent only. `acts` narrows a row without touching that matching: a row may list the
 * narrow acts it covers, and a request that names an act must find it listed. The one thing it may never do is
 * SMUGGLE: a list containing merge, deploy or publish is refused as malformed rather than silently narrowed, because a
 * row that overshoots its own schema is a row nobody checked. No row can cover a merge or a deploy second-hand. */
const ACTS_NARROW = ['push', 'comment', 'edit_body', 'issue_create', 'review'];
const ACTS_OWN_ROW = ['merge', 'deploy', 'publish', 'release'];
function actsWhy(row) {
  const acts = row && row.acts;
  if (acts === undefined || acts === null) return null;
  if (!Array.isArray(acts) || !acts.length) return 'acts must be a non-empty list of narrow acts (' + ACTS_NARROW.join(', ') + ')';
  for (const a of acts) {
    const v = norm(a);
    if (!v) return 'acts contains an empty entry';
    if (ACTS_OWN_ROW.includes(v)) return '"' + a + '" may not be narrowed into an acts list: a merge or a deploy always keeps its own row';
    if (!ACTS_NARROW.includes(v)) return 'unknown act "' + a + '" — a row may only list: ' + ACTS_NARROW.join(', ');
  }
  return null;
}
/* ---- OWN ACT ----
 * A publish row with no acts answered for EVERY act in the category: a row written for a comment cleared a merge. A
 * publish row therefore says what it clears: `acts` (narrow acts) OR `ownAct` (one of merge, deploy, publish, release),
 * never both, and a publish REQUEST must name its act. Rows that predate the rule are the `publishWithoutActs` list of
 * the legacy file, keyed by id and not by `at`: `at` is whatever the writer typed, so a date cutover is beaten by dating a
 * row earlier. They stay unnarrowed and are still reported as such by `list`. */
const isLegacy = (id) => LEGACY_ALL || legacyIds().publishWithoutActs.has(id);
function narrowWhy(row) {
  const hasActs = !!row && row.acts !== undefined && row.acts !== null;
  const hasOwn = !!row && row.ownAct !== undefined && row.ownAct !== null;
  if (hasActs && hasOwn) return 'a row carries acts or ownAct, never both';
  if (hasOwn) {
    if (typeof row.ownAct !== 'string') return 'ownAct must be one string, not a list: ' + ACTS_OWN_ROW.join(', ');
    if (!ACTS_OWN_ROW.includes(norm(row.ownAct))) return 'unknown ownAct "' + row.ownAct + '" — it must be one of: ' + ACTS_OWN_ROW.join(', ');
  }
  if (!hasActs && !hasOwn && norm(row && row.category) === 'publish' && !isLegacy(row && row.id)) {
    return 'a publish row must name what it clears: acts [' + ACTS_NARROW.join(', ') + '] or ownAct (' + ACTS_OWN_ROW.join(', ') + ')';
  }
  return null;
}
// An unrelated file cannot clear an action (a forgery class): the justifying document must name what it justifies.
function justificationSupports(abs, target) {
  const stem = targetStem(target);
  if (!stem) return false;
  try { return norm(fs.readFileSync(abs, 'utf8')).includes(norm(stem)); } catch (_) { return false; }
}

// The six categories of external act. Anything else is refused as an unknown category.
const CATEGORIES = {
  message: 'an outbound message to a person or channel outside the company (chat, email, social, any new channel)',
  publish: 'publishing, uploading, releasing or deploying anything that becomes visible outside the company',
  account: 'creating an account, or requesting/receiving credentials for one',
  form: 'submitting a form, application or request to a third party',
  spend: 'placing a purchase or any spend outside the company',
  network: 'an HTTP request from a company tool to a domain that is not on the company allowlist',
};

/* Only two clearers: the owner (the word "owner", or the owner's name from company.json) and the CEO seat by its
 * display name, read at runtime. "CEO" is a title, not an identity, so it is not accepted (lowercase compare). */
const CLEARERS = Array.from(new Set(['owner', norm(OWNER_NAME), norm(CEO_NAME)].filter(x => x && x !== 'ceo')));
const CLEARER_WORDS = 'the owner (' + OWNER_NAME + ') or the CEO (' + CEO_NAME + ')';

/* ---- THE OWNER CHANNEL: a pinned subject, not a class name ----
 * A branch that allows `message` to anything spelled like "owner" is a string a caller can type. Instead: the subject
 * is one exact target (by default `owner:file`, the file adapter at company/owner/outbound.jsonl), compared for exact
 * equality; the senders are named gate identities (the token "ceo" means the CEO seat's station id, resolved at
 * runtime; "dispatcher" is the batching process); the category is `message`; and the pin's LIFE (target, senders,
 * until) lives in a policy file that locked-watch watches, so ending the channel is an edit with a diff, not a code
 * change. `until` null or absent = no expiry; a past instant kills the pin. A message target that is a class name or a
 * wildcard is MALFORMED, not narrowed — a narrowing invites a rewrite of the request; malformed names the rule.
 *
 * Strength, stated honestly: this does not make the channel safe. It makes it bounded and countable — one subject,
 * named senders, every send logged with an authoring identity, revocable by a file edit. */
const OWNER_PIN_FILE = path.join(ROOT, 'company', 'state', 'owner-channel-policy.json');
// A class name in the recipient position is the defect itself, in any spelling. Addresses and ids are not.
const MESSAGE_CLASS_NAMES = ['owner', 'pm', 'user', 'recipient', 'staff', 'everyone', 'everybody', 'anyone', 'all', 'any', 'me', 'self'];
function messageTargetWhy(target, who) {
  const t = String(target == null ? '' : target).trim();
  const i = t.indexOf(':');
  if (i <= 0 || i === t.length - 1) return 'a ' + who + ' target must be prefix:id ("owner:file", "email:<address>") — "' + t + '" names no recipient';
  const stem = t.slice(0, i).toLowerCase();
  const rest = t.slice(i + 1);
  if (rest.includes('*')) return 'a ' + who + ' target may not wildcard its recipient ("' + t + '") — a wildcard is how "the owner" becomes "anyone"';
  if (!/^[a-z0-9_-]+$/.test(stem)) return 'a ' + who + ' target has no usable prefix ("' + t + '")';
  if (MESSAGE_CLASS_NAMES.includes(rest.trim().toLowerCase())) {
    return 'malformed ' + who + ' target "' + t + '": a class name is not a recipient — the target is a concrete id, and for the owner it is the pinned channel (see company/state/owner-channel-policy.json)';
  }
  return null;
}
function readOwnerPin() {
  try { return JSON.parse(fs.readFileSync(OWNER_PIN_FILE, 'utf8')); } catch (_) { return null; }
}
/* The pin matches only on exact equality of the resolved target, a sender in the list, the policy's category and a
 * live `until`. Anything else returns null and the request goes to the ledger like every other act. */
function ownerPinFor(req, at, opts) {
  const pin = (opts && opts.ownerPin !== undefined) ? opts.ownerPin : readOwnerPin();
  if (!pin || !pin.target) return null;
  const cat = norm(pin.category || 'message');
  if (norm(req.category) !== cat) return null;
  if (String(req.target == null ? '' : req.target).trim() !== String(pin.target).trim()) return null;
  // "ceo" is a role token resolved to the CEO seat's station id; any other entry is a literal gate identity.
  const senders = Array.isArray(pin.senders) ? pin.senders.map(x => (norm(x) === 'ceo' ? norm(CLEARING_AGENT) : norm(x))) : [];
  if (!senders.includes(norm(req.agent))) return null;
  if (pin.until !== null && pin.until !== undefined && pin.until !== '') {
    const until = Date.parse(String(pin.until));
    if (!Number.isFinite(until) || until <= at) return null;   // an unparseable or past until clears nothing
  }
  return pin;
}

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function nowMs() { return Date.now(); }

function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const r = JSON.parse(t); if (r && r._retention) continue; rows.push(r); } catch (_) { /* a corrupt row proves nothing — it can never clear an action */ }   // _retention: the pointer a retention roll leaves
  }
  return rows;
}

function appendJsonl(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return true;
  } catch (_) { return false; }
}

/* `*` matches any run of characters; everything else is literal. A pattern with no `*` matches the whole target
 * exactly, so `github:owner/repo` never matches `github:owner/repo-fork`. */
function targetMatches(pattern, target) {
  const p = norm(pattern), t = norm(target);
  if (!p) return false;
  if (!p.includes('*')) return p === t;
  const rx = new RegExp('^' + p.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(t);
}

function readAllowlist(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

// The allowlist is a data file any agent can append to, so the `network` category is one line wide and the gate cannot
// tell a ruling from an edit. The digest does not stop the edit — nothing on this box can — but it writes into every
// allowlist decision which version of the file allowed it, so a changed file is visible in the log and in the risk
// seat's sweep instead of invisible.
function allowlistDigest(file) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch (_) { return null; }
}

function hostOf(target) {
  // accepts "example.com", "https://example.com/x" or "api.example.com/path"
  const t = String(target || '').trim().replace(/^https?:\/\//i, '');
  return t.split(/[/?#]/)[0].toLowerCase();
}

function allowedHost(host, list) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return (list || []).some(entry => {
    const e = String(entry).toLowerCase();
    if (e.startsWith('*.')) return h === e.slice(2) || h.endsWith(e.slice(1));
    return h === e || h.endsWith('.' + e);
  });
}

/* A clearance row is valid only when every part of it holds. Anything missing or unprovable means "no clearance",
 * which is the same answer as "no row at all" — the gate never guesses in favour of acting. */
/* ---- CLOSE: a row's only other exit is its own `until` ----
 * A row justified for one act kept clearing its subject until it expired, so the ledger had no way to say "spent".
 * `close` is a RECORD, not a deletion: the row keeps every field it had, gains closedAt/closedBy/closedByAgent/
 * closedWhy (and the exact original line in closedFrom), and stops clearing anything. The ledger never loses a line —
 * "closed" and "never existed" must stay distinguishable a year from now. Who may close is exactly who may clear:
 * the close is recorded inside the CEO's own run, by a name in CLEARERS, and an agent never closes the row its own
 * act stands on. */
/* The ledger is append-only (locked-watch holds it so): a close is its own line, {type: 'close', id, closedAt, closedBy,
 * closedByAgent, closedWhy, closedSession}, appended after the row. ledgerRows() reads the clearance rows with their
 * first close folded in; the row's own line is never rewritten. */
function ledgerRows(file) { return mergeClosed(readJsonl(file)); }
function mergeClosed(all) {
  const closes = new Map();
  for (const r of all) if (r && r.type === 'close' && r.id && !closes.has(String(r.id))) closes.set(String(r.id), r);
  return all.filter(r => !(r && r.type === 'close')).map(r => {
    const c = r && r.id != null && closes.get(String(r.id));
    if (!c || r.closedAt) return r;
    const { type, id, until, at, ...fields } = c; return Object.assign({}, r, fields);
  });
}
function closedReason(row) {
  if (!row || typeof row !== 'object' || !row.closedAt) return null;
  return 'closed by ' + (row.closedBy || 'an unrecorded closer') + ' at ' + row.closedAt +
    (row.closedWhy ? ' (' + row.closedWhy + ')' : ' (no reason recorded)');
}

function validateRow(row, req, at) {
  if (!row || typeof row !== 'object') return 'malformed row';
  // A CLOSED row is kept, not deleted: it stays in the ledger
  // with its fields intact plus the close record, and it stops clearing anything. The refusal names the close, so a
  // reader learns what happened instead of "no clearance row".
  const closed = closedReason(row);
  if (closed) return closed + ' — the act it justified is done, so this row clears nothing';
  if (!CATEGORIES[row.category]) return 'unknown category in row';
  if (norm(row.category) !== norm(req.category)) return 'category mismatch';
  // A `message` row must name a CONCRETE recipient. Naming a class under a wildcard is refused as
  // malformed, the way an `acts` list containing merge is refused rather than narrowed — a row that overshoots its
  // own schema is a row nobody checked.
  if (norm(row.category) === 'message') { const mw = messageTargetWhy(row.target, 'row'); if (mw) return 'malformed row: ' + mw; }
  const scopeWhy = publishScopeOk(row.target, 'row');
  if (scopeWhy) return scopeWhy;
  const aw = actsWhy(row); if (aw) return 'malformed row: ' + aw;
  const nw = narrowWhy(row); if (nw) return 'malformed row: ' + nw;
  if (!targetMatches(row.target, req.target)) return 'target mismatch';
  const agent = norm(row.agent || 'any');
  if (agent !== 'any' && agent !== norm(req.agent || 'unknown')) return 'agent mismatch';
  if (Array.isArray(row.acts) && req.act && !row.acts.map(norm).includes(norm(req.act))) return 'act mismatch: the row covers ' + row.acts.join(', ') + ', not "' + req.act + '"';
  if (row.ownAct && req.act && norm(row.ownAct) !== norm(req.act)) return 'act mismatch: the row covers only ' + row.ownAct + ', not "' + req.act + '"';
  const clearee = norm(row.clearedBy);
  if (!CLEARERS.includes(clearee)) return 'clearedBy is not ' + CLEARER_WORDS;
  if (!targetStemOk(row.target)) return 'target "' + String(row.target || '') + '" has no literal part — a wildcard that clears everything is not a clearance';
  if (row.clearedByAgent && norm(row.clearedByAgent) === norm(req.agent)) return 'an agent may not clear its own action';
  if (clearee === norm(req.agent)) return 'an agent may not clear its own action';
  if (!row.until) return 'no expiry (a clearance must say until when)';
  const until = Date.parse(row.until);
  if (!Number.isFinite(until)) return 'unparseable expiry';
  if (until <= at) return 'expired';
  if (!row.justification) return 'no justifying file';
  const j = String(row.justification);
  if (path.isAbsolute(j) || j.includes('..')) return 'justification path must be company-relative';
  const abs = path.join(fileRoot(), j);
  if (!abs.startsWith(path.join(fileRoot(), 'company') + path.sep)) return 'justification must live under company/';
  if (!fs.existsSync(abs)) return 'justifying file does not exist';
  if (!justificationSupports(abs, row.target)) return 'the justifying file does not mention the target ("' + targetStem(row.target) + '") — an unrelated file cannot clear an action';
  // PROVENANCE: the row must name the tool that wrote it, that tool must be the CEO session, and a CEO run must cover
  // the moment the row claims. Without this, `clear --by <CEO name>` is a name anyone can type.
  if (!row.clearedByAgent) return 'no recording agent on the row (clearedByAgent is required)';
  if (norm(row.clearedByAgent) !== CLEARING_AGENT) return 'recorded by "' + row.clearedByAgent + '", not by the CEO session (' + CLEARING_AGENT + ')';
  const rowAt = Date.parse(String(row.at || ''));
  if (!Number.isFinite(rowAt)) return 'row carries no usable timestamp';
  const run = clearingRunFor(rowAt);
  if (!run) return 'no CEO run covers ' + new Date(rowAt).toISOString() + ' — the row was not written inside a CEO run';
  return null;
}

/* ---- LIST: THREE STATES, because "not yet recordable" and "no clearance" are different answers ----
 * StarNet writes a run's row into runs.jsonl when the run ENDS, so a row written inside the
 * run executing right now cannot validate until it closes — and `valid: false` on that row reads as "no clearance",
 * which is the sentence that stops a merge that should happen. The rule is unchanged: validateRow() and check() are
 * untouched, and `valid` keeps exactly the value it had. What changes is that the list says WHICH of the two it is.
 *   valid   — every check passed.
 *   pending — every check but the run record passed (that is the LAST test in validateRow, so any earlier failure
 *             would have returned instead), and the run the row names is not in runs.jsonl yet: valid on close.
 *   invalid — anything else, with the gate's own reason attached.
 * The pending state is deliberately narrow: it cannot arise from a row that failed an earlier test, so it can never
 * dress a forged row as "wait a few minutes". */
// Does a run journal on disk carry a `begin` record naming this runId? The station names each journal
// sha256(runId).jsonl, so one file can answer this and a
// hand-written journal under another name cannot. Unreadable or unparseable answers "no": a state that promises a
// future must be proven, not assumed.
function journalNamesRun(runId) {
  if (!runId) return false;
  const dir = JOURNAL_DIR_OVERRIDE || JOURNAL_DIR;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch (_) { return false; }
  const want = sha256Hex(runId) + '.jsonl';
  if (!files.includes(want)) return false;
  try {
    const begin = JSON.parse(firstLine(path.join(dir, want)));
    const p = (begin && begin.payload) || {};
    return !!(begin && begin.type === 'begin' && String(p.runId || begin.runId || '') === String(runId));
  } catch (_) { return false; }
}
function listState(row, at, runs, liveRunId) {
  // A closed row is its own state, never "invalid": the monthly number is "30 rows, 11 closed",
  // not a total that quietly shrank, and not a row that reads as if it had never been written.
  const cr = closedReason(row);
  if (cr) return { valid: false, state: 'closed', reason: cr };
  // Validate against exactly the runs handed in, so the classification cannot be quietly satisfied by a run the
  // caller did not pass (in the CLI `runs` IS readRuns(), so this is a no-op there; in a test it is the point).
  const savedRuns = RUNS_OVERRIDE;
  if (Array.isArray(runs)) RUNS_OVERRIDE = runs;
  let why;
  try {
    why = validateRow(row, { category: row && row.category, target: row && row.target,
      agent: (row && row.agent) === 'any' ? 'probe' : (row && row.agent) }, at);
  } finally { RUNS_OVERRIDE = savedRuns; }
  if (!why) return { valid: true, state: 'valid', reason: null };
  const cs = row && row.clearingSession;
  const runId = cs && cs.runId ? String(cs.runId) : '';
  const recorded = runId ? (runs || []).some(r => String(r && r.runId) === runId) : false;
  if (why.indexOf('no CEO run covers ') === 0 && runId && !recorded) {
    const now = !!(liveRunId && String(liveRunId) === String(runId));
    // `pending` is a PROMISE — "valid on close, so wait a few minutes". It may only be made when a run exists that can
    // actually close: the run executing in this process, or a journal whose `begin` record names this runId (started,
    // not yet written into runs.jsonl). Entering on a merely non-empty runId would let a row naming a run that never
    // existed read as "valid on close" — a control that reports a state it cannot prove.
    if (now || journalNamesRun(runId)) {
      return { valid: false, state: 'pending', reason: why,
        pending: 'written inside run ' + runId + (now ? ' (executing now)' : ' (begun, not yet recorded)') +
          '; StarNet records a run in runs.jsonl when it ENDS, so this row cannot validate until that run closes — valid on close, not refused' };
    }
    return { valid: false, state: 'invalid', reason: why + '; clearingSession names run ' + runId + ' which is neither executing now nor in the run journal — no such run: this row will never validate' };
  }
  return { valid: false, state: 'invalid', reason: why };
}

function checkInner(req, opts) {
  opts = opts || {};
  const at = Number.isFinite(opts.now) ? opts.now : nowMs();
  const ledger = opts.ledger || LEDGER;
  const logFile = opts.log === null ? null : (opts.log || LOG);
  const allowlist = opts.allowlist || ALLOWLIST;

  const r = {
    category: norm(req && req.category),
    target: String((req && req.target) || ''),
    agent: norm((req && req.agent) || 'unknown') || 'unknown',
    act: norm(req && req.act),                      // optional: a request that names an act must find it on the row
    note: (req && req.note) ? String(req.note).slice(0, 300) : '',
  };
  const base = { at: new Date(at).toISOString(), agent: r.agent, category: r.category, target: r.target, note: r.note };

  const deny = (reason) => {
    const out = Object.assign({ decision: 'refused', reason: reason }, base);
    if (logFile) appendJsonl(logFile, out);
    return { allow: false, reason: reason, clearanceId: null, clearedBy: null, logged: !!logFile };
  };

  if (!r.category) return deny('no category given');
  if (!CATEGORIES[r.category]) return deny('unknown category "' + r.category + '" — the gate fails closed');
  if (!r.target) return deny('no target given — an external act must name exactly what it acts on');
  // The REQUEST says what it acts on. A request that names only a repository cannot be cleared by
  // any row, however carefully written, because the gate compares targets and the note is never parsed.
  const reqScope = publishScopeOk(r.target, 'request');
  if (reqScope) return deny(reqScope);

  // THE GUARDRAIL SWITCH (company/state/guardrails.json externalActions, co.guard): while the owner has it off, the
  // gate logs the attempt and allows it without a clearance row. Off is for experiments in a disposable station.
  const govOpts = { root: opts.govRoot, guards: opts.guards, level: opts.level };
  if (!gov.guard('externalActions', govOpts)) {
    const reason = 'the externalActions guardrail is off (company/state/guardrails.json): logged, not gated';
    const out = Object.assign({ decision: 'allowed-guardrail-off', reason: reason, clearanceId: null, clearedBy: 'guardrail-off' }, base);
    if (logFile) appendJsonl(logFile, out);
    return { allow: true, reason: reason, clearanceId: null, clearedBy: 'guardrail-off', guardrailOff: true };
  }
  // SELF-GOVERNANCE (company/state/governance.json category external): auto = the CEO's own clearance suffices;
  // notify = the CEO's clearance, and the owner is told; approve = only a row that names the owner as the clearer counts.
  const govLevel = gov.level('external', govOpts);
  const ownerCleared = row => ['owner', norm(OWNER_NAME)].includes(norm(row && row.clearedBy));

  // THE OWNER CHANNEL: a class name is malformed; the pinned subject is the only reach.
  if (r.category === 'message') {
    const shapeWhy = messageTargetWhy(r.target, 'request');
    if (shapeWhy) return deny(shapeWhy);
    const pin = ownerPinFor(r, at, opts);
    if (pin) {
      const reason = 'owner-channel pin: the one cleared subject, sender "' + r.agent + '" — bounded, counted and revocable by editing company/state/owner-channel-policy.json';
      const out = Object.assign({ decision: 'allowed-pin', reason: reason, clearanceId: null, clearedBy: 'pin', route: 'pin', pinUntil: pin.until }, base);
      if (logFile) appendJsonl(logFile, out);
      return { allow: true, reason: reason, clearanceId: null, clearedBy: 'pin', pin: true, route: 'pin', pinUntil: pin.until, pinFile: 'company/state/owner-channel-policy.json' };
    }
  }

  // A domain that is already on the company allowlist is not a new domain: only a NEW host needs a row.
  if (r.category === 'network' && allowedHost(hostOf(r.target), readAllowlist(allowlist))) {
    const out = Object.assign({ decision: 'allowed-allowlist', reason: 'host on the company allowlist (allowlist sha256:' + allowlistDigest(allowlist) + ')', clearanceId: null, clearedBy: 'allowlist', allowlistSha: allowlistDigest(allowlist) }, base);
    if (logFile) appendJsonl(logFile, out);
    return { allow: true, reason: 'host is on the company allowlist', clearanceId: null, clearedBy: 'allowlist', allowlistSha: allowlistDigest(allowlist) };
  }

  const allLines = readJsonl(ledger);
  const rows = mergeClosed(allLines);
  const verdicts = ledgerVerdicts(allLines, at);      // order and prefix stamp, per clearance row
  const problems = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    let why = verdicts[ri] || validateRow(row, r, at);
    if (!why && govLevel === 'approve' && !ownerCleared(row)) why = 'self-governance: external is at approve, so a clearance must name the owner (' + OWNER_NAME + '), not ' + row.clearedBy;
    if (why) { if (targetMatches(row && row.target, r.target) && norm(row && row.category) === r.category) problems.push((row && row.id) + ': ' + why); continue; }
    if (govLevel === 'notify' && !ownerCleared(row)) {
      try { gov.notify(String(row.clearedBy) + ' cleared ' + r.agent + ' to ' + r.category + ' ' + r.target + ' (clearance ' + (row.id || '?') + ', until ' + row.until + '). Self-governance: external is set to notify; reply if you want it stopped.', govOpts); } catch (_) {}
    }
    // A publish request names its act, and an ownAct row answers only for that act (a legacy row is exempt, see above).
    if (r.category === 'publish' && !isLegacy(row.id)) {
      if (!r.act) { problems.push(row.id + ': the request names no act — a publish request must say which act it is (--act <' + ACTS_NARROW.concat(ACTS_OWN_ROW).join('|') + '>)'); continue; }
      if (row.ownAct && norm(row.ownAct) !== r.act) { problems.push(row.id + ': act mismatch: the row covers only ' + row.ownAct + ', not "' + r.act + '"'); continue; }
    }
    // A request that NAMES its act, cleared by a row that names none, is an allow wider than the row's words. It is
    // still an allow — the row predates narrowing or was written without acts — but the log entry and the answer say
    // so, so a reader counts the reach instead of inferring it from a note.
    const unnarrowed = r.act && (!Array.isArray(row.acts) || !row.acts.length);
    const out = Object.assign({ decision: 'allowed', reason: 'clearance ' + (row.id || '?'), clearanceId: row.id || null, clearedBy: row.clearedBy }, unnarrowed ? { unnarrowed: true, act: r.act } : {}, base);
    if (logFile) appendJsonl(logFile, out);
    return Object.assign({ allow: true, reason: 'cleared by ' + row.clearedBy + ' until ' + row.until, clearanceId: row.id || null, clearedBy: row.clearedBy }, unnarrowed ? { unnarrowed: true, reach: 'the row lists no acts, so it answers for any act in category "' + r.category + '", including "' + r.act + '"' } : {});
  }
  // A `message` refusal names the row to write, not just that none was found.
  const ask = r.category === 'message'
    ? 'no message row for ' + r.target + ' — this recipient is not cleared; ' + CLEARER_WORDS + ' writes a row in company/state/external-clearances.jsonl with category:"message", target:"' + r.target + '", agent:"' + r.agent + '", until:"<date>"'
    : 'no clearance row';
  return deny(ask + (problems.length ? ' (candidates rejected — ' + problems.slice(0, 3).join('; ') + ')' : '') + ' — action refused');
}

/* ---- IDEMPOTENCY: the same side effect never goes out twice ----
 * A gated act may carry an idempotency key (`--idem <key>` / req.idem), derived by the caller from WHAT it sends (an
 * invoice id + recipient, a report digest + target). The gate keeps company/work/external-idempotency.jsonl: when it
 * ALLOWS a keyed act it records the key as `allowed` (attempt id) BEFORE the caller sends, so a crash between "gate
 * allowed" and "send recorded" leaves the key taken and a retry is answered `duplicate` (not sent again) with the prior
 * attempt id. Exit code 4 (refusal is 3). The caller may mark `sent` (recordSent); the owner may `release` a key whose
 * attempt is known not to have gone out. A refused attempt takes no key. Scope: category + key.
 * TTL per category, closed default: forever for spend (payouts), publish, account, form, network; 24 h for message.
 * A caller may ask for a LONGER ttl (req.idemTtlMs, or 'forever'), never a shorter one. */
const IDEM = path.join(ROOT, 'company', 'work', 'external-idempotency.jsonl');
const IDEM_TTL_MS = { message: 24 * 3600 * 1000 };   // every other category: forever (null)
function idemTtl(category, asked) {
  const base = Object.prototype.hasOwnProperty.call(IDEM_TTL_MS, category) ? IDEM_TTL_MS[category] : null;
  if (base === null || asked === 'forever' || asked === null) return null;   // null = forever
  const n = Number(asked);
  return Number.isFinite(n) && n > base ? n : base;
}
function idemLock(file, fn) {
  const lk = file + '.lock'; fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lk, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lk).mtimeMs > 30000) { fs.rmSync(lk, { force: true }); continue; } } catch (_) { continue; }
      if (i > 400) throw new Error('external-gate: idempotency lock busy (fail closed)');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { fs.rmSync(lk, { force: true }); }
}
/* The live entry for category+key at `at`: the last allowed row not released and not expired, else null. */
function idemFind(file, category, key, at) {
  let live = null;
  for (const r of readJsonl(file)) {
    if (r.category !== category || r.key !== key) continue;
    if (r.state === 'allowed') live = Object.assign({}, r);
    else if (r.state === 'sent' && live && r.attempt === live.attempt) { live.state = 'sent'; live.sentAt = r.at; }
    else if (r.state === 'released' && live && (!r.attempt || r.attempt === live.attempt)) live = null;
  }
  if (live && live.ttlMs != null && at - Date.parse(live.at) >= live.ttlMs) live = null;
  return live;
}
function check(req, opts) {
  // a spend act passes the one gate first (lib/admit.js, door act): phase 1 always allows and records it with its amount;
  // the clearance rule below decides, exactly as before (an approval threshold is phase 2, docs/BUDGET.md)
  if (req && norm(req.category) === 'spend') { try { require('./lib/admit').admit({ door: 'act', kind: 'act', seat: norm(req.agent || 'unknown') || 'unknown', amountUsd: req.amountUsd, why: 'spend ' + String(req.target || '').slice(0, 120) }, { file: opts && opts.log === null ? null : undefined }); } catch (_) {} }
  const key = req && req.idem != null && req.idem !== true ? String(req.idem).trim().slice(0, 300) : '';
  if (!key) return checkInner(req, opts);
  opts = opts || {};
  const file = opts.idemFile || IDEM;
  const at = Number.isFinite(opts.now) ? opts.now : nowMs();
  const category = norm(req.category);
  return idemLock(file, () => {
    const prior = idemFind(file, category, key, at);
    if (prior) {
      const reason = 'duplicate: idempotency key "' + key + '" (' + category + ') already went out as attempt ' + prior.attempt + ' at ' + prior.at + ' (' + prior.state + ') — not sent again';
      const logFile = opts.log === null ? null : (opts.log || LOG);
      if (logFile) appendJsonl(logFile, { at: new Date(at).toISOString(), decision: 'duplicate', reason, agent: norm(req.agent || 'unknown') || 'unknown', category, target: String(req.target || ''), idem: key, priorAttempt: prior.attempt, note: req.note ? String(req.note).slice(0, 300) : '' });
      return { allow: false, duplicate: true, reason, priorAttempt: prior.attempt, priorState: prior.state, priorAt: prior.at, clearanceId: null, clearedBy: null };
    }
    const d = checkInner(req, opts);
    if (!d.allow) return d;
    const attempt = 'att-' + new Date(at).toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + require('crypto').randomBytes(4).toString('hex');
    const ttlMs = idemTtl(category, req.idemTtlMs);
    appendJsonl(file, { at: new Date(at).toISOString(), state: 'allowed', category, key, attempt, ttlMs, target: String(req.target || ''), agent: norm(req.agent || 'unknown'), clearanceId: d.clearanceId || null });
    return Object.assign({}, d, { idem: key, attemptId: attempt, idemTtlMs: ttlMs });
  });
}
/* After the send is recorded: mark the attempt sent (optional; the allowed row already holds the key). */
function recordSent(o, opts) {
  opts = opts || {}; const file = opts.idemFile || IDEM;
  return idemLock(file, () => {
    const r = readJsonl(file).find(x => x.state === 'allowed' && x.attempt === String(o && o.attempt));
    if (!r) return { ok: false, error: 'no allowed attempt ' + (o && o.attempt) };
    appendJsonl(file, { at: new Date().toISOString(), state: 'sent', category: r.category, key: r.key, attempt: r.attempt, ref: o.ref ? String(o.ref).slice(0, 200) : null });
    return { ok: true, attempt: r.attempt };
  });
}
/* The owner frees a key whose attempt is known NOT to have gone out (checked at the far end). Owner only. */
function releaseIdem(o, opts) {
  opts = opts || {}; const file = opts.idemFile || IDEM;
  const by = norm(o && o.by);
  if (!['owner', norm(OWNER_NAME)].includes(by)) return { ok: false, error: 'only the owner (' + OWNER_NAME + ') releases an idempotency key' };
  if (!o.key || !o.category) return { ok: false, error: 'release needs --category and --key' };
  if (String(o.why || '').trim().length < CLOSE_WHY_MIN) return { ok: false, error: '--why must say how you know it did not go out (at least ' + CLOSE_WHY_MIN + ' characters)' };
  return idemLock(file, () => {
    const live = idemFind(file, norm(o.category), String(o.key), nowMs());
    if (!live) return { ok: false, error: 'no live key ' + o.category + ':' + o.key };
    appendJsonl(file, { at: new Date().toISOString(), state: 'released', category: live.category, key: live.key, attempt: live.attempt, by: o.by, why: String(o.why).slice(0, 400) });
    return { ok: true, released: live.attempt };
  });
}

class GateRefusal extends Error {
  constructor(d) { super('external action refused: ' + d.reason); this.gate = d; this.name = 'GateRefusal'; }
}

/* ---- CLAIMS: a public or customer-facing statement must point at a file that supports it ----
 * The claims half belongs to the gate. The risk seat owns the public-output rule and its text checks; this function enforces the one mechanical part of it — a claim is refused when its
 * source is missing, empty, outside company/, or does not actually contain the words the claim rests on. */
function checkClaim(req, opts) {
  opts = opts || {};
  const logFile = opts.log === null ? null : (opts.log || LOG);
  const claim = String((req && req.claim) || '').trim();
  const source = String((req && req.source) || '').trim();
  const excerpt = String((req && req.excerpt) || '').trim();
  const base = { at: new Date().toISOString(), agent: norm((req && req.agent) || 'unknown') || 'unknown', category: 'claim', target: source, note: claim.slice(0, 300) };
  const deny = (reason) => {
    if (logFile) appendJsonl(logFile, Object.assign({ decision: 'refused', reason: reason }, base));
    return { allow: false, reason: reason, source: source || null };
  };
  if (!claim) return deny('no claim stated — nothing to support');
  if (!source) return deny('no source — a claim with no file behind it is not a claim, it is a guess');
  if (path.isAbsolute(source) || source.includes('..')) return deny('source path must be company-relative');
  const abs = path.join(fileRoot(), source);
  if (!abs.startsWith(path.join(fileRoot(), 'company') + path.sep)) return deny('source must live under company/');
  if (!fs.existsSync(abs)) return deny('source file does not exist: ' + source);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return deny('source file unreadable: ' + e.message); }
  if (!text.trim()) return deny('source file is empty');
  if (excerpt && !norm(text).includes(norm(excerpt))) return deny('the source does not contain the words the claim rests on (excerpt: "' + excerpt.slice(0, 80) + '")');
  if (logFile) appendJsonl(logFile, Object.assign({ decision: 'allowed', reason: 'claim sourced' }, base));
  return { allow: true, reason: 'claim is sourced from ' + source + ' (' + text.length + ' chars' + (excerpt ? ', excerpt found' : '') + ')', source: source };
}

/* For a company tool: call this immediately before the act, never after. Throws instead of acting. */
function mustPass(req, opts) {
  const d = check(req, opts);
  if (!d.allow) throw new GateRefusal(d);
  return d;
}

function addClearance(row, opts) {
  opts = opts || {};
  const at = Number.isFinite(opts.now) ? opts.now : nowMs();
  const ledger = opts.ledger || LEDGER;
  const r = row || {};
  const rec = {
    id: 'clr-' + String(at) + '-' + Math.random().toString(36).slice(2, 7),
    at: new Date(at).toISOString(),
    clearedBy: String(r.by || r.clearedBy || ''),
    clearedByAgent: r.clearedByAgent ? String(r.clearedByAgent) : null,   // the tool that recorded the row, for the audit
    category: norm(r.category),
    target: String(r.target || ''),
    agent: r.agent ? norm(r.agent) : 'any',
    until: String(r.until || ''),
    justification: String(r.justification || ''),
    note: String(r.note || '').slice(0, 500),
  };
  if (r.acts !== undefined && r.acts !== null) rec.acts = r.acts;
  if (r.ownAct !== undefined && r.ownAct !== null) rec.ownAct = r.ownAct;
  // Only the CEO session writes a clearance row. These three refusals are what make `--by <CEO name>` mean something:
  // a worker agent cannot record a row at all, and the row may only be written while the CEO's own run exists.
  if (!CLEARERS.includes(norm(rec.clearedBy))) return { ok: false, error: 'clearedBy must be ' + CLEARER_WORDS + ' ("' + rec.clearedBy + '" is neither) — an agent cannot clear an action' };
  if (!rec.clearedByAgent) return { ok: false, error: 'no recording agent: pass --cleared-by-agent, or run this from the CEO session' };
  if (norm(rec.clearedByAgent) !== CLEARING_AGENT) return { ok: false, error: 'only the CEO session (agent "' + CLEARING_AGENT + '") may record a clearance row; this caller is "' + rec.clearedByAgent + '"' };
  const session = opts.session || liveClearingSession();
  if (!session.live) return { ok: false, error: 'no CEO session to record from: ' + (session.error || 'the CEO is not running') + ' — a clearance is recorded inside the CEO\'s own run, not typed by whoever wants it' };
  rec.clearingSession = { jobId: session.jobId || null, lastRunAt: session.lastRunAt || null, inFlight: !!session.inFlight,
    source: session.source || 'station', runId: session.runId || null, startedAt: session.startedAt || null,
    // which field proved the runner (begin.agentId, or scheduler.cronJobId when the record names no agent): a row
    // says what it rests on, so a later auditor can re-read the same field instead of trusting the sentence
    identitySource: session.identitySource || null };
  /* StarNet writes a run's row into runs.jsonl when the run ENDS, so the run that is executing right now is not in
     the file yet. A row written during that run therefore cannot be matched against it until the run closes; that is
     the honest state, and it is why the write-time proof is the live session above while the readable proof is the
     run window below. Only for the duration of this validation do we stand the live run in for the missing row. */
  const savedOverride = RUNS_OVERRIDE;
  if (!savedOverride && session.inFlight) {
    /* When the live session came from the run journal we know its REAL runId and start time, so the stand-in names the
       run a later auditor can find in runs.jsonl instead of a placeholder. `endedAt` is the moment of the write: the
       run is open at `at` by construction, and the unterminated-run bound (PROVENANCE_MAX_OPEN_MS on an unterminated run)
       would otherwise shut the gate on a session longer than 30 minutes — the same defect, moved. */
    const stand = session.runId
      ? { runId: session.runId, agentId: CLEARING_AGENT, startedAt: session.startedAt || (at - 60 * 1000), endedAt: at + 60 * 1000 }
      : { runId: 'live:' + (session.jobId || 'ops'), agentId: CLEARING_AGENT, startedAt: at - 60 * 1000, endedAt: at + 60 * 1000 };
    RUNS_OVERRIDE = readRuns().concat([stand]);
  }
  let why;
  try {
    why = validateRow(rec, { category: rec.category, target: rec.target, agent: rec.agent === 'any' ? (r.probeAgent || 'probe') : rec.agent }, at);
  } finally { RUNS_OVERRIDE = savedOverride; }
  if (why) return { ok: false, error: why };
  rec.prefixSha = stampFor(readJsonl(ledger), rec);   // binds this row to the bytes above it; check() recomputes
  appendJsonl(ledger, rec);
  return { ok: true, row: rec };
}

const CLOSE_WHY_MIN = 20;   // same discipline as `accept --why`: a close with no reason is a row vanishing

/* closeClearance(row, opts) — end a row that has already done its work.
 * Writes nothing new: it can only name an existing id, and the only fields it may change are the close record.
 * Returns { ok, row } or { ok: false, error } — never throws, so a caller that routes around a refusal has to do it
 * with its eyes open. */
function closeClearance(row, opts) {
  opts = opts || {};
  const at = Number.isFinite(opts.now) ? opts.now : nowMs();
  const ledger = opts.ledger || LEDGER;
  const r = row || {};
  const id = String(r.id || '').trim();
  const by = String(r.by || r.closedBy || '');
  const why = String(r.why || r.closedWhy || '').trim();
  const closedByAgent = r.closedByAgent ? String(r.closedByAgent) : null;
  const caller = norm((r.callerAgent !== undefined ? r.callerAgent : opts.callerAgent) || process.env.STARNET_AGENT_ID || '');

  if (!id) return { ok: false, error: 'close needs --id: it may only end a row that already exists, it never creates one' };
  if (!why) return { ok: false, error: 'close needs --why: a row that stops clearing with no reason written down is a row disappearing' };
  if (why.length < CLOSE_WHY_MIN) return { ok: false, error: '--why is ' + why.length + ' characters — say which act consumed the row (at least ' + CLOSE_WHY_MIN + ')' };
  if (!CLEARERS.includes(norm(by))) return { ok: false, error: 'closedBy must be ' + CLEARER_WORDS + ' ("' + by + '" is neither) — an agent cannot close a row in its own favour' };
  if (!closedByAgent) return { ok: false, error: 'no recording agent: pass --closed-by-agent, or run this from the CEO session' };
  if (norm(closedByAgent) !== CLEARING_AGENT) return { ok: false, error: 'only the CEO session (agent "' + CLEARING_AGENT + '") may close a row; this caller is "' + closedByAgent + '"' };

  if (!fs.existsSync(ledger)) return { ok: false, error: 'ledger unreadable: ' + ledger + ' does not exist' };
  const target = ledgerRows(ledger).find(x => x && String(x.id) === id) || null;
  if (!target) return { ok: false, error: 'no clearance row with id "' + id + '" — close ends an existing row and creates nothing' };
  const already = closedReason(target);
  if (already) return { ok: false, error: 'row ' + id + ' is ' + already + ' — a second close is a disagreement to record, not a repeat' };
  // Q1: the self-cleared rule, applied to closes. The row clears one agent's act; that agent does not get to end it.
  const rowAgent = norm(target.agent || 'any');
  if (rowAgent !== 'any' && caller && rowAgent === caller) {
    return { ok: false, error: 'an agent may not close the row its own act is standing on (the row clears "' + rowAgent + '", and the caller is "' + rowAgent + '")' };
  }
  // Provenance (Q2), the same rule as `clear`: the close is recorded inside the CEO's own run.
  const session = opts.session || liveClearingSession();
  if (!session.live) return { ok: false, error: 'no CEO session to close from: ' + (session.error || 'the CEO is not running') + " — a close is recorded inside the CEO's own run, not typed by whoever wants it" };

  const closedAt = new Date(at).toISOString();
  // `until` is the row's own: retention keeps the close exactly as long as it keeps the row it ends
  const ev = { type: 'close', id, at: closedAt, until: target.until || null, closedAt, closedBy: String(by).trim(), closedByAgent, closedWhy: why,
    closedSession: { jobId: session.jobId || null, runId: session.runId || null, source: session.source || 'station' } };
  const before = ledgerRows(ledger).length;
  try { appendJsonl(ledger, ev); } catch (e) { return { ok: false, error: 'could not write the ledger: ' + e.message }; }
  // the close is an appended line: record it, so the watcher reads it as the gate's own append
  try { require('./provenance.js').appended(ledger, JSON.stringify(ev) + '\n', 'external-gate.js'); } catch (_) {}
  const after = ledgerRows(ledger).length;
  if (after !== before) return { ok: false, error: 'the close changed the number of clearance rows (' + before + ' → ' + after + ') — a close records, it never removes' };
  const closed = ledgerRows(ledger).find(x => String(x.id) === id);
  return { ok: true, row: closed, rows: after };
}

/* ---- SELFTEST: show the gate refusing, one category at a time, on a throwaway ledger and log ----
 * It also proves the three ways a row can look like clearance and not be one (expired, self-cleared, no file),
 * and that the two allowed routes still work. Exit 1 if ANY category can act without a row. */
function selftest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extgate-'));
  const ledger = path.join(dir, 'clearances.jsonl');
  const log = path.join(dir, 'actions.jsonl');
  const allow = path.join(dir, 'allowlist.txt');
  fs.writeFileSync(allow, '');
  const at = Date.parse('2026-11-16T00:00:00Z');
  // A scratch company tree for justification and claim files: the selftest never depends on the live company's files.
  const froot = path.join(dir, 'root');
  fs.mkdirSync(path.join(froot, 'company', 'work', 'security'), { recursive: true });
  const fixture = 'company/work/security/gate-selftest-fixtures.md';   // names every target the cases below use
  fs.writeFileSync(path.join(froot, fixture), '# gate selftest fixtures\n\nTargets the selftest clears: '
    + 'github:example-org/public-gist#main, github:example-org/example-app#fix/a, github:example-org/example-app, '
    + 'stripe:charge-100usd, form:vendor-application, email:owner@example.com, chat:owner, chat:thirdparty0000000000001, owner:file.\n');
  fs.writeFileSync(path.join(froot, 'company/work/security/standing-rules.md'), '# standing rules (selftest copy)\n\nCredentials live in secrets/. All are 0600 and stay 0600.\n');
  const savedFileRoot = FILE_ROOT_OVERRIDE;
  FILE_ROOT_OVERRIDE = froot;
  const CEO_ID = CLEARING_AGENT, CEO = CEO_NAME;   // the clearing session and the clearer, read from loops.json
  const rowBase = { at: new Date(at).toISOString(), clearedByAgent: CEO_ID };
  // A synthetic CEO run covering the test moment, so provenance can be exercised without waiting for a real run.
  RUNS_OVERRIDE = [{ runId: 'run-selftest-ceo', agentId: CLEARING_AGENT, startedAt: at - 120000, endedAt: at + 120000 }];
  // self-governance pinned to auto and the guardrail pinned on, so these cases test the gate itself; section 4d sets them
  const opts = { ledger: ledger, log: log, allowlist: allow, now: at, level: 'auto', guards: { externalActions: true }, govRoot: froot };
  let failures = 0;
  const lines = [];
  LEGACY_ALL = true;      // the cases below that predate the stamp and own-act rules run as legacy rows; sections 5b/5c turn it off
  const expect = (label, req, want, o) => {
    const d = check(req, Object.assign({}, opts, o || {}));
    const ok = want === 'refuse' ? d.allow === false : d.allow === true;
    if (!ok) failures++;
    lines.push((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + (d.allow ? 'ALLOWED' : 'REFUSED') + ' (' + d.reason + ')');
    return d;
  };

  // 1. one refusal per category, with no clearance row anywhere
  const targets = {
    message: 'email:owner@example.com',
    publish: 'github:example-org/public-gist#main',
    account: 'social:new-business-account',
    form: 'form:vendor-application',
    spend: 'stripe:charge-100usd',
    network: 'unseen-vendor.example/api',
  };
  for (const c of Object.keys(CATEGORIES)) lines.push('--- category: ' + c + ' — ' + CATEGORIES[c]);
  for (const c of Object.keys(targets)) expect('category ' + c + ' without a row', { category: c, target: targets[c], agent: 'alex' }, 'refuse');

  // 2. a row that looks like clearance and is not one
  const write = (rows) => fs.writeFileSync(ledger, rows.map(r => JSON.stringify(Object.assign({}, rowBase, r))).join('\n') + '\n');
  write([{ id: 'clr-expired', clearedBy: CEO, category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-11-15T23:00:00Z', justification: fixture }]);
  expect('expired row', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-self', clearedBy: 'alex', category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('agent clearing its own action', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-nofile', clearedBy: CEO, category: 'spend', target: 'stripe:charge-*', agent: 'any', until: '2026-12-01T00:00:00Z', justification: 'company/work/does-not-exist.md' }]);
  expect('row whose justifying file is missing', { category: 'spend', target: 'stripe:charge-100usd', agent: 'sam' }, 'refuse');
  write([{ id: 'clr-noexpiry', clearedBy: CEO, category: 'form', target: 'form:*', agent: 'any', justification: fixture }]);
  expect('row with no expiry', { category: 'form', target: 'form:vendor-application', agent: 'kim' }, 'refuse');
  write([]);
  expect('unknown category', { category: 'teleport', target: 'mars:surface', agent: 'jordan' }, 'refuse');

  // 2b. forgery shapes a red-team run tries against the gate, plus the provenance cases
  write([{ id: 'clr-noagent', clearedBy: CEO, clearedByAgent: null, category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('row with no recording agent (anyone could have written it)', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-otheragent', clearedBy: CEO, clearedByAgent: 'engineer', category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('row typed by a worker agent naming the CEO', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-wildcard', clearedBy: CEO, category: 'publish', target: '*', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect("row whose target is '*' (clears the whole category)", { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-unrelated', clearedBy: CEO, category: 'spend', target: 'stripe:charge-*', agent: 'any', until: '2026-12-01T00:00:00Z', justification: 'company/work/security/standing-rules.md' }]);
  expect('row justified by an unrelated file', { category: 'spend', target: 'stripe:charge-100usd', agent: 'sam' }, 'refuse');
  write([{ id: 'clr-noat', clearedBy: CEO, at: '', category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('row with no timestamp', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-outside', clearedBy: CEO, at: new Date(at + 3 * 3600 * 1000).toISOString(), category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('row written outside any CEO run', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');
  write([{ id: 'clr-ceo', clearedBy: 'CEO', category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  // "CEO" is a title, not an identity — a clearer is the owner or the CEO by name.
  expect('row clearedBy "CEO" (a title, not a person) — refused', { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex' }, 'refuse');

  /* 3. THE OWNER CHANNEL — probes P1–P6 against the PIN.
     The build this replaces answered `allow:true, clearedBy:"exception", clearanceId:null` for the word `owner` and
     refused the owner's own id for want of a row. P3 is now a MUST-REFUSE probe and the mutation is the old
     exception restored: put `OWNER_CONVERSATION` back and P3 goes green-flipped, which is what makes the rest mean
     something. P6 is the control that keeps the refusals honest — a rig that only says no has proved nothing. */
  write([]);
  const OWNER_ID = 'owner:file';
  const pinLive = { category: 'message', target: OWNER_ID, senders: ['ceo', 'dispatcher'], until: '2026-12-01T00:00:00Z' };
  const pinDead = Object.assign({}, pinLive, { until: '2026-11-15T00:00:00Z' });
  const pinForever = Object.assign({}, pinLive, { until: null });
  const p3 = expect('P3 the class name "chat:owner" — MALFORMED, refused (this is the defect; it used to allow with no row)', { category: 'message', target: 'chat:owner', agent: CEO_ID }, 'refuse', { ownerPin: pinLive });
  if (p3.allow || !/malformed/i.test(p3.reason)) { failures++; lines.push('FAIL  P3 refusal is not the malformed-target ruling: ' + p3.reason); }
  expect('P3b "chat:*" — malformed, not narrowed', { category: 'message', target: 'chat:*', agent: CEO_ID }, 'refuse', { ownerPin: pinLive });
  expect('P3c "chat:anyone" — malformed (a class name in another spelling)', { category: 'message', target: 'chat:anyone', agent: CEO_ID }, 'refuse', { ownerPin: pinLive });
  const p1 = expect('P1 the owner id + sender agent + a live pin', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'allow', { ownerPin: pinLive });
  if (!(p1.pin === true && p1.route === 'pin' && p1.clearedBy === 'pin')) { failures++; lines.push('FAIL  P1 allowed by something other than the pin: ' + JSON.stringify({ pin: p1.pin, route: p1.route, clearedBy: p1.clearedBy })); }
  expect('P1b the second named sender (dispatcher)', { category: 'message', target: OWNER_ID, agent: 'dispatcher' }, 'allow', { ownerPin: pinLive });
  expect('P2 no row and no pin (policy file absent) — refused', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'refuse', { ownerPin: null });
  const p2 = expect('P2b the refusal names the row the CEO has to write', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'refuse', { ownerPin: null });
  if (!/external-clearances\.jsonl/.test(p2.reason) || !p2.reason.includes(OWNER_ID)) { failures++; lines.push('FAIL  P2b refusal text does not name the row to write: ' + p2.reason); }
  expect('P2c a THIRD sender (a worker agent) falls through to the ledger', { category: 'message', target: OWNER_ID, agent: 'alex' }, 'refuse', { ownerPin: pinLive });
  expect('P2e a pin with until null has no expiry', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'allow', { ownerPin: pinForever });
  expect('P2f the literal CEO station id works as a sender too', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'allow', { ownerPin: Object.assign({}, pinLive, { senders: [CEO_ID] }) });
  expect('P2d the pin past its until clears nothing', { category: 'message', target: OWNER_ID, agent: CEO_ID }, 'refuse', { ownerPin: pinDead });
  // P4 — the exploit that motivated all of this: repoint the recipient and mail a third party under a class name.
  // Nothing is contacted here; the probe is that the gate is asked for the third party's real id and refuses.
  expect('P4 repointed recipient (third party id), no row for it — refused, and no class name can stand in', { category: 'message', target: 'chat:thirdparty0000000000001', agent: CEO_ID }, 'refuse', { ownerPin: pinLive });
  // P5 — a message ROW must name a concrete recipient too, refused as malformed rather than narrowed.
  write([{ id: 'clr-msgclass', clearedBy: CEO, category: 'message', target: 'chat:*', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('P5 a message row whose target is a wildcard — malformed', { category: 'message', target: 'chat:thirdparty0000000000001', agent: CEO_ID }, 'refuse', { ownerPin: null });
  write([{ id: 'clr-msgowner', clearedBy: CEO, category: 'message', target: 'chat:owner', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  // The row itself, read the way `list` reads it: a class name in a message row is malformed, named as such.
  const p5b = listState(readJsonl(ledger)[0], at, RUNS_OVERRIDE);
  if (p5b.state !== 'invalid' || !/malformed/.test(String(p5b.reason))) { failures++; lines.push('FAIL  P5b the message row naming "owner" is not reported malformed: ' + JSON.stringify(p5b)); }
  else lines.push('ok    P5b a message row whose target is "chat:owner" reads invalid/malformed in `list` (' + p5b.reason + ')');
  expect('P5c that row clears nothing', { category: 'message', target: 'chat:owner', agent: CEO_ID }, 'refuse', { ownerPin: null });
  // P6 THE CONTROL: a message row for a concrete recipient still clears, so the refusals above are measuring reach.
  write([{ id: 'clr-msgok', clearedBy: CEO, category: 'message', target: 'email:owner@example.com', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('P6 control: a message row for a concrete recipient allows', { category: 'message', target: 'email:owner@example.com', agent: 'alex' }, 'allow', { ownerPin: null });

  // 3b. the remaining route allowed by rule, not by a row (the network allowlist is exercised below)
  write([]);

  /* 2f. ROW SCOPE: a row written for one file on target `github:<owner>/<repo>` would answer allow for any publish act
     on that repository. The note named the file, the target named the repo, and the gate matches the target. Each case
     below is one of probes P1–P5, plus the P6 control that proves the
     refusal set is measuring something. */
  const REPO = 'github:example-org/example-app';
  const rowAt = (over) => Object.assign({ id: 'clr-scope', clearedBy: CEO, clearedByAgent: CEO_ID, category: 'publish',
    agent: 'jordan', until: '2026-12-01T00:00:00Z', justification: fixture }, over);
  write([rowAt({ target: REPO })]);
  expect('P1 row naming a repository and no ref (the repo-only row shape)', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'refuse');
  write([]);
  expect('P1 request naming a repository and no ref', { category: 'publish', target: REPO, agent: 'jordan' }, 'refuse');
  write([rowAt({ target: REPO + '#fix/a' })]);
  expect('P2 row for branch A, request branch B', { category: 'publish', target: REPO + '#fix/b', agent: 'jordan' }, 'refuse');
  expect('P6 control: row for branch A, request branch A', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'allow');
  write([rowAt({ target: REPO + '#fix/*' })]);
  expect('P4 row wildcarding its ref (#fix/*)', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'refuse');
  write([rowAt({ target: 'github:*' })]);
  expect('P4 row whose literal part is only the scheme word (github:*)', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'refuse');
  write([rowAt({ target: REPO + '#fix/a', acts: ['push', 'merge'] })]);
  expect('P5 row whose acts list contains merge — malformed, not narrowed', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan', act: 'push' }, 'refuse');
  write([rowAt({ target: REPO + '#fix/a', acts: ['comment'] })]);
  expect('acts list that does not cover the requested act', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan', act: 'push' }, 'refuse');
  expect('acts list that covers the requested act', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan', act: 'comment' }, 'allow');
  expect('a row with acts still clears a request that names no act', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'allow');
  // The row that names no acts answers for EVERY act. It is still an allow; what changes is that the answer and the
  // log say so ("unnarrowed"), so reach is counted rather than inferred.
  write([rowAt({ target: REPO + '#fix/a' })]);
  const unn = expect('a request naming act MERGE, cleared by a row naming no acts — allowed, and flagged unnarrowed', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan', act: 'merge' }, 'allow');
  if (unn.unnarrowed !== true) { failures++; lines.push('FAIL  an allow on an unnarrowed row is not flagged: ' + JSON.stringify(unn)); }
  else lines.push('ok    ...and the answer carries unnarrowed:true with the reach in words (' + unn.reach + ')');
  write([rowAt({ target: REPO + '#fix/a', acts: ['push'] })]);
  const nar = expect('the same request against a row that names push only — refused', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan', act: 'merge' }, 'refuse');
  if (nar.unnarrowed) { failures++; lines.push('FAIL  a narrowed row reported unnarrowed'); }
  write([]);
  expect('a deploy target names an environment, so the ref rule does not apply to it', { category: 'publish', target: 'deploy:production', agent: 'jordan' }, 'refuse');

  write([]);
  fs.writeFileSync(allow, 'example-partner.com\n*.googleapis.com\n');
  expect('host already on the allowlist', { category: 'network', target: 'https://api.example-partner.com/v1/messages', agent: CEO_ID }, 'allow');
  expect('host NOT on the allowlist', { category: 'network', target: 'https://unseen-vendor.example/api', agent: CEO_ID }, 'refuse');

  // 4. a real clearance row works, and only for what it names
  fs.writeFileSync(allow, '');
  write([{ id: 'clr-good', clearedBy: CEO, category: 'spend', target: 'stripe:charge-*', agent: 'sam', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('valid row, matching agent+target', { category: 'spend', target: 'stripe:charge-100usd', agent: 'sam' }, 'allow');
  expect('valid row, other agent', { category: 'spend', target: 'stripe:charge-100usd', agent: 'kim' }, 'refuse');
  expect('valid row, other target', { category: 'spend', target: 'stripe:refund-100usd', agent: 'sam' }, 'refuse');

  // 4d. self-governance (category external) and the externalActions guardrail
  const req4 = { category: 'spend', target: 'stripe:charge-100usd', agent: 'sam' };
  const outbound = path.join(froot, 'company', 'owner', 'digest.jsonl');   // an FYI: the day's single message (lib/owner-notice.js)
  expect('external at notify: the CEO row still clears', req4, 'allow', { level: 'notify' });
  { const sent = fs.existsSync(outbound) ? fs.readFileSync(outbound, 'utf8') : '';
    const ok = /cleared sam to spend stripe:charge-100usd/.test(sent) && /\(clearance clr-good/.test(sent);   // the clearance id rides in the technical part
    if (!ok) failures++; lines.push((ok ? 'ok    ' : 'FAIL  ') + 'external at notify: the owner is told in one sentence (company/owner/digest.jsonl, the day\'s message)'); }
  const d4 = expect('external at approve: a CEO row is not enough', req4, 'refuse', { level: 'approve' });
  { const ok = /must name the owner/.test(d4.reason); if (!ok) failures++; lines.push((ok ? 'ok    ' : 'FAIL  ') + 'external at approve: the refusal says the owner must clear it'); }
  write([{ id: 'clr-owner', clearedBy: OWNER_NAME, category: 'spend', target: 'stripe:charge-*', agent: 'sam', until: '2026-12-01T00:00:00Z', justification: fixture }]);
  expect('external at approve: a row that names the owner clears', req4, 'allow', { level: 'approve' });
  fs.writeFileSync(ledger, '');
  const g4 = expect('externalActions guardrail off: no row, still allowed', req4, 'allow', { guards: { externalActions: false } });
  { const logged = readJsonl(log).some(x => x.decision === 'allowed-guardrail-off' && x.target === req4.target);
    const ok = logged && g4.guardrailOff === true; if (!ok) failures++; lines.push((ok ? 'ok    ' : 'FAIL  ') + 'externalActions guardrail off: the attempt is logged as allowed-guardrail-off'); }
  expect('externalActions guardrail on again: no row, refused', req4, 'refuse');
  write([{ id: 'clr-good', clearedBy: CEO, category: 'spend', target: 'stripe:charge-*', agent: 'sam', until: '2026-12-01T00:00:00Z', justification: fixture }]);

  // 4b. `clear` itself: who may WRITE a row. A worker agent, or a caller with no CEO session, gets no row.
  const addCase = (label, row, opts2, want) => {
    fs.writeFileSync(ledger, '');
    const r = addClearance(row, Object.assign({ ledger: ledger, now: at }, opts2 || {}));
    const ok = want === 'refuse' ? r.ok === false : r.ok === true;
    if (!ok) failures++;
    lines.push((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + (r.ok ? 'ROW WRITTEN' : 'REFUSED') + ' (' + (r.ok ? (r.row && r.row.id) : r.error) + ')');
  };
  const rowOk = { by: CEO, clearedByAgent: CEO_ID, category: 'publish', target: 'github:example-org/public-gist#main', agent: 'any', until: '2026-12-01T00:00:00Z', justification: fixture, note: 'selftest' };
  addCase('clear by the CEO session (valid)', rowOk, {}, 'allow');
  addCase('clear recorded by a worker agent', Object.assign({}, rowOk, { clearedByAgent: 'engineer' }), {}, 'refuse');
  addCase('clear with no recording agent', Object.assign({}, rowOk, { clearedByAgent: null }), {}, 'refuse');
  addCase('clear whose target is a bare wildcard', Object.assign({}, rowOk, { target: '*' }), {}, 'refuse');
  addCase('clear with no CEO session running', rowOk, { session: { live: false, error: 'no CEO run in flight (selftest)' } }, 'refuse');
  fs.writeFileSync(ledger, '');

  /* 4c. LIVE PROVENANCE FROM THE RUN JOURNAL. The defect this guards: with /api/cron's lastRunAt as the only live
     source, a row could be written for 3 minutes after the PREVIOUS run and never again, so a long session had a
     3-minute window. These cases prove the new source opens the gate mid-run, and that
     every way it could lie stays shut. */
  const jdir = path.join(dir, 'journal');
  const liveNow = Date.now();
  const resetJournal = () => { try { fs.rmSync(jdir, { recursive: true, force: true }); } catch (_) {} fs.mkdirSync(jdir, { recursive: true }); };
  const writeJournal = (name, payload, ageMs) => {
    const f = path.join(jdir, name);
    fs.writeFileSync(f, JSON.stringify({ v: 1, runId: payload.runId, seq: 1, ts: payload.startedAt, type: 'begin', payload: payload }) + '\n'
      + JSON.stringify({ v: 1, runId: payload.runId, seq: 2, ts: liveNow, type: 'checkpoint', payload: {} }) + '\n');
    if (Number.isFinite(ageMs)) { const t = (liveNow - ageMs) / 1000; fs.utimesSync(f, t, t); }
    return f;
  };
  const savedJournalDir = JOURNAL_DIR_OVERRIDE;
  JOURNAL_DIR_OVERRIDE = jdir;
  const jCase = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failures++;
    lines.push((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + JSON.stringify(got));
  };
  resetJournal();
  jCase('journal empty proves no live session', liveJournalRun(liveNow).live, false);
  const jname = (runId) => sha256Hex(runId) + '.jsonl';   // the station's own naming, copied from disk
  writeJournal(jname('run-live-ceo'), { agentId: CEO_ID, runId: 'run-live-ceo', cronJobId: 'job-live', startedAt: liveNow - 40 * 60000 }, null);
  const midRun = liveJournalRun(liveNow);
  jCase('journal: a CEO run 40 minutes in and still writing is LIVE (the mid-run case)', [midRun.live, midRun.runId], [true, 'run-live-ceo']);
  resetJournal();
  writeJournal('ceo-handwritten.jsonl', { agentId: CEO_ID, runId: 'run-forged-ceo', startedAt: liveNow - 60000 }, null);
  jCase('journal: a hand-written journal not named sha256(runId) is skipped', liveJournalRun(liveNow).live, false);
  resetJournal();
  // fixed 16 minutes, NOT derived from JOURNAL_QUIET_MS: a fixture that scales with the constant cannot notice the
  // constant being widened.
  writeJournal(jname('run-quiet-ceo'), { agentId: CEO_ID, runId: 'run-quiet-ceo', startedAt: liveNow - 40 * 60000 }, 16 * 60 * 1000);
  jCase('journal: a CEO journal that stopped writing 16 minutes ago is NOT live', liveJournalRun(liveNow).live, false);
  resetJournal();
  writeJournal(jname('run-engineer'), { agentId: 'engineer', runId: 'run-engineer', startedAt: liveNow - 60000 }, null);
  jCase('journal: a worker agent\'s live run is not a clearing session', liveJournalRun(liveNow).live, false);
  resetJournal();
  writeJournal(jname('run-selftest-ceo'), { agentId: CEO_ID, runId: 'run-selftest-ceo', startedAt: liveNow - 60000 }, null);
  jCase('journal: a run the station recorded as ended is not live even with a fresh file', liveJournalRun(liveNow).live, false);
  resetJournal();
  writeJournal(jname('run-older'), { agentId: CEO_ID, runId: 'run-older', startedAt: liveNow - 20 * 60000 }, null);
  writeJournal(jname('run-newer'), { agentId: CEO_ID, runId: 'run-newer', startedAt: liveNow - 5 * 60000 }, null);
  jCase('journal: the newest live CEO run is the one named', liveJournalRun(liveNow).runId, 'run-newer');
  /* The WIRING, not just the source function: a version of this file that has liveJournalRun() but does not call it
     from liveClearingSession() passes every case above and still leaves the mid-run defect in place. So this case asserts
     the SOURCE the live view reports, which only the journal can produce mid-run. */
  resetJournal();
  writeJournal(jname('run-wired-ceo'), { agentId: CEO_ID, runId: 'run-wired-ceo', jobId: 'job-wired', startedAt: liveNow - 40 * 60000 }, null);
  const savedRunsForWiring = RUNS_OVERRIDE;
  RUNS_OVERRIDE = null;
  const wired = liveClearingSession();
  RUNS_OVERRIDE = savedRunsForWiring;
  jCase('wiring: liveClearingSession is answered by the run journal mid-run, and says so',
    [wired.live, wired.source, wired.runId], [true, 'run-journal', 'run-wired-ceo']);
  JOURNAL_DIR_OVERRIDE = path.join(dir, 'no-such-journal-dir');
  const noDir = liveJournalRun(liveNow);
  jCase('journal: an unreadable journal directory fails CLOSED with a reason', [noDir.live, /unreadable/.test(String(noDir.error))], [false, true]);
  JOURNAL_DIR_OVERRIDE = savedJournalDir;

  /* 4d. THE SHAPES THE STATION ACTUALLY WRITES. Cases written from what an author ASSUMES the station writes can pass
     while a real CEO run fails. These are the shapes real journals carry. If one of them is wrong, the fix is wrong, and the case says so. */
  const SCHED_CEO = 'job-selftest-ops';
  const savedSched = SCHEDULER_OVERRIDE;
  SCHEDULER_OVERRIDE = {}; SCHEDULER_OVERRIDE[SCHED_CEO] = CLEARING_AGENT;
  JOURNAL_DIR_OVERRIDE = jdir;
  resetJournal();
  // (a) the begin record carries the whole directive: a first line can be tens of KB, not < 16 KB
  writeJournal(jname('run-long-directive'), { agentId: CEO_ID, runId: 'run-long-directive', startedAt: liveNow - 60000,
    directiveTitle: 'You are the CEO of this company. '.repeat(900) }, null);
  const longLine = firstLine(path.join(jdir, jname('run-long-directive')));
  jCase('journal: a begin record longer than 16 KB still proves the CEO run (first line '
      + Buffer.byteLength(longLine, 'utf8') + ' bytes)',
    [liveJournalRun(liveNow).live, Buffer.byteLength(longLine, 'utf8') > 16384], [true, true]);
  resetJournal();
  // (b) the record names a routine, not an agent — resolved from the station's scheduler
  writeJournal(jname('run-no-agent-field'), { turnId: 'turn-x', runId: 'run-no-agent-field', cronJobId: SCHED_CEO, startedAt: liveNow - 60000 }, null);
  const viaSched = liveJournalRun(liveNow);
  jCase('journal: a begin record with no agentId is resolved from the routine that ran it (routine-only shape)',
    [viaSched.live, viaSched.runId, viaSched.identitySource], [true, 'run-no-agent-field', 'scheduler.cronJobId']);
  resetJournal();
  // (c) neither: it cannot prove who ran it, and it says that rather than being skipped
  writeJournal(jname('run-no-identity'), { turnId: 'turn-y', runId: 'run-no-identity', startedAt: liveNow - 60000 }, null);
  const noId = liveJournalRun(liveNow);
  jCase('journal: a record naming no agent and no routine fails CLOSED with that reason',
    [noId.live, /names no agentId and no routine/.test(String(noId.error))], [false, true]);
  resetJournal();
  // (d) a NAMED agent is authoritative: a worker run is not re-attributed by the routine's CEO mapping
  writeJournal(jname('run-engineer-with-ceo-job'), { agentId: 'engineer', runId: 'run-engineer-with-ceo-job', cronJobId: SCHED_CEO, startedAt: liveNow - 60000 }, null);
  const named = liveJournalRun(liveNow);
  jCase('journal: a present agentId is authoritative, not overridden by the routine lookup',
    [named.live, /run was agent "engineer"/.test(String(named.error))], [false, true]);
  // (e) every file that does not qualify is named with a reason — the silent skip is the defect
  resetJournal();
  writeJournal('not-hashed.jsonl', { agentId: CEO_ID, runId: 'run-unhashed', startedAt: liveNow - 60000 }, null);
  writeJournal(jname('run-quiet-copy'), { agentId: CEO_ID, runId: 'run-quiet-copy', startedAt: liveNow - 60000 }, 16 * 60 * 1000);
  const whyText = String(liveJournalRun(liveNow).error || '');
  jCase('journal: the error names every file that did not qualify, and still summarises the counts',
    [/2 file\(s\)/.test(whyText), /1 quiet/.test(whyText), /does not hash to this file name/.test(whyText)], [true, true, true]);
  SCHEDULER_OVERRIDE = savedSched;
  resetJournal();

  // the row a CEO session writes at minute 40 of its run: written, stamped with the real runId, and readable as
  // covered by that run — the case that failed before this change.
  const savedRunsForMid = RUNS_OVERRIDE;
  RUNS_OVERRIDE = null;   // no synthetic run: the stand-in must come from the live journal session itself
  fs.writeFileSync(ledger, '');
  const midRow = addClearance(rowOk, { ledger: ledger, now: at,
    session: { live: true, inFlight: true, runId: 'run-live-ceo', jobId: 'job-live', startedAt: at - 40 * 60000, source: 'run-journal' } });
  RUNS_OVERRIDE = savedRunsForMid;
  jCase('clear at minute 40 of a live CEO run writes a row stamped with that runId',
    [midRow.ok, midRow.ok ? midRow.row.clearingSession.runId : midRow.error, midRow.ok ? midRow.row.clearingSession.source : null],
    [true, 'run-live-ceo', 'run-journal']);
  fs.writeFileSync(ledger, '');

  // ---- LIST DISPLAY: the three states, driven on the very row written mid-run above ----
  // No runs recorded yet and the row's own run is the one executing: "pending", never "invalid" and never "valid".
  if (midRow.ok) {
    const pend = listState(midRow.row, at, [], 'run-live-ceo');
    jCase('list: a row written inside the still-open CEO run is PENDING (valid on close), not invalid',
      [pend.valid, pend.state, /executing now/.test(String(pend.pending)), /run-live-ceo/.test(String(pend.pending))],
      [false, 'pending', true, true]);
    const closed = listState(midRow.row, at, [{ runId: 'run-live-ceo', agentId: CLEARING_AGENT, startedAt: at - 40 * 60000, endedAt: at + 60000 }], null);
    jCase('list: the same row is VALID once runs.jsonl records its run — the state flip is the display, not the rule',
      [closed.valid, closed.state], [true, 'valid']);
    /* A run that is neither
       executing nor in the run journal will NEVER validate, so "valid on close, wait a few minutes" is a false
       instruction to whoever reads the list. It is INVALID, and the reason names the run. */
    const otherRun = listState(Object.assign({}, midRow.row, { clearingSession: Object.assign({}, midRow.row.clearingSession, { runId: 'run-somebody-else' }) }), at, [], null);
    jCase('list: a row naming a run that is not recorded and is not executing is INVALID, and names that run',
      [otherRun.state, /run-somebody-else/.test(String(otherRun.reason)), /no such run/.test(String(otherRun.reason))],
      ['invalid', true, true]);
    const noRunId = listState(Object.assign({}, midRow.row, { clearingSession: { source: 'station' } }), at, [], null);
    jCase('list: a row with no recorded run id is INVALID (nothing to wait on), with the gate\'s reason',
      [noRunId.state, /no CEO run covers/.test(String(noRunId.reason))], ['invalid', true]);
    const expired = listState(Object.assign({}, midRow.row, { until: new Date(at - 1000).toISOString() }), at, [], 'run-live-ceo');
    jCase('list: an expired row is INVALID even when its run is live — pending cannot dress an earlier failure',
      [expired.state, expired.valid, /expired/.test(String(expired.reason))], ['invalid', false, true]);
    const selfClear = listState(Object.assign({}, midRow.row, { clearedByAgent: 'engineer', clearedBy: CEO }), at, [], 'run-live-ceo');
    jCase('list: a row recorded by a non-CEO agent is INVALID, not pending',
      [selfClear.state, /not by the CEO session/.test(String(selfClear.reason))], ['invalid', true]);
  }

  /* 4e. CLOSE PATH — probes Q1–Q8. One case per probe, and the two that decide the certification are here as a pair: Q4 (close ALLOWS, then check() REFUSES and
     names the close) and Q8 (a different, still-valid row on the same subject class still ALLOWS). A gate that simply
     broke on `closed` would pass Q4 and fail Q8, which is the whole point of running both. */
  const closeSession = { live: true, jobId: 'selftest-job', runId: 'run-selftest-ceo', source: 'selftest' };
  const closeWhy = 'the act it justified landed on its commit and is finished';
  const qRows = (rows) => fs.writeFileSync(ledger, rows.map(r => JSON.stringify(Object.assign({}, rowBase, r))).join('\n') + '\n');
  const qRow = (over) => Object.assign({ id: 'clr-q', clearedBy: CEO, category: 'publish', target: REPO + '#fix/a',
    agent: 'alex', until: '2026-12-01T00:00:00Z', justification: fixture }, over);
  const qClose = (args, extra) => closeClearance(args, Object.assign({ ledger: ledger, now: at, session: closeSession }, extra || {}));
  const qCase = (label, res, want, extra) => {
    const ok = want === 'refuse' ? res.ok === false : res.ok === true;
    const bad = !ok || (typeof extra === 'function' ? !extra(res) : false);
    if (bad) failures++;
    lines.push((bad ? 'FAIL  ' : 'ok    ') + label + ' → ' + (res.ok ? 'CLOSED' : 'REFUSED') + ' (' +
      (res.ok ? res.row.id + ', ledger still ' + res.rows + ' rows' : res.error) + ')');
  };
  // Q1 — an agent closes a row its own act is standing on
  qRows([qRow({ agent: 'engineer' })]);
  qCase('Q1 an agent closing the row its own act stands on', qClose({ id: 'clr-q', by: CEO, why: closeWhy, closedByAgent: CEO_ID, callerAgent: 'engineer' }), 'refuse');
  // Q2 — a close naming the CEO, written outside any CEO run
  qRows([qRow({})]);
  qCase('Q2 close outside any CEO run', qClose({ id: 'clr-q', by: CEO, why: closeWhy, closedByAgent: CEO_ID }, { session: { live: false, error: 'no CEO run in flight (selftest)' } }), 'refuse');
  qCase('Q2b close recorded by a worker agent', qClose({ id: 'clr-q', by: CEO, why: closeWhy, closedByAgent: 'engineer' }), 'refuse');
  qCase("Q2c close clearedBy 'CEO' (a title, not a person)", qClose({ id: 'clr-q', by: 'CEO', why: closeWhy, closedByAgent: CEO_ID }), 'refuse');
  // Q3 — no reason, and a reason with no content
  qCase('Q3 close with no --why', qClose({ id: 'clr-q', by: CEO, closedByAgent: CEO_ID }), 'refuse');
  qCase('Q3b close with a two-word --why', qClose({ id: 'clr-q', by: CEO, why: 'all good', closedByAgent: CEO_ID }), 'refuse');
  // Q4 + Q7 — a valid row inside a live CEO run: close ALLOWS, then check() REFUSES and NAMES the close
  qRows([qRow({})]);
  const q4 = qClose({ id: 'clr-q', by: CEO, why: closeWhy, closedByAgent: CEO_ID });
  const q4line = JSON.stringify(Object.assign({}, rowBase, qRow({})));
  qCase('Q4 close a valid row inside a live CEO run', q4, 'allow', (r) => r.row.closedAt && fs.readFileSync(ledger, 'utf8').split('\n')[0] === q4line && /"type":"close"/.test(fs.readFileSync(ledger, 'utf8').split('\n')[1]));
  const q4check = expect('Q4b the subject the closed row used to clear', { category: 'publish', target: REPO + '#fix/a', agent: 'alex' }, 'refuse');
  if (!String(q4check.reason).includes('closed by ' + CEO)) { failures++; lines.push('FAIL  Q4b refusal does not name the close: ' + q4check.reason); }
  else lines.push('ok    Q4b refusal names the close and its reason');
  const q7 = ledgerRows(ledger);
  if (q7.length !== 1 || !q7[0].closedAt || q7[0].target !== REPO + '#fix/a' || q7[0].clearedBy !== CEO || q7[0].until !== '2026-12-01T00:00:00Z') {
    failures++; lines.push('FAIL  Q7 the close did not preserve the row: ' + JSON.stringify(q7));
  } else lines.push('ok    Q7 close keeps the row line byte for byte and appends a close event: the ledger still has 1 clearance row');
  // Q5 — closing twice
  qCase('Q5 a second close of the same row', qClose({ id: 'clr-q', by: CEO, why: closeWhy, closedByAgent: CEO_ID }), 'refuse', (r) => /already|is closed by/.test(r.error));
  // Q6 — an unknown id creates nothing and changes nothing
  const q6Before = fs.readFileSync(ledger, 'utf8');
  qCase('Q6 close an id that does not exist', qClose({ id: 'clr-nope', by: CEO, why: closeWhy, closedByAgent: CEO_ID }), 'refuse', (r) => /no clearance row/.test(r.error));
  if (fs.readFileSync(ledger, 'utf8') !== q6Before) { failures++; lines.push('FAIL  Q6 the refused close changed the ledger'); }
  else lines.push('ok    Q6 the ledger is byte-identical after a refused close');
  // Q8 — control: a different, still-valid row on the same subject class still ALLOWS
  qRows([qRow({ id: 'clr-spent' }), qRow({ id: 'clr-open', agent: 'jordan' })]);
  const q8 = qClose({ id: 'clr-spent', by: CEO, why: closeWhy, closedByAgent: CEO_ID });
  qCase('Q8a closing one row of a pair', q8, 'allow');
  expect('Q8b control: the other valid row on the same subject class still clears', { category: 'publish', target: REPO + '#fix/a', agent: 'jordan' }, 'allow');
  const q8list = listState(ledgerRows(ledger).find(r => r.id === 'clr-spent'), at, [], null);
  if (q8list.state !== 'closed') { failures++; lines.push('FAIL  Q8c list state for a closed row is ' + q8list.state); }
  else lines.push('ok    Q8c list reports the row as closed, not invalid and not absent (' + q8list.reason + ')');
  fs.writeFileSync(ledger, '');

  // 5. a claim with no source behind it is refused
  const claimCases = [
    ['claim with no source', { claim: 'we save customers 3 hours a week', source: '' }, 'refuse'],
    ['claim whose source does not exist', { claim: 'x', source: 'company/work/engineering/no-such-file.md' }, 'refuse'],
    ['claim whose source does not contain the words', { claim: 'x', source: 'company/work/security/standing-rules.md', excerpt: 'the quarterly revenue grew 400%' }, 'refuse'],
    ['claim with a real source and a found excerpt', { claim: 'credentials stay 0600', source: 'company/work/security/standing-rules.md', excerpt: 'All are 0600 and stay 0600' }, 'allow'],
  ];
  for (const [label, req, want] of claimCases) {
    const d = checkClaim(req, opts);
    const ok = want === 'refuse' ? d.allow === false : d.allow === true;
    if (!ok) failures++;
    lines.push((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + (d.allow ? 'ALLOWED' : 'REFUSED') + ' (' + d.reason + ')');
  }

  /* 5b. LEDGER ORDER, PREFIX STAMP AND OWN ACT. Each negative case is paired with a control that differs only in the
     one thing under test, so a refusal cannot come from some other rule. Rows the gate wrote itself (addClearance) carry
     a stamp; rows typed into the ledger by hand do not, which is exactly what the stamp cases tamper with. */
  {
    const bRun = (id, a, b) => ({ runId: id, agentId: CEO_ID, startedAt: a, endedAt: b });
    const savedRuns = RUNS_OVERRIDE;
    RUNS_OVERRIDE = savedRuns.concat([bRun('run-selftest-past', at - 3 * 3600000, at - 2 * 3600000 + 600000), bRun('run-selftest-later', at + 3300000, at + 3900000)]);
    const savedLegacy = LEGACY_OVERRIDE;
    const iso = ms => new Date(ms).toISOString();
    const spend = (over) => Object.assign({ clearedBy: CEO, category: 'spend', target: 'stripe:charge-*', agent: 'jordan', until: '2026-12-01T00:00:00Z', justification: fixture }, over);
    const sReq = (agent) => ({ category: 'spend', target: 'stripe:charge-100usd', agent: agent });
    const reasonOf = (req) => check(req, opts).reason;
    const has = (label, req, re) => { const r = reasonOf(req); const ok = re.test(r); if (!ok) failures++; lines.push((ok ? 'ok    ' : 'FAIL  ') + label + ' → ' + r.slice(0, 160)); };

    // ORDER (stamp off, so only the order rule can refuse)
    LEGACY_ALL = true;
    write([spend({ id: 'clr-o-a', agent: 'jordan', at: iso(at) }), spend({ id: 'clr-o-b', agent: 'casey', at: iso(at + 30000) })]);
    expect('O0 control: two rows in date order both answer', sReq('casey'), 'allow');
    write([spend({ id: 'clr-o-a', agent: 'jordan', at: iso(at) }), spend({ id: 'clr-o-b', agent: 'casey', at: iso(at + 3600000) })]);
    expect('O1 a row dated an hour in the future is refused', sReq('casey'), 'refuse');
    has('O1b the refusal says the row is dated in the future', sReq('casey'), /in the future/);
    expect('O1c the row above it still answers (a forged row does not poison the rest)', sReq('jordan'), 'allow');
    write([spend({ id: 'clr-o-a', agent: 'jordan', at: iso(at) }), spend({ id: 'clr-o-b', agent: 'casey', at: iso(at - 3600000) })]);
    expect('O2 a row dated earlier than the row above it is refused', sReq('casey'), 'refuse');
    has('O2b the refusal says the row is backdated', sReq('casey'), /backdated/);
    expect('O2c the row above it still answers', sReq('jordan'), 'allow');

    // PREFIX STAMP (rows from the real addClearance / closeClearance path; tamper cases edit the file by hand)
    LEGACY_ALL = false;
    const sSession = { live: true, inFlight: true, runId: 'run-selftest-ceo', startedAt: at - 60000, source: 'run-journal' };
    const sNew = (agent, atMs) => addClearance({ by: CEO, clearedByAgent: CEO_ID, category: 'spend', target: 'stripe:charge-*', agent: agent, until: '2026-12-01T00:00:00Z', justification: fixture }, { ledger: ledger, now: atMs, session: sSession });
    const sLines = () => fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
    const sSave = (ls) => fs.writeFileSync(ledger, ls.join('\n') + '\n');
    LEGACY_OVERRIDE = {};
    fs.writeFileSync(ledger, '');
    const r1 = sNew('jordan', at), r2 = sNew('casey', at + 1000);
    const stamped = r1.ok && r2.ok && !!r1.row.prefixSha && !!r2.row.prefixSha && r1.row.prefixSha !== r2.row.prefixSha;
    if (!stamped) failures++;
    lines.push((stamped ? 'ok    ' : 'FAIL  ') + 'S0 clear stamps every row it writes with a distinct prefixSha');
    expect('S1 stamped row 1 (written by clear) answers', sReq('jordan'), 'allow');
    expect('S1b stamped row 2 answers', sReq('casey'), 'allow');
    const cl = closeClearance({ id: r1.row.id, by: CEO, why: closeWhy, closedByAgent: CEO_ID }, { ledger: ledger, now: at + 2000, session: closeSession });
    if (!cl.ok) { failures++; lines.push('FAIL  S2 setup: close failed: ' + cl.error); }
    expect('S2 closing row 1 appends a close line; row 2\'s stamp still holds', sReq('casey'), 'allow');
    expect('S2b the closed row stops clearing', sReq('jordan'), 'refuse');
    const r3 = sNew('morgan', at + 3000);
    expect('S2c a row written after a close line is stamped over it and answers (stamps stay aligned with the rows)', sReq('morgan'), r3.ok ? 'allow' : 'refuse');
    { const ls = sLines(); const o = JSON.parse(ls[1]); o.at = iso(at); ls[1] = JSON.stringify(o); sSave(ls); }
    expect('S3 an earlier row\'s `at` edited by one second: its stamp no longer matches', sReq('casey'), 'refuse');
    has('S3b the refusal names the stamp', sReq('casey'), /prefix stamp does not match/);
    fs.writeFileSync(ledger, ''); sNew('jordan', at); sNew('casey', at + 1000);
    { const ls = sLines(); ls.splice(1, 0, JSON.stringify(Object.assign({ at: iso(at), clearedByAgent: CEO_ID, id: 'clr-hand' }, spend({ target: 'stripe:other-*', agent: 'any' })))); sSave(ls); }
    expect('S4 a row inserted ABOVE a stamped row: the stamped row\'s prefix changed', sReq('casey'), 'refuse');
    const lone = (over) => fs.writeFileSync(ledger, JSON.stringify(Object.assign({ at: iso(at - 2.5 * 3600000), clearedByAgent: CEO_ID, id: 'clr-lone' }, spend({ agent: 'jordan' }), over)) + '\n');
    lone({});
    expect('S5 LONE row hand-appended, dated inside a past CEO run, no stamp, not in the legacy list', sReq('jordan'), 'refuse');
    has('S5b the refusal says the row is unstamped', sReq('jordan'), /unstamped row/);
    lone({ at: iso(at) });
    expect('S6 the same lone unstamped row dated NOW is refused (there is no fresh-unstamped arm)', sReq('jordan'), 'refuse');
    fs.writeFileSync(ledger, ''); sNew('jordan', at);
    expect('S6b control: a lone row written through addClearance, dated now, answers', sReq('jordan'), 'allow');
    lone({});
    LEGACY_OVERRIDE = { unstamped: ['clr-lone'] };
    expect('S7 control: the same unstamped row, its id in the legacy list, answers', sReq('jordan'), 'allow');
    LEGACY_OVERRIDE = { unstamped: 'clr-lone' };
    expect('S8 a malformed legacy file is the neutral default: nothing is exempt', sReq('jordan'), 'refuse');
    LEGACY_OVERRIDE = {};
    { const l = legacyIds(); const okEmpty = l.unstamped.size === 0 && l.publishWithoutActs.size === 0;
      if (!okEmpty) failures++; lines.push((okEmpty ? 'ok    ' : 'FAIL  ') + 'S9 the default legacy lists are empty'); }

    // OWN ACT
    const W = REPO + '#fix/a';
    const wRow = (over) => Object.assign({ id: 'clr-w-new', clearedBy: CEO, category: 'publish', target: W, agent: 'jordan', until: '2026-12-01T00:00:00Z', justification: fixture }, over);
    // rows are STAMPED the way `clear` writes them, otherwise every refusal below would be "unstamped" and the acts / ownAct checks would never be reached
    const wWrite = (rows) => { const out = []; rows.forEach(r => { const full = Object.assign({}, rowBase, r); full.prefixSha = stampFor(out, full); out.push(full); }); fs.writeFileSync(ledger, out.map(r => JSON.stringify(r)).join('\n') + '\n'); };
    const wReq = (act) => Object.assign({ category: 'publish', target: W, agent: 'jordan' }, act ? { act: act } : {});
    wWrite([wRow({})]);
    expect('W1 publish row naming no acts and no ownAct, request MERGE', wReq('merge'), 'refuse');
    has('W1b the refusal says a publish row must name what it clears', wReq('merge'), /must name what it clears/);
    expect('W2 publish row naming no acts, request names no act', wReq(null), 'refuse');
    wWrite([wRow({ ownAct: 'merge' })]);
    expect('W3 control: ownAct merge row, request MERGE', wReq('merge'), 'allow');
    expect('W4 ownAct merge row, request PUSH', wReq('push'), 'refuse');
    expect('W5 ownAct merge row, request names no act', wReq(null), 'refuse');
    wWrite([wRow({ acts: ['push'] })]);
    expect('W6 control: acts [push] row, request PUSH', wReq('push'), 'allow');
    expect('W6b acts [push] row, request MERGE', wReq('merge'), 'refuse');
    expect('W7 acts [push] row, request names no act (publish)', wReq(null), 'refuse');
    wWrite([wRow({ acts: ['push'], ownAct: 'merge' })]);
    expect('W8 row carrying both acts and ownAct', wReq('merge'), 'refuse');
    wWrite([wRow({ ownAct: 'push' })]);
    expect('W9 ownAct that is a narrow act, not an own-row act', wReq('push'), 'refuse');
    wWrite([wRow({ ownAct: ['merge'] })]);
    expect('W10 ownAct as a list', wReq('merge'), 'refuse');
    wWrite([wRow({})]);
    LEGACY_OVERRIDE = { publishWithoutActs: ['clr-w-new'] };
    const w11 = expect('W11 a no-acts publish row whose id is in the legacy list still answers, and is flagged unnarrowed', wReq('merge'), 'allow');
    if (!w11.unnarrowed) { failures++; lines.push('FAIL  W11b the legacy no-acts answer is not flagged unnarrowed'); } else lines.push('ok    W11b the legacy answer carries unnarrowed:true');
    LEGACY_OVERRIDE = { publishWithoutActs: ['clr-someone-else'] };
    expect('W12 the same row with another id in the list gets no pass', wReq('merge'), 'refuse');
    LEGACY_OVERRIDE = {};
    fs.writeFileSync(ledger, '');
    const wa = addClearance({ by: CEO, clearedByAgent: CEO_ID, category: 'publish', target: W, agent: 'jordan', until: '2026-12-01T00:00:00Z', justification: fixture }, { ledger: ledger, now: at, session: sSession });
    const okWa = !wa.ok && /must name what it clears/.test(wa.error || '');
    if (!okWa) failures++; lines.push((okWa ? 'ok    ' : 'FAIL  ') + 'W13 clear refuses to write a publish row that names no acts and no ownAct (' + (wa.error || 'written') + ')');
    const wb = addClearance({ by: CEO, clearedByAgent: CEO_ID, category: 'publish', target: W, agent: 'jordan', until: '2026-12-01T00:00:00Z', justification: fixture, ownAct: 'merge' }, { ledger: ledger, now: at, session: sSession });
    if (!wb.ok) { failures++; lines.push('FAIL  W14 setup: clear refused an ownAct row: ' + wb.error); }
    expect('W14 control: a row written by clear with ownAct merge answers MERGE', wReq('merge'), 'allow');
    expect('W14b ... and answers nothing else', wReq('push'), 'refuse');

    RUNS_OVERRIDE = savedRuns;
    LEGACY_OVERRIDE = savedLegacy;
    LEGACY_ALL = true;
    fs.writeFileSync(ledger, '');
  }

  // 6. idempotency: the same side effect never goes out twice
  {
    const idemFile = path.join(dir, 'idem.jsonl');
    const io = Object.assign({}, opts, { idemFile, guards: { externalActions: false } });   // guardrail off: allowed + logged, so only idem decides
    const ic = (label, cond, d) => { if (!cond) failures++; lines.push((cond ? 'ok    ' : 'FAIL  ') + label + (d ? ' (' + (d.reason || JSON.stringify(d)).slice(0, 160) + ')' : '')); };
    const req = { category: 'spend', target: 'stripe:payout-acme', agent: 'sam', idem: 'payout:inv-1' };
    const d1 = check(req, io);
    ic('I1 a keyed act is allowed once and gets an attempt id', d1.allow && /^att-/.test(d1.attemptId || ''), d1);
    // crash between "gate allowed" and "send recorded": nothing marks it sent; the tool retries the whole send
    const d2 = check(req, io);
    ic('I2 a retry after a crash between allowed and send-recorded is a duplicate, not a second send', !d2.allow && d2.duplicate && d2.priorAttempt === d1.attemptId && d2.priorState === 'allowed', d2);
    ic('I3 the duplicate is logged with the prior attempt id', readJsonl(log).some(r => r.decision === 'duplicate' && r.priorAttempt === d1.attemptId));
    ic('I4 spend keys never expire (closed default: forever)', check(req, Object.assign({}, io, { now: at + 400 * 86400000 })).duplicate === true);
    ic('I5 a different key is a different act', check(Object.assign({}, req, { idem: 'payout:inv-2' }), io).allow === true);
    const m = { category: 'message', target: 'email:owner@example.com', agent: 'sam', idem: 'invoice:inv-1' };
    const m1 = check(m, io); recordSent({ attempt: m1.attemptId }, { idemFile });
    const m2 = check(m, Object.assign({}, io, { now: at + 3600000 }));
    ic('I6 message key: duplicate inside 24 h (after it was marked sent)', m1.allow && m2.duplicate && m2.priorState === 'sent', m2);
    ic('I7 message key: allowed again after 24 h', check(m, Object.assign({}, io, { now: at + 25 * 3600000 })).allow === true);
    ic('I8 a caller cannot shorten the ttl', check(Object.assign({}, m, { idem: 'short', idemTtlMs: 1 }), io).idemTtlMs === 24 * 3600000);
    const rq = { category: 'publish', target: 'github:example-org/public-gist#main', agent: 'alex', idem: 'pub-1' };
    const r1 = check(rq, Object.assign({}, io, { guards: { externalActions: true } }));
    ic('I9 a refused act takes no key: once cleared, the same key goes out', !r1.allow && !r1.duplicate && check(rq, io).allow === true, r1);
    ic('I10 release: only the owner, with a reason', !releaseIdem({ category: 'spend', key: 'payout:inv-1', by: 'sam', why: 'x'.repeat(30) }, { idemFile }).ok && releaseIdem({ category: 'spend', key: 'payout:inv-1', by: 'owner', why: 'checked the processor: payout never arrived' }, { idemFile }).ok && check(req, io).allow === true);
  }

  // every decision the selftest made is in the log, refusals with a reason
  const logged = readJsonl(log);
  const refusals = logged.filter(r => r.decision === 'refused');
  if (!refusals.length || refusals.some(r => !r.reason)) { failures++; lines.push('FAIL  refusals are not all logged with a reason'); }
  else lines.push('ok    ' + refusals.length + ' refusals written to the external-actions log with a reason, ' + logged.filter(r => r.decision !== 'refused').length + ' allowed');

  RUNS_OVERRIDE = null;
  FILE_ROOT_OVERRIDE = savedFileRoot;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(lines.join('\n'));
  console.log('');
  console.log(failures ? 'SELFTEST FAILED: ' + failures + ' case(s) wrong — the gate can be made to act' : 'SELFTEST PASSED: every category refuses without a clearance row, and only a valid row (or the two written routes) lets an action through');
  return failures ? 1 : 0;
}

/* ---- CLI ---- */
function cliArgs() {
  const a = process.argv.slice(2); const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true; }
    else o._.push(a[i]);
  }
  return o;
}

function main() {
  const a = cliArgs();
  if (a.selftest) process.exit(selftest());
  const cmd = a._[0] || 'check';
  if (cmd === 'check' || cmd === 'guard') {
    // `--act` used to be silently dropped here: check() supports acts and the CLI never passed one, so a person could
    // not ask the gate the question the acts field exists to answer ("is this PUSH covered by a row that says push?").
    const d = check({ category: a.category, target: a.target, agent: a.agent || process.env.STARNET_AGENT_ID, act: a.act, note: a.note, idem: a.idem, amountUsd: a['amount-usd'] != null ? Number(a['amount-usd']) : undefined, idemTtlMs: a['idem-ttl'] === 'forever' ? 'forever' : (a['idem-ttl'] ? Number(a['idem-ttl']) * 1000 : undefined) });
    console.log(JSON.stringify(d));
    process.exit(d.allow ? 0 : d.duplicate ? 4 : 3);
  }
  if (cmd === 'claim') {
    const d = checkClaim({ claim: a.claim || (a['claim-file'] ? '' : ''), source: a.source, excerpt: a.excerpt, agent: a.agent || process.env.STARNET_AGENT_ID });
    console.log(JSON.stringify(d));
    process.exit(d.allow ? 0 : 3);
  }
  if (cmd === 'clear') {
    const r = addClearance({ by: a.by, clearedByAgent: a['cleared-by-agent'] || process.env.STARNET_AGENT_ID || null,
      category: a.category, target: a.target, agent: a.agent, until: a.until, justification: a.justification, note: a.note,
      acts: a.acts ? String(a.acts).split(',').map(x => x.trim()).filter(Boolean) : undefined, ownAct: a['own-act'] === true ? '' : a['own-act'] });
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 2);
  }
  /* `close --id <row> --by <owner or CEO name> --why "<what consumed it>"` — ends a row whose act is done. Exit 0 closed, 2 refused
     (usage, provenance, unknown id, already closed). It records; it never deletes a line and never creates one. */
  if (cmd === 'close') {
    const r = closeClearance({ id: a.id, by: a.by, why: a.why || a['closed-why'],
      closedByAgent: a['closed-by-agent'] || a['cleared-by-agent'] || process.env.STARNET_AGENT_ID || null,
      callerAgent: a.caller || process.env.STARNET_AGENT_ID || '' });
    if (r.ok) {
      console.log(JSON.stringify({ ok: true, id: r.row.id, closedBy: r.row.closedBy, closedByAgent: r.row.closedByAgent,
        closedAt: r.row.closedAt, closedWhy: r.row.closedWhy, rows: r.rows, row: r.row }));
    } else {
      console.log(JSON.stringify(r));
    }
    process.exit(r.ok ? 0 : 2);
  }
  if (cmd === 'list') {
    const allLines = readJsonl(LEDGER);
    const rows = mergeClosed(allLines);
    const at = nowMs();
    const verdicts = ledgerVerdicts(allLines, at);
    // the recent window, plus the runs around each older row's moment (bounded reads; never the whole runs.jsonl)
    const runs = readRuns().slice(); const seenRuns = new Set(runs.map(r => r.runId));
    for (const r of rows) { const t = Date.parse(String((r && r.at) || '')); if (Number.isFinite(t)) for (const x of runsFor(t)) if (!seenRuns.has(x.runId)) { seenRuns.add(x.runId); runs.push(x); } }
    let liveRunId = null;
    try { const s = liveClearingSession(); if (s && s.live) liveRunId = s.runId || null; } catch (_) {}
    // ACT NARROWING AS A NUMBER: a row that lists no `acts` answers for EVERY act in its category — a row written for
    // "push" clears a merge. Every row reports `unnarrowed`, and the summary counts them, so the monthly read is "x of y rows name their acts" instead of a sentence in a note.
    const out = rows.map((r, ri) => {
      let st = listState(r, at, runs, liveRunId);
      if (verdicts[ri] && st.state !== 'closed') st = { valid: false, state: 'invalid', reason: verdicts[ri] };
      const unnarrowed = (!Array.isArray(r.acts) || !r.acts.length) && !r.ownAct;
      return Object.assign({}, r, st, { unnarrowed: unnarrowed,
        reach: unnarrowed ? 'no acts listed — answers for any act in category "' + r.category + '" on this target' : (r.ownAct ? 'limited to its own act: ' + r.ownAct : 'limited to: ' + r.acts.join(', ')) });
    });
    const counts = { valid: 0, pending: 0, invalid: 0, closed: 0 };
    for (const r of out) counts[r.state] = (counts[r.state] || 0) + 1;
    const unnarrowedLive = out.filter(r => r.state === 'valid' && r.unnarrowed).length;
    const res = { ok: true, ledger: path.relative(ROOT, LEDGER), count: rows.length, counts: counts, unnarrowed: { live: unnarrowedLive, ofLive: counts.valid }, rows: out };
    if (counts.pending) res.note = counts.pending + ' row(s) are "pending", not refused: each was written inside a run StarNet has not recorded yet (a run reaches runs.jsonl when it ENDS), so they validate when that run closes. The gate\'s own decision is unchanged — at the moment this was read they are not yet provable.';
    console.log(JSON.stringify(res, null, 1));
    process.exit(0);
  }
  /* `idem list | sent --attempt <id> | release --category <c> --key <k> --by owner --why ".."` */
  if (cmd === 'idem') {
    const sub = a._[1] || 'list';
    if (sub === 'list') { console.log(JSON.stringify(readJsonl(IDEM).slice(-200), null, 1)); process.exit(0); }
    if (sub === 'sent') { const r = recordSent({ attempt: a.attempt, ref: a.ref }); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 2); }
    if (sub === 'release') { const r = releaseIdem({ category: a.category, key: a.key, by: a.by, why: a.why }); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 2); }
    console.log('usage: external-gate.js idem list|sent --attempt <id>|release --category <c> --key <k> --by owner --why ".."'); process.exit(2);
  }
  if (cmd === 'categories') { console.log(Object.keys(CATEGORIES).join('\n')); process.exit(0); }
  /* `session` — one read-only line saying whether a clearing session is provable right now, and from which source.
     It exists so a person about to write a row (or a reviewer doubting one) can ask the gate instead of guessing.
     Exit 0 = a live CEO session is provable, 3 = not, 2 = usage. Read-only: it writes nothing, clears nothing. */
  if (cmd === 'session') {
    const s = liveClearingSession();
    console.log(JSON.stringify(s));
    process.exit(s.live ? 0 : 3);
  }
  console.log('usage: external-gate.js check|guard|clear|close|list|session|idem|categories|--selftest  (see the header of this file)');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { ledgerRows, check, checkClaim, mustPass, recordSent, releaseIdem, IDEM, IDEM_TTL_MS, addClearance, closeClearance, closedReason, selftest, CATEGORIES, CLEARERS, CLEARING_AGENT, OWNER_PIN_FILE, targetMatches, allowedHost, hostOf, validateRow, listState, liveClearingSession, liveJournalRun, _internals: { readJsonl, readRuns, runsFor, runsAround, appendJsonl, LEDGER, LOG, ALLOWLIST, JOURNAL_DIR,
  // In-process only (no CLI surface): lets a probe point the journal reader at a copy of a real journal.
  setJournalDir: (d) => { JOURNAL_DIR_OVERRIDE = d || null; return JOURNAL_DIR_OVERRIDE || JOURNAL_DIR; },
  // In-process only (no CLI surface): lets a probe hold runs.jsonl at an earlier state, so "what did the list say
  // mid-run" can be measured instead of described. It cannot write, clear or allow anything.
  setRuns: (r) => { RUNS_OVERRIDE = Array.isArray(r) ? r : null; return RUNS_OVERRIDE; },
  // In-process only: point the bounded runs reader at another file (tests/retention-bounded.test.js).
  setRunsFile: (f) => { RUNS_FILE_OVERRIDE = f || null; runsCache = null; return runsFile(); } } };
