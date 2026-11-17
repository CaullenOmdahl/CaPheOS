#!/usr/bin/env node
/* quest-audit.js — find quests that no run can ever close.
 *
 * Why: a quest can sit `open` with every step ticked and nothing left to do because its `agentId` names an id that
 * has never existed in the roster (a typo in a candidate id is enough). The artifact sweep in
 * `starnet/sidecar/questsweeps.js` completes an artifact contract only for the agent whose run just ended (`openFor()`
 * matches `agentId`), so no run can ever match it, and `op:"attest"` is refused for a mechanical contract. The quest
 * is unfinishable and invisible: every surface says "open", nothing says "impossible".
 *
 * Fixing one takes a hand edit of `.starnet-data/workspaces/_station.quests.json` because `/api/quests/update` has no
 * reassign op. This tool is the recurring half: it names every quest in that shape, so the next one is found by a
 * checker instead of by a person reading a list.
 *
 *   node company/tools/quest-audit.js            # report; exit 1 when anything is wrong
 *   node company/tools/quest-audit.js --json     # machine-readable findings
 *   node company/tools/quest-audit.js --selftest # fixture ledger; exit 1 if the checks cannot see a defect
 *
 * Checks, per OPEN quest:
 *   unknown-owner      agentId is set but names no agent in agent.roster.json  -> no run can own it
 *   artifact-exists    artifact contract key already exists on disk            -> the sweep should have closed it
 *   steps-done-uncloseable  every step is done and the contract cannot fire    -> nothing left to do, ever
 *   title-key-mismatch the quest's title names a deliverable path that does not match its contract key
 *
 * Check, per DONE quest:
 *   closed-early       status is done while steps are unticked. Finding carries `unticked` (step keys), `contract`
 *                      ({type,key}) and `contractPredatesCompletion` (true: the contract file's mtime is earlier
 *                      than the quest's completedAt, i.e. closed on a document that already existed; false: written
 *                      after; null: cannot tell). The work may be real; the finding says the record disagrees.
 *
 * Exit: 0 clean, 1 findings, 2 usage error.
 * Ownership: the tools owner. Runbook line: company/tools/README.md; wired into the daily Tool health routine.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = require('./lib/company').ROOT;
const DEFAULT_QUESTS = path.join(ROOT, '.starnet-data', 'workspaces', '_station.quests.json');
const DEFAULT_ROSTER = path.join(ROOT, '.starnet-data', 'workspaces', 'agent.roster.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function questsFrom(store) {
  if (Array.isArray(store)) return store;
  if (store && Array.isArray(store.quests)) return store.quests;
  if (store && store.value && Array.isArray(store.value.quests)) return store.value.quests;
  return [];
}

function rosterIds(roster) {
  const agents = Array.isArray(roster) ? roster : (roster && roster.agents) || [];
  const ids = new Set();
  for (const a of agents) {
    for (const key of [a.agentId, a.id, a.name]) {
      if (key) ids.add(String(key).toLowerCase());
    }
  }
  return ids;
}

/* Every finding is {quest, code, detail}. A quest with no agentId is station-wide by design, not a finding. */
function audit(quests, roster, opts) {
  const exists = (opts && opts.exists) || ((p) => fs.existsSync(path.join(ROOT, p)));
  const ids = rosterIds(roster);
  const out = [];
  const mtimeMs = (opts && opts.mtimeMs) || ((p) => { try { return fs.statSync(path.join(ROOT, p)).mtimeMs; } catch (_) { return null; } });
  for (const q of quests) {
    if (!q) continue;
    const id = q.id || '?';
    const steps = Array.isArray(q.steps) ? q.steps : [];
    if (q.status === 'done') {
      // closed-early: the quest says done while its own steps are not. The work may be real but stranded in
      // handoff threads; the only person who notices is the seat that tries to tick a step and is refused.
      const unticked = steps.filter((s) => s && !s.done).map((s) => s.key || '?');
      if (unticked.length) {
        const c = q.contract || {};
        const m = c.type === 'artifact' && c.key ? mtimeMs(c.key) : null;
        const completedAt = Number(q.completedAt) || null;
        // true = the contract file was already on disk before the quest closed (closed on a document that existed);
        // null = cannot tell (not an artifact contract, file missing, or no completedAt).
        const predates = m != null && completedAt != null ? m < completedAt : null;
        out.push({
          quest: id, code: 'closed-early',
          detail: `status done with ${unticked.length} unticked step(s): ${unticked.join(', ')}; contract ${c.type || 'none'}${c.key ? ' ' + c.key : ''}` +
            (predates === true ? '; contract file mtime predates completedAt (closed on a document that already existed)' : predates === false ? '; contract file was written after completedAt' : '; contract mtime comparison not possible'),
          unticked, contract: { type: c.type || null, key: c.key || null }, contractPredatesCompletion: predates,
        });
      }
      continue;
    }
    if (q.status !== 'open') continue;
    const allDone = steps.length > 0 && steps.every((s) => s && s.done);
    const contract = q.contract || {};
    const contractLive = contract.type === 'artifact' && contract.key ? exists(contract.key) : false;

    if (q.agentId && !ids.has(String(q.agentId).toLowerCase())) {
      out.push({ quest: id, code: 'unknown-owner', detail: `agentId "${q.agentId}" is not in the roster — no run can match it (` + (ids.size) + ' ids known)' });
    }
    if (contractLive) {
      out.push({ quest: id, code: 'artifact-exists', detail: `contract file ${contract.key} exists but the quest is still open` });
    }
    if (allDone && !contractLive && contract.type !== 'attest') {
      out.push({ quest: id, code: 'steps-done-uncloseable', detail: `all ${steps.length} steps are done and the ${contract.type || 'unknown'} contract cannot fire` + (q.agentId ? ` for ${q.agentId}` : '') });
    }
    // A minted title usually ends "-> <path>"; when it disagrees with the contract key, one of them is wrong.
    // Titles are clipped to 80 chars by the store, so a truncated path that is a PREFIX of the key is not a finding.
    const m = String(q.title || '').match(/->\s*(\S+)\s*$/);
    const related = m && contract.key ? (contract.key.startsWith(m[1]) || m[1].startsWith(contract.key)) : true;
    if (m && contract.key && !related && contract.type === 'artifact') {
      out.push({ quest: id, code: 'title-key-mismatch', detail: `title names ${m[1]} but the contract key is ${contract.key}` });
    }
  }
  return out;
}

function report(findings, opts) {
  if (opts && opts.json) {
    process.stdout.write(JSON.stringify({ ok: findings.length === 0, findings }, null, 2) + '\n');
    return findings.length === 0 ? 0 : 1;
  }
  if (findings.length === 0) {
    process.stdout.write('quest-audit: OK — every open quest names a real owner and has something left that can close it, and no done quest has unticked steps\n');
    return 0;
  }
  process.stdout.write(`quest-audit: ${findings.length} finding(s)\n`);
  for (const f of findings) process.stdout.write(`  ${f.quest.padEnd(6)} ${f.code.padEnd(24)} ${f.detail}\n`);
  return 1;
}

function selftest() {
  const roster = { agents: [{ agentId: 'engineer' }, { agentId: 'cand-sales-2026-01-alex' }] };
  const existsSome = (p) => p === 'company/work/content/short-form-test.md';
  const cases = [
    { name: 'quest owned by an id that does not exist', q: { id: 'q:1', status: 'open', agentId: 'cand-sales-2026-01-01-alex', contract: { type: 'artifact', key: 'company/work/content/short-form-test.md' }, steps: [{ done: true }] }, want: ['unknown-owner', 'artifact-exists'] },
    { name: 'healthy quest (real owner, file absent, steps open)', q: { id: 'q:2', status: 'open', agentId: 'engineer', contract: { type: 'artifact', key: 'company/tools/not-yet.js' }, steps: [{ done: false }] }, want: [] },
    { name: 'all steps ticked, contract can never fire', q: { id: 'q:3', status: 'open', agentId: 'engineer', contract: { type: 'artifact', key: 'company/tools/nowhere.js' }, steps: [{ done: true }, { done: true }] }, want: ['steps-done-uncloseable'] },
    { name: 'attest quest is closeable by the Commander', q: { id: 'q:4', status: 'open', agentId: 'engineer', contract: { type: 'attest', key: '' }, steps: [{ done: true }] }, want: [] },
    { name: 'station-wide quest (no agentId) is not a finding', q: { id: 'q:5', status: 'open', agentId: null, contract: { type: 'artifact', key: 'company/x/y.md' }, steps: [{ done: false }] }, want: [] },
    { name: 'title path disagrees with the contract key', q: { id: 'q:6', status: 'open', agentId: 'engineer', title: 'Thing -> company/a.md', contract: { type: 'artifact', key: 'company/b.md' }, steps: [{ done: false }] }, want: ['title-key-mismatch'] },
    { name: 'a closed quest with every step ticked is not audited', q: { id: 'q:7', status: 'done', agentId: 'nobody', contract: { type: 'artifact', key: 'company/work/content/short-form-test.md' }, steps: [{ key: 'a', done: true }] }, want: [] },
    { name: 'closed quest with unticked steps', q: { id: 'q:8', status: 'done', agentId: 'engineer', completedAt: 2000, contract: { type: 'artifact', key: 'company/work/content/short-form-test.md' }, steps: [{ key: 'a', done: true }, { key: 'b', done: false }] }, want: ['closed-early'] },
    { name: 'closed quest with no steps is not closed-early', q: { id: 'q:9', status: 'done', contract: { type: 'artifact', key: 'x' }, steps: [] }, want: [] },
  ];
  // The extra fields a routine acts on: the unticked keys and the mtime-vs-completedAt verdict, both ways and unknown.
  const probe = (completedAt, mt) => audit([{ id: 'q:p', status: 'done', completedAt, contract: { type: 'artifact', key: 'f' }, steps: [{ key: 'k', done: false }] }], roster, { mtimeMs: () => mt })[0];
  const extra = [
    ['unticked keys reported', probe(2000, 1000).unticked.join() === 'k'],
    ['file older than completedAt -> predates true', probe(2000, 1000).contractPredatesCompletion === true],
    ['file newer than completedAt -> predates false', probe(2000, 3000).contractPredatesCompletion === false],
    ['file missing -> predates null', probe(2000, null).contractPredatesCompletion === null],
  ];
  let extraFail = 0;
  for (const [n, ok] of extra) { if (ok) process.stdout.write(`ok    ${n}\n`); else { extraFail++; process.stdout.write(`FAIL  ${n}\n`); } }
  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const got = audit([c.q], roster, { exists: existsSome }).map((f) => f.code).sort();
    const want = c.want.slice().sort();
    const ok = got.length === want.length && got.every((g, i) => g === want[i]);
    if (ok) { pass++; process.stdout.write(`ok    ${c.name}\n`); }
    else { fail++; process.stdout.write(`FAIL  ${c.name} — want [${want.join(', ')}] got [${got.join(', ')}]\n`); }
  }
  fail += extraFail;
  process.stdout.write(`\nQUEST-AUDIT SELFTEST: ${pass + extra.length - extraFail} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

function main(argv) {
  const opts = { json: argv.includes('--json') };
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node company/tools/quest-audit.js [--json|--selftest]\n');
    return 0;
  }
  const questsFile = process.env.QUEST_AUDIT_QUESTS || DEFAULT_QUESTS;
  const rosterFile = process.env.QUEST_AUDIT_ROSTER || DEFAULT_ROSTER;
  let quests;
  let roster;
  try {
    quests = questsFrom(readJson(questsFile));
    roster = readJson(rosterFile);
  } catch (e) {
    process.stderr.write(`quest-audit: cannot read ${/roster/i.test(String(e.message)) ? '' : ''}${questsFile} or ${rosterFile}: ${e.message}\n`);
    return 2;
  }
  return report(audit(quests, roster, {}), opts);
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { audit, questsFrom, rosterIds };
