/* Selftest fixtures for company/tools/competence.js (policy v1). Each case is a worked example with invented people,
 * repos and files, with the expected numbers worked out by hand under company/competence-policy.json v1.1. A policy change that moves a number breaks the
 * case on purpose: re-derive the expectation and say why in the commit, do not just update the number.
 * Run: node company/tools/competence.js selftest   (exit 1 on any failure; writes only to a temp dir)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const CREW = {
  agent: { name: 'Alex', title: 'CEO', inbox: 'to-alex.md', manager: null, functions: ['ceo'] },
  drafter: { name: 'Sam', title: 'Product Manager', inbox: 'to-sam.md', manager: 'agent' },
  engineer: { name: 'Jordan', title: 'Engineer', inbox: 'to-jordan.md', manager: 'agent', functions: ['tools'] },
  deployer: { name: 'Casey', title: 'DevOps', inbox: 'to-casey.md', manager: 'agent' },
  designer: { name: 'Riley', title: 'Designer', inbox: 'to-riley.md', manager: 'drafter' },
  treasurer: { name: 'Morgan', title: 'CFO', inbox: 'to-morgan.md', manager: 'agent', functions: ['finance'] },
  hiring: { name: 'Taylor', title: 'People', inbox: 'to-taylor.md', manager: 'agent', functions: ['people'] },
  auditor: { name: 'Quinn', title: 'Security', inbox: 'to-quinn.md', manager: 'agent', functions: ['risk'] },
  'cand-qa-robin': { name: 'Robin', title: 'QA', inbox: 'to-robin.md', manager: 'agent' },
};
// the fixtures run in a fixed UTC+07:00 test zone, whatever company/company.json says, so the times below are stable
const TEST_TZ = 'Etc/GMT-7';
const T0 = Date.parse('2026-11-15T05:00:00Z');   // 12:00 local: no case straddles a local midnight
const at = (days, hours) => new Date(T0 + (days || 0) * 86400e3 + (hours || 0) * 3600e3).toISOString();

function run(H) {
  H.setTimeZone(TEST_TZ);
  const POLICY = H.FILES.policy;
  const P = H.loadPolicy(POLICY);
  const crew = H.makeCrew(CREW);
  let n = 0, failed = 0;
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 0.01 : tol);
  const check = (name, cond, detail) => { n++; if (cond) console.log('  PASS  ' + name); else { failed++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); } };
  const eq = (name, got, want, tol) => check(name, typeof want === 'number' ? near(got, want, tol) : got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  let seq = 0;
  const row = o => Object.assign({ schema: 1, policy: P.version }, o, { id: o.id || H.mkId(o.signal, (o.source && o.source.ref) || ('fx' + (++seq)), o.agent, o.bucket, o.kind, o.key || String(++seq)) });
  const credit = o => { const s = H.sizeFiles(P, o.files); return row({ kind: 'credit', signal: o.signal || 'pr.merged', agent: o.agent, bucket: o.bucket || s.bucket, at: o.at, files: o.files.map(f => f.path), lines: s.lines, share: 1, sizePts: s.pts, prSizePts: s.pts, v: o.v, pending: o.pending || null, source: { type: 'gh-pr', ref: o.ref } }); };
  const approval = o => row({ kind: 'credit', signal: 'review.approve', agent: o.agent, bucket: 'review', at: o.at, acceptedAt: o.at, links: { parents: o.parents }, prSizePts: o.prSizePts, files: o.files || [], vReviewer: o.vReviewer == null ? 1 : o.vReviewer, scopeShare: o.scopeShare == null ? 1 : o.scopeShare, pending: o.pending || null, corroboratedBy: o.pending ? null : 'run-x', source: { type: 'gh-comment', ref: o.ref } });
  const flaw = o => row(Object.assign({ kind: 'demerit', signal: 'defect.confirmed', caught: 'after', finderCorroboratedBy: 'run-f', codeEra: 'company', files: [] }, o, { links: { parent: o.parent || null }, source: { type: 'fx', ref: o.ref || ('flaw' + (++seq)) } }));
  const fixed = (target, when, lines) => row({ kind: 'record', signal: 'defect.fix-merged', target, at: when, fixLines: lines, source: { type: 'gh-pr', ref: 'fix-' + target } });
  const soft = o => row(Object.assign({ kind: 'demerit', soft: true, bucket: 'planning', appliesAt: new Date(Date.parse(o.at) + 72 * 3600e3).toISOString(), links: { parent: null } }, o, { source: { type: 'fx', ref: o.ref || ('soft' + (++seq)) } }));
  const ruling = (target, byAgent, changes, when, corroborated) => { const r = row({ kind: 'ruling', signal: 'ruling', target, byAgent, by: crew.nameOf(byAgent), changes, at: when, reason: 'fixture ruling', source: { ref: 'ruling-' + target + JSON.stringify(changes) } }); return corroborated ? [r, row({ kind: 'record', signal: 'ruling.corroborated', target: r.id, at: when, corroboratedBy: 'run-r', source: { ref: 'corr-' + r.id } })] : [r]; };
  const C = (rows, now) => H.compute(rows, P, crew, Date.parse(now));
  const B = (res, id, b) => res.people[id].buckets[b];
  const sw = c => Math.min(1.5, Math.max(0.5, 0.5 + 0.025 * c));

  console.log('T1  Casey gh#101: 3 .github files, Jordan corroborated APPROVE, test record written after the merge');
  {
    const rec = { verdict: 'PASS', dirty_files: 0, required_lanes: 'api,flutter', lanes: { api: { integration: { cases: 110 } }, flutter: { apps: [{ pass: 729 }] } }, command: 'bash company/tools/test-substrate.sh --all', ranAt: '2026-11-15T09:51:12Z' };
    const ts = H.testRecordSignal(rec, Date.parse('2026-11-15T08:30:54Z'));
    eq('test record after the merge is not a hard signal', ts.ok, false);
    const files = [{ path: '.github/README.md', additions: 6, deletions: 4 }, { path: '.github/deploy.test.mjs', additions: 7, deletions: 0 }, { path: '.github/deploy.ts', additions: 9, deletions: 2 }];
    const s = H.sizeFiles(P, files);
    eq('size: 28 lines', s.lines, 28); eq('points: 10 docs x0.05 + 18 code x0.2 = 4.1', s.pts, 4.1); eq('bucket ops', s.bucket, 'ops');
    const c = credit({ agent: 'deployer', ref: 'gh#101', at: '2026-11-15T08:30:54Z', files, v: 0.8 });
    const a = approval({ agent: 'engineer', ref: 'gh#101', at: '2026-11-15T08:30:54Z', parents: [c.id], prSizePts: 4.1, files: files.map(f => f.path) });
    let r = C([c, a], '2026-11-16T08:30:54Z');
    eq('Casey ops xp = 0.8 x 4.1', B(r, 'deployer', 'ops').xp, 3.28);
    eq('Jordan: first half of the approval now (0.3 x 4.1 / 2)', B(r, 'engineer', 'review').xp, 0.615, 0.006);
    eq('Jordan: escrow half pending', B(r, 'engineer', 'review').pendingXp, 0.615, 0.006);
    r = C([c, a], '2026-11-30T09:00:00Z');
    eq('Jordan after 14 clean days: full 1.23', B(r, 'engineer', 'review').xp, 1.23);
    eq('Jordan approval sample counted at q 1', r.samples.filter(x => x.agent === 'engineer').map(x => x.q).join(), '1');
    const pre = H.testRecordSignal(Object.assign({}, rec, { ranAt: '2026-11-15T08:00:00Z' }), Date.parse('2026-11-15T08:30:54Z'));
    eq('the same record written before the merge is a hard signal', pre.ok, true);
  }

  console.log('T2  Sam gh#102: 535 docs lines, Quinn corroborated NO OBJECTION, four cosmetic (S3) findings caught in review');
  {
    const c = credit({ agent: 'drafter', ref: 'gh#102', at: '2026-11-15T02:02:17Z', files: [{ path: 'docs/design/loyalty-web.md', additions: 535, deletions: 0 }], v: 0.8 });
    const a = approval({ agent: 'auditor', ref: 'gh#102', at: '2026-11-15T02:02:17Z', parents: [c.id], prSizePts: 26.75, files: ['docs/design/loyalty-web.md'] });
    const fs4 = ['C1', 'C2', 'C3', 'C4'].map(k => flaw({ signal: 'flaw.in-review', agent: 'drafter', parent: c.id, severity: 'S3', reach: 'R2', caught: 'review', finder: 'auditor', at: '2026-11-15T00:18:00Z', ref: 'recut-verdict', findingKey: 'recut:' + k, key: k }));
    const r = C([c, a].concat(fs4), '2026-12-01T00:00:00Z');
    eq('Sam planning xp = 0.8 x 26.75 (S3 in review costs nothing)', B(r, 'drafter', 'planning').xp, 21.4);
    eq('Sam work sample q = 1', r.units[0].q, 1);
    eq('Quinn review xp = approval 8.025 + cosmetic 1 each, at most 3', B(r, 'auditor', 'review').xp, 11.03, 0.01);
  }

  console.log('T3  the 5,000-line work with one small bug (S2 R4 after acceptance, 10-line fix by someone else)');
  {
    const big = credit({ agent: 'engineer', ref: 'gh#9001', at: at(0), files: [{ path: 'api/src/big.ts', additions: 5000, deletions: 0 }], v: 1.0 });
    const f = flaw({ agent: 'engineer', parent: big.id, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(3), files: ['api/src/big.ts'] });
    const small = credit({ agent: 'designer', ref: 'gh#9002', at: at(0), files: [{ path: 'apps/x/small.dart', additions: 20, deletions: 0 }], v: 1.0 });
    const g = flaw({ agent: 'designer', parent: small.id, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(3), files: ['apps/x/small.dart'] });
    const r = C([big, f, fixed(f.id, at(4), 10), small, g, fixed(g.id, at(4), 10)], at(5));
    eq('5,000 lines: xp 50 - 2.5 (cap 0.5 x 50 x clamp(10x10/5000, 0.1, 1))', B(r, 'engineer', 'build').xp, 47.5);
    eq('5,000 lines: competence sample q = 1 - 36/1000', r.units.find(u => u.agent === 'engineer').q, 0.964, 0.0001);
    eq('20 lines, same bug: xp 4 - 2 (cap 0.5 x 4 x 1)', B(r, 'designer', 'build').xp, 2);
    eq('20 lines, same bug: q = 0 (no floor)', r.units.find(u => u.agent === 'designer').q, 0);
    eq('Robin paid exactly what was charged: 2.5 + 2', B(r, 'cand-qa-robin', 'review').xp, 4.5);
    eq('no serious flag for an S2', r.serious.length, 0);
  }

  console.log('T4  a serious flaw: Casey\'s substrate gate cannot fail (S1 R2 after acceptance), Sam finds it');
  {
    const c = credit({ agent: 'deployer', ref: 'gh#9003', at: at(0), files: [{ path: 'scripts/substrate.ts', additions: 200, deletions: 0 }], v: 0.8 });
    const f = flaw({ agent: 'deployer', parent: c.id, severity: 'S1', reach: 'R2', finder: 'drafter', at: at(2) });
    const r = C([c, f, fixed(f.id, at(3), 12)], at(4));
    eq('the work keeps its xp minus the density-scaled cap: 0.8 x (40 - 0.5x40x0.6)', B(r, 'deployer', 'build').xp, 22.4);
    eq('not voided without a revert', r.units[0].void, false);
    const st = r.samples.filter(s => s.agent === 'deployer');
    eq('two competence samples: the work (q 1) and the flaw alone (q 0)', st.map(s => s.q).sort().join(), '0,1');
    eq('standalone weight min(8, 45/20)', st.find(s => s.q === 0).w, 2.25);
    eq('Casey build competence', B(r, 'deployer', 'build').competence, Math.round(1000 * (0.8 * 1.5 + 1.5) / (0.8 * 1.5 + 2.25 + 3)) / 10, 1.0);   // 41.9 before a few days of decay
    eq('serious list has it', r.serious.map(s => s.severity).join(), 'S1');
    eq('Sam paid what Casey lost: the charge 12 x his verification 0.8 (not the raw 45; a planted flaw never pays the pair)', B(r, 'drafter', 'review').xp, 9.6);
    const dir = require('../../../lib/temp-life').tmpDir('competence-selftest-');
    const saved = Object.assign({}, H.FILES);
    try {
      H.FILES.handoffs = dir;
      const state = {};
      const issued = H.seriousFlags(r, crew, state, {});
      eq('serious flag written once', issued.length, 1);
      const rach = fs.readFileSync(path.join(dir, 'to-taylor.md'), 'utf8'), alex = fs.readFileSync(path.join(dir, 'to-alex.md'), 'utf8');
      check('handoff to Taylor is OPEN', /competence serious flag: Casey, S1/.test(rach) && /\*\*Status:\*\* OPEN/.test(rach));
      check('FYI to Casey\'s manager (Alex) does not wake him', /FYI: competence serious flag/.test(alex) && /\*\*Status:\*\* DONE — FYI/.test(alex));
      eq('second run issues nothing (once per event)', H.seriousFlags(r, crew, state, {}).length, 0);
    } finally { Object.assign(H.FILES, saved); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('T5  a revert: Riley\'s 300-line PR reverted two days later');
  {
    const c = credit({ agent: 'designer', ref: 'gh#9004', at: at(0), files: [{ path: 'apps/web/page.ts', additions: 300, deletions: 0 }], v: 0.8 });
    const rv = flaw({ signal: 'pr.reverted', agent: 'designer', parent: c.id, severity: 'S2', reach: 'R4', finder: null, at: at(2), fixLines: 300 });
    let r = C([c, rv], at(3));
    eq('reverted work: xp 0', B(r, 'designer', 'build').xp, 0);
    eq('reverted work: sample q 0', r.units[0].q, 0);
    eq('an S2 revert is not a serious flag', r.serious.length, 0);
    const rv1 = flaw({ signal: 'pr.reverted', agent: 'designer', parent: c.id, severity: 'S1', reach: 'R4', finder: null, at: at(2), fixLines: 300, key: 's1' });
    r = C([c, rv1], at(3));
    eq('an S1 revert: serious flag', r.serious.length, 1);
  }

  console.log('T6  finder paid the demerit charged: Jordan\'s 171-line gate, regex S2 R2 + --squash S3 R2, Robin finds both');
  {
    const c = credit({ agent: 'engineer', ref: 'gh#9005', at: at(0), files: [{ path: 'tools/premerge-check.js', additions: 171, deletions: 0 }], v: 0.8 });
    const f1 = flaw({ agent: 'engineer', parent: c.id, severity: 'S2', reach: 'R2', finder: 'cand-qa-robin', at: at(1) });
    const f2 = flaw({ agent: 'engineer', parent: c.id, severity: 'S3', reach: 'R2', finder: 'cand-qa-robin', at: at(1) });
    const r = C([c, f1, f2, fixed(f1.id, at(2), 9), fixed(f2.id, at(2), 9)], at(3));
    eq('raw 18 + 6 = 24, capped at 0.5 x 34.2 = 17.1', r.units[0].charge, 17.1);
    eq('Jordan xp 0.8 x (34.2 - 17.1)', B(r, 'engineer', 'build').xp, 13.68);
    eq('Jordan q = 1 - 24/34.2 (competence uses the uncapped demerit)', r.units[0].q, 0.2982, 0.0001);
    eq('Robin paid what Jordan lost: 17.1 charged x 0.8 = 13.68 (not the raw 24)', B(r, 'cand-qa-robin', 'review').xp, 13.68);
  }

  console.log('T7  an old-code finding paid flat: Robin QA-001 (S3) in code written before the company started');
  {
    const f = flaw({ agent: null, parent: null, severity: 'S3', reach: 'R4', finder: 'cand-qa-robin', codeEra: 'pre-company', at: at(0) });
    let r = C([f], at(1));
    eq('before the fix merges: nothing paid', B(r, 'cand-qa-robin', 'review').xp, 0);
    eq('before the fix merges: 2 pending', B(r, 'cand-qa-robin', 'review').pendingXp, 2);
    r = C([f, fixed(f.id, at(2), 6)], at(3));
    eq('fix merged: flat 2', B(r, 'cand-qa-robin', 'review').xp, 2);
    eq('nobody is charged for pre-company code', r.samples.filter(s => s.q === 0).length, 0);
  }

  console.log('T8  an own-error row (Alex, a decisions.md row) and the owner correction it answers');
  {
    const parsed = H.parseOwnErrors('| 2026-11-15 16:45 | **The owner stopped the sales push and I am treating it as policy** | Alex (own error); Sam writes the gate, Robin writes its failure test | `owner/inbound.jsonl` |\n| 2026-11-15 16:50 | something else | Alex (correction: Morgan) | x |');
    eq('parser finds exactly one own-error row', parsed.length, 1);
    eq('...naming Alex', parsed[0].names.join(), 'Alex');
    eq('...and the owner messages it answers', parsed[0].msgTimes.join(), '');
    eq('a row that names "His 16:33 message" links to it', H.parseOwnErrors('| 2026-11-15 16:45 | The owner stopped the push. His 16:33 message: not ready | Alex (own error) | x |')[0].msgTimes.join(), '16:33');
    const own = soft({ signal: 'own-error', agent: 'agent', at: at(0), severity: 'S2', reach: 'R3', caught: 'after', ownUp: true, ref: 'decisions.md:10' });
    let r = C([own], at(1));
    eq('inside 72 hours: waiting for Taylor, not applied', r.waiting.length, 1);
    eq('default charge S2 R3 after x 0.8 = 19.2', r.waiting[0].D, 19.2);
    r = C([own], at(4));
    eq('after 72 hours: applied at its default (weight 19.2/20)', r.samples.find(s => s.agent === 'agent').w, 0.96);
    const corr = soft({ signal: 'owner.correction', agent: 'agent', at: at(0, -1), severity: 'S2', reach: 'R3', caught: 'owner', ref: 'msg-07b6ffdd' });
    const other = soft({ signal: 'owner.correction', agent: 'agent', at: at(0, -0.1), severity: 'S2', reach: 'R3', caught: 'owner', ref: 'msg-39cad601' });
    const named = Object.assign({}, own, { msgTimes: [H.localStamp(Date.parse(at(0, -1))).slice(11)] });
    let rn = C([named, corr, other], at(4));
    eq('the named owner message wins over a nearer one', rn.samples.filter(s => s.agent === 'agent').length, 2);
    check('...and it is the named one that is merged', !rn.samples.some(s => s.id === corr.id) && rn.samples.some(s => s.id === other.id));
    r = C([own, corr], at(4));
    eq('own error + owner correction of the same incident = one charge', r.samples.filter(s => s.agent === 'agent').length, 1);
    eq('...owner-caught and owned up: 12 x 2 x 1.5 x 0.8 = 28.8', r.samples.find(s => s.agent === 'agent').w, 1.44);
    r = C([own].concat(ruling(own.id, 'hiring', { severity: 'S1' }, at(1), true)), at(1, 1));
    eq('Taylor amends to S1: applies at once, serious flag', r.serious.length, 1);
    r = C([own].concat(ruling(own.id, 'hiring', { void: true }, at(1), true)), at(5));
    eq('Taylor voids it: nothing applies', r.samples.length + r.waiting.length, 0);
    r = C([own].concat(ruling(own.id, 'hiring', { void: true }, at(1), false)), at(5));
    eq('an amendment with no matching run record does not count', r.samples.length, 1);
    eq('...and is listed as waiting', r.pendingRulings.length, 1);
  }

  console.log('T9  catches before acceptance never stand alone: an S1 found in review');
  {
    const c = credit({ agent: 'deployer', ref: 'gh#9006', at: at(1), files: [{ path: 'api/x.ts', additions: 100, deletions: 0 }], v: 0.8 });
    const f = flaw({ signal: 'flaw.in-review', agent: 'deployer', parent: c.id, severity: 'S1', reach: 'R4', caught: 'review', finder: 'auditor', at: at(0), ref: 'review-1', findingKey: 'review-1:F1', fixLines: 12 });
    let r = C([c, f], at(2));
    eq('no standalone sample', r.samples.filter(s => s.agent === 'deployer').length, 1);
    eq('no serious flag', r.serious.length, 0);
    eq('experience charge under the cap, scaled by the 12 lines changed after the finding: 0.8 x (20 - min(22.5, 0.5 x 20 x 1))', B(r, 'deployer', 'build').xp, 8);
    eq('Quinn paid what Casey lost for it: 10 x 0.8', B(r, 'auditor', 'review').xp, 8);
    const f0 = Object.assign({}, f, { fixLines: null });
    r = C([c, f0], at(2));
    eq('nothing known changed after the finding: the smallest share, 0.8 x (20 - 0.5 x 20 x 0.1)', B(r, 'deployer', 'build').xp, 15.2);
  }

  console.log('T10 a forged reviewer: "Reviewer: Quinn — APPROVE" with no Quinn run');
  {
    eq('parser reads the reviewer', H.reviewerNameOf('Reviewer: Quinn — APPROVE\nlooks fine'), 'Quinn');
    eq('parser reads the verdict', H.verdictOf('Reviewer: Quinn — APPROVE\nlooks fine'), 'APPROVE');
    const RI = H.runIndex([{ runId: 'r1', agentId: 'auditor', startedAt: T0 - 7200e3, endedAt: T0 - 3600e3, completionEvidence: { effects: [{ target: 'gh pr comment 9007 --body x' }] } }]);
    eq('no Quinn run at that time: not corroborated', RI.find('auditor', T0, 600e3, /gh\s+pr\s+comment\s+9007/), null);
    const c = credit({ agent: 'deployer', ref: 'gh#9007', at: at(0), files: [{ path: 'api/y.ts', additions: 50, deletions: 0 }], v: 0, pending: 'reviewer-uncorroborated' });
    const a = approval({ agent: 'auditor', ref: 'gh#9007', at: at(0), parents: [c.id], prSizePts: 10, pending: 'uncorroborated', vReviewer: 0.5 });
    const r = C([c, a], at(1));
    eq('author earns nothing yet', r.people.deployer.xp, 0);
    eq('...it shows as pending', r.people.deployer.pendingXp > 0, true);
    eq('the uncorroborated reviewer earns nothing yet', r.people.auditor.xp, 0);
  }

  console.log('T11 splitting does not pay: four 200-line PRs on one file within a week are one unit');
  {
    const same = [0, 2, 4, 6].map(d => credit({ agent: 'engineer', ref: 'gh#91' + d, at: at(d), files: [{ path: 'api/feature.ts', additions: 200, deletions: 0 }], v: 0.8 }));
    let r = C(same, at(8));
    eq('one unit', r.units.length, 1);
    eq('sized together and capped once: 0.8 x 50', B(r, 'engineer', 'build').xp, 40);
    const apart = [0, 2, 4, 6].map(d => credit({ agent: 'engineer', ref: 'gh#92' + d, at: at(d), files: [{ path: 'api/f' + d + '.ts', additions: 200, deletions: 0 }], v: 0.8 }));
    r = C(apart, at(8));
    eq('four separate pieces of work stay four units', r.units.length, 4);
    eq('...each capped on its own: 4 x 0.8 x 40', B(r, 'engineer', 'build').xp, 128);
  }

  console.log('T12 test records: case counts must be > 0 in every required lane (D1\'s "0\\n0" record)');
  {
    const d1 = { verdict: 'PASS', dirty_files: 0, required_lanes: 'api,flutter', lanes: { api: { cases: 0 }, flutter: { apps: [{ pass: 12 }] } }, ranAt: '2026-11-15T07:00:00Z', command: 'bash company/tools/test-substrate.sh' };
    const t = H.testRecordSignal(d1, Date.parse('2026-11-15T08:00:00Z'));
    eq('a PASS with 0 api cases is not a hard signal', t.ok, false);
    check('...and says why', /lane api ran 0 cases/.test(t.why), t.why);
    eq('a dirty tree is not a hard signal', H.testRecordSignal(Object.assign({}, d1, { dirty_files: 3, lanes: { api: { cases: 5 }, flutter: { cases: 5 } } }), Date.parse('2026-11-15T08:00:00Z')).ok, false);
  }

  console.log('T13 reviewer escrow: approved work draws a moderate flaw inside 14 days');
  {
    const c = credit({ agent: 'deployer', ref: 'gh#9008', at: at(0), files: [{ path: 'api/z.ts', additions: 100, deletions: 0 }], v: 0.8 });
    const a = approval({ agent: 'engineer', ref: 'gh#9008', at: at(0), parents: [c.id], prSizePts: 20, files: ['api/z.ts'] });
    const f = flaw({ agent: 'deployer', parent: c.id, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(5), files: ['api/z.ts'] });
    const r = C([c, a, f, fixed(f.id, at(6), 5)], at(20));
    eq('reviewer keeps only the first half (0.3 x 20 / 2)', B(r, 'engineer', 'review').xp, 3);
    eq('approval sample quality set by the outcome: 1 - 36/20 -> 0', r.samples.find(s => s.agent === 'engineer').q, 0);
  }

  console.log('T14 the merged-without-gate audit');
  {
    const g = row({ kind: 'demerit', signal: 'process.merged-without-gate', agent: 'deployer', bucket: 'ops', at: at(0), severity: 'S2', reach: 'R2', caught: 'after', links: { parent: null }, source: { ref: 'gh#9009' } });
    const r = C([g], at(1));
    eq('S2 R2 process demerit: one ops sample, weight 18/20', r.samples.find(s => s.agent === 'deployer' && s.bucket === 'ops').w, 0.9);
    eq('it costs no experience', r.people.deployer.xp, 0);
  }

  console.log('T15 parsers on sample files');
  {
    const qa1 = '# Defect QA-001 — every `/api/v1` validation failure answers 500\n\n**Found by:** Robin, 2026-11-15 by hand on a running build.\n**Severity:** **S3** (no data loss). **Risk class:** N1.\n**Owner of the fix:** Jordan (engineering).\n**Filed:** https://github.com/example/app/issues/534 (`sev:S3`).\n\n`api/src/server.ts:217` installs a handler\n**Build:** `origin/master` at `60ec56a2` (`api` v0.1.23)\n';
    const d = H.parseDefect(qa1);
    eq('defect id', d.id, 'QA-001'); eq('finder', d.finder, 'Robin'); eq('severity', d.severity, 'S3'); eq('fix owner', d.fixOwner, 'Jordan'); eq('issue', d.issue, 534); eq('build', d.build, '60ec56a2');
    eq('cited line', d.refs.map(x => x.path + ':' + x.from).join(), 'api/src/server.ts:217');
    const recut = '# Loyalty re-cut: Quinn verdict on P3, P4, P6, R7, R8 (second pass)\n\nDate: 2026-11-15. Reviewer: Quinn (auditor). Answers: Sam\'s handoff "loyalty re-cut".\nDoc reviewed: `docs/design/loyalty-web.md` at commit `0fe0a75a` (535 lines), read via `git show`. Nothing was run.\n\n## OVERALL: NO OBJECTION to the rule text of P3, P4, P6, R7 and R8, on condition that four stale lines (C1-C4) are fixed.\n\n- **C1 (blocking, line 383, §11 test 8):** "5 wrong attempts"\n';
    const v = H.parseVerdictFile(recut);
    eq('reviewer', v.reviewer, 'Quinn'); eq('verdict', v.verdict, 'NO OBJECTION'); eq('scope declared', v.scopeDeclared, true); eq('commit', v.commits.join(), '0fe0a75a'); eq('declared lines', v.declaredLines, 535); eq('requester', v.requester, 'Sam');
    eq('a finding with no severity is not scored', v.findings.length, 0);
    eq('a table finding with a severity is', H.parseFindings('| F5 | S1 | Identity / mismatch | The page |').map(f => f.id + f.severity).join(), 'F5S1');
    const cls = H.parseVerdictFile('# Security classification — QA-001: `/api/v1` error paths echo internal detail (issue #534)\n\n**Asked by:** Robin, 2026-11-15 16:10.\n**Answered:** 2026-11-15 16:52 +0700 by Quinn (IT Security).\n**Short answer:** **class `type:security`, severity stays `S3`.** Not S2.\n\n## 1. What I verified myself (not taken from the defect note)\n');
    eq('classification severity', cls.classification, 'S3'); eq('classification names the issue', cls.subject.issues.join(), '534'); eq('...and the defect in its title', cls.subject.ids.join(), 'QA-001'); eq('classifier', cls.reviewer, 'Quinn');
    eq('no scope, not scored as a review', H.parseVerdictFile('# Quinn\'s read\n\n**Asked by:** Sam.\n**Verdict: APPROVE WITH CHANGES — three blocking.**\n').scopeDeclared, false);
    const gr = '## Independent security review — Quinn (Security Auditor, Example Co)\n\n_Design review at commit c577c146._\n\n## Verdict\n\n**REQUEST CHANGES**\n';
    eq('GitHub review: reviewer', H.reviewerNameOf(gr), 'Quinn'); eq('GitHub review: verdict under the heading', H.verdictOf(gr), 'REQUEST CHANGES');
    eq('commit "(Sam)" suffix', H.commitAuthorName({ messageHeadline: 'docs(design): loyalty fix stale lines C1-C4 from Quinn\'s re-cut review (Sam)', messageBody: '' }, 'Jordan'), 'Sam');
    eq('commit with a truncated headline and an Author trailer', H.commitAuthorName({ messageHeadline: 'fix(deploy): declare production backup buckets so config apply canno…', messageBody: '…t delete them (#31)\n\nAuthor: Casey\n\nbody' }, null), 'Casey');
    eq('PR body Author line', H.prAuthorName('Docs-only design.\n\n**Author:** Jordan (Engineer, Example Co)\n'), 'Jordan');
    eq('PR body "authorized" is not an Author line (Robin)', H.prAuthorName('This change is authorized by Alex.'), null);
    const ack = new RegExp(P.soft.ackCorrectionPattern, 'i'), reply = new RegExp(P.soft.replyAdmissionPattern, 'i');
    eq('owner correction ack is a soft signal', ack.test('Correction recorded: a company account exists and the owner holds access.'), true);
    eq('the owner changing direction is not (review B4)', ack.test('Took the stance as policy: mandate local-first-no-outreach.'), false);
    eq('a reply admitting the error is', reply.test("Owner — you're right, and it was my call that set that in motion"), true);
    eq('agreeing with an idea is not', reply.test('Understood on testing, and I think you were right about the containers.'), false);
    eq('scope that names the changed file covers it', H.scopeShareOf('Doc reviewed: `docs/design/loyalty-web.md`', ['docs/design/loyalty-web.md']).share, 1);
    eq('scope naming 1 of 4 changed paths covers a quarter (review A9)', H.scopeShareOf('scope: README.md only', ['a/README.md', 'b.ts', 'c.ts', 'd.ts']).share, 0.25);
  }

  console.log('T16 the ledger: deterministic ids, a lock, a tamper-evident chain, anchors');
  {
    const dir = require('../../../lib/temp-life').tmpDir('competence-selftest-');
    try {
      const ledger = path.join(dir, 'l.jsonl'), lock = path.join(dir, 'l.lock');
      const rows = [1, 2, 3].map(i => ({ schema: 1, kind: 'credit', signal: 'pr.merged', agent: 'engineer', at: at(i), id: H.mkId('pr.merged', 'gh#' + i, 'engineer', 'build', 'credit', ''), recordedAt: at(i) }));
      eq('same source, same id', H.mkId('pr.merged', 'gh#1', 'engineer', 'build', 'credit', ''), rows[0].id);
      eq('three rows written', H.appendRows(rows, { ledger, lock }).length, 3);
      eq('re-collecting the same source writes nothing', H.appendRows(rows, { ledger, lock }).length, 0);
      fs.writeFileSync(lock, 'stale'); fs.utimesSync(lock, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
      eq('a stale lock (older than 10 min) is cleared', H.appendRows([Object.assign({}, rows[0], { id: 'ev_x4' })], { ledger, lock }).length, 1);
      const read = H.readLedger(ledger);
      let vr = H.verifyLedger(read, '');
      eq('chain verifies', vr.ok, true);
      const anchorText = '| x | Competence ledger anchor: 3 events, head `' + read[2].hash + '` | y | z |';
      eq('anchor matches', H.verifyLedger(read, anchorText).ok, true);
      const lines = fs.readFileSync(ledger, 'utf8').split('\n');
      const edited = JSON.parse(lines[1]); edited.agent = 'deployer'; lines[1] = JSON.stringify(edited);
      vr = H.verifyLedger(lines.filter(Boolean).map(l => JSON.parse(l)), '');
      check('an edited row is caught', !vr.ok && /hash does not match/.test(vr.problems.join()), vr.problems.join('; '));
      const dropped = read.filter((_, i) => i !== 1);
      check('a removed row is caught', !H.verifyLedger(dropped, '').ok);
      // rewrite everything after an edit (the attack review A8 describes): the anchor still catches it
      let prev = H.GENESIS; const forged = read.map(r => { const o = Object.assign({}, r, { agent: 'deployer', prev }); delete o.hash; o.hash = H.rowHash(prev, o); prev = o.hash; return o; });
      eq('a fully recomputed chain passes on its own (tamper-evident, not tamper-proof)', H.verifyLedger(forged, '').ok, true);
      check('...but not against the anchor in decisions.md', !H.verifyLedger(forged, anchorText).ok);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('T17 an amendment needs the people owner, a reason, and is never about yourself');
  {
    const dir = require('../../../lib/temp-life').tmpDir('competence-selftest-');
    const saved = Object.assign({}, H.FILES);
    try {
      H.FILES.ledger = path.join(dir, 'l.jsonl'); H.FILES.lock = path.join(dir, 'l.lock'); H.FILES.loops = path.join(dir, 'loops.json'); H.FILES.policy = POLICY;
      fs.writeFileSync(H.FILES.loops, JSON.stringify({ agents: CREW }));
      const own = soft({ signal: 'own-error', agent: 'agent', at: at(0), severity: 'S2', reach: 'R3', caught: 'after', ownUp: true });
      const hrOwn = soft({ signal: 'owner.correction', agent: 'hiring', at: at(0), severity: 'S2', reach: 'R3', caught: 'owner' });
      H.appendRows([own, hrOwn], { ledger: H.FILES.ledger, lock: H.FILES.lock });
      const refused = (fn, re) => { try { fn(); return false; } catch (e) { return e.code === 2 && (!re || re.test(e.message)); } };
      check('refused without a reason', refused(() => H.amend(own.id, { by: 'Taylor', severity: 'S3' }), /reason/));
      check('refused for anyone but the people owner', refused(() => H.amend(own.id, { by: 'Jordan', reason: 'I think it is minor', severity: 'S3' }), /only Taylor/));
      check('refused on your own event', refused(() => H.amend(hrOwn.id, { by: 'Taylor', reason: 'this was not my error', void: true }), /own events/));
      check('the people owner\'s own event is amended by Morgan or Quinn', !refused(() => H.amend(hrOwn.id, { by: 'Morgan', reason: 'the owner changed direction, nobody was wrong', void: true })));
      const ok = H.amend(own.id, { by: 'Taylor', reason: 'the plan was ratified on a false premise, harm was stopped', severity: 'S2', reach: 'R4' });
      eq('Taylor\'s amendment is recorded with its reason', ok.reason.length > 10 && ok.changes.reach === 'R4', true);
    } finally { Object.assign(H.FILES, saved); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('T18 a serious flaw needs confirming, and every confirmed one reaches Taylor');
  {
    const c = credit({ agent: 'engineer', ref: 'gh#9101', at: at(0), files: [{ path: 'api/src/big.ts', additions: 500, deletions: 0 }], v: 0.8 });
    const forged = flaw({ agent: 'engineer', parent: c.id, severity: 'S1', reach: 'R2', finder: 'cand-qa-robin', finderCorroboratedBy: null, at: at(1), ref: 'qa-006' });
    let r = C([c, forged], at(2));
    eq('a defect file no run wrote and nobody classified: no serious flag', r.serious.length, 0);
    eq('...no sample against Jordan', r.samples.filter(s => s.agent === 'engineer' && s.q === 0).length, 0);
    eq('...listed as unconfirmed', r.unconfirmed.map(u => u.id).join(), forged.id);
    const cls = row({ kind: 'record', signal: 'defect.classified', agent: 'auditor', target: forged.id, severity: 'S1', corroboratedBy: 'run-p', at: at(1, 2), source: { ref: 'cls-verdict' } });
    r = C([c, forged, cls], at(2));
    eq('a corroborated classifier confirms it: flagged', r.serious.map(s => s.attribution).join(), 'verified');
    const late = row({ kind: 'record', signal: 'finding.corroborated', agent: 'cand-qa-robin', target: forged.id, corroboratedBy: 'run-v', at: at(1, 3), source: { ref: 'late' } });
    eq('...and so does the finder\'s run found by a later collect', C([c, forged, late], at(2)).serious.length, 1);
    const selfCls = row({ kind: 'record', signal: 'defect.classified', agent: 'engineer', target: forged.id, severity: 'S3', corroboratedBy: 'run-n', at: at(1, 2), source: { ref: 'self-cls' } });
    eq('the author classifying her own flaw confirms nothing', C([c, forged, selfCls], at(2)).serious.length + C([c, forged, selfCls], at(2)).samples.filter(s => s.q === 0).length, 0);
    const s0 = flaw({ agent: null, parent: null, severity: 'S0', reach: 'R4', finder: 'cand-qa-robin', codeEra: 'company', at: at(1), ref: 'qa-007' });
    r = C([s0], at(2));
    eq('a confirmed S0 nobody is attributed to is still flagged', r.serious.map(s => (s.agent || 'none') + '/' + s.attribution).join(), 'none/unattributed');
    eq('...and waits for attribution', r.attribution.length, 1);
    const old = flaw({ agent: null, parent: null, severity: 'S0', reach: 'R4', finder: 'cand-qa-robin', codeEra: 'pre-company', at: at(1), ref: 'qa-008' });
    eq('pre-company code is not a person\'s serious flaw', C([old], at(2)).serious.length, 0);
    const pend = credit({ agent: 'engineer', ref: 'gh#9102', at: at(0), files: [{ path: 'api/src/p.ts', additions: 100, deletions: 0 }], v: 0, pending: 'author-unverified' });
    const onPend = flaw({ agent: 'engineer', parent: pend.id, severity: 'S1', reach: 'R4', finder: 'cand-qa-robin', at: at(1), ref: 'qa-009' });
    r = C([pend, onPend], at(2));
    eq('an S1 on work whose author is not verified: flagged, naming the declared author', r.serious.map(s => s.agent + '/' + s.attribution).join(), 'engineer/work-unverified');
    eq('...but nobody is charged yet', r.samples.length, 0);
    const dir = require('../../../lib/temp-life').tmpDir('competence-selftest-');
    const saved = Object.assign({}, H.FILES);
    try {
      H.FILES.handoffs = dir;
      H.seriousFlags(C([s0], at(2)), crew, {}, {});
      const rach = fs.readFileSync(path.join(dir, 'to-taylor.md'), 'utf8');
      check('unattributed flag: an OPEN handoff to Taylor asking her to attribute it', /competence serious flag: unattributed, S0/.test(rach) && /--agent <name>/.test(rach) && /\*\*Status:\*\* OPEN/.test(rach));
      check('...and no manager FYI', !fs.existsSync(path.join(dir, 'to-alex.md')));
      H.seriousFlags(r, crew, {}, {});
      check('unverified-work flag names Jordan and asks Taylor to confirm', /competence serious flag: Jordan, S1/.test(fs.readFileSync(path.join(dir, 'to-taylor.md'), 'utf8')) && /no run record shows Jordan/.test(fs.readFileSync(path.join(dir, 'to-taylor.md'), 'utf8')));
    } finally { Object.assign(H.FILES, saved); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  console.log('T19 a ruling counts only if Taylor\'s own run ran that amend, with those changes');
  {
    const ru = { target: 'ev_0123456789abcdef', changes: { void: true } };
    eq('an unrelated Taylor run does not corroborate it', H.amendMatches(ru, 'cat company/work/people/scoreboard.md', crew), false);
    eq('the amend command on that event does', H.amendMatches(ru, 'node company/tools/competence.js amend ev_0123456789abcdef --by Taylor --reason "owner changed direction" --void', crew), true);
    eq('an amend of the same event with different changes does not', H.amendMatches(ru, 'node company/tools/competence.js amend ev_0123456789abcdef --by Taylor --reason "x" --uphold', crew), false);
    eq('an --agent change matches the name she typed', H.amendMatches({ target: 'ev_0123456789abcdef', changes: { agent: 'engineer' } }, 'node company/tools/competence.js amend ev_0123456789abcdef --by Taylor --agent Jordan --reason "blame"', crew), true);
  }

  console.log('T20 a typed "ranAt" is not proof: the file must not have changed after the merge, and a run must have run the test');
  {
    const rec = { verdict: 'PASS', dirty_files: 0, required_lanes: 'api', lanes: { api: { cases: 40 } }, command: 'bash company/tools/test-substrate.sh --api', ranAt: '2026-11-14T20:30:00Z' };
    const merged = Date.parse('2026-11-14T21:00:00Z');
    eq('the file was written after the merge (ctime): not a hard signal', H.testRecordSignal(rec, merged, { ctimeMs: Date.parse('2026-11-15T01:00:00Z') }).ok, false);
    eq('written before: still fine', H.testRecordSignal(rec, merged, { ctimeMs: Date.parse('2026-11-14T20:30:00Z') }).ok, true);
    const RI = H.runIndex([{ runId: 'r-sub', agentId: 'deployer', startedAt: Date.parse('2026-11-14T19:40:00Z'), endedAt: Date.parse('2026-11-14T19:50:00Z'), completionEvidence: { effects: [{ target: 'nohup bash company/tools/test-substrate.sh --api > out.log 2>&1 &' }] } }]);
    eq('a background substrate run that finished 40 minutes after its run ended matches', (H.testRecordRun(RI, rec, merged, {}) || {}).runId, 'r-sub');
    eq('no run ran the test: no match', H.testRecordRun(H.runIndex([]), rec, merged, {}), null);
  }

  console.log('T21 the gate audit: a post-merge re-run does not erase the PASS, and any merge command form is matched');
  {
    const rec = { verdict: 'FAIL', at: '2026-11-15T07:30:00Z', history: [{ verdict: 'PASS', at: '2026-11-15T06:50:00Z' }] };
    eq('the PASS in history before the merge counts', (H.gatePassFor(rec, Date.parse('2026-11-15T07:00:00Z')) || {}).at, '2026-11-15T06:50:00Z');
    eq('a PASS only after the merge does not', H.gatePassFor({ verdict: 'PASS', at: '2026-11-15T08:00:00Z' }, Date.parse('2026-11-15T07:00:00Z')), null);
    eq('gh pr merge --merge --delete-branch 209', H.ghPrCmd('gh pr merge --merge --delete-branch 209', 'merge', 209), true);
    eq('gh pr merge https://github.com/o/r/pull/209', H.ghPrCmd('gh pr merge https://github.com/o/r/pull/209 --merge', 'merge', 209), true);
    eq('not PR 2091, not a sha', H.ghPrCmd('gh pr merge 2091 --match-head-commit 209abcd', 'merge', 209), false);
    eq('not another repo', H.ghPrCmd('gh pr merge 209 --repo other/repo', 'merge', 209, 'Acme/App'), false);
  }

  console.log('T22 a flaw caught in review never costs more than the same flaw found after the merge');
  {
    const big = credit({ agent: 'engineer', ref: 'gh#9201', at: at(0), files: [{ path: 'api/src/big.ts', additions: 5000, deletions: 0 }], v: 1.0 });
    const inRev = flaw({ signal: 'flaw.in-review', agent: 'engineer', parent: big.id, severity: 'S2', reach: 'R4', caught: 'review', finder: 'auditor', at: at(-1), findingKey: 'k1', share: 1, fixLines: 10 });
    const big2 = credit({ agent: 'engineer', ref: 'gh#9202', at: at(0), files: [{ path: 'api/src/big2.ts', additions: 5000, deletions: 0 }], v: 1.0 });
    const post = flaw({ agent: 'engineer', parent: big2.id, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(1) });
    const a = C([big, inRev], at(3)), b = C([big2, post, fixed(post.id, at(2), 10)], at(3));
    eq('caught in review: 50 - min(9, 0.5 x 50 x 0.1) = 47.5', B(a, 'engineer', 'build').xp, 47.5);
    check('...no more than found after the merge (' + B(b, 'engineer', 'build').xp + ')', B(a, 'engineer', 'build').xp >= B(b, 'engineer', 'build').xp);
  }

  console.log('T23 approving big work never pays more than writing it');
  {
    const c = credit({ agent: 'engineer', ref: 'gh#9301', at: at(0), files: [{ path: 'api/src/huge.ts', additions: 5000, deletions: 0 }], v: 0.8 });
    const a = approval({ agent: 'auditor', ref: 'gh#9301', at: at(0), parents: [c.id], prSizePts: 1000, files: ['api/src/huge.ts'] });
    const r = C([c, a], at(20));
    eq('Jordan: 0.8 x 50', B(r, 'engineer', 'build').xp, 40);
    eq('Quinn: 0.3 x min(50, 1000) = 15, not 50', B(r, 'auditor', 'review').xp, 15);
  }

  console.log('T24 splitting: the same branch or the same issue is one piece of work too');
  {
    const parts = [0, 1, 2, 3].map(k => Object.assign(credit({ agent: 'designer', ref: 'gh#94' + k, at: at(0, k), files: [{ path: 'web/part' + k + '.ts', additions: 300, deletions: 0 }], v: 0.8 }), { refs: [3] }));
    let r = C(parts, at(2));
    eq('four 300-line PRs on different files naming the same issue: one unit, 0.8 x 50', B(r, 'designer', 'build').xp, 40);
    const br = [0, 1].map(k => Object.assign(credit({ agent: 'designer', ref: 'gh#95' + k, at: at(0, k), files: [{ path: 'web/b' + k + '.ts', additions: 300, deletions: 0 }], v: 0.8 }), { headRef: 'feat/web-claim' }));
    r = C(br, at(2));
    eq('two PRs from one branch: one unit', r.units.length, 1);
  }

  console.log('T25 one defect is one flaw, and every fix PR counts toward the fix size');
  {
    const c = credit({ agent: 'engineer', ref: 'gh#9401', at: at(0), files: [{ path: 'api/x.ts', additions: 200, deletions: 0 }], v: 0.8 });
    const d1 = flaw({ agent: null, parent: null, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(1), ref: 'company/work/engineering/defects/qa-010.md', key: 'a' });
    const d2 = flaw({ agent: 'engineer', parent: c.id, severity: 'S2', reach: 'R4', finder: 'cand-qa-robin', at: at(1), ref: 'company/work/engineering/defects/qa-010.md', key: 'b' });
    const r = C([c, d1, d2, fixed(d2.id, at(2), 40)], at(5));
    eq('two rows for one defect file (blame moved): one flaw, the attributed one', r.units[0].flaws.length + r.attribution.length, 1);
    const honest = C([c, d2, fixed(d2.id, at(3), 40)], at(5));
    const decoy = C([c, d2, fixed(d2.id, at(2), 1), fixed(d2.id, at(3), 40)], at(5));
    eq('a 1-line decoy fix first does not shrink the charge', B(decoy, 'engineer', 'build').xp <= B(honest, 'engineer', 'build').xp, true);
    eq('...and does not cut the finder\'s pay', B(decoy, 'cand-qa-robin', 'review').xp >= B(honest, 'cand-qa-robin', 'review').xp, true);
  }

  console.log('T26 document verdicts: three verdicts on one plan pay the reviewer once');
  {
    const doc = { path: 'company/work/product/plan.md', additions: 200, deletions: 0 };
    const cr = [1, 2, 3].map(k => credit({ signal: 'work.reviewed', agent: 'drafter', ref: 'verdict-' + k, at: at(0, k), files: [doc], v: 0.8 }));
    const ap = cr.map((c, k) => approval({ agent: 'auditor', ref: 'verdict-' + (k + 1), at: at(0, k + 1), parents: [c.id], prSizePts: 10, files: [doc.path] }));
    ap.forEach(a => { a.source.subject = doc.path; });
    const r = C(cr.concat(ap), at(20));
    eq('Sam: one piece of work, 0.8 x 10', B(r, 'drafter', 'planning').xp, 8);
    eq('Quinn: one approval, 0.3 x 10', B(r, 'auditor', 'review').xp, 3);
    const t = '# Plan\n\n## 1. Intro\na\nb\n## 2. Money\nc\nd\ne\n### 2.1 Detail\nf\n## 3. End\ng\n';
    eq('a scope naming §2 sizes section 2 only (heading to the next ## heading)', H.sectionLines(t, 'Reviewed against `company/work/product/plan.md` §2'), 6);
    eq('"lines 30-42" sizes 13 lines', H.sectionLines(t, 'Page re-read: `x.md` lines 30–42'), 13);
    eq('no part named: whole document', H.sectionLines(t, 'Reviewed against `x.md`'), null);
    eq('"APPROVE WITH CHANGES — two blocking" is conditional', H.parseVerdictFile('# x\n\n## VERDICT: APPROVE WITH CHANGES — two blocking (D1, D2), seven material\n').blocking, true);
    eq('"... five non-blocking" alone is not', H.parseVerdictFile('# x\n\n## VERDICT: APPROVE WITH CHANGES — five non-blocking\n').blocking, false);
  }

  console.log('T27 soft signals: admitting it in a reply counts as owned up');
  {
    const reply = soft({ signal: 'owner.correction', agent: 'agent', at: at(0), severity: 'S2', reach: 'R3', caught: 'owner', ownUp: true, ref: 'msg-reply' });
    const r = C([reply], at(0, 1));
    eq('S2 R3 owner-caught, owned up: 12 x 2 x 1.5 x 0.8 = 28.8 (not 36)', r.waiting[0].D, 28.8);
  }

  console.log('T28 verify checks every anchor copy: decisions.md, the state file and the dispatch log');
  {
    const rows = [1, 2, 3].map(i => ({ schema: 1, kind: 'credit', signal: 'pr.merged', agent: 'engineer', at: at(i), id: 'ev_t28_' + i }));
    let prev = H.GENESIS; for (const o of rows) { o.prev = prev; o.hash = H.rowHash(prev, o); prev = o.hash; }
    const anchorRow = '| x | Competence ledger anchor: 2 events, head `' + rows[1].hash + '` | y | z |';
    const st = [{ n: 2, head: rows[1].hash }];
    eq('all copies agree: ok, 1 row after the last anchor', [H.verifyLedger(rows, anchorRow, { stateAnchors: st }).ok, H.verifyLedger(rows, anchorRow, { stateAnchors: st }).unanchored].join(), 'true,1');
    let p2 = H.GENESIS; const forged = rows.map(r => { const o = Object.assign({}, r, { agent: 'deployer', prev: p2 }); delete o.hash; o.hash = H.rowHash(p2, o); p2 = o.hash; return o; });
    const rewritten = '| x | Competence ledger anchor: 2 events, head `' + forged[1].hash + '` | y | z |';
    check('chain recomputed and the decisions.md row rewritten: the state file still catches it', !H.verifyLedger(forged, rewritten, { stateAnchors: st }).ok);
    check('decisions.md anchor row deleted: caught', !H.verifyLedger(rows, '', { stateAnchors: st }).ok);
    check('the dispatch log copy catches a rewrite too', !H.verifyLedger(forged, rewritten, { stateAnchors: [{ n: 2, head: forged[1].hash }], logText: '- COMPETENCE daily: anchor anchored 2 rows, head ' + rows[1].hash }).ok);
    eq('a state head that is not in the ledger is a problem', H.verifyLedger(rows, '', { stateAnchors: H.stateAnchorsOf({ lastAnchor: 'sha256:' + 'f'.repeat(64) }, rows) }).ok, false);
  }

  console.log('T29 comment verdicts: a negative wins, "tests PASS" is not an approval');
  {
    eq('"not approving yet, tests PASS but REQUEST CHANGES"', H.verdictOf('Reviewer: Jordan — not approving yet, tests PASS but REQUEST CHANGES'), 'REQUEST CHANGES');
    eq('"Reviewer: Robin — PASS" is a QA approval', H.verdictOf('Reviewer: Robin — PASS (api 110, flutter 729)'), 'PASS');
    eq('"I do not approve this" with no verdict line', H.verdictOf('Reviewer: Quinn\nI do not approve this until the leak is fixed.'), 'REQUEST CHANGES');
    eq('a verdict line still wins over later words', H.verdictOf('## OVERALL: APPROVE\n\nThe earlier FAIL was a flaky test.'), 'APPROVE');
  }

  console.log('T30 times are company time (here the UTC+07 test zone), whatever the process time zone is');
  {
    eq('09:34:04Z is 16:34 company time', H.localStamp(Date.parse('2026-11-15T09:34:04Z')), '2026-11-15 16:34');
    eq('17:30Z is already the next company day', H.localDay(Date.parse('2026-11-15T17:30:00Z')), '2026-11-16');
    eq('a decisions.md row at 16:45 is 09:45Z', new Date(H.parseOwnErrors('| 2026-11-15 16:45 | x | Alex (own error) | y |')[0].at).toISOString(), '2026-11-15T09:45:00.000Z');
  }

  console.log('T31 a huge row never blocks the collect; collector versions; late-appearing runs');
  {
    const dir = require('../../../lib/temp-life').tmpDir('competence-selftest-');
    try {
      const ledger = path.join(dir, 'l.jsonl'), lock = path.join(dir, 'l.lock');
      const huge = { schema: 1, kind: 'credit', signal: 'pr.merged', agent: 'engineer', at: at(0), id: 'ev_huge', files: Array.from({ length: 400 }, (_, i) => 'api/src/some/long/path/file' + i + '.ts'), verifiers: Array.from({ length: 50 }, (_, i) => ({ agent: 'x' + i, note: 'y'.repeat(60) })) };
      let out = null, threw = false; try { out = H.appendRows([huge, { schema: 1, kind: 'credit', signal: 'pr.merged', agent: 'engineer', at: at(0), id: 'ev_small' }], { ledger, lock }); } catch (_) { threw = true; }
      check('appendRows does not throw on an oversized row, and the next row is still written', !threw && out.some(r => r.id === 'ev_small'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const v1 = Object.assign(credit({ agent: 'engineer', ref: 'gh#9501', at: at(0), files: [{ path: 'api/v.ts', additions: 100, deletions: 0 }], v: 0.8 }), { writer: H.COLLECT_WRITER });
    const v2 = Object.assign({}, v1, { collector: 2, id: H.mkId('pr.merged', 'gh#9501', 'engineer', 'build', 'credit', '', 2), srcKey: v1.id });
    eq('only the newest collector\'s rows are scored', C([v1, v2], at(1)).units.length, 1);
    const voidV1 = ruling(v1.id, 'hiring', { void: true }, at(0, 1), true);
    eq('a ruling made on the old row follows the source to the new one', C([v1, v2].concat(voidV1), at(1)).units.length, 0);
    const seen = { at: Date.parse(at(1)), ids: { 'run-a': 1 } };
    const late = H.lateRuns([{ runId: 'run-a', endedAt: Date.parse(at(0)) }, { runId: 'run-forged', endedAt: Date.parse(at(0)) }, { runId: 'run-new', endedAt: Date.parse(at(1, 2)) }], seen, 600e3, 0);
    eq('a run that ended before the last collect but was not in it is late; a new one is not', late.map(r => r.runId).join(), 'run-forged');
  }

  console.log('T32 authorship is tied to the commit, not to any commit at that time');
  {
    const needles = H.commitNeedles('feat(api): borrowed thing for the menu', ['api/src/t207.ts'], 'feat/borrowed-207');
    eq('an unrelated `git commit -m "notes"` does not verify the author', H.commitEffect('cd company && git commit -m "notes"', needles), false);
    eq('a commit naming the subject does', H.commitEffect('git commit -q -m "feat(api): borrowed thing for the menu (Sam)"', needles), true);
    eq('an --amend --no-edit after adding the changed file does', H.commitEffect('git add api/src/t207.ts && git commit -q --amend --no-edit', needles), true);
    eq('a push of the PR branch does', H.commitEffect('cd /tmp/wt && git push origin feat/borrowed-207', needles), true);
    eq('reading the branch is not making a commit', H.commitEffect('git log --oneline feat/borrowed-207', needles), false);
  }

  console.log('\n' + (failed ? 'SELFTEST FAILED: ' + failed + ' of ' + n + ' checks' : 'SELFTEST PASS: ' + n + ' checks'));
  return failed ? 1 : 0;
}
module.exports = { run, CREW };
