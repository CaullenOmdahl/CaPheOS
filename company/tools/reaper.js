#!/usr/bin/env node
/* reaper.js — the company cleans up after itself, so a long-running company does not slowly eat the computer's memory:
 * left-behind browsers, stray test and build processes, old temp files, growing folders (docs/RETENTION.md "The reaper").
 * It is the one CHORE among the duties (company/tools/duties.js, acts: true): the dispatcher runs it every 15 minutes (10
 * under the low memory profile), also while the company is halted, and it acts quietly. It wakes the crew (exit 1, routed
 * to the tools function) only for something they must fix, so routine clean-up never costs an agent run.
 *
 *   node company/tools/reaper.js --duty                      what the dispatcher runs (= run; READONLY env: a dry run)
 *   node company/tools/reaper.js status [--json]             what it would do now and why; touches nothing
 *   node company/tools/reaper.js run [--dry-run] [--only browsers,strays,temp,retention,sample] [--json]
 *   node company/tools/reaper.js host-sweep [--apply] --by owner [--json]
 *                                                            the shared temp folder's leftovers nobody can trace to this
 *                                                            company (Python temp dirs, build trees, Chrome temp files,
 *                                                            station leftovers of an unknown pid): listed; removed on --apply
 *                                                            (the owner only, never automatic)
 *   node company/tools/reaper.js selftest
 *
 * THIS COMPANY'S, with proof (lib/owned.js): a profile, working folder (even a deleted one) or TMPDIR inside the company
 * root; a process inside one of the company's units; one of its recorded station pids; a receipt in the station's process
 * ledger matched by pid and identity. When in doubt it leaves it alone. NEVER: the owner's own Chrome, another user's
 * process, a process in a unit or scope the company does not own, the live station / console / dispatcher, a registered
 * background service, anything matched by name only, a local AI model.
 *
 * Each run, in order (each action is one plain line in company/state/reaper.jsonl {at, kind, what, plain, freedMB, pid?,
 * path?, seat?} and the run's summary is one line in the dispatch log; nothing is logged when nothing happened):
 *   1 browsers   a driven Chrome of this company whose parent is gone (pid 1 / systemd --user), older than the plan's
 *                minimum age (30 min; 10 under low) and with no client on its debugging port for that long, measured
 *                across runs (reaper.json browserIdle: a client seen at any run starts the clock again; the first idle
 *                sighting only starts it), so a browser an agent keeps alive and reconnects to between tool calls is
 *                never ended between two calls. One that sits inside the station's own unit is spared while the station
 *                runs anything (GET /api/state/snapshot runs or queued turns; a station that does not answer counts as
 *                busy). Then: TERM to its group, up to 3 s, KILL to everything naming its profile; a profile in a temp
 *                dir is removed. A browser the live
 *                station runs is the station's (patch 0020 closes it when idle): never killed; idle past 3 x the idle
 *                time it is reported (broken idle close).
 *   2 strays     this company's processes handed to init, outside its units, older than 6 h (3 under low): known kinds
 *                (flutter_tester, dart frontend/analysis servers, esbuild --service, a mock station or test walk, an
 *                orphaned test station, pytest) are ended; Gradle and Kotlin daemons only after 3 h without using any
 *                CPU (measured across runs), with TERM and 20 s to stop by themselves first; any other kind is
 *                reported once.
 *   3 temp       company/tools/tmp-sweep.js, scope own: the private temp dir (older than 24 h and not in use; 6 h under
 *                memory pressure; never when it is a symlink or resolves outside the company) and, in the shared /tmp,
 *                only leftovers of this company's own station pids (a test walk there may be another company's). A file pattern that keeps leaking (200 entries or 1 GB a day, 2 days) is
 *                reported once a week. Only in a set-up company (its private temp dir exists; CAPHEOS_TMP_SWEEP=0: off).
 *   4 retention  the folder rules (retention.js dirPolicies), at most once a company day, never while halted: measured;
 *                past a row's warnBytes the owner is asked once (an owner card); deleted only after their yes. A
 *                report-only row is never deleted here: the yes becomes a due item for the tools seat until it is gone.
 *   5 sample     memory.js sample; a unit growing for 48 h without a restart is reported once a week (never restarted).
 *   6 pressure   free memory under keepFreeMB + 256 MB (under low also under 300 MB): asks the station to close its
 *                browser when no run drives it, halves the temp ages, writes company/state/memory-pressure.json;
 *                still short after 3 runs: reported.
 * While halted (either kind): browsers, strays and temp still run (pure clean-up, it frees memory); retention deletes do not.
 * Exit 0: nothing due (even when it acted; stdout {"acted": "<summary>"}). Exit 1: {due, reason, route:'tools', key, items}.
 * State: company/state/reaper.json (station pid history, what was reported, leak counts, the retention answers).
 * Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const O = require('./lib/owned');
const M = require('./lib/memory');
const TS = require('./tmp-sweep.js');

const DAY = 86400e3;
const fmt = mb => mb >= 1024 ? (mb / 1024).toFixed(1).replace(/\.0$/, '') + ' GB' : Math.max(0, Math.round(mb)) + ' MB';
const fmtAge = s => s == null ? 'unknown age' : s >= 7200 ? Math.round(s / 3600) + ' h old' : s >= 3600 ? '1 h old' : Math.max(1, Math.round(s / 60)) + ' min old';
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms)); } catch (_) {} };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function isoWeek(ms) {
  const d = new Date(ms); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / DAY + 1) / 7)).padStart(2, '0');
}
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

/* ---------------- context: everything a selftest replaces ---------------- */
function context(o) {
  o = o || {};
  const root = O.real(path.resolve(o.root || process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..')));
  const config = readJson(path.join(root, 'company', 'company.json'), {}) || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const sup = o.supervisor || (() => { try { return require('./lib/host').supervisor(); } catch (_) { return 'none'; } })();
  const ctx = {
    root, config, now, sup, dry: !!o.dry,
    svc: M.svcOf(config), slug: M.slugOf(config),
    P: (...a) => path.join(root, ...a),
    systemctl: o.systemctl || M.realSystemctl,
    proc: o.proc || '/proc',
    cgroupOf: o.cgroupOf || null, netTcp: o.netTcp || null, home: o.home || os.homedir(),
    kill: o.kill || ((pid, sig) => { try { process.kill(pid, sig); return true; } catch (_) { return false; } }),
    alive: o.alive || alive,
    graceMs: Number.isFinite(o.graceMs) ? o.graceMs : 3000,
    minAgeS: Number.isFinite(o.minAgeS) ? o.minAgeS : null,      // test only (--min-age): browsers and strays
    idleS: Number.isFinite(o.idleS) ? o.idleS : null,            // test only: a build daemon's idle time (else its kind's idleH)
    browserIdleS: Number.isFinite(o.browserIdleS) ? o.browserIdleS : null,   // test only: an orphaned browser's idle time (else the plan's)
    runsInFlight: o.runsInFlight !== undefined ? o.runsInFlight : undefined,  // test only: true / false (else asked of the station)
    daemonGraceMs: Number.isFinite(o.daemonGraceMs) ? o.daemonGraceMs : 20000,   // a build daemon's time to stop on TERM
    tempDirs: o.tempDirs || null, forceTemp: !!o.forceTemp, unitDir: o.unitDir || null,
    meminfo: o.meminfo || null,
    halted: o.halted !== undefined ? o.halted : haltedOf(root, now),
    card: o.card || null, answerOf: o.answerOf || null,
    stationApi: o.stationApi || null,
    noNetwork: o.noNetwork !== undefined ? o.noNetwork : process.env.CAPHEOS_NO_NETWORK === '1',
    log: o.log || null,
  };
  ctx.state = readJson(ctx.P('company', 'state', 'reaper.json'), null) || { v: 1 };
  return ctx;
}
function haltedOf(root, now) {
  const h = readJson(path.join(root, 'company', 'state', 'halt.json'), null);
  if (h && (h.mode === 'soft' || h.mode === 'hard')) return h.mode;
  const r = readJson(path.join(root, 'company', 'state', 'restart-hold.json'), null);
  if (r && r.watching !== true && Date.parse(String(r.expiresAt || '')) > now) return 'restart';
  return false;
}
function planOf(ctx) {
  if (ctx.plan) return ctx.plan;
  const h = ctx.meminfo ? M.parseMeminfo(ctx.meminfo) : M.host({ oomd: false });
  const s = M.settings(ctx.config);
  ctx.hostMem = h;
  // the same plan memory.js applies: the companies sharing this machine and what is kept free on it (lib/memory.js share)
  const unitDir = ctx.unitDir || process.env.MEMORY_UNIT_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
  const sh = M.share({ root: ctx.root, config: ctx.config, unitDir, supervisor: ctx.sup });
  return (ctx.plan = M.plan({ totalMB: h.totalMB, profile: M.profileOf(s, h), keepFreeMB: Math.max(s.keepFreeMB, sh.keepFreeMB), companies: sh.n }));
}
function saveState(ctx) {
  if (ctx.dry) return;
  const f = ctx.P('company', 'state', 'reaper.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(ctx.state, null, 1) + '\n'); fs.renameSync(t, f);
}
function record(ctx, row) {
  const r = Object.assign({ at: new Date(ctx.now).toISOString() }, row);
  (ctx.rows = ctx.rows || []).push(r);
  if (ctx.dry) return r;
  const f = ctx.P('company', 'state', 'reaper.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(r) + '\n');
  return r;
}
function due(ctx, item) { (ctx.due = ctx.due || []).push(item); }
// reported once per key in its window (a pid, a pattern and week, a unit and week)
function firstTime(ctx, key) {
  const rep = ctx.state.reported = ctx.state.reported || {};
  for (const [k, at] of Object.entries(rep)) if (ctx.now - Date.parse(at) > 30 * DAY) delete rep[k];
  if (rep[key]) return false;
  rep[key] = new Date(ctx.now).toISOString(); return true;
}

/* ---------------- the station's pid history and live mains ---------------- */
function mains(ctx) {
  if (ctx.mains) return ctx.mains;
  const out = { station: null, all: [] };
  if (ctx.sup === 'systemd') {
    const units = [ctx.svc + '.service', ctx.svc + '-console.service', ctx.svc + '-dispatch.service'];
    const r = ctx.systemctl(['show', '-p', 'Id', '-p', 'MainPID'].concat(units));
    for (const b of M.parseShow(r.out)) { const pid = Number(b.MainPID) || 0; if (!pid) continue; out.all.push(pid); if (b.Id === ctx.svc + '.service') out.station = pid; }
  }
  const hist = ctx.state.stationPids = (ctx.state.stationPids || []).filter(x => x && x.pid);
  if (out.station) {
    const at = new Date(ctx.now).toISOString(); const e = hist.find(x => x.pid === out.station);
    if (e) e.lastSeen = at; else hist.push({ pid: out.station, firstSeen: at, lastSeen: at });
    ctx.state.stationPids = hist.slice(-50);
  }
  return (ctx.mains = out);
}
function owned(ctx) {
  const m = mains(ctx);
  let reg = []; const doc = readJson(ctx.P('company', 'state', 'services.json'), null);
  for (const e of Object.values((doc && doc.services) || {})) if (e && e.unit) reg.push(e.unit + '.service');
  return O.context({ root: ctx.root, config: ctx.config, proc: ctx.proc, home: ctx.home, cgroupOf: ctx.cgroupOf, netTcp: ctx.netTcp, now: ctx.now,
    mainPids: m.all, stationMain: m.station, stationPids: (ctx.state.stationPids || []).map(x => x.pid), registered: reg,
    tempDirs: ctx.tempDirs || undefined });
}
function seatOf(ctx, p) {
  const s = String(p || '');
  let m = /[\/\\]scratch[\/\\]([a-z][a-z0-9_]*)-/i.exec(s) || /[\/\\]workspaces[\/\\]([A-Za-z0-9_-]{2,40})[\/\\]/.exec(s);
  if (!m) return null;
  const id = m[1]; const agents = (readJson(ctx.P('company', 'tools', 'loops.json'), {}) || {}).agents || {};
  return { id, name: (agents[id] && agents[id].name) || id.charAt(0).toUpperCase() + id.slice(1) };
}
// TERM to the group (when it leads one) or the pid, wait up to graceMs, KILL to what is left (and to `naming`)
function endAll(ctx, targets, naming, graceMs) {
  if (ctx.dry || !targets.length) return;
  for (const t of targets) ctx.kill(t.pgid === t.pid ? -t.pid : t.pid, 'SIGTERM');
  const until = Date.now() + (Number.isFinite(graceMs) ? graceMs : ctx.graceMs);
  const live = () => targets.some(t => (t.pids || [t.pid]).some(p => ctx.alive(p)));
  while (live() && Date.now() < until) pause(100);
  for (const t of targets) { if (t.pgid === t.pid) ctx.kill(-t.pid, 'SIGKILL'); for (const p of t.pids || [t.pid]) if (ctx.alive(p)) ctx.kill(p, 'SIGKILL'); }
  if (naming) { pause(100); const c = owned(ctx); for (const t of targets) if (t.profile) for (const p of O.naming(c, t.profile)) ctx.kill(p, 'SIGKILL'); }   // its helpers too (crashpad names the profile)
}

/* ---------------- 1 browsers ---------------- */
function stepBrowsers(ctx) {
  const p = planOf(ctx); const c = owned(ctx);
  const minAge = ctx.minAgeS != null ? ctx.minAgeS : p.reaper.orphanMinAgeMin * 60;
  const list = O.browsers(c);
  const go = [], idleSeen = ctx.state.idleSeen = ctx.state.idleSeen || {}, seenNow = new Set();
  // an orphan's idle clock, across runs: {"<pid>:<start>": since}. A client on its port (now) resets it; the first idle
  // sighting starts it; it is ended only after needIdle seconds of idle seen at every run in between
  const bIdle = ctx.state.browserIdle = ctx.state.browserIdle || {}, bSeen = new Set();
  const needIdle = ctx.browserIdleS != null ? ctx.browserIdleS : p.reaper.orphanMinAgeMin * 60;
  const stationUnit = ctx.svc + '.service';
  for (const b of list) {
    if (b.parent === 'station') {
      if (!b.idle) { delete idleSeen[b.pid]; continue; }
      seenNow.add(String(b.pid)); idleSeen[b.pid] = idleSeen[b.pid] || new Date(ctx.now).toISOString();
      if (ctx.now - Date.parse(idleSeen[b.pid]) > 3 * p.browsers.idleMin * 60e3 && firstTime(ctx, 'idle-close:' + b.pid))
        due(ctx, { id: 'idle-close:' + b.pid, reason: 'The station\'s own browser has sat unused for more than ' + Math.round((ctx.now - Date.parse(idleSeen[b.pid])) / 60e3) + ' minutes and did not close itself (it should after ' + p.browsers.idleMin + '); it was not ended' });
      continue;
    }
    const key = b.pid + ':' + (b.startMs || 0);
    if (b.parent === 'orphan') bSeen.add(key);
    if (b.parent === 'orphan' && !b.idle) delete bIdle[key];
    let idleFor = null;
    if (b.parent === 'orphan' && b.idle) {
      if (!bIdle[key]) bIdle[key] = new Date(ctx.now).toISOString();
      else idleFor = Math.max(0, (ctx.now - Date.parse(bIdle[key])) / 1000);
    }
    b.idleS = idleFor == null ? null : Math.round(idleFor);
    b.decision = b.parent !== 'orphan' ? 'its parent still runs' : !b.idle ? 'something is connected to it'
      : idleFor == null ? 'idle only since this look (its clock starts)' : idleFor < needIdle ? 'idle for ' + fmtAge(Math.round(idleFor)).replace(/ old$/, '') + ' only'
      : b.ageS != null && b.ageS < minAge ? 'too new'
      : b.unit === stationUnit && ctx.runsInFlight !== false ? (ctx.runsInFlight === true ? 'in the station, which is running work' : 'in the station, which did not say whether it runs work')
      : 'end';
    if (b.decision === 'end') go.push(b);
  }
  for (const k of Object.keys(idleSeen)) if (!seenNow.has(k)) delete idleSeen[k];
  for (const k of Object.keys(bIdle)) if (!bSeen.has(k)) delete bIdle[k];
  endAll(ctx, go, true);
  const tmpRoots = (ctx.tempDirs || [ctx.P('.starnet-data', 'tmp'), os.tmpdir(), '/tmp']).map(O.real);
  for (const b of go) {
    const who = seatOf(ctx, b.profile) || seatOf(ctx, b.cwd);
    let removed = false;
    if (!ctx.dry && b.profile && tmpRoots.some(t => O.inside(O.real(b.profile), t) && O.real(b.profile) !== t) && !O.naming(owned(ctx), b.profile).length) {
      try { fs.rmSync(b.profile, { recursive: true, force: true }); removed = true; } catch (_) {}
    }
    record(ctx, { kind: 'browser', what: 'pid ' + b.pid + ' profile ' + b.profile + ' (' + b.proof.how + ': ' + b.proof.detail + ')' + (removed ? '; profile removed' : ''), pid: b.pid, path: b.profile, seat: who ? who.id : undefined, freedMB: b.pssMB,
      plain: 'Closed a browser left running by ' + (who ? who.name + '\'s work' : 'a test') + ' (' + fmtAge(b.ageS) + ', ' + fmt(b.pssMB) + ').' });
  }
  return { seen: list.length, ended: go.length, list };
}

/* ---------------- 2 strays ---------------- */
function stepStrays(ctx) {
  const p = planOf(ctx); const c = owned(ctx);
  const minAgeS = ctx.minAgeS != null ? ctx.minAgeS : p.reaper.strayMinAgeH * 3600;
  const list = O.strays(c, { minAgeS });
  // a build daemon (Gradle, Kotlin: its kind has idleH) is ended only after idleH hours without using any CPU, measured
  // across runs in reaper.json strayCpu {"<pid>:<start>": {ticks, since}}; its first sighting starts the clock. Never by
  // its age alone: an old daemon may be serving a build right now.
  const cpu = ctx.state.strayCpu = ctx.state.strayCpu || {}; const seenCpu = new Set();
  for (const s of list) {
    if (!s.kind || !s.idleH) continue;
    const key = s.pid + ':' + (s.startMs || 0); seenCpu.add(key);
    const prev = cpu[key];
    if (!prev || prev.ticks !== s.cpuTicks) { cpu[key] = { ticks: s.cpuTicks, since: new Date(ctx.now).toISOString() }; s.decision = 'in use (used CPU since the last look)'; continue; }
    const idleFor = (ctx.now - Date.parse(prev.since)) / 1000;
    const need = ctx.idleS != null ? ctx.idleS : s.idleH * 3600;
    s.decision = idleFor >= need ? 'end' : 'in use (idle ' + fmtAge(Math.round(idleFor)).replace(/ old$/, '') + ')';
    s.idleS = Math.round(idleFor);
  }
  for (const k of Object.keys(cpu)) if (!seenCpu.has(k)) delete cpu[k];
  const known = list.filter(s => s.kind && (!s.idleH || s.decision === 'end'));
  const daemons = known.filter(s => s.idleH), quick = known.filter(s => !s.idleH);
  // a known kind's group may hold the company's other strays: end each one alone unless it leads its own group.
  // A build daemon gets TERM and daemonGraceMs to stop by itself first (the JVM's own shutdown: what `gradle --stop`
  // asks of it). Not `gradle --stop` itself: that stops every daemon of that Gradle version for this user, also ones
  // that are not provably this company's.
  endAll(ctx, quick.map(s => Object.assign({}, s, { pids: [s.pid] })), false);
  endAll(ctx, daemons.map(s => Object.assign({}, s, { pgid: 0, pids: [s.pid] })), false, Math.max(ctx.graceMs, ctx.daemonGraceMs));
  for (const s of known) {
    const who = seatOf(ctx, s.cwd);
    record(ctx, { kind: 'stray', what: s.kind + ' pid ' + s.pid + ' (' + s.proof.how + ': ' + s.proof.detail + ')', pid: s.pid, seat: who ? who.id : undefined, freedMB: s.rssMB,
      plain: 'Ended a left-behind ' + s.kind + ' from ' + (who ? who.name + '\'s work' : 'a test or build') + ' (' + fmtAge(s.ageS) + (s.idleH ? ', unused for ' + fmtAge(s.idleS).replace(/ old$/, '') : '') + ', ' + fmt(s.rssMB) + ').' });
  }
  for (const s of list.filter(x => !x.kind)) {
    if (!firstTime(ctx, 'stray:' + s.pid + ':' + isoWeek(ctx.now))) continue;
    const R = require('./lib/duty-runner');
    due(ctx, { id: 'stray:' + s.pid, reason: 'A process from the company\'s work was left running with nothing to stop it (' + R.sanitize(s.comm, 40) + ', ' + fmtAge(s.ageS) + ', ' + fmt(s.rssMB) + '); it is not a kind the reaper may end: ' + R.sanitize(s.cmd, 120) });
  }
  return { seen: list.length, ended: known.length, list };
}

/* ---------------- 3 temp ---------------- */
// a name's pattern with its random part as * (console-walk-Ab12Cd -> console-walk-*, tmpab12cd_9 -> tmp*)
const patternOf = name => { const m = /^(.*[-.])[^-.]{4,}$/.exec(name); if (m) return m[1].replace(/\d{3,}/g, 'N') + '*'; return /^tmp/.test(name) ? 'tmp*' : name.slice(0, 3) + '*'; };
function stepTemp(ctx, pressure) {
  const priv = TS.privateDir(ctx.root);
  if (!ctx.forceTemp) {
    if (process.env.CAPHEOS_TMP_SWEEP === '0') return { skipped: 'CAPHEOS_TMP_SWEEP=0' };
    if (!fs.existsSync(priv)) return { skipped: 'no private temp dir (not a set-up company)' };
  }
  const p = planOf(ctx);
  const dirs = ctx.tempDirs || TS.defaultDirs(ctx.root);
  const r = TS.apply({ root: ctx.root, dirs, scope: 'own', dry: ctx.dry, stationPids: new Set((ctx.state.stationPids || []).map(x => x.pid)), proc: ctx.proc,
    privateMinAge: (pressure ? p.reaper.pressureTempAgeH : p.reaper.privateTempAgeH) * 3600 });
  if (r.refused) return { refused: r.refused };
  if (r.removed.length) {
    const byCls = {}; for (const it of r.removed) { byCls[it.cls] = byCls[it.cls] || { n: 0, b: 0 }; byCls[it.cls].n++; byCls[it.cls].b += it.bytes; }
    const mb = r.freed / 1048576;
    record(ctx, { kind: 'temp', what: Object.entries(byCls).map(([k, v]) => k + ' ' + v.n + ' (' + fmt(v.b / 1048576) + ')').join(', ') + (pressure ? '; ages halved: memory is short' : ''), freedMB: Math.round(mb),
      plain: 'Removed ' + r.removed.length + ' old temp ' + (r.removed.length === 1 ? 'item' : 'items') + ' nobody used (' + fmt(mb) + ').' });
  }
  // leak counts per name pattern and day: a pattern leaking 200 entries or 1 GB a day for 2 days is reported once a week
  const leaks = ctx.state.leaks = ctx.state.leaks || {}; const today = dayOf(ctx.now);
  for (const it of r.removed) { const k = patternOf(it.name); const L = leaks[k] = leaks[k] || {}; const d = L[today] = L[today] || { n: 0, bytes: 0 }; d.n++; d.bytes += it.bytes; }
  for (const [k, L] of Object.entries(leaks)) {
    for (const d of Object.keys(L)) if (ctx.now - Date.parse(d) > 8 * DAY) delete L[d];
    if (!Object.keys(L).length) { delete leaks[k]; continue; }
    const heavy = Object.entries(L).filter(([, v]) => v.n > 200 || v.bytes > 1e9).map(([d]) => d).sort();
    if (heavy.length >= 2 && firstTime(ctx, 'leak:' + k + ':' + isoWeek(ctx.now))) {
      const n = heavy.reduce((s, d) => s + L[d].n, 0);
      due(ctx, { id: 'leak:' + k.slice(0, 60), reason: 'Crew tests or builds keep leaving temp files: ' + n + ' named like ' + k + ' in ' + heavy.length + ' days. They are cleared automatically, but whatever makes them should clean up after itself (for Python, tempfile.TemporaryDirectory)' });
    }
  }
  return { removed: r.removed.length, freed: r.freed };
}

/* ---------------- 4 retention (growing folders) ---------------- */
function cardApi(ctx) { if (ctx.card) return ctx.card; try { return require('./lib/owner-card'); } catch (_) { return null; } }
function answerOf(ctx, ref) {
  if (ctx.answerOf) return ctx.answerOf(ref);
  try { const g = require('./lib/governance'); const q = g.questionFor(ref, { root: ctx.root }); if (!q) return null; const a = g.approved(ref, { root: ctx.root }); return a === null ? null : { yes: a, id: q.id }; } catch (_) { return null; }
}
function stepRetention(ctx) {
  if (ctx.halted) return { skipped: 'halted' };
  const today = dayOf(ctx.now);
  if (ctx.state.retentionDay === today && !ctx.forceRetention) return { skipped: 'ran today' };
  const st = ctx.state.retention = ctx.state.retention || {};   // id -> {asked, questionId?, enforce?, declined?}
  // the owner's answers first: a yes turns the row on from now on, a no stops the asking
  for (const [id, x] of Object.entries(st)) {
    if (!x.asked || x.enforce || x.declined) continue;
    const a = answerOf(ctx, 'retention:' + id);
    if (a && a.yes) { x.enforce = true; x.answeredAt = new Date(ctx.now).toISOString(); x.questionId = a.id || x.questionId; }
    else if (a && a.yes === false) { x.declined = true; x.answeredAt = new Date(ctx.now).toISOString(); }
  }
  const R = require('./retention.js');
  const enforced = new Set(Object.entries(st).filter(([, x]) => x.enforce).map(([id]) => id));
  const res = R.dirPolicies({ root: ctx.root, now: ctx.now, dry: ctx.dry, halted: !!ctx.halted, enforced });
  const cutover = fs.existsSync(ctx.P('company', 'state', 'migration-cutover.json'));
  const out = { removed: 0, asked: [], handedOver: [] };
  for (const r of res.results) {
    // report-only: the reaper never deletes such a folder itself (another program may own it). The owner's yes hands the
    // removal to the tools seat, once a week until the folder is gone; then the row is marked done.
    if (r.policy === 'report-only' && st[r.id] && st[r.id].enforce && !st[r.id].done) {
      if (!r.exists) { st[r.id].done = new Date(ctx.now).toISOString(); }
      else if (firstTime(ctx, 'retention-yes:' + r.id + ':' + isoWeek(ctx.now))) {
        due(ctx, { id: 'retention-yes:' + r.id, reason: 'The owner agreed that ' + lc(r.plain || r.id) + ' (' + r.path + ', ' + fmt(r.bytes / 1048576) + ') may be removed. The reaper does not remove report-only folders itself: check nothing still uses it, remove it, and tell the owner it is gone' });
        out.handedOver.push(r.id);
      }
    }
    if (r.removed.length) {
      out.removed += r.removed.length;
      const oldest = r.removed.map(x => x.ageDays).sort((a, b) => b - a)[0];
      record(ctx, { kind: 'retention', what: r.id + ': ' + r.removed.map(x => x.rel).join(', ').slice(0, 400), freedMB: Math.round(r.freedBytes / 1048576), path: r.path,
        plain: 'Removed ' + r.removed.length + ' of these: ' + lc(r.plain || r.id) + ', the oldest ' + oldest + ' days old (' + fmt(r.freedBytes / 1048576) + ' on disk).' });
    }
    for (const e of r.errors) record(ctx, { kind: 'retention-error', what: r.id + ': ' + String(e).slice(0, 200), plain: 'Could not clear part of ' + lc(r.plain || r.id) + '; the crew will look.' });
    if (!r.warn || r.enforce || !r.ask || (st[r.id] && (st[r.id].asked || st[r.id].declined))) continue;
    if (r.askAfter === 'migration-cutover' && !cutover) continue;
    if (ctx.dry) { out.asked.push(r.id + ' (would ask)'); continue; }   // a dry run (status) never files a card
    const C = cardApi(ctx); if (!C) continue;
    const lead = r.policy === 'report-only'
      ? lc(r.plain || 'A company folder', true) + ' take ' + fmt(r.bytes / 1048576) + ' of disk. May the crew remove it now that it is no longer needed?'
      : lc(r.plain || 'Old company files', true) + ' take ' + fmt(r.bytes / 1048576) + ' of disk. Remove them automatically from now on' + (r.policy === 'keep-newest-dirs' && r.kept.length ? ', always keeping the newest ' + r.kept.length : '') + '?';
    try {
      const f = C.file({ asker: 'reaper', category: 'tools', ownerAct: true, ref: 'retention:' + r.id, lead,
        consequence: r.policy === 'report-only'
          ? 'Yes: the crew checks nothing still uses it, removes it and tells you when it is gone. No: it stays, and you are not asked again.'
          : 'Yes: the oldest ones are removed once a day and you are told what went. No: they stay, and you are not asked again.',
        recommendation: 'Yes, unless you keep these copies for a reason of your own.',
        technical: 'company/tools/reaper.js asks for retention row ' + r.id + ' (' + r.policy + ' ' + r.path + '); ' + r.candidates.length + ' candidates, ' + Math.round(r.bytes / 1048576) + ' MB. On yes the reaper records enforce for this row in company/state/reaper.json (or set "enforce": true on the row in company/work/ops/retention.json)' + (r.policy === 'report-only' ? '; a report-only row is never deleted by the reaper: the yes becomes a due item for the tools seat (retention-yes:' + r.id + ') until the folder is gone.' : '.'),
        effect: { none: true } }, { root: ctx.root });
      if (f && (f.filed || f.route === 'duplicate')) { st[r.id] = { asked: new Date(ctx.now).toISOString(), questionId: f.id || null }; out.asked.push(r.id); }
    } catch (e) { record(ctx, { kind: 'retention-error', what: 'owner card for ' + r.id + ': ' + String(e.message).slice(0, 200), plain: 'Could not ask you about ' + lc(r.plain || r.id) + '; the crew will look.' }); }
  }
  ctx.state.retentionDay = today;
  return out;
}
function lc(s, upper) { s = String(s || ''); return upper ? s.charAt(0).toUpperCase() + s.slice(1) : s.charAt(0).toLowerCase() + s.slice(1); }

/* ---------------- 5 sample ---------------- */
function stepSample(ctx) {
  const row = M.sample({ root: ctx.root, config: ctx.config, supervisor: ctx.sup, systemctl: ctx.systemctl, host: ctx.hostMem || undefined, dry: ctx.dry, now: ctx.now,
    ownedOpts: { proc: ctx.proc, cgroupOf: ctx.cgroupOf, netTcp: ctx.netTcp, home: ctx.home, now: ctx.now } });
  const grow = M.growth(M.readSamples(ctx.root, 49, ctx.now), ctx.now);
  for (const g of grow) if (firstTime(ctx, 'growth:' + g.unit + ':' + isoWeek(ctx.now)))
    due(ctx, { id: 'growth:' + g.unit, reason: 'A part of the company keeps using more memory without a restart: ' + g.unit + ' went from ' + fmt(g.firstMB) + ' to ' + fmt(g.lastMB) + ' in 48 hours (pid ' + g.pid + '). Nothing was restarted; find what grows' });
  return { row, growing: grow.length };
}

/* ---------------- 6 pressure ---------------- */
function pressureNow(ctx) {
  const p = planOf(ctx); const h = ctx.hostMem;
  return { short: Number.isFinite(h.availableMB) && h.totalMB > 0 && h.availableMB < p.pressure.belowMB, availableMB: h.availableMB, keepFreeMB: p.keepFreeMB, belowMB: p.pressure.belowMB };
}
async function stationCall(ctx, method, p, body) {
  if (ctx.stationApi) return ctx.stationApi(method, p, body);
  if (ctx.noNetwork) throw new Error('no network in this run');
  const port = ctx.config.station && ctx.config.station.port;
  const base = process.env.STARNET_URL || (ctx.config.station && ctx.config.station.url) || (port ? 'http://127.0.0.1:' + port : null);   // STARNET_URL wins, as in lib/company.js
  if (!base || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(base)) throw new Error('the station is not on this machine');
  let tok = ''; try { tok = fs.readFileSync(ctx.P('secrets', 'station-token'), 'utf8').trim(); } catch (_) {}
  if (!tok) throw new Error('no station token');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
  try { const r = await fetch(base.replace(/\/$/, '') + p, { method, headers: { 'x-starnet-token': tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal }); return await r.json(); }
  finally { clearTimeout(t); }
}
// true: the station runs work (a run or a queued turn); false: it says nothing runs; null: it did not answer (busy).
// Asked only when an orphaned browser of this company sits in the station's own unit (otherwise: false, no call).
async function stationBusy(ctx) {
  let list = []; try { list = O.browsers(owned(ctx)); } catch (_) { return null; }
  if (!list.some(b => b.parent === 'orphan' && b.unit === ctx.svc + '.service')) return false;
  try {
    const v = await stationCall(ctx, 'GET', '/api/state/snapshot');
    if (!v || !Array.isArray(v.runs)) return null;
    return v.runs.some(r => r && r.runId) || (v.queues || []).some(q => q && q.depth > 0);
  } catch (_) { return null; }
}
async function stepPressure(ctx, pr) {
  const f = ctx.P('company', 'state', 'memory-pressure.json');
  const prev = readJson(f, null);
  if (!pr.short) {
    ctx.state.pressureRuns = 0;
    if (prev && prev.since && !prev.endedAt && !ctx.dry) { prev.endedAt = new Date(ctx.now).toISOString(); writeJson(f, prev); }
    return { short: false };
  }
  ctx.state.pressureRuns = (ctx.state.pressureRuns || 0) + 1;
  const doc = { since: prev && prev.since && !prev.endedAt ? prev.since : new Date(ctx.now).toISOString(), at: new Date(ctx.now).toISOString(), availableMB: pr.availableMB, keepFreeMB: pr.keepFreeMB, belowMB: pr.belowMB };
  if (!ctx.dry) writeJson(f, doc);
  // the station's browser, when no run drives it (the view list says who drives it); a halt changes nothing here
  let closed = null;
  if (!ctx.dry) try {
    // GET /api/browser/view -> {station: {open, driver, ...}} (StarNet browser-view.js list); the close itself also refuses a driven one
    const v = await stationCall(ctx, 'GET', '/api/browser/view');
    const st = v && v.station;
    if (st && st.open && !st.driver) { if (!ctx.dry) { const r = await stationCall(ctx, 'POST', '/api/browser/view/close', {}); closed = !!(r && r.ok !== false); } }
    else closed = st && st.open ? false : null;
  } catch (_) { closed = null; }
  record(ctx, { kind: 'pressure', what: 'available ' + pr.availableMB + ' MB < ' + pr.belowMB + ' MB' + (closed ? '; station browser closed' : closed === false ? '; station browser in use, left open' : ''), freedMB: 0,
    plain: 'Memory ran short (' + fmt(pr.availableMB) + ' free' + (pr.keepFreeMB ? ', ' + fmt(pr.keepFreeMB) + ' kept for other programs' : '') + '): old temp files were cleared sooner' + (closed ? ' and the station\'s unused browser was closed' : '') + '.' });
  if (ctx.state.pressureRuns >= 3 && firstTime(ctx, 'pressure:' + dayOf(ctx.now)))
    due(ctx, { id: 'pressure', reason: 'The computer has been short of memory for ' + ctx.state.pressureRuns + ' clean-up runs in a row (' + fmt(pr.availableMB) + ' free, ' + fmt(pr.keepFreeMB) + ' kept for other programs). Find what holds the memory (memory.js status) or lower the memory profile' });
  return { short: true, closed };
}
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); }

/* ---------------- one run ---------------- */
const STEPS = ['browsers', 'strays', 'temp', 'retention', 'sample'];
async function run(ctx, o) {
  o = o || {};
  const only = o.only ? new Set(o.only) : null;
  const want = s => !only || only.has(s);
  ctx.rows = []; ctx.due = [];
  planOf(ctx);
  const pr = pressureNow(ctx);
  const res = { halted: ctx.halted || false, pressure: pr };
  const step = (name, fn) => { if (!want(name)) return; try { res[name] = fn(); } catch (e) { res[name] = { error: String(e && e.message || e).slice(0, 200) }; } };
  // whether the station runs anything now: asked only when an orphaned browser sits in the station's own unit
  if (want('browsers') && ctx.runsInFlight === undefined) ctx.runsInFlight = await stationBusy(ctx);
  step('browsers', () => stepBrowsers(ctx));
  step('strays', () => stepStrays(ctx));
  step('temp', () => stepTemp(ctx, pr.short));
  step('retention', () => stepRetention(ctx));
  step('sample', () => stepSample(ctx));
  if (want('pressure')) { try { res.pressureStep = await stepPressure(ctx, pr); } catch (e) { res.pressureStep = { error: String(e.message).slice(0, 200) }; } }
  const freed = ctx.rows.reduce((s, r) => s + (Number(r.freedMB) || 0), 0);
  const acts = ctx.rows.filter(r => r.kind !== 'pressure');
  res.summary = acts.length ? acts.length + ' clean-up action' + (acts.length > 1 ? 's' : '') + ', ' + fmt(freed) + ' freed: ' + acts.map(r => r.plain).join(' ').slice(0, 300) : null;
  if (ctx.rows.some(r => r.kind === 'pressure')) res.summary = (res.summary ? res.summary + ' ' : '') + ctx.rows.find(r => r.kind === 'pressure').plain;
  ctx.state.lastRun = new Date(ctx.now).toISOString();
  if (res.summary) ctx.state.lastSummary = { at: ctx.state.lastRun, text: res.summary, freedMB: Math.round(freed) };
  saveState(ctx);
  res.rows = ctx.rows; res.due = ctx.due;
  for (const k of STEPS) if (res[k] && res[k].list) res[k].list = res[k].list.map(x => ({ pid: x.pid, kind: x.kind, decision: x.decision, parent: x.parent, proof: x.proof && x.proof.how, ageS: x.ageS, idleS: x.idleS }));
  return res;
}
function dueJson(res) {
  if (!res.due.length) return null;
  const items = res.due.slice(0, 50).map(d => ({ id: d.id, route: 'tools' }));
  const key = 'reaper:' + crypto.createHash('sha256').update(items.map(i => i.id).sort().join('|')).digest('hex').slice(0, 12);
  return { due: true, reason: res.due[0].reason + (res.due.length > 1 ? ' (and ' + (res.due.length - 1) + ' more: reaper.js status)' : ''), route: 'tools', key, items };
}

/* ---------------- host-sweep: the owner's button for the shared temp folder ---------------- */
function hostSweep(o) {
  o = o || {};
  const root = O.real(path.resolve(o.root || process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..')));
  const priv = O.real(TS.privateDir(root));
  const dirs = (o.dirs || [os.tmpdir(), '/tmp']).map(d => O.real(path.resolve(d))).filter((d, i, a) => d !== priv && a.indexOf(d) === i && fs.existsSync(d));
  const st = readJson(path.join(root, 'company', 'state', 'reaper.json'), {}) || {};
  const s = TS.scan({ root, dirs, scope: 'host', stationPids: new Set((st.stationPids || []).map(x => x.pid)), proc: o.proc });
  const go = s.items.filter(i => i.go);
  const out = { dirs, items: s.items.length, wouldGo: go.length, bytes: go.reduce((a, i) => a + i.bytes, 0), byClass: {}, applied: false, removed: 0, freed: 0 };
  for (const i of go) { out.byClass[i.cls] = out.byClass[i.cls] || { n: 0, bytes: 0 }; out.byClass[i.cls].n++; out.byClass[i.cls].bytes += i.bytes; }
  if (!o.apply) return out;
  const owner = require('./lib/owner');
  if (!owner.isOwnerName(o.by)) return Object.assign(out, { refused: 'host-sweep --apply is the owner\'s: --by owner' });
  if (!(o.ownerShell ? o.ownerShell() : owner.shell())) return Object.assign(out, { refused: '"--by owner" is accepted ' + owner.REASON });
  if (!s.known) return Object.assign(out, { refused: 'cannot see running processes (/proc); nothing removed' });
  for (const i of go) { try { fs.rmSync(path.join(i.dir, i.name), { recursive: true, force: true }); out.removed++; out.freed += i.bytes; } catch (_) {} }
  out.applied = true;
  if (out.removed) {
    const f = path.join(root, 'company', 'state', 'reaper.jsonl'); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), kind: 'host-temp', by: 'owner', what: Object.entries(out.byClass).map(([k, v]) => k + ' ' + v.n).join(', '), freedMB: Math.round(out.freed / 1048576),
      plain: 'You cleared ' + out.removed + ' leftovers from the shared temp folder (' + fmt(out.freed / 1048576) + ').' }) + '\n');
  }
  return out;
}

/* ---------------- CLI ---------------- */
async function main(argv) {
  const cmd = argv[0] || 'status';
  const val = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const json = argv.includes('--json');
  if (cmd === 'selftest' || cmd === '--selftest') return require('./tests/helpers/reaper-selftest.js').selftest();
  if (cmd === '--duty') {
    const ro = process.env.CAPHEOS_READONLY === '1';   // run as a plain (read-only) duty: look, change nothing
    const ctx = context({ dry: ro });
    const res = await run(ctx);
    if (ro) return 0;
    const d = dueJson(res);
    if (d) { console.log(JSON.stringify(d)); return 1; }
    if (res.summary) console.log(JSON.stringify({ acted: res.summary }));
    return 0;
  }
  if (cmd === 'status' || cmd === 'run') {
    const only = (val('only') || '').split(',').filter(Boolean);
    const ma = val('min-age');
    const ctx = context({ dry: cmd === 'status' || argv.includes('--dry-run'), minAgeS: ma !== undefined ? Number(ma) : undefined });
    if (cmd === 'run') ctx.forceRetention = argv.includes('--retention-now');
    const res = await run(ctx, { only: only.length ? only : null });
    if (json) { console.log(JSON.stringify(res, null, 1)); return 0; }
    console.log((ctx.dry ? 'would do: ' : 'did: ') + (res.summary || 'nothing to clean up') + (res.halted ? ' (company halted: no folder clean-up)' : ''));
    console.log('memory: ' + fmt(res.pressure.availableMB) + ' free' + (res.pressure.short ? ', SHORT (under ' + fmt(res.pressure.belowMB) + ')' : ''));
    for (const k of ['browsers', 'strays']) if (res[k] && res[k].list) for (const x of res[k].list) console.log('  ' + k.slice(0, -1) + ' pid ' + x.pid + ' ' + (x.kind || x.parent || '') + ' ' + fmtAge(x.ageS) + ' (' + x.proof + ')' + (x.decision ? ': ' + x.decision : ''));
    for (const d of res.due) console.log('needs the crew: ' + d.reason);
    return 0;
  }
  if (cmd === 'host-sweep') {
    const r = hostSweep({ apply: argv.includes('--apply'), by: val('by') });
    if (json) console.log(JSON.stringify(r, null, 1));
    else console.log(r.refused ? 'not cleared: ' + r.refused : (r.applied ? 'removed ' + r.removed + ' (' + fmt(r.freed / 1048576) + ')' : r.wouldGo + ' leftovers nobody can trace to this company would go (' + fmt(r.bytes / 1048576) + '): ' + Object.entries(r.byClass).map(([k, v]) => k + ' ' + v.n).join(', ') + '. Clear them with --apply --by owner.'));
    return r.refused ? 3 : 0;
  }
  console.error('usage: reaper.js --duty | status | run [--dry-run] [--only ...] | host-sweep [--apply] --by owner | selftest');
  return 2;
}
module.exports = { stationBusy, context, run, dueJson, hostSweep, stepBrowsers, stepStrays, stepTemp, stepRetention, stepSample, stepPressure, pressureNow, planOf, patternOf, isoWeek, seatOf };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('reaper: ' + (e && e.stack || e)); process.exitCode = 2; });
