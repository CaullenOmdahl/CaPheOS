#!/usr/bin/env node
/* framework-update.js — take a framework update into a running company (an instance), safely, without a terminal:
 * the console's Settings › System › Framework update runs it (owner-ops.js), the owner never types a git command.
 *
 *   node company/tools/framework-update.js check [--no-fetch] [--json]
 *        DRY RUN: fetches the upstream branch (only .git refs change), then says what the update would do and changes
 *        nothing else: the commits and files, new StarNet patches, whether setup must run again and what must restart,
 *        how each company-owned file would be merged, and anything that blocks it.
 *   node company/tools/framework-update.js apply --by owner --expect <sha> [--no-backup] [--no-setup] [--no-restart] [--json]
 *        the owner (lib/owner.js: the owner's shell or the console) applies exactly the commit they reviewed (--expect;
 *        refused if upstream moved since). A crew seat (--by <seat>, not the owner) goes through company/tools/staged-update.js
 *        instead: CI green, merge-tool merges only, the sandbox first, then a watchdog that rolls back. Steps, stopping at the first failure with everything put back:
 *          1. scripts/instance-guard.sh (push disabled, hooks in place: an instance never pushes, and this tool has no
 *             push in it at all);
 *          2. scripts/backup.sh (the company's own state), unless --no-backup;
 *          3. the company-owned tracked files (OWNED) are saved, un-hidden and reset to HEAD, so the pull can apply;
 *          4. git merge --ff-only <sha> (never a merge commit, never a rebase: an instance has no commits of its own);
 *          5. each owned file is put back: JSON files (company.json, model-policy.json, competence-policy.json) as a DEEP
 *             MERGE — the framework's new keys are added, every value the company has is kept, arrays are the company's;
 *             CHARTER.md and tools/loops.json as the company's copy, unchanged;
 *          6. scripts/instance-guard.sh again (the owned files hidden again);
 *          7. scripts/setup-station.sh (no --start) when the update ships a StarNet patch or changes systemd/ or the setup
 *             script, unless --no-setup: it applies the patch to the checkout and rewrites the units; it never restarts;
 *          8. a new patch on a running station: scripts/restart-station.sh --when-idle (detached; it holds new starts and
 *             never cuts a run), unless --no-restart. A console change is reported (needsConsoleRestart): the console
 *             restarts itself when no chat is streaming.
 *        Each run: a row in company/state/framework-updates.jsonl (from, to, steps, merged keys) and one line in
 *        company/work/decisions.md. The owned files as they were: company/state/framework-update/<stamp>/.
 *   node company/tools/framework-update.js selftest
 * Env: FRAMEWORK_UPDATE_SETUP (command instead of scripts/setup-station.sh), FRAMEWORK_UPDATE_RESTART (command instead
 * of the detached restart-station.sh), FRAMEWORK_UPDATE_STATION_ACTIVE=1|0 (tests).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const OWNED = require('./lib/framework-edits').OWNED;   // the one list of company-owned tracked files
const MERGE_JSON = ['company/company.json', 'company/competence-policy.json', 'company/model-policy.json'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* deepMerge(framework, company): the framework's shape with every company value on top. Returns { value, added, kept }:
 * added = paths only the framework has (new keys the company receives), kept = paths where both differ (company wins). */
function deepMerge(fw, mine, at, out) {
  out = out || { added: [], kept: [] }; at = at || '';
  if (!isObj(fw) || !isObj(mine)) { if (JSON.stringify(fw) !== JSON.stringify(mine) && at) out.kept.push(at); return { value: mine, added: out.added, kept: out.kept }; }
  const v = {};
  for (const k of Object.keys(fw)) {
    const p = at ? at + '.' + k : k;
    if (!(k in mine)) { v[k] = fw[k]; out.added.push(p); continue; }
    v[k] = deepMerge(fw[k], mine[k], p, out).value;
  }
  for (const k of Object.keys(mine)) if (!(k in fw)) v[k] = mine[k];
  return { value: v, added: out.added, kept: out.kept };
}

function git(root, args, opts) {
  const r = spawnSync('git', ['-C', root].concat(args), Object.assign({ encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }, opts || {}));
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() || (r.error ? r.error.message : '') };
}
const must = (r, what) => { if (!r.ok) throw new Error(what + ': ' + (r.err || 'git failed')); return r.out; };
const readJ = t => { try { return JSON.parse(t); } catch (_) { return null; } };

function check(opts) {
  opts = opts || {};
  const root = opts.root; const blockers = []; const notes = [];
  if (!git(root, ['rev-parse', '--git-dir']).ok) return { ok: false, error: 'not a git checkout: the framework cannot be updated here' };
  const founded = fs.existsSync(path.join(root, 'company', 'work', '.founded'));
  if (!founded) blockers.push('this is the framework checkout itself (not founded): update it with git as a developer');
  const up = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return { ok: false, error: 'this checkout follows no upstream branch (git branch --set-upstream-to), so there is nothing to pull from', blockers };
  const [remote, ...br] = up.out.split('/'); const branch = br.join('/');
  if (!opts.noFetch) { const f = git(root, ['fetch', '--quiet', remote, branch]); if (!f.ok) return { ok: false, error: 'could not fetch ' + up.out + ': ' + f.err }; }
  const head = must(git(root, ['rev-parse', 'HEAD']), 'HEAD');
  const target = must(git(root, ['rev-parse', '@{u}']), 'upstream');
  const [ahead, behind] = must(git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']), 'compare').split(/\s+/).map(Number);
  if (ahead > 0) blockers.push('this company has ' + ahead + ' commit(s) of its own on top of the framework; an instance never commits, so the server admin must look at them first (git log @{u}..HEAD)');
  const base = { ok: true, upstream: up.out, head, target, ahead, behind, upToDate: behind === 0, founded };
  if (behind === 0) return Object.assign(base, { commits: [], files: [], patches: [], owned: [], blockers, notes, needsSetup: false, needsStationRestart: false, needsConsoleRestart: false });
  const commits = git(root, ['log', '--format=%h%x09%an%x09%ad%x09%s', '--date=short', '-n', '50', 'HEAD..@{u}']).out.split('\n').filter(Boolean)
    .map(l => { const [sha, author, date, ...s] = l.split('\t'); return { sha, author, date, subject: s.join('\t') }; });
  const files = git(root, ['diff', '--name-status', 'HEAD', '@{u}']).out.split('\n').filter(Boolean).map(l => { const [st, ...f] = l.split('\t'); return { status: st[0], file: f[f.length - 1] }; });
  const changed = new Set(files.map(f => f.file));
  const patches = files.filter(f => f.status === 'A' && /^company\/patches\/\d{4}-.*\.diff$/.test(f.file)).map(f => path.basename(f.file, '.diff'));
  const needsSetup = patches.length > 0 || files.some(f => /^systemd\//.test(f.file) || f.file === 'scripts/setup-station.sh');
  const needsConsoleRestart = files.some(f => /^console\/[^/]+\.js$/.test(f.file) || /^company\/tools\/lib\//.test(f.file));
  // framework files this company edited in place (hidden with skip-worktree, or visibly): no longer a blocker; apply saves
  // each one as a framework request and puts it back before it pulls (lib/framework-edits.js)
  const FE = require('./lib/framework-edits');
  const edited = FE.crewEdits(root);
  if (edited.length) notes.push(edited.length + ' framework file(s) were edited in this company (' + edited.map(e => e.file).join(', ') + '): the update saves each as a framework request and puts it back first');
  const owned = [];
  for (const f of OWNED) {
    if (!changed.has(f)) continue;
    const mine = fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null;
    const fw = git(root, ['show', '@{u}:' + f]);
    const row = { file: f, changedUpstream: true };
    if (MERGE_JSON.includes(f) && mine != null && fw.ok) {
      const a = readJ(fw.out), b = readJ(mine);
      if (!a || !b) { blockers.push(f + ' is not valid JSON (' + (a ? 'the company copy' : 'the framework copy') + '), so it cannot be merged'); continue; }
      const m = deepMerge(a, b); row.how = 'deep merge: the framework\'s new keys added, every company value kept'; row.added = m.added; row.kept = m.kept;
    } else row.how = 'the company copy is kept as it is (the framework\'s change to it is in the diff)';
    owned.push(row);
  }
  let stationActive = false;
  if (process.env.FRAMEWORK_UPDATE_STATION_ACTIVE) stationActive = process.env.FRAMEWORK_UPDATE_STATION_ACTIVE === '1';
  else { try { const svc = (readJ(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8')) || {}).station || {}; stationActive = spawnSync('systemctl', ['--user', 'is-active', '--quiet', (svc.serviceName || 'capheos-station') + '.service']).status === 0; } catch (_) {} }
  if (patches.length) notes.push('ships StarNet patch(es) ' + patches.join(', ') + ': setup applies them to the checkout' + (stationActive ? ', and the station restarts when nothing is running' : ''));
  if (needsConsoleRestart) notes.push('changes the console: it restarts itself when no chat reply is streaming');
  return Object.assign(base, { commits, files, patches, owned, blockers, notes, needsSetup, needsStationRestart: patches.length > 0 && stationActive, needsConsoleRestart });
}

function runStep(steps, name, cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', timeout: 900000 }, opts || {}));
  const ok = r.status === 0;
  steps.push({ step: name, ok, out: (String(r.stdout || '') + String(r.stderr || '')).trim().split('\n').slice(-8).join('\n') });
  return ok;
}

function apply(opts) {
  const root = opts.root; const steps = [];
  const refuse = opts.ownerRefusal ? opts.ownerRefusal(opts.by) : 'only the owner applies a framework update (--by owner)';
  if (refuse) return { ok: false, code: 3, error: refuse };
  if (!/^[0-9a-f]{7,40}$/.test(String(opts.expect || ''))) return { ok: false, code: 2, error: '--expect <sha> is required: the commit you reviewed in the dry run' };
  const c = check({ root, noFetch: opts.noFetch });
  if (!c.ok) return Object.assign({ code: 1 }, c);
  if (c.upToDate) return { ok: true, upToDate: true, head: c.head, steps };
  if (!c.target.startsWith(opts.expect)) return { ok: false, code: 1, error: 'the framework moved since you reviewed it (now ' + c.target.slice(0, 10) + ', you reviewed ' + String(opts.expect).slice(0, 10) + '): look at the new dry run first', check: c };
  if (c.blockers.length) return { ok: false, code: 1, error: 'not applied: ' + c.blockers.join('; '), check: c };
  const guard = path.join(root, 'scripts', 'instance-guard.sh');
  if (fs.existsSync(guard) && !runStep(steps, 'instance guard (push disabled)', 'bash', [guard], { cwd: root })) return { ok: false, code: 1, error: 'scripts/instance-guard.sh failed', steps };
  for (const r of git(root, ['remote']).out.split('\n').filter(Boolean)) {
    const pu = git(root, ['remote', 'get-url', '--push', r]).out;
    if (pu !== 'no-push://capheos-instance') return { ok: false, code: 1, error: 'remote ' + r + ' can still push (' + pu + '); not updating an instance that could push', steps };
  }
  const backup = path.join(root, 'scripts', 'backup.sh');
  if (!opts.noBackup && fs.existsSync(backup) && !runStep(steps, 'backup', 'bash', [backup], { cwd: root })) return { ok: false, code: 1, error: 'the backup failed; nothing was changed', steps };
  // 2b. framework files the crew edited in place: each saved as a framework request and put back, so the pull is clean
  { const sw = require('./lib/framework-edits').sweep(root, { via: 'framework-update.js apply', by: 'the crew (found before the update)' });
    steps.push({ step: 'framework files edited in this company', ok: true, out: sw.line || 'none' }); }
  // 3. save and un-hide the owned files
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const keep = path.join(root, 'company', 'state', 'framework-update', stamp);
  const saved = {};
  for (const f of OWNED) { const p = path.join(root, f); if (fs.existsSync(p)) { saved[f] = fs.readFileSync(p); fs.mkdirSync(path.dirname(path.join(keep, f)), { recursive: true }); fs.writeFileSync(path.join(keep, f), saved[f]); } }
  const tracked = OWNED.filter(f => git(root, ['ls-files', '--error-unmatch', '--', f]).ok);
  const putBack = () => { for (const [f, b] of Object.entries(saved)) fs.writeFileSync(path.join(root, f), b); if (fs.existsSync(guard)) runStep(steps, 'instance guard (after putting back)', 'bash', [guard], { cwd: root }); };
  if (tracked.length) { git(root, ['update-index', '--no-skip-worktree', '--'].concat(tracked)); git(root, ['checkout', '--'].concat(tracked)); }
  // 4. fast-forward only
  const mg = git(root, ['merge', '--ff-only', c.target]);
  steps.push({ step: 'git merge --ff-only ' + c.target.slice(0, 10), ok: mg.ok, out: (mg.out + '\n' + mg.err).trim().split('\n').slice(-6).join('\n') });
  if (!mg.ok) { putBack(); return { ok: false, code: 1, error: 'the fast-forward did not apply; the company is as it was', steps }; }
  // 5. the owned files back on top
  const merged = [];
  for (const [f, b] of Object.entries(saved)) {
    const p = path.join(root, f);
    if (MERGE_JSON.includes(f) && fs.existsSync(p)) {
      const fw = readJ(fs.readFileSync(p, 'utf8')), mine = readJ(b.toString('utf8'));
      if (fw && mine) { const m = deepMerge(fw, mine); fs.writeFileSync(p, JSON.stringify(m.value, null, 2) + '\n'); merged.push({ file: f, added: m.added, kept: m.kept.length }); continue; }
    }
    fs.writeFileSync(p, b); merged.push({ file: f, kept: 'company copy' });
  }
  steps.push({ step: 'company-owned files merged', ok: true, out: merged.map(m => m.file + (m.added ? ' (+' + m.added.length + ' new key(s))' : '')).join(', ') });
  if (fs.existsSync(guard)) runStep(steps, 'instance guard (owned files hidden again)', 'bash', [guard], { cwd: root });
  // 7. setup, when the update needs it
  let setupOk = null;
  if (c.needsSetup && !opts.noSetup) {
    const cmd = process.env.FRAMEWORK_UPDATE_SETUP;
    setupOk = cmd ? runStep(steps, 'setup (stand-in)', 'bash', ['-c', cmd], { cwd: root }) : runStep(steps, 'scripts/setup-station.sh', 'bash', [path.join(root, 'scripts', 'setup-station.sh')], { cwd: root });
  }
  // 8. a station restart when idle, detached (it may wait for runs to end)
  let restart = null;
  if (c.needsStationRestart && !opts.noRestart && setupOk !== false) {
    const reason = 'framework update ' + c.target.slice(0, 10) + (c.patches.length ? ' (patch ' + c.patches.join(', ') + ')' : '');
    const cmd = process.env.FRAMEWORK_UPDATE_RESTART;
    const argv = cmd ? ['bash', '-c', cmd] : ['bash', path.join(root, 'scripts', 'restart-station.sh'), '--when-idle', '--max-wait-min', '90', '--reason', reason, '--by', String(opts.by)];
    const ch = spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: 'ignore' }); ch.unref();
    restart = { started: true, pid: ch.pid, reason };
    steps.push({ step: 'station restart when idle (started)', ok: true, out: reason });
  }
  const row = { at: new Date().toISOString(), by: String(opts.by), from: c.head, to: c.target, commits: c.commits.length, patches: c.patches, merged, setup: setupOk, restart: !!restart, needsConsoleRestart: c.needsConsoleRestart, saved: path.relative(root, keep) };
  try { fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true }); fs.appendFileSync(path.join(root, 'company', 'state', 'framework-updates.jsonl'), JSON.stringify(row) + '\n'); } catch (_) {}
  try {
    const f = path.join(root, 'company', 'work', 'decisions.md'); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, '- ' + row.at.slice(0, 16).replace('T', ' ') + ' ' + row.by + ' (owner) took the framework update ' + c.head.slice(0, 10) + '..' + c.target.slice(0, 10) + ' (' + c.commits.length + ' commit(s)' + (c.patches.length ? ', patch ' + c.patches.join(', ') : '') + ')\n');
  } catch (_) {}
  return { ok: setupOk !== false, updated: true, from: c.head, to: c.target, steps, merged, setup: setupOk, restart, needsConsoleRestart: c.needsConsoleRestart, error: setupOk === false ? 'the update is in, but setup failed: see its output' : undefined };
}

/* ---------------- selftest: a temp framework repo, a founded clone, an update with a patch, a console change and a
 * new company.json key ---------------- */
function selftest() {
  const os = require('os'); const assert = require('assert');
  const T = require('./lib/temp-life').tmpDir('framework-update-selftest-');
  const G = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', '-C', cwd, ...a], { encoding: 'utf8', env: Object.assign({}, process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }) }); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok   ' + m); };
  const saveEnv = Object.assign({}, process.env);
  try {
    const U = path.join(T, 'upstream'), I = path.join(T, 'company');
    const W = (root, f, t) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), t); };
    W(U, 'company/company.json', JSON.stringify({ name: 'TEMPLATE', owner: { name: '' }, console: { port: 0 } }, null, 2) + '\n');
    W(U, 'company/model-policy.json', JSON.stringify({ candidateDefault: { provider: null } }, null, 2) + '\n');
    W(U, 'company/CHARTER.md', '# {{COMPANY}}\n');
    W(U, 'console/server.js', '// v1\n');
    W(U, 'scripts/instance-guard.sh', fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'instance-guard.sh')));
    W(U, '.gitignore', 'company/work/\ncompany/state/\n');
    G(U, 'init', '-q'); G(U, 'add', '-A'); G(U, 'commit', '-qm', 'framework');
    spawnSync('git', ['clone', '-q', U, I]);
    W(I, 'company/work/.founded', 'x\n');
    W(I, 'company/company.json', JSON.stringify({ name: 'Acme Law', owner: { name: 'Alex' }, console: { port: 9101 } }, null, 2) + '\n');
    W(I, 'company/CHARTER.md', '# Acme Law\nOur mandate.\n');
    spawnSync('bash', [path.join(I, 'scripts', 'instance-guard.sh')], { cwd: I, encoding: 'utf8' });
    const pushUrl = () => G(I, 'remote', 'get-url', '--push', 'origin');
    ok(pushUrl() === 'no-push://capheos-instance', 'the founded clone cannot push (instance guard)');
    let c = check({ root: I });
    ok(c.ok && c.upToDate && !c.blockers.length, 'check: up to date, nothing to do');
    // the framework moves: a new company.json key, a console change and a StarNet patch
    W(U, 'company/company.json', JSON.stringify({ name: 'TEMPLATE', owner: { name: '' }, console: { port: 0, sessionHours: 168 }, runtime: { scheduler: 'dispatcher' } }, null, 2) + '\n');
    W(U, 'console/server.js', '// v2\n');
    W(U, 'company/patches/0099-test.diff', '# test patch\n');
    G(U, 'add', '-A'); G(U, 'commit', '-qm', 'update with a patch');
    const upHead = G(U, 'rev-parse', 'HEAD');
    const before = fs.readFileSync(path.join(I, 'company', 'company.json'), 'utf8');
    process.env.FRAMEWORK_UPDATE_STATION_ACTIVE = '1';
    c = check({ root: I });
    ok(c.ok && c.behind === 1 && c.target === upHead && c.commits[0].subject === 'update with a patch', 'check (dry run): one commit behind, named');
    ok(c.patches.join() === '0099-test' && c.needsSetup && c.needsStationRestart && c.needsConsoleRestart, 'check: a new patch means setup + a station restart; a console change means a console restart');
    const cj = c.owned.find(o => o.file === 'company/company.json');
    ok(cj && cj.added.includes('console.sessionHours') && cj.added.includes('runtime') && cj.kept.includes('name'), 'check: company.json would be deep-merged (new keys added, the company\'s name kept)');
    ok(fs.readFileSync(path.join(I, 'company', 'company.json'), 'utf8') === before && G(I, 'rev-parse', 'HEAD') !== upHead && !fs.existsSync(path.join(I, 'company', 'patches')), 'check changed nothing in the company');
    let r = apply({ root: I, by: 'owner', expect: upHead, ownerRefusal: () => 'not the owner', noBackup: true });
    ok(!r.ok && r.code === 3, 'apply: refused for anyone but the owner');
    r = apply({ root: I, by: 'owner', expect: 'deadbeef', ownerRefusal: () => null, noBackup: true });
    ok(!r.ok && /moved since you reviewed/.test(r.error) && G(I, 'rev-parse', 'HEAD') !== upHead, 'apply: refused when upstream is not the commit the owner reviewed');
    const marker = path.join(T, 'setup-ran'), rmark = path.join(T, 'restart-ran');
    process.env.FRAMEWORK_UPDATE_SETUP = 'touch ' + JSON.stringify(marker);
    process.env.FRAMEWORK_UPDATE_RESTART = 'touch ' + JSON.stringify(rmark);
    r = apply({ root: I, by: 'owner', expect: upHead.slice(0, 12), ownerRefusal: () => null, noBackup: true });
    ok(r.ok && r.updated && G(I, 'rev-parse', 'HEAD') === upHead, 'apply: fast-forwarded to the reviewed commit');
    const merged = JSON.parse(fs.readFileSync(path.join(I, 'company', 'company.json'), 'utf8'));
    ok(merged.name === 'Acme Law' && merged.owner.name === 'Alex' && merged.console.port === 9101 && merged.console.sessionHours === 168 && merged.runtime.scheduler === 'dispatcher', 'apply: company.json deep-merged (company values kept, framework keys added)');
    ok(fs.readFileSync(path.join(I, 'company', 'CHARTER.md'), 'utf8') === '# Acme Law\nOur mandate.\n', 'apply: the charter is the company\'s, untouched');
    ok(fs.existsSync(marker), 'apply: setup ran (the update ships a patch)');
    const t0 = Date.now(); while (!fs.existsSync(rmark) && Date.now() - t0 < 5000) spawnSync('sleep', ['0.1']);
    ok(fs.existsSync(rmark) && r.restart && r.restart.started, 'apply: the station restart (when idle) was started');
    ok(spawnSync('git', ['-C', I, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() === '', 'apply: git status clean again (owned files hidden)');
    ok(pushUrl() === 'no-push://capheos-instance' && G(U, 'rev-parse', 'HEAD') === upHead && G(U, 'log', '--format=%s', '-1') === 'update with a patch', 'never pushed: the instance still cannot push and upstream is unchanged');
    const rows = fs.readFileSync(path.join(I, 'company', 'state', 'framework-updates.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    ok(rows.length === 1 && rows[0].by === 'owner' && rows[0].to === upHead && /owner\) took the framework update/.test(fs.readFileSync(path.join(I, 'company', 'work', 'decisions.md'), 'utf8')), 'apply: recorded as the owner\'s (framework-updates.jsonl and decisions.md)');
    ok(fs.existsSync(path.join(I, rows[0].saved, 'company', 'company.json')), 'apply: the owned files as they were are kept');
    // a crew edit of a framework file, hidden with skip-worktree, no longer blocks an update: it is filed and put back
    W(I, 'console/server.js', '// v2\n// a rule the crew wrote in place\n'); G(I, 'update-index', '--skip-worktree', 'console/server.js');
    G(I, 'update-index', '--skip-worktree', '.gitignore');   // hidden but unchanged: nothing to file
    W(U, 'console/server.js', '// v2.5\n'); G(U, 'commit', '-qam', 'v2.5'); const up25 = G(U, 'rev-parse', 'HEAD');
    let c2 = check({ root: I });
    ok(c2.ok && !c2.blockers.length && c2.notes.some(x => /console\/server\.js/.test(x) && /framework request/.test(x)), 'check: a hidden crew edit of a framework file is a note, not a blocker: ' + JSON.stringify(c2.blockers));
    const charterBefore = fs.readFileSync(path.join(I, 'company', 'CHARTER.md'), 'utf8');
    r = apply({ root: I, by: 'owner', expect: up25.slice(0, 12), ownerRefusal: () => null, noBackup: true, noSetup: true, noRestart: true });
    ok(r.ok && r.updated && fs.readFileSync(path.join(I, 'console', 'server.js'), 'utf8') === '// v2.5\n', 'apply: the hidden crew edit did not block the pull: ' + (r.error || ''));
    const reqs = fs.readdirSync(path.join(I, 'company', 'work', 'framework-requests')).filter(f => /^fr-\d+/.test(f));
    const req = reqs.map(f => fs.readFileSync(path.join(I, 'company', 'work', 'framework-requests', f), 'utf8')).find(t => t.includes('`console/server.js`'));
    ok(req && /\+\/\/ a rule the crew wrote in place/.test(req) && /^--- a\/console\/server\.js$/m.test(req), 'apply: the edit is filed as a framework request with its diff');
    ok(!reqs.some(f => /gitignore/.test(fs.readFileSync(path.join(I, 'company', 'work', 'framework-requests', f), 'utf8'))), 'apply: no request for a hidden file that matches HEAD');
    ok(fs.readFileSync(path.join(I, 'company', 'CHARTER.md'), 'utf8') === charterBefore, 'apply: company-owned files are untouched');
    ok(r.steps.some(x => /framework files edited/.test(x.step) && /fr-\d{4}/.test(x.out)), 'apply: one plain line says what was filed');
    // a company commit of its own blocks
    W(I, 'x.txt', 'x'); spawnSync('git', ['-C', I, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'x.txt']); spawnSync('git', ['-C', I, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'local']);
    W(U, 'console/server.js', '// v3\n'); G(U, 'commit', '-qam', 'v3');
    c = check({ root: I });
    ok(c.blockers.some(b => /commit\(s\) of its own/.test(b)), 'check: a company commit of its own blocks the update');
    ok(deepMerge({ a: 1, b: { c: 2, d: [1] } }, { b: { d: [9], e: 3 }, z: 1 }).value.b.d[0] === 9, 'deepMerge: arrays are the company\'s');
    console.log('all ' + n + ' checks passed'); return 0;
  } catch (e) { console.log('FAIL ' + e.message); return 1; }
  finally { for (const k of Object.keys(process.env)) if (!(k in saveEnv)) delete process.env[k]; fs.rmSync(T, { recursive: true, force: true }); }
}

module.exports = { check, apply, deepMerge, OWNED, MERGE_JSON };

if (require.main === module) {
  const a = process.argv.slice(2); const cmd = a[0];
  const opt = k => { const i = a.indexOf('--' + k); return i >= 0 ? (a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true) : null; };
  if (cmd === 'selftest' || a.includes('--selftest')) process.exit(selftest());
  const co = require('./lib/company');
  const out = (r, text) => { console.log(opt('json') ? JSON.stringify(r, null, 1) : text(r)); process.exit(r.ok ? 0 : (r.code || 1)); };
  if (cmd === 'check') {
    const r = check({ root: co.ROOT, noFetch: !!opt('no-fetch') });
    out(r, x => !x.ok ? 'cannot check: ' + x.error : x.upToDate ? 'up to date (' + x.head.slice(0, 10) + ')' + (x.blockers.length ? '\nblocked: ' + x.blockers.join('\n  ') : '')
      : 'DRY RUN: ' + x.behind + ' commit(s) to take, ' + x.head.slice(0, 10) + ' -> ' + x.target.slice(0, 10) + '\n' + x.commits.map(k => '  ' + k.sha + ' ' + k.subject).join('\n') +
        '\nfiles: ' + x.files.length + (x.notes.length ? '\n' + x.notes.map(s => '- ' + s).join('\n') : '') + x.owned.map(o => '\n' + o.file + ': ' + o.how + (o.added && o.added.length ? ' (+' + o.added.join(', ') + ')' : '')).join('') +
        (x.blockers.length ? '\nBLOCKED: ' + x.blockers.join('\n  ') : '\napply: node company/tools/framework-update.js apply --by owner --expect ' + x.target.slice(0, 12)));
  } else if (cmd === 'apply' && opt('by') && opt('by') !== true && !require('./lib/owner').isOwnerName(opt('by'))) {
    // the crew's way in (self-improvement): CI green, merge-tool merges only, sandbox first, a watchdog that rolls back
    const r = require('./staged-update').crewApply({ by: opt('by'), expect: opt('expect') === true ? null : opt('expect') });
    out(r, x => x.ok ? (x.upToDate ? 'already up to date' : 'updated ' + x.from.slice(0, 10) + ' -> ' + x.to.slice(0, 10) + ' (staged: ' + x.watch + ')') : 'not updated: ' + x.error);
  } else if (cmd === 'apply') {
    const own = require('./lib/owner');
    const r = apply({ root: co.ROOT, by: opt('by'), expect: opt('expect'), noBackup: !!opt('no-backup'), noSetup: !!opt('no-setup'), noRestart: !!opt('no-restart'),
      ownerRefusal: by => !own.isOwnerName(by) ? 'only the owner applies a framework update (--by owner)' : own.refusal(by, 'a framework update') });
    out(r, x => x.ok ? (x.upToDate ? 'already up to date' : 'updated ' + x.from.slice(0, 10) + ' -> ' + x.to.slice(0, 10) + '\n' + x.steps.map(s => (s.ok ? 'ok   ' : 'FAIL ') + s.step).join('\n')) : 'not updated: ' + x.error + (x.steps ? '\n' + x.steps.map(s => (s.ok ? 'ok   ' : 'FAIL ') + s.step + (s.ok ? '' : '\n' + s.out)).join('\n') : ''));
  } else { console.error('usage: framework-update.js check [--no-fetch] [--json] | apply --by owner --expect <sha> [--no-backup] [--no-setup] [--no-restart] [--json] | selftest'); process.exit(2); }
}
