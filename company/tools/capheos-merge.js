#!/usr/bin/env node
/* capheos-merge.js — the merge tool: the one way the crew merges a pull request (the framework's, CaPheOS, above all).
 *
 *   node company/tools/capheos-merge.js merge <pr> --by <seat> [--repo owner/name] [--method squash|merge|rebase] [--dry-run]
 *        merges only when the PR is open, not a draft, targets the default branch, and GitHub's checks on its head are all
 *        green (at least one check). A repo with no checks at all needs the pre-merge PASS (premerge-check.js) and a local pass of
 *        scripts/test.sh on the exact head commit (a temporary detached worktree; lib/local-tests.js; GitHub Actions is off).
 *        The counterpart sign-off and the accountable lead's accept (lib/signoff.js, lib/accountable.js) are asked as
 *        merge-gate.js asks them; they refuse only when their department/profile is live, so they cost nothing when off.
 *        Then: a pre-merge PASS record for the head (what merge-gate.js and default-branch-watch.js read), `gh pr merge
 *        --match-head-commit <head>` run with the merge tool's token (merge-gate.js check-gh lets it through when
 *        selfimprove.json requireMergeTool is on), and one row in company/state/capheos-merges.jsonl with the merge commit,
 *        which the tripwire (capheos-main-watch.js) and the staged update (staged-update.js) treat as a gated merge.
 *   node company/tools/capheos-merge.js test <pr> [--repo owner/name]
 *        the long step on its own: runs the suite on the PR head (lib/local-tests.js), prints JSON, exit 0 pass / 1 fail,
 *        and caches a pass per head sha. An agent's `merge` on a repo with no GitHub checks refuses until that pass exists
 *        (shell.exec caps a call at 10 minutes), so start it with notify-when.js and merge when it ends:
 *          node company/tools/notify-when.js --seat <seat> --why "tests for #<pr>" -- node company/tools/capheos-merge.js test <pr>
 *        A person running `merge` by hand gets the suite inline instead.
 *   node company/tools/capheos-merge.js baseline --by owner [--repo owner/name] [--sha <sha>]
 *        the owner takes main's head (or --sha) as known-good: a baseline row, so commits that landed before the pipeline
 *        (or by the owner's own hand) do not block the staged update forever. Owner only.
 *   node company/tools/capheos-merge.js hook <checkout>     install the merge gate's pre-push hook into a checkout
 *   node company/tools/capheos-merge.js list [--n 20]       the newest merge rows
 */
'use strict';
const fs = require('fs');
const path = require('path');
const co = require('./lib/company');
const SI = require('./lib/selfimprove');

const a = process.argv.slice(2);
const cmd = a[0];
const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
const die = (msg, code) => { console.error('capheos-merge: ' + msg); process.exit(code || 1); };

function merge() {
  const cfg = SI.config();
  const pr = a[1]; if (!/^\d+$/.test(String(pr || ''))) die('usage: merge <pr number> --by <seat>', 2);
  const by = opt('by'); if (!by || by === true) die('--by <seat> is required', 2);
  const repo = opt('repo') && opt('repo') !== true ? opt('repo') : cfg.repo;
  const method = ['squash', 'merge', 'rebase'].includes(opt('method')) ? opt('method') : 'squash';
  const d = SI.ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'number,state,isDraft,baseRefName,headRefName,headRefOid,title,author']);
  const def = SI.ghJson(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']) || 'main';
  if (d.state !== 'OPEN') die(repo + ' #' + pr + ' is ' + d.state + ', not open');
  if (d.isDraft) die(repo + ' #' + pr + ' is a draft');
  if (d.baseRefName !== def) die(repo + ' #' + pr + ' targets ' + d.baseRefName + ', not the default branch ' + def + ' (merge-tool rows are for the default branch)');
  const head = d.headRefOid;
  const ci = SI.ciOf(repo, head);
  let rule; let lt = null;
  if (ci.runs) {
    if (!ci.green) die(repo + ' #' + pr + ' head ' + head.slice(0, 8) + ': CI is not green (' + (ci.pending.length ? 'running: ' + ci.pending.join(', ') : '') + (ci.failed.length ? ' failed: ' + ci.failed.join(', ') : '') + '); fix it and run again', 3);
    rule = 'ci-green (' + ci.runs + ' check(s))';
  } else {
    const ev = path.join(co.p('company', 'work', 'evidence'), 'premerge-' + repo.split('/').pop() + '-' + head + '.json');
    const e = SI.readJ(ev, null);
    if (!e || e.verdict !== 'PASS') die(repo + ' has no CI checks and head ' + head.slice(0, 8) + ' has no pre-merge PASS: run `node company/tools/premerge-check.js --pr ' + pr + ' --repo ' + repo + '` first', 3);
    // GitHub Actions is off: the suite runs here, on the exact head commit (lib/local-tests.js); a pass is cached per sha
    let agent = false; try { agent = require('./lib/guardrails').isAgentCaller(); } catch (_) {}
    lt = require('./lib/local-tests').gate({ root: co.ROOT, repo, head, pr, by, agent, repoOpt: opt('repo') && opt('repo') !== true, evDir: co.p('company', 'work', 'evidence') });
    if (!lt.ok) die(repo + ' #' + pr + ' head ' + head.slice(0, 8) + ': ' + lt.reason, 3);
    rule = 'local-tests-pass + premerge-pass';
  }
  // the wave-3 checks, as merge-gate.js asks them: a broken or absent library never refuses
  for (const [lib, args] of [['./lib/signoff', { seat: by, kind: 'merge', refs: ['pr:' + repo + '#' + pr], sha: head, via: 'capheos-merge.js' }],
    ['./lib/accountable', { seat: by, refs: ['pr:' + repo + '#' + pr], sha: head, info: () => SI.ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName,author,body,commits']) }]]) {
    let g = null; try { g = require(lib).gate(args); } catch (_) { g = null; }
    if (g && g.refuse) die(repo + ' #' + pr + ': ' + g.refuse, 3);
  }
  // no company's own names in what the PR adds (docs/PORTING.md rule 1; the words come from the companies on this machine)
  let leaks = [];
  try {
    const df = require('child_process').spawnSync('/usr/bin/gh', ['pr', 'diff', String(pr), '--repo', repo], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
    if (df.status === 0) leaks = require('../../scripts/check-deployment-leaks.js').scanDiff(df.stdout);
  } catch (_) { leaks = []; }
  if (leaks.length) die(repo + ' #' + pr + ' adds a company\'s own words (crew, owner or company names) on ' + leaks.length + ' line(s): ' + leaks.slice(0, 5).map(h => h.file + ':' + h.line).join(', ') + ' — use neutral examples (docs/PORTING.md rule 1), then push again', 3);
  if (opt('dry-run')) { console.log(JSON.stringify({ ok: true, dryRun: true, repo, pr: Number(pr), head, rule, tests: lt ? lt.tests : undefined })); return; }
  // the PASS record merge-gate.js and default-branch-watch.js read, so the gated merge is a known one to both
  const evDir = co.p('company', 'work', 'evidence'); fs.mkdirSync(evDir, { recursive: true });
  const evf = path.join(evDir, 'premerge-' + repo.split('/').pop() + '-' + head + '.json');
  const prev = SI.readJ(evf, null);
  if (!prev || prev.verdict !== 'PASS') fs.writeFileSync(evf, JSON.stringify({ sha: head, verdict: 'PASS', repo, pr: Number(pr), by, via: 'capheos-merge.js', rule, at: new Date().toISOString(), history: prev ? [prev] : [] }, null, 1) + '\n');
  const token = SI.issueToken();
  const env = Object.assign({}, process.env, { [SI.TOKEN_ENV]: token, GH_PROMPT_DISABLED: '1' });
  const m = SI.gh(['pr', 'merge', pr, '--repo', repo, '--' + method, '--match-head-commit', head], { env });
  SI.dropToken();
  if (!m.ok) die('gh pr merge failed: ' + m.err.split('\n')[0]);
  let mc = null;
  for (let i = 0; i < 10 && !mc; i++) {
    try { mc = SI.ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']); } catch (_) {}
    if (!mc) require('child_process').spawnSync('sleep', ['2']);
  }
  const row = SI.appendJsonl(SI.mergesFile(), { at: new Date().toISOString(), kind: 'merge', by, repo, pr: Number(pr), title: String(d.title || '').slice(0, 160), head, mergeCommit: mc || null, method, rule, tests: lt ? lt.tests : undefined, company: co.config.name || null }, { writer: 'capheos-merge.js', root: co.ROOT });
  console.log(JSON.stringify({ ok: true, repo, pr: Number(pr), head, mergeCommit: mc, rule, recorded: path.relative(co.ROOT, SI.mergesFile()) }));
  if (!mc) console.error('capheos-merge: merged, but GitHub did not name the merge commit yet; the row has mergeCommit null (the tripwire will flag it; add it by hand with the sha)');
  return row;
}

// the long step on its own: run the suite on the PR head (cached per sha); exit 0 on a pass, 1 on a fail
function testPr() {
  const cfg = SI.config();
  const pr = a[1]; if (!/^\d+$/.test(String(pr || ''))) die('usage: test <pr number> [--repo owner/name]', 2);
  const repo = opt('repo') && opt('repo') !== true ? opt('repo') : cfg.repo;
  const d = SI.ghJson(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid']);
  const r = require('./lib/local-tests').ensure({ root: co.ROOT, repo, head: d.headRefOid, pr, evDir: co.p('company', 'work', 'evidence') });
  console.log(JSON.stringify({ ok: r.ok, repo, pr: Number(pr), head: d.headRefOid, cached: !!r.cached, tests: r.tests, reason: r.reason }));
  process.exit(r.ok ? 0 : 1);
}

function baseline() {
  const own = require('./lib/owner');
  const by = opt('by'); const why = !own.isOwnerName(by) ? 'only the owner takes a baseline (--by owner)' : own.refusal(by, 'a merge-tool baseline');
  if (why) die(why, 3);
  const cfg = SI.config(); const repo = opt('repo') && opt('repo') !== true ? opt('repo') : cfg.repo;
  const sha = opt('sha') && opt('sha') !== true ? opt('sha') : SI.ghJson(['api', 'repos/' + repo + '/commits/HEAD', '--jq', '.sha']);
  if (!/^[0-9a-f]{40}$/.test(sha)) die('need a full 40-character sha', 2);
  SI.appendJsonl(SI.mergesFile(), { at: new Date().toISOString(), kind: 'baseline', by: String(by), repo, sha }, { writer: 'capheos-merge.js', root: co.ROOT });
  console.log('baseline: ' + repo + ' ' + sha.slice(0, 10) + ' taken as known-good');
}

function hook() {
  const dir = path.resolve(a[1] || '.');
  const r = require('child_process').spawnSync(SI.REAL_GIT, ['-C', dir, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' });
  if (r.status !== 0) die('not a git checkout: ' + dir, 2);
  const hooks = path.resolve(dir, r.stdout.trim()); fs.mkdirSync(hooks, { recursive: true });
  const f = path.join(hooks, 'pre-push');
  if (fs.existsSync(f) && !/capheos-merge\.js hook/.test(fs.readFileSync(f, 'utf8'))) fs.renameSync(f, f + '.before-merge-gate');
  const gate = path.join(__dirname, 'merge-gate.js');
  const text = '#!/bin/bash\n# written by company/tools/capheos-merge.js hook: the merge gate for agents (no push to the default branch, no\n# force push, no branch deletion). Only exit 3 from the gate blocks; anything else lets the push through (soft gate).\n' +
    'GATE=' + JSON.stringify(gate) + '\nIN="$(cat)"\nif [ -r "$GATE" ] && command -v node >/dev/null 2>&1; then\n  printf \'%s\\n\' "$IN" | env -u NODE_OPTIONS -u NODE_PATH node "$GATE" check-push "$@"\n  [ $? = 3 ] && exit 1\nfi\n' +
    'if [ -x "$0.before-merge-gate" ]; then printf \'%s\\n\' "$IN" | "$0.before-merge-gate" "$@"; exit $?; fi\nexit 0\n';
  fs.writeFileSync(f, text, { mode: 0o755 });
  // locked-watch.js: this tool's own write (the hook is class F; a hook these bytes match is not a finding)
  try { require('./provenance.js').wrote(f, text, 'capheos-merge.js'); } catch (_) {}
  console.log('pre-push hook installed: ' + f);
}

if (cmd === 'merge') { try { merge(); } catch (e) { die(e.message); } }
else if (cmd === 'test') { try { testPr(); } catch (e) { die(e.message); } }
else if (cmd === 'baseline') baseline();
else if (cmd === 'hook') hook();
else if (cmd === 'list') { const n = Number(opt('n')) || 20; for (const r of SI.mergeRows().slice(-n)) console.log(JSON.stringify(r)); }
else die('usage: capheos-merge.js merge <pr> --by <seat> [--repo R] [--method squash|merge|rebase] [--dry-run] | test <pr> [--repo R] | baseline --by owner [--sha S] | hook <checkout> | list', 2);
