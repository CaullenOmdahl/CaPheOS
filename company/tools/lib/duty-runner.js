'use strict';
/* duty-runner.js — runs the registered duties and keeps their state (docs/DUTIES.md). Used by dispatch.js (one block per
 * tick, after locked-watch) and by duty-status.js (read only).
 *
 *   const R = require('./lib/duty-runner');
 *   R.registry({ toolsDir })        company duties (company/tools/duties.js) + each ENABLED module's module.json "duties"
 *   R.policy()                      { source, tickCapMs, overrides, flagged } from company/work/ops/duty-policy.json
 *   await R.tick({ log, dry, halted, now, toolsDir, flag })   run what is due, write company/state/duties.json
 *   R.view({ now, toolsDir })       per duty { id, route, state ok|due|broken|stale|off|paused, checkedAt, reason, history, ... }
 *                                   (paused: stale only because an active restart hold runs whileHalted duties only)
 *   R.sanitize(text, max)           what any reason goes through before a prompt or a log
 *
 * The contract a duty keeps: `node <tool> --duty`, no other argument. Exit 0 = nothing due; exit 1 = due, stdout one
 * JSON object {due:true, reason, route?, key, items?}; anything else, a timeout or more than 16 KB of output = broken.
 * Absence never renders green: a duty is ok only if it ran inside 2 x its cadence and its last result was ok.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const co = require('./company');
const { dutyEnv } = require('./duty-env');

const OUT_CAP = 16 * 1024;
const HISTORY = 12;
const TICK_CAP_DEFAULT = 20000, TICK_CAP_BOUNDS = [2000, 60000];
const FUNCTIONS = ['ceo', 'people', 'tools', 'risk', 'floor', 'finance'];
const P = {
  state: () => co.p('company', 'state', 'duties.json'),
  policy: () => co.p('company', 'work', 'ops', 'duty-policy.json'),
  policyDefault: () => co.p('company', 'defaults', 'work', 'ops', 'duty-policy.json'),
  baseline: () => co.p('company', 'state', 'locked', 'baseline.json'),
  lkg: key => co.p('company', 'state', 'locked', 'lkg', key),
};
const POLICY_KEY = 'company/work/ops/duty-policy.json';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const iso = ms => new Date(ms).toISOString();

/* ---- sanitizing: counts and ids only reach a prompt or a log ---- */
function sanitize(text, max) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/[`<>*_#[\]|]/g, '')           // no markdown, no html, no fences: a reason is never markup
    .replace(/\s+/g, ' ').trim().slice(0, max || 300);
}
const safeId = (s, max) => String(s == null ? '' : s).replace(/[^A-Za-z0-9:._@/#-]/g, '').slice(0, max || 80);
const safeRoute = r => { const s = String(r || ''); return FUNCTIONS.includes(s) || /^[A-Za-z0-9_-]{2,64}$/.test(s) ? s : null; };

/* ---- registry: code only ---- */
function registry(opts) {
  opts = opts || {};
  const toolsDir = opts.toolsDir || path.join(__dirname, '..');
  const D = require(path.join(toolsDir, 'duties.js'));
  const out = []; const seen = new Set();
  const add = (d, source, dir) => {
    const problems = D.check(d, source);
    const file = d && typeof d.tool === 'string' ? path.join(dir, d.tool) : null;
    if (file && !path.resolve(file).startsWith(path.resolve(dir) + path.sep)) problems.push(source + ': tool path leaves its folder');
    if (d && seen.has(d.id)) problems.push(source + ': duplicate duty id ' + d.id);
    if (d && d.id) seen.add(d.id);
    out.push(Object.assign({}, d, { source, file, invalid: problems.length ? problems.join('; ') : null }));
  };
  for (const d of D.DUTIES) add(d, 'company/tools/duties.js', toolsDir);
  let mods = null; try { mods = require('./modules'); } catch (_) {}
  if (mods) for (const id of mods.enabled()) {
    const mj = co.readJson(path.join(mods.dir(id), 'module.json'), null);
    for (const d of (mj && Array.isArray(mj.duties) ? mj.duties : [])) add(d, 'modules/' + id + '/module.json', mods.dir(id));
  }
  return out;
}

/* ---- policy: {enabled, everyMin} overrides, clamped; an unrecorded edit locked-watch flagged is not obeyed ---- */
function watchEntry() {
  const b = co.readJson(P.baseline(), null);
  return (b && b.files && b.files[POLICY_KEY]) || null;
}
// the watcher's last-known-good copy, only when its digest still matches the baseline (a tampered copy is not used)
function lastKnownGood(entry) {
  try {
    const buf = fs.readFileSync(P.lkg(POLICY_KEY));
    if (!entry.lkgSha || 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex') !== entry.lkgSha) return null;
    return JSON.parse(buf.toString('utf8'));
  } catch (_) { return null; }
}
function policy() {
  const D = require(path.join(__dirname, '..', 'duties.js'));
  let doc = null, source = 'none';
  const we = watchEntry();
  const flagged = !!(we && we.flagged);
  if (flagged) {
    doc = lastKnownGood(we); if (doc) source = 'last-known-good';
    else { doc = co.readJson(P.policyDefault(), null) || {}; source = 'defaults (the flagged edit is not obeyed)'; }
  }
  if (!doc) { doc = co.readJson(P.policy(), null); if (doc) source = 'company'; }
  if (!doc) { doc = co.readJson(P.policyDefault(), null); if (doc) source = 'defaults'; }
  doc = doc && typeof doc === 'object' ? doc : {};
  const cap = Number(doc.tickCapMs);
  const overrides = {};
  for (const [id, o] of Object.entries(doc.duties && typeof doc.duties === 'object' ? doc.duties : {})) {
    if (!D.ID_RE.test(id) || !o || typeof o !== 'object') continue;
    const r = {};
    if (typeof o.enabled === 'boolean') r.enabled = o.enabled;
    if (Number.isFinite(Number(o.everyMin)) && o.everyMin !== null) r.everyMin = clamp(Number(o.everyMin), D.EVERY_MIN_BOUNDS[0], D.EVERY_MIN_BOUNDS[1]);
    overrides[id] = r;
  }
  return { source, flagged, tickCapMs: Number.isFinite(cap) && cap > 0 ? clamp(cap, TICK_CAP_BOUNDS[0], TICK_CAP_BOUNDS[1]) : TICK_CAP_DEFAULT, overrides };
}
function settings(d, pol) {
  const o = (pol.overrides || {})[d.id] || {};
  return { enabled: !d.invalid && (typeof o.enabled === 'boolean' ? o.enabled : d.enabledByDefault === true), everyMin: Number(o.everyMin) || d.everyMin };
}

/* ---- one run ---- */
function parseDue(stdout) {
  let j; try { j = JSON.parse(String(stdout).trim()); } catch (_) { return { error: 'exit 1 without one JSON object on stdout' }; }
  if (!j || typeof j !== 'object' || j.due !== true) return { error: 'exit 1 but the output is not {due:true, ...}' };
  if (typeof j.reason !== 'string' || !j.reason.trim()) return { error: 'due without a reason' };
  if (typeof j.key !== 'string' || !j.key.trim()) return { error: 'due without a key' };
  if (j.route != null && !safeRoute(j.route)) return { error: 'due with a route that is neither a function nor a seat id' };
  const items = Array.isArray(j.items) ? j.items.slice(0, 50).map(x => (x && typeof x === 'object' ? { id: safeId(x.id), route: safeRoute(x.route) || undefined } : { id: safeId(x) })).filter(x => x.id) : [];
  return { reason: sanitize(j.reason, 300), key: safeId(j.key, 80), route: j.route ? safeRoute(j.route) : null, items };
}
function runOne(d, opts) {
  const t0 = Date.now();
  const timeout = Math.max(500, Math.min(d.timeoutMs, opts.remainingMs));
  const cutByCap = timeout < d.timeoutMs;
  return new Promise(resolve => {
    let child;
    try {
      child = execFile(process.execPath, [d.file, '--duty'], { cwd: opts.cwd, env: opts.env, timeout, killSignal: 'SIGKILL', maxBuffer: OUT_CAP, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        const ms = Date.now() - t0;
        if (!err) return resolve({ result: 'ok', ms });
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ result: 'broken', ms, error: 'more than 16 KB of output' });
        if (err.killed || err.signal) return resolve(cutByCap ? { result: 'waited', ms } : { result: 'broken', ms, error: 'no answer within ' + d.timeoutMs + ' ms' });
        if (err.code === 1) { const p = parseDue(stdout); return resolve(p.error ? { result: 'broken', ms, error: p.error } : Object.assign({ result: 'due', ms }, p)); }
        return resolve({ result: 'broken', ms, error: typeof err.code === 'number' ? 'exit ' + err.code : sanitize(err.code || err.message, 120) });
      });
      if (child.stdin) child.stdin.end();
    } catch (e) { resolve({ result: 'broken', ms: Date.now() - t0, error: sanitize(e.message, 120) }); }
  });
}

/* ---- state ---- */
function readState() { const s = co.readJson(P.state(), null); return s && typeof s === 'object' && s.duties ? s : { duties: {} }; }
function writeState(s) {
  const f = P.state(); fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(s, null, 1) + '\n'); fs.renameSync(t, f);
}
// the state a reader sees: ok only when it ran inside its cadence and said ok
function stateOf(d, st, set, now) {
  if (d.invalid) return 'broken';
  if (!set.enabled) return 'off';
  if (!st || !st.lastRun || !st.lastResult) return 'stale';
  if (now - Date.parse(st.lastRun) > set.everyMin * 2 * 60000) return 'stale';
  return ['ok', 'due', 'broken'].includes(st.lastResult) ? st.lastResult : 'stale';
}
const sig = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

/* ---- the tick ---- */
async function tick(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const say = opts.log || (() => {});
  const reg = registry({ toolsDir: opts.toolsDir });
  const pol = policy();
  const S = readState();
  const out = { ran: [], due: [], broken: [], stale: [], waited: [], recovered: [], off: pol.source === 'none', policy: pol };
  if (out.off) {
    if (S.lastLine !== 'off') { say('DUTIES off: no duty policy (company/work/ops/duty-policy.json, or its default)'); S.lastLine = 'off'; if (!opts.dry) writeState(S); }
    return out;
  }
  const env = dutyEnv({ root: co.ROOT }).env;
  const t0 = Date.now();
  const wanted = reg.map(d => ({ d, set: settings(d, pol), st: S.duties[d.id] || (S.duties[d.id] = {}) }))
    .filter(x => x.set.enabled && (!opts.halted || x.d.whileHalted === true))
    .filter(x => !x.st.lastRun || now - Date.parse(x.st.lastRun) >= x.set.everyMin * 60000)
    .sort((a, b) => (Date.parse(a.st.lastRun || 0) || 0) - (Date.parse(b.st.lastRun || 0) || 0));   // the longest-waiting first
  for (const x of wanted) {
    const remainingMs = pol.tickCapMs - (Date.now() - t0);
    if (remainingMs < 500) { x.st.waits = (x.st.waits || 0) + 1; x.st.lastWaitAt = iso(now); out.waited.push(x.d.id); continue; }
    const r = await runOne(x.d, { env, cwd: co.ROOT, remainingMs });
    if (r.result === 'waited') { x.st.waits = (x.st.waits || 0) + 1; x.st.lastWaitAt = iso(now); out.waited.push(x.d.id); continue; }
    const st = x.st; const prev = st.lastResult;
    st.lastRun = iso(now); st.lastResult = r.result; st.ms = r.ms; st.waits = 0;
    if (r.result === 'due') { if (prev !== 'due' || !st.dueSince) st.dueSince = iso(now); st.key = r.key; st.reason = r.reason; st.route = r.route || null; st.items = r.items; }
    else { delete st.dueSince; delete st.reason; delete st.items; delete st.route; if (r.result === 'ok') st.key = null; }
    if (r.result === 'broken') { st.error = r.error; st.brokenSince = st.brokenSince || iso(now); } else { delete st.error; delete st.brokenSince; }
    st.history = (st.history || []).concat([{ at: iso(now), result: r.result, ms: r.ms, key: r.key || null }]).slice(-HISTORY);
    out.ran.push(x.d.id);
    if (r.result === 'ok' && (prev === 'due' || prev === 'broken')) out.recovered.push(x.d.id);
  }
  // what every enabled duty is now, flags once per change (never while halted: nothing new starts then)
  const counts = { ok: 0, due: 0, broken: 0, stale: 0 };
  for (const d of reg) {
    const set = settings(d, pol); const st = S.duties[d.id] || (S.duties[d.id] = {});
    if (!set.enabled && !d.invalid) continue;
    const s = stateOf(d, st, set, now);
    counts[s] = (counts[s] || 0) + 1;
    if (s === 'due') out.due.push({ d, st });
    if (s === 'ok' && st.lastFlaggedKey) { if (!out.recovered.includes(d.id)) out.recovered.push(d.id); delete st.lastFlaggedKey; }
    if (s === 'broken' || s === 'stale') {
      (s === 'broken' ? out.broken : out.stale).push(d.id);
      const why = d.invalid ? 'registry: ' + d.invalid : s === 'broken' ? String(st.error || 'broken') : 'not run inside 2 x its ' + set.everyMin + ' min cadence (last run ' + (st.lastRun || 'never') + (st.waits ? ', waited ' + st.waits + ' tick(s) for the per-tick cap' : '') + ')';
      const flagKey = s === 'broken' ? 'broken:' + sig(why) : 'stale:' + (st.lastRun || 'never');   // stale: once per episode, whatever the wait count
      if (!opts.halted && st.lastFlaggedKey !== flagKey && typeof opts.flag === 'function') {
        try { opts.flag({ d, state: s, why: sanitize(why, 240), set }); st.lastFlaggedKey = flagKey; st.flaggedAt = iso(now); } catch (e) { say('DUTY FLAG ERROR ' + d.id + ': ' + sanitize(e.message, 160)); }
      }
    }
  }
  const ms = Date.now() - t0;
  const parts = [counts.ok + ' ok', counts.due + ' due' + (out.due.length ? ' (' + out.due.map(x => x.d.id).join(', ') + ')' : ''), counts.broken + ' broken' + (out.broken.length ? ' (' + out.broken.join(', ') + ')' : ''), counts.stale + ' stale' + (out.stale.length ? ' (' + out.stale.join(', ') + ')' : '')];
  const key = parts.join(', ') + (out.waited.length ? '; waiting for the cap: ' + out.waited.join(', ') : '');
  if (key !== S.lastLine) { say('DUTIES ' + (opts.halted ? '(halted: liveness only) ' : '') + out.ran.length + ' run in ' + (ms / 1000).toFixed(1) + ' s — ' + key); S.lastLine = key; }
  S.updatedAt = iso(now); S.policySource = pol.source; S.tickCapMs = pol.tickCapMs;
  if (!opts.dry) writeState(S);
  out.counts = counts; out.ms = ms;
  return out;
}

/* ---- the board's view (duty-status.js) ---- */
function view(opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const reg = registry({ toolsDir: opts.toolsDir });
  const pol = policy();
  const S = readState();
  const routeName = r => { if (!r) return null; const id = FUNCTIONS.includes(r) ? co.seatFor(r) : r; return id ? co.nameOf(id) : null; };
  const rhold = co.halted() ? null : co.restartHold(now); const pausedNote = rhold ? co.restartHoldNote(rhold) : null;
  return { policySource: pol.source, policyFlagged: pol.flagged, tickCapMs: pol.tickCapMs, updatedAt: S.updatedAt || null, duties: reg.map(d => {
    const set = settings(d, pol); const st = S.duties[d.id] || {};
    let s = pol.source === 'none' && !d.invalid ? 'stale' : stateOf(d, st, set, now);
    // a restart hold (restart-station.js) runs only whileHalted duties, on purpose: one that went stale under it is paused
    if (s === 'stale' && pausedNote && !d.whileHalted) s = 'paused';
    return { id: d.id, source: d.source, tool: d.tool, route: st.route || d.route, owner: routeName(st.route || d.route), state: s, enabled: set.enabled, everyMin: set.everyMin,
      checkedAt: st.lastRun || null, reason: s === 'due' ? st.reason || null : s === 'broken' ? sanitize(d.invalid || st.error || 'broken', 240) : s === 'stale' ? (st.lastRun ? 'last run ' + st.lastRun + ', older than 2 x ' + set.everyMin + ' min' : 'never run') : s === 'paused' ? pausedNote : null,
      key: st.key || null, items: s === 'due' ? (st.items || []) : [], dueSince: st.dueSince || null, brokenSince: st.brokenSince || null, waits: st.waits || 0, whileHalted: !!d.whileHalted,
      history: (st.history || []).slice(-HISTORY) };
  }) };
}

module.exports = { registry, policy, settings, tick, view, runOne, parseDue, stateOf, sanitize, safeId, safeRoute, readState, P, OUT_CAP, TICK_CAP_DEFAULT, TICK_CAP_BOUNDS, POLICY_KEY };
