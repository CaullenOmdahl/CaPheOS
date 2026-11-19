#!/usr/bin/env node
/* service.js — the crew's sanctioned background services: a recorder or a daily job that runs between agent runs, as a
 * systemd user unit the company registers, names, limits, halts and shows.
 *
 *   node company/tools/service.js propose <name> --kind service|timer --exec "<argv>" [--every 60s|5min|1h | --on-calendar "<spec>"]
 *        --why "..." --by <seat> [--restart on-failure|always] [--timeout 1h] [--success-exit "3"] [--memory 512M] [--cpu 50%]
 *        [--hosts <host>[,<host>] | --network on] [--soft-halt finish|stop|keep] [--wake <seat>[,<seat>]]
 *        [--plain "what it does, for the owner"] [--if-no "what the crew does instead, for the owner"]
 *        No network unless asked: name the websites the job needs with --hosts (a website the company does not use yet is
 *        an `external` decision). Any network (--hosts or --network on) asks the owner while the localComputer guardrail
 *        is on: the named websites are declared, not enforced, so the card names them and says nothing stops others.
 *        --wake (a timer only): each run's end is recorded like a watched job (company/tools/notify-when.js wraps the
 *        ExecStart and passes its exit code through) and wakes those seats, a failure too; it also satisfies a
 *        `**Waiting on:** service:<name>` line (company/HANDOFFS.md)
 *   node company/tools/service.js list [--json]          every registered service, with its live state (status, schedule, last run, who, why)
 *   node company/tools/service.js status                 the same, in words
 *   node company/tools/service.js stop|start <name> --by <seat>    the seat that asked for it, or the owner
 *   node company/tools/service.js remove <name> --by <seat>        stops it, deletes its unit files, drops it from the register
 *   node company/tools/service.js owner-approve <name>   the console's serviceApprove card effect: installs the spec the owner said yes to (only after that yes)
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
 * MemoryMax (default 512M, at most 4G; 256M and 1G under the low memory profile: lib/memory.js plan), with MemoryHigh at 80 % and
 * MemorySwapMax at 50 % of it and OOMScoreAdjust=300, CPUQuota (default 50%, at most 200%), TasksMax=64, Nice=10, NoNewPrivileges.
 * There is no network unless the proposal asks for it (RestrictAddressFamilies=AF_UNIX): --hosts <host>[,<host>] names the
 * websites it needs (recorded, not enforced by the unit: the owner is told which websites it connects to, never that it
 * reaches only those), --network on opens every website. A timer runs its service
 * as a oneshot. The unit files carry X-CaPheOS-* lines naming the company, the folder and the service.
 *
 * GOVERNANCE. A new service follows the `schedules` self-governance level (auto installs, notify installs and puts one
 * plain line in the owner's daily digest, triage asks the decision model, approve files one owner card), like any other
 * category. With the `localComputer` guardrail ON that holds only for a service in the SAFE PROFILE (safeProfile below:
 * a script and paths in the company folder, which validateArgv already requires; no network at all; the default
 * memory and processor limits; a timer, or a service that restarts only on failure; it finishes or stops in a soft halt).
 * Anything outside it (any network, --hosts included, raised limits, restart always, runs through a soft halt) asks the owner. A website
 * in --hosts that is not on the external-gate allowlist is also an `external` decision (auto: the crew decides; notify:
 * one digest line; approve: the owner's card, category external); the stricter of the two levels wins. The owner is asked only through lib/owner-card.js: one card per exact
 * spec (ref service:<name>:<spec key>), plain words up front, the command and limits only under technical, effect
 * {serviceApprove:{name}} (ownerApprove below); a changed spec withdraws the older card. `propose` is idempotent: run it
 * again after the owner answers and it installs. Start and stop of an approved service belong to the seat that asked for
 * it (and the owner); a --by claim made from somebody else's run is refused (provenance.js callerConflict). adopt is the
 * owner's: a seat's adopt asks through one owner card.
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
    memPlan: o.memPlan || null,   // {defaultMax, ceiling}: lib/memory.js plan().services (a selftest hands in a low one)
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
    // the owner's two doors (lib/owner-card.js, lib/owner-notice.js); a selftest hands in stand-ins with the same contract
    cards: () => o.ownerCard || optional('./lib/owner-card'), notices: () => o.ownerNotice || optional('./lib/owner-notice'),
  };
}
// a module that may not be installed yet: null when it is missing, every other load error is real
function optional(name) {
  try { return require(name); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(path.basename(name))) return null; throw e; }
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
/* the memory a service gets by default and at most: from this machine's size and the company's memory profile
   (company/tools/lib/memory.js plan: 256M / at most 1G under the low profile, 512M / 4G otherwise) */
function memPlan(ctx) {
  if (ctx && ctx.memPlan) return ctx.memPlan;
  let p = { defaultMax: '512M', ceiling: '4G' };
  try { const M = require('./lib/memory'); const h = M.host({ oomd: false }); const s = M.settings(ctx && ctx.config); p = M.plan({ totalMB: h.totalMB, profile: M.profileOf(s, h), keepFreeMB: s.keepFreeMB }).services; } catch (_) {}
  if (ctx) ctx.memPlan = p;
  return p;
}
function limitsOf(o, ctx) {
  const mp = memPlan(ctx);
  const mem = String(o.memory || mp.defaultMax).toUpperCase();
  const mm = mem.match(/^(\d+)(K|M|G)$/); if (!mm) throw err('--memory must look like 256M or 1G');
  const bytes = Number(mm[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 })[mm[2]];
  if (bytes < 16 * 1024 ** 2 || bytes > bytesOf(mp.ceiling)) throw err('--memory must be between 16M and ' + mp.ceiling + ' on this computer (its memory profile)');
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
  // no network unless the proposal asks for it: --hosts names the websites it needs (each one a decision at the
  // `external` self-governance level unless it is already on the external-gate allowlist); --network on opens every
  // website (outside the safe profile). Left out, the unit gets RestrictAddressFamilies=AF_UNIX: nothing leaves.
  const wantsHosts = o.hosts != null && o.hosts !== false;
  if (o.network != null && !['on', 'none'].includes(o.network)) throw err('--network is none (the default: no network) or on (any website; asks the owner while the localComputer guardrail is on). To reach named websites, give --hosts instead');
  const network = o.network === 'on' ? true : o.network === 'none' ? false : wantsHosts;
  // --hosts: the websites it needs (declared and recorded; the computer does not block other websites, so the owner is
  // never told it "only" talks to them)
  let hosts = null;
  if (wantsHosts) {
    if (o.network === 'none') throw err('--hosts and --network none contradict each other');
    hosts = [...new Set(String(o.hosts).split(',').map(h => h.trim().toLowerCase()).filter(Boolean))];
    if (!hosts.length || hosts.some(h => !/^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h))) throw err('--hosts is a comma-separated list of host names, e.g. api.example.com');
  }
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
  return Object.assign({ name, unit: unitOf(ctx, name), kind, argv, schedule: scheduleOf(kind, o), why: why.slice(0, 400), restart, softHalt, network, limits: limitsOf(o, ctx), timeout, successExit }, wake ? { wake } : {}, hosts ? { hosts } : {},
    o.plain && o.plain !== true ? { plain: String(o.plain).replace(/\s+/g, ' ').trim().slice(0, 200) } : {},
    o['if-no'] && o['if-no'] !== true ? { ifNo: String(o['if-no']).replace(/\s+/g, ' ').trim().slice(0, 160) } : {});
}
// the exact spec the owner (or the governance level) agrees to; a field added later joins only when set, so the key of an
// installed service stays what it was
const specKey = s => sha(JSON.stringify([s.kind, s.argv, s.schedule, s.restart, s.softHalt, s.network, s.limits, s.timeout, s.successExit].concat(s.wake && s.wake.length ? [s.wake] : [], s.hosts && s.hosts.length ? [['hosts', s.hosts]] : [])));
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
// a fraction of a MemoryMax value, in whole MB (MemoryHigh at 80 %: the kernel reclaims and slows the service before the hard
// limit; MemorySwapMax at 50 %). OOMScoreAdjust=300: a service goes before the station (100) and its console (200).
function memFrac(max, f) { const b = bytesOf(max); return Number.isFinite(b) ? Math.max(1, Math.floor(b * f / 1048576)) + 'M' : max; }
function render(ctx, e) {
  const head = '# Written by company/tools/service.js for ' + (ctx.config.name || ctx.slug) + '. Change it with service.js, not by hand: a hand edit is flagged.\n';
  const x = 'X-CaPheOS-Company=' + ctx.slug + '\nX-CaPheOS-Root=' + ctx.root + '\nX-CaPheOS-Service=' + e.name + '\n' + (e.hosts && e.hosts.length ? 'X-CaPheOS-Hosts=' + e.hosts.join(',') + '\n' : '');
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
    + 'TimeoutStopSec=90s\nMemoryHigh=' + memFrac(e.limits.memoryMax, 0.8) + '\nMemoryMax=' + e.limits.memoryMax + '\nMemorySwapMax=' + memFrac(e.limits.memoryMax, 0.5) + '\nOOMScoreAdjust=300\nCPUQuota=' + e.limits.cpuQuota + '\nTasksMax=64\nNice=10\nNoNewPrivileges=yes\n'
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

/* ---------------- the safe profile, and the owner's card ---------------- */
const DEFAULT_LIMITS = { memoryMax: '512M', cpuQuota: '50%' };
const bytesOf = m => { const x = String(m || '').toUpperCase().match(/^(\d+)(K|M|G)$/); return x ? Number(x[1]) * ({ K: 1024, M: 1024 ** 2, G: 1024 ** 3 })[x[2]] : Infinity; };
function allowlist(ctx) {
  try { return fs.readFileSync(ctx.P('company', 'state', 'external-allowlist.txt'), 'utf8').split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')); } catch (_) { return []; }
}
// the same matching as the external gate (lib/governance.js allowlisted): a host, a parent domain, or a *.domain entry
const hostAllowed = (list, h) => list.some(e => (e.startsWith('*.') ? (h === e.slice(2) || h.endsWith(e.slice(1))) : (h === e || h.endsWith('.' + e))));
/* safeProfile(ctx, e) -> {safe, reasons: [{plain, crew}]} — may this service follow the schedules level while the
 * localComputer guardrail is on? validateArgv has already kept the script and every path inside the company folder.
 * Any network is outside the safe profile: the websites a job names (--hosts) are declared, not enforced (the unit drops
 * RestrictAddressFamilies and blocks no host), so a named website is no safer than open network. Only a job with no
 * network stays inside it (the crew installs it at the schedules level). The new websites still go through the
 * `external` level as well (decision below), so the stricter of the two decides. */
function safeProfile(ctx, e) {
  const reasons = [];
  if (e.network && e.hosts && e.hosts.length) {
    const st = sites(ctx, e);
    reasons.push({ plain: 'It connects to ' + sitesWords(e.hosts) + (st.fresh.length ? ', which is new to the crew,' : '') + ' but nothing stops it reaching others, so company data could leave.',
      crew: 'network on: websites declared (' + e.hosts.join(', ') + '), not enforced' });
  } else if (e.network) reasons.push({ plain: 'It could connect to any website, which risks company data leaving this computer.', crew: 'network open (--network on, no --hosts)' });
  if (bytesOf(e.limits && e.limits.memoryMax) > bytesOf(memPlan(ctx).defaultMax) || parseInt((e.limits && e.limits.cpuQuota) || '0', 10) > parseInt(DEFAULT_LIMITS.cpuQuota, 10))
    reasons.push({ plain: 'It may use more of this computer\'s memory or power than usual, which risks slowing it down.', crew: 'raised limits: MemoryMax=' + e.limits.memoryMax + ' CPUQuota=' + e.limits.cpuQuota });
  if (e.kind === 'service' && e.restart === 'always') reasons.push({ plain: 'It restarts itself whenever it stops, which keeps it going even when something is wrong.', crew: 'Restart=always' });
  if (e.softHalt === 'keep') reasons.push({ plain: 'It keeps running even when you pause the company.', crew: '--soft-halt keep' });
  return { safe: !reasons.length, reasons };
}
/* the websites a job declared, and which of them are new: a host on the external-gate allowlist is one the company
 * already uses (the owner's own list, or an add-on the owner installed); any other host is an `external` decision */
function sites(ctx, e) {
  const hosts = (e && e.network && e.hosts) || [];
  const list = allowlist(ctx);
  return { hosts, fresh: hosts.filter(h => !hostAllowed(list, h.replace(/^\*\./, ''))) };
}
// a website by the name people know it by: api.elections.kalshi.com -> Kalshi
function siteName(h) {
  const parts = String(h || '').replace(/^\*\./, '').toLowerCase().split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const sld = parts.length >= 3 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? parts[parts.length - 3] : parts[parts.length - 2];
  return /^[a-z][a-z0-9-]{1,30}$/.test(sld) ? sld.replace(/-/g, ' ').replace(/(^|\s)\S/g, c => c.toUpperCase()) : null;
}
// "the Kalshi website" / "the Kalshi and Pyth websites" / "3 websites"
function sitesWords(hosts) {
  const names = [...new Set((hosts || []).map(siteName))];
  if (!names.length || names.some(n => !n)) return (hosts || []).length === 1 ? 'one website' : (hosts || []).length + ' websites';
  if (names.length === 1) return 'the ' + names[0] + ' website';
  if (names.length === 2) return 'the ' + names[0] + ' and ' + names[1] + ' websites';
  return names.length + ' websites';
}
// when it runs, in everyday words (a calendar spec the words cannot follow becomes "on a set schedule")
function plainWhen(sched) {
  if (!sched) return null;
  if (sched.every) {
    const m = String(sched.every).match(/^(\d+)(d|h|min|s)$/); if (!m) return 'on a set schedule';
    const n = Number(m[1]); const unit = { d: 'day', h: 'hour', min: 'minute', s: 'second' }[m[2]];
    if (n === 1) return m[2] === 'd' ? 'once a day' : 'every ' + unit;
    return 'every ' + n + ' ' + unit + 's';
  }
  const c = String(sched.onCalendar || '').trim().match(/^(?:(?:\*-\*-\*|daily)\s+)?(\d{1,2}):(\d{2})(?::\d{2})?(?:\s+\S+)?$/i);
  if (!c) return 'on a set schedule';
  const h = Number(c[1]), mi = Number(c[2]); if (h > 23 || mi > 59) return 'on a set schedule';
  const part = h < 6 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  const h12 = (h % 12) || 12, ap = h < 12 ? 'am' : 'pm';
  return 'every ' + part + (mi === 0 ? ' at ' : ' a little after ') + h12 + ' ' + ap;
}
const plainOk = t => { try { return require('./lib/owner-scope').plainScore(t, { approval: true }).ok; } catch (_) { return false; } };
// the crew's facts about the service: the card's technical part, never its lead
function factsOf(ctx, e, who) {
  const cmd = e.argv.map(a => a.startsWith(ctx.root + '/') ? a.slice(ctx.root.length + 1) : a).join(' ');
  return ['**Name:** ' + e.name + ' (the computer calls it ' + e.unit + ')', '**What it runs:** `' + cmd + '`', '**When:** ' + scheduleWords(e.schedule),
    '**Why:** ' + e.why, '**Asked by:** ' + who.name, '**Limits:** at most ' + e.limits.memoryMax + ' of memory and ' + e.limits.cpuQuota + ' of one processor; '
      + (e.network ? (e.hosts && e.hosts.length ? 'network, declared for ' + e.hosts.join(', ') + ' (declared, not enforced: the unit does not block other hosts)' : 'it may use the network (any host)') : 'no network (RestrictAddressFamilies=AF_UNIX)') + '; it restarts ' + (e.kind === 'timer' ? 'never (it runs once per turn)' : e.restart === 'always' ? 'whenever it stops' : 'if it fails'),
    '**In a soft halt:** ' + (e.kind === 'timer' ? 'it stops firing; a run in progress finishes' : e.softHalt === 'keep' ? 'it keeps running (a hard halt stops it)' : 'it is asked to finish and stop'),
    '**You can stop or remove it any time** in Settings › System › Background services.'].join('\n');
}
// what the job reaches, in words that are true: no network is enforced (RestrictAddressFamilies), named websites are
// declared, not enforced, so the owner is told which websites it connects to, never that it reaches "only" those
function reachWords(ctx, e) {
  if (!e.network) return 'It keeps to company files and cannot reach the internet.';
  if (!e.hosts || !e.hosts.length) return null;
  const s = sites(ctx, e);
  return 'It connects to ' + sitesWords(e.hosts) + (s.fresh.length ? ', which the crew has not used before.' : ', which the crew already uses.');
}
// "Halima wants a background job to run every night at 2 am on this computer." + what it touches, or why it needs a yes
function plainLead(ctx, e, who, prof) {
  const when = e.kind === 'timer' ? 'run ' + plainWhen(e.schedule) : 'keep running';
  const first = who.name + ' wants a background job to ' + when + ' on this computer.';
  const what = e.plain && plainOk(e.plain) ? e.plain.replace(/[.!]?$/, '.') : null;
  // outside the safe profile: its first risk sentence, and the websites it connects to whenever that sentence is not
  // already the one about them (a yes never approves a website the card did not name)
  const reach = reachWords(ctx, e);
  const second = prof.reasons.length ? prof.reasons[0].plain + (e.network && e.hosts && e.hosts.length && !/website/.test(prof.reasons[0].plain) && reach ? ' ' + reach : '') : reach || 'It keeps to company files.';
  return [what ? first + ' ' + what : null, first + ' ' + second, who.name + ' wants a background job on this computer. ' + second].filter(Boolean).find(plainOk) || who.name + ' wants a background job on this computer. ' + second;
}
// the digest line after a job was set up without asking: what it does, and what it reaches
function plainDone(ctx, e, who) {
  const when = e.kind === 'timer' ? 'to run ' + plainWhen(e.schedule) : 'that keeps running';
  const first = who.name + ' set up a background job ' + when + ' on this computer.';
  // a notice, not a question: the card's word check (no jargon, ids, paths), not the ask's "what you get" rule
  const words = t => { try { return require('./lib/owner-card').plain(t); } catch (_) { return false; } };
  const what = e.plain && words(e.plain) ? e.plain.replace(/[.!]?$/, '.') : null;
  const reach = reachWords(ctx, e) || 'It can reach any website.';
  return [what ? first + ' ' + what + ' ' + reach : null, first + ' ' + reach].filter(Boolean).find(t => !require('./lib/owner-scope').wordsProblems(t).length) || who.name + ' set up a background job on this computer. ' + reach;
}
// the crew's advice, never a canned reason: the proposer's own plain sentence (--plain) is in the lead; a job outside the
// safe profile is never "recommended" over its own risk sentence
function plainRecommendation(e, who, prof) {
  if (prof.reasons.length) return 'Say yes only if that risk is acceptable to you. If you say no or do not answer, nothing is installed.';
  const ifNo = e.ifNo && plainOk('If you say no, ' + e.ifNo.replace(/[.!]?$/, '.')) ? e.ifNo.replace(/^./, c => c.toLowerCase()).replace(/[.!]?$/, '.') : null;
  const t = ifNo ? who.name + ' recommends yes. If you say no, ' + ifNo : null;
  return t && plainOk(t) ? t : who.name + ' recommends yes, because it keeps that work going between the crew\'s sessions. If you say no or do not answer, nothing is installed.';
}
/* askOwner(ctx, e, who, ref, category, prof) -> what lib/owner-card.js file() returned ({filed, id} or {filed:false, route}) */
// the card's technical part: the exact spec and whether it is inside the safe profile (ownerApprove compares it again)
const cardTechnical = (ctx, e, who, category, prof) => { const st = sites(ctx, e); return factsOf(ctx, e, who) + '\n' + (prof.reasons.length ? '**Outside the safe profile:** ' + prof.reasons.map(r => r.crew).join('; ') : '**Inside the safe profile**; asked because self-governance has ' + category + ' at approve.')
  + (st.fresh.length ? '\n**Websites not on the external-gate allowlist:** ' + st.fresh.join(', ') + ' (an `external` decision).' : ''); };
function askOwner(ctx, e, who, ref, category, prof) {
  const C = ctx.cards();
  if (!C) return { filed: false, route: 'missing', reason: 'lib/owner-card.js is not installed' };
  const technical = cardTechnical(ctx, e, who, category, prof);
  try {
    // outside the safe profile with the localComputer guardrail on, the GUARDRAIL asks the owner: like a fixed gate, no
    // standing ruling or governance level hands it to the crew (guardrail:true)
    return C.file({ asker: who.seat || who.name, category, ref, lead: plainLead(ctx, e, who, prof), guardrail: category === 'localComputer' || undefined,
      consequence: 'If you say yes, the crew sets it up and you keep the power to stop it in Settings. If you say no, nothing is installed.',
      recommendation: plainRecommendation(e, who, prof),
      technical, effect: { serviceApprove: { name: e.name } } }, { root: ctx.root }) || { filed: false, route: 'failed' };
  } catch (x) { logRow(ctx, { event: 'owner-card-failed', name: e.name, code: x.code || null, error: String(x.message).slice(0, 300) }); return { filed: false, route: 'failed', reason: x.message }; }
}
// ONLY crew, digest or a crew-decides ruling lets the crew go ahead; a recent "not now" or a never-ask ruling is the
// owner's no (lib/owner-card.js coveredByCrew / refusedByOwner)
const coveredByCrew = r => require('./lib/owner-card').coveredByCrew(r);
const refusedByOwner = r => require('./lib/owner-card').refusedByOwner(r);
// the owner's card for this ref is service.js's own: it carries {serviceApprove:{name}}, an effect lib/pm-inbox-guard.js
// keeps only on a card service.js itself recorded
const ourCard = (q, name) => !!(q && q.effect && q.effect.serviceApprove && q.effect.serviceApprove.name === name);
function tellOwner(ctx, o) {
  try {
    const N = ctx.notices();
    if (N) return N.send({ kind: 'fyi', from: o.from, text: o.text, technical: o.technical, key: o.key }, { root: ctx.root });
    return require('./lib/governance').fyi({ from: o.from, text: o.text, technical: o.technical, key: o.key }, Object.assign({}, ctx.gov, { root: ctx.root }));
  } catch (x) { logRow(ctx, { event: 'owner-notice-failed', key: o.key, error: String(x.message).slice(0, 200) }); return null; }
}
/* ASKS: what the triage path's governance question says to the owner (lib/governance.js decide): plain words, the
 * service name and its schedule in `technical`. Exported so a test files it at approve. */
const ASKS = {
  triage: e => ({ summary: 'set up a background job that ' + (e.kind === 'timer' ? 'runs ' + (plainWhen(e.schedule) || 'on a set schedule') : 'keeps running') + ' on this computer',
    recommendation: e.plain && require('./lib/governance').plainPart(String(e.plain).replace(/[.!]$/, '')) ? 'yes: ' + String(e.plain).replace(/[.!]$/, '').replace(/^./, c => c.toLowerCase()) : 'yes', default: 'nothing is installed',
    technical: 'Run the background service ' + e.name + ' (' + scheduleWords(e.schedule) + '): ' + String(e.why || '').slice(0, 200) }),
};
// may this proposal go ahead? -> {allowed, waiting?, denied?, questionId?, level, via, tell?}
// Two decisions, the stricter one wins: the job itself (the `schedules` level, or the owner while the localComputer
// guardrail is on and it is outside the safe profile) and the websites it declares that the company does not use yet
// (the `external` level; a website on the external-gate allowlist is not asked about again).
const RANK = { auto: 0, notify: 1, triage: 2, approve: 3 };
function decision(ctx, e, who, ref) {
  const gov = require('./lib/governance');
  if (who.owner) return { allowed: true, level: 'owner', via: 'owner' };
  const lcOn = ctx.guard('localComputer');
  const prof = safeProfile(ctx, e);
  const outside = lcOn && !prof.safe;
  const st = sites(ctx, e);
  const jobLevel = outside ? 'approve' : gov.level('schedules', Object.assign({ triage: true }, ctx.gov));
  // a new website: the external level (triage there reads as approve: the triage model is the schedules question's)
  const siteLevel = st.fresh.length || (!lcOn && e.network && !(e.hosts && e.hosts.length)) ? gov.level('external', Object.assign({}, ctx.gov, { level: undefined })) : 'auto';   // a test's level override is the schedules one
  const level = RANK[siteLevel] > RANK[jobLevel] ? siteLevel : jobLevel;
  // the card's category: the guardrail's, the websites' when only they need the owner, else the job's
  const category = outside ? 'localComputer' : RANK[siteLevel] > RANK[jobLevel] && siteLevel === 'approve' ? 'external' : 'schedules';
  const via = (outside ? 'localComputer guardrail on, outside the safe profile (' + prof.reasons.map(r => r.crew).join('; ') + ')' : 'schedules ' + jobLevel + (lcOn ? ' (localComputer guardrail on, inside the safe profile)' : ' (localComputer guardrail off)'))
    + (st.fresh.length ? '; new websites ' + st.fresh.join(', ') + ': external ' + siteLevel : st.hosts.length ? '; websites on the allowlist: ' + st.hosts.join(', ') : '');
  if (level === 'auto') return { allowed: true, level, via };
  if (level === 'notify') return { allowed: true, level, via, tell: true };
  if (level === 'triage') {
    const d = gov.decide('schedules', Object.assign({ by: who.name, ref }, ASKS.triage(e)), ctx.gov);
    return { allowed: !!d.allowed, waiting: !d.allowed && !d.denied, denied: !!d.denied, questionId: d.questionId || null, level: d.level, via: 'schedules ' + d.level + (lcOn ? ' (inside the safe profile)' : ' (localComputer guardrail off)'), tell: !!d.allowed && d.level !== 'auto' };
  }
  const q = gov.questionFor(ref, ctx.gov);
  if (q) {
    const a = gov.approved(ref, ctx.gov);
    if (a === true && !ourCard(q, e.name)) return { allowed: false, waiting: true, level: 'approve', questionId: null, error: 'the yes on ' + q.id + ' is to a card service.js did not file; nothing is installed' };
    if (a === true) return { allowed: true, level: 'approve', questionId: q.id, via: via + ': owner said yes to ' + q.id };
    if (a === false) return { allowed: false, denied: true, level: 'approve', questionId: q.id };
    const closed = gov.inboxRows(ctx.gov).some(r => r.id === q.id && ['close', 'reclassify', 'withdraw'].includes(r.type));
    if (!closed) return { allowed: false, waiting: true, level: 'approve', questionId: q.id };
  }
  const r = askOwner(ctx, e, who, ref, category, prof);
  if (refusedByOwner(r)) return { allowed: false, denied: true, level: 'approve', questionId: (r.backoff && r.backoff.id) || null, refused: r.reason || r.route };
  if (coveredByCrew(r)) return { allowed: true, level: 'approve', via: via + '; not asked: ' + (r.reason || r.route) };
  if (r.filed || r.route === 'duplicate') return { allowed: false, waiting: true, level: 'approve', questionId: r.id || null, asked: !!r.filed };
  return { allowed: false, waiting: true, level: 'approve', questionId: null, error: 'the owner could not be asked (' + (r.reason || r.route) + '); nothing is installed' };
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
    // installed before network became opt-in: the same proposal without --network/--hosts is the job as it was installed
    if (o.network == null && !(o.hosts != null && o.hosts !== false) && old.network === true && old.specKey === specKey(Object.assign({}, spec, { network: true })))
      return { ok: true, already: true, name, unit: old.unit, status: old.status, note: 'installed with the network open (before --network became opt-in); remove and propose again to close it' };
    throw err('"' + name + '" is already installed with a different command or schedule; remove it first, or propose a new name', 2);
  }
  const ref = 'service:' + name + ':' + key;
  // the same name proposed again with a different spec: the owner's card for the older spec goes, never a second card
  if (old && old.status === 'proposed' && old.specKey && old.specKey !== key) {
    const C = ctx.cards();
    if (C && typeof C.withdraw === 'function') { try { C.withdraw({ ref: 'service:' + name + ':' + old.specKey, by: who.seat || who.name, why: 'replaced by a newer proposal for ' + name }, { root: ctx.root }); } catch (x) { logRow(ctx, { event: 'owner-card-withdraw-failed', name, error: String(x.message).slice(0, 200) }); } }
    logRow(ctx, { event: 'replaced', name, by: who.seat || 'owner', oldKey: old.specKey, newKey: key });
  }
  const d = decision(ctx, spec, who, ref);
  const e = Object.assign({}, spec, { specKey: key, by: who.seat || 'owner', byName: who.name, proposedAt: (old && old.specKey === key && old.proposedAt) || new Date(ctx.now()).toISOString(),
    approval: { level: d.level, questionId: d.questionId || null, via: d.via || null, guardrail: ctx.guard('localComputer') ? 'on' : 'off' } });
  if (d.denied) { e.status = 'declined'; doc.services[name] = e; write(ctx, doc); logRow(ctx, { event: 'declined', name, by: e.by, questionId: d.questionId, refused: d.refused || undefined });
    throw err(d.refused ? 'the owner\'s no stands (' + d.refused + '); "' + name + '" is not installed' : 'the owner said no to ' + d.questionId + '; "' + name + '" is not installed', 3); }
  if (!d.allowed) {
    e.status = 'proposed'; doc.services[name] = e; write(ctx, doc);
    if (d.asked) logRow(ctx, { event: 'proposed', name, by: e.by, questionId: d.questionId, argv: e.argv, schedule: e.schedule });
    if (d.error) return { ok: false, waiting: true, name, unit: e.unit, questionId: null, text: d.error };
    return { ok: true, waiting: true, name, unit: e.unit, questionId: d.questionId, text: 'Asked the owner (' + d.questionId + '). Run the same propose again after they answer yes; it then installs (or the console installs it on their yes).' };
  }
  e.approval.at = new Date(ctx.now()).toISOString();
  install(ctx, e, doc);
  write(ctx, doc);
  logRow(ctx, { event: 'installed', name, unit: e.unit, by: e.by, via: e.approval.via, argv: e.argv, schedule: e.schedule });
  if (d.tell) tellOwner(ctx, { from: who.name, key: ref, text: plainDone(ctx, e, who),
    technical: factsOf(ctx, e, who) + '\nInstalled without asking: ' + e.approval.via + '.' });
  return { ok: !e.lastError, name, unit: e.unit, status: e.status, halted: !!e.halt, error: e.lastError || undefined };
}
/* ownerApprove(name, opts) -> {ok, installed|already|waiting} — the console's {serviceApprove:{name}} card effect, run on
 * the owner's answer. It installs only the exact spec the owner's card was about, and only on a verified owner yes to that
 * card (lib/governance.js approved): calling it never stands in for the owner. Idempotent with the seat's own re-propose. */
function ownerApprove(name, opts) {
  const ctx = opts && opts.ctx ? opts.ctx : context(opts);
  const gov = require('./lib/governance');
  const doc = read(ctx); const e = doc.services[name];
  if (!e) throw err('no registered service "' + name + '"', 2);
  if (e.status === 'installed') return { ok: true, already: true, name, status: e.status };
  if (e.status !== 'proposed' || !e.specKey) return { ok: false, name, status: e.status, text: '"' + name + '" is ' + e.status + '; nothing to install' };
  // services.json is reported, never undone, when someone else edits it: nothing in the entry is trusted as written.
  // The spec is checked again exactly as propose checks it, and its key must be the key of what it holds now.
  const refuse = why => { logRow(ctx, { event: 'owner-approve-refused', name, why }); return { ok: false, refused: true, name, text: 'not installed: ' + why }; };
  try {
    const argv = validateArgv(ctx, e.argv);
    if (JSON.stringify(argv) !== JSON.stringify(e.argv)) return refuse('the command in the registry is not the one propose would write');
    const lim = limitsOf({ memory: e.limits && e.limits.memoryMax, cpu: e.limits && e.limits.cpuQuota }, ctx);
    if (JSON.stringify(lim) !== JSON.stringify(e.limits)) return refuse('the limits in the registry are not ones propose allows');
    if (e.unit !== unitOf(ctx, name) || e.name !== name || !['service', 'timer'].includes(e.kind)) return refuse('the registry entry names another unit');
  } catch (x) { return refuse(x.message); }
  if (specKey(e) !== e.specKey) return refuse('the registry entry was changed after it was proposed (its key does not match what it holds)');
  const ref = 'service:' + name + ':' + e.specKey;
  if (gov.approved(ref, ctx.gov) !== true) return { ok: false, waiting: true, name, text: 'no owner yes to the card for this version of "' + name + '" yet' };
  const q = gov.questionFor(ref, ctx.gov);
  // the owner said yes to service.js's own card, and that card described exactly this spec and safe profile
  if (!ourCard(q, name)) return refuse('the owner\'s yes is to a card service.js did not file');
  {
    const crew = ctx.crew(); const who = { seat: e.by, name: e.byName || (crew[e.by] && crew[e.by].name) || e.by };
    const prof = safeProfile(ctx, e);
    const cat = (q.gate && (q.gate.governanceCategory || q.gate.category)) || 'schedules';
    if (prof.reasons.length && cat !== 'localComputer' && ctx.guard('localComputer')) return refuse('the job is outside the safe profile, but the card said it was inside');
    if ((q.technical || '') !== cardTechnical(ctx, e, who, cat, prof) || q.message !== plainLead(ctx, e, who, prof)) return refuse('the card the owner saw does not describe this job as it is now');
  }
  e.approval = Object.assign({}, e.approval || {}, { level: 'approve', questionId: q ? q.id : null, via: 'the owner said yes to ' + (q ? q.id : ref) + ' on Today', at: new Date(ctx.now()).toISOString() });
  install(ctx, e, doc); write(ctx, doc);
  logRow(ctx, { event: 'installed', name, unit: e.unit, by: e.by, via: e.approval.via, argv: e.argv, schedule: e.schedule });
  return { ok: !e.lastError, installed: true, name, unit: e.unit, status: e.status, halted: !!e.halt, error: e.lastError || undefined };
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
  const cmd = words.map(a => a.startsWith(ctx.root + '/') ? a.slice(ctx.root.length + 1) : a).join(' ');
  const facts = ['**Program:** ' + base, '**What it runs:** `' + cmd + '`', '**Name it would get:** ' + (o.as || base + ' (unchanged)'), '**Owner seat:** ' + (o.seat || who.name),
    '**Why:** ' + String(o.why || 'not given'), '**Asked by:** ' + who.name, '**On a yes:** ' + who.name + '\'s next run adopts it (service.js adopt, recorded with the card).'].join('\n');
  const C = ctx.cards();
  if (!C) return { waiting: true, questionId: null, error: 'the owner could not be asked (lib/owner-card.js is not installed)' };
  let r;
  try {
    r = C.file({ asker: who.seat || who.name, category: 'localComputer', ref,
      lead: who.name + ' found a background job on this computer that the crew never set up properly, and wants to take it over. That keeps it easy to see and stop.',
      consequence: 'If you say yes, it runs under the company\'s rules and you keep the power to stop it in Settings. If you say no, it stays as it is.',
      recommendation: 'The crew recommends yes, because it keeps every background job in one place. If you do not answer, nothing changes.',
      technical: facts, effect: { none: true } }, { root: ctx.root }) || { filed: false, route: 'failed' };
  } catch (x) { logRow(ctx, { event: 'owner-card-failed', name: base, code: x.code || null, error: String(x.message).slice(0, 300) }); r = { filed: false, route: 'failed', reason: x.message }; }
  if (coveredByCrew(r)) return { approved: true, questionId: null, who, via: 'not asked: ' + (r.reason || r.route) };
  if (r.filed || r.route === 'duplicate') return { waiting: true, asked: !!r.filed, questionId: r.id || null };
  return { waiting: true, questionId: null, error: 'the owner could not be asked (' + (r.reason || r.route) + ')' };
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
  if (g.waiting) return { ok: false, waiting: true, questionId: g.questionId, asked: !!g.asked, note: g.error || 'the owner decides on Today or in chat; run this again after the answer' };
  const via = g.approved ? (g.questionId ? 'adopted after the owner approved ' + g.questionId : 'adopted, ' + g.via) + ' (asked by ' + g.who.name + ')' : null;
  const byWord = g.approved ? (g.questionId ? 'owner (' + g.questionId + ')' : g.who.seat + ' (' + g.via + ')') : 'owner';
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
    'soft-halt': o['soft-halt'], memory: o.memory, cpu: o.cpu,
    // the unit keeps the network it had (an adopted unit was made outside this tool, often with the network open)
    network: o.network || (one(u, 'Service.RestrictAddressFamilies') ? 'none' : 'on'), hosts: o.hosts });
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
  // an owner job the console started (console/owner-ops.js: <svc>-owner-job-<id>.service, transient) is the framework's
  const ownerJob = f => f.startsWith(ctx.stationSvc + '-owner-job-') && require('./lib/owned').OWNER_JOB.test(f.slice(ctx.stationSvc.length));
  const unregistered = [...inScope].filter(f => !fw.has(f) && !reg.has(f) && !ownerJob(f)).sort();
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
    + 'node company/tools/service.js propose <name> --kind service|timer --exec "python3 company/work/.../script.py ..." --why "..." --by <your seat> [--hosts <the websites it needs>] [--plain "what it does, in everyday words"] (no network unless you name the websites with --hosts; start/stop are then yours with service.js start|stop).' };
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
  // the console's {serviceApprove:{name}} card effect: installs only the spec the owner's recorded yes was about
  if (cmd === 'owner-approve') { const r = ownerApprove(o._[0], { ctx }); print(r); return r.waiting ? 4 : r.ok ? 0 : 1; }
  console.error('usage: service.js propose|list|status|stop|start|remove|adopt|owner-approve|--duty|selftest (header of company/tools/service.js)'); return 2;
}

module.exports = { ASKS, context, propose, ownerApprove, safeProfile, sites, siteName, sitesWords, plainLead, plainDone, plainRecommendation, decision, plainWhen, startStop, remove, adopt, onHalt, list, findings, duty, checkCommand, validateArgv, splitWords, render, specOf, unitOf, _internals: { frameworkUnits } };

/* ---------------- selftest: temp company, fake systemctl, no real user manager ---------------- */
function selftest() {
  // a selftest measures the mechanism, not the caller (fr-0018): run by an agent, this process IS under the station, and the
  // owner-answer guard would refuse the fixture's own answer. Pin it for the test (provenance.js:122), restore after.
  try { const P = require('./provenance.js'); P.pinUnderStation(false); P.pinOwnerShell(true); } catch (_) {}
  const { spawnSync } = require('child_process');
  const T = require('./lib/temp-life').tmpDir('service-selftest-');
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
    // the owner's two doors as stand-ins with the shared contract; the stand-in reads the level from governance.json, so
    // the cases below that set govLevel write it there too
    const stubs = require('./tests/helpers/owner-stubs.js'); const notice = stubs.makeOwnerNotice(); const card = stubs.makeOwnerCard(R, { notice });
    const setLevel = lv => { govLevel = lv; const g = JSON.parse(fs.readFileSync(path.join(R, 'company/defaults/state/governance.json'), 'utf8')); if (lv) g.categories.schedules = lv; fs.writeFileSync(path.join(R, 'company/state/governance.json'), JSON.stringify(g)); };
    const lastCard = () => card.calls.filter(c => c.op === 'file').pop().card;
    const plainCard = c => ['lead', 'consequence', 'recommendation'].every(k => require('./lib/owner-scope').plainScore(c[k], { approval: true }).ok);
    const journal = {};
    const ctx = context({ root: R, unitDir: U, transientDir: TR, systemctl, journal: u => journal[u] || '', now: () => Date.parse('2026-11-17T10:00:00Z'), isAgent: () => agent, ownerShell: () => !agent,
      guard: nm => nm === 'localComputer' ? guardOn : true, halted: () => halted, callerConflict: () => conflict,
      gov: { root: R, get level() { return govLevel || undefined; } }, ownerCard: card, ownerNotice: notice, memPlan: { defaultMax: '512M', ceiling: '4G' } });
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
    let r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs', 'soft-halt': 'finish', network: 'on' });
    const q = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
    ok('guardrail ON, --network on (outside the safe profile): propose waits for the owner with one card', r.waiting && q.id === r.questionId && q.gate.category === 'localComputer' && q.effect && q.effect.serviceApprove && q.effect.serviceApprove.name === 'depth', r);
    ok('the card is plain up front; name, command, schedule and why only under technical', plainCard(lastCard()) && lastCard().lead === 'Halima wants a background job to keep running on this computer. It could connect to any website, which risks company data leaving this computer.'
      && !/depth|rec\.py|testco|python/.test(lastCard().lead + lastCard().consequence + lastCard().recommendation)
      && /depth/.test(q.technical) && /rec\.py --hz 1/.test(q.technical) && /runs all the time/.test(q.technical) && /order-book depth/.test(q.technical) && /network open/.test(q.technical) && /^Say yes only if that risk is acceptable/.test(lastCard().recommendation), lastCard());
    ok('nothing installed before the answer', !fs.existsSync(path.join(U, 'testco-svc-depth.service')) && !fake.calls.some(c => /^(enable|start)/.test(c)));
    r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs', network: 'on' });
    ok('a rerun before the answer does not ask twice', r.waiting && fs.readFileSync(inbox, 'utf8').trim().split('\n').length === 1);
    answer(q.id, 'yes');
    r = propose(ctx, 'depth', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs', network: 'on' });
    const unit = fs.readFileSync(path.join(U, 'testco-svc-depth.service'), 'utf8');
    ok('after yes: installed, enabled and started', r.ok && r.status === 'installed' && fake.active['testco-svc-depth.service'] && fake.calls.includes('daemon-reload'), r);
    ok('unit: company-scoped name, WorkingDirectory=ROOT, Restart, limits, no network rule', /WorkingDirectory=/.test(unit) && unit.includes('WorkingDirectory=' + R + '\n') && /Restart=on-failure/.test(unit)
      && /MemoryMax=512M/.test(unit) && /CPUQuota=50%/.test(unit) && /NoNewPrivileges=yes/.test(unit) && !/RestrictAddressFamilies/.test(unit) && /X-CaPheOS-Company=testco/.test(unit), unit);
    ok('unit: MemoryHigh at 80 % and MemorySwapMax at 50 % of MemoryMax, OOMScoreAdjust 300', /MemoryHigh=409M\nMemoryMax=512M\nMemorySwapMax=256M\nOOMScoreAdjust=300\n/.test(unit), unit);
    { // the low memory profile (a small machine): a smaller default, a lower ceiling
      const low = context({ root: R, unitDir: U, transientDir: TR, systemctl, isAgent: () => false, ownerShell: () => true, guard: () => true, halted: () => false, callerConflict: () => null, gov: { root: R }, ownerCard: card, ownerNotice: notice, memPlan: { defaultMax: '256M', ceiling: '1G' } });
      const sp = specOf(low, 'smallbox', { kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --hz 1', why: 'records order-book depth between agent runs', network: 'none' }, { resolve: false });
      ok('low profile: a proposal gets 256M by default', sp.limits.memoryMax === '256M', sp.limits);
      ok('low profile: 2G is refused as over the 1G ceiling', throwsCode(() => specOf(low, 'bigbox', { kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py', why: 'records order-book depth between agent runs', network: 'none', memory: '2G' }, { resolve: false }), 2, /between 16M and 1G/) === true);
      ok('low profile: 512M counts as raised limits (over the plan\'s default)', safeProfile(low, Object.assign({}, sp, { limits: { memoryMax: '512M', cpuQuota: '50%' } })).reasons.some(x => /raised limits/.test(x.crew)));
      ok('low profile: the rendered unit carries MemoryHigh', /MemoryHigh=204M\nMemoryMax=256M/.test(render(low, sp)['testco-svc-smallbox.service'])); }
    ok('unit ExecStart is quoted absolute argv', /ExecStart="[^"]*python3" "[^"]*rec\.py" "--hz" "1"/.test(unit), unit);
    const reg = read(ctx).services.depth;
    ok('services.json records who, why, approval and the unit hash', reg.by === 'data' && /order-book/.test(reg.why) && reg.approval.questionId === q.id && reg.files['testco-svc-depth.service']);
    // a declined one: a safe-profile timer while schedules is at approve gets a card too (category schedules)
    setLevel('approve');
    r = propose(ctx, 'tape', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', 'on-calendar': '*-*-* 18:00:00 UTC', why: 'banks the trade tape once a day', network: 'none' });
    const q2 = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
    ok('a safe-profile timer at schedules=approve: one plain card in the schedules category', q2.gate.category === 'schedules' && lastCard().lead === 'Halima wants a background job to run every evening at 6 pm on this computer. It keeps to company files and cannot reach the internet.' && plainCard(lastCard()), lastCard());
    answer(q2.id, 'no');
    ok('a no is final: refused with exit code 3', throwsCode(() => propose(ctx, 'tape', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', 'on-calendar': '*-*-* 18:00:00 UTC', why: 'banks the trade tape once a day', network: 'none' }), 3, /said no/) === true);
    // guardrail ON, schedules=auto: a safe-profile timer installs with no card and nothing in the digest
    setLevel('auto');
    { const rows0 = fs.readFileSync(inbox, 'utf8'); const n0 = notice.sent.length;
      r = propose(ctx, 'night', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', 'on-calendar': '*-*-* 02:00:00', why: 'banks the closed day every night', network: 'none' });
      ok('guardrail ON + safe profile + schedules auto: installed, no owner card, nothing told', r.ok && r.status === 'installed' && fs.readFileSync(inbox, 'utf8') === rows0 && notice.sent.length === n0 && /schedules auto \(localComputer guardrail on, inside the safe profile\)/.test(read(ctx).services.night.approval.via), r);
      remove(ctx, 'night', { by: 'data' }); }
    // guardrail ON, schedules=auto: any network is outside the safe profile (named websites are declared, not enforced),
    // so the guardrail asks the owner, with the websites named on the card; a new website and an allowlisted one alike
    fs.writeFileSync(path.join(R, 'company/state/external-allowlist.txt'), '# hosts\napi.known.example\n');
    { r = propose(ctx, 'feed', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.new.example' });
      const fq = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
      ok('a named website with the guardrail on asks the owner as the guardrail (the website and the risk on the card; the host only under technical)', r.waiting && fq.id === r.questionId && fq.gate.category === 'localComputer' && fq.gate.guardrail && /It connects to the New website, which is new to the crew, but nothing stops it reaching others/.test(lastCard().lead) && !/api\.new/.test(lastCard().lead) && /api\.new\.example/.test(fq.technical) && /not enforced/.test(fq.technical) && plainCard(lastCard()), { r, lead: lastCard().lead });
      const n1 = fs.readFileSync(inbox, 'utf8').trim().split('\n').length;
      propose(ctx, 'feed', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls the price feed every hour, again', hosts: 'api.new.example' });
      ok('no duplicate card for the same spec', fs.readFileSync(inbox, 'utf8').trim().split('\n').length === n1);
      const oldRef = fq.gate.ref;
      r = propose(ctx, 'feed', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.known.example' });
      ok('the same name with a changed spec withdraws the older card; an allowlisted website is still network, so it waits for the owner (never installed by the crew)', r.waiting && card.openFor(oldRef) === null
        && fs.readFileSync(inbox, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.type === 'ask' && x.gate && /^service:feed:/.test(x.gate.ref) && !card.openFor(x.gate.ref)).length === 1
        && /It connects to the Known website but nothing stops it reaching others/.test(lastCard().lead) && !fs.existsSync(path.join(U, 'testco-svc-feed.service')), { r, lead: lastCard().lead });
      remove(ctx, 'feed', { by: 'data' }); }
    // B1 (owner-experience review): no network by default; a website goes through the external level
    { const n0 = fs.readFileSync(inbox, 'utf8').trim().split('\n').length;
      r = propose(ctx, 'quiet', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'banks the closed day every hour' });
      const u = fs.readFileSync(path.join(U, 'testco-svc-quiet.service'), 'utf8');
      ok('no --network and no --hosts: no network (AF_UNIX), inside the safe profile, installed at schedules=auto with no card', r.ok && r.status === 'installed' && read(ctx).services.quiet.network === false && /RestrictAddressFamilies=AF_UNIX/.test(u) && fs.readFileSync(inbox, 'utf8').trim().split('\n').length === n0, { r, u });
      remove(ctx, 'quiet', { by: 'data' });
      ok('--network takes only on or none', throwsCode(P('python3 company/work/sim/scripts/rec.py', { network: 'yes' }), 2, /--network is none/) === true);
      // guardrail ON: a named website (allowlisted, at external=auto) is still outside the safe profile: the owner is asked
      { const g0 = JSON.parse(fs.readFileSync(path.join(R, 'company/state/governance.json'), 'utf8')); g0.categories.external = 'auto'; fs.writeFileSync(path.join(R, 'company/state/governance.json'), JSON.stringify(g0));
        const x = propose(ctx, 'feed1', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.known.example' });
        const xq = JSON.parse(fs.readFileSync(inbox, 'utf8').trim().split('\n').pop());
        ok('guardrail ON: an allowlisted website at external=auto is not installed by the crew; the guardrail card asks the owner', x.waiting && xq.gate.category === 'localComputer' && xq.gate.guardrail && !fs.existsSync(path.join(U, 'testco-svc-feed1.service')), x);
        remove(ctx, 'feed1', { by: 'data' }); }
      // the external level decides the websites while the guardrail is off
      guardOn = false;
      const n0b = fs.readFileSync(inbox, 'utf8').trim().split('\n').length;
      const g = JSON.parse(fs.readFileSync(path.join(R, 'company/state/governance.json'), 'utf8')); g.categories.external = 'auto'; fs.writeFileSync(path.join(R, 'company/state/governance.json'), JSON.stringify(g));
      r = propose(ctx, 'feed2', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls the price feed every hour', hosts: 'api.known.example' });
      ok('guardrail off: an allowlisted website at external=auto: installed, the owner is not asked', r.ok && r.status === 'installed' && fs.readFileSync(inbox, 'utf8').trim().split('\n').length === n0b, r);
      remove(ctx, 'feed2', { by: 'data' });
      r = propose(ctx, 'feed3', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls another price feed every hour', hosts: 'api.brandnew.example' });
      ok('guardrail off: a new website at external=auto: the crew decides (installed, no card)', r.ok && r.status === 'installed' && fs.readFileSync(inbox, 'utf8').trim().split('\n').length === n0b && /external auto/.test(read(ctx).services.feed3.approval.via), r);
      remove(ctx, 'feed3', { by: 'data' });
      g.categories.external = 'notify'; fs.writeFileSync(path.join(R, 'company/state/governance.json'), JSON.stringify(g));
      const s0 = notice.sent.length;
      r = propose(ctx, 'feed4', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'pulls a third price feed every hour', hosts: 'api.other.example', plain: 'It downloads prices once an hour' });
      const told = notice.sent.slice(s0).pop();
      ok('guardrail off: a new website at external=notify: installed, one plain digest line that names the website and never claims "only"', r.ok && r.status === 'installed' && told && told.text === 'Halima set up a background job to run every hour on this computer. It downloads prices once an hour. It connects to the Other website, which the crew has not used before.' && !/only/.test(told.text) && /declared, not enforced/.test(told.technical), told);
      remove(ctx, 'feed4', { by: 'data' });
      guardOn = true; g.categories.external = 'approve'; fs.writeFileSync(path.join(R, 'company/state/governance.json'), JSON.stringify(g));
      // a job installed with the network open before it became opt-in: the same proposal again is "already", not a clash
      const doc = read(ctx); const leg = specOf(ctx, 'legacy', { kind: 'timer', every: '1h', exec: 'bash company/work/sim/scripts/bank.sh', why: 'an old job from before', network: 'on' });
      doc.services.legacy = Object.assign(leg, { specKey: specKey(leg), status: 'installed', by: 'data', byName: 'Halima' }); write(ctx, doc);
      r = propose(ctx, 'legacy', { by: 'data', kind: 'timer', every: '1h', exec: 'bash company/work/sim/scripts/bank.sh', why: 'an old job from before' });
      ok('an installed open-network job proposed again the same way is already installed (not refused)', r.ok && r.already, r);
      delete doc.services.legacy; write(ctx, doc);
      ok('website names in plain words', sitesWords(['api.elections.kalshi.com']) === 'the Kalshi website' && sitesWords(['hermes.pyth.network', 'api.kalshi.com']) === 'the Pyth and Kalshi websites' && sitesWords(['a.example.co.uk']) === 'the Example website'); }
    // ownerApprove: the console's serviceApprove effect installs only after the owner's yes to that exact card
    { r = propose(ctx, 'wide', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --wide', why: 'a recorder that needs more memory', network: 'none', memory: '2G' });
      ok('raised limits ask the owner', r.waiting && /more of this computer's memory or power/.test(lastCard().lead), lastCard().lead);
      ok('ownerApprove before a yes installs nothing', ownerApprove('wide', { ctx }).waiting === true && !fs.existsSync(path.join(U, 'testco-svc-wide.service')));
      answer(r.questionId, 'yes');
      const oa = ownerApprove('wide', { ctx });
      ok('ownerApprove after the yes installs that spec; a second call is a no-op', oa.installed && read(ctx).services.wide.status === 'installed' && /the owner said yes/.test(read(ctx).services.wide.approval.via) && ownerApprove('wide', { ctx }).already, oa);
      remove(ctx, 'wide', { by: 'data' }); }
    ok('plain schedule words', plainWhen({ onCalendar: '*-*-* 02:00:00' }) === 'every night at 2 am' && plainWhen({ every: '1d' }) === 'once a day' && plainWhen({ every: '5min' }) === 'every 5 minutes' && plainWhen({ onCalendar: 'Mon *-*-* 09:00' }) === 'on a set schedule');
    // guardrail OFF follows the schedules level: notify installs at once and puts one plain line in the digest
    guardOn = false; setLevel('notify');
    r = propose(ctx, 'bank', { by: 'data', kind: 'timer', exec: 'bash company/work/sim/scripts/bank.sh', every: '1h', why: 'banks the closed day every hour', network: 'none' });
    const tm = fs.readFileSync(path.join(U, 'testco-svc-bank.timer'), 'utf8'); const ts1 = fs.readFileSync(path.join(U, 'testco-svc-bank.service'), 'utf8');
    { const fyi = notice.sent.filter(x => /^service:bank:/.test(x.key || ''));
      ok('guardrail OFF + schedules notify: installed without a question, one plain digest line (no owner message)', r.ok && r.status === 'installed' && fyi.length === 1 && fyi[0].kind === 'fyi'
        && fyi[0].text === 'Halima set up a background job to run every hour on this computer. It keeps to company files and cannot reach the internet.' && !fs.existsSync(path.join(R, 'company/owner/outbound.jsonl')), { r, fyi }); }
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
    guardOn = true; setLevel(null);
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
    r = (() => { guardOn = false; setLevel('auto'); const x = propose(ctx, 'late', { by: 'data', kind: 'service', exec: 'python3 company/work/sim/scripts/rec.py --late', why: 'proposed during a halt' }); guardOn = true; setLevel(null); return x; })();
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
    // the console's owner job (console/owner-ops.js) is the framework's; a look-alike under another name is not
    fs.writeFileSync(path.join(TR, 'testco-station-owner-job-update-20261119120000-ab12.service'), '[Service]\nWorkingDirectory=' + R + '\nExecStart=bash -c x ' + R + '/company/state/owner-ops/x.pid node ' + R + '/company/tools/framework-update.js apply\n');
    fs.writeFileSync(path.join(TR, 'testco-station-owner-job-sneaky.service'), '[Service]\nWorkingDirectory=' + R + '\nExecStart=/usr/bin/python3 ' + R + '/x.py\n');
    let d = duty(ctx);
    ok('duty: the console\'s own owner-job unit is never flagged; a unit merely named like one is', !d.items.some(i => /owner-job-update-/.test(i.id)) && d.items.some(i => i.id === 'unregistered:testco-station-owner-job-sneaky.service'), d.items);
    fs.unlinkSync(path.join(TR, 'testco-station-owner-job-update-20261119120000-ab12.service')); fs.unlinkSync(path.join(TR, 'testco-station-owner-job-sneaky.service'));
    d = duty(ctx);
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
