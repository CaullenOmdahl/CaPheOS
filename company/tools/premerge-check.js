#!/usr/bin/env node
/* premerge-check.js — the pre-merge gate the company runs because GitHub cannot enforce it here.
 *
 * WHY THIS EXISTS: on a PRIVATE repo on GitHub Free, branch protection and required status checks are
 * unavailable (API 403: "Upgrade to GitHub Pro or make this repository public").
 * And every agent commits under the owner's single GitHub account, so GitHub's own "approve" cannot
 * prove an INDEPENDENT reviewer. This script checks what GitHub cannot:
 *   - PR open, not draft, base = default branch
 *   - conventional-commit title, linked issue (with a narrow chore/build-context exemption)
 *   - a NAMED independent reviewer (different from the author agent) whose LATEST verdict is an approval
 *   - optional evidence string (e.g. strict-green) in the PR discussion
 *   - no unresolved REQUEST CHANGES as the latest verdict
 *   - no UNDECLARED deletion-shaped change (>= 5 files deleted outright, or >= 2000 deleted lines)
 * and, when the PR's author is in a department whose lead gives advice (departments.json advisor live, lib/consult.js),
 * one row "Lead's advice (advisory)": the lead's latest verdict on a premerge consult for this PR (a consult is opened once
 * per PR head when none is there). The row NEVER changes pass or fail or the exit code; it is written as `lead` in the
 * evidence record.
 *
 *   node company/tools/premerge-check.js --pr <n> [--repo owner/name] [--require-evidence "strict-green"]
 *   (no --repo: the cwd's origin remote; no repo is baked in)
 * exit 0 = pass, 1 = blocked, 2 = usage/API error. Guardrail co.guard('defaultBranch') OFF (owner-only, guardrails.js): a
 * blocked PR still prints BLOCKED and records FAIL, but exits 0.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const co = require('./lib/company');

function args() {
  const a = process.argv.slice(2); const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2);
    o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true;
  }
  return o;
}
const a = args();
function originRepo() {
  try {
    const u = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = u.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/); return m ? m[1] : '';
  } catch (_) { return ''; }
}
const repo = String(a.repo || (a.selftest ? 'owner/selftest' : originRepo()));
if (!repo) { console.log('usage: premerge-check.js --pr <number> --repo owner/name (no --repo given and the cwd has no github origin)'); process.exit(2); }
const pr = String(a.pr || '');
const DELETION_FILE_THRESHOLD = 5;
const DELETION_LINE_THRESHOLD = 2000;

// --- replay mode: exercise the deletion guard against any two commits in history -------------
// A silent revert that already merged can never be run through the gate as a PR again. This mode runs
// the SAME functions the PR path uses on a commit range, so a proof against a past range is a proof of
// the shipped code and not of a copy of it.
//   node company/tools/premerge-check.js --replay <baseSha>:<headSha>
// exit 0 = the range is not deletion-shaped, 1 = it is (the gate would block it), 2 = API error.
if (a.replay) {
  const parts = String(a.replay).split(':').map(s => s.trim()).filter(Boolean);
  if (parts.length !== 2) { console.log('usage: --replay <baseSha>:<headSha>'); process.exit(2); }
  let cmp;
  try { cmp = JSON.parse(gh(['api', 'repos/' + repo + '/compare/' + parts[0] + '...' + parts[1]])); }
  catch (e) { console.log('API error: ' + String(e.message).slice(0, 200)); process.exit(2); }
  const shape = deletionShape(cmp.files || []);
  console.log('DELETION-GUARD REPLAY — ' + parts[0].slice(0, 8) + '...' + parts[1].slice(0, 8));
  console.log('  files in diff: ' + (cmp.files || []).length + ' · deleted outright: ' + shape.removed.length
    + ' · deletions: ' + shape.deletions + ' · additions: ' + shape.additions);
  if (shape.removed.length) console.log('  deleted paths: ' + shape.removed.slice(0, 20).join(', ') + (shape.removed.length > 20 ? ' …' : ''));
  console.log(shape.crossed
    ? '  BLOCK  deletion-shaped change — the gate would require a "Deletion intent:" declaration naming every deleted path'
    : '  PASS   not deletion-shaped (thresholds: >= 5 files deleted outright, or >= 2000 deleted lines)');
  process.exit(shape.crossed ? 1 : 0);
}
if (a.selftest) { runDeletionSelftest(); }
if (!pr && !a.selftest) { console.log('usage: premerge-check.js --pr <number> [--repo owner/name]'); process.exit(2); }

function gh(argv) { return execFileSync('gh', argv, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).trim(); }
let d;
try { d = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'number,title,body,state,isDraft,baseRefName,headRefName,author,reviews,comments,files,mergeable,headRefOid,baseRefOid,changedFiles'])); }
catch (e) { console.log('API error: ' + String(e.message).slice(0, 200)); process.exit(2); }

const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

// --- deletion-shaped-change guard -------------------------------------------------------------
// The stale-branch detector below cannot see every silent revert. A branch can be CURRENT (behind_by = 0)
// while the revert comes from a stale WORKING TREE committed on top of it: a hundred-plus files, dozens
// deleted outright, thousands of deleted lines. No ancestry test sees that shape at any strictness.
// So this guard asks a different question of the diff the gate already fetched: is this PR a
// DELETION-SHAPED change? If it is, it must say so — every deleted path named in the PR body — before
// the gate passes it, because the list is then in front of the independent reviewer who must approve.
// The thresholds separate a stale-tree revert (both crossed by a wide margin) from ordinary PRs (a few
// files, tens of deleted lines). There is no bypass flag: a flag any agent can set is not a control.
function deletionShape(files) {
  const removed = [];
  let deletions = 0, additions = 0;
  for (const f of files || []) {
    if (f && f.status === 'removed') removed.push(f.filename);
    deletions += (f && f.deletions) || 0;
    additions += (f && f.additions) || 0;
  }
  return {
    removed, deletions, additions,
    crossed: removed.length >= DELETION_FILE_THRESHOLD || deletions >= DELETION_LINE_THRESHOLD
  };
}

// The declaration is read from the PR body: a line beginning "Deletion intent:" and every deleted
// path named after it. The remainder of the body counts, so a wrapped list still reads.
function intentBlock(body) {
  const m = String(body || '').match(/^[ \t>*_]*Deletion intent[ \t*_]*[:—–-]/im);
  return m ? String(body || '').slice(m.index) : '';
}

// the compare API's file list for base...head — filled in by the stale-branch check below, read by
// the deletion guard after it. One fetch, two questions.
let cmpFiles = null;

// F2. A compare call that SUCCEEDS and carries no `files` key is the same blind
// state as one that throws: `cmp.files || []` turned "I never saw the diff" into "0 files deleted, PASS".
// One parser, used by the PR path and the self-test, so the blind branch cannot be lost in a rewrite.
function parseCompareFiles(cmp) {
  return cmp && Array.isArray(cmp.files) ? cmp.files : null;
}

// F3. The base this check compares against must be the CURRENT tip of the base branch, resolved by name.
// `baseRefOid` is the commit the PR was last pushed against, not where the branch is now: GitHub can answer
// a stale baseRefOid and the gate then prints "branch is current" for PRs that are several commits behind. Resolve the tip,
// compare against that, and when the two disagree print BOTH shas instead of naming one of them "master".
function resolveCompareBase(tipSha, prBaseOid) {
  const sha = tipSha || prBaseOid;
  return { sha, stale: !!(tipSha && prBaseOid && tipSha !== prBaseOid) };
}

// The decision itself, in one place, so the PR path and the self-test cannot drift apart.
// ok = true means "this PR may pass this check".
function evaluateDeletion(files, body) {
  // UNKNOWN is not a pass. When the compare call throws, the diff was NEVER SEEN, and a
  // reader cannot tell "nothing was deleted" from "I never looked". The blind state blocks, for the same reason the
  // stale-branch check warns instead of passing: a check whose blindness reads as a green is worse than no check,
  // because it is counted.
  if (!files) {
    return { crossed: true, ok: false, blind: true,
      shape: { removed: [], deletions: 0, additions: 0 },
      shapeMsg: 'the diff was never seen (the compare API returned no file list)',
      detail: 'the compare API returned no file list — the diff was never seen, so the deletion shape is UNKNOWN (UNKNOWN is not a pass)' };
  }
  const shape = deletionShape(files);
  const truncated = (files || []).length >= 300;
  const shapeMsg = shape.removed.length + ' file(s) deleted outright, ' + shape.deletions + ' line(s) deleted, '
    + shape.additions + ' added'
    + (shape.removed.length ? ' — deleted paths: ' + shape.removed.slice(0, 12).join(', ') + (shape.removed.length > 12 ? ' …' : '') : '');
  if (truncated) {
    return { crossed: true, ok: false, shape, shapeMsg,
      detail: 'the diff lists ' + (files || []).length + ' files — the compare API truncates at 300, so this diff cannot be verified here. Review it by hand and open a smaller PR.' };
  }
  if (!shape.crossed) return { crossed: false, ok: true, shape, shapeMsg, detail: shapeMsg };
  const block = intentBlock(body);
  const missing = shape.removed.filter(p => !block.includes(p));
  return { crossed: true, ok: missing.length === 0, shape, shapeMsg, missing,
    detail: missing.length === 0
      ? shapeMsg + ' — declared in the PR body'
      : shapeMsg + ' — declare it in the PR body with a line "Deletion intent: <path>, <path>"; ' + missing.length + ' deleted path(s) are not named' };
}

// --- self-test: the deletion guard's decisions, including the stale-tree revert shape -----------
// A gate nobody has tried to defeat is not known to work. This runs the SAME evaluateDeletion() the
// PR path runs, over synthetic diffs shaped like the real ones, and prints PASS/FAIL per case.
// --- the chore exemption for the linked-issue check ----------------------------------------------------
// A linked issue exists so behaviour work is traceable to a customer-visible change. A
// build-context CHORE has no customer-visible change and no issue worth filing, so it does not need one
// — but the rule has to live in the gate, not in one person's say-so, so it lives here.
//
// The shape shipped is the NARROW one: the Conventional-commit type must be `chore`, and EVERY changed
// file must be a build-context file (.dockerignore), which cannot change what the runtime does. A broad
// "chore => no issue" rule would let `chore: remove the auth check` skip the traceability the check
// exists for — the exact failure the check was written to catch. Narrow beats convenient: the CEO can
// widen this in one line if the company ever needs to, and can narrow it by removing a file from the
// whitelist. This helper is called by the PR path AND by the selftest, so deleting the rule from the PR
// path while leaving the helper cannot keep the selftest green.
function linkedIssueRule(title, filePaths, changedFiles) {
  const m = String(title || '').match(/^(feat|fix|docs|chore|refactor|test|perf|build|ci|revert)(\([^)]+\))?!?: /);
  const type = m ? m[1] : '';
  const files = Array.isArray(filePaths) ? filePaths.filter(p => typeof p === 'string' && p) : [];
  // An entry the gate could not read is UNKNOWN, not "the readable remainder": never exempt.
  const allReadable = Array.isArray(filePaths) && files.length === filePaths.length;
  // The file list must be COMPLETE. When the PR's own changedFiles count is supplied it must equal the list length; a
  // capped or paginated list (or a missing count) is UNKNOWN. A caller that passes no count skips only this half.
  const complete = changedFiles === undefined || (Number.isInteger(changedFiles) && changedFiles === files.length);
  const BUILD_CONTEXT = /(^|\/)\.dockerignore$/;
  const exempt = type === 'chore' && allReadable && complete && files.length > 0 && files.every(p => BUILD_CONTEXT.test(p));
  return { type: type, exempt: exempt, files: files };
}

// The merge-act decision, extracted so the selftest can exercise it with all the answers the external gate can give,
// including the PASSING one (a gate only ever proved against a refusal cannot be told from a broken gate).
//   res: the external gate's answer for { category: 'publish', act: 'merge' } on this PR, or null; err: why it could not be asked.
//   a row the gate ACCEPTS -> pass; a row that EXISTS and is refused -> block; no row at all -> warn;
//   the gate unreachable -> block (an unknown authorisation is not an authorisation).
function mergeActVerdict(res, err) {
  if (err) return { level: 'block', detail: 'the external gate could not be consulted (' + String(err).slice(0, 160) + ') — an unknown authorisation is not an authorisation' };
  if (res && res.allow) return { level: 'pass', detail: 'cleared by ' + (res.clearanceId || 'a clearance row') + ' (' + (res.clearedBy || 'unknown') + ')' };
  if (res && /candidates rejected/.test(String(res.reason || ''))) {
    return { level: 'block', detail: 'a clearance row names this PR and the external gate refuses it: ' + String(res.reason || '').slice(0, 240) };
  }
  return { level: 'warn', detail: 'no clearance row names this PR — the merge act is not authorised by a row (it needs a publish row with act merge naming this PR)' };
}

function runDeletionSelftest() {
  const removedPaths = (n) => Array.from({ length: n }, (_, i) => 'apps/pkg/lib/file_' + String(i).padStart(2, '0') + '.dart');
  const shapeFiles = (removedCount, deletions, additions) => removedPaths(removedCount)
    .map(p => ({ filename: p, status: 'removed', additions: 0, deletions: Math.ceil(deletions / Math.max(removedCount, 1)) }))
    .concat([{ filename: 'apps/pkg/lib/kept.dart', status: 'modified', additions, deletions: 0 }]);
  const decl = (paths) => 'Deletion intent: ' + paths.join(', ');
  const cases = [
    { n: 'stale-tree revert shape, nothing declared -> BLOCKS', f: shapeFiles(64, 10761, 1490), b: 'Author: Alex\n', want: false },
    { n: 'stale-tree revert shape, ALL deleted paths declared -> passes', f: shapeFiles(64, 10761, 1490), b: 'Author: Alex\n\n' + decl(removedPaths(64)), want: true },
    { n: 'stale-tree revert shape, 63 of 64 paths declared -> still BLOCKS', f: shapeFiles(64, 10761, 1490), b: 'Author: Alex\n\n' + decl(removedPaths(63)), want: false },
    { n: 'small PR shape (2 files, 0 deleted, 49 deletions) -> passes', f: [{ filename: 'api/src/a.ts', status: 'modified', additions: 236, deletions: 49 }], b: 'Author: Sam', want: true },
    { n: 'small PR shape B (3 files, 0 deleted, 2 deletions) -> passes', f: [{ filename: 'api/src/b.ts', status: 'modified', additions: 193, deletions: 2 }], b: 'Author: Sam', want: true },
    { n: 'boundary: exactly 5 files deleted outright -> BLOCKS', f: shapeFiles(5, 100, 10), b: 'Author: Alex', want: false },
    { n: 'boundary: 4 files deleted outright -> passes', f: shapeFiles(4, 100, 10), b: 'Author: Alex', want: true },
    { n: 'boundary: 2000 deleted lines -> BLOCKS', f: shapeFiles(1, 2000, 0), b: 'Author: Alex', want: false },
    { n: 'boundary: 1999 deleted lines -> passes', f: shapeFiles(1, 1999, 0), b: 'Author: Alex', want: true },
    { n: 'a diff the compare API truncated (300 files) -> BLOCKS', f: shapeFiles(299, 10, 0), b: 'Author: Alex', want: false },
    { n: 'the word "intentional" does not open a declaration', f: shapeFiles(6, 100, 0), b: 'Author: Alex\n\nThis was intentional.\n', want: false },
    { n: 'a declaration on a markdown quote line is read', f: shapeFiles(2, 100, 0), b: 'Author: Alex\n\n> Deletion intent: ' + removedPaths(2).join(', '), want: true }
    , { n: 'the compare API threw (no file list) -> BLOCKS, UNKNOWN is not a pass', f: null, b: 'Author: Alex', want: false }
  ];
  let bad = 0;
  for (const c of cases) {
    const got = evaluateDeletion(c.f, c.b).ok;
    const ok = got === c.want;
    if (!ok) bad++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + c.n + '  (expected ' + (c.want ? 'pass' : 'block') + ', got ' + (got ? 'pass' : 'block') + ')');
  }
  // F2/F3 cases. These drive the two helpers the PR path calls rather than a copy of
  // them, because the defects lived in the CALLER: `cmp.files || []` (a parsed response with no list became an
  // empty one) and comparing against the PR's base field instead of the branch tip. Mutate either helper back
  // and these go red — that is the point of them.
  const gateCases = [
    { n: 'compare payload with no files key -> BLOCKS (F2)', want: false,
      got: evaluateDeletion(parseCompareFiles({ behind_by: 0, merge_base_commit: { sha: 'a' } }), 'Author: Alex').ok },
    { n: 'compare payload with files: [] -> passes (an empty diff is legitimate, F2)', want: true,
      got: evaluateDeletion(parseCompareFiles({ files: [], behind_by: 0 }), 'Author: Alex').ok },
    { n: 'compare payload with a files list -> that list is what gets judged (F2)', want: false,
      got: evaluateDeletion(parseCompareFiles({ files: shapeFiles(6, 100, 0) }), 'Author: Alex').ok },
    { n: 'PR base field behind the tip -> compare against the TIP (F3)', want: true,
      got: resolveCompareBase('bbbbbbbb', 'aaaaaaaa').sha === 'bbbbbbbb' },
    { n: 'PR base field behind the tip -> the line reports stale so both shas are printed (F3)', want: true,
      got: resolveCompareBase('bbbbbbbb', 'aaaaaaaa').stale },
    { n: 'PR base field equal to the tip -> not stale (F3)', want: false,
      got: resolveCompareBase('aaaaaaaa', 'aaaaaaaa').stale },
    { n: 'tip unresolvable -> falls back to the PR base field (F3)', want: true,
      got: resolveCompareBase(null, 'aaaaaaaa').sha === 'aaaaaaaa' }
  ];
  for (const c of gateCases) {
    const ok = c.got === c.want;
    if (!ok) bad++;
    console.log((ok ? '  PASS  ' : '  FAIL  ') + c.n + '  (expected ' + (c.want ? 'pass' : 'block') + ', got ' + (c.got ? 'pass' : 'block') + ')');
  }
  // Acceptance-record cases (a missing record WARNs during qa-sign.js's grace period and BLOCKs after it). These call `evaluateRecord` — the function the PR path calls — not a
  // copy of its logic, so deleting the call from the PR path and leaving the helper would not keep them green... except
  // that the last case drives the PR-path wiring itself through QA_VERDICT_DIR, which is the half a helper test cannot
  // see. Each case is red if its rule is reverted: warn->block, the head comparison, the file comparison, or UNKNOWN.
  // qa-sign.js is optional in the framework: absent = these cases are skipped (the PR path then WARNs); present but
  // unloadable = FAIL. The deadline is qa-sign.js's own config, so "before" is the epoch and "after" is far future.
  const qaInstalled = fs.existsSync(path.join(__dirname, 'qa-sign.js'));
  let evaluateRecord = null;
  if (qaInstalled) { try { evaluateRecord = require(path.join(__dirname, 'qa-sign.js')).evaluateRecord; } catch (_) { evaluateRecord = null; } }
  const BEFORE_DEADLINE = 0;
  const AFTER_DEADLINE = Date.parse('2999-01-01T00:00:00Z');
  const qaRec = { sha: 'a1f5390c', base: 'bbbbbbbb', files: ['api/a.ts', 'api/b.ts'], verdict: 'accept' };
  const qaCases = !qaInstalled ? [] : !evaluateRecord ? [{ n: 'acceptance record: qa-sign.js could not be required -> this is a BLOCK, not a skip', ok: false }] : [
    { n: 'acceptance record: none, inside any grace period -> WARN or BLOCK, never a pass', ok: evaluateRecord(null, 'a1f5390c', ['api/a.ts'], BEFORE_DEADLINE).level !== 'pass' },
    { n: 'acceptance record: none, after the grace period -> BLOCKS', ok: evaluateRecord(null, 'a1f5390c', ['api/a.ts'], AFTER_DEADLINE).level === 'block' },
    { n: 'acceptance record: names this head and the same files -> PASSES', ok: evaluateRecord(qaRec, 'a1f5390c', ['api/b.ts', 'api/a.ts'], BEFORE_DEADLINE).level === 'pass' },
    { n: 'acceptance record: one file added at merge time -> BLOCKS (the tree moved under the signature)', ok: evaluateRecord(qaRec, 'a1f5390c', ['api/a.ts', 'api/b.ts', 'api/c.ts'], BEFORE_DEADLINE).level === 'block' },
    { n: 'acceptance record: names another head -> BLOCKS', ok: evaluateRecord(qaRec, 'dddddddd', ['api/a.ts', 'api/b.ts'], BEFORE_DEADLINE).level === 'block' },
    { n: 'acceptance record: merge-time file list unavailable -> BLOCKS (UNKNOWN is not a pass)', ok: evaluateRecord(qaRec, 'a1f5390c', null, BEFORE_DEADLINE).level === 'block' },
    { n: 'acceptance record: a REJECT on this head -> BLOCKS (a veto is not a clause in a green line)', ok: evaluateRecord({ ...qaRec, verdict: 'reject', agent: 'qa', basis: 'record 4711 was written twice, repro `bash scratch/qa/pair-probe.sh`' }, 'a1f5390c', ['api/a.ts', 'api/b.ts'], BEFORE_DEADLINE).level === 'block' }
  ];
  if (!qaInstalled) console.log('  skip  acceptance-record cases — company/tools/qa-sign.js is not installed');
  for (const c of qaCases) {
    if (!c.ok) bad++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n);
  }
  // Chore-exemption cases. These drive `linkedIssueRule` — the same
  // function the PR path calls — so the rule cannot be deleted from the PR path and left in a helper.
  const choreCases = [
    { n: 'chore + only a root .dockerignore -> exempt', ok: linkedIssueRule('chore: add a root .dockerignore to trim the build context', ['.dockerignore']).exempt },
    { n: 'chore + only a service .dockerignore -> exempt', ok: linkedIssueRule('chore: trim the api build context', ['api/.dockerignore']).exempt },
    { n: 'feat + only a .dockerignore -> NOT exempt (the type must be chore)', ok: !linkedIssueRule('feat: add a root .dockerignore', ['.dockerignore']).exempt },
    { n: 'fix + only a .dockerignore -> NOT exempt', ok: !linkedIssueRule('fix: add a root .dockerignore', ['.dockerignore']).exempt },
    { n: 'chore + one behaviour file -> NOT exempt (the whole diff must be build context)', ok: !linkedIssueRule('chore: add a root .dockerignore', ['.dockerignore', 'api/src/server.ts']).exempt },
    { n: 'chore + an empty file list -> NOT exempt (UNKNOWN is not a pass)', ok: !linkedIssueRule('chore: add a root .dockerignore', []).exempt },
    { n: 'chore + a null file list -> NOT exempt', ok: !linkedIssueRule('chore: add a root .dockerignore', null).exempt },
    { n: 'a title that is not conventional-commit -> NOT exempt', ok: !linkedIssueRule('update the dockerignore', ['.dockerignore']).exempt },
    { n: 'chore + .dockerignore + .gitignore -> NOT exempt (.gitignore is not whitelisted)', ok: !linkedIssueRule('chore: ignore files', ['.dockerignore', '.gitignore']).exempt },
    { n: 'complete list: chore + .dockerignore + an unreadable (null) entry -> NOT exempt', ok: !linkedIssueRule('chore: x', ['.dockerignore', null]).exempt },
    { n: 'complete list: chore + .dockerignore + an empty-path entry -> NOT exempt', ok: !linkedIssueRule('chore: x', ['.dockerignore', '']).exempt },
    { n: 'complete list: changedFiles 1 matches a 1-entry list -> exempt', ok: linkedIssueRule('chore: x', ['.dockerignore'], 1).exempt },
    { n: 'complete list: changedFiles 150 but the list holds 1 .dockerignore -> NOT exempt (capped list)', ok: !linkedIssueRule('chore: x', ['.dockerignore'], 150).exempt },
    { n: 'complete list: changedFiles missing (null from the PR view) -> NOT exempt', ok: !linkedIssueRule('chore: x', ['.dockerignore'], null).exempt }
  ];
  for (const c of choreCases) {
    if (!c.ok) bad++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n);
  }
  // Verdict-reader cases.
  // They run the REAL parsing block out of this file rather than a copy of it — a copy stays green while the
  // shipped block goes back to failing open, which is how the defect got a certifying green in the first place.
  // If the block cannot be located the case FAILS, because unknown is not a pass.
  const reviewCases = (() => {
    // The markers are concatenated so this selftest does not itself contain the literals it searches for —
    // the risk owner's probe locates the same block the same way, and a marker spelled out here would be found first.
    const S_MARK = 'const items ' + '= []';
    const E_MARK = 'Latest independent verdict is not ' + 'REQUEST CHANGES';
    const src = fs.readFileSync(__filename, 'utf8').split('\n');
    const s = src.findIndex(l => l.includes(S_MARK));
    const e = src.findIndex(l => l.includes(E_MARK));
    if (s < 0 || e <= s) return [{ n: 'verdict reader: the parsing block could not be located -> FAIL, not a skip', ok: false }];
    const block = src.slice(s, e + 1).join('\n');
    const run = (body) => {
      const rows = [];
      const addRow = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: String(detail) });
      const fixture = {
        title: 'fix(api): a fixture title for the verdict selftest', body: 'Author: Sam\nRefs #1',
        headRefName: 'selftest/verdict', reviews: [], files: [{ path: 'api/src/x.ts' }],
        comments: [{ createdAt: '2000-01-01T00:00:00Z', author: { login: 'x' }, body }]
      };
      // eslint-disable-next-line no-new-func
      const fn = new Function('d', 'authorAgent', 'add', block + '\nreturn { named, latest, independent };');
      fn(fixture, 'Sam', addRow);
      return rows.find(r => r.name.includes('Latest independent verdict')) || { ok: null, detail: 'no row' };
    };
    const verdictCases = [
      { n: 'verdict reader: a BOLD signature (**Reviewer:** Name) is a named reviewer', body: '**Reviewer:** Alex — APPROVE\nok', want: true },
      { n: 'verdict reader: a plain signature is still a named reviewer', body: 'Reviewer: Alex — APPROVE\nok', want: true },
      { n: 'verdict reader: ACCEPT is a clearance word and is named in the detail', body: 'Reviewer: Alex\nACCEPT — the output matches the spec.', want: true, detail: /ACCEPT/ },
      { n: 'verdict reader: a named reviewer with NO verdict word BLOCKS (silence is not an approval)', body: 'Reviewer: Alex\nI read the diff and will think about it.', want: false },
      { n: 'verdict reader: an unrecognised word is quoted so the comment can be fixed from the output', body: 'Reviewer: Alex\nLOOKS FINE to me', want: false, detail: /unrecognised verdict "LOOKS FINE"/ },
      { n: 'verdict reader: REQUEST CHANGES still blocks', body: 'Reviewer: Alex — REQUEST CHANGES\nP1: typed figure.', want: false, detail: /REQUEST CHANGES/ },
      { n: 'verdict reader: APPROVE WITH COMMENTS approves', body: 'Reviewer: Alex — APPROVE WITH COMMENTS\nnits only', want: true },
      { n: 'verdict reader: the author is not an independent reviewer, bold or not', body: '**Reviewer:** Sam — APPROVE\nship it', want: false }
    ];
    return verdictCases.map(c => {
      const row = run(c.body);
      return { n: c.n, ok: row.ok === c.want && (!c.detail || c.detail.test(row.detail)) };
    });
  })();
  for (const c of reviewCases) {
    if (!c.ok) bad++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n);
  }
  // Merge-act authorisation cases: the answers the external gate can give.
  const ALLOW = { allow: true, reason: '', clearanceId: 'clr-test-0001', clearedBy: 'Alex' };
  const REFUSE_ROW = { allow: false, reason: 'no clearance row (candidates rejected — clr-x: no CEO run covers 2026-01-01T00:04:34.490Z — the row was not written inside a CEO run) — action refused' };
  const NO_ROW = { allow: false, reason: 'no clearance row — action refused' };
  const mergeAuthCases = [
    { n: 'merge act: a row the external gate ACCEPTS is a PASS (the green path, proved on a fixture)', ok: mergeActVerdict(ALLOW, null).level === 'pass' },
    { n: 'merge act: the PASS names the clearance row and who cleared it', ok: /clr-test-0001 \(Alex\)/.test(mergeActVerdict(ALLOW, null).detail) },
    { n: 'merge act: a row the gate REFUSES is a BLOCK', ok: mergeActVerdict(REFUSE_ROW, null).level === 'block' },
    { n: 'merge act: the BLOCK quotes the refusal reason', ok: /no CEO run covers/.test(mergeActVerdict(REFUSE_ROW, null).detail) },
    { n: 'merge act: no row at all is a WARN, never a block (a PR with no merge slot is not a broken PR)', ok: mergeActVerdict(NO_ROW, null).level === 'warn' },
    { n: 'merge act: the gate failing to answer is a BLOCK (unknown is not an authorisation)', ok: mergeActVerdict(null, 'ENOENT').level === 'block' },
    { n: 'merge act: the PR path asks the gate for a publish row with act merge, and a block fails the check', ok: (() => {
      const src = fs.readFileSync(__filename, 'utf8');
      return /category: 'publish', target: 'github:' \+ repo \+ '#' \+ pr,[\s\S]{0,160}act: 'merge'/.test(src) && /if \(mergeAct\.level === 'block'\) add\('The merge act is authorised', false/.test(src);
    })() }
  ];
  for (const c of mergeAuthCases) {
    if (!c.ok) bad++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n);
  }
  const guardCases = [
    { n: 'guardrail defaultBranch ON: a blocked PR exits 1', ok: verdictExit(2, true) === 1 },
    { n: 'guardrail defaultBranch OFF: a blocked PR exits 0 (the FAIL is still recorded)', ok: verdictExit(2, false) === 0 },
    { n: 'a passing PR exits 0 either way', ok: verdictExit(0, true) === 0 && verdictExit(0, false) === 0 },
    { n: 'the BLOCKED path reads the switch and still writes the FAIL record before exiting', ok: (() => { const src = fs.readFileSync(__filename, 'utf8'); const i = src.indexOf("writeEvidence('FAIL');\n  if (!co.guard('defaultBranch'))"); return i > 0 && src.indexOf("process.exit(verdictExit(failed.length, co.guard('defaultBranch')))", i) > i; })() }
  ];
  for (const c of guardCases) {
    if (!c.ok) bad++;
    console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n);
  }
  const total = cases.length + gateCases.length + qaCases.length + choreCases.length + reviewCases.length + mergeAuthCases.length + guardCases.length;
  console.log(bad ? 'SELFTEST FAILED: ' + bad + ' case(s) wrong' : 'selftest: ' + total + ' cases ok');
  process.exit(bad ? 1 : 0);
}

add('PR is open', d.state === 'OPEN', d.state);
add('PR is not a draft', !d.isDraft, d.isDraft ? 'draft' : 'ready');
let repoDefault = null;
try { repoDefault = gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']) || null; } catch (_) { repoDefault = null; }
add('Targets the default branch', repoDefault ? d.baseRefName === repoDefault : ['master', 'main'].includes(d.baseRefName),
  d.baseRefName + (repoDefault ? ' (default: ' + repoDefault + ')' : ''));
add('Conventional-commit title', /^(feat|fix|docs|chore|refactor|test|perf|build|ci|revert)(\([^)]+\))?!?: /.test(d.title), d.title);
// filePaths is needed by the linked-issue rule here AND by the merge-authority classification further
// down, so it is computed once, here.
const filePaths = (d.files || []).map(f => f.path || '');
const linked = (d.title + '\n' + (d.body || '') + '\n' + (d.headRefName || '')).match(/#\d+/);
const linkedRule = linkedIssueRule(d.title, filePaths, d.changedFiles === undefined ? null : d.changedFiles);
add('Linked issue', !!linked || linkedRule.exempt,
  linked ? linked[0]
    : (linkedRule.exempt
        ? 'exempt — ' + linkedRule.type + ' PR, build-context file(s) only: ' + linkedRule.files.join(', ')
        : 'no #issue reference'));

// author agent, declared in the PR body ("Author: <Name>") — the GitHub account is the same for everyone.
// A pattern that matches inside a word reads "…authorized…" as `author agent: ized`, passing a check about a
// declaration that was not there. Require the
// word Author at the start of a line, followed by a separator, then a capitalised name.
const authorAgent = ((d.body || '').match(/^[ \t>*_]*Author[ \t*_]*[:—–-][ \t*_]*([A-Z][A-Za-z0-9_-]*)/im) || [])[1]
  || ((d.body || '').match(/^[ \t>*_]*Author[ \t*_]+([A-Z][A-Za-z0-9_-]*)\b/m) || [])[1]
  || 'unknown';
add('Author agent is declared in the PR body', authorAgent !== 'unknown', authorAgent);

// every review/comment that names a reviewer, in chronological order; the LAST verdict wins.
//
// THIS BLOCK IS A CONTROL, AND IT HAD TWO DEFECTS PULLING OPPOSITE WAYS:
//   D2 — `Reviewer:\s*([A-Za-z]…)` wanted a LETTER straight after the colon, so a markdown-bold
//        `**Reviewer:** Name` was not a named reviewer at all, and `ACCEPT` — a reviewer's word — was not in the
//        vocabulary. A real clearance read as nobody reviewed it. That is the half that costs work.
//   D1 — `latest.verdict.indexOf('REQUEST CHANGES') < 0` is TRUE for `''`, so a reviewer who wrote no
//        verdict was a PASS with the detail "no verdict word". A check about a verdict has three
//        outcomes — approve, refuse, no verdict found — and the third is not the first. That is the half
//        that costs trust.
// They land together or not at all: adding ACCEPT alone would hand MORE comments a verdict field for
// the `< 0` test to wave through. The row NAME is deliberately unchanged — the risk owner's probe locates this
// block by its first and last lines and countersigns on the unmodified file, so renaming the row
// would void his instrument. The row's meaning is now "the latest independent verdict is an approval",
// and the detail always says which verdict it read or that it found none.
//
// KEEP THIS BLOCK SELF-CONTAINED: it is evaluated on its own by that probe and by this file's selftest,
// so it may only use `d`, `authorAgent` and `add` from its surroundings.
const items = []
  .concat((d.reviews || []).map(r => ({ at: r.submittedAt || '', by: r.author && r.author.login, body: r.body || '' })))
  .concat((d.comments || []).map(c => ({ at: c.createdAt || '', by: c.author && c.author.login, body: c.body || '' })))
  .sort((x, y) => String(x.at).localeCompare(String(y.at)));
// Declared inside the block, not above it: the probe and the selftest evaluate this slice on its own.
const REVIEWER_RE = /Reviewer[ \t*_]*[:—–-][ \t*_]*([A-Za-z][A-Za-z0-9_-]*)/i;
const VERDICT_WORDS = ['APPROVE WITH COMMENTS', 'REQUEST CHANGES', 'APPROVED', 'ACCEPT', 'APPROVE'];
const VERDICT_RE = new RegExp('\\b(' + VERDICT_WORDS.join('|') + ')\\b', 'i');
// Words a comment may shout without it being an attempt at a verdict; used only to keep the detail honest.
const VERDICT_NOISE = /^(REVIEWER|AUTHOR|PR|PRS|QA|API|UTC|CET|SHA|CI|CD|OK|ACK|ACKS|TODO|FIXME|NOTE|NOTES|BLOCK|BLOCKS|PASS|FAIL|WIP)$/;
const named = [];
for (const it of items) {
  const m = it.body.match(REVIEWER_RE) || it.body.match(/review\s*(?:—|-|:)\s*([A-Z][a-z]+)/) || it.body.match(/—\s*([A-Z][a-z]+)\s*\(/);
  const found = (it.body.match(VERDICT_RE) || [])[0];
  const verdict = found ? found.toUpperCase() : '';
  // No recognised word: quote something an operator can act on rather than reporting silence. This is
  // guidance only — the outcome below never depends on it, so a bad guess costs nothing but a re-read.
  const shout = verdict ? '' : ((it.body.match(/\b[A-Z][A-Z0-9]{2,}(?:\s+[A-Z][A-Z0-9]{2,})?\b/g) || []).find(w => !VERDICT_NOISE.test(w)) || '');
  if (m || verdict || shout) named.push({ reviewer: m ? m[1] : 'unnamed', verdict: verdict, unrecognised: shout, at: it.at });
}
const independent = named.filter(n => n.reviewer.toLowerCase() !== authorAgent.toLowerCase() && n.reviewer !== 'unnamed');
add('Independent reviewer is named', independent.length > 0, independent.length ? independent.map(n => n.reviewer).join(', ') : 'none found — post a review with "Reviewer: <Name>"');
const latest = independent.length ? independent[independent.length - 1] : null;
// D1: an empty verdict is NOT an approval. Only a recognised word that is not REQUEST CHANGES passes.
const verdictApproved = !!(latest && latest.verdict && latest.verdict.toUpperCase().indexOf('REQUEST CHANGES') < 0);
const verdictDetail = !latest ? 'n/a — no independent reviewer named'
  : latest.verdict ? latest.verdict
  : latest.unrecognised ? 'unrecognised verdict "' + latest.unrecognised + '" — accepted words: ' + VERDICT_WORDS.join(', ')
  : 'no verdict found — accepted words: ' + VERDICT_WORDS.join(', ');
add('Latest independent verdict is not REQUEST CHANGES', verdictApproved, verdictDetail);

if (a['require-evidence']) {
  const needle = String(a['require-evidence']).toLowerCase();
  const all = (d.body || '') + '\n' + items.map(i => i.body).join('\n');
  add('Evidence "' + needle + '" present', all.toLowerCase().includes(needle), all.toLowerCase().includes(needle) ? 'found' : 'missing');
}

// classify the PR from its changed files: docs-only → the CEO may merge (DECISION_RIGHTS); anything else → PM merge line
const docsOnly = filePaths.length > 0 && filePaths.every(p => p.startsWith('docs/'));
const ceoName = co.nameOf(co.ceo()) || 'the CEO';
add('PR classified for merge authority', true,
  docsOnly ? 'docs-only (' + filePaths.length + ' file(s) under docs/)'
  : 'not docs-only — PM merge line');

// --- the merge ACT must be authorised ---------------------------------------------------------------------
// This is the last place a merge can be stopped before a train or an agent merges what this gate answers PASS on. The
// external gate is asked for a publish clearance with act merge on this PR: a row it ACCEPTS is a PASS; a row that
// EXISTS and is refused is a BLOCK (a merge must not run on a row the gate rejects); a PR with NO row is only a WARN (it
// is not scheduled to merge); the gate failing to answer is a BLOCK. The gate is consulted as a MODULE with logging off
// (opts.log === null), so reading it appends nothing to the external-actions log.
const mergeAuth = (() => {
  let res = null, err = null;
  try {
    const ext = require(path.join(__dirname, 'external-gate.js'));
    res = ext.check({ category: 'publish', target: 'github:' + repo + '#' + pr,
      agent: String(process.env.STARNET_AGENT_ID || 'unknown'), act: 'merge' }, { log: null });
  } catch (e) { err = String((e && e.message) || e); }
  return { res: res, err: err };
})();
const mergeAct = mergeActVerdict(mergeAuth.res, mergeAuth.err);
if (mergeAct.level === 'block') add('The merge act is authorised', false, mergeAct.detail);
else if (mergeAct.level === 'pass') add('The merge act is authorised', true, mergeAct.detail);
else console.log('  WARN   ' + mergeAct.detail);

// Stale-branch / silent-revert detector. A PR can revert several earlier merges — a hundred files — simply
// because its branch was cut before those merged and the merge took the branch's version of every file. Nothing in this chain would have named it. Cheap pre-merge version:
// if the PR is BEHIND its base, intersect the files it changes with the files the base changed since
// the branch point; any overlap is exactly the set a merge can silently revert. Advisory by default
// (a WARN line), blocking under --strict-tree.
{
  let behindBy = null;
  let atRisk = [];
  let atRiskUnknown = false;
  let mergeBase = null;
  // Resolve the CURRENT tip of the base branch (F3). Behind a try/catch because a gate that dies on a
  // rate-limited API call blocks the queue; the failure mode below is a WARN, never a PASS.
  let tipSha = null;
  try {
    const ref = JSON.parse(gh(['api', 'repos/' + repo + '/git/ref/heads/' + d.baseRefName]));
    tipSha = (ref && ref.object && ref.object.sha) || null;
  } catch (_) { tipSha = null; }
  const base = resolveCompareBase(tipSha, d.baseRefOid || d.baseRefName);
  const baseSha = base.sha;
  const baseNote = base.stale
    ? 'current tip ' + String(baseSha).slice(0, 8) + ', the PR\'s base field still says ' + String(d.baseRefOid).slice(0, 8)
    : 'base ' + String(baseSha).slice(0, 8);
  try {
    // Compare BASE...HEAD. This call had the two sides reversed (head...base), so `behind_by` counted the
    // PR's OWN commits and `files` was the PR's own diff — the detector then flagged the PR's files as
    // "files the base changed" and named reverts that never existed.
    const cmp = JSON.parse(gh(['api', 'repos/' + repo + '/compare/' + baseSha + '...' + d.headRefOid]));
    cmpFiles = parseCompareFiles(cmp);
    behindBy = typeof cmp.behind_by === 'number' ? cmp.behind_by : null;
    mergeBase = cmp.merge_base_commit && cmp.merge_base_commit.sha;
    if (behindBy && mergeBase && mergeBase !== baseSha) {
      // The files the BASE changed since the branch point: merge_base...base.
      const baseCmp = JSON.parse(gh(['api', 'repos/' + repo + '/compare/' + mergeBase + '...' + baseSha]));
      const baseMoved = parseCompareFiles(baseCmp);
      if (baseMoved) {
        const moved = new Set(baseMoved.map(f => f.filename));
        atRisk = filePaths.filter(p => moved.has(p));
      } else {
        atRiskUnknown = true;   // the blind state again: never report "no overlap" for a list we did not get
      }
    }
  } catch (_) { behindBy = null; }
  if (behindBy === null) {
    console.log('  WARN   stale-branch check could not run (compare API error) — silent-revert risk is UNKNOWN');
  } else if (!tipSha) {
    console.log('  WARN   could not resolve the tip of ' + d.baseRefName + ' (git/ref call failed) — whether the branch is current is UNKNOWN; compared only against the PR\'s base field ' + String(baseSha).slice(0, 8) + ', behind_by ' + behindBy);
  } else if (behindBy === 0) {
    console.log('  PASS   branch is current with ' + d.baseRefName + ' (' + baseNote + ') — no files a merge could silently revert');
  } else {
    // Content identity decides the risk, not the file NAME (`git diff <base> <head> -- <files>` can be 0 lines
    // for files a name-only detector names). Same blob sha at base and head = identical content = no revert risk.
    const identical = [];
    if (atRisk.length && baseSha) {
      const stillAtRisk = [];
      for (const p of atRisk) {
        try {
          const a = JSON.parse(gh(['api', 'repos/' + repo + '/contents/' + p + '?ref=' + baseSha]));
          const b = JSON.parse(gh(['api', 'repos/' + repo + '/contents/' + p + '?ref=' + d.headRefOid]));
          if (a.sha && b.sha && a.sha === b.sha) identical.push(p); else stillAtRisk.push(p);
        } catch (_) { stillAtRisk.push(p); } // unknown -> keep it on the risk list
      }
      atRisk = stillAtRisk;
    }
    const msg = 'branch is ' + behindBy + ' commit(s) behind ' + d.baseRefName + ' (' + baseNote
      + (mergeBase ? ', merge base ' + String(mergeBase).slice(0, 8) : '') + ')' + (atRiskUnknown
      ? ' — the list of files the base changed was not returned, so whether any of this PR\'s files would be silently reverted is UNKNOWN'
      : atRisk.length
        ? ' and ' + atRisk.length + ' file(s) it changes were also changed on the base since it was cut, with DIFFERENT content — a merge can silently revert them: ' + atRisk.slice(0, 8).join(', ') + (atRisk.length > 8 ? ' …' : '')
        : ' — no file it changes has different content at the base tip'
          + (identical.length ? ' (content identical, no revert risk: ' + identical.slice(0, 8).join(', ') + (identical.length > 8 ? ' …' : '') + ')' : ''));
    if (a['strict-tree'] && atRisk.length) add('No silent revert against a moved base', false, msg);
    else if (a['strict-tree'] && atRiskUnknown) add('No silent revert against a moved base', false, msg);
    else console.log('  WARN   ' + msg);
  }
}

// Deletion-shaped-change guard (see deletionShape above). It runs whether or not the branch was
// behind: on a stale-tree revert the branch is current and the ancestry detector said PASS, which is the whole
// point. The compare API lists at most 300 files, so a diff that big is treated as unverified and
// blocked rather than passed (a guard that cannot see the diff is not a guard).
{
  const verdict = evaluateDeletion(cmpFiles, d.body);
  if (verdict.crossed) {
    add('Deletion-shaped change is declared', verdict.ok, verdict.detail);
    if (verdict.blind) {
      console.log('  BLOCK  ' + verdict.detail);
    } else {
      console.log((verdict.ok ? '  WARN   ' : '  BLOCK  ') + verdict.shapeMsg + (verdict.ok
        ? ' — declared in the PR body'
        : ' — NOT declared in the PR body (the gate blocks it)'));
    }
  } else {
    console.log('  PASS   deletion shape is small (' + verdict.shape.removed.length + ' file(s) deleted outright, ' + verdict.shape.deletions + ' line(s) deleted)');
  }
}

// Test-substrate evidence. A code-touching PR must show a passing run from the company's test substrate, recorded
// as company/work/engineering/evidence/<headSha>.json with at least {verdict:"pass", command, ranAt}. The convention
// goes LIVE the moment company/work/engineering/test-substrate.md exists; until then it is one WARN line, because a blocking check against a suite that does
// not exist would block every PR. QA's "Reviewer: <Name> — <verdict>" comment satisfies the named-reviewer check
// above and the QA verdict at once: one comment, one record, deliberately.
{
  const sha = d.headRefOid || '';
  const short = sha ? sha.slice(0, 8) : 'this head';
  const substrateLive = fs.existsSync(co.p('company', 'work', 'engineering', 'test-substrate.md'));
  let ev = null;
  try { ev = JSON.parse(fs.readFileSync(co.p('company', 'work', 'engineering', 'evidence', sha + '.json'), 'utf8')); } catch (_) {}
  // The record's contract is written by the test-substrate runner: `verdict` covers the REQUIRED
  // lanes, `ranAt` is the run time, and `dirty_files` must be 0 — a record taken over a
  // tree with uncommitted edits does not describe the commit it names (test-substrate.md §7a).
  const stamp = ev && (ev.ranAt || ev.at);
  const clean = !ev || ev.dirty_files === undefined || Number(ev.dirty_files) === 0;
  const ok = !!(ev && String(ev.verdict || '').toLowerCase() === 'pass' && ev.command && stamp && clean);
  if (docsOnly) {
    // A docs-only PR cannot change what the substrate runs, and DECISION_RIGHTS already routes it to the CEO.
    // Requiring a test record here would block the one merge route the company granted itself.
    add('Test-substrate run record', true, 'docs-only (' + filePaths.length + ' file(s) under docs/) — exempt');
  } else if (substrateLive || ok) {
    add('Test-substrate run recorded for ' + short, ok,
      ok ? String(ev.command).slice(0, 40) + ' @ ' + stamp
           + (ev.advisory && ev.advisory.verdict ? ' · advisory: ' + ev.advisory.verdict : '')
         : (ev && !clean)
           ? 'record is over a dirty tree (' + ev.dirty_files + ' uncommitted file(s)) — re-run on the committed head'
           : 'missing — run the substrate and save company/work/engineering/evidence/' + short + '.json');
  } else if (!docsOnly) {
    console.log('  WARN   no test-substrate evidence for ' + short + ': the substrate note (company/work/engineering/test-substrate.md) is not written yet — this becomes a BLOCK check the day it exists');
  }
}

// QA acceptance record (a missing record WARNs during qa-sign.js's grace period and BLOCKs after it). The record lives in work/engineering/verdicts/pr-<n>.json, written by company/tools/qa-sign.js
// and never by hand. Sits beside the substrate check on purpose: two proofs, one screen — proof that the suite ran, and
// proof that a named agent accepted THIS commit. The question it answers is the one a signature alone cannot: does the
// record name this head, and does the file list it read still match the PR's at merge time? A changed tree under a
// signature BLOCKs; an unfetchable list is UNKNOWN, which BLOCKs; a missing record follows qa-sign.js's grace period.
// qa-sign.js is an optional framework tool: when it is not installed this check is one WARN line (a deletion of an
// installed checker is visible to locked-watch.js); when it is installed but cannot load, that is a BLOCK.
if (!fs.existsSync(path.join(__dirname, 'qa-sign.js'))) {
  console.log('  WARN   no acceptance-record checker installed (company/tools/qa-sign.js) — the QA record was not checked');
} else {
  const dir = process.env.QA_VERDICT_DIR || co.p('company', 'work', 'engineering', 'verdicts');
  const file = path.join(dir, 'pr-' + d.number + '.json');
  let rec = null, recWhy = '';
  if (fs.existsSync(file)) {
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { recWhy = 'unparseable'; }
  }
  let nowFiles = null;
  try {
    const rows = gh(['api', 'repos/' + repo + '/pulls/' + d.number + '/files', '--paginate', '--jq', '.[].filename']).split('\n').filter(Boolean);
    nowFiles = rows.length ? rows : null;   // an empty list is a blind state, not an empty diff
  } catch (_) { nowFiles = null; }
  let evaluate = null;
  try { evaluate = require(path.join(__dirname, 'qa-sign.js')).evaluateRecord; } catch (_) { evaluate = null; }
  let qa;
  if (recWhy === 'unparseable') {
    qa = { ok: false, level: 'block', msg: 'the acceptance record ' + path.relative(co.p('company'), file) + ' is not parseable JSON — UNKNOWN is not a pass' };
  } else if (!evaluate) {
    // A deleted checker is not evidence that the PR is fine: an absent qa-sign.js is a tooling defect, and reading it
    // as "nothing to check" would make deleting one file the way past this line.
    qa = { ok: false, level: 'block', msg: 'company/tools/qa-sign.js is missing, so the acceptance record cannot be checked — UNKNOWN is not a pass' };
  } else {
    qa = evaluate(rec, d.headRefOid || '', nowFiles);
  }
  if (qa.level === 'block') add('Acceptance record matches the tree at merge time', false, qa.msg);
  else console.log('  ' + (qa.level === 'pass' ? 'PASS   ' : 'WARN   ') + qa.msg);
}

const failed = checks.filter(c => !c.ok);
// The department lead's advice (lib/consult.js premergeAdvice): advisory, never a check, never the exit code. Fail-safe.
let leadAdvice = null;
try { leadAdvice = require('./lib/consult').premergeAdvice({ repo, pr: d.number, head: d.headRefOid || '', authorAgent, title: d.title }); } catch (_) { leadAdvice = null; }
// Evidence record (competence v1, review D "nothing enforces the gate"): every completed run leaves
// company/work/evidence/premerge-<repo>-<headSha>.json with PASS or FAIL, so the post-merge audit
// (company/tools/competence.js) can tell a merge that passed this gate from one that skipped it. Silent and
// Guardrail defaultBranch (company/tools/guardrails.js, owner-only): OFF keeps every check and the FAIL record, but a
// blocked PR exits 0 so nothing waits on the gate. ON (the default, and any unreadable state) blocks with exit 1.
function verdictExit(failedCount, guardOn) { return failedCount && guardOn ? 1 : 0; }

// best-effort: it never changes this script's output or exit code. A later run on the same head replaces the
// verdict and keeps the earlier ones in `history` (the last 20, plus every PASS: a re-run after the merge records
// FAIL because the PR is no longer open, and the audit still needs the PASS the merge relied on).
function writeEvidence(verdict) {
  try {
    const sha = d.headRefOid || '';
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return;
    const dir = co.p('company', 'work', 'evidence');
    const file = path.join(dir, 'premerge-' + repo.split('/').pop().replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + sha + '.json');
    let prev = null; try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
    const all = ((prev && prev.history) || []).concat(prev ? [{ verdict: prev.verdict, at: prev.at }] : []);
    const history = all.filter((h, i) => (h && String(h.verdict).toUpperCase() === 'PASS') || i >= all.length - 20);
    const rec = { v: 1, tool: 'company/tools/premerge-check.js', repo, pr: d.number, sha, base: d.baseRefName || '', verdict, at: new Date().toISOString(),
      authorAgent, docsOnly, failed: failed.length, checks: checks.map(c => ({ name: c.name, ok: c.ok })), history };
    if (leadAdvice && leadAdvice.lead) rec.lead = leadAdvice.lead;   // advisory: { verdict: APPROVE|REVISE|null, by, consult, check, advisory: true }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid; const txt = JSON.stringify(rec, null, 1) + '\n';
    fs.writeFileSync(tmp, txt); fs.renameSync(tmp, file);
    try { require('./provenance.js').wrote(file, txt, 'premerge-check.js'); } catch (_) {}   // locked-watch.js: a PASS this tool wrote, not a hand-made one
  } catch (_) {}
}
console.log('PRE-MERGE GATE — ' + repo + ' PR #' + d.number + ' (' + d.headRefName + ' → ' + d.baseRefName + ')');
console.log('author agent: ' + authorAgent + ' · mergeable: ' + (d.mergeable || 'unknown') + ' · files: ' + ((d.files || []).length));
for (const c of checks) console.log((c.ok ? '  PASS  ' : '  BLOCK ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
if (leadAdvice) console.log('  INFO  Lead\'s advice (advisory)  [' + leadAdvice.words + (leadAdvice.opened ? '; asked in ' + leadAdvice.opened : '') + '; never blocks]');
console.log('');
if (failed.length) {
  console.log('BLOCKED by ' + failed.length + ' check(s). GitHub cannot enforce this repo (Free private): this script is the gate.');
  writeEvidence('FAIL');
  if (!co.guard('defaultBranch')) console.log('UNGUARDED: the defaultBranch guardrail is OFF (the owner\'s switch, company/tools/guardrails.js): the FAIL is recorded, but the gate does not block (exit 0).');
  process.exit(verdictExit(failed.length, co.guard('defaultBranch')));
}
// The printed command has to be the one the company actually uses: merge commits are the common practice, so a
// --squash line would tell every merger to do something different from practice. Default is --merge;
// `--merge-mode squash|merge|rebase` overrides it and the head pin is kept either way.
const mergeMode = String(a['merge-mode'] || 'merge');
if (!['merge', 'squash', 'rebase'].includes(mergeMode)) { console.log('usage: --merge-mode merge|squash|rebase'); process.exit(2); }
const mergeCmd = 'gh pr merge ' + d.number + ' --repo ' + repo + ' --' + mergeMode + ' --match-head-commit ' + d.headRefOid;
if (docsOnly) {
  console.log('PASS — docs-only: ' + ceoName + ' (CEO) may merge (DECISION_RIGHTS, docs-only).');
  console.log('merge: ' + mergeCmd);
} else {
  console.log('PASS — safe to ask the PM to merge (merging itself remains a named human gate unless the PM grants it).');
  console.log('merge: ' + mergeCmd);
}
writeEvidence('PASS');
process.exit(0);
