#!/usr/bin/env node
/* merge-gate.js — the company's client-side merge gate, since GitHub branch protection needs GitHub Pro on a
 * private repository. Standing owner rule: agents keep full GitHub (branches, PRs, comments, merges) but a
 * commit never lands on a repo's DEFAULT branch (main, master, or whatever the remote HEAD is, e.g. "production")
 * except by merging a PR whose current head has a recorded pre-merge PASS. The owner's own shells, the dispatcher
 * and the operator's Claude Code session are never affected — every entry point exits immediately unless the
 * caller runs under the StarNet station.
 *
 * "Agent" = the command runs under the station process: an ancestor's argv is (…/)sidecar/index.js, or an
 * ancestor's cgroup is /<station>.service (company.json station.serviceName; not /<station>-dispatch.service — the
 * dispatcher is the owner). Detection
 * fails OPEN: any doubt is treated as the owner, so a bug here can never lock the owner out.
 *
 * Exit-code contract (so a gate CRASH never locks the owner out): 0 = allowed, 2 = bad usage, 3 = REFUSED
 * (reason on stderr). Anything else — an uncaught throw, a SyntaxError in a half-written gate, node off PATH
 * (127), a broken NODE_OPTIONS — is NOT a refusal. The wrappers and hooks run the real binary / let the push
 * proceed on any status but 3, and run the gate's node with NODE_OPTIONS/NODE_PATH stripped. Only exit 3 blocks.
 *
 * Entry points (all soft gates per the contract above):
 *   ~/.local/bin/git  → `merge-gate.js check-git <git args>`   before any `git push` (incl. -C/-c prefixes, hook
 *                        overrides, --no-verify, and a user alias that expands to push). A shell ('!') git alias
 *                        whose body reaches a push is REFUSED, because git runs it with /usr/lib/git-core (the real
 *                        git) ahead on PATH, so its inner `git push` would bypass this wrapper. Refuses a push whose
 *                        dry-run targets a default branch on a github.com remote; local/file sandbox remotes are
 *                        allowed (so agents' tests run). A --dry-run push is never gated (it writes nothing).
 *   ~/.local/bin/gh   → `merge-gate.js check-gh <gh args>`     before `gh pr merge`, `gh api`, `gh repo sync`, and
 *                        any non-core first subcommand (a user alias — the gate expands it via `gh alias list` and
 *                        re-classifies; a shell gh alias that can merge/api-write/repo-sync is refused). A merge
 *                        resolves its number/url/BRANCH selector to the real PR via `gh pr view`, then requires a
 *                        PASS for that head; refuses `gh pr merge --auto`, REST/GraphQL writes onto a default
 *                        branch (glued flags -XPUT/-fk=v, full-URL endpoints, @file and --input bodies all parsed
 *                        like gh does), and `gh repo sync <remote-dest>`. --help and --disable-auto pass.
 *   <repo>/.git/hooks/pre-push → `merge-gate.js check-push <remote> <url>`  refuses a direct push to the remote's
 *                        real default branch (and main/master) for agents.
 *   node company/tools/merge-gate.js status <pr> [--repo owner/name]        print what the gh gate would decide
 *   node company/tools/merge-gate.js selftest                               build throwaway repos and prove the rules
 *
 * A `gh pr merge` is allowed only when company/tools/premerge-check.js recorded a PASS for the PR's current head
 * commit (company/work/evidence/premerge-<repo>-<sha>.json). Refusals are logged to company/work/merge-gate.log;
 * allowed feature pushes are NOT logged (the log stays small). The log line for a merge is kept.
 *
 * Guardrail: co.guard('defaultBranch') OFF (owner-only, company/tools/guardrails.js) lets every refused push/merge through
 * with exit 0 and logs it as an UNGUARDED line instead of REFUSED. Default and any unreadable state: ON.
 *
 * Env vars (TESTS ONLY, and each can only make the gate STRICTER — there is no switch that makes an agent look
 * like the owner):
 *   MERGE_GATE_ASSUME_AGENT=1     treat the caller as an agent even off-station (selftest).
 *   MERGE_GATE_PROTECT_ALL=1      treat local/file remotes as protected too (selftest; by default agents' local
 *                                 sandbox remotes are allowed so their push/merge tests can run).
 *   MERGE_GATE_LOG=<path>         redirect the refusal log (selftest; keeps the real log clean).
 *   MERGE_GATE_EVIDENCE=<dir>     where pre-merge PASS records live (tests).
 *   MERGE_GATE_LEDGER=<path>      the external-clearance ledger read by the bypass check (tests).
 *
 * THE PRE-PUSH HOOK BYPASS. A `git push --no-verify` (or `-c core.hooksPath=<dir>`) never runs the pre-push hook, so
 * there is no gate at all on that push. The check therefore lives on the `check-git` path: a github push that skips
 * the hook is REFUSED unless one live `merge-gate-bypass` row in company/state/external-clearances.jsonl names the
 * exact act (`push:<owner>/<repo>:<branch>`), covers every sha in the push, is oneShot, is unexpired, is granted by
 * the owner or the CEO, and carries a reason. The row is spent at the moment of the push (usedAt/usedBy appended), so
 * a second push against the same row is refused; a hand-written line cannot un-spend it. A row never authorises a
 * branch deletion or a non-fast-forward update of a protected branch: those are refused before any row is read.
 * A push carrying --receive-pack or --exec (a command run on the far side) is refused before any dry run, because the
 * dry run would execute it. The ledger is the ONLY artefact read. Fails open for the owner.
 *
 * Inherent limits this gate CANNOT close (same Unix user) — covered after the fact by the GitHub-side tripwire
 * company/tools/default-branch-watch.js (owned elsewhere):
 *   - /usr/bin/git or /usr/bin/gh invoked by ABSOLUTE PATH (skips both wrappers; --no-verify also skips the
 *     pre-push hook — but an absolute-path push WITHOUT --no-verify is still caught by the installed hook);
 *   - curl with the gh token; git plumbing (send-pack / receive-pack); a clone made without the pre-push hook;
 *   - a shell alias / script that reaches a push through obfuscation this gate's token scan does not recognise;
 *   - TOCTOU: check-git plans with `git push --dry-run` and then the wrapper exec's a separate `git push`; a
 *     racing same-user process could rewrite push config/refs between the two. Not reproduced; same-user and
 *     inherent to check-then-exec. All of the above land on GitHub, where the hourly tripwire reports them.
 *
 * Ownership: the tools owner (co.seatFor('tools')). Policy: the CEO. Gate/tripwire review: the risk owner.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const co = require('./lib/company');
const EVIDENCE = process.env.MERGE_GATE_EVIDENCE || co.p('company', 'work', 'evidence');
const LOG = process.env.MERGE_GATE_LOG || co.p('company', 'work', 'merge-gate.log');
const ROOT = co.ROOT;
// The external-clearance ledger a bypass row lives in, and the station's run journal (who presented a row).
const LEDGER = process.env.MERGE_GATE_LEDGER || co.p('company', 'state', 'external-clearances.jsonl');
const JOURNAL = co.p('.starnet-data', 'workspaces', '.run-journal');
const STATION_UNIT = '/' + (co.config.station.serviceName || 'capheos-station') + '.service';
const REAL_GH = '/usr/bin/gh';
const REAL_GIT = '/usr/bin/git';
// No repo is baked in: when neither --repo, a PR url nor the cwd's origin names one, a merge is refused (agents only).
const DEFAULT_REPO = null;

// ── who is calling ────────────────────────────────────────────────────────────────────────────────────────
// An ancestor whose argv is the station (sidecar/index.js) or whose cgroup is the station unit. Any read error
// returns false (fail open → owner). /<station>-dispatch.service does NOT contain "/<station>.service", so the
// dispatcher and the backup timer stay owner, exactly as required.
function underStation() {
  let pid = process.ppid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
      if (cmd.split('\0').some(a => a === 'sidecar/index.js' || a.endsWith('/sidecar/index.js'))) return true;
      try { if (fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8').includes(STATION_UNIT)) return true; } catch (_) {}
      const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      pid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
    } catch (_) { return false; }
  }
  return false;
}
const isAgent = () => process.env.MERGE_GATE_ASSUME_AGENT === '1' || underStation();
const protectAll = () => process.env.MERGE_GATE_PROTECT_ALL === '1';

// Exit codes form a contract the wrappers/hooks rely on so a gate CRASH never blocks the owner:
//   0 = allowed, 2 = bad usage, 3 = REFUSED. Anything else (an uncaught throw, 127 node-not-found,
//   a SyntaxError in a half-written gate, a broken NODE_OPTIONS) is NOT a refusal — the wrappers run
//   the real binary and the hooks let the push through (soft gate). Only exit 3 blocks.
const REFUSE = 3;
const log = line => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {} };
// Guardrail defaultBranch (company/tools/guardrails.js, owner-only): OFF turns every refusal into an allow that is still
// logged (UNGUARDED lines in the gate log) and said on stderr. Read per refusal through co.guard, so a missing or broken
// state file keeps the gate ON (fail closed); no environment variable can switch it off.
const refuse = msg => {
  if (!co.guard('defaultBranch')) {
    log('UNGUARDED (guardrail defaultBranch is OFF) allowed: ' + msg);
    console.error('merge-gate: the defaultBranch guardrail is OFF (the owner\'s switch), so this is allowed and logged: ' + msg);
    process.exit(0);
  }
  log('REFUSED ' + msg); console.error('merge-gate: ' + msg); process.exit(REFUSE);
};

// ── shared helpers ────────────────────────────────────────────────────────────────────────────────────────
function git(gopts, rest, opts) {
  return execFileSync(REAL_GIT, [...gopts, ...rest],
    Object.assign({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }, opts || {}));
}
// A URL that points at github.com, in https or ssh/scp form.
const isGithub = u => /(^|@|\/\/)github\.com[:/]/.test(u || '') || /^git@github\.com:/.test(u || '');
function shsplit(s) { const out = []; const re = /'([^']*)'|"([^"]*)"|(\S+)/g; let m; while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]); return out; }
const shortRef = r => r.replace(/^refs\/heads\//, '');
function isProtectedRef(toRef, def) {
  if (!/^refs\/heads\//.test(toRef)) return false;           // tags and other namespaces are never the issue
  const s = shortRef(toRef);
  return s === 'main' || s === 'master' || (def && s === def);
}

// ── pre-merge PASS record (gh pr merge) ───────────────────────────────────────────────────────────────────
function passFor(repo, sha) {
  const f = path.join(EVIDENCE, 'premerge-' + repo.split('/').pop() + '-' + sha + '.json');
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { ok: false, why: 'no pre-merge record for head ' + sha.slice(0, 8) }; }
  if (d.sha !== sha) return { ok: false, why: 'the record is for another commit' };
  const passed = d.verdict === 'PASS' || (Array.isArray(d.history) && d.history.some(h => h && h.verdict === 'PASS' && (!h.sha || h.sha === sha)));
  return passed ? { ok: true } : { ok: false, why: 'the pre-merge check did not pass for head ' + sha.slice(0, 8) + ' (verdict ' + d.verdict + ')' };
}
function repoFromArgs(args) {
  const i = args.findIndex(a => a === '-R' || a === '--repo');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith('--repo='));
  if (eq) return eq.slice(7);
  const url = args.find(a => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(a));
  if (url) return url.match(/github\.com\/([^/]+\/[^/]+)\/pull/)[1];
  try {
    const remote = execFileSync(REAL_GIT, ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/); if (m) return m[1];
  } catch (_) {}
  return DEFAULT_REPO;
}
const repoExplicit = args => args.some(a => a === '-R' || a === '--repo' || a.startsWith('--repo=') || /\/pull\/\d+/.test(a));
// The positional PR selector gh accepts: `gh pr merge [<number> | <url> | <branch>]`. Returns the raw token
// (a number, a /pull/N url, OR a branch name) so headOf() can resolve the SAME PR gh would, not the PR of the
// agent's current checkout. Returns null only when no positional selector is present (merge current branch).
function prSelectorFromArgs(args) {
  const rest = args.slice(args.indexOf('merge') + 1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (/^(-R|--repo|-t|--subject|-b|--body|-F|--body-file|-A|--author-email|--match-head-commit)$/.test(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}
// Resolve a selector (number / url / branch) to the PR's head via gh itself, so we validate the PASS for the
// PR gh will actually merge. --repo is honored whenever a selector or an explicit --repo is present.
function headOf(repo, selector, withRepo) {
  const a = ['pr', 'view'];
  if (selector) a.push(selector);
  if (withRepo && repo) a.push('--repo', repo);
  a.push('--json', 'headRefOid,number', '-q', '.headRefOid + " " + (.number|tostring)');
  const [sha, num] = execFileSync(REAL_GH, a, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(' ');
  return { sha, pr: Number(num) };
}

// ── gh api / graphql / repo sync write decisions (pure; default branch injected so tests need no network) ─────
// A GitHub REST request mutates when its method is not GET/HEAD, or when a body field (-f/-F/--field/--raw-field/
// --input) is given (gh then defaults to POST). We refuse only the writes that land on a default branch.
// gh -F/--field expands @file (and @- = stdin) into the value; -f/--raw-field keeps it literal. Returns the
// text, or marks it unreadable (stdin, or a file we cannot read) so the caller can fail safe.
function readAt(val) {
  if (val === '@-') return { unreadable: true };
  if (val[0] === '@') { try { return { value: fs.readFileSync(val.slice(1), 'utf8') }; } catch (_) { return { unreadable: true }; } }
  return { value: val };
}
// Parse `gh api` args the way gh does, closing the holes a partial grammar leaves: glued short method (-XPUT,
// -X=PUT), glued short fields (-fk=v, -Fk=v), @file / @- field values, and a --input JSON/stdin body whose keys
// (branch, ref, …) we fold into fields. bodyUnreadable is set when a body came from stdin or an unreadable file,
// so a write whose target we cannot see is refused rather than waved through.
function parseGhApi(apiArgs) {
  const VAL = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache']);
  let method = null, endpoint = null, hasBody = false, bodyUnreadable = false; const fields = {};
  const setField = (raw, expand) => {
    hasBody = true; const e = raw.indexOf('='); if (e < 0) return;
    const key = raw.slice(0, e); let v = raw.slice(e + 1);
    if (expand) { const r = readAt(v); if (r.unreadable) { bodyUnreadable = true; return; } v = r.value; }
    fields[key] = v;
  };
  for (let i = 0; i < apiArgs.length; i++) {
    const a = apiArgs[i];
    if (a === '-X' || a === '--method') { method = apiArgs[++i]; continue; }
    if (a.startsWith('--method=')) { method = a.slice(9); continue; }
    if (a.startsWith('-X=')) { method = a.slice(3); continue; }
    if (a.startsWith('-X') && a.length > 2) { method = a.slice(2); continue; }     // -XPUT
    if (a === '-f' || a === '--raw-field') { setField(apiArgs[++i] || '', false); continue; }
    if (a === '-F' || a === '--field') { setField(apiArgs[++i] || '', true); continue; }
    if (a.startsWith('--raw-field=')) { setField(a.slice(12), false); continue; }
    if (a.startsWith('--field=')) { setField(a.slice(8), true); continue; }
    if (a.startsWith('-f') && a.length > 2) { setField(a.slice(2), false); continue; }   // -fk=v
    if (a.startsWith('-F') && a.length > 2) { setField(a.slice(2), true); continue; }    // -Fk=v
    if (a === '--input' || a.startsWith('--input=')) {
      hasBody = true;
      const f = a === '--input' ? (apiArgs[++i] || '') : a.slice(8);
      if (f === '-' || f === '') { bodyUnreadable = true; continue; }
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && typeof j === 'object') for (const k of Object.keys(j)) fields[k] = typeof j[k] === 'string' ? j[k] : JSON.stringify(j[k]); }
      catch (_) { bodyUnreadable = true; }
      continue;
    }
    if (VAL.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (endpoint === null) endpoint = a;
  }
  return { method: (method || (hasBody ? 'POST' : 'GET')).toUpperCase(), endpoint: endpoint || '', hasBody, bodyUnreadable, fields };
}
// resolveDefault(owner, repo) → the repo's default branch (string) or null.
function ghApiDecision(apiArgs, resolveDefault) {
  const { method, endpoint, fields, bodyUnreadable } = parseGhApi(apiArgs);
  if (!endpoint) return { refuse: false };
  // Normalize: drop a leading scheme+host (full URL: https://api.github.com/…, or a GHE host), a GHE /api/vN/
  // prefix, leading slashes and any query string, so the `repos/…` matchers below see the same path gh dials.
  const ep = endpoint.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/+/, '').replace(/^api\/v\d+\//, '').replace(/\?.*$/, '');

  if (ep === 'graphql') {                                                        // graphql is always a POST
    const q = fields.query || '';
    if (!q && bodyUnreadable)
      return { refuse: true, reason: 'a GraphQL body read from stdin/@- cannot be screened for a merge or default-branch mutation' };
    for (const n of ['mergePullRequest', 'enablePullRequestAutoMerge'])
      if (new RegExp('\\b' + n + '\\b').test(q)) return { refuse: true, reason: 'GraphQL ' + n + ' would merge/auto-merge a pull request outside the pre-merge gate' };
    const hit = ['updateRef', 'updateRefs', 'createCommitOnBranch', 'deleteRef'].find(n => new RegExp('\\b' + n + '\\b').test(q));
    if (hit) {
      // Best effort: refuse only when a BRANCH VALUE in the mutation is a default branch, so a commit to
      // fix/main-menu, or a headline that merely says "main", is allowed. The hourly tripwire backs this up.
      if (/branchName\s*:\s*"(main|master)"/.test(q) || /(?:name|qualifiedName)\s*:\s*"refs\/heads\/(main|master)"/.test(q))
        return { refuse: true, reason: 'GraphQL ' + hit + ' targets a default branch (best effort; the hourly tripwire backs this up)' };
      return { refuse: false, note: 'graphql-' + hit + '-allowed-not-default' };
    }
    return { refuse: false };
  }

  if (method === 'GET' || method === 'HEAD') return { refuse: false };          // reads are always fine

  let m;
  if (ep.match(/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/)) return { refuse: true, reason: 'the REST merge endpoint bypasses the pre-merge gate; merge with `gh pr merge` after a PASS' };
  if (ep.match(/^repos\/[^/]+\/[^/]+\/merges$/)) return { refuse: true, reason: 'POST /repos/.../merges lands a merge commit on a branch outside the gate' };

  if ((m = ep.match(/^repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/))) {
    if (method === 'PATCH' || method === 'DELETE') {
      const br = m[3]; const def = resolveDefault(m[1], m[2]);
      if (br === 'main' || br === 'master' || (def && br === def)) return { refuse: true, reason: method + ' git/refs/heads/' + br + ' moves/deletes the default branch outside the gate' };
    }
    return { refuse: false };
  }
  if ((m = ep.match(/^repos\/([^/]+)\/([^/]+)\/git\/refs$/)) && method === 'POST') {
    if (bodyUnreadable) return { refuse: true, reason: 'POST git/refs with a body from stdin/@- cannot be screened for the ref it creates' };
    const ref = (fields.ref || '').replace(/^refs\/heads\//, ''); const def = resolveDefault(m[1], m[2]);
    if (ref === 'main' || ref === 'master' || (def && ref === def)) return { refuse: true, reason: 'POST git/refs creating refs/heads/' + ref + ' would overwrite/seed the default branch' };
    return { refuse: false };
  }
  if ((m = ep.match(/^repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/)) && (method === 'PUT' || method === 'DELETE')) {
    const br = fields.branch;
    if (bodyUnreadable && !br) return { refuse: true, reason: method + ' contents/' + m[3] + ' with a body from stdin/@- cannot be screened for its target branch' };
    const def = resolveDefault(m[1], m[2]);
    if (!br || br === 'main' || br === 'master' || (def && br === def)) return { refuse: true, reason: method + ' contents/' + m[3] + (br ? ' on ' + br : ' with no branch field') + ' commits onto the default branch outside the gate' };
    return { refuse: false };
  }
  return { refuse: false };
}
// `gh repo sync [<dest>]`: a destination repo argument syncs a REMOTE repo's branch (its default by default) — refuse.
function repoSyncDecision(args) {
  const i = args.indexOf('sync');
  const rest = args.slice(i + 1);
  const VAL = new Set(['-b', '--branch', '-s', '--source', '-R', '--repo']);
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (VAL.has(a)) { j++; continue; }
    if (a.includes('=')) continue;
    if (a.startsWith('-')) continue;
    return { refuse: true, reason: 'gh repo sync ' + a + ' force-updates a branch on a remote repository outside the gate; sync your local checkout (no destination arg) instead' };
  }
  return { refuse: false };
}
// default branch for gh writes: one `gh api repos/<o>/<r>` GET, cached per process.
const _dbCache = {};
function resolveDefaultBranch(owner, repo) {
  const k = owner + '/' + repo;
  if (k in _dbCache) return _dbCache[k];
  try { return (_dbCache[k] = execFileSync(REAL_GH, ['api', 'repos/' + k, '-q', '.default_branch'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null); }
  catch (_) { return (_dbCache[k] = null); }
}

// ── gh alias expansion (so `gh alias set pm 'pr merge'; gh pm 5` cannot route around the gate) ───────────────
// gh expands a user alias in-process AFTER the thin ~/.local/bin/gh wrapper has already exec'd it, so the wrapper
// only ever sees the alias NAME. The wrapper routes any non-core first subcommand here; this expands it the way
// gh does and re-derives the pr-merge / api / repo-sync classification. The real gh core command set (gh forbids
// an alias from shadowing one), so anything else is an alias or an unknown command.
const GH_CORE = new Set(('auth browse codespace discussion gist issue org pr project release repo skill cache run ' +
  'workflow agent-task alias api attestation completion config copilot extension gpg-key label licenses preview ' +
  'ruleset search secret ssh-key status variable accessibility actions environment help version').split(' '));
function ghAliases() {
  try {
    const out = execFileSync(REAL_GH, ['alias', 'list'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
    // `gh alias list` prints `name: expansion`, and wraps a shell ('!') expansion in single quotes — strip them
    // so the leading '!' is visible to expandGhAlias.
    const unquote = s => (/^'(.*)'$/.test(s) || /^"(.*)"$/.test(s)) ? s.slice(1, -1) : s;
    const map = {}; for (const l of out.split('\n')) { const m = l.match(/^([A-Za-z0-9_-]+):\s+(.*)$/); if (m) map[m[1]] = unquote(m[2]); }
    return map;
  } catch (_) { return {}; }
}
// → { args: [...] }   args with the leading alias expanded (classify these)
// → { refuse: msg }   a shell ('!') alias that can merge / write via the API / sync a remote repo
// → null              a core command, an unknown command, or a harmless shell alias — nothing to change
function expandGhAlias(argv, depth) {
  if (depth > 10) return null;
  const si = argv.findIndex(a => !a.startsWith('-'));
  if (si < 0) return null;
  const sub = argv[si];
  if (GH_CORE.has(sub)) return null;
  const exp = ghAliases()[sub];
  if (!exp) return null;                                           // unknown command — gh will error; not ours
  if (exp[0] === '!') {
    const body = exp.slice(1);
    if (/\bpr\s+merge\b/.test(body) || /\brepo\s+sync\b/.test(body) ||
        (/\bapi\b/.test(body) && /(-X|--method|\bPUT\b|\bPOST\b|\bPATCH\b|\bDELETE\b|graphql|pulls\/\d+\/merge|\/merges\b|git\/refs|\/contents\/)/i.test(body)))
      return { refuse: "a shell gh alias ('!' …) that can merge a PR, write via the API, or sync a remote repo cannot be screened; use `gh pr merge` after a PASS, or the branch → PR flow." };
    return null;                                                  // a shell alias that does none of these — fine
  }
  const toks = shsplit(exp);
  const after = argv.slice(si + 1);
  const hasPh = toks.some(t => /\$\d+/.test(t));
  const consumed = new Set();
  const head = toks.map(t => { const m = t.match(/^\$(\d+)$/); if (m) { consumed.add(Number(m[1])); return after[Number(m[1]) - 1] || ''; } return t; }).filter(Boolean);
  const tail = hasPh ? after.filter((_, i) => !consumed.has(i + 1)) : after;
  const expanded = argv.slice(0, si).concat(head, tail);
  return expandGhAlias(expanded, depth + 1) || { args: expanded };
}

// ── git push analysis (check-git) ─────────────────────────────────────────────────────────────────────────
// Global git options that consume the NEXT argument (so we don't mistake their value for the subcommand).
const GIT_VAL_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source', '--shallow-file', '--exec-path']);
// Split <global opts> <subcommand> <rest>. Returns {gopts, sub, rest} (sub null if none).
function splitGit(argv) {
  const gopts = []; let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (GIT_VAL_OPTS.has(a)) { gopts.push(a, argv[i + 1]); i++; continue; }
    if (a.startsWith('-')) { gopts.push(a); continue; }       // inline-value or boolean global flag
    return { gopts, sub: a, rest: argv.slice(i + 1) };
  }
  return { gopts, sub: null, rest: [] };
}
function gitAlias(name, gopts) {
  try { return git(gopts, ['config', '--get', 'alias.' + name]).trim(); } catch (_) { return ''; }
}
// A word that reaches a push on a git command line (push, or the send-pack plumbing it drives).
const PUSHY = /(^|[^\w-])(push|send-pack)([^\w-]|$)/;
// Resolve a subcommand through the alias chain.
//   → { push: <args array> }      resolves to a real `git push`
//   → { shell: <alias body> }     hit a shell (!) alias; its body is arbitrary shell we cannot re-plan
//   → null                        not a push
// A shell alias is NOT assumed safe: when git runs a `!` alias it prepends its exec-path
// (/usr/lib/git-core, where `git` is the real binary) to PATH, so an inner `git push` inside the alias
// resolves to /usr/bin/git, bypassing this wrapper. check-git screens the body instead.
function resolveToPush(sub, extra, gopts, depth) {
  if (!sub || depth > 10) return null;
  if (sub === 'push') return { push: extra };
  const exp = gitAlias(sub, gopts);
  if (!exp) return null;                      // a builtin that is not push, or unknown — not our business
  if (exp[0] === '!') return { shell: exp.slice(1) };
  const toks = shsplit(exp);
  return resolveToPush(toks[0], toks.slice(1).concat(extra), gopts, depth + 1);
}
// The remote named on a push command line (first bareword after push options), or null for the default remote.
function pushRemote(pushArgs) {
  const VAL = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
  for (let i = 0; i < pushArgs.length; i++) {
    const a = pushArgs[i];
    if (VAL.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}
// Flags that make git run a command on the far side of the transport: --receive-pack names the program git runs
// there, --exec names a command it runs there. No clearance row can authorise that, and the gate's own dry-run
// would RUN it: `git push --dry-run --receive-pack='sh -c …'` executes the command before the gate could refuse
// the push. So these are refused before any plan is read.
function commandTransportFlags(pushArgs) {
  const out = [];
  for (const a of pushArgs) {
    if (a === '--receive-pack' || a.startsWith('--receive-pack=')) out.push('--receive-pack');
    else if (a === '--exec' || a.startsWith('--exec=')) out.push('--exec');
  }
  return out;
}
function defaultBranchForPush(gopts, remote, dest) {
  if (remote) { try { const r = git(gopts, ['symbolic-ref', 'refs/remotes/' + remote + '/HEAD']).trim(); if (r) return r.replace('refs/remotes/' + remote + '/', ''); } catch (_) {} }
  const target = dest || remote;
  if (target) { try { const r = git(gopts, ['ls-remote', '--symref', target, 'HEAD']); const m = r.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m); if (m) return m[1]; } catch (_) {} }
  return null;
}
// The push plan, read from git itself: which refs move, and to where. A --dry-run plan writes nothing, so this is
// safe to run before the real push (and it is also what the --no-verify check reads its acts and shas from).
function planPush(gopts, pushArgs) {
  // Build the args for our own machine-readable dry-run. We always force --no-verify (so a repo hook / test
  // suite does not run during our probe and again on the real push), dropping any caller --verify/--no-verify
  // that would otherwise override it. We force --no-quiet so a caller's -q cannot blank the porcelain lines,
  // spliced in BEFORE any `--` so git does not read it as a refspec (a bare `git push origin -- feat` must
  // still be screened, not fail to parse).
  const userDry = pushArgs.filter(a => a !== '--verify' && a !== '--no-verify');
  // A command carrier never goes into our dry run, even if the refusal above were ever bypassed.
  const dryArgs = [];
  for (let i = 0; i < userDry.length; i++) {
    const a = userDry[i];
    if (a === '--receive-pack' || a === '--exec') { i++; continue; }
    if (a.startsWith('--receive-pack=') || a.startsWith('--exec=')) continue;
    dryArgs.push(a);
  }
  userDry.length = 0;
  userDry.push(...dryArgs);
  const dd = userDry.indexOf('--');
  if (dd >= 0) userDry.splice(dd, 0, '--no-quiet'); else userDry.push('--no-quiet');
  const dry = [...gopts, 'push', '--dry-run', '--porcelain', '--no-verify', ...userDry];
  let out = '', err = '', code = 0;
  try { out = execFileSync(REAL_GIT, dry, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); }
  catch (e) { out = e.stdout || ''; err = (e.stderr || '').toString(); code = e.status == null ? 1 : e.status; }

  const lines = out.split('\n');
  const toLine = lines.find(l => l.startsWith('To '));
  const remote = pushRemote(pushArgs);
  const dest = toLine ? toLine.slice(3).trim() : null;
  const github = isGithub(dest) || isGithub(remote) || (remote && (() => { try { return isGithub(git(gopts, ['remote', 'get-url', remote]).trim()); } catch (_) { return false; } })());

  const updates = [];                       // {flag, from, to}
  for (const l of lines) {
    const m = l.match(/^(.)\t([^\t]*)\t/);
    if (!m) continue;
    const flag = m[1], spec = m[2];
    if (flag === ' ' || flag === '+' || flag === '-' || flag === '*') updates.push({ flag, from: spec.split(':')[0], to: spec.split(':').pop() });
  }
  return { out, err, code, lines, remote, dest, github, updates };
}

function checkPush(gopts, pushArgs, plan) {
  // A --dry-run push writes nothing, so there is nothing to gate — let git run it and report.
  if (pushArgs.includes('-n') || pushArgs.includes('--dry-run')) process.exit(0);
  const { out, err, code, lines, github, updates, remote, dest } = plan || planPush(gopts, pushArgs);

  if (!updates.length) {
    // tags-only / up-to-date-only / rejected-only are harmless. Only refuse when we truly could not read the plan
    // for a github.com remote (fail closed for agents only; local sandboxes are never fail-closed).
    const sawAnyStatus = lines.some(l => /^(.)\t[^\t]*\t/.test(l)) || /\bDone\b/.test(out);
    if (github && code !== 0 && !sawAnyStatus)
      // We could not get a push plan from git for a github.com remote, so we cannot tell a default-branch push
      // from a feature push: fail closed (agents retry). This also catches a plain git usage error (e.g. a bad
      // refspec) — we surface git's own message rather than inventing a "feature branch" hint that may mislead.
      refuse('git could not plan this push to a github.com remote, so the gate cannot verify its target (' +
        (err.split('\n').find(Boolean) || 'git exited ' + code).slice(0, 160) + '). Fix the push or retry; nothing was pushed.');
    process.exit(0);
  }

  const def = defaultBranchForPush(gopts, remote, dest);
  const bad = updates.filter(u => isProtectedRef(u.to, def));
  if (!bad.length) process.exit(0);         // feature-branch / tag pushes: allowed, not logged

  if (github || protectAll()) {
    const names = [...new Set(bad.map(u => shortRef(u.to)))].join(', ');
    refuse('agents may not push to the default branch (' + names + ') of ' + (dest || remote || 'this remote') +
      '. Push your work to a feature branch, open a PR (`gh pr create`), run `node company/tools/premerge-check.js --pr <n> --repo <owner/name>`, then merge with `gh pr merge` once it PASSes.');
  }
  process.exit(0);                           // local/file sandbox remote, not in protect-all mode: allowed
}

// ── the pre-push hook bypass (--no-verify) ────────────────────────────────────────────────────────────────
// Five behaviours: no live matching row →
// refuse; expired or oneShot spent → refuse; a sha outside covers.commits → refuse; the use writes usedAt/usedBy
// onto the row; and the ledger is the ONLY artefact read. The act is `push:<owner>/<repo>:<branch>` and an empty
// acts list authorises nothing.
const BYPASS_KIND = 'merge-gate-bypass';
const BYPASS_FIELDS = ['id', 'kind', 'acts', 'repo', 'branch', 'covers', 'grantedBy', 'grantedAt', 'expiresAt',
  'oneShot', 'usedAt', 'usedBy', 'reason'];
// Who may grant a bypass: the owner and the CEO seat (by the company's own config), never another agent. An agent may
// not write grantedBy; the names are read at use, so a hired CEO is recognised without a code change.
function granters() {
  const out = new Set();
  const add = v => { const t = String(v || '').trim().toLowerCase(); if (t) out.add(t); };
  add(co.config.owner && co.config.owner.name);
  try { const id = co.ceo(); add(id); add(co.nameOf(id)); } catch (_) {}
  return out;
}

// The two command-line routes that stop the pre-push hook from running. `-c core.hooksPath=` is the same door as
// --no-verify (it points git at a directory with no hook in it), so it needs the same row: a rule a sibling flag
// walks around is not a rule.
function hookSkip(gopts, pushArgs) {
  if (pushArgs.includes('--no-verify')) return { skip: true, how: '--no-verify' };
  for (let i = 0; i < gopts.length; i++) {
    const a = gopts[i];
    const v = a === '-c' ? gopts[i + 1] : (a.startsWith('-c') && a.length > 2 ? a.slice(2) : null);
    if (v && /^core\.hooksPath=/.test(v)) return { skip: true, how: '-c core.hooksPath' };
  }
  return { skip: false };
}

// Who presented the row: the agentId of the live station run, read from the run journal (the same source
// external-gate.js trusts). An unreadable journal is recorded as "unknown" — it never blocks an already-cleared
// push, and the timestamp of the use still lands.
function presenter() {
  if (process.env.STARNET_AGENT_ID) return { agent: process.env.STARNET_AGENT_ID, runId: process.env.STARNET_RUN_ID || '' };
  let best = null;
  try {
    for (const f of fs.readdirSync(JOURNAL)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(JOURNAL, f);
      let st; try { st = fs.statSync(p); } catch (_) { continue; }
      if (Date.now() - st.mtimeMs > 15 * 60 * 1000) continue;                  // a live run writes inside 15 min
      if (!best || st.mtimeMs > best.m) best = { m: st.mtimeMs, p };
    }
  } catch (_) { return { agent: 'unknown', runId: '' }; }
  if (!best) return { agent: 'unknown', runId: '' };
  try {
    const b = JSON.parse(fs.readFileSync(best.p, 'utf8').split('\n')[0]);
    const pl = (b && b.payload) || {};
    return { agent: String(pl.agentId || 'unknown'), runId: String(pl.runId || (b && b.runId) || '') };
  } catch (_) { return { agent: 'unknown', runId: '' }; }
}

// The ledger is append-only, so the current state of a row is its LAST line carrying that id — the convention
// external-gate.js already uses (a close/use appends the same row again with the delta fields on it).
function bypassRows() {
  let txt; try { txt = fs.readFileSync(LEDGER, 'utf8'); } catch (_) { return []; }
  const byId = new Map();
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || r.kind !== BYPASS_KIND || !r.id) continue;
    // The spend is sticky. The ledger is a file every agent on this uid can append
    // to, so "the last line wins" let a hand-written line with usedAt:null re-open a row that had been spent — the
    // oneShot rule undone by a keystroke. A later line may add fields; it may not clear the use.
    const prev = byId.get(r.id);
    if (prev && prev.usedAt) r = Object.assign({}, r, { usedAt: prev.usedAt, usedBy: prev.usedBy });
    byId.set(r.id, r);
  }
  return [...byId.values()];
}
// Why this row cannot authorise anything, or null when it is live. Every rule returns a sentence a reader can act
// on: a refusal that only says "no" teaches nobody how to write the row.
function rowWhy(r, at) {
  for (const f of BYPASS_FIELDS) if (!(f in r)) return 'row ' + r.id + ' is missing ' + f + ' (a row missing a field is not a row)';
  if (!Array.isArray(r.acts) || !r.acts.length) return 'row ' + r.id + ' has an empty acts list (a category name is not an act)';
  if (r.oneShot !== true) return 'row ' + r.id + ' is not oneShot (a standing bypass row is a standing hole)';
  if (!granters().has(String(r.grantedBy || '').trim().toLowerCase()))
    return 'row ' + r.id + ' is grantedBy ' + JSON.stringify(r.grantedBy) + '; only the owner or the CEO may grant a bypass, and no agent may write this field';
  if (!r.covers || typeof r.covers !== 'object' || !Array.isArray(r.covers.commits)) return 'row ' + r.id + ' has no covers.commits list';
  const exp = Date.parse(r.expiresAt);
  if (!Number.isFinite(exp)) return 'row ' + r.id + ' has an unreadable expiresAt ' + JSON.stringify(r.expiresAt);
  if (exp <= at) return 'row ' + r.id + ' expired at ' + r.expiresAt;
  if (r.usedAt) return 'row ' + r.id + ' was spent at ' + r.usedAt + (r.usedBy ? ' by ' + r.usedBy : '') + ' (oneShot)';
  const reason = String(r.reason || '').trim();
  if (!reason) return 'row ' + r.id + ' carries no reason';
  if (/^approved( by)?\b/i.test(reason)) return 'row ' + r.id + ' reason is ' + JSON.stringify(r.reason) + ', which is not something a reader can check a year later';
  return null;
}
// The repo slug a github remote URL names, or null. `https://github.com/o/r.git`, `git@github.com:o/r.git` and a
// local path that literally contains `//github.com/o/r.git` (the selftest's network-free github remote) all answer.
function repoSlug(gopts, remote, dest) {
  const urls = [];
  if (dest) urls.push(dest);
  if (remote) { try { urls.push(git(gopts, ['remote', 'get-url', remote]).trim()); } catch (_) {} urls.push(remote); }
  for (const u of urls) {
    const m = String(u || '').match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
    if (m) return m[1] + '/' + m[2];
  }
  return null;
}
// The acts and commit shas this push actually carries. shas === null means git could not tell us, which is a
// refusal (a row cannot be shown to cover a set we cannot read).
function pushCoverage(gopts, plan) {
  const repo = repoSlug(gopts, plan.remote, plan.dest);
  const notRemote = plan.remote && !/[:/]/.test(plan.remote) ? '--remotes=' + plan.remote : '--remotes';
  const items = [];
  for (const u of plan.updates) {
    const branch = shortRef(u.to);
    let shas = [];
    if (u.flag !== '-' && u.from) {                       // a branch deletion carries no commits
      try {
        const sha = git(gopts, ['rev-parse', '--verify', u.from + '^{commit}']).trim();
        shas = git(gopts, ['rev-list', sha, '--not', notRemote], { timeout: 120000 }).trim().split('\n').filter(Boolean);
      } catch (_) { shas = null; }
    }
    items.push({ branch, act: repo ? 'push:' + repo + ':' + branch : null, shas });
  }
  return { repo, items };
}
// The SHAPE of the push, read from git's own plan rather than from a row.
// A clearance row names the commits it clears; it never authorises a branch to be deleted or to move backwards.
// Those two facts are therefore read before any row is consulted, because a refusal that says "no row covers
// this" would be a lie about a push no row can ever cover.
function pushShape(gopts, plan) {
  const def = defaultBranchForPush(gopts, plan.remote, plan.dest);
  const items = [];
  for (const u of plan.updates) {
    items.push({
      branch: shortRef(u.to),
      flag: u.flag,
      deleted: u.flag === '-',
      protectedRef: isProtectedRef(u.to, def),
      fastForward: isFastForward(gopts, plan, u)
    });
  }
  return { def, items };
}
// Whether this update moves the branch forward. git's porcelain flag is the primary signal ('+' is a forced
// update); the remote-tracking ref is the backstop behind it, because the next flag is not the last one.
function isFastForward(gopts, plan, u) {
  if (u.flag === '+') return false;
  if (u.flag === '-' || u.flag === '*') return true;      // a deletion and a creation carry no ancestry question
  if (!plan.remote || !u.from) return true;
  let remoteTip = null, newTip = null;
  try { remoteTip = git(gopts, ['rev-parse', '--verify', 'refs/remotes/' + plan.remote + '/' + shortRef(u.to) + '^{commit}']).trim(); } catch (_) {}
  try { newTip = git(gopts, ['rev-parse', '--verify', u.from + '^{commit}']).trim(); } catch (_) {}
  if (!remoteTip || !newTip) return true;                 // nothing to compare: git already said fast-forward
  try {
    execFileSync(REAL_GIT, [...gopts, 'merge-base', '--is-ancestor', remoteTip, newTip], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.status === 1 ? false : true;                 // 1 = not an ancestor; any other status is unknown, not a verdict
  }
}
// → { allow: { row, acts, commits } }  a live row covers every act and every sha of this push
// → { refuse: <sentence> }             nothing does, and the sentence says why each candidate row did not
function bypassDecision(gopts, plan) {
  // The shape first, and refused outright: a row is a clearance to push the commits it names,
  // never a clearance to move a branch.
  const shape = pushShape(gopts, plan);
  for (const s of shape.items) {
    if (s.deleted)
      return { refuse: 'a deletion of ' + s.branch + ' is not something a clearance row can authorise: a row names the commits it clears, and a branch deletion carries none. Delete the branch without --no-verify, or push the commits the row names.' };
    if (s.protectedRef && !s.fastForward)
      return { refuse: 'a forced update of ' + s.branch + ' moves that branch backwards, and a clearance row can clear the commits it names — not the branch itself. Merge the commits you need through a pull request instead of rewriting ' + s.branch + '.' };
  }
  const cov = pushCoverage(gopts, plan);
  if (!cov.repo)
    return { refuse: 'a --no-verify push needs a merge-gate-bypass row naming its act, and the target ' +
      (plan.dest || plan.remote || '(unknown)') + ' is not a github <owner>/<repo> remote, so no row can name it. Push without --no-verify.' };
  const why = [];
  for (const r of bypassRows()) {
    const bad = rowWhy(r, Date.now());
    if (bad) { why.push(bad); continue; }
    const uncoveredActs = cov.items.filter(i => !r.acts.includes(i.act));
    if (uncoveredActs.length) { why.push('row ' + r.id + ' does not list ' + uncoveredActs.map(i => i.act).join(', ')); continue; }
    const covered = r.covers.commits.map(s => String(s).toLowerCase());
    const outside = [];
    const empties = [];
    for (const i of cov.items) {
      if (i.shas === null) { outside.push('git could not list the commits of ' + i.act); continue; }
      // A push that carries no commit is "nothing to check", and nothing to check used to pass vacuously — which is
      // how a rewind of the default branch sailed through. It is a decision, so it needs a name on it:
      // covers.empty in the row.
      if (!i.shas.length) { empties.push(i.act); continue; }
      for (const s of i.shas) if (!covered.some(c => c.length >= 7 && s.toLowerCase().startsWith(c))) outside.push(s.slice(0, 12) + ' on ' + i.branch);
    }
    if (empties.length && r.covers.empty !== true) {
      why.push('row ' + r.id + ' does not clear an empty commit set on ' + empties.join(', ') + ' (a push that carries no commit is a decision with a name on it: the row has to say covers.empty)');
      continue;
    }
    if (outside.length) { why.push('row ' + r.id + ' does not cover ' + outside.slice(0, 5).join(', ')); continue; }
    return { allow: { row: r, acts: cov.items.map(i => i.act), commits: cov.items.flatMap(i => i.shas || []) } };
  }
  return { refuse: 'a push with --no-verify skips the pre-push hook, so no gate would see it, and no live merge-gate-bypass row in ' +
    path.relative(ROOT, LEDGER) + ' covers this push' +
    (cov.items.length ? ' (' + cov.items.map(i => i.act || i.branch).join(', ') + ')' : '') + '.' +
    (why.length ? ' Why each row did not answer: ' + why.slice(0, 4).join('; ') + '.' : ' No row of that kind exists.') +
    ' A bypass is granted by the owner or the CEO as a clearance row (kind merge-gate-bypass; the fields are listed in merge-gate.js);' +
    ' a release-evidence file, a log line or a handoff note is not an exception. Push without --no-verify to use the pre-push hook.' };
}
// The use is the audit trail: the row is spent by appending it again with usedAt/usedBy on it. If that cannot be
// written the push is refused, because an unrecorded use is not a clearance.
function recordBypassUse(allow, how) {
  const who = presenter();
  const spent = Object.assign({}, allow.row, {
    usedAt: new Date().toISOString(),
    usedBy: who.agent + (who.runId ? ' / run ' + who.runId : ''),
    usedHow: how, usedActs: allow.acts, usedCommits: allow.commits
  });
  try { fs.appendFileSync(LEDGER, JSON.stringify(spent) + '\n', { mode: 0o600 }); }
  catch (e) {
    return 'the clearance row ' + allow.row.id + ' could not be marked used in ' + path.relative(ROOT, LEDGER) +
      ' (' + (e.code || e.message) + '); an unrecorded use is not a clearance, so the push is refused. Fix the ledger and retry.';
  }
  return null;
}

// ── dispatch ──────────────────────────────────────────────────────────────────────────────────────────────
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'check-git') {
  if (!isAgent()) process.exit(0);
  const { gopts, sub, rest } = splitGit(args);
  if (!sub) process.exit(0);
  const resolved = resolveToPush(sub, rest, gopts, 0);
  if (resolved === null) process.exit(0);
  // A push that names a command to run on the far side of the transport is refused before anything is planned —
  // the gate cannot screen it, and even a dry run would execute it.
  const cmdFlags = commandTransportFlags(resolved.push || []);
  if (cmdFlags.length)
    refuse('a push that carries ' + cmdFlags.join(' and ') + ' runs a command on the far side of the transport, so no gate can screen it (and even the gate\'s own dry-run would run it). Drop the flag and push normally.');
  if (resolved.shell !== undefined) {
    // Arbitrary shell we cannot re-plan. If its body reaches a push we cannot verify the target, so refuse
    // and point at the plain `git push` path (which this wrapper screens). A body with no push token is
    // harmless. Deeper obfuscation (a script that pushes) is inherent, same as calling /usr/bin/git, and is
    // covered by the hourly default-branch tripwire.
    if (PUSHY.test(resolved.shell))
      refuse("a shell git alias ('!' …) that pushes cannot be screened for its target branch; run `git push` " +
        'directly (this wrapper checks it) or push a feature branch and open a PR.');
    process.exit(0);
  }
  // A --dry-run push writes nothing: nothing to gate, and a dry run must never spend a bypass row.
  if (resolved.push.includes('-n') || resolved.push.includes('--dry-run')) process.exit(0);
  // The pre-push hook cannot see a push that skips it, so --no-verify is screened HERE, before the real git runs.
  if (hookSkip(gopts, resolved.push).skip) {
    const plan = planPush(gopts, resolved.push);
    if (!plan.github && !protectAll()) process.exit(0);      // local/file sandbox remote: not a company push
    if (!plan.updates.length) {
      if (plan.github && plan.code !== 0)
        refuse('git could not plan this --no-verify push, so the gate cannot check it against a clearance row (' +
          (plan.err.split('\n').find(Boolean) || 'git exited ' + plan.code).slice(0, 160) + '). Fix the push or retry; nothing was pushed.');
      process.exit(0);                                        // up to date / nothing moving: nothing was skipped
    }
    const d = bypassDecision(gopts, plan);
    if (d.refuse) refuse(d.refuse);
    const unwritten = recordBypassUse(d.allow, hookSkip(gopts, resolved.push).how);
    if (unwritten) refuse(unwritten);
    log('ALLOWED bypass ' + d.allow.acts.join(', ') + ' under row ' + d.allow.row.id + ' (' + d.allow.commits.length + ' sha, ' + hookSkip(gopts, resolved.push).how + '); row spent');
    process.exit(0);
  }
  checkPush(gopts, resolved.push);
  process.exit(0);
}

if (cmd === 'check-gh') {
  if (!isAgent()) process.exit(0);
  // Expand a leading user alias first, so `gh pm 5` (pm='pr merge') is classified as a merge, not waved through.
  const ex = expandGhAlias(args, 0);
  if (ex && ex.refuse) refuse(ex.refuse);
  const A = ex && ex.args ? ex.args : args;
  const w = A.filter(a => !a.startsWith('-'));   // gh has no value-taking global flags before the subcommand
  const isPrMerge = w[0] === 'pr' && w[1] === 'merge';
  const isApi = w[0] === 'api';
  const isRepoSync = w[0] === 'repo' && w[1] === 'sync';

  if (isPrMerge) {
    if (A.includes('-h') || A.includes('--help')) process.exit(0);               // help text, no merge
    if (A.includes('--auto') || A.includes('--auto=true'))
      refuse('`gh pr merge --auto` enables auto-merge; the head can change after the pre-merge PASS. Merge directly with `gh pr merge` once `node company/tools/premerge-check.js` records a PASS for the current head.');
    if (A.includes('--disable-auto')) process.exit(0);                           // turning auto-merge OFF lands nothing
    const repo = repoFromArgs(A);
    if (!repo) refuse('could not tell which repository this merge is for; pass --repo owner/name');
    const selector = prSelectorFromArgs(A);
    let h; try { h = headOf(repo, selector, repoExplicit(A) || selector !== null); }
    catch (e) { refuse('could not resolve the pull request' + (selector ? ' "' + selector + '"' : '') + ' (' + String(e.message).split('\n')[0].slice(0, 120) + '); not merging'); }
    const p = passFor(repo, h.sha);
    if (!p.ok) refuse(repo + ' #' + h.pr + ': ' + p.why + '. Run `node company/tools/premerge-check.js --pr ' + h.pr + ' --repo ' + repo + '` and merge only after it passes.');
    // counterpart sign-off (lib/signoff.js, docs/PROFILES.md), in addition to the PASS above: a seat whose profile lists
    // `merge` needs its counterpart's yes for pr:<repo>#<n> (live refuses; shadow records the would-refuse). Required here,
    // lazily, so a broken or missing library never turns into a refusal (the exit-code contract above)
    { let so = null; try { so = require('./lib/signoff').gate({ seat: presenter().agent, kind: 'merge', refs: ['pr:' + repo + '#' + h.pr], sha: h.sha, via: 'merge-gate.js' }); /* a yes is for this head commit only */ } catch (_) { so = null; }
      if (so && so.refuse) refuse(repo + ' #' + h.pr + ': ' + so.refuse + '.'); }
    // accountable leads (lib/accountable.js, docs/DEPARTMENTS.md §8): a member's change merges only once its lead accepted it
    // at this head commit (live refuses; recording only allows). Lazily, like the sign-off: a broken library never refuses
    { let ac = null; try { ac = require('./lib/accountable').gate({ seat: presenter().agent, refs: ['pr:' + repo + '#' + h.pr], sha: h.sha }); } catch (_) { ac = null; }
      if (ac && ac.refuse) refuse(repo + ' #' + h.pr + ': ' + ac.refuse + '.'); }
    log('ALLOWED ' + repo + ' #' + h.pr + ' head ' + h.sha.slice(0, 8));
    process.exit(0);
  }
  if (isApi) {
    const d = ghApiDecision(A.slice(A.indexOf('api') + 1), resolveDefaultBranch);
    if (d.refuse) refuse('gh api refused: ' + d.reason + '. Use the pull-request flow (branch → PR → pre-merge check → `gh pr merge`).');
    process.exit(0);
  }
  if (isRepoSync) {
    const d = repoSyncDecision(A);
    if (d.refuse) refuse(d.reason);
    process.exit(0);
  }
  process.exit(0);          // every other gh command passes untouched
}

if (cmd === 'check-push') {
  if (!isAgent()) process.exit(0);
  const remote = args[0] || '';
  let def = null;
  try { const r = execFileSync(REAL_GIT, ['symbolic-ref', 'refs/remotes/' + remote + '/HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (r) def = r.replace('refs/remotes/' + remote + '/', ''); } catch (_) {}
  if (!def) { try { const r = execFileSync(REAL_GIT, ['ls-remote', '--symref', args[1] || remote, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }); const m = r.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m); if (m) def = m[1]; } catch (_) {} }
  const lines = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);   // <local ref> <local sha> <remote ref> <remote sha>
  for (const l of lines) {
    const remoteRef = l.split(' ')[2] || '';
    if (isProtectedRef(remoteRef, def))
      refuse('agents may not push straight to ' + shortRef(remoteRef) + ' (the default branch); open a pull request, run the pre-merge check, then merge with gh.');
  }
  process.exit(0);
}

if (cmd === 'status') {
  const repo = repoFromArgs(args); const sel = args.find(a => !a.startsWith('-')) || null;
  if (!repo) { console.log(JSON.stringify({ repo: null, pr: sel, allowed: false, why: 'no repository: pass --repo owner/name' })); process.exit(1); }
  let h; try { h = headOf(repo, sel, true); } catch (e) { console.log(JSON.stringify({ repo, pr: sel, allowed: false, why: 'could not read the pull request: ' + String(e.stderr || e.message).split('\n')[0].slice(0, 160) })); process.exit(1); }
  const p = passFor(repo, h.sha);
  console.log(JSON.stringify({ repo, pr: h.pr, head: h.sha, allowed: p.ok, why: p.why || 'a PASS is recorded for this head' }));
  process.exit(0);
}

if (cmd === 'selftest') { selftest(); return; }

console.error('usage: merge-gate.js check-git <git args> | check-gh <gh args> | check-push <remote> <url> | status <pr> [--repo owner/name] | selftest');
process.exit(2);

// ── selftest ──────────────────────────────────────────────────────────────────────────────────────────────
// Builds throwaway bare repos + clones in a temp dir and proves every rule with assume-agent + protect-all + a
// redirected log, directly (node merge-gate check-git …) and through the real wrapper (~/.local/bin/git). Also
// runs pure gh api/graphql/--auto/repo-sync parsing tests with the default branch injected (no network), and
// measures the wrapper's overhead on a non-push owner call.
function selftest() {
  const os = require('os');
  const cp = require('child_process');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-gate-selftest-'));
  const LOGF = path.join(TMP, 'gate.log');
  const WRAP = path.join(os.homedir(), '.local', 'bin', 'git');
  const CLEAN = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const AENV = Object.assign({}, CLEAN, { MERGE_GATE_ASSUME_AGENT: '1', MERGE_GATE_PROTECT_ALL: '1', MERGE_GATE_LOG: LOGF });
  const OENV = Object.assign({}, CLEAN, { MERGE_GATE_PROTECT_ALL: '1', MERGE_GATE_LOG: LOGF });   // no ASSUME_AGENT → owner
  let pass = 0, fail = 0, skips = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name); } };
  // A case whose premise does not hold where it is running is a skip with its reason, not a failure — otherwise the
  // selftest is red for every agent in the company and green for nobody (see the owner case below).
  const skip = (name, why) => { skips++; console.log('  skip ' + name + ' — ' + why); };

  const G = (a, env) => { const r = cp.spawnSync(REAL_GIT, a, { encoding: 'utf8', env: Object.assign({}, process.env, CLEAN, env || {}) }); if (r.status !== 0) throw new Error('setup git ' + a.join(' ') + '\n' + (r.stderr || '')); return r; };
  let seq = 0;
  function mkrepo(def) {
    const base = fs.mkdtempSync(path.join(TMP, 'r' + (seq++) + '-'));
    const bare = path.join(base, 'remote.git'), wc = path.join(base, 'wc');
    G(['init', '-q', '--bare', '-b', def, bare]);
    G(['clone', '-q', bare, wc]);
    G(['-C', wc, 'symbolic-ref', 'HEAD', 'refs/heads/' + def]);
    G(['-C', wc, 'commit', '-q', '--allow-empty', '-m', 'base']);
    G(['-C', wc, 'push', '-q', '-u', 'origin', def]);
    return { base, bare, wc, def };
  }
  const ahead = def => { const r = mkrepo(def); G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'ahead']); return r; };
  // Like mkrepo but the origin URL literally contains //github.com/ so isGithub() treats it as a github remote
  // (the path still resolves locally — no network), to exercise the github-only paths (fail-closed, `--` splice).
  function mkGh(def) {
    const base = fs.mkdtempSync(path.join(TMP, 'g' + (seq++) + '-'));
    const bare = base + '/x//github.com/o/r.git', wc = path.join(base, 'wc');
    fs.mkdirSync(base + '/x//github.com/o', { recursive: true });
    G(['init', '-q', '--bare', '-b', def, bare]);
    G(['clone', '-q', bare, wc]);
    G(['-C', wc, 'symbolic-ref', 'HEAD', 'refs/heads/' + def]);
    G(['-C', wc, 'commit', '-q', '--allow-empty', '-m', 'base']);
    G(['-C', wc, 'push', '-q', '-u', 'origin', def]);
    return { base, bare, wc, def };
  }
  const aheadGh = def => { const r = mkGh(def); G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'ahead']); return r; };
  function divergentMain() {               // local and remote main diverge → +HEAD:main is a real forced update
    const r = mkrepo('main');
    G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'B']); G(['-C', r.wc, 'push', '-q', 'origin', 'main']);
    G(['-C', r.wc, 'reset', '-q', '--hard', 'HEAD~1']); G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'C']);
    return r;
  }

  // One parameterised battery, run with the direct node invoker and again through the real wrapper.
  function battery(label, invoke) {
    console.log('[' + label + ']');
    let r;
    r = mkrepo('master'); G(['-C', r.wc, 'branch', 'feat']);
    ok('feature-branch push allowed', invoke(r.wc, ['push', 'origin', 'feat'], AENV) === 0);
    r = mkrepo('master'); G(['-C', r.wc, 'tag', 'v1']);
    ok('--tags allowed', invoke(r.wc, ['push', '--tags', 'origin'], AENV) === 0);
    r = mkrepo('master');
    ok('up-to-date master push allowed', invoke(r.wc, ['push', 'origin', 'master'], AENV) === 0);
    ok('push origin master refused', invoke(ahead('master').wc, ['push', 'origin', 'master'], AENV) === 1);
    ok('HEAD:master refused', invoke(ahead('master').wc, ['push', 'origin', 'HEAD:master'], AENV) === 1);
    ok('+HEAD:main (forced) refused', invoke(divergentMain().wc, ['push', 'origin', '+HEAD:main'], AENV) === 1);
    ok('--delete master refused', invoke(mkrepo('master').wc, ['push', 'origin', '--delete', 'master'], AENV) === 1);
    ok('--no-verify master refused', invoke(ahead('master').wc, ['push', '--no-verify', 'origin', 'master'], AENV) === 1);
    ok('-c core.hooksPath=/dev/null push refused', invoke(ahead('master').wc, ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'master'], AENV) === 1);
    r = ahead('master');
    ok('git -C <dir> push refused', invoke(TMP, ['-C', r.wc, 'push', 'origin', 'master'], AENV) === 1);
    r = ahead('master'); G(['-C', r.wc, 'config', 'alias.p', 'push']);
    ok('alias p=push refused', invoke(r.wc, ['p', 'origin', 'master'], AENV) === 1);
    ok('production default-branch push refused', invoke(ahead('production').wc, ['push', 'origin', 'production'], AENV) === 1);
    r = ahead('master'); G(['-C', r.wc, 'branch', 'feat']);
    ok('--all including master refused', invoke(r.wc, ['push', '--all', 'origin'], AENV) === 1);
    // shell ('!') aliases: one that pushes is refused (git runs its inner push via git-core, bypassing this
    // wrapper); one that does not push is allowed.
    r = ahead('master'); G(['-C', r.wc, 'config', 'alias.sneak', '!git push --no-verify origin master']);
    ok('shell alias that pushes master refused', invoke(r.wc, ['sneak'], AENV) === 1);
    r = mkrepo('master'); G(['-C', r.wc, 'config', 'alias.shq', '!git status --porcelain']);
    ok('shell alias without push allowed', invoke(r.wc, ['shq'], AENV) === 0);
    // --dry-run writes nothing → never gated, even to the default branch.
    ok('push --dry-run origin master allowed', invoke(ahead('master').wc, ['push', '--dry-run', 'origin', 'master'], AENV) === 0);
    // github-detected remote: default branch refused; a feature push that uses `--` is allowed (the forced
    // --no-quiet must land before the `--`, not become a refspec); a --dry-run to the default branch is allowed.
    ok('github remote: master push refused', invoke(aheadGh('master').wc, ['push', 'origin', 'master'], AENV) === 1);
    r = mkGh('master'); G(['-C', r.wc, 'checkout', '-q', '-b', 'feat']); G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'x']);
    ok('github remote: push origin -- feat (feature) allowed', invoke(r.wc, ['push', 'origin', '--', 'feat'], AENV) === 0);
    ok('github remote: push --dry-run origin master allowed', invoke(aheadGh('master').wc, ['push', '--dry-run', 'origin', 'master'], AENV) === 0);
    // The owner branch: a shell with no agent marker (his own terminal) may push to master — the gate must be soft for
    // him. isAgent() is `MERGE_GATE_ASSUME_AGENT === '1' || underStation()`, and inside a StarNet run underStation() is
    // true by design, so this premise is FALSE where every agent runs it and the case can never pass there. It is proven
    // by running this selftest from a shell outside the station (the owner's terminal, or `setsid` from it), and skipped
    // with its reason everywhere else. Not "fixed" by an override that would let an agent claim to be the owner: that
    // would be a bypass, and the one thing this file must not grow.
    if (underStation()) skip('WITHOUT assume-agent: push master passes',
      'inside a StarNet run isAgent() is true by design, so the owner branch is unreachable here — run this selftest from a shell outside the station to prove it');
    else ok('WITHOUT assume-agent: push master passes', invoke(ahead('master').wc, ['push', 'origin', 'master'], OENV) === 0);
  }

  // The gate's own refusal code is 3 (only 3 blocks; any other code is a crash and soft-passes), while the wrapper maps
  // it to git's 1. The battery asserts "refused", so the direct invoker normalizes 3 -> 1 HERE, at the one place the
  // difference exists, and the raw contract is asserted once immediately below: normalizing silently would hide a
  // change to the exit codes, which is the contract the wrappers rely on.
  const directRaw = (cwd, a, env) => cp.spawnSync('node', [__filename, 'check-git', ...a], { cwd, encoding: 'utf8', env: Object.assign({}, process.env, env) }).status;
  const direct = (cwd, a, env) => { const s = directRaw(cwd, a, env); return s === REFUSE ? 1 : s; };
  console.log('[exit codes: the contract the wrappers rely on]');
  ok('the gate itself refuses with exit 3 (the only code a wrapper blocks on)', directRaw(ahead('master').wc, ['push', 'origin', 'master'], AENV) === REFUSE);
  const rc = mkrepo('master'); G(['-C', rc.wc, 'branch', 'feat']);
  ok('an allowed push exits 0 from the gate itself', directRaw(rc.wc, ['push', 'origin', 'feat'], AENV) === 0);
  battery('direct: node merge-gate.js check-git', direct);

  if (fs.existsSync(WRAP)) {
    const wrapped = (cwd, a, env) => cp.spawnSync(WRAP, a, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, env) }).status;
    battery('wrapper: ~/.local/bin/git', wrapped);
  } else console.log('  SKIP wrapper ~/.local/bin/git is not installed on this machine (a deployment check, not a unit test; install the merge-gate wrapper to run it)');

  // ── the --no-verify bypass check  ───────────────
  // A push that skips the pre-push hook must be named by a live `merge-gate-bypass` row in the clearance ledger,
  // so these cases drive a ledger of our own (MERGE_GATE_LEDGER) and assert BOTH directions: refused with no row,
  // allowed with one, and the row spent afterwards. A check that has never been shown to fail is not a check.
  console.log('[--no-verify needs a live merge-gate-bypass row]');
  {
    const r = mkGh('master');
    G(['-C', r.wc, 'checkout', '-q', '-b', 'feat']);
    G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'one']);
    G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'two']);
    const shas = G(['-C', r.wc, 'rev-list', 'feat', '--not', '--remotes=origin']).stdout.trim().split('\n');
    const led = n => path.join(TMP, 'bypass-' + n + '.jsonl');
    const row = over => Object.assign({ id: 'clr-selftest', kind: 'merge-gate-bypass', acts: ['push:o/r:feat'], repo: 'o/r',
      branch: 'feat', covers: { release: 'selftest', commits: shas }, grantedBy: co.config.owner.name, grantedAt: new Date().toISOString(),
      reason: 'selftest: prove the --no-verify check refuses without a row and allows with one',
      expiresAt: new Date(Date.now() + 600000).toISOString(), oneShot: true, usedAt: null, usedBy: null }, over);
    const run = (a, n, over, keep) => {
      const f = led(n);
      if (!keep) { try { fs.unlinkSync(f); } catch (_) {} }
      if (over !== undefined) fs.writeFileSync(f, JSON.stringify(row(over)) + '\n');
      return cp.spawnSync('node', [__filename, 'check-git', ...a],
        { cwd: r.wc, encoding: 'utf8', env: Object.assign({}, process.env, AENV, { MERGE_GATE_LEDGER: f }) }).status;
    };
    ok('--no-verify with no row of that kind → refused', run(['push', '--no-verify', 'origin', 'feat'], 1) === REFUSE);
    ok('--no-verify with an expired row → refused', run(['push', '--no-verify', 'origin', 'feat'], 2,
      { expiresAt: new Date(Date.now() - 3600000).toISOString() }) === REFUSE);
    ok('--no-verify with a sha outside covers.commits → refused', run(['push', '--no-verify', 'origin', 'feat'], 3,
      { covers: { release: 'selftest', commits: [shas[0]] } }) === REFUSE);
    ok('--no-verify with grantedBy an agent → refused', run(['push', '--no-verify', 'origin', 'feat'], 4,
      { grantedBy: 'Alex' }) === REFUSE);
    ok('--no-verify with an empty acts list → refused', run(['push', '--no-verify', 'origin', 'feat'], 5,
      { acts: [] }) === REFUSE);
    ok('--no-verify with a live row covering the push → allowed', run(['push', '--no-verify', 'origin', 'feat'], 6, {}) === 0);
    let spent = null; try { spent = JSON.parse(fs.readFileSync(led(6), 'utf8').trim().split('\n').pop()); } catch (_) {}
    ok('the use is written onto the row (usedAt + usedBy)', !!(spent && spent.usedAt && spent.usedBy));
    ok('a second push against the spent row → refused', run(['push', '--no-verify', 'origin', 'feat'], 6, undefined, true) === REFUSE);
    ok('a feature push WITHOUT --no-verify needs no row', run(['push', 'origin', 'feat'], 7) === 0);
    ok('--no-verify --dry-run is allowed and spends nothing', run(['push', '--no-verify', '--dry-run', 'origin', 'feat'], 8) === 0);
    ok('-c core.hooksPath=/dev/null (the other hook-skipping route) → refused', run(['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'feat'], 9) === REFUSE);
    // The shape of the push, and a spend that stays spent. A clearance row
    // names the commits it clears — never a branch to be deleted or to move backwards — and a spent row stays spent
    // however the ledger's last line for it reads. These cases drive master (the default branch) and a branch whose
    // tip is already on the remote, because those are the two shapes that used to pass vacuously.
    console.log('[--no-verify: the shape of the push, and a spend that stays spent]');
    {
      const runRow = (a, file) => cp.spawnSync('node', [__filename, 'check-git', ...a],
        { cwd: r.wc, encoding: 'utf8', env: Object.assign({}, process.env, AENV, { MERGE_GATE_LEDGER: file }) });
      G(['-C', r.wc, 'checkout', '-q', 'master']);
      G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'master two']);
      const m1 = G(['-C', r.wc, 'rev-parse', 'master~1']).stdout.trim();
      const m2 = G(['-C', r.wc, 'rev-parse', 'master']).stdout.trim();
      G(['-C', r.wc, 'push', '-q', 'origin', 'master']);          // real git: the remote tip is m2 now
      G(['-C', r.wc, 'checkout', '-q', '-b', 'feat2']);
      G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'feat2 one']);
      const x = G(['-C', r.wc, 'rev-parse', 'HEAD']).stdout.trim();
      G(['-C', r.wc, 'push', '-q', 'origin', 'feat2:other']);     // x is on the remote under another name
      G(['-C', r.wc, 'checkout', '-q', 'feat']);
      G(['-C', r.wc, 'commit', '-q', '--allow-empty', '-m', 'feat three']);
      const s3 = G(['-C', r.wc, 'rev-parse', 'HEAD']).stdout.trim();
      const mrow = over => row(Object.assign({ id: 'clr-selftest-master', acts: ['push:o/r:master'], branch: 'master',
        covers: { release: 'selftest', commits: [m2] } }, over));
      const f2row = over => row(Object.assign({ id: 'clr-selftest-f2', acts: ['push:o/r:feat2'], branch: 'feat2',
        covers: { release: 'selftest', commits: [x] } }, over));
      const write = (n, rowObj) => { const f = led(n); fs.writeFileSync(f, JSON.stringify(rowObj) + '\n'); return f; };
      let res = runRow(['push', '--no-verify', '--delete', 'origin', 'master'], write(10, mrow({})));
      ok('--no-verify --delete of the default branch → refused, and the refusal names the case',
        res.status === REFUSE && /deletion of master/.test(res.stderr || ''));
      res = runRow(['push', '--no-verify', '--force', 'origin', m1 + ':master'], write(11, mrow({})));
      ok('--no-verify --force of an ancestor the remote already has → refused, and the refusal names the case',
        res.status === REFUSE && /forced update of master/.test(res.stderr || ''));
      res = runRow(['push', '--no-verify', 'origin', 'feat2'], write(12, f2row({})));
      ok('a push that carries no commit → refused unless the row says covers.empty',
        res.status === REFUSE && /empty commit set/.test(res.stderr || ''));
      res = runRow(['push', '--no-verify', 'origin', 'feat2'],
        write(13, f2row({ covers: { release: 'selftest', commits: [x], empty: true } })));
      ok('the same push with covers.empty in the row → allowed', res.status === 0);
      const spentFirst = new Date().toISOString();
      const sticky = led(14);
      fs.writeFileSync(sticky, JSON.stringify(row({ id: 'clr-selftest-sticky', covers: { release: 'selftest', commits: [s3] } })) + '\n' +
        JSON.stringify(row({ id: 'clr-selftest-sticky', covers: { release: 'selftest', commits: [s3] }, usedAt: spentFirst, usedBy: 'someone else' })) + '\n' +
        JSON.stringify(row({ id: 'clr-selftest-sticky', covers: { release: 'selftest', commits: [s3] }, usedAt: null, usedBy: null })) + '\n');
      res = runRow(['push', '--no-verify', 'origin', 'feat'], sticky);
      ok('a spent row re-appended by hand with usedAt null stays spent',
        res.status === REFUSE && /was spent/.test(res.stderr || ''));
      // The transport flags: a command carrier, and the two flags that
      // carry EVERY ref instead of the ones a row names.
      const marker = path.join(TMP, 'transport-ran');
      res = runRow(['push', '--no-verify', '--receive-pack=sh -c "touch ' + marker + '"', 'origin', 'feat'],
        write(15, row({ id: 'clr-selftest-rp', acts: ['push:o/r:feat'], covers: { release: 'selftest', commits: [s3] } })));
      ok('--no-verify --receive-pack=<command> → refused, and the command never ran',
        res.status === REFUSE && /receive-pack/.test(res.stderr || '') && !fs.existsSync(marker));
      res = runRow(['push', '--no-verify', '--exec=touch ' + marker, 'origin', 'feat'],
        write(16, row({ id: 'clr-selftest-ex', acts: ['push:o/r:feat'], covers: { release: 'selftest', commits: [s3] } })));
      ok('--no-verify --exec=<command> → refused, and the command never ran',
        res.status === REFUSE && /--exec/.test(res.stderr || '') && !fs.existsSync(marker));
      res = runRow(['push', '--no-verify', '--all', 'origin'],
        write(17, row({ id: 'clr-selftest-all', acts: ['push:o/r:feat'], covers: { release: 'selftest', commits: [s3] } })));
      ok('--no-verify --all (the local repo holds branches the row does not name) → refused, and the refusal names the act',
        res.status === REFUSE && /does not list/.test(res.stderr || ''));
      res = runRow(['push', '--no-verify', '--mirror', 'origin'],
        write(18, row({ id: 'clr-selftest-mirror', acts: ['push:o/r:feat'], covers: { release: 'selftest', commits: [s3] } })));
      ok('--no-verify --mirror → refused', res.status === REFUSE);
    }
  }

  // gh decisions — pure, default branch injected (no network).
  console.log('[gh api / graphql / --auto / repo sync parsing]');
  const def = () => 'main';
  const R = (name, d, want) => ok(name, !!d.refuse === want);
  R('PUT pulls/N/merge refused', ghApiDecision(['-X', 'PUT', 'repos/o/r/pulls/5/merge'], def), true);
  R('glued -XPUT pulls/N/merge refused', ghApiDecision(['-XPUT', 'repos/o/r/pulls/5/merge'], def), true);
  R('-X=PUT pulls/N/merge refused', ghApiDecision(['-X=PUT', 'repos/o/r/pulls/5/merge'], def), true);
  R('full-URL PUT pulls/N/merge refused', ghApiDecision(['-X', 'PUT', 'https://api.github.com/repos/o/r/pulls/5/merge'], def), true);
  R('GET pulls/N/merge (is-merged check) allowed', ghApiDecision(['repos/o/r/pulls/5/merge'], def), false);
  R('POST merges refused', ghApiDecision(['repos/o/r/merges', '-f', 'base=main', '-f', 'head=x'], def), true);
  R('full-URL POST merges refused', ghApiDecision(['-X', 'POST', 'https://api.github.com/repos/o/r/merges', '-f', 'base=main', '-f', 'head=x'], def), true);
  R('PATCH git/refs/heads/main refused', ghApiDecision(['-X', 'PATCH', 'repos/o/r/git/refs/heads/main'], def), true);
  R('DELETE git/refs/heads/master refused', ghApiDecision(['-X', 'DELETE', 'repos/o/r/git/refs/heads/master'], def), true);
  R('PATCH git/refs/heads/feature allowed', ghApiDecision(['-X', 'PATCH', 'repos/o/r/git/refs/heads/feature'], def), false);
  R('POST git/refs creating main refused', ghApiDecision(['repos/o/r/git/refs', '-f', 'ref=refs/heads/main', '-f', 'sha=x'], def), true);
  R('POST git/refs creating feature allowed', ghApiDecision(['repos/o/r/git/refs', '-f', 'ref=refs/heads/feature', '-f', 'sha=x'], def), false);
  R('PUT contents no branch refused', ghApiDecision(['-X', 'PUT', 'repos/o/r/contents/f.txt', '-f', 'message=x', '-f', 'content=x'], def), true);
  R('PUT contents on default refused', ghApiDecision(['-X', 'PUT', 'repos/o/r/contents/f.txt', '-f', 'branch=main', '-f', 'content=x'], def), true);
  R('PUT contents on feature allowed', ghApiDecision(['-X', 'PUT', 'repos/o/r/contents/f.txt', '-f', 'branch=feature', '-f', 'content=x'], def), false);
  R('PUT contents on feature (glued -fbranch=) allowed', ghApiDecision(['-X', 'PUT', 'repos/o/r/contents/f.txt', '-fbranch=feature', '-fcontent=x'], def), false);
  R('POST issue comment allowed', ghApiDecision(['repos/o/r/issues/1/comments', '-f', 'body=hi'], def), false);
  R('GET repo allowed', ghApiDecision(['repos/o/r'], def), false);
  R('explicit GET with -f allowed', ghApiDecision(['-X', 'GET', 'search/issues', '-f', 'q=x'], def), false);
  R('graphql mergePullRequest refused', ghApiDecision(['graphql', '-f', 'query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'], def), true);
  R('graphql enablePullRequestAutoMerge refused', ghApiDecision(['graphql', '-f', 'query=mutation{enablePullRequestAutoMerge(input:{}){x}}'], def), true);
  R('graphql updateRef on main refused', ghApiDecision(['graphql', '-f', 'query=mutation{updateRef(input:{refId:"x",name:"refs/heads/main"}){x}}'], def), true);
  R('graphql createCommitOnBranch main refused', ghApiDecision(['graphql', '-f', 'query=mutation{createCommitOnBranch(input:{branch:{branchName:"main"}}){x}}'], def), true);
  R('graphql createCommitOnBranch feature allowed', ghApiDecision(['graphql', '-f', 'query=mutation{createCommitOnBranch(input:{branch:{branchName:"feature"}}){x}}'], def), false);
  R('graphql commit to fix/main-menu, "main" in headline, allowed', ghApiDecision(['graphql', '-f', 'query=mutation{createCommitOnBranch(input:{branch:{branchName:"fix/main-menu"},message:{headline:"fix the main menu"}}){x}}'], def), false);
  R('repo sync <remote dest> refused', repoSyncDecision(['repo', 'sync', 'owner/fork']), true);
  R('repo sync (local) allowed', repoSyncDecision(['repo', 'sync']), false);
  R('repo sync --branch main (no dest) allowed', repoSyncDecision(['repo', 'sync', '--branch', 'main']), false);
  // --input and @file bodies are parsed (write to a temp file; no network).
  const refJson = path.join(TMP, 'ref.json'); fs.writeFileSync(refJson, JSON.stringify({ ref: 'refs/heads/master', sha: 'x' }));
  const putFeat = path.join(TMP, 'put.json'); fs.writeFileSync(putFeat, JSON.stringify({ branch: 'fix/x', message: 'm', content: 'eA==' }));
  const mutFile = path.join(TMP, 'mut.graphql'); fs.writeFileSync(mutFile, 'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}');
  R('POST git/refs --input master-ref refused', ghApiDecision(['repos/o/r/git/refs', '--input', refJson], def), true);
  R('PUT contents --input feature-branch allowed', ghApiDecision(['-X', 'PUT', 'repos/o/r/contents/a.md', '--input', putFeat], def), false);
  R('graphql -F query=@mergefile refused', ghApiDecision(['graphql', '-F', 'query=@' + mutFile], def), true);
  R('POST git/refs --input - (stdin) refused', ghApiDecision(['repos/o/r/git/refs', '--input', '-'], def), true);
  R('graphql --input - (stdin) refused', ghApiDecision(['graphql', '--input', '-'], def), true);

  // PR selector parsing: a branch name resolves to a selector (not null), so headOf validates the RIGHT PR.
  console.log('[gh pr merge selector]');
  ok('numeric selector parsed', prSelectorFromArgs(['pr', 'merge', '5']) === '5');
  ok('branch-name selector parsed (not dropped)', prSelectorFromArgs(['pr', 'merge', 'my-feature', '--repo', 'o/r']) === 'my-feature');
  ok('url selector parsed', prSelectorFromArgs(['pr', 'merge', 'https://github.com/o/r/pull/9']) === 'https://github.com/o/r/pull/9');
  ok('no selector → null (current branch)', prSelectorFromArgs(['pr', 'merge', '--squash']) === null);
  ok('selector not confused with --subject value', prSelectorFromArgs(['pr', 'merge', '--subject', 'x', 'feat']) === 'feat');

  // check-gh spawns (offline): --auto, --help, --disable-auto, and user-alias routing. Aliases live in a throwaway
  // GH_CONFIG_DIR so the owner's real gh config is untouched.
  console.log('[check-gh spawns (offline)]');
  const CFG = path.join(TMP, 'ghcfg');
  const ghset = (name, exp) => cp.spawnSync(REAL_GH, ['alias', 'set', name, exp], { encoding: 'utf8', env: Object.assign({}, process.env, { GH_CONFIG_DIR: CFG }) });
  const checkgh = a => cp.spawnSync('node', [__filename, 'check-gh', ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { MERGE_GATE_ASSUME_AGENT: '1', MERGE_GATE_LOG: LOGF, GH_CONFIG_DIR: CFG }) });
  ghset('putm', 'api -XPUT repos/o/r/pulls/5/merge'); ghset('sh', '!gh pr merge --admin $1'); ghset('vv', 'pr view');
  const am = checkgh(['pr', 'merge', '5', '--auto', '--repo', 'o/r']);
  // The gate refuses with exit 3 (see the contract case above); this used to assert 1, the wrapper's translation.
  ok('gh pr merge --auto refused (offline, before head lookup)', am.status === REFUSE && /auto-merge/.test(am.stderr || ''));
  ok('gh pr merge --help allowed (before head lookup)', checkgh(['pr', 'merge', '--help']).status === 0);
  ok('gh pr merge --disable-auto allowed', checkgh(['pr', 'merge', '5', '--disable-auto', '--repo', 'o/r']).status === 0);
  ok('alias putm (api -XPUT merge) refused', checkgh(['putm']).status === REFUSE);
  ok('shell alias sh (!gh pr merge) refused', checkgh(['sh', '5']).status === REFUSE);
  ok('alias vv (pr view) allowed', checkgh(['vv', '5', '--repo', 'o/r']).status === 0);

  // Owner overhead on a non-push call (fast path: no node). Reported, not asserted.
  if (fs.existsSync(WRAP)) {
    const N = 60;
    for (const a of [['--version'], ['status', '--porcelain']]) {
      const cwd = mkrepo('master').wc;
      const rt = (bin) => { const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) cp.spawnSync(bin, a, { cwd, encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6 / N; };
      const w = rt(WRAP), real = rt(REAL_GIT);
      console.log('  overhead git ' + a.join(' ') + ': wrapper ' + w.toFixed(1) + ' ms vs real ' + real.toFixed(1) + ' ms (+' + (w - real).toFixed(1) + ' ms/call)');
    }
  }

  // Guardrail defaultBranch: the same refusal with the switch ON (exit 3, REFUSED) and OFF (exit 0, an UNGUARDED log line).
  // Run from a temp copy of the gate + lib/company.js, so the switch is read from that copy's company/state, never the live one.
  console.log('[guardrail defaultBranch (temp copy of the gate)]');
  {
    const GR = path.join(TMP, 'guard-root'), tools = path.join(GR, 'company', 'tools');
    fs.mkdirSync(path.join(tools, 'lib'), { recursive: true }); fs.mkdirSync(path.join(GR, 'company', 'state'), { recursive: true });
    fs.copyFileSync(__filename, path.join(tools, 'merge-gate.js'));
    fs.copyFileSync(path.join(__dirname, 'lib', 'company.js'), path.join(tools, 'lib', 'company.js'));
    const GLOG = path.join(TMP, 'guard.log');
    const setGuard = on => fs.writeFileSync(path.join(GR, 'company', 'state', 'guardrails.json'), JSON.stringify({ guards: { defaultBranch: on } }));
    const pushMain = () => cp.spawnSync('node', [path.join(tools, 'merge-gate.js'), 'check-push', 'nowhere-' + process.pid, ''], { cwd: TMP, encoding: 'utf8',
      input: 'refs/heads/main ' + '1'.repeat(40) + ' refs/heads/main ' + '0'.repeat(40) + '\n', env: Object.assign({}, process.env, CLEAN, { MERGE_GATE_ASSUME_AGENT: '1', MERGE_GATE_LOG: GLOG, CAPHEOS_ROOT: GR }) });
    setGuard(true);
    const on = pushMain();
    ok('guardrail ON: an agent push to main is refused (exit 3, REFUSED logged)', on.status === REFUSE && /REFUSED/.test(fs.existsSync(GLOG) ? fs.readFileSync(GLOG, 'utf8') : ''));
    setGuard(false);
    const off = pushMain(), glog = fs.existsSync(GLOG) ? fs.readFileSync(GLOG, 'utf8') : '';
    ok('guardrail OFF: the same push is allowed (exit 0) and still logged as UNGUARDED', off.status === 0 && /UNGUARDED \(guardrail defaultBranch is OFF\)/.test(glog) && /guardrail is OFF/.test(off.stderr || ''));
    fs.writeFileSync(path.join(GR, 'company', 'state', 'guardrails.json'), '{ not json');
    ok('guardrail state unreadable: the gate stays ON (fail closed)', pushMain().status === REFUSE);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skips ? ', ' + skips + ' skipped (see the reason on each)' : ''));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}
