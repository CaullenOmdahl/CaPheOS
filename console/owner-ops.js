'use strict';
/* console/owner-ops.js — the owner's server chores from the browser (Settings › System), so the owner never needs a
 * terminal on the box (docs/DEPLOY-SERVER.md "What the owner does from the console"). Mounted by console/server.js:
 *
 *   require('./owner-ops.js').mount(route, { co, run, runApi, bad, owner, tool, busy, emit })
 *
 * Every route sits behind the console's owner sign-in and CSRF check like every /api route. Every write runs the same
 * company tool the owner would run in a shell, with --by <owner>: the tools accept the console as the owner
 * (company/tools/lib/owner.js), so the tool's own owner check and its own record (decisions.md, the tool's log) apply.
 * On top, each write is one row in company/state/owner-ops.jsonl {id, at, by, action, target, why, ok, error} — never a
 * secret. Long jobs (restarts, a framework update, a clean-up) run detached with their output in
 * company/state/owner-ops/<id>.log, shown in the console as they go.
 * OUTSIDE THE CONSOLE'S LIMITS. Under systemd each job is its own transient unit, <svc>-owner-job-<id>.service
 * (systemd-run --user --collect, in the company's own slice), never a child in the console's cgroup: the console's MemoryMax (300 / 512 MB),
 * OOMPolicy=stop and KillMode=control-group would end a framework update (npm install, setup-station.sh) halfway when the
 * console reaches its limit or restarts. The unit gets ManagedOOMPreference=omit (systemd-oomd never picks it),
 * OOMPolicy=continue, the console's working folder and a short list of its environment (never the session secret).
 * Without systemd (a container, scripts/supervise.js) or when systemd-run fails, the job is a detached child as before.
 * lib/owned.js counts the unit as the company's; service.js's unregistered-services duty does not flag it.
 * Env: CONSOLE_SYSTEMD_RUN (the systemd-run binary; tests). In a test run (CAPHEOS_TEST_RUN) without it, no transient
 * unit is ever made on the machine's user manager.
 *
 *   GET  /api/ops/flags                           change-watcher flags (locked-watch.js status --json)
 *   POST /api/ops/flags/accept   {key, why}       take a flagged change as the new last-known-good
 *   POST /api/ops/flags/revert   {key, why}       put the last-known-good back
 *   GET  /api/ops/scheduler                       who starts the crew's loops, and both migrations as dry runs
 *   POST /api/ops/scheduler      {to, confirm}    budget-migrate.js --to dispatcher|station (migrate / roll back)
 *   POST /api/ops/scheduler/seat {seat, on}       one seat's loop on or off under the dispatcher
 *   GET  /api/ops/services/unregistered           units running from the company folder that nobody registered
 *   POST /api/ops/services/adopt {unit, as?, seat?, why?}
 *   GET  /api/ops/modules                         core modules; POST /api/ops/modules/<id>/enable|disable
 *   POST /api/ops/guardrails/apply                guardrails.js apply
 *   GET  /api/ops/restart                         what is in flight (station and chats)
 *   POST /api/ops/restart/station {reason}        scripts/restart-station.sh --when-idle (detached)
 *   POST /api/ops/restart/console                 restart the console when no chat is streaming (detached)
 *   GET  /api/ops/update                          framework-update.js check (the dry run)
 *   POST /api/ops/update/apply   {expect}         framework-update.js apply --expect <sha> (detached)
 *   GET  /api/ops/access                          bind address, proxy, cookies, this machine's addresses
 *   POST /api/ops/access {host, trustProxy, publicUrl, sessionHours, confirm}   company.json console.* (restart needed)
 *   GET  /api/ops/memory                          memory.js status --json: what the company uses of this computer's memory,
 *                                                 its profile and limits, what the reaper freed (the Health row's Memory line)
 *   GET  /api/ops/memory/shared                   reaper.js host-sweep --json: leftovers in the shared temp folder no company
 *                                                 can vouch for (listed, nothing removed)
 *   POST /api/ops/memory {profile, keepFreeMB, visibleBrowser}   memory.js set --by owner: {changed, restartNeeded, line}
 *   POST /api/ops/memory/clean {what: 'now'|'shared-temp'}       reaper.js run / host-sweep --apply --by owner, as a job
 *   GET  /api/ops/jobs[/<id>]                     the detached jobs and their output
 *   GET  /api/ops/log                             the owner-ops rows, newest first
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

function mount(route, deps) {
  const { co, run, runApi, bad, owner, tool } = deps;
  const LOG = co.p('company', 'state', 'owner-ops.jsonl');
  const JOBS = co.p('company', 'state', 'owner-ops');
  const AUTHMOD = require(path.join(__dirname, 'auth.js'));
  const host = () => require(co.p('company', 'tools', 'lib', 'host.js'));
  const str = (v, name, max) => { if (v === undefined || v === null || v === '') return null; const s = String(v).trim(); if (s.startsWith('--')) bad(name + ' may not start with --'); if (s.length > (max || 500)) bad(name + ' is too long'); return s; };
  const need = (v, name, max) => str(v, name, max) || bad(name + ' is required');

  function record(action, target, why, result) {
    const row = { id: 'op-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), by: owner(), via: 'console', action, target: target || null, why: why || null,
      ok: !!(result && result.ok !== false), error: result && result.ok === false ? String(result.error || '').slice(0, 300) : undefined };
    try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch (_) {}
    try { deps.emit && deps.emit('ops'); } catch (_) {}
    return row;
  }
  function decision(text) {
    try {
      const f = co.p('company', 'work', 'decisions.md'); fs.mkdirSync(path.dirname(f), { recursive: true });
      if (!fs.existsSync(f)) fs.appendFileSync(f, '# Decisions\n\n');
      const lp = co.localParts(new Date()); const line = '- ' + lp.date + ' ' + lp.time + ' ' + owner() + ' (owner) ' + text + ' (console)\n';
      fs.appendFileSync(f, line);
      try { require(co.p('company', 'tools', 'provenance.js')).appended(f, line, 'console (owner)'); } catch (_) {}
    } catch (_) {}
  }
  // a write as the owner: run it, record it whatever happened, answer with the tool's own answer (or its error)
  async function act(action, target, why, fn) {
    try { const r = await fn(); record(action, target, why, r); return Object.assign({ ok: true }, r, { recorded: true }); }
    catch (e) { record(action, target, why, { ok: false, error: e.message }); throw e; }
  }

  /* ---------- detached jobs ---------- */
  // the job's own shell writes its pid (the unit's main process, or the detached child) and, at the end, its exit code
  const WRAP = 'echo $$ > "$0"; "$@"; echo "[exit $?]"';
  const ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|XDG_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|NODE_EXTRA_CA_CERTS|CAPHEOS_[A-Z0-9_]+|STARNET_[A-Z0-9_]+|CONSOLE_(HOST|PORT|TRUST_PROXY))$/;
  function jobUnitArgs(unit, log, env) {
    const a = ['--user', '--collect', '--quiet', '--unit=' + unit, '--description=' + 'Owner job ' + unit,
      '-p', 'WorkingDirectory=' + co.ROOT, '-p', 'StandardOutput=append:' + log, '-p', 'StandardError=append:' + log,
      '-p', 'ManagedOOMPreference=omit', '-p', 'OOMPolicy=continue',
      // the company's own slice, outside app.slice, where systemd-oomd's pressure kill is off (lib/memory.js sliceOf)
      '--slice=' + sliceName(), '-p', 'KillMode=mixed', '-p', 'TimeoutStopSec=60'];
    for (const [k, v] of Object.entries(env)) if (ENV_KEEP.test(k) && v != null && !/[\n\r\0]/.test(String(v))) a.push('-E', k + '=' + v);
    return a;
  }
  function systemdRun() {
    if (process.env.CONSOLE_SYSTEMD_RUN) return process.env.CONSOLE_SYSTEMD_RUN;
    if (process.env.CAPHEOS_TEST_RUN) return null;   // a test never makes units on the machine's user manager
    let sup = 'none'; try { sup = host().supervisor(); } catch (_) {}
    if (sup !== 'systemd') return null;
    for (const b of ['/usr/bin/systemd-run', '/bin/systemd-run']) if (fs.existsSync(b)) return b;
    return null;
  }
  const sliceName = () => { let c = {}; try { c = JSON.parse(fs.readFileSync(co.p('company', 'company.json'), 'utf8')); } catch (_) {} return require(path.join(__dirname, '..', 'company', 'tools', 'lib', 'memory.js')).sliceOf(c); };
  const svcName = () => { let c = {}; try { c = JSON.parse(fs.readFileSync(co.p('company', 'company.json'), 'utf8')); } catch (_) {} return String((c.station && c.station.serviceName) || 'capheos-station').replace(/\.service$/, ''); };
  function startJob(kind, argv, opts) {
    opts = opts || {};
    fs.mkdirSync(JOBS, { recursive: true });
    const running = listJobs().find(j => j.kind === kind && j.status === 'running');
    if (running) bad('a ' + kind + ' job is already running (' + running.id + ')', 409);
    const id = kind + '-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
    const log = path.join(JOBS, id + '.log'), pidf = path.join(JOBS, id + '.pid');
    const env = Object.assign({}, process.env, opts.env || {});
    const meta = { id, kind, argv: argv.map(a => String(a).slice(0, 200)), pid: null, unit: null, startedAt: new Date().toISOString(), by: owner(), label: opts.label || kind };
    fs.closeSync(fs.openSync(log, 'a', 0o600));
    const sr = systemdRun();
    if (sr) {
      // its own transient unit: outside the console's memory limits and its cgroup, so neither a console restart nor the
      // console's MemoryMax can end it halfway
      const unit = svcName() + '-owner-job-' + id + '.service';
      const r = require('child_process').spawnSync(sr, jobUnitArgs(unit, log, env).concat(['--', 'bash', '-c', WRAP, pidf].concat(argv)), { cwd: co.ROOT, encoding: 'utf8', timeout: 20000, env });
      if (!r.error && r.status === 0) meta.unit = unit;
      else try { fs.appendFileSync(log, '(could not start it as its own unit: ' + String(r.error ? r.error.message : r.stderr || 'exit ' + r.status).trim().slice(0, 200) + '; started as a child of the console)\n'); } catch (_) {}
    }
    if (!meta.unit) {
      const fd = fs.openSync(log, 'a', 0o600);
      const ch = spawn('bash', ['-c', WRAP, pidf].concat(argv), { cwd: co.ROOT, detached: true, stdio: ['ignore', fd, fd], env });
      fs.closeSync(fd); meta.pid = ch.pid; ch.unref();
    }
    fs.writeFileSync(path.join(JOBS, id + '.json'), JSON.stringify(meta, null, 1) + '\n');
    // the end: the log's [exit N] line (the unit's process is no child of this console), checked every 2 s
    const t0 = Date.now();
    const watch = setInterval(() => {
      const j = jobOf(id); if (!j) { clearInterval(watch); return; }
      if (j.status === 'running' && Date.now() - t0 < 6 * 3600e3) return;
      clearInterval(watch);
      if (opts.onExit) try { opts.onExit(j.exit == null ? null : j.exit, meta); } catch (_) {}
      try { deps.emit && deps.emit('ops'); } catch (_) {}
    }, 2000);
    if (watch.unref) watch.unref();
    return meta;
  }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  function jobOf(id) {
    let meta; try { meta = JSON.parse(fs.readFileSync(path.join(JOBS, id + '.json'), 'utf8')); } catch (_) { return null; }
    let text = ''; try { const b = fs.readFileSync(path.join(JOBS, id + '.log')); text = b.slice(Math.max(0, b.length - 16384)).toString('utf8'); } catch (_) {}
    const m = text.match(/\[exit (\d+)\]\s*$/);
    if (!m) { const p = Number(String((() => { try { return fs.readFileSync(path.join(JOBS, id + '.pid'), 'utf8'); } catch (_) { return ''; } })()).trim()); if (p > 1) meta.pid = p; }
    // a unit job whose shell has not written its pid yet (it is just starting) is running, for up to a minute
    const starting = !meta.pid && meta.unit && Date.now() - Date.parse(meta.startedAt) < 60000;
    const status = m ? (m[1] === '0' ? 'done' : 'failed') : (meta.pid && alive(meta.pid)) || starting ? 'running' : 'ended';
    return Object.assign(meta, { status, exit: m ? Number(m[1]) : null, output: text.replace(/\[exit \d+\]\s*$/, '').trimEnd() });
  }
  function listJobs() {
    let ids = []; try { ids = fs.readdirSync(JOBS).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)); } catch (_) {}
    return ids.map(jobOf).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 30);
  }

  /* ---------- change-watcher flags ---------- */
  route('GET', /^\/api\/ops\/flags$/, () => runApi('locked-watch.js', ['status', '--json']));
  const flagKey = k => { const s = need(k, 'key', 300); if (!/^[A-Za-z0-9_.~\/:@+-]+$/.test(s) || s.split('/').includes('..')) bad('key is a locked path or a flag key from the list'); return s; };
  route('POST', /^\/api\/ops\/flags\/accept$/, (m, q, b) => {
    const key = flagKey(b.key); const why = need(b.why, 'why', 500); if (why.length < 10) bad('say in a few words why this change is meant (at least 10 characters)');
    return act('flags.accept', key, why, () => runApi('locked-watch.js', ['accept', key, '--by', owner(), '--why', why + ' (owner, in the console)']));
  });
  route('POST', /^\/api\/ops\/flags\/revert$/, (m, q, b) => {
    const key = flagKey(b.key); const why = str(b.why, 'why', 500) || 'put back by the owner';
    return act('flags.revert', key, why, async () => { const r = await runApi('locked-watch.js', ['revert', key, '--by', owner()]); decision('put back ' + key + ' to its last-known-good copy: ' + why); return r; });
  });

  /* ---------- the scheduler: migrate and roll back ---------- */
  route('GET', /^\/api\/ops\/scheduler$/, async () => {
    const cur = (co.config.runtime && co.config.runtime.scheduler) || 'station';
    const [toD, toS] = await Promise.all([run('budget-migrate.js', ['--to', 'dispatcher', '--dry-run', '--json'], { timeout: 30000 }), run('budget-migrate.js', ['--to', 'station', '--dry-run', '--json'], { timeout: 30000 })]);
    let now = cur; try { now = (JSON.parse(fs.readFileSync(co.p('company', 'company.json'), 'utf8')).runtime || {}).scheduler || 'station'; } catch (_) {}
    return { ok: true, scheduler: now, toDispatcher: toD.data, toStation: toS.data };
  });
  route('POST', /^\/api\/ops\/scheduler$/, (m, q, b) => {
    const to = String(b.to || ''); if (!['dispatcher', 'station'].includes(to)) bad('to is dispatcher or station');
    if (b.confirm !== true) bad('confirm: true is required (look at the dry run first)');
    return act('scheduler.' + (to === 'station' ? 'rollback' : 'migrate'), to, str(b.why, 'why'), () => runApi('budget-migrate.js', ['--to', to, '--by', owner()], { timeout: 180000 }));
  });
  route('POST', /^\/api\/ops\/scheduler\/seat$/, (m, q, b) => {
    const seat = need(b.seat, 'seat', 64); if (!/^[A-Za-z0-9_-]+$/.test(seat)) bad('seat is a seat id');
    const on = b.on === true || b.on === 'on';
    return act('scheduler.seat', seat + (on ? ' on' : ' off'), null, () => runApi('budget-migrate.js', ['--seat', seat, on ? '--on' : '--off', '--by', owner()], { timeout: 60000 }));
  });

  /* ---------- services: adopt what was made outside service.js ---------- */
  route('GET', /^\/api\/ops\/services\/unregistered$/, () => {
    let f = { unregistered: [], unscoped: [], edited: [] };
    try { const S = tool('service.js'); f = S.findings(S.context()); } catch (e) { return { ok: true, unregistered: [], error: 'could not read the units: ' + e.message }; }
    return { ok: true, unregistered: f.unregistered || [], unscoped: f.unscoped || [], edited: f.edited || [], transient: f.transient || [] };
  });
  route('POST', /^\/api\/ops\/services\/adopt$/, (m, q, b) => {
    const unit = need(b.unit, 'unit', 90); if (!/^[A-Za-z0-9@_.:-]{2,90}$/.test(unit)) bad('unit is a unit name');
    const args = ['adopt', unit, '--by', owner()];
    const as = str(b.as, 'as', 60); if (as) { if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(as)) bad('as is a short name (letters, digits, dashes)'); args.push('--as', as); }
    const seat = str(b.seat, 'seat', 64); if (seat) args.push('--seat', seat);
    const why = str(b.why, 'why'); if (why) args.push('--why', why);
    return act('services.adopt', unit + (as ? ' as ' + as : ''), why, () => runApi('service.js', args, { timeout: 60000 }));
  });

  /* ---------- core modules ---------- */
  route('GET', /^\/api\/ops\/modules$/, () => runApi('module.js', ['list', '--json']));
  route('POST', /^\/api\/ops\/modules\/([a-z][a-z0-9-]{1,39})\/(enable|disable)$/, (m, q, b) =>
    act('modules.' + m[2], m[1], str(b.why, 'why'), () => runApi('module.js', [m[2], m[1], '--by', owner(), '--json'], { timeout: 180000 })));

  /* ---------- guardrails: apply to the station ---------- */
  route('POST', /^\/api\/ops\/guardrails\/apply$/, () => act('guardrails.apply', null, null, () => runApi('guardrails.js', ['apply', '--by', owner()], { timeout: 60000 })));

  /* ---------- safe restarts ---------- */
  route('GET', /^\/api\/ops\/restart$/, async () => {
    const st = await run('restart-station.js', ['--status'], { timeout: 30000 });
    return { ok: true, station: { idle: st.code === 0, text: (st.data && (st.data.text || st.data.error)) || null }, chats: deps.busy ? deps.busy() : [], supervisor: host().supervisor(),
      jobs: listJobs().filter(j => /^restart-/.test(j.kind)).slice(0, 5) };
  });
  route('POST', /^\/api\/ops\/restart\/station$/, (m, q, b) => {
    const reason = str(b.reason, 'reason', 200) || 'restart asked by the owner in the console';
    return act('restart.station', null, reason, () => ({ job: startJob('restart-station', ['bash', co.p('scripts', 'restart-station.sh'), '--when-idle', '--max-wait-min', '90', '--reason', reason, '--by', owner()], { label: 'Station restart when idle' }),
      note: 'The station restarts as soon as nothing is running (new starts are held meanwhile; nothing is cut off). It gives up after 90 minutes.' }));
  });
  function restartConsole(why) {
    // under systemd: restart-console.sh waits until no chat streams, then systemctl --user restart (the restart job is
    // queued in the user manager, so it completes even though this console stops). Under any other supervisor (a
    // container, scripts/supervise.js): the console exits by itself once idle and the supervisor starts it again.
    if (host().supervisor() === 'systemd' && !process.env.CONSOLE_RESTART_SELF) return startJob('restart-console', ['bash', co.p('scripts', 'restart-console.sh'), '--when-idle', '--timeout', '600', '--force'], { label: 'Console restart when idle' });
    const meta = { id: 'restart-console-self', kind: 'restart-console', status: 'waiting', why };
    const t0 = Date.now();
    const tick = () => { const b = deps.busy ? deps.busy() : []; if (!b.length || Date.now() - t0 > 600e3) { setTimeout(() => process.exit(0), 500); } else setTimeout(tick, 2000); };
    setTimeout(tick, 1000);
    return meta;
  }
  route('POST', /^\/api\/ops\/restart\/console$/, (m, q, b) =>
    act('restart.console', null, str(b.why, 'why'), () => ({ job: restartConsole(str(b.why, 'why')), note: 'The console restarts as soon as no chat reply is streaming; this page reconnects by itself.' })));

  /* ---------- framework update: dry run, then apply ---------- */
  route('GET', /^\/api\/ops\/update$/, async (m, q) => {
    const r = await run('framework-update.js', ['check', '--json'].concat(q.get('fetch') === '0' ? ['--no-fetch'] : []), { timeout: 180000 });
    return Object.assign({ ok: true }, r.data, { jobs: listJobs().filter(j => j.kind === 'update').slice(0, 5) });
  });
  route('POST', /^\/api\/ops\/update\/apply$/, (m, q, b) => {
    const expect = need(b.expect, 'expect', 40); if (!/^[0-9a-f]{7,40}$/.test(expect)) bad('expect is the commit from the dry run');
    return act('update.apply', expect, null, () => ({ job: startJob('update', [process.execPath, co.p('company', 'tools', 'framework-update.js'), 'apply', '--by', owner(), '--expect', expect, '--json'], {
      label: 'Framework update',
      onExit: code => {   // a console change: restart this console once the update is in and no chat streams
        if (code !== 0) return;
        try { const rows = fs.readFileSync(co.p('company', 'state', 'framework-updates.jsonl'), 'utf8').trim().split('\n'); const last = JSON.parse(rows[rows.length - 1]); if (last.to && last.to.startsWith(expect) && last.needsConsoleRestart) restartConsole('framework update'); } catch (_) {}
      } }), note: 'Updating. Each step shows below as it happens; the station and the console restart only when nothing is running.' }));
  });

  /* ---------- access: bind address, proxy, cookies ---------- */
  route('GET', /^\/api\/ops\/access$/, () => {
    const s = AUTHMOD.settings(co); const hostNow = process.env.CONSOLE_HOST || s.host || '127.0.0.1';
    const addrs = []; for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) if (!a.internal && a.family === 'IPv4') addrs.push({ name, address: a.address });
    let saved = {}; try { saved = JSON.parse(fs.readFileSync(co.p('company', 'company.json'), 'utf8')).console || {}; } catch (_) {}
    let lg = null; try { lg = host().linger(); } catch (_) {}
    return { ok: true, host: hostNow, saved: { host: saved.host || null, trustProxy: saved.trustProxy == null ? false : saved.trustProxy, publicUrl: saved.publicUrl || null, sessionHours: saved.sessionHours || null },
      env: { CONSOLE_HOST: process.env.CONSOLE_HOST || null, CONSOLE_TRUST_PROXY: process.env.CONSOLE_TRUST_PROXY || null }, loopback: AUTHMOD.isLoopbackHost(hostNow), warning: AUTHMOD.bindWarning(hostNow),
      addresses: addrs, supervisor: host().supervisor(), linger: lg };
  });
  route('POST', /^\/api\/ops\/access$/, (m, q, b) => {
    const f = co.p('company', 'company.json');
    let cfg; try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { bad('company/company.json is missing or not JSON', 500); }
    const c = Object.assign({}, cfg.console || {}); const changed = [];
    if (b.host !== undefined) {
      const h = String(b.host || '').trim();
      if (!/^(127\.0\.0\.1|::1|0\.0\.0\.0|::|\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/.test(h)) bad('host is 127.0.0.1, 0.0.0.0 or one of this machine\'s addresses');
      if (!AUTHMOD.isLoopbackHost(h) && b.confirm !== true) bad('listening beyond this machine needs confirm: true (read the warning first)');
      c.host = h; changed.push('host ' + h);
    }
    if (b.trustProxy !== undefined) {
      const t = b.trustProxy;
      if (!(t === false || t === true || (Array.isArray(t) && t.length <= 8 && t.every(x => /^[0-9a-fA-F.:]{2,45}$/.test(String(x)))))) bad('trustProxy is false, true (a proxy on this machine) or a list of proxy addresses');
      c.trustProxy = t; changed.push('trustProxy ' + JSON.stringify(t));
    }
    if (b.publicUrl !== undefined) { const u = String(b.publicUrl || ''); if (u && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/?$/.test(u)) bad('publicUrl is like https://console.example.com'); if (u) c.publicUrl = u; else delete c.publicUrl; changed.push('publicUrl ' + (u || 'none')); }
    if (b.sessionHours !== undefined) { const n = Number(b.sessionHours); if (!(n >= 1 && n <= 720)) bad('sessionHours is from 1 to 720'); c.sessionHours = n; changed.push('sessionHours ' + n); }
    if (!changed.length) bad('nothing to set');
    return act('access.set', changed.join(', '), null, () => {
      cfg.console = c;
      const text = JSON.stringify(cfg, null, 2) + '\n'; const tmp = f + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
      try { require(co.p('company', 'tools', 'provenance.js')).wrote(f, text, 'console (owner)'); } catch (_) {}
      try { const g = co.p('scripts', 'instance-guard.sh'); if (fs.existsSync(g) && fs.existsSync(co.p('company', 'work', '.founded'))) require('child_process').execFileSync('bash', [g], { cwd: co.ROOT, stdio: 'ignore', timeout: 30000 }); } catch (_) {}
      decision('set console access: ' + changed.join(', '));
      return { saved: c, restartNeeded: true, note: 'Saved. It takes effect when the console restarts (Restart the console, below).' };
    });
  });

  /* ---------- memory (company/tools/memory.js; the reaper chore frees it) ---------- */
  route('GET', /^\/api\/ops\/memory$/, () => runApi('memory.js', ['status', '--json'], { timeout: 30000 }));
  // the shared temp folder's leftovers no company can vouch for (a listing, nothing removed)
  route('GET', /^\/api\/ops\/memory\/shared$/, () => runApi('reaper.js', ['host-sweep', '--json'], { timeout: 60000 }));
  route('POST', /^\/api\/ops\/memory$/, (m, q, b) => {
    const args = ['set', '--by', owner(), '--json'], changed = [];
    if (b.profile !== undefined) { if (!['auto', 'low', 'normal'].includes(b.profile)) bad('profile is auto, low or normal'); args.push('--profile', b.profile); changed.push('profile ' + b.profile); }
    if (b.keepFreeMB !== undefined) { const n = Number(b.keepFreeMB); if (!(Number.isFinite(n) && n >= 0 && n <= 1048576)) bad('keepFreeMB is a number of MB, 0 or more'); args.push('--keep-free', String(Math.round(n))); changed.push('keep free ' + Math.round(n) + ' MB'); }
    if (b.visibleBrowser !== undefined) { if (typeof b.visibleBrowser !== 'boolean') bad('visibleBrowser is true or false'); args.push('--visible-browser', b.visibleBrowser ? 'on' : 'off'); changed.push('station browser window ' + (b.visibleBrowser ? 'on' : 'off')); }
    if (!changed.length) bad('nothing to set');
    return act('memory.set', changed.join(', '), null, async () => {
      const r = await runApi('memory.js', args, { timeout: 120000 });
      if (r && r.ok === false) bad(r.error || 'not set', r.refused ? 403 : 400);
      return { changed: r.changed || changed, restartNeeded: !!r.restartNeeded, line: r.apply && r.apply.line || null, warnings: r.warnings || [] };
    });
  });
  // what: 'now' (the reaper's run, now rather than at its next turn) or 'shared-temp' (the owner's host sweep); both detached
  route('POST', /^\/api\/ops\/memory\/clean$/, (m, q, b) => {
    const R = co.p('company', 'tools', 'reaper.js');
    if (b.what === 'now') return act('memory.clean', 'now', null, () => ({ job: startJob('memory-clean', [process.execPath, R, 'run'], { label: 'Clean up now' }) }));
    if (b.what === 'shared-temp') return act('memory.clean', 'shared-temp', null, () => ({ job: startJob('memory-clean', [process.execPath, R, 'host-sweep', '--apply', '--by', owner()], { label: 'Clear other leftovers in the shared temp folder' }) }));
    bad("what is 'now' or 'shared-temp'");
  });

  /* ---------- jobs and the log ---------- */
  route('GET', /^\/api\/ops\/jobs$/, () => ({ ok: true, jobs: listJobs() }));
  route('GET', /^\/api\/ops\/jobs\/([a-z-]+-\d{14}-[0-9a-f]{4})$/, m => { const j = jobOf(m[1]); if (!j) bad('no job ' + m[1], 404); return { ok: true, job: j }; });
  route('GET', /^\/api\/ops\/log$/, () => { let rows = []; try { rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-200).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).reverse(); } catch (_) {} return { ok: true, rows }; });

  return { record, startJob, listJobs, jobOf, restartConsole };
}
module.exports = { mount };
