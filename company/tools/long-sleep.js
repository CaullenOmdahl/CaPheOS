#!/usr/bin/env node
/* long-sleep.js — notice a run that sleeps to wait for a wall-clock time, and tell that seat's manager once.
 *
 *   node company/tools/long-sleep.js tick [--dry-run]   flag new long-sleeping runs (the dispatcher calls tick() every tick)
 *   node company/tools/long-sleep.js scan [--json]      read only: the runs over the limit in the look-back window
 *   node company/tools/long-sleep.js --selftest
 *
 * WHY. On 2026-11-17 a cron run spent most of 42+ minutes in `shell_exec "sleep 236"` loops waiting for 15-minute
 * market boundaries. A sleeping run holds its seat, blocks lanes and station restarts (restart-station.js waits for it),
 * and does no work. The house rules (v7, routine-rules.js) say: never wait inside a run for more than about 2 minutes;
 * to act later, record a commitment with a due time; to record continuously, use a background service. The PATH shim
 * company/tools/shims/sleep refuses one sleep over 120 s, but many short sleeps, or /usr/bin/sleep, still add up.
 *
 * WHAT. The station's transcripts (.starnet-data/workspaces/transcript-history-v2/segment-*.jsonl, the same rows
 * corrections.js reads) hold every tool call with its arguments. For each shell_exec call in the last LOOKBACK_H hours
 * (default 6) whose cmd runs `sleep N` (N[s|m|h|d], several added; `sleep` after ; & | ( or a line start), the seconds
 * are summed per run (sourceRunId), so an in-flight run is seen too. A crew seat's run over LONG_SLEEP_MIN minutes in all
 * (default 10) is flagged ONCE: one OPEN handoff to the seat's manager (none, or the manager is the CEO: the people
 * owner; else the CEO) with the advice, at most one per seat per 24 h (later runs are recorded, not re-flagged).
 * State: company/state/long-sleep.json { flagged: {runId: at}, seats: {agentId: at} }, pruned after 7 days.
 * Owner of this tool: the tools function. Env: LONG_SLEEP_MIN, LONG_SLEEP_LOOKBACK_H, LONG_SLEEP_NOW (ms, tests).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const co = require('./lib/company');

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const now = () => num(process.env.LONG_SLEEP_NOW, Date.now());
const limitMin = () => num(process.env.LONG_SLEEP_MIN, 10);
const lookbackMs = () => num(process.env.LONG_SLEEP_LOOKBACK_H, 6) * 3600e3;
const F = {
  transcripts: () => co.p('.starnet-data', 'workspaces', 'transcript-history-v2'),
  state: () => co.p('company', 'state', 'long-sleep.json'),
  handoffs: () => co.p('company', 'work', 'handoffs'),
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, JSON.stringify(v, null, 1) + '\n'); fs.renameSync(t, f); };

/* seconds one shell command sleeps: every `sleep ARGS` in it, added (a loop's repeats are not known: counted once) */
const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
function sleepSeconds(cmd) {
  let t = 0;
  const re = /(?:^|[;&|(\n`]|\bthen\b|\bdo\b|\belse\b)\s*(?:command\s+|exec\s+|\/usr\/bin\/|\/bin\/)?sleep((?:\s+\+?(?:\d+\.?\d*|\.\d+)[smhd]?)+)/g;
  for (const m of String(cmd || '').matchAll(re)) {
    for (const a of m[1].trim().split(/\s+/)) { const x = /^\+?(\d+\.?\d*|\.\d+)([smhd]?)$/.exec(a); if (x) t += Number(x[1]) * UNIT[x[2] || 's']; }
  }
  return t;
}

/* runs over the limit: [{ runId, agentId, seconds, calls, firstAt, lastAt }] */
function scan(opts) {
  opts = opts || {};
  const t = opts.now || now(), from = t - (opts.lookbackMs || lookbackMs());
  const dir = F.transcripts();
  let files; try { files = fs.readdirSync(dir).filter(f => /^segment-\d+\.jsonl$/.test(f)).sort(); } catch (_) { return { ok: false, error: 'no transcripts at ' + dir, runs: [] }; }
  const man = readJson(path.join(dir, 'manifest.json'), {}) || {};
  const range = new Map((man.segments || []).map(s => [s.file, s]));
  files = files.filter(f => { const s = range.get(f); return !s || !Number.isFinite(Number(s.maxTs)) || Number(s.maxTs) >= from; });
  const by = new Map();
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { continue; }
    for (const l of txt.split('\n')) {
      if (!l || !l.includes('sleep') || !l.includes('shell_exec')) continue;
      let r; try { r = JSON.parse(l); } catch (_) { continue; }
      if (!r || !r.toolCalls || !(Number(r.ts) >= from) || !r.sourceRunId) continue;
      let calls; try { calls = typeof r.toolCalls === 'string' ? JSON.parse(r.toolCalls) : r.toolCalls; } catch (_) { continue; }
      for (const tc of Array.isArray(calls) ? calls : []) {
        const fn = (tc && tc.function) || {};
        if (fn.name !== 'shell_exec') continue;
        let a = fn.arguments; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = {}; } }
        const sec = sleepSeconds(a && a.cmd);
        if (!sec) continue;
        const k = r.sourceRunId;
        const e = by.get(k) || { runId: k, agentId: r.agentId || null, seconds: 0, calls: 0, firstAt: Number(r.ts), lastAt: Number(r.ts) };
        e.seconds += sec; e.calls++; e.lastAt = Math.max(e.lastAt, Number(r.ts)); e.firstAt = Math.min(e.firstAt, Number(r.ts));
        by.set(k, e);
      }
    }
  }
  const lim = (opts.limitMin || limitMin()) * 60;
  return { ok: true, runs: [...by.values()].filter(e => e.seconds > lim).sort((a, b) => a.firstAt - b.firstAt) };
}

/* who hears about a seat: its manager; when that is the CEO (or nobody), the people owner; else the CEO */
function targetFor(agentId) {
  const c = co.crew(); const seat = c[agentId] || {};
  const ceo = co.ceo(), people = co.seatFor('people');
  const ok = id => id && id !== agentId && c[id] && c[id].inbox;
  if (ok(seat.manager) && seat.manager !== ceo) return seat.manager;
  if (ok(people)) return people;
  if (ok(ceo)) return ceo;
  return ok(seat.manager) ? seat.manager : null;
}
const flat = v => String(v == null ? '' : v).replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
// the commitments line only where the module is on (house rules v8 do the same)
function laterAdvice() {
  let on = false; try { on = require('./lib/modules').isEnabled('commitments'); } catch (_) {}
  return on ? 'to act at a later time, record a commitment with a due time (`node company/tools/commitments.js create --title "..." --key <key> --owner <seat> --due <ISO time>`) and end the run, the commitments duty wakes them then;'
    : 'to act at a later time, write what to do and when in a handoff to themselves (with a **Deadline:** line) and end the run;';
}
function handoff(to, e) {
  const c = co.crew(); const inbox = c[to] && c[to].inbox;
  if (!inbox || /[\/\\]|\.\./.test(inbox)) return null;
  const who = co.nameOf(e.agentId), min = Math.round(e.seconds / 60);
  const lp = co.localParts(new Date(now())), at = co.localParts(new Date(e.firstAt));
  const due = co.localParts(new Date(now() + 86400e3)).date;
  const block = '\n## ' + lp.date + ' ' + lp.time + ' from long-sleep.js — ' + flat(who) + '\'s run slept ' + min + ' min waiting for a time\n' +
    '**Need:** tell ' + flat(who) + ', once, how to wait without a run: never wait inside a run for more than about 2 minutes; ' + laterAdvice() + ' for continuous recording or watching, a background service (`node company/tools/service.js propose`). Close this with what you told them.\n' +
    '**Why:** run ' + flat(String(e.runId).slice(0, 12)) + ' (from ' + at.time + ') spent ' + min + ' min in ' + e.calls + ' shell_exec sleep call(s). A sleeping run holds the seat, blocks lanes and station restarts, and does no work (house rules). This is not a performance flag.\n' +
    '**Deadline:** ' + due + '\n**Status:** OPEN\n**Evidence:** run ' + flat(e.runId) + ' in the station transcripts; `node company/tools/long-sleep.js scan`\n';
  const f = path.join(F.handoffs(), inbox);
  require('./lib/tool-blocks').append(f, block);   // recorded (lib/tool-blocks.js): a tool's own block, never held as a member's message
  return inbox;
}

/* the dispatcher's hook: flag each new long-sleeping run once (one per seat per 24 h) */
function tick(opts) {
  opts = opts || {};
  const log = opts.log || (() => {});
  const t = now();
  const st = readJson(F.state(), null) || {}; st.flagged = st.flagged || {}; st.seats = st.seats || {};
  const r = scan({ now: t });
  const out = { flagged: [], recorded: [], ok: r.ok };
  if (!r.ok) return out;
  const crew = co.crew();
  for (const e of r.runs) {
    if (!e.agentId || !crew[e.agentId] || st.flagged[e.runId]) continue;
    const last = Date.parse(st.seats[e.agentId] || '');
    if (Number.isFinite(last) && t - last < 86400e3) { st.flagged[e.runId] = new Date(t).toISOString(); out.recorded.push(e.runId); continue; }
    const to = targetFor(e.agentId);
    if (!opts.dry && to) handoff(to, e);
    st.flagged[e.runId] = new Date(t).toISOString(); st.seats[e.agentId] = new Date(t).toISOString();
    out.flagged.push({ runId: e.runId, agentId: e.agentId, to, minutes: Math.round(e.seconds / 60) });
    log('LONG SLEEP: ' + co.nameOf(e.agentId) + '\'s run ' + String(e.runId).slice(0, 12) + ' slept ' + Math.round(e.seconds / 60) + ' min in ' + e.calls + ' call(s)' + (to ? '; told ' + co.nameOf(to) + ' once' : '; nobody to tell'));
  }
  for (const m of [st.flagged, st.seats]) for (const k of Object.keys(m)) if (t - Date.parse(m[k]) > 7 * 86400e3) delete m[k];
  if (!opts.dry && (out.flagged.length || out.recorded.length)) writeJson(F.state(), st);
  return out;
}

/* ---------------- selftest ---------------- */
function selftest() {
  let bad = 0; const ok = (n, c, d) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  [' + (d || '') + ']')); if (!c) bad++; };
  ok('sleepSeconds: plain, units, several, after ; && and in a loop body', sleepSeconds('sleep 236') === 236 && sleepSeconds('sleep 2m') === 120 && sleepSeconds('sleep 1m 30') === 90
    && sleepSeconds('cd x && sleep 240; date') === 240 && sleepSeconds('for i in 1 2; do sleep 30; done') === 30 && sleepSeconds('sleep 1; sleep 2') === 3 && sleepSeconds('/usr/bin/sleep 5') === 5);
  ok('sleepSeconds: no sleep word, a word that only contains it, and sleep with no number count 0', sleepSeconds('date') === 0 && sleepSeconds('echo nosleep 300') === 0 && sleepSeconds('grep sleep x.log') === 0 && sleepSeconds('sleep inf') === 0);
  const T = require('./lib/temp-life').tmpDir('long-sleep-selftest-');
  try {
    const W = (rel, txt) => { const f = path.join(T, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
    W('company/company.json', JSON.stringify({ name: 'T', timezone: 'UTC' }));
    W('company/tools/loops.json', JSON.stringify({ agents: {
      boss: { name: 'Bea', functions: ['ceo', 'tools'], manager: null, inbox: 'to-bea.md' },
      ppl: { name: 'Pat', functions: ['people'], manager: 'boss', inbox: 'to-pat.md' },
      lead: { name: 'Lee', manager: 'boss', inbox: 'to-lee.md' },
      hal: { name: 'Halima', manager: 'lead', inbox: 'to-halima.md' },
      sol: { name: 'Sol', manager: 'boss', inbox: 'to-sol.md' } } }));
    const t0 = Date.parse('2026-11-17T17:00:00Z');
    const row = (agentId, runId, ts, cmd) => JSON.stringify({ streamId: 'cron-' + runId, agentId, role: 'assistant', ts, sourceRunId: runId,
      toolCalls: JSON.stringify([{ id: 'c' + ts, type: 'function', function: { name: 'shell_exec', arguments: JSON.stringify({ cmd, timeoutMs: 260000 }) } }]) });
    const rows = [];
    for (let i = 0; i < 9; i++) rows.push(row('hal', 'run-hal-1', t0 - (40 - i * 4) * 60000, 'sleep 236; cd /x && date'));   // 9 x 236 s = 35 min
    rows.push(row('hal', 'run-hal-2', t0 - 5 * 60000, 'sleep 120')); for (let i = 0; i < 6; i++) rows.push(row('hal', 'run-hal-2', t0 - 4 * 60000 + i, 'sleep 120'));   // 14 min, same seat
    rows.push(row('sol', 'run-sol', t0 - 10 * 60000, 'sleep 90; date'));   // 1.5 min: fine
    rows.push(row('lead', 'run-old', t0 - 9 * 3600e3, 'sleep 3600'));       // outside the look-back
    rows.push(row('stranger', 'run-x', t0 - 3 * 60000, 'sleep 3000'));      // not a crew seat
    W('.starnet-data/workspaces/transcript-history-v2/segment-000001.jsonl', rows.join('\n') + '\n');
    const run = (args, env) => require('child_process').spawnSync(process.execPath, [__filename].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { CAPHEOS_ROOT: T, LONG_SLEEP_NOW: String(t0) }, env || {}) });
    let r = run(['scan', '--json']); let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
    ok('scan: the long sleeper\'s runs are found with their totals; short, old and in-window-only runs are not', j && j.runs.length === 3 && j.runs[0].runId === 'run-hal-1' && Math.round(j.runs[0].seconds) === 2124 && j.runs[0].calls === 9 && !j.runs.some(x => x.runId === 'run-sol' || x.runId === 'run-old'), r.stdout + r.stderr);
    r = run(['tick']);
    const lee = (() => { try { return fs.readFileSync(path.join(T, 'company/work/handoffs/to-lee.md'), 'utf8'); } catch (_) { return ''; } })();
    ok('tick: one OPEN handoff to the seat\'s manager, with the advice (no commitments tool: the module is off here)', (lee.match(/^## /mg) || []).length === 1 && /Halima's run slept 35 min/.test(lee) && /handoff to themselves/.test(lee) && !/commitments\.js/.test(lee) && /service\.js propose/.test(lee) && /\*\*Status:\*\* OPEN/.test(lee), lee + r.stderr);
    ok('tick: a stranger to the crew is not flagged, and nothing goes to the seat itself', !fs.existsSync(path.join(T, 'company/work/handoffs/to-halima.md')) && /LONG SLEEP: Halima/.test(r.stdout) && !/stranger/.test(r.stdout), r.stdout);
    const st = readJson(path.join(T, 'company/state/long-sleep.json'), {});
    ok('tick: the second long run of the same seat inside 24 h is recorded, not flagged again', st.flagged && st.flagged['run-hal-1'] && st.flagged['run-hal-2'] && st.seats.hal, JSON.stringify(st));
    r = run(['tick']);
    const lee2 = fs.readFileSync(path.join(T, 'company/work/handoffs/to-lee.md'), 'utf8');
    ok('tick again: flagged once, never twice', lee2 === lee && !/LONG SLEEP/.test(r.stdout), r.stdout);
    // a seat whose manager is the CEO: the people owner hears it
    W('.starnet-data/workspaces/transcript-history-v2/segment-000002.jsonl', [0, 1, 2, 3].map(i => row('sol', 'run-sol-2', t0 - 30 * 60000 + i, 'sleep 200')).join('\n') + '\n');
    r = run(['tick']);
    const pat = (() => { try { return fs.readFileSync(path.join(T, 'company/work/handoffs/to-pat.md'), 'utf8'); } catch (_) { return ''; } })();
    ok('a seat whose manager is the CEO: the people owner is told instead', /Sol's run slept 13 min/.test(pat) && !fs.existsSync(path.join(T, 'company/work/handoffs/to-bea.md')), pat + r.stdout + r.stderr);
    r = run(['tick', '--dry-run'], { LONG_SLEEP_MIN: '1' });
    ok('--dry-run writes nothing', !/LONG SLEEP/.test(r.stdout) || fs.readFileSync(path.join(T, 'company/work/handoffs/to-pat.md'), 'utf8') === pat, r.stdout);
  } finally { fs.rmSync(T, { recursive: true, force: true }); }
  // the PATH shim (company/tools/shims/sleep): over the cap refused at once with the advice; under it, the real sleep
  const shim = path.join(__dirname, 'shims', 'sleep');
  const sh = (args, env) => require('child_process').spawnSync('bash', [shim].concat(args), { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, env || {}) });
  let s = sh(['236']);
  ok('shim: sleep 236 is refused at once (exit 2), naming a later-time route and background services', s.status === 2 && /refused: `sleep 236` waits 236 s/.test(s.stderr) && (fs.existsSync(path.join(__dirname, 'commitments.js')) ? /commitments\.js create/ : /handoff to yourself/).test(s.stderr) && /service\.js propose/.test(s.stderr), s.status + ' ' + s.stderr);
  s = sh(['1m', '61']); ok('shim: several arguments are added (1m 61 = 121 s > 120)', s.status === 2, s.status + s.stderr);
  s = sh(['inf']); ok('shim: sleep inf is refused', s.status === 2 && /waits forever/.test(s.stderr), s.stderr);
  const t1 = Date.now(); s = sh(['0.2']); ok('shim: a short sleep runs the real sleep', s.status === 0 && Date.now() - t1 >= 180, s.status + s.stderr);
  s = sh(['0.3'], { SLEEP_SHIM_MAX_SEC: '0.1' }); ok('shim: SLEEP_SHIM_MAX_SEC sets the cap', s.status === 2, s.status + s.stderr);
  s = sh(['--version']); ok('shim: options it cannot sum go to the real sleep', s.status === 0 && /sleep/i.test(s.stdout), s.stdout + s.stderr);
  console.log(bad ? 'LONG-SLEEP SELFTEST FAILED: ' + bad : 'LONG-SLEEP SELFTEST PASSED');
  return bad ? 1 : 0;
}

module.exports = { scan, tick, sleepSeconds, targetFor };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--selftest') || a[0] === 'selftest') process.exit(selftest());
  if (a[0] === 'scan') {
    const r = scan();
    if (a.includes('--json')) console.log(JSON.stringify(r, null, 1));
    else if (!r.ok) console.log('cannot scan: ' + r.error);
    else if (!r.runs.length) console.log('no run slept more than ' + limitMin() + ' min in the last ' + (lookbackMs() / 3600e3) + ' h');
    else for (const e of r.runs) console.log(co.nameOf(e.agentId) + '  run ' + String(e.runId).slice(0, 12) + '  slept ' + Math.round(e.seconds / 60) + ' min in ' + e.calls + ' call(s), from ' + co.localParts(new Date(e.firstAt)).time);
    process.exit(r.ok ? 0 : 1);
  }
  if (a[0] === 'tick') { tick({ dry: a.includes('--dry-run'), log: l => console.log(l) }); process.exit(0); }
  console.error('usage: long-sleep.js tick [--dry-run] | scan [--json] | --selftest'); process.exit(2);
}
