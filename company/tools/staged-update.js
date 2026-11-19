#!/usr/bin/env node
/* staged-update.js — the crew takes a framework update on its own, sandbox first, with a watchdog that rolls back.
 *
 *   node company/tools/staged-update.js apply --by <seat> [--expect <sha>] [--no-watch] [--json]
 *        (also `framework-update.js apply --by <seat>` for anyone who is not the owner). Refused unless:
 *          - selfimprove.json enabled is on;
 *          - no watch is running here and the target was never rolled back here;
 *          - the target is the upstream head (origin/main), GitHub's CI on it is green;
 *          - every first-parent commit from here to the target came through the merge tool (capheos-merges.jsonl of any
 *            company) or is behind an owner baseline;
 *          - this company is the sandbox (selfimprove.json sandboxRoot), or the sandbox already runs the target (or a
 *            later commit) and its watch said "healthy" after watchMin, at least soakMin ago from its apply.
 *        Then framework-update.js apply (backup, owned files kept, fast-forward, setup when needed, station restart when
 *        idle) and the watchdog: a transient systemd --user unit (systemd-run) running `watch`.
 *   node company/tools/staged-update.js watch     the watchdog loop: a health check every minute for watchMin (30) minutes.
 *        Healthy = the station, dispatcher and console units that were active before are active, none restarted 3+ times
 *        (no crash loop), the dispatcher ticked recently (company/state/dispatcher-loop.json), and the console's own health
 *        file (company/state/console-health.json, written by the console about itself) is fresh and ok. Never calls a port.
 *        3 unhealthy checks in a row (after a 5-minute grace) = rollback to the commit before the update: owned files kept,
 *        git reset to it, setup again when the update had changed setup, the units restarted; the crew gets an OPEN
 *        handoff (tools seat) and the owner one plain line. At the end with no trouble: a "healthy" row.
 *   node company/tools/staged-update.js tick       the dispatcher's fallback: finishes a watch whose own unit died.
 *   node company/tools/staged-update.js rollback --by <seat> [--why "..."]   roll the running update back now.
 *   node company/tools/staged-update.js status
 * Rows: company/state/staged-updates.jsonl (applied | healthy | rollback | rollback-failed). Watch: company/state/update-watch.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const co = require('./lib/company');
const SI = require('./lib/selfimprove');

const ROOT = co.ROOT;
const ROWS = co.p('company', 'state', 'staged-updates.jsonl');
const WATCH = co.p('company', 'state', 'update-watch.json');
const MIN = 60e3;
const now = () => new Date().toISOString();
const git = (root, args) => { const r = spawnSync(SI.REAL_GIT, ['-C', root].concat(args), { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }); return { ok: r.status === 0, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }; };
const saveWatch = w => { fs.mkdirSync(path.dirname(WATCH), { recursive: true }); fs.writeFileSync(WATCH, JSON.stringify(w, null, 1) + '\n'); };
const svcName = () => (co.config.station && co.config.station.serviceName) || 'capheos-station';
const units = () => { const s = svcName(); return [s + '.service', s + '-dispatch.service', s + '-console.service']; };
const SYSTEMCTL = process.env.STAGED_UPDATE_SYSTEMCTL || '/usr/bin/systemctl';
function unitInfo(u) {
  const r = spawnSync(SYSTEMCTL, ['--user', 'show', u, '-p', 'ActiveState', '-p', 'NRestarts', '-p', 'LoadState'], { encoding: 'utf8', timeout: 15000 });
  const m = {}; for (const l of String(r.stdout || '').split('\n')) { const i = l.indexOf('='); if (i > 0) m[l.slice(0, i)] = l.slice(i + 1); }
  return { active: m.ActiveState === 'active', state: m.ActiveState || 'unknown', restarts: Number(m.NRestarts) || 0, loaded: m.LoadState === 'loaded' };
}

/* ---------------- the gates ---------------- */
function gates(o) {
  const cfg = SI.config();
  const why = [];
  if (!cfg.enabled) return { ok: false, why: ['self-improvement is off here (company/state/selfimprove.json enabled)'] };
  const w = SI.readJ(WATCH, null);
  if (w && w.status === 'watching') why.push('an update is still being watched (since ' + w.startedAt + ')');
  const FU = require('./framework-update');
  const c = FU.check({ root: ROOT, noFetch: !!o.noFetch });
  if (!c.ok) return { ok: false, why: [c.error] };
  if (c.upToDate) return { ok: true, upToDate: true, check: c };
  const target = c.target;
  if (!/\/(main|master)$/.test(c.upstream)) why.push('this checkout follows ' + c.upstream + ', not the framework\'s main');
  if (o.expect && !target.startsWith(o.expect)) why.push('upstream is ' + target.slice(0, 10) + ', not ' + o.expect);
  if (SI.readJsonl(ROWS).some(r => r.kind === 'rollback' && r.bad === target)) why.push(target.slice(0, 10) + ' was rolled back here before; a newer merge is needed');
  let ci = null; try { ci = SI.ciOf(cfg.repo, target); } catch (e) { why.push('could not read CI for ' + target.slice(0, 10) + ': ' + e.message); }
  if (ci && !ci.green) why.push('CI on ' + target.slice(0, 10) + ' is not green' + (ci.pending.length ? ' (running: ' + ci.pending.join(', ') + ')' : '') + (ci.failed.length ? ' (failed: ' + ci.failed.join(', ') + ')' : '') + (!ci.runs ? ' (no checks)' : ''));
  // every first-parent commit from here to the target: a merge-tool merge, or behind an owner baseline
  const trusted = SI.trustedShas();
  const stops = [...trusted.entries()].filter(([, r]) => r.kind === 'baseline').map(([s]) => s).filter(s => git(ROOT, ['cat-file', '-e', s + '^{commit}']).ok).map(s => '^' + s);
  const line = git(ROOT, ['rev-list', '--first-parent', target, '^' + c.head].concat(stops));
  const unrec = line.ok ? line.out.split('\n').filter(Boolean).filter(s => !trusted.has(s)) : null;
  if (!line.ok) why.push('could not list the commits to take: ' + line.err.split('\n')[0]);
  else if (unrec.length) why.push(unrec.length + ' commit(s) did not come through the merge tool (' + unrec.slice(0, 5).map(s => s.slice(0, 10)).join(', ') + '): the owner can take them with `capheos-merge.js baseline --by owner --sha <sha>`');
  // sandbox first
  let soak = 'this is the sandbox';
  if (!SI.isSandbox(ROOT)) {
    const sb = cfg.sandboxRoot;
    const rows = SI.readJsonl(path.join(sb, 'company', 'state', 'staged-updates.jsonl'));
    const contains = to => to && (to === target || spawnSync(SI.REAL_GIT, ['-C', sb, 'merge-base', '--is-ancestor', target, to]).status === 0);
    const ok = rows.filter(r => r.kind === 'healthy' && contains(r.to) && Date.now() - Date.parse(r.appliedAt || r.at) >= cfg.soakMin * MIN);
    const sbHead = git(sb, ['rev-parse', 'HEAD']).out;
    if (!ok.length) why.push('the sandbox (' + sb + ') has not run ' + target.slice(0, 10) + ' healthy for ' + cfg.soakMin + ' minutes yet');
    else if (!contains(sbHead)) why.push('the sandbox is no longer on ' + target.slice(0, 10) + ' (rolled back?)');
    else soak = 'sandbox healthy on ' + ok[ok.length - 1].to.slice(0, 10) + ' since ' + ok[ok.length - 1].at;
  }
  return { ok: !why.length, why, check: c, target, ci, soak };
}

/* ---------------- apply ---------------- */
function crewApply(o) {
  const by = String(o.by || '');
  if (!by) return { ok: false, code: 2, error: '--by <seat> is required' };
  const g = gates(o);
  if (!g.ok) return { ok: false, code: 3, error: 'not applied: ' + g.why.join('; ') };
  if (g.upToDate) return { ok: true, upToDate: true, head: g.check.head };
  const before = Object.fromEntries(units().map(u => [u, unitInfo(u)]));
  const FU = require('./framework-update');
  const r = FU.apply({ root: ROOT, by, expect: g.target, noFetch: true, ownerRefusal: () => null });
  if (!r.ok && !r.updated) return Object.assign({ code: 1 }, r);
  const row = SI.appendJsonl(ROWS, { at: now(), kind: 'applied', by, from: r.from, to: r.to, ci: g.ci && g.ci.runs, soak: g.soak, needsSetup: !!r.setup || false, setupOk: r.setup });
  const cfg = SI.config();
  const w = { status: 'watching', by, from: r.from, to: r.to, startedAt: row.at, until: new Date(Date.now() + cfg.watchMin * MIN).toISOString(), needsSetup: !!g.check.needsSetup, before, fails: 0, checks: 0 };
  if (o.noWatch) { w.status = 'not-watched'; saveWatch(w); return Object.assign(r, { watch: 'off (--no-watch)' }); }
  saveWatch(w);
  const unit = svcName() + '-update-watch-' + Date.now().toString(36);
  const sr = spawnSync(process.env.STAGED_UPDATE_SYSTEMD_RUN || '/usr/bin/systemd-run', ['--user', '--unit', unit, '--collect', '--quiet', '--setenv=CAPHEOS_ROOT=' + ROOT, process.execPath, __filename, 'watch'], { encoding: 'utf8', timeout: 30000 });
  w.unit = sr.status === 0 ? unit : null; w.unitError = sr.status === 0 ? undefined : String(sr.stderr || sr.error || '').slice(0, 200);
  saveWatch(w);
  return Object.assign(r, { watch: w.unit ? 'watchdog ' + unit + ' for ' + cfg.watchMin + ' min' : 'watchdog unit did not start (' + w.unitError + '); the dispatcher tick watches instead' });
}

/* ---------------- health ---------------- */
function health(w) {
  const bad = [];
  for (const [u, b] of Object.entries(w.before || {})) {
    if (!b.active) continue;                            // only what ran before the update must run after it
    const i = unitInfo(u);
    if (!i.active) bad.push(u + ' is ' + i.state);
    if (i.restarts - (b.restarts || 0) >= 3) bad.push(u + ' restarted ' + (i.restarts - (b.restarts || 0)) + ' times (crash loop)');
  }
  const dispU = svcName() + '-dispatch.service';
  if (w.before && w.before[dispU] && w.before[dispU].active) {
    const d = SI.readJ(co.p('company', 'state', 'dispatcher-loop.json'), {}) || {};
    const last = Math.max(Date.parse(d.lastTickEndAt || 0) || 0, Date.parse(d.lastTickAt || 0) || 0);
    const tickMin = Number(d.tempo && d.tempo.tickMin) || 10;
    if (Date.now() - last > Math.max(20, 2 * tickMin + 5) * MIN) bad.push('the dispatcher has not ticked since ' + (last ? new Date(last).toISOString() : 'ever'));
  }
  const conU = svcName() + '-console.service';
  if (w.before && w.before[conU] && w.before[conU].active) {
    const h = SI.readJ(co.p('company', 'state', 'console-health.json'), null);
    if (!h) bad.push('the console wrote no health file');
    else if (Date.now() - Date.parse(h.at) > 4 * MIN) bad.push('the console\'s health file is stale (' + h.at + ')');
    else if (!h.ok) bad.push('the console does not answer on its own port (' + (h.error || h.status) + ')');
  }
  return bad;
}

/* one watch step: returns the watch after it (status watching | healthy | rolled-back | rollback-failed) */
function step(w) {
  if (!w || w.status !== 'watching') return w;
  const graceOver = Date.now() - Date.parse(w.startedAt) > 5 * MIN;
  const bad = health(w);
  w.checks = (w.checks || 0) + 1; w.lastCheckAt = now(); w.last = bad;
  w.fails = bad.length && graceOver ? (w.fails || 0) + 1 : 0;
  if (w.fails >= 3) { saveWatch(w); return rollback(w, 'unhealthy after the update: ' + bad.join('; '), 'the watchdog'); }
  if (Date.now() >= Date.parse(w.until)) {
    if (bad.length) { saveWatch(w); return rollback(w, 'unhealthy at the end of the watch: ' + bad.join('; '), 'the watchdog'); }
    w.status = 'healthy'; w.endedAt = now(); saveWatch(w);
    SI.appendJsonl(ROWS, { at: now(), kind: 'healthy', from: w.from, to: w.to, appliedAt: w.startedAt, checks: w.checks });
    SI.tell(null, { seatFn: 'tools', from: 'Staged update', heading: 'FYI: framework update ' + String(w.to).slice(0, 10) + ' ran healthy for its watch', fields: { Status: 'DONE — FYI', Need: 'nothing.', Evidence: 'company/state/staged-updates.jsonl' } });
    return w;
  }
  saveWatch(w);
  return w;
}

function rollback(w, why, by) {
  const steps = [];
  const sh = (name, cmd, args) => { const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 900000 }); steps.push({ step: name, ok: r.status === 0, out: (String(r.stdout || '') + String(r.stderr || '')).trim().split('\n').slice(-4).join('\n') }); return r.status === 0; };
  const FE = require('./lib/framework-edits');
  try { FE.sweep(ROOT, { via: 'staged-update.js rollback', by: 'the crew (found before the rollback)' }); } catch (_) {}
  const saved = {};
  for (const f of FE.OWNED) { const p = path.join(ROOT, f); if (fs.existsSync(p)) saved[f] = fs.readFileSync(p); }
  const tracked = FE.OWNED.filter(f => git(ROOT, ['ls-files', '--error-unmatch', '--', f]).ok);
  if (tracked.length) { git(ROOT, ['update-index', '--no-skip-worktree', '--'].concat(tracked)); git(ROOT, ['checkout', '--'].concat(tracked)); }
  const rs = git(ROOT, ['reset', '--hard', '--quiet', w.from]);
  steps.push({ step: 'git reset to ' + String(w.from).slice(0, 10), ok: rs.ok, out: rs.err });
  for (const [f, b] of Object.entries(saved)) { try { fs.writeFileSync(path.join(ROOT, f), b); } catch (_) {} }
  const guard = path.join(ROOT, 'scripts', 'instance-guard.sh');
  if (fs.existsSync(guard)) sh('instance guard', 'bash', [guard]);
  if (rs.ok && w.needsSetup) sh('scripts/setup-station.sh', 'bash', [process.env.STAGED_UPDATE_SETUP || path.join(ROOT, 'scripts', 'setup-station.sh')]);
  if (rs.ok) for (const [u, b] of Object.entries(w.before || {})) if (b.active) sh('restart ' + u, SYSTEMCTL, ['--user', 'restart', u]);
  w.status = rs.ok ? 'rolled-back' : 'rollback-failed'; w.endedAt = now(); w.why = why; w.steps = steps; saveWatch(w);
  SI.appendJsonl(ROWS, { at: now(), kind: rs.ok ? 'rollback' : 'rollback-failed', by, bad: w.to, back: w.from, why, steps });
  SI.tell(null, { seatFn: 'tools', from: 'Staged update', heading: (rs.ok ? 'P1: framework update ' : 'P0: rollback FAILED for framework update ') + String(w.to).slice(0, 10) + (rs.ok ? ' was rolled back' : ''),
    fields: { Priority: rs.ok ? 'P1' : 'P0', Need: rs.ok ? 'find what broke in ' + String(w.to).slice(0, 10) + ', fix it in a new PR (capheos-merge.js), and let the next update take it. This commit will not be applied here again.' : 'the company may be half-updated: get it back to ' + String(w.from).slice(0, 10) + ' by hand (git reset in the company checkout, then restart its units).', Why: why, Deadline: 'today', Evidence: 'company/state/update-watch.json, company/state/staged-updates.jsonl' },
    owner: rs.ok ? 'The crew tried a software update, it did not run well, so the company went back to the version before. Nothing is lost; the crew is fixing it.' : 'A software update went wrong and the crew could not undo it on its own. The crew is on it now.', ownerKind: rs.ok ? 'fyi' : 'urgent' });
  return w;
}

/* ---------------- selftest: a temp framework repo + a founded clone; the watch step rolls back an unhealthy update and
 * marks a healthy one (fake systemctl, no units, no network) ---------------- */
function selftest() {
  const T = require('./lib/temp-life').tmpDir('staged-update-selftest-');
  fs.writeFileSync(path.join(T, '.capheos-selftest-fixture'), '');
  const G = (cwd, ...x) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-C', cwd, ...x], { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) }); if (r.status !== 0) throw new Error('git ' + x.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  let bad = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) bad++; };
  try {
    const U = path.join(T, 'up'), I = path.join(T, 'co');
    const W = (root, f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    W(U, 'company/company.json', JSON.stringify({ name: 'T', station: { serviceName: 'tst' } }) + '\n'); W(U, 'v.txt', '1\n'); W(U, '.gitignore', 'company/work/\ncompany/state/\n');
    G(U, 'init', '-q'); G(U, 'add', '-A'); G(U, 'commit', '-qm', 'one'); const one = G(U, 'rev-parse', 'HEAD');
    spawnSync('git', ['clone', '-q', U, I]); fs.cpSync(path.join(__dirname, '..', '..', 'company', 'tools'), path.join(I, 'company', 'tools'), { recursive: true });
    W(U, 'v.txt', '2\n'); G(U, 'commit', '-qam', 'two'); const two = G(U, 'rev-parse', 'HEAD');
    G(I, 'fetch', '-q'); G(I, 'merge', '-q', '--ff-only', 'origin/main');
    const sysctl = path.join(T, 'systemctl'); W(T, 'systemctl', '#!/bin/bash\necho "ActiveState=$(cat ' + path.join(T, 'state') + ')"\necho NRestarts=0\necho LoadState=loaded\n'); fs.chmodSync(sysctl, 0o755);
    const run = st => { fs.writeFileSync(path.join(T, 'state'), st); const r = spawnSync(process.execPath, [path.join(I, 'company', 'tools', 'staged-update.js'), '_step'], { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: I, STAGED_UPDATE_SYSTEMCTL: sysctl, CAPHEOS_COMPANIES_DIR: T }) }); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { return { err: r.stderr }; } };
    const before = { 'tst.service': { active: true, restarts: 0 } };
    const wf = path.join(I, 'company', 'state', 'update-watch.json');
    W(I, 'company/state/update-watch.json', JSON.stringify({ status: 'watching', from: one, to: two, startedAt: new Date(Date.now() - 10 * MIN).toISOString(), until: new Date(Date.now() + 10 * MIN).toISOString(), before, fails: 0 }));
    ok(run('active').status === 'watching', 'a healthy check keeps watching');
    ok(run('failed').status === 'watching' && run('failed').status === 'watching', 'two unhealthy checks: still watching');
    const r3 = run('failed');
    ok(r3.status === 'rolled-back' && G(I, 'rev-parse', 'HEAD') === one && fs.readFileSync(path.join(I, 'v.txt'), 'utf8') === '1\n', 'the third unhealthy check rolls back to the commit before: ' + JSON.stringify(r3));
    const rows = SI.readJsonl(path.join(I, 'company', 'state', 'staged-updates.jsonl'));
    ok(rows.some(r => r.kind === 'rollback' && r.bad === two), 'the rollback is recorded with the bad commit');
    G(I, 'merge', '-q', '--ff-only', 'origin/main');
    W(I, 'company/state/update-watch.json', JSON.stringify({ status: 'watching', from: one, to: two, startedAt: new Date(Date.now() - 31 * MIN).toISOString(), until: new Date(Date.now() - MIN).toISOString(), before, fails: 0 }));
    ok(run('active').status === 'healthy' && SI.readJsonl(path.join(I, 'company', 'state', 'staged-updates.jsonl')).some(r => r.kind === 'healthy' && r.to === two), 'a watch that ends healthy writes a healthy row');
    void wf;
  } catch (e) { bad++; console.log('FAIL ' + e.stack); }
  finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log(bad ? bad + ' FAILED' : 'staged-update selftest passed'); return bad ? 1 : 0;
}

/* ---------------- CLI ---------------- */
module.exports = { gates, crewApply, health, step, rollback };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  if (cmd === 'apply') {
    const r = crewApply({ by: opt('by') === true ? '' : opt('by'), expect: opt('expect') === true ? null : opt('expect'), noWatch: !!opt('no-watch'), noFetch: !!opt('no-fetch') });
    console.log(opt('json') ? JSON.stringify(r, null, 1) : r.ok ? (r.upToDate ? 'already up to date' : 'updated ' + r.from.slice(0, 10) + ' -> ' + r.to.slice(0, 10) + '; ' + r.watch) : 'not updated: ' + r.error);
    process.exit(r.ok ? 0 : (r.code || 1));
  } else if (cmd === 'check') {
    const g = gates({ noFetch: !!opt('no-fetch') }); console.log(JSON.stringify({ ok: g.ok, upToDate: !!g.upToDate, target: g.target, why: g.why, soak: g.soak }, null, 1));
  } else if (cmd === 'watch') {
    const every = Number(process.env.STAGED_UPDATE_EVERY_MS) || MIN;
    const loop = () => { const w = step(SI.readJ(WATCH, null)); if (w && w.status === 'watching') setTimeout(loop, every); else console.log('watch ended: ' + (w ? w.status : 'no watch')); };
    loop();
  } else if (cmd === 'tick') {
    const w = SI.readJ(WATCH, null);
    if (!w || w.status !== 'watching') { console.log('STAGED UPDATE: nothing to do'); process.exit(0); }
    if (w.lastCheckAt && Date.now() - Date.parse(w.lastCheckAt) < 3 * MIN) { console.log('STAGED UPDATE: skipped, the watchdog is running'); process.exit(0); }
    const after = step(w); console.log('STAGED UPDATE: watch of ' + String(after.to).slice(0, 10) + ' is ' + after.status + ' (fallback check from the dispatcher)');
  } else if (cmd === 'rollback') {
    const w = SI.readJ(WATCH, null);
    if (!w || !w.from || /rolled-back/.test(w.status)) { console.error('no update to roll back'); process.exit(1); }
    if (!opt('by') || opt('by') === true) { console.error('--by <seat> is required'); process.exit(2); }
    const r = rollback(w, String(opt('why') || 'rolled back by hand'), String(opt('by'))); console.log(r.status); process.exit(r.status === 'rolled-back' ? 0 : 1);
  } else if (cmd === 'status') {
    console.log(JSON.stringify({ watch: SI.readJ(WATCH, null), rows: SI.readJsonl(ROWS).slice(-5) }, null, 1));
  } else if (cmd === 'selftest') process.exit(selftest());
  else if (cmd === '_step') { const w = step(SI.readJ(WATCH, null)); console.log(JSON.stringify({ status: w && w.status })); }
  else { console.error('usage: staged-update.js apply --by <seat> [--expect sha] [--no-watch] | check | watch | tick | rollback --by <seat> [--why ..] | status | selftest'); process.exit(2); }
}
