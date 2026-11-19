#!/usr/bin/env node
/* memory.js — what the company uses of this computer's memory, what it may use, and the limits that keep it there
 * (docs/RETENTION.md "Memory", docs/DEPLOY-SERVER.md "Memory").
 *
 *   node company/tools/memory.js status [--json]       the machine, the profile, the plan, what each part uses now, what the
 *                                                       reaper freed in the last day and week; one plain line on top
 *   node company/tools/memory.js plan [--total MB] [--profile auto|low|normal] [--keep-free MB] [--companies N] [--json]
 *                                                       what would be set (this machine's size and the companies on it
 *                                                       unless --total / --companies)
 *   node company/tools/memory.js set [--profile auto|low|normal] [--keep-free MB] [--visible-browser on|off] --by owner [--json]
 *                                                       owner only: company.json runtime.memory, then apply
 *   node company/tools/memory.js apply [--dry-run] [--json]
 *                                                       write the limits: a drop-in per unit and .starnet-data/memory.env
 *   node company/tools/memory.js sample                 one line in company/state/memory-samples.jsonl (the reaper runs it)
 *   node company/tools/memory.js selftest
 *
 * Settings (company.json runtime.memory; unset = auto): profile auto|low|normal (auto: low on 4.5 GB or less),
 * keepFreeMB (memory the company never plans to use: kept for other programs, like a local AI model), visibleBrowser
 * (the station's browser as a window on this computer; off: headless, and it closes itself when unused).
 * Two or more companies on one machine (lib/memory.js share: every other enabled station unit in the user's unit dir):
 * the machine minus what is kept free (the largest keepFreeMB any of them asks for) and the system's share is split
 * evenly, so together they fit; status says when the limits in force were planned for another number of companies.
 *
 * apply writes ONLY its own files, never the main units or the env file that holds the station token:
 *   ~/.config/systemd/user/<unit>.service.d/50-capheos-memory.conf   station, console, dispatcher: MemoryHigh, MemoryMax,
 *       MemorySwapMax and the ExecStart line of the unit's template with --max-old-space-size (the heap cap goes on the
 *       start command, not NODE_OPTIONS, so an agent's own node builds never inherit it)
 *   ~/.config/systemd/user/<slice>.slice and <level>.slice.d/50-capheos-memory.conf   the company's own slice
 *       (lib/memory.js sliceOf: capheos-<svc>.slice, outside app.slice; every unit template and service.js unit says
 *       Slice=<it>, owner jobs get --slice) with systemd-oomd's memory-pressure kill off on it and on each level above it
 *       (ManagedOOMMemoryPressure=auto). Why: the host's slice defaults put the kill rule on app.slice, and a build held
 *       at the station's MemoryHigh raises app.slice's pressure; with the station omitted, oomd would end the owner's
 *       desktop apps, the owner's Chrome or the other company's units instead. A running unit moves into the slice at its
 *       next restart (apply says which are still elsewhere; status shows it).
 *   <root>/.starnet-data/memory.env (0600)   the station's browser and shell settings (StarNet patch 0020 reads them;
 *       a station without it ignores them); in a container also the three heap sizes the s6 run script passes on
 * Then `systemctl --user daemon-reload` and, for each running unit, `set-property --runtime` so the limits apply now
 * without a restart. A changed heap or memory.env needs a restart: apply never restarts anything; it prints (and returns
 * as restartCommand) the safe restart that waits until nothing runs. Each written file is recorded with
 * locked-watch.js accept, so no drift flag appears. The reaper never calls apply.
 * Env: MEMORY_SYSTEMCTL (the systemctl binary), MEMORY_UNIT_DIR (where the drop-ins go; default XDG_CONFIG_HOME or ~/.config).
 * Owner of this tool: the tools function (co.seatFor('tools')).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./lib/memory');

const DROPIN = '50-capheos-memory.conf';
const fmtGB = mb => mb == null ? '?' : mb >= 1024 ? (mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace(/\.0$/, '') + ' GB' : Math.round(mb) + ' MB';

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } }
function context(o) {
  o = o || {};
  const root = path.resolve(o.root || process.env.CAPHEOS_ROOT || path.join(__dirname, '..', '..'));
  const config = readJson(path.join(root, 'company', 'company.json'), {}) || {};
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return {
    root, config,
    unitDir: o.unitDir || process.env.MEMORY_UNIT_DIR || path.join(xdg, 'systemd', 'user'),
    systemctl: o.systemctl || M.realSystemctl,
    supervisor: o.supervisor || (() => { try { return require('./lib/host').supervisor(); } catch (_) { return 'none'; } })(),
    host: o.host || null,
    ownerShell: o.ownerShell || (() => require('./lib/owner').shell()),
    accept: o.accept || (rel => {
      if (!fs.existsSync(path.join(root, 'company', 'state', 'locked', 'baseline.json'))) return;
      try { execFileSync(process.execPath, [path.join(root, 'company', 'tools', 'locked-watch.js'), 'accept', rel, '--by', 'owner', '--why', 'memory settings (memory.js apply)'], { cwd: root, stdio: 'ignore', timeout: 30000 }); } catch (_) {}
    }),
    usageOpts: o.usageOpts || {},
    stationApi: o.stationApi || null,
    noNetwork: o.noNetwork !== undefined ? o.noNetwork : process.env.CAPHEOS_NO_NETWORK === '1',
    now: Number.isFinite(o.now) ? o.now : Date.now(),
  };
}
const hostOf = ctx => ctx.host || (ctx.host = M.host());
// the companies sharing this machine and the memory kept free on it (lib/memory.js share): never cached across a set
const shareOf = ctx => ctx.share || (ctx.share = M.share({ root: ctx.root, config: ctx.config, unitDir: ctx.unitDir, supervisor: ctx.supervisor }));
function planFor(ctx, over) {
  over = over || {};
  const s = Object.assign(M.settings(ctx.config), over.settings || {});
  const h = hostOf(ctx);
  const sh = shareOf(ctx);
  const totalMB = Number(over.totalMB) || h.totalMB;
  const profile = M.profileOf(s, { totalMB });
  // kept free: this company's own setting, or more when another company on this machine keeps more free (a local AI
  // model is the machine's, not one company's); --keep-free on plan shows one value
  const keepFreeMB = over.keepFreeMB != null ? over.keepFreeMB : Math.max(s.keepFreeMB, sh.keepFreeMB);
  const companies = Number(over.companies) || sh.n;
  return Object.assign(M.plan({ totalMB, profile, keepFreeMB, companies }), { settings: s, others: over.companies ? [] : sh.others });
}
function sliceLine(sl) {
  if (!sl) return null;
  return 'slice: ' + sl.name + (sl.pressureKillOff ? ' (outside app.slice; systemd-oomd\'s pressure kill off)' : ' (not written yet: memory.js apply writes it)')
    + (sl.elsewhere.length ? ' · still elsewhere until their next restart: ' + sl.elsewhere.map(x => x.unit + ' (' + x.slice + ')').join(', ') : sl.inSlice.length ? ' · every running unit is in it' : '');
}
function planLine(p) {
  const n = p.companies || 1;
  return 'Memory: ' + p.profile + ' profile for this ' + fmtGB(p.totalMB) + ' machine' + (n > 1 ? ', shared evenly with ' + (n - 1) + ' other compan' + (n > 2 ? 'ies' : 'y') + ' on it' : '') + '; the station may use up to ' + fmtGB(p.station.maxMB) + '; ' + fmtGB(p.keepFreeMB) + ' kept free for other programs.';
}

/* ---------------- what apply writes ---------------- */
const svc = ctx => M.svcOf(ctx.config);
function templateExec(ctx, tpl) {
  const f = path.join(ctx.root, 'systemd', tpl);
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  const m = /^ExecStart=(.*)$/m.exec(t); if (!m) return null;
  return m[1].replace(/@ROOT@/g, ctx.root).replace(/@SVC@/g, svc(ctx));
}
function withHeap(exec, heapMB) { return exec.replace(/(^|\s)node(\s)/, '$1node --max-old-space-size=' + heapMB + '$2'); }
const UNITS = [
  { role: 'station', tpl: 'capheos-station.service.in', suffix: '' },
  { role: 'console', tpl: 'capheos-station-console.service.in', suffix: '-console' },
  { role: 'dispatcher', tpl: 'capheos-station-dispatch.service.in', suffix: '-dispatch' },
];
function dropins(ctx, p) {
  const out = {};
  for (const u of UNITS) {
    const lim = p[u.role]; const exec = templateExec(ctx, u.tpl);
    const name = svc(ctx) + u.suffix + '.service';
    let t = '# written by company/tools/memory.js apply (profile ' + p.profile + ', ' + fmtGB(p.totalMB) + ' machine, keep free ' + p.keepFreeMB + ' MB, companies ' + (p.companies || 1) + '). Edit runtime.memory, not this file.\n[Service]\n'
      + 'MemoryHigh=' + lim.highMB + 'M\nMemoryMax=' + lim.maxMB + 'M\n' + (lim.swapMaxMB ? 'MemorySwapMax=' + lim.swapMaxMB + 'M\n' : '');
    // the station: a process the kernel ends at MemoryMax (a build) must not stop the whole unit (OOMPolicy=stop is the
    // default on many hosts); the console and dispatcher keep stop, they hold no runs and Restart= brings them back
    if (u.role === 'station') t += 'OOMPolicy=continue\n';
    // systemd-oomd: the host's slice defaults (/usr/lib/systemd/user/slice.d/10-oomd-per-slice-defaults.conf on Fedora,
    // CachyOS, ...) put ManagedOOMMemoryPressure=kill on every user slice, app.slice included, so a build holding the
    // station at its MemoryHigh reads as pressure and oomd would end the station's whole cgroup, every live run in it.
    // omit: oomd never picks this unit for memory pressure (its MemoryMax still bounds it; the kernel then ends the
    // build inside it, OOMScoreAdjust 500, not the sidecar). The dispatcher under low: the same, so a tick is never cut.
    const omit = u.role === 'station' || lim.oomdKill === false;
    if (lim.oomdKill === false) t += 'ManagedOOMMemoryPressure=auto\n';
    if (omit) t += 'ManagedOOMPreference=omit\n';
    if (exec) t += 'ExecStart=\nExecStart=' + withHeap(exec, lim.heapMB) + '\n';
    out[name] = { role: u.role, file: path.join(ctx.unitDir, name + '.d', DROPIN), text: t, heapMB: lim.heapMB, props: ['MemoryHigh=' + lim.highMB + 'M', 'MemoryMax=' + lim.maxMB + 'M'].concat(lim.swapMaxMB ? ['MemorySwapMax=' + lim.swapMaxMB + 'M'] : []).concat(omit ? ['ManagedOOMPreference=omit'] : []) };
  }
  return out;
}
// the company's slice: a unit file for it (a name in systemctl) and on it and every level above it (a dash is a level,
// capheos.slice is shared by the companies on this machine; the text is the same for all) the drop-in that turns
// systemd-oomd's memory-pressure kill off. 50- sorts after the host's slice.d/10-oomd-per-slice-defaults.conf, so it
// wins. The swap rule (ManagedOOMSwap) keeps the host's setting: MemorySwapMax bounds the station's swap, and a slice
// left out of it would only make oomd pick someone else's program when swap runs out.
const sliceName = ctx => M.sliceOf(ctx.config);
function sliceFiles(ctx) {
  const name = sliceName(ctx); const out = {};
  out[path.join(ctx.unitDir, name)] = '# written by company/tools/memory.js apply. The units of ' + (ctx.config.name || svc(ctx)) + ' run here, outside app.slice.\n'
    + '[Unit]\nDescription=' + String(ctx.config.name || svc(ctx)).replace(/[\n\r]/g, ' ').slice(0, 80) + ': the station, console, dispatcher, background services and owner jobs\n';
  for (const lvl of M.sliceChain(name)) out[path.join(ctx.unitDir, lvl + '.d', DROPIN)] = '# written by company/tools/memory.js apply (' + (lvl === name ? 'this company\'s slice' : 'a level of the CaPheOS companies\' slices; the same text from every company') + ').\n'
    + '# systemd-oomd never ends units here for memory pressure: a build held at the station\'s MemoryHigh is bounded by the\n# station\'s own MemoryMax; the kernel then ends the build, not the station or anyone else\'s program.\n[Slice]\nManagedOOMMemoryPressure=auto\n';
  return out;
}
function memEnv(ctx, p, sup) {
  const s = p.settings || M.settings(ctx.config);
  const lines = ['# written by company/tools/memory.js apply (profile ' + p.profile + '). Edit runtime.memory in company/company.json, not this file.'];
  if (!s.visibleBrowser) lines.push('STARNET_BROWSER_HEADLESS=1');
  lines.push('STARNET_BROWSER_IDLE_MIN=' + p.browsers.idleMin, 'STARNET_BROWSER_LOWMEM=' + (p.browsers.lowMemFlags ? 1 : 0), 'STARNET_PRIVATE_BROWSERS_MAX=' + p.browsers.privateMax,
    'STARNET_SHELL_OOM_ADJ=500', 'STARNET_SHELL_REAP_GROUP=1', 'STARNET_BROWSER_OWN_GROUP=1');
  if (p.agents.maxConcurrent > 0) lines.push('STARNET_MAX_CONCURRENT_AGENTS=' + p.agents.maxConcurrent);
  if (sup === 'container') lines.push('CAPHEOS_STATION_HEAP=' + p.station.heapMB, 'CAPHEOS_CONSOLE_HEAP=' + p.console.heapMB, 'CAPHEOS_DISPATCH_HEAP=' + p.dispatcher.heapMB);
  return lines.join('\n') + '\n';
}
const envFile = ctx => path.join(ctx.root, '.starnet-data', 'memory.env');
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
function writeAtomic(f, text, mode) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, text, { mode: mode || 0o644 }); fs.chmodSync(t, mode || 0o644); fs.renameSync(t, f);
}
const relOf = (ctx, f) => f.startsWith(ctx.root + path.sep) ? f.slice(ctx.root.length + 1) : f.startsWith(os.homedir() + path.sep) ? '~' + f.slice(os.homedir().length) : f;
function restartCommand(ctx) { return path.join(ctx.root, 'scripts', 'restart-station.sh') + ' --when-idle --reason "memory profile"'; }

function apply(ctx, o) {
  o = o || {};
  const p = planFor(ctx);
  const sup = ctx.supervisor;
  const wrote = [], unchanged = [], calls = [];
  const envText = memEnv(ctx, p, sup);
  const envChanged = readText(envFile(ctx)) !== envText;
  const result = { ok: true, dry: !!o.dry, supervisor: sup, plan: p, line: planLine(p), wrote, unchanged, restartNeeded: [], warnings: p.warnings.slice() };
  if (!o.dry) { if (envChanged) { writeAtomic(envFile(ctx), envText, 0o600); wrote.push(envFile(ctx)); } else unchanged.push(envFile(ctx)); }
  else if (envChanged) wrote.push(envFile(ctx));
  if (envChanged) result.restartNeeded.push(svc(ctx) + '.service');
  if (sup === 'systemd') {
    const d = dropins(ctx, p);
    const heapChanged = [];
    result.slice = { name: sliceName(ctx), elsewhere: [] };
    for (const [f, text] of Object.entries(sliceFiles(ctx))) {
      if (readText(f) === text) { unchanged.push(f); continue; }
      if (!o.dry) writeAtomic(f, text, 0o644);
      wrote.push(f);
    }
    for (const [unit, x] of Object.entries(d)) {
      const before = readText(x.file);
      if (before === x.text) { unchanged.push(x.file); continue; }
      const oldHeap = before && (/--max-old-space-size=(\d+)/.exec(before) || [])[1];
      if (Number(oldHeap) !== x.heapMB) heapChanged.push(unit);
      if (!o.dry) writeAtomic(x.file, x.text, 0o644);
      wrote.push(x.file);
    }
    if (!o.dry) {
      if (wrote.length) { const r = ctx.systemctl(['daemon-reload']); calls.push(['daemon-reload', r.code]); }
      for (const [unit, x] of Object.entries(d)) {
        const a = ctx.systemctl(['is-active', unit]);
        if (String(a.out || '').trim() !== 'active') continue;
        if (heapChanged.includes(unit) && !result.restartNeeded.includes(unit)) result.restartNeeded.push(unit);
        // live limits only when they cannot stop the unit: the station must already run with OOMPolicy=continue (the
        // drop-in, after daemon-reload), and no unit may already use more than its new MemoryHigh. Otherwise the limits
        // wait for its next start (an empty unit), and the warning says so.
        const now = M.parseShow(ctx.systemctl(['show', '-p', 'OOMPolicy', '-p', 'MemoryCurrent', '-p', 'Slice', unit]).out)[0] || {};
        // a running unit keeps its slice until it restarts (systemd never moves a live cgroup)
        if (now.Slice && now.Slice !== result.slice.name) {
          result.slice.elsewhere.push({ unit, slice: now.Slice });
          if (!result.restartNeeded.includes(unit)) result.restartNeeded.push(unit);
        }
        const curMB = /^\d+$/.test(String(now.MemoryCurrent || '')) ? Math.round(Number(now.MemoryCurrent) / 1048576) : null;
        const lim = p[x.role];
        if (x.role === 'station' && now.OOMPolicy && now.OOMPolicy !== 'continue') {
          calls.push(['set-property', unit, 'skipped: OOMPolicy ' + now.OOMPolicy]);
          result.warnings.push('the new limits on ' + unit + ' wait for its next start: it still runs with OOMPolicy=' + now.OOMPolicy + ', so reaching the limit now would stop every run in it');
          if (!result.restartNeeded.includes(unit)) result.restartNeeded.push(unit);
          continue;
        }
        if (curMB != null && curMB >= lim.highMB) {
          calls.push(['set-property', unit, 'skipped: uses ' + curMB + ' MB']);
          result.warnings.push(unit + ' uses ' + fmtGB(curMB) + ' now, more than its new limit (' + fmtGB(lim.highMB) + ' soft, ' + fmtGB(lim.maxMB) + ' hard); not set now, it applies at its next start');
          if (!result.restartNeeded.includes(unit)) result.restartNeeded.push(unit);
          continue;
        }
        const r = ctx.systemctl(['set-property', '--runtime', unit].concat(x.props)); calls.push(['set-property', unit, r.code]);
        if (r.code !== 0) result.warnings.push('could not set the limits on ' + unit + ' now: ' + String(r.err || '').slice(0, 120) + ' (they apply at its next start)');
      }
      if (!fs.existsSync(path.join(ctx.unitDir, svc(ctx) + '.service'))) result.restartNeeded = result.restartNeeded.filter(u => u !== svc(ctx) + '.service');
    } else for (const u of heapChanged) if (!result.restartNeeded.includes(u)) result.restartNeeded.push(u);
  }
  if (!o.dry) for (const f of wrote) ctx.accept(relOf(ctx, f));
  result.calls = calls;
  if (result.restartNeeded.includes(svc(ctx) + '.service')) result.restartCommand = restartCommand(ctx);
  return result;
}

/* ---------------- set (owner) ---------------- */
function set(ctx, o) {
  const owner = require('./lib/owner');
  if (!owner.isOwnerName(o.by)) return { ok: false, refused: true, error: 'set is the owner\'s: --by owner' };
  if (!ctx.ownerShell()) return { ok: false, refused: true, error: '"--by owner" is accepted ' + owner.REASON };
  const f = path.join(ctx.root, 'company', 'company.json');
  let cfg; try { cfg = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return { ok: false, error: 'company/company.json is missing or not JSON' }; }
  const rt = cfg.runtime = cfg.runtime && typeof cfg.runtime === 'object' ? cfg.runtime : {};
  const m = Object.assign({}, rt.memory || {}); const changed = [];
  if (o.profile !== undefined) { if (!['auto', 'low', 'normal'].includes(o.profile)) return { ok: false, error: '--profile is auto, low or normal' }; m.profile = o.profile; changed.push('profile ' + o.profile); }
  if (o.keepFreeMB !== undefined) { const n = Number(o.keepFreeMB); if (!(Number.isFinite(n) && n >= 0 && n <= 1048576)) return { ok: false, error: '--keep-free is a number of MB, 0 or more' }; m.keepFreeMB = Math.round(n); changed.push('keep free ' + Math.round(n) + ' MB'); }
  if (o.visibleBrowser !== undefined) { m.visibleBrowser = !!o.visibleBrowser; changed.push('station browser ' + (m.visibleBrowser ? 'shown as a window' : 'hidden')); }
  if (!changed.length) return { ok: false, error: 'nothing to set (--profile, --keep-free or --visible-browser)' };
  rt.memory = m;
  const text = JSON.stringify(cfg, null, 2) + '\n';
  const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, text); fs.renameSync(t, f);
  try { require('./provenance.js').wrote(f, text, 'memory.js set (owner)'); } catch (_) {}
  ctx.config = cfg; ctx.share = null;
  const a = apply(ctx, {});
  const total = hostOf(ctx).totalMB;
  if (a.plan.budget <= 1024 && total - (m.keepFreeMB || 0) < 2048) a.warnings.push('this leaves the company very little memory; work may be slow or fail');
  return Object.assign({ ok: true, changed, memory: m }, { apply: a, restartNeeded: a.restartNeeded.length > 0, restartCommand: a.restartCommand || null, warnings: a.warnings });
}

/* ---------------- status ---------------- */
function reaperFreed(root, now) {
  let rows = [];
  try { const B = require('./lib/bounded'); rows = B.tailText(path.join(root, 'company', 'state', 'reaper.jsonl'), 4 * 1048576).split('\n'); } catch (_) {}
  rows = rows.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const win = ms => { const s = rows.filter(r => now - Date.parse(r.at) <= ms); const by = {}; for (const r of s) { by[r.kind] = by[r.kind] || { n: 0, mb: 0 }; by[r.kind].n++; by[r.kind].mb += Number(r.freedMB) || 0; } return { mb: Math.round(s.reduce((a, r) => a + (Number(r.freedMB) || 0), 0)), actions: s.length, byKind: by }; };
  return { day: win(86400e3), week: win(7 * 86400e3), last: rows.slice(-5).reverse().map(r => ({ at: r.at, plain: r.plain, kind: r.kind })) };
}
function localModels(o) {
  // a local AI model on this machine (any uid, read only): shown, never counted as company use, never touched
  const re = /^(ollama|llama-server|llama\.cpp|llama-cli|vllm|lmstudio|lms)$/i; let mb = 0; const names = new Set();
  const procRoot = (o && o.proc) || '/proc';
  let ents = []; try { ents = fs.readdirSync(procRoot); } catch (_) {}
  for (const e of ents) {
    if (!/^\d+$/.test(e)) continue;
    let st; try { st = fs.readFileSync(path.join(procRoot, e, 'status'), 'utf8'); } catch (_) { continue; }
    const n = (/Name:\s+(\S+)/.exec(st) || [])[1] || '';
    if (!re.test(n)) continue;
    names.add(n); mb += Number((/VmRSS:\s+(\d+)/.exec(st) || [])[1] || 0) / 1024;
  }
  return names.size ? { names: [...names], mb: Math.round(mb) } : null;
}
function status(ctx) {
  const h = hostOf(ctx); const p = planFor(ctx);
  const u = M.usage(Object.assign({ root: ctx.root, config: ctx.config, supervisor: ctx.supervisor, systemctl: ctx.systemctl }, ctx.usageOpts));
  const freed = reaperFreed(ctx.root, ctx.now);
  const pressure = readJson(path.join(ctx.root, 'company', 'state', 'memory-pressure.json'), null);
  const reaper = readJson(path.join(ctx.root, 'company', 'state', 'reaper.json'), null);
  const by = r => Object.entries(u.units).filter(([, x]) => x.role === r).reduce((s, [, x]) => s + (x.currentMB || 0), 0);
  const parts = [];
  if (u.supervisor === 'systemd') {
    parts.push('station ' + fmtGB(by('station')));
    if (u.browsers.count) parts.push(u.browsers.count + ' browser' + (u.browsers.count > 1 ? 's' : '') + ' ' + fmtGB(u.browsers.mb));
    parts.push('console ' + fmtGB(by('console')), 'dispatcher ' + fmtGB(by('dispatcher')));
    if (by('service')) parts.push('background services ' + fmtGB(by('service')));
  }
  const model = localModels(ctx.usageOpts);
  const pressureNow = !!(pressure && pressure.since && !pressure.endedAt);
  const recent = !!(pressure && (pressureNow || (pressure.endedAt && ctx.now - Date.parse(pressure.endedAt) < 3600e3)));
  const verdict = pressureNow ? 'Short' : recent ? 'Tight' : 'Fine';
  // the limits in force were planned for another number of companies (one was added or removed since): say so plainly
  const warnings = p.warnings.slice();
  if (u.supervisor === 'systemd') {
    const own = readText(path.join(ctx.unitDir, svc(ctx) + '.service.d', DROPIN));
    const m = own && /companies (\d+)\)/.exec(own);
    const was = m ? Number(m[1]) : own ? 1 : null;
    if (was != null && was !== (p.companies || 1)) warnings.push('the memory limits were set when ' + (was === 1 ? 'this was the only company' : was + ' companies shared') + ' this computer; ' + ((p.companies || 1) === 1 ? 'it is the only one now' : (p.companies || 1) + ' share it now') + '. Save the memory settings again (Settings › System › Memory) to share it fairly.');
  }
  // the company's slice (outside app.slice, systemd-oomd's pressure kill off): which units run in it, which still run
  // elsewhere until their next restart, and whether its drop-ins are there
  let slice = null;
  if (u.supervisor === 'systemd') {
    const name = sliceName(ctx);
    const rows = Object.entries(u.units).filter(([, x]) => x.active);
    slice = { name, pressureKillOff: Object.keys(sliceFiles(ctx)).every(f => readText(f) != null),
      inSlice: rows.filter(([, x]) => x.slice === name).map(([n]) => n), elsewhere: rows.filter(([, x]) => x.slice && x.slice !== name).map(([n, x]) => ({ unit: n, slice: x.slice })) };
  }
  const line = 'The company uses ' + fmtGB(u.totalMB) + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '. ' + fmtGB(h.availableMB) + ' free' + (p.keepFreeMB ? '; ' + fmtGB(p.keepFreeMB) + ' kept for other programs' : '') + '.'
    + (model ? ' Local AI model: ' + fmtGB(model.mb) + '.' : '');
  return { ok: true, at: new Date(ctx.now).toISOString(), line, verdict, host: h, settings: p.settings, profile: p.profile, plan: p, usage: u, freed, pressure, localModel: model,
    reaper: reaper ? { lastRun: reaper.lastRun || null, lastSummary: reaper.lastSummary || null } : null, warnings, planLine: planLine(p),
    sharing: { companies: p.companies || 1, others: (p.others || []).map(c => c.name || c.svc) }, slice };
}

/* The station browser right now (StarNet GET /api/browser/view, this machine's station only, 4 s at most):
   { open, driver, mode, visible } or { unknown: why }. Patch 0020 closes it after runtime.memory's idle minutes. */
async function stationBrowser(ctx) {
  const api = ctx.stationApi || (async (m, p) => {
    // this machine's station only (the same rule as reaper.js stationCall), 4 s at most
    if (ctx.noNetwork) throw new Error('no network in this run');
    const st = ctx.config.station || {};
    const base = process.env.STARNET_URL || st.url || (st.port ? 'http://127.0.0.1:' + st.port : null);   // STARNET_URL wins, as in lib/company.js
    if (!base || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(base)) throw new Error('the station is not on this machine');
    let tok = ''; try { tok = fs.readFileSync(path.join(ctx.root, 'secrets', 'station-token'), 'utf8').trim(); } catch (_) {}
    if (!tok) throw new Error('no station token');
    const r = await fetch(base.replace(/\/$/, '') + p, { method: m, headers: { 'x-starnet-token': tok }, signal: AbortSignal.timeout(4000) });
    return r.json();
  });
  try {
    const v = await api('GET', '/api/browser/view');
    const st = v && v.station;
    if (!st) return { unknown: 'the station did not say' };
    return { open: !!st.open, driver: st.driver ? (st.driver.agentId || 'a run') : null, mode: st.mode || null, visible: !!st.visible };
  } catch (e) { return { unknown: String(e && e.message || e).slice(0, 120) }; }
}
async function statusWithStation(ctx) {
  const r = status(ctx);
  r.station = { browser: await stationBrowser(ctx) };
  return r;
}

/* ---------------- selftest ---------------- */
function selftest() {
  const assert = require('assert');
  const life = require('./lib/temp-life');
  let bad = 0; const ok = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { bad++; console.log('FAIL ' + name + ': ' + (e && e.message || e)); } };
  const T = life.tmpDir('memory-selftest-');
  const root = path.join(T, 'co'); fs.mkdirSync(path.join(root, 'company', 'state'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', '..', 'systemd'), path.join(root, 'systemd'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company', 'company.json'), JSON.stringify({ name: 'Test Co', slug: 'testco', station: { serviceName: 'testco-station', port: 1 } }, null, 2));
  const unitDir = path.join(T, 'config', 'systemd', 'user'); fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'testco-station.service'), '# installed\n');
  const calls = [];
  const fakeSc = args => { calls.push(args.join(' ')); if (args[0] === 'is-active') return { code: 0, out: 'active\n' }; return { code: 0, out: '' }; };
  const accepted = [];
  const mk = (hostMB, extra) => context(Object.assign({ root, unitDir, systemctl: fakeSc, supervisor: 'systemd', host: { totalMB: hostMB, availableMB: hostMB / 2, swapTotalMB: 0, swapUsedMB: 0 }, accept: r => accepted.push(r), ownerShell: () => true }, extra || {}));
  const setMem = m => { const f = path.join(root, 'company', 'company.json'); const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.runtime = { memory: m }; fs.writeFileSync(f, JSON.stringify(c)); };

  ok('plan line is plain', () => { const p = planFor(mk(2048)); assert.strictEqual(planLine(p), 'Memory: low profile for this 2 GB machine; the station may use up to 1.1 GB; 0 MB kept free for other programs.'); });
  ok('apply on a 2 GB machine: three drop-ins, memory.env 0600, daemon-reload, set-property live', () => {
    calls.length = 0;
    const r = apply(mk(2048), {});
    const st = fs.readFileSync(path.join(unitDir, 'testco-station.service.d', DROPIN), 'utf8');
    assert.ok(/MemoryHigh=1152M\nMemoryMax=1152M\nMemorySwapMax=128M\n/.test(st), st);
    const tplExec = /^ExecStart=(.*)$/m.exec(fs.readFileSync(path.join(root, 'systemd', 'capheos-station.service.in'), 'utf8'))[1];
    assert.ok(st.includes('ExecStart=\nExecStart=' + tplExec.replace('node ', 'node --max-old-space-size=384 ') + '\n'), 'station ExecStart = template + heap: ' + st);
    const con = fs.readFileSync(path.join(unitDir, 'testco-station-console.service.d', DROPIN), 'utf8');
    assert.ok(con.includes('ExecStart=/usr/bin/env node --max-old-space-size=128 ' + root + '/console/server.js\n') && /MemoryMax=300M/.test(con), con);
    const dis = fs.readFileSync(path.join(unitDir, 'testco-station-dispatch.service.d', DROPIN), 'utf8');
    assert.ok(/MemoryHigh=512M\nMemoryMax=768M/.test(dis) && dis.includes('node --max-old-space-size=160 ' + root + '/company/tools/dispatcher-loop.js'), 'low: the dispatcher\'s High is above its heap and its ticks\' children: ' + dis);
    assert.ok(/\nManagedOOMMemoryPressure=auto\n/.test(dis) && /\nManagedOOMPreference=omit\n/.test(dis), 'low: systemd-oomd does not kill the dispatcher mid-tick (the slice\'s kill rule skips it too)');
    assert.ok(/\nManagedOOMPreference=omit\n/.test(st), 'the slice\'s oomd kill rule never picks the station: ' + st);
    assert.ok(/^ManagedOOMPreference=omit$/m.test(fs.readFileSync(path.join(root, 'systemd', 'capheos-station.service.in'), 'utf8')), 'the station template says so too');
    assert.ok(/\nOOMPolicy=continue\n/.test(st), 'the station goes on when the kernel ends a build in it: ' + st);
    assert.ok(!/OOMPolicy/.test(con) && !/OOMPolicy/.test(dis) && !/ManagedOOM/.test(con), 'console and dispatcher keep the host\'s OOM policy and oomd');
    const normal = dropins(mk(16384), planFor(mk(16384), { settings: { profile: 'normal' } }));
    assert.ok(!/ManagedOOM/.test(normal['testco-station-dispatch.service'].text) && /ManagedOOMPreference=omit/.test(normal['testco-station.service'].text), 'normal: the dispatcher keeps oomd, the station never');
    assert.ok(/^OOMPolicy=continue$/m.test(fs.readFileSync(path.join(root, 'systemd', 'capheos-station.service.in'), 'utf8')), 'the template says so too');
    const env = path.join(root, '.starnet-data', 'memory.env');
    assert.strictEqual(fs.statSync(env).mode & 0o777, 0o600);
    const et = fs.readFileSync(env, 'utf8');
    for (const k of ['STARNET_BROWSER_HEADLESS=1', 'STARNET_BROWSER_IDLE_MIN=5', 'STARNET_BROWSER_LOWMEM=1', 'STARNET_PRIVATE_BROWSERS_MAX=1', 'STARNET_SHELL_OOM_ADJ=500', 'STARNET_SHELL_REAP_GROUP=1', 'STARNET_BROWSER_OWN_GROUP=1', 'STARNET_MAX_CONCURRENT_AGENTS=2']) assert.ok(et.includes(k + '\n'), k);
    assert.ok(!/CAPHEOS_STATION_HEAP/.test(et));
    assert.ok(calls.includes('daemon-reload'), calls.join('|'));
    assert.ok(calls.includes('set-property --runtime testco-station.service MemoryHigh=1152M MemoryMax=1152M MemorySwapMax=128M ManagedOOMPreference=omit'), calls.join('|'));
    assert.ok(calls.includes('set-property --runtime testco-station-console.service MemoryHigh=160M MemoryMax=300M'), calls.join('|'));
    assert.ok(!calls.some(c => /restart/.test(c)), 'never restarts');
    assert.ok(r.restartNeeded.includes('testco-station.service') && /restart-station\.sh --when-idle/.test(r.restartCommand), JSON.stringify(r.restartNeeded));
    assert.ok(accepted.some(a => /memory\.env$/.test(a)) && accepted.length === 8, 'memory.env, three unit drop-ins, the slice and its three levels\' drop-ins: ' + accepted.join());
    const sl = fs.readFileSync(path.join(unitDir, 'capheos-testco-station.slice.d', DROPIN), 'utf8');
    assert.ok(/\[Slice\]\nManagedOOMMemoryPressure=auto\n/.test(sl) && !/ManagedOOMSwap/.test(sl), 'the slice: pressure kill off, swap rule the host\'s: ' + sl);
    for (const lvl of ['capheos', 'capheos-testco']) assert.ok(/ManagedOOMMemoryPressure=auto/.test(fs.readFileSync(path.join(unitDir, lvl + '.slice.d', DROPIN), 'utf8')), lvl + '.slice: every level above it too');
    assert.ok(/^Description=Test Co: /m.test(fs.readFileSync(path.join(unitDir, 'capheos-testco-station.slice'), 'utf8')));
  });
  ok('apply never sets live limits that could stop a unit: the station on OOMPolicy=stop, a unit already over its new limit', () => {
    setMem({ profile: 'low', keepFreeMB: 1 });   // a changed plan, so the drop-ins are rewritten
    const show = { 'testco-station.service': 'OOMPolicy=stop\nMemoryCurrent=104857600\n', 'testco-station-console.service': 'OOMPolicy=stop\nMemoryCurrent=' + (400 * 1048576) + '\n', 'testco-station-dispatch.service': 'OOMPolicy=stop\nMemoryCurrent=' + (50 * 1048576) + '\n' };
    const sc = args => { calls.push(args.join(' ')); if (args[0] === 'is-active') return { code: 0, out: 'active\n' }; if (args[0] === 'show') return { code: 0, out: show[args[args.length - 1]] || '' }; return { code: 0, out: '' }; };
    calls.length = 0;
    const r = apply(mk(2048, { systemctl: sc }), {});
    assert.ok(!calls.some(c => /^set-property --runtime testco-station\.service /.test(c)), 'station on OOMPolicy=stop: not set live: ' + calls.join('|'));
    assert.ok(!calls.some(c => /^set-property --runtime testco-station-console\.service /.test(c)), 'console uses 400 MB, over its new 160 MB High: not set live');
    assert.ok(calls.some(c => /^set-property --runtime testco-station-dispatch\.service /.test(c)), 'the dispatcher (50 MB, keeps OOMPolicy=stop) is set live');
    assert.ok(r.warnings.some(w => /testco-station\.service.*OOMPolicy=stop/.test(w)) && r.warnings.some(w => /testco-station-console\.service uses 400 MB now/.test(w)), r.warnings.join('|'));
    assert.ok(r.restartNeeded.includes('testco-station.service') && r.restartNeeded.includes('testco-station-console.service'), JSON.stringify(r.restartNeeded));
    show['testco-station.service'] = 'OOMPolicy=continue\nMemoryCurrent=104857600\n';
    setMem({ profile: 'low' }); calls.length = 0; apply(mk(2048, { systemctl: sc }), {});
    assert.ok(calls.some(c => /^set-property --runtime testco-station\.service MemoryHigh=1152M/.test(c)), 'on OOMPolicy=continue and under the limit: set live: ' + calls.join('|'));
    setMem({});
  });
  ok('apply: a running unit still outside the slice moves at its next restart (never restarted here)', () => {
    const sc = args => { calls.push(args.join(' ')); if (args[0] === 'is-active') return { code: 0, out: 'active\n' }; if (args[0] === 'show') return { code: 0, out: 'OOMPolicy=continue\nMemoryCurrent=1048576\nSlice=' + (args[args.length - 1] === 'testco-station.service' ? 'app.slice' : 'capheos-testco-station.slice') + '\n' }; return { code: 0, out: '' }; };
    calls.length = 0; const r = apply(mk(2048, { systemctl: sc }), {});
    assert.deepStrictEqual(r.slice, { name: 'capheos-testco-station.slice', elsewhere: [{ unit: 'testco-station.service', slice: 'app.slice' }] });
    assert.ok(r.restartNeeded.includes('testco-station.service') && !r.restartNeeded.includes('testco-station-console.service') && /restart-station\.sh --when-idle/.test(r.restartCommand), JSON.stringify(r.restartNeeded));
    assert.ok(!calls.some(c => /restart|stop/.test(c)), calls.join('|'));
    const show = 'Id=testco-station.service\nMemoryCurrent=1048576\nMainPID=1\nActiveState=active\nSlice=app.slice\n\nId=testco-station-console.service\nMemoryCurrent=1048576\nMainPID=2\nActiveState=active\nSlice=capheos-testco-station.slice\n';
    const s = status(mk(2048, { systemctl: () => ({ code: 0, out: show }), usageOpts: { browsers: false } }));
    assert.deepStrictEqual(s.slice, { name: 'capheos-testco-station.slice', pressureKillOff: true, inSlice: ['testco-station-console.service'], elsewhere: [{ unit: 'testco-station.service', slice: 'app.slice' }] });
    assert.strictEqual(sliceLine(s.slice), 'slice: capheos-testco-station.slice (outside app.slice; systemd-oomd\'s pressure kill off) · still elsewhere until their next restart: testco-station.service (app.slice)');
  });
  ok('apply again changes nothing and needs no restart', () => {
    calls.length = 0; const r = apply(mk(2048), {});
    assert.strictEqual(r.wrote.length, 0); assert.strictEqual(r.restartNeeded.length, 0); assert.ok(!calls.includes('daemon-reload'));
  });
  ok('the 62 GB row with 16 GB kept free; visible browser drops the headless line', () => {
    setMem({ keepFreeMB: 16384, visibleBrowser: true });
    const r = apply(mk(63488), {});
    const st = fs.readFileSync(path.join(unitDir, 'testco-station.service.d', DROPIN), 'utf8');
    assert.ok(/MemoryHigh=32256M\nMemoryMax=32256M\nMemorySwapMax=4032M/.test(st) && /--max-old-space-size=1024 /.test(st), st);
    const et = fs.readFileSync(path.join(root, '.starnet-data', 'memory.env'), 'utf8');
    assert.ok(!/HEADLESS/.test(et) && /IDLE_MIN=15/.test(et) && /LOWMEM=0/.test(et) && /BROWSERS_MAX=3/.test(et) && !/MAX_CONCURRENT_AGENTS/.test(et), et);
    assert.ok(r.restartNeeded.includes('testco-station.service'), 'heap and env changed');
  });
  ok('--dry-run writes nothing', () => {
    setMem({ profile: 'low' });
    const before = fs.readFileSync(path.join(root, '.starnet-data', 'memory.env'), 'utf8'); calls.length = 0;
    const r = apply(mk(63488), { dry: true });
    assert.strictEqual(fs.readFileSync(path.join(root, '.starnet-data', 'memory.env'), 'utf8'), before);
    assert.ok(r.wrote.length >= 1 && !calls.length, JSON.stringify(r.wrote) + calls.join());
  });
  ok('a container writes only memory.env, with the heap sizes', () => {
    const croot = path.join(T, 'cont'); fs.mkdirSync(path.join(croot, 'company'), { recursive: true });
    fs.writeFileSync(path.join(croot, 'company', 'company.json'), '{"slug":"c"}');
    const cu = path.join(T, 'cont-units'); calls.length = 0;
    const r = apply(context({ root: croot, unitDir: cu, systemctl: fakeSc, supervisor: 'container', host: { totalMB: 2048 }, accept: () => {} }), {});
    assert.ok(!fs.existsSync(cu) && !calls.length, 'no unit dir, no slice, no systemctl in a container');
    assert.strictEqual(status(context({ root: croot, unitDir: cu, systemctl: fakeSc, supervisor: 'container', host: { totalMB: 2048 }, usageOpts: { browsers: false, cgroup: path.join(T, 'nocg') } })).slice, null);
    const et = fs.readFileSync(path.join(croot, '.starnet-data', 'memory.env'), 'utf8');
    assert.ok(/CAPHEOS_STATION_HEAP=384\nCAPHEOS_CONSOLE_HEAP=128\nCAPHEOS_DISPATCH_HEAP=160\n/.test(et), et);
    assert.deepStrictEqual(r.wrote, [path.join(croot, '.starnet-data', 'memory.env')]);
  });
  ok('set: owner only, writes runtime.memory and applies', () => {
    assert.ok(set(mk(8192), { by: 'pm', profile: 'low' }).refused);
    assert.ok(set(mk(8192, { ownerShell: () => false }), { by: 'owner', profile: 'low' }).refused);
    assert.ok(/auto, low or normal/.test(set(mk(8192), { by: 'owner', profile: 'tiny' }).error));
    const r = set(mk(8192), { by: 'owner', profile: 'normal', keepFreeMB: 4096, visibleBrowser: false });
    assert.ok(r.ok && r.memory.keepFreeMB === 4096 && r.memory.profile === 'normal', JSON.stringify(r));
    const c = JSON.parse(fs.readFileSync(path.join(root, 'company', 'company.json'), 'utf8'));
    assert.strictEqual(c.runtime.memory.keepFreeMB, 4096); assert.strictEqual(c.name, 'Test Co', 'the rest of company.json is kept');
    assert.ok(/MemoryHigh=2112M\nMemoryMax=2112M\n/.test(fs.readFileSync(path.join(unitDir, 'testco-station.service.d', DROPIN), 'utf8')), '8 GB with 4 GB kept: budget 3072 MB, high = max 2112');
  });
  ok('status: one plain line, the reaper\'s freed totals, a container\'s cgroup', () => {
    fs.writeFileSync(path.join(root, 'company', 'state', 'reaper.jsonl'), [
      { at: new Date(Date.now() - 3600e3).toISOString(), kind: 'browser', plain: 'Closed a browser left running by a test (4 h old, 835 MB).', freedMB: 835 },
      { at: new Date(Date.now() - 3 * 86400e3).toISOString(), kind: 'temp', plain: 'Removed old temp files (1.1 GB).', freedMB: 1126 }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const show = 'Id=testco-station.service\nMemoryCurrent=943718400\nMemoryPeak=1073741824\nMemoryHigh=infinity\nMemoryMax=infinity\nMainPID=4242\nActiveState=active\n\nId=testco-station-console.service\nMemoryCurrent=94371840\nMemoryPeak=[not set]\nMemoryHigh=infinity\nMemoryMax=infinity\nMainPID=4300\nActiveState=active\n\nId=testco-station-dispatch.service\nMemoryCurrent=62914560\nMainPID=4400\nActiveState=active\n';
    const s = status(mk(8192, { systemctl: () => ({ code: 0, out: show }), usageOpts: { browsers: false } }));
    assert.ok(/^The company uses 1 GB \(station 900 MB, console 90 MB, dispatcher 60 MB\)\. 4 GB free; 4 GB kept for other programs\./.test(s.line), s.line);
    assert.strictEqual(s.freed.day.mb, 835); assert.strictEqual(s.freed.week.mb, 1961); assert.strictEqual(s.verdict, 'Fine');
    const cg = path.join(T, 'cg'); fs.mkdirSync(cg); fs.writeFileSync(path.join(cg, 'memory.current'), String(500 * 1048576)); fs.writeFileSync(path.join(cg, 'memory.max'), 'max\n');
    const u = M.usage({ root, supervisor: 'container', cgroup: cg, browsers: false });
    assert.strictEqual(u.units.container.currentMB, 500); assert.strictEqual(u.units.container.maxMB, null); assert.strictEqual(u.totalMB, 500);
  });
  ok('sample appends one line', () => {
    const row = M.sample({ root, host: { availableMB: 1000, swapUsedMB: 0 }, usage: { units: { 'testco-station.service': { currentMB: 900, pid: 4242 } }, browsers: { count: 0, mb: 0 }, tmp: { mb: 3 } } });
    const lines = fs.readFileSync(M.sampleFile(root), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1); assert.deepStrictEqual(JSON.parse(lines[0]).units, row.units);
  });
  ok('a second company on this machine: an even share, one plain line, status says the limits in force were set for one', () => {
    setMem({});
    apply(mk(63488), {});   // written for one company
    const other = path.join(T, 'other'); fs.mkdirSync(path.join(other, 'company'), { recursive: true });
    fs.writeFileSync(path.join(other, 'company', 'company.json'), JSON.stringify({ name: 'Other Co', station: { serviceName: 'other-station' }, runtime: { memory: { keepFreeMB: 4096 } } }));
    const u = path.join(unitDir, 'other-station.service'); fs.writeFileSync(u, '[Service]\nWorkingDirectory=' + other + '/starnet\nExecStart=/usr/bin/env node sidecar/index.js\n');
    fs.mkdirSync(path.join(unitDir, 'default.target.wants'), { recursive: true }); fs.symlinkSync(u, path.join(unitDir, 'default.target.wants', 'other-station.service'));
    const show = 'Id=testco-station.service\nMemoryCurrent=104857600\nMainPID=1\nActiveState=active\n';
    const s = status(mk(63488, { systemctl: () => ({ code: 0, out: show }), usageOpts: { browsers: false } }));
    assert.strictEqual(s.plan.companies, 2); assert.strictEqual(s.plan.keepFreeMB, 4096, 'the other company keeps 4 GB free for the machine');
    assert.strictEqual(s.planLine, 'Memory: normal profile for this 62 GB machine, shared evenly with 1 other company on it; the station may use up to ' + fmtGB(s.plan.station.maxMB) + '; 4 GB kept free for other programs.');
    assert.deepStrictEqual(s.sharing, { companies: 2, others: ['Other Co'] });
    assert.ok(s.warnings.some(w => /set when this was the only company this computer; 2 share it now\. Save the memory settings again/.test(w)), s.warnings.join('|'));
    const r = apply(mk(63488), {});
    assert.ok(/companies 2\)/.test(fs.readFileSync(path.join(unitDir, 'testco-station.service.d', DROPIN), 'utf8')) && r.plan.station.maxMB === M.floor64(0.7 * Math.floor((63488 - 4096 - 1024) / 2)), JSON.stringify(r.plan.station));
    const s2 = status(mk(63488, { systemctl: () => ({ code: 0, out: show }), usageOpts: { browsers: false } }));
    assert.ok(!s2.warnings.some(w => /share it now/.test(w)), 'applied again: no warning');
    fs.rmSync(path.join(unitDir, 'default.target.wants'), { recursive: true }); fs.rmSync(u);
  });
  life.cleanup();
  console.log(bad ? 'MEMORY SELFTEST FAILED: ' + bad : 'MEMORY SELFTEST PASSED');
  return bad ? 1 : 0;
}

/* ---------------- CLI ---------------- */
function main(argv) {
  const cmd = argv[0] || 'status';
  const val = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const json = argv.includes('--json');
  const print = (r, text) => { if (json) console.log(JSON.stringify(r, null, 1)); else console.log(text(r)); };
  if (cmd === 'selftest' || cmd === '--selftest') return selftest();
  const ctx = context();
  if (cmd === 'status') {
    return statusWithStation(ctx).then(r => {
    const b = r.station.browser;
    const bl = b.unknown ? 'station browser: not known (' + b.unknown + ')' : 'station browser: ' + (b.open ? 'open' + (b.driver ? ', used by ' + b.driver : ', nobody using it') + (b.visible ? ', a window on this computer' : '') : 'closed');
    print(r, s => [s.line, bl].concat(s.slice ? [sliceLine(s.slice)] : []).concat(['profile ' + s.profile + (s.settings.profile === 'auto' ? ' (automatic)' : '') + ' · machine ' + fmtGB(s.host.totalMB) + ' · swap used ' + fmtGB(s.host.swapUsedMB) + (s.host.tmpfsTmp ? ' · /tmp (RAM) ' + fmtGB(s.host.tmpfsTmp.usedMB) + ' used' : ''),
      'freed by the reaper: ' + fmtGB(s.freed.day.mb) + ' in the last day, ' + fmtGB(s.freed.week.mb) + ' in the last week']).concat(s.freed.last.map(x => '  ' + x.at.slice(0, 16) + ' ' + x.plain)).concat(s.warnings.map(w => 'warning: ' + w)).join('\n'));
    return 0;
    });
  }
  if (cmd === 'plan') {
    const over = {}; if (val('total')) over.totalMB = Number(val('total'));
    if (val('profile')) over.settings = { profile: val('profile') };
    if (val('keep-free') !== undefined) over.keepFreeMB = Number(val('keep-free'));
    if (val('companies') !== undefined) over.companies = Number(val('companies'));
    const p = planFor(ctx, over);
    print(p, x => [planLine(x), 'station   heap ' + x.station.heapMB + ' MB, high ' + x.station.highMB + ' MB, max ' + x.station.maxMB + ' MB, swap ' + x.station.swapMaxMB + ' MB',
      'console   heap ' + x.console.heapMB + ' MB, high ' + x.console.highMB + ' MB, max ' + x.console.maxMB + ' MB', 'dispatcher heap ' + x.dispatcher.heapMB + ' MB, high ' + x.dispatcher.highMB + ' MB, max ' + x.dispatcher.maxMB + ' MB',
      'services  default ' + x.services.defaultMax + ', at most ' + x.services.ceiling, 'browsers  ' + x.browsers.privateMax + ' private at once, the station\'s closes after ' + x.browsers.idleMin + ' min unused' + (x.browsers.lowMemFlags ? ', low-memory flags' : ''),
      'reaper    every ' + x.reaper.everyMin + ' min'].concat(x.warnings.map(w => 'warning: ' + w)).join('\n'));
    return 0;
  }
  if (cmd === 'set') {
    const o = { by: val('by') };
    if (val('profile') !== undefined) o.profile = val('profile');
    if (val('keep-free') !== undefined) o.keepFreeMB = val('keep-free');
    if (val('visible-browser') !== undefined) o.visibleBrowser = /^(on|true|yes|1)$/i.test(val('visible-browser'));
    const r = set(ctx, o);
    print(r, x => x.ok ? ['set: ' + x.changed.join(', '), x.apply.line].concat(x.restartNeeded ? ['A restart is needed for all of it to take effect. Safe restart (waits until nothing runs): ' + (x.restartCommand || 'restart the console and dispatcher from Settings › System')] : []).concat(x.warnings.map(w => 'warning: ' + w)).join('\n') : 'not set: ' + x.error);
    return r.ok ? 0 : r.refused ? 3 : 2;
  }
  if (cmd === 'apply') {
    const r = apply(ctx, { dry: argv.includes('--dry-run') });
    print(r, x => [x.line].concat(x.wrote.map(f => (x.dry ? 'would write ' : 'wrote ') + f)).concat(x.slice && x.slice.elsewhere.length ? ['These run outside ' + x.slice.name + ' until their next restart: ' + x.slice.elsewhere.map(e => e.unit + ' (now ' + e.slice + ')').join(', ')] : []).concat(x.restartCommand ? ['The station runs with the old settings until it restarts. Not restarted (that would cut off running work). Safe restart: ' + x.restartCommand] : []).concat(x.warnings.map(w => 'warning: ' + w)).join('\n'));
    return 0;
  }
  if (cmd === 'sample') { const r = M.sample({ root: ctx.root, config: ctx.config, supervisor: ctx.supervisor }); if (json) console.log(JSON.stringify(r)); return 0; }
  console.error('usage: memory.js status|plan|set|apply|sample|selftest (header of company/tools/memory.js)');
  return 2;
}
module.exports = { context, planFor, planLine, sliceLine, sliceFiles, apply, set, status, statusWithStation, stationBrowser, dropins, memEnv, withHeap, templateExec, DROPIN };
if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then(c => { process.exitCode = c; }, e => { console.error(e && e.stack || e); process.exitCode = 2; });
