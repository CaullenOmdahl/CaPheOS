#!/usr/bin/env node
/* accountable.js — accountable leads (docs/DEPARTMENTS.md §8): a member hands finished work back to its lead after checking
 * it itself; the lead's audit is binding; the lead passes accepted work on. The rules and the dispatcher's side are
 * lib/accountable.js.
 *
 *   node company/tools/accountable.js handback <item> --note "<what I checked>" [--tests ".."] [--test-cmd "<cmd>"]...
 *        [--cwd <repo> [--base <ref>] | --diff-file <file> | --no-diff "<why>"] [--pr <url> --sha <head>] --by <member>
 *        the self-check: the item's acceptance check is required, its **Check command:** and every --test-cmd are run
 *        (exit 3 when one fails: nothing goes to the lead), then the audit packet (the diff, the check, the note) goes to
 *        the lead. In recording-only mode it is recorded, nothing is sent.
 *   node company/tools/accountable.js audit <ac-id> --verdict ACCEPT|REVISE --check "<what I checked>" [--finding ".."]... --by <lead>
 *        binding: ACCEPT makes the item DONE and lets its merge (at the handed-back commit) go ahead; REVISE (with at
 *        least one finding) sends it back to the member. The first verdict decides.
 *   node company/tools/accountable.js pass <inbox>#<item> [--escalation cross-department|"owner: money|access|ownership|commitment"] --by <lead>
 *   node company/tools/accountable.js pass <inbox>#<item> --return --why ".." --by <lead>      a held onward handoff
 *   node company/tools/accountable.js drop <inbox>#<item> --why ".." --by <lead>              the item is not needed (not done)
 *   node company/tools/accountable.js escape <ac-id> --why "<what was found>" --by <seat|owner>   a problem found later in
 *        accepted work, charged to the lead's review
 *   node company/tools/accountable.js spot <ac-id> --result agree|disagree --why ".." --by <seat>   a second look
 *   node company/tools/accountable.js list [--dept <id>] [--open] [--json]
 *   node company/tools/accountable.js status [--dept <id>] [--json]                           the department scorecards
 *   node company/tools/accountable.js --selftest
 * Inside an agent's run, --by must be that run's own seat. Exit: 0 done, 2 refused or usage, 3 the self-check failed.
 * Owner of this tool: the tools function.
 */
'use strict';
const path = require('path');
const co = require('./lib/company');
const AC = require('./lib/accountable');

function args(argv) {
  const o = { pos: [], multi: {} };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { o.pos.push(argv[i]); continue; }
    const k = argv[i].slice(2), v = (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    if (k in o && k !== 'pos' && k !== 'multi') (o.multi[k] = o.multi[k] || [o[k]]).push(v); else o[k] = v;
  }
  return o;
}
const many = (a, k) => (a.multi[k] || (a[k] !== undefined ? [a[k]] : [])).filter(x => x !== true);
const str = v => (v === true || v == null ? '' : String(v));

// inside an agent's run the --by claim must be that run's own seat (as departments.js does)
function callerCheck(by, cmd) {
  let pv = null; try { pv = require('./provenance.js'); } catch (_) { return null; }
  if (!pv.underStation()) return null;
  const crew = co.crew(), low = String(by || '').toLowerCase();
  const id = crew[by] ? by : Object.keys(crew).find(k => String((crew[k] || {}).name || '').toLowerCase() === low || String((crew[k] || {}).name || '').split(/\s+/)[0].toLowerCase() === low);
  const env = String(process.env.STARNET_AGENT_ID || '').trim();
  if (id && env && env !== id) return 'this run is ' + ((crew[env] || {}).name || env) + '\'s: --by names the seat running the command';
  const c = id ? pv.callerConflict(co.ROOT, ['accountable.js', cmd], id) : null;
  return c ? 'this command claims --by ' + by + ' but ran in another seat\'s run (' + c.runId + ')' : null;
}

function main(argv) {
  const a = args(argv), cmd = a.pos[0] || 'status';
  const by = str(a.by);
  const res = r => ({ code: r.ok ? 0 : (r.code || 2), out: r });
  if (['handback', 'audit', 'pass', 'drop', 'escape', 'spot'].includes(cmd)) {
    if (!by) return { code: 2, out: { ok: false, error: '--by <name> is required' } };
    const cc = callerCheck(by, cmd); if (cc) return { code: 2, out: { ok: false, error: cc } };
  }
  if (cmd === 'handback') return res(AC.handback({ by, item: a.pos[1], note: str(a.note), tests: str(a.tests) || undefined, testCmds: many(a, 'test-cmd'), cwd: str(a.cwd) || undefined, base: str(a.base) || undefined,
    diffFile: str(a['diff-file']) || undefined, noDiff: str(a['no-diff']) || (a['no-diff'] === true ? 'not given' : undefined), pr: str(a.pr) || undefined, sha: str(a.sha) || undefined }));
  if (cmd === 'audit') return res(AC.audit({ id: a.pos[1], verdict: str(a.verdict), check: str(a.check), findings: many(a, 'finding'), by }));
  if (cmd === 'pass') return res(AC.pass({ ref: a.pos[1], by, escalation: str(a.escalation), ret: a.return === true, why: str(a.why) }));
  if (cmd === 'drop') return res(AC.drop({ ref: a.pos[1], by, why: str(a.why) }));
  if (cmd === 'escape') return res(AC.escape({ id: a.pos[1], by, why: str(a.why) }));
  if (cmd === 'spot') return res(AC.spot({ id: a.pos[1], by, result: str(a.result), why: str(a.why) }));
  if (cmd === 'list') {
    const all = [...AC.audits(AC.rows()).values()].filter(x => (!a.dept || x.hb.dept === a.dept) && (!a.open || x.status === 'open'));
    const out = all.map(x => ({ id: x.id, status: x.hb.shadow ? 'recorded only' : x.status, item: x.hb.ref, seat: x.hb.seat, lead: x.hb.lead, tier: x.hb.tier, at: x.hb.ts, verdict: x.verdict ? x.verdict.verdict : null, escapes: x.escapes.length }));
    return { code: 0, out: a.json ? { ok: true, audits: out } : (out.length ? out.map(x => x.id + '  ' + x.status.padEnd(13) + ' ' + x.tier.padEnd(8) + ' ' + x.seat + ' -> ' + x.lead + '  ' + x.item).join('\n') : 'No audits.') };
  }
  if (cmd === 'status') {
    const s = AC.status({ dept: str(a.dept) || undefined });
    return { code: 0, out: a.json ? s : s.departments.map(d => d.name + ' (' + d.mode + (d.withdrawn ? ', withdrawn' : '') + '): ' + d.words.join(' ')).join('\n') || 'No departments.' };
  }
  return { code: 2, out: { ok: false, error: 'usage: accountable.js handback <item> --note ".." --by <member> | audit <ac-id> --verdict ACCEPT|REVISE --check ".." [--finding ".."] --by <lead> | pass <ref> [--escalation ..|--return --why ..] --by <lead> | drop <ref> --why .. --by <lead> | escape <ac-id> --why .. --by <seat> | spot <ac-id> --result agree|disagree --why .. --by <seat> | list | status | --selftest' } };
}
function run(argv) { try { return main(argv); } catch (e) { return { code: 1, out: { ok: false, error: String(e && e.stack || e) } }; } }

function selftest() {
  const assert = require('assert');
  let fails = 0; const ok = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { fails++; console.log('FAIL ' + name + ': ' + e.message); } };
  ok('acceptance check from a line or a section', () => { assert.equal(AC.acceptanceOf('**Acceptance check:** the parser tests pass'), 'the parser tests pass'); assert.equal(AC.acceptanceOf('### Acceptance check\nnpm test passes\n'), 'npm test passes'); assert.equal(AC.acceptanceOf('**Need:** x'), ''); });
  ok('check command in backticks', () => assert.equal(AC.checkCommandOf('**Check command:** `npm test -- parser`'), 'npm test -- parser'));
  ok('risk: a risky path, a big diff, an explicit routine', () => {
    assert.equal(AC.riskOf({ block: '', diff: '+++ b/secrets/x\n+a\n' }).risky, true);
    assert.equal(AC.riskOf({ block: '**Risk:** routine', diff: '+++ b/secrets/x\n' }).risky, false);
    assert.equal(AC.riskOf({ block: '## fix the docs', diff: '+++ b/docs/a.md\n+x\n' }).risky, false);
  });
  ok('escalation reasons: cross-department or one of the four owner gates', () => { assert.ok(AC.escalationOk('cross-department').ok); assert.ok(AC.escalationOk('owner: money').ok); assert.ok(!AC.escalationOk('owner: tooling').ok); assert.ok(!AC.escalationOk('').ok); });
  ok('audit pairs are config, never a router: null reads the lead model', () => {
    const st = { leadModelDefault: { provider: 'claude-cli', model: 'top' } };
    assert.deepEqual(AC.auditPair('risky', { audit: { routine: { provider: 'claude-cli', model: 'mid' }, risky: null } }, st), { provider: 'claude-cli', model: 'top' });
    assert.deepEqual(AC.auditPair('routine', { audit: { routine: { provider: 'claude-cli', model: 'mid' }, risky: null } }, st), { provider: 'claude-cli', model: 'mid' });
  });
  console.log(fails ? 'ACCOUNTABLE SELFTEST FAILED (' + fails + ')' : 'ACCOUNTABLE SELFTEST PASSED');
  return fails ? 1 : 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--selftest' || argv[0] === 'selftest') process.exit(selftest());
  const r = run(argv);
  console.log(typeof r.out === 'string' ? r.out : JSON.stringify(r.out, null, 1));
  process.exit(r.code);
}
module.exports = { run, main, selftest };
