#!/usr/bin/env node
/* service.js — the crew's sanctioned background services: a recorder or a daily job that runs between agent runs, as a
 * systemd user unit the company registers, names, limits, halts and shows.
 *
 *   node company/tools/service.js propose <name> --kind service|timer --exec "<argv>" [--every 60s|5min|1h | --on-calendar "<spec>"]
 *        --why "..." --by <seat> [--restart on-failure|always] [--timeout 1h] [--success-exit "3"] [--memory 512M] [--cpu 50%]
 *        [--network none] [--soft-halt finish|stop|keep] [--wake <seat>[,<seat>]]
 *        --wake (a timer only): each run's end is recorded like a watched job (company/tools/notify-when.js wraps the
 *        ExecStart and passes its exit code through) and wakes those seats, a failure too; it also satisfies a
 *        `**Waiting on:** service:<name>` line (company/HANDOFFS.md)
 *   node company/tools/service.js list [--json]          every registered service, with its live state (status, schedule, last run, who, why)
 *   node company/tools/service.js status                 the same, in words
 *   node company/tools/service.js stop|start <name> --by <seat>    the seat that asked for it, or the owner
 *   node company/tools/service.js remove <name> --by <seat>        stops it, deletes its unit files, drops it from the register
 *   node company/tools/service.js rerender --by owner     units an older template wrote are written again from this one
 *        (reset and their timers restarted); scripts/setup-station.sh runs it, so a template fix reaches installed units
 *   node company/tools/service.js adopt <unit> --by <owner|seat> [--as <name>] [--seat <seat>] [--why "..."]
 *        a seat's adopt asks the owner once (Today or chat) and adopts on its next run after a yes (exit 4 while waiting);
 *        the owner adopts at once from a shell or Settings › System › Background programs nobody registered
 *        registers a unit made outside this tool. With --as it is rebuilt from the template under the company-scoped name
 *        and the old unit is disabled and its files moved to company/state/services-adopted/; without --as it is only
 *        recorded (the duty keeps flagging its unscoped name)
 *   node company/tools/service.js check-systemctl <args...> | check-systemd-run <args...>   (the PATH shims call these)
 *   node company/tools/service.js --duty                 duty unregistered-services (docs/DUTIES.md): read-only
 *   node company/tools/service.js selftest               offline: temp company, fake systemctl, never the real user manager
 *
 * NAMES. A unit is `<company slug>-svc-<name>` (company/company.json slug), so two companies on one machine never collide.
 * THE ARGV. `--exec` is split like a shell would split plain words, but no shell ever runs it: no ; | & $ ` > < ( ) { } * ?
 * ~ % \ or newline, no sudo/su/doas/pkexec, and its first word is python3, node, bash or sh (the interpreter may take only
 * -I -u -B -O -s -E for python3, nothing for the others; never -c, -e or -m). The second word is the script: a file inside
 * company/work/ or company/tools/ of this company (by its real path), with a matching extension (.py, .js/.mjs/.cjs,
 * .sh). Every later word that is a path (starts with /, or holds a .. segment) must be inside the company folder.
 * THE TEMPLATE. WorkingDirectory=the company folder; Restart=on-failure (or always, declared) with a start limit;
 * MemoryMax (default 512M, at most 4G), CPUQuota (default 50%, at most 200%), TasksMax=64, Nice=10, NoNewPrivileges.
 * Network is open unless the proposal declares --network none (RestrictAddressFamilies=AF_UNIX). A timer runs its service
 * as a oneshot. The unit files carry X-CaPheOS-* lines naming the company, the folder and the service.
 *
 * GOVERNANCE. A new service is a `localComputer` decision. With that guardrail ON it always waits for the owner: a typed
 * owner question (Approve / Decline) showing the name, the command, the schedule, the limits and why. With it OFF it follows
 * the `schedules` self-governance level (auto, notify, triage or approve). `propose` is idempotent: run it again after the
 * owner answers and it installs. Start and stop of an approved service belong to the seat that asked for it (and the
 * owner); a --by claim made from somebody else's run is refused (provenance.js callerConflict). adopt is the owner's.
 *
 * HALT (company/tools/halt.js calls onHalt() whenever it writes halt.json). Soft: timers stop firing new jobs, a run in
 * progress finishes; a long-running service is stopped gracefully (SIGTERM, 90 s to finish its step) unless it declared
 * --soft-halt keep (it then runs through a soft halt), or --soft-halt stop. Hard: every registered unit is stopped now.
 * Resume starts exactly what was running when the halt began. A service started while halted waits for the resume.
 *
 * THE REGISTER. company/state/services.json: locked-watch policy tier (class F), writers service.js and halt.js (which
 * calls in), every write recorded with provenance.js. Each change is one row in company/state/services-log.jsonl.
 *
 * THE GUARDRAIL GAP this closes. Agents run on full approval (station-seed.js), which in StarNet is per-agent Full Power:
 * the station's own command floor (it refuses systemctl, crontab, kill ...) does not apply to them, so with localComputer
 * ON a seat could still `cat > ~/.config/systemd/user/x.service` and `systemctl --user enable --now x`. Now:
 *   - refused: company/tools/shims/systemctl and shims/systemd-run sit first on the station's PATH (scripts/setup-station.sh
 *     writes it into the station env file); for an agent caller with localComputer ON, a systemctl --user verb that
 *     changes units (enable, start, restart, daemon-reload, link, edit, mask, ...) and any systemd-run --user exit 3 with
 *     the route through this tool. Read-only verbs pass. OFF: allowed and logged as UNGUARDED. An absolute /usr/bin path
 *     skips a shim (the same limit as the merge gate's wrappers), which is why there is also:
 *   - flagged: the duty below finds every unit whose ExecStart or WorkingDirectory is inside this company folder but is
 *     not registered (including transient systemd-run units), every registered unit edited by hand, and every registered
 *     service whose runs fail (3 failed runs in the last hour by its journal, or any for a halt-related service), routed to
 *     the seat that asked for it.
 * Env (tests only): SERVICE_SYSTEMCTL (the systemctl this tool runs; default /usr/bin/systemctl), SERVICE_UNIT_DIR,
 * SERVICE_TRANSIENT_DIR, SERVICE_REAL_SYSTEMCTL / SERVICE_REAL_SYSTEMD_RUN (what a shim passes through to).
 * Exit: 0 ok, 1 error, 2 bad usage or input, 3 refused, 4 waiting for the owner. Owner of this tool: the risk function.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const co = require('./lib/company');

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const META = /[;|&$`<>(){}*?~%\\\n\r\t'"!#^[\]]/;   // after quote handling, a word may hold none of these
const INTERPS = { python3: { ext: /\.py$/, flags: ['-I', '-u', '-B', '-O', '-s', '-E'] }, node: { ext: /\.(js|mjs|cjs)$/, flags: [] },
  bash: { ext: /\.sh$/, flags: [] }, sh: { ext: /\.sh$/, flags: [] } };
const PRIV = /^(sudo|su|doas|pkexec|runuser|setpriv|chroot|nsenter)$/;
const SCRIPT_DIRS = [['company', 'work'], ['company', 'tools']];
const MUTATING = new Set(['start', 'stop', 'restart', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'reload', 'enable', 'disable',
  'reenable', 'preset', 'preset-all', 'link', 'revert', 'edit', 'mask', 'unmask', 'daemon-reload', 'daemon-reexec', 'set-property', 'kill',
  'isolate', 'add-wants', 'add-requires', 'set-environment', 'unset-environment', 'import-environment', 'clean', 'freeze', 'thaw', 'bind', 'mount-image']);
const err = (msg, code) => Object.assign(new Error(msg), { code: code || 2 });

/* ---------------- context (selftests pass a temp root and a fake systemctl) ---------------- */
function context(o) {
  o = o || {};
  const root = path.resolve(o.root || co.ROOT);
  const P = (...a) => path.join(root, ...a);
  const config = co.readJson(P('company', 'company.json'), {}) || {};
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    root, config, P,
    slug: String(config.slug || config.shortName || 'company').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'company',
    stationSvc: String((config.station && config.station.serviceName) || 'capheos-station'),
    file: P('company', 'state', 'services.json'), log: P('company', 'state', 'services-log.jsonl'), adoptedDir: P('company', 'state', 'services-adopted'),
    unitDir: o.unitDir || process.env.SERVICE_UNIT_DIR || path.join(os.homedir(), '.config', 'systemd', 'user'),
    transientDir: o.transientDir || process.env.SERVICE_TRANSIENT_DIR || path.join(process.env.XDG_RUNTIME_DIR || '/run/user/' + uid, 'systemd', 'transient'),
    systemctl: o.systemctl || realSystemctl,
    journal: o.journal || realJournal,
    now: o.now || (() => Date.now()),
    isAgent: o.isAgent || (() => require('./lib/guardrails').isAgentCaller()),
    ownerShell: o.ownerShell || (() => require('./lib/owner').shell()),   // the one owner rule (lib/owner.js)
    guard: o.guard || (name => require('./lib/guardrails').guardIn(root, name)),
    halted: o.halted || (() => { const m = (co.readJson(P('company', 'state', 'halt.json'), {}) || {}).mode; return m === 'soft' || m === 'hard' ? m : false; }),
    gov: o.gov || { root },
    callerConflict: o.callerConflict || ((parts, id) => { try { return require('./provenance.js').callerConflict(root, parts, id); } catch (_) { return null; } }),
    crew: o.crew || (() => (co.readJson(P('company', 'tools', 'loops.json'), {}) || {}).agents || {}),
  };
}
// the real systemctl, by absolute path (never the shim on PATH); returns {code, out}
function realSystemctl(args) {
  const bin = process.env.SERVICE_SYSTEMCTL || '/usr/bin/systemctl';
  try { return { code: 0, out: execFileSync(bin, ['--user'].concat(args), { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: typeof e.status === 'number' ? e.status : 1, out: String(e.stdout || ''), err: String(e.stderr || e.message || '').slice(0, 300) }; }
}

// a unit's journal for the last hour, read only (the failing-service check); '' when it cannot be read
function realJournal(unit, sinceSec) {
  try { return execFileSync(process.env.SERVICE_JOURNALCTL || '/usr/bin/journalctl', ['--user', '-u', unit, '--since', '-' + Math.round(sinceSec) + 's', '-o', 'cat', '--no-pager'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 << 20 }); }
  catch (_) { return ''; }
}

/* ---------------- the register ---------------- */
function read(ctx) {
  const d = co.readJson(ctx.file, null);
  const doc = d && typeof d === 'object' ? d : {};
  doc.services = doc.services && typeof doc.services === 'object' ? doc.services : {};
  return doc;
}
function write(ctx, doc) {
  doc._doc = 'The company\'s registered background services (systemd user units). Written only by company/tools/service.js (and halt.js through it); locked-watch reports any other edit. Read it with `node company/tools/service.js list`.';
  doc.company = ctx.slug;
  const text = JSON.stringify(doc, null, 1) + '\n';
  fs.mkdirSync(path.dirname(ctx.file), { recursive: true });
  const tmp = ctx.file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, ctx.file);
  try { require('./provenance.js').wrote(ctx.file, text, 'service.js'); } catch (_) {}
  return doc;
}
function logRow(ctx, row) {
  const line = JSON.stringify(Object.assign({ at: new Date(ctx.now()).toISOString() }, row)) + '\n';
  try { fs.mkdirSync(path.dirname(ctx.log), { recursive: true }); fs.appendFileSync(ctx.log, line); try { require('./provenance.js').appended(ctx.log, line, 'service.js'); } catch (_) {} } catch (_) {}
}
const unitOf = (ctx, name) => ctx.slug + '-svc-' + name;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);

/* ---------------- argv ---------------- */
function splitWords(s) {
  const out = []; let cur = null, q = null;
  for (const ch of String(s || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur = cur == null ? '' : cur; continue; }
    if (/\s/.test(ch)) { if (cur != null) { out.push(cur); cur = null; } continue; }
    cur = (cur == null ? '' : cur) + ch;
  }
  if (q) throw err('--exec has an unclosed quote');
  if (cur != null) out.push(cur);
  return out;
}
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
function which(name) {
  const shim = path.join(__dirname, 'shims');
  for (const d of String(process.env.PATH || '').split(':').concat(['/usr/local/bin', '/usr/bin', '/bin'])) {
    if (!d || path.resolve(d) === shim) continue;
    const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) {}
  }
  return null;
}
/* validateArgv(ctx, words) -> absolute argv for ExecStart, or throws code 2 with the reason */
function validateArgv(ctx, words, opts) {
  opts = opts || {};
  if (!Array.isArray(words) || !words.length) throw err('--exec is required: the interpreter, the script and its arguments');
  if (words.length > 40) throw err('--exec has too many words (at most 40)');
  for (const w of words) {
    if (!w.length) throw err('--exec has an empty word');
    if (w.length > 300) throw err('--exec has a word over 300 characters');
    if (META.test(w)) throw err('--exec may not hold shell syntax (' + JSON.stringify(w.slice(0, 40)) + '): it is not run by a shell; give plain words');
    if (PRIV.test(path.basename(w))) throw err('--exec may not use ' + path.basename(w) + ': a company service runs as the company\'s own user, never with more rights');
  }
  let i = 0; const a0 = words[0];
  const base = path.basename(a0).replace(/^(python3)\.\d+$/, '$1');
  const spec = INTERPS[base];
  if (!spec) throw err('--exec must start with python3, node, bash or sh (a company script run by its interpreter), not ' + JSON.stringify(a0.slice(0, 60)));
  if (path.isAbsolute(a0) && !/^\/(usr\/(local\/)?)?bin\//.test(a0)) throw err('the interpreter must be the system one (/usr/bin, /usr/local/bin or /bin), or just its name');
  const interp = path.isAbsolute(a0) ? a0 : (opts.resolve === false ? '/usr/bin/' + a0 : (which(a0) || '/usr/bin/' + a0));
  const out = [interp]; i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    if (!spec.flags.includes(words[i])) throw err('the interpreter flag ' + words[i] + ' is not allowed (' + base + ' may take ' + (spec.flags.join(' ') || 'none') + '; never -c, -e or -m: the service runs a script file)');
    out.push(words[i]); i++;
  }
  const s = words[i];
  if (!s) throw err('--exec names no script: after the interpreter comes a file under company/work/ or company/tools/');
  const abs = path.resolve(ctx.root, s);
  let real; try { real = fs.realpathSync(abs); } catch (_) { throw err('the script ' + s + ' does not exist in this company'); }
  const rootReal = fs.realpathSync(ctx.root);
  if (!SCRIPT_DIRS.some(d => inside(real, path.join(rootReal, ...d)))) throw err('the script must be a file under company/work/ or company/tools/ of this company (by its real path), not ' + s);
  if (!fs.statSync(real).isFile()) throw err('the script ' + s + ' is not a file');
  if (!spec.ext.test(real)) throw err('the script ' + s + ' does not look like a ' + base + ' script (' + spec.ext + ')');
  out.push(abs); i++;
  for (; i < words.length; i++) {
    const w = words[i]; const val = w.includes('=') && w.startsWith('-') ? w.slice(w.indexOf('=') + 1) : w;
    const isPath = val.startsWith('/') || val.split('/').includes('..');
    if (isPath) {
      const p = path.resolve(ctx.root, val);
      if (!inside(p, ctx.root) && !inside(p, rootReal)) throw err('the argument ' + JSON.stringify(w.slice(0, 80)) + ' points outside the company folder');
    }
    out.push(w);
  }
  return out;
}
const execLine = argv => argv.map(a => '"' + a + '"').join(' ');

/* ---------------- schedule and limits ---------------- */
function duration(s, what, minSec, maxSec) {
  const m = String(s || '').trim().match(/^(\d+)\s*(s|sec|m|min|h|d)$/i);
  if (!m) throw err(what + ' must look like 60s, 5min, 1h or 1d');
  const n = Number(m[1]) * ({ s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400 })[m[2].toLowerCase()];
  if (n < minSec || n > maxSec) throw err(what + ' must be between ' + minSec + ' s and ' + maxSec + ' s');
  return n;
}
const secs = n => n % 86400 === 0 ? (n / 86400) + 'd' : n % 3600 === 0 ? (n / 3600) + 'h' : n % 60 === 0 ? (n / 60) + 'min' : n + 's';
function scheduleOf(kind, o) {
  if (kind === 'service') { if (o.every || o['on-calendar']) throw err('a service runs all the time; --every and --on-calendar are for --kind timer'); return null; }
  if (o.every && o['on-calendar']) throw err('give --every or --on-calendar, not both');
  if (o.every) return { every: secs(duration(o.every, '--every', 30, 7 * 86400)) };
  const c = String(o['on-calendar'] || '').trim();
  if (!c) throw err('a timer needs --every (60s, 5min, 1h) or --on-calendar ("*-*-* 17:30:00 UTC")');
  if (!/^[A-Za-z0-9*:,.\/~ _+-]{1,80}$/.test(c)) throw err('--on-calendar may hold only a systemd calendar spec (letters, digits, * : , . / ~ - + and spaces)');
  return { onCalendar: c };
}
function limitsOf(o) {
  const mem = String(o.memory || '512M').toUpperCase();
  const mm = mem.match(/^(\d+)(K|M|G)$/); if (!mm) throw err('--memory must look like 256M or 1G');
  const bytes = Number(mm[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 })[mm[2]];
  if (bytes < 16 * 1024 ** 2 || bytes > 4 * 1024 ** 3) throw err('--memory must be between 16M and 4G');
  const cpu = String(o.cpu || '50%'); const cm = cpu.match(/^(\d+)%$/); if (!cm || Number(cm[1]) < 1 || Number(cm[1]) > 200) throw err('--cpu must be 1% to 200%');
  return { memoryMax: mem, cpuQuota: cpu };
}
function specOf(ctx, name, o, opts) {
  if (!NAME_RE.test(String(name || ''))) throw err('the name must be 2-31 lowercase letters, digits or dashes, starting with a letter');
  const kind = String(o.kind || '');
  if (!['service', 'timer'].includes(kind)) throw err('--kind must be service (runs all the time) or timer (runs on a schedule)');
  const words = Array.isArray(o.argv) ? o.argv : splitWords(o.exec);
  const argv = validateArgv(ctx, words, opts);
  const why = String(o.why || '').replace(/\s+/g, ' ').trim();
  if (why.length < 10) throw err('--why is required: in a sentence, what it is for and why it must run between agent runs');
  const restart = String(o.restart || 'on-failure'); if (!['on-failure', 'always'].includes(restart)) throw err('--restart is on-failure or always');
  const softHalt = String(o['soft-halt'] || 'finish'); if (!['finish', 'stop', 'keep'].includes(softHalt)) throw err('--soft-halt is finish, stop or keep');
  if (kind === 'timer' && softHalt === 'keep') throw err('--soft-halt keep is for a long-running service; a timer stops firing in a soft halt');
  const network = o.network == null || o.network === 'on' ? true : o.network === 'none' ? false : (() => { throw err('--network is none (no network) or left out'); })();
  const timeout = o.timeout ? secs(duration(o.timeout, '--timeout', 10, 6 * 3600)) : null;
  const successExit = o['success-exit'] ? String(o['success-exit']).trim() : null;
  if (successExit && !/^\d{1,3}( \d{1,3}){0,7}$/.test(successExit)) throw err('--success-exit is exit codes separated by spaces, e.g. "3"');
  let wake = null;
  if (o.wake != null && o.wake !== false) {
    if (kind !== 'timer') throw err('--wake is for a timer: a run that ends is what wakes the seats');
    const crew = ctx.crew(); wake = [];
    for (const w of String(o.wake).split(',').map(x => x.trim()).filter(Boolean)) {
      const id = crew[w] ? w : Object.keys(crew).find(k => { const n = String((crew[k] || {}).name || '').toLowerCase(); return n === w.toLowerCase() || n.split(/\s+/)[0] === w.toLowerCase(); });
      if (!id) throw err('--wake: no seat "' + w + '" in company/tools/loops.json');
      if (!wake.includes(id)) wake.push(id);
    }
    if (!wake.length) throw err('--wake names the seats to wake, e.g. --wake rohan');
  }
  return Object.assign({ name, unit: unitOf(ctx, name), kind, argv, schedule: scheduleOf(kind, o), why: why.slice(0, 400), restart, softHalt, network, limits: limitsOf(o), timeout, successExit }, wake ? { wake } : {});
}
const specKey = s => sha(JSON.stringify([s.kind, s.argv, s.schedule, s.restart, s.softHalt, s.network, s.limits, s.timeout, s.successExit].concat(s.wake && s.wake.length ? [s.wake] : [])));
// a timer with --wake runs through notify-when.js (company/tools), which records the run's end and passes its exit code on
const execArgv = (ctx, e) => e.wake && e.wake.length ? [which('node') || process.execPath, path.join(ctx.root, 'company', 'tools', 'notify-when.js'), '--service-run', e.name, '--seat', e.wake.join(','), '--'].concat(e.argv) : e.argv;
const scheduleWords = s => !s ? 'runs all the time' : s.every ? 'every ' + s.every : 'on the calendar ' + s.onCalendar;

/* ---------------- unit files ---------------- */
/* Start limit: systemd allows StartLimitBurst starts per StartLimitIntervalSec, and a timer's own activations count
 * against it, so 5 per 10 min turns a timer that fires every minute into one that runs half the time (5 starts, then
 * start-limit-hit until the window expires, while the timer reads active). A timer's oneshot has no Restart= and gets one
 * start per firing, so it cannot crash-loop: timers get no start limit. A long-running service (Restart=on-failure)
 * keeps the 5-per-10-min guard it exists for. */
const startLimit = e => e.kind === 'timer' ? 'StartLimitIntervalSec=0\n' : 'StartLimitIntervalSec=10min\nStartLimitBurst=5\n';
function render(ctx, e) {
  const head = '# Written by company/tools/service.js for ' + (ctx.config.name || ctx.slug) + '. Change it with service.js, not by hand: a hand edit is flagged.\n';
  const x = 'X-CaPheOS-Company=' + ctx.slug + '\nX-CaPheOS-Root=' + ctx.root + '\nX-CaPheOS-Service=' + e.name + '\n';
  const svc = head + '[Unit]\nDescription=' + (ctx.config.name || ctx.slug) + ' background service ' + e.name + '\n'
    + 'Documentation=file:' + path.join(ctx.root, 'company', 'state', 'services.json') + '\n'
    + startLimit(e) + x + '\n[Service]\n'
    + 'Type=' + (e.kind === 'timer' ? 'oneshot' : 'simple') + '\n'
    + 'WorkingDirectory=' + ctx.root + '\n'
    + 'ExecStart=' + execLine(execArgv(ctx, e)) + '\n'
    + 'Environment=CAPHEOS_ROOT=' + ctx.root + ' CAPHEOS_SERVICE=' + e.name + '\n'
    + (e.kind === 'timer' ? '' : 'Restart=' + e.restart + '\nRestartSec=10s\n')
    + (e.timeout ? 'TimeoutStartSec=' + e.timeout + '\n' : '')
    + (e.successExit ? 'SuccessExitStatus=' + e.successExit + '\n' : '')
    + 'TimeoutStopSec=90s\nMemoryMax=' + e.limits.memoryMax + '\nCPUQuota=' + e.limits.cpuQuota + '\nTasksMax=64\nNice=10\nNoNewPrivileges=yes\n'
    + (e.network ? '' : 'RestrictAddressFamilies=AF_UNIX\n')
    + (e.kind === 'timer' ? '' : '\n[Install]\nWantedBy=default.target\n');
  if (e.kind !== 'timer') return { [e.unit + '.service']: svc };
  const s = e.schedule || {};
  const tmr = head + '[Unit]\nDescription=' + (ctx.config.name || ctx.slug) + ' background service ' + e.name + ': ' + scheduleWords(s) + '\n' + x + '\n[Timer]\n'
    + (s.every ? 'OnBootSec=' + s.every + '\nOnUnitActiveSec=' + s.every + '\nAccuracySec=1s\n' : 'OnCalendar=' + s.onCalendar + '\nPersistent=true\n')
    + 'Unit=' + e.unit + '.service\n\n[Install]\nWantedBy=timers.target\n';
  return { [e.unit + '.service']: svc, [e.unit + '.timer']: tmr };
}
function writeUnits(ctx, e) {
  const files = render(ctx, e);
  fs.mkdirSync(ctx.unitDir, { recursive: true });
  e.files = {};
  for (const [f, text] of Object.entries(files)) { fs.writeFileSync(path.join(ctx.unitDir, f), text); e.files[f] = sha(text); }
  return files;
}
const mainUnit = e => e.unit + (e.kind === 'timer' ? '.timer' : '.service');
function sc(ctx, args, e) {
  const r = ctx.systemctl(args);
  if (r.code !== 0 && e) e.lastError = ('systemctl ' + args.join(' ') + ': exit ' + r.code + ' ' + (r.err || '')).slice(0, 300);
  return r;
}
function isActive(ctx, unit) { return String(ctx.systemctl(['is-active', unit]).out || '').trim() === 'active'; }

/* ---------------- who may ---------------- */
function isOwner(ctx, by) {
  const b = String(by || '').trim().toLowerCase();
  const own = String((ctx.config.owner && ctx.config.owner.name) || '').trim().toLowerCase();
  return !!b && (b === 'owner' || (own && b === own)) && !ctx.isAgent() && !!ctx.ownerShell();
}
function seatOf(ctx, by) {
  const c = ctx.crew(); const b = String(by || '').trim();
  if (c[b]) return b;
  const hit = Object.keys(c).find(id => String((c[id] && c[id].name) || '').toLowerCase() === b.toLowerCase());
  return hit || null;
}
function actor(ctx, by, cmd, name) {
  if (!by) throw err('--by <seat> is required');
  if (isOwner(ctx, by)) return { owner: true, seat: null, name: (ctx.config.owner && ctx.config.owner.name) || 'Owner' };
  const lb = String(by).trim().toLowerCase();
  if (lb === 'owner' || lb === String((ctx.config.owner && ctx.config.owner.name) || '').toLowerCase()) throw err('--by ' + by + ' is the owner\'s name; it is accepted ' + require('./lib/owner').REASON, 3);
  const seat = seatOf(ctx, by);
  if (!seat) throw err('--by ' + by + ' is not a seat in company/tools/loops.json', 2);
  const clash = ctx.callerConflict(['service.js', cmd, name].filter(Boolean), seat);
  if (clash) throw err('--by ' + by + ' does not match who ran this (' + clash.agentId + '); refused', 3);
  return { owner: false, seat, name: (ctx.crew()[seat] || {}).name || seat };
}

/* ---------------- the owner question (typed) ---------------- */
function newQid(ctx) {
  const gov = require('./lib/governance');
  const used = new Set(gov.readLines(gov.files(ctx.gov).inbox).map(r => r.id));
  let n = Number(String(ctx.now()).slice(-6)); let id;
  do { id = 'q-' + String(n).padStart(6, '0'); n = (n + 1) % 1e6; } while (used.has(id));
  return id;
}
function askOwner(ctx, e, who, ref, why) {
  const gov = require('./lib/governance');
  const { normalizeForm } = require('./inbox.js');
  const sched = scheduleWords(e.schedule);
  const cmd = e.argv.map(a => a.startsWith(ctx.root + '/') ? a.slice(ctx.root.length + 1) : a).join(' ');
  const facts = ['**Name:** ' + e.name + ' (the computer calls it ' + e.unit + ')', '**What it runs:** `' + cmd + '`', '**When:** ' + sched,
    '**Why:** ' + e.why, '**Asked by:** ' + who.name, '**Limits:** at most ' + e.limits.memoryMax + ' of memory and ' + e.limits.cpuQuota + ' of one processor; '
      + (e.network ? 'it may use the network' : 'no network') + '; it restarts ' + (e.kind === 'timer' ? 'never (it runs once per turn)' : e.restart === 'always' ? 'whenever it stops' : 'if it fails'),
    '**In a soft halt:** ' + (e.kind === 'timer' ? 'it stops firing; a run in progress finishes' : e.softHalt === 'keep' ? 'it keeps running (a hard halt stops it)' : 'it is asked to finish and stop'),
    '**You can stop or remove it any time** in Settings › System › Background services.'].join('\n');
  const form = normalizeForm({ fields: [{ id: 'facts', type: 'info', text: facts }, { id: 'reason', type: 'text', multiline: true, label: 'Reason (optional)', required: false }],
    actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true }, { id: 'decline', label: 'Decline', verdict: 'no' }] });
  const id = newQid(ctx);
  const message = (who.name + ' wants to run "' + e.name + '" in the background on this computer, ' + sched + ', so it keeps going between their working sessions. '
    + 'It is limited to the company folder and can be stopped from Settings. If you decline or do not answer, nothing is installed.').slice(0, 600);
  const row = { type: 'ask', id, at: new Date(ctx.now()).toISOString(), from: who.name, about: 'service:' + e.name, kind: 'form', form, message, details: facts,
    q: message + '\n\n' + facts, blocking: false, batch: 'gate',
    gate: { category: why, ref, by: who.seat || 'owner', summary: 'run the background service ' + e.name + ' (' + sched + ')', recommendation: null, default: 'nothing is installed' } };
  // recorded in the provenance log first (lib/pm-inbox-guard.js), so every reader trusts the question
  require('./lib/pm-inbox-guard').append(gov.files(ctx.gov).inbox, row, 'service.js');
  return row;
}
// may this proposal go ahead? -> {allowed, waiting?, denied?, questionId?, level, via}
function decision(ctx, e, who, ref) {
  const gov = require('./lib/governance');
  if (who.owner) return { allowed: true, level: 'owner', via: 'owner' };
  const lcOn = ctx.guard('localComputer');
  const level = lcOn ? 'approve' : gov.level('schedules', Object.assign({ triage: true }, ctx.gov));
  if (!lcOn && level !== 'approve') {
    const d = gov.decide('schedules', { by: who.name, summary: 'run the background service ' + e.name + ' (' + scheduleWords(e.schedule) + '): ' + e.why.slice(0, 120), ref,
      recommendation: 'yes', default: 'nothing is installed' }, ctx.gov);
    return { allowed: !!d.allowed, waiting: !d.allowed && !d.denied, denied: !!d.denied, questionId: d.questionId || null, level: d.level, via: 'schedules ' + d.level + ' (localComputer guardrail off)' };
  }
  const q = gov.questionFor(ref, ctx.gov);
  if (q) {
    const a = gov.approved(ref, ctx.gov);
    if (a === true) return { allowed: true, level: 'approve', questionId: q.id, via: (lcOn ? 'localComputer guardrail on' : 'schedules approve') + ': owner said yes to ' + q.id };
    if (a === false) return { allowed: false, denied: true, level: 'approve', questionId: q.id };
    const closed = gov.inboxRows(ctx.gov).some(r => r.id === q.id && (r.type === 'close' || r.type === 'reclassify'));
    if (!closed) return { allowed: false, waiting: true, level: 'approve', questionId: q.id };
  }
  const row = askOwner(ctx, e, who, ref, lcOn ? 'localComputer' : 'schedules');
  return { allowed: false, waiting: true, level: 'approve', questionId: row.id, asked: true };
}

/* ---------------- install / start / stop ---------------- */
function install(ctx, e, doc) {
  writeUnits(ctx, e);
  sc(ctx, ['daemon-reload'], e);
  const halted = ctx.halted();
  sc(ctx, ['enable', mainUnit(e)], e);
  if (halted) { e.halt = { mode: halted, at: new Date(ctx.now()).toISOString(), wasRunning: true, note: 'installed during a halt: starts on resume' }; }
  else sc(ctx, ['start', mainUnit(e)], e);
  e.status = 'installed'; e.installedAt = new Date(ctx.now()).toISOString(); e.desired = 'running';
  doc.services[e.name] = e;
  return e;
}
function propose(ctx, name, o) {
  const who = actor(ctx, o.by, 'propose', name);
  const spec = specOf(ctx, name, o);
  const doc = read(ctx);
  const old = doc.services[name];
  const key = specKey(spec);
  if (old && old.status === 'installed') {
    if (old.specKey === key) return { ok: true, already: true, name, unit: old.unit, status: old.status };
    throw err('"' + name + '" is already installed with a different command or schedule; remove it first, or propose a new name', 2);
  }
  const ref = 'service:' + name + ':' + key;
  const d = decision(ctx, spec, who, ref);
  const e = Object.assign({}, spec, { specKey: key, by: who.seat || 'owner', byName: who.name, proposedAt: (old && old.specKey === key && old.proposedAt) || new Date(ctx.now()).toISOString(),
    approval: { level: d.level, questionId: d.questionId || null, via: d.via || null, guardrail: ctx.guard('localComputer') ? 'on' : 'off' } });
  if (d.denied) { e.status = 'declined'; doc.services[name] = e; write(ctx, doc); logRow(ctx, { event: 'declined', name, by: e.by, questionId: d.questionId });
    throw err('the owner said no to ' + d.questionId + '; "' + name + '" is not installed', 3); }
  if (!d.allowed) {
    e.status = 'proposed'; doc.services[name] = e; write(ctx, doc);
    if (d.asked) logRow(ctx, { event: 'proposed', name, by: e.by, questionId: d.questionId, argv: e.argv, schedule: e.schedule });
    return { ok: true, waiting: true, name, unit: e.unit, questionId: d.questionId, text: 'Asked the owner (' + d.questionId + '). Run the same propose again after they answer yes; it then installs.' };
  }
  e.approval.at = new Date(ctx.now()).toISOString();
  install(ctx, e, doc);
  write(ctx, doc);
  logRow(ctx, { event: 'installed', name, unit: e.unit, by: e.by, via: e.approval.via, argv: e.argv, schedule: e.schedule });
  return { ok: !e.lastError, name, unit: e.unit, status: e.status, halted: !!e.halt, error: e.lastError || undefined };
}
function mayControl(ctx, e, by, cmd) {
  const who = actor(ctx, by, cmd, e.name);
  if (who.owner || who.seat === e.by) return who;
  throw err(cmd + ' "' + e.name + '" belongs to ' + (e.byName || e.by) + ' (who asked for it) or the owner', 3);
}
function entry(doc, name) { const e = doc.services[name]; if (!e) throw err('no registered service "' + name + '" (service.js list)', 2); return e; }
function startStop(ctx, cmd, name, o) {
  const doc = read(ctx); const e = entry(doc, name);
  const who = mayControl(ctx, e, o.by, cmd);
  if (e.status !== 'installed') throw err('"' + name + '" is ' + e.status + ', not installed', 2);
  delete e.lastError;
  if (cmd === 'start') {
    const h = ctx.halted();
    if (h) { e.halt = Object.assign({}, e.halt || { mode: h, at: new Date(ctx.now()).toISOString() }, { wasRunning: true }); e.desired = 'running'; write(ctx, doc);
      return { ok: true, name, waiting: true, text: 'The company is ' + h + '-halted; "' + name + '" starts when it resumes.' }; }
    sc(ctx, ['start', mainUnit(e)], e); e.desired = 'running';
  } else {
    const units = e.kind === 'timer' ? [e.unit + '.timer', e.unit + '.service'] : [e.unit + '.service'];
    sc(ctx, ['stop'].concat(units), e); e.desired = 'stopped';
    if (e.halt) e.halt.wasRunning = false;
  }
  e.lastControl = { cmd, by: who.seat || 'owner', at: new Date(ctx.now()).toISOString() };
  write(ctx, doc); logRow(ctx, { event: cmd, name, by: who.seat || 'owner' });
  return { ok: !e.lastError, name, done: cmd, error: e.lastError || undefined };
}
/* rerender (the owner, e.g. from scripts/setup-station.sh): units written by an older template are written again from
 * this one, so a template fix reaches what is already installed. Adopted units (managed: false) are left as they are. */
function rerender(ctx, o) {
  if (!isOwner(ctx, o.by)) throw err('rerender is the owner\'s: --by owner, from the owner\'s own shell', 3);
  const doc = read(ctx); const changed = [];
  for (const e of Object.values(doc.services || {})) {
    if (e.status !== 'installed' || e.managed === false) continue;
    const files = render(ctx, e);
    if (Object.entries(files).every(([f, text]) => (e.files || {})[f] === sha(text))) continue;
    writeUnits(ctx, e); changed.push(e);
  }
  if (!changed.length) return { ok: true, rerendered: [] };
  sc(ctx, ['daemon-reload']);
  for (const e of changed) {
    sc(ctx, ['reset-failed', e.unit + '.service'], e);   // a unit the old template rate-limited starts clean
    if (e.kind === 'timer' && e.desired === 'running' && !e.halt) sc(ctx, ['restart', e.unit + '.timer'], e);
  }
  write(ctx, doc); logRow(ctx, { event: 'rerendered', names: changed.map(e => e.name), by: 'owner' });
  return { ok: true, rerendered: changed.map(e => e.name) };
}
function remove(ctx, name, o) {
  const doc = read(ctx); const e = entry(doc, name);
  const who = mayControl(ctx, e, o.by, 'remove');
  if (e.status === 'installed') {
    const units = e.kind === 'timer' ? [e.unit + '.timer', e.unit + '.service'] : [e.unit + '.service'];
    sc(ctx, ['disable', '--now'].concat(units), e);
    for (const f of Object.keys(e.files || {})) {
      const p = path.join(ctx.unitDir, f);
      try { if (e.managed === false) { fs.mkdirSync(ctx.adoptedDir, { recursive: true }); fs.copyFileSync(p, path.join(ctx.adoptedDir, f)); } fs.unlinkSync(p); } catch (_) {}
    }
    sc(ctx, ['daemon-reload'], e);
  }
  delete doc.services[name];
  write(ctx, doc); logRow(ctx, { event: 'removed', name, unit: e.unit, by: who.seat || 'owner' });
  return { ok: true, name, removed: true };
}

/* ---------------- adopt (owner) ---------------- */
function parseUnit(text) {
  const out = {}; let sec = null;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const s = l.match(/^\[(.+)\]$/); if (s) { sec = s[1]; continue; }
    const i = l.indexOf('='); if (i < 0 || !sec) continue;
    const k = sec + '.' + l.slice(0, i).trim(); (out[k] = out[k] || []).push(l.slice(i + 1).trim());
  }
  return out;
}
const one = (u, k) => (u[k] || []).filter(Boolean).pop() || null;
/* adopt by a seat: the owner's yes is the authority. The first run asks one owner question (a gate on the exact unit,
 * name and seat); the owner answers it on Today or in chat; the seat's next run finds the yes and adopts, recorded with
 * the question id. A no refuses; a changed unit, name or seat is a new question. */
function adoptGate(ctx, base, o, words) {
  const who = actor(ctx, o.by, 'adopt', base);
  if (who.owner) return { owner: true };
  const gov = require('./lib/governance');
  const ref = 'service-adopt:' + sha(JSON.stringify({ unit: base, as: o.as || null, seat: o.seat || null })).replace(/^sha256:/, '').slice(0, 16);
  const q = gov.questionFor(ref, ctx.gov);
  if (q) {
    const a = gov.approved(ref, ctx.gov);
    if (a === true) return { approved: true, questionId: q.id, who };
    if (a === false) throw err('the owner declined adopting ' + base + ' (' + q.id + ')', 3);
    return { waiting: true, questionId: q.id };
  }
  const { normalizeForm } = require('./inbox.js');
  const cmd = words.map(a => a.startsWith(ctx.root + '/') ? a.slice(ctx.root.length + 1) : a).join(' ');
  const facts = ['**Program:** ' + base, '**What it runs:** `' + cmd + '`', '**Name it would get:** ' + (o.as || base + ' (unchanged)'), '**Owner seat:** ' + (o.seat || who.name),
    '**Why:** ' + String(o.why || 'not given'), '**Asked by:** ' + who.name].join('\n');
  const form = normalizeForm({ fields: [{ id: 'facts', type: 'info', text: facts }, { id: 'reason', type: 'text', multiline: true, label: 'Reason (optional)', required: false }],
    actions: [{ id: 'approve', label: 'Approve', verdict: 'yes', primary: true }, { id: 'decline', label: 'Decline', verdict: 'no' }] });
  const id = newQid(ctx);
  const message = (who.name + ' wants to adopt "' + base + '", a background program already running from the company folder that nobody registered, so it runs under the company\'s rules'
    + (o.as ? ' as "' + o.as + '"' : '') + '. If you decline or do not answer, it stays as it is and keeps being reported.').slice(0, 600);
  const row = { type: 'ask', id, at: new Date(ctx.now()).toISOString(), from: who.name, about: 'service-adopt:' + base, kind: 'form', form, message, details: facts,
    q: message + '\n\n' + facts, blocking: false, batch: 'gate',
    gate: { category: 'localComputer', ref, by: who.seat, summary: 'adopt the background program ' + base + (o.as ? ' as ' + o.as : ''), recommendation: null, default: 'nothing changes' } };
  require('./lib/pm-inbox-guard').append(gov.files(ctx.gov).inbox, row, 'service.js');
  return { waiting: true, asked: true, questionId: id };
}
function adopt(ctx, unit, o) {
  const base = String(unit || '').replace(/\.(service|timer)$/, '');
  if (!/^[A-Za-z0-9@_.:-]{2,80}$/.test(base)) throw err('name a unit, e.g. capheos-depth-stopgap');
  const svcFile = path.join(ctx.unitDir, base + '.service'), tmrFile = path.join(ctx.unitDir, base + '.timer');
  let svcText; try { svcText = fs.readFileSync(svcFile, 'utf8'); } catch (_) { throw err('no unit file ' + svcFile, 2); }
  const tmrText = fs.existsSync(tmrFile) ? fs.readFileSync(tmrFile, 'utf8') : null;
  const u = parseUnit(svcText), t = tmrText ? parseUnit(tmrText) : null;
  const words = splitWords(String(one(u, 'Service.ExecStart') || '').replace(/^[-@:+!]+/, ''));
  const g = adoptGate(ctx, base, o, words);
  if (g.waiting) return { ok: false, waiting: true, questionId: g.questionId, asked: !!g.asked, note: 'the owner decides on Today or in chat; run this again after the answer' };
  const via = g.approved ? 'adopted after the owner approved ' + g.questionId + ' (asked by ' + g.who.name + ')' : null;
  const byWord = g.approved ? 'owner (' + g.questionId + ')' : 'owner';
  const doc = read(ctx);
  const seat = o.seat ? seatOf(ctx, o.seat) : null;
  if (o.seat && !seat) throw err('--seat ' + o.seat + ' is not a seat in loops.json');
  const now = new Date(ctx.now()).toISOString();
  const why = String(o.why || one(u, 'Unit.Description') || 'adopted').slice(0, 400);
  const kind = t ? 'timer' : 'service';
  const schedule = t ? (one(t, 'Timer.OnCalendar') ? { onCalendar: one(t, 'Timer.OnCalendar') } : one(t, 'Timer.OnUnitActiveSec') ? { every: one(t, 'Timer.OnUnitActiveSec') } : null) : null;
  const wasRunning = isActive(ctx, t ? base + '.timer' : base + '.service');
  const wasEnabled = String(ctx.systemctl(['is-enabled', t ? base + '.timer' : base + '.service']).out || '').trim() === 'enabled';
  if (!o.as) {
    const name = base;
    if (doc.services[name]) throw err('"' + name + '" is already registered');
    doc.services[name] = { name, unit: base, kind, argv: words, schedule, why, by: seat || 'owner', byName: seat ? (ctx.crew()[seat] || {}).name || seat : 'Owner',
      status: 'installed', managed: false, desired: wasRunning ? 'running' : 'stopped', adopted: { from: base, at: now, by: byWord, renamed: false },
      approval: { level: 'owner', via: via || 'adopted by the owner', at: now, questionId: g.questionId || null }, softHalt: 'finish', files: Object.fromEntries([[base + '.service', sha(svcText)]].concat(tmrText ? [[base + '.timer', sha(tmrText)]] : [])) };
    write(ctx, doc); logRow(ctx, { event: 'adopted', name, unit: base, renamed: false, by: byWord, askedBy: g.who ? g.who.seat : null, questionId: g.questionId || null });
    return { ok: true, name, unit: base, renamed: false, note: 'registered under its old name; the unregistered-services duty keeps flagging it until it is adopted with --as <name>' };
  }
  const name = String(o.as);
  if (doc.services[name] && doc.services[name].status === 'installed') throw err('"' + name + '" is already registered');
  const restart = one(u, 'Service.Restart') === 'always' ? 'always' : 'on-failure';
  const toSec = v => { const m = String(v || '').match(/^(\d+)\s*(s|sec|min|m|h|d)?$/); return m ? m[1] + (m[2] ? m[2].replace(/^m$/, 'min') : 's') : null; };
  const spec = specOf(ctx, name, { kind, argv: words, why, restart, every: schedule && schedule.every ? toSec(schedule.every) : undefined, 'on-calendar': schedule && schedule.onCalendar,
    timeout: kind === 'timer' && one(u, 'Service.TimeoutStartSec') ? toSec(one(u, 'Service.TimeoutStartSec')) : undefined, 'success-exit': one(u, 'Service.SuccessExitStatus') || undefined,
    'soft-halt': o['soft-halt'], memory: o.memory, cpu: o.cpu, network: o.network });
  const e = Object.assign(spec, { specKey: specKey(spec), by: seat || 'owner', byName: seat ? (ctx.crew()[seat] || {}).name || seat : 'Owner', proposedAt: now,
    approval: { level: 'owner', via: (via || 'adopted by the owner') + ' from ' + base, at: now, questionId: g.questionId || null }, adopted: { from: base, at: now, by: byWord, renamed: true, wasRunning, wasEnabled } });
  // the old unit goes first: disabled, stopped, its files kept under company/state/services-adopted/
  sc(ctx, ['disable', '--now'].concat(t ? [base + '.timer', base + '.service'] : [base + '.service']), e);
  fs.mkdirSync(ctx.adoptedDir, { recursive: true });
  for (const f of [svcFile].concat(tmrText ? [tmrFile] : [])) { try { fs.copyFileSync(f, path.join(ctx.adoptedDir, path.basename(f))); fs.unlinkSync(f); } catch (x) { e.lastError = 'moving ' + f + ': ' + x.message; } }
  writeUnits(ctx, e);
  sc(ctx, ['daemon-reload'], e);
  e.status = 'installed'; e.installedAt = now;
  if (wasEnabled || wasRunning) sc(ctx, ['enable', mainUnit(e)], e);
  const h = ctx.halted();
  if (wasRunning && !h) sc(ctx, ['start', mainUnit(e)], e);
  if (wasRunning && h) e.halt = { mode: h, at: now, wasRunning: true };
  e.desired = wasRunning ? 'running' : 'stopped';
  doc.services[name] = e;
  write(ctx, doc); logRow(ctx, { event: 'adopted', name, unit: e.unit, from: base, renamed: true, by: byWord, askedBy: g.who ? g.who.seat : null, questionId: g.questionId || null });
  return { ok: !e.lastError, name, unit: e.unit, from: base, renamed: true, started: wasRunning && !h, error: e.lastError || undefined };
}

/* ---------------- halt (halt.js calls this whenever it writes halt.json) ---------------- */
function onHalt(st, o) {
  const ctx = o && o.ctx ? o.ctx : context(o);
  const mode = (st && st.mode) || 'running';
  const doc = read(ctx);
  const names = Object.keys(doc.services).filter(n => doc.services[n].status === 'installed');
  if (!names.length) return { mode, acted: [] };
  const mark = mode + '@' + ((st && st.at) || '');
  if (doc.halt && doc.halt.mark === mark) return { mode, acted: [], already: true };
  const now = new Date(ctx.now()).toISOString();
  const acted = [];
  for (const n of names) {
    const e = doc.services[n];
    const svc = e.unit + '.service', tmr = e.unit + '.timer';
    if (mode === 'hard') {
      if (!e.halt) e.halt = { mode: 'hard', at: now, wasRunning: e.kind === 'timer' ? isActive(ctx, tmr) : isActive(ctx, svc) };
      else e.halt.mode = 'hard';
      sc(ctx, ['stop', '--no-block'].concat(e.kind === 'timer' ? [tmr, svc] : [svc]), e);
      sc(ctx, ['kill', '--signal=SIGKILL', svc], null);
      acted.push(n + ': stopped now');
    } else if (mode === 'soft') {
      if (e.halt) continue;   // already handled by this halt
      const running = e.kind === 'timer' ? isActive(ctx, tmr) : isActive(ctx, svc);
      e.halt = { mode: 'soft', at: now, wasRunning: running };
      if (!running) { acted.push(n + ': was not running'); continue; }
      if (e.kind === 'timer') { sc(ctx, ['stop', tmr], e); acted.push(n + ': no new runs (a run in progress finishes)'); }
      else if (e.softHalt === 'keep') { e.halt.kept = true; acted.push(n + ': keeps running (declared --soft-halt keep)'); }
      else { sc(ctx, ['stop', '--no-block', svc], e); acted.push(n + ': asked to finish and stop'); }
    } else {
      if (!e.halt) continue;
      if (e.halt.wasRunning && e.desired !== 'stopped' && !(e.halt.kept && e.halt.mode === 'soft')) { sc(ctx, ['start', e.kind === 'timer' ? tmr : svc], e); acted.push(n + ': started again'); }
      delete e.halt;
    }
  }
  doc.halt = { mark, mode, at: now, acted };
  write(ctx, doc);
  if (acted.length) logRow(ctx, { event: 'halt-' + mode, acted });
  return { mode, acted };
}

/* ---------------- list / status ---------------- */
function showProps(ctx, unit, props) {
  const r = ctx.systemctl(['show', unit, '-p', props.join(',')]);
  const o = {}; for (const l of String(r.out || '').split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return o;
}
const ts = v => { if (!v || v === 'n/a' || v === '0') return null; const d = Date.parse(String(v).replace(/^\w{3} /, '').replace(/ ([+-]\d\d)$/, ' $1:00')); return Number.isFinite(d) ? new Date(d).toISOString() : String(v); };
function live(ctx, e) {
  if (e.status !== 'installed') return { state: e.status };
  const s = showProps(ctx, e.unit + '.service', ['ActiveState', 'SubState', 'Result', 'ExecMainStartTimestamp', 'ExecMainExitTimestamp', 'ExecMainStatus', 'NRestarts']);
  const out = { state: s.ActiveState || 'unknown', sub: s.SubState || null, result: s.Result || null, lastStart: ts(s.ExecMainStartTimestamp), lastExit: ts(s.ExecMainExitTimestamp),
    exitStatus: s.ExecMainStatus != null && s.ExecMainStatus !== '' ? Number(s.ExecMainStatus) : null, restarts: s.NRestarts ? Number(s.NRestarts) : 0 };
  if (e.kind === 'timer') {
    const t = showProps(ctx, e.unit + '.timer', ['ActiveState', 'LastTriggerUSec', 'NextElapseUSecRealtime']);
    out.timer = t.ActiveState || 'unknown'; out.lastRun = ts(t.LastTriggerUSec) || out.lastStart; out.nextRun = ts(t.NextElapseUSecRealtime);
    out.state = out.state === 'activating' || out.state === 'active' ? 'running now' : out.timer === 'active' ? 'scheduled' : 'stopped';
  } else {
    out.lastRun = out.lastStart;
    out.state = out.state === 'active' ? 'running' : out.state === 'failed' ? 'failed' : out.state === 'activating' ? 'starting' : 'stopped';
  }
  return out;
}
function list(ctx) {
  const doc = read(ctx);
  const rows = Object.values(doc.services).map(e => {
    const lv = live(ctx, e);
    return { name: e.name, unit: e.unit, kind: e.kind, status: e.status, state: lv.state, schedule: e.schedule, scheduleWords: scheduleWords(e.schedule), lastRun: lv.lastRun || null,
      nextRun: lv.nextRun || null, result: lv.result || null, exitStatus: lv.exitStatus, restarts: lv.restarts || 0, by: e.by, byName: e.byName || e.by, why: e.why,
      command: (e.argv || []).map(a => a.startsWith(ctx.root + '/') ? a.slice(ctx.root.length + 1) : a).join(' '), limits: e.limits || null, network: e.network !== false,
      softHalt: e.softHalt || 'finish', wake: e.wake || null, approval: e.approval || null, questionId: (e.approval || {}).questionId || null, proposedAt: e.proposedAt || null,
      installedAt: e.installedAt || null, halt: e.halt || null, scoped: String(e.unit || '').startsWith(ctx.slug + '-svc-'), managed: e.managed !== false, lastError: e.lastError || null, adopted: e.adopted || null };
  });
  return { ok: true, company: ctx.slug, guardrail: ctx.guard('localComputer') ? 'on' : 'off', services: rows };
}

/* ---------------- duty: unregistered-services (read-only, no network, no systemctl) ---------------- */
// Every unit the framework itself installs (systemd/*.in, named for this company's station by setup-station.sh) is the
// framework's, never a crew service: derived from the templates, so a new framework unit (e.g. the heartbeat timer) can
// never be flagged as unregistered or offered to the owner to "adopt".
function frameworkUnits(ctx) {
  const s = ctx.stationSvc;
  const out = new Set([s + '.service', s + '-dispatch.service', s + '-dispatch.timer', s + '-console.service', s + '-liveness.service', s + '-liveness.timer']);
  let names = []; try { names = fs.readdirSync(path.join(__dirname, '..', '..', 'systemd')); } catch (_) {}
  for (const n of names) { if (!n.endsWith('.in')) continue; const u = n.slice(0, -3); out.add(u.startsWith('capheos-station') ? s + u.slice('capheos-station'.length) : u.replace(/^capheos-/, s + '-')); }
  return out;
}
function unitFiles(dir) {
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const f of names) {
    if (!/\.(service|timer)$/.test(f)) continue;
    const p = path.join(dir, f);
    try { const st = fs.statSync(p); if (!st.isFile() || st.size > 65536) continue; out.push({ file: f, text: fs.readFileSync(p, 'utf8') }); } catch (_) {}
  }
  return out;
}
function findings(ctx) {
  const doc = read(ctx);
  const reg = new Map(); const regFiles = new Map();
  for (const e of Object.values(doc.services)) { if (e.status !== 'installed') continue; reg.set(e.unit + '.service', e); reg.set(e.unit + '.timer', e); for (const [f, h] of Object.entries(e.files || {})) regFiles.set(f, { e, h }); }
  const fw = frameworkUnits(ctx);
  const roots = new Set([ctx.root]); try { roots.add(fs.realpathSync(ctx.root)); } catch (_) {}
  const refsRoot = v => [...roots].some(r => String(v || '').split(/[\s"'=]+/).some(w => w === r || w.startsWith(r + '/')));
  const files = unitFiles(ctx.unitDir).map(x => Object.assign(x, { transient: false })).concat(unitFiles(ctx.transientDir).map(x => Object.assign(x, { transient: true })));
  const inScope = new Set();
  const byName = new Map(files.map(x => [x.file, x]));
  for (const x of files) {
    if (!x.file.endsWith('.service')) continue;
    const u = parseUnit(x.text);
    const vals = [].concat(u['Service.ExecStart'] || [], u['Service.ExecStartPre'] || [], u['Service.ExecStartPost'] || [], u['Service.WorkingDirectory'] || []);
    if (vals.some(refsRoot)) inScope.add(x.file);
  }
  for (const x of files) {
    if (!x.file.endsWith('.timer')) continue;
    const target = one(parseUnit(x.text), 'Timer.Unit') || x.file.replace(/\.timer$/, '.service');
    if (inScope.has(target) || (byName.has(target) === false && refsRoot(x.text))) inScope.add(x.file);
  }
  const unregistered = [...inScope].filter(f => !fw.has(f) && !reg.has(f)).sort();
  const unscoped = [...new Set([...reg.values()].map(e => e.unit))].filter(u => !u.startsWith(ctx.slug + '-svc-')).sort();
  const edited = [];
  for (const [f, { e, h }] of regFiles) {
    if (e.managed === false) continue;
    const x = byName.get(f);
    if (!x) edited.push(f + ' (missing)'); else if (sha(x.text) !== h) edited.push(f);
  }
  const transient = files.filter(x => x.transient && unregistered.includes(x.file)).map(x => x.file);
  return { unregistered, unscoped, edited: edited.sort(), transient, failing: failing(ctx, doc) };
}
/* failing(ctx, doc): registered services whose runs fail. A timer's failed run changes nothing anyone reads (the timer
 * stays active, the next run may pass), so it is counted from the unit's journal: FAIL_IN_HOUR failed runs in the last
 * hour, or any failed run of a halt-related service (name, why or command naming the halt / kill switch). */
const FAIL_IN_HOUR = 3;
const HALT_RE = /\bhalt|kill[- ]?switch/i;
function failing(ctx, doc) {
  const out = [];
  for (const e of Object.values(doc.services || {})) {
    if (e.status !== 'installed' || e.desired === 'stopped') continue;
    // a rare timer (on a calendar, or every 20 min or more) cannot fail 3 times in an hour: one failure of its latest run
    // counts, read over a window that covers at least one of its runs (2 periods, at least an hour; 26 h on a calendar)
    const s = e.schedule || {}; const per = s.every ? secsOf(s.every) : 0;
    const rare = e.kind === 'timer' && (!!s.onCalendar || per >= 1200);
    const windowSec = s.onCalendar ? 26 * 3600 : Math.max(3600, 2 * per);
    const txt = String(ctx.journal(e.unit + '.service', rare ? windowSec : 3600) || '');
    // only what happened since the last successful run counts: a later success clears it
    const since = txt.split(/\n/).reduce((acc, l) => (/Deactivated successfully|Finished /.test(l) && !/Failed/.test(l) ? [] : /Failed with result '([^']+)'/.test(l) ? acc.concat([l.match(/Failed with result '([^']+)'/)[1]]) : acc), []);
    const all = [...txt.matchAll(/Failed with result '([^']+)'/g)].map(m => m[1]);
    const results = rare ? since : all;
    if (!results.length) continue;
    const halt = HALT_RE.test([e.name, e.why, (e.argv || []).join(' ')].join(' '));
    if (results.length >= FAIL_IN_HOUR || halt || rare) out.push({ name: e.name, by: e.by || 'owner', count: results.length, last: results[results.length - 1], halt, rare });
  }
  return out;
}
const secsOf = v => { const m = String(v || '').match(/^(\d+)\s*(s|sec|m|min|h|d)$/i); return m ? Number(m[1]) * ({ s: 1, sec: 1, m: 60, min: 60, h: 3600, d: 86400 })[m[2].toLowerCase()] : 0; };
function duty(ctx) {
  const f = findings(ctx);
  const items = f.unregistered.map(u => ({ id: 'unregistered:' + u })).concat(f.unscoped.map(u => ({ id: 'unscoped:' + u }))).concat(f.edited.map(u => ({ id: 'edited:' + u.split(' ')[0] })))
    // a failing service goes to the seat that asked for it (the owner's own go to risk); the id is stable while it fails, so it is handed over once
    .concat(f.failing.map(x => ({ id: 'failing:' + x.name, route: x.by && x.by !== 'owner' ? x.by : 'risk' })));
  if (!items.length) return { due: false };
  const parts = [];
  if (f.failing.length) parts.push(f.failing.length + ' registered service(s) failing: ' + f.failing.slice(0, 4).map(x => x.name + ' ' + x.count + (x.rare ? ' failed run(s) since its last success (a rare timer: one failure counts)' : ' failed run(s) in the last hour') + ', last ' + x.last + (x.halt ? ' (halt-related: any failure counts)' : '')).join('; ') + ' (service.js status; fix the cause, or stop it)');
  if (f.unregistered.length) parts.push(f.unregistered.length + ' background unit(s) run from this company folder but are not registered with service.js: ' + f.unregistered.slice(0, 6).join(', ') + (f.unregistered.length > 6 ? ' and more' : '') + (f.transient.length ? ' (' + f.transient.length + ' transient)' : ''));
  if (f.unscoped.length) parts.push(f.unscoped.length + ' registered unit(s) not company-scoped by name: ' + f.unscoped.slice(0, 4).join(', '));
  if (f.edited.length) parts.push(f.edited.length + ' registered unit file(s) changed by hand: ' + f.edited.slice(0, 4).join(', '));
  const key = sha(items.map(i => i.id).sort().join('|'));
  const tail = f.unregistered.length || f.unscoped.length || f.edited.length ? '. Adopt or remove the unregistered or changed ones (service.js adopt / remove; the owner decides).' : '.';
  return { due: true, reason: (parts.join('; ') + tail).slice(0, 300), route: 'risk', key, items: items.slice(0, 50) };
}

/* ---------------- the shims: check-systemctl / check-systemd-run ---------------- */
// -> {refuse: bool, why?} for an agent caller; the owner and other callers always pass
function checkCommand(ctx, which, args) {
  const user = args.includes('--user') || args.some(a => a === '-M' || /^--machine=.*@/.test(a));
  if (!ctx.isAgent()) return { refuse: false };
  let changes = false, verb = null;
  if (which === 'systemd-run') { changes = user; verb = 'systemd-run'; }
  else {
    const words = args.filter(a => !a.startsWith('-'));
    verb = words[0] || null;
    changes = user && !!verb && MUTATING.has(verb);
  }
  if (!changes) return { refuse: false };
  const what = (which === 'systemd-run' ? 'systemd-run ' : 'systemctl ') + args.join(' ').slice(0, 160);
  if (!ctx.guard('localComputer')) { logRow(ctx, { event: 'unguarded', what }); return { refuse: false, unguarded: require('./lib/guardrails').unguarded('localComputer', what) }; }
  logRow(ctx, { event: 'refused', what });
  return { refuse: true, why: 'refused (guardrail localComputer is ON): `' + what + '` changes background units on this computer. A service the company needs between runs goes through '
    + 'node company/tools/service.js propose <name> --kind service|timer --exec "python3 company/work/.../script.py ..." --why "..." --by <your seat> (the owner approves it; start/stop are then yours with service.js start|stop).' };
}

/* ---------------- CLI ---------------- */
function parseArgs(a) {
  const o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); o[k] = (a[i + 1] !== undefined && !a[i + 1].startsWith('--')) ? a[++i] : true; }
    else o._.push(a[i]);
  }
  return o;
}
function printStatus(r) {
  if (!r.services.length) { console.log('No background services are registered (guardrail localComputer ' + r.guardrail + ').'); return; }
  for (const s of r.services) console.log(s.name.padEnd(20) + ' ' + String(s.state).padEnd(12) + ' ' + s.scheduleWords + (s.lastRun ? ', last run ' + s.lastRun : '') + (s.result && s.result !== 'success' ? ' [last result: ' + s.result + ']' : '') + ' — asked by ' + s.byName + ': ' + s.why.slice(0, 80) + (s.scoped ? '' : '  [NOT company-scoped: ' + s.unit + ']'));
}
function main(argv) {
  const cmd = argv[0];
  if (cmd === 'check-systemctl' || cmd === 'check-systemd-run') {
    const r = checkCommand(context(), cmd === 'check-systemctl' ? 'systemctl' : 'systemd-run', argv.slice(1).filter((x, i) => !(i === 0 && x === '--')));
    if (r.unguarded) console.error(r.unguarded);
    if (r.refuse) { console.error(r.why); return 3; }
    return 0;
  }
  if (cmd === '--duty') {
    let r; try { r = duty(context()); } catch (e) { console.error('duty broken: ' + e.message); return 2; }
    if (!r.due) return 0;
    process.stdout.write(JSON.stringify(r) + '\n'); return 1;
  }
  if (cmd === 'selftest' || cmd === '--selftest') return selftest();
  const o = parseArgs(argv.slice(1));
  const ctx = context();
  const print = x => console.log(JSON.stringify(x, null, 1));
  if (cmd === 'list') { const r = list(ctx); if (o.json) print(r); else printStatus(r); return 0; }
  if (cmd === 'status') { printStatus(list(ctx)); const f = findings(ctx); if (f.unregistered.length) console.log('Not registered but running from this company folder: ' + f.unregistered.join(', ')); return 0; }
  if (cmd === 'propose') { const r = propose(ctx, o._[0], o); print(r); return r.waiting ? 4 : r.ok ? 0 : 1; }
  if (cmd === 'start' || cmd === 'stop') { const r = startStop(ctx, cmd, o._[0], o); print(r); return r.ok ? 0 : 1; }
  if (cmd === 'remove') { print(remove(ctx, o._[0], o)); return 0; }
  if (cmd === 'rerender') { print(rerender(ctx, o)); return 0; }
  if (cmd === 'adopt') { const r = adopt(ctx, o._[0], o); print(r); return r.waiting ? 4 : r.ok ? 0 : 1; }
  console.error('usage: service.js propose|list|status|stop|start|remove|adopt|--duty|selftest (header of company/tools/service.js)'); return 2;
}

module.exports = { context, propose, startStop, remove, adopt, onHalt, list, findings, duty, checkCommand, validateArgv, splitWords, render, specOf, unitOf, _internals: { frameworkUnits } };

/* ---------------- selftest: temp company, fake systemctl, no real user manager ---------------- */
function selftest() {
  const { spawnSync } = require('child_process');
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'service-selftest-'));
  let bad = 0, n = 0;
  const ok = (name, cond, detail) => { n++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : '  [' + String(detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) + ']')); if (!cond) bad++; };
  const throwsCode = (fn, code, re) => { try { fn(); return false; } catch (e) { return e.code === code && (!re || re.test(e.message)) ? true : e.code + ' ' + e.message; } };
  try {
    const R = path.join(T, 'co'); const U = path.join(T, 'units'); const TR = path.join(T, 'transient');
    for (const d of ['company/state', 'company/tools', 'company/work/sim/scripts', 'company/defaults/state', 'company/owner']) fs.mkdirSync(path.join(R, d), { recursive: true });
    fs.mkdirSync(U); fs.mkdirSync(TR);
    fs.writeFileSync(path.join(R, 'company/company.json'), JSON.stringify({ name: 'Test Co', slug: 'testco', owner: { name: 'Pat' }, station: { serviceName: 'testco-station' } }));
    fs.writeFileSync(path.join(R, 'company/tools/loops.json'), JSON.stringify({ agents: { agent: { name: 'Alex' }, data: { name: 'Halima' } } }));
    fs.copyFileSync(path.join(__dirname, '..', 'defaults', 'state', 'governance.json'), path.join(R, 'company/defaults/state/governance.json'));
    fs.writeFileSync(path.join(R, 'company/work/sim/scripts/rec.py'), 'print(1)\n');
    fs.writeFileSync(path.join(R, 'company/work/sim/scripts/bank.sh'), 'echo 1\n');
    fs.writeFileSync(path.join(T, 'outside.py'), 'print(1)\n');
    fs.symlinkSync(path.join(T, 'outside.py'), path.join(R, 'company/work/sim/scripts/link.py'));
    // the fake user manager: a map of unit -> active, and every call recorded
    const fake = { calls: [], active: {}, enabled: {} };
    const systemctl = args => {
      fake.calls.push(args.join(' '));
      const [v, ...rest] = args; const units = rest.filter(x => !x.startsWith('-'));
      if (v === 'is-active') return { code: fake.active[units[0]] ? 0 : 3, out: fake.active[units[0]] ? 'active\n' : 'inactive\n' };
      if (v === 'is-enabled') return { code: 0, out: fake.enabled[units[0]] ? 'enabled\n' : 'disabled\n' };
      if (v === 'start') { for (const u of units) { fake.active[u] = true; if (u.endsWith('.timer')) fake.active[u] = true; } return { code: 0, out: '' }; }
      if (v === 'stop') { for (const u of units) fake.active[u] = false; return { code: 0, out: '' }; }
      if (v === 'enable') { for (const u of units) fake.enabled[u] = true; return { code: 0, out: '' }; }
      if (v === 'disable') { for (const u of units) { fake.enabled[u] = false; if (rest.includes('--now')) fake.active[u] = false; } return { code: 0, out: '' }; }
      if (v === 'show') return { code: 0, out: 'ActiveState=' + (fake.active[units[0]] ? 'active' : 'inactive') + '\nSubState=running\nResult=success\nExecMainStartTimestamp=Tue 2026-11-17 05:41:26 +07\nLastTriggerUSec=n/a\n' };
      return { code: 0, out: '' };
    };
    let halted = false, agent = true, guardOn = true, govLevel = null, conflict = null;
    const journal = {};
    const ctx = context({ root: R, unitDir: U, transientDir: TR, systemctl, journal: u => journal[u] || '', now: () => Date.parse('2026-11-17T10:00:00Z'), isAgent: () => agent, ownerShell: () => !agent,
      guard: nm => nm === 'localComputer' ? guardOn : true, halted: () => halted, callerConflict: () => conflict,
      gov: { root: R, get level() { return govLevel || undefined; } } });
    const inbox = path.join(R, 'company', 'pm-inbox.jsonl');
    const answer = (qid, verdict) => require('./lib/pm-inbox-guard').append(inbox, { type: 'answer', id: qid, a: verdict === 'yes' ? 'yes' : 'no', answer: { verdict }, by: 'Pat' }, 'selftest');

    // ---- argv validation refusals
    const P = (exec, extra) => () => specOf(ctx, 'rec', Object.assign({ kind: 'service', exec, why: 'records depth between runs' }, extra), { resolve: false });
    ok('refused: a shell string', throwsCode(P('python3 company/work/sim/scripts/rec.py; rm -rf x'), 2, /shell syntax/) === true);
    ok('refused: bash -c', throwsCode(P('bash -c "echo hi"'), 2, /flag -c is not allowed/) === true);
    ok('refused: python3 -m (a module, not a file)', throwsCode(P('python3 -m http.server'), 2, /flag -m/) === true);
    ok('refused: sudo', throwsCode(P('sudo python3 company/work/sim/scripts/rec.py'), 2, /sudo/) === true);
    ok('refused: an interpreter that is not python3/node/bash/sh', throwsCode(P('curl http://x'), 2, /must start with python3/) === true);
    ok('refused: a script outside the company tree', throwsCode(P('python3 ' + path.join(T, 'outside.py')), 2, /under company\/work/) === true);
    ok('refused: a symlink in company/work that points outside', throwsCode(P('python3 company/work/sim/scripts/link.py'), 2, /real path/) === true);
    ok('refused: a script outside company/work and company/tools', (() => { fs.writeFileSync(path.join(R, 'x.py'), ''); return throwsCode(P('python3 x.py'), 2, /under company\/work/); })() === true);
    ok('refused: an argument path outside ROOT', throwsCode(P('python3 company/work/sim/scripts/rec.py --out /tmp/elsewhere'), 2, /outside the company folder/) === true);
    ok('refused: a .. argument that escapes', throwsCode(P('python3 company/work/sim/scripts/rec.py --out=../../x'), 2, /outside the company folder/) === true);
    ok('refused: wrong extension for the interpreter', throwsCode(P('node company/work/sim/scripts/rec.py'), 2, /does not look like/) === true);
    ok('refused: a bad name', throwsCode(() => specOf(ctx, 'Bad Name', { kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py', why: 'xxxxxxxxxxxx' }), 2, /name must be/) === true);
    ok('refused: a timer without a schedule', throwsCode(P('python3 company/work/sim/scripts/rec.py', { kind: 'timer' }), 2, /--every/) === true);
    ok('refused: --why missing', throwsCode(P('python3 company/work/sim/scripts/rec.py', { why: '' }), 2, /--why/) === true);
    const good = specOf(ctx, 'depth', { kind: 'service', exec: 'python3 -u company/work/sim/scripts/rec.py --out ' + path.join(R, 'scratch/d') + ' --hz 1', why: 'records depth between runs' }, { resolve: false });
    ok('accepted: python3 -u <company script> with in-tree args, made absolute', good.argv[0] === '/usr/bin/python3' && good.argv[2] === path.join(R, 'company/work/sim/scripts/rec.py') && good.unit === 'testco-svc-depth', good);
    {   // --wake: a timer's ExecStart goes through notify-when.js, which records the run and wakes the seats
      const wk = specOf(ctx, 'bank', { kind: 'timer', every: '1h', exec: 'bash company/work/sim/scripts/bank.sh', why: 'banks the day between runs', wake: 'Halima' }, { resolve: false });
      const svc = render(ctx, wk)[wk.unit + '.service'];
      ok('--wake: the seat is resolved and the ExecStart is wrapped by notify-when.js --service-run (exit code passed through)', JSON.stringify(wk.wake) === '["data"]' && new RegExp('ExecStart="[^"]*node" "' + R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/company/tools/notify-when\\.js" "--service-run" "bank" "--seat" "data" "--" "[^"]*bash" "').test(svc), svc);
      ok('--wake: refused for a long-running service and for an unknown seat', throwsCode(P('python3 company/work/sim/scripts/rec.py', { wake: 'data' }), 2, /--wake is for a timer/) === true && throwsCode(() => specOf(ctx, 'bank', { kind: 'timer', every: '1h', exec: 'bash company/work/sim/scripts/bank.sh', why: 'banks the day between runs', wake: 'zed' }, { resolve: false }), 2, /no seat "zed"/) === true);
      ok('--wake: a spec without it keeps its old key (installed services are not re-proposed)', specKey(good) === sha(JSON.stringify([good.kind, good.argv, good.schedule, good.restart, good.softHalt, good.network, good.limits, good.timeout, good.successExit])));
    }

    // ---- propose -> owner question (guardrail ON) -> approval -> unit rendered
    let r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs', 'soft-halt': 'finish' });
    const q = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
    ok('guardrail ON: propose waits for the owner with a typed question', r.waiting && q.id === r.questionId && q.kind === 'form' && q.gate.category === 'localComputer', r);
    ok('the question shows name, command, schedule and why', /depth/.test(q.details) && /rec\.py --hz 1/.test(q.details) && /runs all the time/.test(q.details) && /order-book depth/.test(q.details) && q.form.actions.some(a => a.verdict === 'yes'));
    ok('nothing installed before the answer', !fs.existsSync(path.join(U, 'testco-svc-depth.service')) && !fake.calls.some(c => /^(enable|start)/.test(c)));
    r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs' });
    ok('a rerun before the answer does not ask twice', r.waiting && fs.readFileSync(inbox, 'utf8').trim().split('\n').length === 1);
    answer(q.id, 'yes');
    r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs' });
    const unit = fs.readFileSync(path.join(U, 'testco-svc-depth.service'), 'utf8');
    ok('after yes: installed, enabled and started', r.ok && r.status === 'installed' && fake.active['testco-svc-depth.service'] && fake.calls.includes('daemon-reload'), r);
    ok('unit: company-scoped name, WorkingDirectory=ROOT, Restart, limits, no network rule', /WorkingDirectory=/.test(unit) && unit.includes('WorkingDirectory=' + R + '\n') && /Restart=on-failure/.test(unit)
      && /MemoryMax=512M/.test(unit) && /CPUQuota=50%/.test(unit) && /NoNewPrivileges=yes/.test(unit) && !/RestrictAddressFamilies/.test(unit) && /X-CaPheOS-Company=testco/.test(unit), unit);
    ok('unit ExecStart is quoted absolute argv', /ExecStart="[^"]*python3" "[^"]*rec\.py" "--hz" "1"/.test(unit), unit);
    const reg = read(ctx).services.depth;
    ok('services.json records who, why, approval and the unit hash', reg.by === 'data' && /order-book/.test(reg.why) && reg.approval.questionId === q.id && reg.files['testco-svc-depth.service']);
    // a declined one
    r = propose(ctx, 'tape', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', 'on-calendar': '*-*-* 18:00:00 UTC', why: 'banks the trade tape once a day', network: 'none' });
    const q2 = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
    answer(q2.id, 'no');
    ok('a no is final: refused with exit code 3', throwsCode(() => propose(ctx, 'tape', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', 'on-calendar': '*-*-* 18:00:00 UTC', why: 'banks the trade tape once a day', network: 'none' }), 3, /said no/) === true);
    // guardrail OFF follows the schedules level: notify installs at once and tells the owner
    guardOn = false; govLevel = 'notify';
    r = propose(ctx, 'bank', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'banks the closed day every hour', network: 'none' });
    const tm = fs.readFileSync(path.join(U, 'testco-svc-bank.timer'), 'utf8'); const ts1 = fs.readFileSync(path.join(U, 'testco-svc-bank.service'), 'utf8');
    ok('guardrail OFF + schedules notify: installed without a question, owner told', r.ok && r.status === 'installed' && fs.existsSync(path.join(R, 'company/owner/outbound.jsonl')), r);
    ok('timer rendered: OnUnitActiveSec, oneshot service, no network', /OnUnitActiveSec=1h/.test(tm) && /Unit=testco-svc-bank.service/.test(tm) && /Type=oneshot/.test(ts1) && /RestrictAddressFamilies=AF_UNIX/.test(ts1) && fake.active['testco-svc-bank.timer']);
    // start limit: a timer must not rate-limit itself to half its schedule; a long-running service keeps the guard
    const minuteSvc = render(ctx, specOf(ctx, 'minute', { kind: 'timer', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', every: '1min', why: 'one pass every minute' }, { resolve: false }))['testco-svc-minute.service'];
    ok('a 1-min timer gets no start limit (its own firings would hit 5 per 10 min)', /StartLimitIntervalSec=0/.test(minuteSvc) && !/StartLimitBurst/.test(minuteSvc), minuteSvc);
    ok('a long-running service keeps the 5-per-10-min limit', /StartLimitIntervalSec=10min/.test(render(ctx, good)['testco-svc-depth.service']) && /StartLimitBurst=5/.test(render(ctx, good)['testco-svc-depth.service']));
    // rerender: a unit written by an older template is written again (owner only), reset and its timer restarted
    {
      const was = agent; agent = true;
      ok('rerender is the owner\'s only', throwsCode(() => rerender(ctx, { by: 'data' }), 3) === true);
      agent = false;
      const doc = read(ctx); const be = doc.services.bank; const f = path.join(U, 'testco-svc-bank.service');
      const old = fs.readFileSync(f, 'utf8').replace('StartLimitIntervalSec=0\n', 'StartLimitIntervalSec=10min\nStartLimitBurst=5\n');
      fs.writeFileSync(f, old); be.files['testco-svc-bank.service'] = sha(old); write(ctx, doc);
      const n0 = fake.calls.length; const rr = rerender(ctx, { by: 'Pat' }); const calls = fake.calls.slice(n0);
      ok('rerender rewrites an old-template unit, resets it and restarts its timer', rr.rerendered.join() === 'bank' && /StartLimitIntervalSec=0/.test(fs.readFileSync(f, 'utf8'))
        && calls.includes('daemon-reload') && calls.includes('reset-failed testco-svc-bank.service') && calls.includes('restart testco-svc-bank.timer'), { rr, calls });
      ok('rerender with nothing out of date changes nothing', rerender(ctx, { by: 'Pat' }).rerendered.length === 0);
      agent = was;
    }
    guardOn = true; govLevel = null;
    // start/stop/remove rights
    ok('stop by another seat is refused', throwsCode(() => startStop(ctx, 'stop', 'depth', { by: 'agent' }), 3, /belongs to/) === true);
    conflict = { agentId: 'agent' };
    ok('a --by claim from somebody else\'s run is refused', throwsCode(() => startStop(ctx, 'stop', 'depth', { by: 'data' }), 3, /does not match/) === true);
    conflict = null;
    r = startStop(ctx, 'stop', 'depth', { by: 'data' });
    ok('the owner seat stops its service', r.ok && fake.active['testco-svc-depth.service'] === false);
    r = startStop(ctx, 'start', 'depth', { by: 'data' });
    ok('and starts it again', r.ok && fake.active['testco-svc-depth.service'] === true);
    ok('an agent cannot claim to be the owner', throwsCode(() => startStop(ctx, 'stop', 'depth', { by: 'owner' }), 3, /owner/) === true);

    // ---- halt: soft, then resume; hard, then resume
    propose(ctx, 'keeper', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --keep', why: 'a recorder that must keep running', 'soft-halt': 'keep' });
    const q3 = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop()); answer(q3.id, 'yes');
    propose(ctx, 'keeper', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --keep', why: 'a recorder that must keep running', 'soft-halt': 'keep' });
    fake.calls.length = 0;
    let h = onHalt({ mode: 'soft', at: 'T1' }, { ctx });
    ok('soft: the timer stops firing, a finish-service is asked to stop, a keep-service keeps running', fake.active['testco-svc-bank.timer'] === false && fake.calls.includes('stop testco-svc-bank.timer')
      && !fake.calls.some(c => c === 'stop testco-svc-bank.timer testco-svc-bank.service') && fake.active['testco-svc-depth.service'] === false && fake.calls.includes('stop --no-block testco-svc-depth.service')
      && fake.active['testco-svc-keeper.service'] === true, { calls: fake.calls, h });
    ok('soft is applied once per halt (a second write of the same halt does nothing)', onHalt({ mode: 'soft', at: 'T1' }, { ctx }).already === true);
    halted = 'soft';
    ok('start while halted waits for the resume', startStop(ctx, 'start', 'depth', { by: 'data' }).waiting === true && fake.active['testco-svc-depth.service'] === false);
    halted = false;
    h = onHalt({ mode: 'running', at: 'T2' }, { ctx });
    ok('resume restarts what was running', fake.active['testco-svc-bank.timer'] === true && fake.active['testco-svc-depth.service'] === true && fake.active['testco-svc-keeper.service'] === true && !read(ctx).services.depth.halt, h);
    startStop(ctx, 'stop', 'bank', { by: 'data' });
    fake.calls.length = 0;
    h = onHalt({ mode: 'hard', at: 'T3' }, { ctx });
    ok('hard: every registered unit is stopped now (keep included)', fake.active['testco-svc-depth.service'] === false && fake.active['testco-svc-keeper.service'] === false
      && fake.calls.includes('kill --signal=SIGKILL testco-svc-keeper.service') && fake.calls.some(c => c.startsWith('stop --no-block testco-svc-bank.timer')), fake.calls);
    h = onHalt({ mode: 'running', at: 'T4' }, { ctx });
    ok('resume after hard starts only what was running (the stopped timer stays stopped)', fake.active['testco-svc-depth.service'] === true && fake.active['testco-svc-keeper.service'] === true && !fake.active['testco-svc-bank.timer'], fake.active);
    halted = 'hard';
    r = (() => { guardOn = false; govLevel = 'auto'; const x = propose(ctx, 'late', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --late', why: 'proposed during a halt' }); guardOn = true; govLevel = null; return x; })();
    ok('a service installed during a halt is not started; resume starts it', r.halted && !fake.active['testco-svc-late.service'] && (onHalt({ mode: 'running', at: 'T5' }, { ctx }), fake.active['testco-svc-late.service'] === true));
    halted = false;

    // ---- the duty: unregistered and unscoped units
    ok('duty: nothing due while every unit is registered', duty(ctx).due === false, duty(ctx));
    // ---- the duty: a registered service whose runs fail reaches the seat that asked for it, once
    const fails = n => Array.from({ length: n }, () => 'testco-svc-depth.service: Failed with result \'core-dump\'.').join('\n');
    journal['testco-svc-depth.service'] = fails(2);
    ok('duty: 2 failed runs in the hour of an ordinary service are not due yet', duty(ctx).due === false, duty(ctx));
    journal['testco-svc-depth.service'] = fails(3);
    const d0 = duty(ctx);
    ok('duty: 3 failed runs in the hour are due, routed to the seat that asked for the service, with a stable id (handed over once)',
      d0.due && d0.items.some(i => i.id === 'failing:depth' && i.route === read(ctx).services.depth.by) && /depth 3 failed run\(s\) in the last hour, last core-dump/.test(d0.reason) && duty(ctx).key === d0.key, d0);
    journal['testco-svc-depth.service'] = '';
    const hw = { status: 'installed', name: 'halt-watchdog', unit: 'testco-svc-halt-watchdog', by: 'tools1', why: 'the kill switch watchdog', argv: ['python3', 'w.py'] };
    journal['testco-svc-halt-watchdog.service'] = fails(1);
    ok('duty: one failed run of a halt-related service is enough', failing(ctx, { services: { hw } }).length === 1 && failing(ctx, { services: { hw } })[0].halt === true);
    ok('duty: one failed run of an ordinary service is not', failing(ctx, { services: { hw: Object.assign({}, hw, { name: 'feed', why: 'record a feed' }) } }).length === 0);
    // a nightly timer: one failure of its latest run counts (it can never fail 3 times in an hour); a later success clears it
    const nightly = { status: 'installed', name: 'bank', unit: 'testco-svc-nightly', kind: 'timer', by: 'data', why: 'bank the day', argv: ['sh', 'b.sh'], schedule: { onCalendar: '*-*-* 00:30:00' } };
    let asked = 0; const realJ = ctx.journal;
    journal['testco-svc-nightly.service'] = 'testco-svc-nightly.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED\ntestco-svc-nightly.service: Failed with result \'exit-code\'.';
    ctx.journal = (u, sec) => { if (u === 'testco-svc-nightly.service') asked = sec; return realJ(u, sec); };
    const nf = failing(ctx, { services: { nightly } });
    ok('duty: one failure of a nightly timer is due (read over 26 h)', nf.length === 1 && nf[0].rare && asked === 26 * 3600, JSON.stringify({ nf, asked }));
    journal['testco-svc-nightly.service'] += '\ntestco-svc-nightly.service: Deactivated successfully.';
    ok('duty: a later successful run of that timer clears it', failing(ctx, { services: { nightly } }).length === 0);
    ctx.journal = realJ;
    fs.writeFileSync(path.join(U, 'testco-station.service'), '[Service]\nWorkingDirectory=' + R + '/starnet\nExecStart=/usr/bin/env node sidecar/index.js\n');
    fs.writeFileSync(path.join(U, 'other-company.service'), '[Service]\nWorkingDirectory=/elsewhere\nExecStart=/usr/bin/python3 /elsewhere/x.py\n');
    fs.writeFileSync(path.join(U, 'capheos-depth-stopgap.service'), '[Unit]\nDescription=stopgap\n[Service]\nExecStart="/usr/bin/python3" "' + R + '/company/work/sim/scripts/rec.py"\nRestart=always\n[Install]\nWantedBy=default.target\n');
    fs.writeFileSync(path.join(U, 'capheos-bank-day.service'), '[Service]\nType=oneshot\nExecStart=/bin/sh ' + R + '/company/work/sim/scripts/bank.sh\nTimeoutStartSec=3h\n');
    fs.writeFileSync(path.join(U, 'capheos-bank-day.timer'), '[Timer]\nOnCalendar=*-*-* 17:30:00 UTC\nPersistent=true\n[Install]\nWantedBy=timers.target\n');
    fs.writeFileSync(path.join(TR, 'run-u42.service'), '[Service]\nExecStart=/usr/bin/python3 ' + R + '/company/work/sim/scripts/rec.py\n');
    let d = duty(ctx);
    ok('duty: finds the units inside ROOT that are not registered (incl. a transient one), not the station or another company', d.due && d.route === 'risk'
      && ['capheos-bank-day.service', 'capheos-bank-day.timer', 'capheos-depth-stopgap.service', 'run-u42.service'].every(u => d.items.some(i => i.id === 'unregistered:' + u))
      && !d.items.some(i => /testco-station|other-company/.test(i.id)) && /transient/.test(d.reason), d);
    ok('duty: the reason is counts and ids only, at most 300 chars; same findings give the same key', d.reason.length <= 300 && !/print\(|echo/.test(d.reason) && duty(ctx).key === d.key);
    fs.appendFileSync(path.join(U, 'testco-svc-depth.service'), '# hand edit\n');
    ok('duty: a registered unit edited by hand is flagged', duty(ctx).items.some(i => i.id === 'edited:testco-svc-depth.service'));
    writeUnits(ctx, read(ctx).services.depth);
    // ---- adopt: as-is (still flagged unscoped), and renamed (scoped, old one disabled and moved)
    // a seat's adopt asks the owner once; a no refuses; the owner does not adopt by name from an agent's run
    let ar = adopt(ctx, 'capheos-depth-stopgap', { by: 'data', why: 'a stopgap recorder' });
    const aq = ar.questionId; const aRow = fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).find(x => x.id === aq);
    ok('adopt by a seat: one owner question (a gate on the exact unit), nothing adopted yet', ar.waiting && ar.asked && aRow && aRow.gate && /^service-adopt:/.test(aRow.gate.ref) && !read(ctx).services['capheos-depth-stopgap'] && adopt(ctx, 'capheos-depth-stopgap', { by: 'data', why: 'a stopgap recorder' }).questionId === aq, ar);
    answer(aq, 'no');
    ok('the owner declined: the seat\'s adopt is refused', throwsCode(() => adopt(ctx, 'capheos-depth-stopgap', { by: 'data', why: 'a stopgap recorder' }), 3) === true);
    ok('an agent run cannot adopt as the owner', throwsCode(() => adopt(ctx, 'capheos-depth-stopgap', { by: 'Pat' }), 3) === true);
    agent = false;
    fake.active['capheos-depth-stopgap.service'] = true; fake.enabled['capheos-depth-stopgap.service'] = true;
    r = adopt(ctx, 'capheos-depth-stopgap', { by: 'Pat', as: 'depth-stopgap', seat: 'data', why: 'stopgap depth recorder, adopted' });
    ok('adopt --as: rebuilt as testco-svc-depth-stopgap, old unit disabled and moved, new one started', r.ok && r.unit === 'testco-svc-depth-stopgap' && !fs.existsSync(path.join(U, 'capheos-depth-stopgap.service'))
      && fs.existsSync(path.join(R, 'company/state/services-adopted/capheos-depth-stopgap.service')) && fake.active['testco-svc-depth-stopgap.service'] && !fake.active['capheos-depth-stopgap.service']
      && /Restart=always/.test(fs.readFileSync(path.join(U, 'testco-svc-depth-stopgap.service'), 'utf8')), r);
    agent = true;
    r = adopt(ctx, 'capheos-bank-day', { by: 'data', seat: 'data' });
    ok('adopt by a seat waits for the owner', r.waiting && r.questionId && !read(ctx).services['capheos-bank-day'], r);
    answer(r.questionId, 'yes');
    const bq = r.questionId;
    r = adopt(ctx, 'capheos-bank-day', { by: 'data', seat: 'data' });
    ok('after the owner\'s yes the seat\'s next run adopts it, recorded with the question', r.ok && read(ctx).services['capheos-bank-day'].approval.questionId === bq
      && /owner approved/.test(read(ctx).services['capheos-bank-day'].approval.via) && fs.readFileSync(path.join(R, 'company/state/services-log.jsonl'), 'utf8').includes('"questionId":"' + bq + '"'), r);
    agent = false;
    d = duty(ctx);
    ok('adopt without --as registers it; the duty then flags it as not company-scoped', r.ok && !r.renamed && d.items.some(i => i.id === 'unscoped:capheos-bank-day') && !d.items.some(i => i.id === 'unregistered:capheos-bank-day.timer'), d);
    r = remove(ctx, 'capheos-bank-day', { by: 'Pat' });
    ok('remove of an adopted, unmanaged unit: unregistered, its files moved aside (kept), not left behind', !read(ctx).services['capheos-bank-day'] && !fs.existsSync(path.join(U, 'capheos-bank-day.timer')) && fs.existsSync(path.join(R, 'company/state/services-adopted/capheos-bank-day.timer')));
    fs.unlinkSync(path.join(TR, 'run-u42.service'));   // a transient unit vanishes once stopped
    r = remove(ctx, 'bank', { by: 'Pat' });
    ok('remove of a managed one disables it and deletes its files', !fs.existsSync(path.join(U, 'testco-svc-bank.timer')) && fake.calls.some(c => /^disable --now testco-svc-bank.timer/.test(c)));
    agent = true;

    // ---- list (the console reads it)
    const L = list(ctx);
    const dep = L.services.find(s => s.name === 'depth');
    ok('list: status, schedule, last run, who asked and why', dep && dep.state === 'running' && dep.scheduleWords === 'runs all the time' && dep.lastRun && dep.byName === 'Halima' && /order-book/.test(dep.why) && dep.scoped, dep);

    // ---- the shims refuse systemctl --user enable/start/daemon-reload for an agent while localComputer is ON
    const C = c => checkCommand(ctx, 'systemctl', c.split(' '));
    ok('shim: enable --now / start / daemon-reload refused for an agent', C('--user enable --now x.timer').refuse && C('--user start x.service').refuse && C('--user daemon-reload').refuse);
    ok('shim: read-only verbs pass', !C('--user status x').refuse && !C('--user list-timers').refuse && !C('--user is-active x').refuse && !C('--user cat x').refuse);
    ok('shim: systemd-run --user refused', checkCommand(ctx, 'systemd-run', ['--user', '--unit', 'x', 'python3', 'a.py']).refuse);
    guardOn = false;
    const un = C('--user enable x.timer');
    ok('shim: guardrail OFF lets it through, logged UNGUARDED', !un.refuse && /UNGUARDED/.test(un.unguarded));
    guardOn = true; agent = false;
    ok('shim: the owner is never refused', !C('--user enable x.timer').refuse);
    agent = true;
    // the real shim file, through PATH-free invocation: a fake "real systemctl" and GUARDRAILS_ASSUME_AGENT=1
    const fakeBin = path.join(T, 'fake-systemctl'); const fakeLog = path.join(T, 'fake.log');
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho "$@" >> ' + fakeLog + '\necho fake-ok\n', { mode: 0o755 });
    const shim = path.join(__dirname, 'shims', 'systemctl');
    const env = Object.assign({}, process.env, { CAPHEOS_ROOT: R, GUARDRAILS_ASSUME_AGENT: '1', SERVICE_REAL_SYSTEMCTL: fakeBin });
    let s = spawnSync('bash', [shim, '--user', 'enable', '--now', 'x.timer'], { env, encoding: 'utf8' });
    ok('shim file: an agent\'s systemctl --user enable exits 3 and never reaches systemctl', s.status === 3 && /service\.js propose/.test(s.stderr) && !fs.existsSync(fakeLog), s.stderr);
    s = spawnSync('bash', [shim, '--user', 'status', 'x'], { env, encoding: 'utf8' });
    ok('shim file: a read-only call passes through to the real one', s.status === 0 && /fake-ok/.test(s.stdout) && /--user status x/.test(fs.readFileSync(fakeLog, 'utf8')), s);
    s = spawnSync('bash', [path.join(__dirname, 'shims', 'systemd-run'), '--user', 'python3', 'x.py'], { env: Object.assign({}, env, { SERVICE_REAL_SYSTEMD_RUN: fakeBin }), encoding: 'utf8' });
    ok('shim file: systemd-run --user exits 3', s.status === 3, s.stderr);
    // the CLI with a fake systemctl through the environment (never the real user manager)
    const fakeSc = path.join(T, 'fake-sc'); const scLog = path.join(T, 'sc.log');
    fs.writeFileSync(fakeSc, '#!/bin/sh\necho "$@" >> ' + scLog + '\ncase "$2" in show) echo ActiveState=active;; is-active) echo active;; esac\n', { mode: 0o755 });
    s = spawnSync(process.execPath, [__filename, 'list', '--json'], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: R, SERVICE_SYSTEMCTL: fakeSc, SERVICE_UNIT_DIR: U }), encoding: 'utf8' });
    let J = null; try { J = JSON.parse(s.stdout); } catch (_) {}
    ok('CLI list --json goes through SERVICE_SYSTEMCTL', s.status === 0 && J && J.services.some(x => x.name === 'depth') && /--user show testco-svc-depth.service/.test(fs.readFileSync(scLog, 'utf8')), s.stderr || s.stdout);
    s = spawnSync(process.execPath, [__filename, '--duty'], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: R, SERVICE_UNIT_DIR: U, SERVICE_TRANSIENT_DIR: TR }), encoding: 'utf8' });
    ok('CLI --duty: exit 0 when nothing is due', s.status === 0, s.stdout + s.stderr);
    fs.writeFileSync(path.join(U, 'capheos-halt-watchdog.service'), '[Service]\nExecStart=/usr/bin/python3 -I ' + R + '/company/work/sim/scripts/rec.py\n');
    s = spawnSync(process.execPath, [__filename, '--duty'], { env: Object.assign({}, process.env, { CAPHEOS_ROOT: R, SERVICE_UNIT_DIR: U, SERVICE_TRANSIENT_DIR: TR }), encoding: 'utf8' });
    J = null; try { J = JSON.parse(s.stdout); } catch (_) {}
    ok('CLI --duty: exit 1 with one JSON object routed to risk', s.status === 1 && J && J.due && J.route === 'risk' && J.items[0].id === 'unregistered:capheos-halt-watchdog.service', s.stdout);
  } catch (e) { bad++; console.log('FAIL selftest threw: ' + (e.stack || e.message)); }
  finally { fs.rmSync(T, { recursive: true, force: true }); }
  console.log(bad ? 'SERVICE SELFTEST FAILED: ' + bad + ' of ' + n : 'SERVICE SELFTEST PASSED: ' + n + ' cases');
  return bad ? 1 : 0;
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); }
  catch (e) { console.error(JSON.stringify({ ok: false, error: e.message })); code = typeof e.code === 'number' ? e.code : 1; }
  process.exitCode = code;
}
