#!/usr/bin/env node
/* capheos-main-watch.js — the tripwire on the framework's main branch (selfimprove.json repo, CaPheOS): every commit that
 * reaches main must be a merge the merge tool made (company/state/capheos-merges.jsonl of any company under ~/Companies)
 * or one the owner took as a baseline. Anything else (a direct push, a web merge, an owner merge from a shell, a rewrite)
 * files a P0 OPEN handoff to the risk seat and an urgent plain line to the owner, once per commit.
 *
 *   node company/tools/capheos-main-watch.js tick [--force] [--dry-run]   at most every watchEveryMin (5) minutes;
 *        selfimprove.json enabled must be on (else: "off"). The dispatcher starts it on every tick.
 *   node company/tools/capheos-main-watch.js status
 * State: company/state/capheos-main-watch.json { head, at, flagged: {sha: at}, lastError }. First sight: today's head is
 * taken as it is (the owner runs `capheos-merge.js baseline` for the history before).
 * Read-only GitHub calls through /usr/bin/gh. Stops nothing; it reports.
 */
'use strict';
const fs = require('fs');
const co = require('./lib/company');
const SI = require('./lib/selfimprove');

const STATE = co.p('company', 'state', 'capheos-main-watch.json');
const save = s => { fs.mkdirSync(require('path').dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n'); };

/* judge(oldHead, newHead, compare, trusted) -> [{sha, why, subject}] pure: what on main's first-parent line from old to new
 * did not come through the merge tool. compare: GitHub's compare answer {status, commits:[{sha, parents:[{sha}], commit:{message}}]} */
function judge(oldHead, newHead, cmp, trusted) {
  if (cmp.status === 'behind' || cmp.status === 'diverged') return [{ sha: newHead, why: 'main\'s history was rewritten (' + cmp.status + ' from ' + oldHead.slice(0, 10) + ')', subject: '' }];
  const by = new Map((cmp.commits || []).map(c => [c.sha, c]));
  const bad = [];
  let cur = newHead, n = 0;
  while (cur && cur !== oldHead && n++ < 300) {
    const c = by.get(cur);
    if (!trusted.has(cur)) bad.push({ sha: cur, why: 'reached main without the merge tool', subject: c ? String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 120) : '' });
    // an owner baseline vouches for the commit AND the history before it (a multi-commit push is baselined at its head);
    // a gated merge's own row covers only its merge commit, so the walk goes on below it
    const t = trusted.get(cur); if (t && t.kind === 'baseline') break;
    if (!c) break;                                  // past what GitHub listed: stop (a long backlog is judged in part)
    cur = (c.parents && c.parents[0] && c.parents[0].sha) || null;
  }
  return bad;
}

function tick(o) {
  const cfg = SI.config();
  if (!cfg.enabled && !o.force) return 'CAPHEOS MAIN WATCH: off (selfimprove.json enabled is false)';
  const s = SI.readJ(STATE, {}) || {};
  if (!o.force && s.at && Date.now() - Date.parse(s.at) < cfg.watchEveryMin * 60e3 - 15e3) return 'CAPHEOS MAIN WATCH: skipped, checked ' + s.at;
  const repo = cfg.repo;
  let head;
  try { head = SI.ghJson(['api', 'repos/' + repo + '/commits/HEAD', '--jq', '.sha']); }
  catch (e) { s.lastError = e.message.slice(0, 200); s.at = new Date().toISOString(); if (!o.dryRun) save(s); throw e; }
  if (!s.head) { s.head = head; s.at = new Date().toISOString(); s.flagged = s.flagged || {}; if (!o.dryRun) save(s); return 'CAPHEOS MAIN WATCH: first sight, ' + repo + ' main ' + head.slice(0, 10) + ' taken as it is'; }
  if (s.head === head) { s.at = new Date().toISOString(); delete s.lastError; if (!o.dryRun) save(s); return 'CAPHEOS MAIN WATCH: ' + repo + ' main unchanged (' + head.slice(0, 10) + ')'; }
  const cmp = SI.ghJson(['api', 'repos/' + repo + '/compare/' + s.head + '...' + head, '--jq', '{status, commits: [.commits[] | {sha, parents: [.parents[] | {sha}], commit: {message: .commit.message}}]}']);
  const bad = judge(s.head, head, cmp, SI.trustedShas()).filter(b => !(s.flagged || {})[b.sha]);
  // a merge made in the last few minutes may not have its row yet (GitHub names the merge commit a little later): wait once
  const young = bad.length && !o.force && !s.pendingSince ? true : false;
  if (young) { s.pendingSince = new Date().toISOString(); s.at = new Date().toISOString(); if (!o.dryRun) save(s); return 'CAPHEOS MAIN WATCH: ' + bad.length + ' unrecorded commit(s) on main, looking again next tick'; }
  delete s.pendingSince;
  if (bad.length && !o.dryRun) {
    const list = bad.map(b => b.sha.slice(0, 10) + ' ' + b.subject + ' (' + b.why + ')').join('; ');
    SI.tell(null, { seatFn: 'risk', from: 'Main-branch watch', heading: 'P0: ' + bad.length + ' commit(s) on ' + repo + ' main did not come through the merge tool',
      fields: { Priority: 'P0', Need: 'find out who put these on main and how (agent run, owner by hand, web). If it was not the owner: open a revert PR and merge it with capheos-merge.js, and close the hole. If the owner did it on purpose: record it with `capheos-merge.js baseline --by owner --sha <sha>` (owner\'s shell) and set Status to DONE.', Why: 'the crew deploys only what the merge tool merged; something else changed the framework every company runs.', Deadline: 'today', Evidence: list },
      owner: 'Something changed the main copy of the company software without going through the crew\'s safety checks. The crew is looking into it now.', ownerKind: 'urgent' });
    s.flagged = s.flagged || {}; for (const b of bad) s.flagged[b.sha] = new Date().toISOString();
  }
  s.head = head; s.at = new Date().toISOString(); delete s.lastError;
  if (!o.dryRun) save(s);
  return 'CAPHEOS MAIN WATCH: ' + repo + ' main ' + head.slice(0, 10) + (bad.length ? ', FLAGGED ' + bad.length + ' commit(s) without the merge tool (P0 to the risk seat)' : ', every new commit came through the merge tool');
}

module.exports = { judge, tick };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === 'tick') { try { console.log(tick({ force: a.includes('--force'), dryRun: a.includes('--dry-run') })); } catch (e) { console.error('capheos-main-watch: ' + e.message); process.exit(1); } }
  else if (a[0] === 'status') console.log(JSON.stringify(SI.readJ(STATE, {}), null, 1));
  else if (a[0] === 'selftest') {
    const assert = require('assert');
    const C = (sha, p, m) => ({ sha, parents: p ? [{ sha: p }] : [], commit: { message: m || sha } });
    const s40 = c => c.repeat(40);
    const cmp = { status: 'ahead', commits: [C(s40('b'), s40('a')), C(s40('c'), s40('b')), C(s40('d'), s40('c'))] };
    assert.deepStrictEqual(judge(s40('a'), s40('d'), cmp, new Map([[s40('b'), 1], [s40('c'), 1], [s40('d'), 1]])), []);
    const bad = judge(s40('a'), s40('d'), cmp, new Map([[s40('b'), 1], [s40('d'), 1]]));
    assert.strictEqual(bad.length, 1); assert.strictEqual(bad[0].sha, s40('c'));
    assert.strictEqual(judge(s40('a'), s40('d'), { status: 'diverged', commits: [] }, new Map())[0].sha, s40('d'));
    assert.deepStrictEqual(judge(s40('a'), s40('d'), cmp, new Map([[s40('d'), { kind: 'baseline' }]])), [], 'a baseline at the head covers the commits pushed with it');
    assert.strictEqual(judge(s40('a'), s40('d'), cmp, new Map([[s40('d'), { kind: 'merge' }]])).length, 2, 'a merge row covers only its own commit');
    console.log('ok   capheos-main-watch judge: gated merges pass, an unrecorded commit and a rewrite are flagged');
  } else { console.error('usage: capheos-main-watch.js tick [--force] [--dry-run] | status | selftest'); process.exit(2); }
}
