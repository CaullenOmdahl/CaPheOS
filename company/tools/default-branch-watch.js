#!/usr/bin/env node
/* default-branch-watch.js — the GitHub-side tripwire for the one rule about GitHub: nothing lands on a repository's default
 * branch except a merged pull request that had a pre-merge PASS for its head.
 *
 * The owner's standing rule: agents keep full GitHub through the gh login (branches, pull requests, comments, merges through
 * the merge gate); the one rule is that an agent never puts commits on a default branch (main, master, or whatever GitHub
 * says it is, e.g. "production") except by merging a PR with a recorded PASS (company/tools/merge-gate.js). Branch
 * protection may not be available (it needs a paid plan on private repos), and the client-side gate (merge-gate.js, the gh
 * and git wrappers, the pre-push hook) cannot stop /usr/bin/git or /usr/bin/gh by absolute path, curl with the gh token, git
 * plumbing or the web UI: everyone runs as the same Unix user. This watcher stops nothing either. It looks at GitHub itself
 * and reports whatever got through, by any route. When the owner and the agents share one GitHub account, the owner's own
 * pushes and web merges are reported too: if the owner did it themselves, there is nothing to do.
 *
 *   node company/tools/default-branch-watch.js tick [--dry-run] [--preview N]   check (a full check at most every 55 min;
 *        --dry-run checks now and writes nothing; --preview N, dry runs only, judges the newest N logged changes of up to 6
 *        repos seen for the first time, so you can see how real history would be judged)
 *   node company/tools/default-branch-watch.js status                            watched repos, heads, errors, recent flags
 *   node company/tools/default-branch-watch.js baseline                          take today's heads as known-good (owner's own
 *        terminal only: it skips checking how the heads got there; the risk owner and the CEO are told what it took unchecked)
 *   node company/tools/default-branch-watch.js watch add|remove <owner/name> --by <Name> --why "..."
 *        the recorded way to change the watch list (company/work/security/default-branch-watch.json): add is the risk
 *        seat's or the owner's (it only tightens), remove is the owner's alone (it loosens). List the company's OWN repos:
 *        a repository the company cannot push to (the framework's, a vendor's) is listed but never watched.
 *   node company/tools/default-branch-watch.js selftest                          fake gh, temp folders, no network
 *
 * Which repos: the watch list, company/work/security/default-branch-watch.state.json (default in company/defaults/work/security/):
 * { "repos": ["owner/name", ...], "discover": false, "watchStart": "", "attribution": { "nearBeforeMinutes": 180, "nearAfterMinutes": 5 } }.
 * attribution is the window in which an agent tool call is named as a change's possible cause (else: who pushed is unknown). Listed repos are always watched. With discover: true
 * it also watches every repository the gh login can push to, from one `user/repos` listing per tick (paginated; archived,
 * disabled and not-pushable ones are left out, since nobody can push there; one the login owns is never left out, and one
 * GitHub lists without permissions is watched anyway), plus the github.com remotes of local clones (company/repos,
 * company/memory, scratch; depth 4, no node_modules), company/projects.json and company/work/merge-gate.log. The listing is
 * read either way: it supplies GitHub's answers for the listed repos. Repos are tracked by GitHub's repository id, so a
 * rename keeps its last checked head. A name not in the listing is looked up on its own, at most 5 a tick and each at most
 * once a day (a name GitHub does not know is parked, asked weekly, after 3 misses), so planted remotes cannot crowd the real
 * check out; one that turns out pushable is watched like the others. A watched repo that answers 404 three times and is not
 * listed (deleted, access lost) is dropped with a note to the risk owner; if it comes back, watching resumes from its last
 * checked head. A repo taken off the watch list is a note to the risk owner too, so editing the list cannot hide a repo.
 * Calls, all read-only GETs through /usr/bin/gh api with a fixed minimal environment (no GH_*, proxy or certificate
 * variables from the caller, HOME from the password database): user (once a day), user/repos, and only for a repo whose pushed_at or
 * default branch changed, that has unfinished work, or that is due its 6-hourly re-check: repos/R/branches/<b> (the head) and
 * repos/R/activity?ref=refs/heads/<b> (GitHub's own log of every change to the branch, with server time and account).
 * Judging, oldest change first, one flag per change:
 *   pr_merge / merge_queue_merge: repos/R/commits/<merge>/pulls names the PR; its head needs a PASS in
 *     company/work/evidence/premerge-<name>-<head>.json (the merge-gate.js rule, history entries included; the file name is
 *     matched without regard to case). No PASS = "merged without a pre-merge PASS"; the report says whether merge-gate.log
 *     has an ALLOWED line for it, and for which head. GitHub not naming the PR yet (it links merges a little later) waits
 *     15 min, then counts as no PASS.
 *   push = "pushed straight to the branch", whatever it holds (a local merge commit, a PR head with a PASS: the code may be
 *     what was checked, the route went around the merge gate). force_push, deletion or re-creation = "history rewritten".
 *   A change made by another GitHub account (a collaborator's own push on someone else's repo) is not ours: not flagged.
 *   A change the activity log does not show is judged from the commits: repos/R/compare/<old>...<new> and the first-parent
 *   line from new back to old (compared again from where GitHub's 250-commit list stops). A commit GitHub did not make and
 *   sign itself (committer web-flow with a verified signature) was pushed; a GitHub-made one without a merged PR is a web
 *   editor or API edit (after 15 min); behind or diverged = rewritten; a line that misses the old head = a branch pushed
 *   over the default branch. GitHub's log lags a few minutes: a change younger than 15 min is left for the next tick.
 *   A default branch that changed (renamed or switched) is flagged, and what reached it since the last check is judged too.
 * Work resumes: at most 40 judging calls per repo per tick; the watched head moves only past what was judged, so a backlog
 * or a long outage is finished on later ticks, never skipped. Repos with known heads that moved go first, oldest first.
 * First sight: a repo created after the watch started (watchStart, else the first tick, or the owner's last baseline) is a
 * "new repository" note; one with no push since then is taken as it is; otherwise every change logged on its default branch
 * since then is judged as above, so a fresh clone somewhere new plus a push is still caught.
 * Reports: rows in company/work/security/default-branch-watch.md (handoffs are written even when that file cannot be); per
 * tick at most one handoff to the risk owner (the seat holding `risk` in loops.json): OPEN with a next-day deadline when
 * there is anything to find out, DONE FYI for notes only; one DONE FYI to the CEO for direct pushes, rewritten history, a
 * changed default branch, unchecked stretches and a changed watcher state. Each item gives GitHub's time (shown in the
 * company timezone) and the agent runs going then (.starnet-data/workspaces/runs.jsonl): names on commits are not
 * evidence, agents may commit under the owner's name.
 * Dead man's switch: a repo that has needed a check for 3 h (API errors, the gh login, the time budget), a listing that has
 * failed for 3 h, no full check for 3 h, or two lock skips in a row give the tools owner an OPEN handoff and the risk owner
 * an FYI, at most once a day each. dispatch.js starts `tick` on every 10-min tick (a skipped one costs no API call), logs its
 * line and the reason of a failure, and gives the tools owner an OPEN handoff after 3 failures in a row.
 * State: company/work/security/default-branch-watch.state.json plus the same bytes in default-branch-watch.backup.json, every
 * write recorded with company/tools/provenance.js. A state that does not match this tool's last recorded write, cannot be
 * read, or has a last-check time in the future is flagged to the risk owner and the CEO at once (next dispatcher tick); the
 * tool then resumes from the backup if that still matches, and with neither it judges again from its last good write, never
 * from today's heads.
 * Lock: company/work/security/default-branch-watch.lock (pid + start); stale when its process is gone or is not this tool,
 * when it is older than 3 min or dated in the future, or when it is not a plain file.
 * Refused: a real `tick` from an agent's run (provenance.underStation(); agents may use --dry-run and status), and
 * `baseline` outside the owner's own terminal (provenance.ownerShell() and a tty). No environment variable changes it.
 * Limits (same Unix user, so tamper-evident, not tamper-proof): it stops nothing and reports within about 65 min. An agent
 * that forges the state, its backup and their provenance rows, or a fake lock holder that looks like this tool, or a tick
 * started outside the station's process tree (systemd-run), or `ssh -t localhost` to pass the owner-terminal check, can
 * still blind or reset it; each of those takes deliberate steps in the agent's transcript, a forced lock is reported after
 * two skips, and a baseline always tells the risk owner and the CEO what it took unchecked. The watch list itself should be
 * a locked file (locked-watch.js), so an edit to it leaves a diff. Commit dates are set by whoever commits, so for a repo
 * first seen after the fact only GitHub's activity log (server time) decides what is new. A repo the gh login cannot see
 * at all (an organisation that blocks the gh app but not the SSH key) is not watched. That GitHub signs its own
 * rebase-merge commits is assumed in the commit-based fallback only (the activity log needs no signature).
 * Owner of this tool: the tools owner; its flags go to the risk owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const gr = require('./lib/guardrails');
const LIVE_ROOT = co.ROOT;
const CONFIG_REL = 'company/work/security/default-branch-watch.json', CONFIG_DEFAULT_REL = 'company/defaults/work/security/default-branch-watch.json';
const TOOL = 'default-branch-watch.js', TOOL_NAME = 'Default-branch watch', MAIN = 'company/tools/' + TOOL;
const REAL_GH = '/usr/bin/gh';
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const NEAR_BEFORE_DEFAULT_MIN = 180, NEAR_AFTER_DEFAULT_MIN = 5;   // the attribution window defaults (config: attribution.nearBeforeMinutes / nearAfterMinutes)
const EVERY = 55 * MIN, CALL_MS = 15000, BUDGET_MS = 70000, MAX_JUDGE = 40, LAG_MS = 15 * MIN, STALE_MS = 3 * HOUR;
const RECHECK_MS = 6 * HOUR, RECHECK_PER_TICK = 12, OTHERS_PER_TICK = 5, OTHERS_MAX = 300, LOCK_MAX_MS = 3 * MIN, PAGES = 10;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, SHA = /^[0-9a-f]{40}$/, ZERO = /^0{40}$/;
// projections of GitHub's answers that keep GitHub's own field names, so a fake gh can answer with GitHub's shapes
const C = '{sha, parents: [(.parents // [])[] | {sha}], committer: {login: (.committer.login // null)}, commit: {message: ((.commit.message // "") | split("\\n")[0] | .[0:160]), author: {name: .commit.author.name, date: .commit.author.date}, committer: {name: .commit.committer.name, date: .commit.committer.date}, verification: {verified: (.commit.verification.verified // false), reason: (.commit.verification.reason // null)}}}';
const R = '{id, full_name, default_branch, archived, disabled, pushed_at, created_at, owner: {login: .owner.login}, permissions: (if .permissions then {push: .permissions.push} else null end)}';
const JQ = {
  user: '{login}',
  list: '[.[] | ' + R + ']',
  repo: R,
  branch: '{name, commit: {sha: .commit.sha}}',
  activity: '[.[] | {id, before, after, ref, timestamp, activity_type, actor: {login: (.actor.login // null)}}]',
  compare: '{status, ahead_by, behind_by, total_commits, commits: [(.commits // [])[] | ' + C + ']}',
  pulls: '[.[] | {number, title: ((.title // "") | .[0:160]), merged_at, merge_commit_sha, base: {ref: .base.ref}, head: {sha: .head.sha, ref: .head.ref}}]',
};
const LABEL = { 'no-pr': 'no pull request', 'no-pass': 'no pre-merge PASS', pushed: 'pushed straight to the branch', rewritten: 'history rewritten',
  'pushed-over': 'branch pushed over', 'branch-changed': 'default branch changed', unchecked: 'not fully checked', 'state-changed': 'watcher state changed',
  'new-repo': 'new repository', 'report-failed': 'report not written', 'repo-gone': 'repository gone', 'repo-unwatched': 'taken off the watch list' };
const TO_CEO = new Set(['no-pr', 'pushed', 'pushed-over', 'rewritten', 'branch-changed', 'unchecked', 'state-changed']);
const NOTE_ONLY = new Set(['new-repo', 'report-failed', 'repo-gone', 'repo-unwatched']);   // the risk owner's block is OPEN unless every flag is one of these
const mdHead = ctx => '# Default-branch watch\n\nWritten by `company/tools/default-branch-watch.js` (do not edit). About once an hour it looks at GitHub itself and lists anything that ' +
  'landed on a watched repository\'s default branch without a merged pull request that had a pre-merge PASS for its head (the owner\'s rule), ' +
  'whatever route it took: absolute-path git, curl with the token, the web UI. The owner and the agents may share one GitHub account, so the owner\'s own ' +
  'pushes and web merges show up here too: **if you (the owner) did this yourself, nothing to do.** Each tick\'s flags go to the risk owner (' + roleName(ctx, 'risk') + ') as an ' +
  'OPEN handoff; direct pushes and rewritten history also go to the CEO (' + roleName(ctx, 'ceo') + ') as an FYI. Oldest first. Which repos are watched: `' + CONFIG_REL + '`. ' +
  '`node company/tools/default-branch-watch.js status` shows what is watched.\n\n| When (' + zone(ctx.now) + ') | Repo | Branch | Event | What | Links |\n|---|---|---|---|---|---|\n';

/* ---------------- small helpers ---------------- */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const sha256 = data => 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
const iso = ms => new Date(ms).toISOString();
// wall-clock times in the company timezone (company.json), with the offset spelled out, e.g. 2026-01-02T09:00:00+02:00
let TZ = (() => { try { new Intl.DateTimeFormat('en-US', { timeZone: co.TZ }); return co.TZ; } catch (_) { return 'UTC'; } })();
function tzOffsetMin(t) {
  const o = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))) o[x.type] = x.value;
  return Math.round((Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(t / 1000) * 1000) / 60000);
}
const offStr = m => (m < 0 ? '-' : '+') + String(Math.floor(Math.abs(m) / 60)).padStart(2, '0') + ':' + String(Math.abs(m) % 60).padStart(2, '0');
const zone = t => offStr(tzOffsetMin(t));
const local = t => { const m = tzOffsetMin(t); return new Date(t + m * 60000).toISOString().slice(0, 19) + offStr(m); };
const stamp = ms => local(ms).slice(0, 16).replace('T', ' ');
const day = ms => local(ms).slice(0, 10);
const ms = s => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? t : 0; };
const short = s => String(s || '').slice(0, 8);
const one = s => String(s == null ? '' : s).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
const cell = s => one(s).replace(/\|/g, '/');
const enc = b => String(b).split('/').map(encodeURIComponent).join('/');
const commitLink = (repo, sha) => ({ t: 'commit ' + short(sha), u: 'https://github.com/' + repo + '/commit/' + sha });
const prLink = (repo, n) => ({ t: 'PR #' + n, u: 'https://github.com/' + repo + '/pull/' + n });
const compareLink = (repo, a, b) => ({ t: 'compare ' + short(a) + '...' + short(b), u: 'https://github.com/' + repo + '/compare/' + a + '...' + b });
const relTo = (ctx, f) => path.relative(ctx.root, f).split(path.sep).join('/');
function writeAtomic(f, text) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, f); }
function prov(ctx, kind, f, text) {   // locked-watch.js / provenance.js: this tool's own write
  if (ctx.dry) return;
  if (ctx.live) { try { const P = require('./provenance.js'); if (kind === 'append') P.appended(f, text, TOOL); else P.wrote(f, text, TOOL); } catch (_) {} return; }
  if (!ctx.recordTest) return;   // selftest: the same rows, in its temp folder
  try {
    const row = kind === 'append' ? { at: iso(ctx.now), file: relTo(ctx, f), kind: 'append', chunkSha: sha256(text), writer: TOOL, main: MAIN, tainted: false }
      : { at: iso(ctx.now), file: relTo(ctx, f), kind: 'write', sha256: sha256(text), writer: TOOL, main: MAIN, tainted: false };
    fs.mkdirSync(path.dirname(ctx.paths.prov), { recursive: true }); fs.appendFileSync(ctx.paths.prov, JSON.stringify(row) + '\n');
  } catch (_) {}
}
// provenance.js not loadable: the same ancestry test, and on any doubt "an agent's run" (the stricter answer)
function stationFallback() {
  const e = process.env; if (e.STARNET_USER_CONTROL_MODE === 'preserve' && e.BROWSER === 'none') return true;
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    try { if (/sidecar\/index\.js/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '))) return true; const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); pid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]); }
    catch (_) { return true; }
  }
  return false;
}

/* ---------------- which repos ----------------
 * company/work/security/default-branch-watch.json (copied from company/defaults at founding; the defaults copy is read when
 * the live one is missing): { repos: ["owner/name", ...], discover: false, watchStart: "" }. repos are always watched;
 * discover: true also watches every repository the gh login can push to and the github.com remotes of local clones.
 * watchStart (ISO) is the instant from which a repo seen for the first time is judged; empty = the first tick. */
function loadConfig(root) {
  const c = readJson(path.join(root, CONFIG_REL), null) || readJson(path.join(root, CONFIG_DEFAULT_REL), null) || {};
  const repos = [...new Map((Array.isArray(c.repos) ? c.repos : []).map(x => String(typeof x === 'string' ? x : (x && x.repo) || '').trim()).filter(x => SLUG.test(x)).map(x => [x.toLowerCase(), x])).values()];
  // The attribution window (minutes before / after a change in which an agent tool call may be named as its possible
  // cause); anything but a positive number is the default.
  const at = c.attribution && typeof c.attribution === 'object' ? c.attribution : {};
  const win = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt) * MIN;
  const near = { before: win(at.nearBeforeMinutes, NEAR_BEFORE_DEFAULT_MIN), after: win(at.nearAfterMinutes, NEAR_AFTER_DEFAULT_MIN) };
  return { repos, discover: c.discover === true, watchStart: ms(c.watchStart) ? String(c.watchStart) : null, near };
}
const roleName = (ctx, role) => one((ctx.roles[role] && ctx.roles[role].name) || 'unassigned');
const startOf = ctx => ctx.cfg.watchStart || local(ctx.now);
const OUT_OF_SCOPE = 'not in the watch list (' + CONFIG_REL + ')';
const inScope = (ctx, full) => ctx.cfg.discover || ctx.cfg.repos.some(x => x.toLowerCase() === String(full).toLowerCase());
function scopeListing(ctx, listed) {   // without discover, the listing only supplies GitHub's answers for the listed repos
  if (!listed || ctx.cfg.discover) return listed;
  const out = new Map(); for (const [k, L] of listed) if (inScope(ctx, k)) out.set(k, L); return out;
}
// a repo taken off the list stops being checked; that is a note to the risk owner, so a list edit cannot hide a repo silently
function applyScope(ctx, st, flags) {
  if (ctx.cfg.discover) { for (const r of Object.values(st.repos)) if (r.skipped === OUT_OF_SCOPE) delete r.skipped; return; }
  for (const [k, r] of Object.entries(st.repos)) {
    if (inScope(ctx, k)) { if (r.skipped === OUT_OF_SCOPE) delete r.skipped; continue; }
    if (r.skipped) continue;
    r.skipped = OUT_OF_SCOPE; delete r.needSince; delete r.pending;
    if (flags) flags.push(mk(ctx, { repo: k, branch: r.branch || '—', kind: 'repo-unwatched', title: 'taken off the watch list', links: [{ t: 'repo', u: 'https://github.com/' + k }],
      detail: k + ' is no longer in ' + CONFIG_REL + ', so its default branch is no longer checked (last checked head ' + (short(r.sha) || 'none') + '). If that was not meant, put it back: watching resumes from that head' }));
  }
}

/* ---------------- context ---------------- */
function context(o) {
  o = o || {};
  const root = path.resolve(o.root || LIVE_ROOT), P = rel => path.join(root, rel);
  const agents = (readJson(P('company/tools/loops.json'), {}) || {}).agents || {};
  // seats by function (loops.json functions), the CEO seat when nobody holds it: never by name
  const ceoId = Object.keys(agents).find(k => co.holds(agents[k], 'ceo')) || Object.keys(agents).find(k => agents[k] && agents[k].manager == null) || null;
  const seat = fn => { const id = Object.keys(agents).find(k => co.holds(agents[k], fn)) || ceoId; return id && agents[id] ? Object.assign({ id }, agents[id]) : null; };
  let PM; const pm = () => { if (PM === undefined) { try { PM = require('./provenance.js'); } catch (_) { PM = null; } } return PM; };
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : BUDGET_MS;
  return { root, live: root === LIVE_ROOT, now: Number.isFinite(o.now) ? o.now : Date.now(), dry: !!o.dry, preview: o.dry ? Math.max(0, Math.min(30, Number(o.preview) || 0)) : 0,
    log: o.log || console.log, api: o.api || null, gh: o.gh || REAL_GH, calls: 0, maxJudge: o.maxJudge || MAX_JUDGE, budgetMs, deadline: Date.now() + budgetMs, recordTest: !!o.recordTest, agents,
    roles: { risk: seat('risk'), ceo: seat('ceo'), tools: seat('tools') }, cfg: loadConfig(root),
    ownerShell: typeof o.ownerShell === 'boolean' ? o.ownerShell : !!(pm() && pm().ownerShell()),
    // guardrail defaultBranch, read from THIS root (the live one through co.guard); a selftest passes it in
    guardOn: typeof o.guardOn === 'boolean' ? o.guardOn : gr.guardIn(root, 'defaultBranch'),
    underStation: typeof o.underStation === 'boolean' ? o.underStation : (pm() ? pm().underStation() : stationFallback()),
    tty: typeof o.tty === 'boolean' ? o.tty : !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY),
    paths: { state: P('company/work/security/default-branch-watch.state.json'), backup: P('company/work/security/default-branch-watch.backup.json'), md: P('company/work/security/default-branch-watch.md'),
      lock: P('company/work/security/default-branch-watch.lock'), skips: P('company/work/security/default-branch-watch.skips.json'), handoffs: P('company/work/handoffs'),
      evidence: P('company/work/evidence'), gateLog: P('company/work/merge-gate.log'), merges: P('company/state/capheos-merges.jsonl'), prov: P('company/state/locked/provenance.jsonl'), projects: P('company/projects.json'),
      runs: P('.starnet-data/workspaces/runs.jsonl'), transcripts: P('.starnet-data/workspaces/transcript-history-v2') } };
}

/* ---------------- GitHub, read-only ---------------- */
function ghEnv() {   // never the caller's: GH_TOKEN, GH_CONFIG_DIR, GH_HOST, proxies and certificate overrides cannot steer it
  let u; try { u = os.userInfo(); } catch (_) { u = { uid: process.getuid ? process.getuid() : 0, username: 'user', homedir: os.homedir() }; }
  const run = '/run/user/' + u.uid;
  return { PATH: '/usr/bin:/bin', HOME: u.homedir, USER: u.username, LOGNAME: u.username, LANG: 'C.UTF-8', XDG_RUNTIME_DIR: run, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + run + '/bus',
    GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1' };
}
function api(ctx, endpoint, jq) {
  if (Date.now() > ctx.deadline) { const e = new Error('out of time for this tick (' + Math.round(ctx.budgetMs / 1000) + ' s budget); the rest is checked next tick'); e.deadline = true; throw e; }
  ctx.calls++;
  if (ctx.api) return ctx.api(endpoint);   // selftest
  const args = ['api', '-X', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint].concat(jq ? ['--jq', jq] : []);
  let out;
  try { out = execFileSync(ctx.gh, args, { encoding: 'utf8', timeout: CALL_MS, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: ghEnv(), cwd: '/' }); }
  catch (e) {
    const first = String(e.stderr || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || (e.signal || e.code === 'ETIMEDOUT' ? 'gh gave no answer in ' + CALL_MS / 1000 + ' s' : String(e.message || e).split('\n')[0]);
    const err = new Error(one(first).slice(0, 200)); const m = first.match(/HTTP (\d{3})/); err.status = m ? Number(m[1]) : 0; throw err;
  }
  try { return JSON.parse(out); } catch (_) { throw new Error('gh did not answer JSON for ' + endpoint.split('?')[0]); }
}
function viewer(ctx, st) {
  if (st.viewer && st.viewer.login && ctx.now - ms(st.viewer.at) < DAY && ctx.now >= ms(st.viewer.at)) return st.viewer.login;
  try { const u = api(ctx, 'user', JQ.user); if (u && /^[A-Za-z0-9-]+$/.test(String(u.login || ''))) { st.viewer = { login: u.login, at: local(ctx.now) }; return u.login; } } catch (e) { if (e.deadline) throw e; }
  return (st.viewer && st.viewer.login) || null;
}
function listRepos(ctx) {
  const all = new Map();
  for (let page = 1; page <= PAGES; page++) {
    const list = api(ctx, 'user/repos?per_page=100&page=' + page, JQ.list);
    if (!Array.isArray(list)) throw new Error('GitHub did not answer a list of repositories');
    for (const L of list) if (L && SLUG.test(String(L.full_name || ''))) all.set(L.full_name.toLowerCase(), L);
    if (list.length < 100) return all;
  }
  throw new Error('more than ' + PAGES * 100 + ' repositories: the listing was cut short');
}
const own = (ctx, L) => !!(ctx.viewer && L && L.owner && String(L.owner.login || '').toLowerCase() === ctx.viewer.toLowerCase());
const permsMissing = L => !L || !L.permissions || typeof L.permissions.push !== 'boolean';
const skipWhy = L => L.disabled ? 'disabled by GitHub (nobody can push)' : L.archived ? 'archived (read-only on GitHub)' : 'this gh login cannot push here, so no agent can';
const watchable = (ctx, L) => !!L && L.archived !== true && L.disabled !== true && (permsMissing(L) || L.permissions.push === true || own(ctx, L));

/* ---------------- local remotes (looked up, never trusted to pick the work) ---------------- */
function remotesOf(dir) {
  let gd = path.join(dir, '.git');
  try { if (fs.statSync(gd).isFile()) { const m = fs.readFileSync(gd, 'utf8').match(/^gitdir:\s*(.+)$/m); if (!m) return []; gd = path.resolve(dir, m[1].trim()); } } catch (_) { return []; }
  try { const c = fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim(); if (c) gd = path.resolve(gd, c); } catch (_) {}   // a worktree: remotes live in the main repo
  let txt = ''; try { txt = fs.readFileSync(path.join(gd, 'config'), 'utf8'); } catch (_) { return []; }
  const out = []; let inRemote = false;
  for (const l of txt.split('\n')) {
    const sec = l.match(/^\s*\[\s*([A-Za-z0-9.-]+)/); if (sec) { inRemote = sec[1].toLowerCase() === 'remote'; continue; }
    const kv = inRemote && l.match(/^\s*(?:url|pushurl)\s*=\s*(.+?)\s*$/i); if (kv) out.push(kv[1].replace(/^"|"$/g, ''));
  }
  return out;
}
const slugOf = url => { const m = String(url).match(/github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i); return m ? m[1] + '/' + m[2] : null; };
function discover(ctx) {
  const found = new Map();   // lower-case owner/name -> { repo, foundIn }
  const add = (slug, where) => { if (!slug || !SLUG.test(slug)) return; const k = slug.toLowerCase(); if (!found.has(k)) found.set(k, { repo: slug, foundIn: [] }); const f = found.get(k).foundIn; if (!f.includes(where)) f.push(where); };
  for (const r of ctx.cfg.repos) add(r, CONFIG_REL);
  if (!ctx.cfg.discover) return found;
  const rel = d => relTo(ctx, d);
  const walk = (dir, depth) => {
    let repo = false; try { fs.lstatSync(path.join(dir, '.git')); repo = true; } catch (_) {}
    if (repo) { for (const u of remotesOf(dir)) add(slugOf(u), rel(dir)); return; }   // a checkout's own folders are not searched
    if (depth >= 4) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (_) { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(dir, e.name), depth + 1);
  };
  for (const base of ['company/repos', 'company/memory', 'scratch']) walk(path.join(ctx.root, base), 0);
  const pj = readJson(ctx.paths.projects, {}) || {};
  for (const p of Array.isArray(pj.projects) ? pj.projects : []) { if (!p) continue; add(slugOf(p.remote || ''), 'company/projects.json'); for (const u of ((p.git || {}).remotes || [])) add(slugOf(typeof u === 'string' ? u : (u && (u.url || u.fetch)) || ''), 'company/projects.json'); }
  let log = ''; try { log = fs.readFileSync(ctx.paths.gateLog, 'utf8'); } catch (_) {}
  for (const m of log.matchAll(/(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) #\d+/g)) add(m[1], 'company/work/merge-gate.log');
  return found;
}

/* ---------------- the state's repo set ---------------- */
function newEntry(st, at, L) { return { id: L && L.id != null ? L.id : null, branch: null, sha: null, actAt: st.since || at, since: at }; }
// the listing decides what is watched; GitHub's repository id keeps a renamed repo's history
function syncWatched(ctx, st, listed, at, rows) {
  const byId = new Map(), byLower = new Map();
  for (const [k, r] of Object.entries(st.repos)) { if (r.id != null) byId.set(String(r.id), k); byLower.set(k.toLowerCase(), k); }
  for (const L of listed.values()) {
    const name = L.full_name, w = watchable(ctx, L);
    let k = (L.id != null && byId.get(String(L.id))) || byLower.get(name.toLowerCase());
    if (!k) { if (!w) continue; st.repos[name] = newEntry(st, at, L); k = name; byLower.set(name.toLowerCase(), name); }
    else if (k !== name) {   // renamed on GitHub: the entry that holds a checked head wins over an empty one under the new name
      const r = st.repos[k], other = st.repos[name];
      if (other && other !== r && other.sha && !r.sha) { delete st.repos[k]; }
      else { delete st.repos[k]; st.repos[name] = Object.assign(r, { renamedFrom: k }); rows.push(row(ctx, name, r.branch, 'renamed', 'GitHub now calls ' + k + ' ' + name + ' (same repository id); its last checked head is kept', [])); }
      k = name; byLower.set(name.toLowerCase(), name);
    }
    const r = st.repos[k]; r.id = L.id != null ? L.id : r.id;
    if (w) delete r.skipped; else r.skipped = skipWhy(L);
    if (permsMissing(L)) r.note = 'GitHub listed it without permissions: watched anyway'; else delete r.note;
    delete r.unlisted;
  }
  for (const [k, r] of Object.entries(st.repos)) if (!listed.has(k.toLowerCase())) r.unlisted = r.unlisted || local(ctx.now);
}
function syncOthers(ctx, st, found, at) {
  const watchedLower = new Map(Object.keys(st.repos).map(k => [k.toLowerCase(), k]));
  for (const [lk, f] of found) {
    const wk = watchedLower.get(lk); if (wk) { st.repos[wk].foundIn = f.foundIn.slice(0, 12); continue; }
    const o = st.others[lk] = st.others[lk] || { repo: f.repo, misses: 0, firstSeen: at };
    o.foundIn = f.foundIn.slice(0, 12); o.seenAt = at;
  }
  for (const k of Object.keys(st.others)) {
    const o = st.others[k];
    if (!SLUG.test(k) || !o || typeof o !== 'object' || !SLUG.test(String(o.repo || '')) || watchedLower.has(k)) { delete st.others[k]; continue; }
    if (!found.has(k) && ctx.now - ms(o.seenAt) > 30 * DAY) delete st.others[k];
  }
  const keys = Object.keys(st.others); if (keys.length > OTHERS_MAX) keys.sort((a, b) => ms(st.others[a].seenAt) - ms(st.others[b].seenAt)).slice(0, keys.length - OTHERS_MAX).forEach(k => delete st.others[k]);
}

/* ---------------- the merge gate's records ---------------- */
function evidenceIndex(ctx) {
  if (!ctx.evIdx) { ctx.evIdx = new Map(); try { for (const f of fs.readdirSync(ctx.paths.evidence)) if (/^premerge-.+-[0-9a-f]{40}\.json$/i.test(f)) ctx.evIdx.set(f.toLowerCase(), f); } catch (_) {} }
  return ctx.evIdx;
}
// same rule as merge-gate.js passFor (not required: that file runs its CLI when loaded); the file name without regard to case
function passFor(ctx, names, sha) {
  if (!SHA.test(String(sha || ''))) return { ok: false, why: 'GitHub gave no head commit for it' };
  const idx = evidenceIndex(ctx);
  for (const n of [...new Set(names.filter(Boolean).map(x => String(x).split('/').pop().toLowerCase()))].filter(x => /^[a-z0-9_.-]+$/.test(x))) {
    const f = idx.get('premerge-' + n + '-' + sha + '.json'); if (!f) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(ctx.paths.evidence, f), 'utf8')); } catch (_) { continue; }
    if (!d || typeof d !== 'object' || d.sha !== sha) return { ok: false, why: 'the pre-merge record for head ' + short(sha) + ' is for another commit' };
    const passed = d.verdict === 'PASS' || (Array.isArray(d.history) && d.history.some(h => h && h.verdict === 'PASS' && (!h.sha || h.sha === sha)));
    return passed ? { ok: true } : { ok: false, why: 'the pre-merge check did not pass for head ' + short(sha) + ' (verdict ' + one(d.verdict) + ')' };
  }
  return { ok: false, why: 'no pre-merge record for head ' + short(sha) };
}
function gateLines(ctx) {
  if (ctx.gateTxt == null) { try { ctx.gateTxt = fs.readFileSync(ctx.paths.gateLog, 'utf8'); } catch (_) { ctx.gateTxt = ''; } }
  return ctx.gateTxt.split('\n');
}
function gateLine(ctx, names, n) {
  const want = new Set(names.filter(Boolean).map(x => String(x).toLowerCase()));
  let hit = null;
  for (const l of gateLines(ctx)) { const m = l.match(/^(\S+) ALLOWED ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) #(\d+) head ([0-9a-f]+)/); if (m && want.has(m[2].toLowerCase()) && Number(m[3]) === n) hit = { at: m[1].slice(0, 16).replace('T', ' ') + 'Z', head: m[4], repo: m[2] }; }
  return hit;
}
function ownerBaselines(ctx) {
  if (ctx._baselines !== undefined) return ctx._baselines;
  const out = [];
  if (ctx.paths && ctx.paths.merges) {
    try {
      const ls = require('./lib/recorded').lines(ctx.paths.merges, ['capheos-merge.js'], { root: ctx.root });
      for (const l of ls) {
        let r; try { r = JSON.parse(l); } catch (_) { continue; }
        if (r && r.kind === 'baseline' && typeof r.repo === 'string' && SHA.test(String(r.sha || ''))) out.push(r);
      }
    } catch (_) {}
  }
  return (ctx._baselines = out);
}
function ownerBaselineFor(ctx, names, sha) {
  if (!SHA.test(String(sha || ''))) return null;
  const want = new Set(names.filter(Boolean).map(x => String(x).toLowerCase()));
  return ownerBaselines(ctx).find(r => r.sha === sha && want.has(r.repo.toLowerCase())) || null;
}

/* ---------------- judging ---------------- */
const madeByGitHub = c => !!(c && c.committer && c.committer.login === 'web-flow' && c.commit && c.commit.verification && c.commit.verification.verified === true);
const who = c => {
  const k = (c && c.commit) || {}, a = one((k.author || {}).name) || '?', m = one((k.committer || {}).name) || '?', login = c && c.committer && c.committer.login, v = k.verification || {};
  if (madeByGitHub(c)) return 'made and signed by GitHub (a merge, the web editor or the API), author ' + a + (k.committer && k.committer.date ? ', ' + k.committer.date : '');
  return 'author ' + a + ', committer ' + m + (login ? ' (GitHub account ' + login + ')' : '') + ', ' + (v.verified ? 'signed, but not by GitHub' : 'not signed by GitHub' + (v.reason ? ' (' + one(v.reason) + ')' : '')) +
    (k.committer && k.committer.date ? ', commit time ' + k.committer.date : '');
};
const subj = c => '"' + one(String(((c && c.commit) || {}).message || '').split('\n')[0]).slice(0, 100) + '"';
function mk(ctx, f) { return Object.assign({ at: local(ctx.now), label: LABEL[f.kind] || f.kind, links: [] }, f); }
const room = (ctx, res) => ctx.calls - res.start < ctx.maxJudge;
const lagging = (ctx, m) => !!(m.L && m.L.pushed_at && ctx.now - ms(m.L.pushed_at) < LAG_MS);
function pullsOf(ctx, m, sha) {
  const prs = api(ctx, 'repos/' + m.full + '/commits/' + sha + '/pulls', JQ.pulls);
  return (Array.isArray(prs) ? prs : []).filter(p => p && p.merged_at && p.base && (p.base.ref === m.branch || (m.oldBranch && p.base.ref === m.oldBranch)));
}
const prNames = m => [m.full, m.key, m.r.renamedFrom];
function judgePr(ctx, m, pr, info, res) {
  const { full, branch, r } = m, head = pr.head && pr.head.sha;
  r.prSeen = Array.isArray(r.prSeen) ? r.prSeen : [];
  if (r.prSeen.includes(pr.number)) { res.verdicts.push('ok   ' + short(info.landed) + ' more of PR #' + pr.number + ' (judged already)'); return; }
  r.prSeen = r.prSeen.concat([pr.number]).slice(-60);
  const gate = gateLine(ctx, prNames(m), pr.number), pass = passFor(ctx, prNames(m).concat(gate ? [gate.repo] : []), head);
  const viaPush = !!(pr.merge_commit_sha && head && pr.merge_commit_sha === head);
  const prText = 'PR #' + pr.number + ' "' + one(pr.title).slice(0, 100) + '" (head ' + short(head) + (info.n > 1 ? ', ' + info.n + ' commits on ' + branch : '') + ')';
  const gateText = gate ? 'merge-gate.log has an ALLOWED line for #' + pr.number + ' at ' + gate.at + (head && !head.startsWith(gate.head) ? ' but for head ' + gate.head + ', not the merged head ' + short(head) + ' (the head changed after the gate)' : '')
    : 'merge-gate.log has no ALLOWED line for #' + pr.number + ', so the merge did not go through the merge gate (absolute-path gh, the API or the web UI, or the owner)';
  const links = [prLink(full, pr.number), commitLink(full, info.landed)];
  if (pass.ok && !viaPush) { res.ok++; res.verdicts.push('ok   ' + short(info.landed) + ' ' + prText + ' merged; a PASS is recorded for its head' + (gate ? '; merge gate ALLOWED it' : '')); return; }
  const bl = !viaPush ? ownerBaselineFor(ctx, prNames(m), info.landed) : null;
  if (bl) { res.ok++; res.verdicts.push('ok   ' + short(info.landed) + ' ' + prText + ' merged; owner baseline recorded by ' + one(bl.by || 'owner') + (bl.at ? ' (' + one(bl.at).slice(0, 16) + ')' : '')); return; }
  const f = pass.ok
    ? mk(ctx, { repo: full, branch, kind: 'pushed', pr: pr.number, sha: info.landed, t: info.t, tNote: info.tNote, title: 'pushed straight to ' + branch, links,
      detail: prText + ' was not merged: its head was pushed straight to ' + branch + ' and GitHub then marked the PR merged. The head has a pre-merge PASS, so the code is what was checked, but the push went around the merge gate' })
    : mk(ctx, { repo: full, branch, kind: 'no-pass', pr: pr.number, sha: info.landed, t: info.t, tNote: info.tNote, title: 'merged without a pre-merge PASS', links,
      detail: prText + (info.when ? ' merged at ' + info.when : '') + ': ' + pass.why + '; ' + gateText + (viaPush ? '. GitHub marked it merged because its head was pushed straight to ' + branch + ' (not merged with gh or the merge button)' : '') });
  res.flags.push(f); res.verdicts.push('FLAG ' + short(info.landed) + ' ' + f.title + ': ' + f.detail);
}
// one change from GitHub's activity log. Returns 'defer' when GitHub has not linked a fresh merge to its PR yet.
function judgeActivity(ctx, m, a, res) {
  const { full, branch } = m, type = String(a.activity_type || '?'), actor = (a.actor && a.actor.login) || null, when = String(a.timestamp || ''), t = ms(when);
  const span = short(a.before) + '..' + short(a.after), base = { repo: full, branch, t, tNote: 'GitHub\'s time' };
  if (actor && ctx.viewer && actor.toLowerCase() !== ctx.viewer.toLowerCase()) { res.verdicts.push('other ' + type + ' ' + span + ' at ' + when + ' by ' + actor + ', another GitHub account (not this login, so not an agent): not flagged'); return null; }
  const flag = f => { const x = mk(ctx, Object.assign({}, base, f)); res.flags.push(x); res.verdicts.push('FLAG ' + short(x.sha) + ' ' + x.title + ': ' + x.detail); };
  if (type === 'pr_merge' || type === 'merge_queue_merge') {
    const prs = pullsOf(ctx, m, a.after), pr = prs.find(p => p.merge_commit_sha === a.after) || prs[0];
    if (!pr) {
      if (ctx.now - t < LAG_MS) return 'defer';
      flag({ kind: 'no-pass', sha: a.after, title: 'merged without a pre-merge PASS', links: [commitLink(full, a.after)],
        detail: 'GitHub logged a pull-request merge onto ' + branch + ' at ' + when + ' (' + span + ') but names no merged pull request for ' + short(a.after) + ', so its pre-merge PASS cannot be checked' });
      return null;
    }
    judgePr(ctx, m, pr, { landed: a.after, when, t, tNote: 'GitHub\'s time', n: 0 }, res);
    return null;
  }
  if (type === 'push') {
    let detail = 'GitHub logged a push (not a pull-request merge) onto ' + branch + ' at ' + when + ' by ' + (actor || '?') + ': ' + span;
    if (SHA.test(String(a.before || '')) && !ZERO.test(a.before)) {
      try {
        const cmp = api(ctx, 'repos/' + full + '/compare/' + a.before + '...' + a.after, JQ.compare) || {}, cs = cmp.commits || [], newest = cs[cs.length - 1];
        detail += cmp.status === 'ahead' ? ', ' + (cmp.total_commits || cs.length) + ' commit(s); newest ' + short(a.after) + ' ' + subj(newest) + ', ' + who(newest) : ' (' + one(cmp.status) + ': it also dropped commits)';
      } catch (e) { if (e.deadline) throw e; }
    }
    try {
      const pr = pullsOf(ctx, m, a.after)[0];
      if (pr) { const gate = gateLine(ctx, prNames(m), pr.number), pass = passFor(ctx, prNames(m).concat(gate ? [gate.repo] : []), pr.head && pr.head.sha); detail += '. GitHub links ' + short(a.after) + ' to PR #' + pr.number + (pass.ok ? ', whose head has a pre-merge PASS: the code may be what was checked, but it went around the merge gate' : ' (' + pass.why + ')'); }
    } catch (e) { if (e.deadline) throw e; }
    flag({ kind: 'pushed', sha: a.after, title: 'pushed straight to ' + branch, detail, links: SHA.test(String(a.before || '')) && !ZERO.test(a.before) ? [compareLink(full, a.before, a.after)] : [commitLink(full, a.after)] });
    return null;
  }
  if (type === 'force_push') { flag({ kind: 'rewritten', sha: a.after, title: 'history rewritten (force push or reset)', links: [compareLink(full, a.before, a.after)], detail: 'GitHub logged a force push onto ' + branch + ' at ' + when + ' by ' + (actor || '?') + ': ' + short(a.before) + ' was replaced by ' + short(a.after) + '; GitHub merges never do that' }); return null; }
  if (type === 'branch_deletion') { flag({ kind: 'rewritten', sha: a.before, title: 'the default branch was deleted', links: [commitLink(full, a.before)], detail: branch + ' was deleted at ' + when + ' by ' + (actor || '?') + ' (it was at ' + short(a.before) + ')' }); return null; }
  if (type === 'branch_creation') {
    if (res.cursor && a.after === res.cursor) { res.verdicts.push('ok   ' + short(a.after) + ' ' + branch + ' created again at the commit it had (' + when + ')'); return null; }
    if (!res.cursor && m.first) { flag({ kind: 'new-repo', sha: a.after, title: 'the default branch was first pushed', links: [commitLink(full, a.after)], detail: branch + ' was created at ' + when + ' by ' + (actor || '?') + ' at ' + short(a.after) + ' (the first commits of a branch cannot come from a pull request)' }); return null; }
    flag({ kind: 'rewritten', sha: a.after, title: 'the default branch was created again', links: [commitLink(full, a.after)], detail: branch + ' was created at ' + when + ' by ' + (actor || '?') + ' at ' + short(a.after) + (res.cursor ? ', replacing ' + short(res.cursor) : '') + ': a push, not a merge' });
    return null;
  }
  flag({ kind: 'pushed', sha: a.after, title: 'changed outside a pull request', links: [commitLink(full, a.after)], detail: 'GitHub logged a "' + one(type).slice(0, 40) + '" change onto ' + branch + ' at ' + when + ' by ' + (actor || '?') + ': ' + span });
  return null;
}
// a stretch GitHub's activity log does not explain: judge the commits. true = judged up to `to` (res.cursor = to).
function walkGap(ctx, m, res, from, to) {
  const { full, branch, r } = m, link = compareLink(full, from, to);
  let cmp;
  try { cmp = api(ctx, 'repos/' + full + '/compare/' + from + '...' + to, JQ.compare) || {}; }
  catch (e) {
    if (e.deadline || e.status !== 404) throw e;
    r.compareMiss = (r.compareMiss || 0) + 1;
    if (r.compareMiss < 2) throw new Error(e.message + ' comparing ' + branch + ' with ' + short(from) + ' (asked again next tick)');
    delete r.compareMiss;
    res.flags.push(mk(ctx, { repo: full, branch, kind: 'rewritten', sha: to, title: 'history rewritten (force push or reset)', links: [commitLink(full, to)],
      detail: branch + ' is now at ' + short(to) + ' and ' + short(from) + ', where it was, is no longer on GitHub (compare answered 404 twice): a force push or a reset; GitHub merges never do that' }));
    res.cursor = to; res.actAt = iso(ctx.now); res.actId = 0; return true;
  }
  delete r.compareMiss;
  if (cmp.status === 'identical') { res.cursor = to; return true; }
  if (cmp.status !== 'ahead') {
    const detail = cmp.status === 'behind' ? branch + ' moved back ' + (cmp.behind_by || '?') + ' commit(s), from ' + short(from) + ' to the older ' + short(to) + ': a force push or a reset'
      : branch + ' moved from ' + short(from) + ' to ' + short(to) + ', which does not contain it (' + (cmp.status || '?') + ': ' + (cmp.behind_by || '?') + ' commit(s) dropped, ' + (cmp.ahead_by || '?') + ' new): a force push; GitHub merges never do that';
    res.flags.push(mk(ctx, { repo: full, branch, kind: 'rewritten', sha: to, title: 'history rewritten (force push or reset)', detail, links: [link, commitLink(full, to)] }));
    res.cursor = to; res.actAt = iso(ctx.now); res.actId = 0; return true;
  }
  // the first-parent line from `to` back to `from`, compared again from where GitHub's list (newest 250) stops
  const map = new Map((cmp.commits || []).map(c => [c.sha, c]));
  let truncated = (Number(cmp.total_commits) || 0) > map.size, extra = 0, s = to, reached = false, over = false;
  const chain = [];
  while (chain.length < 5000) {
    if (s === from) { reached = true; break; }
    if (!s) { over = true; break; }
    let c = map.get(s);
    if (!c && truncated && extra < 8) {
      extra++;
      const more = api(ctx, 'repos/' + full + '/compare/' + from + '...' + s, JQ.compare) || {};
      if (more.status === 'identical') { reached = true; break; }
      if (more.status !== 'ahead') { over = true; break; }
      for (const x of more.commits || []) map.set(x.sha, x);
      truncated = (Number(more.total_commits) || 0) > (more.commits || []).length;
      c = map.get(s);
    }
    if (!c) { if (!truncated) over = true; break; }
    chain.push(c); s = c.parents && c.parents[0] ? c.parents[0].sha : null;
  }
  if (!reached && !over) {
    res.flags.push(mk(ctx, { repo: full, branch, kind: 'unchecked', sha: to, title: 'not fully checked', links: [link],
      detail: 'the first-parent line of ' + branch + ' from ' + short(to) + ' could not be followed back to ' + short(from) + ' within ' + (extra + 1) + ' comparisons (' + chain.length + ' commits followed); that stretch was not checked: check it by hand' }));
    res.cursor = to; res.actAt = iso(ctx.now); res.actId = 0; return true;
  }
  if (over) res.flags.push(mk(ctx, { repo: full, branch, kind: 'pushed-over', sha: to, title: 'landed on ' + branch + ' without a pull request: a branch was pushed over it', links: [link],
    detail: 'the first-parent history of ' + branch + ' from ' + short(to) + ' does not pass through ' + short(from) + ', where it was, so a branch was pushed over ' + branch + ' (a GitHub merge, squash or rebase never does that); the commits on the new line are judged one by one' }));
  chain.reverse();   // oldest first
  let group = null, i = 0;
  const close = () => { if (group) { emitGroup(ctx, m, group, res); group = null; } };
  const stop = why => { close(); if (i) res.cursor = chain[i - 1].sha; res.why = why; return false; };
  try {
    for (; i < chain.length; i++) {
      if (!room(ctx, res)) return stop('more to judge than one tick allows (' + ctx.maxJudge + ' calls); the rest next tick');
      const c = chain[i], made = madeByGitHub(c), prs = pullsOf(ctx, m, c.sha), pr = prs.find(p => p.merge_commit_sha === c.sha) || prs[0];
      if (made && !pr && ctx.now - ms(c.commit && c.commit.committer && c.commit.committer.date) < LAG_MS) return stop('GitHub has not linked ' + short(c.sha) + ' to a pull request yet');
      const kind = !made ? 'pushed' : !pr ? 'no-pr' : 'pr', key = kind === 'pr' ? 'pr#' + pr.number : kind === 'pushed' ? 'pushed' : 'no-pr ' + c.sha;
      if (!group || group.key !== key) { close(); group = { key, kind, pr: kind === 'no-pr' ? null : pr, commits: [] }; }
      group.commits.push(c); if (!group.pr && pr) group.pr = pr;
    }
  } catch (e) { close(); if (i) res.cursor = chain[i - 1].sha; throw e; }
  close(); res.cursor = to; res.actAt = iso(ctx.now); res.actId = 0; return true;
}
function emitGroup(ctx, m, g, res) {
  const { full, branch } = m, cs = g.commits, newest = cs[cs.length - 1], cdate = c => ms(c && c.commit && c.commit.committer && c.commit.committer.date) || null;
  if (g.kind === 'pr') { judgePr(ctx, m, g.pr, { landed: g.pr.merge_commit_sha || newest.sha, when: (newest.commit && newest.commit.committer && newest.commit.committer.date) || '', t: cdate(newest), tNote: 'GitHub\'s commit time', n: cs.length }, res); return; }
  let f;
  if (g.kind === 'no-pr') f = mk(ctx, { repo: full, branch, kind: 'no-pr', sha: newest.sha, t: cdate(newest), tNote: 'GitHub\'s commit time', title: 'landed on ' + branch + ' without a pull request', links: [commitLink(full, newest.sha)],
    detail: 'commit ' + short(newest.sha) + ' ' + subj(newest) + ' was made on github.com (signed by GitHub: the web editor or the API) without a merged pull request; ' + who(newest) });
  else {
    let detail = (cs.length > 1 ? cs.length + ' first-parent commits ' + short(cs[0].sha) + '..' + short(newest.sha) + ', the newest ' : 'commit ' + short(newest.sha) + ' ') + subj(newest) + ', ' + who(newest) + ': not made and signed by GitHub, so pushed from a clone rather than merged on GitHub';
    if (g.pr) { const pass = passFor(ctx, prNames(m), g.pr.head && g.pr.head.sha); detail += '. GitHub links it to PR #' + g.pr.number + (pass.ok ? ', whose head has a pre-merge PASS: the code may be what was checked, but it went around the merge gate' : ' (' + pass.why + ')'); }
    f = mk(ctx, { repo: full, branch, kind: 'pushed', sha: newest.sha, pr: g.pr ? g.pr.number : null, t: cdate(newest), tNote: 'commit time, set by whoever made the commit', title: 'pushed straight to ' + branch, detail,
      links: [cs.length > 1 ? compareLink(full, cs[0].parents && cs[0].parents[0] ? cs[0].parents[0].sha : cs[0].sha, newest.sha) : commitLink(full, newest.sha)] });
  }
  res.flags.push(f); res.verdicts.push('FLAG ' + short(f.sha) + ' ' + f.title + ': ' + f.detail);
}
function activities(ctx, m, ref, since, sinceId) {
  const list = api(ctx, 'repos/' + m.full + '/activity?ref=' + encodeURIComponent('refs/heads/' + ref) + '&per_page=100', JQ.activity);
  if (!Array.isArray(list)) throw new Error('GitHub did not answer a list of changes');
  const onRef = list.filter(a => a && a.ref === 'refs/heads/' + ref && SHA.test(String(a.after || '')));
  const after = ms(since), afterId = Number(sinceId) || 0;
  const want = onRef.filter(a => ms(a.timestamp) > after || (afterId > 0 && ms(a.timestamp) === after && Number(a.id) > afterId)).sort((x, y) => (ms(x.timestamp) - ms(y.timestamp)) || (Number(x.id) - Number(y.id)));
  want.full = list.length >= 100 && want.length === onRef.length;   // the whole page is new: older new changes may be on the next page
  return want;
}
// everything that reached m.branch since the last check: GitHub's activity log first, the commits for what it does not explain
function judgeRange(ctx, m) {
  const { r } = m, res = { flags: [], verdicts: [], ok: 0, cursor: r.sha || null, actAt: r.actAt || null, actId: r.actId || 0, done: false, why: null, error: null, start: ctx.calls };
  try {
    let acts = null;
    try { acts = activities(ctx, m, m.oldBranch || m.branch, r.actAt, r.actId); }
    catch (e) { if (e.deadline) throw e; if (m.first && e.status !== 404) throw e; res.verdicts.push('GitHub\'s activity log could not be read (' + one(e.message).slice(0, 120) + '): judged from the commits'); }
    if (m.first) {   // first sight: start where GitHub's log starts after the cutoff
      if (acts && !acts.length) {
        if (lagging(ctx, m)) { res.why = 'GitHub has not logged its newest change yet'; return res; }
        res.cursor = m.head; res.verdicts.push('nothing logged on ' + m.branch + ' since ' + one(r.actAt).slice(0, 16) + ': taken as it is'); res.done = true; return res;
      }
      if (!acts || acts.full) res.flags.push(mk(ctx, { repo: m.full, branch: m.branch, kind: 'unchecked', sha: m.head, title: 'not fully checked', links: [commitLink(m.full, m.head)],
        detail: (acts ? 'more than 100 changes were logged on ' + m.branch + ' since ' + one(r.actAt).slice(0, 16) + ' (the watch start); only the newest 100 were judged' : 'GitHub\'s activity log is not available for it, so what landed on ' + m.branch + ' since ' + one(r.actAt).slice(0, 16) + ' was not checked') + ': check the older part by hand' }));
      if (!acts) { res.cursor = m.head; res.actAt = iso(ctx.now); res.actId = 0; res.done = true; return res; }
      res.cursor = ZERO.test(acts[0].before || '') ? null : acts[0].before;
    }
    for (const a of acts || []) {
      if (!room(ctx, res)) { res.why = 'more to judge than one tick allows (' + ctx.maxJudge + ' calls); the rest next tick'; return res; }
      if (a.after === res.cursor && a.activity_type !== 'branch_creation') { res.verdicts.push('ok   ' + short(a.after) + ' ' + a.activity_type + ' at ' + a.timestamp + ' (already judged)'); res.actAt = a.timestamp; res.actId = a.id; continue; }
      if (res.cursor && SHA.test(String(a.before || '')) && !ZERO.test(a.before) && a.before !== res.cursor && !walkGap(ctx, m, res, res.cursor, a.before)) return res;
      if (judgeActivity(ctx, m, a, res) === 'defer') { res.why = 'GitHub has not yet linked the merge ' + short(a.after) + ' to its pull request'; return res; }
      if (!ZERO.test(a.after)) res.cursor = a.after;
      res.actAt = a.timestamp; res.actId = a.id;
    }
    if (res.cursor !== m.head) {
      if (acts && lagging(ctx, m)) { res.why = 'GitHub has not logged the newest change to ' + m.branch + ' yet'; return res; }
      if (!res.cursor) {
        res.flags.push(mk(ctx, { repo: m.full, branch: m.branch, kind: 'unchecked', sha: m.head, title: 'not fully checked', links: [commitLink(m.full, m.head)], detail: m.branch + ' is at ' + short(m.head) + ' with no earlier head to compare against (it was deleted, or GitHub logged no starting point): check it by hand' }));
        res.cursor = m.head; res.actAt = iso(ctx.now); res.actId = 0;
      } else if (!walkGap(ctx, m, res, res.cursor, m.head)) return res;
    }
    res.done = true; return res;
  } catch (e) { res.error = e; return res; }
}

/* ---------------- one repository ---------------- */
function checkRepo(ctx, st, w, acc) {
  const { key, r } = w, at = acc.at; let L = w.L;
  r.triedAt = at;
  if (!L) {   // no listing this tick (or not listed): ask about this repo itself
    try { L = api(ctx, 'repos/' + key, JQ.repo) || {}; delete r.goneMisses; }
    catch (e) {
      if (e.status !== 404 || !acc.listed) throw e;
      r.goneMisses = (r.goneMisses || 0) + 1;
      if (r.goneMisses < 3) throw new Error(e.message + ': not in this login\'s repository list either (' + r.goneMisses + ' of 3 before it is dropped)');
      r.skipped = 'gone: not on GitHub for this login (404 three times, not in its repository list)'; r.lastError = null; delete r.needSince; delete r.pending;
      acc.flags.push(mk(ctx, { repo: key, branch: r.branch || '—', kind: 'repo-gone', title: 'no longer on GitHub for this login', links: [{ t: 'repo', u: 'https://github.com/' + key }],
        detail: key + ' answers 404 and is not in the login\'s repository list (deleted, or access lost); it is no longer watched (last checked head ' + (short(r.sha) || 'none') + '). If it comes back, watching resumes from that head' }));
      acc.lines.push('  ' + key + ': gone, no longer watched'); return;
    }
    if (!watchable(ctx, L)) { r.skipped = skipWhy(L); r.lastError = null; delete r.needSince; acc.skipped++; acc.lines.push('  ' + key + ': skipped, ' + r.skipped); return; }
  }
  const branch = String(L.default_branch || '');
  if (!branch) throw new Error('GitHub did not say which branch is the default');
  let head;
  try { const b = api(ctx, 'repos/' + key + '/branches/' + enc(branch), JQ.branch) || {}; head = b.commit && b.commit.sha; }
  catch (e) { if (e.status === 404 && !L.pushed_at && !r.sha) { r.empty = true; finish(r, L, at); acc.lines.push('  ' + key + ': an empty repository, nothing on ' + branch + ' yet'); return; } throw e; }
  if (!SHA.test(String(head || ''))) throw new Error('GitHub gave no head commit for ' + branch);
  delete r.empty; acc.checked++;
  const changed = !!(r.sha && r.branch && r.branch !== branch);   // r.branchFrom: a branch change whose judging is not finished yet
  const m = { key, full: key, r, L, branch, head, oldBranch: changed ? r.branch : (r.sha && r.branchFrom) || null, first: !r.sha };
  if (m.first) {
    const cutoff = ms(r.actAt) || ms(st.since) || ctx.now;
    if (ms(L.created_at) > cutoff) {
      acc.flags.push(mk(ctx, { repo: key, branch, kind: 'new-repo', sha: head, t: ms(L.created_at), tNote: 'GitHub\'s time', title: 'a new repository', links: [{ t: 'repo', u: 'https://github.com/' + key }, commitLink(key, head)],
        detail: key + ' was created ' + one(L.created_at) + ', after the watch started; its default branch ' + branch + ' is at ' + short(head) + ' (the first commits of a new repository cannot come from a pull request). Watched from now' }));
      Object.assign(r, { branch, sha: head, actAt: iso(ctx.now), actId: 0 }); finish(r, L, at); acc.first++; acc.lines.push('  ' + key + ' ' + branch + ' @ ' + short(head) + ': new repository (created ' + one(L.created_at) + ')'); preview(ctx, m, acc); return;
    }
    if (!(ms(L.pushed_at) > cutoff)) { Object.assign(r, { branch, sha: head }); finish(r, L, at); acc.first++; acc.lines.push('  ' + key + ' ' + branch + ' @ ' + short(head) + ': first sight, nothing pushed since ' + stamp(cutoff) + ', taken as it is'); preview(ctx, m, acc); return; }
    acc.first++; acc.lines.push('  ' + key + ' ' + branch + ' @ ' + short(head) + ': first sight, pushed since ' + stamp(cutoff) + ': judging what GitHub logged on ' + branch + ' since then');
  }
  if (changed) acc.flags.push(mk(ctx, { repo: key, branch, kind: 'branch-changed', sha: head, t: ctx.now, tNote: 'when the watcher noticed', title: 'the default branch changed from ' + m.oldBranch + ' to ' + branch,
    links: [{ t: 'repo', u: 'https://github.com/' + key }, compareLink(key, r.sha, head)],
    detail: 'GitHub now says the default branch is ' + branch + ' (it was ' + m.oldBranch + ', last checked head there ' + short(r.sha) + '); making another branch the default puts its commits on the default branch without any pull request. What reached ' + branch + ' since that head is judged below' }));
  if (!m.first && !m.oldBranch && r.sha === head && L.pushed_at && r.pushedAt === L.pushed_at) { finish(r, L, at); acc.lines.push('  ' + key + ' ' + branch + ' @ ' + short(head) + ': unchanged'); return; }
  const res = judgeRange(ctx, m);
  acc.flags.push(...res.flags); acc.ok += res.ok;
  const was = r.sha;
  r.actAt = res.actAt; r.actId = res.actId; if (res.cursor) { r.sha = res.cursor; r.branch = branch; }
  if (m.oldBranch && !res.done) r.branchFrom = m.oldBranch; else delete r.branchFrom;
  acc.lines.push('  ' + key + ' ' + branch + ': ' + (was ? short(was) : 'start') + ' -> ' + short(r.sha) + (res.done ? '' : ' (head ' + short(head) + ' not reached yet)') + ', ' + res.ok + ' pull request(s) with a PASS, ' + res.flags.length + ' flagged');
  for (const v of res.verdicts) acc.lines.push('    ' + v);
  if (res.error) throw res.error;
  if (res.done) finish(r, L, at);
  else { r.pending = res.why; r.lastError = null; acc.deferred++; acc.lines.push('    waiting: ' + res.why); }
}
function finish(r, L, at) { r.pushedAt = (L && L.pushed_at) || null; r.checkedAt = at; r.lastError = null; delete r.lastErrorAt; delete r.errorSince; delete r.pending; delete r.needSince; }
// dry runs only (--preview N): the newest N logged changes of a repo seen for the first time, judged as if they were new
function preview(ctx, m, acc) {
  if (!ctx.preview || (acc.previewed = (acc.previewed || 0) + 1) > 6) return;
  const scratch = Object.assign({}, m.r, { prSeen: [] }), mm = Object.assign({}, m, { r: scratch }), res = { flags: [], verdicts: [], ok: 0, cursor: null, start: ctx.calls };
  try {
    const acts = activities(ctx, mm, m.branch, 0, 0).slice(-ctx.preview); res.cursor = acts.length ? acts[0].before : null; const saved = ctx.maxJudge; ctx.maxJudge = 1e9;
    try { for (const a of acts) { judgeActivity(ctx, mm, a, res); res.cursor = a.after; } } finally { ctx.maxJudge = saved; }
    acc.lines.push('  PREVIEW ' + m.full + ' ' + m.branch + ': the newest ' + acts.length + ' logged changes judged as if they were new (not flags: a real tick starts from ' + short(m.head) + ')');
    for (const v of res.verdicts) acc.lines.push('    ' + v);
  } catch (e) { acc.lines.push('  PREVIEW ' + m.full + ': could not read its log: ' + one(e.message).slice(0, 160)); }
}

/* ---------------- state ---------------- */
function readStateFile(f) {
  let bytes = null; try { bytes = fs.readFileSync(f); } catch (_) { return { exists: false }; }
  let s = null; try { s = JSON.parse(bytes.toString('utf8')); } catch (_) {}
  const ok = !!(s && typeof s === 'object' && s.repos && typeof s.repos === 'object' && !Array.isArray(s.repos));
  return { exists: true, ok, s: ok ? s : null, bytes };
}
function lastProvRow(ctx, rel) {
  let txt = '';
  try { const f = ctx.paths.prov, size = fs.statSync(f).size, want = Math.min(size, 4 << 20), buf = Buffer.alloc(want), fd = fs.openSync(f, 'r'); try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); } txt = buf.toString('utf8'); } catch (_) { return null; }
  let last = null;
  for (const l of txt.split('\n')) { if (!l.includes(rel)) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } if (r && r.file === rel && r.writer === TOOL && r.kind === 'write') last = r; }
  return last;
}
function provCheck(ctx, f, file) {   // { row, ok, why }: is this file what this tool last wrote?
  const row = lastProvRow(ctx, relTo(ctx, f));
  if (!row) return { row: null, ok: null };
  if (!file.exists) return { row, ok: false, why: 'it is gone, though this tool wrote it at ' + one(row.at).slice(0, 16) + 'Z' };
  if (sha256(file.bytes) !== row.sha256) return { row, ok: false, why: 'it is not what this tool last wrote (' + one(row.at).slice(0, 16) + 'Z), so something else changed it (or this tool was stopped mid-write)' };
  if (row.main !== MAIN || row.tainted) return { row, ok: false, why: 'its last write was recorded by ' + one(row.main || '?') + (row.tainted ? ' with a preload or eval flag' : '') + ', not by this tool run directly' };
  return { row, ok: true };
}
function migrate(s, start) {
  s.repos = s.repos || {}; s.others = s.others && typeof s.others === 'object' && !Array.isArray(s.others) ? s.others : {};
  if (!s.since) s.since = s.baselineAt || start;
  const v1 = s.v !== 2;
  for (const k of Object.keys(s.repos)) {
    const r = s.repos[k];
    if (!SLUG.test(k) || !r || typeof r !== 'object') { delete s.repos[k]; continue; }
    if (v1 && !r.sha) { s.others[k.toLowerCase()] = { repo: k, foundIn: r.foundIn || [], misses: 0, seenAt: r.checkedAt || s.since }; delete s.repos[k]; continue; }   // v1: a repo it never had a head for
    if (v1) { if (!r.actAt) r.actAt = r.checkedAt || s.since; delete r.fullName; delete r.skipped; }
    if (r.sha && !SHA.test(String(r.sha))) r.sha = null;
    if (!r.actAt) r.actAt = s.since;
  }
  s.v = 2; return s;
}
// { st, tamper }: the tool's own last write, else the backup if that still is, never silently today's heads
function loadState(ctx) {
  const cur = readStateFile(ctx.paths.state), bak = readStateFile(ctx.paths.backup), pc = provCheck(ctx, ctx.paths.state, cur), pb = provCheck(ctx, ctx.paths.backup, bak);
  const why = []; let st = null;
  if (cur.ok && pc.ok !== false) st = cur.s;
  else {
    if (cur.exists && !cur.ok) why.push('the state file cannot be read as this tool\'s state (corrupt or replaced)');
    else if (pc.ok === false) why.push('the state file: ' + pc.why);
    if (bak.ok && pb.ok === true) { st = bak.s; why.push('resumed from the backup copy, which still is this tool\'s last write'); }
    else if (cur.ok) { st = cur.s; why.push('there is no good backup, so the changed state is used as it is: the heads it holds may hide a push'); }
    else if (bak.ok) { st = bak.s; if (why.length) why.push('resumed from the backup copy (no record to check it against)'); }
    else {
      const lastGood = ms((pc.row || {}).at) || ms((pb.row || {}).at);
      st = { repos: {}, since: lastGood ? local(lastGood) : startOf(ctx) };
      if (why.length || pc.row) why.push('there is no good backup either, so every repository is judged again from ' + st.since.slice(0, 16).replace('T', ' ') + ' (' + (lastGood ? 'the last good write' : 'the watch start') + '), not taken as it is now');
    }
  }
  st = migrate(st, startOf(ctx));
  if (st.lastRun && st.lastRun > ctx.now + 5 * MIN) why.push('its last-check time is in the future (' + local(st.lastRun) + ')');
  return { st, tamper: why.length ? why.join('; ') : null };
}
function saveState(ctx, st) {
  const out = { _doc: 'Written by company/tools/default-branch-watch.js (do not edit: a change that is not this tool\'s own recorded write is flagged to security). repos: owner/name -> GitHub id, the default branch, its last judged head and activity, when, errors; others: repos from the watch list or local remotes not (yet) watched. Which repos to watch: ' + CONFIG_REL + '.',
    v: 2, lastRun: st.lastRun || null, lastRunAt: st.lastRun ? local(st.lastRun) : null, since: st.since, baselineAt: st.baselineAt || null, viewer: st.viewer || null, listOkAt: st.listOkAt || null,
    listError: st.listError || null, health: st.health || null, downNotified: st.downNotified || null, ticks: (st.ticks || []).slice(-48), repos: st.repos, others: st.others, recent: (st.recent || []).slice(-50) };
  const text = JSON.stringify(out, null, 1) + '\n';
  let err = null;
  try { writeAtomic(ctx.paths.state, text); prov(ctx, 'write', ctx.paths.state, text); } catch (e) { err = e; }
  try { writeAtomic(ctx.paths.backup, text); prov(ctx, 'write', ctx.paths.backup, text); } catch (_) {}
  if (err) throw err;
}

/* ---------------- lock ---------------- */
function alive(pid) {
  try { process.kill(pid, 0); } catch (_) { return false; }
  try { return /default-branch-watch\.js/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')); } catch (_) { return false; }
}
function lockInfo(ctx) {   // null = no lock; { held } = a live check; { stale } = to be removed
  const f = ctx.paths.lock; let s; try { s = fs.lstatSync(f); } catch (_) { return null; }
  if (!s.isFile()) return { stale: 'it is not a plain file' };
  const now = Date.now(), age = now - s.mtimeMs;
  if (age < -MIN) return { stale: 'it is dated in the future' };
  if (age > LOCK_MAX_MS) return { stale: 'it is older than ' + LOCK_MAX_MS / MIN + ' min (a check takes under 90 s)' };
  let d = null; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  if (!d || !Number.isInteger(d.pid) || !Number.isFinite(d.start)) return { stale: 'it was not written by this tool' };
  if (now - d.start > LOCK_MAX_MS || d.start > now + MIN) return { stale: 'its start time is out of range' };
  if (d.pid === process.pid || !alive(d.pid)) return { stale: 'its process ' + d.pid + ' is not a running check' };
  return { held: 'pid ' + d.pid + ' since ' + new Date(d.start).toISOString().slice(11, 19) + 'Z' };
}
function takeLock(ctx) {
  const f = ctx.paths.lock; try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch (_) {}
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, start: Date.now() }), { flag: 'wx' }); return { ok: true }; }
    catch (e) {
      if (e.code !== 'EEXIST') return { ok: true, note: 'no lock (' + e.code + ')' };   // cannot write one: check anyway rather than not at all
      const li = lockInfo(ctx); if (!li) continue;
      if (li.held) return { ok: false, held: li.held };
      try { fs.rmSync(f, { recursive: true, force: true }); } catch (_) {}
      ctx.lockNote = 'removed a stale lock (' + li.stale + ')';
    }
  }
  return { ok: false, held: 'a lock that could not be taken or cleared' };
}
function dropLock(ctx) { try { const d = JSON.parse(fs.readFileSync(ctx.paths.lock, 'utf8')); if (d && d.pid === process.pid) fs.unlinkSync(ctx.paths.lock); } catch (_) {} }
function lockSkipped(ctx, lk) {
  const s = readJson(ctx.paths.skips, null) || {};
  s.count = (Number(s.count) || 0) + 1; s.last = local(ctx.now); s.first = s.first || s.last; s.held = lk.held;
  if (s.count >= 2 && s.notified !== day(ctx.now)) {
    s.notified = day(ctx.now);
    watchDown(ctx, ['the check was skipped ' + s.count + ' times in a row since ' + s.first.slice(0, 16).replace('T', ' ') + ' because its lock (company/work/security/default-branch-watch.lock) is held by ' + lk.held +
      '; a real check takes under 90 s, so this is a hung run or something keeping the check from running (look at that process)']);
  }
  try { const text = JSON.stringify(s) + '\n'; writeAtomic(ctx.paths.skips, text); prov(ctx, 'write', ctx.paths.skips, text); } catch (_) {}
  const line = 'DEFAULT-BRANCH WATCH: skipped, another check is running (lock held by ' + lk.held + '; ' + s.count + ' time(s) in a row)';
  ctx.log(line); return { skipped: true, lock: true, line, flags: [], calls: 0 };
}

/* ---------------- reports ---------------- */
const row = (ctx, repo, branch, event, what, links) => '| ' + stamp(ctx.now) + ' | ' + cell(repo) + ' | ' + cell(branch || '—') + ' | ' + cell(event) + ' | ' + cell(what) + ' | ' +
  ((links || []).length ? links.map(l => '[' + cell(l.t) + '](' + l.u + ')').join(' ') : '—') + ' |\n';
function appendMd(ctx, chunk) {
  const f = ctx.paths.md; fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) { const text = mdHead(ctx) + chunk; fs.writeFileSync(f, text, { flag: 'wx' }); prov(ctx, 'write', f, text); }
  else { fs.appendFileSync(f, chunk); prov(ctx, 'append', f, chunk); }
}
function agentRuns(ctx) {   // finished agent runs (start, end) from the station's run log; only ids and times are read
  if (ctx.runsCache) return ctx.runsCache;
  const out = [];
  try {
    const f = ctx.paths.runs, size = fs.statSync(f).size, want = Math.min(size, 6 << 20), buf = Buffer.alloc(want), fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, want, size - want); } finally { fs.closeSync(fd); }
    for (const l of buf.toString('utf8').split('\n')) { if (!l.includes('"startedAt"')) continue; let r; try { r = JSON.parse(l); } catch (_) { continue; } if (r && r.agentId && Number.isFinite(r.startedAt)) out.push({ agentId: String(r.agentId), runId: String(r.runId || '').slice(0, 8), start: r.startedAt, end: Number.isFinite(r.endedAt) ? r.endedAt : r.startedAt }); }
  } catch (_) {}
  return (ctx.runsCache = out);
}
function runsText(ctx, f) {
  if (!Number.isFinite(f.t) || !f.t) return '';
  const name = id => one((ctx.agents[id] && ctx.agents[id].name) || id);
  const hit = agentRuns(ctx).filter(r => r.start - 2 * MIN <= f.t && f.t <= r.end + 2 * MIN).slice(-8);
  return 'At ' + stamp(f.t) + ' (' + zone(f.t) + ', ' + (f.tNote || 'GitHub\'s time') + ') agent runs going: ' + (hit.length ? hit.map(r => name(r.agentId) + ' (run ' + r.runId + ', ' + stamp(r.start).slice(11) + '-' + stamp(r.end).slice(11) + ')').join(', ') : 'none recorded (a run still going at the check is not listed yet)') + '.';
}
function itemsText(ctx, list, withRuns) {
  const items = list.map((f, i) => one((i + 1) + ') ' + f.repo + ' `' + f.branch + '`: ' + f.title + ' — ' + f.detail + '. ' + (withRuns ? runsText(ctx, f) + ' ' : '') + f.links.map(l => l.t + ' ' + l.u).join(' ')));
  let out = '', n = 0;
  for (const it of items) { if (n && out.length + it.length > 3500) break; out += (n ? ' ' : '') + it.slice(0, 3500); n++; }
  return out + (n < items.length ? ' … and ' + (items.length - n) + ' more: see `company/work/security/default-branch-watch.md`.' : '');
}
const HEADING = (ctx, what) => '\n## ' + stamp(ctx.now) + ' from ' + TOOL_NAME + ' (company/tools/default-branch-watch.js) — ' + what + '\n';
function handoffBlock(ctx, list, how) {
  const repos = one([...new Set(list.map(f => f.repo))].join(', ')).slice(0, 160), n = list.length;
  const head = HEADING(ctx, n + ' change' + (n > 1 ? 's' : '') + (how === 'fyi' ? ' to note' : ' on a default branch outside a pull request with a pre-merge PASS') + ': ' + repos);
  const why = '**Why:** the owner\'s one rule for GitHub: nothing lands on a default branch except a pull request merged after a pre-merge PASS. GitHub branch protection may not be available on these repos, and the client-side gate (merge-gate.js, the gh and git wrappers) cannot stop absolute-path git, curl with the token or the web UI; this check of GitHub itself is the tripwire.\n';
  const ev = '**Evidence:** ' + itemsText(ctx, list, how === 'open') + ' Owner: if you did this yourself, nothing to do. Log: `company/work/security/default-branch-watch.md`.\n';
  if (how === 'open') return head +
    '**Need:** find out who made each change below and write down what you found: an agent (then follow it up with that agent; a fix or a revert goes through a pull request too, never straight onto the branch) or the owner (then nothing to do). ' +
    'The names on a commit and the GitHub account are not evidence: the owner and the agents may share one GitHub login, and agents may commit under the owner\'s own name (the git user.name on this machine). Go by the time: each item gives the time and the agent runs going then (.starnet-data/workspaces/runs.jsonl); read those runs\' transcripts, and look at company/work/dispatch-log.md RUN lines and REFUSED lines in company/work/merge-gate.log around then. If no agent run matches, ask the owner. Then set Status to DONE with one line on what you found.\n' +
    why + '**Deadline:** ' + stamp(ctx.now + DAY) + '\n**Status:** OPEN\n' + ev;
  if (how === 'ceo') return head + '**Need:** nothing unless ' + roleName(ctx, 'risk') + ' (the risk owner) asks for help: ' + roleName(ctx, 'risk') + ' has the same report as an OPEN handoff and follows it up. You get this because something reached a default branch outside a pull request, or its history was rewritten, which the owner ruled out for agents. If the owner did it themselves, nothing to do.\n' +
    why + '**Deadline:** none\n**Status:** DONE — FYI\n' + ev;
  return head + '**Need:** nothing unless it was not meant: these are notes, not breaches.\n' + why + '**Deadline:** none\n**Status:** DONE — FYI\n' + ev;
}
/* ---------------- the owner's change, or possibly an agent's ----------------
 * The owner and the agents may share one GitHub account, and the owner pushes to their own repositories too, so GitHub
 * cannot say whose a change is, and reporting every one would wake the risk owner (and spend model budget) for the owner's
 * own work. Every agent tool call is in the station's transcripts, so a flag stays loud (handoffs as
 * above) only when an agent could have made it:
 *   - a company repository (a clone under company/ or scratch/, or in company/projects.json): an agent tool call within 3 h
 *     before to 5 min after the change (7 days to now when only a commit time is known) that names the repository or one of its
 *     clone folders AND could write to GitHub (push, merge, git/refs, contents, graphql, repo sync, send-pack, api.github.com,
 *     /usr/bin/git or gh by absolute path). Notes on company repos (new repo, default branch changed, unchecked) stay loud.
 *   - any other repository: any agent tool call in the last 30 days that names it (owner/name). Never named = the owner's own.
 * Otherwise the flag is recorded in the report file as "owner, probably" and nobody is told. Unreadable transcripts = nothing is
 * quietened. Limit: an agent that keeps the repository's name out of its own commands (a script written more than 3 h earlier,
 * a remote added under another name) is quietened too; its transcript still holds the trail. */
const PUSHY = /\bpush\b|\bmerge\b|git\/refs|\/contents\/|graphql|repo\s+sync|send-pack|api\.github\.com|\/usr\/bin\/(?:git|gh)\b/i;
const BREACH = new Set(['no-pr', 'no-pass', 'pushed', 'pushed-over', 'rewritten']);
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const agentName = (ctx, id) => (ctx.agents[id] && ctx.agents[id].name) || String(id);
/* ATTRIBUTION WINDOW. A run listed against a push must be a run that could have made it, and the distance between the two
 * must be printed. A repository that has no company clone is searched over 30 days, which decides whether the row is loud
 * at all (an agent that named the repository at any point in 30 days is why the row is not quietened); narrowing that
 * would make the tripwire quieter. But only the calls inside the window (default 3 h before to 5 min after the change,
 * config attribution.nearBeforeMinutes / nearAfterMinutes) are NAMED. A loud row whose runs do not overlap keeps its place
 * and says WHO PUSHED IS UNKNOWN, with the nearest run's distance, instead of accusing a run that was nowhere near it. */
const fmtDist = ms => {
  const a = Math.abs(ms), m = Math.round(a / MIN);
  const s = a < HOUR ? m + 'm' : (a < DAY ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm' : Math.floor(a / DAY) + 'd' + Math.floor((a % DAY) / HOUR) + 'h');
  return ms < 0 ? s + ' before' : s + ' after';
};
const fmtSpan = ms => (ms % HOUR === 0 ? ms / HOUR + 'h' : Math.round(ms / MIN) + 'm');
function segmentsBetween(ctx, fromMs, toMs) {   // null when the transcripts cannot be listed
  const dir = ctx.paths.transcripts; let files; try { files = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort(); } catch (_) { return null; }
  const man = readJson(path.join(dir, 'manifest.json'), {}) || {}, range = new Map((man.segments || []).map(s => [s.file, s]));
  return files.filter(f => { const s = range.get(f); if (!s) return true; const lo = Number(s.minTs), hi = Number(s.maxTs); return !(Number.isFinite(hi) && hi < fromMs) && !(Number.isFinite(lo) && lo > toMs); }).map(f => path.join(dir, f));
}
// agent tool calls in [fromMs, toMs] whose arguments match nameRe (and mustRe, if given); null when a transcript cannot be read.
// Only the agent, run and time leave this function, never the arguments.
function agentCalls(ctx, fromMs, toMs, nameRe, mustRe) {
  const files = segmentsBetween(ctx, fromMs, toMs); if (files === null) return null;
  const hits = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
    for (const l of txt.split('\n')) {
      if (!l || !l.includes('toolCalls') || !nameRe.test(l) || (mustRe && !mustRe.test(l))) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      const ts = Number(r && r.ts); if (!r || !r.agentId || !r.toolCalls || !(ts >= fromMs && ts <= toMs)) continue;
      const args = typeof r.toolCalls === 'string' ? r.toolCalls : JSON.stringify(r.toolCalls);
      if (!nameRe.test(args) || (mustRe && !mustRe.test(args))) continue;
      hits.push({ name: agentName(ctx, r.agentId), run: String(r.sourceRunId || '').slice(0, 8), ts });
    }
  }
  return hits;
}
function whose(ctx, st, flags) {
  const lower = new Map(Object.entries(st.repos || {}).map(([k, r]) => [k.toLowerCase(), r])), cache = new Map();
  for (const f of flags) {
    if (!f.repo || String(f.repo).startsWith('(')) continue;
    const r = lower.get(String(f.repo).toLowerCase());
    const folders = ((r && r.foundIn) || []).filter(p => !/\.(json|log)$/.test(p));
    const company = !!(r && (r.foundIn || []).length);
    if (company && !BREACH.has(f.kind)) continue;
    let hits;
    if (company) {
      const t = Number(f.t) || ctx.now, gh = /GitHub/.test(f.tNote || '');
      const names = [reEsc(f.repo) + '(?![A-Za-z0-9_.-])'].concat(folders.map(p => '(?:^|[^A-Za-z0-9_.-])' + reEsc(p.split('/').pop()) + '(?![A-Za-z0-9_.-])'));
      hits = agentCalls(ctx, gh ? t - ctx.cfg.near.before : Math.min(t, ctx.now - 7 * DAY), gh ? t + ctx.cfg.near.after : ctx.now, new RegExp(names.join('|'), 'i'), PUSHY);
    } else {
      const k = String(f.repo).toLowerCase();
      if (!cache.has(k)) cache.set(k, agentCalls(ctx, ctx.now - 30 * DAY, ctx.now, new RegExp(reEsc(f.repo) + '(?![A-Za-z0-9_.-])', 'i')));
      hits = cache.get(k);
    }
    if (hits === null) continue;   // transcripts unreadable: report as before
    if (hits.length) {
      const t = Number(f.t) || ctx.now, N = ctx.cfg.near, near = hits.filter(h => h.ts >= t - N.before && h.ts <= t + N.after);
      if (company || near.length) {
        f.detail += '. Agent tool calls that ' + (company ? 'could have made it then' : 'name this repository near that time (' + fmtSpan(N.before) + ' before to ' + fmtSpan(N.after) + ' after)')
          + ': ' + [...new Set(near.map(h => h.name + ' (run ' + h.run + ', ' + fmtDist(h.ts - t) + ')'))].slice(-6).join(', ');
      } else {
        // No run is inside the window. The row stays (it is not quietened: an agent did name this repository inside 30
        // days) and the attribution is UNKNOWN with the nearest distance: a row that disappears is a worse failure than a
        // row that is imprecise.
        const nearest = hits.slice().sort((a, b) => Math.abs(a.ts - t) - Math.abs(b.ts - t))[0];
        f.detail += '. No agent tool call named this repository within ' + fmtSpan(N.before) + ' before to ' + fmtSpan(N.after) + ' after the change, so WHO PUSHED IS UNKNOWN — it was named once, by ' + nearest.name + ' (run ' + nearest.run + ', ' + stamp(nearest.ts) + '), ' + fmtDist(nearest.ts - t) + '. Not the owner\'s by default and not an agent\'s: unproven';
      }
      continue;
    }
    f.quiet = true;
    f.detail += '. ' + (company ? 'No agent ran a command that could do this near that time' : 'No agent tool call has named this repository in 30 days (no company clone either)') + ', so it is most likely the owner\'s own work: recorded here only, nobody was told';
  }
}
// Guardrail defaultBranch OFF (the owner's switch, company/tools/guardrails.js): agents may push and merge freely, so a
// breach-kind flag is recorded in the report file (still logged) but nobody is handed it. Notes about the watcher itself
// (state changed, not checking, report failed) and new or dropped repositories stay as they are.
function unguard(ctx, flags) {
  if (ctx.guardOn) return;
  for (const f of flags) if (BREACH.has(f.kind)) { f.quiet = true; f.unguarded = true; f.detail += '. The defaultBranch guardrail is OFF (the owner\'s switch): allowed, recorded here only, nobody was told'; }
}
// the inboxes a tick's flags go to: { inbox: { name, list, how } } (at most one block per person per tick); quiet flags go nowhere
function targets(ctx, flags) {
  flags = flags.filter(f => !f.quiet);
  const out = new Map(), put = (role, list, how) => { const r = ctx.roles[role]; if (list.length && r && /^[A-Za-z0-9_.-]+\.md$/.test(String(r.inbox || '')) && !out.has(r.inbox)) out.set(r.inbox, { name: r.name, list, how }); };
  put('risk', flags, flags.some(f => !NOTE_ONLY.has(f.kind)) ? 'open' : 'fyi'); put('ceo', flags.filter(f => TO_CEO.has(f.kind)), 'ceo');
  return out;
}
// recorded (lib/tool-blocks.js): a block this tool wrote is known as a tool's by provenance, never held as a member's message
function appendHandoff(ctx, inbox, text) { fs.mkdirSync(ctx.paths.handoffs, { recursive: true }); require('./lib/tool-blocks').append(path.join(ctx.paths.handoffs, inbox), text); }
// the report file first (its failure is itself flagged), then the handoffs, which never depend on it
function report(ctx, flags, rows) {
  const md = flags.map(f => row(ctx, f.repo, f.branch, f.label + (f.unguarded ? ' (guardrail off)' : f.quiet ? ' (owner, probably)' : ''), f.title + ' — ' + f.detail, f.links)).join('') + rows.join('');
  if (md) { try { appendMd(ctx, md); } catch (e) { flags.push(mk(ctx, { repo: '(this watcher)', branch: '—', kind: 'report-failed', title: 'its report file could not be written', detail: 'company/work/security/default-branch-watch.md: ' + one(e.code || e.message).slice(0, 80) + '; the rows for this tick are only in this handoff. ' + roleName(ctx, 'tools') + ' (tools owner): make it a plain writable file again' })); } }
  const sent = [];
  for (const [inbox, t] of targets(ctx, flags)) { try { appendHandoff(ctx, inbox, handoffBlock(ctx, t.list, t.how)); sent.push(t.name + ' (' + t.list.length + (t.how === 'open' ? ', OPEN' : '') + ')'); } catch (_) {} }
  return sent;
}
// the watcher cannot do its job: the tools owner fixes it (OPEN), security hears of it (FYI)
function watchDown(ctx, problems) {
  const ev = '**Evidence:** ' + one(problems.join('; ')).slice(0, 2500) + '. `node company/tools/default-branch-watch.js status` shows the details.\n';
  const why = '**Why:** this watcher is the only check on GitHub itself that nothing lands on a default branch outside a pull request with a pre-merge PASS; while it cannot check, a push there goes unnoticed.\n';
  const head = HEADING(ctx, 'the default-branch watch is not checking everything');
  const sent = [], put = (role, text) => { const r = ctx.roles[role]; if (r && /^[A-Za-z0-9_.-]+\.md$/.test(String(r.inbox || ''))) { try { appendHandoff(ctx, r.inbox, text); sent.push(r.name); } catch (_) {} } };
  put('tools', head + '**Need:** get it checking again: run `node company/tools/default-branch-watch.js status` and fix the cause; a gh login problem (an expired or revoked token) needs the owner, so tell them. Then set Status to DONE.\n' + why + '**Deadline:** ' + stamp(ctx.now + DAY) + '\n**Status:** OPEN\n' + ev);
  put('risk', head + '**Need:** nothing unless it lasts: the tools owner has it as an OPEN handoff. Until it is fixed, a push to a default branch would not be reported.\n' + why + '**Deadline:** none\n**Status:** DONE — FYI\n' + ev);
  return sent;
}
function health(ctx, st, extra) {
  const P = extra.slice();
  if (st.listError && ctx.now - (ms(st.listOkAt) || ms(st.since)) > STALE_MS) P.push('the list of repositories this login can push to has not been read since ' + (st.listOkAt || 'the watch started').slice(0, 16).replace('T', ' ') + ': ' + st.listError);
  for (const [k, r] of Object.entries(st.repos)) if (!r.skipped && r.needSince && ctx.now - ms(r.needSince) > STALE_MS)
    P.push(k + ' has needed a check since ' + r.needSince.slice(0, 16).replace('T', ' ') + ' (' + (r.lastError || r.pending || 'not reached within the time budget') + ')');
  return P;
}

/* ---------------- tick ---------------- */
function tick(ctx) {
  if (!ctx.dry && ctx.underStation) { const line = 'DEFAULT-BRANCH WATCH: refused: a real check may not run from an agent\'s run (it moves the watch forward); use --dry-run or status'; ctx.log(line); return { refused: true, line, flags: [], calls: 0 }; }
  if (!ctx.dry) { const lk = takeLock(ctx); if (!lk.ok) return lockSkipped(ctx, lk); if (fs.existsSync(ctx.paths.skips)) { try { fs.unlinkSync(ctx.paths.skips); } catch (_) {} } }
  try {
    const { st, tamper } = loadState(ctx);   // inside the lock: never a state another check is about to replace
    if (!ctx.dry && !tamper && st.lastRun && ctx.now >= st.lastRun && ctx.now - st.lastRun < EVERY) {
      const line = 'DEFAULT-BRANCH WATCH: skipped, the last full check was ' + Math.round((ctx.now - st.lastRun) / 60000) + ' min ago (at most one every ' + EVERY / MIN + ' min)'; ctx.log(line); return { skipped: true, line, flags: [], calls: 0 };
    }
    return run(ctx, st, tamper);
  } finally { if (!ctx.dry) dropLock(ctx); }
}
function run(ctx, st, tamper) {
  const t0 = Date.now(), at = local(ctx.now), rows = [], acc = { at, flags: [], lines: [], checked: 0, first: 0, skipped: 0, errors: 0, deferred: 0, ok: 0 }, extra = [];
  if (tamper) acc.flags.push(mk(ctx, { repo: '(this watcher)', branch: '—', kind: 'state-changed', title: 'its state was changed outside the tool', t: ctx.now, tNote: 'when the watcher noticed',
    detail: tamper + '. The heads it compares against may have been changed to hide a push: look at each default branch\'s history since the last good check by hand, or the owner runs `node company/tools/default-branch-watch.js baseline` once the branches are known to be clean' }));
  if (ctx.lockNote) acc.lines.push('  ' + ctx.lockNote);
  if (st.lastRun && ctx.now - st.lastRun > STALE_MS) extra.push('no full check ran between ' + stamp(st.lastRun) + ' and ' + stamp(ctx.now) + ' (' + zone(ctx.now) + '): the dispatcher did not start this tool, or every start failed (see DEFAULT-BRANCH WATCH lines in company/work/dispatch-log.md)');
  const fail = (key, r, e) => {
    acc.errors++; const msg = one(e && e.message).slice(0, 200) || 'unknown error';
    if (r.lastError !== msg) rows.push(row(ctx, key, r.branch, 'error', 'could not check: ' + msg + ' (checked again next tick)', []));
    r.lastError = msg; r.lastErrorAt = at; r.errorSince = r.errorSince || at; r.needSince = r.needSince || at; acc.lines.push('  ' + key + ': ERROR ' + msg);
  };
  let listed = null, outOfTime = false;
  try {
    ctx.viewer = viewer(ctx, st);
    try { listed = listRepos(ctx); st.listOkAt = at; st.listError = null; }
    catch (e) { if (e.deadline) throw e; st.listError = one(e.message).slice(0, 200); acc.lines.push('  could not list the repositories: ' + st.listError + ' (repos with a known head are polled one by one)'); }
    listed = scopeListing(ctx, listed);
    if (listed) syncWatched(ctx, st, listed, at, rows);
    applyScope(ctx, st, acc.flags);
    acc.listed = !!listed;
    syncOthers(ctx, st, discover(ctx), at);
    // the work, most important first: known heads that moved or have unfinished work, then first sights, then re-checks
    const work = [];
    for (const [key, r] of Object.entries(st.repos)) {
      if (r.skipped) continue;
      const L = listed ? listed.get(key.toLowerCase()) || null : null;
      let pri;
      if (r.sha && (r.pending || r.lastError || r.needSince)) pri = 0;
      else if (L && r.sha && (L.pushed_at !== r.pushedAt || L.default_branch !== r.branch)) pri = 0;
      else if (!r.sha && (!r.empty || (L && L.pushed_at !== r.pushedAt)) && (L || !listed)) pri = 1;
      else if (!listed && r.sha) pri = 2;
      else if (listed && !L) pri = 2;   // watched but not listed: asked about one by one (at most 20 such a tick)
      else if (L && ctx.now - (ms(r.checkedAt) || 0) > RECHECK_MS) pri = 3;
      else continue;
      if (pri < 2 && !r.needSince) r.needSince = at;
      work.push({ key, r, L, pri, age: ms(r.checkedAt) });
    }
    work.sort((a, b) => a.pri - b.pri || a.age - b.age || (a.key < b.key ? -1 : 1));
    let re = 0, polls = 0;
    for (const w of work) {
      if (w.pri === 3 && ++re > RECHECK_PER_TICK) continue;
      if (w.pri === 2 && ++polls > 20) continue;
      if (Date.now() > ctx.deadline) { outOfTime = true; break; }
      try { checkRepo(ctx, st, w, acc); } catch (e) { if (e.deadline) { outOfTime = true; acc.lines.push('  ' + w.key + ': out of time, checked first next tick'); if (!w.r.needSince) w.r.needSince = at; break; } fail(w.key, w.r, e); }
    }
    // remotes found locally that are not watched: a few a tick, each at most once a day (weekly once parked)
    if (listed && !outOfTime) {
      const due = Object.entries(st.others).filter(([, o]) => ctx.now - ms(o.triedAt) > ((o.misses || 0) >= 3 || o.sameAs ? 7 * DAY : DAY))
        .sort((a, b) => ms(a[1].triedAt) - ms(b[1].triedAt) || (a[0] < b[0] ? -1 : 1)).slice(0, OTHERS_PER_TICK);
      for (const [k, o] of due) {
        try {
          const L = api(ctx, 'repos/' + o.repo, JQ.repo) || {}, full = SLUG.test(String(L.full_name || '')) ? L.full_name : o.repo;
          o.triedAt = at; o.misses = 0;
          if (listed.has(full.toLowerCase())) { o.sameAs = full; o.status = 'the same repository as ' + full; continue; }
          if (watchable(ctx, L)) { st.repos[full] = Object.assign(newEntry(st, at, L), { foundIn: o.foundIn || [], unlisted: 'pushable, but missing from the login\'s repository list' }); delete st.others[k]; acc.lines.push('  ' + full + ': found locally, pushable but not listed: watched from now'); continue; }
          o.status = skipWhy(L);
        } catch (e) {
          if (e.deadline) { outOfTime = true; break; }
          o.triedAt = at; if (e.status === 404) { o.misses = (o.misses || 0) + 1; o.status = 'GitHub does not know it (404)' + (o.misses >= 3 ? '; parked, asked again weekly' : ''); } else o.status = 'could not ask GitHub: ' + one(e.message).slice(0, 120);
        }
      }
    }
  } catch (e) { if (!e.deadline) throw e; outOfTime = true; acc.lines.push('  out of time before the repositories were listed'); }
  const secs = Math.round((Date.now() - t0) / 100) / 10, watched = Object.values(st.repos).filter(r => !r.skipped).length;
  const problems = health(ctx, st, extra);
  try { whose(ctx, st, acc.flags); } catch (_) { for (const f of acc.flags) delete f.quiet; }   // on any error every flag stays loud
  unguard(ctx, acc.flags);
  let sent = [], down = [];
  if (!ctx.dry) {
    if (problems.length) {
      st.health = Object.assign(st.health || { since: at }, { problems: problems.slice(0, 20) });
      if (st.downNotified !== day(ctx.now)) { st.downNotified = day(ctx.now); down = watchDown(ctx, problems); rows.push(row(ctx, '(this watcher)', '—', 'watch not checking', problems.join('; ').slice(0, 600), [])); }
    } else if (st.health) { rows.push(row(ctx, '(this watcher)', '—', 'watch working again', 'every repository that needed a check was checked (problems since ' + String(st.health.since).slice(0, 16).replace('T', ' ') + ')', [])); st.health = null; }
    st.lastRun = ctx.now;
    sent = report(ctx, acc.flags, rows);   // report before the state write: a crash in between repeats a report, never loses one
    st.ticks = (st.ticks || []).concat([{ at, repos: watched, checked: acc.checked, first: acc.first, errors: acc.errors, deferred: acc.deferred, apiCalls: ctx.calls, flags: acc.flags.length, seconds: secs, outOfTime: outOfTime || undefined }]).slice(-48);
    st.recent = (st.recent || []).concat(acc.flags.map(f => ({ at: f.at, repo: f.repo, branch: f.branch, kind: f.kind, title: f.title, sha: f.sha || null, pr: f.pr || null }))).slice(-50);
    saveState(ctx, st);
  } else for (const [inbox, t] of targets(ctx, acc.flags)) sent.push('would tell ' + t.name + ' (' + inbox + ', ' + t.list.length + (t.how === 'open' ? ', OPEN' : '') + ')');
  for (const f of acc.flags) acc.lines.push('  ' + (f.unguarded ? 'NOTED (guardrail off) ' : f.quiet ? 'NOTED (owner, probably) ' : 'FLAG ') + f.repo + ' ' + f.branch + ': ' + f.title + ' — ' + f.detail);
  for (const p of problems) acc.lines.push('  NOT CHECKING: ' + p);
  const line = 'DEFAULT-BRANCH WATCH' + (ctx.dry ? ' (dry run)' : '') + ': ' + watched + ' repos (' + acc.checked + ' checked' + (acc.first ? ', ' + acc.first + ' first seen' : '') + (acc.deferred ? ', ' + acc.deferred + ' to finish next tick' : '') +
    (acc.errors ? ', ' + acc.errors + ' with API ERRORS' : '') + (outOfTime ? ', OUT OF TIME' : '') + (listed ? '' : ', LISTING FAILED') + '), ' + ctx.calls + ' API calls, ' +
    (acc.flags.some(f => f.quiet) ? acc.flags.filter(f => f.quiet).length + ' noted as the owner\'s, probably; ' : '') +
    (acc.flags.some(f => !f.quiet) ? acc.flags.filter(f => !f.quiet).length + ' FLAGGED (' + acc.flags.filter(f => !f.quiet).map(f => f.repo.split('/').pop() + ': ' + f.label).join('; ').slice(0, 200) + ')' + (sent.length ? ' -> ' + sent.join(', ') : '') : 'nothing flagged') +
    (problems.length ? ', NOT CHECKING EVERYTHING' + (down.length ? ' -> ' + down.join(', ') : '') : '') + ', ' + secs + ' s';
  for (const l of acc.lines) ctx.log(l);
  ctx.log(line);
  return { line, flags: acc.flags, calls: ctx.calls, checked: acc.checked, errors: acc.errors, ok: acc.ok, firstSeen: acc.first, deferred: acc.deferred, sent, problems, outOfTime };
}

/* ---------------- baseline, status ---------------- */
/* watch add|remove: the watch list's one writer besides the owner's editor. Recorded with provenance, so locked-watch
 * accepts the bytes; the decision goes to decisions.md through decision.js. */
function watchCmd(ctx, verb, repo, o) {
  repo = String(repo || '').trim();
  if (!['add', 'remove'].includes(verb)) throw new Error('watch add|remove <owner/name> --by <Name> --why "..."');
  if (!SLUG.test(repo)) throw new Error('give the repository as owner/name ("' + one(repo).slice(0, 60) + '" is not one)');
  const why = String((o && o.why) || '').trim(); if (why.length < 12) throw new Error('--why must say why this repository is (no longer) watched (12+ characters)');
  const by = String((o && o.by) || '').trim(); const risk = ctx.roles.risk;
  const owner = by.toLowerCase() === 'owner' && ctx.ownerShell && !ctx.underStation;
  const isRisk = !!risk && by.toLowerCase() === String(risk.name || '').toLowerCase();
  if (verb === 'remove' && !owner) throw new Error('removing a watched repository loosens the rule: only the owner, from the owner\'s own shell (--by owner)');
  if (!owner && !isRisk) throw new Error('--by must be the risk seat (' + roleName(ctx, 'risk') + ') or the owner from the owner\'s own shell');
  if (isRisk && ctx.live) { try { const c = require('./provenance.js').callerConflict(ctx.root, [TOOL, 'watch', repo, by], risk.id); if (c) throw new Error('this command claims --by ' + by + ' but ran in another seat\'s run (' + c.runId + ')'); } catch (e) { if (/claims --by/.test(e.message)) throw e; } }
  const f = path.join(ctx.root, CONFIG_REL);
  const cur = readJson(f, null) || readJson(path.join(ctx.root, CONFIG_DEFAULT_REL), null) || { repos: [], discover: false, watchStart: '' };
  const list = (Array.isArray(cur.repos) ? cur.repos : []).map(x => String(typeof x === 'string' ? x : (x && x.repo) || ''));
  const has = list.some(x => x.toLowerCase() === repo.toLowerCase());
  if (verb === 'add' && has) return { ok: true, unchanged: true, repo, repos: list };
  if (verb === 'remove' && !has) return { ok: true, unchanged: true, repo, repos: list };
  cur.repos = verb === 'add' ? list.concat([repo]) : list.filter(x => x.toLowerCase() !== repo.toLowerCase());
  const text = JSON.stringify(cur, null, 2) + '\n';
  if (!ctx.dry) { writeAtomic(f, text); prov(ctx, 'write', f, text); }
  if (ctx.live && !ctx.dry) { try { require('./decision.js').add({ by: owner ? 'owner' : risk.name, text: (verb === 'add' ? 'watching ' : 'no longer watching ') + repo + ' for direct pushes to its default branch (default-branch-watch.js watch ' + verb + ')', why }); } catch (_) {} }
  return { ok: true, repo, verb, by: owner ? 'owner' : risk.name, repos: cur.repos, note: 'a repository the company cannot push to is listed but not watched; watch the company\'s own repos' };
}
function baseline(ctx) {
  if (!ctx.ownerShell || !ctx.tty || ctx.underStation) throw new Error('baseline is for the owner\'s own terminal only (an interactive shell): it takes the current heads as known-good without checking how they got there. A normal tick checks every change; nothing else needs a baseline.');
  const lk = takeLock(ctx); if (!lk.ok) throw new Error('a check is running now (' + lk.held + '); try again in a minute');
  try {
    const { st } = loadState(ctx), rows = [], moved = [], at = local(ctx.now); let errors = 0;
    ctx.viewer = viewer(ctx, st);
    const listed = scopeListing(ctx, listRepos(ctx));   // no baseline without the full list
    syncWatched(ctx, st, listed, at, rows); applyScope(ctx, st, null);
    for (const [key, r] of Object.entries(st.repos)) {
      const L = listed.get(key.toLowerCase()); if (!L || r.skipped) continue;
      try {
        const branch = String(L.default_branch || ''); if (!branch) throw new Error('GitHub did not say which branch is the default');
        let head = null; try { const b = api(ctx, 'repos/' + key + '/branches/' + enc(branch), JQ.branch) || {}; head = b.commit && b.commit.sha; } catch (e) { if (!(e.status === 404 && !L.pushed_at)) throw e; }
        if (head && !SHA.test(head)) throw new Error('GitHub gave no head commit for ' + branch);
        if (!head) { r.empty = true; finish(r, L, at); continue; }
        if ((r.sha && (r.sha !== head || r.branch !== branch)) || r.pending || r.needSince) {
          const what = 'the owner took ' + branch + ' @ ' + short(head) + ' as known-good; ' + (r.sha ? 'the change from ' + (r.branch || '?') + ' @ ' + short(r.sha) : 'what landed since ' + one(r.actAt).slice(0, 16)) + ' was not checked';
          rows.push(row(ctx, key, branch, 'rebaselined', what, r.sha && r.branch === branch ? [compareLink(key, r.sha, head)] : [commitLink(key, head)])); moved.push(key + ': ' + what);
        }
        Object.assign(r, { branch, sha: head, actAt: iso(ctx.now), actId: 0 }); finish(r, L, at); delete r.compareMiss;
        ctx.log('  ' + key + ' ' + branch + ' @ ' + (short(head) || 'empty'));
      } catch (e) { errors++; r.lastError = one(e.message).slice(0, 200); r.lastErrorAt = at; ctx.log('  ' + key + ': ERROR ' + r.lastError); }
    }
    st.since = at; st.lastRun = ctx.now; st.baselineAt = at; st.listOkAt = at; st.listError = null;
    st.ticks = (st.ticks || []).concat([{ at, kind: 'baseline', repos: Object.keys(st.repos).length, errors, apiCalls: ctx.calls, moved: moved.length }]).slice(-48);
    if (rows.length) { try { appendMd(ctx, rows.join('')); } catch (_) {} }
    if (moved.length) for (const role of ['risk', 'ceo']) {
      const r = ctx.roles[role]; if (!r || !/^[A-Za-z0-9_.-]+\.md$/.test(String(r.inbox || ''))) continue;
      try { appendHandoff(ctx, r.inbox, HEADING(ctx, 'the owner took ' + moved.length + ' default branch head(s) as known-good without a check') + '**Need:** nothing if the owner did this: `baseline` runs only from their own terminal. If they did not, tell them at once: someone reset the watch, which can hide a push.\n**Why:** a baseline skips judging how the heads got there.\n**Deadline:** none\n**Status:** DONE — FYI\n**Evidence:** ' + one(moved.join('; ')).slice(0, 2500) + '. Log: `company/work/security/default-branch-watch.md`.\n'); } catch (_) {}
    }
    saveState(ctx, st);
    const line = 'DEFAULT-BRANCH WATCH baseline: ' + Object.keys(st.repos).length + ' repos, ' + ctx.calls + ' API calls' + (errors ? ', ' + errors + ' errors' : '') + (moved.length ? ', ' + moved.length + ' head(s) taken without a check (logged; the risk owner and the CEO told)' : '');
    ctx.log(line); return { line, errors, rebaselined: moved.length };
  } finally { dropLock(ctx); }
}
function status(ctx) {
  const { st, tamper } = loadState(ctx), L = [], ticks = st.ticks || [], last = ticks.slice(-1)[0];
  L.push(TOOL_NAME + ' (company/tools/default-branch-watch.js): the GitHub-side check that nothing lands on a default branch without a PR that passed.');
  L.push(!st.lastRun ? 'No check yet: the first tick lists the repositories and judges what landed since ' + String(st.since).slice(0, 16).replace('T', ' ') + '.'
    : (last && last.kind === 'baseline' ? 'Baseline taken by the owner ' + stamp(st.lastRun) + ' (' + zone(st.lastRun) + '), no check since' : 'Last full check ' + stamp(st.lastRun) + ' (' + zone(st.lastRun) + ')' + (last ? ': ' + last.checked + ' checked, ' + last.apiCalls + ' API calls, ' + last.flags + ' flagged, ' + last.errors + ' errors' + (last.outOfTime ? ', out of time' : '') : '')) +
      '. Next full check after ' + stamp(st.lastRun + EVERY) + '. Judging changes since ' + String(st.since).slice(0, 16).replace('T', ' ') + '.');
  if (st.lastRun && ctx.now - st.lastRun > STALE_MS) L.push('WARNING: no full check for ' + Math.round((ctx.now - st.lastRun) / HOUR) + ' h: the dispatcher starts this tool every 10 min (see DEFAULT-BRANCH WATCH lines in company/work/dispatch-log.md).');
  if (tamper) L.push('WARNING: ' + tamper + '. The next tick flags it to security.');
  if (st.health) L.push('WARNING: not checking everything since ' + String(st.health.since).slice(0, 16).replace('T', ' ') + ': ' + (st.health.problems || []).join('; '));
  if (st.listError) L.push('Listing error: ' + st.listError + ' (last good listing ' + (st.listOkAt || 'never') + ')');
  const li = lockInfo(ctx); if (li) L.push('Lock: ' + (li.held ? 'held by ' + li.held : 'stale (' + li.stale + '); the next tick removes it'));
  const sk = readJson(ctx.paths.skips, null); if (sk && sk.count) L.push('WARNING: skipped ' + sk.count + ' time(s) in a row because the lock was held (' + one(sk.held) + ')');
  const keys = Object.keys(st.repos).sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1), watched = keys.filter(k => !st.repos[k].skipped);
  // Zero watched repos is not a clean bill of health: this check is protecting nothing, and a bare 'Watched repos (0):'
  // under a status header reads as an all-clear to anyone quoting it.
  if (!watched.length) L.push('WARNING: 0 watched - nothing is protected: no repository this check can see is being watched (' + CONFIG_REL + ' lists ' + keys.length + '), so nothing guards a default branch. See ' + relTo(ctx, ctx.paths.md) + '.');
  L.push('Watched repos (' + watched.length + (keys.length > watched.length ? ', plus ' + (keys.length - watched.length) + ' listed that nobody can push to' : '') + '):');
  for (const k of watched) {
    const r = st.repos[k];
    L.push('  ' + k.padEnd(40) + ' ' + (r.branch || '?') + ' @ ' + (short(r.sha) || (r.empty ? 'empty' : 'not seen yet')) + (r.checkedAt ? ', checked ' + r.checkedAt.slice(0, 16).replace('T', ' ') : '') +
      (r.pending ? '  PENDING: ' + r.pending : '') + (r.lastError ? '  ERROR since ' + String(r.errorSince || r.lastErrorAt || '').slice(0, 16).replace('T', ' ') + ': ' + r.lastError : '') + (r.unlisted ? '  (not in the listing: ' + r.unlisted + ')' : '') + (r.note ? '  (' + r.note + ')' : ''));
  }
  const others = Object.values(st.others || {});
  if (others.length) L.push('Found locally, not watched (' + others.length + '): ' + others.slice(0, 15).map(o => o.repo + ' (' + (o.status || 'not asked yet') + ')').join('; ') + (others.length > 15 ? '; …' : ''));
  const rec = (st.recent || []).slice(-10);
  L.push(rec.length ? 'Recent flags (newest last):' : 'No flags yet.');
  for (const f of rec) L.push('  ' + String(f.at).slice(0, 16).replace('T', ' ') + ' ' + f.repo + ' ' + f.branch + ': ' + f.title + (f.pr ? ' (PR #' + f.pr + ')' : '') + (f.sha ? ' ' + short(f.sha) : ''));
  L.push('API calls in the last ' + Math.min(48, ticks.length) + ' ticks: ' + (ticks.map(t => t.apiCalls || 0).join(' ') || 'none'));
  L.push('Watch list: ' + CONFIG_REL + (ctx.cfg.discover ? ' (plus every repo the gh login can push to)' : '') + ' (' + ctx.cfg.repos.length + ' listed) · state: company/work/security/default-branch-watch.state.json (+ .backup.json) · report: company/work/security/default-branch-watch.md');
  return L.join('\n');
}

module.exports = { tick, baseline, status, context, discover, passFor, _internals: { judgeRange, walkGap, judgeActivity, slugOf, remotesOf, loadState, lockInfo, takeLock, ghEnv, JQ, loadConfig } };

/* ---------------- selftest (fake GitHub, temp folders) ---------------- */
function fakeGitHub(clock) {
  let n = 0, aid = 5000; const G = { repos: {}, fail: null, actFail: null, cap: 250, calls: [], viewer: 'owner1', delay: 0 };
  const R = full => G.repos[String(full).toLowerCase()];
  const now = () => new Date(clock()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const notFound = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 404 });
  const info = r => ({ id: r.id, full_name: r.full_name, default_branch: r.default_branch, archived: r.archived, disabled: !!r.disabled, pushed_at: r.pushed_at, created_at: r.created_at, owner: { login: r.full_name.split('/')[0] }, permissions: r.push === undefined ? null : { push: r.push } });
  let ids = 700;
  G.repo = (full, o) => { const r = Object.assign({ id: ++ids, full_name: full, default_branch: 'main', archived: false, push: true, listed: true, created_at: '2026-01-01T00:00:00Z', pushed_at: '2026-11-01T00:00:00Z', heads: {}, commits: new Map(), pulls: {}, acts: [] }, o || {}); G.repos[full.toLowerCase()] = r; return r; };
  // by: 'GitHub' = made and signed by GitHub; 'forged' = committer name GitHub and the web-flow address, unsigned; else a person
  G.commit = (full, parents, msg, by) => {
    const sha = crypto.createHash('sha1').update('commit ' + (++n)).digest('hex'), gh = by === 'GitHub', forged = by === 'forged';
    R(full).commits.set(sha, { sha, i: n, parents: parents.map(p => ({ sha: p })), committer: { login: gh || forged ? 'web-flow' : 'owner1' },
      commit: { message: (msg || 'change ' + n) + '\n\nbody', author: { name: forged ? 'Owner Name' : 'Agent', date: now() }, committer: { name: gh || forged ? 'GitHub' : (by || 'Agent'), date: now() }, verification: { verified: gh, reason: gh ? 'valid' : 'unsigned' } } });
    return sha;
  };
  // the branch moves to sha; GitHub logs it as `type` unless o.unlogged
  G.move = (full, sha, type, o) => {
    o = o || {}; const r = R(full), b = o.branch || r.default_branch, before = r.heads[b] || '0'.repeat(40);
    if (sha) r.heads[b] = sha; else delete r.heads[b];
    r.pushed_at = now();
    if (!o.unlogged) r.acts.push({ id: ++aid, before, after: sha || '0'.repeat(40), ref: 'refs/heads/' + b, timestamp: now(), activity_type: type || 'push', actor: { login: o.actor || G.viewer } });
  };
  G.pr = (full, number, o) => {
    const p = { number, title: 'PR ' + number, merged_at: o.merged === false ? null : now(), merge_commit_sha: o.mergeSha || null, base: { ref: o.base || R(full).default_branch }, head: { sha: o.head, ref: 'feature-' + number } };
    for (const c of o.commits || []) (R(full).pulls[c] = R(full).pulls[c] || []).push(p);
    return p;
  };
  const anc = (r, sha) => { const seen = new Set(), todo = [sha]; while (todo.length) { const s = todo.pop(); if (!s || seen.has(s) || !r.commits.has(s)) continue; seen.add(s); for (const p of r.commits.get(s).parents) todo.push(p.sha); } return seen; };
  G.api = endpoint => {
    G.calls.push(endpoint);
    if (G.delay) { const until = Date.now() + G.delay; while (Date.now() < until) { /* a slow GitHub */ } }
    if (G.fail && G.fail.test(endpoint)) throw Object.assign(new Error('gh: Server Error (HTTP 502)'), { status: 502 });
    let m, r;
    if (endpoint === 'user') return { login: G.viewer };
    if ((m = endpoint.match(/^user\/repos\?per_page=100&page=(\d+)$/))) { const all = Object.values(G.repos).filter(x => x.listed).sort((a, b) => (a.full_name.toLowerCase() < b.full_name.toLowerCase() ? -1 : 1)); return all.slice((m[1] - 1) * 100, m[1] * 100).map(info); }
    if ((m = endpoint.match(/^repos\/([^/]+\/[^/?]+)$/))) { if (!(r = R(m[1]))) throw notFound(); return info(r); }
    if (!(m = endpoint.match(/^repos\/([^/]+\/[^/]+)\/(.*)$/)) || !(r = R(m[1]))) throw notFound();
    const rest = m[2];
    if ((m = rest.match(/^branches\/(.+)$/))) { const h = r.heads[decodeURIComponent(m[1])]; if (!h) throw notFound(); return { name: decodeURIComponent(m[1]), commit: { sha: h } }; }
    if ((m = rest.match(/^activity\?ref=([^&]+)&per_page=(\d+)$/))) {
      if (G.actFail && G.actFail.test(endpoint)) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 404 });
      const ref = decodeURIComponent(m[1]); return r.acts.filter(a => a.ref === ref).slice().reverse().slice(0, Number(m[2]));
    }
    if ((m = rest.match(/^compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/))) {
      if (!r.commits.has(m[1]) || !r.commits.has(m[2])) throw notFound();
      const a = anc(r, m[2]), b = anc(r, m[1]), ahead = [...a].filter(s => !b.has(s)), behind = [...b].filter(s => !a.has(s));
      const status = !ahead.length && !behind.length ? 'identical' : !behind.length ? 'ahead' : !ahead.length ? 'behind' : 'diverged';
      return { status, ahead_by: ahead.length, behind_by: behind.length, total_commits: ahead.length, commits: ahead.map(s => r.commits.get(s)).sort((x, y) => x.i - y.i).slice(-G.cap) };
    }
    if ((m = rest.match(/^commits\/([0-9a-f]{40})\/pulls$/))) return r.pulls[m[1]] || [];
    throw notFound();
  };
  return G;
}
function selftest() {
  const TMP = require('./lib/temp-life').tmpDir('dbw-selftest-');
  let bad = 0, nroot = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
  const LOOPS = JSON.stringify({ agents: { agent: { name: 'Alex', functions: ['ceo'], manager: null, inbox: 'to-alex.md' }, engineer: { name: 'Sam', functions: ['tools'], manager: 'agent', inbox: 'to-sam.md' },
    auditor: { name: 'Jo', functions: ['risk'], manager: 'agent', inbox: 'to-jo.md' }, drafter: { name: 'Kim', manager: 'agent', inbox: 'to-kim.md' } } });
  const START = '2026-11-15T20:10:25Z';   // the fixtures' watch start
  const savedTZ = TZ; TZ = 'UTC';   // fixed clock text, whatever company.json says
  const remote = url => '[core]\n\tbare = false\n[remote "origin"]\n\turl = ' + url + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  const setup = () => {
    const T = path.join(TMP, 'r' + (++nroot)); fs.mkdirSync(T, { recursive: true });
    let now = Date.parse('2026-11-16T00:00:00Z');
    const S = { T, out: [], get now() { return now; }, adv: d => { now += d; } };
    S.G = fakeGitHub(() => now);
    S.W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
    S.Rd = rel => { try { return fs.readFileSync(path.join(T, rel), 'utf8'); } catch (_) { return ''; } };
    S.C = o => context(Object.assign({ root: T, now, api: S.G.api, log: l => S.out.push(l), ownerShell: false, underStation: false, tty: false, recordTest: true }, o || {}));
    S.tick = o => { S.out.length = 0; return tick(S.C(o)); };
    S.state = () => readJson(path.join(T, 'company/work/security/default-branch-watch.state.json'), {});
    S.blocks = inbox => (S.Rd('company/work/handoffs/' + inbox).match(/^## .* from Default-branch watch /gm) || []).length;
    S.lastBlock = inbox => S.Rd('company/work/handoffs/' + inbox).split(/^(?=## )/m).pop();
    S.evidence = (name, sha, d) => S.W('company/work/evidence/premerge-' + name + '-' + sha + '.json', JSON.stringify(Object.assign({ sha }, d)));
    S.W('company/tools/loops.json', LOOPS); S.W(CONFIG_REL, JSON.stringify({ repos: [], discover: true, watchStart: START })); S.W('company/work/handoffs/to-sam.md', '# Sam\n'); S.W('company/work/handoffs/to-kim.md', '# Kim\n');
    return S;
  };
  const kinds = r => (r.flags || []).map(f => f.kind).sort().join(',');
  const base = (S, full, o) => { const r = S.G.repo(full, o); const c0 = S.G.commit(full, [], 'root'); r.heads[r.default_branch] = c0; return c0; };   // existing before the watch started
  const H = HOUR;

  // ---- discovery and the first tick ----
  { const S = setup();
    ok(!Object.values(S.C().paths).some(p => p.startsWith(LIVE_ROOT + path.sep)), 'the selftest writes only in temp folders (state, backup, report, handoffs, evidence, lock)');
    S.W('company/repos/app/.git/config', remote('https://github.com/acme/app.git'));
    S.W('company/repos/app/.git/worktrees/wt/commondir', '../..\n');
    S.W('scratch/wt/.git', 'gitdir: ' + path.join(S.T, 'company/repos/app/.git/worktrees/wt') + '\n');
    S.W('scratch/a/b/c/r4/.git/config', remote('https://x-access-token:secret@github.com/ACME/app'));
    S.W('scratch/a/b/c/d/deep/.git/config', remote('https://github.com/acme/deep.git'));
    S.W('scratch/x/node_modules/pkg/.git/config', remote('https://github.com/acme/nm.git'));
    S.W('company/memory/notes/.git/config', remote('git@github.com:acme/notes.git'));
    S.W('company/projects.json', JSON.stringify({ projects: [{ remote: 'https://github.com/acme/site' }] }));
    S.W('company/work/merge-gate.log', '2026-11-15T18:28:43.782Z ALLOWED Acme/App #3 head aaaaaaaa\n2026-11-15T18:30:00.000Z REFUSED acme/tools #9: no pre-merge record for head bbbbbbbb.\n');
    const d = discover(S.C());
    ok([...d.keys()].sort().join(' ') === 'acme/app acme/notes acme/site acme/tools', 'local remotes, worktrees, projects.json and merge-gate.log are found, deduped by owner/name (' + [...d.keys()].join(' ') + ')');
    ok(d.get('acme/app').foundIn.join(' ') === 'company/repos/app scratch/a/b/c/r4 scratch/wt company/work/merge-gate.log' && !JSON.stringify([...d.values()]).includes('secret'), 'a worktree resolves to its main repo; depth 4 searched, depth 5 and node_modules not; a token in a remote URL is never kept');
    const cut = ms(START);
    base(S, 'acme/app'); base(S, 'acme/notes'); base(S, 'acme/site'); base(S, 'acme/unrelated');   // pushable, no clone anywhere: still watched
    base(S, 'someone/lib', { push: false }); base(S, 'acme/old', { archived: true }); base(S, 'acme/blocked', { disabled: true }); base(S, 'owner1/mine', { push: false });   // own repo: never left out
    base(S, 'acme/noperm', { push: undefined });
    S.G.repo('acme/fresh', { created_at: iso(cut + H) }); S.G.move('acme/fresh', S.G.commit('acme/fresh', [], 'init'), 'branch_creation');
    const o0 = base(S, 'acme/other'); const oD = S.G.commit('acme/other', [o0], 'EVIL direct push'); S.G.move('acme/other', oD, 'push');   // pushed after the watch started, before it was first seen
    const f0 = base(S, 'acme/feat'); S.G.move('acme/feat', S.G.commit('acme/feat', [f0], 'feature'), 'push', { branch: 'feature' });     // pushed, but only to a feature branch
    const p0 = base(S, 'friend/proj', { push: true }); S.G.move('friend/proj', S.G.commit('friend/proj', [p0], 'their own push'), 'push', { actor: 'friend' });   // a collaborator's repo
    let r = S.tick(), s = S.state();
    const w = Object.keys(s.repos).filter(k => !s.repos[k].skipped).sort().join(' ');
    ok(w === 'acme/app acme/feat acme/fresh acme/noperm acme/notes acme/other acme/site acme/unrelated friend/proj owner1/mine', 'every repo the login can push to is watched, clone or not; archived, disabled and no-push ones are not, own ones and ones listed without permissions are (' + w + ')');
    ok(s.repos['acme/noperm'].note && /without permissions/.test(s.repos['acme/noperm'].note), 'a repo listed without permissions is watched, with a note (not silently skipped)');
    ok(kinds(r) === 'new-repo,pushed' && r.flags.find(f => f.kind === 'pushed').sha === oD, 'first sight judges what GitHub logged since the watch started: the direct push to acme/other is flagged, a new repo is a note (' + kinds(r) + ')');
    ok(!s.repos['acme/feat'].sha && s.repos['acme/feat'].pending && s.repos['friend/proj'].sha !== p0 && !r.flags.some(f => f.repo === 'friend/proj' || f.repo === 'acme/feat'), 'a push by another GitHub account on a collaborator repo is not flagged; a fresh push GitHub has not logged on the default branch waits a tick');
    ok(s.others['acme/tools'] && /404/.test(s.others['acme/tools'].status || '') && !s.repos['acme/tools'], 'a merge-gate.log name GitHub does not know is looked up once, kept out of the watch');
    const riskTxt = S.lastBlock('to-jo.md'), ceoTxt = S.lastBlock('to-alex.md');
    ok(/\*\*Status:\*\* OPEN/.test(riskTxt) && /\*\*Deadline:\*\* 2026-11-17/.test(riskTxt) && /DONE — FYI/.test(ceoTxt) && ceoTxt.includes(oD) && !ceoTxt.includes('acme/fresh'), 'Jo gets an OPEN handoff with a next-day deadline; Alex an FYI with the push but not the new-repo note');
    ok(/not evidence/.test(riskTxt) && /runs\.jsonl/.test(riskTxt) && /if you did this yourself, nothing to do/.test(riskTxt) && /if the owner did it themselves, nothing to do/i.test(ceoTxt), 'the handoffs say names are not evidence, point to the agent runs, and that the owner\'s own change needs nothing');
    const before = S.G.calls.length; S.adv(10 * MIN); r = S.tick();
    ok(r.skipped && S.G.calls.length === before, 'a tick within 55 min does nothing and calls nothing');
    S.adv(50 * MIN); const before2 = S.G.calls.length; r = S.tick();
    ok(!r.skipped && S.G.calls.length - before2 <= 4 && S.state().repos['acme/feat'].sha === f0 && r.flags.length === 0, 'an hour later the feature-branch push is taken as it is (not flagged), and a quiet account costs a few calls: ' + (S.G.calls.length - before2));
  }

  // ---- merges, pushes, PASS records (GitHub's activity log) ----
  { const S = setup(), A = 'acme/app';
    S.W('company/work/merge-gate.log', '2026-11-16T00:30:00.000Z ALLOWED acme/app #3 head aaaaaaaa\n');
    const c0 = base(S, A); S.tick(); S.adv(H);
    const f1 = S.G.commit(A, [c0], 'feature 1'), m1 = S.G.commit(A, [c0, f1], 'Merge pull request #1', 'GitHub'); S.G.pr(A, 1, { head: f1, mergeSha: m1, commits: [m1, f1] }); S.evidence('app', f1, { verdict: 'PASS' }); S.G.move(A, m1, 'pr_merge');
    const h2 = S.G.commit(A, [c0], 'feature 2'), s2 = S.G.commit(A, [m1], 'squashed (#2)', 'GitHub'); S.G.pr(A, 2, { head: h2, mergeSha: s2, commits: [s2] }); S.evidence('APP', h2, { verdict: 'FAIL', history: [{ verdict: 'PASS' }] }); S.G.move(A, s2, 'pr_merge');
    const h4 = S.G.commit(A, [c0], 'feature 4'), r1 = S.G.commit(A, [s2], 'rebased 1', 'GitHub'), r2 = S.G.commit(A, [r1], 'rebased 2', 'GitHub'); S.G.pr(A, 4, { head: h4, mergeSha: r2, commits: [r1, r2] }); S.evidence('app', h4, { verdict: 'PASS' }); S.G.move(A, r2, 'pr_merge');
    let r = S.tick(), s = S.state();
    ok(r.flags.length === 0 && r.ok === 3 && s.repos[A].sha === r2, 'merge, squash and rebase merges of PRs with a PASS: no flag (history entries count; the evidence name is matched without regard to case)');
    ok(!S.blocks('to-jo.md') && !S.blocks('to-alex.md'), 'nothing flagged: no handoff');
    S.adv(H);
    const d1 = S.G.commit(A, [r2], 'hotfix straight on main'); S.G.move(A, d1, 'push');
    const f5 = S.G.commit(A, [c0], 'feature 5'), m5 = S.G.commit(A, [d1, f5], 'Merge pull request #5', 'GitHub'); S.G.pr(A, 5, { head: f5, mergeSha: m5, commits: [m5] }); S.G.move(A, m5, 'pr_merge');
    const f3 = S.G.commit(A, [c0], 'feature 3'), m3 = S.G.commit(A, [m5, f3], 'Merge pull request #3', 'GitHub'); S.G.pr(A, 3, { head: f3, mergeSha: m3, commits: [m3] }); S.G.move(A, m3, 'pr_merge');
    const hL = S.G.commit(A, [c0], 'feature 11'); S.evidence('app', hL, { verdict: 'PASS' });
    const mL = S.G.commit(A, [m3, hL], 'Merge branch feature (with unreviewed edits)', 'Sam'); S.G.pr(A, 11, { head: hL, mergeSha: mL, commits: [mL] }); S.G.move(A, mL, 'push');   // a local merge commit, pushed
    const h12 = S.G.commit(A, [mL], 'feature 12 head'); S.evidence('app', h12, { verdict: 'PASS' }); S.G.pr(A, 12, { head: h12, mergeSha: 'a'.repeat(40), commits: [h12] }); S.G.move(A, h12, 'push');   // a passed head, fast-forwarded
    const stateBytes = S.Rd('company/work/security/default-branch-watch.state.json');
    S.out.length = 0; r = tick(S.C({ dry: true }));
    ok(r.flags.length === 5 && S.Rd('company/work/security/default-branch-watch.state.json') === stateBytes && !S.blocks('to-jo.md'), 'a dry run ignores the 55-min limit, finds the same flags and writes nothing');
    r = S.tick();
    ok(kinds(r) === 'no-pass,no-pass,pushed,pushed,pushed', 'a direct push, a locally made merge commit and a fast-forwarded PASSed head are all "pushed"; PRs #5 and #3 without a PASS are flagged (' + kinds(r) + ')');
    const f3f = r.flags.find(f => f.pr === 3), f5f = r.flags.find(f => f.pr === 5), fL = r.flags.find(f => f.sha === mL);
    ok(f3f && /ALLOWED line for #3/.test(f3f.detail) && /but for head aaaaaaaa/.test(f3f.detail) && f5f && /no ALLOWED line for #5/.test(f5f.detail), 'says whether merge-gate.log has an ALLOWED line for the PR (and for which head)');
    ok(fL && /PR #11, whose head has a pre-merge PASS/.test(fL.detail) && /committer Sam/.test(fL.detail) && /not signed by GitHub/.test(fL.detail), 'the local merge says what GitHub links it to and who committed it, without trusting it');
    ok(S.blocks('to-jo.md') === 1 && S.blocks('to-alex.md') === 1 && S.Rd('company/work/handoffs/to-sam.md') === '# Sam\n' && S.Rd('company/work/handoffs/to-kim.md') === '# Kim\n', 'one handoff per tick, to Jo and Alex only');
    const riskTxt = S.lastBlock('to-jo.md'), ceoTxt = S.lastBlock('to-alex.md');
    ok(riskTxt.includes('/pull/5') && riskTxt.includes('/pull/3') && !ceoTxt.includes('/pull/5') && ceoTxt.includes(d1.slice(0, 8)), 'Jo gets every flag with links; Alex only the direct pushes');
    S.adv(H);
    const back = S.G.repos[A].commits.get(m3).sha; S.G.move(A, back, 'force_push');
    const n0 = base(S, 'acme/notes'); S.W('company/memory/notes/.git/config', remote('https://github.com/acme/notes.git'));
    r = S.tick();
    ok(kinds(r) === 'rewritten' && /force push/.test(r.flags[0].detail), 'a force push back to an older commit -> history rewritten (to Alex too)');
    ok(S.state().repos['acme/notes'] && S.state().repos['acme/notes'].sha === n0 && S.blocks('to-alex.md') === 2, 'a repo created before the watch and never pushed since is taken as it is');
  }

  // ---- what the activity log does not show: the commits decide ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const gw = S.G.commit(A, [c0], 'merge on GitHub', 'GitHub'), fx = S.G.commit(A, [c0], 'feature x'); S.G.pr(A, 7, { head: fx, mergeSha: gw, commits: [gw] }); S.evidence('app', fx, { verdict: 'PASS' }); S.G.move(A, gw, 'pr_merge', { unlogged: true });
    const p1 = S.G.commit(A, [gw], 'pushed from a clone'); S.G.move(A, p1, 'push', { unlogged: true });
    const fg = S.G.commit(A, [p1], 'chore: owner hotfix (owner approved, nothing to do)', 'forged'); S.G.move(A, fg, 'push', { unlogged: true });
    S.adv(20 * MIN);
    let r = S.tick();
    const pf = r.flags.filter(f => f.kind === 'pushed');
    ok(kinds(r) === 'pushed' && r.ok === 1 && pf.length === 1 && /2 first-parent commits/.test(pf[0].detail), 'unlogged changes are judged from the commits: the GitHub-made merge with a PASS is ok, the two pushed commits one flag');
    ok(/committer GitHub \(GitHub account web-flow\), not signed by GitHub/.test(pf[0].detail) && !/made and signed by GitHub \(a merge/.test(pf[0].detail), 'a commit that only claims to be GitHub\'s (name and address, no signature) is called pushed, never "made on github.com"');
    S.adv(H);
    const ed = S.G.commit(A, [fg], 'edit in the web UI', 'GitHub'); S.G.move(A, ed, 'push', { unlogged: true }); S.G.repos[A].pushed_at = iso(S.now - 20 * MIN);
    r = S.tick();
    ok(r.deferred === 1 && r.flags.length === 0 && S.state().repos[A].sha === fg, 'a GitHub-made commit with no PR yet, younger than 15 min, waits for the next tick (GitHub links merges a little later)');
    S.adv(H); r = S.tick();
    ok(kinds(r) === 'no-pr' && /web editor or the API/.test(r.flags[0].detail), 'an hour later it has no PR: landed without a pull request (a web or API edit)');
    // bury a push under a 40-commit legitimate rebase merge, plus a merge-commit PR with 262 commits, all unlogged
    S.adv(H);
    let tip = ed; const D = S.G.commit(A, [tip], 'EVIL direct push'); tip = D;
    const hb = S.G.commit(A, [c0], 'big PR head'), many = []; for (let i = 0; i < 41; i++) { tip = S.G.commit(A, [tip], 'rebased ' + i, 'GitHub'); many.push(tip); }
    S.G.pr(A, 8, { head: hb, mergeSha: tip, commits: many }); S.evidence('app', hb, { verdict: 'PASS' });
    let ft = c0; for (let i = 0; i < 262; i++) ft = S.G.commit(A, [ft], 'feature ' + i);
    const D2 = S.G.commit(A, [tip], 'EVIL push number two'); const M9 = S.G.commit(A, [D2, ft], 'Merge pull request #9', 'GitHub'); S.G.pr(A, 9, { head: ft, mergeSha: M9, commits: [M9] }); S.evidence('app', ft, { verdict: 'PASS' });
    S.G.move(A, M9, 'push', { unlogged: true }); S.adv(20 * MIN);
    const r1 = S.tick(), s1 = S.state(); S.adv(H); const r2 = S.tick(), s2 = S.state();
    const all = r1.flags.concat(r2.flags);
    ok(r1.flags.some(f => f.sha === D) && r1.deferred === 1 && s1.repos[A].sha !== M9 && s1.repos[A].pending, 'a push buried under a 41-commit rebase merge is flagged, oldest first; the rest waits (the watched head stops where judging stopped)');
    ok(all.some(f => f.sha === D2) && s2.repos[A].sha === M9 && !s2.repos[A].pending && all.filter(f => f.pr === 8).length === 0, 'the next tick finishes: the push behind the 262-commit merge is found too (compared again past GitHub\'s 250), PR #8 is not flagged twice');
  }

  // ---- the commit fallback: a branch pushed over, a reset, an old head GitHub no longer has; deletion; a long first sight ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const fa = S.G.commit(A, [c0], 'feature a'), m1 = S.G.commit(A, [c0, fa], 'Merge pull request #20', 'GitHub'); S.G.pr(A, 20, { head: fa, mergeSha: m1, commits: [m1] }); S.evidence('app', fa, { verdict: 'PASS' }); S.G.move(A, m1, 'pr_merge');
    S.tick(); S.adv(H);
    const x1 = S.G.commit(A, [c0], 'feature work'), fox = S.G.commit(A, [x1, m1], 'Merge branch main into feature'); S.G.move(A, fox, 'push', { unlogged: true }); S.G.repos[A].pushed_at = iso(S.now - 20 * MIN);
    let r = S.tick();
    ok(kinds(r) === 'pushed,pushed-over' && r.flags.find(f => f.kind === 'pushed').detail.startsWith('2 first-parent commits'), 'unlogged: a branch pushed over main (main merged into it, pushed) -> "pushed over" plus its pushed commits');
    S.adv(H); S.G.move(A, m1, 'push', { unlogged: true }); S.G.repos[A].pushed_at = iso(S.now - 20 * MIN);
    r = S.tick();
    ok(kinds(r) === 'rewritten' && /moved back/.test(r.flags[0].detail), 'unlogged: a reset to an older commit -> history rewritten');
    S.adv(H); S.G.repos[A].commits.delete(m1); const nx = S.G.commit(A, [], 'new root'); S.G.move(A, nx, 'push', { unlogged: true }); S.G.repos[A].pushed_at = iso(S.now - 20 * MIN);
    r = S.tick(); const err1 = S.state().repos[A].lastError;
    S.adv(H); const r2 = S.tick();
    ok(r.flags.length === 0 && /404/.test(err1 || '') && kinds(r2) === 'rewritten' && /no longer on GitHub/.test(r2.flags[0].detail) && S.state().repos[A].sha === nx, 'the old head gone from GitHub: an error once (asked again), then history rewritten and the watch moves on');
    S.adv(H); S.G.move(A, null, 'branch_deletion'); const re = S.G.commit(A, [], 're-created'); S.G.move(A, re, 'branch_creation'); S.adv(20 * MIN);
    r = S.tick();
    ok(kinds(r) === 'rewritten,rewritten' && /deleted/.test(r.flags.map(f => f.title).join(' ')) && S.state().repos[A].sha === re, 'the default branch deleted and created again: both flagged as rewritten');
    const B = 'acme/busy', b0 = base(S, B); let t = b0; for (let i = 0; i < 105; i++) { t = S.G.commit(B, [t], 'push ' + i); S.G.move(B, t, 'push'); }
    S.adv(H); r = S.tick();
    ok(r.flags.some(f => f.repo === B && f.kind === 'unchecked' && /more than 100 changes/.test(f.detail)) && r.flags.filter(f => f.repo === B && f.kind === 'pushed').length >= 10 && S.state().repos[B].pending, 'a repo first seen with more than 100 logged changes: the older part is named as unchecked, the rest is judged over several ticks');
  }

  // ---- PR association lag, rename after a push, case-insensitive evidence ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const f = S.G.commit(A, [c0], 'feature'), M = S.G.commit(A, [c0, f], 'Merge pull request #4', 'GitHub'); S.evidence('app', f, { verdict: 'PASS' }); S.G.move(A, M, 'pr_merge');
    let r = S.tick();
    ok(r.flags.length === 0 && r.deferred === 1 && !S.blocks('to-alex.md'), 'a fresh pr_merge GitHub has not linked to its PR yet is left for the next tick, not flagged');
    S.G.pr(A, 4, { head: f, mergeSha: M, commits: [M] }); S.adv(H); r = S.tick();
    ok(r.flags.length === 0 && r.ok === 1 && S.state().repos[A].sha === M, 'the next tick finds the PR and its PASS: no flag');
    S.adv(H);
    const D = S.G.commit(A, [M], 'EVIL direct push'); S.G.move(A, D, 'push');
    const ra = S.G.repos[A]; ra.default_branch = 'trunk'; ra.heads.trunk = D; delete ra.heads.main;   // renamed main -> trunk in the same hour
    r = S.tick();
    ok(kinds(r) === 'branch-changed,pushed' && r.flags.find(x => x.kind === 'pushed').sha === D && S.state().repos[A].branch === 'trunk', 'a default branch renamed after a push: both the rename and the push are flagged, then trunk is watched');
    const S2 = setup(), B = 'Acme/App';
    S2.W('company/work/merge-gate.log', '2026-11-16T00:30:00.000Z ALLOWED acme/app #3 head 00000000\n');
    const b0 = base(S2, B); S2.tick(); S2.adv(H);
    const fb = S2.G.commit(B, [b0], 'feature'), MB = S2.G.commit(B, [b0, fb], 'Merge pull request #3', 'GitHub'); S2.G.pr(B, 3, { head: fb, mergeSha: MB, commits: [MB] }); S2.evidence('app', fb, { verdict: 'PASS' }); S2.G.move(B, MB, 'pr_merge');
    r = S2.tick();
    ok(r.flags.length === 0 && r.ok === 1, 'a PASS recorded as premerge-app-<sha> counts for the GitHub name Acme/App');
  }

  // ---- renames keep the checked head; starvation; errors and the dead man's switch ----
  { const S = setup();
    const z0 = base(S, 'acme/zed'); S.tick(); S.adv(H);
    const R0 = S.G.repos['acme/zed']; R0.full_name = 'acme/alpha'; S.G.repos['acme/alpha'] = R0; delete S.G.repos['acme/zed'];
    const D = S.G.commit('acme/alpha', [z0], 'EVIL direct push'); S.G.move('acme/alpha', D, 'push');
    S.W('scratch/new/alpha/.git/config', remote('https://github.com/acme/alpha.git'));
    const r = S.tick(), s = S.state();
    ok(kinds(r) === 'pushed' && s.repos['acme/alpha'] && s.repos['acme/alpha'].renamedFrom === 'acme/zed' && !s.repos['acme/zed'], 'a renamed repo (same id) keeps its checked head, so the push in between is flagged');
  }
  { const S = setup(), A = 'zeta/app';
    const c0 = base(S, A); S.tick();
    let log = ''; for (let i = 0; i < 60; i++) log += '2026-11-16T00:00:00.000Z REFUSED Aaa' + i + '/x #1: no pre-merge record for head bbbbbbbb.\n';
    S.W('company/work/merge-gate.log', log);
    for (let i = 0; i < 170; i++) S.W('scratch/junk/c' + i + '/.git/config', remote('https://github.com/0-planted/r' + i + '.git'));
    for (let i = 0; i < 110; i++) base(S, 'vendor' + i + '/lib', { push: false });
    S.adv(H); const D = S.G.commit(A, [c0], 'EVIL direct push'); S.G.move(A, D, 'push');
    S.G.delay = 6; const r = S.tick({ budgetMs: 700 }); S.G.delay = 0;   // 0.6 s a call and a 70 s budget, at 1/100 scale
    ok(r.flags.some(f => f.sha === D) && r.calls <= 12, 'planted remotes and 110 read-only repos do not starve the check: the push is flagged first (' + r.calls + ' calls)');
  }
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const d2 = S.G.commit(A, [c0], 'another direct commit'); S.G.move(A, d2, 'push'); S.G.fail = /^repos\/acme\/app\/branches/;
    let r = S.tick(), s = S.state();
    ok(r.flags.length === 0 && /HTTP 502/.test(s.repos[A].lastError || '') && s.repos[A].sha === c0 && !S.blocks('to-jo.md'), 'API failure: lastError, head kept, no flag');
    S.adv(H); S.G.fail = null; r = S.tick(); s = S.state();
    ok(kinds(r) === 'pushed' && s.repos[A].lastError === null && s.repos[A].sha === d2, 'the next tick retries and flags what landed meanwhile');
    S.G.fail = /^repos\/acme\/app\/branches/; const d3 = S.G.commit(A, [d2], 'pushed during an outage'); S.G.move(A, d3, 'push');
    for (let i = 0; i < 5; i++) { S.adv(H); r = S.tick(); }
    const nad = S.Rd('company/work/handoffs/to-sam.md');
    ok(S.blocks('to-sam.md') === 1 && /\*\*Status:\*\* OPEN/.test(nad) && /acme\/app has needed a check since/.test(nad) && /HTTP 502/.test(nad) && r.problems.length === 1, 'an error that lasts 3 h gives Sam (tools owner) one OPEN handoff and Jo an FYI, once a day');
    S.adv(H); S.G.fail = null; r = S.tick();
    ok(kinds(r) === 'pushed' && !S.state().health && /watch working again/.test(S.Rd('company/work/security/default-branch-watch.md')), 'when it can check again it flags what landed during the outage and logs that it works again');
    S.adv(5 * H); r = S.tick();
    ok(r.problems.some(p => /no full check ran between/.test(p)), 'a gap of more than 3 h without a full check is itself reported');
    S.G.fail = /^user\/repos/; for (let i = 0; i < 4; i++) { S.adv(H); r = S.tick(); }
    ok(r.problems.some(p => /list of repositories/.test(p)) && r.calls >= 1, 'a listing that fails for 3 h is reported too (the known heads are polled one by one meanwhile)');
  }

  { const S = setup(); base(S, 'acme/app'); base(S, 'acme/gone'); S.tick();
    delete S.G.repos['acme/gone']; let r;
    for (let i = 0; i < 3; i++) { S.adv(H); r = S.tick(); }
    const s = S.state();
    ok(s.repos['acme/gone'].skipped && /gone/.test(s.repos['acme/gone'].skipped) && kinds(r) === 'repo-gone' && /DONE — FYI/.test(S.lastBlock('to-jo.md')) && !S.blocks('to-sam.md') && !S.blocks('to-alex.md'), 'a watched repo that is deleted (or access lost) is dropped after three 404s, as a note to Jo, without a false "not checking" alarm');
  }
  // ---- the lock ----
  { const S = setup(), A = 'acme/app', lock = () => path.join(S.T, 'company/work/security/default-branch-watch.lock'), cp = require('child_process');
    const c0 = base(S, A); S.tick(); S.adv(H); S.G.move(A, S.G.commit(A, [c0], 'EVIL direct push'), 'push');
    fs.writeFileSync(lock(), '1'); const fut = new Date('2030-01-01T00:00:00Z'); fs.utimesSync(lock(), fut, fut);
    let r = S.tick();
    ok(!r.skipped && kinds(r) === 'pushed' && S.out.some(l => /stale lock \(it is dated in the future\)/.test(l)), 'a lock dated in the future is stale: the check runs');
    S.adv(H); S.G.move(A, S.G.commit(A, [S.G.repos[A].heads.main], 'EVIL 2'), 'push'); fs.mkdirSync(lock());
    r = S.tick();
    ok(!r.skipped && kinds(r) === 'pushed', 'a lock that is a directory is removed: the check runs');
    const sleeper = cp.spawn('sleep', ['30'], { stdio: 'ignore' }), holder = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'default-branch-watch.js'], { stdio: 'ignore' });
    try {
      S.adv(H); fs.writeFileSync(lock(), JSON.stringify({ pid: sleeper.pid, start: Date.now() }));
      r = S.tick();
      ok(!r.skipped, 'a lock naming a live process that is not this tool is stale');
      S.adv(H); fs.writeFileSync(lock(), JSON.stringify({ pid: holder.pid, start: Date.now() }));   // looks like a running check
      r = S.tick(); S.adv(10 * MIN); const r2 = S.tick();
      ok(r.skipped && r.lock && /another check is running/.test(r.line) && r2.lock && S.blocks('to-sam.md') === 1 && /lock/.test(S.lastBlock('to-sam.md')) && /\*\*Status:\*\* OPEN/.test(S.lastBlock('to-sam.md')), 'a held lock skips (the dispatcher logs that line); two skips in a row hand Sam an OPEN handoff');
    } finally { sleeper.kill(); holder.kill(); }
    fs.unlinkSync(lock()); S.adv(H); r = S.tick();
    ok(!r.skipped && !fs.existsSync(path.join(S.T, 'company/work/security/default-branch-watch.skips.json')) && !fs.existsSync(lock()), 'once free, the check runs and the skip count is cleared');
  }

  // ---- report file, state file, refusals ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    fs.mkdirSync(path.join(S.T, 'company/work/security/default-branch-watch.md'));
    const D = S.G.commit(A, [c0], 'EVIL direct push'); S.G.move(A, D, 'push');
    let threw = null, r; try { r = S.tick(); } catch (e) { threw = e; }
    ok(!threw && kinds(r) === 'pushed,report-failed' && S.blocks('to-jo.md') === 1 && /could not be written/.test(S.lastBlock('to-jo.md')) && S.state().repos[A].sha === D, 'a report file that cannot be written: the handoffs still go out (saying so) and the state moves on');
  }
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const stf = path.join(S.T, 'company/work/security/default-branch-watch.state.json');
    let D = S.G.commit(A, [c0], 'EVIL direct push'); S.G.move(A, D, 'push');
    fs.writeFileSync(stf, '{"repos": oops');
    let r = S.tick();
    ok(kinds(r) === 'pushed,state-changed' && r.flags.some(f => f.sha === D) && /backup/.test(r.flags.find(f => f.kind === 'state-changed').detail) && S.blocks('to-alex.md') === 1, 'a corrupt state: resumed from the backup, the push in the gap is still flagged, Jo and Alex are told');
    S.adv(H); D = S.G.commit(A, [D], 'EVIL 2'); S.G.move(A, D, 'push');
    fs.writeFileSync(stf, 'x'); fs.writeFileSync(path.join(S.T, 'company/work/security/default-branch-watch.backup.json'), 'y');
    r = S.tick();
    ok(r.flags.some(f => f.sha === D) && r.flags.some(f => f.kind === 'state-changed' && /judged again from/.test(f.detail)), 'state and backup both unreadable: every repo is judged again from the last good write, not taken as it is');
    const st1 = S.state(); st1.repos[A].sha = 'e'.repeat(40); fs.writeFileSync(stf, JSON.stringify(st1)); S.adv(10 * MIN);
    r = S.tick();
    ok(!r.skipped && r.flags.some(f => f.kind === 'state-changed') && S.state().repos[A].sha === D, 'an edited state is flagged on the next tick (no 55-min wait) and the backup copy is used instead');
    const st2 = S.state(); st2.lastRun = S.now + 30 * DAY; fs.writeFileSync(stf, JSON.stringify(st2)); fs.unlinkSync(path.join(S.T, 'company/state/locked/provenance.jsonl'));   // no record to compare with
    ok(/in the future/.test(loadState(S.C()).tamper || ''), 'a last-check time in the future counts as a changed state (it would stop the checks)');
    ok(/WARNING/.test(status(S.C())) && /acme\/app/.test(status(S.C())), 'status lists the watched repos and warns about a changed state');
    { const S0 = setup(); S0.W(CONFIG_REL, JSON.stringify({ repos: [], discover: false, watchStart: START }));
      const text0 = status(S0.C());
      ok(/0 watched - nothing is protected/.test(text0) && /Watched repos \(0\)/.test(text0), 'an empty watch list says 0 watched - nothing is protected, instead of reading as a clean status'); }
    const a = S.tick({ underStation: true });
    ok(a.refused && /refused/.test(a.line), 'a real tick from an agent\'s run is refused (a dry run is not)');
    let threw = null; try { baseline(S.C({ ownerShell: true, tty: false })); } catch (e) { threw = e.message; }
    let threw2 = null; try { baseline(S.C({ ownerShell: false, tty: true })); } catch (e) { threw2 = e.message; }
    ok(/owner's own terminal/.test(threw || '') && /owner's own terminal/.test(threw2 || ''), 'baseline needs the owner\'s shell and a terminal');
    S.adv(H); const E = S.G.commit(A, [D], 'moved'); S.G.move(A, E, 'push');
    const b = baseline(S.C({ ownerShell: true, tty: true }));
    ok(b.rebaselined === 1 && S.state().repos[A].sha === E && /known-good without a check/.test(S.lastBlock('to-jo.md')) && /known-good without a check/.test(S.lastBlock('to-alex.md')), 'the owner\'s baseline takes the heads and tells Jo and Alex what it took unchecked');
  }

  // ---- handoff text limits, the agent runs, preview ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    let tip = c0; const t1 = S.now;
    for (let i = 0; i < 17; i++) { tip = S.G.commit(A, [tip], 'direct push number ' + i + ' with a long subject line that fills the handoff'); S.G.move(A, tip, 'push'); }
    S.W('.starnet-data/workspaces/runs.jsonl', '{"partial line\n' + JSON.stringify({ runId: 'abcdef12-3456', agentId: 'drafter', startedAt: t1 - 5 * MIN, endedAt: t1 + 5 * MIN, prompt: 'not read' }) + '\n');
    const r = S.tick(), riskTxt = S.lastBlock('to-jo.md');
    ok(r.flags.length === 17 && /… and \d+ more: see `company\/work\/security\/default-branch-watch\.md`/.test(riskTxt) && /[0-9a-f]{40}$/.test(riskTxt.split(' … and')[0].trim()), 'a long list is cut between items with "and N more", never mid-link');
    ok(/agent runs going: Kim \(run abcdef12/.test(riskTxt) && !riskTxt.includes('not read'), 'each item names the agent runs going at GitHub\'s time (only ids and times are read)');
    const S2 = setup(), B = 'acme/old'; const o0 = base(S2, B);
    S2.G.move(B, S2.G.commit(B, [o0], 'old direct push'), 'push');
    S2.G.repos[B].pushed_at = '2026-11-01T00:00:00Z';
    S2.out.length = 0; const p = tick(S2.C({ dry: true, preview: 3 }));
    ok(p.flags.length === 0 && S2.out.some(l => /PREVIEW acme\/old/.test(l)) && S2.out.some(l => /FLAG .*pushed straight/.test(l)) && !fs.existsSync(path.join(S2.T, 'company/work/security/default-branch-watch.state.json')), 'dry-run preview judges a new repo\'s logged history, flags nothing and writes nothing');
  }

  // ---- the owner's change, or possibly an agent's (the station's transcripts) ----
  { const S = setup(), A = 'acme/app', O = 'acme/own', N = 'acme/named', TR = '.starnet-data/workspaces/transcript-history-v2/';
    S.W('company/repos/app/.git/config', remote('https://github.com/acme/app.git'));
    const a0 = base(S, A), o0 = base(S, O), n0 = base(S, N); S.tick(); S.adv(H);
    const call = (ts, agentId, cmd) => JSON.stringify({ ts, agentId, sourceRunId: agentId + '-run-1', toolCalls: JSON.stringify([{ function: { name: 'shell_exec', arguments: JSON.stringify({ command: cmd }) } }]) });
    const lines = [call(S.now - 2 * DAY, 'engineer', 'gh api repos/acme/named/branches'),   // named two days ago: acme/named stays loud
      call(S.now - 20 * MIN, 'drafter', 'cat company/repos/app/README.md'),                    // names the clone, but cannot write to GitHub
      call(S.now - 10 * MIN, 'drafter', 'git push origin feature # acme/own-fork')];           // a longer name is not acme/own
    S.W(TR + 'manifest.json', JSON.stringify({ segments: [] })); S.W(TR + 'segment-000001.jsonl', lines.join('\n') + '\n');
    S.G.move(A, S.G.commit(A, [a0], 'owner hotfix'), 'push'); S.G.move(O, S.G.commit(O, [o0], 'owner work'), 'push'); S.G.move(N, S.G.commit(N, [n0], 'direct'), 'push');
    let r = S.tick(); const q = r.flags.filter(f => f.quiet).map(f => f.repo).sort().join(' '), riskTxt = S.lastBlock('to-jo.md'), ceoTxt = S.lastBlock('to-alex.md');
    ok(kinds(r) === 'pushed,pushed,pushed' && q === 'acme/app acme/own', 'with no agent command that could have made it, a company-repo push and a push to a repo no agent ever named are the owner\'s, probably (' + q + ')');
    ok(S.blocks('to-jo.md') === 1 && riskTxt.includes(N) && !riskTxt.includes(O + ' ') && !riskTxt.includes('owner hotfix') && S.blocks('to-alex.md') === 1 && ceoTxt.includes(N) && !ceoTxt.includes(O + ' '), 'only the loud flag reaches Jo and Alex');
    // the naming run is 2 days before the push, so it is NOT listed as the culprit: the row stays loud (an agent named this
    // repository inside 30 days) and the attribution is UNKNOWN with the distance
    const nd = r.flags.find(f => f.repo === N).detail;
    ok(/No agent tool call named this repository within 3h before to 5m after the change, so WHO PUSHED IS UNKNOWN/.test(nd) && /Sam \(run engineer[^)]*\), 2d0h before/.test(nd) && !/Agent tool calls that name this repository/.test(nd),
      'a loud flag whose run is 2 days away says UNKNOWN and prints the distance, instead of attaching the stale run');
    // ...and a run that IS inside the window is named, with its distance
    S.adv(H);   // a new push needs a new pushed_at, or the tick sees the same state and flags nothing
    lines.push(call(S.now - 2 * MIN, 'engineer', 'gh api repos/acme/named/commits')); S.W(TR + 'segment-000001.jsonl', lines.join('\n') + '\n');
    S.G.move(N, S.G.commit(N, [S.G.repos[N].heads.main], 'another direct push'), 'push');
    const r2 = S.tick(), nd2 = (r2.flags.find(f => f.repo === N) || { detail: '' }).detail;
    ok(/name this repository near that time \(3h before to 5m after\): Sam \(run engineer, 2m before\)$/.test(nd2),
      'a run inside the window is named as one that could have made the change, with its distance');
    // the window is config: a 90-minute-old call is inside the default 3 h but outside a 30-minute window
    S.adv(H);
    const oneCall = [call(S.now - 90 * MIN, 'engineer', 'gh api repos/acme/named/pulls')];   // the only call in the transcripts from here
    S.W(TR + 'segment-000001.jsonl', oneCall.join('\n') + '\n');
    S.W(CONFIG_REL, JSON.stringify({ repos: [], discover: true, watchStart: START, attribution: { nearBeforeMinutes: 30, nearAfterMinutes: 5 } }));
    S.G.move(N, S.G.commit(N, [S.G.repos[N].heads.main], 'a third direct push'), 'push');
    const r3 = S.tick(), nd3 = (r3.flags.find(f => f.repo === N) || { detail: '' }).detail;
    ok(/within 30m before to 5m after the change, so WHO PUSHED IS UNKNOWN/.test(nd3) && /1h30m before/.test(nd3),
      'the window is config: with nearBeforeMinutes 30 a call 90 minutes earlier is not named, the row says UNKNOWN');
    S.adv(H);
    S.W(CONFIG_REL, JSON.stringify({ repos: [], discover: true, watchStart: START }));
    S.W(TR + 'segment-000001.jsonl', [call(S.now - 90 * MIN, 'engineer', 'gh api repos/acme/named/pulls')].join('\n') + '\n');
    S.G.move(N, S.G.commit(N, [S.G.repos[N].heads.main], 'a fourth direct push'), 'push');
    const r4 = S.tick(), nd4 = (r4.flags.find(f => f.repo === N) || { detail: '' }).detail;
    ok(/near that time \(3h before to 5m after\): Sam \(run engineer, 1h30m before\)$/.test(nd4),
      'the default window (no attribution key) is 3 h before to 5 min after: the same call is named');
    S.adv(H);
    const md = S.Rd('company/work/security/default-branch-watch.md');
    ok((md.match(/\(owner, probably\)/g) || []).length === 2 && /most likely the owner's own work/.test(md), 'the quiet ones are still recorded in the report file');
    S.adv(H);
    const jo0 = S.blocks('to-jo.md');   // the ticks above moved the handoff count; the assertions below count from here
    lines.push(call(S.now - 5 * MIN, 'deployer', 'cd company/repos/app && /usr/bin/git push origin main')); S.W(TR + 'segment-000001.jsonl', lines.join('\n') + '\n');
    const before = S.G.repos[A].heads.main; S.G.move(A, S.G.commit(A, [before], 'agent bypass'), 'push');
    r = S.tick();
    ok(r.flags.length === 1 && !r.flags[0].quiet && /could have made it then: deployer \(run deployer,/.test(r.flags[0].detail) && S.blocks('to-jo.md') === jo0 + 1, 'an agent push from the company clone near that time stays loud and names the run');
    fs.rmSync(path.join(S.T, TR), { recursive: true, force: true }); S.adv(H);
    S.G.move(O, S.G.commit(O, [S.G.repos[O].heads.main], 'more owner work'), 'push'); r = S.tick();
    ok(r.flags.length === 1 && !r.flags[0].quiet && S.blocks('to-jo.md') === jo0 + 2, 'without readable transcripts nothing is quietened');
  }

  // ---- the real gh path: read-only arguments, a fixed environment ----
  { const S = setup(), argLog = path.join(S.T, 'gh-args.log'), fakeGh = path.join(S.T, 'bin', 'gh');
    S.W('bin/gh', '#!' + process.execPath + '\nconst fs = require("fs"); const a = process.argv.slice(2); fs.appendFileSync(' + JSON.stringify(argLog) + ', JSON.stringify({ a, env: Object.keys(process.env).sort() }) + "\\n");\n' +
      'if (a.includes("repos/acme/app")) { console.log(JSON.stringify({ full_name: "acme/app", default_branch: "main", archived: false, permissions: { push: true }, extra: 1 })); process.exit(0); }\n' +
      'process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1);\n');
    fs.chmodSync(fakeGh, 0o755);
    const saved = {}; for (const k of ['GH_TOKEN', 'GH_CONFIG_DIR', 'HTTPS_PROXY', 'SSL_CERT_FILE']) { saved[k] = process.env[k]; process.env[k] = '/tmp/evil'; }
    let info, err = null;
    try { const rc = context({ root: S.T, gh: fakeGh, ownerShell: false, underStation: false }); info = api(rc, 'repos/acme/app', JQ.repo); try { api(rc, 'repos/acme/none', JQ.repo); } catch (e) { err = e; } }
    finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    const calls = S.Rd('gh-args.log').trim().split('\n').map(l => JSON.parse(l));
    ok(info && info.default_branch === 'main' && err && err.status === 404 && /HTTP 404/.test(err.message), 'the real call path parses JSON and keeps the HTTP status of an error');
    ok(calls.length === 2 && calls.every(c => c.a[0] === 'api' && c.a[1] === '-X' && c.a[2] === 'GET' && c.a.includes('--jq') && !c.a.some(x => /^(-f|-F|--field|--raw-field|--input|--method)$/.test(x))), 'gh is only ever asked for a GET, with no fields or body');
    ok(calls.every(c => !c.env.some(k => /^(GH_TOKEN|GH_CONFIG_DIR|HTTPS_PROXY|SSL_CERT_FILE|GITHUB_TOKEN|NODE_OPTIONS)$/.test(k))), 'gh runs without the caller\'s GH_TOKEN, GH_CONFIG_DIR, proxy or certificate variables');
  }

  // ---- the watch list: without discover only listed repos are watched; taking one off is a note ----
  { const S = setup();
    S.W(CONFIG_REL, JSON.stringify({ repos: ['acme/app', 'acme/hidden', 'not a slug'], discover: false, watchStart: START }));
    base(S, 'acme/app'); const o0 = base(S, 'acme/other'); base(S, 'acme/hidden', { listed: false });
    S.W('company/repos/other/.git/config', remote('https://github.com/acme/other.git'));
    let r = S.tick(); const w = Object.keys(S.state().repos).filter(k => !S.state().repos[k].skipped).sort().join(' ');
    ok(w === 'acme/app acme/hidden' && r.flags.length === 0, 'without discover only the listed repos are watched, one missing from the login listing included, a local clone of another not (' + w + ')');
    S.G.move('acme/other', S.G.commit('acme/other', [o0], 'direct'), 'push'); S.adv(HOUR); r = S.tick();
    ok(r.flags.length === 0 && !S.blocks('to-jo.md'), 'a push to a repo that is not on the list is not judged');
    S.W(CONFIG_REL, JSON.stringify({ repos: ['acme/hidden'], discover: false, watchStart: START })); S.adv(HOUR); r = S.tick();
    ok(kinds(r) === 'repo-unwatched' && S.state().repos['acme/app'].skipped && /DONE — FYI/.test(S.lastBlock('to-jo.md')) && !S.blocks('to-alex.md'), 'a repo taken off the list stops being checked and the risk owner gets an FYI');
    S.W(CONFIG_REL, JSON.stringify({ repos: ['acme/hidden', 'acme/app'], discover: false, watchStart: START })); S.adv(HOUR); r = S.tick();
    ok(r.flags.length === 0 && !S.state().repos['acme/app'].skipped, 'put back on the list, it is watched again from its last checked head');
    fs.rmSync(path.join(S.T, CONFIG_REL));
    ok(loadConfig(S.T).repos.length === 0 && loadConfig(S.T).discover === false, 'no watch list: nothing is assumed (the defaults copy is read when there is one)');
  }

  // ---- guardrail defaultBranch: OFF records a direct push without telling anyone; ON flags it; the temp root's file is read ----
  { const S = setup(), A = 'acme/app';
    ok(S.C().guardOn === true, 'guardrail defaultBranch: no state file in the root -> ON (fail closed)');
    S.W('company/state/guardrails.json', JSON.stringify({ guards: { defaultBranch: false } }));
    ok(S.C().guardOn === false, 'guardrail defaultBranch: read from the watched root\'s company/state/guardrails.json');
    const c0 = base(S, A); S.tick(); S.adv(H);
    const d1 = S.G.commit(A, [c0], 'direct push while unguarded'); S.G.move(A, d1, 'push');
    let r = S.tick();
    ok(kinds(r) === 'pushed' && r.flags[0].unguarded && !S.blocks('to-jo.md') && !S.blocks('to-alex.md'), 'guardrail OFF: a direct push is still judged but nobody is handed it');
    ok(/pushed straight to the branch \(guardrail off\)/.test(S.Rd('company/work/security/default-branch-watch.md')) && S.out.some(l => /NOTED \(guardrail off\)/.test(l)), 'guardrail OFF: it is still logged in the report file and the tick output');
    S.W('company/state/guardrails.json', JSON.stringify({ guards: { defaultBranch: true } })); S.adv(H);
    const d2 = S.G.commit(A, [d1], 'direct push once guarded again'); S.G.move(A, d2, 'push');
    r = S.tick();
    ok(kinds(r) === 'pushed' && !r.flags[0].unguarded && S.blocks('to-jo.md') === 1, 'guardrail back ON: the next direct push is an OPEN handoff again');
  }

  { // watch add|remove: the recorded writer of the watch list
    const W = setup(); const cfgF = path.join(W.T, CONFIG_REL); W.W(CONFIG_REL, JSON.stringify({ repos: [], discover: false, watchStart: START }));
    const riskName = (W.C().roles.risk || {}).name; let e1 = null;
    try { watchCmd(W.C(), 'add', 'acme/app', { by: 'Nobody', why: 'the product repository we ship from' }); } catch (e) { e1 = e.message; }
    ok(/risk seat/.test(e1 || ''), 'watch add: refused for someone who is neither the risk seat nor the owner');
    const r = watchCmd(W.C(), 'add', 'acme/app', { by: riskName, why: 'the product repository we ship from' });
    const provRows = fs.readFileSync(path.join(W.T, 'company/state/locked/provenance.jsonl'), 'utf8');
    ok(r.ok && readJson(cfgF, {}).repos.join() === 'acme/app' && provRows.includes('"file":"' + CONFIG_REL + '"') && provRows.includes(sha256(fs.readFileSync(cfgF, 'utf8'))), 'watch add by the risk seat: written and recorded (provenance, the exact bytes)');
    ok(watchCmd(W.C(), 'add', 'acme/app', { by: riskName, why: 'the product repository we ship from' }).unchanged, 'watch add: twice is a no-op');
    let e2 = null; try { watchCmd(W.C(), 'remove', 'acme/app', { by: riskName, why: 'we stopped shipping from this one' }); } catch (e) { e2 = e.message; }
    ok(/only the owner/.test(e2 || ''), 'watch remove: loosening is the owner\'s alone');
    ok(watchCmd(W.C({ ownerShell: true }), 'remove', 'acme/app', { by: 'owner', why: 'we stopped shipping from this one' }).repos.length === 0, 'watch remove by the owner from the owner\'s shell');
  }

  // ---- owner baseline in capheos-merges.jsonl: provenance-verified baseline accepts a merged PR without local PASS; forged row does not ----
  { const S = setup(), A = 'acme/app';
    const c0 = base(S, A); S.tick(); S.adv(H);
    const f1 = S.G.commit(A, [c0], 'owner fix 1'), m1 = S.G.commit(A, [c0, f1], 'owner fix 1 (#21)', 'GitHub');
    S.G.pr(A, 21, { head: f1, mergeSha: m1, commits: [m1] }); S.G.move(A, m1, 'pr_merge');
    const mergesF = path.join(S.T, 'company/state/capheos-merges.jsonl');
    require('./lib/selfimprove').appendJsonl(mergesF, { at: new Date(S.C().now).toISOString(), kind: 'baseline', by: 'owner', repo: A, sha: m1 }, { writer: 'capheos-merge.js', root: S.T });
    let r = S.tick();
    ok(r.flags.length === 0 && !S.blocks('to-jo.md'), 'owner baseline recorded with provenance accepts merged PR without local pre-merge PASS');
    // forged (hand-appended without provenance) baseline row must still be flagged
    S.adv(H);
    const f2 = S.G.commit(A, [m1], 'unreviewed 2'), m2 = S.G.commit(A, [m1, f2], 'unreviewed 2 (#22)', 'GitHub');
    S.G.pr(A, 22, { head: f2, mergeSha: m2, commits: [m2] }); S.G.move(A, m2, 'pr_merge');
    fs.appendFileSync(mergesF, JSON.stringify({ at: new Date(S.C().now).toISOString(), kind: 'baseline', by: 'owner', repo: A, sha: m2 }) + '\n');
    r = S.tick();
    ok(kinds(r) === 'no-pass' && S.blocks('to-jo.md') === 1, 'forged capheos-merges.jsonl baseline row without provenance is still flagged as no-pass');
    // provenance-verified baseline for a different repo must not clear this repo
    S.adv(H);
    const f3 = S.G.commit(A, [m2], 'other repo 3'), m3 = S.G.commit(A, [m2, f3], 'other repo 3 (#23)', 'GitHub');
    S.G.pr(A, 23, { head: f3, mergeSha: m3, commits: [m3] }); S.G.move(A, m3, 'pr_merge');
    require('./lib/selfimprove').appendJsonl(mergesF, { at: new Date(S.C().now).toISOString(), kind: 'baseline', by: 'owner', repo: 'acme/other', sha: m3 }, { writer: 'capheos-merge.js', root: S.T });
    r = S.tick();
    ok(kinds(r) === 'no-pass', 'owner baseline for a different repo does not clear no-pass');
  }

  fs.rmSync(TMP, { recursive: true, force: true }); TZ = savedTZ;
  console.log(bad ? bad + ' FAILED' : 'all checks passed'); return bad ? 1 : 0;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'tick') { const i = rest.indexOf('--preview'); const r = tick(context({ dry: rest.includes('--dry-run'), preview: i >= 0 ? Number(rest[i + 1]) || 10 : 0 })); if (r && r.refused) { console.log('tick refused by design: a real check never runs from an agent run' + (typeof r.reason === 'string' ? ' (' + r.reason + ')' : '')); process.exit(0); } }
    else if (cmd === 'status') console.log(status(context()));
    else if (cmd === 'baseline') baseline(context());
    else if (cmd === 'watch') { const o = {}; for (let i = 2; i < rest.length; i++) if (rest[i].startsWith('--')) o[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; console.log(JSON.stringify(watchCmd(context(), rest[0], rest[1], o), null, 1)); }
    else if (cmd === 'selftest') process.exit(selftest());
    else { console.error('usage: default-branch-watch.js tick [--dry-run] [--preview N] | status | baseline | watch add|remove <owner/name> --by <Name> --why "..." | selftest'); process.exit(2); }
  } catch (e) { console.error('default-branch-watch: ' + one(e.message).slice(0, 300)); process.exit(1); }
}
